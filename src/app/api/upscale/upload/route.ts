import { NextRequest, NextResponse } from 'next/server'
import { createWriteStream, mkdirSync, renameSync, unlinkSync } from 'fs'
import path from 'path'
import crypto from 'crypto'

/**
 * (fix 74) POST /api/upscale/upload
 * FormData field `file` → stream to data/upscale-input/<ts>-<name>.
 * Video/photo for Upscale tab (DLSS bridge). 32 GB limit.
 *
 * IMPORTANT: req.formData() buffers the ENTIRE file in memory (undici collects
 * multipart into a Blob in RAM) — for gigabyte videos this causes an OOM for the whole server.
 * Therefore the request body is parsed as a stream: the file is written to disk in chunks,
 * size limit is checked on the fly.
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 600

const MAX_UPLOAD_BYTES = 32 * 1024 ** 3

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

/** boundary from Content-Type: multipart/form-data; boundary=... */
function getBoundary(contentType: string | null): string | null {
  if (!contentType) return null
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)
  const b = (m?.[1] ?? m?.[2] ?? '').trim()
  return b || null
}

/** filename from content-disposition part headers. */
function parseFileName(headers: string): string | null {
  const cd = headers
    .split(/\r?\n/)
    .find((l) => /^content-disposition\s*:/i.test(l))
  if (!cd) return null
  const m = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(cd)
  if (!m) return null
  const name = m[1].replace(/\\(.)/g, '$1').trim()
  return name || null
}

interface UploadedFile {
  fileName: string
  size: number
}

/** Validation error (client-side) — return as 400, not 500. */
class UploadError extends Error {}

/**
 * Streaming parser for multipart/form-data: finds part with filename and writes its
 * body to `dest` via factory write stream without keeping request body
 * in memory. Other parts (fields without filename) are skipped.
 * Throws an error on exceeding MAX_UPLOAD_BYTES — file is cleaned up by the caller.
 */
async function streamMultipartFile(
  req: NextRequest,
  dest: string,
): Promise<UploadedFile> {
  const boundary = getBoundary(req.headers.get('content-type'))
  if (!boundary) throw new Error('multipart/form-data with boundary expected')
  if (!req.body) throw new Error('Empty request body')

  const delim = Buffer.from(`\r\n--${boundary}`)
  // Virtual leading CRLF: the very first "--boundary" at the start of the body
  // matches the same delimiter as all subsequent ones.
  let carry = Buffer.from('\r\n')
  let phase: 'preamble' | 'headers' | 'body' | 'done' = 'preamble'
  let fileName: string | null = null
  let fileBytes = 0
  let sawFile = false

  const out = createWriteStream(dest)
  // (fix 587) 'error' listener on the write stream is required: ENOSPC/EPERM
  // in the middle of writing emitted 'error' with ZERO listeners → uncaught exception
  // crashed the whole server (out.write() callbacks are not considered listeners).
  // The error is recorded in streamError and fails the nearest flush/end,
  // while the partial file is cleaned up by the existing rollback path (out.destroy + unlink).
  let streamError: Error | null = null
  out.on('error', (err: Error) => {
    streamError = err
  })
  const reader = req.body.getReader()
  const flush = (chunk: Buffer) =>
    new Promise<void>((resolve, reject) => {
      if (streamError) return reject(streamError)
      out.write(chunk, (err) => (err ? reject(err) : resolve()))
    })

  try {
    readLoop: for (;;) {
      // ── parse accumulated buffer by phases ──
      // ("done" does not reach here: setting phase to done is always accompanied
      // by break readLoop below)
      for (;;) {
        if (phase === 'preamble') {
          const i = carry.indexOf(delim)
          if (i < 0) {
            // keep tail of length delim-1: delimiter might be split across chunk boundary
            if (carry.length > delim.length - 1) {
              carry = carry.subarray(carry.length - (delim.length - 1))
            }
            break
          }
          carry = carry.subarray(i + delim.length)
          // after delimiter: "--" = final, otherwise "\r\n" + part headers
          if (carry.subarray(0, 2).toString() === '--') {
            phase = 'done'
            break readLoop
          }
          if (carry.subarray(0, 2).toString() === '\r\n') carry = carry.subarray(2)
          phase = 'headers'
        }

        if (phase === 'headers') {
          const i = carry.indexOf('\r\n\r\n')
          if (i < 0) break // wait for more data
          const headers = carry.subarray(0, i).toString('utf8')
          carry = carry.subarray(i + 4)
          fileName = parseFileName(headers)
          phase = 'body'
        }

        if (phase === 'body') {
          const i = carry.indexOf(delim)
          if (i < 0) {
            // delimiter not found: everything except potential tail is part body
            const keep = delim.length - 1
            if (carry.length > keep) {
              const chunk = carry.subarray(0, carry.length - keep)
              if (fileName) {
                fileBytes += chunk.length
                if (fileBytes > MAX_UPLOAD_BYTES) {
                  throw new UploadError('File is larger than 32 GB — too large to process')
                }
                await flush(chunk)
              }
              carry = carry.subarray(carry.length - keep)
            }
            break
          }
          const chunk = carry.subarray(0, i)
          if (fileName) {
            fileBytes += chunk.length
            if (fileBytes > MAX_UPLOAD_BYTES) {
              throw new UploadError('File is larger than 32 GB — too large to process')
            }
            await flush(chunk)
            sawFile = true
          }
          carry = carry.subarray(i + delim.length)
          if (carry.subarray(0, 2).toString() === '--') {
            phase = 'done'
            break readLoop
          }
          if (carry.subarray(0, 2).toString() === '\r\n') carry = carry.subarray(2)
          phase = 'headers'
        }
      }

      const { done, value } = await reader.read()
      if (done) break
      carry = Buffer.concat([carry, Buffer.from(value)])
    }

    if (!sawFile || !fileName) {
      throw new UploadError('File not provided (expected field "file")')
    }
    // (fix 587) Stream error could arrive between writes (not in
    // write callback) — check flag before end as well.
    if (streamError) throw streamError
    await new Promise<void>((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())))
    return { fileName, size: fileBytes }
  } catch (err) {
    out.destroy()
    void reader.cancel().catch(() => {})
    throw err
  }
}

export async function POST(req: NextRequest) {
  let destPath = ''
  try {
    const dir = path.join(process.cwd(), 'data', 'upscale-input')
    mkdirSync(dir, { recursive: true })
    destPath = path.join(dir, `part-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`)

    const uploaded = await streamMultipartFile(req, destPath)

    const ext = path.extname(uploaded.fileName).toLowerCase()
    if (!IMAGE_EXTS.has(ext) && !VIDEO_EXTS.has(ext)) {
      throw new UploadError(
        `Format ${ext || '(no extension)'} is not supported. Supported: images (PNG, JPEG, WebP, AVIF, RAW…) and videos (MP4, MOV, MKV, AVI…).`,
      )
    }
    if (uploaded.size > MAX_UPLOAD_BYTES) {
      throw new UploadError('File is larger than 32 GB — too large to process')
    }

    const finalName = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${sanitizeName(uploaded.fileName)}`
    const finalPath = path.join(dir, finalName)
    renameSync(destPath, finalPath)
    destPath = finalPath

    return NextResponse.json({
      ok: true,
      path: finalPath,
      name: uploaded.fileName,
      size: uploaded.size,
      kind: IMAGE_EXTS.has(ext) ? 'image' : 'video',
    })
  } catch (err) {
    if (destPath) {
      try { unlinkSync(destPath) } catch { /* ignore */ }
    }
    const msg = err instanceof Error ? err.message : String(err)
    const status = err instanceof UploadError ? 400 : 500
    return NextResponse.json({ error: `Upload error: ${msg}` }, { status })
  }
}
