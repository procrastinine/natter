import { describe, expect, it, vi } from 'vitest'
import { messageRenderableText, messageRenderableTextSegments } from '../../src/core/branch-flatten'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import {
  compileSearchText,
  type MessageCorpusSearchRequest,
  type MessageCorpusSearchResult,
  scanSearchTextSegments,
} from '../../src/core/search-query'
import type { Chat, ChatFolder, ChatTag, Message } from '../../src/core/types'
import {
  type ChatSearchUpdate,
  DEFAULT_SEARCH_FILTERS,
  searchChats,
} from '../../src/store/chat-search'
import { splitMessageForStorage } from '../../src/store/message-storage'
import type {
  WorkspaceQuery,
  WorkspaceReadAuthority,
  WorkspaceRepository,
} from '../../src/store/workspace-protocol'

const authority = { signal: new AbortController().signal } as WorkspaceReadAuthority

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
    summaryVersion: 1,
    structuralVersion: 1,
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

function folder(id: string, name: string): ChatFolder {
  return { id, name, sortIndex: 0, createdAt: 1, updatedAt: 1 }
}

function tag(id: string, name: string): ChatTag {
  return { id, name, nameLower: name.toLocaleLowerCase(), createdAt: 1, updatedAt: 1 }
}

interface RepositoryFixture {
  readonly repo: WorkspaceRepository
  readonly query: ReturnType<
    typeof vi.fn<
      (
        authority: unknown,
        request: WorkspaceQuery,
      ) => Promise<{ workspaceId: string; replacementEpoch: number; value: unknown }>
    >
  >
  readonly execute: ReturnType<typeof vi.fn<() => void>>
}

function repository(input: {
  chats: Chat[]
  folders?: ChatFolder[]
  tags?: ChatTag[]
  messages?: Record<string, Message[]>
  branches?: Record<string, Message[]>
  beforeQuery?: (query: WorkspaceQuery) => Promise<void> | void
}): RepositoryFixture {
  const chats = new Map(input.chats.map((row) => [row.id, row]))
  const branchPresentations = new Map(
    Object.entries(input.branches ?? {}).map(([chatId, rows]) => [
      chatId,
      rows.map((row) => {
        const { header } = splitMessageForStorage(row)
        return { header, message: row, bodyVersion: header.bodyVersion }
      }),
    ]),
  )
  const query = vi.fn(async (_authority: unknown, request: WorkspaceQuery) => {
    await input.beforeQuery?.(request)
    if (
      request.kind !== 'sidebar.catalog-page' &&
      request.kind !== 'sidebar.rows-by-id' &&
      request.kind !== 'folder.get-many' &&
      request.kind !== 'tag.get-many' &&
      request.kind !== 'chat.get' &&
      request.kind !== 'branch.open' &&
      request.kind !== 'branch.page-structure' &&
      request.kind !== 'message.presentations' &&
      request.kind !== 'message.search-corpus'
    ) {
      throw new Error(`UnexpectedQuery:${request.kind}`)
    }
    let value: unknown
    switch (request.kind) {
      case 'sidebar.catalog-page':
        value = { rows: input.chats }
        break
      case 'sidebar.rows-by-id':
        value = request.chatIds.map((chatId) => chats.get(chatId))
        break
      case 'folder.get-many': {
        const folders = new Map((input.folders ?? []).map((folder) => [folder.id, folder]))
        value = request.folderIds.map((folderId) => folders.get(folderId))
        break
      }
      case 'tag.get-many': {
        const tags = new Map((input.tags ?? []).map((tag) => [tag.id, tag]))
        value = request.tagIds.map((tagId) => tags.get(tagId))
        break
      }
      case 'chat.get':
        value = chats.get(request.chatId)
        break
      case 'branch.open': {
        const currentChat = chats.get(request.chatId)
        const presentations = branchPresentations.get(request.chatId) ?? []
        value = currentChat
          ? {
              kind: 'ready',
              chat: currentChat,
              target: request.target,
              proof: {
                chatId: request.chatId,
                structuralVersion: currentChat.structuralVersion,
                tipId: currentChat.lastUpdatedLeafId,
                pathHeaders: presentations.map((presentation) => presentation.header),
              },
              presentations: [],
            }
          : { kind: 'missing', chatId: request.chatId, target: request.target }
        break
      }
      case 'branch.page-structure': {
        value = {
          kind: 'ready',
          snapshot: {
            chatId: request.chatId,
            pageHeaders: request.window.nodes,
            pageOffset: request.window.offset,
            pageLimit: request.window.limit,
            branchLength: request.window.branchLength,
          },
        }
        break
      }
      case 'message.presentations': {
        const byId = new Map(
          [...branchPresentations.values()]
            .flat()
            .map((presentation) => [presentation.header.id, presentation] as const),
        )
        value = request.messageIds.map((messageId) => byId.get(messageId))
        break
      }
      case 'message.search-corpus':
        value = searchCorpus(input.messages?.[request.request.chatId] ?? [], request.request)
        break
    }
    return { workspaceId: 'workspace', replacementEpoch: 0, value }
  })
  const execute = vi.fn()
  return {
    repo: {
      query,
      execute,
      replace: vi.fn(),
      subscribeChanges: vi.fn(() => () => undefined),
    } as unknown as WorkspaceRepository,
    query,
    execute,
  }
}

function searchCorpus(
  messages: readonly Message[],
  request: MessageCorpusSearchRequest,
): MessageCorpusSearchResult {
  const compiled = compileSearchText(request.clauses)
  const live = messages.filter((row) => !row.deleted).sort(compareMessages)
  const corpusSegments = [
    ...(request.prefixFields ?? []).map((field) => field.text),
    ...live.flatMap((row) => [...messageRenderableTextSegments(row)]),
  ]
  const matching = live.filter(
    (row) => scanSearchTextSegments(messageRenderableTextSegments(row), compiled).matches,
  )
  const positive = live.filter(
    (row) => scanSearchTextSegments(messageRenderableTextSegments(row), compiled).firstPositive,
  )
  const firstPositive = live
    .map((row) => ({
      row,
      scan: scanSearchTextSegments(messageRenderableTextSegments(row), compiled),
    }))
    .find(({ scan }) => scan.firstPositive)
  const firstMatch = firstPositive?.scan.firstPositive
  const newestMatching = matching.at(-1)
  const newestPositive = positive.at(-1)
  return {
    clauseHits: scanSearchTextSegments(corpusSegments, compiled).clauseHits,
    matchingMessageIds: request.collectMatchingMessageIds ? matching.map((row) => row.id) : [],
    ...(newestMatching ? { newestMatchingMessageId: newestMatching.id } : {}),
    ...(newestPositive ? { newestPositiveMessageId: newestPositive.id } : {}),
    ...(firstPositive && firstMatch
      ? {
          firstPositiveExcerpt: {
            messageId: firstPositive.row.id,
            text: messageRenderableText(firstPositive.row),
            matchIndex: firstMatch.index,
            matchLength: firstMatch.length,
            messageMatchIndex: firstMatch.index,
            prefixTruncated: false,
            suffixTruncated: false,
          },
        }
      : {}),
  }
}

function compareMessages(left: Message, right: Message): number {
  return left.createdAt - right.createdAt || left.id.localeCompare(right.id)
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('chat search backend', () => {
  it('streams title hits before a different chat branch page resolves', async () => {
    const bodyGate = deferred()
    const updates: ChatSearchUpdate[] = []
    const body = message({
      id: 'body-message',
      chatId: 'body',
      content: [{ type: 'text', text: 'needle in body' }],
    })
    const fixture = repository({
      chats: [
        chat({ id: 'title', title: 'needle title' }),
        chat({ id: 'body', title: 'other', lastUpdatedLeafId: body.id }),
      ],
      branches: { body: [body] },
      beforeQuery: (request) =>
        request.kind === 'branch.page-structure' && request.chatId === 'body'
          ? bodyGate.promise
          : undefined,
    })

    const pending = searchChats({
      queryId: 'query',
      query: 'needle',
      repo: fixture.repo,
      authority,
      concurrency: 1,
      onUpdate: (update) => updates.push(update),
    })
    await vi.waitFor(() => {
      expect(
        updates.some((update) => update.kind === 'hit' && update.result.chatId === 'title'),
      ).toBe(true)
    })
    expect(updates.some((update) => update.kind === 'done')).toBe(false)

    bodyGate.resolve()
    const output = await pending
    expect(output.results.map((result) => result.chatId).sort()).toEqual(['body', 'title'])
  })

  it('streams title hits before an all-branches corpus query resolves', async () => {
    const corpusGate = deferred()
    const updates: ChatSearchUpdate[] = []
    const body = message({
      id: 'body-message',
      chatId: 'body',
      content: [{ type: 'text', text: 'needle in body' }],
    })
    const fixture = repository({
      chats: [
        chat({ id: 'title', title: 'needle title' }),
        chat({ id: 'body', title: 'other', lastUpdatedLeafId: body.id }),
      ],
      messages: { body: [body] },
      branches: { body: [body] },
      beforeQuery: (request) =>
        request.kind === 'message.search-corpus' && request.request.chatId === 'body'
          ? corpusGate.promise
          : undefined,
    })

    const pending = searchChats({
      queryId: 'query',
      query: 'needle',
      scope: 'all-branches',
      repo: fixture.repo,
      authority,
      concurrency: 1,
      onUpdate: (update) => updates.push(update),
    })
    await vi.waitFor(() => {
      expect(
        updates.some((update) => update.kind === 'hit' && update.result.chatId === 'title'),
      ).toBe(true)
    })
    expect(updates.some((update) => update.kind === 'done')).toBe(false)

    corpusGate.resolve()
    const output = await pending
    expect(output.results.map((result) => result.chatId).sort()).toEqual(['body', 'title'])
  })

  it('keeps title-only search away from branch and message reads', async () => {
    const fixture = repository({ chats: [chat({ id: 'title', title: 'needle' })] })

    const output = await searchChats({
      queryId: 'query',
      query: 'needle',
      filters: { ...DEFAULT_SEARCH_FILTERS, titleOnly: true },
      repo: fixture.repo,
      authority,
    })

    expect(output.results).toMatchObject([{ chatId: 'title', source: 'title' }])
    expect(
      fixture.query.mock.calls.some(
        ([, request]) =>
          request.kind === 'branch.open' ||
          request.kind === 'branch.page-structure' ||
          request.kind === 'message.presentations' ||
          request.kind === 'message.search-corpus',
      ),
    ).toBe(false)
  })

  it('searches the canonical last-updated branch without any derived write', async () => {
    const user = message({
      id: 'user',
      chatId: 'chat',
      content: [{ type: 'text', text: 'prefix' }],
    })
    const assistant = message({
      id: 'assistant',
      chatId: 'chat',
      parentId: user.id,
      createdAt: 2,
      role: 'assistant',
      origin: 'generated',
      content: [{ type: 'output_text', text: 'needle here' }],
    })
    const fixture = repository({
      chats: [chat({ id: 'chat', lastUpdatedLeafId: assistant.id })],
      branches: { chat: [user, assistant] },
    })

    const output = await searchChats({
      queryId: 'query',
      query: 'needle',
      repo: fixture.repo,
      authority,
    })

    expect(output.results).toMatchObject([
      { chatId: 'chat', source: 'last-updated-branch', branchLeafId: 'assistant' },
    ])
    expect(fixture.execute).not.toHaveBeenCalled()
    expect(
      fixture.query.mock.calls.some(([, request]) => request.kind === 'branch.page-structure'),
    ).toBe(true)
    expect(
      fixture.query.mock.calls.some(([, request]) => request.kind === 'message.presentations'),
    ).toBe(true)
  })

  it('finds off-branch text and returns the exact all-branches navigation target', async () => {
    const latest = message({
      id: 'latest',
      chatId: 'chat',
      createdAt: 1,
      content: [{ type: 'text', text: 'latest text' }],
    })
    const matching = message({
      id: 'matching',
      chatId: 'chat',
      createdAt: 2,
      content: [{ type: 'text', text: 'off branch needle' }],
    })
    const fixture = repository({
      chats: [chat({ id: 'chat', lastUpdatedLeafId: latest.id })],
      messages: { chat: [latest, matching] },
      branches: { chat: [latest] },
    })

    const output = await searchChats({
      queryId: 'query',
      query: 'needle',
      scope: 'all-branches',
      repo: fixture.repo,
      authority,
    })

    expect(output.results).toMatchObject([
      { chatId: 'chat', source: 'all-branches', messageId: 'matching' },
    ])
    expect(fixture.execute).not.toHaveBeenCalled()
  })

  it('pins the canonical leaf when all-branches text also matches it', async () => {
    const latest = message({
      id: 'latest',
      chatId: 'chat',
      content: [{ type: 'text', text: 'needle on latest branch' }],
    })
    const fixture = repository({
      chats: [chat({ id: 'chat', lastUpdatedLeafId: latest.id })],
      messages: { chat: [latest] },
      branches: { chat: [latest] },
    })

    const output = await searchChats({
      queryId: 'query',
      query: 'needle',
      scope: 'all-branches',
      repo: fixture.repo,
      authority,
    })

    expect(output.results).toMatchObject([
      { chatId: 'chat', source: 'all-branches', branchLeafId: 'latest' },
    ])
    expect(output.results[0]).not.toHaveProperty('messageId')
  })

  it('searches folder and tag metadata while honoring operators', async () => {
    const fixture = repository({
      chats: [chat({ id: 'chat', title: 'Roadmap', folderId: 'work', tags: ['research'] })],
      folders: [folder('work', 'Work')],
      tags: [tag('research', 'Research')],
    })

    const output = await searchChats({
      queryId: 'query',
      query: 'folder:work tag:research roadmap',
      repo: fixture.repo,
      authority,
    })

    expect(output.results).toMatchObject([{ chatId: 'chat', source: 'title' }])
  })

  it('does not emit a title hit until negative body clauses are checked', async () => {
    const row = message({
      id: 'message',
      chatId: 'chat',
      content: [{ type: 'text', text: 'forbidden' }],
    })
    const updates: ChatSearchUpdate[] = []
    const fixture = repository({
      chats: [chat({ id: 'chat', title: 'needle title', lastUpdatedLeafId: row.id })],
      branches: { chat: [row] },
    })

    const output = await searchChats({
      queryId: 'query',
      query: 'needle -forbidden',
      repo: fixture.repo,
      authority,
      onUpdate: (update) => updates.push(update),
    })

    expect(output.results).toEqual([])
    expect(updates.some((update) => update.kind === 'hit')).toBe(false)
  })
})
