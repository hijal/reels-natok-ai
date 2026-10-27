import { NextRequest, NextResponse } from 'next/server'
import { promises as fs } from 'fs'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { getAppConfig } from '@/lib/app-config'
import { sanitizeFolderPath } from '@/lib/gallery-folders' // (fix 495)
import { writeMetaSidecar } from '@/lib/pending-meta'
import { probeVideoFile } from '@/lib/video-probe' // (fix 722) — actual trim geometry
import { resolveFfmpeg } from '@/lib/thumb'
import { ffmpegVideoArgs } from '@/lib/video-format'
import { getVideoFormatSettings } from '@/lib/video-format-server' // (fix 386)

const execFileAsync = promisify(execFile)

/**
 * POST /api/comfy/trim
 *
 * Body: { filename: string, subfolder?: string, start: number, end: number }
 *   - filename: file name in output/ (or subfolder/output/)
 *   - subfolder: subfolder in output/ (empty for root)
 *   - start: seconds from start (>= 0)
 *   - end: seconds until end (<= duration)
 *
 * Result: new file `<base>_trim_<start>-<end>.mp4` in the same folder.
 * Response: { filename, subfolder, url, duration }
 * (fix 307) Result gets a .meta.json sidecar: inherits sidecar
 * of source in full + workflow:'trim', source_video, trim_start/end/duration.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      filename?: string
      subfolder?: string
      start?: number
      end?: number
    }

    const { filename, subfolder = '', start = 0, end } = body
    if (!filename || typeof start !== 'number' || typeof end !== 'number') {
      return NextResponse.json({ error: 'filename, start, end are required' }, { status: 400 })
    }
    // (fix 357) NaN/Infinity passed typeof check and went into
    // ffmpeg arguments / file name → 500 instead of clear 400.
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      return NextResponse.json({ error: 'start/end must be finite numbers' }, { status: 400 })
    }
    if (start < 0 || end <= 0 || start >= end) {
      return NextResponse.json({ error: 'Invalid range: need 0 <= start < end' }, { status: 400 })
    }

    const { outputDir } = getAppConfig()

    // Resolve source path
    // (fix 495) subfolder is a multi-level relative path ('a/b').
    const safeName = path.basename(filename)
    const safeSub = subfolder ? sanitizeFolderPath(subfolder) : ''
    const sourcePath = path.join(outputDir, safeSub, safeName)

    // (fix 587) Missing source is 404, not 500: file could have been
    // deleted from the gallery right before trimming (normal client race).
    try {
      await fs.access(sourcePath)
    } catch {
      return NextResponse.json(
        { error: `File not found: ${safeSub ? safeSub + '/' : ''}${safeName}` },
        { status: 404 },
      )
    }

    // Build output filename: <base>_trim_<start>-<end>.<ext>
    const ext = path.extname(safeName) || '.mp4'
    const baseNoExt = path.basename(safeName, ext)
    // Round to 1 decimal for clean names
    const s = Math.round(start * 10) / 10
    const e = Math.round(end * 10) / 10
    const outName = `${baseNoExt}_trim_${s}-${e}${ext}`
    const outPath = path.join(outputDir, safeSub, outName)

    // If already exists, add a counter
    let finalOutPath = outPath
    let counter = 1
    while (true) {
      try {
        await fs.access(finalOutPath)
        // exists — increment
        finalOutPath = path.join(outputDir, safeSub, `${baseNoExt}_trim_${s}-${e}_${counter}${ext}`)
        counter++
      } catch {
        break // doesn't exist, good
      }
    }

    // Run ffmpeg trim (stream copy for speed — no re-encode)
    const bin = await resolveFfmpeg()
    if (!bin) throw new Error('ffmpeg-not-available')

    const duration = end - start

    // (fix 306) Re-encode trim: -c copy gives a frozen frame (no I-frame at split point).
    // Re-encode with veryfast takes ~1 sec for a 20s video, result is valid and plays immediately.
    await execFileAsync(
      bin,
      [
        '-hide_banner', '-loglevel', 'error',
        '-ss', String(start),
        '-i', sourcePath,
        '-t', String(duration),
        // (fix 386) codec/quality from studio [video] settings
        '-preset', 'veryfast', ...ffmpegVideoArgs(getVideoFormatSettings()),
        '-c:a', 'aac', '-b:a', '192k',
        '-movflags', '+faststart',
        '-y',
        finalOutPath,
      ],
      { timeout: 300_000 },
    )

    // Verify output exists
    const stat = await fs.stat(finalOutPath)
    if (stat.size === 0) throw new Error('Trim produced empty file')

    const finalName = path.basename(finalOutPath)

    // (fix 307) Result sidecar: inherit source sidecar ENTIRELY
    // (prompt/chain, references, seed, etc.) and add trim service fields.
    // No source sidecar — write minimal one (the trim fact itself).
    //
    // (fix 722) Geometry is ACTUAL, not inherited. Previously
    // the trimmed file kept source's video_length/duration_seconds
    // (107 frames instead of, say, 48) → metadata lied about the file itself, and
    // lossless latent resolver (resolveSourceLatent) checked meta against probe
    // of mp4 and hit a mismatch. Now: probe of trimmed file → exact
    // frames/duration/resolution.
    try {
      const outputRoot = path.resolve(outputDir)
      const srcMetaFile = path.resolve(path.join(outputDir, safeSub, safeName + '.meta.json'))
      let srcMeta: Record<string, unknown> = {}
      if (srcMetaFile.startsWith(outputRoot + path.sep)) {
        try {
          srcMeta = JSON.parse(await fs.readFile(srcMetaFile, 'utf-8')) as Record<string, unknown>
        } catch { /* corrupted sidecar — write minimal */ }
      }

      // Actual geometry of trimmed file.
      let probed: Record<string, unknown> = {}
      try {
        const pr = await probeVideoFile(finalOutPath)
        if (pr.width > 0 && pr.height > 0 && pr.frames > 0) {
          probed = {
            video_length: pr.frames,
            duration_seconds: Number(pr.durationSec.toFixed(2)),
            resolution: `${pr.width}x${pr.height}`,
            fps: pr.fps ?? 24,
          }
        }
      } catch { /* probe is non-critical — inherited fields remain */ }

      // Source latent does NOT apply to the trimmed file: it describes
      // the full length and canvas of the source. Leaving it in the sidecar is inaccurate
      // (and an extra branch where lossless refine would try to go).
      const { latent_file: _dropLatent, ...srcMetaNoLatent } = srcMeta

      writeMetaSidecar(finalName, safeSub, {
        ...srcMetaNoLatent,
        workflow: 'trim',
        // (fix 722) "File edited" mark — allows gallery and any
        // metadata consumers to distinguish trim from original generation.
        edited: true,
        source_video: { filename: safeName, subfolder: safeSub },
        trim_start: s,
        trim_end: e,
        trim_duration: Math.round(duration * 100) / 100,
        ...probed,
        job_id: `trim_${Date.now().toString(36)}`,
      })
    } catch { /* sidecar is non-critical for trim itself */ }

    const url = `/api/comfy/file?filename=${encodeURIComponent(finalName)}&subfolder=${encodeURIComponent(safeSub)}&type=output`

    return NextResponse.json({
      filename: finalName,
      subfolder: safeSub,
      url,
      duration: Math.round(duration * 100) / 100,
      size: stat.size,
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[trim] ERROR:', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
