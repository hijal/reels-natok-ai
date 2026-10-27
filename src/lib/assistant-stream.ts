'use client'

/**
 * Assistant stream engine (fix 31) — lives at MODULE scope, NOT in a
 * component, so an in-flight LLM reply SURVIVES AssistantView unmount.
 *
 * Why this exists: switching app tabs unmounts AssistantView (page.tsx uses
 * AnimatePresence). Previously the SSE read loop was a fire-and-forget
 * closure inside the component (`void runCompletion(...)`): after unmount its
 * state updates no-oped, its only strong references were gone, and the
 * re-mounted view never reattached to the in-flight stream — so the model
 * answered "into the void" and the user had to resend.
 *
 * Now:
 *  • the async fetch/reader loop runs here, at module level, and completes
 *    regardless of component lifecycle;
 *  • on completion the reply is committed to the persisted chats store —
 *    a (re)mounted view renders it because it derives messages from the
 *    store reactively;
 *  • while streaming, any mounted view reattaches by subscribing to the
 *    tiny `useAssistantStream` store below and renders the live tail.
 */
import { create } from 'zustand'
import { toast } from 'sonner'
import { useAssistantChats, type AssistantChatMessage, type AssistantChatMode } from './assistant-chats-store'
import { useGenStore } from './gen-store'
import { useControlNetTarget } from './controlnet-target-store' // (fix 502)
import { H3_SPEC_A, H3_SPEC_B, H3_SPEC_EXTEND } from './h3-prompt-spec'

export interface LlmStatusResp {
  running: boolean
  starting: boolean
  gpuMode: 'gpu' | 'cpu' | null
  modelReady: boolean
  /** Active LLM model ID (depends on selected quantization). */
  modelId: string
  /** (fix 257) Active model file name (for custom model labels). */
  modelName?: string
  /** Assistant is currently streaming a response (to lock generation). */
  streaming: boolean
  /** Assistant is busy (loading or responding). */
  assistantBusy: boolean
  /** Video generation in progress — chat is locked. */
  blockedByGeneration: boolean
}

/**
 * Pre-cap on the wire (equal to store ceiling — 200 msg/chat); exact
 * token truncation is done by server (fix 169): system prompt + longest
 * fitting tail of recent messages. Long chats degrade
 * gracefully — only the beginning of history is trimmed, assistant always remembers
 * the system prompt and what was discussed at the end.
 */
const HISTORY_LIMIT = 200

/** System prompt: compact OFFICIAL H3 spec + live session context.
 * (fix 168) Generation context (mode, refs, frames, duration) the model
 * sees AUTOMATICALLY and always CURRENT — without manual steps as before.
 * Prompt draft from generation form is NOT inserted into system prompt:
 * this was the main channel of topic "leakage" between chats (prompt pasted
 * from another chat was pulled by the model into a new dialog). The user quotes the draft
 * in the message itself (the "Improve my prompt" button does this automatically).
 * (fix 53) `videoVisionOn` — whether assistant sees video refs (setting
 * "Video vision by assistant", enabled by default). Video comes as a compressed
 * digest description, not raw frames. Without this flag prompt must not
 * tell the model "you SEE frames", otherwise it invents content.
 * (fix 150) Assistant sees CURRENT GENERATION MODE (t2v/flf/ref) from gen-store
 * and builds system prompt taking the mode into account: in t2v/flf forbids tags <Picture N>,
 * <Video N>, <Subject N> (MiniMaxH3ReferenceToVideo node is not used),
 * <Audio N> remains allowed for audio references.
 * (fix 427) `chatMode` — CHAT mode ('generate' | 'extend'), not the form
 * generation mode: extend chats get a separate system prompt
 * (buildExtendSystemMessage) — previously 'extend' mode of the form fell through to
 * ref branch with alien refs of "Generate" tab. Async: extend branch reads
 * source metadata via /api/comfy/meta.
 * (fix 502) 'controlnet' mode — its own system prompt
 * (buildControlNetSystemMessage) and "ControlNet" tab references. */
async function buildSystemMessage(
  videoVisionOn: boolean,
  chatMode: AssistantChatMode = 'generate',
  signal?: AbortSignal,
): Promise<string> {
  // (fix 427) extend chat — its own context (clips, extend refs, source metadata).
  if (chatMode === 'extend') return buildExtendSystemMessage(signal)
  // (fix 502) controlnet chat — its own context (control video,
  // refImages of "ControlNet" tab, control parameters).
  if (chatMode === 'controlnet') return buildControlNetSystemMessage(videoVisionOn)
  const v = useGenStore.getState().video
  const mode = v.mode // (fix 150) 'ref' | 't2v' | 'flf' | 'extend'
  const refs = v.refs
  // (fix 138) default 124 → 60: minimum 2.5 s (60 frames at 24 fps)
  const frames = v.videoLength || 60
  const seconds = Math.max(2.5, Math.round(frames / 24))
  // Shot budget from configured duration: shot needs ≥ ~2 s to be "readable".
  // Without this limit, for an "epic scene" query the model produced a plan for
  // 15 shots, which physically does not fit in a 5–10-second clip.
  const maxShots = Math.max(1, Math.floor(seconds / 2))

  // (fix 717) Spec — by output format:
  //   ref      → FORMAT B (six sections, <Subject N> tags) — Ref2VA guide needed;
  //   t2v/flf  → FORMAT A (three fields) — guide NOT needed (extra ~1k tokens);
  //   extend   → "Generate" tab in extend mode: chat remains
  //              regular generation, but the mode CANNOT be silently ignored
  //              (previously it fell into t2v branch and gave conflicting
  //              instructions "FORMAT A" + "switch to
  //              References").
  const isExtendMode = mode === 'extend'
  const H3_SPEC = isExtendMode ? H3_SPEC_A : mode === 'ref' ? H3_SPEC_B : H3_SPEC_A

  // (fix 150) In t2v/flf only audio is passed from refs (images/videos are not used by node).
  // Show only audio refs to assistant so LLM does not write <Picture N>/<Video N>.
  // (fix 168) refs are visible ALWAYS, without exception for new chats (fix 166):
  // uniform and predictable behavior — model always sees the current workspace.
  const effectiveRefs = mode === 'ref' ? refs : refs.filter((r) => r.kind === 'audio')

  const images = effectiveRefs.filter((r) => r.kind === 'image')
  const videos = effectiveRefs.filter((r) => r.kind === 'video')
  const audios = effectiveRefs.filter((r) => r.kind === 'audio')

  // ── Explicit "attached references" block, numbered exactly like MiniMax ──
  // (images → <Picture N>, videos → <Video N>, audios → <Audio N>, each 1-based
  //  within its type — this is what MiniMax's ref_images/ref_videos/ref_audios expect)
  let attachedBlock: string

  // (fix 150) Mode-specific prefix for system prompt
  // (fix 717) 'extend' mode no longer falls into 'ref' branch:
  // previously it got the label "References (ref, Ref2VA)", followed by
  // "image and video references ARE NOT USED, format FORMAT A"
  // (conflict "FORMAT B / FORMAT A" in one prompt).
  const modeHint = isExtendMode
    ? '⚠️ The "Generate" tab is currently in EXTEND mode. This chat is standard generation: write FORMAT A. Prompts for extension are in the chat on "Extend" tab.'
    : mode === 't2v'
      ? '⚠️ CURRENT GENERATION MODE: "Text" (t2v). Tags <Picture N>, <Video N>, <Subject N> are FORBIDDEN — image and video references are not used. <Audio N> is PERMITTED ONLY if audio refs are attached below. Format is FORMAT A.'
      : mode === 'flf'
        ? '⚠️ CURRENT GENERATION MODE: "Frames" (flf, first/last frame → video). Tags <Picture N>, <Video N>, <Subject N> are FORBIDDEN — frames are set by form fields, not references. <Audio N> is PERMITTED ONLY if audio refs are attached below. Format is FORMAT A. Describe motion/transition between first and last frames.'
        : '⚠️ CURRENT GENERATION MODE: "References" (ref, Ref2VA).'

  // (fix 151) In flf mode, frames (startFrame/endFrame) are NOT refs, but they
  // are attached to LLM as images. Therefore "no references" condition must
  // account for frames: if there are frames or audio → go to flf branch, not "none".
  // (fix 168) frames — live from current generation form.
  const hasFlfFrames = mode === 'flf' && (!!v.startFrame?.path || !!v.endFrame?.path)

  if (effectiveRefs.length === 0 && !hasFlfFrames) {
    attachedBlock =
      modeHint + '\n' +
      'There are NO attached references → this is FORMAT A (text-to-video).\n' +
      'FORBIDDEN to use any tags <Picture N>, <Video N>, <Audio N>, <Subject N>.'
  } else if (mode === 'ref') {
    const lines: string[] = []
    // (fix 137) STRICT mode: references attached → ONLY FORMAT B
    // with tags. Models regularly "forgot" about references and produced
    // text-to-video prompt without a single tag — now explicitly forbidden.
    lines.push('⚠️ GENERATION MODE: REFERENCES attached → prompt ONLY in FORMAT B (Ref2VA).')
    lines.push('FORBIDDEN to output FORMAT A (text-to-video) or prompt without tags when references are attached.')
    lines.push('First field of fence is subject_definitions (NOT integrated_multimodal_description).')
    lines.push('Every ATTACHED IMAGE must get into the prompt with its <Picture N> tag: create <Subject N> in subject_definitions, link to <Picture N>, and mention in shot description.')
    lines.push('<Video N> — include tag if shot uses motion/scene from video reference; <Audio N> — if voice/sound from audio reference (character lines via it).')
    lines.push('A PROMPT WITHOUT A SINGLE REFERENCE TAG when references are attached = ERROR. Before responding verify: each tag from the list below is present in the prompt (or consciously explained why reference is not used).')
    lines.push('')
    if (images.length) {
      lines.push('IMAGES — you receive a visual description (digest) of each image, generated from the file itself (if file is directly attached — you see it):')
      images.forEach((r, i) => {
        lines.push(`  <Picture ${i + 1}> = ${r.name}${r.imageIntent ? ` (used as: ${r.imageIntent})` : ''}`)
      })
    }
    if (videos.length) {
      if (videoVisionOn) {
        lines.push('VIDEOS — you receive a visual description (digest) generated from video frames:')
        videos.forEach((r, i) => lines.push(`  <Video ${i + 1}> = ${r.name}${r.includeAudio ? ' (has audio track — model does NOT hear it, see rule on AUDIO)' : ''}`))
        lines.push('  Describe according to factual digest: scene, characters, MOTION and camera behavior over the clip, not just the first frame. Do not invent details not present in description.')
      } else {
        // (fix 53) video vision is off: frames NOT attached — model
        // knows only about the PRESENCE of video. Strictly forbid describing/inventing.
        lines.push('VIDEOS — attached ONLY as tags (frames NOT attached: assistant video vision is off, context saving):')
        videos.forEach((r, i) => lines.push(`  <Video ${i + 1}> = ${r.name}${r.includeAudio ? ' (has audio track — model does NOT hear it, see rule on AUDIO)' : ''}`))
        lines.push('  Reference <Video N> as a tag when user requests (e.g. "motion from <Video 1>"). Do NOT describe, guess or invent what happens inside the video — you do NOT see it.')
      }
    }
    if (audios.length) {
      if (v.audioGuide) {
        lines.push('AUDIO — Audio Guide: original track guides generation and is inserted into final video. Model does NOT hear its contents, but timing/sound character is already set:')
        audios.forEach((r, i) => lines.push(`  <Audio ${i + 1}> = ${r.name}`))
        lines.push('  Reference <Audio 1> as original track/guide. Take character lines and text ONLY from user query, do not invent "heard" words.')
      } else {
        lines.push('AUDIO — attached as VOICE/sound references for MiniMax (ref_audios). Model CANNOT listen to them and does NOT know what lines are spoken:')
        audios.forEach((r, i) => lines.push(`  <Audio ${i + 1}> = ${r.name}`))
        lines.push('  In prompt reference <Audio N> as voice/sound reference (MiniMax uses file itself). Take specific line ONLY from user query text — do not invent what is "heard" in audio.')
      }
    }
    const forbidden: string[] = []
    if (!videos.length) forbidden.push('<Video N>')
    if (!audios.length) forbidden.push('<Audio N>')
    lines.push('')
    if (forbidden.length) {
      lines.push(`⚠️ RULE: in prompt ONLY tags from the list above are PERMITTED. Forbidden to use ${forbidden.join(', ')} — no such references exist in this session, do not invent them.`)
    } else {
      lines.push('⚠️ RULE: in prompt use ONLY tags listed above (e.g. if only <Audio 1> exists — write <Audio 1>, not <Audio 2>).')
    }
    if (!audios.length) lines.push('Write voices and lines in <d>...</d> WITHOUT referencing <Audio N> (no audio attached). Do not describe voice as "referenced from <Audio N>" / "voice timbre from <Audio N>" — just specify tone/gender/age in words.')
    if (!videos.length) lines.push('Describe motion and camera in words, not as "from <Video N>" (no video attached).')
    attachedBlock = lines.join('\n')
  } else if (mode === 'flf') {
    // (fix 151) "Frames" mode: frames (startFrame/endFrame) attached as image refs —
    // LLM SEES them and describes in words. <Picture N> is FORBIDDEN (frames are not ref2va refs).
    // Audio refs are also sent (via MiniMaxH3AddGuide) — <Audio N> is allowed.
    const lines: string[] = [modeHint, '']

    // (fix 151) Show frames as "visual descriptions" (or actual
    // attached files if digest failed).
    const hasStartFrame = !!v.startFrame?.path
    const hasEndFrame = !!v.endFrame?.path
    if (hasStartFrame || hasEndFrame) {
      lines.push('FRAMES (you receive their visual description / see attached file):')
      if (hasStartFrame) {
        lines.push(`  FIRST FRAME = ${v.startFrame!.name} — video starting point. Describe its content in words (scene, characters, composition, lighting).`)
      }
      if (hasEndFrame) {
        lines.push(`  LAST FRAME = ${v.endFrame!.name} — video final point. Describe its content in words.`)
      }
      lines.push('  ⚠️ FORBIDDEN to use <Picture N> tag for these frames — they are NOT ref2va references.')
      lines.push('  In prompt describe motion/transition BETWEEN first and last frames: what changes, camera movement, actions occurring.')
      lines.push('  If user says "based on ref" or "tell what is in the frame" — describe what is seen in digest / attached image.')
      lines.push('')
    }

    if (audios.length) {
      lines.push('AUDIO REFERENCES (attached, <Audio N> is ALLOWED):')
      audios.forEach((r, i) => lines.push(`  <Audio ${i + 1}> = ${r.name}`))
      lines.push('  Reference <Audio N> for voice/sound. Take specific dialogue line ONLY from user request text.')
      lines.push('')
    }

    const forbidden = ['<Picture N>', '<Video N>', '<Subject N>']
    lines.push(`⚠️ FORBIDDEN to use tags ${forbidden.join(', ')} — frames are set by form fields, not references. Format — FORMAT A.`)
    if (!audios.length) lines.push('Write voices and lines in <d>...</d> WITHOUT referencing <Audio N> (no audio attached).')
    attachedBlock = lines.join('\n')
  } else {
    // (fix 150) t2v: audio refs only, format A (no frames)
    const lines: string[] = [modeHint, '']
    if (audios.length) {
      lines.push('AUDIO REFERENCES (attached, <Audio N> is ALLOWED):')
      audios.forEach((r, i) => lines.push(`  <Audio ${i + 1}> = ${r.name}`))
      lines.push('  Reference <Audio N> for voice/sound. Take specific dialogue line ONLY from user request text.')
    }
    const forbidden = ['<Picture N>', '<Video N>', '<Subject N>']
    lines.push('')
    lines.push(`⚠️ FORBIDDEN to use tags ${forbidden.join(', ')} — in this mode image and video references ARE NOT USED. If user requests reference — tell them to switch to "References" mode. Format — FORMAT A.`)
    if (!audios.length) lines.push('Write voices and lines in <d>...</d> WITHOUT referencing <Audio N> (no audio attached).')
    attachedBlock = lines.join('\n')
  }

  // ── Visual anchor: lock characters/objects by what the model actually sees ──
  // (fix 717) Compressed: previously 4 points over 200+ characters each.
  const anchorBlock = images.length
    ? '\n=== VISUAL ANCHOR ===\n' +
      'You receive a visual description (digest) of attached images. For each character/object that must appear in shot:\n' +
      '1) Describe from factual digest: facial features, eyes, hair, skin, age, physique, clothing (color, style, details), distinguishing marks (scars, tattoos, glasses, jewelry).\n' +
      '2) Create <Subject N>, link to its <Picture N>, in retention_analysis mark fully_preserved listing details.\n' +
      '3) In detailed_description reference <Subject N> and repeat key details — otherwise MiniMax invents a different character.\n' +
      'If ref has no character (only location or style) — anchor is not needed.'
    : ''

  // ── Audio anchor: reference voice/tone for MiniMax (fix 36: model does NOT hear) ──
  // (fix 717) Points 3 and 4 merged with general "audio cannot be heard" rule
  // from honestyBlock — only MiniMax-specific items remain here.
  const hasAudioRefs = audios.length > 0 || videos.some((r) => r.includeAudio)
  const audioAnchorBlock = hasAudioRefs
    ? '\n=== AUDIO ANCHOR ===\n' +
      'Audio references (and video audio tracks) are attached for MiniMax (ref_audios) — they set VOICE/SOUND in generation.\n' +
      '1) Reference <Audio N> (or audio track of <Video N>) as voice/sound reference — MiniMax uses file itself.\n' +
      '2) Take line/dialogue ONLY from user query. If not given — indicate character speaks and link <Audio N>, but do not invent words.\n' +
      '3) Specify voice character (tone, gender, age) in words only if user described it.'
    : ''

  // (fix 53) hint depends on video vision: when off,
  // model should not "watch" video, only reference tag <Video N>.
  const rescanHint = videoVisionOn
    ? 'use the reference digests/attached images and the video digests; do not invent details beyond them'
    : 'look at images; videos are TAGS ONLY — you do NOT see their frames, so never describe, guess or invent their content'

  // (fix 717) ONE block instead of three: "STRICT HONESTY RULE" +
  // "INDEPENDENCE OF CHATS" + "CHAT ATTACHMENTS" + tail "Chat behaviour".
  // Points 1-3, 6, and 8 of old blocks repeated the same thing in different words
  // (tags forbidden / current list is truth / audio cannot be heard), taking
  // ~2.4k tokens and repeating rule "cannot hear audio" in audio anchor too.
  const honestyBlock =
    '\n=== HONESTY AND CHAT BOUNDARIES ===\n' +
    '1) Current list of references above is the sole source of truth. Describe only them and only what actually exists in them. What you do not see or are unsure about — say plainly "cannot see", do not invent.\n' +
    '2) References not in current list NO LONGER EXIST: do not carry over their descriptions from earlier turns in this chat.\n' +
    '3) You CANNOT hear audio: do not quote or describe its contents, reference only as <Audio N>; take spoken lines from user text.\n' +
    '4) This chat is an independent dialog: you do not see or remember messages from other chats. Do not transfer topics, characters, scenes, prompts, or settings from there.\n' +
    '5) Prompt draft from generation form is NOT shown to you. If asked to "improve current prompt" and text is absent — ask user to click "Improve prompt" or send text. Do not invent it.\n' +
    '6) Attachments from chat are only for description/analysis, NOT generation references: NEVER tag them <Picture N>/<Video N>/<Audio N>. If attachment should appear in video — instruct user to add it to references on "Generate" tab.'

  // (fix 540) 3D draft → ControlNet: toggle and instructions removed
  const guide3dBlock = ''

  return `${H3_SPEC}

=== SESSION CONTEXT ===
Clip duration: ~${seconds} s (${frames} frames @ 24 fps). Timecodes within duration.
Shot budget: no more than ~${maxShots} (shot is readable in ~2 s).${seconds <= 6 ? ' For this duration — ONE continuous [Shot 1], no cuts.' : ' Count [Shot N] before replying: if exceeds budget — merge into longer shots.'}

=== MODE AND REFERENCES ===
${attachedBlock}
${anchorBlock}${audioAnchorBlock}
${honestyBlock}
${guide3dBlock}

Before EVERY prompt, consult the CURRENT list of references above (${rescanHint}), but do NOT recite it to the user or repeat idea lists. Do not ask about duration — it is specified.`
}

/**
 * (fix 427) System prompt for "Extend" mode chat.
 * Separate from generation: context — extend clips (extendClips), SEPARATE
 * extend image refs (extendImageRefs, NOT v.refs!) and metadata of the source
 * video (.meta.json: source prompt + extend history). Main rules:
 * each clip prompt in a separate ```text fence with marker `clip: N` on first
 * line (UI inserts into card by marker); <Video 1> and camera-lock
 * are FORBIDDEN — they are added automatically on submit (extend-view.tsx,
 * fixes 165/197), duplicating breaks conditioning.
 */
async function buildExtendSystemMessage(signal?: AbortSignal): Promise<string> {
  const v = useGenStore.getState().video
  const clips = v.extendClips
  const refs = v.extendImageRefs

  const lines: string[] = []
  lines.push('⚠️ CHAT MODE: "Extend". Helping write prompts for video EXTENSION CLIPS. There is no general prompt here — each clip continues the previous one (clip 1 continues the source video).')

  // ── Extension clips: number, duration, current prompt ──
  lines.push('')
  if (clips.length) {
    lines.push(`EXTENSION CLIPS (total ${clips.length}):`)
    clips.forEach((c, i) => {
      const p = c.prompt.trim()
      lines.push(`  Clip ${i + 1}: ${c.duration} s, prompt: ${p ? `"${p}"` : '"empty"'}`)
    })
  } else {
    lines.push('There are NO extension clips yet. If user asks for clip prompt — tell them to add a clip on "Extend" tab, or suggest prompts with clip numbers to create.')
  }

  // ── Source video ──
  if (v.extendSourceVideoPath) {
    lines.push(`Source video: ${v.extendSourceName ?? v.extendSourceVideoPath}${v.extendSourceDuration > 0 ? ` (~${v.extendSourceDuration.toFixed(1)} s)` : ''}.`)
  } else {
    lines.push('Source video is NOT selected yet — extension cannot run without it; suggest user select it on "Extend" tab if needed.')
  }

  // ── Extension references (extendImageRefs — its own <Picture N> numbering) ──
  lines.push('')
  if (refs.length) {
    lines.push('EXTENSION REFERENCES (images; you receive their visual description / see attached file):')
    refs.forEach((r, i) => {
      lines.push(`  <Picture ${i + 1}> = ${r.name}${r.imageIntent ? ` (used as: ${r.imageIntent})` : ''}`)
    })
  } else {
    lines.push('NO EXTENSION REFERENCES → tags <Picture N> are FORBIDDEN, do not invent them.')
  }

  // ── Source metadata: original prompt + extension history ──
  // Read .meta.json sidecar (like extend-view.tsx, fix 389): model must
  // continue THIS EXACT scene, not invent source contents.
  if (v.extendSourceName) {
    try {
      const metaPath = v.extendSourceSubfolder
        ? `${v.extendSourceSubfolder}/${v.extendSourceName}`
        : v.extendSourceName
      const mr = await fetch(`/api/comfy/meta?path=${encodeURIComponent(metaPath)}`, {
        // (fix 717) Timeout and abort signal. Previously this request went without
        // signal: hung /api/comfy/meta permanently locked await, and
        // therefore the entire stream loop: UI remained in "streaming" state,
        // send() refused, and without "Stop" the chat could not be revived.
        signal: signal ?? AbortSignal.timeout(8000),
      })
      if (mr.ok) {
        const meta = (await mr.json()) as {
          prompt?: unknown
          source_prompt?: unknown
          extend_prompts?: unknown
        }
        const srcPrompt =
          typeof meta.source_prompt === 'string' && meta.source_prompt.trim()
            ? meta.source_prompt.trim()
            : typeof meta.prompt === 'string'
              ? meta.prompt.trim()
              : ''
        const history = Array.isArray(meta.extend_prompts)
          ? meta.extend_prompts.filter((p): p is string => typeof p === 'string' && !!p.trim())
          : []
        if (srcPrompt || history.length) {
          lines.push('')
          lines.push('=== SOURCE VIDEO (from metadata) ===')
          if (srcPrompt) lines.push(`Source prompt: "${srcPrompt.slice(0, 2000)}"`)
          if (history.length) {
            lines.push('Extension history (already generated clips, old to new):')
            history.forEach((p, i) => lines.push(`  ${i + 1}. "${p.trim().slice(0, 500)}"`))
          }
        }
      }
    } catch { /* no sidecar/network — skip block, not an error */ }
  }

  // (fix 717) Extension rules compressed: 10 points → 8 (was ~2.8k tokens).
  // What is important and KEPT: clip: N marker, "do not rewrite static elements",
  // "<Picture N> tags only from list", "one shot by default", "sound".
  // What was REMOVED as duplicates: "honesty" (moved to general block below),
  // repeated "do not rewrite static elements" (was in both DETAIL_ACTION and here),
  // repeated "tags only from list" (was both here and in honesty block).
  const rulesBlock =
    '\n=== EXTENSION RULES (strict) ===\n' +
    '1) Prompt of EACH clip — SEPARATE fence. FIRST line inside fence — marker `clip: N` (N = clip card number from list above, 1-based), then only prompt text. UI inserts prompt into card BY THIS MARKER — insertion is impossible without it.\n' +
    '2) QUERY → ALL CLIPS: distribute user overall request sequentially across ALL clips from list above (clip: 1 … clip: N) taking duration of each into account. Fewer prompts than clips only if user explicitly asks for a specific clip ("rewrite clip 2").\n' +
    '3) NEVER write tag <Video 1> or instructions like "continue same scene/camera" (camera lock) in clip prompt — they are added to EACH clip automatically. Duplication spoils the prompt.\n' +
    '4) DO NOT RE-DESCRIBE WHAT IS ALREADY GIVEN: model sees tail of previous video and references — appearance, clothing, location, lighting, and atmosphere are ALREADY set and continue on their own. Clip prompt = NEW action/motion/event of chunk (and new elements if appearing). Mention static elements ONLY if they change.\n' +
    '5) REFERENCE TAGS: if image refs exist — on FIRST mention of character/object in EACH clip place its tag <Picture N> ("<Picture 1> stops and turns around..."). Only from list above. Tags <Subject N>, <Character N>, etc. are FORBIDDEN — they are not bound to anything and reference will fail.\n' +
    '6) ONE SHOT BY DEFAULT: entire extension is one continuous take (same camera, same action unfolding over time). DO NOT split clip into multiple shots ("[Shot 1]/[Shot 2]", "cut to") and do not start clip with a "new shot". Multishot — only on EXPLICIT request ("make multishot", "different angle"). Clips continue each other seamlessly: clip 1 starts from last frame of source, clip N — from last frame of clip N-1; fit timecodes within clip duration.\n' +
    '7) SOUND: if speech/dialogue/voiceover NOT requested — in overall_soundscape MANDATORILY write "no voice, no speech, no dialogue, no narration" as first words, then ambient scene sounds. non_diegetic_music: N/A. Do NOT add voice, lines, narration, or music by default.\n' +
    '8) Clip prompt format — as in H3 spec: integrated_multimodal_description / overall_soundscape / non_diegetic_music. No camera-lock and no <Video 1>.'

  // (fix 717) General honesty/boundaries block — same as in generate mode.
  const honestyBlock =
    '\n=== HONESTY AND CHAT BOUNDARIES ===\n' +
    '1) Describe only what you see on references or know from metadata above. What you cannot see — state plainly "cannot see / do not know", do not speculate on source video content.\n' +
    '2) Clips, references, and source above are CURRENT state of "Extend" tab (shared workspace), not chat history. Clips/refs from past turns not in lists above NO LONGER exist.\n' +
    '3) This chat is an independent dialog of "Extend" mode: you do not see messages from other chats. Do not transfer topics, characters, scenes, or prompts from there.\n' +
    '4) Attachments from chat are only for description, NOT extension references: NEVER tag them <Picture N>. If attachment should appear in video — instruct user to add it to image refs on "Extend" tab.'

  return `${H3_SPEC_EXTEND}

=== SESSION CONTEXT (EXTENSION) ===
${lines.join('\n')}
${rulesBlock}
${honestyBlock}

Clip prompt — ONLY in fence, first line — \`clip: N\`. Multiple clips = multiple consecutive fences. Short note before fence — OK.
Before EVERY prompt reread CURRENT lists of clips and references above (look at attached images).`
}

/**
 * (fix 502) System prompt for "ControlNet" mode chat.
 * Control video is passed as <Video 1> (ref_video_0) — this is official
 * video reference. Prompt — FORMAT B: with <Video 1> and (optionally) <Picture N>.
 * Do NOT describe motion in words — it is set by control; prompt describes
 * ONLY appearance: scene, characters, style, lighting, sound.
 */
function buildControlNetSystemMessage(videoVisionOn: boolean): string {
  const st = useControlNetTarget.getState()
  const direct = st.params.controlType === 'direct'

  const lines: string[] = []
  lines.push(
    direct
      ? '⚠️ GENERATION MODE: "ControlNet" (direct). This is animation transfer: motion, gestures, timing, and camera — from control video; new appearance created from prompt. Prompt describes appearance, not retelling motion. Format — FORMAT B.'
      : '⚠️ GENERATION MODE: "ControlNet" (Ref2VA). Video repeats motion of control clip; prompt describes appearance. Format — FORMAT B.',
  )

  // ── ATTACHED REFERENCES ──
  lines.push('')
  lines.push('=== ATTACHED REFERENCES (available references) ===')
  lines.push('⚠️ CURRENT GENERATION MODE: "ControlNet" (Ref2VA).')
  if (st.source) {
    if (direct) {
      lines.push(`<Video 1> = ${st.source.filename} — ATTACHED as control video and animation source (ref_video_0): timing, body movements, gestures, facial expressions, camera, and editing rhythm.`)
      if (videoVisionOn) {
        lines.push('You receive digest/frames of this video (scene, characters, motion, camera). Use them to understand animation transfer, but do NOT retell motion in prompt.')
      } else {
        lines.push('Frames/digest not attached: assistant video vision is off. Do not guess contents; in prompt only reference <Video 1> as motion source.')
      }
    } else {
      lines.push(`<Video 1> = ${st.source.filename} — ATTACHED as control video. This is official video reference: IT IS in references.`)
      lines.push('You do not see FRAMES of this video (it is video, not image) — but it IS ATTACHED and ACCOUNTED FOR during generation. Motion/camera NOT described in words (control sets them), but <Video 1> MUST be mentioned in detailed_description.')
    }
  } else {
    lines.push('Control video is NOT selected yet — generation cannot start without it; prompt user to select on "ControlNet" tab.')
  }
  if (st.refImages.length) {
    lines.push('Reference images (you receive their visual description / see attached file):')
    st.refImages.forEach((r, i) => {
      lines.push(`  <Picture ${i + 1}> = ${r.name}`)
    })
  } else {
    lines.push('NO reference images → tags <Picture N>, <Subject N> are FORBIDDEN.')
  }
  lines.push('')
  lines.push(`Control type: ${st.params.controlType}. Duration: ~${st.params.duration} s.`)

  // ── Strict mode rules ──
  // (fix 717) Compressed: 7 points → 5, "HONESTY" and "INDEPENDENCE OF
  // CHATS" blocks merged with "STRICT RULES" (was ~1.3k tokens).
  // Direct — separate branch: not "motion map", but animation transfer.
  const rulesBlock = direct
    ? '\n=== CONTROLNET MODE RULES (DIRECT: ANIMATION TRANSFER) ===\n' +
      '1) ⚠️ <Video 1> — source of animation: body movements, gestures, facial expressions, timing, camera, and editing rhythm. In detailed_description MANDATORILY state in one phrase: "The motion, timing, gestures and camera movement follow <Video 1>". Other tags <Video N> FORBIDDEN.\n' +
      '2) Use digest/frames of <Video 1> only to understand transfer. DO NOT detail motion and camera frame by frame — control already sets animation (this overrides general base spec requirement to describe camera). If no digest — do not invent video content.\n' +
      '3) Create new appearance from query and <Picture N>: by default DO NOT copy face, appearance, clothing, or location from <Video 1>. Preserving them allowed only on EXPLICIT request. Each image with its own <Picture N> tag (create <Subject N>).\n' +
      `4) One CONTINUOUS scene (~${st.params.duration} s), English, ONE fence (FORMAT B), WITHOUT clip: N.\n` +
      '5) SOUND: if speech/dialogue/voiceover NOT requested — overall_soundscape: ambient/silence, non_diegetic_music: N/A. Do NOT add voice, lines, narration, or music by default.\n' +
      '6) HONESTY/BOUNDARIES: reference list above is sole source of truth; digest <Video 1> only if attached; do not invent details. Chat attachments are not references (no <Picture N>); you do not see other chats.'
    : '\n=== CONTROLNET MODE RULES ===\n' +
      '1) ⚠️ MANDATORY: <Video 1> is control video, official video reference. MENTION it in detailed_description ("The camera and subject motion follow <Video 1>"). Other tags <Video N> FORBIDDEN.\n' +
      '2) Motion/camera/poses DO NOT describe in words — control sets them. Text about motion INTERFERES with control.\n' +
      '3) Prompt describes ONLY: scene/location, appearance, clothing, style, lighting, atmosphere, sound. Each attached image with its own <Picture N> tag (create <Subject N>, link to <Picture N>).\n' +
      `4) One CONTINUOUS scene (~${st.params.duration} s), English prompt, ONE fence (FORMAT B). WITHOUT clip: N.\n` +
      '5) SOUND: if speech/dialogue/voiceover NOT requested — overall_soundscape: ambient/silence, non_diegetic_music: N/A. Do NOT add voice, lines, narration, or music by default.\n' +
      '6) HONESTY: current reference list above is sole source of truth. You do NOT see frames of <Video 1> (it is video, not image) — do not guess or describe its content, but it MUST be mentioned in prompt. Details not seen in images do not invent — say "cannot see".\n' +
      '7) This chat is independent: you do not see other chats. Source, parameters, and references above are CURRENT state of "ControlNet" tab. Chat attachments are only for description, NOT references: NEVER tag them <Picture N>.'

  return `${H3_SPEC_B}

=== SESSION CONTEXT (CONTROLNET) ===
${lines.join('\n')}
${rulesBlock}

Prompt — ONE \`\`\`text fence (FORMAT B), in English. Short note before fence — OK.
${direct ? 'Main binding: new appearance from query and <Picture N>; animation, timing, and camera from <Video 1>.' : 'Before prompt reread CURRENT list of references above.'}`
}
/** Ensure roles alternate: merge consecutive same-role, and ensure first is user.
 *  Merge, NOT replace: two consecutive user messages appear when previous
 *  request failed without answer (409/503/network) — replacement lost first question
 *  along with its context; model saw only the last one. */
function sanitizeRoles(msgs: AssistantChatMessage[]): AssistantChatMessage[] {
  const out: AssistantChatMessage[] = []
  for (const m of msgs) {
    if (out.length && out[out.length - 1].role === m.role) {
      const prev = out[out.length - 1]
      const merged = typeof prev.content === 'string' && typeof m.content === 'string'
        ? `${prev.content}\n\n${m.content}`
        : m.content
      out[out.length - 1] = { ...prev, content: merged }
    } else {
      out.push(m)
    }
  }
  // LLM requires the first non-system message to be 'user'
  while (out.length && out[0].role !== 'user') out.shift()
  return out
}

/**
 * A one-character reply like "1" is ambiguous to a small local model,
 * especially when the system prompt is full of reference rules. If the
 * previous assistant message contains a numbered list, make the selection
 * explicit for this request only (the stored chat stays unchanged).
 */
function numberSelectionHint(msgs: AssistantChatMessage[], n: number): string | null {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m.role !== 'assistant' || typeof m.content !== 'string') continue
    const named = new RegExp(
      `(?:^|\\n)\\s*(?:#{1,6}\\s*)?(?:Idea|Option)\\s*${n}\\b`,
      'i',
    )
    const numbered = new RegExp(
      `(?:^|\\n)\\s*\\*{0,2}${n}[.)]\\s+`,
    )
    if (named.test(m.content) || numbered.test(m.content)) {
      return `[User selection: option ${n} from your previous list. Output the completed prompt specifically for it. Do not repeat the list of ideas and do not retell references.]`
    }
    // Only the immediately preceding assistant turn is relevant.
    return null
  }
  return null
}

/**
 * Build the multimodal reference list for the LLM: images, videos AND audios.
 * (fix 168) Source — LIVE state of "Generate" tab (gen-store):
 * model sees generation context automatically, without manual actions —
 * including refs added by user in the middle of a dialog.
 * - images  → sharp-resized 512px JPEG  ({"type":"image"})
 * - videos  → whole downscaled video + its audio track when includeAudio
 * - audios  → 16 kHz mono WAV           ({"type":"audio"})
 * The server prepares the media (see src/lib/llm-media.ts).
 * (fix 427) In extend chat, source — extendImageRefs of "Extend" tab.
 * (fix 502) In controlnet chat — refImages of "ControlNet" tab
 * (controlnet-target-store; paths — filenames in ComfyUI input/).
 */
/**
 * (fix 717) Reference limits — matching H3 model itself and UI
 * (generate-view.tsx: FALLBACK_REF_LIMITS = image 9 / video 3 / audio 3,
 * total 15).
 *
 * Previously the reference list was UNCONSTRAINED, while server at /api/llm/chat
 * truncated it to 9 positions IN ORDER. Because of this, system prompt
 * listed <Picture 10>, <Video 2>... which were never sent on the wire: model
 * wrote tags of nonexistent references in prompt and described images
 * it COULD NOT SEE. Now the limit is applied HERE, by type, and prompt
 * numbers exactly what goes onto the wire.
 */
const REF_LIMITS = { image: 9, video: 3, audio: 3, total: 15 } as const

function getReferences(chatMode: AssistantChatMode = 'generate'): Array<{
  path: string
  trigger: string
  intent?: string
  kind: 'image' | 'video' | 'audio'
  includeAudio?: boolean
}> {
  const v = useGenStore.getState().video
  // (fix 502) controlnet chat: references — images of "ControlNet" tab:
  // <Picture N> numbering in controlnet chat system prompt follows them.
  //
  // (direct) In "Direct" mode, control video is passed to H3 as
  // ref_video_0 and serves as the animation source. We add it to refs so
  // server builds digest from frames and caches it by file content.
  // For depth/canny/pose keep former behavior: assistant sees only
  // images, while motion is guided by map.
  if (chatMode === 'controlnet') {
    const cn = useControlNetTarget.getState()
    const out: Array<{
      path: string
      trigger: string
      intent?: string
      kind: 'image' | 'video' | 'audio'
      includeAudio?: boolean
    }> = []
    if (cn.params.controlType === 'direct' && cn.source) {
      const sourcePath = cn.source.inputSource
        || (cn.source.subfolder ? `${cn.source.subfolder}/${cn.source.filename}` : cn.source.filename)
      out.push({
        path: sourcePath,
        trigger: 'Video 1',
        // inputSource — file from disk, already in input/staging; otherwise it's
        // a gallery output file, and resolver must search for it in output.
        intent: cn.source.inputSource ? 'control_source_input' : 'control_source',
        kind: 'video',
        includeAudio: false,
      })
    }
    for (const [i, r] of cn.refImages.entries()) {
      out.push({
        path: r.path,
        trigger: `Picture ${i + 1}`,
        kind: 'image',
      })
    }
    return out
  }
  // (fix 427) extend chat: references — images of "Extend" tab
  // (extendImageRefs), NOT v.refs of "Generate" tab: numbering <Picture N>
  // in system prompt of extend chat follows them, and they are what must be attached.
  if (chatMode === 'extend') {
    return v.extendImageRefs.map((r, i) => ({
      path: r.path,
      trigger: `Picture ${i + 1}`,
      intent: r.imageIntent || 'identity',
      kind: 'image' as const,
    }))
  }
  // (fix 150) In t2v/flf only audio is passed from refs (images/videos not used by node).
  // (fix 151) In flf: frames (startFrame/endFrame) attached as image refs,
  // so LLM SEES them and describes in words (forbidden <Picture N> — see system prompt).
  const refs = v.mode === 'ref' ? v.refs : v.refs.filter((r) => r.kind === 'audio')
  const out: Array<{
    path: string
    trigger: string
    intent?: string
    kind: 'image' | 'video' | 'audio'
    includeAudio?: boolean
  }> = []
  const counters: Record<'image' | 'video' | 'audio', number> = { image: 0, video: 0, audio: 0 }

  // (fix 151) In flf mode, frames come FIRST (they are primary), then audio.
  // LLM must see them and describe in words; <Picture N> is forbidden in system prompt.
  if (v.mode === 'flf') {
    // (fix 717) Frames take slots <Picture 1..2> — count them in
    // image limit, otherwise total image count could exceed 9.
    if (v.startFrame?.path && counters.image < REF_LIMITS.image) {
      out.push({ path: v.startFrame.path, trigger: 'First frame', intent: 'first_frame', kind: 'image' })
      counters.image++
    }
    if (v.endFrame?.path && counters.image < REF_LIMITS.image) {
      out.push({ path: v.endFrame.path, trigger: 'Last frame', intent: 'last_frame', kind: 'image' })
      counters.image++
    }
  }

  for (const r of refs) {
    // (fix 717) Limit by type + overall ceiling. Priority: images
    // (model sees them and they carry appearance), then videos, then audios.
    if (out.length >= REF_LIMITS.total) break
    if (r.kind === 'image') {
      if (counters.image >= REF_LIMITS.image) continue
      out.push({ path: r.path, trigger: `Picture ${++counters.image}`, intent: r.imageIntent || 'identity', kind: 'image' })
    } else if (r.kind === 'video') {
      if (counters.video >= REF_LIMITS.video) continue
      out.push({ path: r.path, trigger: `Video ${++counters.video}`, kind: 'video', includeAudio: r.includeAudio })
    } else if (r.kind === 'audio') {
      if (counters.audio >= REF_LIMITS.audio) continue
      out.push({ path: r.path, trigger: `Audio ${++counters.audio}`, kind: 'audio' })
    }
  }
  return out
}

/* ── Live stream state (subscribed by mounted views) ────────────────── */

interface StreamState {
  /** Chat id of the in-flight reply, or null when idle. */
  chatId: string | null
  /** Accumulated assistant text of the in-flight reply. */
  text: string
  /**
   * (fix 717) Stream INSTANCE identifier (monotonic counter).
   *
   * Previously "is this still my stream?" was checked by chatId. But after "Stop",
   * in the same chat a NEW stream could start, and the finally of the OLD stream (which runs
   * asynchronously on next tick) saw chatId === chatId and reset the
   * state of the ACTIVE new stream: text of new response disappeared, while
   * isStreamActive() became false when running === true → next
   * message was silently lost. Instance identifier eliminates race condition.
   */
  runId: number
}

export const useAssistantStream = create<StreamState>(() => ({
  chatId: null,
  text: '',
  runId: 0,
}))

let activeAbort: AbortController | null = null
let running = false
/** (fix 717) Stream instance counter. */
let runCounter = 0
/**
 * (fix 717) Current LLM request id — passed in body of /chat and in
 * /abort so cancellation targets specifically this generation (without targeting,
 * "Stop" could abort the NEXT request).
 */
let activeRequestId: string | null = null

/** True while a reply is in flight (for guards from non-reactive code). */
export function isStreamActive(): boolean {
  return useAssistantStream.getState().chatId !== null
}

/**
 * Send history[] to the LLM, stream the reply, commit to the store.
 * Module-level: keeps running after AssistantView unmounts.
 * No-op while another reply is already in flight (one at a time).
 */
/** (fix 86; updated by fix 108) Chat message attachment:
 *  image or video. (fix 108) Stored in isolated directory
 *  data/chat-attachments/ — file exists ONLY in chat and is used
 *  ONLY for LLM analysis/description. NOT mixed with generation references
 *  (<Picture N>/<Video N>), does not reside in ComfyUI/input/, does not appear in gallery,
 *  upscale, or "clean input". */
export interface ChatAttachment {
  /** Filename in attachment storage (data/chat-attachments/, or legacy ComfyUI/input/). */
  path: string
  /** Original filename (for display). */
  name: string
  /** Media type. */
  kind: 'image' | 'video'
  /** (fix 108) Legacy attachment (fixes 86–87) stored in ComfyUI/input/ —
   *  server reads it from input/, but it ALSO is not a generation ref. */
  legacyComfy?: boolean
}

export function runAssistantCompletion(
  chatId: string,
  history: AssistantChatMessage[],
  attachments?: ChatAttachment[],
): void {
  if (running) return
  running = true
  const ac = new AbortController()
  activeAbort = ac
  // (fix 717) Stream instance identifier — finally uses it to know
  // "is this still my stream" (see StreamState.runId).
  const runId = ++runCounter
  // (fix 717) Request address for /abort.
  const requestId = `r${runId}_${Date.now().toString(36)}`
  activeRequestId = requestId
  useAssistantStream.setState({ chatId, text: '', runId })

  void (async () => {
    let final = ''
    // false = server responded with error to POST itself (409/503/...): show
    // THIS error; true = stream started and broke midway
    let streamStarted = false
    // (client idle-watchdog) declared BEFORE try: catch reads them even if
    // throw happened before stream opened.
    let idleTimedOut = false
    // (fix 717) Response hit max_tokens limit (finish_reason='length'):
    // response is incomplete, but not an "error" — mark in text.
    let truncatedByLimit = false
    // (fix 717) Response aborted by user ("Stop").
    let abortedByUser = false
    // (fix 717) Request error text — will enter chat as a synthetic
    // assistant turn (instead of "orphaned" user message).
    let errorMessage: string | null = null
    let idleTimer: ReturnType<typeof setTimeout> | null = null
    // (fix 267) Timeout waiting for response HEADERS: fetch up to res.headers
    // has neither timeout nor abort — hung POST (VRAM arbiter waiting for minutes)
    // left running=true forever and blocked chat. Arm BEFORE first
    // fetch, clear on receiving headers; user stop (same
    // ac.signal) interrupts waiting silently, timeout — with error.
    // 10 minutes: first turn may first build reference digests (multiple
    // isolated LLM calls) — 5 minutes was too close to timeout on
    // a set of 9 images + 3 videos.
    let headerTimedOut = false
    let headerTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      headerTimedOut = true
      ac.abort()
    }, 10 * 60_000)
    try {
      // (fix 427) CHAT mode (generate/extend/controlnet (fix 502)) —
      // from chats store by chatId:
      // system prompt and set of attached references depend on it
      // (contexts of "Generate" / "Extend" / "ControlNet" tabs do not mix).
      const chatMode: AssistantChatMode =
        useAssistantChats.getState().chats.find((c) => c.id === chatId)?.mode ?? 'generate'
      // (fix 168) References to attach — from LIVE gen-store: model sees
      // generation context automatically, including refs added mid-dialog.
      // No manual bindings.
      const refs = getReferences(chatMode)
      // (fix 108) Chat attachments — SEPARATE from generation refs: they exist
      // ONLY in chat and are needed ONLY for LLM description/analysis. In references
      // (<Picture N>/<Video N>) they DO NOT go — server receives them in separate
      // chatAttachments field, attaches as "Chat N", and forbids tagging
      // in prompt (previously they were pushed into refs → LLM wrote <Picture N> →
      // MiniMax pulled file from input/ into generation).
      const chatAttachments = (() => {
        // (fix 717) Chat attachments are reattached on EVERY turn.
        // Previously attachments came only for the turn where the file was
        // uploaded, and on next message model COULD NOT SEE the image —
        // even though its question ("what is in photo?") remained in history. Rule
        // "do not invent what you do not see" drove model to say "cannot see"
        // or invent. Now we take attachments of recent turns from message history
        // (where they are saved together with text).
        const explicit = attachments?.length
          ? attachments.map((a) => ({
              path: a.path,
              name: a.name,
              kind: a.kind,
              legacyComfy: a.legacyComfy === true,
            }))
          : []
        if (explicit.length) return explicit
        const fromHistory: Array<{ path: string; name: string; kind: 'image' | 'video'; legacyComfy?: boolean }> = []
        for (const m of history) {
          if (m.role !== 'user' || !m.attachment) continue
          fromHistory.push({
            path: m.attachment.path,
            name: m.attachment.name,
            kind: m.attachment.kind,
            legacyComfy: m.attachment.src !== 'chat',
          })
        }
        // No more than 3 (attachment limit per turn) — otherwise prefill balloons.
        return fromHistory.slice(-3)
      })()
      // (fix 53) Fresh "video vision" value from config — system
      // prompt must match what server actually attaches.
      // Lightweight local GET; on error stay with default (off).
      let videoVisionOn = true
      try {
        const cfgRes = await fetch('/api/config', { signal: ac.signal })
        if (cfgRes.ok) {
          const cfg = await cfgRes.json()
          videoVisionOn = cfg.llm_video_vision !== false
        }
      } catch { /* ignore — default ON (compressed digest) */ }
      // The stored history is untouched; this copy may get a one-line
      // clarification for numeric selections ("1", "2", ...).
      const apiHistory = sanitizeRoles(history.slice(-HISTORY_LIMIT))
      const lastApiMsg = apiHistory[apiHistory.length - 1]
      if (lastApiMsg && lastApiMsg.role === 'user' && typeof lastApiMsg.content === 'string') {
        const selection = /^\s*([1-9]|1[0-9]|2[0-5])\s*$/.exec(lastApiMsg.content)
        if (selection) {
          const hint = numberSelectionHint(apiHistory.slice(0, -1), Number(selection[1]))
          if (hint) {
            apiHistory[apiHistory.length - 1] = {
              ...lastApiMsg,
              content: `${lastApiMsg.content.trim()}\n\n${hint}`,
            }
          }
        }
      }
      const res = await fetch('/api/llm/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // (fix 717) request_id — abort address: /abort with this id
          // stops specifically this generation.
          request_id: requestId,
          messages: [
            // (fix 168) System prompt is built from LIVE state of
            // "Generate" tab (mode, refs, frames, duration) — model
            // sees generation context itself, without manual actions. Prompt
            // draft is NOT included here: it was a channel of topic leakage between chats;
            // if needed user quotes it in the message
            // ("Improve my prompt" button does this automatically).
            // (fix 427) For extend chat — extension system prompt
            // (clips, extend refs, source metadata); await: reads metadata.
            { role: 'system', content: await buildSystemMessage(videoVisionOn, chatMode, ac.signal) },
            // Replay the (capped) chat history so the model "remembers"
            ...apiHistory,
          ],
          // Send image references so the server can inject them as vision
          ...(refs.length > 0 ? { references: refs } : {}),
          // (fix 108) Chat attachments — separate field (NOT references):
          // server reads them from data/chat-attachments/ (or legacy input/)
          // and attaches to LLM as "Chat N" forbidding <Picture N> tags.
          ...(chatAttachments ? { chatAttachments } : {}),
        }),
        signal: ac.signal,
      })
      // (fix 267) Headers received — clear header timeout; from here on
      // stream body idle-watchdog guards.
      if (headerTimer) {
        clearTimeout(headerTimer)
        headerTimer = null
      }
      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => '')
        let msg = `HTTP ${res.status}`
        try {
          msg = (JSON.parse(errText) as { error?: string }).error || msg
        } catch {
          /* keep */
        }
        throw new Error(msg)
      }
      const reader = res.body.getReader()
      streamStarted = true
      const decoder = new TextDecoder()
      let buf = ''
      // (client idle-watchdog) Half-open connection (PC sleep/hibernation,
      // dead proxy) never resolves reader.read() — stream hung
      // forever, chat blocked until page reload. Mirror server
      // watchdog: 5 min without a single chunk = forced abort with toast.
      idleTimer = setTimeout(() => {
        idleTimedOut = true
        ac.abort()
      }, 5 * 60_000)
      const armIdle = () => {
        if (idleTimer) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => {
          idleTimedOut = true
          ac.abort()
        }, 5 * 60_000)
      }
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          armIdle()
          buf += decoder.decode(value, { stream: true })
        const events = buf.split('\n\n')
        buf = events.pop() ?? ''
        for (const ev of events) {
          const line = ev.split('\n').find((l) => l.startsWith('data: '))
          if (!line) continue
          // JSON.parse — in SEPARATE try: previously "not JSON in message" filter
          // swallowed payload.error too if server error text mentioned JSON
          // (e.g. llama-cpp exceptions) — stream "completed" as successful
          // with truncated response.
          // (fix 717) Server distinguishes "reached end" vs "aborted":
          // final frame carries finish_reason and aborted flag (see
          // tools/llm_server.py). Previously client IGNORED these fields, and
          // aborted response committed to chat as COMPLETE — user saw
          // finished prompt that did not actually exist.
          let payload: {
            delta?: string
            error?: string
            done?: boolean
            aborted?: boolean
            finish_reason?: string | null
          } | null = null
          try {
            payload = JSON.parse(line.slice(6))
          } catch {
            continue // broken/incomplete chunk — wait for next
          }
          if (!payload) continue
          if (payload.error) throw new Error(payload.error)
          if (payload.aborted) {
            throw new Error('Response aborted (stopped by user or server failure).')
          }
          if (payload.done && payload.finish_reason === 'length') {
            // Response hit max_tokens — not an "error", but not a complete
            // prompt either. Mark so user knows.
            truncatedByLimit = true
          }
          if (payload.delta) {
            final += payload.delta
            const s = useAssistantStream.getState()
            // (fix 717) Check stream INSTANCE, not chat: after "Stop"
            // in same chat a new stream could start, and old would write
            // its text into its tail.
            if (s.runId === runId) useAssistantStream.setState({ text: final })
          }
        }
        }
      } finally {
        if (idleTimer) clearTimeout(idleTimer)
      }
    } catch (err) {
      if (headerTimer) {
        clearTimeout(headerTimer)
        headerTimer = null
      }
      // (fix 717) AbortError WITHOUT header/idle timeouts = user
      // pressed "Stop" (see stopAssistantStream). Mark response as aborted
      // so snippet is not committed as complete prompt.
      if ((err as Error).name === 'AbortError' && !idleTimedOut && !headerTimedOut) {
        abortedByUser = true
      }
      if ((err as Error).name !== 'AbortError' || idleTimedOut || headerTimedOut) {
        // Error BEFORE stream start = structured server response
        // (409 "generation in progress", 503 "did not free VRAM", ...) — show
        // it as is, WITHOUT masking "friendly" substitutions.
        // Interruption of already started response is a separate case.
        let msg = err instanceof Error ? err.message : String(err)
        if (headerTimedOut) {
          // (fix 267) Server accepted request and did not return headers for 5 min
          // (hung VRAM arbitration / server) — free chat and server.
          msg = 'Assistant did not respond within 5 minutes (server busy or hung) — request cancelled. Please send message again.'
        } else if (idleTimedOut) {
          msg = 'Assistant response hung (no data for 5 min) — connection aborted. Please send message again.'
        } else if (streamStarted) {
          try {
            const s = (await fetch('/api/llm/status').then((r) => r.json())) as LlmStatusResp
            if (s && !s.running) {
              msg = 'Connection to assistant lost (server stopped). Please send message again — assistant will start anew.'
            }
          } catch {
            /* status unavailable — show original error */
          }
        }
        toast.error('Assistant', { description: msg })
        if (idleTimedOut || headerTimedOut) void fetch('/api/llm/abort', { method: 'POST' }).catch(() => {})
        // (fix 717) Record error IN CHAT, not just via toast: toast
        // disappears after a few seconds, and user message remained
        // unanswered forever. On next turn sanitizeRoles merged two
        // user messages, mixing unresolved question with next.
        // Synthetic assistant turn makes failure visible and durable.
        errorMessage = msg
      }
    } finally {
      // Commit the finished assistant reply to the persisted chat. This runs
      // even when the view is UNMOUNTED — exactly what makes the answer
      // survive tab switches.
      //
      // (fix 717) Aborted response is NOT committed as complete: previously
      // interruption (abort, socket break, finish_reason='length') silently
      // saved half-prompt to chat, and user saw "ready" response
      // that does not exist. Now an explicit marker is added to text.
      if (final.trim()) {
        const marker = abortedByUser
          ? '\n\n_[Response aborted — partial snippet shown.]_'
          : truncatedByLimit
            ? '\n\n_[Response truncated by token limit — partial snippet shown.]_'
            : errorMessage
              ? '\n\n_[Connection interrupted — partial snippet shown.]_'
              : ''
        useAssistantChats.getState().appendMessage(chatId, {
          role: 'assistant',
          content: final + marker,
        })
      } else if (errorMessage) {
        // (fix 717) No response at all — leave explicit assistant turn
        // in chat so user message is not orphaned.
        useAssistantChats.getState().appendMessage(chatId, {
          role: 'assistant',
          content: `_[Error: ${errorMessage}]_`,
        })
      }
      // (fix 268) Reset running/activeAbort only if stream is still
      // OURS: stopAssistantStream now resets state synchronously, and a new
      // stream could start BEFORE our finally — without guard it would clear
      // someone else's running and someone else's AbortController.
      if (activeAbort === ac) {
        running = false
        activeAbort = null
      }
      // (fix 717) Reset live state of ONLY own instance.
      // Checking by chatId was insufficient: after "Stop" in this same chat
      // a new stream could start, and finally of old would clear it (text of new
      // response disappeared, while running remained true → next message
      // silently lost). Check runId.
      if (useAssistantStream.getState().runId === runId) {
        useAssistantStream.setState({ chatId: null, text: '', runId })
      }
    }
  })()
}

/** Stop the in-flight reply (user pressed "Stop"). */
export function stopAssistantStream(): void {
  // (fix 268) Synchronous state reset BEFORE abort: previously running=false and
  // chatId reset occurred only in finally of async read loop, and
  // send() called in this window passed guard isStreamActive(), but was silently
  // discarded (text was lost). Now retry immediately sees
  // free engine. Repeat call (activeAbort already null) is a no-op:
  // we do not send /api/llm/abort twice.
  const ac = activeAbort
  if (!ac) return
  activeAbort = null
  running = false
  const requestId = activeRequestId
  activeRequestId = null
  // (fix 717) Reset instance identifier so finally of old stream
  // does not consider its runId active and clear new stream in this chat.
  useAssistantStream.setState({ chatId: null, text: '', runId: 0 })
  ac.abort()
  // (fix 717) /api/llm/abort — WITH request_id and awaiting response: previously it
  // was fire-and-forget and could arrive AFTER next /chat, aborting
  // the NEW generation. Now abortion is targeted, and client waits for its completion
  // before returning ("Stop" button cancels only current request).
  const abortUrl = requestId
    ? `/api/llm/abort?request_id=${encodeURIComponent(requestId)}`
    : '/api/llm/abort'
  void fetch(abortUrl, { method: 'POST' }).catch(() => {})
}

/**
 * Stop the in-flight reply ONLY if it belongs to `chatId` (fix 32).
 *
 * Used when deleting the chat that owns the stream: the engine's `finally`
 * runs its `appendMessage` AFTER the chat is already gone, so the partial
 * reply is dropped (the store map finds no such chat) — exactly what we want
 * — and the model is freed via the abort POST. No-op when the stream is
 * owned by another chat or when idle.
 */
export function stopStreamForChat(chatId: string): void {
  if (useAssistantStream.getState().chatId !== chatId) return
  stopAssistantStream()
}
