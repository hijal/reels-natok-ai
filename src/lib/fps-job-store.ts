'use client'

/**
 * (edit 554) FpsJobStore — job state of the "FPS" tab OUTSIDE React.
 * Copy of the ControlNetJobStore pattern (edits 319/330/491/497/512):
 *  • promptId/phase/progress/error — in zustand store rather than view's useState;
 *    previously FpsView kept them locally — tab switching unmounted the
 *    component, polling died, status was reset, task became orphaned
 *    (button became active again → repeat click = second task);
 *  • SINGLE modular polling loop for /api/comfy/status — survives unmount;
 *  • upon completion — useGalleryRefresh.bump();
 *  • active promptId is persisted → re-attach after page reload;
 *  • (edit 554) registration in shared queue (useGenQueue, type 'fps') —
 *    QueueIndicator sees the task and survives reload with it;
 *  • cancellation epoch: cancel() during in-flight POST cancels accepted task;
 *  • user's own cancellation is never shown as a red error banner.
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { toast } from 'sonner'
import { useGalleryRefresh } from '@/lib/gallery-refresh-store'
import { useGenQueue } from '@/lib/gen-queue-store'
import { acquireComfyTurn, isComfyTurnActive } from '@/lib/comfy-turn'

export type FpsPhase = 'idle' | 'submitting' | 'running' | 'done' | 'error'

export interface FpsSubmitBody {
  inputSource?: string
  sourceFilename?: string
  sourceSubfolder?: string
  mode?: string
  multiplier?: number
  [key: string]: unknown
}

interface FpsJobState {
  phase: FpsPhase
  progress: number
  error: string | null
  promptId: string | null
  startedAt: number | null
  busy: boolean

  submit: (body: FpsSubmitBody) => Promise<void>
  cancel: () => Promise<void>
  reset: () => void
}

const ACTIVE: ReadonlySet<FpsPhase> = new Set(['submitting', 'running'])

/* Cancellation epoch (like edit 330 in ControlNet): cancel() during
 * 'submitting' (POST still in flight, no promptId yet) — submit() notices epoch
 * change after await POST and immediately cancels the returned prompt_id. */
let cancelEpoch = 0

/** promptId for which user requested cancellation. ComfyUI reports
 *  interrupted tasks in history as 'error' (execution_interrupted) rather than
 *  'cancelled' — without marking, poller displayed own cancellation as a red
 *  banner "Generation error" (this was an old fps-view bug). */
let cancelRequestedFor: string | null = null

/** queue-item owning tab state; protects against delayed
 *  response of cancelled POST when next task has already started. */
let activeQid: string | null = null

/** (edit 555) Mark promptId as cancel-requested — called from
 *  QueueIndicator when cancelling FPS/ControlNet task FROM the queue: tab's own
 *  poller will then treat subsequent 'error' (interrupted) as
 *  clean cancellation rather than failure. */
export function markFpsCancelRequested(promptId: string) {
  cancelRequestedFor = promptId
}

export const useFpsJob = create<FpsJobState>()(
  persist(
    (set, get) => ({
      phase: 'idle',
      progress: 0,
      error: null,
      promptId: null,
      startedAt: null,
      busy: false,

      submit: async (body) => {
        // (edit 554) Queue: no busy blocking — multiple tasks can be added.
        // Store tracks the LAST submitted task (for UI status), while
        // gen-queue-store tracks all of them.
        const label = typeof body.sourceFilename === 'string' && body.sourceFilename
          ? `FPS: ${body.sourceFilename}`
          : 'FPS'
        const qid = useGenQueue.getState().enqueue('fps', label)

        // Unified FIFO: don't alter tab state while task is waiting for its turn.
        const granted = await acquireComfyTurn(qid)
        if (!granted || !isComfyTurnActive(qid)) return

        // Capture cancellation epoch only at the start of own task, not when
        // enqueuing: Cancel of current job must not cancel all tasks still
        // waiting in queue.
        const myEpoch = cancelEpoch
        cancelRequestedFor = null
        activeQid = qid
        set({ phase: 'submitting', busy: true, error: null, progress: 0, startedAt: Date.now() })

        try {
          const res = await fetch('/api/comfy/fps', {
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
          // Cancellation arrived while POST was in flight: task is already in ComfyUI —
          // cancel it on the server and DO NOT start polling.
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
          toast.success('FPS started')
          ensurePolling()
        } catch (e) {
          if (!useGenQueue.getState().items.find((i) => i.id === qid)?.error) {
            useGenQueue.getState().setStatus(qid, 'error', e instanceof Error ? e.message : String(e))
          }
          if (activeQid === qid) {
            activeQid = null
            set({ phase: 'error', error: e instanceof Error ? e.message : String(e), busy: false })
          }
        }
      },

      cancel: async () => {
        // Increment epoch BEFORE checking promptId: if POST is still in flight,
        // submit() continuation will notice the change and cancel the accepted task itself.
        cancelEpoch++
        const { promptId, phase } = get()
        if (!promptId) {
          if (phase === 'submitting') {
            set({ phase: 'idle', busy: false, progress: 0, startedAt: null })
            toast.info('Cancelled')
          }
          return
        }
        // After cancellation is CONFIRMED by the server — immediate clean idle and stop
        // polling (like edit 491 in ControlNet).
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
          // (edit 555) Mark shared queue item as cancelled — previously card
          // in QueueIndicator remained "running" without poller and
          // transitioned to "Error" after ~2 min.
          const qi = useGenQueue.getState().items.find((i) => i.promptId === promptId)
          if (qi) useGenQueue.getState().setStatus(qi.id, 'cancelled')
          if (activeQid === null || activeQid === qi?.id) {
            activeQid = null
            stopPolling()
            set({ phase: 'idle', progress: 0, busy: false, promptId: null, startedAt: null })
          }
          toast.info('Cancelled')
        } else {
          cancelRequestedFor = null
          toast.error('Cancellation not confirmed by server — check that ComfyUI is running')
        }
      },

      reset: () => {
        cancelEpoch++
        cancelRequestedFor = null
        activeQid = null
        stopPolling()
        set({ phase: 'idle', progress: 0, error: null, promptId: null, startedAt: null, busy: false })
      },
    }),
    {
      name: 'fps-job',
      partialize: (s) =>
        ACTIVE.has(s.phase) ? { promptId: s.promptId, startedAt: s.startedAt, phase: s.phase } : {},
      onRehydrateStorage: () => (state) => {
        if (state?.promptId && ACTIVE.has(state.phase)) {
          state.busy = true
          ensurePolling()
          void pollOnce()
        }
      },
    },
  ),
)

/* ─── Modular polling /api/comfy/status (lives outside React) ─── */

const POLL_MS = 2000
let pollTimer: ReturnType<typeof setInterval> | null = null
let pollInFlight = false
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
  const s = useFpsJob.getState()
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
      // Non-OK response (502 — ComfyUI is down/restarting) is treated as
      // 'unknown' (like edit 491 in ControlNet): otherwise if ComfyUI is dead
      // "Processing..." would hang indefinitely.
      unknownStreak++
      if (unknownStreak >= 10) {
        useFpsJob.setState({
          phase: 'error',
          error: 'ComfyUI is not responding (server stopped or restarting) — tracking stopped',
          busy: false,
        })
        stopPolling()
      }
      return
    }
    const data = await res.json()
    const cur = useFpsJob.getState()
    if (cur.promptId !== promptId) return // already another job
    if (data.status === 'done') {
      useFpsJob.setState({ phase: 'done', progress: 100, busy: false })
      // (edit 554) Update queue
      const qi = useGenQueue.getState().items.find((i) => i.promptId === promptId)
      if (qi) useGenQueue.getState().setStatus(qi.id, 'done')
      // Gallery: bump immediately + delayed — finalization of .meta.json on
      // server may lag behind done status (old fps-view did reloads
      // at 1/3/6 s).
      useGalleryRefresh.getState().bump()
      setTimeout(() => useGalleryRefresh.getState().bump(), 3000)
      stopPolling()
      setTimeout(() => {
        const c = useFpsJob.getState()
        if (c.promptId === promptId && c.phase === 'done') useFpsJob.setState({ promptId: null })
      }, 7000)
    } else if (data.status === 'cancelled') {
      cancelRequestedFor = null
      useFpsJob.setState({ phase: 'idle', progress: 0, busy: false, promptId: null, startedAt: null })
      const qi2 = useGenQueue.getState().items.find((i) => i.promptId === promptId)
      if (qi2) useGenQueue.getState().setStatus(qi2.id, 'cancelled')
      stopPolling()
    } else if (data.status === 'error') {
      if (cancelRequestedFor === promptId) {
        // Own cancellation: ComfyUI reports interrupt as 'error' —
        // render clean cancellation rather than red banner (old fps-view bug:
        // data.status === 'cancelled' || 'error' both went to error branch).
        cancelRequestedFor = null
        useFpsJob.setState({ phase: 'idle', progress: 0, busy: false, promptId: null, startedAt: null })
        const qi3 = useGenQueue.getState().items.find((i) => i.promptId === promptId)
        if (qi3) useGenQueue.getState().setStatus(qi3.id, 'cancelled')
      } else {
        useFpsJob.setState({
          phase: 'error',
          error: data.error || data.detail || 'Generation error',
          busy: false,
        })
        const qi4 = useGenQueue.getState().items.find((i) => i.promptId === promptId)
        if (qi4) useGenQueue.getState().setStatus(qi4.id, 'error', data.error || 'Error')
      }
      stopPolling()
    } else if (data.status === 'unknown') {
      if (cancelRequestedFor === promptId) {
        cancelRequestedFor = null
        useFpsJob.setState({ phase: 'idle', progress: 0, busy: false, promptId: null, startedAt: null })
        stopPolling()
        return
      }
      unknownStreak++
      if (unknownStreak >= 10) {
        useFpsJob.setState({
          phase: 'error',
          error: 'Task not found in ComfyUI (server was restarted) — tracking stopped',
          busy: false,
        })
        stopPolling()
      }
    } else {
      unknownStreak = 0
      // Progress from tracker (/api/comfy/progress) — by KJ events count.
      try {
        const progRes = await fetch(`/api/comfy/progress?prompt_id=${encodeURIComponent(promptId)}`)
        if (progRes.ok) {
          const progData = await progRes.json()
          if (progData.progress && typeof progData.progress.percent === 'number') {
            useFpsJob.setState({ progress: progData.progress.percent })
          }
        }
      } catch { /* non-critical */ }
    }
  } catch {
    /* transient — next tick will retry */
  } finally {
    pollInFlight = false
  }
}
