'use client'

/**
 * AssistantView — local LLM chat tab (edit 24; multi-chat in edit 30).
 *
 * Runs Gemma 4 12B (GGUF Q4, multimodal) through the ComfyUI embedded python
 * (llama-cpp-python) — see tools/llm_server.py and src/lib/llm-runner.ts.
 * The system prompt is the MiniMax H3 prompt guide (H3_OFFICIAL_PROMPT_SPEC
 * in src/lib/h3-prompt-spec.ts, sourced from src/lib/prompt-guide.md),
 * enriched with live session context (loaded references with their numbers),
 * so the assistant can emit correct <Picture N> tags automatically — no
 * manual binding (edit 168). The prompt draft is NOT injected into the
 * system prompt: it was the cross-chat topic leak; "Enhance my prompt"
 * quotes the draft in the user's message explicitly when wanted.
 *
 * Chats live in the persisted assistant-chats store: multiple named
 * conversations, the active one is restored on mount, and the model
 * "remembers" a chat because its (capped) history is replayed with every
 * request.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import {
  BotIcon,
  SendIcon,
  SquareIcon,
  DownloadIcon,
  ArrowDownToLineIcon,
  SparklesIcon,
  WandSparklesIcon,
  PlusIcon,
  MessageSquareIcon,
  XIcon,
  PencilIcon,
  CopyIcon,
  CheckIcon,
  ChevronRightIcon,
  PaperclipIcon,
  FilmIcon,
  Trash2Icon,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { getClipboardImageFiles, hasClipboardImage } from '@/lib/paste-utils'
import { useGenStore } from '@/lib/gen-store'
import { useAssistantChats, type AssistantChatMessage, type AssistantChatMode } from '@/lib/assistant-chats-store'
import { useControlNetTarget } from '@/lib/controlnet-target-store' // (edit 502)
import {
  useAssistantStream,
  runAssistantCompletion,
  stopAssistantStream,
  stopStreamForChat,
  isStreamActive,
  type LlmStatusResp,
  type ChatAttachment,
} from '@/lib/assistant-stream'
import { uploadChatAttachment } from '@/lib/upload'
import { MentionTagWithPreview } from '@/components/h3/mention-preview'
import { VoiceInputButton } from '@/components/h3/voice-input-button'
// (edit 719) Attachment preview with full-screen viewer — matching "Generate".
import { RefPreviewThumb } from '@/components/h3/ref-preview-thumb'
import { parseAllFences, parseClipMarker, stripClipMarker, hasH3Field, extractInsertablePrompt } from '@/lib/assistant-fence'
import { MarkdownText } from '@/components/h3/assistant/markdown-text'
// (edit 719) Reference viewer on tag click — matching "Generate".
import { RefViewerDialog, type RefViewerData } from '@/components/h3/ref-viewer-dialog'
import { useAssistantDraft } from '@/lib/assistant-draft-store'
import { DEFAULT_LLM_MODEL_ID } from '@/components/h3/llm-model-selector' // (edit 268)
import { MODELS } from '@/lib/models-config'

/** Live download state derived from /api/models/status. */
interface DlInfo {
  active: boolean
  received: number
  total: number | null
  speed: number
  error: string | null
}

/**
 * Assistant model name for labels — from models config by status modelId,
 * falling back to default Qwen3.5 9B.
 * Custom model ('llm_custom') — by filename from status.
 */
function llmDisplayName(modelId?: string | null, modelName?: string | null): string {
  if (modelId === 'llm_custom') return modelName ? `custom: ${modelName}` : 'custom model (GGUF)'
  if (modelId === 'llm_assistant_bonsai') return 'Bonsai 2 27B'
  if (modelId === 'llm_assistant_bonsai_light') return 'Bonsai 2 27B (PTQ1_0)'
  if (modelId) {
    const m = MODELS.find((x) => x.id === modelId)
    if (m) return m.label
  }
  // Bonsai/Gemma/Qwen virtual ids may be absent from MODELS; the status
  // carries the real GGUF name, so do not fall back to the Qwen default.
  if (modelName) {
    if (/bonsai/i.test(modelName)) return 'Bonsai 2 27B'
    if (/gemma/i.test(modelName)) return 'Gemma 4 12B'
    if (/qwen/i.test(modelName)) return 'Qwen3.5 9B'
    return modelName
  }
  return 'Qwen3.5 9B (default)'
}

export function AssistantView({
  panelMode,
  onCollapse,
}: {
  /** (edit 442) Panel mode: chat mode is strictly bound to tab
   *  ('generate'/'extend'), mode switch in chat list is hidden,
   *  header is compact, chat list is a slide-out overlay over chat. */
  panelMode?: AssistantChatMode
  /** (edit 442) Button to collapse panel into narrow rail (in header). */
  onCollapse?: () => void
} = {}) {
  const inPanel = panelMode !== undefined
  // (edit 442) Chat list in panel is a slide-out overlay over chat (space is constrained).
  const [chatListOpen, setChatListOpen] = useState(false)
  /* ── chats (persisted store; hydrated on mount to stay SSR-safe) ── */
  const chats = useAssistantChats((s) => s.chats)
  // (edit 266) Reactive subscription to pendingImprove: if tab is already
  // mounted, neither streaming nor activeId change — without subscription the auto-start
  // effect would not re-run and the request would hang indefinitely.
  const pendingImprove = useAssistantChats((s) => s.pendingImprove)
  // (edit 427) Chat list mode filter: "Generate" / "Extend".
  const assistantMode = useAssistantChats((s) => s.assistantMode)
  const [activeId, setActiveId] = useState<string | null>(null)
  // (edit 427) ACTIVE chat mode: determines tag previews
  // (<Picture N> -> extendImageRefs in extend chats, refImages of
  // ControlNet tab in controlnet chats (edit 502)), fence card labels,
  // and insert button set ("To prompt" vs "To clip N").
  const activeChatMode: AssistantChatMode =
    chats.find((c) => c.id === activeId)?.mode ?? 'generate'
  const isExtendChat = activeChatMode === 'extend'
  // (edit 502)
  const isControlNetChat = activeChatMode === 'controlnet'
  // (edit 540) guide3d removed — motion transfer via ControlNet tab

  // (edit 256) Input/attachment draft in style store, not useState:
  // tabs unmount (AnimatePresence key={activeTab}) and local
  // state was lost when switching "Assistant -> Generate -> back".
  const input = useAssistantDraft((s) => s.input)
  const setInput = useAssistantDraft((s) => s.setInput)
  const [status, setStatus] = useState<LlmStatusResp | null>(null)
  const [dl, setDl] = useState<DlInfo>({ active: false, received: 0, total: null, speed: 0, error: null })
  // (edit 83) Actual size of selected LLM model (from /api/models/status)
  // instead of hardcoded "~5.7 GB" (Qwen ~5.7 GB, other quants have their own size).
  const [sizeLabel, setSizeLabel] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  // (edit 267) Stick to bottom: autoscroll only while user is near bottom
  // (<80px from bottom); scrolled up — stream does not reset it. See onScroll
  // of container and effect below.
  const stickToBottomRef = useRef(true)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [copiedPrompt, setCopiedPrompt] = useState<string | null>(null)

  /* ── (edit 86) Attachment to chat message (image / video) ── */
  const attachment = useAssistantDraft((s) => s.attachment)
  const setAttachment = useAssistantDraft((s) => s.setAttachment)
  const [attUploading, setAttUploading] = useState(false)
  const attFileRef = useRef<HTMLInputElement>(null)
  /**
   * (edit 717) Flag "sending in progress". isStreamActive() does not help in
   * attachment upload window (stream has not started), and fast buttons/Enter
   * could trigger a second send() — message was appended twice, while second
   * request was silently dropped by `if (running) return`.
   */
  const sendingRef = useRef(false)

  /* ── In-flight reply (edit 31: engine lives at module level) ──
   * Stream runs in src/lib/assistant-stream.ts and survives
   * unmounting of this tab (AnimatePresence). Here we only
   * "reconnect": while reply is in-flight in this chat — render live
   * tail; completed reply appears on its own, as messages below
   * are rendered reactively from persisted chats store. */
  const streamChatId = useAssistantStream((s) => s.chatId)
  const streamText = useAssistantStream((s) => s.text)
  const streaming = streamChatId !== null
  const streamingHere = streamChatId === activeId

  // (edit 719) Preview reference on click on <Picture N>/<Video N> tag
  // in assistant reply — matching "Generate" tab.
  const [viewingRef, setViewingRef] = useState<RefViewerData | null>(null)

  // Live references (for hover previews on <Picture N>/<Video N> tags).
  const refs = useGenStore((s) => s.video.refs)
  // (edit 587) Subscribe to non-empty prompt: button label "Refine my
  // prompt / Suggest ideas" previously read getState() during render — non-reactive,
  // label remained stale until an unrelated re-render.
  const hasPrompt = useGenStore((s) => s.video.prompt.trim().length > 0)
  // (edit 427) Extend mode: references and clips of "Extend" tab —
  // <Picture N> in extend chats are numbered by extendImageRefs, and buttons
  // "To clip N" — by extendClips count.
  const extendRefs = useGenStore((s) => s.video.extendImageRefs)
  const extendClipsCount = useGenStore((s) => s.video.extendClips.length)
  // (edit 502) ControlNet mode: <Picture N> are numbered by refImages
  // of "ControlNet" tab (controlnet-target-store).
  const controlnetRefs = useControlNetTarget((s) => s.refImages)
  // ControlNet chat quick button label: "Refine" makes sense only
  // when tab input already has a prompt; otherwise suggest creating from scratch.
  const controlnetHasPrompt = useControlNetTarget((s) => s.prompt.trim().length > 0)

  /** Build a preview URL for a reference by (kind, 1-based index).
   *  (edit 427) In extend chat <Picture N> corresponds to extendImageRefs of
   *  "Extend" tab, not refs of "Generate" tab.
   *  (edit 502) In controlnet chat — refImages of "ControlNet" tab. */
  const previewFor = useCallback(
    (kind: 'image' | 'video', index: number): { url?: string; label?: string; path?: string } => {
      // (edit 502) ControlNet: images only (refImages without kind field).
      if (isControlNetChat) {
        if (kind !== 'image') return {}
        const r = controlnetRefs[index - 1]
        if (!r) return {}
        const url =
          r.previewUrl ||
          (r.path ? `/api/comfy/file?filename=${encodeURIComponent(r.path)}&type=input` : undefined)
        return { url, label: r.name, path: r.path }
      }
      const source = isExtendChat ? extendRefs : refs
      const list = source.filter((r) => r.kind === kind)
      const r = list[index - 1]
      if (!r) return {}
      const url =
        r.previewUrl ||
        (r.path ? `/api/comfy/file?filename=${encodeURIComponent(r.path)}&type=input` : undefined)
      return { url, label: r.name, path: r.path }
    },
    [refs, extendRefs, controlnetRefs, isExtendChat, isControlNetChat],
  )

  /**
   * (edit 719) Click on <Picture N>/<Video N> tag in assistant reply —
   * full-screen reference viewer (matching "Generate" tab).
   */
  const openRefByTag = useCallback(
    (kind: 'image' | 'video', index: number) => {
      const info = previewFor(kind, index)
      if (!info.url && !info.path) return
      setViewingRef({
        kind,
        name: info.label || `Reference ${index}`,
        path: info.path ?? '',
        url: info.url,
      })
    },
    [previewFor],
  )

  /** Copy prompt to clipboard with visual feedback. */
  const copyPrompt = useCallback(
    async (prompt: string, id: string) => {
      try {
        await navigator.clipboard.writeText(prompt)
        setCopiedPrompt(id)
        toast.success('Prompt copied')
        setTimeout(() => setCopiedPrompt(null), 2000)
      } catch {
        toast.error('Failed to copy')
      }
    },
    [],
  )

  /**
   * Render chat message content with hover previews on <Picture N>/<Video N>
   * tags (audio excluded). Plain text passes through unchanged. The tags are
   * highlighted the same way as the Learn guide (purple/cyan) so the user
   * can still read them as tags, but hovering now shows the asset preview.
   *
   * If the message contains a ```text / ``` code-fence, everything inside
   * the fence is treated as "the prompt" and rendered with a distinct
   * background so the user can visually separate the LLM's explanation
   * from the actual prompt to copy.
   */
  const renderChatContent = useCallback(
    (rawText: string): React.ReactNode => {
      if (!rawText) return null

      // Fence parsing — single source of truth: src/lib/assistant-fence.ts
      // (edit 34). Fence in assistant reply = "prompt"; text BEFORE it
      // (preamble) and AFTER closing fence (trailing) is rendered with regular
      // muted text. parseAllFences also catches OPENING-only
      // fence during stream — card appears immediately and fills in,
      // instead of raw "```text" flashing as plain text.
      // (edit 427) parseAllFences returns ALL fences of message: in
      // extend chats model emits prompt of each clip in separate fence with
      // `clip: N` marker — card rendered for each. Single fence —
      // render is identical to legacy parseFence.
      const fences = parseAllFences(rawText)
      if (fences.length) {
        return (
          <div className="space-y-3">
            {fences.map((fence, fi) => {
              const fenceStreaming = fence.streaming
              // (edit 427) extend: `clip: N` marker as first line of fence —
              // show number in card label and strip line from body
              // (it won't be in clip card — stripClipMarker upon insertion).
              const clipMarker = isExtendChat ? parseClipMarker(fence.prompt) : null
              const prompt = clipMarker !== null ? stripClipMarker(fence.prompt) : fence.prompt
              // Render preamble (if any) with muted style, then the prompt
              // as plain text — (edit 444) without purple border/background and without
              // monospace font; only copy button,
              // clip label (extend) and streaming cursor remain.
              // (edit 88) Preamble/trailing and responses without fence render as
              // markdown (lists, bold, headings…); prompt text is plain,
              // with tag highlighting.
              const preambleNodes = fence.preamble ? (
                <MarkdownText text={fence.preamble} previewFor={previewFor} onRefClick={openRefByTag} />
              ) : null
              const trailingNodes = fence.trailing ? (
                <MarkdownText text={fence.trailing} previewFor={previewFor} onRefClick={openRefByTag} />
              ) : null
              return (
                <div key={fi} className="space-y-3">
                  {preambleNodes && (
                    <div className="text-sm leading-relaxed text-foreground/75">
                      {preambleNodes}
                    </div>
                  )}
                  {/* (edit 448) Thin divider between
                      assistant explanation and prompt itself — only when
                      explanation is present (otherwise line would float). */}
                  {preambleNodes && <div className="h-px bg-border/50" />}
                  <div>
                    <div className="flex items-center justify-between gap-2 mb-0.5">
                      <span className="text-[10px] text-muted-foreground/60 flex items-center gap-1.5">
                        {fenceStreaming && (
                          <span className="w-1.5 h-1.5 rounded-full bg-cyan-400/80 animate-pulse" />
                        )}
                        {clipMarker !== null
                          ? `Clip ${clipMarker}`
                          : fenceStreaming ? 'generating…' : ''}
                      </span>
                      <button
                        type="button"
                        onClick={() => copyPrompt(prompt, prompt.slice(0, 40))}
                        className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-[var(--surface-2)] transition-colors"
                        title="Copy prompt"
                      >
                        {copiedPrompt === prompt.slice(0, 40) ? (
                          <CheckIcon className="w-3 h-3 text-emerald-400" />
                        ) : (
                          <CopyIcon className="w-3 h-3" />
                        )}
                      </button>
                    </div>
                    <div className="leading-relaxed whitespace-pre-wrap break-words text-foreground/95">
                      {renderHighlightedParts(prompt)}
                      {fenceStreaming && (
                        <span className="inline-block w-[7px] h-[14px] align-middle ml-0.5 bg-cyan-400/80 animate-pulse" />
                      )}
                    </div>
                  </div>
                  {trailingNodes && (
                    <div className="text-sm leading-relaxed text-foreground/75">
                      {trailingNodes}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )
      }

      // No fence — render the whole text as markdown.
      return <MarkdownText text={rawText} previewFor={previewFor} onRefClick={openRefByTag} />

      function renderHighlightedParts(text: string): React.ReactNode[] {
        const parts = text.split(/(<(?:Picture|Video|Audio) \d+>|<d>[\s\S]*?<\/d>)/g)
        return parts.map((p, i) => {
          if (!p) return null
          const m = p.match(/^<(Picture|Video) (\d+)>$/)
          if (m) {
            const kind = m[1] === 'Picture' ? 'image' : 'video'
            const index = parseInt(m[2], 10)
            const { url, label } = previewFor(kind, index)
            const cls =
              kind === 'video'
                ? 'bg-cyan-500/15 text-cyan-300'
                : 'bg-purple-500/15 text-purple-300'
            return (
              <MentionTagWithPreview
                key={i}
                triggerText={p}
                previewUrl={url}
                label={label}
                kind={kind}
                className={cn('rounded', cls)}
              />
            )
          }
          if (/^<Audio \d+>$/.test(p)) {
            return (
              <span key={i} className="rounded bg-emerald-500/15 text-emerald-300">
                {p}
              </span>
            )
          }
          if (/^<d>[\s\S]*<\/d>$/.test(p)) {
            return (
              <span key={i} className="rounded bg-amber-500/15 text-amber-300">
                {p}
              </span>
            )
          }
          return <span key={i}>{p}</span>
        })
      }
    },
    [previewFor, copiedPrompt, isExtendChat],
  )

  /** Activate the persisted chat (or create one) on first mount only. */
  useEffect(() => {
    const st = useAssistantChats.getState()
    let id = st.activeChatId && st.chats.some((c) => c.id === st.activeChatId)
      ? st.activeChatId
      : (st.chats[0]?.id ?? null)
    if (!id) id = st.createChat()
    setActiveId(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // (edit 427) Mode filter change: if open chat belongs to another mode,
  // AUTOMATICALLY open first chat of selected mode (or create new,
  // if mode is empty). Chosen over "chat from another mode" placeholder
  // with button: filter feels like filter, not dead-end — no extra click
  // needed when switching or on empty mode.
  useEffect(() => {
    const st = useAssistantChats.getState()
    const current = st.chats.find((c) => c.id === activeId)
    if (current && current.mode === assistantMode) return
    const first = st.chats.find((c) => c.mode === assistantMode)
    const id = first ? first.id : st.createChat(assistantMode)
    st.setActiveChat(id)
    if (id !== activeId) setActiveId(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assistantMode, activeId, chats])

  // (edit 442) Panel mode: filter strictly tracks tab —
  // panel on "Generate" always shows generate chats, on "Extend" —
  // extend chats (no mode switch in panel). Effect above catches
  // assistantMode change and opens/creates chat of appropriate mode.
  useEffect(() => {
    if (!panelMode) return
    const st = useAssistantChats.getState()
    if (st.assistantMode !== panelMode) st.setAssistantMode(panelMode)
  }, [panelMode, assistantMode])

  /**
   * Auto-run a queued "improve prompt" request (edit 32): the user
   * message is appended to the active chat and the completion starts.
   * Edit 32: switching tab/chat no longer aborts in-flight reply —
   * on mount the stream may still be running. runAssistantCompletion() — no-op
   * when running, and request would hang without reply; so while stream is active,
   * request WAITS in store and starts right after it completes.
   * (edit 266) Effect also depends on pendingImprove: with tab already mounted
   * request arrives WITHOUT changing streaming/activeId — without store subscription
   * effect did not re-run and request would hang indefinitely.
   */
  useEffect(() => {
    if (streaming || !activeId) return
    const pending = useAssistantChats.getState().pendingImprove
    if (!pending) return
    const st = useAssistantChats.getState()
    // (edit 266) Improve executes in chat created by
    // requestImprovePrompt (its id passed in pendingImprove), not in current
    // activeId — otherwise request landed in another dialog while created chat
    // was empty. Fallback to activeId — for persisted pending without chatId.
    const id = st.chats.some((c) => c.id === pending.chatId)
      ? pending.chatId
      : st.chats.some((c) => c.id === activeId) ? activeId : st.createChat()
    // (edit 427) List filter to improve-request chat mode, otherwise
    // new extend chat would stay hidden by "Generate" filter (duplicates
    // setAssistantMode in requestImprovePrompt — for persisted pending).
    const targetChat = st.chats.find((c) => c.id === id)
    if (targetChat && targetChat.mode !== st.assistantMode) st.setAssistantMode(targetChat.mode)
    if (id !== activeId) setActiveId(id)
    st.clearImprove()
    const userMsg: AssistantChatMessage = { role: 'user', content: pending.content }
    const history = [...(st.chats.find((c) => c.id === id)?.messages ?? []), userMsg]
    st.appendMessage(id, userMsg)
    runAssistantCompletion(id, history)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming, activeId, pendingImprove])

  const activeChat = chats.find((c) => c.id === activeId) ?? null
  /** Messages rendered REACTIVELY from persisted store: reply committed
   *  by engine while on another tab appears here automatically. */
  const messages = activeChat?.messages ?? []
  // Stable keys (index shifts on trimming >200 messages and
  // re-animates all bubbles); duplicate messages distinguished by counter.
  const messageKeys = useMemo(() => {
    const seen = new Map<string, number>()
    return messages.map((m) => {
      const base = `${m.role}-${hashStr(m.content)}-${m.attachment?.path ?? ''}`
      const n = seen.get(base) ?? 0
      seen.set(base, n + 1)
      return n === 0 ? base : `${base}-${n}`
    })
  }, [messages])

  /** Video generation in progress — sending messages blocked (vram-arbiter). */
  const chatBlocked = status?.blockedByGeneration === true

  // Poll LLM status + download progress
  useEffect(() => {
    let cancelled = false
    // Note assistant usage in this session: generation view
    // polls /api/llm/status (for button lock) only if assistant was used
    sessionStorage.setItem('assistantUsed', '1')
    const tick = async () => {
      try {
        const r = await fetch('/api/llm/status', { signal: AbortSignal.timeout(4000) })
        const s = (await r.json()) as LlmStatusResp
        if (!cancelled) setStatus(s)
        if (s.modelReady) {
          if (!cancelled) setDl((d) => (d.active || d.error ? { active: false, received: 0, total: null, speed: 0, error: null } : d))
          return
        }
        const mr = await fetch('/api/models/status', { signal: AbortSignal.timeout(4000) })
        const md = await mr.json()
        const activeId = s.modelId || DEFAULT_LLM_MODEL_ID
        const mine = (md.models ?? []).find((m: { id: string; sizeLabel?: string }) => m.id === activeId)
        if (!cancelled && mine) {
          if (mine.sizeLabel) setSizeLabel(mine.sizeLabel)
          if (mine.status === 'downloading') {
            setDl({
              active: true,
              received: mine.bytesReceived ?? 0,
              total: mine.totalBytes ?? null,
              speed: mine.speed ?? 0,
              error: null,
            })
          } else if (mine.status === 'error') {
            setDl({ active: false, received: 0, total: null, speed: 0, error: mine.error || 'Download failed' })
          }
        }
      } catch {
        /* backend not up */
      }
    }
    void tick()
    const id = setInterval(() => void tick(), 2000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  // Autoscroll on new content (use rAF to ensure DOM has updated)
  useEffect(() => {
    const el = scrollRef.current
    // (edit 267) Scroll only when stuck to bottom — otherwise each token
    // of stream pushed user down when reading history.
    // Cancel rAF on unmount/re-run of effect.
    if (!el || !stickToBottomRef.current) return
    const raf = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight
    })
    return () => cancelAnimationFrame(raf)
  }, [messages, streamText, activeId, status?.modelReady])

  /* ── Textarea auto-expand (edit 38): up to 8 lines, then scroll ── */
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    // text-sm = 14px, line-height ≈ 1.5 → ~21px/line; 8 lines = 168px + 20px padding
    el.style.height = Math.min(el.scrollHeight, 188) + 'px'
  }, [input])

  const clickTs = useRef(0)

  const startDownload = useCallback(async () => {
    clickTs.current = Date.now()
    setDl({ active: true, received: 0, total: null, speed: 0, error: null })
    try {
      const modelId = status?.modelId || DEFAULT_LLM_MODEL_ID // (edit 268)
      const r = await fetch('/api/models/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId }),
      })
      const d = await r.json()
      if (!d.ok) {
        setDl({ active: false, received: 0, total: null, speed: 0, error: d.error || 'Failed to start download' })
        toast.error(d.error || 'Failed to start download')
      } else {
        toast.success('Model download started')
      }
    } catch {
      setDl({ active: false, received: 0, total: null, speed: 0, error: 'Failed to start download' })
      toast.error('Failed to start download')
    }
  }, [status?.modelId])

  // (edit 86) Handle file selection for attachment
  const handleAttFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const isVideo = file.type.startsWith('video/')
    const isImage = file.type.startsWith('image/')
    if (!isVideo && !isImage) {
      toast.error('Only images and videos are supported')
      return
    }
    // (edit 349) Revoke old preview on attachment replacement — otherwise
    // blob URL leaks on each file re-selection.
    const prevAtt = useAssistantDraft.getState().attachment
    if (prevAtt) {
      try { URL.revokeObjectURL(prevAtt.previewUrl) } catch { /* already revoked */ }
    }
    setAttachment({
      file,
      previewUrl: URL.createObjectURL(file),
      name: file.name,
      kind: isVideo ? 'video' : 'image',
    })
    e.target.value = '' // reset so selecting same file triggers change
  }, [])

  const removeAttachment = useCallback(() => {
    if (attachment) URL.revokeObjectURL(attachment.previewUrl)
    setAttachment(null)
  }, [attachment])

  const send = useCallback(
    async (text?: string) => {
      const content = (text ?? input).trim()
      // chatBlocked: generation in progress — vram-arbiter returns 409 anyway,
      // block ahead of time (Enter and quick buttons bypass disabled)
      if (!content || isStreamActive() || chatBlocked) return
      // (edit 717) Protection against DOUBLE send. isStreamActive() check
      // did not fire during attachment upload (stream not started), and
      // quick buttons/Enter could trigger second send(): message
      // was appended twice, while second runAssistantCompletion failed via
      // `if (running) return` — without reply or error.
      if (sendingRef.current) return
      sendingRef.current = true
      try {
        // (edit 267) Sending user message — stick back to bottom of feed.
        stickToBottomRef.current = true
        let id = activeId
        if (!id || !useAssistantChats.getState().chats.some((c) => c.id === id)) {
          id = useAssistantChats.getState().createChat()
          setActiveId(id)
        }

        // (edit 87; edit 108) Upload attachment FIRST to save path
        // in message. (edit 108) Upload to ISOLATED storage
        // data/chat-attachments/ (NOT in ComfyUI/input/): file exists only in
        // chat and is used only for LLM description — does not enter generation
        // references, gallery, upscale or "input cleanup".
        let attInfo: { path: string; name: string; kind: 'image' | 'video'; src?: 'chat' | 'comfy' } | undefined
        let atts: ChatAttachment[] | undefined
        if (attachment) {
          setAttUploading(true)
          try {
            const { path } = await uploadChatAttachment(attachment.file)
            attInfo = { path, name: attachment.name, kind: attachment.kind, src: 'chat' }
            atts = [{ path, name: attachment.name, kind: attachment.kind }]
          } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to upload file')
            setAttUploading(false)
            removeAttachment()
            return
          }
          setAttUploading(false)
          removeAttachment()
        }

        setInput('')
        const userMsg: AssistantChatMessage = { role: 'user', content, attachment: attInfo }
        // Persist user message immediately (with attachment for chat display)
        useAssistantChats.getState().appendMessage(id, userMsg)
        // (edit 265) history — fresh snapshot AFTER appendMessage: userMsg is already
        // in it; adding it to literal duplicated message in request.
        const history = useAssistantChats.getState().chats.find((c) => c.id === id)?.messages ?? []

        runAssistantCompletion(id, history, atts)
      } finally {
        // (edit 717) Flag released in finally — otherwise on exception
        // (e.g. attachment upload error) chat would remain stuck blocked.
        sendingRef.current = false
      }
    },
    [input, activeId, chatBlocked, attachment, removeAttachment],
  )

  const stop = useCallback(() => {
    stopAssistantStream()
  }, [])

  /**
   * Switch to another chat (edit 32: do NOT abort stream).
   * Reply in-flight continues generating in ITS chat —
   * engine lives at module level and survives chat/tab switch.
   * Live tail is visible only in chat where it began (streamingHere),
   * "Stop" is globally available near input field.
   */
  const switchChat = useCallback(
    (id: string) => {
      useAssistantChats.getState().setActiveChat(id)
      setActiveId(id)
      // (edit 442) Chat list in panel is slide-out: close after selection.
      if (inPanel) setChatListOpen(false)
    },
    [inPanel],
  )

  /** New chat (edit 32: reply in another chat is untouched). */
  const newChat = useCallback(() => {
    const id = useAssistantChats.getState().createChat()
    setActiveId(id)
    if (inPanel) setChatListOpen(false)
  }, [inPanel])

  const deleteChat = useCallback(
    (id: string) => {
      // Edit 32: if stream is running SPECIFICALLY in deleted chat — abort it first.
      // Engine commits partial reply in finally AFTER
      // chat deletion, appendMessage won't find chat and silently drops —
      // as intended (garbage tail not saved), model is freed.
      // For another chat — no-op.
      stopStreamForChat(id)
      const st = useAssistantChats.getState()
      st.deleteChat(id)
      const remaining = useAssistantChats.getState()
      if (id === activeId) {
        const nextId = remaining.activeChatId ?? remaining.createChat()
        setActiveId(nextId)
      }
    },
    [activeId],
  )

  /* ── (edit 264) Rename chat ──
   * Inline editor in list: pencil -> input (prefilled with current title),
   * Enter/blur/checkmark — save, Esc/cross — cancel. Double-click on name does the same.
   * renameChat updates only title (without updatedAt) — list
   * is not re-sorted, synchronization (assistant-chats-sync) automatically
   * sends updated chats array to server via debounced PUT. */
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)

  const startRename = useCallback((id: string, current: string) => {
    setRenamingId(id)
    setRenameValue(current)
    // Focus and select all after input renders
    requestAnimationFrame(() => {
      renameInputRef.current?.focus()
      renameInputRef.current?.select()
    })
  }, [])

  const commitRename = useCallback(() => {
    if (!renamingId) return
    const v = renameValue.trim()
    if (v) useAssistantChats.getState().renameChat(renamingId, v)
    setRenamingId(null)
    setRenameValue('')
  }, [renamingId, renameValue])

  const cancelRename = useCallback(() => {
    setRenamingId(null)
    setRenameValue('')
  }, [])

  /** Insert an assistant reply into the prompt editor.
   *  Prompt extraction — single source: src/lib/assistant-fence.ts
   *  (edit 34): fence content -> from H3 field marker -> last
   *  meaningful paragraph; trimmed at closing fence, without
   *  model tail or decorative quotes. */
  const insertIntoPrompt = useCallback((content: string) => {
    const clean = extractInsertablePrompt(content)
    if (!clean) return
    useGenStore.getState().setVideoPrompt(clean)
    // (edit 161) Button visible only when !streaming — stream finished.
    // But server assistantBusy might still be true (drain pump not
    // finished). GenerateView polls /api/llm/status on mount
    // and locks "Generate". Release lock: generation does not interfere with
    // LLM (stream finished), real gate is 409 from runGeneration.
    void fetch('/api/llm/release', { method: 'POST' }).catch(() => {})
    window.dispatchEvent(new CustomEvent('h3:goto-generate'))
    toast.success('Prompt inserted into editor')
  }, [])

  /** (edit 502) Insert controlnet chat fence prompt into prompt field
   *  of "ControlNet" tab (controlnet-target-store) + navigate to tab. */
  const insertIntoControlNetPrompt = useCallback((content: string) => {
    const clean = extractInsertablePrompt(content)
    if (!clean) return
    useControlNetTarget.getState().setPrompt(clean)
    void fetch('/api/llm/release', { method: 'POST' }).catch(() => {})
    window.dispatchEvent(new CustomEvent('h3:goto-controlnet'))
    toast.success('Prompt inserted into ControlNet tab')
  }, [])

  /** (edit 427) Insert extend chat fence prompt into clip card N.
   *  `clip: N` marker line is stripped (stripClipMarker) — needed
   *  only by UI for addressing. Copy array by index matching
   *  editing in extend-view; release LLM and navigate to tab
   *  "Extend" — matching "To prompt" (edit 161). */
  const insertIntoClip = useCallback((fenceContent: string, clipNumber: number) => {
    const clean = stripClipMarker(fenceContent).trim()
    if (!clean) return
    const st = useGenStore.getState()
    const clips = [...st.video.extendClips]
    const idx = clipNumber - 1
    if (idx < 0 || idx >= clips.length) {
      toast.error(`Clip ${clipNumber} not found — add it on the "Extend" tab`)
      return
    }
    clips[idx] = { ...clips[idx], prompt: clean }
    st.patchVideo({ extendClips: clips })
    void fetch('/api/llm/release', { method: 'POST' }).catch(() => {})
    window.dispatchEvent(new CustomEvent('h3:goto-extend'))
    toast.success(`Prompt inserted into clip ${clipNumber}`)
  }, [])

  /** (edit 428) Batch insert: assistant usually yields prompts for ALL
   *  clips in one message (multiple fences with `clip: N` markers) — then
   *  instead of multiple "To clip N" buttons show ONE "Insert all (N)".
   *  All updates applied to single array copy and one patchVideo. */
  const insertAllIntoClips = useCallback((pairs: Array<{ content: string; clip: number }>) => {
    const st = useGenStore.getState()
    const clips = [...st.video.extendClips]
    let applied = 0
    for (const { content, clip } of pairs) {
      const clean = stripClipMarker(content).trim()
      const idx = clip - 1
      if (!clean || idx < 0 || idx >= clips.length) continue
      clips[idx] = { ...clips[idx], prompt: clean }
      applied++
    }
    if (applied === 0) {
      toast.error('Nothing to insert — clips not found')
      return
    }
    st.patchVideo({ extendClips: clips })
    void fetch('/api/llm/release', { method: 'POST' }).catch(() => {})
    window.dispatchEvent(new CustomEvent('h3:goto-extend'))
    toast.success(`Prompts inserted into clips: ${applied}`)
  }, [])

  /**
   * Does this assistant reply actually contain a structured prompt?
   * The "To prompt" button is rendered ONLY in that case — plain
   * conversational answers (greetings, Q&A, tips) have nothing to insert,
   * and a dead button there only confuses users.
   */
  const hasStructuredPrompt = useCallback((content: string): boolean => {
    if (!content.trim()) return false
    // A ``` code fence (the assistant wraps prompts in one)…
    if (/```/.test(content)) return true
    // …or an official H3 structural field marker.
    return hasH3Field(content)
  }, [])

  const modelReady = status?.modelReady
  const running = status?.running


  // SSR/hydration guard: persisted store (chats) differs between server and
  // first client render. Render a neutral placeholder until mounted.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  if (!mounted) {
    return (
      <div className="flex-1 flex flex-col min-h-0 bg-[var(--surface-1)]">
        <div className={cn('shrink-0', inPanel ? 'px-3 pt-3 pb-2' : 'px-6 pt-5 pb-3')}>
          <h1 className={cn('font-semibold text-foreground flex items-center gap-2.5', inPanel ? 'text-sm' : 'text-xl')}>
            <span className={cn('rounded-xl gradient-creative flex items-center justify-center shrink-0 shadow-lg shadow-amber-500/20', inPanel ? 'w-7 h-7' : 'w-9 h-9')}>
              <BotIcon className={cn('text-white', inPanel ? 'w-3.5 h-3.5' : 'w-4.5 h-4.5')} />
            </span>
            Assistant
          </h1>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <div className="text-xs text-muted-foreground">Loading…</div>
        </div>
      </div>
    )
  }

  return (
    <div
      className="relative flex-1 flex flex-row min-h-0 bg-[var(--surface-1)]"
      onPaste={(e) => {
        // (edit 123) Ctrl+V from clipboard — image becomes
        // chat attachment (same as paperclip button). Fires on
        // focus in any tab field; text paste untouched —
        // intercept only if clipboard contains image.
        // preventDefault synchronously (before await).
        if (!hasClipboardImage(e.clipboardData)) return
        e.preventDefault()
        if (attUploading) {
          toast.error('Please wait for message to send — current attachment is uploading')
          return
        }
        void getClipboardImageFiles(e.clipboardData).then((files) => {
          if (files.length === 0) return
          const file = files[0]
          if (attachment) URL.revokeObjectURL(attachment.previewUrl)
          setAttachment({ file, previewUrl: URL.createObjectURL(file), name: file.name, kind: 'image' })
        })
      }}
    >
      {/* Left: main content */}
      <div className="flex-1 flex flex-col min-h-0 min-w-0">
      {/* Header — (edit 442) in panel compact: chat list button on left,
          collapse panel button on right */}
      <div className={cn('shrink-0 aurora-bg', inPanel ? 'px-3 pt-3 pb-2' : 'px-6 pt-5 pb-3')}>
        <div className={cn('flex gap-3', inPanel ? 'items-center' : 'items-end justify-between')}>
          {inPanel && (
            <button
              type="button"
              onClick={() => setChatListOpen((o) => !o)}
              title="Chat list"
              className={cn(
                'shrink-0 w-8 h-8 rounded-lg border flex items-center justify-center transition-colors',
                chatListOpen
                  ? 'border-amber-500/50 bg-amber-500/15 text-amber-300'
                  : 'border-border bg-[var(--surface-2)] text-muted-foreground hover:text-foreground',
              )}
            >
              <MessageSquareIcon className="w-4 h-4" />
            </button>
          )}
          <div className="min-w-0 flex-1">
            <h1 className={cn('font-semibold text-foreground flex items-center gap-2.5', inPanel ? 'text-sm' : 'text-xl')}>
              <span className={cn('rounded-xl gradient-creative flex items-center justify-center shrink-0 shadow-lg shadow-amber-500/20', inPanel ? 'w-7 h-7' : 'w-9 h-9')}>
                <BotIcon className={cn('text-white', inPanel ? 'w-3.5 h-3.5' : 'w-4.5 h-4.5')} />
              </span>
              Assistant
            </h1>
            <p className={cn('text-muted-foreground mt-1 truncate', inPanel ? 'text-[10px]' : 'text-xs')}>
              {inPanel
                ? `Local LLM: ${llmDisplayName(status?.modelId, status?.modelName)}`
                : `Local LLM (${llmDisplayName(status?.modelId, status?.modelName)}) · multimodal vision · persistent chats`}
            </p>
          </div>
          {modelReady && (
            <div className="flex items-center gap-2 shrink-0">
              {/* (edit 540) Toggle "3D -> Video" removed — motion transfer via ControlNet tab */}
              <span
                className={cn(
                  'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] border',
                  running
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                    : 'border-border bg-[var(--surface-2)] text-muted-foreground',
                )}
              >
                <span className={cn('w-1.5 h-1.5 rounded-full', running ? 'bg-emerald-400' : 'bg-muted-foreground/50')} />
                {running ? (status?.gpuMode === 'gpu' ? 'GPU' : 'CPU') : 'idle'}
              </span>
            </div>
          )}
          {inPanel && onCollapse && (
            <button
              type="button"
              onClick={onCollapse}
              title="Collapse panel"
              className="shrink-0 w-8 h-8 rounded-lg border border-border bg-[var(--surface-2)] flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
            >
              <ChevronRightIcon className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* Body */}
      {!modelReady ? (
        /* ── Model not downloaded yet ── */
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="max-w-md w-full rounded-2xl border border-amber-500/25 bg-amber-500/5 p-6 text-center space-y-4">
            <div className="w-14 h-14 rounded-2xl gradient-creative flex items-center justify-center mx-auto shadow-lg shadow-amber-500/20">
              <BotIcon className="w-7 h-7 text-white" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-foreground">
                {status?.modelId === 'llm_custom' ? 'Custom model file not found' : 'Assistant model not downloaded'}
              </h3>
              <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
                {status?.modelId === 'llm_custom' ? (
                  <>
                    Check the path to your model in <b>Settings → LLM</b>: file
                    "{status?.modelName || '—'}" is not available. Custom models are
                    not downloaded by the studio — fix the path or clear the field
                    to return to the built-in model.
                  </>
                ) : (
                  <>
                    Local assistant model ({llmDisplayName(status?.modelId, status?.modelName)})
                    — downloaded to <span className="font-mono text-[10px]">ComfyUI/models/llm/</span>. Runs
                    locally without internet, directly on your hardware.
                  </>
                )}
              </p>
            </div>
            {status?.modelId === 'llm_custom' ? null : dl.error ? (
              <div className="space-y-2">
                <p className="text-xs text-red-400 break-words">Error: {dl.error}</p>
                <Button variant="outline" size="sm" onClick={startDownload} className="gap-1.5">
                  <DownloadIcon className="w-3.5 h-3.5" />
                  Retry
                </Button>
              </div>
            ) : dl.active ? (
              <div className="space-y-2">
                <div className="h-2 rounded-full bg-[var(--surface-2)] overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-amber-500 to-orange-500 rounded-full transition-all duration-500"
                    style={{
                      width: `${
                        dl.total && dl.total > 0
                          ? Math.min(100, Math.floor((dl.received / dl.total) * 100))
                          : 8
                      }%`,
                    }}
                  />
                </div>
                <p className="text-xs text-muted-foreground font-mono tabular-nums">
                  {dl.received > 0
                    ? `${(dl.received / 1024 / 1024 / 1024).toFixed(2)} / ${sizeLabel || '~5.7 GB'}` +
                      (dl.total && dl.total > 0 ? ` · ${Math.floor((dl.received / dl.total) * 100)}%` : '') +
                      (dl.speed > 0 ? ` · ${(dl.speed / 1024 / 1024).toFixed(1)} MB/s` : '')
                    : 'Connecting to download server…'}
                </p>
              </div>
            ) : (
              <Button
                onClick={startDownload}
                className="bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-400 hover:to-orange-500 text-white border-0 font-semibold gap-2"
              >
                <DownloadIcon className="w-4 h-4" />
                Download model ({sizeLabel || '~5.7 GB'})
              </Button>
            )}
            <p className="text-[10px] text-muted-foreground/60">
              After downloading, first launch takes 1–2 minutes. During video generation,
              the model automatically starts in CPU mode if VRAM is insufficient.
            </p>
          </div>
        </div>
      ) : (
        /* ── Chat ── */
        <>
          <div
            ref={scrollRef}
            // (edit 267) Track stuck to bottom for autoscroll
            onScroll={(e) => {
              const el = e.currentTarget
              stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
            }}
            className="flex-1 overflow-y-auto px-6 pb-4 min-h-0"
          >
            {messages.length === 0 && (
              <div className="h-full flex items-center justify-center">
                <div className="max-w-md text-center space-y-3">
                  <SparklesIcon className="w-8 h-8 text-amber-400/60 mx-auto" />
                  <p className="text-sm text-muted-foreground">
                    {/* (edit 427) Greeting depends on chat mode. */}
                    {isExtendChat
                      ? 'Describe how to continue the video — the assistant will craft prompts for clips (each in a separate block labeled clip: N) taking into account the source and extension references.'
                      : isControlNetChat
                        ? 'Describe the scene — the assistant will create a prompt for ControlNet. Motion and camera are defined by the control video, so the prompt should describe only the scene, appearance, style, lighting, and sound.'
                        : 'Describe your video idea in natural language — the assistant will generate a prompt (in English, tagged with your references) and remember the conversation.'}
                  </p>
                </div>
              </div>
            )}
            <div className="space-y-3 max-w-3xl mx-auto">
              {messages.map((m, i) => (
                <motion.div
                  key={messageKeys[i]}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}
                >
                  <div
                    className={cn(
                      // (edit 564) select-text: chat message text can be selected
                      // (copying replies), internal buttons excluded in CSS.
                      'select-text max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed break-words',
                      // (edit 88) assistant text is rendered as markdown —
                      // pre-wrap is not needed there (double newlines), user keeps it.
                      m.role === 'user' && 'whitespace-pre-wrap',
                      m.role === 'user'
                        ? 'bg-gradient-to-r from-slate-600/90 to-indigo-600/90 text-white rounded-br-sm'
                        : 'bg-[var(--surface-2)]/60 border border-border/60 text-foreground/95 rounded-bl-sm',
                    )}
                  >
                    {/* (edit 87) Attachment: image or video in bubble.
                        (edit 108) src='chat' -> isolated chat storage
                        (data/chat-attachments/); legacy (without src) -> /api/comfy/file. */}
                    {m.attachment && (() => {
                      const attSrc = m.attachment.src === 'chat'
                        ? `/api/assistant/attachment?filename=${encodeURIComponent(m.attachment.path)}`
                        : `/api/comfy/file?filename=${encodeURIComponent(m.attachment.path)}&type=input`
                      return (
                        <div className="mb-2">
                          {/* (edit 719) Click on attachment — full-screen
                              viewer (matching "Generate" tab). */}
                          <RefPreviewThumb
                            kind={m.attachment.kind}
                            name={m.attachment.name}
                            path={m.attachment.path}
                            url={attSrc}
                            className="block max-w-full"
                            title="Open attachment full screen"
                          >
                            {m.attachment.kind === 'image' ? (
                              <img
                                src={attSrc}
                                alt={m.attachment.name}
                                className="max-h-48 max-w-full rounded-lg object-contain cursor-zoom-in"
                              />
                            ) : (
                              <video
                                src={attSrc}
                                className="max-h-48 max-w-full rounded-lg"
                                controls
                                preload="metadata"
                                /* (edit 719) Player button clicks must not
                                   trigger full-screen viewer. */
                                onClick={(e) => e.stopPropagation()}
                              />
                            )}
                          </RefPreviewThumb>
                          <p className="mt-1 text-[10px] opacity-60">{m.attachment.name}</p>
                        </div>
                      )
                    })()}
                    {/* (edit 695) User messages — plain markdown, without fence parsing:
                        instruction "```text fence with clip: N" contains three backticks,
                        and parseAllFences treated them as "open fence", adding
                        "generating…" to user message. Fence cards needed
                        only in assistant replies. */}
                    {m.role === 'user'
                      ? (<div className="leading-relaxed break-words"><MarkdownText text={m.content} previewFor={previewFor} onRefClick={openRefByTag} /></div>)
                      : (renderChatContent(m.content) || '')}
                    {/* (edit 427) Insert — by chat mode: "To prompt"
                        only in "Generate" chats; in "Extend" chats —
                        per-fence "To clip N" (by `clip: N` marker, or without
                        marker — row of buttons matching clip count).
                        (edit 502) In "ControlNet" chats — "To prompt"
                        of ControlNet tab. */}
                    {m.role === 'assistant' && !streaming && !isExtendChat && hasStructuredPrompt(m.content) && (
                      <div className="mt-2 pt-2 border-t border-border/60 flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => isControlNetChat ? insertIntoControlNetPrompt(m.content) : insertIntoPrompt(m.content)}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] border border-violet-500/30 bg-violet-500/10 text-violet-300 hover:bg-violet-500/20 transition-colors"
                        >
                          <ArrowDownToLineIcon className="w-3 h-3" />
                          To prompt
                        </button>
                      </div>
                    )}
                    {m.role === 'assistant' && !streaming && isExtendChat && (() => {
                      const msgFences = parseAllFences(m.content)
                      if (!msgFences.length) return null
                      // (edit 428) Collect fences with valid `clip: N` marker
                      // into pairs; if 2+ — ONE "Insert all" button
                      // instead of multiple "To clip N". Fences without marker
                      // (or with stale number) — row of manual buttons.
                      const marked: Array<{ content: string; clip: number }> = []
                      const unmarked: Array<{ content: string; fi: number }> = []
                      msgFences.forEach((f, fi) => {
                        const marker = parseClipMarker(f.prompt)
                        if (marker !== null && marker >= 1 && marker <= extendClipsCount) {
                          marked.push({ content: f.prompt, clip: marker })
                        } else {
                          unmarked.push({ content: f.prompt, fi })
                        }
                      })
                      // (edit 453) Button duplicates: model often yields 2+
                      // fences WITHOUT `clip: N` marker — previously for EACH
                      // an identical row "To clip: [1] [2]…" was rendered (which
                      // which row belonged to which prompt was ambiguous). Now: if all
                      // fences lack markers and there are >=2 (not exceeding clips)
                      // — match POSITIONALLY (fence i -> clip i+1) and
                      // show ONE "Insert all" button. Single
                      // fence — manual selection row once. Mismatch
                      // (more fences than clips) — rows with prompt number
                      // label to distinguish.
                      const positional =
                        marked.length === 0 &&
                        unmarked.length >= 2 &&
                        unmarked.length <= extendClipsCount
                      return (
                        <div className="mt-2 pt-2 border-t border-border/60 space-y-1.5">
                          {marked.length >= 2 ? (
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => insertAllIntoClips(marked)}
                                className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] border border-violet-500/30 bg-violet-500/10 text-violet-300 hover:bg-violet-500/20 transition-colors"
                              >
                                <ArrowDownToLineIcon className="w-3 h-3" />
                                Insert all ({marked.length})
                              </button>
                              <span className="text-[10px] text-muted-foreground/60">
                                → clips {marked.map((p) => p.clip).join(', ')}
                              </span>
                            </div>
                          ) : (
                            marked.map((p) => (
                              <div key={p.clip} className="flex items-center gap-2">
                                <button
                                  type="button"
                                  onClick={() => insertIntoClip(p.content, p.clip)}
                                  className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] border border-violet-500/30 bg-violet-500/10 text-violet-300 hover:bg-violet-500/20 transition-colors"
                                >
                                  <ArrowDownToLineIcon className="w-3 h-3" />
                                  To clip {p.clip}
                                </button>
                              </div>
                            ))
                          )}
                          {positional ? (
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() =>
                                  insertAllIntoClips(
                                    unmarked.map((u, i) => ({ content: u.content, clip: i + 1 })),
                                  )
                                }
                                className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] border border-violet-500/30 bg-violet-500/10 text-violet-300 hover:bg-violet-500/20 transition-colors"
                              >
                                <ArrowDownToLineIcon className="w-3 h-3" />
                                Insert all ({unmarked.length})
                              </button>
                              <span className="text-[10px] text-muted-foreground/60">
                                → clips {unmarked.map((_, i) => i + 1).join(', ')}
                              </span>
                            </div>
                          ) : (
                            unmarked.map(({ content, fi }) => {
                              if (extendClipsCount === 0) {
                                return fi === unmarked[0].fi ? (
                                  <p key={fi} className="text-[10px] text-muted-foreground/60">
                                    No clips — add them on the "Extend" tab, then insert prompt.
                                  </p>
                                ) : null
                              }
                              return (
                                <div key={fi} className="flex items-center gap-1 flex-wrap">
                                  <span className="text-[10px] text-muted-foreground/60 mr-0.5">
                                    {unmarked.length > 1 ? `Prompt ${fi + 1} →` : 'To clip:'}
                                  </span>
                                  {Array.from({ length: extendClipsCount }, (_, k) => (
                                    <button
                                      key={k}
                                      type="button"
                                      onClick={() => insertIntoClip(content, k + 1)}
                                      className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] border border-violet-500/30 bg-violet-500/10 text-violet-300 hover:bg-violet-500/20 transition-colors"
                                    >
                                      Clip {k + 1}
                                    </button>
                                  ))}
                                </div>
                              )
                            })
                          )}
                        </div>
                      )
                    })()}
                  </div>
                </motion.div>
              ))}
              {streamingHere && (
                <div className="flex justify-start">
                  <div className="select-text max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed break-words bg-[var(--surface-2)]/60 border border-border/60 text-foreground/95 rounded-bl-sm">
                    {streamText ? renderChatContent(streamText) : 'Preparing reply…'}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Quick actions + input (edit 87: centered, max-width) */}
          <div className="shrink-0 border-t border-border px-4 py-3 bg-[var(--surface-0)]/90 backdrop-blur-sm">
          <div className="max-w-3xl mx-auto space-y-2">
            {!streaming && (
              <div className="flex items-center gap-1.5 flex-wrap">
                {isExtendChat ? (
                  /* (edit 427) Extend chat: quick button asks prompts for
                      ALL clips — via fence with clip: N marker per clip. */
                  <button
                    type="button"
                    onClick={() => {
                      void send(
                        extendClipsCount > 0
                          ? `Fill in (or improve) prompts for all ${extendClipsCount} extension clips based on the source context — for each clip create a separate \`\`\`text fence with the first line \`clip: N\`.`
                          : 'Suggest 2–3 extension clips based on the context of the source video: for each, provide a separate ```text fence with the first line `clip: N` (I will create clip cards with these numbers).',
                      )
                    }}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full border border-amber-500/30 bg-amber-500/10 text-amber-300 text-xs hover:bg-amber-500/20 transition-colors"
                  >
                    <WandSparklesIcon className="w-3 h-3" />
                    {extendClipsCount > 0 ? 'Prompts for all clips' : 'Suggest extension clips'}
                  </button>
                ) : isControlNetChat ? (
                  /* (edit 502) ControlNet chat: "Refine prompt" (edit 560
                      — renamed) with current prompt of "ControlNet" tab
                      (empty — create from scratch). */
                  <button
                    type="button"
                    onClick={() => {
                      const draft = useControlNetTarget.getState().prompt.trim()
                      void send(
                        draft
                          ? `Refine my current prompt for ControlNet mode, preserving the meaning. Do NOT describe motion or camera — they are driven by the control video. Current prompt:\n\n${draft}`
                          : 'Create a prompt for ControlNet mode from scratch: motion and camera are set by the control video, describe only the scene, character appearance, style, lighting, and audio.',
                      )
                    }}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full border border-amber-500/30 bg-amber-500/10 text-amber-300 text-xs hover:bg-amber-500/20 transition-colors"
                  >
                    <WandSparklesIcon className="w-3 h-3" />
                    {controlnetHasPrompt ? 'Refine prompt' : 'Create prompt'}
                  </button>
                ) : (
                <button
                  type="button"
                  onClick={() => {
                    const draft = useGenStore.getState().video.prompt.trim()
                    void send(
                      draft
                        ? `Refine my current prompt while preserving the meaning. Current prompt:\n\n${draft}`
                        : 'Suggest 3 different ideas for a short video (one scene per idea), I will choose one and ask for a prompt.',
                    )
                  }}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full border border-amber-500/30 bg-amber-500/10 text-amber-300 text-xs hover:bg-amber-500/20 transition-colors"
                >
                  <WandSparklesIcon className="w-3 h-3" />
                  {hasPrompt ? 'Refine my prompt' : 'Suggest ideas'}
                </button>
                )}
              </div>
            )}
            {/* (edit 86) Attachment preview */}
            {attachment && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-amber-500/30 bg-amber-500/10">
                {attachment.kind === 'image' ? (
                  <img
                    src={attachment.previewUrl}
                    alt={attachment.name}
                    className="w-10 h-10 rounded-md object-cover shrink-0"
                  />
                ) : (
                  <div className="w-10 h-10 rounded-md bg-[var(--surface-3)] flex items-center justify-center shrink-0">
                    <FilmIcon className="w-5 h-5 text-amber-400" />
                  </div>
                )}
                <span className="text-xs text-foreground truncate flex-1 min-w-0">{attachment.name}</span>
                {attUploading ? (
                  <span className="text-[10px] text-amber-400 animate-pulse shrink-0">Uploading…</span>
                ) : (
                  <button
                    type="button"
                    onClick={removeAttachment}
                    className="p-1 rounded hover:bg-red-500/20 text-muted-foreground hover:text-red-400 transition-colors shrink-0"
                    title="Remove attachment"
                  >
                    <XIcon className="w-3.5 h-3.5" />
                  </button>
                )}
                {/* (edit 691) "Clear" — resets text and attachment in single
                    action (shown when there is content to clear). */}
                {(input.trim() || attachment) && (
                  <button
                    type="button"
                    onClick={() => { setInput(''); removeAttachment() }}
                    className="p-1 rounded hover:bg-red-500/20 text-muted-foreground hover:text-red-400 transition-colors shrink-0"
                    title="Clear input and attachment"
                  >
                    <Trash2Icon className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            )}
            <div className="flex items-center gap-2">
              {/* (edit 86) "+" button — attach image or video */}
              <button
                type="button"
                onClick={() => attFileRef.current?.click()}
                disabled={streaming || attUploading}
                title="Attach image or video for LLM analysis"
                className={cn(
                  'shrink-0 inline-flex items-center justify-center rounded-xl border transition-colors',
                  'h-11 w-11',
                  'border-border bg-[var(--surface-2)] text-muted-foreground',
                  'hover:text-foreground hover:bg-[var(--surface-3)]',
                  'disabled:opacity-40 disabled:cursor-not-allowed',
                )}
              >
                <PaperclipIcon className="w-4 h-4" />
              </button>
              <input
                ref={attFileRef}
                type="file"
                accept="image/*,video/*"
                className="hidden"
                onChange={handleAttFile}
              />
              {/* Input field + microphone (edit 87: centered) */}
              <div className="relative flex-1 min-w-0">
                <textarea
                  ref={textareaRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      // Send button disabled while attachment is uploading —
                      // Enter must observe the same guard: otherwise text
                      // was sent WITHOUT attachment, and repeated send (on upload
                      // finish) was silently dropped (running=true).
                      if (attUploading) {
                        toast.error('Please wait for attachment to finish uploading')
                        return
                      }
                      void send()
                    }
                  }}
                  placeholder="Describe scene idea… (Enter to send, Shift+Enter for newline)"
                  rows={1}
                  // (edit 452) Exact vertical rhythm: 11+20+11 + 2px border =
                  // exactly 44px (h-11 buttons) — text, placeholder and buttons sit
                  // on one axis. placeholder:text-xs removed: reduced font size
                  // broke baseline and placeholder hung above center.
                  className="w-full resize-none rounded-xl border border-border bg-[var(--surface-2)] px-3.5 py-[11px] pr-12 text-sm leading-5 text-foreground placeholder:text-muted-foreground/50 placeholder:whitespace-nowrap placeholder:overflow-hidden placeholder:text-ellipsis focus:outline-none focus:ring-1 focus:ring-amber-500/50 min-h-[44px] max-h-[188px] overflow-y-auto"
                />
                {/* (edit 139) Microphone: explicit flex-center h-11 container so 32px button
                    is vertically centered with input (previously inline-flex 32px in
                    absolutely-positioned div with top-1/2 visually hung lower) */}
                <div className="absolute right-2.5 top-1/2 -translate-y-1/2 flex h-11 w-11 items-center justify-center">
                  <VoiceInputButton
                    variant="inline"
                    hotkey
                    onText={(t) => {
                      // (edit 256) setInput — direct store setter (not fn updater)
                      const prev = useAssistantDraft.getState().input
                      setInput(prev.trim() ? `${prev.replace(/\s+$/, '')} ${t}` : t)
                      textareaRef.current?.focus()
                    }}
                  />
                </div>
              </div>
              {streaming ? (
                <Button variant="outline" size="sm" onClick={stop} className="h-11 gap-1.5">
                  <SquareIcon className="w-4 h-4" />
                  Stop
                </Button>
              ) : (
                <Button
                  size="sm"
                  onClick={() => { void send() }}
                  disabled={!input.trim() || chatBlocked || attUploading}
                  title={chatBlocked ? '⚙️ Video generation in progress — sending disabled' : 'Send'}
                  className="h-11 px-4 gap-1.5 rounded-xl border border-amber-500/30 bg-amber-500/15 text-amber-200 hover:bg-amber-500/25 hover:border-amber-500/50 font-medium shadow-sm shadow-amber-500/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <SendIcon className="w-4 h-4" />
                  Send
                </Button>
              )}
            </div>
          </div>
          </div>
        </>
      )}
      </div>

      {/* Right: chat list sidebar (edit 87).
          (edit 442) In panel — slide-out overlay over chat (space for
          permanent column unavailable), mode switcher hidden: mode specified
          by tab (panelMode). */}
      {inPanel && chatListOpen && (
        <div className="absolute inset-0 z-10 bg-black/30" onClick={() => setChatListOpen(false)} />
      )}
      {(!inPanel || chatListOpen) && (
      <div
        className={cn(
          'border-l border-border flex flex-col',
          inPanel
            ? 'absolute inset-y-0 right-0 w-52 z-20 bg-[var(--surface-0)] shadow-2xl shadow-black/50'
            : 'w-56 bg-[var(--surface-0)]/60 shrink-0',
        )}
      >
        <div className="p-3 border-b border-border space-y-2">
          {/* (edit 427) Chat mode filter — styled like "Pass quality"
              in extend-view (grid-cols-2, active — emerald). Switches
              ONLY the list: active chat mode synchronized by effect above
              (auto-open first chat of mode or create new).
              (edit 442) Hidden in panel — mode strictly follows tab. */}
          {!inPanel && (
          <div className="grid grid-cols-3 gap-1.5">
            {/* (edit 502) Third mode: "ControlNet". */}
            {([['generate', 'Generate'], ['extend', 'Extend'], ['controlnet', 'ControlNet']] as const).map(([m, label]) => (
              <button
                key={m}
                type="button"
                onClick={() => useAssistantChats.getState().setAssistantMode(m)}
                className={cn(
                  'h-7 rounded-md border text-xs font-medium transition-all',
                  assistantMode === m
                    ? 'bg-emerald-500/15 border-emerald-500/50 text-emerald-300'
                    : 'bg-[var(--surface-2)] border-border text-muted-foreground hover:border-emerald-500/30',
                )}
              >
                {label}
              </button>
            ))}
          </div>
          )}
          <Button
            variant="outline"
            size="sm"
            className="w-full gap-1.5 text-xs justify-center"
            onClick={newChat}
          >
            <PlusIcon className="w-3.5 h-3.5" />
            New chat
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {/* (edit 427) List shows only chats for selected mode. */}
          {chats.filter((c) => c.mode === assistantMode).map((c) => {
            const isRenaming = renamingId === c.id
            return (
            <div
              key={c.id}
              onClick={() => { if (!isRenaming) switchChat(c.id) }}
              className={cn(
                'group flex items-center gap-2 px-3 py-2.5 cursor-pointer border-b border-border/40',
                c.id === activeId ? 'bg-amber-500/10' : 'hover:bg-white/5',
              )}
            >
              <MessageSquareIcon
                className={cn('w-3.5 h-3.5 shrink-0', c.id === activeId ? 'text-amber-400' : 'text-muted-foreground/60')}
              />
              {isRenaming ? (
                /* (edit 264) Inline chat title editor */
                <div className="flex-1 min-w-0 flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                  <input
                    ref={renameInputRef}
                    type="text"
                    value={renameValue}
                    maxLength={80}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); commitRename() }
                      else if (e.key === 'Escape') { e.preventDefault(); cancelRename() }
                    }}
                    onBlur={commitRename}
                    className="flex-1 min-w-0 rounded-md border border-cyan-500/50 bg-[var(--surface-2)] px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-cyan-500/50"
                    placeholder="Chat title"
                  />
                  <button
                    type="button"
                    onClick={commitRename}
                    className="shrink-0 w-6 h-6 flex items-center justify-center text-emerald-400 hover:text-emerald-300 hover:bg-emerald-500/10 rounded"
                    title="Save (Enter)"
                  >
                    <CheckIcon className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={cancelRename}
                    className="shrink-0 w-6 h-6 flex items-center justify-center text-muted-foreground/60 hover:text-red-400 hover:bg-red-500/10 rounded"
                    title="Cancel (Esc)"
                  >
                    <XIcon className="w-3.5 h-3.5" />
                  </button>
                </div>
              ) : (
                <div className="flex-1 min-w-0">
                  <p
                    className="text-xs text-foreground truncate"
                    onDoubleClick={(e) => { e.stopPropagation(); startRename(c.id, c.title) }}
                    title={c.title}
                  >
                    {c.title}
                    {c.id === streamChatId && (
                      <span
                        className="ml-1.5 inline-block w-1.5 h-1.5 rounded-full bg-cyan-400/80 animate-pulse align-middle"
                        title="Reply is generating in this chat"
                      />
                    )}
                  </p>
                  <p className="text-[10px] text-muted-foreground/60">
                    {c.id === streamChatId
                      ? 'generating reply…'
                      : `${c.messages.length} msg · ${new Date(c.updatedAt).toLocaleDateString('en-US')}`}
                  </p>
                </div>
              )}
              {isRenaming ? null : (
                <>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      startRename(c.id, c.title)
                    }}
                    className="shrink-0 w-5 h-5 flex items-center justify-center text-muted-foreground/40 hover:text-cyan-400 opacity-0 group-hover:opacity-100 transition-opacity"
                    title="Rename (double click title)"
                  >
                    <PencilIcon className="w-3 h-3" />
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      deleteChat(c.id)
                    }}
                    className="shrink-0 w-5 h-5 flex items-center justify-center text-muted-foreground/40 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
                    title="Delete chat"
                  >
                    <XIcon className="w-3 h-3" />
                  </button>
                </>
              )}
            </div>
            )
          })}
          {chats.filter((c) => c.mode === assistantMode).length === 0 && (
            <p className="text-[10px] text-muted-foreground/50 text-center py-6 px-3">
              No chats in "{assistantMode === 'extend' ? 'Extend' : assistantMode === 'controlnet' ? 'ControlNet' : 'Generate'}" mode. Create a new one.
            </p>
          )}
        </div>
      </div>
      )}

      {/* (edit 719) Preview reference on click on <Picture N>/
          <Video N> tag in assistant reply. */}
      <RefViewerDialog
        data={viewingRef}
        onOpenChange={(v) => { if (!v) setViewingRef(null) }}
      />
    </div>
  )
}

/** Short string hash (djb2). */
function hashStr(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(36)
}
