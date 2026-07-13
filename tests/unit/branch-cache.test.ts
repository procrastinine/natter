import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildBranchCacheRow,
  exportLastUpdatedBranchAsTxt,
  flattenBranchMessages,
} from '../../src/core/branch-flatten'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type { Chat, ChatBranchCache, Message } from '../../src/core/types'
import {
  __resetBranchCacheStoreForTests,
  readFreshChatBranchCache,
  refreshChatBranchCache,
} from '../../src/store/branch-cache'
import {
  __resetBroadcastForTests,
  type BroadcastEvent,
  onEvent,
  postEvent,
} from '../../src/store/broadcast'
import {
  __resetBrowserRepositoryForTests,
  getBrowserRepository,
} from '../../src/store/browser-repo'
import { searchChats } from '../../src/store/chat-search'
import { __resetDbForTests, childListKey, getDb, openDb } from '../../src/store/db'
import {
  chatBranchCacheWriteGuard,
  missingChatBranchCacheWriteGuard,
  type WorkspaceRepository,
} from '../../src/store/repository'
import {
  __resetWorkspaceRepositoryForTests,
  __setWorkspaceRepositoryForTests,
} from '../../src/store/workspace-repository'
import { putTestMessage, putTestMessages } from '../helpers/message-storage'

const DB_NAME = 'natter'

async function resetAll() {
  __resetBrowserRepositoryForTests()
  __resetDbForTests()
  __resetBroadcastForTests()
  __resetBranchCacheStoreForTests()
  __resetWorkspaceRepositoryForTests()
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
  it.each([
    { kind: 'workspace-replaced' as const },
    { kind: 'workspace-invalidated' as const, mutationCounter: 7 },
  ])('clears the in-memory branch cache on $kind', async (event) => {
    await seedChat({ lastUpdatedLeafId: 'a', lastBranchUpdatedAt: 1 })
    await getDb().chatBranchCache.put({
      chatId: 'chat-cache',
      branchLeafId: 'a',
      generatedAt: 10,
      textContent: 'first',
      previewText: 'first',
      messageCount: 1,
      wordCount: 1,
      messageTimestamps: [],
    })
    expect((await readFreshChatBranchCache('chat-cache'))?.textContent).toBe('first')

    await getDb().chatBranchCache.update('chat-cache', {
      generatedAt: 20,
      textContent: 'second',
      previewText: 'second',
    })
    postEvent(event)

    expect((await readFreshChatBranchCache('chat-cache'))?.textContent).toBe('second')
  })

  it('does not repopulate memory from a read that predates invalidation', async () => {
    await seedChat({ lastUpdatedLeafId: 'a', lastBranchUpdatedAt: 1 })
    const stale: ChatBranchCache = {
      chatId: 'chat-cache',
      branchLeafId: 'a',
      generatedAt: 10,
      textContent: 'stale',
      previewText: 'stale',
      messageCount: 1,
      wordCount: 1,
      messageTimestamps: [],
    }
    const fresh: ChatBranchCache = { ...stale, generatedAt: 20, textContent: 'fresh' }
    await getDb().chatBranchCache.put(fresh)
    let resolveStale!: (row: ChatBranchCache) => void
    let firstReadStarted!: () => void
    const started = new Promise<void>((resolve) => {
      firstReadStarted = resolve
    })
    const firstRead = new Promise<ChatBranchCache>((resolve) => {
      resolveStale = resolve
    })
    let reads = 0
    const base = getBrowserRepository()
    __setWorkspaceRepositoryForTests({
      getChat: base.getChat.bind(base),
      getWorkspaceMeta: base.getWorkspaceMeta.bind(base),
      getChatBranchCache: async (chatId) => {
        reads += 1
        if (reads === 1) {
          firstReadStarted()
          return firstRead
        }
        return getDb().chatBranchCache.get(chatId)
      },
    } as WorkspaceRepository)

    const pending = readFreshChatBranchCache('chat-cache')
    await started
    postEvent({ kind: 'workspace-invalidated', mutationCounter: 7 })
    resolveStale(stale)

    await expect(pending).resolves.toMatchObject({ textContent: 'fresh' })
    await expect(readFreshChatBranchCache('chat-cache')).resolves.toMatchObject({
      textContent: 'fresh',
    })
    expect(reads).toBe(2)
  })

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
    await putTestMessages([user, assistant])
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

  it('invalidates branch cache atomically when a mutation advances the last-updated leaf', async () => {
    await seedChat({ lastUpdatedLeafId: null, lastBranchUpdatedAt: 1 })
    await getDb().chatBranchCache.put({
      chatId: 'chat-cache',
      branchLeafId: 'stale-leaf',
      generatedAt: 1,
      textContent: 'stale',
      previewText: 'stale',
      messageCount: 1,
      wordCount: 1,
      messageTimestamps: [],
    })
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
    expect(chat?.wordCount).toBe(2)
    expect(cache).toBeUndefined()
    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'chat-mutated', chatId: 'chat-cache' }),
    )
    expect(events).toContainEqual({ kind: 'branch-cache-refreshed', chatId: 'chat-cache' })
  })

  it('matches the full summary projection and rolls back every row, version, counter, and event', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const root = message({
      id: 'golden-root',
      createdAt: 10,
      content: [{ type: 'text', text: 'golden root words' }],
    })
    const leaf = message({
      id: 'golden-leaf',
      parentId: root.id,
      createdAt: 20,
      role: 'assistant',
      origin: 'generated',
      content: [{ type: 'output_text', text: 'golden first answer' }],
      generation: {
        id: 'generation-before',
        model: 'model-before',
        requestedModel: 'model-before',
        apiUsed: 'chat',
        delivery: 'streaming',
        cost: 0.25,
        costSource: 'stream',
        startedAt: 20,
        finishedAt: 21,
      },
    })
    const initialCache = buildBranchCacheRow({
      chatId: 'chat-cache',
      branchLeafId: leaf.id,
      messages: [root, leaf],
      generatedAt: 50,
    })
    await seedChat({
      updatedAt: 50,
      lastUpdatedLeafId: leaf.id,
      lastBranchUpdatedAt: 50,
      wordCount: initialCache.wordCount,
      totalCostUsd: 0.25,
      summaryVersion: 7,
      previewText: 'golden root words',
    })
    await putTestMessages([root, leaf])
    await getDb().chatBranchCache.put(initialCache)
    const beforeChat = await getDb().chats.get('chat-cache')
    const beforeWorkspace = await getBrowserRepository().getWorkspaceMeta()
    const appended = message({
      id: 'golden-appended',
      parentId: leaf.id,
      createdAt: 30,
      role: 'assistant',
      origin: 'generated',
      content: [{ type: 'output_text', text: 'golden second answer with more words' }],
      generation: {
        id: 'generation-after',
        model: 'model-after',
        requestedModel: 'model-after',
        apiUsed: 'chat',
        delivery: 'streaming',
        cost: 0.5,
        costSource: 'stream',
        startedAt: 30,
        finishedAt: 31,
      },
    })
    const events: BroadcastEvent[] = []
    const unsubscribe = onEvent((event) => events.push(event))
    const result = await getBrowserRepository().runMutation(
      [
        { kind: 'message', messageId: appended.id },
        { kind: 'children', chatId: 'chat-cache', parentId: leaf.id },
      ],
      async (ctx) => ctx.putMessage(appended),
    )
    unsubscribe()

    const expectedCache = buildBranchCacheRow({
      chatId: 'chat-cache',
      branchLeafId: appended.id,
      messages: [root, leaf, appended],
      generatedAt: 1_000,
    })
    const afterChat = await getDb().chats.get('chat-cache')
    expect(afterChat).toEqual({
      ...beforeChat,
      updatedAt: 1_000,
      summaryVersion: 8,
      lastUpdatedLeafId: appended.id,
      lastBranchUpdatedAt: 1_000,
      wordCount: expectedCache.wordCount,
      totalCostUsd: 0.75,
    })
    expect(await getDb().chatBranchCache.get('chat-cache')).toBeUndefined()
    expect(await getDb().messages.get(appended.id)).toMatchObject({
      id: appended.id,
      parentId: leaf.id,
      nodeVersion: 0,
    })
    expect(await getDb().messageBodies.get(appended.id)).toMatchObject({
      id: appended.id,
      content: appended.content,
      nodeVersion: 0,
      updatedAt: 1_000,
    })
    expect(await getDb().childLists.get(childListKey('chat-cache', leaf.id))).toEqual({
      id: childListKey('chat-cache', leaf.id),
      chatId: 'chat-cache',
      parentId: leaf.id,
      version: 1,
      updatedAt: 1_000,
    })
    expect(result.chatVersions['chat-cache']).toEqual({ metaVersion: 0, summaryVersion: 8 })
    expect((await getBrowserRepository().getWorkspaceMeta()).mutationCounter).toBe(
      beforeWorkspace.mutationCounter + 1,
    )
    expect(events).toEqual([
      {
        kind: 'chat-mutated',
        chatId: 'chat-cache',
        metaVersion: 0,
        summaryVersion: 8,
        affected: [
          { kind: 'children', chatId: 'chat-cache', parentId: leaf.id },
          { kind: 'message', chatId: 'chat-cache', messageId: appended.id },
        ],
      },
      { kind: 'branch-cache-refreshed', chatId: 'chat-cache' },
    ])

    const exported = await exportLastUpdatedBranchAsTxt(getBrowserRepository(), 'chat-cache')
    expect(exported.content).toBe(flattenBranchMessages([root, leaf, appended], afterChat))
    expect(await getDb().chatBranchCache.get('chat-cache')).toEqual(expectedCache)

    const stableChat = structuredClone(afterChat)
    const stableCache = await getDb().chatBranchCache.get('chat-cache')
    const stableWorkspace = await getBrowserRepository().getWorkspaceMeta()
    const stableEvents: BroadcastEvent[] = []
    const unsubscribeRollback = onEvent((event) => stableEvents.push(event))
    const rolledBack = message({
      id: 'golden-rolled-back',
      parentId: appended.id,
      createdAt: 40,
      role: 'assistant',
      origin: 'generated',
      content: [{ type: 'output_text', text: 'must not persist' }],
    })
    await expect(
      getBrowserRepository().runMutation(
        [
          { kind: 'message', messageId: rolledBack.id },
          { kind: 'children', chatId: 'chat-cache', parentId: appended.id },
        ],
        async (ctx) => {
          await ctx.putMessage(rolledBack)
          throw new Error('injected rollback')
        },
      ),
    ).rejects.toThrow('injected rollback')
    unsubscribeRollback()

    expect(await getDb().chats.get('chat-cache')).toEqual(stableChat)
    expect(await getDb().chatBranchCache.get('chat-cache')).toEqual(stableCache)
    expect(await getBrowserRepository().getWorkspaceMeta()).toEqual(stableWorkspace)
    expect(await getDb().messages.get(rolledBack.id)).toBeUndefined()
    expect(await getDb().messageBodies.get(rolledBack.id)).toBeUndefined()
    expect(await getDb().childLists.get(childListKey('chat-cache', appended.id))).toBeUndefined()
    expect(stableEvents).toEqual([])
  })

  it('invalidates on-path edits and rebuilds the cache lazily through search', async () => {
    await seedChat({ lastUpdatedLeafId: 'a', lastBranchUpdatedAt: 1, wordCount: 4 })
    const user = message({ id: 'u', content: [{ type: 'text', text: 'hello user' }] })
    const assistant = message({
      id: 'a',
      role: 'assistant',
      parentId: user.id,
      createdAt: 2,
      content: [{ type: 'output_text', text: 'old answer' }],
    })
    await putTestMessages([user, assistant])
    await getDb().chatBranchCache.put({
      chatId: 'chat-cache',
      branchLeafId: 'a',
      generatedAt: 1,
      textContent: 'old',
      previewText: 'old',
      messageCount: 2,
      wordCount: 4,
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
    expect(chat?.wordCount).toBe(7)
    expect(cache).toBeUndefined()
    expect(events).toContainEqual({ kind: 'branch-cache-refreshed', chatId: 'chat-cache' })

    const search = await searchChats({
      queryId: 'lazy-cache-rebuild',
      query: 'new answer with more words',
      repo: getBrowserRepository(),
      concurrency: 1,
    })
    expect(search.results).toMatchObject([
      { chatId: 'chat-cache', source: 'branch-cache', branchLeafId: 'a' },
    ])
    expect((await getDb().chatBranchCache.get('chat-cache'))?.textContent).toContain(
      'new answer with more words',
    )
  })

  it('rejects a stale lazy cache write after a same-leaf edit', async () => {
    const user = message({ id: 'cas-user', content: [{ type: 'text', text: 'user words' }] })
    const assistant = message({
      id: 'cas-assistant',
      role: 'assistant',
      parentId: user.id,
      createdAt: 2,
      content: [{ type: 'output_text', text: 'old assistant words' }],
    })
    const stale = buildBranchCacheRow({
      chatId: 'chat-cache',
      branchLeafId: assistant.id,
      messages: [user, assistant],
      generatedAt: 50,
    })
    const before = await seedChat({
      lastUpdatedLeafId: assistant.id,
      lastBranchUpdatedAt: 10,
      summaryVersion: 3,
      wordCount: stale.wordCount,
    })
    await putTestMessages([user, assistant])
    const repo = getBrowserRepository()
    const expected = chatBranchCacheWriteGuard(
      before,
      (await repo.getWorkspaceMeta()).replacementEpoch,
    )

    await repo.runMutation([{ kind: 'message', messageId: assistant.id }], async (ctx) => {
      await ctx.putMessage({
        ...assistant,
        content: [{ type: 'output_text', text: 'new assistant words' }],
      })
    })

    await expect(repo.putChatBranchCache(stale, expected)).resolves.toBeUndefined()
    expect(await getDb().chatBranchCache.get('chat-cache')).toBeUndefined()
  })

  it('rejects a stale lazy cache write after the last-updated leaf changes', async () => {
    const root = message({ id: 'leaf-cas-root', content: [{ type: 'text', text: 'root words' }] })
    const oldLeaf = message({
      id: 'leaf-cas-old',
      role: 'assistant',
      parentId: root.id,
      createdAt: 2,
      content: [{ type: 'output_text', text: 'old leaf words' }],
    })
    const stale = buildBranchCacheRow({
      chatId: 'chat-cache',
      branchLeafId: oldLeaf.id,
      messages: [root, oldLeaf],
      generatedAt: 50,
    })
    const before = await seedChat({
      lastUpdatedLeafId: oldLeaf.id,
      lastBranchUpdatedAt: 10,
      summaryVersion: 4,
      wordCount: stale.wordCount,
    })
    await putTestMessages([root, oldLeaf])
    const repo = getBrowserRepository()
    const expected = chatBranchCacheWriteGuard(
      before,
      (await repo.getWorkspaceMeta()).replacementEpoch,
    )
    const newLeaf = message({
      id: 'leaf-cas-new',
      role: 'assistant',
      parentId: root.id,
      siblingIndex: 1,
      createdAt: 3,
      content: [{ type: 'output_text', text: 'new leaf words' }],
    })

    await repo.runMutation(
      [
        { kind: 'message', messageId: newLeaf.id },
        { kind: 'children', chatId: 'chat-cache', parentId: root.id },
      ],
      async (ctx) => ctx.putMessage(newLeaf),
    )

    await expect(repo.putChatBranchCache(stale, expected)).resolves.toBeUndefined()
    expect((await getDb().chats.get('chat-cache'))?.lastUpdatedLeafId).toBe(newLeaf.id)
    expect(await getDb().chatBranchCache.get('chat-cache')).toBeUndefined()
  })

  it('rejects a pre-replacement cache write even when restored chat revisions coincide', async () => {
    const repo = getBrowserRepository()
    const chat = await seedChat({
      lastUpdatedLeafId: 'same-leaf',
      lastBranchUpdatedAt: 10,
      summaryVersion: 4,
    })
    const meta = await repo.getWorkspaceMeta()
    const expected = chatBranchCacheWriteGuard(chat, meta.replacementEpoch)
    const stale = buildBranchCacheRow({
      chatId: chat.id,
      branchLeafId: 'same-leaf',
      messages: [message({ id: 'same-leaf', content: [{ type: 'text', text: 'old body' }] })],
      generatedAt: 20,
    })
    const restored = { ...stale, textContent: 'new body after restore', generatedAt: 30 }
    await getDb().transaction(
      'rw',
      getDb().settings,
      getDb().chats,
      getDb().chatBranchCache,
      async () => {
        await getDb().settings.put({
          key: 'workspace-meta',
          value: { ...meta, replacementEpoch: meta.replacementEpoch + 1 },
        })
        await getDb().chats.put({ ...chat })
        await getDb().chatBranchCache.put(restored)
      },
    )

    await expect(repo.putChatBranchCache(stale, expected)).resolves.toBeUndefined()
    expect(await getDb().chatBranchCache.get(chat.id)).toEqual(restored)
  })

  it('does not let a pre-replacement missing-chat cleanup delete a restored cache', async () => {
    const repo = getBrowserRepository()
    const meta = await repo.getWorkspaceMeta()
    const expected = missingChatBranchCacheWriteGuard(meta.replacementEpoch)
    const chat = await seedChat({
      lastUpdatedLeafId: 'restored-leaf',
      lastBranchUpdatedAt: 10,
      summaryVersion: 2,
    })
    const restored = buildBranchCacheRow({
      chatId: chat.id,
      branchLeafId: 'restored-leaf',
      messages: [
        message({ id: 'restored-leaf', content: [{ type: 'text', text: 'restored body' }] }),
      ],
      generatedAt: 20,
    })
    await getDb().chatBranchCache.put(restored)
    await getDb().settings.put({
      key: 'workspace-meta',
      value: { ...meta, replacementEpoch: meta.replacementEpoch + 1 },
    })

    await expect(repo.deleteChatBranchCache(chat.id, expected)).resolves.toBe(false)
    expect(await getDb().chatBranchCache.get(chat.id)).toEqual(restored)
  })

  it('keeps word count exact when content and branch structure change together', async () => {
    const root = message({
      id: 'combined-root',
      content: [{ type: 'text', text: 'shared root words' }],
    })
    const oldLeaf = message({
      id: 'combined-old',
      role: 'assistant',
      parentId: root.id,
      createdAt: 2,
      content: [{ type: 'output_text', text: 'old short answer' }],
    })
    const initial = buildBranchCacheRow({
      chatId: 'chat-cache',
      branchLeafId: oldLeaf.id,
      messages: [root, oldLeaf],
    })
    await seedChat({
      lastUpdatedLeafId: oldLeaf.id,
      lastBranchUpdatedAt: 10,
      wordCount: initial.wordCount,
    })
    await putTestMessages([root, oldLeaf])
    await getDb().chatBranchCache.put(initial)
    const newLeaf = message({
      id: 'combined-new',
      role: 'assistant',
      parentId: root.id,
      siblingIndex: 1,
      createdAt: 3,
      content: [{ type: 'output_text', text: 'new selected answer' }],
    })

    await getBrowserRepository().runMutation(
      [
        { kind: 'message', messageId: oldLeaf.id },
        { kind: 'message', messageId: newLeaf.id },
        { kind: 'children', chatId: 'chat-cache', parentId: root.id },
      ],
      async (ctx) => {
        await ctx.putMessage({
          ...oldLeaf,
          createdAt: 1,
          content: [{ type: 'output_text', text: 'edited off-path answer with many more words' }],
        })
        await ctx.putMessage(newLeaf)
      },
    )

    const expected = buildBranchCacheRow({
      chatId: 'chat-cache',
      branchLeafId: newLeaf.id,
      messages: [root, newLeaf],
    })
    expect((await getDb().chats.get('chat-cache'))?.wordCount).toBe(expected.wordCount)
    expect(await getDb().chatBranchCache.get('chat-cache')).toBeUndefined()
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
    await putTestMessages([root, latest, offPath])
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
    await putTestMessage(user)
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
