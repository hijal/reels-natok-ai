/**
 * video-format (fix 386) — UNIFIED encoding settings for studio video outputs
 * (config.ini → [video]). Applied in ALL modes:
 * generation (draft/full), refine "Full"/"Tiled", extend
 * (combined output and headless clips), tiled upscale, FPS, and
 * ffmpeg paths (trim, concat, stitch).
 *
 * Codecs (VHS VideoHelperSuite formats, ffmpeg — same encoders):
 *  • h264       — libx264, maximum compatibility (default)
 *  • h265       — libx265, files ~30–50% smaller at the same CRF
 *  • nvenc_h264 — h264_nvenc, NVIDIA hardware encoder (fast, quality
 *                 specified by bitrate, not CRF)
 *  • nvenc_h265 — hevc_nvenc, same + compactness
 *
 * Quality: CRF 0–30 (lower = better; default 12 — as previously in studio).
 * For nvenc — bitrate in Mbps (default 16).
 *
 * PURE MODULE (no fs/config): imported by client modules as well
 * (workflow templates are imported into use-video-gen for framesForDuration).
 * Reading config.ini is in video-format-server.ts (server only): routes and
 * minimax-h3-client pass prepared settings via videoFormat parameter.
 */
export type VideoCodec = 'h264' | 'h265' | 'nvenc_h264' | 'nvenc_h265'

export const VIDEO_CODECS: VideoCodec[] = ['h264', 'h265', 'nvenc_h264', 'nvenc_h265']

export interface VideoFormatSettings {
  codec: VideoCodec
  /** CRF for software codecs (h264/h265), 0–30. */
  crf: number
  /** Bitrate for NVENC, Mbps (4–40). */
  nvencBitrate: number
}

export function normalizeVideoFormat(raw: {
  codec?: unknown
  crf?: unknown
  nvencBitrate?: unknown
}): VideoFormatSettings {
  const codec = VIDEO_CODECS.includes(raw.codec as VideoCodec)
    ? (raw.codec as VideoCodec)
    : 'h264'
  // (fix 587) crf=0 is valid (fix 556): default 12 — only if value is
  // absent (undefined/null/empty string/NaN); || 12 silently turned genuine 0 into 12
  // (Number('') and Number(null) are also 0, so check before conversion).
  const emptyCrf = raw.crf === undefined || raw.crf === null ||
    (typeof raw.crf === 'string' && raw.crf.trim() === '')
  const crfNum = emptyCrf ? NaN : Number(raw.crf)
  const crf = Math.max(0, Math.min(30, Math.round(Number.isFinite(crfNum) ? crfNum : 12)))
  const nvencBitrate = Math.max(4, Math.min(40, Math.round(Number(raw.nvencBitrate) || 16)))
  return { codec, crf, nvencBitrate }
}

/**
 * Inputs for VHS_VideoCombine node for the selected codec/quality — spread into
 * workflow inputs (replaces format/pix_fmt/crf/trim_to_audio).
 * Caveat: trim_to_audio exists only for formats where it is declared in JSON
 * (h264); h265/nvenc don't have it — extra input fails node validation.
 */
/** Default (without settings): previous studio behavior — h264 / CRF 12. */
export const DEFAULT_VIDEO_FORMAT: VideoFormatSettings = { codec: 'h264', crf: 12, nvencBitrate: 16 }

export function vhsEncodeInputs(fmt?: VideoFormatSettings): Record<string, unknown> {
  const f = fmt ?? DEFAULT_VIDEO_FORMAT
  switch (f.codec) {
    case 'h265':
      return { format: 'video/h265-mp4', pix_fmt: 'yuv420p', crf: f.crf }
    case 'nvenc_h264':
      return { format: 'video/nvenc_h264-mp4', pix_fmt: 'yuv420p', bitrate: f.nvencBitrate, megabit: true }
    case 'nvenc_h265':
      return { format: 'video/nvenc_h265-mp4', pix_fmt: 'yuv420p', bitrate: f.nvencBitrate, megabit: true }
    default:
      return { format: 'video/h264-mp4', pix_fmt: 'yuv420p', crf: f.crf, trim_to_audio: false }
  }
}

/**
 * ffmpeg arguments for video encoding (trim/concat/stitch routes).
 * Caller adds its own -preset and specific flags (pix_fmt etc.).
 */
export function ffmpegVideoArgs(fmt?: VideoFormatSettings): string[] {
  const f = fmt ?? DEFAULT_VIDEO_FORMAT
  switch (f.codec) {
    case 'h265':
      return ['-c:v', 'libx265', '-crf', String(f.crf), '-tag:v', 'hvc1']
    case 'nvenc_h264':
      return ['-c:v', 'h264_nvenc', '-b:v', `${f.nvencBitrate}M`]
    case 'nvenc_h265':
      return ['-c:v', 'hevc_nvenc', '-b:v', `${f.nvencBitrate}M`, '-tag:v', 'hvc1']
    default:
      return ['-c:v', 'libx264', '-crf', String(f.crf)]
  }
}
