#!/usr/bin/env node
/**
 * scripts/prepare-electron.mjs — Electron process renaming.
 *
 * WHY. In Task Manager the studio window process is called "electron.exe" —
 * the user has no way to distinguish it from another Electron app.
 * When asked to "kill the studio if frozen", it is impossible to do
 * properly. Here exe is copied under the application name, and that is what
 * gets launched: Task Manager shows "MinimaxH3Studio".
 *
 * WHAT IS DONE.
 *   1. Copy `node_modules/electron/dist/electron.exe` →
 *      `node_modules/electron/dist/MinimaxH3Studio.exe`.
 *      The image file name is exactly what Task Manager displays.
 *      A copy, not a move: the stock `node_modules/electron` remains
 *      intact, `require('electron')` and `npm install` continue to work.
 *   2. The version resource is written into the copy (ProductName,
 *      FileDescription, CompanyName, OriginalFilename, InternalName) — so that
 *      both file Properties and the "Product name" column in Task Manager show
 *      the studio rather than "Electron / GitHub, Inc.".
 *
 * APPLICATION IDENTITY. The copy is located in the same dist folder, so Electron
 * finds its resources (resources/, icudtl.dat, DLL) as usual — the path
 * is calculated relative to the exe location.
 *
 * LAUNCH. The copy cannot be launched directly from .bat: exe is compiled as
 * a GUI application (subsystem 2), stdout will not reach the console. Therefore
 * scripts/launch-electron.mjs handles launching — it spawns the copy with
 * stdio:'inherit' (output visible in console) and terminates cleanly along
 * with it.
 *
 * IDEMPOTENCE. The script is idempotent: if the copy already exists and is not
 * older than the original, nothing is done. Any error (e.g. permission denied
 * modifying resources) DOES NOT break startup — renaming the exe already solves
 * the problem, so a version resource update failure is only logged to console.
 *
 * Usage:
 *   node scripts/prepare-electron.mjs
 *   node scripts/prepare-electron.mjs --force   — recreate copy from scratch
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readPeResourceInfo, buildVersionInfo } from './pe-version.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FORCE = process.argv.includes('--force');

/** Process name in Task Manager. */
const EXE_NAME = 'MinimaxH3Studio.exe';
/** What to show in file properties and in the "Product name" column. */
const APP_TITLE = 'Minimax H3 Studio';
const APP_VENDOR = 'Minimax H3 Studio';
const APP_DESC = 'MiniMax H3 Studio — local video generation with audio';
const APP_COPYRIGHT = 'MiniMax H3 Studio';

const DIST = path.join(ROOT, 'node_modules', 'electron', 'dist');
const SRC_EXE = path.join(DIST, 'electron.exe');
const DST_EXE = path.join(DIST, EXE_NAME);

function log(msg) {
  console.log(`[prepare-electron] ${msg}`);
}

/** Is the copy newer than the original? */
function isFresh() {
  try {
    return fs.statSync(DST_EXE).mtimeMs >= fs.statSync(SRC_EXE).mtimeMs;
  } catch {
    return false;
  }
}

if (!fs.existsSync(SRC_EXE)) {
  log('electron.exe not found — skipping (launch will proceed normally).');
  process.exit(0);
}

if (!FORCE && fs.existsSync(DST_EXE) && isFresh()) {
  log(`${EXE_NAME} is already up to date — skipping.`);
  process.exit(0);
}

log(`copying electron.exe → ${EXE_NAME} ...`);
try {
  fs.copyFileSync(SRC_EXE, DST_EXE);
} catch (e) {
  log(`FAILED to copy: ${e.message}`);
  log('application will launch normally (process name will be electron).');
  process.exit(0);
}

// ── Version resource ──────────────────────────────────────────────────────
// Non-critical: without it, the copy is still named MinimaxH3Studio.exe.
try {
  const info = readPeResourceInfo(DST_EXE);
  const langId = info.version.langId;
  const nameId = info.version.nameId;

  // Application version — from package.json so that "File Properties" and
  // "About" match the release itself.
  let fileVer = 7_00_00;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const [maj, min, pat] = String(pkg.version || '7.0.0').split('.').map((n) => parseInt(n, 10) || 0);
    fileVer = ((maj & 0xffff) << 16) | ((min & 0xffff) << 8) | (pat & 0xff);
  } catch { /* version from package.json unavailable — fallback to 7.0.0 */ }

  const vi = buildVersionInfo(
    [
      ['CompanyName', APP_VENDOR],
      ['FileDescription', APP_DESC],
      ['FileVersion', `${(fileVer >>> 16) & 0xffff}.${(fileVer >>> 8) & 0xff}.${fileVer & 0xff}`],
      ['InternalName', EXE_NAME],
      ['LegalCopyright', APP_COPYRIGHT],
      ['OriginalFilename', EXE_NAME],
      ['ProductName', APP_TITLE],
      ['ProductVersion', `${(fileVer >>> 16) & 0xffff}.${(fileVer >>> 8) & 0xff}.${fileVer & 0xff}`],
    ],
    fileVer,
    fileVer,
  );

  const tmp = path.join(ROOT, 'data', 'electron-version.bin');
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  fs.writeFileSync(tmp, vi);
  try {
    const ps = path.join(ROOT, 'scripts', 'set-version-resource.ps1');
    const r = spawnSync(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps, '-ExePath', DST_EXE, '-ResFile', tmp, '-LangId', String(langId), '-NameId', String(nameId)],
      { stdio: 'pipe', windowsHide: true, encoding: 'utf8' },
    );
    if (r.status === 0) {
      log('version resource updated (ProductName / FileDescription / OriginalFilename).');
    } else {
      log(`version resource not updated: ${(r.stderr || r.stdout || '').trim().split('\n').pop()}`);
      log('(does not affect process name in Task Manager)');
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* nothing to remove */ }
  }
} catch (e) {
  log(`version resource not updated: ${e.message}`);
  log('(does not affect process name in Task Manager)');
}

log(`done: ${path.relative(ROOT, DST_EXE)}`);
