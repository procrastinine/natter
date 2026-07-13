import type Dexie from 'dexie'
import type { Table, Transaction } from 'dexie'
import type { Chat, ChatId } from '../core/types'
import { putChatSidebarProjection } from '../store/chat-sidebar-projection'
import type { SettingsRow } from '../store/db-rows'
import {
  type MessageBodyRow,
  type MessageHeaderRow,
  previewTextFromContent,
} from '../store/message-storage'
import { forEachTableBatch } from './batched-table'

const CHAT_PREVIEW_PROJECTION_BACKFILL_KEY = 'backfill:chat-preview-projection-v1'

export function chatPreviewProjectionBackfillMarker(): SettingsRow {
  return { key: CHAT_PREVIEW_PROJECTION_BACKFILL_KEY, value: 1 }
}

export async function migrateChatPreviewProjection(tx: Transaction): Promise<void> {
  const settings = tx.table<SettingsRow, string>('settings')
  if ((await settings.get(CHAT_PREVIEW_PROJECTION_BACKFILL_KEY))?.value === 1) return

  const chats = tx.table<Chat, ChatId>('chats')
  const earliestByChat = await earliestLiveUserHeaders(
    tx.table<MessageHeaderRow, string>('messages'),
  )
  const bodies = tx.table<MessageBodyRow, string>('messageBodies')

  await forEachTableBatch(chats, async (rows) => {
    for (const chat of rows) {
      const header = earliestByChat.get(chat.id)
      const body = header ? await bodies.get(header.id) : undefined
      const next = { ...chat, previewText: previewTextFromContent(body?.content ?? []) }
      await chats.put(next)
      await putChatSidebarProjection(tx, next)
    }
  })
  await settings.put(chatPreviewProjectionBackfillMarker())
}

export async function backfillChatPreviewProjection(db: Dexie): Promise<void> {
  const chats = db.table<Chat, ChatId>('chats')
  const messages = db.table<MessageHeaderRow, string>('messages')
  const bodies = db.table<MessageBodyRow, string>('messageBodies')
  const sidebarRows = db.table('chatSidebarRows')
  const settings = db.table<SettingsRow, string>('settings')
  if ((await settings.get(CHAT_PREVIEW_PROJECTION_BACKFILL_KEY))?.value === 1) return
  await db.transaction('rw', chats, sidebarRows, messages, bodies, settings, (tx) =>
    migrateChatPreviewProjection(tx),
  )
}

async function earliestLiveUserHeaders(
  rows: Table<MessageHeaderRow, string>,
): Promise<Map<ChatId, Pick<MessageHeaderRow, 'id' | 'createdAt'>>> {
  const earliestByChat = new Map<ChatId, Pick<MessageHeaderRow, 'id' | 'createdAt'>>()
  await rows.each((row) => {
    if (row.deleted || row.role !== 'user') return
    const earliest = earliestByChat.get(row.chatId)
    if (
      !earliest ||
      row.createdAt < earliest.createdAt ||
      (row.createdAt === earliest.createdAt && row.id < earliest.id)
    ) {
      earliestByChat.set(row.chatId, { id: row.id, createdAt: row.createdAt })
    }
  })
  return earliestByChat
}
