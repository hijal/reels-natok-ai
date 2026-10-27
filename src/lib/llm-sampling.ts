/**
 * (edit 135) Fine-tuning of LLM sampling for a specific model.
 *
 * Prior to this edit, route.ts passed only `temperature` (hardcoded 0.7) to
 * llm_server, while top_p / top_k / min_p / penalties defaulted to
 * llama-cpp-python defaults (top_k=40, top_p=0.95, min_p=0.05) — which were NOT
 * optimized for our two models. Result: occasional looping, degradation of
 * the thought channel, "floating" answers.
 *
 * Now parameters are selected according to the active model family based on
 * official recommendations (unsloth / Ollama / HuggingFace) adjusted for
 * using llama.cpp rather than Ollama. Priority is STABILITY (fewer glitches)
 * rather than maximum creativity.
 *
 * (edit 135b) UI: In LLM settings there is a collapsed section "Advanced
 * sampling settings" — the user can ENABLE overrides and tweak any of the
 * 7 parameters. If override is OFF (default) — model-aware values from
 * this function are applied.
 *
 * PURE module (no Next imports) — easy to test and reuse.
 */

import { getAppConfig } from './app-config'

export interface SamplingParams {
  temperature: number
  top_p: number
  top_k: number
  min_p: number
  presence_penalty: number
  frequency_penalty: number
  repeat_penalty: number
}

const FALLBACK: SamplingParams = {
  temperature: 0.7,
  top_p: 0.95,
  top_k: 40,
  min_p: 0.05,
  presence_penalty: 0.0,
  frequency_penalty: 0.0,
  repeat_penalty: 1.0,
}

/**
 * Recommended sampling parameters for model families.
 *
 * ── Gemma 4 12B (unsloth/Gemma, HF Gemma team) ──
 *   Official: temperature=1.0, top_p=0.95, top_k=64.
 *   However, that is for Ollama; in llama.cpp/llama-cpp-python the community (r/LocalLLaMA)
 *   achieves better stability with reduced temperature. We pick 0.7 (middle ground
 *   between "too creative → degeneration" and "too rigid → repetitive").
 *   top_p=0.95 + top_k=64 — moderate tail cutoff, min_p=0.0 (Gemma does
 *   not like min_p>0), repeat_penalty=1.05 — gentle anti-looping without loss of style.
 *
 * ── Qwen3.5 9B (unsloth Qwen3.5-9B-MTP-GGUF, "Instruct general") ──
 *   temperature=0.7, top_p=0.8, top_k=20, min_p=0.0,
 *   presence_penalty=1.5 (Qwen favors presence penalty against repetition),
 *   frequency_penalty=0.0, repeat_penalty=1.0.
 *
 * ── Fallback (unknown model) ──
 *   Close to llama-cpp-python defaults, but with clean zeros for min_p/penalty
 *   to avoid surprises.
 */
const QWEN_PRESET: SamplingParams = {
  temperature: 0.7,
  top_p: 0.8,
  top_k: 20,
  min_p: 0.0,
  presence_penalty: 1.5,
  frequency_penalty: 0.0,
  repeat_penalty: 1.0,
}

const GEMMA_PRESET: SamplingParams = {
  temperature: 0.7,
  top_p: 0.95,
  top_k: 64,
  min_p: 0.0,
  presence_penalty: 0.0,
  frequency_penalty: 0.0,
  repeat_penalty: 1.05,
}

function modelSampling(modelId: string): SamplingParams {
  // (edit 136 / Bonsai) Ternary Bonsai 2 27B — Qwen family, ternary
  // quantization. Thinking is disabled (--reasoning-budget 0) → instruct recommendations
  // from authors: temp 0.7, top_p 0.80, presence_penalty 1.5; top_k 20 from
  // thinking profile (moderate tail cutoff, stability).
  if (modelId === 'llm_assistant_bonsai') {
    return { ...QWEN_PRESET }
  }
  // Qwen3.5 9B — default model (edit 99).
  if (modelId.startsWith('llm_assistant_qwen')) {
    return { ...QWEN_PRESET }
  }
  // Gemma 4 12B (Q3/Q4/Q5 — any quantization of the same family).
  if (modelId.startsWith('llm_assistant')) {
    return { ...GEMMA_PRESET }
  }
  return { ...FALLBACK }
}

/**
 * (edit 477) Sampling for CUSTOM GGUF model: family determined by filename
 * (Qwen/Gemma presets above). Previously 'llm_custom' fell back to FALLBACK without
 * presence_penalty — causing Qwen-compatible models (Qwen3.5-4B etc.) to enter loops.
 */
export function samplingForCustomModel(customPath: string): SamplingParams {
  const base = customPath.split(/[\\/]/).pop() || ''
  if (/qwen/i.test(base)) return { ...QWEN_PRESET }
  if (/gemma/i.test(base)) return { ...GEMMA_PRESET }
  return { ...FALLBACK }
}

/**
 * (edit 135b) Final sampling set: if the user ENABLED override in settings —
 * take their values from config.ini; otherwise — model-aware values from modelSampling().
 */
export function samplingForModel(modelId: string): SamplingParams {
  try {
    const cfg = getAppConfig()
    if (cfg.llmSamplingOverride) {
      return {
        temperature: cfg.llmTemperature,
        top_p: cfg.llmTopP,
        top_k: cfg.llmTopK,
        min_p: cfg.llmMinP,
        presence_penalty: cfg.llmPresencePenalty,
        frequency_penalty: cfg.llmFrequencyPenalty,
        repeat_penalty: cfg.llmRepeatPenalty,
      }
    }
    // (edit 477) Custom model: family by filename — otherwise FALLBACK
    // without presence_penalty caused Qwen-compatible models to loop.
    if (modelId === 'llm_custom') {
      return samplingForCustomModel(cfg.llmCustomModel || '')
    }
  } catch {
    /* config unavailable — fall through to model-based defaults */
  }
  return modelSampling(modelId)
}
