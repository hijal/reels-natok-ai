import { vhsEncodeInputs, type VideoFormatSettings } from '../video-format' // (fix 386)
import { chainLatentCut } from './latent-cut' // (fix 392)
import { clampVedaSparsity, sanitizeVedaIndexList, buildCustomLoraNodes, getLastLoraOutput } from './minimax-h3-template' // (fix 399; LoRA helpers — fix 483)
// (fix 723) Sigma ladder / Pass 2 preset moved to a separate module without imports,
// so that the Refine tab can import them without pulling the entire template into the client bundle.
import { refineSigmaLadder } from './refine-sigmas'
/**
 * Refine — generative v2v upscale of finished video (Pass 2 latent scheme).
 *
 * Instead of a heavy LMS recipe (guide for entire clip → denoise 1.0 for 8 steps,
 * ~27k attention tokens and ~1.5 h for 3.9 s at 1080p), the source is encoded by
 * video-VAE at ITS OWN resolution and becomes the sampler seed — the same
 * role as the Pass 1 output in the "Generation" tab:
 *
 *   VHS_LoadVideo (24 fps) ─IMAGE→ align 17k+5 → Resize(/32) → VAEEncode
 *                           └AUDIO→ VHS_VideoCombine (audio without re-encode)
 *   Encoded latent ──→ MinimaxH3LatentUpscaler3D (target genW×genH, node
 *                      '46:26' in "Generation" tab)
 *   Empty AV latent ─→ Separate → audio latent of required length
 *   Concat(upscaled video, empty audio) ──→ SamplerCustomAdvanced
 *   (RandomNoise, euler, ManualSigmas = Pass 2 ladders: 0.9035…) →
 *   Separate → VAEDecode (video only) → [ImageCrop to nominal] → VHS
 *
 * (fix 376) Lossless branch: if source has a saved generation latent
 * (.latent file, latent_file field in meta; see fix 375),
 * the seed is built from IT (MiniMaxStudioLoadAVLatent) — h264 decode,
 * Resize and VAEEncode of the entire clip are skipped, audio part is also native.
 * mp4 is loaded only for the first frame (conditioning anchor). Then the pipeline
 * is identical: upscaler → Pass 2 ladder → decode. Fallback to mp4 path is
 * automatic (latent file missing/modified/VAE mismatch).
 *
 * Why this way:
 *  • Sequence = target resolution only (~15k tokens for 3.9 s at 1080p
 *    vs ~27k in guide scheme) — step cost = Pass 2 generation step cost.
 *  • 3–5 steps on Pass 2 ladders instead of 8 full steps.
 *  • First frame of source is ALWAYS a reference, but (fix 315) slot depends
 *    on presence of image references from source meta: with them, META-REFS
 *    occupy <Picture 1..k> (original generation order — like 'ref' mode of
 *    "Generation" tab, so that <Picture N> tags in prompt point to the same images),
 *    and the first frame comes LAST (<Picture k+1>); without meta-refs first frame =
 *    <Picture 1>, as before. Anchors palette/identity/materials during
 *    re-render; 'match' does not upscale — ~900 tokens.
 *  • Temporal grid: VAEEncode and EmptyMiniMaxH3LatentAV produce IDENTICAL
 *    latent_t only on 17k+5 grid (clips < 5 frames → 1 frame) — therefore
 *    frames are cropped in-graph to n ≡ 5 (mod 17) (AddGuide crop pattern),
 *    and the same value goes into length of Empty latent.
 *  • (fix 313) Audio is regenerated as in generation pass 2:
 *    source track → VAEEncodeAudio → into AV latent → sampler →
 *    VAEDecodeAudio → output. For silent source,
 *    MiniMaxH3AudioOrSilent substitutes silence (otherwise VHS_LoadVideo
 *    crashes VAEEncodeAudio). In "Chunked" mode, chunk audio is attached
 *    like video (chunk k-1 tail ⊕ new window, noise mask black on tail),
 *    and stitched chunk by chunk upon assembly.
 *  • Sigma ladders — Pass 2 benchmark (SIGMA_VARIANTS in "Generation" tab);
 *    soft start (σ_start 0.63, fix 199) over-smoothed — not used.
 *
 * Model chain = "Generation" tab chain:
 *   UNET → [LowVRAM] → [ChunkFF] → [custom LoRAs, incl. turbo] → SigmaShift
 *   → [SparseAttn] → AttentionBackend (+ KJ live preview)
 */
import { computeFinalDimensions, type FinalDimensions } from './minimax-h3-template'

/** Default caption (from LMS recipe doc; neutral enhance). */
export const DEFAULT_REFINE_PROMPT =
  'Enhance this video with sharp, crisp details while preserving a natural photorealistic appearance.'

/** (fix 316) Meta-ref slot caption: with imageIntent role from meta —
 *  meaningful, without role — generic (like fix 305/309). */
function metaRefCaption(slot: number, role: string): string {
  const r = role.trim()
  return r
    ? `<Picture ${slot}> is the reference image of ${r}. Keep this subject's appearance exactly.`
    : `<Picture ${slot}> is a reference image for style, subjects and appearance consistency.`
}

/** (fix 315) First frame anchor text: palette/lighting/style of source. */
function firstFrameCaption(slot: number): string {
  return `<Picture ${slot}> is the first frame of this same video. Reproduce its subjects, colors, materials, lighting and style exactly; keep the original appearance unchanged, only refine fine detail.`
}

// (fix 723) SIGMA_LADDERS and refineSigmaLadder moved to ./refine-sigmas
// (client Refine tab imports them from there as well).

export interface RefineParams {
  /** Source video filename in ComfyUI input/ (already copied by /api/comfy/refine route). */
  sourceVideo: string
  /** (fix 376) Path to saved AV latent of source, relative to
   *  output/ ComfyUI (latent_file field in .meta.json, file from
   *  MiniMaxStudioSaveAVLatent node of fix 372). If provided (route already
   *  validated: existence, safetensors header, VAE/frame count/
   *  resolution match with mp4) → sampler seed is built directly from latent,
   *  without h264 decode + Resize + VAEEncode of entire clip (lossless path).
   *  mp4 remains the source ONLY for the FIRST FRAME for conditioning. */
  sourceLatent?: string
  /** (fix 376) Source frames (ffprobe, 24 fps). In latent branch, length of
   *  conditioning/preview is calculated on server from this value — entire mp4
   *  is not loaded into graph. Required when sourceLatent is provided. */
  sourceFrames?: number
  /** Source dimensions in pixels (ffprobe on server) — for target calculation. */
  sourceWidth: number
  sourceHeight: number
  /** Target short side: 'same' = source resolution (sharp only),
   *  'x2' = doubled resolution (latent ×2 recipe), or 720 / 1080. */
  targetShortSide: 'same' | 'x2' | number
  /** Caption (default: enhance prompt). */
  prompt?: string
  /** Seed (-1 = random). */
  seed?: number
  /** Pass 2 sigma ladder: 3 (default) | 4 | 5 | 6 | 7 steps. */
  steps?: number
  /** σ_start of ladder (0.1–0.95): "how much noise to remove". undefined = standard. */
  sigmaStart?: number
  /** ("Chunked" mode) Skip first N frames of source — chunk start. */
  skipFrames?: number
  /** ("Chunked" mode) Load at most N frames — chunk length. 0 = all. */
  frameCap?: number
  /** ("Chunked" mode) Single chunk job: no audio in output (audio is added
   *  by stitcher from whole source) and prefix Minimax_Studio_refinepart. */
  chunkJob?: boolean
  /** Diffusion model filename (default — same as "Generation" tab). */
  diffusionModel?: string
  /** Output subfolder (gallery project folder; '' = common). */
  outputSubfolder?: string
  /** MiniMaxLowVRAMAttention (default true). */
  lowVramAttention?: boolean
  /** MiniMaxChunkFeedForward (default true). */
  chunkFeedForward?: boolean
  /** MiniMaxSparseAttention / Sol-Attn (default true). */
  sparseAttention?: boolean
  /** (fix 466) Sol-Attn: node settings (see MiniMaxH3Params). */
  sparseTau?: number
  sparseStartPercent?: number
  sparseEndPercent?: number
  sparseMinTokens?: number
  sparseExtraTokens?: number
  /** (fix 301) Veda Sparse Attention (default false). */
  vedaAttention?: boolean
  /** (fix 399) Veda: node settings (see MiniMaxH3Params). */
  vedaGeneratedSparsity?: string
  vedaReferenceSparsity?: string
  vedaFullAttentionLayers?: string
  vedaFullAttentionSteps?: string
  vedaVerbose?: boolean
  /** (fix 309, type — fix 311) Image references from source meta
   *  (ComfyUI input/ filenames + imageIntent role, can be '').
   *  (fix 315) Provided as <Picture 1..k> in original generation order,
   *  first frame of video is last (<Picture k+1>). */
  refImages?: Array<{ path: string; role: string }>
  /** (fix 323) Reference image size mode (ref_image_size of
   *  MiniMaxH3ReferenceToVideo node): 'match' — does not upscale reference
   *  (cheaper), 'max' — full resolution (more accurate identity).
   *  Default 'max' (user requirement). */
  refImageSize?: 'match' | 'max'
  /** (fix 386) Video output format/quality ([video] config.ini). */
  videoFormat?: VideoFormatSettings
  /** (fix 483) Custom LoRA from settings — chained customLoras
   *  together with turbo LoRA (standard record, ON by default), as in
   *  "Generation" tab (fix 44). */
  customLoras?: Array<{ name: string; strength: number }>
  /** (fix 483) Prompt suffix (trigger words of active LoRAs) —
   *  appended to the very end of conditioning prompt, after reference
   *  captions. Not included in meta (route stores clean prompt). */
  promptSuffix?: string
  /** (fix 492) Do not regenerate audio: mux ORIGINAL source track
   *  to output instead of decoding sampler audio latent. mp4 path —
   *  'r_asafe' (VHS_LoadVideo whole, silence if no track);
   *  latent path — decode native audio latent from .latent ('r_lsep', 1),
   *  i.e. pristine sound without aac/re-encode loss. Does not affect sampling:
   *  audio latent in seed remains identical. */
  keepOriginalAudio?: boolean
}

/**
 * Target geometry: scale source to target short side,
 * gen = ceil32(nominal) for latent, final — centered crop to
 * nominal (pattern of fix 124 in "Generation" tab).
 */
export function refineDimensions(
  srcW: number,
  srcH: number,
  targetShortSide: 'same' | 'x2' | number,
): FinalDimensions & { nominalW: number; nominalH: number } {
  const even = (n: number) => 2 * Math.round(n / 2)
  let nominalW: number
  let nominalH: number
  if (targetShortSide === 'same') {
    nominalW = even(srcW)
    nominalH = even(srcH)
  } else if (targetShortSide === 'x2') {
    nominalW = even(srcW * 2)
    nominalH = even(srcH * 2)
  } else {
    const short = Math.min(srcW, srcH)
    const scale = targetShortSide / short
    nominalW = even(srcW * scale)
    nominalH = even(srcH * scale)
  }
  const final = computeFinalDimensions(nominalW, nominalH)
  return { ...final, nominalW, nominalH }
}

/**
 * Build ComfyUI API-format workflow for Refine (v2v latent scheme).
 */
export function buildRefineWorkflow(p: RefineParams): Record<string, unknown> {
  const seed = !p.seed || p.seed < 0 ? Math.floor(Math.random() * 2 ** 31) : p.seed
  const vhsEnc = vhsEncodeInputs(p.videoFormat) // (fix 386)
  // ("light ×2" recipe, inspired by MMH3UltimateUpscale): steps=2 → instead of
  // ManualSigmas ladder, use BasicScheduler(2 steps, denoise 0.2) — noise
  // starts at ~20% of schedule, model only refines details; sampler
  // res_multistep. Full ×2 recipe: target 'x2' + steps=2.
  const light = p.steps === 2
  const ladder = refineSigmaLadder(p.steps ?? 3, p.sigmaStart)
  const basePrompt = (p.prompt ?? '').trim() || DEFAULT_REFINE_PROMPT
  // (fix 315) Slots preserve original generation numbering: meta-refs
  // go FIRST — ref_image_0..k-1 → <Picture 1..k> (array order =
  // references order in use-video-gen.ts metaReferences, where refImages[i]
  // mapped to ref_image_i → <Picture i+1>; filter type==='image' in
  // readMetaImageRefs preserves relative order). First frame of video —
  // LAST slot ref_image_k → <Picture k+1>. Thus <Picture N> tags,
  // preserved by sanitizeDraftPrompt (fix 310), point to the same
  // images as in the original. Without meta-refs: first frame = <Picture 1>.
  const metaRefs = (p.refImages ?? []).slice(0, 8) // max 8 external + 1 first frame = 9 total
  let prompt = basePrompt
  if (metaRefs.length > 0) {
    prompt += `\n\n` + metaRefs.map((r, i) => metaRefCaption(i + 1, r.role)).join(' ')
    prompt += `\n\n` + firstFrameCaption(metaRefs.length + 1)
  } else {
    prompt += `\n\n` + firstFrameCaption(1)
  }
  // (fix 483) Trigger words of custom LoRAs — to the end of prompt
  const pSuffix = p.promptSuffix?.trim()
  if (pSuffix) prompt += ` ${pSuffix}`
  const condNodeId = '46:11r'
  const final = refineDimensions(p.sourceWidth, p.sourceHeight, p.targetShortSide)
  const needsCrop = final.genW !== final.outW || final.genH !== final.outH
  const sub = p.outputSubfolder ? `${p.outputSubfolder}/` : ''

  // Encode source at ITS OWN resolution (cheap), to /32-grid — latent
  // without upscaler should directly match DiT grid (patch 2×2).
  const ceil32 = (n: number) => Math.max(32, Math.ceil(n / 32) * 32)
  // Latent 3D upscaler supports ONLY UPSCALE (scale >= 1.0):
  // when target is smaller than source (e.g. 1080p → 720p), encode source directly
  // in target grid — pixel resize before VAEEncode ('r_res' already in chain),
  // upscaler is not attached.
  const downscale = final.genW < ceil32(p.sourceWidth) || final.genH < ceil32(p.sourceHeight)
  const encW = downscale ? final.genW : ceil32(p.sourceWidth)
  const encH = downscale ? final.genH : ceil32(p.sourceHeight)
  // Upscaler not needed when gen is already equal to encoded size ('same').
  const needsUpscale = final.genW !== encW || final.genH !== encH

  // (fix 376) Lossless branch: seed from saved AV latent.
  const latentMode = !!p.sourceLatent
  // 17k+5 grid from actual source frames (equivalent to 'r_cap'), but
  // on server: in latent branch, entire mp4 is not loaded into graph. Formula is
  // the same as ComfyMathExpression 'r_cap': max(5, a - ((a - 5) % 17)).
  const srcFrames = Math.max(0, Math.round(p.sourceFrames ?? 0))
  const framesGrid = Math.max(5, srcFrames - ((srcFrames - 5) % 17))

  // ─── Model optimization chain: UNET → [LowVRAM] → [ChunkFF] ───
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
      inputs: { chunks: 2, seq_threshold: 4096, model: modelSrc },
      class_type: 'MiniMaxChunkFeedForward',
      _meta: { title: 'Chunk FeedForward' },
    }
    modelSrc = ['46:40', 0]
  }

  return {
    // ═══════════════════════════════════════════════
    //  MODEL LOADING + CHAIN (like "Generation" tab)
    // ═══════════════════════════════════════════════
    '46:30': {
      inputs: {
        unet_name:
          p.diffusionModel || 'minimax_h3_fastvideo_vsa_datafree_1300step_4step_int8_convrot.safetensors', // (fix 293)
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

    ...modelNodes,

    // Turbo LoRA — standard customLoras record (ON by default), as with
    // custom LoRAs; order set by loras.json.
    ...buildCustomLoraNodes(p.customLoras, modelSrc),
    '46:38': {
      inputs: { shift_video: 12, shift_audio: 3, model: getLastLoraOutput(p.customLoras, modelSrc) },
      class_type: 'MiniMaxH3SigmaShift',
      _meta: { title: 'Sigma Shift' },
    },
    // (fix 301) Veda or Sol-Attn
    ...(p.vedaAttention ? {
      '46:44': {
        inputs: {
          model: ['46:38', 0],
          predictor: 'minimax_h3_t2va_veda_8nfe_600step_preview_fp8.safetensors',
          // (fix 399) node parameters — from app settings
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
          model: ['46:38', 0],
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
        model: (p.vedaAttention || p.sparseAttention === true) ? ['46:44', 0] : ['46:38', 0],
      },
      class_type: 'ModelAttentionBackend',
      _meta: { title: 'Attention Backend' },
    },

    // ═══════════════════════════════════════════════
    //  SOURCE → LATENT SEED (Pass 1 role)
    //  (fix 376) Two paths:
    //   • latentMode — lossless: pristine AV latent of generation from
    //     .latent file (MiniMaxStudioLoadAVLatent). Full h264 decode +
    //     Resize + VAEEncode of entire clip are skipped; audio part of seed
    //     = audio latent of same generation (also without loss). Upscaler and
    //     further along pipeline — unchanged (masks/seams not in this mode).
    //   • regular path (no latent / mp4 modified / foreign video) — as before.
    // ═══════════════════════════════════════════════
    ...(latentMode ? {
      'r_lat': {
        inputs: { latent: p.sourceLatent },
        class_type: 'MiniMaxStudioLoadAVLatent',
        _meta: { title: 'Source AV Latent (lossless, fix 376)' },
      },
      // First frame of mp4 — only thing taken from pixel path:
      // conditioning anchor of palette/identity (fix 315). Loading
      // ONE frame (frame_load_cap: 1); copy of source in input/ already
      // made by route. Without upscaler ('same') seed = 'r_lat' itself.
      'r_f0src': {
        inputs: {
          video: p.sourceVideo,
          force_rate: 24,
          custom_width: 0,
          custom_height: 0,
          frame_load_cap: 1,
          skip_first_frames: 0,
          select_every_nth: 1,
        },
        class_type: 'VHS_LoadVideo',
        _meta: { title: 'Source: first frame (conditioning anchor)' },
      },
      // (fix 492) r_lsep needed even WITHOUT upscaler (target 'same'):
      // original sound is taken from audio half of latent (keepOriginalAudio).
      ...((needsUpscale || p.keepOriginalAudio) && {
        'r_lsep': {
          inputs: { av_latent: ['r_lat', 0] },
          class_type: 'LTXVSeparateAVLatent',
          _meta: { title: 'Separate AV Latent (loaded)' },
        },
      }),
      ...(needsUpscale && {
        // Same node/parameters as Pass 1→2 of "Generation" tab ('46:26').
        'r_up': {
          inputs: {
            model_name: 'minimax_h3_latent_upscaler_3d_fp16.safetensors',
            mode: 'target dimensions',
            'mode.width': final.genW,
            'mode.height': final.genH,
            align: 32,
            // enable_chunking — old input name; new versions of node (pinned
            // 40316cf) require enable_temporal_chunking + force_unload.
            enable_chunking: true,
            enable_temporal_chunking: true,
            force_unload: true,
            device: 'cuda',
            precision: 'fp16',
            latent: ['r_lsep', 0],
          },
          class_type: 'MinimaxH3LatentUpscaler3D',
          _meta: { title: `Latent Upscaler (3D) → ${final.genW}×${final.genH}` },
        },
        'r_cat': {
          inputs: {
            video_latent: ['r_up', 0],
            // generation audio latent from the same .latent file
            audio_latent: ['r_lsep', 1],
          },
          class_type: 'LTXVConcatAVLatent',
          _meta: { title: 'AV Latent (upscale of loaded latent)' },
        },
      }),
      // (fix 492) Original sound without regeneration: decode native
      // audio latent from source .latent (pristine, without mp4 aac losses).
      ...(p.keepOriginalAudio && {
        'r_aorig': {
          inputs: { samples: ['r_lsep', 1], vae: ['46:4', 0] },
          class_type: 'VAEDecodeAudio',
          _meta: { title: 'Original Audio (source audio latent)' },
        },
      }),
    } : {
      // force_rate 24: model timebase; H3 sources are already 24 fps —
      // normalization for imported 25/30 fps (pattern of fix 211).
      // (fix 322) VHS force_rate drops/duplicates frames PRESERVING
      // duration, and its audio output is full original track:
      // VAEEncodeAudio encodes audio of the same duration as video →
      // A/V sync preserved, trim_to_audio at output not needed.
      // ("Chunked" mode) skipFrames/frameCap cut chunk window.
      'r_src': {
        inputs: {
          video: p.sourceVideo,
          force_rate: 24,
          custom_width: 0,
          custom_height: 0,
          frame_load_cap: p.frameCap ?? 0,
          skip_first_frames: p.skipFrames ?? 0,
          select_every_nth: 1,
        },
        class_type: 'VHS_LoadVideo',
        _meta: { title: `Source (24 fps${p.skipFrames ? `, from frame ${p.skipFrames}` : ''})` },
      },
      'r_cnt': {
        inputs: { image: ['r_src', 0] },
        class_type: 'GetImageSizeAndCount',
        _meta: { title: 'Frames in source' },
      },
      // Align DOWN to model 17k+5 grid (AddGuide crop pattern):
      // only on it VAEEncode and EmptyMiniMaxH3LatentAV produce equal
      // latent_t — otherwise concat of video+audio latents desynchronizes.
      'r_cap': {
        inputs: {
          expression: 'max(5, a - ((a - 5) % 17))',
          'values.a': ['r_cnt', 3],
        },
        class_type: 'ComfyMathExpression',
        _meta: { title: 'Frames to 17k+5 grid' },
      },
      'r_img': {
        inputs: { image: ['r_src', 0], batch_index: 0, length: ['r_cap', 1] },
        class_type: 'ImageFromBatch',
        _meta: { title: 'Grid aligned frames' },
      },
      // Resize to /32 encoding grid (pattern 'extv_tres' in Extend tab).
      'r_res': {
        inputs: {
          image: ['r_img', 0],
          width: encW,
          height: encH,
          upscale_method: 'lanczos',
          keep_proportion: 'stretch',
          pad_color: '0, 0, 0',
          crop_position: 'center',
          divisible_by: 16,
          device: 'cpu',
        },
        class_type: 'ImageResizeKJv2',
        _meta: { title: `Source → ${encW}×${encH} (encode)` },
      },
      'r_enc': {
        inputs: { pixels: ['r_res', 0], vae: ['46:3', 0] },
        class_type: 'VAEEncode',
        _meta: { title: 'VAE Encode Source' },
      },
      // (fix 313) Audio is regenerated: source track protected with
      // MiniMaxH3AudioOrSilent (for silent video accessing waveform in
      // VHS_LoadVideo throws exception and crashed VAEEncodeAudio — earlier
      // VHS_VideoCombine simply skipped mux, now we substitute silence)
      // → VAEEncodeAudio → into AV latent below.
      'r_asafe': {
        inputs: { audio: ['r_src', 2], fallback_seconds: 5.0 },
        class_type: 'MiniMaxH3AudioOrSilent',
        _meta: { title: 'Source audio (or silence)' },
      },
      'r_aenc': {
        inputs: { audio: ['r_asafe', 0], vae: ['46:4', 0] },
        class_type: 'VAEEncodeAudio',
        _meta: { title: 'Audio → latent (fix 313)' },
      },
      // (fix 313: nodes r_len/r_spl removed — audio latent is no longer empty)
      ...(needsUpscale && {
        // Same node/parameters as Pass 1→2 of "Generation" tab ('46:26').
        'r_up': {
          inputs: {
            model_name: 'minimax_h3_latent_upscaler_3d_fp16.safetensors',
            mode: 'target dimensions',
            'mode.width': final.genW,
            'mode.height': final.genH,
            align: 32,
            enable_chunking: true,
            enable_temporal_chunking: true,
            force_unload: true,
            device: 'cuda',
            precision: 'fp16',
            latent: ['r_enc', 0],
          },
          class_type: 'MinimaxH3LatentUpscaler3D',
          _meta: { title: `Latent Upscaler (3D) → ${final.genW}×${final.genH}` },
        },
      }),
      'r_cat': {
        inputs: {
          video_latent: [needsUpscale ? 'r_up' : 'r_enc', 0],
          // (fix 313) real source audio, encoded by audio-VAE
          audio_latent: ['r_aenc', 0],
        },
        class_type: 'LTXVConcatAVLatent',
        _meta: { title: 'AV Latent (sampler seed)' },
      },
    }),
    // ─── Conditioning: meta-refs (<Picture 1..k>) + FIRST FRAME of video
    // as LAST slot (<Picture k+1>; without meta-refs — <Picture 1>) —
    // appearance anchor (fix 315). Same node as in 'ref' mode of
    // "Generation" tab ('46:11'): latent output is not used, only
    // conditioning. (fix 323) Reference image size mode — parameter
    // refImageSize ('match' does NOT upscale reference, default 'max'). ───
    '46:4': {
      inputs: { vae_name: 'minimax_h3_audio_vae_fp32.safetensors' },
      class_type: 'VAELoader',
      _meta: { title: 'VAE (audio)' },
    },
    'r_f0': {
      inputs: {
        // (fix 376) latent branch: frame is taken from single-frame loader
        // 'r_f0src' (entire mp4 not loaded); mp4 branch — from 'r_img'.
        image: latentMode ? ['r_f0src', 0] : ['r_img', 0],
        batch_index: 0,
        length: 1,
      },
      class_type: 'ImageFromBatch',
      _meta: { title: `First frame → <Picture ${metaRefs.length + 1}>` },
    },
    // (fix 309, slots — fix 315) LoadImage nodes for refs from meta:
    // <Picture 1..k> — original numbering of original generation
    ...Object.fromEntries(
      metaRefs.map((r, i) => [`r_ref_${i}`, {
        inputs: { image: r.path },
        class_type: 'LoadImage',
        _meta: { title: `Reference ${i + 1} (from meta)` },
      }]),
    ),
    '46:11r': {
      inputs: {
        prompt,
        width: final.genW,
        height: final.genH,
        // (fix 376) latent branch: length from server (mp4 frames already on
        // 17k+5 grid — matches T of loaded latent); mp4 branch —
        // from graph ('r_cap').
        length: latentMode ? framesGrid : ['r_cap', 1],
        ref_image_size: p.refImageSize ?? 'max', // (fix 323)
        clip: ['46:15', 0],
        vae: ['46:3', 0],
        audio_vae: ['46:4', 0],
        // (fix 315) Meta-refs first (ref_image_0..k-1 = <Picture 1..k>),
        // first frame — last (ref_image_k = <Picture k+1>).
        // (fix 587) In latent chain first frame anchor is NOT included
        // (test: remove effect on softness/sharpness of refine result).
        ...Object.fromEntries(
          metaRefs.map((_, i) => [`ref_images.ref_image_${i}`, [`r_ref_${i}`, 0]]),
        ),
        ...(!latentMode && { [`ref_images.ref_image_${metaRefs.length}`]: ['r_f0', 0] }),
      },
      class_type: 'MiniMaxH3ReferenceToVideo',
      _meta: { title: latentMode
        ? `Conditioning (${metaRefs.length} meta-refs, without frame anchor)`
        : `Conditioning (${1 + metaRefs.length} refs: meta + frame)` },
    },

    // ═══════════════════════════════════════════════
    //  SAMPLER (RandomNoise, euler, ManualSigmas = Pass 2)
    // ═══════════════════════════════════════════════
    '46:31': {
      inputs: { noise_seed: seed },
      class_type: 'RandomNoise',
      _meta: { title: 'Random Noise' },
    },
    '46:18': {
      inputs: { sampler_name: light ? 'res_multistep' : 'euler' },
      class_type: 'KSamplerSelect',
      _meta: { title: `KSampler (${light ? 'res_multistep' : 'euler'})` },
    },
    '46:33': light
      ? {
          inputs: { scheduler: 'simple', steps: 2, denoise: 0.2, model: ['46:37', 0] },
          class_type: 'BasicScheduler',
          _meta: { title: 'Light pass: 2 steps, denoise 0.2' },
        }
      : {
          inputs: { sigmas: ladder },
          class_type: 'ManualSigmas',
          _meta: { title: `Pass 2 Sigmas (${ladder.split(',').length - 1} steps)` },
        },
    '12': {
      inputs: {
        model: ['46:37', 0],
        vae: ['46:3', 0],
        tiny_vae: 'taeh3.safetensors',
        max_resolution: 1024,
        jpeg_quality: 80,
        suppress_default_preview: true,
        // As on "Generation" tab ('46:19'): preview covers entire video
        // (frames on 17k+5 grid; (fix 376) in latent branch — from server),
        // playback 6 fps.
        preview_frames: latentMode ? framesGrid : ['r_cap', 1],
        preview_fps: 6,
      },
      class_type: 'ModelPreviewOverrideKJ',
      _meta: { title: 'Model Preview Override' },
    },
    '46:29': {
      inputs: { model: ['12', 0], conditioning: [condNodeId, 0] },
      class_type: 'BasicGuider',
      _meta: { title: 'Guider' },
    },
    '46:21': {
      inputs: {
        noise: ['46:31', 0],
        guider: ['46:29', 0],
        sampler: ['46:18', 0],
        sigmas: ['46:33', 0],
        // (fix 376) Seed: latent branch without upscaler ('same') — the
        // loaded AV latent ('r_lat') itself; with upscaler — 'r_cat' (upscale of
        // video part + native audio). mp4 branch — 'r_cat', as before.
        latent_image: latentMode
          ? (needsUpscale ? ['r_cat', 0] : ['r_lat', 0])
          : ['r_cat', 0],
      },
      class_type: 'SamplerCustomAdvanced',
      _meta: { title: 'Refine Sampler (Pass 2)' },
    },

    // (fix 471) Save AV latent of result — repeated refine and
    // tile upscale of this video starts from pristine latent
    // (lossless), as in normal generation ('46:49'). Finalizing meta
    // will pick up .latent from outputs and write latent_file in sidecar.
    // In legacy chunkJob (per-chunk refinepart) latent is only a window,
    // we do not save it.
    ...(!p.chunkJob && {
      'r_savelat': {
        inputs: {
          samples: ['46:21', 0],
          filename_prefix: `${sub}latents/Minimax_Studio_refine`,
          vae_name: 'minimax_h3_video_vae_int8_convrot.safetensors',
        },
        class_type: 'MiniMaxStudioSaveAVLatent',
        _meta: { title: 'Save AV Latent (for lossless refine)' },
      },
    }),

    // ═══════════════════════════════════════════════
    //  DECODE (video only) + EXACT CROP
    // ═══════════════════════════════════════════════
    '46:35': {
      inputs: { av_latent: ['46:21', 0] },
      class_type: 'LTXVSeparateAVLatent',
      _meta: { title: 'Separate AV Latent' },
    },
    '46:25': {
      inputs: { samples: ['46:35', 0], vae: ['46:3', 0] },
      class_type: 'VAEDecode',
      _meta: { title: 'Decode Video' },
    },
    // (fix 313) Decode audio latent of sampler — like '46:14' in 2nd
    // pass of generation (minimax-h3-template.ts).
    'r_adec': {
      inputs: { samples: ['46:35', 1], vae: ['46:4', 0] },
      class_type: 'VAEDecodeAudio',
      _meta: { title: 'Decode Audio (fix 313)' },
    },
    ...(needsCrop && {
      '46:48': {
        inputs: {
          image: ['46:25', 0],
          width: final.outW,
          height: final.outH,
          x: final.cropX,
          y: final.cropY,
        },
        class_type: 'ImageCrop',
        _meta: { title: `Exact crop → ${final.outW}×${final.outH}` },
      },
    }),

    // ═══════════════════════════════════════════════
    //  OUTPUT: video + audio. (fix 313) In whole mode audio =
    //  regenerated by sampler (r_adec), as in 2nd pass of
    //  generation. In legacy chunkJob path audio is added by stitcher from
    //  original (such chunks do not generate audio).
    // ═══════════════════════════════════════════════
    '45': {
      inputs: {
        frame_rate: 24,
        loop_count: 0,
        filename_prefix: `${sub}${p.chunkJob ? 'Minimax_Studio_refinepart' : 'Minimax_Studio_refine'}`,
        // (fix 386) format/quality — from [video] studio settings
        ...vhsEnc,
        save_metadata: false,
        pingpong: false,
        save_output: true,
        images: needsCrop ? ['46:48', 0] : ['46:25', 0],
        // (fix 313) regenerated audio instead of source track.
        // (fix 492) keepOriginalAudio — mux ORIGINAL track: mp4 path
        // — 'r_asafe' (VHS_LoadVideo loads whole source, frame_load_cap=0
        // — track is not cut; silence if none), latent path — decode
        // native audio latent ('r_aorig').
        ...(p.chunkJob
          ? {}
          : { audio: p.keepOriginalAudio ? [latentMode ? 'r_aorig' : 'r_asafe', 0] : ['r_adec', 0] }),
      },
      class_type: 'VHS_VideoCombine',
      _meta: { title: p.chunkJob ? 'Video Combine (chunk)' : 'Video Combine (refine)' },
    },
  }
}

/* ═══════════════════════════════════════════════════════════
 *  "Chunked" mode v2 (fix 253) — latent masking chain.
 *
 *  Single workflow for entire video (like extension in fix 252): chunk 0 —
 *  standard v2v refine of window [0, T); chunk k>0 = [preserved tail of sampler
 *  output k−1 (O frames, mask 0)] ⊕ [encoded source window
 *  without first O frames (mask 1)]. Seam lives INSIDE single latent —
 *  no pixel stitching between chunks, chunk files are joined by
 *  hard concatenation; audio — from whole original (stitching).
 *
 *  Geometry: O = 39 (17k+5 grid, 12 tokens); window T = grid around
 *  chunkSeconds×24; new chunk content = T − O frames (for chunk 0 — T).
 *  Tokens: tok(F) = ((F−5)/17)·5+2; audio steps = round(F·5/3).
 *
 *  (fix 314) Latent stitching + segmented decode — SINGLE output file.
 *  Previously each window was decoded into its own refinepart_<k> (h264), and client
 *  stitched them with ffmpeg via RE-ENCODING — double lossy pass.
 *  Now: sampler outputs css_k are concatenated by LatentConcat in time
 *  (window k>0 head is cut by actual overlap overlap_k tokens —
 *  seams are continuous thanks to latent chain), full latent is split into
 *  segments of SEG_DECODE_TOK tokens (VRAM savings), each decoded by
 *  its own VAEDecode, frames concatenated with ImageBatchMulti, and SINGLE
 *  VHS_VideoCombine encodes h264 once. Audio mirrors: concatenate
 *  audio latents → single VAEDecodeAudio → audio into same combine.
 *  ffmpeg stage (/api/comfy/refine/stitch) is not called by new workflow.
 */
export interface ChunkedRefineParams {
  sourceVideo: string
  /** (fix 382) Path to saved AV latent of source (relative to
   *  output/, latent_file field in meta; route validated and passed
   *  sourceWidth/sourceHeight = LATENT canvas). Windows are cut by TOKENS from
   *  loaded latent (LatentCut) instead of pixel slices + VAEEncode:
   *  no h264 decode and re-encoding. Window audio — slices of
   *  generation audio latent (dim 'x'). mp4 loaded as single frame
   *  (conditioning anchor). Latent token boundaries calculated EXACTLY by
   *  VAE positional pattern (fix 468); off-grid skip (plan back-branch)
   *  rounded down by ≤17 frames — audio slices and seam arithmetic
   *  calculated from same effective boundaries. */
  sourceLatent?: string
  sourceWidth: number
  sourceHeight: number
  /** Total frames in source (ffprobe, 24 fps) — window plan; in latent branch
   *  (fix 382) also token count of full latent. */
  sourceFrames: number
  targetShortSide: 'same' | 'x2' | number
  /** Desired chunk window duration in seconds (3 | 5 | 8, default 5). */
  chunkSeconds?: number
  /** Caption — passed ONLY to window 0 (first prompt of chain, describes
   *  video start); windows 1+ receive only anchor captions of references,
   *  without plot text — to avoid confusing model with descriptions of later scenes.
   *  Tags <Picture N> from meta are preserved by
   *  sanitizeDraftPrompt (fix 310) and valid thanks to fix 315:
   *  <Picture 1..k> = refs from meta (original order), <Picture k+1> =
   *  first frame of video. */
  prompt?: string
  seed?: number
  steps?: number
  /** σ_start of ladder (0.1–0.95): "how much noise to remove". undefined = standard. */
  sigmaStart?: number
  diffusionModel?: string
  outputSubfolder?: string
  lowVramAttention?: boolean
  chunkFeedForward?: boolean
  sparseAttention?: boolean
  // (fix 466) Sol-Attn: node settings (see MiniMaxH3Params)
  sparseTau?: number
  sparseStartPercent?: number
  sparseEndPercent?: number
  sparseMinTokens?: number
  sparseExtraTokens?: number
  vedaAttention?: boolean // (fix 301)
  // (fix 399) Veda: node settings (see MiniMaxH3Params)
  vedaGeneratedSparsity?: string
  vedaReferenceSparsity?: string
  vedaFullAttentionLayers?: string
  vedaFullAttentionSteps?: string
  vedaVerbose?: boolean
  /** (fix 305, type — fix 311) Image references from source meta
   *  (ComfyUI input/ filenames + imageIntent role, can be '').
   *  (fix 315) Provided as <Picture 1..k> (original generation order)
   *  on all windows, first frame — <Picture k+1>. */
  refImages?: Array<{ path: string; role: string }>
  /** (fix 323) Reference image size mode (ref_image_size), as in
   *  RefineParams: 'match' (cheaper) | 'max' (more accurate). Default 'max'. */
  refImageSize?: 'match' | 'max'
  /** (fix 386) Video output format/quality ([video] config.ini). */
  videoFormat?: VideoFormatSettings
  /** (fix 483) LoRA from settings — customLoras chain (including
   *  turbo LoRA if enabled), as in buildRefineWorkflow. */
  customLoras?: Array<{ name: string; strength: number }>
  /** (fix 483) Prompt suffix (LoRA triggers) — appended to prompt of
   *  EVERY window in chain (both plot of window 0 and anchors of windows 1+),
   *  otherwise later windows would refine without LoRA style. Not included in meta. */
  promptSuffix?: string
  /** (fix 492) Original audio instead of regenerated: source track is
   *  muxed to final combine (mp4 — 'r_src' pin 2 through
   *  MiniMaxH3AudioOrSilent; latent — decode of audio latent 'r_lsep'). */
  keepOriginalAudio?: boolean
}

/** Chain overlap (17k+5 grid): preserved head of chunk k>0. */
export const CHAIN_OVERLAP = 39

/**
 * (fix 255) Sampler nodes by stages for progress tracker:
 * "Chunked" → cs_0…cs_{n−1} by plan windows (same planChunkWindows
 * parameters as builder; window always has same name, even if single).
 */
export function refineChunkStages(sourceFrames: number, chunkSeconds?: number): string[][] {
  const windows = planChunkWindows(sourceFrames, chunkSeconds ?? 5)
  return windows.map((_, k) => [`cs_${k}`])
}

const snapUpGrid = (n: number) => {
  let x = Math.max(5, Math.round(n))
  while ((x - 5) % 17 !== 0) x += 1
  return x
}
const alignDownG = (n: number) => (n < 5 ? Math.max(1, n) : 5 + 17 * Math.floor((n - 5) / 17))
const tokOf = (frames: number) => Math.round(((frames - 5) / 17) * 5 + 2)

/** Window plan: [{skip, cap}] — all cap on grid; coverage up to N−16 max. */
export function planChunkWindows(
  totalFrames: number,
  chunkSeconds: number,
): Array<{ skip: number; cap: number }> {
  const target = Math.max(3, Math.min(15, chunkSeconds)) * 24
  const T = snapUpGrid(target)
  if (totalFrames <= T + 56) return [{ skip: 0, cap: alignDownG(totalFrames) }]
  const windows: Array<{ skip: number; cap: number }> = []
  let s = 0
  while (true) {
    const remaining = totalFrames - s
    if (remaining <= T + 56) {
      const cap = alignDownG(remaining)
      if (cap < 22) {
        const back = Math.max(0, totalFrames - T)
        windows.push({ skip: back, cap: Math.min(T, alignDownG(totalFrames - back)) })
      } else {
        windows.push({ skip: s, cap })
      }
      break
    }
    windows.push({ skip: s, cap: T })
    s += T - CHAIN_OVERLAP
  }
  return windows
}

export function buildChunkedRefineWorkflow(p: ChunkedRefineParams): Record<string, unknown> {
  const seed = !p.seed || p.seed < 0 ? Math.floor(Math.random() * 2 ** 31) : p.seed
  const vhsEnc = vhsEncodeInputs(p.videoFormat) // (fix 386)
  // (fix 272) SIGMA_LADDERS (σ_start 0.9035) — as in D-version (working).
  // Latent chain + tail of previous render ensures continuity;
  // high σ gives model freedom for detail.
  const light = p.steps === 2
  const ladder = refineSigmaLadder(p.steps ?? 3, p.sigmaStart)
  const basePrompt = (p.prompt ?? '').trim() || DEFAULT_REFINE_PROMPT
  // (fix 315, replaces layout of fix 305) Identity anchor on ALL
  // windows: slots preserve original generation numbering — meta-refs
  // FIRST (ref_image_0..k-1 → <Picture 1..k>, array order = order
  // of references in original generation, see comment in buildRefineWorkflow),
  // FIRST FRAME of video — last (<Picture k+1>; without meta-refs —
  // <Picture 1>). Conditioning of each window is built by MiniMaxH3ReferenceToVideo
  // (same node as 'ref' mode of "Generation" tab and refine "Whole").
  // Without anchor, at σ_start 0.9035 model remembered character only from text
  // and "over-acted" them from chunk to chunk. Tags <Picture N> from meta prompt
  // preserved by sanitizeDraftPrompt (fix 310) and point to same
  // images as in original; slot captions added here (fix 316).
  const metaRefs = (p.refImages ?? []).slice(0, 8) // max 8 external + 1 first frame = 9 total
  const captions =
    (metaRefs.length > 0
      ? metaRefs.map((r, i) => metaRefCaption(i + 1, r.role)).join(' ') + '\n\n'
      : '') + firstFrameCaption(metaRefs.length + 1)
  // (fix 483) Trigger words of custom LoRAs — suffix for window prompts
  const pSuffix = p.promptSuffix?.trim() ? ` ${p.promptSuffix!.trim()}` : ''
  const promptFirst = basePrompt + `\n\n` + captions + pSuffix
  // Plot prompt — only to window 0 (covers start of video that
  // first chain prompt describes). Windows 1+ receive ONLY anchor
  // captions of references: chain prompt describes scenes not present
  // in these windows, confusing model with mismatches. Latent seed + anchor
  // of first frame hold content without text guide.
  // (fix 483) LoRA triggers (pSuffix) — on ALL windows, otherwise windows 1+
  // would refine without active LoRA style.
  const promptRest = captions + pSuffix
  const windows = planChunkWindows(p.sourceFrames, p.chunkSeconds ?? 5)
  const sub = p.outputSubfolder ? `${p.outputSubfolder}/` : ''

  const final = refineDimensions(p.sourceWidth, p.sourceHeight, p.targetShortSide)
  const needsCrop = final.genW !== final.outW || final.genH !== final.outH
  const ceil32 = (n: number) => Math.max(32, Math.ceil(n / 32) * 32)
  // Upscaler only increases (scale >= 1.0): when target is smaller than source,
  // encode windows directly in target grid, upscaler is not attached.
  const downscale = final.genW < ceil32(p.sourceWidth) || final.genH < ceil32(p.sourceHeight)
  const encW = downscale ? final.genW : ceil32(p.sourceWidth)
  const encH = downscale ? final.genH : ceil32(p.sourceHeight)
  const needsUpscale = final.genW !== encW || final.genH !== encH
  const lw = Math.max(1, Math.round(final.genW / 16))
  const lh = Math.max(1, Math.round(final.genH / 16))
  /**
   * (fix 263) Length of preserved window HEAD in tokens.
   *
   * Before 263: oTok = tokOf(CHAIN_OVERLAP) = 12 tokens — fixed number,
   * while slice of decoded output was made by CHAIN_OVERLAP = 39 FRAMES.
   * These values were unrelated: 12 tokens ≈ 39 frames (by framesFromTok), but
   * since sTok = tokOf(40) = 12 and tTok − sTok = 24−12 = 12, new content
   * = 12 tokens = 39 frames, not expected 40. At T=124: sTok = 26,
   * new = 37−26 = 11 tokens = 36 frames, not 85.
   *
   * Now: oTok = tokOf(CHAIN_OVERLAP) (head = CHAIN_OVERLAP frames),
   * new content = tTok − oTok tokens (entire rest of window), decode slice
   * = framesFromTok(oTok) frames. Encoded window is NOT sliced — mask
   * is black on head, white on new. Sampler refines entire window, head
   * remains as is (context), new content — is refined.
   * Zero duplicates at the seam.
   */
  const oTok = Math.max(1, tokOf(CHAIN_OVERLAP))

  /**
   * (fix 314) Positional frame pattern of H3 video-VAE:
   * FRAME_PER_TOKEN = (1, 4, 4, 4, 4) (comfy.ldm.minimax.model, see
   * MMH3_Split_Upscale in Comfyui_Minimax_h3_latent_Upscaler): token k
   * covers FPT[k%5] frames, 5 tokens = 17 frames. All slice/segment
   * boundaries below are multiples of 5 tokens from start of latent → segment frames
   * sum EXACTLY (no duration drift).
   */
  const FPT = [1, 4, 4, 4, 4]
  const framesForTok = (t: number) => {
    let s = 0
    for (let i = 0; i < t; i++) s += FPT[i % 5]
    return s
  }
  /** (fix 468) Smallest number of tokens covering f frames. */
  const tokCover = (f: number) => {
    let t = 0
    while (framesForTok(t) < f) t++
    return t
  }
  /** Largest number of head tokens covering AT MOST f frames
   *  (conservatively: better ≤3 duplicate frames of preserved head — this
   *  is bit-for-bit content of tail from previous render — than hole in new frames). */
  const tokHeadAtMost = (f: number) => {
    let t = 0
    while (framesForTok(t + 1) <= f) t++
    return Math.max(1, t)
  }
  /** (fix 314) Segment size for segmented decode, tokens (multiple of 5).
   *  25 tokens ≈ 85 frames: previously windows up to
   *  tokOf(T)=37 tokens (chunkSeconds=5 → T=124) were decoded piecemeal — worked;
   *  25 is conservatively lower, and multiple of 5 maintains positional FPT pattern
   *  (see above): each segment starts with k%5==0, frames sum without drift. */
  const SEG_DECODE_TOK = 25

  // ─── (fix 382) Lossless branch: windows from saved latent ───
  const latentMode = !!p.sourceLatent
  // (fix 468) Full latent tokens — exact by FPT: tokOf is linear
  // approximation, errs by ±1 token on non-grid lengths.
  const totalTok = Math.max(1, tokCover(Math.max(5, p.sourceFrames ?? 0)))
  /** Window start token index — EXACT iteration by FPT (fix 468).
   *  tokOf(skip) is an approximation: planned skip 85/170/… (step T−39) are not
   *  on 17k+5 grid, and tokOf(85) gave 26 instead of exact 25 — window started
   *  a frame later, and its tokens fell into final latent with a phase shift
   *  in VAE positional pattern (1,4,4,4,4) → flicker on windows 1+ in
   *  latent branch (in mp4 branch slices are pixel-based, no phase shift — so
   *  clean there). Take largest t with framesForTok(t) ≤ skip (off-grid skip
   *  rounded DOWN — overlap only grows, no holes). */
  const tokOfSkip = (skip: number) =>
    skip <= 0 ? 0 : Math.min(tokHeadAtMost(skip), Math.max(0, totalTok - 1))
  /** Geometry of window k: effective (actual) start/length frames, number
   *  of tokens and audio steps. mp4 path: effSkip/effCap = plan (exact frames);
   *  latent path: alignment to token boundaries of full latent. */
  const winGeo = windows.map((w) => {
    if (!latentMode) {
      return {
        effSkip: w.skip,
        effCap: w.cap,
        tTok: tokOf(w.cap),
        aTotal: Math.round((w.cap * 5) / 3),
        sTok: 0,
        aStart: 0,
      }
    }
    const sTok = tokOfSkip(w.skip)
    const tTok = Math.max(1, Math.min(tokOf(w.cap), totalTok - sTok))
    const effSkip = framesForTok(sTok)
    const effCap = framesForTok(tTok)
    return {
      effSkip,
      effCap,
      tTok,
      aTotal: Math.round((effCap * 5) / 3),
      sTok,
      aStart: Math.round((effSkip * 5) / 3),
    }
  })

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
      inputs: { chunks: 2, seq_threshold: 4096, model: modelSrc },
      class_type: 'MiniMaxChunkFeedForward',
      _meta: { title: 'Chunk FeedForward' },
    }
    modelSrc = ['46:40', 0]
  }

  return {
    '46:30': {
      inputs: {
        unet_name:
          p.diffusionModel || 'minimax_h3_fastvideo_vsa_datafree_1300step_4step_int8_convrot.safetensors', // (fix 293)
        weight_dtype: 'default',
      },
      class_type: 'UNETLoader',
      _meta: { title: 'Load Diffusion Model' },
    },
    '46:15': {
      inputs: { clip_name: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', type: 'minimax', device: 'default' },
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
    ...modelNodes,
    // Turbo LoRA — standard customLoras record (ON by default), as with
    // custom LoRAs; order set by loras.json.
    ...buildCustomLoraNodes(p.customLoras, modelSrc),
    '46:38': {
      inputs: { shift_video: 12, shift_audio: 3, model: getLastLoraOutput(p.customLoras, modelSrc) },
      class_type: 'MiniMaxH3SigmaShift',
      _meta: { title: 'Sigma Shift' },
    },
    // (fix 301) Veda or Sol-Attn — pass 2
    ...(p.vedaAttention ? {
      '46:44': {
        inputs: { model: ['46:38', 0], predictor: 'minimax_h3_t2va_veda_8nfe_600step_preview_fp8.safetensors', generated_sparsity: clampVedaSparsity(p.vedaGeneratedSparsity, 90), reference_sparsity: clampVedaSparsity(p.vedaReferenceSparsity, 90), full_attention_layers: sanitizeVedaIndexList(p.vedaFullAttentionLayers), full_attention_steps: sanitizeVedaIndexList(p.vedaFullAttentionSteps), verbose: p.vedaVerbose === true }, // (fix 399) settings
        class_type: 'VedaSparseAttention',
        _meta: { title: 'Veda Sparse Attention' },
      },
    } : p.sparseAttention === true ? { // (fix 387) Sol-Attn OFF by default
      '46:44': {
        inputs: { model: ['46:38', 0], tau: p.sparseTau ?? 1.3, start_percent: p.sparseStartPercent ?? 0.2, end_percent: p.sparseEndPercent ?? 1.0, min_tokens: p.sparseMinTokens ?? 12288, extra_tokens: p.sparseExtraTokens ?? 256 }, // (fix 466) settings
        class_type: 'MiniMaxSparseAttention',
        _meta: { title: 'Sparse Attention (Sol-Attn)' },
      },
    } : {}),
    '46:37': {
      inputs: { attention: 'comfy kitchen attention', model: (p.vedaAttention || p.sparseAttention === true) ? ['46:44', 0] : ['46:38', 0] },
      class_type: 'ModelAttentionBackend',
      _meta: { title: 'Attention Backend' },
    },
    '46:18': {
      inputs: { sampler_name: light ? 'res_multistep' : 'euler' },
      class_type: 'KSamplerSelect',
      _meta: { title: `KSampler (${light ? 'res_multistep' : 'euler'})` },
    },
    '46:33': light
      ? {
          inputs: { scheduler: 'simple', steps: 2, denoise: 0.2, model: ['46:37', 0] },
          class_type: 'BasicScheduler',
          _meta: { title: 'Light pass: 2 steps, denoise 0.2' },
        }
      : {
          inputs: { sigmas: ladder },
          class_type: 'ManualSigmas',
          _meta: { title: `Pass 2 Sigmas (${ladder.split(',').length - 1} steps)` },
        },
    '12': {
      inputs: {
        model: ['46:37', 0],
        vae: ['46:3', 0],
        tiny_vae: 'taeh3.safetensors',
        max_resolution: 1024,
        jpeg_quality: 80,
        suppress_default_preview: true,
        // As on "Generation" tab: preview covers entire chunk (for shorter
        // windows extra limit is harmless — no subsampling), 6 fps.
        // (fix 382) latent branch: from effective window lengths.
        preview_frames: Math.max(...winGeo.map((g) => g.effCap)),
        preview_fps: 6,
      },
      class_type: 'ModelPreviewOverrideKJ',
      _meta: { title: 'Model Preview Override' },
    },
    // ─── (fix 315, replaces layout of fix 305) Identity anchor:
    // meta-refs (<Picture 1..k>, original numbering of original generation) +
    // first frame LAST (<Picture k+1>; without meta — <Picture 1>) —
    // common to all windows. Conditioning is built per-window by
    // MiniMaxH3ReferenceToVideo node (in loop below): length varies across windows
    // (last window is shorter). ───
    'r_f0c': {
      inputs: { image: [latentMode ? 'r_f0src' : 'r_src', 0], batch_index: 0, length: 1 },
      class_type: 'ImageFromBatch',
      _meta: { title: `First frame → <Picture ${metaRefs.length + 1}>` },
    },
    ...Object.fromEntries(
      metaRefs.map((r, i) => [`c_ref_${i}`, {
        inputs: { image: r.path },
        class_type: 'LoadImage',
        _meta: { title: `Reference ${i + 1} (from meta)` },
      }]),
    ),

    // ─── Source (single loader for all windows) ───
    // (fix 382) latent branch: pristine AV latent + split into
    // video/audio streams; mp4 loaded as ONE frame for conditioning anchor.
    // Windows are cut in loop below (LatentCut by tokens/audio steps).
    ...(latentMode ? {
      'r_lat': {
        inputs: { latent: p.sourceLatent },
        class_type: 'MiniMaxStudioLoadAVLatent',
        _meta: { title: 'Source AV Latent (lossless, fix 382)' },
      },
      'r_lsep': {
        inputs: { av_latent: ['r_lat', 0] },
        class_type: 'LTXVSeparateAVLatent',
        _meta: { title: 'Separate AV Latent (loaded)' },
      },
      'r_f0src': {
        inputs: {
          video: p.sourceVideo,
          force_rate: 24,
          custom_width: 0,
          custom_height: 0,
          frame_load_cap: 1,
          skip_first_frames: 0,
          select_every_nth: 1,
        },
        class_type: 'VHS_LoadVideo',
        _meta: { title: 'Source: first frame (conditioning anchor)' },
      },
    } : {
      'r_src': {
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
    }),

    // ─── Chunk chain ───
    ...(() => {
      const nodes: Record<string, unknown> = {}
      windows.forEach((w, k) => {
        const chained = k > 0
        const geo = winGeo[k]
        const { tTok, aTotal, effSkip, effCap } = geo
        // (fix 313) Audio equivalent of overlap in audio latent time:
        // audio latent advances at 5/3 rate of video frames (same formula
        // as in EmptyMiniMaxH3LatentAV). = 65 for CHAIN_OVERLAP = 39.
        const aOver = chained ? Math.round((CHAIN_OVERLAP * 5) / 3) : 0

        // Window video latent (fix 382 — two paths):
        //  • mp4: pixel slice [skip, skip+cap) → resize → VAEEncode;
        //  • latent: slice of full GENERATION latent by tokens
        //    [sTok, sTok+tTok) — without h264 decode and encoding.
        // Then both paths unite: [upscale to gen canvas] → window latent.
        let encLatent: [string, number]
        if (latentMode) {
          // (fix 395) sTok/tTok for long source (>~39 min video)
          // exceed MAX_RESOLUTION=16384 — chunk with chainLatentCut.
          encLatent = chainLatentCut(
            nodes, `cl_${k}`,
            ['r_lsep', 0],
            't', geo.sTok, tTok,
            `Window ${k + 1}: tokens [${geo.sTok}, ${geo.sTok + tTok}) ≈ frames [${effSkip}, ${effSkip + effCap})`,
          )
        } else {
          nodes[`cw_${k}`] = {
            inputs: { image: ['r_src', 0], batch_index: w.skip, length: w.cap },
            class_type: 'ImageFromBatch',
            _meta: { title: `Window ${k + 1}: [${w.skip}, ${w.skip + w.cap})` },
          }
          nodes[`cr_${k}`] = {
            inputs: {
              image: [`cw_${k}`, 0],
              width: encW,
              height: encH,
              upscale_method: 'lanczos',
              keep_proportion: 'stretch',
              pad_color: '0, 0, 0',
              crop_position: 'center',
              divisible_by: 16,
              device: 'cpu',
            },
            class_type: 'ImageResizeKJv2',
            _meta: { title: `Window ${k + 1} → ${encW}×${encH}` },
          }
          nodes[`ce_${k}`] = {
            inputs: { pixels: [`cr_${k}`, 0], vae: ['46:3', 0] },
            class_type: 'VAEEncode',
            _meta: { title: `VAE Encode window ${k + 1}` },
          }
          encLatent = [`ce_${k}`, 0]
        }
        const genLatent: [string, number] = needsUpscale
          ? (() => {
              nodes[`cu_${k}`] = {
                inputs: {
                  model_name: 'minimax_h3_latent_upscaler_3d_fp16.safetensors',
                  mode: 'target dimensions',
                  'mode.width': final.genW,
                  'mode.height': final.genH,
                  align: 32,
                  enable_chunking: true,
                  enable_temporal_chunking: true,
                  force_unload: true,
                  device: 'cuda',
                  precision: 'fp16',
                  latent: encLatent,
                },
                class_type: 'MinimaxH3LatentUpscaler3D',
                _meta: { title: `Latent Upscaler window ${k + 1}` },
              }
              return [`cu_${k}`, 0]
            })()
          : encLatent

        // Window audio latent:
        //  • mp4 (fix 313): source track (MiniMaxH3AudioOrSilent — for
        //    silent video VHS_LoadVideo crashes VAEEncodeAudio) → slice
        //    of window in seconds → VAEEncodeAudio;
        //  • latent (fix 382): slice of AUDIO generation latent by steps
        //    [aStart, aStart+aTotal) — native audio without re-encoding.
        let audioEnc: [string, number]
        if (latentMode) {
          // (fix 395) aStart = effSkip·5/3 for source >~6.8 min
          // exceeds MAX_RESOLUTION=16384 → 400 on submit; chunk it.
          audioEnc = chainLatentCut(
            nodes, `cla_${k}`,
            ['r_lsep', 1],
            'x', geo.aStart, aTotal,
            `Audio of window ${k + 1}: steps [${geo.aStart}, ${geo.aStart + aTotal})`,
          )
        } else {
          nodes[`cask_${k}`] = {
            inputs: { audio: ['r_src', 2], fallback_seconds: Number(((w.cap / 24) + 0.5).toFixed(2)) },
            class_type: 'MiniMaxH3AudioOrSilent',
            _meta: { title: `Audio of window ${k + 1} (or silence)` },
          }
          nodes[`caw_${k}`] = {
            inputs: {
              audio: [`cask_${k}`, 0],
              start_seconds: Number((w.skip / 24).toFixed(4)),
            },
            class_type: 'MiniMaxH3AudioSliceFrom',
            _meta: { title: `Audio window ${k + 1} from frame ${w.skip}` },
          }
          nodes[`caenc_${k}`] = {
            inputs: { audio: [`caw_${k}`, 0], vae: ['46:4', 0] },
            class_type: 'VAEEncodeAudio',
            _meta: { title: `Audio → latent (window ${k + 1})` },
          }
          audioEnc = [`caenc_${k}`, 0]
        }

        // Chunk video latent (fix 272, scheme of D-version — working):
        // k=0: whole window (no mask needed).
        // k>0: LatentCut + LatentConcat — slice head O tokens of encoded
        // window + preserved tail of previous render (css_{k-1}). That is,
        // latent chain: chunk k-1 output → tail → concat with new
        // content of chunk k. Noise mask: black on tail (not refined),
        // white on new (refined). This is a proven working scheme —
        // seams continuous by construction (tail of chunk k-1 = head of chunk k),
        // hard concat without jumps.
        let videoForJoin: [string, number]
        if (!chained) {
          videoForJoin = genLatent
        } else {
          // Slice head: remove first oTok tokens (they = tail of previous render)
          nodes[`cvc_${k}`] = {
            inputs: { samples: genLatent, dim: 't', index: oTok, amount: tTok - oTok },
            class_type: 'LatentCut',
            _meta: { title: `Window without head (${oTok} tok.)` },
          }
          // Preserved tail of previous render: last oTok tokens
          nodes[`cpt_${k}`] = {
            inputs: { samples: [`css_${k - 1}`, 0], dim: 't', index: -oTok, amount: oTok },
            class_type: 'LatentCut',
            _meta: { title: `Preserved tail of chunk ${k}` },
          }
          // Concat: tail + new content = full window
          nodes[`ccc_${k}`] = {
            inputs: { samples1: [`cpt_${k}`, 0], samples2: [`cvc_${k}`, 0], dim: 't' },
            class_type: 'LatentConcat',
            _meta: { title: `Concat window ${k + 1} (${tTok} tok.)` },
          }
          // Noise mask: black on tail (oTok), white on new (tTok−oTok)
          nodes[`cmb_${k}`] = {
            inputs: { width: lw, height: lh, batch_size: oTok, color: 0 },
            class_type: 'EmptyImage',
            _meta: { title: `Mask: black ${oTok}` },
          }
          nodes[`cmw_${k}`] = {
            inputs: { width: lw, height: lh, batch_size: tTok - oTok, color: 16777215 },
            class_type: 'EmptyImage',
            _meta: { title: `Mask: white ${tTok - oTok}` },
          }
          nodes[`cmba_${k}`] = {
            inputs: { inputcount: 2, image_1: [`cmb_${k}`, 0], image_2: [`cmw_${k}`, 0] },
            class_type: 'ImageBatchMulti',
            _meta: { title: `Video mask ${k + 1}` },
          }
          nodes[`cmk_${k}`] = {
            inputs: { image: [`cmba_${k}`, 0], channel: 'red' },
            class_type: 'ImageToMask',
            _meta: { title: `ImageToMask ${k + 1}` },
          }
          nodes[`cms_${k}`] = {
            inputs: { samples: [`ccc_${k}`, 0], mask: [`cmk_${k}`, 0] },
            class_type: 'SetLatentNoiseMask',
            _meta: { title: `Noise mask window ${k + 1}` },
          }
          videoForJoin = [`cms_${k}`, 0]
        }
        // (fix 313) Window audio latent: new content or chain
        // (chunk k−1 tail ⊕ new window − head), mirror of video chain.
        // (fix 382) source — window audio (mp4: caenc / latent: cla).
        let audioForJoin: [string, number]
        // Trim to window length (LatentCut clamps if audio shorter;
        // window slice runs to end of track/latent, and window k is shorter — see aTotal).
        nodes[`cane_${k}`] = {
          inputs: { samples: audioEnc, dim: 'x', index: chained ? aOver : 0, amount: chained ? aTotal - aOver : aTotal },
          class_type: 'LatentCut',
          _meta: { title: chained ? `Audio window without head (${aOver})` : `Audio window → ${aTotal}` },
        }
        if (!chained) {
          audioForJoin = [`cane_${k}`, 0]
        } else {
          // Preserved audio tail of previous render: last aOver
          nodes[`caold_${k}`] = {
            inputs: { samples: [`css_${k - 1}`, 1], dim: 'x', index: -aOver, amount: aOver },
            class_type: 'LatentCut',
            _meta: { title: `Audio tail of chunk ${k}` },
          }
          // Concat: tail + new = full window
          nodes[`cacc_${k}`] = {
            inputs: { samples1: [`caold_${k}`, 0], samples2: [`cane_${k}`, 0], dim: 'x' },
            class_type: 'LatentConcat',
            _meta: { title: `Audio chain of window ${k + 1}` },
          }
          // Noise mask: black on tail (aOver), white on new (aTotal−aOver)
          nodes[`camb_${k}`] = {
            inputs: { value: 0, width: aTotal, height: 2 },
            class_type: 'SolidMask',
            _meta: { title: `Audio mask: black ${aOver}` },
          }
          nodes[`camw_${k}`] = {
            inputs: { value: 1, width: aTotal - aOver, height: 2 },
            class_type: 'SolidMask',
            _meta: { title: `Audio mask: white ${aTotal - aOver}` },
          }
          nodes[`camas_${k}`] = {
            inputs: { destination: [`camb_${k}`, 0], source: [`camw_${k}`, 0], x: aOver, y: 0, operation: 'add' },
            class_type: 'MaskComposite',
            _meta: { title: `Audio mask window ${k + 1}` },
          }
          nodes[`caaset_${k}`] = {
            inputs: { samples: [`cacc_${k}`, 0], mask: [`camas_${k}`, 0] },
            class_type: 'SetLatentNoiseMask',
            _meta: { title: `Audio noise mask window ${k + 1}` },
          }
          audioForJoin = [`caaset_${k}`, 0]
        }
        nodes[`cj_${k}`] = {
          inputs: { video_latent: videoForJoin, audio_latent: audioForJoin },
          class_type: 'LTXVConcatAVLatent',
          _meta: { title: `AV Latent window ${k + 1}` },
        }
        // Window conditioning (fix 315): MiniMaxH3ReferenceToVideo with
        // identity anchor — meta-refs (<Picture 1..k>) + first frame
        // as LAST (<Picture k+1>; without meta — <Picture 1>). length = length
        // of this specific window (last is shorter). Latent output of node
        // not used — only conditioning.
        nodes[`ccond_${k}`] = {
          inputs: {
            // Window 0 — plot prompt (first chain prompt, from route);
            // windows 1+ — only anchor captions of references (see above).
            prompt: k === 0 ? promptFirst : promptRest,
            width: final.genW,
            height: final.genH,
            // (fix 382) window length: mp4 — plan; latent — actual frames
            // of token slice (last window might be shorter due to clamp)
            length: effCap,
            ref_image_size: p.refImageSize ?? 'max', // (fix 324) ref size mode as in whole (fix 323)
            clip: ['46:15', 0],
            vae: ['46:3', 0],
            audio_vae: ['46:4', 0],
            ...Object.fromEntries(
              metaRefs.map((_, i) => [`ref_images.ref_image_${i}`, [`c_ref_${i}`, 0]]),
            ),
            // (fix 587) In latent chain first frame anchor is NOT included
            ...(!latentMode && { [`ref_images.ref_image_${metaRefs.length}`]: ['r_f0c', 0] }),
          },
          class_type: 'MiniMaxH3ReferenceToVideo',
          _meta: { title: latentMode
            ? `Conditioning window ${k + 1} (${metaRefs.length} meta-refs, without frame anchor)`
            : `Conditioning window ${k + 1} (${1 + metaRefs.length} refs)` },
        }
        nodes[`cg_${k}`] = {
          inputs: { model: ['12', 0], conditioning: [`ccond_${k}`, 0] },
          class_type: 'BasicGuider',
          _meta: { title: `Guider window ${k + 1}` },
        }
        // (fix 305) Same noise seed on all windows: details are regenerated
        // consistently, no change of texture character at seams.
        nodes[`cn_${k}`] = {
          inputs: { noise_seed: seed },
          class_type: 'RandomNoise',
          _meta: { title: `Noise window ${k + 1}` },
        }
        nodes[`cs_${k}`] = {
          inputs: {
            noise: [`cn_${k}`, 0],
            guider: [`cg_${k}`, 0],
            sampler: ['46:18', 0],
            sigmas: ['46:33', 0],
            latent_image: [`cj_${k}`, 0],
          },
          class_type: 'SamplerCustomAdvanced',
          _meta: { title: `Sampler window ${k + 1}${chained ? ' (latent masking)' : ''}` },
        }
        nodes[`css_${k}`] = {
          inputs: { av_latent: [`cs_${k}`, 0] },
          class_type: 'LTXVSeparateAVLatent',
          _meta: { title: `Separate output ${k + 1}` },
        }
      })

      // ─── (fix 314) Latent window stitching + segmented decode ───
      // Full video latent: css_0 ⊕ for k>0 LatentCut(css_k, head =
      // cutTok_k tokens). cutTok_k — by ACTUAL window overlap with already
      // covered timeline: overlap_k = (effSkip_{k−1}+effCap_{k−1}) − effSkip_k.
      // For standard windows overlap_k = CHAIN_OVERLAP = 39 → cutTok_k = 12
      // (= oTok, zero duplicates). For rebound of last window
      // (planChunkWindows back branch) and latent window shifts (fix 382:
      // off-grid skip aligns to tokens) overlap is calculated from
      // EFFECTIVE boundaries — and sliced accordingly, not fixed 39 frames.
      let fullVideo: [string, number] = [`css_0`, 0]
      let fullAudio: [string, number] = [`css_0`, 1]
      let tTokTotal = winGeo[0].tTok
      for (let k = 1; k < windows.length; k++) {
        const g = winGeo[k]
        const prevG = winGeo[k - 1]
        const overlap = Math.max(CHAIN_OVERLAP, prevG.effSkip + prevG.effCap - g.effSkip)
        const cutTok = tokHeadAtMost(overlap)
        const tTok = g.tTok
        const aTotal = g.aTotal
        // Audio equivalent of overlap (same formula as aOver in fix 313)
        const aCut = Math.round((overlap * 5) / 3)
        nodes[`cfj_${k}`] = {
          inputs: { samples: [`css_${k}`, 0], dim: 't', index: cutTok, amount: tTok - cutTok },
          class_type: 'LatentCut',
          _meta: { title: `Output window ${k + 1} without head (${cutTok} tok. ≈ ${overlap} frames)` },
        }
        nodes[`cfull_${k}`] = {
          inputs: { samples1: fullVideo, samples2: [`cfj_${k}`, 0], dim: 't' },
          class_type: 'LatentConcat',
          _meta: { title: `Full latent after window ${k + 1}` },
        }
        fullVideo = [`cfull_${k}`, 0]
        tTokTotal += tTok - cutTok
        nodes[`caf_${k}`] = {
          inputs: { samples: [`css_${k}`, 1], dim: 'x', index: aCut, amount: aTotal - aCut },
          class_type: 'LatentCut',
          _meta: { title: `Audio window ${k + 1} without head (${aCut} steps)` },
        }
        nodes[`cafl_${k}`] = {
          inputs: { samples1: fullAudio, samples2: [`caf_${k}`, 0], dim: 'x' },
          class_type: 'LatentConcat',
          _meta: { title: `Full audio latent after window ${k + 1}` },
        }
        fullAudio = [`cafl_${k}`, 0]
      }

      // (fix 471) Save full stitched AV latent of result —
      // repeated refine/upscale starts from it lossless (like '46:49'
      // in generation). Finalizing meta will pick up .latent from outputs.
      nodes['cfullav'] = {
        inputs: { video_latent: fullVideo, audio_latent: fullAudio },
        class_type: 'LTXVConcatAVLatent',
        _meta: { title: 'Full AV Latent (for saving)' },
      }
      nodes['csavelat'] = {
        inputs: {
          samples: ['cfullav', 0],
          filename_prefix: `${sub}latents/Minimax_Studio_refine`,
          vae_name: 'minimax_h3_video_vae_int8_convrot.safetensors',
        },
        class_type: 'MiniMaxStudioSaveAVLatent',
        _meta: { title: 'Save AV Latent (for lossless refine)' },
      }

      // Segmented decode: full latent is cut into segments of SEG_DECODE_TOK
      // tokens (VRAM: decode peak limited to segment, not whole video),
      // each decoded by its own VAEDecode, frames concatenated in order
      // with single ImageBatchMulti (KJNodes — already used above for masks).
      // (fix 412) OVERLAP of 5 tokens (=17 frames, boundaries multiple of 5 —
      // FPT pattern preserved): temporal VAE is non-local at edges, decoding
      // segments back-to-back created visual seams at each boundary (~85
      // frames) — "chunks don't stitch". Segment i>0 captures tail of
      // previous, duplicate 17 frames after decode are discarded.
      const OVL_TOK = 5
      const OVL_FRAMES = framesForTok(OVL_TOK) // 17
      const segCount = Math.max(1, Math.ceil(tTokTotal / SEG_DECODE_TOK))
      const segDec: string[] = []
      for (let i = 0; i < segCount; i++) {
        const index = i > 0 ? i * SEG_DECODE_TOK - OVL_TOK : 0
        const amount = Math.min(SEG_DECODE_TOK + (i > 0 ? OVL_TOK : 0), tTokTotal - index)
        // (fix 395) index for video >~39 min > MAX_RESOLUTION — chunk it.
        const segRef = chainLatentCut(
          nodes, `cds_${i}`,
          fullVideo,
          't', index, amount,
          `Decode segment ${i + 1}/${segCount} (${amount} tok.)`,
        )
        nodes[`cdd_${i}`] = {
          inputs: { samples: segRef, vae: ['46:3', 0] },
          class_type: 'VAEDecode',
          _meta: { title: `Decode segment ${i + 1}/${segCount}` },
        }
        if (i > 0) {
          nodes[`cdt_${i}`] = {
            inputs: { image: [`cdd_${i}`, 0], batch_index: OVL_FRAMES, length: 4096 },
            class_type: 'ImageFromBatch',
            _meta: { title: `Segment ${i + 1}: without ${OVL_FRAMES} overlap frames` },
          }
          segDec.push(`cdt_${i}`)
        } else {
          segDec.push(`cdd_${i}`)
        }
      }
      let framesAll: [string, number] = [segDec[0], 0]
      if (segDec.length > 1) {
        nodes[`cbatch`] = {
          inputs: {
            inputcount: segDec.length,
            ...Object.fromEntries(segDec.map((id, i) => [`image_${i + 1}`, [id, 0]])),
          },
          class_type: 'ImageBatchMulti',
          _meta: { title: `Frame stitching (${segDec.length} segm.)` },
        }
        framesAll = [`cbatch`, 0]
      }
      // Crop to nominal — ONCE on full batch (previously ccrop_k per chunk)
      if (needsCrop) {
        nodes[`ccrop`] = {
          inputs: { image: framesAll, width: final.outW, height: final.outH, x: final.cropX, y: final.cropY },
          class_type: 'ImageCrop',
          _meta: { title: `Crop → ${final.outW}×${final.outH}` },
        }
        framesAll = [`ccrop`, 0]
      }
      // Audio latent is small — no need to segment, single decode for entire video
      nodes[`cadec`] = {
        inputs: { samples: fullAudio, vae: ['46:4', 0] },
        class_type: 'VAEDecodeAudio',
        _meta: { title: 'Decode Audio (full)' },
      }
      // (fix 492) keepOriginalAudio: instead of regenerated audio,
      // ORIGINAL source track is muxed — mp4 path: 'r_src' pin 2
      // (loaded whole, track not cut; silent → silence matching video
      // duration), latent path: decode native audio latent from .latent.
      let outAudio: [string, number] = [`cadec`, 0]
      if (p.keepOriginalAudio) {
        if (latentMode) {
          nodes['corigdec'] = {
            inputs: { samples: ['r_lsep', 1], vae: ['46:4', 0] },
            class_type: 'VAEDecodeAudio',
            _meta: { title: 'Original audio (source audio latent)' },
          }
          outAudio = ['corigdec', 0]
        } else {
          nodes['corigs'] = {
            inputs: {
              audio: ['r_src', 2],
              fallback_seconds: Number((p.sourceFrames / 24).toFixed(2)),
            },
            class_type: 'MiniMaxH3AudioOrSilent',
            _meta: { title: 'Original source audio (or silence)' },
          }
          outAudio = ['corigs', 0]
        }
      }
      // SINGLE VHS_VideoCombine: only h264 encoding (previously: encode
      // each refinepart + repeated encode on ffmpeg stitch).
      nodes[`co`] = {
        inputs: {
          frame_rate: 24,
          loop_count: 0,
          filename_prefix: `${sub}Minimax_Studio_refine`,
          // (fix 386) format/quality — from [video] studio settings
          ...vhsEnc,
          save_metadata: false,
          pingpong: false,
          save_output: true,
          images: framesAll,
          audio: outAudio,
        },
        class_type: 'VHS_VideoCombine',
        _meta: { title: 'Video Combine (refine, chunked)' },
      }
      return nodes
    })(),
  }
}
