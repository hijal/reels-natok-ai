'use client'

/**
 * FpsStore — bridge "gallery → FPS tab" + UI state. (fix 268)
 *
 * Similar to TileUpscaleTargetStore: button in gallery puts target here and sends
 * 'h3:goto-fps' event. FpsView consumes the target.
 *
 * Parameters for two frame interpolation modes (Fannovel16/ComfyUI-Frame-Interpolation):
 *   RIFE VFI  — fast, low VRAM; parameters: ckpt_name, multiplier, batch_size,
 *               scale_factor, dtype, fast_mode, ensemble, clear_cache_after_n_frames.
 *   FILM VFI  — for large motions; parameters: ckpt_name, multiplier,
 *               clear_cache_after_n_frames.
 */
import { create } from 'zustand'

export interface FpsTarget {
  filename: string
  subfolder: string
}

export interface FpsSource {
  url: string
  filename: string
  subfolder: string
  /** File from disk, already uploaded to ComfyUI input/. */
  inputSource?: string
}

/** VFI mode: RIFE VFI (fast) / FILM VFI (large motion). */
export type FpsMode = 'rife' | 'film'

/** FPS tab parameters — survive tab switching. */
export interface FpsUiParams {
  /** Mode: 'rife' | 'film'. Default 'rife'. */
  mode: FpsMode
  /** FPS multiplier: 2 | 3 | 4. Default 2. */
  multiplier: number
  // (fix 269) rifeModel/filmModel removed: one model per mode,
  // pinned in fps-template.ts (rife49.pth / film_net_fp32.pt) and
  // downloaded in Settings → Models.
  /** RIFE batch_size (1–64). Default 4. */
  rifeBatchSize: number
  /** RIFE scale_factor: 0.25 | 0.5 | 1 | 2 | 4. Default 1. */
  rifeScale: number
  /** RIFE dtype: float32 | float16 | bfloat16. Default 'float16' (VRAM saving). */
  rifeDtype: string
  /** RIFE fast_mode. Default false (quality). */
  rifeFastMode: boolean
  /** RIFE ensemble. Default true (quality). */
  rifeEnsemble: boolean
  /** Anti-OOM: lower = lower VRAM peak, slower. Default 4. */
  clearCacheAfterNFrames: number
}

const DEFAULT_PARAMS: FpsUiParams = {
  mode: 'rife',
  multiplier: 2,
  rifeBatchSize: 4,
  rifeScale: 1,
  rifeDtype: 'float16',
  rifeFastMode: false,
  rifeEnsemble: true,
  clearCacheAfterNFrames: 4,
}

interface FpsState {
  target: FpsTarget | null
  setTarget: (t: FpsTarget) => void
  clear: () => void
  source: FpsSource | null
  setSource: (s: FpsSource | null) => void
  params: FpsUiParams
  patchParams: (p: Partial<FpsUiParams>) => void
}

export const useFpsTarget = create<FpsState>((set, get) => ({
  target: null,
  setTarget: (target) => set({ target }),
  clear: () => set({ target: null }),
  source: null,
  // (fix 558) Revoke blob:URL of previous file from disk — each
  // source re-selection would otherwise keep the blob in memory until session end.
  setSource: (source) => {
    const prev = get().source
    if (prev?.url.startsWith('blob:') && prev.url !== source?.url) {
      try { URL.revokeObjectURL(prev.url) } catch { /* noop */ }
    }
    set({ source })
  },
  params: DEFAULT_PARAMS,
  patchParams: (p) => set((s) => ({ params: { ...s.params, ...p } })),
}))
