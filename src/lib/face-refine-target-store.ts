'use client'

/**
 * FaceRefineTargetStore — bridge "gallery → Face Refine tab" + its UI state.
 *
 * Analogous to TileUpscaleTargetStore: the button in gallery puts the target here
 * and emits the 'h3:goto-face-refine' event; FaceRefineView picks up the target.
 */
import { create } from 'zustand'
import type {
  FaceIdentityModel,
  FacePasteRegion,
  FaceSelectMode,
  FaceUndetected,
} from '@/lib/comfy/face-refine-template'

export interface FaceRefineTarget {
  filename: string
  subfolder: string
}

export interface FaceRefineSource {
  url: string
  filename: string
  subfolder: string
  /** Disk file already uploaded to ComfyUI input/. */
  inputSource?: string
}

/** Face reference of "this specific person" — file in ComfyUI input/. */
export interface FaceIdentityRef {
  /** File name in ComfyUI input/ — passed to the node. */
  name: string
  /** Preview in interface (data-URL or URL from input/). */
  previewUrl: string
}

/**
 * (edit 723) Point on the face specified by clicking on a source frame.
 *
 * Coordinates are in pixels of the VIDEO ITSELF (not the browser element),
 * as expected by the node in X/Y. `frame` is the frame index where the click
 * was made: the node measures distance to face centers on this exact frame,
 * and tracks this face forward via continuity.
 */
export interface FaceRefinePoint {
  x: number
  y: number
  frame: number
}

export interface FaceRefineUiParams {
  /** H3 canvas, px (presets 384–1280; engine clamps to 1344, multiple of 32).
   *  512 is 2.25× cheaper than 768 in latent tokens; above 768 is heavier on VRAM. */
  canvas: number
  /** Base denoise. H3 is flow matching with shift 12: 0.25 → sigma 0.800. */
  denoise: number
  /** Sampling steps (must match turbo LoRA). */
  steps: number
  /** Subject selection rule. */
  select: FaceSelectMode
  /** Face rank index in selection rule (0-based). */
  selectIndex: number
  /** Metric for comparing faces when selecting by reference. */
  identityModel: FaceIdentityModel
  /** Keep track of single subject across a crowd. */
  identityTrack: boolean
  /** Crop side as a multiple of face height. */
  cropFactor: number
  /** Face detector threshold. */
  confidence: number
  /** What region to paste back. */
  pasteRegion: FacePasteRegion
  /** Edge feathering of pasted region, source px. */
  feather: number
  /** Paste color match. */
  colourMatch: number
  /** Overall paste opacity. */
  blend: number
  /** Action for frames without a detected face. */
  undetectedFrames: FaceUndetected
  /**
   * (edit 722) "Wide shots": search for person and take head from their box
   * on frames without a detected face (fallback_detector). Requires person_yolov8m-seg model.
   */
  fallback: boolean
  /** Denoise multiplier for the smallest faces. */
  denoiseSmall: number
  /** Denoise multiplier for large faces. */
  denoiseLarge: number
}

const DEFAULT_PARAMS: FaceRefineUiParams = {
  canvas: 512,
  denoise: 0.35,
  steps: 4,
  select: 'largest_face',
  selectIndex: 0,
  identityModel: 'insightface',
  identityTrack: true,
  cropFactor: 2.5,
  confidence: 0.35,
  pasteRegion: 'face_only',
  feather: 6,
  colourMatch: 1,
  blend: 1,
  undetectedFrames: 'fade_out',
  fallback: true,
  denoiseSmall: 1,
  denoiseLarge: 0.35,
}

interface FaceRefineState {
  target: FaceRefineTarget | null
  setTarget: (t: FaceRefineTarget) => void
  clear: () => void
  source: FaceRefineSource | null
  setSource: (s: FaceRefineSource | null) => void
  identityRef: FaceIdentityRef | null
  setIdentityRef: (r: FaceIdentityRef | null) => void
  /** (edit 723) Click on face in source preview. */
  facePoint: FaceRefinePoint | null
  setFacePoint: (p: FaceRefinePoint | null) => void
  params: FaceRefineUiParams
  patchParams: (p: Partial<FaceRefineUiParams>) => void
}

export const useFaceRefineTarget = create<FaceRefineState>((set, get) => ({
  target: null,
  setTarget: (target) => set({ target }),
  clear: () => set({ target: null }),
  source: null,
  setSource: (source) => {
    const prev = get().source
    if (prev?.url.startsWith('blob:') && prev.url !== source?.url) {
      try { URL.revokeObjectURL(prev.url) } catch { /* noop */ }
    }
    set({ source })
  },
  identityRef: null,
  setIdentityRef: (identityRef) => set({ identityRef }),
  facePoint: null,
  setFacePoint: (facePoint) => set({ facePoint }),
  params: DEFAULT_PARAMS,
  patchParams: (p) => set((s) => ({ params: { ...s.params, ...p } })),
}))
