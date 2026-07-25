import type Dexie from 'dexie'
import type { Table, Transaction } from 'dexie'
import type { Chat, ChatId } from '../core/types'
import {
  type ChatSidebarProjectionRow,
  chatSidebarProjectionRow,
} from '../store/chat-sidebar-projection'
import type { SettingsRow } from '../store/db-rows'
import {
  type MessageBodyRow,
  type MessageHeaderRow,
  previewTextFromContent,
} from '../store/message-storage'
import { forEachTableBatch } from './batched-table'
import { runOnceBackfill, runOnceBackfillInTransaction } from './run-once'

const CHAT_PREVIEW_PROJECTION_BACKFILL_KEY = 'backfill:chat-preview-projection-v1'

export function chatPreviewProjectionBackfillMarker(): SettingsRow {
  return { key: CHAT_PREVIEW_PROJECTION_BACKFILL_KEY, value: 1 }
}

export async function migrateChatPreviewProjection(tx: Transaction): Promise<void> {
  await runOnceBackfillInTransaction(tx, {
    marker: chatPreviewProjectionBackfillMarker(),
    run: migrateChatPreviewProjectionRows,
  })
}

async function migrateChatPreviewProjectionRows(tx: Transaction): Promise<void> {
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
      await tx
        .table<ChatSidebarProjectionRow, ChatId>('chatSidebarRows')
        .put(chatSidebarProjectionRow(next))
    }
  })
}

export async function backfillChatPreviewProjection(db: Dexie): Promise<void> {
  await runOnceBackfill(db, {
    marker: chatPreviewProjectionBackfillMarker(),
    tables: ['chats', 'messages', 'messageBodies', 'chatSidebarRows'],
    run: migrateChatPreviewProjectionRows,
  })
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
