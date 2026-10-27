/**
 * Assistant fence logic (LLM chat) — fix 34.
 *
 * The model is instructed (src/lib/h3-prompt-spec.ts) to ALWAYS wrap
 * the completed structured prompt in fence ```text ... ```. The UI relies on
 * this: fence contents are rendered as a "prompt" card with copying,
 * and the "To prompt" button inserts exactly this into the editor.
 *
 * Pure functions (without React) — so they can be covered by tests
 * without DOM (scratchpad harness: fence-view-test.mjs) and so that a single
 * source of truth for fence parsing is used by both views and tests.
 */

export interface FenceParse {
  /** Text BEFORE the fence (model explanation), trimmed. */
  preamble: string
  /** Prompt INSIDE the fence, trimmed. */
  prompt: string
  /** Text AFTER the closing fence, trimmed (empty when streaming). */
  trailing: string
  /** true if only OPENING fence was found (stream still running). */
  streaming: boolean
}

/** Official H3 structural fields (first fields of FORMAT A and FORMAT B). */
const H3_FIELD_RE = /(subject_definitions|integrated_multimodal_description)\s*:/i

/**
 * Whether the text contains a real H3 field marker.
 * A fence ``` by itself does NOT count: normal responses (Q&A, advice)
 * may quote code snippets.
 */
export function hasH3Field(content: string): boolean {
  return !!content && H3_FIELD_RE.test(content)
}

/**
 * Parse assistant response into preamble / fence-prompt / trailing.
 * Returns null if there is no fence at all.
 *
 * - Full fence (```text … ```) → prompt = content, trailing = everything
 *   after the closing fence.
 * - Only opening fence (streaming, closing has not arrived yet) →
 *   prompt = everything after the opening fence, streaming = true.
 */
export function parseFence(raw: string): FenceParse | null {
  if (!raw) return null
  let m = raw.match(/```[a-zA-Z]*\s*\n?([\s\S]*?)\n?\s*```/)
  let streaming = false
  if (!m) {
    const open = raw.match(/```[a-zA-Z]*[ \t]*\n?([\s\S]*)$/)
    if (!open) return null
    m = open
    streaming = true
  }
  const idx = raw.indexOf(m[0])
  const preamble = raw.slice(0, idx).trim()
  const trailing = streaming ? '' : raw.slice(idx + m[0].length).trim()
  return { preamble, prompt: m[1].trim(), trailing, streaming }
}

/**
 * (fix 427) Parse ALL fence blocks of a message (not only the first, as
 * parseFence does): in extend chats the model produces the prompt of EACH clip
 * in a separate fence with a `clip: N` marker — UI draws a card and insert button for
 * each. Order of segments = order of fences in text; text between fences
 * goes into preamble/trailing of adjacent segments. Unclosed fence at the end
 * (streaming) — last segment with streaming=true.
 */
export function parseAllFences(raw: string): FenceParse[] {
  if (!raw) return []
  const out: FenceParse[] = []
  const re = /```[a-zA-Z]*\s*\n?([\s\S]*?)\n?\s*```/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) {
    out.push({ preamble: raw.slice(last, m.index).trim(), prompt: m[1].trim(), trailing: '', streaming: false })
    last = m.index + m[0].length
  }
  const rest = raw.slice(last)
  // Unclosed fence at the end — streaming: important to check EVEN when
  // there were no completed fences at all (the only fence is still streaming).
  const open = rest.match(/```[a-zA-Z]*[ \t]*\n?([\s\S]*)$/)
  if (open && typeof open.index === 'number') {
    out.push({
      preamble: rest.slice(0, open.index).trim(),
      prompt: open[1].trim(),
      trailing: '',
      streaming: true,
    })
  } else if (out.length && rest.trim()) {
    out[out.length - 1].trailing = rest.trim()
  }
  return out
}

/** (fix 427) Clip marker in extend chat: first line of fence `clip: N`
 *  (case-insensitive, whitespace around `:` allowed). null — no marker. */
export function parseClipMarker(fenceContent: string): number | null {
  if (!fenceContent) return null
  const firstLine = fenceContent.split('\n', 1)[0].trim()
  const m = firstLine.match(/^clip\s*:\s*(\d+)\s*$/i)
  if (!m) return null
  const n = parseInt(m[1], 10)
  return Number.isFinite(n) && n >= 1 ? n : null
}

/** (fix 427) Clip prompt without marker line `clip: N` — what is
 *  actually inserted into the clip card. No marker → content as is. */
export function stripClipMarker(fenceContent: string): string {
  if (parseClipMarker(fenceContent) === null) return fenceContent.trim()
  return fenceContent.split('\n').slice(1).join('\n').trim()
}

function stripDecorativeQuotes(t: string): string {
  return t.replace(/^["«]+/, '').replace(/["»]+$/g, '').trim()
}

/**
 * Extract insertable H3 prompt from assistant response (fix 34):
 * 1) content of fence block — exactly between ```text and ```, i.e. trimmed
 *    AT CLOSING FENCE, not to the end of the line;
 * 2) no fence — from the first H3 field marker, also trimmed at
 *    closing fence if it still appears further;
 * 3) fallback — last substantive paragraph (as it was before fix 34).
 * Returns '' if nothing suitable found.
 */
export function extractInsertablePrompt(content: string): string {
  if (!content) return ''

  // 1) fence block — preferred source.
  const fence = content.match(/```[a-zA-Z]*\s*\n?([\s\S]*?)\n?\s*```/)
  if (fence && fence[1].trim()) {
    return stripDecorativeQuotes(fence[1].trim())
  }

  // 2) No (full) fence: from first H3 field, trimmed at closing
  //    fence if it still appears further.
  const marker = content.search(H3_FIELD_RE)
  if (marker >= 0) {
    let text = content.slice(marker)
    const close = text.search(/\n\s*```/)
    if (close >= 0) text = text.slice(0, close)
    return stripDecorativeQuotes(text.trim())
  }

  // 3) Fallback: last substantive paragraph (as it was before fix 34).
  const para = content
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p && !p.startsWith('—') && p.length > 40)
    .pop()
  return stripDecorativeQuotes(para ?? content.trim())
}
