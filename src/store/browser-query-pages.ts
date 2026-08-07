import Dexie, { type Table } from 'dexie'
import { treeParentKey } from '../core/message-tree-index'
import type { ChatId, MessageId } from '../core/types'
import { bindReadonlyTransactionAbort } from './browser-indexeddb-reads'
import type { NatterDb } from './db'
import { exactCompoundPrefixBetween } from './indexeddb-key-ranges'
import type { MessageBodyRow, MessageHeaderRow } from './message-storage'
import {
  type CanonicalStreamJournalFrameRow,
  isStreamLeaseRow,
  type StreamJournalFramePage,
  type StreamLeaseRow,
} from './repository'
import { estimateStreamJournalFrameStorageBytes } from './storage-size-estimate'
import {
  requireCanonicalStreamJournalFrame,
  STREAM_JOURNAL_READ_MAX_BYTES,
  STREAM_JOURNAL_READ_MAX_ROWS,
} from './stream-journal-codec'

export const HEADER_READ_PAGE_SIZE = 256
export const BODY_READ_PAGE_SIZE = 16
const CATALOG_READ_PAGE_SIZE = 256
const STREAM_READ_PAGE_SIZE = 128

interface BrowserPageReadOptions {
  readonly signal?: AbortSignal
  readonly onPageRead?: (rowCount: number) => void
  readonly maxRows?: number
}

export async function readChatMessageHeaderPages(
  db: NatterDb,
  chatId: ChatId,
  options: BrowserPageReadOptions = {},
): Promise<MessageHeaderRow[]> {
  const rows: MessageHeaderRow[] = []
  const prefixRange = exactCompoundPrefixBetween([chatId])
  let after: readonly [number, MessageId] | undefined
  for (;;) {
    throwIfPageReadAborted(options.signal)
    const page = await db.messages
      .where('[chatId+createdAt+id]')
      .between(
        after ? [chatId, after[0], after[1]] : prefixRange[0],
        prefixRange[1],
        after === undefined,
        false,
      )
      .limit(HEADER_READ_PAGE_SIZE)
      .toArray()
    throwIfPageReadAborted(options.signal)
    if (page.length === 0) return rows
    rows.push(...page)
    const last = page.at(-1) as MessageHeaderRow
    after = [last.createdAt, last.id]
    if (page.length < HEADER_READ_PAGE_SIZE) return rows
  }
}

export interface ExactMessageRow {
  readonly header: MessageHeaderRow
  readonly body: MessageBodyRow
}

export async function readExactMessageRowsByIdPages(
  db: NatterDb,
  messageIds: readonly MessageId[],
  options: BrowserPageReadOptions = {},
): Promise<Array<ExactMessageRow | undefined>> {
  const rows: Array<ExactMessageRow | undefined> = []
  for (let offset = 0; offset < messageIds.length; offset += BODY_READ_PAGE_SIZE) {
    throwIfPageReadAborted(options.signal)
    const pageIds = messageIds.slice(offset, offset + BODY_READ_PAGE_SIZE)
    const page = await db.transaction('r', db.messages, db.messageBodies, async (tx) => {
      const unbind = bindReadonlyTransactionAbort(tx, options.signal, 'Workspace query aborted')
      try {
        const [headers, bodies] = await Dexie.Promise.all([
          db.messages.bulkGet(pageIds),
          db.messageBodies.bulkGet(pageIds),
        ])
        return pageIds.map((messageId, index) => {
          const header = headers[index]
          const body = bodies[index]
          return header &&
            body &&
            header.id === messageId &&
            body.id === messageId &&
            header.chatId === body.chatId &&
            header.bodyVersion === body.bodyVersion
            ? { header, body }
            : undefined
        })
      } finally {
        unbind()
      }
    })
    throwIfPageReadAborted(options.signal)
    rows.push(...page)
  }
  return rows
}

export async function readChildHeaderPages(
  db: NatterDb,
  chatId: ChatId,
  parentId: MessageId | null,
  options: BrowserPageReadOptions = {},
): Promise<MessageHeaderRow[]> {
  const rows: MessageHeaderRow[] = []
  const prefixRange = exactCompoundPrefixBetween([chatId, treeParentKey(parentId)])
  let after: readonly [number, MessageId] | undefined
  for (;;) {
    throwIfPageReadAborted(options.signal)
    const page = await db.messages
      .where('[chatId+treeParentKey+siblingIndex+id]')
      .between(
        after ? [chatId, treeParentKey(parentId), after[0], after[1]] : prefixRange[0],
        prefixRange[1],
        after === undefined,
        false,
      )
      .limit(HEADER_READ_PAGE_SIZE)
      .toArray()
    throwIfPageReadAborted(options.signal)
    if (page.length === 0) return rows
    rows.push(...page)
    const last = page.at(-1) as MessageHeaderRow
    after = [last.siblingIndex, last.id]
    if (page.length < HEADER_READ_PAGE_SIZE) return rows
  }
}

export async function readStringPrimaryKeyPages<Row>(
  table: Table<Row, string>,
  primaryKeyOf: (row: Row) => string,
  options: BrowserPageReadOptions = {},
): Promise<Row[]> {
  const rows: Row[] = []
  let after: string | undefined
  for (;;) {
    throwIfPageReadAborted(options.signal)
    const page = await table
      .where(':id')
      .above(after ?? Dexie.minKey)
      .limit(CATALOG_READ_PAGE_SIZE)
      .toArray()
    throwIfPageReadAborted(options.signal)
    if (page.length === 0) return rows
    rows.push(...page)
    after = primaryKeyOf(page.at(-1) as Row)
    if (page.length < CATALOG_READ_PAGE_SIZE) return rows
  }
}

export async function readStreamLeasePages(
  db: NatterDb,
  chatId?: ChatId,
  options: BrowserPageReadOptions = {},
): Promise<StreamLeaseRow[]> {
  if (chatId === undefined) {
    const rows = await readStringPrimaryKeyPages(db.streamLeases, (row) => row.streamId, options)
    return rows.filter(isStreamLeaseRow).map((row) => ({ ...row }))
  }

  const rows: StreamLeaseRow[] = []
  const prefixRange = exactCompoundPrefixBetween([chatId])
  let after: string | undefined
  for (;;) {
    throwIfPageReadAborted(options.signal)
    const page = await db.streamLeases
      .where('[chatId+streamId]')
      .between(
        after === undefined ? prefixRange[0] : [chatId, after],
        prefixRange[1],
        after === undefined,
        false,
      )
      .limit(STREAM_READ_PAGE_SIZE)
      .toArray()
    throwIfPageReadAborted(options.signal)
    if (page.length === 0) return rows
    for (const row of page) {
      if (isStreamLeaseRow(row)) rows.push({ ...row })
    }
    after = (page.at(-1) as StreamLeaseRow).streamId
    if (page.length < STREAM_READ_PAGE_SIZE) return rows
  }
}

export async function readStreamJournalFramePage(
  db: NatterDb,
  input: {
    readonly streamId: string
    readonly afterSeq: number
    readonly throughSeq: number
  },
  options: BrowserPageReadOptions = {},
): Promise<StreamJournalFramePage> {
  throwIfPageReadAborted(options.signal)
  if (input.throughSeq < 0 || input.afterSeq >= input.throughSeq) {
    return { frames: [], nextAfterSeq: input.afterSeq, done: true }
  }
  const rows = await db.streamChunks
    .where('[streamId+seq]')
    .between([input.streamId, input.afterSeq], [input.streamId, input.throughSeq], false, true)
    .limit(STREAM_JOURNAL_READ_MAX_ROWS)
    .toArray()
  throwIfPageReadAborted(options.signal)
  const frames: CanonicalStreamJournalFrameRow[] = []
  let bytes = 0
  for (const row of rows) {
    const frame = requireCanonicalStreamJournalFrame(row)
    const rowBytes = estimateStreamJournalFrameStorageBytes(frame)
    if (frames.length > 0 && bytes + rowBytes > STREAM_JOURNAL_READ_MAX_BYTES) break
    frames.push(frame)
    bytes += rowBytes
  }
  options.onPageRead?.(frames.length)
  const nextAfterSeq = frames.at(-1)?.seq ?? input.afterSeq
  return {
    frames,
    nextAfterSeq,
    done:
      nextAfterSeq >= input.throughSeq ||
      (frames.length === rows.length && rows.length < STREAM_JOURNAL_READ_MAX_ROWS),
  }
}

function throwIfPageReadAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException('Workspace query aborted', 'AbortError')
}
