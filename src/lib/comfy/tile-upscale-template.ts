import { vhsEncodeInputs, type VideoFormatSettings } from '../video-format' // (fix 386)
/**
 * Tile Upscale — latent tiled upscale of finished video
 * (MMH3UltimateUpscale — monolithic node: temporal chunks → latent upscale →
 * spatial tiles → per-tile sampling → spatial stitch → temporal stitch).
 *
 * Architecture (based on "Minimax H3 Latent Upscale" workflow):
 *   VHS_LoadVideo (24 fps) ──→ GetImageSize → ComfyMathExpression (×2)
 *   EmptyMiniMaxH3LatentAV (src size, length) ──→ H3InjectVideoLatent (replaces
 *     video stream with encoded source frames, keeps audio stream)
 *   MMH3UltimateUpscale:
 *     model (UNET → H3SLAAttention → LoRA → H3AdaLNLoRAFix → SigmaShift)
 *     conditioning (MiniMaxH3ImageToVideo, without first_frame — fix 482)
 *     latent_upscale_param (MMH3LatentUpscaleWithModelParams, target W×H)
 *     temporal_split_param (MMH3TemporalSplitParams)
 *     spatial_split_param (MMH3SpatialSplitParams)
 *     noise (RandomNoise), sampler (res_multistep), sigmas (BasicScheduler 2/denoise 0.1)
 *   VAEDecode → VHS_VideoCombine (24 fps, audio from source)
 *
 * Tiles: user sets only tile size (tileSize) — the MMH3SpatialSplitParams node
 * operates in specific_size mode and calculates on its own how many tiles are
 * needed along each axis based on target frame dimensions and overlap.
 *
 * Models (our analogs):
 *   VAE:      minimax_h3_video_vae_int8_convrot.safetensors
 *   CLIP:     qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors
 *   UNET:     minimax_h3_fastvideo_vsa_datafree_1300step_4step_int8_convrot.safetensors
 *   LoRA:     minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors
 *   Upscaler: minimax_h3_latent_upscaler_3d_fp16.safetensors
 */

export const DEFAULT_TILE_UPSCALE_PROMPT =
  'Enhance this video with sharp, crisp details while preserving a natural photorealistic appearance.'

export interface TileUpscaleParams {
  /** Filename in ComfyUI input/ (already copied by route). */
  sourceVideo: string
  /** (fix 381) Path to saved source AV latent (relative to
   *  output/, latent_file field in metadata; route already validated file and passed
   *  sourceWidth/sourceHeight = LATENT pixel canvas). If provided → latent
   *  loads directly (MiniMaxStudioLoadAVLatent) instead of
   *  Empty+H3InjectVideoLatent: without h264 decode and repeated VAE-encode
   *  of the entire clip. mp4 remains the source of first frame and audio track. */
  sourceLatent?: string
  /** (fix 381) Source frames (ffprobe) — in latent branch the conditioning
   *  length is calculated on the server (mp4 is not loaded entirely). */
  sourceFrames?: number
  /** (fix 488) Absolute path to source copy in ComfyUI input/ —
   *  source of audio track in latent branch (VHS_LoadAudio requires actual
   *  path, does not resolve filename through input directory, unlike
   *  VHS_LoadVideo). */
  sourceAudioPath?: string
  /** Source dimensions in pixels (ffprobe; in latent branch route replaces
   *  them with latent pixel canvas — target ×N is computed from it). */
  sourceWidth: number
  /** Source dimensions in pixels (ffprobe / latent canvas). */
  sourceHeight: number
  /** Caption (default: enhance prompt). */
  prompt?: string
  /** Seed (-1 = random). */
  seed?: number
  /** Tile size in pixels (multiple of 32). Default 768. Tile count
   *  is computed automatically from target frame dimensions (specific_size
   *  mode of MMH3SpatialSplitParams node). Clamped to smaller target side. */
  tileSize?: number
  /** Spatial overlap, px. Default 128. */
  overlap?: number
  /** Fade width in pixels. Default 64. */
  fade?: number
  /** Temporal chunk length in frames (multiple of 17). Default 136. */
  chunkFrames?: number
  /** Temporal overlap in frames (multiple of 17). Default 17. */
  temporalOverlap?: number
  /** Anchor strength 0–1. Default 0.999. */
  anchorStrength?: number
  /** Upscale model name. Default: minimax_h3_latent_upscaler_3d_fp16.safetensors */
  upscaleModel?: string
  /** Diffusion model name. */
  diffusionModel?: string
  /** Output subfolder. */
  outputSubfolder?: string
  /** Short side of target resolution in px (720|1080|1440|2160). Default 1080. (fix 265) */
  targetResolution?: number
  /** Denoise level 0–1. Default 0.1. */
  denoise?: number
  /** Number of sampling steps. Default 2. */
  steps?: number
  /** (fix 481) SyncTile: per-step tile synchronization (MultiDiffusion) —
   *  tiles are blended into shared canvas after EVERY step + shared noise canvas.
   *  Eliminates seams/flicker at junctions. In this mode node ignores
   *  fade/overlap_mode/blend/brightness_match (overlap sets only
   *  ramp geometry). Default true. */
  syncTiles?: boolean
  /** (fix 483) LoRA from settings — customLoras chain (including
   *  turbo LoRA if enabled), before AdaLN fix and SigmaShift. */
  customLoras?: Array<{ name: string; strength: number }>
  /** (fix 386) Video output format/quality ([video] config.ini). */
  videoFormat?: VideoFormatSettings
}

/**
 * Snap a value to the nearest multiple of 17 (H3 keyframe grid step).
 */
function snap17(n: number): number {
  return Math.max(17, Math.round(n / 17) * 17)
}

/**
 * Snap a pixel value to a multiple of 32 (H3 latent patch grid).
 */
function snap32(n: number): number {
  return Math.max(32, Math.round(n / 32) * 32)
}

/** (fix 489) Target side limit for MMH3LatentUpscaleWithModelParams
 *  (node validation: width/height max 4096). */
const TILE_TARGET_MAX = 4096

/**
 * (fix 265/489) Target dimensions: short side = targetResolution,
 * long side — according to source aspect ratio, but NOT exceeding TILE_TARGET_MAX:
 * for ultrawide videos (21:9 etc.) 2160p on the short side resulted in width >4096
 * and ComfyUI rejected the workflow (value_bigger_than_max). In this case the entire
 * target is scaled down preserving aspect ratio until the long side fits within
 * the node limit.
 */
function computeTileTarget(srcW: number, srcH: number, target: number): { targetW: number; targetH: number } {
  const shortSide = Math.min(srcW, srcH)
  const scale = target / shortSide
  let targetW = snap32(srcW * scale)
  let targetH = snap32(srcH * scale)
  const longSide = Math.max(targetW, targetH)
  if (longSide > TILE_TARGET_MAX) {
    const shrink = TILE_TARGET_MAX / longSide
    targetW = snap32(srcW * scale * shrink)
    targetH = snap32(srcH * scale * shrink)
    // snap32 rounds to nearest multiple of 32 — safeguard against exceeding
    // limit when rounding up.
    targetW = Math.min(targetW, TILE_TARGET_MAX)
    targetH = Math.min(targetH, TILE_TARGET_MAX)
  }
  return { targetW, targetH }
}

/** (fix 479) Tile/chunk geometry for progress tracker. */
export interface TileGeometry {
  totalTiles: number
  tilesW: number
  tilesH: number
  totalChunks: number
  stepsPerUnit: number
  totalUnits: number
}

/**
 * (fix 479) Calculation of tile count, temporal chunks, and sampling units.
 * Formulas are identical to internal calculations of MMH3SpatialSplitParams
 * (specific_size) and MMH3TemporalSplitParams nodes. Returns null if input
 * parameters do not permit calculation (srcFrames = 0 in pixel branch).
 */
export function computeTileGeometry(opts: {
  sourceWidth: number
  sourceHeight: number
  targetResolution?: number
  tileSize?: number
  overlap?: number
  chunkFrames?: number
  temporalOverlap?: number
  steps?: number
  sourceFrames?: number
}): TileGeometry | null {
  const srcW = opts.sourceWidth
  const srcH = opts.sourceHeight
  if (!srcW || !srcH) return null

  const target = opts.targetResolution ?? 1080
  // (fix 489) same target formula as in buildTileUpscaleWorkflow
  // (clamping long side to node limit) — otherwise progress geometry
  // would diverge from actual workflow.
  const { targetW, targetH } = computeTileTarget(srcW, srcH, target)

  const tileMax = Math.max(256, Math.floor(Math.min(targetW, targetH) / 32) * 32)
  const tileSize = Math.min(snap32(opts.tileSize ?? 768), tileMax)
  const spatialOverlap = Math.min(snap32(opts.overlap ?? 128), tileSize - 32)

  // Grid: ceil((dim - tile) / (tile - overlap)) + 1, min 1
  const tilesW = Math.max(1, Math.ceil((targetW - tileSize) / (tileSize - spatialOverlap)) + 1)
  const tilesH = Math.max(1, Math.ceil((targetH - tileSize) / (tileSize - spatialOverlap)) + 1)
  const totalTiles = tilesW * tilesH

  // Temporal chunks
  const chunkLen = snap17(opts.chunkFrames ?? 136)
  const tempOverlap = snap17(opts.temporalOverlap ?? 17)

  let srcFrames = Math.max(0, Math.round(opts.sourceFrames ?? 0))
  if (srcFrames === 0) return null // pixel branch: frames unknown at geometry time
  const framesGrid = Math.max(5, srcFrames - ((srcFrames - 5) % 17))
  const totalChunks = Math.max(1, Math.ceil((framesGrid - tempOverlap) / (chunkLen - tempOverlap)))

  const stepsPerUnit = opts.steps ?? 2
  const totalUnits = totalTiles * totalChunks

  return { totalTiles, tilesW, tilesH, totalChunks, stepsPerUnit, totalUnits }
}

export function buildTileUpscaleWorkflow(p: TileUpscaleParams): Record<string, unknown> {
  const seed = !p.seed || p.seed < 0 ? Math.floor(Math.random() * 2 ** 31) : p.seed
  const vhsEnc = vhsEncodeInputs(p.videoFormat) // (fix 386)
  const prompt = (p.prompt ?? '').trim()

  // (fix 381) Lossless branch: seeding from saved latent.
  const latentMode = !!p.sourceLatent
  // 17k+5 grid from actual frames (equivalent to length from tu_src[1]),
  // on server: in latent branch mp4 is not loaded into graph entirely.
  const srcFrames = Math.max(0, Math.round(p.sourceFrames ?? 0))
  const framesGrid = Math.max(5, srcFrames - ((srcFrames - 5) % 17))

  // Target dimensions: short side = targetResolution (fix 265),
  // long side clamped to node limit 4096 (fix 489)
  const srcW = p.sourceWidth
  const srcH = p.sourceHeight
  const target = p.targetResolution ?? 1080
  const { targetW, targetH } = computeTileTarget(srcW, srcH, target)

  // Temporal params (must be multiples of 17)
  const chunkLen = snap17(p.chunkFrames ?? 136)
  const tempOverlap = snap17(p.temporalOverlap ?? 17)
  const anchor = p.anchorStrength ?? 0.999

  // Spatial params: tile size set by user, grid (how many tiles
  // along axes) computed by node itself from target frame dimensions
  // (specific_size mode). Tile clamped to smaller side of target (otherwise
  // node rejects: upscale size >= tile size), fade clamped to overlap (fade > overlap
  // is also a node error).
  const tileMax = Math.max(256, Math.floor(Math.min(targetW, targetH) / 32) * 32)
  const tileSize = Math.min(snap32(p.tileSize ?? 768), tileMax)
  // overlap strictly smaller than tile (node validation) — important when clamping tile down
  const spatialOverlap = Math.min(snap32(p.overlap ?? 128), tileSize - 32)
  const fadeWidth = Math.min(snap32(p.fade ?? 64), spatialOverlap)
  const minTile = snap32(256)

  // Model chain: UNET → [custom LoRAs] → SigmaShift
  // Turbo LoRA is a regular customLoras entry (ON by default), like
  // user LoRAs; order is determined by loras.json.
  let modelSrc: [string, number] = ['tu_unet', 0]
  const modelNodes: Record<string, unknown> = {}

  // (fix 483) User LoRAs — BEFORE
  // AdaLN fix (H3AdaLNLoRAFix patches adaLN layers taking all applied
  // LoRAs into account, so custom ones must enter model earlier).
  const customLoras = (p.customLoras ?? []).filter((l) => l.name)
  customLoras.forEach((lora, i) => {
    const id = `tu_clora_${i}`
    modelNodes[id] = {
      inputs: {
        lora_name: lora.name,
        strength_model: lora.strength,
        model: modelSrc,
      },
      class_type: 'LoraLoaderModelOnly',
      _meta: { title: `Custom LoRA ${i + 1}: ${lora.name}` },
    }
    modelSrc = [id, 0]
  })

  modelNodes['tu_sigma'] = {
    inputs: { shift_video: 12, shift_audio: 3, model: modelSrc },
    class_type: 'MiniMaxH3SigmaShift',
    _meta: { title: 'Sigma Shift' },
  }
  modelSrc = ['tu_sigma', 0]

  // (fix 478) Live preview same as on Refine/Generation tabs: KJ node
  // ModelPreviewOverrideKJ at the end of model chain sends its own
  // kj_preview_override events on each step of internal sampling of
  // MMH3UltimateUpscale (per-tile; OUTER_SAMPLE wrapper triggers in
  // CFGGuider.sample, which node builds from provided model).
  // Default previews are disabled in this build (--preview-method NoPreviews
  // by default), without KJ node the preview window would receive nothing.
  // Settings identical to Refine/Generation tabs: vae link + preview_frames
  // for the whole video (latent branch — framesGrid from server, pixel branch — frame
  // counter tu_src, like r_cap in refine). Preview of each per-tile step covers
  // its whole temporal chunk (KJ takes min(limit, frames in latent) — for
  // short runs extra limit is harmless, no subsampling); taeh3 is
  // H3 taesd decoder (24 ch). Scheduler (tu_sigmas) takes model WITHOUT wrapper —
  // like in refine, wrapper is only needed for sampling path.
  modelNodes['tu_preview'] = {
    inputs: {
      model: modelSrc,
      vae: ['tu_vae', 0],
      tiny_vae: 'taeh3.safetensors',
      max_resolution: 1024,
      jpeg_quality: 80,
      suppress_default_preview: true,
      preview_frames: latentMode ? framesGrid : ['tu_src', 1],
      preview_fps: 6,
    },
    class_type: 'ModelPreviewOverrideKJ',
    _meta: { title: 'Model Preview Override (fix 478)' },
  }
  const previewModel: [string, number] = ['tu_preview', 0]

  const sub = p.outputSubfolder ? `${p.outputSubfolder}/` : ''

  return {
    // ═══════════════════════════════════════════════
    //  MODEL LOADING + CHAIN
    // ═══════════════════════════════════════════════
    'tu_unet': {
      inputs: {
        unet_name:
          // (fix 293) restored main model
          p.diffusionModel || 'minimax_h3_fastvideo_vsa_datafree_1300step_4step_int8_convrot.safetensors',
        weight_dtype: 'default',
      },
      class_type: 'UNETLoader',
      _meta: { title: 'Diffusion Model' },
    },
    'tu_clip': {
      inputs: {
        clip_name: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
        type: 'minimax',
        device: 'default',
      },
      class_type: 'CLIPLoader',
      _meta: { title: 'CLIP' },
    },
    'tu_vae': {
      inputs: { vae_name: 'minimax_h3_video_vae_int8_convrot.safetensors' },
      class_type: 'VAELoader',
      _meta: { title: 'VAE (video)' },
    },
    'tu_audvae': {
      inputs: { vae_name: 'minimax_h3_audio_vae_fp32.safetensors' },
      class_type: 'VAELoader',
      _meta: { title: 'VAE (audio)' },
    },
    ...modelNodes,

    // ═══════════════════════════════════════════════
    //  SOURCE VIDEO LOADING
    //  (fix 381) Two paths:
    //   • latentMode — lossless: pristine AV latent from .latent file.
    //     Full h264 decode + Empty→H3InjectVideoLatent (repeated VAE encode
    //     of entire clip) are skipped. mp4 is not decoded at all (fix 482 —
    //     first_frame removed); audio track for mux is fetched by VHS_LoadAudio
    //     directly via ffmpeg (fix 488).
    //   • normal path — as before.
    // ═══════════════════════════════════════════════
    ...(latentMode ? {
      'tu_lat': {
        inputs: { latent: p.sourceLatent },
        class_type: 'MiniMaxStudioLoadAVLatent',
        _meta: { title: 'Source AV Latent (lossless, fix 381)' },
      },
      // (fix 488) Previously audio was taken from VHS_LoadVideo (frame_load_cap=1) —
      // but VHS cuts track to frame_load_cap × frame_time (≈1 frame), and
      // result had NO audio. VHS_LoadAudio extracts the full track
      // via ffmpeg without touching video stream (no RAM for frames, no h264 decode).
      'tu_audio': {
        inputs: {
          audio_file: p.sourceAudioPath ?? p.sourceVideo,
          seek_seconds: 0,
          duration: 0, // 0 = entire track
        },
        class_type: 'VHS_LoadAudio',
        _meta: { title: 'Source: audio track (mux)' },
      },
    } : {
      'tu_src': {
        inputs: {
          video: p.sourceVideo,
          force_rate: 24,
          custom_width: 0,
          custom_height: 0,
          frame_load_cap: 0,
          skip_first_frames: 0,
          select_every_nth: 1,
        },
        class_type: 'VHS_LoadVideo',
        _meta: { title: 'Source (24 fps)' },
      },
      'tu_size': {
        inputs: { image: ['tu_src', 0] },
        class_type: 'GetImageSize',
        _meta: { title: 'Frame Dimensions' },
      },
      // Target = source × 2 (already computed server-side; these are fixed numbers)
      // We use the pre-computed targetW/targetH as constants since we know them.

      // ═══════════════════════════════════════════════
      //  AV LATENT: Empty (source size) → Inject real frames
      // ═══════════════════════════════════════════════
      'tu_empty': {
        inputs: {
          width: srcW,
          height: srcH,
          // length comes from the video frame count — use VHS output (index 1)
          length: ['tu_src', 1],
        },
        class_type: 'EmptyMiniMaxH3LatentAV',
        _meta: { title: `Empty AV Latent ${srcW}×${srcH}` },
      },
      'tu_inject': {
        inputs: {
          av_latent: ['tu_empty', 0],
          images: ['tu_src', 0],
          vae: ['tu_vae', 0],
        },
        class_type: 'H3InjectVideoLatent',
        _meta: { title: 'Inject real frames into AV latent' },
      },
    }),

    // ═══════════════════════════════════════════════
    //  CONDITIONING: MiniMaxH3ImageToVideo (t2v style, WITHOUT first_frame)
    //  (fix 482) Key frame frame-0 removed: it was encoded from
    //  LOW-RESOLUTION first frame of source (plain resize to target +
    //  VAE encode), and in packed sequence of H3 sits close to t=0 and
    //  pulls early tokens towards its "blurry" version → first ~5 frames
    //  of result "swam", then effect faded. Content is already locked
    //  by source latent itself (denoise is low), and temporal chunk seams
    //  are anchored by node's own keyframes from resampled frames
    //  (anchor_conditioning creates list if absent) — as done by
    //  node author in reference upscale workflow (ReferenceToVideo without
    //  frame-0 keyframe).
    // ═══════════════════════════════════════════════
    'tu_cond': {
      inputs: {
        prompt,
        width: targetW,
        height: targetH,
        // length from the source video; (fix 381) latent branch — from server
        length: latentMode ? framesGrid : ['tu_src', 1],
        clip: ['tu_clip', 0],
        vae: ['tu_vae', 0],
      },
      class_type: 'MiniMaxH3ImageToVideo',
      _meta: { title: 'Conditioning (without first_frame — fix 482)' },
    },

    // ═══════════════════════════════════════════════
    //  MMH3 ULTIMATE UPSCALE — main pipeline node
    // ═══════════════════════════════════════════════
    'tu_up_param': {
      inputs: {
        model_name: p.upscaleModel || 'minimax_h3_latent_upscaler_3d_fp16.safetensors',
        width: targetW,
        height: targetH,
        device: 'cuda',
        precision: 'fp16',
        offload_model: true,
      },
      class_type: 'MMH3LatentUpscaleWithModelParams',
      _meta: { title: `Latent Upscale Params → ${targetW}×${targetH}` },
    },
    'tu_temporal': {
      inputs: {
        chunk_length: chunkLen,
        temporal_overlap: tempOverlap,
        anchor_strength: anchor,
      },
      class_type: 'MMH3TemporalSplitParams',
      _meta: { title: `Temporal Split (${chunkLen}f, overlap ${tempOverlap}f)` },
    },
    'tu_spatial': {
      inputs: {
        upscale_width: targetW,
        upscale_height: targetH,
        // specific_size: tile size is set, tile grid is computed automatically
        // from upscale_width/height and overlap (node splits along axes itself).
        tile_size_mode: 'specific_size',
        tile_width: tileSize,
        tile_height: tileSize,
        grid_rows: 1,
        grid_cols: 1,
        spatial_w_overlap: spatialOverlap,
        spatial_h_overlap: spatialOverlap,
        fade_width: fadeWidth,
        fade_height: fadeWidth,
        min_tile_size: minTile,
        // (fix 469) overlap_mode 'earlier' — node default and only
        // mode consistent with 'linear': new tile weight grows 0→1 from
        // seam inward (at seam — neighbor content, at tile body — new).
        // Pair 'later'+'linear' inverted the ramp: at inner edge of
        // band old content was taken, and beyond it — new → hard boundary
        // at overlap px from each seam = visible tile grid.
        // Relevant only for legacy mode: in sync_tiles (fix 481)
        // node ignores fade/overlap_mode/blend — tiles blend into shared
        // canvas after each step.
        overlap_mode: 'earlier',
        overlap_blend: 'linear',
        masked_area_noise: 0,
        brightness_match: false,
        dynamic_fade: 'off',
        dynamic_fade_min: 32,
        // (fix 481) SyncTile (MultiDiffusion): per-step tile blending +
        // shared noise canvas. Studio default is ON; legacy mode remains
        // available for A/B (syncTiles: false).
        sync_tiles: p.syncTiles !== false,
      },
      class_type: 'MMH3SpatialSplitParams',
      _meta: { title: `Spatial Split (tile ${tileSize}px, auto grid)` },
    },
    'tu_noise': {
      inputs: { noise_seed: seed },
      class_type: 'RandomNoise',
      _meta: { title: 'Random Noise' },
    },
    'tu_sampler': {
      inputs: { sampler_name: 'res_multistep' },
      class_type: 'KSamplerSelect',
      _meta: { title: 'Sampler (res_multistep)' },
    },
    'tu_sigmas': {
      inputs: {
        scheduler: 'simple',
        steps: p.steps ?? 2,
        denoise: p.denoise ?? 0.1,
        model: modelSrc,
      },
      class_type: 'BasicScheduler',
      _meta: { title: `BasicScheduler (${p.steps ?? 2} steps, denoise ${p.denoise ?? 0.1})` },
    },
    'tu_upscale': {
      inputs: {
        // (fix 478) model via KJ preview — frames of each step of
        // per-tile sampling inside node reach the tab preview window
        model: previewModel,
        conditioning: ['tu_cond', 0],
        // (fix 381) latent branch: seed is the loaded latent itself
        latent: [latentMode ? 'tu_lat' : 'tu_inject', 0],
        noise: ['tu_noise', 0],
        sampler: ['tu_sampler', 0],
        sigmas: ['tu_sigmas', 0],
        cfg: 1.0,
        latent_upscale_param: ['tu_up_param', 0],
        temporal_split_param: ['tu_temporal', 0],
        spatial_split_param: ['tu_spatial', 0],
      },
      class_type: 'MMH3UltimateUpscale',
      _meta: { title: 'MMH3 Ultimate Upscale' },
    },

    // ═══════════════════════════════════════════════
    //  DECODE + OUTPUT
    // ═══════════════════════════════════════════════
    'tu_decode': {
      inputs: {
        samples: ['tu_upscale', 0],
        vae: ['tu_vae', 0],
      },
      class_type: 'VAEDecode',
      _meta: { title: 'VAE Decode' },
    },
    'tu_out': {
      inputs: {
        frame_rate: 24,
        loop_count: 0,
        filename_prefix: `${sub}Minimax_Studio_tileupscale`,
        // (fix 386) format/quality — from studio [video] settings
        ...vhsEnc,
        save_metadata: false,
        // (fix 321) A/V sync: force_rate=24 on input PRESERVES duration
        // (VHS drops/duplicates frames), audio output of VHS_LoadVideo is original
        // full track → durations match, trim_to_audio not needed
        // (false → VHS pads audio apad to video length, -shortest = video).
        pingpong: false,
        save_output: true,
        images: ['tu_decode', 0],
        // (fix 488) latent branch: track full from VHS_LoadAudio;
        // normal — audio output of VHS_LoadVideo (pin 2, not cut —
        // frame_load_cap=0 there).
        audio: latentMode ? ['tu_audio', 0] : ['tu_src', 2],
      },
      class_type: 'VHS_VideoCombine',
      _meta: { title: 'Video Combine (tile upscale)' },
    },
  }
}
