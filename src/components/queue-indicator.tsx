'use client'

import { useState, useMemo, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  ImageIcon,
  MusicIcon,
  Volume2Icon,
  VideoIcon,
  Wand2Icon,
  XIcon,
  Trash2Icon,
  LoaderIcon,
  CheckCircleIcon,
  AlertCircleIcon,
  ClockIcon,
  DownloadIcon,
  XCircleIcon,
  ArrowUpFromLineIcon,
  WaypointsIcon, // (fix 512) ControlNet
  GaugeIcon, // (fix 554) FPS
  Grid3x3Icon,
  ScanFaceIcon,
} from 'lucide-react'
import { useGenQueue, TYPE_ACCENT, TYPE_LABEL, type QueueItemType } from '@/lib/gen-queue-store'
import { useAssistantPanel } from '@/lib/assistant-panel-store' // (fix 442) offset from assistant panel
import { useGalleryRefresh } from '@/lib/gallery-refresh-store'
import { cn } from '@/lib/utils'

/* ──────────────────── Icon Map ──────────────────── */

const TYPE_ICON: Record<QueueItemType, typeof ImageIcon> = {
  image: ImageIcon,
  music: MusicIcon,
  sound: Volume2Icon,
  video: VideoIcon,
  refine: Wand2Icon, // (fix 261) refine in general queue
  upscale: ArrowUpFromLineIcon, // (fix 262) upscale in general queue
  controlnet: WaypointsIcon, // (fix 512)
  fps: GaugeIcon, // (fix 554)
  'tile-upscale': Grid3x3Icon,
  'face-refine': ScanFaceIcon,
}

/* ──────────────────── Status Icons ──────────────────── */

/** Detect if a WanGP status message indicates model downloading */
function isDownloading(message: string | null | undefined): boolean {
  if (!message) return false
  return /download|loading|fetching/i.test(message)
}

function StatusIcon({ status, color, message }: { status: string; color: string; message?: string | null }) {
  switch (status) {
    case 'submitting':
    case 'queued':
      return <ClockIcon className="w-3 h-3" style={{ color }} />
    case 'running':
      if (isDownloading(message)) {
        return <DownloadIcon className="w-3 h-3 animate-pulse" style={{ color }} />
      }
      return <LoaderIcon className="w-3 h-3 animate-spin" style={{ color }} />
    case 'done':
      return <CheckCircleIcon className="w-3 h-3 text-emerald-400" />
    case 'cancelled':
      return <XIcon className="w-3 h-3 text-muted-foreground" />
    case 'error':
      return <AlertCircleIcon className="w-3 h-3 text-red-400" />
    default:
      return null
  }
}

/* ──────────────────── Status Labels ──────────────────── */

const STATUS_LABEL: Record<string, string> = {
  submitting: 'Submitting…',
  queued: 'Queued',
  running: 'Generating…',
  done: 'Done',
  cancelled: 'Cancelled',
  error: 'Error',
}

/* ──────────────────── Global poller ──────────────────── */
const GLOBAL_POLL_INTERVAL_MS = 8000

/**
 * Fallback poller: keeps queue alive even when use-video-gen is unmounted
 * (tab switched). 8s interval (instead of 4s) — reduces load on
 * ComfyUI, which responds slowly during generation (GPU blocks
 * event loop). use-video-gen already polls every 1s — this poller is a backup
 * only for edge cases.
 */
function useGlobalQueuePoller() {
  const items = useGenQueue((s) => s.items)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const activeJobIds = useMemo(
    () =>
      items
        .filter((it) => (it.status === 'submitting' || it.status === 'queued' || it.status === 'running') && it.promptId)
        .map((it) => it.promptId as string),
    [items],
  )

  useEffect(() => {
    if (activeJobIds.length === 0) {
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
      return
    }

    if (pollRef.current) return // already polling

    // Slow requests must not stack ticks — skip while one is in flight
    let busy = false
    // (fix) Consecutive 'unknown' counter for each video. Lives in effect closure,
    // not inside tick: previously Map was recreated every tick, counter never
    // accumulated, and threshold 15 was unreachable.
    const unknownCountMap = new Map<string, number>()
    // (fix) Threshold 15: during active generation ComfyUI event loop
    // is blocked by GPU operations, and /history may not respond within 30s →
    // false 502. 15 × 8s = 2 min of continuous unavailability.
    const UNKNOWN_THRESHOLD = 15
    pollRef.current = setInterval(async () => {
      if (busy) return
      busy = true
      try {
        const store = useGenQueue.getState()
        const active = store.items.filter(
          (it) => (it.status === 'submitting' || it.status === 'queued' || it.status === 'running') && it.promptId,
        )
        if (active.length === 0) {
          if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
          return
        }

        // (fix 141) Consecutive 'unknown' counter for each video.
        // If ComfyUI is unavailable N times in a row — show error, but do NOT delete
        // immediately: give the user time to restart ComfyUI.
        // (fix) unknownCountMap/UNKNOWN_THRESHOLD — see declaration above.

        // (fix) Parallel requests: 3 videos = 3 parallel fetches
        // instead of 3 sequential. ComfyUI responds slowly during generation
        // (GPU blocks event loop) — sequential requests accumulated delay,
        // and some resulted in 502.
        await Promise.allSettled(active.map(async (item) => {
          try {
            const res = await fetch(`/api/comfy/status?prompt_id=${encodeURIComponent(item.promptId!)}`)
            if (!res.ok) {
              const count = (unknownCountMap.get(item.id) ?? 0) + 1
              unknownCountMap.set(item.id, count)
              if (count >= UNKNOWN_THRESHOLD) {
                store.setStatus(item.id, 'error', 'ComfyUI is not responding. Please restart start.bat.')
              }
              return
            }
            unknownCountMap.delete(item.id)
            const s = await res.json()

            // Re-check: item could be cancelled/removed during request
            const fresh = useGenQueue.getState().items.find((it) => it.id === item.id)
            if (!fresh || fresh.status === 'cancelled' || fresh.status === 'done' || fresh.status === 'error') return

            if (s.detail) store.setMessage(item.id, s.detail)

            if (s.status === 'running') {
              try {
                const progRes = await fetch(`/api/comfy/progress?prompt_id=${encodeURIComponent(item.promptId!)}`)
                if (progRes.ok) {
                  const progData = await progRes.json()
                  if (progData.progress) {
                    store.setProgress(item.id, progData.progress.percent, 100)
                  }
                }
              } catch { /* non-critical */ }
            }

            if (s.status === 'running') {
              // (fix) Terminal-status guard: item could become error/done/cancelled
              // between fresh-check above and this call (race with rehydration effect).
              // Without this: error → running (resurrection).
              const guard = useGenQueue.getState().items.find((it) => it.id === item.id)
              if (guard && !['done', 'error', 'cancelled'].includes(guard.status)) {
                if (guard.status !== 'running') store.setStatus(item.id, 'running')
              }
            } else if (s.status === 'queued') {
              const guard = useGenQueue.getState().items.find((it) => it.id === item.id)
              if (guard && !['done', 'error', 'cancelled'].includes(guard.status)) {
                if (guard.status !== 'queued') store.setStatus(item.id, 'queued')
              }
            } else if (s.status === 'unknown') {
              // (fix) ComfyUI responds, but prompt_id is missing — task
              // was rejected or lost. Previously 'unknown' was handled ONLY
              // via !res.ok (502), and on 200+unknown the item spun forever
              // as "Queued". Now: counter + proper error.
              const count = (unknownCountMap.get(item.id) ?? 0) + 1
              unknownCountMap.set(item.id, count)
              if (count >= UNKNOWN_THRESHOLD) {
                const isNotFound = s.detail?.toLowerCase().includes('not found') || s.detail?.toLowerCase().includes('rejected')
                const errMsg = isNotFound
                  ? 'Task not found in ComfyUI — rejected or lost'
                  : 'ComfyUI is not responding'
                store.setStatus(item.id, 'error', errMsg)
              }
              return
            } else if (s.status === 'error') {
              // (fix) Only if item does not already have 'error' status
              const fresh = useGenQueue.getState().items.find((it) => it.id === item.id)
              if (fresh && fresh.status !== 'error') {
                console.warn(`[queue-poll] ${item.id}: SETTING ERROR — ${s.detail}`)
                store.setStatus(item.id, 'error', s.detail || 'Error')
              }
            } else if (s.status === 'done') {
              // (fix 332) refine-items are NOT finalized by this poller:
              // previously it set done without legacy-stitch of chunked
              // refinepart_* and without gallery bump. refine finalization is in
              // refine-queue (runner in active session, recoverOrphanRefineItem
              // after reload).
              if (item.type === 'refine') return
              // (fix) Only if item does not already have 'done' status
              // (use-video-gen already processed 'done' and started removal timer)
              const fresh = useGenQueue.getState().items.find((it) => it.id === item.id)
              if (fresh && fresh.status !== 'done') {
                store.setStatus(item.id, 'done')
                // Tab local poller might not have had time to bump: with
                // unified FIFO next task starts immediately after done, and
                // old poller already sees new promptId and exits. Update gallery
                // here so the result is not lost.
                if (
                  item.type === 'controlnet' ||
                  item.type === 'fps' ||
                  item.type === 'tile-upscale' ||
                  item.type === 'face-refine'
                ) {
                  useGalleryRefresh.getState().bump()
                }
              }
            }
          } catch {
            /* transient network error — keep polling */
          }
        }))
      } finally {
        busy = false
      }
    }, GLOBAL_POLL_INTERVAL_MS)

    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
    }
  }, [activeJobIds.length > 0]) // eslint-disable-line react-hooks/exhaustive-deps
}

/* ──────────────────── Cancel handler ──────────────────── */

async function cancelQueueItem(item: { id: string; promptId: string | null; type: QueueItemType }) {
  const { setStatus, remove } = useGenQueue.getState()
  // (fix 329) upscale: queue has no promptId, !promptId branch just
  // removed the item while server DLSS render continued working as a zombie.
  // Now — real cancellation (status + task from Map + cancel on bridge).
  if (item.type === 'upscale') {
    const { cancelUpscaleItem } = await import('@/lib/upscale-queue')
    await cancelUpscaleItem(item.id)
    return
  }
  // (fix 334) refine: cancel via refine-queue — cleans tasks Map of
  // unstarted tasks (otherwise the entry remained orphaned forever).
  if (item.type === 'refine') {
    const { cancelRefineItem } = await import('@/lib/refine-queue')
    await cancelRefineItem(item.id)
    return
  }
  // (fix 555) ControlNet/FPS: mark promptId as cancellable BEFORE
  // /api/comfy/cancel — otherwise the tab's own modular poller will see
  // 'error' (interrupted) from ComfyUI and render a red banner "Generation error"
  // instead of clean cancellation. Then — common path (cancel + status).
  if (item.type === 'controlnet' && item.promptId) {
    const { markControlNetCancelRequested } = await import('@/lib/controlnet-job-store')
    markControlNetCancelRequested(item.promptId)
  }
  if (item.type === 'fps' && item.promptId) {
    const { markFpsCancelRequested } = await import('@/lib/fps-job-store')
    markFpsCancelRequested(item.promptId)
  }
  if (item.type === 'tile-upscale' && item.promptId) {
    const { markTileUpscaleCancelRequested } = await import('@/lib/tile-upscale-job-store')
    markTileUpscaleCancelRequested(item.promptId)
  }
  if (item.type === 'face-refine' && item.promptId) {
    const { markFaceRefineCancelRequested } = await import('@/lib/face-refine-job-store')
    markFaceRefineCancelRequested(item.promptId)
  }
  if (!item.promptId) {
    // No job yet — just remove from queue
    remove(item.id)
    return
  }
  // Mark cancelled FIRST so the status pollers stop tracking this prompt
  // (they watch for 'cancelled' / removed items) before we hit the API.
  setStatus(item.id, 'cancelled')
  try {
    await fetch('/api/comfy/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt_id: item.promptId }),
    })
  } catch { /* ignore */ }
}

/* ──────────────────── Component ──────────────────── */

export function QueueIndicator({ activeTab }: { activeTab?: string } = {}) {
  const [expanded, setExpanded] = useState(false)
  // The queue store is persisted — on first client render it may already
  // contain items while SSR rendered none → hydration mismatch (React #418).
  // Render only after mount.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  // Global poller: keeps queue alive even when source tab is unmounted
  useGlobalQueuePoller()

  // (fix 442) On tabs with assistant panel on the right ("Generation",
  // "Extend"), indicator shifts left of the panel so as not to overlap
  // the chat input field. Expanded panel — its width, collapsed rail — 46px.
  const panelSpace = useAssistantPanel((s) => (s.collapsed ? 46 : s.width))

  // Single subscription — compute everything from items
  const items = useGenQueue((s) => s.items)
  const clearFinished = useGenQueue((s) => s.clearFinished)
  const remove = useGenQueue((s) => s.remove)

  const activeItems = useMemo(
    () => items.filter((it) => it.status !== 'done' && it.status !== 'error' && it.status !== 'cancelled'),
    [items]
  )
  const activeCount = activeItems.length
  const currentRunning = useMemo(
    () => items.find((it) => it.status === 'running' || it.status === 'submitting' || it.status === 'queued'),
    [items]
  )

  // Don't render anything before mount (SSR) or when there are no items
  if (!mounted || items.length === 0) return null

  const accent = currentRunning ? TYPE_ACCENT[currentRunning.type] : '#8B5CF6'
  const progressPercent =
    currentRunning && currentRunning.progressMax > 0
      ? Math.round((currentRunning.progressValue / currentRunning.progressMax) * 100)
      : 0

  // (fix 442) Right offset: assistant panel on generate/extend
  // (fix 502: and controlnet) + 16px gap.
  const rightOffset =
    (activeTab === 'generate' || activeTab === 'extend' || activeTab === 'controlnet' ? panelSpace : 0) + 16

  return (
    // Bottom-right corner: stays out of the way of the prompt line.
    // flex-col-reverse makes the expanded panel open UP from the pill.
    <div
      className="fixed bottom-4 z-50 flex flex-col-reverse items-end gap-2 pointer-events-none transition-[right] duration-200 ease-in-out"
      style={{ right: rightOffset }}
    >
      {/* Main floating pill */}
      <motion.div
        layout
        initial={{ opacity: 0, y: -20, scale: 0.9 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -20, scale: 0.9 }}
        className="pointer-events-auto"
      >
        <button
          onClick={() => setExpanded(!expanded)}
          className={cn(
            'flex items-center gap-2.5 pl-3 pr-2 py-2 rounded-xl border backdrop-blur-xl transition-colors',
            'bg-[var(--surface-1)]/90 border-border hover:border-border shadow-lg shadow-black/30',
            activeCount > 0 && 'border-opacity-100'
          )}
          style={activeCount > 0 ? { borderColor: `${accent}40` } : undefined}
        >
          {/* Spinning/pulsing dot */}
          <div className="relative">
            {currentRunning && (
              <motion.div
                className="absolute inset-0 rounded-full"
                style={{ backgroundColor: accent }}
                animate={{ scale: [1, 1.6, 1], opacity: [0.4, 0, 0.4] }}
                transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
              />
            )}
            <div
              className="relative w-2 h-2 rounded-full"
              style={{
                backgroundColor: activeCount > 0 ? accent : '#555',
              }}
            />
          </div>

          {/* Label */}
          <div className="flex flex-col items-start min-w-0">
            <span className="text-xs font-medium text-foreground leading-tight">
              {activeCount > 0
                ? currentRunning
                  ? `${TYPE_LABEL[currentRunning.type]}: ${STATUS_LABEL[currentRunning.status]}`
                  : `${activeCount} in queue`
                : 'Queue is empty'}
            </span>
            {/* Real-time message from WanGP (e.g. "Downloading model...") */}
            {currentRunning?.message && (
              <span className="text-[10px] text-blue-400 leading-tight max-w-[180px] truncate">
                {currentRunning.message}
              </span>
            )}
            {currentRunning && currentRunning.progressMax > 0 && (
              <span className="text-[10px] text-muted-foreground font-mono leading-tight">
                {progressPercent}% · {currentRunning.progressValue}/{currentRunning.progressMax}
              </span>
            )}
          </div>

          {/* Queue count badge */}
          {activeCount > 0 && (
            <div
              className="flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-md text-[10px] font-bold text-white"
              style={{ backgroundColor: accent }}
            >
              {activeCount}
            </div>
          )}

          {/* Expand/collapse chevron (points up when collapsed — panel opens upward) */}
          <svg
            className={cn(
              'w-3.5 h-3.5 text-muted-foreground transition-transform',
              !expanded && 'rotate-180'
            )}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
      </motion.div>

      {/* Expanded panel */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ opacity: 0, y: -8, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.95 }}
            transition={{ duration: 0.15 }}
            className="pointer-events-auto w-[300px] max-h-[400px] flex flex-col rounded-xl border bg-[var(--surface-1)]/95 backdrop-blur-xl border-border shadow-xl shadow-black/40 overflow-hidden"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-3 py-2.5 border-b border-border">
              <span className="text-xs font-semibold text-foreground">
                Generation Queue
              </span>
              <div className="flex items-center gap-1">
                {items.some((it) => it.status === 'done' || it.status === 'error' || it.status === 'cancelled') && (
                  <button
                    onClick={clearFinished}
                    className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-[var(--surface-3)] transition-colors"
                    title="Clear completed"
                  >
                    <Trash2Icon className="w-3 h-3" />
                  </button>
                )}
                <button
                  onClick={() => setExpanded(false)}
                  className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-[var(--surface-3)] transition-colors"
                >
                  <XIcon className="w-3 h-3" />
                </button>
              </div>
            </div>

            {/* Item list */}
            <div className="flex-1 overflow-y-auto p-2 space-y-1">
              {[...items].reverse().map((item) => {
                const Icon = TYPE_ICON[item.type]
                const itemAccent = TYPE_ACCENT[item.type]
                const isActive =
                  item.status === 'submitting' ||
                  item.status === 'queued' ||
                  item.status === 'running'
                const itemProgress =
                  item.progressMax > 0
                    ? Math.round((item.progressValue / item.progressMax) * 100)
                    : 0

                return (
                  <motion.div
                    key={item.id}
                    layout
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -20 }}
                    className={cn(
                      'flex items-center gap-2 p-2 rounded-lg transition-colors group',
                      isActive
                        ? 'bg-[var(--surface-3)]'
                        : 'bg-[var(--surface-2)]/60'
                    )}
                  >
                    {/* Type icon */}
                    <div
                      className="w-7 h-7 rounded-md flex items-center justify-center shrink-0"
                      style={{ backgroundColor: `${itemAccent}15` }}
                    >
                      <Icon className="w-3.5 h-3.5" style={{ color: itemAccent }} />
                    </div>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <StatusIcon status={item.status} color={itemAccent} message={item.message} />
                        <span className="text-xs font-medium text-foreground truncate">
                          {item.label}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-[10px] text-muted-foreground">
                          {isDownloading(item.message) ? 'Downloading model…' : STATUS_LABEL[item.status]}
                        </span>
                        {isActive && item.progressMax > 0 && (
                          <span className="text-[10px] text-muted-foreground font-mono">
                            {itemProgress}%
                          </span>
                        )}
                      </div>
                      {/* Real-time message (e.g. "Downloading model...") */}
                      {item.message && isActive && (
                        <p className={cn("text-[10px] mt-0.5 truncate", isDownloading(item.message) ? "text-cyan-400" : "text-blue-400")}>
                          {item.message}
                        </p>
                      )}
                      {/* (fix M4) Error reason — previously panel showed
                          only "Error" without explanation. */}
                      {item.error && !isActive && (
                        <p className="text-[10px] mt-0.5 truncate text-red-400" title={item.error}>
                          {item.error}
                        </p>
                      )}
                      {/* Mini progress bar for active items */}
                      {isActive && (
                        <div className="mt-1 h-1 bg-[var(--surface-3)] rounded-full overflow-hidden">
                          {item.progressMax > 0 ? (
                            <motion.div
                              className="h-full rounded-full"
                              style={{ backgroundColor: itemAccent }}
                              initial={false}
                              animate={{ width: `${itemProgress}%` }}
                              transition={{ duration: 0.3 }}
                            />
                          ) : (
                            <motion.div
                              className="h-full rounded-full"
                              style={{ backgroundColor: itemAccent }}
                              animate={{ width: ['0%', '60%', '40%', '70%'] }}
                              transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
                            />
                          )}
                        </div>
                      )}
                    </div>

                    {/* Cancel button (for active items) */}
                    {isActive && (
                      <button
                        onClick={() => cancelQueueItem(item)}
                        className="p-1 rounded-md text-muted-foreground/50 hover:text-red-400 hover:bg-red-900/20 transition-colors opacity-0 group-hover:opacity-100"
                        title="Cancel"
                      >
                        <XCircleIcon className="w-3.5 h-3.5" />
                      </button>
                    )}

                    {/* Remove button (only for finished items) */}
                    {!isActive && (
                      <button
                        onClick={() => remove(item.id)}
                        className="p-1 rounded-md text-muted-foreground/50 hover:text-foreground hover:bg-[var(--surface-3)] transition-colors opacity-0 group-hover:opacity-100"
                      >
                        <XIcon className="w-3 h-3" />
                      </button>
                    )}
                  </motion.div>
                )
              })}
            </div>

            {/* Footer */}
            {activeCount > 0 && (
              <div className="px-3 py-2 border-t border-border">
                <p className="text-[10px] text-muted-foreground text-center">
                  {activeCount} {activeCount === 1 ? 'task' : 'tasks'} in queue
                </p>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}