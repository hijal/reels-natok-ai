/**
 * ComfyUI progress tracker.
 * Maintains a WebSocket connection to ComfyUI and stores:
 *   - Latest progress per prompt_id
 *   - Latest preview image (base64) per prompt_id
 *
 * IMPORTANT: Uses the SAME clientId as the prompt submission so that
 * ComfyUI ModelPreviewOverrideKJ events are delivered to us.
 */
import WebSocket from 'ws'
import { onQueueDrained } from '@/lib/vram-arbiter'

const COMFY_BASE_URL = (process.env.COMFY_URL || 'http://127.0.0.1:8188').replace(/\/+$/, '')
const COMFY_WS_URL = COMFY_BASE_URL.replace(/^http/, 'ws') + '/ws'

/** Single shared client_id used for BOTH prompt submission and WebSocket. */
const CLIENT_ID = `cb_session_${Date.now().toString(36)}`

export function getClientId(): string {
  return CLIENT_ID
}

interface NodeProgress {
  value: number
  max: number
}

/**
 * Per-prompt progress. The H3 workflow has TWO sampler passes (Pass 1 low-res,
 * Pass 2 high-res); each emits its own `progress` WS events, so a flat value/max
 * would bounce 0→100→0→100. We track each progress-emitting node separately and
 * expose an overall fraction that goes 0→100 once across all passes.
 */
interface ProgressEntry {
  /** progress-emitting nodes observed for this prompt, in order. */
  nodes: string[]
  byNode: Record<string, NodeProgress>
  /** True when `executing` reported node===null (prompt finished). */
  done: boolean
  /**
   * STICKY (fix 50): becomes true the moment ANY pass-2 node is observed
   * (progress event, executing event, or KJ preview node_id '13') and never
   * reverts. The workflow runs pass 1 → pass 2 strictly once, so the stage
   * must be monotonic. The old logic derived the stage from the most recent
   * event's node, so a pass-2 KJ preview event (pseudo-node 'preview',
   * statically stage 1) flipped the stage back to 1 every step — the overall
   * bar snapped to 50% (pass-1 fraction 1.0 → (0+1)/2) on every step.
   */
  stage2Seen: boolean
  /**
   * Which pass the shared 'preview' pseudo-node (KJ step/total) currently
   * reflects; set from the node_id of the kj_preview_override event, so stage
   * fractions never mix stale values from the other pass into the bar.
   */
  previewStage: number
  /**
   * (fix 255) Dynamic stages: submit registers a list of sampler nodes
   * in the workflow IN EXECUTION ORDER (generate full: ['46:21'],['46:16']; draft:
   * single; extend: ext_samp_i across clips; refine chunks: cs_k across windows).
   * Overall progress = (stage + fraction)/N — honest 0→100 for ANY number
   * of passes, not just two-pass generation.
   */
  stageSpecs: string[][] | null
  /** node_id → stage index (from stageSpecs; sampler nodes only). */
  nodeStage: Record<string, number> | null
  /**
   * (order fix) Sampler nodes in order of FIRST event. ComfyUI
   * executes independent refine windows out of numerical order
   * (observed cs_0 → cs_2 → cs_1): stage for label/percentage is
   * sequential index of STARTED sampler, not its node index,
   * otherwise "Chunk 3/3" appears during the second and percentage jumps.
   */
  stageObserved: string[]
  /** Sticky-maximum of observed stage (−1 = nothing seen). */
  maxStage: number
  /** Node currently being executed by ComfyUI (from 'executing'). */
  executingNode: string | null
  /**
   * Last sampler from which ANY event occurred (executing or
   * progress). Sampler progress flows continuously while it runs —
   * this is the most reliable indicator of "what is executing NOW": a single
   * runaway event from the next sampler is discarded by the very first event
   * of the actual one (fixes "Chunk 3/3" label during second window execution).
   */
  lastStageEvidence: string | null
  /**
   * (fix 479) Tile-upscale: geometry (number of tiles, chunks, steps).
   * Set on submission if successfully computed. KJ-events counters:
   * kjEventCount = how many KJ previews already arrived (each = 1 step of 1 tile-chunk).
   * Overall progress = kjEventCount / (totalUnits × stepsPerUnit), monotonically 0→1.
   */
  tileTotalUnits: number | null
  tileTotalTiles: number | null
  tileTotalChunks: number | null
  tileStepsPerUnit: number | null
  tileKjCount: number
}

interface PreviewEntry {
  image: string // base64 data
  mime: string // 'image/jpeg' | 'image/webp' | 'video/mp4' | 'image/png'
  width: number
  height: number
  step: number
  total: number
  timestamp: number
  /** (fix 198) Pass from which THIS frame came (1|2) — based on node_id
   *  of KJ event ('12'/'extpv' = 1, '13'/'extpv2' = 2). Non-sticky: needed so
   *  that /api/comfy/preview route can hide early "over-noised" frames
   *  of pass 2 without affecting drafts of pass 1. */
  stage?: number
}

const progressMap = new Map<string, ProgressEntry>()
const previewMap = new Map<string, PreviewEntry>()

function newEntry(): ProgressEntry {
  return {
    nodes: [], byNode: {}, done: false, stage2Seen: false, previewStage: 0,
    stageSpecs: null, nodeStage: null, stageObserved: [], maxStage: -1,
    executingNode: null, lastStageEvidence: null,
    tileTotalUnits: null, tileTotalTiles: null, tileTotalChunks: null,
    tileStepsPerUnit: null, tileKjCount: 0,
  }
}

/** (fix 479) Tile geometry for progress tracker. */
export interface TileGeometry {
  totalTiles: number
  tilesW: number
  tilesH: number
  totalChunks: number
  stepsPerUnit: number
  totalUnits: number
}

/**
 * (fix 255) Prompt stage registration: list of sampler node groups in
 * execution order. Called immediately after successful submit — before any
 * WS events. Without registration the legacy "exactly 2 passes" model runs.
 * (fix 479) Optional tileGeometry — for tile-upscale progress.
 */
export function registerPromptStages(
  promptId: string,
  stages: string[][],
  tileGeometry?: TileGeometry | null,
) {
  ensureConnected()
  const entry = progressMap.get(promptId) ?? newEntry()
  progressMap.set(promptId, entry)
  if (!stages.length) return
  entry.stageSpecs = stages
  const map: Record<string, number> = {}
  stages.forEach((nodes, idx) => {
    for (const n of nodes) map[n] = idx
  })
  entry.nodeStage = map
  entry.stageObserved = []
  // (fix 479) tile-upscale geometry
  if (tileGeometry) {
    entry.tileTotalUnits = tileGeometry.totalUnits
    entry.tileTotalTiles = tileGeometry.totalTiles
    entry.tileTotalChunks = tileGeometry.totalChunks
    // (fix 716) stepsPerUnit must be > 0: progress calculations
    // divide by it (tileKjCount / tileStepsPerUnit) — client could
    // send steps: 0, resulting in NaN-step/NaN-progress.
    entry.tileStepsPerUnit = Math.max(1, Math.floor(tileGeometry.stepsPerUnit || 0) || 1)
    entry.tileKjCount = 0
  }
}

/**
 * Real execution window per prompt (ms), measured directly from ComfyUI
 * `executing` WS events: first node start → node===null (finished).
 * This is the ACTUAL generation time — independent of poll intervals and
 * submission overhead — and the single source of truth for both the gallery
 * badge and the .meta.json sidecar.
 */
const execWindows = new Map<string, { start: number; end: number | null }>()

/** Get the real execution duration in ms, or null if not (yet) measured. */
export function getExecutionDurationMs(promptId: string): number | null {
  const w = execWindows.get(promptId)
  if (!w || w.end === null) return null
  return Math.max(0, w.end - w.start)
}

let ws: WebSocket | null = null
let connecting = false
let activePromptId: string | null = null
/** The prompt_id currently executing (from 'executing' WS event). */
let executingPromptId: string | null = null
/** Previous queue_remaining value from ComfyUI status events. */
let lastQueueRemaining = 0

/** Set the active prompt_id (called when we submit a job). */
export function setActivePrompt(id: string) {
  activePromptId = id
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return
  if (connecting) return
  connecting = true

  try {
    // Use clientId query param so ComfyUI routes events to this session
    const sock = new WebSocket(`${COMFY_WS_URL}?clientId=${CLIENT_ID}`)
    ws = sock

    sock.on('open', () => {
      connecting = false
    })

    sock.on('message', (raw) => {
      try {
        applyTrackerMessage(JSON.parse(raw.toString()))
      } catch { /* ignore parse errors */ }
    })

    // (fix 716) Handlers verify that the event came SPECIFICALLY from
    // the current socket. Previously handler of OLD socket assigned ws = null
    // unconditionally: if by then a new socket had already been created, module
    // lost reference to live connection (which remained open), and
    // next connect() created a SECOND connection → duplicate ComfyUI events
    // and duplicate progress/preview updates.
    const isCurrent = () => ws === sock

    sock.on('close', () => {
      if (!isCurrent()) return
      ws = null
      connecting = false
      setTimeout(connect, 3000)
    })

    sock.on('error', () => {
      if (!isCurrent()) return
      ws = null
      connecting = false
      // Usually 'error' is followed by 'close' with reconnect, but this is not
      // guaranteed — safeguard with our own timer (safe: connect
      // is idempotent via connecting flag).
      setTimeout(connect, 3000)
    })
  } catch {
    ws = null
    connecting = false
    setTimeout(connect, 5000)
  }
}

/**
 * Handling of a single ComfyUI WS message (body of ws.on('message')).
 * Extracted as export (fix 255) for smoke-testing stage math
 * without a live connection.
 */
export function applyTrackerMessage(msg: {
  type?: string
  data?: Record<string, unknown> & { prompt_id?: string; node?: string | null }
}) {
  try {
    // Queue drained → background unload of MiniMax models from VRAM
    // (vram-arbiter: GPU released immediately after generation finishes)
    if (msg.type === 'status') {
      const remaining = (msg.data as { status?: { exec_info?: { queue_remaining?: number } } } | undefined)
        ?.status?.exec_info?.queue_remaining
      if (typeof remaining === 'number') {
        if (remaining === 0 && lastQueueRemaining > 0) {
          // (fix 716) .catch is required: onQueueDrained internally waits
          // for VRAM arbiter mutex, which can be locked longer than
          // timeout — without handler this is an unhandled rejection, and Node
          // terminates process on unhandled rejection by default.
          void onQueueDrained().catch((err) => {
            console.warn('[progress-tracker] onQueueDrained failed:', err instanceof Error ? err.message : String(err))
          })
        }
        lastQueueRemaining = remaining
      }
    }

    // Standard progress events (one per sampler node/pass)
    if (msg.type === 'progress' && msg.data?.prompt_id) {
      const pid = msg.data.prompt_id
      const node = typeof msg.data.node === 'string' ? msg.data.node : 'sampler'
      let entry = progressMap.get(pid)
      if (!entry) {
        entry = newEntry()
        progressMap.set(pid, entry)
      }
      if (!entry.byNode[node]) {
        entry.byNode[node] = { value: 0, max: 1 }
      }
      entry.byNode[node].value = (msg.data.value as number) || 0
      entry.byNode[node].max = (msg.data.max as number) || 1
      if (!entry.nodes.includes(node)) {
        entry.nodes.push(node)
      }
      // Fix 50: sticky stage — pass-2 evidence never reverts to pass 1
      if (STAGE2_NODES.has(node)) entry.stage2Seen = true
      // (order fix) stage in ORDER OF OBSERVATION of samplers
      const obsIdx = obsStageOf(entry, node)
      if (obsIdx !== null) {
        entry.maxStage = Math.max(entry.maxStage, obsIdx)
        entry.lastStageEvidence = node
      }
    }

    // Standard preview events (from KSampler etc.)
    if (msg.type === 'preview' && msg.data?.prompt_id && msg.data.image) {
      previewMap.set(msg.data.prompt_id, {
        image: msg.data.image as string,
        mime: `image/${(msg.data.image_type as string) || 'png'}`,
        width: (msg.data.width as number) || 0,
        height: (msg.data.height as number) || 0,
        step: 0,
        total: 0,
        timestamp: Date.now(),
      })
      trimPreviewMap()
    }

    // KJNodes ModelPreviewOverride events (custom type)
    if (msg.type === 'kj_preview_override' && (msg.data as { image?: string } | undefined)?.image) {
      const d = msg.data as {
        image: string; mime?: string; w?: number; h?: number
        step?: number; total?: number; node_id?: string
      }
      // Use the currently-executing prompt (most accurate for queue scenarios)
      const pid = executingPromptId || activePromptId || d.node_id || 'unknown'
      const kjNodeForStage = typeof d.node_id === 'string' ? d.node_id : ''
      previewMap.set(pid, {
        image: d.image,
        mime: d.mime || 'image/jpeg',
        width: d.w || 0,
        height: d.h || 0,
        step: d.step || 0,
        total: d.total || 0,
        timestamp: Date.now(),
        // (fix 198) pass of THIS frame (non-sticky, from event node_id)
        stage: STAGE2_NODES.has(kjNodeForStage) ? 2 : 1,
      })
      // Also update progress from step/total
      if ((d.total || 0) > 0) {
        let entry = progressMap.get(pid)
        if (!entry) {
          entry = newEntry()
          progressMap.set(pid, entry)
        }
        // (fix 479) Tile-upscale: each KJ event = 1 step of 1 tile-chunk.
        // Count ALL events monotonically — this is honest 0→100 progress.
        // (fix 487) Boundary-0 event (step=0 — noise seed BEFORE
        // first step, sent at start of each sampling) is NOT a step:
        // count only step>=1, otherwise each tile added an extra unit
        // and progress bar drifted ahead ("tiles already processing"
        // while model was still initializing).
        if (entry.tileTotalUnits !== null && entry.tileStepsPerUnit !== null) {
          if ((d.step || 0) >= 1) entry.tileKjCount++
        }
        const node = 'preview'
        if (!entry.byNode[node]) entry.byNode[node] = { value: 0, max: 1 }
        entry.byNode[node].value = d.step || 0
        entry.byNode[node].max = d.total as number
        if (!entry.nodes.includes(node)) entry.nodes.push(node)
        // Fix 50: the KJ event knows its own node_id ('12' pass 1 /
        // '13' pass 2) — tag the shared pseudo-node with that pass and
        // latch the sticky stage from real pass-2 evidence.
        const kjNode = kjNodeForStage
        // (fix 255 + order fix) pseudo-node 'preview' reflects stage of
        // EXECUTING sampler in ORDER OF OBSERVATION (KJ wrapper is shared
        // across all clips/windows — its node_id does not distinguish stages).
        const obsIdx = obsStageOf(entry, entry.executingNode)
        if (obsIdx !== null) {
          entry.previewStage = obsIdx
          entry.maxStage = Math.max(entry.maxStage, obsIdx)
        } else {
          // (fix 716) Units normalized to 0-BASED stage index — as in
          // branch above. Previously 1-BASED pass number (1|2) was written here,
          // while previewStage field was also used in dynamic path as
          // 0-based index (comparison `idx !== cur`, where cur is 0-based).
          // Due to mixing units, KJ preview share was attributed to WRONG stage
          // (off-by-one) — progress bar jumped.
          entry.previewStage = STAGE2_NODES.has(kjNode) ? 1 : 0
        }
        if (STAGE2_NODES.has(kjNode)) entry.stage2Seen = true
      }
      trimPreviewMap()
    }

    // Execution events
    if (msg.type === 'executing' && msg.data?.prompt_id) {
      // Real execution window: first node start → finished marker
      const pid = msg.data.prompt_id
      if (typeof msg.data.node === 'string') {
        let w = execWindows.get(pid)
        if (!w) {
          w = { start: Date.now(), end: null }
          execWindows.set(pid, w)
        }
        if (execWindows.size > 100) {
          const keys = Array.from(execWindows.keys())
          for (let i = 0; i < keys.length - 100; i++) execWindows.delete(keys[i])
        }
      } else if (msg.data.node === null) {
        const w = execWindows.get(pid)
        if (w && w.end === null) w.end = Date.now()
      }

      if (msg.data.node === null) {
        const entry = progressMap.get(msg.data.prompt_id)
        if (entry) entry.done = true
        // Clear preview when done
        previewMap.delete(msg.data.prompt_id)
        // Clear executing prompt if it was this one
        if (executingPromptId === msg.data.prompt_id) {
          executingPromptId = null
        }
        // (fix 716) Also reset activePromptId: it was NEVER cleared,
        // and late KJ events after job completion were attributed to
        // PREVIOUS prompt (pid = executingPromptId || activePromptId) —
        // in gallery "phantom" preview appeared on already finished video.
        if (activePromptId === msg.data.prompt_id) {
          activePromptId = null
        }
      } else if (typeof msg.data.node === 'string') {
        let entry = progressMap.get(msg.data.prompt_id)
        if (!entry) {
          entry = newEntry()
          progressMap.set(msg.data.prompt_id, entry)
        }
        // (fix 255) remember executing node — pseudo-node 'preview'
        // takes stage from it (preview wrapper is shared)
        entry.executingNode = msg.data.node
        if (STAGE2_NODES.has(msg.data.node)) entry.stage2Seen = true
        const obsIdx = obsStageOf(entry, msg.data.node)
        if (obsIdx !== null) {
          entry.maxStage = Math.max(entry.maxStage, obsIdx)
          entry.lastStageEvidence = msg.data.node
        }
        // Track which prompt is currently executing
        executingPromptId = msg.data.prompt_id
      }
    }

    // Error events
    if (msg.type === 'execution_error' && msg.data?.prompt_id) {
      progressMap.delete(msg.data.prompt_id)
      previewMap.delete(msg.data.prompt_id)
    }

    // Cleanup progress: keep max 100 entries
    if (progressMap.size > 100) {
      const keys = Array.from(progressMap.keys())
      for (let i = 0; i < keys.length - 100; i++) {
        progressMap.delete(keys[i])
      }
    }
  } catch { /* ignore parse errors */ }
}

function trimPreviewMap() {
  if (previewMap.size > 10) {
    const keys = Array.from(previewMap.keys())
    previewMap.delete(keys[0])
  }
}

/* ─── Fixed two-stage progress (workflow is known: Pass 1 low-res, Pass 2 high-res) ───
 *
 * Dividing by the number of OBSERVED progress nodes makes the bar bounce:
 * while only pass-1 nodes exist the divisor is 1 (bar hits 100%), then the
 * pass-2 node appears and the divisor becomes 2 (bar drops to 50%). Instead,
 * the workflow always has exactly TWO stages, and every progress-emitting
 * node id is mapped to its stage up front. */
const TOTAL_STAGES = 2

/** Pass 1: SamplerCustomAdvanced '46:21', KJ preview override '12';
 *  (fix 194) extend mode: KJ preview 'extpv' (Extender pass 1). */
const STAGE1_NODES = new Set(['46:21', '12', 'extpv'])
/** Pass 2: SamplerCustomAdvanced '46:16', KJ preview override '13';
 *  (fix 194) extend mode: KJ preview 'extpv2' (MiniMaxH3ExtenderPass2). */
const STAGE2_NODES = new Set(['46:16', '13', 'extpv2'])
/** Pseudo-node carrying KJ preview step/total for whichever pass is active. */
const PREVIEW_PSEUDO = 'preview'

function stageOf(node: string): 1 | 2 | null {
  if (STAGE2_NODES.has(node)) return 2
  if (STAGE1_NODES.has(node)) return 1
  return null
}

/**
 * (fix 255) Node stage according to dynamic specs (0-based
 * index); null — specs not registered or node is outside lists.
 */
function dynStageOf(entry: ProgressEntry, node: string | null): number | null {
  if (!entry.nodeStage || !node) return null
  const idx = entry.nodeStage[node]
  return typeof idx === 'number' ? idx : null
}

/**
 * (order fix) SEQUENTIAL sample index by first event (0-based).
 * ComfyUI executes independent refine windows out of node order
 * (cs_0 → cs_2 → cs_1): "Chunk X/N" and percentage must advance monotonically,
 * so stage = how many samplers have already started, not whose node it is.
 * Calling with a new sampler appends it to the end of observation order.
 */
function obsStageOf(entry: ProgressEntry, node: string | null): number | null {
  if (dynStageOf(entry, node) === null) return null
  const n = node as string
  let i = entry.stageObserved.indexOf(n)
  if (i === -1) {
    entry.stageObserved.push(n)
    i = entry.stageObserved.length - 1
  }
  return i
}

/**
 * Current stage of dynamic model (0-based, in order of observation).
 *
 * Based on LAST sampler event (lastStageEvidence): progress of running
 * sampler flows continuously, so a single "runaway" event of another sampler
 * (executing/KJ-preview on node switch) is discarded by the very first event
 * of the actual one. If samplers haven't appeared in events yet (or finished) —
 * sticky-maximum of observed orders: workflow never goes backward.
 */
function curDynStage(entry: ProgressEntry): number {
  const n = entry.stageSpecs?.length ?? 1
  const evidenceIdx = obsStageOf(entry, entry.lastStageEvidence)
  const cur = evidenceIdx !== null ? evidenceIdx : entry.maxStage
  return Math.min(Math.max(cur, 0), n - 1)
}

/** Stage of a node; the shared 'preview' pseudo-node follows the pass that
 *  last wrote it (fix 50), so its step/total never leaks into the wrong
 *  stage fraction. */
function stageOfTracked(entry: ProgressEntry, node: string): 1 | 2 | null {
  // Legacy branch: previewStage is stored as 0-BASED stage index (0 = pass
  // 1, 1 = pass 2) — just like in dynamic path (fix 716). Here
  // we translate to 1|2 (pass number) for legacy scale.
  if (node === PREVIEW_PSEUDO) return entry.previewStage >= 1 ? 2 : 1
  return stageOf(node)
}

/**
 * The stage currently executing. STICKY (fix 50): once pass 2 has any
 * evidence it stays 2 — the workflow never goes back from pass 2 to pass 1.
 */
function currentStage(entry: ProgressEntry): 1 | 2 {
  return entry.stage2Seen ? 2 : 1
}

/** Clamp helper. */
function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x))
}

/** Lazy-init: start the WebSocket connection on first access. */
let initialized = false
function ensureConnected() {
  if (!initialized) {
    initialized = true
    connect()
  }
}

/**
 * Compute the overall progress fraction (0..1) across ALL sampling stages.
 *
 * (fix 255) If stageSpecs registered on submit — progress is fairly
 * divided across N stages (draft/extend clips/refine windows define scale length):
 *   overall = (stageIdx + stageFraction) / N
 * Legacy mode (unregistered) — previous "exactly 2 passes" model:
 *   overall = ((stage − 1) + stageFraction) / 2
 * In both cases progress traverses 0→100 exactly once, monotonically.
 * Returns null if the prompt is unknown.
 */
export function getOverallProgress(promptId: string): number | null {
  ensureConnected()
  const entry = progressMap.get(promptId)
  if (!entry || entry.nodes.length === 0) return null
  if (entry.done) return 1

  // (fix 479) Tile-upscale: monotonic progress from KJ events counter.
  // Each KJ preview = 1 step of 1 tile-chunk. Total steps count =
  // totalUnits × stepsPerUnit. Bar traverses 0→100 exactly once.
  if (entry.tileTotalUnits !== null && entry.tileStepsPerUnit !== null && entry.tileTotalUnits > 0) {
    const totalSteps = entry.tileTotalUnits * entry.tileStepsPerUnit
    return clamp01(entry.tileKjCount / totalSteps)
  }

  if (entry.stageSpecs && entry.stageSpecs.length > 0) {
    const n = entry.stageSpecs.length
    const cur = curDynStage(entry)
    let stageFrac = 0
    for (const node of entry.nodes) {
      // Pseudo-node 'preview' gets stage from previewStage (by executing
      // sampler at moment of KJ event); actual samplers — in order of observation.
      const idx = node === PREVIEW_PSEUDO ? entry.previewStage : obsStageOf(entry, node)
      if (idx === null || idx !== cur) continue
      const np = entry.byNode[node]
      if (np && np.max > 0) {
        stageFrac = Math.max(stageFrac, clamp01((np.value || 0) / np.max))
      }
    }
    return clamp01((cur + stageFrac) / n)
  }

  const stage = currentStage(entry)
  // Best fraction within the current stage (several nodes may report —
  // e.g. the sampler and the KJ preview override; take the furthest one).
  let stageFrac = 0
  for (const n of entry.nodes) {
    if (stageOfTracked(entry, n) !== stage) continue
    const np = entry.byNode[n]
    if (np && np.max > 0) {
      stageFrac = Math.max(stageFrac, clamp01((np.value || 0) / np.max))
    }
  }
  return clamp01(((stage - 1) + stageFrac) / TOTAL_STAGES)
}

/**
 * Stage readout for the live-preview overlay: which stage is running
 * (1-based) out of how many, and its step/total (the largest reporting
 * node of that stage).
 */
export interface TileStageInfo {
  stage: number
  totalStages: number
  step: number
  total: number
  /** (fix 479) Tile info for UI: "Tile X/Y" + current tile/chunk. */
  tileInfo?: {
    totalTiles: number
    currentTile: number
    totalUnits: number
    currentUnit: number
    stepsPerUnit: number
  }
  /**
   * (fix 487) Sampling hasn't started yet: preparation / dynamic
   * loading of model into VRAM underway ("Model Initialization" logs, SLA, etc.).
   * UI displays "Preparing model..." instead of false "Tile 1/N · step 1/2".
   */
  preparing?: boolean
}

export function getStageInfo(
  promptId: string,
): TileStageInfo | null {
  ensureConnected()
  const entry = progressMap.get(promptId)
  if (!entry) return null

  // (fix 479) Tile-upscale: "Tile X/Y" by KJ event counter.
  // Tiles proceed in row-major order: tile 1 (chunk 1..N), tile 2 (chunk 1..N), …
  // currentTile = floor((unit-1) / totalChunks) + 1
  if (entry.tileTotalUnits !== null && entry.tileStepsPerUnit !== null && entry.tileTotalUnits > 0) {
    const completedUnits = Math.floor(entry.tileKjCount / entry.tileStepsPerUnit)
    const currentUnit = Math.min(completedUnits + 1, entry.tileTotalUnits)
    const stepInUnit = (entry.tileKjCount % entry.tileStepsPerUnit) + 1
    // Current tile (1-based): tiles proceed in row-major order, each tile
    // has totalChunks temporal chunks.
    const totalChunks = entry.tileTotalChunks ?? 1
    const totalTiles = entry.tileTotalTiles ?? entry.tileTotalUnits
    const currentTile = Math.min(
      Math.floor((currentUnit - 1) / totalChunks) + 1,
      totalTiles,
    )
    return {
      stage: currentTile,
      totalStages: totalTiles,
      step: stepInUnit,
      total: entry.tileStepsPerUnit,
      // (fix 487) While no actual steps completed — model is preparing
      // (initialization, dynamic weight loading): don't mislead
      // user with "Tile 1/N" label.
      preparing: entry.tileKjCount === 0,
      tileInfo: {
        totalTiles,
        currentTile,
        totalUnits: entry.tileTotalUnits,
        currentUnit,
        stepsPerUnit: entry.tileStepsPerUnit,
      },
    }
  }

  if (entry.stageSpecs && entry.stageSpecs.length > 0) {
    const n = entry.stageSpecs.length
    const cur = curDynStage(entry)
    let step = 0
    let total = 0
    for (const node of entry.nodes) {
      // Pseudo-node 'preview' — stage from previewStage; actual — order
      // of observation (see getOverallProgress).
      const idx = node === PREVIEW_PSEUDO ? entry.previewStage : obsStageOf(entry, node)
      if (idx === null || idx !== cur) continue
      const np = entry.byNode[node]
      if (np && np.max > total) {
        total = np.max
        step = Math.min(np.value || 0, np.max)
      }
    }
    return { stage: cur + 1, totalStages: n, step, total }
  }

  const stage = currentStage(entry)
  let step = 0
  let total = 0
  for (const n of entry.nodes) {
    if (stageOfTracked(entry, n) !== stage) continue
    const np = entry.byNode[n]
    if (np && np.max > total) {
      total = np.max
      step = Math.min(np.value || 0, np.max)
    }
  }
  return { stage, totalStages: TOTAL_STAGES, step, total }
}

/** Get progress for a prompt_id. Returns null if unknown. */
export function getProgress(promptId: string): ProgressEntry | null {
  ensureConnected()
  return progressMap.get(promptId) ?? null
}

/** Get the latest preview image for a prompt_id. Returns null if none. */
export function getPreview(promptId: string): PreviewEntry | null {
  ensureConnected()
  return previewMap.get(promptId) ?? null
}
