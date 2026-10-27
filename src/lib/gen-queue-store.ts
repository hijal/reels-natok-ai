/**
 * Global generation queue store (Zustand, persisted to localStorage).
 *
 * Tracks all active/recent generations across all tabs so that:
 *   - The QueueIndicator can show overall status
 *   - Each item has its own progress tracking
 *   - Auto-cleanup removes finished items after a timeout
 *
 * ComfyUI modes (video/refine/controlnet/fps/tile-upscale/face-refine)
 * are serialized by a single FIFO gateway `comfy-turn.ts`; in parallel, only
 * separate DLSS Upscale (`upscale`) can run.
 *
 * Persisted so the queue (and its ComfyUI prompt_ids) survives a page
 * reload — useVideoGen re-attaches polling for active items on mount.
 * On rehydrate, finished items and anything older than MAX_AGE_MS are
 * dropped (their auto-remove timers don't survive the reload).
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/* ──────────────────── Types ──────────────────── */

export type QueueItemType =
  | 'image'
  | 'music'
  | 'sound'
  | 'video'
  | 'refine'
  | 'upscale'
  | 'controlnet'
  | 'fps'
  | 'tile-upscale'
  | 'face-refine'
export type QueueItemStatus = 'submitting' | 'queued' | 'running' | 'done' | 'error' | 'cancelled'

export interface QueueItem {
  id: string
  type: QueueItemType
  label: string
  promptId: string | null
  status: QueueItemStatus
  progressValue: number
  progressMax: number
  error: string | null
  /** Real-time status message from the backend (e.g. "Downloading model..."). */
  message: string | null
  createdAt: number
  /** (fix 587) Actual execution start time (on transition to running). */
  startedAt?: number | null
  completedAt: number | null
  /** (fix 331) Inflight recovery token: frontend generates upon submit and
   *  sends to POST /generate; server logs token → prompt_id. After a
   *  reload during POST, frontend looks up prompt_id by token. */
  clientToken?: string | null
}

/* ──────────────────── Accent colors ──────────────────── */

export const TYPE_ACCENT: Record<QueueItemType, string> = {
  image: '#8B5CF6',
  music: '#10B981',
  sound: '#14B8A6',
  video: '#06B6D4',
  refine: '#34D399', // (fix 261) refine in global queue
  upscale: '#A78BFA', // (fix 262) upscale in global queue
  controlnet: '#F97316', // (fix 512) ControlNet in global queue
  fps: '#22D3EE', // (fix 554) FPS (frame interpolation) in global queue
  'tile-upscale': '#F59E0B',
  'face-refine': '#EC4899',
}

export const TYPE_LABEL: Record<QueueItemType, string> = {
  image: 'Image',
  music: 'Music',
  sound: 'Sound',
  video: 'Video',
  refine: 'Refine',
  upscale: 'Upscale',
  controlnet: 'ControlNet', // (fix 512)
  fps: 'FPS', // (fix 554)
  'tile-upscale': 'Tile Upscale',
  'face-refine': 'Face Refine',
}

/* ──────────────────── Auto-cleanup ──────────────────── */

const AUTO_REMOVE_DONE_MS = 30000
// (fix Phase 4) 10s → 30s: error disappeared instantly, user didn't have
// time to read the message. 30s is enough to see the reason.
const AUTO_REMOVE_ERROR_MS = 30000
/** Rehydrated items older than this are dropped (stale across sessions). */
const MAX_AGE_MS = 24 * 60 * 60 * 1000

/** Drop finished + stale items when rehydrating from localStorage. */
function rehydrateItems(persisted: unknown): QueueItem[] {
  const items = (persisted as { items?: QueueItem[] } | null)?.items
  if (!Array.isArray(items)) return []
  const now = Date.now()
  return items.filter(
    (i) =>
      (i as { type?: string }).type !== 'inpaint' &&
      now - i.createdAt < MAX_AGE_MS &&
      i.status !== 'done' &&
      i.status !== 'error' &&
      i.status !== 'cancelled',
  )
}

/* ──────────────────── ID generator ──────────────────── */

let nextId = 1
function genId(): string {
  return `q_${nextId++}_${Date.now().toString(36)}`
}

/* ──────────────────── Store ──────────────────── */

interface GenQueueState {
  items: QueueItem[]

  /** Add a new item to the queue, returns the queue item ID. */
  enqueue: (type: QueueItemType, label: string) => string

  /** Set the ComfyUI prompt_id for a queue item. */
  setPromptId: (id: string, promptId: string) => void

  /** (fix 331) Remember clientToken for inflight recovery. */
  setClientToken: (id: string, clientToken: string) => void

  /** Update the status of a queue item. Triggers auto-cleanup for done/error. */
  setStatus: (id: string, status: QueueItemStatus, error?: string) => void

  /** Update the progress of a queue item. */
  setProgress: (id: string, value: number, max: number) => void

  /** Update the real-time status message for a queue item. */
  setMessage: (id: string, message: string | null) => void

  /** Remove a specific item from the queue. */
  remove: (id: string) => void

  /** Remove all done/error/cancelled items. */
  clearFinished: () => void
}

export const useGenQueue = create<GenQueueState>()(
  persist(
    (set) => ({
      items: [],

      enqueue: (type, label) => {
        const id = genId()
        const item: QueueItem = {
          id,
          type,
          label: label.length > 40 ? label.slice(0, 37) + '…' : label,
          promptId: null,
          status: 'submitting',
          progressValue: 0,
          progressMax: 0,
          error: null,
          message: null,
          createdAt: Date.now(),
          startedAt: null,
          completedAt: null,
          clientToken: null,
        }
        set((s) => ({ items: [...s.items, item] }))
        return id
      },

      setPromptId: (id, promptId) => {
        set((s) => ({
          items: s.items.map((item) =>
            item.id === id ? { ...item, promptId } : item
          ),
        }))
      },

      setClientToken: (id, clientToken) => {
        set((s) => ({
          items: s.items.map((item) =>
            item.id === id ? { ...item, clientToken } : item
          ),
        }))
      },

      setStatus: (id, status, error) => {
        const finished = status === 'done' || status === 'error' || status === 'cancelled'
        const completedAt = finished ? Date.now() : null

        // (fix) Diagnostics: log all state transitions for debugging
        const currentItem = useGenQueue.getState().items.find((i) => i.id === id)
        const previousStatus = currentItem?.status

        // (fix 716) startedAt is pinned ONLY on transition to running.
        // Previously it was overwritten on each poller tick (setStatus(id,
        // 'running') is called once per second), which caused "start time"
        // to always be ≈ "now" making any elapsed estimation based on it meaningless.
        const startedAt =
          status === 'running' && previousStatus !== 'running' ? Date.now() : undefined

        if (currentItem) {
          console.log(`[queue-store] ${id}: ${previousStatus} → ${status}`, error || '')
        }
        
        // (fix) BLOCK terminal → non-terminal transitions (resurrection).
        // This is the last line of defense: if previous guards didn't fire
        // (race condition), the store itself rejects transitioning error/done/cancelled
        // back to submitting/queued/running.
        const TERMINAL: QueueItemStatus[] = ['done', 'error', 'cancelled']
        const NON_TERMINAL: QueueItemStatus[] = ['submitting', 'queued', 'running']
        if (currentItem && TERMINAL.includes(currentItem.status) && NON_TERMINAL.includes(status)) {
          console.warn(`[queue-store] BLOCKED resurrection: ${id} (${currentItem.status}) → ${status}`)
          return
        }

        // (fix) "Cancelled" is a terminal user decision: nothing can
        // overwrite it. ComfyUI marks an aborted prompt as
        // 'error', and status pollers after await managed to roll over
        // cancelled → error — tab showed "Error / Try
        // again" after cancellation.
        if (currentItem && currentItem.status === 'cancelled' && status !== 'cancelled') {
          console.warn(`[queue-store] BLOCKED overwrite of cancelled: ${id} → ${status}`)
          return
        }
        
        // (fix) Start removal timer ONLY if status changed from previous.
        // This prevents race condition: if item was already 'done',
        // repeated setStatus('done') will not launch a new timer.
        const shouldStartTimer = previousStatus !== status && finished

        // (fix 716) The error field no longer "sticks".
        // Previously: error ?? item.error — and any subsequent status change without
        // explicit error preserved the old error. As a result, a SUCCESSFUL
        // task (done) showed red text "Waiting for GPU release…" /
        // "Page reloaded…". Now error is tied to the 'error' status;
        // on any other transition it is cleared.
        const nextError = error ?? (status === 'error' ? currentItem?.error ?? 'Error' : null)

        set((s) => ({
          items: s.items.map((item) =>
            item.id === id
              ? { ...item, status, error: nextError, completedAt, ...(startedAt !== undefined && { startedAt }) }
              : item
          ),
        }))

        // (fix) Auto-remove finished items after a delay
        if (shouldStartTimer) {
          if (status === 'done' || status === 'cancelled') {
            setTimeout(() => {
              console.log(`[queue-store] auto-removing ${id}`)
              set((s) => ({ items: s.items.filter((i) => i.id !== id) }))
            }, AUTO_REMOVE_DONE_MS)
          } else if (status === 'error') {
            setTimeout(() => {
              console.log(`[queue-store] auto-removing ${id} (error)`)
              set((s) => ({ items: s.items.filter((i) => i.id !== id) }))
            }, AUTO_REMOVE_ERROR_MS)
          }
        }
      },

      setProgress: (id, value, max) => {
        set((s) => ({
          items: s.items.map((item) =>
            item.id === id ? { ...item, progressValue: value, progressMax: max } : item
          ),
        }))
      },

      setMessage: (id, message) => {
        set((s) => ({
          items: s.items.map((item) =>
            item.id === id ? { ...item, message } : item
          ),
        }))
      },

      remove: (id) => {
        set((s) => ({ items: s.items.filter((i) => i.id !== id) }))
      },

      clearFinished: () => {
        set((s) => ({
          items: s.items.filter(
            (i) => i.status !== 'done' && i.status !== 'error' && i.status !== 'cancelled'
          ),
        }))
      },
    }),
    {
      name: 'h3-gen-queue',
      version: 1,
      partialize: (state) => ({ items: state.items }),
      merge: (persisted, current) => ({
        ...current,
        items: rehydrateItems(persisted),
      }),
    }
  )
)
