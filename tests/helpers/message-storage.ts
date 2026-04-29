import type { Message } from '../../src/core/types'
import { getDb } from '../../src/store/db'
import { splitMessageForStorage } from '../../src/store/message-storage'

export async function putTestMessage(row: Message): Promise<void> {
  const { header, body } = splitMessageForStorage(row)
  await getDb().messages.put(header)
  await getDb().messageBodies.put(body)
}

export async function putTestMessageHeaderOnly(row: Message): Promise<void> {
  const { header } = splitMessageForStorage(row)
  await getDb().messages.put(header)
}

export async function putTestMessages(rows: readonly Message[]): Promise<void> {
  const split = rows.map((row) => splitMessageForStorage(row))
  await getDb().messages.bulkPut(split.map((row) => row.header))
  await getDb().messageBodies.bulkPut(split.map((row) => row.body))
}
