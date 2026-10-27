'use client'

/**
 * Clickable reference preview with fullscreen viewer.
 *
 * Provides a unified component and behavior across tabs:
 * click on preview -> open in fullscreen (see RefViewerDialog).
 *
 * The component maintains viewer state and renders it via portal to
 * body (like VideoLightbox). Parent only needs to pass kind/name/path/url.
 */
import { useState, type ReactNode } from 'react'
import { RefViewerDialog, type RefViewerData } from './ref-viewer-dialog'

export interface RefPreviewThumbProps {
  /** Reference type: image / video / audio. */
  kind: RefViewerData['kind']
  /** Display name (in viewer caption). */
  name: string
  /** Path to file in ComfyUI input/ (or staging) — for viewer. */
  path?: string
  /** Direct URL (blob:/file) — prioritized over path. */
  url?: string
  /** Wrapper button classes (size/rounding/border — matching the specific tab). */
  className?: string
  /** Tooltip. Default is "Open fullscreen". */
  title?: string
  /** Preview content (img/video/icon) — rendered inside button. */
  children: ReactNode
  /** Audio: current trim/volume — displayed in viewer. */
  trimStart?: number
  trimEnd?: number | null
  audioVolume?: number
  /** Called when opening viewer (parent can record ref id). */
  onOpen?: (data: RefViewerData) => void
  /**
   * Stop click propagation (true — click on preview does not bubble to parent:
   * e.g., to a drop zone that opens a file picker dialog).
   */
  stopPropagation?: boolean
  /** Audio: trim changed — persist to store. */
  onTrimChange?: (start: number, end: number | null) => void
  /** Audio: volume changed — persist to store. */
  onVolumeChange?: (v: number) => void
}

export function RefPreviewThumb({
  kind,
  name,
  path,
  url,
  className,
  title,
  children,
  trimStart,
  trimEnd,
  audioVolume,
  onOpen,
  stopPropagation,
  onTrimChange,
  onVolumeChange,
}: RefPreviewThumbProps) {
  const [data, setData] = useState<RefViewerData | null>(null)
  const canOpen = !!(path || url)

  const open = (e: React.MouseEvent) => {
    if (stopPropagation) e.stopPropagation()
    if (!canOpen) return
    const next: RefViewerData = { kind, name, path: path ?? '', url, trimStart, trimEnd, audioVolume }
    setData(next)
    onOpen?.(next)
  }

  return (
    <>
      <button
        type="button"
        onClick={open}
        disabled={!canOpen}
        title={title ?? (canOpen ? 'Open fullscreen' : undefined)}
        className={className}
      >
        {children}
      </button>
      <RefViewerDialog
        data={data}
        onOpenChange={(v) => {
          if (!v) setData(null)
        }}
        onTrimChange={(start, end) => {
          setData((d) => (d ? { ...d, trimStart: start, trimEnd: end } : d))
          onTrimChange?.(start, end)
        }}
        onVolumeChange={(v) => {
          setData((d) => (d ? { ...d, audioVolume: v } : d))
          onVolumeChange?.(v)
        }}
      />
    </>
  )
}
