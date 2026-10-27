/**
 * Server-side metadata writer (fix 21).
 *
 * Previously .meta.json sidecars were written ONLY by the browser after it
 * saw the job finish — closing the tab/window while the ComfyUI queue kept
 * generating produced videos without metadata. Now:
 *
 *   1. /api/comfy/generate  → recordPendingMeta(promptId, params)
 *      (server persists the job params immediately at submit time)
 *   2. /api/comfy/status    → markPendingRunning(promptId) on 'running',
 *                             finalizePendingMeta(promptId, outputs) on 'done'
 *                             (writes the sidecar even with no browser alive)
 *   3. /api/comfy/metadata  → client fast path: writeMetaSidecar() +
 *      clearPendingMeta() so the server copy never overwrites fresher data.
 *
 * Pending entries live in `<outputDir>/.pending-meta.json` (a dotfile — the
 * files listing skips dotfiles) and are pruned after 24h.
 */
import fs from 'fs'
import path from 'path'
import { getAppConfig } from '@/lib/app-config'
import { sanitizeFolderPath } from '@/lib/gallery-folders' // (fix 495)
import { probeVideoFile } from '@/lib/video-probe' // (fix 410)
import { computeFinalDimensions, finalDimsFromMegapixels, framesForDuration, clampLowResMP, selectResolution, type MiniMaxH3Params } from '@/lib/comfy/minimax-h3-template'
import { replaceVideoAudio, resolveOriginalAudioReplacement } from '@/lib/replace-video-audio' // (fix 699)

/* ──────────────────── shared helpers ──────────────────── */

/** (fixes 121, 124) Final video dimensions AFTER exact crop — same
 *  formula as in template (buildMiniMaxH3Workflow): preset → nominal
 *  (computeFinalDimensions), free resolution → finalDimsFromMegapixels.
 *  lowResMP no longer affects the result: upscaler uses "target dimensions". */
export function computeOutputDimensions(
  aspectRatio: string,
  megapixels: number,
  targetDimensions?: { width: number; height: number },
): { w: number; h: number } {
  const d = targetDimensions
    ? computeFinalDimensions(targetDimensions.width, targetDimensions.height)
    : finalDimsFromMegapixels(aspectRatio, megapixels)
  return { w: d.outW, h: d.outH }
}

/** Remove undefined values: in merge mode an explicit undefined
 *  would overwrite an already recorded value in sidecar, while JSON.stringify
 *  does not serialize undefined anyway (in standard mode behavior unchanged). */
function stripUndefined(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(o)) {
    if (v !== undefined) out[k] = v
  }
  return out
}

/**
 * (fix 722) Element-wise merge of `references` array (keyed by path).
 *
 * Why not standard "new overwrites old": writers' fields differ in composition,
 * and each knows something the other does not:
 *  • client knows `role` (imageIntent: character/scene/style/composition) —
 *    server knows nothing about role (request body contains only paths);
 *  • server knows `trim_start`/`trim_end` (trimming of audio references) and
 *    `compress` (compressed 480p video) — client does not write them.
 * Standard overwrite lost one or the other. Here: items from incoming,
 * while fields absent in incoming are preserved; non-empty `role` is preferred.
 */
function mergeReferences(existing: unknown, incoming: unknown): unknown {
  if (!Array.isArray(incoming)) return existing
  if (!Array.isArray(existing)) return incoming
  const byPath = new Map<string, Record<string, unknown>>()
  for (const r of existing) {
    if (r && typeof r === 'object' && !Array.isArray(r)) {
      const rec = r as Record<string, unknown>
      byPath.set(String(rec.path ?? ''), rec)
    }
  }
  const out: Array<Record<string, unknown>> = []
  for (const r of incoming) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) continue
    const rec = r as Record<string, unknown>
    const prev = byPath.get(String(rec.path ?? ''))
    const merged: Record<string, unknown> = { ...(prev ?? {}), ...rec }
    // Role: non-empty from either side (client knows, server does not).
    const role = rec.role || (prev ? prev.role : '') || ''
    merged.role = role
    out.push(merged)
  }
  return out
}

/** Write a .meta.json sidecar next to the output file + clean VHS
 *  byproducts (silent video / first-frame png). Returns the path or null.
 *
 *  (fix 722) opts.merge — MERGE with existing sidecar instead of
 *  complete overwrite. Problem this fixes: sidecars for the same file
 *  are written by TWO independent writers — server-side (pending-meta:
 *  recordPendingMeta → finalizePendingMeta) and client fast path
 *  (POST /api/comfy/metadata). Their field sets differed, and full overwrite
 *  meant "whichever ran last erased the other's fields".
 *  For example, actually applied custom LoRAs (`lora`) were only written by
 *  server, and client overwrote them without knowing. Now fields are merged:
 *  incoming overwrites old, old unfamiliar fields are preserved. */
export function writeMetaSidecar(
  filename: string,
  subfolder: string,
  params: Record<string, unknown>,
  opts?: { merge?: boolean },
): string | null {
  const OUTPUT_DIR = getAppConfig().outputDir
  if (!OUTPUT_DIR || !filename) return null

  const safeName = path.basename(filename)
  // (fix 495) subfolder — multi-level relative path ('a/b').
  const safeSub = subfolder ? sanitizeFolderPath(subfolder) : ''
  // (fix 348) startsWith without normalization on Windows compared paths with
  // different case/separators ('E:\\Out' vs 'e:\\out') — false negative
  // or false positive on foreign prefix. Compare resolved
  // paths (lowercase on win32), bounded by path separator.
  const outRoot = path.resolve(OUTPUT_DIR)
  const dir = path.resolve(path.join(outRoot, safeSub))
  const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p)
  const nDir = norm(dir)
  const nRoot = norm(outRoot)
  if (nDir !== nRoot && !nDir.startsWith(nRoot + path.sep)) return null

  const metaFile = path.join(dir, safeName + '.meta.json')
  fs.mkdirSync(dir, { recursive: true })
  let metadata: Record<string, unknown>
  if (opts?.merge) {
    // (fix 722) Merge: old sidecar is base, new fields on top.
    let existing: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(fs.readFileSync(metaFile, 'utf-8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed
    } catch { /* missing/corrupt sidecar — write from scratch */ }
    // (fix 722) Merge — ONLY within the same task. ComfyUI counter
    // resets on restart, and the name `Minimax_Studio_00001.mp4` might
    // belong to a new generation: old meta would then mix with new
    // (prompt is new, but `flf_resolution`/`lora` from old task).
    const oldJob = typeof existing.job_id === 'string' ? existing.job_id : null
    const newJob = typeof params.job_id === 'string' ? params.job_id : null
    const sameJob = oldJob === newJob
    metadata = sameJob
      ? { ...existing, ...stripUndefined(params) }
      : { ...stripUndefined(params) }
    // (fix 722) references — element-wise merge (see mergeReferences).
    if (sameJob) {
      const mergedRefs = mergeReferences(existing.references, params.references)
      if (mergedRefs !== undefined) metadata.references = mergedRefs
    }
    // created_at — file CREATION timestamp: a later write must not
    // overwrite it (otherwise "creation date" shifts on every write).
    if (sameJob && typeof existing.created_at === 'number') metadata.created_at = existing.created_at
    else metadata.created_at = Date.now() / 1000
  } else {
    metadata = {
      ...params,
      created_at: Date.now() / 1000,
    }
  }
  metadata.job_id = (params.job_id as string) || (metadata.job_id as string) || `srv_${Date.now().toString(36)}`
  fs.writeFileSync(metaFile, JSON.stringify(metadata, null, 2), 'utf-8')

  // VHS byproduct cleanup (same logic the client-facing route had).
  // Delete sibling ONLY if created AFTER this task started:
  // without mtime filtering a user file foo-audio.mp4 from a completely different
  // generation could erase a legitimate foo.mp4.
  const audioMatch = safeName.match(/^(.*)-audio\.[^.]+$/i)
  // (fix 715) Without started_at, DO NOT perform cleanup at all. Previously
  // `jobStartMs = ... : 0`, and condition `st.mtimeMs >= 0` was always true —
  // the protection "delete sibling only if created AFTER this task started"
  // became a no-op, and legitimate files of ANOTHER generation were deleted
  // (foo.mp4 next to foo-audio.mp4). Now: no timestamp — no deletion (fail-safe).
  // Additionally: timestamp must be plausible (not 0 and not from the future) —
  // otherwise client could pass 0 and restore previous fail-open behavior.
  const rawStart = params.started_at
  const jobStartMs =
    typeof rawStart === 'number' &&
    Number.isFinite(rawStart) &&
    rawStart > 0 &&
    rawStart <= Date.now() + 60 * 60 * 1000
      ? rawStart
      : null
  if (audioMatch && jobStartMs !== null) {
    const base = audioMatch[1]
    const ext = path.extname(safeName).toLowerCase()
    // (fix 587) Second condition: sibling is not newer than audio file itself
    // (otherwise it's a later unrelated file). If stat fails —
    // previous behavior (Infinity = condition does not restrict).
    let audioMtimeMs = Infinity
    try {
      audioMtimeMs = fs.statSync(path.join(dir, safeName)).mtimeMs
    } catch { /* audio file unavailable — don't block cleanup */ }
    const unwanted = [path.join(dir, base + ext), path.join(dir, base + '.png')]
    for (const f of unwanted) {
      try {
        const st = fs.statSync(f)
        // Sibling of the same task: modified after its start and not newer
        // than the audio file itself (otherwise it's a later unrelated file).
        if (st.mtimeMs >= jobStartMs && st.mtimeMs <= audioMtimeMs) fs.unlinkSync(f)
      } catch { /* file missing — ok */ }
    }
  }
  return metaFile
}

/* ──────────────────── pending-meta store ──────────────────── */

interface PendingEntry {
  params: Record<string, unknown>
  started_at: number
  /** Set on the first status poll that saw the prompt executing. */
  running_since?: number
  /** Set when a status poll saw the prompt QUEUED behind other jobs.
   *  Mirrors the client's `sawQueued` (use-video-gen.ts): a job that waited
   *  in the queue counts from its execution start, a job that went straight
   *  to execution counts from submission — otherwise the sidecar's
   *  generation_time diverges from the gallery badge. */
  saw_queued?: boolean
}

const PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000

function pendingFile(): string | null {
  const dir = getAppConfig().outputDir
  return dir ? path.join(dir, '.pending-meta.json') : null
}

function loadPending(): Record<string, PendingEntry> {
  const file = pendingFile()
  if (!file || !fs.existsSync(file)) return {}
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, PendingEntry>
    if (!parsed || typeof parsed !== 'object') return {}
    const now = Date.now()
    const fresh: Record<string, PendingEntry> = {}
    for (const [pid, e] of Object.entries(parsed)) {
      if (e && typeof e.started_at === 'number' && now - e.started_at < PENDING_MAX_AGE_MS) {
        fresh[pid] = e
      }
    }
    return fresh
  } catch {
    return {}
  }
}

function savePending(map: Record<string, PendingEntry>) {
  const file = pendingFile()
  if (!file) return
  try {
    fs.writeFileSync(file, JSON.stringify(map, null, 2), 'utf-8')
  } catch { /* non-critical */ }
}

/** Map a generate-request body to the canonical sidecar fields
 *  (same shape the browser writes — see use-video-gen genParamsMap). */
function bodyToMetaParams(body: MiniMaxH3Params): Record<string, unknown> {
  const fps = 24
  // (fix 138) default 5 → 2.5: minimum 2.5s
  const duration = body.duration ?? 2.5
  // Actual frame count the server produces (node 46:19), for metadata (fix 55).
  const videoLengthFrames = framesForDuration(duration, fps)
  const finalResolution = body.finalResolution ?? 0.7
  // (fixes 121, 124) EXACT final dimensions: preset → body.targetDimensions,
  // free resolution → MP path (same formula as in template)
  const { w, h } = computeOutputDimensions(body.aspectRatio || '16:9', finalResolution, body.targetDimensions)
  const genMode0: 'ref' | 't2v' | 'flf' | 'extend' = body.mode === 't2v' || body.mode === 'flf' || body.mode === 'extend' ? body.mode : 'ref'
  const draft0 = genMode0 !== 'extend' && body.pipeline === 'draft'
  // Draft: actual output = BASE resolution (like flf):
  // preset → ceil32(targetDimensions), free → finalRes MP
  const draftCanvas = draft0 && genMode0 !== 'flf'
    ? (body.targetDimensions
        ? {
            w: Math.max(32, Math.ceil(body.targetDimensions.width / 32) * 32),
            h: Math.max(32, Math.ceil(body.targetDimensions.height / 32) * 32),
          }
        : selectResolution(body.aspectRatio || '16:9', finalResolution))
    : null
  const resW = draftCanvas ? draftCanvas.w : w
  const resH = draftCanvas ? draftCanvas.h : h
  // (fix 2) Audio refs: preserve trim (trim_start/trim_end) —
  // restoring from meta restores it in UI.
  const references: Array<{ type: string; path: string; role: string; trim_start?: number; trim_end?: number | null; /** (fix 493) video ref was compressed to 480p */ compress?: boolean }> = [
    ...(body.refImages ?? []).map((p) => ({ type: 'image', path: p, role: '' })),
    // (fix 493) path is ORIGINAL (route only substitutes path for submission),
    // compress flag — "Retry" compresses anew (compression is cached).
    ...(body.refVideos ?? []).map((r) => ({ type: 'video', path: r.path, role: '', ...(r.compress === true && { compress: true }) })),
    ...(body.refAudios ?? []).map((p, i) => {
      const t = body.refAudioTrims?.[i]
      return t
        ? { type: 'audio', path: p, role: '', trim_start: t.start, trim_end: t.end }
        : { type: 'audio', path: p, role: '' }
    }),
  ]
  // (fix 470) flf: first frame is also an identity anchor. Previously it lived
  // only in first_frame field, and references for flf videos were empty → refine
  // (readMetaImageRefs reads only references) ran without meta refs, and resulting
  // refine sidecar severed the anchor chain permanently. Deduplicate by path.
  if (genMode0 === 'flf' && body.firstFrame && !references.some((r) => r.path === body.firstFrame)) {
    references.unshift({ type: 'image', path: body.firstFrame, role: '' })
  }
  // (fix 157) Modes + first frame dimensions — for "Retry"
  // (without first_frame_width/height aspect ratio won't be restored from frame
  //  and flf generation would produce wrong aspect ratio again).
  const genMode: 'ref' | 't2v' | 'flf' | 'extend' = genMode0
  const draft = draft0
  return {
    prompt: body.prompt,
    model_type: 'minimax_h3_ref2va',
    workflow: draft ? 'draft-single-pass' : 'two-pass-latent-upscaler',
    pipeline: draft ? 'draft' : 'full',
    seed: body.seed ?? -1,
    generation_mode: genMode,
    ...(genMode === 'ref' && body.audioGuide === true && { audio_guide: true }),
    ...(body.keepOriginalAudio === true && { keep_original_audio: true }),
    ...(genMode === 'flf' && {
      first_frame: body.firstFrame ?? null,
      last_frame: body.lastFrame ?? null,
      first_frame_width: body.firstFrameWidth ?? null,
      first_frame_height: body.firstFrameHeight ?? null,
      // (fix 722) Final nominal resolution of flf — "Retry" restores
      // this specifically rather than the UI preset. In preset mode targetDimensions
      // has already been computed by client as flfNominalDimensions (first frame aspect ratio).
      ...(body.targetDimensions && {
        flf_resolution: `${body.targetDimensions.width}x${body.targetDimensions.height}`,
      }),
    }),
    resolution: `${resW}x${resH}`,
    aspect_ratio: body.aspectRatio,
    // (fix 722) Task output subfolder — without it fallback lookup for output
    // file (concat/extend) does not know where to look.
    output_subfolder: body.outputSubfolder || '',
    final_resolution_mp: finalResolution,
    // Clamped value — same as in real workflow (clampLowResMP).
    // (fix 424) extend: additional cap by source MP — pass 1 canvas
    // must not exceed final on any axis (upscaler only upscales).
    low_res_mp: genMode0 === 'extend' && body.targetDimensions
      ? Math.min(
          clampLowResMP(body.lowResMP ?? 0.2, finalResolution),
          (body.targetDimensions.width * body.targetDimensions.height) / (1024 * 1024),
        )
      : clampLowResMP(body.lowResMP ?? 0.2, finalResolution),
    video_length: videoLengthFrames,
    duration_seconds: videoLengthFrames / fps,
    fps,
    // Extend: actual CLIP steps (override > firstSamplerSteps fallback) —
    // next extension reads "auto" value from this meta.
    pass1_steps: genMode === 'extend'
      ? (body.extendClipSteps ?? body.firstSamplerSteps ?? 6)
      : (body.firstSamplerSteps ?? 6),
    // Total steps in pass 1 schedule (split point = this number → "6 of 6").
    pass1_total_steps: body.firstSamplerTotalSteps ?? body.firstSamplerSteps ?? 6,
    // (fix 722) Steps of the SINGLE draft pass. Without this field, server
    // draft sidecar showed "6" in metadata dialog (split point value)
    // instead of actually used draft steps — and "Retry" was unable to restore draftSteps.
    ...(draft && { draft_steps: body.draftSteps ?? 4 }),
    pass2_steps: { '3step': 3, '4step': 4, '5step': 5, '6step': 6, '7step': 7 }[body.sigmaVariant || '3step'] ?? 3,
    sigma_variant: body.sigmaVariant || '3step',
    pass2_sampler: body.pass2Sampler || 'euler', // (fix 69)
    pass1_sampler: body.pass1Sampler || 'euler', // (fix 70)
    pass1_scheduler: body.pass1Scheduler || 'simple', // (fix 70)
    // Turbo LoRA is now re-attached (via customLoras, enabled by default),
    // so its name goes into `lora` below. Dedicated turbo strength is not
    // used in template — strength is stored in loras.json.
    minimax_h3_reference_detail: body.refImageSize || 'match', // (fix 58)
    sparse_attention: body.sparseAttention === true, // (fixes 168→387) Sol-Attn default OFF
    // (fix 466) Sol-Attn settings — "Retry" restores them
    ...(body.sparseAttention === true && {
      sparse_tau: body.sparseTau ?? 1.3,
      sparse_start_percent: body.sparseStartPercent ?? 0.2,
      sparse_end_percent: body.sparseEndPercent ?? 1.0,
      sparse_min_tokens: body.sparseMinTokens ?? 12288,
      sparse_extra_tokens: body.sparseExtraTokens ?? 256,
    }),
    veda_attention: body.vedaAttention === true, // (fix 301)
    // (fix 404) veda settings — "Retry" restores them
    ...(body.vedaAttention === true && {
      veda_generated_sparsity: body.vedaGeneratedSparsity ?? '90%',
      veda_reference_sparsity: body.vedaReferenceSparsity ?? '90%',
      veda_full_attention_layers: body.vedaFullAttentionLayers ?? '',
      veda_full_attention_steps: body.vedaFullAttentionSteps ?? '',
      veda_verbose: body.vedaVerbose === true,
    }),
    low_vram_attention: body.lowVramAttention !== false,
    chunk_feed_forward: body.chunkFeedForward !== false,
    ...(body.chunkFeedForward !== false
      ? {
          chunk_ff_chunks: body.chunkFFChunks ?? 2,
          chunk_ff_threshold: body.chunkFFThreshold ?? 4096,
        }
      : {}),
    // Actually applied LoRAs (including built-in turbo LoRA unless skipped
    // in flf+audio). May be empty; MetaDialog "More" removes field.
    lora: (body.customLoras ?? []).map((l) => l.name).join(', '),
    references,
    // (fix 161) extend mode: clips + refs
    ...(genMode === 'extend' && {
      extend_clips: body.extendClips || [],
      extend_refs: body.extendRefs || [],
      // (fix 260) extension source — what the video was made from
      source_video: body.extendSourceVideo ? { name: body.extendSourceVideo } : null,
      // (fix 722) Same data under client writer's property NAMES: client
      // sidecar wrote extend_source_video (string) and extend_clips_count, while
      // server wrote source_video {name} and extend_clips (array). Field sets
      // diverged, and "whoever wrote last" determined metadata contents.
      // Server now writes both variations.
      extend_source_video: body.extendSourceVideo ?? null,
      extend_clips_count: (body.extendClips || []).length,
      ...((body.extendClips || []).length > 0 && {
        extend_prompts: (body.extendClips || [])
          .map((c) => (c.prompt || '').trim())
          .filter((p) => /\p{L}{2,}/u.test(p)),
      }),
      // (fix 423) two-pass extension mode — in sidecar
      extend_two_pass: body.extendTwoPass === true,
    }),
  }
}

/** /api/comfy/generate: persist job params right after submission. */
export function recordPendingMeta(promptId: string, body: MiniMaxH3Params) {
  try {
    const map = loadPending()
    const startedAt = Date.now()
    // (fix 715) put started_at INSIDE params — otherwise finalization
    // (finalizePendingMeta) collects params from entry.params and timestamp
    // was lost → protection against deleting foreign siblings broke.
    map[promptId] = {
      params: { ...bodyToMetaParams(body), job_id: promptId, started_at: startedAt },
      started_at: startedAt,
    }
    savePending(map)
  } catch { /* non-critical */ }
}

/**
 * (fix 260) Write pending metadata for NON-generation jobs
 * (refine "Whole"/"Chunks"): parameters passed READY-MADE (without
 * MiniMaxH3Params mapping). Finalization by the same /api/comfy/status on 'done',
 * ensuring sidecar is created even if browser was closed.
 */
export function recordPendingMetaRaw(promptId: string, params: Record<string, unknown>) {
  try {
    const map = loadPending()
    const startedAt = Date.now()
    // (fix 715) started_at — inside params (see recordPendingMeta).
    map[promptId] = {
      params: { ...params, job_id: promptId, started_at: startedAt },
      started_at: startedAt,
    }
    savePending(map)
  } catch { /* non-critical */ }
}

/** /api/comfy/status: the prompt was seen waiting in the queue. */
export function markPendingQueued(promptId: string) {
  try {
    const map = loadPending()
    const e = map[promptId]
    if (e && !e.saw_queued) {
      e.saw_queued = true
      savePending(map)
    }
  } catch { /* non-critical */ }
}

/** /api/comfy/status: first observation of the prompt actually executing. */
export function markPendingRunning(promptId: string) {
  try {
    const map = loadPending()
    const e = map[promptId]
    if (e && e.running_since === undefined) {
      e.running_since = Date.now()
      savePending(map)
    }
  } catch { /* non-critical */ }
}

/** /api/comfy/status on 'done': write the sidecar server-side.
 *  Skips when the browser already wrote it (client data wins) or when the
 *  pending entry is missing. Returns the written path or null.
 *  `execMs` — REAL execution time from ComfyUI WS events (preferred);
 *  falls back to the submit/running-anchor estimate when unavailable
 *  (e.g. the tracker restarted mid-job). */
export async function finalizePendingMeta(
  promptId: string,
  outputs: Array<{ filename: string; subfolder?: string }>,
  execMs?: number | null,
): Promise<string | null> {
  try {
    const map = loadPending()
    const entry = map[promptId]
    if (!entry) return null
    delete map[promptId]
    savePending(map)

    const primary =
      outputs.find((o) => o.filename?.match(/\.(mp4|webm|mov|m4v)$/i) && !/Minimax_Studio_cnref/i.test(o.filename ?? '')) || outputs[0]
    if (!primary?.filename) return null

    // Generation time: prefer the REAL ComfyUI execution window (WS events);
    // fall back to the submit/running-anchor estimate (same rule as the
    // client badge: queued → from execution start, straight → from submit).
    const from = entry.saw_queued ? (entry.running_since ?? entry.started_at) : entry.started_at
    const durationMs = typeof execMs === 'number' && execMs > 0 ? execMs : Date.now() - from
    // (fix 375) Latent pipeline: output of MiniMaxStudioSaveAVLatent ('46:49')
    // arrives in outputs as {filename: *.latent, subfolder: '<sub>/latents'}.
    // Write path relative to output/ in sidecar — refine starts from it
    // with original latent (lossless branch of refine route).
    // (fix 383 → updated by fix 397, reverted by fix 417)
    // Guard "single video in job". After fix 417 extend produces MULTIPLE
    // videos again (individual extclip files) and has no latent —
    // guard automatically omits latent_file for extend jobs. Guard
    // protects against jobs with multiple video outputs where a single job
    // latent would not match each individual file.
    // (fix 420) Extend job with ONE clip has a latent (combined,
    // post-assembly), but it corresponds to the STITCHED result rather than the extclip file —
    // extend is explicitly excluded; result's latent_file is written by client to combined meta
    // when calling /api/comfy/concat.
    const vids = outputs.filter((o) => o.filename?.match(/\.(mp4|webm|mov|m4v)$/i) && !/Minimax_Studio_cnref/i.test(o.filename ?? ''))
    const latentOut = vids.length === 1 && entry.params.generation_mode !== 'extend'
      ? outputs.find((o) => o.filename?.match(/\.latent$/i))
      : undefined
    const latentFile = latentOut
      ? `${latentOut.subfolder ? latentOut.subfolder + '/' : ''}${latentOut.filename}`
      : null
    const params: Record<string, unknown> = {
      ...entry.params,
      // (fix 715) Job start timestamp — inside params, otherwise
      // writeMetaSidecar didn't see it and cleaned "unrelated" siblings.
      started_at: entry.started_at,
      generation_time: Math.max(1, Math.round(durationMs / 1000)),
      ...(latentFile && { latent_file: latentFile }),
    }

    // (fix 410, updated by fix 417) Extend with source: probe
    // video outputs. Previously fixed sidecar of combined file from latent combiner
    // (planned video_length of clips ≠ actual result). After rollback 417 extend
    // writes individual extclip files again — probe provides them with actual
    // frames/resolution (clip file is longer than clip plan by preserved head).
    // Final combined file is created by ffmpeg concatenation /api/comfy/concat — which
    // writes probed fields itself.
    const isExtendCombined =
      entry.params.generation_mode === 'extend' && !!entry.params.source_video
    // (fix 471) Refine: now saves result .latent → sidecar needs
    // EXACT video_length/resolution of output mp4 (resolveSourceLatent
    // compares them with ffprobe on subsequent refine). Refine has no planned
    // fields (in "Chunks" mode result length ≠ source length: 17k+5 grid and
    // window trims), so output is probed like extend.
    // (fix 722) Probe is also needed by other modes: for FPS/Tile Upscale/
    // ControlNet planned dimensions are INPUT parameters, whereas sidecar must
    // receive dimensions and duration of the FINAL file (otherwise metadata lies:
    // FPS has ×multiplier more frames than source).
    const needsProbe =
      isExtendCombined ||
      entry.params.generation_mode === 'refine' ||
      entry.params.generation_mode === 'fps' ||
      entry.params.generation_mode === 'tileupscale' ||
      entry.params.generation_mode === 'controlnet' ||
      entry.params.generation_mode === 'facerefine'

    // (fix 260) Sidecar on EVERY video output of the job (extend clips,
    // refine chunks), not just the first — metadata must exist
    // on every generated clip. Deduplicate by filename.
    const seen = new Set<string>()
    let last: string | null = null
    let i = 0
    const OUTPUT_DIR = getAppConfig().outputDir
    for (const o of outputs) {
      if (!o.filename?.match(/\.(mp4|webm|mov|m4v)$/i)) continue
      const key = `${o.subfolder || ''}/${o.filename}`
      if (seen.has(key)) continue
      seen.add(key)

      // (fix 699) FLF — always; ref with audio guide checked — by
      // keep_original_audio flag: substitute original track (references
      // type='audio') instead of regenerated audio, trimmed to video duration.
      // Perform BEFORE probe/sidecar — otherwise probe will see old audio stream.
      if (i === 0 && OUTPUT_DIR) {
        const videoPath = path.join(OUTPUT_DIR, o.subfolder || '', path.basename(o.filename))
        const audioPath = resolveOriginalAudioReplacement(params)
        if (audioPath) {
          try {
            const ok = await replaceVideoAudio(videoPath, audioPath)
            if (ok) {
              console.log(`[replace-audio] ${params.generation_mode}: swapped audio in ${o.filename} from ${path.basename(audioPath)}`)
              params.audio_replaced_from = path.basename(audioPath) // tag in sidecar
            }
          } catch (err) {
            console.error('[replace-audio] flf swap failed:', err)
          }
        }
      }

      let probed: Record<string, unknown> = {}
      if (needsProbe) {
        try {
          const filePath = path.join(OUTPUT_DIR, o.subfolder || '', path.basename(o.filename))
          const pr = await probeVideoFile(filePath)
          if (pr.width > 0 && pr.height > 0 && pr.frames > 0) {
            probed = {
              video_length: pr.frames,
              duration_seconds: Number(pr.durationSec.toFixed(2)),
              // Actual file fps (probed from r_frame_rate): FPS mode results
              // in 48/72 fps — previous hardcoded 24 was incorrect in sidecar.
              // Generation/refine already write 24 — value does not change.
              fps: Math.round(pr.fps ?? 24),
              resolution: `${pr.width}x${pr.height}`,
            }
          }
        } catch { /* probe is non-critical — planned fields remain */ }
      }
      last = writeMetaSidecar(o.filename, o.subfolder || '', {
        ...params,
        ...probed,
        ...(outputs.length > 1 ? { output_index: i } : {}),
      }, { merge: true }) ?? last
      i++
    }
    if (last) return last
    return writeMetaSidecar(primary.filename, primary.subfolder || '', params, { merge: true })
  } catch {
    return null
  }
}

/** Drop a pending entry (client already wrote the sidecar / job errored). */
export function clearPendingMeta(promptId: string) {
  try {
    const map = loadPending()
    if (promptId in map) {
      delete map[promptId]
      savePending(map)
    }
  } catch { /* non-critical */ }
}

/** (fix 511) Delete temporary depth/canny maps (Minimax_Studio_cnref_*.mp4)
 *  from ComfyUI output folder. Files are created by VHS_VideoCombine (cn_preout)
 *  during ControlNet generation for VHS_LoadVideoPath; after job completion
 *  they are unnecessary. "Map" mode creates Minimax_Studio_controlmap_*
 *  (different prefix) — not affected by cleanup.
 *
 *  (fix 716) Now ONLY maps for the specific job are deleted (by
 *  unique prefix cn_ref_prefix). Previously prefix was generic
 *  ("Minimax_Studio_cnref" + ComfyUI counter) and cleanup removed ALL maps —
 *  including maps of a concurrently running ControlNet task, causing it
 *  to crash inside VHS_LoadVideoPath. If prefix is unknown (e.g.
 *  job did not use ControlNet) — delete nothing. */
export async function cleanupCnrefTempFiles(_promptId: string, prefix?: string | null) {
  try {
    if (!prefix) return
    const cfg = getAppConfig()
    const outDir = cfg.outputDir
    if (!outDir) return

    // Prefix from job — sanitize to prevent it from becoming a wildcard
    // for arbitrary deletion via glob-like matching.
    const safePrefix = prefix.replace(/[^A-Za-z0-9_.-]/g, '')
    if (!safePrefix) return
    const fileRe = new RegExp(`^${safePrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*\\.mp4$`, 'i')

    const files = fs.readdirSync(outDir)
    for (const f of files) {
      if (fileRe.test(f)) {
        try { fs.unlinkSync(path.join(outDir, f)) } catch { /* ignore */ }
      }
    }
    // Subfolders (outputSubfolder)
    for (const f of files) {
      const fp = path.join(outDir, f)
      try {
        if (!fs.statSync(fp)?.isDirectory()) continue
      } catch { continue }
      try {
        const sub = fs.readdirSync(fp)
        for (const sf of sub) {
          if (fileRe.test(sf)) {
            try { fs.unlinkSync(path.join(fp, sf)) } catch { /* ignore */ }
          }
        }
      } catch { /* ignore */ }
    }
  } catch { /* non-critical */ }
}

/**
 * (fix 716) Temporary reference map prefix for task (from pending-meta).
 * Read BEFORE finalization while the entry exists.
 */
export function getPendingCnRefPrefix(promptId: string): string | null {
  try {
    const map = loadPending()
    const e = map[promptId]
    const p = e?.params?.cn_ref_prefix
    return typeof p === 'string' && p ? p : null
  } catch {
    return null
  }
}
