/**
 * Custom LoRA management (fix 44).
 *
 * Stores settings for LoRAs in a JSON file in the project root.
 * The built-in turbo LoRA is stored here too: it is ON by default, while
 * user LoRAs are OFF by default.
 *
 * File: loras.json
 * Schema: [{ name: string, strength: number, enabled: boolean, trigger?: string }]
 */
import fs from 'fs'
import path from 'path'
import { getAppConfig } from './app-config'
import { listExternalModels } from './extra-model-paths'

export interface LoraEntry {
  /** Filename in ComfyUI models/loras/ (e.g. "my_lora.safetensors") */
  name: string
  /** Strength (0.0 – 2.0). */
  strength: number
  /** Whether this LoRA is included in generation. */
  enabled: boolean
  /** Trigger words — appended to the prompt when this LoRA is enabled. */
  trigger?: string
}

/** The built-in turbo LoRA filename (ON by default, skipped in flf+audio). */
export const TURBO_LORA_NAME = 'minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors'

function lorasFile(): string {
  return path.join(process.cwd(), 'data', 'loras.json')
}

export function loadLoras(): LoraEntry[] {
  let entries: LoraEntry[] = []
  try {
    const raw = fs.readFileSync(lorasFile(), 'utf-8')
    const arr = JSON.parse(raw)
    if (Array.isArray(arr)) {
      entries = arr.filter((e) => e && typeof e.name === 'string')
    }
  } catch {
    entries = []
  }
  // The built-in turbo LoRA is enabled by default. If the file exists but an entry
  // in loras.json does not exist yet (first launch / older installation), we add
  // a synthetic enabled entry. Explicit user entry (including
  // enabled=false) always takes precedence — turbo LoRA can be disabled in settings.
  if (!entries.some((e) => e.name === TURBO_LORA_NAME)) {
    const files = listLoraFiles()
    if (files.includes(TURBO_LORA_NAME)) {
      entries.push({ name: TURBO_LORA_NAME, strength: 1.0, enabled: true, trigger: '' })
    }
  }
  return entries
}

export function saveLoras(entries: LoraEntry[]): void {
  fs.writeFileSync(lorasFile(), JSON.stringify(entries, null, 2), 'utf-8')
}

/**
 * (fix 130) Reset LoRA settings to defaults:
 * default strength (1.0), triggers cleared. The loras.json file is saved
 * with a "clean" state.
 *
 * By default after factory reset, the standard 4-step
 * turbo LoRA (TURBO_LORA_NAME) is enabled — it is needed for basic generation operation.
 * Other custom LoRAs are disabled.
 */
export function resetLorasToDefaults(): LoraEntry[] {
  const files = listLoraFiles()
  // Built-in turbo LoRA — ON by default, user-defined ones — OFF.
  const defaults: LoraEntry[] = files.map((name) => ({
    name,
    strength: 1.0,
    enabled: name === TURBO_LORA_NAME,
    trigger: '',
  }))
  saveLoras(defaults)
  return defaults
}

/** Path to the ComfyUI models/loras/ directory. */
export function lorasDir(): string {
  const cfg = getAppConfig()
  return path.join(cfg.comfyRoot, 'ComfyUI', 'models', 'loras')
}

/** List all .safetensors files in the LoRAs folder.
 *  (fix 95) Turbo LoRA is now in the general list — managed like a normal one
 *  (on/off, strength, deletion); separate panel in settings was removed. */
export function listLoraFiles(): string[] {
  const dir = lorasDir()
  try {
    const local = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.safetensors')) // (fix 82) duplicate condition removed
    // (fix 257) External folders (Settings → Custom model folders): LoRAs
    // from collections outside the studio — names as ComfyUI sees them (yaml).
    const external = listExternalModels('loras')
      .filter((n) => n.toLowerCase().endsWith('.safetensors'))
      .filter((n) => !local.includes(n))
    return [...local, ...external].sort()
  } catch {
    return []
  }
}

/**
 * (fix 483) Enabled LoRAs for refine / tile-upscale / controlnet routes
 * (the generate route builds its own list — it needs to skip turbo separately
 * in "Frames" mode with audio). Built-in turbo LoRA is included in the list when
 * enabled (by default — yes). Filters: entry is enabled and the file actually
 * exists on disk (otherwise ComfyUI would fail loading a non-existent LoRA —
 * "ghost", fix 89).
 */
export function enabledCustomLoras(): Array<{ name: string; strength: number; trigger?: string }> {
  const files = new Set(listLoraFiles())
  return loadLoras()
    .filter((e) => e.enabled && files.has(e.name))
    .map((e) => ({ name: e.name, strength: e.strength, trigger: e.trigger }))
}

/** (fix 483) Trigger words of enabled LoRAs as a single string ('' = none). */
export function loraTriggerSuffix(
  entries: Array<{ trigger?: string }>,
): string {
  return entries
    .map((e) => e.trigger?.trim())
    .filter((t): t is string => !!t)
    .join(', ')
}