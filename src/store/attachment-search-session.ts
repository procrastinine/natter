import type { AttachmentId } from '../core/types'
import {
  type CatalogQueryTransitionScheduler,
  createCatalogQueryTransitionScheduler,
} from './catalog-query-transition'
import type {
  AttachmentCatalogPage,
  AttachmentCatalogRow,
  AttachmentCatalogSearchRequest,
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
import type { ReadEnvelope, WorkspaceRepository } from './workspace-protocol'
import { getWorkspaceRepository } from './workspace-repository'
import { runWorkspaceRead } from './workspace-runtime'

type AttachmentSearchSessionStatus = 'idle' | 'loading' | 'ready' | 'refreshing' | 'error'

interface AttachmentSearchSessionRequest extends WorkspaceFence {
  readonly search: Omit<AttachmentCatalogSearchRequest, 'cursor' | 'direction' | 'limit'>
  readonly pageSize?: number
}

export interface AttachmentSearchSessionSnapshot extends WorkspaceFence {
  readonly revision: number
  readonly requestKey: string
  readonly status: AttachmentSearchSessionStatus
  readonly rows: readonly AttachmentCatalogRow[]
  readonly interactive: boolean
  readonly pageNumber: number
  readonly previousCursor?: string
  readonly nextCursor?: string
  readonly matchedCount?: number
  readonly complete: boolean
  readonly error: unknown
}

export interface AttachmentSearchSessionSource {
  readonly readPage: (
    search: AttachmentCatalogSearchRequest,
    signal: AbortSignal,
  ) => Promise<ReadEnvelope<AttachmentCatalogPage>>
  readonly evaluate: (
    search: AttachmentCatalogSearchRequest,
    attachmentIds: readonly AttachmentId[],
    signal: AbortSignal,
  ) => Promise<ReadEnvelope<readonly (AttachmentCatalogRow | undefined)[]>>
  readonly subscribeEffects: (
    apply: (effect: WorkspaceEffect) => void,
    recover: (effect: WorkspaceEffect) => void,
  ) => () => void
}

export interface AttachmentSearchSessionController {
  readonly subscribe: (listener: () => void) => () => void
  readonly getSnapshot: () => AttachmentSearchSessionSnapshot | null
  readonly request: (request: AttachmentSearchSessionRequest) => () => void
  readonly loadMore: () => void
  readonly nextPage: () => void
  readonly previousPage: () => void
  readonly refresh: () => void
  readonly dispose: () => void
}

type AttachmentSearchQuery = Omit<AttachmentCatalogSearchRequest, 'cursor' | 'direction' | 'limit'>

interface AttachmentSearchPageMeta {
  readonly matchedCount?: number
  readonly complete: boolean
}

const DEFAULT_PAGE_SIZE = 100
const MAX_PAGE_SIZE = 500
const ATTACHMENT_SEARCH_DEBOUNCE_MS = 150

function createWorkspaceAttachmentSearchSource(
  repository?: WorkspaceRepository,
): AttachmentSearchSessionSource {
  const currentRepository = () => repository ?? getWorkspaceRepository()
  return {
    readPage: (search, signal) =>
      runWorkspaceRead(
        'repository-query',
        (permit) =>
          currentRepository().query(
            permit,
            { kind: 'attachment.catalog-page', search },
            { signal: permit.signal },
          ),
        { signal },
      ),
    evaluate: (search, attachmentIds, signal) =>
      runWorkspaceRead(
        'repository-query',
        (permit) =>
          currentRepository().query(
            permit,
            { kind: 'attachment.catalog-evaluate', search, attachmentIds },
            { signal: permit.signal },
          ),
        { signal },
      ),
    subscribeEffects: (apply, recover) =>
      subscribeWorkspaceEffects({
        owner: 'attachment-search-session',
        factKinds: ['attachment-row-changed', 'attachment-row-deleted'],
        impactKinds: ['attachment', 'attachment-job'],
        replacements: false,
        apply,
        recover: (_error, effect) => {
          recover(effect)
          return WORKSPACE_EFFECT_RECOVERY_OWNED
        },
      }),
  }
}

export function createAttachmentSearchSessionController(
  source: AttachmentSearchSessionSource = createWorkspaceAttachmentSearchSource(),
): AttachmentSearchSessionController {
  const adapter = attachmentSearchAdapter(source)
  const core = createTabCatalogSession(adapter, source.subscribeEffects)
  return new AttachmentSearchSessionFacade(core)
}

class AttachmentSearchSessionFacade implements AttachmentSearchSessionController {
  private readonly core: TabCatalogSessionController<
    AttachmentSearchSessionRequest,
    AttachmentCatalogRow,
    AttachmentSearchPageMeta
  >
  private cachedCore: TabCatalogSessionSnapshot<
    AttachmentCatalogRow,
    AttachmentSearchPageMeta
  > | null = null
  private cachedPublic: AttachmentSearchSessionSnapshot | null = null
  private readonly queryTransitions: CatalogQueryTransitionScheduler<AttachmentSearchSessionRequest>
  constructor(
    core: TabCatalogSessionController<
      AttachmentSearchSessionRequest,
      AttachmentCatalogRow,
      AttachmentSearchPageMeta
    >,
  ) {
    this.core = core
    this.queryTransitions = createCatalogQueryTransitionScheduler((request) =>
      this.core.request(request),
    )
  }

  readonly subscribe = (listener: () => void): (() => void) => this.core.subscribe(listener)

  readonly getSnapshot = (): AttachmentSearchSessionSnapshot | null => {
    const current = this.core.getSnapshot()
    if (current === this.cachedCore) return this.cachedPublic
    this.cachedCore = current
    this.cachedPublic = current ? publicSnapshot(current) : null
    return this.cachedPublic
  }

  request(request: AttachmentSearchSessionRequest): () => void {
    return this.queryTransitions.schedule(request, {
      debounceKey: request.search.query?.trim() || null,
      debounceMs: ATTACHMENT_SEARCH_DEBOUNCE_MS,
    })
  }

  loadMore(): void {
    this.core.loadMore()
  }

  nextPage(): void {
    this.core.nextPage()
  }

  previousPage(): void {
    this.core.previousPage()
  }

  refresh(): void {
    this.core.refresh()
  }

  dispose(): void {
    this.queryTransitions.dispose()
    this.core.dispose()
    this.cachedCore = null
    this.cachedPublic = null
  }
}

function attachmentSearchAdapter(
  source: AttachmentSearchSessionSource,
): TabCatalogSessionAdapter<
  AttachmentSearchSessionRequest,
  AttachmentSearchQuery,
  AttachmentCatalogRow,
  AttachmentId,
  AttachmentSearchPageMeta
> {
  return {
    disposedError: 'AttachmentSearchSessionDisposed',
    normalize: normalizeRequest,
    requestKey,
    emptyPage: () => Object.freeze({ rows: Object.freeze([]), meta: { complete: false } }),
    readPage: async (query, page, signal) => {
      const envelope = await source.readPage(
        {
          ...query,
          limit: page.limit,
          ...(page.cursor ? { cursor: page.cursor } : {}),
          direction: page.direction,
        },
        signal,
      )
      return {
        workspaceId: envelope.workspaceId,
        replacementEpoch: envelope.replacementEpoch,
        value: protocolPage(envelope.value),
      }
    },
    evaluate: (query, attachmentIds, signal) => source.evaluate(query, attachmentIds, signal),
    changeImpact: attachmentChangeImpact,
    rowId: (row) => row.id,
    cloneRow: cloneCatalogRow,
    compareRows: (left, right, query) => catalogComparator(query.sort)(left, right),
  }
}

function normalizeRequest(
  request: AttachmentSearchSessionRequest,
): NormalizedTabCatalogRequest<AttachmentSearchQuery> {
  const pageSize = Number.isSafeInteger(request.pageSize)
    ? Math.min(MAX_PAGE_SIZE, Math.max(1, request.pageSize as number))
    : DEFAULT_PAGE_SIZE
  const query = request.search.query?.trim() ?? ''
  const search: AttachmentSearchQuery = Object.freeze({
    ...(query ? { query } : {}),
    ...(request.search.filters ? { filters: Object.freeze({ ...request.search.filters }) } : {}),
    sort: request.search.sort ?? 'created-desc',
  })
  const fence = {
    workspaceId: request.workspaceId,
    replacementEpoch: request.replacementEpoch,
  }
  return {
    ...fence,
    requestKey: requestKey(fence, search, pageSize),
    query: search,
    pageSize,
  }
}

function requestKey(
  fence: WorkspaceFence,
  search: AttachmentSearchQuery,
  pageSize: number,
): string {
  return JSON.stringify([
    fence.workspaceId,
    fence.replacementEpoch,
    search.query ?? '',
    search.filters ?? null,
    search.sort ?? 'created-desc',
    pageSize,
  ])
}

function protocolPage(
  page: AttachmentCatalogPage,
): TabCatalogPage<AttachmentCatalogRow, AttachmentSearchPageMeta> {
  return Object.freeze({
    rows: page.rows,
    ...(page.previousCursor ? { previousCursor: page.previousCursor } : {}),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    meta: Object.freeze({
      ...(page.matchedCount === undefined ? {} : { matchedCount: page.matchedCount }),
      complete: page.complete,
    }),
  })
}

function publicSnapshot(
  snapshot: TabCatalogSessionSnapshot<AttachmentCatalogRow, AttachmentSearchPageMeta>,
): AttachmentSearchSessionSnapshot {
  return Object.freeze({
    workspaceId: snapshot.workspaceId,
    replacementEpoch: snapshot.replacementEpoch,
    revision: snapshot.revision,
    requestKey: snapshot.requestKey,
    status: snapshot.status,
    rows: snapshot.page.rows,
    interactive: snapshot.interactive,
    pageNumber: snapshot.pageNumber,
    ...(snapshot.page.previousCursor ? { previousCursor: snapshot.page.previousCursor } : {}),
    ...(snapshot.page.nextCursor ? { nextCursor: snapshot.page.nextCursor } : {}),
    ...(snapshot.page.meta.matchedCount === undefined
      ? {}
      : { matchedCount: snapshot.page.meta.matchedCount }),
    complete: snapshot.page.meta.complete,
    error: snapshot.error,
  })
}

function attachmentChangeImpact(effect: WorkspaceEffect): TabCatalogChangeImpact<AttachmentId> {
  const changedIds = new Set<AttachmentId>()
  const deletedIds = new Set<AttachmentId>()
  if (effect.kind === 'replace') {
    return { relevant: false, broad: false, changedIds, deletedIds }
  }
  let broad = effect.impactByKind === 'all'
  for (const fact of effect.factsByKind['attachment-row-changed'] ?? []) {
    changedIds.add(fact.attachmentId)
  }
  for (const fact of effect.factsByKind['attachment-row-deleted'] ?? []) {
    deletedIds.add(fact.attachmentId)
  }
  if (effect.impactByKind !== 'all') {
    if ((effect.impactByKind.workspace?.length ?? 0) > 0) broad = true
    for (const dependency of [
      ...(effect.impactByKind.attachment ?? []),
      ...(effect.impactByKind['attachment-job'] ?? []),
    ]) {
      if (!dependency.attachmentIds) broad = true
      else for (const attachmentId of dependency.attachmentIds) changedIds.add(attachmentId)
    }
  }
  for (const attachmentId of deletedIds) changedIds.delete(attachmentId)
  return {
    relevant: broad || changedIds.size > 0 || deletedIds.size > 0,
    broad,
    changedIds,
    deletedIds,
  }
}

function catalogComparator(
  sort: AttachmentCatalogSearchRequest['sort'],
): (left: AttachmentCatalogRow, right: AttachmentCatalogRow) => number {
  return (left, right) => {
    let compared: number
    if (sort === 'created-asc') compared = left.createdAt - right.createdAt
    else if (sort === 'updated-desc') compared = right.updatedAt - left.updatedAt
    else if (sort === 'size-desc') compared = right.sizeBytes - left.sizeBytes
    else if (sort === 'size-asc') compared = left.sizeBytes - right.sizeBytes
    else compared = right.createdAt - left.createdAt
    if (compared !== 0) return compared
    return sort === 'created-asc' || sort === 'size-asc'
      ? left.id.localeCompare(right.id)
      : right.id.localeCompare(left.id)
  }
}

function cloneCatalogRow(row: AttachmentCatalogRow): AttachmentCatalogRow {
  return {
    ...row,
    storage: structuredClone(row.storage),
    ...(row.dimensions ? { dimensions: { ...row.dimensions } } : {}),
    processing: row.processing.map((state) => ({ ...state })),
  }
}
