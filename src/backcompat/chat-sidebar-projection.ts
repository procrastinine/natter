import type { Transaction } from 'dexie'
import type { Chat, ChatId } from '../core/types'
import {
  type ChatSidebarProjectionRow,
  chatSidebarProjectionRow,
  chatSidebarProjectionSettings,
} from '../store/chat-sidebar-projection'
import type { SettingsRow } from '../store/db-rows'
import { forEachTableBatch } from './batched-table'

export async function migrateChatSidebarProjection(tx: Transaction): Promise<void> {
  const chats = tx.table<Chat, ChatId>('chats')
  const rows = tx.table<ChatSidebarProjectionRow, ChatId>('chatSidebarRows')
  await rows.clear()
  const stats = await forEachTableBatch(chats, async (batch) => {
    await rows.bulkPut(batch.map(chatSidebarProjectionRow))
  })
  await tx
    .table<SettingsRow, string>('settings')
    .bulkPut(chatSidebarProjectionSettings(stats.rowCount))
}
