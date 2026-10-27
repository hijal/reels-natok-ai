/**
 * Electron main process — desktop wrapper for MiniMax H3 Studio 7 (fix 561).
 *
 * The application remains a web application (Next.js production server on :3000),
 * but runs in its OWN window without browser chrome: its own icon and name in
 * the taskbar, closes like a regular application.
 *
 * Orchestration (equivalent to previous start.bat flow, see fix 551):
 *   1. single-instance lock — second copy focuses existing window;
 *   2. kill hanging listeners on :3000 and :8188 (orphaned past sessions);
 *   3. spawn web server (server.js) as a child process — using Electron's
 *      own Node (ELECTRON_RUN_AS_NODE=1), system Node is not required for runtime;
 *   4. spawn ComfyUI (python_embeded) with VRAM flags from config/config.ini;
 *   5. await response from :3000 and open window at /splash — splash screen itself
 *      awaits ComfyUI readiness (/api/comfy/health) and enters studio;
 *   6. window close = quit application = taskkill /T /F trees of
 *      server.js and ComfyUI (along with their child LLM/upscale processes).
 *
 * Launch: node_modules\.bin\electron electron\main.js (`npm run desktop` script,
 * or automatically from start.bat — with fallback there to old browser mode).
 */
const { app, BrowserWindow, Menu, dialog, shell, ipcMain } = require('electron')
const { spawn, spawnSync } = require('node:child_process')
const { existsSync, readFileSync } = require('node:fs')
const fsPromises = require('node:fs').promises
const path = require('node:path')
const util = require('node:util')

const APP_ROOT = path.resolve(__dirname, '..')
const PORT = 3000
const COMFY_PORT = 8188
const CONFIG_INI = path.join(APP_ROOT, 'config', 'config.ini')
const COMFY_ROOT = resolveComfyRoot()
const COMFY_PY = path.join(COMFY_ROOT, 'python_embeded', 'python.exe')
const ICON = path.join(__dirname, 'icons', 'icon.ico')

function resolveComfyRoot() {
  let configured = ''
  try {
    if (existsSync(CONFIG_INI)) {
      let section = ''
      for (const line of readFileSync(CONFIG_INI, 'utf8').split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue
        const sectionMatch = /^\[([^\]]+)\]$/.exec(trimmed)
        if (sectionMatch) {
          section = sectionMatch[1].toLowerCase()
          continue
        }
        const eq = trimmed.indexOf('=')
        if (section === 'comfy' && eq > 0 && trimmed.slice(0, eq).trim().toLowerCase() === 'comfy_dir') {
          configured = trimmed.slice(eq + 1).trim().replace(/"/g, '')
          break
        }
      }
    }
  } catch { /* use env/default */ }
  const raw = configured || (process.env.COMFY_ROOT || '').trim() || 'ComfyUI-Easy-Install'
  return path.resolve(APP_ROOT, raw)
}

/* ── (fix 567) Console capture ────────────────────────────────
 * All output of server.js, ComfyUI, and Electron itself is collected in a ring
 * buffer (for the "Console" panel in UI) AND duplicated to the real console
 * (minimized start.bat window) — nothing is lost.
 * Cap: 2 MB of text, trimmed along newline boundary.
 *
 * (fix 588) OPERATIONS protocol instead of raw text: ComfyUI/tqdm
 * prints generation progress with a SINGLE \r (carriage return without \n) — the real
 * console OVERWRITES the line in-place in this case. Previously each step
 * was added as a new line — a wall of "0%|…| 1/6", "0%|…| 2/6"… was unreadable.
 * Now child output goes through terminal line assembler (see
 * makeConsoleWriter): \n → 'a' op (append), solitary \r → 'r'
 * (write text from START of last line, overwriting old text — exactly like
 * in Windows console; tqdm appends spaces itself to clear the tail).
 * Buffer and UI apply operations identically → "Save log" is also clean. */
const CONSOLE_MAX = 2_000_000
let consoleBuf = ''
/** Operation queue for UI: ['a'|'r', text][]. */
let consolePend = []
let consoleTimer = null

/**
 * (fix 716) Clean exit flag. Declared at TOP of file: previously it was
 * declared lower in the module (let quitting = false), and the handler
 * server.on('exit') referenced it in the TDZ zone. It only worked because
 * the handler was registered after reaching the declaration — any
 * refactoring (or exit during module initialization) produced
 * ReferenceError INSIDE the handler: with no dialog and no app.quit() —
 * hanging Electron process without a window.
 */
let quitting = false

function consoleBroadcast() {
  if (consoleTimer) return
  consoleTimer = setTimeout(() => {
    consoleTimer = null
    if (!consolePend.length || !win || win.isDestroyed()) { consolePend = []; return }
    const ops = consolePend
    consolePend = []
    win.webContents.send('h3:console-append', ops)
  }, 400)
}

/** Apply operation to text buffer (consoleBuf and UI apply the same thing). */
function applyConsoleOp(buf, op, text) {
  if (op === 'r') {
    const nl = buf.lastIndexOf('\n')
    const oldLine = buf.slice(nl + 1)
    // Pad old line tail with spaces (EL, clear-to-line-end): if
    // the new line is shorter, leftovers from previous state won't show through.
    const pad = oldLine.length > text.length ? ' '.repeat(oldLine.length - text.length) : ''
    return buf.slice(0, nl + 1) + text + pad
  }
  return buf + text
}

function pushConsoleOp(op, str) {
  consoleBuf = applyConsoleOp(consoleBuf, op, str)
  if (consoleBuf.length > CONSOLE_MAX) {
    const nl = consoleBuf.indexOf('\n', consoleBuf.length - CONSOLE_MAX)
    consoleBuf = nl >= 0 ? consoleBuf.slice(nl + 1) : consoleBuf.slice(-CONSOLE_MAX)
  }
  consolePend.push([op, str])
  consoleBroadcast()
}

function appendConsole(str, tee = true) {
  // tee=false — string has already been printed to the real console through another path
  // (console.log patch below writes via orig.log itself) — do not duplicate.
  // (fix 573) COMPLETELY disable writing to process.stdout — when launched
  // hidden (start_hidden.vbs), stdout is a pipe, and writing to it causes
  // EPIPE (broken pipe). Logs are preserved only in buffer for UI.
  // if (tee && process.stdout.isTTY) {
  //   try { process.stdout.write(str) } catch { /* ignore */ }
  // }
  pushConsoleOp('a', str)
}

/* (fix 588) Terminal line assembler for a single child stream:
 * accumulates incomplete tail between chunks, slices stream by \n and \r, and emits
 * operations. Semantics are like a cursor in console: solitary \r means that
 * the NEXT segment is written from the start of the line ('r' operation — overwrite
 * clearing the tail). A solitary \r at the VERY end of chunk is held back
 * (until the next chunk it's unknown whether it is \r\n or line overwrite). */
function makeConsoleWriter() {
  let carry = ''
  let atLineStart = false
  const flush = (seg, withNewline) => {
    if (atLineStart) {
      pushConsoleOp('r', seg)
      atLineStart = false
    } else {
      pushConsoleOp('a', seg)
    }
    if (withNewline) pushConsoleOp('a', '\n')
  }
  return (chunkStr) => {
    carry += chunkStr
    let i = 0
    while (i < carry.length) {
      const nl = carry.indexOf('\n', i)
      const cr = carry.indexOf('\r', i)
      if (nl === -1 && cr === -1) break // incomplete line — wait for continuation
      if (cr !== -1 && (nl === -1 || cr < nl)) {
        if (cr + 1 >= carry.length) break // \r at end of chunk: wait for next
        if (carry[cr + 1] === '\n') {
          flush(carry.slice(i, cr), true) // \r\n — regular end of line
          i = cr + 2
        } else {
          flush(carry.slice(i, cr), false) // solitary \r: continue from start of line
          atLineStart = true
          i = cr + 1
        }
      } else {
        flush(carry.slice(i, nl), true) // \n without \r
        i = nl + 1
      }
    }
    carry = carry.slice(i)
  }
}

/* Own logs ([desktop] …) — also into buffer: "literally all information".
 * orig.log prints to real console, appendConsole — without tee (no duplicate). */
{
  const fmt = (a) => a.map((x) => (typeof x === 'string' ? x : util.inspect(x))).join(' ')
  // (fix 571) Do not call original console.log/warn/error — it writes
  // to process.stdout, which on hidden launch (start_hidden.vbs) may
  // be a broken pipe (EPIPE). appendConsole writes to buffer and UI directly.
  console.log = (...a) => { appendConsole(fmt(a) + '\n', false) }
  console.warn = (...a) => { appendConsole('[warn] ' + fmt(a) + '\n', false) }
  console.error = (...a) => { appendConsole('[error] ' + fmt(a) + '\n', false) }
}
appendConsole(`[desktop] MiniMax H3 Studio — console capture started (${new Date().toISOString()})\n`)

/* ── Child processes (killed on exit) ── */
const children = new Set()

/* (fix 587) ComfyUI/python on Windows often writes to console in OEM encoding
 * (cp866) — toString('utf8') produces garbled characters in the "Console" panel. If
 * UTF decoding contains U+FFFD (corrupted sequences), try IBM866
 * (TextDecoder with full ICU, Node 22+ / Electron 44). */
let ibm866Decoder = null
function decodeChildOutput(d) {
  const s = d.toString('utf8')
  if (!s.includes('\uFFFD')) return s
  try {
    if (!ibm866Decoder) ibm866Decoder = new TextDecoder('ibm866')
    return ibm866Decoder.decode(d)
  } catch { return s }
}

function spawnChild(cmd, args, opts = {}) {
  const c = spawn(cmd, args, {
    cwd: APP_ROOT,
    // (fix 567) pipe + capture to "Console" buffer (appendConsole duplicates
    // to real console itself) — inherit is not accessible to renderer.
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    ...opts,
  })
  // (fix 587) Async spawn error (ENOENT, etc.) without 'error' handler
  // crashed the entire main process instead of giving an understandable message.
  c.on('error', (err) => {
    appendConsole(`[desktop] failed to spawn process (${cmd}): ${err.message}\n`)
    children.delete(c)
  })
  // (fix 588) Each stream has its OWN line assembler (incomplete tail
  // of one stream must not concatenate with another stream's chunk).
  const writeOut = makeConsoleWriter()
  const writeErr = makeConsoleWriter()
  c.stdout.on('data', (d) => writeOut(decodeChildOutput(d)))
  c.stderr.on('data', (d) => writeErr(decodeChildOutput(d)))
  children.add(c)
  c.on('exit', () => children.delete(c))
  return c
}

/** Kill process tree (process itself + all child processes — LLM/upscale, etc.).
 *  taskkill /T /F — like in llm-runner: more reliable than child.kill() on Windows. */
function killTree(pid) {
  if (!pid) return
  try {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
  } catch { /* already dead */ }
}

/** Process image name by PID ("node.exe" / "python.exe" / …), '' if not found.
 *  (fix 587) Check owner before taskkill port. */
function processImageName(pid) {
  try {
    const out = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8', windowsHide: true,
    }).stdout || ''
    const m = /^"([^"]+\.exe)"/i.exec(out.trim())
    return m ? m[1].toLowerCase() : ''
  } catch { return '' }
}

/** Kill TCP port listeners (orphaned past sessions).
 *  (fix 561) Port from start.bat: TWO literal filters in a row —
 *  `:port ` at start of address field AND "LISTENING". Single findstr match
 *  by substring would catch ESTABLISHED browser/node connections and taskkill
 *  would kill unrelated processes. taskkill by PID does not touch pooling sockets.
 *  (fix 587) Owner filter: kill only node/python/electron —
 *  third-party application that happened to occupy port 3000/8188 (IIS, custom
 *  service, browser) is no longer killed silently. */
const KILLABLE_IMAGES = new Set(['node.exe', 'python.exe', 'pythonw.exe', 'electron.exe'])
function killPortListeners(port) {
  let out = ''
  try {
    out = spawnSync('netstat', ['-aon'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).stdout || ''
  } catch { return }
  const needle = `:${port}`
  const pids = new Set()
  for (const line of out.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/)
    if (parts.length >= 5 && parts[3] === 'LISTENING') {
      const local = parts[1] || ''
      // local address like 0.0.0.0:3000 / [::]:3000 / 127.0.0.1:3000
      if (local.endsWith(needle)) pids.add(parts[4])
    }
  }
  for (const pid of pids) {
    if (Number(pid) === process.pid) continue // do not kill self
    const image = processImageName(pid)
    // (fix 716) Fail-SAFE, not fail-open. Previously the check was
    // `if (image && !KILLABLE_IMAGES.has(image))` — with an EMPTY image
    // (process already terminated: tasklist prints localized
    // "INFO: No tasks are running…", which does not match regex;
    // or tasklist failed), the check was skipped and PID was killed
    // UNCONDITIONALLY — exactly the case the comment above promises
    // not to touch (foreign app that accidentally occupied the port).
    if (!image) {
      console.log(`[desktop] port ${port} listener (PID ${pid}) — owner unknown, skipping kill`)
      continue
    }
    if (!KILLABLE_IMAGES.has(image)) {
      console.log(`[desktop] port ${port} listener (PID ${pid}, ${image}) — not our process, skipping`)
      continue
    }
    try {
      spawnSync('taskkill', ['/PID', pid, '/F'], { windowsHide: true })
      console.log(`[desktop] killed port ${port} listener: PID ${pid} (${image})`)
    } catch { /* ignore */ }
  }
}

/* ── config.ini → ComfyUI flags (port of fix 551 from start.bat) ── */
function parseIniVram() {
  const v = { reserveGb: '3', dynamicVram: '1', asyncOffload: '0', vramHeadroom: '0' }
  if (!existsSync(CONFIG_INI)) return v
  let text = ''
  try {
    text = readFileSync(CONFIG_INI, 'utf8')
  } catch { return v }
  const grab = (key) => {
    for (const line of text.split(/\r?\n/)) {
      if (line.trim().toLowerCase().startsWith(key + '=')) {
        return line.slice(line.indexOf('=') + 1).trim().replace(/"/g, '')
      }
    }
    return undefined
  }
  // first match wins (duplicate keys from old configs), /b semantics of bat
  const num = (raw, dflt, re) => (raw !== undefined && re.test(raw) ? raw : dflt)
  v.reserveGb = num(grab('reserve_gb'), '3', /^[0-9][0-9.]*$/)
  v.dynamicVram = num(grab('dynamic_vram'), '1', /^[01]$/)
  v.asyncOffload = num(grab('async_offload'), '0', /^[01]$/)
  v.vramHeadroom = num(grab('vram_headroom'), '2', /^[0-9][0-9.]*$/)
  return v
}

function startComfy() {
  if (!existsSync(COMFY_PY)) {
    console.log('[desktop] ComfyUI not found — frontend-only mode (generation unavailable)')
    return null
  }
  const v = parseIniVram()
  const args = [
    '-I', path.join(COMFY_ROOT, 'ComfyUI', 'main.py'),
    '--windows-standalone-build',
    '--use-ck-attention',
    '--disable-auto-launch',
    '--reserve-vram', v.reserveGb,
  ]
  if (v.dynamicVram === '0') args.push('--disable-dynamic-vram')
  if (v.asyncOffload !== '1') args.push('--disable-async-offload', '--disable-pinned-memory')
  if (v.vramHeadroom !== '0') args.push('--vram-headroom', v.vramHeadroom)
  console.log(`[desktop] ComfyUI: ${args.join(' ')}`)
  return spawnChild(COMFY_PY, args)
}

function startWebServer() {
  // Electron's own Node: ELECTRON_RUN_AS_NODE turns electron.exe into
  // regular node — system Node is not required for runtime (needed only for
  // npm install/build, which start.bat runs before opening the window).
  return spawnChild(process.execPath, [path.join(APP_ROOT, 'server.js')], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: 'production',
      // (fix 587) Guardian parent: server.js checks this PID every 5s
      // and terminates itself (along with python children via runner exit hooks)
      // if Electron died and its before-quit cleanup didn't run.
      MINIMAX_PARENT_PID: String(process.pid),
    },
  })
}

/** Wait for HTTP response from web server (splash is served immediately after start). */
async function waitHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) })
      if (res.ok) return true
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

/* ── Window ── */
let win = null

/* (fix 563) Window buttons from renderer (preload → IPC): custom HTML buttons
 * in DesktopTitleBar instead of native ones. */
ipcMain.on('h3:window-minimize', () => win?.minimize())
ipcMain.on('h3:window-maximize-toggle', () => {
  if (!win) return
  if (win.isMaximized()) win.unmaximize()
  else win.maximize()
})
ipcMain.on('h3:window-close', () => win?.close())

/* (fix 567) "Console" panel: full buffer + saving to file
 * via native save file dialog. */
ipcMain.handle('h3:console-get', () => consoleBuf)
ipcMain.handle('h3:console-save', async (_e, text) => {
  if (typeof text !== 'string' || !text.length) return { ok: false, error: 'Empty log' }
  try {
    const r = await dialog.showSaveDialog(win, {
      title: 'Save console log',
      defaultPath: `h3-studio-console-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`,
      filters: [{ name: 'Text file', extensions: ['txt'] }],
    })
    if (r.canceled || !r.filePath) return { ok: false, canceled: true }
    await fsPromises.writeFile(r.filePath, text, 'utf8')
    console.log(`[desktop] console log saved: ${r.filePath}`)
    return { ok: true, path: r.filePath }
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) }
  }
})

function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 1200,
    minHeight: 700,
    backgroundColor: '#1c1c20', // background before loading — avoids white flash
    icon: ICON,
    title: 'MiniMax H3 Studio 7',
    autoHideMenuBar: true,
    show: false,
    // (fix 562/563) Custom window chrome: native title bar hidden. Minimize/
    // maximize/close buttons are rendered by the application ITSELF (DesktopTitleBar)
    // via preload-IPC — without native titleBarOverlay background plate,
    // only close button on splash, all three in app.
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  })
  // Real desktop feel: no menu bar (no need to show Alt menu).
  Menu.setApplicationMenu(null)

  // Splash opens in normal size (fix 565 — do NOT maximize
  // on show). Window maximizes to full screen only upon entering the application
  // ITSELF (splash → /), i.e. when ComfyUI is ready and splash is dismissed.
  win.once('ready-to-show', () => win.show())

  // (fix 565) Transition splash → '/': Next.js App Router navigates via
  // History API → did-navigate-in-page event; full navigation (reload
  // while in app) — did-navigate. Catch both, maximize once.
  let maximizedForApp = false
  const maximizeWhenApp = (_e, url) => {
    if (maximizedForApp || !win) return
    let pathname = ''
    try {
      pathname = new URL(url).pathname
    } catch { return }
    if (!pathname.startsWith('/splash')) {
      maximizedForApp = true
      win.maximize()
    }
  }
  win.webContents.on('did-navigate', maximizeWhenApp)
  win.webContents.on('did-navigate-in-page', maximizeWhenApp)

  // External links — open in system browser; do not spawn new app windows.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url) && !url.includes(`127.0.0.1:${PORT}`) && !url.includes(`localhost:${PORT}`)) {
      // (fix 716) .catch is required: openExternal rejects if OS does not
      // have a registered handler (no browser). Without handler this is unhandled
      // rejection → crash of main process → orphaned ComfyUI.
      void shell.openExternal(url).catch((err) => {
        console.log(`[desktop] failed to open external link: ${err && err.message ? err.message : err}`)
      })
    }
    return { action: 'deny' }
  })

  // (fix 716) Disallow navigation to foreign origins. setWindowOpenHandler
  // covers only window.open()/target="_blank"; main frame navigation
  // (location.href, <a href>, form submit, XSS) proceeded unrestricted, and
  // the remote page inherited preload bridge (console.get() with local
  // paths, console.save(), window management). Also Electron by default
  // AUTO-APPROVES microphone requests, and the application uses it.
  win.webContents.on('will-navigate', (event, url) => {
    if (!isLocalAppUrl(url)) {
      event.preventDefault()
      console.log(`[desktop] navigation to foreign origin blocked: ${url}`)
    }
  })
  win.webContents.on('will-redirect', (event, url) => {
    if (!isLocalAppUrl(url)) {
      event.preventDefault()
      console.log(`[desktop] redirect to foreign origin blocked: ${url}`)
    }
  })
  // Microphone and clipboard — only for local application origin.
  // Chromium requests clipboard-sanitized-write for navigator.clipboard.writeText()
  // ("Copy all" button in console, copying prompts/paths).
  // Previously permission was only granted for media, so copying in
  // Electron consistently crashed with "permission request denied".
  const CLIPBOARD_PERMISSIONS = new Set([
    'clipboard-read',
    'clipboard-write',
    'clipboard-sanitized-write',
  ])
  win.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    const local = isLocalAppUrl(win && win.webContents.getURL())
    const allowed = local && (permission === 'media' || CLIPBOARD_PERMISSIONS.has(permission))
    if (!allowed) console.log(`[desktop] permission request denied: ${permission}`)
    callback(allowed)
  })

  // F12 — DevTools (diagnostics of local application)
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      win.webContents.toggleDevTools()
      e.preventDefault()
    }
  })

  win.on('closed', () => { win = null })
  // (fix 716) .catch is required: loadURL rejects on ERR_CONNECTION_REFUSED
  // (server didn't start) or ERR_ABORTED. Without handler — unhandled
  // rejection → crash of main process → orphaned ComfyUI/python processes
  // (before-quit won't run, killTree() won't be called).
  void win.loadURL(`http://127.0.0.1:${PORT}/splash`).catch((err) => {
    console.error(`[desktop] failed to load window: ${err && err.message ? err.message : err}`)
    try {
      dialog.showErrorBox(
        'MiniMax H3 Studio — load error',
        `Failed to open interface:\n${err && err.message ? err.message : String(err)}\n` +
          'Application will close.',
      )
    } catch { /* ignore */ }
    app.quit()
  })
}

/** (fix 716) Does URL belong to local application? */
function isLocalAppUrl(url) {
  if (!url) return false
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'file:') return false
    if (u.protocol === 'file:') return true
    return u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1'
  } catch {
    return false
  }
}

/* ── Lifecycle ── */

// (fix 716) before-quit is registered BEFORE checking single-instance lock.
// Previously app.quit() in the "second instance" branch was called before registering
// the handler, and hidden cmd.exe console created by start_hidden.vbs for
// THIS run remained hanging forever (invisible orphaned process).
app.on('before-quit', () => {
  quitting = true
  for (const c of children) killTree(c.pid)
  children.clear()
  // (fix 570/587) Kill parent cmd process (hidden console from
  // start_hidden.vbs / start.bat). process.ppid is NOT cmd: in standard launch
  // chain (start.bat → node electron\cli.js → electron.exe), parent of
  // Electron is node.exe (cli.js), and cmd.exe is its parent. Old
  // check "ppid is cmd.exe" always failed, and hidden console
  // remained hanging. Walk up ancestor tree (up to 6 levels) and kill
  // nearest cmd.exe with tree (/T /F).
  killAncestorCmd()
})

// Second instance — focus existing window instead of new process.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  void (async () => {
    // Wait for app readiness (ready); in packaged mode path to icon/resources
    // does not change — we only run from project folder.
    await app.whenReady()

    // (release) Application identity in Windows. Without it taskbar icon
    // and window grouping appear under the name "Electron" (taken from
    // productName = name in package.json) and after reinstall/update
    // Windows might duplicate shortcuts. Explicit AppUserModelID binds
    // window to our application.
    try {
      app.setAppUserModelId('com.minimax.h3studio')
    } catch {
      /* older Windows — non-critical */
    }

    // (fix 586) Keep only safe cleanup of listeners on ports 3000/8188.
    killPortListeners(PORT)
    killPortListeners(COMFY_PORT)

    const server = startWebServer()
    startComfy()

    // Server crash (not our quit) — report honestly and exit.
    server.on('exit', (code) => {
      if (quitting) return
      dialog.showErrorBox(
        'MiniMax H3 Studio — server stopped',
        `Web server exited with code ${code}.\n` +
          'Details available in launch console (start.bat).\n' +
          'Application will close.',
      )
      app.quit()
    })

    const up = await waitHttp(`http://127.0.0.1:${PORT}/splash`, 120_000)
    if (!up) {
      dialog.showErrorBox(
        'MiniMax H3 Studio — server failed to start',
        `Web server did not respond within 120s (port ${PORT}).\n` +
          'First build might be in progress — please restart start.bat.',
      )
      app.quit()
      return
    }
    createWindow()
  })().catch((err) => {
    // (fix 716) Previously IIFE was "void" without a handler: any exception
    // (e.g. new BrowserWindow() failed) caused unhandled rejection →
    // crash of main process → app.on('before-quit') was NOT executed →
    // killTree() was not called → ComfyUI/python remained running (port 8188,
    // VRAM) until next launch.
    console.error(`[desktop] critical startup error: ${err && err.stack ? err.stack : err}`)
    try {
      dialog.showErrorBox(
        'MiniMax H3 Studio — startup error',
        `Failed to launch application:\n${err && err.message ? err.message : String(err)}`,
      )
    } catch { /* ignore */ }
    app.quit()
  })
}

// (fix 716) Unhandled error handlers: without them Node terminates
// the process, and main process crash leaves ALL child processes
// (ComfyUI, LLM, STT, upscale bridge) orphaned — they hold ports and VRAM.
process.on('unhandledRejection', (reason) => {
  console.error(`[desktop] unhandledRejection: ${reason && reason.stack ? reason.stack : reason}`)
  try { app.quit() } catch { /* ignore */ }
})
process.on('uncaughtException', (err) => {
  console.error(`[desktop] uncaughtException: ${err && err.stack ? err.stack : err}`)
  try { app.quit() } catch { /* ignore */ }
})

// (fix 716) before-quit handler is registered ABOVE — before checking
// single-instance lock (otherwise app.quit() in "second instance" branch left
// hidden cmd.exe console hanging).

/** (fix 587) Find cmd.exe among current process ancestors and kill it. */
function killAncestorCmd() {
  let pid = process.ppid
  for (let hop = 0; pid && pid > 0 && hop < 6; hop++) {
    let name = ''
    let ppid = 0
    try {
      const out = spawnSync(
        'powershell', ['-NoProfile', '-Command',
          `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').Name;` +
          `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').ParentProcessId`],
        { encoding: 'utf8', windowsHide: true },
      ).stdout || ''
      const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
      if (lines.length >= 2) {
        name = (lines[0] || '').toLowerCase()
        ppid = parseInt(lines[1], 10) || 0
      }
    } catch { /* PowerShell unavailable — exit loop */ }
    if (!name) {
      console.log(`[desktop] ancestor PID ${pid} not found (already terminated) — stopping cmd search`)
      return
    }
    if (name === 'cmd.exe') {
      try {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
        console.log(`[desktop] parent cmd process (PID ${pid}) terminated`)
      } catch {
        console.log(`[desktop] parent cmd process (PID ${pid}) already terminated`)
      }
      return
    }
    pid = ppid
  }
  console.log('[desktop] cmd.exe not found among nearest ancestors — leaving parent untouched')
}
app.on('window-all-closed', () => app.quit())
