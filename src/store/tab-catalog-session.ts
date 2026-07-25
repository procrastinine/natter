import {
  type MountedProjectionLifecycle,
  type MountedProjectionReconcileEvent,
  mountRepositoryProjection,
} from './mounted-projection-lifecycle'
import type { WorkspaceFence } from './repository'
import type { WorkspaceEffect } from './workspace-effect-hub'
import type { ReadEnvelope } from './workspace-protocol'

type TabCatalogSessionStatus = 'loading' | 'ready' | 'refreshing' | 'error'

export interface TabCatalogPage<Row, Meta> {
  readonly rows: readonly Row[]
  readonly previousCursor?: string
  readonly nextCursor?: string
  readonly meta: Meta
}

export interface TabCatalogSessionSnapshot<Row, Meta> extends WorkspaceFence {
  readonly revision: number
  readonly requestKey: string
  readonly status: TabCatalogSessionStatus
  readonly page: TabCatalogPage<Row, Meta>
  readonly pageNumber: number
  readonly interactive: boolean
  readonly error: unknown
}

export interface NormalizedTabCatalogRequest<Query> extends WorkspaceFence {
  readonly requestKey: string
  readonly query: Query
  readonly pageSize: number
}

interface TabCatalogPageRead<Meta> {
  readonly cursor?: string
  readonly direction: 'forward' | 'backward'
  readonly limit: number
  readonly previousMeta?: Meta
}

export interface TabCatalogChangeImpact<Id> {
  readonly relevant: boolean
  readonly broad: boolean
  readonly changedIds: ReadonlySet<Id>
  readonly deletedIds: ReadonlySet<Id>
}

export interface TabCatalogSessionAdapter<Input, Query, Row, Id, Meta> {
  readonly disposedError: string
  readonly normalize: (request: Input) => NormalizedTabCatalogRequest<Query>
  readonly requestKey: (fence: WorkspaceFence, query: Query, pageSize: number) => string
  readonly emptyPage: () => TabCatalogPage<Row, Meta>
  readonly readPage: (
    query: Query,
    page: TabCatalogPageRead<Meta>,
    signal: AbortSignal,
  ) => Promise<ReadEnvelope<TabCatalogPage<Row, Meta>>>
  readonly evaluate?: (
    query: Query,
    ids: readonly Id[],
    signal: AbortSignal,
  ) => Promise<ReadEnvelope<readonly (Row | undefined)[]>>
  readonly changeImpact: (effect: WorkspaceEffect) => TabCatalogChangeImpact<Id>
  readonly rowId: (row: Row) => Id
  readonly cloneRow: (row: Row) => Row
  readonly compareRows: (left: Row, right: Row, query: Query) => number
}

export interface TabCatalogSessionController<Input, Row, Meta> {
  readonly subscribe: (listener: () => void) => () => void
  readonly subscribeEffects: (listener: (effect: WorkspaceEffect) => void) => () => void
  readonly getSnapshot: () => TabCatalogSessionSnapshot<Row, Meta> | null
  readonly isOpen: () => boolean
  readonly track: <T>(promise: Promise<T>) => Promise<T>
  readonly request: (request: Input) => void
  readonly loadMore: () => void
  readonly nextPage: () => void
  readonly previousPage: () => void
  readonly refresh: () => void
  readonly release: () => void
  readonly dispose: () => void
}

interface ActiveRequest<Query> extends NormalizedTabCatalogRequest<Query> {
  readonly generation: number
  readonly cursor?: string
  readonly direction: 'forward' | 'backward'
  readonly pageNumber: number
}

interface CatalogRead<Query, Meta> {
  readonly active: ActiveRequest<Query>
  readonly controller: AbortController
  readonly mode: 'initial' | 'navigate' | 'refresh' | 'load-more'
  readonly rollback: ActiveRequest<Query> | null
  readonly targetRowCount: number
  readonly acceptedMeta?: Meta
  invalidated: boolean
}

interface PointRead<Query, Id> {
  readonly active: ActiveRequest<Query>
  readonly controller: AbortController
  readonly ids: readonly Id[]
}

const POINT_READ_BATCH_SIZE = 64

export function createTabCatalogSession<Input, Query, Row, Id, Meta>(
  adapter: TabCatalogSessionAdapter<Input, Query, Row, Id, Meta>,
  subscribeEffects: (
    apply: (effect: WorkspaceEffect) => void,
    recover: (effect: WorkspaceEffect) => void,
  ) => () => void,
): TabCatalogSessionController<Input, Row, Meta> {
  return new TabCatalogSession(adapter, subscribeEffects)
}

class TabCatalogSession<Input, Query, Row, Id, Meta>
  implements TabCatalogSessionController<Input, Row, Meta>
{
  private readonly adapter: TabCatalogSessionAdapter<Input, Query, Row, Id, Meta>
  private readonly subscribeSourceEffects: (
    apply: (effect: WorkspaceEffect) => void,
    recover: (effect: WorkspaceEffect) => void,
  ) => () => void
  private readonly listeners = new Set<() => void>()
  private readonly effectListeners = new Set<(effect: WorkspaceEffect) => void>()
  private readonly dirtyIds = new Set<Id>()
  private readonly deletedIds = new Set<Id>()
  private stopChanges: (() => void) | null = null
  private readonly lifecycle: MountedProjectionLifecycle
  private snapshot: TabCatalogSessionSnapshot<Row, Meta> | null = null
  private active: ActiveRequest<Query> | null = null
  private pageRead: CatalogRead<Query, Meta> | null = null
  private pointRead: PointRead<Query, Id> | null = null
  private generation = 0
  private revision = 0
  private pointDrainScheduled = false
  private refreshQueued = false
  private demandedRowCount = 0
  private resumeReadPending = false
  private resumeReplacement = false
  private disposed = false

  constructor(
    adapter: TabCatalogSessionAdapter<Input, Query, Row, Id, Meta>,
    subscribeEffects: (
      apply: (effect: WorkspaceEffect) => void,
      recover: (effect: WorkspaceEffect) => void,
    ) => () => void,
  ) {
    this.adapter = adapter
    this.subscribeSourceEffects = subscribeEffects
    this.lifecycle = mountRepositoryProjection({
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
    if (this.lifecycle.isOpen()) this.attachChangefeed()
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return () => undefined
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  readonly subscribeEffects = (listener: (effect: WorkspaceEffect) => void): (() => void) => {
    if (this.disposed) return () => undefined
    this.effectListeners.add(listener)
    return () => this.effectListeners.delete(listener)
  }

  readonly getSnapshot = (): TabCatalogSessionSnapshot<Row, Meta> | null => this.snapshot

  readonly isOpen = (): boolean => this.lifecycle.isOpen()

  readonly track = <T>(promise: Promise<T>): Promise<T> => this.lifecycle.track(promise)

  request(request: Input): void {
    if (this.disposed) throw new Error(this.adapter.disposedError)
    if (this.lifecycle.isOpen()) this.attachChangefeed()
    const normalized = this.adapter.normalize(request)
    if (this.active?.requestKey === normalized.requestKey) return
    const priorPage = sameFence(this.snapshot, normalized)
      ? (this.snapshot?.page ?? this.adapter.emptyPage())
      : this.adapter.emptyPage()
    const preserveDemand =
      sameFence(this.snapshot, normalized) && this.active?.pageSize === normalized.pageSize
    this.demandedRowCount = preserveDemand
      ? Math.max(this.demandedRowCount, priorPage.rows.length, normalized.pageSize)
      : normalized.pageSize
    this.abortReads()
    this.dirtyIds.clear()
    this.deletedIds.clear()
    const active: ActiveRequest<Query> = {
      ...normalized,
      generation: ++this.generation,
      direction: 'forward',
      pageNumber: 0,
    }
    this.active = active
    this.publish({
      workspaceId: active.workspaceId,
      replacementEpoch: active.replacementEpoch,
      revision: ++this.revision,
      requestKey: active.requestKey,
      status: 'loading',
      page: priorPage,
      pageNumber: 0,
      interactive: false,
      error: null,
    })
    this.startPageRead(active, 'initial', null, this.demandedRowCount)
  }

  nextPage(): void {
    const active = this.active
    const cursor = this.snapshot?.page.nextCursor
    if (!active || !cursor || this.pageRead || this.pointRead) return
    const next: ActiveRequest<Query> = {
      ...active,
      cursor,
      direction: 'forward',
      pageNumber: active.pageNumber + 1,
    }
    this.active = next
    this.demandedRowCount = next.pageSize
    this.startPageRead(next, 'navigate', active)
  }

  loadMore(): void {
    const active = this.active
    const current = this.snapshot
    if (!active || !current || (!current.page.nextCursor && !this.pageRead)) return
    const baseRowCount = Math.max(current.page.rows.length, this.demandedRowCount)
    this.demandedRowCount = Math.max(baseRowCount + active.pageSize, baseRowCount * 2)
    if (!current.interactive || this.pageRead || this.pointRead) return
    this.startPageRead(active, 'load-more', null, this.demandedRowCount)
  }

  previousPage(): void {
    const active = this.active
    const cursor = this.snapshot?.page.previousCursor
    if (!active || !cursor || this.pageRead || this.pointRead) return
    const next: ActiveRequest<Query> = {
      ...active,
      cursor,
      direction: 'backward',
      pageNumber: Math.max(0, active.pageNumber - 1),
    }
    this.active = next
    this.demandedRowCount = next.pageSize
    this.startPageRead(next, 'navigate', active)
  }

  refresh(): void {
    const active = this.active
    if (!active) return
    if (this.pageRead || this.pointRead) {
      this.refreshQueued = true
      return
    }
    this.refreshQueued = false
    this.startPageRead(active, 'refresh', null, this.demandedRowCount)
  }

  release(): void {
    if (this.disposed || (!this.active && !this.snapshot)) return
    this.abortReads()
    this.detachChangefeed()
    this.active = null
    this.demandedRowCount = 0
    this.snapshot = null
    this.dirtyIds.clear()
    this.deletedIds.clear()
    this.resumeReadPending = false
    this.resumeReplacement = false
    this.generation += 1
    for (const listener of [...this.listeners]) listener()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposeOwner()
    this.lifecycle.dispose()
  }

  private disposeOwner(): void {
    if (this.disposed) return
    this.disposed = true
    this.abortReads()
    this.detachChangefeed()
    this.active = null
    this.demandedRowCount = 0
    this.snapshot = null
    this.dirtyIds.clear()
    this.deletedIds.clear()
    this.listeners.clear()
    this.effectListeners.clear()
  }

  private startPageRead(
    active: ActiveRequest<Query>,
    mode: CatalogRead<Query, Meta>['mode'],
    rollback: ActiveRequest<Query> | null,
    targetRowCount?: number,
  ): void {
    if (this.disposed || this.active !== active || this.pageRead || this.pointRead) return
    if (!this.lifecycle.isOpen()) {
      this.resumeReadPending = true
      return
    }
    const controller = new AbortController()
    const current = this.snapshot
    const read: CatalogRead<Query, Meta> = {
      active,
      controller,
      mode,
      rollback,
      targetRowCount:
        targetRowCount ??
        (mode === 'refresh'
          ? Math.max(active.pageSize, current?.page.rows.length ?? 0, this.demandedRowCount)
          : active.pageSize),
      invalidated: false,
      ...(current?.interactive ? { acceptedMeta: current.page.meta } : {}),
    }
    this.pageRead = read
    if (current) {
      this.publish({
        ...current,
        revision: ++this.revision,
        status: mode === 'refresh' || mode === 'load-more' ? 'refreshing' : 'loading',
        interactive: (mode === 'refresh' || mode === 'load-more') && current.interactive,
        error: null,
      })
    }
    let promise: Promise<ReadEnvelope<TabCatalogPage<Row, Meta>>>
    try {
      promise = this.lifecycle.track(this.readWindow(read))
    } catch (error) {
      this.settlePageRead(read, undefined, error)
      return
    }
    void promise.then(
      (envelope) => this.settlePageRead(read, envelope),
      (error: unknown) => this.settlePageRead(read, undefined, error),
    )
  }

  private settlePageRead(
    read: CatalogRead<Query, Meta>,
    envelope?: ReadEnvelope<TabCatalogPage<Row, Meta>>,
    error?: unknown,
  ): void {
    if (this.pageRead === read) this.pageRead = null
    if (
      this.disposed ||
      this.active !== read.active ||
      read.controller.signal.aborted ||
      read.active.generation !== this.generation
    ) {
      return
    }
    if (envelope && !sameFence(envelope, read.active)) {
      this.replaceFence(envelope)
      return
    }
    if (read.invalidated) {
      this.dirtyIds.clear()
      this.refreshQueued = false
      this.startPageRead(
        read.active,
        'refresh',
        null,
        Math.max(read.targetRowCount, this.demandedRowCount),
      )
      return
    }
    if (error !== undefined || !envelope) {
      if (!isAbortError(error)) {
        if (read.rollback) this.active = read.rollback
        const current = this.snapshot
        if (current) {
          this.publish({
            ...current,
            revision: ++this.revision,
            status: 'error',
            interactive:
              read.mode === 'refresh' || read.mode === 'load-more'
                ? current.interactive
                : read.rollback !== null,
            error: error ?? new Error('CatalogPageReadFailed'),
          })
        }
      }
      this.afterPageRead(false)
      return
    }
    const page = envelope.value
    const rows = Object.freeze(
      page.rows
        .filter((row) => !this.deletedIds.has(this.adapter.rowId(row)))
        .map((row) => this.adapter.cloneRow(row)),
    )
    this.publish({
      workspaceId: envelope.workspaceId,
      replacementEpoch: envelope.replacementEpoch,
      revision: ++this.revision,
      requestKey: read.active.requestKey,
      status: 'ready',
      page: Object.freeze({ ...page, rows }),
      pageNumber: read.active.pageNumber,
      interactive: true,
      error: null,
    })
    this.dirtyIds.clear()
    this.deletedIds.clear()
    this.afterPageRead(true)
  }

  private afterPageRead(drainDemand: boolean): void {
    if (this.dirtyIds.size > 0 && this.adapter.evaluate) {
      this.schedulePointDrain()
      return
    }
    if (this.refreshQueued) {
      this.refreshQueued = false
      this.refresh()
      return
    }
    if (!drainDemand) return
    const active = this.active
    const current = this.snapshot
    if (
      active &&
      current?.interactive &&
      current.page.nextCursor &&
      current.page.rows.length < this.demandedRowCount
    ) {
      this.startPageRead(active, 'load-more', null, this.demandedRowCount)
    }
  }

  private receiveEffect(effect: WorkspaceEffect): void {
    if (this.disposed) return
    for (const listener of [...this.effectListeners]) listener(effect)
    const active = this.active
    if (!active) return
    if (effect.kind === 'replace' || !sameFence(effect, active)) return
    const impact = this.adapter.changeImpact(effect)
    if (!impact.relevant) return
    if (this.pageRead) this.pageRead.invalidated = true
    if (impact.broad) {
      this.refreshQueued = true
      this.refresh()
      return
    }
    for (const id of impact.deletedIds) {
      this.deletedIds.add(id)
      this.dirtyIds.delete(id)
    }
    for (const id of impact.changedIds) {
      this.deletedIds.delete(id)
      this.dirtyIds.add(id)
    }
    if (impact.deletedIds.size > 0) this.removeRows(impact.deletedIds)
    this.refreshQueued = true
    if (this.adapter.evaluate && this.dirtyIds.size > 0) this.schedulePointDrain()
    else this.refresh()
  }

  private recoverEffect(effect: WorkspaceEffect): void {
    if (this.disposed || !this.active || !sameFence(effect, this.active)) return
    if (this.pageRead) this.pageRead.invalidated = true
    this.pointRead?.controller.abort()
    this.pointRead = null
    this.dirtyIds.clear()
    this.deletedIds.clear()
    this.refreshQueued = true
    const current = this.snapshot
    if (current) {
      this.publish({
        ...current,
        revision: ++this.revision,
        status: current.page.rows.length > 0 ? 'refreshing' : 'loading',
        interactive: current.page.rows.length > 0,
        error: null,
      })
    }
    this.refresh()
  }

  private replaceFence(fence: WorkspaceFence, startRead = true): void {
    const active = this.active
    if (!active) return
    this.abortReads()
    this.dirtyIds.clear()
    this.deletedIds.clear()
    const next: ActiveRequest<Query> = {
      query: active.query,
      pageSize: active.pageSize,
      workspaceId: fence.workspaceId,
      replacementEpoch: fence.replacementEpoch,
      requestKey: this.adapter.requestKey(fence, active.query, active.pageSize),
      generation: ++this.generation,
      direction: 'forward',
      pageNumber: 0,
    }
    this.active = next
    this.demandedRowCount = next.pageSize
    this.publish({
      workspaceId: fence.workspaceId,
      replacementEpoch: fence.replacementEpoch,
      revision: ++this.revision,
      requestKey: next.requestKey,
      status: 'loading',
      page: this.adapter.emptyPage(),
      pageNumber: 0,
      interactive: false,
      error: null,
    })
    if (startRead) this.startPageRead(next, 'initial', null, this.demandedRowCount)
  }

  private suspendForRuntime(): void {
    if (this.disposed) return
    this.resumeReadPending = this.active !== null
    this.abortReads()
    const current = this.snapshot
    if (!current) return
    this.publish({
      ...current,
      revision: ++this.revision,
      status: current.page.rows.length > 0 ? 'refreshing' : 'loading',
      interactive: false,
      error: null,
    })
  }

  private reconcileRuntime(event: MountedProjectionReconcileEvent): void {
    if (this.disposed || !this.active) return
    this.resumeReadPending = true
    if (!sameFence(this.active, event.fence)) {
      this.resumeReplacement = true
      this.replaceFence(event.fence, false)
    } else if (event.replaced) {
      this.resumeReplacement = true
    }
  }

  private resumeRuntime(event: MountedProjectionReconcileEvent): void {
    if (this.disposed) return
    if (this.active && !sameFence(this.active, event.fence)) {
      this.resumeReplacement = true
      this.replaceFence(event.fence, false)
    }
    const active = this.active
    if (!active || !this.resumeReadPending) return
    const replacing = this.resumeReplacement
    this.resumeReadPending = false
    this.resumeReplacement = false
    this.dirtyIds.clear()
    this.deletedIds.clear()
    this.startPageRead(
      active,
      replacing ? 'initial' : 'refresh',
      null,
      Math.max(active.pageSize, this.snapshot?.page.rows.length ?? 0, this.demandedRowCount),
    )
  }

  private schedulePointDrain(): void {
    if (
      this.pointDrainScheduled ||
      this.pointRead ||
      this.pageRead ||
      this.dirtyIds.size === 0 ||
      !this.active ||
      !this.adapter.evaluate
    ) {
      return
    }
    if (this.dirtyIds.size > POINT_READ_BATCH_SIZE) {
      this.dirtyIds.clear()
      this.refresh()
      return
    }
    this.pointDrainScheduled = true
    queueMicrotask(() => {
      this.pointDrainScheduled = false
      this.startPointRead()
    })
  }

  private startPointRead(): void {
    const active = this.active
    const evaluate = this.adapter.evaluate
    if (
      this.disposed ||
      !active ||
      !evaluate ||
      this.pointRead ||
      this.pageRead ||
      this.dirtyIds.size === 0
    ) {
      return
    }
    if (!this.lifecycle.isOpen()) {
      this.resumeReadPending = true
      return
    }
    const ids: Id[] = []
    for (const id of this.dirtyIds) {
      this.dirtyIds.delete(id)
      ids.push(id)
      if (ids.length === POINT_READ_BATCH_SIZE) break
    }
    const controller = new AbortController()
    const read: PointRead<Query, Id> = { active, controller, ids }
    this.pointRead = read
    let promise: Promise<ReadEnvelope<readonly (Row | undefined)[]>>
    try {
      promise = this.lifecycle.track(evaluate(active.query, ids, controller.signal))
    } catch (error) {
      this.settlePointRead(read, undefined, error)
      return
    }
    void promise.then(
      (envelope) => this.settlePointRead(read, envelope),
      (error: unknown) => this.settlePointRead(read, undefined, error),
    )
  }

  private settlePointRead(
    read: PointRead<Query, Id>,
    envelope?: ReadEnvelope<readonly (Row | undefined)[]>,
    error?: unknown,
  ): void {
    if (this.pointRead === read) this.pointRead = null
    if (
      this.disposed ||
      this.active !== read.active ||
      read.controller.signal.aborted ||
      read.active.generation !== this.generation
    ) {
      return
    }
    if (envelope && !sameFence(envelope, read.active)) {
      this.replaceFence(envelope)
      return
    }
    if (error !== undefined || !envelope || envelope.value.length !== read.ids.length) {
      if (!isAbortError(error)) {
        this.refreshQueued = true
        this.refresh()
      }
      return
    }
    const current = this.snapshot
    if (current) {
      const rows: Array<Row | undefined> = [...current.page.rows]
      const indexById = new Map<Id, number>()
      for (let index = 0; index < rows.length; index += 1) {
        indexById.set(this.adapter.rowId(rows[index] as Row), index)
      }
      let changed = false
      for (let index = 0; index < read.ids.length; index += 1) {
        const id = read.ids[index] as Id
        const rowIndex = indexById.get(id)
        if (rowIndex === undefined) continue
        const row = envelope.value[index]
        if (!row || this.deletedIds.has(id)) rows[rowIndex] = undefined
        else rows[rowIndex] = this.adapter.cloneRow(row)
        changed = true
      }
      if (changed) {
        const nextRows = rows.filter((row): row is Row => row !== undefined)
        nextRows.sort((left, right) => this.adapter.compareRows(left, right, read.active.query))
        this.publish({
          ...current,
          revision: ++this.revision,
          page: Object.freeze({ ...current.page, rows: Object.freeze(nextRows) }),
          status: 'ready',
          interactive: true,
          error: null,
        })
      }
    }
    this.dirtyIds.clear()
    this.refresh()
  }

  private removeRows(ids: ReadonlySet<Id>): void {
    const current = this.snapshot
    if (!current) return
    const rows = current.page.rows.filter((row) => !ids.has(this.adapter.rowId(row)))
    if (rows.length === current.page.rows.length) return
    this.publish({
      ...current,
      revision: ++this.revision,
      page: Object.freeze({ ...current.page, rows: Object.freeze(rows) }),
    })
  }

  private abortReads(): void {
    this.pageRead?.controller.abort()
    this.pointRead?.controller.abort()
    this.pageRead = null
    this.pointRead = null
    this.pointDrainScheduled = false
    this.refreshQueued = false
  }

  private attachChangefeed(): void {
    if (this.disposed || this.stopChanges) return
    this.stopChanges = this.subscribeSourceEffects(
      (effect) => this.receiveEffect(effect),
      (effect) => this.recoverEffect(effect),
    )
  }

  private detachChangefeed(): void {
    this.stopChanges?.()
    this.stopChanges = null
  }

  private publish(snapshot: TabCatalogSessionSnapshot<Row, Meta>): void {
    this.snapshot = Object.freeze(snapshot)
    for (const listener of [...this.listeners]) listener()
  }

  private async readWindow(
    read: CatalogRead<Query, Meta>,
  ): Promise<ReadEnvelope<TabCatalogPage<Row, Meta>>> {
    const base = read.mode === 'load-more' ? this.snapshot?.page : undefined
    const rows: Row[] = base ? [...base.rows] : []
    const ids = new Set<Id>()
    for (const row of rows) ids.add(this.adapter.rowId(row))
    let cursor = base?.nextCursor ?? read.active.cursor
    let direction = read.mode === 'load-more' ? ('forward' as const) : read.active.direction
    let previousCursor = base?.previousCursor
    let nextCursor = base?.nextCursor
    const reusableMeta =
      read.mode === 'load-more' || read.mode === 'navigate'
        ? (base?.meta ?? read.acceptedMeta)
        : undefined
    let meta = reusableMeta ?? this.adapter.emptyPage().meta
    let hasAcceptedMeta = reusableMeta !== undefined
    let fence: WorkspaceFence | null = null
    let firstRead = true

    while (firstRead || (rows.length < read.targetRowCount && cursor)) {
      firstRead = false
      const remaining = Math.max(1, read.targetRowCount - rows.length)
      const envelope = await this.adapter.readPage(
        read.active.query,
        {
          ...(cursor ? { cursor } : {}),
          direction,
          limit: Math.min(read.active.pageSize, remaining),
          ...(hasAcceptedMeta ? { previousMeta: meta } : {}),
        },
        read.controller.signal,
      )
      if (fence && !sameFence(fence, envelope)) return envelope
      fence = {
        workspaceId: envelope.workspaceId,
        replacementEpoch: envelope.replacementEpoch,
      }
      if (previousCursor === undefined) previousCursor = envelope.value.previousCursor
      meta = envelope.value.meta
      hasAcceptedMeta = true
      for (const row of envelope.value.rows) {
        const id = this.adapter.rowId(row)
        if (ids.has(id)) continue
        ids.add(id)
        rows.push(row)
      }
      const followingCursor = envelope.value.nextCursor
      nextCursor = followingCursor
      if (!followingCursor || followingCursor === cursor || rows.length >= read.targetRowCount)
        break
      cursor = followingCursor
      direction = 'forward'
    }

    const resolvedFence = fence ?? read.active
    return {
      workspaceId: resolvedFence.workspaceId,
      replacementEpoch: resolvedFence.replacementEpoch,
      value: Object.freeze({
        rows: Object.freeze(rows),
        ...(previousCursor ? { previousCursor } : {}),
        ...(nextCursor ? { nextCursor } : {}),
        meta,
      }),
    }
  }
}

function sameFence(
  left: WorkspaceFence | null | undefined,
  right: WorkspaceFence | null | undefined,
): boolean {
  return (
    left !== null &&
    left !== undefined &&
    right !== null &&
    right !== undefined &&
    left.workspaceId === right.workspaceId &&
    left.replacementEpoch === right.replacementEpoch
  )
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : (error as { name?: string } | null)?.name === 'AbortError'
}
