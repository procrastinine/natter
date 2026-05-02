import { describe, expect, it, vi } from 'vitest'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type { Chat, ChatBranchCache, ChatFolder, ChatTag, Message } from '../../src/core/types'
import {
  type ChatSearchUpdate,
  DEFAULT_SEARCH_FILTERS,
  searchChats,
} from '../../src/store/chat-search'
import type { WorkspaceRepository } from '../../src/store/repository'

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
  caches?: Record<string, ChatBranchCache | undefined>
}): WorkspaceRepository & {
  getChatBranchCache: ReturnType<typeof vi.fn>
  putChatBranchCache: ReturnType<typeof vi.fn>
  listMessages: ReturnType<typeof vi.fn>
} {
  const chats = new Map(input.chats.map((row) => [row.id, row]))
  const caches = new Map<string, ChatBranchCache | undefined>(Object.entries(input.caches ?? {}))
  const repository = {
    listChats: vi.fn(async () => [...chats.values()]),
    getChat: vi.fn(async (chatId: string) => chats.get(chatId)),
    listFolders: vi.fn(async () => input.folders ?? []),
    listTags: vi.fn(async () => input.tags ?? []),
    getChatBranchCache: vi.fn(async (chatId: string) => caches.get(chatId)),
    putChatBranchCache: vi.fn(async (cache: ChatBranchCache) => {
      caches.set(cache.chatId, cache)
      return cache
    }),
    deleteChatBranchCache: vi.fn(async (chatId: string) => caches.delete(chatId)),
    listMessages: vi.fn(async (chatId: string) => input.messages?.[chatId] ?? []),
  }
  return repository as unknown as WorkspaceRepository & {
    getChatBranchCache: ReturnType<typeof vi.fn>
    putChatBranchCache: ReturnType<typeof vi.fn>
    listMessages: ReturnType<typeof vi.fn>
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
  })

  it('refreshes a missing default-mode branch cache through the repository', async () => {
    const repository = repo({
      chats: [
        chat({
          id: 'cached',
          title: 'cache',
          lastUpdatedLeafId: 'assistant',
          lastBranchUpdatedAt: 10,
        }),
      ],
      messages: {
        cached: [
          message({
            id: 'user',
            chatId: 'cached',
            content: [{ type: 'text', text: 'hello' }],
          }),
          message({
            id: 'assistant',
            chatId: 'cached',
            parentId: 'user',
            role: 'assistant',
            createdAt: 2,
            content: [{ type: 'output_text', text: 'body needle appears here' }],
          }),
        ],
      },
    })

    const output = await searchChats({
      queryId: 'q-cache',
      query: 'needle',
      repo: repository,
      concurrency: 1,
    })

    expect(repository.putChatBranchCache).toHaveBeenCalledTimes(1)
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
    expect(repository.listMessages).toHaveBeenCalled()
  })
})
