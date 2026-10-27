import { NextResponse, NextRequest } from 'next/server'
import { readdirSync, mkdirSync, existsSync, renameSync, unlinkSync, createWriteStream, statSync } from 'fs'
import { basename, join } from 'path'
import { getAppConfig } from '@/lib/app-config'
import { listExternalModels } from '@/lib/extra-model-paths'
import {
  readFirstMultipartPart,
  MultipartParseError,
  type MultipartFilePart,
} from '@/lib/multipart-stream'

/**
 * GET /api/comfy/diffusion-models
 * Returns list of .safetensors files in the ComfyUI diffusion_models folder.
 *
 * (fix 90) POST — model file upload (FormData 'file', .safetensors)
 * to models/diffusion_models/; similar to "Add" for LoRA.
 *
 * (fix 102) Streaming: request body is parsed stream-wise (without
 * `req.formData()`, which buffered the ENTIRE file in Node heap — on
 * models >4 GB this killed the process with OOM: "copies to 100%,
 * but model is missing"). Bytes are written directly to .part file, then atomic
 * rename. Memory is O(chunk), not O(file).
 *
 * (fix 103) Shared streaming parser moved to @/lib/multipart-stream
 * (the same used in /api/loras).
 *
 * (fix 106) Request body is read using NATIVE Web stream reader
 * (req.body.getReader() inside the parser) — just like the working route
 * /api/upscale/upload. Previously the body was wrapped with Readable.fromWeb, and on
 * large uploads under Next.js the server reset the socket (ECONNRESET);
 * through the native reader everything transfers to completion (see src/lib/multipart-stream).
 */
export const dynamic = 'force-dynamic'

// (fix 293) Primary model — reverted back (better quality)
const DEFAULT_MODEL = 'minimax_h3_fastvideo_vsa_datafree_1300step_4step_int8_convrot.safetensors'

export async function GET() {
  let config: ReturnType<typeof getAppConfig> | null = null
  try {
    config = getAppConfig()
    const modelsDir = join(config.comfyRoot, 'ComfyUI', 'models', 'diffusion_models')
    // (fix 102) Case-insensitive: X.SAFETENSORS file was previously
    // accepted by POST, but was not shown in the list.
    const files = readdirSync(modelsDir).filter(f => f.toLowerCase().endsWith('.safetensors'))
    // (fix 257) External folders (Settings → Custom model folders): models
    // from them are seen by ComfyUI via extra_model_paths.yaml, studio — here.
    // Relative path names match how ComfyUI resolves them.
    const external = listExternalModels('diffusion_models')
      .filter((n) => n.toLowerCase().endsWith('.safetensors'))
      .filter((n) => !files.includes(n))
    return NextResponse.json({
      models: [...files, ...external],
      default: DEFAULT_MODEL,
      current: config.diffusionModel || DEFAULT_MODEL,
    })
  } catch {
    // (fix 89) Folder unavailable — do NOT replace config.diffusionModel
    // with default: the selector would show "base", even though config points
    // to an alternative model, quietly desyncing with generation.
    return NextResponse.json({
      models: [],
      default: DEFAULT_MODEL,
      current: config?.diffusionModel || DEFAULT_MODEL,
    })
  }
}

/** Abort upload: client stops reading body, socket is closed. */
function abortUpload(part: MultipartFilePart | null): void {
  try { part?.stream.destroy() } catch { /* already destroyed */ }
  try { part?.cancel() } catch { /* already closed */ }
}

export async function POST(req: NextRequest) {
  let tmpDest = ''
  let part: MultipartFilePart | null = null
  try {
    const webBody = req.body
    if (!webBody) {
      return NextResponse.json({ error: 'Empty request body' }, { status: 400 })
    }

    // (fix 102) Part headers arrive first — filename is known
    // BEFORE transferring gigabytes, and we can reject (400/409)
    // before a single byte is written.
    // (fix 106) req.body is a Web stream, read via native reader
    // (inside parser), without Readable.fromWeb — same as /api/upscale/upload.
    part = await readFirstMultipartPart(webBody, req.headers.get('content-type'))
    if (!part.filename) {
      abortUpload(part)
      return NextResponse.json({ error: 'No file provided' }, { status: 400 })
    }

    // Filename sanitization — base name only without forbidden
    // Windows characters (protection against path traversal).
    const safeName = basename(part.filename).replace(/[\\/:*?"<>|]+/g, '_').trim()
    if (!safeName) {
      abortUpload(part)
      return NextResponse.json({ error: 'Invalid file name' }, { status: 400 })
    }
    if (!safeName.toLowerCase().endsWith('.safetensors')) {
      abortUpload(part)
      return NextResponse.json({ error: 'Only .safetensors files are supported' }, { status: 400 })
    }

    const config = getAppConfig()
    const dir = join(config.comfyRoot, 'ComfyUI', 'models', 'diffusion_models')
    mkdirSync(dir, { recursive: true })
    const dest = join(dir, safeName)
    if (existsSync(dest)) {
      abortUpload(part)
      return NextResponse.json({ error: `File "${safeName}" already exists` }, { status: 409 })
    }

    // (fix 102) Clean leftover .part from previous failed upload.
    const stalePart = dest + '.part'
    if (existsSync(stalePart)) {
      try { unlinkSync(stalePart) } catch { /* ignore */ }
    }

    // (fix 102) Write to temporary .part file as chunks arrive
    // (streamed, without loading entire file into RAM), then atomically
    // rename — on failure partial file does not block
    // retry upload (409).
    tmpDest = dest + '.part'
    const ws = createWriteStream(tmpDest)

    await new Promise<void>((resolve, reject) => {
      ws.on('finish', resolve)
      ws.on('error', reject)
      part!.stream.on('error', reject)
      part!.stream.pipe(ws)
    })

    renameSync(tmpDest, dest)
    tmpDest = '' // success — no cleanup needed

    let size = 0
    try { size = statSync(dest).size } catch { /* ignore */ }
    return NextResponse.json({ ok: true, name: safeName, size })
  } catch (err) {
    // Remove partial file and abort unfinished body.
    abortUpload(part)
    if (tmpDest) {
      try { unlinkSync(tmpDest) } catch { /* ignore */ }
    }
    const msg = err instanceof Error ? err.message : String(err)
    if (err instanceof MultipartParseError) {
      return NextResponse.json({ error: msg }, { status: 400 })
    }
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
