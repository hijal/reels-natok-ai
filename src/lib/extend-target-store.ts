'use client'

/**
 * (fix 369) ExtendTargetStore — bridge "gallery → Extend tab".
 *
 * The "Extend" item in the video card action menu in gallery puts the
 * filename from the shared ComfyUI output folder here and emits the 'h3:goto-extend' event.
 * ExtendView retrieves the target and imports the video via importGalleryVideo
 * (POST /api/extend/import — server copies output → input).
 *
 * The store is needed because the click happens BEFORE ExtendView is mounted
 * (the active tab changes), and an on-the-fly event would be lost.
 * Pattern mimics UpscaleTargetStore / RefineTargetStore.
 */
import { create } from 'zustand'

export interface ExtendTarget {
  /** Filename in ComfyUI output folder. */
  filename: string
  /** Subfolder of output (usually '' — gallery lists root). */
  subfolder: string
}

interface ExtendTargetState {
  target: ExtendTarget | null
  setTarget: (t: ExtendTarget) => void
  clear: () => void
}

export const useExtendTarget = create<ExtendTargetState>((set) => ({
  target: null,
  setTarget: (target) => set({ target }),
  clear: () => set({ target: null }),
}))
