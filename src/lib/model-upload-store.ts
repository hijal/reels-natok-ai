/**
 * (fix 104) Shared model/LoRA upload state across all panels.
 *
 * WHY: previously `uploading`/`uploadProgress` lived in component useState
 * (DiffusionModelSelector, LoraSettingsPanel) inside the Radix settings
 * dialog. Upon close, Radix unmounts dialog contents — the progress bar
 * disappeared, and the user saw "upload interrupted" (and due to a server-side
 * OOM bug it actually failed — fixes 102/103).
 *
 * Now the state resides in a modular zustand store (outside the React tree):
 * closing and reopening the settings window does NOT reset progress and
 * does NOT abort the upload — XHR lives in a promise outside the component,
 * and the indicator is picked up by the new panel instance.
 */
import { create } from 'zustand'

/** Where the file is being uploaded — so panels can show "upload already in progress" for their target. */
export type UploadTarget = 'diffusion' | 'lora'

interface ModelUploadState {
  /** Whether an upload is currently active (any target). */
  active: boolean
  /** Target folder of the current upload. */
  target: UploadTarget | null
  /** Progress 0–100. */
  progress: number
  /** Name of the file being uploaded (for the indicator). */
  fileName: string | null

  start: (target: UploadTarget, fileName: string) => void
  setProgress: (pct: number) => void
  done: () => void
}

export const useModelUploadStore = create<ModelUploadState>((set) => ({
  active: false,
  target: null,
  progress: 0,
  fileName: null,

  start: (target, fileName) =>
    set({ active: true, target, fileName, progress: 0 }),

  setProgress: (pct) => set({ progress: Math.min(100, Math.max(0, Math.round(pct))) }),

  done: () => set({ active: false, target: null, progress: 0, fileName: null }),
}))
