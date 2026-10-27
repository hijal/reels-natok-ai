/**
 * (fix 257) Custom model directories — collections OUTSIDE the studio folder.
 *
 * Most frequent request from YouTube (3 independent requests): "I have a 2 TB
 * model pack, I don't want to duplicate it into the studio folder".
 *
 * How it works:
 *   1. User adds folders in Settings (category = ComfyUI folder name:
 *      diffusion_models, loras, vae, text_encoders, ...).
 *      If a folder with standard structure is added (like models/ in
 *      ComfyUI) — subfolders are distributed into categories automatically.
 *   2. List is written to config.ini ([models] extra_paths, JSON) and to
 *      ComfyUI/extra_model_paths.yaml — ComfyUI fork reads it at
 *      startup ITSELF (main.py:141), models from external folders appear in
 *      node lists. Changes require restarting start.bat.
 *   3. Studio lists (video models, LoRA) scan external folders with the same
 *      extensions, names are relative paths (subdir/name.safetensors),
 *      as ComfyUI sees them.
 */
import { readdirSync, writeFileSync, statSync, readFileSync, mkdirSync } from 'fs'
import { join, relative, dirname } from 'path'
import { getAppConfig } from './app-config'

/** Categories that make sense to attach externally (fork's folder_paths). */
export const EXTRA_CATEGORIES: Array<{ key: string; label: string; exts: string[] }> = [
  { key: 'diffusion_models', label: 'Video models (diffusion/unet)', exts: ['.safetensors', '.ckpt', '.pt', '.bin', '.gguf'] },
  { key: 'loras', label: 'LoRA', exts: ['.safetensors', '.ckpt', '.pt'] }, // (fix 587) '.pt' without dot matched any names ending with "pt"
  { key: 'vae', label: 'VAE', exts: ['.safetensors', '.ckpt', '.pt', '.bin'] },
  { key: 'vae_approx', label: 'VAE Approx (TAE)', exts: ['.safetensors'] },
  { key: 'veda', label: 'Veda Sparse Attention', exts: ['.safetensors'] },
  { key: 'text_encoders', label: 'Text encoders (CLIP)', exts: ['.safetensors', '.bin', '.gguf'] },
  { key: 'latent_upscale_models', label: 'Latent upscalers', exts: ['.safetensors', '.pt'] },
  { key: 'upscale_models', label: 'Pixel upscalers', exts: ['.safetensors', '.pt', '.pth'] },
]

/** Root subfolders that indicate a category (ComfyUI name aliases). */
const CATEGORY_ALIASES: Record<string, string> = {
  diffusion_models: 'diffusion_models',
  unet: 'diffusion_models',
  loras: 'loras',
  vae: 'vae',
  vae_approx: 'vae_approx',
  veda: 'veda',
  text_encoders: 'text_encoders',
  clip: 'text_encoders',
  latent_upscale_models: 'latent_upscale_models',
  upscale_models: 'upscale_models',
}

/** Does the folder have a standard models/ structure (category subfolders)? */
export function looksLikeModelsRoot(dir: string): boolean {
  try {
    const subs = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory())
    return subs.some((e) => CATEGORY_ALIASES[e.name.toLowerCase()])
  } catch {
    return false
  }
}

/**
 * Split added folder into {path, category} entries:
 * root with standard structure → one entry per category subfolder;
 * otherwise → one entry with guessed (by name) or default category.
 */
export function detectExtraEntries(dir: string): Array<{ path: string; category: string }> {
  if (looksLikeModelsRoot(dir)) {
    const out: Array<{ path: string; category: string }> = []
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      const cat = CATEGORY_ALIASES[e.name.toLowerCase()]
      if (cat) out.push({ path: join(dir, e.name), category: cat })
    }
    return out
  }
  const name = dir.split(/[\\/]/).pop()?.toLowerCase() ?? ''
  let guess = CATEGORY_ALIASES[name]
  if (!guess) {
    // Heuristic by substring: "my-loras", "VAE-backup", "unet_big" ...
    if (name.includes('lora')) guess = 'loras'
    else if (name.includes('vae')) guess = 'vae'
    else if (name.includes('unet') || name.includes('diffusion')) guess = 'diffusion_models'
    else if (name.includes('clip') || name.includes('encoder')) guess = 'text_encoders'
  }
  return [{ path: dir, category: guess ?? 'diffusion_models' }]
}

/** Path to yaml next to ComfyUI main.py (fork reads it itself at startup). */
function yamlPath(): string {
  const cfg = getAppConfig()
  return join(cfg.comfyRoot, 'ComfyUI', 'extra_model_paths.yaml')
}

/**
 * (fix 722) Studio's own entry: Face Refine detectors folder.
 *
 * No one registers the `ultralytics` category in this build (Impact Pack is not
 * installed), but H3FaceTrackCrop gathers the detector list from it — without
 * registration, only the default face_yolov8m.pt lives in the combo, and a
 * human model cannot be selected for fallback_detector. The path is relative: yaml
 * is in ComfyUI folder, fork loader resolves relative paths from it.
 */
const STUDIO_EXTRA_ENTRIES = [{ config: 'minimax_studio_detectors', category: 'ultralytics', paths: ['models/ultralytics'] }]

/**
 * Write extra_model_paths.yaml: always — own detectors folder,
 * plus external model folders from settings. Called when saving settings
 * and on server startup. Returns true if file changed (requires ComfyUI
 * restart).
 */
export function writeExtraModelPathsYaml(
  entries: Array<{ path: string; category: string }>,
): boolean {
  const valid = entries.filter((e) => {
    try {
      return statSync(e.path).isDirectory()
    } catch {
      return false
    }
  })
  const file = yamlPath()
  // Group by category; paths with forward slashes (yaml-friendly).
  const byCat = new Map<string, string[]>()
  for (const e of valid) {
    const list = byCat.get(e.category) ?? []
    list.push(e.path.replace(/\\/g, '/'))
    byCat.set(e.category, list)
  }
  // Canonical ComfyUI format: config name → category → path list.
  // (Single-level "category: [paths]" broke fork loader — TypeError
  // at startup: it expects dict-categories inside config name.)
  const lines: string[] = ['# Generated by Minimax Studio (Settings → Custom model folders). Do not delete manually.']
  for (const e of STUDIO_EXTRA_ENTRIES) {
    lines.push(`${e.config}:`)
    lines.push(`    ${e.category}:`)
    for (const p of e.paths) lines.push(`        - "${p}"`)
  }
  if (byCat.size) {
    lines.push('minimax_studio:')
    for (const [cat, paths] of byCat) {
      lines.push(`    ${cat}:`)
      for (const p of paths) lines.push(`        - "${p}"`)
    }
  }
  const content = lines.join('\n') + '\n'
  let prev: string | null = null
  try {
    prev = readFileSync(file, 'utf-8')
  } catch {
    prev = null
  }
  if (prev !== content) {
    // ComfyUI directory might be missing (fresh install/migration) — create it.
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content, 'utf-8')
    return true
  }
  return false
}

/**
 * (fix 722) Rewrite yaml from current settings. Called at server
 * startup — ComfyUI starts next and reads the file on import, so
 * the detectors folder has time to register before /object_info is built.
 */
export function syncExtraModelPathsYaml(): boolean {
  return writeExtraModelPathsYaml(getAppConfig().modelExtraPaths)
}


/**
 * Enumerate models from external folders of the given category.
 * Returns relative path names ('subdir/x.safetensors') as
 * ComfyUI expects them. Recursion up to 4 levels, only files with matching
 * extension.
 */
export function listExternalModels(category: string): string[] {
  const cfg = getAppConfig()
  const cat = EXTRA_CATEGORIES.find((c) => c.key === category)
  if (!cat) return []
  const out: string[] = []
  for (const entry of cfg.modelExtraPaths) {
    if (entry.category !== category) continue
    let root: string
    try {
      root = entry.path
      if (!statSync(root).isDirectory()) continue
    } catch {
      continue
    }
    walk(root, root, 0, cat.exts, out)
  }
  return out
}

function walk(root: string, dir: string, depth: number, exts: string[], out: string[]) {
  if (depth > 4) return
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      walk(root, full, depth + 1, exts, out)
    } else if (exts.some((x) => e.name.toLowerCase().endsWith(x))) {
      out.push(relative(root, full).replace(/\\/g, '/'))
    }
  }
}
