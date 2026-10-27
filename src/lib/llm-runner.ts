/**
 * LLM runner (edit 24) — lazy spawn/stop of the local assistant model.
 *
 * The model runs inside the ComfyUI embedded python (llama-cpp-python is
 * already installed there) via tools/llm_server.py on 127.0.0.1:8090.
 *
 * VRAM arbitration lives in vram-arbiter.ts (dispatcher LLM ↔ MiniMax):
 * this module handles only spawn/stop of the LLM server and its status.
 */
import { spawn, execFile, type ChildProcess } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import { existsSync, statSync } from 'fs'
import { getAppConfig } from './app-config'
import { MODELS } from './models-config'

const execFileAsync = promisify(execFile)

export const LLM_PORT = 8090
/** Default assistant model is Qwen3.5 9B (Q4_K_M, vision).
 *  Bonsai 2 27B remains an optional backend upon explicit selection. */
export const LLM_MODEL_ID = 'llm_assistant_qwen'

/* ── (edit 136 / Bonsai) Second assistant backend ──
 * Ternary Bonsai 2 27B (Qwen family, ternary quantization PQ2_0, vision via
 * mmproj) runs ONLY on a llama.cpp fork (PrismML) — standard llama.cpp/llama-cpp-python
 * cannot read ternary quants. Therefore llama-server.exe is spawned from an
 * external portable folder (config [llm] bonsai_dir) with OpenAI protocol,
 * instead of tools/llm_server.py on llama-cpp-python.
 * VRAM arbitration remains unchanged: process is our child (llmPid/stopLlm work). */
export type LlmBackend = 'standard' | 'bonsai' | 'custom'

/** Marker in config [llm] model enabling Bonsai backend. */
export const LLM_MODEL_BONSAI = 'bonsai'
/** (edit 168) Marker for lightweight Bonsai quant PTQ1_0. */
export const LLM_MODEL_BONSAI_LIGHT = 'bonsai_light'
/** (edit 467) Marker for custom GGUF model: appears as an item in assistant
 *  model selector when [llm] custom_model is set. */
export const LLM_MODEL_CUSTOM = 'llm_custom'

export function llmBackend(): LlmBackend {
  try {
    const cfg = getAppConfig()
    // (edit 257) Custom model (.gguf by absolute path): same engine
    // (llm_server.py), user file.
    // (edit 467) Previously non-empty custom_model unconditionally overrode
    // selector choice — selector "lied" (showed Bonsai, ran custom), and
    // custom path could not be distinguished in list. Now custom is active when
    // path is set AND selector is on it (model='llm_custom') OR model is still empty
    // (legacy: path set before item appeared in list). Explicit choice of built-in
    // model in selector switches back, while path remains saved in settings.
    if (cfg.llmCustomModel && (cfg.llmModel === '' || cfg.llmModel === LLM_MODEL_CUSTOM)) return 'custom'
    const m = cfg.llmModel
    // Bonsai is enabled only by explicit marker. Empty value, 'llm_custom'
    // without path, and any filename use standard backend; default is Qwen.
    return (m === LLM_MODEL_BONSAI || m === LLM_MODEL_BONSAI_LIGHT) ? 'bonsai' : 'standard'
  } catch {
    return 'standard' // On unavailable config — standard Qwen default.
  }
}

/** External Bonsai bundle files (engine + model + mmproj). */
export function llmBonsaiPaths(): {
  exe: string
  model: string
  mmproj: string | null
} {
  const cfg = getAppConfig()
  const dir = cfg.llmBonsaiDir
  const modelsDir = path.join(dir, 'models')
  const mmproj = path.join(modelsDir, 'Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf')
  const pq = path.join(modelsDir, 'Ternary-Bonsai-2-27B-PQ2_0.gguf')
  const ptq = path.join(modelsDir, 'Ternary-Bonsai-2-27B-PTQ1_0.gguf')

  // (edit 168) If 'bonsai_light' selected — use PTQ1_0 (if available), else PQ2_0.
  // Otherwise (default / 'bonsai') — PQ2_0 priority, PTQ1_0 as fallback.
  let model: string
  if (cfg.llmModel === LLM_MODEL_BONSAI_LIGHT) {
    model = existsSync(ptq) ? ptq : pq
  } else {
    model = existsSync(pq) ? pq : existsSync(ptq) ? ptq : pq
  }

  return {
    exe: path.join(dir, 'llama.cpp', 'llama-server.exe'),
    model,
    mmproj: existsSync(mmproj) ? mmproj : null,
  }
}

/**
 * (edit 138) Bonsai auto-download: if files are missing — trigger download
 * of engine (2 zips from GitHub) + model and mmproj (HuggingFace) via standard
 * downloader and return human-readable status for chat message.
 */
const BONSAI_DOWNLOAD_IDS = ['bonsai_engine_bin', 'bonsai_engine_cudart', 'bonsai_model', 'bonsai_mmproj'] as const

async function autoDownloadBonsai(): Promise<string> {
  const { startDownload, getAllModelsStatus } = await import('./model-downloader')
  const statuses = getAllModelsStatus().filter(s => (BONSAI_DOWNLOAD_IDS as readonly string[]).includes(s.id))
  const missing = statuses.filter(s => s.status === 'missing' || s.status === 'error')
  for (const m of missing) {
    const r = await startDownload(m.id)
    if (r.ok) console.log(`[llm] Bonsai auto-download: ${m.id} started`)
    else if (r.error !== 'Download already in progress') console.warn(`[llm] Bonsai auto-download ${m.id}: ${r.error}`)
  }
  const parts = statuses.map(s =>
    s.status === 'downloading'
      ? `${s.id} — ${(s.bytesReceived / 1024 ** 2).toFixed(0)} of ${s.totalBytes ? `${(s.totalBytes / 1024 ** 2).toFixed(0)} MB` : '?'}`
      : `${s.id} — ${s.status === 'ready' ? 'ready' : s.status === 'error' ? `error: ${s.error}` : 'pending'}`,
  )
  return 'Bonsai assistant model is not downloaded yet — download started automatically ' +
    `(${parts.join('; ')}). This is a one-time download (~8 GB, engine + model + vision); ` +
    'progress is visible in Settings → Models. Send your message again in a few minutes.'
}

/**
 * Resolve the currently active LLM model ID from config.
 * If the user selected a specific quantization (e.g. Q3_K_M), return
 * the matching MODELS ID (e.g. 'llm_assistant_q3'); otherwise fall back
 * to the default 'llm_assistant_qwen' (edit 99).
 * (edit 136) 'bonsai' in config → virtual ID 'llm_assistant_bonsai'.
 */
export function activeLlmModelId(): string {
  const be = llmBackend()
  if (be === 'bonsai') return 'llm_assistant_bonsai'
  // (edit 257) Virtual ID of custom model — outside MODELS, status/banner
  // handle it separately.
  if (be === 'custom') return 'llm_custom'
  try {
    const cfg = getAppConfig()
    if (cfg.llmModel) {
      const found = MODELS.find((m) => {
        if (!m.id.startsWith('llm_assistant') || isLlmMmprojId(m.id)) return false
        return m.relPath.endsWith(cfg.llmModel)
      })
      if (found) return found.id
    }
  } catch { /* config unavailable */ }
  return LLM_MODEL_ID
}

/** ID of mmproj file (vision) — not the model itself, but companion file. */
function isLlmMmprojId(id: string): boolean {
  return id === 'llm_assistant_mmproj' || id === 'llm_assistant_qwen_mmproj'
}

/** LLM context window size (tokens) — read from config at call-time. */
export function llmContextSize(): number {
  try {
    return getAppConfig().llmContextSize
  } catch {
    // (edit 119) default 25K tokens
    return 25600
  }
}

let child: ChildProcess | null = null
let starting: Promise<{ ok: boolean; error?: string }> | null = null
let gpuMode: 'gpu' | 'cpu' | null = null
let startedAt = 0
/** Actual context size the running server was started with (set at spawn time). */
let actualCtx: number | null = null

/**
 * (edit: out-of-sync after reset / model change) Configuration signature
 * that the CURRENT server was spawned with. Previously ensureLlm assumed
 * "alive process = suitable server": after "Reset settings" or changing model/context
 * in settings, running server continued serving the OLD model, while chat route
 * already read the NEW config — protocol (/chat in llm_server.py vs
 * /v1/chat/completions in llama-server), chat template, and sampling differed from
 * the actually loaded model → "weird" responses on initial messages until server
 * was restarted by idle timeout. Now alive server with mismatched config is
 * restarted (see ensureLlm). null = server was not spawned by us
 * (adopted foreign server on port) — check is skipped.
 */
let spawnSig: string | null = null

/** Signature of DESIRED configuration based on current config.ini. */
function desiredSpawnSig(): string {
  try {
    const cfg = getAppConfig()
    return JSON.stringify({
      b: llmBackend(),
      m: llmModelPath(),
      p: llmMmprojPath(),
      c: llmContextSize(),
      kv: cfg.llmKvCache,
      d: cfg.llmDevice,
    })
  } catch {
    return 'unknown'
  }
}

// (edit 348) Orphans: when Node process exits (studio closing), child
// llm_server.py / llama-server stayed alive on port 8090 and held VRAM.
const killChildSync = () => {
  if (child && child.pid && child.exitCode === null && child.signalCode === null) {
    try { child.kill() } catch { /* already dead */ }
  }
}
process.once('exit', killChildSync)
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, () => {
    killChildSync()
    process.exit(130)
  })
}

/** The ACTUAL context window of the running server (matches --ctx arg).
 *  Falls back to config value if server hasn't started yet. */
export function actualLlmContextSize(): number {
  return actualCtx ?? llmContextSize()
}

export function llmModelPath(): string {
  const cfg = getAppConfig()
  // (edit 257) Custom model: absolute path from config as is.
  if (llmBackend() === 'custom') return cfg.llmCustomModel
  // (edit 162) Bonsai: model in external bundle folder, not in ComfyUI/models
  if (llmBackend() === 'bonsai') return llmBonsaiPaths().model
  // Resolve via MODELS + active model (edit 52): correctly handles
  // Gemma quants in llm/ and Qwen3.5 9B in llm/qwen3.5-9b/ subfolder.
  const def = MODELS.find((m) => m.id === activeLlmModelId())
  return path.join(cfg.comfyRoot, 'ComfyUI', 'models', def?.relPath ?? 'llm')
}

/** Path to the multimodal projector (vision) file, or null if not present.
 *  (edit 52) mmproj depends on selected model: Qwen3.5 9B has its own file.
 *  (edit 162) Bonsai: own mmproj in bundle folder.
 *  (edit 257) custom: mmproj from config (optional — text-only without it). */
function llmMmprojPath(): string | null {
  // (edit 257) Custom model: mmproj from config if specified and exists.
  if (llmBackend() === 'custom') {
    const cfg = getAppConfig()
    return cfg.llmCustomMmproj && existsSync(cfg.llmCustomMmproj) ? cfg.llmCustomMmproj : null
  }
  // (edit 162) Bonsai: own mmproj in bundle folder, not in ComfyUI/models
  if (llmBackend() === 'bonsai') {
    const b = llmBonsaiPaths()
    return b.mmproj // already checked with existsSync in llmBonsaiPaths
  }
  const cfg = getAppConfig()
  const mmId = activeLlmModelId() === 'llm_assistant_qwen'
    ? 'llm_assistant_qwen_mmproj'
    : 'llm_assistant_mmproj'
  const def = MODELS.find((m) => m.id === mmId)
  if (!def) return null
  const p = path.join(cfg.comfyRoot, 'ComfyUI', 'models', def.relPath)
  return existsSync(p) ? p : null
}

export function llmModelExists(): boolean {
  try {
    // (edit 257) Custom model: user file — threshold only 1 MB
    // (quants can be small; 100 MB would filter out lightweight models).
    if (llmBackend() === 'custom') {
      return statSync(llmModelPath()).size > 1_000_000
    }
    // (edit 136) Bonsai: check external bundle files (exe + GGUF).
    if (llmBackend() === 'bonsai') {
      const b = llmBonsaiPaths()
      return existsSync(b.exe) && statSync(b.model).size > 100_000_000
    }
    const st = statSync(llmModelPath())
    return st.size > 100_000_000
  } catch {
    return false
  }
}

async function healthUp(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  const proc = child
  while (Date.now() < deadline) {
    // Process died (crashed on startup) — don't poll dead port until timeout
    if (!proc || proc.killed || proc.exitCode !== null || proc.signalCode !== null) return false
    if (!child) return false
    try {
      const r = await fetch(`http://127.0.0.1:${LLM_PORT}/health`, {
        signal: AbortSignal.timeout(2000),
      })
      if (r.ok) return true
    } catch {
      /* not up yet — model loading */
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  return false
}

export interface LlmStatus {
  running: boolean
  starting: boolean
  gpuMode: 'gpu' | 'cpu' | null
  modelExists: boolean
  startedAt: number
  ctxSize: number
}

export function llmStatus(): LlmStatus {
  return {
    // exitCode/signalCode: process may have already died while exit event hasn't
    // been processed yet — otherwise ensureLlm sees "running" and spends up to 90s
    // health-polling a dead PID.
    running: !!child && !child.killed && child.exitCode === null && child.signalCode === null,
    starting: !!starting,
    gpuMode,
    modelExists: llmModelExists(),
    startedAt,
    ctxSize: actualLlmContextSize(),
  }
}

/** PID of LLM server process (null when not running / already exited). */
export function llmPid(): number | null {
  return child?.pid ?? null
}

/* ── (edit 136 / Bonsai) Idle auto-stop ──
 * llm_server.py stops itself after --idle-sec 600; llama-server lacks
 * this feature — watched from runner: 10 minutes without chat requests
 * → stopLlm() (VRAM released for MiniMax/system). */
let lastLlmActivity = 0
let bonsaiIdleTimer: ReturnType<typeof setInterval> | null = null

/** Mark assistant activity (called by chat route on every request). */
export function noteLlmActivity(): void {
  lastLlmActivity = Date.now()
}

function startBonsaiIdleWatchdog(): void {
  lastLlmActivity = Date.now()
  if (bonsaiIdleTimer) return
  bonsaiIdleTimer = setInterval(() => {
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      stopBonsaiIdleWatchdog()
      return
    }
    if (Date.now() - lastLlmActivity > 600_000) {
      console.log('[llm] Bonsai: 10 min without requests — unloading (idle)')
      // (edit 716) .catch is required: stopLlm is async, and its rejection
      // without handler would be unhandled rejection (Node terminates process by default).
      void stopLlm().catch((err) => {
        console.warn('[llm] idle unloading failed:', err instanceof Error ? err.message : String(err))
      })
    }
  }, 60_000)
  // Keep event-loop alive properly: timer is periodic, interval does not interfere.
  bonsaiIdleTimer.unref?.()
}

function stopBonsaiIdleWatchdog(): void {
  if (bonsaiIdleTimer) {
    clearInterval(bonsaiIdleTimer)
    bonsaiIdleTimer = null
  }
}

/**
 * Wait for current LLM startup to finish if in progress (for arbiter):
 * while model is loading, stopLlm is useless — process doesn't exist yet or is
 * about to appear. Once loading is complete, it can be stopped cleanly.
 */
export async function awaitLlmStartup(): Promise<void> {
  while (starting) {
    const p = starting
    await p.catch(() => {})
    if (p === starting) break // startup finished and new one didn't start
  }
}

/** Wait for process exit event up to `ms` ms. true = process terminated. */
function waitForExit(p: ChildProcess, ms: number): Promise<boolean> {
  if (p.exitCode !== null || p.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms)
    p.once('exit', () => {
      clearTimeout(t)
      resolve(true)
    })
  })
}

/** Start the LLM server (idempotent). Resolves when /health answers. */
export async function ensureLlm(): Promise<{ ok: boolean; error?: string }> {
  if (child && !child.killed) {
    // Process EXITED while exit event was not yet handled — this is a dead child:
    // previously healthUp faithfully polled it up to 90s and failed the request.
    // Clear reference and start afresh.
    if (child.exitCode !== null || child.signalCode !== null) {
      child = null
      gpuMode = null
      actualCtx = null
      spawnSig = null
    } else {
      // Already running — but confirm health (model may still be loading)
      const ok = await healthUp(90_000)
      if (ok && spawnSig !== null && spawnSig !== desiredSpawnSig()) {
        // Live server is serving OLD configuration (reset settings / changed
        // model / context / KV after it started): chat route already sends
        // protocol, chat template and sampling for NEW model — incompatible
        // with loaded one (/chat in llm_server.py vs /v1/chat/completions in
        // llama-server). Restart with current parameters, otherwise first
        // responses glitch until server hits idle auto-stop.
        console.warn('[llm] LLM config changed after server launch — restarting with current parameters')
        await stopLlm()
      } else if (ok) {
        return { ok: true }
      } else if (child && child.pid) {
        // (edit 259) Process is ALIVE but unresponsive (deadlock in llama.cpp):
        // previously returned an error, and EVERY subsequent request paid the same
        // 90s without any recovery attempt. This is OUR tracked child
        // (PID known) — kill and fall through to cold spawn branch below
        // (restart exactly once per call). If PID were unknown
        // (foreign/orphaned process on port) — we don't blindly kill.
        console.warn('[llm] (edit 259) process is alive but /health silent for 90s — killing and restarting')
        await stopLlm()
      } else {
        return { ok: false, error: 'LLM server is not responding' }
      }
    }
  }
  if (starting) return starting

  // (edit 343) Port 8090 could be held by an orphan (llm_server.py survived
  // studio restart) — previously new process failed on bind with traceback,
  // and healthUp waited 3 minutes for response. Now: live server on port is
  // reused via /health (quick start after app restart), while occupied
  // silent port yields a clear error instead of a long wait.
  try {
    const r = await fetch(`http://127.0.0.1:${LLM_PORT}/health`, {
      signal: AbortSignal.timeout(2000),
    })
    if (r.ok) {
      // Adopt foreign (orphaned) server — first verify that the port
      // is running the model expected by current config. Otherwise chat route
      // would send mismatched protocol/template/sampling (same issue
      // solved by spawnSig for own child), and we cannot kill orphan
      // (unknown PID) — hence explicit error instead of silent glitches.
      // llm_server.py returns model directly in /health; llama-server (bonsai) —
      // via /v1/models.
      let foreignModel: string | null = null
      try {
        const j = (await r.json()) as { model?: unknown }
        if (typeof j.model === 'string' && j.model) foreignModel = j.model
      } catch { /* non-JSON body — likely llama-server */ }
      if (!foreignModel) {
        try {
          const mr = await fetch(`http://127.0.0.1:${LLM_PORT}/v1/models`, {
            signal: AbortSignal.timeout(2000),
          })
          if (mr.ok) {
            const mj = (await mr.json()) as { data?: Array<{ id?: unknown }> }
            const id = mj.data?.[0]?.id
            if (typeof id === 'string' && id) foreignModel = id
          }
        } catch { /* couldn't identify — trust as before */ }
      }
      if (foreignModel) {
        const base = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p
        let desired = ''
        try { desired = llmModelPath() } catch { /* config unavailable */ }
        if (desired && base(foreignModel) !== base(desired)) {
          return {
            ok: false,
            error: `Port ${LLM_PORT} is occupied by an LLM server with a different model (${base(foreignModel)} instead of ${base(desired)}) — leftover process from previous launch. Terminate python.exe / llama-server.exe in Task Manager and send message again.`,
          }
        }
      }
      spawnSig = null // server not spawned by us — skip signature check
      console.log(`[llm] (edit 343) port ${LLM_PORT} already has a live server — reusing it`)
      if (!startedAt) startedAt = Date.now()
      return { ok: true }
    }
  } catch (e) {
    // ECONNREFUSED — port free, spawn our own. Timeout — port occupied
    // by process not responding as LLM (hung orphan?).
    if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      return {
        ok: false,
        error: `Port ${LLM_PORT} is occupied by a process not responding as LLM server (possibly a hung orphan from a previous run). Terminate it in Task Manager (python.exe / llama-server.exe) and try again.`,
      }
    }
  }

  if (!llmModelExists()) {
    // (edit 138) Bonsai: files missing — auto-download missing files (engine/
    // model/mmproj) instead of blunt error. Response contains status with progress.
    if (llmBackend() === 'bonsai') {
      return { ok: false, error: await autoDownloadBonsai() }
    }
    return { ok: false, error: 'Assistant model is not downloaded' }
  }

  starting = (async () => {
    let proc: ChildProcess | null = null
    try {
      const cfg = getAppConfig()
      // Device selection: manual override via Settings ([llm] device in
      // config.ini) wins; 'auto' falls back to the free-VRAM heuristic.
      // When GPU is wanted but VRAM is occupied by ComfyUI's post-generation
      // model cache — and nothing is generating — evict that cache first
      // (edit 29) so the assistant gets the GPU.
      const device = cfg.llmDevice
      const wantsGpu = device !== 'cpu'
      let gpuLayers = 0
      if (wantsGpu) {
        // Eviction of ComfyUI is handled by vram-arbiter (startChat in chat route)
        // BEFORE ensureLlm call — here model simply loads into free VRAM.
        // n_gpu_layers = -1: llm_server.py will calculate max layers on GPU
        // fitting into 90% of total VRAM (--max-vram-percent 90, edit 60: back to the original 90%).
        // Remaining layers automatically stay on CPU — system won't lag.
        gpuLayers = -1
      }
      const useGpu = gpuLayers !== 0
      gpuMode = useGpu ? 'gpu' : 'cpu'
      startedAt = Date.now()

      // llama-cpp-python's load_shared_library checks CUDA_PATH and adds
      // $CUDA_PATH/lib to the DLL search path. We point it at the PyTorch
      // directory (which contains lib/ with CUDA runtime DLLs) so that
      // ggml-cuda.dll can find cublas/cudart. Portable: no system CUDA
      // toolkit install needed — uses DLLs bundled with PyTorch.
      const torchDir = path.join(
        cfg.comfyRoot, 'python_embeded', 'Lib', 'site-packages', 'torch',
      )
      const env = { ...process.env }
      if (existsSync(torchDir)) {
        env.CUDA_PATH = torchDir
      }

      // Whole-video support: the MTMD video helper (patched into
      // llama_multimodal.py) spawns ffmpeg+ffprobe from one directory. The
      // portable static build lives in <project>/runtime/ffmpeg — point the
      // helper there so nothing external is required.
      const ffmpegDir = [path.join(process.cwd(), 'runtime', 'ffmpeg'), path.join(cfg.comfyRoot, '..', 'runtime', 'ffmpeg')].find(
        (d) => existsSync(path.join(d, 'ffmpeg.exe')) && existsSync(path.join(d, 'ffprobe.exe')),
      )
      if (ffmpegDir) {
        env.LLM_FFMPEG_DIR = path.resolve(ffmpegDir)
      }

      const mmproj = llmMmprojPath()
      const ctx = llmContextSize()
      actualCtx = ctx

      if (llmBackend() === 'bonsai') {
        // (edit 136) Bonsai: prism llama-server with OpenAI protocol.
        // Flags from verified bundle launchers (Start-Bonsai.bat).
        // "Thinking" is disabled NOT by startup flag (--reasoning-budget 0
        // does not work in fork), but by template parameter in each request:
        // chat_template_kwargs.enable_thinking=false (see chat route).
        const b = llmBonsaiPaths()
        if (!existsSync(b.exe) || !existsSync(b.model)) {
          // (edit 138) Auto-download: engine/model missing — download
          // automatically, user receives status with progress.
          return { ok: false, error: await autoDownloadBonsai() }
        }
        const bArgs = [
          '-m', b.model,
          '-c', String(ctx),
          '-ngl', wantsGpu ? '99' : '0',
          '-fa', 'on',
          // (fix) Single slot: fork defaults to n_slots=4 with unified-KV —
          // foreign context leaked between slots (responses not following system prompt).
          // Studio only sends one chat at a time anyway.
          '-np', '1',
          // (fix) Context checkpoints of the fork (fuzzy LCP KV reuse between TASKS)
          // restored "similar" foreign prefix — responses drifted into topics of
          // past requests and ignored system prompt. Disable:
          // 0 checkpoints + do not cache idle slots. Exact prefix reuse
          // (shared system prompt) remains — it is correct.
          '-ctxcp', '0',
          '--no-cache-idle-slots',
          '--jinja',
          // instruct recommendations from authors (thinking disabled); exact
          // values arrive per-request from llm-sampling.ts
          '--temp', '0.7',
          '--top-p', '0.8',
          '--top-k', '20',
          '--presence-penalty', '1.5',
          '--host', '127.0.0.1',
          '--port', String(LLM_PORT),
        ]
        // (edit 136b) KV-cache quantization — same setting as standard
        // backend ([llm] kv_cache): Bonsai KV is tiny
        // (hybrid attention: cache only for ~16 of 128 layers; 25.6K ctx =
        // 1.7 GB f16 / 850 MB q8_0 / 425 MB q4_0), but on smaller GPUs even this
        // is noticeable. '-fa on' already enabled — prerequisite for quantized KV.
        if (cfg.llmKvCache !== 'off') {
          bArgs.push('-ctk', cfg.llmKvCache, '-ctv', cfg.llmKvCache)
        }
        if (b.mmproj) bArgs.push('--mmproj', b.mmproj)
        noteLlmActivity()
        proc = spawn(b.exe, bArgs, {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          env: process.env,
        })
        startBonsaiIdleWatchdog()
      } else {
        const args = [
          path.join(process.cwd(), 'tools', 'llm_server.py'),
          '--model', llmModelPath(),
          '--port', String(LLM_PORT),
          '--gpu-layers', String(gpuLayers),
          '--max-vram-percent', '90',
          '--ctx', String(ctx),
          // (edit 109) KV cache quantization: off (fp16) / q8_0 / q5_1 / q4_0
          '--kv-cache', cfg.llmKvCache,
          '--threads', '6',
          '--idle-sec', '600',
        ]
        if (mmproj) args.push('--mmproj', mmproj)

        proc = spawn(
          path.join(cfg.comfyRoot, 'python_embeded', 'python.exe'),
          args,
          { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env },
        )
      }
      child = proc
      spawnSig = desiredSpawnSig()
      proc.stdout?.on('data', (d: Buffer) => process.stdout.write(`[llm] ${d}`))
      proc.stderr?.on('data', (d: Buffer) => process.stderr.write(`[llm] ${d}`))
      // Clear reference only if this is STILL current process: during
      // shutdown of old process, new LLM server could have already started.
      proc.on('exit', () => {
        if (child === proc) {
          child = null
          gpuMode = null
          actualCtx = null
          spawnSig = null
        }
        stopBonsaiIdleWatchdog()
      })

      const up = await healthUp(180_000)
      return up
        ? { ok: true }
        : { ok: false, error: 'Model did not load within 3 minutes (see server log)' }
    } catch (err) {
      // Clear reference only for process created by THIS run:
      // an old (killed, still exiting) process could remain prior to spawn.
      if (proc && child === proc) {
        // (edit 716) KILL the process rather than merely forgetting reference.
        // Previously child = null — and child llama-server stayed alive
        // (~10 GB VRAM + port 8090), 'exit' handler no longer cleaned it up
        // (checks child === proc), and stopLlm() exited immediately when child === null.
        // Orphan lived until its own --idle-sec timeout.
        try {
          proc.kill()
        } catch { /* already dead */ }
        if (proc.pid) {
          try {
            await execFileAsync('taskkill', ['/F', '/T', '/PID', String(proc.pid)])
          } catch {
            /* process may have already exited */
          }
        }
        child = null
        gpuMode = null
        actualCtx = null
        spawnSig = null
      }
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      starting = null
    }
  })()

  return starting
}

/**
 * Stop LLM server guaranteeing actual process exit:
 *  1) graceful POST /shutdown (server releases CUDA context itself: del llm → os._exit);
 *  2) wait for exit event (no sleep!) up to 10s;
 *  3) escalation: kill() → wait exit 5s → taskkill /F /T → wait exit 5s.
 * Returns control only when process is dead (or all attempts exhausted).
 */
export async function stopLlm(): Promise<void> {
  const proc = child
  if (!proc) {
    child = null
    gpuMode = null
    spawnSig = null
    return
  }
  // 1) Graceful shutdown — server releases CUDA context itself.
  // (edit 258) Endpoint /shutdown exists ONLY in standard backend
  // (tools/llm_server.py); prism llama-server (bonsai) lacks it → 404, and
  // waitForExit below wasted all 10s on EVERY shutdown. For bonsai
  // skip graceful step — terminate/kill immediately.
  let exited = false
  if (llmBackend() !== 'bonsai') {
    try {
      await fetch(`http://127.0.0.1:${LLM_PORT}/shutdown`, {
        method: 'POST',
        signal: AbortSignal.timeout(3000),
      })
    } catch {
      /* server not responding — escalate to forced termination */
    }
    // 2) Wait for actual exit
    exited = await waitForExit(proc, 10_000)
  }
  // 3) Escalation: soft kill, then taskkill /F /T (process tree)
  if (!exited) {
    proc.kill()
    exited = await waitForExit(proc, 5_000)
  }
  if (!exited && proc.pid) {
    try {
      await execFileAsync('taskkill', ['/F', '/T', '/PID', String(proc.pid)])
    } catch {
      /* process may have already exited */
    }
    await waitForExit(proc, 5_000)
  }
  // Reset only if a new server hasn't already started (see ensureLlm).
  // Reset actualCtx here as well: if exit event hasn't arrived yet, its guard
  // child === proc won't fire and dead server context would "leak"
  // into next session planning.
  if (child === proc) {
    child = null
    gpuMode = null
    actualCtx = null
    spawnSig = null
  }
}
