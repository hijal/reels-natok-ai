'use client'

/**
 * LoraSettingsPanel (edit 44) — manages LoRAs in settings.
 * Shows enabled/disabled state, strength slider, add/remove buttons.
 * The built-in turbo LoRA is shown here too: it is ON by default, user LoRAs
 * are OFF by default. In "Frames" + audio the app skips turbo automatically.
 * (edit 104) Upload progress in shared store: closing the settings dialog
 * does not reset the indicator or interrupt the upload.
 */
import { useState, useCallback, useRef, useEffect } from 'react'
import {
  PlusIcon,
  Trash2Icon,
  Loader2Icon,
  PowerIcon,
  PowerOffIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useModelUploadStore } from '@/lib/model-upload-store'

interface LoraItem {
  name: string
  strength: number
  enabled: boolean
  trigger: string
  size: number
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`
  return `${(bytes / 1024).toFixed(0)} KB`
}

function shortName(name: string): string {
  // Remove .safetensors extension and trim to reasonable length
  const base = name.replace(/\.safetensors$/i, '')
  return base.length > 35 ? base.slice(0, 32) + '…' : base
}

export function LoraSettingsPanel() {
  const [loras, setLoras] = useState<LoraItem[]>([])
  const [loading, setLoading] = useState(true)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // (edit 104) Upload state in shared store (lives outside React tree):
  // Radix unmounts panel when dialog closes, but upload and its progress
  // are preserved; reopening dialog recovers the indicator.
  const uploading = useModelUploadStore((s) => s.active && s.target === 'lora')
  const uploadProgress = useModelUploadStore((s) => s.progress)

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/loras')
      const d = await r.json()
      const items: LoraItem[] = d.loras ?? []
      setLoras(items)
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const handleAdd = async () => {
    fileInputRef.current?.click()
  }

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''

    // (edit 104) Request lives in a promise outside component — closing settings
    // dialog does not interrupt it; progress is written to shared store.
    const { start, setProgress, done } = useModelUploadStore.getState()
    start('lora', file.name)

    try {
      const form = new FormData()
      form.append('file', file)

      // Use XMLHttpRequest for progress events (fetch doesn't support upload progress)
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        xhr.open('POST', '/api/loras')
        xhr.upload.onprogress = (ev) => {
          if (ev.lengthComputable) {
            setProgress((ev.loaded / ev.total) * 100)
          }
        }
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) resolve()
          else {
            try { reject(new Error(JSON.parse(xhr.responseText).error || `HTTP ${xhr.status}`)) }
            catch { reject(new Error(`Upload failed (${xhr.status})`)) }
          }
        }
        xhr.onerror = () => reject(new Error('Network error'))
        xhr.send(form)
      })

      toast.success('LoRA added', { description: file.name })
      await refresh()
    } catch (err) {
      toast.error('Failed to upload LoRA', { description: err instanceof Error ? err.message : String(err) })
    } finally {
      done()
    }
  }

  const toggleEnabled = async (name: string, enabled: boolean) => {
    // Optimistic update
    setLoras((prev) => prev.map((l) => l.name === name ? { ...l, enabled } : l))
    // (edit 587) Previously only caught network errors: non-2xx (400/500) left
    // optimistic flip in UI without rollback and toast — panel was desynced
    // until next refresh. Now check res.ok, matching POST/DELETE above.
    try {
      const res = await fetch('/api/loras', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, enabled }),
      })
      if (!res.ok) {
        let msg = `HTTP ${res.status}`
        try {
          const d = await res.json()
          if (d?.error) msg = d.error
        } catch { /* empty body — status code */ }
        throw new Error(msg)
      }
    } catch (err) {
      setLoras((prev) => prev.map((l) => l.name === name ? { ...l, enabled: !enabled } : l))
      toast.error('Failed to update', { description: err instanceof Error ? err.message : String(err) })
    }
  }

  /* (edit 81) Debounce PUT requests: strength slider and trigger inputs used to trigger
     a separate PUT on each move/character (dozens of requests, each writing loras.json).
     Now: optimistic state update + single request after 350ms silence; unwritten values
     are flushed on unmount. */
  type PendingPut = { timer: ReturnType<typeof setTimeout>; payload: Record<string, unknown> }
  const pendingPuts = useRef<Map<string, PendingPut>>(new Map())

  const sendPut = useCallback(async (payload: Record<string, unknown>) => {
    try {
      await fetch('/api/loras', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
    } catch {
      // optimistic state already applied; non-critical
    }
  }, [])

  const schedulePut = useCallback((key: string, payload: Record<string, unknown>, delay = 350) => {
    const map = pendingPuts.current
    const existing = map.get(key)
    if (existing) clearTimeout(existing.timer)
    const timer = setTimeout(() => {
      map.delete(key)
      void sendPut(payload)
    }, delay)
    map.set(key, { timer, payload })
  }, [sendPut])

  // Incomplete writes — flush on unmount so the last slider/trigger value is saved.
  useEffect(() => {
    const map = pendingPuts.current
    return () => {
      map.forEach((p) => {
        clearTimeout(p.timer)
        void sendPut(p.payload)
      })
      map.clear()
    }
  }, [sendPut])

  const updateStrength = (name: string, strength: number) => {
    setLoras((prev) => prev.map((l) => l.name === name ? { ...l, strength } : l))
    schedulePut(`strength:${name}`, { name, strength })
  }

  const updateTrigger = (name: string, trigger: string) => {
    setLoras((prev) => prev.map((l) => l.name === name ? { ...l, trigger } : l))
    schedulePut(`trigger:${name}`, { name, trigger })
  }

  const handleDelete = async (name: string) => {
    const msg = `Delete LoRA "${name}"?\nThe file will be deleted from the LoRAs folder.`
    if (!confirm(msg)) return
    try {
      const r = await fetch('/api/loras', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, deleteFile: true }),
      })
      if (!r.ok) {
        const d = await r.json().catch(() => ({}))
        throw new Error(d.error || `HTTP ${r.status}`)
      }
      toast.success('LoRA deleted')
      await refresh()
    } catch (err) {
      toast.error('Failed to delete', { description: err instanceof Error ? err.message : String(err) })
    }
  }

  return (
    <div className="space-y-3 pt-3 border-t border-border">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">LoRAs</span>
        <div className="flex items-center gap-2">
          {/* (edit 133) "Reset patches" button removed — reset is now
           * automatic when enabling/disabling LoRAs (in PUT API). */}
          <Button
            variant="outline"
            size="sm"
            onClick={handleAdd}
            disabled={uploading}
            className="h-7 gap-1.5 text-xs"
          >
            {uploading ? <Loader2Icon className="w-3.5 h-3.5 animate-spin" /> : <PlusIcon className="w-3.5 h-3.5" />}
            Add
          </Button>
        </div>
        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          accept=".safetensors"
          className="hidden"
          onChange={handleFile}
        />
      </div>

      <p className="text-[10px] text-muted-foreground leading-snug">
        Built-in turbo LoRA is enabled by default. In "Frames" mode with added audio
        it is skipped automatically; custom LoRAs always work.
      </p>

      {/* Upload progress (edit 104 — state from shared store) */}
      {uploading && (
        <div className="space-y-1">
          <div className="h-1.5 bg-[var(--surface-2)] rounded-full overflow-hidden">
            <div
              className="h-full bg-cyan-500 rounded-full transition-all duration-200"
              style={{ width: `${uploadProgress}%` }}
            />
          </div>
          <p className="text-[10px] text-muted-foreground text-right">{uploadProgress}%</p>
        </div>
      )}

      {/* LoRA list */}
      {loading ? (
        <div className="flex items-center justify-center py-4">
          <Loader2Icon className="w-4 h-4 animate-spin text-muted-foreground" />
        </div>
      ) : loras.length === 0 ? (
        <p className="text-xs text-muted-foreground/60 py-1">
          No custom LoRAs. Add a .safetensors file.
        </p>
      ) : (
        <div className="space-y-2">
          {loras.map((lora) => (
            <div
              key={lora.name}
              className="rounded-lg border border-border bg-[var(--surface-2)] px-3 py-2 space-y-1.5"
            >
              {/* Header: name + actions */}
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-foreground truncate flex items-center gap-1.5" title={lora.name}>
                    <span className="truncate">{shortName(lora.name)}</span>
                  </p>
                  <p className="text-[10px] text-muted-foreground">
                    {formatSize(lora.size)}
                  </p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => toggleEnabled(lora.name, !lora.enabled)}
                    className={`p-1.5 rounded-md transition-colors ${
                      lora.enabled
                        ? 'text-emerald-400 hover:bg-emerald-500/10'
                        : 'text-muted-foreground/40 hover:bg-muted'
                    }`}
                    title={lora.enabled ? 'Disable' : 'Enable'}
                  >
                    {lora.enabled ? <PowerIcon className="w-3.5 h-3.5" /> : <PowerOffIcon className="w-3.5 h-3.5" />}
                  </button>
                  <button
                    onClick={() => handleDelete(lora.name)}
                    className="p-1.5 rounded-md text-muted-foreground/40 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                    title="Delete"
                  >
                    <Trash2Icon className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {/* Strength slider (only when enabled) */}
              {lora.enabled && (
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <input
                      type="range"
                      /* (edit 256) Range -10...+10: civitai has LoRAs trained
                         with negative strength (inversion), previous bounds
                         0.1...2.0 blocked their usage. */
                      min="-10"
                      max="10"
                      step="0.05"
                      value={lora.strength}
                      onChange={(e) => updateStrength(lora.name, parseFloat(e.target.value))}
                      className="flex-1 h-1 accent-cyan-500 cursor-pointer"
                    />
                    <span className="text-[10px] font-mono text-muted-foreground w-12 text-right">
                      {lora.strength.toFixed(2)}
                    </span>
                  </div>
                  {/* Trigger words (edit 46) */}
                  <input
                    type="text"
                    placeholder="Trigger words (appended to prompt)"
                    value={lora.trigger || ''}
                    onChange={(e) => updateTrigger(lora.name, e.target.value)}
                    className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-cyan-500/40"
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
