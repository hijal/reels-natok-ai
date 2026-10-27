'use client'

/**
 * (edit 723) FacePickDialog — "Target face selection" window: source video
 * with frame scrubbing and click-to-pick target face.
 *
 * Why: geometric rules (largest / leftmost / rightmost) only see frame geometry
 * and get stuck on the same person in crowds or wide shots. Clicking specifies the target
 * directly: the H3 Face Track + Crop node picks the closest face to the point and tracks
 * that person across the entire clip.
 *
 * Coordinates are calculated in pixels of the VIDEO ITSELF (video.videoWidth/Height) —
 * which is what the X/Y inputs expect. Frame number is calculated from fps returned by ffprobe
 * (video.currentTime * fps), since HTML <video> does not provide frame indices directly.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { CrosshairIcon, PauseIcon, PlayIcon, XIcon } from 'lucide-react'
import type { FaceRefinePoint } from '@/lib/face-refine-target-store'

interface FacePickDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Source video URL (same as preview player in panel). */
  url: string
  filename: string
  /** Source fps; 24 fallback if ffprobe did not respond. */
  fps: number
  /** Total frames (0 = unknown). */
  frames: number
  point: FaceRefinePoint | null
  onPick: (point: FaceRefinePoint) => void
  /** Reset point and revert to rule. */
  onClear: () => void
}

function fmtTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) return '0:00.0'
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}:${s.toFixed(1).padStart(4, '0')}`
}

export function FacePickDialog({
  open,
  onOpenChange,
  url,
  filename,
  fps,
  frames,
  point,
  onPick,
  onClear,
}: FacePickDialogProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [duration, setDuration] = useState(0)
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [marker, setMarker] = useState<FaceRefinePoint | null>(point)
  // Browsers cannot play all containers (mkv/mxf), and without frames click cannot be placed.
  const [loadFailed, setLoadFailed] = useState(false)
  // Each open picks up current point; clicks inside the dialog do not reset it.
  const openedRef = useRef(false)

  const frameOf = useCallback(
    (t: number) => Math.max(0, Math.round(t * (fps > 0 ? fps : 24))),
    [fps],
  )

  useEffect(() => {
    if (!open) {
      openedRef.current = false
      return
    }
    if (openedRef.current) return
    openedRef.current = true
    setMarker(point)
    setPlaying(false)
    setLoadFailed(false)
  }, [open, point])

  // Metadata arrives after open: set cursor to frame of point
  // so that it's visible and can be adjusted.
  const handleMetadata = () => {
    const v = videoRef.current
    if (!v) return
    const dur = isFinite(v.duration) ? v.duration : 0
    setDuration(dur)
    setSize({ w: v.videoWidth, h: v.videoHeight })
    const t = point && fps > 0 ? point.frame / fps : 0
    v.currentTime = Math.max(0, Math.min(t, dur > 0 ? dur - 0.05 : 0))
    setTime(v.currentTime)
  }

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const v = videoRef.current
    if (!v || !v.videoWidth || !v.videoHeight) return
    const r = v.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) return
    const x = Math.max(0, Math.min(v.videoWidth - 1,
      Math.round(((e.clientX - r.left) / r.width) * v.videoWidth)))
    const y = Math.max(0, Math.min(v.videoHeight - 1,
      Math.round(((e.clientY - r.top) / r.height) * v.videoHeight)))
    const picked: FaceRefinePoint = { x, y, frame: frameOf(v.currentTime) }
    setMarker(picked)
    onPick(picked)
  }

  const togglePlay = () => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) void v.play().catch(() => { /* autoplay blocked — non-critical */ })
    else v.pause()
  }

  const seek = (t: number) => {
    const v = videoRef.current
    if (!v || !duration) return
    const next = Math.max(0, Math.min(t, duration))
    v.currentTime = next
    setTime(next)
  }

  const markerPct = marker && size.w > 0
    ? { left: `${(marker.x / size.w) * 100}%`, top: `${(marker.y / size.h) * 100}%` }
    : null

  // Fit even vertical/massive videos into dialog: width constrained
  // by 52vh height (52 * aspect), rather than 900px width.
  const maxVideoWidthVh =
    size.w > 0 && size.h > 0 ? 52 * (size.w / size.h) : null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[900px] max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <CrosshairIcon className="w-4 h-4 text-yellow-400" />
            Select Face to Redraw
          </DialogTitle>
          <DialogDescription className="text-xs">
            Find the frame where the target face is most visible and click on it.
            The node will select the face closest to the point and track that person
            throughout the entire video.
            {filename && <span className="text-muted-foreground/70"> {filename}</span>}
          </DialogDescription>
        </DialogHeader>

        {/* Frame. Click on video = point. Wrapper gets width from video aspect
            and 52vh height constraint: even large vertical videos fit completely
            without scrolling. */}
        <div className="flex justify-center">
          <div
            className="relative inline-block max-w-full rounded-lg overflow-hidden bg-black cursor-crosshair select-none"
            style={maxVideoWidthVh ? { width: `min(100%, ${maxVideoWidthVh}vh)` } : { width: '100%' }}
            onClick={handleClick}
            title="Click on the face"
          >
            <video
              ref={videoRef}
              src={url}
              className="w-full h-auto block"
              preload="metadata"
              playsInline
              onLoadedMetadata={handleMetadata}
              onError={() => setLoadFailed(true)}
              onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onEnded={() => setPlaying(false)}
            />
            {markerPct && (
              <div
                className="absolute -translate-x-1/2 -translate-y-1/2 pointer-events-none"
                style={markerPct}
              >
                <span className="absolute -inset-3 rounded-full border-2 border-yellow-400" />
                <span className="absolute left-1/2 top-1/2 w-2 h-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-yellow-400" />
              </div>
            )}
          </div>
        </div>

        {/* Timeline and frame */}
        <div className="space-y-1">
          {loadFailed && (
            <p className="text-[10px] text-yellow-400">
              The browser could not open this file (unsupported container) — select the face
              using the rule in the left panel.
            </p>
          )}
          <input
            type="range"
            min={0}
            max={Math.max(duration, 0.01)}
            step={1 / (fps > 0 ? fps : 24)}
            value={Math.min(time, duration || 0)}
            onChange={(e) => seek(parseFloat(e.target.value))}
            className="w-full accent-yellow-400"
            aria-label="Video position"
          />
          <div className="flex items-center justify-between text-[10px] text-muted-foreground font-mono">
            <span>{fmtTime(time)} / {fmtTime(duration)}</span>
            <span className="text-yellow-400">
              frame {frameOf(time)}{frames > 0 ? ` of ${frames}` : ''}
              {marker ? ` · point on frame ${marker.frame}` : ''}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={togglePlay} className="h-8 px-3 gap-1.5 text-xs">
            {playing ? <PauseIcon className="w-3.5 h-3.5" /> : <PlayIcon className="w-3.5 h-3.5" />}
            {playing ? 'Pause' : 'Play'}
          </Button>
          <div className="flex-1" />
          {marker && (
            <>
              <span className="text-[10px] text-muted-foreground font-mono">
                X {marker.x} · Y {marker.y}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { setMarker(null); onClear(); onOpenChange(false) }}
                className="h-8 px-2 gap-1 text-xs text-muted-foreground"
                title="Reset point and revert to rule"
              >
                <XIcon className="w-3.5 h-3.5" />
                Reset
              </Button>
            </>
          )}
          <Button
            size="sm"
            onClick={() => onOpenChange(false)}
            className="h-8 px-4 text-xs bg-yellow-500 hover:bg-yellow-400 text-black border-0 font-medium"
          >
            Done
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
