import { NextRequest, NextResponse } from 'next/server'
import path from 'path'
import { fetchUpscaleHealth, bridgeUrl } from '@/lib/upscale-runner'
import { ensureUpscaleMeta } from '@/lib/upscale-meta'

/**
 * (fix 74) GET /api/upscale/job?id=<jobId>
 * Bridge job status + downloadUrl for result (if ready).
 *
 * (fix 94) On 'done' status write a .meta.json sidecar next to
 * the result (resolution/duration/fps/size — via ffprobe),
 * so that gallery upscale videos also support "file info".
 * Idempotent and fire-and-forget — status polling does not wait for ffprobe.
 */
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const id = new URL(req.url).searchParams.get('id')
  if (!id) {
    return NextResponse.json({ error: 'id is required' }, { status: 400 })
  }
  try {
    const r = await fetch(bridgeUrl(`/jobs/${encodeURIComponent(id)}`), {
      signal: AbortSignal.timeout(8000),
    })
    const data = (await r.json().catch(() => ({}))) as {
      status?: string
      progress?: number
      message?: string
      error?: string
      output?: { output_path?: string }
    }
    if (!r.ok) {
      return NextResponse.json({ error: data.error ?? 'Job not found (the service may have been restarted)' }, { status: 404 })
    }
    const outPath = data.output?.output_path
    // (fix 94) Result is ready — ensure metadata sidecar.
    if (data.status === 'done' && outPath) {
      const sourceHint = (data.output as Record<string, unknown>)?.input ?? (data.output as Record<string, unknown>)?.input_path
      void ensureUpscaleMeta(outPath, id, sourceHint).catch(() => {})
    }
    const payload: Record<string, unknown> = {
      id,
      status: data.status,
      progress: data.progress ?? 0,
      message: data.message,
      error: data.error ?? null,
      output: data.output ?? null,
    }
    if (outPath) {
      payload.downloadUrl = `/api/upscale/file?path=${encodeURIComponent(outPath)}`
      payload.downloadName = path.basename(outPath)
    }
    return NextResponse.json(payload)
  } catch {
    // Bridge is not responding — service might have died during render.
    let hint = ''
    try {
      const h = await fetchUpscaleHealth(1500)
      if (!h.ready && h.error) hint = ` (${h.error})`
    } catch {
      hint = ' (Upscale service is not responding)'
    }
    return NextResponse.json({ error: `Failed to get job status${hint}` }, { status: 503 })
  }
}
