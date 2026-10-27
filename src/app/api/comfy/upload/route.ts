import { NextRequest, NextResponse } from 'next/server'
import { uploadImage } from '@/lib/comfy/minimax-h3-client'
import { stageFileFromPath } from '@/lib/staging'
import path from 'path'
import os from 'os'
import { createWriteStream, promises as fs } from 'fs'
import { openAsBlob } from 'node:fs'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { getAppConfig } from '@/lib/app-config'
import { probeVideoFile } from '@/lib/video-probe'
import {
  readFirstMultipartPart,
  MultipartParseError,
  type MultipartFilePart,
} from '@/lib/multipart-stream'

/**
 * POST /api/comfy/upload
 * Body: FormData with 'image' field
 *
 * Uploads the file to ComfyUI's input/ directory. When ComfyUI is not
 * reachable, the file is staged locally (.local-input/) and transferred
 * to ComfyUI automatically at generation time — the response carries
 * `staged: true` so the UI can inform the user.
 *
 * (fix 347) Streamed write to disk (temp → openAsBlob in ComfyUI /
 * move to staging) instead of Buffer.from(await file.arrayBuffer()): video
 * references of hundreds of MBs were previously buffered entirely in heap. Size
 * limit matches assistant attachments (MAX_ATTACH_BYTES, 1 GB).
 * (fix 587) Multipart itself is also parsed as a stream (readFirstMultipartPart,
 * same as /api/loras): req.formData() buffered the ENTIRE request body in heap before
 * checking the limit — a gigabyte upload inflated memory before returning 413.
 */
const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024

const UNSAFE_CHARS = /[<>:"/\\|?*\x00-\x1f]/g

export async function POST(req: NextRequest) {
  let tmpPath: string | null = null
  let part: MultipartFilePart | null = null
  try {
    const webBody = req.body
    if (!webBody) {
      return NextResponse.json({ error: 'Empty request body' }, { status: 400 })
    }
    part = await readFirstMultipartPart(webBody, req.headers.get('content-type'))
    if (!part.filename) {
      part.cancel()
      return NextResponse.json({ error: 'No file provided' }, { status: 400 })
    }
    // (fix 347) Basic name sanitization (basename + unsafe characters).
    const safeName = (path.basename(part.filename).replace(UNSAFE_CHARS, '_') || 'upload').slice(0, 200)

    // Streamed write to temporary file with size limit.
    tmpPath = path.join(
      os.tmpdir(),
      `mms-upload-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    )
    let received = 0
    let tooLarge = false
    const limiter = new Transform({
      transform(chunk, _enc, cb) {
        received += (chunk as Buffer).length
        if (received > MAX_UPLOAD_BYTES) {
          tooLarge = true
          cb(new Error('upload-too-large'))
          return
        }
        cb(null, chunk)
      },
    })
    try {
      await pipeline(part.stream, limiter, createWriteStream(tmpPath))
    } catch (e) {
      await fs.unlink(tmpPath).catch(() => {})
      tmpPath = null
      if (tooLarge) {
        part.cancel()
        return NextResponse.json({ error: 'File is too large (1 GB limit)' }, { status: 413 })
      }
      throw e
    }

    // (fix 291) For video files, return durationSec (ffprobe on server)
    // — client (extend-view) immediately knows source duration and displays
    // "total ~X s" in badges/clip cards. Not for images.
    const ext = path.extname(safeName).toLowerCase()
    const isVideo = ['.mp4', '.m4v', '.mov', '.mkv', '.avi', '.webm', '.m2ts',
      '.mts', '.mxf', '.vob', '.wmv', '.flv', '.mpg', '.mpeg', '.ogv'].includes(ext)
    try {
      const blob = await openAsBlob(tmpPath)
      const name = await uploadImage(blob, safeName)
      await fs.unlink(tmpPath).catch(() => {})
      tmpPath = null
      let durationSec: number | undefined
      if (isVideo) {
        try {
          const cfg = getAppConfig()
          const p = path.join(cfg.inputDir, name)
          const pr = await probeVideoFile(p)
          if (Number.isFinite(pr.durationSec) && pr.durationSec > 0) {
            durationSec = Math.round(pr.durationSec * 10) / 10
          }
        } catch { /* ffprobe unavailable — non-critical, UI will handle 0 */ }
      }
      return NextResponse.json({ name, ...(durationSec !== undefined ? { durationSec } : {}) })
    } catch (comfyErr) {
      // ComfyUI unreachable — stage locally instead of failing hard
      try {
        const stagedTmp = tmpPath
        tmpPath = null // ownership transferred to stageFileFromPath (move)
        const name = await stageFileFromPath(stagedTmp!, safeName)
        return NextResponse.json({ name, staged: true })
      } catch {
        const msg = comfyErr instanceof Error ? comfyErr.message : String(comfyErr)
        return NextResponse.json({ error: msg }, { status: 500 })
      }
    }
  } catch (err) {
    if (part) part.cancel()
    if (tmpPath) await fs.unlink(tmpPath).catch(() => {})
    const msg = err instanceof Error ? err.message : String(err)
    const status = err instanceof MultipartParseError ? 400 : 500
    return NextResponse.json({ error: msg }, { status })
  }
}
