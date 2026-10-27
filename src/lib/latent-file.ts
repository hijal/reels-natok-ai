/**
 * latent-file (fix 375/376) — working with .latent files of the
 * "draft → refine" pipeline (MiniMaxStudioSaveAVLatent node, fix 372).
 *
 * Format: safetensors with video_samples/audio_samples tensors and JSON header
 * in metadata → {"minimax_av_latent": "{\"fps\":24,\"vae\":…,\"version\":1}"}.
 * The header is read WITHOUT loading tensors: safetensors stores the length of JSON header
 * in the first 8 bytes (u64 LE), the header itself immediately follows them.
 *
 * Latent is valid only with the same video VAE: when changing VAE, old files
 * are invalidated — we verify the name in the header against current VAELoader
 * (the project has only one video VAE: minimax_h3_video_vae_int8_convrot).
 */
import fs from 'fs'
import path from 'path'
import { getAppConfig } from '@/lib/app-config'

/** Name of the video VAE used by studio workflow builder ('46:3' VAELoader). */
export const VIDEO_VAE_NAME = 'minimax_h3_video_vae_int8_convrot.safetensors'

export interface LatentHeader {
  fps: number
  vae: string
  version: number
}

export interface LatentCheck {
  ok: boolean
  reason?: string
  header?: LatentHeader
  /** Pixel canvas of the latent (latent × 16, VAE_DOWNSAMPLE in upscaler node),
   *  number of video tokens and audio steps — from shape of tensors
   *  video_samples/audio_samples in safetensors header, without loading them. */
  dims?: { width: number; height: number; tokens: number; audioSteps: number }
}

/**
 * Check .latent file (path relative to ComfyUI output/) before passing
 * to refine: exists, inside output/, safetensors header parsed, both
 * tensors present, format version and VAE match current ones.
 * Tensors are NOT read — this is a cheap check before queueing the job.
 */
export function validateLatentFile(relPath: string): LatentCheck {
  const OUTPUT_DIR = getAppConfig().outputDir
  if (!OUTPUT_DIR || !relPath) return { ok: false, reason: 'latent path not specified' }

  // (fix 348 pattern) resolve + lowercase on win32 — otherwise
  // startsWith check passed '..\' or a foreign prefix with different casing.
  const root = path.resolve(OUTPUT_DIR)
  const full = path.resolve(root, relPath)
  const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p)
  if (norm(full) !== norm(root) && !norm(full).startsWith(norm(root) + path.sep)) {
    return { ok: false, reason: 'path outside output/' }
  }

  let st: fs.Stats
  try {
    st = fs.statSync(full)
  } catch {
    return { ok: false, reason: 'latent file not found' }
  }
  if (!st.isFile() || st.size < 16) return { ok: false, reason: 'latent file is empty/corrupted' }

  const fd = fs.openSync(full, 'r')
  try {
    const lenBuf = Buffer.alloc(8)
    fs.readSync(fd, lenBuf, 0, 8, 0)
    const headerLen = Number(lenBuf.readBigUInt64LE(0))
    if (!Number.isFinite(headerLen) || headerLen <= 0 || headerLen > 16 * 1024 * 1024) {
      return { ok: false, reason: 'corrupted safetensors header' }
    }
    const headBuf = Buffer.alloc(headerLen)
    fs.readSync(fd, headBuf, 0, headerLen, 8)
    const header = JSON.parse(headBuf.toString('utf-8')) as {
      video_samples?: { shape?: number[] }
      audio_samples?: { shape?: number[] }
      __metadata__?: Record<string, string>
    }
    if (!header.video_samples || !header.audio_samples) {
      return { ok: false, reason: 'no video/audio tensor pair in file' }
    }
    // (fixes 381/382) Pixel canvas from shape: last two dimensions
    // of video latent = (H_lat, W_lat), pixels = latent × 16 (VAE_DOWNSAMPLE
    // of MinimaxH3LatentUpscaler3D node: VAE 8× + patch 2×). tokens = shape[-3],
    // audio steps = last dimension of audio latent (frames × 5/3).
    const vShape = header.video_samples.shape
    const aShape = header.audio_samples.shape
    const dims =
      Array.isArray(vShape) && vShape.length >= 3 &&
      Number.isFinite(vShape[vShape.length - 1]) && Number.isFinite(vShape[vShape.length - 2])
        ? {
            width: Math.max(32, Math.round(vShape[vShape.length - 1] * 16)),
            height: Math.max(32, Math.round(vShape[vShape.length - 2] * 16)),
            tokens: Math.max(1, Math.round(vShape[vShape.length - 3] ?? 1)),
            audioSteps: Array.isArray(aShape) && aShape.length >= 1 && Number.isFinite(aShape[aShape.length - 1])
              ? Math.max(1, Math.round(aShape[aShape.length - 1]))
              : 0,
          }
        : undefined
    const raw = header.__metadata__?.minimax_av_latent
    if (typeof raw !== 'string') return { ok: false, reason: 'missing minimax_av_latent header' }
    const info = JSON.parse(raw) as LatentHeader
    if (info.version !== 1) return { ok: false, reason: `format version ${info.version} ≠ 1` }
    if (info.vae !== VIDEO_VAE_NAME) {
      return { ok: false, reason: `latent VAE (${info.vae}) does not match current` }
    }
    return { ok: true, header: info, dims }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  } finally {
    fs.closeSync(fd)
  }
}
