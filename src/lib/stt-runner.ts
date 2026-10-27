/**
 * STT runner (fix 65) — lazy spawn/stop of the bundled speech-to-text
 * service (whisper / transcribe.cpp).
 *
 * The service runs inside the ComfyUI embedded python (tools/stt_server.py,
 * ctypes → <project>/stt/transcribe.dll — self-contained, portable) on
 * 127.0.0.1:8091. CPU-only by design.
 *
 * The module only manages spawn/stop/health — VRAM arbitration is NOT
 * involved (STT never touches the GPU).
 */
import { spawn, execFile, type ChildProcess } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import { getAppConfig } from './app-config'

const execFileAsync = promisify(execFile)

export const STT_PORT = 8091

export interface SttStartResult {
  ok: boolean
  error?: string
}

export interface SttStatus {
  running: boolean
  starting: boolean
  error: string | null
  startedAt: number
}

let child: ChildProcess | null = null
let starting: Promise<SttStartResult> | null = null
let lastError: string | null = null
let startedAt = 0
/**
 * (fix 345) pendingStop — user clicked "Stop" while the server
 * is still starting (starting-promise is active, child might not exist yet).
 * Previously such a stop was lost: stopStt saw child=null and returned, while spawn
 * continued. Now the starting branch checks the flag after spawn and in healthUp.
 */
let pendingStop = false

// (fix 348) Orphans: on Node process exit (studio shutdown), the child
// STT server remained alive on port 8091 until its idle timeout (15 min).
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

export function sttStatus(): SttStatus {
  return {
    // exitCode/signalCode — process may have exited, but exit event not handled yet
    running: !!child && !child.killed && child.exitCode === null && child.signalCode === null,
    starting: !!starting,
    error: lastError,
    startedAt,
  }
}

async function healthUp(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  const proc = child
  while (Date.now() < deadline) {
    // Process died (crashed on start) — don't poll dead port until timeout
    if (!proc || proc.killed || proc.exitCode !== null || proc.signalCode !== null) return false
    if (!child) return false
    // (fix 345) User clicked "Stop" during model loading.
    if (pendingStop) return false
    try {
      const r = await fetch(`http://127.0.0.1:${STT_PORT}/health`, {
        signal: AbortSignal.timeout(2000),
      })
      if (r.ok) return true
    } catch {
      /* not up yet — model still loading */
    }
    await new Promise((r) => setTimeout(r, 750))
  }
  return false
}

/** Start the STT service (idempotent). Resolves when /health answers. */
export async function ensureStt(): Promise<SttStartResult> {
  if (child && !child.killed) {
    // (fix 339) Process EXITED, but exit event hasn't fired yet — this is
    // a dead child: clear reference and fall through to cold spawn below,
    // instead of 5s polling of a known dead port.
    if (child.exitCode !== null || child.signalCode !== null) {
      child = null
    } else {
      const ok = await healthUp(5000)
      if (ok) {
        lastError = null
        return { ok: true }
      }
      // (fix 339) Semi-dead STT: process is ALIVE, but /health is unresponsive (deadlock
      // in whisper/transcribe.dll). This is OUR tracked child (PID known)
      // — kill and restart below, following the llm-runner pattern (fix 259).
      // Previously returned error, and EVERY subsequent request paid the same 5s
      // without any reanimation attempt.
      if (child && child.pid) {
        console.warn('[stt] (fix 339) process alive, but /health silent for 5s — killing and restarting')
        await stopStt()
      } else {
        lastError = 'STT server is not responding'
        return { ok: false, error: lastError }
      }
    }
  }
  if (starting) return starting
  // (fix 345) New (re)start — reset stop flag set
  // either by user during previous start, or by internal stopStt above.
  pendingStop = false

  starting = (async () => {
    let proc: ChildProcess | null = null
    try {
      const cfg = getAppConfig()
      if (!cfg.sttEnabled) {
        return { ok: false, error: 'Voice input is disabled in settings' }
      }

      // (fix 72) STT runtime is bundled in project: stt folder next to tools/ (stt/).
      // Pass explicitly so as not to rely on server defaults.
      const args = [
        path.join(process.cwd(), 'tools', 'stt_server.py'),
        '--stt-dir', cfg.sttDir,
        '--port', String(STT_PORT),
        '--language', cfg.sttLanguage,
        '--threads', String(cfg.sttThreads),
        '--idle-sec', '900',
      ]
      // Empty sttModel = let the server auto-pick the first model it finds.
      if (cfg.sttModel) args.push('--model', cfg.sttModel)

      proc = spawn(cfg.pythonExe, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      child = proc
      startedAt = Date.now()
      proc.stdout?.on('data', (d: Buffer) => process.stdout.write(`[stt] ${d}`))
      proc.stderr?.on('data', (d: Buffer) => process.stderr.write(`[stt] ${d}`))
      proc.on('exit', () => {
        if (child === proc) {
          child = null
        }
      })

      // (fix 345) Stop arrived while spawn was running (child was null) — kill
      // the freshly spawned process, rather than continuing model loading.
      if (pendingStop) {
        try { proc.kill() } catch { /* ignore */ }
        if (child === proc) child = null
        return { ok: false, error: 'Stopped by user' }
      }

      // Model load is the slow part (CPU, hundreds of MB) — allow 2 minutes.
      const up = await healthUp(120_000)
      if (!up) {
        // (fix 345) Stop during model loading — not a launch error.
        if (pendingStop) {
          try { proc.kill() } catch { /* ignore */ }
          if (child === proc) child = null
          return { ok: false, error: 'Stopped by user' }
        }
        // Process likely exited with an error (no model, bad DLL).
        const err = 'STT server failed to start: missing STT model or transcribe.dll not found (see console and "Voice Input" settings)'
        lastError = err
        if (child === proc) {
          try { proc.kill() } catch { /* already dead */ }
          child = null
        }
        return { ok: false, error: err }
      }
      lastError = null
      return { ok: true }
    } catch (err) {
      if (proc && child === proc) {
        try { proc.kill() } catch { /* ignore */ }
        child = null
      }
      const msg = err instanceof Error ? err.message : String(err)
      lastError = msg
      return { ok: false, error: msg }
    } finally {
      starting = null
    }
  })()

  return starting
}

/**
 * Stop the STT service: graceful POST /shutdown → wait for exit →
 * kill() → taskkill /F /T escalation (same contract as stopLlm).
 */
export async function stopStt(): Promise<void> {
  // (fix 345) Set flag BEFORE checking child: during startup, child
  // might not exist yet, and the starting branch will see the flag after spawn.
  pendingStop = true
  const proc = child
  if (!proc) {
    child = null
    // (fix 355) Reset traces of previous run: otherwise status after
    // stopping showed stale startedAt and old error.
    lastError = null
    startedAt = 0
    return
  }
  try {
    await fetch(`http://127.0.0.1:${STT_PORT}/shutdown`, {
      method: 'POST',
      signal: AbortSignal.timeout(3000),
    })
  } catch {
    /* server not responding — escalate */
  }
  let exited = await waitForExit(proc, 8_000)
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
  if (child === proc) {
    child = null
  }
  // (fix 355) See above: don't leave stale error/startedAt.
  lastError = null
  startedAt = 0
}

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
