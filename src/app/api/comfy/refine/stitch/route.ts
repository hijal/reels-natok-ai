import { NextRequest, NextResponse } from 'next/server'
import { promises as fs } from 'fs'
import { existsSync } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import { writeMetaSidecar } from '@/lib/pending-meta'
import { getAppConfig } from '@/lib/app-config'
import { sanitizeFolderPath } from '@/lib/gallery-folders' // (fix 495)
import { resolveFfmpeg } from '@/lib/thumb'
import { probeVideoFile, type VideoProbe } from '@/lib/video-probe'
import { ffmpegVideoArgs } from '@/lib/video-format'
import { getVideoFormatSettings } from '@/lib/video-format-server' // (fix 386)

const execFileAsync = promisify(execFile)

/**
 * POST /api/comfy/refine/stitch — final stitching of chunks for refine
 * "By parts" mode.
 *
 * (fix 314) LEGACY path: the current "By parts" workflow (fix 314 in
 * refine-template.ts) glues windows in latent space and outputs ONE
 * file Minimax_Studio_refine_* — it does NOT call this route (no per-chunk
 * refinepart_*, no second h264 encoding, meta is written by server via
 * recordPendingMetaRaw → /api/comfy/status). Route is kept for backward
 * compatibility: client (refine-queue.ts) calls it only if refinepart_*
 * are found in job outputs (old-style workflow).
 *
 * Body:
 *   chunkFiles — [{filename, subfolder}] chunks in output (without audio)
 *   audioSource — {filename, subfolder} source in output (its audio
 *                 is laid onto entire stitched timeline without re-encode)
 *   overlapsSec — [number] overlap of each seam in seconds (for xfade)
 *   outSubfolder — output subfolder ('' = root)
 *
 * xfade mathematics — same as in /api/comfy/concat (fix 182): offset of each
 * seam is calculated from the RUNNING duration of intermediate output. Chunks
 * are cut according to the source timeline, so stitched video timeline
 * matches the original — audio stays synchronized without trimming.
 */
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      chunkFiles?: Array<{ filename: string; subfolder?: string }>
      audioSource?: { filename: string; subfolder?: string }
      overlapsSec?: number[]
      outSubfolder?: string
      /** (fix 253) Latent chain: chunks without duplicates — hard stitch. */
      hard?: boolean
      /** (fix 260) Metadata parameters of the final file (with source). */
      meta?: Record<string, unknown>
    }
    if (!body?.chunkFiles?.length || !body?.audioSource?.filename) {
      return NextResponse.json({ error: 'chunkFiles and audioSource are required' }, { status: 400 })
    }

    const cfg = getAppConfig()
    const resolveOut = (f: { filename: string; subfolder?: string }) => {
      const safeName = path.basename(f.filename)
      // (fix 495) subfolder — multi-level relative path ('a/b').
      const sub = f.subfolder ? sanitizeFolderPath(f.subfolder) : ''
      const p = path.join(cfg.outputDir, ...(sub ? sub.split('/') : []), safeName)
      // (fix 716) Missing file is 404, not 500: same logic as
      // in sibling /api/comfy/trim.
      if (!existsSync(p)) {
        const err = new Error(`File not found: ${safeName}`) as Error & { status?: number }
        err.status = 404
        throw err
      }
      return p
    }

    const chunkPaths = body.chunkFiles.map(resolveOut)
    const audioPath = resolveOut(body.audioSource)
    const outSub = body.outSubfolder ? sanitizeFolderPath(body.outSubfolder) : ''
    const outName = `Minimax_Studio_refine_${Date.now().toString(36)}.mp4`
    const outPath = path.join(cfg.outputDir, outSub, outName)
    await fs.mkdir(path.dirname(outPath), { recursive: true })

    const ffmpeg = await resolveFfmpeg()
    if (!ffmpeg) {
      return NextResponse.json({ error: 'FFmpeg unavailable' }, { status: 500 })
    }

    // Probe chunks: durations for xfade offsets, canvas from the first.
    const infos: VideoProbe[] = []
    for (const p of chunkPaths) {
      infos.push(await probeVideoFile(p))
    }
    const W = infos[0].width % 2 === 0 ? infos[0].width : infos[0].width + 1
    const H = infos[0].height % 2 === 0 ? infos[0].height : infos[0].height + 1

    // Video stream: bring to canvas and fps, then chain of xfades across seams.
    // ─── (fix 272) Hard stitch (D-version scheme — working):
    // latent chain gives chunks without duplicates (head trimmed),
    // seams are continuous by construction — xfade not needed.
    // ─── (fix 313) Audio is now in chunks themselves (regenerated
    // by sampler, like video, and muxed by VHS_VideoCombine): stitch
    // audio across chunks just like video. Fallbacks: (1) audio from whole
    // original — behavior prior to fix 313; (2) video without audio.
    if (body.hard) {
      const runFfmpeg = (args: string[]) =>
        execFileAsync(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...args], {
          timeout: 600_000,
          maxBuffer: 32 * 1024 * 1024,
        }).then(() => true).catch(() => false)

      // (fix 386) codec/quality from studio [video] settings
      const videoEnc = ['-preset', 'fast', ...ffmpegVideoArgs(getVideoFormatSettings()), '-pix_fmt', 'yuv420p', '-movflags', '+faststart']
      const videoFilter = chunkPaths.map((_, i) => `[${i}:v]scale=${W}:${H},setsar=1,fps=24[v${i}]`).join(';')
      const concatV = chunkPaths.map((_, i) => `[v${i}]`).join('') + `concat=n=${chunkPaths.length}:v=1:a=0[vout]`

      // 1) Main: video and audio from chunks themselves (fix 313).
      const fullArgs = [
        ...chunkPaths.flatMap((q) => ['-i', q]),
        '-filter_complex',
        `${videoFilter};${chunkPaths.map((_, i) => `[${i}:a]aresample=44100[a${i}]`).join(';')};${chunkPaths.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${chunkPaths.length}:v=1:a=1[vout][aout]`,
        '-map', '[vout]', '-map', '[aout]',
        ...videoEnc, '-c:a', 'aac', '-b:a', '192k', '-shortest', '-y', outPath,
      ]
      // 2) Fallback (prior to fix 313): video from chunks + audio of whole original.
      const origArgs = [
        ...[...chunkPaths, audioPath].flatMap((q) => ['-i', q]),
        '-filter_complex',
        `${videoFilter};[${chunkPaths.length}:a]aresample=44100[aout];${concatV}`,
        '-map', '[vout]', '-map', '[aout]',
        ...videoEnc, '-c:a', 'aac', '-b:a', '192k', '-shortest', '-y', outPath,
      ]
      // 3) Last resort: video only (source has no audio track).
      const videoOnlyArgs = [
        ...[...chunkPaths, audioPath].flatMap((q) => ['-i', q]),
        '-filter_complex', `${videoFilter};${concatV}`,
        '-map', '[vout]', '-an', ...videoEnc, '-y', outPath,
      ]

      let ok = await runFfmpeg(fullArgs)
      if (!ok) ok = await runFfmpeg(origArgs)
      if (!ok) ok = await runFfmpeg(videoOnlyArgs)
      if (!ok) throw new Error('FFmpeg hard-stitch failed: no stitch mode succeeded')
      // (fix 260) Sidecar for "By parts" refine result: client passes meta
      // with source; add only service fields here.
      // (fix 361) Write result sidecar BEFORE deleting chunks and delete
      // chunk sidecars only if final was written (or not requested) —
      // otherwise on write failure ALL chain meta was lost.
      let finalMetaOk = !body.meta || typeof body.meta !== 'object'
      if (body.meta && typeof body.meta === 'object') {
        try {
          writeMetaSidecar(outName, outSub, {
            ...(body.meta as Record<string, unknown>),
            combined_from: body.chunkFiles.map((c) => c.filename),
            created_at: Date.now() / 1000,
          })
          finalMetaOk = true
        } catch { /* non-critical */ }
      }
      // (fix 260) Chunks are intermediate: delete along with their sidecars
      // (written by status route pending-meta on job 'done').
      for (const q of chunkPaths) {
        await fs.unlink(q).catch(() => {})
        if (finalMetaOk) await fs.unlink(q + '.meta.json').catch(() => {})
      }
      return NextResponse.json({ filename: outName, subfolder: outSub })
    }

    // ─── Seam calculation (fix 271) ───
    // Chunks overlap by CHAIN_OVERLAP (39) frames: each window file
    // k>0 includes head overlap (same source frames as tail of
    // window k−1). At the seam there are two DIFFERENT re-renders of the SAME frames
    // (close, since conditioning + latent seed are identical). Therefore:
    //  • fade is short — FADE_SEC (3 frames): blend closest frames
    //    of two close renders → smooth transition without ghosting;
    //  • remainder of overlap is TRIMMED from head of next chunk (trim) —
    //    timeline is continuous: content of chunk i+1 after trim starts exactly
    //    at fade before end of chunk i. Math: trim + fade = overlap.
    const FADE_SEC = 3 / 24
    const seams = chunkPaths.slice(1).map((_, i) => {
      const overlap = body.overlapsSec?.[i] ?? 1
      const f = Math.min(
        overlap,
        FADE_SEC,
        Math.max(0.05, infos[i].durationSec / 2 - 0.01),
        Math.max(0.05, infos[i + 1].durationSec / 2 - 0.01),
      )
      return { fade: f, trim: Math.max(0, overlap - f) }
    })

    const filter: string[] = []
    // Chunk 0 — whole; chunks i>=1 — head trimmed by (overlap - fade).
    filter.push(`[0:v]scale=${W}:${H},setsar=1,fps=24[v0]`)
    for (let i = 1; i < chunkPaths.length; i++) {
      const trim = seams[i - 1].trim
      const head = trim > 0.001 ? `trim=start=${trim.toFixed(4)},setpts=PTS-STARTPTS,` : ''
      filter.push(`[${i}:v]${head}scale=${W}:${H},setsar=1,fps=24[v${i}]`)
    }
    // Audio — from WHOLE source (last input), without crossfades.
    const audioIndex = chunkPaths.length
    filter.push(`[${audioIndex}:a]aresample=44100[aout]`)

    if (chunkPaths.length === 1) {
      filter.push(`[v0]copy[vout]`)
    } else {
      // Running duration: head trims already accounted for in actual length
      // of chunks AFTER trim — compute from probes.
      let running = infos[0].durationSec
      for (let i = 0; i < chunkPaths.length - 1; i++) {
        const f = seams[i].fade
        const nextDur = infos[i + 1].durationSec - seams[i].trim
        const offset = Math.max(0, running - f)
        filter.push(`[v${i}][v${i + 1}]xfade=transition=fade:duration=${f.toFixed(3)}:offset=${offset.toFixed(3)}[v${i + 1}]`)
        running += nextDur - f
      }
      filter.push(`[v${chunkPaths.length - 1}]null[vout]`)
    }

    const inputArgs: string[] = []
    for (const p of [...chunkPaths, audioPath]) inputArgs.push('-i', p)

    try {
      await execFileAsync(
        ffmpeg,
        [
          '-hide_banner', '-loglevel', 'error',
          ...inputArgs,
          '-filter_complex', filter.join(';'),
          '-map', '[vout]',
          '-map', '[aout]',
          // (fix 386) codec/quality from studio [video] settings
          '-preset', 'fast', ...ffmpegVideoArgs(getVideoFormatSettings()),
          '-pix_fmt', 'yuv420p',
          '-c:a', 'aac', '-b:a', '192k',
          '-movflags', '+faststart',
          '-shortest',
          '-y',
          outPath,
        ],
        { timeout: 600_000, maxBuffer: 32 * 1024 * 1024 },
      )
    } catch (err) {
      const e = err as { stderr?: string; message?: string }
      const stderr = e.stderr || e.message || String(err)
      // Fallback without audio (source may not have audio track).
      try {
        const videoOnly = filter.filter((s) => !s.startsWith(`[${audioIndex}:a`) && !s.includes('[aout]'))
        await execFileAsync(
          ffmpeg,
          [
            '-hide_banner', '-loglevel', 'error',
            ...inputArgs,
            '-filter_complex', videoOnly.join(';'),
            '-map', '[vout]',
            '-an',
            // (fix 386) codec/quality from studio [video] settings
            '-preset', 'fast', ...ffmpegVideoArgs(getVideoFormatSettings()),
            '-pix_fmt', 'yuv420p',
            '-movflags', '+faststart',
            '-y',
            outPath,
          ],
          { timeout: 600_000, maxBuffer: 32 * 1024 * 1024 },
        )
      } catch {
        throw new Error(`FFmpeg stitch failed: ${stderr.slice(0, 600)}`)
      }
    }

    // (fix 260) Result sidecar (xfade branch) — same as in hard branch.
    // (fix 361) First result sidecar, then delete chunks: delete chunk
    // sidecars only upon successful writing of final (or if meta
    // not requested) — do not lose all chain meta on write failure.
    let finalMetaOk = !body.meta || typeof body.meta !== 'object'
    if (body.meta && typeof body.meta === 'object') {
      try {
        writeMetaSidecar(outName, outSub, {
          ...(body.meta as Record<string, unknown>),
          combined_from: body.chunkFiles.map((c) => c.filename),
          created_at: Date.now() / 1000,
        })
        finalMetaOk = true
      } catch { /* non-critical */ }
    }

    // Chunks are consumable: remove after successful stitch
    // (fix 260) along with their sidecars from pending-meta.
    for (const p of chunkPaths) {
      await fs.unlink(p).catch(() => {})
      if (finalMetaOk) await fs.unlink(p + '.meta.json').catch(() => {})
    }

    return NextResponse.json({ filename: outName, subfolder: outSub })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // (fix 716) Status from error (404 for "file not found"), otherwise 500.
    const status = (err as { status?: number })?.status
    return NextResponse.json({ error: msg }, { status: typeof status === 'number' ? status : 500 })
  }
}
