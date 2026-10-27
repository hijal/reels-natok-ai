'use client'

/**
 * "Voice Input" panel — settings for built-in whisper STT.
 *
 *   • enable/disable voice input in UI
 *   • STT model (download from catalog or select from local)
 *   • language, CPU threads
 *   • service status + start/restart/stop
 *   • live test: record → recognized text
 *
 * Recognition runs on CPU ONLY (keeps VRAM untouched).
 * Runtime (transcribe.dll / binary) is bundled in the project.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Loader2Icon,
  CheckCircleIcon,
  AlertCircleIcon,
  RefreshCwIcon,
  PowerIcon,
  PlayIcon,
  DownloadIcon,
  XIcon,
  MicIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { VoiceInputButton } from './voice-input-button'
import { setSttMicDevice, getSttMicDevice } from '@/lib/use-voice-dictation'

interface SttStatusResp {
  enabled: boolean
  sttDir: string
  model: string
  models: string[]
  modelDirs: Array<{ dir: string; files: string[] }>
  language: string
  threads: number
  service: { running: boolean; starting: boolean; error: string | null; startedAt: number }
  health: Record<string, unknown> | null
}

interface DownloadProgress {
  name: string
  active?: boolean
  downloaded: number
  total: number
  done: boolean
  error: string | null
  cancelled: boolean
}

const MODEL_CATALOG: Array<{ name: string; file: string; sizeLabel: string; quality: string }> = [
  { name: 'tiny',     file: 'ggml-tiny.bin',     sizeLabel: '~75 MB',  quality: 'fast, low quality' },
  { name: 'base',     file: 'ggml-base.bin',     sizeLabel: '~142 MB', quality: 'medium quality' },
  { name: 'small',    file: 'ggml-small.bin',    sizeLabel: '~466 MB', quality: 'good (recommended)' },
  { name: 'medium',   file: 'ggml-medium.bin',   sizeLabel: '~1.5 GB', quality: 'excellent' },
  { name: 'large-v3', file: 'ggml-large-v3.bin', sizeLabel: '~3.1 GB', quality: 'best, slow' },
]

export function VoiceSettingsPanel() {
  const [st, setSt] = useState<SttStatusResp | null>(null)
  const [enabled, setEnabled] = useState(true)
  const [model, setModel] = useState('')
  const [language, setLanguage] = useState('ru')
  const [threads, setThreads] = useState(0)

  const [saving, setSaving] = useState(false)
  const [testText, setTestText] = useState('')
  const [loading, setLoading] = useState(true)

  // Microphone selection
  const [micDevices, setMicDevices] = useState<MediaDeviceInfo[]>([])
  const [selectedMic, setSelectedMic] = useState<string>('')
  const [micLoading, setMicLoading] = useState(false)

  // Download state
  const [downloading, setDownloading] = useState<Record<string, DownloadProgress | null>>({})
  const downloadingRef = useRef<Record<string, DownloadProgress | null>>({})
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const toastShownRef = useRef<Set<string>>(new Set())
  const refreshRef = useRef<() => Promise<void>>(async () => {})

  const setProg = (name: string, p: DownloadProgress) => {
    downloadingRef.current = { ...downloadingRef.current, [name]: p }
    setDownloading(downloadingRef.current)
  }

  const resetToasts = (name: string) => {
    toastShownRef.current.delete(`ok:${name}`)
    toastShownRef.current.delete(`err:${name}`)
    toastShownRef.current.delete(`cxl:${name}`)
  }

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/stt/status')
      const d = (await r.json()) as SttStatusResp
      setSt(d)
      setEnabled(d.enabled)
      setModel(d.model)
      setLanguage(d.language)
      setThreads(d.threads)
    } catch {
      setSt(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refreshRef.current = refresh
  }, [refresh])

  const tick = () => {
    void (async () => {
      const activeNames = Object.keys(downloadingRef.current).filter((n) => {
        const p = downloadingRef.current[n]
        return p && !p.done && !p.error && !p.cancelled
      })
      if (activeNames.length === 0) {
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
        return
      }
      for (const name of activeNames) {
        try {
          const r = await fetch(`/api/stt/models/download?name=${name}`)
          if (!r.ok) continue
          const d = (await r.json()) as DownloadProgress
          setProg(name, d)
          if (d.done && !toastShownRef.current.has(`ok:${name}`)) {
            toastShownRef.current.add(`ok:${name}`)
            toast.success(`Model ${name} downloaded!`)
            await refreshRef.current()
          } else if (d.error && !toastShownRef.current.has(`err:${name}`)) {
            toastShownRef.current.add(`err:${name}`)
            toast.error(`Downloading ${name}: ${d.error}`)
          } else if (d.cancelled && !toastShownRef.current.has(`cxl:${name}`)) {
            toastShownRef.current.add(`cxl:${name}`)
            toast.info(`Downloading ${name} cancelled`)
          }
        } catch { /* network blip — retry next tick */ }
      }
    })()
  }

  const ensurePolling = () => {
    if (pollRef.current) return
    pollRef.current = setInterval(tick, 1500)
  }

  // Enumerate available microphones
  const refreshMics = useCallback(async () => {
    setMicLoading(true)
    try {
      try {
        const tmp = await navigator.mediaDevices.getUserMedia({ audio: true })
        tmp.getTracks().forEach((t) => t.stop())
      } catch { /* no permission — labels will be fallback */ }
      const devices = await navigator.mediaDevices.enumerateDevices()
      const mics = devices.filter((d) => d.kind === 'audioinput')
      setMicDevices(mics)
      const saved = getSttMicDevice()
      if (saved) {
        const match = mics.find((m) => m.deviceId === saved)
        setSelectedMic(match ? saved : '')
      } else {
        setSelectedMic('')
      }
    } catch {
      setMicDevices([])
      setSelectedMic('')
    } finally {
      setMicLoading(false)
    }
  }, [])

  const handleMicChange = (id: string) => {
    setSelectedMic(id)
    setSttMicDevice(id === '__default__' ? null : id)
  }

  useEffect(() => {
    void refresh()
    void refreshMics()
    MODEL_CATALOG.forEach((m) => {
      if (downloadingRef.current[m.name]) return
      fetch(`/api/stt/models/download?name=${m.name}`)
        .then((r) => (r.ok ? (r.json() as Promise<DownloadProgress>) : null))
        .then((d) => {
          if (d && d.active && !d.done && !d.error && !d.cancelled) {
            setProg(m.name, d)
          }
        })
        .catch(() => {})
        .finally(() => { ensurePolling() })
    })
    return () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const startDownload = async (name: string) => {
    try {
      const r = await fetch('/api/stt/models/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      const d = await r.json()
      if (!r.ok) {
        toast.error(d.error || 'Failed to start download')
        return
      }
      if (d.already && d.downloaded) {
        toast.success(`Model ${name} is already downloaded`)
        await refreshRef.current()
        return
      }
      toast.info(`Downloading model ${name} started…`)
      resetToasts(name)
      setProg(name, { name, downloaded: 0, total: 0, done: false, error: null, cancelled: false })
      ensurePolling()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Download error')
    }
  }

  const cancelDownload = async (name: string) => {
    try {
      await fetch(`/api/stt/models/download?name=${name}`, { method: 'DELETE' })
    } catch { /* ignore */ }
    const prev = downloadingRef.current[name]
    setProg(name, {
      ...(prev || { name, downloaded: 0, total: 0, done: false, error: null, cancelled: false }),
      cancelled: true,
    })
  }

  const isModelDownloaded = (modelName: string): boolean => {
    const cat = MODEL_CATALOG.find((m) => m.name === modelName)
    if (!cat) return false
    return (st?.models || []).some((m) => m === cat.file || m.includes(cat.file))
  }

  const save = async () => {
    setSaving(true)
    try {
      const r = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stt_enabled: enabled,
          stt_model: model,
          stt_language: language,
          stt_threads: threads,
        }),
      })
      if (!r.ok) {
        let msg = 'Failed to save settings'
        try {
          const d = await r.json()
          if (d && typeof d.error === 'string' && d.error) msg = d.error
        } catch { /* response is not JSON */ }
        toast.error(msg)
        return
      }
      toast.success('Voice input settings saved')
      // Restart STT service with new params
      const rr = await fetch('/api/stt/reload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, language, threads }),
      })
      const rd = await rr.json()
      if (rr.ok && rd.ok) {
        toast.success('STT service running and ready', {
          description: rd.model ? `Model: ${String(rd.model).split(/[\\/]/).pop()}` : undefined,
        })
      } else if (enabled) {
        toast.error(rd.error || 'Failed to start STT service')
      }
      await refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save error')
    } finally {
      setSaving(false)
    }
  }

  const stopService = async () => {
    const r = await fetch('/api/stt/stop', { method: 'POST' })
    const d = await r.json().catch(() => ({}))
    if (d.ok !== false) toast.success('STT service stopped (memory released)')
    await refresh()
  }

  if (loading) {
    return (
      <div className="py-3 flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2Icon className="w-3.5 h-3.5 animate-spin" />
        Loading voice input settings…
      </div>
    )
  }

  const service = st?.service
  const anyModel = (st?.models.length ?? 0) > 0

  return (
    <div className="space-y-4 py-2">
      {/* Enable/disable */}
      <div className="flex items-center justify-between">
        <div>
          <span className="text-sm font-medium text-foreground">Voice input</span>
          <p className="text-[10px] text-muted-foreground/60">
            Dictation button next to prompt input, in prompt editor, and in assistant chat. Runs on CPU (whisper / transcribe.cpp).
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          onClick={() => setEnabled((v) => !v)}
          className={cn(
            'relative w-9 h-5 rounded-full transition-colors border',
            enabled ? 'bg-cyan-500/40 border-cyan-500/50' : 'bg-[var(--surface-3)] border-border',
          )}
        >
          <span
            className={cn(
              'absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white transition-all',
              enabled ? 'left-[18px]' : 'left-0.5',
            )}
          />
        </button>
      </div>

      {/* Model downloads */}
      <div className="pt-3 border-t border-border space-y-2">
        <div>
          <span className="text-xs text-muted-foreground">Recognition models</span>
          <p className="text-[10px] text-muted-foreground/60">
            Download the model with desired quality. For general use, <span className="font-mono">small</span> or <span className="font-mono">medium</span> is recommended.
          </p>
        </div>
        <div className="space-y-1.5">
          {MODEL_CATALOG.map((m) => {
            const downloaded = isModelDownloaded(m.name)
            const prog = downloading[m.name]
            const isActive = prog && !prog.done && !prog.cancelled
            const pct = prog && prog.total > 0 ? Math.round((prog.downloaded / prog.total) * 100) : 0

            return (
              <div key={m.name} className="flex items-center gap-2 rounded-md border border-border bg-[var(--surface-2)] px-3 py-2">
                <div className="flex-1 min-w-0">
                  <span className="text-xs font-medium text-foreground">{m.name}</span>
                  <span className="text-[10px] text-muted-foreground ml-2">{m.sizeLabel} · {m.quality}</span>
                </div>
                {downloaded ? (
                  <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30 gap-1 text-[10px] shrink-0">
                    <CheckCircleIcon className="w-3 h-3" />
                    Downloaded
                  </Badge>
                ) : isActive ? (
                  <div className="flex items-center gap-2 shrink-0">
                    <div className="w-20 h-1.5 rounded-full bg-[var(--surface-3)] overflow-hidden">
                      <div
                        className="h-full rounded-full bg-cyan-500 transition-all"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="text-[10px] text-muted-foreground w-8 text-right">{pct}%</span>
                    <button
                      type="button"
                      onClick={() => cancelDownload(m.name)}
                      className="p-1 rounded hover:bg-red-500/20 text-red-400"
                      title="Cancel download"
                    >
                      <XIcon className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5 text-xs shrink-0"
                    onClick={() => { void startDownload(m.name) }}
                  >
                    <DownloadIcon className="w-3.5 h-3.5" />
                    Download
                  </Button>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* Model selection */}
      <div className="pt-3 border-t border-border space-y-2">
        <div>
          <span className="text-xs text-muted-foreground">Active model</span>
          <p className="text-[10px] text-muted-foreground/60">
            Which model will be used for recognition. Empty = automatic (first found).
          </p>
        </div>
        <Select value={model || '__auto__'} onValueChange={(v) => setModel(v === '__auto__' ? '' : v)}>
          <SelectTrigger className="h-8 w-full text-xs">
            <SelectValue placeholder="Select model" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__auto__">Automatic (first available)</SelectItem>
            {st?.models.map((m) => (
              <SelectItem key={m} value={m}>{m}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {!anyModel && (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2">
            <AlertCircleIcon className="w-3.5 h-3.5 text-amber-400 mt-0.5 shrink-0" />
            <p className="text-xs text-amber-200/90 leading-snug">
              No models downloaded yet. Download a model above (e.g. <span className="font-mono">small</span>) — and it will appear in the list.
            </p>
          </div>
        )}
      </div>

      {/* Microphone */}
      <div className="pt-3 border-t border-border space-y-2">
        <div className="flex items-center justify-between">
          <div>
            <span className="text-xs text-muted-foreground">Microphone</span>
            <p className="text-[10px] text-muted-foreground/60">
              If your computer has multiple input devices, select the desired one here.
            </p>
          </div>
          <button
            type="button"
            onClick={() => { void refreshMics() }}
            disabled={micLoading}
            className="p-1 rounded hover:bg-[var(--surface-3)] text-muted-foreground hover:text-foreground transition-colors"
            title="Refresh microphone list"
          >
            <RefreshCwIcon className={cn('w-3.5 h-3.5', micLoading && 'animate-spin')} />
          </button>
        </div>
        <div className="flex items-center gap-2">
          <MicIcon className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
          <Select value={selectedMic || '__default__'} onValueChange={handleMicChange} disabled={micLoading || micDevices.length === 0}>
            <SelectTrigger className="h-8 flex-1 text-xs">
              <SelectValue placeholder={micLoading ? 'Loading…' : 'System (default)'} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__default__">System (default)</SelectItem>
              {micDevices.map((d) => (
                <SelectItem key={d.deviceId} value={d.deviceId}>
                  {d.label || `Microphone ${micDevices.indexOf(d) + 1}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Language + Threads */}
      <div className="pt-3 border-t border-border grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <span className="text-xs text-muted-foreground">Spoken language</span>
          <Select value={language} onValueChange={setLanguage}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ru">Russian</SelectItem>
              <SelectItem value="en">English</SelectItem>
              <SelectItem value="auto">Auto-detect</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <span className="text-xs text-muted-foreground">CPU threads</span>
          <Select value={String(threads)} onValueChange={(v) => setThreads(parseInt(v, 10))}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="0">Auto (by CPU cores)</SelectItem>
              <SelectItem value="2">2</SelectItem>
              <SelectItem value="4">4</SelectItem>
              <SelectItem value="6">6</SelectItem>
              <SelectItem value="8">8</SelectItem>
              <SelectItem value="12">12</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Service status */}
      <div className="pt-3 border-t border-border space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">STT service:</span>
            {service?.starting ? (
              <Badge variant="secondary" className="gap-1 text-[10px]">
                <Loader2Icon className="w-3 h-3 animate-spin" />
                Loading…
              </Badge>
            ) : service?.running ? (
              <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30 gap-1 text-[10px]">
                <CheckCircleIcon className="w-3 h-3" />
                Running
              </Badge>
            ) : (
              <Badge variant="secondary" className="text-[10px]">
                Stopped (starts on first dictation)
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            {service?.running && (
              <Button size="sm" variant="outline" className="gap-1.5 text-xs" onClick={stopService}>
                <PowerIcon className="w-3 h-3" />
                Stop
              </Button>
            )}
          </div>
        </div>
        {st?.health && (
          <p className="text-[10px] text-muted-foreground/60 font-mono truncate">
            {String(st.health.model ?? '')} · language: {String(st.health.language ?? '')} · threads: {String(st.health.threads ?? '')}
            {st.health.version ? ` · ${String(st.health.version)}` : ''}
          </p>
        )}
        {service?.error && (
          <p className="text-xs text-red-300/90 flex items-start gap-1.5">
            <AlertCircleIcon className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            {service.error}
          </p>
        )}
      </div>

      {/* Test */}
      <div className="pt-3 border-t border-border space-y-2">
        <span className="text-xs text-muted-foreground">
          Test: click the button, say a phrase, and click it again — recognized text will appear below
        </span>
        <div className="flex items-center gap-2">
          <VoiceInputButton
            variant="inline"
            onText={(t) => setTestText(t)}
            disabled={!enabled}
          />
          <span className="text-[10px] text-muted-foreground/60">
            {enabled ? 'Voice input enabled' : 'Voice input disabled — enable it above'}
          </span>
        </div>
        {testText && (
          <div className="rounded-md border border-cyan-500/30 bg-cyan-500/10 px-3 py-2">
            <p className="text-xs text-cyan-100/90 leading-snug">{testText}</p>
          </div>
        )}
      </div>

      {/* Save */}
      <div className="pt-3 border-t border-border flex items-center justify-end gap-2">
        <Button size="sm" variant="outline" className="gap-1.5 text-xs" onClick={() => { void refresh() }} disabled={saving}>
          <RefreshCwIcon className="w-3.5 h-3.5" />
          Refresh
        </Button>
        <Button size="sm" className="gap-1.5 text-xs bg-cyan-600 hover:bg-cyan-500" onClick={() => { void save() }} disabled={saving}>
          {saving ? <Loader2Icon className="w-3.5 h-3.5 animate-spin" /> : <PlayIcon className="w-3.5 h-3.5" />}
          Save and Apply
        </Button>
      </div>
    </div>
  )
}
