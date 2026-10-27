'use client'

/**
 * RefineTargetStore — bridge "gallery → Refine tab" + its UI state.
 *
 * The "To Refine" button on a gallery video card puts the filename from the
 * shared ComfyUI output folder here and emits the 'h3:goto-refine' event. RefineView
 * picks up the target (the click occurs BEFORE the tab mounts — as with
 * UpscaleTargetStore, the on-the-fly event would otherwise be lost).
 *
 * The tab's UI state (source + parameters) also lives here: tabs
 * are rendered with key={activeTab} and unmount upon switching; local
 * useState was lost — after returning to the tab, the start button was
 * disabled until the video was dragged in again. The Zustand store lives at the
 * module level and survives unmounts.
 */
import { create } from 'zustand'

export interface RefineTarget {
  /** Filename in the ComfyUI output folder. */
  filename: string
  /** Output subfolder (usually '' — the gallery lists the root). */
  subfolder: string
}

/** Refine source: video from gallery (output) or file from disk (input/). */
export interface RefineSource {
  url: string
  filename: string
  subfolder: string
  /** File from disk, already uploaded to ComfyUI input/ (via /api/comfy/upload). */
  inputSource?: string
}

/** Refine tab parameters — persist across tab switches. */
export interface RefineUiParams {
  /** (fix 494) 'free' — custom resolution in MP (see targetMp). */
  target: 'same' | '720' | '1080' | 'free'
  mode: 'whole' | 'chunks'
  chunkSec: '3' | '5' | '8'
  /** '2' = lightweight ×2 recipe (BasicScheduler 2 steps, denoise 0.2).
   *  '6'/'7' — same sigma ladders as Pass 2 generation (6step/7step). */
  steps: '2' | '3' | '4' | '5' | '6' | '7'
  /** σ_start of the ladder ("Refine Influence" in UI), 0.3–0.95. */
  strength: number
  /** (fix 1) Reference size mode: 'match' — without ref upscale
   *  (cheaper), 'max' — full resolution (more accurate identity). */
  refDetail: 'match' | 'max'
  /** (fix 492) Keep original audio (do not regenerate). */
  keepOriginalAudio: boolean
  /** (fix 494) "Custom resolution" target in megapixels (up to 4K =
   *  8.3 MP); conversion to short side is done on server using real
   *  source dimensions (like in the "Generate" tab, but up to 4K). */
  targetMp: number
}

const DEFAULT_PARAMS: RefineUiParams = {
  // (fix 413) Default 'same' (no upscale): default 720 silently
  // inflated a 480p source to ~1.25 MP (e.g. 1120×480 → 1696×736) —
  // refine took ~2.3x longer than expected, while user saw
  // "480p test" in generation settings. Upscaling requires explicit choice.
  target: 'same',
  mode: 'whole',
  chunkSec: '5',
  steps: '3',
  // (fix 698) Default 90% (σ 0.90) for "Whole" mode: user
  // wants refine to noticeably enhance the image by default. For
  // "In Parts" mode, switching in refine-view.tsx automatically sets 80%.
  strength: 0.9,
  refDetail: 'max', // (fix 1) default Max — user requirement
  keepOriginalAudio: false, // (fix 492)
  targetMp: 2.0, // (fix 494)
}

interface RefineTargetState {
  target: RefineTarget | null
  setTarget: (t: RefineTarget) => void
  clear: () => void
  /** Refine tab UI state. */
  source: RefineSource | null
  setSource: (s: RefineSource | null) => void
  params: RefineUiParams
  patchParams: (p: Partial<RefineUiParams>) => void
  // (fix 509) Prompt and references entered manually for disk source
  // (inputSource — lacks .meta.json). Kept in store, not in view useState:
  // tab unmounts on switch, local state was lost.
  prompt: string
  setPrompt: (p: string) => void
  userRefs: RefineUserRef[]
  addUserRefs: (items: RefineUserRef[]) => void
  removeUserRef: (id: string) => void
  clearUserRefs: () => void
}

/** (fix 509) Reference image uploaded by user for
 *  source from disk (uploaded to ComfyUI input/ via /api/comfy/upload). */
export interface RefineUserRef {
  id: string
  path: string
  name: string
  previewUrl: string
}

export const useRefineTarget = create<RefineTargetState>((set, get) => ({
  target: null,
  setTarget: (target) => set({ target }),
  clear: () => set({ target: null }),
  source: null,
  // (fix 716) Revoke blob:URL of previous file from disk — each
  // source reselection previously left blob in memory until end of session (already
  // done in controlnet-target-store.ts, but was missing here).
  setSource: (source) => {
    const prev = get().source
    if (prev?.url.startsWith('blob:') && prev.url !== source?.url) {
      try { URL.revokeObjectURL(prev.url) } catch { /* noop */ }
    }
    set({ source })
  },
  params: DEFAULT_PARAMS,
  patchParams: (p) => set((s) => ({ params: { ...s.params, ...p } })),
  prompt: '',
  setPrompt: (prompt) => set({ prompt }),
  userRefs: [],
  addUserRefs: (items) => set((s) => ({ userRefs: [...s.userRefs, ...items] })),
  // (fix 716) Also revoke preview of removed references — blob previously persisted
  // until session end.
  removeUserRef: (id) => set((s) => {
    const gone = s.userRefs.find((r) => r.id === id)
    if (gone?.previewUrl?.startsWith('blob:')) {
      try { URL.revokeObjectURL(gone.previewUrl) } catch { /* noop */ }
    }
    return { userRefs: s.userRefs.filter((r) => r.id !== id) }
  }),
  clearUserRefs: () => set((s) => {
    for (const r of s.userRefs) {
      if (r.previewUrl?.startsWith('blob:')) {
        try { URL.revokeObjectURL(r.previewUrl) } catch { /* noop */ }
      }
    }
    return { userRefs: [] }
  }),
}))
