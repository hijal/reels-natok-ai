'use client'

/**
 * A full-screen modal editor for long prompts.
 * Left: large highlighted textarea (MentionTextarea) + live quality checklist.
 * Right: insert panel — reference tag buttons, "+ dialogue" (<d>…</d>),
 * cinema vocabulary chips and scene skeletons from the Learn guide.
 */
import { useState, useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  PencilLineIcon,
  TagsIcon,
  MessageSquareQuoteIcon,
  CameraIcon,
  LayoutTemplateIcon,
  CopyIcon,
  TrashIcon,
  WrapTextIcon,
  HistoryIcon,
  SparklesIcon,
  WandSparklesIcon,
  StarIcon,
  XIcon,
  Trash2Icon,
} from 'lucide-react'
import {
  MentionTextarea,
  type MentionItem,
  type MentionTextareaHandle,
} from './mention-textarea'
import { PromptQuality } from './prompt-quality'
import { CAMERA_WORDS, EXAMPLES } from './learn/prompt-guide'
import { usePromptHistory } from '@/lib/prompt-history-store'
import { useImprovePrompt, type ImprovePromptOptions } from '@/hooks/use-improve-prompt'
import { VoiceInputButton } from './voice-input-button'
import { cn } from '@/lib/utils'

interface PromptEditorDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialText: string
  onSave: (text: string) => void
  /** Optional "save & immediately start generation" action (Ctrl+Enter). */
  onSaveAndRun?: (text: string) => void
  placeholder?: string
  mentions?: MentionItem[]
  /** Options for "Improve Prompt": request goes to extend chat or generate chat */
  improveOptions?: ImprovePromptOptions
}

type RightTab = 'insert' | 'history' | 'examples'

/** Scene skeletons following the guide's formula (WHO→WHAT→WHERE→LIGHT→CAMERA→LINES).
 *  English — the model follows English noticeably better; bracket hints
 *  [in brackets] are placeholders for the user to fill in. */
const SKELETONS: Array<{ label: string; text: string }> = [
  {
    label: 'Portrait',
    text: 'A character with <Picture 1> [what they are doing], [place, time of day], [lighting and mood]. The camera [movement/shot]. He/She says: <d>short line.</d>',
  },
  {
    label: 'Scene',
    text: 'A character with <Picture 1> [action] in [location from <Video 1>], [surrounding details], [light]. The camera [movement]. Sounds: [background sounds].',
  },
  {
    label: 'Dialogue',
    text: 'A character with <Picture 1> [scene context and place]. He/She says: <d>first short line.</d> A pause, [reaction/gesture]. Then: <d>second line.</d>',
  },
]

export function PromptEditorDialog({
  open,
  onOpenChange,
  initialText,
  onSave,
  onSaveAndRun,
  placeholder = 'Enter or edit prompt…',
  mentions,
  improveOptions,
}: PromptEditorDialogProps) {
  const [text, setText] = useState(initialText)
  const [rightTab, setRightTab] = useState<RightTab>('insert')
  const editorRef = useRef<MentionTextareaHandle>(null)

  // History + improve prompt
  const historyEntries = usePromptHistory((s) => s.entries)
  const toggleHistoryFavorite = usePromptHistory((s) => s.toggleFavorite)
  const removeHistoryEntry = usePromptHistory((s) => s.remove)
  const clearHistory = usePromptHistory((s) => s.clear)
  const improvePrompt = useImprovePrompt()

  // Sync text when dialog opens with new content
  useEffect(() => {
    if (open) setText(initialText)
  }, [open, initialText])

  const insert = (snippet: string) => editorRef.current?.insertAtCursor(snippet)

  /** Apply a full prompt (from history/examples) — replaces the current text. */
  const applyPrompt = (snippet: string) => {
    setText(snippet)
    toast.success('Prompt applied')
  }

  /** "Refine prompt": first ask what to change via modal input;
   *  prompt + request are sent to assistant chat. */
  const [fixOpen, setFixOpen] = useState(false)
  const [fixText, setFixText] = useState('')

  /** "Refine prompt" — open the "what to change" dialog. */
  const handleImprove = () => {
    if (!text.trim()) {
      toast.info('Prompt is empty', { description: 'Enter at least a few words so the LLM can refine it.' })
      return
    }
    setFixText('')
    setFixOpen(true)
  }

  /** Send: save draft, close editor, user instructions + current prompt
   *  are sent to the respective assistant chat. */
  const submitFix = () => {
    const req = fixText.trim()
    if (!req) return
    onSave(text)
    setFixOpen(false)
    improvePrompt(text, { ...improveOptions, fixRequest: req })
    // Close editor on separate tick to avoid Presence exit animation conflicts
    setTimeout(() => onOpenChange(false), 50)
  }

  const handleSave = () => {
    onSave(text)
    onOpenChange(false)
  }

  const handleSaveAndRun = () => {
    onSave(text)
    onOpenChange(false)
    onSaveAndRun?.(text)
  }

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success('Prompt copied to clipboard')
    } catch {
      toast.error('Failed to copy')
    }
  }

  // Ctrl+Enter inside the editor = save (+run when wired)
  const handleKeyDownFs = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault()
      if (onSaveAndRun) handleSaveAndRun()
      else handleSave()
    }
  }

  const panelBlock = (
    icon: React.ReactNode,
    title: string,
    children: React.ReactNode,
  ) => (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 text-muted-foreground">
        {icon}
        <span className="text-[10px] font-medium uppercase tracking-wide">{title}</span>
      </div>
      {children}
    </div>
  )

  return (
    <>
    {/* Two independent sibling dialogs */}
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[56vw] sm:max-w-[56vw] w-full h-[85vh] flex flex-col p-0 gap-0">
        <DialogHeader className="px-4 pt-3 pb-2 border-b border-border shrink-0 flex items-center justify-between">
          <div>
            <DialogTitle className="text-base font-semibold">
              Prompt Editor
            </DialogTitle>
            {mentions && mentions.length > 0 && (
              <p className="text-[10px] text-muted-foreground mt-0.5">
                Type <span className="font-mono text-foreground/80">@</span> to insert reference
              </p>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground mr-2">{text.length} characters</span>
            {/* "Refine prompt" — opens task dialog */}
            <button
              type="button"
              onClick={handleImprove}
              title="Send to LLM assistant with instructions on what to change"
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium bg-gradient-to-r from-violet-500/20 to-fuchsia-500/20 text-violet-300 border border-violet-500/30 hover:from-violet-500/30 hover:to-fuchsia-500/30 transition-colors"
            >
              <WandSparklesIcon className="w-3.5 h-3.5" />
              Refine prompt
            </button>
            {/* Mini-toolbar: wrap selection · copy · clear */}
            <button
              type="button"
              onClick={() => editorRef.current?.wrapSelection('<d>', '</d>')}
              title="Wrap selection in <d>…</d>"
              className="p-1.5 rounded-md text-muted-foreground hover:text-amber-300 hover:bg-amber-500/10 transition-colors"
            >
              <WrapTextIcon className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={copyPrompt}
              title="Copy prompt"
              className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-[var(--surface-3)] transition-colors"
            >
              <CopyIcon className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => setText('')}
              title="Clear"
              className="p-1.5 rounded-md text-muted-foreground hover:text-red-400 hover:bg-red-500/10 transition-colors"
            >
              <TrashIcon className="w-4 h-4" />
            </button>
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            {onSaveAndRun ? (
              <Button
                size="sm"
                onClick={handleSaveAndRun}
                className="bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white border-0 font-semibold"
                title="Ctrl+Enter"
              >
                Save and Run
              </Button>
            ) : null}
            <Button size="sm" variant={onSaveAndRun ? 'outline' : 'default'} onClick={handleSave}>
              Save
            </Button>
          </div>
        </DialogHeader>

        <div className="flex-1 min-h-0 flex flex-col lg:flex-row gap-2 px-3 py-2">
          {/* Editor + quality checklist */}
          <div className="flex-1 min-h-0 flex flex-col gap-2">
            {/* Microphone inside editor */}
            <div className="relative flex-1 min-h-0">
              <MentionTextarea
                ref={editorRef}
                value={text}
                onChange={setText}
                onKeyDown={handleKeyDownFs}
                placeholder={placeholder}
                mentions={mentions}
                className="w-full h-full resize-none rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/50 pr-10"
              />
              <VoiceInputButton
                hotkey
                onText={(t) => editorRef.current?.insertAtCursor(t)}
                title="Voice input — insert at cursor"
              />
            </div>
            <PromptQuality prompt={text} refsCount={mentions?.length ?? 0} className="shrink-0" />
          </div>

          {/* Right panel: insert / history / examples */}
          <aside className="w-full lg:w-[300px] shrink-0 rounded-lg border border-border bg-[var(--surface-1)]/70 flex flex-col max-h-[38vh] lg:max-h-none p-5">
            {/* Right-panel tabs */}
            <div className="flex items-center gap-1 p-1 rounded-lg bg-[var(--surface-2)]/60 border border-border mb-3 shrink-0">
              {([
                ['insert', 'Insert', <TagsIcon key="i" className="w-3.5 h-3.5" />],
                ['history', 'History', <HistoryIcon key="h" className="w-3.5 h-3.5" />],
                ['examples', 'Examples', <SparklesIcon key="e" className="w-3.5 h-3.5" />],
              ] as const).map(([id, label, icon]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setRightTab(id)}
                  className={cn(
                    'flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium transition-colors',
                    rightTab === id
                       ? 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/30'
                       : 'text-muted-foreground border border-transparent hover:text-foreground',
                  )}
                >
                  {icon}
                  {label}
                </button>
              ))}
            </div>
            {rightTab === 'insert' && (
              <div className="flex-1 overflow-y-auto space-y-4 min-h-0 px-1">
            {panelBlock(<TagsIcon className="w-3.5 h-3.5" />, 'References (insert tag)', (
              <div className="flex flex-wrap gap-1.5">
                {(mentions ?? []).map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => insert(m.trigger)}
                    title={m.label}
                    className="px-2 py-1 rounded-md text-[10px] font-mono border border-border bg-[var(--surface-2)] hover:border-cyan-500/40 hover:text-cyan-300 transition-colors"
                  >
                    {m.trigger.replace(/[<>]/g, '')}
                  </button>
                ))}
                {(!mentions || mentions.length === 0) && (
                  <p className="text-[10px] text-muted-foreground/70">Upload references in the generation tab.</p>
                )}
              </div>
            ))}

            {panelBlock(<MessageSquareQuoteIcon className="w-3.5 h-3.5" />, 'Dialogue (voiceover)', (
              <div className="space-y-1">
                <button
                  type="button"
                  onClick={() => insert('<d>character dialogue</d>')}
                  className="w-full px-2 py-1.5 rounded-md text-xs border border-amber-500/30 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 transition-colors"
                >
                  + &lt;d&gt;…&lt;/d&gt;
                </button>
                <button
                  type="button"
                  onClick={() => editorRef.current?.wrapSelection('<d>', '</d>')}
                  className="w-full px-2 py-1.5 rounded-md text-xs border border-amber-500/20 text-amber-300/80 hover:bg-amber-500/10 transition-colors"
                  title="Select text in prompt and click"
                >
                  Wrap selection in &lt;d&gt;
                </button>
              </div>
            ))}

            {panelBlock(<CameraIcon className="w-3.5 h-3.5" />, 'Camera & Lighting', (
              <div className="flex flex-wrap gap-1">
                {CAMERA_WORDS.map((w) => (
                  <button
                    key={w}
                    type="button"
                    onClick={() => insert(w)}
                    className="px-1.5 py-0.5 rounded-full border border-border bg-[var(--surface-2)]/70 text-[10px] text-foreground/80 hover:border-cyan-500/40 hover:text-cyan-300 transition-colors"
                  >
                    {w}
                  </button>
                ))}
              </div>
            ))}

            {panelBlock(<LayoutTemplateIcon className="w-3.5 h-3.5" />, 'Scene Templates', (
              <div className="space-y-1">
                {SKELETONS.map((s) => (
                  <button
                    key={s.label}
                    type="button"
                    onClick={() => insert(s.text)}
                    className="w-full text-left px-2 py-1.5 rounded-md text-xs border border-border bg-[var(--surface-2)]/70 text-foreground/85 hover:border-cyan-500/40 transition-colors"
                  >
                    {s.label} <span className="text-muted-foreground/60">— insert skeleton</span>
                  </button>
                ))}
              </div>
            ))}
              </div>
            )}

            {/* ─── HISTORY TAB ─── */}
            {rightTab === 'history' && (
              <div className="flex-1 overflow-y-auto min-h-0 space-y-1">
                <div className="flex items-center justify-between px-1 py-1.5 border-b border-border sticky top-0 bg-[var(--surface-1)]">
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
                  <p className="px-2 py-4 text-xs text-muted-foreground text-center">
                    Empty for now — executed prompts are saved here automatically.
                  </p>
                )}
                {historyEntries.map((e) => (
                  <div
                    key={e.id}
                    className="group flex items-start gap-2 px-2 py-1.5 hover:bg-white/5 cursor-pointer rounded-md"
                    onClick={() => applyPrompt(e.text)}
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
              </div>
            )}

            {/* ─── EXAMPLES TAB ─── */}
            {rightTab === 'examples' && (
              <div className="flex-1 overflow-y-auto min-h-0 space-y-1">
                <div className="px-1 py-1.5 border-b border-border sticky top-0 bg-[var(--surface-1)]">
                  <span className="text-[10px] font-semibold text-foreground">Ready-made Examples</span>
                </div>
                {EXAMPLES.map((ex) => (
                  <div
                    key={ex.title}
                    className="px-2 py-1.5 hover:bg-white/5 cursor-pointer rounded-md"
                    onClick={() => applyPrompt(ex.text)}
                  >
                    <p className="text-xs font-medium text-foreground">{ex.title}</p>
                    <p className="text-[10px] text-muted-foreground/80 line-clamp-2 leading-snug break-words">
                      {ex.note}
                    </p>
                  </div>
                ))}
                <p className="px-2 py-2 text-[10px] text-muted-foreground/60 border-t border-border mt-2">
                  Replaces current prompt. Prompts are in English: model understands it best.
                </p>
              </div>
            )}
          </aside>
        </div>
      </DialogContent>
    </Dialog>

    {/* "What to change" window: opens via "Refine prompt" button.
        User request + current draft are sent to assistant chat (submitFix).
        Sibling of editor, not nested dialog. */}
    <Dialog open={fixOpen} onOpenChange={setFixOpen}>
      <DialogContent className="max-w-lg p-0 gap-0">
          <DialogHeader className="px-4 pt-4 pb-2 border-b border-border">
            <DialogTitle className="text-base font-semibold">Refine Prompt</DialogTitle>
            <DialogDescription className="text-xs leading-relaxed">
              Describe what you would like to change in this prompt
            </DialogDescription>
          </DialogHeader>
          <div className="p-4 space-y-3">
            <textarea
              autoFocus
              value={fixText}
              onChange={(e) => setFixText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setFixOpen(false)
                } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault()
                  submitFix()
                }
              }}
              rows={4}
              placeholder="For example: make the camera static, remove rain, make character dialogue shorter…"
              className="w-full resize-none rounded-xl border border-border bg-[var(--surface-2)] px-3.5 py-2.5 text-sm leading-5 text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-violet-500/50"
            />
            <p className="text-[10px] text-muted-foreground/70 leading-relaxed">
              Prompt and your request will be sent to the assistant chat of this tab — the response
              can be pasted back via "To Prompt". Ctrl+Enter to send, Esc to cancel.
            </p>
            <div className="flex items-center justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setFixOpen(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={submitFix}
                disabled={!fixText.trim()}
                className="gap-1.5 rounded-lg border border-violet-500/30 bg-violet-500/15 text-violet-200 hover:bg-violet-500/25 hover:border-violet-500/50 font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <WandSparklesIcon className="w-3.5 h-3.5" />
                Send to Assistant
              </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
    </>
  )
}

/**
 * Vertical column of prompt field buttons.
 * Flex container: strict column, consistent gap, no magic offsets.
 */
export function PromptFieldTools({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="absolute right-2 top-2 z-10 flex flex-col items-center gap-1.5"
      data-prompt-field-tools=""
    >
      {children}
    </div>
  )
}

/** "Refine prompt" — compact button above input field:
 * opens dialog asking "what to change" and sends current prompt + request
 * to assistant chat of this tab. */
export function PromptFixButton({
  onFix,
}: {
  /** Called on click. */
  onFix: () => void
}) {
  return (
    <button
      type="button"
      onClick={onFix}
      title="Refine prompt with assistant: write what to change — prompt and instructions will go to chat"
      className="p-1.5 rounded-md bg-[var(--surface-3)]/80 hover:bg-[var(--surface-4)] text-violet-300 hover:text-violet-200 transition-colors border border-violet-500/30 backdrop-blur-sm"
    >
      <WandSparklesIcon className="w-3.5 h-3.5" />
    </button>
  )
}

/** "Clear field" — compact button above input field. */
export function PromptClearButton({
  onClear,
  disabled,
}: {
  onClear: () => void
  /** true — prompt is empty: button not shown. */
  disabled?: boolean
}) {
  if (disabled) return null
  return (
    <button
      type="button"
      onClick={onClear}
      title="Clear prompt field"
      className="p-1.5 rounded-md bg-[var(--surface-3)]/80 hover:bg-red-500/15 text-muted-foreground hover:text-red-400 transition-colors border border-border/50 backdrop-blur-sm"
    >
      <Trash2Icon className="w-3.5 h-3.5" />
    </button>
  )
}

/**
 * A small button that triggers the PromptEditorDialog.
 * Place it next to a prompt textarea to open the editor.
 */
export function PromptEditButton({
  onOpen,
}: {
  onOpen: () => void
}) {
  return (
    <button
      onClick={onOpen}
      className="p-1.5 rounded-md bg-[var(--surface-3)] hover:bg-[var(--surface-4)] text-muted-foreground hover:text-foreground transition-colors border border-border/50"
      title="Open prompt editor"
    >
      <PencilLineIcon className="w-3.5 h-3.5" />
    </button>
  )
}

/** "Refine prompt" dialog: user describes what to change,
 * current prompt + request are sent to assistant chat of the tab. */
export function PromptFixDialog({
  open,
  onOpenChange,
  /** Called when submitting request. */
  onSubmit,
  hint,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (fixRequest: string) => void
  /** Contextual hint under input. */
  hint?: string
}) {
  const [text, setText] = useState('')

  // Reset text each time opened.
  useEffect(() => {
    if (open) setText('')
  }, [open])

  const submit = () => {
    const req = text.trim()
    if (!req) return
    onSubmit(req)
    onOpenChange(false)
    setTimeout(() => onOpenChange(false), 50)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg p-0 gap-0">
        <DialogHeader className="px-4 pt-4 pb-2 border-b border-border">
          <DialogTitle className="text-base font-semibold">Refine Prompt</DialogTitle>
          <DialogDescription className="text-xs leading-relaxed">
            Describe what you would like to change in this prompt
          </DialogDescription>
        </DialogHeader>
        <div className="p-4 space-y-3">
          <textarea
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                onOpenChange(false)
              } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault()
                submit()
              }
            }}
            rows={4}
            placeholder="For example: make the camera static, remove rain, make character dialogue shorter…"
            className="w-full resize-none rounded-xl border border-border bg-[var(--surface-2)] px-3.5 py-2.5 text-sm leading-5 text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-violet-500/50"
          />
          <p className="text-[10px] text-muted-foreground/70 leading-relaxed">
            {hint ?? 'Prompt and your request will be sent to the assistant chat of this tab — the response can be pasted back via "To Prompt". Ctrl+Enter to send, Esc to cancel.'}
          </p>
          <div className="flex items-center justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={submit}
              disabled={!text.trim()}
              className="gap-1.5 rounded-lg border border-violet-500/30 bg-violet-500/15 text-violet-200 hover:bg-violet-500/25 hover:border-violet-500/50 font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <WandSparklesIcon className="w-3.5 h-3.5" />
              Send to Assistant
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
