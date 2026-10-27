#!/usr/bin/env node
/**
 * scripts/release.mjs — prepares portable build for release.
 *
 * Sequence:
 *   1. clean       — remove artifacts from previous build and garbage
 *   2. typecheck   — tsc --noEmit (strict + noUnusedLocals/Parameters)
 *   3. build       — next build --webpack via scripts/build.mjs (heap 8 GB)
 *   4. verify      — verify that artifacts are in place and project is clean
 *
 * Step 4 is the most valuable: it catches exactly those problems that cause
 * "release does not start for the user":
 *   • .next/ is not built or partially built;
 *   • logs / junk files remain in root;
 *   • node_modules is missing (without it start.bat will not start app);
 *   • .env is missing (without it ComfyUI backend cannot be found);
 *   • electron/ is missing (start.bat will fall back to browser mode);
 *   • public/splash-videos/ is missing (splash screen remains black).
 *
 * Usage:
 *   node scripts/release.mjs            — full cycle
 *   node scripts/release.mjs --verify   — verification only (no build)
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const VERIFY_ONLY = process.argv.includes('--verify');

let failed = false;

function run(label, cmd, args) {
  console.log(`\n[release] === ${label} ===`);
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) {
    console.error(`[release] FAILED: ${label}`);
    failed = true;
    return false;
  }
  return true;
}

function dirSize(dir) {
  try {
    let total = 0;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      total += e.isDirectory() ? dirSize(p) : statSync(p).size;
    }
    return total;
  } catch {
    return 0;
  }
}

// ── 1. Clean ──────────────────────────────────────────────────────────────
if (!VERIFY_ONLY) {
  if (!run('clean', process.execPath, ['scripts/clean.mjs'])) process.exit(1);

  // ── 2. Typecheck ────────────────────────────────────────────────────────
  if (!run('typecheck', process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit'])) process.exit(1);

  // ── 3. Build ────────────────────────────────────────────────────────────
  if (!run('build', process.execPath, ['scripts/build.mjs'])) process.exit(1);

  // ── 3b. Prune build ─────────────────────────────────────────────────────
  // .next/cache (rebuild cache, ~300 MB) and .nft.json manifests (~530 MB)
  // are not needed at runtime: server.js launches next() from node_modules.
  if (!run('prune build', process.execPath, ['scripts/prune-build.mjs'])) process.exit(1);

  // ── 3c. Process name ────────────────────────────────────────────────────
  // Copy electron.exe as MinimaxH3Studio.exe — so that in Task Manager
  // the studio process does not look like "electron".
  run('prepare electron', process.execPath, ['scripts/prepare-electron.mjs']);
}

// ── 4. Artifact verification ──────────────────────────────────────────────
console.log(`\n[release] === verify ===`);

const checks = [];
const check = (ok, label, hint) => checks.push({ ok, label, hint });

// Build.
const buildId = join(ROOT, '.next', 'BUILD_ID');
check(existsSync(buildId), 'production build (.next/BUILD_ID)', 'run `npm run build`');
check(existsSync(join(ROOT, '.next', 'server')), 'server bundle (.next/server)');
check(existsSync(join(ROOT, '.next', 'static')), 'client assets (.next/static)');

// Runtime.
check(existsSync(join(ROOT, 'node_modules')), 'node_modules (npm dependencies)', 'run `npm install`');
check(
  existsSync(join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')),
  'Electron (app window)',
  'copy node_modules entirely from source PC',
);
check(
  existsSync(join(ROOT, 'node_modules', 'electron', 'dist', 'MinimaxH3Studio.exe')),
  'renamed MinimaxH3Studio.exe (Task Manager name)',
  'run `node scripts/prepare-electron.mjs`',
);
check(existsSync(join(ROOT, 'electron', 'main.js')), 'electron/main.js');
check(existsSync(join(ROOT, 'electron', 'preload.js')), 'electron/preload.js');

// Entry point.
check(existsSync(join(ROOT, 'start.bat')), 'start.bat (entry point)');
check(existsSync(join(ROOT, 'start_hidden.vbs')), 'start_hidden.vbs');
check(existsSync(join(ROOT, 'server.js')), 'server.js');
check(existsSync(join(ROOT, '.env')), '.env (COMFY_URL)', 'copy .env from source PC');

// Resources.
check(existsSync(join(ROOT, 'public', 'splash-videos')), 'public/splash-videos (splash video)');
check(existsSync(join(ROOT, 'public', 'logo.svg')), 'public/logo.svg');
check(existsSync(join(ROOT, 'config', 'config.ini')), 'config/config.ini');

// Garbage in root.
const junk = [];
for (const e of readdirSync(ROOT, { withFileTypes: true })) {
  if (e.isFile() && (e.name.toLowerCase().endsWith('.log') || e.name === '_nul' || e.name.endsWith('.tsbuildinfo'))) {
    junk.push(e.name);
  }
}
check(junk.length === 0, 'no logs/garbage in root', `delete: ${junk.join(', ')}`);

// Summary.
console.log('');
for (const c of checks) {
  console.log(`  ${c.ok ? 'OK  ' : 'FAIL'}  ${c.label}${c.ok ? '' : `   → ${c.hint}`}`);
}

const bad = checks.filter((c) => !c.ok);
if (bad.length > 0) {
  console.error(`\n[release] FAILED: ${bad.length} checks failed.`);
  process.exit(1);
}

// Soft warnings — do not block release, but show what could be pruned.
const warnings = [];
const cacheDir = join(ROOT, '.next', 'cache');
if (existsSync(cacheDir)) {
  const cacheSize = dirSize(cacheDir);
  // Minor cache (tsconfig.tsbuildinfo ~200 KB) is normal, recreated on every
  // typecheck run. Warn only about heavy webpack cache.
  if (cacheSize > 10 * 1024 * 1024) {
    warnings.push(
      `rebuild cache remains in .next/cache (${(cacheSize / 1024 / 1024).toFixed(0)} MB) — run 'npm run release'`,
    );
  }
}
const nextSize = dirSize(join(ROOT, '.next'));
if (nextSize > 100 * 1024 * 1024) {
  warnings.push(`.next size is ${(nextSize / 1024 / 1024).toFixed(0)} MB — run 'node scripts/prune-build.mjs'`);
}

const size = dirSize(join(ROOT, '.next'));
const buildIdValue = existsSync(buildId) ? readFileSync(buildId, 'utf-8').trim() : '?';
console.log(
  `\n[release] OK — build is ready for release ` +
    `(.next: ${(size / 1024 / 1024).toFixed(1)} MB, BUILD_ID ${buildIdValue}).`,
);
for (const w of warnings) {
  console.log(`  WARNING  ${w}`);
}
