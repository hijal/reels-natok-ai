/**
 * Upscale runner (fix 74) — lazy spawn/stop of the bundled
 * DLSS 5 Visual Enhancer bridge (upscale/bridge.py, native JSON API).
 *
 * The bridge runs on the embedded Python (upscale/bin/python-3.13.15-embed-amd64)
 * and exposes the DLSS pipelines (Neural Rendering / RTX VSR / Frame
 * Interpolation) over localhost HTTP. The browser talks to the Next.js
 * /api/upscale/* routes only; this module manages spawn/stop/health.
 *
 * Spawning contract:
 *   - UPSCALE_BRIDGE_PORT pinned (health must hit a predictable URL)
 *   - UPSCALE_OUTPUT_DIR — rendered files are published to the common
 *     ComfyUI output folder (app-config outputDir), so they show up in the
 *     shared gallery, the Gallery tab and are cleaned by "Clear Content"
 *   - PYTHONNOUSERSITE=1, PYTHONDONTWRITEBYTECODE=1, PYTHONIOENCODING=utf-8
 */
import { spawn, execFile, type ChildProcess } from 'child_process'
import { promisify } from 'util'
import { existsSync, mkdirSync } from 'fs'
import path from 'path'
import { getAppConfig } from './app-config'

const execFileAsync = promisify(execFile)

export interface UpscaleStartResult {
  ok: boolean
  error?: string
}

export interface UpscaleStatus {
  running: boolean
  starting: boolean
  error: string | null
  startedAt: number
}

export interface UpscaleHealth {
  ok: boolean
  ready: boolean
  error: string | null
  gpus: Array<{ uuid: string; label: string; ai_compatible: boolean; memory_gb: number }>
  output_dir: string
  features: string[]
  log_tail: string[]
}

export function upscaleDir(): string {
  return path.join(process.cwd(), 'upscale')
}

export function upscalePort(): number {
  return getAppConfig().upscalePort
}

export function bridgeUrl(base = '/'): string {
  return `http://127.0.0.1:${upscalePort()}${base}`
}

let child: ChildProcess | null = null
let starting: Promise<UpscaleStartResult> | null = null
let lastError: string | null = null
let startedAt = 0
/** Tail of the service stderr — quoted in error messages on early death. */
let stderrTail = ''
/**
 * (fix 77) adopted — a HEALTHY bridge is already listening on the port (survived after
 * app/session restart), but it is not our child process. We do not spawn a duplicate:
 * we "adopt" it — running=true, and on stop we kill it by PID from netstat.
 * This provides "fast startup" after app restart, and eliminates the "phantom"
 * state (dead child + orphan on port → UI perpetually "not running" while health answers).
 */
let adopted = false
/**
 * (fix 77) manualStop — user explicitly clicked "Stop".
 * Auto-start (client tick) must not bring the service back up until
 * the user clicks "Start" (force) themselves.
 */
let manualStop = false

// (fix 348) Orphans: on Node process exit (studio shutdown), the child
// bridge remained alive on the port. Synchronous kill in exit/signal handlers.
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

export function upscaleStatus(): UpscaleStatus {
  return {
    // (fix 716) Check signalCode as well: a process killed by signal should not
    // be considered "running" (llm-runner.ts and stt-runner.ts check the same).
    running: (!!child && !child.killed && child.exitCode === null && child.signalCode === null) || adopted,
    starting: !!starting,
    error: lastError,
    startedAt,
  }
}

/** GET /health from the bridge. Fast; `ready` is polled by the UI. */
export async function fetchUpscaleHealth(timeoutMs = 3000): Promise<UpscaleHealth> {
  const r = await fetch(bridgeUrl('/health'), { signal: AbortSignal.timeout(timeoutMs) })
  if (!r.ok) throw new Error(`bridge /health → ${r.status}`)
  const data = (await r.json()) as UpscaleHealth
  return data
}

async function healthUp(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child && (child.killed || child.exitCode !== null || child.signalCode !== null)) {
      return false
    }
    // (fix 344) User clicked "Stop" during startup.
    if (manualStop) return false
    try {
      const r = await fetch(bridgeUrl('/health'), { signal: AbortSignal.timeout(2500) })
      if (r.ok) return true
    } catch {
      /* not up yet — heavy imports / runtime prep */
    }
    await new Promise((r) => setTimeout(r, 700))
  }
  return false
}

/** Kill the process tree (bridge has no children, but keep the pattern). */
function killTree(pid?: number) {
  if (process.platform === 'win32' && pid) {
    // taskkill almost always has non-zero exit if PID is already dead — swallow
    void execFileAsync('taskkill', ['/F', '/T', '/PID', String(pid)]).catch(() => {})
  }
}

function cleanChild(proc: ChildProcess) {
  if (child === proc) child = null
  try { proc.kill() } catch { /* already dead */ }
}

function appendStderr(data: Buffer) {
  stderrTail = (stderrTail + data.toString('utf8')).slice(-8000)
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * (fix 77) PIDs of processes holding the port (Windows, netstat -ano).
 * Best effort: empty list if netstat is unavailable or no listeners exist.
 * State column is not checked (localization); TIME_WAIT (PID "-")
 * is ignored by the regex.
 */
async function findPortPids(port: number): Promise<number[]> {
  if (process.platform !== 'win32') return []
  try {
    const { stdout } = await execFileAsync('netstat', ['-ano'])
    const pids = new Set<number>()
    for (const line of stdout.split(/\r?\n/)) {
      // netstat -ano prints lines with leading whitespace — trim is mandatory.
      // (fix 340) LISTENING socket marker — foreign address "all zeros":
      // on Windows netstat prints '0.0.0.0:0' or '[::]:0', while Linux format
      // '*:*' does not appear here. Previously only '*:*' was checked → regex
      // did not match ANY line, and killPortHolders killed nothing.
      const m = line.trim().match(/^tcp\s+(\S+):(\d+)\s+(\S+)\s+\S+\s+(\d+)/i)
      if (m && Number(m[2]) === port && (m[3] === '*:*' || m[3] === '0.0.0.0:0' || m[3] === '[::]:0')) {
        const pid = Number(m[4])
        if (Number.isFinite(pid) && pid > 0) pids.add(pid)
      }
    }
    return [...pids]
  } catch {
    return []
  }
}

/** (fix 77) Kill all processes holding the port (orphaned/zombie bridge). Best effort. */
async function killPortHolders(port: number): Promise<void> {
  const pids = await findPortPids(port)
  for (const pid of pids) killTree(pid)
}

/**
 * Start the Upscale bridge (idempotent). Resolves when /health answers.
 * First start can take ~30–60 s (imports + runtime validation + GPU detect).
 *
 * (fix 77) `opts.force` — explicit "Start" from UI: resets manualStop.
 * Without force (auto-start) — respects explicit stop by user.
 */
export async function ensureUpscale(opts: { force?: boolean } = {}): Promise<UpscaleStartResult> {
  // (fix 716) force is handled BEFORE checking starting. Previously
  // `if (starting) return starting` came first, and user's explicit action
  // ("Start") was lost: force did not reach manualStop reset, and an in-flight
  // auto-start remained, which was immediately aborted with "Stopped by user".
  if (opts.force) manualStop = false
  if (starting) return starting
  // (fix 344) manualStop is reset ONLY here, upon explicit force from UI.
  // Previously starting-promise unconditionally reset the flag (manualStop = false after
  // spawn) — stopUpscale arriving DURING start was lost: process still started up
  // even though user just clicked "Stop".
  if (manualStop && !opts.force) {
    return { ok: false, error: 'Service stopped by user — click "Start"' }
  }
  if (child && !child.killed && child.exitCode === null && child.signalCode === null) {
    const ok = await healthUp(8000)
    if (ok) {
      lastError = null
      return { ok: true }
    }
    // (fix "semi-dead" child) process alive, but /health unresponsive:
    // kill tree and recreate below — otherwise status stays running=true,
    // health=null and UI hangs on "runtime preparation…" without auto-start.
    killTree(child.pid)
    cleanChild(child)
  }
  if (adopted) {
    // (fix 77) already "adopted" an external healthy bridge — verify if it is alive.
    try {
      const h = await fetchUpscaleHealth(2500)
      if (h) {
        lastError = null
        return { ok: true }
      }
    } catch {
      /* bridge died — recreate below */
    }
    adopted = false
  }

  starting = (async () => {
    let proc: ChildProcess | null = null
    try {
      const cfg = getAppConfig()
      if (!cfg.upscaleEnabled) {
        return { ok: false, error: 'Upscale tab disabled: config.ini → [upscale] enabled=1' }
      }

      const dir = upscaleDir()
      const pythonExe = path.join(dir, 'bin', 'python-3.13.15-embed-amd64', 'python.exe')
      const entry = path.join(dir, 'bridge.py')

      if (!existsSync(pythonExe)) {
        const msg = 'Embedded Upscale runtime not found (upscale/bin/…). The upscale/ folder must be located next to start.bat.'
        lastError = msg
        return { ok: false, error: msg }
      }
      if (!existsSync(entry)) {
        const msg = `Input file not found: ${entry}`
        lastError = msg
        return { ok: false, error: msg }
      }

      stderrTail = ''
      const port = upscalePort()
      // (fix 344) manualStop is NOT reset here — see ensureUpscale above.

      // (fix 77) If a HEALTHY bridge is already listening on the port (survived
      // app restart), adopt it instead of spawning a duplicate: new process
      // would fail on bind, while healthUp would see the orphan — causing phantom
      // state "running=false, but service works". Adoption = instant.
      try {
        const h = await fetchUpscaleHealth(2500)
        if (h) {
          adopted = true
          startedAt = Date.now()
          lastError = null
          return { ok: true }
        }
      } catch {
        /* no healthy bridge on port — spawn our own */
      }

      // (fix 77) Port occupied by dead process (zombie listener) — free it,
      // otherwise our bridge will fail on bind and healthUp will wait up to 3 minutes.
      try {
        await killPortHolders(port)
        await sleep(600)
      } catch {
        /* best effort */
      }

      // Ensure common output directory exists (backend might not have created it).
      try {
        mkdirSync(cfg.outputDir, { recursive: true })
      } catch {
        /* best effort — bridge will create it or fail with clear error */
      }

      const env = {
        ...process.env,
        PYTHONNOUSERSITE: '1',
        PYTHONDONTWRITEBYTECODE: '1',
        PYTHONIOENCODING: 'utf-8',
        UPSCALE_BRIDGE_PORT: String(port),
        // (fix 74.2) results go to common ComfyUI output folder, so they are
        // visible in shared gallery and "Gallery" tab.
        UPSCALE_OUTPUT_DIR: cfg.outputDir,
      }

      proc = spawn(pythonExe, [entry], {
        cwd: dir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      child = proc
      startedAt = Date.now()
      /* Bridge writes access log of every HTTP request to stdout, while client
         singleton pings /health every 2.5s — studio console was flooded
         with "GET /health 200" lines. Filter successful health pings;
         everything else (rendering, errors, non-200 responses) passes through. */
      proc.stdout?.on('data', (d: Buffer) => {
        for (const line of d.toString('utf8').split(/\r?\n/)) {
          if (!line) continue
          // bridge format: `HTTP "GET /health HTTP/1.1" 200 -`
          if (line.includes('GET /health') && /\s200\b/.test(line)) continue
          process.stdout.write(`[upscale] ${line}\n`)
        }
      })
      proc.stderr?.on('data', (d: Buffer) => {
        appendStderr(d)
        process.stderr.write(`[upscale] ${d}`)
      })
      proc.on('exit', () => {
        if (child === proc) {
          child = null
        }
      })

      // (fix 344) Stop arrived while spawn / adoption checks were in progress —
      // kill freshly created process rather than continuing startup.
      if (manualStop) {
        killTree(proc.pid)
        cleanChild(proc)
        return { ok: false, error: 'Stopped by user' }
      }

      // Imports + runtime prep + GPU detection: allow 3 minutes.
      const up = await healthUp(180_000)
      if (!up) {
        // (fix 344) Stop during prepare_runtime — not a launch error.
        if (manualStop) {
          killTree(proc.pid)
          cleanChild(proc)
          return { ok: false, error: 'Stopped by user' }
        }
        const tail = stderrTail.trim().split(/\r?\n/).slice(-3).join(' | ').slice(0, 400)
        const err = `Upscale failed to start: port ${port} occupied or process exited. ${tail ? `Log: ${tail}` : 'See console'}`
        lastError = err
        if (child === proc) {
          killTree(proc.pid)
          cleanChild(proc)
        }
        return { ok: false, error: err }
      }
      lastError = null
      return { ok: true }
    } catch (err) {
      if (proc && child === proc) {
        killTree(proc.pid)
        cleanChild(proc)
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

/** Stop the Upscale bridge (no graceful endpoint — kill the process). */
export async function stopUpscale(): Promise<void> {
  // (fix 77) adopted bridge is not our child: kill by PID holding the port.
  if (adopted) {
    const port = upscalePort()
    adopted = false
    manualStop = true
    try {
      await killPortHolders(port)
      await sleep(300)
    } catch {
      /* best effort */
    }
    lastError = null
    return
  }
  const proc = child
  if (!proc) {
    child = null
    manualStop = true
    return
  }
  manualStop = true
  killTree(proc.pid)
  const exited = await waitForExit(proc, 6_000)
  if (!exited) {
    // (fix) process did not exit in 6s — force kill and reliably clear
    // child reference. Previously, if second waitForExit failed, child stayed
    // "stuck" in the variable and ensureUpscale saw it as alive.
    cleanChild(proc)
    await waitForExit(proc, 4_000)
  }
  // (fix) in any outcome — if child is still our proc, reset it.
  if (child === proc) child = null
  lastError = null
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
