import { NextRequest, NextResponse } from 'next/server'
import { promises as fs } from 'fs'
import { createReadStream, createWriteStream, unlinkSync } from 'fs'
import { pipeline } from 'stream/promises'
import path from 'path'
import crypto from 'crypto'
import { getAppConfig } from '@/lib/app-config'
import { sanitizeFolderPath } from '@/lib/gallery-folders' // (fix 495)
import { probeVideoFile } from '@/lib/video-probe'

/**
 * POST /api/extend/import
 * Body: { filename, subfolder? }
 *
 * Copies video FROM COMFYUI COMMON OUTPUT FOLDER into ComfyUI input/ directly on
 * the server (streaming, without browser in the loop) — for the scenario of "drag
 * thumbnail from gallery into extend source".
 *
 * IMPORTANT: extend node (VHS_LoadVideo) and size/frame probe in
 * /api/comfy/generate look up source BY NAME IN input/ folder, so
 * the response returns basename — exactly like uploadImage() for files from disk.
 * (Separate route, not /api/upscale/import: that one writes to data/upscale-input —
 * a path LoadVideo cannot see.)
 *
 * Response: { ok, name, size, kind }.
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 600

const MAX_BYTES = 32 * 1024 ** 3

const VIDEO_EXTS = new Set([
  '.mp4', '.m4v', '.mov', '.mkv', '.avi', '.webm', '.m2ts', '.mts', '.ts',
  '.mxf', '.vob', '.wmv', '.flv', '.mpg', '.mpeg', '.mpe', '.ogv', '.3gp',
  '.3g2', '.asf', '.divx', '.f4v',
])

function sanitizeName(name: string): string {
  const base = path.basename(name).replace(/[\\/:*?"<>|]+/g, '_').trim()
  return base.length > 1 ? base : 'file'
}

export async function POST(req: NextRequest) {
  let destPath = ''
  try {
    const body = (await req.json().catch(() => null)) as
      | { filename?: unknown; subfolder?: unknown }
      | null
    const filename = typeof body?.filename === 'string' ? body.filename.trim() : ''
    const subfolder = typeof body?.subfolder === 'string' ? body.subfolder.trim() : ''
    if (!filename) {
      return NextResponse.json(
        { error: 'Filename not provided (expected { filename, subfolder? })' },
        { status: 400 },
      )
    }

    const cfg = getAppConfig()
    if (!cfg.outputDir) {
      return NextResponse.json(
        { error: 'ComfyUI output folder not found (config.ini → [comfy] comfy_dir)' },
        { status: 500 },
      )
    }

    // Security: basename of name + sanitized relative folder
    // path (fix 495), source must remain inside output.
    const outRoot = path.resolve(cfg.outputDir)
    const safeName = path.basename(filename)
    const safeSub = subfolder ? sanitizeFolderPath(subfolder) : ''
    const src = path.resolve(outRoot, safeSub ? path.join(safeSub, safeName) : safeName)
    if (src !== outRoot && !src.startsWith(outRoot + path.sep)) {
      return NextResponse.json({ error: 'Invalid file path' }, { status: 400 })
    }

    const ext = path.extname(safeName).toLowerCase()
    if (!VIDEO_EXTS.has(ext)) {
      return NextResponse.json(
        { error: `Format ${ext || '(no extension)'} is not supported for video extension` },
        { status: 400 },
      )
    }

    let st
    try {
      st = await fs.stat(src)
    } catch {
      return NextResponse.json(
        { error: 'File not found in common output folder (it might have been deleted)' },
        { status: 404 },
      )
    }
    if (!st.isFile()) {
      return NextResponse.json({ error: 'Not a file' }, { status: 400 })
    }
    if (st.size > MAX_BYTES) {
      return NextResponse.json({ error: `File is larger than 32 GB — too large to process` }, { status: 400 })
    }

    const dir = path.resolve(cfg.inputDir)
    await fs.mkdir(dir, { recursive: true })

    // Unique name without overwrite (as in /api/comfy/refine).
    // (fix 716) extName/stem were computed but never used —
    // dead code. Name is formed via base.
    const base = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${sanitizeName(safeName)}`
    let destName: string
    destPath = path.join(dir, base)
    await pipeline(createReadStream(src), createWriteStream(destPath))
    destName = base

    // (fix 291) Source duration — ffprobe on server so client
    // immediately sees "total ~X s" in badges/clip cards without a separate API.
    // Probe error is non-critical: UI handles durationSec=0/missing.
    let durationSec: number | undefined
    try {
      const pr = await probeVideoFile(destPath)
      if (Number.isFinite(pr.durationSec) && pr.durationSec > 0) {
        durationSec = Math.round(pr.durationSec * 10) / 10
      }
    } catch { /* ffprobe unavailable/non-standard video — do not block import */ }

    return NextResponse.json({
      ok: true,
      name: destName, // basename — expected by VHS_LoadVideo and probe in /api/comfy/generate
      size: st.size,
      kind: 'video',
      ...(durationSec !== undefined ? { durationSec } : {}),
    })
  } catch (err) {
    if (destPath) {
      try { unlinkSync(destPath) } catch { /* ignore */ }
    }
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: `Error importing from gallery: ${msg}` }, { status: 500 })
  }
}
