import { NextResponse } from 'next/server'
import { ensureUpscale } from '@/lib/upscale-runner'

/**
 * (fix 74) POST /api/upscale/start
 * Start the built-in DLSS 5 Visual Enhancer (upscale/bridge.py) and wait until
 * it responds on the port. May take up to ~3 minutes on first start.
 *
 * (fix 77) `?auto=1` — autostart from background status check (not a
 * button click). In this case we respect explicit manual stop by the user
 * (manualStop); explicit "Start" (without parameter) — force=true.
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 240

export async function POST(req: Request) {
  try {
    let auto = false
    try {
      auto = new URL(req.url).searchParams.get('auto') === '1'
    } catch {
      /* redirect/strange url — treat as explicit start */
    }
    const res = await ensureUpscale({ force: !auto })
    return NextResponse.json(
      res.ok ? { ok: true } : { ok: false, error: res.error ?? 'Upscale service failed to start' },
      { status: res.ok ? 200 : 500 },
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}
