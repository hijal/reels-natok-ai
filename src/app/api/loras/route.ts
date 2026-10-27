import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import {
  loadLoras,
  saveLoras,
  lorasDir,
  listLoraFiles,
  TURBO_LORA_NAME,
} from '@/lib/loras-config'
import { comfyBusy } from '@/lib/vram-arbiter'
import {
  readFirstMultipartPart,
  MultipartParseError,
  type MultipartFilePart,
} from '@/lib/multipart-stream'

/**
 * GET /api/loras
 * Returns the list of available LoRAs (files in folder) merged with settings.
 */
export async function GET(req: NextRequest) {
  try {
    // Turbo-LoRA in general list: enabled by default, like the other
    // files, comes from loras.json (loadLoras adds entry if missing).
    void req
    const files = listLoraFiles()
    const settings = loadLoras()
    const settingsMap = new Map(settings.map((e) => [e.name, e]))

    // Build the response: all files with their settings.
    // Built-in turbo-LoRA is enabled by default; custom ones are not.
    const result = files.map((name) => {
      const s = settingsMap.get(name)
      return {
        name,
        strength: s?.strength ?? 1.0,
        enabled: s?.enabled ?? (name === TURBO_LORA_NAME),
        trigger: s?.trigger ?? '',
        size: getFileSize(name),
      }
    })

    // (fix 89) Pruning "ghosts": entries whose files were deleted manually from
    // the loras folder are no longer shown and should not remain in config
    // (otherwise the generate route must filter them by disk — which it does,
    // but no need to accumulate garbage in loras.json).
    // (fix 319) GET does not mutate file unnecessarily: rewrite loras.json
    // only if the list actually CHANGED (content comparison, not
    // just length — names/order also taken into account).
    // (fix 716) If file list is EMPTY — do not prune anything. listLoraFiles()
    // catches any folder read error and returns [], so if the folder is temporarily
    // unavailable (EBUSY/EACCES on Windows, moved comfy_dir), prune
    // yielded [] and saveLoras([]) ERASED all LoRA settings (enabled/strength/
    // trigger) — permanently.
    const fileSet = new Set(files)
    if (fileSet.size > 0) {
      const pruned = settings.filter((e) => fileSet.has(e.name))
      const unchanged =
        pruned.length === settings.length &&
        pruned.every((e, i) => e === settings[i])
      if (!unchanged) {
        saveLoras(pruned)
      }
    }

    return NextResponse.json({ loras: result })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

/**
 * POST /api/loras
 * Body: FormData with 'file' field (.safetensors)
 * Copies the file to the LoRAs folder and adds it to settings.
 *
 * (fix 103) Streaming — same as in /api/comfy/diffusion-models
 * (fixes 102/103): `req.formData()` buffered ENTIRE file into RAM — on
 * large LoRAs this killed the process via OOM ("uploads to 100%, but
 * no LoRA appears"). Now body is parsed via streaming (@/lib/multipart-stream),
 * bytes are written to a .part file, followed by atomic rename. Memory O(chunk).
 *
 * (fix 106) Request body is read by standard Web-stream reader
 * (req.body.getReader() inside parser) — same as working route
 * /api/upscale/upload; Readable.fromWeb is no longer used
 * (on large uploads it caused ECONNRESET under Next.js).
 */
export async function POST(req: NextRequest) {
  let tmpDest = ''
  let part: MultipartFilePart | null = null
  try {
    const webBody = req.body
    if (!webBody) {
      return NextResponse.json({ error: 'Empty request body' }, { status: 400 })
    }

    // (fix 103) Part headers arrive first — filename is known
    // BEFORE byte transfer: 400/409 returned before a single byte is written.
    // (fix 106) req.body is a Web stream, parser reads it via standard
    // reader (without Readable.fromWeb) — like /api/upscale/upload.
    part = await readFirstMultipartPart(webBody, req.headers.get('content-type'))
    if (!part.filename) {
      abortUpload(part)
      return NextResponse.json({ error: 'No file provided' }, { status: 400 })
    }

    // Name from multipart may contain path (..\..\model.safetensors) —
    // keep only basename and strip characters invalid for Windows,
    // otherwise upload turns into arbitrary file write.
    const safeName = path.basename(part.filename).replace(/[\\/:*?"<>|]+/g, '_').trim()
    if (!safeName) {
      abortUpload(part)
      return NextResponse.json({ error: 'Invalid file name' }, { status: 400 })
    }
    const ext = path.extname(safeName).toLowerCase()
    if (ext !== '.safetensors') {
      abortUpload(part)
      return NextResponse.json({ error: 'Only .safetensors files are supported' }, { status: 400 })
    }

    const dir = lorasDir()
    fs.mkdirSync(dir, { recursive: true })
    const dest = path.join(dir, safeName)

    // Check name collision
    if (fs.existsSync(dest)) {
      abortUpload(part)
      return NextResponse.json({ error: `File "${safeName}" already exists in LoRAs folder` }, { status: 409 })
    }

    // (fix 103) Clean up leftover .part from a failed upload in advance.
    const stalePart = dest + '.part'
    if (fs.existsSync(stalePart)) {
      try { fs.unlinkSync(stalePart) } catch { /* ignore */ }
    }

    // (fix 103) Stream to temporary .part, then atomic
    // rename — on failure partial file does not block re-upload.
    tmpDest = dest + '.part'
    const ws = fs.createWriteStream(tmpDest)
    await new Promise<void>((resolve, reject) => {
      ws.on('finish', resolve)
      ws.on('error', reject)
      part!.stream.on('error', reject)
      part!.stream.pipe(ws)
    })
    fs.renameSync(tmpDest, dest)
    tmpDest = '' // success — no cleanup needed

    // Add to settings.
    // (fix 256) Newly UPLOADED LoRA is enabled immediately: uploading
    // is itself an intention to use (YouTube complaint "I constantly
    // forget to click enable"). Factory reset (resetLorasToDefaults)
    // still enables only the built-in turbo-LoRA.
    const entries = loadLoras()
    entries.push({ name: safeName, strength: 1.0, enabled: true })
    saveLoras(entries)

    let size = 0
    try { size = fs.statSync(dest).size } catch { /* ignore */ }
    return NextResponse.json({ ok: true, name: safeName, size })
  } catch (err) {
    abortUpload(part)
    if (tmpDest) {
      try { fs.unlinkSync(tmpDest) } catch { /* ignore */ }
    }
    const msg = err instanceof Error ? err.message : String(err)
    if (err instanceof MultipartParseError) {
      return NextResponse.json({ error: msg }, { status: 400 })
    }
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

/** (fix 103) Abort upload: client stops reading body. */
function abortUpload(part: MultipartFilePart | null): void {
  try { part?.stream.destroy() } catch { /* already destroyed */ }
  try { part?.cancel() } catch { /* already closed */ }
}

/**
 * PUT /api/loras
 * Body: { name: string, strength?: number, enabled?: boolean }
 * Updates LoRA settings.
 *
 * (fix 133) On enabled toggle (on/off) automatically frees ComfyUI
 * patches (POST /free) to avoid "shape ... invalid" error on
 * re-enabling. Reset runs in background — does not block response.
 */
export async function PUT(req: NextRequest) {
  try {
    const body = await req.json()
    const { name, strength, enabled, trigger } = body as { name: string; strength?: number; enabled?: boolean; trigger?: string }
    if (!name) {
      return NextResponse.json({ error: 'Invalid LoRA name' }, { status: 400 })
    }

    const entries = loadLoras()
    let entry = entries.find((e) => e.name === name)
    if (!entry) {
      // Turbo-LoRA enabled by default, other new entries are disabled.
      entry = { name, strength: 1.0, enabled: name === TURBO_LORA_NAME }
      entries.push(entry)
    }

    // (fix 133) Remember previous state for freeing patches
    const wasEnabled = entry.enabled

    // (fix 309) Clamping unified with UI slider: −10…+10 (ComfyUI
    // LoraLoader supports negative strengths — inversion); server-side
    // 0…2 silently corrupted values chosen in slider.
    // (fix 716) Type validation: strength="abc" produced NaN
    // (Math.max(-10, NaN) → NaN → sent as null in JSON), and enabled="false"
    // (string) was truthy, silently enabling LoRA.
    if (strength !== undefined) {
      if (typeof strength !== 'number' || !Number.isFinite(strength)) {
        return NextResponse.json({ error: 'Invalid strength (must be a finite number)' }, { status: 400 })
      }
      entry.strength = Math.max(-10, Math.min(10, strength))
    }
    if (enabled !== undefined) {
      if (typeof enabled !== 'boolean') {
        return NextResponse.json({ error: 'Invalid enabled (must be a boolean)' }, { status: 400 })
      }
      entry.enabled = enabled
    }
    // (fix 320) trigger not a string → 400, not 500 on .trim()
    if (trigger !== undefined) {
      if (typeof trigger !== 'string') {
        return NextResponse.json({ error: 'Invalid trigger' }, { status: 400 })
      }
      entry.trigger = trigger.trim()
    }
    saveLoras(entries)

    // (fix 133) If enabled changed — reset ComfyUI patches.
    // This prevents "shape ... invalid" error upon re-enabling
    // LoRA when ComfyUI caches patches in RAM.
    // BUT not during generation: unload_models in the middle of executing prompt
    // kills the task (OOM/model-missing). Check ComfyUI busy state.
    if (enabled !== undefined && enabled !== wasEnabled) {
      const busy = await comfyBusy().catch(() => false)
      if (busy) {
        return NextResponse.json({
          ok: true,
          warning: 'ComfyUI patches not reset: generation in progress. Reset will occur on next toggle.',
        })
      }
      const COMFY_URL = (process.env.COMFY_URL || 'http://127.0.0.1:8188').replace(/\/+$/, '')
      // fire-and-forget: do not await response, do not block UI
      fetch(`${COMFY_URL}/free`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ unload_models: true, free_memory: true }),
        signal: AbortSignal.timeout(5_000),
      }).catch(() => { /* ComfyUI may be unavailable — silently ignore */ })
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

/**
 * DELETE /api/loras
 * Body: { name: string, deleteFile?: boolean }
 * Removes LoRA from settings. If deleteFile=true, also deletes the file.
 */
export async function DELETE(req: NextRequest) {
  try {
    const body = await req.json()
    const { name, deleteFile } = body as { name: string; deleteFile?: boolean }
    // (fix 95) Turbo-LoRA is deleted equally to others: file gone
    // from folder → generate route won't include it in workflow.
    if (!name) {
      return NextResponse.json({ error: 'Invalid LoRA name' }, { status: 400 })
    }

    // Remove from settings
    const entries = loadLoras()
    saveLoras(entries.filter((e) => e.name !== name))

    // Delete file if requested
    if (deleteFile) {
      const dir = lorasDir()
      const filePath = path.join(dir, path.basename(name))
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath)
      }
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

/* ─── helper ─── */
function getFileSize(name: string): number {
  try {
    const dir = lorasDir()
    const st = fs.statSync(path.join(dir, name))
    return st.size
  } catch {
    return 0
  }
}
