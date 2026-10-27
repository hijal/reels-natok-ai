/**
 * POST /api/models/migrate
 * (fix 47 + fix 64)
 *
 * Data migration from an older version of the program:
 *   - MODELS: recursive search for "models" folder (up to 3 levels) within the selected
 *     folder → all files are moved to the current ComfyUI models folder;
 *   - CONTENT (fix 64): "output" folder (generated videos + .meta.json)
 *     → moved to current output directory. Preview cache (.thumbs/) and
 *     stale pending state (.pending-meta.json) are not migrated;
 *   - CHATS (fix 74): "assistant-chats.json" file (search up to 3 levels)
 *     → merged into current data/assistant-chats.json (existing chats
 *     take precedence, new ones are added). After successful merge, source
 *     file is deleted (move, not copy).
 *
 * Body: { sourceDir: string, items?: { models?, content?, chats?: boolean } }
 * All categories are enabled by default → backwards-compatible with { sourceDir }.
 */
import { NextResponse } from 'next/server'
import { existsSync, statSync, readdirSync, renameSync, copyFileSync, unlinkSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join, relative, dirname, resolve } from 'path'
import { getAppConfig } from '@/lib/app-config'

export const dynamic = 'force-dynamic'

interface CategoryResult {
  enabled: boolean
  found: boolean
  dir: string | null
  /** (fix 74) Source FILE path (for "chats" category). */
  file?: string | null
  moved: number
  skipped: number
  errors: string[]
}

interface MigrateResult {
  models: CategoryResult
  content: CategoryResult
  chats: CategoryResult
}

const DISABLED: CategoryResult = {
  enabled: false,
  found: false,
  dir: null,
  moved: 0,
  skipped: 0,
  errors: [],
}

/**
 * Recursively find a directory named `name` (case-insensitive) up to
 * `maxDepth` levels deep under `startDir`.
 */
function findDirByName(startDir: string, name: string, maxDepth = 3): string | null {
  if (!existsSync(startDir)) return null

  let entries: string[]
  try {
    entries = readdirSync(startDir)
  } catch {
    return null
  }

  for (const entry of entries) {
    const fullPath = join(startDir, entry)
    let st
    try {
      st = statSync(fullPath)
    } catch {
      continue
    }
    if (!st.isDirectory()) continue

    if (entry.toLowerCase() === name) {
      return fullPath
    }

    if (maxDepth > 1) {
      const found = findDirByName(fullPath, name, maxDepth - 1)
      if (found) return found
    }
  }
  return null
}

/**
 * (fix 283) Find ALL directories named `name` (up to maxDepth levels).
 * Returns array of paths (from closest to farthest). Used for
 * models: there may be multiple models folders (root with bonsai +
 * ComfyUI/models with main models) — both need to be merged.
 */
function findAllDirByName(startDir: string, name: string, maxDepth = 3): string[] {
  const results: string[] = []
  if (!existsSync(startDir)) return results

  let entries: string[]
  try {
    entries = readdirSync(startDir)
  } catch {
    return results
  }

  for (const entry of entries) {
    const fullPath = join(startDir, entry)
    let st
    try {
      st = statSync(fullPath)
    } catch {
      continue
    }
    if (!st.isDirectory()) continue

    if (entry.toLowerCase() === name) {
      results.push(fullPath)
    }

    if (maxDepth > 1) {
      const found = findAllDirByName(fullPath, name, maxDepth - 1)
      results.push(...found)
    }
  }
  return results
}

/**
 * (fix 64) Find generated content directory of an old installation:
 * priority — <...>/ComfyUI/output (standard layout
 * ComfyUI-Easy-Install/ComfyUI/output), then any "output" folder (up to 3 levels).
 */
function findContentDir(startDir: string): string | null {
  const comfyDir = findDirByName(startDir, 'comfyui', 3)
  if (comfyDir) {
    const out = join(comfyDir, 'output')
    try {
      if (existsSync(out) && statSync(out).isDirectory()) return out
    } catch {
      /* unreadable — proceed to fallback */
    }
  }
  return findDirByName(startDir, 'output', 3)
}

/**
 * Recursively collect all file relative paths from a directory.
 */
function collectFiles(dir: string, baseDir: string = dir): string[] {
  const results: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return results
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry)
    let st
    try {
      st = statSync(fullPath)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      results.push(...collectFiles(fullPath, baseDir))
    } else if (st.isFile()) {
      results.push(relative(baseDir, fullPath))
    }
  }
  return results
}

/**
 * Move a file, handling cross-drive moves (copy + unlink).
 * (fix 279) Cross-volume: if unlinkSync fails (file busy), throw
 * error — file is copied, but not deleted. Caller records in errors.
 */
function moveFile(src: string, dest: string): void {
  // (fix 587) Extract drive letter via regex from both paths; if any
  // path has NO drive letter (UNC \\server\share or garbage) — treat as cross-volume:
  // old split('\\')[0] check for UNC yielded '' on both sides, copy branch
  // was skipped, renameSync failed with EXDEV and each file
  // ended up in errors, even though copy+delete would have succeeded.
  const driveOf = (p: string) => (/^([a-zA-Z]):/.exec(p)?.[1] || '').toLowerCase()
  const srcDrive = driveOf(src)
  const destDrive = driveOf(dest)

  if (srcDrive !== destDrive || !srcDrive) {
    // Cross-drive: copy then delete source
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(src, dest)
    try {
      unlinkSync(src)
    } catch (err) {
      throw new Error(`Cross-volume: file copied, but not deleted (locked by another process?): ${err instanceof Error ? err.message : String(err)}`)
    }
  } else {
    // Same drive: rename (atomic on NTFS)
    mkdirSync(dirname(dest), { recursive: true })
    renameSync(src, dest)
  }
}

/** (fix 64) Items to exclude from old output. */
function isExcludedContent(rel: string): boolean {
  const norm = rel.split('\\').join('/')
  return norm.startsWith('.thumbs/') || norm === '.pending-meta.json'
}

/**
 * (fix 64) Generic migration of a single category: files from foundDir → targetRoot
 * preserving structure. Existing destination files are skipped.
 */
function runMigrate(
  targetRoot: string,
  foundDir: string | null,
  notFoundMsg: string,
  emptyMsg: string,
  exclude?: (rel: string) => boolean,
): CategoryResult {
  if (!foundDir) {
    return { enabled: true, found: false, dir: null, moved: 0, skipped: 0, errors: [notFoundMsg] }
  }

  let files = collectFiles(foundDir)
  if (exclude) files = files.filter((f) => !exclude(f))

  if (files.length === 0) {
    return { enabled: true, found: true, dir: foundDir, moved: 0, skipped: 0, errors: [emptyMsg] }
  }

  let moved = 0
  let skipped = 0
  const errors: string[] = []

  for (const relPath of files) {
    const srcFile = join(foundDir, relPath)
    const destFile = join(targetRoot, relPath)

    try {
      if (existsSync(destFile)) {
        // Already exists — skip
        skipped++
        continue
      }
      moveFile(srcFile, destFile)
      moved++
    } catch (err) {
      errors.push(`Error migrating ${relPath}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return { enabled: true, found: true, dir: foundDir, moved, skipped, errors }
}

/**
 * (fix 283) Migration from MULTIPLE folders (models: root + ComfyUI/models).
 * Files from all folders are merged and migrated to targetRoot.
 */
function runMigrateMulti(
  targetRoot: string,
  foundDirs: string[],
  emptyMsg: string,
): CategoryResult {
  let totalMoved = 0
  let totalSkipped = 0
  const errors: string[] = []
  let totalFiles = 0

  for (const foundDir of foundDirs) {
    const files = collectFiles(foundDir)
    totalFiles += files.length

    for (const relPath of files) {
      const srcFile = join(foundDir, relPath)
      const destFile = join(targetRoot, relPath)

      try {
        if (existsSync(destFile)) {
          totalSkipped++
          continue
        }
        moveFile(srcFile, destFile)
        totalMoved++
      } catch (err) {
        errors.push(`Error migrating ${relPath} (from ${foundDir}): ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  if (totalFiles === 0) {
    return { enabled: true, found: true, dir: foundDirs[0] ?? null, moved: 0, skipped: 0, errors: [emptyMsg] }
  }

  return { enabled: true, found: true, dir: foundDirs[0] ?? null, moved: totalMoved, skipped: totalSkipped, errors }
}

/* ─── (fix 74) Assistant chats: migration from older version file ─── */
interface ChatLike {
  id: string
  title?: string
  createdAt?: number
  updatedAt?: number
  messages?: Array<{ role: string; content: string }>
}

function isValidChat(c: unknown): c is ChatLike {
  if (!c || typeof c !== 'object') return false
  const chat = c as ChatLike
  return typeof chat.id === 'string' && chat.id.length > 0 && Array.isArray(chat.messages)
}

function currentChatsFile(): string {
  return join(process.cwd(), 'data', 'assistant-chats.json')
}

/**
 * (fix 74) Find assistant chats file in old installation:
 * "assistant-chats.json" (case-insensitive, up to 3 levels deep).
 */
function findChatsFile(startDir: string, maxDepth = 3): string | null {
  if (!existsSync(startDir)) return null
  let rootSt
  try {
    rootSt = statSync(startDir)
  } catch {
    return null
  }
  if (!rootSt.isDirectory()) return null

  let entries: string[]
  try {
    entries = readdirSync(startDir)
  } catch {
    return null
  }
  for (const entry of entries) {
    const fullPath = join(startDir, entry)
    let entrySt
    try {
      entrySt = statSync(fullPath)
    } catch {
      continue
    }
    if (entrySt.isFile() && entry.toLowerCase() === 'assistant-chats.json') {
      return fullPath
    }
    if (entrySt.isDirectory() && maxDepth > 1) {
      const found = findChatsFile(fullPath, maxDepth - 1)
      if (found) return found
    }
  }
  return null
}

/**
 * (fix 74) Merge old version chats file into current data/assistant-chats.json:
 * existing chats (by id) take precedence, new ones are added. After successful
 * merge the source file is deleted (move, not copy).
 */
function migrateChats(srcFile: string): CategoryResult {
  const dest = currentChatsFile()
  // (fix 338) Strict guard: source = current chats file. POST already
  // rejects such sourceDir, but findChatsFile searches recursively (3 levels) —
  // if sourceDir is an ancestor of the project (e.g. current project folder itself),
  // the CURRENT data/assistant-chats.json could be found, and unlinkSync below
  // would delete active chats after "merging file into itself".
  if (resolve(srcFile).toLowerCase() === resolve(dest).toLowerCase()) {
    return {
      enabled: true, found: false, dir: null, file: srcFile,
      moved: 0, skipped: 0,
      errors: ['Source is identical to current chats file — migration skipped.'],
    }
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(srcFile, 'utf-8'))
    let srcChats: unknown[] | null
    if (Array.isArray(parsed)) {
      srcChats = parsed
    } else if (
      parsed &&
      typeof parsed === 'object' &&
      Array.isArray((parsed as { chats?: unknown }).chats)
    ) {
      srcChats = (parsed as { chats: unknown[] }).chats
    } else {
      srcChats = null
    }
    if (!srcChats) {
      return {
        enabled: true, found: true, dir: null, file: srcFile,
        moved: 0, skipped: 0,
        errors: ['File does not contain a chats list.'],
      }
    }
    const validSrc = srcChats.filter(isValidChat)

    // Current chats (if any)
    let curChats: ChatLike[] = []
    let curActive: string | null = null
    if (existsSync(dest)) {
      try {
        const cur = JSON.parse(readFileSync(dest, 'utf-8'))
        if (cur && Array.isArray(cur.chats)) curChats = cur.chats.filter(isValidChat)
        if (cur && typeof cur.activeChatId === 'string') curActive = cur.activeChatId
      } catch {
        /* corrupted file — start anew (old chats will remain in browser cache) */
      }
    }

    const curIds = new Set(curChats.map((c) => c.id))
    const added = validSrc.filter((c) => !curIds.has(c.id))
    const merged = [...curChats, ...added]
    const activeChatId =
      curActive && merged.some((c) => c.id === curActive) ? curActive : (merged[0]?.id ?? null)

    const dataDir = dirname(dest)
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
    writeFileSync(dest, JSON.stringify({ chats: merged, activeChatId }, null, 2), 'utf-8')

    // Migration = move: delete source file after successful write
    // (fix 279) If unlinkSync fails (file busy), record in errors —
    // data is migrated, but source file remains (copy, not move).
    try {
      unlinkSync(srcFile)
    } catch (err) {
      return {
        enabled: true, found: true, dir: null, file: srcFile,
        moved: added.length,
        skipped: validSrc.length - added.length,
        errors: [`Chats migrated, but source file could not be deleted (locked by another process?): ${err instanceof Error ? err.message : String(err)}`],
      }
    }

    return {
      enabled: true, found: true, dir: null, file: srcFile,
      moved: added.length,
      skipped: validSrc.length - added.length,
      errors: [],
    }
  } catch (err) {
    return {
      enabled: true, found: true, dir: null, file: srcFile,
      moved: 0, skipped: 0,
      errors: [`Error reading/migrating chats: ${err instanceof Error ? err.message : String(err)}`],
    }
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      sourceDir?: string
      items?: { models?: boolean; content?: boolean; chats?: boolean }
    }
    const sourceDir = (body.sourceDir || '').trim()

    if (!sourceDir) {
      return NextResponse.json(
        { error: 'Specify path to older version folder.' },
        { status: 400 }
      )
    }

    // (fix 135) Ensure it is a directory, not a file.
    // Previously if user specified a file — existsSync returned true, and code
    // attempted to search subfolders inside it → unexpected behavior.
    if (!existsSync(sourceDir)) {
      return NextResponse.json(
        { error: `Folder not found: ${sourceDir}` },
        { status: 400 }
      )
    }
    if (!statSync(sourceDir).isDirectory()) {
      return NextResponse.json(
        { error: `Specified path is a file, not a directory: ${sourceDir}` },
        { status: 400 }
      )
    }

    // (fix 135) Guard against migrating folder into itself.
    // If sourceDir matches any target — error.
    // (fix 279) Added check for chats file — if sourceDir contains
    // current data/assistant-chats.json, migrateChats will delete it after
    // merge → data loss.
    const cfg = getAppConfig()
    const modelsTarget = join(cfg.comfyRoot, 'ComfyUI', 'models')
    const contentTarget = cfg.outputDir
    const chatsTarget = currentChatsFile()
    const targets = [modelsTarget, contentTarget].map((p) => p.toLowerCase().replace(/\\/g, '/'))
    const srcLower = sourceDir.toLowerCase().replace(/\\/g, '/')
    for (const t of targets) {
      if (srcLower === t || srcLower.startsWith(t + '/')) {
        return NextResponse.json(
          { error: `Cannot migrate folder into itself: ${sourceDir}` },
          { status: 400 }
        )
      }
    }
    // (fix 279) Protection against deleting current chats file
    const chatsLower = chatsTarget.toLowerCase().replace(/\\/g, '/')
    if (srcLower === dirname(chatsLower) || srcLower.startsWith(dirname(chatsLower) + '/')) {
      return NextResponse.json(
        { error: `Cannot migrate folder containing current chats file: ${sourceDir}` },
        { status: 400 }
      )
    }
    // (fix 338) And vice-versa: sourceDir is an ANCESTOR of current data/ (user
    // specified current version folder or its parent). Recursive
    // findChatsFile would find live assistant-chats.json inside, and migrateChats
    // would delete it after merging "into itself" → loss of all chats.
    if (chatsLower === srcLower + '/assistant-chats.json' || chatsLower.startsWith(srcLower + '/')) {
      return NextResponse.json(
        { error: `Cannot migrate data from current version program folder: ${sourceDir}` },
        { status: 400 }
      )
    }
    // (release) sourceDir is an ANCESTOR of live models folder.
    //
    // findAllDirByName(sourceDir, 'models', 3) looks for ANY folder named
    // 'models' 3 levels down. If user specified project root
    // (or its parent), the REAL models folder of the current
    // version would be matched — and migration would start operating on live files
    // instead of a copy of the old version. Check "sourceDir == target or inside it" does not
    // catch this: only target itself and its subfolders are prohibited, not ancestors.
    //
    // Consequence — live models move out of ComfyUI\models, leaving studio
    // without weights. Therefore, an ancestor of live models folder is rejected
    // explicitly with a clear message.
    if (modelsTarget.toLowerCase().replace(/\\/g, '/').startsWith(srcLower + '/')) {
      return NextResponse.json(
        {
          error:
            `Specified folder contains the current models folder (${modelsTarget}). ` +
            `Migrating from there would remove active models from the program. Specify the folder containing the OLD version.`,
        },
        { status: 400 }
      )
    }

    // Categories enabled by default — legacy client
    // sending only { sourceDir } migrates models, content, and chats.
    const wantModels = body.items?.models !== false
    const wantContent = body.items?.content !== false
    const wantChats = body.items?.chats !== false

    // (fix 283) Models: multiple models folders may exist (root +
    // ComfyUI/models). Find all and combine their contents.
    const modelsDirs = findAllDirByName(sourceDir, 'models', 3)
    const models: CategoryResult = wantModels
      ? modelsDirs.length > 0
        ? runMigrateMulti(modelsTarget, modelsDirs,
            'Folders "models" found, but contain no files.')
        : { enabled: true, found: false, dir: null, moved: 0, skipped: 0, errors: ['Folder "models" (models) not found in specified directory (search up to 3 levels deep).'] }
      : DISABLED

    const content: CategoryResult = wantContent
      ? runMigrate(
          contentTarget,
          findContentDir(sourceDir),
          'Folder "output" (generated videos) not found in specified directory (search up to 3 levels deep).',
          'Folder "output" found, but contains no files.',
          isExcludedContent,
        )
      : DISABLED

    const chatsFile = wantChats ? findChatsFile(sourceDir) : null
    const chats: CategoryResult = wantChats
      ? chatsFile
        ? migrateChats(chatsFile)
        : {
            enabled: true,
            found: false,
            dir: null,
            moved: 0,
            skipped: 0,
            errors: ['File "assistant-chats.json" (assistant chats) not found in specified directory (search up to 3 levels deep).'],
          }
      : DISABLED

    const result: MigrateResult = { models, content, chats }
    return NextResponse.json(result)
  } catch (err) {
    return NextResponse.json(
      { error: `Internal error: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    )
  }
}
