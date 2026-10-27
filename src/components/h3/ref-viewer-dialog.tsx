'use client'

/**
 * Reference viewer — fullscreen reference preview
 * (image / video with player / audio with trim editor).
 * Source file — ComfyUI input/ (or local staging) via
 * /api/comfy/file, so staged refs are available offline.
 *
 * Audio: integrated trim editor (start/end in seconds).
 * Trimming is VIRTUAL: values go to workflow (AudioTrim node cuts
 * tensor), no trimmed file copies are created.
 *
 * Modeled after video player (video-lightbox.tsx):
 *   • true fullscreen — fixed inset-0;
 *   • no Dialog frame: no border, no radius, no extra overlay — just black screen;
 *   • top gradient bar with filename and close button, auto-hides on mouse idle;
 *   • click on black background closes, Esc closes, wheel scrolls.
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { FilmIcon, ImageIcon, AudioLinesIcon, PlayIcon, PauseIcon, XIcon } from 'lucide-react'

export interface RefViewerData {
  kind: 'image' | 'video' | 'audio'
  name: string
  /** ComfyUI input/ filename (staged names are served too). */
  path: string
  /** Direct source URL (blob: preview of newly uploaded file not yet in input/).
   *  Prioritized over path. */
  url?: string
  /** Audio: current trim, seconds. trimEnd null/0 = to end. */
  trimStart?: number
  trimEnd?: number | null
  /** Audio: volume 0–1 (default 0.5) — virtual (AudioGain node). */
  audioVolume?: number
}

/** Format 0:00.0 for timestamps. */
function fmt(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = sec - m * 60
  return `${m}:${s.toFixed(1).padStart(4, '0')}`
}

/** Player + audio reference trimming. */
function AudioTrimEditor({
  src,
  trimStart,
  trimEnd,
  onTrimChange,
  /** Volume 0–1, default 0.5. */
  volume = 0.5,
  onVolumeChange,
}: {
  src: string
  trimStart?: number
  trimEnd?: number | null
  onTrimChange?: (start: number, end: number | null) => void
  /** Volume 0–1 (default 0.5), persisted to ref. */
  volume?: number
  onVolumeChange?: (v: number) => void
}) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const [duration, setDuration] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [pos, setPos] = useState(0)

  const start = Math.min(trimStart ?? 0, duration || Infinity)
  const end = trimEnd && trimEnd > 0 ? Math.min(trimEnd, duration || trimEnd) : duration

  // Auto-stop at selection end during playback.
  useEffect(() => {
    const el = audioRef.current
    if (!el || !playing) return
    const onTime = () => {
      setPos(el.currentTime)
      if (end > 0 && el.currentTime >= end) {
        el.pause()
        setPlaying(false)
      }
    }
    el.addEventListener('timeupdate', onTime)
    return () => el.removeEventListener('timeupdate', onTime)
  }, [playing, end])

  // Player volume = ref volume (persist).
  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = Math.max(0, Math.min(1, volume))
  }, [volume])

  const togglePlay = () => {
    const el = audioRef.current
    if (!el) return
    if (playing) {
      el.pause()
      setPlaying(false)
    } else {
      // Playback start — from selection start (or current point inside it)
      if (el.currentTime < start || (end > 0 && el.currentTime >= end)) el.currentTime = start
      void el.play()
      setPlaying(true)
    }
  }

  const changeStart = (v: number) => {
    const s = Math.max(0, Math.min(v, (end || duration) - 0.05))
    onTrimChange?.(Math.round(s * 100) / 100, trimEnd ?? null)
  }
  const changeEnd = (v: number) => {
    const e = Math.max(start + 0.05, Math.min(v, duration))
    // End = file duration -> null ("to end", no numbers)
    onTrimChange?.(start, duration > 0 && e >= duration - 0.005 ? null : Math.round(e * 100) / 100)
  }

  const trimmed = start > 0.004 || (trimEnd != null && trimEnd > 0)

  return (
    // Compact player: max-w-md (448px), gap-3, py-3; icon 12.
    <div className="w-full max-w-md flex flex-col items-center gap-3 py-3">
      <AudioLinesIcon className="w-12 h-12 text-emerald-400/60" />
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
        onEnded={() => setPlaying(false)}
      />

      {/* Play and Reset Trim are padded from edges. */}
      <div className="w-full px-4 flex items-center gap-3">
        <button
          type="button"
          onClick={togglePlay}
          className="w-9 h-9 rounded-full bg-emerald-500/20 border border-emerald-400/40 flex items-center justify-center text-emerald-300 hover:bg-emerald-500/30 transition-colors shrink-0"
          title={playing ? 'Pause' : 'Play selection'}
        >
          {playing ? <PauseIcon className="w-4 h-4" /> : <PlayIcon className="w-4 h-4 ml-0.5" />}
        </button>
        <span className="text-xs font-mono text-muted-foreground">
          {fmt(pos)} / {duration > 0 ? fmt(duration) : '…'}
        </span>
        {trimmed && (
          <button
            type="button"
            onClick={() => onTrimChange?.(0, null)}
            className="ml-auto text-[10px] text-red-300 hover:text-red-200 transition-colors"
          >
            Reset trim
          </button>
        )}
      </div>

      {/* Borderless card: padding only. */}
      {duration > 0 && (
        <div className="w-full space-y-2 px-4">
          <div className="space-y-1">
            <div className="flex justify-between text-[10px] text-muted-foreground">
              <span>Start</span>
              <span className="font-mono text-emerald-300">{fmt(start)}</span>
            </div>
            <input
              type="range"
              min={0}
              max={duration}
              step={0.01}
              value={start}
              onChange={(e) => changeStart(parseFloat(e.target.value))}
              className="w-full accent-emerald-500"
            />
          </div>
          <div className="space-y-1">
            <div className="flex justify-between text-[10px] text-muted-foreground">
              <span>End</span>
              <span className="font-mono text-emerald-300">{trimEnd == null ? `${fmt(duration)} (to end)` : fmt(end)}</span>
            </div>
            <input
              type="range"
              min={0}
              max={duration}
              step={0.01}
              value={end || duration}
              onChange={(e) => changeEnd(parseFloat(e.target.value))}
              className="w-full accent-emerald-500"
            />
          </div>
          {/* Ref volume: 0–100%, default 50%, persisted. */}
          <div className="space-y-1">
            <div className="flex justify-between text-[10px] text-muted-foreground">
              <span>Volume</span>
              <span className="font-mono text-emerald-300">{Math.round(volume * 100)}%</span>
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={volume}
              onChange={(e) => onVolumeChange?.(parseFloat(e.target.value))}
              className="w-full accent-emerald-500"
            />
          </div>
          <p className="text-[10px] text-muted-foreground/60">
            Reference will use fragment {fmt(start)} → {fmt(end || duration)} ({fmt(Math.max(0, (end || duration) - start))}).
            Virtual trimming — no duplicate files created.
          </p>
        </div>
      )}
    </div>
  )
}

export function RefViewerDialog({
  data,
  onOpenChange,
  onTrimChange,
  onVolumeChange,
}: {
  data: RefViewerData | null
  onOpenChange: (v: boolean) => void
  /** Audio: trim save callback (start, end|null). */
  onTrimChange?: (start: number, end: number | null) => void
  /** Audio: volume save callback (0–1). */
  onVolumeChange?: (v: number) => void
}) {
  const src = data
    ? data.url || `/api/comfy/file?filename=${encodeURIComponent(data.path)}&type=input`
    : ''

  // Auto-hide top controls — like video player.
  const [showControls, setShowControls] = useState(true)
  const controlsTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const close = () => onOpenChange(false)

  const handleMouseMove = () => {
    setShowControls(true)
    clearTimeout(controlsTimer.current)
    controlsTimer.current = setTimeout(() => setShowControls(false), 3000)
  }

  // Esc closes. Raw overlay requires custom key listener.
  useEffect(() => {
    if (!data) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [data, onOpenChange])

  // Clear auto-hide timer on unmount.
  useEffect(() => () => clearTimeout(controlsTimer.current), [])

  // Lock background scroll while viewer is open.
  useEffect(() => {
    if (!data) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [data])

  const content = (
    <AnimatePresence>
      {data && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[9999] bg-black flex flex-col"
          onMouseMove={handleMouseMove}
          onClick={(e) => {
            // Close only on black background click
            if (e.target === e.currentTarget) close()
          }}
        >
          {/* Fullscreen content, no margins or borders */}
          <div
            className="flex-1 relative flex items-center justify-center min-h-0 min-w-0 overflow-auto"
            onClick={(e) => {
              if (e.target === e.currentTarget) close()
            }}
          >
            {data.kind === 'image' && (
              <img
                src={src}
                alt={data.name}
                className="max-w-full max-h-full object-contain"
                draggable={false}
              />
            )}
            {data.kind === 'video' && (
              <video
                src={src}
                controls
                autoPlay
                loop
                playsInline
                className="max-w-full max-h-full"
              />
            )}
            {data.kind === 'audio' && (
              <div className="w-full h-full overflow-auto">
                <div className="w-full min-h-full flex items-center justify-center p-6">
                  <AudioTrimEditor
                    src={src}
                    trimStart={data.trimStart}
                    trimEnd={data.trimEnd}
                    onTrimChange={onTrimChange}
                    volume={data.audioVolume}
                    onVolumeChange={onVolumeChange}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Top controls — gradient, name on left, close on right; auto-hides on mouse idle. */}
          <div
            className={`absolute top-0 left-0 right-0 flex items-center justify-between gap-3 px-4 py-3 transition-opacity duration-300 ${
              showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'
            }`}
            style={{ background: 'linear-gradient(to bottom, rgba(0,0,0,0.7) 0%, transparent 100%)' }}
          >
            <div className="flex items-center gap-2 min-w-0">
              {data.kind === 'image' && <ImageIcon className="w-4 h-4 text-purple-400 shrink-0" />}
              {data.kind === 'video' && <FilmIcon className="w-4 h-4 text-cyan-400 shrink-0" />}
              {data.kind === 'audio' && <AudioLinesIcon className="w-4 h-4 text-emerald-400 shrink-0" />}
              <h3 className="text-sm text-white/90 font-medium truncate">{data.name}</h3>
            </div>
            <button
              type="button"
              onClick={close}
              className="p-2 rounded-lg bg-white/10 hover:bg-white/20 text-white transition-colors shrink-0"
              title="Close (Esc)"
            >
              <XIcon className="w-4 h-4" />
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )

  // Portal to document.body — avoids framer-motion transform clipping.
  return createPortal(content, document.body)
}
