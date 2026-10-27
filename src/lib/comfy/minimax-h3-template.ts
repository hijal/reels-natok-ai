import { vhsEncodeInputs, type VideoFormatSettings } from '../video-format' // (fix 386)
/**
 * MiniMax H3 Reference-to-Video — Two-Pass Latent Upscaler workflow.
 *
 * Architecture:
 *   Pass 1: Low-res generation (0.2 MP, 6 total steps → SplitSigmas → 6 effective, «6/6»)
 *   Upscale: MinimaxH3LatentUpscaler3D to target resolution (default 0.7 MP)
 *   Pass 2: High-res refinement (3 steps via ManualSigmas)
 *   Decode: Separate VAEDecode (video) + VAEDecodeAudio (audio)
 *
 * Model chain: UNET → [LowVRAM] → [ChunkFF] → [custom LoRAs, incl. turbo] → SigmaShift → AttentionBackend → Preview
 * (LowVRAM Attention and Chunk FeedForward are optional, default ON;
 *  SageAttn and SLA patches were removed in favour of --use-ck-attention)
 *
 * Defaults (overridable via MiniMaxH3Params):
 *   - LoRA: customLoras from loras.json; built-in turbo LoRA enabled by default
 *   - Pass 1: sampler + scheduler selectable (default euler / simple, fixes 67, 70)
 *     BasicScheduler (steps) → SplitSigmas
 *   - Pass 2: sampler selectable (default euler, fixes 68-69) / ManualSigmas
 *   - Latent Upscaler: 'target dimensions' (fix 124), enable_chunking: true (fix 68)
 *   - Pass 2: ManualSigmas (0.9035, 0.6316, 0.3158, 0.0000)
 *   - Low-res: 0.2 MP (default), range 0.2-2 MP (fix 70)
 *   - Optimization nodes SigmaShift + Attention
 *
 *   (fix 124) Resolution: generation multiple of 32, slightly above nominal
 *   (16:9 1080p → 1920x1088), cropped at end exactly to nominal (1920x1080).
 */

/** (fixes 69–70) Valid k-samplers for both passes — subset of
 *  KSAMPLER_NAMES in installed ComfyUI build (comfy/samplers.py).
 *  Default: euler. */
export const VALID_KSAMPLERS = [
  'er_sde',
  'euler',
  'dpmpp_2m',
  'dpmpp_3m_sde',
  'heun',
  'lcm',
  'res_multistep',
] as const

export const DEFAULT_PASS2_SAMPLER = 'euler'
export const DEFAULT_PASS1_SAMPLER = 'euler'
/** (fix 70) Valid pass 1 schedulers — SCHEDULER_HANDLERS
 *  in installed ComfyUI build (comfy/samplers.py). Default: simple. */
export const PASS1_SCHEDULERS = [
  'sgm_uniform',
  'simple',
  'karras',
  'exponential',
  'ddim_uniform',
  'normal',
  'beta',
  'linear_quadratic',
  'kl_optimal',
] as const

export const DEFAULT_PASS1_SCHEDULER = 'simple'

/* ── (fix 399) Veda Sparse Attention — node settings ── */

/**
 * Sparsity of type '90%' (or integer tiles) → string `${n}%`, clamped 0..95.
 * Unreadable value → `${def}%`.
 */
export function clampVedaSparsity(v: unknown, def: number): string {
  let n: number
  if (typeof v === 'number') n = v
  else if (typeof v === 'string') n = Number.parseFloat(v.replace('%', '').trim())
  else n = NaN
  if (!Number.isFinite(n)) n = def
  n = Math.min(95, Math.max(0, Math.round(n)))
  return `${n}%`
}

/**
 * List '0, 1, 47-49' (0-based blocks/steps): digits, commas, hyphens, spaces.
 * Anything else → '' (node uses its default).
 */
export function sanitizeVedaIndexList(v: unknown): string {
  if (typeof v !== 'string') return ''
  const t = v.trim()
  return /^[\d\s,\-]*$/.test(t) ? t : ''
}

export interface MiniMaxH3Params {
  prompt: string
  /** Uploaded image filenames in ComfyUI input/ (max 9). */
  refImages: string[]
  /** (fix 146) Generation mode:
   *  • 'ref' — references (as before, default): refImages/refVideos/refAudios
   *    via MiniMaxH3ReferenceToVideo;
   *  • 't2v' — text only: MiniMaxH3ImageToVideo without frames;
   *  • 'flf' — first/last frame: MiniMaxH3ImageToVideo + firstFrame/lastFrame;
   *  • 'extend' — video extension: chain of clips via MiniMaxH3Extender
   *    (tritant) + MiniMaxH3MotionContextDiskFinalDecode.
   *  In t2v/flf audio references are fed via MiniMaxH3AddGuide chain
   *  (node itself has no audio inputs). */
  mode?: 'ref' | 't2v' | 'flf' | 'extend'
  /** (fix 161) extend: clips for extension. Each clip — prompt + duration + seed. */
  extendClips?: Array<{ prompt: string; duration: number; seed: number }>
  /** (fix 161) extend: ref file names for metadata ('Replay').
   *  For generation itself extendRefDescriptors is used. */
  extendRefs?: string[]
  /** (fix 161) extend: image ref descriptors uploaded to
   *  internal Extender node cache via /h3_extender/ref/upload.
   *  Each descriptor — {id: 64-hex, width, height, ...}. Up to 9. */
  extendRefDescriptors?: Array<Record<string, unknown> & { id: string }>
  /** extend: source video name in ComfyUI input/ — provided via
   *  LoadVideo → GetVideoComponents → ref_video_1 (IMAGE frame batch).
   *  Node uses it as reference video for extension. */
  extendSourceVideo?: string
  /** (fix 254) extend: actual frame count of source (ffprobe in
   *  route). Tail plan clamps to it: LatentCut truncates latent
   *  shorter than plan, and mask was calculated from plan → shift of preserved zone and
   *  'pure noise' at clip start. */
  extendSourceFrames?: number
  /** (fix 385, REVERTED by fix 417) extend: path to source LATENT.
   *  Extend latent pipeline (seed/head/combine from pristine latent)
   *  reverted based on test results (source replay in white zone of clip);
   *  extend is completely mp4-based again. Fields retained in interface for
   *  backward compatibility with old job metadata — NOT used by builder. */
  extendSourceLatent?: string
  /** (fix 385, REVERTED by fix 417) Not used, see extendSourceLatent. */
  extendSourceTokens?: number
  /** (fix 385, REVERTED by fix 417) Not used, see extendSourceLatent. */
  extendSourceAudioSteps?: number
  /** (fix 420) extend: path to source .latent (relative to output/) —
   *  NOT for generation (seed remains pixel-based, fix 409/419), only
   *  for POST-ASSEMBLY of combined latent AFTER samplers: final latent
   *  is saved as single file for lossless refine/upscale.
   *  No file — source is encoded in full once in the graph. */
  extendSourceLatentFile?: string
  /** extend: number of overlap frames between clips (24 fps). Default 48 (2 sec). */
  extendOverlapFrames?: number
  /** (fix 423) extend: two-pass mode — clips generated on low-res
   *  canvas (lowResMP), then each upscaled by LatentUpscaler3D to size
   *  of source and refined by pass-2 sampler (ManualSigmas sigmaVariant).
   *  Default false = single-pass scheme (fix 247). */
  extendTwoPass?: boolean
  /** (fix 146) flf: filename of first frame in ComfyUI input/. */
  firstFrame?: string
  /** (fix 146) flf: filename of last frame in ComfyUI input/ (optional). */
  lastFrame?: string
  /** (fix 152) flf: width of first frame in pixels (for aspect ratio without distortion). */
  firstFrameWidth?: number
  /** (fix 152) flf: height of first frame in pixels. */
  firstFrameHeight?: number
  /** Aspect ratio string for ResolutionSelector (e.g., "16:9", "21:9 (Ultrawide)"). */
  aspectRatio: string
  /** Duration in seconds */
  duration: number
  /** Seed (-1 = random) */
  seed: number
  /** Target megapixels for the latent upscaler output (default 0.7 ≈ 720p).
   *  (fix 124) Used only in free resolution mode —
   *  with given targetDimensions exact sizes take priority. */
  finalResolution?: number
  /** Pipeline: 'draft' — single pass on draft low-res canvas (fast exploration,
   *  upgrade via Refine tab); 'full' (default) — two passes
   *  (low-res → LatentUpscaler3D → Pass 2), as before. */
  pipeline?: 'draft' | 'full'
  /** Steps of single pass in 'draft' pipeline (default 4 — turbo reference,
   *  minimum 2). */
  draftSteps?: number
  /** (fix 124) Exact nominal (final) video dimensions, e.g.
   *  1920x1080 for 16:9 1080p. Set for quality presets: upscaler
   *  operates in 'target dimensions' mode (gen = ceil32(nominal)), result —
   *  centered crop to nominalW x nominalH. */
  targetDimensions?: { width: number; height: number }
  /** Low-res pass 1 resolution in MP (default 0.2, range 0.2-2, fix 70). */
  lowResMP?: number
  /** Pass 1 effective sampling steps (SplitSigmas split point, default 6, max 30). */
  firstSamplerSteps?: number
  /**
   * TOTAL steps in BasicScheduler schedule for pass 1.
   *
   * Number of schedule steps is set independently of split point — this
   * allows taking e.g. 6 sigmas from an 8-step schedule.
   *
   * undefined = same as split consumes (firstSteps) — '6 of 6'
   * by default. Previously firstSteps * 2 ('6 of 12').
   */
  firstSamplerTotalSteps?: number
  /**
   * (fix 719) Clip steps in extend mode. In Extend this is NOT a split point:
   * single BasicScheduler per clip (denoise = 1, no split).
   * Default is 4 — as in reference extend workflow.
   */
  extendClipSteps?: number
  /** Pass 2 sigma variant: '3step' | '4step' | '5step' | '6step' | '7step'. Default '3step'. */
  sigmaVariant?: string
  /** (fix 69) Pass 2 sampler (default 'euler'). Must be one of VALID_KSAMPLERS. */
  pass2Sampler?: string
  /** (fix 70) Pass 1 sampler (default 'euler'). Must be one of VALID_KSAMPLERS. */
  pass1Sampler?: string
  /** (fix 70) Pass 1 scheduler (default 'simple'). Must be one of PASS1_SCHEDULERS. */
  pass1Scheduler?: string
  /** @deprecated Turbo LoRA handled via customLoras; template ignores this field. */
  turboLoraStrength?: number
  /** @deprecated Turbo LoRA handled via customLoras; template ignores this field. */
  turboLoraName?: string
  /** @deprecated Turbo LoRA handled via customLoras; template ignores this field. */
  turboLoraEnabled?: boolean
  /** (fix 168) Sparse attention (Sol-Attn) — accelerates long sequences.
   *  Short sequences (< min_tokens) remain dense automatically. Default true. */
  sparseAttention?: boolean
  /** (fix 301) Veda Sparse Attention — trained predictor. Default false.
   *  If true, replaces Sol-Attn. */
  vedaAttention?: boolean
  /** (fix 399) Veda: generation sparsity, string 'N%' (50-95, default '90%'). */
  vedaGeneratedSparsity?: string
  /** (fix 399) Veda: reference sparsity, 'N%' (0-95, default '90%'; 0% = full attention). */
  vedaReferenceSparsity?: string
  /** (fix 399) Veda: 0-based DiT blocks with full attention ('0, 1, 47-49'; '' = all sparse). */
  vedaFullAttentionLayers?: string
  /** (fix 399) Veda: 0-based sampler steps with full attention ('0, 1'; '' = none). */
  vedaFullAttentionSteps?: string
  /** (fix 399) Veda: verbose log (default false). */
  vedaVerbose?: boolean
  /** (fix 168) Sol-Attn: sparsity threshold (0-4, default 1.3). */
  sparseTau?: number
  /** (fix 466) Sol-Attn: start_percent (default 0.2). */
  sparseStartPercent?: number
  /** (fix 466) Sol-Attn: end_percent (default 1.0). */
  sparseEndPercent?: number
  /** (fix 466) Sol-Attn: min_tokens (default 12288). */
  sparseMinTokens?: number
  /** (fix 466) Sol-Attn: extra_tokens (default 256). */
  sparseExtraTokens?: number
  /** Enable MiniMaxLowVRAMAttention (head-chunked attention, saves VRAM). Default true. */
  lowVramAttention?: boolean
  /** Enable MiniMaxChunkFeedForward (chunked FFN, saves VRAM on long sequences). Default true. */
  chunkFeedForward?: boolean
  /** ChunkFF: number of feed-forward chunks (default 2). */
  chunkFFChunks?: number
  /** ChunkFF: sequence length threshold above which chunking kicks in (default 4096). */
  chunkFFThreshold?: number

  /* ── Video references (max 3) ── */
  /** Video filenames in ComfyUI input/. Each produces IMAGE frames for ref_video_N. */
  refVideos?: Array<{ path: string; includeAudio?: boolean; /** (fix 493) flag 'compress to 480p' — handled by /api/comfy/generate route (replaces path with compressed copy), template does not see it. */ compress?: boolean }>
  /* ── Standalone audio references (max 3) ── */
  /** Audio filenames in ComfyUI input/. Each maps to ref_audio_N. */
  refAudios?: string[]
  /** ref mode: feed audio refs as Audio Guide (anchored at frame 0) instead of
   *  only as ref_audios. Enabled by 'keep original audio
   *  + guide by it'; server-side replaces final audio track. */
  audioGuide?: boolean
  /** Replace final audio track with original (after done). */
  keepOriginalAudio?: boolean
  /** (fix 326) Audio ref trims (parallel to refAudios): specified →
      MiniMaxStudioAudioTrim inserted between LoadAudio and consumer.
      Virtual trim (tensor), no file copies created. */
  refAudioTrims?: Array<{ start: number; end: number | null } | undefined>
  /** (fix 694) Audio ref volume (0-1, default 0.5): between AudioTrim and
      consumer MiniMaxStudioAudioGain is inserted. Virtual, no file copies. */
  refAudioVolumes?: Array<number | undefined>
  /* ── Custom LoRAs (chained after turbo LoRA) ── */
  /** Custom LoRAs to apply after the built-in turbo LoRA. */
  customLoras?: Array<{ name: string; strength: number }>
  /** Diffusion model filename (default: minimax_h3_fastvideo_vsa_datafree_1300step_4step_int8_convrot.safetensors). */
  diffusionModel?: string
  /** (fix 91) Output subfolder (gallery project folder; '' = default).
   *  Passed to filename_prefix of VHS_VideoCombine node as 'folder/Minimax_Studio'. */
  outputSubfolder?: string
  /** (fix 58) Reference image sizing mode (node input ref_image_size):
   *  'match' — shrink refs to the generation pixel area (default, faster);
   *  'max' — 2048px short edge for best identity fidelity (slower). */
  refImageSize?: 'match' | 'max'
  /** (fix 386) Video output format/quality ([video] in config.ini; server
   *  passes when building job, undefined = default h264/CRF 12). */
  videoFormat?: VideoFormatSettings
}

/** Node IDs for reference images (up to 9). */
const REF_IMAGE_NODE_IDS = ['101', '399', '401', '403', '405', '407', '409', '411', '413'] as const

/** Node IDs for reference videos (up to 3) — VHS_LoadVideo nodes. */
const REF_VIDEO_NODE_IDS = ['501', '502', '503'] as const

/** Node IDs for standalone audio references (up to 3) — LoadAudio nodes. */
const REF_AUDIO_NODE_IDS = ['510', '511', '512'] as const

/** (fix 146) flf: LoadImage nodes of first/last frame. */
const FIRST_FRAME_NODE_ID = '105'
const LAST_FRAME_NODE_ID = '107'

/** (fix 146) t2v/flf: MiniMaxH3AddGuide chain for audio references (up to 3). */
const AUDIO_GUIDE_NODE_IDS = ['46:50', '46:51', '46:52'] as const

/**
 * Parse an aspect-ratio string "A:B" (decimals allowed, e.g. "2.35:1",
 * decorations like "(Ultrawide)" ignored) → [rw, rh].
 */
function parseAspect(s: string): [number, number] {
  const m = s.match(/^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)/)
  if (!m) return [16, 9]
  return [parseFloat(m[1]), parseFloat(m[2])]
}

/**
 * EXACT math of ComfyUI's ResolutionSelector node (comfy_extras/
 * nodes_resolution.py): megapixels are BINARY (MP × 1024 × 1024), results
 * aligned to `multiple`. Doing it here (instead of wiring the node) allows
 * ANY aspect ratio — including "2.35:1", which the node's combo does not
 * offer (it silently collapsed to 21:9 before).
 */
export function selectResolution(
  aspect: string,
  megapixels: number,
  multiple = 32,
): { w: number; h: number } {
  const [rw, rh] = parseAspect(aspect)
  const total = megapixels * 1024 * 1024
  const scale = Math.sqrt(total / (rw * rh))
  const w = Math.round((rw * scale) / multiple) * multiple
  const h = Math.round((rh * scale) / multiple) * multiple
  return { w: Math.max(multiple, w), h: Math.max(multiple, h) }
}

/* ─── (fix 124) Exact aspect ratios + EXACT final resolution ───
 *
 * Logic per user request (fix 124): first — generation resolution,
 * multiple of 32 and slightly above nominal; then generation; at the end — exact
 * fitting to selected aspect ratio + quality:
 *   1) nominal = EXACT selected aspect ratio + quality
 *      (16:9 + 1080p → 1920x1080; short side = number 'p');
 *   2) gen-resolution = nominal, raised on each axis to multiple of 32
 *      (1920x1080 → 1920x1088) — anti-banding/VAE preserved;
 *   3) upscaler runs in 'target dimensions' mode — outputs exactly
 *      genW x genH regardless of pass 1 aspect ratio (megapixels mode kept
 *      pass 1 aspect ratio and rounded axes independently — so 16:9
 *      yielded 1952x1098, etc.);
 *   4) centered crop ImageCrop genW x genH → nominal
 *      (1920x1088 → 1920x1080). Result: video EXACTLY 16:9 1080p.
 *
 * Free resolution (MP) uses second path (finalDimsFromMegapixels):
 * generation — by binary node MP (MP*1024*1024), result — maximum
 * inscribed rectangle with exact aspect ratio (even dimensions, yuv420p).
 *
 * computeFinalDimensions / finalDimsFromMegapixels — SINGLE source
 * of truth: workflow (target dimensions + ImageCrop), metadata
 * (pending-meta, use-video-gen) and UI badges — consistent everywhere.
 */

function gcd(a: number, b: number): number {
  a = Math.abs(a); b = Math.abs(b)
  while (b) { const t = a % b; a = b; b = t }
  return a || 1
}

/** Converts fractional ratio ("2.35:1") to irreducible integer
 *  pair (47:20) — required for exact crop calculation. (fix 121) */
export function aspectToInts(aspect: string): [number, number] {
  const [rw, rh] = parseAspect(aspect)
  const dec = (v: number) => {
    const s = String(v)
    const i = s.indexOf('.')
    return i < 0 ? 0 : Math.min(6, s.length - i - 1)
  }
  const f = Math.pow(10, Math.max(dec(rw), dec(rh)))
  const w = Math.round(rw * f)
  const h = Math.round(rh * f)
  const g = gcd(w, h)
  return [w / g, h / g]
}

/** Python round() = half-to-even (upscaler node written in Python). (fix 121) */
function pyRound(x: number): number {
  const f = Math.floor(x)
  const frac = x - f
  if (frac > 0.5) return f + 1
  if (frac < 0.5) return f
  return f % 2 === 0 ? f : f + 1
}

/** Round to even (yuv420p). (fix 124) */
function roundToEven(n: number): number {
  const r = Math.round(n)
  return r % 2 === 0 ? r : r + 1
}

/**
 * (fix 124) Nominal (final) dimensions: short side = shortSide,
 * long side = short side * (rw/rh), rounded to even (yuv420p).
 * 16:9 + 1080 → 1920x1080; 21:9 + 480 → 1120x480. Aspect ratio EXACT.
 */
export function nominalDimensions(aspect: string, shortSide: number): { w: number; h: number } {
  const [rw, rh] = parseAspect(aspect)
  const ratio = rw / rh
  if (ratio >= 1) {
    return { w: roundToEven(shortSide * ratio), h: roundToEven(shortSide) }
  }
  return { w: roundToEven(shortSide), h: roundToEven(shortSide / ratio) }
}

/**
 * (fix 157) flf-nominal: short side = given p (480/720/1080),
 * long side = p * (fw/fh) — EXACT aspect ratio of first frame (no quantization
 * to standard 16:9/9:16/...). Short side rounded to even
 * (yuv420p) so final is always multiple of 2.
 *
 * Unlike nominalDimensions() (which quantizes to nearest
 * standard aspect ratio), here aspect ratio comes directly from dimensions
 * — horizontal frame produces horizontal video, etc.
 */
export function flfNominalDimensions(
  shortSide: number,
  frameW: number,
  frameH: number,
): { w: number; h: number } {
  if (frameW >= frameH) {
    const h = roundToEven(shortSide)
    return { w: roundToEven(shortSide * (frameW / frameH)), h }
  }
  const w = roundToEven(shortSide)
  return { w, h: roundToEven(shortSide * (frameH / frameW)) }
}

export interface FinalDimensions {
  /** Dimensions actually output by upscaler (multiple of 32, >= nominal). */
  genW: number
  genH: number
  /** Center crop offset (0 — no crop needed). */
  cropX: number
  cropY: number
  /** Final video dimensions AFTER crop — exact nominal. */
  outW: number
  outH: number
}

/**
 * (fix 124) SINGLE source of truth for final video dimensions.
 * Generation = nominal rounded up to multiple of 32 on each axis (slightly above
 * nominal, multiple of 32 preserved); final = nominal via centered
 * crop (ImageCrop). Used by workflow (upscaler 'target dimensions' +
 * ImageCrop), metadata (pending-meta, use-video-gen) and UI badges —
 * consistent everywhere.
 */
export function computeFinalDimensions(
  nominalW: number,
  nominalH: number,
  multiple: number = 32,
): FinalDimensions {
  const genW = Math.max(multiple, Math.ceil(nominalW / multiple) * multiple)
  const genH = Math.max(multiple, Math.ceil(nominalH / multiple) * multiple)
  const outW = Math.min(Math.max(2, nominalW), genW)
  const outH = Math.min(Math.max(2, nominalH), genH)
  return {
    genW,
    genH,
    cropX: Math.floor((genW - outW) / 2),
    cropY: Math.floor((genH - outH) / 2),
    outW,
    outH,
  }
}

/**
 * (fix 124) Free resolution path (MP): generation dimensions —
 * same formula as MinimaxH3LatentUpscaler3D node (MEGAPIXELS mode:
 * binary MP * 1024*1024, Python round to multiple of 32); result —
 * maximum inscribed rectangle with EXACT aspect ratio and even
 * dimensions (yuv420p). Node receives these gen dimensions in
 * 'target dimensions' mode so output matches calculation 1:1.
 *
 * (fixes 121, 124) Floor 0.2 MP: pass 1 fixed at 0.2 MP, and upscaler
 * node prohibits downscaling (effective_scale < 1.0 and output < input
 * → ValueError). 0.2 MP is lower bound of 'Free resolution' slider;
 * at floor = 0.2 gen is always >= pass 1 (equality → node passes early-return,
 * crop still produces exact aspect ratio). Was Math.max(1, mp) — silently
 * lifted any <1 MP to 1 MP (badge '0.70 MP' generated 1 MP — incorrect).
 */
export function finalDimsFromMegapixels(
  aspect: string,
  megapixels: number,
  multiple: number = 32,
): FinalDimensions {
  const [rw, rh] = parseAspect(aspect)
  const ratio = rw / rh
  const targetPixels = Math.max(0.2, megapixels) * 1024 * 1024
  const hT = Math.sqrt(targetPixels / ratio)
  const wT = hT * ratio
  const genW = Math.max(multiple, pyRound(wT / multiple) * multiple)
  const genH = Math.max(multiple, pyRound(hT / multiple) * multiple)
  const [aw, ah] = aspectToInts(aspect)
  let k = Math.min(Math.floor(genW / aw), Math.floor(genH / ah))
  if (aw % 2 !== 0 || ah % 2 !== 0) k = Math.floor(k / 2) * 2 // both sides even
  if (k < 1) k = 1
  const outW = aw * k
  const outH = ah * k
  return {
    genW,
    genH,
    cropX: Math.floor((genW - outW) / 2),
    cropY: Math.floor((genH - outH) / 2),
    outW,
    outH,
  }
}

/**
 * Replicate ComfyUI's frame-count calculation (workflow node 46:19) exactly:
 *   max(5, round(seconds*fps)) snapped UP to the 17n+5 grid.
 * Single source of truth for metadata, shared by the client (use-video-gen)
 * and the server (pending-meta), so .video_length matches the ACTUAL frames
 * the server produces (fix 55). JS-safe Python-style modulo via
 * ((x % m) + m) % m.
 */
export function framesForDuration(seconds: number, fps = 24): number {
  const frames = Math.max(5, Math.round(seconds * fps))
  return frames + (((5 - frames) % 17) + 17) % 17
}

/* ─── Custom LoRA chain helpers (fix 44) ─── */

function loraNodeId(index: number): string {
  return `46:36_${index + 1}`
}

// (fix 483) Exported for refine-template: customLoras chain
// inserted between modelSrc and SigmaShift with same helpers (id '46:36_N'
// in refine workflow do not conflict with other nodes).
export function buildCustomLoraNodes(
  loras: Array<{ name: string; strength: number }> | undefined,
  source: [string, number],
): Record<string, unknown> {
  if (!loras || loras.length === 0) return {}
  const nodes: Record<string, unknown> = {}
  let modelSrc = source
  for (let i = 0; i < loras.length; i++) {
    const id = loraNodeId(i)
    nodes[id] = {
      inputs: {
        lora_name: loras[i].name,
        strength_model: loras[i].strength,
        model: modelSrc,
      },
      class_type: 'LoraLoaderModelOnly',
      _meta: { title: `Custom LoRA ${i + 1}: ${loras[i].name}` },
    }
    modelSrc = [id, 0]
  }
  return nodes
}

export function getLastLoraOutput(
  loras: Array<{ name: string; strength: number }> | undefined,
  fallback: [string, number],
): [string, number] {
  if (!loras || loras.length === 0) return fallback
  return [loraNodeId(loras.length - 1), 0]
}

/**
 * Build the ComfyUI API-format workflow JSON for MiniMax H3 Two-Pass Latent Upscaler.
 */
/** (fix 258) Pass 1 (low-res) cannot exceed min(2.0, finalRes).
 *  Unified function for workflow AND metadata — otherwise sidecar (and 'Replay'
 *  from it) would carry unclamped slider, drifting from actual render. */
export function clampLowResMP(lowResMP: number, finalRes: number): number {
  // (fix 258) first pass ceiling raised from 0.5 → 2.0 MP (default 0.2
  // untouched): invariant 'pass 1 <= final resolution' preserved.
  // (fix 327) ...except guaranteed minimum 1.0 MP: for 0.7 MP final
  // draft can be raised to 1.0 (better first pass detail at the cost of
  // speed). Pass 1 still never exceeds final (>1.0).
  return Math.min(lowResMP, Math.min(2, Math.max(finalRes, 1)))
}

/**
 * (fix 255) Sampler nodes by stages IN EXECUTION ORDER — for honest
 * 0→100% progress in tracker. Formed from SAME parameters as
 * workflow (defaults mirror buildExtendWorkflow):
 *   - t2v/flf/ref: 'full' → [['46:21'], ['46:16']] (pass 1 + pass 2),
 *     'draft' → [['46:21']] (single pass);
 *   - extend → [['ext_samp_0'], ['ext_samp_1'], ...] per clip;
 *     (fix 423) extendTwoPass → after each clip also its pass 2:
 *     [['ext_samp_0'], ['ext_samp2_0'], ['ext_samp_1'], ['ext_samp2_1'], …].
 */
export function videoSamplerStages(p: MiniMaxH3Params): string[][] {
  if (p.mode === 'extend') {
    const clips = p.extendClips && p.extendClips.length > 0
      ? p.extendClips
      : [{ prompt: p.prompt, duration: p.duration, seed: p.seed }]
    return clips.flatMap((_, i) =>
      p.extendTwoPass === true
        ? [[`ext_samp_${i}`], [`ext_samp2_${i}`]]
        : [[`ext_samp_${i}`]],
    )
  }
  return p.pipeline === 'draft' ? [['46:21']] : [['46:21'], ['46:16']]
}

// (fix 423) Sigma variants for pass 2 — in module scope: used by both
// main builder ('46:33') and two-pass extend (ext_sig2_*).
const SIGMA_VARIANTS: Record<string, string> = {
  '3step': '0.9035, 0.6316, 0.3158, 0.0000',
  '4step': '0.9035, 0.8000, 0.6316, 0.3158, 0.0000',
  '5step': '0.9231, 0.8780, 0.8000, 0.6316, 0.3158, 0.0000',
  '6step': '0.9412, 0.9100, 0.8780, 0.8000, 0.6316, 0.3158, 0.0000',
  '7step': '0.9500, 0.9280, 0.9100, 0.8780, 0.8000, 0.6316, 0.3158, 0.0000',
}

export function buildMiniMaxH3Workflow(p: MiniMaxH3Params): Record<string, unknown> {
  const seed = p.seed < 0 ? Math.floor(Math.random() * 2 ** 31) : p.seed
  // (fix 386) VHS output inputs from format settings
  const vhsEnc = vhsEncodeInputs(p.videoFormat)
  const finalRes = p.finalResolution ?? 0.7
  const lowResMP = clampLowResMP(p.lowResMP ?? 0.2, finalRes)
  // Default split point = 6. Previous default was 4.
  const firstSteps = p.firstSamplerSteps ?? 6
  // Total steps in pass 1 schedule. Default — same as
  // consumed by split ('6 of 6'). Configured independently → can take '6 of 8'.
  const totalSteps = Math.max(
    2,
    Math.min(64, Math.round(p.firstSamplerTotalSteps ?? firstSteps)),
  )
  // Split cannot exceed available sigmas (steps+1) — otherwise
  // SplitSigmas node receives non-existent index.
  const splitStep = Math.max(1, Math.min(firstSteps, totalSteps))

  // (fix 258) Constraint: pass 1 (low-res) maximum min(2.0, finalResolution).
  // Draft should not exceed final resolution.
  // Clamping moved to clampLowResMP — metadata uses SAME value.
  // Sigma variants for pass 2 (fix 423: table in module scope — SIGMA_VARIANTS)
  const sigmaVariant = SIGMA_VARIANTS[p.sigmaVariant || '3step'] || SIGMA_VARIANTS['3step']
  // (fix 69) Pass 2 sampler — from advanced settings, whitelist validated
  const pass2Sampler = (VALID_KSAMPLERS as readonly string[]).includes(p.pass2Sampler || '')
    ? (p.pass2Sampler as string)
    : DEFAULT_PASS2_SAMPLER
  // (fix 70) Pass 1: sampler + scheduler from advanced settings
  const pass1Sampler = (VALID_KSAMPLERS as readonly string[]).includes(p.pass1Sampler || '')
    ? (p.pass1Sampler as string)
    : DEFAULT_PASS1_SAMPLER
  const pass1Scheduler = (PASS1_SCHEDULERS as readonly string[]).includes(p.pass1Scheduler || '')
    ? (p.pass1Scheduler as string)
    : DEFAULT_PASS1_SCHEDULER
  // Turbo LoRA is regular customLoras entry (ON by default), like
  // user LoRAs; order determined by loras.json.

  // ─── (fix 146) Generation mode ───
  const mode: 'ref' | 't2v' | 'flf' | 'extend' = p.mode === 't2v' || p.mode === 'flf' || p.mode === 'extend' ? p.mode : 'ref'

  // (fix 161) Extension mode — separate workflow via MiniMaxH3Extender
  if (mode === 'extend') {
    return buildExtendWorkflow(p)
  }

  // ─── Reference images (max 9) — only in 'ref' mode ───
  // (fix 266) In 'extend' mode image refs are bound INSIDE
  // buildExtendWorkflow to ext_cond_* nodes via ref_images.ref_image_N.
  const refCount = mode === 'ref' ? Math.min(p.refImages.length, 9) : 0
  const refImageNodes: Record<string, unknown> = {}
  const refImageLinks: Record<string, unknown> = {}

  for (let i = 0; i < refCount; i++) {
    const loadId = REF_IMAGE_NODE_IDS[i]
    refImageNodes[loadId] = {
      inputs: { image: p.refImages[i] },
      class_type: 'LoadImage',
      _meta: { title: `Reference ${i + 1}` },
    }
    refImageLinks[`ref_images.ref_image_${i}`] = [loadId, 0]
  }

  // ─── Reference videos (max 3) — VHS_LoadVideo → IMAGE frames + optional AUDIO — only 'ref' ───
  const refVideoCount = mode === 'ref' ? Math.min(p.refVideos?.length ?? 0, 3) : 0
  const refVideoNodes: Record<string, unknown> = {}
  const refVideoLinks: Record<string, unknown> = {}

  for (let i = 0; i < refVideoCount; i++) {
    const vid = p.refVideos![i]
    const nodeId = REF_VIDEO_NODE_IDS[i]
    refVideoNodes[nodeId] = {
      // (fix 320) force_rate 24: model interprets frames as 1/24 s.
      // Was force_rate: 0 → 30 fps ref gave duration*30 frames → reference
      // played by model 25% slower, and its audio (original
      // duration, VHS audio passthrough) desynced from frames.
      // force_rate drops/duplicates frames while PRESERVING duration (VHS
      // cv/ffmpeg generators), keeping audio ref synchronous.
      inputs: { video: vid.path, force_rate: 24, custom_width: 0, custom_height: 0, frame_load_cap: 0, skip_first_frames: 0, select_every_nth: 1 },
      class_type: 'VHS_LoadVideo',
      _meta: { title: `Video Ref ${i + 1}` },
    }
    // output[0] = IMAGE (frames) → ref_video_N
    refVideoLinks[`ref_videos.ref_video_${i}`] = [nodeId, 0]
    // If includeAudio, wire output[2] = AUDIO → ref_video_audio_N
    if (vid.includeAudio !== false) {
      refVideoLinks[`ref_video_audios.ref_video_audio_${i}`] = [nodeId, 2]
    }
  }

  // ─── Standalone audio references (max 3) — LoadAudio → AUDIO ───
  // (fix 146) in ref mode they feed ref_audio_N of main node,
  // in t2v/flf — into MiniMaxH3AddGuide chain (see below). In ref with audioGuide
  // ('original audio + guide by it' option) ref_audios NOT connected:
  // same audio feeds Audio Guide, server attaches track later.
  const refAudioCount = Math.min(p.refAudios?.length ?? 0, 3)
  const refAudioNodes: Record<string, unknown> = {}
  const refAudioLinks: Record<string, unknown> = {}
  // (fix 326) Final AUDIO sources with trim accounted for — for ref links
  // and Audio Guide chain (t2v/flf).
  const refAudioSrcs: Record<number, [string, number]> = {}

  for (let i = 0; i < refAudioCount; i++) {
    const nodeId = REF_AUDIO_NODE_IDS[i]
    refAudioNodes[nodeId] = {
      inputs: { audio: p.refAudios![i] },
      class_type: 'LoadAudio',
      _meta: { title: `Audio Ref ${i + 1}` },
    }
    // (fix 326) Audio ref trim: LoadAudio → MiniMaxStudioAudioTrim →
    // consumer (ref_audio_N / Audio Guide). Virtual, no file copies.
    let audioSrc: [string, number] = [nodeId, 0]
    const trim = p.refAudioTrims?.[i]
    if (trim && (trim.start > 0 || (trim.end != null && trim.end > 0))) {
      const trimId = `${nodeId}_trim`
      refAudioNodes[trimId] = {
        inputs: {
          audio: [nodeId, 0],
          start_seconds: trim.start,
          end_seconds: trim.end ?? 0,
        },
        class_type: 'MiniMaxStudioAudioTrim',
        _meta: { title: `Audio Ref ${i + 1}: trim ${trim.start}s → ${trim.end ?? 'end'}` },
      }
      audioSrc = [trimId, 0]
    }
    // (fix 694) Audio ref volume: AudioTrim/LoadAudio → AudioGain → consumer.
    const vol = p.refAudioVolumes?.[i]
    if (vol != null && Math.abs(vol - 1.0) > 1e-6) {
      const gainId = `${nodeId}_gain`
      refAudioNodes[gainId] = {
        inputs: { audio: audioSrc, gain: vol },
        class_type: 'MiniMaxStudioAudioGain',
        _meta: { title: `Audio Ref ${i + 1}: volume ${Math.round(vol * 100)}%` },
      }
      audioSrc = [gainId, 0]
    }
    if (mode === 'ref' && p.audioGuide !== true) {
      refAudioLinks[`ref_audios.ref_audio_${i}`] = audioSrc
    }
    // t2v/flf: source for MiniMaxH3AddGuide (below) — with trim and volume accounted for.
    refAudioSrcs[i] = audioSrc
  }

  // ─── H3 node inputs ───
  // Resolution: pass 1 always lowResMP (except flf — finalRes there, fix 153)
  // (fix 152) In flf mode with known frame dimensions — use frame aspect ratio
  let aspect = p.aspectRatio || '16:9 (Widescreen)'
  // (fix 152) If first frame dimensions known — recalculate aspect ratio from them
  if (mode === 'flf' && p.firstFrameWidth && p.firstFrameHeight) {
    const ratio = p.firstFrameWidth / p.firstFrameHeight
    // Find nearest standard aspect ratio
    if (Math.abs(ratio - 21/9) < 0.2) aspect = '21:9 (Ultrawide)'
    else if (Math.abs(ratio - 16/9) < 0.15) aspect = '16:9 (Widescreen)'
    else if (Math.abs(ratio - 9/16) < 0.15) aspect = '9:16 (Portrait Widescreen)'
    else if (Math.abs(ratio - 1) < 0.1) aspect = '1:1 (Square)'
    else if (Math.abs(ratio - 4/3) < 0.15) aspect = '4:3 (Standard)'
    else if (Math.abs(ratio - 3/4) < 0.15) aspect = '3:4 (Portrait Standard)'
    else if (Math.abs(ratio - 3/2) < 0.15) aspect = '3:2 (Photo)'
    else if (Math.abs(ratio - 2/3) < 0.15) aspect = '2:3 (Portrait Photo)'
    else aspect = '16:9 (Widescreen)'
  }
  // (fix 525) If targetDimensions set (480p/720p/1080p presets * aspect),
  // aspect ratio derived from it so lowRes (pass 1) shares same
  // aspect ratio as final. Otherwise MinimaxH3LatentUpscaler3D in
  // 'target dimensions' mode scales lowRes → final with DIFFERENT factors on
  // axes → distortion (stretching/squishing). Example: targetDimensions=640x480 (4:3), but
  // aspect='16:9' → lowRes=608x352 (16:9) → upscale x1.05 y1.36.
  // (Under singleCanvas — flf/draft — lowRes already derived from targetDimensions,
  // so aspect does not matter, but recalculation is harmless.)
  if (p.targetDimensions) {
    aspect = `${p.targetDimensions.width}:${p.targetDimensions.height}`
  }
  // (fix 153) In flf mode pass 1 generated at SAME resolution as pass 2.
  // Reason: keyframe encoded ONCE (vae.encode) for pass 1 resolution.
  // If pass 1 != pass 2, upscaler rescales latent but keyframe latent
  // remains low-res → fix 149 re-encodes for pass 2, but
  // vae.encode() at different resolutions yields DIFFERENT latents → model sees
  // 'two different frames' → ghosting/doubling.
  //
  // Solution: in flf pass 1 = pass 2 resolution. Thus:
  //   1. Keyframe encoded once at this resolution
  //   2. Pass 1 runs at this resolution — keyframe latent matches
  //   3. Upscaler does early-return (w_out == w_in && h_out == h_in)
  //   4. Pass 2 runs at same resolution — keyframe latent IDENTICAL to pass 1
  //
  // This eliminates frame doubling in frame mode.
  //
  // IMPORTANT: selectResolution() and finalDimsFromMegapixels() use DIFFERENT
  // formulas (Math.round vs pyRound, different scale math), so even at
  // same MP they may produce different sizes. To guarantee early-return
  // of upscaler in flf: (a) compute lowRes via selectResolution or from
  // targetDimensions, (b) pass as final — then final = computeFinalDimensions
  // gives genW = lowRes.w, genH = lowRes.h (ceil32 already applied).
  // (fix 155) In flf with preset (480p/720p/1080p) targetDimensions = nominal,
  // so 480p and 720p produce distinct resolutions (480x854 vs 720x1280 for 9:16).
  // Without preset — finalRes MP (default 0.7).
  const flfSinglePass = mode === 'flf'
  // Pipeline 'Draft': SINGLE pass across FULL BasicScheduler schedule
  // (steps = draftSteps, without SplitSigmas — in 'full' split cuts upper
  // half for Pass 2, here no Pass 2). No upscaler or
  // second pass. Output = draft for review; upgrade via Refine tab.
  const draft = p.pipeline === 'draft'
  const draftSteps = Math.min(30, Math.max(2, Math.round(p.draftSteps ?? 4)))
  // Single-pass canvas (flf and draft) taken from PRIMARY resolution
  // settings: preset → targetDimensions (ceil32), free → finalRes MP.
  // lowResMP from advanced settings only controls Pass 1 canvas in 'full'.
  // (fix 156) In flf single-pass mode: pass 1 must generate at SAME
  // resolution as pass 2. If targetDimensions set — use for lowRes,
  // otherwise finalRes MP. Guarantees lowRes == final and upscaler triggers
  // early-return (no rescaling → no aspect ratio change).
  // IMPORTANT: ComfyUI requires multiple of 32 for latent dimensions. targetDimensions from
  // presets (480x854, 720x1280) not multiple of 32 — round up to multiple of 32 (ceil32).
  // (draft) Single-pass canvas — like flf: from PRIMARY settings.
  const singleCanvas = flfSinglePass || draft
  // (fix 124) Exact aspect ratio + EXACT final resolution:
  //   • quality presets — nominal dimensions (targetDimensions),
  //     gen = ceil32(nominal), upscaler 'target dimensions', final —
  //     crop exactly to nominal (16:9 1080p → 1920x1088 → 1920x1080);
  //   • free resolution — binary node MP + inscribed crop
  //     (finalDimsFromMegapixels).
  // (fix 153) In flf single-pass: final = computeFinalDimensions(lowRes)
  // — upscaler does early-return, keyframe latent remains identical.
  // (fix 155) In flf with targetDimensions — use nominal (480p/720p/1080p),
  // without — lowRes (from finalRes MP).
  // computeFinalDimensions / finalDimsFromMegapixels — unified source
  // of truth for workflow (target dimensions + ImageCrop), metadata
  // (pending-meta, use-video-gen) and UI badges — identical result everywhere.
  // (fix 156) Single canvas (flf/draft): final = computeFinalDimensions
  // (ceil32) — upscaler does early-return / unneeded, no crop.
  // In other modes — targetDimensions (nominal) or finalRes MP.
  const final = singleCanvas
    ? (p.targetDimensions
      ? computeFinalDimensions(
          Math.max(32, Math.ceil(p.targetDimensions.width / 32) * 32),
          Math.max(32, Math.ceil(p.targetDimensions.height / 32) * 32),
        )
      : computeFinalDimensions(
          ...(() => {
              const r = selectResolution(aspect, finalRes)
              return [r.w, r.h] as [number, number]
            })(),
        ))
    : p.targetDimensions
      ? computeFinalDimensions(p.targetDimensions.width, p.targetDimensions.height)
      : finalDimsFromMegapixels(aspect, finalRes)
  // (fix 525 REVISED) Pass 1 canvas: select lowResMP so that
  // selectResolution(aspect, lowResMP) has same aspect ratio as final
  // (or as close as possible). Then lowRes → final upscale is uniform
  // (x_factor ≈ y_factor) — distortion-free. Pass 1 is SMALLER than final
  // (faster generation), but matching aspect ratio.
  //
  // Algorithm: search lowResMP in [0.05, 0.5] (or lower if userMP < 0.05)
  // to minimize |x_factor - y_factor|, where:
  //   x_factor = final.genW / lowRes.w
  //   y_factor = final.genH / lowRes.h
  //
  // Constraints:
  //  - lowRes must NOT exceed final on ANY axis (otherwise ValueError)
  //  - if x_factor and y_factor both < 1.25 — pass 1 = final (fix 439 analog)
  //
  // In singleCanvas (flf/draft) lowRes = ceil32(targetDimensions) or
  // selectResolution(aspect, finalRes) — upscaler early-return.
  // In 'full' without targetDimensions (free-MP) — selectResolution
  // (aspect, lowResMP); aspect and final share SAME ASPECT RATIO → upscale ~1x.
  const finalMP = (final.genW * final.genH) / (1024 * 1024)
  let lowRes: { w: number; h: number }
  if (singleCanvas) {
    // flf/draft: lowRes = ceil32(targetDimensions) or selectResolution(finalRes)
    lowRes = p.targetDimensions
      ? {
          w: Math.max(32, Math.ceil(p.targetDimensions.width / 32) * 32),
          h: Math.max(32, Math.ceil(p.targetDimensions.height / 32) * 32),
        }
      : selectResolution(aspect, finalRes)
  } else if (p.targetDimensions) {
    // 'full' with preset: choose lowResMP so lowRes aspect ratio ≈ final aspect ratio
    // (minimize |x_factor - y_factor|), with lowRes <= final on both axes.
    const userMP = clampLowResMP(p.lowResMP ?? 0.2, finalRes)
    // Search range: 0.05 to max(userMP, 0.5), not above finalMP
    const searchHi = Math.min(Math.max(userMP, 0.5), finalMP)
    const searchLo = 0.05
    let bestDistortion = Infinity
    let bestResult = selectResolution(aspect, userMP)
    // Iterative search: test different MP values and pick one that gives
    // minimal |x_factor - y_factor| provided lowRes <= final
    const numSteps = 50
    for (let i = 0; i <= numSteps; i++) {
      const mp = searchLo + (searchHi - searchLo) * (i / numSteps)
      const r = selectResolution(aspect, mp)
      // Verify lowRes <= final on both axes
      if (r.w > final.genW || r.h > final.genH) continue
      const xFactor = final.genW / r.w
      const yFactor = final.genH / r.h
      const distortion = Math.abs(xFactor - yFactor)
      // Verify upscale is not too small (< 1.25x on both axes → redundant)
      const isTrivial = xFactor < 1.25 && yFactor < 1.25
      if (isTrivial) continue // skip so pass 1 is truly smaller than final
      if (distortion < bestDistortion) {
        bestDistortion = distortion
        bestResult = r
      }
    }
    // (fix 439 analog) If no suitable lowRes found (either all > final
    // or upscale < 1.25x) — pass 1 = final, upscaler early-return.
    if (bestDistortion === Infinity) {
      lowRes = { w: final.genW, h: final.genH }
    } else {
      lowRes = bestResult
    }
  } else {
    // 'full' without targetDimensions (free-MP): as before
    lowRes = selectResolution(aspect, lowResMP)
  }
  const needsCrop = final.genW !== final.outW || final.genH !== final.outH
  // (fix 146) Main H3 node depends on mode: references →
  // MiniMaxH3ReferenceToVideo (as before), t2v/flf → MiniMaxH3ImageToVideo
  // (+ LoadImage frame nodes for flf). Both have identical outputs
  // (conditioning + latent) — downstream pipeline unchanged.
  const flfNodes: Record<string, unknown> = {}
  let h3Class = 'MiniMaxH3ReferenceToVideo'
  let h3Title = 'MiniMax H3 Reference to Video'
  let h3Inputs: Record<string, unknown>
  if (mode === 'ref') {
    h3Inputs = {
      prompt: p.prompt,
      width: lowRes.w,
      height: lowRes.h,
      length: ['46:19', 1],
      ref_image_size: p.refImageSize || 'match', // (fix 58) match | max — from advanced settings
      clip: ['46:15', 0],
      vae: ['46:3', 0],
      audio_vae: ['46:4', 0],
      ...refImageLinks,
      ...refVideoLinks,
      ...refAudioLinks,
    }
  } else {
    h3Class = 'MiniMaxH3ImageToVideo'
    h3Title = mode === 'flf'
      ? 'MiniMax H3 First/Last Frame to Video'
      : 'MiniMax H3 Text to Video'
    h3Inputs = {
      prompt: p.prompt,
      width: lowRes.w,
      height: lowRes.h,
      length: ['46:19', 1],
      clip: ['46:15', 0],
      vae: ['46:3', 0],
    }
    if (mode === 'flf') {
      if (!p.firstFrame) {
        throw new Error('First/last frame mode: first frame not specified')
      }
      flfNodes[FIRST_FRAME_NODE_ID] = {
        inputs: { image: p.firstFrame },
        class_type: 'LoadImage',
        _meta: { title: 'First frame' },
      }
      h3Inputs.first_frame = [FIRST_FRAME_NODE_ID, 0]
      if (p.lastFrame) {
        flfNodes[LAST_FRAME_NODE_ID] = {
          inputs: { image: p.lastFrame },
          class_type: 'LoadImage',
          _meta: { title: 'Last frame' },
        }
        h3Inputs.last_frame = [LAST_FRAME_NODE_ID, 0]
      }
    }
  }

  // (fix 146) t2v/flf: audio refs fed via MiniMaxH3AddGuide chain —
  // MiniMaxH3ImageToVideo has no audio inputs. Each guide anchors audio to
  // frame 0 (soundtrack for whole clip); downstream conditioning chains from tail
  // of chain.
  const audioGuideNodes: Record<string, unknown> = {}
  let condSrc: [string, number] = ['46:11', 0]
  if ((mode !== 'ref' || p.audioGuide === true) && refAudioCount > 0) {
    for (let i = 0; i < refAudioCount; i++) {
      const gid = AUDIO_GUIDE_NODE_IDS[i]
      audioGuideNodes[gid] = {
        inputs: {
          positive: condSrc,
          latent: ['46:11', 1],
          frame_idx: 0,
          audio: refAudioSrcs[i] ?? [REF_AUDIO_NODE_IDS[i], 0], // (fix 326) with trim accounted for
          audio_vae: ['46:4', 0],
        },
        class_type: 'MiniMaxH3AddGuide',
        _meta: { title: `Audio Guide ${i + 1}` },
      }
      condSrc = [gid, 0]
    }
  }

  // ─── Model optimization chain (optional nodes) ───
  // UNET → [LowVRAM] → [ChunkFF] → (LoRA input). `modelSrc` walks down
  // the chain as nodes get enabled, so the LoRA always receives the
  // last patch in the chain (or the raw UNET when both are off).
  const lowVram = p.lowVramAttention !== false
  const chunkFF = p.chunkFeedForward !== false
  const modelNodes: Record<string, unknown> = {}
  let modelSrc: [string, number] = ['46:30', 0]
  if (lowVram) {
    modelNodes['46:43'] = {
      inputs: { head_chunks: 4, model: modelSrc },
      class_type: 'MiniMaxLowVRAMAttention',
      _meta: { title: 'Low VRAM Attention' },
    }
    modelSrc = ['46:43', 0]
  }
  if (chunkFF) {
    modelNodes['46:40'] = {
      inputs: {
        chunks: Math.max(1, Math.round(p.chunkFFChunks ?? 2)),
        seq_threshold: Math.max(0, Math.round(p.chunkFFThreshold ?? 4096)),
        model: modelSrc,
      },
      class_type: 'MiniMaxChunkFeedForward',
      _meta: { title: 'Chunk FeedForward' },
    }
    modelSrc = ['46:40', 0]
  }

  const workflow: Record<string, unknown> = {
    // ═══════════════════════════════════════════════
    //  INPUTS
    // ═══════════════════════════════════════════════

    // Duration → Frames calculation
    '17': {
      inputs: { value: p.duration },
      class_type: 'PrimitiveFloat',
      _meta: { title: 'Duration (seconds)' },
    },
    '46:19': {
      inputs: {
        expression: 'max(5, round(a * 24)) + (5 - (max(5, round(a * 24)) % 17)) % 17',
        'values.a': ['17', 0],
      },
      class_type: 'ComfyMathExpression',
      _meta: { title: 'Frames Calculation' },
    },

    // Low-res resolution is computed server-side (selectResolution) and fed
    // to the H3 node as plain ints — no ResolutionSelector node needed
    // (it cannot express e.g. 2.35:1).

    // (fix 124) Node '23' (PrimitiveFloat final MP) removed: upscaler
    // receives exact dimensions directly (mode.width / mode.height).

    // ═══════════════════════════════════════════════
    //  MODEL LOADING
    // ═══════════════════════════════════════════════

    '46:30': {
      inputs: {
        // (fix 293) Default — returned base model (better quality)
        unet_name: p.diffusionModel || 'minimax_h3_fastvideo_vsa_datafree_1300step_4step_int8_convrot.safetensors',
        weight_dtype: 'default',
      },
      class_type: 'UNETLoader',
      _meta: { title: 'Load Diffusion Model' },
    },
    '46:15': {
      inputs: {
        clip_name: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
        type: 'minimax',
        device: 'default',
      },
      class_type: 'CLIPLoader',
      _meta: { title: 'Load CLIP' },
    },
    '46:3': {
      inputs: { vae_name: 'minimax_h3_video_vae_int8_convrot.safetensors' },
      class_type: 'VAELoader',
      _meta: { title: 'VAE (video)' },
    },
    '46:4': {
      inputs: { vae_name: 'minimax_h3_audio_vae_fp32.safetensors' },
      class_type: 'VAELoader',
      _meta: { title: 'VAE (audio)' },
    },

    // ═══════════════════════════════════════════════
    //  MODEL OPTIMIZATION CHAIN (optional nodes)
    //  UNET → [LowVRAM] → [ChunkFF] → LoRA → SigmaShift → Attention → Preview
    // ═══════════════════════════════════════════════

    ...modelNodes,

    // Turbo LoRA — standard customLoras entry (ON by default), like
    // user LoRAs; order set by loras.json.
    ...buildCustomLoraNodes(p.customLoras, modelSrc),
    // Sigma Shift (receives last node in the LoRA chain)
    '46:38': {
      inputs: {
        shift_video: 12,
        shift_audio: 3,
        model: getLastLoraOutput(p.customLoras, modelSrc),
      },
      class_type: 'MiniMaxH3SigmaShift',
      _meta: { title: 'Sigma Shift' },
    },
    // (fix 301) Sparse attention: Veda (if enabled) or Sol-Attn (default).
    // Veda: for long videos (10+ sec) and 8+ steps. Sol-Attn: for short clips.
    ...(p.vedaAttention ? {
      '46:44': {
        inputs: {
          // (fix 422) Veda AFTER Attention Backend: both nodes write
          // transformer_options['optimized_attention_override'], Veda
          // composites over current, backend — overwrites. If
          // backend follows Veda, Veda hooks are overwritten and do not work.
          model: ['46:37', 0],
          predictor: 'minimax_h3_t2va_veda_8nfe_600step_preview_fp8.safetensors',
          // (fix 399) node parameters from application settings
          generated_sparsity: clampVedaSparsity(p.vedaGeneratedSparsity, 90),
          reference_sparsity: clampVedaSparsity(p.vedaReferenceSparsity, 90),
          full_attention_layers: sanitizeVedaIndexList(p.vedaFullAttentionLayers),
          full_attention_steps: sanitizeVedaIndexList(p.vedaFullAttentionSteps),
          verbose: p.vedaVerbose === true,
        },
        class_type: 'VedaSparseAttention',
        _meta: { title: 'Veda Sparse Attention' },
      },
    } : p.sparseAttention === true ? { // (fix 387) Sol-Attn OFF by default
      '46:44': {
        inputs: {
          model: ['46:37', 0], // (fix 422) sparse — AFTER Attention Backend, see above
          // (fix 466) Parameters — from Settings → Generation Optimization
          tau: p.sparseTau ?? 1.3,
          start_percent: p.sparseStartPercent ?? 0.2,
          end_percent: p.sparseEndPercent ?? 1.0,
          min_tokens: p.sparseMinTokens ?? 12288,
          extra_tokens: p.sparseExtraTokens ?? 256,
        },
        class_type: 'MiniMaxSparseAttention',
        _meta: { title: 'Sparse Attention (Sol-Attn)' },
      },
    } : {}),
    // Attention Backend (connects to SigmaShift or sparse attention node)
    '46:37': {
      inputs: {
        attention: 'comfy kitchen attention',
        // (fix 422) Backend immediately after SigmaShift; sparse-node ('46:44')
        // now follows it — last attention patch before sampler.
        model: ['46:38', 0],
      },
      class_type: 'ModelAttentionBackend',
      _meta: { title: 'Attention Backend' },
    },
    // Live Preview (attached to pass 1 only)
    '12': {
      inputs: {
        // (fix 422) chain tail: sparse-node if enabled, otherwise backend
        model: (p.vedaAttention || p.sparseAttention === true) ? ['46:44', 0] : ['46:37', 0],
        vae: ['46:3', 0],
        tiny_vae: 'taeh3.safetensors',
        max_resolution: 1024,
        jpeg_quality: 80,
        suppress_default_preview: true,
        preview_frames: ['46:19', 1],
        preview_fps: 6,
      },
      class_type: 'ModelPreviewOverrideKJ',
      _meta: { title: 'Model Preview Override' },
    },

    // ═══════════════════════════════════════════════
    //  MAIN H3 NODE (Reference to Video)
    // ═══════════════════════════════════════════════

    '46:11': {
      inputs: h3Inputs,
      class_type: h3Class,
      _meta: { title: h3Title },
    },

    // (fix 146) flf: LoadImage of first/last frame
    ...flfNodes,
    // (fix 146) t2v/flf: audio guides chain
    ...audioGuideNodes,

    // ═══════════════════════════════════════════════
    //  SAMPLING COMMON
    // ═══════════════════════════════════════════════

    // (fixes 67, 70) Pass 1: sampler + scheduler selectable (default euler / simple).
    // (fixes 68–69) Pass 2: sampler selectable (default euler) —
    // sigmas remain ManualSigmas.
    '46:18a': {
      inputs: { sampler_name: pass1Sampler },
      class_type: 'KSamplerSelect',
      _meta: { title: `KSampler Pass 1 (${pass1Sampler})` },
    },
    '46:18': {
      inputs: { sampler_name: pass2Sampler },
      class_type: 'KSamplerSelect',
      _meta: { title: `KSampler Pass 2 (${pass2Sampler})` },
    },
    '46:31': {
      inputs: { noise_seed: seed },
      class_type: 'RandomNoise',
      _meta: { title: 'Random Noise' },
    },

    // ═══════════════════════════════════════════════
    //  PASS 1: Low-res (0.2 MP, totalSteps → SplitSigmas)
    // ═══════════════════════════════════════════════

    // BasicScheduler: 'full' — totalSteps (default = split point,
    // '6 of 6'), SplitSigmas gives Pass 1 top portion; 'draft' — schedule
    // of single pass with draftSteps length, full, without split.
    '46:24': {
      inputs: {
        scheduler: pass1Scheduler,
        steps: draft ? draftSteps : totalSteps,
        denoise: 1,
        model: ['46:30', 0],
      },
      class_type: 'BasicScheduler',
      _meta: {
        title: `Pass 1 Scheduler (${draft ? `${draftSteps} steps (draft)` : `${totalSteps} steps`}, ${pass1Scheduler})`,
      },
    },
    // SplitSigmas: take first splitStep of the total — only 'full'
    ...(!draft && {
      '46:13': {
        inputs: {
          step: splitStep,
          sigmas: ['46:24', 0],
        },
        class_type: 'SplitSigmas',
        _meta: { title: `Split Sigmas (take ${splitStep} of ${totalSteps})` },
      },
    }),
    // BasicGuider (pass 1 — uses Preview model)
    '46:29': {
      inputs: {
        model: ['12', 0],
        conditioning: condSrc, // (fix 146) audio guide chain tail in t2v/flf
      },
      class_type: 'BasicGuider',
      _meta: { title: 'Pass 1 Guider' },
    },
    // SamplerCustomAdvanced (pass 1). 'full': split-sigmas (top HALF
    // of trajectory — composition; tail completed by Pass 2). 'draft': full
    // BasicScheduler schedule ('46:24') — single pass from scratch, output
    // directly to decode.
    '46:21': {
      inputs: {
        noise: ['46:31', 0],
        guider: ['46:29', 0],
        sampler: ['46:18a', 0],
        sigmas: draft ? ['46:24', 0] : ['46:13', 0],
        latent_image: ['46:11', 1],
      },
      class_type: 'SamplerCustomAdvanced',
      _meta: { title: draft ? 'Draft Sampler (single pass, full schedule)' : 'Pass 1 Sampler (low-res, split sigmas)' },
    },

    // ═══════════════════════════════════════════════
    //  LATENT UPSAMPLE (only 'full')
    // ═══════════════════════════════════════════════

    ...(!draft && {
      // Separate AV latent from pass 1
      '46:35': {
        inputs: { av_latent: ['46:21', 1] },
        class_type: 'LTXVSeparateAVLatent',
        _meta: { title: 'Separate AV Latent' },
      },
      // Upscale video latent to target resolution
      // (fix 124) Mode 'target dimensions': node outputs exactly genW x genH,
      // regardless of pass 1 aspect ratio (megapixels mode kept aspect ratio
      // of input and rounded axes — so 16:9 was inaccurate).
      '46:26': {
        inputs: {
          model_name: 'minimax_h3_latent_upscaler_3d_fp16.safetensors',
          mode: 'target dimensions',
          'mode.width': final.genW,
          'mode.height': final.genH,
          align: 32,
          // enable_chunking — input of older node versions; newer versions (pinned
          // 40316cf) renamed to enable_temporal_chunking and added
          // required force_unload. ComfyUI ignores superfluous inputs, so
          // we pass both names — workflow works with any node version.
          enable_chunking: true, // (fix 68) was false — per user request
          enable_temporal_chunking: true,
          force_unload: true,
          device: 'cuda',
          precision: 'fp16',
          latent: ['46:35', 0],
        },
        class_type: 'MinimaxH3LatentUpscaler3D',
        _meta: { title: `Latent Upscaler (3D) → ${final.genW}×${final.genH}` },
      },
      // Re-combine upscaled video + audio latent
      '46:10': {
        inputs: {
          video_latent: ['46:26', 0],
          audio_latent: ['46:35', 1],
        },
        class_type: 'LTXVConcatAVLatent',
        _meta: { title: 'Concat AV Latent' },
      },
    }),

    // ═══════════════════════════════════════════════
    //  PASS 2: High-res refinement (3 steps) — only 'full'
    // ═══════════════════════════════════════════════

    ...(!draft && {
      // ManualSigmas schedule for Pass 2 (re-render seed from upscaler)
      '46:33': {
        inputs: {
          sigmas: sigmaVariant,
        },
        class_type: 'ManualSigmas',
        _meta: { title: `Pass 2 Sigmas (${(p.sigmaVariant || '3step')})` },
      },
      // Live Preview (attached to pass 2)
      '13': {
        inputs: {
          // (fix 422) chain tail: sparse-node if enabled, otherwise backend
          model: (p.vedaAttention || p.sparseAttention === true) ? ['46:44', 0] : ['46:37', 0],
          vae: ['46:3', 0],
          tiny_vae: 'taeh3.safetensors',
          max_resolution: 1024,
          jpeg_quality: 80,
          suppress_default_preview: true,
          preview_frames: ['46:19', 1],
          preview_fps: 6,
        },
        class_type: 'ModelPreviewOverrideKJ',
        _meta: { title: 'Model Preview Override (Pass 2)' },
      },
      // BasicGuider (pass 2 — uses Preview model)
      '46:32': {
        inputs: {
          model: ['13', 0],
          conditioning: condSrc, // (fix 146) audio guide chain tail in t2v/flf
        },
        class_type: 'BasicGuider',
        _meta: { title: 'Pass 2 Guider' },
      },
      // SamplerCustomAdvanced (pass 2)
      '46:16': {
        inputs: {
          noise: ['46:31', 0],
          guider: ['46:32', 0],
          sampler: ['46:18', 0],
          sigmas: ['46:33', 0],
          latent_image: ['46:10', 0],
        },
        class_type: 'SamplerCustomAdvanced',
        _meta: { title: 'Pass 2 Sampler (high-res)' },
      },
    }),

    // ═══════════════════════════════════════════════
    //  DECODE (separate video + audio)
    // ═══════════════════════════════════════════════

    '46:25': {
      inputs: {
        // 'draft': single pass ('46:21'); 'full': Pass 2 ('46:16')
        samples: draft ? ['46:21', 0] : ['46:16', 0],
        vae: ['46:3', 0],
      },
      class_type: 'VAEDecode',
      _meta: { title: 'Decode Video' },
    },

    // (fix 124) Crop gen-resolution (multiple of 32, slightly above nominal)
    // to EXACT nominal (e.g. 16:9 1080p: 1920x1088 → 1920x1080).
    // Node placed only when gen != nominal — otherwise chain unchanged.
    // ('draft' not cropped: selectResolution canvas already /32 = exact final.)
    ...(needsCrop && !draft && {
      '46:48': {
        inputs: {
          image: ['46:25', 0],
          width: final.outW,
          height: final.outH,
          x: final.cropX,
          y: final.cropY,
        },
        class_type: 'ImageCrop',
        _meta: { title: `Exact Crop → ${final.outW}×${final.outH}` },
      },
    }),
    '46:14': {
      inputs: {
        samples: draft ? ['46:21', 0] : ['46:16', 0],
        vae: ['46:4', 0],
      },
      class_type: 'VAEDecodeAudio',
      _meta: { title: 'Decode Audio' },
    },

    // ═══════════════════════════════════════════════
    //  OUTPUT
    // ═══════════════════════════════════════════════

    '45': {
      inputs: {
        frame_rate: 24,
        loop_count: 0,
        // (fix 91) Subfolder = project folder: VHS writes to output/<folder>/.
        // Name already sanitized on server (generate route, single segment).
        filename_prefix: p.outputSubfolder ? `${p.outputSubfolder}/Minimax_Studio` : 'Minimax_Studio',
        // (fix 386) format/quality — from studio [video] settings
        ...vhsEnc,
        save_metadata: false,
        pingpong: false,
        save_output: true,
        // (fix 121) via crop node if aspect ratio requires exact crop
        images: needsCrop && !draft ? ['46:48', 0] : ['46:25', 0],
        audio: ['46:14', 0],
      },
      class_type: 'VHS_VideoCombine',
      _meta: { title: 'Video Combine' },
    },

    // ═══════════════════════════════════════════════
    //  SAVE AV LATENT (fix 375) — latent pipeline 'draft → refine'
    // ═══════════════════════════════════════════════
    // Save SAME sampler output as goes to decode/mp4 ('46:25'/'46:14'):
    // draft → single pass '46:21', full → Pass 2 '46:16' (output 0 =
    // final latent of complete schedule ending at sigma=0). Binding with mp4
    // — NOT by counter match (nodes have independent counters), but actual
    // path in ui.latents: status route writes to sidecar on metadata finalization
    // as latent_file (pending-meta.ts). Refine starts from it directly
    // avoiding h264-decode + redundant VAEEncode (lossless path).
    // File: output/<subfolder>/latents/Minimax_Studio_XXXXX_.latent (~1-10 MB).
    '46:49': {
      inputs: {
        samples: draft ? ['46:21', 0] : ['46:16', 0],
        filename_prefix: p.outputSubfolder
          ? `${p.outputSubfolder}/latents/Minimax_Studio`
          : 'latents/Minimax_Studio',
        vae_name: 'minimax_h3_video_vae_int8_convrot.safetensors',
      },
      class_type: 'MiniMaxStudioSaveAVLatent',
      _meta: { title: 'Save AV Latent (for lossless refine)' },
    },

    // ─── Reference image nodes (fix 55: up to 9) ───
    ...refImageNodes,

    // ─── Reference video nodes (VHS_LoadVideo) ───
    ...refVideoNodes,

    // ─── Reference audio nodes (LoadAudio) ───
    ...refAudioNodes,
  }

  return workflow
}

/* ═══════════════════════════════════════════════════════════
 * Extend mode — SINGLE-PASS.
 * (fix 247) Second pass (upscale + soft refine) REMOVED:
 * re-rendering each clip with own sigmas broke continuity at
 * seams (same artifacts as before). Extender runs standalone —
 * on canvas of SOURCE RESOLUTION (final.genW x genH), its internal
 * sampler (steps/sampler/scheduler, denoise 1.0) — full trajectory.
 * Upgrade resolution of extended video later via Refine tab.
 *
 *   LoadVideo (24 fps) → tail (17n+5 grid) → Resize(gen) → VAEEncode
 *     → tail AV latent → preserved head of clip 0 (latent masking,
 *     fix 252)
 *   (fix 419, reference 'V2V Extend Any Video'): source context window
 *     2 s (56 frames), not 5 s; ENTIRE wedge fed to conditioning as
 *     ref_image (frame batch, slot after user images), ref_videos not
 *     used; segment-to-segment overlap = 56 frames.
 *   For each clip i: one sampler (latent masking) → VAEDecode
 *     (+ VAEDecodeAudio) → VHS_VideoCombine extclip_<i>
 *     (clip i>0 — with 22-frame preserved head trimmed in workflow;
 *     clip 0 written WITH head-tail of source: its overlap of
 *     17 frames smoothed by client ffmpeg concat — Trim 9 + xfade 8)
 *   Client concats [source, clip0, clip1, ...] via
 *   /api/comfy/concat (fix 417 — REVERT extend latent pipeline:
 *   combined latent, segment decode, and single output of fixes
 *   383/384/385/416 removed — with pixel/latent head model
 *   replayed source from frame 0 or froze end; old scheme
 *   'each clip own mp4 + ffmpeg concat' verified by user).
 *
 *   Preview: extpv (ModelPreviewOverrideKJ) wraps model
 *   FOR Extender — wrapper triggers only if sampler
 *   receives OUTPUT of preview node.
 */
function buildExtendWorkflow(p: MiniMaxH3Params): Record<string, unknown> {
  const seed = p.seed < 0 ? Math.floor(Math.random() * 2 ** 31) : p.seed
  const vhsEnc = vhsEncodeInputs(p.videoFormat) // (fix 386)

  // Clips: from extendClips or single prompt
  const clips = p.extendClips && p.extendClips.length > 0
    ? p.extendClips
    : [{ prompt: p.prompt, duration: p.duration, seed: p.seed }]

  // ─── Resolution ───
  const finalRes = p.finalResolution ?? 0.7
  // (fixes 227 → 247) Single-pass scheme: SINGLE canvas = source,
  // ceil32 to latent grid (route sets targetDimensions from ffprobe
  // of source). Integer factor family (fix 227b) preserved invariant
  // 'aspect pass 1 = aspect gen' BETWEEN passes — passes no longer exist,
  // invariant unneeded; canvas matches source within <= 31 px.
  // (fix 431) Multiple of 32, NOT 16: 16x VAE gives W/16 latent — on canvas
  // multiple of only 16, latent is ODD (1680x720 → 105x45), while model pads
  // it to even (106x46). Then post-assembly of combined latent (fix 420)
  // fails on LatentConcat: source encode 105x45 != clips 106x46
  // ('Expected size 46 but got size 45'). With /32 latent is always even.
  // Without targetDimensions (extension without source) — MP path.
  const final = p.targetDimensions
    ? (() => {
        const w = Math.max(32, Math.ceil(p.targetDimensions!.width / 32) * 32)
        const h = Math.max(32, Math.ceil(p.targetDimensions!.height / 32) * 32)
        return { genW: w, genH: h, outW: w, outH: h, cropX: 0, cropY: 0 }
      })()
    : finalDimsFromMegapixels(p.aspectRatio || '16:9 (Widescreen)', finalRes)
  const needsCrop = final.genW !== final.outW || final.genH !== final.outH

  // (fix 423) Two-pass extend (option, default OFF): pass 1 of clips
  // runs on low-res canvas (lowResMP, like 'full' generation pipeline),
  // then each clip is upscaled by LatentUpscaler3D to source size
  // and refined by pass-2 sampler (ManualSigmas sigmaVariant). If
  // upscale factor is below 1.5x, pass 1 runs at final resolution (guard
  // below): LatentUpscaler3D blurs instead of detailing at this scale.
  // When flag disabled behavior is single-pass (fix 247), passW = final.
  // Temporal geometry (tokens/slices/masks) in both passes
  // is IDENTICAL — upscaler only changes spatial axes.
  const twoPass = p.extendTwoPass === true
  const finalMP = (final.genW * final.genH) / (1024 * 1024)
  // (fix 424) Pass 1 canvas must NOT exceed final on ANY axis:
  // MinimaxH3LatentUpscaler3D only supports upscale (effective_scale >= 1.0,
  // otherwise ValueError in node). clampLowResMP has floor max(final, 1.0 MP)
  // (fix 327, for 'Generate' tab) — on small extend source it
  // allowed pass 1 canvas LARGER than source (1312x576 with final ~1280x544)
  // crashing upscaler. We additionally guard against rounding to 32 in
  // selectResolution: reduce MP until both axes fit within final
  // (equality allowed — node does early-return).
  const lowRes = (() => {
    if (!twoPass) return { w: final.genW, h: final.genH }
    const aspect = `${final.genW}:${final.genH}`
    let mp = Math.min(clampLowResMP(p.lowResMP ?? 0.2, finalMP), finalMP)
    let r = selectResolution(aspect, mp)
    let guard = 0
    while ((r.w > final.genW || r.h > final.genH) && guard++ < 20 && mp > 0.05) {
      mp *= 0.8
      r = selectResolution(aspect, mp)
    }
    // (fix 439) Upscale factor below 1.5x is redundant and harmful:
    // generative LatentUpscaler3D trained for large target sizes and at
    // 1.1-1.4x (e.g. 864x480, lowResMP 0.2 → 38x22 latent) adds no detail
    // and blurs latent; 3-step pass 2 cannot recover sharpness →
    // blurry clips and obvious seam with crisp original (clip 0 head also
    // suffers downscale→upscale of tail). Instead pass 1 raised to
    // final canvas: upscaler early-returns (scale 1.0), and pass 2
    // runs as pure detail refinement at full resolution.
    // 1.5x — verified mode (1120x480 → 1680x720); below this upscaler
    // produces blur (seen on 864x480: 1.39x worse than single pass).
    if (final.genW / r.w < 1.5 && final.genH / r.h < 1.5) {
      r = { w: final.genW, h: final.genH }
    }
    return r
  })()
  const passW = lowRes.w
  const passH = lowRes.h
  const sigmaVariant = SIGMA_VARIANTS[p.sigmaVariant || '3step'] || SIGMA_VARIANTS['3step']
  const pass2Sampler = p.pass2Sampler || 'euler'

  // Model chain: UNET → [LowVRAM] → [ChunkFF] → [custom LoRAs, incl. turbo] → SigmaShift → [Sparse] → Attention
  const lowVram = p.lowVramAttention !== false
  const chunkFF = p.chunkFeedForward !== false
  const modelNodes: Record<string, unknown> = {}
  let modelSrc: [string, number] = ['46:30', 0]

  if (lowVram) {
    modelNodes['46:43'] = {
      inputs: { head_chunks: 4, model: modelSrc },
      class_type: 'MiniMaxLowVRAMAttention',
      _meta: { title: 'Low VRAM Attention' },
    }
    modelSrc = ['46:43', 0]
  }
  if (chunkFF) {
    modelNodes['46:40'] = {
      inputs: {
        chunks: Math.max(1, Math.round(p.chunkFFChunks ?? 2)),
        seq_threshold: Math.max(0, Math.round(p.chunkFFThreshold ?? 4096)),
        model: modelSrc,
      },
      class_type: 'MiniMaxChunkFeedForward',
      _meta: { title: 'Chunk FeedForward' },
    }
    modelSrc = ['46:40', 0]
  }

  // (fix 207) Continuation preamble from reference V2V-Extend workflow.
  // Embedded in clips_json for clip 0 so BOTH passes see it:
  // Extender (pass 1) and MiniMaxH3ExtenderPass2 (rebuilds conditioning from
  // clips_json). <Video 1> points to ref_video_1 (source tail).
  const CONTINUATION_PREAMBLE =
    '[Video Continuation] A direct, seamless continuation of <Video 1> ' +
    'starting precisely from its final frame. The camera movement, subject ' +
    'position, clothing, and environment maintain identical continuity ' +
    'without cuts or jumps.\n\n' +
    '[Audio Continuation] The stereo sound design and ambient audio flow ' +
    'seamlessly forward, preserving the exact vocal timbre, speaking rhythm ' +
    'and background track dynamics without interruption or re-triggering. ' +
    'The character continues speaking and moving naturally as the timeline ' +
    'progresses.\n\n' +
    '[Shot 1]\nTarget video is a seamless continuation of <Video 1>. ' +
    'First frame of [Shot 1] is the last frame of <Video 1>.\n\n'

  // (fix 252) Latent-masking chain: geometry helpers.
  // Video latent tokens: T = ((F - 5)/17)*5 + 2 (17k+5 grid);
  // audio steps: round(F * 5/3) (F frames * 40 Hz / 24).
  const tok = (frames: number) => Math.round(((frames - 5) / 17) * 5 + 2)
  const snapUp = (n: number) => {
    let x = Math.max(5, Math.round(n))
    while ((x - 5) % 17 !== 0) x += 1
    return x
  }
  // Clips i>0 overlap (17k+5 grid): preserved latent head.
  // (fix 419) Reference 'V2V Extend Any Video': segment-to-segment overlap
  // = same 2-second context window (56 frames) as source seam.
  const CHAIN_OVERLAP_FRAMES = 56
  // Continuity phrase for clips i>0: last frame
  // of previous clip passed as <Picture N> reference (node ext_lf_i below) —
  // visual anchor for ENTIRE new clip content, not just seam.
  const continuityPhrase = (pic: number) =>
    `Continuity: <Picture ${pic}> is the last frame of the previous shot of this video; ` +
    `continue seamlessly from it and keep characters, faces, clothing, lighting and ` +
    `details consistent with <Picture ${pic}>.`
  // Clip prompt: clip 0 — with continuation preamble (fix 207); clips i>0 —
  // with continuity phrase referencing last frame of previous (picSlot).
  const clipPrompt = (idx: number, picSlot: number) => {
    if (idx === 0) {
      return clips[idx].prompt.includes('[Video Continuation]')
        ? clips[idx].prompt
        : CONTINUATION_PREAMBLE + clips[idx].prompt
    }
    return continuityPhrase(picSlot) + '\n\n' + clips[idx].prompt
  }
  const clipSeed = (idx: number) => (clips[idx].seed < 0 ? seed + idx : clips[idx].seed)
  // Full length of clip idx in frames (17k+5 grid) — same formula as in
  // loop below: needed beforehand for ext_lf (last frame of clip idx).
  const clipTotalFrames = (idx: number) =>
    snapUp((idx === 0 ? tailFrames : CHAIN_OVERLAP_FRAMES) + framesForDuration(clips[idx].duration))

  // Duration for preview frames calculation node (like '17'+'46:19' of
  // 'Generate' tab): use longest clip — preview animated to maximum.
  const maxClipDuration = clips.reduce((m, c) => Math.max(m, c.duration), 0) || 5
  // (fix 419) Source context window = 2 s (56 frames), as in reference
  // 'V2V Extend Any Video (latent masking)' (OVERLAP/CONTEXT node = 2 s).
  // Replacement for rules 202/322 (tail = longest clip / minimum 5 s):
  // with 5-second sources a 5-s window fed ENTIRE clip to model — both into
  // seed and reference — model 're-rendered' source anew instead of
  // extending (replay from frame 0). Reference keeps window short (2 s):
  // seed = last 2 s, remainder model knows only from reference.
  // (fix 254) Clamp to actual source length (ffprobe) with
  // rounding DOWN on 17n+5 grid — see above.
  const tailFrames = (() => {
    const planned = framesForDuration(2)
    const cap =
      p.extendSourceFrames && p.extendSourceFrames >= 5
        ? Math.min(planned, p.extendSourceFrames)
        : planned
    let x = Math.max(5, Math.round(cap))
    while ((x - 5) % 17 !== 0) x -= 1
    return Math.max(5, x)
  })()
  // (fix 251) Joint geometry 'source → clip 0': preserved head
  // of clip 0 duplicates source tail (17 frames — historical Trim 9 +
  // Fade 8 ffmpeg seam; clip 0 written to extclip_0 WITH head,
  // duplication suppressed by client ffmpeg concat). (fix 414, REVERTED by fix 417) trim of clip 0 from tailFrames in combined latent —
  // combine removed.
  const hasSeed = !!p.extendSourceVideo
  // (fix 385, REVERTED by fix 417) Source latent in extend graph
  // (ext_src_lat/ext_src_lsep, slices for combine and clip 0 head) —
  // removed along with entire extend latent pipeline.
  // (fix 416, REVERTED by fix 417) Clip 0 head from slice of
  // pristine latent: freeze/replay was only partially cured
  // (n=1), while combine still replayed; by user decision extend
  // returned to verified mp4 scheme — clip 0 head ALWAYS from
  // pixel encode of tail (extv_ssep, fix 409).

  return {
    // ═══════════════════════════════════════════════
    //  MODEL LOADING
    // ═══════════════════════════════════════════════
    '46:30': {
      inputs: {
        // (fix 293) Default — returned base model
        unet_name: p.diffusionModel || 'minimax_h3_fastvideo_vsa_datafree_1300step_4step_int8_convrot.safetensors',
        weight_dtype: 'default',
      },
      class_type: 'UNETLoader',
      _meta: { title: 'Load Diffusion Model' },
    },
    '46:15': {
      inputs: {
        clip_name: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
        type: 'minimax',
        device: 'default',
      },
      class_type: 'CLIPLoader',
      _meta: { title: 'Load CLIP' },
    },
    '46:3': {
      inputs: { vae_name: 'minimax_h3_video_vae_int8_convrot.safetensors' },
      class_type: 'VAELoader',
      _meta: { title: 'VAE (video)' },
    },
    '46:4': {
      inputs: { vae_name: 'minimax_h3_audio_vae_fp32.safetensors' },
      class_type: 'VAELoader',
      _meta: { title: 'VAE (audio)' },
    },

    // ═══════════════════════════════════════════════
    //  MODEL OPTIMIZATION CHAIN
    // ═══════════════════════════════════════════════
    ...modelNodes,

    ...buildCustomLoraNodes(p.customLoras, modelSrc),

    '46:38': {
      inputs: {
        shift_video: 12,
        shift_audio: 3,
        model: getLastLoraOutput(p.customLoras, modelSrc),
      },
      class_type: 'MiniMaxH3SigmaShift',
      _meta: { title: 'Sigma Shift' },
    },

    // (fix 301) Sparse attention: Veda or Sol-Attn — draft pass
    ...(p.vedaAttention ? {
      '46:44': {
        inputs: {
          // (fix 422) Veda AFTER Attention Backend: both nodes write
          // transformer_options['optimized_attention_override'], Veda
          // composite over current, backend — overwrites. If
          // backend follows Veda, Veda hooks overwritten and non-functional.
          model: ['46:37', 0],
          predictor: 'minimax_h3_t2va_veda_8nfe_600step_preview_fp8.safetensors',
          // (fix 399) node parameters from app settings
          generated_sparsity: clampVedaSparsity(p.vedaGeneratedSparsity, 90),
          reference_sparsity: clampVedaSparsity(p.vedaReferenceSparsity, 90),
          full_attention_layers: sanitizeVedaIndexList(p.vedaFullAttentionLayers),
          full_attention_steps: sanitizeVedaIndexList(p.vedaFullAttentionSteps),
          verbose: p.vedaVerbose === true,
        },
        class_type: 'VedaSparseAttention',
        _meta: { title: 'Veda Sparse Attention' },
      },
    } : p.sparseAttention === true ? { // (fix 387) Sol-Attn OFF by default
      '46:44': {
        inputs: {
          model: ['46:37', 0], // (fix 422) sparse — AFTER Attention Backend, see above
          // (fix 466) Parameters — from Settings → Generation Optimization
          tau: p.sparseTau ?? 1.3,
          start_percent: p.sparseStartPercent ?? 0.2,
          end_percent: p.sparseEndPercent ?? 1.0,
          min_tokens: p.sparseMinTokens ?? 12288,
          extra_tokens: p.sparseExtraTokens ?? 256,
        },
        class_type: 'MiniMaxSparseAttention',
        _meta: { title: 'Sparse Attention (Sol-Attn)' },
      },
    } : {}),

    '46:37': {
      inputs: {
        attention: 'comfy kitchen attention',
        // (fix 422) Backend immediately after SigmaShift; sparse node ('46:44')
        // now follows it — last attention patch before sampler.
        model: ['46:38', 0],
      },
      class_type: 'ModelAttentionBackend',
      _meta: { title: 'Attention Backend' },
    },

    // (fix 252) Clips sampler (pass1 sampler, like main builder)
    '46:18a': {
      inputs: { sampler_name: p.pass1Sampler || 'euler' },
      class_type: 'KSamplerSelect',
      _meta: { title: `KSampler Clips (${p.pass1Sampler || 'euler'})` },
    },

    // (fix 423) Two-pass extend: pass-2 sampler + second preview node
    // (like '46:18'/'13' of main builder). Only with extendTwoPass.
    ...(twoPass && {
      '46:18': {
        inputs: { sampler_name: pass2Sampler },
        class_type: 'KSamplerSelect',
        _meta: { title: `KSampler Clips Pass 2 (${pass2Sampler})` },
      },
      'extpv2': {
        inputs: {
          // (fix 422) chain tail: sparse node if enabled, otherwise backend
          model: (p.vedaAttention || p.sparseAttention === true) ? ['46:44', 0] : ['46:37', 0],
          vae: ['46:3', 0],
          tiny_vae: 'taeh3.safetensors',
          max_resolution: 1024,
          jpeg_quality: 80,
          suppress_default_preview: true,
          preview_frames: ['46:19', 1],
          preview_fps: 6,
        },
        class_type: 'ModelPreviewOverrideKJ',
        _meta: { title: 'Model Preview Override (Pass 2)' },
      },
    }),

    // ═══════════════════════════════════════════════
    //  Preview frames (like '17' + '46:19' of 'Generate' tab)
    // ═══════════════════════════════════════════════
    '17': {
      inputs: { value: maxClipDuration },
      class_type: 'PrimitiveFloat',
      _meta: { title: 'Duration (seconds)' },
    },
    '46:19': {
      inputs: {
        expression: 'max(5, round(a * 24)) + (5 - (max(5, round(a * 24)) % 17)) % 17',
        'values.a': ['17', 0],
      },
      class_type: 'ComfyMathExpression',
      _meta: { title: 'Frames Calculation' },
    },

    // ═══════════════════════════════════════════════
    //  LIVE PREVIEW — settings of node '12' in 'Generate' tab.
    //  IMPORTANT: wrapped model must feed INTO sampler (Extender),
    //  otherwise preview does not trigger.
    // ═══════════════════════════════════════════════
    'extpv': {
      inputs: {
        // (fix 422) chain tail: sparse node if enabled, otherwise backend
        model: (p.vedaAttention || p.sparseAttention === true) ? ['46:44', 0] : ['46:37', 0],
        vae: ['46:3', 0],
        tiny_vae: 'taeh3.safetensors',
        max_resolution: 1024,
        jpeg_quality: 80,
        suppress_default_preview: true,
        preview_frames: ['46:19', 1],
        preview_fps: 6,
      },
      class_type: 'ModelPreviewOverrideKJ',
      _meta: { title: 'Model Preview Override' },
    },

    // ═══════════════════════════════════════════════
    //  SOURCE VIDEO CHAIN — GetVideoComponents outputs:
    //  [0]=images, [1]=audio, [2]=fps.
    //  (fix 202) Extender node (like official MiniMaxH3ReferenceToVideo)
    //  cuts video ref with PREFIX up to clip duration. For EXTENSION we need
    //  end of source: slice last tailFrames frames and provide them —
    //  then node prefix-crop takes exactly tail. ImageFromBatch safely
    //  clamps index/length if source is shorter.
    // ═══════════════════════════════════════════════
    ...((p.extendSourceVideo ? {
      // (fix 211) VHS_LoadVideo instead of LoadVideo: has force_rate.
      // Tail MUST arrive at 24 fps timebase — model trained at 24;
      // source 25/30 fps without normalization produces speed jump at seam
      // (continuation 'slows down') and jitter.
      'extv_load': {
        inputs: {
          video: p.extendSourceVideo,
          force_rate: 24,
          custom_width: 0,
          custom_height: 0,
          frame_load_cap: 0,
          skip_first_frames: 0,
          select_every_nth: 1,
        },
        class_type: 'VHS_LoadVideo',
        _meta: { title: 'Load Video (source, 24 fps)' },
      },
      // Source frame count
      'extv_cnt': {
        inputs: { image: ['extv_load', 0] },
        class_type: 'GetImageSizeAndCount',
        _meta: { title: 'Frames in Source' },
      },
      // Required tail length = frames of longest clip (17n+5 grid)
      'extv_tailn': {
        inputs: { value: tailFrames },
        class_type: 'PrimitiveInt',
        _meta: { title: 'Tail (frames)' },
      },
      // batch_index = max(0, count - tail)
      'extv_tailidx': {
        inputs: {
          expression: 'max(0, a - b)',
          'values.a': ['extv_cnt', 3],
          'values.b': ['extv_tailn', 0],
        },
        class_type: 'ComfyMathExpression',
        _meta: { title: 'Tail Index' },
      },
      // Source TAIL → ref_video_1
      'extv_tail': {
        inputs: {
          image: ['extv_load', 0],
          batch_index: ['extv_tailidx', 1],
          length: tailFrames,
        },
        class_type: 'ImageFromBatch',
        _meta: { title: 'Source Tail' },
      },
      // (fix 205) STRICT binding: tail → resize to pass 1 geometry →
      // VAE-encode (video + audio) → AV latent → seed_latent input
      // of Extender. Clip 1 extends tail LATENT via motion context —
      // multitrackProject semantics (segments chain via latents), not
      // soft Ref2VA feed 'original → empty latent'.
      // (fix 385, REVERTED by fix 417) nodes ext_src_lat/ext_src_lsep
      // (source latent in extend graph) removed along with combine.
      // (fix 409) SEED-TAIL — ALWAYS pixel encode of mp4 tail: same
      // content/characteristics seen by conditioning (ref_video_0 = extv_tail).
      // This is preserved head of clip 0 (extv_ssep below) and audio part
      // of AV seed latent; conditioning is pixel-based and independent of this encode.
      'extv_tres': {
        inputs: {
          image: ['extv_tail', 0],
          // (fix 247) Tail is encoded for Extender canvas = resolution
          // of source (final) — no low-res canvas in single-pass scheme.
          // (fix 423) In two-pass mode — for pass 1 canvas (lowRes):
          // seed latent must spatially match clip latent.
          width: passW,
          height: passH,
          upscale_method: 'lanczos',
          keep_proportion: 'stretch',
          pad_color: '0, 0, 0',
          crop_position: 'center',
          divisible_by: 16,
          device: 'cpu',
        },
        class_type: 'ImageResizeKJv2',
        _meta: { title: `Tail → ${passW}×${passH} (Extender canvas)` },
      },
      // (fix 419) Source reference for conditioning: ENTIRE wedge (batch
      // of frames) fed as ref_image (image) — like in reference
      // 'V2V Extend Any Video': source feeds ref_images.ref_image_0,
      // not ref_videos. Seed (extv_tres/extv_tenc) is then only
      // short 2-s tail: model extends tail, knowing entire wedge from
      // this reference.
      'extv_fres': {
        inputs: {
          image: ['extv_load', 0],
          width: final.genW,
          height: final.genH,
          upscale_method: 'lanczos',
          keep_proportion: 'stretch',
          pad_color: '0, 0, 0',
          crop_position: 'center',
          divisible_by: 16,
          device: 'cpu',
        },
        class_type: 'ImageResizeKJv2',
        _meta: { title: `Source Ref → ${final.genW}×${final.genH} (entire wedge)` },
      },
      'extv_tenc': {
        inputs: {
          pixels: ['extv_tres', 0],
          vae: ['46:3', 0],
        },
        class_type: 'VAEEncode',
        _meta: { title: 'VAE Encode Tail (video)' },
      },
      'extv_asl_seed': {
        inputs: {
          audio: ['extv_load', 2],
          start_seconds: Number((-tailFrames / 24).toFixed(4)),
        },
        class_type: 'MiniMaxH3AudioSliceFrom',
        _meta: { title: `Audio Tail ${Number((tailFrames / 24).toFixed(2))} s` },
      },
      // tail audio encode — part of AV seed latent extv_seed (head
      // of clip 0). (fix 419) no longer fed to conditioning:
      // audio continuation comes from preserved audio latent, as in reference.
      'extv_taenc': {
        inputs: {
          // (fix 221) Audio TAIL of same length as video tail
          // (negative start = from end): full source audio with
          // video tail desynced seed latent (anchor degraded
          // → hallucinations on sources longer than tail).
          audio: ['extv_asl_seed', 0],
          vae: ['46:4', 0],
        },
        class_type: 'VAEEncodeAudio',
        _meta: { title: 'VAE Encode Audio' },
      },
      'extv_seed': {
        inputs: {
          video_latent: ['extv_tenc', 0],
          audio_latent: ['extv_taenc', 0],
        },
        class_type: 'LTXVConcatAVLatent',
        _meta: { title: 'Tail AV Latent (seed)' },
      },

      // ─── (fix 420) SOURCE LATENT FOR POST-ASSEMBLY OF FINAL RESULT ───
      // NOT fed into generation (seed is pixel tail above, fixes
      // 409/419): this latent is only needed AFTER samplers to assemble
      // combined latent of concat timeline for lossless refine. If file exists
      // (route resolver, pristine) — load it; otherwise single VAE encode
      // of entire wedge (extv_fres already adjusted to canvas).
      ...(p.extendSourceLatentFile ? {
        'ext_srcload': {
          inputs: { latent: p.extendSourceLatentFile },
          class_type: 'MiniMaxStudioLoadAVLatent',
          _meta: { title: 'Source Latent (pristine)' },
        },
        'ext_srclsep': {
          inputs: { av_latent: ['ext_srcload', 0] },
          class_type: 'LTXVSeparateAVLatent',
          _meta: { title: 'Source Latent Separation' },
        },
      } : {
        'extv_fenc': {
          inputs: {
            pixels: ['extv_fres', 0],
            vae: ['46:3', 0],
          },
          class_type: 'VAEEncode',
          _meta: { title: 'VAE Encode Full Source (post-assembly)' },
        },
        'extv_aful': {
          inputs: {
            audio: ['extv_load', 2],
            vae: ['46:4', 0],
          },
          class_type: 'VAEEncodeAudio',
          _meta: { title: 'VAE Encode Full Source Audio' },
        },
      }),
    } : {})),

    // ═══════════════════════════════════════════════
    //  (fix 252) LATENT-MASKING CLIPS CHAIN
    //  Per reference 'V2V Extend Any Video (latent masking)':
    //  clip latent = [preserved tail (mask 0 — sampler leaves untouched)]
    //  + [new section (mask 1 — generation)]; LatentCut/Concat on grid
    //  tokens; SetLatentNoiseMask; one sampler per clip; unified decode.
    //  Clip 0: preserved head = encoded source tail
    //  (extv_seed; pixel VAE-encode, fix 409 — single scheme
    //  after revert 417).
    //  Clip i>0: preserved head = tail of sampler OUTPUT from clip i-1.
    //  Each clip is decoded SEPARATELY into its own file extclip_<i>
    //  (fix 417): clip i>0 — with 22-frame head sliced in workflow,
    //  clip 0 — with head-tail, its 17-frame duplication suppressed
    //  by client ffmpeg concat (Trim 9 + xfade 8).
    // ═══════════════════════════════════════════════
    ...(hasSeed && {
      'extv_ssep': {
        inputs: { av_latent: ['extv_seed', 0] },
        class_type: 'LTXVSeparateAVLatent',
        _meta: { title: 'Tail Latent Separation' },
      },
    }),
    ...(() => {
      const nodes: Record<string, unknown> = {}
      // (fix 423) Spatial size of pass 1 canvas latent
      // (single pass mode: passW = final.genW) — pass 1 video mask
      // removed (keyframes + lock), only
      // pass 2 geometry remains (lw2/lh2 below).
      // (fix 423) Two-pass: pass 2 masks in final geometry.
      const lw2 = Math.max(1, Math.round(final.genW / 16))
      const lh2 = Math.max(1, Math.round(final.genH / 16))
      // Audio lengths of clips (aTotal per index) — for keyframe audio context
      // of clip i+1 (sound available in clip i before overlap).
      const audioTotals: number[] = []

      // (fix 266) Image refs: LoadImage nodes + binding to EACH
      // ext_cond_i via ref_images.ref_image_N (as in 'ref' mode).
      // Without this user-uploaded refs were NOT applied to clips.
      const extRefCount = Math.min(p.refImages.length, 9)
      const extRefLinks: Record<string, unknown> = {}
      for (let ri = 0; ri < extRefCount; ri++) {
        const loadId = REF_IMAGE_NODE_IDS[ri]
        nodes[loadId] = {
          inputs: { image: p.refImages[ri] },
          class_type: 'LoadImage',
          _meta: { title: `Reference ${ri + 1}` },
        }
        extRefLinks[`ref_images.ref_image_${ri}`] = [loadId, 0]
      }

      // (fix 325, refined by fix 434) Fix 324 (v2v tail run)
      // REVERTED by user decision: instead of latent experiments
      // duration of extend clips bounded below (UI clamp 3 s, was
      // 5 s — with 5-second clips joint 'source → clip 0' is stably
      // clean, verified by user on same scene).
      // Clip 0 takes encoded tail (extv_ssep).
      for (let i = 0; i < clips.length; i++) {
        const clipFrames = framesForDuration(clips[i].duration)
        const overlapFrames = i === 0 ? tailFrames : CHAIN_OVERLAP_FRAMES
        const totalFrames = i === 0 ? snapUp(overlapFrames + clipFrames) : snapUp(CHAIN_OVERLAP_FRAMES + clipFrames)
        const oTok = tok(overlapFrames)
        const tTok = tok(totalFrames)
        const aOver = Math.round((overlapFrames * 5) / 3)
        const aTotal = Math.round((totalFrames * 5) / 3)
        // Audio track length of previous clip (for keyframe audio context).
        // Clip 0: source tail (audio encoded for exactly tailFrames).
        const prevATotal = i === 0 ? Math.round((tailFrames * 5) / 3) : audioTotals[i - 1]
        audioTotals.push(aTotal)

        // Clip conditioning + empty latent totalFrames
        // (fix 423) Conditioning/empty latent dimensions — pass 1 canvas
        // (in single-pass mode passW = final.genW). Pass 2 reuses
        // same conditioning — as in main builder (conditioning
        // built on lowRes and feeds both passes).
        // Clips i>0 additionally receive LAST
        // FRAME of clip i-1 as <Picture> reference (ext_lf_i): visual
        // anchor for new content — previously clip i>0 had no visual
        // anchor whatsoever, and content generated blindly
        // (ghosting/doubling accumulating across chain).
        if (i > 0 && extRefCount + 1 < 9) {
          nodes[`ext_lf_${i}`] = {
            inputs: {
              images: [`ext_decv_${i - 1}`, 0],
              start_index: clipTotalFrames(i - 1) - 1,
              num_frames: 1,
            },
            class_type: 'GetImageRangeFromBatch',
            _meta: { title: `Last Frame of Clip ${i} (anchor <Picture>)` },
          }
        }
        nodes[`ext_cond_${i}`] = {
          inputs: {
            prompt: clipPrompt(i, extRefCount + 2),
            width: passW,
            height: passH,
            length: totalFrames,
            ref_image_size: p.refImageSize || 'match',
            clip: ['46:15', 0],
            vae: ['46:3', 0],
            audio_vae: ['46:4', 0],
            ...(Object.keys(extRefLinks).length > 0 ? extRefLinks : {}),
            // (fix 419) Source — as ref_image (frame batch of whole
            // wedge, reference V2V Extend), in slot AFTER user images.
            // ref_videos/ref_video_audios deprecated: audio continuation
            // comes from preserved audio latent.
            ...(hasSeed && extRefCount < 9 && {
              [`ref_images.ref_image_${extRefCount}`]: ['extv_fres', 0],
            }),
            // last frame of clip i-1 — slot after
            // source tail; referenced by continuity phrase.
            ...(i > 0 && extRefCount + 1 < 9 && {
              [`ref_images.ref_image_${extRefCount + 1}`]: [`ext_lf_${i}`, 0],
            }),
          },
          class_type: 'MiniMaxH3ReferenceToVideo',
          _meta: { title: `Conditioning Clip ${i + 1} (${totalFrames} frames)` },
        }
        nodes[`ext_empty_${i}`] = {
          inputs: { width: passW, height: passH, length: totalFrames },
          class_type: 'EmptyMiniMaxH3LatentAV',
          _meta: { title: `Empty AV Latent Clip ${i + 1}` },
        }
        nodes[`ext_esep_${i}`] = {
          inputs: { av_latent: [`ext_empty_${i}`, 0] },
          class_type: 'LTXVSeparateAVLatent',
          _meta: { title: `Separate Empty Latent ${i + 1}` },
        }
        // Previous output: clip 0 — source tail; i>0 — sampler output of i-1.
        // Without source clip 0 has no preserved head — pure generation.
        const useOld = i > 0 || hasSeed
        // (fix 416, REVERTED by fix 417) Clip 0 head from slice of
        // pristine latent removed with extend latent pipeline:
        // clip 0 head ALWAYS from pixel encode of tail (extv_ssep,
        // fix 409).
        // (fix 426) Two-pass mode: preserved head of clip i binds to
        // FINAL (pass-2) output of clip i-1, not low-res draft.
        // Otherwise clip i extends 'another version': pass 2 refines and
        // changes tail of clip i-1, while final goes to file; joint i-1→i
        // is hard in seam (fade=0) — divergence visible as jump.
        // Scheme = like source seam (fix 409, clean): tail
        // of already decoded final clip i-1 (ext_decv) → resize to pass 1
        // canvas → VAE-encode → seed latent. Audio — tail slice from
        // decoded final (ext_deca) → VAE-encode. Mask geometry
        // (oTok/aOver) unchanged: encode exactly CHAIN_OVERLAP_FRAMES frames.
        let prevVideo: [string, number] = i === 0 ? ['extv_ssep', 0] : [`ext_ssep_${i - 1}`, 0]
        let prevAudio: [string, number] = i === 0 ? ['extv_ssep', 1] : [`ext_ssep_${i - 1}`, 1]
        if (twoPass && i > 0) {
          const prevCf = framesForDuration(clips[i - 1].duration)
          const prevTotal = (i - 1) === 0
            ? snapUp(tailFrames + prevCf)
            : snapUp(CHAIN_OVERLAP_FRAMES + prevCf)
          const aTailSec = Number((CHAIN_OVERLAP_FRAMES / 24).toFixed(4))
          Object.assign(nodes, {
            [`ext_p2tail_${i}`]: {
              inputs: {
                images: [`ext_decv_${i - 1}`, 0],
                start_index: prevTotal - CHAIN_OVERLAP_FRAMES,
                num_frames: CHAIN_OVERLAP_FRAMES,
              },
              class_type: 'GetImageRangeFromBatch',
              _meta: { title: `Final Tail of Clip ${i} (${CHAIN_OVERLAP_FRAMES} frames)` },
            },
            [`ext_p2res_${i}`]: {
              inputs: {
                image: [`ext_p2tail_${i}`, 0],
                width: passW,
                height: passH,
                upscale_method: 'lanczos',
                keep_proportion: 'stretch',
                pad_color: '0, 0, 0',
                crop_position: 'center',
                divisible_by: 16,
                device: 'cpu',
              },
              class_type: 'ImageResizeKJv2',
              _meta: { title: `Final Tail ${i} → ${passW}x${passH} (pass 1 canvas)` },
            },
            [`ext_p2venc_${i}`]: {
              inputs: { pixels: [`ext_p2res_${i}`, 0], vae: ['46:3', 0] },
              class_type: 'VAEEncode',
              _meta: { title: `VAE Encode Final Tail ${i} (video)` },
            },
            [`ext_p2asl_${i}`]: {
              inputs: { audio: [`ext_deca_${i - 1}`, 0], start_seconds: -aTailSec },
              class_type: 'MiniMaxH3AudioSliceFrom',
              _meta: { title: `Audio Tail of Final Clip ${i} (${aTailSec} s)` },
            },
            [`ext_p2aenc_${i}`]: {
              inputs: { audio: [`ext_p2asl_${i}`, 0], vae: ['46:4', 0] },
              class_type: 'VAEEncodeAudio',
              _meta: { title: `VAE Encode Final Audio Tail ${i}` },
            },
          })
          prevVideo = [`ext_p2venc_${i}`, 0]
          prevAudio = [`ext_p2aenc_${i}`, 0]
        }

        // Tail is anchored via TWO mechanisms instead of
        // video SetLatentNoiseMask (only kept tokens in sampler
        // trajectory — DiT saw no context and generated new
        // content blindly, causing ghosting on clips 2+):
        //   1. ext_kf_i — tail into conditioning via minimax_keyframes channel:
        //      PackedLayout packs it as cond strings (img_update=0), model
        //      sees clean tail on each step. Audio — with context BEFORE
        //      overlap (model hears continuation rather than noise).
        //   2. ext_lock_i — model wrapper: x0 prediction in locked
        //      positions forced = clean tail latent (drift
        //      physically impossible). KJ preview does not conflict:
        //      OUTER_SAMPLE wrapper, lock on function wrapper.
        // Audio mask (ext_amask/ext_aset below) REMAINS: core converts
        // it to audio_denoise_mask conds — model knows clean timestep.
        // Video: past tail + empty, trim to total tokens.
        if (useOld) {
          // Keyframe audio context: audio before overlap (<=1 s, multiple of 5),
          // ends at overlap boundary; frame index negative
          // (5 audio steps = 3 pixel frames, FRAME_RESCALE 5/3).
          const audioCtx = Math.max(0, Math.min(40, prevATotal - aOver))
          const audioCtx5 = Math.floor(audioCtx / 5) * 5
          nodes[`ext_actx_${i}`] = {
            inputs: {
              samples: prevAudio,
              dim: 'x',
              index: -(aOver + audioCtx5),
              amount: aOver + audioCtx5,
            },
            class_type: 'LatentCut',
            _meta: { title: `Audio Context Clip ${i + 1}: overlap ${aOver} + ${audioCtx5} steps before it` },
          }
          nodes[`ext_vold_${i}`] = {
            inputs: { samples: prevVideo, dim: 't', index: -oTok, amount: oTok },
            class_type: 'LatentCut',
            _meta: { title: `Previous Tail (video) ${i + 1}: ${oTok} tok.` },
          }
          nodes[`ext_vcat_${i}`] = {
            inputs: { samples1: [`ext_vold_${i}`, 0], samples2: [`ext_esep_${i}`, 0], dim: 't' },
            class_type: 'LatentConcat',
            _meta: { title: `Concat Video ${i + 1}` },
          }
          nodes[`ext_aold_${i}`] = {
            inputs: { samples: prevAudio, dim: 'x', index: -aOver, amount: aOver },
            class_type: 'LatentCut',
            _meta: { title: `Previous Tail (audio) ${i + 1}: ${aOver}` },
          }
          // Tail of clip i in conditioning (native H3 keyframe channel).
          nodes[`ext_kf_${i}`] = {
            inputs: {
              conditioning: [`ext_cond_${i}`, 0],
              video_latent: [`ext_vold_${i}`, 0],
              video_frame: 0,
              audio_latent: [`ext_actx_${i}`, 0],
              audio_frame: -Math.floor((audioCtx5 * 3) / 5),
            },
            class_type: 'MiniMaxStudioExtendKeyframes',
            _meta: { title: `Tail Keyframe Anchor Clip ${i + 1}` },
          }
          // Hard overlap lock (overwrite x0 prediction).
          // Lock tensors — FULL clip init latents (tail at start,
          // zeros with 0 weight later), lock = video with
          // inscribed tail): sizes match model output.
          nodes[`ext_lock_${i}`] = {
            inputs: {
              model: ['extpv', 0],
              lock_video: [`ext_vtrim_${i}`, 0],
              video_tokens_locked: oTok,
              video_tokens_total: tTok,
              lock_audio: [`ext_atrim_${i}`, 0],
              audio_steps_locked: aOver,
              audio_steps_total: aTotal,
            },
            class_type: 'MiniMaxStudioLatentLock',
            _meta: { title: `Overlap Lock Clip ${i + 1} (${oTok} tok. video / ${aOver} audio)` },
          }
        }
        nodes[`ext_vtrim_${i}`] = {
          inputs: {
            samples: useOld ? [`ext_vcat_${i}`, 0] : [`ext_esep_${i}`, 0],
            dim: 't',
            index: 0,
            amount: tTok,
          },
          class_type: 'LatentCut',
          _meta: { title: `Trim Video ${i + 1} → ${tTok} tok.` },
        }

        // Audio: same pattern along x (audio steps = frames * 5/3).
        // ext_aold_i declared above (useOld block) — also lock input.
        if (useOld) Object.assign(nodes, {
          [`ext_acat_${i}`]: {
            inputs: { samples1: [`ext_aold_${i}`, 0], samples2: [`ext_esep_${i}`, 1], dim: 'x' },
            class_type: 'LatentConcat',
            _meta: { title: `Concat Audio ${i + 1}` },
          },
          // (fix 254) Audio mask: canvas = BLACK for full aTotal width,
          // white (aTotal - aOver) pasted at offset x = aOver —
          // MaskComposite does not expand canvas; at x=0 white overwrote
          // black portion losing audio tail completely.
          [`ext_amb_${i}`]: {
            // (fix 324) Canvas is black again: audio tail of clip 0 is now
            // model-consistent (encoded tail), no softening needed.
            inputs: { value: 0, width: aTotal, height: 2 },
            class_type: 'SolidMask',
            _meta: { title: `Audio Mask: black canvas ${aTotal}` },
          },
          [`ext_amw_${i}`]: {
            inputs: { value: 1, width: aTotal - aOver, height: 2 },
            class_type: 'SolidMask',
            _meta: { title: `Audio Mask: white ${aTotal - aOver}` },
          },
          [`ext_amask_${i}`]: {
            inputs: {
              destination: [`ext_amb_${i}`, 0],
              source: [`ext_amw_${i}`, 0],
              x: aOver,
              y: 0,
              operation: 'add',
            },
            class_type: 'MaskComposite',
            _meta: { title: `Audio Mask ${i + 1}: ${aOver} black + ${aTotal - aOver} white` },
          },
          [`ext_aset_${i}`]: {
            inputs: { samples: [`ext_atrim_${i}`, 0], mask: [`ext_amask_${i}`, 0] },
            class_type: 'SetLatentNoiseMask',
            _meta: { title: `Noise Mask Audio ${i + 1}` },
          },
        })
        nodes[`ext_atrim_${i}`] = {
          inputs: {
            samples: useOld ? [`ext_acat_${i}`, 0] : [`ext_esep_${i}`, 1],
            dim: 'x',
            index: 0,
            amount: aTotal,
          },
          class_type: 'LatentCut',
          _meta: { title: `Trim Audio ${i + 1} → ${aTotal}` },
        }

        // Clip AV latent + sampler (full schedule — generation from scratch).
        // Video without SetLatentNoiseMask (anchor — keyframes
        // in conditioning + hard lock via ext_lock_i), audio — with
        // own mask: LTXVConcatAVLatent assembles NestedTensor mask
        // (video = ones, audio = amask) — this exact scheme.
        nodes[`ext_join_${i}`] = {
          inputs: {
            video_latent: [`ext_vtrim_${i}`, 0],
            audio_latent: useOld ? [`ext_aset_${i}`, 0] : [`ext_atrim_${i}`, 0],
          },
          class_type: 'LTXVConcatAVLatent',
          _meta: { title: `AV Latent Clip ${i + 1}` },
        }
        nodes[`ext_sched_${i}`] = {
          inputs: {
            scheduler: p.pass1Scheduler || 'simple',
            // (fix 719) Clip steps — separate field (extendClipSteps),
            // NOT a generation split point: Extend has no split.
            steps: p.extendClipSteps ?? p.firstSamplerSteps ?? 4,
            // (fix 291) denoise=1 + SetLatentNoiseMask (fix 252) — reference
            // scheme from V2V Extend Any Video: noise added only in mask zone
            // (white = new content), mask=0 zone (black = tail of previous
            // clip/source) restored from input latent WITHOUT
            // re-noising. With denoise<1 mask=0 zone shifts slightly,
            // but does NOT solve repetition at start of clip with 3+
            // clips — caused by error accumulation in chain ext_ssep_{i-1}
            // (sampler i-1 output → sampler i input) and tail i-1
            // already containing recomputed tail i-2, etc.
            // Keep denoise=1 (as in reference) — slice of preserved head
            // (fix 252) removes duplication from clip i file, and
            // SetLatentNoiseMask guarantees mask=0 zone is untouched.
            denoise: 1,
            model: ['46:30', 0],
          },
          class_type: 'BasicScheduler',
          _meta: { title: `Scheduler Clip ${i + 1}` },
        }
        nodes[`ext_g_${i}`] = {
          // model — through lock wrapper (ext_lock_i,
          // over KJ-preview extpv), conditioning — via keyframe anchor
          // (ext_kf_i attaches minimax_keyframes to ext_cond_i).
          inputs: {
            model: useOld ? [`ext_lock_${i}`, 0] : ['extpv', 0],
            conditioning: useOld ? [`ext_kf_${i}`, 0] : [`ext_cond_${i}`, 0],
          },
          class_type: 'BasicGuider',
          _meta: { title: `Guider Clip ${i + 1}` },
        }
        nodes[`ext_samp_${i}`] = {
          inputs: {
            noise: [`ext_noise_${i}`, 0],
            guider: [`ext_g_${i}`, 0],
            sampler: ['46:18a', 0],
            sigmas: [`ext_sched_${i}`, 0],
            latent_image: [`ext_join_${i}`, 0],
          },
          class_type: 'SamplerCustomAdvanced',
          _meta: { title: `Sampler Clip ${i + 1} (latent masking)` },
        }
        nodes[`ext_noise_${i}`] = {
          inputs: { noise_seed: clipSeed(i) },
          class_type: 'RandomNoise',
          _meta: { title: `Noise Clip ${i + 1}` },
        }
        nodes[`ext_ssep_${i}`] = {
          inputs: { av_latent: [`ext_samp_${i}`, 0] },
          class_type: 'LTXVSeparateAVLatent',
          _meta: { title: `Separate Output ${i + 1}` },
        }

        // ─── (fix 423) PASS 2 of clip: upscale to final + refine ───
        // Upscaler changes space only — temporal geometry
        // (oTok/tTok/aOver/aTotal, slices) identical in both passes.
        // Preserved head already INSIDE ext_ssep_i latent: upscales along
        // with clip, protected by mask rebuilt for final geometry
        // (LatentCut/Concat pass 2 unneeded — latent already full length).
        // Audio has no space — passthrough with same audio mask
        // (ext_amask_i independent of resolution).
        if (twoPass) {
          nodes[`ext_ups_${i}`] = {
            inputs: {
              model_name: 'minimax_h3_latent_upscaler_3d_fp16.safetensors',
              mode: 'target dimensions',
              'mode.width': final.genW,
              'mode.height': final.genH,
              // align 16 sufficient: target (final canvas) multiple of 32 (fix
              // 431) — upscaler output gets even latent
              align: 16,
              enable_chunking: true,
              enable_temporal_chunking: true,
              force_unload: true,
              device: 'cuda',
              precision: 'fp16',
              latent: [`ext_ssep_${i}`, 0],
            },
            class_type: 'MinimaxH3LatentUpscaler3D',
            _meta: { title: `Upscale Clip ${i + 1} → ${final.genW}x${final.genH}` },
          }
          if (useOld) Object.assign(nodes, {
            [`ext_mb2_${i}`]: {
              inputs: { width: lw2, height: lh2, batch_size: oTok, color: 0 },
              class_type: 'EmptyImage',
              _meta: { title: `Mask Pass 2: black ${oTok}` },
            },
            [`ext_mw2_${i}`]: {
              inputs: { width: lw2, height: lh2, batch_size: tTok - oTok, color: 16777215 },
              class_type: 'EmptyImage',
              _meta: { title: `Mask Pass 2: white ${tTok - oTok}` },
            },
            [`ext_mbat2_${i}`]: {
              inputs: { inputcount: 2, image_1: [`ext_mb2_${i}`, 0], image_2: [`ext_mw2_${i}`, 0] },
              class_type: 'ImageBatchMulti',
              _meta: { title: `Video Mask ${i + 1} (pass 2)` },
            },
            [`ext_vmask2_${i}`]: {
              inputs: { image: [`ext_mbat2_${i}`, 0], channel: 'red' },
              class_type: 'ImageToMask',
              _meta: { title: `ImageToMask ${i + 1} (pass 2)` },
            },
            [`ext_vset2_${i}`]: {
              inputs: { samples: [`ext_ups_${i}`, 0], mask: [`ext_vmask2_${i}`, 0] },
              class_type: 'SetLatentNoiseMask',
              _meta: { title: `Noise Mask Video ${i + 1} (pass 2)` },
            },
            [`ext_aset2_${i}`]: {
              inputs: { samples: [`ext_ssep_${i}`, 1], mask: [`ext_amask_${i}`, 0] },
              class_type: 'SetLatentNoiseMask',
              _meta: { title: `Noise Mask Audio ${i + 1} (pass 2)` },
            },
          })
          nodes[`ext_join2_${i}`] = {
            inputs: {
              video_latent: useOld ? [`ext_vset2_${i}`, 0] : [`ext_ups_${i}`, 0],
              audio_latent: useOld ? [`ext_aset2_${i}`, 0] : [`ext_ssep_${i}`, 1],
            },
            class_type: 'LTXVConcatAVLatent',
            _meta: { title: `AV Latent Clip ${i + 1} (pass 2)` },
          }
          nodes[`ext_sig2_${i}`] = {
            inputs: { sigmas: sigmaVariant },
            class_type: 'ManualSigmas',
            _meta: { title: `Pass 2 Sigmas Clip ${i + 1} (${p.sigmaVariant || '3step'})` },
          }
          nodes[`ext_g2_${i}`] = {
            inputs: { model: ['extpv2', 0], conditioning: [`ext_cond_${i}`, 0] },
            class_type: 'BasicGuider',
            _meta: { title: `Guider Clip ${i + 1} (pass 2)` },
          }
          nodes[`ext_samp2_${i}`] = {
            inputs: {
              noise: [`ext_noise_${i}`, 0],
              guider: [`ext_g2_${i}`, 0],
              sampler: ['46:18', 0],
              sigmas: [`ext_sig2_${i}`, 0],
              latent_image: [`ext_join2_${i}`, 0],
            },
            class_type: 'SamplerCustomAdvanced',
            _meta: { title: `Sampler Clip ${i + 1} (pass 2, refine)` },
          }
          nodes[`ext_ssep2_${i}`] = {
            inputs: { av_latent: [`ext_samp2_${i}`, 0] },
            class_type: 'LTXVSeparateAVLatent',
            _meta: { title: `Separate Output ${i + 1} (pass 2)` },
          }
        }
        // (fix 423) Downstream source (decode/post-assembly): pass 2,
        // if present, otherwise pass 1.
        const outSep = twoPass ? `ext_ssep2_${i}` : `ext_ssep_${i}`

        // ─── (fix 417) Clip output — EACH clip into OWN file ───
        // Revert fix 384: combined latent and single output removed
        // (extend latent pipeline replayed source / froze end —
        // see buildExtendWorkflow header). Each clip decoded
        // separately → Minimax_Studio_extclip_<i> → client ffmpeg concat
        // (/api/comfy/concat). Clip 0 written WITH preserved head (source
        // tail): its 17-frame duplication suppressed by concat
        // (sourceTrim 9/24 + seamFade 8/24, fix 251). Clip i>0 —
        // with 22-frame head sliced here, hard joint (fade=0).
        // (fix 418) Slice of clip 0 head to 17 frames: fix 417
        // rebuilt this block losing slice — clip 0 file carried ENTIRE
        // source tail, concat showed 'source, source again,
        // then continuation'. Restored from pre-383 code (ext_sl_0/
        // ext_asl_0 with start = sliceStart = tailFrames - 17).
        {
          // (fixes 216/251) sliceStart — 17 frames before tail end;
          // tail on 17n+5 grid → slice on grid too. Clamp for
          // degenerately short sources (< 22 frames).
          const sliceStart = Math.max(0, tailFrames - 17)
          nodes[`ext_decv_${i}`] = {
            inputs: { samples: [outSep, 0], vae: ['46:3', 0] },
            class_type: 'VAEDecode',
            _meta: { title: `Decode Video (Clip ${i + 1})` },
          }
          // Clip 0 (with source): 'tail+continuation' window, slice 17
          // frames before tail end — seam on overlap. Clips i>0: slice
          // ENTIRE preserved head — clip file = pure new content.
          if (i === 0 && hasSeed) {
            nodes['ext_sl_0'] = {
              inputs: { images: ['ext_decv_0', 0], start_index: sliceStart, num_frames: 4096 },
              class_type: 'GetImageRangeFromBatch',
              _meta: { title: `Window Slice: from ${sliceStart} (17-frame seam)` },
            }
          } else if (i > 0) {
            nodes[`ext_sl_${i}`] = {
              inputs: { images: [`ext_decv_${i}`, 0], start_index: overlapFrames, num_frames: 4096 },
              class_type: 'GetImageRangeFromBatch',
              _meta: { title: `Preserved Head Slice (${overlapFrames} frames)` },
            }
          }
          let clipFramesSrc = i === 0 && hasSeed ? 'ext_sl_0' : i > 0 ? `ext_sl_${i}` : `ext_decv_${i}`
          if (needsCrop) {
            nodes[`ext_crop_${i}`] = {
              inputs: {
                image: [clipFramesSrc, 0],
                width: final.outW,
                height: final.outH,
                x: final.cropX,
                y: final.cropY,
              },
              class_type: 'ImageCrop',
              _meta: { title: `Exact Crop Clip ${i + 1} → ${final.outW}x${final.outH}` },
            }
          }
          const clipToneSrc = needsCrop ? `ext_crop_${i}` : clipFramesSrc

          // Clip audio + head slice at same moment
          nodes[`ext_deca_${i}`] = {
            inputs: { samples: [outSep, 1], vae: ['46:4', 0] },
            class_type: 'VAEDecodeAudio',
            _meta: { title: `Decode Audio (Clip ${i + 1})` },
          }
          let clipAudioSrc = `ext_deca_${i}`
          // (fix 418) Clip 0 audio — slice at same moment as video:
          // from sliceStart (17-frame seam), synchronous with ext_sl_0.
          if (i === 0 && hasSeed) {
            nodes['ext_asl_0'] = {
              inputs: { audio: ['ext_deca_0', 0], start_seconds: Number((sliceStart / 24).toFixed(4)) },
              class_type: 'MiniMaxH3AudioSliceFrom',
              _meta: { title: `Clip Audio: from ${(sliceStart / 24).toFixed(2)} s (seam)` },
            }
            clipAudioSrc = 'ext_asl_0'
          } else if (i > 0) {
            nodes[`ext_asl_${i}`] = {
              inputs: { audio: [`ext_deca_${i}`, 0], start_seconds: Number((overlapFrames / 24).toFixed(4)) },
              class_type: 'MiniMaxH3AudioSliceFrom',
              _meta: { title: `Clip Audio: from ${(overlapFrames / 24).toFixed(2)} s` },
            }
            clipAudioSrc = `ext_asl_${i}`
          }

          // Save clip
          nodes[`ext_out_${i}`] = {
            inputs: {
              frame_rate: 24,
              loop_count: 0,
              filename_prefix: p.outputSubfolder
                ? `${p.outputSubfolder}/Minimax_Studio_extclip_${i}`
                : `Minimax_Studio_extclip_${i}`,
              // (fix 386) format/quality — from studio [video] settings
              ...vhsEnc,
              save_metadata: false,
              pingpong: false,
              save_output: true,
              images: [clipToneSrc, 0],
              audio: [clipAudioSrc, 0],
            },
            class_type: 'VHS_VideoCombine',
            _meta: { title: `Video Combine Clip ${i + 1}` },
          }
        }
      }
      return nodes
    })(),

    // ═══════════════════════════════════════════════
    //  (fixes 383/384/385/414/416 — REVERTED by fix 417)
    //  EXTEND COMBINED LATENT REMOVED.
    // ═══════════════════════════════════════════════
    // Extend latent combine was here: source slices (extcf_v/extcf_a,
    // incl. from pristine latent ext_src_lsep), clip slices
    // (extcc_*), concat chain (extcj_*, ext_comb), SaveAVLatent (46:49),
    // segment decode (ext_csep/ext_seg_*/ext_sdec_*/ext_strim_*/ext_sbatch)
    // and single output Minimax_Studio_combined (ext_cout). Reverted
    // by user decision after tests: with pixel head (409) model
    // replayed source from frame 0, with latent head (416) — froze
    // end; segment decode with overlap (411) produced seam pops.
    // Extend back to verified scheme: clips decoded separately
    // to extclip_<i>.mp4 and concatenated via ffmpeg (/api/comfy/concat).
    // Latent pipeline remains in generate/refine/tile-upscale.
    //
    // ═══════════════════════════════════════════════
    //  (fix 420) POST-ASSEMBLY OF COMBINED LATENT (without model)
    // ═══════════════════════════════════════════════
    // Difference from reverted combine 383-416: latent is NOT fed into
    // sampler — assembled AFTER generation with clean slices/concats and
    // written to file for lossless refine/tile upscale of result.
    // Timeline = exact timeline of ffmpeg concat (seam overlap 17 frames
    // consumed by Trim 9 + xfade 8; clips i>0 — slice head 56):
    //   src[:F−17] ⊕ clip0[from tailFrames-17] ⊕ clips i>0[from frame 56]
    // Real-run verification: mp4 260 frames = 107+153 ok.
    ...((hasSeed && clips.length >= 1) ? (() => {
      const nodes: Record<string, unknown> = {}
      const srcF = Math.max(5, p.extendSourceFrames ?? tailFrames)
      const srcCutTok = tok(Math.max(5, srcF - 17))
      const srcCutA = Math.round((Math.max(5, srcF - 17) * 5) / 3)
      const srcV: [string, number] = p.extendSourceLatentFile ? ['ext_srclsep', 0] : ['extv_fenc', 0]
      const srcA: [string, number] = p.extendSourceLatentFile ? ['ext_srclsep', 1] : ['extv_aful', 0]

      // Clip pieces: clip 0 — from seam slice (sliceStart), i>0 — from head 56
      const clipCut = (i: number) =>
        i === 0 ? Math.max(0, tailFrames - 17) : CHAIN_OVERLAP_FRAMES
      const clipCutTok = (i: number) => tok(clipCut(i))
      const clipCutA = (i: number) => Math.round((clipCut(i) * 5) / 3)

      nodes['ext_ljsrc_v'] = {
        inputs: { samples: srcV, dim: 't', index: 0, amount: srcCutTok },
        class_type: 'LatentCut',
        _meta: { title: `Result: source[:${srcF - 17}] (video)` },
      }
      nodes['ext_ljsrc_a'] = {
        inputs: { samples: srcA, dim: 'x', index: 0, amount: srcCutA },
        class_type: 'LatentCut',
        _meta: { title: `Result: source[:${srcF - 17}] (audio)` },
      }
      let vCur = 'ext_ljsrc_v'
      let aCur = 'ext_ljsrc_a'
      for (let i = 0; i < clips.length; i++) {
        const cTok = clipCutTok(i)
        const cA = clipCutA(i)
        nodes[`ext_ljc_v_${i}`] = {
          inputs: { samples: [twoPass ? `ext_ssep2_${i}` : `ext_ssep_${i}`, 0], dim: 't', index: cTok, amount: 4096 },
          class_type: 'LatentCut',
          _meta: { title: `Result: clip ${i + 1}[from frame ${clipCut(i)}] (video)` },
        }
        nodes[`ext_ljc_a_${i}`] = {
          inputs: { samples: [twoPass ? `ext_ssep2_${i}` : `ext_ssep_${i}`, 1], dim: 'x', index: cA, amount: 4096 },
          class_type: 'LatentCut',
          _meta: { title: `Result: clip ${i + 1} (audio)` },
        }
        nodes[`ext_lj_v_${i}`] = {
          inputs: { samples1: [vCur, 0], samples2: [`ext_ljc_v_${i}`, 0], dim: 't' },
          class_type: 'LatentConcat',
          _meta: { title: `Result: concat video ← clip ${i + 1}` },
        }
        nodes[`ext_lj_a_${i}`] = {
          inputs: { samples1: [aCur, 0], samples2: [`ext_ljc_a_${i}`, 0], dim: 'x' },
          class_type: 'LatentConcat',
          _meta: { title: `Result: concat audio ← clip ${i + 1}` },
        }
        vCur = `ext_lj_v_${i}`
        aCur = `ext_lj_a_${i}`
      }
      nodes['ext_ljoin'] = {
        inputs: { video_latent: [vCur, 0], audio_latent: [aCur, 0] },
        class_type: 'LTXVConcatAVLatent',
        _meta: { title: 'Extend Result AV Latent' },
      }
      nodes['ext_lsave'] = {
        inputs: {
          samples: ['ext_ljoin', 0],
          filename_prefix: p.outputSubfolder
            ? `${p.outputSubfolder}/latents/Minimax_Studio_combined`
            : 'latents/Minimax_Studio_combined',
          vae_name: 'minimax_h3_video_vae_int8_convrot.safetensors',
        },
        class_type: 'MiniMaxStudioSaveAVLatent',
        _meta: { title: 'Save AV Latent (extend result → lossless refine)' },
      }
      return nodes
    })() : {}),
  }
}
