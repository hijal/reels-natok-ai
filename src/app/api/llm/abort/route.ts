import { NextRequest, NextResponse } from 'next/server'
import { LLM_PORT, llmStatus, llmBackend } from '@/lib/llm-runner'

export const dynamic = 'force-dynamic'

/**
 * POST /api/llm/abort — stop the current LLM generation (best effort).
 *
 * (fix 717) Accepts request_id (query or body) and forwards it:
 * abort must hit exactly the generation that was stopped. Without
 * addressing, "Stop" could abort the NEXT request (abort arrived
 * later than new /chat).
 */
export async function POST(req: NextRequest) {
  const backend = llmBackend()
  let aborted = false
  let requestId: string | null = null
  try {
    const url = new URL(req.url)
    const q = url.searchParams.get('request_id')
    if (q) requestId = q
    if (!requestId) {
      const body = (await req.json().catch(() => null)) as { request_id?: unknown } | null
      if (body && typeof body.request_id === 'string' && body.request_id) {
        requestId = body.request_id
      }
    }
  } catch {
    /* no id — abort current generation (legacy mode) */
  }
  // (fix 351) Bonsai backend (prism llama-server) has no /abort endpoint —
  // the request returned 404 and logged an error. For bonsai we send nothing and
  // honestly report aborted:false to client: server generation continues,
  // only local stream (client-side SSE read) is aborted.
  if (backend !== 'bonsai') {
    // (fix 587) Previously aborted=true was set unconditionally — even when
    // the /abort request didn't reach the server (ECONNREFUSED swallowed by
    // .catch(() => {})), and client considered generation stopped.
    try {
      const r = await fetch(`http://127.0.0.1:${LLM_PORT}/abort`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestId ? { request_id: requestId } : {}),
      })
      aborted = r.ok
    } catch {
      /* runner not up — nothing to abort */
    }
  }
  return NextResponse.json({ ok: true, aborted, backend, requestId, ...llmStatus() })
}
