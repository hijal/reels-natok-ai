/**
 * Tracks generation durations (persisted to localStorage).
 * Each entry records the completion timestamp and the elapsed time.
 * The gallery matches the N-th newest file to the N-th newest entry.
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface GenDurationEntry {
  /** Completion timestamp (ms). */
  ts: number
  /** Elapsed generation time in milliseconds. */
  durationMs: number
  /** Type of generation (for display). */
  type: 'video' | 'image' | 'music' | 'sound'
  /** Output filename (for reliable matching). */
  filename?: string
}

interface GenDurationState {
  entries: GenDurationEntry[]
  /** Record a completed generation. durationMs = null → don't record (unknown). */
  record: (durationMs: number | null, type: GenDurationEntry['type'], filename?: string) => void
  /** Clear all entries. */
  clear: () => void
}

export const useGenDurations = create<GenDurationState>()(
  persist(
    (set) => ({
      entries: [],
      record: (durationMs, type, filename) => {
        // (fix 716) Discard non-numeric value: previously NaN got into
        // history, and formatSeconds(NaN) gave "NaN sec" in the badge.
        if (durationMs === null || !Number.isFinite(durationMs)) return
        set((s) => ({
          entries: [...s.entries.slice(-199), { ts: Date.now(), durationMs, type, filename }],
        }))
      },
      clear: () => set({ entries: [] }),
    }),
    { name: 'cb-gen-durations' },
  ),
)

/** Format whole seconds into a human-readable string: "45 sec" / "2 min 15 sec".
 *  Used for the generation-time badge when the value comes from the sidecar
 *  (field `generation_time`, already in seconds). */
export function formatSeconds(totalSec: number): string {
  // (fix 716) Non-numeric values (NaN/Infinity) must not reach the UI.
  if (!Number.isFinite(totalSec)) return '—'
  const s = Math.max(0, Math.round(totalSec))
  if (s < 60) return `${s} sec`
  const min = Math.floor(s / 60)
  const sec = s % 60
  return sec > 0 ? `${min} min ${sec} sec` : `${min} min`
}

/** Format milliseconds into a human-readable string like "45 sec" or "2 min 15 sec". */
export function formatDuration(ms: number): string {
  return formatSeconds(ms / 1000)
}
