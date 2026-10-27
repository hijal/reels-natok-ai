import { NextRequest, NextResponse } from 'next/server'
import { promises as fs } from 'fs'
import path from 'path'
import { getAppConfig } from '@/lib/app-config'
import { sanitizeFolderPath } from '@/lib/gallery-folders' // (fix 495)
import { deleteThumbsFor } from '@/lib/thumb'

/**
 * POST /api/comfy/delete
 * Body: { filename: string, subfolder?: string }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const filename = body.filename as string
    const OUTPUT_DIR = getAppConfig().outputDir
    if (!filename) {
      return NextResponse.json({ error: 'filename required' }, { status: 400 })
    }

    // Sanitize: prevent path traversal
    // (fix 495) subfolder is a multi-level relative path ('a/b').
    const safeName = path.basename(filename)
    const subfolder = body.subfolder ? sanitizeFolderPath(String(body.subfolder)) : ''
    // (fix 350) Normalize OUTPUT_DIR with resolve BEFORE comparison — otherwise
    // relative/unnormalized outputDir broke the startsWith check.
    const outputRoot = path.resolve(OUTPUT_DIR)
    const target = path.resolve(path.join(outputRoot, subfolder, safeName))

    // Ensure target is within OUTPUT_DIR
    if (!target.startsWith(outputRoot + path.sep)) {
      return NextResponse.json({ error: 'Invalid path' }, { status: 400 })
    }

    await fs.unlink(target)
    // (fixes 378/391) Latent pipeline: saved AV-latent (.latent from
    // meta's latent_file field) lives while its mp4 lives — delete it along
    // with it, otherwise orphan files accumulate in output/<sub>/latents/. Path strictly
    // inside output/ (resolve + lowercase on win32, pattern of fix 348).
    // (fix 391) Read meta BEFORE deleting sidecar — fix 378 deleted
    // it first, reading always yielded ENOENT and the .latent was never deleted.
    // latent_file is stored relative to output/ ('<sub>/latents/<file>' —
    // written by pending-meta finalizePendingMeta), same as resolveSourceLatent.
    let latentFile: string | null = null
    try {
      const metaRaw = await fs.readFile(target + '.meta.json', 'utf-8')
      const meta = JSON.parse(metaRaw) as { latent_file?: unknown }
      if (typeof meta.latent_file === 'string' && meta.latent_file) {
        latentFile = meta.latent_file
      }
    } catch { /* no meta / corrupted — simply leave latent untouched */ }
    // Also delete .meta.json sidecar if present
    await fs.unlink(target + '.meta.json').catch(() => {})
    if (latentFile) {
      const latentPath = path.resolve(outputRoot, latentFile)
      const norm = (x: string) => (process.platform === 'win32' ? x.toLowerCase() : x)
      if (
        norm(latentPath) !== norm(outputRoot) &&
        norm(latentPath).startsWith(norm(outputRoot) + path.sep)
      ) {
        await fs.unlink(latentPath).catch(() => {})
      }
    }
    // (fix 355) Clear disk preview cache (.thumbs) of the deleted file.
    await deleteThumbsFor(`output_${subfolder ? subfolder + '_' : ''}${safeName}`)
    return NextResponse.json({ ok: true })
  } catch (err) {
    if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return NextResponse.json({ error: 'File not found' }, { status: 404 })
    }
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
