import type Dexie from 'dexie'
import type { Transaction } from 'dexie'
import type { Message } from '../core/types'
import type { SettingsRow } from '../store/db-rows'
import {
  MESSAGE_BODY_KEYS,
  type MessageBodyRow,
  splitMessageForStorage,
} from '../store/message-storage'
import { forEachTableBatch } from './batched-table'
import { runOnceBackfill, runOnceBackfillInTransaction } from './run-once'

const MESSAGE_BODY_SPLIT_BACKFILL_KEY = 'backfill:message-body-split-v1'

export function messageBodySplitBackfillMarker(): SettingsRow {
  return { key: MESSAGE_BODY_SPLIT_BACKFILL_KEY, value: 1 }
}

type LegacyInlineMessageRow = Record<string, unknown> & Partial<Message>

export async function migrateInlineMessageBodies(tx: Transaction): Promise<void> {
  await runOnceBackfillInTransaction(tx, {
    marker: messageBodySplitBackfillMarker(),
    run: migrateInlineMessageBodyRows,
  })
}

export async function backfillMissingMessageBodies(db: Dexie): Promise<void> {
  await runOnceBackfill(db, {
    marker: messageBodySplitBackfillMarker(),
    tables: ['messages', 'messageBodies'],
    run: backfillMissingMessageBodyRows,
  })
}

async function migrateInlineMessageBodyRows(tx: Transaction): Promise<void> {
  const messages = tx.table<LegacyInlineMessageRow, string>('messages')
  const bodies = tx.table<MessageBodyRow, string>('messageBodies')
  await forEachTableBatch(messages, async (rows) => {
    for (const row of rows) await splitAndStoreLegacyMessage(messages, bodies, row)
  })
}

async function backfillMissingMessageBodyRows(tx: Transaction): Promise<void> {
  const messages = tx.table<LegacyInlineMessageRow, string>('messages')
  const messageBodies = tx.table<MessageBodyRow, string>('messageBodies')
  await forEachTableBatch(messages, async (rows) => {
    for (const row of rows) {
      const existingBody = await messageBodies.get(String(row.id))
      if (existingBody) {
        if (hasInlineBodyFields(row)) await messages.put(stripInlineBodyFields(row))
        continue
      }
      if (!hasInlineBodyFields(row)) throw new Error(`MessageBodyMissing:${String(row.id)}`)
      await splitAndStoreLegacyMessage(messages, messageBodies, row)
    }
  })
}

export async function assertNoInlineMessageBodies(db: Dexie): Promise<void> {
  const messages = db.table<LegacyInlineMessageRow, string>('messages')
  await forEachTableBatch(messages, (rows) => {
    const bad = rows.find((row) => hasInlineBodyFields(row))
    if (bad) throw new Error(`InlineMessageBodyStillPresent:${String(bad.id)}`)
  })
}

function hasInlineBodyFields(row: LegacyInlineMessageRow): boolean {
  return MESSAGE_BODY_KEYS.some((key) => key in row)
}

async function splitAndStoreLegacyMessage(
  messages: { put(row: LegacyInlineMessageRow): Promise<unknown> },
  bodies: { put(row: MessageBodyRow): Promise<unknown> },
  row: LegacyInlineMessageRow,
): Promise<void> {
  const legacy = normalizeLegacyMessage(row)
  const { header, body } = splitMessageForStorage(legacy)
  await bodies.put(body)
  await messages.put(header as unknown as LegacyInlineMessageRow)
}

function normalizeLegacyMessage(row: LegacyInlineMessageRow): Message {
  const legacy = structuredClone(row)
  if (!Array.isArray(legacy.content)) legacy.content = []
  if (typeof legacy.nodeVersion !== 'number') legacy.nodeVersion = 0
  if (legacy.deleted !== true) legacy.deleted = false
  return legacy as unknown as Message
}

function stripInlineBodyFields(row: LegacyInlineMessageRow): LegacyInlineMessageRow {
  const next = structuredClone(row)
  for (const key of MESSAGE_BODY_KEYS) delete next[key]
  return next
}
