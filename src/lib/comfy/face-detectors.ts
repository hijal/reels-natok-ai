/**
 * (fix 722) Face Refine detectors — query combo values from ComfyUI.
 *
 * H3FaceTrackCrop declares `detector` and `fallback_detector` as combos from
 * folder_paths categories `ultralytics_bbox` / `ultralytics`. Impact Pack, which
 * usually registers them, is not installed in this build — the studio registers
 * the detectors folder itself (extra_model_paths.yaml -> models/ultralytics), and then
 * ComfyUI returns names with subfolders: `bbox\face_yolov8m.pt`,
 * `segm\person_yolov8m-seg.pt`.
 *
 * ComfyUI rejects values not in the list during prompt validation, so hardcoding
 * the name won't work: before registering the folder (or before restarting the backend)
 * the list is just `face_yolov8m.pt`, after — names with subfolders. We pick what
 * actually exists via /object_info; cache TTL is short so a newly started backend is picked up automatically.
 */
import { COMFY_URL } from './minimax-h3-client'
import { DEFAULT_FACE_DETECTOR } from './face-refine-template'

export interface FaceDetectors {
  /** Face detector — value for H3FaceTrackCrop.detector. */
  detector: string
  /** Person detector for frames without a face, or null if the model is absent. */
  fallbackDetector: string | null
}

const OK_TTL_MS = 60_000
const FAIL_TTL_MS = 10_000

let cache: { at: number; value: FaceDetectors } | null = null

/** Both forms of combo: legacy `[["a","b"], {...}]` and `["COMBO", {options}]`. */
function comboOptions(spec: unknown): string[] {
  if (!Array.isArray(spec)) return []
  const raw = Array.isArray(spec[0])
    ? spec[0]
    : (spec[1] as { options?: unknown } | undefined)?.options
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []
}

export async function resolveFaceDetectors(): Promise<FaceDetectors> {
  if (cache) {
    const ttl = cache.value.fallbackDetector ? OK_TTL_MS : FAIL_TTL_MS
    if (Date.now() - cache.at < ttl) return cache.value
  }

  let options: string[] = []
  try {
    const res = await fetch(`${COMFY_URL}/object_info/H3FaceTrackCrop`, {
      signal: AbortSignal.timeout(5000),
    })
    if (res.ok) {
      const info = (await res.json()) as {
        H3FaceTrackCrop?: { input?: { required?: Record<string, unknown> } }
      }
      options = comboOptions(info.H3FaceTrackCrop?.input?.required?.detector)
    }
  } catch {
    // ComfyUI is not responding — return default, prompt submit will fail anyway.
  }

  const detector =
    options.find((o) => /face_yolov8/i.test(o)) ??
    options.find((o) => /face/i.test(o)) ??
    options[0] ??
    DEFAULT_FACE_DETECTOR
  // Person model — usually person_yolov8m-seg; any with "person" is suitable.
  const fallbackDetector = options.find((o) => /person/i.test(o)) ?? null

  const value: FaceDetectors = { detector, fallbackDetector }
  cache = { at: Date.now(), value }
  return value
}
