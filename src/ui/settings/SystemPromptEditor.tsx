import { useEffect, useMemo, useRef, useState } from 'react'
import type { Chat } from '../../core/types'
import { estimateTokensByTokenizer } from '../../core/tokens'
import { updateChatSettings } from '../../store/chats'

export interface SystemPromptEditorProps {
  chat: Chat
}

const SAVE_DEBOUNCE_MS = 300
const ESTIMATE_DEBOUNCE_MS = 120
const TOAST_STORAGE_KEY = 'natter:system-prompt-toast-shown'

export function SystemPromptEditor({ chat }: SystemPromptEditorProps) {
  const [draft, setDraft] = useState(chat.settings.systemPrompt)
  const [estimateText, setEstimateText] = useState(() =>
    chat.settings.systemPrompt,
  )
  const [toastVisible, setToastVisible] = useState(false)
  // Reset local draft whenever the upstream chat row swaps (chat navigation).
  const lastChatIdRef = useRef(chat.id)
  useEffect(() => {
    if (lastChatIdRef.current !== chat.id) {
      lastChatIdRef.current = chat.id
      setDraft(chat.settings.systemPrompt)
      setEstimateText(chat.settings.systemPrompt)
    }
  }, [chat.id, chat.settings.systemPrompt])
  // Debounced token estimate.
  useEffect(() => {
    const id = setTimeout(() => setEstimateText(draft), ESTIMATE_DEBOUNCE_MS)
    return () => clearTimeout(id)
  }, [draft])
  // Debounced persistence (also triggers the toast the first time).
  useEffect(() => {
    if (draft === chat.settings.systemPrompt) return
    const id = setTimeout(async () => {
      const saved = await updateChatSettings(chat.id, { systemPrompt: draft })
      if (saved) {
        if (
          typeof window !== 'undefined' &&
          !window.sessionStorage.getItem(TOAST_STORAGE_KEY)
        ) {
          window.sessionStorage.setItem(TOAST_STORAGE_KEY, '1')
          setToastVisible(true)
          window.setTimeout(() => setToastVisible(false), 4000)
        }
      }
    }, SAVE_DEBOUNCE_MS)
    return () => clearTimeout(id)
  }, [draft, chat.id, chat.settings.systemPrompt])
  const tokens = useMemo(
    () => estimateTokensByTokenizer(estimateText, null),
    [estimateText],
  )
  return (
    <div data-ui="settings-section">
      <h3>System prompt</h3>
      {toastVisible ? (
        <div data-ui="settings-toast" role="status">
          System prompt updated — it takes effect on your next send. Earlier
          responses used the previous prompt.
        </div>
      ) : null}
      <div data-ui="field-group">
        <label htmlFor="system-prompt-textarea" data-ui="visually-hidden">
          System prompt
        </label>
        <textarea
          id="system-prompt-textarea"
          data-ui="system-prompt-textarea"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Leave empty to send no system message."
          rows={8}
        />
        <span data-ui="system-prompt-token-estimate" aria-live="polite">
          ~{tokens.toLocaleString()} tokens
        </span>
      </div>
    </div>
  )
}
