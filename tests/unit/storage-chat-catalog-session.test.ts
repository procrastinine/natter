import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, expectTypeOf, it } from 'vitest'
import type {
  ChatFolder,
  ChatId,
  ChatSidebarRow,
  ChatTag,
  TokenCalibrationSample,
} from '../../src/core/types'
import {
  openMountedRepositoryProjections,
  reconcileMountedRepositoryProjections,
  suspendMountedRepositoryProjections,
} from '../../src/store/mounted-projection-lifecycle'
import type {
  ChatSidebarAggregate,
  ChatSidebarCatalogRequest,
  ChatTokenCalibrationProjection,
  SidebarPresentationPage,
  SidebarPresentationRequest,
  WorkspaceFence,
} from '../../src/store/repository'
import {
  createSidebarSessionController,
  type SidebarPresentationSessionSource,
  type SidebarSessionController,
} from '../../src/store/sidebar-session'
import {
  createStorageChatCatalogSessionController,
  type StorageChatCatalogRow,
  type StorageChatCatalogSessionController,
  type StorageChatCatalogSessionSource,
} from '../../src/store/storage-chat-catalog-session'
import { reduceWorkspaceChange, type WorkspaceEffect } from '../../src/store/workspace-effect-hub'
import type { ReadEnvelope, WorkspaceChange } from '../../src/store/workspace-protocol'
import { workspaceRuntimeInternal } from '../../src/store/workspace-runtime'
import type { WorkspaceUsableSurfaceSettlementPort } from '../../src/store/workspace-runtime-control'

const FENCE = Object.freeze({ workspaceId: 'storage-catalog-workspace', replacementEpoch: 0 })
const noSidebarFirstPageSettlement = Object.freeze({
  claim: () => null,
}) satisfies WorkspaceUsableSurfaceSettlementPort<'sidebar-first-page'>
const controllers = new Set<StorageChatCatalogSessionController>()
const sidebarControllers = new Set<SidebarSessionController>()

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
  for (const controller of sidebarControllers) controller.dispose()
  sidebarControllers.clear()
})

describe('storage chat catalog session', () => {
  it('requires an explicit typed first-page settlement capability', () => {
    type Arguments = Parameters<typeof createSidebarSessionController>
    type Dependencies = Arguments[0]
    type AllowsNoArguments = [] extends Arguments ? true : false
    type AllowsMissingSettlement = { source?: Dependencies['source'] } extends Dependencies
      ? true
      : false

    expectTypeOf<AllowsNoArguments>().toEqualTypeOf<false>()
    expectTypeOf<AllowsMissingSettlement>().toEqualTypeOf<false>()
  })

  it('constructs and accepts demand without subscribing or reading before open', async () => {
    suspendMountedRepositoryProjections()
    const source = new SyntheticStorageCatalogSource(20)
    const controller = createController(source)

    controller.request({ ...FENCE, catalog: {}, pageSize: 20 })
    controller.demandCalibrations(['chat-000001'])
    expect(controller.getSnapshot()).toMatchObject({ status: 'loading', interactive: false })
    expect(source.subscriptionCount).toBe(0)
    expect(source.pageReads).toEqual([])
    expect(source.exactCalibrationDemands).toEqual([])

    reconcileMountedRepositoryProjections(FENCE)
    expect(source.subscriptionCount).toBe(0)
    expect(source.pageReads).toEqual([])

    openMountedRepositoryProjections()
    await waitFor(() => controller.getSnapshot()?.status === 'ready')
    await waitFor(() => controller.getSnapshot()?.calibrations.has('chat-000001') === true)
    expect(source.subscriptionCount).toBe(1)
    expect(source.pageReads).toHaveLength(1)
    expect(source.exactCalibrationDemands).toEqual([['chat-000001']])
  })

  it('has no whole-chat Storage catalog query or generic retained-query owner', () => {
    const application = readFileSync(
      resolve(process.cwd(), 'src/store/storage-application.ts'),
      'utf8',
    )
    const hook = readFileSync(
      resolve(process.cwd(), 'src/hooks/useStorageCatalogApplication.ts'),
      'utf8',
    )
    expect(application).not.toContain('readStorageChatCatalogModel')
    expect(application).not.toContain('listChatSidebarRows')
    expect(application).not.toContain('listChats')
    expect(hook).not.toContain("'storage-chat-model'")
  })

  it('keeps catalog/session wall-clock scheduling in the one input debounce owner', () => {
    const store = resolve(process.cwd(), 'src/store')
    const candidates = readdirSync(store).filter(
      (name) =>
        name.endsWith('-session.ts') ||
        name.includes('catalog') ||
        name === 'storage-application.ts' ||
        name === 'catalog-application.ts',
    )
    const timerOwners = candidates.filter((name) =>
      /\b(?:setTimeout|setInterval)\s*\(/u.test(readFileSync(resolve(store, name), 'utf8')),
    )
    expect(timerOwners).toEqual(['catalog-query-transition.ts'])
    const transitions = readFileSync(resolve(store, 'catalog-query-transition.ts'), 'utf8')
    expect(transitions.match(/\bsetTimeout\s*\(/gu)).toHaveLength(1)
    const search = readFileSync(resolve(store, 'search-session.ts'), 'utf8')
    expect(search).not.toMatch(/\bsetTimeout\s*\(/u)
    expect(search).toContain('const SEARCH_DEBOUNCE_MS = 150')
    expect(search).toContain('queueMicrotask')
  })

  it('retains one compact keyset page instead of the visited or full catalog', async () => {
    const source = new SyntheticStorageCatalogSource(100_000)
    const controller = createController(source)

    controller.request({
      ...FENCE,
      catalog: { orderBy: 'updatedAt', direction: 'desc', excludeEmptyDrafts: true },
      pageSize: 200,
    })

    await waitFor(() => controller.getSnapshot()?.status === 'ready')
    expect(controller.getSnapshot()?.page).toMatchObject({ exactCount: 100_000 })
    expect(controller.getSnapshot()?.page.rows).toHaveLength(200)
    expect(source.pageReads).toEqual([{ cursor: undefined, limit: 200, countMode: 'exact' }])
    expect(source.exactCalibrationDemands).toEqual([])

    controller.nextPage()
    await waitFor(() => controller.getSnapshot()?.pageNumber === 1)

    const snapshot = controller.getSnapshot()
    expect(snapshot?.page.rows).toHaveLength(200)
    expect(snapshot?.page.rows[0]?.id).toBe('chat-000200')
    expect(snapshot?.calibrations.size).toBe(0)
    expect(source.pageReads).toHaveLength(2)
    expect(source.pageReads[1]?.countMode).toBe('omit')
  })

  it('loads calibration only for the page and exact visible search demand', async () => {
    const source = new SyntheticStorageCatalogSource(1_000)
    const controller = createController(source)
    controller.request({ ...FENCE, catalog: {}, pageSize: 50 })
    await waitFor(() => controller.getSnapshot()?.status === 'ready')

    controller.demandCalibrations(['chat-000777'])
    await waitFor(() => controller.getSnapshot()?.calibrations.has('chat-000777') === true)

    expect(source.exactCalibrationDemands).toEqual([['chat-000777']])
    expect(controller.getSnapshot()?.calibrations.size).toBe(1)

    controller.demandCalibrations([])
    await waitFor(() => controller.getSnapshot()?.calibrations.size === 0)
  })

  it('collects all matching compact rows only when an explicit bulk action asks for them', async () => {
    const source = new SyntheticStorageCatalogSource(1_205)
    const controller = createController(source)
    controller.request({ ...FENCE, catalog: { archived: 'include' }, pageSize: 100 })
    await waitFor(() => controller.getSnapshot()?.status === 'ready')

    expect(source.collectReads).toEqual([])
    const rows = await controller.collectMatchingRows()

    expect(rows).toHaveLength(1_205)
    expect(source.collectReads.map((read) => read.limit)).toEqual([500, 500, 500])
    expect(source.collectReads.every((read) => read.countMode === 'omit')).toBe(true)
    expect(controller.getSnapshot()?.page.rows).toHaveLength(100)
  })

  it('cancels an explicit bulk collection when its catalog session is disposed', async () => {
    const source = new SyntheticStorageCatalogSource(1_205)
    const controller = createController(source)
    controller.request({ ...FENCE, catalog: {}, pageSize: 100 })
    await waitFor(() => controller.getSnapshot()?.status === 'ready')
    const release = source.blockNextCollectRead()

    const collecting = controller.collectMatchingRows()
    await waitFor(() => source.collectSignals.length === 1)
    controller.dispose()

    expect(source.collectSignals[0]?.aborted).toBe(true)
    release()
    await expect(collecting).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('point-reads a changed demanded row and drops it when it no longer matches', async () => {
    const source = new SyntheticStorageCatalogSource(20)
    const controller = createController(source)
    controller.request({
      ...FENCE,
      catalog: { archived: 'exclude', excludeEmptyDrafts: true },
      pageSize: 20,
    })
    await waitFor(() => controller.getSnapshot()?.status === 'ready')

    source.archived.add('chat-000005')
    source.emit({
      kind: 'invalidate',
      ...FENCE,
      dependencies: [{ kind: 'chat', chatIds: ['chat-000005'] }],
    })

    await waitFor(() => source.pointReads.length > 0)
    expect(source.pointReads).toEqual([['chat-000005']])
    await waitFor(
      () => controller.getSnapshot()?.page.rows.every((row) => row.id !== 'chat-000005') === true,
    )
  })

  it('maps ordinary tab intent to one pinned-first bounded catalog session', async () => {
    const source = new SyntheticSidebarPresentationSource(1_000)
    const sidebar = createSidebarSessionController({
      source,
      firstPageSettlement: noSidebarFirstPageSettlement,
    })
    sidebarControllers.add(sidebar)

    sidebar.request({
      ...FENCE,
      mode: 'expanded',
      sort: 'createdAt-asc',
      collapsedFolderIds: ['folder-collapsed'],
      pageSize: 40,
      createdAtGroupBoundaries: [100, 90, 40, -190],
    })
    await waitFor(() => sidebar.getSnapshot()?.status === 'ready')

    expect(source.requests[0]).toMatchObject({
      mode: 'expanded',
      sort: 'createdAt-asc',
      collapsedFolderIds: ['folder-collapsed'],
      limit: 40,
      countMode: 'exact',
    })
    expect(sidebar.getSnapshot()?.page.rows).toHaveLength(40)

    sidebar.loadMore()
    await waitFor(() => (sidebar.getSnapshot()?.page.rows.length ?? 0) > 40)
    expect(sidebar.getSnapshot()?.page.rows).toHaveLength(80)
  })

  it('ignores last-viewed effects unless the mounted sidebar sorts by last viewed', async () => {
    const source = new SyntheticSidebarPresentationSource(20)
    const sidebar = createSidebarSessionController({
      source,
      firstPageSettlement: noSidebarFirstPageSettlement,
    })
    sidebarControllers.add(sidebar)
    const request = {
      ...FENCE,
      mode: 'expanded' as const,
      collapsedFolderIds: [],
      pageSize: 20,
      createdAtGroupBoundaries: [100, 90, 40, -190] as const,
    }

    sidebar.request({ ...request, sort: 'updatedAt-desc' })
    await waitFor(() => sidebar.getSnapshot()?.status === 'ready')
    source.emit(lastViewedChange('viewed-while-sorted-by-update'))
    expect(source.requests).toHaveLength(1)

    sidebar.request({ ...request, sort: 'lastViewedAt-desc' })
    await waitFor(() => sidebar.getSnapshot()?.status === 'ready')
    expect(source.requests).toHaveLength(2)
    source.emit(lastViewedChange('viewed-while-sorted-by-view'))
    expect(source.requests).toHaveLength(3)
    await waitFor(() => sidebar.getSnapshot()?.status === 'ready')
  })

  it('settles only terminal first-page publications with their exact outcome', async () => {
    for (const scenario of [
      { count: 1, expected: 'ready' as const },
      { count: 0, expected: 'empty' as const },
      { count: 1, expected: 'error' as const },
    ]) {
      const sidebarSource = new SyntheticSidebarPresentationSource(scenario.count)
      if (scenario.expected === 'error') {
        sidebarSource.failNextPage(new Error('sidebar-page-failed'))
      }
      const settlements: Array<{
        fence: WorkspaceFence
        outcome: 'ready' | 'empty' | 'error'
      }> = []
      const sidebar = createSidebarSessionController({
        source: sidebarSource,
        firstPageSettlement: {
          claim: (fence) => ({
            settle: (outcome) => {
              settlements.push({ fence, outcome })
              return true
            },
          }),
        },
      })
      sidebarControllers.add(sidebar)

      sidebar.request({
        ...FENCE,
        mode: 'expanded',
        sort: 'updatedAt-desc',
        collapsedFolderIds: [],
        pageSize: 20,
        createdAtGroupBoundaries: [100, 90, 40, -190],
      })
      expect(settlements).toEqual([])
      await waitFor(() => {
        const status = sidebar.getSnapshot()?.status
        return status === 'ready' || status === 'error'
      })
      expect(settlements).toEqual([{ fence: FENCE, outcome: scenario.expected }])
      expect(sidebarSource.pageReads).toHaveLength(1)
      sidebar.dispose()
      sidebarControllers.delete(sidebar)
    }
  })

  it('joins an identical terminal request without another repository read', async () => {
    const source = new SyntheticSidebarPresentationSource(1)
    const settlements: Array<{ fence: WorkspaceFence; outcome: 'ready' | 'empty' | 'error' }> = []

    const sidebar = createSidebarSessionController({
      source,
      firstPageSettlement: {
        claim: (fence) => ({
          settle: (outcome) => {
            settlements.push({ fence, outcome })
            return true
          },
        }),
      },
    })
    sidebarControllers.add(sidebar)
    const request = {
      ...FENCE,
      mode: 'expanded' as const,
      sort: 'updatedAt-desc' as const,
      collapsedFolderIds: [],
      pageSize: 20,
      createdAtGroupBoundaries: [100, 90, 40, -190] as const,
    }
    sidebar.request(request)
    await waitFor(() => sidebar.getSnapshot()?.status === 'ready')
    expect(settlements).toEqual([{ fence: FENCE, outcome: 'ready' }])
    expect(source.pageReads).toHaveLength(1)
    sidebar.request(request)
    await Promise.resolve()
    expect(source.pageReads).toHaveLength(1)
  })

  it('retains one monotonic row demand across in-flight loads and same-size query changes', async () => {
    const source = new SyntheticSidebarPresentationSource(1_000)
    const sidebar = createSidebarSessionController({
      source,
      firstPageSettlement: noSidebarFirstPageSettlement,
    })
    sidebarControllers.add(sidebar)

    sidebar.request({
      ...FENCE,
      mode: 'expanded',
      sort: 'createdAt-asc',
      collapsedFolderIds: [],
      pageSize: 40,
      createdAtGroupBoundaries: [100, 90, 40, -190],
    })
    await waitFor(() => sidebar.getSnapshot()?.status === 'ready')

    const release = source.blockNextPageRead()
    sidebar.loadMore()
    await waitFor(() => source.pageReads.length === 2)
    sidebar.loadMore()
    release()

    await waitFor(
      () =>
        sidebar.getSnapshot()?.status === 'ready' &&
        sidebar.getSnapshot()?.page.rows.length === 160,
    )
    expect(source.pageReads.map((read) => read.limit)).toEqual([40, 40, 40, 40])

    sidebar.request({
      ...FENCE,
      mode: 'expanded',
      sort: 'createdAt-desc',
      collapsedFolderIds: [],
      pageSize: 40,
      createdAtGroupBoundaries: [100, 90, 40, -190],
    })
    expect(sidebar.getSnapshot()).toMatchObject({ status: 'loading' })
    expect(sidebar.getSnapshot()?.page.rows).toHaveLength(160)
    await waitFor(
      () =>
        sidebar.getSnapshot()?.status === 'ready' &&
        sidebar.getSnapshot()?.page.rows.length === 160,
    )
    expect(source.pageReads.map((read) => read.limit)).toEqual([40, 40, 40, 40, 40, 40, 40, 40])
    expect(source.pageReads.map((read) => read.countMode)).toEqual([
      'exact',
      'omit',
      'omit',
      'omit',
      'exact',
      'omit',
      'omit',
      'omit',
    ])

    sidebar.refresh()
    await waitFor(() => source.pageReads.length === 12)
    expect(source.pageReads.slice(8).map((read) => read.countMode)).toEqual([
      'exact',
      'omit',
      'omit',
      'omit',
    ])
  })

  it('reuses mounted metadata for chat-only refreshes and invalidates exact affected buckets', async () => {
    const source = new SyntheticSidebarPresentationSource(1, true)
    const sidebar = createSidebarSessionController({
      source,
      firstPageSettlement: noSidebarFirstPageSettlement,
    })
    sidebarControllers.add(sidebar)
    sidebar.request({
      ...FENCE,
      mode: 'expanded',
      sort: 'updatedAt-desc',
      collapsedFolderIds: [],
      pageSize: 20,
      createdAtGroupBoundaries: [100, 90, 40, -190],
    })
    await waitFor(() => sidebar.getSnapshot()?.status === 'ready')
    expect(sidebar.getSnapshot()?.page.meta.tags.map((tag) => tag.id)).toEqual(['visible-tag'])
    expect(sidebar.getSnapshot()?.page.meta.folders.map((folder) => folder.id)).toEqual([
      'visible-folder',
    ])

    source.emit({
      kind: 'invalidate',
      ...FENCE,
      dependencies: [{ kind: 'chat', chatIds: ['chat-000000'] }],
    })
    await waitFor(() => source.requests.length === 2 && sidebar.getSnapshot()?.status === 'ready')
    expect(source.requests[1]?.knownTagIds).toEqual(['visible-tag'])
    expect(source.requests[1]?.knownFolderIds).toEqual(['visible-folder'])
    expect(sidebar.getSnapshot()?.page.meta.tags.map((tag) => tag.id)).toEqual(['visible-tag'])

    source.emit({
      kind: 'invalidate',
      ...FENCE,
      dependencies: [{ kind: 'tag', tagIds: ['visible-tag'] }],
    })
    await waitFor(() => source.requests.length === 3 && sidebar.getSnapshot()?.status === 'ready')
    expect(source.requests[2]?.knownTagIds).toEqual([])
    expect(source.requests[2]?.knownFolderIds).toEqual(['visible-folder'])
    expect(sidebar.getSnapshot()?.page.meta.tags.map((tag) => tag.id)).toEqual(['visible-tag'])

    source.emit({
      kind: 'invalidate',
      ...FENCE,
      dependencies: [{ kind: 'folder', folderIds: ['visible-folder'] }],
    })
    await waitFor(() => source.requests.length === 4 && sidebar.getSnapshot()?.status === 'ready')
    expect(source.requests[3]?.knownTagIds).toEqual(['visible-tag'])
    expect(source.requests[3]?.knownFolderIds).toEqual([])
    expect(sidebar.getSnapshot()?.page.meta.folders.map((folder) => folder.id)).toEqual([
      'visible-folder',
    ])
  })
})

class SyntheticStorageCatalogSource implements StorageChatCatalogSessionSource {
  readonly catalogRequests: ChatSidebarCatalogRequest[] = []
  readonly pageReads: Array<{
    cursor: string | undefined
    limit: number
    countMode: ChatSidebarCatalogRequest['countMode']
  }> = []
  readonly collectReads: Array<{
    cursor: string | undefined
    limit: number
    countMode: ChatSidebarCatalogRequest['countMode']
  }> = []
  readonly collectSignals: AbortSignal[] = []
  readonly exactCalibrationDemands: ChatId[][] = []
  readonly pointReads: ChatId[][] = []
  readonly archived = new Set<ChatId>()
  private readonly listeners = new Set<{
    apply: (effect: WorkspaceEffect) => void
    recover: (effect: WorkspaceEffect) => void
  }>()
  private readonly count: number
  private nextPageReadGate: Promise<void> | null = null
  private nextCollectReadGate: Promise<void> | null = null
  private nextPageFailure: Error | null = null

  get subscriptionCount(): number {
    return this.listeners.size
  }

  constructor(count: number) {
    this.count = count
  }

  async readPage(request: ChatSidebarCatalogRequest) {
    this.catalogRequests.push({ ...request })
    const start = cursorOffset(request.cursor)
    const limit = request.limit ?? 100
    this.pageReads.push({ cursor: request.cursor, limit, countMode: request.countMode })
    const gate = this.nextPageReadGate
    this.nextPageReadGate = null
    if (gate) await gate
    const failure = this.nextPageFailure
    this.nextPageFailure = null
    if (failure) throw failure
    const rows = this.page(start, limit).filter((row) => this.matches(row, request))
    return envelope({
      catalog: {
        rows,
        ...(start > 0 ? { previousCursor: cursor(Math.max(0, start - limit)) } : {}),
        ...(start + limit < this.count ? { nextCursor: cursor(start + limit) } : {}),
        exactCount: this.count,
      },
      aggregate: aggregate(this.count),
      folders: [],
      tags: [],
    })
  }

  async readRows(chatIds: readonly ChatId[]) {
    this.pointReads.push([...chatIds])
    return envelope(
      chatIds.map((id): StorageChatCatalogRow | undefined => {
        const index = Number(id.slice('chat-'.length))
        if (!Number.isSafeInteger(index) || index < 0 || index >= this.count) return undefined
        return { chat: this.row(index) }
      }),
    )
  }

  async readCalibrations(chatIds: readonly ChatId[]) {
    this.exactCalibrationDemands.push([...chatIds])
    return envelope(chatIds.map((chatId) => calibration(chatId)))
  }

  async readSidebarPage(request: ChatSidebarCatalogRequest, signal: AbortSignal) {
    const start = cursorOffset(request.cursor)
    const limit = request.limit ?? 100
    this.collectReads.push({ cursor: request.cursor, limit, countMode: request.countMode })
    this.collectSignals.push(signal)
    const gate = this.nextCollectReadGate
    this.nextCollectReadGate = null
    if (gate) await gate
    if (signal.aborted) throw signal.reason
    const rows = this.page(start, limit).filter((row) => this.matches(row, request))
    return envelope({
      rows,
      ...(start > 0 ? { previousCursor: cursor(Math.max(0, start - limit)) } : {}),
      ...(start + limit < this.count ? { nextCursor: cursor(start + limit) } : {}),
      exactCount: this.count,
    })
  }

  readonly subscribeEffects = (
    apply: (effect: WorkspaceEffect) => void,
    recover: (effect: WorkspaceEffect) => void,
  ): (() => void) => {
    const listener = { apply, recover }
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(change: WorkspaceChange): void {
    const effect = reduceWorkspaceChange(change, 'remote')
    for (const listener of [...this.listeners]) listener.apply(effect)
  }

  blockNextPageRead(): () => void {
    let release: () => void = () => undefined
    this.nextPageReadGate = new Promise<void>((resolve) => {
      release = resolve
    })
    return release
  }

  failNextPage(error: Error): void {
    this.nextPageFailure = error
  }

  blockNextCollectRead(): () => void {
    let release: () => void = () => undefined
    this.nextCollectReadGate = new Promise<void>((resolve) => {
      release = resolve
    })
    return release
  }

  private page(start: number, limit: number): ChatSidebarRow[] {
    const end = Math.min(this.count, start + limit)
    return Array.from({ length: end - start }, (_, offset) => this.row(start + offset))
  }

  private row(index: number): ChatSidebarRow {
    return {
      id: chatId(index),
      title: `Chat ${index}`,
      titleStatus: 'manual',
      createdAt: index,
      updatedAt: this.count - index,
      lastViewedAt: index,
      wordCount: index,
      totalCostUsd: 0,
      lastUpdatedLeafId: null,
      lastBranchUpdatedAt: index,
      archived: this.archived.has(chatId(index)),
      pinned: false,
      folderId: null,
      tags: [],
      previewText: `Preview ${index}`,
    }
  }

  private matches(row: ChatSidebarRow, request: ChatSidebarCatalogRequest): boolean {
    if ((request.archived ?? 'exclude') === 'exclude' && row.archived) return false
    if (request.archived === 'only' && !row.archived) return false
    return !request.excludeEmptyDrafts || Boolean(row.previewText)
  }
}

class SyntheticSidebarPresentationSource implements SidebarPresentationSessionSource {
  readonly requests: SidebarPresentationRequest[] = []
  readonly pageReads: Array<{
    cursor: string | undefined
    limit: number
    countMode: SidebarPresentationRequest['countMode']
  }> = []
  private nextPageReadGate: Promise<void> | null = null
  private nextPageFailure: Error | null = null
  private readonly count: number
  private readonly withMetadata: boolean
  private readonly listeners = new Set<{
    apply: (effect: WorkspaceEffect) => void
    recover: (effect: WorkspaceEffect) => void
  }>()
  private readonly folder: ChatFolder = {
    id: 'visible-folder',
    name: 'Visible folder',
    sortIndex: 0,
    createdAt: 1,
    updatedAt: 1,
  }
  private readonly tag: ChatTag = {
    id: 'visible-tag',
    name: 'Visible tag',
    nameLower: 'visible tag',
    createdAt: 1,
    updatedAt: 1,
  }

  constructor(count: number, withMetadata = false) {
    this.count = count
    this.withMetadata = withMetadata
  }

  async readPage(
    request: SidebarPresentationRequest,
    _signal: AbortSignal,
  ): Promise<ReadEnvelope<SidebarPresentationPage>> {
    this.requests.push({ ...request })
    const start = cursorOffset(request.cursor)
    const limit = request.limit ?? 100
    this.pageReads.push({ cursor: request.cursor, limit, countMode: request.countMode })
    const gate = this.nextPageReadGate
    this.nextPageReadGate = null
    if (gate) await gate
    const failure = this.nextPageFailure
    this.nextPageFailure = null
    if (failure) throw failure
    const end = Math.min(this.count, start + limit)
    const rows = Array.from({ length: end - start }, (_, offset) => {
      const chat = this.row(start + offset)
      return {
        kind: 'chat' as const,
        key: `entry:chat:${chat.id}`,
        chat,
        depth: 'root' as const,
      }
    })
    return envelope({
      rows,
      ...(end < this.count ? { nextCursor: cursor(end) } : {}),
      ...(request.countMode === 'exact'
        ? {
            exactTotalRows: this.count,
            exactVisibleChats: this.count,
            aggregate: aggregate(this.count),
            folders:
              this.withMetadata && !request.knownFolderIds?.includes(this.folder.id)
                ? [this.folder]
                : [],
            tags:
              this.withMetadata && !request.knownTagIds?.includes(this.tag.id) ? [this.tag] : [],
          }
        : {}),
      measurement: {
        rootChatRowsRead: rows.length,
        folderChildRowsRead: 0,
        folderCatalogRowsRead: 0,
        tagCatalogRowsRead: 0,
        createdAtGroupProbeQueries: 0,
        createdAtGroupProbeKeysRead: 0,
      },
    })
  }

  readonly subscribeEffects = (
    apply: (effect: WorkspaceEffect) => void,
    recover: (effect: WorkspaceEffect) => void,
  ): (() => void) => {
    const listener = { apply, recover }
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(change: WorkspaceChange): void {
    const effect = reduceWorkspaceChange(change, 'remote')
    for (const listener of [...this.listeners]) listener.apply(effect)
  }

  blockNextPageRead(): () => void {
    let release: () => void = () => undefined
    this.nextPageReadGate = new Promise<void>((resolve) => {
      release = resolve
    })
    return release
  }

  failNextPage(error: Error): void {
    this.nextPageFailure = error
  }

  private row(index: number): ChatSidebarRow {
    return {
      id: chatId(index),
      title: `Chat ${index}`,
      titleStatus: 'manual',
      createdAt: index,
      updatedAt: this.count - index,
      lastViewedAt: index,
      wordCount: index,
      totalCostUsd: 0,
      lastUpdatedLeafId: null,
      lastBranchUpdatedAt: index,
      archived: false,
      pinned: false,
      folderId: this.withMetadata ? this.folder.id : null,
      tags: this.withMetadata ? [this.tag.id] : [],
      previewText: `Preview ${index}`,
    }
  }
}

function calibration(chatId: ChatId): ChatTokenCalibrationProjection {
  const tokenCalibration: Record<string, TokenCalibrationSample> = {
    family: {
      totalTextChars: 400,
      totalTextTokens: 100,
      sampleCount: 1,
      updatedAt: 1,
    },
  }
  return { chatId, tokenCalibration }
}

function aggregate(count: number): ChatSidebarAggregate {
  return {
    totalCount: count,
    activeCount: count,
    archivedCount: 0,
    pinnedCount: 0,
    visibleCount: count,
    visiblePinnedCount: 0,
    folderCounts: {},
    folderAggregates: {},
    rootCount: count,
    rootVisibleCount: count,
    rootVisiblePinnedCount: 0,
  }
}

function chatId(index: number): ChatId {
  return `chat-${index.toString().padStart(6, '0')}`
}

function cursor(offset: number): string {
  return `offset:${offset}`
}

function cursorOffset(value: string | undefined): number {
  return value ? Number(value.slice('offset:'.length)) : 0
}

function envelope<T>(value: T): ReadEnvelope<T> {
  return { ...FENCE, value }
}

function lastViewedChange(commitId: string): WorkspaceChange {
  return {
    kind: 'commit',
    stamp: { ...FENCE, commitId },
    delta: {
      facts: [
        {
          kind: 'sidebar-row-changed',
          chatId: 'chat-000000',
          facets: ['last-viewed'],
        },
      ],
      invalidations: [
        { kind: 'chat', chatIds: ['chat-000000'] },
        { kind: 'sidebar', chatIds: ['chat-000000'] },
      ],
    },
  }
}

async function waitFor(assertion: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now()
  while (!assertion()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('TimedOut')
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function createController(
  source: StorageChatCatalogSessionSource,
): StorageChatCatalogSessionController {
  const controller = createStorageChatCatalogSessionController(source)
  controllers.add(controller)
  return controller
}
