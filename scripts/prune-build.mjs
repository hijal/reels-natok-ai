#!/usr/bin/env node
/**
 * scripts/prune-build.mjs — compact production build before release.
 *
 * What it does:
 *   1. Removes `.next/cache/` (≈300 MB) — webpack cache used to SPEED UP
 *      rebuilds. Has no impact on application runtime.
 *   2. Trims `.next/server` — `.nft.json` manifests (≈530 MB): file lists
 *      that Next considers necessary for standalone deployment
 *      (output-file-tracing). Each lists ~87,000 files across ComfyUI /
 *      embedded-Python trees accessed by the app via ABSOLUTE paths at
 *      runtime rather than require().
 *
 * Why not `outputFileTracingExcludes` in next.config.ts:
 * Next concatenates the pattern with the project root via `path.join`, which
 * on Windows yields backslashes — picomatch treats backslash as an escape
 * character, and no pattern matches. Verified on Next 16.1.1:
 *   path.join(dir, GLOB) produces 'E:\\proj\\**\\ComfyUI-Easy-Install\\**'
 *   and such a template DOES NOT match an absolute path, whereas a raw
 *   pattern with forward slashes matches. Therefore we trim manifests
 *   post-build — predictable across all platforms.
 *
 * Safety: .nft.json manifests are only read during standalone builds
 * (output: 'standalone') and deployment. Here the application runs via
 * `next()` from node_modules (server.js) — manifests are unused at runtime.
 *
 * Usage:
 *   node scripts/prune-build.mjs
 *   node scripts/prune-build.mjs --dry
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const DRY = process.argv.includes('--dry');

/**
 * Path segments that the app does not need at runtime.
 * Matched against normalized paths (no backslashes).
 */
const EXCLUDE_SEGMENTS = [
  'ComfyUI-Easy-Install',
  'upscale\\bin',
  'upscale/bin',
  'Bonsai_2_27B',
  '.local-input',
];

/** Files that must always be retained in the manifest. */
const KEEP_SUFFIXES = ['node_modules/next/dist/compiled'];

function normalize(p) {
  return p.split(sep).join('/').split('\\').join('/');
}

/** Should this path be excluded from the manifest? */
function isExcluded(filePath) {
  const p = normalize(filePath);
  for (const seg of EXCLUDE_SEGMENTS) {
    const s = normalize(seg);
    if (p === s || p.includes('/' + s + '/') || p.startsWith(s + '/')) return true;
  }
  return false;
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

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

// ── 1. Build cache ────────────────────────────────────────────────────────
const cacheDir = join(ROOT, '.next', 'cache');
if (existsSync(cacheDir)) {
  const size = dirSize(cacheDir);
  console.log(`[prune] .next/cache            ${(size / 1024 / 1024).toFixed(0)} MB — removing (rebuild cache)`);
  if (!DRY) rmSync(cacheDir, { recursive: true, force: true });
}

// ── 2. .nft.json manifests ────────────────────────────────────────────────
const serverDir = join(ROOT, '.next', 'server');
const manifests = walk(serverDir).filter((f) => f.endsWith('.nft.json'));

let before = 0;
let after = 0;
let trimmed = 0;

for (const file of manifests) {
  const size = statSync(file).size;
  before += size;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    continue;
  }
  if (!Array.isArray(parsed.files)) continue;
  const kept = parsed.files.filter((f) => !isExcluded(f) || KEEP_SUFFIXES.some((s) => normalize(f).includes(s)));
  if (kept.length === parsed.files.length) {
    after += size;
    continue;
  }
  const removed = parsed.files.length - kept.length;
  trimmed += removed;
  parsed.files = kept;
  const out = JSON.stringify(parsed);
  after += Buffer.byteLength(out);
  if (!DRY) writeFileSync(file, out);
}

console.log(
  `[prune] .nft.json (${manifests.length} files)  ` +
    `${(before / 1024 / 1024).toFixed(0)} MB → ${(after / 1024 / 1024).toFixed(1)} MB` +
    (trimmed ? `  (entries excluded: ${trimmed.toLocaleString('en-US')})` : ''),
);

const total = dirSize(join(ROOT, '.next'));
console.log(`[prune] final .next size:         ${(total / 1024 / 1024).toFixed(1)} MB${DRY ? '  (--dry: nothing deleted)' : ''}`);
