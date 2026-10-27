'use client'

/**
 * FaceRefineView — "Face Refine" tab: redrawing small faces in finished
 * video via ComfyUI-H3-FaceRefine nodes (detect → crop → H3 → composite back).
 *
 * Layout similar to Tile Upscale: left — parameters + status, right — gallery.
 * Source: drag & drop from gallery or file from disk.
 *
 * "Whom to refine" — three methods:
 *  • rule + rank index (largest_face / centre_most / left_most …);
 *  • click on face in source preview (closest_to_xy);
 *  • reference photo of person (identity_reference) — tracker finds them
 *    in each shot by facial embedding match (insightface).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ScanFaceIcon,
  CrosshairIcon,
  PlayIcon,
  FileVideoIcon,
  ImageIcon,
  Loader2Icon,
  XIcon,
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
import { SettingSlider } from '@/components/h3/setting-slider'
import { VideoGalleryGrid, H3_VIDEO_DND_MIME } from '@/components/h3/video-gallery-grid'
import { GenerationStatus } from '@/components/h3/generation-status'
import { RefPreviewThumb } from '@/components/h3/ref-preview-thumb'
import { FacePickDialog } from '@/components/h3/face-pick-dialog'
import { useVideoGallery } from '@/components/h3/use-video-gallery'
import {
  useFaceRefineTarget,
  type FaceRefineSource,
} from '@/lib/face-refine-target-store'
import { useFaceRefineJob } from '@/lib/face-refine-job-store'
import { uploadInputFile } from '@/lib/upload'
import type { FaceSelectMode } from '@/lib/comfy/face-refine-template'

const SELECT_MODES: Array<{ value: FaceSelectMode; label: string }> = [
  { value: 'largest_face', label: 'Largest face' },
  { value: 'centre_most', label: 'Closest to frame center' },
  { value: 'left_most', label: 'Leftmost' },
  { value: 'right_most', label: 'Rightmost' },
  { value: 'top_most', label: 'Topmost' },
  { value: 'bottom_most', label: 'Bottommost' },
  { value: 'smallest_face', label: 'Smallest face' },
  { value: 'detector_score', label: 'Highest confidence' },
  { value: 'closest_to_xy', label: 'Point on face (frame click)' },
]

export function FaceRefineView() {
  const storeTarget = useFaceRefineTarget((s) => s.target)
  const clearStoreTarget = useFaceRefineTarget((s) => s.clear)
  const source = useFaceRefineTarget((s) => s.source)
  const setSource = useFaceRefineTarget((s) => s.setSource)
  const identityRef = useFaceRefineTarget((s) => s.identityRef)
  const setIdentityRef = useFaceRefineTarget((s) => s.setIdentityRef)
  const facePoint = useFaceRefineTarget((s) => s.facePoint)
  const setFacePoint = useFaceRefineTarget((s) => s.setFacePoint)
  const identityOverridesSelection = Boolean(identityRef) && !facePoint
  const params = useFaceRefineTarget((s) => s.params)
  const patchParams = useFaceRefineTarget((s) => s.patchParams)

  const prevSourceUrlRef = useRef<string | null>(null)
  const setSourceSafe = useCallback(
    (next: FaceRefineSource | null) => {
      const prev = prevSourceUrlRef.current
      if (prev && prev.startsWith('blob:') && prev !== next?.url) {
        try { URL.revokeObjectURL(prev) } catch { /* already revoked */ }
      }
      prevSourceUrlRef.current = next?.url ?? null
      setSource(next)
      setFacePoint(null)
    },
    [setSource, setFacePoint],
  )
  const sourceRef = useRef<FaceRefineSource | null>(null)
  sourceRef.current = source

  const [prompt, setPrompt] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [uploadingSrc, setUploadingSrc] = useState(false)
  const [uploadingRef, setUploadingRef] = useState(false)
  const [fallbackAvailable, setFallbackAvailable] = useState<boolean | null>(null)
  const [srcProbe, setSrcProbe] = useState<{ fps: number; frames: number } | null>(null)
  const [pickOpen, setPickOpen] = useState(false)

  const busy = useFaceRefineJob((s) => s.busy)
  const phase = useFaceRefineJob((s) => s.phase)
  const progress = useFaceRefineJob((s) => s.progress)
  const error = useFaceRefineJob((s) => s.error)
  const promptId = useFaceRefineJob((s) => s.promptId)
  const startedAt = useFaceRefineJob((s) => s.startedAt)
  const jobSubmit = useFaceRefineJob((s) => s.submit)
  const jobCancel = useFaceRefineJob((s) => s.cancel)
  const jobReset = useFaceRefineJob((s) => s.reset)

  const gallery = useVideoGallery()

  useEffect(() => {
    let alive = true
    const q = new URLSearchParams()
    if (source?.inputSource) {
      q.set('input', source.inputSource)
    } else if (source) {
      q.set('filename', source.filename)
      q.set('subfolder', source.subfolder ?? '')
    }
    const qs = q.toString()
    void fetch(`/api/comfy/face-refine${qs ? `?${qs}` : ''}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: {
        fallbackDetector?: string | null
        probe?: { fps?: number; frames?: number } | null
      } | null) => {
        if (!alive) return
        setFallbackAvailable(Boolean(d?.fallbackDetector))
        setSrcProbe(d?.probe ? { fps: d.probe.fps ?? 24, frames: d.probe.frames ?? 0 } : null)
      })
      .catch(() => {
        if (alive) {
          setFallbackAvailable(false)
          setSrcProbe(null)
        }
      })
    return () => { alive = false }
  }, [busy, source])

  useEffect(() => {
    if (!storeTarget) return
    const file = gallery.files.find(
      (f) => f.filename === storeTarget.filename && f.subfolder === storeTarget.subfolder,
    )
    if (file) {
      setSourceSafe(file as FaceRefineSource)
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

  const fileInputRef = useRef<HTMLInputElement>(null)
  const refInputRef = useRef<HTMLInputElement>(null)
  const VIDEO_EXTS = '.mp4,.m4v,.mov,.mkv,.avi,.webm,.m2ts,.mts,.mxf,.vob,.wmv,.flv,.mpg,.mpeg,.ogv'
  const IMAGE_EXTS = '.png,.jpg,.jpeg,.webp,.bmp'

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

  const uploadIdentityRef = useCallback(async (file: File) => {
    setUploadingRef(true)
    try {
      const { path } = await uploadInputFile(file)
      setIdentityRef({
        name: path,
        previewUrl: URL.createObjectURL(file),
      })
      if (facePoint) {
        setFacePoint(null)
        patchParams({ select: 'largest_face' })
        toast.success('Face reference uploaded — frame point removed')
      } else {
        toast.success('Face reference uploaded')
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Error uploading reference')
    } finally {
      setUploadingRef(false)
    }
  }, [setIdentityRef, facePoint, setFacePoint, patchParams])

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
      prompt: prompt.trim() || undefined,
      seed: -1,
      canvas: params.canvas,
      denoise: params.denoise,
      steps: params.steps,
      select: params.select === 'closest_to_xy' && !facePoint ? 'largest_face' : params.select,
      selectIndex: params.selectIndex,
      identityModel: params.identityModel,
      identityTrack: params.identityTrack,
      cropFactor: params.cropFactor,
      confidence: params.confidence,
      pasteRegion: params.pasteRegion,
      feather: params.feather,
      colourMatch: params.colourMatch,
      blend: params.blend,
      undetectedFrames: params.undetectedFrames,
      denoiseSmall: params.denoiseSmall,
      denoiseLarge: params.denoiseLarge,
      fallback: params.fallback && fallbackAvailable === true,
      ...(facePoint ? { facePoint } : {}),
      ...(identityRef ? { identityReference: identityRef.name } : {}),
    }
    await jobSubmit(body)
  }, [
    prompt,
    uploadingSrc,
    params,
    identityRef,
    jobSubmit,
    fallbackAvailable,
    facePoint,
  ])

  const cancel = useCallback(() => { void jobCancel() }, [jobCancel])
  const reset = useCallback(() => { jobReset() }, [jobReset])

  const srcThumb = (f: FaceRefineSource) =>
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

  const identityPreview = identityRef
    ? `/api/comfy/file?filename=${encodeURIComponent(identityRef.name)}&subfolder=&type=input&width=96`
    : null

  return (
    <div className="flex h-full w-full min-w-0">
      {/* ═══ Parameter Panel ═══ */}
      <aside className="w-[360px] shrink-0 border-r border-border bg-[var(--surface-1)] flex flex-col">
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <div className="flex items-center gap-2">
            <ScanFaceIcon className="w-4 h-4 text-yellow-400" />
            <h2 className="text-sm font-semibold text-foreground">Face Refine</h2>
          </div>

          <p className="text-[11px] text-muted-foreground leading-relaxed">
            H3 struggles with faces when the head occupies a small portion of the frame. The node
            detects the face, re-renders it at high resolution, and composites it back — the rest of the
            frame remains untouched.
          </p>

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
                  dragOver ? 'border-yellow-400 ring-1 ring-yellow-400/50' : 'border-border',
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
                  {uploadingSrc && <p className="text-[10px] text-yellow-400">uploading…</p>}
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
                  dragOver ? 'border-yellow-400 bg-yellow-500/10' : 'border-border hover:border-yellow-500/40 hover:bg-[var(--surface-2)]',
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

          {/* Whom to refine */}
          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground font-medium">Face to Refine</Label>

            {facePoint ? (
              <div className="flex items-center gap-2 rounded-lg border border-yellow-500/40 bg-yellow-500/10 p-2">
                <CrosshairIcon className="w-4 h-4 text-yellow-400 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-foreground">Face selected by click</p>
                  <p className="text-[10px] text-muted-foreground font-mono">
                    X {facePoint.x} · Y {facePoint.y} · frame {facePoint.frame}
                  </p>
                </div>
                {!busy && (
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      onClick={() => setPickOpen(true)}
                      className="text-[10px] text-yellow-400 hover:text-yellow-300"
                    >
                      change
                    </button>
                    <button
                      onClick={() => {
                        setFacePoint(null)
                        patchParams({ select: 'largest_face' })
                      }}
                      className="text-muted-foreground hover:text-foreground"
                      title="Reset point and return to rule"
                    >
                      <XIcon className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setPickOpen(true)}
                disabled={!source || busy}
                className="w-full flex items-center justify-center gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground hover:border-yellow-500/40 hover:bg-[var(--surface-2)] transition-all disabled:opacity-50"
                title="Open source frame and click on target face"
              >
                <CrosshairIcon className="w-3.5 h-3.5" />
                Select face by clicking on frame
              </button>
            )}

            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground" title="Subject selection rule. Selected ONCE per shot, tracker follows the same face afterwards.">
                Rule
              </Label>
              <Select
                value={params.select === 'closest_to_xy' && !facePoint ? 'largest_face' : params.select}
                onValueChange={(v) => {
                  const mode = v as FaceSelectMode
                  patchParams({ select: mode })
                  if (mode !== 'closest_to_xy') setFacePoint(null)
                  else if (!facePoint) setPickOpen(true)
                }}
                disabled={busy || identityOverridesSelection}
              >
                <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-[var(--surface-3)] border-border">
                  {SELECT_MODES.map((m) => (
                    <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground" title="Face index in rule ranking: 0 — first, 1 — second, etc. Not used when selecting by click.">
                Rank index
              </Label>
              <Select
                value={String(params.selectIndex)}
                onValueChange={(v) => patchParams({ selectIndex: parseInt(v, 10) })}
                disabled={busy || Boolean(facePoint) || identityOverridesSelection}
              >
                <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-[var(--surface-3)] border-border">
                  {[0, 1, 2, 3].map((n) => (
                    <SelectItem key={n} value={String(n)}>{n + 1}th face</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {identityOverridesSelection && (
                <p className="text-[10px] leading-snug text-yellow-400/90">
                  A specific person reference is selected — the node uses it, while the rule and rank index are ignored. To restore the rule, remove the reference photo.
                </p>
              )}
            </div>

            {/* Reference of specific person */}
            <div className="space-y-1">
              <Label
                className="text-xs text-muted-foreground"
                title="Photo of a specific person. Tracker matches faces by embedding (insightface) and tracks this person throughout the video. Requires buffalo_l and insightface package."
              >
                Specific person reference (optional)
              </Label>
              {identityRef ? (
                <div className={cn(
                  'flex items-center gap-2 rounded-lg border border-border bg-[var(--surface-2)] p-2',
                  facePoint && 'opacity-60',
                )}>
                  {identityPreview && (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img
                      src={identityPreview}
                      alt=""
                      className="w-10 h-10 rounded object-cover border shrink-0"
                    />
                  )}
                  <p className="text-xs font-medium text-foreground truncate flex-1">{identityRef.name}</p>
                  {!busy && (
                    <button
                      onClick={() => setIdentityRef(null)}
                      className="text-muted-foreground hover:text-foreground shrink-0"
                    >
                      <XIcon className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => refInputRef.current?.click()}
                  disabled={busy}
                  className="w-full flex items-center justify-center gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground hover:border-yellow-500/40 hover:bg-[var(--surface-2)] transition-all disabled:opacity-50"
                >
                  {uploadingRef
                    ? <Loader2Icon className="w-3.5 h-3.5 animate-spin" />
                    : <ImageIcon className="w-3.5 h-3.5" />}
                  Upload photo of person
                </button>
              )}
              <input
                ref={refInputRef}
                type="file"
                accept={IMAGE_EXTS}
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) void uploadIdentityRef(f)
                  e.target.value = ''
                }}
              />
              {facePoint && identityRef && (
                <p className="text-[10px] text-yellow-400/90 leading-snug">
                  Not used: face is selected by click, tracker uses point coordinates. Remove point (✕ on card) or upload photo again to search by face.
                </p>
              )}
            </div>
          </div>

          {/* Pipeline parameters */}
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label
                className="text-xs text-muted-foreground"
                title="Canvas size in which H3 re-renders the face. 512 is about 2.25x cheaper than 768 in latent tokens; above 768 uses significantly more VRAM and time (engine maximum is 1344)."
              >
                Canvas (px)
              </Label>
              <Select
                value={String(params.canvas)}
                onValueChange={(v) => patchParams({ canvas: parseInt(v, 10) })}
                disabled={busy}
              >
                <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-[var(--surface-3)] border-border">
                  {[384, 512, 640, 768, 896, 1024, 1152, 1280].map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n}{n > 768 ? ' — above reference' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground" title="Sampling steps. Our model is 4-step — this is the recommended value.">
                Steps
              </Label>
              <Select
                value={String(params.steps)}
                onValueChange={(v) => patchParams({ steps: parseInt(v, 10) })}
                disabled={busy}
              >
                <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-[var(--surface-3)] border-border">
                  {[2, 3, 4, 6, 8].map((n) => (
                    <SelectItem key={n} value={String(n)}>{n}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <SettingSlider
            label="Denoise"
            labelTitle="How strongly the model redraws the face. H3 uses flow matching with shift 12: 0.25 gives effective sigma 0.800 (frame rewritten entirely). Working range: 0.25–0.40."
            value={params.denoise}
            min={0.05}
            max={0.6}
            step={0.05}
            onChange={(v) => patchParams({ denoise: v })}
            formatValue={(v) => v.toFixed(2)}
            disabled={busy}
          />

          {/* Advanced Parameters */}
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="w-full flex items-center justify-between px-3 py-2 rounded-lg bg-[var(--surface-2)] border border-border hover:border-yellow-500/30 transition-all text-left"
            >
              <span className="text-xs font-medium text-muted-foreground">Advanced Parameters</span>
              <span className={cn('text-[10px] text-muted-foreground transition-transform', showAdvanced && 'rotate-180')}>▼</span>
            </button>

            {showAdvanced && (
              <div className="space-y-3 pl-1">
                <SettingSlider
                  label="Face crop factor (×)"
                  labelTitle="Crop bounding box side as a multiple of face height. 2.5 places the face at ~40% of the canvas. Larger values provide more context, but less magnification."
                  value={params.cropFactor}
                  min={1.2}
                  max={5}
                  step={0.1}
                  onChange={(v) => patchParams({ cropFactor: v })}
                  formatValue={(v) => v.toFixed(1)}
                  disabled={busy}
                />
                <SettingSlider
                  label="Detector confidence"
                  labelTitle="Lower threshold detects more profile views and tiny faces, but increases false positives."
                  value={params.confidence}
                  min={0.05}
                  max={0.9}
                  step={0.05}
                  onChange={(v) => patchParams({ confidence: v })}
                  formatValue={(v) => v.toFixed(2)}
                  disabled={busy}
                />
                <SettingSlider
                  label="Denoise: small faces ×"
                  labelTitle="Denoise multiplier for very small faces. Below 1.0 makes the whole clip softer."
                  value={params.denoiseSmall}
                  min={0}
                  max={1}
                  step={0.05}
                  onChange={(v) => patchParams({ denoiseSmall: v })}
                  formatValue={(v) => v.toFixed(2)}
                  disabled={busy}
                />
                <SettingSlider
                  label="Denoise: large faces ×"
                  labelTitle="Denoise multiplier for large faces — they already have details and need less redrawing."
                  value={params.denoiseLarge}
                  min={0}
                  max={1}
                  step={0.05}
                  onChange={(v) => patchParams({ denoiseLarge: v })}
                  formatValue={(v) => v.toFixed(2)}
                  disabled={busy}
                />

                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground" title="What is pasted back: only face rectangle, face ellipse, or full crop (with hair and background — may show a visible boundary).">
                    Composite region
                  </Label>
                  <Select
                    value={params.pasteRegion}
                    onValueChange={(v) => patchParams({ pasteRegion: v as 'face_only' | 'face_ellipse' | 'full_crop' })}
                    disabled={busy}
                  >
                    <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-[var(--surface-3)] border-border">
                      <SelectItem value="face_only">Only face</SelectItem>
                      <SelectItem value="face_ellipse">Face ellipse</SelectItem>
                      <SelectItem value="full_crop">Full crop</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground" title="What to do with frames where face is not detected (turned away, occluded).">
                    Frames without detected face
                  </Label>
                  <Select
                    value={params.undetectedFrames}
                    onValueChange={(v) => patchParams({ undetectedFrames: v as 'fade_out' | 'skip' | 'composite_anyway' })}
                    disabled={busy}
                  >
                    <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-[var(--surface-3)] border-border">
                      <SelectItem value="fade_out">Fade out composite</SelectItem>
                      <SelectItem value="skip">Skip (keep original)</SelectItem>
                      <SelectItem value="composite_anyway">Composite anyway</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* Person fallback checkbox */}
                <label
                  className={cn(
                    'flex items-start gap-2 rounded-lg border border-border bg-[var(--surface-2)] p-2.5 transition-all',
                    fallbackAvailable === true && !busy
                      ? 'cursor-pointer hover:border-yellow-500/40'
                      : 'opacity-60',
                  )}
                >
                  <input
                    type="checkbox"
                    checked={params.fallback && fallbackAvailable === true}
                    onChange={(e) => patchParams({ fallback: e.target.checked })}
                    disabled={busy || fallbackAvailable !== true}
                    className="mt-0.5 accent-yellow-400"
                  />
                  <span className="space-y-0.5">
                    <span className="block text-xs font-medium text-foreground">
                      Distant shots: detect person
                    </span>
                    <span className="block text-[10px] text-muted-foreground leading-relaxed">
                      {fallbackAvailable === true
                        ? 'When face is not visible (turned back, wearing hood) — head position is taken from person bounding box. Without this, missing frames are interpolated.'
                        : fallbackAvailable === null
                          ? 'Checking detector models…'
                          : 'Requires segm/person_yolov8m-seg.pt model in models/ultralytics — restart studio after installation.'}
                    </span>
                  </span>
                </label>

                <SettingSlider
                  label="Feather radius (px)"
                  labelTitle="Feathering radius of composite mask in source pixels. Smaller values give sharper edges."
                  value={params.feather}
                  min={0}
                  max={40}
                  step={2}
                  onChange={(v) => patchParams({ feather: v })}
                  formatValue={(v) => String(v)}
                  disabled={busy}
                />
                <SettingSlider
                  label="Color match"
                  labelTitle="Matches mean and deviation of redrawn face to original area — prevents face from looking pasted on."
                  value={params.colourMatch}
                  min={0}
                  max={1}
                  step={0.05}
                  onChange={(v) => patchParams({ colourMatch: v })}
                  formatValue={(v) => v.toFixed(2)}
                  disabled={busy}
                />
                <SettingSlider
                  label="Composite opacity"
                  labelTitle="Overall opacity of redrawn face. Below 1.0 blends with original."
                  value={params.blend}
                  min={0}
                  max={1}
                  step={0.05}
                  onChange={(v) => patchParams({ blend: v })}
                  formatValue={(v) => v.toFixed(2)}
                  disabled={busy}
                />
              </div>
            )}
          </div>

          {/* Start */}
          <div className="flex gap-2 pt-1">
            <Button onClick={start} disabled={!source} className="flex-1 gap-1.5">
              <PlayIcon className="w-4 h-4" />
              {busy ? 'Queue another' : 'Run Face Refine'}
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
            emptyHint="Face Refine results will appear here"
          />
        </div>
      </section>

      {/* Dialog for selecting face by click on source frame */}
      {source && (
        <FacePickDialog
          open={pickOpen}
          onOpenChange={(open) => {
            setPickOpen(open)
            if (!open && !facePoint) patchParams({ select: 'largest_face' })
          }}
          url={source.url}
          filename={source.filename}
          fps={srcProbe?.fps ?? 24}
          frames={srcProbe?.frames ?? 0}
          point={facePoint}
          onPick={(p) => {
            setFacePoint(p)
            patchParams({ select: 'closest_to_xy' })
          }}
          onClear={() => {
            setFacePoint(null)
            patchParams({ select: 'largest_face' })
          }}
        />
      )}
    </div>
  )
}
