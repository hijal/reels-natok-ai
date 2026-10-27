/**
 * video-format-server (edit 386) — server-side half of video format settings:
 * reads config.ini → [video]. Import ONLY from server-side code (routes,
 * minimax-h3-client) — this module pulls in fs via app-config.
 * The template input/arguments themselves are pure functions in video-format.ts.
 */
import { getAppConfig } from './app-config'
import { normalizeVideoFormat, type VideoFormatSettings } from './video-format'

/** Current format settings from config.ini (with safe defaults). */
export function getVideoFormatSettings(): VideoFormatSettings {
  try {
    const cfg = getAppConfig() as {
      videoCodec?: unknown
      videoCrf?: unknown
      videoNvencBitrate?: unknown
    }
    return normalizeVideoFormat({
      codec: cfg.videoCodec,
      crf: cfg.videoCrf,
      nvencBitrate: cfg.videoNvencBitrate,
    })
  } catch {
    return { codec: 'h264', crf: 12, nvencBitrate: 16 }
  }
}
