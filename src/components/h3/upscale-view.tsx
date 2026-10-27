'use client'

/**
 * (fix 74) UpscaleView — native "Upscale" tab (renamed to "DLSS" — fix 266).
 *
 * Layout matches "Generate" tab:
 *  • left — parameter panel: service status (always visible), then
 *    collapsible block "{mode} — parameters"
 *    (fixes 136/137/162: "GPU" and "Encoding" blocks removed — always H.264, HDR disabled);
 *    pinned job status block at the bottom;
 *  • top right — mode selection (Neural Rendering / RTX VSR) + video
 *    upload + start button;
 *  • bottom right — SHARED video gallery (ComfyUI output folder): upscale results
 *    appear alongside generated videos, visible in "Gallery" tab
 *    and cleaned with "Delete content" button.
 *
 * (fix 77) Service state (running/starting/schema/job) moved to
 * client singleton `useUpscaleService` (src/lib/upscale-service.ts):
 * polling, autostart, and toasts survive tab switching (previously
 * intervals died on unmount, and service "started when user returned").
 * Download link removed — file is in shared gallery.
 *
 * DLSS 5 Visual Enhancer built into project (upscale/ folder):
 *  • Neural Rendering — video (noise, tone, structure, presets)
 *  • RTX Video Super Resolution — upscale 1×–4× (HDR disabled, fix 162)
 *
 * UI communicates ONLY with Next.js routes /api/upscale/*; they in turn
 * talk with headless bridge upscale/bridge.py (embedded Python).
 * Video only: image submodes are omitted from UI.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import {
  SparklesIcon,
  PlayIcon,
  SquareIcon,
  UploadCloudIcon,
  RefreshCwIcon,
  PowerOffIcon,
  FileVideoIcon,
  Loader2Icon,
  AlertTriangleIcon,
  XIcon,
  CheckCircle2Icon,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
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
import { SettingSlider } from '@/components/h3/setting-slider'
// (fix 719) Preview with fullscreen lightbox — same as on "Generate".
import { RefPreviewThumb } from '@/components/h3/ref-preview-thumb'
import { VideoGalleryGrid, H3_VIDEO_DND_MIME } from '@/components/h3/video-gallery-grid'
import { useVideoGallery } from '@/components/h3/use-video-gallery'
import { useGalleryRefresh } from '@/lib/gallery-refresh-store'
import { useUpscaleTarget } from '@/lib/upscale-target-store'
import {
  useUpscaleService,
  attachUpscaleService,
  detachUpscaleService,
  isUpscaleJobActive,
  type UpscaleFeatureSchema,
  type UpscaleSchema,
} from '@/lib/upscale-service'
import {
  enqueueUpscale,
  cancelActiveUpscales,
  sweepOrphanUpscaleItems,
} from '@/lib/upscale-queue'

/* ────────────────────────────────────────────────────────────────
 * Types (status/schema/job/Gpu in @/lib/upscale-service)
 * ──────────────────────────────────────────────────────────────── */

type FeatureKey = 'nr-video' | 'vsr-video'

interface UploadResp {
  ok: boolean
  path: string
  name: string
  size: number
  kind: 'image' | 'video'
  /** (fix 727) Source folder in gallery ('' = output root). */
  subfolder?: string
  error?: string
}

interface ProbeResp {
  input: string
  size_bytes: number
  name: string
  kind: string
  width?: number
  height?: number
  fps?: number
  duration?: number
  frames?: number
  codec?: string
  hdr?: unknown
  format?: string
}

/* ────────────────────────────────────────────────────────────────
 * Form controls (parameter descriptions by feature)
 * ──────────────────────────────────────────────────────────────── */

interface OptItem {
  label: string
  value: string | number
}

type Control = {
  kind: 'select' | 'slider' | 'toggle' | 'number'
  key: string
  label: string
  items?: OptItem[]
  min?: number
  max?: number
  step?: number
  int?: boolean
  hiddenIf?: (o: Record<string, unknown>) => boolean
}

const STR = (arr: string[]): OptItem[] => arr.map((v) => ({ label: v, value: v }))

const FALLBACK = {
  nrPreset: STR(['Default', 'Preset #1', 'Preset #2', 'Preset #3']),
  nrStyle: STR(['Default', 'Natural', 'Cinematic']),
  dlssModel: STR(['Default', 'J', 'K', 'L', 'M']),
  factor: [
    { label: '1× (DLAA / native)', value: 1.0 },
    { label: '1.5× (Quality)', value: 1.5 },
    { label: '1.724× (Balanced)', value: 1.724 },
    { label: '2× (Performance)', value: 2.0 },
    { label: '3× (Ultra Performance)', value: 3.0 },
  ],
  /* (fix 137) Codec is always H.264 — select "Codec" removed from UI, fallback remains
     in case bridge returns schema with this field. */
  codec: ['H.264'],
  vq: ['Auto (Default)'],
  cont: ['MP4'],
  vsrQ: [
    { label: '1 — Low', value: 1 },
    { label: '2 — Medium', value: 2 },
    { label: '3 — High', value: 3 },
    { label: '4 — Ultra', value: 4 },
  ],
  scale: [
    { label: '1×', value: 1 },
    { label: '1.5×', value: 1.5 },
    { label: '2×', value: 2 },
    { label: '3×', value: 3 },
    { label: '4×', value: 4 },
  ],
  sizeMode: STR(['Scale factor', 'Custom dimensions']),
}

function itemsFrom(s: UpscaleFeatureSchema | undefined, key: string, fallback: OptItem[]): OptItem[] {
  const raw = s?.choices?.[key]
  if (!Array.isArray(raw) || raw.length === 0) return fallback
  return raw.map((v) => {
    const item = Array.isArray(v) ? { label: String(v[0]), value: v[1] as string | number } : { label: String(v), value: String(v) }
    // (fix 162) scale_factor is number (1, 1.5, 2, 3, 4), not string:
    // bridge previously returned only labels → value = "1.5" → Python validate() failed.
    // If bridge already returns pairs — v[1] = number and cast is harmless.
    if (key === 'scale_factor' && typeof item.value === 'string') {
      const n = parseFloat(item.value)
      if (!Number.isNaN(n) && n >= 1) item.value = n
    }
    return item
  })
}

/** Size mode "Custom dimensions" (case/format-insensitive for bridge). */
function isCustomSize(o: Record<string, unknown>): boolean {
  return String(o.size_mode ?? '').toLowerCase().includes('custom')
}

function buildSpecs(schema: UpscaleSchema | null): Record<FeatureKey, Control[]> {
  const nrVid = schema?.['nr-video']
  const vsrVid = schema?.['vsr-video']
  // NR parameters shared across video features (shared dataclass fields in bridge).
  // Take schema from nr-video, fallback from nr-image (if backend provides it).
  const nrSrc = nrVid ?? schema?.['nr-image']

  const nrPreset = itemsFrom(nrSrc, 'nr_preset', FALLBACK.nrPreset)
  const nrStyle = itemsFrom(nrSrc, 'nr_style', FALLBACK.nrStyle)
  const dlssModel = itemsFrom(nrSrc, 'dlss_model_preset', FALLBACK.dlssModel)
  const factor = itemsFrom(nrSrc, 'upscaling_factor', FALLBACK.factor)
  /* (fix 137) codec/quality/container not used in UI — values
     are forced in run() (H.264 + auto-quality + MP4). */
  const vsrQ = itemsFrom(vsrVid, 'vsr_quality', FALLBACK.vsrQ)
  const scale = itemsFrom(vsrVid, 'scale_factor', FALLBACK.scale)
  const sizeMode = itemsFrom(vsrVid, 'size_mode', FALLBACK.sizeMode)

  const nrSliders: Control[] = [
    { kind: 'slider', key: 'nr_intensity', label: 'NR Intensity', min: 0, max: 2, step: 0.05 },
    { kind: 'slider', key: 'local_tone_strength', label: 'Local Tone', min: 0, max: 2, step: 0.05 },
    { kind: 'slider', key: 'local_structure_strength', label: 'Local Structure', min: 0, max: 2, step: 0.05 },
    { kind: 'slider', key: 'skin_structure_strength', label: 'Skin Structure', min: -1, max: 2, step: 0.05 },
  ]

  return {
    'nr-video': [
      { kind: 'select', key: 'nr_preset', label: 'NR Preset', items: nrPreset },
      { kind: 'select', key: 'nr_style', label: 'Style', items: nrStyle },
      { kind: 'select', key: 'dlss_model_preset', label: 'DLSS Model', items: dlssModel },
      { kind: 'select', key: 'upscaling_factor', label: 'Factor', items: factor },
      ...nrSliders,
    ],
    'vsr-video': [
      { kind: 'select', key: 'vsr_quality', label: 'VSR Quality', items: vsrQ },
      { kind: 'select', key: 'size_mode', label: 'Size Mode', items: sizeMode },
      /* size_mode may come from bridge in different case/format — compare
         case-insensitively with 'custom', not exact string. */
      { kind: 'select', key: 'scale_factor', label: 'Factor', items: scale, hiddenIf: isCustomSize },
      { kind: 'number', key: 'width', label: 'Width', min: 2, max: 16384, step: 2, int: true, hiddenIf: (o) => !isCustomSize(o) },
      { kind: 'number', key: 'height', label: 'Height', min: 2, max: 16384, step: 2, int: true, hiddenIf: (o) => !isCustomSize(o) },
      { kind: 'toggle', key: 'aspect_lock', label: 'Maintain aspect ratio', hiddenIf: (o) => !isCustomSize(o) },
      /* (fix 162) RTX Video HDR removed from UI: H.264 does not support HDR,
         avoiding user error. */
    ],
  }
}

/* ────────────────────────────────────────────────────────────────
 * Small UI elements
 * ──────────────────────────────────────────────────────────────── */

function OptSelect({ label, value, items, onChange }: {
  label: string
  value: string | number
  items: OptItem[]
  onChange: (v: string | number) => void
}) {
  const current = items.find((i) => String(i.value) === String(value))
  return (
    <div className="space-y-1.5">
      <span className="block text-xs font-medium text-muted-foreground">{label}</span>
      <Select
        value={String(value)}
        onValueChange={(v) => {
          const it = items.find((i) => String(i.value) === v)
          onChange(it ? it.value : v)
        }}
      >
        <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
          <SelectValue>{current ? current.label : String(value)}</SelectValue>
        </SelectTrigger>
        <SelectContent className="bg-[var(--surface-3)] border-border">
          {items.map((it) => (
            <SelectItem key={String(it.value)} value={String(it.value)}>
              {it.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

function OptToggle({ label, checked, onChange }: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex w-full items-center justify-between rounded-md border border-input bg-[var(--surface-2)]/40 px-3 py-2 text-left transition-colors hover:bg-accent/50"
    >
      <span className="text-xs font-medium text-foreground/90">{label}</span>
      <span
        className={cn(
          'relative h-5 w-9 shrink-0 rounded-full p-0.5 transition-colors',
          checked ? 'bg-violet-500' : 'bg-muted-foreground/30',
        )}
      >
        <span
          className={cn(
            'block h-4 w-4 rounded-full bg-white shadow transition-transform',
            checked ? 'translate-x-4' : 'translate-x-0',
          )}
        />
      </span>
    </button>
  )
}

function OptNumber({ label, value, min, max, step, int, onChange }: {
  label: string
  value: number
  min: number
  max: number
  step: number
  int?: boolean
  onChange: (v: number) => void
}) {
  return (
    <div className="space-y-1.5">
      <span className="block text-xs font-medium text-muted-foreground">{label}</span>
      <input
        type="number"
        value={Number.isFinite(value) ? value : min}
        min={min}
        max={max}
        step={int ? 1 : step}
        onChange={(e) => {
          const v = Number(e.target.value)
          if (Number.isFinite(v)) onChange(v)
        }}
        className="h-9 w-full rounded-md border border-input bg-[var(--surface-2)]/40 px-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-ring/40"
      />
    </div>
  )
}

function humanBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

function humanDuration(sec?: number): string {
  if (!Number.isFinite(sec) || sec === undefined || sec <= 0) return ''
  const s = Math.round(sec)
  const m = Math.floor(s / 60)
  const r = s % 60
  return m > 0 ? `${m} min ${r} s` : `${r} s`
}

/* ────────────────────────────────────────────────────────────────
 * Modes (video-only)
 * ──────────────────────────────────────────────────────────────── */

const MODES = [
  { id: 'nr', label: 'Neural Rendering', hint: 'Noise, tone, structure · up to 3×' },
  { id: 'vsr', label: 'RTX VSR', hint: 'Upscale 1–4×' },
] as const

type ModeId = (typeof MODES)[number]['id']

const VIDEO_EXTS =
  '.mp4,.m4v,.mov,.mkv,.avi,.webm,.m2ts,.mts,.mxf,.vob,.wmv,.flv,.mpg,.mpeg,.ogv'

/* (fix 137) ENC_KEYS/encControls/Encoding block removed: always H.264. */

/* ────────────────────────────────────────────────────────────────
 * Tab
 * ──────────────────────────────────────────────────────────────── */

export function UpscaleView() {
  /* (fix 77) Service state — singleton store: survives tab unmount,
   * toasts fired once in cycle, autostart in tick. */
  const st = useUpscaleService((s) => s.st)
  const schema = useUpscaleService((s) => s.schema)
  const job = useUpscaleService((s) => s.job)
  const startBusy = useUpscaleService((s) => s.startBusy)
  const cancelBusy = useUpscaleService((s) => s.cancelBusy)
  const start = useUpscaleService((s) => s.start)
  const stop = useUpscaleService((s) => s.stop)


  /* Mode (replaces old "tab NR/VSR + media type") */
  const [tab, setTab] = useState<ModeId>('nr')

  /* (fix 77) Collapsible blocks — collapsed by default, like Pass1/Pass2.
     (fix 136) GPU block removed from DLSS settings: always single GPU, no choice needed.
     (fix 137) "Encoding" block removed: always H.264, HDR preservation disabled. */
  const [showMode, setShowMode] = useState(false)

  /* File */
  const [file, setFile] = useState<UploadResp | null>(null)
  const [probe, setProbe] = useState<ProbeResp | null>(null)
  const [uploading, setUploading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  /* Options (local UI state: parameter values per feature) */
  const [opts, setOpts] = useState<Record<string, Record<string, unknown>>>({})

  /* Shared gallery (same as in "Generate" and "Gallery" tabs) */
  const { files: galleryFiles, loading: galleryLoading, load: loadGallery, deleteFile } = useVideoGallery()

  const svcRunning = st?.service.running ?? false
  const svcStarting = st?.service.starting ?? false
  const svcError = st?.service.error ?? null
  const gpus = st?.health?.gpus ?? []
  const runtimeReady = st?.health?.ready ?? false
  const runtimeError = st?.health?.error ?? null
  const disabled = st?.enabled === false

  const featureKey: FeatureKey = tab === 'nr' ? 'nr-video' : 'vsr-video'

  const isBusy = isUpscaleJobActive(job)

  /* (fix 267) Safeguard: upscale means INCREASE only. If source
   * is already >= 4K (short side >= 2160), any multiplier (1–4×)
   * yields >= 2160p — output >= source. If source is under 2160p,
   * multiplier 1× does not increase it (1× is "as is"), and no smaller
   * values exist in schema — so upscale without increasing is disallowed
   * (otherwise DLSS "enhances" high-res video uselessly). */
  const srcShortSide = probe?.width && probe?.height ? Math.min(probe.width, probe.height) : null
  const upscaleBlocked = !!srcShortSide && srcShortSide >= 2160

  // (fix 262) canRun does not depend on isBusy — can queue up
  // (fix 267) + block if source is already 4K or above
  const canRun = !disabled && svcRunning && runtimeReady && !!file && !uploading && !upscaleBlocked

  /* (fix 77) Bridge log tail line — live log line during startup. */
  const startLog = (() => {
    const t = st?.health?.log_tail
    return t && t.length > 0 ? t[t.length - 1] : null
  })()

  /* (fix 77) Singleton subscription: polling loop lives at module level. */
  useEffect(() => {
    attachUpscaleService()
    return () => detachUpscaleService()
  }, [])

  /* Defaults from schema — once, when schema is loaded (store caches it). */
  useEffect(() => {
    if (!schema) return
    setOpts((prev) => {
      const next = { ...prev }
      for (const [key, f] of Object.entries(schema)) {
        if (f?.defaults && !next[key]) next[key] = { ...f.defaults }
      }
      return next
    })
  }, [schema])

  /**
   * After job finishes, result may take a moment to flush/encode —
   * several staggered background reloads ensure the file appears
   * in the shared gallery (analogous to "staggered reload").
   * (fix 77) Completion toast is now in singleton; here only gallery,
   * bound to job id to prevent duplicate runs on remount.
   */
  const refreshTimers = useRef<ReturnType<typeof setTimeout>[]>([])
  const scheduleGalleryRefresh = useCallback(() => {
    refreshTimers.current.forEach(clearTimeout)
    refreshTimers.current = [1000, 3000, 6000, 12000].map((d) =>
      setTimeout(() => void loadGallery(true), d),
    )
  }, [loadGallery])
  useEffect(() => () => refreshTimers.current.forEach(clearTimeout), [])

  const galleryRefreshedFor = useRef<string | null>(null)
  useEffect(() => {
    if (job && job.status === 'done' && galleryRefreshedFor.current !== job.id) {
      galleryRefreshedFor.current = job.id
      scheduleGalleryRefresh()
      // (fix 259) Global signal: upscale result appears in
      // OTHER tabs with gallery ("Gallery", "Generate"), not only here.
      useGalleryRefresh.getState().bump()
    }
  }, [job, scheduleGalleryRefresh])

  /* ── Actions ── */

  /** Shared logic after file arrives (upload OR gallery import). */
  const applyLoadedFile = useCallback(async (d: UploadResp) => {
    setFile(d)
    toast.success(`File loaded: ${d.name}`)
    // Metadata (requires bridge).
    try {
      const p = await fetch('/api/upscale/probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: d.path }),
        signal: AbortSignal.timeout(60000),
      })
      const pd = (await p.json().catch(() => ({}))) as ProbeResp & { error?: string }
      if (p.ok) {
        setProbe(pd)
      } else if (pd.error) {
        // Metadata non-critical for rendering, but reporting errors helps UX.
        toast.warning(`Metadata unavailable: ${pd.error}`)
      }
    } catch {
      /* works without metadata as well — render does not depend on probe */
    }
  }, [])

  const doUpload = useCallback(async (f: File) => {
    if (uploading || isBusy) return
    setUploading(true)
    setProbe(null)
    setFile(null)
    try {
      const form = new FormData()
      form.append('file', f)
      const r = await fetch('/api/upscale/upload', { method: 'POST', body: form })
      const d = (await r.json().catch(() => ({}))) as UploadResp
      if (!r.ok || !d.ok) throw new Error(d.error ?? `upload → ${r.status}`)
      await applyLoadedFile(d)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Error uploading file')
    } finally {
      setUploading(false)
    }
  }, [uploading, isBusy, applyLoadedFile])

  /**
   * Video import FROM GALLERY (ComfyUI shared output folder): server copies
   * file to upscale-input directly — without browser in loop (video can be
   * gigabytes, fetch→blob→upload would be double transfer).
   */
  const doImport = useCallback(async (filename: string, subfolder: string) => {
    if (!filename) return
    if (uploading || isBusy) {
      toast.warning('Wait for current upscale processing to complete')
      return
    }
    setUploading(true)
    setProbe(null)
    setFile(null)
    try {
      const r = await fetch('/api/upscale/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, subfolder }),
      })
      const d = (await r.json().catch(() => ({}))) as UploadResp
      if (!r.ok || !d.ok) throw new Error(d.error ?? `import → ${r.status}`)
      await applyLoadedFile(d)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load video from gallery')
    } finally {
      setUploading(false)
    }
  }, [uploading, isBusy, applyLoadedFile])

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    // Video dragged from project gallery (thumbnail): import
    // on server from shared output folder (no browser in the loop).
    const raw = e.dataTransfer.getData(H3_VIDEO_DND_MIME)
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { filename?: string; subfolder?: string }
        void doImport(parsed.filename ?? '', parsed.subfolder ?? '')
      } catch {
        toast.error('Failed to read dragged video')
      }
      return
    }
    const f = e.dataTransfer.files?.[0]
    if (f) void doUpload(f)
  }, [doUpload, doImport])

  /* ── Video sent with "✨" button from gallery preview.
   *    Click can occur before tab mount (and from tab's own gallery) —
   *    take target from store and load video. ── */
  const target = useUpscaleTarget((s) => s.target)
  const clearTarget = useUpscaleTarget((s) => s.clear)
  const targetInFlightRef = useRef(false)
  const doImportRef = useRef(doImport)
  doImportRef.current = doImport
  useEffect(() => {
    if (!target || targetInFlightRef.current) return
    targetInFlightRef.current = true
    // (fix 587) finally clears target only if store STILL holds the SAME
    // target: a second video sent from gallery during import of the first
    // was previously silently dropped (cleared by first import's finally).
    const importedName = target.filename
    const importedSub = target.subfolder
    void doImportRef.current(importedName, importedSub).finally(() => {
      targetInFlightRef.current = false
      const cur = useUpscaleTarget.getState().target
      if (cur && cur.filename === importedName && cur.subfolder === importedSub) {
        clearTarget()
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target])

  // (fix 262) Launch via shared queue
  const run = useCallback(async () => {
    if (!canRun || !file) return
    /* (fix 137) Force H.264 codec + auto-quality + MP4:
       "Encoding" removed from UI, HDR preservation disabled. */
    const base = { ...(opts[featureKey] ?? {}) }
    base.codec = 'H.264'
    base.quality = 'Auto (Default)'
    base.container = 'MP4'
    /* (fix 162) HDR disabled: H.264 does not support HDR. */
    base.hdr_enabled = false
    base.preserve_hdr = false
    // (fix 264) sourceName — original file name for sidecar
    // (reserved for metadata).
    enqueueUpscale({
      feature: featureKey,
      input: file.path,
      options: base,
      sourceName: file.name,
      // (fix 727) Result into source folder from gallery.
      subfolder: file.subfolder || '',
    })
    toast.info(`Upscale queued: ${file.name}`)
  }, [canRun, file, featureKey, opts])

  const cancel = useCallback(() => {
    void cancelActiveUpscales()
  }, [])

  // (fix 262) Clean orphan items after reload
  useEffect(() => {
    sweepOrphanUpscaleItems()
  }, [])

  const setOptValue = useCallback((feature: FeatureKey, field: string, value: unknown) => {
    setOpts((prev) => {
      const cur = { ...(prev[feature] ?? {}) }
      cur[field] = value
      return { ...prev, [feature]: cur }
    })
  }, [])

  /* ── Render mode options ── */
  const specs = schema ? buildSpecs(schema) : null
  const spec = specs?.[featureKey] ?? []
  const optsFor = opts[featureKey] ?? {}
  const visibleSpec = spec.filter((c) => (c.hiddenIf ? !c.hiddenIf(optsFor) : true))
  /* (fix 137) "Encoding" block removed — all visible controls go into mode. */
  const modeControls = visibleSpec

  const renderControl = (c: Control) => {
    if (c.kind === 'select') {
      return (
        <OptSelect
          key={c.key}
          label={c.label}
          items={c.items ?? []}
          value={(optsFor[c.key] as string | number) ?? ''}
          onChange={(v) => setOptValue(featureKey, c.key, v)}
        />
      )
    }
    if (c.kind === 'toggle') {
      return (
        <OptToggle
          key={c.key}
          label={c.label}
          checked={!!optsFor[c.key]}
          onChange={(v) => setOptValue(featureKey, c.key, v)}
        />
      )
    }
    if (c.kind === 'number') {
      return (
        <OptNumber
          key={c.key}
          label={c.label}
          value={(optsFor[c.key] as number) ?? (c.min ?? 0)}
          min={c.min ?? 0}
          max={c.max ?? 16384}
          step={c.step ?? 1}
          int={c.int}
          onChange={(v) => setOptValue(featureKey, c.key, v)}
        />
      )
    }
    return (
      <SettingSlider
        key={c.key}
        label={c.label}
        value={(optsFor[c.key] as number) ?? (c.min ?? 0)}
        min={c.min ?? 0}
        max={c.max ?? 100}
        step={c.step ?? 0.05}
        onChange={(v) => setOptValue(featureKey, c.key, v)}
        formatValue={(v) => (v >= 100 ? String(Math.round(v)) : v.toFixed(2).replace(/\.?0+$/, ''))}
      />
    )
  }

  /* (fix 77) Collapsible block header (template as in Pass1/Pass2). */
  const collapseHeader = (title: string, open: boolean, onToggle: () => void) => (
    <button
      type="button"
      onClick={onToggle}
      className="w-full flex items-center justify-between px-3 py-1.5 rounded-md bg-[var(--surface-3)] border border-border/60 hover:border-violet-500/30 transition-all text-left"
    >
      <span className="text-xs font-medium text-muted-foreground">{title}</span>
      <span className={cn('text-[10px] text-muted-foreground transition-transform', open && 'rotate-180')}>▼</span>
    </button>
  )

  /* ───────────────────────────────────────────────────────────── */

  return (
    <div className="flex-1 flex min-h-0">
      {/* LEFT: parameter panel (same as in "Generate" tab; fix 472 — surface-1 background, like Refine/Tile/FPS) */}
      <div className="w-[400px] shrink-0 border-r border-border flex flex-col bg-[var(--surface-1)]">
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Header */}
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">Parameters</h2>
            <Badge className="text-[10px] bg-violet-500/15 text-violet-400 border-violet-500/30 hover:bg-violet-500/15">
              DLSS 5
            </Badge>
          </div>

          <Separator className="bg-border opacity-50" />

          {/* Service — always visible, non-collapsible */}
          <div
            className="space-y-2"
            title="Service starts automatically. First run takes 2–3 minutes. Works only on NVIDIA RTX GPUs (20/30/40/50 series)."
          >
            <div className="flex items-center justify-between gap-2">
              {disabled ? (
                <span className="text-xs font-medium text-red-300">Tab disabled</span>
              ) : svcRunning ? (
                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-300">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" /> service running
                </span>
              ) : svcStarting ? (
                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-300">
                  <Loader2Icon className="w-3 h-3 animate-spin" /> starting…
                </span>
              ) : (
                <span className="text-xs text-muted-foreground">service stopped</span>
              )}
              <div className="flex items-center gap-1.5 shrink-0">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void start()}
                  disabled={svcRunning || svcStarting || disabled || startBusy}
                  title="Start / reconnect DLSS bridge"
                >
                  <RefreshCwIcon className={cn((svcStarting || startBusy) && 'animate-spin')} />
                  Start
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => void stop()}
                  disabled={(!svcRunning && !svcStarting) || isBusy}
                  title={isBusy ? 'Wait for processing to finish or cancel it' : 'Stop DLSS bridge'}
                >
                  <PowerOffIcon className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>

            {/* (fix 77) Live bridge log tail line during startup. */}
            {(svcStarting || startBusy) && (
              <p className="text-xs text-amber-300/80 flex items-start gap-1.5 min-w-0">
                <Loader2Icon className="w-3.5 h-3.5 shrink-0 animate-spin" />
                <span className="truncate" title={startLog ?? undefined}>
                  {startLog ?? 'Preparing DLSS runtime…'}
                </span>
              </p>
            )}

            {svcError && (
              <p className="text-xs text-red-300 break-words flex items-start gap-1.5">
                <AlertTriangleIcon className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span className="break-words">{svcError}</span>
              </p>
            )}

            <div className="flex flex-wrap gap-1.5">
              {svcRunning && runtimeReady && (
                <Badge className="bg-violet-500/10 text-violet-300 border-violet-500/30 text-[10px]">
                  runtime ready
                </Badge>
              )}
              {svcRunning && !runtimeReady && runtimeError && (
                <Badge variant="destructive" className="max-w-full text-[10px] truncate" title={runtimeError}>
                  <AlertTriangleIcon className="w-3 h-3" /> {runtimeError}
                </Badge>
              )}
              {svcRunning && !runtimeReady && !runtimeError && (
                <Badge className="bg-amber-500/10 text-amber-300 border-amber-500/30 text-[10px]">
                  <Loader2Icon className="w-3 h-3 animate-spin" /> preparing runtime…
                </Badge>
              )}
              {gpus.length > 0 && (
                <Badge variant="secondary" className="font-mono text-[10px]">
                  GPU: {gpus.map((g) => g.label).join(' + ')}
                </Badge>
              )}
            </div>
          </div>

          <Separator className="bg-border opacity-50" />

          {/* (fix 77) Collapsible block: mode parameters */}
          <div className="space-y-1.5">
            {collapseHeader(
              `${tab === 'nr' ? 'Neural Rendering' : 'RTX VSR'} — parameters`,
              showMode,
              () => setShowMode(!showMode),
            )}
            {showMode && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                className="space-y-3 pl-1 overflow-hidden"
              >
                {!schema ? (
                  <p className="text-xs text-muted-foreground/70 flex items-center gap-1.5">
                    <Loader2Icon className="w-3 h-3 animate-spin" />
                    {svcStarting ? 'starting service…' : 'waiting for parameter schema…'}
                  </p>
                ) : modeControls.length > 0 ? (
                  <div className="space-y-3">{modeControls.map(renderControl)}</div>
                ) : (
                  <p className="text-xs text-muted-foreground/70">
                    Parameter schema will appear once service is running.
                  </p>
                )}
              </motion.div>
            )}
          </div>

        </div>

        {/* Pinned block: job status (analogous to GenerationStatus).
            Not shown in idle (no job) — instructions moved to tooltip
            of "Processing Mode" label. */}
        {(isBusy || job) && (
        <div className="shrink-0 border-t border-border p-3 bg-[var(--surface-1)]/90 backdrop-blur-sm">
          {/* (fix 475) status/preview panel — surface-1, matching settings panel color */}
          {isBusy ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-violet-300 inline-flex items-center gap-1.5">
                  <Loader2Icon className="w-3.5 h-3.5 animate-spin" />
                  {job?.status === 'queued' ? 'Queued…' : 'Processing…'}
                </span>
                <span className="text-muted-foreground font-mono tabular-nums">
                  {Math.round((job?.progress ?? 0) * 100)}%
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted-foreground/20">
                <div
                  className="h-full rounded-full transition-all duration-500 gradient-creative"
                  style={{ width: `${Math.round((job?.progress ?? 0) * 100)}%` }}
                />
              </div>
              {job?.message && (
                <p className="text-xs text-muted-foreground truncate" title={job.message}>
                  {job.message}
                </p>
              )}
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] text-muted-foreground/60">GPU busy — please wait</span>
                <Button variant="outline" size="sm" onClick={() => cancel()} disabled={cancelBusy}>
                  <SquareIcon />
                  {cancelBusy ? 'Cancelling…' : 'Cancel'}
                </Button>
              </div>
            </div>
          ) : job?.status === 'done' ? (
            <div className="space-y-1.5">
              <div className="flex items-center gap-2 text-sm font-medium text-emerald-300">
                <CheckCircle2Icon className="w-4 h-4" /> Done
              </div>
              {/* (fix 77) Download removed: result in shared gallery. */}
              <p className="text-[10px] text-muted-foreground/60">
                Result added to shared gallery on the right.
              </p>
            </div>
          ) : job?.status === 'error' ? (
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-sm font-medium text-red-300">
                <AlertTriangleIcon className="w-4 h-4" /> Error
              </div>
              <p className="text-xs text-red-300/80 break-words">{job.error}</p>
            </div>
          ) : job?.status === 'cancelled' ? (
            <p className="text-xs text-muted-foreground">Processing cancelled.</p>
          ) : null}
        </div>
        )}
      </div>

      {/* RIGHT: mode + file + CTA, bottom — shared gallery */}
      <div className="flex-1 flex flex-col min-w-0 bg-[var(--surface-1)]">
        {/* Card — processing mode + upload + CTA (analogous to prompt card) */}
        <div className="p-5 pb-3 space-y-3 aurora-bg overflow-hidden flex flex-col shrink-0">
          <div className="flex items-center justify-between shrink-0">
            <Label
              className="text-sm font-medium text-foreground flex items-center gap-2"
              title="Upload a video, choose a mode and click 'Start'. The result will appear in the shared gallery on the right."
            >
              <SparklesIcon className="w-4 h-4 text-violet-400" />
              Processing Mode
            </Label>
            <span className="text-[10px] text-muted-foreground/70 hidden sm:block">
              DLSS 5 · video only · NVIDIA RTX (20/30/40/50)
            </span>
          </div>

          {disabled && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300 flex items-center gap-2">
              <AlertTriangleIcon className="w-3.5 h-3.5 shrink-0" />
              Tab disabled: config.ini → [upscale] enabled=1
            </div>
          )}

          {/* Mode selection (replaces prompt) */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => setTab(m.id)}
                className={cn(
                  'rounded-lg border px-3 py-2.5 text-left transition-colors',
                  tab === m.id
                    ? 'border-violet-500/60 bg-violet-500/10'
                    : 'border-input bg-[var(--surface-2)]/50 hover:bg-accent/50',
                )}
              >
                <div className={cn('text-sm font-medium', tab === m.id ? 'text-violet-200' : 'text-foreground/90')}>
                  {m.label}
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">{m.hint}</div>
              </button>
            ))}
          </div>

          {/* Upload (video-only) */}
          <div
            onDragOver={(e) => {
              e.preventDefault()
              if (!uploading && !isBusy) setDragOver(true)
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            className={cn(
              'rounded-xl border border-dashed p-4 transition-colors',
              dragOver ? 'border-violet-500 bg-violet-500/10' : 'border-input',
            )}
          >
            {!file ? (
              <div className="flex flex-col items-center gap-2 py-3">
                <UploadCloudIcon className="w-8 h-8 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  Drag video here — or directly from a gallery thumbnail — or{' '}
                  <button
                    type="button"
                    className="text-violet-300 underline underline-offset-2 hover:text-violet-200"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading || isBusy}
                  >
                    choose a file
                  </button>{' '}
                  (MP4 / MOV / MKV / AVI / WEBM…)
                </p>
                <div className="flex items-center gap-2">
                  <Button size="sm" onClick={() => fileInputRef.current?.click()} disabled={uploading || isBusy}>
                    <UploadCloudIcon />
                    {uploading ? 'Uploading…' : 'Choose Video'}
                  </Button>
                </div>
                {uploading && (
                  <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                    <Loader2Icon className="w-3 h-3 animate-spin" /> Transferring to service… (large videos may take a minute)
                  </p>
                )}
              </div>
            ) : (
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2">
                    {/* (fix 719) Click on file name — open fullscreen (as in "Generate" tab). */}
                    <RefPreviewThumb
                      kind={file.kind === 'image' ? 'image' : 'video'}
                      name={file.name}
                      path={file.path}
                      url={`/api/upscale/file?path=${encodeURIComponent(file.path)}`}
                      className="flex items-center gap-2 text-left min-w-0 group"
                      title="Open file fullscreen"
                    >
                      <FileVideoIcon className="w-4 h-4 text-violet-300 shrink-0" />
                      <span className="text-sm font-medium truncate group-hover:underline">
                        {file.name}
                      </span>
                    </RefPreviewThumb>
                  </div>
                  <div className="text-xs text-muted-foreground flex flex-wrap gap-x-3 gap-y-0.5">
                    <span>{humanBytes(file.size)}</span>
                    {probe?.width && probe?.height && <span>{probe.width}×{probe.height}</span>}
                    {probe?.fps && <span>{Number(probe.fps).toFixed(2).replace(/\.?0+$/, '')} fps</span>}
                    {probe && probe.duration ? <span>{humanDuration(probe.duration)}</span> : null}
                    {probe?.frames && <span>{probe.frames} frames</span>}
                    {probe?.codec && <span className="font-mono">{probe.codec}</span>}
                    {probe?.hdr ? <span className="text-amber-300">HDR</span> : null}
                    {/* (fix 727) Output destination: source folder. */}
                    <span className="text-violet-300/90">
                      Output: {file.subfolder ? `folder "${file.subfolder}"` : 'root folder'}
                    </span>
                  </div>
                  {upscaleBlocked && (
                    <p className="text-xs text-amber-300/90 flex items-center gap-1.5">
                      <AlertTriangleIcon className="w-3 h-3 shrink-0" />
                      Source is already 4K or above — upscale only enlarges, launch is blocked
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading || isBusy}
                  >
                    Change
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setFile(null)
                      setProbe(null)
                    }}
                    disabled={isBusy}
                  >
                    <XIcon />
                  </Button>
                </div>
              </div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept={VIDEO_EXTS}
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void doUpload(f)
                e.target.value = ''
              }}
            />
          </div>

          {/* CTA row */}
          <div className="flex items-center gap-3">
            <div className="flex flex-wrap items-center gap-1.5 flex-1 min-w-0">
              {file && (
                <Badge variant="secondary" className="text-[10px] max-w-[280px] truncate" title={file.name}>
                  {file.name} · {humanBytes(file.size)}
                </Badge>
              )}
              {svcRunning && runtimeReady && (
                <Badge className="bg-violet-500/10 text-violet-300 border-violet-500/30 text-[10px]">
                  ready
                </Badge>
              )}
              {svcRunning && !runtimeReady && (
                <Badge className="bg-amber-500/10 text-amber-300 border-amber-500/30 text-[10px]">
                  <Loader2Icon className="w-3 h-3 animate-spin" /> waiting for DLSS runtime…
                </Badge>
              )}
              {!svcRunning && !disabled && (
                <Badge variant="secondary" className="text-[10px]">
                  service stopped
                </Badge>
              )}
            </div>
            <Button
              onClick={() => void run()}
              disabled={!canRun}
              title={
                isBusy
                  ? 'Processing in progress'
                  : upscaleBlocked
                    ? `Source ${probe!.width}×${probe!.height} is already 4K or above — upscale only enlarges, launch is blocked`
                    : file
                      ? 'Start processing (DLSS 5)'
                      : 'Upload a video first'
              }
              className="h-11 px-6 bg-gradient-to-r from-violet-500 to-fuchsia-600 hover:from-violet-400 hover:to-fuchsia-500 text-white border-0 text-sm font-semibold shadow-lg shadow-violet-500/20"
            >
              {isBusy ? <Loader2Icon className="w-4 h-4 animate-spin" /> : <PlayIcon className="w-4 h-4" />}
              {isBusy ? 'Add to Queue' : 'Start'}
            </Button>
          </div>
        </div>

        {/* Results — SHARED gallery (same as in "Generate" and "Gallery") */}
        <div className="flex-1 overflow-y-auto px-5 pb-5 min-h-0">
          <VideoGalleryGrid
            files={galleryFiles}
            loading={galleryLoading}
            onRefresh={loadGallery}
            onDeleteFile={deleteFile}
            emptyHint="Generated and upscaled videos will appear here. Choose a mode, upload a video, and click 'Start'."
          />
        </div>
      </div>
    </div>
  )
}
