'use client'

/**
 * ExtendView — standalone "Video Extension" tab.
 *
 * Two-column layout (similar to GenerateView):
 *   LEFT panel (400px): parameters — source video, references, advanced settings,
 *   generation status (pinned to bottom).
 *   RIGHT panel (flex-1): horizontal ribbon of extension clips (each with its
 *   own prompt and duration, added from left to right) + badges +
 *   gallery + "Generate" button.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import {
  Maximize2Icon,
  PlayIcon,
  PlusIcon,
  SparklesIcon,
  XIcon,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { useGenStore, type VideoRefItem } from '@/lib/gen-store'
import { useVideoGen } from '@/hooks/use-video-gen'
import { useGenProgress } from '@/lib/gen-progress-store'
import { uploadInputFile } from '@/lib/upload'
import { SeedBlock } from './video-shared'
import { GenerationStatus } from './generation-status'
import { VideoGalleryGrid, H3_VIDEO_DND_MIME } from './video-gallery-grid'
import { MentionTextarea, type MentionItem } from './mention-textarea'
import { useVideoGallery } from './use-video-gallery'
import { isStreamActive } from '@/lib/assistant-stream'
import { useExtendTarget } from '@/lib/extend-target-store'
import { requestImprovePrompt } from '@/hooks/use-improve-prompt'
import { AssistantPanel } from './assistant/assistant-panel'
import { PromptEditorDialog, PromptFixDialog, PromptFixButton, PromptClearButton, PromptFieldTools } from './prompt-editor-dialog'
import { RefPreviewThumb } from './ref-preview-thumb'

function detectKind(name: string): VideoRefItem['kind'] | null {
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase()
  if (['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff'].includes(ext)) return 'image'
  if (['.avi', '.m4v', '.mkv', '.mov', '.mp4', '.webm'].includes(ext)) return 'video'
  if (['.aac', '.flac', '.m4a', '.mp3', '.ogg', '.wav'].includes(ext)) return 'audio'
  return null
}

let _id = 0
function newId(): string {
  return `extref_${Date.now()}_${++_id}`
}

export function ExtendView() {
  const { phase, error, progressValue, progressMax, statusMessage, promptId, generate, interrupt, reset } = useVideoGen()
  const videoStartedAt = useGenProgress((s) => s.video.startedAt)

  const video = useGenStore((s) => s.video)
  const patchVideo = useGenStore((s) => s.patchVideo)

  const isGenerating = phase === 'submitting' || phase === 'queued' || phase === 'running'
  const [assistantBusy, setAssistantBusy] = useState(false)
  const firstBusyAtRef = useRef<number | null>(null)
  const lockReleasedRef = useRef(false)
  useEffect(() => {
    let stopped = false
    const tick = async () => {
      if (stopped) return
      if (isStreamActive()) {
        setAssistantBusy(true)
        firstBusyAtRef.current = Date.now()
        return
      }
      if (sessionStorage.getItem('assistantUsed') !== '1') {
        setAssistantBusy(false)
        return
      }
      try {
        const r = await fetch('/api/llm/status', { signal: AbortSignal.timeout(4000) })
        const s = (await r.json()) as { assistantBusy?: boolean }
        if (stopped) return
        const busy = s.assistantBusy === true && !isStreamActive()
        setAssistantBusy(busy)
        if (busy) {
          if (firstBusyAtRef.current === null) firstBusyAtRef.current = Date.now()
          const stuckMs = Date.now() - firstBusyAtRef.current
          if (!lockReleasedRef.current && stuckMs > 60_000 && !isStreamActive()) {
            void fetch('/api/llm/release', { method: 'POST' }).catch(() => {})
            setTimeout(() => {
              if (!isStreamActive()) {
                void fetch('/api/llm/release?force=1', { method: 'POST' }).catch(() => {})
              }
            }, 2000)
            lockReleasedRef.current = true
            firstBusyAtRef.current = null
            setAssistantBusy(false)
            toast.warning('Assistant', { description: 'Lock released forcibly (persisted after response).' })
          }
        } else {
          firstBusyAtRef.current = null
          lockReleasedRef.current = false
        }
      } catch {
        /* backend not up */
      }
    }
    void tick()
    const id = setInterval(tick, 5000)
    return () => {
      stopped = true
      clearInterval(id)
    }
  }, [])
  const canGenerateNow = !assistantBusy

  /* ──────────── UI state ──────────── */
  const [uploadingRefs, setUploadingRefs] = useState(false)
  const [refsDragOver, setRefsDragOver] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [showPass1, setShowPass1] = useState(false)
  const [showPass2, setShowPass2] = useState(false)
  const [editingClip, setEditingClip] = useState<number | null>(null)
  const [fixClip, setFixClip] = useState<number | null>(null)
  const extendImageInputRef = useRef<HTMLInputElement>(null)
  const videoInputRef = useRef<HTMLInputElement>(null)
  const clipsStripRef = useRef<HTMLDivElement>(null)
  const [sourceVideo, setSourceVideo] = useState<{ name: string; previewUrl: string } | null>(null)
  const sourceVideoPath = video.extendSourceVideoPath
  const [videoDragOver, setVideoDragOver] = useState(false)

  const [autoClipSteps, setAutoClipSteps] = useState<number | null>(null)
  useEffect(() => {
    const name = video.extendSourceName
    if (!name) { setAutoClipSteps(null); return }
    const sub = video.extendSourceSubfolder ? video.extendSourceSubfolder + '/' : ''
    let cancelled = false
    fetch(`/api/comfy/meta?path=${encodeURIComponent(sub + name)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: Record<string, unknown> | null) => {
        if (cancelled || !d) return
        const p = (d.params && typeof d.params === 'object' ? d.params : d) as Record<string, unknown>
        const steps = typeof p.pass1_steps === 'number' ? p.pass1_steps
          : typeof p.draft_steps === 'number' ? p.draft_steps
          : null
        setAutoClipSteps(steps && steps >= 2 ? steps : null)
      })
      .catch(() => { if (!cancelled) setAutoClipSteps(null) })
    return () => { cancelled = true }
  }, [video.extendSourceName, video.extendSourceSubfolder])
  const effectiveClipSteps = video.extendClipSteps ?? autoClipSteps ?? video.firstSamplerSteps ?? 6

  const extendRefs = video.extendImageRefs
  const progressPercent = progressMax > 0 ? Math.round((progressValue / progressMax) * 100) : 0

  useEffect(() => {
    if (!sourceVideoPath) {
      setSourceVideo((prev) => {
        if (prev?.previewUrl.startsWith('blob:')) {
          try { URL.revokeObjectURL(prev.previewUrl) } catch { /* already revoked */ }
        }
        return null
      })
      return
    }
    setSourceVideo((prev) => {
      if (prev && prev.name === sourceVideoPath) return prev
      if (prev?.previewUrl.startsWith('blob:')) {
        try { URL.revokeObjectURL(prev.previewUrl) } catch { /* already revoked */ }
      }
      return {
        name: sourceVideoPath,
        previewUrl: `/api/comfy/file?filename=${encodeURIComponent(sourceVideoPath)}&type=input`,
      }
    })
  }, [sourceVideoPath])

  const clipsCount = video.extendClips.length
  useEffect(() => {
    const el = clipsStripRef.current
    if (el) el.scrollTo({ left: el.scrollWidth, behavior: 'smooth' })
  }, [clipsCount])

  const clipMentions: MentionItem[] = useMemo(() => {
    return extendRefs.map((ref, i) => ({
      id: ref.id,
      label: ref.name,
      trigger: `<Picture ${i + 1}>`,
      kind: 'image',
      color: 'bg-purple-500/15 text-purple-400',
      previewUrl:
        ref.previewUrl ||
        (ref.path
          ? `/api/comfy/file?filename=${encodeURIComponent(ref.path)}&type=input`
          : undefined),
    }))
  }, [extendRefs])

  /* ──────────── Upload handlers ──────────── */
  const addExtendImageFiles = useCallback(async (files: File[]) => {
    const images = files.filter((f) => detectKind(f.name) === 'image')
    const rejected = files.length - images.length
    if (rejected > 0) toast.error(`Images only — ${rejected} file(s) rejected`)
    if (!images.length) return
    const current = useGenStore.getState().video.extendImageRefs.length
    const available = Math.max(0, 9 - current)
    if (available === 0) {
      toast.error('Maximum of 9 reference images for extension')
      return
    }
    setUploadingRefs(true)
    try {
      const items: VideoRefItem[] = []
      for (const file of images.slice(0, available)) {
        const { path } = await uploadInputFile(file)
        items.push({
          id: newId(),
          kind: 'image',
          path,
          name: file.name,
          previewUrl: URL.createObjectURL(file),
          role: '',
          imageIntent: 'identity',
          includeAudio: false,
        })
      }
      const prev = useGenStore.getState().video.extendImageRefs
      patchVideo({ extendImageRefs: [...prev, ...items] })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Upload error')
    } finally {
      setUploadingRefs(false)
    }
  }, [patchVideo])

  const [uploadingVideo, setUploadingVideo] = useState(false)

  const handleVideoSelect = useCallback(async (file: File) => {
    if (detectKind(file.name) !== 'video') {
      toast.error('Select a video file (mp4, webm, mov, ...)')
      return
    }
    const blobUrl = URL.createObjectURL(file)
    setSourceVideo((prev) => {
      if (prev?.previewUrl.startsWith('blob:')) {
        try { URL.revokeObjectURL(prev.previewUrl) } catch { /* already revoked */ }
      }
      return { name: file.name, previewUrl: blobUrl }
    })
    setUploadingVideo(true)
    try {
      const form = new FormData()
      form.append('image', file)
      const res = await fetch('/api/comfy/upload', { method: 'POST', body: form })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`Upload failed (${res.status}): ${text.slice(0, 200)}`)
      }
      const data = await res.json() as { name?: string; durationSec?: number; staged?: boolean }
      if (!data.name) throw new Error('Upload: no name in response')
      const duration = typeof data.durationSec === 'number' && data.durationSec > 0 ? data.durationSec : 0
      patchVideo({ extendSourceVideoPath: data.name, extendSourceDuration: duration, extendSourceSubfolder: null, extendSourceName: null })
      if (duration > 0) {
        toast.success(`Source: ${file.name} (${duration.toFixed(1)} s)`)
      } else {
        toast.success(`Source: ${file.name}`)
      }
      try { URL.revokeObjectURL(blobUrl) } catch { /* already revoked */ }
      setSourceVideo({ name: data.name, previewUrl: `/api/comfy/file?filename=${encodeURIComponent(data.name)}&type=input` })
    } catch (e) {
      try { URL.revokeObjectURL(blobUrl) } catch { /* already revoked */ }
      setSourceVideo(null)
      toast.error(e instanceof Error ? e.message : 'Error uploading video')
    } finally {
      setUploadingVideo(false)
    }
  }, [patchVideo])

  const importGalleryVideo = useCallback(async (filename: string, subfolder: string) => {
    if (!filename) {
      toast.error('Failed to read dragged video')
      return
    }
    setSourceVideo({ name: filename, previewUrl: `/api/comfy/file?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder || '')}` })
    setUploadingVideo(true)
    try {
      const r = await fetch('/api/extend/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, subfolder: subfolder || '' }),
      })
      const d = (await r.json().catch(() => ({}))) as { ok?: boolean; name?: string; path?: string; error?: string; durationSec?: number }
      if (!r.ok || !d.ok || !d.name) {
        throw new Error(d.error ?? `import → ${r.status}`)
      }
      const dur = typeof d.durationSec === 'number' && d.durationSec > 0 ? d.durationSec : 0
      patchVideo({
        extendSourceVideoPath: d.name,
        extendSourceDuration: dur,
        extendSourceSubfolder: subfolder || '',
        extendSourceName: filename,
      })
      try {
        const metaPath = subfolder ? `${subfolder}/${filename}` : filename
        const mr = await fetch(`/api/comfy/meta?path=${encodeURIComponent(metaPath)}`)
        if (mr.ok) {
          const meta = (await mr.json()) as {
            references?: Array<{ type?: string; path?: string; role?: string }>
            minimax_h3_references?: Array<{ type?: string; path?: string; role?: string }>
            generation_mode?: string
            first_frame?: string | null
          }
          const list = Array.isArray(meta.references) ? meta.references
            : Array.isArray(meta.minimax_h3_references) ? meta.minimax_h3_references
            : []
          const imgRefs = list.filter((r) => r?.type === 'image' && typeof r?.path === 'string' && r.path.length > 0)
          const firstFrame =
            meta.generation_mode === 'flf' && typeof meta.first_frame === 'string' && meta.first_frame
              ? meta.first_frame
              : null
          if (firstFrame && !imgRefs.some((r) => r.path === firstFrame)) {
            imgRefs.unshift({ type: 'image', path: firstFrame, role: 'first frame of original' })
          }
          if (imgRefs.length > 0) {
            const prev = useGenStore.getState().video.extendImageRefs
            const known = new Set(prev.map((r) => r.path))
            const inherited: VideoRefItem[] = []
            for (const r of imgRefs) {
              if (prev.length + inherited.length >= 9) break
              const p = r.path as string
              if (known.has(p)) continue
              known.add(p)
              inherited.push({
                id: newId(),
                kind: 'image',
                path: p,
                name: p.split(/[\\/]/).pop() ?? p,
                previewUrl: `/api/comfy/file?filename=${encodeURIComponent(p)}&type=input`,
                role: typeof r.role === 'string' ? r.role : '',
                imageIntent: 'identity',
                includeAudio: false,
              })
            }
            if (inherited.length > 0) {
              patchVideo({ extendImageRefs: [...prev, ...inherited] })
              toast.success(`Original references: +${inherited.length} from metadata`)
            }
          }
        }
      } catch { /* ignored */ }
      toast.success(dur > 0 ? `Source video: ${filename} (${dur.toFixed(1)} s)` : `Source video: ${filename}`)
    } catch (e) {
      setSourceVideo(null)
      patchVideo({ extendSourceVideoPath: '', extendSourceDuration: 0, extendSourceSubfolder: null, extendSourceName: null })
      toast.error(e instanceof Error ? e.message : 'Error importing video from gallery')
    } finally {
      setUploadingVideo(false)
    }
  }, [patchVideo])

  const galleryTarget = useExtendTarget((s) => s.target)
  const clearGalleryTarget = useExtendTarget((s) => s.clear)
  useEffect(() => {
    if (!galleryTarget) return
    clearGalleryTarget()
    void importGalleryVideo(galleryTarget.filename, galleryTarget.subfolder)
  }, [galleryTarget, clearGalleryTarget, importGalleryVideo])

  /* ──────────── Generate ──────────── */
  const submitInFlightRef = useRef(false)

  const handleGenerate = useCallback(async () => {
    if (assistantBusy) {
      toast.error('Assistant is responding — wait for response or cancel it')
      return
    }
    const v = useGenStore.getState().video
    if (!v.extendSourceVideoPath) {
      toast.error('Upload a source video — extension requires it (source clip is concatenated with new clips)')
      return
    }
    if (v.extendClips.length === 0) {
      toast.error('Add at least one clip')
      return
    }
    if (v.extendClips.every((c) => !c.prompt.trim())) {
      toast.error('Fill in the prompt of at least one clip')
      return
    }
    if (uploadingVideo) {
      toast.error('Video is still uploading — please wait')
      return
    }

    const CAMERA_LOCK =
      'You are continuing the reference video <Video 1>: keep the exact same scene, location, environment, lighting and time of day as shown in <Video 1>; the same characters with the same appearance and clothing. Continue exactly the same camera angle, framing and camera movement as the reference video; keep the same subject position and shot. Do not change the location, do not introduce a new setting or new characters, do not cut to a new shot.'
    const hasSourceVideo = !!v.extendSourceVideoPath
    const clips = v.extendClips.map((c) => {
      let prompt = c.prompt.trim()
      if (hasSourceVideo && prompt) {
        if (!/<Video 1>/i.test(prompt)) {
          prompt = `<Video 1> ${prompt}`
        }
        if (!/camera angle|same scene|same location/i.test(prompt)) {
          prompt = `${prompt} ${CAMERA_LOCK}`
        }
      }
      return { prompt, duration: Math.max(3, c.duration), seed: c.seed }
    })

    const MEANINGFUL_WORD = /[a-zA-Z]{2,}/
    const labelPrompt = v.extendClips.find((c) => MEANINGFUL_WORD.test(c.prompt))?.prompt.trim() ?? ''
    if (submitInFlightRef.current) return
    submitInFlightRef.current = true
    useGenProgress.getState().setVideoFrozenStageKind(v.extendTwoPass ? 'clips2' : 'clips')
    try {
      await generate({
        modelType: v.modelType,
        mode: 'extend',
        prompt: labelPrompt,
        seed: v.seed,
        resolution: v.resolution,
        videoLength: v.videoLength,
        extendClips: clips,
        extendRefs: v.extendImageRefs.map((r) => r.path),
        extendSourceVideo: v.extendSourceVideoPath || undefined,
        extendSourceName: v.extendSourceName ?? undefined,
        extendSourceSubfolder: v.extendSourceSubfolder ?? undefined,
        extendTwoPass: v.extendTwoPass,
        referenceDetail: v.referenceDetail || 'match',
        lowResMP: v.lowResMP ?? 0.2,
        firstSamplerSteps: v.firstSamplerSteps ?? 6,
        extendClipSteps: v.extendClipSteps ?? autoClipSteps ?? undefined,
        sigmaVariant: v.sigmaVariant || '3step',
        pass2Sampler: v.pass2Sampler || 'euler',
        pass1Sampler: v.pass1Sampler || 'euler',
        pass1Scheduler: v.pass1Scheduler || 'simple',
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
        outputSubfolder: v.extendSourceSubfolder ?? (v.outputFolder || ''),
      })
    } finally {
      submitInFlightRef.current = false
    }
  }, [generate, assistantBusy, uploadingVideo, autoClipSteps])

  /* ──────────── Gallery ──────────── */
  const { files: galleryFiles, loading: galleryLoading, load: loadGallery, deleteFile } = useVideoGallery({ phase })

  /* ──────────── Badges ──────────── */
  const clipsSum = video.extendClips.reduce((s, c) => s + c.duration, 0)
  const sourceDur = typeof video.extendSourceDuration === 'number' && video.extendSourceDuration > 0
    ? video.extendSourceDuration
    : 0
  const totalDuration = sourceDur + clipsSum
  const badges = (
    <>
      <Badge variant="secondary" className="text-[10px]">Same as source</Badge>
      <Badge variant="secondary" className="text-[10px]">
        {totalDuration.toFixed(1)} s{sourceDur > 0 ? ' (src ' + sourceDur.toFixed(0) + ' + ' + clipsSum + ')' : ''}
      </Badge>
      <Badge variant="secondary" className="text-[10px]">{video.extendClips.length} clip(s)</Badge>
      {extendRefs.length > 0 && (
        <Badge variant="secondary" className="text-[10px]">{extendRefs.length} ref(s)</Badge>
      )}
      {video.extendTwoPass ? (
        <Badge className="text-[10px] bg-cyan-500/15 text-cyan-400 border-cyan-500/30 hover:bg-cyan-500/15">
          Full (2 passes)
        </Badge>
      ) : (
        <Badge className="text-[10px] bg-emerald-500/15 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/15">
          Draft (1 pass) ✓
        </Badge>
      )}
    </>
  )

  /* ──────────── Render ──────────── */
  return (
    <div className="flex-1 flex min-h-0 min-w-0">
      {/* ═══════════ LEFT: Settings panel (400px) ═══════════ */}
      <div className="w-[400px] shrink-0 border-r border-border flex flex-col bg-[var(--surface-1)]">
        <div className="flex-1 overflow-y-auto p-4 space-y-4">

          {/* Header */}
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">Extension Parameters</h2>
            <Badge className="text-[10px] bg-cyan-500/15 text-cyan-400 border-cyan-500/30 hover:bg-cyan-500/15">
              MiniMax H3
            </Badge>
          </div>

          <Separator className="bg-border opacity-50" />

          {/* Source video (required) */}
          <div className="space-y-2">
            <Label
              className="text-xs text-amber-400"
              title="Video will continue with same angle, scene, and camera motion. Finished clips are automatically joined with source into a single video."
            >
              Source video <span className="text-amber-400/70">(required)</span>
            </Label>
            <div
              onDragOver={(e) => { e.preventDefault(); setVideoDragOver(true); setRefsDragOver(true) }}
              onDragLeave={() => { setVideoDragOver(false); setRefsDragOver(false) }}
              onDrop={(e) => {
                e.preventDefault()
                setVideoDragOver(false)
                setRefsDragOver(false)
                const raw = e.dataTransfer.getData(H3_VIDEO_DND_MIME)
                if (raw) {
                  try {
                    const parsed = JSON.parse(raw) as { filename?: string; subfolder?: string }
                    void importGalleryVideo(parsed.filename ?? '', parsed.subfolder ?? '')
                  } catch {
                    toast.error('Failed to read dragged video')
                  }
                  return
                }
                const f = Array.from(e.dataTransfer.files).find((x) => detectKind(x.name) === 'video')
                if (f) void handleVideoSelect(f)
                else toast.error('A video file is required')
              }}
              onClick={() => videoInputRef.current?.click()}
              className={cn(
                'border-2 border-dashed rounded-lg p-3 text-center cursor-pointer transition-all',
                (videoDragOver || refsDragOver) ? 'border-cyan-400 bg-cyan-500/10' : 'border-border hover:border-cyan-500/50 hover:bg-[var(--surface-2)]',
              )}
            >
              {sourceVideo ? (
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <RefPreviewThumb
                      kind="video"
                      name={sourceVideo.name}
                      url={sourceVideo.previewUrl}
                      className="h-16 w-28 rounded-md object-cover bg-black shrink-0"
                      title="Open source video in full screen"
                      stopPropagation
                    >
                      <video
                        src={sourceVideo.previewUrl}
                        preload="metadata"
                        muted
                        playsInline
                        onClick={(e) => e.stopPropagation()}
                        className="w-full h-full object-cover"
                      />
                    </RefPreviewThumb>
                    <div className="min-w-0 flex-1">
                      <p className="text-xs truncate" title={sourceVideo.name}>{sourceVideo.name}</p>
                      <div className="flex items-center gap-1.5">
                        {typeof video.extendSourceDuration === 'number' && video.extendSourceDuration > 0 && (
                          <span className="text-[10px] text-cyan-400/80 shrink-0" title="Source video duration">
                            {video.extendSourceDuration.toFixed(1)} s
                          </span>
                        )}
                        {uploadingVideo && <span className="text-[10px] text-cyan-400 shrink-0">uploading…</span>}
                        {sourceVideoPath && !uploadingVideo && <span className="text-[10px] text-green-400 shrink-0">✓</span>}
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      setSourceVideo((prev) => {
                        if (prev?.previewUrl.startsWith('blob:')) {
                          try { URL.revokeObjectURL(prev.previewUrl) } catch { /* already revoked */ }
                        }
                        return null
                      })
                      patchVideo({ extendSourceVideoPath: '', extendSourceSubfolder: null })
                    }}
                    className="text-[10px] text-muted-foreground hover:text-red-400 shrink-0"
                  >
                    Remove
                  </button>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">Add video for extension — drag a card from gallery or drop a file from disk</p>
              )}
            </div>
            <input
              ref={videoInputRef}
              type="file"
              accept="video/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void handleVideoSelect(f)
                e.target.value = ''
              }}
            />
            {sourceVideoPath && (
              <p className="text-[10px] text-muted-foreground/60">
                Output folder: {video.extendSourceSubfolder !== null
                  ? `${video.extendSourceSubfolder || 'General'} (matching source)`
                  : (video.outputFolder || 'General')}
              </p>
            )}
          </div>

          <Separator className="bg-border opacity-50" />

          {/* Image references */}
          <div className="space-y-2">
            <Label
              className="text-xs text-muted-foreground"
              title="Up to 9 images — help maintain character and scene consistency across all extension clips."
            >
              Image references
              <span className="text-[10px] font-normal text-muted-foreground/60 ml-2">
                {extendRefs.length}/9 img
              </span>
            </Label>
            <div
              onDragOver={(e) => { e.preventDefault(); setRefsDragOver(true) }}
              onDragLeave={() => setRefsDragOver(false)}
              onDrop={(e) => {
                e.preventDefault()
                setRefsDragOver(false)
                const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'))
                if (files.length) void addExtendImageFiles(files)
              }}
              onClick={() => extendImageInputRef.current?.click()}
              className={cn(
                'border-2 border-dashed rounded-lg py-3 text-center cursor-pointer transition-all',
                refsDragOver ? 'border-cyan-400 bg-cyan-500/10' : 'border-border hover:border-cyan-500/50 hover:bg-[var(--surface-2)]',
              )}
            >
              {uploadingRefs ? (
                <p className="text-xs text-cyan-400">Uploading…</p>
              ) : (
                <p className="text-xs text-muted-foreground">Add image references</p>
              )}
            </div>
            <input
              ref={extendImageInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                const files = Array.from(e.target.files || [])
                if (files.length) void addExtendImageFiles(files)
                e.target.value = ''
              }}
            />
            {extendRefs.length > 0 && (
              <div className="grid grid-cols-3 gap-2">
                {extendRefs.map((ref) => (
                  <div key={ref.id} className="relative group">
                    <RefPreviewThumb
                      kind="image"
                      name={ref.name}
                      path={ref.path ?? ''}
                      url={ref.previewUrl || undefined}
                      className="w-full block"
                      title="Open reference in full screen"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={ref.previewUrl || (ref.path ? `/api/comfy/file?filename=${encodeURIComponent(ref.path)}&type=input&width=200` : undefined)}
                        alt={ref.name}
                        className="w-full h-16 object-cover rounded-md border border-border cursor-zoom-in"
                        onError={(e) => {
                          if (!ref.previewUrl) {
                            (e.target as HTMLImageElement).src = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2224%22 height=%2224%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%2394a3b8%22 stroke-width=%222%22%3E%3Crect x=%223%22 y=%223%22 width=%2218%22 height=%2218%22 rx=%222%22/%3E%3Ccircle cx=%228.5%22 cy=%228.5%22 r=%221.5%22/%3E%3Cpath d=%22m21 15-5-5L5 21%22/%3E%3C/svg%3E'
                          }
                        }}
                      />
                    </RefPreviewThumb>
                    <button
                      type="button"
                      onClick={() => {
                        const refs = useGenStore.getState().video.extendImageRefs
                        const removed = refs.find((r) => r.id === ref.id)
                        if (removed?.previewUrl?.startsWith('blob:')) {
                          try { URL.revokeObjectURL(removed.previewUrl) } catch { /* already revoked */ }
                        }
                        patchVideo({ extendImageRefs: refs.filter((r) => r.id !== ref.id) })
                      }}
                      className="absolute top-1 right-1 p-0.5 rounded bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <XIcon className="w-3 h-3 text-white" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Reference size mode */}
          <div className="space-y-1">
            <Label
              className="text-xs text-muted-foreground"
              title="How to process uploaded images. Match — faster; Max — preserves reference details more accurately, but slower."
            >
              Refs: size mode
            </Label>
            <div className="grid grid-cols-2 gap-1.5">
              <button
                type="button"
                onClick={() => patchVideo({ referenceDetail: 'match' })}
                className={cn(
                  'px-2 py-1.5 rounded-md border text-xs transition-colors',
                  (video.referenceDetail || 'match') === 'match'
                    ? 'border-cyan-500/40 text-cyan-300 bg-cyan-500/10'
                    : 'border-border text-muted-foreground hover:text-foreground',
                )}
              >
                Match (fast)
              </button>
              <button
                type="button"
                onClick={() => patchVideo({ referenceDetail: 'max' })}
                className={cn(
                  'px-2 py-1.5 rounded-md border text-xs transition-colors',
                  video.referenceDetail === 'max'
                    ? 'border-cyan-500/40 text-cyan-300 bg-cyan-500/10'
                    : 'border-border text-muted-foreground hover:text-foreground',
                )}
              >
                Max (quality)
              </button>
            </div>
          </div>

          <Separator className="bg-border opacity-50" />

          {/* Pass quality */}
          <div className="space-y-1.5">
            <Label
              className="text-xs text-muted-foreground"
              title={
                video.extendTwoPass
                  ? 'First a fast draft of each clip, then refinement to clear output. Takes longer, but more detailed.'
                  : 'Single pass at source resolution — faster. Can be brought to full quality later in Refine tab.'
              }
            >
              Pass quality
            </Label>
            <div className="grid grid-cols-2 gap-1.5">
              {([
                [false, 'Draft', 'Single fast pass — draft quality; can be refined later in Refine tab'],
                [true, 'Full', 'Two passes: fast draft, then detail refinement to source quality'],
              ] as const).map(([tp, label, hint]) => (
                <button
                  key={label}
                  type="button"
                  title={hint}
                  onClick={() => patchVideo({ extendTwoPass: tp })}
                  className={cn(
                    'h-8 rounded-md border text-xs font-medium transition-all',
                    (video.extendTwoPass === true) === tp
                      ? 'bg-emerald-500/15 border-emerald-500/50 text-emerald-300'
                      : 'bg-[var(--surface-2)] border-border text-muted-foreground hover:border-emerald-500/30',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <Separator className="bg-border opacity-50" />

          {/* Collapsible: Advanced parameters */}
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
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                className="space-y-3 pl-1 overflow-hidden"
              >
                <SeedBlock />

                {/* Pass 1 */}
                <div className="space-y-1.5">
                  <button
                    type="button"
                    onClick={() => setShowPass1(!showPass1)}
                    className="w-full flex items-center justify-between px-3 py-1.5 rounded-md bg-[var(--surface-3)] border border-border/60 hover:border-cyan-500/30 transition-all text-left"
                  >
                    <span className="text-xs font-medium text-muted-foreground">
                      {video.extendTwoPass ? 'Pass 1 (low-res)' : 'Extension pass (single)'}
                    </span>
                    <span className={cn('text-[10px] text-muted-foreground transition-transform', showPass1 && 'rotate-180')}>▼</span>
                  </button>

                  {showPass1 && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      className="space-y-3 pl-1 overflow-hidden"
                    >
                      <div className="space-y-1">
                        <Label
                          className="text-xs text-muted-foreground"
                          title="Sampling steps for drawing the clip. More is more accurate, but slower. Default is auto: source pass 1 steps (from metadata); manual input overrides auto."
                        >
                          Sampler steps
                          {video.extendClipSteps == null && (
                            <span className="ml-1.5 text-[10px] text-cyan-400/80">auto</span>
                          )}
                        </Label>
                        <div className="flex items-center gap-2">
                          <input
                            type="number"
                            min={2}
                            max={30}
                            value={effectiveClipSteps}
                            onChange={(e) => patchVideo({ extendClipSteps: Math.max(2, Math.min(30, parseInt(e.target.value, 10) || 2)) })}
                            className="w-20 text-xs bg-[var(--surface-3)] border border-border rounded-md px-2 py-1.5 text-foreground"
                          />
                          {video.extendClipSteps != null ? (
                            <button
                              type="button"
                              onClick={() => patchVideo({ extendClipSteps: undefined })}
                              className="shrink-0 rounded-md border border-cyan-500/40 px-1.5 py-0.5 text-[10px] text-cyan-300 transition-colors hover:bg-cyan-500/10"
                              title={`Restore 'auto': source steps${autoClipSteps != null ? ` (${autoClipSteps})` : ' → same as generation'}`}
                            >
                              auto
                            </button>
                          ) : (
                            <span className="text-[10px] text-muted-foreground">
                              {autoClipSteps != null
                                ? `from source · ${autoClipSteps}`
                                : `same as generation · ${video.firstSamplerSteps ?? 6}`}
                            </span>
                          )}
                          <span className="text-[10px] text-muted-foreground/70">2–30</span>
                        </div>
                      </div>

                      <div className="space-y-1">
                        <Label
                          className="text-xs text-muted-foreground"
                          title="Sampling method for drawing frames. Influences detail and stability; if unsure, keep euler."
                        >
                          Sampler (pass 1)
                        </Label>
                        <Select value={video.pass1Sampler || 'euler'} onValueChange={(v) => patchVideo({ pass1Sampler: v })}>
                          <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent className="bg-[var(--surface-3)] border-border">
                            {['euler', 'er_sde', 'dpmpp_2m', 'dpmpp_3m_sde', 'heun', 'lcm', 'res_multistep'].map((s) => (
                              <SelectItem key={s} value={s}>{s}</SelectItem>
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
                        <Select value={video.pass1Scheduler || 'simple'} onValueChange={(v) => patchVideo({ pass1Scheduler: v })}>
                          <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent className="bg-[var(--surface-3)] border-border">
                            {['simple', 'ddim_uniform', 'karras', 'exponential'].map((s) => (
                              <SelectItem key={s} value={s}>{s}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </motion.div>
                  )}
                </div>

                {/* Pass 2 (only in Full two-pass mode) */}
                {video.extendTwoPass && (
                  <div className="space-y-1.5">
                    <button
                      type="button"
                      onClick={() => setShowPass2(!showPass2)}
                      className="w-full flex items-center justify-between px-3 py-1.5 rounded-md bg-[var(--surface-3)] border border-border/60 hover:border-cyan-500/30 transition-all text-left"
                    >
                      <span className="text-xs font-medium text-muted-foreground">Pass 2 — refinement</span>
                      <span className={cn('text-[10px] text-muted-foreground transition-transform', showPass2 && 'rotate-180')}>▼</span>
                    </button>

                    {showPass2 && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        className="space-y-3 pl-1 overflow-hidden"
                      >
                        <div className="space-y-1">
                          <Label
                            className="text-xs text-muted-foreground"
                            title="Sampling steps for final refinement pass. More is clearer, but takes longer."
                          >
                            Sigma profile (steps)
                          </Label>
                          <Select value={video.sigmaVariant || '3step'} onValueChange={(v) => patchVideo({ sigmaVariant: v })}>
                            <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
                              <SelectValue />
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
                            title="Sampling method for final refinement pass. If unsure, keep euler."
                          >
                            Sampler (pass 2)
                          </Label>
                          <Select value={video.pass2Sampler || 'euler'} onValueChange={(v) => patchVideo({ pass2Sampler: v })}>
                            <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent className="bg-[var(--surface-3)] border-border">
                              {['euler', 'er_sde', 'dpmpp_2m', 'dpmpp_3m_sde', 'heun', 'lcm', 'res_multistep'].map((s) => (
                                <SelectItem key={s} value={s}>{s}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      </motion.div>
                    )}
                  </div>
                )}

              </motion.div>
            )}
          </div>
        </div>

        {/* Pinned bottom: generation status */}
        <div className="shrink-0 border-t border-border p-3 bg-[var(--surface-1)]/90 backdrop-blur-sm">
          <GenerationStatus
            isGenerating={isGenerating}
            phase={phase}
            progressPercent={progressPercent}
            statusMessage={statusMessage}
            error={error}
            onInterrupt={interrupt}
            onReset={reset}
            startedAt={videoStartedAt}
            promptId={promptId}
            stageKind={video.extendTwoPass ? 'clips2' : 'clips'}
          />
        </div>
      </div>

      {/* ═══════════ RIGHT: Clips + Gallery (flex-1) ═══════════ */}
      <div style={{ minWidth: 0, overflow: 'hidden' }} className="flex-1 flex flex-col bg-[var(--surface-1)]">
        <div style={{ overflow: 'hidden', maxWidth: '100%' }} className="p-5 pb-3 space-y-3 aurora-bg">
          <div style={{ minWidth: 0 }} className="space-y-2">
            <div className="flex items-center justify-between shrink-0">
              <Label
                className="text-sm font-medium text-foreground flex items-center gap-2"
                title="Each clip continues the previous one — together they are concatenated with source into a single video."
              >
                <SparklesIcon className="w-4 h-4 text-cyan-400" />
                Extension clips
                <span className="text-[10px] font-normal text-muted-foreground/60">
                  {video.extendClips.length} clip(s)
                </span>
              </Label>
              <span className="text-[10px] text-muted-foreground/70 hidden sm:block">
                <kbd className="px-1.5 py-0.5 rounded border border-border bg-[var(--surface-2)] font-mono text-[10px]">Ctrl</kbd>
                {' + '}
                <kbd className="px-1.5 py-0.5 rounded border border-border bg-[var(--surface-2)] font-mono text-[10px]">Enter</kbd>
                {' — generate'}
              </span>
            </div>

            {/* Clips ribbon */}
            <div ref={clipsStripRef} className="pb-2 overflow-x-auto min-w-0">
            <div className="pb-1 flex gap-3 w-max">
              {video.extendClips.map((clip, i) => (
                <div
                  key={clip.id ?? `clip-${i}`}
                  className="flex flex-col p-3 rounded-lg border border-border bg-[var(--surface-2)] space-y-2 w-[280px] shrink-0"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-foreground">Clip {i + 1}</span>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setFixClip(i)}
                        className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-amber-300 transition-colors"
                        title="Fix clip prompt with assistant (describe what to change)"
                      >
                        <SparklesIcon className="w-3 h-3" />
                        Fix
                      </button>
                      {clip.prompt.trim() && (
                        <button
                          type="button"
                          onClick={() => {
                            const clips = [...video.extendClips]
                            clips[i] = { ...clips[i], prompt: '' }
                            patchVideo({ extendClips: clips })
                          }}
                          className="text-[10px] text-muted-foreground hover:text-red-400 transition-colors"
                          title="Clear clip prompt"
                        >
                          Clear
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          const clips = [...video.extendClips]
                          clips.splice(i, 1)
                          patchVideo({ extendClips: clips })
                        }}
                        className="text-[10px] text-muted-foreground hover:text-red-400 transition-colors"
                      >
                        Delete
                      </button>
                    </div>
                  </div>

                  <div className="relative h-[150px] shrink-0">
                    <PromptFieldTools>
                      <PromptClearButton
                        disabled={!clip.prompt.trim()}
                        onClear={() => {
                          const clips = [...video.extendClips]
                          clips[i] = { ...clips[i], prompt: '' }
                          patchVideo({ extendClips: clips })
                        }}
                      />
                      <PromptFixButton onFix={() => setFixClip(i)} />
                    </PromptFieldTools>
                    <MentionTextarea
                      value={clip.prompt}
                      onChange={(v) => {
                        const clips = [...video.extendClips]
                        clips[i] = { ...clips[i], prompt: v }
                        patchVideo({ extendClips: clips })
                      }}
                      onKeyDown={(e) => {
                        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                          e.preventDefault()
                          void handleGenerate()
                        }
                      }}
                      placeholder="What happens in this clip: action, camera angle, motion..."
                      mentions={clipMentions}
                      className="h-full min-h-0 pr-12"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <Label className="text-[10px] text-muted-foreground">Duration, s:</Label>
                    <input
                      type="number"
                      min={3}
                      max={30}
                      value={Math.round(clip.duration)}
                      onChange={(e) => {
                        const clips = [...video.extendClips]
                        clips[i] = { ...clips[i], duration: Math.max(3, Math.min(30, parseInt(e.target.value, 10) || 3)) }
                        patchVideo({ extendClips: clips })
                      }}
                      className="w-16 text-xs bg-[var(--surface-3)] border border-border rounded-md px-2 py-1 text-foreground"
                    />
                    <span className="text-[10px] text-muted-foreground">
                      {(() => {
                        const sumUpTo = video.extendClips.slice(0, i + 1).reduce((s, c) => s + c.duration, 0)
                        const srcD = typeof video.extendSourceDuration === 'number' && video.extendSourceDuration > 0
                          ? video.extendSourceDuration : 0
                        return srcD > 0
                          ? `${sumUpTo} s · total ~${(srcD + sumUpTo).toFixed(0)} s`
                          : `${sumUpTo} s (clips total: ${video.extendClips.reduce((s, c) => s + c.duration, 0)} s)`
                      })()}
                    </span>
                    <button
                      type="button"
                      onClick={() => setEditingClip(i)}
                      className="ml-auto inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-cyan-300 transition-colors"
                      title="Open clip prompt in full-screen editor"
                    >
                      <Maximize2Icon className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              ))}

              {/* Add clip button */}
              <button
                type="button"
                onClick={() => {
                  const clips = [...video.extendClips]
                  clips.push({ prompt: '', duration: 5, seed: -1, id: `clip-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}` })
                  patchVideo({ extendClips: clips })
                }}
                className="w-[140px] shrink-0 rounded-lg border-2 border-dashed border-border hover:border-cyan-500/50 hover:bg-[var(--surface-2)] transition-all flex flex-col items-center justify-center gap-2 text-muted-foreground hover:text-cyan-400"
              >
                <PlusIcon className="w-5 h-5" />
                <span className="text-xs">Add clip</span>
              </button>
            </div>
            </div>

            {/* Badges */}
            <div className="flex flex-wrap items-center gap-1.5">{badges}</div>
          </div>

          {/* Generate button */}
          <div className="pt-2 flex justify-end">
            <Button
              onClick={() => void handleGenerate()}
              disabled={!canGenerateNow}
              title={
                assistantBusy
                  ? '💬 Assistant is responding — wait for response or cancel it'
                  : 'Generate extension (Ctrl+Enter)'
              }
              className="h-11 px-6 bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white border-0 text-sm font-semibold shadow-lg shadow-cyan-500/20"
            >
              {isGenerating ? 'Queue another' : (
                <>
                  <PlayIcon className="w-4 h-4 mr-2" />
                  Generate extension
                </>
              )}
            </Button>
          </div>
        </div>

        {/* Results gallery */}
        <div style={{ flex: '1 1 0%', minHeight: 0, overflowY: 'auto' }} className="px-5 pb-5">
          <VideoGalleryGrid
            files={galleryFiles}
            loading={galleryLoading}
            onRefresh={loadGallery}
            onDeleteFile={deleteFile}
            emptyHint="Generated extension videos will appear here. Describe the scene, add clips, and click 'Generate extension'."
          />
        </div>
      </div>

      {/* Assistant panel */}
      <AssistantPanel mode="extend" />

      {/* Fullscreen clip prompt editor */}
      <PromptEditorDialog
        open={editingClip !== null}
        onOpenChange={(v) => { if (!v) setEditingClip(null) }}
        initialText={editingClip !== null ? (video.extendClips[editingClip]?.prompt ?? '') : ''}
        onSave={(text) => {
          if (editingClip === null) return
          const clips = [...useGenStore.getState().video.extendClips]
          if (!clips[editingClip]) return
          clips[editingClip] = { ...clips[editingClip], prompt: text }
          patchVideo({ extendClips: clips })
        }}
        onSaveAndRun={() => { void handleGenerate() }}
        placeholder="What happens in this clip: action, camera angle, motion..."
        mentions={clipMentions}
        improveOptions={editingClip !== null ? { mode: 'extend', clipNumber: editingClip + 1 } : undefined}
      />

      {/* Prompt fix dialog */}
      <PromptFixDialog
        open={fixClip !== null}
        onOpenChange={(v) => { if (!v) setFixClip(null) }}
        hint={fixClip !== null ? `Clip ${fixClip + 1} prompt and your request will be sent to the Extension tab assistant chat — you can paste the response back with 'To Prompt'. Ctrl+Enter to send, Esc to cancel.` : undefined}
        onSubmit={(req) => {
          const n = fixClip
          if (n === null) return
          requestImprovePrompt(video.extendClips[n]?.prompt ?? '', { mode: 'extend', clipNumber: n + 1, fixRequest: req })
        }}
      />
    </div>
  )
}
