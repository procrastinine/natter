import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { ChatId, ChatSidebarRow } from '../../src/core/types'
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

const FENCE = Object.freeze({ workspaceId: 'search-store-workspace', replacementEpoch: 0 })
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

describe('search session state ownership', () => {
  it('crosses the shared input boundary and uses an exact chat delta', async () => {
    const repository = new SearchStateRepository([row('chat-1', 'needle')])
    const controller = createController()
    controller.request({ query: 'needle', repo: repository, debounceMs: 20 })
    expect(controller.getSnapshot()).toMatchObject({
      query: 'needle',
      status: 'debouncing',
      interactive: false,
      results: { size: 0 },
    })
    await doneWithResults(controller, 1)

    repository.setTitle('chat-1', 'other')
    repository.emit(chatChanged('chat-1', 'changed'))
    await doneWithResults(controller, 0)

    expect(repository.count('sidebar.catalog-page')).toBe(1)
    expect(repository.count('sidebar.rows-by-id')).toBe(1)
    expect(repository.calls).not.toContain('branch.page')
  })

  it('owns a replacement query synchronously and debounces only its physical scan', async () => {
    const repository = new SearchStateRepository([row('chat-1', 'needle')])
    const controller = createController()
    controller.request({ query: 'needle', repo: repository, debounceMs: 0 })
    await doneWithResults(controller, 1)
    let releaseCatalog!: () => void
    repository.catalogGate = new Promise<void>((resolve) => {
      releaseCatalog = resolve
    })

    controller.request({ query: 'other', repo: repository, debounceMs: 20 })
    expect(controller.getSnapshot()).toMatchObject({
      query: 'other',
      status: 'debouncing',
      interactive: false,
      results: { size: 0 },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(repository.count('sidebar.catalog-page')).toBe(1)

    releaseCatalog()
    await doneWithResults(controller, 0)
  })

  it('drops a deleted chat immediately and ignores its late in-flight point hit', async () => {
    const repository = new SearchStateRepository([row('chat-1', 'needle')])
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
      const late = ids.map((id) => repository.get(id))
      markPointReadStarted()
      await pointReadGate
      return late
    }

    repository.emit(chatChanged('chat-1', 'rescan'))
    await pointReadStarted
    repository.delete('chat-1')
    repository.emit({
      kind: 'commit',
      stamp: { ...FENCE, commitId: 'delete' },
      delta: {
        facts: [
          { kind: 'chat-deleted', chatId: 'chat-1' },
          { kind: 'sidebar-row-deleted', chatId: 'chat-1' },
        ],
        invalidations: [],
      },
    })
    expect(controller.getSnapshot()?.results.size).toBe(0)
    releasePointRead()
    await doneWithResults(controller, 0)

    expect(controller.getSnapshot()?.results.size).toBe(0)
  })

  it('replaces a repeated hit immutably without changing result order', async () => {
    const repository = new SearchStateRepository([
      row('first', 'needle first'),
      row('second', 'needle second'),
    ])
    const controller = createController()
    controller.request({ query: 'needle', repo: repository, debounceMs: 0 })
    await doneWithResults(controller, 2)
    const initial = controller.getSnapshot()?.results
    if (!initial) throw new Error('missing initial results')

    repository.setTitle('first', 'needle updated')
    repository.emit(chatChanged('first', 'update'))
    await waitFor(
      () => orderedSearchResults(controller.getSnapshot()?.results)[0]?.title === 'needle updated',
    )
    const results = controller.getSnapshot()?.results

    expect(results).not.toBe(initial)
    expect(results?.orderedIds).toEqual(initial.orderedIds)
    expect(results?.orderedIds).not.toBe(initial.orderedIds)
    expect(results?.byChatId).not.toBe(initial.byChatId)
    expect(orderedSearchResults(results)).toMatchObject([
      { chatId: 'first', title: 'needle updated' },
      { chatId: 'second', title: 'needle second' },
    ])
    expect(Object.isFrozen(results?.orderedIds)).toBe(true)
    expect(Object.isFrozen(orderedSearchResults(results))).toBe(true)
  })

  it('removes a miss and appends a later point-rescan hit without disturbing survivors', async () => {
    const repository = new SearchStateRepository([
      row('first', 'needle first'),
      row('second', 'needle second'),
      row('third', 'needle third'),
    ])
    const controller = createController()
    controller.request({ query: 'needle', repo: repository, debounceMs: 0 })
    await doneWithResults(controller, 3)

    repository.setTitle('second', 'other')
    repository.emit(chatChanged('second', 'miss'))
    await doneWithResults(controller, 2)
    expect(orderedSearchResults(controller.getSnapshot()?.results)).toMatchObject([
      { chatId: 'first' },
      { chatId: 'third' },
    ])

    repository.setTitle('second', 'needle later')
    repository.emit(chatChanged('second', 'return'))
    await doneWithResults(controller, 3)
    expect(orderedSearchResults(controller.getSnapshot()?.results)).toMatchObject([
      { chatId: 'first' },
      { chatId: 'third' },
      { chatId: 'second', title: 'needle later' },
    ])
  })

  it('progressively replaces one visible collection during same-fence reconciliation', async () => {
    const repository = new SearchStateRepository([row('chat-1', 'needle')])
    const controller = createController()
    controller.request({ query: 'needle', repo: repository, debounceMs: 0 })
    await doneWithResults(controller, 1)
    let releaseCatalog!: () => void
    repository.catalogGate = new Promise<void>((resolve) => {
      releaseCatalog = resolve
    })

    suspendMountedRepositoryProjections()
    reconcileMountedRepositoryProjections(FENCE)
    expect(controller.getSnapshot()).toMatchObject({
      status: 'debouncing',
      interactive: false,
      results: { size: 1 },
    })
    openMountedRepositoryProjections()
    await waitFor(() => controller.getSnapshot()?.status === 'scanning')
    expect(controller.getSnapshot()).toMatchObject({
      status: 'scanning',
      interactive: true,
      results: { size: 1 },
    })

    releaseCatalog()
    await doneWithResults(controller, 1)
  })

  it('clears old-fence results synchronously on workspace replacement', async () => {
    const repository = new SearchStateRepository([row('chat-1', 'needle')])
    const controller = createController()
    controller.request({ query: 'needle', repo: repository, debounceMs: 0 })
    await doneWithResults(controller, 1)

    suspendMountedRepositoryProjections()
    reconcileMountedRepositoryProjections({ workspaceId: 'replacement', replacementEpoch: 1 })

    expect(controller.getSnapshot()).toMatchObject({
      status: 'debouncing',
      interactive: false,
      results: { size: 0 },
      completedCount: 0,
      candidateCount: 0,
    })
  })

  it('releases the visible result collection when search is aborted', async () => {
    const repository = new SearchStateRepository([row('chat-1', 'needle')])
    const controller = createController()
    controller.request({ query: 'needle', repo: repository, debounceMs: 0 })
    await doneWithResults(controller, 1)

    controller.abort()

    expect(controller.getSnapshot()).toMatchObject({
      status: 'aborted',
      interactive: false,
      results: { size: 0 },
      candidateCount: 0,
      completedCount: 0,
    })
  })
})

class SearchStateRepository implements WorkspaceRepository {
  readonly calls: WorkspaceQuery['kind'][] = []
  readonly listeners = new Set<(change: WorkspaceChange) => void>()
  rowsByIdHook: ((ids: readonly ChatId[]) => Promise<Array<ChatSidebarRow | undefined>>) | null =
    null
  catalogGate: Promise<void> | null = null
  private readonly order: ChatId[]
  private readonly rows = new Map<ChatId, ChatSidebarRow>()

  constructor(rows: readonly ChatSidebarRow[]) {
    this.order = rows.map((candidate) => candidate.id)
    for (const candidate of rows) this.rows.set(candidate.id, candidate)
  }

  get(chatId: ChatId): ChatSidebarRow | undefined {
    return this.rows.get(chatId)
  }

  setTitle(chatId: ChatId, title: string): void {
    const current = this.rows.get(chatId)
    if (!current) throw new Error(`MissingSearchRow:${chatId}`)
    current.title = title
  }

  delete(chatId: ChatId): void {
    this.rows.delete(chatId)
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
      query.kind !== 'tag.list'
    ) {
      throw new Error(`UnexpectedSearchStateQuery:${query.kind}`)
    }
    let value: unknown
    switch (query.kind) {
      case 'sidebar.catalog-page': {
        await this.catalogGate
        const rows = this.order.flatMap((chatId) => {
          const candidate = this.rows.get(chatId)
          return candidate ? [candidate] : []
        })
        value = { rows, exactCount: rows.length } satisfies ChatSidebarCatalogPage
        break
      }
      case 'sidebar.rows-by-id':
        value = this.rowsByIdHook
          ? await this.rowsByIdHook(query.chatIds)
          : query.chatIds.map((chatId) => this.rows.get(chatId))
        break
      case 'folder.list':
      case 'tag.list':
        value = []
        break
    }
    return {
      workspaceId: authority.workspaceId,
      replacementEpoch: authority.replacementEpoch,
      value,
    } as ReadEnvelope<WorkspaceQueryResult<Q>>
  }

  execute(): never {
    throw new Error('SearchStateExecuteUnexpected')
  }

  replace(): never {
    throw new Error('SearchStateReplaceUnexpected')
  }

  subscribeChanges(listener: (change: WorkspaceChange) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

function row(id: ChatId, title: string): ChatSidebarRow {
  return {
    id,
    title,
    titleStatus: 'manual',
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
  throw new Error('Timed out waiting for search state')
}
