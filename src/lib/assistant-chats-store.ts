/**
 * Assistant chats store (Zustand, persisted to localStorage) — fix 30.
 *
 * Multiple named conversations with the local LLM assistant:
 *   - chats survive reloads / tab switches;
 *   - the active chat is restored on mount;
 *   - the title auto-derives from the first user message;
 *   - the model "remembers" a chat because the whole (capped) message
 *     history is replayed with every request — see assistant-view.tsx.
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface AssistantChatMessage {
  role: 'user' | 'assistant'
  content: string
  /** (fix 87) Message attachment (image/video for LLM analysis). */
  attachment?: {
    path: string
    name: string
    kind: 'image' | 'video'
    /** (fix 108) File location:
     *  'chat'  = data/chat-attachments/ (isolated chat storage — new);
     *  'comfy' = ComfyUI/input/ (legacy, fixes 86–87) — served via /api/comfy/file.
     *  Fields without src (old messages) render as legacy. */
    src?: 'chat' | 'comfy'
  }
}

/** (fix 427) Assistant chat mode: 'generate' — prompt of the
 *  "Generate" tab, 'extend' — prompts of clips of the "Extend" tab,
 *  (fix 502) 'controlnet' — prompt of the "ControlNet" tab. Chat mode
 *  does NOT change after creation: system prompt, reference set, and insertion
 *  logic ("To prompt" vs "To clip N") are different between modes; mixing contexts
 *  would result in garbage in model responses. */
export type AssistantChatMode = 'generate' | 'extend' | 'controlnet'

export interface AssistantChat {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  /** (fix 427) Chat mode; old persisted chats lack this field — merge guard
   *  below defaults to 'generate'. */
  mode: AssistantChatMode
  messages: AssistantChatMessage[]
}

const MAX_CHATS = 20
const MAX_MESSAGES_PER_CHAT = 200
/** (fix 267) Length limit of a single message: the 20x200 limits did not constrain
 *  SIZE — several huge messages would hit the localStorage quota
 *  (QuotaExceededError) and persist would silently stop saving chats. */
const MAX_MESSAGE_CONTENT = 100_000

/** (fix 267) Truncate message content to MAX_MESSAGE_CONTENT with a marker. */
function capContent(content: string): string {
  return content.length > MAX_MESSAGE_CONTENT
    ? content.slice(0, MAX_MESSAGE_CONTENT) + '\n… [message truncated]'
    : content
}

interface AssistantChatsState {
  chats: AssistantChat[]
  activeChatId: string | null
  /**
   * Pending user message to auto-run when the view mounts (e.g. the
   * "Improve prompt" flow from the prompt editor). Cleared after run.
   * (fix 266) Holds the id of the chat created by requestImprovePrompt — improve
   * executes specifically in it, rather than in the currently active chat.
   */
  pendingImprove: { chatId: string; content: string } | null
  /** (fix 427) Selected mode-filter for chat list ("Generate" /
   *  "Extend"). Persisted: yes — assistant tab opens in the same
   *  mode in which it was left. */
  assistantMode: AssistantChatMode

  /** Create a new empty chat, make it active, return its id.
   *  (fix 427) Chat mode — from argument or current assistantMode. */
  createChat: (mode?: AssistantChatMode) => string
  /** (fix 427) Switch chat list mode-filter. */
  setAssistantMode: (mode: AssistantChatMode) => void
  deleteChat: (id: string) => void
  /** (fix 264) Rename chat. Empty/whitespace-only title is a no-op. */
  renameChat: (id: string, newTitle: string) => void
  setActiveChat: (id: string) => void
  /** Append a message; auto-titles the chat from the first user message. */
  appendMessage: (id: string, msg: AssistantChatMessage) => void
  clearAll: () => void
  /** Queue an auto-run for the next AssistantView mount. */
  queueImprove: (content: string, chatId: string) => void
  /** Clear the queued auto-run. */
  clearImprove: () => void
}

function newId(): string {
  return `ac_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

function capChats(chats: AssistantChat[]): AssistantChat[] {
  return [...chats]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_CHATS)
}

export const useAssistantChats = create<AssistantChatsState>()(
  persist(
    (set, get) => ({
      chats: [],
      activeChatId: null,
      pendingImprove: null,
      assistantMode: 'generate',

      createChat: (mode) => {
        const id = newId()
        // (fix 427) New chat mode: explicit argument (e.g. improve
        // from clip card) or current mode-filter — "New Chat" in
        // sidebar creates a chat of specifically the selected mode.
        const chatMode: AssistantChatMode = mode ?? get().assistantMode
        set((s) => ({
          chats: capChats([
            { id, title: 'New chat', createdAt: Date.now(), updatedAt: Date.now(), mode: chatMode, messages: [] },
            ...s.chats,
          ]),
          activeChatId: id,
        }))
        return id
      },

      setAssistantMode: (mode) => set({ assistantMode: mode }),

      deleteChat: (id) =>
        set((s) => {
          const chats = s.chats.filter((c) => c.id !== id)
          let activeChatId = s.activeChatId
          if (activeChatId === id) {
            activeChatId = chats[0]?.id ?? null
          }
          // (fix 108) Attachment files of the deleted chat exist only in the chat —
          // delete them from disk (best-effort, fire-and-forget). Legacy files
          // in ComfyUI/input/ are NOT touched: they might be generation references.
          const doomed = s.chats.find((c) => c.id === id)
          if (doomed && typeof window !== 'undefined') {
            for (const m of doomed.messages) {
              const a = m.attachment
              if (a && a.src === 'chat' && typeof a.path === 'string' && a.path) {
                void fetch(
                  `/api/assistant/attachment?filename=${encodeURIComponent(a.path)}`,
                  { method: 'DELETE' },
                ).catch(() => {})
              }
            }
          }
          return { chats, activeChatId }
        }),

      // (fix 264) Renaming: update only title (without updatedAt —
      // otherwise chat pops to the top of list due to capChats sorting, which
      // is disorienting during renaming). 80 character limit.
      renameChat: (id, newTitle) =>
        set((s) => {
          const title = newTitle.trim().slice(0, 80)
          if (!title) return s
          return {
            chats: s.chats.map((c) => (c.id === id ? { ...c, title } : c)),
          }
        }),

      setActiveChat: (id) =>
        set((s) => (s.chats.some((c) => c.id === id) ? { activeChatId: id } : s)),

      appendMessage: (id, msg) =>
        set((s) => ({
          chats: capChats(
            s.chats.map((c) => {
              if (c.id !== id) return c
              const title =
                (c.title === 'New chat' || !c.title) && msg.role === 'user'
                  ? msg.content.trim().replace(/\s+/g, ' ').slice(0, 48) || 'Chat'
                  : c.title
              return {
                ...c,
                title,
                updatedAt: Date.now(),
                messages: [...c.messages, { ...msg, content: capContent(msg.content) }].slice(-MAX_MESSAGES_PER_CHAT),
              }
            }),
          ),
        })),

      clearAll: () =>
        set((s) => {
          // (fix 108) "Clear content" in settings = deletion of ALL chats:
          // delete their attachment files from isolated storage as well
          // (best-effort, as in deleteChat) — otherwise orphans remain on disk.
          if (typeof window !== 'undefined') {
            for (const c of s.chats) {
              for (const m of c.messages) {
                const a = m.attachment
                if (a && a.src === 'chat' && typeof a.path === 'string' && a.path) {
                  void fetch(
                    `/api/assistant/attachment?filename=${encodeURIComponent(a.path)}`,
                    { method: 'DELETE' },
                  ).catch(() => {})
                }
              }
            }
          }
          return { chats: [], activeChatId: null }
        }),

      queueImprove: (content, chatId) => set({ pendingImprove: { chatId, content } }),
      clearImprove: () => set({ pendingImprove: null }),
    }),
    {
      name: 'h3-assistant-chats',
      version: 1,
      partialize: (state) => ({
        chats: state.chats,
        activeChatId: state.activeChatId,
        pendingImprove: state.pendingImprove,
        assistantMode: state.assistantMode, // (fix 427)
      }),
      merge: (persisted, current) => {
        const raw = persisted as AssistantChatsState | null
        let chats: AssistantChat[] = Array.isArray(raw?.chats)
          ? raw.chats.filter(
              (c) =>
                c &&
                typeof c.id === 'string' &&
                Array.isArray(c.messages) &&
                c.messages.every((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string'),
            )
          : []
        chats = capChats(chats)
        // (fix 267) Old persists without size limit — truncate upon rehydration.
        // (fix 427) Old persists without mode — these are "Generate" chats
        // (extend mode did not exist back then).
        chats = chats.map((c) => ({
          ...c,
          mode: typeof c.mode === 'string' ? c.mode : 'generate',
          messages: c.messages.map((m) => ({ ...m, content: capContent(m.content) })),
        }))
        const activeChatId =
          typeof raw?.activeChatId === 'string' && chats.some((c) => c.id === raw.activeChatId)
            ? raw.activeChatId
            : (chats[0]?.id ?? null)
        // (fix 266) pendingImprove is an object { chatId, content }; discard old
        // persists with a string (without chatId there is nowhere to execute them).
        const pi = raw?.pendingImprove
        const pendingImprove =
          pi && typeof pi === 'object' &&
          typeof (pi as { chatId?: unknown }).chatId === 'string' &&
          typeof (pi as { content?: unknown }).content === 'string'
            ? (pi as { chatId: string; content: string })
            : null
        // (fix 427) Mode-filter from persist; garbage → 'generate'.
        // (fix 502) Whitelist of three modes ('controlnet' added).
        const assistantMode: AssistantChatMode =
          raw?.assistantMode === 'extend' || raw?.assistantMode === 'controlnet'
            ? raw.assistantMode
            : 'generate'
        return { ...current, chats, activeChatId, pendingImprove, assistantMode }
      },
    },
  ),
)
