import type { Table } from 'dexie'
import { emptyChildListAggregate } from '../core/child-list-state'
import type { ChildListState, Message } from '../core/types'
import { forEachTableBatch } from './batched-table'

export async function migrateLegacyChildLists<
  TMessage extends Pick<Message, 'chatId' | 'parentId'>,
>(messages: Table<TMessage, string>, childLists: Table<ChildListState, string>): Promise<void> {
  await forEachTableBatch(messages, async (rows) => {
    const entries = new Map<string, ChildListState>()
    for (const row of rows) {
      const id = `${row.chatId}:${row.parentId ?? '__root__'}`
      entries.set(id, {
        id,
        chatId: row.chatId,
        parentId: row.parentId,
        version: 0,
        updatedAt: 0,
        ...emptyChildListAggregate(),
      })
    }
    if (entries.size > 0) await childLists.bulkPut([...entries.values()])
  })
}
