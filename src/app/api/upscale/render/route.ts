import { NextRequest, NextResponse } from 'next/server'
import path from 'path'
import { ensureUpscale, fetchUpscaleHealth, bridgeUrl } from '@/lib/upscale-runner'
import { isPathInsideRoots } from '@/lib/local-file'
import { upscaleAllowedRoots } from '@/lib/upscale-paths'

/**
 * (fix 74) POST /api/upscale/render
 * Body: {feature: "nr-image"|"nr-video"|"vsr-image"|"vsr-video",
 *        input: "<absolute path>", options: {...}}
 * Starts the bridge (if needed), waits for runtime readiness
 * (GPU/DLL preparation — up to ~2 minutes) and creates a job.
 * 409 — GPU is busy with another render.
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as {
      feature?: string
      input?: string
      options?: Record<string, unknown>
    } | null
    const feature = body?.feature
    const input = body?.input
    const options = body?.options ?? {}
    if (!feature || !input) {
      return NextResponse.json({ error: 'feature and input are required' }, { status: 400 })
    }
    // (fix 716) feature is checked against the allow-list, input — against
    // allowed roots. Previously an arbitrary absolute path was sent to the Python bridge,
    // which opened/processed ANY file on disk (unlike /api/upscale/file,
    // which verified roots).
    const ALLOWED_FEATURES = new Set(['nr-image', 'nr-video', 'vsr-image', 'vsr-video', 'fi-video'])
    if (!ALLOWED_FEATURES.has(feature)) {
      return NextResponse.json(
        { error: `Unknown feature: ${feature}. Available: ${[...ALLOWED_FEATURES].join(', ')}` },
        { status: 400 },
      )
    }
    if (!isPathInsideRoots(path.resolve(input), upscaleAllowedRoots())) {
      return NextResponse.json(
        { error: 'Path outside allowed folders (output and/or uploads)' },
        { status: 400 },
      )
    }

    // 1) Is the service running?
    // (fix 346) Render is an explicit user action: force, otherwise after
    // manual service stop the "Upscale" button would silently fail with error
    // "stopped by user".
    const start = await ensureUpscale({ force: true })
    if (!start.ok) {
      return NextResponse.json({ ok: false, error: start.error ?? 'Upscale service failed to start' }, { status: 500 })
    }

    // 2) Is runtime ready (prepare_runtime + GPU)?
    const deadline = Date.now() + 120_000
    let health: Awaited<ReturnType<typeof fetchUpscaleHealth>> | null = null
    while (Date.now() < deadline) {
      try {
        health = await fetchUpscaleHealth(3000)
        if (health.ready) break
        if (health.error) break // permanent error (no RTX-GPU, etc.)
      } catch {
        /* bridge is still starting up — keep polling */
      }
      await new Promise((r) => setTimeout(r, 1000))
    }
    if (!health?.ready) {
      const err = health?.error || 'DLSS runtime is not ready. NVIDIA RTX (20/30/40/50) with an up-to-date driver is required.'
      return NextResponse.json({ ok: false, error: err }, { status: 500 })
    }

    // 3) Create job.
    const r = await fetch(bridgeUrl('/render'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feature, input, options }),
      signal: AbortSignal.timeout(20_000),
    })
    const data = (await r.json().catch(() => ({}))) as { jobId?: string; error?: string }
    if (r.status === 409) {
      return NextResponse.json({ ok: false, busy: true, error: data.error ?? 'GPU is busy' }, { status: 409 })
    }
    if (!r.ok) {
      return NextResponse.json({ ok: false, error: data.error ?? `bridge /render → ${r.status}` }, { status: 500 })
    }
    return NextResponse.json({ ok: true, jobId: data.jobId })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}
