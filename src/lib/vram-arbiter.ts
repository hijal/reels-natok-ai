/**
 * VRAM Arbiter — strict mutual exclusion between LLM ↔ MiniMax H3.
 *
 * Rules (see docs/superpowers/specs/2026-08-31-vram-arbiter-design.md):
 *  • video generation running → LLM chat forbidden (409);
 *  • LLM responding → generation forbidden (409);
 *  • before loading LLM — evict ComfyUI models and CONFIRM via nvidia-smi;
 *  • before submitting generation — evict LLM and CONFIRM via nvidia-smi;
 *  • after all generations finish, ComfyUI models are evicted in background.
 *
 * All transitions are serialized by async-mutex (withLock): chat and generation
 * physically cannot execute in parallel.
 */
import { execFile } from 'child_process'
import { promisify } from 'util'
import { awaitLlmStartup, llmPid, stopLlm } from './llm-runner'
import { getAppConfig } from './app-config'

const execFileAsync = promisify(execFile)

const COMFY_URL = (process.env.COMFY_URL || 'http://127.0.0.1:8188').replace(/\/+$/, '')

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/* ── Async-mutex: promise chain ── */

let chain: Promise<unknown> = Promise.resolve()

/**
 * (Phase 4 fix; revised in fix 138) Maximum wait time to ACQUIRE
 * mutex for a SINGLE call. 120s is more than enough
 * for all normal operations (evict LLM ~15s, evict Comfy ~90s).
 *
 * (fix 138) Timeout applies ONLY to waiting for lock acquisition, NOT to
 * holder execution: previous race "released" lock (chain = run.catch),
 * and next operation entered "mutex" IN PARALLEL with hung one — mutual
 * exclusion broke. Now chain always waits for ACTUAL completion
 * of holder; timeout only rejects waiting call with error.
 * Protection against permanent deadlock is preserved: each waiting call gets
 * error after 120s (chat/generation don't hang silently), but critical
 * section stays under hung holder until its factual finish.
 */
const LOCK_WAIT_TIMEOUT_MS = 120_000

/**
 * Serializes the passed operation: next call waits for previous to complete.
 * NOT re-entrant: calling withLock inside locked section causes deadlock.
 *
 * (Phase 4 fix) Guarantees:
 *  1. chain NEVER remains rejected — each link finishes resolved.
 *  2. (fix 138) Waiting has timeout ONLY for the waiting call:
 *     hung operation continues to own the lock until completion —
 *     concurrent entry into critical section is prevented.
 */
export function withLock<T>(fn: () => Promise<T>): Promise<T> {
  // (fix 138) chain waits for ACTUAL completion of previous link — without
  // race. Timeout below rejects only the WAITING caller, without releasing
  // lock prematurely. After timeout the operation of this call itself is NOT
  // executed (guard timedOut — as before), but lock remains with
  // hung holder until its factual completion.
  let timedOut = false
  let waitTimer: ReturnType<typeof setTimeout> | undefined
  const run = chain.then(() => {
    // Lock acquired: timeout no longer constrains execution of fn().
    clearTimeout(waitTimer)
    if (timedOut) return undefined as T
    return fn()
  })

  // chain is always resolved — even if run rejected, chain is not blocked.
  chain = run.catch(() => {})

  // Wait timeout for THIS call: hung previous operation doesn't
  // freeze chat/generation forever — call is rejected with error, but lock
  // is NOT released.
  const raced = Promise.race([
    run,
    new Promise<never>((_, reject) => {
      waitTimer = setTimeout(() => {
        timedOut = true
        reject(new Error(
          `VRAM Arbiter: waiting for release took >${LOCK_WAIT_TIMEOUT_MS / 1000} s (previous operation hung)`,
        ))
      }, LOCK_WAIT_TIMEOUT_MS)
    }),
  ])
  return raced
}

/* ── Counter of active LLM SSE streams ── */

let streamingCount = 0

/** (fix 110) Timestamp of last +1 — for leak watchdog. 0 = no streams. */
let streamingStartedAt = 0

/** (fix 110) A lock held longer than this is considered stuck. A healthy
 * stream won't live this long: idle watchdog terminates LLM after 5 min of silence,
 * connection to upstream is bounded by 120 s. */
const STREAMING_STUCK_MS = 30 * 60_000

/** +1 on response stream start, -1 on completion/disconnect. */
export function noteLlmStreaming(delta: 1 | -1): void {
  const prev = streamingCount
  streamingCount = Math.max(0, streamingCount + delta)
  // (fix 110) timestamp + diagnostic log (visible in server.log who did +1/−1)
  if (delta > 0) streamingStartedAt = Date.now()
  if (streamingCount === 0) streamingStartedAt = 0
  console.log(`[vram] (fix 110) streaming: ${prev} → ${streamingCount}`)
}

/** True while LLM is generating answer in chat. */
export function llmStreaming(): boolean {
  if (streamingCount <= 0) return false
  // (fix 110) Leak watchdog: if stream pump got stuck (hung
  // writer.write/close on half-open socket) and finish() never fired,
  // counter would hold generation lock FOREVER (button 409 forever).
  // A healthy stream won't live longer than STREAMING_STUCK_MS — release lock.
  if (streamingStartedAt > 0 && Date.now() - streamingStartedAt > STREAMING_STUCK_MS) {
    console.warn(`[vram] (fix 110) streaming counter stuck (count=${streamingCount}, >30 min) — releasing lock`)
    streamingCount = 0
    streamingStartedAt = 0
    return false
  }
  return true
}

/**
 * (fix 590) Check if chatActive is stuck (cold start hung).
 * If stuck — reset.
 *
 * (fix 716) Reset is now TIME-BASED ONLY, not "if no streams".
 * Previous check `streamingCount <= 0` triggered in normal situation:
 * chat queued behind mutex, model still loading (no streams yet)
 * → any read-only status poll (/api/llm/status) reset
 * chatActive → "LLM responding → generation forbidden" guard disappeared, and
 * generation started right when LLM was loading into VRAM.
 * Now flag is considered stuck only if held longer than
 * CHAT_ACTIVE_STALE_MS AND there are no streams.
 */
const CHAT_ACTIVE_STALE_MS = 5 * 60_000

function checkAndResetChatActive(): void {
  if (!chatActive) return
  // Fresh flag (model loading, chat queued) — do NOT touch.
  const age = chatActiveSince > 0 ? Date.now() - chatActiveSince : 0
  if (age < CHAT_ACTIVE_STALE_MS) return
  if (streamingCount <= 0) {
    console.warn(`[vram] (fix 716) chatActive true for ${Math.round(age / 1000)} s and streamingCount=0 — resetting (stuck on cold start)`)
    chatActive = false
    chatActiveSince = 0
  }
}

/**
 * (fix 110) Force-release assistant lock (UI fallback).
 * Only if lock held LONGER than `minAgeMs`: fresh lock (stream actually
 * running) is not touched. true = released, false = nothing to release / lock is fresh.
 * 
 * (fix 590) Also resets chatActive if stuck (cold start hung, finally
 * didn't fire). Otherwise forceRelease wouldn't help: assertGenerationAllowed
 * checks chatActive || llmStreaming().
 *
 * (fix 692) `force=true` — unconditional reset of streamingCount + chatActive,
 * ignoring minAge. Used by second pass of client fallback when
 * first (non-force) did not help: streamingCount held < minAgeMs, but in reality
 * stream is no longer active (leaked finish()).
 */
export function forceReleaseAssistantLock(minAgeMs: number = 60_000, force = false): boolean {
  let released = false
  
  // Reset streamingCount if stuck (or force)
  if (streamingCount > 0) {
    const held = streamingStartedAt > 0 ? Date.now() - streamingStartedAt : Infinity
    if (held >= minAgeMs || force) {
      if (force) {
        console.warn(`[vram] (fix 692) forceRelease(force): count ${streamingCount} → 0 (forced)`)
      } else {
        console.warn(`[vram] (fix 110) forceRelease: count ${streamingCount} → 0 (lock was held for ${Math.round(held / 1000)} s)`)
      }
      streamingCount = 0
      streamingStartedAt = 0
      released = true
    }
  }
  
  // (fix 590/717) reset chatActive ONLY by age (or force).
  // Previously there was NO age check here: /api/llm/release was called on
  // every "To Prompt" and in 60s client fallback, releasing
  // lock of FRESH chat (model loading into VRAM — chatActive=true).
  // Afterwards assertGenerationAllowed() allowed generation, and
  // evictLlmVerified() killed loading model — chat request died, and
  // user message was left without response.
  if (chatActive) {
    const chatAge = chatActiveSince > 0 ? Date.now() - chatActiveSince : Infinity
    if (chatAge >= minAgeMs || force) {
      if (force) {
        console.warn(`[vram] (fix 692) forceRelease(force): chatActive true → false (forced)`)
      } else {
        console.warn(`[vram] (fix 717) forceRelease: chatActive true → false (lock was held for ${Math.round(chatAge / 1000)} s)`)
      }
      chatActive = false
      chatActiveSince = 0
      released = true
    }
  }
  
  return released
}

/* ── ComfyUI queue state ── */

/** True when ComfyUI has running/pending tasks (generation "has not finished"). */
export async function comfyBusy(): Promise<boolean> {
  try {
    const r = await fetch(`${COMFY_URL}/queue`, { signal: AbortSignal.timeout(4000) })
    if (!r.ok) return false
    const q = await r.json()
    return (q.queue_running?.length ?? 0) > 0 || (q.queue_pending?.length ?? 0) > 0
  } catch {
    return false // ComfyUI unreachable — nothing can be running
  }
}

/* ── nvidia-smi: per-process VRAM ── */

/** VRAM (MB) by PID for processes on GPU. null = nvidia-smi unavailable. Value -1 = volume unknown (WDDM `[N/A]`). */
async function gpuProcs(): Promise<Map<number, number> | null> {
  try {
    const { stdout } = await execFileAsync(
      'nvidia-smi',
      ['--query-compute-apps=pid,used_memory', '--format=csv,noheader,nounits'],
      { timeout: 5000 },
    )
    const map = new Map<number, number>()
    for (const line of stdout.trim().split(/\r?\n/)) {
      if (!line.trim()) continue
      const [pidS, mbS] = line.split(',')
      const pid = parseInt((pidS ?? '').trim(), 10)
      const mb = parseInt((mbS ?? '').replace(/[^\d]/g, ''), 10)
      if (Number.isFinite(pid) && pid > 0) map.set(pid, Number.isFinite(mb) ? mb : -1)
    }
    return map
  } catch {
    return null
  }
}

/**
 * Globally used VRAM (MB) across ALL processes. null = nvidia-smi unavailable.
 * On Windows WDDM per-process memory is unavailable ([N/A]), but global always is.
 * NOTE: on WDDM nvidia-smi lags by tens of seconds after deallocation.
 */
async function gpuUsedMb(): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(
      'nvidia-smi',
      ['--query-gpu=memory.used', '--format=csv,noheader,nounits'],
      { timeout: 5000 },
    )
    const mb = parseInt((stdout.trim().split(/\r?\n/)[0] ?? ''), 10)
    return Number.isFinite(mb) ? mb : null
  } catch {
    return null
  }
}

/**
 * Used VRAM (MB) according to ComfyUI ITSELF (/system_stats → cudaMemGetInfo).
 * Real time — unlike nvidia-smi on WDDM. Accounts for all processes.
 * null = ComfyUI unavailable or unexpected response format.
 */
async function comfyVramUsedMb(): Promise<number | null> {
  try {
    const r = await fetch(`${COMFY_URL}/system_stats`, { signal: AbortSignal.timeout(4000) })
    if (!r.ok) return null
    const j = await r.json()
    const d = j?.devices?.[0]
    const total = typeof d?.vram_total === 'number' ? d.vram_total : NaN
    const free = typeof d?.vram_free === 'number' ? d.vram_free : NaN
    if (!Number.isFinite(total) || !Number.isFinite(free)) return null
    return Math.round((total - free) / (1024 * 1024))
  } catch {
    return null
  }
}

/* ── ComfyUI /free ── */

/** Ask ComfyUI to unload models (asynchronous on ComfyUI side!). */
async function freeComfy(): Promise<void> {
  try {
    await fetch(`${COMFY_URL}/free`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    /* ComfyUI unreachable — nothing to unload */
  }
}

/* ── ComfyUI PID lookup ── */

const PS_FIND_COMFY = [
  "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\"",
  "Where-Object { $_.CommandLine -like '*ComfyUI*main.py*' }",
  'Select-Object -ExpandProperty ProcessId',
].join(' | ')

/** PID of ComfyUI python process (by command line). null = not running. */
async function findComfyPid(): Promise<number | null> {
  const { stdout } = await execFileAsync(
    'powershell',
    ['-NoProfile', '-Command', PS_FIND_COMFY],
    { timeout: 10_000 },
  )
  const pid = parseInt((stdout.trim().split(/\r?\n/)[0] ?? ''), 10)
  return Number.isFinite(pid) && pid > 0 ? pid : null
}

/* ── Verified evictions ── */

export type EvictResult = { ok: true } | { ok: false; error: string }

/**
 * (fix 137) Graceful degradation when nvidia-smi is unavailable (AMD/CPU-only
 * machine): previously evict immediately returned error → chat got permanent 503.
 * If [llm] device=cpu — VRAM conflict is physically impossible (LLM on CPU,
 * ComfyUI without NVIDIA GPU also does not hold VRAM): evict not needed, skip.
 * If GPU mode is configured, but nvidia-smi is missing in system — verification
 * cannot be performed: skip with warning in log (warned risk is
 * better than guaranteed blocked assistant/generation).
 */
function noSmiEvictResult(context: string): EvictResult {
  let cpuOnly = false
  try { cpuOnly = getAppConfig().llmDevice === 'cpu' } catch { /* config unavailable */ }
  console.warn(
    `[vram] (fix 137) ${context}: nvidia-smi unavailable — ` +
    (cpuOnly
      ? 'llm device=cpu, VRAM conflict impossible: eviction skipped'
      : 'GPU mode configured, but VRAM release cannot be verified: continuing without verification'),
  )
  return { ok: true }
}

/**
 * Evict LLM and verify via nvidia-smi that its PID disappeared from GPU.
 * Call ONLY under withLock. Takes up to ~15 s (usually 1–2 s).
 */
export async function evictLlmVerified(): Promise<EvictResult> {
  // While LLM is starting, stopLlm is useless (process not created yet or
  // still loading) — await startup, then stop and verify.
  await awaitLlmStartup()
  const pid = llmPid()
  if (pid !== null) {
    console.log('[vram] evicting LLM before generation…')
    await stopLlm()
  }
  if (pid === null) return { ok: true } // was not running
  const deadline = Date.now() + 15_000
  for (;;) {
    const procs = await gpuProcs()
    if (procs === null) return noSmiEvictResult('evictLlm') // (fix 137)
    if (!procs.has(pid)) {
      console.log(`[vram] LLM (PID ${pid}) completely left VRAM`)
      return { ok: true }
    }
    if (Date.now() > deadline) {
      const mb = procs.get(pid) ?? 0
      return { ok: false, error: `LLM (PID ${pid}) did not free VRAM in 15s (${mb < 0 ? 'memory unknown' : `${mb} MB`})` }
    }
    await sleep(500)
  }
}

/** ComfyUI is considered "empty" when its process holds ≤ this memory (CUDA context only). */
const COMFY_EMPTY_MB = 1500

/**
 * "GPU empty" threshold for GLOBAL check (WDDM mode, per-process unavailable):
 * baseline — CUDA contexts of all processes (~1–1.5 GB), without ComfyUI models.
 */
const COMFY_GLOBAL_EMPTY_MB = 2500

/**
 * Evict ComfyUI models (POST /free) and confirm VRAM release.
 * Verification, in order of reliability:
 *  1) per-process nvidia-smi (when driver provides memory — TCC/some systems);
 *  2) /system_stats of ComfyUI itself (cudaMemGetInfo — real time);
 *  3) global nvidia-smi (on WDDM lags by tens of seconds).
 * ComfyUI PID — only speeds up exact branch; on lookup failure verify via
 * system metrics (freeComfy does not require PID). Call ONLY under withLock.
 */
export async function evictComfyVerified(timeoutMs = 30_000): Promise<EvictResult> {
  const procs0 = await gpuProcs()
  if (procs0 === null) return noSmiEvictResult('evictComfy') // (fix 137)

  let comfyPid: number | null = null
  try {
    comfyPid = await findComfyPid()
  } catch {
    comfyPid = null // CIM query sometimes times out — verify via metrics
  }

  // (fix 136) ComfyUI NOT running → nothing to evict: its models
  // physically do not exist in VRAM. Previously fallback to GLOBAL nvidia-smi
  // kicked in, which counts OUR own LLM process (Bonsai ~10 GB) and third-party
  // apps → false 503 "did not free VRAM" on SECOND chat message,
  // if ComfyUI is turned off at that time.
  if (comfyPid === null) {
    const comfyAlive = await fetch(`${COMFY_URL}/system_stats`, {
      signal: AbortSignal.timeout(2500),
    }).then((r) => r.ok).catch(() => false)
    if (!comfyAlive) {
      console.log('[vram] ComfyUI is not running — no need to evict its models')
      return { ok: true }
    }
  }

  if (comfyPid === null) {
    console.log('[vram] ComfyUI PID not found — verifying via system metrics')
  }

  // Fast exit: PID is known and ComfyUI no longer holds GPU
  if (comfyPid !== null && !procs0.has(comfyPid)) {
    console.log(`[vram] MiniMax evicted: ComfyUI (PID ${comfyPid}) left GPU processes`)
    return { ok: true }
  }

  const deadline = Date.now() + timeoutMs
  for (;;) {
    await freeComfy()
    const procs = await gpuProcs()
    if (procs === null) return noSmiEvictResult('evictComfy') // (fix 137)

    let used: number | null
    let threshold: number
    const mb = comfyPid !== null ? procs.get(comfyPid) : undefined
    if (mb !== undefined && mb >= 0) {
      // per-process memory available — exact check
      used = mb
      threshold = COMFY_EMPTY_MB
    } else {
      // WDDM [N/A] or PID not found: /system_stats (real time),
      // fallback — global nvidia-smi
      used = (await comfyVramUsedMb()) ?? (await gpuUsedMb())
      threshold = COMFY_GLOBAL_EMPTY_MB
    }
    if (used === null) return noSmiEvictResult('evictComfy') // (fix 137)

    if (used <= threshold) {
      console.log(`[vram] MiniMax evicted (using ${used} MB${comfyPid === null ? ', without PID' : ''})`)
      return { ok: true }
    }
    if (Date.now() > deadline) {
      return { ok: false, error: `ComfyUI did not free VRAM in ${timeoutMs / 1000}s (used ${used} MB > ${threshold} MB)` }
    }
    await sleep(1500)
  }
}

/* ── Guards (block reason or null = allowed) ── */

/** 409 reason forbidding chat: generation in progress (running or pending). */
export async function assertChatAllowed(): Promise<string | null> {
  return (await comfyBusy())
    ? 'Video generation in progress. Wait for it to finish or cancel it.'
    : null
}

/** True while chat request is active: loading model OR streaming answer. */
let chatActive = false
/**
 * (fix 716) Timestamp when chatActive was set — needed to determine "stuck"
 * flag by time (see checkAndResetChatActive).
 */
let chatActiveSince = 0

/**
 * 409 reason forbidding generation: assistant is busy (loading or answering).
 * chatActive covers cold start (before stream starts), counter — response itself;
 * together they cover entire chat lifecycle WITHOUT waiting for mutex.
 *
 * (fix 716) Function PURELY READS state. Previously it reset
 * stuck chatActive, and was invoked by read-only endpoint /api/llm/status —
 * meaning STATUS POLL changed arbitration and could permit generation during
 * LLM loading. Reset moved to runGeneration (called under mutex,
 * where reset is safe) — see opts.resetStale.
 */
export function assertGenerationAllowed(opts: { resetStale?: boolean } = {}): string | null {
  if (opts.resetStale) {
    // (fix 590) Automatic reset of stuck chatActive
    checkAndResetChatActive()
  }

  return chatActive || llmStreaming()
    ? 'Assistant is answering. Wait for response or cancel it.'
    : null
}

/* ── Composite operations under mutex ── */

export type GateResult<T> = { ok: true; result: T } | { ok: false; error: string; status: number }

/**
 * Prepare GPU for generation and SUBMIT task under the same mutex
 * (gap between check and enqueue is eliminated):
 * guard → evict LLM (verified) → submit().
 * 409 = state conflict, 503 = eviction failed, 500 = submit error.
 */
export async function runGeneration<T>(submit: () => Promise<T>): Promise<GateResult<T>> {
  try {
    return await withLock(async () => {
      // (fix 716) resetStale: reset stuck chatActive HERE, under
      // mutex (safe here: chat already released mutex). Previously reset
      // also happened in read-only /api/llm/status — status poll should not
      // alter VRAM arbitration.
      const reason = assertGenerationAllowed({ resetStale: true })
      if (reason) {
        console.warn(`[vram] runGeneration BLOCKED: ${reason}`)
        return { ok: false, error: reason, status: 409 }
      }
      const ev = await evictLlmVerified()
      if (!ev.ok) {
        console.error(`[vram] runGeneration FAILED: ${ev.error}`)
        return { ok: false, error: ev.error, status: 503 }
      }
      try {
        const result = await submit()
        console.log(`[vram] runGeneration OK`)
        return { ok: true, result }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[vram] runGeneration SUBMIT ERROR: ${msg}`)
        return { ok: false, error: msg, status: 500 }
      }
    })
  } catch (err) {
    // (Phase 4 fix) withLock could reject (should not happen after fix,
    // but safety): return structured error instead of unhandled rejection.
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[vram] runGeneration UNEXPECTED ERROR: ${msg}`)
    return { ok: false, error: `VRAM Arbiter internal error: ${msg}`, status: 500 }
  }
}

/**
 * Prepare GPU for chat under mutex:
 * guard (generation?) → evict ComfyUI (verified) → start() (= ensureLlm,
 * holds mutex for entire model loading — generation correctly waits).
 *
 * CONTRACT: if start() launches response stream, noteLlmStreaming(+1) must
 * be called INSIDE start() — while mutex is still held. Otherwise between release of
 * mutex and start of stream, generation could evict just-loaded LLM.
 */
export async function startChat<T>(start: () => Promise<T>): Promise<GateResult<T>> {
  chatActive = true
  chatActiveSince = Date.now()
  console.log(`[vram] (fix 590) startChat: chatActive=true`)
  try {
    try {
      return await withLock(async () => {
        const reason = await assertChatAllowed()
        if (reason) return { ok: false, error: reason, status: 409 }
        const ev = await evictComfyVerified()
        if (!ev.ok) return { ok: false, error: ev.error, status: 503 }
        try {
          const result = await start()
          console.log(`[vram] (fix 590) startChat: start() finished successfully`)
          return { ok: true, result }
        } catch (err) {
          console.error(`[vram] (fix 590) startChat: start() failed: ${err instanceof Error ? err.message : String(err)}`)
          return { ok: false, error: err instanceof Error ? err.message : String(err), status: 500 }
        }
      })
    } catch (err) {
      // (Phase 4 fix) Safety: orphan error from mutex chain.
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[vram] startChat UNEXPECTED ERROR: ${msg}`)
      return { ok: false, error: `VRAM Arbiter internal error: ${msg}`, status: 500 }
    }
  } finally {
    chatActive = false
    chatActiveSince = 0
    console.log(`[vram] (fix 590) startChat: chatActive=false (finally)`)
  }
}

/* ── Background eviction after all generations finish ── */

let lastDrainAt = 0

/**
 * Called by progress tracker when ComfyUI queue empties:
 * immediately evict MiniMax models from VRAM so GPU is free for LLM.
 * Minimum 5s between attempts (protection against duplicate status events).
 *
 * (Phase 4 fix) Previously this function HELD mutex for up to 90 seconds
 * (evictComfyVerified(90_000)). If user clicked "Generate" during
 * background eviction, their request waited in mutex queue up to 90s — and client
 * AbortSignal.timeout(60_000) killed the request earlier. Now: ComfyUI busy check
 * (fast) runs under lock, while eviction itself runs WITHOUT lock. If
 * generation starts concurrently, it simply won't find ComfyUI "empty" —
 * models will be evicted on the fly on next ComfyUI free request.
 */
export async function onQueueDrained(): Promise<void> {
  if (Date.now() - lastDrainAt < 5_000) return
  lastDrainAt = Date.now()
  console.log('[vram] queue empty — background eviction of MiniMax models')

  // Quick check under lock: do not compete with chat/generation start.
  // (fix 716) withLock REJECTS when exceeding LOCK_WAIT_TIMEOUT_MS
  // (120s) — and lock normally holds startChat during model loading
  // (up to 180s). Previously this await was outside try/catch, and called as
  // `void onQueueDrained()` — unhandled rejection in Next.js process →
  // server crash. Now caught and logged.
  let shouldEvict = false
  try {
    shouldEvict = await withLock(async () => {
      if (await comfyBusy()) return false
      if (llmPid() !== null || chatActive) return false
      return true
    })
  } catch (err) {
    console.log(`[vram] background eviction: lock wait timed out — ${err instanceof Error ? err.message : String(err)}`)
    return
  }
  if (!shouldEvict) return

  // Eviction WITHOUT lock: do not block generation for 90 seconds.
  // If generation starts concurrently — ComfyUI will evict models itself
  // upon loading new checkpoint (dynamic VRAM).
  try {
    const r = await evictComfyVerified(90_000)
    if (!r.ok) {
      console.log(`[vram] background eviction: VRAM not yet freed (${r.error}) — will retry on next chat call`)
    }
  } catch (err) {
    console.log(`[vram] background eviction: error — ${err instanceof Error ? err.message : err}`)
  }
}
