/**
 * (fix 136 / Bonsai) Protocol adapter for Ternary Bonsai 2 27B.
 *
 * The Bonsai backend is a prism llama-server with an OpenAI-compatible API
 * (/v1/chat/completions, stream:true), while the rest of the studio uses
 * the tools/llm_server.py protocol:
 *   request:  messages with media parts {type:'image', image:'/abs/path.jpg'}
 *   response: SSE `data: {"delta":"..."}\n\n` (+ {"done":true} at the end)
 *
 * This module bridges both directions:
 *  • toOpenAiMessages() — internal messages → OpenAI (images are read
 *    from disk and sent as data:image/...;base64 URIs);
 *  • openAiSseToDelta() — OpenAI SSE → our SSE format so that the FRONTEND
 *    (assistant-stream.ts) remains completely unchanged. reasoning_content (if
 *    it appears despite --reasoning-budget 0) is discarded.
 *
 * VIDEO: the llama-server fork does not accept full videos (our python server
 * supports this via the mtmd patch) — on the Bonsai backend, video frames are extracted
 * via ffmpeg into individual JPEGs and sent as image_url (fix 162).
 */
import { readFileSync } from 'fs'

/* ──────────────────── Request: messages → OpenAI ──────────────────── */

interface InternalPart {
  type?: string
  text?: string
  image?: string
  video?: string
  /** (fix 162) Array of paths to JPEG frames extracted from video. */
  video_frames?: string[]
}

export interface InternalMessage {
  role: string
  /** As in the entire chat route: string OR array of parts (weak typing —
   * narrow by type field during traversal, as estimateMessageTokens does). */
  content: string | unknown[]
}

export type OpenAiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface OpenAiMessage {
  role: string
  content: string | Array<OpenAiContentPart>
}

function imageToDataUri(absPath: string): string | null {
  try {
    const buf = readFileSync(absPath)
    const mime = /\.png$/i.test(absPath) ? 'image/png' : 'image/jpeg'
    return `data:${mime};base64,${buf.toString('base64')}`
  } catch {
    return null
  }
}

/**
 * Converts internal messages to OpenAI format. Each {type:'image'}
 * part is read from disk and becomes an image_url data-URI; {type:'video'}
 * is replaced with a text note (the model should not describe what it
 * cannot see). Text parts pass through as-is, in original order.
 */
export async function toOpenAiMessages(
  messages: Array<InternalMessage>,
): Promise<OpenAiMessage[]> {
  const out: OpenAiMessage[] = []
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content })
      continue
    }
    if (!Array.isArray(m.content)) {
      out.push({ role: m.role, content: '' })
      continue
    }
    const parts: OpenAiContentPart[] = []
    for (const raw of m.content as unknown[]) {
      const p = raw as InternalPart
      if (p && p.type === 'text' && typeof p.text === 'string') {
        parts.push({ type: 'text', text: p.text })
      } else if (p && p.type === 'image' && typeof p.image === 'string') {
        const uri = imageToDataUri(p.image)
        if (uri) {
          parts.push({ type: 'image_url', image_url: { url: uri } })
        } else {
          parts.push({
            type: 'text',
            text: '(an image reference could not be attached — do NOT describe or invent its content)',
          })
        }
      } else if (p && p.type === 'video') {
        // (fix 162) Video frames extracted by ffmpeg — send as images.
        if (Array.isArray(p.video_frames) && p.video_frames.length > 0) {
          for (const framePath of p.video_frames) {
            const uri = imageToDataUri(framePath)
            if (uri) {
              parts.push({ type: 'image_url', image_url: { url: uri } })
            }
          }
          if (parts.length === 0 || parts[parts.length - 1].type !== 'image_url') {
            parts.push({
              type: 'text',
              text: '(video frames could not be attached — do NOT describe or invent its content)',
            })
          }
        } else {
          // Frames not extracted — honest note.
          parts.push({
            type: 'text',
            text: '(a video reference exists, but its frames are NOT attached to this assistant — reference it as a tag only and do NOT describe, guess or invent its content)',
          })
        }
      }
    }
    out.push({
      role: m.role,
      content: parts.length === 1 && parts[0].type === 'text'
        ? (parts[0] as { type: 'text'; text: string }).text
        : parts,
    })
  }
  return out
}

/* ──────────────────── Response: OpenAI SSE → our SSE ──────────────────── */

/**
 * Wraps the OpenAI stream body (data: {"choices":[{"delta":{"content"}}]}
 * ... data: [DONE]) into our format (data: {"delta":"..."} / {"done":true}).
 * The assistant-stream.ts frontend remains untouched.
 */
export function openAiSseToDelta(
  body: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buf = ''
  let sentDone = false

  // JSON.stringify escapes newlines inside strings automatically —
  // SSE framing (delimiter \n\n) is not broken.
  const emit = (
    controller: TransformStreamDefaultController<Uint8Array>,
    obj: Record<string, unknown>,
  ) => {
    if (sentDone && obj.done) return // single done per stream: [DONE] OR flush
    if (obj.done) sentDone = true
    controller.enqueue(
      encoder.encode(`data: ${JSON.stringify(obj)}\n\n`),
    )
  }

  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buf += decoder.decode(chunk, { stream: true })
        const events = buf.split('\n\n')
        buf = events.pop() ?? ''
        for (const ev of events) {
          for (const line of ev.split('\n')) {
            if (!line.startsWith('data: ')) continue
            const payload = line.slice(6)
            if (payload === '[DONE]') {
              emit(controller, { done: true })
              continue
            }
            let parsed: {
              choices?: Array<{ delta?: { content?: string; reasoning_content?: string } }>
              error?: { message?: string } | string
            }
            try {
              parsed = JSON.parse(payload)
            } catch {
              continue // corrupted/partial chunk — wait for next
            }
            if (parsed.error) {
              const msg = typeof parsed.error === 'string'
                ? parsed.error
                : parsed.error.message || 'LLM error'
              emit(controller, { error: msg, done: true })
              continue
            }
            const delta = parsed.choices?.[0]?.delta
            // reasoning_content is discarded: with --reasoning-budget 0 it
            // should not exist, but the fork might send empty chunks.
            if (typeof delta?.content === 'string' && delta.content.length > 0) {
              emit(controller, { delta: delta.content })
            }
          }
        }
      },
      flush(controller) {
        // Stream terminated without [DONE] — close our protocol cleanly.
        emit(controller, { done: true })
      },
    }),
  )
}
