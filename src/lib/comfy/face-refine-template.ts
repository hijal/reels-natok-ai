import { vhsEncodeInputs, type VideoFormatSettings } from '../video-format'

/**
 * Face Refine — repainting small faces in finished MiniMax H3 video.
 *
 * Node suite ComfyUI-H3-FaceRefine (Carasibana, MIT) — "FaceDetailer for video":
 * detect face per frame → crop so that the head occupies ~40% of canvas →
 * pass crops to H3 (MiniMaxH3ReferenceToVideo + H3InjectVideoLatent) →
 * regenerate them with low denoise (H3PerFrameDenoise, denoise scales
 * according to face size in frame) → paste back ONLY the face area
 * (H3FaceStitch, feather + color match).
 *
 * Graph (according to pack example_workflows, without NativeAudioLock — we don't have its package,
 * audio is taken from source):
 *
 *   VHS_LoadVideo ─→ H3FaceTrackCrop ─┬─ crops ─→ H3InjectVideoLatent ─┐
 *                     │                │              (av_latent from H3)│
 *                     │                ├─ canvas_w/h ─┐                │
 *                     │                ├─ frame_count ┤                │
 *                     │                └─ transform ─┤                │
 *   UNETLoader → LoraLoader ──────────────── model ──┼─→ H3PerFrameDenoise
 *   CLIPLoader ────────────────────────────────────┐  │        │
 *   VAELoader(video) ───────────────────────┐      │  │  av_latent
 *   VAELoader(audio) ──────────────────┐   │      │  │
 *   LoadImage (references) ──────────┐ │   │      │  │
 *                                     ▼ ▼   ▼      ▼  ▼
 *                     MiniMaxH3ReferenceToVideo → positive/LATENT
 *                                             → BasicGuider / SamplerCustomAdvanced
 *                                             → VAEDecode → H3FaceStitch
 *                                             → VHS_VideoCombine
 *
 * Denoise is NOT transferable from SDXL family: H3 uses flow matching with shift 12,
 * denoise 0.25 → effective sigma 0.800 (rewrites frame). Base
 * value 0.35–0.40 is recommended by the pack.
 *
 * Step count must match turbo LoRA: we have 4-step, so
 * steps defaults to 4 (pack example-workflow uses 8-step LoRA and 8 steps).
 */

export type FaceSelectMode =
  | 'largest_face'
  | 'smallest_face'
  | 'left_most'
  | 'right_most'
  | 'top_most'
  | 'bottom_most'
  | 'centre_most'
  | 'closest_to_xy'
  | 'detector_score'

export type FaceIdentityModel = 'insightface' | 'clip_vision' | 'ccip'
export type FacePasteRegion = 'face_only' | 'face_ellipse' | 'full_crop'
export type FaceUndetected = 'fade_out' | 'skip' | 'composite_anyway'

export interface FaceRefineParams {
  /** Filename in ComfyUI input/ (route copies source there). */
  sourceVideo: string
  /** Caption — source clip prompt (its scenes and characters). */
  prompt?: string
  /** Seed (-1 = random). */
  seed?: number
  /** H3 canvas, px. 512 is 2.25× cheaper than 768 in latent tokens. Default 512. */
  canvas?: number
  /** Base denoise for BasicScheduler. Default 0.35. */
  denoise?: number
  /** Sampling steps. Default 4 (turbo LoRA is 4-step). */
  steps?: number
  /** KSamplerSelect sampler. Default 'euler'. */
  sampler?: string
  /** Subject selection rule. */
  select?: FaceSelectMode
  /** Face rank index in rule rating (0-based). */
  selectIndex?: number
  /**
   * (fix 723) Face point specified by clicking on a source frame: source video
   * pixels + frame number. If set, rule is ignored, select becomes closest_to_xy,
   * and node picks the face closest to the point and tracks it across the entire clip.
   */
  facePoint?: { x: number; y: number; frame: number }
  /** Reference image filename in input/ — "this specific person". */
  identityReference?: string
  /** Face comparison method: insightface (photo) | clip_vision | ccip (anime). */
  identityModel?: FaceIdentityModel
  /** Identity match threshold (0 = model default). */
  identityThreshold?: number
  /** Keep single subject across crowds (identity_track). */
  identityTrack?: boolean
  /** Crop side as multiple of face height. Default 2.5. */
  cropFactor?: number
  /** Face detector confidence threshold. Default 0.35. */
  confidence?: number
  /** Detector model (H3FaceTrackCrop combo value, e.g. 'bbox\\face_yolov8m.pt'). */
  detector?: string
  /**
   * (fix 722) Fallback detector "in case face is not visible" (back, hood):
   * person/body model — head is taken from top of bounding box. 'none' — disabled.
   */
  fallbackDetector?: string
  /** (fix 722) Head center as fraction of face height below top of person box. */
  fallbackHeadFrac?: number
  /** Canvas mode: 'manual' — exactly canvas×canvas; 'auto_capped_768' — from crop. */
  canvasMode?: 'manual' | 'auto_no_downscale' | 'auto_capped_768'
  /** Region to paste back. Default 'face_only'. */
  pasteRegion?: FacePasteRegion
  /** Face mask dilation, px in canvas. Default 16. */
  maskDilation?: number
  /** Paste boundary blur, px in source. Default 6. */
  feather?: number
  /** Paste color match (0–1). Default 1. */
  colourMatch?: number
  /** Overall paste opacity (0–1). Default 1. */
  blend?: number
  /** Action for frames without a detected face. Default 'fade_out'. */
  undetectedFrames?: FaceUndetected
  /** Denoise multiplier for smallest faces. Default 1.0. */
  denoiseSmall?: number
  /** Denoise multiplier for large faces. Default 0.35. */
  denoiseLarge?: number
  /** Face height (source px) below which full denoise applies. Default 30. */
  facePxSmall?: number
  /** Face height (source px) above which large multiplier applies. Default 120. */
  facePxLarge?: number
  /** Strength interpolation gamma curve. Default 1.0. */
  gamma?: number
  /** Strength curve smoothing window, frames. Default 9. */
  smoothFrames?: number
  /** Character reference images (filenames in input/). */
  refImages?: string[]
  /** Reference size: 'match' | 'max' (max gives better identity). */
  refImageSize?: 'match' | 'max'
  /** Diffusion model name. */
  diffusionModel?: string
  /** Turbo LoRA (steps must match it). */
  lora?: string
  /** Turbo LoRA strength (from loras.json; default 1.0). */
  loraStrength?: number
  /**
   * Source dimensions/duration (probe from route). Needed for .latent sidecar:
   * final frames are encoded on ceil32 canvas (latent must be divisible
   * by 32 — verified by validateLatentFile), and duration is for silence when
   * source has no audio. If omitted, latent is not saved (legacy behavior).
   */
  width?: number
  height?: number
  frames?: number
  /** Output subfolder. */
  outputSubfolder?: string
  /** Output video format/quality ([video] config.ini). */
  videoFormat?: VideoFormatSettings
}

export const DEFAULT_FACE_DETECTOR = 'face_yolov8m.pt'

/** Default steps — tailored to our 4-step turbo LoRA. */
export const DEFAULT_FACE_STEPS = 4
/** Base denoise: 0.35–0.40 — recommended range of the pack. */
export const DEFAULT_FACE_DENOISE = 0.35

function pick<T extends string>(allowed: readonly T[], value: T | undefined, fallback: T): T {
  return value !== undefined && allowed.includes(value) ? value : fallback
}

export function buildFaceRefineWorkflow(p: FaceRefineParams): Record<string, unknown> {
  const canvas = Math.max(128, Math.min(1344, Math.round((p.canvas ?? 512) / 32) * 32))
  const steps = Math.max(1, Math.min(64, Math.round(p.steps ?? DEFAULT_FACE_STEPS)))
  const denoise = Math.max(0.01, Math.min(1, p.denoise ?? DEFAULT_FACE_DENOISE))
  const select = pick<FaceSelectMode>(
    ['largest_face', 'smallest_face', 'left_most', 'right_most', 'top_most', 'bottom_most', 'centre_most', 'closest_to_xy', 'detector_score'],
    p.select,
    'largest_face',
  )
  // (fix 723) Face click takes precedence over rule: it is "who specifically". Without
  // a point closest_to_xy has nothing to measure against (X/Y = 0,0 — top left corner), so
  // in that case we fall back to largest face.
  const point = p.facePoint
  const selectMode: FaceSelectMode = point
    ? 'closest_to_xy'
    : select === 'closest_to_xy'
      ? 'largest_face'
      : select
  const pointX = Math.max(0, Math.round(point?.x ?? 0))
  const pointY = Math.max(0, Math.round(point?.y ?? 0))
  const pointFrame = Math.max(0, Math.round(point?.frame ?? 0))
  const identityModel = pick<FaceIdentityModel>(['insightface', 'clip_vision', 'ccip'], p.identityModel, 'insightface')
  const pasteRegion = pick<FacePasteRegion>(['face_only', 'face_ellipse', 'full_crop'], p.pasteRegion, 'face_only')
  const undetectedFrames = pick<FaceUndetected>(['fade_out', 'skip', 'composite_anyway'], p.undetectedFrames, 'fade_out')
  const canvasMode = pick<'manual' | 'auto_no_downscale' | 'auto_capped_768'>(['manual', 'auto_no_downscale', 'auto_capped_768'], p.canvasMode, 'manual')
  const sub = p.outputSubfolder ? `${p.outputSubfolder}/` : ''
  const vhsEnc = vhsEncodeInputs(p.videoFormat)

  // Model chain: UNET → [turbo LoRA] → H3PerFrameDenoise.
  // Patched model goes to both BasicGuider and BasicScheduler — otherwise
  // per-frame denoise mask will not be applied (node won't complain, result
  // will simply be "almost clean").
  let modelSrc: [string, number] = ['fr_unet', 0]

  const modelNodes: Record<string, unknown> = {
    fr_unet: {
      inputs: {
        unet_name: p.diffusionModel || 'minimax_h3_fastvideo_vsa_datafree_1300step_4step_int8_convrot.safetensors',
        weight_dtype: 'default',
      },
      class_type: 'UNETLoader',
      _meta: { title: 'Diffusion Model' },
    },
    fr_clip: {
      inputs: { clip_name: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', type: 'minimax', device: 'default' },
      class_type: 'CLIPLoader',
      _meta: { title: 'Text Encoder' },
    },
    fr_vae_video: {
      inputs: { vae_name: 'minimax_h3_video_vae_int8_convrot.safetensors' },
      class_type: 'VAELoader',
      _meta: { title: 'Video VAE' },
    },
    fr_vae_audio: {
      inputs: { vae_name: 'minimax_h3_audio_vae_fp32.safetensors' },
      class_type: 'VAELoader',
      _meta: { title: 'Audio VAE' },
    },
  }

  if (p.lora) {
    modelNodes['fr_lora'] = {
      inputs: { lora_name: p.lora, strength_model: p.loraStrength ?? 1.0, model: modelSrc },
      class_type: 'LoraLoaderModelOnly',
      _meta: { title: `Turbo LoRA (${p.lora})` },
    }
    modelSrc = ['fr_lora', 0]
  }

  const refImages = (p.refImages ?? []).filter(Boolean).slice(0, 9)
  refImages.forEach((name, i) => {
    modelNodes[`fr_ref_${i}`] = {
      inputs: { image: name },
      class_type: 'LoadImage',
      _meta: { title: `Reference ${i + 1}` },
    }
  })

  // (fix 722) Live generation preview — same as on "Generation",
  // "Refine" and "Tile Upscale" tabs: KJ node ModelPreviewOverrideKJ at the end
  // of model chain sends its kj_preview_override events on each sampling
  // step; GenerationStatus fetches them via /api/comfy/preview.
  // Default previews are disabled in this build (--preview-method NoPreviews).
  // Model is taken from H3PerFrameDenoise (per-frame denoise mask), while
  // schedule (fr_sigmas) takes model WITHOUT wrapper — just like in Refine/Tile
  // Upscale: wrapper is needed only for sampling path. preview_frames is tracker
  // frame count (same INT as sent to H3 length), taeh3 is H3 taesd decoder.
  modelNodes['fr_preview'] = {
    inputs: {
      model: ['fr_denoise', 2],
      vae: ['fr_vae_video', 0],
      tiny_vae: 'taeh3.safetensors',
      max_resolution: 1024,
      jpeg_quality: 80,
      suppress_default_preview: true,
      preview_frames: ['fr_track', 6],
      preview_fps: 6,
    },
    class_type: 'ModelPreviewOverrideKJ',
    _meta: { title: 'Model Preview Override (fix 722)' },
  }

  return {
    // ═══════════════════════════════════════════════
    //  SOURCE
    // ═══════════════════════════════════════════════
    fr_src: {
      inputs: {
        video: p.sourceVideo,
        force_rate: 0,
        custom_width: 0,
        custom_height: 0,
        frame_load_cap: 0,
        skip_first_frames: 0,
        select_every_nth: 1,
      },
      class_type: 'VHS_LoadVideo',
      _meta: { title: 'Source Video' },
    },

    // ═══════════════════════════════════════════════
    //  FACE TRACKING + CROP
    // ═══════════════════════════════════════════════
    fr_track: {
      inputs: {
        images: ['fr_src', 0],
        detector: p.detector || DEFAULT_FACE_DETECTOR,
        confidence: Math.max(0.05, Math.min(0.95, p.confidence ?? 0.35)),
        crop_factor: Math.max(1.2, Math.min(8, p.cropFactor ?? 2.5)),
        canvas_width: canvas,
        canvas_height: canvas,
        canvas_mode: canvasMode,
        smooth_window: 21,
        size_smooth_window: 51,
        smooth_method: 'gaussian',
        size_mode: 'per_frame',
        // "This specific person": reference image + face matching.
        ...(p.identityReference
          ? { identity_reference: ['fr_identity', 0] }
          : {}),
        identity_track: p.identityTrack !== false,
        identity_threshold: p.identityThreshold ?? 0.28,
        select: selectMode,
        // (fix 723) Click point: X/Y — source frame pixels, frame_index —
        // frame on which it was clicked. Node measures on it and advances forward
        // to first frame with faces, then tracks selected face by continuity.
        X: pointX,
        Y: pointY,
        frame_index: pointFrame,
        // (fix 722) "Distant shots": if face not found (person turned away,
        // in hood) — take person box and treat its top as head.
        // Value must be from combo list (gathered by route via
        // /object_info), otherwise ComfyUI will reject prompt.
        fallback_detector: p.fallbackDetector || 'none',
        fallback_head_frac: Math.max(0, Math.min(1.5, p.fallbackHeadFrac ?? 0.5)),
        select_index: Math.max(0, p.selectIndex ?? 0),
        identity_model: identityModel,
        cut_detection: 'none',
        cut_threshold: 3,
        absent_shots: 'off',
      },
      class_type: 'H3FaceTrackCrop',
      _meta: { title: 'Face Track + Crop' },
    },

    // ═══════════════════════════════════════════════
    //  H3 CONDITIONING (character references + prompt)
    // ═══════════════════════════════════════════════
    fr_h3: {
      inputs: {
        clip: ['fr_clip', 0],
        vae: ['fr_vae_video', 0],
        audio_vae: ['fr_vae_audio', 0],
        prompt: p.prompt || '',
        width: ['fr_track', 4],
        height: ['fr_track', 5],
        length: ['fr_track', 6],
        ref_image_size: p.refImageSize === 'match' ? 'match' : 'max',
        ...Object.fromEntries(refImages.map((_, i) => [`ref_images.ref_image_${i}`, ['fr_ref_' + i, 0]])),
      },
      class_type: 'MiniMaxH3ReferenceToVideo',
      _meta: { title: 'H3 (prompt + references)' },
    },

    // ═══════════════════════════════════════════════
    //  CROPS → AV-LATENT VIDEO STREAM
    // ═══════════════════════════════════════════════
    fr_inject: {
      inputs: {
        av_latent: ['fr_h3', 1],
        images: ['fr_track', 0],
        vae: ['fr_vae_video', 0],
      },
      class_type: 'H3InjectVideoLatent',
      _meta: { title: 'Inject Video Latent' },
    },

    // ═══════════════════════════════════════════════
    //  PER-FRAME DENOISE (strength ~ face size)
    // ═══════════════════════════════════════════════
    fr_denoise: {
      inputs: {
        model: modelSrc,
        av_latent: ['fr_inject', 0],
        transform: ['fr_track', 1],
        denoise_multiplier_small_face: Math.max(0, Math.min(1, p.denoiseSmall ?? 1.0)),
        denoise_multiplier_large_face: Math.max(0, Math.min(1, p.denoiseLarge ?? 0.35)),
        scale_mode: 'absolute_px',
        face_px_small: Math.max(4, p.facePxSmall ?? 30),
        face_px_large: Math.max(8, p.facePxLarge ?? 120),
        gamma: Math.max(0.2, Math.min(4, p.gamma ?? 1.0)),
        smooth_frames: Math.max(1, Math.min(61, p.smoothFrames ?? 9)),
      },
      class_type: 'H3PerFrameDenoise',
      _meta: { title: 'Per-Frame Denoise' },
    },

    // ═══════════════════════════════════════════════
    //  SAMPLER
    // ═══════════════════════════════════════════════
    fr_sampler_sel: {
      inputs: { sampler_name: p.sampler || 'euler' },
      class_type: 'KSamplerSelect',
      _meta: { title: 'Sampler' },
    },
    fr_sigmas: {
      inputs: {
        model: ['fr_denoise', 2],
        scheduler: 'simple',
        steps,
        denoise,
      },
      class_type: 'BasicScheduler',
      _meta: { title: `Schedule (${steps} steps, denoise ${denoise})` },
    },
    fr_noise: {
      inputs: { noise_seed: p.seed ?? -1 },
      class_type: 'RandomNoise',
      _meta: { title: 'Noise' },
    },
    fr_guider: {
      // (fix 722) model with KJ preview wrapper; fr_sigmas — without it.
      inputs: { model: ['fr_preview', 0], conditioning: ['fr_h3', 0] },
      class_type: 'BasicGuider',
      _meta: { title: 'Guider' },
    },
    fr_sample: {
      inputs: {
        noise: ['fr_noise', 0],
        guider: ['fr_guider', 0],
        sampler: ['fr_sampler_sel', 0],
        sigmas: ['fr_sigmas', 0],
        latent_image: ['fr_denoise', 0],
      },
      class_type: 'SamplerCustomAdvanced',
      _meta: { title: 'Sampling' },
    },

    // ═══════════════════════════════════════════════
    //  DECODE + STITCH
    // ═══════════════════════════════════════════════
    fr_decode: {
      inputs: { samples: ['fr_sample', 0], vae: ['fr_vae_video', 0] },
      class_type: 'VAEDecode',
      _meta: { title: 'Decode' },
    },
    fr_stitch: {
      inputs: {
        base_images: ['fr_src', 0],
        refined_crops: ['fr_decode', 0],
        transform: ['fr_track', 1],
        paste_region: pasteRegion,
        mask_dilation: Math.max(0, Math.min(256, p.maskDilation ?? 16)),
        feather: Math.max(0, Math.min(256, p.feather ?? 6)),
        colour_match: Math.max(0, Math.min(1, p.colourMatch ?? 1.0)),
        blend: Math.max(0, Math.min(1, p.blend ?? 1.0)),
        undetected_frames: undetectedFrames,
      },
      class_type: 'H3FaceStitch',
      _meta: { title: 'Stitch Back' },
    },

    // ═══════════════════════════════════════════════
    //  OUTPUT (audio from source)
    // ═══════════════════════════════════════════════
    fr_out: {
      inputs: {
        images: ['fr_stitch', 0],
        audio: ['fr_src', 2],
        frame_rate: 24,
        loop_count: 0,
        filename_prefix: `${sub}Minimax_Studio_facerefine`,
        ...vhsEnc,
        save_metadata: false,
        pingpong: false,
        save_output: true,
      },
      class_type: 'VHS_VideoCombine',
      _meta: { title: 'Video Combine' },
    },

    // ═══════════════════════════════════════════════
    //  SAVE AV LATENT — for lossless reuse
    // ═══════════════════════════════════════════════
    // Sampler latent (fr_sample) is latent of face CROPS, not the final result:
    // the face-refine result consists of source frames with stitched faces
    // (fr_stitch). Therefore we construct .latent sidecar separately — VAE-encode
    // the final frames (same pattern as mp4 refine branch:
    // resize to ceil32 canvas >= source → VAEEncode) + source audio
    // (AudioOrSilent protects against silent sources) → AV latent → safetensors.
    // Metadata finalization will pick up .latent from outputs and write latent_file
    // to mp4 sidecar — subsequent refine/upscale of this video will follow
    // lossless path, bypassing h264 decode and repeated VAEEncode.
    ...(p.width && p.height
      ? {
          fr_ls_res: {
            inputs: {
              image: ['fr_stitch', 0],
              width: Math.ceil(p.width / 32) * 32,
              height: Math.ceil(p.height / 32) * 32,
              upscale_method: 'lanczos',
              keep_proportion: 'stretch',
              pad_color: '0, 0, 0',
              crop_position: 'center',
              divisible_by: 16,
              device: 'cpu',
            },
            class_type: 'ImageResizeKJv2',
            _meta: { title: `Output → ceil32 canvas (encoding)` },
          },
          fr_ls_enc: {
            inputs: { pixels: ['fr_ls_res', 0], vae: ['fr_vae_video', 0] },
            class_type: 'VAEEncode',
            _meta: { title: 'VAE Encode Output' },
          },
          fr_ls_asafe: {
            inputs: {
              audio: ['fr_src', 2],
              fallback_seconds: Number(((p.frames ?? 120) / 24).toFixed(2)),
            },
            class_type: 'MiniMaxH3AudioOrSilent',
            _meta: { title: 'Source audio (or silence)' },
          },
          fr_ls_aenc: {
            inputs: { audio: ['fr_ls_asafe', 0], vae: ['fr_vae_audio', 0] },
            class_type: 'VAEEncodeAudio',
            _meta: { title: 'Audio → latent' },
          },
          fr_ls_cat: {
            inputs: { video_latent: ['fr_ls_enc', 0], audio_latent: ['fr_ls_aenc', 0] },
            class_type: 'LTXVConcatAVLatent',
            _meta: { title: 'Final AV Latent' },
          },
          fr_ls_save: {
            inputs: {
              samples: ['fr_ls_cat', 0],
              filename_prefix: `${sub}latents/Minimax_Studio_facerefine`,
              vae_name: 'minimax_h3_video_vae_int8_convrot.safetensors',
            },
            class_type: 'MiniMaxStudioSaveAVLatent',
            _meta: { title: 'Save AV Latent (for lossless reuse)' },
          },
        }
      : {}),

    ...modelNodes,

    // Character reference image (for identity_reference).
    ...(p.identityReference
      ? {
          fr_identity: {
            inputs: { image: p.identityReference },
            class_type: 'LoadImage',
            _meta: { title: 'Identity Face Reference' },
          },
        }
      : {}),
  }
}
