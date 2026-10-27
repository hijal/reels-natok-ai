import { NextResponse } from 'next/server'
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs'
import { join } from 'path'

/**
 * GET  /api/assistant/chats — load chats from project file.
 * PUT  /api/assistant/chats — save chats to project file.
 *
 * File: <project>/data/assistant-chats.json
 * Format: { chats: AssistantChat[], activeChatId: string | null }
 *
 * This allows transferring chats between program versions
 * (the file is stored in project folder, not in browser localStorage).
 */
export const dynamic = 'force-dynamic'

const DATA_DIR = join(process.cwd(), 'data')
const CHATS_FILE = join(DATA_DIR, 'assistant-chats.json')

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

interface Chat {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  /** (fix 427) Chat mode ('generate' | 'extend' | 'controlnet' (fix 502));
   *  optional — old records without it are treated by client as 'generate'.
   *  Extra fields beyond validation are preserved as-is (JSON round-trip). */
  mode?: 'generate' | 'extend' | 'controlnet'
  messages: ChatMessage[]
}

interface ChatsPayload {
  chats: Chat[]
  activeChatId: string | null
}

function readChats(): ChatsPayload | null {
  try {
    if (!existsSync(CHATS_FILE)) return null
    const raw = readFileSync(CHATS_FILE, 'utf-8')
    const data = JSON.parse(raw)
    if (!data || !Array.isArray(data.chats)) return null
    // Validate each chat
    const valid = data.chats.filter(
      (c: unknown): c is Chat =>
        !!c &&
        typeof c === 'object' &&
        typeof (c as Chat).id === 'string' &&
        Array.isArray((c as Chat).messages) &&
        (c as Chat).messages.every(
          (m: unknown) =>
            !!m &&
            ((m as ChatMessage).role === 'user' || (m as ChatMessage).role === 'assistant'),
        ),
    )
    return {
      chats: valid,
      activeChatId: typeof data.activeChatId === 'string' ? data.activeChatId : (valid[0]?.id ?? null),
    }
  } catch {
    return null
  }
}

function writeChats(payload: ChatsPayload): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
  const safe = {
    chats: payload.chats,
    activeChatId: payload.activeChatId ?? null,
  }
  // Atomic write (tmp + rename): on crash/disk full/race
  // PUT+POST direct writeFileSync could leave truncated JSON — and then
  // ALL server chats were lost (readChats would fail parsing).
  const tmp = CHATS_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(safe, null, 2), 'utf-8')
  renameSync(tmp, CHATS_FILE)
}

/* ─── GET ─── */
export async function GET() {
  const data = readChats()
  if (!data) {
    return NextResponse.json({ chats: [], activeChatId: null, found: false })
  }
  return NextResponse.json({ ...data, found: true })
}

/* ─── PUT ─── */
export async function PUT(request: Request) {
  try {
    // (fix 716) Body limit and chat count limit. Previously payload was unlimited:
    // the whole array was serialized and written synchronously (writeFileSync) in
    // the request handler — a single request could block the process for a long time.
    const MAX_BODY_BYTES = 32 * 1024 * 1024
    const MAX_CHATS = 500
    const declared = Number(request.headers.get('content-length') || 0)
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return NextResponse.json({ error: 'Payload too large' }, { status: 413 })
    }
    const body = await request.json()
    if (!body || !Array.isArray(body.chats)) {
      return NextResponse.json({ error: 'Invalid payload' }, { status: 400 })
    }
    if (body.chats.length > MAX_CHATS) {
      return NextResponse.json({ error: `Too many chats (max ${MAX_CHATS})` }, { status: 400 })
    }
    writeChats({
      chats: body.chats,
      activeChatId: typeof body.activeChatId === 'string' ? body.activeChatId : null,
    })
    return NextResponse.json({ ok: true, count: body.chats.length })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

/* ─── POST ─── */
// Alias of PUT: navigator.sendBeacon only supports POST — without this
// handler the chat save fallback on tab close receives 405.
export async function POST(request: Request) {
  return PUT(request)
}
