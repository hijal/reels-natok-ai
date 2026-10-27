/**
 * (fix 331) In-flight dispatch journal: clientToken → prompt_id.
 *
 * Problem: the page is reloaded while POST /api/comfy/generate was in
 * flight — the server might have already queued the prompt in ComfyUI, but the
 * frontend does not know prompt_id → zombie task without tracking. Now frontend
 * generates clientToken and sends it in the POST body; server writes the
 * mapping here after dispatching. After reload, frontend asks
 * GET /api/comfy/inflight?token=… and re-attaches polling.
 *
 * File: data/inflight-generate.json, entries live for 24 hours.
 */
import fs from 'fs'
import path from 'path'

interface InflightEntry {
  prompt_id: string
  ts: number
}

const MAX_AGE_MS = 24 * 60 * 60 * 1000

function journalFile(): string {
  return path.join(process.cwd(), 'data', 'inflight-generate.json')
}

function loadJournal(): Record<string, InflightEntry> {
  const file = journalFile()
  if (!fs.existsSync(file)) return {}
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, InflightEntry>
    if (!parsed || typeof parsed !== 'object') return {}
    const now = Date.now()
    const fresh: Record<string, InflightEntry> = {}
    for (const [token, e] of Object.entries(parsed)) {
      if (e && typeof e.ts === 'number' && now - e.ts < MAX_AGE_MS) fresh[token] = e
    }
    // (fix 716) Save cleaned-up journal IMMEDIATELY: previously expired
    // entries were only discarded in memory, and the file remained with them
    // until the next write.
    if (Object.keys(fresh).length !== Object.keys(parsed).length) {
      try { saveJournal(fresh) } catch { /* non-critical */ }
    }
    return fresh
  } catch {
    return {}
  }
}

function saveJournal(map: Record<string, InflightEntry>) {
  try {
    fs.mkdirSync(path.dirname(journalFile()), { recursive: true })
    fs.writeFileSync(journalFile(), JSON.stringify(map, null, 2), 'utf-8')
  } catch { /* non-critical */ }
}

/** (fix 692) Complete journal reset — factory reset: old clientToken
 *  entries (stale prompts, cancelled tasks) are removed. */
export function clearInflight() {
  try {
    const file = journalFile()
    if (fs.existsSync(file)) fs.unlinkSync(file)
  } catch { /* non-critical */ }
}

/** /api/comfy/generate: task accepted by ComfyUI — remember mapping. */
export function recordInflight(clientToken: string, promptId: string) {
  try {
    const map = loadJournal()
    map[clientToken] = { prompt_id: promptId, ts: Date.now() }
    saveJournal(map)
  } catch { /* non-critical */ }
}

/** GET /api/comfy/inflight: find prompt_id by clientToken (null — not yet
 *  dispatched or entry has expired). */
export function lookupInflight(clientToken: string): string | null {
  try {
    return loadJournal()[clientToken]?.prompt_id ?? null
  } catch {
    return null
  }
}
