'use client'

/**
 * FaceRefineJobStore — Face Refine job state OUTSIDE React.
 *
 * Pattern tile-upscale-job-store: promptId/phase/progress/error live in
 * zustand store, modular polling loop for /api/comfy/status survives unmount
 * of the tab, upon completion — useGalleryRefresh.bump() (staggered reloads
 * of gallery are built into useVideoGallery upon bump).
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { toast } from 'sonner'
import { useGalleryRefresh } from '@/lib/gallery-refresh-store'
import { useGenQueue } from '@/lib/gen-queue-store'
import { acquireComfyTurn, isComfyTurnActive } from '@/lib/comfy-turn'

export type FaceRefinePhase = 'idle' | 'submitting' | 'running' | 'done' | 'error'

export interface FaceRefineSubmitBody {
  inputSource?: string
  sourceFilename?: string
  sourceSubfolder?: string
  prompt?: string
  seed?: number
  [key: string]: unknown
}

interface FaceRefineJobState {
  phase: FaceRefinePhase
  progress: number
  error: string | null
  promptId: string | null
  startedAt: number | null
  busy: boolean

  submit: (body: FaceRefineSubmitBody) => Promise<void>
  cancel: () => Promise<void>
  reset: () => void
}

const ACTIVE: ReadonlySet<FaceRefinePhase> = new Set(['submitting', 'running'])

/** Cancellation epoch: cancel() during 'submitting' breaks the epoch, and submit()
 *  cancels the task accepted by the server itself. */
let cancelEpoch = 0

/** promptId for which the user requested cancellation. ComfyUI reports
 *  an interrupted task as 'error' (execution_interrupted) — without this mark the poller
 *  would display its own cancellation with a red "Error" banner. */
let cancelRequestedFor: string | null = null

/** queue-item owning the tab state; protects against delayed
 *  response of a cancelled POST when the next task has already started. */
let activeQid: string | null = null

/** Cancellation from general queue: interrupted ComfyUI prompt should not be drawn
 *  with a red error banner. */
export function markFaceRefineCancelRequested(promptId: string) {
  cancelRequestedFor = promptId
}

export const useFaceRefineJob = create<FaceRefineJobState>()(
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
          ? `Face: ${body.sourceFilename}`
          : 'Face Refine'
        const qid = useGenQueue.getState().enqueue('face-refine', label)

        // Unified FIFO: multiple tasks can be queued; tab state
        // is changed only after acquiring turn.
        const granted = await acquireComfyTurn(qid)
        if (!granted || !isComfyTurnActive(qid)) return

        // Capture cancellation epoch only when starting own task, not at
        // enqueue time: Cancel of the current job must not cancel all
        // tasks still waiting in queue.
        const myEpoch = cancelEpoch
        cancelRequestedFor = null
        activeQid = qid
        set({ phase: 'submitting', busy: true, error: null, progress: 0, startedAt: Date.now() })

        try {
          const res = await fetch('/api/comfy/face-refine', {
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
          toast.success('Face Refine started')
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
        cancelEpoch++
        const { promptId, phase } = get()
        if (!promptId) {
          if (phase === 'submitting') {
            set({ phase: 'idle', busy: false, progress: 0, startedAt: null })
            toast.info('Cancelled')
          }
          return
        }
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
      name: 'face-refine-job',
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
/** Counter of consecutive 'unknown' responses — prompt could have died along with
 *  a ComfyUI restart. */
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
  const s = useFaceRefineJob.getState()
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
      unknownStreak++
      if (unknownStreak >= 10) {
        useFaceRefineJob.setState({
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
    const cur = useFaceRefineJob.getState()
    if (cur.promptId !== promptId) return
    if (data.status === 'done') {
      useFaceRefineJob.setState({ phase: 'done', progress: 100, busy: false })
      const qi = useGenQueue.getState().items.find((i) => i.promptId === promptId)
      if (qi) {
        useGenQueue.getState().setStatus(qi.id, 'done')
        useGenQueue.getState().setProgress(qi.id, 100, 100)
      }
      useGalleryRefresh.getState().bump()
      stopPolling()
      setTimeout(() => {
        const c = useFaceRefineJob.getState()
        if (c.promptId === promptId && c.phase === 'done') useFaceRefineJob.setState({ promptId: null })
      }, 7000)
    } else if (data.status === 'cancelled') {
      cancelRequestedFor = null
      useFaceRefineJob.setState({ phase: 'idle', progress: 0, busy: false, promptId: null, startedAt: null })
      const qi = useGenQueue.getState().items.find((i) => i.promptId === promptId)
      if (qi) useGenQueue.getState().setStatus(qi.id, 'cancelled')
      stopPolling()
    } else if (data.status === 'error') {
      const qi = useGenQueue.getState().items.find((i) => i.promptId === promptId)
      if (cancelRequestedFor === promptId) {
        cancelRequestedFor = null
        useFaceRefineJob.setState({ phase: 'idle', progress: 0, busy: false, promptId: null, startedAt: null })
        if (qi) useGenQueue.getState().setStatus(qi.id, 'cancelled')
      } else {
        useFaceRefineJob.setState({
          phase: 'error',
          error: data.error || data.detail || 'Face Refine error',
          busy: false,
        })
        if (qi) useGenQueue.getState().setStatus(qi.id, 'error', data.error || data.detail || 'Face Refine error')
      }
      stopPolling()
    } else if (data.status === 'unknown') {
      const qi = useGenQueue.getState().items.find((i) => i.promptId === promptId)
      if (cancelRequestedFor === promptId) {
        cancelRequestedFor = null
        useFaceRefineJob.setState({ phase: 'idle', progress: 0, busy: false, promptId: null, startedAt: null })
        if (qi) useGenQueue.getState().setStatus(qi.id, 'cancelled')
        stopPolling()
        return
      }
      unknownStreak++
      if (unknownStreak >= 10) {
        useFaceRefineJob.setState({
          phase: 'error',
          error: 'Task not found in ComfyUI (server was restarted) — tracking stopped',
          busy: false,
        })
        if (qi) useGenQueue.getState().setStatus(qi.id, 'error', 'Task not found in ComfyUI — tracking stopped')
        stopPolling()
      }
    } else {
      unknownStreak = 0
      try {
        const progRes = await fetch(`/api/comfy/progress?prompt_id=${encodeURIComponent(promptId)}`)
        if (progRes.ok) {
          const progData = await progRes.json()
          if (progData.progress && typeof progData.progress.percent === 'number') {
            useFaceRefineJob.setState({ progress: progData.progress.percent })
            const qi = useGenQueue.getState().items.find((i) => i.promptId === promptId)
            if (qi) useGenQueue.getState().setProgress(qi.id, progData.progress.percent, 100)
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
