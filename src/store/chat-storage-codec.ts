import type Dexie from 'dexie'
import type { CreatingHookContext, Table, Transaction, UpdatingHookContext } from 'dexie'
import type { Chat, ChatId } from '../core/types'
import { exactCompoundPrefixBetween } from './indexeddb-key-ranges'
import type { TemporaryChatCursor } from './storage-retention-state'

export interface ChatStoragePhysicalIndexFields {
  archivedKey: 0 | 1
  temporaryKey: 0 | 1
  temporaryRetentionAt: number
}

type ChatStorageRow = Chat & ChatStoragePhysicalIndexFields

const transactionCurrentChatBrand: unique symbol = Symbol('TransactionCurrentChat')
const transactionCurrentChatRuntimeBrand = Symbol.for('natter.TransactionCurrentChat')

export type TransactionCurrentChat = Chat & {
  readonly [transactionCurrentChatBrand]: true
}

export interface ChatIdPage {
  readonly chatIds: readonly ChatId[]
  readonly nextAfterChatId?: ChatId
  readonly done: boolean
}

export interface TemporaryChatIdPage {
  readonly chatIds: readonly ChatId[]
  readonly nextCursor?: TemporaryChatCursor
  readonly earliestDeferredAt?: number
  readonly done: boolean
}

interface ChatStorageTableSource {
  table<Row, Key>(name: string): Table<Row, Key>
}

export function installChatStorageCodec(db: Dexie): void {
  const chats = db.table<ChatStorageRow, ChatId>('chats')
  chats.hook(
    'creating',
    function (this: CreatingHookContext<ChatStorageRow, ChatId>, _primaryKey, row) {
      const hadArchivedKey = Object.hasOwn(row, 'archivedKey')
      const hadTemporaryKey = Object.hasOwn(row, 'temporaryKey')
      const hadTemporaryRetentionAt = Object.hasOwn(row, 'temporaryRetentionAt')
      const previousArchivedKey = row.archivedKey
      const previousTemporaryKey = row.temporaryKey
      const previousTemporaryRetentionAt = row.temporaryRetentionAt
      Object.assign(row, chatStoragePhysicalIndexFields(row))
      const restore = () => {
        if (hadArchivedKey) row.archivedKey = previousArchivedKey
        else delete (row as Partial<ChatStorageRow>).archivedKey
        if (hadTemporaryKey) row.temporaryKey = previousTemporaryKey
        else delete (row as Partial<ChatStorageRow>).temporaryKey
        if (hadTemporaryRetentionAt) row.temporaryRetentionAt = previousTemporaryRetentionAt
        else delete (row as Partial<ChatStorageRow>).temporaryRetentionAt
      }
      this.onsuccess = restore
      this.onerror = restore
    },
  )
  chats.hook(
    'updating',
    function (this: UpdatingHookContext<ChatStorageRow, ChatId>, changes, _primaryKey, row) {
      const restore = preservePhysicalIndexFields(changes)
      this.onsuccess = (updated) => {
        restore()
        if (updated !== changes) stripPhysicalIndexFields(updated)
      }
      this.onerror = restore
      const next = { ...(row as Chat), ...(changes as Partial<Chat>) }
      return chatStoragePhysicalIndexFields(next)
    },
  )
  chats.hook('reading', (stored) => publicChat(stored))
}

export function currentChatRowForTransaction(tx: Transaction, row: Chat): TransactionCurrentChat {
  if (transactionCurrentChatIdentity(row) !== transactionIdentity(tx)) {
    throw new Error(`ChatRowPriorNotCurrentTransaction:${row.id}`)
  }
  return row as TransactionCurrentChat
}

export async function readCurrentChatForTransaction(
  tx: Transaction,
  id: ChatId,
): Promise<TransactionCurrentChat | undefined> {
  const row = await tx.table<Chat, ChatId>('chats').get(id)
  if (!row) return undefined
  markCurrentChatRow(row, transactionIdentity(tx))
  return row as TransactionCurrentChat
}

export async function readCurrentChatRowsForTransaction(
  tx: Transaction,
  ids: readonly ChatId[],
): Promise<readonly TransactionCurrentChat[]> {
  const rows = await readOptionalCurrentChatRowsForTransaction(tx, ids)
  return rows.map((row, index) => {
    if (!row) throw new Error(`ChatRowPriorMissing:${ids[index] as ChatId}`)
    return row
  })
}

export async function readOptionalCurrentChatRowsForTransaction(
  tx: Transaction,
  ids: readonly ChatId[],
): Promise<readonly (TransactionCurrentChat | undefined)[]> {
  const rows = await tx.table<Chat, ChatId>('chats').bulkGet([...ids])
  return markCurrentChatRows(tx, rows)
}

export async function readAllCurrentChatsForTransaction(
  tx: Transaction,
): Promise<readonly TransactionCurrentChat[]> {
  return markCurrentChatRows(tx, await tx.table<Chat, ChatId>('chats').toArray())
}

export async function readCurrentChatsInFolderForTransaction(
  tx: Transaction,
  folderId: NonNullable<Chat['folderId']>,
): Promise<readonly TransactionCurrentChat[]> {
  return markCurrentChatRows(
    tx,
    await tx.table<Chat, ChatId>('chats').where('folderId').equals(folderId).toArray(),
  )
}

export async function readArchivedChatIdPage(
  db: ChatStorageTableSource,
  input: { readonly afterChatId?: ChatId; readonly limit: number },
): Promise<ChatIdPage> {
  return readChatIdPage(db, '[archivedKey+id]', input, 'ArchivedChatPageLimitInvalid')
}

export async function readTemporaryChatIdPage(
  db: ChatStorageTableSource,
  input: {
    readonly after?: TemporaryChatCursor
    readonly cutoff: number
    readonly limit: number
  },
): Promise<TemporaryChatIdPage> {
  if (!Number.isSafeInteger(input.limit) || input.limit <= 0) {
    throw new Error('TemporaryChatPageLimitInvalid')
  }
  if (!Number.isFinite(input.cutoff)) throw new Error('TemporaryChatPageCutoffInvalid')
  const index = db
    .table<ChatStorageRow, ChatId>('chats')
    .where('[temporaryKey+temporaryRetentionAt+id]')
  const lower = input.after ? [1, input.after.retentionAt, input.after.chatId] : [1]
  const keys = (await index
    .between(lower, [1, input.cutoff], false, false)
    .limit(input.limit + 1)
    .keys()) as unknown as Array<[1, number, ChatId]>
  const pageKeys = keys.slice(0, input.limit)
  const last = pageKeys.at(-1)
  const done = keys.length <= input.limit
  const deferredKey = done
    ? (
        (await index
          .between([1, input.cutoff], [1, []], true, false)
          .limit(1)
          .keys()) as unknown as Array<[1, number, ChatId]>
      )[0]
    : undefined
  return {
    chatIds: pageKeys.map((key) => key[2]),
    ...(!done && last ? { nextCursor: { retentionAt: last[1], chatId: last[2] } } : {}),
    ...(deferredKey ? { earliestDeferredAt: deferredKey[1] } : {}),
    done,
  }
}

async function readChatIdPage(
  db: ChatStorageTableSource,
  indexName: '[archivedKey+id]',
  input: { readonly afterChatId?: ChatId; readonly limit: number },
  limitError: string,
): Promise<ChatIdPage> {
  if (!Number.isSafeInteger(input.limit) || input.limit <= 0) throw new Error(limitError)
  const index = db.table<ChatStorageRow, ChatId>('chats').where(indexName)
  const keys = await (input.afterChatId === undefined
    ? index.between(...exactCompoundPrefixBetween([1]))
    : index.between([1, input.afterChatId], [1, []], false, false)
  )
    .limit(input.limit + 1)
    .primaryKeys()
  const chatIds = keys.slice(0, input.limit)
  if (keys.length > input.limit && chatIds.length > 0) {
    return {
      chatIds,
      nextAfterChatId: chatIds[chatIds.length - 1] as ChatId,
      done: false,
    }
  }
  return { chatIds, done: true }
}

export function chatStoragePhysicalIndexFields(chat: Chat): ChatStoragePhysicalIndexFields {
  return {
    archivedKey: chat.archived ? 1 : 0,
    temporaryKey:
      chat.temporary === true &&
      chat.lastUpdatedLeafId === null &&
      chat.wordCount === 0 &&
      chat.totalCostUsd === 0 &&
      Object.keys(chat.tokenCalibration ?? {}).length === 0
        ? 1
        : 0,
    temporaryRetentionAt: Math.max(chat.createdAt, chat.updatedAt, chat.lastViewedAt),
  }
}

const CHAT_PHYSICAL_INDEX_FIELDS = ['archivedKey', 'temporaryKey', 'temporaryRetentionAt'] as const

function preservePhysicalIndexFields(value: object): () => void {
  const record = value as Partial<ChatStorageRow>
  const previous = CHAT_PHYSICAL_INDEX_FIELDS.map((key) => ({
    key,
    present: Object.hasOwn(record, key),
    value: record[key],
  }))
  return () => {
    for (const field of previous) {
      if (field.present) {
        Object.assign(record, { [field.key]: field.value })
      } else {
        delete record[field.key]
      }
    }
  }
}

function stripPhysicalIndexFields(value: object): void {
  const record = value as Partial<ChatStorageRow>
  for (const key of CHAT_PHYSICAL_INDEX_FIELDS) delete record[key]
}

function publicChat(stored: ChatStorageRow | undefined): Chat | undefined {
  if (stored === undefined) return undefined
  const {
    archivedKey: _archivedKey,
    temporaryKey: _temporaryKey,
    temporaryRetentionAt: _temporaryRetentionAt,
    ...chat
  } = stored
  return chat
}

function transactionIdentity(tx: Transaction): object {
  const identity: unknown = tx.idbtrans
  if (!identity || (typeof identity !== 'object' && typeof identity !== 'function')) {
    throw new Error('ChatRowTransactionIdentityMissing')
  }
  return identity
}

function markCurrentChatRows(tx: Transaction, rows: readonly Chat[]): TransactionCurrentChat[]
function markCurrentChatRows(
  tx: Transaction,
  rows: readonly (Chat | undefined)[],
): Array<TransactionCurrentChat | undefined>
function markCurrentChatRows(
  tx: Transaction,
  rows: readonly (Chat | undefined)[],
): Array<TransactionCurrentChat | undefined> {
  const identity = transactionIdentity(tx)
  return rows.map((row) => {
    if (!row) return undefined
    markCurrentChatRow(row, identity)
    return row as TransactionCurrentChat
  })
}

function markCurrentChatRow(row: Chat, identity: object): void {
  Object.defineProperty(row, transactionCurrentChatRuntimeBrand, {
    configurable: true,
    enumerable: false,
    value: identity,
  })
}

function transactionCurrentChatIdentity(row: Chat): object | undefined {
  return (row as Chat & { readonly [transactionCurrentChatRuntimeBrand]?: object })[
    transactionCurrentChatRuntimeBrand
  ]
}
