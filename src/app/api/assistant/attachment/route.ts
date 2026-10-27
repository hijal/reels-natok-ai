import { NextRequest, NextResponse } from 'next/server'
import { promises as fs, createWriteStream } from 'fs'
import { basename, extname, join, resolve } from 'path'
import { Transform } from 'stream'
import { pipeline } from 'stream/promises'
import { serveLocalFile } from '@/lib/local-file'
import {
  readFirstMultipartPart,
  MultipartParseError,
  type MultipartFilePart,
} from '@/lib/multipart-stream'

/**
 * (fix 108) Assistant chat attachments — ISOLATED storage.
 *
 * Images/videos attached in chat exist ONLY in chat and are needed
 * ONLY for description generation (multimodal LLM). They must NOT:
 *   • reside in ComfyUI/input/ (shared generation references folder);
 *   • enter generation references (<Picture N>/<Video N>);
 *   • appear in gallery / upscale / "cleanup input".
 *
 * Therefore, they live in a dedicated project folder <project>/data/chat-attachments/
 * (portable alongside data/assistant-chats.json) and are served by this route.
 *
 *   POST   /api/assistant/attachment          — upload (FormData: file)
 *   GET    /api/assistant/attachment?filename — serve (Range-capable)
 *   DELETE /api/assistant/attachment?filename — delete (when deleting chat)
 */
export const dynamic = 'force-dynamic'

const ATTACH_DIR = resolve(process.cwd(), 'data', 'chat-attachments')

// Attachment limit: previously file was buffered entirely without limit, and
// gigabyte video could crash the entire Node process (along with generations).
// 1 GB is sufficient for any LLM references.
const MAX_ATTACH_BYTES = 1024 * 1024 * 1024

/** Unsafe filename characters — replace with '_' (any OS). */
const UNSAFE = /[<>:"/\\|?*\x00-\x1f]/g

/** Keep only image/video extensions (everything else is meaningless for the LLM). */
function allowedExt(ext: string): string | null {
  const e = ext.toLowerCase()
  if (
    e === '.png' || e === '.jpg' || e === '.jpeg' || e === '.webp' ||
    e === '.gif' || e === '.bmp' || e === '.avif' ||
    e === '.mp4' || e === '.m4v' || e === '.webm' || e === '.mov' || e === '.mkv'
  ) return e
  return null
}

/** Traversal-safe resolution inside ATTACH_DIR. null = invalid/missing. */
async function safeAttachPath(filename: string): Promise<string | null> {
  const name = basename(filename)
  if (!name || name === '.' || name === '..') return null
  const target = resolve(ATTACH_DIR, name)
  if (!target.startsWith(ATTACH_DIR)) return null
  try {
    const st = await fs.stat(target)
    if (!st.isFile()) return null
  } catch {
    return null
  }
  return target
}

/* ─── POST: upload ─── */
export async function POST(req: NextRequest) {
  let part: MultipartFilePart | null = null
  try {
    const webBody = req.body
    if (!webBody) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 })
    }
    // (fix 587) Streaming multipart parsing (like /api/loras): req.formData()
    // buffered the ENTIRE body in heap before checks — a gigabyte attachment bloated
    // memory before returning 413. Filename comes in part headers BEFORE bytes.
    part = await readFirstMultipartPart(webBody, req.headers.get('content-type'))
    if (!part.filename) {
      part.cancel()
      return NextResponse.json({ error: 'No file provided' }, { status: 400 })
    }
    const ext = allowedExt(extname(part.filename))
    if (!ext) {
      part.cancel()
      return NextResponse.json(
        { error: 'Only images and videos are supported (png, jpg, webp, gif, mp4, webm, mov…)' },
        { status: 400 },
      )
    }
    await fs.mkdir(ATTACH_DIR, { recursive: true })
    const safeBase = basename(part.filename).replace(UNSAFE, '_') || 'attachment'
    const unique = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${safeBase}`
    const dest = join(ATTACH_DIR, unique)
    // (fix 350) Stream write instead of Buffer.from(arrayBuffer): files
    // up to 1 GB previously were buffered entirely into Node heap (pressuring
    // already tight memory next to ComfyUI). (fix 587) Limit enforced ONLY
    // here, on the fly (file.size from formData is no longer available) — when
    // exceeded, stream is aborted, partial file is deleted.
    let bytes = 0
    let tooLarge = false
    const guard = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        bytes += chunk.length
        if (bytes > MAX_ATTACH_BYTES) {
          tooLarge = true
          cb(new Error('attachment too large'))
        } else cb(null, chunk)
      },
    })
    try {
      await pipeline(part.stream, guard, createWriteStream(dest))
    } catch (pipeErr) {
      part.cancel()
      await fs.unlink(dest).catch(() => {})
      if (tooLarge) {
        return NextResponse.json(
          { error: 'File is too large (1 GB limit). Reduce video size before attaching.' },
          { status: 413 },
        )
      }
      throw pipeErr
    }
    return NextResponse.json({ name: unique })
  } catch (err) {
    if (part) part.cancel()
    const msg = err instanceof Error ? err.message : String(err)
    const status = err instanceof MultipartParseError ? 400 : 500
    return NextResponse.json({ error: `Upload failed: ${msg}` }, { status })
  }
}

/* ─── GET: serve (Range-capable for video seeking) ─── */
export async function GET(req: NextRequest) {
  const filename = req.nextUrl.searchParams.get('filename')
  if (!filename) {
    return new Response('Missing filename', { status: 400 })
  }
  const source = await safeAttachPath(filename)
  if (!source) {
    return new Response('Attachment not found', { status: 404 })
  }
  const local = await serveLocalFile(req, filename, source)
  if (local) return local
  return new Response('Failed to serve attachment', { status: 500 })
}

/* ─── DELETE: remove (best-effort, called when a chat is deleted) ─── */
export async function DELETE(req: NextRequest) {
  const filename = req.nextUrl.searchParams.get('filename')
  if (!filename) {
    return NextResponse.json({ error: 'Missing filename' }, { status: 400 })
  }
  const source = await safeAttachPath(filename)
  if (!source) {
    return NextResponse.json({ deleted: false, reason: 'not found' })
  }
  try {
    await fs.unlink(source)
    return NextResponse.json({ deleted: true })
  } catch {
    return NextResponse.json({ deleted: false })
  }
}
