import { useLiveQuery } from 'dexie-react-hooks'
import { useCallback } from 'react'
import type { Chat, ChatId } from '../../core/types'
import { archiveChat } from '../../store/chats'
import { getDb } from '../../store/db'
import {
  chatHref,
  makeAnchorClickHandler,
  navigateHome,
} from '../../app/router'
import { TrashIcon } from '../icons/Icon'

export interface ChatListProps {
  activeChatId: ChatId | null
  collapsed?: boolean
}

interface ChatRowData {
  chat: Chat
  preview: string
}

const PREVIEW_MAX_CHARS = 80

async function loadChatRows(): Promise<ChatRowData[]> {
  const db = getDb()
  const rows = await db.chats.toArray()
  const live = rows
    .filter((r) => !r.archived)
    .sort((a, b) => b.updatedAt - a.updatedAt)
  // Pull the first user message for each chat to use as the preview line.
  // For the V1 sidebar this is fine; once `chatBranchCache.previewText` is
  // implemented (plan/02-data-model.md §2.10.4) we can swap to that for free.
  const previews = await Promise.all(
    live.map(async (chat) => {
      const messages = await db.messages
        .where('chatId')
        .equals(chat.id)
        .filter((m) => !m.deleted && m.role === 'user')
        .toArray()
      messages.sort((a, b) => a.createdAt - b.createdAt)
      const first = messages[0]
      const text = first
        ? first.content
            .map((p) => (p.type === 'text' || p.type === 'output_text' ? p.text : ''))
            .join('')
        : ''
      const trimmed = text.replace(/\s+/g, ' ').trim()
      return trimmed.length > PREVIEW_MAX_CHARS
        ? `${trimmed.slice(0, PREVIEW_MAX_CHARS - 1)}…`
        : trimmed
    }),
  )
  return live.map((chat, i) => ({ chat, preview: previews[i] ?? '' }))
}

export function ChatList({ activeChatId, collapsed }: ChatListProps) {
  const rows = useLiveQuery(loadChatRows, [], [])
  const handleDelete = useCallback(
    async (chat: Chat) => {
      const label = chat.title?.trim().length ? chat.title : 'this untitled chat'
      const confirmed = window.confirm(`Delete "${label}"? You can restore it later from the archive.`)
      if (!confirmed) return
      await archiveChat(chat.id)
      if (activeChatId === chat.id) navigateHome()
    },
    [activeChatId],
  )
  return (
    <ul data-ui="chat-list">
      {(rows ?? []).map(({ chat, preview }) => {
        const displayTitle = chat.title?.trim().length
          ? chat.title
          : 'Untitled chat'
        const href = chatHref(chat.id)
        return (
          <li
            key={chat.id}
            data-ui="chat-row"
            data-active={chat.id === activeChatId}
            data-title-status={chat.titleStatus}
          >
            <a
              data-ui="chat-row-link"
              href={href}
              rel="noopener"
              onClick={makeAnchorClickHandler(href)}
            >
              <span data-ui="chat-row-title">{displayTitle}</span>
              {!collapsed && preview ? (
                <span data-ui="chat-row-preview">{preview}</span>
              ) : null}
            </a>
            {collapsed ? null : (
              <button
                type="button"
                data-ui="chat-row-delete"
                aria-label={`Delete ${displayTitle}`}
                title="Delete chat"
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  void handleDelete(chat)
                }}
              >
                <TrashIcon size={14} />
              </button>
            )}
          </li>
        )
      })}
    </ul>
  )
}
