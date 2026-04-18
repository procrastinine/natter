import { useLiveQuery } from 'dexie-react-hooks'
import { memo, useMemo } from 'react'
import { activePath } from '../../core/active-path'
import type { ChatId, CursorMap } from '../../core/types'
import { loadChatMessages } from '../../store/chats'
import { useChatStore } from '../../store/zustand/chatStore'
import { Message } from './Message'

export interface MessageListProps {
  chatId: ChatId
}

// Stable reference so `useChatStore(selector)` doesn't allocate a fresh `{}`
// every render — that triggers React 19's infinite-rerender detection via
// `useSyncExternalStore` (getSnapshot must return a stable value).
const EMPTY_CURSOR: CursorMap = Object.freeze({}) as CursorMap

// Memoized at the list level so prefs changes (theme, send shortcut,
// chat width) on the Shell don't cascade into a re-render of the
// markdown-heavy children.
export const MessageList = memo(function MessageList({
  chatId,
}: MessageListProps) {
  const messages = useLiveQuery(() => loadChatMessages(chatId), [chatId], [])
  const cursor = useChatStore(
    (state) => state.cursors[chatId] ?? EMPTY_CURSOR,
  )
  const path = useMemo(
    () => activePath(messages ?? [], cursor),
    [messages, cursor],
  )
  return (
    <div data-ui="message-list" aria-live="polite">
      {path.map((m) => (
        <Message key={m.id} message={m} />
      ))}
    </div>
  )
})
