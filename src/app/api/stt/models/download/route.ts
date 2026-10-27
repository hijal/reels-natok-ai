import { NextResponse } from 'next/server'
import { createWriteStream, existsSync, mkdirSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import { getAppConfig } from '@/lib/app-config'
import { sttStatus } from '@/lib/stt-runner'
import { stopStt } from '@/lib/stt-runner'

/**
 * (fix 72) STT models: download, progress, cancellation.
 *
 * POST   — start downloading model
 * DELETE — cancel active download
 * GET    — download progress (?name=small)
 *
 * Models are downloaded from HuggingFace (ggerganov/whisper.cpp)
 * to the built-in folder <project>/stt/models/.
 */
export const dynamic = 'force-dynamic'

/* (fix 73) Models are located at the repository root (models/ folder no longer exists —
 * old URLs like .../resolve/main/models/*.bin return 404). */
const HF_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main'

const STT_MODEL_CATALOG: Array<{
  name: string
  file: string
  sizeLabel: string
  quality: string
}> = [
  { name: 'tiny',     file: 'ggml-tiny.bin',     sizeLabel: '~75 MB',  quality: 'fast, low quality' },
  { name: 'base',     file: 'ggml-base.bin',     sizeLabel: '~142 MB', quality: 'medium quality' },
  { name: 'small',    file: 'ggml-small.bin',    sizeLabel: '~466 MB', quality: 'good (recommended)' },
  { name: 'medium',   file: 'ggml-medium.bin',   sizeLabel: '~1.5 GB', quality: 'excellent' },
  { name: 'large-v3', file: 'ggml-large-v3.bin', sizeLabel: '~3.1 GB', quality: 'best, slow' },
]

interface DownloadState {
  name: string
  file: string
  dest: string
  downloaded: number
  total: number
  done: boolean
  error: string | null
  cancelled: boolean
  controller: AbortController
}

const active = new Map<string, DownloadState>()

function destDir(): string {
  const cfg = getAppConfig()
  const dir = join(cfg.sttDir, 'models')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function isAlreadyDownloaded(name: string): boolean {
  const cat = STT_MODEL_CATALOG.find((m) => m.name === name)
  if (!cat) return false
  const dest = join(destDir(), cat.file)
  return existsSync(dest) && statSync(dest).size > 0
}

/* ─── GET /api/stt/models/download?name=small ─── */
export async function GET(request: Request) {
  const url = new URL(request.url)
  const name = (url.searchParams.get('name') || '').trim()
  if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 })

  const st = active.get(name)
  if (st) {
    return NextResponse.json({
      name: st.name,
      active: true,
      downloaded: st.downloaded,
      total: st.total,
      done: st.done,
      error: st.error,
      cancelled: st.cancelled,
    })
  }

  // Not actively downloading — report if file already exists
  const cat = STT_MODEL_CATALOG.find((m) => m.name === name)
  if (cat && isAlreadyDownloaded(name)) {
    const dest = join(destDir(), cat.file)
    return NextResponse.json({
      name,
      active: false,
      downloaded: statSync(dest).size,
      total: statSync(dest).size,
      done: true,
      error: null,
      cancelled: false,
    })
  }

  return NextResponse.json({ name, active: false, downloaded: 0, total: 0, done: false, error: null, cancelled: false })
}

/* ─── POST /api/stt/models/download ─── */
export async function POST(request: Request) {
  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const name = (typeof body.name === 'string' ? body.name : '').trim()
  const cat = STT_MODEL_CATALOG.find((m) => m.name === name)
  if (!cat) {
    return NextResponse.json({ error: `Unknown model: ${name}` }, { status: 400 })
  }

  if (active.has(name)) {
    return NextResponse.json({ ok: true, already: true })
  }

  if (isAlreadyDownloaded(name)) {
    return NextResponse.json({ ok: true, already: true, downloaded: true })
  }

  const dir = destDir()
  const dest = join(dir, cat.file)

  // Stop STT service if running (it may hold the model file open)
  if (sttStatus().running) {
    try { await stopStt() } catch { /* ignore */ }
  }

  const controller = new AbortController()
  const state: DownloadState = {
    name,
    file: cat.file,
    dest,
    downloaded: 0,
    total: 0,
    done: false,
    error: null,
    cancelled: false,
    controller,
  }
  active.set(name, state)

  // Start download in background (fire-and-forget)
  // (fix 716) .catch is required: doDownload is async, and rejecting it
  // without a handler would become an unhandled rejection (Node terminates
  // the process by default). Download state itself writes error — must not lose it.
  void doDownload(state).catch((err) => {
    const message = err instanceof Error ? err.message : String(err)
    state.error = message
    state.done = true
    console.error('[stt-model-download] failed:', message)
  })

  return NextResponse.json({ ok: true, started: true, name })
}

/* ─── DELETE /api/stt/models/download?name=small ─── */
export async function DELETE(request: Request) {
  const url = new URL(request.url)
  const name = (url.searchParams.get('name') || '').trim()
  if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 })

  const st = active.get(name)
  if (!st) return NextResponse.json({ ok: false, error: 'No active download' }, { status: 404 })

  st.cancelled = true
  st.controller.abort()

  return NextResponse.json({ ok: true, cancelled: true })
}

/* ─── Internal: stream download ─── */
async function doDownload(state: DownloadState) {
  const tmpDest = state.dest + '.part'
  try {
    const res = await fetch(`${HF_BASE}/${state.file}`, {
      signal: state.controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'MiniMaxH3Studio/1.0' },
    })
    if (!res.ok) {
      state.error = `HuggingFace ${res.status} ${res.statusText}`
      return
    }

    const contentLength = res.headers.get('content-length')
    if (contentLength) state.total = parseInt(contentLength, 10)

    if (!res.body) {
      state.error = 'Response without body (unsupported environment)'
      return
    }

    const reader = res.body.getReader()
    const out = createWriteStream(tmpDest, { flags: 'w' })

    // (fix 587) 'error'-listener across the ENTIRE write-phase: previously listeners
    // were only attached around out.end() — write errors in the middle of loop
    // (ENOSPC/EPERM on .part file) were emitted with zero listeners and
    // crashed the entire server with an uncaught error. The flag aborts the loop (throw),
    // and controller.abort() cancels fetch and reader in catch below.
    let writeError: Error | null = null
    out.on('error', (err: Error) => {
      writeError = err
    })

    let received = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (state.cancelled) break

      if (value) {
        const b = Buffer.from(value)
        // (fix 347) Backpressure: write() returns false when
        // internal buffer is full — previously chunks kept arriving,
        // and the entire file accumulated in RAM (up to hundreds of MB for ggml models).
        if (!out.write(b)) {
          await new Promise<void>((resolve, reject) => {
            // (fix 587) drain after write error = error, not success
            out.once('drain', () => (writeError ? reject(writeError) : resolve()))
            out.once('error', reject)
          })
        }
        if (writeError) {
          out.destroy()
          throw writeError
        }
        received += b.length
        state.downloaded = received
      }
    }
    if (writeError) {
      out.destroy()
      throw writeError
    }
    out.end()
    await new Promise<void>((resolve, reject) => {
      out.on('finish', resolve)
      out.on('error', reject)
    })

    if (state.cancelled) {
      // Clean up partial file
      try { if (existsSync(tmpDest)) unlinkSync(tmpDest) } catch { /* ignore */ }
      return
    }

    // (fix 347) Verify actual size with content-length BEFORE rename:
    // previously connection abort (fetch without error, just short body)
    // renamed truncated file to "ready" model, and whisper crashed
    // silently upon loading.
    if (state.total && received < state.total) {
      state.error = `Download incomplete: ${received} of ${state.total} bytes — click "Download" again`
      try { if (existsSync(tmpDest)) unlinkSync(tmpDest) } catch { /* ignore */ }
      return
    }

    // Rename .part → final
    const fs = await import('fs')
    fs.renameSync(tmpDest, state.dest)
    state.done = true
    state.downloaded = received
  } catch (err) {
    if (state.cancelled) {
      try { if (existsSync(tmpDest)) unlinkSync(tmpDest) } catch { /* ignore */ }
    } else {
      state.error = err instanceof Error ? err.message : String(err)
      try { if (existsSync(tmpDest)) unlinkSync(tmpDest) } catch { /* ignore */ }
    }
  } finally {
    // Keep state in map for progress queries; clean up after a delay
    setTimeout(() => {
      if (state.done || state.cancelled || state.error) {
        active.delete(state.name)
      }
    }, 60_000) // keep available for 60s after completion
  }
}
