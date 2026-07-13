import type { Transaction } from 'dexie'
import {
  type MessageBodyRow,
  type MessageHeaderRow,
  syncMessageHeaderProjections,
} from '../store/message-storage'
import { forEachTableBatch } from './batched-table'

type LegacyMessageHeaderRow = Omit<MessageHeaderRow, 'textPreview'> & {
  textPreview?: string
}

export async function migrateMessageHeaderProjections(tx: Transaction): Promise<void> {
  const messages = tx.table<LegacyMessageHeaderRow, string>('messages')
  const bodies = tx.table<MessageBodyRow, string>('messageBodies')

  await forEachTableBatch(messages, async (headers) => {
    const bodyRows = await bodies.bulkGet(headers.map((header) => header.id))
    for (const [index, legacyHeader] of headers.entries()) {
      const body = bodyRows[index]
      const header = structuredClone(legacyHeader) as MessageHeaderRow
      if (!body) {
        header.textPreview = ''
        await messages.put(header)
        continue
      }
      const priorOutputs = body.generationServerToolOutputs
      syncMessageHeaderProjections(header, body, {
        replaceGenerationServerToolOutputs: true,
      })
      await messages.put(header)
      if (body.generationServerToolOutputs !== priorOutputs) await bodies.put(body)
    }
  })
}
