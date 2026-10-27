import { NextResponse } from 'next/server'
import { bridgeUrl } from '@/lib/upscale-runner'

/**
 * (fix 74) GET /api/upscale/schema
 * DLSS bridge feature catalog proxy (defaults + choices) for native UI.
 */
export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const r = await fetch(bridgeUrl('/schema'), { signal: AbortSignal.timeout(8000) })
    if (!r.ok) {
      const data = (await r.json().catch(() => ({}))) as { error?: string }
      return NextResponse.json({ error: data.error ?? `bridge /schema → ${r.status}` }, { status: 502 })
    }
    return NextResponse.json(await r.json())
  } catch {
    return NextResponse.json({ error: 'Upscale service is not responding (bridge is not running)' }, { status: 503 })
  }
}
