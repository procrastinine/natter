import Dexie, { type Transaction } from 'dexie'
import type { Chat, ChatId, MessageId } from '../core/types'
import { exactCompoundPrefixBetween } from './indexeddb-key-ranges'
import type { MessageHeaderRow } from './message-storage'

function nextSafeTimestamp(
  current: number | undefined,
  proposed: number,
  exhausted: string,
): number {
  const floor = current ?? -1
  if (!Number.isSafeInteger(floor) || !Number.isSafeInteger(proposed) || proposed < 0) {
    throw new Error(`${exhausted}Invalid`)
  }
  if (floor >= Number.MAX_SAFE_INTEGER) throw new Error(exhausted)
  return Math.max(proposed, floor + 1)
}

export async function nextChatUpdatedAtInTransaction(
  tx: Transaction,
  proposed: number,
): Promise<number> {
  return new TransactionChatUpdateClock().next(tx, proposed)
}

export class TransactionChatUpdateClock {
  private readonly allocator = new TransactionMonotonicAllocator<'workspace'>(
    'TransactionChatUpdateClockTransactionMismatch',
  )

  next(tx: Transaction, proposed: number): Promise<number> {
    return this.allocator.next(
      tx,
      'workspace',
      proposed,
      async () => (await tx.table<Chat, ChatId>('chats').orderBy('updatedAt').last())?.updatedAt,
      'ChatUpdatedAtClockExhausted',
    )
  }
}

export class TransactionMessageCreationClock {
  private readonly allocator = new TransactionMonotonicAllocator<ChatId>(
    'TransactionMessageCreationClockTransactionMismatch',
  )

  next(tx: Transaction, chatId: ChatId, proposed: number): Promise<number> {
    const range = exactCompoundPrefixBetween([chatId])
    return this.allocator.next(
      tx,
      chatId,
      proposed,
      async () =>
        (
          await tx
            .table<MessageHeaderRow, MessageId>('messages')
            .where('[chatId+createdAt+id]')
            .between(...range)
            .last()
        )?.createdAt,
      `MessageCreatedAtClockExhausted:${chatId}`,
    )
  }
}

interface TransactionMonotonicLane {
  highWatermark: number | undefined
  initialized: boolean
  tail: Promise<void>
}

class TransactionMonotonicAllocator<Key> {
  private readonly lanes = new Map<Key, TransactionMonotonicLane>()
  private readonly transactionMismatch: string
  private transactionIdentity: object | undefined

  constructor(transactionMismatch: string) {
    this.transactionMismatch = transactionMismatch
  }

  next(
    tx: Transaction,
    key: Key,
    proposed: number,
    readCurrent: () => Promise<number | undefined>,
    exhausted: string,
  ): Promise<number> {
    const transactionIdentity = tx.idbtrans as unknown as object
    if (this.transactionIdentity && this.transactionIdentity !== transactionIdentity) {
      return Dexie.Promise.reject(new Error(this.transactionMismatch))
    }
    this.transactionIdentity = transactionIdentity
    const lane = this.lanes.get(key) ?? {
      highWatermark: undefined,
      initialized: false,
      tail: Dexie.Promise.resolve(),
    }
    this.lanes.set(key, lane)
    const allocation = lane.tail.then(async () => {
      if (!lane.initialized) {
        lane.highWatermark = await readCurrent()
        lane.initialized = true
      }
      const next = nextSafeTimestamp(lane.highWatermark, proposed, exhausted)
      lane.highWatermark = next
      return next
    })
    lane.tail = allocation.then(
      () => undefined,
      () => undefined,
    )
    return allocation
  }
}
