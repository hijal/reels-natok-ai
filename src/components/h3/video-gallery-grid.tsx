'use client'

/**
 * VideoGalleryGrid — compact video gallery for the video generation tab.
 * Shows generated videos as a grid with thumbnails, click → VideoLightbox player.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom' // (fix 692) menu portal in body — above all UI elements
import { motion, AnimatePresence } from 'framer-motion'
import {
  DownloadIcon,
  RefreshCcwIcon,
  VideoIcon,
  Trash2Icon,
  InfoIcon,
  RotateCcwIcon,
  SparklesIcon,
  Maximize2Icon,
  FilmIcon,
  Wand2Icon,
  Grid3x3Icon,
  MoreVerticalIcon,
  ScissorsIcon,
  GaugeIcon,
  ZapIcon,
  WaypointsIcon,
  ScanFaceIcon,
  ArrowLeftRightIcon,
  XIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { MetaDialog } from './meta-dialog'
import { VideoTrimDialog } from './video-trim-dialog'
// (fix 729) Fullscreen comparison of two videos "before/after".
import { VideoCompareDialog } from './video-compare-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { VideoLightbox } from './video-lightbox'
import { useGenDurations, formatDuration, formatSeconds } from '@/lib/gen-duration-store'
import { restoreFromMeta } from '@/lib/restore-from-meta'
import { useUpscaleTarget } from '@/lib/upscale-target-store'
import { useRefineTarget } from '@/lib/refine-target-store'
import { useTileUpscaleTarget } from '@/lib/tile-upscale-target-store'
import { useControlNetTarget } from '@/lib/controlnet-target-store' // (fix 497)
import { useFpsTarget } from '@/lib/fps-store'
import { useExtendTarget } from '@/lib/extend-target-store'
import { useFaceRefineTarget } from '@/lib/face-refine-target-store'


/** Custom MIME for gallery video drag&drop into Upscale drop zone. */
export const H3_VIDEO_DND_MIME = 'application/x-h3-video'

/** Thumbnail width for gallery cards (server-side sharp/ffmpeg resize). */
const THUMB_WIDTH = 600

export interface VideoGalleryFile {
  url: string
  filename: string
  subfolder: string
  size?: number
  mtime?: number
  /** Generation time (seconds) from .meta.json sidecar — shown on badge. */
  generationTime?: number | null
  /** (fix 313) 'draft' → red "Draft" badge on preview. */
  pipeline?: 'draft' | 'full' | null
}

interface VideoGalleryGridProps {
  files: VideoGalleryFile[]
  loading?: boolean
  onRefresh?: () => void
  onDeleteFile?: (filename: string, subfolder: string) => void | Promise<void>
  emptyHint?: string
}

/**
 * (fix 78) Gallery video source markers:
 * - "DLSS 5" — neural-rendering bridge output (DLSS 5 Visual Enhancer):
 *   "<original>_DLSS5_<YYYYMMDD-HHMMSS-NNNNNN>.ext"
 *   (upscale/src/…/processor.py + core/naming.py, rename_mode=Auto);
 * - "Upscale" — real upscale output (RTX Video SDK, "Upscale" tab):
 *   "<original>_RTXVIDEO[_PREVIEW]_<stamp>-<uuid8>.ext"
 *   (upscale/src/upscale/video/processor.py:67-69).
 * Minimax generations are never named like this — these are reliable markers.
 * (fix 233) "Extended" — "Extend" tab output:
 *   "Minimax_Studio_extclip_<i>_<stamp>.ext" (each clip) and
 *   "Minimax_Studio_combined*.mp4" (final stitch of original + clips).
 * Markers are unique and don't clash with regular generations
 * (Minimax_Studio_<stamp>.mp4 — without extclip/combined substring).
 * (fix 312) "FPS" — "FPS" tab output (frame interpolation):
 *   "Minimax_Studio_fps_<stamp>.ext" (filename_prefix in fps-template.ts).
 */
export type VideoSourceBadge = 'dlss5' | 'upscale' | 'extended' | 'refined' | 'tileupscale' | 'fps' | 'edited' | 'controlnet' | 'facerefine' | 'draft'

export function videoSourceBadge(file: Pick<VideoGalleryFile, 'filename'>): VideoSourceBadge | null {
  // (fix 306) "Edited" — highest priority: trimmed file is always trimmed,
  // regardless of base name (combined, fps, refine, etc.)
  if (/_trim_\d/.test(file.filename)) return 'edited'
  if (/_DLSS5_\d{8}-\d{6}-\d{6}/.test(file.filename)) return 'dlss5'
  if (/_RTXVIDEO(?:_PREVIEW)?_\d{8}-\d{6}-[0-9a-f]{8}/.test(file.filename)) return 'upscale'
  if (/Minimax_Studio_extclip_\d+/i.test(file.filename) || /Minimax_Studio_combined/i.test(file.filename)) return 'extended'
  if (/Minimax_Studio_tileupscale/i.test(file.filename)) return 'tileupscale'
  // (fix 497) "ControlNet" — "ControlNet" tab output (Fun ControlNet).
  if (/Minimax_Studio_controlnet/i.test(file.filename)) return 'controlnet'
  // (fix 722) "Face Refine" — "Face Refine" tab output.
  if (/Minimax_Studio_facerefine/i.test(file.filename)) return 'facerefine'
  if (/Minimax_Studio_refine/i.test(file.filename)) return 'refined'
  // (fix 312) "FPS" — "FPS" tab output: Minimax_Studio_fps_<stamp>.mp4.
  if (/Minimax_Studio_fps/i.test(file.filename)) return 'fps'
  return null
}

/**
 * (fix 722) SINGLE badge per card.
 *
 * Previously the "Draft" badge was drawn SEPARATELY from the source badge, both in one
 * place (top-left). For a trimmed draft (`X_trim_0-2.mp4`), sidecar
 * inherits `pipeline: 'draft'` from source, so on preview there were
 * TWO badges: yellow "Edited" and red "Draft" — the second covered the first,
 * and user saw "Draft" instead of "Edited".
 *
 * Now there is a single badge with source priority: trim > DLSS > Upscale >
 * Extend > Tile > ControlNet > Refine > FPS > Draft. "Draft" is shown
 * ONLY when no other source is identified (regular generation in
 * "Draft" mode). Same principle as fix 508 for ControlNet.
 */
export function videoGalleryBadge(
  file: Pick<VideoGalleryFile, 'filename' | 'pipeline'>,
): VideoSourceBadge | null {
  const src = videoSourceBadge(file)
  if (src) return src
  if (file.pipeline === 'draft') return 'draft'
  return null
}

function thumbUrl(file: VideoGalleryFile): string {
  // The file URL from /api/comfy/files already carries `&_t=<mtime>` for
  // cache-busting — just add the thumbnail width.
  const sep = file.url.includes('?') ? '&' : '?'
  return `${file.url}${sep}width=${THUMB_WIDTH}`
}

/**
 * Poster URL — server-side extracted JPEG frame (ffmpeg, disk-cached).
 * Used as the <video poster> so the grid paints instantly without
 * downloading full videos.
 */
function posterUrl(file: VideoGalleryFile): string {
  return thumbUrl(file)
}

export const VideoGalleryGrid = memo(function VideoGalleryGrid({
  files,
  loading = false,
  onRefresh,
  onDeleteFile,
  emptyHint = 'No videos yet',
}: VideoGalleryGridProps) {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  const [metaIndex, setMetaIndex] = useState<number | null>(null)
  /** Deletion awaiting confirmation ("Delete video?" dialog). */
  const [pendingDelete, setPendingDelete] = useState<{ filename: string; subfolder: string } | null>(null)
  // (fix 272) Index of card whose action menu (MoreVertical) is open
  const [actionsOpenIndex, setActionsOpenIndex] = useState<number | null>(null)
  // (fix 305) Mini video editor: file for trimming
  const [trimFile, setTrimFile] = useState<VideoGalleryFile | null>(null)
  const [trimOpen, setTrimOpen] = useState(false)
  // (fix 729) Two-video comparison: keys of selected cards (Ctrl+click)
  // and file pair open in fullscreen dialog.
  const [selectedKeys, setSelectedKeys] = useState<string[]>([])
  const [compare, setCompare] = useState<{ a: VideoGalleryFile; b: VideoGalleryFile } | null>(null)

  /** Ctrl+click (⌘ on Mac): select/unselect. Hold at most two — third
   *  replaces the first (FIFO) so selection is never stuck. */
  const toggleSelect = useCallback((file: VideoGalleryFile) => {
    const key = `${file.subfolder}/${file.filename}`
    setSelectedKeys((prev) => {
      if (prev.includes(key)) return prev.filter((k) => k !== key)
      if (prev.length >= 2) return [prev[1], key]
      return [...prev, key]
    })
  }, [])

  /** Selected files may have disappeared (deleted/list updated) — prune. */
  useEffect(() => {
    setSelectedKeys((prev) => {
      const next = prev.filter((k) => files.some((f) => `${f.subfolder}/${f.filename}` === k))
      return next.length === prev.length ? prev : next
    })
  }, [files])

  const openCompare = useCallback(() => {
    if (selectedKeys.length !== 2) return
    const a = files.find((f) => `${f.subfolder}/${f.filename}` === selectedKeys[0])
    const b = files.find((f) => `${f.subfolder}/${f.filename}` === selectedKeys[1])
    if (!a || !b) return
    setCompare({ a, b })
  }, [selectedKeys, files])

  /* (fix 730) Esc — clear selection, Enter (when two selected) — compare.
     While any dialog is open, do not touch keys: handled by dialog. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (compare || pendingDelete || trimOpen) return
      if (e.key === 'Escape' && selectedKeys.length > 0) {
        e.preventDefault()
        setSelectedKeys([])
      } else if (e.key === 'Enter' && selectedKeys.length === 2) {
        e.preventDefault()
        openCompare()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [compare, pendingDelete, trimOpen, selectedKeys, openCompare])
  // (fix 272) Click outside menu -> close (global listener on document)
  useEffect(() => {
    if (actionsOpenIndex === null) return
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.closest('[data-video-actions-menu]'))) return
      setActionsOpenIndex(null)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [actionsOpenIndex])
  const videoRefs = useRef<(HTMLVideoElement | null)[]>([])
  // (fix 692) Ref to each card's "⋮" button — for positioning portaled menu.
  const actionBtnRefs = useRef<(HTMLButtonElement | null)[]>([])
  // (fix 353) Truncate/reset ref array when list changes: stale elements
  // of deleted cards remained in videoRefs and on hover on old index
  // another video could play.
  useEffect(() => {
    videoRefs.current.length = files.length
  }, [files])
  const durations = useGenDurations((s) => s.entries)

  // Build a filename → entry map. Entries without a filename (very old
  // sessions) are NOT matched — an index-based guess ("N-th newest entry ↔
  // N-th newest file") happily showed another video's generation time.
  const durationMap = useMemo(() => {
    const byName = new Map<string, (typeof durations)[0]>()
    const sorted = [...durations].sort((a, b) => b.ts - a.ts)
    for (const entry of sorted) {
      if (entry.filename) {
        byName.set(entry.filename, entry)
      }
    }
    return byName
  }, [durations])

  /* ── "Send to Upscale": put target in store and switch tab.
   *    UpscaleView will pick it up and import video via server
   *    (/api/upscale/import) — browser is not in loop. ── */
  const sendToUpscale = useCallback((file: VideoGalleryFile) => {
    useUpscaleTarget.getState().setTarget({ filename: file.filename, subfolder: file.subfolder })
    window.dispatchEvent(new CustomEvent('h3:goto-upscale'))
  }, [])

  /* ── "To Refine": generative v2v upscale — same pattern. ── */
  const sendToRefine = useCallback((file: VideoGalleryFile) => {
    useRefineTarget.getState().setTarget({ filename: file.filename, subfolder: file.subfolder })
    window.dispatchEvent(new CustomEvent('h3:goto-refine'))
  }, [])

  /* ── "Tile Upscale": tiled latent upscale — target into store + switch tab. ── */
  const sendToTileUpscale = useCallback((file: VideoGalleryFile) => {
    useTileUpscaleTarget.getState().setTarget({ filename: file.filename, subfolder: file.subfolder })
    window.dispatchEvent(new CustomEvent('h3:goto-tile-upscale'))
  }, [])

  /* ── "Face Refine": redraw small faces — target into store + switch tab. ── */
  const sendToFaceRefine = useCallback((file: VideoGalleryFile) => {
    useFaceRefineTarget.getState().setTarget({ filename: file.filename, subfolder: file.subfolder })
    window.dispatchEvent(new CustomEvent('h3:goto-face-refine'))
  }, [])

  /* ── (fix 497) "ControlNet": video as control clip (motion) — same pattern. ── */
  const sendToControlNet = useCallback((file: VideoGalleryFile) => {
    useControlNetTarget.getState().setTarget({ filename: file.filename, subfolder: file.subfolder })
    window.dispatchEvent(new CustomEvent('h3:goto-controlnet'))
  }, [])

  /* ── "FPS": frame interpolation (RIFE/FILM VFI) — target into store + switch tab. ── */
  const sendToFps = useCallback((file: VideoGalleryFile) => {
    useFpsTarget.getState().setTarget({ filename: file.filename, subfolder: file.subfolder })
    window.dispatchEvent(new CustomEvent('h3:goto-fps'))
  }, [])

  /* ── (fix 369) "Extend": source for "Extend" tab — same pattern. ── */
  const sendToExtend = useCallback((file: VideoGalleryFile) => {
    useExtendTarget.getState().setTarget({ filename: file.filename, subfolder: file.subfolder })
    window.dispatchEvent(new CustomEvent('h3:goto-extend'))
  }, [])

  /* ── Delete handler (optimistic update in useVideoGallery) ── */
  const handleDelete = useCallback(
    async (filename: string, subfolder: string) => {
      if (!onDeleteFile) return
      await onDeleteFile(filename, subfolder)
    },
    [onDeleteFile],
  )

  /** Confirm pending deletion ("Delete" button or Enter). */
  const confirmPendingDelete = useCallback(async () => {
    if (!pendingDelete) return
    const { filename, subfolder } = pendingDelete
    setPendingDelete(null)
    await handleDelete(filename, subfolder)
  }, [pendingDelete, handleDelete])

  /* ── Empty state ── */
  if (!loading && files.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center py-12">
        <VideoIcon className="w-10 h-10 text-muted-foreground/30 mb-3" />
        <p className="text-sm text-muted-foreground">{emptyHint}</p>
      </div>
    )
  }

  /* ── Loading skeletons ── */
  if (loading) {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            className="aspect-video rounded-lg bg-[var(--surface-2)] animate-pulse"
          />
        ))}
      </div>
    )
  }

  return (
    <>
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <Badge variant="secondary" className="text-xs shrink-0">
            {files.length} {files.length === 1 ? 'video' : 'videos'}
          </Badge>
          {/* (fix 729) Comparison hint: Ctrl+click two cards */}
          {selectedKeys.length === 0 ? (
            <span className="hidden sm:inline text-[10px] text-muted-foreground/70 truncate">
              Ctrl+click two videos to compare
            </span>
          ) : (
            <span className="text-[10px] text-muted-foreground truncate">
              {selectedKeys.length === 1
                ? '1 of 2 selected — select one more'
                : 'Ready to compare'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {/* (fix 729) "Compare" button appears when exactly two videos are selected */}
          {selectedKeys.length === 2 && (
            <Button
              size="sm"
              onClick={openCompare}
              className="h-7 gap-1.5 px-2.5 text-xs bg-cyan-500 hover:bg-cyan-400 text-black font-semibold"
              title="Open before/after comparison (Enter)"
            >
              <ArrowLeftRightIcon className="w-3.5 h-3.5" />
              Compare
            </Button>
          )}
          {selectedKeys.length > 0 && (
            <button
              onClick={() => setSelectedKeys([])}
              className="p-1.5 rounded-lg hover:bg-[var(--surface-3)] text-muted-foreground transition-colors"
              title="Clear selection (Esc)"
            >
              <XIcon className="w-3.5 h-3.5" />
            </button>
          )}
          {onRefresh && (
            <button
              onClick={() => onRefresh()}
              className="p-1.5 rounded-lg hover:bg-[var(--surface-3)] text-muted-foreground transition-colors"
              title="Refresh"
            >
              <RefreshCcwIcon className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
        <AnimatePresence mode="popLayout">
          {files.map((file, index) => (
            <motion.div
              key={`${file.subfolder}/${file.filename}`}
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              className={cn(
                'group relative aspect-video rounded-lg border border-border bg-[var(--surface-2)] cursor-pointer transition-shadow',
                // (fix 729) Highlight selected for comparison
                selectedKeys.includes(`${file.subfolder}/${file.filename}`) &&
                  'ring-2 ring-cyan-400 border-cyan-400/60 shadow-[0_0_14px_rgba(34,211,238,0.35)]',
              )}
              onClick={(e) => {
                // (fix 729) Ctrl/⌘+click — select for comparison, normal click — lightbox.
                if (e.ctrlKey || e.metaKey) {
                  e.preventDefault()
                  toggleSelect(file)
                  return
                }
                setLightboxIndex(index)
              }}
              // (fix 388) draggable lost during menu refactoring (272/379):
              // without attribute browser does not start HTML5 DnD at all, breaking
              // drag&drop of cards TO ALL targets (Upscale/Refine/FPS/Tile/Extend/
              // gallery folders). Handler below just populates dataTransfer.
              draggable
              onDragStartCapture={(e) => {
                // Drag&drop to Upscale drop zone: send filename from
                // common output folder (not local File) — upscale-view
                // imports it on server (/api/upscale/import).
                // (fix 93) 'copyMove': target in folder gallery declares
                // dropEffect 'move' — with effectAllowed 'copy' browser
                // considers them incompatible and drop event does NOT fire.
                e.dataTransfer.setData(
                  H3_VIDEO_DND_MIME,
                  JSON.stringify({ filename: file.filename, subfolder: file.subfolder }),
                )
                e.dataTransfer.setData('text/plain', file.filename)
                e.dataTransfer.effectAllowed = 'copyMove'
              }}
              onPointerEnter={() => { videoRefs.current[index]?.play().catch(() => {}) }}
              onPointerLeave={() => { const v = videoRefs.current[index]; if (v) { v.pause(); v.currentTime = 0; } }}
            >
              {/* Video thumbnail — poster JPEG (server-cached) + lazy video.
                  preload="none" keeps the grid light: full video streams
                  only on hover (pointer events below) or in the lightbox. */}
              <video
                ref={(el) => { videoRefs.current[index] = el }}
                src={file.url}
                poster={posterUrl(file)}
                muted
                loop
                preload="none"
                playsInline
                className="w-full h-full object-cover pointer-events-none rounded-lg"
                onLoadedMetadata={(e) => { e.currentTarget.currentTime = 0; }}
              />

              {/* (fix 729) Comparison selection marker: A — "before", B — "after".
                  Selection order determines side (first = A), so label
                  shows letter rather than just checkmark. */}
              {selectedKeys.includes(`${file.subfolder}/${file.filename}`) && (() => {
                const selIndex = selectedKeys.indexOf(`${file.subfolder}/${file.filename}`)
                return (
                  <div className="absolute inset-0 z-[5] flex items-center justify-center pointer-events-none">
                    <span
                      className={cn(
                        'w-9 h-9 rounded-full flex items-center justify-center text-sm font-extrabold border-2 shadow-lg backdrop-blur-sm',
                        selIndex === 0
                          ? 'bg-cyan-500/85 text-black border-cyan-100/80'
                          : 'bg-fuchsia-500/85 text-black border-fuchsia-100/80',
                      )}
                      title={selIndex === 0 ? 'A — "before" (left)' : 'B — "after" (right)'}
                    >
                      {selIndex === 0 ? 'A' : 'B'}
                    </span>
                  </div>
                )
              })()}

              {/* (fix 272) Single button in top-right corner -> actions menu.
                  Hover overlay no longer covers whole preview: preview is
                  fully visible, actions opened by clicking "⋮".
                  (fix 379) Open menu is NOT faded with hover wrapper:
                  previously mouse leaving card gave opacity-0 to menu as well. */}
              <div
                data-video-actions-menu
                className={`absolute top-1.5 right-1.5 transition-opacity z-10 ${
                  actionsOpenIndex === index
                    ? 'opacity-100'
                    : 'opacity-0 group-hover:opacity-100'
                }`}
              >
                <button
                  ref={(el) => { if (el) actionBtnRefs.current[index] = el }}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    setActionsOpenIndex((prev) => (prev === index ? null : index))
                  }}
                  className="p-1.5 rounded-lg bg-black/60 backdrop-blur-sm hover:bg-black/80 text-white transition-colors"
                  title="Actions"
                >
                  <MoreVerticalIcon className="w-4 h-4" />
                </button>
                {(actionsOpenIndex === index && actionBtnRefs.current[index]) && (() => {
                  /* (fix 692, add. fix 700) Action menu via createPortal in
                     document.body. Portal + fixed + z-[300] — above UI by z-index.

                     (fix 700) REAL cause of overlap: position:fixed child
                     is CLIPPED by ancestor stacking context — AnimatePresence mode="popLayout"
                     sets transform on grid wrapper (creates stacking context). Hence
                     left panel (DOM sibling) was drawn ON TOP OF menu regardless of z-index.
                     Solution independent of z: open menu to the LEFT (anchor is right edge
                     of button). Button "⋮" is in top right corner of card, so menu
                     remains entirely in right zone of gallery and cannot physically
                     slip under left panel at any window size. Clamped top/left to viewport. */
                  const _btn = actionBtnRefs.current[index]!
                  const _rect = _btn.getBoundingClientRect()
                  const _MENU_W = 224 // 14rem
                  const _MENU_H = 560 // safety margin: real height ~470px
                  const _top = Math.max(4, Math.min(_rect.bottom + 4, window.innerHeight - _MENU_H - 4))
                  // Menu occupies [left .. left+_MENU_W]; right edge = right edge of button.
                  let _left = _rect.right - _MENU_W
                  if (_left < 4) _left = Math.max(4, _rect.left) // too narrow — shift right
                  return createPortal(
                  <div
                    data-video-actions-menu
                    className="fixed z-[300] flex flex-col gap-0.5 p-1 rounded-lg border border-border bg-[var(--surface-1)] shadow-xl"
                    style={{
                      top: _top,
                      left: _left,
                      width: '14rem',
                    }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {/* (fix 371 made menu 5×2 icon grid — in practice
                       it collapsed to tiny width and icons were unreadable.
                       (fix 380) REVERT to version with labels: vertical
                       list "icon + label", explicit width w-56 — independent
                       of positioning context. Tooltips not needed: label always visible.
                       (fix 717) Comment was bare block comment in JSX. */}
                    <a
                      href={file.url}
                      download={file.filename}
                      onClick={(e) => { e.stopPropagation(); setActionsOpenIndex(null) }}
                      title="Download"
                      className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-xs text-foreground hover:bg-[var(--surface-3)] transition-colors"
                    >
                      <DownloadIcon className="w-4 h-4 shrink-0 text-muted-foreground" />
                      Download
                    </a>
                    <button
                      onClick={() => { setMetaIndex(index); setActionsOpenIndex(null) }}
                      title="Metadata"
                      className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-xs text-foreground hover:bg-[var(--surface-3)] transition-colors text-left"
                    >
                      <InfoIcon className="w-4 h-4 shrink-0 text-muted-foreground" />
                      Metadata
                    </button>
                    <button
                      onClick={() => {
                        void restoreFromMeta(`${file.subfolder}/${file.filename}`)
                        setActionsOpenIndex(null)
                      }}
                      title="Rerun generation"
                      className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-xs text-foreground hover:bg-[var(--surface-3)] transition-colors text-left"
                    >
                      <RotateCcwIcon className="w-4 h-4 shrink-0 text-cyan-400" />
                      Rerun generation
                    </button>
                    <button
                      onClick={() => {
                        sendToUpscale(file)
                        setActionsOpenIndex(null)
                      }}
                      title="Send to upscale (DLSS 5)"
                      className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-xs text-foreground hover:bg-[var(--surface-3)] transition-colors text-left"
                    >
                      <SparklesIcon className="w-4 h-4 shrink-0 text-violet-400" />
                      Upscale (DLSS 5)
                    </button>
                    <button
                      onClick={() => {
                        sendToRefine(file)
                        setActionsOpenIndex(null)
                      }}
                      title="To Refine (v2v upscale)"
                      className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-xs text-foreground hover:bg-[var(--surface-3)] transition-colors text-left"
                    >
                      <Wand2Icon className="w-4 h-4 shrink-0 text-emerald-400" />
                      Refine (v2v)
                    </button>
                    <button
                      onClick={() => {
                        sendToTileUpscale(file)
                        setActionsOpenIndex(null)
                      }}
                      title="To Tile Upscale"
                      className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-xs text-foreground hover:bg-[var(--surface-3)] transition-colors text-left"
                    >
                      <Grid3x3Icon className="w-4 h-4 shrink-0 text-pink-400" />
                      Tile Upscale
                    </button>
                    <button
                      onClick={() => {
                        sendToFaceRefine(file)
                        setActionsOpenIndex(null)
                      }}
                      title="Redraw faces ('Face Refine' tab)"
                      className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-xs text-foreground hover:bg-[var(--surface-3)] transition-colors text-left"
                    >
                      <ScanFaceIcon className="w-4 h-4 shrink-0 text-lime-400" />
                      Face Refine
                    </button>
                    <button
                      onClick={() => {
                        sendToControlNet(file)
                        setActionsOpenIndex(null)
                      }}
                      title="Use as control video ('ControlNet' tab)"
                      className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-xs text-foreground hover:bg-[var(--surface-3)] transition-colors text-left"
                    >
                      <WaypointsIcon className="w-4 h-4 shrink-0 text-orange-400" />
                      ControlNet (motion)
                    </button>
                    <button
                      onClick={() => {
                        sendToFps(file)
                        setActionsOpenIndex(null)
                      }}
                      title="Increase FPS"
                      className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-xs text-foreground hover:bg-[var(--surface-3)] transition-colors text-left"
                    >
                      <GaugeIcon className="w-4 h-4 shrink-0 text-cyan-400" />
                      Increase FPS
                    </button>
                    <button
                      onClick={() => {
                        sendToExtend(file)
                        setActionsOpenIndex(null)
                      }}
                      title="Extend"
                      className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-xs text-foreground hover:bg-[var(--surface-3)] transition-colors text-left"
                    >
                      <FilmIcon className="w-4 h-4 shrink-0 text-cyan-400" />
                      Extend
                    </button>
                    <button
                      onClick={() => {
                        setTrimFile(file)
                        setTrimOpen(true)
                        setActionsOpenIndex(null)
                      }}
                      title="Trim"
                      className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-xs text-foreground hover:bg-[var(--surface-3)] transition-colors text-left"
                    >
                      <ScissorsIcon className="w-4 h-4 shrink-0 text-amber-400" />
                      Trim
                    </button>
                    {onDeleteFile && (
                      <button
                        onClick={() => {
                          setPendingDelete({ filename: file.filename, subfolder: file.subfolder })
                          setActionsOpenIndex(null)
                        }}
                        title="Delete"
                        className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-xs text-red-400 hover:bg-red-500/10 transition-colors text-left"
                      >
                        <Trash2Icon className="w-4 h-4 shrink-0" />
                        Delete
                      </button>
                    )}
                  </div>, document.body)
                  })()}
              </div>

              {/* (fixes 78, 233) Source marker — result of DLSS 5 / upscale
                  / extension. Always visible, not just on hover.
                  (fix 722) SINGLE badge: videoGalleryBadge returns source
                  by priority, "Draft" only if no other source exists. */}
              {(() => {
                const badge = videoGalleryBadge(file)
                if (!badge) return null
                if (badge === 'upscale') {
                  return (
                    <span
                      className="absolute top-1.5 left-1.5 inline-flex items-center gap-1 rounded-md bg-black/60 backdrop-blur-sm px-1.5 py-0.5 text-[10px] font-semibold text-cyan-300 border border-cyan-400/40"
                      title="Upscale result (RTX Video SDK, 'Upscale' tab)"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Maximize2Icon className="w-2.5 h-2.5" />
                      Upscale
                    </span>
                  )
                }
                if (badge === 'dlss5') {
                  return (
                    <span
                      className="absolute top-1.5 left-1.5 inline-flex items-center gap-1 rounded-md bg-black/60 backdrop-blur-sm px-1.5 py-0.5 text-[10px] font-semibold text-fuchsia-300 border border-fuchsia-400/40"
                      title="Upscale result ('Upscale' tab)"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <SparklesIcon className="w-2.5 h-2.5" />
                      DLSS 5
                    </span>
                  )
                }
                // "Refined" — generative upscale of "Refine" tab:
                // Minimax_Studio_refine_<stamp>.mp4.
                if (badge === 'refined') {
                  return (
                    <span
                      className="absolute top-1.5 left-1.5 inline-flex items-center gap-1 rounded-md bg-black/60 backdrop-blur-sm px-1.5 py-0.5 text-[10px] font-semibold text-emerald-300 border border-emerald-400/40"
                      title="Generative upscale ('Refine' tab, v2v)"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Wand2Icon className="w-2.5 h-2.5" />
                      Refined
                    </span>
                  )
                }
                // "TileUpscale" — tiled latent upscale ("Tile Upscale" tab).
                if (badge === 'tileupscale') {
                  return (
                    <span
                      className="absolute top-1.5 left-1.5 inline-flex items-center gap-1 rounded-md bg-black/60 backdrop-blur-sm px-1.5 py-0.5 text-[10px] font-semibold text-pink-300 border border-pink-400/40"
                      title="Tiled latent upscale ('Tile Upscale' tab)"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Grid3x3Icon className="w-2.5 h-2.5" />
                      Tile
                    </span>
                  )
                }
                // (fix 497) "ControlNet" — generation using control video
                // ("ControlNet" tab): Minimax_Studio_controlnet_<stamp>.mp4.
                // (fix 508) Two-pass mode (pipeline='full' in meta) —
                // badge "ControlNet x2".
                if (badge === 'controlnet') {
                  const twoPass = file.pipeline === 'full'
                  return (
                    <span
                      className="absolute top-1.5 left-1.5 inline-flex items-center gap-1 rounded-md bg-black/60 backdrop-blur-sm px-1.5 py-0.5 text-[10px] font-semibold text-orange-300 border border-orange-400/40"
                      title={twoPass
                        ? 'Generation using control video, two passes ("ControlNet" tab)'
                        : 'Generation using control video ("ControlNet" tab)'}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <WaypointsIcon className="w-2.5 h-2.5" />
                      {twoPass ? 'ControlNet x2' : 'ControlNet'}
                    </span>
                  )
                }
                // (fix 312) "FPS" — "FPS" tab output:
                // Minimax_Studio_fps_<stamp>.mp4 (RIFE/FILM VFI, frame interpolation).
                // Violet — not to confuse with cyan Upscale/Extended markers.
                if (badge === 'fps') {
                  return (
                    <span
                      className="absolute top-1.5 left-1.5 inline-flex items-center gap-1 rounded-md bg-black/60 backdrop-blur-sm px-1.5 py-0.5 text-[10px] font-semibold text-violet-300 border border-violet-400/40"
                      title="FPS boost ('FPS' tab, frame interpolation)"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <GaugeIcon className="w-2.5 h-2.5" />
                      FPS
                    </span>
                  )
                }
                // (fix 233) "Extended" — "Extend" tab output:
                // Minimax_Studio_extclip_<i> (clip) / Minimax_Studio_combined (stitch).
                if (badge === 'extended') {
                  return (
                    <span
                      className="absolute top-1.5 left-1.5 inline-flex items-center gap-1 rounded-md bg-black/60 backdrop-blur-sm px-1.5 py-0.5 text-[10px] font-semibold text-cyan-300 border border-cyan-400/40"
                      title="Extension result ('Extend' tab)"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <FilmIcon className="w-2.5 h-2.5" />
                      Extended
                    </span>
                  )
                }
                // (fix 722) "Face Refine" — "Face Refine" tab output:
                // Minimax_Studio_facerefine_<stamp>.mp4.
                if (badge === 'facerefine') {
                  return (
                    <span
                      className="absolute top-1.5 left-1.5 inline-flex items-center gap-1 rounded-md bg-black/60 backdrop-blur-sm px-1.5 py-0.5 text-[10px] font-semibold text-lime-300 border border-lime-400/40"
                      title="Redrawn faces ('Face Refine' tab)"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <ScanFaceIcon className="w-2.5 h-2.5" />
                      Face Refine
                    </span>
                  )
                }
                // (fix 305) "Edited" — video trim result.
                if (badge === 'edited') {
                  return (
                    <span
                      className="absolute top-1.5 left-1.5 inline-flex items-center gap-1 rounded-md bg-black/60 backdrop-blur-sm px-1.5 py-0.5 text-[10px] font-semibold text-amber-300 border border-amber-400/40"
                      title="Edited (trim)"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <ScissorsIcon className="w-2.5 h-2.5" />
                      Edited
                    </span>
                  )
                }
                // (fix 313) Red badge "Draft" — single-pass generation
                // (pipeline='draft' in .meta.json). Shown ONLY when
                // no other source is detected (videoGalleryBadge): trimmed
                // draft prefers "Edited", ControlNet prefers "ControlNet"
                // (fix 508), Refine/FPS/Extend/Tile prefer their own badges.
                if (badge === 'draft') {
                  return (
                    <span
                      className="absolute top-1.5 left-1.5 inline-flex items-center gap-1 rounded-md bg-black/60 backdrop-blur-sm px-1.5 py-0.5 text-[10px] font-semibold text-red-300 border border-red-400/40"
                      title="Draft: single pass in draft resolution (upgrade in 'Refine' tab)"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <ZapIcon className="w-2.5 h-2.5" />
                      Draft
                    </span>
                  )
                }
              })()}

              {/* Filename + duration badge.
                  (fix 522) Bottom dark gradient removed by user request
                  in all modes. Text stays on subtle semi-transparent background. */}
              <div className="absolute bottom-0 left-0 right-0 rounded-b-lg p-1.5">
                <div className="flex items-center justify-between gap-1">
                  <p className="text-[10px] text-white/70 truncate font-mono">
                    {String(files.length - index).padStart(3, '0')}
                  </p>
                  {(() => {
                    // Generation time: priority — value from metadata
                    // (.meta.json → generation_time, same as in metadata dialog);
                    // fallback — client-side estimation useGenDurations.
                    const metaSec = typeof file.generationTime === 'number' && file.generationTime > 0
                      ? file.generationTime
                      : null
                    const storeEntry = durationMap.get(file.filename)
                    const label = metaSec != null
                      ? formatSeconds(metaSec)
                      : storeEntry
                        ? formatDuration(storeEntry.durationMs)
                        : null
                    if (!label) return null
                    return (
                      <span
                        className="text-[10px] text-cyan-300/80 font-medium shrink-0"
                        title="Generation time (from metadata)"
                      >
                        {label}
                      </span>
                    )
                  })()}
                </div>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {/* Lightbox: onDelete triggers deletion directly — lightbox has
          its own inline confirmation, no second dialog needed here
          (previously had double confirmation). */}
      {lightboxIndex !== null && (
        <VideoLightbox
          files={files.map((f) => ({ url: f.url, filename: f.filename, subfolder: f.subfolder }))}
          initialIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onDelete={onDeleteFile ? (filename, subfolder) => handleDelete(filename, subfolder) : undefined}
        />
      )}

      {/* Metadata dialog */}
      {metaIndex !== null && files[metaIndex] && (
        <MetaDialog
          filePath={`${files[metaIndex].subfolder}/${files[metaIndex].filename}`}
          filename={files[metaIndex].filename}
          onClose={() => setMetaIndex(null)}
        />
      )}

      {/* (fix 305) Mini video editor — video trimming */}
      <VideoTrimDialog
        file={trimFile}
        open={trimOpen}
        onOpenChange={(v) => { setTrimOpen(v); if (!v) setTrimFile(null) }}
        onDone={() => onRefresh?.()}
      />

      {/* (fix 729) Fullscreen comparison of two selected videos */}
      {compare && (
        <VideoCompareDialog
          a={compare.a}
          b={compare.b}
          onClose={() => setCompare(null)}
        />
      )}

      {/* Delete confirmation — Enter confirms, Esc cancels */}
      <Dialog open={!!pendingDelete} onOpenChange={(v) => !v && setPendingDelete(null)}>
        <DialogContent
          className="max-w-sm"
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void confirmPendingDelete()
            }
          }}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Trash2Icon className="w-4 h-4 text-red-400" />
              Delete video?
            </DialogTitle>
            <DialogDescription>
              File &quot;{pendingDelete?.filename}&quot; and its metadata will be permanently deleted. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 mt-1">
            <Button variant="outline" size="sm" onClick={() => setPendingDelete(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              autoFocus
              onClick={() => void confirmPendingDelete()}
            >
              <Trash2Icon className="w-3.5 h-3.5" />
              Delete
            </Button>
          </div>
          <p className="text-[10px] text-muted-foreground/50 text-right -mt-1">
            Enter — delete · Esc — cancel
          </p>
        </DialogContent>
      </Dialog>
    </>
  )
})
