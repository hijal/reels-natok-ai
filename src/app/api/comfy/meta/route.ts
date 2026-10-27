import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import { getAppConfig } from '@/lib/app-config'
import { ensureUpscaleMeta } from '@/lib/upscale-meta'

/**
 * GET /api/comfy/meta?path=subfolder/filename.ext
 * Reads the .meta.json sidecar file from the ComfyUI output directory.
 *
 * (fix 94) Lazy backfill: upscaled videos (DLSS5 / RTXVIDEO by file name)
 * historically lack sidecars — generate one on the fly using ffprobe
 * (resolution/duration/fps/size), then serve as normal.
 */
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const filePath = searchParams.get('path')
  const OUTPUT_DIR = getAppConfig().outputDir

  if (!filePath) {
    return NextResponse.json({ error: 'path is required' }, { status: 400 })
  }

  // (fix 340) Sanitization following safeOutputPath pattern (src/lib/thumb.ts):
  // old scheme (stripping leading slashes + removing '../') did not strip '..\'
  // (Windows) and compared startsWith WITHOUT path.sep — a sibling folder with a common
  // prefix passed as "inside output".
  const cleaned = filePath.replace(/^[\\/]+/, '')
  const outputRoot = path.resolve(OUTPUT_DIR)
  const metaFile = path.resolve(outputRoot, cleaned + '.meta.json')
  if (metaFile !== outputRoot && !metaFile.startsWith(outputRoot + path.sep)) {
    return NextResponse.json({ error: 'Invalid path' }, { status: 400 })
  }
  const safePath = path.relative(outputRoot, metaFile).slice(0, -'.meta.json'.length)

  try {
    if (!fs.existsSync(metaFile)) {
      // (fix 94) No sidecar, but file is upscale result? Generate it.
      const base = path.basename(safePath)
      const isUpscale = /_(?:DLSS5|RTXVIDEO(?:_PREVIEW)?)_\d{8}-\d{6}/i.test(base)
      if (isUpscale) {
        const ok = await ensureUpscaleMeta(
          path.join(OUTPUT_DIR, path.dirname(safePath), base),
          `backfill_${base}`,
        )
        if (ok && fs.existsSync(metaFile)) {
          return NextResponse.json(JSON.parse(fs.readFileSync(metaFile, 'utf-8')))
        }
      }
      return NextResponse.json({ error: 'Metadata file not found' }, { status: 404 })
    }
    const raw = fs.readFileSync(metaFile, 'utf-8')
    const data = JSON.parse(raw)
    // (fix 377) Latent availability for refine-view badge: saved
    // AV-latent path in meta + file exists (inside output/). Computed field —
    // not written to sidecar.
    const latentFile = typeof (data as { latent_file?: unknown }).latent_file === 'string'
      ? (data as { latent_file: string }).latent_file
      : null
    let latentAvailable = false
    if (latentFile) {
      try {
        const latentPath = path.resolve(outputRoot, latentFile)
        latentAvailable =
          latentPath !== outputRoot && latentPath.startsWith(outputRoot + path.sep)
            ? fs.existsSync(latentPath)
            : false
      } catch { /* outside output/ — treat as missing */ }
    }
    return NextResponse.json({ ...data, latent_available: latentAvailable })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to read metadata' },
      { status: 500 },
    )
  }
}
