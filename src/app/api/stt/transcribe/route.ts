import { NextResponse } from 'next/server'
import { ensureStt, STT_PORT } from '@/lib/stt-runner'

/**
 * (fix 65) POST /api/stt/transcribe
 * Body: raw WAV (16-bit PCM mono, recorded in browser).
 * Automatically starts the service if needed and proxies to tools/stt_server.py.
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function POST(request: Request) {
  let started: { ok: boolean; error?: string }
  try {
    started = await ensureStt()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
  if (!started.ok) {
    return NextResponse.json(
      { ok: false, error: started.error ?? 'STT service is not running' },
      { status: 503 },
    )
  }

  try {
    // (fix 716) UPPER body limit. Previously only minimum was checked
    // (64 bytes), and arrayBuffer() buffered the entire body and then
    // Buffer.from(body) made a SECOND copy — multi-gigabyte body
    // (or simple client error) consumed Next.js process memory. Limit
    // matches MAX_BODY_BYTES in tools/stt_server.py (48 MB).
    const MAX_UPLOAD_BYTES = 48 * 1024 * 1024
    const declared = Number(request.headers.get('content-length') || 0)
    if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        { ok: false, error: 'Audio file is too large (maximum 48 MB)' },
        { status: 413 },
      )
    }
    const body = await request.arrayBuffer()
    if (!body || body.byteLength < 64) {
      return NextResponse.json(
        { ok: false, error: 'Empty audio recording — nothing recognized' },
        { status: 400 },
      )
    }
    if (body.byteLength > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        { ok: false, error: 'Audio file is too large (maximum 48 MB)' },
        { status: 413 },
      )
    }
    const r = await fetch(`http://127.0.0.1:${STT_PORT}/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.from(body),
      // CPU recognition: 30 seconds of recording on whisper small ≈ up to a minute.
      signal: AbortSignal.timeout(180_000),
    })
    const data = await r.json().catch(() => ({ ok: false, error: 'Invalid response from STT server' }))
    return NextResponse.json(data, { status: r.status })
  } catch (err) {
    const msg =
      err instanceof Error && err.name === 'TimeoutError'
        ? 'Recognition took too long — try a shorter phrase'
        : err instanceof Error ? err.message : String(err)
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}
