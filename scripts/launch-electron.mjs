#!/usr/bin/env node
/**
 * scripts/launch-electron.mjs — launches the studio window.
 *
 * WHY NOT `electron electron/main.js`. Normal launch goes through
 * node_modules/electron/cli.js, which spawns `dist/electron.exe` — in
 * Task Manager the process is called "electron.exe", and the user cannot
 * distinguish the studio from any other Electron app.
 *
 * Here we launch the renamed copy (scripts/prepare-electron.mjs):
 * `dist/MinimaxH3Studio.exe` — Task Manager shows "MinimaxH3Studio".
 *
 * WHY NOT DIRECTLY FROM .BAT. electron.exe is compiled as a GUI application
 * (PE subsystem 2), so its stdout does not go to the bat console window.
 * cli.js acted as a shim: it lived in the console and launched Electron with
 * stdio:'inherit'. This script does the exact same thing, but for the renamed
 * binary — output remains visible in the console and in the "Console" panel inside
 * the app.
 *
 * FALLBACK PATH. If the renamed copy does not exist (or prepare did not run) —
 * the stock electron.exe is launched, and the app works as before.
 *
 * Usage:
 *   node scripts/launch-electron.mjs electron/main.js
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'node_modules', 'electron', 'dist');

const RENAMED = path.join(DIST, 'MinimaxH3Studio.exe');
const STOCK = path.join(DIST, 'electron.exe');

const exe = existsSync(RENAMED) ? RENAMED : STOCK;
if (!existsSync(exe)) {
  console.error('[launch] electron not found in node_modules/electron/dist — ' +
    'run `npm install`.');
  process.exit(1);
}
console.log(`[launch] ${path.basename(exe)} ${process.argv.slice(2).join(' ')}`);

const child = spawn(exe, process.argv.slice(2), {
  stdio: 'inherit',
  windowsHide: false,
  cwd: ROOT,
});

let childClosed = false;
child.on('close', (code, signal) => {
  childClosed = true;
  if (code === null) {
    console.error('[launch] terminated by signal', signal);
    process.exit(1);
  }
  process.exit(code);
});

for (const sig of ['SIGINT', 'SIGTERM', 'SIGUSR2']) {
  process.on(sig, () => {
    if (!childClosed) child.kill(sig);
  });
}
