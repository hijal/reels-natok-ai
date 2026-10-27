/**
 * Upscale results metadata (edit 94).
 *
 * Videos created by the DLSS bridge (neural rendering "..._DLSS5_...") and
 * real upscaling (RTX Video SDK "..._RTXVIDEO_...") land in ComfyUI's shared
 * output directly from the bridge — no one writes a .meta.json sidecar for
 * them, so in the gallery they lack "file info" (the metadata dialog is empty).
 *
 * Here: ffprobe (the same binary as for previews) extracts resolution,
 * duration, fps, and size — and writes a flat sidecar next to the file,
 * in the same schema read by MetaDialog.
 *
 * (edit 265) If the source is known (sourceHint from bridge) and a sidecar
 * exists next to it in output — inherit the prompt chain (prompt, including
 * extend chains via promptChainFromMeta) and image references (references).
 */
import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs'
import path from 'path'
import { getAppConfig } from './app-config'
import { promptChainFromMeta } from './refine-meta'

const execFileAsync = promisify(execFile)

/** Determine "tool" by filename (using the same markers as the gallery). */
export function upscaleToolFor(filename: string): string {
  if (/_RTXVIDEO(?:_PREVIEW)?_\d{8}-\d{6}/i.test(filename)) {
    return 'RTX Video Super Resolution (upscale)'
  }
  if (/_DLSS5_\d{8}-\d{6}/i.test(filename)) {
    return 'DLSS 5 Visual Enhancer (neural rendering)'
  }
  return 'Upscale (DLSS bridge)'
}

/* ── ffprobe: same lookup order as ffmpeg in thumb.ts ── */

let ffprobeBin: string | null = null

function resolveFfprobeSync(): string {
  const ext = process.platform === 'win32' ? '.exe' : ''
  const runtimeDir = path.join(process.cwd(), 'runtime', 'ffmpeg')
  const candidates = [
    process.env.FFPROBE_PATH,
    path.join(runtimeDir, `ffprobe${ext}`),
    'ffprobe',
  ].filter(Boolean) as string[]
  for (const bin of candidates) {
    if (existsSync(bin) || !bin.includes(path.sep)) return bin
  }
  return ''
}

async function resolveFfprobe(): Promise<string> {
  if (ffprobeBin !== null) return ffprobeBin
  const bin = resolveFfprobeSync()
  if (!bin) {
    // (edit 587) DO NOT cache "not found" (like resolveFfmpeg, edit 355):
    // ffprobe could be placed into runtime/ later — retry lookup.
    return ''
  }
  try {
    await execFileAsync(bin, ['-version'], { timeout: 10_000 })
    ffprobeBin = bin
    return bin
  } catch {
    return '' // (edit 587) failure is not cached
  }
}

interface ProbeResult {
  width?: number
  height?: number
  fps?: number
  duration?: number
  /** (edit 722) Frame count — from nb_frames (fallback: fps × duration). */
  frames?: number
}

async function probeVideo(file: string): Promise<ProbeResult> {
  const bin = await resolveFfprobe()
  if (!bin) return {}
  try {
    const { stdout } = await execFileAsync(
      bin,
      [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height,avg_frame_rate,nb_frames',
        '-show_entries', 'format=duration',
        '-of', 'json',
        file,
      ],
      { timeout: 15_000 },
    )
    const j = JSON.parse(stdout) as {
      streams?: Array<{ width?: number; height?: number; avg_frame_rate?: string; nb_frames?: string }>
      format?: { duration?: string }
    }
    const s = j.streams?.[0]
    const out: ProbeResult = {}
    if (s?.width && s?.height) {
      out.width = s.width
      out.height = s.height
    }
    if (s?.avg_frame_rate && s.avg_frame_rate.includes('/')) {
      const [num, den] = s.avg_frame_rate.split('/').map(Number)
      if (Number.isFinite(num) && Number.isFinite(den) && den > 0) {
        out.fps = Math.round((num / den) * 100) / 100
      }
    }
    const dur = Number(j.format?.duration)
    if (Number.isFinite(dur) && dur > 0) out.duration = Math.round(dur * 100) / 100
    // (edit 722) Frame count: nb_frames (more accurate) → fps × duration.
    const nb = Number(s?.nb_frames)
    if (Number.isFinite(nb) && nb > 0) {
      out.frames = Math.round(nb)
    } else if (out.fps && out.duration) {
      out.frames = Math.max(1, Math.round(out.fps * out.duration))
    }
    return out
  } catch {
    return {}
  }
}

/**
 * Write .meta.json for upscale result if it doesn't exist yet.
 * Idempotent: bridge may return 'done' for several polls in a row.
 * Returns true if sidecar was written (or already existed).
 */
export async function ensureUpscaleMeta(
  outputPath: string,
  jobId: string,
  sourceHint?: unknown,
): Promise<boolean> {
  try {
    const OUTPUT_DIR = path.resolve(getAppConfig().outputDir)
    const file = path.resolve(outputPath)
    // (edit 587) like edit 348 (latent-file.ts): case-insensitive on win32 —
    // the bridge (python) may return path in different casing.
    const normPath = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p)
    if (!normPath(file).startsWith(normPath(OUTPUT_DIR) + path.sep)) return false // alien path
    if (!existsSync(file)) return false

    const metaFile = file + '.meta.json'
    if (existsSync(metaFile)) return true

    const name = path.basename(file)
    let size = 0
    let mtime = 0
    try {
      const st = statSync(file)
      size = st.size
      mtime = Math.floor(st.mtimeMs / 1000)
    } catch { /* ignore */ }

    const probe = await probeVideo(file)

    // Source: bridge puts different fields in output — take any string
    // path field other than the result itself (best effort).
    let sourceFile: string | null = null
    if (typeof sourceHint === 'string' && sourceHint && sourceHint !== outputPath) {
      sourceFile = path.basename(sourceHint)
    }

    // (edit 265) Inheritance from source sidecar: prompt chain
    // (promptChainFromMeta: source_prompt → prompt → extend_prompts — same
    // logic as refine; refine-meta only imports app-config,
    // so no circular dependency) and image references. sourceHint is full
    // path or name; search sidecar strictly inside outputDir: first relative
    // to root, then basename in root and 1st-level subfolders.
    let srcMeta: Record<string, unknown> | null = null
    if (typeof sourceHint === 'string' && sourceHint) {
      const candidates: string[] = []
      const resolvedHint = path.resolve(sourceHint)
      if (resolvedHint.startsWith(OUTPUT_DIR + path.sep)) {
        candidates.push(resolvedHint + '.meta.json')
      }
      const base = path.basename(sourceHint)
      candidates.push(path.join(OUTPUT_DIR, base + '.meta.json'))
      try {
        for (const entry of readdirSync(OUTPUT_DIR, { withFileTypes: true })) {
          if (entry.isDirectory()) candidates.push(path.join(OUTPUT_DIR, entry.name, base + '.meta.json'))
        }
      } catch { /* ignore */ }
      for (const c of candidates) {
        if (!existsSync(c)) continue
        try {
          srcMeta = JSON.parse(readFileSync(c, 'utf-8')) as Record<string, unknown>
        } catch { /* corrupted sidecar — skip inheritance */ }
        break
      }
    }
    const inheritedPrompt = srcMeta ? promptChainFromMeta(srcMeta) : null
    const srcRefsRaw = srcMeta
      ? (Array.isArray(srcMeta.references) ? srcMeta.references
        : Array.isArray(srcMeta.minimax_h3_references) ? srcMeta.minimax_h3_references
        : [])
      : []
    const inheritedRefs = (srcRefsRaw as Array<{ type?: string; path?: string; role?: string }>)
      .filter((r) => r && r.type === 'image' && typeof r.path === 'string' && r.path.length > 0)
      .map((r) => ({ type: 'image', path: r.path as string, role: typeof r.role === 'string' ? r.role : '' }))

    const meta: Record<string, unknown> = {
      job_id: jobId,
      tool: upscaleToolFor(name),
      // (edit 722) Unified sidecar schema: same as all other studio modes.
      // Previously only tool/generation_mode/created_at/file_size were here —
      // which left half the fields empty in upscale metadata dialog, and the
      // mode was not recognized by any common field.
      workflow: 'upscale-dlss5',
      model_type: 'minimax_h3_upscale',
      generation_mode: 'upscale',
      pipeline: 'full',
      created_at: mtime || Math.floor(Date.now() / 1000),
      file_size: size,
    }
    if (probe.width && probe.height) meta.resolution = `${probe.width}x${probe.height}`
    if (probe.duration !== undefined) meta.duration_seconds = probe.duration
    if (probe.fps !== undefined) meta.fps = probe.fps
    // (edit 722) Frame count — same as all other modes.
    if (probe.frames !== undefined) meta.video_length = probe.frames
    if (sourceFile) meta.source_file = sourceFile
    // (edit 722) Source video — as an object { filename, subfolder }, like in
    // other modes (refine/FPS/Tile/ControlNet).
    if (sourceFile) meta.source_video = { filename: sourceFile, subfolder: '' }
    // (edit 265) inherited fields — only if actually found
    if (inheritedPrompt) meta.prompt = inheritedPrompt
    if (inheritedRefs.length > 0) meta.references = inheritedRefs

    writeFileSync(metaFile, JSON.stringify(meta, null, 2), 'utf-8')
    return true
  } catch {
    return false
  }
}

/**
 * (edit 264) Append generation_time + DLSS settings into existing upscale
 * sidecar. Idempotent: existing fields are not overwritten.
 */
export function setUpscaleMetaGenerationTime(
  outputPath: string,
  generationTimeSec: number,
  feature?: string,
  options?: Record<string, unknown>,
): boolean {
  try {
    if (!Number.isFinite(generationTimeSec) || generationTimeSec <= 0) return false
    const OUTPUT_DIR = path.resolve(getAppConfig().outputDir)
    const file = path.resolve(outputPath)
    // (edit 587) like edit 348: case-insensitive comparison on win32.
    const normPath = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p)
    if (!normPath(file).startsWith(normPath(OUTPUT_DIR) + path.sep)) return false // alien path

    const metaFile = file + '.meta.json'
    if (!existsSync(metaFile)) return false // not yet — let ensureUpscaleMeta create it

    const meta = JSON.parse(readFileSync(metaFile, 'utf-8')) as Record<string, unknown>
    let changed = false

    if (typeof meta.generation_time !== 'number' || meta.generation_time <= 0) {
      meta.generation_time = Math.round(generationTimeSec)
      changed = true
    }
    // (edit 550) generation_mode + DLSS settings — if not yet written
    if (!meta.generation_mode) {
      meta.generation_mode = 'upscale'
      changed = true
    }
    if (feature && !meta.upscale_feature) {
      meta.upscale_feature = feature
      changed = true
    }
    if (options && typeof options === 'object' && !meta.upscale_options) {
      meta.upscale_options = options
      changed = true
    }

    if (changed) {
      writeFileSync(metaFile, JSON.stringify(meta, null, 2), 'utf-8')
    }
    return true
  } catch {
    return false
  }
}
