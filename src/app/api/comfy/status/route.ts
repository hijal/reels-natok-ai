import { NextRequest, NextResponse } from 'next/server'
import { getStatusWithRetry } from '@/lib/comfy/minimax-h3-client'
import { getExecutionDurationMs } from '@/lib/comfy/progress-tracker'
import { markPendingRunning, markPendingQueued, finalizePendingMeta, clearPendingMeta, cleanupCnrefTempFiles, getPendingCnRefPrefix } from '@/lib/pending-meta'

/**
 * GET /api/comfy/status?prompt_id=...
 * Also drives the server-side metadata writer: marks execution start and
 * finalizes the .meta.json sidecar on completion — works even when no
 * browser tab is alive (the ComfyUI queue keeps generating without it).
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const promptId = searchParams.get('prompt_id')
  if (!promptId) {
    return NextResponse.json({ error: 'prompt_id required' }, { status: 400 })
  }
  try {
    // (fix) Using getStatusWithRetry — automatic retries on
    // network failures (WinError 10054). Previously, a single TCP drop = error.
    const result = await getStatusWithRetry(promptId)
    // Real execution time (from ComfyUI WS events) — single source of truth
    // for the gallery badge AND the .meta.json sidecar.
    if (result.status === 'done') {
      const execMs = getExecutionDurationMs(promptId)
      if (execMs !== null) {
        ;(result as { execution_ms?: number }).execution_ms = execMs
      }
    }
    // Server-side sidecar bookkeeping (never fails the status response)
    try {
      if (result.status === 'running') {
        markPendingRunning(promptId)
      } else if (result.status === 'queued') {
        markPendingQueued(promptId)
      } else if (result.status === 'done') {
        // (fix 716) Read temporary map prefix BEFORE finalization —
        // finalizePendingMeta deletes the pending entry.
        const cnRefPrefix = getPendingCnRefPrefix(promptId)
        await finalizePendingMeta(promptId, result.outputs ?? [], getExecutionDurationMs(promptId))
        // (fix 511) Delete temporary depth/canny maps if job was
        // ControlNet generation (not "Map" mode). "Map" mode saves
        // the map as final output — cleanup is not needed there.
        // .catch is required: without it, a rejected promise is an unhandled
        // rejection, and Node by default terminates the process.
        void cleanupCnrefTempFiles(promptId, cnRefPrefix).catch(() => {})
      } else if (result.status === 'error') {
        const cnRefPrefix = getPendingCnRefPrefix(promptId)
        clearPendingMeta(promptId)
        void cleanupCnrefTempFiles(promptId, cnRefPrefix).catch(() => {})
      }
      // 'unknown' (ComfyUI unavailable) — leave pending-meta untouched
    } catch { /* non-critical */ }
    return NextResponse.json(result)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // (fix 343) On network failure — status:'unknown', NOT 'error':
    // client mistook the shape for a real job error and aborted polling
    // with "failure", even though the task was still running in ComfyUI.
    return NextResponse.json({ status: 'unknown', detail: msg }, { status: 502 })
  }
}
