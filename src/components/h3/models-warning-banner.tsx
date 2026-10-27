'use client'

/**
 * ModelsWarningBanner — shows a warning at the top of content
 * if one or more models are not downloaded.
 *
 * - Fetches /api/models/status and /api/config on mount.
 * - Respects the selected LLM quantization: inactive quantizations are not considered missing.
 * - Collects models with 'missing' or 'error' status (not 'ready', not 'downloading').
 * - If any exist — shows yellow banner with "Download in Settings" button.
 * - Dismissible via cross button (until page reload).
 */
import { useState, useEffect } from 'react'
import { AlertTriangleIcon, XIcon, DownloadIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface ModelStatusItem {
  id: string
  label: string
  status: string
  relPath: string
  /** optional: true — model is optional (banner does not require it) */
  optional?: boolean
}

interface ModelsWarningBannerProps {
  onOpenSettings: () => void
}

/** mmproj file ID (vision) — companion file, not the model itself */
function isLlmMmproj(id: string): boolean {
  return id === 'llm_assistant_mmproj' || id === 'llm_assistant_qwen_mmproj'
}

/** Checks whether a model is an LLM quantization (not mmproj) */
function isLlmQuant(id: string): boolean {
  return id.startsWith('llm_assistant') && !isLlmMmproj(id)
}

/** File corresponding to selected LLM (empty string = default Qwen). */
function resolveSelectedLlm(llmModel: string): string {
  if (!llmModel) return 'Qwen3.5-9B-Q4_K_M.gguf'
  return llmModel
}

/** Selected LLM family — determines which mmproj is considered required:
 *  'bonsai' family has its own mmproj, not Gemma/Qwen */
function selectedLlmFamily(llmModel: string): 'gemma' | 'qwen' | 'bonsai' {
  if (/bonsai/i.test(llmModel)) return 'bonsai'
  return /qwen/i.test(llmModel) ? 'qwen' : 'gemma'
}

export function ModelsWarningBanner({ onOpenSettings }: ModelsWarningBannerProps) {
  const [missing, setMissing] = useState<ModelStatusItem[]>([])
  const [dismissed, setDismissed] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const check = () => {
      Promise.all([
        fetch('/api/models/status'),
        fetch('/api/config'),
      ])
        .then(([statusRes, configRes]) => Promise.all([statusRes.json(), configRes.json()]))
        .then(([data, config]) => {
          const selectedLlm = resolveSelectedLlm(config.llm_model || '')
          const family = selectedLlmFamily(selectedLlm)
          // Bonsai set is considered only when Bonsai is explicitly selected.
          const isBonsaiSelected = config.llm_model === 'bonsai' || config.llm_model === 'bonsai_light'
          const notReady = (data.models ?? []).filter((m: ModelStatusItem) => {
            if (m.status === 'ready' || m.status === 'downloading') return false

            // Custom LLM is connected (Settings -> LLM, path to .gguf):
            // studio assistant models are not needed — do not require them.
            if (config.llm_custom_model && (isLlmQuant(m.id) || isLlmMmproj(m.id) || m.id.startsWith('bonsai_'))) {
              return false
            }

            // Optional models (bonsai_model_light) are not required
            if (m.optional) return false

            // Bonsai set: visible only when Bonsai is selected.
            // bonsai_mmproj is part of the set (not optional), so it is included here.
            if (m.id.startsWith('bonsai_') && !isBonsaiSelected) return false

            // LLM quantizations: check only the selected one
            if (isLlmQuant(m.id)) {
              const file = m.relPath.split('/').pop() || ''
              if (file !== selectedLlm) return false
            }

            // mmproj: check only for the selected family
            // (Gemma and Qwen3.5 have different mmproj files).
            // When Bonsai is selected (family === 'bonsai'), gemma/qwen mmproj
            // are NOT required — Bonsai has its own bonsai_mmproj.
            if (isLlmMmproj(m.id)) {
              if (family === 'bonsai') return false
              const isQwenMmproj = m.id === 'llm_assistant_qwen_mmproj'
              if (isQwenMmproj !== (family === 'qwen')) return false
            }

            return true
          })
          setMissing(notReady)
        })
        .catch(() => {
          /* API unavailable — do not show banner */
        })
        .finally(() => setLoading(false))
    }
    check()
    // Periodic recalculation: banner keeps up to date when user changes/downloads
    // models in settings without needing page reload.
    const t = setInterval(check, 15_000)
    return () => clearInterval(t)
  }, [])

  if (loading || dismissed || missing.length === 0) return null

  const label =
    missing.length === 1
      ? `Model not downloaded: ${missing[0].label}`
      : missing.length === 2
        ? `Models not downloaded: ${missing.map((m) => m.label).join(', ')}`
        : `Models not downloaded: ${missing.length}. Generation may not work properly.`

  return (
    <div className="flex items-center gap-3 px-4 py-2.5 bg-amber-500/10 border-b border-amber-500/20 shrink-0">
      <AlertTriangleIcon className="w-4 h-4 text-amber-400 shrink-0" />
      <span className="text-xs text-amber-300 flex-1 min-w-0 truncate" title={label}>
        {label}
      </span>
      <Button
        size="sm"
        variant="outline"
        className="h-7 text-xs text-amber-300 border-amber-500/30 hover:bg-amber-500/10 hover:text-amber-200 shrink-0"
        onClick={onOpenSettings}
      >
        <DownloadIcon className="w-3 h-3" />
        Download in Settings
      </Button>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="p-1 rounded hover:bg-amber-500/20 text-amber-400/70 hover:text-amber-300 shrink-0"
        title="Dismiss"
      >
        <XIcon className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}