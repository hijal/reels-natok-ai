/**
 * (fix 718) Reconciliation of persistent "generation in progress" state with
 * live ComfyUI on app startup.
 *
 * Problem: the `gen-progress` store (and `gen-queue` queue) are saved in
 * localStorage. On app restart they restore the 'running'/'queued' phase — and
 * the "Generation in progress" card is immediately shown, even though the generation
 * ended long ago (ComfyUI restarted, job crashed, computer rebooted).
 * The user sees "generation in progress" while nothing is happening,
 * and the "Generate" button is blocked.
 *
 * What we do: once per session, ask ComfyUI which prompt_ids are
 * actually queued/running, and clear any "stuck" state.
 *
 * Important rules:
 *   • If ComfyUI DOES NOT RESPOND (booting up) — DO NOT touch state:
 *     we don't know what is happening and shouldn't guess.
 *   • If the task exists in ComfyUI — leave "in progress" as is; pollers
 *     will reconnect and track the task to completion.
 *   • If the task is not in ComfyUI — clear the "in progress" phase and mark
 *     the queue item as interrupted (with clear error text, not a silent hang).
 */
import { useGenProgress } from './gen-progress-store'
import { useGenQueue } from './gen-queue-store'
import { useControlNetJob } from './controlnet-job-store'
import { useFpsJob } from './fps-job-store'
import { useTileUpscaleJob } from './tile-upscale-job-store'
import { useFaceRefineJob } from './face-refine-job-store'

/** Phases in which the card shows "generation in progress". */
const ACTIVE_PHASES = ['submitting', 'queued', 'running'] as const

/** Whether already started (per session) — do not reconcile repeatedly. */
let started = false
/** Whether cancelled (component unmounted before response). */
let cancelled = false

/**
 * Reconciles state. Returns a promise that resolves when reconciliation
 * completes (successfully OR definitively impossible).
 */
export function reconcileGenerationOnStartup(): Promise<void> {
  if (started) return Promise.resolve()
  started = true
  cancelled = false
  return run().catch(() => {
    /* reconciliation is non-critical — silently proceed */
  })
}

async function run(): Promise<void> {
  // ComfyUI takes ~30-60s to boot. While it is unresponsive — there's nothing to reconcile,
  // but we shouldn't reset either. Wait up to 5 minutes and reconcile on FIRST successful response.
  const deadline = Date.now() + 5 * 60_000
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

  for (;;) {
    if (cancelled) return
    // Candidates to check: progress card + active queue items.
    const candidates = collectCandidates()
    const answer = await fetchActive(candidates)
    if (answer) {
      applyReconciliation(answer)
      return
    }
    if (Date.now() > deadline) return
    await delay(2500)
  }
}

/** prompt_ids that might appear "hung". */
function collectCandidates(): string[] {
  const out = new Set<string>()
  const video = useGenProgress.getState().video
  if (video.promptId && (ACTIVE_PHASES as readonly string[]).includes(video.phase)) {
    out.add(video.promptId)
  }
  for (const it of useGenQueue.getState().items) {
    if (it.status !== 'queued' && it.status !== 'running') continue
    if (it.promptId) out.add(it.promptId)
  }
  // Dedicated stores for ControlNet / FPS / Tile Upscale tabs — they have their own
  // persistent 'busy' flag and their own status card.
  const cn = useControlNetJob.getState()
  if (cn.busy && cn.promptId) out.add(cn.promptId)
  const fps = useFpsJob.getState()
  if (fps.busy && fps.promptId) out.add(fps.promptId)
  const tu = useTileUpscaleJob.getState()
  if (tu.busy && tu.promptId) out.add(tu.promptId)
  const fr = useFaceRefineJob.getState()
  if (fr.busy && fr.promptId) out.add(fr.promptId)
  return [...out]
}

interface ActiveAnswer {
  /** prompt_ids actually alive in the ComfyUI queue. */
  alive: Set<string>
  /** Detailed state of requested prompts. */
  states: Record<string, 'alive' | 'done' | 'gone'>
}

/** ComfyUI state. null — ComfyUI did not respond (cannot reconcile). */
async function fetchActive(candidates: string[]): Promise<ActiveAnswer | null> {
  try {
    const qs = candidates.length ? `?check=${encodeURIComponent(candidates.join(','))}` : ''
    const res = await fetch(`/api/comfy/active${qs}`, { cache: 'no-store' })
    if (!res.ok) return null
    const data = (await res.json()) as {
      ok?: boolean
      prompts?: string[]
      states?: Record<string, 'alive' | 'done' | 'gone'>
    }
    // ok === false → ComfyUI is unavailable, response is uninformative.
    if (data.ok !== true) return null
    return {
      alive: new Set(Array.isArray(data.prompts) ? data.prompts : []),
      states: data.states ?? {},
    }
  } catch {
    return null
  }
}

function applyReconciliation(answer: ActiveAnswer): void {
  const { alive, states } = answer
  const gone = (id: string) => states[id] === 'gone'

  // ── 1) "Generation in progress" card ──
  const video = useGenProgress.getState().video
  if (video.promptId && (ACTIVE_PHASES as readonly string[]).includes(video.phase)) {
    // "Not in queue" doesn't mean "interrupted" yet: the task may have just
    // finished (ComfyUI moves it to history). Only reset when
    // ComfyUI has no knowledge of this prompt at all ('gone').
    if (!alive.has(video.promptId) && gone(video.promptId)) {
      console.log(
        `[reconcile] generation ${video.promptId} missing from ComfyUI — resetting phase "${video.phase}"`,
      )
      useGenProgress.getState().resetVideoGen()
    }
  }

  // ── 2) Queue items in active statuses ──
  // "submitting" without prompt_id is a task whose POST /generate was inflight
  // when the application closed. Handled by existing inflight recovery
  // logic (use-video-gen) — do not touch.
  const items = useGenQueue.getState().items
  for (const it of items) {
    if (it.status !== 'queued' && it.status !== 'running') continue
    if (!it.promptId) continue
    if (alive.has(it.promptId)) continue
    if (!gone(it.promptId)) continue
    console.log(
      `[reconcile] task ${it.promptId} missing from ComfyUI — marking interrupted`,
    )
    useGenQueue
      .getState()
      .setStatus(it.id, 'error', 'Interrupted: application was restarted, generation not found in ComfyUI')
  }

  // ── 3) Dedicated stores for ControlNet / FPS / Tile Upscale tabs ──
  // They have their own persistent 'busy': after restart the tab also showed
  // "generation in progress" until their poller hit unknown responses.
  const cn = useControlNetJob.getState()
  if (cn.busy && cn.promptId && !alive.has(cn.promptId) && gone(cn.promptId)) {
    console.log(`[reconcile] ControlNet ${cn.promptId} missing from ComfyUI — clearing busy`)
    useControlNetJob.getState().reset()
  }
  const fps = useFpsJob.getState()
  if (fps.busy && fps.promptId && !alive.has(fps.promptId) && gone(fps.promptId)) {
    console.log(`[reconcile] FPS ${fps.promptId} missing from ComfyUI — clearing busy`)
    useFpsJob.getState().reset()
  }
  const tu = useTileUpscaleJob.getState()
  if (tu.busy && tu.promptId && !alive.has(tu.promptId) && gone(tu.promptId)) {
    console.log(`[reconcile] Tile Upscale ${tu.promptId} missing from ComfyUI — clearing busy`)
    useTileUpscaleJob.getState().reset()
  }
  const fr = useFaceRefineJob.getState()
  if (fr.busy && fr.promptId && !alive.has(fr.promptId) && gone(fr.promptId)) {
    console.log(`[reconcile] Face Refine ${fr.promptId} missing from ComfyUI — clearing busy`)
    useFaceRefineJob.getState().reset()
  }
}

/** Cancel waiting (called on unmount). */
export function cancelReconcile(): void {
  cancelled = true
}

/**
 * Cleans up items from general queue that no longer have a runner after app restart.
 * The queue is persisted, but payloads/waiting promises live only in page memory.
 * Video has separate inflight recovery via clientToken, so `submitting` video is
 * untouched; `queued` video means it was waiting its turn and was never dispatched.
 */
export function cleanupLostPendingQueueItems(): void {
  const { items, setStatus } = useGenQueue.getState()
  for (const item of items) {
    if (item.promptId) continue
    if (item.type === 'upscale') continue // DLSS lives separately
    if (item.status !== 'submitting' && item.status !== 'queued') continue
    if (item.type === 'video' && item.status === 'submitting') continue

    setStatus(
      item.id,
      'error',
      'The application was restarted — task was not dispatched. Please submit it again.',
    )
  }

  // If the lost task was video, the "Submitting.../Queued" card could remain
  // in persisted gen-progress. Do not reset it while there's a chance to recover
  // the POST via clientToken (`submitting` without promptId).
  const itemsNow = useGenQueue.getState().items
  const hasRecoverableVideo = itemsNow.some(
    (item) =>
      item.type === 'video' &&
      (!!item.promptId ||
        item.status === 'submitting' ||
        item.status === 'running' ||
        item.status === 'queued'),
  )
  if (!hasRecoverableVideo) {
    const video = useGenProgress.getState().video
    if (video.phase === 'submitting' || video.phase === 'queued') {
      useGenProgress.getState().resetVideoGen()
    }
  }
}
