/**
 * Refine Queue — (fix 261).
 *
 * Previously the "Refine" tab executed tasks directly: one task occupied
 * the tab until completion, a second could not be queued, and there was no
 * unified queue with generations. Now whole/chunks refine is queued in the
 * COMMON queue (useGenQueue, type 'refine') alongside generations and
 * extensions — tasks execute one by one, the queue card displays
 * all tasks, and cancellation works.
 *
 * The runner is a module-level singleton (like the assistant engine): survives
 * tab switching; submits task in background, polls status/progress,
 * stitches chunks for "chunks" mode, and notifies the gallery. Extension and generation
 * use the same queue via use-video-gen (type 'video'); unified FIFO
 * ComfyUI execution is guaranteed by `comfy-turn.ts`.
 */
import { useGenQueue, type QueueItem } from './gen-queue-store'
import { acquireComfyTurn, isComfyTurnActive } from './comfy-turn'
import { useGalleryRefresh } from './gallery-refresh-store'

export interface RefineTask {
  mode: 'whole' | 'chunks'
  /** Original video from gallery (output) being refined. */
  source: { filename: string; subfolder: string }
  /** (fix 265) File from disk, already in ComfyUI input/ (via /api/comfy/upload).
      When present — source, rather than a copy from output. */
  inputSource?: string
  /** (fix 494) 'free' — custom resolution: server computes short
   *  side from targetMp based on actual source dimensions. */
  target: 'same' | 'x2' | number | 'free'
  /** (fix 494) Megapixel target for target='free' (up to 4K = 8.3 MP). */
  targetMp?: number
  steps: number
  /** Ladder σ_start (0.1–0.95) — slider for "how much noise to remove". */
  sigmaStart?: number
  seed: number
  prompt: string
  chunkSeconds: number
  /** (fix 315) Reference sizing mode ('match' | 'max', default 'max'
   *  on server) — toggle from Refine tab. */
  refImageSize?: 'match' | 'max'
  /** (fix 407) Veda Sparse Attention + node settings (from gen-store). */
  vedaAttention?: boolean
  vedaGeneratedSparsity?: string
  vedaReferenceSparsity?: string
  vedaFullAttentionLayers?: string
  vedaFullAttentionSteps?: string
  vedaVerbose?: boolean
  /** (fix 466) Sol-Attn + node settings (from gen-store). */
  sparseAttention?: boolean
  sparseTau?: number
  sparseStartPercent?: number
  sparseEndPercent?: number
  sparseMinTokens?: number
  sparseExtraTokens?: number
  /** (fix 492) Original audio track instead of regenerated sound. */
  keepOriginalAudio?: boolean
  /** (fix 509) Reference images from user (names in input/) —
   *  for disk sources without metadata. */
  refImages?: string[]
}

/** Tasks waiting in queue (module-level — survives tab switching). */
const tasks = new Map<string, RefineTask>()
/**
 * Turn in the unified ComfyUI queue is requested IMMEDIATELY upon enqueueing, rather than
 * when runner reaches the task. Otherwise refine #2 enqueued before
 * video wouldn't participate in FIFO and video could overtake it.
 */
const turns = new Map<string, Promise<boolean>>()
let running = false
/**
 * (fix 716) Queue item id that the runner is processing RIGHT NOW.
 * Allows sweep to distinguish a live task from an orphan after page reload
 * (module-level Map resets on reload, queue items do not).
 */
let activeItemId: string | null = null

/** Enqueue refine in global queue. Returns queue item id. */
export function enqueueRefine(task: RefineTask): string {
  const id = useGenQueue.getState().enqueue('refine', `Refine: ${task.source.filename}`)
  tasks.set(id, task)
  turns.set(id, acquireComfyTurn(id))
  kick()
  return id
}

/** All active queue items of type 'refine'. */
export function activeRefineItems(items: QueueItem[]): QueueItem[] {
  return items.filter(
    (i) => i.type === 'refine' && (i.status === 'submitting' || i.status === 'queued' || i.status === 'running'),
  )
}

/** Cancel all active refines ("Stop" button on tab). */
export async function cancelActiveRefines(): Promise<void> {
  const { setStatus } = useGenQueue.getState()
  for (const item of activeRefineItems(useGenQueue.getState().items)) {
    setStatus(item.id, 'cancelled')
    // (fix 334) Queued task waiting its turn — delete from Map as well: otherwise orphan
    // record remained forever (runner won't pick it up — item is cancelled).
    tasks.delete(item.id)
    turns.delete(item.id)
    if (item.promptId) {
      try {
        await fetch('/api/comfy/cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt_id: item.promptId }),
        })
      } catch { /* ignore */ }
    }
  }
}

/**
 * (fixes 329/334) Cancel a SINGLE refine from QueueIndicator: cancelled status,
 * deleted from Map (for not-yet-started task) and cancelled in ComfyUI by prompt_id.
 */
export async function cancelRefineItem(id: string): Promise<void> {
  const { setStatus } = useGenQueue.getState()
  const item = useGenQueue.getState().items.find((i) => i.id === id)
  tasks.delete(id)
  turns.delete(id)
  setStatus(id, 'cancelled')
  if (item?.promptId) {
    try {
      await fetch('/api/comfy/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt_id: item.promptId }),
      })
    } catch { /* ignore */ }
  }
}

function kick() {
  if (running) return
  running = true
  void runLoop().finally(() => {
    running = false
    // New tasks may have been added during execution — keep loop going.
    if (activeRefineItems(useGenQueue.getState().items).some((i) => tasks.has(i.id))) kick()
  })
}

async function runLoop(): Promise<void> {
  for (;;) {
    const item = useGenQueue
      .getState()
      .items.find(
        (i) =>
          i.type === 'refine' &&
          (i.status === 'submitting' || i.status === 'queued') &&
          tasks.has(i.id),
      )
    if (!item) return
    const task = tasks.get(item.id)!
    tasks.delete(item.id)

    try {
      // (fix 716) Mark item as "in progress" — sweep won't consider it
      // an orphan and won't launch a second finalizer.
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

const isCancelled = (id: string) =>
  useGenQueue.getState().items.find((i) => i.id === id)?.status === 'cancelled'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function runTask(id: string, task: RefineTask): Promise<void> {
  const q = () => useGenQueue.getState()

  // Turn already requested in enqueueRefine — await here, preserving global
  // enqueue order. A task cancelled while waiting simply exits.
  const turn = turns.get(id)
  const granted = turn ? await turn : true
  turns.delete(id)
  if (!granted || !isComfyTurnActive(id) || isCancelled(id)) return

  q().setStatus(id, 'submitting')

  // (fix 264) Generation time for resulting file sidecar:
  // from submission to ComfyUI to done (generation + stitching for "chunks").
  const t0 = Date.now()

  const res = await fetch('/api/comfy/refine', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sourceFilename: task.source.filename,
      sourceSubfolder: task.source.subfolder,
      ...(task.inputSource ? { inputSource: task.inputSource } : {}),
      // (fix 494) free mode: server converts MP to short side
      target: task.target === 'free' ? 'same' : task.target,
      ...(task.target === 'free' && task.targetMp ? { targetMp: task.targetMp } : {}),
      steps: task.steps,
      ...(task.sigmaStart ? { sigmaStart: task.sigmaStart } : {}),
      seed: task.seed,
      prompt: task.prompt.trim() ? task.prompt.trim() : undefined,
      refImageSize: task.refImageSize ?? 'max', // (fix 315)
      // (fix 407) Veda + node settings — only when toggle enabled
      ...(task.vedaAttention === true && {
        vedaAttention: true,
        vedaGeneratedSparsity: task.vedaGeneratedSparsity,
        vedaReferenceSparsity: task.vedaReferenceSparsity,
        vedaFullAttentionLayers: task.vedaFullAttentionLayers,
        vedaFullAttentionSteps: task.vedaFullAttentionSteps,
        vedaVerbose: task.vedaVerbose === true,
      }),
      // (fix 466) Sol-Attn + node settings — only when toggle enabled
      ...(task.sparseAttention === true && {
        sparseAttention: true,
        sparseTau: task.sparseTau,
        sparseStartPercent: task.sparseStartPercent,
        sparseEndPercent: task.sparseEndPercent,
        sparseMinTokens: task.sparseMinTokens,
        sparseExtraTokens: task.sparseExtraTokens,
      }),
      ...(task.mode === 'chunks' ? { mode: 'chunks', chunkSeconds: task.chunkSeconds } : {}),
      // (fix 492) Original sound — checkbox on Refine tab
      ...(task.keepOriginalAudio === true && { keepOriginalAudio: true }),
      // (fix 509) User references (source from disk)
      ...(task.refImages && task.refImages.length > 0 && { refImages: task.refImages }),
    }),
  })
  const data = (await res.json()) as {
    prompt_id?: string
    error?: string
    chunks?: number
    /** Prompt actually sent by server into workflow (source meta +
     *  its image references are resolved on server) — for stitch sidecar. */
    promptUsed?: string
  }
  if (!res.ok || data.error) {
    throw new Error(data.error || `HTTP ${res.status}`)
  }
  const promptId = data.prompt_id
  if (!promptId) throw new Error('ComfyUI did not return prompt_id')

  // Cancelled/removed from queue while POST was in-flight: task already accepted
  // by ComfyUI — abort it and do not launch orphan polling.
  if (!isComfyTurnActive(id) || isCancelled(id)) {
    try {
      await fetch('/api/comfy/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt_id: promptId }),
      })
    } catch { /* ignore */ }
    return
  }

  q().setPromptId(id, promptId)
  q().setStatus(id, 'queued')

  // ── Poll status + progress (like awaitJobDone of previous tab) ──
  let unknownStreak = 0
  for (;;) {
    if (isCancelled(id)) return
    await sleep(1500)
    let s: { status?: string; detail?: string; outputs?: Array<{ filename: string; subfolder?: string; type?: string }> }
    try {
      const r = await fetch(`/api/comfy/status?prompt_id=${encodeURIComponent(promptId)}`)
      if (!r.ok) throw new Error(`status ${r.status}`)
      s = await r.json()
    } catch {
      if (++unknownStreak >= 20) throw new Error('ComfyUI is not responding (30s consecutive)')
      continue
    }
    // (fix 552) Re-check after await: cancellation could arrive while request
    // was in-flight. ComfyUI marks aborted prompt as 'error' — without
    // this check, "Cancelled" status was overwritten by "Error".
    if (isCancelled(id)) return
    // (fix 552) Reset unknown counter ONLY on credible status.
    // Previously reset was in try-block (any HTTP 200) and cleared counter
    // BEFORE checking status:'unknown' — when "responding but task not found"
    // (ComfyUI restarted / prompt removed from queue) counter never reached 20,
    // "Task not found" timeout was dead, polling loop hung forever
    // and blocked entire refine queue (running = true in kick()).
    if (s.status !== 'unknown') unknownStreak = 0
    if (s.status === 'running' && q().items.find((i) => i.id === id)?.status !== 'running') {
      q().setStatus(id, 'running')
    }
    if (s.status === 'running' || s.status === 'queued') {
      try {
        const pr = await fetch(`/api/comfy/progress?prompt_id=${encodeURIComponent(promptId)}`)
        if (pr.ok) {
          const pd = await pr.json()
          if (pd.progress && typeof pd.progress.percent === 'number') {
            q().setProgress(id, pd.progress.percent, 100)
          }
        }
      } catch { /* non-critical */ }
      continue
    }
    if (s.status === 'error') throw new Error(s.detail || 'Execution error')
    if (s.status === 'unknown') {
      if (++unknownStreak >= 20) throw new Error('Task not found in ComfyUI')
      continue
    }
    if (s.status !== 'done') continue

    // ── done ──
    if (task.mode === 'chunks') {
      // (fix 311) New workflow (fix 314 in refine-template.ts) concatenates
      // windows IN LATENT space and produces ONE Minimax_Studio_refine_* file — ffmpeg
      // stitch and re-encoding are no longer needed, metadata is written
      // by server (recordPendingMetaRaw in /api/comfy/refine → finalize in
      // /api/comfy/status on done), just like in "whole" mode.
      // LEGACY path: if refinepart_* outputs returned (old workflow) —
      // sort by window number and stitch with hard concatenation as before.
      const parts = (s.outputs || [])
        .filter((o) => o.type === 'output' && /refinepart.*[.]mp4$/i.test(o.filename))
        .sort((a, b) => {
          // (fix 310) Window index explicitly in prefix: refinepart_0, refinepart_1, …
          const num = (f: string) => {
            const m = f.match(/refinepart_(\d+)/i)
            return m ? parseInt(m[1], 10) : 0
          }
          return num(a.filename) - num(b.filename)
        })
      if (!parts.length) {
        // New path: single output file, nothing to stitch.
        const single = (s.outputs || []).find(
          (o) => o.type === 'output' && /Minimax_Studio_refine(?!part).*[.]mp4$/i.test(o.filename),
        )
        if (!single) throw new Error('ComfyUI did not return refine file')
        if (isCancelled(id)) return
      } else {
      if (isCancelled(id)) return
      q().setMessage(id, 'Stitching chunks…')
      // (fix 272) Latent chain: chunks without duplicates (head trimmed),
      // continuous seams — hard concat. (fix 311) LEGACY: only for
      // old-style workflows with chunked refinepart_*.
      const st = await fetch('/api/comfy/refine/stitch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chunkFiles: parts.map((o) => ({ filename: o.filename, subfolder: o.subfolder || '' })),
          audioSource: { filename: task.source.filename, subfolder: task.source.subfolder },
          outSubfolder: task.source.subfolder || '',
          hard: true,
          meta: {
            // Server already resolved prompt (source meta + images) —
            // write it to final sidecar rather than raw task prompt field.
            prompt: data.promptUsed || task.prompt,
            model_type: 'minimax_h3_ref2va',
            workflow: 'refine-chunks-latent-chain',
            generation_mode: 'refine',
            refine_mode: 'chunks',
            source_video: { filename: task.source.filename, subfolder: task.source.subfolder },
            steps: task.steps,
            sigma_start: task.sigmaStart,
            seed: task.seed,
            chunks: parts.length,
            // (fix 407) veda settings — "Retry" restores them
            ...(task.vedaAttention === true && {
              veda_attention: true,
              veda_generated_sparsity: task.vedaGeneratedSparsity ?? '90%',
              veda_reference_sparsity: task.vedaReferenceSparsity ?? '90%',
              veda_full_attention_layers: task.vedaFullAttentionLayers ?? '',
              veda_full_attention_steps: task.vedaFullAttentionSteps ?? '',
              veda_verbose: task.vedaVerbose === true,
            }),
            // (fix 264) Generation time: submit → done (+ chunk stitching).
            generation_time: Math.max(1, Math.round((Date.now() - t0) / 1000)),
          },
        }),
      })
      const sd = (await st.json()) as { error?: string }
      if (!st.ok || sd.error) throw new Error(sd.error || `HTTP ${st.status}`)
      }
    }
    q().setStatus(id, 'done')
    q().setProgress(id, 100, 100)
    useGalleryRefresh.getState().bump()
    return
  }
}

/**
 * Cleanup after page reload: queue items survived reload (persist),
 * but their Runtime (task Map / runner) did not. Mark with an honest
 * error: files may have finished generating on server.
 * Called on mount of Refine tab.
 */
export function sweepOrphanRefineItems(): void {
  const { items, setStatus } = useGenQueue.getState()
  for (const it of items) {
    if (it.type !== 'refine') continue
    if (it.status !== 'submitting' && it.status !== 'queued' && it.status !== 'running') continue
    // (fix 716) Live task is one in queue (tasks) or being processed
    // right now by the runner (activeItemId). Previously sweep ran
    // recoverOrphanRefineItem for ANY item with prompt_id, including
    // the currently running task: leading to TWO pollers on a single prompt,
    // both calling /api/comfy/refine/stitch → chunks stitched twice,
    // and two outputs written in parallel.
    if (tasks.has(it.id) || it.id === activeItemId) continue
    // Active task with prompt_id will be completed by global queue poller
    // (queue-indicator): files might have been preserved. But tasks not yet
    // dispatched (without prompt_id) are lost with the task.
    if (!it.promptId) {
      setStatus(it.id, 'error', 'Page reloaded — task was not dispatched. Please run again.')
    } else {
      // (fix 332) Task with prompt_id: finish it ourselves. Previously its
      // done was set by global queue-indicator poller — WITHOUT legacy stitch
      // of chunked refinepart_* and without gallery bump ("Done" without stitched
      // file). Now finalization of refine items is only here / in runner.
      void recoverOrphanRefineItem(it).catch((err) => {
        console.warn('[refine-queue] recoverOrphanRefineItem failed:', err instanceof Error ? err.message : String(err))
      })
    }
  }
}

/* (fix 332) Recovery of refine task after page reload.
 * Runner (tasks Map) cannot survive reload, but task in ComfyUI is alive.
 * Poll status; on done:
 *  • single file Minimax_Studio_refine_* (new workflow) — simply done + bump;
 *  • refinepart_* (legacy) — stitch via /api/comfy/refine/stitch, as
 *    runner did: source and meta taken from chunk sidecar (written by
 *    status route pending-meta on 'done' — recordPendingMetaRaw in
 *    /api/comfy/refine contains source_video). No sidecar — honest
 *    error with clear text, rather than silent "Done". */
const orphanRecovery = new Set<string>()

async function recoverOrphanRefineItem(item: QueueItem): Promise<void> {
  const promptId = item.promptId
  if (!promptId || orphanRecovery.has(promptId)) return
  orphanRecovery.add(promptId)
  const q = () => useGenQueue.getState()
  try {
    let unknownStreak = 0
    for (;;) {
      const cur = q().items.find((i) => i.id === item.id)
      if (!cur || cur.status === 'cancelled') return
      await sleep(2000)
      let s: {
        status?: string
        detail?: string
        outputs?: Array<{ filename: string; subfolder?: string; type?: string }>
      }
      try {
        const r = await fetch(`/api/comfy/status?prompt_id=${encodeURIComponent(promptId)}`)
        if (!r.ok) throw new Error(`status ${r.status}`)
        s = await r.json()
      } catch {
        if (++unknownStreak >= 20) {
          q().setStatus(item.id, 'error', 'ComfyUI is not responding after page reload')
          return
        }
        continue
      }
      if (s.status === 'running' || s.status === 'queued') {
        unknownStreak = 0
        continue
      }
      if (s.status === 'unknown') {
        if (++unknownStreak >= 20) {
          q().setStatus(item.id, 'error', 'Task not found in ComfyUI (server was restarted)')
          return
        }
        continue
      }
      if (s.status === 'error') {
        q().setStatus(item.id, 'error', s.detail || 'Execution error')
        return
      }
      if (s.status !== 'done') continue

      // ── done ──
      const parts = (s.outputs || [])
        .filter((o) => o.type === 'output' && /refinepart.*[.]mp4$/i.test(o.filename))
        .sort((a, b) => {
          const num = (f: string) => {
            const m = f.match(/refinepart_(\d+)/i)
            return m ? parseInt(m[1], 10) : 0
          }
          return num(a.filename) - num(b.filename)
        })
      if (!parts.length) {
        // New workflow: single file, nothing to stitch.
        q().setStatus(item.id, 'done')
        q().setProgress(item.id, 100, 100)
        useGalleryRefresh.getState().bump()
        return
      }

      // LEGACY: refinepart_* chunks — stitch them.
      q().setMessage(item.id, 'Stitching chunks…')
      // Source and prompt from first chunk's sidecar (pending-meta writes
      // them on 'done' even without active browser).
      let source: { filename: string; subfolder: string } | null = null
      let promptUsed = ''
      try {
        const metaPath = `${parts[0].subfolder ? parts[0].subfolder + '/' : ''}${parts[0].filename}`
        const mr = await fetch(`/api/comfy/meta?path=${encodeURIComponent(metaPath)}`)
        if (mr.ok) {
          const m = (await mr.json()) as {
            source_video?: { filename?: string; subfolder?: string }
            prompt?: string
          }
          if (m?.source_video?.filename) {
            source = {
              filename: m.source_video.filename,
              subfolder: m.source_video.subfolder ?? '',
            }
          }
          if (typeof m?.prompt === 'string') promptUsed = m.prompt
        }
      } catch { /* honest error below */ }
      if (!source) {
        q().setStatus(
          item.id,
          'error',
          'Refine "Chunks" completed, but page was reloaded: refinepart_* chunks remained unstitched (source not found in chunk metadata). Please run refine again.',
        )
        return
      }
      // stitch resolves audioSource only in output/: for refine from disk
      // (inputSource) the original file is in input/ — in that case the first
      // chunk serves as file anchor (hard concatenation takes audio from chunks themselves).
      const audioSource =
        source.subfolder === 'input'
          ? { filename: parts[0].filename, subfolder: parts[0].subfolder || '' }
          : source
      const st = await fetch('/api/comfy/refine/stitch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chunkFiles: parts.map((o) => ({ filename: o.filename, subfolder: o.subfolder || '' })),
          audioSource,
          outSubfolder: source.subfolder === 'input' ? '' : source.subfolder,
          hard: true,
          meta: {
            prompt: promptUsed,
            model_type: 'minimax_h3_ref2va',
            workflow: 'refine-chunks-latent-chain',
            generation_mode: 'refine',
            refine_mode: 'chunks',
            source_video: source,
            chunks: parts.length,
            recovered_after_reload: true,
          },
        }),
      })
      const sd = (await st.json().catch(() => ({}))) as { error?: string }
      if (!st.ok || sd.error) {
        q().setStatus(
          item.id,
          'error',
          `Chunk stitching failed after reload: ${sd.error || `HTTP ${st.status}`}. refinepart_* chunks remained in gallery.`,
        )
        return
      }
      q().setStatus(item.id, 'done')
      q().setProgress(item.id, 100, 100)
      useGalleryRefresh.getState().bump()
      return
    }
  } finally {
    orphanRecovery.delete(promptId)
  }
}
