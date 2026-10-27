'use client'

/**
 * GenerateView — the main screen of MiniMax H3 Studio.
 *
 * Left panel: generation parameters (resolution, duration, references,
 * advanced two-pass settings) with the pinned generation status card.
 * Right panel: prompt card with the CTA button and the results gallery.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import {
  AudioLinesIcon,
  ChevronDownIcon,
  FilmIcon,
  FolderIcon,
  HistoryIcon,
  ImageIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  StarIcon,
  UploadIcon,
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
import { SettingSlider } from './setting-slider'
import { useVideoGen, computeOutputDimensions } from '@/hooks/use-video-gen'

import { useModelOptions } from '@/hooks/use-model-options'
import { useGenProgress } from '@/lib/gen-progress-store'
import { cn } from '@/lib/utils'
import { useGenStore, type VideoRefItem } from '@/lib/gen-store'
import {
  DurationSlider,
  SeedBlock,
  buildPresets,
  parseResolution,
  resolveResolution,
  uploadInputFile,
} from './video-shared'
import { MentionTextarea, type MentionItem } from './mention-textarea'
import { VoiceInputButton } from './voice-input-button'
import { PromptEditorDialog, PromptEditButton, PromptFixButton, PromptClearButton, PromptFixDialog, PromptFieldTools } from './prompt-editor-dialog'
import { requestImprovePrompt } from '@/hooks/use-improve-prompt' // (edit 691) 'Fix' directly from the field
import { PromptQuality } from './prompt-quality'
import { EXAMPLES } from './learn/prompt-guide'
import { usePromptHistory } from '@/lib/prompt-history-store'
import { isStreamActive } from '@/lib/assistant-stream'
import { getClipboardImageFiles, getClipboardImageFromApi, hasClipboardImage } from '@/lib/paste-utils'
import { VideoGalleryGrid } from './video-gallery-grid'
import { GenerationStatus } from './generation-status'
// (edit 719) Shared preview component with full-screen view —
// used across all tabs (Generate/Extend/Refine/ControlNet/...).
import { RefPreviewThumb } from './ref-preview-thumb'
import { useVideoGallery } from './use-video-gallery'
import { AssistantPanel } from './assistant/assistant-panel' // (edit 442) assistant — right side panel of the tab

/* ──────────────── Constants ──────────────── */

const FALLBACK_REF_LIMITS = { image: 9, video: 3, audio: 3, total: 15 }

/* (edit 449) The "audio intent" selector (Voice/Tempo/Style) was removed: it did not
   affect the workflow at all (all audios mapped to identical ref_audio_N) — it was only
   a hint for the assistant and a string in metadata. */

/* Sampler labels for both passes (order matches VALID_KSAMPLERS) */
const SAMPLER_OPTIONS = [
  { value: 'euler', label: 'euler (default, classic)' },
  { value: 'er_sde', label: 'er_sde (SDE)' },
  { value: 'dpmpp_2m', label: 'dpmpp_2m (multistep)' },
  { value: 'dpmpp_3m_sde', label: 'dpmpp_3m_sde (high quality)' },
  { value: 'heun', label: 'heun (2nd order)' },
  { value: 'lcm', label: 'lcm (few steps)' },
  { value: 'res_multistep', label: 'res_multistep (residual)' },
]

/* Scheduler labels for pass 1 (order matches PASS1_SCHEDULERS) */
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

const KIND_META: Record<
  VideoRefItem['kind'],
  { label: string; tag: string; icon: typeof ImageIcon; color: string }
> = {
  image: { label: 'Image', tag: 'Picture', icon: ImageIcon, color: 'text-purple-400 bg-purple-500/15' },
  video: { label: 'Video', tag: 'Video', icon: FilmIcon, color: 'text-cyan-400 bg-cyan-500/15' },
  audio: { label: 'Audio', tag: 'Audio', icon: AudioLinesIcon, color: 'text-emerald-400 bg-emerald-500/15' },
}

function detectKind(name: string): VideoRefItem['kind'] | null {
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase()
  if (['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff'].includes(ext)) return 'image'
  if (['.avi', '.m4v', '.mkv', '.mov', '.mp4', '.webm'].includes(ext)) return 'video'
  if (['.aac', '.flac', '.m4a', '.mp3', '.ogg', '.wav'].includes(ext)) return 'audio'
  return null
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
}

/* (edit 146) Audio references in "Text" / "Frames" modes: MiniMaxH3ImageToVideo node
 * has no audio inputs — audio is passed through MiniMaxH3AddGuide on the server,
 * in the UI it is simply an audio upload zone. */
function AudioRefsBlock({
  onPick,
  dragOver,
  setDragOver,
  onDropFiles,
  uploading,
  counts,
  hint,
}: {
  onPick: () => void
  dragOver: boolean
  setDragOver: (v: boolean) => void
  onDropFiles: (files: File[]) => void
  uploading: boolean
  counts: string
  hint: string
}) {
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        onDropFiles(Array.from(e.dataTransfer.files))
      }}
      onClick={onPick}
      className={cn(
        'border-2 border-dashed rounded-lg py-3 text-center cursor-pointer transition-all',
        dragOver ? 'border-cyan-400 bg-cyan-500/10' : 'border-border hover:border-cyan-500/50 hover:bg-[var(--surface-2)]',
      )}
    >
      {uploading ? (
        <p className="text-xs text-cyan-400">Uploading audio...</p>
      ) : (
        <>
          <AudioLinesIcon className="w-4 h-4 text-muted-foreground mx-auto mb-1" />
          <p className="text-xs text-muted-foreground">
            Audio references <span className="text-[10px] text-muted-foreground/60">({counts})</span>
          </p>
          <p className="text-[10px] text-muted-foreground/60 mt-0.5">{hint}</p>
        </>
      )}
    </div>
  )
}

/** Reference tag in prompt: <Picture N> / <Video N> / <Audio N>. */
function refTag(kind: VideoRefItem['kind'], n: number): string {
  const tag = kind === 'image' ? 'Picture' : kind === 'video' ? 'Video' : 'Audio'
  return `<${tag} ${n}>`
}

/** refId → current tag, numbering by type in list order (same as in mentions). */
function tagsForRefs(refs: VideoRefItem[]): Map<string, string> {
  const counters: Record<'image' | 'video' | 'audio', number> = { image: 0, video: 0, audio: 0 }
  const map = new Map<string, string>()
  for (const r of refs) map.set(r.id, refTag(r.kind, ++counters[r.kind]))
  return map
}

/**
 * Rewrites reference tags in prompt to match new list order:
 * tags of removed references are deleted, others are renumbered.
 * Intermediate placeholders prevent collisions during renumbering
 * (e.g. swap <Video 1> ↔ <Video 2>).
 */
function rewritePromptTags(
  prompt: string,
  oldTags: Map<string, string>,
  newTags: Map<string, string>,
): string {
  let any = false
  for (const t of oldTags.values()) {
    if (prompt.includes(t)) { any = true; break }
  }
  if (!any) return prompt
  let text = prompt
  for (const [id, oldTag] of oldTags) {
    const next = newTags.get(id)
    // Removed reference: its tag is stripped completely from prompt
    text = text.split(oldTag).join(next ? `\x00${id}\x00` : '')
  }
  for (const [id, tag] of newTags) {
    text = text.split(`\x00${id}\x00`).join(tag)
  }
  return text
}

/* ──────────────── Component ──────────────── */

export function GenerateView() {
  const { phase, error, progressValue, progressMax, statusMessage, promptId, generate, interrupt, reset } = useVideoGen()
  const videoStartedAt = useGenProgress((s) => s.video.startedAt)

  const video = useGenStore((s) => s.video)
  const setResolution = useGenStore((s) => s.setVideoResolution)
  const addRefs = useGenStore((s) => s.addVideoRefs)
  const updateRef = useGenStore((s) => s.updateVideoRef)
  const removeRef = useGenStore((s) => s.removeVideoRef)
  const moveRef = useGenStore((s) => s.moveVideoRef)
  const patchVideo = useGenStore((s) => s.patchVideo)
  const setPrompt = useGenStore((s) => s.setVideoPrompt)
  // (edit 146) first/last frame slots ('Frames' mode)
  const setVideoStartFrame = useGenStore((s) => s.setVideoStartFrame)
  const setVideoEndFrame = useGenStore((s) => s.setVideoEndFrame)

  const isGenerating = phase === 'submitting' || phase === 'queued' || phase === 'running'

  /* ──────────── Models & options ──────────── */

  const { options } = useModelOptions(video.modelType || null)

  /* ──────────── Derived params ──────────── */

  const fps = (options?.fps as number) || 24
  // Honest model bounds: the backend silently clamps anything below
  // frames_minimum back up — that's how a "2 s" request produced a 5 s clip.
  // (edit 131) fallback 124 → 42: minimum now ~2 s (42 frames at 24 fps).
  // (edit 138) fallback 42 → 60: minimum 2.5 s (60 frames), 1.75 s removed.
  const framesMin = (options?.frames_minimum as number) || 60
  // (edit 59) max increased to 30 s (719 frames) — model actually generates long clips
  const framesMax = (options?.frames_maximum as number) || 719
  const framesStep = (options?.frames_steps as number) || 17

  const refLimits = (options?.omni_reference_limits as typeof FALLBACK_REF_LIMITS | null) ?? FALLBACK_REF_LIMITS

  const presets = useMemo(() => buildPresets(options, true), [options])

  const refCounts = useMemo(() => {
    const counts = { image: 0, video: 0, audio: 0 }
    for (const r of video.refs) counts[r.kind]++
    return counts
  }, [video.refs])

  /* ──────────── Reference uploads ──────────── */

  const [uploadingRefs, setUploadingRefs] = useState(false)
  const refsInputRef = useRef<HTMLInputElement>(null)
  const [refsDragOver, setRefsDragOver] = useState(false)
  // (edit 146) 'Frames'/'Text' modes: hidden inputs for frames and audio
  const frameInputRef = useRef<HTMLInputElement>(null)
  const audioOnlyInputRef = useRef<HTMLInputElement>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [showPass1, setShowPass1] = useState(false)
  const [showPass2, setShowPass2] = useState(false)

  /** Free resolution: disable quality presets and set MP directly. */
  const toggleFreeResolution = () => {
    const next = !video.freeResolution
    if (next) {
      if (!(video.finalResolution > 0)) {
        // Initialize MP from current preset so slider is meaningful.
        const m = video.resolution.match(/(\d+)\s*x\s*(\d+)/i)
        const mp = m
          ? Math.round((parseInt(m[1], 10) * parseInt(m[2], 10) / 1e6) * 100) / 100
          : 0.7
        patchVideo({ freeResolution: true, finalResolution: mp })
      } else {
        patchVideo({ freeResolution: true })
      }
      return
    }
    // Turn off free resolution → reset finalResolution to 0
    // (0 = 'take from quality preset'), otherwise remaining MP overrides preset.
    patchVideo({ freeResolution: false, finalResolution: 0 })
  }
  // (edit 719) Reference preview moved to shared RefPreviewThumb component
  // (each preview has its own viewer), so global viewingRef/viewingRefId state
  // is no longer needed here.
  // Persisted stores (history) may differ on first client render vs SSR —
  // mount-gate their DOM to avoid hydration mismatch (React #418).
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const addReferenceFiles = useCallback(
    async (files: File[]) => {
      if (!files.length) return
      // (edit 146) In 'Text'/'Frames' modes, image and video references are not
      // supported by the node — they could only get here by paste/drop outside
      // specialized fields; reject honestly.
      const mode = useGenStore.getState().video.mode
      if (mode !== 'ref') {
        const nonAudio = files.find((f) => detectKind(f.name) !== 'audio')
        if (nonAudio) {
          toast.error(mode === 't2v' ? 'In "Text" mode, images and videos are not used' : 'In "Frames" mode, images are set via "First/Last Frame" fields')
        }
        files = files.filter((f) => detectKind(f.name) === 'audio')
        if (!files.length) return
      }
      // Calculate limits from CURRENT store state: refCounts from render closure
      // goes stale during overlapping calls (paste + file picker at the same time)
      // — both would pass checks and exceed limit.
      const current = useGenStore.getState().video.refs
      const liveCounts: Record<string, number> = { image: 0, video: 0, audio: 0 }
      for (const r of current) liveCounts[r.kind] = (liveCounts[r.kind] ?? 0) + 1
      let img = liveCounts.image
      let vid = liveCounts.video
      let aud = liveCounts.audio
      const accepted: File[] = []
      for (const file of files) {
        const kind = detectKind(file.name)
        if (!kind) {
          toast.error(`Unsupported file: ${file.name}`)
          continue
        }
        if (kind === 'image' && ++img > refLimits.image) { toast.error(`Maximum ${refLimits.image} image references`); img--; continue }
        if (kind === 'video' && ++vid > refLimits.video) { toast.error(`Maximum ${refLimits.video} video references`); vid--; continue }
        if (kind === 'audio' && ++aud > refLimits.audio) { toast.error(`Maximum ${refLimits.audio} audio references`); aud--; continue }
        if (current.length + accepted.length >= refLimits.total) { toast.error(`Maximum ${refLimits.total} references total`); break }
        accepted.push(file)
      }
      if (!accepted.length) return

      setUploadingRefs(true)
      const items: VideoRefItem[] = []
      let anyStaged = false
      for (const file of accepted) {
        try {
          const { path, staged } = await uploadInputFile(file)
          if (staged) anyStaged = true
          items.push({
            id: newId(),
            kind: detectKind(file.name)!,
            path,
            name: file.name,
            previewUrl: URL.createObjectURL(file),
            role: '',
            imageIntent: 'identity',
            includeAudio: true,
            compress: false, // (edit 493)
          })
        } catch (err) {
          toast.error(err instanceof Error ? err.message : String(err))
        }
      }
      setUploadingRefs(false)
      if (items.length) {
        // Double check BEFORE inserting: during upload a parallel call
        // might have taken up the limit — clamp rather than push over.
        const nowRefs = useGenStore.getState().video.refs
        const room = Math.max(0, refLimits.total - nowRefs.length)
        if (items.length > room) {
          toast.error(`Maximum ${refLimits.total} references total`)
          items.length = room
        }
        if (items.length) addRefs(items)
      }
      if (anyStaged) {
        toast.info('ComfyUI unavailable — references saved locally', {
          description: 'They will be automatically sent to ComfyUI upon generation.',
        })
      }
    },
    [addRefs, refLimits],
  )

  /* (edit 146) Load frame into 'Frames' mode slot: same uploadInputFile
   * as references (including staged fallback when ComfyUI is down).
   * (edit 152) Get image dimensions for aspect ratio. */
  const addFrameFile = useCallback(async (file: File, slot: 'start' | 'end') => {
    if (detectKind(file.name) !== 'image') {
      toast.error('First/last frame must be an image')
      return
    }
    setUploadingRefs(true)
    try {
      const { path, staged } = await uploadInputFile(file)
      // (edit 152) Get image dimensions (for aspect ratio in flf mode)
      const previewUrl = URL.createObjectURL(file)
      const dims = await new Promise<{ w: number; h: number } | null>((resolve) => {
        const img = new Image()
        img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight })
        img.onerror = () => resolve(null)
        img.src = previewUrl
      })
      const item = {
        path,
        name: file.name,
        previewUrl,
        width: dims?.w,
        height: dims?.h,
      }
      if (slot === 'start') setVideoStartFrame(item)
      else setVideoEndFrame(item)
      if (staged) {
        toast.info('ComfyUI unavailable — frame saved locally', {
          description: 'It will be automatically sent to ComfyUI upon generation.',
        })
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setUploadingRefs(false)
    }
  }, [setVideoStartFrame, setVideoEndFrame])

  /* (edit 146) Audio references in 'Text'/'Frames' modes — filtered
   * pass through the shared reference uploader. */
  const addAudioOnlyFiles = useCallback((files: File[]) => {
    const audio = files.filter((f) => detectKind(f.name) === 'audio')
    const rejected = files.length - audio.length
    if (rejected > 0) toast.error(`Audio only — ${rejected} file(s) rejected`)
    if (audio.length) void addReferenceFiles(audio)
  }, [addReferenceFiles])



  /* ──────────── Ctrl+V → reference anywhere on tab (edit 125) ────────────
   * (edit 123) attached onPaste to tab root, but browser sends `paste` ONLY
   * to focused element (event bubbles up): if focus is on body or button,
   * it never reached root onPaste, and paste only 'worked' after clicking
   * reference panel (where click focuses hidden file input).
   *
   * Now listen globally while tab is mounted:
   *  1) `paste` on document (capture) — catch paste on any focus inside doc;
   *  2) `keydown` Ctrl/Cmd+V on window (capture) — fallback via navigator.clipboard.read().
   * Do NOT touch text from clipboard — intercept only if image.
   * Deduplication: both branches can fire on the same Ctrl+V.
   */
  const lastRefPasteAt = useRef(0)
  useEffect(() => {
    const DEDUP_MS = 2000
    const tryAddFiles = (files: File[], viaPasteEvent: boolean): boolean => {
      const now = Date.now()
      if (now - lastRefPasteAt.current < DEDUP_MS) return false
      lastRefPasteAt.current = now
      if (!viaPasteEvent && files.length === 0) return false
      void addReferenceFiles(files)
      return true
    }

    // (edit 587) Intercept only non-targeted pastes: if paste/keydown happened
    // INSIDE an editable field (assistant chat, prompt textarea, input),
    // event belongs to it — capture phase + stopPropagation previously stole image from chat onPaste.
    const isEditableTarget = (t: EventTarget | null): boolean => {
      if (!(t instanceof HTMLElement)) return false
      if (t.isContentEditable) return true
      const tag = t.tagName
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
    }

    const onPaste = (e: ClipboardEvent) => {
      if (e.defaultPrevented) return
      if (isEditableTarget(e.target)) return // input field will handle itself
      if (!hasClipboardImage(e.clipboardData)) return
      // Synchronously before any await
      e.preventDefault()
      e.stopPropagation()
      const files = getClipboardImageFiles(e.clipboardData).then((list) => {
        // Timestamp set here synchronously in microtask to prevent keydown duplicate
        lastRefPasteAt.current = Date.now()
        if (list.length > 0) void addReferenceFiles(list)
      })
      void files
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'v') {
        if (isEditableTarget(e.target)) return // Ctrl+V in input field — ignore
        void (async () => {
          // Allow normal paste event to try first
          const file = await getClipboardImageFromApi()
          if (!file) return // no image in clipboard — normal text paste
          tryAddFiles([file], false)
        })()
      }
    }

    document.addEventListener('paste', onPaste, true)
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('paste', onPaste, true)
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [addReferenceFiles])

  /* ──────────── Prompt mentions (from refs) ──────────── */

  const mentions: MentionItem[] = useMemo(() => {
    // Trigger numbering runs SEPARATELY for each reference type
    // (Picture N / Video N / Audio N), not a single combined counter.
    const counters: Record<'image' | 'video' | 'audio', number> = { image: 0, video: 0, audio: 0 }
    return video.refs.map((ref) => {
      const tag = ref.kind === 'image' ? 'Picture' : ref.kind === 'video' ? 'Video' : 'Audio'
      counters[ref.kind] += 1
      return {
        id: ref.id,
        label: ref.name,
        trigger: `<${tag} ${counters[ref.kind]}>`,
        kind: ref.kind,
        color:
          ref.kind === 'image'
            ? 'bg-purple-500/15 text-purple-400'
            : ref.kind === 'video'
              ? 'bg-cyan-500/15 text-cyan-400'
              : 'bg-emerald-500/15 text-emerald-400',
        // Live blob preview while in-session; server URL after a reload
        previewUrl:
          ref.previewUrl ||
          (ref.path
            ? `/api/comfy/file?filename=${encodeURIComponent(ref.path)}&type=input`
            : undefined),
      }
    })
  }, [video.refs])

  const [promptEditorOpen, setPromptEditorOpen] = useState(false)

  // (edit 691) 'Improve prompt' directly from field: dialog 'what to change'
  // + prompt sent to assistant generate chat (requestImprovePrompt).
  const [fixOpen, setFixOpen] = useState(false)

  /* ──────────── Prompt history & examples ──────────── */

  const [historyOpen, setHistoryOpen] = useState(false)
  const [examplesOpen, setExamplesOpen] = useState(false)
  const historyBtnRef = useRef<HTMLButtonElement>(null)
  const examplesBtnRef = useRef<HTMLButtonElement>(null)
  const historyEntries = usePromptHistory((s) => s.entries)
  const toggleHistoryFavorite = usePromptHistory((s) => s.toggleFavorite)
  const removeHistoryEntry = usePromptHistory((s) => s.remove)
  const clearHistory = usePromptHistory((s) => s.clear)

  /** Position a portal dropdown under its anchor button (clamped to viewport). */
  const dropdownPos = (anchor: HTMLElement): React.CSSProperties => {
    const r = anchor.getBoundingClientRect()
    const width = 340
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8))
    const top = Math.min(r.bottom + 6, window.innerHeight - 80)
    return { top, left, width }
  }

  const applyExample = useCallback(
    (text: string) => {
      const old = video.prompt
      setPrompt(text)
      setExamplesOpen(false)
      if (old.trim()) {
        toast.success('Example applied (previous prompt replaced)', {
          action: { label: 'Undo', onClick: () => setPrompt(old) },
        })
      }
    },
    [video.prompt, setPrompt],
  )

  /* ──────────── Gallery ──────────── */

  const { files: galleryFiles, folders: galleryFolders, loading: galleryLoading, load: loadGallery, deleteFile } = useVideoGallery({ phase })

  /* (edit 91) Active project folder: tab gallery is filtered by it,
   * new videos are saved into it. '' = root folder.
   * (edit 495) Nested folders: filter includes subfolder contents
   * (prefix path match 'a/b'). */
  const outputFolder = video.outputFolder || ''
  const [folderMenuOpen, setFolderMenuOpen] = useState(false)
  const visibleGalleryFiles = useMemo(
    () => galleryFiles.filter((f) => {
      const sub = f.subfolder || ''
      return outputFolder === '' ? sub === '' : sub === outputFolder || sub.startsWith(outputFolder + '/')
    }),
    [galleryFiles, outputFolder],
  )

  /* ──────────── Generation ──────────── */

  const canGenerate = Boolean(video.prompt.trim())

  /** Assistant is loading or replying — generation is locked (vram-arbiter). */
  const [assistantBusy, setAssistantBusy] = useState(false)

  // (edit 110) Fallback against stale lock: if server streaming counter leaks
  // (stuck drain pump), button would hang disabled FOREVER. Seeing busy >60 s
  // with no active stream IN THIS TAB, forcibly release lock on server
  // (fresh lock — stream really running — server won't touch).
  const firstBusyAtRef = useRef<number | null>(null)
  const lockReleasedRef = useRef(false)

  // Lightweight poll of LLM status — only if assistant was used in this
  // session (otherwise requests are not needed: LLM was never launched).
  useEffect(() => {
    if (sessionStorage.getItem('assistantUsed') !== '1') return
    let stopped = false
    const tick = async () => {
      try {
        const r = await fetch('/api/llm/status', { signal: AbortSignal.timeout(4000) })
        const s = (await r.json()) as { assistantBusy?: boolean }
        if (stopped) return
        const busy = s.assistantBusy === true
        // (edit 110) after forced release — do not block locally;
        // real gate is 409 from runGeneration. If stream active in this tab — block.
        // (edit 161) If stream not active — busy lock is stale.
        const override = !isStreamActive()
        setAssistantBusy(busy && !override)
        if (busy) {
          if (firstBusyAtRef.current === null) firstBusyAtRef.current = Date.now()
          const stuckMs = Date.now() - firstBusyAtRef.current
          if (!lockReleasedRef.current && stuckMs > 60_000 && !isStreamActive()) {
            // (edit 692) Two passes: non-force first, then force
            void fetch('/api/llm/release', { method: 'POST' }).catch(() => {})
            setTimeout(() => {
              if (!isStreamActive()) {
                void fetch('/api/llm/release?force=1', { method: 'POST' }).catch(() => {})
              }
            }, 2000)
            lockReleasedRef.current = true
            firstBusyAtRef.current = null
            setAssistantBusy(false)
            toast.warning('Assistant', { description: 'Lock released forcibly (stuck after reply). "Generate" button is available again.' })
          }
        } else {
          firstBusyAtRef.current = null
          // (edit 110) server confirmed healthy — clear local override
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

  const canGenerateNow = canGenerate && !assistantBusy

  // (edit 333) Guard against accidental double click: while generate() hasn't returned
  // (POST submit in flight, prompt_id not yet received), repeated call is ignored.
  // Intentional repeated launches ('Queue More') are not blocked — flag cleared after prompt_id.
  const submitInFlightRef = useRef(false)

  const handleGenerate = useCallback(async () => {
    // Unified guard for all launch triggers (button, Ctrl+Enter, 'save & run' dialog):
    // assistant busy — vram-arbiter will return 409
    if (assistantBusy) {
      toast.error('Assistant is responding — wait for response or interrupt it')
      return
    }
    // Read the store AT CALL TIME — the fullscreen editor's 'save & run'
    // (and history/example inserts) may have updated the prompt a moment ago.
    const v = useGenStore.getState().video
    if (!v.prompt.trim()) {
      toast.error('Please enter a video prompt')
      return
    }
    // (edit 146) 'Frames' mode: first frame is required
    if (v.mode === 'flf' && !v.startFrame) {
      toast.error('First frame is required in "Frames" mode')
      return
    }
    let prompt = v.prompt.trim()
    // (edit 150) Clean prompt from tags unsupported by current mode.
    // In t2v/flf, MiniMaxH3ReferenceToVideo node does not exist — <Picture N>/<Video N>
    // do not resolve and end up in tokenize as text (garbage for model).
    // Leave <Audio N>: in these modes audio is passed via MiniMaxH3AddGuide
    // and <Audio N> tag in prompt is a valid reference.
    // <Subject N> — FORMAT B only ('ref' mode), always clean in t2v/flf.
    const mode = v.mode
    const removedTags: string[] = []
    if (mode !== 'ref') {
      // Remove <Picture N> and <Video N> (including closing </Picture N>)
      const picRe = /<\/?(?:Picture|Video)\s*\d+\s*>/g
      const picMatches = prompt.match(picRe)
      if (picMatches) {
        for (const m of picMatches) {
          const norm = m.replace(/^<\//, '<')
          if (!removedTags.includes(norm)) removedTags.push(norm)
        }
        prompt = prompt.replace(picRe, '')
      }
      // Remove <Subject N> (FORMAT B / 'ref' mode only)
      const subjRe = /<\/Subject\s*\d+\s*>|<Subject\s*\d+\s*>/g
      const subjMatches = prompt.match(subjRe)
      if (subjMatches) {
        for (const m of subjMatches) {
          const norm = m.replace(/^<\//, '<')
          if (!removedTags.includes(norm)) removedTags.push(norm)
        }
        prompt = prompt.replace(subjRe, '')
      }
      // Remove double spaces after removal
      prompt = prompt.replace(/\s{2,}/g, ' ').trim()
    }
    if (removedTags.length) {
      toast.warning('Generation Mode', {
        description: `Tags ${removedTags.join(', ')} were removed from prompt (not supported in "${mode === 't2v' ? 'Text' : 'Frames'}" mode).`,
      })
    }
    if (!prompt) {
      toast.error('Prompt is empty after stripping unsupported tags')
      return
    }

    // (edit 256) Validate reference tags BEFORE sending: each
    // <Picture N>/<Video N>/<Audio N> must have a corresponding ref
    // (number = position among refs of same type). Previously dangling tag
    // reached ComfyUI and crashed with unclear error.
    {
      const refsForMode = v.refs.filter((r) => mode === 'ref' || r.kind === 'audio')
      const counts: Record<string, number> = { Picture: 0, Video: 0, Audio: 0 }
      for (const r of refsForMode) {
        if (r.kind === 'image') counts.Picture++
        else if (r.kind === 'video') counts.Video++
        else if (r.kind === 'audio') counts.Audio++
      }
      const dangling = new Set<string>()
      const tagRe = /<(Picture|Video|Audio)\s+(\d+)\s*>/g
      let tm: RegExpExecArray | null
      while ((tm = tagRe.exec(prompt)) !== null) {
        const kind = tm[1]
        const n = parseInt(tm[2], 10)
        if (n < 1 || n > counts[kind]) dangling.add(tm[0])
      }
      if (dangling.size) {
        toast.error('Prompt references missing files', {
          description: `Tag${dangling.size > 1 ? 's' : ''} ${[...dangling].join(', ')} — no file under this number. Add reference or remove tag from prompt.`,
          duration: 8000,
        })
        return
      }
    }

    // (edit 333, 346) Set flag synchronously BEFORE await — second click
    // while validation/submit is in flight is ignored by guard.
    // Record into prompt history — AFTER guard to prevent duplicates.
    if (submitInFlightRef.current) return
    submitInFlightRef.current = true
    usePromptHistory.getState().add(prompt)
    // (edit 696) Freeze stageKind at moment of start: during generation
    // switching 'Draft/Full' won't change stage label template.
    // extend is always 'clips2' (generate-view passes pipeline='full' for extend),
    // otherwise 'passes' (draft → 1 pass, full → 2 passes — both 'passes').
    useGenProgress.getState().setVideoFrozenStageKind(
      v.mode === 'extend' ? 'clips2' : 'passes',
    )
    try {
      await generate({
      modelType: v.modelType,
      mode: v.mode,
      pipeline: v.mode === 'extend' ? 'full' : v.pipeline,
      prompt,
      seed: v.seed,
      resolution: v.resolution,
      videoLength: v.videoLength,
      // (edit 146) 'Frames': frame files separate from references;
      // 'Text'/'Frames': only audio sent from references (images/videos
      // not accepted by node in these modes).
      firstFrame: v.mode === 'flf' ? v.startFrame?.path : undefined,
      lastFrame: v.mode === 'flf' ? v.endFrame?.path : undefined,
      // (edit 152) First frame dimensions — for aspect ratio in flf mode
      firstFrameWidth: v.mode === 'flf' ? v.startFrame?.width : undefined,
      firstFrameHeight: v.mode === 'flf' ? v.startFrame?.height : undefined,
      // ref: audio guide + preserve original track (checkbox in UI).
      audioGuide: v.mode === 'ref' && v.audioGuide === true,
      references: v.refs
        .filter((r) => v.mode === 'ref' || r.kind === 'audio')
        .map((r) => ({
        kind: r.kind,
        path: r.path,
        role: r.role || undefined,
        imageIntent: r.imageIntent,
        includeAudio: r.includeAudio,
        compress: r.compress, // (edit 493)
        // (edit 302) trim audio ref (virtual, AudioTrim node)
        trimStart: r.trimStart,
        trimEnd: r.trimEnd,
        // (edit 694) volume audio ref (virtual, AudioGain node)
        audioVolume: r.audioVolume,
      })),
      finalResolution: v.finalResolution || undefined,
      lowResMP: v.lowResMP ?? 0.2,
      firstSamplerSteps: v.firstSamplerSteps ?? 6,
      // Total schedule steps pass 1. Defaults to split point ('6 of 6').
      firstSamplerTotalSteps: v.firstSamplerTotalSteps ?? v.firstSamplerSteps ?? 6,
      draftSteps: v.mode === 'extend' ? undefined : (v.draftSteps ?? 4),
      sigmaVariant: v.sigmaVariant || '3step',
      pass2Sampler: v.pass2Sampler || 'euler',
      pass1Sampler: v.pass1Sampler || 'euler',
      pass1Scheduler: v.pass1Scheduler || 'simple',
      // (edit 96) Turbo LoRA effect is controlled only in Settings → LoRAs
      referenceDetail: v.referenceDetail || 'match', // (edit 58)
      sparseAttention: v.sparseAttention, // (edit 168)
      sparseTau: v.sparseTau, // (edit 466)
      sparseStartPercent: v.sparseStartPercent, // (edit 466)
      sparseEndPercent: v.sparseEndPercent, // (edit 466)
      sparseMinTokens: v.sparseMinTokens, // (edit 466)
      sparseExtraTokens: v.sparseExtraTokens, // (edit 466)
      vedaAttention: v.vedaAttention, // (edit 301)
      vedaGeneratedSparsity: v.vedaGeneratedSparsity, // (edit 402)
      vedaReferenceSparsity: v.vedaReferenceSparsity, // (edit 402)
      vedaFullAttentionLayers: v.vedaFullAttentionLayers, // (edit 402)
      vedaFullAttentionSteps: v.vedaFullAttentionSteps, // (edit 402)
      vedaVerbose: v.vedaVerbose, // (edit 402)
      lowVramAttention: v.lowVramAttention,
      chunkFeedForward: v.chunkFeedForward,
      chunkFFChunks: v.chunkFFChunks,
      chunkFFThreshold: v.chunkFFThreshold,
      outputSubfolder: v.outputFolder || '', // (edit 91) project folder
      })
    } finally {
      submitInFlightRef.current = false
    }
  }, [generate, assistantBusy])

  useEffect(() => {
    if (error) toast.error(error)
  }, [error])

  const progressPercent = progressMax > 0 ? Math.round((progressValue / progressMax) * 100) : 0

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && canGenerateNow) {
        e.preventDefault()
        void handleGenerate()
      }
    },
    [handleGenerate, canGenerateNow],
  )

  /* ──────────── Ref list edits that keep prompt tags in sync ──────────── */

  /** Remove reference: its tag is stripped from prompt, others renumbered.
   *  (edit 256) EXCEPTION: if the ONLY ref of its type is removed
   *  (typical 'replace video with another' scenario), KEEP tags in prompt —
   *  next added ref of same type will occupy that same <Video 1> slot. */
  const removeRefSynced = useCallback(
    (id: string) => {
      const v = useGenStore.getState().video
      const removed = v.refs.find((r) => r.id === id)
      // (edit 587) Release blob-URL of removed ref (leak fix)
      if (removed?.previewUrl?.startsWith('blob:')) {
        try { URL.revokeObjectURL(removed.previewUrl) } catch { /* already revoked */ }
      }
      const sameKindLeft = removed
        ? v.refs.filter((r) => r.kind === removed.kind && r.id !== id).length
        : 0
      if (removed && sameKindLeft === 0) {
        removeRef(id)
        return
      }
      const oldTags = tagsForRefs(v.refs)
      const newTags = tagsForRefs(v.refs.filter((r) => r.id !== id))
      const nextPrompt = rewritePromptTags(v.prompt, oldTags, newTags)
      removeRef(id)
      if (nextPrompt !== v.prompt) setPrompt(nextPrompt)
    },
    [removeRef, setPrompt],
  )

  /** Move reference: <Video N> tags follow new list order. */
  const moveRefSynced = useCallback(
    (from: number, to: number) => {
      const v = useGenStore.getState().video
      const oldTags = tagsForRefs(v.refs)
      moveRef(from, to)
      const nextTags = tagsForRefs(useGenStore.getState().video.refs)
      const nextPrompt = rewritePromptTags(v.prompt, oldTags, nextTags)
      if (nextPrompt !== v.prompt) setPrompt(nextPrompt)
    },
    [moveRef, setPrompt],
  )

  /* ──────────── Ref card ──────────── */

  const renderRefCard = (ref: VideoRefItem, index: number) => {
    const meta = KIND_META[ref.kind]
    const KindIcon = meta.icon
    const total = video.refs.length
    // Reference number within its type (Picture N / Video N / Audio N)
    const typeNum = video.refs.slice(0, index + 1).filter((r) => r.kind === ref.kind).length
    return (
      <motion.div
        key={ref.id}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        className="rounded-lg border border-border bg-[var(--surface-2)] p-2.5 space-y-2"
      >
        <div className="flex items-start gap-2.5">
          <div className="flex flex-col gap-0.5 shrink-0">
            <button
              onClick={() => moveRefSynced(index, index - 1)}
              disabled={index === 0}
              className="w-5 h-5 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-[var(--surface-3)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              title="Move Up"
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 6L5 3L8 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </button>
            <button
              onClick={() => moveRefSynced(index, index + 1)}
              disabled={index === total - 1}
              className="w-5 h-5 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-[var(--surface-3)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              title="Move Down"
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 4L5 7L8 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </button>
          </div>
          {/* (edit 719) Ref preview — shared component with fullscreen view
              (same as on Refine/ControlNet/FPS/...).
              Audio ref opens player with trim. */}
          <RefPreviewThumb
            kind={ref.kind}
            name={ref.name}
            path={ref.path}
            className="w-14 h-14 rounded-md overflow-hidden bg-black/40 border border-border shrink-0 flex items-center justify-center hover:border-cyan-500/60 transition-colors disabled:cursor-not-allowed"
            title={ref.kind === 'audio' ? 'Open player / trim' : 'Open reference'}
            trimStart={ref.trimStart}
            trimEnd={ref.trimEnd}
            audioVolume={ref.audioVolume}
            onTrimChange={(start, end) => {
              // (edit 302) Trim saved in refs store.
              updateRef(ref.id, { trimStart: start, trimEnd: end })
            }}
            onVolumeChange={(v) => {
              updateRef(ref.id, { audioVolume: v })
            }}
          >
            {ref.kind === 'image' && ref.path && (
              <img src={`/api/comfy/file?filename=${encodeURIComponent(ref.path)}&type=input&width=200`} alt={ref.name} className="w-full h-full object-cover" />
            )}
            {ref.kind === 'video' && ref.path && (
              <video src={`/api/comfy/file?filename=${encodeURIComponent(ref.path)}&type=input`} muted playsInline className="w-full h-full object-cover" preload="metadata" />
            )}
            {ref.kind === 'audio' && (
              <KindIcon className="w-5 h-5 text-emerald-400" />
            )}
            {!ref.path && (
              <KindIcon className={cn('w-5 h-5', ref.kind === 'audio' ? 'text-emerald-400' : 'text-muted-foreground')} />
            )}
          </RefPreviewThumb>
          <div className="flex-1 min-w-0 space-y-1">
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] font-mono text-muted-foreground">#{index + 1}</span>
              <span className={cn('text-[10px] px-1.5 py-0.5 rounded font-medium', meta.color)}>
                {meta.label} → &lt;{meta.tag} {typeNum}&gt;
              </span>
            </div>
            <p className="text-xs text-foreground/80 truncate" title={ref.name}>{ref.name}</p>
          </div>
          <button
            onClick={() => removeRefSynced(ref.id)}
            className="p-1 rounded hover:bg-red-500/20 text-muted-foreground hover:text-red-400 transition-colors shrink-0"
            title="Delete reference"
          >
            <XIcon className="w-3.5 h-3.5" />
          </button>
        </div>
        {ref.kind === 'video' && (
          <div className="flex items-center gap-3 flex-wrap">
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
              <input
                type="checkbox"
                checked={ref.includeAudio}
                onChange={(e) => updateRef(ref.id, { includeAudio: e.target.checked })}
                className="accent-cyan-500"
              />
              use video audio
            </label>
            {/* (edit 493) Compress reference to 480p on server (ffmpeg, cache):
                video references are heavy, and for motion/scene anchor high res is rarely needed. */}
            <label
              className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer"
              title="Resize video to 480p preserving aspect ratio before generation — saves tokens and VRAM, sufficient for motion/scene reference"
            >
              <input
                type="checkbox"
                checked={ref.compress === true}
                onChange={(e) => updateRef(ref.id, { compress: e.target.checked })}
                className="accent-cyan-500"
              />
              compress video (480p)
            </label>
          </div>
        )}
      </motion.div>
    )
  }

  /* ──────────── Render ──────────── */

  // SSR/hydration guard: persisted store values (video.resolution, prompt, refs)
  // differ between server render and first client render. Render a neutral
  // skeleton until mounted to avoid React hydration error #418.
  if (!mounted) {
    return (
      <div className="flex-1 flex min-h-0">
        {/* (edit 472) panel — surface-1, same as Refine/Tile/FPS (unified look) */}
        <div className="w-[400px] shrink-0 border-r border-border flex flex-col bg-[var(--surface-1)]">
          <div className="flex-1 flex items-center justify-center p-4">
            <div className="text-xs text-muted-foreground">Loading...</div>
          </div>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <div className="text-xs text-muted-foreground">…</div>
        </div>
      </div>
    )
  }

  const badges = (
    <>
      {video.freeResolution ? (
        <Badge className="text-[10px] bg-cyan-500/15 text-cyan-300 border-cyan-500/30 hover:bg-cyan-500/15">
          {(() => {
            const bAspect = parseResolution(video.resolution, presets).aspect
            const bMP = video.finalResolution > 0 ? video.finalResolution : 0.7
            // (edits 121, 124) exact dimensions: gen multiple of 32 + final crop
            const bDims = computeOutputDimensions(bAspect, bMP)
            return <>Free · {bAspect} · {bMP.toFixed(2)} MP ({bDims.w}×{bDims.h})</>
          })()}
        </Badge>
      ) : (
        <Badge variant="secondary" className="text-[10px]">{video.resolution}</Badge>
      )}
      <Badge variant="secondary" className="text-[10px]">{(video.videoLength / fps).toFixed(1)} s · {fps} fps</Badge>
      <Badge className="text-[10px] bg-amber-500/15 text-amber-400 border-amber-500/30 hover:bg-amber-500/15">
        2-Pass · {video.finalResolution || 'auto'} MP
      </Badge>
      {video.refs.length > 0 && (
        <Badge variant="secondary" className="text-[10px]">{video.refs.length} ref{video.refs.length > 1 ? 's' : ''}</Badge>
      )}
    </>
  )

  return (
    <div
      className="flex-1 flex min-h-0"
      // (edit 125) Ctrl+V → reference handled by global listeners
      // paste/keydown (useEffect above) — triggers on ANY tab focus.
    >
      {/* LEFT: Settings panel (edit 472: surface-1, like Refine/Tile/FPS) */}
      <div className="w-[400px] shrink-0 border-r border-border flex flex-col bg-[var(--surface-1)]">
        <div className="flex-1 overflow-y-auto p-4 space-y-4">

          {/* Header */}
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">Parameters</h2>
            <Badge className="text-[10px] bg-cyan-500/15 text-cyan-400 border-cyan-500/30 hover:bg-cyan-500/15">
              MiniMax H3
            </Badge>
          </div>

          <Separator className="bg-border opacity-50" />

          {/* (edit 146) Generation mode: text / frames / references */}
          <div className="space-y-1.5">
            <Label
              className="text-xs text-muted-foreground"
              title={
                video.mode === 't2v'
                  ? 'Video is generated only from text prompt. Audio below can be added for character voices.'
                  : video.mode === 'flf'
                    ? 'Upload the first frame (and optionally last) — video is smoothly constructed between them, guided by prompt.'
                    : 'Add images, videos, or audio — the model will use them as references.'
              }
            >
              Generation Mode
            </Label>
            <div className="grid grid-cols-3 gap-1.5">
              {([
                ['t2v', 'Text', 'Prompt only — no images or references'],
                ['flf', 'Frames', 'First (and opt. last) frame → video'],
                ['ref', 'References', 'Images/video/audio as references'],
              ] as const).map(([m, label, hint]) => (
                <button
                  key={m}
                  type="button"
                  title={hint}
                  onClick={() => patchVideo({ mode: m })}
                  className={cn(
                    'h-8 rounded-md border px-1 text-xs font-medium transition-all min-w-0 truncate text-center',
                    video.mode === m
                      ? 'bg-cyan-500/15 border-cyan-500/50 text-cyan-300'
                      : 'bg-[var(--surface-2)] border-border text-muted-foreground hover:border-cyan-500/30',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <Separator className="bg-border opacity-50" />

          {/* Pipeline: draft (single pass) / full (two passes) */}
          <div className="space-y-1.5">
            <Label
              className="text-xs text-muted-foreground"
              title={
                video.pipeline === 'draft'
                  ? 'Single fast pass — draft quality, quick generation. Can be refined later in Refine tab.'
                  : 'Fast draft at lower resolution first, then refined to sharp full quality. Takes longer, higher quality.'
              }
            >
              Pass Quality
            </Label>
            <div className="grid grid-cols-2 gap-1.5">
              {([
                ['draft', 'Draft', 'Single fast pass — draft quality; can be refined in Refine tab'],
                ['full', 'Full', 'Two passes: fast draft, then refinement to full quality'],
              ] as const).map(([pl, label, hint]) => (
                <button
                  key={pl}
                  type="button"
                  title={hint}
                  onClick={() => patchVideo({ pipeline: pl })}
                  disabled={video.mode === 'extend'}
                  className={cn(
                    'h-8 rounded-md border text-xs font-medium transition-all',
                    video.pipeline === pl
                      ? 'bg-emerald-500/15 border-emerald-500/50 text-emerald-300'
                      : 'bg-[var(--surface-2)] border-border text-muted-foreground hover:border-emerald-500/30',
                    video.mode === 'extend' && 'opacity-50 cursor-not-allowed',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <Separator className="bg-border opacity-50" />

          {/* Resolution: quality + aspect ratio (+ free-resolution mode) */}
          {(() => {
            const { quality: curQuality, aspect: curAspect } = parseResolution(video.resolution, presets)
            const qualities = Object.keys(presets)
            const aspects = Object.keys(presets[curQuality] || presets[qualities[0] || '720p'] || {})
            const freeOn = !!video.freeResolution
            const freeMP = video.finalResolution > 0
              ? video.finalResolution
              : 0.7
            // (edits 121, 124) Real resolution by MP + ratio — same
            // algorithm as backend (gen multiple of 32 → exact crop)
            const freeDims = computeOutputDimensions(curAspect, freeMP)
            return (
              <div className="space-y-2.5">
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">Resolution</Label>
                    <Select
                      value={curQuality}
                      disabled={freeOn}
                      onValueChange={(q) => {
                        const { aspect } = parseResolution(video.resolution, presets)
                        setResolution(resolveResolution(q, aspect, presets))
                      }}
                    >
                      <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md disabled:cursor-not-allowed disabled:opacity-50">
                        <SelectValue placeholder="Resolution" />
                      </SelectTrigger>
                      <SelectContent className="bg-[var(--surface-3)] border-border">
                        {qualities.map((q) => (
                          <SelectItem key={q} value={q}>{q}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">Aspect Ratio</Label>
                    {/* (edit 152) In 'Frames' mode aspect ratio is taken from first frame — selector disabled */}
                    <Select
                      value={curAspect}
                      disabled={video.mode === 'flf'}
                      onValueChange={(a) => {
                        const { quality } = parseResolution(video.resolution, presets)
                        setResolution(resolveResolution(quality, a, presets))
                      }}
                    >
                      <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md disabled:cursor-not-allowed disabled:opacity-50">
                        <SelectValue placeholder={video.mode === 'flf' ? 'From frame' : 'Aspect Ratio'} />
                      </SelectTrigger>
                      {video.mode !== 'flf' && (
                        <SelectContent className="bg-[var(--surface-3)] border-border">
                          {aspects.map((a) => (
                            <SelectItem key={a} value={a}>{a}</SelectItem>
                          ))}
                        </SelectContent>
                      )}
                    </Select>
                  </div>
                </div>

                {/* Free-resolution toggle (edit 158) — not available in 'Frames' mode:
                    orientation and nominal are taken from first frame (flfNominalDimensions),
                    free resolution (MP) would break frame proportions. */}
                {video.mode !== 'flf' && (
                  <>
                <button
                  type="button"
                  onClick={toggleFreeResolution}
                  aria-pressed={freeOn}
                  className={cn(
                    'w-full flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-medium transition-all',
                    freeOn
                      ? 'bg-cyan-500/15 border-cyan-500/40 text-cyan-300 hover:bg-cyan-500/20'
                      : 'bg-[var(--surface-2)] border-border text-muted-foreground hover:border-cyan-500/40 hover:text-foreground',
                  )}
                >
                  <SlidersHorizontalIcon className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">Free Resolution</span>
                  {freeOn && (
                    <span className="ml-auto text-[10px] font-mono tabular-nums text-cyan-300/90">
                      {freeMP.toFixed(2)} MP ({freeDims.w}×{freeDims.h})
                    </span>
                  )}
                </button>

                {/* Free-resolution MP slider */}
                {freeOn && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    className="overflow-hidden"
                  >
                    <div className="space-y-1 px-1">
                      <SettingSlider
                        label="Resolution (MP)"
                        labelTitle="Exact video size in megapixels. Final pixel dimensions are shown alongside; up to 16 MP can be entered manually in the field."
                        value={freeMP}
                        onChange={(v) => patchVideo({ finalResolution: Math.round(v * 100) / 100 })}
                        min={0.2}
                        max={3.0}
                        step={0.05}
                        formatValue={(v) => {
                          // (edits 121, 124) result: gen multiple of 32 + exact crop
                          const d = computeOutputDimensions(curAspect, v)
                          return `${v.toFixed(2)} MP (${d.w}×${d.h})`
                        }}
                        inputMin={0.2}
                        inputMax={16}
                        inputHint="0.2–16 MP. Above 3 MP requires significantly more VRAM and render time"
                      />
                    </div>
                  </motion.div>
                )}
                  </>
                )}
              </div>
            )
          })()}

          <DurationSlider
            min={framesMin}
            max={framesMax}
            step={framesStep}
            fps={fps}
            hint="17n+5 alignment · 30 s maximum"
          />

          <Separator className="bg-border opacity-50" />

          {/* Reference manager — content depends on mode (edit 146) */}
          {video.mode === 'flf' ? (
            /* ── Mode 'Frames': first/last frame + audio references ── */
            <div className="space-y-2.5">
              <Label className="text-xs text-muted-foreground flex items-center justify-between">
                <span>Frames & Audio</span>
                <span className="text-[10px] font-normal">
                  {refCounts.audio}/{refLimits.audio} aud
                </span>
              </Label>

              <div className="grid grid-cols-2 gap-2">
                {(['start', 'end'] as const).map((slotKey) => {
                  const slot = slotKey === 'start' ? video.startFrame : video.endFrame
                  const isStart = slotKey === 'start'
                  return (
                    <div
                      key={slotKey}
                      onDragOver={(e) => { e.preventDefault(); setRefsDragOver(true) }}
                      onDragLeave={() => setRefsDragOver(false)}
                      onDrop={(e) => {
                        e.preventDefault()
                        setRefsDragOver(false)
                        const f = Array.from(e.dataTransfer.files).find((x) => detectKind(x.name) === 'image')
                        if (f) void addFrameFile(f, isStart ? 'start' : 'end')
                        else toast.error('Image required')
                      }}
                      onClick={() => frameInputRef.current?.click()}
                      data-frame-slot={slotKey}
                      className={cn(
                        'border-2 border-dashed rounded-lg py-3 text-center cursor-pointer transition-all',
                        refsDragOver ? 'border-cyan-400 bg-cyan-500/10' : 'border-border hover:border-cyan-500/50 hover:bg-[var(--surface-2)]',
                        isStart ? 'flf-slot-start' : 'flf-slot-end',
                      )}
                    >
                      {slot ? (
                        <div className="px-2">
                          {/* (edit 273) previewUrl empty after restart — fallback to server path.
                              (edit 719) Click on frame — fullscreen view (shared component). */}
                          <RefPreviewThumb
                            kind="image"
                            name={slot.name}
                            path={slot.path ?? ''}
                            url={slot.previewUrl || undefined}
                            className="w-full block"
                            title="Open frame full screen"
                            stopPropagation
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={slot.previewUrl || (slot.path ? `/api/comfy/file?filename=${encodeURIComponent(slot.path)}&type=input` : undefined)}
                              alt={slot.name}
                              className="w-full h-16 object-cover rounded-md cursor-zoom-in"
                            />
                          </RefPreviewThumb>
                          <p className="text-[10px] text-muted-foreground truncate mt-1">{slot.name}</p>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              if (isStart) setVideoStartFrame(null)
                              else setVideoEndFrame(null)
                            }}
                            className="text-[10px] text-red-400 hover:text-red-300 mt-0.5"
                          >
                            remove
                          </button>
                        </div>
                      ) : (
                        <>
                          <ImageIcon className="w-4 h-4 text-muted-foreground mx-auto mb-1" />
                          <p className="text-xs text-muted-foreground font-medium">{isStart ? 'First Frame' : 'Last Frame'}</p>
                          <p className="text-[10px] text-muted-foreground/60">{isStart ? 'required' : 'optional'}</p>
                        </>
                      )}
                    </div>
                  )
                })}
              </div>

              <AudioRefsBlock
                onPick={() => audioOnlyInputRef.current?.click()}
                dragOver={refsDragOver}
                setDragOver={setRefsDragOver}
                onDropFiles={(files) => void addAudioOnlyFiles(files)}
                uploading={uploadingRefs}
                counts={`${refCounts.audio}/${refLimits.audio} aud`}
                hint="audio for voice/speech (WAV, MP3...)"
              />
              <input
                ref={frameInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/bmp,image/tiff"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) {
                    // Both slots share one input: start if empty or last is filled.
                    // (edit 347) Read store at call time (getState) to avoid stale render closure.
                    const vs = useGenStore.getState().video
                    const target = !vs.startFrame || (vs.startFrame && vs.endFrame) ? 'start' : 'end'
                    void addFrameFile(f, target)
                  }
                  e.target.value = ''
                }}
              />
              <input
                ref={audioOnlyInputRef}
                type="file"
                multiple
                accept="audio/wav,audio/mpeg,audio/ogg,audio/flac,audio/aac,audio/mp4,audio/x-m4a"
                className="hidden"
                onChange={(e) => {
                  void addAudioOnlyFiles(Array.from(e.target.files ?? []))
                  e.target.value = ''
                }}
              />

              {video.refs.some((r) => r.kind === 'audio') && (
                <div className="space-y-2">
                  {video.refs.map((ref, i) => ref.kind === 'audio' ? renderRefCard(ref, i) : null)}
                </div>
              )}
            </div>
          ) : video.mode === 't2v' ? (
            /* ── Mode 'Text': only audio references ── */
            <div className="space-y-2.5">
              <AudioRefsBlock
                onPick={() => audioOnlyInputRef.current?.click()}
                dragOver={refsDragOver}
                setDragOver={setRefsDragOver}
                onDropFiles={(files) => void addAudioOnlyFiles(files)}
                uploading={uploadingRefs}
                counts={`${refCounts.audio}/${refLimits.audio} aud`}
                hint="audio for voice/speech — images/videos are not used in this mode"
              />
              <input
                ref={audioOnlyInputRef}
                type="file"
                multiple
                accept="audio/wav,audio/mpeg,audio/ogg,audio/flac,audio/aac,audio/mp4,audio/x-m4a"
                className="hidden"
                onChange={(e) => {
                  void addAudioOnlyFiles(Array.from(e.target.files ?? []))
                  e.target.value = ''
                }}
              />
              {video.refs.some((r) => r.kind === 'audio') && (
                <div className="space-y-2">
                  {video.refs.map((ref, i) => ref.kind === 'audio' ? renderRefCard(ref, i) : null)}
                </div>
              )}
            </div>
          ) : (
            /* ── Mode 'References': standard ── */
            <div className="space-y-2.5">
              <Label
                className="text-xs text-muted-foreground flex items-center justify-between"
                title="To attach a file to the description, type @ in prompt — list will appear. Wrap dialogue in <d>...</d>."
              >
                <span>References</span>
                <span className="text-[10px] font-normal">
                  {refCounts.image}/{refLimits.image} img · {refCounts.video}/{refLimits.video} vid ·{' '}
                  {refCounts.audio}/{refLimits.audio} aud
                </span>
              </Label>

              <div
                onDragOver={(e) => { e.preventDefault(); setRefsDragOver(true) }}
                onDragLeave={() => setRefsDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault()
                  setRefsDragOver(false)
                  void addReferenceFiles(Array.from(e.dataTransfer.files))
                }}
                onClick={() => refsInputRef.current?.click()}
                className={cn(
                  'border-2 border-dashed rounded-lg py-4 text-center cursor-pointer transition-all',
                  refsDragOver ? 'border-cyan-400 bg-cyan-500/10' : 'border-border hover:border-cyan-500/50 hover:bg-[var(--surface-2)]',
                )}
              >
                <input
                  ref={refsInputRef}
                  type="file"
                  multiple
                  accept="image/png,image/jpeg,image/webp,image/bmp,image/tiff,video/mp4,video/webm,video/quicktime,video/x-matroska,video/x-msvideo,video/x-m4v,audio/wav,audio/mpeg,audio/ogg,audio/flac,audio/aac,audio/mp4,audio/x-m4a"
                  className="hidden"
                  onChange={(e) => {
                    void addReferenceFiles(Array.from(e.target.files ?? []))
                    e.target.value = ''
                  }}
                />
                {uploadingRefs ? (
                  <p className="text-xs text-cyan-400">Uploading references...</p>
                ) : (
                  <>
                    <UploadIcon className="w-5 h-5 text-muted-foreground mx-auto mb-1.5" />
                    <p className="text-xs text-muted-foreground">
                      Drag & drop, <span className="text-cyan-400 underline">choose</span> or paste with{' '}
                      <span className="font-mono text-cyan-400">Ctrl+V</span>
                    </p>
                    <p className="text-[10px] text-muted-foreground/60 mt-0.5">
                      images, videos, and audio — up to {refLimits.total} items
                    </p>
                  </>
                )}
              </div>

              {video.refs.length > 0 && (
                <div className="space-y-2">
                  {video.refs.map(renderRefCard)}
                </div>
              )}

              {/* ref + audio: Audio Guide leads generation, original track preserved in output */}
              {refCounts.audio > 0 && (
                <label className="flex items-start gap-2 rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={video.audioGuide === true}
                    onChange={(e) => patchVideo({ audioGuide: e.target.checked })}
                    className="mt-0.5 accent-emerald-400"
                  />
                  <span className="min-w-0">
                    <span className="block text-xs font-medium text-foreground">
                      Keep original sound and guide by it
                    </span>
                    <span className="block text-[10px] text-muted-foreground/70 leading-snug mt-0.5">
                      Audio references become Audio Guide; the original track of the first audio ref is inserted into final video, trimmed to video length.
                    </span>
                  </span>
                </label>
              )}
            </div>
          )}

          <Separator className="bg-border opacity-50" />

          {/* Collapsible: Additional parameters */}
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="w-full flex items-center justify-between px-3 py-2 rounded-lg bg-[var(--surface-2)] border border-border hover:border-cyan-500/30 transition-all text-left"
            >
              <span className="text-xs font-medium text-muted-foreground">Advanced Settings</span>
              <span className={cn('text-[10px] text-muted-foreground transition-transform', showAdvanced && 'rotate-180')}>▼</span>
            </button>

            {showAdvanced && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                className="space-y-3 pl-1 overflow-hidden"
              >
                {/* Root: Seed */}
                <SeedBlock />

                {/* Draft pipeline: settings for single pass; Pass 2 not present */}
                {(() => {
                  const isDraft = video.pipeline === 'draft' && video.mode !== 'extend'
                  // (edit 719) Split summary pass 1: 'N of M' + sigma boundaries.
                  // Shows exact values going to SplitSigmas/BasicScheduler.
                  const pass1Split = Math.max(1, Math.round(video.firstSamplerSteps ?? 6))
                  const pass1TotalSteps = Math.max(
                    2,
                    Math.min(64, Math.round(video.firstSamplerTotalSteps ?? pass1Split)),
                  )
                  const effSplit = Math.min(pass1Split, pass1TotalSteps)
                  // Final sigma pass 1: linspace(1.0, 0.0, steps+1)[split-1]
                  // = 1 − (split−1)/steps.
                  const pass1SigmaEnd = 1 - (effSplit - 1) / pass1TotalSteps
                  const pass2Steps =
                    (video.sigmaVariant || '3step') === '3step'
                      ? 3
                      : (video.sigmaVariant || '3step') === '4step'
                        ? 4
                        : (video.sigmaVariant || '3step') === '5step'
                          ? 5
                          : (video.sigmaVariant || '3step') === '6step'
                            ? 6
                            : 7
                  const pass2SigmaStart =
                    video.sigmaVariant === '5step'
                      ? 0.9231
                      : video.sigmaVariant === '6step'
                        ? 0.9412
                        : video.sigmaVariant === '7step'
                          ? 0.95
                          : 0.9035
                  return (
                    <>
                      {/* (edit 277) 'Refs: size mode' moved to MAIN settings.
                          (edit 281) Modes with image references: ref, extend, flf.
                          Only t2v without refs — Match/Max is irrelevant. */}
                      {video.mode !== 't2v' && (
                        <div className="space-y-1">
                          <Label
                            className="text-xs text-muted-foreground"
                            title="How to process loaded images. Match is faster; Max preserves reference details more accurately but takes longer."
                          >
                            Refs: Size Mode
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
                      )}

                      {/* Collapsible: Pass 1 (in draft — single pass) */}
                      <div className="space-y-1.5">
                        <button
                          type="button"
                          onClick={() => setShowPass1(!showPass1)}
                          className="w-full flex items-center justify-between px-3 py-1.5 rounded-md bg-[var(--surface-3)] border border-border/60 hover:border-cyan-500/30 transition-all text-left"
                        >
                          <span className="text-xs font-medium text-muted-foreground">
                            {isDraft ? 'Draft — Single Pass' : 'Pass 1 — Low-res'}
                          </span>
                          <span className={cn('text-[10px] text-muted-foreground transition-transform', showPass1 && 'rotate-180')}>▼</span>
                        </button>

                        {showPass1 && (
                          <motion.div
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: 'auto' }}
                            className="space-y-3 pl-1 overflow-hidden"
                          >
                            {/* Pass 1 canvas resolution — 'full' only: in draft
                                resolution comes from MAIN settings above */}
                            {!isDraft && (
                            <div className="space-y-1">
                              {(() => {
                                const finalMP = video.finalResolution > 0 ? video.finalResolution : 0.7
                                const maxLowRes = Math.min(2, Math.max(finalMP, 1))
                                return (
                                  <SettingSlider
                                    label="Low-res Resolution (MP)"
                                    labelTitle="Draft pass size: smaller is faster. Video is brought to full resolution at the end anyway. Quality presets (480p/720p/1080p) automatically match Pass 1 aspect ratio to final resolution for uniform upscale without distortion. Slider sets maximum Pass 1 size; template may reduce it to maintain aspect ratio."
                                    value={typeof video.lowResMP === 'number' ? Math.min(video.lowResMP, maxLowRes) : 0.2}
                                    onChange={(v) => {
                                      const clamped = Math.min(maxLowRes, Math.round(v * 100) / 100)
                                      patchVideo({ lowResMP: clamped })
                                    }}
                                    min={0.2}
                                    max={maxLowRes}
                                    step={0.05}
                                    inputMin={0.1}
                                    inputMax={maxLowRes}
                                    inputHint={`0.1–${maxLowRes.toFixed(2)} MP — draft pass size (presets affect speed only)`}
                                  />
                                )
                              })()}
                            </div>
                            )}

                            {/* Steps: draft — direct counter of single pass;
                                'full' — Pass 1 split point (effective steps). */}
                            <div className="space-y-1">
                              <SettingSlider
                                label={isDraft ? 'Draft Steps' : 'Sampler Steps'}
                                labelTitle={
                                  isDraft
                                    ? 'Number of steps the model takes to generate video. 4 is standard: fast and good; higher is more detailed but slower.'
                                    : 'Number of sigmas assigned to draft pass (split point). Higher is more accurate, but slower.'
                                }
                                value={isDraft ? (video.draftSteps ?? 4) : (video.firstSamplerSteps ?? 6)}
                                onChange={(v) =>
                                  patchVideo(
                                    isDraft
                                      ? { draftSteps: Math.round(v) }
                                      : { firstSamplerSteps: Math.round(v) },
                                  )
                                }
                                min={isDraft ? 2 : 2}
                                max={isDraft ? 16 : 30}
                                step={1}
                                inputMin={isDraft ? 2 : 1}
                                inputMax={isDraft ? 30 : 128}
                                inputHint={
                                  isDraft
                                    ? '2–30 single-pass steps (standard is 4)'
                                    : '1–128 steps. Above 30 significantly slows generation'
                                }
                              />
                            </div>

                            {/* Total schedule steps pass 1 — configured separately
                                from split point: default '6 of 6', can be '6 of 8'. */}
                            {!isDraft && (
                              <div className="space-y-1">
                                <SettingSlider
                                  label="Total Steps (Pass 1)"
                                  labelTitle={
                                    'Length of BasicScheduler schedule from which SplitSigmas ' +
                                    'takes the upper part for draft pass. Defaults to split value ' +
                                    '("6 of 6"). Increase to use e.g. "6 of 8".'
                                  }
                                  value={pass1TotalSteps}
                                  onChange={(v) =>
                                    patchVideo({ firstSamplerTotalSteps: Math.round(v) })
                                  }
                                  min={2}
                                  max={64}
                                  step={1}
                                  inputMin={2}
                                  inputMax={128}
                                  inputHint="2–128 schedule steps. Defaults to split count (6/6)"
                                />
                                {/* Live summary */}
                                <p className="text-[10px] text-muted-foreground/70 leading-snug">
                                  Pass 1: {pass1Split} of {pass1TotalSteps} · σ 1.0 → {pass1SigmaEnd.toFixed(3)} ·
                                  Pass 2: σ {pass2SigmaStart} → 0 ({pass2Steps} steps)
                                </p>
                              </div>
                            )}

                      <div className="space-y-1">
                        <Label
                          className="text-xs text-muted-foreground"
                          title="Algorithm the model uses to generate frames. Affects detail and stability; if unsure, keep euler."
                        >
                          Sampler
                        </Label>
                        <Select
                          value={video.pass1Sampler || 'euler'}
                          onValueChange={(v) => patchVideo({ pass1Sampler: v })}
                        >
                          <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
                            <SelectValue placeholder="Select" />
                          </SelectTrigger>
                          <SelectContent className="bg-[var(--surface-3)] border-border">
                            {SAMPLER_OPTIONS.map((o) => (
                              <SelectItem key={o.value} value={o.value}>
                                {o.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                      <div className="space-y-1">
                        <Label
                          className="text-xs text-muted-foreground"
                          title="How the model distributes noise across steps. Usually best to keep simple."
                        >
                          Scheduler
                        </Label>
                        <Select
                          value={video.pass1Scheduler || 'simple'}
                          onValueChange={(v) => patchVideo({ pass1Scheduler: v })}
                        >
                          <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
                            <SelectValue placeholder="Select" />
                          </SelectTrigger>
                          <SelectContent className="bg-[var(--surface-3)] border-border">
                            {SCHEDULER_OPTIONS.map((o) => (
                              <SelectItem key={o.value} value={o.value}>
                                {o.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </motion.div>
                  )}
                </div>

                {/* Collapsible: Pass 2 — 'full' pipeline only */}
                {!isDraft && (
                <div className="space-y-1.5">
                  <button
                    type="button"
                    onClick={() => setShowPass2(!showPass2)}
                    className="w-full flex items-center justify-between px-3 py-1.5 rounded-md bg-[var(--surface-3)] border border-border/60 hover:border-cyan-500/30 transition-all text-left"
                  >
                    <span className="text-xs font-medium text-muted-foreground">Pass 2 — High-res</span>
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
                          title="Number of steps in the final detail pass. More steps mean sharper image, but longer generation."
                        >
                          Sigma Profile (Steps)
                        </Label>
                        <Select
                          value={video.sigmaVariant || '3step'}
                          onValueChange={(v) => patchVideo({ sigmaVariant: v })}
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
                          title="Algorithm the model uses to generate frames. Affects detail and stability; if unsure, keep euler."
                        >
                          Sampler
                        </Label>
                        <Select
                          value={video.pass2Sampler || 'euler'}
                          onValueChange={(v) => patchVideo({ pass2Sampler: v })}
                        >
                          <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
                            <SelectValue placeholder="Select" />
                          </SelectTrigger>
                          <SelectContent className="bg-[var(--surface-3)] border-border">
                            {SAMPLER_OPTIONS.map((o) => (
                              <SelectItem key={o.value} value={o.value}>
                                {o.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                    </motion.div>
                  )}
                </div>
                )}
              </>
                  )
                })()}
              </motion.div>
            )}
          </div>
        </div>

        {/* Pinned bottom: generation status */}
        {/* (edit 475) status/preview panel — surface-1 */}
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
          />
        </div>
      </div>

      {/* RIGHT: prompt + results */}
      <div className="flex-1 flex flex-col min-w-0 bg-[var(--surface-1)]">
        {/* Prompt card — takes all available space, results grid stays at bottom */}
        <div className="p-5 pb-3 space-y-3 aurora-bg overflow-hidden flex flex-col shrink-0">
          <div className="space-y-2 flex flex-col">
            <div className="flex items-center justify-between shrink-0">
              <Label className="text-sm font-medium text-foreground flex items-center gap-2">
                <SparklesIcon className="w-4 h-4 text-cyan-400" />
                Video Description
              </Label>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-muted-foreground/70 hidden sm:block">
                  <kbd className="px-1.5 py-0.5 rounded border border-border bg-[var(--surface-2)] font-mono text-[10px]">Ctrl</kbd>
                  {' + '}
                  <kbd className="px-1.5 py-0.5 rounded border border-border bg-[var(--surface-2)] font-mono text-[10px]">Enter</kbd>
                  {' — generate'}
                </span>
              </div>
            </div>
            <div className="relative">
              <MentionTextarea
                value={video.prompt}
                onChange={setPrompt}
                onKeyDown={handleKeyDown}
                placeholder="A girl with <Picture 1> walks through the market from <Video 1> and says: <d>Almost there.</d> …"
                mentions={mentions}
                className="h-[220px] pr-12"
              />
              {/* (edit 717) Field buttons — vertical column with even spacing (PromptFieldTools). */}
              <PromptFieldTools>
                <PromptEditButton onOpen={() => setPromptEditorOpen(true)} />
                {/* (edit 691) 'Clear' + 'Fix' above microphone (PromptFixButton/PromptClearButton). */}
                <PromptClearButton
                  disabled={!video.prompt.trim()}
                  onClear={() => setPrompt('')}
                />
                <PromptFixButton onFix={() => setFixOpen(true)} />
              </PromptFieldTools>
              {/* (edit 74) Voice input: round mic inside prompt field */}
              {/* (edit 118) hotkey: R — dictation in prompt field */}
              <VoiceInputButton
                hotkey
                onText={(t) => {
                  const cur = video.prompt
                  setPrompt((cur ? cur.trimEnd() : '') ? `${cur.trimEnd()} ${t}` : t)
                }}
              />
              <PromptEditorDialog
                open={promptEditorOpen}
                onOpenChange={setPromptEditorOpen}
                initialText={video.prompt}
                onSave={setPrompt}
                onSaveAndRun={() => {
                  void handleGenerate()
                }}
                placeholder="A girl with <Picture 1> walks through the market from <Video 1> and says: <d>Almost there.</d> …"
                mentions={mentions}
              />
              {/* (edit 691) 'Improve prompt' dialog from field */}
              <PromptFixDialog
                open={fixOpen}
                onOpenChange={setFixOpen}
                hint="The prompt and your instruction will be sent to the Generate tab assistant chat — the response can be pasted back with the 'Insert' button. Ctrl+Enter to send, Esc to cancel."
                onSubmit={(req) => requestImprovePrompt(video.prompt, { mode: 'generate', fixRequest: req })}
              />
            </div>
            {/* Live prompt quality hints (non-blocking) */}
            <PromptQuality prompt={video.prompt} refsCount={video.refs.length} />

            {/* Prompt tools: history & ready-made examples.
                Dropdowns render in a portal (document.body) — inside the
                panel they would fall behind the video gallery stacking
                contexts. */}
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
                    ? 'border-cyan-500/40 text-cyan-300 bg-cyan-500/10'
                    : 'border-border text-muted-foreground hover:text-foreground',
                )}
              >
                <HistoryIcon className="w-3 h-3" />
                History
                {mounted && historyEntries.length > 0 && (
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
                    ? 'border-cyan-500/40 text-cyan-300 bg-cyan-500/10'
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
                    <span className="text-[10px] font-semibold text-foreground">Prompt History</span>
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
                      Empty for now — executed prompts are saved here automatically.
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
                    <span className="text-[10px] font-semibold text-foreground">Preset Examples</span>
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
                    Replaces the current prompt (can be undone). Prompts are in English: the model understands it best.
                  </p>
                </div>,
                document.body
              )}
          </div>

          <div className="flex items-center gap-3">
            <div className="flex flex-wrap items-center gap-1.5 flex-1 min-w-0">{badges}</div>

            {/* (edit 91) Project folder selection: videos from this generation go
                into it, gallery below shows only it. Displayed only when folders
                exist (created in "Gallery" tab). */}
            {galleryFolders.length > 0 && (
              <div className="relative shrink-0">
                <button
                  type="button"
                  onClick={() => setFolderMenuOpen(!folderMenuOpen)}
                  className={cn(
                    'h-11 inline-flex items-center gap-1.5 px-3 rounded-lg border text-xs transition-colors',
                    outputFolder
                      ? 'border-violet-500/40 bg-violet-500/10 text-violet-300'
                      : 'border-border bg-[var(--surface-2)] text-muted-foreground hover:text-foreground',
                  )}
                  title={outputFolder ? `Project folder: ${outputFolder} — videos are saved here, gallery shows it and subfolders` : 'Project folder: videos are saved here, gallery shows only this folder'}
                >
                  <FolderIcon className="w-3.5 h-3.5" />
                  <span className="max-w-[120px] truncate">{outputFolder || 'Root folder'}</span>
                  <ChevronDownIcon className={cn('w-3 h-3 transition-transform', folderMenuOpen && 'rotate-180')} />
                </button>
                {folderMenuOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setFolderMenuOpen(false)} />
                    <div className="absolute bottom-full mb-1.5 right-0 z-50 w-52 rounded-lg border border-border bg-[var(--surface-2)] shadow-xl p-1 max-h-64 overflow-y-auto">
                      <button
                        type="button"
                        onClick={() => { patchVideo({ outputFolder: '' }); setFolderMenuOpen(false) }}
                        className={cn(
                          'w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-xs text-left transition-colors',
                          !outputFolder ? 'bg-violet-500/10 text-violet-300' : 'hover:bg-[var(--surface-3)] text-foreground/80',
                        )}
                      >
                        <FilmIcon className="w-3.5 h-3.5 shrink-0" />
                        <span className="flex-1 truncate">Root folder</span>
                      </button>
                      {galleryFolders.map((f) => {
                        const depth = f.split('/').length - 1
                        const leaf = f.slice(f.lastIndexOf('/') + 1)
                        return (
                          <button
                            key={f}
                            type="button"
                            onClick={() => { patchVideo({ outputFolder: f }); setFolderMenuOpen(false) }}
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
            )}

            <Button
              onClick={() => void handleGenerate()}
              disabled={!canGenerateNow}
              title={
                assistantBusy
                  ? '💬 Assistant is responding — wait for response or interrupt it'
                  : canGenerate
                    ? 'Generate Video (Ctrl+Enter)'
                    : 'Enter prompt'
              }
              className="h-11 px-6 bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white border-0 text-sm font-semibold shadow-lg shadow-cyan-500/20"
            >
              {isGenerating ? 'Queue More' : 'Generate Video'}
            </Button>
          </div>
        </div>

        {/* Results */}
        <div className="flex-1 overflow-y-auto px-5 pb-5 min-h-0">
          <VideoGalleryGrid
            files={visibleGalleryFiles}
            loading={galleryLoading}
            onRefresh={loadGallery}
            onDeleteFile={deleteFile}
            emptyHint={
              outputFolder
                ? `No videos in folder "${outputFolder}" yet. New generations will be saved here.`
                : 'Generated videos will appear here. Describe your scene, add a reference image, and click "Generate Video".'
            }
          />
        </div>
      </div>

      {/* (edit 442) Assistant — right side panel ('Generate' mode chats) */}
      <AssistantPanel mode="generate" />

      {/* (edit 719) Ref preview is now per-thumb (shared RefPreviewThumb component) */}
    </div>
  )
}
