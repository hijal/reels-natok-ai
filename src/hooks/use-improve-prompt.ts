'use client'

/**
 * useImprovePrompt — single entry point for "Fix prompt" (fix 560:
 * previously "Improve prompt"; from the prompt editor the request now goes as a PAIR —
 * user instructions "what to change" (fixRequest) + draft itself).
 *
 * Queues the improve-prompt request in the assistant-chats store (so it
 * survives a tab switch), then asks the app shell to open the assistant
 * panel (fix 442: right panel on "Generation"/"Extend", not a tab).
 * AssistantView picks it up on mount and auto-runs the completion.
 *
 * (fix 427) Modes: 'generate' (default, draft on "Generation" tab),
 * 'extend' (clip prompt on "Extend" tab card),
 * 'controlnet' (prompt on "ControlNet" tab, fix 502). The request always
 * goes into an existing chat of its mode (fix 559) and switches the chat
 * filter to this mode.
 */
import { useCallback } from 'react'
import { useAssistantChats, type AssistantChatMode } from '@/lib/assistant-chats-store'

/** (fix 427) Fix options: chat mode and clip number (extend). */
export interface ImprovePromptOptions {
  mode?: AssistantChatMode
  /** Extend: clip card number (1-based) — quoted in the message. */
  clipNumber?: number
  /** (fix 560) Specific user instructions "what to change" from the
   *  "Fix prompt" dialog in the editor — quoted first in the message,
   *  so that the LLM modifies specifically that, preserving the rest of the prompt's meaning. */
  fixRequest?: string
}

/** Build the user-facing prompt text. */
export function buildImprovePrompt(currentPrompt: string, opts?: ImprovePromptOptions): string {
  const trimmed = currentPrompt.trim()
  const fix = opts?.fixRequest?.trim()
  // (fix 560) User request as the first line, requiring not to
  // touch anything not related to the request.
  const fixLine = fix ? `Task: "${fix}".\nKeep everything NOT related to this task unchanged.\n` : ''
  // (fix 427) Extend: quote the CLIP prompt with its number; empty prompt —
  // ask to generate from scratch based on source context (in the extend chat
  // system prompt: metadata .meta.json + extend references).
  if (opts?.mode === 'extend') {
    const n = opts.clipNumber ?? 1
    return trimmed
      ? `${fixLine}Fix the prompt for clip ${n}, preserving the meaning. Current clip prompt:\n\n${trimmed}`
      : `Create a prompt for clip ${n} from scratch based on the context of the source video and extend references (in system context).${fix ? ` Task: "${fix}".` : ''}`
  }
  // (fix 502) ControlNet: motion/camera is defined by the control video —
  // fix ONLY scene/appearance/style/lighting/sound descriptions.
  if (opts?.mode === 'controlnet') {
    return trimmed
      ? `${fixLine}Fix my prompt for ControlNet mode, preserving the meaning. Do NOT describe motion or camera — they are defined by the control video; include only scene, character appearances, style, lighting, and sound in the prompt. Reference images using <Picture N> tags. Current prompt:\n\n${trimmed}`
      : 'Create a prompt for ControlNet mode from scratch: motion and camera are set by the control video (in system context); describe only scene, character appearance, style, lighting, and sound. If reference images are attached, reference them using <Picture N> tags.'
  }
  return trimmed
    ? `${fixLine}Fix my current prompt, preserving the meaning. Current prompt:\n\n${trimmed}`
    : 'Suggest 3 different ideas for a short video (5–8 seconds) with the references I will attach.'
}

/**
 * Queue an improve-prompt request and switch to the assistant tab.
 * Safe to call from anywhere (the store is a module singleton).
 *
 * (fix 559) Previously EVERY improve-request created a new chat — chats
 * spawned from every "Improve prompt" button (prompt editor, clip card,
 * ControlNet). Now the request goes into the SAME chat for the mode as the quick
 * panel button: active chat for the mode (the one opened in the tab panel),
 * otherwise the freshest chat of this mode; new chat — only if no chats exist
 * for this mode yet. Request context (mode + clip number) is still
 * quoted in the message itself.
 */
export function requestImprovePrompt(currentPrompt: string, opts?: ImprovePromptOptions): void {
  if (typeof window === 'undefined') return

  const mode: AssistantChatMode = opts?.mode ?? 'generate'
  const content = buildImprovePrompt(currentPrompt, opts)
  // (fix 266) Chat id passed into pendingImprove: if AssistantView is already
  // mounted, improve must be executed in THIS chat (subscription to
  // pendingImprove in view restarts the auto-run effect).
  // (fix 427) Chat list filter switches to request mode —
  // otherwise mode chat would be hidden by the filter of another mode.
  const st = useAssistantChats.getState()
  st.setAssistantMode(mode)
  // (fix 559) Reuse existing mode chat instead of creating
  // a new one. Chat list is sorted by updatedAt (fresh on top) —
  // fallback branch takes the newest chat of this mode.
  const active = st.chats.find((c) => c.id === st.activeChatId)
  const chatId =
    active && active.mode === mode
      ? active.id
      : (st.chats.find((c) => c.mode === mode)?.id ?? st.createChat(mode))
  st.queueImprove(content, chatId)

  // (fix 442) "Assistant" tab no longer exists: ask app-shell to switch
  // to the desired mode tab and expand the right assistant panel.
  window.dispatchEvent(new CustomEvent('h3:open-assistant-panel', { detail: { mode } }))
}

/**
 * Hook wrapper (so callers can memoize if needed). Returns a stable callback.
 */
export function useImprovePrompt() {
  return useCallback(
    (currentPrompt: string, opts?: ImprovePromptOptions) => {
      requestImprovePrompt(currentPrompt, opts)
    },
    [],
  )
}
