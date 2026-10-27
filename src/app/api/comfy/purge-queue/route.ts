import { NextResponse } from 'next/server'
import { clearInflight } from '@/lib/inflight-journal'

export const dynamic = 'force-dynamic'

/**
 * POST /api/comfy/purge-queue — (fix 692) complete reset of ComfyUI queue
 * + inflight journal. Called on factory reset to delete stale
 * queued prompts (WinError 2: 'E:\000\diffusion_models') and old entries
 * clientToken → prompt_id.
 *
 * Does not require GPU: only HTTP requests to ComfyUI /queue (no generation).
 */
export async function POST() {
  const results: { inflightCleared: boolean; queueCleared: boolean; error?: string } = {
    inflightCleared: false,
    queueCleared: false,
  }

  // 1) Clear inflight journal (stale clientToken records)
  try {
    clearInflight()
    results.inflightCleared = true
  } catch (e) {
    results.error = `inflight: ${e instanceof Error ? e.message : String(e)}`
  }

  // 2) Purge ComfyUI queue (stale queued prompts)
  //    First GET /queue to fetch all pending prompt_ids,
  //    then POST /queue {delete: [...]} for each.
  try {
    const COMFY_URL = process.env.COMFY_URL || 'http://127.0.0.1:8188'
    // Fetch all pending tasks
    const qRes = await fetch(`${COMFY_URL}/queue`, { signal: AbortSignal.timeout(5000) })
    if (qRes.ok) {
      const q = await qRes.json()
      // (fix 716) ComfyUI queue format: [[number, prompt_id, prompt, ...], ...]
      // → item[0] is the index in queue, item[1] is prompt_id.
      // Previously p[0] was used, i.e. queue indices: POST /queue {delete:[...]} with
      // such values deleted NOTHING, while the route reported success.
      const promptIdOf = (p: unknown): string => {
        if (Array.isArray(p)) return String(p[1] ?? '')
        if (p && typeof p === 'object') return String((p as Record<string, unknown>).prompt_id ?? '')
        return ''
      }
      const pendingIds: string[] = (q.queue_pending ?? []).map(promptIdOf)
      const runningIds: string[] = (q.queue_running ?? []).map(promptIdOf)
      const allIds = [...new Set([...runningIds, ...pendingIds].filter(Boolean))]

      // Cancel running (interrupt) + remove all from queue
      if (runningIds.length > 0) {
        await fetch(`${COMFY_URL}/interrupt`, { method: 'POST', signal: AbortSignal.timeout(5000) }).catch(() => {})
      }
      if (allIds.length > 0) {
        const delRes = await fetch(`${COMFY_URL}/queue`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ delete: allIds }),
          signal: AbortSignal.timeout(5000),
        })
        // (fix 716) Previously deletion errors were swallowed by catch(() => {}), and
        // queueCleared was still set to true — reporting success
        // to caller on failure.
        if (!delRes.ok) {
          results.error = `queue delete: HTTP ${delRes.status}`
        }
      }
      results.queueCleared = true
    }
  } catch (e) {
    // ComfyUI unavailable — this is normal (it may not be running).
    // Inflight journal is already cleared.
    if (!results.error) {
      results.error = `queue: ${e instanceof Error ? e.message : String(e)}`
    }
  }

  return NextResponse.json(results)
}
