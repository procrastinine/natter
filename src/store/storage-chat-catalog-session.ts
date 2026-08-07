import { compareSidebarChatRows, type SidebarSortMode } from '../core/sidebar-sort'
import type {
  ChatFolder,
  ChatId,
  ChatSidebarRow,
  ChatTag,
  TokenCalibrationSample,
} from '../core/types'
import type {
  ChatSidebarAggregate,
  ChatSidebarCatalogPage,
  ChatSidebarCatalogRequest,
  ChatTokenCalibrationProjection,
  WorkspaceFence,
} from './repository'
import {
  createTabCatalogSession,
  type NormalizedTabCatalogRequest,
  type TabCatalogChangeImpact,
  type TabCatalogPage,
  type TabCatalogSessionAdapter,
  type TabCatalogSessionController,
  type TabCatalogSessionSnapshot,
} from './tab-catalog-session'
import type { WorkspaceEffect } from './workspace-effect-hub'
import { subscribeWorkspaceEffects, WORKSPACE_EFFECT_RECOVERY_OWNED } from './workspace-effect-hub'
import type {
  ReadEnvelope,
  WorkspaceReadAuthority,
  WorkspaceRepository,
} from './workspace-protocol'
import { getWorkspaceRepository } from './workspace-repository'
import { runWorkspaceRead } from './workspace-runtime'

export interface StorageChatCatalogRow {
  readonly chat: ChatSidebarRow
}

interface StorageChatCatalogSessionRequest extends WorkspaceFence {
  readonly catalog: Omit<
    ChatSidebarCatalogRequest,
    'cursor' | 'pageDirection' | 'limit' | 'countMode'
  >
  readonly pageSize?: number
}

interface StorageChatCatalogPageMeta {
  readonly exactCount: number
  readonly aggregate: ChatSidebarAggregate
  readonly folders: readonly ChatFolder[]
  readonly tags: readonly ChatTag[]
  readonly createdAtGroupCount: number
}

export interface StorageChatCatalogSessionSnapshot extends WorkspaceFence {
  readonly revision: number
  readonly requestKey: string
  readonly status: 'loading' | 'ready' | 'refreshing' | 'error'
  readonly page: {
    readonly rows: readonly ChatSidebarRow[]
    readonly previousCursor?: string
    readonly nextCursor?: string
    readonly exactCount: number
  }
  readonly pageNumber: number
  readonly interactive: boolean
  readonly error: unknown
  readonly aggregate: ChatSidebarAggregate
  readonly folders: readonly ChatFolder[]
  readonly tags: readonly ChatTag[]
  readonly createdAtGroupCount: number
  readonly calibrations: ReadonlyMap<
    ChatId,
    Readonly<Record<string, TokenCalibrationSample>> | undefined
  >
}

interface StorageChatCatalogSourcePage {
  readonly catalog: ChatSidebarCatalogPage
  readonly aggregate?: ChatSidebarAggregate
  readonly folders?: readonly ChatFolder[]
  readonly tags?: readonly ChatTag[]
  readonly createdAtGroupCount?: number
}

export interface StorageChatCatalogSessionSource {
  readonly readPage: (
    request: ChatSidebarCatalogRequest,
    signal: AbortSignal,
  ) => Promise<ReadEnvelope<StorageChatCatalogSourcePage>>
  readonly readRows: (
    chatIds: readonly ChatId[],
    signal: AbortSignal,
  ) => Promise<ReadEnvelope<readonly (StorageChatCatalogRow | undefined)[]>>
  readonly readCalibrations: (
    chatIds: readonly ChatId[],
    signal: AbortSignal,
  ) => Promise<ReadEnvelope<readonly (ChatTokenCalibrationProjection | undefined)[]>>
  readonly readSidebarPage: (
    request: ChatSidebarCatalogRequest,
    signal: AbortSignal,
  ) => Promise<ReadEnvelope<ChatSidebarCatalogPage>>
  readonly subscribeEffects: (
    apply: (effect: WorkspaceEffect) => void,
    recover: (effect: WorkspaceEffect) => void,
  ) => () => void
}

export interface StorageChatCatalogSessionController {
  readonly subscribe: (listener: () => void) => () => void
  readonly getSnapshot: () => StorageChatCatalogSessionSnapshot | null
  readonly request: (request: StorageChatCatalogSessionRequest) => void
  readonly nextPage: () => void
  readonly previousPage: () => void
  readonly loadMore: () => void
  readonly refresh: () => void
  readonly demandCalibrations: (chatIds: readonly ChatId[]) => void
  readonly collectMatchingRows: () => Promise<readonly ChatSidebarRow[]>
  readonly resolveRows: (chatIds: readonly ChatId[]) => Promise<readonly ChatSidebarRow[]>
  readonly dispose: () => void
}

type StorageChatCatalogQuery = Omit<
  ChatSidebarCatalogRequest,
  'cursor' | 'pageDirection' | 'limit' | 'countMode'
>

const DEFAULT_PAGE_SIZE = 200
const MAX_PAGE_SIZE = 500
const COLLECT_PAGE_SIZE = 500

const EMPTY_AGGREGATE: ChatSidebarAggregate = Object.freeze({
  totalCount: 0,
  activeCount: 0,
  archivedCount: 0,
  pinnedCount: 0,
  visibleCount: 0,
  visiblePinnedCount: 0,
  folderCounts: Object.freeze({}),
  folderAggregates: Object.freeze({}),
  rootCount: 0,
  rootVisibleCount: 0,
  rootVisiblePinnedCount: 0,
})

function createWorkspaceSource(repository?: WorkspaceRepository): StorageChatCatalogSessionSource {
  const currentRepository = () => repository ?? getWorkspaceRepository()
  const read = <T>(
    signal: AbortSignal,
    operation: (
      repository: WorkspaceRepository,
      permit: WorkspaceReadAuthority,
    ) => Promise<ReadEnvelope<T>>,
  ) =>
    runWorkspaceRead('repository-query', (permit) => operation(currentRepository(), permit), {
      signal,
    })
  return {
    readPage: (request, signal) =>
      read<StorageChatCatalogSourcePage>(signal, async (workspace, permit) => {
        if (request.countMode === 'omit') {
          const catalog = await workspace.query(
            permit,
            { kind: 'sidebar.catalog-page', request },
            { signal: permit.signal },
          )
          return {
            workspaceId: catalog.workspaceId,
            replacementEpoch: catalog.replacementEpoch,
            value: { catalog: catalog.value },
          }
        }
        const [catalog, aggregate] = await Promise.all([
          workspace.query(
            permit,
            { kind: 'sidebar.catalog-page', request },
            { signal: permit.signal },
          ),
          workspace.query(permit, { kind: 'sidebar.aggregate' }, { signal: permit.signal }),
        ])
        const folderIds = [
          ...new Set(catalog.value.rows.flatMap((chat) => (chat.folderId ? [chat.folderId] : []))),
        ]
        const tagIds = [...new Set(catalog.value.rows.flatMap((chat) => chat.tags))]
        const [folders, tags] = await Promise.all([
          workspace.query(
            permit,
            { kind: 'folder.get-many', folderIds },
            { signal: permit.signal },
          ),
          workspace.query(permit, { kind: 'tag.get-many', tagIds }, { signal: permit.signal }),
        ])
        assertSameFence(catalog, aggregate, folders, tags)
        return {
          workspaceId: catalog.workspaceId,
          replacementEpoch: catalog.replacementEpoch,
          value: {
            catalog: catalog.value,
            aggregate: aggregate.value,
            folders: folders.value.filter((folder) => folder !== undefined),
            tags: tags.value.filter((tag) => tag !== undefined),
            createdAtGroupCount: 0,
          },
        }
      }),
    readRows: (chatIds, signal) =>
      read(signal, async (workspace, permit) => {
        const rows = await workspace.query(
          permit,
          { kind: 'sidebar.rows-by-id', chatIds },
          { signal: permit.signal },
        )
        return {
          workspaceId: rows.workspaceId,
          replacementEpoch: rows.replacementEpoch,
          value: rows.value.map((chat) => (chat ? { chat } : undefined)),
        }
      }),
    readCalibrations: (chatIds, signal) =>
      read(signal, (workspace, permit) =>
        workspace.query(
          permit,
          { kind: 'chat.token-calibrations', chatIds },
          { signal: permit.signal },
        ),
      ),
    readSidebarPage: (request, signal) =>
      read(signal, (workspace, permit) =>
        workspace.query(
          permit,
          { kind: 'sidebar.catalog-page', request },
          { signal: permit.signal },
        ),
      ),
    subscribeEffects: (apply, recover) =>
      subscribeWorkspaceEffects({
        owner: 'storage-chat-catalog-session',
        factKinds: [
          'sidebar-row-changed',
          'sidebar-row-deleted',
          'chat-deleted',
          'conversation-created',
        ],
        impactKinds: ['sidebar', 'chat', 'folder', 'tag'],
        replacements: false,
        apply,
        recover: (_error, effect) => {
          recover(effect)
          return WORKSPACE_EFFECT_RECOVERY_OWNED
        },
      }),
  }
}

export function createStorageChatCatalogSessionController(
  source: StorageChatCatalogSessionSource = createWorkspaceSource(),
): StorageChatCatalogSessionController {
  const core = createTabCatalogSession(storageAdapter(source), source.subscribeEffects)
  return new StorageChatCatalogSessionFacade(core, source)
}

class StorageChatCatalogSessionFacade implements StorageChatCatalogSessionController {
  private readonly core: TabCatalogSessionController<
    StorageChatCatalogSessionRequest,
    StorageChatCatalogRow,
    StorageChatCatalogPageMeta
  >
  private readonly source: StorageChatCatalogSessionSource
  private readonly listeners = new Set<() => void>()
  private readonly onDemandController = new AbortController()
  private readonly stopCore: () => void
  private readonly stopChanges: () => void
  private cachedCore: TabCatalogSessionSnapshot<
    StorageChatCatalogRow,
    StorageChatCatalogPageMeta
  > | null = null
  private cachedPublic: StorageChatCatalogSessionSnapshot | null = null
  private activeRequest: StorageChatCatalogSessionRequest | null = null
  private demandIds: readonly ChatId[] = Object.freeze([])
  private demandKey = ''
  private demandGeneration = 0
  private demandController: AbortController | null = null
  private demandedCalibrations = new Map<
    ChatId,
    Readonly<Record<string, TokenCalibrationSample>> | undefined
  >()
  private disposed = false

  constructor(
    core: TabCatalogSessionController<
      StorageChatCatalogSessionRequest,
      StorageChatCatalogRow,
      StorageChatCatalogPageMeta
    >,
    source: StorageChatCatalogSessionSource,
  ) {
    this.core = core
    this.source = source
    this.stopCore = core.subscribe(() => this.coreChanged())
    this.stopChanges = core.subscribeEffects((effect) => this.demandChanged(effect))
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return () => undefined
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  readonly getSnapshot = (): StorageChatCatalogSessionSnapshot | null => {
    const current = this.core.getSnapshot()
    if (current === this.cachedCore && this.cachedPublic) return this.cachedPublic
    this.cachedCore = current
    this.cachedPublic = current ? publicSnapshot(current, this.demandedCalibrations) : null
    return this.cachedPublic
  }

  request(request: StorageChatCatalogSessionRequest): void {
    this.assertOpen()
    this.activeRequest = request
    this.clearDemand()
    this.core.request(request)
  }

  nextPage(): void {
    this.core.nextPage()
  }

  previousPage(): void {
    this.core.previousPage()
  }

  loadMore(): void {
    this.assertOpen()
    this.core.loadMore()
  }

  refresh(): void {
    this.core.refresh()
  }

  demandCalibrations(chatIds: readonly ChatId[]): void {
    this.assertOpen()
    const ids = Object.freeze([...new Set(chatIds)].sort())
    const key = ids.join('\u0000')
    if (key === this.demandKey) return
    this.demandIds = ids
    this.demandKey = key
    this.startDemandRead()
  }

  async collectMatchingRows(): Promise<readonly ChatSidebarRow[]> {
    this.assertOpen()
    const request = this.activeRequest
    if (!request) return Object.freeze([])
    const rows: ChatSidebarRow[] = []
    let cursor: string | undefined
    let fence: WorkspaceFence | null = null
    do {
      const envelope = await this.source.readSidebarPage(
        {
          ...request.catalog,
          limit: COLLECT_PAGE_SIZE,
          ...(cursor ? { cursor } : {}),
          pageDirection: 'forward',
          countMode: 'omit',
        },
        this.onDemandController.signal,
      )
      if (fence) assertSameFence(fence, envelope)
      fence = envelope
      rows.push(...envelope.value.rows)
      cursor = envelope.value.nextCursor
    } while (cursor)
    return Object.freeze(rows)
  }

  async resolveRows(chatIds: readonly ChatId[]): Promise<readonly ChatSidebarRow[]> {
    this.assertOpen()
    if (chatIds.length === 0) return Object.freeze([])
    const envelope = await this.source.readRows(
      [...new Set(chatIds)],
      this.onDemandController.signal,
    )
    return Object.freeze(
      envelope.value
        .filter((row): row is StorageChatCatalogRow => row !== undefined)
        .map((row) => row.chat),
    )
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.stopCore()
    this.stopChanges()
    this.onDemandController.abort()
    this.core.dispose()
    this.clearDemand()
    this.activeRequest = null
    this.cachedCore = null
    this.cachedPublic = null
    this.listeners.clear()
  }

  private coreChanged(): void {
    const core = this.core.getSnapshot()
    const prior = this.cachedCore
    this.cachedCore = null
    this.cachedPublic = null
    if (!this.core.isOpen()) this.abortDemandRead()
    if (prior && core && !sameFence(prior, core)) {
      this.clearDemand()
      if (this.demandIds.length > 0) this.startDemandRead()
    } else if (core?.interactive && prior?.interactive !== true && this.demandIds.length > 0) {
      this.startDemandRead()
    }
    this.publish()
  }

  private demandChanged(effect: WorkspaceEffect): void {
    if (this.disposed || this.demandIds.length === 0 || effect.kind === 'replace') return
    const current = this.core.getSnapshot()
    if (!current) return
    if (!sameFence(current, effect)) return
    const impact = storageChangeImpact(effect)
    if (
      impact.broad ||
      this.demandIds.some(
        (chatId) => impact.changedIds.has(chatId) || impact.deletedIds.has(chatId),
      )
    ) {
      this.startDemandRead()
    }
  }

  private startDemandRead(): void {
    this.demandController?.abort()
    const ids = this.demandIds
    const current = this.core.getSnapshot()
    if (ids.length === 0 || !current) {
      this.demandedCalibrations.clear()
      this.cachedPublic = null
      this.publish()
      return
    }
    if (!this.core.isOpen() || !current.interactive) return
    const retained = new Map<ChatId, Readonly<Record<string, TokenCalibrationSample>> | undefined>()
    for (const id of ids) {
      if (this.demandedCalibrations.has(id)) retained.set(id, this.demandedCalibrations.get(id))
    }
    this.demandedCalibrations = retained
    const generation = ++this.demandGeneration
    const controller = new AbortController()
    this.demandController = controller
    const read = this.core.track(this.source.readCalibrations(ids, controller.signal))
    void read.then(
      (envelope) => {
        if (
          this.disposed ||
          controller.signal.aborted ||
          generation !== this.demandGeneration ||
          !sameFence(current, envelope)
        ) {
          return
        }
        this.demandController = null
        this.demandedCalibrations = new Map(
          ids.map((id, index) => [id, envelope.value[index]?.tokenCalibration]),
        )
        this.cachedPublic = null
        this.publish()
      },
      () => {
        if (generation === this.demandGeneration) this.demandController = null
      },
    )
  }

  private clearDemand(): void {
    this.abortDemandRead()
    this.demandGeneration += 1
    this.demandIds = Object.freeze([])
    this.demandKey = ''
    this.demandedCalibrations.clear()
    this.cachedPublic = null
  }

  private abortDemandRead(): void {
    this.demandController?.abort()
    this.demandController = null
  }

  private publish(): void {
    for (const listener of [...this.listeners]) listener()
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error('StorageChatCatalogSessionDisposed')
  }
}

function storageAdapter(
  source: StorageChatCatalogSessionSource,
): TabCatalogSessionAdapter<
  StorageChatCatalogSessionRequest,
  StorageChatCatalogQuery,
  StorageChatCatalogRow,
  ChatId,
  StorageChatCatalogPageMeta
> {
  return {
    disposedError: 'StorageChatCatalogSessionDisposed',
    normalize: normalizeRequest,
    requestKey,
    emptyPage: () =>
      Object.freeze({
        rows: Object.freeze([]),
        meta: Object.freeze({
          exactCount: 0,
          aggregate: EMPTY_AGGREGATE,
          folders: Object.freeze([]),
          tags: Object.freeze([]),
          createdAtGroupCount: 0,
        }),
      }),
    readPage: async (query, page, signal) => {
      const envelope = await source.readPage(
        {
          ...query,
          limit: page.limit,
          ...(page.cursor ? { cursor: page.cursor } : {}),
          pageDirection: page.direction,
          countMode: page.previousMeta ? 'omit' : 'exact',
        },
        signal,
      )
      const exactCount = envelope.value.catalog.exactCount ?? page.previousMeta?.exactCount
      if (exactCount === undefined) throw new Error('StorageChatCatalogExactCountMissing')
      const value = protocolPage(envelope.value, exactCount, page.previousMeta)
      return {
        workspaceId: envelope.workspaceId,
        replacementEpoch: envelope.replacementEpoch,
        value,
      }
    },
    evaluate: async (query, ids, signal) => {
      const envelope = await source.readRows(ids, signal)
      return {
        workspaceId: envelope.workspaceId,
        replacementEpoch: envelope.replacementEpoch,
        value: envelope.value.map((row) =>
          row && storageRowMatchesQuery(row.chat, query) ? row : undefined,
        ),
      }
    },
    changeImpact: storageChangeImpact,
    rowId: (row) => row.chat.id,
    cloneRow,
    compareRows,
  }
}

function normalizeRequest(
  request: StorageChatCatalogSessionRequest,
): NormalizedTabCatalogRequest<StorageChatCatalogQuery> {
  const pageSize = Number.isSafeInteger(request.pageSize)
    ? Math.min(MAX_PAGE_SIZE, Math.max(1, request.pageSize as number))
    : DEFAULT_PAGE_SIZE
  const query = Object.freeze({
    ...request.catalog,
    includeFolderIds: Object.freeze([...(request.catalog.includeFolderIds ?? [])].sort()),
    excludeFolderIds: Object.freeze([...(request.catalog.excludeFolderIds ?? [])].sort()),
    includeTagIds: Object.freeze([...(request.catalog.includeTagIds ?? [])].sort()),
    excludeTagIds: Object.freeze([...(request.catalog.excludeTagIds ?? [])].sort()),
  })
  const fence = {
    workspaceId: request.workspaceId,
    replacementEpoch: request.replacementEpoch,
  }
  return {
    ...fence,
    requestKey: requestKey(fence, query, pageSize),
    query,
    pageSize,
  }
}

function requestKey(
  fence: WorkspaceFence,
  query: StorageChatCatalogQuery,
  pageSize: number,
): string {
  return JSON.stringify([fence.workspaceId, fence.replacementEpoch, query, pageSize])
}

function protocolPage(
  page: StorageChatCatalogSourcePage,
  exactCount: number,
  previous: StorageChatCatalogPageMeta | undefined,
): TabCatalogPage<StorageChatCatalogRow, StorageChatCatalogPageMeta> {
  const aggregate = page.aggregate ?? previous?.aggregate
  const folders = page.folders ?? previous?.folders
  const tags = page.tags ?? previous?.tags
  if (!aggregate || !folders || !tags) throw new Error('StorageChatCatalogMetadataMissing')
  return Object.freeze({
    rows: Object.freeze(
      page.catalog.rows.map((chat) => ({
        chat,
      })),
    ),
    ...(page.catalog.previousCursor ? { previousCursor: page.catalog.previousCursor } : {}),
    ...(page.catalog.nextCursor ? { nextCursor: page.catalog.nextCursor } : {}),
    meta: Object.freeze({
      exactCount,
      aggregate,
      folders: Object.freeze([...folders]),
      tags: Object.freeze([...tags]),
      createdAtGroupCount: page.createdAtGroupCount ?? previous?.createdAtGroupCount ?? 0,
    }),
  })
}

function publicSnapshot(
  snapshot: TabCatalogSessionSnapshot<StorageChatCatalogRow, StorageChatCatalogPageMeta>,
  demanded: ReadonlyMap<ChatId, Readonly<Record<string, TokenCalibrationSample>> | undefined>,
): StorageChatCatalogSessionSnapshot {
  const calibrations = new Map(demanded)
  return Object.freeze({
    workspaceId: snapshot.workspaceId,
    replacementEpoch: snapshot.replacementEpoch,
    revision: snapshot.revision,
    requestKey: snapshot.requestKey,
    status: snapshot.status,
    page: Object.freeze({
      rows: Object.freeze(snapshot.page.rows.map((row) => row.chat)),
      ...(snapshot.page.previousCursor ? { previousCursor: snapshot.page.previousCursor } : {}),
      ...(snapshot.page.nextCursor ? { nextCursor: snapshot.page.nextCursor } : {}),
      exactCount: snapshot.page.meta.exactCount,
    }),
    pageNumber: snapshot.pageNumber,
    interactive: snapshot.interactive,
    error: snapshot.error,
    aggregate: snapshot.page.meta.aggregate,
    folders: snapshot.page.meta.folders,
    tags: snapshot.page.meta.tags,
    createdAtGroupCount: snapshot.page.meta.createdAtGroupCount,
    calibrations,
  })
}

function storageChangeImpact(effect: WorkspaceEffect): TabCatalogChangeImpact<ChatId> {
  const changedIds = new Set<ChatId>()
  const deletedIds = new Set<ChatId>()
  if (effect.kind === 'replace') {
    return { relevant: false, broad: false, changedIds, deletedIds }
  }
  let broad = effect.impactByKind === 'all'
  for (const fact of effect.factsByKind['sidebar-row-changed'] ?? []) {
    changedIds.add(fact.chatId)
  }
  for (const fact of effect.factsByKind['conversation-created'] ?? []) {
    changedIds.add(fact.chatId)
  }
  for (const fact of effect.factsByKind['sidebar-row-deleted'] ?? []) {
    deletedIds.add(fact.chatId)
  }
  for (const fact of effect.factsByKind['chat-deleted'] ?? []) deletedIds.add(fact.chatId)
  if (effect.impactByKind !== 'all') {
    if (
      (effect.impactByKind.folder?.length ?? 0) > 0 ||
      (effect.impactByKind.tag?.length ?? 0) > 0 ||
      (effect.impactByKind.workspace?.length ?? 0) > 0
    ) {
      broad = true
    }
    for (const dependency of [
      ...(effect.impactByKind.sidebar ?? []),
      ...(effect.impactByKind.chat ?? []),
    ]) {
      if (!dependency.chatIds) broad = true
      else for (const chatId of dependency.chatIds) changedIds.add(chatId)
    }
  }
  for (const chatId of deletedIds) changedIds.delete(chatId)
  return {
    relevant: broad || changedIds.size > 0 || deletedIds.size > 0,
    broad,
    changedIds,
    deletedIds,
  }
}

function compareRows(
  left: StorageChatCatalogRow,
  right: StorageChatCatalogRow,
  query: StorageChatCatalogQuery,
): number {
  const orderBy = query.orderBy ?? 'updatedAt'
  const direction = query.direction ?? 'desc'
  const mode: SidebarSortMode = `${orderBy}-${direction}`
  return compareSidebarChatRows(left.chat, right.chat, mode, query.pinnedFirst === true)
}

function storageRowMatchesQuery(chat: ChatSidebarRow, query: StorageChatCatalogQuery): boolean {
  const archived = query.archived ?? 'exclude'
  if (archived === 'exclude' && chat.archived) return false
  if (archived === 'only' && !chat.archived) return false
  if (query.excludeEmptyDrafts && (chat.previewText === undefined || chat.previewText === '')) {
    return false
  }
  if (query.folderId !== undefined && chat.folderId !== query.folderId) return false
  const folderId = chat.folderId ?? ''
  const includeFolderIds = new Set(query.includeFolderIds ?? [])
  if (includeFolderIds.size > 0 && !includeFolderIds.has(folderId)) return false
  if (new Set(query.excludeFolderIds ?? []).has(folderId)) return false
  const includeTagIds = new Set(query.includeTagIds ?? [])
  if (includeTagIds.size > 0 && !chat.tags.some((tagId) => includeTagIds.has(tagId))) return false
  const excludeTagIds = new Set(query.excludeTagIds ?? [])
  return !chat.tags.some((tagId) => excludeTagIds.has(tagId))
}

function cloneRow(row: StorageChatCatalogRow): StorageChatCatalogRow {
  return {
    chat: { ...row.chat, tags: [...row.chat.tags] },
  }
}

function assertSameFence(first: WorkspaceFence, ...rest: readonly WorkspaceFence[]): void {
  if (rest.some((item) => !sameFence(first, item))) {
    throw new Error('StorageChatCatalogFenceMismatch')
  }
}

function sameFence(left: WorkspaceFence, right: WorkspaceFence): boolean {
  return left.workspaceId === right.workspaceId && left.replacementEpoch === right.replacementEpoch
}
