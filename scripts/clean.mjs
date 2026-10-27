#!/usr/bin/env node
/**
 * scripts/clean.mjs — cleanup of build artifacts and garbage.
 *
 * What it removes:
 *   .next/                — production build (rebuilt from scratch)
 *   .next/dev/            — dev server
 *   tsconfig.tsbuildinfo  — TypeScript incremental cache
 *   __pycache__/          — Python bytecode (in upscale/, tools/)
 *   *.log                 — startup logs (comfyui_startup.log, start_*.log)
 *   _nul                 — Git Bash trap: `2>nul` in bash creates a file
 *                          with a reserved Windows name (see .gitignore)
 *
 * What it does NOT touch:
 *   node_modules/, ComfyUI-Easy-Install/, data/, .env, config/config.ini
 *
 * Usage:
 *   node scripts/clean.mjs          — clean
 *   node scripts/clean.mjs --dry    — dry run, show what would be removed
 */
import { readdirSync, statSync, existsSync, rmSync } from 'node:fs';
import { join, relative, basename } from 'node:path';

const ROOT = process.cwd();
const DRY = process.argv.includes('--dry');

/** Top-level files/directories that are always removed. */
const TOP_LEVEL = [
  '.next',
  'tsconfig.tsbuildinfo',
  '_nul',
  'comfyui_startup.log',
  'start_error.log',
  'start_debug.log',
];

/**
 * Directories with our own Python code where we clean the cache.
 * IMPORTANT: `upscale/bin/` is vendor embedded Python (site-packages);
 * its `__pycache__` does not need to be touched as it is not our code.
 */
const PYCACHE_ROOTS = ['upscale', 'tools'];

/** Directories not traversed recursively (vendor runtimes). */
const PYCACHE_SKIP = ['node_modules', '.next', 'bin', 'site-packages', 'Lib'];

/** Log file extension in root. */
const LOG_EXT = '.log';

const removed = [];
const freedBytes = [];

function sizeOf(p) {
  try {
    const st = statSync(p);
    if (st.isFile()) return st.size;
    let total = 0;
    for (const e of readdirSync(p, { withFileTypes: true })) {
      total += sizeOf(join(p, e.name));
    }
    return total;
  } catch {
    return 0;
  }
}

function drop(target, label) {
  if (!existsSync(target)) return;
  const size = sizeOf(target);
  removed.push(label);
  freedBytes.push(size);
  if (!DRY) {
    rmSync(target, { recursive: true, force: true });
  }
}

/** Recursively look for __pycache__ in the specified roots. */
function findPycache(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (!entry.isDirectory()) continue;
    if (entry.name === '__pycache__') {
      drop(full, relative(ROOT, full));
    } else if (!PYCACHE_SKIP.includes(entry.name)) {
      findPycache(full);
    }
  }
}

console.log(`[clean] root: ${ROOT}${DRY ? '  (--dry: removing nothing)' : ''}`);

// 1. Specific targets in root.
for (const name of TOP_LEVEL) drop(join(ROOT, name), name);

// 2. All *.log in root (except those already dropped above).
for (const entry of readdirSync(ROOT, { withFileTypes: true })) {
  if (entry.isFile() && entry.name.toLowerCase().endsWith(LOG_EXT)) {
    drop(join(ROOT, entry.name), entry.name);
  }
}

// 3. Python cache.
for (const r of PYCACHE_ROOTS) findPycache(join(ROOT, r));

// 4. DLSS bridge working artifacts: reports from past renders and job files.
//    Keep the folders themselves — bridge.py expects them to exist.
for (const dir of ['upscale/logs', 'upscale/jobs']) {
  const full = join(ROOT, dir);
  if (!existsSync(full)) continue;
  for (const entry of readdirSync(full, { withFileTypes: true })) {
    drop(join(full, entry.name), `${dir}/${entry.name}`);
  }
}

if (removed.length === 0) {
  console.log('[clean] clean — nothing to remove.');
} else {
  const total = freedBytes.reduce((a, b) => a + b, 0);
  for (const label of removed) console.log(`  - ${label}`);
  console.log(
    `[clean] ${DRY ? 'will be removed' : 'removed'}: ${removed.length} object(s), ` +
      `${(total / 1024 / 1024).toFixed(1)} MB`,
  );
}
