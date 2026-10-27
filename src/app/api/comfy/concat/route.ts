import { NextRequest, NextResponse } from 'next/server'
import { promises as fs, existsSync } from 'fs'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { getAppConfig } from '@/lib/app-config'
import { sanitizeFolderPath } from '@/lib/gallery-folders' // (fix 495)
import { writeMetaSidecar } from '@/lib/pending-meta'
import { mergeExtendMeta } from '@/lib/extend-meta'
import { resolveFfmpeg } from '@/lib/thumb'
import { probeVideoFile } from '@/lib/video-probe'
import { ffmpegVideoArgs } from '@/lib/video-format'
import { getVideoFormatSettings } from '@/lib/video-format-server' // (fix 386)

const execFileAsync = promisify(execFile)

/**
 * (fix 716) Recursive search for file by name in subfolders (depth ≤ depth).
 * Skips service dots and folders starting with '.'.
 */
async function findFileRecursive(root: string, fileName: string, depth: number): Promise<string | null> {
  if (depth < 0) return null
  let entries: import('fs').Dirent[]
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return null
  }
  const direct = path.join(root, fileName)
  if (existsSync(direct)) return direct
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name === '.' || entry.name === '..' || entry.name.startsWith('.')) continue
    const found = await findFileRecursive(path.join(root, entry.name), fileName, depth - 1)
    if (found) return found
  }
  return null
}

interface ProbeInfo {
  duration: number
  width: number
  height: number
  fps: number
}

interface InputSpec {
  /** Filename in ComfyUI output/ (or input/ if `kind === 'source'`). */
  name: string
  /** Subfolder inside output/ (empty string for root). */
  subfolder?: string
  /** 'output' (default) = file in output/; 'source' = file in input/. */
  kind?: 'output' | 'source'
}

/**
 * POST /api/comfy/concat
 *
 * N-way seamless crossfade concat of videos.
 *
 * Backward-compatible body shapes:
 *   { source: string, generated: string, fade?: number }
 *
 * New (N-way) shape:
 *   { inputs: InputSpec[], fade?: number, outName?: string }
 *
 * Output is saved in output/ as `Minimax_Studio_combined_<n>.mp4`
 * (or `<outName>` if provided) and returned with filename + url.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      source?: string
      generated?: string
      fade?: number
      inputs?: InputSpec[]
      outName?: string
      /** (fix 213) Trim END of first input (source) by N seconds —
       * seam "source → clip 0" sits on seam overlap from fix 210. */
      sourceTrimSeconds?: number
      /** (fix 218) Crossfade specifically on FIRST seam "source → clip 0".
       * Overlap content is identical on both sides, so long
       * fade is invisible as a "dissolve", but completely covers change
       * of image character (VAE roundtrip + pass 2: microcontrast,
       * sharpness). Short `fade` remains between clips. */
      seamFadeSeconds?: number
      /** (fix 250) Trim HEAD of input i≥1 by N seconds — warmup prefix
       *  of clip (duplicated moments of tail of clip i-1), not consumed by crossfade.
       *  Without this trim, short fade would leave a repeat of ~0.8 s at the seam. */
      headTrims?: number[]
      /** (fix 260) Metadata parameters for output file sidecar. */
      meta?: Record<string, unknown>
      /** (fix 365) Output subfolder for final file ('' = root) —
       *  extend concat places combined file in original's folder. */
      outSubfolder?: string
      /** (fix 384) Combined file ALREADY assembled by extension workflow
       *  (segmented decode + single encode) — ffmpeg not needed, only
       *  metadata with ACTUAL result parameters (file probe):
       *  video_length/resolution/duration for latent lossless resolver
       *  and meta dialog. outName = ready file name in output/. */
      metaOnly?: boolean
    }
    // (fix 716) Numbers are validated: previously body.fade = "abc" yielded NaN
    // (Math.min(3, "abc") → NaN), and xfade received duration=NaN → ffmpeg
    // crashed with 500 instead of clear 400. headTrims without array check gave
    // ".map is not a function" → also 500.
    const num = (v: unknown, def: number, lo: number, hi: number): number => {
      const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
      if (!Number.isFinite(n)) return def
      return Math.max(lo, Math.min(hi, n))
    }
    const fadeSec = num(body.fade, 1, 0, 3)
    const seamFadeSec = num(body.seamFadeSeconds, fadeSec, 0, 3)
    const sourceTrim = num(body.sourceTrimSeconds, 0, 0, 10)
    const headTrimsRaw = Array.isArray(body.headTrims) ? body.headTrims : []
    const headTrims = headTrimsRaw.map((t) => num(t, 0, 0, 10))

    // Normalize inputs: legacy 2-input shape → [source, generated].
    const inputs: InputSpec[] = []
    if (Array.isArray(body.inputs) && body.inputs.length >= 2) {
      for (const it of body.inputs) {
        if (it && typeof it.name === 'string' && it.name.trim()) {
          inputs.push({ name: it.name.trim(), subfolder: it.subfolder || '', kind: it.kind || 'output' })
        }
      }
    } else if (body.source && body.generated) {
      inputs.push({ name: body.source.trim(), subfolder: '', kind: 'source' })
      inputs.push({ name: body.generated.trim(), subfolder: '', kind: 'output' })
    }

    // (fix 384) metaOnly does not require two inputs — ffmpeg is not invoked
    if (!body.metaOnly && inputs.length < 2) {
      return NextResponse.json(
        { error: 'Provide at least 2 inputs (source + generated, or inputs[] array)' },
        { status: 400 },
      )
    }

    const cfg = getAppConfig()
    const inputDir = cfg.inputDir
    const outputDir = cfg.outputDir
    const outputRoot = path.resolve(outputDir)

    // ─── (fix 384) metaOnly: file already assembled by workflow — metadata only ───
    if (body.metaOnly) {
      let mName = (body.outName || '').replace(/[\\/:*?"<>|]/g, '_')
      mName = path.basename(mName)
      if (!mName) {
        return NextResponse.json({ error: 'outName required for metaOnly' }, { status: 400 })
      }
      // (fix 716) Multi-level outSubfolder — same as other file
      // routes (sanitizeFolderPath, fix 495). Previously only
      // ONE segment was accepted, whereas the client sends output_subfolder of the generated
      // clip here (use-video-gen.ts) — for a nested project folder like
      // 'project/scenes' concat responded 400 Invalid outSubfolder, and the final
      // video was not created.
      const mSub = sanitizeFolderPath(body.outSubfolder || '')
      const mPath = path.resolve(path.join(outputDir, ...(mSub ? mSub.split('/') : []), mName))
      if (mPath !== outputRoot && !mPath.startsWith(outputRoot + path.sep)) {
        return NextResponse.json({ error: 'Invalid path' }, { status: 400 })
      }
      if (!existsSync(mPath)) {
        return NextResponse.json({ error: `File not found: ${mName}` }, { status: 404 })
      }
      let actual: { width: number; height: number; frames: number; durationSec: number } | null = null
      try {
        const pr = await probeVideoFile(mPath)
        if (pr.width > 0 && pr.height > 0 && pr.frames > 0) {
          actual = { width: pr.width, height: pr.height, frames: pr.frames, durationSec: pr.durationSec }
        }
      } catch { /* without actual fields — record as received */ }
      if (body.meta && typeof body.meta === 'object') {
        try {
          writeMetaSidecar(mName, mSub, {
            ...body.meta,
            ...(actual && {
              video_length: actual.frames,
              duration_seconds: Number(actual.durationSec.toFixed(2)),
              resolution: `${actual.width}x${actual.height}`,
              fps: 24,
            }),
            combined_from: inputs.map((i2) => i2.name),
            created_at: Date.now() / 1000,
          })
        } catch { /* sidecar is not critical */ }
      }
      return NextResponse.json({
        filename: mName,
        subfolder: mSub,
        audio: true,
        input_count: inputs.length,
        url: `/api/comfy/file?filename=${encodeURIComponent(mName)}${mSub ? `&subfolder=${encodeURIComponent(mSub)}` : ''}`,
      })
    }

    // Resolve each input path.
    // (fix 339) Validation of name/subfolder BEFORE join: basename strips
    // separators, and dot segments ('.', '..') are rejected — otherwise path.join
    // escaped above outputDir/inputDir (path traversal via concat inputs).
    const inputRoot = path.resolve(inputDir)
    const resolvedPaths: string[] = []
    for (const it of inputs) {
      const base = it.kind === 'source' ? inputDir : outputDir
      const baseRoot = it.kind === 'source' ? inputRoot : outputRoot
      const safeItName = path.basename(it.name)
      if (!safeItName || safeItName === '.' || safeItName === '..') {
        return NextResponse.json({ error: `Invalid input name: ${it.name}` }, { status: 400 })
      }
      // (fix 495) Nested folders: subfolder is a multi-level
      // relative path ('a/b'); '.'/'..' segments are stripped.
      const subSegs = sanitizeFolderPath(it.subfolder || '').split('/').filter(Boolean)
      let p = path.join(base, ...subSegs, safeItName)
      const resolvedP = path.resolve(p)
      if (resolvedP !== baseRoot && !resolvedP.startsWith(baseRoot + path.sep)) {
        return NextResponse.json({ error: `Invalid path for input: ${safeItName}` }, { status: 400 })
      }
      if (!existsSync(p) && it.kind === 'output') {
        // (fix 716) Fallback: recursive search in output/ subfolders.
        // Previously only FIRST level folders were scanned, and a clip
        // located in 'project/scenes' was not found → 404 Input not found.
        try {
          const found = await findFileRecursive(outputDir, safeItName, 3)
          if (found) p = found
        } catch { /* ignore */ }
      }
      if (!existsSync(p)) {
        return NextResponse.json({ error: `Input not found: ${it.name}` }, { status: 404 })
      }
      resolvedPaths.push(p)
    }

    const ffmpeg = await resolveFfmpeg()
    if (!ffmpeg) {
      return NextResponse.json({ error: 'FFmpeg not available' }, { status: 500 })
    }

    // Probe all inputs.
    const infos: ProbeInfo[] = []
    for (const p of resolvedPaths) {
      const info = await probeVideo(ffmpeg, p)
      if (!info) {
        return NextResponse.json({ error: `Cannot probe video: ${path.basename(p)}` }, { status: 500 })
      }
      infos.push(info)
    }

    // (fix 224) Target = FIRST CLIP (infos[1]), not source: clip
    // is generated on pass 1 canvas (fix 224 — exact aspect), and scaling
    // it back to match source would reintroduce stretching. Source is evenly
    // scaled to match output (~2% — imperceptible). Fallback infos[0].
    const targetW = infos[1]?.width || infos[0]?.width || 1280
    const targetH = infos[1]?.height || infos[0]?.height || 704
    const targetFps = 24
    const evW = targetW % 2 === 0 ? targetW : targetW + 1
    const evH = targetH % 2 === 0 ? targetH : targetH + 1

    // Build filter chain: hard-cut concat (fade=0) or xfade/acrossfade (fade>0).
    const filterParts: string[] = []
    const trim0 = sourceTrim > 0 && !!infos[0] && infos[0].duration > sourceTrim + 0.05
    for (let i = 0; i < infos.length; i++) {
      // (fix 213) First input (source) with sourceTrim: trim TAIL
      // by exactly the seam overlap duration (node fix 210) — by
      // time, audio by the same number.
      if (i === 0 && trim0) {
        const keep = (infos[0].duration - sourceTrim).toFixed(4)
        filterParts.push(`[${i}:v]fps=${targetFps},trim=duration=${keep},setpts=PTS-STARTPTS,scale=${evW}:${evH},setsar=1[v${i}]`)
        filterParts.push(`[${i}:a]aresample=44100,atrim=duration=${keep},asetpts=PTS-STARTPTS[a${i}]`)
      } else {
        // (fix 239) Removed in_color_matrix — this is NOT a valid ffmpeg filter,
        // it breaks filter graph. Color is already correct without it (fix 237 —
        // tone matching removed for clips i>0).
        // (fix 250) Heads of inputs i≥1: trim warmup prefix not consumed
        // by fade (duplicated moments of previous clip's tail).
        const ht = headTrims[i] || 0
        const headCut = ht > 0.001 ? `trim=start=${ht.toFixed(4)},setpts=PTS-STARTPTS,` : ''
        filterParts.push(`[${i}:v]${headCut}scale=${evW}:${evH},setsar=1,fps=${targetFps}[v${i}]`)
      }
    }

    if (fadeSec === 0) {
      // (fix 292) Hybrid mode: fade=0 + seamFadeSec>0 →
      // first seam (source→clip 0) is xfade with seamFadeSec,
      // other seams are hard cut. Without seamFadeSec — all hard cut.
      if (seamFadeSec > 0.001 && infos.length >= 2) {
        // xfade on first seam: [v0][v1]xfade→[v1]
        const offset_0 = Math.max(0, (infos[0].duration - (trim0 ? sourceTrim : 0)) - seamFadeSec)
        filterParts.push(
          `[v0][v1]xfade=transition=fade:duration=${seamFadeSec.toFixed(3)}:offset=${offset_0.toFixed(3)}[v1]`,
        )
        // concat for the rest: [v1][v2][v3]...concat
        const rest = infos.slice(1).map((_, i) => `[v${i + 1}]`).join('')
        filterParts.push(`${rest}concat=n=${infos.length - 1}:v=1:a=0[vout]`)
        // Audio: acrossfade on first seam, then concat
        if (trim0) {
          // [0:a] already trimmed
        } else {
          filterParts.push(`[0:a]aresample=44100[a0]`)
        }
        for (let i = 1; i < infos.length; i++) {
          const ht = headTrims[i] || 0
          const ahead = ht > 0.001 ? `atrim=start=${ht.toFixed(4)},asetpts=PTS-STARTPTS,` : ''
          filterParts.push(`[${i}:a]${ahead}aresample=44100[a${i}]`)
        }
        filterParts.push(`[a0][a1]acrossfade=d=${seamFadeSec.toFixed(3)}[a1]`)
        const restA = infos.slice(1).map((_, i) => `[a${i + 1}]`).join('')
        filterParts.push(`${restA}concat=n=${infos.length - 1}:v=0:a=1[aout]`)
      } else {
        // Pure hard-cut concat: no overlap, full duration preserved.
        const videoConcat = infos.map((_, i) => `[v${i}]`).join('') + `concat=n=${infos.length}:v=1:a=0[vout]`
        filterParts.push(videoConcat)
        for (let i = 0; i < infos.length; i++) {
          if (i === 0 && trim0) continue // [0:a] already consumed in trim
          const ht = i >= 1 ? (headTrims[i] || 0) : 0
          const ahead = ht > 0.001 ? `atrim=start=${ht.toFixed(4)},asetpts=PTS-STARTPTS,` : ''
          filterParts.push(`[${i}:a]${ahead}aresample=44100[a${i}]`)
        }
        const audioConcat = infos.map((_, i) => `[a${i}]`).join('') + `concat=n=${infos.length}:v=0:a=1[aout]`
        filterParts.push(audioConcat)
      }
    } else {
      // N-way xfade chain (fix 182, final):
      // After each xfade intermediate output duration is
      //   prev_out_dur + d[next] - fadeSec
      // Therefore offset of next xfade is calculated from RUNNING duration
      // of intermediate output, NOT from sum of input clips.
      //
      // Verification: 3 clips of 5.17s each, fade=1s
      //   running = 5.17
      //   offset_0 = 5.17 - 1 = 4.17 → out dur = 5.17+5.17-1 = 9.34
      //   offset_1 = 9.34 - 1 = 8.34 → out dur = 9.34+5.17-1 = 13.51
      //   TOTAL: 13.51s ✅ (matches manual ffmpeg)
      //
      // Old formula (cumulative += d[i]; offset = cumulative - fadeSec)
      // produced offset_1 = 9.34, which EXCEEDED the boundary of intermediate output
      // (duration 9.34s), ffmpeg trimmed the tail and output was 9.33s.
      let running = infos[0].duration - (trim0 ? sourceTrim : 0)
      for (let i = 0; i < infos.length - 1; i++) {
        // (fix 218) First seam — "source → clip 0": content on both
        // sides is identical (seam overlap), long fade is invisible, but
        // covers change in image character. Other seams — short fade.
        const f = i === 0 ? seamFadeSec : fadeSec
        const offset_i = Math.max(0, running - f)
        filterParts.push(
          `[v${i}][v${i + 1}]xfade=transition=fade:duration=${f}:offset=${offset_i.toFixed(3)}[v${i + 1}]`,
        )
        // (fix 250) next input is shorter by its head trim
        running += infos[i + 1].duration - (headTrims[i + 1] || 0) - f
      }

      // Audio chain: acrossfade between consecutive clips.
      // (fix 250) head trim synchronous with video stream.
      for (let i = 0; i < infos.length; i++) {
        if (i === 0 && trim0) continue // [0:a] already consumed in trim
        const ht = i >= 1 ? (headTrims[i] || 0) : 0
        const ahead = ht > 0.001 ? `atrim=start=${ht.toFixed(4)},asetpts=PTS-STARTPTS,` : ''
        filterParts.push(`[${i}:a]${ahead}aresample=44100[a${i}]`)
      }
      for (let i = 0; i < infos.length - 1; i++) {
        filterParts.push(`[a${i}][a${i + 1}]acrossfade=d=${i === 0 ? seamFadeSec : fadeSec}[a${i + 1}]`)
      }
    }

    let outName = (body.outName || `Minimax_Studio_combined_${infos.length}`).replace(/[\\/:*?"<>|]/g, '_')
    outName = path.basename(outName)
    if (!/\.mp4$/i.test(outName)) outName = outName + '.mp4'
    // (fix 342) Fixed name + '-y' quietly overwritten previous
    // concat result — counter loop, same as in /api/comfy/trim.
    // (fix 716) Multi-level outSubfolder (same as other file
    // routes — sanitizeFolderPath, fix 495). Previously only
    // ONE segment was accepted, whereas the client sends output_subfolder of the generated
    // clip here (use-video-gen.ts) — for a nested project folder like
    // 'project/scenes' concat responded 400 Invalid outSubfolder, and the final
    // video was not created.
    const outSub = sanitizeFolderPath(body.outSubfolder || '')
    const outExt = path.extname(outName)
    const outStem = outName.slice(0, outName.length - outExt.length)
    let outPath = path.join(outputDir, ...(outSub ? outSub.split('/') : []), outName)
    {
      let counter = 1
      while (existsSync(outPath)) {
        outName = `${outStem}_${counter++}${outExt}`
        outPath = path.join(outputDir, ...(outSub ? outSub.split('/') : []), outName)
        if (counter > 100) {
          return NextResponse.json({ error: 'Too many combined outputs' }, { status: 500 })
        }
      }
    }
    await fs.mkdir(path.dirname(outPath), { recursive: true })

    const inputArgs: string[] = []
    for (const p of resolvedPaths) {
      inputArgs.push('-i', p)
    }

    // Determine output label based on concat mode.
    const vOutLabel = fadeSec === 0 ? 'vout' : `v${infos.length - 1}`
    const aOutLabel = fadeSec === 0 ? 'aout' : `a${infos.length - 1}`

    // (fix 213a) outPath goes LAST: previously -map [a..]/-c:a were appended
    // AFTER the filename — ffmpeg treated them as options of phantom "second
    // output", [a1] remained unbound, and ALL concats lost audio.
    const baseArgs = [
      '-hide_banner', '-loglevel', 'error',
      ...inputArgs,
      '-filter_complex', filterParts.join(';'),
      '-map', `[${vOutLabel}]`,
      // (fix 386) codec/quality — from studio [video] settings
      '-preset', 'fast', ...ffmpegVideoArgs(getVideoFormatSettings()),
      '-movflags', '+faststart',
      '-y',
    ]

    let usedAudio = true
    const audioArgs = ['-map', `[${aOutLabel}]`, '-c:a', 'aac', '-b:a', '192k', outPath]
    try {
      await execFileAsync(ffmpeg, [...baseArgs, ...audioArgs], {
        timeout: 600_000, maxBuffer: 32 * 1024 * 1024,
      })
    } catch (err: unknown) {
      // Retry without audio (some clips may lack audio streams).
      const e = err as { stderr?: string; message?: string }
      const stderr = e.stderr || e.message || String(err)
      console.error('[concat] FFmpeg with-audio FAILED:', stderr.slice(0, 800))
      usedAudio = false
      const noAudioFilter = filterParts.filter((s) => !s.includes('[a') && !s.includes('acrossfade') && !s.includes('[aout]'))
      try {
        await execFileAsync(
          ffmpeg,
          [
            '-hide_banner', '-loglevel', 'error',
            ...inputArgs,
            '-filter_complex', noAudioFilter.join(';'),
            '-map', `[${vOutLabel}]`,
            '-an',
            // (fix 386) codec/quality — from studio [video] settings
            '-preset', 'fast', ...ffmpegVideoArgs(getVideoFormatSettings()),
            '-movflags', '+faststart',
            '-y',
            outPath,
          ],
          { timeout: 600_000, maxBuffer: 32 * 1024 * 1024 },
        )
      } catch {
        throw new Error(`FFmpeg concat failed: ${stderr.slice(0, 600)}`)
      }
    }

    // (fix 260) Metadata of combined file (e.g. extension
    // result): caller passes prepared parameters — here
    // we only add service fields. Without meta, sidecar is not written (route
    // is used by other callers too).
    if (body.meta && typeof body.meta === 'object') {
      try {
        // (fix 293) Inheritance from extension source sidecar
        // (references / extend_prompts chain / source_prompt — mergeExtendMeta
        // in src/lib/extend-meta.ts). Look for sidecar
        // in output root and, as fallback, in first-level subfolders (same
        // as inputs above). If no sidecar — write meta as received.
        let sourceMeta: Record<string, unknown> | null = null
        const sv = (body.meta as { source_video?: { name?: unknown } }).source_video
        const srcName = typeof sv?.name === 'string' && sv.name ? path.basename(sv.name) : ''
        if (srcName) {
          const outputRoot = path.resolve(outputDir)
          const candidates = [path.join(outputDir, srcName + '.meta.json')]
          try {
            for (const entry of await fs.readdir(outputDir, { withFileTypes: true })) {
              if (entry.isDirectory()) candidates.push(path.join(outputDir, entry.name, srcName + '.meta.json'))
            }
          } catch { /* ignore */ }
          for (const c of candidates) {
            const resolved = path.resolve(c)
            if (!resolved.startsWith(outputRoot + path.sep) && resolved !== outputRoot) continue
            if (!existsSync(resolved)) continue
            try {
              sourceMeta = JSON.parse(await fs.readFile(resolved, 'utf-8')) as Record<string, unknown>
            } catch { /* corrupted sidecar — no inheritance */ }
            break
          }
        }
        // (fix 383) ACTUAL parameters of FINAL file (ffprobe):
        // video_length/resolution/duration. Previously meta carried parameters
        // of JOB (clip duration, not concat) — now they match
        // real file; this is also required for lossless branch: latent resolver
        // matches video_length/resolution of meta against mp4 probe.
        let actual: { width: number; height: number; frames: number; durationSec: number } | null = null
        try {
          const pr = await probeVideoFile(outPath)
          if (pr.width > 0 && pr.height > 0 && pr.frames > 0) {
            actual = { width: pr.width, height: pr.height, frames: pr.frames, durationSec: pr.durationSec }
          }
        } catch { /* probe is not critical: meta without actual fields */ }
        writeMetaSidecar(outName, outSub, { // (fix 365) sidecar next to result
          ...mergeExtendMeta(body.meta as Record<string, unknown>, sourceMeta),
          ...(actual && {
            video_length: actual.frames,
            duration_seconds: Number(actual.durationSec.toFixed(2)),
            resolution: `${actual.width}x${actual.height}`,
            fps: 24,
          }),
          combined_from: inputs.map((i2) => i2.name),
          combined_audio: usedAudio,
          created_at: Date.now() / 1000,
        })
      } catch { /* sidecar is not critical for concat itself */ }
    }

    return NextResponse.json({
      filename: outName,
      subfolder: outSub, // (fix 365)
      audio: usedAudio,
      input_count: infos.length,
      url: `/api/comfy/file?filename=${encodeURIComponent(outName)}${outSub ? `&subfolder=${encodeURIComponent(outSub)}` : ''}`,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

/** Probe a video file for duration, width, height, fps. */
async function probeVideo(ffmpeg: string, filePath: string): Promise<ProbeInfo | null> {
  let stderr = ''
  try {
    const r = await execFileAsync(ffmpeg, ['-hide_banner', '-i', filePath], { timeout: 15_000 })
    stderr = r.stderr ?? ''
  } catch (e) {
    stderr = (e as { stderr?: string }).stderr ?? ''
  }

  const durM = /Duration:\s*(\d+):(\d{2}):(\d{2}\.\d{2})/.exec(stderr)
  const duration = durM
    ? Number(durM[1]) * 3600 + Number(durM[2]) * 60 + Number(durM[3])
    : 0

  // (fix 359) Resolution — only from video stream line, otherwise general
  // regex grabbed other NxM from container tags/metadata.
  const videoLine = stderr.split('\n').find((l) => /Stream #.*Video:/.test(l)) ?? stderr
  const resM = /(\d{2,5})x(\d{2,5})/.exec(videoLine)
  let width = resM ? parseInt(resM[1], 10) : 0
  let height = resM ? parseInt(resM[2], 10) : 0

  // (fix 218) SAR≠1: target scale is DISPLAY aspect (how file looks on
  // playback), otherwise source with square pixels would distort
  // into storage proportions, and clip (generated by display) — vice versa.
  const sarM = /SAR (\d+):(\d+) DAR (\d+):(\d+)/.exec(stderr)
  if (sarM) {
    const sarW = parseInt(sarM[1], 10)
    const sarH = parseInt(sarM[2], 10)
    if (sarW > 0 && sarH > 0 && sarW !== sarH) {
      const w = 2 * Math.round((width * sarW) / 2)
      const h = 2 * Math.round((height * sarH) / 2)
      if (w > 0 && h > 0) { width = w; height = h }
    }
  }

  const fpsM = /([\d.]+)\s*fps/.exec(stderr)
  const fps = fpsM ? parseFloat(fpsM[1]) : 24

  if (duration <= 0 || width <= 0 || height <= 0) return null
  return { duration, width, height, fps }
}