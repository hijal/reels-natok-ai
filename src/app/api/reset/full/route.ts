import { NextResponse } from 'next/server'
import { promises as fs } from 'fs'
import path from 'path'
import { getAppConfig, resetConfigToDefaults } from '@/lib/app-config'
import { resetLorasToDefaults } from '@/lib/loras-config'
import { writeExtraModelPathsYaml } from '@/lib/extra-model-paths'
import { clearInflight } from '@/lib/inflight-journal'
import { stopLlm } from '@/lib/llm-runner'
import { stopStt } from '@/lib/stt-runner'

export const dynamic = 'force-dynamic'

/**
 * POST /api/reset/full — factory reset (server part).
 *
 * (factory reset) Deletes EVERYTHING created by the user:
 *   • ComfyUI/input          — references, frames, uploads
 *   • ComfyUI/output         — generated videos and .meta.json
 *   • ComfyUI/temp           — temporary ComfyUI files
 *   • data/chat-attachments  — assistant chat attachments
 *   • data/upscale-*         — upscale inputs/outputs
 *   • upscale/outputs|jobs|logs — upscale results and logs
 *   • .local-input           — offline uploads
 *   • data/assistant-chats.json, data/inflight-generate.json — chats and task journal
 *   • ComfyUI/user         — ComfyUI logs (contain prompts), comfyui.db,
 *                            workflows, node manager cache (locked files
 *                            are truncated — see purgeComfyUserDir)
 *   • start_error.log        — startup log (may contain prompt text)
 *   • data/loras.json        — LoRA settings → defaults
 *   • ComfyUI/extra_model_paths.yaml — external model folders → empty
 *   • config/config.ini      — settings → factory defaults
 *
 * Directories themselves are preserved (only contents are deleted), so
 * ComfyUI and the app continue working without reinstalling.
 * Models, custom_nodes, and program code are NOT touched.
 *
 * Client part (localStorage, Zustand stores, ComfyUI queue)
 * is cleared in settings-dialog.tsx.
 */

/** Recursively cleans directory contents. Returns number of deleted items. */
async function cleanDirectory(dir: string): Promise<{ deleted: number; error?: string }> {
  try {
    await fs.stat(dir)
  } catch {
    return { deleted: 0 } // directory does not exist — already empty
  }

  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch (e) {
    return { deleted: 0, error: e instanceof Error ? e.message : String(e) }
  }

  let deleted = 0
  const failed: string[] = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    try {
      await fs.rm(full, { recursive: true, force: true })
      deleted++
    } catch (e) {
      failed.push(`${entry.name}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return { deleted, error: failed.length ? failed.join('; ') : undefined }
}

/**
 * (factory reset) ComfyUI/user — internal ComfyUI data: logs (contain
 * user prompt text), comfyui.db, saved workflows, node manager
 * cache. Active log and DB are locked by running ComfyUI — delete everything
 * not locked, and truncate locked FILES (truncate works even on logs open
 * for writing): prompt texts disappear, ComfyUI recreates files
 * in full form after program restart.
 */
async function purgeComfyUserDir(
  dir: string,
): Promise<{ deleted: number; truncated: number; failed: string[] }> {
  const out = { deleted: 0, truncated: 0, failed: [] as string[] }
  let entries: import('fs').Dirent[]
  try {
    await fs.stat(dir)
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return out // directory does not exist — already empty
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    try {
      await fs.rm(full, { recursive: true, force: true })
      out.deleted++
    } catch {
      if (entry.isFile()) {
        try {
          await fs.writeFile(full, '')
          out.truncated++
          continue
        } catch { /* below — added to failed */ }
      }
      out.failed.push(entry.name)
    }
  }
  return out
}

/** Deletes file if it exists. Returns 1 if deleted, otherwise 0. */
async function removeFile(file: string): Promise<number> {
  try {
    await fs.unlink(file)
    return 1
  } catch {
    return 0
  }
}

export async function POST() {
  const cwd = process.cwd()
  // Read config BEFORE reset: input/output paths are taken from current backend,
  // not from defaults (the user may have custom ComfyUI directory).
  const cfg = getAppConfig()

  // errors — reasons why reset cannot be considered full (files remain);
  // warnings — non-critical issues (service did not stop, YAML rewrite failed).
  const errors: string[] = []
  const warnings: string[] = []
  const details: Record<string, number> = {}
  let deleted = 0

  // 1) Stop local models so they release files and VRAM.
  //    Errors are non-fatal: data reset takes priority.
  try {
    await stopLlm()
  } catch (e) {
    warnings.push(`LLM: ${e instanceof Error ? e.message : String(e)}`)
  }
  try {
    await stopStt()
  } catch (e) {
    warnings.push(`STT: ${e instanceof Error ? e.message : String(e)}`)
  }

  // 2) Directories with user content.
  const dirs: Array<[string, string]> = [
    ['ComfyUI/input', cfg.inputDir],
    ['ComfyUI/output', cfg.outputDir],
    ['ComfyUI/temp', path.join(cfg.comfyRoot, 'ComfyUI', 'temp')],
    ['data/chat-attachments', path.join(cwd, 'data', 'chat-attachments')],
    ['data/upscale-input', path.join(cwd, 'data', 'upscale-input')],
    ['data/upscale-output', path.join(cwd, 'data', 'upscale-output')],
    ['upscale/outputs', path.join(cwd, 'upscale', 'outputs')],
    ['upscale/jobs', path.join(cwd, 'upscale', 'jobs')],
    ['upscale/logs', path.join(cwd, 'upscale', 'logs')],
    ['.local-input', path.join(cwd, '.local-input')],
  ]
  for (const [label, dir] of dirs) {
    const r = await cleanDirectory(dir)
    details[label] = r.deleted
    deleted += r.deleted
    if (r.error) errors.push(`${label}: ${r.error}`)
  }

  // 2.5) ComfyUI/user — logs with user prompts, comfyui.db,
  //      workflows, node manager cache. Locked files are truncated rather than deleted
  //      (see purgeComfyUserDir): failures go to warnings, not errors — reset
  //      is not considered incomplete due to running ComfyUI; after restarting
  //      the program the folder will be cleanly recreated.
  const user = await purgeComfyUserDir(path.join(cfg.comfyRoot, 'ComfyUI', 'user'))
  deleted += user.deleted + user.truncated
  details['ComfyUI/user'] = user.deleted + user.truncated
  if (user.failed.length) {
    warnings.push(
      `ComfyUI/user (locked by running ComfyUI, will truncate after restart): ${user.failed.join(', ')}`,
    )
  }

  // 3) Files with user data.
  const files = [
    path.join(cwd, 'data', 'assistant-chats.json'),
    path.join(cwd, 'data', 'assistant-chats.json.tmp'),
    path.join(cwd, 'data', 'inflight-generate.json'),
    path.join(cwd, 'start_error.log'),
  ]
  for (const f of files) {
    deleted += await removeFile(f)
  }
  // Inflight journal might have been recreated by a concurrent request — clean again.
  clearInflight()

  // 4) LoRAs and external model folders → defaults (before resetting config.ini,
  //    so paths are resolved from the active backend).
  try {
    resetLorasToDefaults()
  } catch (e) {
    warnings.push(`LoRA: ${e instanceof Error ? e.message : String(e)}`)
  }
  try {
    writeExtraModelPathsYaml([])
  } catch (e) {
    warnings.push(`extra_model_paths: ${e instanceof Error ? e.message : String(e)}`)
  }

  // 5) Settings → defaults.
  try {
    resetConfigToDefaults()
  } catch (e) {
    errors.push(`config.ini: ${e instanceof Error ? e.message : String(e)}`)
  }

  return NextResponse.json({
    ok: errors.length === 0,
    deleted,
    details,
    errors,
    warnings,
  })
}
