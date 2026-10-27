'use client'

/**
 * Models Panel — check, download, and track progress of required model files.
 *
 * Visually divided into two sections:
 *   1. "Minimax H3 (generation)" — diffusion, text encoder, VAE, LoRA, upscaler, preview
 *   2. "LLM Assistant" — only selected quantization + mmproj
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import { Button } from '@/components/ui/button'
import {
  CheckCircleIcon,
  DownloadIcon,
  Loader2Icon,
  AlertCircleIcon,
  PackageIcon,
  RefreshCwIcon,
  CpuIcon,
  BotIcon,
  XIcon,
  Trash2Icon,
  GaugeIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

/* ─── Types ─── */

interface ModelStatus {
  id: string
  label: string
  relPath: string
  sizeLabel: string
  category: string
  status: 'ready' | 'downloading' | 'missing' | 'error'
  bytesReceived?: number
  totalBytes?: number | null
  speed?: number
  error?: string
  /** Optional model: "Download all" does not fetch it. */
  optional?: boolean
}

/* ─── Helpers ─── */

function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(1) + ' GB'
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(0) + ' MB'
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB'
  return (n / 1024).toFixed(0) + ' MB'
}

function formatSpeed(bps: number): string {
  if (bps >= 1024 ** 3) return (bps / 1024 ** 3).toFixed(1) + ' GB/s'
  if (bps >= 1024 ** 2) return (bps / 1024 ** 2).toFixed(0) + ' MB/s'
  return (bps / 1024).toFixed(0) + ' KB/s'
}

function isLlmMmproj(id: string): boolean {
  return id === 'llm_assistant_mmproj' || id === 'llm_assistant_qwen_mmproj'
}

function isLlmQuant(id: string): boolean {
  return id.startsWith('llm_assistant') && !isLlmMmproj(id)
}

function resolveSelectedLlm(llmModel: string): string {
  if (!llmModel) return 'Qwen3.5-9B-Q4_K_M.gguf'
  return llmModel
}

/** Which LLM family is selected: gemma/qwen/bonsai — determines
 *  which mmproj to show/require.
 *  'bonsai' family has its own mmproj. */
function selectedLlmFamily(llmModel: string): 'gemma' | 'qwen' | 'bonsai' {
  if (/bonsai/i.test(llmModel)) return 'bonsai'
  return /qwen/i.test(llmModel) ? 'qwen' : 'gemma'
}

/* ─── Component ─── */

export function ModelsPanel() {
  const [models, setModels] = useState<ModelStatus[]>([])
  const [loading, setLoading] = useState(true)
  const [starting, setStarting] = useState<string | null>(null)
  const [selectedLlm, setSelectedLlm] = useState('Qwen3.5-9B-Q4_K_M.gguf')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/models/status')
      if (res.ok) {
        const data = await res.json()
        setModels(data.models)
      }
    } catch { /* ignore */ }
  }, [])

  const loadConfig = useCallback(async () => {
    try {
      const res = await fetch('/api/config')
      if (res.ok) {
        const d = await res.json()
        setSelectedLlm(resolveSelectedLlm(d.llm_model || ''))
      }
    } catch { /* default */ }
  }, [])

  const startPolling = useCallback(() => {
    if (pollRef.current) return
    pollRef.current = setInterval(() => {
      void fetchStatus()
    }, 2000)
  }, [fetchStatus])

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  // Initial load
  useEffect(() => {
    void Promise.all([fetchStatus(), loadConfig()]).then(() => setLoading(false))
    return () => stopPolling()
  }, [fetchStatus, loadConfig, stopPolling])

  // Start polling if any download is active
  useEffect(() => {
    const hasActive = models.some(m => m.status === 'downloading')
    if (hasActive) {
      startPolling()
    } else {
      stopPolling()
    }
  }, [models, startPolling, stopPolling])

  // Split into three sections
  // FPS (VFI) — separate section (models-config.ts, category 'fps')
  const h3Models = models.filter(m => m.category !== 'llm' && m.category !== 'fps')
  const fpsModels = models.filter(m => m.category === 'fps')
  const family = selectedLlmFamily(selectedLlm)
  // Bonsai set is shown only when Bonsai is selected
  const isBonsai = selectedLlm === 'bonsai' || selectedLlm === 'bonsai_light'
  const llmModels = models.filter(m => {
    if (m.category !== 'llm') return false
    if (m.id.startsWith('bonsai_')) return isBonsai
    // mmproj — only for selected family (Gemma <-> Qwen3.5)
    if (m.id === 'llm_assistant_mmproj') return family === 'gemma'
    if (m.id === 'llm_assistant_qwen_mmproj') return family === 'qwen'
    if (isLlmQuant(m.id)) {
      const file = m.relPath.split('/').pop() || ''
      return file === selectedLlm
    }
    return false
  })

  const visibleModels = [...h3Models, ...llmModels]

  const download = useCallback(async (modelId: string) => {
    setStarting(modelId)
    try {
      const res = await fetch('/api/models/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId }),
      })
      const data = await res.json()
      if (!data.ok) {
        toast.error('Failed to start download', { description: data.error })
      } else {
        toast.info('Download started', { description: 'Track progress below' })
        setTimeout(() => void fetchStatus(), 500)
      }
    } catch {
      toast.error('Network error when starting download')
    } finally {
      setStarting(null)
    }
  }, [fetchStatus])

  const downloadAll = useCallback(async () => {
    // Download ONLY visible models (H3 + selected LLM family):
    // previously "Download all" pulled from full /api/models/status list
    // including quantizations of unselected LLM families.
    const visibleIds = new Set(visibleModels.map(m => m.id))
    const missing = models.filter(
      m => (m.status === 'missing' || m.status === 'error') && visibleIds.has(m.id)
        // optional models are not pulled by "Download all" —
        // only explicit "Download" button on the model itself.
        && !m.optional,
    )
    for (const m of missing) {
      await download(m.id)
    }
  }, [models, visibleModels, download])

  const cancel = useCallback(async (modelId: string) => {
    try {
      await fetch('/api/models/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId }),
      })
      toast.info('Download cancelled')
      setTimeout(() => void fetchStatus(), 300)
    } catch {
      toast.error('Failed to cancel download')
    }
  }, [fetchStatus])

  // Delete downloaded model: frees disk space when model is not needed
  // (e.g. alternative selected). Server will not delete active assistant model.
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const remove = useCallback(async (model: ModelStatus) => {
    if (!window.confirm(`Delete model files from disk?\n\n"${model.label}" (${model.sizeLabel})\n\nYou can download it again if needed.`)) return
    setDeletingId(model.id)
    try {
      const res = await fetch('/api/models/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId: model.id }),
      })
      if (res.ok) {
        toast.success('Model deleted from disk')
      } else {
        const d = await res.json().catch(() => ({}))
        toast.error('Failed to delete model', { description: d.error || `HTTP ${res.status}` })
      }
    } catch {
      toast.error('Failed to delete model')
    } finally {
      setDeletingId(null)
      setTimeout(() => void fetchStatus(), 300)
    }
  }, [fetchStatus])

  // Optional models (Veda, FPS, etc.) are NOT included in the counter:
  // otherwise panel would constantly show "8/9" in yellow and keep "Download all"
  // button active, even though "Download all" does not fetch them.
  const requiredModels = visibleModels.filter(m => !m.optional)
  const readyCount = requiredModels.filter(m => m.status === 'ready').length
  const totalCount = requiredModels.length
  const allReady = readyCount === totalCount

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2Icon className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <PackageIcon className="w-4 h-4 text-cyan-400" />
          <span className="text-sm font-medium">Models</span>
          <span className={cn(
            'text-xs px-1.5 py-0.5 rounded',
            allReady ? 'bg-emerald-500/15 text-emerald-400' : 'bg-amber-500/15 text-amber-400',
          )}>
            {readyCount}/{totalCount}
          </span>
        </div>
        <div className="flex gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={() => void fetchStatus()}
          >
            <RefreshCwIcon className="w-3 h-3" />
          </Button>
          {!allReady && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={() => void downloadAll()}
              disabled={!!starting}
            >
              <DownloadIcon className="w-3 h-3" />
              Download all
            </Button>
          )}
        </div>
      </div>

      {/* ─── Section 1: Minimax H3 ─── */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-2 px-1 pt-1">
          <CpuIcon className="w-3.5 h-3.5 text-cyan-500/70" />
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Minimax H3 (generation)
          </span>
        </div>
        {h3Models.map(model => (
          <ModelRow
            key={model.id}
            model={model}
            onDownload={() => void download(model.id)}
            onCancel={() => void cancel(model.id)}
            onDelete={() => void remove(model)}
            deleting={deletingId === model.id}
            starting={starting === model.id}
          />
        ))}
      </div>

      {/* ─── Section: FPS (VFI) ─── */}
      {fpsModels.length > 0 && (
        <div className="space-y-1.5 pt-2 border-t border-border">
          <div className="flex items-center gap-2 px-1 pt-1">
            <GaugeIcon className="w-3.5 h-3.5 text-cyan-500/70" />
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              FPS (frame interpolation)
            </span>
          </div>
          {fpsModels.map(model => (
            <ModelRow
              key={model.id}
              model={model}
              onDownload={() => void download(model.id)}
              onCancel={() => void cancel(model.id)}
              onDelete={() => void remove(model)}
              deleting={deletingId === model.id}
              starting={starting === model.id}
            />
          ))}
        </div>
      )}

      {/* ─── Section 2: LLM ─── */}
      {llmModels.length > 0 && (
        <div className="space-y-1.5 pt-2 border-t border-border">
          <div className="flex items-center gap-2 px-1 pt-1">
            <BotIcon className="w-3.5 h-3.5 text-violet-500/70" />
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              LLM Assistant
            </span>
          </div>
          {llmModels.map(model => (
            <ModelRow
              key={model.id}
              model={model}
              onDownload={() => void download(model.id)}
              onCancel={() => void cancel(model.id)}
              onDelete={() => void remove(model)}
              deleting={deletingId === model.id}
              starting={starting === model.id}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/* ─── Single model row ─── */

function ModelRow({
  model,
  onDownload,
  onCancel,
  onDelete,
  starting,
  deleting,
}: {
  model: ModelStatus
  onDownload: () => void
  onCancel?: () => void
  onDelete?: () => void
  starting: boolean
  deleting?: boolean
}) {
  const progress = model.totalBytes
    ? Math.min(100, ((model.bytesReceived || 0) / model.totalBytes) * 100)
    : null

  return (
    <div className={cn(
      'flex items-center gap-3 px-3 py-2 rounded-lg border',
      model.status === 'ready' && 'border-emerald-500/20 bg-emerald-500/5',
      model.status === 'downloading' && 'border-cyan-500/30 bg-cyan-500/5',
      model.status === 'missing' && 'border-border',
      model.status === 'error' && 'border-red-500/30 bg-red-500/5',
    )}>
      {/* Status icon */}
      <div className="shrink-0">
        {model.status === 'ready' && <CheckCircleIcon className="w-4 h-4 text-emerald-400" />}
        {model.status === 'downloading' && <Loader2Icon className="w-4 h-4 animate-spin text-cyan-400" />}
        {model.status === 'missing' && <DownloadIcon className="w-4 h-4 text-muted-foreground" />}
        {model.status === 'error' && <AlertCircleIcon className="w-4 h-4 text-red-400" />}
      </div>

      {/* Label + size */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-xs truncate">{model.label}</span>
          <span className="text-[10px] text-muted-foreground shrink-0">{model.sizeLabel}</span>
          {/* "optional" badge — clarifies why model is excluded from counter and "Download all". */}
          {model.optional && (
            <span className="shrink-0 px-1 py-px rounded text-[9px] border border-border/60 text-muted-foreground/80">
              optional
            </span>
          )}
        </div>

        {/* Progress bar (when downloading) */}
        {model.status === 'downloading' && (
          <div className="mt-1.5 space-y-0.5">
            <div className="h-1.5 rounded-full bg-[var(--surface-2)] overflow-hidden">
              <div
                className="h-full bg-cyan-400 rounded-full transition-all duration-500"
                style={{ width: `${progress ?? 0}%` }}
              />
            </div>
            <div className="flex justify-between text-[10px] text-muted-foreground">
              <span>
                {formatBytes(model.bytesReceived || 0)}
                {model.totalBytes ? ` / ${formatBytes(model.totalBytes)}` : ''}
              </span>
              <span>
                {model.speed ? formatSpeed(model.speed) : ''}
                {progress !== null ? ` · ${progress.toFixed(1)}%` : ''}
              </span>
            </div>
          </div>
        )}

        {/* Error */}
        {model.status === 'error' && model.error && (
          <p className="text-[10px] text-red-400 mt-0.5 truncate">{model.error}</p>
        )}
      </div>

      {/* Action buttons */}
      {(model.status === 'missing' || model.status === 'error') && (
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs shrink-0"
          onClick={onDownload}
          disabled={starting}
        >
          {starting ? <Loader2Icon className="w-3 h-3 animate-spin" /> : 'Download'}
        </Button>
      )}
      {model.status === 'downloading' && onCancel && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs shrink-0 text-red-400 hover:text-red-300 hover:bg-red-500/10"
          onClick={onCancel}
        >
          <XIcon className="w-3.5 h-3.5" />
        </Button>
      )}
      {/* Delete downloaded/corrupted — free up disk space.
          Active assistant model is blocked by server (409 + toast). */}
      {(model.status === 'ready' || model.status === 'error') && onDelete && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs shrink-0 text-muted-foreground hover:text-red-400 hover:bg-red-500/10"
          onClick={onDelete}
          disabled={deleting}
          title="Delete model files from disk"
        >
          {deleting ? <Loader2Icon className="w-3.5 h-3.5 animate-spin" /> : <Trash2Icon className="w-3.5 h-3.5" />}
        </Button>
      )}
    </div>
  )
}