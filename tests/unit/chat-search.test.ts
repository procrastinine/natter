import { describe, expect, it, vi } from 'vitest'
import { buildBranchCacheRow } from '../../src/core/branch-flatten'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type { Chat, ChatBranchCache, ChatFolder, ChatTag, Message } from '../../src/core/types'
import {
  type ChatSearchUpdate,
  DEFAULT_SEARCH_FILTERS,
  searchChats,
} from '../../src/store/chat-search'
import type { ChatBranchCacheWriteGuard, WorkspaceRepository } from '../../src/store/repository'

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

function folder(overrides: Partial<ChatFolder> & Pick<ChatFolder, 'id' | 'name'>): ChatFolder {
  const { id, name, ...rest } = overrides
  return {
    id,
    name,
    sortIndex: 0,
    createdAt: 1,
    updatedAt: 1,
    ...rest,
  }
}

function tag(overrides: Partial<ChatTag> & Pick<ChatTag, 'id' | 'name'>): ChatTag {
  const { id, name, ...rest } = overrides
  return {
    id,
    name,
    nameLower: name.toLocaleLowerCase(),
    createdAt: 1,
    updatedAt: 1,
    ...rest,
  }
}

function repo(input: {
  chats: Chat[]
  folders?: ChatFolder[]
  tags?: ChatTag[]
  messages?: Record<string, Message[] | Promise<Message[]>>
  branches?: Record<string, Message[] | Promise<Message[]>>
  caches?: Record<string, ChatBranchCache | undefined>
}): WorkspaceRepository & {
  getChatBranchCache: ReturnType<typeof vi.fn>
  putChatBranchCache: ReturnType<typeof vi.fn>
  listMessages: ReturnType<typeof vi.fn>
  getBranchByLeaf: ReturnType<typeof vi.fn>
} {
  const chats = new Map(input.chats.map((row) => [row.id, row]))
  const caches = new Map<string, ChatBranchCache | undefined>(Object.entries(input.caches ?? {}))
  const repository = {
    listChats: vi.fn(async () => [...chats.values()]),
    getChat: vi.fn(async (chatId: string) => chats.get(chatId)),
    getWorkspaceMeta: vi.fn(async () => ({
      workspaceId: 'test-workspace',
      backendKind: 'unknown' as const,
      lastMutationAt: 0,
      mutationCounter: 0,
      replacementEpoch: 0,
    })),
    listFolders: vi.fn(async () => input.folders ?? []),
    listTags: vi.fn(async () => input.tags ?? []),
    getChatBranchCache: vi.fn(async (chatId: string) => caches.get(chatId)),
    putChatBranchCache: vi.fn(async (cache: ChatBranchCache) => {
      caches.set(cache.chatId, cache)
      return cache
    }),
    deleteChatBranchCache: vi.fn(async (chatId: string) => caches.delete(chatId)),
    listMessages: vi.fn(async (chatId: string) => input.messages?.[chatId] ?? []),
    getBranchByLeaf: vi.fn(
      async (chatId: string) => input.branches?.[chatId] ?? input.messages?.[chatId] ?? [],
    ),
  }
  return repository as unknown as WorkspaceRepository & {
    getChatBranchCache: ReturnType<typeof vi.fn>
    putChatBranchCache: ReturnType<typeof vi.fn>
    listMessages: ReturnType<typeof vi.fn>
    getBranchByLeaf: ReturnType<typeof vi.fn>
  }
}

describe('chat search backend', () => {
  it('streams title hits before body scans complete', async () => {
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
        chat({ id: 'title', title: 'alpha title', lastUpdatedLeafId: null }),
        chat({
          id: 'body',
          title: 'body',
          lastUpdatedLeafId: 'body-message',
          lastBranchUpdatedAt: 5,
        }),
      ],
      messages: { body: slowMessages },
    })
    const updates: ChatSearchUpdate[] = []

    const promise = searchChats({
      queryId: 'q-stream',
      query: 'alpha',
      repo: repository,
      concurrency: 1,
      onUpdate: (update) => updates.push(update),
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    const titleHit = updates.find(
      (update): update is Extract<ChatSearchUpdate, { kind: 'hit' }> =>
        update.kind === 'hit' && update.result.chatId === 'title',
    )
    expect(titleHit?.queryId).toBe('q-stream')
    expect(titleHit?.completedCount).toBe(1)
    expect(titleHit?.result.source).toBe('title')
    expect(updates.some((update) => update.kind === 'done')).toBe(false)

    releaseMessages()
    const output = await promise
    expect(output.results.map((result) => result.chatId).sort()).toEqual(['body', 'title'])
  })

  it('keeps title-only search away from cache and message reads', async () => {
    const repository = repo({
      chats: [chat({ id: 'title', title: 'needle title', lastUpdatedLeafId: 'm' })],
    })

    const output = await searchChats({
      queryId: 'q-title',
      query: 'needle',
      repo: repository,
      filters: { ...DEFAULT_SEARCH_FILTERS, titleOnly: true },
    })

    expect(output.results).toHaveLength(1)
    expect(repository.getChatBranchCache).not.toHaveBeenCalled()
    expect(repository.listMessages).not.toHaveBeenCalled()
    expect(repository.getBranchByLeaf).not.toHaveBeenCalled()
  })

  it('refreshes a missing default-mode branch cache through the repository', async () => {
    const user = message({
      id: 'user',
      chatId: 'cached',
      content: [{ type: 'text', text: 'hello' }],
    })
    const assistant = message({
      id: 'assistant',
      chatId: 'cached',
      parentId: 'user',
      role: 'assistant',
      createdAt: 2,
      content: [{ type: 'output_text', text: 'body needle appears here' }],
    })
    const offBranch = message({
      id: 'off-branch',
      chatId: 'cached',
      parentId: 'user',
      siblingIndex: 1,
      role: 'assistant',
      createdAt: 3,
      content: [{ type: 'output_text', text: 'unselected body' }],
    })
    const repository = repo({
      chats: [
        chat({
          id: 'cached',
          title: 'cache',
          lastUpdatedLeafId: 'assistant',
          lastBranchUpdatedAt: 10,
        }),
      ],
      messages: { cached: [user, assistant, offBranch] },
      branches: { cached: [user, assistant] },
    })

    const output = await searchChats({
      queryId: 'q-cache',
      query: 'needle',
      repo: repository,
      concurrency: 1,
    })

    expect(repository.putChatBranchCache).toHaveBeenCalledTimes(1)
    expect(repository.getBranchByLeaf).toHaveBeenCalledWith('cached', 'assistant')
    expect(repository.listMessages).not.toHaveBeenCalled()
    const written = repository.putChatBranchCache.mock.calls[0]?.[0] as ChatBranchCache
    expect(written).toEqual(
      buildBranchCacheRow({
        chatId: 'cached',
        branchLeafId: 'assistant',
        messages: [user, assistant, offBranch],
        generatedAt: written.generatedAt,
      }),
    )
    expect(output.results).toMatchObject([
      {
        chatId: 'cached',
        source: 'branch-cache',
        branchLeafId: 'assistant',
      },
    ])
    expect(output.results[0]?.snippet).toContain('needle')
    const highlight = output.results[0]?.highlightRanges[0]
    expect(output.results[0]?.snippet.slice(highlight?.start, highlight?.end)).toBe('needle')
  })

  it('preserves phrase matching across metadata and branch-cache field boundaries', async () => {
    const repository = repo({
      chats: [
        chat({
          id: 'field-boundary',
          title: 'alpha',
          lastUpdatedLeafId: 'leaf',
          lastBranchUpdatedAt: 10,
        }),
      ],
      caches: {
        'field-boundary': {
          chatId: 'field-boundary',
          branchLeafId: 'leaf',
          generatedAt: 10,
          textContent: 'beta body',
          previewText: 'beta body',
          messageCount: 1,
          wordCount: 2,
          messageTimestamps: [{ id: 'leaf', createdAt: 1, editedAt: 1 }],
        },
      },
    })

    const output = await searchChats({
      queryId: 'q-field-boundary',
      query: '"alpha\nbeta"',
      repo: repository,
    })

    expect(output.results).toMatchObject([
      {
        chatId: 'field-boundary',
        source: 'title',
        snippet: 'alpha',
        highlightRanges: [],
      },
    ])
  })

  it('normalizes one large selected-branch cache exactly once without a combined corpus copy', async () => {
    const textContent = `${'large transcript '.repeat(32_768)}needle at the end`
    const repository = repo({
      chats: [
        chat({
          id: 'large-cache',
          title: 'metadata',
          lastUpdatedLeafId: 'leaf',
          lastBranchUpdatedAt: 10,
        }),
      ],
      caches: {
        'large-cache': {
          chatId: 'large-cache',
          branchLeafId: 'leaf',
          generatedAt: 10,
          textContent,
          previewText: 'needle at the end',
          messageCount: 1,
          wordCount: 65_540,
          messageTimestamps: [{ id: 'leaf', createdAt: 1, editedAt: 1 }],
        },
      },
    })
    const original = String.prototype.toLocaleLowerCase
    const normalizedLengths: number[] = []
    const lowerSpy = vi.spyOn(String.prototype, 'toLocaleLowerCase').mockImplementation(function (
      this: string,
      locales?: Intl.LocalesArgument,
    ) {
      normalizedLengths.push(String(this).length)
      return locales === undefined
        ? original.call(String(this))
        : original.call(String(this), locales)
    })

    try {
      const output = await searchChats({
        queryId: 'q-large-cache',
        query: 'needle',
        repo: repository,
      })

      expect(output.results).toHaveLength(1)
      expect(normalizedLengths.filter((length) => length >= textContent.length)).toEqual([
        textContent.length,
      ])
    } finally {
      lowerSpy.mockRestore()
    }
  })

  it('does not write branch cache rows in all-branches mode', async () => {
    const repository = repo({
      chats: [
        chat({
          id: 'branches',
          title: 'branch chat',
          lastUpdatedLeafId: 'latest',
          lastBranchUpdatedAt: 10,
        }),
      ],
      messages: {
        branches: [
          message({
            id: 'older',
            chatId: 'branches',
            createdAt: 2,
            content: [{ type: 'text', text: 'branchword older' }],
          }),
          message({
            id: 'latest-match',
            chatId: 'branches',
            createdAt: 5,
            content: [{ type: 'text', text: 'branchword latest' }],
          }),
        ],
      },
    })

    const output = await searchChats({
      queryId: 'q-all',
      query: 'branchword',
      repo: repository,
      scope: 'all-branches',
      concurrency: 1,
    })

    expect(repository.putChatBranchCache).not.toHaveBeenCalled()
    expect(output.results).toMatchObject([
      {
        chatId: 'branches',
        source: 'all-branches',
        messageId: 'latest-match',
      },
    ])
  })

  it('retries a same-leaf cache rebuild when the chat changes before the guarded write', async () => {
    const oldChat = chat({
      id: 'cache-race',
      lastUpdatedLeafId: 'assistant',
      lastBranchUpdatedAt: 10,
      summaryVersion: 1,
    })
    const newChat = { ...oldChat, lastBranchUpdatedAt: 20, summaryVersion: 2 }
    const user = message({
      id: 'user',
      chatId: oldChat.id,
      content: [{ type: 'text', text: 'question' }],
    })
    const oldAssistant = message({
      id: 'assistant',
      chatId: oldChat.id,
      parentId: user.id,
      role: 'assistant',
      createdAt: 2,
      content: [{ type: 'output_text', text: 'old body' }],
    })
    const newAssistant = {
      ...oldAssistant,
      content: [{ type: 'output_text' as const, text: 'new needle body' }],
    }
    let current = oldChat
    let branch = [user, oldAssistant]
    const putChatBranchCache = vi.fn(
      async (cache: ChatBranchCache, _expected: ChatBranchCacheWriteGuard) => {
        if (putChatBranchCache.mock.calls.length === 1) {
          current = newChat
          branch = [user, newAssistant]
          return undefined
        }
        return cache
      },
    )
    const repository = {
      listChats: vi.fn(async () => [oldChat]),
      getChat: vi.fn(async () => current),
      getWorkspaceMeta: vi.fn(async () => ({
        workspaceId: 'test-workspace',
        backendKind: 'unknown' as const,
        lastMutationAt: 0,
        mutationCounter: 0,
        replacementEpoch: 0,
      })),
      listFolders: vi.fn(async () => []),
      listTags: vi.fn(async () => []),
      getChatBranchCache: vi.fn(async () => undefined),
      getBranchByLeaf: vi.fn(async () => branch),
      putChatBranchCache,
    } as unknown as WorkspaceRepository

    const output = await searchChats({
      queryId: 'same-leaf-cas-retry',
      query: 'new needle',
      repo: repository,
      concurrency: 1,
    })

    expect(putChatBranchCache).toHaveBeenCalledTimes(2)
    expect(putChatBranchCache.mock.calls[0]?.[1]).toEqual({
      branchLeafId: 'assistant',
      lastBranchUpdatedAt: 10,
      summaryVersion: 1,
      replacementEpoch: 0,
    })
    expect(putChatBranchCache.mock.calls[1]?.[1]).toEqual({
      branchLeafId: 'assistant',
      lastBranchUpdatedAt: 20,
      summaryVersion: 2,
      replacementEpoch: 0,
    })
    expect(output.results).toMatchObject([
      { chatId: oldChat.id, source: 'branch-cache', branchLeafId: 'assistant' },
    ])
  })

  it('returns the all-branches navigation target even when the snippet source is title', async () => {
    const repository = repo({
      chats: [
        chat({
          id: 'branches',
          title: 'alpha title',
          lastUpdatedLeafId: 'latest',
          lastBranchUpdatedAt: 10,
        }),
      ],
      messages: {
        branches: [
          message({
            id: 'matching-message',
            chatId: 'branches',
            createdAt: 5,
            content: [{ type: 'text', text: 'alpha beta inside an older branch' }],
          }),
        ],
      },
    })

    const output = await searchChats({
      queryId: 'q-title-plus-body',
      query: 'alpha beta',
      repo: repository,
      scope: 'all-branches',
      concurrency: 1,
    })

    expect(output.results).toMatchObject([
      {
        chatId: 'branches',
        source: 'title',
        messageId: 'matching-message',
      },
    ])
  })

  it('pins the last-updated leaf when an all-branches hit already matches that branch', async () => {
    const repository = repo({
      chats: [
        chat({
          id: 'branches',
          title: 'branch chat',
          lastUpdatedLeafId: 'latest',
          lastBranchUpdatedAt: 10,
        }),
      ],
      caches: {
        branches: {
          chatId: 'branches',
          branchLeafId: 'latest',
          generatedAt: 12,
          textContent: 'branchword already on last branch',
          previewText: 'branchword already on last branch',
          messageCount: 1,
          wordCount: 5,
          messageTimestamps: [{ id: 'latest', createdAt: 10, editedAt: 10 }],
        },
      },
      messages: {
        branches: [
          message({
            id: 'older-match',
            chatId: 'branches',
            createdAt: 5,
            content: [{ type: 'text', text: 'branchword older branch' }],
          }),
        ],
      },
    })

    const output = await searchChats({
      queryId: 'q-last-branch',
      query: 'branchword',
      repo: repository,
      scope: 'all-branches',
      concurrency: 1,
    })

    expect(output.results).toMatchObject([{ chatId: 'branches', branchLeafId: 'latest' }])
    expect(output.results[0]).not.toHaveProperty('messageId')
  })

  it('searches folder and tag metadata and honors operators', async () => {
    const work = folder({ id: 'folder-work', name: 'Work' })
    const research = tag({ id: 'tag-research', name: 'Research' })
    const repository = repo({
      chats: [
        chat({
          id: 'match',
          title: 'notes',
          folderId: work.id,
          tags: [research.id],
          pinned: true,
        }),
        chat({ id: 'miss', title: 'notes', pinned: true }),
      ],
      folders: [work],
      tags: [research],
    })

    const filtered = await searchChats({
      queryId: 'q-filter',
      query: 'tag:research folder:work is:pinned',
      repo: repository,
    })
    const plainTag = await searchChats({
      queryId: 'q-tag',
      query: 'research',
      repo: repository,
    })

    expect(filtered.results.map((result) => result.chatId)).toEqual(['match'])
    expect(plainTag.results).toMatchObject([{ chatId: 'match', source: 'tag' }])
  })

  it('does not emit title hits until body negatives have been checked', async () => {
    const repository = repo({
      chats: [
        chat({
          id: 'negative',
          title: 'alpha title',
          lastUpdatedLeafId: 'm',
          lastBranchUpdatedAt: 5,
        }),
      ],
      messages: {
        negative: [
          message({
            id: 'm',
            chatId: 'negative',
            content: [{ type: 'text', text: 'beta appears in the body' }],
          }),
        ],
      },
    })

    const output = await searchChats({
      queryId: 'q-negative',
      query: 'alpha -beta',
      repo: repository,
      concurrency: 1,
    })

    expect(output.results).toEqual([])
    expect(repository.getBranchByLeaf).toHaveBeenCalledWith('negative', 'm')
    expect(repository.listMessages).not.toHaveBeenCalled()
  })
})
