import type { Transaction } from 'dexie'
import type { MessageHeaderRow } from '../store/message-storage'
import { forEachTableBatch } from './batched-table'

type LegacyMessageHeaderRow = Omit<MessageHeaderRow, 'requestContextVersion'> & {
  requestContextVersion?: number
}

export async function migrateMessageRequestContextVersions(tx: Transaction): Promise<void> {
  const messages = tx.table<LegacyMessageHeaderRow, string>('messages')
  await forEachTableBatch(messages, async (headers) => {
    const patched: MessageHeaderRow[] = []
    for (const legacy of headers) {
      if (legacy.requestContextVersion !== undefined) continue
      patched.push({ ...legacy, requestContextVersion: 0 })
    }
    if (patched.length > 0) await messages.bulkPut(patched)
  })
}
