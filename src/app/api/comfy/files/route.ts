import { NextRequest, NextResponse } from 'next/server'
import { promises as fs } from 'fs'
import path from 'path'
import { getAppConfig } from '@/lib/app-config'
import { listGalleryFolders } from '@/lib/gallery-folders'

/**
 * GET /api/comfy/files?type=all|video|image
 * Lists output files from the ComfyUI output directory.
 *
 * - (fix 91) Files from project folders have subfolder = folder path;
 *   the folders themselves are in `folders`.
 * - (fix 495) Nested folders: listing is recursive (up to MAX_DEPTH in
 *   gallery-folders), subfolder is relative path 'a/b'; internal
 *   directories like 'latents' are skipped.
 * - `.meta.json` sidecars and dotfiles are never listed.
 * - Files written within the last HOT_SKIP_SECONDS are skipped: VHS creates
 *   the output mp4 at the start of muxing and writes it progressively, so a
 *   "fresh" file is usually still incomplete (serving it would poison the
 *   browser cache for the plain file URL).
 * - URLs carry `&_t=<mtime>` so a new version of a file is always a new URL –
 *   a mid-write fetch can never shadow the finished file in the HTTP cache.
 */
const VIDEO_EXTS = ['.mp4', '.webm', '.mov', '.avi', '.mkv', '.m4v']
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif']
const HOT_SKIP_SECONDS = 4

async function listDir(
  dirAbs: string,
  subfolder: string,
  typeFilter: string,
  includeHot: boolean,
): Promise<Array<{ url: string; filename: string; subfolder: string; mtime: number; size: number; type: string; hasMeta: boolean; generationTime: number | null; pipeline: string | null }>> {
  const files: Array<{ url: string; filename: string; subfolder: string; mtime: number; size: number; type: string; hasMeta: boolean; generationTime: number | null; pipeline: string | null }> = []
  const entries = await fs.readdir(dirAbs, { withFileTypes: true })

  // (fix 354) stat + sidecar reading in PARALLEL across files:
  // sequential await on each file made listing large folders
  // linearly slow (disk RTT accumulated).
  const probed = await Promise.all(entries.map(async (entry) => {
    if (!entry.isFile()) return null
    if (entry.name.startsWith('.')) return null
    if (entry.name.endsWith('.meta.json')) return null
    const ext = path.extname(entry.name).toLowerCase()

    const isVideo = VIDEO_EXTS.includes(ext)
    const isImage = IMAGE_EXTS.includes(ext)
    if (typeFilter === 'video' && !isVideo) return null
    if (typeFilter === 'image' && !isImage) return null
    if (!isVideo && !isImage) return null

    let mtime = 0
    // (fix 260) File size — fast-track gallery waits for size stabilization
    // to determine that mp4 muxing is finished and the file can be displayed.
    let size = 0
    let hasMeta = false
    let generationTime: number | null = null
    let pipeline: string | null = null
    try {
      const filePath = path.join(dirAbs, entry.name)
      const metaPath = filePath + '.meta.json'
      const [stats, metaRaw] = await Promise.all([
        fs.stat(filePath),
        fs.readFile(metaPath, 'utf-8').catch(() => null),
      ])
      mtime = Math.floor(stats.mtimeMs / 1000)
      size = stats.size
      hasMeta = metaRaw !== null
      // Generation time from metadata (sidecar .meta.json → generation_time) —
      // the same source shown in the metadata dialog. The preview badge now
      // takes the value FROM HERE rather than from client-side estimation in useGenDurations
      // (which caused discrepancy).
      if (metaRaw !== null) {
        try {
          const meta = JSON.parse(metaRaw) as { generation_time?: unknown; pipeline?: unknown; params?: { generation_time?: unknown } }
          const top = typeof meta.generation_time === 'number' ? meta.generation_time : null
          const nested = typeof meta.params?.generation_time === 'number' ? meta.params.generation_time : null
          const gt = top ?? nested
          if (typeof gt === 'number' && Number.isFinite(gt) && gt > 0) generationTime = gt
          // (fix 261) pipeline ('draft'|'full') — red "Draft" badge on
          // gallery preview for single-pass generations.
          if (meta.pipeline === 'draft' || meta.pipeline === 'full') pipeline = meta.pipeline
        } catch { /* sidecar malformed / mid-write — keep null */ }
      }
    } catch { /* ignore */ }

    return { entry, mtime, size, hasMeta, generationTime, pipeline, isVideo }
  }))

  for (const item of probed) {
    if (!item) continue
    const { entry, mtime, size, hasMeta, generationTime, pipeline, isVideo } = item
    // Still being written — skip until it goes "cold". include_hot=1 (used by
    // the post-completion extend discovery, where the task is already done and
    // all files are final) bypasses this filter.
    if (!includeHot && Date.now() / 1000 - mtime < HOT_SKIP_SECONDS) continue

    files.push({
      url: `/api/comfy/file?filename=${encodeURIComponent(entry.name)}&subfolder=${encodeURIComponent(subfolder)}&type=output&_t=${mtime}`,
      filename: entry.name,
      subfolder,
      mtime,
      size,
      type: isVideo ? 'video' : 'image',
      hasMeta,
      generationTime,
      pipeline,
    })
  }
  return files
}

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const typeFilter = searchParams.get('type') || 'all'
  const includeHot = searchParams.get('include_hot') === '1'
  const OUTPUT_DIR = getAppConfig().outputDir

  // (fix 259) No list caching: URL is always the same
  // (?type=all), and without explicit prevention the browser was allowed to serve stale
  // responses — new video "did not appear" until manual page refresh.
  const NO_STORE = {
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    Pragma: 'no-cache',
  } as const

  if (!OUTPUT_DIR) {
    return NextResponse.json({ files: [], folders: [] }, { headers: NO_STORE })
  }

  try {
    // (fix 495) Project folders — all nesting levels (listGalleryFolders
    // already excludes dot-folders and service 'latents', and sorts).
    const folders = await listGalleryFolders()

    // (fix 354) List project folders in parallel.
    const nested = await Promise.all(
      folders.map((folder) => listDir(path.join(OUTPUT_DIR, ...folder.split('/')), folder, typeFilter, includeHot)
        .catch(() => [])),
    )
    let files = await listDir(OUTPUT_DIR, '', typeFilter, includeHot)
    for (const sub of nested) {
      files = files.concat(sub)
    }

    // Sort by mtime descending (newest first)
    files.sort((a, b) => b.mtime - a.mtime)

    return NextResponse.json({ files, folders }, { headers: NO_STORE })
  } catch (err) {
    // (fix 716) Error is no longer masked as an "empty gallery":
    // previously UI showed an empty gallery, and the user did not understand that
    // the output folder was unavailable. Return 500 with error message.
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: `Failed to read gallery: ${msg}`, files: [], folders: [] }, { status: 500, headers: NO_STORE })
  }
}
