import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import { newId } from '../../src/lib/ulid'
import { __resetBroadcastForTests, type BroadcastEvent, onEvent } from '../../src/store/broadcast'
import { __resetDbForTests, getDb, openDb } from '../../src/store/db'
import { ChatMissingError, withChatLock } from '../../src/store/locks'
import type { Chat, Message } from '../../src/core/types'

const DB_NAME = 'natter'

async function resetAll() {
  __resetDbForTests()
  __resetBroadcastForTests()
  await Dexie.delete(DB_NAME)
}

beforeEach(async () => {
  await resetAll()
})

afterEach(async () => {
  await resetAll()
})

async function seedChat(overrides: Partial<Chat> = {}): Promise<Chat> {
  const db = await openDb()
  const chat: Chat = {
    id: newId(),
    title: 'Test',
    titleStatus: 'untitled',
    createdAt: 100,
    updatedAt: 100,
    lastViewedAt: 100,
    wordCount: 0,
    totalCostUsd: 0,
    version: 0,
    settings: cloneDefaultChatSettings(),
    lastUpdatedLeafId: null,
    lastBranchUpdatedAt: 100,
    archived: false,
    pinned: false,
    folderId: null,
    tags: [],
    ...overrides,
  }
  await db.chats.put(chat)
  return chat
}

function makeMessage(chatId: string, overrides: Partial<Message> = {}): Message {
  return {
    id: newId(),
    chatId,
    parentId: null,
    siblingIndex: 0,
    turnId: newId(),
    turnIndex: 0,
    createdAt: Date.now(),
    role: 'user',
    origin: 'user',
    content: [{ type: 'text', text: 'hi' }],
    deleted: false,
    ...overrides,
  }
}

describe('withChatLock', () => {
  it('bumps chat.version exactly once per call and returns both the value and the new version', async () => {
    const chat = await seedChat()
    const result = await withChatLock(chat.id, async ({ chat: snapshot }) => {
      expect(snapshot.version).toBe(0)
      return 'done'
    })
    expect(result).toEqual({ value: 'done', version: 1 })
    const stored = await getDb().chats.get(chat.id)
    expect(stored?.version).toBe(1)
  })

  it('applies chat patches staged via patchChat on commit', async () => {
    const chat = await seedChat()
    await withChatLock(chat.id, async ({ patchChat }) => {
      patchChat({ title: 'Renamed' })
      patchChat({ wordCount: 42 })
    })
    const stored = await getDb().chats.get(chat.id)
    expect(stored?.title).toBe('Renamed')
    expect(stored?.wordCount).toBe(42)
    expect(stored?.version).toBe(1)
  })

  it('bumps updatedAt to a fresh wall-clock timestamp', async () => {
    const chat = await seedChat({ updatedAt: 100 })
    const before = Date.now()
    await withChatLock(chat.id, async () => undefined)
    const stored = await getDb().chats.get(chat.id)
    expect(stored?.updatedAt).toBeGreaterThanOrEqual(before)
  })

  it('persists writes made to other tables inside the callback', async () => {
    const chat = await seedChat()
    const messageId = newId()
    await withChatLock(chat.id, async () => {
      await getDb().messages.put(makeMessage(chat.id, { id: messageId }))
    })
    const row = await getDb().messages.get(messageId)
    expect(row?.id).toBe(messageId)
  })

  it('rolls back all writes if the callback throws', async () => {
    const chat = await seedChat()
    await expect(
      withChatLock(chat.id, async () => {
        await getDb().messages.put(makeMessage(chat.id, { id: 'will-not-persist' }))
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    const messageMiss = await getDb().messages.get('will-not-persist')
    expect(messageMiss).toBeUndefined()
    const chatStill = await getDb().chats.get(chat.id)
    expect(chatStill?.version).toBe(0)
  })

  it('throws ChatMissingError when the chat does not exist', async () => {
    await openDb()
    await expect(
      withChatLock('ghost', async () => undefined),
    ).rejects.toBeInstanceOf(ChatMissingError)
  })

  it('serializes concurrent callers and loses no writes', async () => {
    const chat = await seedChat()
    const db = getDb()
    const ids = Array.from({ length: 8 }, () => newId())
    await Promise.all(
      ids.map((id) =>
        withChatLock(chat.id, async () => {
          const current = await db.chats.get(chat.id)
          // If the lock weren't exclusive, two writers would see the same
          // version here and clobber each other's message write on commit.
          const stamped = makeMessage(chat.id, {
            id,
            content: [{ type: 'text', text: `v${current?.version ?? '??'}` }],
          })
          await db.messages.put(stamped)
        }),
      ),
    )
    const finalChat = await db.chats.get(chat.id)
    expect(finalChat?.version).toBe(ids.length)
    const stored = await db.messages.where('chatId').equals(chat.id).toArray()
    expect(stored.map((m) => m.id).sort()).toEqual(ids.sort())
    // Each callback saw the previous version; the distinct set should be 0..7.
    const seenVersions = new Set(
      stored.map((m) => (m.content[0] as { type: 'text'; text: string }).text),
    )
    expect(seenVersions).toEqual(new Set(['v0', 'v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7']))
  })

  it('broadcasts chat-mutated exactly once after commit, with the new version', async () => {
    const chat = await seedChat()
    const received: BroadcastEvent[] = []
    const unsub = onEvent((ev) => {
      if (ev.kind === 'chat-mutated' && ev.chatId === chat.id) received.push(ev)
    })
    await withChatLock(chat.id, async () => undefined)
    unsub()
    expect(received).toEqual([{ kind: 'chat-mutated', chatId: chat.id, version: 1 }])
  })

  it('does not broadcast when the callback throws', async () => {
    const chat = await seedChat()
    const received: BroadcastEvent[] = []
    const unsub = onEvent((ev) => {
      if (ev.kind === 'chat-mutated') received.push(ev)
    })
    await expect(
      withChatLock(chat.id, async () => {
        throw new Error('abort')
      }),
    ).rejects.toThrow('abort')
    unsub()
    expect(received).toEqual([])
  })

  it('structured-clones the chat snapshot so callback mutations do not leak into the committed row', async () => {
    const chat = await seedChat({ title: 'Original' })
    await withChatLock(chat.id, async ({ chat: snapshot }) => {
      snapshot.title = 'MutatedInPlace'
    })
    const stored = await getDb().chats.get(chat.id)
    expect(stored?.title).toBe('Original')
  })
})
