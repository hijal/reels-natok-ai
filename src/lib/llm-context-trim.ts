/**
 * Token estimation & context trimming for the assistant chat — (fix 169).
 *
 * Requirements for long chats:
 *   1) system prompt is ALWAYS present (H3 spec, refs, rules) —
 *      it is not considered "history" and does not participate in trimming;
 *   2) trimmed from the START of history ONLY: model always sees what was
 *      discussed at the end (the longest fitting tail);
 *   3) the last message is never touched — references and attachments of current
 *      turn were attached to it by the server;
 *   4) if even [system + last message] doesn't fit — degrade media
 *      (subsample video frames), rather than sending certain overflow.
 *
 * Media lives only on the last user message (refs and chat attachments
 * are attached to the current turn on EVERY request anew), so
 * trimming history from the start cannot "silently lose" attached
 * references — on the next turn they will again be in the tail.
 */

/**
 * Rough token estimate, char-class aware (fix 258).
 *
 * Previous flat estimate of 0.4 tokens/character underestimated Cyrillic text:
 * in Qwen/Bonsai tokenizers Cyrillic costs ~0.5–0.7 tokens per character.
 * In long Cyrillic chats the trimming budget was off by 1.5x — actual tokens
 * exceeded the window, server silently trimmed history (and with it context) — hence
 * "assistant glitches after 4–5 prompts". Cyrillic is counted at 0.65
 * (conservative), other characters (Latin/digits/punctuation) at 0.3.
 */
export function estimateTokens(text: string): number {
  let cyr = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c >= 0x0400 && c <= 0x04ff) cyr++
  }
  return Math.ceil(cyr * 0.65 + (text.length - cyr) * 0.3)
}

/** Chat template wrapper per message (role tags, special tokens). Previously
 *  unaccounted for: ~16 tokens × 60 messages ≈ 1000 "invisible" tokens. */
export const TEMPLATE_TOKENS_PER_MSG = 16

/** Vision tokens per one 512px frame (standard backend — whole video). */
export const FRAME_TOKENS_512 = 768

/** Safety margin for aggregate heuristic estimation error across entire prompt.
 *  (fix 258) raised 192 → 320: estimation is cheaper than window overflow. */
export const TRIM_SAFETY_MARGIN = 320

/** (fix 258) Hard cap on history length regardless of budget:
 *  insurance against chat template surprises on VERY long chats. */
export const MAX_HISTORY_MESSAGES = 60

export interface TrimMessage {
  role: string
  content: string | unknown[]
  images?: string[]
}

/** Estimate tokens for a message content (string or multimodal array). */
export function estimateMessageTokens(content: string | unknown[]): number {
  if (typeof content === 'string') return estimateTokens(content)
  if (Array.isArray(content)) {
    let tokens = 0
    for (const part of content) {
      if (typeof part === 'string') {
        tokens += estimateTokens(part)
      } else if (part && typeof part === 'object') {
        const p = part as Record<string, unknown>
        if (p.type === 'image') {
          // A 512px JPEG ≈ ~256-512 tokens for Gemma vision. Use 384 as midpoint.
          tokens += 384
        } else if (p.type === 'audio') {
          // A 16 kHz WAV clip ≈ 80-150 tokens per second of audio.
          tokens += 256
        } else if (p.type === 'video') {
          if (Array.isArray(p.video_frames)) {
            // (fix 162) Bonsai: 256px frames, up to 48 frames — 384/frame conservatively.
            tokens += (p.video_frames as unknown[]).length * 384
          } else if (typeof p.est_frames === 'number') {
            // (fix 169) standard backend: video duration is bounded
            // by context budget BEFORE attachment (videoBudgetSec) — estimate
            // calculated based on actual frame limit rather than "flat" 15K.
            tokens += (p.est_frames as number) * FRAME_TOKENS_512
          } else {
            tokens += 15_000
          }
        } else if (p.type === 'text' && typeof p.text === 'string') {
          tokens += estimateTokens(p.text)
        }
      }
    }
    return tokens
  }
  return 0
}

/** Full message cost: content + chat template wrapper. */
export function messageTokens(m: { content: string | unknown[] }): number {
  return estimateMessageTokens(m.content) + TEMPLATE_TOKENS_PER_MSG
}

/**
 * (fix 169) Suffix trimming: [system] + longest history tail
 * fitting within budget (ctx − output reserve − safety). Properties:
 *   • system prompt (index 0) is always preserved;
 *   • trimmed only from the start; last message is always preserved —
 *     even if it alone doesn't fit (media), degradeMediaToBudget
 *     handles it next, rather than silent loss of current turn;
 *   • tail is aligned to user message (template expects user after system,
 *     otherwise some templates render "answer without a question");
 *   • if anything was trimmed — trim notice marker is added to the first kept message:
 *     model understands why history starts abruptly.
 */
export function trimToContext(
  messages: TrimMessage[],
  ctxSize: number,
  outputReserve: number,
): TrimMessage[] {
  const budget = ctxSize - outputReserve - TRIM_SAFETY_MARGIN
  // (fix 717) Previously when budget <= 0 (or messages.length <= 2) the function
  // returned messages AS IS — and huge last request was sent to
  // model in its entirety, overflowing the window. Now in degenerate case we trim
  // the TEXT of the last message (media must not be touched — it is re-attached
  // each turn) and honestly report truncation.
  if (budget <= 0) return truncateLastMessageText(messages)
  if (messages.length <= 2) {
    const sysTokens = messageTokens(messages[0])
    if (sysTokens + messageTokens(messages[1] ?? { content: '' }) <= budget) return messages
    return truncateLastMessageText(messages)
  }

  const sys = messages[0]
  // (fix 258) hard cap on history length (safeguard against template
  // surprises on very long chats) — before budget trimming.
  const rest = messages.length - 1 > MAX_HISTORY_MESSAGES
    ? messages.slice(messages.length - MAX_HISTORY_MESSAGES)
    : messages.slice(1)
  const wasCapped = messages.length - 1 > MAX_HISTORY_MESSAGES
  const sysTokens = messageTokens(sys)

  // Suffix sums: suf[i] — aggregate tokens of tail rest[i..].
  const suf = new Array<number>(rest.length + 1).fill(0)
  for (let i = rest.length - 1; i >= 0; i--) suf[i] = suf[i + 1] + messageTokens(rest[i])

  if (!wasCapped && sysTokens + suf[0] <= budget) return messages // everything fits — don't touch

  // Longest fitting tail (last message is never trimmed).
  let start = 0
  while (start < rest.length - 1 && sysTokens + suf[start] > budget) start++
  while (start < rest.length - 1 && rest[start].role === 'assistant') start++

  const kept = rest.slice(start)
  if (!wasCapped && (start === 0 || kept.length === 0)) return [sys, ...kept]
  return [sys, withTrimNotice(kept[0]), ...kept.slice(1)]
}

/**
 * (fix 717) Emergency truncation: trim TEXT of the last message
 * so that at least something fits in the window. Media parts are left intact (images/videos
 * are re-attached on each turn), but explicit notice is added to text
 * so the model knows input was truncated.
 */
function truncateLastMessageText(messages: TrimMessage[]): TrimMessage[] {
  if (messages.length === 0) return messages
  const out = messages.slice()
  const last = out[out.length - 1]
  const notice = '[Input truncated: did not fit into model context.]'
  if (typeof last.content === 'string') {
    const maxChars = 20_000
    const text = last.content.length > maxChars ? last.content.slice(0, maxChars) : last.content
    out[out.length - 1] = { ...last, content: `${notice}\n${text}` }
    return out
  }
  if (Array.isArray(last.content)) {
    const parts = [...(last.content as Array<Record<string, unknown>>)]
    const idx = parts.findIndex((p) => p && p.type === 'text' && typeof p.text === 'string')
    if (idx >= 0) {
      const text = String(parts[idx].text)
      parts[idx] = {
        ...parts[idx],
        text: `${notice}\n${text.length > 20_000 ? text.slice(0, 20_000) : text}`,
      }
    } else {
      parts.unshift({ type: 'text', text: notice })
    }
    out[out.length - 1] = { ...last, content: parts }
  }
  return out
}

/** (fix 169) Trim notice in the first preserved message. */
function withTrimNotice<T extends { content: string | unknown[] }>(msg: T): T {
  const notice =
    '[Note: earlier messages in this chat did not fit into context and were trimmed. Rely on recent messages and currently attached references.]'
  if (typeof msg.content === 'string') {
    return { ...msg, content: `${notice}\n\n${msg.content}` }
  }
  if (Array.isArray(msg.content)) {
    const parts = [...(msg.content as Array<Record<string, unknown>>)]
    const firstText = parts.findIndex((p) => p && p.type === 'text' && typeof p.text === 'string')
    if (firstText >= 0) {
      parts[firstText] = { ...parts[firstText], text: `${notice}\n\n${parts[firstText].text}` }
    } else {
      parts.unshift({ type: 'text', text: notice })
    }
    return { ...msg, content: parts }
  }
  return msg
}

/**
 * (fix 169) Last resort: [system + last message] alone does not
 * fit into window. Evenly subsample video frames (Bonsai
 * video_frames) until prompt fits; images and whole videos are not touched
 * (their limits are calculated BEFORE attachment — videoBudgetSec). We do not
 * trim below 4 frames — motion would become illegible; beyond that backend decides (standard:
 * context shift with n_keep, system survives; Bonsai: honest error).
 */
export function degradeMediaToBudget(
  messages: TrimMessage[],
  ctxSize: number,
  outputReserve: number,
): TrimMessage[] {
  const budget = ctxSize - outputReserve - TRIM_SAFETY_MARGIN
  if (budget <= 0 || messages.length === 0) return messages

  const work = messages.map((m) => ({ ...m }))
  const total = () => work.reduce((sum, m) => sum + messageTokens(m), 0)
  if (total() <= budget) return work

  const last = work[work.length - 1]
  if (!Array.isArray(last.content)) return work
  const parts = [...(last.content as Array<Record<string, unknown>>)]

  for (;;) {
    if (total() <= budget) break
    let best = -1
    let bestN = 0
    parts.forEach((p, i) => {
      const n = p && Array.isArray(p.video_frames) ? (p.video_frames as unknown[]).length : 0
      if (n > bestN) {
        best = i
        bestN = n
      }
    })
    if (best < 0 || bestN <= 4) break
    const frames = parts[best].video_frames as string[]
    // Evenly: every other frame + guaranteed last frame.
    parts[best] = {
      ...parts[best],
      video_frames: frames.filter((_, i) => i % 2 === 0 || i === frames.length - 1),
    }
    work[work.length - 1] = { ...last, content: parts }
  }
  return work
}

/**
 * (fix 169) How many seconds of one video can be allocated to vision
 * (standard backend, whole video): 512px frame ≈ FRAME_TOKENS_512, 8 fps.
 * A 60-second ref at 8 fps is ~480 frames ≈ hundreds of thousands of vision tokens;
 * previous "flat" estimate of 15K led to real overflows.
 * Available room is divided evenly among video references of the turn.
 */
export function videoBudgetSec(
  messages: TrimMessage[],
  videoCount: number,
  ctxSize: number,
  outputReserve: number,
): number {
  if (videoCount <= 0) return 2
  const used = messages.reduce((sum, m) => sum + messageTokens(m), 0)
  const free = ctxSize - outputReserve - TRIM_SAFETY_MARGIN - used
  const frames = Math.floor(Math.max(0, free) / videoCount / FRAME_TOKENS_512)
  return Math.max(2, Math.min(60, Math.floor(frames / 8)))
}
