import { vhsEncodeInputs, type VideoFormatSettings } from '../video-format'
import { buildMiniMaxH3Workflow, selectResolution, type MiniMaxH3Params } from './minimax-h3-template'

/**
 * ControlNet tab — preprocessing (depth/canny) + standard
 * References workflow (MiniMaxH3ReferenceToVideo).
 *
 * Architecture:
 *   Generation mode (single workflow):
 *     cn_src (VHS_LoadVideo) → cn_pre (DepthAnythingV2 | Canny) →
 *     cn_prescale (ImageScale) → cn_preout (VHS_VideoCombine)
 *     → cn_fname (VHS_SelectFilename) → cn_refload (VHS_LoadVideoPath)
 *     → MiniMaxH3ReferenceToVideo (standard generation)
 *
 *   "Map" mode (preprocessOnly):
 *     cn_src → cn_pre → cn_prescale → cn_out (VHS_VideoCombine)
 *     — only saves depth/canny video, without generation.
 *
 * Standard generation is completely identical to the "Generation → References" tab:
 * same models (diffusion, CLIP, VAE, turbo LoRA, upscaler), same samplers,
 * same pipeline (draft/full), same options (sparse attention, Veda, LoRAs).
 * The control video is fed as a regular video reference (ref_video_0)
 * via VHS_LoadVideoPath — just like user video refs.
 *
 * NOTE: ComfyUI builds a DAG — cn_refload depends on cn_preout (via
 * VHS_FILENAMES), which means preprocessing executes BEFORE generation.
 */

export type ControlNetType = 'depth' | 'canny' | 'direct' | 'pose' // (fix 512) pose — DWPreprocessor

export interface ControlNetGenParams {
  /** Filename of the control video in ComfyUI input/. */
  sourceVideo: string
  /** Control video width (ffprobe). */
  sourceWidth: number
  /** Control video height (ffprobe). */
  sourceHeight: number
  /** Number of frames in control video (ffprobe). */
  sourceFrames: number
  /** Control type: depth | canny | direct (direct, without maps) | pose (fix 512). */
  controlType: ControlNetType
  /** Generation duration in seconds. */
  duration?: number
  /** Target short side of generation, px. */
  targetShortSide?: number
  /** Prompt. */
  prompt?: string
  /** Seed (-1 = random). */
  seed?: number
  /** Image references (filenames in input/). */
  refImages?: string[]
  /** Refs: size mode (match | max). */
  refImageSize?: 'match' | 'max'
  /** Pipeline: draft | full. */
  pipeline?: 'draft' | 'full'
  /** Low-res MP (for full pipeline, Pass 1). */
  lowResMP?: number
  /** Pass 1 effective steps (SplitSigmas split point, default 6, max 30). */
  firstSamplerSteps?: number
  /**
   * Total steps in BasicScheduler schedule for pass 1.
   * undefined = firstSamplerSteps — "6 of 6" by default.
   */
  firstSamplerTotalSteps?: number
  /** Custom LoRAs. */
  customLoras?: Array<{ name: string; strength: number }>
  /** Diffusion model. */
  diffusionModel?: string
  /** Output subfolder. */
  outputSubfolder?: string
  /**
   * (fix 716) Unique prefix for temporary reference map (cn_preout).
   * Previously the prefix was fixed ("Minimax_Studio_cnref" + ComfyUI counter),
   * and cleanup removed ALL such maps — including maps of another concurrently
   * running ControlNet task (control maps of concurrent tasks are allowed),
   * which caused that task to fail inside VHS_LoadVideoPath.
   */
  cnRefPrefix?: string
  /** Video format. */
  videoFormat?: VideoFormatSettings
  /** Sparse attention. */
  sparseAttention?: boolean
  /** (fix 466) Sol-Attn: sparsity threshold. */
  sparseTau?: number
  /** (fix 466) Sol-Attn: start_percent. */
  sparseStartPercent?: number
  /** (fix 466) Sol-Attn: end_percent. */
  sparseEndPercent?: number
  /** (fix 466) Sol-Attn: min_tokens. */
  sparseMinTokens?: number
  /** (fix 466) Sol-Attn: extra_tokens. */
  sparseExtraTokens?: number
  /** Veda attention. */
  vedaAttention?: boolean
  /** (fix 399) Veda: generation sparsity, 'N%'. */
  vedaGeneratedSparsity?: string
  /** (fix 399) Veda: reference sparsity, 'N%'. */
  vedaReferenceSparsity?: string
  /** (fix 399) Veda: 0-based DiT blocks with full attention. */
  vedaFullAttentionLayers?: string
  /** (fix 399) Veda: 0-based sampler steps with full attention. */
  vedaFullAttentionSteps?: string
  /** (fix 399) Veda: verbose log. */
  vedaVerbose?: boolean
  /** Low VRAM attention. */
  lowVramAttention?: boolean
  /** Chunk FF. */
  chunkFeedForward?: boolean
  /** ChunkFF: number of chunks. */
  chunkFFChunks?: number
  /** ChunkFF: sequence length threshold. */
  chunkFFThreshold?: number
  /** Sigma variant (pass 2). */
  sigmaVariant?: string
  /** Pass 1 sampler. */
  pass1Sampler?: string
  /** Pass 1 scheduler. */
  pass1Scheduler?: string
  /** Pass 2 sampler. */
  pass2Sampler?: string
  /** Draft steps. */
  draftSteps?: number
  /** @deprecated Turbo LoRA goes through customLoras; template does not read this field. */
  turboLoraStrength?: number
  /** @deprecated Turbo LoRA goes through customLoras; template does not read this field. */
  turboLoraEnabled?: boolean
}

/** Snap to multiple of 32. */
function snap32(n: number): number {
  return Math.max(32, Math.round(n / 32) * 32)
}

/**
 * Generation dimensions: short side = targetShortSide, long side — according to
 * control video aspect ratio; both axes snap to 32.
 */
export function controlNetSize(
  sourceWidth: number,
  sourceHeight: number,
  targetShortSide: number,
): { width: number; height: number } {
  const shortSrc = Math.min(sourceWidth, sourceHeight)
  const scale = targetShortSide / shortSrc
  return {
    width: snap32(sourceWidth * scale),
    height: snap32(sourceHeight * scale),
  }
}

/**
 * Actual number of generation frames: 17n+5 grid from duration,
 * clamped down to control video frame count.
 */
export function controlNetFrames(duration: number, sourceFrames: number): number {
  const want = Math.max(5, Math.round(duration * 24))
  const snapped = want + (((5 - want) % 17) + 17) % 17
  const cap = Math.max(5, Math.round(sourceFrames))
  return Math.min(snapped, cap)
}

/**
 * "Map" mode: preprocessing only → save depth/canny video.
 */
export function buildControlNetPreprocessWorkflow(p: {
  sourceVideo: string
  sourceWidth: number
  sourceHeight: number
  sourceFrames: number
  controlType: ControlNetType
  duration?: number
  targetShortSide?: number
  outputSubfolder?: string
  videoFormat?: VideoFormatSettings
}): Record<string, unknown> {
  const vhsEnc = vhsEncodeInputs(p.videoFormat)
  const frames = Math.max(1, Math.min(Math.round((p.duration ?? 5) * 24), p.sourceFrames))
  const { width, height } = controlNetSize(p.sourceWidth, p.sourceHeight, p.targetShortSide ?? 720)
  const controlType = p.controlType === 'canny' ? 'canny' : (p.controlType === 'pose' ? 'pose' : 'depth') // (fix 512)
  const sub = p.outputSubfolder ? `${p.outputSubfolder}/` : ''

  return {
    'cn_src': {
      inputs: {
        video: p.sourceVideo,
        force_rate: 24,
        custom_width: width,
        custom_height: height,
        frame_load_cap: frames,
        skip_first_frames: 0,
        select_every_nth: 1,
      },
      class_type: 'VHS_LoadVideo',
      _meta: { title: `Control video → ${width}×${height}, ${frames} frames` },
    },
    'cn_pre': controlType === 'canny'
      ? {
          inputs: {
            image: ['cn_src', 0],
            low_threshold: 100,
            high_threshold: 200,
            resolution: 1024,
          },
          class_type: 'CannyEdgePreprocessor',
          _meta: { title: 'Canny Edge' },
        }
      : controlType === 'pose'
        ? {
            inputs: {
              image: ['cn_src', 0],
              detect_hand: 'enable',
              detect_body: 'enable',
              detect_face: 'enable',
              resolution: 1024,
              bbox_detector: 'yolox_l.onnx',
              pose_estimator: 'dw-ll_ucoco_384.onnx',
            },
            class_type: 'DWPreprocessor',
            _meta: { title: 'DWPose' },
          }
        : {
            inputs: {
              image: ['cn_src', 0],
              ckpt_name: 'depth_anything_v2_vits.pth',
              resolution: 1024,
            },
            class_type: 'DepthAnythingV2Preprocessor',
            _meta: { title: 'Depth Anything V2' },
          },
    'cn_prescale': {
      inputs: {
        image: ['cn_pre', 0],
        upscale_method: 'bilinear',
        width,
        height,
        crop: 'disabled',
      },
      class_type: 'ImageScale',
      _meta: { title: `Control → exact size ${width}×${height}` },
    },
    'cn_out': {
      inputs: {
        frame_rate: 24,
        loop_count: 0,
        filename_prefix: `${sub}Minimax_Studio_controlmap`,
        ...vhsEnc,
        save_metadata: false,
        pingpong: false,
        save_output: true,
        images: ['cn_prescale', 0],
      },
      class_type: 'VHS_VideoCombine',
      _meta: { title: `Video Combine (${controlType} map)` },
    },
  }
}

/**
 * Generation mode: preprocessing + standard References workflow.
 *
 * Single ComfyUI workflow, two branches by controlType:
 *
 *   direct (fix 511):
 *     cn_src (VHS_LoadVideo) → ref_video_0
 *     — video is fed as a regular video reference, without maps.
 *
 *   depth | canny:
 *     1. cn_src → cn_pre → cn_prescale → cn_preout (saves depth/canny mp4)
 *     2. cn_fname (VHS_SelectFilename) extracts filename from cn_preout
 *     3. cn_refload (VHS_LoadVideoPath) loads this mp4 as IMAGE frames
 *     4. ref_video_0 = cn_refload
 *
 * NOTE: ComfyUI builds a DAG — cn_refload depends on cn_preout,
 * which means preprocessing executes BEFORE generation.
 */
export function buildControlNetWorkflow(p: ControlNetGenParams): Record<string, unknown> {
  const { width, height } = controlNetSize(p.sourceWidth, p.sourceHeight, p.targetShortSide ?? 720)
  const frames = controlNetFrames(p.duration ?? 5, p.sourceFrames)
  const controlType: ControlNetType = p.controlType === 'canny' ? 'canny' : (p.controlType === 'direct' ? 'direct' : (p.controlType === 'pose' ? 'pose' : 'depth')) // (fix 512)
  const sub = p.outputSubfolder ? `${p.outputSubfolder}/` : ''
  const vhsEnc = vhsEncodeInputs(p.videoFormat)

  const isDirect = controlType === 'direct'

  // ─── cn_src node: VHS_LoadVideo — common to both branches ───
  // direct: video goes as ref directly (like in "Generation" tab).
  // depth/canny: source for preprocessing.
  // In direct mode custom_width/height = 0 (like standard video refs: model
  // itself works with native resolution), frame_load_cap = 0 (all frames).
  // In depth/canny — exact size + frame clamping for generation.
  const cnSrcInputs = isDirect
    ? {
        video: p.sourceVideo,
        force_rate: 24,
        custom_width: 0,
        custom_height: 0,
        frame_load_cap: 0,
        skip_first_frames: 0,
        select_every_nth: 1,
      }
    : {
        video: p.sourceVideo,
        force_rate: 24,
        custom_width: width,
        custom_height: height,
        frame_load_cap: frames,
        skip_first_frames: 0,
        select_every_nth: 1,
      }

  const extraNodes: Record<string, unknown> = {
    'cn_src': {
      inputs: cnSrcInputs,
      class_type: 'VHS_LoadVideo',
      _meta: {
        title: isDirect
          ? 'Control video (direct)'
          : `Control video → ${width}×${height}, ${frames} frames`,
      },
    },
  }

  // ─── depth/canny: preprocessing chain + loading map as video ───
  // direct: nothing — cn_src connects directly to ref_video_0.
  let refVideo0Src: [string, number] = ['cn_src', 0]

  if (!isDirect) {
    const mapType = controlType === 'canny' ? 'canny' : (controlType === 'pose' ? 'pose' : 'depth') // (fix 512)
    extraNodes['cn_pre'] = mapType === 'canny'
      ? {
          inputs: {
            image: ['cn_src', 0],
            low_threshold: 100,
            high_threshold: 200,
            resolution: 1024,
          },
          class_type: 'CannyEdgePreprocessor',
          _meta: { title: 'Canny Edge (control)' },
        }
      : mapType === 'pose'
        ? {
            inputs: {
              image: ['cn_src', 0],
              detect_hand: 'enable',
              detect_body: 'enable',
              detect_face: 'enable',
              resolution: 1024,
              bbox_detector: 'yolox_l.onnx',
              pose_estimator: 'dw-ll_ucoco_384.onnx',
            },
            class_type: 'DWPreprocessor',
            _meta: { title: 'DWPose (control)' },
          }
        : {
            inputs: {
              image: ['cn_src', 0],
              ckpt_name: 'depth_anything_v2_vits.pth',
              resolution: 1024,
            },
            class_type: 'DepthAnythingV2Preprocessor',
            _meta: { title: 'Depth Anything V2 (control)' },
          }
    extraNodes['cn_prescale'] = {
      inputs: {
        image: ['cn_pre', 0],
        upscale_method: 'bilinear',
        width,
        height,
        crop: 'disabled',
      },
      class_type: 'ImageScale',
      _meta: { title: `Control → exact size ${width}×${height}` },
    }
    extraNodes['cn_preout'] = {
      inputs: {
        frame_rate: 24,
        loop_count: 0,
        // (fix 716) Prefix is unique per task — cleanup removes only
        // maps of THIS job, not maps of concurrent ControlNet tasks.
        filename_prefix: `${sub}${p.cnRefPrefix ?? 'Minimax_Studio_cnref'}`,
        ...vhsEnc,
        save_metadata: false,
        pingpong: false,
        save_output: true,
        images: ['cn_prescale', 0],
      },
      class_type: 'VHS_VideoCombine',
      _meta: { title: `Save ${mapType} reference` },
    }
    // Extract filename from VHS_FILENAMES output of cn_preout
    extraNodes['cn_fname'] = {
      inputs: {
        filenames: ['cn_preout', 0],
        index: -1, // last (most complete) file
      },
      class_type: 'VHS_SelectFilename',
      _meta: { title: 'Depth/canny map filename' },
    }
    // Load map as video (just like user video refs)
    extraNodes['cn_refload'] = {
      inputs: {
        video: ['cn_fname', 0],
        force_rate: 24,
        custom_width: 0,
        custom_height: 0,
        frame_load_cap: 0,
        skip_first_frames: 0,
        select_every_nth: 1,
      },
      class_type: 'VHS_LoadVideoPath',
      _meta: { title: 'Load depth/canny map as video reference' },
    }
    refVideo0Src = ['cn_refload', 0]
  }

  // ─── Standard References workflow ───
  // (fix 523) Aspect ratio pass 1 — from target dimensions (width:height),
  // not hardcoded '16:9'. Otherwise for vertical video (9:16) pass 1
  // would be generated on horizontal canvas (e.g. 608×352), and upscaler
  // MinimaxH3LatentUpscaler3D in 'target dimensions' mode would stretch this
  // horizontal latent into vertical 704×1280 → image gets squashed
  // (upscale x1.16 y3.64 — 3× distortion vertically).
  //
  // We select lowResMP such that selectResolution(aspect, lowResMP) produces
  // close to targetDimensions (via binary search). Then lowRes ≈ final
  // and upscaler scales ~1× (without aspect ratio distortion).
  const aspectRatio = `${width}:${height}`
  const finalMP = (width * height) / (1024 * 1024)
  // (fix 523) Binary search lowResMP so that lowRes is as close as possible to target
  // (but not higher). selectResolution snaps to multiple of 32, so exact match
  // may not always occur — but upscaler scales ~1×, aspect ratios are preserved.
  let lowResMP: number
  {
    let lo = 0.05, hi = finalMP
    let best = { mp: lo, res: selectResolution(aspectRatio, lo) }
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2
      const res = selectResolution(aspectRatio, mid)
      if (res.w > width || res.h > height) {
        hi = mid
      } else {
        lo = mid
        // Remember best (maximum lowRes <= target)
        best = { mp: mid, res }
      }
    }
    lowResMP = best.mp
  }
  // (fix 523) lowRes multiple of 32 (selectResolution already provides this).
  // If lowRes == target — upscaler early-return (optimal).
  // If lowRes < target — upscaler scales ~1× (acceptable, without distortion).

  const stdParams: MiniMaxH3Params = {
    prompt: (p.prompt ?? '').trim(),
    refImages: (p.refImages ?? []).filter(Boolean).slice(0, 9),
    refVideos: [], // replaced below
    mode: 'ref',
    aspectRatio, // (fix 523) from target size, not '16:9'
    duration: p.duration ?? 5,
    seed: p.seed ?? -1,
    pipeline: p.pipeline === 'full' ? 'full' : 'draft',
    targetDimensions: { width, height },
    lowResMP, // (fix 523) tuned for target
    firstSamplerSteps: p.firstSamplerSteps,
    // Total steps in pass 1 schedule (undefined = split point, "6 of 6").
    firstSamplerTotalSteps: p.firstSamplerTotalSteps,
    refImageSize: p.refImageSize ?? 'max', // (fix 511) default max
    outputSubfolder: p.outputSubfolder ?? '',
    videoFormat: p.videoFormat,
    customLoras: p.customLoras,
    diffusionModel: p.diffusionModel,
    sparseAttention: p.sparseAttention,
    sparseTau: p.sparseTau,
    sparseStartPercent: p.sparseStartPercent,
    sparseEndPercent: p.sparseEndPercent,
    sparseMinTokens: p.sparseMinTokens,
    sparseExtraTokens: p.sparseExtraTokens,
    vedaAttention: p.vedaAttention,
    vedaGeneratedSparsity: p.vedaGeneratedSparsity,
    vedaReferenceSparsity: p.vedaReferenceSparsity,
    vedaFullAttentionLayers: p.vedaFullAttentionLayers,
    vedaFullAttentionSteps: p.vedaFullAttentionSteps,
    vedaVerbose: p.vedaVerbose,
    lowVramAttention: p.lowVramAttention,
    chunkFeedForward: p.chunkFeedForward,
    chunkFFChunks: p.chunkFFChunks,
    chunkFFThreshold: p.chunkFFThreshold,
    sigmaVariant: p.sigmaVariant,
    pass1Sampler: p.pass1Sampler,
    pass1Scheduler: p.pass1Scheduler,
    pass2Sampler: p.pass2Sampler,
    draftSteps: p.draftSteps,
    turboLoraStrength: p.turboLoraStrength,
    turboLoraEnabled: p.turboLoraEnabled,
  }

  const stdWorkflow = buildMiniMaxH3Workflow(stdParams)

  // Connect control video as ref_video_0.
  // direct: cn_src (VHS_LoadVideo) — identical to standard pattern
  //   ("Generation" tab): video + audio (output[2]).
  // depth/canny: cn_refload (VHS_LoadVideoPath) — map as video, without audio.
  if ('46:11' in stdWorkflow) {
    const refNode = stdWorkflow['46:11'] as Record<string, unknown>
    const inputs = refNode.inputs as Record<string, unknown>
    inputs['ref_videos.ref_video_0'] = refVideo0Src
    // direct: audio from source video (VHS_LoadVideo output[2] = AUDIO),
    // as on the "Generation" tab for video refs.
    if (isDirect) {
      inputs['ref_video_audios.ref_video_audio_0'] = ['cn_src', 2]
    }
  }
  // Node '501' (VHS_LoadVideo for ref video) is not created when refVideos:[] —
  // delete here is harmless, left in case of future changes.
  delete stdWorkflow['501']

  // ─── Replace filename_prefix with Minimax_Studio_controlnet ───
  // buildMiniMaxH3Workflow writes "<subfolder>/Minimax_Studio" or "Minimax_Studio".
  // Gallery detects "ControlNet" badge by /Minimax_Studio_controlnet/i in filename.
  // Iterate through all nodes with filename_prefix and replace trailing "Minimax_Studio".
  for (const val of Object.values(stdWorkflow)) {
    if (!val || typeof val !== 'object') continue
    const node = val as Record<string, unknown>
    if (node.class_type === 'VHS_VideoCombine' && node.inputs) {
      const inputs = node.inputs as Record<string, unknown>
      if (typeof inputs.filename_prefix === 'string') {
        // Do NOT touch Minimax_Studio_cnref (that is a temporary map, not the final output)
        if (!/Minimax_Studio_cnref/i.test(inputs.filename_prefix)) {
          inputs.filename_prefix = inputs.filename_prefix.replace(/Minimax_Studio$/, 'Minimax_Studio_controlnet')
        }
      }
    }
  }

  // Add control nodes
  const result: Record<string, unknown> = { ...stdWorkflow, ...extraNodes }

  return result
}
