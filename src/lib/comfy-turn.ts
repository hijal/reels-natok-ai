'use client'

/**
 * Unified FIFO gateway for all tasks executed by ComfyUI.
 *
 * The `useGenQueue` queue remains the tracker/UI, while this module guarantees
 * that no more than one application task is executing in ComfyUI at the same time.
 * Tasks are granted a turn in order of `createdAt` (i.e. order of enqueueing
 * into the shared queue), regardless of mode: Generate/Extend/Refine/
 * ControlNet/FPS/Tile Upscale/Face Refine.
 *
 * DLSS Upscale (type `upscale`) is NOT included here: it executes on a separate
 * bridge outside ComfyUI, and should continue to run in parallel.
 *
 * The turn is held until a terminal status of the queue item is reached
 * (`done` / `error` / `cancelled`). This avoids having to touch the pollers and
 * completion handlers of each mode: the gateway releases the turn on its own when
 * the queue item finishes.
 */

import {
  useGenQueue,
  type QueueItem,
  type QueueItemType,
} from './gen-queue-store'

/** Modes executed by ComfyUI that must run strictly one at a time. */
export const COMFY_GATED_TYPES: ReadonlySet<QueueItemType> = new Set<QueueItemType>([
  'video',
  'refine',
  'controlnet',
  'fps',
  'tile-upscale',
  'face-refine',
])

type TurnWaiter = {
  id: string
  createdAt: number
  order: number
  resolve: (granted: boolean) => void
}

let holderId: string | null = null
let waiters: TurnWaiter[] = []
let waiterOrder = 0
let unsubscribe: (() => void) | null = null
let pumping = false
let holderTimer: ReturnType<typeof setTimeout> | null = null
let cancelledReleaseTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Queue items created before loading this page originate from localStorage
 * of a previous run. If such an item with prompt_id holds the turn, on the
 * first new task we quickly check it against ComfyUI: after restarting ComfyUI,
 * old prompt_ids no longer exist and should not block the queue for minutes
 * while local/global pollers slowly encounter an error.
 */
const SESSION_STARTED_AT = Date.now()
let verifyingHolderId: string | null = null

/**
 * Emergency timeout: if a mode's poller died and an item remained stuck in
 * `submitting`/`running` forever, do not block the queue until app restart.
 * 6 hours safely covers the longest generations.
 */
const HOLDER_TIMEOUT_MS = 6 * 60 * 60 * 1000

function itemById(id: string): QueueItem | undefined {
  return useGenQueue.getState().items.find((item) => item.id === id)
}

function isActive(item: QueueItem | undefined): boolean {
  return (
    !!item &&
    (item.status === 'submitting' || item.status === 'queued' || item.status === 'running')
  )
}

function isGated(item: QueueItem | undefined): boolean {
  return !!item && COMFY_GATED_TYPES.has(item.type)
}

function verifyRestoredHolder() {
  if (!holderId || verifyingHolderId === holderId) return
  const item = itemById(holderId)
  if (!item || !item.promptId) return
  // Don't touch live tasks from the current session — their fate is decided by their pollers.
  if (item.createdAt >= SESSION_STARTED_AT) return

  const promptId = item.promptId
  const heldId = item.id
  verifyingHolderId = heldId
  void fetch(`/api/comfy/active?check=${encodeURIComponent(promptId)}`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(8000),
  })
    .then((res) => (res.ok ? res.json() : null))
    .then((data: { ok?: boolean; states?: Record<string, 'alive' | 'done' | 'gone'> } | null) => {
      if (!data || data.ok !== true) return
      if (holderId !== heldId) return
      if (data.states?.[promptId] !== 'gone') return
      console.log(`[comfy-turn] old task ${promptId} not found in ComfyUI — releasing turn`)
      useGenQueue
        .getState()
        .setStatus(heldId, 'error', 'Task from previous run was not found in ComfyUI — removing from queue.')
    })
    .catch(() => { /* ComfyUI is still starting up — leave as is */ })
    .finally(() => {
      if (verifyingHolderId === heldId) verifyingHolderId = null
    })
}

function clearHolderTimer() {
  if (holderTimer) clearTimeout(holderTimer)
  holderTimer = null
  if (cancelledReleaseTimer) clearTimeout(cancelledReleaseTimer)
  cancelledReleaseTimer = null
}

function armHolderTimer() {
  clearHolderTimer()
  holderTimer = setTimeout(() => {
    if (holderId) {
      console.warn(`[comfy-turn] watchdog: releasing stuck turn ${holderId}`)
      releaseHolder('watchdog')
    }
  }, HOLDER_TIMEOUT_MS)
}

/**
 * After a page reload, pending promises are lost, but a task with `promptId`
 * might still be running in ComfyUI. Restore its turn so that a new generation
 * does not start concurrently.
 */
function ensureHolderFromQueue(): boolean {
  if (holderId) return true

  const activeWithPrompt = useGenQueue
    .getState()
    .items.filter((item) => isGated(item) && !!item.promptId && isActive(item))
    .sort((a, b) => a.createdAt - b.createdAt)

  if (activeWithPrompt.length === 0) return false

  holderId = activeWithPrompt[0].id
  armHolderTimer()
  console.log(`[comfy-turn] restored active turn ${holderId}`)
  return true
}

/**
 * On cancellation, QueueIndicator first sets `cancelled`, and only then sends
 * `/api/comfy/cancel`. Do not release the turn immediately, otherwise the next task
 * might start while ComfyUI is still finishing up the cancelled one. A short grace period
 * closes this race condition without blocking the queue if the cancel request hangs.
 */
function scheduleCancelledRelease() {
  if (cancelledReleaseTimer) return
  cancelledReleaseTimer = setTimeout(() => {
    cancelledReleaseTimer = null
    if (!holderId) return
    const item = itemById(holderId)
    if (!item || item.status === 'cancelled') releaseHolder('cancelled')
  }, 1500)
}

function releaseHolder(reason: string) {
  if (!holderId) return
  const released = holderId
  holderId = null
  clearHolderTimer()
  console.log(`[comfy-turn] turn released ${released} (${reason})`)
  pump()
}

function ensureSubscription() {
  if (unsubscribe) return
  unsubscribe = useGenQueue.subscribe((state) => {
    if (holderId) {
      const item = state.items.find((candidate) => candidate.id === holderId)
      if (!item) {
        releaseHolder('removed')
        return
      }
      if (!isActive(item)) {
        if (item.status === 'cancelled') scheduleCancelledRelease()
        else releaseHolder(`status ${item.status}`)
        return
      }
    }
    // An item may have been cancelled/deleted while waiting for its turn. `pump`
    // will clean up such waiters and resolve them with granted=false.
    pump()
  })
}

function pump() {
  if (pumping || holderId) return
  pumping = true
  try {
    // A task surviving a reload has priority: it is already in ComfyUI.
    if (ensureHolderFromQueue()) return

    // Discard cancelled/deleted/already finished waiters.
    waiters = waiters.filter((waiter) => {
      const item = itemById(waiter.id)
      if (!isGated(item) || !isActive(item)) {
        waiter.resolve(false)
        return false
      }
      return true
    })

    if (waiters.length === 0) return

    waiters.sort((a, b) => a.createdAt - b.createdAt || a.order - b.order)
    const next = waiters.shift()
    if (!next) return

    const item = itemById(next.id)
    if (!item || !isGated(item) || !isActive(item)) {
      next.resolve(false)
      return
    }

    holderId = next.id
    armHolderTimer()
    console.log(`[comfy-turn] turn granted ${next.id} (${item.type})`)

    // While waiting, the item was displayed as "Queued"; now it is actually
    // being submitted. setStatus synchronously triggers subscriptions — `pumping` prevents
    // recursion.
    useGenQueue.getState().setStatus(next.id, 'submitting')
    next.resolve(true)
  } finally {
    pumping = false
  }
}

/**
 * Request a turn for a queue item.
 *
 * Returns `false` if the item was cancelled/deleted before acquiring turn —
 * calling code should simply exit without submitting a request to ComfyUI.
 */
export function acquireComfyTurn(id: string): Promise<boolean> {
  ensureSubscription()

  const item = itemById(id)
  if (!item || !isGated(item) || !isActive(item)) return Promise.resolve(false)
  if (holderId === id) return Promise.resolve(true)

  const holderBusy = ensureHolderFromQueue() || holderId !== null
  if (holderBusy) {
    useGenQueue.getState().setStatus(id, 'queued')
    // If the turn is held by an old persisted task, do not wait minutes for
    // its "natural" error — quickly verify prompt_id in ComfyUI.
    verifyRestoredHolder()
  }

  return new Promise<boolean>((resolve) => {
    waiters.push({
      id,
      createdAt: item.createdAt,
      order: waiterOrder++,
      resolve,
    })
    pump()
  })
}

/**
 * Prematurely release turn. Typically unnecessary: turn is released automatically
 * upon reaching terminal item status. Kept for emergency code paths.
 */
export function releaseComfyTurn(id: string): void {
  if (holderId === id) releaseHolder('manual')
}

/** Element still exists and is not cancelled/finished. Check after await
 *  acquire: user could have deleted the task right between turn grant and
 *  continuation of submit(). */
export function isComfyTurnActive(id: string): boolean {
  const item = itemById(id)
  return !!item && isGated(item) && isActive(item)
}

/** Initialization on app startup: restore turn for a live task. */
export function initComfyTurn(): void {
  ensureSubscription()
  if (ensureHolderFromQueue()) return
  pump()
}
