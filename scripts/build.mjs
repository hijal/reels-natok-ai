#!/usr/bin/env node
/**
 * scripts/build.mjs — cross-platform wrapper around `next build --webpack`.
 *
 * Why: building this project does not fit in Node's default heap
 * (~4 GB) and fails with `FATAL ERROR: JavaScript heap out of memory`.
 * With an increased heap (8 GB), the build succeeds normally (verified).
 *
 * How: NODE_OPTIONS is read only at the START of the node process, so
 * we launch `next build` in a separate child process which already has
 * this flag set in its environment (webpack worker threads — threads of
 * the same process — share the heap with it). No new dependencies required.
 *
 * Override heap size (in MB):
 *   NEXT_BUILD_HEAP_MB=12288 npm run build
 *
 * Fallback to build without wrapper (default heap):
 *   npm run build:default
 */
import { spawnSync } from 'node:child_process';

// (fix 716) NEXT_BUILD_HEAP_MB is validated: 0 silently turned into 8192,
// and a negative value resulted in "--max-old-space-size=-1", which Node
// rejects with an unclear error.
const heapMbRaw = Number(process.env.NEXT_BUILD_HEAP_MB);
const heapMb = Number.isInteger(heapMbRaw) && heapMbRaw >= 512 && heapMbRaw <= 65536
  ? heapMbRaw
  : 8192;
const flag = `--max-old-space-size=${heapMb}`;
// (fix 587) Do not duplicate the flag if it is already in NODE_OPTIONS (the
// last one wins, but the duplicate confuses diagnostics).
// (fix 716) NODE_OPTIONS is NOT reassembled by splitting on spaces:
// values with spaces (e.g. --require "C:\my path\preload.js") were broken,
// and Node refused to start with "--require is not allowed in NODE_OPTIONS".
// Simply strip our flag from the original string.
const rawOptions = process.env.NODE_OPTIONS || '';
const prev = rawOptions
  .split(/--max-old-space-size=\d+/)
  .join(' ')
  .replace(/\s+/g, ' ')
  .trim();
const env = { ...process.env, NODE_OPTIONS: prev ? `${prev} ${flag}` : flag };

console.log(`[build] next build --webpack  (heap = ${heapMb} MB)`);
// (fix 716) --no-install: without it, npx when node_modules is missing
// WILL PROMPT to download next from the registry and ask "Ok to proceed? (y)" — in
// a non-interactive context the build would hang forever instead of failing.
const r = spawnSync('npx', ['--no-install', 'next', 'build', '--webpack'], {
  env,
  stdio: 'inherit',
  // On Windows npx is npx.cmd — shell is required to resolve it.
  shell: process.platform === 'win32',
});

if (r.error) {
  console.error('[build] failed to launch next build:', r.error.message);
  process.exit(1);
}
if (r.signal) {
  console.error(`[build] next build interrupted by signal ${r.signal}`);
  process.exit(1);
}
process.exit(r.status == null ? 1 : r.status);
