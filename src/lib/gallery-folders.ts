/**
 * Gallery folders (fix 91) — subfolders of the ComfyUI output directory.
 *
 * "Root" folder = output root (subfolder ''), always present.
 * Project folders — subfolders of output; generation can be targeted to them
 * (VHS filename_prefix "folder/Minimax_Studio"), while the "Gallery" tab
 * shows all folders at once.
 *
 * (fix 495) Nested folders: subfolder is a RELATIVE path of
 * sanitized segments ('project/scenes', separator '/'), depth
 * up to MAX_DEPTH. Segments '.'/'..' are stripped, the reserved name 'latents'
 * (storage for .latent files in the "draft → refine" pipeline) is reserved.
 */
import { promises as fs } from 'fs'
import path from 'path'
import { getAppConfig } from './app-config'

/** Maximum folder name length (protection against edge cases in URL/filesystem). */
const MAX_NAME_LEN = 60
/** (fix 495) Nesting depth and total length of relative path. */
const MAX_DEPTH = 5
const MAX_PATH_LEN = 240

/** Sanitize folder name: single segment, no invalid characters. */
export function sanitizeFolderName(name: string): string {
  return path
    .basename(String(name ?? ''))
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    // Windows rejects names ending with a dot or space ('dir.' ≡ 'dir').
    .replace(/[. ]+$/, '')
    .slice(0, MAX_NAME_LEN)
}

/**
 * (fix 495) Sanitize RELATIVE folder path ('a/b/c'): each
 * segment — sanitizeFolderName, segments '.'/'..' are discarded (protection against
 * path traversal), separator is normalized to '/'. '' = root (shared folder).
 */
export function sanitizeFolderPath(input: string): string {
  const segs = String(input ?? '')
    .split(/[\\/]+/)
    .map((s) => sanitizeFolderName(s))
    .filter((s) => s && s !== '.' && s !== '..')
    .slice(0, MAX_DEPTH)
  let out = ''
  for (const seg of segs) {
    if (out && out.length + 1 + seg.length > MAX_PATH_LEN) break
    out = out ? `${out}/${seg}` : seg
  }
  return out
}

/** Path to folder inside output ('' = root). */
export function folderPath(folder: string): string {
  const safe = sanitizeFolderPath(folder)
  return safe ? path.join(getAppConfig().outputDir, ...safe.split('/')) : getAppConfig().outputDir
}

/**
 * List of project folders (all nesting levels, relative paths with '/').
 * Sorted; parent always precedes its children (prefix
 * sort). System directories ('latents', dot folders) are excluded.
 */
export async function listGalleryFolders(): Promise<string[]> {
  const root = getAppConfig().outputDir
  const out: string[] = []
  const walk = async (dirAbs: string, rel: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) return
    let entries
    try {
      entries = await fs.readdir(dirAbs, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue
      // (fix 378) 'latents' is internal storage for .latent files,
      // not a project folder (at any nesting level).
      if (e.name.toLowerCase() === 'latents') continue
      const childRel = rel ? `${rel}/${e.name}` : e.name
      out.push(childRel)
      await walk(path.join(dirAbs, e.name), childRel, depth + 1)
    }
  }
  await walk(root, '', 1)
  return out.sort((a, b) => a.localeCompare(b))
}

/** Create folder (nested path 'a/b' creates entire chain). */
export async function createGalleryFolder(name: string): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
  const safe = sanitizeFolderPath(name)
  if (!safe) return { ok: false, error: 'Enter folder name' }
  if (safe.split('/').some((s) => s.toLowerCase() === 'latents')) {
    return { ok: false, error: 'Name "latents" is reserved (internal folder)' }
  }
  const dir = folderPath(safe)
  try {
    await fs.access(dir)
    return { ok: false, error: `Folder "${safe}" already exists` }
  } catch { /* does not exist — create */ }
  try {
    await fs.mkdir(dir, { recursive: true })
    return { ok: true, name: safe }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** (fix 122) Rename folder. Files and .meta.json sidecars
 *  remain in the folder (it just changes name on disk).
 *  (fix 495) newName without slash = new leaf name (parent preserved);
 *  with slash = full new path (move between levels). Children and nested
 *  folders move along with parent. */
export async function renameGalleryFolder(
  oldName: string,
  newName: string,
): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
  const fromSafe = sanitizeFolderPath(oldName)
  if (!fromSafe) return { ok: false, error: 'Invalid folder name' }
  let toSafe = sanitizeFolderPath(newName)
  if (!toSafe) return { ok: false, error: 'Enter new folder name' }
  if (!toSafe.includes('/')) {
    const parent = fromSafe.includes('/') ? fromSafe.slice(0, fromSafe.lastIndexOf('/')) : ''
    toSafe = parent ? `${parent}/${toSafe}` : toSafe
  }
  if (fromSafe === toSafe) return { ok: true, name: toSafe }
  if (toSafe.startsWith(fromSafe + '/')) {
    return { ok: false, error: 'Cannot move folder inside itself' }
  }
  if (toSafe.split('/').some((s) => s.toLowerCase() === 'latents')) {
    return { ok: false, error: 'Name "latents" is reserved (internal folder)' }
  }
  const srcDir = folderPath(fromSafe)
  const dstDir = folderPath(toSafe)
  try {
    await fs.access(dstDir)
    return { ok: false, error: `Folder "${toSafe}" already exists` }
  } catch { /* destination folder does not exist — ok */ }
  try {
    await fs.mkdir(path.dirname(dstDir), { recursive: true })
    await fs.rename(srcDir, dstDir)
    return { ok: true, name: toSafe }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { ok: false, error: `Folder "${fromSafe}" not found` }
    if (code === 'ENOTEMPTY' || code === 'EEXIST' || code === 'EPERM') {
      return { ok: false, error: `Folder "${toSafe}" already exists` }
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Delete folder (only if empty — videos and subfolders are not silently lost). */
export async function deleteGalleryFolder(name: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const safe = sanitizeFolderPath(name)
  if (!safe) return { ok: false, error: 'Invalid folder name' }
  const dir = folderPath(safe)
  try {
    const entries = await fs.readdir(dir)
    // Orphaned .meta.json sidecars (video deleted externally) are not counted
    // as content — folder with only sidecars can be deleted. Subfolders —
    // are counted: move or delete them first.
    const visible = entries.filter((e) => !e.startsWith('.') && !e.endsWith('.meta.json'))
    if (visible.length > 0) {
      return { ok: false, error: `Folder "${safe}" is not empty (${visible.length} files/folders). Move or delete them.` }
    }
    await fs.rm(dir, { recursive: true })
    return { ok: true }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { ok: true }
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Move output file (along with .meta.json sidecar)
 * between folders. from/to — relative folder paths ('' = root).
 */
export async function moveOutputFile(
  filename: string,
  from: string,
  to: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const safeName = path.basename(String(filename ?? ''))
  if (!safeName || safeName.startsWith('.')) return { ok: false, error: 'Invalid file name' }
  const fromSafe = sanitizeFolderPath(from)
  const toSafe = sanitizeFolderPath(to)
  if (fromSafe === toSafe) return { ok: true }

  const srcDir = folderPath(fromSafe)
  const dstDir = folderPath(toSafe)
  try {
    await fs.mkdir(dstDir, { recursive: true })
    for (const candidate of [safeName, `${safeName}.meta.json`]) {
      const src = path.join(srcDir, candidate)
      const dst = path.join(dstDir, candidate)
      try {
        await fs.rename(src, dst)
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code !== 'ENOENT') throw err // meta might be missing — ok
      }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
