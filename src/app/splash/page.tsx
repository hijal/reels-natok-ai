'use client'

/**
 * Splash — splash screen while ComfyUI is loading.
 *
 * (fix 522) New design: instead of ONE video in the center — a "video wall"
 * of 8 9:16 cards (public/splash-videos/tile_01..08.mp4) that slowly
 * scroll down and loop infinitely. Cards without borders, labels, or
 * paddings — seamlessly stitched, serving as a live backdrop of cinematic
 * shots generated in this program.
 *
 * All original logic preserved:
 *  - polling ComfyUI readiness via /api/comfy/health every 2 s;
 *  - load timer (m:ss) + shimmer bar;
 *  - after ~5 min — honest warning that ComfyUI is taking longer to start;
 *  - on ready — "Ready — opening studio..." and router.replace('/').
 *
 * Styling is built on theme CSS variables (--surface-*, --foreground,
 * --splash-*) and follows light/dark app theme.
 */
import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

const POLL_MS = 2000
/** Delay on "Ready" before transitioning, ms. */
const EXIT_DELAY_MS = 700

/** 8 video tiles (public/splash-videos). 9:16, looped, muted. */
const SPLASH_TILES = [
  '/splash-videos/tile_01.mp4',
  '/splash-videos/tile_02.mp4',
  '/splash-videos/tile_03.mp4',
  '/splash-videos/tile_04.mp4',
  '/splash-videos/tile_05.mp4',
  '/splash-videos/tile_06.mp4',
  '/splash-videos/tile_07.mp4',
  '/splash-videos/tile_08.mp4',
]

export default function SplashPage() {
  const router = useRouter()
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const startedAt = useRef(Date.now())

  /* Frame order: shuffled on every screen load.
   * Shuffle ONE base order and duplicate it in both groups
   * (for seamless loop translateY 0 → -50% the groups must match).
   * Initialized with canonical order to prevent hydration mismatch;
   * shuffling occurs after mounting. */
  const [order, setOrder] = useState<string[]>(SPLASH_TILES)

  /* Autoplay all videos (muted so autoplay is not blocked). */
  useEffect(() => {
    const vids = Array.from(document.querySelectorAll<HTMLVideoElement>('.splash-tile video'))
    vids.forEach((v) => {
      v.play().catch(() => { /* autoplay may be blocked — silently ignore */ })
    })
  }, [])

  /* Shuffle frame order once after mount (Fisher–Yates).
   * Thanks to this, each splash load has a different tile order, but
   * duplication in both groups remains — scroll loop is seamless. */
  useEffect(() => {
    const a = [...SPLASH_TILES]
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[a[i], a[j]] = [a[j], a[i]]
    }
    setOrder(a)
  }, [])

  /* Poll ComfyUI readiness. Controller reference to prevent timers from
   * firing after unmount when transitioning to the application. */
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    // (fix 587) Also track transition timer to the app: without this,
    // leaving splash during the 700ms "Ready" window left a dangling setTimeout,
    // which after unmount forcibly redirected the app to '/'.
    let exitTimer: ReturnType<typeof setTimeout> | undefined

    const tick = async () => {
      try {
        const r = await fetch('/api/comfy/health', { signal: AbortSignal.timeout(8000) })
        if (!cancelled && r.ok) {
          const d = await r.json().catch(() => ({}))
          if (d.ok !== false) {
            setReady(true)
            exitTimer = setTimeout(() => router.replace('/'), EXIT_DELAY_MS)
            return
          }
        }
      } catch {
        /* ComfyUI is still loading (or web server itself is starting) — wait */
      }
      if (!cancelled) timer = setTimeout(tick, POLL_MS)
    }
    void tick()
    return () => {
      cancelled = true
      clearTimeout(timer)
      if (exitTimer) clearTimeout(exitTimer)
    }
  }, [router])

  /* Loading seconds counter — to show that everything is alive. */
  useEffect(() => {
    if (ready) return
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt.current) / 1000)), 1000)
    return () => clearInterval(id)
  }, [ready])

  /* ComfyUI did not come up after ~5 minutes — inform honestly, but keep waiting. */
  useEffect(() => {
    if (elapsed > 300 && !failed) setFailed(true)
  }, [elapsed, failed])

  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden bg-[var(--surface-0)]">
      {/* ── Live backdrop: "video wall" of 8 9:16 frames, scrolls down ── */}
      <div className="relative flex-1 min-h-0 overflow-hidden bg-[var(--surface-1)]">
        <div className="splash-scroll absolute inset-0">
          {/* Two identical groups for seamless loop (translateY 0 → -50%). */}
          <div className="splash-track">
            {[0, 1].map((set) => (
              <div key={set} className="splash-set" aria-hidden={set === 1}>
                {order.map((src) => (
                  <div key={`${set}-${src}`} className="splash-tile">
                    <video src={src} muted playsInline loop preload="auto" />
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>

        {/* Edge fade so the wall "dissolves" under panels. */}
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-24"
          style={{ background: 'linear-gradient(to bottom, var(--surface-0), transparent)' }}
        />
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 h-28"
          style={{ background: 'linear-gradient(to top, var(--surface-0), transparent)' }}
        />
      </div>

      {/* ── Top panel: brand on left, captions on right ── */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center justify-between px-8 py-5">
        <div className="flex items-center gap-3">
          <div
            className="flex h-9 w-9 items-center justify-center rounded-lg text-sm font-bold text-white"
            style={{ background: 'linear-gradient(135deg, var(--splash-a), var(--splash-b))', boxShadow: '0 0 20px -6px var(--splash-glow)' }}
          >
            H3
          </div>
          <div>
            <div className="text-[15px] font-semibold leading-tight" style={{ color: 'var(--foreground)' }}>
              MiniMax H3 Studio
            </div>
            <div className="text-[11px] uppercase tracking-wider" style={{ color: 'var(--muted-foreground)' }}>
              AI Video Generation
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3 text-xs" style={{ color: 'var(--muted-foreground)' }}>
          <span>by Evgen Rublev</span>
          <span className="opacity-50">·</span>
          <span className="font-medium">Comfy UI</span>
        </div>
      </div>

      {/* ── Loading status (as in previous splash) ── */}
      <div className="relative z-10 flex flex-col items-center gap-3 px-8 pb-3 pt-2">
        {ready ? (
          <div className="flex items-center gap-2 text-emerald-400">
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6 9 17l-5-5" />
            </svg>
            <span className="text-sm font-medium">Ready — opening studio…</span>
          </div>
        ) : (
          <>
            {/* Shimmer loading bar */}
            <div className="h-1 w-64 overflow-hidden rounded-full bg-[var(--surface-2)] relative">
              <div
                className="absolute inset-y-0 w-1/3 rounded-full animate-[splash-slide_1.6s_ease-in-out_infinite]"
                style={{ background: 'linear-gradient(90deg, transparent, var(--splash-a), transparent)' }}
              />
            </div>
            <p className="flex items-center gap-2 text-xs tabular-nums" style={{ color: 'var(--muted-foreground)' }}>
              <span
                className="inline-block h-1.5 w-1.5 rounded-full animate-[splash-pulse_1.5s_ease-in-out_infinite]"
                style={{ background: 'var(--splash-a)' }}
              />
              {failed
                ? 'ComfyUI is taking longer than usual to start — see console window for details…'
                : 'Loading ComfyUI…'}
              <span className="opacity-50">·</span>
              <span className="font-semibold" style={{ color: 'var(--foreground)' }}>
                {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}
              </span>
            </p>
          </>
        )}
      </div>

      {/* Animation keyframes (locally, without polluting globals.css classes). */}
      <style>{`
        .splash-scroll { overflow: hidden; }
        .splash-track {
          display: flex;
          flex-direction: column;
          animation: splash-wall 80s linear infinite;
          will-change: transform;
        }
        .splash-set {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 0;
        }
        .splash-tile { position: relative; aspect-ratio: 9 / 16; overflow: hidden; background: var(--surface-1); }
        .splash-tile video { width: 100%; height: 100%; object-fit: cover; display: block; }

        @keyframes splash-wall {
          0% { transform: translateY(0); }
          100% { transform: translateY(-50%); }
        }
        @keyframes splash-slide {
          0% { left: -35%; }
          100% { left: 100%; }
        }
        @keyframes splash-pulse {
          0%, 100% { opacity: 0.4; transform: scale(1); }
          50% { opacity: 1; transform: scale(1.3); }
        }
      `}</style>
    </div>
  )
}
