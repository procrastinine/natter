import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type {
  Chat,
  ChatFolder,
  ChatId,
  ChatSidebarRow,
  ChatTag,
  Message,
} from '../../src/core/types'
import { splitMessageForStorage } from '../../src/store/message-storage'
import {
  openMountedRepositoryProjections,
  reconcileMountedRepositoryProjections,
  suspendMountedRepositoryProjections,
} from '../../src/store/mounted-projection-lifecycle'
import type { ChatSidebarCatalogPage } from '../../src/store/repository'
import {
  createSearchSessionController,
  orderedSearchResults,
  type SearchSessionController,
} from '../../src/store/search-session'
import {
  prepareLocalWorkspaceChange,
  publishPreparedWorkspaceEffect,
} from '../../src/store/workspace-effect-hub'
import type {
  ReadEnvelope,
  WorkspaceChange,
  WorkspaceQuery,
  WorkspaceQueryResult,
  WorkspaceReadAuthority,
  WorkspaceRepository,
} from '../../src/store/workspace-protocol'
import { workspaceRuntimeInternal } from '../../src/store/workspace-runtime'

const FENCE = Object.freeze({ workspaceId: 'search-workspace', replacementEpoch: 0 })
const controllers = new Set<SearchSessionController>()

beforeAll(() => {
  if (workspaceRuntimeInternal.snapshot().state === 'STARTING') {
    workspaceRuntimeInternal.beginReconciliation(FENCE)
    workspaceRuntimeInternal.finishReconciliation(FENCE)
  }
})

beforeEach(() => {
  reconcileMountedRepositoryProjections(FENCE)
  openMountedRepositoryProjections()
})

afterEach(() => {
  for (const controller of controllers) controller.dispose()
  controllers.clear()
})

describe('search session controller', () => {
  it('defers reads until open and never attaches a per-session repository changefeed', async () => {
    suspendMountedRepositoryProjections()
    const repository = new SearchProtocolRepository([chat({ id: 'deferred', title: 'needle' })])
    const controller = createController()

    controller.request({ query: 'needle', repo: repository, debounceMs: 0 })
    await waitFor(() => controller.getSnapshot()?.status === 'debouncing')
    expect(repository.listeners.size).toBe(0)
    expect(repository.calls).toEqual([])

    reconcileMountedRepositoryProjections(FENCE)
    expect(repository.listeners.size).toBe(0)
    expect(repository.calls).toEqual([])

    openMountedRepositoryProjections()
    await doneWithResults(controller, 1)
    expect(repository.listeners.size).toBe(0)
    expect(repository.count('sidebar.catalog-page')).toBe(1)
  })

  it('publishes partial title hits while a branch body query remains pending', async () => {
    const title = chat({ id: 'title', title: 'alpha title' })
    const body = chat({
      id: 'body',
      title: 'body',
      lastUpdatedLeafId: 'body-message',
      lastBranchUpdatedAt: 5,
    })
    const bodyMessage = message({
      id: 'body-message',
      chatId: body.id,
      content: [{ type: 'text', text: 'alpha body hit' }],
    })
    const repository = new SearchProtocolRepository([title, body], {
      [body.id]: [bodyMessage],
    })
    let releaseBody!: () => void
    repository.branchPageGate = new Promise<void>((resolve) => {
      releaseBody = resolve
    })
    const controller = createController()

    controller.request({ query: 'alpha', repo: repository, concurrency: 1, debounceMs: 0 })
    await waitFor(() => controller.getSnapshot() !== null)
    expect(repository.listeners.size).toBe(0)

    await waitFor(() => controller.getSnapshot()?.results.size === 1)
    expect(controller.getSnapshot()).toMatchObject({
      status: 'scanning',
      completedCount: 1,
      candidateCount: 2,
    })

    releaseBody()
    await waitFor(() => controller.getSnapshot()?.status === 'done')
    expect(
      orderedSearchResults(controller.getSnapshot()?.results)
        .map((result) => result.chatId)
        .sort(),
    ).toEqual(['body', 'title'])
  })

  it('publishes only partials from the latest synchronously owned query', async () => {
    const alpha = chat({ id: 'alpha', title: 'alpha title' })
    const beta = chat({ id: 'beta', title: 'beta title' })
    const body = chat({
      id: 'body',
      title: 'body',
      lastUpdatedLeafId: 'body-message',
      lastBranchUpdatedAt: 5,
    })
    const bodyMessage = message({
      id: 'body-message',
      chatId: body.id,
      content: [{ type: 'text', text: 'alpha body hit' }],
    })
    const repository = new SearchProtocolRepository([alpha, beta, body], {
      [body.id]: [bodyMessage],
    })
    let releaseBody!: () => void
    repository.branchPageGate = new Promise<void>((resolve) => {
      releaseBody = resolve
    })
    const controller = createController()

    controller.request({ query: 'alpha', repo: repository, concurrency: 2, debounceMs: 0 })
    await waitFor(() => controller.getSnapshot()?.results.size === 1)
    expect(orderedSearchResults(controller.getSnapshot()?.results)).toMatchObject([
      { chatId: 'alpha' },
    ])

    controller.request({ query: 'beta', repo: repository, concurrency: 2, debounceMs: 0 })
    expect(controller.getSnapshot()).toMatchObject({
      query: 'beta',
      status: 'debouncing',
      results: { size: 0 },
    })
    await waitFor(() => controller.getSnapshot()?.results.size === 1)
    expect(orderedSearchResults(controller.getSnapshot()?.results)).toMatchObject([
      { chatId: 'beta' },
    ])

    releaseBody()
    await doneWithResults(controller, 1)
    expect(orderedSearchResults(controller.getSnapshot()?.results)).toMatchObject([
      { chatId: 'beta' },
    ])
  })

  it('keeps catalog order when concurrent body scans finish in reverse', async () => {
    const firstMessage = message({
      id: 'first-message',
      chatId: 'first',
      content: [{ type: 'text', text: 'needle first' }],
    })
    const secondMessage = message({
      id: 'second-message',
      chatId: 'second',
      content: [{ type: 'text', text: 'needle second' }],
    })
    const repository = new SearchProtocolRepository(
      [
        chat({ id: 'first', title: 'first', lastUpdatedLeafId: firstMessage.id }),
        chat({ id: 'second', title: 'second', lastUpdatedLeafId: secondMessage.id }),
      ],
      { first: [firstMessage], second: [secondMessage] },
    )
    let releaseFirst!: () => void
    repository.branchPageHook = (chatId) =>
      chatId === 'first'
        ? new Promise<void>((resolve) => {
            releaseFirst = resolve
          })
        : null
    const controller = createController()

    controller.request({ query: 'needle', repo: repository, concurrency: 2, debounceMs: 0 })
    await waitFor(() => controller.getSnapshot()?.results.size === 1)
    expect(orderedSearchResults(controller.getSnapshot()?.results)).toMatchObject([
      { chatId: 'second' },
    ])

    releaseFirst()
    await doneWithResults(controller, 2)
    expect(orderedSearchResults(controller.getSnapshot()?.results)).toMatchObject([
      { chatId: 'first' },
      { chatId: 'second' },
    ])
  })

  it('point-rescans a changed chat after done in both result directions', async () => {
    const mutable = chat({ id: 'mutable', title: 'needle' })
    const repository = new SearchProtocolRepository([mutable])
    const controller = createController()
    controller.request({ query: 'needle', repo: repository, debounceMs: 0 })
    await doneWithResults(controller, 1)

    mutable.title = 'other'
    repository.emit(chatChanged(mutable.id, 'commit-1'))
    await doneWithResults(controller, 0)

    mutable.title = 'needle again'
    repository.emit(chatChanged(mutable.id, 'commit-2'))
    await waitFor(
      () =>
        controller.getSnapshot()?.status === 'done' &&
        orderedSearchResults(controller.getSnapshot()?.results)[0]?.chat.title === 'needle again',
    )

    expect(repository.count('sidebar.catalog-page')).toBe(1)
    expect(repository.count('sidebar.rows-by-id')).toBe(2)
    expect(repository.count('branch.page-structure')).toBe(0)
    expect(repository.count('message.presentations')).toBe(0)
  })

  it('requeues a second invalidation while the first point rescan is in flight', async () => {
    const mutable = chat({ id: 'mutable', title: 'needle' })
    const repository = new SearchProtocolRepository([mutable])
    const controller = createController()
    controller.request({ query: 'needle', repo: repository, debounceMs: 0 })
    await doneWithResults(controller, 1)

    let markPointReadStarted!: () => void
    let releasePointRead!: () => void
    const pointReadStarted = new Promise<void>((resolve) => {
      markPointReadStarted = resolve
    })
    const pointReadGate = new Promise<void>((resolve) => {
      releasePointRead = resolve
    })
    repository.rowsByIdHook = async (ids) => {
      const snapshot = ids.map((id) => repository.row(id))
      markPointReadStarted()
      await pointReadGate
      repository.rowsByIdHook = null
      return snapshot
    }

    mutable.title = 'other'
    repository.emit(chatChanged(mutable.id, 'commit-1'))
    await pointReadStarted
    mutable.title = 'needle again'
    repository.emit(chatChanged(mutable.id, 'commit-2'))
    releasePointRead()

    await waitFor(
      () =>
        controller.getSnapshot()?.status === 'done' &&
        orderedSearchResults(controller.getSnapshot()?.results)[0]?.chat.title === 'needle again',
    )
    expect(repository.count('sidebar.rows-by-id')).toBe(2)
    expect(repository.count('branch.page-structure')).toBe(0)
    expect(repository.count('message.presentations')).toBe(0)
  })

  it('turns a filtered-tag invalidation into one full catalog rescan', async () => {
    const survivor = chat({ id: 'survivor', title: 'survivor', tags: ['tag-1'] })
    const removed = chat({ id: 'removed', title: 'removed', tags: ['tag-1'] })
    const repository = new SearchProtocolRepository(
      [survivor, removed],
      {},
      [],
      [{ id: 'tag-1', name: 'Tag', nameLower: 'tag', createdAt: 1, updatedAt: 1 }],
    )
    const controller = createController()
    controller.request({
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
    await doneWithResults(controller, 2)

    let releaseCatalog!: () => void
    repository.catalogPageGate = new Promise<void>((resolve) => {
      releaseCatalog = resolve
    })
    const publishedSizes: number[] = []
    const unsubscribe = controller.subscribe(() => {
      publishedSizes.push(controller.getSnapshot()?.results.size ?? 0)
    })

    removed.tags = []
    repository.emit({
      kind: 'commit',
      stamp: { ...FENCE, commitId: 'tag-delete' },
      delta: { facts: [], invalidations: [{ kind: 'tag', tagIds: ['tag-1'] }] },
    })
    await waitFor(() => controller.getSnapshot()?.status === 'scanning')
    expect(controller.getSnapshot()).toMatchObject({ interactive: true, results: { size: 2 } })

    releaseCatalog()
    await doneWithResults(controller, 1)
    unsubscribe()

    expect(repository.count('sidebar.catalog-page')).toBe(2)
    expect(repository.count('sidebar.rows-by-id')).toBe(0)
    expect(repository.count('branch.page-structure')).toBe(0)
    expect(repository.count('message.presentations')).toBe(0)
    expect(publishedSizes).not.toContain(0)
    expect(orderedSearchResults(controller.getSnapshot()?.results)).toMatchObject([
      { chatId: 'survivor' },
    ])
  })

  it('publishes 100,003 title hits geometrically without branch or body queries', async () => {
    const count = 100_003
    const rows = Array.from({ length: count }, (_, index) =>
      sidebarRow({ id: `chat-${index}`, title: `needle ${index}` }),
    )
    const repository = new SearchProtocolRepository(rows)
    const controller = createController()
    const resultRevisions: number[] = []
    const unsubscribe = controller.subscribe(() => {
      const revision = controller.getSnapshot()?.results.revision
      if (revision !== undefined && resultRevisions.at(-1) !== revision) {
        resultRevisions.push(revision)
      }
    })
    const startedAt = performance.now()

    controller.request({ query: 'needle', repo: repository, debounceMs: 0 })
    await doneWithResults(controller, count, 10_000)
    const elapsedMs = performance.now() - startedAt
    unsubscribe()

    const results = orderedSearchResults(controller.getSnapshot()?.results)
    expect(results).toHaveLength(count)
    expect(results[0]?.chatId).toBe('chat-0')
    expect(results.at(-1)?.chatId).toBe(`chat-${count - 1}`)
    expect(resultRevisions.length).toBeLessThanOrEqual(19)
    expect(resultRevisions).toEqual(
      Array.from({ length: resultRevisions.length }, (_, index) => index),
    )
    expect(Object.isFrozen(controller.getSnapshot()?.results.orderedIds)).toBe(true)
    expect(Object.isFrozen(results)).toBe(true)
    expect(repository.count('chat.get')).toBe(0)
    expect(repository.count('branch.open')).toBe(0)
    expect(repository.count('branch.page-structure')).toBe(0)
    expect(repository.count('message.presentations')).toBe(0)
    expect(repository.count('message.search-corpus')).toBe(0)
    expect(elapsedMs).toBeLessThan(5_000)
  }, 15_000)
})

class SearchProtocolRepository implements WorkspaceRepository {
  readonly calls: WorkspaceQuery['kind'][] = []
  readonly listeners = new Set<(change: WorkspaceChange) => void>()
  readonly folders: ChatFolder[]
  readonly tags: ChatTag[]
  branchPageGate: Promise<void> | null = null
  branchPageHook: ((chatId: ChatId) => Promise<void> | null) | null = null
  rowsByIdHook: ((ids: readonly ChatId[]) => Promise<Array<ChatSidebarRow | undefined>>) | null =
    null
  catalogPageGate: Promise<void> | null = null
  private readonly rows: readonly ChatSidebarRow[]
  private readonly rowsById = new Map<ChatId, ChatSidebarRow>()
  private readonly liveIds: ChatId[] = []
  private readonly archivedIds: ChatId[] = []
  private readonly mutableChats = new Map<ChatId, Chat>()
  private readonly messagesByChat: Readonly<Record<ChatId, readonly Message[]>>

  constructor(
    rows: readonly (Chat | ChatSidebarRow)[],
    messagesByChat: Readonly<Record<ChatId, readonly Message[]>> = {},
    folders: ChatFolder[] = [],
    tags: ChatTag[] = [],
  ) {
    this.rows = rows.map((row) => sidebarRow(row))
    for (const row of this.rows) {
      this.rowsById.set(row.id, row)
      if (row.archived) this.archivedIds.push(row.id)
      else this.liveIds.push(row.id)
    }
    for (const row of rows) {
      if ('settings' in row) this.mutableChats.set(row.id, row)
    }
    this.messagesByChat = messagesByChat
    this.folders = folders
    this.tags = tags
  }

  row(chatId: ChatId): ChatSidebarRow | undefined {
    const mutable = this.mutableChats.get(chatId)
    if (mutable) return sidebarRow(mutable)
    return this.rowsById.get(chatId)
  }

  count(kind: WorkspaceQuery['kind']): number {
    return this.calls.filter((candidate) => candidate === kind).length
  }

  emit(change: WorkspaceChange): void {
    publishPreparedWorkspaceEffect(prepareLocalWorkspaceChange(change).effect)
  }

  async query<Q extends WorkspaceQuery>(
    authority: WorkspaceReadAuthority,
    query: Q,
  ): Promise<ReadEnvelope<WorkspaceQueryResult<Q>>> {
    this.calls.push(query.kind)
    if (
      query.kind !== 'sidebar.catalog-page' &&
      query.kind !== 'sidebar.rows-by-id' &&
      query.kind !== 'folder.list' &&
      query.kind !== 'tag.list' &&
      query.kind !== 'chat.get' &&
      query.kind !== 'branch.open' &&
      query.kind !== 'branch.page-structure' &&
      query.kind !== 'message.presentations'
    ) {
      throw new Error(`UnexpectedSearchQuery:${query.kind}`)
    }
    let value: unknown
    switch (query.kind) {
      case 'sidebar.catalog-page': {
        await this.catalogPageGate
        const offset = query.request.cursor ? Number(query.request.cursor) : 0
        const visibleIds =
          query.request.archived === 'only'
            ? this.archivedIds
            : query.request.archived === 'include'
              ? [...this.liveIds, ...this.archivedIds]
              : this.liveIds
        const limit = query.request.limit ?? visibleIds.length
        const nextOffset = Math.min(visibleIds.length, offset + limit)
        value = {
          rows: visibleIds
            .slice(offset, nextOffset)
            .map((chatId) => this.row(chatId) as ChatSidebarRow),
          ...(nextOffset < visibleIds.length ? { nextCursor: String(nextOffset) } : {}),
          exactCount: visibleIds.length,
        } satisfies ChatSidebarCatalogPage
        break
      }
      case 'sidebar.rows-by-id':
        value = this.rowsByIdHook
          ? await this.rowsByIdHook(query.chatIds)
          : query.chatIds.map((chatId) => this.row(chatId))
        break
      case 'folder.list':
        value = [...this.folders]
        break
      case 'tag.list':
        value = [...this.tags]
        break
      case 'chat.get':
        value = this.mutableChats.get(query.chatId)
        break
      case 'branch.open': {
        const target = this.mutableChats.get(query.chatId)
        const presentations = (this.messagesByChat[query.chatId] ?? []).map((message) => {
          const { header } = splitMessageForStorage(message)
          return { header, message, bodyVersion: header.bodyVersion }
        })
        value = target
          ? {
              kind: 'ready',
              chat: structuredClone(target),
              target: query.target,
              proof: {
                chatId: query.chatId,
                structuralVersion: target.structuralVersion,
                tipId: target.lastUpdatedLeafId,
                pathHeaders: presentations.map((presentation) => presentation.header),
              },
              presentations: [],
            }
          : { kind: 'missing', chatId: query.chatId, target: query.target }
        break
      }
      case 'branch.page-structure': {
        await this.branchPageHook?.(query.chatId)
        await this.branchPageGate
        value = {
          kind: 'ready',
          snapshot: {
            chatId: query.chatId,
            pageHeaders: query.window.nodes,
            pageOffset: query.window.offset,
            pageLimit: query.window.limit,
            branchLength: query.window.branchLength,
          },
        }
        break
      }
      case 'message.presentations': {
        const byId = new Map(
          Object.values(this.messagesByChat)
            .flat()
            .map((message) => {
              const { header } = splitMessageForStorage(message)
              return [message.id, { header, message, bodyVersion: header.bodyVersion }] as const
            }),
        )
        value = query.messageIds.map((messageId) => byId.get(messageId))
        break
      }
    }
    return {
      workspaceId: authority.workspaceId,
      replacementEpoch: authority.replacementEpoch,
      value,
    } as ReadEnvelope<WorkspaceQueryResult<Q>>
  }

  execute(): never {
    throw new Error('SearchRepositoryExecuteUnexpected')
  }

  replace(): never {
    throw new Error('SearchRepositoryReplaceUnexpected')
  }

  subscribeChanges(listener: (change: WorkspaceChange) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

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
    structuralVersion: 1,
    configurationVersion: 0,
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

function sidebarRow(
  overrides: Partial<ChatSidebarRow> & Pick<ChatSidebarRow, 'id'>,
): ChatSidebarRow {
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
    nodeVersion: 1,
    deleted: false,
    ...rest,
  }
}

function chatChanged(chatId: ChatId, commitId: string): WorkspaceChange {
  return {
    kind: 'commit',
    stamp: { ...FENCE, commitId },
    delta: { facts: [], invalidations: [{ kind: 'chat', chatIds: [chatId] }] },
  }
}

function createController(): SearchSessionController {
  const controller = createSearchSessionController()
  controllers.add(controller)
  return controller
}

async function doneWithResults(
  controller: SearchSessionController,
  count: number,
  timeoutMs = 5_000,
): Promise<void> {
  await waitFor(
    () =>
      controller.getSnapshot()?.status === 'done' &&
      controller.getSnapshot()?.results.size === count,
    timeoutMs,
  )
}

async function waitFor(assertion: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (assertion()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('Timed out waiting for search session state')
}
