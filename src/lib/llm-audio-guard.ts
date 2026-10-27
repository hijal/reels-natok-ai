/**
 * LLM audio-reliability guard — "proper audio ref handling without Whisper".
 *
 * Problem: small local LLM is unstable on "raw" audio. Some runs degenerate
 * (infinite loop: thought-channel artifacts `<|channel>thought\n<channel|>` × N
 * or repeating a single phrase × N), some give "coherent" but contradictory
 * responses (confabulation rather than actual listening).
 *
 * What we do (without installing anything new):
 *  1) STOP TOKENS — `LLM_STOP_TOKENS` are passed to every request: generation
 *     is physically cut off as soon as the model begins dumping the
 *     thought channel. Degeneration no longer consumes max_tokens.
 *  2) PROBE WITH RETRY — if audio is attached to the message, BEFORE the real
 *     answer we run a short non-streaming probe (~48 tokens) with
 *     increasing temperature. The first NON-degenerate run wins —
 *     its temperature is used in the main response (the temp at which the model
 *     "hears" more stably wins on average). If all probes degenerate —
 *     we proceed with base temperature (stop tokens will cut the loop anyway).
 *  3) PROMPT HONESTY — phrasing "describe ONLY what is actually
 *     audible; if unsure, say so, do not invent anything" (route.ts and
 *     assistant-stream.ts).
 *
 * PURE module (no Next imports) — can be tested directly:
 *   node src/lib/llm-audio-guard.selftest.ts  (or external script).
 *
 * (fix 135) SamplingParams type is imported from ./llm-sampling
 * (also a pure module, no Next) — single source of truth for sampling
 * parameters: both main response and audio probe pass identical sets of
 * top_p / top_k / min_p / presence_penalty / frequency_penalty / repeat_penalty
 * to llm_server.
 */

import type { SamplingParams } from './llm-sampling'

/** Chat template thought-channel artifacts produced during model degeneration. */
export const LLM_STOP_TOKENS = ['<|channel>', '<channel|>']

/**
 * Degenerate response detector.
 *  • empty/short (< 12 characters) — not an answer;
 *  • any thought channel (`<|channel` / `channel|>`) — template artifact;
 *  • looping: identical window of 8/16/32 chars repeated ≥ 5 times
 *    (covers "Yes, I'm on the train." × N and similar repetitions).
 */
export function isDegenerateAnswer(text: string | undefined | null): boolean {
  const t = (text ?? '').trim()
  if (t.length < 12) return true
  if (/<\|channel|channel\|>/i.test(t)) return true
  if (t.length < 80) return false
  for (const len of [8, 16, 32]) {
    if (t.length < len * 5) continue
    const counts = new Map<string, number>()
    let degenerate = false
    for (let i = 0; i + len <= t.length; i++) {
      const block = t.slice(i, i + len)
      if (/^\s+$/.test(block)) continue
      const c = (counts.get(block) ?? 0) + 1
      counts.set(block, c)
      if (c >= 5) {
        degenerate = true
        break
      }
    }
    if (degenerate) return true
  }
  return false
}

export interface ProbeResult {
  /** Temperature to use in main (streaming) response. */
  temperature: number
  /** Number of probe attempts made (1..3). */
  attempts: number
  /** Last probe text (for debugging/logging). */
  lastProbeText: string | null
  /** Human-readable outcome description. */
  note: string
}

const PROBE_MAX_TOKENS = 48
const PROBE_TIMEOUT_MS = 90_000
/** Temperature steps: base, base+0.1, base+0.2 (capped at 1.0). */
const PROBE_STEPS = [0, 0.1, 0.2]

/**
 * Trial LLM run (non-streaming, ~48 tokens) with temperature retry.
 * Returns temperature of the first non-degenerate run (or base
 * if all probes degenerate — then stop tokens protect the main answer).
 *
 * Never throws: any error (network, timeout, 5xx) falls back to "proceed
 * with base temperature", the assistant must not crash due to probing.
 */
export async function probeAudioAnswer(opts: {
  baseUrl: string
  messages: Array<{ role: string; content: unknown }>
  baseTemperature: number
  maxTokens?: number
  /** (fix 135) sampling params — passed to each probe matching the main answer. */
  sampling?: SamplingParams
  fetchImpl?: typeof fetch
  log?: (msg: string) => void
}): Promise<ProbeResult> {
  const { baseUrl, messages, baseTemperature } = opts
  const log = opts.log ?? (() => {})
  const fetchImpl = opts.fetchImpl ?? fetch
  const sampling = opts.sampling
  const temps = PROBE_STEPS.map(
    (d) => Math.min(1.0, Math.round((baseTemperature + d) * 100) / 100),
  )

  let lastText: string | null = null
  for (let i = 0; i < temps.length; i++) {
    const temp = temps[i]
    try {
      const res = await fetchImpl(`${baseUrl}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages,
          max_tokens: opts.maxTokens ?? PROBE_MAX_TOKENS,
          // (fix 135) — same sampling shape as main answer,
          // with temperature varying across PROBE_STEPS.
          // (fix 421) temperature AFTER spread: SamplingParams includes
          // its own temperature, and spread overwrote stepped temp — causing all
          // probes to run at the same temperature and breaking PROBE_STEPS.
          ...(sampling ?? {}),
          temperature: temp,
          stream: false,
          stop: LLM_STOP_TOKENS,
        }),
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      })
      if (!res.ok) {
        log(`probe temp=${temp}: HTTP ${res.status} — trying next probe`)
        continue
      }
      const data = (await res.json().catch(() => null)) as {
        ok?: boolean
        text?: string
        error?: string
      } | null
      if (!data?.ok) {
        log(`probe temp=${temp}: ${data?.error ?? 'response not ok'} — trying next probe`)
        continue
      }
      const text = (data.text ?? '').trim()
      lastText = text
      if (!isDegenerateAnswer(text)) {
        log(`probe temp=${temp}: OK (${text.length} chars)`)
        return {
          temperature: temp,
          attempts: i + 1,
          lastProbeText: text,
          note: `audio-probe passed (temp ${temp}, attempt ${i + 1})`,
        }
      }
      log(`probe temp=${temp}: DEGENERATION (${text.length} chars) — trying next probe`)
    } catch (e) {
      log(`probe temp=${temp}: ${e instanceof Error ? e.message : String(e)} — trying next probe`)
    }
  }
  return {
    temperature: baseTemperature,
    attempts: temps.length,
    lastProbeText: lastText,
    note: 'all audio probes degenerate — proceeding with base temperature (stop tokens will cut loop in main answer)',
  }
}
