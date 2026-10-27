'use client'

/**
 * (fix 77) UpscaleService — client-side singleton for DLSS service state.
 *
 * Why it exists: previously status polling, auto-start, and job tracking lived in
 * the UpscaleView component's useEffect. Switching tabs (AnimatePresence
 * in page.tsx) unmounts the tab → interval dies → during service startup
 * the UI "freezes", and after switching back "suddenly comes alive"
 * (fresh mount sees running=true). Similarly, job progress was lost
 * if user switched to another tab.
 *
 * Now (pattern like in assistant-stream.ts):
 *  • service status, parameter schema, and active job live in Zustand store;
 *  • SINGLE poll loop at the module level — survives tab unmounting;
 *  • completion toasts fire in the loop — once, regardless of whether
 *    the tab is mounted;
 *  • any (re)mounted UpscaleView immediately sees up-to-date state
 *    because attach triggers an immediate tick.
 */
import { create } from 'zustand'
import { toast } from 'sonner'

/* ────────────────────────────────────────────────────────────────
 * API types (extracted from upscale-view.tsx)
 * ──────────────────────────────────────────────────────────────── */

export interface UpscaleGpu {
  uuid: string
  label: string
  ai_compatible: boolean
  memory_gb: number
}

export interface UpscaleStatusResp {
  enabled: boolean
  port: number
  dir: string
  service: { running: boolean; starting: boolean; error: string | null; startedAt: number }
  health: {
    ok: boolean
    ready: boolean
    error: string | null
    gpus: UpscaleGpu[]
    output_dir: string
    features: string[]
    log_tail: string[]
  } | null
}

export interface UpscaleFeatureSchema {
  label: string
  media: string
  quality_kind: 'int' | 'str'
  defaults: Record<string, unknown>
  choices: Record<string, unknown>
}

export type UpscaleSchema = Record<string, UpscaleFeatureSchema>

export interface UpscaleJob {
  id: string
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled'
  progress: number
  message: string | null
  error: string | null
  output: Record<string, unknown> | null
  downloadUrl?: string
  downloadName?: string
}

export const isUpscaleJobActive = (j: UpscaleJob | null): boolean =>
  !!j && (j.status === 'queued' || j.status === 'running')

/* ────────────────────────────────────────────────────────────────
 * Store
 * ──────────────────────────────────────────────────────────────── */

interface UpscaleServiceState {
  /** Latest /api/upscale/status response. */
  st: UpscaleStatusResp | null
  /** Parameter schema (loaded once when service is running). */
  schema: UpscaleSchema | null
  /** Active/latest job (progress, status). */
  job: UpscaleJob | null
  /** POST /start inflight (spinner on button). */
  startBusy: boolean
  /** POST /cancel inflight. */
  cancelBusy: boolean
  /** Do not auto-start after hard server error (until explicit "Start"). */
  gaveUp: boolean

  tick: () => Promise<void>
  loadSchema: () => Promise<void>
  start: (opts?: { auto?: boolean }) => Promise<void>
  stop: () => Promise<void>
  /**
   * (fix 716) Returns start result: ok/jobId/error/busy.
   * Previously returned void, and the upscale queue could not distinguish
   * "server rejected (GPU busy)" from "successfully launched".
   */
  run: (
    feature: string,
    input: string,
    options: Record<string, unknown>,
  ) => Promise<{ ok: boolean; jobId?: string; error?: string; busy?: boolean }>
  cancel: () => Promise<void>
  resetJob: () => void
  _pollJob: (id: string) => Promise<void>
  _setSt: (st: UpscaleStatusResp | null) => void
  _setSchema: (s: UpscaleSchema | null) => void
  _setJob: (j: UpscaleJob | null) => void
  _setFlag: (p: Partial<Pick<UpscaleServiceState, 'startBusy' | 'cancelBusy' | 'gaveUp'>>) => void
}

export const useUpscaleService = create<UpscaleServiceState>((set, get) => ({
  st: null,
  schema: null,
  job: null,
  startBusy: false,
  cancelBusy: false,
  gaveUp: false,

  tick: async () => {
    if (tickInFlight) return
    tickInFlight = true
    try {
      let d: UpscaleStatusResp | null = null
      try {
        const r = await fetch('/api/upscale/status', { signal: AbortSignal.timeout(6000) })
        if (r.ok) d = (await r.json()) as UpscaleStatusResp
      } catch {
        /* server unavailable — don't touch state (might be expected) */
      }
      const s = get()
      if (d) {
        s._setSt(d)
        // Auto-start: service is not running and not starting, user did not
        // stop explicitly, and we are not in gaveUp mode.
        if (
          d.enabled !== false &&
          !d.service.running &&
          !d.service.starting &&
          !s.gaveUp &&
          Date.now() - lastStopAt > 10_000
        ) {
          void s.start({ auto: true })
        }
        // Hard server error (not "starting") — stop auto-pinging.
        if (d.service.error && !d.service.starting) {
          s._setFlag({ gaveUp: true })
        }
        // Schema — once when service is up.
        if (d.service.running && !s.schema) {
          void s.loadSchema()
        }
        // Job — one request per tick while active (placeholder id '…'
        // means POST /render is still in flight — nothing to poll yet).
        const j = s.job
        if (isUpscaleJobActive(j) && j!.id !== '…') {
          void s._pollJob(j!.id)
        }
      }
    } finally {
      tickInFlight = false
    }
  },

  loadSchema: async () => {
    if (schemaInFlight || get().schema) return
    schemaInFlight = true
    try {
      const r = await fetch('/api/upscale/schema', { signal: AbortSignal.timeout(8000) })
      if (!r.ok) return
      const s = (await r.json()) as { features?: UpscaleSchema }
      if (s.features) get()._setSchema(s.features)
    } catch {
      /* bridge still starting — retry on next tick */
    } finally {
      schemaInFlight = false
    }
  },

  start: async (opts?: { auto?: boolean }) => {
    const s = get()
    if (s.startBusy) return
    // Explicit "Start" clears "gaveUp" / "stopped by user".
    if (!opts?.auto) s._setFlag({ gaveUp: false })
    s._setFlag({ startBusy: true })
    try {
      const r = await fetch(opts?.auto ? '/api/upscale/start?auto=1' : '/api/upscale/start', {
        method: 'POST',
      })
      const d = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string }
      if (!r.ok) {
        // (fix) explicit failure — set gaveUp, otherwise tick after 2.5s
        // will send /start?auto=1 again and user will see repeated errors
        // despite already clicking "Start".
        if (!opts?.auto) {
          s._setFlag({ gaveUp: true })
          toast.error(d.error ?? 'Failed to start Upscale service')
        }
        // auto-start silent — tick will keep trying until gaveUp becomes true
      }
    } catch (e) {
      if (!opts?.auto) {
        s._setFlag({ gaveUp: true })
        toast.error(e instanceof Error ? e.message : 'Failed to start Upscale service')
      }
    } finally {
      s._setFlag({ startBusy: false })
      void get().tick()
    }
  },

  stop: async () => {
    try {
      const r = await fetch('/api/upscale/stop', { method: 'POST' })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      // (fix) success: only now reset state — otherwise UI "sticks"
      // on last status during network error (st=null + gaveUp=true → polling
      // stops silently, user sees UI hanging).
      lastStopAt = Date.now()
      get()._setSchema(null)
      get()._setSt(null)
      // (fix) after explicit stop DO NOT auto-start until user
      // clicks "Start" (start without auto resets flag). Previously after 10s
      // tick started sending /start?auto=1 indefinitely.
      get()._setFlag({ gaveUp: true })
      // (fix) active job dies with the service — otherwise isBusy forever.
      const j = get().job
      if (j && isUpscaleJobActive(j)) {
        get()._setJob({ ...j, status: 'cancelled', message: 'Service stopped' })
        toast.info('Render cancelled — service stopped')
      }
      toast.success('Upscale service stopped')
    } catch {
      // (fix) stop error: DO NOT touch state — service on server
      // is likely still alive. If we reset st/gaveUp, tick after 2.5s
      // would silently restart the service the user asked to stop.
      // User sees toast and can retry manually.
      toast.error('Failed to stop service — please try again')
    } finally {
      void get().tick()
    }
  },

  run: async (feature, input, options): Promise<{ ok: boolean; jobId?: string; error?: string; busy?: boolean }> => {
    set({
      job: { id: '…', status: 'queued', progress: 0, message: 'Starting…', error: null, output: null },
    })
    try {
      const r = await fetch('/api/upscale/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feature, input, options }),
        signal: AbortSignal.timeout(180000),
      })
      const d = (await r.json().catch(() => ({}))) as {
        ok?: boolean
        jobId?: string
        error?: string
        busy?: boolean
      }
      if (!r.ok || !d.ok || !d.jobId) {
        // (fix 716) RETURN result: previously run() never threw or returned anything,
        // so the upscale queue couldn't distinguish "server rejected (GPU busy)"
        // from "launched", falling back to generic "Task lost".
        const error = d.busy ? 'GPU busy with another render' : d.error ?? `render → ${r.status}`
        set({ job: null })
        toast.error(error)
        return { ok: false, error, busy: !!d.busy }
      }
      set({
        job: { id: d.jobId, status: 'queued', progress: 0, message: 'Waiting for GPU', error: null, output: null },
      })
      toast.info('Render started')
      return { ok: true, jobId: d.jobId }
    } catch (e) {
      const error = e instanceof Error ? e.message : 'Failed to start render'
      set({ job: null })
      toast.error(error)
      return { ok: false, error }
    }
  },

  cancel: async () => {
    const j = get().job
    if (!j || !isUpscaleJobActive(j)) return
    // (fix) id is still placeholder — /render in flight, nothing to cancel on bridge
    // (previously: /cancel?id=… → 404 → scary error toast).
    if (j.id === '…') {
      toast.info('Render is still starting — cancellation will be available in a few seconds')
      return
    }
    get()._setFlag({ cancelBusy: true })
    try {
      const r = await fetch(`/api/upscale/cancel?id=${encodeURIComponent(j.id)}`, { method: 'POST' })
      const d = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string }
      if (r.ok && d.ok) toast.info('Cancellation sent — process will terminate')
      else toast.error(d.error ?? 'Failed to send cancellation')
    } catch {
      toast.error('Upscale service is not responding')
    } finally {
      get()._setFlag({ cancelBusy: false })
    }
  },

  resetJob: () => set({ job: null }),

  _pollJob: async (id: string) => {
    try {
      const r = await fetch(`/api/upscale/job?id=${encodeURIComponent(id)}`, {
        signal: AbortSignal.timeout(10000),
      })
      const d = (await r.json().catch(() => ({}))) as UpscaleJob & { error?: string }
      if (!r.ok) {
        // Service could fail temporarily — show and continue polling.
        const prev = get().job
        if (prev && isUpscaleJobActive(prev)) {
          get()._setJob({ ...prev, message: d.error ?? `job → ${r.status}` })
        }
        return
      }
      const prev = get().job
      if (!prev || prev.id !== d.id) return
      get()._setJob(d)
      if (d.status === 'done') {
        toast.success('Processing complete — result saved to shared gallery')
      } else if (d.status === 'error') {
        toast.error(d.error ?? 'Processing error')
      } else if (d.status === 'cancelled') {
        toast.info('Processing cancelled')
      }
    } catch {
      /* bridge did not respond — next tick will retry */
    }
  },

  _setSt: (st) => set({ st }),
  _setSchema: (schema) => set({ schema }),
  _setJob: (job) => set({ job }),
  _setFlag: (p) => set(p),
}))

/* ────────────────────────────────────────────────────────────────
 * Singleton poll loop (module level — survives tab unmounting)
 * ──────────────────────────────────────────────────────────────── */

let pollTimer: ReturnType<typeof setInterval> | null = null
let tickInFlight = false
let schemaInFlight = false
let attached = 0
/** Do not auto-start within 10s of explicit stop by user. */
let lastStopAt = 0

function ensurePolling() {
  if (pollTimer) return
  pollTimer = setInterval(() => {
    void useUpscaleService.getState().tick()
  }, 2500)
}

/** Subscribe (mount tab). Repeated attach calls are idempotent. */
export function attachUpscaleService() {
  attached += 1
  ensurePolling()
  void useUpscaleService.getState().tick()
}

/** Unsubscribe (unmount tab). Poll loop STAYS ALIVE — this is the bugfix:
 * service state and job continue updating when user switches tabs. */
export function detachUpscaleService() {
  attached = Math.max(0, attached - 1)
}
