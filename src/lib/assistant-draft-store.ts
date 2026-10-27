/**
 * (fix 256) Assistant draft that outlives the component.
 *
 * Complaint from YouTube: wrote a prompt in the assistant window, inserted references,
 * switched to the "Generate" tab — came back, and the draft was empty. Reason:
 * tabs are rendered with key={activeTab} inside AnimatePresence and unmount,
 * while input/attachment were local useState. Zustand store lives in process
 * memory for the entire session — the draft survives tab switching.
 * (Not saved to disk — File objects are not serializable anyway.)
 */
import { create } from 'zustand'

/** Chat attachment: file + preview (see assistant-view). */
export interface AssistantDraftAttachment {
  file: File
  previewUrl: string
  name: string
  kind: 'image' | 'video'
}

interface AssistantDraftState {
  /** Text in the assistant input field. */
  input: string
  /** Pending attachment (image/video before sending). */
  attachment: AssistantDraftAttachment | null
  setInput: (v: string) => void
  setAttachment: (a: AssistantDraftAttachment | null) => void
}

export const useAssistantDraft = create<AssistantDraftState>((set) => ({
  input: '',
  attachment: null,
  setInput: (v) => set({ input: v }),
  setAttachment: (a) => set({ attachment: a }),
}))
