/**
 * Upscale Queue — (fix 262).
 *
 * The DLSS bridge server supports only ONE active render (409 busy).
 * Previously the "Start" button was disabled while a task was running —
 * a second task could not be enqueued. Now upscale tasks are queued:
 * the runner serializes them and feeds them to useUpscaleService.run() one by one,
 * as soon as the GPU becomes free.
 *
 * Integration with global queue (useGenQueue, type 'upscale') — status
 * is visible in floating QueueIndicator and the status card on the tab.
 */
import { useGenQueue, type QueueItem } from './gen-queue-store'
import { useUpscaleService, isUpscaleJobActive } from './upscale-service'
import { toast } from 'sonner'
import { useGalleryRefresh } from './gallery-refresh-store'

export interface UpscaleTask {
  feature: string
  input: string
  options: Record<string, unknown>
  /** (fix 264) File source: name from gallery/upload — saved to sidecar. */
  sourceName?: string
  /** (fix 727) Source folder in gallery — output is moved there. */
  subfolder?: string
}

/** Tasks waiting in queue (module-level — survives tab switching). */
const tasks = new Map<string, UpscaleTask>()
let running = false
/**
 * (fix 716) Queue item id that the runner is processing RIGHT NOW.
 * Needed by sweep to distinguish a live task from an orphan after page reload:
 * items in queue (tasks) and item in progress (activeItemId)
 * are live; everything else is an orphan.
 */
let activeItemId: string | null = null

/** Enqueue upscale task in global queue. Returns queue item id. */
export function enqueueUpscale(task: UpscaleTask): string {
  const label = `Upscale: ${task.input.split('/').pop() || task.feature}`
  const id = useGenQueue.getState().enqueue('upscale', label)
  tasks.set(id, task)
  kick()
  return id
}

/** Active upscale queue items. */
export function activeUpscaleItems(items: QueueItem[]): QueueItem[] {
  return items.filter(
    (i) => i.type === 'upscale' && (i.status === 'submitting' || i.status === 'queued' || i.status === 'running'),
  )
}

/** Cancel all active upscales. */
export async function cancelActiveUpscales(): Promise<void> {
  const { setStatus } = useGenQueue.getState()
  for (const item of activeUpscaleItems(useGenQueue.getState().items)) {
    setStatus(item.id, 'cancelled')
    // (fix 334) Queued task waiting its turn — delete from Map as well: otherwise
    // orphan record remained forever (runner won't pick it up — item is
    // already cancelled, and Map was only cleaned when task is taken).
    // If task not started yet (no active job) — simply cancel.
    // If job active — cancel via service.
    const job = useUpscaleService.getState().job
    if (job && isUpscaleJobActive(job)) {
      await useUpscaleService.getState().cancel()
    }
  }
}

/**
 * (fix 329) Cancel a SINGLE upscale from QueueIndicator.
 * Previously cancelQueueItem for upscale took the !promptId branch (upscale queue
 * never sets promptId) → simply remove(item.id), while server-side DLSS
 * render continued running as a zombie. Now: cancelled status + task removed from Map
 * + actual cancellation of active render on bridge (same cancel as the button
 * on Upscale tab). The server keeps ONE active render and the runner
 * serializes tasks — active job corresponds to running item; if a queued
 * item is cancelled while another task's render is running, we don't send cancel to bridge.
 */
export async function cancelUpscaleItem(id: string): Promise<void> {
  const { setStatus } = useGenQueue.getState()
  const item = useGenQueue.getState().items.find((i) => i.id === id)
  tasks.delete(id) // (fix 334) clean up waiting task
  setStatus(id, 'cancelled')
  if (item?.status === 'running') {
    const job = useUpscaleService.getState().job
    if (job && isUpscaleJobActive(job)) {
      await useUpscaleService.getState().cancel()
    }
  }
}

/** Clean up orphan tasks after page reload. */
export function sweepOrphanUpscaleItems(): void {
  const { items, setStatus } = useGenQueue.getState()
  for (const it of items) {
    if (it.type !== 'upscale') continue
    if (it.status !== 'submitting' && it.status !== 'queued' && it.status !== 'running') continue
    // (fix 716) Upscale tasks DO NOT have ComfyUI prompt_id — DLSS bridge works
    // via its own API. The previous check `if (!it.promptId)` was ALWAYS true,
    // so sweep marked live tasks with error on every tab switch (tab unmounts
    // → sweep → 'running' item became 'error'; store then blocked error→running).
    // Now live tasks are: items in queue (tasks) and the item the runner is
    // processing right now (activeItemId), as well as when render is actually running on bridge.
    if (tasks.has(it.id) || it.id === activeItemId) continue
    const job = useUpscaleService.getState().job
    if (job && isUpscaleJobActive(job)) continue
    setStatus(it.id, 'error', 'Page reloaded — task was not dispatched. Please run again.')
  }
}

function kick() {
  if (running) return
  running = true
  void runLoop().finally(() => {
    running = false
    if (activeUpscaleItems(useGenQueue.getState().items).some((i) => tasks.has(i.id))) kick()
  })
}

const isCancelled = (id: string) =>
  useGenQueue.getState().items.find((i) => i.id === id)?.status === 'cancelled'

/**
 * (fix 716) Poll bridge job BY ITS ID.
 *
 * Previously the queue tracked the global slot useUpscaleService.job, which
 * gets overwritten by manual Upscale tab: poller switched to the wrong job and
 * completed with generic "Task lost". Now the queue queries its own
 * job directly and does not depend on global state.
 */
interface BridgeJob {
  id: string
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled'
  progress: number
  message?: string
  error?: string | null
  output?: { output_path?: string } | null
}

async function fetchUpscaleJob(jobId: string): Promise<BridgeJob | null> {
  try {
    const r = await fetch(`/api/upscale/job?id=${encodeURIComponent(jobId)}`, {
      signal: AbortSignal.timeout(15000),
    })
    if (!r.ok) return null
    const d = (await r.json().catch(() => null)) as BridgeJob | null
    if (!d || d.id !== jobId) return null
    return d
  } catch {
    return null
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function runLoop(): Promise<void> {
  for (;;) {
    // Find next task (submitting or queued)
    const item = useGenQueue
      .getState()
      .items.find(
        (i) =>
          i.type === 'upscale' &&
          (i.status === 'submitting' || i.status === 'queued') &&
          tasks.has(i.id),
      )
    if (!item) return

    const task = tasks.get(item.id)!
    tasks.delete(item.id)

    try {
      // (fix 716) Mark item as "in progress" — sweep must not
      // consider it an orphan.
      activeItemId = item.id
      await runTask(item.id, task)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      useGenQueue.getState().setStatus(item.id, 'error', msg)
    } finally {
      if (activeItemId === item.id) activeItemId = null
    }
  }
}

async function runTask(id: string, task: UpscaleTask): Promise<void> {
  const q = () => useGenQueue.getState()
  const svc = () => useUpscaleService.getState()

  q().setStatus(id, 'submitting')

  // (fix 716) Start generation timing (submit → done).
  const t0 = Date.now()
  // Output path of own job (not the service global slot).
  let lastOutput: { output_path?: string } | null = null

  // Wait until GPU is free (active job finishes)
  // Server returns 409 if busy — wait and retry.
  let attempts = 0
  const MAX_WAIT = 3600 // 1 hour max wait

  while (true) {
    if (isCancelled(id)) return
    if (attempts * 3 > MAX_WAIT) {
      throw new Error('Timed out waiting for GPU to become free')
    }

    // If there is an active job — wait for it to finish
    const job = svc().job
    if (job && isUpscaleJobActive(job)) {
      // (fix 716) setStatus(id, status, error?) — third argument is
      // ERROR, not message. Previously "Waiting for GPU release…" was passed here,
      // and error stuck (error ?? item.error) — successful
      // upscale showed red text. Status message should only use setMessage.
      q().setStatus(id, 'queued')
      q().setMessage(id, 'Waiting for GPU release…')
      await sleep(3000)
      attempts++
      continue
    }

    // GPU is free — start task
    // (fix 716) run() now returns ok/jobId/error: previously run() returned
    // NOTHING and did not throw, so queue could not distinguish
    // "server rejected (GPU busy)" from "started successfully" and
    // showed generic "Task lost".
    const started = await svc().run(task.feature, task.input, task.options)
    if (!started.ok || !started.jobId) {
      throw new Error(started.error || 'Server did not accept task (GPU busy)')
    }
    // Own job id: queue polls SPECIFICALLY this job onwards (not global
    // slot useUpscaleService.job which can be overwritten by manual
    // Upscale tab). Previously poller followed someone else's job and failed with
    // "Task lost".
    const jobId = started.jobId
    q().setStatus(id, 'running')

    // Wait for job completion via polling
    for (;;) {
      if (isCancelled(id)) return
      await sleep(2500)
      const cur = await fetchUpscaleJob(jobId)
      if (!cur) {
        throw new Error('Task lost')
      }
      if (cur.status === 'done') {
        lastOutput = cur.output ?? null
        break
      }
      if (cur.status === 'error') {
        throw new Error(cur.error || 'Processing error')
      }
      if (cur.status === 'cancelled') {
        throw new Error('Cancelled')
      }
      // Update progress in queue
      if (cur.progress > 0) {
        q().setProgress(id, Math.round(cur.progress * 100), 100)
      }
    }

    // (fix 727) DLSS bridge always writes to output root. If video came
    // from a gallery folder — move finished file (and sidecar) there, BEFORE
    // updating gallery, so the result is immediately in place.
    let outPath = lastOutput?.output_path
    if (typeof outPath === 'string' && outPath && task.subfolder) {
      try {
        const placed = await fetch('/api/upscale/place', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            path: outPath,
            subfolder: task.subfolder,
            job_id: jobId,
            source_name: task.sourceName,
          }),
        })
        const pd = (await placed.json().catch(() => ({}))) as { ok?: boolean; path?: string }
        if (placed.ok && pd.ok && typeof pd.path === 'string') outPath = pd.path
      } catch { /* move failed — file remained in root, result is not lost */ }
    }

    // Successful completion
    q().setStatus(id, 'done')
    q().setProgress(id, 100, 100)
    useGalleryRefresh.getState().bump()
    toast.success(task.subfolder
      ? `Upscale ready — video in folder "${task.subfolder}"`
      : 'Upscale ready — video in gallery')

    // (fix 264) Generation time + DLSS settings → result sidecar.
    // ensureUpscaleMeta created .meta.json on first 'done' poll; finalize
    // appends generation_time + feature + options (idempotent).
    // (fix 716) Take path from OWN job (lastOutput), not from
    // svc().job — global slot might have been overwritten by manual tab.
    if (typeof outPath === 'string' && outPath) {
      const genSec = Math.max(1, Math.round((Date.now() - t0) / 1000))
      void fetch('/api/upscale/finalize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: outPath,
          generation_time: genSec,
          feature: task.feature,
          options: task.options,
        }),
      }).catch(() => { /* metadata is non-critical for result */ })
    }
    return
  }
}
