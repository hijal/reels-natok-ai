/**
 * Central runtime app configuration, backed by config.ini next to the
 * project root. The backend folder (portable ComfyUI-Easy-Install root)
 * is user-configurable from the Settings dialog — all file routes read
 * it through getAppConfig() so a change applies without a restart.
 *
 * Precedence for the backend root:
 *   1. config.ini [comfy] comfy_dir
 *   2. env COMFY_ROOT
 *   3. ./ComfyUI-Easy-Install (default, next to the app)
 */
import { readFileSync, writeFileSync, renameSync, rmSync, existsSync, statSync, mkdirSync } from 'fs'
import { dirname, join, resolve } from 'path'

const CONFIG_PATH = join(process.cwd(), 'config', 'config.ini')

export interface AppConfig {
  reserveGb: number
  dynamicVram: boolean
  /** (fix 490) Extra free VRAM headroom for DynamicVRAM (--vram-headroom,
   *  GB; 0 = off). Unlike reserveGb, acts CONTINUOUSLY (aimdo
   *  monitors via NVML, including third-party apps), rather than at decision points —
   *  protection against activation spikes that bypass reserve. */
  vramHeadroom: number
  /** LLM assistant device: 'auto' (VRAM-based) | 'gpu' | 'cpu'. */
  llmDevice: 'auto' | 'gpu' | 'cpu'
  /** LLM context window size in tokens. */
  llmContextSize: number
  /** Max output tokens per LLM response (clamped to fit inside the context window). */
  llmMaxOutputTokens: number
  /** Root of the portable backend install (contains ComfyUI/ and python_embeded/). */
  comfyRoot: string
  /** ComfyUI output directory (gallery files). */
  outputDir: string
  /** ComfyUI input directory (reference uploads). */
  inputDir: string
  /** Embedded python executable for launching the backend. */
  pythonExe: string
  /** Custom diffusion model filename (empty = default). */
  diffusionModel: string
  /** Custom LLM model filename (empty = default Q4_K_M). */
  llmModel: string
  /** (fix 136 / Bonsai) Portable build folder for Bonsai 2 27B (llama.cpp\
   * + models). Assistant model llmModel='bonsai' launches from it. */
  llmBonsaiDir: string
  /** (fix 257) Absolute path to CUSTOM assistant model (.gguf).
   *  Non-empty value = 'custom' backend: built-in engine launches
   *  with this file instead of studio models. */
  llmCustomModel: string
  /** (fix 257) mmproj file (vision) for custom model; empty = text only. */
  llmCustomMmproj: string
  /** (fix 257) Extra model directories (outside studio folder):
   *  written to ComfyUI/extra_model_paths.yaml + scanned by studio listings.
   *  Category is ComfyUI folder name (diffusion_models, loras, vae, ...). */
  modelExtraPaths: Array<{ path: string; category: string }>
  /** (fix 53) Assistant inspects video reference frames. Off by default:
   *  model only knows about the PRESENCE of video (saves context). */
  llmVideoVision: boolean
  /** (fix 109) LLM KV-cache quantization: 'off' (fp16) | 'q8_0' | 'q5_1' | 'q4_0'.
   *  Reduces VRAM/RAM usage at the expense of a slight quality decrease. */
  llmKvCache: 'off' | 'q8_0' | 'q5_1' | 'q4_0'
  /** (fix 135b) Fine-tuning of LLM sampling — ON/OFF. */
  llmSamplingOverride: boolean
  /** (fix 135b) temperature — override (if override is on). */
  llmTemperature: number
  /** (fix 135b) top_p — override (if override is on). */
  llmTopP: number
  /** (fix 135b) top_k — override (if override is on). */
  llmTopK: number
  /** (fix 135b) min_p — override (if override is on). */
  llmMinP: number
  /** (fix 135b) presence_penalty — override (if override is on). */
  llmPresencePenalty: number
  /** (fix 135b) frequency_penalty — override (if override is on). */
  llmFrequencyPenalty: number
  /** (fix 135b) repeat_penalty — override (if override is on). */
  llmRepeatPenalty: number
  /** Play notification sound when generation completes (default true). */
  soundOn: boolean
  /** (fix 65) Voice input (whisper STT): whether dictation is enabled in UI. */
  sttEnabled: boolean
  /** (fix 72) Folder of built-in STT runtime (transcribe.dll + models/). Default <project>/stt. */
  sttDir: string
  /** (fix 65) STT model file (name in model folders; empty = auto). */
  sttModel: string
  /** (fix 65) Recognition language: 'ru' | 'en' | 'auto'. */
  sttLanguage: string
  /** (fix 65) CPU threads (0 = auto). */
  sttThreads: number
  /** (fix 74) Upscale tab (DLSS 5 Visual Enhancer): service enabled. */
  upscaleEnabled: boolean
  /** (fix 74) Port of Upscale DLSS bridge (bridge.py, default 7890). */
  upscalePort: number
  /** (fix 386) [video] Video output codec: h264 | h265 | nvenc_h264 | nvenc_h265. */
  videoCodec: 'h264' | 'h265' | 'nvenc_h264' | 'nvenc_h265'
  /** (fix 386) [video] CRF for software codecs (0–30, lower = better). Default 12. */
  videoCrf: number
  /** (fix 386) [video] NVENC bitrate, Mbps (4–40). Default 16. */
  videoNvencBitrate: number
}

/* ────────────────────────── INI parsing ────────────────────────── */

/** (fix 257) [models] extra_paths — JSON array [{path, category}]. */
function parseExtraPaths(raw: string): Array<{ path: string; category: string }> {
  const s = raw.trim()
  if (!s) return []
  try {
    const parsed = JSON.parse(s)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (e): e is { path: string; category: string } =>
          !!e && typeof e === 'object' &&
          typeof (e as { path?: unknown }).path === 'string' &&
          typeof (e as { category?: unknown }).category === 'string',
      )
      .map((e) => ({ path: e.path, category: e.category }))
  } catch {
    return []
  }
}

function parseIni(content: string): Record<string, string> {
  const result: Record<string, string> = {}
  let currentSection = ''
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      currentSection = trimmed.slice(1, -1)
      continue
    }
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim()
      const value = trimmed.slice(eqIdx + 1).trim()
      result[`${currentSection}.${key}`] = value
      // (fix 318) "Bare" keys — only for actually read legacy
      // fallbacks (reserve_gb, dynamic_vram — see getAppConfig below). Previously
      // each key was also written bare: [llm] model and [stt] model overwrote
      // each other (bare ini['model'] returned value of the last section).
      if (key === 'reserve_gb' || key === 'dynamic_vram') {
        result[key] = value
      }
    }
  }
  return result
}

/* ────────────────────────── Cached reads ────────────────────────── */

/** (fix 556) Number from config.ini, where 0 is a legitimate value.
 *  Pattern "parseFloat(v) || dflt" turned saved 0 into default
 *  (llm.temperature=0 → 0.7 when sampling_override=1, video.crf=0 =
 *  maximum quality → 12): UI faithfully saved setting, but read
 *  silently substituted it. Default only when absent/non-numeric. */
function parseNum0(v: string | undefined, dflt: number): number {
  if (v === undefined || v.trim() === '') return dflt
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : dflt
}

let cache: { mtimeMs: number; config: AppConfig } | null = null

export function getAppConfig(): AppConfig {
  let mtimeMs = 0
  try {
    mtimeMs = statSync(CONFIG_PATH).mtimeMs
  } catch {
    /* no config.ini yet — use defaults below */
  }
  if (cache && cache.mtimeMs === mtimeMs) return cache.config

  let ini: Record<string, string> = {}
  try {
    if (existsSync(CONFIG_PATH)) ini = parseIni(readFileSync(CONFIG_PATH, 'utf-8'))
  } catch {
    /* unreadable config — fall back to defaults */
  }

  const rawRoot =
    (ini['comfy.comfy_dir'] ?? '').trim() ||
    (process.env.COMFY_ROOT || '').trim() ||
    join(process.cwd(), 'ComfyUI-Easy-Install')
  const comfyRoot = resolve(rawRoot)

  // (fix 314) Minimum context unified with POST validation: 4096
  // (previously read clamped lower bound to 8192, while POST accepted from 4096 —
  // saved 4096 "jumped" back to 8192).
  const ctxSize = Math.max(4096, Math.min(102400, parseInt(ini['llm.context_size'] ?? '25600', 10) || 25600))
  const config: AppConfig = {
    // (fix 716) parseNum0 rather than `|| 3`: saved reserve_gb = 0
    // (valid value) silently turned into 3. Fix 556 removed this
    // pattern in other fields — here it remained.
    reserveGb: parseNum0(ini['vram.reserve_gb'] ?? ini['reserve_gb'] ?? '3', 3),
    // (fix 490) 0 = off (flag not passed), range as in UI: 0–8 GB.
    // Default 2 GB: aimdo keeps this headroom free even with external
    // applications, preventing DynamicVRAM from taking entire card for weights.
    vramHeadroom: Math.max(0, Math.min(8, parseFloat(ini['vram.vram_headroom'] ?? '2') || 0)),
    // Canonical home is [vram]; [comfy]/bare kept as read fallbacks for
    // configs written by older versions.
    dynamicVram: (ini['vram.dynamic_vram'] ?? ini['comfy.dynamic_vram'] ?? ini['dynamic_vram'] ?? '1') !== '0',
    llmDevice: (['auto', 'gpu', 'cpu'].includes(ini['llm.device'] ?? '')
      ? ini['llm.device']
      : 'auto') as AppConfig['llmDevice'],
    // (fix 119) assistant context: default 25K, max 100K tokens
    llmContextSize: ctxSize,
    // (fix 313) Max response length cannot exceed context window:
    // context clamping promised in docstring was missing — with ctx 4096
    // and max_output 16384 chat route received an impossible budget.
    llmMaxOutputTokens: Math.max(256, Math.min(ctxSize, 16384, parseInt(ini['llm.max_output_tokens'] ?? '4096', 10) || 4096)),
    comfyRoot,
    outputDir: join(comfyRoot, 'ComfyUI', 'output'),
    inputDir: join(comfyRoot, 'ComfyUI', 'input'),
    pythonExe: join(comfyRoot, 'python_embeded', 'python.exe'),
    diffusionModel: (ini['comfy.diffusion_model'] ?? '').trim(),
    llmModel: (ini['llm.model'] ?? '').trim(),
    // (fix 136) Bonsai now lives INSIDE project (<project>/Bonsai_2_27B)
    // — default is relative, project is portable. External path if desired
    // is set in config.ini: [llm] bonsai_dir=...
    llmBonsaiDir: (ini['llm.bonsai_dir'] ?? '').trim() || join(process.cwd(), 'Bonsai_2_27B'),
    // (fix 257) Custom LLM + external model folders
    llmCustomModel: (ini['llm.custom_model_path'] ?? '').trim(),
    llmCustomMmproj: (ini['llm.custom_mmproj_path'] ?? '').trim(),
    modelExtraPaths: parseExtraPaths(ini['models.extra_paths'] ?? ''),
    // (fix 53) enabled by default: video refs go to assistant as compressed
    // digest description (cached by content), not raw frames.
    // Older config.ini without key also get new default; explicit 0 = off.
    llmVideoVision: ini['llm.video_vision'] !== '0',
    // (fix 109) KV cache quantization; (fix 119) default q4_0 — saves memory
    llmKvCache: (['off', 'q8_0', 'q5_1', 'q4_0'].includes(ini['llm.kv_cache'] ?? '')
      ? ini['llm.kv_cache']
      : 'q4_0') as AppConfig['llmKvCache'],
    // (fix 135b) fine sampling settings for LLM — default OFF,
    // then route.ts uses model-aware values from llm-sampling.ts.
    // If ON — user values below are applied.
    llmSamplingOverride: ini['llm.sampling_override'] === '1',
    // (fix 556) parseNum0 — 0 is legitimate (deterministic sampling).
    llmTemperature: parseNum0(ini['llm.temperature'], 0.7),
    llmTopP: parseNum0(ini['llm.top_p'], 0.95),
    llmTopK: Math.max(1, Math.min(200, parseInt(ini['llm.top_k'] ?? '40', 10) || 40)),
    llmMinP: Math.max(0, Math.min(1, parseNum0(ini['llm.min_p'], 0.05))),
    llmPresencePenalty: Math.max(0, Math.min(2.5, parseFloat(ini['llm.presence_penalty'] ?? '0.0') || 0.0)),
    llmFrequencyPenalty: Math.max(0, Math.min(2.5, parseFloat(ini['llm.frequency_penalty'] ?? '0.0') || 0.0)),
    llmRepeatPenalty: Math.max(1.0, Math.min(2.0, parseFloat(ini['llm.repeat_penalty'] ?? '1.0') || 1.0)),
    soundOn: ini['ui.sound_on'] !== '0',
    // (fix 65) Voice input — whisper (transcribe.cpp), CPU-only.
    // Default ON: dictation button visible, and if model is missing
    // shows clear error with hint where to download it.
    sttEnabled: ini['stt.enabled'] !== '0',
    // (fix 72) STT runtime built into project: <project>/stt (overridable in config.ini).
    sttDir: (ini['stt.dir'] ?? '').trim() || join(process.cwd(), 'stt'),
    sttModel: (ini['stt.model'] ?? '').trim(),
    sttLanguage: (['auto', 'ru', 'en'].includes(ini['stt.language'] ?? '')
      ? ini['stt.language']
      : 'ru') as string,
    sttThreads: Math.max(0, Math.min(32, parseInt(ini['stt.threads'] ?? '0', 10) || 0)),
    // (fix 74) Upscale (DLSS 5 Visual Enhancer) — built-in upscale/ folder.
    upscaleEnabled: ini['upscale.enabled'] !== '0',
    upscalePort: Math.max(1024, Math.min(65535, parseInt(ini['upscale.port'] ?? '7890', 10) || 7890)),
    // (fix 386) [video] Save format: codec + quality (CRF/NVENC-bitrate).
    videoCodec: (['h264', 'h265', 'nvenc_h264', 'nvenc_h265'].includes(ini['video.codec'] ?? '')
      ? ini['video.codec']
      : 'h264') as AppConfig['videoCodec'],
    // (fix 556) crf=0 is legitimate (0–30, lower = better) — parseNum0.
    videoCrf: Math.max(0, Math.min(30, parseNum0(ini['video.crf'], 12))),
    videoNvencBitrate: Math.max(4, Math.min(40, parseInt(ini['video.nvenc_bitrate'] ?? '16', 10) || 16)),
  }
  cache = { mtimeMs, config }
  return config
}

/* ────────────────────────── Writing ────────────────────────── */

/**
 * Set a single `key = value` line inside an INI section, preserving the
 * rest of the file. Creates the section when missing. Resets the cache.
 */
export function setConfigValue(section: string, key: string, value: string): void {
  let content = ''
  try {
    content = readFileSync(CONFIG_PATH, 'utf-8')
  } catch {
    content = ''
  }
  // A newline inside a value would corrupt the INI layout — strip
  // line breaks and other control characters defensively.
  const safeValue = value.replace(/[\r\n\0]/g, ' ').trim()
  const lines = content.split(/\r?\n/)

  let inSection = false
  let sectionStart = -1
  let replaced = false
  let insertAt = -1

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim()
    if (t.startsWith('[') && t.endsWith(']')) {
      if (inSection) break // reached the next section
      inSection = t.slice(1, -1) === section
      if (inSection) sectionStart = i
      continue
    }
    if (inSection) {
      // (fix 716) Match key allowing spaces around '=': INI parser
      // (above) accepts "key = value", while this search did not. Because
      // of this a DUPLICATE key with another value was appended to files with spaces.
      const eqIdx = t.indexOf('=')
      if (eqIdx > 0 && t.slice(0, eqIdx).trim().toLowerCase() === key.toLowerCase()) {
        lines[i] = `${key}=${safeValue}`
        replaced = true
        break
      }
      insertAt = i + 1 // after the last line inside the section
    }
  }

  if (!replaced) {
    if (sectionStart >= 0) {
      // (fix 317) Insert at END of section (insertAt — position after
      // last line of section): previously insertAt was computed but not
      // used — new key landed immediately after section header.
      lines.splice(Math.max(insertAt, sectionStart + 1), 0, `${key}=${safeValue}`)
    } else {
      lines.push('', `[${section}]`, `${key}=${safeValue}`)
    }
  }

  // (fix 312) Atomic write: temp file + rename, like .part approach in
  // /api/loras. Direct writeFileSync could leave a truncated config.ini on
  // crash midway through write. On Windows rename over existing file in
  // Node works (MOVEFILE_REPLACE_EXISTING), but just in case of error
  // delete destination and retry.
  const tmpPath = CONFIG_PATH + '.tmp'
  writeFileSync(tmpPath, lines.join('\n'), 'utf-8')
  try {
    renameSync(tmpPath, CONFIG_PATH)
  } catch {
    try { rmSync(CONFIG_PATH, { force: true }) } catch { /* ignore */ }
    renameSync(tmpPath, CONFIG_PATH)
  }
  cache = null
}

/* ─────────────────────── Factory Config Reset ─────────────────────── */

/**
 * Factory contents of config.ini.
 *
 * (full reset) Previously "Factory reset" only rewrote part
 * of keys via POST /api/config: `comfy_dir`, `upscale.*`, `video.*`,
 * `async_offload` and others remained user-modified. For a full
 * "as from factory" reset the file is completely overwritten with this template.
 * Values match code defaults (getAppConfig) and repository config.ini,
 * so after reset the application behaves as if freshly installed.
 */
const DEFAULT_CONFIG_INI = `[vram]
reserve_gb=3
dynamic_vram=1
; 0 = synchronous model loading (stable), 1 = async-offload
async_offload=0
vram_headroom=2

[comfy]
turbo_lora=
; Empty = default diffusion model from code
diffusion_model=
; comfy_dir not set = ./ComfyUI-Easy-Install next to program

[llm]
custom_mmproj_path=
custom_model_path=
repeat_penalty=1
frequency_penalty=0
presence_penalty=0
min_p=0.05
top_k=40
top_p=0.95
temperature=0.7
sampling_override=0
kv_cache=q4_0
video_vision=1
model=Qwen3.5-9B-Q4_K_M.gguf
max_output_tokens=4096
context_size=25600
device=auto

[ui]
sound_on=1

[stt]
dir=
threads=0
language=ru
model=
enabled=1

[upscale]
enabled=1
port=7890

[models]
extra_paths=[]

[video]
codec=h264
crf=12
nvenc_bitrate=16
`

/**
 * (full reset) Overwrite config/config.ini with factory default values.
 * Atomically (tmp + rename), like setConfigValue: crash midway through write
 * won't leave a truncated file.
 */
export function resetConfigToDefaults(): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true })
  const tmpPath = CONFIG_PATH + '.tmp'
  writeFileSync(tmpPath, DEFAULT_CONFIG_INI, 'utf-8')
  try {
    renameSync(tmpPath, CONFIG_PATH)
  } catch {
    try { rmSync(CONFIG_PATH, { force: true }) } catch { /* ignore */ }
    renameSync(tmpPath, CONFIG_PATH)
  }
  cache = null
}
