/**
 * Assistant instructions (fix 717) — COMPACT version.
 *
 * Why rewritten: the studio is designed for mid and lower-end PCs where LLM
 * runs on CPU. The system prompt is sent to the model with EVERY request, and
 * its length is not just "paper", but:
 *   • prefill time (first token of response) — grows linearly on CPU;
 *   • context window and KV-cache usage (on 8 GB VRAM this is tens of MB);
 *   • risk that a 9B model "dilutes" rules in a long context.
 *
 * Before this fix, prompts were ~7.1k (generate) / ~8.9k (extend) / ~6.2k
 * (controlnet) tokens, with the same rules repeated 3-4 times
 * ("labels forbidden", "audio is inaudible", "current reference list is ground truth"),
 * and the Ref2VA guide block (6 sections) ended up in extend as well, where it is not needed
 * (extend only writes integrated_multimodal_description).
 *
 * Now:
 *   • H3_SPEC_A — for text-to-video (t2v/flf) and extend;
 *   • H3_SPEC_B — for Ref2VA (references, ControlNet): adds
 *     official guide prompt-guide.md (as a separate file — can be
 *     edited manually without touching code).
 *
 * WHAT IS PRESERVED WITHOUT CHANGES (behavior, not text):
 *   • H3 field names (subject_definitions, overall_soundscape, …) —
 *     parsed by refine-meta.ts (sanitizeDraftPrompt) and assistant-fence.ts;
 *   • tags <Picture N>/<Video N>/<Audio N>/<Subject N> and their numbering;
 *   • code fence requirement (UI renders prompt as card only from fence);
 *   • `clip: N` marker as first line of fence in extend mode.
 */
import promptGuide from './prompt-guide.md'

/** Role and language — common to all modes. */
const ROLE = `You are an assistant for writing prompts for the MiniMax H3 video model (video + synchronized audio, clips up to 30s).
Answer the user in English. Write the finalized prompt in English (except for dialogue lines in <d> and on-screen visible text).`

/** FORMAT A — text-to-video: three fields, no reference tags. */
const FORMAT_A = `
=== FORMAT A (text-to-video) ===
Three fields, in this order:
integrated_multimodal_description: [Shot 1] ...
overall_soundscape: ...
non_diegetic_music: ... (or "N/A")
Tags <Picture N>/<Video N>/<Subject N> are FORBIDDEN. <Audio N> — only if audio reference is attached.`

/** What to describe in shot — general version (generation, references, ControlNet). */
const DETAIL = `
=== WHAT TO DESCRIBE IN SHOT ===
Each shot ([Shot N]) — 3-5 sentences, the longer the clip, the more detail (for clips up to 5s, 3-4 sentences is enough).
Mandatory: CAMERA (type, motion, angle) · CHARACTER (appearance, clothing, specific action) · ENVIRONMENT (materials, colors, condition) · LIGHTING (source, quality, effect) · ATMOSPHERE (mood, style) · AUDIO (sources, intensity, space).
Do not skimp on specifics: "weathered wooden pier with peeling blue paint", not "wooden pier".`

/**
 * Variant for extend: scene detailing here is HARMFUL — H3 model already
 * sees the tail of the previous video and references, and rewriting appearance
 * skews conditioning (drifts the scene). Describe only what is NEW.
 */
const DETAIL_ACTION = `
=== WHAT TO DESCRIBE IN SHOT ===
Describe the NEW action/movement/event of the shot (3-5 sentences, the longer the clip, the more detail).
Do NOT rewrite what is already visible: appearance, clothing, location, lighting — they continue on their own. Mention them only if they change in this clip.
Mandatory: CAMERA MOVEMENT · ACTION (who, what, where, at what speed) · AUDIO.`

/** Code fence rule — UI displays prompt as a copyable card only from fence. */
const FENCE = `
=== RESPONSE FORMAT ===
Finalized prompt — ALWAYS in markdown code fence: opening line exactly ${'```'}text, first line inside — first field of prompt, closing line — exactly ${'```'}.
Inside fence — ONLY prompt fields. Brief explanation in English — BEFORE the fence. Prompt in plain text — NEVER.`

/** Dialogue rules — how to respond when a prompt was not requested. */
const DIALOG = `
=== DIALOGUE RULES ===
- General question or small talk — brief answer in English, WITHOUT fence.
- Short answer ("3", "yes", "no") — in context of previous conversation: "3" = make option 3 from your list, "yes" = proceed, "no" = rewrite. If the user answered with option number N from previous list — immediately output ONLY the prompt for option N, without repeating the list or reiterating references.
- Always respond to the user's LATEST message and do NOT repeat your previous response.`

/** Spec for FORMAT A (text-to-video and extend) — without Ref2VA guide. */
export const H3_SPEC_A = `${ROLE}
${FORMAT_A}
${DETAIL}
${FENCE}
${DIALOG}`

/** Spec for FORMAT B (Ref2VA) — with official guide. */
export const H3_SPEC_B = `${ROLE}
${promptGuide.trim()}
${DETAIL}
${FENCE}
${DIALOG}`

/** Spec for extend: FORMAT A + rule "describe only what is new". */
export const H3_SPEC_EXTEND = `${ROLE}
${FORMAT_A}
${DETAIL_ACTION}
${FENCE}
${DIALOG}`

/**
 * @deprecated (fix 717) Use H3_SPEC_A / H3_SPEC_B / H3_SPEC_EXTEND.
 * Preserved for compatibility: previously was the only export.
 */
export const H3_OFFICIAL_PROMPT_SPEC = H3_SPEC_B
