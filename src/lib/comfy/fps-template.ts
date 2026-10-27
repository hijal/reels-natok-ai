import { vhsEncodeInputs, type VideoFormatSettings } from '../video-format' // (fix 386)
/**
 * FPS — frame interpolation (VFI) workflow template. (fix 268)
 *
 * Inserting frames between existing ones: 24 fps → 48/72/96 fps.
 * Node package: Fannovel16/ComfyUI-Frame-Interpolation.
 *
 * Chain:
 *   VHS_LoadVideo (24 fps) ──IMAGE→ RIFE VFI / FILM VFI (multiplier) ──IMAGE→
 *   VHS_VideoCombine (fps = source × multiplier, audio from source)
 *
 * RIFE VFI  (fast, low VRAM) — parameters:
 *   ckpt_name (rife49.pth | rife47.pth | rife417.pth | rife426.pth |
 *              sudo_rife4_269.662_testV1_scale1.pth), frames (IMAGE),
 *   multiplier (INT), clear_cache_after_n_frames (INT 1–1000),
 *   fast_mode (BOOL), ensemble (BOOL), scale_factor (0.25|0.5|1|2|4),
 *   dtype (float32|float16|bfloat16), torch_compile (BOOL), batch_size (1–64).
 *
 * FILM VFI (large motion) — parameters:
 *   ckpt_name (film_net_fp32.pt), frames (IMAGE), multiplier (INT),
 *   clear_cache_after_n_frames (INT 1–1000).
 *
 * Notes on VRAM:
 *   - clear_cache_after_n_frames — main anti-OOM: smaller = lower peak,
 *     slower. On low-end GPU 2–4.
 *   - scale_factor (RIFE) — 0.25/0.5 = faster and less VRAM, 1.0 = quality.
 *   - dtype=float16 saves ~50% VRAM relative to float32.
 */

export type FpsMode = 'rife' | 'film'

export interface FpsParams {
  /** (fix 386) Video output format/quality ([video] config.ini). */
  videoFormat?: VideoFormatSettings
  /** Filename in ComfyUI input/ (already copied by route). */
  sourceVideo: string
  /** Source video FPS (ffprobe r_frame_rate). Default 24. */
  sourceFps: number
  /** VFI mode: 'rife' | 'film'. Default 'rife'. */
  mode?: FpsMode
  /** FPS multiplier: 2 | 3 | 4. Default 2. */
  multiplier?: number
  // (fix 269) rifeModel/filmModel removed: one model per mode,
  // fixed below (RIFE_MODEL / FILM_MODEL). Downloaded in
  // Settings → Models (models-config.ts, category 'fps').
  /** RIFE batch_size (1–64). Default 4. */
  rifeBatchSize?: number
  /** RIFE scale_factor. Default 1. */
  rifeScale?: number
  /** RIFE dtype. Default 'float16'. */
  rifeDtype?: string
  /** RIFE fast_mode. Default false. */
  rifeFastMode?: boolean
  /** RIFE ensemble. Default true. */
  rifeEnsemble?: boolean
  /** Anti-OOM: frames between cache clearing. Default 4. */
  clearCacheAfterNFrames?: number
  /** Output subfolder. */
  outputSubfolder?: string
}

// (fix 269) One model per mode (user decision):
// RIFE → rife49.pth, FILM → film_net_fp32.pt.
const RIFE_MODEL = 'rife49.pth'
const FILM_MODEL = 'film_net_fp32.pt'

/**
 * Clamp value to a known allowed list (for COMBO inputs). Falls back to first
 * option if the value isn't in the list — this avoids ComfyUI rejecting the
 * workflow with an "invalid value" error.
 */
function pickOption<T extends string>(allowed: readonly T[], value: T | undefined, fallback: T): T {
  if (value && (allowed as readonly string[]).includes(value)) return value
  return fallback
}

/** Round fps to a safe positive number (ComfyUI VHS_VideoCombine). */
function safeFps(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 24
  return Math.max(1, Math.min(240, Math.round(n * 100) / 100))
}

export function buildFpsWorkflow(p: FpsParams): Record<string, unknown> {
  const vhsEnc = vhsEncodeInputs(p.videoFormat) // (fix 386)
  const mode: FpsMode = p.mode === 'film' ? 'film' : 'rife'
  const multiplier = Math.max(2, Math.min(1000, Math.floor(p.multiplier ?? 2)))
  const srcFps = safeFps(p.sourceFps)
  const outFps = safeFps(srcFps * multiplier)

  // (fix 269) Models are fixed — not accepted from params.
  const rifeModel = RIFE_MODEL
  const filmModel = FILM_MODEL
  const rifeBatchSize = Math.max(1, Math.min(64, Math.floor(p.rifeBatchSize ?? 4)))
  // (fix 268, fix) scale_factor — NUMBER (0.25/0.5/1.0/2.0/4.0), not string.
  const RIFE_SCALE_OPTIONS = [0.25, 0.5, 1.0, 2.0, 4.0]
  const rifeScaleNum = p.rifeScale ?? 1.0
  const rifeScale = RIFE_SCALE_OPTIONS.includes(rifeScaleNum) ? rifeScaleNum : 1.0
  const rifeDtype = pickOption(['float32', 'float16', 'bfloat16'] as const, p.rifeDtype, 'float16')
  const rifeFastMode = p.rifeFastMode === true
  const rifeEnsemble = p.rifeEnsemble !== false
  const clearCache = Math.max(1, Math.min(1000, Math.floor(p.clearCacheAfterNFrames ?? 4)))

  const sub = p.outputSubfolder ? `${p.outputSubfolder}/` : ''

  return {
    // ═══════════════════════════════════════════════
    //  SOURCE VIDEO LOADING
    // ═══════════════════════════════════════════════
    'fps_src': {
      inputs: {
        video: p.sourceVideo,
        // Do not force 24 fps — use fps from source (VHS force_rate=0).
        // multiplier will multiply this fps and yield target fps.
        force_rate: 0,
        custom_width: 0,
        custom_height: 0,
        frame_load_cap: 0,
        skip_first_frames: 0,
        select_every_nth: 1,
      },
      class_type: 'VHS_LoadVideo',
      _meta: { title: `Source (${srcFps} fps)` },
    },

    // ═══════════════════════════════════════════════
    //  FRAME INTERPOLATION (RIFE / FILM)
    // ═══════════════════════════════════════════════
    ...(mode === 'rife'
      ? {
          'fps_vfi': {
            inputs: {
              ckpt_name: rifeModel,
              frames: ['fps_src', 0],
              multiplier,
              clear_cache_after_n_frames: clearCache,
              fast_mode: rifeFastMode,
              ensemble: rifeEnsemble,
              scale_factor: rifeScale,
              dtype: rifeDtype,
              torch_compile: false,
              batch_size: rifeBatchSize,
            },
            class_type: 'RIFE VFI',
            _meta: { title: `RIFE VFI (×${multiplier})` },
          },
        }
      : {
          'fps_vfi': {
            inputs: {
              ckpt_name: filmModel,
              frames: ['fps_src', 0],
              multiplier,
              clear_cache_after_n_frames: clearCache,
            },
            class_type: 'FILM VFI',
            _meta: { title: `FILM VFI (×${multiplier})` },
          },
        }),

    // ═══════════════════════════════════════════════
    //  OUTPUT COMBINE (fps × multiplier, audio from source)
    // ═══════════════════════════════════════════════
    'fps_out': {
      inputs: {
        frame_rate: outFps,
        loop_count: 0,
        filename_prefix: `${sub}Minimax_Studio_fps`,
        // (fix 386) format/quality — from studio [video] settings
        ...vhsEnc,
        save_metadata: false,
        // (fix 323) A/V sync: VFI INTERPOLATES frames (N → N×multiplier),
        // out frame_rate = srcFps×multiplier → video duration =
        // source duration. Audio is the original track from VHS
        // passthrough with the same duration → no desync; false will pad
        // audio with apad to video length. This is the purpose of fps mode — do not touch.
        pingpong: false,
        save_output: true,
        images: ['fps_vfi', 0],
        audio: ['fps_src', 2],
      },
      class_type: 'VHS_VideoCombine',
      _meta: { title: `Video Combine (${outFps} fps)` },
    },
  }
}
