/**
 * Video generation configuration (ComfyUI-compatible).
 * The UI component passes VideoGenerateParams to useVideoGen,
 * which maps them to the ComfyUI workflow (MiniMax H3 Ref2VA).
 */

/** One ref2va reference. `path` is the ComfyUI input/ filename. */
export interface VideoReferenceParam {
  kind: 'image' | 'video' | 'audio'
  /** ComfyUI input/ filename (from /api/comfy/upload). */
  path: string
  /** Free text: who/what this reference is. */
  role?: string
  /** Images: identity | scene | style | composition. */
  imageIntent?: 'identity' | 'scene' | 'style' | 'composition'
  /** Videos: include the reference's own audio track. */
  includeAudio?: boolean
  /** (fix 493) Videos: compress to 480p before feeding into conditioning. */
  compress?: boolean
  /** (fix 302) Audio: trim, seconds. trimEnd null/0/undefined = until the end. */
  trimStart?: number
  trimEnd?: number | null
  /** (fix 694) Audio: volume 0–1 (default 0.5) — virtual (AudioGain node). */
  audioVolume?: number
}

/**
 * Parameters from the UI — the hook maps them to the ComfyUI workflow.
 */
export interface VideoGenerateParams {
  /** Model type (kept for UI compatibility; ComfyUI uses the workflow template). */
  modelType: string
  /** (fix 146) Generation mode: 'ref' (default) | 't2v' | 'flf' | 'extend' (fix 161). */
  mode?: 'ref' | 't2v' | 'flf' | 'extend'
  /** Pipeline: 'draft' — single pass on low-res canvas (draft for selection,
   *  upgrade via Refine tab); 'full' (default) — two passes, as before. */
  pipeline?: 'draft' | 'full'
  /** Single pass steps in 'draft' pipeline (default 4, min 2). */
  draftSteps?: number
  /** (fix 719) extend: extension clip steps. undefined = "auto" —
   *  first pass steps of source (from its metadata), without metadata — firstSamplerSteps. */
  extendClipSteps?: number
  /** (fix 161) extend: clips for extension. */
  extendClips?: Array<{ prompt: string; duration: number; seed: number }>
  /** (fix 161) extend: image refs for extension (up to 9). */
  extendRefs?: string[]
  /** (fix 164) extend: source video filename in ComfyUI input/ (for LoadVideo → ref_video_1). */
  extendSourceVideo?: string
  /** (fix 385) extend: ORIGINAL filename in output/ (copy in input/ has
   *  random name) — together with extendSourceSubfolder gives the sidecar address of the source:
   *  route resolves source latent against it (lossless seed of extension). */
  extendSourceName?: string
  /** (fix 385) extend: output subfolder from which the gallery source was taken. */
  extendSourceSubfolder?: string
  /** (fix 190) extend: number of overlap frames between clips (24 fps).
   *  Default 48 (2 sec). These frames from the end of the previous clip
   *  are fed as latent context for seamless continuation. */
  extendOverlapFrames?: number
  /** (fix 423) extend: two-pass mode (low-res pass 1 → upscale →
   *  pass 2 refine to source size). Default false = single pass. */
  extendTwoPass?: boolean
  /** (fix 146) flf: ComfyUI input/ filename of first frame. */
  firstFrame?: string
  /** (fix 146) flf: ComfyUI input/ filename of last frame. */
  lastFrame?: string
  /** (fix 152) flf: first frame width in pixels (for aspect ratio). */
  firstFrameWidth?: number
  /** (fix 152) flf: first frame height in pixels. */
  firstFrameHeight?: number
  /** Positive prompt (supports <Picture 1>/<Picture 2> tags for refs). */
  prompt: string
  /** Random seed (-1 = random, default: -1). */
  seed?: number
  /** Sampling steps (default 20; turbo: 4). */
  steps?: number
  /** Resolution string — EXACT nominal (fix 124), e.g. "1280x720", "1920x1080". */
  resolution?: string
  /** Total output frames (H3: 17n+5, min 124). */
  videoLength?: number
  /** Turbo mode (4-step LoRA). */
  turbo?: boolean
  /** Turbo LoRA multiplier 0.1–2.0 (default 0.7). */
  turboWeight?: number
  /** Custom LoRA filename (overrides turbo default). */
  turboLoraName?: string
  /** Non-turbo LoRA filename. */
  loraName?: string
  /** (fix 91) Output subfolder — gallery project folder ('' = common). */
  outputSubfolder?: string

  /* ── FL2VA: first/last frame ── */
  imagePromptType?: '' | 'S' | 'E' | 'SE'
  startFramePath?: string
  endFramePath?: string

  /* ── ref2va: reference manifest ── */
  references?: VideoReferenceParam[]
  referenceDetail?: 'match' | 'max'
  /** ref + audio ref: feed audio as Audio Guide (not just ref_audio)
   *  and keep original track in the result. */
  audioGuide?: boolean
  /** Server-side replacement of the final track with original (set together with audioGuide). */
  keepOriginalAudio?: boolean

  /* ── Two-pass latent upscaler ── */
  /** (fix 124) Exact nominal (final) video dimensions — priority
   *  over finalResolution: gen = ceil32(nominal), crop → exactly nominal. */
  targetDimensions?: { width: number; height: number }
  /** Target resolution in MP for the latent upscaler (default 0.7 ≈ 720p;
   *  (fix 124) used in free resolution mode). */
  finalResolution?: number
  /** Low-res pass 1 resolution in MP (default 0.2). */
  lowResMP?: number
  /** Pass 1 effective sampling steps (SplitSigmas split point, default 6, max 30). */
  firstSamplerSteps?: number
  /**
   * TOTAL steps in BasicScheduler schedule for pass 1.
   * undefined = firstSteps — "6 of 6" by default.
   */
  firstSamplerTotalSteps?: number
  /** Pass 2 sigma variant: '3step' | '4step' | '5step' | '6step' | '7step'. */
  sigmaVariant?: string
  /** (fix 69) Pass 2 sampler (default 'euler'). */
  pass2Sampler?: string
  /** (fix 70) Pass 1 sampler (default 'euler'). */
  pass1Sampler?: string
  /** (fix 70) Pass 1 scheduler (default 'simple'). */
  pass1Scheduler?: string
  /** (fix 168) Sparse Attention (Sol-Attn) — accelerates long sequences. Default true. */
  sparseAttention?: boolean
  /** (fix 466) Sol-Attn: tau threshold (default 1.3). */
  sparseTau?: number
  /** (fix 466) Sol-Attn: start_percent (default 0.2). */
  sparseStartPercent?: number
  /** (fix 466) Sol-Attn: end_percent (default 1.0). */
  sparseEndPercent?: number
  /** (fix 466) Sol-Attn: min_tokens (default 12288). */
  sparseMinTokens?: number
  /** (fix 466) Sol-Attn: extra_tokens (default 256). */
  sparseExtraTokens?: number
  /** (fix 301) Veda Sparse Attention — trained predictor. Default false. */
  vedaAttention?: boolean
  /** (fix 401) Veda: generation sparsity, 'N%' (default '90%'). */
  vedaGeneratedSparsity?: string
  /** (fix 401) Veda: reference sparsity, 'N%' (default '90%'; 0% = full attention). */
  vedaReferenceSparsity?: string
  /** (fix 401) Veda: DiT blocks with full attention ("0, 1, 47-49"; '' = all sparse). */
  vedaFullAttentionLayers?: string
  /** (fix 401) Veda: sampler steps with full attention ("0, 1"; '' = none). */
  vedaFullAttentionSteps?: string
  /** (fix 401) Veda: verbose log (default false). */
  vedaVerbose?: boolean
  /** Enable MiniMaxLowVRAMAttention (head-chunked attention, saves VRAM). */
  lowVramAttention?: boolean
  /** Enable MiniMaxChunkFeedForward (chunked FFN for long sequences). */
  chunkFeedForward?: boolean
  /** ChunkFF: number of feed-forward chunks (default 2). */
  chunkFFChunks?: number
  /** ChunkFF: sequence length threshold above which chunking kicks in (default 4096). */
  chunkFFThreshold?: number

  /* ── misc ── */
  textEncoder?: string
  negativePrompt?: string
  guidance?: number
  audioGuidance?: number
  [key: string]: unknown
}
