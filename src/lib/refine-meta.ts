/**
 * refine-meta — borrowing draft prompt from .meta.json sidecar for
 * v2v-refine, stripping out anything harmful or pointless in refine.
 *
 * Why: refine at σ_start 0.9035 is a text-conditioned re-render anchored
 * by source latent; the original draft prompt describes the scene and makes
 * the scheme identical to Pass 2 of generation (where pass 2 uses the same
 * caption as pass 1).
 *
 * What is stripped out (Assistant Format A/B, h3-prompt-spec.ts + prompt-guide.md):
 *  • audio sections — overall_soundscape, non_diegetic_music (audio is taken
 *    directly from source, these tokens only dilute attention);
 *  • reference-meta sections — retention_analysis, summary (structured
 *    around <Subject N> tags);
 *  • <Video N>/<Audio N> tags — these modalities are not present in refine,
 *    dangling references to non-existent ref segments = out-of-distribution
 *    conditioning. <Picture N> tags (edit 310) ARE PRESERVED: refine builder
 *    (edit 315) passes meta-refs in the original numbering of initial
 *    generation (<Picture 1..k>), so links are valid again;
 *  • <Subject N> tags (edit 310) — abstraction from subject_definitions
 *    (prompt-guide.md: "<Subject N> — visible content abstracted from refs",
 *    specified via <Picture N>, no 1:1 mapping to slots exists) —
 *    stripped out, while CONTENTS of subject_definitions (appearance descriptions
 *    with valid <Picture N>) are preserved;
 *  • speaker markers (S1) and prefix [reference generation].
 * Dialog <d>…</d> IS PRESERVED — keeps lip sync of re-render with original audio.
 *
 * References (edit 315): images from source meta (<Picture 1..k>, original
 * order from original generation), first video frame — LAST slot
 * (<Picture k+1>); without meta-refs, first frame = <Picture 1>.
 *
 * (edit 316) Prompt chain: readPromptChain/promptChainFromMeta combine
 * source_prompt → prompt → extend_prompts[] into a single conditioning text
 * (separator '\n\n---\n\n') — for extend-combined sources, refine and
 * upscales inherit the ENTIRE chain "source → clips", rather than a single prompt.
 */
import fs from 'fs'
import path from 'path'
import { getAppConfig } from '@/lib/app-config'
import { sanitizeFolderPath } from '@/lib/gallery-folders' // (edit 495)
import { validateLatentFile } from '@/lib/latent-file'

/** Does the text contain at least one "real" word (2+ letters)?
 *  A prompt consisting only of dots/digits ("." — test extend clips) cannot
 *  serve as a conditioning anchor: with such a caption, refine at σ≈0.9
 *  rebuilds each chunk independently — characters change from chunk
 *  to chunk. Such prompts are treated as absent → neutral enhance. */
function hasMeaningfulText(s: string): boolean {
  return /[a-zA-Z\u00c0-\u024f\u0400-\u04ff]{2,}/.test(s)
}

/** Sections that are kept (section label is stripped, body kept in full).
 *  (edit 310) subject_definitions is kept: its body consists of appearance descriptions
 *  with <Picture N> tags that are valid again (edit 315). */
const KEEP_SECTIONS = new Set(['integrated_multimodal_description', 'detailed_description', 'subject_definitions'])

/** (edit 310) Reference tag of a modality absent in refine:
 *  <Video 2> / <Audio 1> (no audio/video refs in refine-cond).
 *  <Picture N> is NOT stripped — builder (edit 315) preserves original
 *  numbering of meta-refs, links remain valid. */
const REF_TAG_RE = /<\s*(?:video|audio)\s+\d+\s*>/gi
/** (edit 310) Tag <Subject N> — abstraction of subject_definitions defined
 *  via <Picture N> (prompt-guide.md), no 1:1 mapping to image slots →
 *  stripped out (section content is preserved). */
const SUBJECT_TAG_RE = /<\s*subject\s+\d+\s*>/gi
/** Speaker marker from FORMAT B: "(S1)" and variants. */
const SPEAKER_RE = /\(\s*S\d+\s*\)/g
/** FORMAT B mode prefix: "[reference generation] ...". */
const REF_MODE_PREFIX_RE = /^\s*\[reference generation\]\s*/i
/** Section label at line start: "overall_soundscape: ...". */
const SECTION_RE = /^([a-z_]+):\s*/gm

/**
 * Clean up draft prompt for refine-conditioning.
 * Free text without section labels is returned sanitized of tags as is.
 */
export function sanitizeDraftPrompt(raw: string): string {
  const text = (raw || '').replace(/\r\n?/g, '\n')
  if (!text.trim()) return ''

  // Parse by sections: [label, body] — section runs until the next label.
  const sections: Array<{ label: string; body: string }> = []
  const marks: Array<{ label: string; start: number; end: number }> = []
  for (const m of text.matchAll(SECTION_RE)) {
    marks.push({ label: m[1], start: m.index, end: m.index + m[0].length })
  }
  if (marks.length === 0) {
    sections.push({ label: '', body: text })
  } else {
    // Text before the first label (usually empty) is also treated as an "unlabeled" section.
    if (marks[0].start > 0) sections.push({ label: '', body: text.slice(0, marks[0].start) })
    marks.forEach((mk, i) => {
      const stop = i + 1 < marks.length ? marks[i + 1].start : text.length
      sections.push({ label: mk.label, body: text.slice(mk.end, stop) })
    })
  }

  const kept = sections
    .map(({ label, body }) => (label === '' || KEEP_SECTIONS.has(label) ? body : ''))
    .filter((s) => s.trim())

  return kept
    .map((s) => sanitizeFragment(s))
    .filter((s) => s.length > 0)
    .join('\n\n')
}

/** Sanitize single fragment: <Video|Audio|Subject N> tags (edit 310;
 *  <Picture N> are kept), speakers, prefix, redundant whitespace. */
function sanitizeFragment(fragment: string): string {
  return fragment
    .replace(REF_TAG_RE, '')
    .replace(SUBJECT_TAG_RE, '')
    .replace(SPEAKER_RE, '')
    .replace(REF_MODE_PREFIX_RE, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]{2,}/g, ' ').trim())
    .filter((line, i, arr) => line !== '' || (i > 0 && arr[i - 1] !== ''))
    .join('\n')
    .trim()
}

/**
 * (edit 309) Read image references from source .meta.json.
 * (edit 311) Returns objects { path, role } (role is imageIntent from
 * meta, may be empty): refine builder writes meaningful slot label
 * <Picture N> based on role.
 * Array order = references order of original generation (filter
 * type==='image' preserves relative order) — this is the original
 * numbering <Picture 1..k> (see edit 315 in refine-template.ts).
 */
export function readMetaImageRefs(subfolder: string, filename: string): Array<{ path: string; role: string }> {
  const OUTPUT_DIR = getAppConfig().outputDir
  if (!OUTPUT_DIR || !filename) return []

  const safeSub = subfolder ? sanitizeFolderPath(subfolder) : ''
  const safeName = path.basename(filename)
  const metaFile = path.resolve(path.join(OUTPUT_DIR, ...safeSub.split('/').filter(Boolean), safeName + '.meta.json'))
  // (edit 716) Compare resolved paths (lowercase on win32)
  // with delimiter boundary. Former metaFile.startsWith(OUTPUT_DIR) compared
  // UN-normalized OUTPUT_DIR and skipped neighboring "outputX" folder.
  if (!isInsideOutput(metaFile, OUTPUT_DIR)) return []

  try {
    const raw = fs.readFileSync(metaFile, 'utf-8')
    const meta = JSON.parse(raw) as {
      references?: Array<{ type?: string; path?: string; role?: string }>
      minimax_h3_references?: Array<{ type?: string; path?: string; role?: string }>
    }
    const refs = Array.isArray(meta.references) ? meta.references
      : Array.isArray(meta.minimax_h3_references) ? meta.minimax_h3_references
      : []
    return refs
      .filter((r) => r.type === 'image' && typeof r.path === 'string' && r.path.length > 0)
      // (edit 716) Path from sidecar is normalized to FILENAME (basename).
      // Sidecar comes from client (POST /api/comfy/metadata accepts params as is),
      // so r.path could be "../../../secret.png". Previously it went to
      // path.join(cfg.inputDir, r.path) — an oracle for existence
      // of arbitrary files — and then into workflow where ComfyUI LoadImage
      // expects just a filename from input/.
      .map((r) => ({
        path: path.basename((r.path as string).replace(/\\/g, '/')),
        role: typeof r.role === 'string' ? r.role : '',
      }))
      .filter((r) => r.path.length > 0 && r.path !== '.' && r.path !== '..')
  } catch {
    return []
  }
}

/** (edit 316) Shared sidecar path resolution with outputDir traversal protection. */
function resolveMetaFile(subfolder: string, filename: string): string | null {
  const OUTPUT_DIR = getAppConfig().outputDir
  if (!OUTPUT_DIR || !filename) return null

  // (edit 495) subfolder is a multi-level relative path ('a/b').
  const safeSub = subfolder ? sanitizeFolderPath(subfolder) : ''
  const safeName = path.basename(filename)
  const metaFile = path.resolve(path.join(OUTPUT_DIR, ...safeSub.split('/').filter(Boolean), safeName + '.meta.json'))
  // (edit 716) Normalized comparison with delimiter boundary.
  if (!isInsideOutput(metaFile, OUTPUT_DIR)) return null
  return metaFile
}

/**
 * (edit 716) Is path inside outputDir? Comparison of normalized paths
 * (case-insensitive on win32), boundary by delimiter.
 */
function isInsideOutput(target: string, outputDir: string): boolean {
  const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p)
  const root = norm(path.resolve(outputDir))
  const t = norm(path.resolve(target))
  return t === root || t.startsWith(root + path.sep)
}

/**
 * Read draft prompt from sidecar `<outputDir>/<subfolder>/<filename>.meta.json`.
 * Returns SANITIZED prompt or null (no file / no field / empty).
 */
export function readDraftPrompt(subfolder: string, filename: string): string | null {
  const metaFile = resolveMetaFile(subfolder, filename)
  if (!metaFile) return null

  try {
    const raw = fs.readFileSync(metaFile, 'utf-8')
    const meta = JSON.parse(raw) as { prompt?: unknown }
    if (typeof meta.prompt !== 'string' || !hasMeaningfulText(meta.prompt)) return null
    return sanitizeDraftPrompt(meta.prompt) || null
  } catch {
    return null
  }
}

/**
 * (edit 316) Assemble FULL prompt chain from already parsed meta:
 * source → extensions. Order: source_prompt (source prompt, preserved
 * by concat) → prompt → extend_prompts[] (accumulated chain of extensions).
 * Consecutive duplicates are collapsed (first extension prompt often matches
 * source prompt). Each part undergoes sanitizeDraftPrompt; parts are
 * joined with '\n\n---\n\n' separator. No meaningful text → null.
 */
export function promptChainFromMeta(meta: Record<string, unknown>): string | null {
  const parts = promptChainPartsFromMeta(meta)
  if (parts.length === 0) return null
  const joined = parts.join('\n\n---\n\n')
  return hasMeaningfulText(joined) ? joined : null
}

/**
 * Prompt chain from meta BY PARTS (same breakdown as
 * promptChainFromMeta, but without joining): [source_prompt, prompt,
 * ...extend_prompts] — each part is sanitized, consecutive duplicates
 * collapsed. Needed for "By parts" mode so window 0 gets the FIRST prompt
 * of the chain (describing start of video), rather than sum of all scenes.
 */
export function promptChainPartsFromMeta(meta: Record<string, unknown>): string[] {
  const parts: string[] = []
  const push = (v: unknown) => {
    if (typeof v !== 'string' || !hasMeaningfulText(v)) return
    const s = sanitizeDraftPrompt(v)
    if (s && parts[parts.length - 1] !== s) parts.push(s)
  }
  push(meta.source_prompt)
  push(meta.prompt)
  if (Array.isArray(meta.extend_prompts)) {
    for (const p of meta.extend_prompts) push(p)
  }
  return parts
}

/** Parts of prompt chain from source sidecar (see promptChainPartsFromMeta). */
export function readPromptChainParts(subfolder: string, filename: string): string[] | null {
  const metaFile = resolveMetaFile(subfolder, filename)
  if (!metaFile) return null

  try {
    const raw = fs.readFileSync(metaFile, 'utf-8')
    const parts = promptChainPartsFromMeta(JSON.parse(raw) as Record<string, unknown>)
    return parts.length > 0 ? parts : null
  } catch {
    return null
  }
}

/**
 * (edit 375/376) Read data from source sidecar for lossless branch of refine:
 * path to saved AV latent (latent_file — written by meta finalization
 * from ui.latents of node '46:49') + video_length/resolution of the same meta.
 * Route verifies them against ffprobe mp4 data: mismatch (video was trimmed/edited
 * after generation) → latent is unsuitable, refine follows standard mp4 path.
 */
export function readMetaLatentSource(
  subfolder: string,
  filename: string,
): { latentFile: string; videoLength: number; resolution: string } | null {
  const metaFile = resolveMetaFile(subfolder, filename)
  if (!metaFile) return null

  try {
    const raw = fs.readFileSync(metaFile, 'utf-8')
    const meta = JSON.parse(raw) as {
      latent_file?: unknown
      video_length?: unknown
      resolution?: unknown
    }
    if (typeof meta.latent_file !== 'string' || meta.latent_file.length === 0) return null
    return {
      latentFile: meta.latent_file,
      videoLength: typeof meta.video_length === 'number' ? meta.video_length : -1,
      resolution: typeof meta.resolution === 'string' ? meta.resolution : '',
    }
  } catch {
    return null
  }
}

export interface ResolvedSourceLatent {
  /** Path to .latent relative to ComfyUI output/. */
  file: string
  /** Pixel canvas of latent (from safetensors header, latent × 16).
   *  This is the GENERATION canvas (before cropping to nominal) — all geometry
   *  of lossless branch (target, conditioning, upscale) is calculated from it. */
  width: number
  height: number
  /** Number of latent video tokens (exact, from shape). */
  tokens: number
  /** Number of latent audio steps (exact, from shape; 0 = unreadable). */
  audioSteps: number
}

/**
 * (edits 381/382) UNIFIED resolver of lossless branch for refine "Whole" /
 * "By parts" / Tile Upscale: meta → mp4 integrity → file validation →
 * latent pixel canvas. Any failure → null (silent fallback to mp4),
 * reason logged via caller's console.warn (verbose flag).
 *
 * Checks:
 *  • latent_file in sidecar, mp4 NOT changed (meta frames/resolution = ffprobe);
 *  • file exists, safetensors header intact, version/VAE match;
 *  • latent canvas ≥ mp4 dimensions (generation crop only trims) and multiple of 32.
 */
export function resolveSourceLatent(
  subfolder: string,
  filename: string,
  probe: { width: number; height: number; frames: number },
  warn?: (msg: string) => void,
): ResolvedSourceLatent | null {
  const log = warn ?? (() => {})
  const ls = readMetaLatentSource(subfolder, filename)
  if (!ls) return null
  if (ls.videoLength !== probe.frames || ls.resolution !== `${probe.width}x${probe.height}`) {
    log(`mp4 does not match meta (trimmed/modified after generation)`)
    return null
  }
  const check = validateLatentFile(ls.latentFile)
  if (!check.ok || !check.dims) {
    log(check.reason ?? 'no latent dimensions in header')
    return null
  }
  const { width, height, tokens, audioSteps } = check.dims
  if (width < probe.width || height < probe.height) {
    log(`latent canvas ${width}×${height} is smaller than mp4 ${probe.width}×${probe.height} — inconsistent meta`)
    return null
  }
  // (edit 396, 431) Canvas must be a multiple of 32 (as promised by docstring;
  // with edit 431 extend-combine also writes latent on ceil32 canvas — before it,
  // ceil16 resulted in odd latent and LatentConcat failure during post-assembly).
  // Otherwise lossless conditioning geometry diverges — silent fallback to mp4.
  if (width % 32 !== 0 || height % 32 !== 0) {
    log(`latent canvas ${width}×${height} is not a multiple of 32 — lossless rejected`)
    return null
  }
  return { file: ls.latentFile, width, height, tokens, audioSteps }
}

/**
 * (edit 316) Read prompt chain from source sidecar.
 * For standard meta (single prompt, no extend fields) equivalent to
 * readDraftPrompt; for extend-combined returns the full path
 * "source → clip 1 → … → clip N".
 */
export function readPromptChain(subfolder: string, filename: string): string | null {
  const metaFile = resolveMetaFile(subfolder, filename)
  if (!metaFile) return null

  try {
    const raw = fs.readFileSync(metaFile, 'utf-8')
    return promptChainFromMeta(JSON.parse(raw) as Record<string, unknown>)
  } catch {
    return null
  }
}
