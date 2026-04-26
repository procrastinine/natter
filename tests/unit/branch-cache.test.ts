import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type { Chat, Message } from '../../src/core/types'
import {
  __resetBranchCacheStoreForTests,
  readFreshChatBranchCache,
  refreshChatBranchCache,
} from '../../src/store/branch-cache'
import { __resetBroadcastForTests, type BroadcastEvent, onEvent } from '../../src/store/broadcast'
import {
  __resetBrowserRepositoryForTests,
  getBrowserRepository,
} from '../../src/store/browser-repo'
import { __resetDbForTests, getDb, openDb } from '../../src/store/db'

const DB_NAME = 'natter'

async function resetAll() {
  __resetBrowserRepositoryForTests()
  __resetDbForTests()
  __resetBroadcastForTests()
  __resetBranchCacheStoreForTests()
  await Dexie.delete(DB_NAME)
}

beforeEach(async () => {
  await resetAll()
  await openDb()
})

afterEach(async () => {
  await resetAll()
})

async function seedChat(overrides: Partial<Chat> = {}): Promise<Chat> {
  const chat: Chat = {
    id: 'chat-cache',
    title: 'Cache chat',
    titleStatus: 'manual',
    createdAt: 1,
    updatedAt: 1,
    lastViewedAt: 1,
    wordCount: 0,
    totalCostUsd: 0,
    metaVersion: 0,
    summaryVersion: 0,
    settings: cloneDefaultChatSettings(),
    lastUpdatedLeafId: null,
    lastBranchUpdatedAt: 1,
    archived: false,
    pinned: false,
    folderId: null,
    tags: [],
    ...overrides,
  }
  await getDb().chats.put(chat)
  return chat
}

function message(overrides: Partial<Message>): Message {
  return {
    id: 'm',
    chatId: 'chat-cache',
    parentId: null,
    siblingIndex: 0,
    turnId: 't',
    turnIndex: 0,
    createdAt: 1,
    role: 'user',
    origin: 'user',
    content: [{ type: 'text', text: 'hello' }],
    nodeVersion: 0,
    deleted: false,
    ...overrides,
  }
}

describe('branch-cache store', () => {
  it('refreshes stale branch cache through the workspace repository', async () => {
    await seedChat({ lastUpdatedLeafId: 'a', lastBranchUpdatedAt: 5 })
    const user = message({ id: 'u', content: [{ type: 'text', text: 'hello user' }] })
    const assistant = message({
      id: 'a',
      role: 'assistant',
      parentId: user.id,
      createdAt: 2,
      content: [{ type: 'output_text', text: 'hello assistant' }],
    })
    await getDb().messages.bulkPut([user, assistant])
    const events: BroadcastEvent[] = []
    const unsub = onEvent((event) => events.push(event))

    const row = await readFreshChatBranchCache('chat-cache')
    unsub()

    expect(row).toMatchObject({
      chatId: 'chat-cache',
      branchLeafId: 'a',
      previewText: 'hello assistant',
      messageCount: 2,
      wordCount: 4,
    })
    expect((await getDb().chatBranchCache.get('chat-cache'))?.textContent).toContain(
      'ASSISTANT:\nhello assistant',
    )
    expect(events).toContainEqual({ kind: 'branch-cache-refreshed', chatId: 'chat-cache' })
  })

  it('deletes existing cache rows for empty chats', async () => {
    await seedChat({ lastUpdatedLeafId: null })
    await getDb().chatBranchCache.put({
      chatId: 'chat-cache',
      branchLeafId: 'old-leaf',
      generatedAt: 1,
      textContent: 'old',
      previewText: 'old',
      messageCount: 1,
      wordCount: 1,
      messageTimestamps: [],
    })

    expect(await refreshChatBranchCache('chat-cache')).toBeUndefined()
    expect(await getDb().chatBranchCache.get('chat-cache')).toBeUndefined()
  })

  it('writes branch cache atomically when a mutation advances the last-updated leaf', async () => {
    await seedChat({ lastUpdatedLeafId: null, lastBranchUpdatedAt: 1 })
    const repo = getBrowserRepository()
    const user = message({
      id: 'u',
      content: [{ type: 'text', text: 'hello user' }],
      createdAt: 2,
    })
    const events: BroadcastEvent[] = []
    const unsub = onEvent((event) => events.push(event))

    await repo.runMutation(
      [
        { kind: 'message', messageId: user.id },
        { kind: 'children', chatId: user.chatId, parentId: null },
      ],
      async (ctx) => {
        await ctx.putMessage(user)
      },
    )
    unsub()

    const chat = await getDb().chats.get('chat-cache')
    const cache = await getDb().chatBranchCache.get('chat-cache')
    expect(chat?.lastUpdatedLeafId).toBe('u')
    expect(cache).toMatchObject({
      chatId: 'chat-cache',
      branchLeafId: 'u',
      textContent: 'USER:\nhello user\n',
      previewText: 'hello user',
      wordCount: chat?.wordCount,
    })
    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'chat-mutated', chatId: 'chat-cache' }),
    )
    expect(events).toContainEqual({ kind: 'branch-cache-refreshed', chatId: 'chat-cache' })
  })

  it('refreshes branch cache atomically for on-path edits', async () => {
    await seedChat({ lastUpdatedLeafId: 'a', lastBranchUpdatedAt: 1 })
    const user = message({ id: 'u', content: [{ type: 'text', text: 'hello user' }] })
    const assistant = message({
      id: 'a',
      role: 'assistant',
      parentId: user.id,
      createdAt: 2,
      content: [{ type: 'output_text', text: 'old answer' }],
    })
    await getDb().messages.bulkPut([user, assistant])
    await getDb().chatBranchCache.put({
      chatId: 'chat-cache',
      branchLeafId: 'a',
      generatedAt: 1,
      textContent: 'old',
      previewText: 'old',
      messageCount: 2,
      wordCount: 2,
      messageTimestamps: [],
    })
    const events: BroadcastEvent[] = []
    const unsub = onEvent((event) => events.push(event))

    await getBrowserRepository().runMutation(
      [{ kind: 'message', messageId: assistant.id }],
      async (ctx) => {
        await ctx.putMessage({
          ...assistant,
          content: [{ type: 'output_text', text: 'new answer with more words' }],
        })
      },
    )
    unsub()

    const chat = await getDb().chats.get('chat-cache')
    const cache = await getDb().chatBranchCache.get('chat-cache')
    expect(chat?.lastUpdatedLeafId).toBe('a')
    expect(chat?.lastBranchUpdatedAt).toBeGreaterThan(1)
    expect(cache?.textContent).toContain('new answer with more words')
    expect(cache?.wordCount).toBe(chat?.wordCount)
    expect(events).toContainEqual({ kind: 'branch-cache-refreshed', chatId: 'chat-cache' })
  })

  it('skips branch-cache writes for off-path edits', async () => {
    await seedChat({ lastUpdatedLeafId: 'latest', lastBranchUpdatedAt: 10 })
    const root = message({ id: 'root', content: [{ type: 'text', text: 'root' }], createdAt: 1 })
    const latest = message({
      id: 'latest',
      role: 'assistant',
      parentId: root.id,
      siblingIndex: 1,
      createdAt: 3,
      content: [{ type: 'output_text', text: 'latest branch' }],
    })
    const offPath = message({
      id: 'old',
      role: 'assistant',
      parentId: root.id,
      siblingIndex: 0,
      createdAt: 2,
      content: [{ type: 'output_text', text: 'old branch' }],
    })
    await getDb().messages.bulkPut([root, latest, offPath])
    await getDb().chatBranchCache.put({
      chatId: 'chat-cache',
      branchLeafId: 'latest',
      generatedAt: 20,
      textContent: 'stable-cache',
      previewText: 'stable-cache',
      messageCount: 2,
      wordCount: 2,
      messageTimestamps: [],
    })
    const events: BroadcastEvent[] = []
    const unsub = onEvent((event) => events.push(event))

    await getBrowserRepository().runMutation(
      [{ kind: 'message', messageId: offPath.id }],
      async (ctx) => {
        await ctx.putMessage({
          ...offPath,
          content: [{ type: 'output_text', text: 'edited old branch' }],
        })
      },
    )
    unsub()

    expect((await getDb().chatBranchCache.get('chat-cache'))?.textContent).toBe('stable-cache')
    expect(events).not.toContainEqual({ kind: 'branch-cache-refreshed', chatId: 'chat-cache' })
  })

  it('deletes the branch cache atomically when the final live leaf is tombstoned', async () => {
    await seedChat({ lastUpdatedLeafId: 'u', lastBranchUpdatedAt: 1 })
    const user = message({ id: 'u', content: [{ type: 'text', text: 'hello user' }] })
    await getDb().messages.put(user)
    await getDb().chatBranchCache.put({
      chatId: 'chat-cache',
      branchLeafId: 'u',
      generatedAt: 1,
      textContent: 'USER:\nhello user\n',
      previewText: 'hello user',
      messageCount: 1,
      wordCount: 2,
      messageTimestamps: [],
    })
    const events: BroadcastEvent[] = []
    const unsub = onEvent((event) => events.push(event))

    await getBrowserRepository().runMutation(
      [
        { kind: 'message', messageId: user.id },
        { kind: 'children', chatId: user.chatId, parentId: null },
      ],
      async (ctx) => {
        await ctx.putMessage({ ...user, deleted: true })
      },
    )
    unsub()

    expect((await getDb().chats.get('chat-cache'))?.lastUpdatedLeafId).toBeNull()
    expect(await getDb().chatBranchCache.get('chat-cache')).toBeUndefined()
    expect(events).toContainEqual({ kind: 'branch-cache-refreshed', chatId: 'chat-cache' })
  })
})
