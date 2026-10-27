'use client'

/**
 * ConsoleDialog — "Console" panel (edit 567): all real console output
 * of the application inside the UI: server.js, ComfyUI, and the Electron process itself.
 *
 * Source — circular buffer in the main process (electron/main.js, captured
 * via pipe) → preload window.h3desktop.console: full text on request +
 * live appends (400ms batch). The physical console from start.bat
 * continues to receive everything as well.
 *
 * Buttons: "Copy all" (clipboard) and "Save to file" (native
 * save file dialog; in browser fallback — download .txt).
 * In browser mode (without Electron), console is unavailable — informative placeholder.
 */
import { useEffect, useRef, useState } from 'react'
import { CopyIcon, SaveIcon, Loader2Icon } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

const RENDERER_CAP = 1_500_000

export function ConsoleDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [text, setText] = useState('')
  const [available, setAvailable] = useState<boolean | null>(null)
  const [saving, setSaving] = useState(false)
  const preRef = useRef<HTMLPreElement>(null)
  const stickRef = useRef(true)

  useEffect(() => {
    const api = window.h3desktop?.console
    setAvailable(!!api)
    if (!api || !open) return
    let alive = true
    setText('')
    stickRef.current = true
    void api.get().then((t) => { if (alive) setText(t) })
    const off = api.onAppend((ops) => {
      setText((prev) => {
        // (edit 588) Apply batch operations in order — same semantics
        // as the ring buffer in the main process: 'a' — append, 'r' —
        // overwrite from start of last line (\r overwrite, as in console:
        // older longer tail remains visible, tqdm pads with spaces).
        let next = prev
        for (const [op, text] of ops) {
          if (op === 'r') {
            const nl = next.lastIndexOf('\n')
            const oldLine = next.slice(nl + 1)
            // Overwrite tail of old line with spaces (like clear-to-line-end):
            // a shorter new line does not leave ghost characters of the previous line.
            const pad = oldLine.length > text.length ? ' '.repeat(oldLine.length - text.length) : ''
            next = next.slice(0, nl + 1) + text + pad
          } else {
            next += text
          }
        }
        return next.length > RENDERER_CAP ? next.slice(-1_400_000) : next
      })
    })
    return () => { alive = false; off() }
  }, [open])

  // Auto-scroll to tail while user is at the bottom (like assistant stream).
  useEffect(() => {
    const el = preRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [text])

  const lineCount = text ? text.split('\n').length : 0

  const copyAll = async () => {
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      toast.success(`Copied: ${lineCount} log lines`)
    } catch {
      toast.error('Failed to copy to clipboard')
    }
  }

  const saveToFile = async () => {
    if (!text || saving) return
    setSaving(true)
    try {
      const api = window.h3desktop?.console
      if (api) {
        const r = await api.save(text)
        if (r.ok) toast.success(`Log saved: ${r.path}`)
        else if (!r.canceled) toast.error(r.error || 'Failed to save file')
      } else {
        // Browser fallback — download .txt (console is not available there,
        // but kept as working path for potential future sources).
        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `h3-studio-console-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`
        a.click()
        URL.revokeObjectURL(url)
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* (edit 568/570) Width: MUST use sm:max-w — base DialogContent
          brings sm:max-w-lg (512px) which overrides max-w without sm: prefix
          (different variants in tailwind-merge) — caused window to be narrow.
          Pattern matches settings dialog: w + max-w + sm:max-w. */}
      <DialogContent
        className="w-[95vw] max-w-[95vw] sm:max-w-[1200px] h-[82vh] flex flex-col p-0 gap-0 overflow-hidden"
      >
        <DialogHeader className="shrink-0 flex-row items-center justify-between gap-3 border-b border-border px-4 py-2 pr-12 text-left">
          <div className="flex min-w-0 flex-1 items-baseline gap-3">
            <DialogTitle className="shrink-0 text-base font-semibold">Console</DialogTitle>
            <DialogDescription className="min-w-0 truncate text-xs">
              All application output: web server, ComfyUI, and window process
              {lineCount > 0 && ` · ${lineCount.toLocaleString('en-US')} lines`}
            </DialogDescription>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void copyAll()}
              disabled={!text}
              className="gap-1.5 text-xs"
            >
              <CopyIcon className="w-3.5 h-3.5" />
              Copy all
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void saveToFile()}
              disabled={!text || saving}
              className="gap-1.5 text-xs"
            >
              {saving ? <Loader2Icon className="w-3.5 h-3.5 animate-spin" /> : <SaveIcon className="w-3.5 h-3.5" />}
              Save to file…
            </Button>
          </div>
        </DialogHeader>

        {available === false ? (
          <div className="flex-1 flex items-center justify-center p-6">
            <div className="max-w-md text-center space-y-2">
              <p className="text-sm text-muted-foreground">
                Console is available in desktop window mode (Electron).
              </p>
              <p className="text-xs text-muted-foreground/70">
                In browser mode, view logs in the launch console (start.bat).
              </p>
            </div>
          </div>
        ) : (
          <pre
            ref={preRef}
            onScroll={(e) => {
              const el = e.currentTarget
              stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
            }}
            className={cn(
              'select-text flex-1 min-h-0 min-w-0 max-w-full overflow-y-auto overflow-x-hidden px-4 py-3 m-0',
              'text-[11px] leading-[1.45] font-mono text-foreground/85 bg-[#0d0d10]',
              'whitespace-pre-wrap wrap-anywhere',
            )}
          >
            {text || '…'}
          </pre>
        )}
      </DialogContent>
    </Dialog>
  )
}
