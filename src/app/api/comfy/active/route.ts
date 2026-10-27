import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

/**
 * GET /api/comfy/active — active generation state in ComfyUI.
 *
 * (fix 718) Needed for reconciliation at app start: the gen-progress store
 * persists in localStorage and restores the "running" phase on restart —
 * even if generation finished long ago (ComfyUI was restarted, task
 * crashed, computer was rebooted). Without reconciliation, the "Generation in progress" card
 * would hang after every app launch.
 *
 * Query:
 *   ?check=id1,id2 — prompt_ids whose state needs verification
 *                     (not in queue, but still alive in history).
 *
 * Response:
 *   {
 *     ok: true,          // ComfyUI responded — safe to reconcile
 *     active: boolean,   // whether there are active generations at all
 *     prompts: string[], // prompt_ids in queue_running + queue_pending
 *     states: { [id]: 'alive' | 'done' | 'gone' }
 *   }
 *   { ok: false, active: false, prompts: [], states: {} }
 *                      // ComfyUI unavailable (still booting): CANNOT reconcile,
 *                        // client must not reset state.
 */
export async function GET(req: Request) {
  const COMFY_URL = process.env.COMFY_URL || 'http://127.0.0.1:8188'
  const url = new URL(req.url)
  const check = (url.searchParams.get('check') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 20)

  try {
    const res = await fetch(`${COMFY_URL}/queue`, {
      signal: AbortSignal.timeout(8000),
      cache: 'no-store',
    })
    if (!res.ok) {
      return NextResponse.json({ ok: false, active: false, prompts: [], states: {} })
    }
    const q = (await res.json()) as {
      queue_running?: unknown[]
      queue_pending?: unknown[]
    }
    // ComfyUI queue format: [[number, prompt_id, prompt, ...], ...]
    // (item[0] is the index in queue, item[1] is prompt_id). Just in case,
    // object format is also supported.
    const idOf = (p: unknown): string => {
      if (Array.isArray(p)) return String(p[1] ?? '')
      if (p && typeof p === 'object') {
        const v = (p as { prompt_id?: unknown }).prompt_id
        return typeof v === 'string' ? v : ''
      }
      return ''
    }
    const prompts = [...(q.queue_running ?? []), ...(q.queue_pending ?? [])]
      .map(idOf)
      .filter(Boolean)
    const alive = new Set(prompts)

    // For prompts not in queue, check whether ComfyUI knows about them
    // at all (history) — otherwise we cannot distinguish "just finished" from
    // "ComfyUI was restarted, task does not exist".
    const states: Record<string, 'alive' | 'done' | 'gone'> = {}
    for (const id of check) {
      if (alive.has(id)) {
        states[id] = 'alive'
        continue
      }
      states[id] = (await isKnownToComfy(COMFY_URL, id)) ? 'done' : 'gone'
    }

    return NextResponse.json({ ok: true, active: prompts.length > 0, prompts, states })
  } catch {
    // ComfyUI is still starting or crashed — do NOT assert that there are no generations.
    return NextResponse.json({ ok: false, active: false, prompts: [], states: {} })
  }
}

/** Does ComfyUI know about this prompt_id (entry in history)? */
async function isKnownToComfy(comfyUrl: string, promptId: string): Promise<boolean> {
  try {
    const res = await fetch(`${comfyUrl}/history/${encodeURIComponent(promptId)}`, {
      signal: AbortSignal.timeout(8000),
      cache: 'no-store',
    })
    if (!res.ok) return false
    const hist = (await res.json()) as Record<string, unknown>
    return !!hist && Object.keys(hist).length > 0
  } catch {
    return false
  }
}
