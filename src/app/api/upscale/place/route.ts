import { NextRequest, NextResponse } from 'next/server'
import { promises as fs } from 'fs'
import { existsSync } from 'fs'
import path from 'path'
import { getAppConfig } from '@/lib/app-config'
import { sanitizeFolderPath } from '@/lib/gallery-folders'
import { ensureUpscaleMeta } from '@/lib/upscale-meta'

/**
 * (fix 727) POST /api/upscale/place
 * Body: { path: "<output_path>", subfolder: "project/scenes",
 *        job_id?: "<id>", source_name?: "<source name>" }
 *
 * DLSS bridge always publishes result to output ROOT (UPSCALE_OUTPUT_DIR),
 * so a reused video from a folder previously lost its folder. This route
 * moves the finished file (and its .meta.json) to the chosen subfolder; on
 * name collision it adds a suffix. Returns the new path — queue
 * appends generation_time to it.
 *
 * Metadata itself: if sidecar does not exist yet (ensureUpscaleMeta in /api/upscale/job
 * is fire-and-forget and may not have finished), we create it at the new location —
 * inheriting prompt from the source sidecar (source_name + subfolder).
 */
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as
      | { path?: unknown; subfolder?: unknown; job_id?: unknown; source_name?: unknown }
      | null
    const rawPath = typeof body?.path === 'string' ? body.path : ''
    const sub = sanitizeFolderPath(typeof body?.subfolder === 'string' ? body.subfolder : '')
    if (!rawPath) {
      return NextResponse.json({ error: 'path is required' }, { status: 400 })
    }

    const OUTPUT_DIR = path.resolve(getAppConfig().outputDir)
    const src = path.resolve(rawPath)
    if (src !== OUTPUT_DIR && !src.startsWith(OUTPUT_DIR + path.sep)) {
      return NextResponse.json({ error: 'File outside output folder' }, { status: 400 })
    }
    if (!existsSync(src)) {
      return NextResponse.json({ error: 'Result file not found' }, { status: 404 })
    }
    // '' — shared folder: result is already in place, nowhere to move.
    if (!sub) {
      return NextResponse.json({ ok: true, path: src, subfolder: '' })
    }

    const dir = path.join(OUTPUT_DIR, ...sub.split('/').filter(Boolean))
    await fs.mkdir(dir, { recursive: true })

    const ext = path.extname(src)
    const stem = path.basename(src, ext)
    let dest = path.join(dir, path.basename(src))
    let counter = 1
    while (existsSync(dest)) {
      dest = path.join(dir, `${stem}_${counter++}${ext}`)
      if (counter > 1000) {
        return NextResponse.json({ error: 'Too many name collisions' }, { status: 500 })
      }
    }

    // Same filesystem move — rename; otherwise copy + delete.
    try {
      await fs.rename(src, dest)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
      await fs.copyFile(src, dest)
      await fs.unlink(src)
    }

    // Sidecar moves together with video (if status server already managed to create it).
    const srcMeta = `${src}.meta.json`
    const destMeta = `${dest}.meta.json`
    if (existsSync(srcMeta)) {
      try {
        await fs.rename(srcMeta, destMeta)
      } catch {
        await fs.copyFile(srcMeta, destMeta).catch(() => {})
        await fs.unlink(srcMeta).catch(() => {})
      }
    }

    // Ensure metadata at new location (otherwise finalize silently appends nothing).
    if (!existsSync(destMeta)) {
      const jobId = typeof body?.job_id === 'string' && body.job_id ? body.job_id : `place_${Date.now().toString(36)}`
      const sourceName = typeof body?.source_name === 'string' ? path.basename(body.source_name) : ''
      // Absolute path to source → ensureUpscaleMeta will find its sidecar even
      // in a nested folder and inherit prompt/references.
      const sourceHint = sourceName ? path.join(dir, sourceName) : undefined
      await ensureUpscaleMeta(dest, jobId, sourceHint).catch(() => {})
    }

    // source_video in sidecar — real source (bridge puts a temporary copy
    // from data/upscale-input into input field, its name is useless in gallery).
    if (existsSync(destMeta)) {
      try {
        const meta = JSON.parse(await fs.readFile(destMeta, 'utf-8')) as Record<string, unknown>
        const sourceName = typeof body?.source_name === 'string' ? path.basename(body.source_name) : ''
        if (sourceName) {
          meta.source_video = { filename: sourceName, subfolder: sub }
          meta.source_file = sourceName
        } else if (meta.source_video && typeof meta.source_video === 'object') {
          ;(meta.source_video as { subfolder?: string }).subfolder = sub
        }
        await fs.writeFile(destMeta, JSON.stringify(meta, null, 2), 'utf-8')
      } catch { /* corrupted sidecar — leave as is */ }
    }

    return NextResponse.json({
      ok: true,
      path: dest,
      filename: path.basename(dest),
      subfolder: sub,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
