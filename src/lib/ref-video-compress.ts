/**
 * (fix 493) "Compress video" for video references in the "Generate" tab.
 *
 * The reference video is loaded into conditioning as a whole — in native resolution
 * this wastes tokens and VRAM, while for a motion/scene anchor 480p is almost always
 * sufficient. When the compress flag is set, the /api/comfy/generate route runs the file
 * through ffmpeg: short side → 480 px (aspect ratio preserved, even dimension
 * via -2), audio re-encoded to aac (track needed if "use video audio" is enabled).
 *
 * Cache: output name ref480_<stem>_<hash8>.mp4, hash = path|size|mtime —
 * repeated generations with the same reference do not re-encode. Sources
 * ≤480p on the short side are returned as-is (we don't upscale).
 */
import { promises as fs } from 'fs'
import { existsSync } from 'fs'
import path from 'path'
import { createHash } from 'crypto'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { getAppConfig } from './app-config'
import { resolveFfmpeg } from './thumb'
import { probeVideoFile } from './video-probe'

const execFileAsync = promisify(execFile)

/** Returns the filename in ComfyUI input/ (compressed copy or original). */
export async function compressRefVideo480(fileName: string): Promise<string> {
  const cfg = getAppConfig()
  const base = path.basename(fileName)
  const srcPath = path.join(cfg.inputDir, base)
  if (!existsSync(srcPath)) {
    throw new Error(`file not found in input: ${base}`)
  }
  const probe = await probeVideoFile(srcPath)
  const shortSide = Math.min(probe.width, probe.height)
  if (shortSide > 0 && shortSide <= 480) {
    return base // already ≤480p — re-encoding would only lose quality
  }
  const st = await fs.stat(srcPath)
  const hash = createHash('sha1')
    .update(`${srcPath}|${st.size}|${Math.round(st.mtimeMs)}`)
    .digest('hex')
    .slice(0, 8)
  const stem = path.basename(base, path.extname(base)).replace(/[^\w.-]+/g, '_').slice(0, 40)
  const outName = `ref480_${stem}_${hash}.mp4`
  const outPath = path.join(cfg.inputDir, outName)
  if (existsSync(outPath)) return outName // cache hit — same source already compressed
  const ffmpeg = await resolveFfmpeg()
  if (!ffmpeg) throw new Error('FFmpeg is unavailable')
  // Landscape: height 480, width auto (-2 = even). Portrait is vice-versa.
  const scale = probe.width >= probe.height ? '-2:480' : '480:-2'
  await execFileAsync(
    ffmpeg,
    [
      '-hide_banner', '-loglevel', 'error', '-i', srcPath,
      '-map', '0:v:0', '-map', '0:a?',
      '-vf', `scale=${scale}`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart', '-y', outPath,
    ],
    { timeout: 300_000, maxBuffer: 8 * 1024 * 1024 },
  )
  return outName
}
