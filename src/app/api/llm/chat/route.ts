import { NextRequest } from 'next/server'
import { ensureLlm, LLM_PORT, actualLlmContextSize, activeLlmModelId, llmBackend, noteLlmActivity } from '@/lib/llm-runner'
import { samplingForModel } from '@/lib/llm-sampling'
import { startChat, noteLlmStreaming } from '@/lib/vram-arbiter'
import { getAppConfig } from '@/lib/app-config'
import { prepVideoForLlm, extractVideoFrames } from '@/lib/llm-media'
import { getReferenceDigest } from '@/lib/llm-ref-digest'
import { toOpenAiMessages, openAiSseToDelta } from '@/lib/llm-bonsai'
import { LLM_STOP_TOKENS, probeAudioAnswer } from '@/lib/llm-audio-guard'
import {
  trimToContext,
  degradeMediaToBudget,
  videoBudgetSec,
  messageTokens,
} from '@/lib/llm-context-trim'
import { existsSync, mkdirSync, unlinkSync, rmdirSync, readdirSync, statSync } from 'fs'
import path, { join } from 'path'
import sharp from 'sharp'
import { stagedPath } from '@/lib/staging' // (fix 697)

export const dynamic = 'force-dynamic'

/**
 * POST /api/llm/chat
 * Body: {
 *   messages: [{role, content}],
 *   references?: [{ path: "file.png", trigger: "Picture 1", intent: "identity" }],
 *   chatAttachments?: [{ path, name, kind: 'image'|'video', legacyComfy?: boolean }] — (fix 108)
 *   chat attachments from data/chat-attachments/ (or legacy input/): ONLY for
 *   LLM description, NOT generation refs — attached as "Chat N" with tags forbidden.
 *   maxTokens?, temperature?
 * }
 * Lazily starts the local LLM server, then proxies the SSE stream.
 * If references are provided, image files are read and injected as
 * vision content into the first user message.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const messages = body?.messages as Array<{ role: string; content: string | unknown[]; images?: string[] }> | undefined
    // (fix 717) request_id is forwarded to llm_server.py — used to
    // route /abort directly to this generation.
    const requestId = typeof body?.request_id === 'string' && body.request_id ? body.request_id : null
    if (!Array.isArray(messages) || messages.length === 0) {
      return new Response(JSON.stringify({ error: 'messages required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Cleanup temp vision files (idempotent; called on error paths and at stream end)
    // (fix 162) Frame folders (Bonsai video-vision) deleted via rmdirSync.
    const tempFiles: string[] = []
    const cleanup = () => { tempFiles.forEach((f) => { try { unlinkSync(f) } catch { try { rmdirSync(f, { recursive: true }) } catch {} } }) }

    // (fix 108) Orphan sweep: temp files in _tmp_vision older than 1 hour — leftover
    // after process crash (local cleanup did not run). Do NOT touch fresh ones
    // (they may belong to an active stream completing later).
    const cfg = getAppConfig()
    // (fix 136) Active assistant backend: 'standard' (llm_server.py)
    // or 'bonsai' (prism llama-server, OpenAI protocol).
    const backend = llmBackend()
    try {
      // (fix 108) IMPORTANT: path is taken from cfg.comfyRoot — actual ComfyUI
      // root is configurable (defaults to ./ComfyUI-Easy-Install), not cwd.
      const sweepDir = path.join(cfg.comfyRoot, 'ComfyUI', 'models', 'llm', '_tmp_vision')
      const now = Date.now()
      for (const f of readdirSync(sweepDir)) {
        try {
          const st = statSync(join(sweepDir, f))
          if (st.isFile() && now - st.mtimeMs > 3600_000) {
            unlinkSync(join(sweepDir, f))
          } else if (
            // (fix 172) Frame directories llmvidframes_*/llmvidcaframes_*
            // (Bonsai video-vision, src/lib/llm-media.ts) accumulated infinitely
            // after crashes — sweep previously deleted only files.
            // Delete recursively with the same age threshold (1 hour).
            st.isDirectory() && /^(llmvidframes_|llmvidcaframes_|digest_)/.test(f) &&
            now - st.mtimeMs > 3600_000
          ) {
            rmdirSync(join(sweepDir, f), { recursive: true })
          }
        } catch { /* file may have disappeared — ignore */ }
      }
    } catch { /* folder does not exist — ok */ }

    // Guard + MiniMax unload (verified) under mutex. All request preparation and
    // upstream connection opening happen ONLY under the same mutex, and
    // streaming counter increments before its release (startChat contract):
    // from this point generation gets 409 until the assistant response finishes.
    const gate = await startChat(async () => {
      const started = await ensureLlm()
      if (!started.ok) {
        return { kind: 'start-error' as const, error: started.error ?? 'LLM server not responding' }
      }

      // Inject references as multimodal CONTENT PARTS (llama-cpp-python 0.3.46
      // mtmd format — the legacy `images` message field is NOT read by this
      // version and would be silently dropped):
      //   {"type":"image"} — sharp-resized JPEG
      //   {"type":"video"} — whole MP4 (≤512px, 8 fps) — the MTMD video helper
      //                      (lazy bitmap, patched into llama_multimodal.py)
      //                      decodes it frame-by-frame during tokenization;
      //                      + optional {"type":"audio"} part for the track
      //   {"type":"audio"} — 16 kHz mono WAV
      const references = body?.references as Array<{
        path: string
        trigger: string
        intent?: string
        kind?: 'image' | 'video' | 'audio'
        includeAudio?: boolean
      }> | undefined
      // (fix 717) Media budget is calculated on ALREADY TRIMMED history.
      // Previously videoBudgetSec() received full (untrimmed) message
      // list: in a long chat no "free space" remained, and
      // video ref was trimmed to 2-second floor (Math.max(2, ...)) — model
      // described 2 seconds of the video instead of, say, 20. The point of trimming is
      // "only the tail fits the context", so media budget must also be calculated
      // from the tail.
      const budgetBase = trimToContext(
        messages as unknown as Parameters<typeof trimToContext>[0],
        actualLlmContextSize(),
        cfg.llmMaxOutputTokens,
      )
      // FIX 36: audio is not sent to LLM (model cannot hear it),
      // therefore hasAudioParts is always false and audio probe (llm-audio-guard) is a
      // no-op safety net. Preserved in case LLM audio support
      // is restored: reliability run will work automatically again.
      let hasAudioParts = false
      // (fix 716/717) Cap on reference count — by type, exactly matching
      // client (getReferences in assistant-stream.ts: REF_LIMITS =
      // image 9 / video 3 / audio 3, total 15) and H3 model itself.
      //
      // Previously there was a single cap of 9 IN ORDER: system prompt numbered
      // ALL references (number by type), but only the first 9 positions
      // were sent over the wire. The model wrote <Picture 12> in prompt and described pictures
      // it DID NOT see. Now both sides clamp identically by type —
      // prompt and actual attachment always match.
      const REF_LIMITS = { image: 9, video: 3, audio: 3, total: 15 } as const
      const cappedReferences = (() => {
        if (!Array.isArray(references)) return undefined
        const counters = { image: 0, video: 0, audio: 0 }
        const out: NonNullable<typeof references> = []
        for (const r of references as NonNullable<typeof references>) {
          if (out.length >= REF_LIMITS.total) break
          const kind = r.kind ?? 'image'
          if (kind === 'image') {
            if (counters.image >= REF_LIMITS.image) continue
            counters.image++
          } else if (kind === 'video') {
            if (counters.video >= REF_LIMITS.video) continue
            counters.video++
          } else if (kind === 'audio') {
            if (counters.audio >= REF_LIMITS.audio) continue
            counters.audio++
          }
          out.push(r)
        }
        return out
      })()
      if (references && cappedReferences && references.length > cappedReferences.length) {
        console.warn(
          `[llm] references ${references.length} — using ${cappedReferences.length} (per-type limits)`,
        )
      }
      if (cappedReferences?.length) {
        const inputDir = path.join(cfg.comfyRoot, 'ComfyUI', 'input')
        const outputDir = cfg.outputDir
        const tmpDir = path.join(cfg.comfyRoot, 'ComfyUI', 'models', 'llm', '_tmp_vision')
        mkdirSync(tmpDir, { recursive: true })
        const mediaParts: Array<Record<string, unknown>> = []
        const textParts: string[] = []
        // Digests are CONTEXT, not the user's request. They are appended to the
        // system message so a short answer like "1" is not buried under a big
        // reference-description block in the last user message.
        const digestTextParts: string[] = []
        // (fix 53) true if frames of at least one video ref are attached to request
        let videoAttached = false
        // Reference digests: video first (as agreed with the user), then images.
        // Each one is generated in an isolated LLM request and cached by file
        // identity; the main chat receives only the compact text. If a digest
        // fails, the old raw-media path below is kept as a fallback.
        const digestByTrigger = new Map<string, string>()
        let digestUsed = false
        const useRefDigest = body?.useRefDigest !== false
        // Model fingerprint for cache invalidation: switching Qwen/Bonsai,
        // a different quantization, or another custom GGUF must not reuse
        // descriptions produced by the previous model.
        const digestModelKey = [
          activeLlmModelId(),
          cfg.llmModel,
          backend === 'custom' ? cfg.llmCustomModel : '',
        ].filter(Boolean).join('|')
        const resolveRefPath = async (refPath: string, preferOutput = false): Promise<string | null> => {
          const tryInput = (): string | null => {
            const absPath = path.resolve(inputDir, refPath)
            const inside = absPath.startsWith(path.resolve(inputDir) + path.sep)
            return inside && existsSync(absPath) ? absPath : null
          }
          const tryOutput = (): string | null => {
            const absPath = path.resolve(outputDir, refPath)
            const inside = absPath.startsWith(path.resolve(outputDir) + path.sep)
            return inside && existsSync(absPath) ? absPath : null
          }
          // ControlNet direct takes source from gallery (output), not from input:
          // if filenames match, input copy might belong to another task.
          // Regular references do not look in output: a different file with
          // the same name may reside there, while staged copy is their valid fallback.
          if (preferOutput) {
            const output = tryOutput()
            if (output) return output
          }
          const input = tryInput()
          if (input) return input
          // (fix 697) Staging fallback: when ComfyUI is down,
          // uploadInputFile() places ref in .local-input/ and returns staged name.
          return await stagedPath(refPath)
        }
        if (useRefDigest) {
          const digestStartedAt = Date.now()
          // Keep the first turn from blocking the 10-minute client header
          // watchdog indefinitely. If we run out of budget, remaining refs use
          // the raw-media fallback and the chat still starts.
          const digestBudgetMs = 7 * 60_000
          const digestOrder = [...cappedReferences].sort((a, b) => {
            const rank = (k: string | undefined) => (k === 'video' ? 0 : k === 'image' ? 1 : 2)
            return rank(a.kind) - rank(b.kind)
          })
          for (const ref of digestOrder) {
            if (Date.now() - digestStartedAt > digestBudgetMs) {
              console.warn('[llm] ref digest budget exhausted — remaining references use raw media')
              break
            }
            const kind = ref.kind ?? 'image'
            if (kind === 'audio') continue
            if (kind === 'video' && !cfg.llmVideoVision) continue
            const resolved = await resolveRefPath(ref.path, ref.intent === 'control_source')
            if (!resolved) continue
            const result = await getReferenceDigest({
              ref,
              resolvedPath: resolved,
              backend,
              modelId: digestModelKey,
              videoVision: cfg.llmVideoVision,
              signal: req.signal,
            })
            if (result.ok && result.digest) {
              digestByTrigger.set(ref.trigger, result.digest)
              digestUsed = true
            } else {
              console.warn(`[llm] ref digest unavailable for ${ref.trigger}: ${result.error ?? 'unknown error'} — falling back to raw media`)
            }
          }
        }
        const uid = () => `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
        // (fix 169) how many whole videos will enter context (standard backend
        // with vision enabled): we limit duration of each by available
        // space IN ADVANCE — a 512px frame costs ~768 vision tokens, and a 60-second
        // ref at 8 fps would consume entire context window alone.
        const genVideoCount = cfg.llmVideoVision && backend !== 'bonsai'
          ? cappedReferences.filter((r) => r.kind === 'video').length
          : 0
        const refVideoSec = videoBudgetSec(budgetBase, genVideoCount, actualLlmContextSize(), cfg.llmMaxOutputTokens)

        for (const ref of cappedReferences) {
          // (fix 170) SECURITY: ref.path comes from client without validation —
          // path traversal (../../ or absolute path) allowed arbitrary file reading.
          // resolveRefPath keeps path inside input/output
          // (safeAttachPath approach) and falls back to staging.
          const resolvedPath = await resolveRefPath(ref.path, ref.intent === 'control_source')
          if (!resolvedPath) {
            // FIX 36: ref file is missing on disk — explicitly notify model
            // so it DOES NOT invent its contents. Previously silent `continue`
            // caused mismatch: system prompt listed ref, but media was
            // not attached → model confabulated (bug #3).
            textParts.push(`[${ref.trigger}] file="${ref.path}" (COULD NOT ATTACH — file not found on disk; do NOT describe, reference, or invent its content; if it matters, ask the user to re-attach it)`)
            continue
          }
          const safeName = path.basename(resolvedPath).replace(/[^a-zA-Z0-9.]/g, '_')

          if (ref.kind === 'video') {
            // A successful digest already contains the visual facts; do not
            // attach raw frames/video again (that is the whole point of the
            // cache). The old path below remains as a fallback.
            const digest = digestByTrigger.get(ref.trigger)
            if (digest) {
              digestTextParts.push(
                `[${ref.trigger}] file="${ref.path}" (reference digest generated from the actual video frames — treat it as what you observed${ref.includeAudio !== false ? '; it has an audio track for MiniMax — reference it as <Video N> and do NOT invent what is "heard" in it' : ''}):\n${digest}`,
              )
              continue
            }
            // (fix 53) By default assistant does NOT view video frames —
            // saves context: model only knows about EXISTENCE of video ref and
            // does NOT describe/invent its contents. Full vision is enabled
            // via "Assistant video vision" checkbox in settings (llm.video_vision).
            if (!cfg.llmVideoVision) {
              textParts.push(
                `[${ref.trigger}] file="${ref.path}" (video reference — its frames are NOT attached: assistant video-vision is OFF. You only know the video EXISTS. Reference it as <Video N> when the user asks to use it; do NOT describe, guess or invent what happens inside it. If the user wants you to "see" the video, tell them to enable "Assistant video vision" in Settings → LLM)`,
              )
              continue
            }
            // (fix 162) Bonsai: does not accept whole videos — extract frames
            // via ffmpeg to JPEG and send as image_url (OpenAI format).
            if (backend === 'bonsai') {
              const stamp = uid()
              const framesDir = path.join(tmpDir, `llmvidframes_${stamp}`)
              const frames = await extractVideoFrames(resolvedPath, framesDir) // (fix 697)
              if (frames) {
                mediaParts.push({ type: 'video', video_frames: frames })
                videoAttached = true
                tempFiles.push(...frames, framesDir)
                textParts.push(
                  `[${ref.trigger}] file="${ref.path}" (video frames attached — describe the scene, motion and camera behaviour over time, ONLY what is actually in the frames${ref.includeAudio !== false ? '; it has an audio track for MiniMax — reference as <Video N> and do NOT invent what is "heard" in it' : ''})`,
                )
              } else {
                textParts.push(`[${ref.trigger}] file="${ref.path}" (video reference — could NOT extract frames to attach, ask user if visual details matter; do NOT describe it as if you saw it)`)
              }
              continue
            }
            // Whole video as ONE {"type":"video"} part: the MTMD video helper
            // (patched into llama_multimodal.py via lazy bitmap) decodes it
            // frame-by-frame during tokenization. We only downscale (≤512px)
            // and cap the rate at 8 fps so the frame count — and hence the
            // vision tokens — stay small.
            //
            // FIX 36: video audio track is NOT sent to LLM — the model
            // CANNOT listen to audio (in tests it responds "unable to hear"),
            // while old prompt said "you hear it" → invented dialogue.
            // Audio goes to MiniMax directly (ref_video_audio); LLM only
            // places <Video N> in prompt text.
            const stamp = uid()
            const baseName = ref.path.replace(/[^a-zA-Z0-9]/g, '_')
            const videoOut = path.join(tmpDir, `llmvid_${stamp}_${baseName}.mp4`)
            const audioOut = path.join(tmpDir, `llmvidaud_${stamp}_${baseName}.wav`)
            // (fix 169) duration — based on available context room
            const prepared = await prepVideoForLlm(resolvedPath, videoOut, audioOut, 512, 8, refVideoSec) // (fix 697)
            if (prepared) {
              mediaParts.push({ type: 'video', video: prepared.videoPath, est_frames: refVideoSec * 8 })
              videoAttached = true
              tempFiles.push(prepared.videoPath)
              if (prepared.audioPath) tempFiles.push(prepared.audioPath) // created for MiniMax, but not sent to LLM
              textParts.push(
                `[${ref.trigger}] file="${ref.path}" (whole video attached — describe the scene, motion and camera behaviour over time, ONLY what is actually in the frames${ref.includeAudio !== false ? '; it has an audio track for MiniMax — reference as <Video N> and do NOT invent what is "heard" in it' : ''})`,
              )
            } else {
              textParts.push(`[${ref.trigger}] file="${ref.path}" (video reference — could NOT transcode it to attach, ask user if visual details matter; do NOT describe it as if you saw it)`)
            }
            continue
          }

          if (ref.kind === 'audio') {
            // FIX 36: audio is NOT sent to LLM. The model CANNOT listen
            // to it (in tests: "I'm unable to hear or process the audio"),
            // while old prompt claimed "you HEAR them" → model either refused,
            // or INVENTED content (bugs #2 and #3). Audio goes to MiniMax
            // as ref_audios directly (see use-video-gen.ts), LLM only places
            // <Audio N> in prompt text. WAV is not generated for LLM at all.
            textParts.push(
              `[${ref.trigger}] file="${ref.path}" (audio reference for MiniMax voice/tone, intent: ${ref.intent || 'voice'} — the model CANNOT hear it; reference it as <Audio N> and do NOT describe or quote its content)`,
            )
            continue
          }

          const imageDigest = digestByTrigger.get(ref.trigger)
          if (imageDigest) {
            digestTextParts.push(
              `[${ref.trigger}] file="${ref.path}" (intent: ${ref.intent || 'identity'}; reference digest generated from the actual image — treat it as what you observed):\n${imageDigest}`,
            )
            continue
          }

          // Image: resize to max 512px longest side — keeps vision tokens low
          const outPath = path.join(tmpDir, `vision_${uid()}_${safeName}`)
          try {
            await sharp(resolvedPath) // (fix 697) staged-fallback
              .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
              .jpeg({ quality: 80 })
              .toFile(outPath)
            mediaParts.push({ type: 'image', image: outPath })
            tempFiles.push(outPath)
          } catch {
            // Fallback: use original (might be slow)
            mediaParts.push({ type: 'image', image: resolvedPath }) // (fix 697)
          }
          textParts.push(`[${ref.trigger}] file="${ref.path}" (intent: ${ref.intent || 'identity'})`)
        }

        // Digests go into the SYSTEM context, never into the last user
        // message. A short reply like "1" must remain the actual request; a
        // big reference block in the same message made the model answer the
        // block (repeating reference summaries/ideas) instead of "1".
        if (digestTextParts.length > 0) {
          const digestBlock = [
            '=== REFERENCE DIGESTS (internal visual memory) ===',
            'These are descriptions of the current generation references, not a user request. Use them as visual context for the actual request in the last user message; do not repeat or summarize this block unless the user asks. Do not mention the word "digest" to the user.',
            ...digestTextParts,
          ].join('\n')
          const sys = messages[0]
          if (sys && sys.role === 'system') {
            if (typeof sys.content === 'string') {
              messages[0] = { ...sys, content: `${sys.content}\n\n${digestBlock}` }
            } else if (Array.isArray(sys.content)) {
              messages[0] = { ...sys, content: [...sys.content, { type: 'text', text: digestBlock }] }
            } else {
              messages[0] = { ...sys, content: digestBlock }
            }
          } else {
            messages.unshift({ role: 'system', content: digestBlock })
          }
        }

        // (fix 53) attach not only when media is present: textParts may
        // contain "tag-only" notes (video with vision disabled, audio).
        // Previously such notes were quietly lost, and the model didn't know about refs.
        if (mediaParts.length > 0 || textParts.length > 0) {
          // Bind to the LAST user message (current turn) rather than the
          // first (fix 35): model responds to the last turn —
          // references should stand next to it; trimToContext cuts
          // history from the beginning, and old first message (with media) was dropped
          // first — vision was quietly lost in long chats.
          const introText = digestUsed
            ? [
                'Reference digests are in the system context (internal visual memory; not a user request).',
                mediaParts.length > 0
                  ? 'References that could not be digested are attached as raw media; you can see those directly.'
                  : '',
                'You CANNOT hear the audios — reference them as <Audio N> and do NOT describe or quote their content.',
              ].filter(Boolean).join(' ')
            : videoAttached
              ? 'Attached references (you can SEE the images and WATCH the video frames; you CANNOT hear the audios — this model has no reliable audio input). Images: describe faces, hair, clothing, colors, distinguishing details — ONLY what is actually visible, do not invent details. Videos: attached as whole short clips (≤512px, 8 fps) — describe the scene, motion and camera behaviour over time, ONLY what is actually in the frames. Audios: attached for MiniMax voice/tone ONLY — the model CANNOT hear them, so reference them as <Audio N> and do NOT describe or quote their content.'
              : 'Attached references (you can SEE the attached images — describe faces, hair, clothing, colors, distinguishing details — ONLY what is actually visible, do not invent details; video references are TAGS ONLY — their frames are NOT attached to save context, so you only know they EXIST: use their <Video N> tags when the user asks, and do NOT describe, guess or invent what happens inside them). You CANNOT hear the audios — reference them as <Audio N> and do NOT describe or quote their content.'
          let lastUserIdx = -1
          for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === 'user') { lastUserIdx = i; break }
          }
          if (lastUserIdx >= 0) {
            const existingText = typeof messages[lastUserIdx].content === 'string'
              ? messages[lastUserIdx].content
              : ''
            messages[lastUserIdx] = {
              role: 'user',
              // Text part first, media parts in reference order — the chat
              // template renders media markers exactly in part order.
              content: [
                {
                  type: 'text',
                  text: `${introText} ${textParts.join('; ')}.\n\n${existingText}`,
                },
                ...mediaParts,
              ],
            }
          }
        }
      }

      // (fix 108) Chat attachments — ISOLATED from generation references.
      // Files reside in data/chat-attachments/ (new storage) or legacy
      // ComfyUI/input/ (fixes 86–87, legacyComfy). They are needed ONLY for
      // LLM description/analysis:
      //   • attached to LLM as "Chat N" (NOT "Picture N"/"Video N");
      //   • model is explicitly forbidden to use them as <Picture N>/<Video N> in
      //     prompt — they are NOT generation references (MiniMax must not
      //     pull them from input/ into generation);
      //   • video attachments are ALWAYS attached as frames (user explicitly
      //     attached them to chat for description) — independent of llmVideoVision
      //     (that flag controls only video refs for generation).
      const chatAttachments = body?.chatAttachments as Array<{
        path: string
        name?: string
        kind: 'image' | 'video'
        legacyComfy?: boolean
      }> | undefined
      if (chatAttachments?.length) {
        const attachDir = path.resolve(process.cwd(), 'data', 'chat-attachments')
        const caInputDir = path.join(cfg.comfyRoot, 'ComfyUI', 'input')
        const caTmpDir = path.join(cfg.comfyRoot, 'ComfyUI', 'models', 'llm', '_tmp_vision')
        mkdirSync(caTmpDir, { recursive: true })
        const caMediaParts: Array<Record<string, unknown>> = []
        const caTextParts: string[] = []
        const caUid = () => `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
        let caNum = 0
        // (fix 169) duration of video attachments — also based on free space
        // in context (512px frame ≈ 768 tokens; see videoBudgetSec).
        const caVideoSec = videoBudgetSec(
          budgetBase,
          chatAttachments.filter((a) => a.kind === 'video').length,
          actualLlmContextSize(),
          cfg.llmMaxOutputTokens,
        )
        for (const att of chatAttachments) {
          caNum++
          // (fix 117) att.path — filename in attachment store AS-IS.
          // Upload endpoint already generates safe filename from original's basename
          // (e.g. mtyx1rqu-j776gm-photo.jpg — WITH HYPHENS).
          // Previously we re-sanitized the name
          // (replace(/[^a-zA-Z0-9.]/g, '_')), converting hyphens into
          // underscores → file was "not found" on EVERY new attachment
          // (model received COULD NOT ATTACH). Now we take basename as-is
          // (traversal-safe: no separators in name by construction).
          const attName = String(att.path).split(/[\\/]/).pop() || ''
          const safeName = (attName || 'attachment').replace(/[^a-zA-Z0-9.]/g, '_')
          // (fix 170) SECURITY: legacyComfy flag is controlled by client, while
          // startsWith check previously applied only to non-legacy branch —
          // path traversal via att.path. Resolve and enforce staying inside
          // caInputDir; violation is rejected as "file not found" below.
          const legacyResolved = att.legacyComfy ? path.resolve(caInputDir, att.path) : null
          const legacySafe = legacyResolved !== null &&
            legacyResolved.startsWith(path.resolve(caInputDir) + path.sep)
          const absPath = att.legacyComfy
            ? (legacySafe ? legacyResolved : null)
            : attName && attName !== '.' && attName !== '..'
              ? path.resolve(attachDir, attName)
              : null
          const missing =
            !absPath ||
            (att.legacyComfy ? !existsSync(absPath) : !absPath.startsWith(attachDir) || !existsSync(absPath))
          if (missing) {
            console.warn('[llm] chatAttachment MISSING:', att.path, '→ resolved:', absPath ?? 'null', 'attachDir:', attachDir)
            caTextParts.push(
              `[Chat ${caNum}] file="${att.path}" (COULD NOT ATTACH — file not found in the chat-attachments store; do NOT describe or invent its content; ask the user to re-attach it)`,
            )
            continue
          }
          if (att.kind === 'video') {
            // (fix 162) Bonsai: extract frames → send as images.
            if (backend === 'bonsai') {
              const stamp = caUid()
              const framesDir = path.join(caTmpDir, `llmvidcaframes_${stamp}`)
              const frames = await extractVideoFrames(absPath, framesDir)
              if (frames) {
                caMediaParts.push({ type: 'video', video_frames: frames })
                tempFiles.push(...frames, framesDir)
                caTextParts.push(
                  `[Chat ${caNum}] file="${att.path}" (chat video frames attached — describe the scene, motion and camera behaviour over time, ONLY what is actually in the frames, do NOT invent details; it is NOT a generation reference: NEVER reference it as <Video N> in the prompt)`,
                )
              } else {
                caTextParts.push(
                  `[Chat ${caNum}] file="${att.path}" (chat video — could NOT extract frames to attach; ask the user if visual details matter; do NOT describe it as if you saw it; it is NOT a generation reference)`,
                )
              }
              continue
            }
            // (fix 108) chat video attachment ALWAYS as frames (does not depend
            // on llmVideoVision — that is only for gen refs).
            // (fix 169) duration — based on available context space.
            const stamp = caUid()
            const videoOut = path.join(caTmpDir, `llmvidca_${stamp}_${safeName}.mp4`)
            const audioOut = path.join(caTmpDir, `llmvidaudca_${stamp}_${safeName}.wav`)
            const prepared = await prepVideoForLlm(absPath, videoOut, audioOut, 512, 8, caVideoSec)
            if (prepared) {
              caMediaParts.push({ type: 'video', video: prepared.videoPath, est_frames: caVideoSec * 8 })
              tempFiles.push(prepared.videoPath)
              if (prepared.audioPath) tempFiles.push(prepared.audioPath)
              caTextParts.push(
                `[Chat ${caNum}] file="${att.path}" (chat video attached as frames — describe the scene, motion and camera behaviour over time, ONLY what is actually in the frames, do NOT invent details; it is NOT a generation reference: NEVER reference it as <Video N> in the prompt)`,
              )
            } else {
              caTextParts.push(
                `[Chat ${caNum}] file="${att.path}" (chat video — could NOT transcode it to attach; ask the user if visual details matter; do NOT describe it as if you saw it; it is NOT a generation reference)`,
              )
            }
            continue
          }
          // Image: resize to max 512px longest side — keeps vision tokens low
          const outPath = path.join(caTmpDir, `visionca_${caUid()}_${safeName}`)
          try {
            await sharp(absPath)
              .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
              .jpeg({ quality: 80 })
              .toFile(outPath)
            caMediaParts.push({ type: 'image', image: outPath })
            tempFiles.push(outPath)
          } catch {
            // Fallback: use original (might be slow)
            caMediaParts.push({ type: 'image', image: absPath })
          }
          caTextParts.push(
            `[Chat ${caNum}] file="${att.path}" (chat attachment — attached ONLY for your description/analysis; it is NOT a generation reference: NEVER reference it as <Picture N>, <Video N> or <Audio N> in the prompt)`,
          )
        }
        // (fix 689) Debug: verify that chat attachments are attached
        console.log('[llm] chatAttachments:', caTextParts.length, 'text parts,', caMediaParts.length, 'media parts')
        if (caTextParts.length > 0) {
          // (fix 108) Attach to the SAME last user message (current turn) —
          // model responds to it; trimToContext doesn't trim
          // media messages, and history is cut from start (fixes 35, 53, 108).
          const caIntro =
            'CHAT ATTACHMENTS (isolated from generation references — they exist ONLY in this chat and are used ONLY for your description/analysis; they are NOT <Picture N>/<Video N>/<Audio N> — do NOT reference them as such in any prompt):'
          let caLastIdx = -1
          for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === 'user') { caLastIdx = i; break }
          }
          if (caLastIdx >= 0) {
            const existing = messages[caLastIdx].content
            const existingMedia = (Array.isArray(existing)
              ? (existing as Array<Record<string, unknown>>)
              : []
            ).filter((p) => p && p.type !== 'text')
            // (fix 717) Marker order and media order now MATCH:
            // text in order [refs..., Chat N...], then media in same order
            // (gen-ref media first, then chat attachment media).
            // Previously text started with caIntro (chat markers FIRST), while
            // media went refs first: chat template renders markers strictly in
            // part order, and the model matched the marker to the WRONG image.
            const refTextParts = typeof existing === 'string'
              ? existing
              : (Array.isArray(existing)
                  ? (existing as Array<Record<string, unknown>>)
                      .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
                      .map((p) => String(p.text))
                      .join(' ')
                  : '')
            messages[caLastIdx] = {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: [
                    refTextParts,
                    `${caIntro} ${caTextParts.join('; ')}.`,
                  ]
                    .filter(Boolean)
                    .join('\n\n'),
                },
                ...existingMedia,
                ...caMediaParts,
              ],
            }
          }
        }
      }

      // Autofill remaining context, but not exceeding manual setting
      // [llm] max_output_tokens (UI "Max output tokens").
      // IMPORTANT: compute input on ALREADY trimmed history — otherwise in a long chat
      // untrimmed volume pressed maxTokens to floor, and answers were cut off
      // even where trim freed up plenty of context.
      // (fix 169, 338) adaptive floor: usually 256 (minimally useful
      // response), but when window is almost full — 64: a short response is better than
      // guaranteed overflow. Media is already constrained by this point
      // (videoBudgetSec), and Bonsai frames are thinned if needed by
      // degradeMediaToBudget.
      // (fix 338) SINGLE pass of trimToContext (previously two: for room calculation
      // and for result). Trim reserves manual limit cfg.llmMaxOutputTokens
      // for response; resulting maxTokens never exceeds it
      // (previously Math.max(256, ...) punctured manual limit from below). Minimum 64:
      // with critically small room context is trimmed to 64 budget.
      const ctxSize = actualLlmContextSize()
      const preTrimmed = trimToContext(messages, ctxSize, cfg.llmMaxOutputTokens)
      const inputTokens = preTrimmed.reduce((sum, m) => sum + messageTokens(m), 0)
      const room = ctxSize - inputTokens - 128
      const maxTokens = Math.max(64, Math.min(cfg.llmMaxOutputTokens, room))
      // (fix 169) trim → media degradation: guarantee that [system + tail]
      // actually fits the window even with a "heavy" last message.
      const trimmed = degradeMediaToBudget(preTrimmed, ctxSize, maxTokens)

      // (fix 135) Fine-tuning sampling: set tailored for
      // family of ACTIVE model (Gemma 4 12B vs Qwen3.5 9B) — see
      // src/lib/llm-sampling.ts. Prior to this fix only temperature went to llm_server,
      // while top_p/top_k/min_p/penalty took llama-cpp defaults
      // (top_k=40, top_p=0.95, min_p=0.05), which performs worse on our models →
      // periodic looping and thought channel degeneration.
      // Priority is stability (fewer glitches), not creativity.
      const baseSampling = body.sampling ?? samplingForModel(activeLlmModelId())

      // (fix 716) Client sampling is VALIDATED and clamped. Previously
      // body.sampling/body.temperature were passed upstream as-is, bypassing all
      // constraints that app-config.ts applies to the same fields when
      // reading from config.ini (top_p <= 1, top_k 1..200, penalties 0..2.5).
      // String instead of number also slipped through.
      const clampNum = (v: unknown, def: number, lo: number, hi: number): number => {
        const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
        if (!Number.isFinite(n)) return def
        return Math.max(lo, Math.min(hi, n))
      }
      const rawSampling = (body.sampling ?? {}) as Partial<typeof baseSampling>
      const sampling = {
        temperature: clampNum(rawSampling.temperature, baseSampling.temperature, 0, 2),
        top_p: clampNum(rawSampling.top_p, baseSampling.top_p, 0, 1),
        top_k: Math.round(clampNum(rawSampling.top_k, baseSampling.top_k, 0, 200)),
        min_p: clampNum(rawSampling.min_p, baseSampling.min_p, 0, 1),
        presence_penalty: clampNum(rawSampling.presence_penalty, baseSampling.presence_penalty, 0, 2.5),
        frequency_penalty: clampNum(rawSampling.frequency_penalty, baseSampling.frequency_penalty, 0, 2.5),
        repeat_penalty: clampNum(rawSampling.repeat_penalty, baseSampling.repeat_penalty, 0, 2.5),
      }

      // Audio reliability (without Whisper): model is unstable on "raw" audio —
      // some runs degenerate into looping (<|channel>thought × N and
      // repeat of single phrase × N). If request contains audio — do a short
      // non-streaming run (~48 tokens) with increasing temperature and
      // take first NON-degenerative: its temperature goes into main
      // response. Stop tokens (LLM_STOP_TOKENS) trim thought channel on the fly anyway.
      // Probe does not crash assistant: on any error —
      // continue with initial temperature.
      let finalTemperature = clampNum(body.temperature, sampling.temperature, 0, 2)
      if (hasAudioParts) {
        try {
          const probe = await probeAudioAnswer({
            baseUrl: `http://127.0.0.1:${LLM_PORT}`,
            messages: trimmed,
            baseTemperature: finalTemperature,
            sampling, // (fix 135) — probe runs with same top_p/top_k/penalty as main response
            log: (m) => console.log('[llm] audio-probe:', m),
          })
          finalTemperature = probe.temperature
          console.log('[llm] audio-probe:', probe.note)
        } catch (e) {
          console.warn('[llm] audio-probe failed, continuing:', e)
        }
      }

      // Timeout only for establishing connection (see comment on fetch).
      const headerTimeout = {
        controller: new AbortController(),
        timer: setTimeout(() => headerTimeout.controller.abort(), 120_000),
      }
      // (fix 136) Bonsai backend: OpenAI /v1/chat/completions + conversion
      // of media parts into data-URI, response is wrapped in our SSE format.
      noteLlmActivity()
      let upstream: Response
      let upstreamBody: ReadableStream<Uint8Array> | null = null
      // (fix 717) Timer is cleared in finally: previously clearTimeout was
      // AFTER fetch, and on exception (LLM server not running → ECONNREFUSED)
      // timer remained armed for 120 s on each failed request.
      try {
        if (backend === 'bonsai') {
          const oaiMessages = await toOpenAiMessages(trimmed)
          upstream = await fetch(`http://127.0.0.1:${LLM_PORT}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              messages: oaiMessages,
              max_tokens: maxTokens,
              stream: true,
              // (fix) Disable "thinking" at TEMPLATE level — launch flag
              // --reasoning-budget 0 does not work in fork, and with thinking
              // enabled responses degraded (drifted off-topic, and with
              // small max_tokens did not complete at all — finish:length
              // inside reasoning). enable_thinking=false is a template parameter
              // of Qwen family: <think> closes immediately, responds instantly.
              chat_template_kwargs: { enable_thinking: false },
              temperature: finalTemperature,
              top_p: sampling.top_p,
              top_k: sampling.top_k,
              min_p: sampling.min_p,
              presence_penalty: sampling.presence_penalty,
              frequency_penalty: sampling.frequency_penalty,
              repeat_penalty: sampling.repeat_penalty,
              // do NOT send stop tokens: <|channel|> is a Qwen3.5 specific marker,
              // not needed for Bonsai template (EOS is handled by llama-server).
            }),
            signal: headerTimeout.controller.signal,
          })
          if (upstream.ok && upstream.body) {
            upstreamBody = openAiSseToDelta(upstream.body)
          }
        } else {
          upstream = await fetch(`http://127.0.0.1:${LLM_PORT}/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              // (fix 717) request_id — abort address: /abort with this id
              // stops this exact generation.
              ...(requestId ? { request_id: requestId } : {}),
              messages: trimmed,
              max_tokens: maxTokens,
              // (fix 135) — pass full sampling set; llm_server.py reads
              // each key and forwards to llama-cpp-python create_chat_completion.
              temperature: finalTemperature,
              top_p: sampling.top_p,
              top_k: sampling.top_k,
              min_p: sampling.min_p,
              presence_penalty: sampling.presence_penalty,
              frequency_penalty: sampling.frequency_penalty,
              repeat_penalty: sampling.repeat_penalty,
              stop: LLM_STOP_TOKENS,
            }),
            // Insurance against frozen llm_server: timeout applies ONLY to
            // connection establishment (SSE headers arrive immediately, so normally
            // fetch resolves in milliseconds). Once response is received,
            // timer is cleared — AbortSignal.timeout cannot be used here: it aborts
            // the body stream too, cutting off any response longer than 2 minutes. Idle watchdog
            // below protects against stream freezes.
            signal: headerTimeout.controller.signal,
          })
          if (upstream.ok && upstream.body) {
            upstreamBody = upstream.body
          }
        }
      } finally {
        clearTimeout(headerTimeout.timer)
      }
      if (!upstream.ok || !upstreamBody) {
        const errText = await upstream.text().catch(() => '')
        cleanup()
        // (fix 173) 409 from llm_server.py ("LLM already generating another
        // response") is NOT a 502 failure: forward clean 409 with clear
        // JSON rather than nested JSON inside error text (UI could not parse it).
        if (upstream.status === 409) {
          return { kind: 'busy' as const }
        }
        return { kind: 'upstream-error' as const, error: `LLM error: ${errText || upstream.status}` }
      }
      // Streaming counter is enabled under mutex (startChat contract): from this
      // moment until response ends generation receives 409.
      noteLlmStreaming(1)
      return { kind: 'ok' as const, body: upstreamBody }
    })

    if (!gate.ok) {
      cleanup()
      return new Response(JSON.stringify({ error: gate.error }), {
        status: gate.status,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    const v = gate.result
    if (v.kind === 'start-error') {
      cleanup()
      return new Response(JSON.stringify({ error: v.error }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (v.kind === 'busy') {
      // (fix 173) Clean 409 for parallel request — client
      // (assistant-stream) parses { error } and displays it as-is.
      return new Response(
        JSON.stringify({ ok: false, error: 'Assistant is already generating another response — please wait for completion' }),
        { status: 409, headers: { 'Content-Type': 'application/json' } },
      )
    }
    if (v.kind === 'upstream-error') {
      return new Response(JSON.stringify({ error: v.error }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Visible in catch below (try-block variables are out of scope there).
    let finishRef: (() => void) | null = null

    // Proxy SSE manually (reader → writer): first, server KNOWS when
    // response ends (including disconnection) and lifts generation lock;
    // second, idle watchdog aborts FROZEN stream — otherwise streaming counter
    // would hang forever and generation would receive 409 forever.
    // temp-files: safety net. 60 s is not enough — lazy video decoding and
    // generation itself run AFTER stream starts and can last minutes;
    // normally finish() cleans up files right after response ends.
    // 15 minutes = finishWatchdog boundary: temp files are deleted no earlier
    // than stream is guaranteed finished (at 10 min a live stream could
    // lose its video files in the midst of lazy tokenization).
    const safetyTimer = setTimeout(cleanup, 15 * 60_000)
    // (fix 110) finish() watchdog: if drain pump hangs (hung
    // writer.write/close on client's half-open socket), finish() from finally
    // would never execute and streaming counter would hold generation lock
    // FOREVER (409 button permanently). A healthy stream doesn't live 15 minutes —
    // idle watchdog aborts LLM after 5 min of silence.
    let finishWatchdog: ReturnType<typeof setTimeout> | null = null
    try {
      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
      const reader = v.body.getReader()
      const writer = writable.getWriter()

      // Fix 31: model reading and serving client are DECOUPLED via buffer.
      // Old pump was sequential (read → await writer.write): slow
      // client (background tab) created back-pressure on llm_server, and
      // idle watchdog could trigger because "client isn't reading" rather than
      // frozen model. Now: upstream loop only reads model into buffer,
      // drain loop only feeds client — neither waits on the other.
      const buffer: Uint8Array[] = []
      let bufferedBytes = 0
      let upstreamDone = false
      let upstreamFailed = false
      let clientGone = false
      const MAX_BUFFERED = 8 * 1024 * 1024 // do not buffer more than 8 MB in memory

      let idleTimer: ReturnType<typeof setTimeout> | null = null
      const armIdleWatchdog = () => {
        if (idleTimer) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => {
          console.log('[llm] stream frozen (no data for 5 min) — aborting')
          upstreamFailed = true
          void reader.cancel().catch(() => {})
        }, 5 * 60_000)
      }

      let finished = false
      const finish = () => {
        if (finished) return
        finished = true
        if (idleTimer) clearTimeout(idleTimer)
        clearTimeout(safetyTimer)
        if (finishWatchdog) clearTimeout(finishWatchdog) // (fix 110)
        noteLlmStreaming(-1)
        cleanup()
      }
      finishRef = finish

      // (fix 110) Force finish() even if drain loop hangs forever.
      finishWatchdog = setTimeout(() => {
        if (!finished) {
          console.warn('[llm] (fix 110) finish watchdog: 15 min without finish() — forcing lock release')
          finish()
        }
      }, 15 * 60_000)

      // Upstream: read model into buffer independently from client. If client
      // lags behind significantly — wait until buffer drains (back-pressure on model,
      // not on browser tab).
      void (async () => {
        try {
          armIdleWatchdog()
          for (;;) {
            if (clientGone) break
            const { done, value } = await reader.read()
            if (done) break
            armIdleWatchdog()
            // (fix 171) Bonsai idle-watchdog (llm-runner, 10 min) killed
            // server in the middle of long response: activity was recorded once
            // before stream. Update on every SSE delta — same as touch() on
            // every chunk in standard backend (tools/llm_server.py).
            if (backend === 'bonsai') noteLlmActivity()
            buffer.push(value)
            bufferedBytes += value.length
            while (bufferedBytes > MAX_BUFFERED && !clientGone) {
              // Slow client ≠ frozen model: reset idle watchdog,
              // otherwise 8 MB buffer draining longer than 5 min would falsely kill
              // a healthy stream.
              armIdleWatchdog()
              await new Promise((r) => setTimeout(r, 20))
            }
          }
          upstreamDone = true
        } catch {
          upstreamFailed = true
        }
      })()

      // Drain: feed client until buffer is empty and upstream is done.
      void (async () => {
        try {
          for (;;) {
            const chunk = buffer.shift()
            if (chunk) {
              bufferedBytes -= chunk.length
              await writer.write(chunk)
              continue
            }
            if (upstreamDone || upstreamFailed || clientGone) break
            await new Promise((r) => setTimeout(r, 10))
          }
          if (upstreamFailed && !clientGone) {
            try { await writer.abort() } catch { /* already closed */ }
          } else if (!clientGone) {
            try { await writer.close() } catch { /* already closed */ }
          }
        } catch {
          // client disconnected (tab closed, network) — abort upstream
          // reading as well, so we don't hold connection with llm_server
          clientGone = true
          void reader.cancel().catch(() => {})
        } finally {
          finish()
        }
      })()

      return new Response(readable, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      })
    } catch (err) {
      // Gap between "stream started" and "pump running": decrement counter and
      // forward to outer catch (500), without leaving lock behind.
      // Via finish() — it is idempotent (`finished` guard); direct
      // noteLlmStreaming(-1) here would double-decrement if
      // pumps already scheduled their own finish().
      if (finishRef) {
        finishRef()
      } else {
        // throw occurred before finish creation — raw rollback
        noteLlmStreaming(-1)
        cleanup()
        clearTimeout(safetyTimer)
        if (finishWatchdog) clearTimeout(finishWatchdog) // (fix 110)
      }
      throw err
    }
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : 'Internal error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    )
  }
}
