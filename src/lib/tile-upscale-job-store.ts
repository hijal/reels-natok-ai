'use client'

/**
 * (fix 319) TileUpscaleJobStore — tile-upscale job state OUTSIDE React.
 *
 * Previously promptId/phase/progress lived in TileUpscaleView useState, and polling
 * /api/comfy/status — in useEffect: tab switching (unmount) killed
 * interval → progress "froze", result did not reach gallery, and
 * staggered-reload of gallery was canceled by cleanup.
 *
 * Now (simplified pattern from upscale-service.ts):
 *  • promptId/phase/progress/error live in zustand store;
 *  • ONE module-level polling loop — survives tab unmount;
 *  • on completion — useGalleryRefresh.bump(): staggered reloads are already
 *    built into useVideoGallery on bump, local timers are not needed;
 *  • active promptId is persisted (localStorage) → after page reload
 *    onRehydrateStorage restarts polling (re-attach).
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { toast } from 'sonner'
import { useGalleryRefresh } from '@/lib/gallery-refresh-store'
import { useGenQueue } from '@/lib/gen-queue-store'
import { acquireComfyTurn, isComfyTurnActive } from '@/lib/comfy-turn'

export type TileUpscalePhase = 'idle' | 'submitting' | 'running' | 'done' | 'error'

export interface TileUpscaleSubmitBody {
  inputSource?: string
  sourceFilename?: string
  sourceSubfolder?: string
  prompt?: string
  seed?: number
  [key: string]: unknown
}

interface TileUpscaleJobState {
  phase: TileUpscalePhase
  progress: number
  error: string | null
  promptId: string | null
  startedAt: number | null
  busy: boolean

  submit: (body: TileUpscaleSubmitBody) => Promise<void>
  cancel: () => Promise<void>
  reset: () => void
}

const ACTIVE: ReadonlySet<TileUpscalePhase> = new Set(['submitting', 'running'])

/* (fix 330) Cancellation epoch (patterned after fix H2 in use-video-gen.ts): cancel()
 * during 'submitting' (POST /api/comfy/tile-upscale still in flight, no promptId)
 * previously was a no-op — when POST returned, orphan job started
 * in ComfyUI untracked. Now submit() notices epoch change after
 * await POST and immediately cancels the returned prompt_id. */
let cancelEpoch = 0

/** promptId for which user requested cancellation. ComfyUI reports
 *  interrupted task in history as 'error' (execution_interrupted), not
 *  'cancelled' — without this tag poller displayed its own cancellation with red
 *  "Error" banner. Poller translates such terminal status into clean
 *  idle. */
let cancelRequestedFor: string | null = null

/** queue-item owning the tab state; protects against delayed
 *  response of canceled POST when the next task has already started. */
let activeQid: string | null = null

/** Cancel from shared queue: interrupted ComfyUI prompt must not be displayed
 *  with red error banner. */
export function markTileUpscaleCancelRequested(promptId: string) {
  cancelRequestedFor = promptId
}

export const useTileUpscaleJob = create<TileUpscaleJobState>()(
  persist(
    (set, get) => ({
      phase: 'idle',
      progress: 0,
      error: null,
      promptId: null,
      startedAt: null,
      busy: false,

      submit: async (body) => {
        const label = typeof body.sourceFilename === 'string' && body.sourceFilename
          ? `Tile: ${body.sourceFilename}`
          : 'Tile Upscale'
        const qid = useGenQueue.getState().enqueue('tile-upscale', label)

        // Single FIFO: multiple tasks can be queued. Tab state
        // is changed only when the task actually receives its turn.
        const granted = await acquireComfyTurn(qid)
        if (!granted || !isComfyTurnActive(qid)) return

        // Fix cancellation epoch only at task start, not when
        // queued: Cancel of current job must not cancel all
        // tasks still waiting in queue.
        const myEpoch = cancelEpoch // (fix 330)
        cancelRequestedFor = null
        activeQid = qid
        set({ phase: 'submitting', busy: true, error: null, progress: 0, startedAt: Date.now() })

        try {
          const res = await fetch('/api/comfy/tile-upscale', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          })
          const data = await res.json()
          if (!res.ok) {
            useGenQueue.getState().setStatus(qid, 'error', data.error || `Error ${res.status}`)
            throw new Error(data.error || `Error ${res.status}`)
          }
          if (!data.prompt_id) {
            const msg = 'ComfyUI did not return prompt_id'
            useGenQueue.getState().setStatus(qid, 'error', msg)
            throw new Error(msg)
          }
          // (fix 330) Cancellation arrived while POST was in flight: task is already in
          // ComfyUI — cancel it on server and DO NOT start polling.
          if (cancelEpoch !== myEpoch || !isComfyTurnActive(qid)) {
            if (data.prompt_id) {
              await fetch('/api/comfy/cancel', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt_id: data.prompt_id }),
              }).catch(() => {})
            }
            useGenQueue.getState().setStatus(qid, 'cancelled')
            if (activeQid === qid) {
              activeQid = null
              set({ phase: 'idle', busy: false, progress: 0, startedAt: null })
            }
            return
          }
          set({ promptId: data.prompt_id ?? null, phase: 'running' })
          useGenQueue.getState().setPromptId(qid, data.prompt_id)
          useGenQueue.getState().setStatus(qid, 'running')
          toast.success('Tile Upscale started')
          ensurePolling()
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          const qi = useGenQueue.getState().items.find((i) => i.id === qid)
          if (!qi?.error) useGenQueue.getState().setStatus(qid, 'error', msg)
          if (activeQid === qid) {
            activeQid = null
            set({ phase: 'error', error: msg, busy: false })
          }
        }
      },

      cancel: async () => {
        // (fix 330) Invalidate epoch BEFORE checking promptId: if POST is still in
        // flight ('submitting'), subsequent submit() will notice the change and cancel
        // accepted task itself.
        cancelEpoch++
        const { promptId, phase } = get()
        if (!promptId) {
          if (phase === 'submitting') {
            set({ phase: 'idle', busy: false, progress: 0, startedAt: null })
            toast.info('Cancelled')
          }
          return
        }
        // (fix 491) After server-CONFIRMED cancellation, immediately clean idle
        // and stop polling. Previously UI waited for poller to hit terminal
        // status: task canceled from QUEUE does not enter history → 'unknown'
        // status → 20 seconds "Generating..." → red banner "Task not
        // found in ComfyUI (server was restarted)". cancelRequestedFor in this case
        // only triggered on 'error' status (interrupted running).
        let cancelled = false
        try {
          cancelRequestedFor = promptId
          const res = await fetch('/api/comfy/cancel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt_id: promptId }),
          })
          const data = await res.json().catch(() => ({}))
          cancelled = res.ok && data.ok !== false
        } catch { /* ignore */ }
        if (cancelled) {
          cancelRequestedFor = null
          const qi = useGenQueue.getState().items.find((i) => i.promptId === promptId)
          if (qi) useGenQueue.getState().setStatus(qi.id, 'cancelled')
          if (activeQid === null || activeQid === qi?.id) {
            activeQid = null
            stopPolling()
            set({ phase: 'idle', progress: 0, busy: false, promptId: null, startedAt: null })
          }
          toast.info('Cancelled')
        } else {
          // Server did not confirm (ComfyUI unavailable?) — keep state,
          // so user can retry cancellation.
          cancelRequestedFor = null
          toast.error('Cancellation not confirmed by server — check that ComfyUI is running')
        }
      },

      reset: () => {
        cancelEpoch++ // (fix 330) reset also invalidates in-flight POST
        cancelRequestedFor = null
        activeQid = null
        stopPolling()
        set({ phase: 'idle', progress: 0, error: null, promptId: null, startedAt: null, busy: false })
      },
    }),
    {
      name: 'tile-upscale-job',
      // Persist ONLY active job — after page reload
      // onRehydrateStorage re-attaches polling. Progress/errors are not stored.
      partialize: (s) =>
        ACTIVE.has(s.phase) ? { promptId: s.promptId, startedAt: s.startedAt, phase: s.phase } : {},
      onRehydrateStorage: () => (state) => {
        if (state?.promptId && ACTIVE.has(state.phase)) {
          state.busy = true
          ensurePolling()
          void pollOnce() // fresh tick immediately, don't wait for interval
        }
      },
    },
  ),
)

/* ─── Modular polling /api/comfy/status (lives outside React) ─── */

const POLL_MS = 2000
let pollTimer: ReturnType<typeof setInterval> | null = null
let pollInFlight = false
/** Counter of consecutive 'unknown's — prompt could have died along with
 *  ComfyUI restart (persisted 'running' after reload). */
let unknownStreak = 0

function ensurePolling() {
  if (pollTimer) return
  unknownStreak = 0
  pollTimer = setInterval(() => void pollOnce(), POLL_MS)
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
  unknownStreak = 0
}

async function pollOnce() {
  if (pollInFlight) return
  const s = useTileUpscaleJob.getState()
  const promptId = s.promptId
  if (!promptId || !ACTIVE.has(s.phase)) {
    stopPolling()
    return
  }
  pollInFlight = true
  try {
    const res = await fetch(`/api/comfy/status?prompt_id=${encodeURIComponent(promptId)}`, {
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) {
      // (fix 491) Non-OK response (502 — ComfyUI is down/restarting) previously
      // simply skipped the tick: unknownStreak did not increase, and with dead ComfyUI
      // "Generating..." hung INDEFINITELY. Count such ticks as 'unknown'.
      unknownStreak++
      if (unknownStreak >= 10) {
        useTileUpscaleJob.setState({
          phase: 'error',
          error: 'ComfyUI is not responding (server stopped or restarted) — tracking stopped',
          busy: false,
        })
        const qi = useGenQueue.getState().items.find((i) => i.promptId === promptId)
        if (qi) useGenQueue.getState().setStatus(qi.id, 'error', 'ComfyUI is not responding — tracking stopped')
        stopPolling()
      }
      return
    }
    const data = await res.json()
    const cur = useTileUpscaleJob.getState()
    if (cur.promptId !== promptId) return // already another job
    if (data.status === 'done') {
      useTileUpscaleJob.setState({ phase: 'done', progress: 100, busy: false })
      const qi = useGenQueue.getState().items.find((i) => i.promptId === promptId)
      if (qi) {
        useGenQueue.getState().setStatus(qi.id, 'done')
        useGenQueue.getState().setProgress(qi.id, 100, 100)
      }
      // Staggered gallery reloads — inside useVideoGallery on bump.
      useGalleryRefresh.getState().bump()
      stopPolling()
      // Keep promptId briefly for status card, then clear
      setTimeout(() => {
        const c = useTileUpscaleJob.getState()
        if (c.promptId === promptId && c.phase === 'done') useTileUpscaleJob.setState({ promptId: null })
      }, 7000)
    } else if (data.status === 'cancelled') {
      // Cancellation is NOT an error: clean return to initial state without red
      // banner (previously folded into phase 'error' with text "Cancelled").
      cancelRequestedFor = null
      useTileUpscaleJob.setState({ phase: 'idle', progress: 0, busy: false, promptId: null, startedAt: null })
      const qi = useGenQueue.getState().items.find((i) => i.promptId === promptId)
      if (qi) useGenQueue.getState().setStatus(qi.id, 'cancelled')
      stopPolling()
    } else if (data.status === 'error') {
      const qi = useGenQueue.getState().items.find((i) => i.promptId === promptId)
      if (cancelRequestedFor === promptId) {
        // ComfyUI reports interruption via /interrupt as error
        // (execution_interrupted) — for task canceled by user,
        // this is expected outcome, not an error: clean idle.
        cancelRequestedFor = null
        useTileUpscaleJob.setState({ phase: 'idle', progress: 0, busy: false, promptId: null, startedAt: null })
        if (qi) useGenQueue.getState().setStatus(qi.id, 'cancelled')
      } else {
        useTileUpscaleJob.setState({
          phase: 'error',
          error: data.error || data.detail || 'Generation error',
          busy: false,
        })
        if (qi) useGenQueue.getState().setStatus(qi.id, 'error', data.error || data.detail || 'Generation error')
      }
      stopPolling()
    } else if (data.status === 'unknown') {
      const qi = useGenQueue.getState().items.find((i) => i.promptId === promptId)
      // (fix 491) Own cancellation from queue: removed pending task
      // does not enter history → 'unknown'. This is expected outcome, not a failure —
      // clean idle (previously: 20s wait → red banner).
      if (cancelRequestedFor === promptId) {
        cancelRequestedFor = null
        useTileUpscaleJob.setState({ phase: 'idle', progress: 0, busy: false, promptId: null, startedAt: null })
        if (qi) useGenQueue.getState().setStatus(qi.id, 'cancelled')
        stopPolling()
        return
      }
      // ~10 ticks × 2s = 20s of unknown — honestly drop (task died
      // with ComfyUI restart, otherwise busy would hang forever).
      unknownStreak++
      if (unknownStreak >= 10) {
        useTileUpscaleJob.setState({
          phase: 'error',
          error: 'Task not found in ComfyUI (server was restarted) — tracking stopped',
          busy: false,
        })
        if (qi) useGenQueue.getState().setStatus(qi.id, 'error', 'Task not found in ComfyUI — tracking stopped')
        stopPolling()
      }
    } else {
      unknownStreak = 0
      // (fix 479) Progress from tracker (/api/comfy/progress) — monotonic
      // 0→100 based on KJ-event counter, rather than frozen progress.value/max
      // from ComfyUI status (MMH3UltimateUpscale does not send standard progress).
      try {
        const progRes = await fetch(`/api/comfy/progress?prompt_id=${encodeURIComponent(promptId)}`)
        if (progRes.ok) {
          const progData = await progRes.json()
          if (progData.progress && typeof progData.progress.percent === 'number') {
            useTileUpscaleJob.setState({ progress: progData.progress.percent })
            const qi = useGenQueue.getState().items.find((i) => i.promptId === promptId)
            if (qi) useGenQueue.getState().setProgress(qi.id, progData.progress.percent, 100)
          }
        }
      } catch { /* non-critical — next tick will retry */ }
    }
  } catch {
    /* transient — next tick will retry */
  } finally {
    pollInFlight = false
  }
}
