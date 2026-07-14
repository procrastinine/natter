import type { Transaction } from 'dexie'
import type { Message } from '../core/types'
import { countMessagesWords } from '../core/word-count'
import type { MessageBodyRow, MessageHeaderRow } from '../store/message-storage'
import { forEachTableBatch } from './batched-table'

type LegacyMessageHeaderRow = Omit<MessageHeaderRow, 'bodyVersion' | 'bodyWordCount'> & {
  bodyVersion?: number
  bodyWordCount?: number
}

type LegacyMessageBodyRow = Omit<MessageBodyRow, 'bodyVersion'> & {
  bodyVersion?: number
  nodeVersion?: number
}

export async function migrateMessageBodyVersions(tx: Transaction): Promise<void> {
  const messages = tx.table<LegacyMessageHeaderRow, string>('messages')
  const bodies = tx.table<LegacyMessageBodyRow, string>('messageBodies')

  await forEachTableBatch(messages, async (headers) => {
    const storedBodies = await bodies.bulkGet(headers.map((header) => header.id))
    const nextHeaders: LegacyMessageHeaderRow[] = []
    const nextBodies: LegacyMessageBodyRow[] = []
    for (const [index, legacyHeader] of headers.entries()) {
      const legacyBody = storedBodies[index]
      const header = structuredClone(legacyHeader)
      header.bodyVersion = header.nodeVersion
      header.bodyWordCount = legacyBody ? countMessagesWords([legacyBody as unknown as Message]) : 0
      nextHeaders.push(header)
      if (!legacyBody) continue
      const body = structuredClone(legacyBody)
      body.bodyVersion = legacyBody.nodeVersion ?? header.bodyVersion
      delete body.nodeVersion
      nextBodies.push(body)
    }
    await messages.bulkPut(nextHeaders)
    if (nextBodies.length > 0) await bodies.bulkPut(nextBodies)
  })
}
