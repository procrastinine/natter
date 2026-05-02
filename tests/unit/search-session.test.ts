import { afterEach, describe, expect, it, vi } from 'vitest'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type { Chat, ChatBranchCache, Message } from '../../src/core/types'
import type { WorkspaceRepository } from '../../src/store/repository'
import {
  __resetSearchSessionRunnerForTests,
  requestSearchSession,
} from '../../src/store/search-session'
import { __resetSearchStoreForTests, useSearchStore } from '../../src/store/zustand/searchStore'

afterEach(() => {
  __resetSearchSessionRunnerForTests()
  __resetSearchStoreForTests()
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
    listFolders: vi.fn(async () => []),
    listTags: vi.fn(async () => []),
    getChatBranchCache: vi.fn(async (chatId: string) => caches.get(chatId)),
    putChatBranchCache: vi.fn(async (cache: ChatBranchCache) => {
      caches.set(cache.chatId, cache)
      return cache
    }),
    deleteChatBranchCache: vi.fn(async (chatId: string) => caches.delete(chatId)),
    listMessages: vi.fn(async (chatId: string) => input.messages?.[chatId] ?? []),
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

    await waitFor(() => useSearchStore.getState().session?.results.length === 1)
    expect(useSearchStore.getState().session).toMatchObject({
      status: 'scanning',
      completedCount: 1,
      candidateCount: 2,
    })

    releaseMessages()
    await waitFor(() => useSearchStore.getState().session?.status === 'done')
    expect(
      useSearchStore
        .getState()
        .session?.results.map((result) => result.chatId)
        .sort(),
    ).toEqual(['body', 'title'])
  })
})

async function waitFor(assertion: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (assertion()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('Timed out waiting for search session state')
}
