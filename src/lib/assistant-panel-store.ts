/**
 * Assistant panel store (Zustand, persisted) — fix 442.
 *
 * The assistant lives as a right side panel on the "Generation" and
 * "Extend" tabs (there is no separate tab anymore). The store keeps the panel width
 * (resize via left border) and whether it is collapsed into a narrow rail.
 *
 * Module-level store (rather than useState in a component) so that the event
 * h3:open-assistant-panel can expand the panel BEFORE it is mounted:
 * "Improve prompt" switches tab → panel mounts already
 * expanded and immediately picks up pendingImprove.
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export const ASSISTANT_PANEL_MIN = 300
export const ASSISTANT_PANEL_MAX = 640
export const ASSISTANT_PANEL_DEFAULT = 380

interface AssistantPanelState {
  /** Width of the expanded panel, px. */
  width: number
  /** Collapsed into a narrow rail (expand button + vertical label). */
  collapsed: boolean
  /** (fix 496) "3D → Video" mode: a compact section is added to the assistant's
   *  system prompt about transferring motion/camera from a 3D blockout
   *  (video reference = motion/camera source, not visual appearance). */
  guide3d: boolean
  setWidth: (w: number) => void
  setCollapsed: (v: boolean) => void
  setGuide3d: (v: boolean) => void
}

export const useAssistantPanel = create<AssistantPanelState>()(
  persist(
    (set) => ({
      width: ASSISTANT_PANEL_DEFAULT,
      // (fix 444) By default the panel is collapsed into a rail: expanded
      // by the ‹ button in the rail or via the h3:open-assistant-panel event ("Improve
      // prompt") — then opens to the full saved width.
      collapsed: true,
      guide3d: false,
      setWidth: (w) =>
        set({ width: Math.min(ASSISTANT_PANEL_MAX, Math.max(ASSISTANT_PANEL_MIN, Math.round(w))) }),
      setCollapsed: (v) => set({ collapsed: v }),
      setGuide3d: (v) => set({ guide3d: v }),
    }),
    {
      name: 'h3-assistant-panel',
      // (fix 444) Migration v0→v1: for those who have already opened the panel
      // (collapsed:false in localStorage), collapse into a rail once —
      // new default. Width is preserved.
      version: 1,
      migrate: (persisted, version) => {
        if (version === 0 && persisted && typeof persisted === 'object') {
          return { ...(persisted as AssistantPanelState), collapsed: true }
        }
        return persisted as AssistantPanelState
      },
    },
  )
)
