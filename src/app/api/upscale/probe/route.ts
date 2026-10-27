import { NextRequest, NextResponse } from 'next/server'
import path from 'path'
import { bridgeUrl, ensureUpscale } from '@/lib/upscale-runner'
import { isPathInsideRoots } from '@/lib/local-file'
import { upscaleAllowedRoots } from '@/lib/upscale-paths'

/**
 * (fix 74) POST /api/upscale/probe
 * Body: {input: "<absolute path>"}
 * Media metadata (resolution, FPS, duration, HDR, codec) for the uploaded
 * file card. Starts the bridge if necessary.
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 120

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as { input?: string } | null
    const input = body?.input
    if (!input) {
      return NextResponse.json({ error: 'File (input) is not specified' }, { status: 400 })
    }
    // (fix 716) Path is checked against allowed roots: otherwise /probe
    // disclosed metadata (size, resolution, codec, duration) of any
    // local file at an arbitrary path.
    if (!isPathInsideRoots(path.resolve(input), upscaleAllowedRoots())) {
      return NextResponse.json(
        { error: 'Path outside allowed folders (output and/or uploads)' },
        { status: 400 },
      )
    }

    // (fix 346) Probe is an explicit user action (uploaded file):
    // force, same as render.
    const start = await ensureUpscale({ force: true })
    if (!start.ok) {
      return NextResponse.json({ ok: false, error: start.error ?? 'Upscale service failed to start' }, { status: 500 })
    }
    const r = await fetch(bridgeUrl('/probe'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input }),
      signal: AbortSignal.timeout(30_000),
    })
    const data = (await r.json().catch(() => ({}))) as { error?: string } & Record<string, unknown>
    if (!r.ok) {
      return NextResponse.json({ error: data.error ?? `probe → ${r.status}` }, { status: r.status >= 400 && r.status < 500 ? r.status : 500 })
    }
    return NextResponse.json(data)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
