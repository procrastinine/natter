import { useLiveQuery } from 'dexie-react-hooks'
import { useCallback } from 'react'
import type { Chat, ChatId } from '../../core/types'
import { getDb } from '../../store/db'

export interface ChatListProps {
  activeChatId: ChatId | null
  onSelect: (chatId: ChatId) => void
  onCreate: () => void
}

async function listChatsByRecency(): Promise<Chat[]> {
  const rows = await getDb().chats.toArray()
  return rows.filter((r) => !r.archived).sort((a, b) => b.updatedAt - a.updatedAt)
}

export function ChatList({ activeChatId, onSelect, onCreate }: ChatListProps) {
  const chats = useLiveQuery(listChatsByRecency, [], [])
  const handleSelect = useCallback(
    (id: ChatId) => () => onSelect(id),
    [onSelect],
  )
  return (
    <nav data-ui="sidebar-nav" aria-label="Chats">
      <button type="button" data-ui="new-chat" onClick={onCreate}>
        New chat
      </button>
      <ul data-ui="chat-list">
        {(chats ?? []).map((chat) => (
          <li
            key={chat.id}
            data-ui="chat-row"
            data-active={chat.id === activeChatId}
          >
            <button
              type="button"
              data-ui="chat-row-button"
              onClick={handleSelect(chat.id)}
            >
              {chat.title || 'Untitled chat'}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  )
}
