'use client'

/**
 * Shared gallery loading hook — lists generated videos from ComfyUI's
 * output directory via /api/comfy/files. Used by both the Generate view
 * (results under the prompt) and the Gallery tab so they stay in sync.
 *
 * Auto-refresh: the hook subscribes to the global generation phase and, while
 * a generation is in progress, silently polls the file list and detects
 * completion via ComfyUI's status endpoint. This means the Gallery tab picks
 * up a finished video immediately — even if the Generate tab is unmounted
 * (whose own polling would have stopped).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useGenProgress } from '@/lib/gen-progress-store'
import { useGenQueue } from '@/lib/gen-queue-store'
import { useGalleryRefresh } from '@/lib/gallery-refresh-store'
import type { VideoGalleryFile } from './video-gallery-grid'

const ACTIVE_PHASES = new Set(['submitting', 'queued', 'running'])
const ACTIVE_POLL_MS = 2500

export function useVideoGallery(opts?: {
  /** Current generation phase — retriggers loads shortly after 'done'. */
  phase?: string
}) {
  const [files, setFiles] = useState<VideoGalleryFile[]>([])
  /** (fix 91) Project folders (subfolders of output; default '' is not included). */
  const [folders, setFolders] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  // Monotonic load id: only apply state from the latest request —
  // otherwise parallel load() calls (polling + manual refresh) could
  // resolve out of order and an older list would overwrite the newer one.
  const loadSeq = useRef(0)
  // (fix 309) Fast-track: "hot" files window. While Date.now() <
  // hotUntilRef, regular load() also sends include_hot=1 — otherwise
  // list without hot files (HOT_SKIP on server) would drop the newly shown video
  // from the gallery for 4 seconds (flicker).
  const hotUntilRef = useRef(0)
  // Known file keys (subfolder/filename) — fast-track looks for NEW ones.
  const knownKeysRef = useRef<Set<string>>(new Set())
  // Guard against parallel fast-track cycles + cleanup on unmount.
  const fastTrackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fastTrackGenRef = useRef(0)
  // Prefer an explicitly passed phase; otherwise read the global store so
  // GalleryView (and any consumer) auto-refreshes without wiring a prop.
  const storePhase = useGenProgress((s) => s.video.phase)
  const phase = opts?.phase ?? storePhase
  // (fix 134) External refresh signal — factory reset / content deletion.
  // On bump(), gallery immediately re-reads file list without waiting
  // for tab switch.
  const refreshVersion = useGalleryRefresh((s) => s.version)

  /**
   * Load the file list.
   * @param background When true, skip the visible "loading" state so the grid
   *   keeps showing the current files (no skeleton flicker) — used for the
   *   periodic/refresh loads, not the very first load.
   * @param hot (fix 309) Explicitly request include_hot=1 from the server. Also
   *   enabled automatically while hot window is active (hotUntilRef).
   */
  const load = useCallback(async (background = false, hot = false) => {
    const seq = ++loadSeq.current
    if (!background) setLoading(true)
    try {
      const wantHot = hot || Date.now() < hotUntilRef.current
      const res = await fetch('/api/comfy/files?type=all' + (wantHot ? '&include_hot=1' : '') + '&_t=' + Date.now(), { cache: 'no-store' })
      if (seq !== loadSeq.current) return // newer load already exists
      if (!res.ok) {
        console.warn('[Gallery] Failed to load files:', res.status)
        return
      }
      const data = await res.json()
      if (seq !== loadSeq.current) return
      setFolders(Array.isArray(data.folders) ? data.folders : [])
      // (fix 308) Intermediate extend clips (extclip_*) and refine parts
      // (refinepart_*) are not shown in gallery — only final stitched
      // video. They are temporary files, not needed after stitching.
      const videoFiles = (data.files ?? []).filter(
        (f: { type?: string; name?: string; filename?: string }) =>
          (f.type?.startsWith('video') || f.name?.match(/\.(mp4|webm|mov)$/i)) &&
          !/Minimax_Studio_extclip_/i.test(f.name || f.filename || '') &&
          !/Minimax_Studio_refinepart_/i.test(f.name || f.filename || ''),
      )
      const next: VideoGalleryFile[] = videoFiles.map(
        (f: { url: string; filename?: string; name?: string; subfolder?: string; mtime?: number; generationTime?: number | null; pipeline?: string | null }) => ({
          url: f.url,
          filename: f.filename || f.name || '',
          subfolder: f.subfolder || '',
          mtime: f.mtime,
          generationTime: typeof f.generationTime === 'number' ? f.generationTime : null,
          // (fix 310) pipeline from .meta.json — "Draft" badge.
          pipeline: f.pipeline === 'draft' || f.pipeline === 'full' ? f.pipeline : null,
        }),
      )
      // Only update state if the file list actually changed (avoids re-renders)
      setFiles((prev) => {
        if (
          prev.length === next.length &&
          prev.every((p, i) => p.filename === next[i].filename && p.subfolder === next[i].subfolder && p.mtime === next[i].mtime && p.pipeline === next[i].pipeline &&
            // (fix 348) generationTime participates in comparison: sidecar
            // is written AFTER file appearance, and without this the generation
            // time badge did not appear until list changed for another reason.
            p.generationTime === next[i].generationTime)
        ) {
          return prev
        }
        return next
      })
      // (fix 309) Update known keys on every applied list.
      knownKeysRef.current = new Set(next.map((f) => `${f.subfolder}/${f.filename}`))
    } catch (err) {
      console.error('[Gallery] Error loading files:', err)
    } finally {
      // (fix M5) loading clears on the LAST live request — regardless of
      // background. Previously background load (active generation watcher)
      // outran initial: initial was dropped by seq (didn't touch
      // loading), background was background and shouldn't → skeleton stayed
      // FOREVER ("videos not displaying" after launch with active generation).
      if (seq === loadSeq.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // (fix 309) Fast-track: after generation completes, poll list with
  // include_hot=1 every ~700ms (~15s cap). Show new file as soon as its
  // size stops changing between two polls — meaning VHS/FFmpeg finished
  // muxing and file is safe to serve to browser (URL with _t=mtime is final).
  // fast-track itself does NOT apply the list — only calls load(true) to avoid
  // bypassing loadSeq protection. Staggered timers below remain as safeguard.
  const fastTrack = useCallback(() => {
    const gen = ++fastTrackGenRef.current
    if (fastTrackTimerRef.current) clearTimeout(fastTrackTimerRef.current)
    const startedAt = Date.now()
    const pendingSizes = new Map<string, number>()
    const tick = async () => {
      if (gen !== fastTrackGenRef.current) return
      if (Date.now() - startedAt > 15000) return // hard cap
      try {
        const res = await fetch('/api/comfy/files?type=all&include_hot=1&_t=' + Date.now(), { cache: 'no-store' })
        if (!res.ok) throw new Error(String(res.status))
        const data = await res.json()
        const videoFiles = (data.files ?? []).filter(
          (f: { type?: string; name?: string; filename?: string }) =>
            (f.type?.startsWith('video') || f.name?.match(/\.(mp4|webm|mov)$/i)) &&
            !/Minimax_Studio_extclip_/i.test(f.name || f.filename || '') &&
            !/Minimax_Studio_refinepart_/i.test(f.name || f.filename || ''),
        ) as Array<{ filename?: string; name?: string; subfolder?: string; size?: number }>
        const newOnes: Array<{ key: string; size: number }> = []
        for (const f of videoFiles) {
          const key = `${f.subfolder || ''}/${f.filename || f.name || ''}`
          if (!knownKeysRef.current.has(key)) newOnes.push({ key, size: typeof f.size === 'number' ? f.size : 0 })
        }
        // No new files — file might not be created yet, keep polling.
        // All new ones already seen twice and size unchanged -> muxing complete.
        const stable = newOnes.length > 0 && newOnes.every((f) => pendingSizes.get(f.key) === f.size)
        for (const f of newOnes) pendingSizes.set(f.key, f.size)
        if (stable) {
          knownKeysRef.current = new Set([...knownKeysRef.current, ...newOnes.map((f) => f.key)])
          hotUntilRef.current = Date.now() + 8000
          void load(true)
          return
        }
      } catch { /* transient — next tick */ }
      fastTrackTimerRef.current = setTimeout(() => void tick(), 700)
    }
    fastTrackTimerRef.current = setTimeout(() => void tick(), 700)
  }, [load])

  useEffect(() => {
    return () => {
      fastTrackGenRef.current++
      if (fastTrackTimerRef.current) clearTimeout(fastTrackTimerRef.current)
    }
  }, [])

  // After a generation finishes the file may take a moment to flush/encode —
  // a few staggered silent reloads guarantee the newest video shows up.
  useEffect(() => {
    if (phase === 'done') {
      // 20s — margin for auto-concatenation (extend mode: FFmpeg xfade)
      const timers = [1000, 3000, 6000, 12000, 20000].map((delay) => setTimeout(() => load(true), delay))
      fastTrack() // (fix 309) fast display as soon as muxing finishes
      return () => timers.forEach(clearTimeout)
    }
  }, [phase, load, fastTrack])

  // (fix 134/259) External refresh signal (factory reset / content deletion /
  // job COMPLETION by any tab — generation, extend stitch, refine, upscale):
  // re-read file list in background with staggered loads — fresh file might
  // not be closed yet (VHS muxing/ffmpeg), and files route skips "hot" files
  // younger than 4 seconds.
  useEffect(() => {
    if (refreshVersion === 0) return
    const delays = [300, 1500, 4000, 8000]
    const timers = delays.map((d) => setTimeout(() => void load(true), d))
    fastTrack() // (fix 309) bump also arrives from extend stitch / refine / upscale
    return () => timers.forEach(clearTimeout)
  }, [refreshVersion, load, fastTrack])

  // While a generation is active, keep the list fresh and detect completion
  // directly from the backend so the new video appears even if the Generate
  // tab (and its polling) is unmounted. Flipping the shared phase to
  // 'done'/'error' also keeps the status card and queue indicator in sync and
  // stops this watcher (the effect re-runs and clears the interval).
  const active = ACTIVE_PHASES.has(phase)
  useEffect(() => {
    if (!active) return
    // (fix M5) Counter of consecutive 'unknown' responses: card might track
    // a task that died with ComfyUI restart (persisted 'running' remained
    // after page reload). If no active queue item remains for prompt_id —
    // queue won't pick it up, and card would spin "Generating…" forever.
    // ~8 ticks × 2.5s = 20s — honestly mark as failed.
    let unknownStreak = 0
    const tick = async () => {
      await load(true)
      const { promptId, phase: cur } = useGenProgress.getState().video
      if (!promptId || !ACTIVE_PHASES.has(cur)) return
      try {
        const res = await fetch(`/api/comfy/status?prompt_id=${encodeURIComponent(promptId)}`)
        if (!res.ok) return
        const s = await res.json()
        if (s.status === 'done') {
          useGenProgress.getState().setVideoPhase('done')
          useGenProgress.getState().setVideoProgress(100, 100)
        } else if (s.status === 'error') {
          // ComfyUI returns "error" for CANCELLED prompt: if task
          // was intentionally cancelled (button/queue) — don't show red
          // "Error", keep clean cancelled state.
          const qItem = useGenQueue.getState().items.find((i) => i.promptId === promptId)
          if (qItem?.status === 'cancelled') return
          useGenProgress.getState().setVideoPhase('error')
          if (s.detail) useGenProgress.getState().setVideoError(s.detail)
        } else if (s.status === 'unknown') {
          unknownStreak++
          if (unknownStreak >= 8) {
            const qItem = useGenQueue.getState().items.find((i) => i.promptId === promptId)
            const qActive = qItem && ['submitting', 'queued', 'running'].includes(qItem.status)
            // Queue item is active -> handled by its own poller
            // (which will report error after its 20 'unknown's). Only act
            // when card is left alone without a queue item.
            if (!qActive) {
              const isNotFound = s.detail?.includes('\u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d\u0430') || s.detail?.includes('\u043e\u0442\u043a\u043b\u043e\u043d\u0435\u043d\u0430') || s.detail?.includes('not found') || s.detail?.includes('rejected')
              useGenProgress.getState().setVideoError(isNotFound
                ? 'Task not found in ComfyUI (server was restarted) — tracking stopped'
                : 'ComfyUI not responding — tracking stopped')
              useGenProgress.getState().setVideoPhase('error')
            }
          }
        } else {
          unknownStreak = 0
        }
        // 'running'/'queued' — generation alive, just wait for next tick
      } catch {
        // transient network blip — retry on the next tick
      }
    }
    void tick()
    const id = setInterval(() => void tick(), ACTIVE_POLL_MS)
    return () => clearInterval(id)
  }, [active, phase, load])

  const deleteFile = useCallback(async (filename: string, subfolder: string) => {
    try {
      const res = await fetch('/api/comfy/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, subfolder }),
      })
      if (res.ok) {
        toast.success('Video deleted')
        // (fix 587) Disqualify loads started BEFORE deletion:
        // their response still contains deleted file, and without this
        // the "resurrected" item remained in grid until next poll tick.
        loadSeq.current += 1
        setFiles((prev) => prev.filter((f) => !(f.filename === filename && f.subfolder === subfolder)))
      } else {
        toast.error('Failed to delete file')
      }
    } catch {
      toast.error('Deletion error')
    }
  }, [])

  return { files, folders, loading, load, deleteFile }
}