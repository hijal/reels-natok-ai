'use client'

/**
 * LLM Model Selector — dropdown to switch between LLM models/quantizations:
 * Gemma 4 12B (Q3_K_M / Q4_K_M / Q5_K_M) or Qwen3.5 9B (edit 52).
 * Listed with VRAM recommendations. (edit 48)
 */
import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import { BotIcon, Loader2Icon } from 'lucide-react'
import { MODELS } from '@/lib/models-config'

interface LlmModelOption {
  id: string
  label: string
  filename: string
  sizeLabel: string
}

/** Default assistant model — Qwen3.5 9B. */
export const DEFAULT_LLM_MODEL_ID = 'llm_assistant_qwen'
const DEFAULT_LLM_MODEL_FILE = 'Qwen3.5-9B-Q4_K_M.gguf'

/**
 * Model size is retrieved from the registry (models-config.ts) instead of hardcoding:
 * avoids selector labels diverging from actual files on disk.
 *
 * Virtual ids ('llm_assistant_bonsai*') are resolved to their source entry.
 */
function sizeOf(modelId: string): string {
  const def = MODELS.find((m) => m.id === modelId)
  return def?.sizeLabel ?? '—'
}

const LLM_OPTIONS: LlmModelOption[] = [
  // (edit 136) Bonsai 2 27B — ternary quantization of Qwen family on llama.cpp fork (PrismML).
  // 'bonsai' value = special marker in config [llm] model.
  {
    id: 'llm_assistant_bonsai',
    label: `Bonsai 2 27B · ternary (27B in ${sizeOf('bonsai_model')}, vision)`,
    filename: 'bonsai',
    sizeLabel: sizeOf('bonsai_model'),
  },
  // (edit 168) Bonsai 2 27B PTQ1_0 — lightest quantization for <=8 GB GPUs.
  // 'bonsai_light' value = use PTQ1_0 instead of PQ2_0.
  {
    id: 'llm_assistant_bonsai_light',
    label: `Bonsai 2 27B · PTQ1_0 (lightest, ${sizeOf('bonsai_model_light')}, for GPUs ≤8 GB)`,
    filename: 'bonsai_light',
    sizeLabel: sizeOf('bonsai_model_light'),
  },
  {
    id: 'llm_assistant',
    label: `Gemma 4 12B · Q4_K_M (balanced, ${sizeOf('llm_assistant')})`,
    filename: 'gemma-4-12b-it-Q4_K_M.gguf',
    sizeLabel: sizeOf('llm_assistant'),
  },
  {
    id: 'llm_assistant_q3',
    label: `Gemma 4 12B · Q3_K_M (light, ${sizeOf('llm_assistant_q3')}, ~8 GB VRAM)`,
    filename: 'gemma-4-12b-it-Q3_K_M.gguf',
    sizeLabel: sizeOf('llm_assistant_q3'),
  },
  {
    id: 'llm_assistant_q5',
    label: `Gemma 4 12B · Q5_K_M (max quality, ${sizeOf('llm_assistant_q5')}, ~12 GB VRAM)`,
    filename: 'gemma-4-12b-it-Q5_K_M.gguf',
    sizeLabel: sizeOf('llm_assistant_q5'),
  },
  // Qwen3.5 9B (edit 52): alternative for lower-spec machines — 5.7 GB weights,
  // multimodal (images + video). Requires modern llama.cpp (qwen35).
  {
    id: 'llm_assistant_qwen',
    label: `Qwen3.5 9B · Q4_K_M (vision, light, ${sizeOf('llm_assistant_qwen')})`,
    filename: 'Qwen3.5-9B-Q4_K_M.gguf',
    sizeLabel: sizeOf('llm_assistant_qwen'),
  },
]

export function LlmModelSelector() {
  const [selected, setSelected] = useState(DEFAULT_LLM_MODEL_FILE)
  const [saving, setSaving] = useState(false)
  // Custom GGUF model path from config: when set — "Custom model" appears in list,
  // and is selected when backend=custom.
  const [customPath, setCustomPath] = useState('')

  useEffect(() => {
    fetch('/api/config')
      .then((r) => r.json())
      .then((d) => {
        const custom = typeof d.llm_custom_model === 'string' ? d.llm_custom_model.trim() : ''
        setCustomPath(custom)
        const m = typeof d.llm_model === 'string' ? d.llm_model : ''
        if (custom && (m === '' || m === 'llm_custom')) {
          setSelected('llm_custom')
        } else {
          setSelected(m || DEFAULT_LLM_MODEL_FILE)
        }
      })
      .catch(() => {})
  }, [])

  const save = useCallback(async (filename: string) => {
    setSaving(true)
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ llm_model: filename }),
      })
      if (res.ok) {
        // Unload active LLM: otherwise it continues responding with the OLD model
        // while chat routes use the protocol/sampling of the NEW one (for
        // standard <-> bonsai backend switches this is incompatible /chat vs /v1/chat/completions).
        // Race condition guarded by config signature in ensureLlm (llm-runner.ts).
        void fetch('/api/llm/stop', { method: 'POST' }).catch(() => {})
        if (filename === 'llm_custom') {
          toast.success('LLM: custom model (GGUF)', {
            description: 'The assistant will restart with it on the next message.',
          })
        } else {
          const opt = LLM_OPTIONS.find((o) => o.filename === filename)
          toast.success(
            `LLM: ${opt?.label ?? (filename || 'Qwen3.5 9B')}`,
            { description: 'The assistant will restart with it on the next message.' },
          )
        }
      }
    } catch {
      toast.error('Failed to save')
    } finally {
      setSaving(false)
    }
  }, [])

  const handleSelect = (value: string) => {
    setSelected(value)
    void save(value)
  }

  // Base name of custom model file for option label (path may be a directory or file).
  const customBase = customPath.split(/[\\/]/).filter(Boolean).pop() ?? ''

  return (
    <div className="space-y-2 pt-2 border-t border-border">
      <div className="flex items-center gap-2">
        <BotIcon className="w-3.5 h-3.5 text-muted-foreground" />
        <span className="text-xs text-muted-foreground">Assistant model</span>
        {saving && <Loader2Icon className="w-3 h-3 animate-spin text-muted-foreground" />}
      </div>
      <select
        value={selected}
        onChange={(e) => handleSelect(e.target.value)}
        disabled={saving}
        className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-cyan-500/50"
      >
        {customPath && (
          <option value="llm_custom">Custom model (GGUF): {customBase}</option>
        )}
        {LLM_OPTIONS.map((opt) => (
          <option key={opt.id} value={opt.filename}>
            {opt.label} — {opt.sizeLabel}
          </option>
        ))}
      </select>
      <p className="text-[10px] text-muted-foreground/50">
        {customPath
          ? 'Custom model is configured via path below; choosing a built-in model switches back (path is retained).'
          : 'Qwen3.5 9B — default model (8–12 GB VRAM) · Bonsai 2 27B — optional ternary model · PTQ1_0 — lightest (≤8 GB) · Gemma Q3 — 8 GB VRAM · Q4 — 12 GB · Q5 — 16+ GB'}
      </p>
    </div>
  )
}
