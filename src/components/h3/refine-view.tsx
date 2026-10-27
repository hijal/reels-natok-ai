'use client'

/**
 * RefineView — "Refine" tab: generative v2v upscale of finished video
 * (latent Pass 2 pipeline: VAEEncode of source → LatentUpscaler3D →
 * short sigma ladder pass from "Generation" tab).
 *
 * Scenario: user generates drafts in lower resolution (cheap/fast),
 * picks a good clip here — and gets the same scene in 720p/1080p:
 * source is encoded to H3 latent at its own resolution, latent is
 * upscaled via 3D upscaler to target, and model refines details in
 * 3–5 steps (like Pass 2 generation).
 *
 * Layout similar to "Generation" tab:
 *  • left — parameter panel: source, target, pass profile, launch button,
 *    and status card; prompt for gallery video is taken from metadata
 *    automatically. For files from disk, a prompt and reference upload
 *    section is displayed.
 *  • right — shared gallery: results appear here.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { H3_VIDEO_DND_MIME } from './video-gallery-grid'
import {
  Wand2Icon,
  PlayIcon,
  FileVideoIcon,
  Loader2Icon,
  UploadIcon,
  XIcon,
  WandSparklesIcon,
  Trash2Icon,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { VideoGalleryGrid, type VideoGalleryFile } from '@/components/h3/video-gallery-grid'
import { PromptFixDialog } from '@/components/h3/prompt-editor-dialog'
import { requestImprovePrompt } from '@/hooks/use-improve-prompt'
import { GenerationStatus } from '@/components/h3/generation-status'
import { RefPreviewThumb } from '@/components/h3/ref-preview-thumb'
import { SettingSlider } from '@/components/h3/setting-slider'
import {
  REFINE_PASS2_SIGMA,
  REFINE_PASS2_STEPS,
  refineSigmaLadder,
} from '@/lib/comfy/refine-sigmas'
import { useVideoGallery } from '@/components/h3/use-video-gallery'
import { useRefineTarget, type RefineSource } from '@/lib/refine-target-store'
import {
  enqueueRefine,
  cancelActiveRefines,
  sweepOrphanRefineItems,
} from '@/lib/refine-queue'
import { useGenQueue, type QueueItem } from '@/lib/gen-queue-store'
import { useGenStore } from '@/lib/gen-store'
import { uploadInputFile } from '@/lib/upload'

type Phase = 'idle' | 'submitting' | 'queued' | 'running' | 'done' | 'error'

export function RefineView() {
  const storeTarget = useRefineTarget((s) => s.target)
  const clearStoreTarget = useRefineTarget((s) => s.clear)
  const source = useRefineTarget((s) => s.source)
  const setSource = useRefineTarget((s) => s.setSource)
  const sourceRef = useRef<RefineSource | null>(null)
  sourceRef.current = source

  const revokeSourceUrl = useCallback((s: RefineSource | null) => {
    if (s?.url?.startsWith('blob:')) {
      try { URL.revokeObjectURL(s.url) } catch { /* already revoked */ }
    }
  }, [])

  const params = useRefineTarget((s) => s.params)
  const patchParams = useRefineTarget((s) => s.patchParams)
  const { target, steps, strength, mode, chunkSec, refDetail, keepOriginalAudio, targetMp } = params

  const prompt = useRefineTarget((s) => s.prompt)
  const setPrompt = useRefineTarget((s) => s.setPrompt)
  const [fixOpen, setFixOpen] = useState(false)
  const userRefs = useRefineTarget((s) => s.userRefs)
  const [uploadingRefs, setUploadingRefs] = useState(false)
  const refsInputRef = useRef<HTMLInputElement>(null)
  const [refsDragOver, setRefsDragOver] = useState(false)
  const [srcDims, setSrcDims] = useState<{ w: number; h: number } | null>(null)

  type MetaRef = { path: string; role: string }
  const [metaRefs, setMetaRefs] = useState<MetaRef[] | null>(null)
  const [metaLoading, setMetaLoading] = useState(false)
  const [latentOk, setLatentOk] = useState(false)

  useEffect(() => {
    setMetaRefs(null)
    setLatentOk(false)
    if (!source || source.inputSource || !source.filename) return
    const sub = source.subfolder ?? ''
    const p = sub ? `${sub}/${source.filename}` : source.filename
    let cancelled = false
    setMetaLoading(true)
    fetch(`/api/comfy/meta?path=${encodeURIComponent(p)}`)
      .then(async (r) => {
        if (!r.ok) return null
        return (await r.json()) as {
          references?: Array<{ type?: string; path?: string; role?: string }>
          minimax_h3_references?: Array<{ type?: string; path?: string; role?: string }>
          generation_mode?: string
          first_frame?: string | null
          latent_available?: boolean
        }
      })
      .then((meta) => {
        if (cancelled) return
        setLatentOk(meta?.latent_available === true)
        const list = Array.isArray(meta?.references) ? meta!.references!
          : Array.isArray(meta?.minimax_h3_references) ? meta!.minimax_h3_references!
          : []
        const imgRefs = list
          .filter((r) => r?.type === 'image' && typeof r?.path === 'string' && r.path.length > 0)
          .map((r) => ({ path: r.path as string, role: typeof r.role === 'string' ? r.role : '' }))
        const firstFrame =
          meta?.generation_mode === 'flf' && typeof meta.first_frame === 'string' && meta.first_frame
            ? meta.first_frame
            : null
        if (firstFrame && !imgRefs.some((r) => r.path === firstFrame)) {
          imgRefs.unshift({ path: firstFrame, role: 'first frame of original' })
        }
        setMetaRefs(imgRefs)
      })
      .catch(() => { if (!cancelled) setMetaRefs([]) })
      .finally(() => { if (!cancelled) setMetaLoading(false) })
    return () => { cancelled = true }
  }, [source])

  const [dragOver, setDragOver] = useState(false)
  const [uploadingSrc, setUploadingSrc] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const VIDEO_EXTS = '.mp4,.m4v,.mov,.mkv,.avi,.webm,.m2ts,.mts,.mxf,.vob,.wmv,.flv,.mpg,.mpeg,.ogv'

  const uploadLocalFile = useCallback(async (file: File) => {
    setUploadingSrc(true)
    try {
      const { path } = await uploadInputFile(file)
      revokeSourceUrl(sourceRef.current)
      setSource({
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
  }, [revokeSourceUrl, setSource])

  const addRefFiles = useCallback(async (files: File[]) => {
    const images = files.filter((f) => /^image\//.test(f.type) || /\.(png|jpe?g|webp|bmp|tiff?)$/i.test(f.name))
    if (!images.length) { toast.error('References must be images (png, jpg, webp)'); return }
    const room = 8 - useRefineTarget.getState().userRefs.length
    if (room <= 0) { toast.error('Maximum of 8 reference images'); return }
    if (images.length > room) toast.error(`Maximum 8 references — added ${room}`)
    setUploadingRefs(true)
    try {
      for (const file of images.slice(0, room)) {
        try {
          const { path } = await uploadInputFile(file)
          useRefineTarget.getState().addUserRefs([{
            id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            path,
            name: file.name,
            previewUrl: `/api/comfy/file?filename=${encodeURIComponent(path)}&type=input&width=200`,
          }])
        } catch (e) {
          toast.error(e instanceof Error ? e.message : 'Error uploading reference')
        }
      }
    } finally {
      setUploadingRefs(false)
    }
  }, [])

  const removeRef = useCallback((id: string) => {
    useRefineTarget.getState().removeUserRef(id)
  }, [])

  const queueItems = useGenQueue((s) => s.items)
  const myItem: QueueItem | undefined =
    queueItems.find((i) => i.type === 'refine' && i.status === 'running') ??
    queueItems.find(
      (i) => i.type === 'refine' && (i.status === 'submitting' || i.status === 'queued'),
    )
  const [lastDone, setLastDone] = useState<QueueItem | null>(null)
  const [lastError, setLastError] = useState<QueueItem | null>(null)

  const phase: Phase = myItem
    ? (myItem.status === 'submitting' ? 'submitting' : myItem.status === 'queued' ? 'queued' : 'running')
    : lastDone
      ? 'done'
      : lastError
        ? 'error'
        : 'idle'
  const promptId = myItem?.promptId ?? null
  const percent = myItem ? Math.round((myItem.progressValue / Math.max(myItem.progressMax, 1)) * 100) : lastDone ? 100 : 0
  const error = lastError?.error ?? null
  const startedAt = myItem
    ? (myItem.startedAt ?? myItem.createdAt)
    : (lastDone?.startedAt ?? lastDone?.createdAt ?? null)

  useEffect(() => {
    sweepOrphanRefineItems()
  }, [])

  useEffect(() => {
    for (const it of queueItems) {
      if (it.type !== 'refine') continue
      if (it.status === 'done' && it.completedAt && (!lastDone || it.completedAt > (lastDone.completedAt ?? 0))) {
        setLastDone(it)
      }
      if (it.status === 'error' && (!lastError || (it.completedAt ?? 0) > (lastError.completedAt ?? 0))) {
        setLastError(it)
      }
    }
  }, [queueItems, lastDone, lastError])

  const gallery = useVideoGallery()

  useEffect(() => {
    if (!storeTarget) return
    const file = gallery.files.find(
      (f) => f.filename === storeTarget.filename && f.subfolder === storeTarget.subfolder,
    )
    revokeSourceUrl(sourceRef.current)
    if (file) {
      setSource(file)
      toast.success(`Source: ${file.filename}`)
    } else {
      setSource({
        url: `/api/comfy/file?filename=${encodeURIComponent(storeTarget.filename)}&subfolder=${encodeURIComponent(storeTarget.subfolder)}`,
        filename: storeTarget.filename,
        subfolder: storeTarget.subfolder,
      })
    }
    clearStoreTarget()
  }, [storeTarget, gallery.files, clearStoreTarget, revokeSourceUrl, setSource])

  const busy = !!myItem

  useEffect(() => {
    setPrompt('')
    setSrcDims(null)
    useRefineTarget.getState().clearUserRefs()
  }, [source, setPrompt])

  const lastSubmitAtRef = useRef(0)
  const start = useCallback(async () => {
    const src = sourceRef.current
    if (!src) {
      toast.error('First select a source video')
      return
    }
    if (uploadingSrc) {
      toast.error('Video is still uploading — please wait')
      return
    }
    if (Date.now() - lastSubmitAtRef.current < 1000) return
    lastSubmitAtRef.current = Date.now()
    setLastDone(null)
    setLastError(null)

    const task = {
      mode: mode as 'whole' | 'chunks',
      source: { filename: src.filename, subfolder: src.subfolder ?? '' },
      ...(src.inputSource ? { inputSource: src.inputSource } : {}),
      target: target === 'same' ? 'same' as const : target === 'free' ? 'free' as const : parseInt(target, 10),
      ...(target === 'free' ? { targetMp } : {}),
      steps: parseInt(steps, 10),
      sigmaStart: strength,
      seed: -1,
      prompt: prompt.trim() ? prompt.trim() : '',
      ...(userRefs.length > 0 && { refImages: userRefs.map((r) => r.path) }),
      chunkSeconds: parseInt(chunkSec, 10),
      refImageSize: refDetail,
      keepOriginalAudio,
      ...(useGenStore.getState().video.vedaAttention === true && {
        vedaAttention: true,
        vedaGeneratedSparsity: useGenStore.getState().video.vedaGeneratedSparsity,
        vedaReferenceSparsity: useGenStore.getState().video.vedaReferenceSparsity,
        vedaFullAttentionLayers: useGenStore.getState().video.vedaFullAttentionLayers,
        vedaFullAttentionSteps: useGenStore.getState().video.vedaFullAttentionSteps,
        vedaVerbose: useGenStore.getState().video.vedaVerbose,
      }),
      ...(useGenStore.getState().video.sparseAttention === true && {
        sparseAttention: true,
        sparseTau: useGenStore.getState().video.sparseTau,
        sparseStartPercent: useGenStore.getState().video.sparseStartPercent,
        sparseEndPercent: useGenStore.getState().video.sparseEndPercent,
        sparseMinTokens: useGenStore.getState().video.sparseMinTokens,
        sparseExtraTokens: useGenStore.getState().video.sparseExtraTokens,
      }),
    }
    enqueueRefine(task)
    toast.info(`Refine queued: ${src.filename}`)
  }, [mode, target, targetMp, steps, strength, prompt, chunkSec, uploadingSrc, refDetail, keepOriginalAudio, userRefs])

  const cancel = useCallback(async () => {
    await cancelActiveRefines()
    toast.info('Refine cancelled')
  }, [])

  const reset = useCallback(() => {
    setLastDone(null)
    setLastError(null)
  }, [])

  const srcThumb = (f: VideoGalleryFile) =>
    f.url.includes('?') ? `${f.url}&width=320` : `${f.url}?width=320`

  return (
    <div className="flex h-full w-full min-w-0">
      {/* ═══ Parameter Panel ═══ */}
      <aside className="w-[360px] shrink-0 border-r border-border bg-[var(--surface-1)] flex flex-col">
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <div className="flex items-center gap-2">
            <Wand2Icon className="w-4 h-4 text-emerald-400" />
            <h2 className="text-sm font-semibold text-foreground">Refine</h2>
          </div>

          {/* Source */}
          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground font-medium">Source</Label>
            {source ? (
              <div
                onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault()
                  setDragOver(false)
                  const raw = e.dataTransfer.getData(H3_VIDEO_DND_MIME)
                  if (raw) {
                    try {
                      const parsed = JSON.parse(raw) as { filename?: string; subfolder?: string }
                      revokeSourceUrl(sourceRef.current)
                      setSource({
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
                }}
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
                    onLoadedMetadata={(e) => {
                      const v = e.currentTarget
                      if (v.videoWidth > 0 && v.videoHeight > 0) {
                        setSrcDims({ w: v.videoWidth, h: v.videoHeight })
                      }
                    }}
                    className="w-full h-full object-cover"
                  />
                </RefPreviewThumb>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-foreground truncate">
                    {source.filename}
                  </p>
                  {uploadingSrc && (
                    <p className="text-[10px] text-cyan-400">uploading…</p>
                  )}
                </div>
                {!busy && (
                  <button
                    onClick={() => { revokeSourceUrl(sourceRef.current); setSource(null) }}
                    className="text-[10px] text-muted-foreground hover:text-foreground shrink-0"
                  >
                    remove
                  </button>
                )}
              </div>
            ) : (
              <div
                onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault()
                  setDragOver(false)
                  const raw = e.dataTransfer.getData(H3_VIDEO_DND_MIME)
                  if (raw) {
                    try {
                      const parsed = JSON.parse(raw) as { filename?: string; subfolder?: string }
                      revokeSourceUrl(sourceRef.current)
                      setSource({
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
                }}
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

          {source && (
            <p className="text-[10px] text-muted-foreground/60 -mt-2">
              Output folder: {source.inputSource ? 'General' : `${source.subfolder || 'General'} (matching source)`}
            </p>
          )}

          {source && !source.inputSource && latentOk && (
            <p
              className="text-[10px] -mt-1 flex items-center gap-1.5 text-emerald-400/90"
              title={
                mode === 'whole'
                  ? 'Refine starts from original generation latent — lossless without h264 or re-encoding'
                  : 'Chunk mode windows are sliced from generation latent tokens directly — lossless without re-encoding'
              }
            >
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
              Latent ✓ — lossless refine
            </p>
          )}

          {source && source.inputSource && (
            <div className="space-y-2 rounded-lg border border-cyan-500/30 bg-cyan-500/5 p-2.5">
              <Label
                className="text-xs text-muted-foreground font-medium"
                title="File from disk has no saved metadata — describe the scene yourself and optionally add anchor images (character, location, style)."
              >
                Prompt and references
              </Label>
              <div className="relative">
                <Textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="Describe the scene: action, characters, style, lighting. Empty — generic enhancement prompt…"
                  disabled={uploadingRefs}
                  className="min-h-[72px] resize-y bg-[var(--surface-2)] border-border text-xs pr-14"
                />
                <button
                  type="button"
                  onClick={() => setFixOpen(true)}
                  title="Improve prompt with assistant: describe changes — prompt and request will be sent to chat"
                  className="absolute top-2 right-9 p-1.5 rounded-md bg-[var(--surface-3)]/80 hover:bg-[var(--surface-4)] text-violet-300 hover:text-violet-200 transition-colors border border-violet-500/30 z-10 backdrop-blur-sm"
                >
                  <WandSparklesIcon className="w-3.5 h-3.5" />
                </button>
                {prompt.trim() && (
                  <button
                    type="button"
                    onClick={() => setPrompt('')}
                    title="Clear prompt field"
                    className="absolute top-2 right-16 p-1.5 rounded-md bg-[var(--surface-3)]/80 hover:bg-red-500/15 text-muted-foreground hover:text-red-400 transition-colors border border-border/50 z-10 backdrop-blur-sm"
                  >
                    <Trash2Icon className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              <div
                onDragOver={(e) => { e.preventDefault(); setRefsDragOver(true) }}
                onDragLeave={() => setRefsDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault()
                  setRefsDragOver(false)
                  void addRefFiles(Array.from(e.dataTransfer.files))
                }}
                onClick={() => refsInputRef.current?.click()}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); refsInputRef.current?.click() } }}
                className={cn(
                  'rounded-lg border border-dashed p-2.5 text-[11px] text-muted-foreground text-center cursor-pointer transition-all',
                  refsDragOver ? 'border-cyan-400 bg-cyan-500/10' : 'border-border hover:border-cyan-500/40 hover:bg-[var(--surface-2)]',
                )}
              >
                <input
                  ref={refsInputRef}
                  type="file"
                  multiple
                  accept="image/png,image/jpeg,image/webp,image/bmp,image/tiff"
                  className="hidden"
                  onChange={(e) => {
                    void addRefFiles(Array.from(e.target.files ?? []))
                    e.target.value = ''
                  }}
                />
                {uploadingRefs ? (
                  <span className="text-cyan-400">Uploading references…</span>
                ) : (
                  <span className="flex items-center justify-center gap-1.5">
                    <UploadIcon className="w-3.5 h-3.5" />
                    References (optional, up to 8)
                  </span>
                )}
              </div>
              {userRefs.length > 0 && (
                <div className="grid grid-cols-4 gap-1.5">
                  {userRefs.map((r, i) => (
                    <div key={r.id} className="relative group rounded-md overflow-hidden border border-border bg-black/40 aspect-square">
                      <RefPreviewThumb
                        kind="image"
                        name={r.name}
                        path={r.path}
                        url={r.previewUrl}
                        className="w-full h-full block"
                        title="Open reference in full screen"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={r.previewUrl} alt={r.name} className="w-full h-full object-cover" />
                      </RefPreviewThumb>
                      <span className="absolute left-0.5 bottom-0.5 text-[9px] font-mono px-1 rounded bg-black/70 text-cyan-300 pointer-events-none">
                        P{i + 1}
                      </span>
                      <button
                        onClick={() => removeRef(r.id)}
                        className="absolute right-0.5 top-0.5 p-0.5 rounded bg-black/70 text-muted-foreground hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
                        title={`Delete (${r.name})`}
                      >
                        <XIcon className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <p className="text-[10px] text-muted-foreground/60">
                Reference images in prompt as &lt;Picture 1&gt;, &lt;Picture 2&gt;… The first video frame will be added as an anchor in the last slot automatically.
              </p>
            </div>
          )}

          {source && !source.inputSource && (
            <div className="space-y-2">
              <Label
                className="text-xs text-muted-foreground font-medium"
                title="Images saved in the video during generation, plus its first frame — they help preserve characters, colors, and lighting."
              >
                Metadata references
              </Label>
              {metaLoading ? (
                <p className="text-[10px] text-muted-foreground">Reading metadata…</p>
              ) : metaRefs && metaRefs.length > 0 ? (
                <>
                  <div className="flex flex-wrap gap-1.5">
                    {metaRefs.map((r, i) => (
                      <div
                        key={`${r.path}-${i}`}
                        title={r.path}
                        className="relative w-14 rounded-md border border-purple-500/30 bg-[var(--surface-2)] overflow-hidden"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={`/api/comfy/file?filename=${encodeURIComponent(r.path)}&type=input&width=96`}
                          alt=""
                          loading="lazy"
                          className="w-14 h-14 object-cover"
                        />
                        <span className="absolute top-0.5 left-0.5 rounded bg-black/70 px-1 text-[10px] font-mono text-cyan-300">
                          P{i + 1}
                        </span>
                        <p className="px-1 py-0.5 text-[10px] leading-tight text-muted-foreground truncate">
                          {r.role
                            ? ({ identity: 'character', scene: 'scene', style: 'style', composition: 'composition' } as Record<string, string>)[r.role] ?? r.role
                            : r.path.split(/[\\/]/).pop()}
                        </p>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <p className="text-[10px] text-muted-foreground">
                  No metadata: only the first frame will be used as anchor.
                </p>
              )}
            </div>
          )}

          {/* Reference size mode */}
          <div className="space-y-2">
            <Label
              className="text-xs text-muted-foreground font-medium"
              title="How to process reference images. Match — faster; Max — preserves details more accurately, but slower."
            >
              Refs: size mode
            </Label>
            <div className="grid grid-cols-2 gap-1.5">
              {(['match', 'max'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => patchParams({ refDetail: m })}
                  className={cn(
                    'px-2 py-1.5 rounded-md border text-xs transition-colors',
                    refDetail === m
                      ? 'border-cyan-500/40 text-cyan-300 bg-cyan-500/10'
                      : 'border-border text-muted-foreground hover:text-foreground',
                  )}
                >
                  {m === 'match' ? 'Match (fast)' : 'Max (quality)'}
                </button>
              ))}
            </div>
          </div>

          {/* Target resolution */}
          <div className="space-y-2">
            <Label
              className="text-xs text-muted-foreground font-medium"
              title={
                target === 'same'
                  ? 'Resolution does not change — video simply becomes clearer and more detailed.'
                  : target === 'free'
                    ? 'Exact output size in megapixels (like in Generation tab), source aspect ratio is preserved. Up to 8.3 MP = 4K.'
                    : `Short side of output will be ${target}p, source aspect ratio is preserved.`
              }
            >
              Target resolution
            </Label>
            <Select value={target} onValueChange={(v) => patchParams({ target: v as 'same' | '720' | '1080' | 'free' })}>
              <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
                <SelectValue placeholder="Resolution" />
              </SelectTrigger>
              <SelectContent className="bg-[var(--surface-3)] border-border">
                <SelectItem value="720">720p (faster, safer for VRAM)</SelectItem>
                <SelectItem value="1080">1080p (slower, maximum detail)</SelectItem>
                <SelectItem value="free">Custom (in MP, up to 4K)</SelectItem>
                <SelectItem value="same">Same as source (detail enhancement only)</SelectItem>
              </SelectContent>
            </Select>
            {target === 'free' && (
              <SettingSlider
                label="Resolution (MP)"
                labelTitle="Exact output size in megapixels — source aspect ratio is preserved. 8.3 MP = 4K (e.g. 3840×2160). Above 2–3 MP uses noticeably more VRAM and time."
                value={targetMp}
                onChange={(v) => patchParams({ targetMp: Math.round(v * 100) / 100 })}
                min={0.2}
                max={8.3}
                step={0.05}
                formatValue={(v) => {
                  if (!srcDims) return `${v.toFixed(2)} MP`
                  const scale = Math.sqrt((Math.min(8.3, v) * 1e6) / (srcDims.w * srcDims.h))
                  const even = (n: number) => 2 * Math.round(n / 2)
                  return `${v.toFixed(2)} MP (≈${even(srcDims.w * scale)}×${even(srcDims.h * scale)})`
                }}
                inputMin={0.2}
                inputMax={8.3}
                inputHint="0.2–8.3 MP (8.3 = 4K). Above 2–3 MP uses noticeably more VRAM and time"
              />
            )}
          </div>

          {/* Mode: whole / chunks */}
          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground font-medium">Mode</Label>
            <div className="grid grid-cols-2 gap-1.5">
              {([
                ['whole', 'Full', 'Single job for the entire video'],
                ['chunks', 'Chunks', 'Overlapping chunks + seamless blending (for long videos)'],
              ] as const).map(([m, label, hint]) => (
                <button
                  key={m}
                  type="button"
                  title={hint}
                  onClick={() => {
                    if (mode === m) return
                    const defaultStrength = m === 'chunks' ? 0.8 : 0.9
                    patchParams({ mode: m, strength: defaultStrength })
                  }}
                  className={cn(
                    'h-8 rounded-md border text-xs font-medium transition-all',
                    mode === m
                      ? 'bg-cyan-500/15 border-cyan-500/50 text-cyan-300'
                      : 'bg-[var(--surface-2)] border-border text-muted-foreground hover:border-cyan-500/30',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            {mode === 'chunks' && (
              <div
                className="space-y-1.5 pt-1"
                title="Long video is processed in overlapping chunks, then seamlessly blended together. Sound is regenerated with video — check 'Keep original audio' below to preserve the original track."
              >
                <Select value={chunkSec} onValueChange={(v) => patchParams({ chunkSec: v as '3' | '5' | '8' })}>
                  <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
                    <SelectValue placeholder="Chunk length" />
                  </SelectTrigger>
                  <SelectContent className="bg-[var(--surface-3)] border-border">
                    <SelectItem value="3">~3 s (less VRAM)</SelectItem>
                    <SelectItem value="5">~5 s (recommended)</SelectItem>
                    <SelectItem value="8">~8 s (faster overall)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          {/* Pass profile (Pass 2 sigma ladder) */}
          <div className="space-y-2">
            <Label
              className="text-xs text-muted-foreground font-medium"
              title={
                steps === '2'
                  ? 'Light touchup: model only slightly enhances details, barely changing the picture.'
                  : 'How many steps the refinement pass performs. 3 is a proven balance of speed and clarity; more is more detailed, but slower.'
              }
            >
              Pass (steps)
            </Label>
            <Select value={steps} onValueChange={(v) => patchParams({ steps: v as '2' | '3' | '4' | '5' | '6' | '7' })}>
              <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
                <SelectValue placeholder="Steps" />
              </SelectTrigger>
              <SelectContent className="bg-[var(--surface-3)] border-border">
                <SelectItem value="2">2 steps</SelectItem>
                <SelectItem value="3">3 steps — fast (generation standard)</SelectItem>
                <SelectItem value="4">4 steps — more detailed</SelectItem>
                <SelectItem value="5">5 steps</SelectItem>
                <SelectItem value="6">6 steps</SelectItem>
                <SelectItem value="7">7 steps — maximum (same as generation)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Refine strength */}
          <div className="space-y-1.5">
            <SettingSlider
              label="Refine strength"
              labelTitle={
                strength >= 0.9
                  ? 'Model boldly adds details — maximum effect.'
                  : strength >= 0.6
                    ? 'Changes are subtle, result remains closer to source.'
                    : 'Very light touchup — minimal redrawing, details may not increase.'
              }
              value={Math.round(strength * 100)}
              min={30}
              max={95}
              step={5}
              onChange={(v) => patchParams({ strength: v / 100 })}
              formatValue={() => `${Math.round(strength * 100)}% · σ ${strength.toFixed(3)}`}
            />
            <div className="flex items-center gap-2">
              <span
                className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground"
                title="Actual sigma ladder (start → … → 0) fed to sampler. Pass 2 preset mirrors the second pass of two-pass generation."
              >
                σ{' '}
                {refineSigmaLadder(parseInt(steps, 10), strength)
                  .split(',')
                  .map((s) => s.trim())
                  .join(' → ')}
              </span>
              <button
                type="button"
                onClick={() =>
                  patchParams({
                    steps: String(REFINE_PASS2_STEPS) as '2' | '3' | '4' | '5' | '6' | '7',
                    strength: REFINE_PASS2_SIGMA,
                  })
                }
                title={`Like generation Pass 2: ${REFINE_PASS2_STEPS} steps, start σ ${REFINE_PASS2_SIGMA} — exact ladder match.`}
                className={
                  steps === String(REFINE_PASS2_STEPS) &&
                  Math.abs(strength - REFINE_PASS2_SIGMA) < 1e-6
                    ? 'shrink-0 rounded-md border border-cyan-500/50 bg-cyan-500/10 px-1.5 py-0.5 font-mono text-[10px] text-cyan-300'
                    : 'shrink-0 rounded-md border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground transition-colors hover:border-cyan-500/40 hover:text-foreground'
                }
              >
                Pass 2
              </button>
            </div>
          </div>

          {/* Keep original audio */}
          <label
            className="flex items-start gap-2 cursor-pointer select-none pt-1"
            title="By default sound is regenerated by model alongside video. Checkbox preserves original audio track as is."
          >
            <input
              type="checkbox"
              checked={keepOriginalAudio}
              onChange={(e) => patchParams({ keepOriginalAudio: e.target.checked })}
              className="mt-0.5 h-4 w-4 shrink-0 accent-cyan-500"
            />
            <span className="text-xs text-muted-foreground font-medium leading-tight">
              Keep original audio
              <span className="block text-[10px] font-normal text-muted-foreground/70">
                do not regenerate audio track — less work, sounds identical to source
              </span>
            </span>
          </label>

          {/* Launch */}
          <div className="flex gap-2 pt-1">
            <Button
              onClick={start}
              disabled={!source}
              className="flex-1 gap-1.5"
            >
              {busy ? <Loader2Icon className="w-4 h-4 animate-spin" /> : <PlayIcon className="w-4 h-4" />}
              {busy ? 'Queue another' : 'Run Refine'}
            </Button>
          </div>
        </div>

        {/* Pinned bottom: generation status */}
        <div className="shrink-0 border-t border-border p-3 bg-[var(--surface-1)]/90 backdrop-blur-sm">
          <GenerationStatus
            isGenerating={busy}
            phase={phase}
            progressPercent={percent}
            statusMessage={null}
            error={error}
            onInterrupt={cancel}
            onReset={reset}
            startedAt={startedAt}
            promptId={promptId}
            stageKind={mode === 'chunks' ? 'chunks' : 'single'}
          />
        </div>
      </aside>

      <PromptFixDialog
        open={fixOpen}
        onOpenChange={setFixOpen}
        hint="The prompt and your request will be sent to assistant chat — you can paste the response back with 'To Prompt'. Ctrl+Enter to send, Esc to cancel."
        onSubmit={(req) => requestImprovePrompt(prompt, { mode: 'generate', fixRequest: req })}
      />

      {/* Right side: gallery */}
      <section className="flex-1 min-w-0 flex flex-col overflow-hidden">
        <div className="flex-1 min-h-0 overflow-y-auto p-3">
          <VideoGalleryGrid
            files={gallery.files}
            loading={gallery.loading}
            onRefresh={() => void gallery.load()}
            onDeleteFile={gallery.deleteFile}
            emptyHint="Refine results will appear here"
          />
        </div>
      </section>
    </div>
  )
}
