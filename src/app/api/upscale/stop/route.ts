import { NextResponse } from 'next/server'
import { stopUpscale } from '@/lib/upscale-runner'

/**
 * (fix 74) POST /api/upscale/stop — stop the Upscale service
 * (python + Node SSR proxy, entire process tree).
 */
export const dynamic = 'force-dynamic'

export async function POST() {
  try {
    await stopUpscale()
    return NextResponse.json({ ok: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}
