'use client'

/**
 * DesktopTitleBar — slim window titlebar replacing native Windows titlebar
 * (edit 562; buttons — edit 563). Operates ONLY within an Electron window:
 *   • electron/main.js sets titleBarStyle:'hidden' — no native buttons;
 *   • custom HTML buttons manage window via preload-IPC (window.h3desktop):
 *     no background plate, matched to app theme, hover lighting;
 *   • on splash (/splash) — ONLY a small close button; in the app
 *     itself — all three (minimize/maximize/close);
 *   • entire bar is draggable window region (-webkit-app-region: drag,
 *     class .h3-titlebar in globals.css), double-click = maximize toggle;
 *   • not rendered in a standard browser (fallback start.bat without Electron).
 *
 * Titlebar background — constant #1c1c20: unified window chrome in all themes;
 * content below follows its own theme.
 */
import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { MinusIcon, SquareIcon, XIcon } from 'lucide-react'

const isElectron = () =>
  typeof navigator !== 'undefined' && /electron/i.test(navigator.userAgent)

/** Window button: no background, slim glyph, soft hover highlight. */
function CaptionButton({
  onClick,
  title,
  children,
  danger,
}: {
  onClick: () => void
  title: string
  children: React.ReactNode
  danger?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={
        'h3-no-drag h-full w-11 flex items-center justify-center text-[#8b8b94] transition-colors ' +
        (danger
          ? 'hover:bg-red-500/80 hover:text-white'
          : 'hover:bg-white/10 hover:text-white')
      }
    >
      {children}
    </button>
  )
}

export function DesktopTitleBar() {
  // SSR/hydration: userAgent on server is not Electron -> render after mount.
  const [show, setShow] = useState(false)
  useEffect(() => setShow(isElectron()), [])
  const pathname = usePathname()
  if (!show) return null

  const api = (window as Window & typeof globalThis & {
    h3desktop?: { minimize: () => void; maximizeToggle: () => void; close: () => void }
  }).h3desktop
  if (!api) return null

  // (edit 563) Splash screen waiting for backend — only close button, small.
  const isSplash = pathname === '/splash'

  return (
    <header
      className="h3-titlebar h-9 shrink-0 flex items-center gap-2.5 pl-3 bg-[#1c1c20] border-b border-black/40 select-none"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      onDoubleClick={() => api.maximizeToggle()}
    >
      <img src="/logo.svg" alt="" width={16} height={16} className="shrink-0" draggable={false} />
      <span className="text-[11px] font-medium tracking-wide text-[#8b8b94] select-none">
        MiniMax H3 Studio 7
      </span>
      <span className="flex-1" />

      {isSplash ? (
        /* Splash: small close icon only. */
        <button
          type="button"
          onClick={() => api.close()}
          title="Close"
          className="h3-no-drag h-7 w-8 mr-1 flex items-center justify-center rounded-md text-[#8b8b94] hover:bg-red-500/80 hover:text-white transition-colors"
        >
          <XIcon className="w-3.5 h-3.5" />
        </button>
      ) : (
        /* Application: minimize / maximize / close. */
        <div className="h-full flex items-stretch">
          <CaptionButton onClick={() => api.minimize()} title="Minimize">
            <MinusIcon className="w-3.5 h-3.5" />
          </CaptionButton>
          <CaptionButton onClick={() => api.maximizeToggle()} title="Maximize / Restore">
            <SquareIcon className="w-3 h-3" />
          </CaptionButton>
          <CaptionButton onClick={() => api.close()} title="Close" danger>
            <XIcon className="w-4 h-4" />
          </CaptionButton>
        </div>
      )}
    </header>
  )
}
