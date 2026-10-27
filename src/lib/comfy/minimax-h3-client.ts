/**
 * ComfyUI client for MiniMax H3 video generation.
 *
 * Endpoints:
 *   POST /prompt          — submit workflow
 *   GET  /history/:id     — result
 *   GET  /queue           — current queue state
 *   POST /upload/image    — upload reference images
 *   GET  /view            — serve output files
 */

import { buildMiniMaxH3Workflow, videoSamplerStages, type MiniMaxH3Params } from './minimax-h3-template'
import { buildRefineWorkflow, type RefineParams } from './refine-template'
import { getClientId, registerPromptStages, type TileGeometry } from './progress-tracker'
import { getVideoFormatSettings } from '../video-format-server' // (fix 386)

export const COMFY_URL =
  process.env.COMFY_URL?.replace(/\/+$/, '') || 'http://127.0.0.1:8188'

/**
 * (fix Phase 6) Routine status polling logs ([status] … RUNNING/QUEUED/…)
 * spammed the start.bat console — one line per polling tick (1/s per
 * task) and alarmed the user. Now they are visible ONLY when running with
 * the environment variable H3_DEBUG=1. Anomaly warnings (NOT FOUND,
 * execution errors) always remain in the console.
 */
const statusDbg = process.env.H3_DEBUG
  ? (...args: unknown[]) => console.log('[status]', ...args)
  : () => {}

export interface SubmitResult {
  prompt_id: string
  number?: number
}

/** (fix 161) Descriptor returned by MiniMaxH3Extender node after
 *  uploading reference image via /h3_extender/ref/upload. ID is 64 hex characters
 *  (content-addressed), not a filename from ComfyUI input/. */
export interface ExtenderRefDescriptor {
  id: string
  source_id?: string
  original_name?: string
  width?: number
  height?: number
  size_bytes?: number
  saturation?: number
  contrast?: number
  brightness?: number
}

/** (fix 161) Upload one reference image to Extender node internal cache.
 *  Unlike uploadImage() — this is NOT a filename in ComfyUI input/, but a
 *  content-addressed descriptor that the node understands and uses itself.
 *  Returns descriptor (id — 64 hex). */
export async function uploadExtenderRef(
  buffer: Buffer,
  filename: string,
  timeoutMs = 120_000,
): Promise<ExtenderRefDescriptor> {
  const form = new FormData()
  form.append('ref_file', new Blob([new Uint8Array(buffer)]), filename)
  const res = await fetch(`${COMFY_URL}/h3_extender/ref/upload`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Extender ref upload failed (${res.status}): ${text.slice(0, 300)}`)
  }
  const data = (await res.json()) as { ok: boolean; ref?: ExtenderRefDescriptor; error?: string }
  if (!data.ok || !data.ref?.id) {
    throw new Error(`Extender ref upload: ${data.error || 'no ref returned'}`)
  }
  return data.ref
}

export interface StatusResult {
  status: 'queued' | 'running' | 'done' | 'error' | 'unknown'
  progress?: number
  detail?: string
  /** Output files when done. */
  outputs?: Array<{ filename: string; subfolder: string; type: string }>
}

/**
 * Upload an image (or any reference file, e.g. a video) to ComfyUI's input
 * directory. Returns the filename. Large video references can take a while —
 * pass a longer timeout (or rely on the 5-minute default).
 */
export async function uploadImage(
  buffer: Buffer | Blob,
  filename: string,
  timeoutMs = 300_000,
): Promise<string> {
  const form = new FormData()
  // (fix 347) Blob (e.g. fs.openAsBlob) — streaming body transmission
  // without buffering the whole file in heap.
  const blob = buffer instanceof Blob ? buffer : new Blob([new Uint8Array(buffer)])
  form.append('image', blob, filename)
  form.append('subfolder', '')
  form.append('type', 'input')

  const res = await fetch(`${COMFY_URL}/upload/image`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Upload failed (${res.status}): ${text.slice(0, 200)}`)
  }
  const data = await res.json()
  return data.name as string
}

/** Submit a MiniMax H3 workflow. Returns prompt_id. */
export async function submitVideo(params: MiniMaxH3Params): Promise<SubmitResult> {
  const workflow = buildMiniMaxH3Workflow({ ...params, videoFormat: getVideoFormatSettings() }) // (fix 386)
  // (fix 255) sampler stages → honest 0–100% in tracker
  return submitWorkflowJson(workflow, videoSamplerStages(params))
}

/**
 * Submit a Refine workflow (generative v2v upscale: encoded source latent →
 * LatentUpscaler3D → short Pass-2-style sampling).
 * Same VHS output options as submitVideo (no PNG poster / silent intermediate).
 */
export async function submitRefine(params: RefineParams): Promise<SubmitResult> {
  const workflow = buildRefineWorkflow({ ...params, videoFormat: getVideoFormatSettings() }) // (fix 386)
  // (fix 255) single pass — 0–100 scale without dividing by 2
  return submitWorkflowJson(workflow, [['46:21']])
}

/** POST an API-format workflow to ComfyUI /prompt. */
export async function submitWorkflowJson(
  workflow: Record<string, unknown>,
  stages?: string[][],
  tileGeometry?: TileGeometry | null, // (fix 479)
): Promise<SubmitResult> {
  const body = {
    prompt: workflow,
    client_id: getClientId(),
    // VideoHelperSuite (VHS_VideoCombine) otherwise writes THREE files per
    // generation: the first-frame PNG poster, an intermediate SILENT video,
    // and the muxed video-with-audio. We only want the audio video (+ our own
    // .meta.json sidecar). These VHS options are read from
    // extra_pnginfo.workflow.extra — skip the PNG and delete the silent video
    // so the output folder ends up clean.
    extra_data: {
      extra_pnginfo: {
        workflow: {
          extra: {
            VHS_MetadataImage: false,
            VHS_KeepIntermediate: false,
          },
        },
      },
    },
  }

  let res: Response
  try {
    res = await fetch(`${COMFY_URL}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })
  } catch (err) {
    throw new Error(
      `ComfyUI is not responding at ${COMFY_URL}. ` +
        `Start ComfyUI and verify the port. (${String(err)})`,
    )
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    // (fix 504) Detect "models not found" (value_not_in_list for
    // vae_name / unet_name / clip_name / tiny_vae) — give a friendly
    // message instead of raw JSON error.
    let msg = `ComfyUI rejected workflow (HTTP ${res.status}): ${detail.slice(0, 500)}`
    try {
      const parsed = JSON.parse(detail)
      const nodeErrors: Record<string, { errors?: Array<{ type?: string; details?: string }> }> |
        undefined = parsed.node_errors
      if (nodeErrors && typeof nodeErrors === 'object') {
        const isModelMissing = Object.values(nodeErrors).some((ne) =>
          Array.isArray(ne?.errors) && ne.errors.some((e) =>
            e.type === 'value_not_in_list' &&
            /not in \[/.test(e.details || '') &&
            /(_vae|_unet|clip_name|tiny_vae|model_name|unet_name|vae_name|clip_name)/.test(e.details || ''),
          ),
        )
        if (isModelMissing) {
          msg =
            'Models not found on disk. ' +
            'Open "Settings → Models" and download the required files, ' +
            'or place them manually in ComfyUI-Easy-Install/ComfyUI/models/ (vae/, text_encoders/, diffusion_models/).'
        }
      }
    } catch { /* not JSON — keep original message */ }
    throw new Error(msg)
  }

  const data = (await res.json()) as SubmitResult
  if (!data.prompt_id) throw new Error('ComfyUI returned response without prompt_id.')
  // (fix 255) register stages BEFORE first WS events of prompt
  // (fix 479) + tile geometry for monotonic progress of tile-upscale
  if (stages && stages.length > 0) {
    registerPromptStages(data.prompt_id, stages, tileGeometry)
  }
  return data
}

/**
 * (fix) Retries on network errors. Previously a single TCP drop (WinError 10054)
 * = getStatus returned 'unknown' → client treated this as an error and failed.
 * Now we automatically retry 2 times with 1s, 2s delays.
 */
export async function getStatusWithRetry(promptId: string, maxRetries = 2): Promise<StatusResult> {
  let lastError: Error | null = null
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        // Exponential backoff: 1s, 2s
        // (fix 587) pow(2, attempt-1) — same as model-downloader: was 2s/4s
        const delay = Math.pow(2, attempt - 1) * 1000
        await new Promise(r => setTimeout(r, delay))
      }
      
      return await getStatus(promptId)
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e))
      
      // If this is the last retry — rethrow error
      if (attempt === maxRetries) {
        throw lastError
      }
      
      // Otherwise — try again
    }
  }
  
  throw lastError || new Error('Unknown error')
}

/** Poll the status of a submitted prompt. */
export async function getStatus(promptId: string): Promise<StatusResult> {
  statusDbg(`getStatus(${promptId})`)
  // (fix) Increased timeouts for video generation. Previously 5 seconds was
  // too short — during long generation TCP connection dropped (WinError 10054),
  // and getStatus returned 'unknown' → client treated this as an error.
  // Now 30 seconds is enough even for slow machines.
  const histRes = await fetch(`${COMFY_URL}/history/${promptId}`, {
    signal: AbortSignal.timeout(30_000),
  }).catch(() => null)

  if (histRes && histRes.ok) {
    const hist = await histRes.json()
    const entry = hist[promptId]
    if (entry) {
      const statusStr = entry.status?.status_str?.toLowerCase() ?? ''
      // (fix 432) status.messages is an ARRAY OF PAIRS [type, data]
      // (['execution_error', {...}], ['execution_start', {...}], ...), not
      // objects {type, data}. Old find(m.type === 'execution_error')
      // never triggered → errMsg undefined → detail = bare "error"
      // without reason (in log: "ERROR from history — error undefined").
      // Check in BOTH formats (tuple and object) — ComfyUI versions differ.
      const msgs: unknown[] = Array.isArray(entry.status?.messages) ? entry.status.messages : []
      const pickMsg = (pred: (t: unknown, d: unknown) => boolean) => {
        for (const m of msgs) {
          if (Array.isArray(m)) {
            if (pred(m[0], m[1])) return m[1]
          } else if (m && typeof m === 'object') {
            const o = m as { type?: unknown; data?: unknown }
            if (pred(o.type, o.data)) return o.data
          }
        }
        return undefined
      }
      const errData =
        pickMsg((t) => t === 'execution_error') ??
        pickMsg((t) => typeof t === 'string' && t.toLowerCase().includes('error'))

      if (errData !== undefined || statusStr.includes('error')) {
        const ed = (errData ?? {}) as {
          exception_message?: string
          exception_type?: string
          node_type?: string
          node_id?: string | number
        }
        // Readable failure reason: exception_message + exception type + node.
        const reason =
          (typeof ed.exception_message === 'string' && ed.exception_message.trim()) ||
          (typeof ed.exception_type === 'string' && ed.exception_type.trim()) ||
          (entry.status?.status_str && entry.status.status_str !== 'error' ? entry.status.status_str : '') ||
          'Execution error in ComfyUI'
        const node = ed.node_type
          ? ` [node: ${ed.node_type}${ed.node_id != null ? ` #${ed.node_id}` : ''}]`
          : ''
        // Single line with cap: don't pass traceback lines and \n into banner/queue.
        const detail = `${reason}${node}`.replace(/\s+/g, ' ').slice(0, 500)
        console.warn(`[status] ${promptId}: ERROR from history —`, detail)
        return {
          status: 'error',
          detail,
        }
      }

      // Extract outputs — check ALL keys for file arrays (robust to different node output names)
      const outputs: Array<{ filename: string; subfolder: string; type: string }> = []
      for (const nodeOutput of Object.values(entry.outputs ?? {})) {
        const o = nodeOutput as Record<string, unknown>
        for (const val of Object.values(o)) {
          if (Array.isArray(val)) {
            for (const item of val) {
              if (item && typeof item === 'object' && 'filename' in item) {
                outputs.push(item as { filename: string; subfolder: string; type: string })
              }
            }
          }
        }
      }
      statusDbg(`${promptId}: DONE`)
      return { status: 'done', outputs }
    }
    // No entry in history — fall through to queue check
    statusDbg(`${promptId}: not in history, checking queue...`)
  } else {
    statusDbg(`${promptId}: history request failed (histRes=${!!histRes}, ok=${histRes?.ok})`)
  }

  // Check queue
  // (fix) Increased timeout — see above
  const queueRes = await fetch(`${COMFY_URL}/queue`, {
    signal: AbortSignal.timeout(30_000),
  }).catch(() => null)

  if (queueRes && queueRes.ok) {
    const queue = await queueRes.json()
    const running = queue.queue_running ?? []
    const pending = queue.queue_pending ?? []

    // ComfyUI queue format: [[number, prompt_id, prompt, ...], ...]
    // item[0] = queue number (int), item[1] = prompt_id (string)
    if (running.some((item: unknown[]) => item[1] === promptId)) {
      statusDbg(`${promptId}: RUNNING`)
      return { status: 'running' }
    }
    if (pending.some((item: unknown[]) => item[1] === promptId)) {
      statusDbg(`${promptId}: QUEUED`)
      return { status: 'queued' }
    }
    statusDbg(`${promptId}: NOT in queue (running=${running.length}, pending=${pending.length})`)
  } else {
    statusDbg(`${promptId}: queue request failed (queueRes=${!!queueRes})`)
  }

  // Both requests failed — ComfyUI is unavailable/restarting. This is NOT "queued":
  // previously such response endlessly displayed "Queued...", until the
  // 60-minute timeout expired. Client counts consecutive 'unknown' and fails
  // with an error after N attempts.
  if (!histRes && !queueRes) {
    return { status: 'unknown', detail: 'ComfyUI is not responding' }
  }

  // Not in queue and not in history. ComfyUI answers (both requests
  // succeeded) but this prompt_id is nowhere to be found — it was either
  // rejected (execution error that ComfyUI didn't record in /history for
  // this client_id), lost (ComfyUI restart), or never properly queued.
  //
  // Returning 'queued' here was a trap: the client polls forever, shows
  // "Generating..." for the full 60-minute timeout, and the user sees a
  // phantom generation. Returning 'unknown' lets the client's consecutive-
  // unknown counter kick in (20 polls × 1s = 20s) and surface a clear
  // error: "ComfyUI is not responding" — which, while slightly misleading in
  // this specific case (ComfyUI IS responding), is far better than
  // waiting an hour for a job that will never finish.
  console.warn(
    `[status] ${promptId}: NOT FOUND — ComfyUI is responding (history+queue OK), ` +
    `but prompt_id is absent from both. ComfyUI may have rejected the task ` +
    `or restarted. Returning 'unknown'.`
  )
  return { status: 'unknown', detail: 'Task not found in ComfyUI (rejected or lost)' }
}

/**
 * Cancel a specific prompt (fix 145).
 *
 * IMPORTANT: /interrupt kills the CURRENTLY executing task in ComfyUI — regardless
 * of which prompt_id we intend. Previously /interrupt was ALWAYS sent:
 * deleting a WAITING task (or already completed one) interrupted SOMEONE ELSE's running
 * generation (bug: "deleted the last of three — interrupted the one being generated").
 *
 * Now:
 *  • task is RUNNING → /interrupt + delete from queue;
 *  • task is PENDING → only delete from queue; then re-check: if during
 *    this time it started running (race condition pending→running between GET and
 *    DELETE) — interrupt specifically this task;
 *  • task not in queue (completed/lost) → do nothing, do not touch /interrupt.
 */
export async function cancelPrompt(promptId: string): Promise<void> {
  // (fix 356) null = /queue unavailable (network failure / ComfyUI down).
  // Previously this was silently treated as "no task" → no-op, while client
  // received ok:true — "cancellation" did not occur.
  const inQueueState = async (): Promise<{ running: boolean; pending: boolean } | null> => {
    try {
      const res = await fetch(`${COMFY_URL}/queue`, { signal: AbortSignal.timeout(5_000) })
      if (!res.ok) return null
      const q = await res.json()
      const match = (arr: unknown[]) => (arr ?? []).some((item) => Array.isArray(item) && item[1] === promptId)
      return {
        running: match(q.queue_running),
        pending: match(q.queue_pending),
      }
    } catch {
      return null
    }
  }
  const deleteFromQueue = () =>
    fetch(`${COMFY_URL}/queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delete: [promptId] }),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => {})
  const interruptRunning = () =>
    fetch(`${COMFY_URL}/interrupt`, { method: 'POST' }).catch(() => {})

  const state = await inQueueState()
  if (state === null) {
    // (fix 356) /queue unavailable — do not remain silent: caller route will return error.
    throw new Error('ComfyUI /queue is unavailable — cancellation not performed')
  }

  if (state.running) {
    // Our task is running: interrupt and clean remnants from queue.
    await interruptRunning()
    await deleteFromQueue()
    return
  }
  if (state.pending) {
    // Only remove from queue — do NOT touch another running task.
    await deleteFromQueue()
    // Race condition: task might have started between GET and DELETE — then DELETE did not
    // catch it, and it is now running. Re-check and interrupt SPECIFICALLY this task.
    const after = await inQueueState()
    if (after?.running) await interruptRunning()
    return
  }
  // Task is not in queue (completed/rejected/lost): complete no-op.
  // Previously an unconditional /interrupt was sent here — killing someone else's generation.
}

/** Build a URL for viewing a generated file. */
export function fileUrl(filename: string, subfolder = '', type = 'output'): string {
  const params = new URLSearchParams({ filename, subfolder, type })
  return `${COMFY_URL}/view?${params}`
}
