'use client'

/**
 * ControlNetTargetStore — bridge "gallery → ControlNet tab"
 * + its UI state.
 *
 * (fix 511) ControlNet is now completely on the standard References workflow:
 *  • Control type: depth | canny | direct (new "Direct" — video is passed as a ref
 *    directly, without depth/canny maps);
 *  • Default "Refs: size mode" — Max (was Match);
 *  • Extra parameters: steps (draft: 1, full: 2), sampler + scheduler (Pass 1),
 *    Sigma profile + sampler (Pass 2), low-res resolution (Pass 1) — same as on
 *    the "Generate" tab;
 *  • Compress source to 480p — works in all modes (fix 511).
 */
import { create } from 'zustand'
import type { ControlNetType } from '@/lib/comfy/controlnet-template'

export interface ControlNetTarget {
  filename: string
  subfolder: string
}

export interface ControlNetSource {
  url: string
  filename: string
  subfolder: string
  /** File from disk, already uploaded to ComfyUI input/. */
  inputSource?: string
}

/** ControlNet tab parameters — persist across tab switches. */
export interface ControlNetUiParams {
  /** Control type: depth | canny | direct (direct, without maps). */
  controlType: ControlNetType
  /** Generation duration, seconds (clamped to source length). */
  duration: number
  /** Generation short side, px. Default 720. */
  targetShortSide: number
  /** "Map only": save depth/canny video without Minimax generation.
   *  Unavailable in direct mode (no map is generated). */
  preprocessOnly: boolean
  /** Refs: input image size mode. Default — 'max' (fix 511). */
  refImageSize: 'match' | 'max'
  /** 'draft' — single-pass; 'full' — two-pass. */
  pipeline: 'draft' | 'full'
  /** Compress source video to 480p (server, cache) — across all modes (fix 511). */
  compressSource: boolean

  // ── Extra parameters (fix 511) — same as on the "Generate" tab ──
  /** Draft pipeline: single-pass steps (default 4, min 2, max 30). */
  draftSteps: number
  /** Full pipeline, Pass 1: effective steps (SplitSigmas split, default 6). */
  firstSamplerSteps: number
  /**
   * TOTAL steps in the BasicScheduler schedule for pass 1.
   * Default 6 — same as what split takes ("6 out of 6").
   */
  firstSamplerTotalSteps?: number
  /** Pass 1 sampler (default 'euler'). */
  pass1Sampler: string
  /** Pass 1 scheduler (default 'simple'). */
  pass1Scheduler: string
  /** Pass 2 sigma profile: '3step' | '4step' | '5step' | '6step' | '7step'. */
  sigmaVariant: string
  /** Pass 2 sampler (default 'euler'). */
  pass2Sampler: string
  /** Full pipeline, Pass 1 low-res resolution, MP (default 0.2). */
  lowResMP: number
}

const DEFAULT_PARAMS: ControlNetUiParams = {
  controlType: 'depth',
  duration: 5,
  targetShortSide: 720,
  preprocessOnly: false,
  refImageSize: 'max', // (fix 511) was 'match'
  pipeline: 'draft',
  compressSource: true, // (fix 512) default ON — across all modes
  draftSteps: 4,
  firstSamplerSteps: 6,
  firstSamplerTotalSteps: 6,
  pass1Sampler: 'euler',
  pass1Scheduler: 'simple',
  sigmaVariant: '3step',
  pass2Sampler: 'euler',
  lowResMP: 0.2,
}

/** ControlNet tab reference image (character/location/frame). */
export interface ControlNetRefImage {
  id: string
  path: string
  name: string
  previewUrl: string
}

interface ControlNetState {
  target: ControlNetTarget | null
  setTarget: (t: ControlNetTarget) => void
  clear: () => void
  source: ControlNetSource | null
  setSource: (s: ControlNetSource | null) => void
  /**
   * (fix 727) Output folder — same as on the "Generate" tab. By default
   * matches source folder ('' = shared), user can change it.
   */
  outputFolder: string
  setOutputFolder: (folder: string) => void
  params: ControlNetUiParams
  patchParams: (p: Partial<ControlNetUiParams>) => void
  prompt: string
  setPrompt: (p: string) => void
  seed: number
  setSeed: (n: number) => void
  refImages: ControlNetRefImage[]
  addRefImages: (items: ControlNetRefImage[]) => void
  removeRefImage: (id: string) => void
}

export const useControlNetTarget = create<ControlNetState>((set, get) => ({
  target: null,
  setTarget: (target) => set({ target }),
  clear: () => set({ target: null }),
  source: null,
  // (fix 558) Revoke blob:URL of previous file from disk — each
  // reselection of source previously left blob in memory until session end.
  setSource: (source) => {
    const prev = get().source
    if (prev?.url.startsWith('blob:') && prev.url !== source?.url) {
      try { URL.revokeObjectURL(prev.url) } catch { /* noop */ }
    }
    // (fix 727) New source — output folder is set to its folder again.
    set({ source, outputFolder: source?.subfolder ?? '' })
  },
  outputFolder: '',
  setOutputFolder: (outputFolder) => set({ outputFolder }),
  params: DEFAULT_PARAMS,
  patchParams: (p) => set((s) => ({ params: { ...s.params, ...p } })),
  prompt: '',
  setPrompt: (prompt) => set({ prompt }),
  seed: -1,
  setSeed: (seed) => set({ seed }),
  refImages: [],
  addRefImages: (items) => set((s) => ({ refImages: [...s.refImages, ...items] })),
  // (fix 716) Revoke preview of removed reference — blob previously persisted
  // until session end.
  removeRefImage: (id) => set((s) => {
    const gone = s.refImages.find((r) => r.id === id)
    if (gone?.previewUrl?.startsWith('blob:')) {
      try { URL.revokeObjectURL(gone.previewUrl) } catch { /* noop */ }
    }
    return { refImages: s.refImages.filter((r) => r.id !== id) }
  }),
}))