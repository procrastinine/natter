import Dexie, { type Table } from 'dexie'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '../../src/core/types'
import { buildChat } from '../../src/store/chats'
import { createDbForTests, type NatterDb } from '../../src/store/db'
import { splitMessageForStorage } from '../../src/store/message-storage'
import {
  TransactionChatUpdateClock,
  TransactionMessageCreationClock,
} from '../../src/store/transaction-order'

let db: NatterDb | null = null

afterEach(async () => {
  vi.restoreAllMocks()
  const current = db
  db = null
  if (!current) return
  const name = current.name
  current.close()
  await Dexie.delete(name)
})

describe('transaction monotonic clocks', () => {
  it('serializes concurrent workspace allocations with one initialization read', async () => {
    db = createDbForTests(`transaction-chat-clock-${crypto.randomUUID()}`)
    await db.open()
    await db.chats.add(buildChat({ id: 'newest-chat', now: 50 }))
    const tablePrototype = Object.getPrototypeOf(db.chats) as typeof db.chats
    const orderBy = vi.spyOn(tablePrototype, 'orderBy')
    const clock = new TransactionChatUpdateClock()

    const values = await db.transaction('r', db.chats, (tx) =>
      Promise.all([
        clock.next(tx, 1),
        clock.next(tx, 100),
        clock.next(tx, 2),
        ...Array.from({ length: 61 }, () => clock.next(tx, 0)),
      ]),
    )

    expect(values.slice(0, 3)).toEqual([51, 100, 101])
    expect(new Set(values).size).toBe(64)
    expect(values).toEqual([...values].sort((left, right) => left - right))
    expect(tableCallCount(orderBy, 'chats')).toBe(1)
    await expect(db.transaction('r', db.chats, (tx) => clock.next(tx, 200))).rejects.toThrow(
      'TransactionChatUpdateClockTransactionMismatch',
    )
    expect(tableCallCount(orderBy, 'chats')).toBe(1)
  })

  it('serializes each message-chat lane independently and binds every lane to one transaction', async () => {
    db = createDbForTests(`transaction-message-clock-${crypto.randomUUID()}`)
    await db.open()
    const headers = [message('message-a', 'chat-a', 20), message('message-b', 'chat-b', 100)].map(
      (row) => splitMessageForStorage(row).header,
    )
    await db.messages.bulkAdd(headers)
    const tablePrototype = Object.getPrototypeOf(db.messages) as typeof db.messages
    const where = vi.spyOn(tablePrototype, 'where')
    const clock = new TransactionMessageCreationClock()

    const values = await db.transaction('r', db.messages, (tx) =>
      Promise.all([
        clock.next(tx, 'chat-a', 1),
        clock.next(tx, 'chat-a', 50),
        clock.next(tx, 'chat-b', 1),
        clock.next(tx, 'chat-a', 2),
        clock.next(tx, 'chat-b', 200),
      ]),
    )

    expect(values).toEqual([21, 50, 101, 51, 200])
    expect(tableCallCount(where, 'messages')).toBe(2)
    await expect(
      db.transaction('r', db.messages, (tx) => clock.next(tx, 'chat-c', 1)),
    ).rejects.toThrow('TransactionMessageCreationClockTransactionMismatch')
    expect(tableCallCount(where, 'messages')).toBe(2)
  })
})

function message(id: string, chatId: string, createdAt: number): Message {
  return {
    id,
    chatId,
    parentId: null,
    siblingIndex: 0,
    turnId: `turn-${id}`,
    turnIndex: 0,
    createdAt,
    role: 'user',
    origin: 'user',
    content: [{ type: 'text', text: id }],
    nodeVersion: 0,
    deleted: false,
  }
}

type TableMethodSpy = {
  readonly mock: { readonly contexts: readonly unknown[] }
}

function tableCallCount(spy: TableMethodSpy, tableName: string): number {
  return spy.mock.contexts.filter((context) => (context as Table).name === tableName).length
}
