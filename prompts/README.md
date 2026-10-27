# LLM Assistant Instructions

This folder contains **reference copies** of instructions (system prompts) for the LLM assistant
in MiniMax H3 Studio.

> Fix 717: instructions were refactored and **condensed** (generate 4212 -> 2572 tokens,
> extend 5128 -> 2873, controlnet 3624 -> 2720). Reason: studio is designed for
> mid and low-end PCs where LLM runs on CPU: system prompt length = prefill time
> (time to first token) + context and KV cache consumption. Furthermore, 9B models follow
> rules worse in excessively long contexts.

## Files

### `base-framing.md`
Role, language, FORMAT A, level of detail, code fence rule, dialogue rules.

**Used in:** `src/lib/h3-prompt-spec.ts` (constants `ROLE`, `FORMAT_A`,
`DETAIL`, `DETAIL_ACTION`, `FENCE`, `DIALOG`)

### `prompt-guide.md`
Official MiniMax H3 guide on Ref2VA prompt structure: six-section
structure, reference tags, relationship markers, example.

**Used in:** `src/lib/h3-prompt-spec.ts` (imported as `promptGuide`).
Included **only in FORMAT B modes** (references, ControlNet) — in
text-to-video and extend modes it is not needed and would cost ~1k extra tokens.

> ⚠️ **Keep copies synchronized.** This copy and `src/lib/prompt-guide.md`
> must be **byte-for-byte identical**: the application reads the file in
> `src/lib/`, while this one is a reference copy for human inspection and editing.
> After editing, copy the file to `src/lib/prompt-guide.md` (or vice versa).
> Verify: `diff -u prompts/prompt-guide.md src/lib/prompt-guide.md`.

### `generate-mode.md`
Dynamic part of system prompt for "Generate" chat (t2v/flf/ref):
SESSION CONTEXT, reference list, visual/audio anchor, honesty block.

**Used in:** `src/lib/assistant-stream.ts` (function `buildSystemMessage()`)

### `extend-mode.md`
Dynamic part of system prompt for "Extend" chat: clip list,
extension references, source metadata, extension rules.

**Used in:** `src/lib/assistant-stream.ts` (function `buildExtendSystemMessage()`)

### `controlnet-mode.md`
Dynamic part of system prompt for "ControlNet" chat: control video,
image references, mode rules. For `controlType=direct` — dedicated
"animation transfer" branch: control video is added to refs as `<Video 1>`,
its digest is cached by file content, and prompt describes new appearance.

**Used in:** `src/lib/assistant-stream.ts` (function `buildControlNetSystemMessage()`)

## Important

⚠️ **These files are NOT read by the application directly.** They are reference copies for
reading and manual editing.

The application uses instructions from:
- `src/lib/h3-prompt-spec.ts` — static part (role, format, detail, fence, dialogue)
- `src/lib/prompt-guide.md` — official Ref2VA guide (only for FORMAT B)
- `src/lib/assistant-stream.ts` — dynamic part (session context + mode rules)

The actual **complete** text of system prompts for all three modes
is assembled from these files: static — `src/lib/h3-prompt-spec.ts`,
dynamic — `src/lib/assistant-stream.ts`.

## Changes in Fix 717

1. **Duplicates eliminated.** "Tags forbidden", "audio cannot be heard", "current ref list is
   sole source of truth" were repeated 3-4 times across different blocks. Now
   there is a single "HONESTY AND CHAT BOUNDARIES" block.
2. **Ref2VA guide attached based on output format**, rather than always. In extend mode it
   is not only redundant, but HARMFUL: guide suggests `<Subject N>`, whereas extension
   rules forbid it.
3. **Contradiction removed:** "prefer 400 words per shot" vs "3-second clip = single
   shot". Detail level is now linked to clip duration.
4. **Mode conflict removed.** The "Generate" tab in extend mode
   ("extend") previously landed in "References" branch, receiving both
   "FORMAT B" and "FORMAT A, references not used" in one prompt. Now explicit
   notification is provided for this mode.
5. **Fence rule formulated once** (was present in both "RESPONSE FORMAT" and
   tail of "Chat behaviour").
