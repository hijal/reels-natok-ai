import { NextRequest, NextResponse } from 'next/server'
import { createReadStream, createWriteStream, mkdirSync, unlinkSync } from 'fs'
import { promises as fs } from 'fs'
import { pipeline } from 'stream/promises'
import path from 'path'
import crypto from 'crypto'
import { getAppConfig } from '@/lib/app-config'
import { sanitizeFolderPath } from '@/lib/gallery-folders' // (fix 495)

/**
 * POST /api/upscale/import
 * Body: { filename, subfolder? }
 *
 * Copies video FROM COMFYUI SHARED OUTPUT FOLDER to data/upscale-input
 * directly on the server (streaming, without browser in the loop) — for the
 * "send preview from gallery to upscale" workflow. The video can be
 * gigabytes — transferring it via fetch/blob in the browser is not viable.
 *
 * Response — same format as /api/upscale/upload:
 * { ok, path, name, size, kind }.
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 600

const MAX_BYTES = 32 * 1024 ** 3

// (fix 349) Images are allowed, as in /api/upscale/upload — the bridge
// supports nr-image/vsr-image, otherwise an image from gallery could not be sent
// to upscale (only via manual upload).
const IMAGE_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.avif', '.avifs', '.tiff', '.tif',
  '.heic', '.heif', '.bmp', '.gif',
])
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
        { error: 'File name not provided (expected { filename, subfolder? })' },
        { status: 400 },
      )
    }

    const OUTPUT_DIR = getAppConfig().outputDir
    if (!OUTPUT_DIR) {
      return NextResponse.json(
        { error: 'ComfyUI output folder not found (config.ini → [comfy] comfy_dir)' },
        { status: 500 },
      )
    }

    // Security: name basename + sanitized relative folder path
    // (fix 495), result must stay inside output.
    const outRoot = path.resolve(OUTPUT_DIR)
    const safeName = path.basename(filename)
    const safeSub = subfolder ? sanitizeFolderPath(subfolder) : ''
    const src = path.resolve(outRoot, safeSub ? path.join(safeSub, safeName) : safeName)
    if (src !== outRoot && !src.startsWith(outRoot + path.sep)) {
      return NextResponse.json({ error: 'Invalid file path' }, { status: 400 })
    }

    const ext = path.extname(safeName).toLowerCase()
    const isImage = IMAGE_EXTS.has(ext)
    if (!VIDEO_EXTS.has(ext) && !isImage) {
      return NextResponse.json(
        { error: `Format ${ext || '(no extension)'} is not supported for upscale` },
        { status: 400 },
      )
    }

    let st
    try {
      st = await fs.stat(src)
    } catch {
      return NextResponse.json(
        { error: 'File not found in shared output folder (it may have been deleted)' },
        { status: 404 },
      )
    }
    if (!st.isFile()) {
      return NextResponse.json({ error: 'Not a file' }, { status: 400 })
    }
    if (st.size > MAX_BYTES) {
      return NextResponse.json({ error: `File is larger than 32 GB — too large to process` }, { status: 400 })
    }

    const dir = path.join(process.cwd(), 'data', 'upscale-input')
    mkdirSync(dir, { recursive: true })
    const name = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${sanitizeName(safeName)}`
    destPath = path.join(dir, name)

    // Disk streaming — memory is not touched.
    await pipeline(createReadStream(src), createWriteStream(destPath))

    return NextResponse.json({
      ok: true,
      path: destPath,
      name: safeName,
      size: st.size,
      kind: isImage ? 'image' : 'video',
      // (fix 727) Source folder in gallery — upscale result
      // will be saved there as well, not in output root.
      subfolder: safeSub,
    })
  } catch (err) {
    if (destPath) {
      try { unlinkSync(destPath) } catch { /* ignore */ }
    }
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: `Gallery import error: ${msg}` }, { status: 500 })
  }
}
