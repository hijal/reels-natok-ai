'use client'

import { useCallback, useEffect, useRef } from 'react'
import { toast } from 'sonner'
import type { VideoGenerateParams } from '@/lib/comfy/video-config'
import { useGenProgress, type GenPhase } from '@/lib/gen-progress-store'
import { useGenQueue } from '@/lib/gen-queue-store'
import { acquireComfyTurn, isComfyTurnActive } from '@/lib/comfy-turn'
// (fix 259) global signal to refresh galleries after job completion
import { useGalleryRefresh } from '@/lib/gallery-refresh-store'
import { useGenDurations } from '@/lib/gen-duration-store'
import { useGenStore } from '@/lib/gen-store'
import { playNotificationSound } from '@/lib/sound'
import { computeFinalDimensions, finalDimsFromMegapixels, framesForDuration, selectResolution, flfNominalDimensions } from '@/lib/comfy/minimax-h3-template'

/** (fix 158) flf: compute nominal from preset + frame dimensions —
 *  SAME formula as on the server (body.targetDimensions in route.ts).
 *  Without this, "Repeat" (restore-from-meta) restores resolution
 *  from metadata, but the UI badge/form resolution does not match the actual
 *  generation size (meta stores final outW×outH from computeOutputDimensions).
 */
function flfFinalResolution(p: {
  mode?: 'ref' | 't2v' | 'flf' | 'extend'
  firstFrameWidth?: number
  firstFrameHeight?: number
  resolution?: string
  finalResolution?: number
  freeResolution?: boolean
}): string | undefined {
  if (p.mode !== 'flf') return undefined
  if (!p.firstFrameWidth || !p.firstFrameHeight) return undefined
  if (!p.resolution) return undefined
  const match = p.resolution.match(/(\d+)\s*x\s*(\d+)/i)
  if (!match) return undefined
  const shortSide = Math.min(parseInt(match[1], 10), parseInt(match[2], 10))
  if (!shortSide) return undefined
  const dims = flfNominalDimensions(shortSide, p.firstFrameWidth, p.firstFrameHeight)
  return `${dims.w}x${dims.h}`
}

export type { GenPhase }

const POLL_INTERVAL_MS = 1000
// (fix 263) 60 min limit removed: long generations (high
// resolution, many frames) could exceed it. Now polling continues
// until ComfyUI returns done/error — or user cancels.

/** Store of generation params for metadata (keyed by promptId). */
const genParamsMap = new Map<string, Record<string, unknown>>()

/* (fix H2) Interrupt epoch: interrupt() during 'submitting' (POST still in
 * flight) previously left an orphan task in ComfyUI — could not send cancel
 * for it (no prompt_id yet), and after POST resolved it quietly went to
 * GPU without UI tracking. Now generate() detects an epoch change after
 * POST and cancels the returned prompt_id itself. */
let interruptEpoch = 0

/* (fix 328) Cross-tab post-processing lock. Two browser tabs
 * maintain the same persisted queue (localStorage h3-gen-queue) and BOTH re-attach
 * polling to the same prompt_id → both see done and both run doSave(): duplicate
 * saveMetadata and duplicate extend-concat. Now doSave is only executed by the
 * tab that acquired the lock in localStorage (tab ID + timestamp, TTL
 * 10 min — concat for long videos can take dozens of seconds). The second tab
 * merely monitors status. We DO NOT release the lock upon completion — let it expire:
 * this prevents the other tab from triggering the done branch, and avoids the race
 * "released → other tab also sneaked in". This does not break a single tab:
 * its own lock always belongs to it. */
const TAB_ID = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
const POSTPROC_LOCK_TTL_MS = 10 * 60 * 1000

function tryAcquirePostProcLock(promptId: string): boolean {
  if (typeof window === 'undefined') return true
  try {
    const key = `h3-postproc-lock:${promptId}`
    const raw = window.localStorage.getItem(key)
    if (raw) {
      const parsed = JSON.parse(raw) as { tab?: string; ts?: number }
      if (
        parsed.tab !== TAB_ID &&
        typeof parsed.ts === 'number' &&
        Date.now() - parsed.ts < POSTPROC_LOCK_TTL_MS
      ) {
        return false // another tab is already doing post-processing
      }
    }
    window.localStorage.setItem(key, JSON.stringify({ tab: TAB_ID, ts: Date.now() }))
    // localStorage write across tabs is not atomic: if another tab
    // overwrote us at the exact same moment — lock belongs to it.
    const verify = window.localStorage.getItem(key)
    if (verify) {
      const v = JSON.parse(verify) as { tab?: string }
      return v.tab === TAB_ID
    }
    return true
  } catch {
    return true // storage unavailable — behavior as before (single tab)
  }
}

/* ── genParamsMap persistence (survives page reload) ──
 * Without this, a reload before the job finishes loses the params and the
 * finished video never gets its .meta.json sidecar. */
const GEN_PARAMS_STORAGE_KEY = 'h3_gen_params_v1'
const GEN_PARAMS_MAX_AGE_MS = 24 * 60 * 60 * 1000

function persistGenParams() {
  if (typeof window === 'undefined') return
  try {
    const now = Date.now()
    const fresh: Record<string, unknown> = {}
    for (const [pid, p] of genParamsMap) {
      if (typeof p.started_at === 'number' && now - p.started_at > GEN_PARAMS_MAX_AGE_MS) {
        genParamsMap.delete(pid)
        continue
      }
      fresh[pid] = p
    }
    window.localStorage.setItem(GEN_PARAMS_STORAGE_KEY, JSON.stringify(fresh))
  } catch { /* storage unavailable — keep in-memory only */ }
}

if (typeof window !== 'undefined') {
  try {
    const raw = window.localStorage.getItem(GEN_PARAMS_STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, Record<string, unknown>>
      const now = Date.now()
      for (const [pid, p] of Object.entries(parsed)) {
        if (p && typeof p.started_at === 'number' && now - p.started_at <= GEN_PARAMS_MAX_AGE_MS) {
          genParamsMap.set(pid, p)
        }
      }
    }
  } catch { /* corrupted storage — start fresh */ }
}

/**
 * (fix 124) Known presets → aspect ratio string.
 * Keys = EXACT nominals (final dimensions): short side = "p",
 * long side = short × (A:B), even (yuv420p). Unknown values
 * fall through to the ratio heuristic below.
 */
const RES_TO_ASPECT: Record<string, string> = {
  '854x480': '16:9 (Widescreen)',
  '480x854': '9:16 (Portrait Widescreen)',
  '480x480': '1:1 (Square)',
  '640x480': '4:3 (Standard)',
  '480x640': '3:4 (Portrait Standard)',
  '1120x480': '21:9 (Ultrawide)',
  '1280x720': '16:9 (Widescreen)',
  '720x1280': '9:16 (Portrait Widescreen)',
  '720x720': '1:1 (Square)',
  '960x720': '4:3 (Standard)',
  '720x960': '3:4 (Portrait Standard)',
  '1680x720': '21:9 (Ultrawide)',
  '1920x1080': '16:9 (Widescreen)',
  '1080x1920': '9:16 (Portrait Widescreen)',
  '1080x1080': '1:1 (Square)',
  '2520x1080': '21:9 (Ultrawide)',
}

/**
 * (fixes 121, 124) Final video dimensions in custom resolution mode
 * (MP) — SAME formula as in template (finalDimsFromMegapixels): generation
 * multiple of 32 (node binary MP), result is maximum inscribed
 * rectangle with exact aspect ratio. lowResMP no longer affects the result:
 * the upscaler works in "target dimensions" mode.
 */
export function computeOutputDimensions(aspectRatio: string, megapixels: number): { w: number; h: number } {
  const d = finalDimsFromMegapixels(aspectRatio, megapixels)
  return { w: d.outW, h: d.outH }
}

/**
 * Drives the ComfyUI video generation lifecycle for MiniMax H3.
 *
 * Flow:
 *   1. Upload ref images to ComfyUI input/
 *   2. Submit workflow via /api/comfy/generate
 *   3. Poll /api/comfy/status?prompt_id=X until done
 *   4. Save metadata on completion
 */
export function useVideoGen() {
  const progressStore = useGenProgress()
  const queue = useGenQueue()

  const timersRef = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map())
  const abortFlagsRef = useRef<Map<string, boolean>>(new Map())

  const clearTimer = useCallback((pid: string) => {
    const timer = timersRef.current.get(pid)
    if (timer) {
      clearInterval(timer)
      timersRef.current.delete(pid)
    }
    abortFlagsRef.current.delete(pid)
  }, [])

  const clearAllTimers = useCallback(() => {
    for (const pid of timersRef.current.keys()) {
      const timer = timersRef.current.get(pid)!
      clearInterval(timer)
    }
    timersRef.current.clear()
    abortFlagsRef.current.clear()
  }, [])

  useEffect(() => clearAllTimers, [clearAllTimers])

  /** Save metadata file when generation completes. */
  const saveMetadata = useCallback(async (
    promptId: string,
    outputs: Array<{ filename: string; subfolder: string }>,
    durationMs?: number | null,
  ) => {
    const params = genParamsMap.get(promptId)
    if (!params || !outputs.length) return
    try {
      // (fix 260) Sidecar on EVERY video output of the job (extend clips,
      // refine chunks, etc.), not just the first. Deduplicate by name.
      const vids = outputs.filter((o) => o.filename?.match(/\.(mp4|webm|mov)$/i))
      const list = vids.length ? vids : [outputs[0]]
      // (fix 375) Latent pipeline: path of saved AV-latent (output of
      // node '46:49') goes to sidecar as latent_file — server finalization
      // (pending-meta) writes the same field, here symmetric for client path.
      // (fix 383, updated by fix 417) Only for jobs with ONE
      // video: extend does not write latent at all (extend latent pipeline
      // rolled back), and the "one video" guard protects multi-output jobs from
      // mismatch "one latent — multiple files".
      // (fix 420) For extend there is ONLY one latent (combined, post-assembly), but
      // it corresponds to the FINAL concat result, not extclip files — does not go here;
      // client attaches it to combined meta in /api/comfy/concat call.
      const isExtendJob = params.generation_mode === 'extend'
      const latentOut = vids.length === 1 && !isExtendJob
        ? outputs.find((o) => o.filename?.match(/\.latent$/i))
        : undefined
      const latentFile = latentOut
        ? `${latentOut.subfolder ? latentOut.subfolder + '/' : ''}${latentOut.filename}`
        : null
      const seen = new Set<string>()
      let i = 0
      for (const o of list) {
        const key = `${o.subfolder || ''}/${o.filename}`
        if (seen.has(key)) continue
        seen.add(key)
        await fetch('/api/comfy/metadata', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            filename: o.filename,
            subfolder: o.subfolder || '',
            params: {
              ...params,
              // Real generation time (execution time) — the same value the
              // gallery badge shows. Only recorded when server-measured
              // (execution_ms from WS events). No fallback — better nothing
              // than a wrong number.
              ...(durationMs != null && { generation_time: Math.round(durationMs / 1000) }),
              ...(list.length > 1 && { output_index: i }),
              ...(latentFile && { latent_file: latentFile }),
              job_id: promptId,
            },
          }),
        }).catch(() => {})
        i++
      }
    } catch { /* non-critical */ }
    // Clean up
    genParamsMap.delete(promptId)
    persistGenParams()
  }, [])

  /* (fix 336) Cleanup extclip clips on error/cancel of extend task.
   * Previously Minimax_Studio_extclip_* were deleted only after SUCCESSFUL concat
   * (fix 291): on error/cancel leftover clips remained in output/ and
   * were visible in the gallery. Filter mtime ≥ started_at − 10s and by own
   * subfolder — avoid touching clips belonging to parallel extend tasks. */
  const cleanupExtendClips = useCallback(async (promptId: string) => {
    const params = genParamsMap.get(promptId)
    if (params?.generation_mode !== 'extend') return
    try {
      const filesRes = await fetch('/api/comfy/files?type=video&include_hot=1')
      if (!filesRes.ok) return
      const filesData = await filesRes.json()
      const startedAtSec = ((params.started_at as number) || Date.now()) / 1000 - 10
      const ownSub = (params.output_subfolder || '') as string
      const clips = (filesData.files ?? []).filter(
        (f: { filename?: string; subfolder?: string; mtime?: number }) =>
          /^Minimax_Studio_extclip_\d+/i.test(f.filename || '') &&
          (f.subfolder || '') === ownSub &&
          typeof f.mtime === 'number' && f.mtime >= startedAtSec,
      )
      for (const f of clips) {
        try {
          await fetch('/api/comfy/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename: f.filename, subfolder: f.subfolder || '' }),
          })
        } catch { /* file will just remain in output/ — non-critical */ }
      }
    } catch { /* non-critical */ }
  }, [])

  // (fix M4) pollUntilDone MUST be stable (stable deps): its identity
  // is in the deps of the resuscitation effect below. Previously deps contained
  // `queue` — state object from useGenQueue(), which changes on EVERY store
  // update (progress ticks every second, etc.) → pollUntilDone was recreated →
  // resuscitation effect re-ran on every tick and (fix M3) killed fresh 'submitting'
  // tasks whose POST was still in flight: "Submission aborted by page reload"
  // without any reload, video generated fine while queue showed "Error". Now all calls
  // go through useGenQueue.getState() — closure over live store, deps empty.
  const pollUntilDone = useCallback(
    (promptId: string, queueId: string, startedAt: number) => {
      if (timersRef.current.has(promptId)) return

      // When this prompt actually started EXECUTING (first 'running' poll).
      let runningSince: number | null = null
      // True once a poll saw this prompt 'queued' behind other jobs — such a
      // video counts from its actual execution start; a job that went
      // straight to execution counts from the button press (startedAt).
      let sawQueued = false
      // Counter of consecutive 'unknown' responses (ComfyUI unavailable)
      let unknownCount = 0
      // Guard against overlapping ticks: if status/progress fetch takes longer
      // than the interval, two ticks concurrently see 'done' and completion branch
      // fires twice (duplicate metadata, sound, duration record).
      let tickInFlight = false

      const timer = setInterval(async () => {
        if (tickInFlight) return
        tickInFlight = true
        try {
          await tick()
        } finally {
          tickInFlight = false
        }
      }, POLL_INTERVAL_MS)

      async function tick() {
        const aborted = abortFlagsRef.current.get(promptId)
        if (aborted) {
          clearTimer(promptId)
          return
        }

        // The queue item was cancelled (or removed) elsewhere — stop tracking.
        // Without this, a cancelled prompt keeps polling forever: ComfyUI no
        // longer knows it, so getStatus falls back to 'queued' forever.
        // (fix) Also stop if item is in terminal status (error/done):
        // rehydration effect could mark it with error, but polling remained active
        // and without this guard called setStatus('running') — resurrection error → running.
        const qItem = useGenQueue.getState().items.find((i) => i.promptId === promptId)
        if (!qItem || qItem.status === 'cancelled' || qItem.status === 'error' || qItem.status === 'done') {
          // (fix 336) Cancellation came externally (QueueIndicator): clean up extclip
          // junk of extend task as well — successful concat will not happen.
          if (qItem?.status === 'cancelled') void cleanupExtendClips(promptId)
          clearTimer(promptId)
          return
        }


        try {
          const res = await fetch(`/api/comfy/status?prompt_id=${encodeURIComponent(promptId)}`)
          if (!res.ok) {
            // (fix 491) Non-OK (502 — ComfyUI down/restarting) previously
            // just skipped the tick: unknownCount didn't increment, and with dead ComfyUI
            // the card spun indefinitely. Count as an 'unknown' tick.
            unknownCount++
            if (unknownCount >= 20) {
              clearTimer(promptId)
              const errMsg = 'ComfyUI is not responding (server is down or restarting)'
              useGenQueue.getState().setStatus(queueId, 'error', errMsg)
              useGenProgress.getState().setVideoError(errMsg)
              useGenProgress.getState().setVideoPhase('error')
            }
            return
          }
          const s = await res.json()

          // Re-check after await: user may have cancelled while request was in-flight.
          // Without this, a 'error' status from ComfyUI (which reports cancelled
          // prompts as errors) would overwrite the clean post-cancel state.
          if (abortFlagsRef.current.get(promptId)) {
            clearTimer(promptId)
            return
          }
          const qItem2 = useGenQueue.getState().items.find((i) => i.promptId === promptId)
          if (!qItem2 || qItem2.status === 'cancelled') {
            clearTimer(promptId)
            return
          }

          // ComfyUI unavailable (restart/crash): do not treat as "queued" —
          // after N consecutive missing responses fail honestly with error, otherwise
          // card would spin "In queue…" for the entire timeout.
          if (s.status === 'unknown') {
            unknownCount++
            // (fix) Threshold 20 instead of 10: during active generation
            // ComfyUI event loop is blocked by GPU operations, and individual
            // /history requests might not complete within 30s → false 'unknown'.
            // 20 × 1s = 20s of continuous unreachability — that is an actual failure.
            if (unknownCount >= 20) {
              clearTimer(promptId)
              // Honest diagnosis: 'unknown' occurs in two cases:
              //  1) ComfyUI is not responding (server is down/restarting)
              //  2) ComfyUI responds, but prompt_id is missing from history
              //     and queue — task was rejected or lost
              const isNotFound = s.detail?.includes('not found') || s.detail?.includes('rejected')
              const errMsg = isNotFound
                ? 'Task not found in ComfyUI — may have been rejected on submission or ComfyUI restarted'
                : 'ComfyUI is not responding (server is down or restarting)'
              useGenQueue.getState().setStatus(queueId, 'error', errMsg)
              useGenProgress.getState().setVideoError(errMsg)
              useGenProgress.getState().setVideoPhase('error')
              return
            }
            return
          }
          unknownCount = 0

          // ── Progress from WebSocket tracker ──
          if (s.status === 'running' || s.status === 'queued') {
            // Fetch progress percentage from WebSocket tracker
            try {
              const progRes = await fetch(`/api/comfy/progress?prompt_id=${encodeURIComponent(promptId)}`)
              if (progRes.ok) {
                const progData = await progRes.json()
                if (progData.progress) {
                  const pct = progData.progress.percent
                  useGenQueue.getState().setProgress(queueId, pct, 100)
                  // Only update shared progress store for the RUNNING prompt
                  if (s.status === 'running') {
                    useGenProgress.getState().setVideoProgress(pct, 100)
                  }
                }
              }
            } catch { /* non-critical */ }

            // Update phase and queue status
            if (s.status === 'running') {
              if (runningSince === null) runningSince = Date.now()
              // (fix) Terminal-status guard: item may have become error/done/cancelled
              // between guard at start of tick() and this call (race with rehydration).
              const guardItem = useGenQueue.getState().items.find((i) => i.id === queueId)
              if (guardItem && ['done', 'error', 'cancelled'].includes(guardItem.status)) {
                clearTimer(promptId)
                return
              }
              const cur = useGenProgress.getState().video
              if (cur.promptId !== promptId) {
                // The card must follow the job that is actually EXECUTING —
                // previews/progress are keyed to the executing prompt. Take
                // the card over (forced) from a merely-queued or dead prompt.
                const tracked = useGenQueue.getState().items.find((i) => i.promptId === cur.promptId)
                const trackedRunning = tracked
                  ? tracked.status === 'running'
                  : cur.phase === 'running'
                if (!trackedRunning) {
                  useGenProgress.getState().startVideoGen(promptId, true)
                }
              }
              if (useGenProgress.getState().video.phase !== 'running') {
                useGenProgress.getState().setVideoPhase('running')
              }
              useGenQueue.getState().setStatus(queueId, 'running')
            } else {
              // This prompt is waiting behind other jobs — its duration
              // timer must start only when its turn comes.
              sawQueued = true
              // (fix) Terminal-status guard for queued branch
              const guardItem = useGenQueue.getState().items.find((i) => i.id === queueId)
              if (guardItem && ['done', 'error', 'cancelled'].includes(guardItem.status)) {
                clearTimer(promptId)
                return
              }
              // Only set 'queued' in shared store if no other item is running
              const anyRunning = useGenQueue.getState().items.some(
                (i) => i.status === 'running' && i.id !== queueId
              )
              useGenQueue.getState().setStatus(queueId, 'queued')
              const cur = useGenProgress.getState().video
              if (!anyRunning && cur.phase !== 'running') {
                // The card might be tracking a COMPLETED/cancelled task
                // (e.g. previous generation) — transfer it to this queued one,
                // otherwise the card polls a dead prompt and oscillates
                // "Done"/"In queue".
                const tracked = cur.promptId
                  ? useGenQueue.getState().items.find((i) => i.promptId === cur.promptId)
                  : null
                const trackedActive = tracked
                  ? ['submitting', 'queued', 'running'].includes(tracked.status)
                  : false
                if (!trackedActive) {
                  useGenProgress.getState().startVideoGen(promptId, true)
                } else {
                  useGenProgress.getState().setVideoPhase('queued')
                }
              }
            }
          } else if (s.status === 'error') {
            clearTimer(promptId)
            const label = s.detail || 'Generation error'
            useGenQueue.getState().setStatus(queueId, 'error', label)
            useGenProgress.getState().setVideoError(label)
            useGenProgress.getState().setVideoPhase('error')
            void cleanupExtendClips(promptId) // (fix 336) extclip junk on error
          } else if (s.status === 'done') {
            clearTimer(promptId)
            // REAL generation time from ComfyUI WS execution events
            // (server-measured). Single source of truth for BOTH the gallery
            // Single source of truth: server-measured execution time from
            // ComfyUI WebSocket events. Poll-based estimates are unreliable
            // (startedAt = button press, not execution start) and cause the
            // gallery badge to show less time than the .meta.json sidecar.
            // If the tracker missed the events, durationMs stays null and we
            // simply don't record a duration (better nothing than wrong).
            const execMs = typeof s.execution_ms === 'number' && s.execution_ms > 0
              ? s.execution_ms
              : null
            // Fallback chain (server WS events lost):
            //  1) runningSince — moment when tick first saw 'running'
            //     (pure execution time, without queue wait);
            //  2) Date.now() - startedAt — only if task was NEVER
            //     queued behind other jobs (otherwise minutes of waiting
            //     would leak into badge — violating "better nothing than wrong").
            let durationMs: number | null = execMs
            if (durationMs === null) {
              if (runningSince !== null) durationMs = Date.now() - runningSince
              else if (!sawQueued) durationMs = Date.now() - startedAt
            }
            useGenQueue.getState().setStatus(queueId, 'done')
            useGenProgress.getState().setVideoPhase('done')
            useGenProgress.getState().setVideoProgress(100, 100)
            // (fix 259) Explicit signal to all galleries (not just phase
            // staggered-reload): guarantees repainting in ANY mounted
            // tab immediately upon job completion.
            useGalleryRefresh.getState().bump()
            // Notification sound (if enabled)
            if (typeof window !== 'undefined') {
              fetch('/api/config').then((r) => r.json()).then((d) => {
                if (d.sound_on !== false) playNotificationSound()
              }).catch(() => {})
            }
            // Save metadata with output filename
            // Fallback: if history returns no outputs, find the newest video file from the output dir
            const doSave = async () => {
              let outputs = s.outputs
              const _genParamsEarly = genParamsMap.get(promptId)
              const _isExtend = (_genParamsEarly?.generation_mode === 'extend')
              // (fix 194) extend: each clip is written by ITS OWN VHS_VideoCombine
              // (after pass 2) — files Minimax_Studio_extclip_<i>_*; sort
              // by clip index. include_hot=1: task is already done — files are
              // final, whereas the 4-second HOT_SKIP could otherwise hide fresh files.
              if (_isExtend) {
                outputs = []
                try {
                  const filesRes = await fetch('/api/comfy/files?type=video&include_hot=1')
                  if (filesRes.ok) {
                    const filesData = await filesRes.json()
                    const startedAtSec = startedAt / 1000 - 10 // mtime skew allowance
                    const ownSub = (_genParamsEarly?.output_subfolder || '') as string
                    const clipFiles = (filesData.files ?? [])
                      .map((f: { filename?: string; subfolder?: string; mtime?: number }) => {
                        const m = /^Minimax_Studio_extclip_(\d+)/.exec(f.filename || '')
                        return { index: m ? parseInt(m[1], 10) : -1, f }
                      })
                      .filter((x: { index: number; f: { subfolder?: string; mtime?: number } }) =>
                        x.index >= 0 &&
                        (x.f.subfolder || '') === ownSub &&
                        typeof x.f.mtime === 'number' && x.f.mtime >= startedAtSec)
                      .sort((a: { index: number }, b: { index: number }) => a.index - b.index)
                    if (clipFiles.length > 0) {
                      outputs = clipFiles.map((x: { f: { filename: string; subfolder?: string } }) => ({
                        filename: x.f.filename,
                        subfolder: x.f.subfolder || '',
                        type: 'output',
                      }))
                    }
                  }
                } catch { /* ignore */ }
                if (outputs.length === 0) {
                  console.warn('[concat] extend: clip files Minimax_Studio_extclip_<i> not found in output/')
                }
              } else if (!outputs || outputs.length === 0) {
                try {
                  const filesRes = await fetch('/api/comfy/files?type=video')
                  if (filesRes.ok) {
                    const filesData = await filesRes.json()
                    const startedAtSec = startedAt / 1000 - 10 // mtime skew allowance
                    const ownSub = (_genParamsEarly?.output_subfolder || '') as string
                    const fresh = (filesData.files ?? []).filter(
                      (f: { hasMeta?: boolean; mtime?: number; subfolder?: string; filename?: string }) =>
                        (f.subfolder || '') === ownSub &&
                        typeof f.mtime === 'number' && f.mtime >= startedAtSec,
                    )
                    if (fresh.length > 0) {
                      outputs = fresh.map((f: { filename: string; subfolder?: string }) => ({
                        filename: f.filename,
                        subfolder: f.subfolder || '',
                        type: 'output',
                      }))
                    }
                  }
                } catch { /* ignore */ }
              }
              // Record the duration against the actual VIDEO output — using
              // the same fallback filename the metadata save uses, so the
              // gallery badge appears even when history returned no outputs.
              const badgeFilename =
                outputs?.find((o) => o.filename?.match(/\.(mp4|webm|mov|m4v)$/i))?.filename ||
                outputs?.[0]?.filename ||
                undefined
              if (durationMs !== null) {
                useGenDurations.getState().record(durationMs, 'video', badgeFilename)
              }
              if (outputs?.length) {
                // (fix 180) CRITICAL: saveMetadata deletes params from genParamsMap.
                // Must preserve params BEFORE call, otherwise concat won't see
                // extend_source_video and will skip splicing.
                const storedParams = genParamsMap.get(promptId)
                const srcVideo = storedParams?.extend_source_video as string | null | undefined
                await saveMetadata(promptId, outputs, durationMs)
                // (fix 194) extend: N-way splice — source video + all
                // clips (clips are already sorted by index; mutually generated
                // by motion-context chain, seams are seamless).
                if (srcVideo && _isExtend) {
                  // (fix 384, ROLLED BACK by fix 417) The metaOnly branch for
                  // assembled workflow combined file was removed along with
                  // extend latent combine. Splicing is again ALWAYS ffmpeg:
                  // source + extclip_<i> → /api/comfy/concat.
                  const inputs = [
                    { name: srcVideo, kind: 'source' as const, subfolder: '' },
                    // (fix 420) .latent (combined, post-assembly) does not go
                    // into splicing — only video files of clips.
                    ...outputs
                      .filter((o: { filename?: string }) => !o.filename?.match(/\.latent$/i))
                      .map((o: { filename: string; subfolder?: string }) => ({
                        name: o.filename,
                        kind: 'output' as const,
                        subfolder: o.subfolder || '',
                      })),
                  ]
                  try {
                    const concatRes = await fetch('/api/comfy/concat', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      // (fix 193) 0.5-second crossfade at "source → first clip"
                      // seam was noticeable as a "fade"; 3 frames (0.125s)
                      // smooth the jump between footage and render without reading
                      // as a dissolve. Between clips transitions are unnecessary —
                      // there is a single generation chain (xfade with small fade only at
                      // source|clip0 seam, further running formula reduces
                      // overlap of each subsequent seam to the same 3 frames).
                      // (fixes 210/213) Clip 0 begins with 17-frame overlap
                      // of source tail (node preserves them when trimming
                      // seed-prefix) — trim same 0.708s from END of source
                      // so the seam falls on the overlap, not boundary of two decodes.
                      // (fix 229) "Source → clip 0" seam: 16 frames of
                      // re-decoded tail of source, crossfade of
                      // 8 frames (0.33s, "longer" by request) blends
                      // IDENTICAL moments — without ghosting.
                      // (fixes 210/213) Clip 0 begins with 17-frame overlap
                      // of source tail (node preserves them when trimming
                      // seed-prefix) — trim same 0.708s from END of source
                      // so the seam falls on the overlap, not boundary of two decodes.
                      // (fix 249) fade = 3/24s (3 frames) — brief smoothing of
                      // the jump (VAE-roundtrip, microcontrast) at seam of two
                      // independent decodes. Do NOT blend 22 warmup frames of clip i>0
                      // with tail of clip i-1: warmup is regeneration under conditioning,
                      // not a copy, and 22-frame xfade blends similar but non-identical
                      // frames → ghosting/double image (fix 244 did exactly that).
                      // 3 frames is enough to smooth the jump without reading as dissolve or ghosting.
                      // (fixes 210/213, 229) "Source → clip 0" seam: seed-latent
                      // (perfect copy of tail), 17-frame overlap, 8-frame xfade
                      // blends copy with original — no ghosting, keep as is.
                      // (fix 250) Harmonizing 248+249: context_length = 22
                      // (template) provides warmup prefix of 22 DUPLICATED moments of
                      // tail of clip i-1 (measured SSIM: 0.93+ in anchor zone, 0.58-0.72
                      // beyond). 3-frame fade blends only nearest frames;
                      // REMAINING 19 warmup frames are trimmed by head cut —
                      // otherwise timeline would replay ~0.8s repeat at each seam.
                      // [source, clip0 (no head trim), clip1..N (19/24 from head)]
                      // (fix 251) Aligning "source → clip 0" seam:
                      // clip contains exactly seamOverlapFrames=17 duplicated
                      // tail frames. Seamless xfade requires Trim+Fade ≤ 17
                      // (moment pairs match). Previously 16+8=24 — 7 frames of fade
                      // extended beyond duplication: source and clip showed
                      // DIFFERENT moments → ghosting on motion (visible at
                      // native resolution of single-pass pipeline). 9+8=17 — fade
                      // blends pairwise matching frames.
                      // (fix 252) Latent-masking chain: clip files are already
                      // free of duplicate heads (preserved-head cut in workflow) —
                      // inter-clip seams are hard cuts (fade 1 frame =
                      // technical xfade, no duplicate content). "Source → clip 0" seam
                      // as before: 17 duplicate frames, Trim 9 + Fade 8 = 17 (fix 251).
                      body: JSON.stringify({
                        inputs,
                        // (fix 292) fade=0: between clips i>0 — HARD CUT (no xfade).
                        // 1-frame xfade created "slowdown/ghosting" at seams
                        // (first frame of clip i after cutting 22 frames visually close
                        // to last frame of clip i-1 → blending = double frame).
                        // Seam fade at "source → clip 0" boundary remains (8/24 s).
                        fade: 0,
                        seamFadeSeconds: 8 / 24,
                        outName: 'Minimax_Studio_combined',
                        // (fix 364) Final spliced file goes to the same
                        // output subfolder where task clips were written (original
                        // folder for gallery source, fix 363).
                        outSubfolder: (_genParamsEarly?.output_subfolder || '') as string,
                        sourceTrimSeconds: 9 / 24,
                        // (fix 260) Metadata of the FINAL extension file:
                        // job parameters + source from which extension was made.
                        // Clip list will be added by concat route.
                        meta: {
                          ..._genParamsEarly,
                          generation_mode: 'extend',
                          workflow: 'extend-latent-chain-combined',
                          source_video: _genParamsEarly.extend_source_video
                            ? { name: _genParamsEarly.extend_source_video }
                            : null,
                          // (fix 420) latent_file for extend combined meta —
                          // RETURNED in a new role: workflow post-assembly
                          // (after samplers, model is not involved) saves
                          // combined latent with the same timeline as ffmpeg splice
                          // (17-frame seam overlap consumed by Trim 9 + xfade 8).
                          // Refine/tile upscale of result starts lossless.
                          ...(() => {
                            // (fix 553) Look in s.outputs — ComfyUI's ORIGINAL response.
                            // For extend, outputs variable above was completely overwritten
                            // by list of video clips (extclip_*.mp4 from /api/comfy/files?type=video),
                            // which doesn't include the combined .latent file — find
                            // always returned undefined, latent_file was never written
                            // to result meta, and lossless refine of extended video
                            // went through mp4 path with repeated VAEEncode — exactly
                            // what fix 420 was designed to avoid.
                            const lo = (s.outputs ?? []).find((o: { filename?: string }) => o.filename?.match(/\.latent$/i))
                            return lo
                              ? {
                                latent_file: `${lo.subfolder ? lo.subfolder + '/' : ''}${lo.filename}`,
                                // frames/resolution for resolver — actual final dimensions:
                                // probe fields are appended by concat route (ffprobe combined).
                              }
                              : {}
                          })(),
                          // (fix 264) Generation time of the FINAL extension file:
                          // server-side execution_ms from ComfyUI (same value that
                          // goes to .meta.json of individual clips) — preview badge
                          // and "Generation time" in MetaDialog use generation_time.
                          ...(durationMs !== null
                            ? { generation_time: Math.round(durationMs / 1000) }
                            : {}),
                        },
                      }),
                    })
                    if (concatRes.ok) {
                      const concatData = await concatRes.json()
                      toast.success(`Spliced: ${concatData.filename}`, { duration: 5000 })
                      // (fix 259) Concat finishes AFTER 'done' phase —
                      // its phase reloads had already run by then,
                      // and the resulting video wouldn't show in galleries until manual
                      // refresh. Signal explicitly.
                      useGalleryRefresh.getState().bump()
                      // (fix 291) Remove intermediate Minimax_Studio_extclip_<i> clips
                      // from output/ — user sees only the FINAL spliced
                      // file. If user wants to re-generate, they can restart —
                      // clips will be re-created. Delete quietly in the background
                      // (deletion failure is non-critical: file simply remains in output/
                      // and will be visible in gallery).
                      for (const o of outputs) {
                        if (!o.filename?.match(/^Minimax_Studio_extclip_\d+/i)) continue
                        try {
                          await fetch('/api/comfy/delete', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                              filename: o.filename,
                              subfolder: o.subfolder || '',
                            }),
                          })
                        } catch (delErr) {
                          console.warn('[extend] clip cleanup failed:', o.filename, delErr)
                        }
                      }
                    } else {
                      const errData = await concatRes.json().catch(() => ({}))
                      console.warn(`[concat] FAILED:`, errData.error || concatRes.status)
                      toast.error('Auto-splice failed', { description: errData.error, duration: 6000 })
                    }
                  } catch (ce) {
                    console.warn('[concat] request error:', ce)
                    toast.error('Auto-splice: network error', { duration: 5000 })
                  }
                }
              } else {
                genParamsMap.delete(promptId)
                persistGenParams()
              }
            }
            // (fix 328) Post-processing (saveMetadata + extend-concat +
            // clip deletion) is executed by ONLY ONE tab — the lock
            // holder. Other tabs merely observe statuses.
            if (tryAcquirePostProcLock(promptId)) {
              void doSave()
            }
          }
        } catch {
          /* transient network blip — keep polling */
        }
      }

      timersRef.current.set(promptId, timer)
    },
    [clearTimer, saveMetadata, cleanupExtendClips]
  )

  // Re-hydrate on mount: re-attach polling for every ACTIVE queue item that
  // survived a page reload (the queue store is persisted). Also point the
  // shared progress card at an active item when it came back idle.
  // (fix M4) Effect runs ONLY on mount: pollUntilDone is now
  // stable (see comment above). Previously due to unstable pollUntilDone
  // the effect re-ran on every store update.
  // (fix M3, M4) 'submitting' without prompt_id ≠ instant "error": POST /generate
  // takes up to 120s (AbortSignal.timeout(120_000)). Instant error marking
  // killed fresh tasks (POST succeeded, video generated, while queue
  // showed "Error" and stopped tracking). We grant the full POST timeout
  // + grace margin; only if prompt_id never arrives is it marked as error.
  useEffect(() => {
    const items = useGenQueue.getState().items
    const SUBMIT_GRACE_MS = 150_000 // POST timeout (120s) + grace margin
    const graceTimers: ReturnType<typeof setTimeout>[] = []
    for (const it of items) {
      if (it.status !== 'submitting' || it.promptId) continue
      const giveUp = () => {
        const cur = useGenQueue.getState().items.find((x) => x.id === it.id)
        if (cur && cur.status === 'submitting' && !cur.promptId) {
          useGenQueue.getState().setStatus(it.id, 'error', 'Submission interrupted by page reload')
        }
      }
      // (fix 331) First try to recover prompt_id by clientToken:
      // the server might have already queued the task in ComfyUI while page
      // was reloading. Retries continue until grace window expires (server POST
      // might still be running — journal entry appears only after submission).
      if (it.clientToken) {
        const token = it.clientToken
        const tryRecover = async (): Promise<boolean> => {
          try {
            const r = await fetch(`/api/comfy/inflight?token=${encodeURIComponent(token)}`)
            if (!r.ok) return false
            const d = (await r.json()) as { prompt_id?: string }
            if (!d.prompt_id) return false
            const cur = useGenQueue.getState().items.find((x) => x.id === it.id)
            if (cur && cur.status === 'submitting' && !cur.promptId) {
              useGenQueue.getState().setPromptId(it.id, d.prompt_id)
              abortFlagsRef.current.set(d.prompt_id, false)
              pollUntilDone(d.prompt_id, it.id, it.createdAt)
            }
            return true
          } catch {
            return false
          }
        }
        void tryRecover()
        const retry = setInterval(() => {
          const cur = useGenQueue.getState().items.find((x) => x.id === it.id)
          if (!cur || cur.status !== 'submitting' || cur.promptId) {
            clearInterval(retry)
            return
          }
          void tryRecover().then((ok) => {
            if (ok) clearInterval(retry)
          })
        }, 5000)
        graceTimers.push(retry)
      }
      const left = SUBMIT_GRACE_MS - (Date.now() - it.createdAt)
      if (left <= 0) {
        giveUp()
      } else {
        graceTimers.push(setTimeout(giveUp, left))
      }
    }
    for (const it of items) {
      if (!it.promptId) continue
      // (fix 716) ONLY VIDEO tasks. Previously there was no type filter, and
      // the video poller attached to refine items (which also have a promptId):
      // on 'done' it set them to 'done' BEFORE the refine queue's own finalization
      // and recorded a bogus video duration. The global poller in
      // queue-indicator.tsx excludes this case — exclude it here as well.
      if (it.type !== 'video') continue
      if (!['submitting', 'queued', 'running'].includes(it.status)) continue
      if (timersRef.current.has(it.promptId)) continue
      abortFlagsRef.current.set(it.promptId, false)
      pollUntilDone(it.promptId, it.id, it.createdAt)
    }
    const cur = useGenProgress.getState().video
    if (cur.phase === 'idle' || !cur.promptId) {
      const next =
        items.find((i) => i.status === 'running' && i.promptId) ??
        items.find((i) => ['submitting', 'queued'].includes(i.status) && i.promptId)
      if (next?.promptId) {
        useGenProgress.getState().startVideoGen(next.promptId)
      }
    }
    return () => {
      for (const t of graceTimers) clearTimeout(t)
    }
  }, [pollUntilDone])

  /**
   * Submit a video generation job via ComfyUI.
   * Reference images must already be uploaded to ComfyUI input/
   * (their filenames are in params.references[].path).
   */
  const generate = useCallback(
    async (params: VideoGenerateParams) => {
      const queueId = queue.enqueue('video', params.prompt?.slice(0, 50) || 'Video')

      // (fix 331) clientToken for inflight recovery: if page is
      // reloaded while POST /generate is in flight, the server still submits
      // the task and journals token → prompt_id; rehydrate effect will find it
      // via GET /api/comfy/inflight instead of "Submission interrupted".
      const clientToken =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`
      queue.setClientToken(queueId, clientToken)

      // (unified queue) Wait for our turn BEFORE submitting to ComfyUI. While waiting,
      // the item stays "Queued"; after grant the gateway itself sets 'submitting'.
      // If the item was cancelled/removed while waiting — simply return.
      const granted = await acquireComfyTurn(queueId)
      if (!granted || !isComfyTurnActive(queueId)) return

      // Immediately show "Submitting..." on a clean card — WITHOUT data from
      // previous task. The gateway already guarantees no other video generation
      // is currently executing; later videos in 'queued' status must not
      // block card reset for the task that just got its turn.
      const hasActiveInQueue = useGenQueue.getState().items.some(
        (i) => i.type === 'video' && i.status === 'running' && i.id !== queueId
      )
      if (!hasActiveInQueue) {
        useGenProgress.getState().beginVideoSubmit()
      }

      try {
        // Build MiniMaxH3Params from VideoGenerateParams
        // Extract ref image filenames (ComfyUI input/ filenames)
        // (fix 146) generation mode: in t2v/flf image/video refs are not passed
        // (frames are separate fields firstFrame/lastFrame)
        const genMode = params.mode ?? 'ref'
        const refImages: string[] = []
        const refVideos: Array<{ path: string; includeAudio: boolean; compress?: boolean }> = []
        const refAudios: string[] = []
        // (fix 304) Parallel array of audio ref trims (AudioTrim).
        const refAudioTrims: Array<{ start: number; end: number | null } | undefined> = []
        // (fix 694) Parallel array of audio ref gains (AudioGain).
        const refAudioVolumes: Array<number | undefined> = []
        // (fix 161) extend: image refs go via extendRefs, not refImages
        if (genMode === 'extend') {
          // extend mode: refs from params.extendRefs or from references
          if (params.extendRefs?.length) {
            for (const path of params.extendRefs) {
              if (path && !/^[A-Za-z]:[\\/]/.test(path) && !path.startsWith('/')) {
                refImages.push(path)
              }
            }
          } else if (params.references?.length) {
            for (const ref of params.references) {
              if (ref.kind === 'image' && ref.path) {
                if (!/^[A-Za-z]:[\\/]/.test(ref.path) && !ref.path.startsWith('/')) {
                  refImages.push(ref.path)
                }
              }
            }
          }
        } else if (params.references?.length) {
          for (const ref of params.references) {
            if (!ref.path) continue
            if (/^[A-Za-z]:[\\/]/.test(ref.path) || ref.path.startsWith('/')) {
              throw new Error(
                `File "${ref.path}" was uploaded to the old system. Please remove and re-upload it.`,
              )
            }
            if (ref.kind === 'image') {
              if (genMode === 'ref') refImages.push(ref.path)
            } else if (ref.kind === 'video') {
              if (genMode === 'ref') refVideos.push({ path: ref.path, includeAudio: ref.includeAudio !== false, compress: ref.compress === true })
            } else if (ref.kind === 'audio') {
              refAudios.push(ref.path)
              // (fix 304) Trim: add only if actually configured —
              // otherwise undefined (AudioTrim node not inserted).
              const s = ref.trimStart ?? 0
              const e = ref.trimEnd ?? null
              refAudioTrims.push(s > 0 || (e != null && e > 0) ? { start: s, end: e } : undefined)
              // (fix 694) Volume: configured and ≠ 1.0 → AudioGain node; otherwise
              // undefined (node not inserted). Default in UI = 0.5.
              const v = ref.audioVolume
              refAudioVolumes.push(v != null && Math.abs(v - 1.0) > 1e-6 ? v : undefined)
            }
          }
        }
        // No references required — the hybrid model supports prompt-only generation

        // (fix 124) Two modes:
        //  • preset (known WxH) — EXACT nominal: server does
        //    gen = ceil32(nominal), upscaler "target dimensions", crop →
        //    exactly nominal (16:9 1080p: 1920×1088 → 1920×1080);
        //  • custom resolution (finalResolution > 0) / unknown WxH —
        //    MP path (finalDimsFromMegapixels: node binary MP + inscribed crop).
        let aspectRatio = '16:9 (Widescreen)'
        let qualityFinalRes: number | null = null
        let presetDims: { w: number; h: number } | null = null

        // (fix 152) In flf mode aspect ratio is taken from first frame
        if (genMode === 'flf' && params.firstFrameWidth && params.firstFrameHeight) {
          const ratio = params.firstFrameWidth / params.firstFrameHeight
          if (Math.abs(ratio - 21/9) < 0.2) aspectRatio = '21:9 (Ultrawide)'
          else if (Math.abs(ratio - 16/9) < 0.15) aspectRatio = '16:9 (Widescreen)'
          else if (Math.abs(ratio - 9/16) < 0.15) aspectRatio = '9:16 (Portrait Widescreen)'
          else if (Math.abs(ratio - 1) < 0.1) aspectRatio = '1:1 (Square)'
          else if (Math.abs(ratio - 4/3) < 0.15) aspectRatio = '4:3 (Standard)'
          else if (Math.abs(ratio - 3/4) < 0.15) aspectRatio = '3:4 (Portrait Standard)'
          else if (Math.abs(ratio - 3/2) < 0.15) aspectRatio = '3:2 (Photo)'
          else if (Math.abs(ratio - 2/3) < 0.15) aspectRatio = '2:3 (Portrait Photo)'
          else aspectRatio = '16:9 (Widescreen)'
          // (fix 155) In flf use nominal dimensions from preset (480p/720p/1080p),
          // rather than fixed 0.7 MP. This allows choosing 480p or 720p and getting
          // the matching resolution (480×854 vs 720×1280 for 9:16), instead of identical.
          // (fix 157) Orientation is taken from FRAME, not from UI preset: short
          // side = target quality (min(w,h)), long = short × (fw/fh) —
          // exact proportion of the first frame. Horizontal frame + any preset
          // (480p/720p/1080p) → always horizontal video.
          if (params.resolution) {
            const match = params.resolution.match(/(\d+)\s*x\s*(\d+)/i)
            if (match) {
              const pw = parseInt(match[1], 10)
              const ph = parseInt(match[2], 10)
              const shortSide = Math.min(pw, ph)
              const dims = flfNominalDimensions(shortSide, params.firstFrameWidth, params.firstFrameHeight)
              presetDims = { w: dims.w, h: dims.h }
              // MP for metadata (not used in calculation, informational only)
              qualityFinalRes = Math.round((dims.w * dims.h / 1_000_000) * 100) / 100
            } else {
              qualityFinalRes = 0.7
            }
          } else {
            qualityFinalRes = 0.7
          }
        } else if (params.resolution) {
          // Exact preset match first; unknown resolutions use ratio heuristic.
          aspectRatio = RES_TO_ASPECT[params.resolution] ?? aspectRatio
          const match = params.resolution.match(/(\d+)\s*x\s*(\d+)/i)
          if (match) {
            const w = parseInt(match[1], 10)
            const h = parseInt(match[2], 10)
            if (RES_TO_ASPECT[params.resolution]) {
              // (fix 124) Known preset: WxH is the exact nominal
              presetDims = { w, h }
            } else {
              const ratio = w / h
              if (Math.abs(ratio - 21/9) < 0.2) aspectRatio = '21:9 (Ultrawide)'
              else if (Math.abs(ratio - 16/9) < 0.15) aspectRatio = '16:9 (Widescreen)'
              else if (Math.abs(ratio - 9/16) < 0.15) aspectRatio = '9:16 (Portrait Widescreen)'
              else if (Math.abs(ratio - 1) < 0.1) aspectRatio = '1:1 (Square)'
              else if (Math.abs(ratio - 4/3) < 0.15) aspectRatio = '4:3 (Standard)'
              else if (Math.abs(ratio - 3/4) < 0.15) aspectRatio = '3:4 (Portrait Standard)'
              else if (Math.abs(ratio - 3/2) < 0.15) aspectRatio = '3:2 (Photo)'
              else if (Math.abs(ratio - 2/3) < 0.15) aspectRatio = '2:3 (Portrait Photo)'
              else aspectRatio = '16:9 (Widescreen)'
            }
            // Derive final resolution (MP) directly from pixel count
            // (metadata + MP path for unknown WxH)
            const totalPx = w * h
            qualityFinalRes = Math.round((totalPx / 1_000_000) * 100) / 100
          }
        }

        // Duration: videoLength is frame count, convert to seconds at 24fps.
        // Keep duration as an exact float (NO integer rounding) so the server's
        // frames formula round-trips on the 17n+5 grid (fix 55).
        const fps = 24
        // (fix 138) default 48 → 60: minimum 2.5s (60 frames at 24 fps)
        const duration = Math.max(2.5, (params.videoLength ?? 60) / fps)
        // Actual frame count the server will produce (node 46:19) — for metadata.
        const videoLengthFrames = framesForDuration(duration, fps)

        // Final resolution: explicit override (>0) > quality-derived > default
        const finalResolution = (params.finalResolution && params.finalResolution > 0)
          ? params.finalResolution
          : qualityFinalRes ?? 0.7
        // (fix 124) Exact dimensions — only for known preset and not in
        // custom mode. Template (server) uses them for gen = ceil32 and
        // final crop; metadata uses the same calculation below.
        // (fix 153) In flf single-pass mode: if presetDims exists — use them,
        // otherwise template computes from lowRes (finalRes MP).
        // (fix 155) In flf with preset (480p/720p/1080p) targetDimensions = nominal,
        // so 480p and 720p produce different resolutions (480×854 vs 720×1280 for 9:16).
        const freeMode = (params.finalResolution ?? 0) > 0
        const targetDimensions = presetDims && !freeMode
          ? { width: presetDims.w, height: presetDims.h }
          : undefined

        // Actual seed: resolve random (-1) to a concrete value so metadata stores it
        const actualSeed = (params.seed ?? -1) < 0 ? Math.floor(Math.random() * 2 ** 31) : (params.seed ?? -1)

        const body = {
          prompt: params.prompt,
          clientToken, // (fix 331) inflight recovery of prompt_id
          mode: genMode, // (fix 146) ref | t2v | flf | extend
          pipeline: genMode === 'extend' ? 'full' : (params.pipeline || 'full'), // draft | full
          draftSteps: genMode === 'extend' ? undefined : params.draftSteps,
          firstFrame: genMode === 'flf' ? params.firstFrame : undefined,
          lastFrame: genMode === 'flf' ? params.lastFrame : undefined,
          firstFrameWidth: genMode === 'flf' ? params.firstFrameWidth : undefined,
          firstFrameHeight: genMode === 'flf' ? params.firstFrameHeight : undefined,
          refImages,
          refVideos: refVideos.length > 0 ? refVideos : undefined,
          refAudios: refAudios.length > 0 ? refAudios : undefined,
          refAudioTrims: refAudioTrims.some(Boolean) ? refAudioTrims : undefined, // (fix 304)
          refAudioVolumes: refAudioVolumes.some((v) => v != null) ? refAudioVolumes : undefined, // (fix 694)
          // ref + audio ref: Audio Guide instead of ref_audio + preserving
          // original track. In t2v/flf unnecessary: guide is standard there.
          audioGuide: genMode === 'ref' && params.audioGuide === true && refAudios.length > 0
            ? true
            : undefined,
          keepOriginalAudio: genMode === 'ref' && params.audioGuide === true && refAudios.length > 0
            ? true
            : undefined,
          aspectRatio,
          duration,
          seed: actualSeed,
          targetDimensions, // (fix 124) exact nominal — priority over MP
          finalResolution,
          lowResMP: params.lowResMP ?? 0.2,
          firstSamplerSteps: params.firstSamplerSteps ?? 6,
          // Total schedule steps for pass 1. Previously field did not reach
          // server — template always took 2× split ("6 of 12"), and the
          // "Total Steps" slider in UI had no effect. Default is 6/6.
          firstSamplerTotalSteps: params.firstSamplerTotalSteps ?? params.firstSamplerSteps ?? 6,
          sigmaVariant: params.sigmaVariant || '3step',
          pass2Sampler: params.pass2Sampler || 'euler', // (fix 69)
          pass1Sampler: params.pass1Sampler || 'euler', // (fix 70)
          pass1Scheduler: params.pass1Scheduler || 'simple', // (fix 70)
          refImageSize: params.referenceDetail || 'match', // (fix 58)
          sparseAttention: params.sparseAttention === true, // (fix 387) Sol-Attn default OFF
          sparseTau: params.sparseTau, // (fix 466)
          sparseStartPercent: params.sparseStartPercent, // (fix 466)
          sparseEndPercent: params.sparseEndPercent, // (fix 466)
          sparseMinTokens: params.sparseMinTokens, // (fix 466)
          sparseExtraTokens: params.sparseExtraTokens, // (fix 466)
          vedaAttention: params.vedaAttention === true, // (fix 301)
          vedaGeneratedSparsity: params.vedaGeneratedSparsity, // (fix 403)
          vedaReferenceSparsity: params.vedaReferenceSparsity, // (fix 403)
          vedaFullAttentionLayers: params.vedaFullAttentionLayers, // (fix 403)
          vedaFullAttentionSteps: params.vedaFullAttentionSteps, // (fix 403)
          vedaVerbose: params.vedaVerbose === true, // (fix 403)
          lowVramAttention: params.lowVramAttention !== false,
          chunkFeedForward: params.chunkFeedForward !== false,
          chunkFFChunks: params.chunkFFChunks ?? 2,
          chunkFFThreshold: params.chunkFFThreshold ?? 4096,
          outputSubfolder: params.outputSubfolder || '', // (fix 91)
          // (fix 161) extend mode: clips + refs (refImages → extendRefs)
          extendClips: genMode === 'extend' ? (params.extendClips || []) : undefined,
          extendRefs: genMode === 'extend' ? refImages : undefined,
          // (fix 164) extend: source video for extension
          extendSourceVideo: genMode === 'extend' ? params.extendSourceVideo : undefined,
          extendSourceName: genMode === 'extend' ? params.extendSourceName : undefined, // (fix 385)
          extendSourceSubfolder: genMode === 'extend' ? params.extendSourceSubfolder : undefined, // (fix 385)
          // (fix 423) extend: two-pass mode (low-res → upscale → refine)
          extendTwoPass: genMode === 'extend' ? params.extendTwoPass === true : undefined,
          // Extension clip steps: undefined = "auto" (template fallback —
          // firstSamplerSteps, while client substitutes source's pass1_steps
          // when metadata is present). Previously field was lost here — UI value
          // was silently ignored and clips always ran with firstSamplerSteps.
          extendClipSteps: genMode === 'extend' ? params.extendClipSteps : undefined,
        }

        const myEpoch = interruptEpoch
        // (fix 141, Phase 4 fix) 120s timeout: server may be waiting
        // for mutex release (background unload, LLM unload) + upload
        // of references + submit. 60s was too short: AbortSignal killed the request,
        // while server kept working → duplicate task in ComfyUI.
        // 120s is sufficient for all normal scenarios.
        const res = await fetch('/api/comfy/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(120_000),
        })

        const data = await res.json()
        if (!res.ok || !data.prompt_id) {
          // (fix 141) Log status and response body — for diagnosing
          // "third video cannot be added".
          console.error(`[gen] generate() failed: HTTP ${res.status}`, data)
          throw new Error(data.error || `Failed to submit task to ComfyUI (HTTP ${res.status}).`)
        }

        const promptId = data.prompt_id as string

        // (fix H2) User pressed "Cancel" while POST was in flight:
        // task is already in ComfyUI, but UI is not tracking it. Cancel it
        // on server immediately and DO NOT launch polling/card.
        if (interruptEpoch !== myEpoch || !isComfyTurnActive(queueId)) {
          // Stop already accepted ComfyUI task. Do not leave it
          // as an orphan if queue was cancelled while POST was in flight.
          await fetch('/api/comfy/cancel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt_id: promptId }),
          }).catch(() => {})
          genParamsMap.delete(promptId)
          persistGenParams()
          queue.remove(queueId)
          return
        }

        queue.setPromptId(queueId, promptId)
        abortFlagsRef.current.set(promptId, false)

        // Staged references (uploaded while ComfyUI was down) have been
        // transferred server-side — update the stored paths so previews
        // and future generations use the real ComfyUI input/ names.
        const transfers = (data.staged_transfers ?? {}) as Record<string, string>
        if (Object.keys(transfers).length > 0) {
          const store = useGenStore.getState()
          for (const ref of store.video.refs) {
            const mapped = transfers[ref.path]
            if (mapped && mapped !== ref.path) {
              store.updateVideoRef(ref.id, { path: mapped })
            }
          }
        }

        // (fixes 121, 124) ACTUAL final dimensions — SAME as template:
        // preset → nominal (computeFinalDimensions), custom → finalDimsFromMegapixels
        // (fix 153) In flf mode — single-pass: lowRes = targetDimensions (ceil32)
        // or selectResolution(aspect, finalRes).
        // (fix 155) In flf with preset targetDimensions = nominal (480p/720p/1080p).
        // (fix 156) In flf final = lowRes (ceil32) — upscaler early-return.
        const finalDims = genMode === 'flf'
          ? (() => {
              const lowRes = targetDimensions
                ? {
                    w: Math.max(32, Math.ceil(targetDimensions.width / 32) * 32),
                    h: Math.max(32, Math.ceil(targetDimensions.height / 32) * 32),
                  }
                : selectResolution(aspectRatio, finalResolution)
              return computeFinalDimensions(lowRes.w, lowRes.h)
            })()
          : targetDimensions
            ? computeFinalDimensions(targetDimensions.width, targetDimensions.height)
            : finalDimsFromMegapixels(aspectRatio, finalResolution)
        const { outW, outH } = finalDims

        // "Draft" pipeline: canvas = BASE resolution (as in flf):
        // preset → ceil32(targetDimensions), custom → finalRes MP.
        // Metadata honestly records the draft's actual size + label.
        const draft = genMode !== 'extend' && params.pipeline === 'draft'
        const draftDims = draft && genMode !== 'flf'
          ? (targetDimensions
              ? {
                  w: Math.max(32, Math.ceil(targetDimensions.width / 32) * 32),
                  h: Math.max(32, Math.ceil(targetDimensions.height / 32) * 32),
                }
              : selectResolution(aspectRatio, finalResolution))
          : { w: outW, h: outH }
        const metaOutW = draft ? draftDims.w : outW
        const metaOutH = draft ? draftDims.h : outH

        // Store params for metadata saving.
        // Reference paths go through staged_transfers so the sidecar records
        // the real ComfyUI input/ names, not the local staged ones.
        // (fix 302) extend: refs go through params.extendRefs (refImages),
        // while params.references is empty — without this branch extend job sidecars
        // (both clips and combined) recorded references: [] and refine/upscale
        // lost identity anchors.
        const metaReferences = genMode === 'extend'
          ? refImages.map((p) => ({
              type: 'image',
              path: transfers[p] ?? p,
              role: params.references?.find((r) => r.kind === 'image' && r.path === p)?.imageIntent || '',
            }))
          : (params.references ?? []).map((r) => ({
              type: r.kind,
              path: transfers[r.path] ?? r.path,
              role: r.imageIntent || '',
            }))
        // (fix 470) flf: first frame goes to sidecar references (identity
        // anchor for refine; previously references for flf videos were empty
        // and anchor chain broke on first refine). Deduplicate by path.
        if (genMode === 'flf' && params.firstFrame) {
          const ffPath = transfers[params.firstFrame] ?? params.firstFrame
          if (ffPath && !metaReferences.some((r) => r.path === ffPath)) {
            metaReferences.unshift({ type: 'image', path: ffPath, role: '' })
          }
        }
        genParamsMap.set(promptId, {
          prompt: params.prompt,
          generation_mode: genMode, // (fix 146) ref | t2v | flf
          ...(genMode === 'ref' && params.audioGuide === true && refAudios.length > 0 && {
            audio_guide: true,
            keep_original_audio: true,
          }),
          ...(genMode === 'flf' && {
            first_frame: transfers[params.firstFrame ?? ''] ?? params.firstFrame ?? null,
            last_frame: transfers[params.lastFrame ?? ''] ?? params.lastFrame ?? null,
            // (fix 157) First frame dimensions — for "Repeat": without them
            // orientation from frame will not be restored and flf breaks again.
            first_frame_width: params.firstFrameWidth ?? null,
            first_frame_height: params.firstFrameHeight ?? null,
            // (fix 158) Final flf nominal (WxH from flfNominalDimensions) —
            // "Repeat" restores EXACTLY these dimensions, not the UI preset.
            flf_resolution: flfFinalResolution(params) ?? null,
          }),
          // Output subfolder of this task — for fallback output file search
          // (filter by own subfolder to avoid taking someone else's file)
          output_subfolder: params.outputSubfolder || '',
          model_type: 'minimax_h3_ref2va',
          workflow: draft ? 'draft-single-pass' : 'two-pass-latent-upscaler',
          pipeline: draft ? 'draft' : 'full',
          seed: actualSeed,
          resolution: `${metaOutW}x${metaOutH}`,
          aspect_ratio: aspectRatio,
          final_resolution_mp: finalResolution,
          low_res_mp: params.lowResMP ?? 0.2,
          video_length: videoLengthFrames,
          duration_seconds: videoLengthFrames / fps,
          fps,
          // Extend: actual steps of the CLIP (override > source steps/first) —
          // result metadata is read by next extension as "auto".
          pass1_steps: genMode === 'extend'
            ? (params.extendClipSteps ?? params.firstSamplerSteps ?? 6)
            : (params.firstSamplerSteps ?? 6),
          pass1_total_steps: params.firstSamplerTotalSteps ?? params.firstSamplerSteps ?? 6,
          ...(draft && { draft_steps: params.draftSteps ?? 4 }),
          pass2_steps: { '3step': 3, '4step': 4, '5step': 5, '6step': 6, '7step': 7 }[params.sigmaVariant || '3step'] ?? 3,
          sigma_variant: params.sigmaVariant || '3step',
          pass2_sampler: params.pass2Sampler || 'euler', // (fix 69)
          pass1_sampler: params.pass1Sampler || 'euler', // (fix 70)
          pass1_scheduler: params.pass1Scheduler || 'simple', // (fix 70)
          // Turbo LoRA strength is stored in loras.json (regular entry),
          // do not duplicate separate field in meta — applied LoRAs are listed in `lora`.
          minimax_h3_reference_detail: params.referenceDetail || 'match', // (fix 58) — meta-dialog already displays this field
          sparse_attention: params.sparseAttention === true, // (fixes 168→387) Sol-Attn default OFF
          // (fix 466) Sol-Attn settings into sidecar — "Repeat" restores them
          ...(params.sparseAttention === true && {
            sparse_tau: params.sparseTau ?? 1.3,
            sparse_start_percent: params.sparseStartPercent ?? 0.2,
            sparse_end_percent: params.sparseEndPercent ?? 1.0,
            sparse_min_tokens: params.sparseMinTokens ?? 12288,
            sparse_extra_tokens: params.sparseExtraTokens ?? 256,
          }),
          veda_attention: params.vedaAttention === true, // (fix 301)
          // (fix 403) veda settings into sidecar — "Repeat" restores them
          ...(params.vedaAttention === true && {
            veda_generated_sparsity: params.vedaGeneratedSparsity ?? '90%',
            veda_reference_sparsity: params.vedaReferenceSparsity ?? '90%',
            veda_full_attention_layers: params.vedaFullAttentionLayers ?? '',
            veda_full_attention_steps: params.vedaFullAttentionSteps ?? '',
            veda_verbose: params.vedaVerbose === true,
          }),
          low_vram_attention: params.lowVramAttention !== false,
          chunk_feed_forward: params.chunkFeedForward !== false,
          ...(params.chunkFeedForward !== false
            ? {
                chunk_ff_chunks: params.chunkFFChunks ?? 2,
                chunk_ff_threshold: params.chunkFFThreshold ?? 4096,
              }
            : {}),
          // Field `lora` is not duplicated: server itself records actually applied
          // LoRAs (customLoras, including turbo lora) into pending-meta.
          references: metaReferences,
          // extend mode: source video name (for auto-concatenation after generation)
          // (fix 174) Safeguard: if params.extendSourceVideo is empty, try
          // restoring from store (user could have uploaded video, but path was lost)
          extend_source_video: (() => {
            if (genMode !== 'extend') return null
            if (params.extendSourceVideo) return params.extendSourceVideo
            const storePath = useGenStore.getState().video.extendSourceVideoPath
            if (storePath) {
              return storePath
            }
            return null
          })(),
          // (fix 176) How many clips in this task — for N-way concatenation.
          extend_clips_count: genMode === 'extend' ? (params.extendClips?.length || 0) : 0,
          // (fix 423) extend: two-pass mode — to sidecar
          ...(genMode === 'extend' && { extend_two_pass: params.extendTwoPass === true }),
          // (fix 303) extend: FULL chain of clip prompts (meaningful,
          // trimmed; discard "." test clip prompts) — to clip and
          // combined file sidecars. concat route prepends source's chain
          // before them → full path "source → clip 1 → ... → clip N".
          ...(genMode === 'extend' && (() => {
            const chain = (params.extendClips ?? [])
              .map((c) => (c.prompt || '').trim())
              .filter((p) => /\p{L}{2,}/u.test(p))
            return chain.length > 0 ? { extend_prompts: chain } : {}
          })()),
          started_at: Date.now(),
        })
        persistGenParams()

        pollUntilDone(promptId, queueId, Date.now())
        useGenProgress.getState().startVideoGen(promptId)
      } catch (err) {
        // (fix Phase 4) Detailed diagnostics: log the EXACT error,
        // including HTTP status and response body. Visible in DevTools console.
        const isTimeout = err instanceof DOMException && err.name === 'AbortError'
        const isNetwork = err instanceof TypeError && /fetch|network/i.test(err.message)
        let errMsg: string
        if (isTimeout) {
          errMsg = 'Request timeout (120s). The server is likely waiting for GPU to be freed. Please try again.'
        } else if (isNetwork) {
          errMsg = 'Web server unavailable (ERR_CONNECTION_REFUSED). Make sure start.bat is running.'
        } else {
          errMsg = err instanceof Error ? err.message : String(err)
        }
        // (fix 141) If ComfyUI is not running — show clear message
        const isComfyDown = /ComfyUI|Failed to load resource|502|Bad Gateway|ERR_CONNECTION_REFUSED/i.test(errMsg)
        const displayMsg = isComfyDown
          ? 'ComfyUI is not running or not responding. Run start.bat and wait for ComfyUI to start (30-90 seconds).'
          : errMsg
        console.error(`[gen] generate() CAUGHT: type=${isTimeout ? 'timeout' : isNetwork ? 'network' : 'other'}`, err, `| displayMsg: ${displayMsg}`)
        queue.setStatus(queueId, 'error', displayMsg)
        // Explicit toast: 409 from vram-arbiter (assistant occupying VRAM) and other
        // submission errors should be visible immediately, not just in task queue
        toast.error('Generation not submitted', { description: displayMsg, duration: 8000 })
        const cur = useGenProgress.getState().video
        if (cur.phase === 'idle' || cur.phase === 'done' || cur.phase === 'error' || cur.phase === 'submitting') {
          useGenProgress.getState().setVideoPhase('error')
          useGenProgress.getState().setVideoError(displayMsg)
        }
      }
    },
    [queue, pollUntilDone]
  )

  const interrupt = useCallback(async () => {
    // (fix H2) Bump epoch: if POST /generate is currently in flight, its
    // continuation will notice the change and cancel the already accepted task.
    interruptEpoch++
    const activeJobIds = useGenQueue
      .getState()
      .items
      .filter((i) => i.type === 'video' && ['submitting', 'queued', 'running'].includes(i.status))
      .map((i) => i.promptId)
      .filter((pid): pid is string => Boolean(pid))

    // Set abort flags FIRST — prevents in-flight poll responses from
    // overwriting the clean state with a spurious 'error'.
    for (const pid of timersRef.current.keys()) {
      abortFlagsRef.current.set(pid, true)
    }
    // Also mark active queue items as cancelled immediately.
    useGenQueue
      .getState()
      .items
      .filter((i) => i.type === 'video' && ['submitting', 'queued', 'running'].includes(i.status))
      .forEach((i) => useGenQueue.getState().setStatus(i.id, 'cancelled'))

    // (fix 141) Send cancel requests in PARALLEL (not sequential) to
    // reduce total cancel time. Also add a small delay between sends to
    // avoid overwhelming ComfyUI with concurrent /interrupt + /queue POSTs.
    const cancelPromises = activeJobIds.map(async (promptId) => {
      try {
        await fetch('/api/comfy/cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt_id: promptId }),
        })
      } catch { /* ignore */ }
      // (fix 336) extclip junk on cancel — before deleting params from Map.
      await cleanupExtendClips(promptId)
      genParamsMap.delete(promptId)
    })
    await Promise.allSettled(cancelPromises)
    persistGenParams()

    clearAllTimers()
    useGenProgress.getState().resetVideoGen()
    // Remove cancelled items from queue
    useGenQueue
      .getState()
      .items
      .filter((i) => i.type === 'video' && i.status === 'cancelled')
      .forEach((i) => useGenQueue.getState().remove(i.id))

    toast.info('Generation cancelled')
  }, [clearAllTimers, cleanupExtendClips])

  const reset = useCallback(() => {
    clearAllTimers()
    useGenProgress.getState().resetVideoGen()
  }, [clearAllTimers])

  return {
    phase: progressStore.video.phase,
    error: progressStore.video.error,
    promptId: progressStore.video.promptId,
    progressValue: progressStore.video.progressValue,
    progressMax: progressStore.video.progressMax,
    executingNode: progressStore.video.executingNode,
    statusMessage: progressStore.video.statusMessage,
    generate,
    interrupt,
    reset,
  }
}
