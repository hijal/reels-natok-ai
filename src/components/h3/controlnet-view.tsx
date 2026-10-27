'use client'

/**
 * ControlNetView — "ControlNet" tab: video generation following the motion
 * of a control video (3D puppet, previz, or reference) frame-by-frame
 * via the standard MiniMax H3 References workflow.
 * Control video is passed as a video reference (depth/canny map).
 *
 * Layout similar to "Generation": left — parameters + status,
 * top center — prompt card (with assistant improvement button),
 * below — gallery, right — assistant panel in 'controlnet' mode.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  WaypointsIcon,
  PlayIcon,
  FileVideoIcon,
  AlertTriangleIcon,
  DicesIcon,
  UploadIcon,
  XIcon,
  SparklesIcon,
  HistoryIcon,
  StarIcon,
  FolderIcon,
  FilmIcon,
  ChevronDownIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

import { MentionTextarea, type MentionItem } from './mention-textarea'
import { PromptEditorDialog, PromptEditButton, PromptFixButton, PromptClearButton, PromptFixDialog, PromptFieldTools } from './prompt-editor-dialog'
import { requestImprovePrompt } from '@/hooks/use-improve-prompt'
import { PromptQuality } from './prompt-quality'
import { RefPreviewThumb } from './ref-preview-thumb'
import { VoiceInputButton } from './voice-input-button'
import { EXAMPLES } from './learn/prompt-guide'
import { usePromptHistory } from '@/lib/prompt-history-store'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { SettingSlider } from '@/components/h3/setting-slider'
import { VideoGalleryGrid, H3_VIDEO_DND_MIME } from '@/components/h3/video-gallery-grid'
import { GenerationStatus } from '@/components/h3/generation-status'
import { useVideoGallery } from '@/components/h3/use-video-gallery'
import { useControlNetTarget, type ControlNetSource } from '@/lib/controlnet-target-store'
import { useControlNetJob } from '@/lib/controlnet-job-store'
import { uploadInputFile } from '@/lib/upload'
import { AssistantPanel } from './assistant/assistant-panel'
import { useGenStore } from '@/lib/gen-store'

const SAMPLER_OPTIONS = [
  { value: 'euler', label: 'euler (default, classic)' },
  { value: 'er_sde', label: 'er_sde (SDE)' },
  { value: 'dpmpp_2m', label: 'dpmpp_2m (multistep)' },
  { value: 'dpmpp_3m_sde', label: 'dpmpp_3m_sde (high quality)' },
  { value: 'heun', label: 'heun (2nd order)' },
  { value: 'lcm', label: 'lcm (few steps)' },
  { value: 'res_multistep', label: 'res_multistep (residual)' },
]

const SCHEDULER_OPTIONS = [
  { value: 'simple', label: 'simple (default)' },
  { value: 'sgm_uniform', label: 'sgm_uniform' },
  { value: 'karras', label: 'karras' },
  { value: 'exponential', label: 'exponential' },
  { value: 'ddim_uniform', label: 'ddim_uniform' },
  { value: 'normal', label: 'normal' },
  { value: 'beta', label: 'beta' },
  { value: 'linear_quadratic', label: 'linear_quadratic' },
  { value: 'kl_optimal', label: 'kl_optimal' },
]

export function ControlNetView() {
  const storeTarget = useControlNetTarget((s) => s.target)
  const clearStoreTarget = useControlNetTarget((s) => s.clear)
  const source = useControlNetTarget((s) => s.source)
  const setSource = useControlNetTarget((s) => s.setSource)
  const prevSourceUrlRef = useRef<string | null>(null)
  const setSourceSafe = useCallback(
    (next: ControlNetSource | null) => {
      const prev = prevSourceUrlRef.current
      if (prev && prev.startsWith('blob:') && prev !== next?.url) {
        try { URL.revokeObjectURL(prev) } catch { /* already revoked */ }
      }
      prevSourceUrlRef.current = next?.url ?? null
      setSource(next)
    },
    [setSource],
  )
  const sourceRef = useRef<ControlNetSource | null>(null)
  sourceRef.current = source

  const params = useControlNetTarget((s) => s.params)
  const patchParams = useControlNetTarget((s) => s.patchParams)
  const outputFolder = useControlNetTarget((s) => s.outputFolder)
  const setOutputFolder = useControlNetTarget((s) => s.setOutputFolder)
  const [folderMenuOpen, setFolderMenuOpen] = useState(false)

  const isDraft = params.pipeline === 'draft'
  const cnSplit = Math.max(1, Math.round(params.firstSamplerSteps ?? 6))
  const cnTotal = Math.max(2, Math.min(64, Math.round(params.firstSamplerTotalSteps ?? cnSplit)))
  const cnEffSplit = Math.min(cnSplit, cnTotal)
  const cnSigmaEnd = 1 - (cnEffSplit - 1) / cnTotal
  const cnPass2Steps =
    params.sigmaVariant === '7step' ? 7
      : params.sigmaVariant === '6step' ? 6
        : params.sigmaVariant === '5step' ? 5
          : params.sigmaVariant === '4step' ? 4 : 3
  const cnPass2Start =
    params.sigmaVariant === '5step' ? 0.9231
      : params.sigmaVariant === '6step' ? 0.9412
        : params.sigmaVariant === '7step' ? 0.95 : 0.9035
  const [showPass1, setShowPass1] = useState(false)
  const [showPass2, setShowPass2] = useState(false)

  const prompt = useControlNetTarget((s) => s.prompt)
  const setPrompt = useControlNetTarget((s) => s.setPrompt)
  const seed = useControlNetTarget((s) => s.seed)
  const setSeed = useControlNetTarget((s) => s.setSeed)
  const [dragOver, setDragOver] = useState(false)
  const [uploadingSrc, setUploadingSrc] = useState(false)

  const refImages = useControlNetTarget((s) => s.refImages)
  const [uploadingRefs, setUploadingRefs] = useState(false)
  const [refsDragOver, setRefsDragOver] = useState(false)
  const refsInputRef = useRef<HTMLInputElement>(null)

  const busy = useControlNetJob((s) => s.busy)
  const phase = useControlNetJob((s) => s.phase)
  const progress = useControlNetJob((s) => s.progress)
  const error = useControlNetJob((s) => s.error)
  const promptId = useControlNetJob((s) => s.promptId)
  const startedAt = useControlNetJob((s) => s.startedAt)
  const jobSubmit = useControlNetJob((s) => s.submit)
  const jobCancel = useControlNetJob((s) => s.cancel)
  const jobReset = useControlNetJob((s) => s.reset)

  const gallery = useVideoGallery()

  const [missingModels, setMissingModels] = useState<string[]>([])
  const [showAdvanced, setShowAdvanced] = useState(false)
  useEffect(() => {
    let cancelled = false
    const check = () => {
      fetch('/api/models/status')
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (cancelled || !data) return
          const models = (data.models ?? []) as Array<{ id: string; label: string; status: string }>
          const need = params.preprocessOnly
            ? (params.controlType === 'depth' ? ['depth_anything_v2_vits'] : [])
            : [
                ...(params.controlType === 'depth' ? ['depth_anything_v2_vits'] : []),
                'diffusion',
                'text_encoder',
                'vae_video',
                ...(params.pipeline === 'full' ? ['upscaler'] : []),
              ]
          setMissingModels(
            models.filter((m) => need.includes(m.id) && m.status !== 'ready').map((m) => m.label),
          )
        })
        .catch(() => {})
    }
    check()
    const t = setInterval(check, 15_000)
    return () => { cancelled = true; clearInterval(t) }
  }, [params.controlType, params.preprocessOnly, params.pipeline])
  const modelsMissing = missingModels.length > 0

  useEffect(() => {
    if (!storeTarget) return
    const file = gallery.files.find(
      (f) => f.filename === storeTarget.filename && f.subfolder === storeTarget.subfolder,
    )
    if (file) {
      setSourceSafe(file as ControlNetSource)
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

  const REF_SHORT_EDGE_CAP = 1024
  const downscaleRef = useCallback(async (file: File): Promise<File> => {
    try {
      const bmp = await createImageBitmap(file)
      const short = Math.min(bmp.width, bmp.height)
      if (short <= REF_SHORT_EDGE_CAP) { bmp.close(); return file }
      const scale = REF_SHORT_EDGE_CAP / short
      const w = Math.max(2, Math.round(bmp.width * scale))
      const h = Math.max(2, Math.round(bmp.height * scale))
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) { bmp.close(); return file }
      ctx.drawImage(bmp, 0, 0, w, h)
      bmp.close()
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'))
      if (!blob) return file
      return new File([blob], file.name.replace(/\.[a-z0-9]+$/i, '') + '.png', { type: 'image/png' })
    } catch {
      return file
    }
  }, [])

  const addRefFiles = useCallback(async (files: File[]) => {
    const images = files.filter((f) => /^image\//.test(f.type) || /\.(png|jpe?g|webp|bmp|tiff?)$/i.test(f.name))
    if (!images.length) { toast.error('References must be images (png, jpg, webp)'); return }
    const room = 9 - useControlNetTarget.getState().refImages.length
    if (room <= 0) { toast.error('Maximum of 9 reference images'); return }
    if (images.length > room) toast.error(`Maximum 9 references — added ${room}`)
    setUploadingRefs(true)
    try {
      for (const raw of images.slice(0, room)) {
        try {
          const file = await downscaleRef(raw)
          const { path } = await uploadInputFile(file)
          useControlNetTarget.getState().addRefImages([{
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
  }, [downscaleRef])

  const removeRef = useCallback((id: string) => {
    useControlNetTarget.getState().removeRefImage(id)
  }, [])

  const start = useCallback(async () => {
    const src = sourceRef.current
    if (!src) {
      toast.error('First select a control video')
      return
    }
    if (uploadingSrc) {
      toast.error('Video is still uploading')
      return
    }
    if (modelsMissing) {
      toast.error('First download ControlNet models (Settings → Models)')
      return
    }

    const st = useControlNetTarget.getState()
    const body: Record<string, unknown> = {
      ...(src.inputSource
        ? { inputSource: src.inputSource }
        : { sourceFilename: src.filename, sourceSubfolder: src.subfolder ?? '' }),
      prompt: st.prompt.trim() || undefined,
      seed: st.seed,
      duration: params.duration,
      targetShortSide: params.targetShortSide,
      controlType: params.controlType,
      preprocessOnly: params.preprocessOnly || undefined,
      outputSubfolder: st.outputFolder,
      refImageSize: params.refImageSize,
      compress: params.compressSource || undefined,
      pipeline: params.pipeline,
      draftSteps: params.draftSteps,
      firstSamplerSteps: params.firstSamplerSteps,
      firstSamplerTotalSteps: params.firstSamplerTotalSteps ?? params.firstSamplerSteps ?? 6,
      pass1Sampler: params.pass1Sampler,
      pass1Scheduler: params.pass1Scheduler,
      pass2Sampler: params.pass2Sampler,
      sigmaVariant: params.sigmaVariant,
      lowResMP: params.lowResMP,
      ...(st.refImages.length > 0 && { refImages: st.refImages.map((r) => r.path) }),
      ...(() => {
        const v = useGenStore.getState().video
        return {
          sparseAttention: v.sparseAttention,
          sparseTau: v.sparseTau,
          sparseStartPercent: v.sparseStartPercent,
          sparseEndPercent: v.sparseEndPercent,
          sparseMinTokens: v.sparseMinTokens,
          sparseExtraTokens: v.sparseExtraTokens,
          vedaAttention: v.vedaAttention,
          vedaGeneratedSparsity: v.vedaGeneratedSparsity,
          vedaReferenceSparsity: v.vedaReferenceSparsity,
          vedaFullAttentionLayers: v.vedaFullAttentionLayers,
          vedaFullAttentionSteps: v.vedaFullAttentionSteps,
          vedaVerbose: v.vedaVerbose,
          lowVramAttention: v.lowVramAttention,
          chunkFeedForward: v.chunkFeedForward,
          chunkFFChunks: v.chunkFFChunks,
          chunkFFThreshold: v.chunkFFThreshold,
        }
      })(),
    }
    await jobSubmit(body)
  }, [uploadingSrc, params, modelsMissing, jobSubmit])

  const cancel = useCallback(() => { void jobCancel() }, [jobCancel])
  const reset = useCallback(() => { jobReset() }, [jobReset])

  const [promptEditorOpen, setPromptEditorOpen] = useState(false)
  const [fixOpen, setFixOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [examplesOpen, setExamplesOpen] = useState(false)
  const historyBtnRef = useRef<HTMLButtonElement>(null)
  const examplesBtnRef = useRef<HTMLButtonElement>(null)
  const historyEntries = usePromptHistory((s) => s.entries)
  const toggleHistoryFavorite = usePromptHistory((s) => s.toggleFavorite)
  const removeHistoryEntry = usePromptHistory((s) => s.remove)
  const clearHistory = usePromptHistory((s) => s.clear)

  const dropdownPos = (anchor: HTMLElement): React.CSSProperties => {
    const r = anchor.getBoundingClientRect()
    const width = 340
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8))
    const top = Math.min(r.bottom + 6, window.innerHeight - 80)
    return { top, left, width }
  }

  const applyExample = useCallback(
    (text: string) => {
      const old = useControlNetTarget.getState().prompt
      useControlNetTarget.getState().setPrompt(text)
      setExamplesOpen(false)
      if (old.trim()) {
        toast.success('Example inserted (previous prompt replaced)', {
          action: { label: 'Undo', onClick: () => useControlNetTarget.getState().setPrompt(old) },
        })
      }
    },
    [],
  )

  const canStart = Boolean(source) && !modelsMissing && !params.preprocessOnly
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && canStart) {
        e.preventDefault()
        void start()
      }
    },
    [start, canStart],
  )

  const startWithHistory = useCallback(async () => {
    const p = useControlNetTarget.getState().prompt.trim()
    if (p) usePromptHistory.getState().add(p)
    await start()
  }, [start])

  const srcThumb = (f: ControlNetSource) =>
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

  return (
    <div className="flex h-full w-full min-w-0">
      {/* ═══ Parameter Panel ═══ */}
      <aside className="w-[360px] shrink-0 border-r border-border bg-[var(--surface-1)] flex flex-col">
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <div className="flex items-center gap-2">
            <WaypointsIcon className="w-4 h-4 text-orange-400" />
            <h2 className="text-sm font-semibold text-foreground">ControlNet</h2>
          </div>
          <p className="text-[10px] text-muted-foreground/70 -mt-2">
            Video generation following the motion of a control video (3D puppet, previz, or reference) frame-by-frame.
          </p>

          {/* Missing models banner */}
          {modelsMissing && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
              <AlertTriangleIcon className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <p className="text-xs text-amber-300">
                To use ControlNet mode, download models: {missingModels.join(', ')} — Settings → Models (Preprocessors category)
              </p>
            </div>
          )}

          {/* Mode */}
          <div className="space-y-1">
            <Label
              className="text-xs text-muted-foreground"
              title="Draft — single pass (fast). Full — two passes: low-res draft, then latent upscale and refinement at full resolution (longer, higher quality). Map — save Depth/Canny video without generation for use in external tools."
            >
              Mode
            </Label>
            <div className="grid grid-cols-3 gap-1.5">
              {([
                ['draft', 'Draft', 'Single pass — fast'],
                ['full', 'Full', 'Two passes: low-res draft → latent upscale → refinement at full resolution'],
                ['map', 'Map', 'Save Depth/Canny video without generation'],
              ] as const).map(([v, label, hint]) => {
                const active = v === 'map'
                  ? params.preprocessOnly
                  : !params.preprocessOnly && params.pipeline === v
                const mapDisabled = busy || (v === 'map' && params.controlType === 'direct')
                return (
                  <button
                    key={v}
                    type="button"
                    title={v === 'map' && params.controlType === 'direct' ? 'Not available in Direct mode' : hint}
                    disabled={mapDisabled}
                    onClick={() => patchParams(
                      v === 'map'
                        ? { preprocessOnly: true }
                        : { preprocessOnly: false, pipeline: v },
                    )}
                    className={cn(
                      'h-8 rounded-md border px-1 text-xs font-medium transition-all min-w-0 truncate text-center',
                      mapDisabled && 'opacity-40 cursor-not-allowed',
                      active
                        ? 'bg-orange-500/15 border-orange-500/50 text-orange-300'
                        : 'bg-[var(--surface-2)] border-border text-muted-foreground hover:border-orange-500/30',
                    )}
                  >
                    {label}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Source */}
          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground font-medium">Source (control video)</Label>
            {source ? (
              <div
                onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
                onDragLeave={() => setDragOver(false)}
                onDrop={dropHandler}
                className={cn(
                  'flex items-center gap-3 rounded-lg border bg-[var(--surface-2)] p-2 transition-all',
                  dragOver ? 'border-orange-400 ring-1 ring-orange-400/50' : 'border-border',
                )}
              >
                <RefPreviewThumb
                  kind="video"
                  name={source.filename}
                  url={source.url}
                  className="w-20 h-12 rounded object-cover bg-black shrink-0"
                  title="Open control video in full screen"
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
                  {uploadingSrc && <p className="text-[10px] text-orange-400">uploading…</p>}
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
                  dragOver ? 'border-orange-400 bg-orange-500/10' : 'border-border hover:border-orange-500/40 hover:bg-[var(--surface-2)]',
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
            <label
              className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer"
              title="Before processing, video is resized to 480p preserving aspect ratio (cached on server) — faster preprocessing and less VRAM. High resolution is not needed for motion transfer."
            >
              <input
                type="checkbox"
                checked={params.compressSource}
                onChange={(e) => patchParams({ compressSource: e.target.checked })}
                className="accent-orange-500"
              />
              Compress video to 480p
            </label>
          </div>

          {/* Reference images */}
          <div className={cn('space-y-1.5', params.preprocessOnly && 'opacity-40 pointer-events-none select-none')}>
            <Label
              className="text-xs text-muted-foreground font-medium flex items-center justify-between"
              title="Images of character, location, or scene — the model preserves their visual appearance in every frame. Refer to them as <Picture 1>, <Picture 2>, etc. in prompt."
            >
              <span>References (character / location / frame){params.preprocessOnly ? ' — not used in Map mode' : ''}</span>
              {refImages.length > 0 && <span className="text-[10px] font-normal">{refImages.length}/9</span>}
            </Label>
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
                refsDragOver ? 'border-orange-400 bg-orange-500/10' : 'border-border hover:border-orange-500/40 hover:bg-[var(--surface-2)]',
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
                <span className="text-orange-400">Uploading references…</span>
              ) : (
                <span className="flex items-center justify-center gap-1.5">
                  <UploadIcon className="w-3.5 h-3.5" />
                  Drag & drop or select images (up to 9)
                </span>
              )}
            </div>
            {refImages.length > 0 && (
              <div className="grid grid-cols-4 gap-1.5">
                {refImages.map((r, i) => (
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
                    <span className="absolute left-0.5 bottom-0.5 text-[9px] font-mono px-1 rounded bg-black/70 text-orange-300 pointer-events-none">
                      &lt;Picture {i + 1}&gt;
                    </span>
                    {!busy && (
                      <button
                        onClick={() => removeRef(r.id)}
                        className="absolute right-0.5 top-0.5 p-0.5 rounded bg-black/70 text-muted-foreground hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
                        title={`Delete (${r.name})`}
                      >
                        <XIcon className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
            <p className="text-[10px] text-muted-foreground/60">
              In prompt, refer to them as &lt;Picture 1&gt;, &lt;Picture 2&gt;…
            </p>

            {/* Reference size mode */}
            <div className="space-y-1 pt-1">
              <Label
                className="text-xs text-muted-foreground"
                title="How to process uploaded images. Match — downscales reference to frame size (faster, but face may lose resemblance). Max — preserves reference details (better identity, slower). In ControlNet, references are capped at 1024px during upload to prevent crowding out motion control."
              >
                Refs: size mode
              </Label>
              <div className="grid grid-cols-2 gap-1.5">
                {(['match', 'max'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => patchParams({ refImageSize: m })}
                    className={cn(
                      'px-2 py-1.5 rounded-md border text-xs transition-colors',
                      params.refImageSize === m
                        ? 'border-orange-500/40 text-orange-300 bg-orange-500/10'
                        : 'border-border text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {m === 'match' ? 'Match (fast)' : 'Max (detailed)'}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Control type */}
          <div className="space-y-1">
            <Label
              className="text-xs text-muted-foreground"
              title="Depth — distance map (scenes, volume). Canny — edge contours (drawings, blueprints). Pose — body skeleton (DWPose). Direct — video passed as standard reference without maps."
            >
              Control type
            </Label>
            <Select
              value={params.controlType}
              onValueChange={(v) => patchParams({
                controlType: v as 'depth' | 'canny' | 'direct' | 'pose',
                ...(v === 'direct' && params.preprocessOnly ? { preprocessOnly: false } : {}),
              })}
            >
              <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-[var(--surface-3)] border-border">
                <SelectItem value="depth">Depth</SelectItem>
                <SelectItem value="canny">Contours (Canny)</SelectItem>
                <SelectItem value="pose">Pose (DWPose)</SelectItem>
                <SelectItem value="direct">Direct (no maps)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Duration */}
          <div className="space-y-1">
            <SettingSlider
              label="Duration, sec"
              labelTitle="Result duration in seconds."
              value={params.duration}
              min={1}
              max={30}
              step={1}
              onChange={(v) => patchParams({ duration: Math.round(v) })}
              formatValue={(v) => `${v} s`}
            />
            <p className="text-[10px] text-muted-foreground/60">
              If control video is shorter, duration will be trimmed to match it.
            </p>
          </div>

          {/* Short side */}
          <div className="space-y-1">
            <Label
              className="text-xs text-muted-foreground"
              title="Short side of result. Long side is computed by control video aspect ratio."
            >
              Short side of result
            </Label>
            <Select
              value={String(params.targetShortSide)}
              onValueChange={(v) => patchParams({ targetShortSide: parseInt(v, 10) })}
            >
              <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-[var(--surface-3)] border-border">
                {[480, 576, 720, 1080].map((n) => <SelectItem key={n} value={String(n)}>{n}p</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          {/* Advanced parameters */}
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="w-full flex items-center justify-between px-3 py-2 rounded-lg bg-[var(--surface-2)] border border-border hover:border-orange-500/30 transition-all text-left"
            >
              <span className="text-xs font-medium text-muted-foreground">Advanced Parameters</span>
              <span className={cn('text-[10px] text-muted-foreground transition-transform', showAdvanced && 'rotate-180')}>▼</span>
            </button>

            {showAdvanced && (
              <div className="space-y-3 pl-1">
                {/* Seed */}
                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground flex items-center justify-between">
                    <span>Seed</span>
                    <button
                      onClick={() => setSeed(-1)}
                      className="p-1 rounded hover:bg-[var(--surface-3)] transition-colors"
                      title="Random seed (-1)"
                    >
                      <DicesIcon className="w-4 h-4 text-muted-foreground" />
                    </button>
                  </Label>
                  <Input
                    type="number"
                    value={seed}
                    onChange={(e) => {
                      const n = e.target.valueAsNumber
                      const MAX_SEED = 2 ** 31 - 1
                      if (!Number.isFinite(n)) { setSeed(-1); return }
                      setSeed(n < 0 ? -1 : Math.min(Math.trunc(n), MAX_SEED))
                    }}
                    className={cn('h-9 bg-[var(--surface-2)] border-border text-sm font-mono')}
                  />
                </div>

                {/* Pass 1 */}
                <div className="space-y-1.5">
                  <button
                    type="button"
                    onClick={() => setShowPass1(!showPass1)}
                    className="w-full flex items-center justify-between px-3 py-1.5 rounded-md bg-[var(--surface-3)] border border-border/60 hover:border-orange-500/30 transition-all text-left"
                  >
                    <span className="text-xs font-medium text-muted-foreground">
                      {isDraft ? 'Draft — single pass' : 'Pass 1 — Low-res'}
                    </span>
                    <span className={cn('text-[10px] text-muted-foreground transition-transform', showPass1 && 'rotate-180')}>▼</span>
                  </button>

                  {showPass1 && (
                    <div className="space-y-3 pl-1">
                      {!isDraft && (
                        <div className="space-y-1">
                          <SettingSlider
                            label="Low-res resolution (MP)"
                            labelTitle="Draft pass size: smaller is faster. Video is brought to full resolution at the end regardless."
                            value={params.lowResMP}
                            onChange={(v) => patchParams({ lowResMP: Math.min(2, Math.max(0.2, Math.round(v * 100) / 100)) })}
                            min={0.2}
                            max={2}
                            step={0.05}
                            inputMin={0.1}
                            inputMax={2}
                            inputHint="0.1–2.0 MP — draft pass size"
                          />
                        </div>
                      )}

                      <div className="space-y-1">
                        <SettingSlider
                          label={isDraft ? 'Draft steps' : 'Sampler steps (Pass 1)'}
                          labelTitle={isDraft
                            ? 'How many steps the model performs. 4 is standard: fast and good; more is cleaner, but slower.'
                            : 'How many steps the draft pass performs. More is more accurate, but slower.'}
                          value={isDraft ? params.draftSteps : params.firstSamplerSteps}
                          onChange={(v) => {
                            const n = Math.round(v)
                            if (isDraft) patchParams({ draftSteps: n })
                            else patchParams({ firstSamplerSteps: n })
                          }}
                          min={2}
                          max={isDraft ? 16 : 30}
                          step={1}
                          inputMin={1}
                          inputMax={128}
                          inputHint={isDraft ? '2–30 steps for single pass (standard is 4)' : '1–128 steps. Above 30 takes noticeably longer'}
                        />
                      </div>

                      {!isDraft && (
                        <div className="space-y-1">
                          <SettingSlider
                            label="Total steps (pass 1)"
                            labelTitle="Length of BasicScheduler schedule from which SplitSigmas takes the top portion for draft pass. Default is equal to split ('6 of 6')."
                            value={cnTotal}
                            onChange={(v) => patchParams({ firstSamplerTotalSteps: Math.round(v) })}
                            min={2}
                            max={64}
                            step={1}
                            inputMin={2}
                            inputMax={128}
                            inputHint="2–128 schedule steps. Default is same as split (6/6)"
                          />
                          <p className="text-[10px] text-muted-foreground/70 leading-snug">
                            Pass 1: {cnSplit} of {cnTotal} · σ 1.0 → {cnSigmaEnd.toFixed(3)} ·
                            Pass 2: σ {cnPass2Start} → 0 ({cnPass2Steps} steps)
                          </p>
                        </div>
                      )}

                      <div className="space-y-1">
                        <Label
                          className="text-xs text-muted-foreground"
                          title="Sampling method for drawing frames. Influences detail and stability; if unsure, keep euler."
                        >
                          Sampler
                        </Label>
                        <Select
                          value={params.pass1Sampler}
                          onValueChange={(v) => patchParams({ pass1Sampler: v })}
                        >
                          <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
                            <SelectValue placeholder="Select" />
                          </SelectTrigger>
                          <SelectContent className="bg-[var(--surface-3)] border-border">
                            {SAMPLER_OPTIONS.map((o) => (
                              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                      <div className="space-y-1">
                        <Label
                          className="text-xs text-muted-foreground"
                          title="How model distributes work across steps. Usually best to keep simple."
                        >
                          Scheduler
                        </Label>
                        <Select
                          value={params.pass1Scheduler}
                          onValueChange={(v) => patchParams({ pass1Scheduler: v })}
                        >
                          <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
                            <SelectValue placeholder="Select" />
                          </SelectTrigger>
                          <SelectContent className="bg-[var(--surface-3)] border-border">
                            {SCHEDULER_OPTIONS.map((o) => (
                              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  )}
                </div>

                {/* Pass 2 (Full pipeline only) */}
                {!isDraft && (
                  <div className="space-y-1.5">
                    <button
                      type="button"
                      onClick={() => setShowPass2(!showPass2)}
                      className="w-full flex items-center justify-between px-3 py-1.5 rounded-md bg-[var(--surface-3)] border border-border/60 hover:border-orange-500/30 transition-all text-left"
                    >
                      <span className="text-xs font-medium text-muted-foreground">Pass 2 — High-res</span>
                      <span className={cn('text-[10px] text-muted-foreground transition-transform', showPass2 && 'rotate-180')}>▼</span>
                    </button>

                    {showPass2 && (
                      <div className="space-y-3 pl-1">
                        <div className="space-y-1">
                          <Label
                            className="text-xs text-muted-foreground"
                            title="Sampling steps for final refinement pass. More is clearer, but takes longer."
                          >
                            Sigma profile (steps)
                          </Label>
                          <Select
                            value={params.sigmaVariant}
                            onValueChange={(v) => patchParams({ sigmaVariant: v })}
                          >
                            <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
                              <SelectValue placeholder="Select" />
                            </SelectTrigger>
                            <SelectContent className="bg-[var(--surface-3)] border-border">
                              <SelectItem value="3step">3 steps (faster)</SelectItem>
                              <SelectItem value="4step">4 steps (balanced)</SelectItem>
                              <SelectItem value="5step">5 steps (high)</SelectItem>
                              <SelectItem value="6step">6 steps (very high)</SelectItem>
                              <SelectItem value="7step">7 steps (max)</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>

                        <div className="space-y-1">
                          <Label
                            className="text-xs text-muted-foreground"
                            title="Sampling method for drawing frames. Influences detail and stability; if unsure, keep euler."
                          >
                            Sampler
                          </Label>
                          <Select
                            value={params.pass2Sampler}
                            onValueChange={(v) => patchParams({ pass2Sampler: v })}
                          >
                            <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
                              <SelectValue placeholder="Select" />
                            </SelectTrigger>
                            <SelectContent className="bg-[var(--surface-3)] border-border">
                              {SAMPLER_OPTIONS.map((o) => (
                                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Output folder */}
          {gallery.folders.length > 0 && (
            <div className="space-y-1.5">
              <Label
                className="text-xs text-muted-foreground"
                title="Where to save results. Default is source video folder."
              >
                Output folder
              </Label>
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setFolderMenuOpen(!folderMenuOpen)}
                  disabled={busy}
                  className={cn(
                    'w-full h-9 inline-flex items-center gap-1.5 px-3 rounded-lg border text-xs transition-colors',
                    outputFolder
                      ? 'border-violet-500/40 bg-violet-500/10 text-violet-300'
                      : 'border-border bg-[var(--surface-2)] text-muted-foreground hover:text-foreground',
                    busy && 'opacity-50 pointer-events-none',
                  )}
                  title={outputFolder
                    ? `Output folder: ${outputFolder}`
                    : 'Output folder: general output folder'}
                >
                  <FolderIcon className="w-3.5 h-3.5" />
                  <span className="flex-1 text-left truncate">{outputFolder || 'General folder'}</span>
                  <ChevronDownIcon className={cn('w-3 h-3 transition-transform', folderMenuOpen && 'rotate-180')} />
                </button>
                {folderMenuOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setFolderMenuOpen(false)} />
                    <div className="absolute bottom-full mb-1.5 left-0 right-0 z-50 rounded-lg border border-border bg-[var(--surface-2)] shadow-xl p-1 max-h-64 overflow-y-auto">
                      <button
                        type="button"
                        onClick={() => { setOutputFolder(''); setFolderMenuOpen(false) }}
                        className={cn(
                          'w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-xs text-left transition-colors',
                          !outputFolder ? 'bg-violet-500/10 text-violet-300' : 'hover:bg-[var(--surface-3)] text-foreground/80',
                        )}
                      >
                        <FilmIcon className="w-3.5 h-3.5 shrink-0" />
                        <span className="flex-1 truncate">General folder</span>
                      </button>
                      {gallery.folders.map((f) => {
                        const depth = f.split('/').length - 1
                        const leaf = f.slice(f.lastIndexOf('/') + 1)
                        return (
                          <button
                            key={f}
                            type="button"
                            onClick={() => { setOutputFolder(f); setFolderMenuOpen(false) }}
                            title={depth > 0 ? f : undefined}
                            style={depth > 0 ? { paddingLeft: 10 + depth * 14 } : undefined}
                            className={cn(
                              'w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-xs text-left transition-colors',
                              outputFolder === f ? 'bg-violet-500/10 text-violet-300' : 'hover:bg-[var(--surface-3)] text-foreground/80',
                            )}
                          >
                            <FolderIcon className="w-3.5 h-3.5 shrink-0" />
                            <span className="flex-1 truncate">{leaf}</span>
                          </button>
                        )
                      })}
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          {/* Launch */}
          <div className="flex gap-2 pt-1">
            <Button onClick={startWithHistory} disabled={!source || modelsMissing || uploadingSrc} className="flex-1 gap-1.5">
              <PlayIcon className="w-4 h-4" />
              {busy ? 'Queue another' : params.preprocessOnly ? 'Save map' : 'Generate'}
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
            stageKind="passes"
          />
        </div>
      </aside>

      {/* ═══ Center Column: Prompt + Gallery ═══ */}
      <section className="flex-1 min-w-0 flex flex-col overflow-hidden bg-[var(--surface-1)]">
        <div className="p-5 pb-3 space-y-3 aurora-bg shrink-0">
          <div className="flex items-center justify-between shrink-0">
            <Label className="text-sm font-medium text-foreground flex items-center gap-2">
              <SparklesIcon className="w-4 h-4 text-orange-400" />
              Video description
            </Label>
            <span className="text-[10px] text-muted-foreground/70 hidden sm:block">
              <kbd className="px-1.5 py-0.5 rounded border border-border bg-[var(--surface-2)] font-mono text-[10px]">Ctrl</kbd>
              {' + '}
              <kbd className="px-1.5 py-0.5 rounded border border-border bg-[var(--surface-2)] font-mono text-[10px]">Enter</kbd>
              {' — generate'}
            </span>
          </div>

          <div className="relative">
            <MentionTextarea
              value={prompt}
              onChange={setPrompt}
              onKeyDown={handleKeyDown}
              placeholder="A character with <Picture 1> [what they are doing], [place, time of day], [lighting and mood]. The camera [movement/shot]. He/She says: <d>short line.</d> …"
              mentions={params.preprocessOnly ? undefined : refImages.map((r, i): MentionItem => ({
                id: r.id,
                label: `Picture ${i + 1}`,
                trigger: `<Picture ${i + 1}>`,
                kind: 'image',
                color: 'bg-purple-500/15 text-purple-400',
                previewUrl: r.previewUrl,
              }))}
              className="h-[220px] pr-12"
            />
            <PromptFieldTools>
              <PromptEditButton onOpen={() => setPromptEditorOpen(true)} />
              <PromptClearButton
                disabled={!prompt.trim()}
                onClear={() => setPrompt('')}
              />
              <PromptFixButton onFix={() => setFixOpen(true)} />
            </PromptFieldTools>
            <VoiceInputButton
              hotkey
              onText={(t) => {
                const cur = prompt
                setPrompt((cur ? cur.trimEnd() : '') ? `${cur.trimEnd()} ${t}` : t)
              }}
            />
            <PromptEditorDialog
              open={promptEditorOpen}
              onOpenChange={setPromptEditorOpen}
              initialText={prompt}
              onSave={setPrompt}
              onSaveAndRun={() => { void startWithHistory() }}
              placeholder="A character with <Picture 1> [what they are doing], [place, time of day], [lighting and mood]. …"
              mentions={params.preprocessOnly ? undefined : refImages.map((r, i): MentionItem => ({
                id: r.id,
                label: `Picture ${i + 1}`,
                trigger: `<Picture ${i + 1}>`,
                kind: 'image',
                color: 'bg-purple-500/15 text-purple-400',
                previewUrl: r.previewUrl,
              }))}
              improveOptions={{ mode: 'controlnet' }}
            />
            <PromptFixDialog
              open={fixOpen}
              onOpenChange={setFixOpen}
              hint="The prompt and your request will be sent to the ControlNet tab assistant chat — you can paste the response back with 'To Prompt'. Ctrl+Enter to send, Esc to cancel."
              onSubmit={(req) => requestImprovePrompt(prompt, { mode: 'controlnet', fixRequest: req })}
            />
          </div>

          <PromptQuality prompt={prompt} refsCount={refImages.length} />

          <div className="flex items-center gap-1.5">
            <button
              ref={historyBtnRef}
              type="button"
              onClick={() => {
                setHistoryOpen((o) => !o)
                setExamplesOpen(false)
              }}
              className={cn(
                'inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] border transition-colors',
                historyOpen
                  ? 'border-orange-500/40 text-orange-300 bg-orange-500/10'
                  : 'border-border text-muted-foreground hover:text-foreground',
              )}
            >
              <HistoryIcon className="w-3 h-3" />
              History
              {historyEntries.length > 0 && (
                <span className="ml-0.5 px-1 rounded-full bg-[var(--surface-3)] text-[10px] text-muted-foreground">
                  {historyEntries.length}
                </span>
              )}
            </button>
            <button
              ref={examplesBtnRef}
              type="button"
              onClick={() => {
                setExamplesOpen((o) => !o)
                setHistoryOpen(false)
              }}
              className={cn(
                'inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] border transition-colors',
                examplesOpen
                  ? 'border-orange-500/40 text-orange-300 bg-orange-500/10'
                  : 'border-border text-muted-foreground hover:text-foreground',
              )}
            >
              <SparklesIcon className="w-3 h-3" />
              Examples
            </button>
          </div>

          {(historyOpen || examplesOpen) && (
            <div
              className="fixed inset-0 z-[95]"
              onClick={() => {
                setHistoryOpen(false)
                setExamplesOpen(false)
              }}
            />
          )}
          {historyOpen &&
            historyBtnRef.current &&
            createPortal(
              <div
                className="fixed z-[100] w-[340px] max-h-80 overflow-y-auto rounded-lg border border-border bg-[var(--surface-3)] shadow-2xl shadow-black/60"
                style={dropdownPos(historyBtnRef.current)}
              >
                <div className="flex items-center justify-between px-2.5 py-1.5 border-b border-border sticky top-0 bg-[var(--surface-3)]">
                  <span className="text-[10px] font-semibold text-foreground">Prompt history</span>
                  {historyEntries.length > 0 && (
                    <button
                      type="button"
                      onClick={clearHistory}
                      className="text-[10px] text-muted-foreground hover:text-red-400"
                    >
                      clear all
                    </button>
                  )}
                </div>
                {historyEntries.length === 0 && (
                  <p className="px-2.5 py-3 text-xs text-muted-foreground">
                    Empty so far — generated prompts are saved here automatically.
                  </p>
                )}
                {historyEntries.map((e) => (
                  <div
                    key={e.id}
                    className="group flex items-start gap-2 px-2.5 py-1.5 hover:bg-white/5 cursor-pointer"
                    onClick={() => {
                      setPrompt(e.text)
                      setHistoryOpen(false)
                      toast.success('Prompt inserted from history')
                    }}
                  >
                    <button
                      type="button"
                      onClick={(ev) => {
                        ev.stopPropagation()
                        toggleHistoryFavorite(e.id)
                      }}
                      title={e.favorite ? 'Remove from favorites' : 'Add to favorites'}
                      className={cn(
                        'shrink-0 mt-0.5 w-4 h-4 flex items-center justify-center transition-colors',
                        e.favorite ? 'text-amber-400' : 'text-muted-foreground/40 hover:text-amber-400',
                      )}
                    >
                      <StarIcon className="w-3 h-3" fill={e.favorite ? 'currentColor' : 'none'} />
                    </button>
                    <p className="flex-1 min-w-0 text-xs text-foreground/90 leading-snug line-clamp-2 break-words">
                      {e.text}
                    </p>
                    <button
                      type="button"
                      onClick={(ev) => {
                        ev.stopPropagation()
                        removeHistoryEntry(e.id)
                      }}
                      className="shrink-0 mt-0.5 w-4 h-4 flex items-center justify-center text-muted-foreground/40 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
                      title="Delete from history"
                    >
                      <XIcon className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>,
              document.body
            )}
          {examplesOpen &&
            examplesBtnRef.current &&
            createPortal(
              <div
                className="fixed z-[100] w-[340px] max-h-80 overflow-y-auto rounded-lg border border-border bg-[var(--surface-3)] shadow-2xl shadow-black/60"
                style={dropdownPos(examplesBtnRef.current)}
              >
                <div className="px-2.5 py-1.5 border-b border-border sticky top-0 bg-[var(--surface-3)]">
                  <span className="text-[10px] font-semibold text-foreground">Ready-made examples</span>
                </div>
                {EXAMPLES.map((ex) => (
                  <div
                    key={ex.title}
                    className="px-2.5 py-1.5 hover:bg-white/5 cursor-pointer"
                    onClick={() => applyExample(ex.text)}
                  >
                    <p className="text-xs font-medium text-foreground">{ex.title}</p>
                    <p className="text-[10px] text-muted-foreground/80 line-clamp-2 leading-snug break-words">
                      {ex.text}
                    </p>
                  </div>
                ))}
                <p className="px-2.5 py-2 text-[10px] text-muted-foreground/60 border-t border-border">
                  Replaces current prompt (can be undone). Prompts are in English: model understands it best.
                </p>
              </div>,
              document.body
            )}
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-3">
          <VideoGalleryGrid
            files={gallery.files}
            loading={gallery.loading}
            onRefresh={() => void gallery.load()}
            onDeleteFile={gallery.deleteFile}
            emptyHint="ControlNet results will appear here"
          />
        </div>
      </section>

      {/* Assistant panel */}
      <AssistantPanel mode="controlnet" />
    </div>
  )
}
