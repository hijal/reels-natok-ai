/**
 * Gallery refresh signal (fix 134).
 *
 * The gallery (Generate / Upscale / Gallery tabs) picks up new videos
 * via useVideoGallery — it subscribes to generation phase. But during
 * "Factory Reset" / "Clear Content", videos are deleted on the backend,
 * and the gallery does not know about this — it only redraws when switching
 * tabs (component unmount → mount → load() again).
 *
 * Solution: lightweight zustand signal store. settings-dialog sends
 * `bump()` after reset/delete; useVideoGallery subscribes to
 * `version` and on change calls `load(true)` (background, without skeleton).
 */
import { create } from 'zustand'

interface GalleryRefreshState {
  /** Unique counter: on each bump++ all subscribers reload the gallery. */
  version: number
  bump: () => void
}

export const useGalleryRefresh = create<GalleryRefreshState>()((set) => ({
  version: 0,
  bump: () => set((s) => ({ version: s.version + 1 })),
}))