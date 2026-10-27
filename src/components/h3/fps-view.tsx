'use client'

/**
 * FpsView — "FPS" tab: frame interpolation (VFI) of finished video.
 *
 * Two modes from Fannovel16/ComfyUI-Frame-Interpolation:
 *   RIFE VFI  — fast, low VRAM (parameters: model, batch, scale, dtype, fast/ensemble).
 *   FILM VFI  — for large motions (model + multiplier).
 *
 * Layout similar to Tile Upscale: left — parameters + status, right — gallery.
 * Source: drag & drop from gallery or file from disk.
 *
 * Target fps = source fps × multiplier. Playback speed does not change —
 * intermediate frames are inserted (24→48/72/96 fps), audio is preserved.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  GaugeIcon,
  PlayIcon,
  FileVideoIcon,
  ZapIcon,
  FilmIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { VideoGalleryGrid, H3_VIDEO_DND_MIME } from '@/components/h3/video-gallery-grid'
import { GenerationStatus } from '@/components/h3/generation-status'
import { RefPreviewThumb } from '@/components/h3/ref-preview-thumb'
import { useVideoGallery } from '@/components/h3/use-video-gallery'
import { useFpsTarget, type FpsSource, type FpsMode } from '@/lib/fps-store'
import { useFpsJob } from '@/lib/fps-job-store'
import { uploadInputFile } from '@/lib/upload'

const MODES: Array<{ id: FpsMode; label: string; hint: string; icon: typeof ZapIcon }> = [
  { id: 'rife', label: 'RIFE VFI', hint: 'Fast · low VRAM', icon: ZapIcon },
  { id: 'film', label: 'FILM VFI', hint: 'Large motions', icon: FilmIcon },
]

export function FpsView() {
  const storeTarget = useFpsTarget((s) => s.target)
  const clearStoreTarget = useFpsTarget((s) => s.clear)
  const source = useFpsTarget((s) => s.source)
  const setSource = useFpsTarget((s) => s.setSource)
  const prevSourceUrlRef = useRef<string | null>(null)
  const setSourceSafe = useCallback(
    (next: FpsSource | null) => {
      const prev = prevSourceUrlRef.current
      if (prev && prev.startsWith('blob:') && prev !== next?.url) {
        try { URL.revokeObjectURL(prev) } catch { /* already revoked */ }
      }
      prevSourceUrlRef.current = next?.url ?? null
      setSource(next)
    },
    [setSource],
  )
  const sourceRef = useRef<FpsSource | null>(null)
  sourceRef.current = source

  const params = useFpsTarget((s) => s.params)
  const patchParams = useFpsTarget((s) => s.patchParams)

  const [dragOver, setDragOver] = useState(false)
  const [uploadingSrc, setUploadingSrc] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const busy = useFpsJob((s) => s.busy)
  const phase = useFpsJob((s) => s.phase)
  const progress = useFpsJob((s) => s.progress)
  const error = useFpsJob((s) => s.error)
  const promptId = useFpsJob((s) => s.promptId)
  const startedAt = useFpsJob((s) => s.startedAt)
  const submitJob = useFpsJob((s) => s.submit)
  const cancelJob = useFpsJob((s) => s.cancel)
  const resetJob = useFpsJob((s) => s.reset)

  const gallery = useVideoGallery()

  useEffect(() => {
    if (!storeTarget) return
    const file = gallery.files.find(
      (f) => f.filename === storeTarget.filename && f.subfolder === storeTarget.subfolder,
    )
    if (file) {
      setSourceSafe(file as FpsSource)
      toast.success(`Source: ${file.filename}`)
    } else {
      setSourceSafe({
        url: `/api/comfy/file?filename=${encodeURIComponent(storeTarget.filename)}&subfolder=${encodeURIComponent(storeTarget.subfolder)}`,
        filename: storeTarget.filename,
        subfolder: storeTarget.subfolder,
      })
    }
    clearStoreTarget()
  }, [storeTarget, gallery.files, clearStoreTarget, setSourceSafe])

  const fileInputRef = useRef<HTMLInputElement>(null)
  const VIDEO_EXTS = '.mp4,.m4v,.mov,.mkv,.avi,.webm,.m2ts,.mts,.mxf,.vob,.wmv,.flv,.mpg,.mpeg,.ogv'

  const uploadLocalFile = useCallback(async (file: File) => {
    setUploadingSrc(true)
    try {
      const { path } = await uploadInputFile(file)
      setSourceSafe({
        url: URL.createObjectURL(file),
        filename: file.name,
        subfolder: '',
        inputSource: path,
      })
      toast.success(`Source: ${file.name}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Error uploading video')
    } finally {
      setUploadingSrc(false)
    }
  }, [setSourceSafe])

  const start = useCallback(async () => {
    const src = sourceRef.current
    if (!src) {
      toast.error('First select a source video')
      return
    }
    if (uploadingSrc) {
      toast.error('Video is still uploading')
      return
    }

    const body: Record<string, unknown> = {
      ...(src.inputSource
        ? { inputSource: src.inputSource }
        : { sourceFilename: src.filename, sourceSubfolder: src.subfolder ?? '' }),
      mode: params.mode,
      multiplier: params.multiplier,
      rifeBatchSize: params.rifeBatchSize,
      rifeScale: params.rifeScale,
      rifeDtype: params.rifeDtype,
      rifeFastMode: params.rifeFastMode,
      rifeEnsemble: params.rifeEnsemble,
      clearCacheAfterNFrames: params.clearCacheAfterNFrames,
    }
    await submitJob(body)
  }, [uploadingSrc, params, submitJob])

  const cancel = useCallback(async () => {
    await cancelJob()
  }, [cancelJob])

  const reset = useCallback(() => {
    resetJob()
  }, [resetJob])

  const srcThumb = (f: FpsSource) =>
    f.url.includes('?') ? `${f.url}&width=320` : `${f.url}?width=320`

  const dropHandler = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const raw = e.dataTransfer.getData(H3_VIDEO_DND_MIME)
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { filename?: string; subfolder?: string }
        setSourceSafe({
          url: `/api/comfy/file?filename=${encodeURIComponent(parsed.filename ?? '')}&subfolder=${encodeURIComponent(parsed.subfolder ?? '')}`,
          filename: parsed.filename ?? '',
          subfolder: parsed.subfolder ?? '',
        })
        toast.success(`Source: ${parsed.filename}`)
      } catch { toast.error('Failed to read dragged video') }
      return
    }
    const f = e.dataTransfer.files?.[0]
    if (f) void uploadLocalFile(f)
    else toast.error('A video file is required')
  }

  const isRife = params.mode === 'rife'

  return (
    <div className="flex h-full w-full min-w-0">
      {/* ═══ Parameter Panel ═══ */}
      <aside className="w-[360px] shrink-0 border-r border-border bg-[var(--surface-1)] flex flex-col">
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <div className="flex items-center gap-2">
            <GaugeIcon className="w-4 h-4 text-cyan-400" />
            <h2
              className="text-sm font-semibold text-foreground"
              title="Motion smoothing: inserts intermediate frames between video frames. Playback speed and audio remain unchanged."
            >
              FPS
            </h2>
          </div>

          {/* Source */}
          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground font-medium">Source</Label>
            {source ? (
              <div
                onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
                onDragLeave={() => setDragOver(false)}
                onDrop={dropHandler}
                className={cn(
                  'flex items-center gap-3 rounded-lg border bg-[var(--surface-2)] p-2 transition-all',
                  dragOver ? 'border-cyan-400 ring-1 ring-cyan-400/50' : 'border-border',
                )}
              >
                <RefPreviewThumb
                  kind="video"
                  name={source.filename}
                  url={source.url}
                  className="w-20 h-12 rounded object-cover bg-black shrink-0"
                  title="Open source video in full screen"
                >
                  <video
                    src={source.url}
                    poster={source.url.startsWith('blob:') ? undefined : srcThumb(source)}
                    preload="metadata"
                    muted
                    playsInline
                    className="w-full h-full object-cover"
                  />
                </RefPreviewThumb>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-foreground truncate">{source.filename}</p>
                  {uploadingSrc && <p className="text-[10px] text-cyan-400">uploading…</p>}
                </div>
                {!busy && (
                  <button onClick={() => setSourceSafe(null)}
                    className="text-[10px] text-muted-foreground hover:text-foreground shrink-0">
                    remove
                  </button>
                )}
              </div>
            ) : (
              <div
                onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
                onDragLeave={() => setDragOver(false)}
                onDrop={dropHandler}
                onClick={() => fileInputRef.current?.click()}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInputRef.current?.click() } }}
                className={cn(
                  'flex items-center gap-2 rounded-lg border border-dashed p-3 text-xs text-muted-foreground transition-all cursor-pointer',
                  dragOver ? 'border-cyan-400 bg-cyan-500/10' : 'border-border hover:border-cyan-500/40 hover:bg-[var(--surface-2)]',
                )}
              >
                <FileVideoIcon className="w-4 h-4 shrink-0" />
                <span>Click to select, drag a card from gallery or drop a file from disk</span>
              </div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept={VIDEO_EXTS}
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void uploadLocalFile(f)
                e.target.value = ''
              }}
            />
          </div>

          {/* Mode Selection */}
          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground font-medium">Mode</Label>
            <div className="grid grid-cols-2 gap-2">
              {MODES.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => patchParams({ mode: m.id })}
                  disabled={busy}
                  className={cn(
                    'rounded-lg border px-3 py-2 text-left transition-colors',
                    params.mode === m.id
                      ? 'border-cyan-500/60 bg-cyan-500/10'
                      : 'border-input bg-[var(--surface-2)]/50 hover:bg-accent/50',
                  )}
                >
                  <div className="flex items-center gap-1.5">
                    <m.icon className="w-3.5 h-3.5 text-cyan-400" />
                    <span className="text-xs font-medium text-foreground">{m.label}</span>
                  </div>
                  <p className="text-[10px] text-muted-foreground mt-0.5">{m.hint}</p>
                </button>
              ))}
            </div>
          </div>

          {/* FPS Multiplier */}
          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground font-medium">
              FPS Multiplier
              <span className="ml-1 text-[10px] text-muted-foreground">(24 → {24 * params.multiplier} fps)</span>
            </Label>
            <div className="grid grid-cols-3 gap-1.5">
              {[2, 3, 4].map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => patchParams({ multiplier: n })}
                  disabled={busy}
                  className={cn(
                    'h-8 rounded-md border text-xs font-medium transition-all',
                    params.multiplier === n
                      ? 'bg-cyan-500/15 border-cyan-500/50 text-cyan-300'
                      : 'bg-[var(--surface-2)] border-border text-muted-foreground hover:border-cyan-500/30',
                    busy && 'opacity-50 cursor-not-allowed',
                  )}
                >
                  ×{n}
                </button>
              ))}
            </div>
          </div>

          {/* Advanced Parameters */}
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="w-full flex items-center justify-between px-3 py-2 rounded-lg bg-[var(--surface-2)] border border-border hover:border-cyan-500/30 transition-all text-left"
            >
              <span className="text-xs font-medium text-muted-foreground">Advanced Parameters</span>
              <span className={cn('text-[10px] text-muted-foreground transition-transform', showAdvanced && 'rotate-180')}>▼</span>
            </button>

            {showAdvanced && (
              <div className="space-y-3 pl-1">
                {/* RIFE parameters (only in RIFE mode) */}
                {isRife && (
                  <>
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">Batch (VRAM)</Label>
                      <Select
                        value={String(params.rifeBatchSize)}
                        onValueChange={(v) => patchParams({ rifeBatchSize: parseInt(v, 10) })}
                        disabled={busy}
                      >
                        <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="bg-[var(--surface-3)] border-border">
                          {[1, 2, 4, 8, 16].map((n) => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">Scale (quality)</Label>
                        <Select
                          value={String(params.rifeScale)}
                          onValueChange={(v) => patchParams({ rifeScale: parseFloat(v) })}
                          disabled={busy}
                        >
                          <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent className="bg-[var(--surface-3)] border-border">
                            <SelectItem value="0.25">0.25 (faster, less VRAM)</SelectItem>
                            <SelectItem value="0.5">0.5 (balanced)</SelectItem>
                            <SelectItem value="1">1.0 (quality)</SelectItem>
                            <SelectItem value="2">2.0 (experimental)</SelectItem>
                            <SelectItem value="4">4.0 (experimental)</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">Dtype</Label>
                        <Select
                          value={params.rifeDtype}
                          onValueChange={(v) => patchParams({ rifeDtype: v })}
                          disabled={busy}
                        >
                          <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent className="bg-[var(--surface-3)] border-border">
                            <SelectItem value="float16">float16 (save VRAM)</SelectItem>
                            <SelectItem value="bfloat16">bfloat16</SelectItem>
                            <SelectItem value="float32">float32 (quality)</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <label className="flex items-center gap-2 text-xs text-foreground">
                        <input
                          type="checkbox"
                          checked={params.rifeFastMode}
                          onChange={(e) => patchParams({ rifeFastMode: e.target.checked })}
                          disabled={busy}
                          className="h-3.5 w-3.5 rounded border-border bg-[var(--surface-2)]"
                        />
                        Fast mode
                      </label>
                      <label className="flex items-center gap-2 text-xs text-foreground">
                        <input
                          type="checkbox"
                          checked={params.rifeEnsemble}
                          onChange={(e) => patchParams({ rifeEnsemble: e.target.checked })}
                          disabled={busy}
                          className="h-3.5 w-3.5 rounded border-border bg-[var(--surface-2)]"
                        />
                        Ensemble
                      </label>
                    </div>
                  </>
                )}

                {/* Anti-OOM (shared for both modes) */}
                <div className="space-y-1">
                  <Label
                    className="text-xs text-muted-foreground"
                    title="How often to clear VRAM during processing. Smaller values reduce the risk of out-of-memory errors, but may be slower."
                  >
                    Anti-OOM (frames between cache clears)
                  </Label>
                  <Select
                    value={String(params.clearCacheAfterNFrames)}
                    onValueChange={(v) => patchParams({ clearCacheAfterNFrames: parseInt(v, 10) })}
                    disabled={busy}
                  >
                    <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-[var(--surface-3)] border-border">
                      {[2, 4, 8, 16, 32].map((n) => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}
          </div>

          {/* Start */}
          <div className="flex gap-2 pt-1">
            <Button onClick={start} disabled={!source || uploadingSrc} className="flex-1 gap-1.5">
              <PlayIcon className="w-4 h-4" />
              {busy ? 'Queue another' : 'Run FPS'}
            </Button>
          </div>

        </div>

        {/* Status */}
        <div className="shrink-0 border-t border-border p-3 bg-[var(--surface-1)]/90 backdrop-blur-sm">
          <GenerationStatus
            isGenerating={busy}
            phase={phase}
            progressPercent={progress}
            statusMessage={null}
            error={error}
            onInterrupt={cancel}
            onReset={reset}
            startedAt={startedAt}
            promptId={promptId}
            stageKind="single"
          />
        </div>
      </aside>

      {/* ═══ Gallery ═══ */}
      <section className="flex-1 min-w-0 flex flex-col overflow-hidden">
        <div className="flex-1 min-h-0 overflow-y-auto p-3">
          <VideoGalleryGrid
            files={gallery.files}
            loading={gallery.loading}
            onRefresh={() => void gallery.load()}
            onDeleteFile={gallery.deleteFile}
            emptyHint="FPS results will appear here"
          />
        </div>
      </section>
    </div>
  )
}
