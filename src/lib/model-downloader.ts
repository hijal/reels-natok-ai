/**
 * Model download manager — streams files from HuggingFace to disk,
 * tracks progress, and supports status queries.
 */
import { createWriteStream, existsSync, mkdirSync, unlinkSync, statSync, statfsSync } from 'fs'
import { dirname, join } from 'path'
import { Readable } from 'stream'
import { MODELS, type ModelDef } from './models-config'
import { getAppConfig } from './app-config'

export interface DownloadState {
  modelId: string
  status: 'downloading' | 'done' | 'error' | 'cancelled'
  bytesReceived: number
  totalBytes: number | null
  speed: number // bytes/sec
  error?: string
  startedAt: number
}

const activeDownloads = new Map<string, DownloadState>()
const abortControllers = new Map<string, AbortController>()

/* (fix 136) Parallel downloading with concurrency limit.
 *
 * Previously: all models were downloaded concurrently (fast, but disk and network
 * choked, failure rate grew).
 * Then: sequentially (stable, but slow).
 * Now: up to MAX_CONCURRENT concurrent downloads (fast + stable).
 *
 * MAX_CONCURRENT = 3 — optimum for most connections and drives.
 * If network/disk are slow — can be decreased to 2; if powerful — up to 5. */
const MAX_CONCURRENT = 3
let activeCount = 0
let queue: Array<() => Promise<void>> = []

function enqueueDownload(run: () => Promise<void>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const task = async () => {
      try {
        await run()
        resolve()
      } catch (e) {
        reject(e)
      } finally {
        activeCount--
        // Start next task from queue, if any
        if (queue.length > 0 && activeCount < MAX_CONCURRENT) {
          const next = queue.shift()!
          activeCount++
          next()
        }
      }
    }
    
    if (activeCount < MAX_CONCURRENT) {
      activeCount++
      task()
    } else {
      queue.push(task)
    }
  })
}

/** Resolve absolute path for a model file */
function modelAbsPath(model: ModelDef): string {
  const cfg = getAppConfig()
  // (fix 138) Bonsai files live in their own build folder (<bonsai_dir>),
  // not in ComfyUI models. Engine's relPath is directory ('llama.cpp/').
  if (model.target === 'bonsai') {
    return join(cfg.llmBonsaiDir, model.relPath)
  }
  // (fix 269) Custom root directory — for custom node models
  // that look for files NOT in ComfyUI/models (e.g. VFI: ckpts/ in
  // ComfyUI-Frame-Interpolation folder). baseDir can be absolute or
  // relative to cwd (project directory).
  if (model.target === 'custom' && model.baseDir) {
    // (fix 269) baseDir: absolute (E:\...) or relative to
    // comfyRoot (ComfyUI-Easy-Install/...) or to cwd (project).
    const isAbsolute = model.baseDir.startsWith('/')
      || model.baseDir.startsWith('\\')
      || /^[a-zA-Z]:[\\/]/.test(model.baseDir)
    // (fix 507) If directory exists in neither place (first download — node
    // has not yet created its ckpts), resolve from comfyRoot, NOT from cwd:
    // otherwise downloader created extra folder <project>/ComfyUI/... next to
    // real ComfyUI-Easy-Install and placed model there.
    const base = isAbsolute
      ? model.baseDir
      : (existsSync(join(cfg.comfyRoot, model.baseDir))
          ? join(cfg.comfyRoot, model.baseDir)
          : existsSync(join(process.cwd(), model.baseDir))
            ? join(process.cwd(), model.baseDir)
            : join(cfg.comfyRoot, model.baseDir))
    return join(base, model.relPath)
  }
  return join(cfg.comfyRoot, 'ComfyUI', 'models', model.relPath)
}

/** (fix 505) Size check: file is close to expected (±10%) */
function sizeOk(abs: string, expected: number): boolean {
  try {
    const stat = statSync(abs)
    const tolerance = Math.max(1_000_000, expected * 0.1)
    return stat.size >= expected - tolerance && stat.size <= expected + tolerance
  } catch {
    return false
  }
}

/** Check if a model file already exists (and has reasonable size) */
export function modelExists(modelId: string): boolean {
  const model = MODELS.find(m => m.id === modelId)
  if (!model) return false
  try {
    // (fix 138) zip entries (Bonsai engine): "ready" = all required files
    // are extracted; zip size check is inapplicable here.
    if (model.extractFiles) {
      const dir = modelAbsPath(model)
      return model.extractFiles.every(f => existsSync(join(dir, f)))
    }
    const abs = modelAbsPath(model)
    if (existsSync(abs) && sizeOk(abs, model.sizeBytes)) return true
    // (fix 505) Check external model directories (extra paths) — if
    // user specified custom models folder, file may be located there.
    // relPath like 'vae/xxx.safetensors' → category='vae', file='xxx.safetensors'.
    // Preserve SUBPATH inside category: for models with subfolder
    // ('llm/qwen3.5-9b/xxx.gguf') file in external folder is stored as
    // 'qwen3.5-9b/xxx.gguf' — searching by filename only failed to find it.
    const parts = model.relPath.split('/')
    if (parts.length >= 2) {
      const categoryDir = parts[0]
      const fileName = parts[parts.length - 1]
      const subPath = parts.slice(1).join('/')
      const cfg = getAppConfig()
      const externalDirs = (cfg.modelExtraPaths || [])
        .filter(e => e.category === categoryDir)
        .map(e => e.path)
      for (const extDir of externalDirs) {
        // First try full subpath (as seen by ComfyUI), then — filename only.
        for (const candidate of subPath !== fileName ? [subPath, fileName] : [fileName]) {
          const extPath = join(extDir, ...candidate.split('/'))
          if (existsSync(extPath) && sizeOk(extPath, model.sizeBytes)) return true
        }
      }
    }
    return false
  } catch {
    return false
  }
}

/**
 * (fix 138) Extract SELECTED files from zip (Bonsai engine from GitHub).
 * Extraction via PowerShell Expand-Archive into temp folder + recursive
 * search for required files — independent of archive internal directory layout.
 */
async function extractZipFiles(zipPath: string, targetDir: string, fileNames: string[]): Promise<void> {
  const { mkdtempSync, readdirSync, copyFileSync, rmSync } = await import('fs')
  const { execFile } = await import('child_process')
  const { promisify } = await import('util')
  const execFileAsync = promisify(execFile)
  const tmpDir = mkdtempSync(join(dirname(zipPath), 'unzip_'))
  try {
    const psZip = zipPath.replace(/'/g, "''")
    const psDir = tmpDir.replace(/'/g, "''")
    await execFileAsync(
      'powershell',
      ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${psZip}' -DestinationPath '${psDir}' -Force`],
      { timeout: 600_000, windowsHide: true },
    )
    const found = new Map<string, string>()
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if ((fileNames as string[]).includes(e.name) && !found.has(e.name)) found.set(e.name, p)
      }
    }
    walk(tmpDir)
    const missing = fileNames.filter(f => !found.has(f))
    if (missing.length > 0) {
      throw new Error(`Archive is missing files: ${missing.join(', ')}`)
    }
    mkdirSync(targetDir, { recursive: true })
    for (const f of fileNames) copyFileSync(found.get(f)!, join(targetDir, f))
    // zip is deleted ONLY after successful extraction (in calling code):
    // on Extract-Archive failure saved zip allows resuming/retrying,
    // rather than re-downloading hundreds of megabytes.
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

/** Get status for all models */
export function getAllModelsStatus() {
  return MODELS.map(model => {
    // (fix 162) optional: true — model is optional (banner does not require it)
    const optional = model.optional === true
    const active = activeDownloads.get(model.id)
    if (active && active.status === 'downloading') {
      return {
        id: model.id,
        label: model.label,
        relPath: model.relPath,
        sizeLabel: model.sizeLabel,
        category: model.category,
        status: 'downloading' as const,
        bytesReceived: active.bytesReceived,
        totalBytes: active.totalBytes,
        speed: active.speed,
        optional,
      }
    }
    const exists = modelExists(model.id)
    if (exists) {
      return {
        id: model.id,
        label: model.label,
        relPath: model.relPath,
        sizeLabel: model.sizeLabel,
        category: model.category,
        status: 'ready' as const,
        optional,
      }
    }
    if (active?.status === 'error') {
      return {
        id: model.id,
        label: model.label,
        relPath: model.relPath,
        sizeLabel: model.sizeLabel,
        category: model.category,
        status: 'error' as const,
        error: active.error,
        optional,
      }
    }
    if (active?.status === 'cancelled') {
      activeDownloads.delete(model.id)
    }
    return {
      id: model.id,
      label: model.label,
      relPath: model.relPath,
      sizeLabel: model.sizeLabel,
      category: model.category,
      status: 'missing' as const,
      optional,
    }
  })
}

const BONSAI_DOWNLOAD_BUNDLES: Record<string, readonly string[]> = {
  llm_assistant_bonsai: ['bonsai_engine_bin', 'bonsai_engine_cudart', 'bonsai_model', 'bonsai_mmproj'],
  llm_assistant_bonsai_light: ['bonsai_engine_bin', 'bonsai_engine_cudart', 'bonsai_model_light', 'bonsai_mmproj'],
}

/** Start downloading a model. Returns immediately; progress via getAllModelsStatus(). */
export async function startDownload(modelId: string): Promise<{ ok: boolean; error?: string }> {
  const bundle = BONSAI_DOWNLOAD_BUNDLES[modelId]
  if (bundle) {
    for (const bundledId of bundle) {
      const result = await startDownload(bundledId)
      const alreadyHandled = result.error === 'Download already in progress' || result.error === 'File already exists'
      if (!result.ok && !alreadyHandled) return result
    }
    return { ok: true }
  }

  const model = MODELS.find(m => m.id === modelId)
  if (!model) return { ok: false, error: 'Unknown model' }

  // Already downloading?
  const existing = activeDownloads.get(modelId)
  if (existing?.status === 'downloading') {
    return { ok: false, error: 'Download already in progress' }
  }

  // Already exists?
  if (modelExists(modelId)) {
    return { ok: false, error: 'File already exists' }
  }

  const absPath = modelAbsPath(model)
  // Zip entries in same folder receive distinct temporary names: concurrent
  // engine and CUDA archives should not overwrite and unpack each other.
  // .zip suffix is required for PowerShell Expand-Archive.
  const tmpPath = absPath + (model.extractFiles ? `_${model.id}_tmp.zip` : '.downloading')

  // Pre-flight free disk space check: previously a 21 GB
  // model failed with generic write error at the end, rather than a clear error.
  try {
    const dir = dirname(tmpPath)
    mkdirSync(dir, { recursive: true })
    // statfsSync might be missing in older runtimes — wrapped in try
    const fsStat = statfsSync(dir)
    const free = BigInt(fsStat.bavail) * BigInt(fsStat.bsize)
    const needed = BigInt(Math.ceil(model.sizeBytes))
    if (free < needed) {
      return {
        ok: false,
        error: `Insufficient disk space: free ${(Number(free) / 1024 ** 3).toFixed(1)} GB, required ~${(model.sizeBytes / 1024 ** 3).toFixed(1)} GB`,
      }
    }
  } catch {
    /* statfs unavailable — don't block download */
  }

  // Do NOT delete partial file: resume (Range) instead of starting from scratch —
  // for 21 GB model connection drops previously meant restarting from 0.
  let resumeBytes = 0
  try {
    if (existsSync(tmpPath)) resumeBytes = statSync(tmpPath).size
  } catch { /* ignore */ }

  // Create target directory
  try { mkdirSync(dirname(tmpPath), { recursive: true }) } catch (e) {
    return { ok: false, error: `Cannot create directory: ${e instanceof Error ? e.message : String(e)}` }
  }

  // Initialize state
  const state: DownloadState = {
    modelId,
    status: 'downloading',
    bytesReceived: resumeBytes,
    totalBytes: null,
    speed: 0,
    startedAt: Date.now(),
  }
  activeDownloads.set(modelId, state)

  // Create abort controller for cancellation
  const controller = new AbortController()
  abortControllers.set(modelId, controller)

  // Run download in background (don't await), serialized
  // Use doDownloadWithRetry — automatic retries on
  // network failures (2 attempts with exponential backoff)
  // (fix 337) .catch is required: doDownload now re-throws errors
  // (otherwise retries didn't work), and final reject without handler gave
  // unhandledRejection. Error text is already recorded in state — just suppress here.
  void enqueueDownload(() => doDownloadWithRetry(model, tmpPath, absPath, state, controller, resumeBytes))
    .catch(() => { /* error already in state.error */ })

  return { ok: true }
}

/**
 * Retries on network failures. Previously a single network drop = user
 * had to manually click "Download" again. Now automatically
 * retry 2 times with exponential backoff (1s, 2s).
 */
async function doDownloadWithRetry(
  model: ModelDef,
  tmpPath: string,
  finalPath: string,
  state: DownloadState,
  controller: AbortController,
  resumeBytes: number,
  maxRetries = 2,
): Promise<void> {
  let lastError: Error | null = null

  // (fix 337) Abort controller lives until all retries finish.
  try {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        // Exponential backoff: 1s, 2s
        const delay = Math.pow(2, attempt - 1) * 1000
        await new Promise(r => setTimeout(r, delay))
        // Update resumeBytes — file might have grown
        try {
          resumeBytes = statSync(tmpPath).size
        } catch {
          resumeBytes = 0
        }
        // (fix 587) Rebase progress to actual file size on disk: in interrupted
        // attempt state.bytesReceived counted network chunks and could run ahead
        // of uncommitted bytes on disk — without reset progress exceeded 100%.
        // lastBytes in doDownload starts from state.bytesReceived (fix 350).
        state.bytesReceived = resumeBytes
      }
      
      await doDownload(model, tmpPath, finalPath, state, controller, resumeBytes)
      return // Success — exit
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e))
      
      // User cancellation — do not retry
      if (lastError.message === 'cancelled' || lastError.name === 'AbortError') {
        throw lastError
      }
      
      // 404 — model not found, retries useless
      if (lastError.message.includes('404')) {
        throw lastError
      }
      
      // If this is the last retry — re-throw error
      if (attempt === maxRetries) {
        throw lastError
      }

      // (fix 337) Between retries revert status to 'downloading':
      // doDownload already set 'error' in state, but attempt is not the last —
      // UI should not show failure until all retries are exhausted.
      state.status = 'downloading'
      delete state.error

      // Otherwise — try again
    }
  }

  throw lastError || new Error('Unknown error')
  } finally {
    abortControllers.delete(model.id)
  }
}

async function doDownload(
  model: ModelDef,
  tmpPath: string,
  finalPath: string,
  state: DownloadState,
  controller: AbortController,
  resumeBytes: number,
) {
  const { renameSync } = await import('fs')
  
  // Logging — previously on error it wasn't clear at what stage
  // download failed. Now key stages are logged to console.
  console.log(`[download] START: ${model.label} (${model.sizeLabel})`)
  if (resumeBytes > 0) {
    console.log(`[download] Resume: ${(resumeBytes / 1024 ** 3).toFixed(2)} GB already downloaded`)
  }
  
  try {
    // Range-resume if partial file exists (HuggingFace supports it)
    // On 416 Range Not Satisfiable — server says such
    // position in file does not exist (file updated, URL changed, different hash).
    // Delete partial file and start fresh — otherwise we loop.
    const headers: Record<string, string> = { 'User-Agent': 'MiniMaxH3Studio/1.0' }
    let skip = 0
    if (resumeBytes > 0) {
      headers['Range'] = `bytes=${resumeBytes}-`
      skip = resumeBytes
    }
    
    let res = await fetch(model.url, { headers, signal: controller.signal })
    
    // 404 — model deleted or URL changed. Dedicated message
    // so user understands this is not a transient network glitch.
    if (res.status === 404) {
      throw new Error('Model not found on HuggingFace (404). URL may have changed or model was deleted. Check models-config.ts.')
    }
    
    // (fix 142) 416 Range Not Satisfiable — partial file does not match
    // current server file, or server doesn't support Range.
    // Previously: tried to resume. Now: delete and start fresh — more reliable.
    if (res.status === 416 && resumeBytes > 0) {
      console.log(`[download] 416: deleting partial file and starting fresh`)
      try {
        unlinkSync(tmpPath)
      } catch { /* ignore */ }
      resumeBytes = 0
      skip = 0
      delete headers['Range']
      state.bytesReceived = 0
      // Retry request without Range
      res = await fetch(model.url, { headers, signal: controller.signal })
    }
    
    if (!res.ok && !(res.status === 206 && resumeBytes > 0)) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`)
    }
    // Server ignored Range (200 instead of 206) — write from scratch
    if (resumeBytes > 0 && res.status !== 206) {
      skip = 0
      state.bytesReceived = 0
    }

    // Get total size
    const contentLength = res.headers.get('content-length')
    if (contentLength) {
      state.totalBytes = parseInt(contentLength, 10) + skip
    }

    const body = res.body
    if (!body) throw new Error('No response body')

    // Read from web stream, write to file (append on resume)
    const nodeStream = Readable.fromWeb(body as any)
    const fileStream = createWriteStream(tmpPath, { flags: skip > 0 ? 'a' : 'w' })

    let lastTime = Date.now()
    // (fix 350) On resume lastBytes must start from already
    // downloaded volume: otherwise first speed calculation divided whole resumeFrom
    // by 0.5s and showed a huge speed spike.
    let lastBytes = state.bytesReceived

    nodeStream.on('data', (chunk: Buffer) => {
      state.bytesReceived += chunk.length
      // Calculate speed every ~500ms
      const now = Date.now()
      if (now - lastTime >= 500) {
        // bytesReceived already includes current chunk (line above) — don't double count
        state.speed = (state.bytesReceived - lastBytes) / ((now - lastTime) / 1000)
        lastBytes = state.bytesReceived
        lastTime = now
      }
    })

    await new Promise<void>((resolve, reject) => {
      nodeStream.pipe(fileStream)
      fileStream.on('finish', () => {
        console.log(`[download] File stream finished: ${model.label}`)
        resolve()
      })
      // ENOSPC — disk ran out of space during download. Previously generic error
      // left user confused about needing to free up space.
      fileStream.on('error', (err: any) => {
        console.error(`[download] File stream error: ${model.label}`, err.message)
        if (err.code === 'ENOSPC') {
          reject(new Error('Disk ran out of space during download. Free up space and click "Download" again — download will resume from where it stopped.'))
        } else {
          reject(err)
        }
      })
      nodeStream.on('error', (err: any) => {
        console.error(`[download] Node stream error: ${model.label}`, err.message)
        reject(err)
      })
      // If aborted, destroy the file stream
      controller.signal.addEventListener('abort', () => {
        console.log(`[download] Aborted: ${model.label}`)
        fileStream.destroy()
        nodeStream.destroy()
        reject(new Error('cancelled'))
      })
    })

    // Final size validation: truncated file (>1 MB, but incomplete)
    // was previously considered "ready" and failed later in ComfyUI on load.
    // (fix 351) Threshold unified with modelExists (~line 111): file is valid
    // if ≥ 90% of expected size is downloaded (HuggingFace sometimes closes
    // connection at end, last megabytes don't arrive, but file is practically
    // complete). Previously there was a different threshold (1% + separate 90% check) —
    // two conflicting "ready" criteria for the same file.
    try {
      const finalSize = statSync(tmpPath).size
      const completion = model.sizeBytes > 0 ? finalSize / model.sizeBytes : 1
      if (model.sizeBytes > 1_000_000 && completion < 0.9) {
        throw new Error(
          `File downloaded incompletely (${(finalSize / 1024 ** 3).toFixed(2)} GB of ${(model.sizeBytes / 1024 ** 3).toFixed(2)} GB) — click "Download" again`,
        )
      }
      if (completion < 1) {
        console.log(`[download] File ${Math.round(completion * 100)}% complete — accepting as valid`)
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes('incompletely')) throw e
      /* stat failed — don't block */
    }

    // Move tmp → final
    // renameSync can fail (permissions, inode exhaustion) — previously
    // error was unhandled and state.status remained 'downloading' forever.
    // (fix 138) zip entries (Bonsai engine): instead of rename — extract
    // selected files to target folder, zip is deleted.
    if (model.extractFiles) {
      console.log(`[download] Extracting ${model.extractFiles.length} files from zip: ${model.label}`)
      mkdirSync(dirname(finalPath), { recursive: true })
      await extractZipFiles(tmpPath, finalPath, model.extractFiles)
      try { unlinkSync(tmpPath) } catch { /* already deleted */ }
    } else {
      console.log(`[download] Renaming: ${tmpPath} → ${finalPath}`)
      try {
        renameSync(tmpPath, finalPath)
      } catch (e) {
        throw new Error(`Failed to rename file: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    state.status = 'done'
    state.speed = 0
    console.log(`[download] DONE: ${model.label}`)
    // "done" entries are never read (status checked from disk) — remove,
    // otherwise map grows all session.
    activeDownloads.delete(model.id)
  } catch (e) {
    const isCancel = e instanceof Error && (e.message === 'cancelled' || e.name === 'AbortError')
    state.status = isCancel ? 'cancelled' : 'error'
    state.error = isCancel ? 'Cancelled by user' : (e instanceof Error ? e.message : String(e))
    state.speed = 0
    // Error logging — previously on failure what happened wasn't clear
    console.error(`[download] ${isCancel ? 'CANCELLED' : 'ERROR'}: ${model.label}`)
    if (!isCancel) {
      console.error(`[download] Error: ${state.error}`)
    }
    // Partial file is PRESERVED: repeated download will resume from drop point,
    // rather than restarting 21 GB from scratch. Complete file after validation is already renamed.
    // (fix 337) RE-THROW error: previously catch swallowed it, and
    // doDownloadWithRetry considered attempt successful — retries were dead code.
    // Status/error in state are already set above; doDownloadWithRetry will decide
    // whether to retry (and reset status to 'downloading') or if this is final failure.
    throw e
  } finally {
    // (fix 337) Controller is deleted by doDownloadWithRetry (after ALL attempts):
    // otherwise after first failed retry user cancellation ceased
    // working — abortControllers was already empty.
  }
}

/** Cancel an active download. */
export function cancelDownload(modelId: string): { ok: boolean; error?: string } {
  const controller = abortControllers.get(modelId)
  if (!controller) {
    return { ok: false, error: 'No active download' }
  }
  // Abort applies to tasks still in queue: doDownload will see
  // already cancelled signal on very first fetch and complete as "cancelled".
  controller.abort()
  return { ok: true }
}

/**
 * (fix 139) Delete downloaded model files (free space when
 * model is no longer needed — e.g. alternative was chosen). Also clears tails
 * of incomplete downloads (.downloading / _tmp.zip). Guard "do not delete active
 * assistant model" lives in /api/models/delete route — config is visible there.
 */
export function deleteModel(modelId: string): { ok: boolean; error?: string } {
  const model = MODELS.find(m => m.id === modelId)
  if (!model) return { ok: false, error: 'Unknown model' }
  const active = activeDownloads.get(modelId)
  if (active?.status === 'downloading') {
    return { ok: false, error: 'Download is still in progress — cancel it first' }
  }
  const absPath = modelAbsPath(model)
  try {
    if (model.extractFiles) {
      // zip entries (Bonsai engine): remove extracted files by list
      let removed = 0
      for (const f of model.extractFiles) {
        try { unlinkSync(join(absPath, f)); removed++ } catch { /* file missing — ok */ }
      }
      console.log(`[download] Deleted ${removed}/${model.extractFiles.length} files: ${model.label}`)
    } else {
      if (existsSync(absPath)) unlinkSync(absPath)
      console.log(`[download] Deleted: ${model.label}`)
    }
    // Tails of incomplete downloads, including shared ZIP from older versions.
    for (const tail of [absPath + '.downloading', absPath + `_${modelId}_tmp.zip`, absPath + '_tmp.zip']) {
      try { unlinkSync(tail) } catch { /* missing — ok */ }
    }
    // (fix 352) Clear stuck error/cancelled status: after deleting
    // model, entry in activeDownloads is meaningless, and getAllModelsStatus
    // would show "error" for already deleted file until reload.
    activeDownloads.delete(modelId)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: `Failed to delete file: ${e instanceof Error ? e.message : String(e)}` }
  }
}


