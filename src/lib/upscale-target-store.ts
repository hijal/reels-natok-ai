'use client'

/**
 * UpscaleTargetStore — bridge "gallery → Upscale tab".
 *
 * The "Send to Upscale" button on a video preview (and dragging & dropping
 * a gallery card into the Upscale upload zone) puts the filename from the
 * shared ComfyUI output folder here. UpscaleView takes the target and sends it to
 * POST /api/upscale/import — the server copies the file directly into upscale-input
 * (videos can be gigabytes, the browser is not involved).
 *
 * The store is needed because the click occurs BEFORE UpscaleView mounts
 * (the tab switches), and the on-the-fly event would otherwise be lost.
 */
import { create } from 'zustand'

export interface UpscaleTarget {
  /** Filename in the ComfyUI output folder. */
  filename: string
  /** Output subfolder (usually '' — the gallery lists the root). */
  subfolder: string
}

interface UpscaleTargetState {
  target: UpscaleTarget | null
  setTarget: (t: UpscaleTarget) => void
  clear: () => void
}

export const useUpscaleTarget = create<UpscaleTargetState>((set) => ({
  target: null,
  setTarget: (target) => set({ target }),
  clear: () => set({ target: null }),
}))
