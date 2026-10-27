/**
 * assistant-chats-sync — sync assistant chats with project file.
 *
 * Sources (priority):
 *   1. Server (data/assistant-chats.json) — portable storage
 *   2. Browser localStorage — cache / fallback if server is unreachable
 *
 * On every store change — debounced write to server.
 * On startup — load from server, if data exists — rewrite store.
 */
import { useAssistantChats, type AssistantChat } from './assistant-chats-store'

let initialized = false
let saveTimer: ReturnType<typeof setTimeout> | null = null
let prevChats: AssistantChat[] = []
/** (fix 108) true while sync PUT is in flight — flush does not duplicate it. */
let saving = false
/** Flush arrived while PUT was in flight — rerun save upon completion. */
let pendingFlush = false
/** true after first load from server or first store change:
 *  only then is it permissible to send an EMPTY list (otherwise closing the tab
 *  before loadFromServer completion would overwrite server chats with an empty array). */
let storeTouched = false
const SAVE_DEBOUNCE_MS = 1500

/** (fix 108) Capture chats state to pass into request body.
 *  Empty list is a VALID state (user deleted all chats):
 *  we return it as is, otherwise flush on tab close sent nothing
 *  and deleted chats "resurrected" from the server file on the next
 *  launch. null — only if store is not loaded yet or unavailable. */
function capturePayload(): string | null {
  try {
    const { chats, activeChatId } = useAssistantChats.getState()
    if (!Array.isArray(chats)) return null
    if (chats.length === 0 && !storeTouched) return null
    return JSON.stringify({ chats, activeChatId })
  } catch {
    return null
  }
}

/** (fix 337) Single beacon dispatch point: verify return value of sendBeacon.
 *  false (browser queue full / API rejected) — data remains in
 *  store's localStorage cache, and the retry flag guarantees a repeat PUT on
 *  the next visit (see initAssistantChatsSync). */
function tryBeacon(payload: string): boolean {
  try {
    if (navigator.sendBeacon) {
      return navigator.sendBeacon('/api/assistant/chats', new Blob([payload], { type: 'application/json' }))
    }
  } catch { /* beacon unavailable */ }
  return false
}

function markRetryNeeded() {
  try { localStorage.setItem('assistantChatsSyncRetry', '1') } catch { /* private mode */ }
}

function takeRetryNeeded(): boolean {
  try {
    if (localStorage.getItem('assistantChatsSyncRetry') === '1') {
      localStorage.removeItem('assistantChatsSyncRetry')
      return true
    }
  } catch { /* private mode */ }
  return false
}

/** (fixes 108, 337) Synchronous flush: completes pending debounce tick and,
 *  if PUT is not yet in flight, sends it with keepalive — will survive until
 *  delivery even when closing the tab. sendBeacon — fallback if fetch is
 *  unavailable/rejected (some browsers do not support beacon with JSON body).
 *  (fix 337) keepalive PUT goes through the shared saveToServer mutex —
 *  two concurrent PUTs with different snapshots are impossible, an older snapshot
 *  cannot land on top of a fresh one. */
function flushSave() {
  if (typeof window === 'undefined') return
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  if (saving) {
    // PUT is already in flight — do not duplicate, but mark: changes made
    // AFTER capturing its body must be saved again upon completion,
    // otherwise they are silently lost (debounce timer is already cleared).
    // The retry will also go with keepalive (see saveToServer finally).
    pendingFlush = true
    return
  }
  const payload = capturePayload()
  if (!payload) return
  // (fix 109) keepalive-fetch is limited to ~64 KB body: when exceeded, fetch
  // is rejected ASYNCHRONOUSLY, while done is already set to true synchronously — beacon
  // fallback did not trigger and large chats were lost on tab close.
  // PUT /api/assistant/chats accepts only a full snapshot, so for
  // large bodies we use sendBeacon immediately with full payload (skipping keepalive branch).
  // (fix 587) The limit is ~64KB BYTES, whereas payload.length counts UTF-16 code units:
  // non-ASCII chars (~2 bytes/char) passed the check, but dropped both transports.
  if (new Blob([payload]).size > 60_000) {
    if (!tryBeacon(payload)) markRetryNeeded()
    return
  }
  void saveToServer(payload, true)
}

/**
 * Initializes synchronization. Called once on app mount.
 * 1. Loads chats from server (if any) → into store.
 * 2. Subscribes to store changes → debounced save to server.
 */
export function initAssistantChatsSync() {
  if (initialized) return
  initialized = true

  // 1. Load from server
  // (fix 337) If the previous beacon-PUT failed to send (sendBeacon returned false),
  // after load/merge we retry saving the local copy.
  void loadFromServer().finally(() => {
    if (takeRetryNeeded()) void saveToServer()
  })

  // 2. Subscribe to changes → debounced save
  prevChats = useAssistantChats.getState().chats

  useAssistantChats.subscribe((state) => {
    // Only save if chats actually changed (not just activeChatId)
    if (state.chats === prevChats) return
    prevChats = state.chats
    storeTouched = true

    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      void saveToServer()
    }, SAVE_DEBOUNCE_MS)
  })

  // (fix 108) Sync stability: on tab close/hide,
  // pending debounce tick (1.5 s) used to be lost — chat disappeared from disk.
  // Now flush with keepalive (survives until delivery) + sendBeacon fallback.
  window.addEventListener('pagehide', flushSave)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushSave()
  })
}

/**
 * (fix 74) Reload chats from project file (data/assistant-chats.json).
 * Called after migrating chats from an older version of the program.
 */
export async function reloadAssistantChats(): Promise<void> {
  await loadFromServer()
}

async function loadFromServer() {
  try {
    const res = await fetch('/api/assistant/chats')
    if (!res.ok) return
    const data = await res.json()
    if (!data.found || !Array.isArray(data.chats) || data.chats.length === 0) {
      // Server has no data — keep whatever is in localStorage
      return
    }
    // Merge: per-chat by updatedAt. Previously server copy overwrote local copy
    // ALWAYS — if previous PUT was lost (crash before debounce/flush), messages
    // from the lost window disappeared on the next launch. Now the fresher copy
    // wins; chats that are local-only and server-only are included as is.
    const store = useAssistantChats.getState()
    storeTouched = true
    const localById = new Map(store.chats.map((c) => [c.id, c]))
    const merged = data.chats.map((c: AssistantChat) => {
      const local = localById.get(c.id)
      if (!local) return c
      // no updatedAt (old entries) — consider server copy up-to-date
      if (typeof local.updatedAt !== 'number' || typeof c.updatedAt !== 'number') return c
      return local.updatedAt > c.updatedAt ? local : c
    })
    const serverIds = new Set(merged.map((c: AssistantChat) => c.id))
    const localOnly = store.chats.filter((c) => !serverIds.has(c.id))
    merged.push(...localOnly)
    // (fix 427) Old server chats without mode — these are "Generate" chats
    // (extend mode did not exist); normalize like store merge-guard.
    // (fix 502) Whitelist of three modes ('controlnet' added).
    const normalized = merged.map((c: AssistantChat) => ({
      ...c,
      mode: (c.mode === 'extend' || c.mode === 'controlnet' ? c.mode : 'generate') as AssistantChat['mode'],
    }))
    const activeChatId =
      typeof data.activeChatId === 'string' && normalized.some((c) => c.id === data.activeChatId)
        ? data.activeChatId
        : (normalized[0]?.id ?? null)

    // Update store without triggering save loop
    useAssistantChats.setState({ chats: normalized, activeChatId })
    prevChats = normalized

    // Immediately persist to server (in case localStorage had more)
    void saveToServer()
  } catch {
    // Server unavailable — silently fall back to localStorage
  }
}

async function saveToServer(payload?: string, keepalive = false) {
  // (fixes 108, 337) saving=true — single mutex for ALL PUTs (debounce
  // save and keepalive-flush): parallel PUTs cannot occur, and an earlier
  // snapshot will not land after a later one.
  if (saving) {
    pendingFlush = true
    return
  }
  saving = true
  let body = payload ?? ''
  try {
    if (!body) {
      const { chats, activeChatId } = useAssistantChats.getState()
      body = JSON.stringify({ chats, activeChatId })
    }
    const res = await fetch('/api/assistant/chats', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive,
    })
    if (!res.ok) {
      // Non-critical: log but don't crash
      console.warn('[assistant-chats-sync] save failed:', res.status)
    }
  } catch (err) {
    // Server unavailable — data stays in localStorage cache
    console.warn('[assistant-chats-sync] save error:', err)
    // (fix 337) keepalive-fetch rejected (tab closing) — beacon fallback.
    if (keepalive && typeof window !== 'undefined') {
      if (!tryBeacon(body)) markRetryNeeded()
    }
  } finally {
    saving = false
    if (pendingFlush) {
      pendingFlush = false
      // (fix 337) Retry on pendingFlush — also with keepalive: flush most
      // often arrives on pagehide, normal fetch on tab close will die.
      void saveToServer(undefined, true)
    }
  }
}
