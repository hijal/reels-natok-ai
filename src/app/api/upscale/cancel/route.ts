import { NextRequest, NextResponse } from 'next/server'
import { bridgeUrl } from '@/lib/upscale-runner'

/**
 * (fix 74) POST /api/upscale/cancel?id=<jobId>
 * Cancel active render (bridge sends request to pipeline JobController).
 */
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const id = new URL(req.url).searchParams.get('id')
  if (!id) {
    return NextResponse.json({ error: 'id is required' }, { status: 400 })
  }
  try {
    const r = await fetch(bridgeUrl(`/jobs/${encodeURIComponent(id)}/cancel`), {
      method: 'POST',
      signal: AbortSignal.timeout(8000),
    })
    const data = (await r.json().catch(() => ({}))) as { ok?: boolean; message?: string; error?: string }
    if (!r.ok) {
      return NextResponse.json({ error: data.error ?? 'Failed to send cancellation' }, { status: 500 })
    }
    return NextResponse.json({ ok: true, message: data.message ?? 'Cancellation sent' })
  } catch {
    return NextResponse.json({ error: 'Upscale service is not responding' }, { status: 503 })
  }
}
