'use client'

/**
 * (fix 497) ControlNetJobStore — job state for "ControlNet" tab
 * OUTSIDE React. Copy of TileUpscaleJobStore pattern (fixes 319/330/491):
 *  • promptId/phase/progress/error — in zustand store;
 *  • SINGLE modular polling loop for /api/comfy/status — survives unmount;
 *  • on completion — useGalleryRefresh.bump();
 *  • active promptId persisted → re-attached after page reload;
 *  • cancellation epoch: cancel() during in-flight POST cancels accepted task;
 *  • intentional cancellation never displays a red error banner.
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { toast } from 'sonner'
import { useGalleryRefresh } from '@/lib/gallery-refresh-store'
import { useGenQueue } from '@/lib/gen-queue-store' // (fix 512) shared queue
import { acquireComfyTurn, isComfyTurnActive } from '@/lib/comfy-turn'

export type ControlNetPhase = 'idle' | 'submitting' | 'running' | 'done' | 'error'

export interface ControlNetSubmitBody {
  inputSource?: string
  sourceFilename?: string
  sourceSubfolder?: string
  prompt?: string
  seed?: number
  duration?: number
  targetShortSide?: number
  controlType?: string
  [key: string]: unknown
}

interface ControlNetJobState {
  phase: ControlNetPhase
  progress: number
  error: string | null
  promptId: string | null
  startedAt: number | null
  busy: boolean

  submit: (body: ControlNetSubmitBody) => Promise<void>
  cancel: () => Promise<void>
  reset: () => void
}

const ACTIVE: ReadonlySet<ControlNetPhase> = new Set(['submitting', 'running'])

/* Cancellation epoch (fix 330): cancel() during 'submitting' (POST still in
 * flight, no promptId) — submit() notices the epoch change after await POST
 * and immediately cancels the returned prompt_id. */
let cancelEpoch = 0

/** promptId for which user requested cancellation. ComfyUI reports
 *  interrupted task in history as 'error' (execution_interrupted), not
 *  'cancelled' — without this flag the poller displayed user-initiated cancellation as red
 *  "Error" banner. */
let cancelRequestedFor: string | null = null

/** Which queue-item currently owns the tab state. Needed so that
 *  a delayed response of a cancelled POST does not overwrite the state of the next
 *  task that already received its turn. */
let activeQid: string | null = null

/** (fix 555) Mark promptId as cancellable — called from
 *  QueueIndicator when cancelling ControlNet task FROM the queue: tab's own
 *  poller will then treat subsequent 'error' (interrupted) as
 *  clean cancellation, not failure. */
export function markControlNetCancelRequested(promptId: string) {
  cancelRequestedFor = promptId
}

export const useControlNetJob = create<ControlNetJobState>()(
  persist(
    (set, get) => ({
      phase: 'idle',
      progress: 0,
      error: null,
      promptId: null,
      startedAt: null,
      busy: false,

      submit: async (body) => {
        // (fix 512) Queue: no blocking on busy — multiple tasks can be added.
        // Store tracks the LAST submitted task
        // (for status in UI), while gen-queue-store tracks all.
        // (fix 512) Registration in shared queue
        const label = typeof body.sourceFilename === 'string' && body.sourceFilename
          ? `ControlNet: ${body.sourceFilename}`
          : 'ControlNet'
        const qid = useGenQueue.getState().enqueue('controlnet', label)

        // Unified FIFO: don't touch tab store until we got our turn.
        // Otherwise cancelling a waiting task would leave the tab in busy.
        const granted = await acquireComfyTurn(qid)
        if (!granted || !isComfyTurnActive(qid)) return

        // Fix cancellation epoch only at start of own task, not at
        // enqueue time: Cancel of current job should not cancel all
        // tasks still standing in queue.
        const myEpoch = cancelEpoch
        cancelRequestedFor = null
        activeQid = qid
        set({ phase: 'submitting', busy: true, error: null, progress: 0, startedAt: Date.now() })

        try {
          const res = await fetch('/api/comfy/controlnet', {
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
          toast.success('ControlNet generation started')
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
        // Advance epoch BEFORE checking promptId: if POST is still in flight,
        // subsequent submit() will see epoch change and cancel the accepted task itself.
        cancelEpoch++
        const { promptId, phase } = get()
        if (!promptId) {
          if (phase === 'submitting') {
            set({ phase: 'idle', busy: false, progress: 0, startedAt: null })
            toast.info('Cancelled')
          }
          return
        }
        // After server-CONFIRMED cancellation — immediately clean idle and stop
        // polling (fix 491).
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
          // (fix 555) Mark shared queue item as cancelled — previously
          // card in QueueIndicator remained "running" without its own
          // poller and after ~2 min rolled over to "Error" / "Task not found".
          const qi = useGenQueue.getState().items.find((i) => i.promptId === promptId)
          if (qi) useGenQueue.getState().setStatus(qi.id, 'cancelled')
          // If the next task already received its turn, do not stop its
          // poller and do not overwrite its state.
          if (activeQid === null || activeQid === qi?.id) {
            activeQid = null
            stopPolling()
            set({ phase: 'idle', progress: 0, busy: false, promptId: null, startedAt: null })
          }
          toast.info('Cancelled')
        } else {
          cancelRequestedFor = null
          toast.error('Cancellation not confirmed by server — verify that ComfyUI is running')
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
      name: 'controlnet-job',
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
  const s = useControlNetJob.getState()
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
      // Non-OK response (502 — ComfyUI is down/restarting) treated as
      // 'unknown' (fix 491): otherwise with dead ComfyUI "Generation in progress…"
      // would hang indefinitely.
      unknownStreak++
      if (unknownStreak >= 10) {
        useControlNetJob.setState({
          phase: 'error',
          error: 'ComfyUI is not responding (server stopped or restarted) — tracking stopped',
          busy: false,
        })
        stopPolling()
      }
      return
    }
    const data = await res.json()
    const cur = useControlNetJob.getState()
    if (cur.promptId !== promptId) return // already another job
    if (data.status === 'done') {
      useControlNetJob.setState({ phase: 'done', progress: 100, busy: false })
      // (fix 512) Update queue
      const qi = useGenQueue.getState().items.find((i) => i.promptId === promptId)
      if (qi) useGenQueue.getState().setStatus(qi.id, 'done')
      useGalleryRefresh.getState().bump()
      stopPolling()
      setTimeout(() => {
        const c = useControlNetJob.getState()
        if (c.promptId === promptId && c.phase === 'done') useControlNetJob.setState({ promptId: null })
      }, 7000)
    } else if (data.status === 'cancelled') {
      cancelRequestedFor = null
      useControlNetJob.setState({ phase: 'idle', progress: 0, busy: false, promptId: null, startedAt: null })
      // (fix 512)
      const qi2 = useGenQueue.getState().items.find((i) => i.promptId === promptId)
      if (qi2) useGenQueue.getState().setStatus(qi2.id, 'cancelled')
      stopPolling()
    } else if (data.status === 'error') {
      if (cancelRequestedFor === promptId) {
        cancelRequestedFor = null
        useControlNetJob.setState({ phase: 'idle', progress: 0, busy: false, promptId: null, startedAt: null })
        const qi3 = useGenQueue.getState().items.find((i) => i.promptId === promptId)
        if (qi3) useGenQueue.getState().setStatus(qi3.id, 'cancelled')
      } else {
        useControlNetJob.setState({
          phase: 'error',
          error: data.error || data.detail || 'Generation error',
          busy: false,
        })
        // (fix 512)
        const qi4 = useGenQueue.getState().items.find((i) => i.promptId === promptId)
        if (qi4) useGenQueue.getState().setStatus(qi4.id, 'error', data.error || 'Error')
      }
      stopPolling()
    } else if (data.status === 'unknown') {
      if (cancelRequestedFor === promptId) {
        cancelRequestedFor = null
        useControlNetJob.setState({ phase: 'idle', progress: 0, busy: false, promptId: null, startedAt: null })
        stopPolling()
        return
      }
      unknownStreak++
      if (unknownStreak >= 10) {
        useControlNetJob.setState({
          phase: 'error',
          error: 'Task not found in ComfyUI (server was restarted) — tracking stopped',
          busy: false,
        })
        stopPolling()
      }
    } else {
      unknownStreak = 0
      // Progress from tracker (/api/comfy/progress) — by KJ-events counter.
      try {
        const progRes = await fetch(`/api/comfy/progress?prompt_id=${encodeURIComponent(promptId)}`)
        if (progRes.ok) {
          const progData = await progRes.json()
          if (progData.progress && typeof progData.progress.percent === 'number') {
            useControlNetJob.setState({ progress: progData.progress.percent })
          }
        }
      } catch { /* non-critical */ }
    }
  } catch {
    /* transient — next tick will try again */
  } finally {
    pollInFlight = false
  }
}
