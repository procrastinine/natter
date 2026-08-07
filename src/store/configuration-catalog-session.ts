import type { PromptPresetKind } from '../core/types'
import {
  type ConfigurationCatalogChange,
  configurationController,
} from './configuration-controller'
import {
  type MountedProjectionLifecycle,
  type MountedProjectionReconcileEvent,
  mountRepositoryProjection,
} from './mounted-projection-lifecycle'
import type { WorkspaceFence } from './repository'
import type {
  ConfigurationCatalogAddress,
  ConfigurationCatalogPage,
  ConfigurationCatalogPageRequest,
  ConfigurationCatalogPageValue,
  ConfigurationConnectionManagerRow,
  ConfigurationPresetCatalogRow,
  ConfigurationProfileCatalogRow,
  ConfigurationPromptPresetCatalogRow,
  ReadEnvelope,
  WorkspaceDependency,
} from './workspace-protocol'
import {
  CONFIGURATION_CATALOG_MAX_ADDRESSED_ROWS,
  CONFIGURATION_CATALOG_MAX_PAGE_SIZE,
  CONFIGURATION_CATALOG_MAX_REFRESH_ANCHORS,
  workspaceDependenciesOverlap,
} from './workspace-protocol'
import { getWorkspaceRepository } from './workspace-repository'
import { runWorkspaceRead } from './workspace-runtime'

export interface ConfigurationCatalogSessionRequest extends WorkspaceFence {
  readonly pageSize?: number
  readonly addressedIds?: readonly string[]
}

type ConfigurationCatalogSessionStatus = 'loading' | 'ready' | 'refreshing' | 'error'

export interface ConfigurationCatalogWindow<Row> {
  readonly catalogRevision: number
  readonly exactCount: number
  readonly rows: readonly Row[]
  readonly addressedRows: readonly ConfigurationCatalogAddress<Row>[]
  readonly atStart: boolean
  readonly atEnd: boolean
  readonly previousCursor?: string
  readonly nextCursor?: string
}

export interface ConfigurationCatalogSessionSnapshot<Row> extends WorkspaceFence {
  readonly revision: number
  readonly requestKey: string
  readonly status: ConfigurationCatalogSessionStatus
  readonly page: ConfigurationCatalogWindow<Row>
  readonly interactive: boolean
  readonly error: unknown
}

export interface ConfigurationCatalogSessionController<Row> {
  readonly subscribe: (listener: () => void) => () => void
  readonly getSnapshot: () => ConfigurationCatalogSessionSnapshot<Row> | null
  readonly request: (request: ConfigurationCatalogSessionRequest) => void
  readonly demandAfter: () => void
  readonly demandBefore: () => void
  readonly refresh: () => void
  readonly release: () => void
}

interface ConfigurationCatalogSessionSource<Row> {
  readonly readPage: (
    request: ConfigurationCatalogPageRequest,
    signal: AbortSignal,
  ) => Promise<ReadEnvelope<ConfigurationCatalogPage<Row>>>
  readonly subscribeCatalogChanges: (
    listener: (change: ConfigurationCatalogChange) => void,
  ) => () => void
}

interface ConfigurationCatalogSessionSpec<Row> {
  readonly disposedError: string
  readonly queryKey: string
  readonly defaultPageSize: number
  readonly dependency: WorkspaceDependency
  readonly maxRetainedPages: number
  readonly source: ConfigurationCatalogSessionSource<Row>
  readonly cloneRow: (row: Row) => Row
  readonly rowId: (row: Row) => string
}

interface ActiveConfigurationCatalogRequest extends WorkspaceFence {
  readonly generation: number
  readonly requestKey: string
  readonly pageSize: number
  readonly addressedIds: readonly string[]
}

interface ConfigurationCatalogRead<Row> {
  readonly active: ActiveConfigurationCatalogRequest
  readonly controller: AbortController
  readonly mode: 'initial' | 'next' | 'previous' | 'refresh'
  readonly pages: readonly ConfigurationCatalogPageValue<Row>[]
  invalidated: boolean
}

interface ConfigurationCatalogReadResult<Row> extends WorkspaceFence {
  readonly pages: readonly ConfigurationCatalogPageValue<Row>[]
}

export function createConfigurationProfileCatalogSessionController(): ConfigurationCatalogSessionController<ConfigurationProfileCatalogRow> {
  return createConfigurationCatalogController({
    disposedError: 'ConfigurationProfileCatalogSessionDisposed',
    queryKey: 'profiles',
    defaultPageSize: 64,
    maxRetainedPages: 3,
    dependency: {
      kind: 'profile',
      facets: ['catalog-membership', 'catalog-order', 'catalog-display', 'usage'],
    },
    source: configurationCatalogSource((request, signal) =>
      runWorkspaceRead(
        'repository-query',
        (permit) =>
          getWorkspaceRepository().query(
            permit,
            { kind: 'configuration.profile-catalog-page', request },
            { signal: permit.signal },
          ),
        { signal },
      ),
    ),
    cloneRow: (row) => ({ ...row }),
    rowId: (row) => row.id,
  })
}

export function createConfigurationConnectionManagerSessionController(): ConfigurationCatalogSessionController<ConfigurationConnectionManagerRow> {
  return createConfigurationCatalogController({
    disposedError: 'ConfigurationConnectionManagerSessionDisposed',
    queryKey: 'connection-manager',
    defaultPageSize: 64,
    maxRetainedPages: 1,
    dependency: {
      kind: 'profile',
      facets: ['catalog-membership', 'catalog-order', 'catalog-display', 'dependent-counts'],
    },
    source: configurationCatalogSource((request, signal) =>
      runWorkspaceRead(
        'repository-query',
        (permit) =>
          getWorkspaceRepository().query(
            permit,
            { kind: 'configuration.connection-manager-page', request },
            { signal: permit.signal },
          ),
        { signal },
      ),
    ),
    cloneRow: (row) => ({ ...row }),
    rowId: (row) => row.id,
  })
}

export function createConfigurationPresetCatalogSessionController(): ConfigurationCatalogSessionController<ConfigurationPresetCatalogRow> {
  return createConfigurationCatalogController({
    disposedError: 'ConfigurationPresetCatalogSessionDisposed',
    queryKey: 'presets',
    defaultPageSize: 64,
    maxRetainedPages: 3,
    dependency: {
      kind: 'preset',
      facets: ['catalog-membership', 'catalog-order', 'catalog-display'],
    },
    source: configurationCatalogSource((request, signal) =>
      runWorkspaceRead(
        'repository-query',
        (permit) =>
          getWorkspaceRepository().query(
            permit,
            { kind: 'configuration.preset-catalog-page', request },
            { signal: permit.signal },
          ),
        { signal },
      ),
    ),
    cloneRow: (row) => ({ ...row }),
    rowId: (row) => row.id,
  })
}

export function createConfigurationPromptPresetCatalogSessionController(
  promptKind: PromptPresetKind,
): ConfigurationCatalogSessionController<ConfigurationPromptPresetCatalogRow> {
  return createConfigurationCatalogController({
    disposedError: 'ConfigurationPromptPresetCatalogSessionDisposed',
    queryKey: `prompt-presets:${promptKind}`,
    defaultPageSize: 48,
    maxRetainedPages: 3,
    dependency: {
      kind: 'prompt-preset',
      facets: ['catalog-membership', 'catalog-order', 'catalog-display'],
    },
    source: configurationCatalogSource((request, signal) =>
      runWorkspaceRead(
        'repository-query',
        (permit) =>
          getWorkspaceRepository().query(
            permit,
            { kind: 'configuration.prompt-preset-catalog-page', promptKind, request },
            { signal: permit.signal },
          ),
        { signal },
      ),
    ),
    cloneRow: (row) => ({ ...row }),
    rowId: (row) => row.id,
  })
}

function configurationCatalogSource<Row>(
  readPage: ConfigurationCatalogSessionSource<Row>['readPage'],
): ConfigurationCatalogSessionSource<Row> {
  return {
    readPage,
    subscribeCatalogChanges: (listener) =>
      configurationController.subscribeCatalogChanges(listener),
  }
}

function createConfigurationCatalogController<Row>(
  spec: ConfigurationCatalogSessionSpec<Row>,
): ConfigurationCatalogSessionController<Row> {
  return new ConfigurationCatalogSession(spec)
}

class ConfigurationCatalogSession<Row> implements ConfigurationCatalogSessionController<Row> {
  private readonly spec: ConfigurationCatalogSessionSpec<Row>
  private lifecycle: MountedProjectionLifecycle | null = null
  private readonly listeners = new Set<() => void>()
  private stopChanges: (() => void) | null = null
  private snapshot: ConfigurationCatalogSessionSnapshot<Row> | null = null
  private active: ActiveConfigurationCatalogRequest | null = null
  private pages: readonly ConfigurationCatalogPageValue<Row>[] = Object.freeze([])
  private read: ConfigurationCatalogRead<Row> | null = null
  private generation = 0
  private revision = 0
  private refreshQueued = false
  private pageDemand: 'next' | 'previous' | null = null
  private resumeReadPending = false
  private released = true
  private disposed = false

  constructor(spec: ConfigurationCatalogSessionSpec<Row>) {
    this.spec = spec
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return () => undefined
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  readonly getSnapshot = (): ConfigurationCatalogSessionSnapshot<Row> | null => this.snapshot

  request(request: ConfigurationCatalogSessionRequest): void {
    if (this.disposed) throw new Error(this.spec.disposedError)
    const normalized = normalizeRequest(this.spec.queryKey, request, this.spec.defaultPageSize)
    this.ensureLifecycle()
    const wasReleased = this.released
    this.released = false
    if (this.active?.requestKey === normalized.requestKey) {
      this.attachChangefeed()
      if (wasReleased) {
        this.publishFromPages(
          this.active,
          this.pages.length > 0 ? 'refreshing' : 'loading',
          this.pages.length > 0,
          null,
        )
        this.startRead(this.pages.length > 0 ? 'refresh' : 'initial')
      }
      return
    }
    this.pageDemand = null
    const preserve =
      this.active !== null &&
      sameFence(this.active, normalized) &&
      this.active.pageSize === normalized.pageSize &&
      this.pages.length > 0
    this.abortRead()
    const active: ActiveConfigurationCatalogRequest = {
      ...normalized,
      generation: ++this.generation,
    }
    this.active = active
    this.attachChangefeed()
    if (!preserve) this.pages = Object.freeze([])
    this.publishFromPages(active, preserve ? 'refreshing' : 'loading', preserve, null)
    this.startRead(preserve ? 'refresh' : 'initial')
  }

  demandAfter(): void {
    this.demandPage('next')
  }

  demandBefore(): void {
    this.demandPage('previous')
  }

  refresh(): void {
    if (this.read) {
      this.refreshQueued = true
      return
    }
    this.refreshQueued = false
    this.startRead('refresh')
  }

  release(): void {
    if (this.disposed || this.released) return
    const lifecycle = this.lifecycle
    this.lifecycle = null
    this.released = true
    this.abortRead()
    this.detachChangefeed()
    this.pageDemand = null
    this.resumeReadPending = false
    lifecycle?.dispose()
  }

  private ensureLifecycle(): MountedProjectionLifecycle {
    if (this.disposed) throw new Error(this.spec.disposedError)
    this.lifecycle ??= mountRepositoryProjection({
      suspend: () => {
        this.detachChangefeed()
        this.suspendForRuntime()
      },
      reconcile: (event) => {
        this.detachChangefeed()
        this.reconcileRuntime(event)
      },
      resume: (event) => {
        this.attachChangefeed()
        this.resumeRuntime(event)
      },
      dispose: () => this.disposeOwner(),
    })
    return this.lifecycle
  }

  private disposeOwner(): void {
    if (this.disposed) return
    this.disposed = true
    this.lifecycle = null
    this.released = true
    this.abortRead()
    this.detachChangefeed()
    this.active = null
    this.pages = Object.freeze([])
    this.pageDemand = null
    this.snapshot = null
    this.listeners.clear()
  }

  private demandPage(mode: 'next' | 'previous'): void {
    if (this.disposed || this.released || !this.active) return
    if (this.read || !this.lifecycle?.isOpen()) {
      this.pageDemand = mode
      if (!this.lifecycle?.isOpen()) this.resumeReadPending = true
      return
    }
    this.startRead(mode)
  }

  private startRead(mode: ConfigurationCatalogRead<Row>['mode']): boolean {
    const active = this.active
    if (this.disposed || this.released || !active || this.read) return false
    const lifecycle = this.lifecycle
    if (!lifecycle?.isOpen()) {
      this.resumeReadPending = true
      return false
    }
    const first = this.pages[0]
    const last = this.pages.at(-1)
    if (mode === 'next' && !last?.nextCursor) return false
    if (mode === 'previous' && !first?.previousCursor) return false
    const read: ConfigurationCatalogRead<Row> = {
      active,
      controller: new AbortController(),
      mode,
      pages: this.pages,
      invalidated: false,
    }
    this.read = read
    this.publishFromPages(
      active,
      this.pages.length > 0 ? 'refreshing' : 'loading',
      this.pages.length > 0,
      null,
    )
    let promise: Promise<ConfigurationCatalogReadResult<Row>>
    try {
      promise = lifecycle.track(this.readPages(read))
    } catch (error) {
      this.settleRead(read, undefined, error)
      return true
    }
    void promise.then(
      (result) => this.settleRead(read, result),
      (error: unknown) => this.settleRead(read, undefined, error),
    )
    return true
  }

  private async readPages(
    read: ConfigurationCatalogRead<Row>,
  ): Promise<ConfigurationCatalogReadResult<Row>> {
    const head = (
      anchorIds?: readonly string[],
    ): Promise<ReadEnvelope<ConfigurationCatalogPage<Row>>> =>
      this.spec.source.readPage(
        pageRequest(read.active, undefined, 'forward', anchorIds),
        read.controller.signal,
      )
    const freshHead = () => head()
    if (read.mode === 'initial' || read.pages.length === 0) {
      const envelope = await freshHead()
      return readyReadResult(envelope, [requireCatalogPage(envelope.value)])
    }

    if (read.mode === 'next') {
      const cursor = read.pages.at(-1)?.nextCursor
      if (!cursor) return readyReadResult(read.active, read.pages)
      const envelope = await this.spec.source.readPage(
        pageRequest(read.active, cursor, 'forward'),
        read.controller.signal,
      )
      if (envelope.value.kind !== 'page') return this.readFreshHead(read, freshHead)
      if (!sameCatalogFrame(read.pages[0], envelope.value)) {
        return this.readFreshHead(read, freshHead)
      }
      const pages = [...read.pages, envelope.value].slice(-this.spec.maxRetainedPages)
      if (!coherentPages(pages, this.spec.rowId)) return this.readFreshHead(read, freshHead)
      return readyReadResult(envelope, pages)
    }

    if (read.mode === 'previous') {
      const cursor = read.pages[0]?.previousCursor
      if (!cursor) return readyReadResult(read.active, read.pages)
      const envelope = await this.spec.source.readPage(
        pageRequest(read.active, cursor, 'backward'),
        read.controller.signal,
      )
      if (envelope.value.kind !== 'page') return this.readFreshHead(read, freshHead)
      if (!sameCatalogFrame(read.pages[0], envelope.value)) {
        return this.readFreshHead(read, freshHead)
      }
      const pages = [envelope.value, ...read.pages].slice(0, this.spec.maxRetainedPages)
      if (!coherentPages(pages, this.spec.rowId)) return this.readFreshHead(read, freshHead)
      return readyReadResult(envelope, pages)
    }

    const targetPages = Math.min(this.spec.maxRetainedPages, Math.max(1, read.pages.length))
    const anchorIds = retainedAnchorIds(read.pages, this.spec.rowId)
    let cursor: string | undefined
    const pages: ConfigurationCatalogPageValue<Row>[] = []
    let lastEnvelope: WorkspaceFence = read.active
    for (let index = 0; index < targetPages; index += 1) {
      const envelope = await this.spec.source.readPage(
        pageRequest(read.active, cursor, 'forward', index === 0 ? anchorIds : undefined),
        read.controller.signal,
      )
      lastEnvelope = envelope
      if (envelope.value.kind !== 'page') return this.readFreshHead(read, freshHead)
      if (pages[0] && !sameCatalogFrame(pages[0], envelope.value)) {
        return this.readFreshHead(read, freshHead)
      }
      pages.push(envelope.value)
      cursor = envelope.value.nextCursor
      if (!cursor) break
    }
    if (!coherentPages(pages, this.spec.rowId)) return this.readFreshHead(read, freshHead)
    return readyReadResult(lastEnvelope, pages)
  }

  private async readFreshHead(
    read: ConfigurationCatalogRead<Row>,
    head: () => Promise<ReadEnvelope<ConfigurationCatalogPage<Row>>>,
  ): Promise<ConfigurationCatalogReadResult<Row>> {
    read.controller.signal.throwIfAborted()
    const envelope = await head()
    return readyReadResult(envelope, [requireCatalogPage(envelope.value)])
  }

  private settleRead(
    read: ConfigurationCatalogRead<Row>,
    result?: ConfigurationCatalogReadResult<Row>,
    error?: unknown,
  ): void {
    if (this.read === read) this.read = null
    if (
      this.disposed ||
      this.active !== read.active ||
      read.controller.signal.aborted ||
      read.active.generation !== this.generation
    ) {
      return
    }
    if (result && !sameFence(result, read.active)) {
      this.replaceFence(result)
      return
    }
    if (read.invalidated) {
      this.refreshQueued = false
      this.startRead('refresh')
      return
    }
    if (error !== undefined || !result) {
      if (!isAbortError(error)) {
        this.publishFromPages(
          read.active,
          'error',
          this.pages.length > 0,
          error ?? new Error('ConfigurationCatalogReadFailed'),
        )
      }
      this.afterRead()
      return
    }
    this.pages = Object.freeze(result.pages.map(freezeProtocolPage))
    this.publishFromPages(read.active, 'ready', true, null)
    this.afterRead()
  }

  private afterRead(): void {
    if (this.refreshQueued) {
      this.refreshQueued = false
      this.startRead('refresh')
      return
    }
    const mode = this.pageDemand
    if (!mode) return
    this.pageDemand = null
    if (this.startRead(mode) || !this.resumeReadPending) return
    this.pageDemand = mode
  }

  private receiveChange(change: ConfigurationCatalogChange): void {
    if (this.disposed) return
    const active = this.active
    if (!active || !sameFence(change, active)) return
    if (!workspaceDependenciesOverlap([this.spec.dependency], change.dependencies)) {
      return
    }
    if (this.read) this.read.invalidated = true
    this.refresh()
  }

  private publishFromPages(
    active: ActiveConfigurationCatalogRequest,
    status: ConfigurationCatalogSessionStatus,
    interactive: boolean,
    error: unknown,
  ): void {
    const page = flattenPages(this.pages, this.spec.cloneRow)
    this.snapshot = Object.freeze({
      workspaceId: active.workspaceId,
      replacementEpoch: active.replacementEpoch,
      revision: ++this.revision,
      requestKey: active.requestKey,
      status,
      page,
      interactive,
      error,
    })
    this.emit()
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener()
  }

  private abortRead(): void {
    this.read?.controller.abort()
    this.read = null
    this.refreshQueued = false
  }

  private attachChangefeed(): void {
    if (this.disposed || this.released || !this.active || this.stopChanges) return
    this.stopChanges = this.spec.source.subscribeCatalogChanges((change) =>
      this.receiveChange(change),
    )
  }

  private detachChangefeed(): void {
    this.stopChanges?.()
    this.stopChanges = null
  }

  private suspendForRuntime(): void {
    if (this.disposed) return
    this.resumeReadPending = this.active !== null && !this.released
    this.abortRead()
    if (this.active) {
      this.publishFromPages(
        this.active,
        this.pages.length > 0 ? 'refreshing' : 'loading',
        false,
        null,
      )
    }
  }

  private reconcileRuntime(event: MountedProjectionReconcileEvent): void {
    if (this.disposed || !this.active) return
    this.resumeReadPending = true
    if (!sameFence(this.active, event.fence)) this.replaceFence(event.fence, false)
  }

  private resumeRuntime(event: MountedProjectionReconcileEvent): void {
    if (this.disposed) return
    if (this.active && !sameFence(this.active, event.fence)) this.replaceFence(event.fence, false)
    if (this.released || !this.active || !this.resumeReadPending) return
    this.attachChangefeed()
    this.resumeReadPending = false
    this.startRead(this.pages.length > 0 ? 'refresh' : 'initial')
  }

  private replaceFence(fence: WorkspaceFence, startRead = true): void {
    const active = this.active
    if (!active) return
    this.abortRead()
    const next: ActiveConfigurationCatalogRequest = {
      ...active,
      workspaceId: fence.workspaceId,
      replacementEpoch: fence.replacementEpoch,
      requestKey: requestKey(this.spec.queryKey, fence, active.pageSize, active.addressedIds),
      generation: ++this.generation,
    }
    this.active = next
    this.pages = Object.freeze([])
    this.publishFromPages(next, 'loading', false, null)
    if (startRead) this.startRead('initial')
  }
}

function normalizeRequest(
  queryKey: string,
  request: ConfigurationCatalogSessionRequest,
  defaultPageSize: number,
): Omit<ActiveConfigurationCatalogRequest, 'generation'> {
  const pageSize = Number.isSafeInteger(request.pageSize)
    ? Math.min(CONFIGURATION_CATALOG_MAX_PAGE_SIZE, Math.max(1, request.pageSize as number))
    : defaultPageSize
  const rawAddressedIds = request.addressedIds ?? []
  if (rawAddressedIds.length > CONFIGURATION_CATALOG_MAX_ADDRESSED_ROWS) {
    throw new Error('ConfigurationCatalogAddressLimitExceeded')
  }
  const addressedIds = Object.freeze([...new Set(rawAddressedIds)])
  const fence = {
    workspaceId: request.workspaceId,
    replacementEpoch: request.replacementEpoch,
  }
  return {
    ...fence,
    pageSize,
    addressedIds,
    requestKey: requestKey(queryKey, fence, pageSize, addressedIds),
  }
}

function requestKey(
  queryKey: string,
  fence: WorkspaceFence,
  pageSize: number,
  addressedIds: readonly string[],
): string {
  return JSON.stringify([
    fence.workspaceId,
    fence.replacementEpoch,
    queryKey,
    pageSize,
    addressedIds,
  ])
}

function pageRequest(
  active: ActiveConfigurationCatalogRequest,
  cursor: string | undefined,
  direction: 'forward' | 'backward',
  anchorIds?: readonly string[],
): ConfigurationCatalogPageRequest {
  return {
    ...(cursor ? { cursor } : {}),
    ...(anchorIds && anchorIds.length > 0 ? { anchorIds } : {}),
    direction,
    limit: active.pageSize,
    ...(active.addressedIds.length > 0 ? { addressedIds: active.addressedIds } : {}),
  }
}

function requireCatalogPage<Row>(
  page: ConfigurationCatalogPage<Row>,
): ConfigurationCatalogPageValue<Row> {
  if (page.kind !== 'page') throw new Error('ConfigurationCatalogHeadReadStale')
  return page
}

function readyReadResult<Row>(
  fence: WorkspaceFence,
  pages: readonly ConfigurationCatalogPageValue<Row>[],
): ConfigurationCatalogReadResult<Row> {
  return Object.freeze({
    workspaceId: fence.workspaceId,
    replacementEpoch: fence.replacementEpoch,
    pages: Object.freeze([...pages]),
  })
}

function sameCatalogFrame<Row>(
  left: ConfigurationCatalogPageValue<Row> | undefined,
  right: ConfigurationCatalogPageValue<Row>,
): boolean {
  return (
    left !== undefined &&
    left.catalogRevision === right.catalogRevision &&
    left.exactCount === right.exactCount
  )
}

function retainedAnchorIds<Row>(
  pages: readonly ConfigurationCatalogPageValue<Row>[],
  rowId: (row: Row) => string,
): readonly string[] {
  const ids: string[] = []
  for (let rowIndex = 0; ids.length < CONFIGURATION_CATALOG_MAX_REFRESH_ANCHORS; rowIndex += 1) {
    let found = false
    for (const page of pages) {
      const row = page.rows[rowIndex]
      if (!row) continue
      found = true
      ids.push(rowId(row))
      if (ids.length === CONFIGURATION_CATALOG_MAX_REFRESH_ANCHORS) return Object.freeze(ids)
    }
    if (!found) break
  }
  return Object.freeze(ids)
}

function coherentPages<Row>(
  pages: readonly ConfigurationCatalogPageValue<Row>[],
  rowId: (row: Row) => string,
): boolean {
  const ids = new Set<string>()
  for (let index = 1; index < pages.length; index += 1) {
    const previous = pages[index - 1]
    const current = pages[index]
    if (!previous || !current || !sameCatalogFrame(previous, current)) {
      return false
    }
  }
  for (const page of pages) {
    for (const row of page.rows) {
      const id = rowId(row)
      if (ids.has(id)) return false
      ids.add(id)
    }
  }
  return true
}

function flattenPages<Row>(
  pages: readonly ConfigurationCatalogPageValue<Row>[],
  cloneRow: (row: Row) => Row,
): ConfigurationCatalogWindow<Row> {
  const first = pages[0]
  const last = pages.at(-1)
  if (!first || !last) {
    return Object.freeze({
      catalogRevision: 0,
      exactCount: 0,
      rows: Object.freeze([]),
      addressedRows: Object.freeze([]),
      atStart: true,
      atEnd: true,
    })
  }
  return Object.freeze({
    catalogRevision: first.catalogRevision,
    exactCount: first.exactCount,
    rows: Object.freeze(pages.flatMap((page) => page.rows.map(cloneRow))),
    addressedRows: Object.freeze(
      last.addressedRows.map((address) => ({
        id: address.id,
        row: address.row ? cloneRow(address.row) : null,
      })),
    ),
    atStart: first.previousCursor === undefined,
    atEnd: last.nextCursor === undefined,
    ...(first.previousCursor ? { previousCursor: first.previousCursor } : {}),
    ...(last.nextCursor ? { nextCursor: last.nextCursor } : {}),
  })
}

function freezeProtocolPage<Row>(
  page: ConfigurationCatalogPageValue<Row>,
): ConfigurationCatalogPageValue<Row> {
  return Object.freeze({
    ...page,
    rows: Object.freeze([...page.rows]),
    addressedRows: Object.freeze([...page.addressedRows]),
  })
}

function sameFence(left: WorkspaceFence | null | undefined, right: WorkspaceFence): boolean {
  return (
    left !== null &&
    left !== undefined &&
    left.workspaceId === right.workspaceId &&
    left.replacementEpoch === right.replacementEpoch
  )
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
