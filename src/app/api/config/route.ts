import { NextResponse } from 'next/server'
import { statSync, readdirSync } from 'fs'
import { join, resolve, basename } from 'path'
import { getAppConfig, setConfigValue } from '@/lib/app-config'
import { llmStatus, stopLlm } from '@/lib/llm-runner'
import { sttStatus, stopStt } from '@/lib/stt-runner'
import { writeExtraModelPathsYaml, EXTRA_CATEGORIES } from '@/lib/extra-model-paths'

/** (fix 262) Directory exists as folder (for UI indicator and validation). */
function isExistingDir(p: string): boolean {
  try { return statSync(p).isDirectory() } catch { return false }
}

/**
 * (fix 308) Resolve "custom LLM": value can be a .gguf FILE
 * (returned as-is) or a FOLDER — in which case we take the first matching file
 * inside it (subsequent code always expects a file: llm_server.py opens
 * the path via open('rb')). For mmproj we look for a file with 'mmproj' in name
 * (or .mmproj extension); for model — .gguf WITHOUT 'mmproj' in name.
 * Returns { path } on success or { error } with text for 400.
 *
 * (release) Three fixes:
 *  1. VERIFY FILE EXTENSION. Previously ANY file was accepted — including
 *     README.md or image: config accepted value, while error surfaced
 *     only when launching LLM, with cryptic message from llama.cpp.
 *  2. Search IN SUBFOLDERS (2 levels). The studio organizes LLM models in
 *     subfolders (llm/qwen3.5-9b/…), and the folder selected by user almost
 *     always contains the model in a subfolder rather than root.
 *  3. Result is an ABSOLUTE path (resolve). Relative path from
 *     config.ini was resolved against process CWD and silently broke when moving
 *     folder or starting outside project root.
 */
function resolveGgufPath(input: string, kind: 'model' | 'mmproj'): { path: string } | { error: string } {
  const isModel = kind === 'model'
  const label = isModel ? 'Model file' : 'mmproj file'
  let st
  try { st = statSync(input) } catch {
    return { error: `${label} not found: ${input}` }
  }

  if (st.isFile()) {
    const lower = input.toLowerCase()
    const isGguf = lower.endsWith('.gguf') || lower.endsWith('.mmproj')
    if (!isGguf) {
      return { error: `${label} must be a .gguf file (specified: ${basename(input)})` }
    }
    // For model: mmproj file is not a model. For mmproj: .gguf extension
    // is acceptable (actual projectors are named mmproj-F16.gguf etc.).
    if (isModel && lower.includes('mmproj')) {
      return { error: 'This is an mmproj file (vision projector), not a model — specify model .gguf' }
    }
    return { path: resolve(input) }
  }

  if (!st.isDirectory()) {
    return { error: `Path is not a file or directory: ${input}` }
  }

  // Collect candidates: first folder root, then subfolders (2 levels).
  // Sort by full path — deterministic selection.
  const candidates: string[] = []
  const collect = (dir: string, depth: number) => {
    if (depth > 2) return
    let entries: string[]
    try { entries = readdirSync(dir) } catch { return }
    for (const name of entries) {
      const full = join(dir, name)
      let isDir = false
      try { isDir = statSync(full).isDirectory() } catch { /* ignore */ }
      if (isDir) collect(full, depth + 1)
      else candidates.push(full)
    }
  }
  collect(input, 0)
  candidates.sort()

  const ggufs = candidates.filter(
    (f) => f.toLowerCase().endsWith('.gguf') || f.toLowerCase().endsWith('.mmproj'),
  )
  const match = isModel
    ? ggufs.find((f) => f.toLowerCase().endsWith('.gguf') && !f.toLowerCase().includes('mmproj'))
    : (ggufs.find((f) => f.toLowerCase().includes('mmproj')) ??
       ggufs.find((f) => f.toLowerCase().endsWith('.mmproj')))

  if (!match) {
    return {
      error: isModel
        ? `No .gguf model found in folder: ${input}`
        : `No mmproj file found in folder: ${input}`,
    }
  }
  return { path: resolve(match) }
}

/**
 * GET /api/config — runtime app settings (config.ini).
 * POST /api/config — update settings: { reserve_gb?, dynamic_vram?, llm_device?, comfy_dir? }.
 *
 * comfy_dir is the root of the portable backend install (the folder that
 * contains ComfyUI/ and python_embeded/). Changing it re-points every
 * file route immediately — no restart needed.
 *
 * llm_device ('auto'|'gpu'|'cpu') re-modes the LLM assistant: the running
 * instance (if any) is stopped so the next chat message reloads it with
 * the new device.
 */
export async function GET() {
  try {
    const config = getAppConfig()
    return NextResponse.json({
      reserve_gb: config.reserveGb,
      dynamic_vram: config.dynamicVram,
      vram_headroom: config.vramHeadroom, // (fix 490)
      llm_device: config.llmDevice,
      llm_context_size: config.llmContextSize,
      llm_max_output_tokens: config.llmMaxOutputTokens,
      comfy_dir: config.comfyRoot,
      diffusion_model: config.diffusionModel,
      llm_model: config.llmModel,
      // (fix 136 / Bonsai) portable build folder for Bonsai 2 27B
      llm_bonsai_dir: config.llmBonsaiDir,
      // (fix 257) custom LLM (.gguf + mmproj) and external model folders
      llm_custom_model: config.llmCustomModel,
      llm_custom_mmproj: config.llmCustomMmproj,
      model_extra_paths: config.modelExtraPaths.map((e) => ({ ...e, exists: isExistingDir(e.path) })),
      // (fix 53) assistant video vision — default false
      llm_video_vision: config.llmVideoVision,
      // (fix 109) LLM KV-cache quantization — default off (fp16)
      llm_kv_cache: config.llmKvCache,
      // (fix 135b) fine-tuning LLM sampling
      llm_sampling_override: config.llmSamplingOverride,
      llm_temperature: config.llmTemperature,
      llm_top_p: config.llmTopP,
      llm_top_k: config.llmTopK,
      llm_min_p: config.llmMinP,
      llm_presence_penalty: config.llmPresencePenalty,
      llm_frequency_penalty: config.llmFrequencyPenalty,
      llm_repeat_penalty: config.llmRepeatPenalty,
      sound_on: config.soundOn,
      // (fix 65) voice input — whisper STT (CPU)
      stt_enabled: config.sttEnabled,
      stt_dir: config.sttDir,
      stt_model: config.sttModel,
      stt_language: config.sttLanguage,
      stt_threads: config.sttThreads,
      // (fix 386) video save format ([video] in config.ini)
      video_codec: config.videoCodec,
      video_crf: config.videoCrf,
      video_nvenc_bitrate: config.videoNvencBitrate,
    })
  } catch {
    // (fix 119) defaults: context 25K, KV cache Q4
    // (fix 135b) sampling — override off, values model-aware
    // (fix 316) llm_bonsai_dir/llm_custom_*/model_extra_paths — defaults
    // so GET contract on error matches normal response.
    return NextResponse.json({ reserve_gb: 3, dynamic_vram: true, vram_headroom: 2, llm_device: 'auto', llm_context_size: 25600, llm_max_output_tokens: 4096, comfy_dir: '', diffusion_model: '', llm_model: '', llm_bonsai_dir: '', llm_custom_model: '', llm_custom_mmproj: '', model_extra_paths: [], llm_video_vision: true, llm_kv_cache: 'q4_0', llm_sampling_override: false, llm_temperature: 0.7, llm_top_p: 0.95, llm_top_k: 40, llm_min_p: 0.05, llm_presence_penalty: 0.0, llm_frequency_penalty: 0.0, llm_repeat_penalty: 1.0, sound_on: true, stt_enabled: true, stt_dir: '', stt_model: '', stt_language: 'ru', stt_threads: 0, video_codec: 'h264', video_crf: 12, video_nvenc_bitrate: 16 })
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json()

    // (fix 716) VALIDATION BEFORE WRITING. Previously checks were performed during
    // processing, while writes to config.ini had ALREADY happened. On
    // error (non-existent ComfyUI/Bonsai folder, corrupted .gguf, missing
    // model folder) client received 400, but codec/CRF/VRAM/device/context were
    // already written — config divergence without a single error. Now all
    // "potentially returning 400" fields are checked IN ADVANCE, and on any error
    // NOT A SINGLE value is written.
    const pre: {
      comfyDir?: string
      bonsaiDir?: string
      sttDir?: string
      customModel?: string
      customMmproj?: string
      extraPaths?: Array<{ path: string; category: string }>
    } = {}

    if (typeof body.comfy_dir === 'string') {
      const v = body.comfy_dir.trim()
      if (v && !isExistingDir(v)) {
        return NextResponse.json(
          { error: `ComfyUI folder not found: ${v}` },
          { status: 400 },
        )
      }
      pre.comfyDir = v
    }

    if (typeof body.llm_bonsai_dir === 'string') {
      const v = body.llm_bonsai_dir.trim()
      if (v && !isExistingDir(v)) {
        return NextResponse.json(
          { error: `Bonsai folder not found: ${v}` },
          { status: 400 },
        )
      }
      pre.bonsaiDir = v
    }

    // (release) STT runtime folder — same contract as comfy_dir and
    // llm_bonsai_dir: non-empty value = existing directory. Previously path
    // was written to config as-is, and typos surfaced only when starting
    // dictation ("STT server failed to start"), already during work.
    if (typeof body.stt_dir === 'string') {
      const v = body.stt_dir.trim()
      if (v && !isExistingDir(v)) {
        return NextResponse.json(
          { error: `Voice input folder not found: ${v}` },
          { status: 400 },
        )
      }
      pre.sttDir = v
    }

    if (typeof body.llm_custom_model === 'string') {
      const v = body.llm_custom_model.trim()
      if (v) {
        const r = resolveGgufPath(v, 'model')
        if ('error' in r) {
          return NextResponse.json({ error: r.error }, { status: 400 })
        }
        pre.customModel = r.path
      } else {
        pre.customModel = ''
      }
    }

    if (typeof body.llm_custom_mmproj === 'string') {
      const v = body.llm_custom_mmproj.trim()
      if (v) {
        const r = resolveGgufPath(v, 'mmproj')
        if ('error' in r) {
          return NextResponse.json({ error: r.error }, { status: 400 })
        }
        pre.customMmproj = r.path
      } else {
        pre.customMmproj = ''
      }
    }

    if (Array.isArray(body.model_extra_paths)) {
      const validCats = new Set(EXTRA_CATEGORIES.map((c) => c.key))
      const entries = (body.model_extra_paths as unknown[])
        .filter(
          (e): e is { path: string; category: string } =>
            !!e && typeof e === 'object' &&
            typeof (e as { path?: unknown }).path === 'string' &&
            typeof (e as { category?: unknown }).category === 'string' &&
            validCats.has((e as { category?: unknown }).category as string),
        )
        .map((e) => ({ path: e.path.trim(), category: e.category }))
        .filter((e) => e.path.length > 0)
      if (entries.length > 0) {
        const missing = entries.filter((e) => !isExistingDir(e.path))
        if (missing.length > 0) {
          return NextResponse.json(
            { error: `Folders not found: ${missing.map((e) => e.path).join(', ')}` },
            { status: 400 },
          )
        }
      }
      pre.extraPaths = entries
    }

    // (fix 386) Video save format: applied to ALL new
    // tasks (generation/refine/extend/tiles/FPS/trim/concat) without
    // restart — templates read config when assembling workflow.
    if (body.video_codec !== undefined) {
      const codec = ['h264', 'h265', 'nvenc_h264', 'nvenc_h265'].includes(body.video_codec)
        ? body.video_codec
        : 'h264'
      setConfigValue('video', 'codec', codec)
    }
    if (body.video_crf !== undefined) {
      // (fix 556) crf=0 is valid (0–30, lower = better): parseInt()||12
      // turned saved 0 into default 12 — default only for non-number.
      const parsedCrf = parseInt(body.video_crf, 10)
      const crf = Math.max(0, Math.min(30, Number.isFinite(parsedCrf) ? parsedCrf : 12))
      setConfigValue('video', 'crf', String(crf))
    }
    if (body.video_nvenc_bitrate !== undefined) {
      const br = Math.max(4, Math.min(40, parseInt(body.video_nvenc_bitrate, 10) || 16))
      setConfigValue('video', 'nvenc_bitrate', String(br))
    }

    if (body.reserve_gb !== undefined) {
      // (fix 315) Range unified with UI slider: 1–16 GB
      const reserveGb = Math.max(1, Math.min(16, parseFloat(body.reserve_gb) || 3))
      setConfigValue('vram', 'reserve_gb', String(reserveGb))
    }

    if (body.dynamic_vram !== undefined) {
      // Written to [vram] next to reserve_gb — start_comfy.bat reads both
      // from there (single source of truth; [comfy] was a legacy duplicate).
      setConfigValue('vram', 'dynamic_vram', body.dynamic_vram ? '1' : '0')
    }

    // (fix 490) Extra free VRAM headroom for DynamicVRAM
    // (--vram-headroom in start_comfy.bat). 0 = off, range 0–8 GB.
    if (body.vram_headroom !== undefined) {
      const headroom = Math.max(0, Math.min(8, parseFloat(body.vram_headroom) || 0))
      setConfigValue('vram', 'vram_headroom', String(headroom))
    }

    if (body.llm_device !== undefined) {
      const dev = ['auto', 'gpu', 'cpu'].includes(body.llm_device) ? body.llm_device : 'auto'
      // Restart ONLY on actual change: dialog always sends
      // device/ctx/kv_cache, and "Save" without changes was killing the loaded
      // model with a cold reload on the next message.
      const changed = getAppConfig().llmDevice !== dev
      setConfigValue('llm', 'device', dev)
      // Re-mode the running assistant: stop it so the next chat message
      // reloads the model on the newly selected device.
      if (changed && llmStatus().running) await stopLlm()
    }

    if (body.llm_context_size !== undefined) {
      // (fix 119) max context — 100K tokens, default — 25K
      const ctx = Math.max(4096, Math.min(102400, parseInt(body.llm_context_size, 10) || 25600))
      const ctxChanged = getAppConfig().llmContextSize !== ctx
      setConfigValue('llm', 'context_size', String(ctx))
      // Context size is baked into the Llama instance — restart to apply.
      if (ctxChanged && llmStatus().running) await stopLlm()
    }

    if (body.llm_max_output_tokens !== undefined) {
      const out = Math.max(256, Math.min(16384, parseInt(body.llm_max_output_tokens, 10) || 4096))
      setConfigValue('llm', 'max_output_tokens', String(out))
      // Applied per-request on the next chat message — no LLM restart needed.
    }

    // (fix 310) comfy_dir: non-empty value must be an EXISTING
    // folder (previously written blindly — and all file routes silently broke);
    // empty string = reset to default (<project>/ComfyUI-Easy-Install), previously
    // empty string was stripped and path could not be reset.
    if (typeof body.comfy_dir === 'string') {
      // (fix 716) Value already validated in pre-validation (see start of POST).
      setConfigValue('comfy', 'comfy_dir', pre.comfyDir ?? '')
    }

    if (typeof body.diffusion_model === 'string') {
      setConfigValue('comfy', 'diffusion_model', body.diffusion_model.trim())
    }

    if (typeof body.llm_model === 'string') {
      const modelChanged = getAppConfig().llmModel !== body.llm_model.trim()
      setConfigValue('llm', 'model', body.llm_model.trim())
      // Model file change requires LLM restart to load the new file.
      if (modelChanged && llmStatus().running) await stopLlm()
    }

    // (fix 136 / Bonsai) external Bonsai build folder: path change requires
    // assistant restart (model files are loaded from this directory).
    // (fix 310) non-empty value — only existing folder (400 otherwise);
    // empty string = reset to default (<project>/Bonsai_2_27B).
    if (typeof body.llm_bonsai_dir === 'string') {
      // (fix 716) Checked in pre-validation.
      const v = pre.bonsaiDir ?? ''
      const dirChanged = getAppConfig().llmBonsaiDir !== v
      setConfigValue('llm', 'bonsai_dir', v)
      if (dirChanged && llmStatus().running) await stopLlm()
    }

    // (fix 257) Custom LLM: paths to .gguf and mmproj. Empty string is valid
    // value (return to built-in models). Change — with LLM restart.
    // (fix 262) Non-empty path — verify existence BEFORE writing to config:
    // silence (yaml without entries / assistant "model not found") is the worst
    // outcome, explicit error immediately.
    // (fix 308) Value can be file OR folder (UI offers selecting
    // folder): folder resolves to first matching file inside it, and config
    // stores the specific FILE — subsequent code (llm_server.py:
    // open(model_path,'rb')) always expects a file.
    if (typeof body.llm_custom_model === 'string') {
      // (fix 716) Resolved path already computed and validated in pre-validation.
      const resolved = pre.customModel ?? ''
      const changed = getAppConfig().llmCustomModel !== resolved
      setConfigValue('llm', 'custom_model_path', resolved)
      if (changed && llmStatus().running) await stopLlm()
    }
    if (typeof body.llm_custom_mmproj === 'string') {
      // (fix 716) Resolved path already computed and validated in pre-validation.
      const resolved = pre.customMmproj ?? ''
      const changed = getAppConfig().llmCustomMmproj !== resolved
      setConfigValue('llm', 'custom_mmproj_path', resolved)
      if (changed && llmStatus().running) await stopLlm()
    }

    // (fix 257) External model folders: save list + rewrite
    // ComfyUI/extra_model_paths.yaml (fork reads it at startup).
    let extraPathsRestart = false
    if (Array.isArray(body.model_extra_paths)) {
      // (fix 716) List already normalized and validated in pre-validation.
      const entries = pre.extraPaths ?? []
      const prev = getAppConfig().modelExtraPaths
      const same =
        prev.length === entries.length &&
        prev.every((p, i) => p.path === entries[i].path && p.category === entries[i].category)
      setConfigValue('models', 'extra_paths', JSON.stringify(entries))
      if (!same) extraPathsRestart = writeExtraModelPathsYaml(entries)
    }

    // (fix 53) Assistant video vision: applied to each chat
    // request — no LLM restart needed.
    if (typeof body.llm_video_vision === 'boolean') {
      setConfigValue('llm', 'video_vision', body.llm_video_vision ? '1' : '0')
    }

    // (fix 109) LLM KV-cache quantization: parameter is baked into Llama instance
    // (type_k/type_v) upon context creation — running server is restarted,
    // new one loads with selected type.
    if (typeof body.llm_kv_cache === 'string' && ['off', 'q8_0', 'q5_1', 'q4_0'].includes(body.llm_kv_cache)) {
      const kvChanged = getAppConfig().llmKvCache !== body.llm_kv_cache
      setConfigValue('llm', 'kv_cache', body.llm_kv_cache)
      if (kvChanged && llmStatus().running) await stopLlm()
    }

    // (fix 135b) Fine-tuning LLM sampling — applied to each
    // request (per-request), no LLM restart needed.
    if (typeof body.llm_sampling_override === 'boolean') {
      setConfigValue('llm', 'sampling_override', body.llm_sampling_override ? '1' : '0')
    }
    if (typeof body.llm_temperature === 'number') {
      setConfigValue('llm', 'temperature', String(Math.max(0, Math.min(2.0, body.llm_temperature))))
    }
    if (typeof body.llm_top_p === 'number') {
      setConfigValue('llm', 'top_p', String(Math.max(0, Math.min(1.0, body.llm_top_p))))
    }
    if (typeof body.llm_top_k === 'number') {
      setConfigValue('llm', 'top_k', String(Math.max(1, Math.min(200, Math.round(body.llm_top_k)))))
    }
    if (typeof body.llm_min_p === 'number') {
      setConfigValue('llm', 'min_p', String(Math.max(0, Math.min(1.0, body.llm_min_p))))
    }
    if (typeof body.llm_presence_penalty === 'number') {
      setConfigValue('llm', 'presence_penalty', String(Math.max(0, Math.min(2.5, body.llm_presence_penalty))))
    }
    if (typeof body.llm_frequency_penalty === 'number') {
      setConfigValue('llm', 'frequency_penalty', String(Math.max(0, Math.min(2.5, body.llm_frequency_penalty))))
    }
    if (typeof body.llm_repeat_penalty === 'number') {
      setConfigValue('llm', 'repeat_penalty', String(Math.max(1.0, Math.min(2.0, body.llm_repeat_penalty))))
    }

    if (typeof body.sound_on === 'boolean') {
      setConfigValue('ui', 'sound_on', body.sound_on ? '1' : '0')
    }

    // (fix 65) Voice input (whisper STT). Changes applied from
    // next dictation: running service is stopped (will restart
    // automatically upon first use with new parameters).
    let sttChanged = false
    if (typeof body.stt_enabled === 'boolean') {
      setConfigValue('stt', 'enabled', body.stt_enabled ? '1' : '0')
      sttChanged = true
    }
    // Empty string is a VALID value (reset to default <project>/stt):
    // previous guard `.trim()` silently dropped it, and custom folder survived
    // "Reset settings" and factory reset contrary to dialog promise.
    if (typeof body.stt_dir === 'string') {
      // (release) Checked in pre-validation (existing folder).
      setConfigValue('stt', 'dir', (pre.sttDir ?? '').trim())
      sttChanged = true
    }
    if (typeof body.stt_model === 'string') {
      setConfigValue('stt', 'model', body.stt_model.trim())
      sttChanged = true
    }
    if (typeof body.stt_language === 'string' && ['auto', 'ru', 'en'].includes(body.stt_language)) {
      setConfigValue('stt', 'language', body.stt_language)
      sttChanged = true
    }
    if (typeof body.stt_threads === 'number') {
      setConfigValue('stt', 'threads', String(Math.max(0, Math.min(32, Math.round(body.stt_threads)))))
      sttChanged = true
    }
    if (sttChanged && sttStatus().running) {
      await stopStt()
    }

    const config = getAppConfig()
    return NextResponse.json({
      ok: true,
      reserve_gb: config.reserveGb,
      dynamic_vram: config.dynamicVram,
      vram_headroom: config.vramHeadroom, // (fix 490)
      llm_device: config.llmDevice,
      llm_context_size: config.llmContextSize,
      llm_max_output_tokens: config.llmMaxOutputTokens,
      comfy_dir: config.comfyRoot,
      diffusion_model: config.diffusionModel,
      llm_model: config.llmModel,
      llm_custom_model: config.llmCustomModel,
      llm_custom_mmproj: config.llmCustomMmproj,
      model_extra_paths: config.modelExtraPaths,
      // (fix 257) external folders yaml changed — restart start.bat required
      restart_required: extraPathsRestart,
      llm_video_vision: config.llmVideoVision,
      llm_kv_cache: config.llmKvCache,
      llm_sampling_override: config.llmSamplingOverride,
      llm_temperature: config.llmTemperature,
      llm_top_p: config.llmTopP,
      llm_top_k: config.llmTopK,
      llm_min_p: config.llmMinP,
      llm_presence_penalty: config.llmPresencePenalty,
      llm_frequency_penalty: config.llmFrequencyPenalty,
      llm_repeat_penalty: config.llmRepeatPenalty,
      sound_on: config.soundOn,
      stt_enabled: config.sttEnabled,
      stt_dir: config.sttDir,
      stt_model: config.sttModel,
      stt_language: config.sttLanguage,
      stt_threads: config.sttThreads,
    })
  } catch {
    return NextResponse.json({ error: 'Failed to save config' }, { status: 500 })
  }
}
