'use client'

/**
 * VoiceInputButton — circular microphone button INSIDE the text field
 * (overlay on top of it, in the bottom right corner) — similar to messaging apps.
 *
 * Click:
 *  idle       → start recording (STT model starts automatically on first call
 *               if not already running);
 *  recording  → stop and transcribe; text is passed to onText;
 *  processing → spinner (CPU transcription can take several seconds).
 *
 * Hotkey: R key — toggle dictation button: press to record, press again to stop
 * and insert text. Ignored during typing in input fields and when Ctrl/Alt/Meta
 * are pressed.
 *
 * Positioning: parent container must be `relative`;
 * the button positions itself as `absolute bottom-2 right-2`.
 * For usage outside inputs (e.g. settings test) — use `variant="inline"`.
 */
import { useEffect, useRef, useState } from 'react'
import { MicIcon, Loader2Icon, SquareIcon } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { useVoiceDictation } from '@/lib/use-voice-dictation'

/* ─── Hotkey: R key ───
 * Physical key KeyR (regardless of active layout).
 * Global single listener; owner is the latest mounted VoiceInputButton
 * with hotkey enabled (top of stack). If any button is already recording
 * or processing, the key goes to that button (stop + insert). */
interface HotkeyEntry {
  run: () => void
  /** true — instance is recording or processing. */
  active: () => boolean
}
const hotkeyStack: HotkeyEntry[] = []
let hotkeyBound = false

function ensureHotkeyBound(): void {
  if (hotkeyBound || typeof window === 'undefined') return
  hotkeyBound = true
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyR' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return
    if (e.isComposing) return
    const t = e.target as HTMLElement | null
    if (
      t &&
      (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')
    ) return
    let pick = hotkeyStack[hotkeyStack.length - 1]
    if (!pick || !pick.active()) {
      const busy = hotkeyStack.find((en) => en.active())
      if (busy) pick = busy
    }
    if (!pick) return
    e.preventDefault()
    pick.run()
  })
}

interface VoiceInputButtonProps {
  /** Callback for recognized text. */
  onText: (text: string) => void
  disabled?: boolean
  className?: string
  title?: string
  /**
   * 'overlay' (default) — circular button overlaying input field
   * (absolute bottom-2 right-2; parent must be relative);
   * 'inline' — static circular button in flow (e.g. test in settings).
   */
  variant?: 'overlay' | 'inline'
  /**
   * Enable hotkey R: press to start dictation, press again to stop and insert text.
   * Does not trigger while typing in an input field, or with Ctrl/Alt/Meta.
   */
  hotkey?: boolean
}

export function VoiceInputButton({
  onText,
  disabled,
  className,
  title,
  variant = 'overlay',
  hotkey = false,
}: VoiceInputButtonProps) {
  const { state, start, stop } = useVoiceDictation()
  // STT toggle in settings (stt.enabled)
  const [sttOn, setSttOn] = useState(true)
  useEffect(() => {
    fetch('/api/config')
      .then((r) => r.json())
      .then((d: { stt_enabled?: boolean }) => setSttOn(d.stt_enabled !== false))
      .catch(() => {})
  }, [])
  const toggleRef = useRef<() => void>(() => {})
  const busyRef = useRef(false)
  busyRef.current = state === 'recording' || state === 'processing'

  const handleClick = async () => {
    if (state === 'processing') return
    if (state === 'recording') {
      const { text, error: stopError } = await stop()
      if (text) {
        onText(text)
        toast.success('Voice input: text added')
      } else if (stopError) {
        toast.error(stopError)
      }
      return
    }
    if (state === 'idle') {
      try {
        await start()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err))
      }
    }
  }

  toggleRef.current = handleClick

  // Register hotkey in stack
  useEffect(() => {
    if (!hotkey || disabled) return
    ensureHotkeyBound()
    const entry: HotkeyEntry = {
      run: () => { void toggleRef.current() },
      active: () => busyRef.current,
    }
    hotkeyStack.push(entry)
    return () => {
      const i = hotkeyStack.lastIndexOf(entry)
      if (i >= 0) hotkeyStack.splice(i, 1)
    }
  }, [hotkey, disabled])

  const recording = state === 'recording'
  const processing = state === 'processing'
  const hk = hotkey ? ' · R' : ''

  // STT disabled in settings — don't render dictation button
  if (!sttOn) return null

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled || processing}
      title={
        title
        ?? (recording
          ? `Stop recording${hk ? ` (${hk.trim()})` : ''}`
          : processing
            ? 'Transcribing…'
            : `Voice input — click to speak${hk ? ` (hotkey ${hk.trim()})` : ''}`)
      }
      aria-label="Voice input"
      className={cn(
        'inline-flex items-center justify-center rounded-full border transition-all select-none',
        variant === 'overlay'
          ? 'absolute bottom-2 right-2 z-10 h-8 w-8 shadow-sm backdrop-blur-sm'
          : 'h-8 w-8',
        recording
          ? 'border-red-500/60 bg-red-500/20 text-red-300 animate-pulse'
          : processing
            ? 'border-amber-500/50 bg-amber-500/15 text-amber-300 cursor-wait'
            : 'border-border bg-[var(--surface-2)]/80 text-muted-foreground hover:text-foreground hover:bg-[var(--surface-3)]',
        disabled && 'opacity-40 cursor-not-allowed',
        className,
      )}
    >
      {processing ? (
        <Loader2Icon className="w-4 h-4 animate-spin" />
      ) : recording ? (
        <SquareIcon className="w-3.5 h-3.5 fill-current" />
      ) : (
        <MicIcon className="w-4 h-4" />
      )}
    </button>
  )
}
