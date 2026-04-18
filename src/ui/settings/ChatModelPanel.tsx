import { useLiveQuery } from 'dexie-react-hooks'
import type { ChatId } from '../../core/types'
import { getChat } from '../../store/chats'
import { CloseIcon } from '../icons/Icon'
import { SystemPromptEditor } from './SystemPromptEditor'

export interface ChatModelPanelProps {
  chatId: ChatId
  onClose: () => void
}

// The right-side drawer for THIS chat's per-chat settings (system prompt now,
// model + sampling + reasoning later in Phase 9). Coexists with the sidebar
// and main pane — does NOT dim or block them.
export function ChatModelPanel({ chatId, onClose }: ChatModelPanelProps) {
  const chat = useLiveQuery(
    () => getChat(chatId),
    [chatId],
    undefined,
  )
  return (
    <aside
      data-ui="chat-model-panel"
      role="complementary"
      aria-label="Chat model settings"
    >
      <header data-ui="settings-pane-header">
        <span data-ui="settings-pane-title">Model</span>
        <button
          type="button"
          data-ui="icon-button"
          data-role="settings-pane-close"
          onClick={onClose}
          aria-label="Close model panel"
        >
          <CloseIcon size={16} />
        </button>
      </header>
      <div data-ui="settings-panel">
        {chat ? (
          <SystemPromptEditor chat={chat} />
        ) : (
          <p data-ui="helper">Loading…</p>
        )}
      </div>
    </aside>
  )
}
