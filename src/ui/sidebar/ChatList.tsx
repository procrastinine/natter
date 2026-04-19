import { useLiveQuery } from 'dexie-react-hooks'
import { memo, useCallback } from 'react'
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

// Loads the chat-row list only — never touches the `messages` table.
// `chat.previewText` is populated by `refreshChatPreview` on the write
// path (see src/store/chat-preview-maintainer.ts), so the sidebar stays
// cheap even with thousands of chats. The daemon-mode equivalent will
// implement the same read via the repository boundary; this module
// doesn't couple to Dexie semantics beyond the live-query subscription.
async function loadChatRows(): Promise<Chat[]> {
  const db = getDb()
  const rows = await db.chats.toArray()
  return rows
    .filter((r) => !r.archived)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export const ChatList = memo(function ChatList({
  activeChatId,
  collapsed,
}: ChatListProps) {
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
      {(rows ?? []).map((chat) => {
        const displayTitle = chat.title?.trim().length
          ? chat.title
          : 'Untitled chat'
        const preview = chat.previewText ?? ''
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
})
