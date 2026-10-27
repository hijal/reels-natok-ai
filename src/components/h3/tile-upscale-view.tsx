'use client'

/**
 * TileUpscaleView — "Tile Upscale" tab: tiled latent upscale of finished video
 * via MMH3UltimateUpscale (monolithic node: temporal chunks → latent upscale →
 * spatial tiles → per-tile sampling → stitch).
 *
 * Layout matches Refine: left — parameters + status, right — gallery.
 * Source: drag&drop from gallery or file from disk.
 *
 * (fix 319) Job state (promptId/phase/progress/error) and /api/comfy/status
 * polling moved to modular tile-upscale-job-store — survives tab unmount
 * and page reload. Gallery refresh via useGalleryRefresh.bump() from store
 * (staggered reload built into useVideoGallery).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Grid3x3Icon,
  PlayIcon,
  FileVideoIcon,
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
import { SettingSlider } from '@/components/h3/setting-slider' // (fix 461)
import { VideoGalleryGrid, H3_VIDEO_DND_MIME } from '@/components/h3/video-gallery-grid'
import { GenerationStatus } from '@/components/h3/generation-status'
// (fix 719) Preview with fullscreen lightbox — same as on "Generate".
import { RefPreviewThumb } from '@/components/h3/ref-preview-thumb'
import { useVideoGallery } from '@/components/h3/use-video-gallery'
import { useTileUpscaleTarget, type TileUpscaleSource } from '@/lib/tile-upscale-target-store'
import { useTileUpscaleJob } from '@/lib/tile-upscale-job-store'
import { uploadInputFile } from '@/lib/upload'

export function TileUpscaleView() {
  const storeTarget = useTileUpscaleTarget((s) => s.target)
  const clearStoreTarget = useTileUpscaleTarget((s) => s.clear)
  const source = useTileUpscaleTarget((s) => s.source)
  const setSource = useTileUpscaleTarget((s) => s.setSource)
  // (fix 587) Revoke previous blob:-URL when replacing/removing source
  // (refine-view pattern, fix 345) — URL.createObjectURL leaked.
  const prevSourceUrlRef = useRef<string | null>(null)
  const setSourceSafe = useCallback(
    (next: TileUpscaleSource | null) => {
      const prev = prevSourceUrlRef.current
      if (prev && prev.startsWith('blob:') && prev !== next?.url) {
        try { URL.revokeObjectURL(prev) } catch { /* already revoked */ }
      }
      prevSourceUrlRef.current = next?.url ?? null
      setSource(next)
    },
    [setSource],
  )
  const sourceRef = useRef<TileUpscaleSource | null>(null)
  sourceRef.current = source

  const params = useTileUpscaleTarget((s) => s.params)
  const patchParams = useTileUpscaleTarget((s) => s.patchParams)

  const [prompt, setPrompt] = useState('')
  // (fix 270) "Advanced Parameters" — collapsed by default.
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [uploadingSrc, setUploadingSrc] = useState(false)
  // (fix 319) Job state from modular store (survives unmount).
  const busy = useTileUpscaleJob((s) => s.busy)
  const phase = useTileUpscaleJob((s) => s.phase)
  const progress = useTileUpscaleJob((s) => s.progress)
  const error = useTileUpscaleJob((s) => s.error)
  const promptId = useTileUpscaleJob((s) => s.promptId)
  const startedAt = useTileUpscaleJob((s) => s.startedAt)
  const jobSubmit = useTileUpscaleJob((s) => s.submit)
  const jobCancel = useTileUpscaleJob((s) => s.cancel)
  const jobReset = useTileUpscaleJob((s) => s.reset)

  const gallery = useVideoGallery()

  // Target from gallery store
  useEffect(() => {
    if (!storeTarget) return
    const file = gallery.files.find(
      (f) => f.filename === storeTarget.filename && f.subfolder === storeTarget.subfolder,
    )
    if (file) {
      setSourceSafe(file as TileUpscaleSource)
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

  useEffect(() => {
    setPrompt('')
  }, [source])

  // (fix 274) Click-select file: <input type='file'> + ref
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

  // (fix 319) Polling and staggered gallery reload moved to
  // tile-upscale-job-store (modular, survives unmount); gallery
  // refresh via useGalleryRefresh.bump() upon job completion.

  const start = useCallback(async () => {
    const src = sourceRef.current
    if (!src) {
      toast.error('Please select a source video first')
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
      prompt: prompt.trim() || undefined,
      seed: -1,
      tileSize: params.tileSize,
      overlap: params.overlap,
      fade: params.fade,
      chunkFrames: params.chunkFrames,
      temporalOverlap: params.temporalOverlap,
      anchorStrength: params.anchorStrength,
      targetResolution: params.targetResolution,
      denoise: params.denoise,
      steps: params.steps,
      syncTiles: params.syncTiles,
    }
    await jobSubmit(body)
  }, [prompt, uploadingSrc, params, jobSubmit])

  // (fix 319) Cancel/reset via store (modular polling).
  const cancel = useCallback(() => { void jobCancel() }, [jobCancel])
  const reset = useCallback(() => { jobReset() }, [jobReset])

  const srcThumb = (f: TileUpscaleSource) =>
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
    else toast.error('Video file required')
  }

  return (
    <div className="flex h-full w-full min-w-0">
      {/* ═══ Parameter Panel ═══ */}
      <aside className="w-[360px] shrink-0 border-r border-border bg-[var(--surface-1)] flex flex-col">
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <div className="flex items-center gap-2">
            <Grid3x3Icon className="w-4 h-4 text-pink-400" />
            <h2 className="text-sm font-semibold text-foreground">Tile Upscale</h2>
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
                  dragOver ? 'border-pink-400 ring-1 ring-pink-400/50' : 'border-border',
                )}
              >
                {/* (fix 460) Preview: src is the video ITSELF (source.url), not
                    srcThumb(...): URL with &width=320 returns JPEG poster, and <video>
                    showed a black square. JPEG poster goes to poster=
                    (instant rendering), first frame via preload="metadata"
                    + muted (WebView2). Blob URL (file from disk) has no poster.
                    (fix 719) Click — open fullscreen. */}
                <RefPreviewThumb
                  kind="video"
                  name={source.filename}
                  url={source.url}
                  className="w-20 h-12 rounded object-cover bg-black shrink-0"
                  title="Open source video fullscreen"
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
                  {uploadingSrc && <p className="text-[10px] text-pink-400">uploading…</p>}
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
                // (fix 274) Click field — choose file from disk
                onClick={() => fileInputRef.current?.click()}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInputRef.current?.click() } }}
                className={cn(
                  'flex items-center gap-2 rounded-lg border border-dashed p-3 text-xs text-muted-foreground transition-all cursor-pointer',
                  dragOver ? 'border-pink-400 bg-pink-500/10' : 'border-border hover:border-pink-500/40 hover:bg-[var(--surface-2)]',
                )}
              >
                <FileVideoIcon className="w-4 h-4 shrink-0" />
                <span>Click to select, drag card from gallery or file from disk</span>
              </div>
            )}
            {/* (fix 274) Hidden input — click file select from disk */}
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

          {/* (fix 270) Main parameters: resolution + steps in one
              row, denoise below. Rest (tiles/overlap/temporal) in
              "Advanced Parameters" (pattern from generate-view).
              (fix 462) Raw <select> replaced with common Select from
              @/components/ui/select (reference from "Generate" tab). */}
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Resolution</Label>
              <Select
                value={String(params.targetResolution)}
                onValueChange={(v) => patchParams({ targetResolution: parseInt(v, 10) })}
                disabled={busy}
              >
                <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-[var(--surface-3)] border-border">
                  {[720, 1080, 1440, 2160].map((n) => <SelectItem key={n} value={String(n)}>{n}p</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Steps</Label>
              <Select
                value={String(params.steps)}
                onValueChange={(v) => patchParams({ steps: parseInt(v, 10) })}
                disabled={busy}
              >
                <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-[var(--surface-3)] border-border">
                  {[2, 3, 4, 5, 6, 8].map((n) => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* (fix 461) Raw <input type="range"> replaced with common
              SettingSlider (as in "Generate" tab): value in
              formatValue, explanation in labelTitle tooltip. */}
          <SettingSlider
            label="Denoise"
            labelTitle="How strongly the model redraws the image during upscale. Lower is closer to original, higher adds more new detail."
            value={params.denoise}
            min={0.05}
            max={1}
            step={0.05}
            onChange={(v) => patchParams({ denoise: v })}
            formatValue={(v) => v.toFixed(2)}
            disabled={busy}
          />

          {/* (fix 270) Advanced parameters — tiles, overlap, temporal. */}
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="w-full flex items-center justify-between px-3 py-2 rounded-lg bg-[var(--surface-2)] border border-border hover:border-pink-500/30 transition-all text-left"
            >
              <span className="text-xs font-medium text-muted-foreground">Advanced Parameters</span>
              <span className={cn('text-[10px] text-muted-foreground transition-transform', showAdvanced && 'rotate-180')}>▼</span>
            </button>

            {showAdvanced && (
              <div className="space-y-3 pl-1">
                {/* (fix 481) SyncTile: per-step tile synchronization.
                    In sync mode "Fade" is unused (blending runs after
                    each step), "Overlap" specifies ramp geometry. */}
                <div className="space-y-1">
                  <Label
                    className="text-xs text-muted-foreground"
                    title="Tiles are reconciled after each sampling step (blending into common canvas + shared noise) — eliminates seam flicker. Turn off to compare with legacy mode."
                  >
                    SyncTile (seamless joints)
                  </Label>
                  <Select
                    value={params.syncTiles ? 'on' : 'off'}
                    onValueChange={(v) => patchParams({ syncTiles: v === 'on' })}
                    disabled={busy}
                  >
                    <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-[var(--surface-3)] border-border">
                      <SelectItem value="on">On (recommended)</SelectItem>
                      <SelectItem value="off">Off (legacy mode)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* Tile: user sets size, count calculated automatically */}
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label
                      className="text-xs text-muted-foreground"
                      title="Size of chunks the frame is split into during processing. How many are needed is calculated automatically."
                    >
                      Tile (px)
                    </Label>
                    <Select
                      value={String(params.tileSize)}
                      onValueChange={(v) => patchParams({ tileSize: parseInt(v, 10) })}
                      disabled={busy}
                    >
                      <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="bg-[var(--surface-3)] border-border">
                        {[512, 640, 768, 896, 1024].map((n) => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {/* Overlap + Fade */}
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Overlap (px)</Label>
                    <Select
                      value={String(params.overlap)}
                      onValueChange={(v) => patchParams({ overlap: parseInt(v, 10) })}
                      disabled={busy}
                    >
                      <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="bg-[var(--surface-3)] border-border">
                        {[64, 96, 128, 192, 256].map((n) => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Fade (px)</Label>
                    <Select
                      value={String(params.fade)}
                      onValueChange={(v) => patchParams({ fade: parseInt(v, 10) })}
                      disabled={busy}
                    >
                      <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="bg-[var(--surface-3)] border-border">
                        {[32, 48, 64, 96, 128].map((n) => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {/* Temporal */}
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Chunk (frames)</Label>
                    <Select
                      value={String(params.chunkFrames)}
                      onValueChange={(v) => patchParams({ chunkFrames: parseInt(v, 10) })}
                      disabled={busy}
                    >
                      <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="bg-[var(--surface-3)] border-border">
                        {[102, 136, 170, 204, 272].map((n) => <SelectItem key={n} value={String(n)}>{n} (~{Math.round(n/24*10)/10}s)</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Overlap (frames)</Label>
                    <Select
                      value={String(params.temporalOverlap)}
                      onValueChange={(v) => patchParams({ temporalOverlap: parseInt(v, 10) })}
                      disabled={busy}
                    >
                      <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="bg-[var(--surface-3)] border-border">
                        {[17, 34, 51, 68].map((n) => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Launch */}
          <div className="flex gap-2 pt-1">
            <Button onClick={start} disabled={!source} className="flex-1 gap-1.5">
              <PlayIcon className="w-4 h-4" />
              {busy ? 'Add to Queue' : 'Start Tile Upscale'}
            </Button>
          </div>

        </div>

        {/* Status */}
        {/* (fix 475) status/preview panel — surface-1, matching settings panel color */}
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
            // (fix 478) custom stage kind — "Tile Upscale" badge, not "Refine"
            stageKind="tile"
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
            emptyHint="Tile Upscale results will appear here"
          />
        </div>
      </section>
    </div>
  )
}
