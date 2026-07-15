import { afterEach, describe, expect, it, vi } from 'vitest'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type { Chat, ChatBranchCache, Message } from '../../src/core/types'
import { __resetBroadcastForTests, postEvent } from '../../src/store/broadcast'
import type { WorkspaceRepository } from '../../src/store/repository'
import {
  __resetSearchSessionRunnerForTests,
  requestSearchSession,
} from '../../src/store/search-session'
import {
  __resetSearchStoreForTests,
  orderedSearchResults,
  startSearchStoreBroadcastListener,
  useSearchStore,
} from '../../src/store/zustand/searchStore'

afterEach(() => {
  __resetSearchSessionRunnerForTests()
  __resetSearchStoreForTests()
  __resetBroadcastForTests()
})

function chat(overrides: Partial<Chat> & Pick<Chat, 'id'>): Chat {
  const { id, ...rest } = overrides
  return {
    id,
    title: '',
    titleStatus: 'untitled',
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
    ...rest,
  }
}

function message(overrides: Partial<Message> & Pick<Message, 'id' | 'chatId'>): Message {
  const { id, chatId, ...rest } = overrides
  return {
    id,
    chatId,
    parentId: null,
    siblingIndex: 0,
    turnId: `turn-${id}`,
    turnIndex: 0,
    createdAt: 1,
    role: 'user',
    origin: 'user',
    content: [{ type: 'text', text: '' }],
    nodeVersion: 0,
    deleted: false,
    ...rest,
  }
}

function repo(input: {
  chats: Chat[]
  messages?: Record<string, Message[] | Promise<Message[]>>
}): WorkspaceRepository {
  const chats = new Map(input.chats.map((row) => [row.id, row]))
  const caches = new Map<string, ChatBranchCache>()
  return {
    listChats: vi.fn(async () => [...chats.values()]),
    getChat: vi.fn(async (chatId: string) => chats.get(chatId)),
    getWorkspaceMeta: vi.fn(async () => ({
      workspaceId: 'test-workspace',
      backendKind: 'unknown' as const,
      lastMutationAt: 0,
      mutationCounter: 0,
      replacementEpoch: 0,
    })),
    listFolders: vi.fn(async () => []),
    listTags: vi.fn(async () => []),
    getChatBranchCache: vi.fn(async (chatId: string) => caches.get(chatId)),
    putChatBranchCache: vi.fn(async (cache: ChatBranchCache) => {
      caches.set(cache.chatId, cache)
      return cache
    }),
    deleteChatBranchCache: vi.fn(async (chatId: string) => caches.delete(chatId)),
    listMessages: vi.fn(async (chatId: string) => input.messages?.[chatId] ?? []),
    getBranchByLeaf: vi.fn(async (chatId: string) => input.messages?.[chatId] ?? []),
  } as unknown as WorkspaceRepository
}

describe('search session runner', () => {
  it('writes partial hits into the store before the session completes', async () => {
    let releaseMessages!: () => void
    const slowMessages = new Promise<Message[]>((resolve) => {
      releaseMessages = () =>
        resolve([
          message({
            id: 'body-message',
            chatId: 'body',
            content: [{ type: 'text', text: 'alpha body hit' }],
          }),
        ])
    })
    const repository = repo({
      chats: [
        chat({ id: 'title', title: 'alpha title' }),
        chat({
          id: 'body',
          title: 'body',
          lastUpdatedLeafId: 'body-message',
          lastBranchUpdatedAt: 5,
        }),
      ],
      messages: { body: slowMessages },
    })

    requestSearchSession({
      query: 'alpha',
      repo: repository,
      concurrency: 1,
      debounceMs: 0,
    })

    await waitFor(() => useSearchStore.getState().session?.results.size === 1)
    expect(useSearchStore.getState().session).toMatchObject({
      status: 'scanning',
      completedCount: 1,
      candidateCount: 2,
    })

    releaseMessages()
    await waitFor(() => useSearchStore.getState().session?.status === 'done')
    expect(
      orderedSearchResults(useSearchStore.getState().session?.results)
        .map((result) => result.chatId)
        .sort(),
    ).toEqual(['body', 'title'])
  })

  it('drains exact chat invalidations that arrive after done in both result directions', async () => {
    const mutableChat = chat({ id: 'mutable', title: 'needle' })
    const repository = repo({ chats: [mutableChat] })
    startSearchStoreBroadcastListener()

    requestSearchSession({ query: 'needle', repo: repository, debounceMs: 0 })
    await waitFor(
      () =>
        useSearchStore.getState().session?.status === 'done' &&
        useSearchStore.getState().session?.results.size === 1,
    )

    mutableChat.title = 'other'
    postEvent({
      kind: 'chat-mutated',
      chatId: mutableChat.id,
      metaVersion: 1,
      summaryVersion: 1,
      affected: [{ kind: 'chat-meta', chatId: mutableChat.id }],
    })
    await waitFor(
      () =>
        useSearchStore.getState().session?.status === 'done' &&
        useSearchStore.getState().session?.results.size === 0,
    )

    mutableChat.title = 'needle again'
    postEvent({
      kind: 'chat-mutated',
      chatId: mutableChat.id,
      metaVersion: 2,
      summaryVersion: 2,
      affected: [{ kind: 'chat-meta', chatId: mutableChat.id }],
    })
    await waitFor(
      () =>
        useSearchStore.getState().session?.status === 'done' &&
        orderedSearchResults(useSearchStore.getState().session?.results)[0]?.chat.title ===
          'needle again',
    )

    expect(repository.listChats).toHaveBeenCalledTimes(3)
    expect(repository.listMessages).not.toHaveBeenCalled()
  })

  it('requeues an invalidation for the same chat while its tail pass is in flight', async () => {
    const mutableChat = chat({ id: 'mutable', title: 'needle' })
    const repository = repo({ chats: [mutableChat] })
    startSearchStoreBroadcastListener()

    requestSearchSession({ query: 'needle', repo: repository, debounceMs: 0 })
    await waitFor(
      () =>
        useSearchStore.getState().session?.status === 'done' &&
        useSearchStore.getState().session?.results.size === 1,
    )

    let markTailStarted!: () => void
    let releaseTail!: () => void
    const tailStarted = new Promise<void>((resolve) => {
      markTailStarted = resolve
    })
    const tailGate = new Promise<void>((resolve) => {
      releaseTail = resolve
    })
    vi.mocked(repository.listChats).mockImplementationOnce(async () => {
      const snapshot = { ...mutableChat }
      markTailStarted()
      await tailGate
      return [snapshot]
    })

    mutableChat.title = 'other'
    postEvent({
      kind: 'chat-mutated',
      chatId: mutableChat.id,
      metaVersion: 1,
      summaryVersion: 1,
      affected: [{ kind: 'chat-meta', chatId: mutableChat.id }],
    })
    await tailStarted

    mutableChat.title = 'needle again'
    postEvent({
      kind: 'chat-mutated',
      chatId: mutableChat.id,
      metaVersion: 2,
      summaryVersion: 2,
      affected: [{ kind: 'chat-meta', chatId: mutableChat.id }],
    })
    releaseTail()

    await waitFor(
      () =>
        useSearchStore.getState().session?.status === 'done' &&
        orderedSearchResults(useSearchStore.getState().session?.results)[0]?.chat.title ===
          'needle again',
    )
    expect(repository.listChats).toHaveBeenCalledTimes(3)
    expect(repository.listMessages).not.toHaveBeenCalled()
  })

  it('turns a post-done filtered-tag invalidation into a full rescan', async () => {
    const mutableChat = chat({ id: 'tagged', title: 'tagged', tags: ['tag-1'] })
    const repository = repo({ chats: [mutableChat] })
    startSearchStoreBroadcastListener()

    requestSearchSession({
      query: '',
      repo: repository,
      debounceMs: 0,
      filters: {
        includeFolderIds: [],
        excludeFolderIds: [],
        includeTagIds: ['tag-1'],
        excludeTagIds: [],
        archived: 'exclude',
        titleOnly: false,
      },
    })
    await waitFor(
      () =>
        useSearchStore.getState().session?.status === 'done' &&
        useSearchStore.getState().session?.results.size === 1,
    )

    mutableChat.tags = []
    postEvent({ kind: 'tag-deleted', tagId: 'tag-1' })
    await waitFor(
      () =>
        useSearchStore.getState().session?.status === 'done' &&
        useSearchStore.getState().session?.results.size === 0,
    )

    expect(repository.listChats).toHaveBeenCalledTimes(2)
    expect(repository.listMessages).not.toHaveBeenCalled()
  })

  it('publishes a 100,003-title-hit session geometrically without hydrating bodies', async () => {
    const count = 100_003
    const base = chat({ id: 'base', title: 'needle' })
    const chats = Array.from({ length: count }, (_, index) => ({
      ...base,
      id: `chat-${index}`,
      title: `needle ${index}`,
    }))
    const repository = repo({ chats })
    const resultRevisions: number[] = []
    const unsubscribe = useSearchStore.subscribe((state, previous) => {
      const revision = state.session?.results.revision
      if (revision !== undefined && revision !== previous.session?.results.revision) {
        resultRevisions.push(revision)
      }
    })
    const startedAt = performance.now()

    requestSearchSession({ query: 'needle', repo: repository, debounceMs: 0 })
    await waitFor(
      () =>
        useSearchStore.getState().session?.status === 'done' &&
        useSearchStore.getState().session?.results.size === count,
      10_000,
    )
    const elapsedMs = performance.now() - startedAt
    unsubscribe()

    const results = orderedSearchResults(useSearchStore.getState().session?.results)
    expect(results).toHaveLength(count)
    expect(results[0]?.chatId).toBe('chat-0')
    expect(results.at(-1)?.chatId).toBe(`chat-${count - 1}`)
    expect(resultRevisions.length).toBeLessThanOrEqual(18)
    expect(resultRevisions).toEqual(
      Array.from({ length: resultRevisions.length }, (_, index) => index),
    )
    expect(repository.listMessages).not.toHaveBeenCalled()
    expect(repository.getBranchByLeaf).not.toHaveBeenCalled()
    expect(elapsedMs).toBeLessThan(5_000)
  }, 15_000)
})

async function waitFor(assertion: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (assertion()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('Timed out waiting for search session state')
}
