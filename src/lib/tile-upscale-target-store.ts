'use client'

/**
 * TileUpscaleTargetStore — bridge "gallery → Tile Upscale tab" + its UI state.
 *
 * Analogous to RefineTargetStore: the button in gallery puts the target here
 * and emits the 'h3:goto-tile-upscale' event. TileUpscaleView picks up the target.
 */
import { create } from 'zustand'

export interface TileUpscaleTarget {
  filename: string
  subfolder: string
}

export interface TileUpscaleSource {
  url: string
  filename: string
  subfolder: string
  /** Disk file already uploaded to ComfyUI input/. */
  inputSource?: string
}

/** Tile Upscale tab parameters — preserved across tab switching. */
export interface TileUpscaleUiParams {
  /** Short side of target resolution: 720|1080|1440|2160. Default 1080. (edit 265) */
  targetResolution: number
  /** Denoise level 0–1. Default 0.1. */
  denoise: number
  /** Number of steps. Default 2. */
  steps: number
  /** Tile size in pixels (multiple of 32). Number of tiles is auto. */
  tileSize: number
  /** Spatial overlap, px. */
  overlap: number
  /** Fade width, px. */
  fade: number
  /** Temporal chunk length, frames. */
  chunkFrames: number
  /** Temporal overlap, frames. */
  temporalOverlap: number
  /** Anchor strength 0–1. */
  anchorStrength: number
  /** (edit 481) SyncTile: per-step tile synchronization (flicker-free seams). */
  syncTiles: boolean
}

const DEFAULT_PARAMS: TileUpscaleUiParams = {
  targetResolution: 1080,
  denoise: 0.1,
  steps: 2,
  tileSize: 768,
  overlap: 128,
  fade: 64,
  chunkFrames: 136,
  temporalOverlap: 34,
  anchorStrength: 0.999,
  syncTiles: true,
}

interface TileUpscaleState {
  target: TileUpscaleTarget | null
  setTarget: (t: TileUpscaleTarget) => void
  clear: () => void
  source: TileUpscaleSource | null
  setSource: (s: TileUpscaleSource | null) => void
  params: TileUpscaleUiParams
  patchParams: (p: Partial<TileUpscaleUiParams>) => void
}

export const useTileUpscaleTarget = create<TileUpscaleState>((set, get) => ({
  target: null,
  setTarget: (target) => set({ target }),
  clear: () => set({ target: null }),
  source: null,
  // (edit 558) Revoke blob:URL of previous disk file — every source
  // reselection previously leaked the blob in memory until end of session.
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
