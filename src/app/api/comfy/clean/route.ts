import { NextResponse } from 'next/server'
import { promises as fs } from 'fs'
import path from 'path'
import { getAppConfig } from '@/lib/app-config'

/**
 * POST /api/comfy/clean
 * Body: { target: 'input' | 'output' | 'upscale' }
 *
 * Deletes ALL files and subdirectories in the specified directory.
 * The directory itself is preserved (only its contents are deleted).
 *
 * - target='input'   → cleans ComfyUI/input  (references, frames, uploads)
 * - target='output'  → cleans ComfyUI/output (generated videos + .meta.json)
 * - target='upscale' → (fix 167) cleans data/upscale-input, data/upscale-output,
 *   upscale/outputs — all upscale files (inputs and outputs)
 */

/** Recursively cleans the contents of a single directory. Returns the number of deleted items. */
async function cleanDirectory(dir: string): Promise<number> {
  try {
    await fs.stat(dir)
  } catch {
    return 0 // Directory does not exist — consider it already empty
  }

  const entries = await fs.readdir(dir, { withFileTypes: true })
  let deleted = 0
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    try {
      if (entry.isDirectory()) {
        await fs.rm(fullPath, { recursive: true, force: true })
      } else {
        await fs.unlink(fullPath)
      }
      deleted++
    } catch {
      // File might be locked — skip
    }
  }
  return deleted
}

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const target: unknown = body.target

    if (target !== 'input' && target !== 'output' && target !== 'upscale') {
      return NextResponse.json(
        { error: 'target must be "input", "output" or "upscale"' },
        { status: 400 },
      )
    }

    // (fix 167) Upscale: clean ALL upscale directories (input + output)
    if (target === 'upscale') {
      const cwd = process.cwd()
      const dirs = [
        path.join(cwd, 'data', 'upscale-input'),
        path.join(cwd, 'data', 'upscale-output'),
        path.join(cwd, 'upscale', 'outputs'),
      ]
      let total = 0
      for (const d of dirs) {
        total += await cleanDirectory(d)
      }
      return NextResponse.json({ ok: true, deleted: total })
    }

    const config = getAppConfig()
    const dir = target === 'input' ? config.inputDir : config.outputDir

    if (!dir) {
      return NextResponse.json({ error: 'Directory not configured' }, { status: 400 })
    }

    const deleted = await cleanDirectory(dir)
    return NextResponse.json({ ok: true, deleted })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to clean directory'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
