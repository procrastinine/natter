import type { AttachmentId } from '../core/types'
import { PersistentStringMap } from '../lib/persistent-string-map'
import type { WorkspaceFence } from './repository'
import type { WorkspaceEffect } from './workspace-effect-hub'

export interface AttachmentProjectionRow {
  readonly id: AttachmentId
}

interface AttachmentProjectionReadEnvelope<Row extends AttachmentProjectionRow>
  extends WorkspaceFence {
  readonly rows: readonly (Row | undefined)[]
}

interface AttachmentProjectionSource<Row extends AttachmentProjectionRow> {
  loadRows(
    attachmentIds: readonly AttachmentId[],
    signal: AbortSignal,
  ): Promise<AttachmentProjectionReadEnvelope<Row>>
}

type AttachmentDemandStatus = 'loading' | 'ready' | 'refreshing' | 'error'

export interface AttachmentDemandSnapshot<Row extends AttachmentProjectionRow> {
  readonly revision: number
  readonly workspaceFence: WorkspaceFence | null
  readonly status: AttachmentDemandStatus
  readonly interactive: boolean
  readonly attachmentIds: readonly AttachmentId[]
  readonly rowsById: PersistentStringMap<Row>
  readonly errorsById: PersistentStringMap<unknown>
}

export interface AttachmentDemand<Row extends AttachmentProjectionRow> {
  readonly subscribe: (listener: () => void) => () => void
  readonly getSnapshot: () => AttachmentDemandSnapshot<Row>
  update(attachmentIds: readonly AttachmentId[]): void
  release(): void
}

interface AttachmentProjectionControllerStats {
  readonly demands: number
  readonly demandedIds: number
  readonly loadedIds: number
  readonly pendingIds: number
  readonly inFlightIds: number
  readonly errorIds: number
}

export interface AttachmentProjectionController<Row extends AttachmentProjectionRow> {
  setSource(source: AttachmentProjectionSource<Row> | null): void
  reconcileWorkspace(fence: WorkspaceFence): void
  recoverWorkspace(fence: WorkspaceFence): void
  observeWorkspaceEffect(effect: WorkspaceEffect): void
  demand(attachmentIds: readonly AttachmentId[]): AttachmentDemand<Row>
  stats(): AttachmentProjectionControllerStats
  dispose(): void
}

interface AttachmentIdState<Row extends AttachmentProjectionRow> {
  readonly loaded: boolean
  readonly busy: boolean
  readonly blocked: boolean
  readonly row: Row | undefined
  readonly error: unknown
}

const READ_BATCH_SIZE = 128

export function createAttachmentProjectionController<
  Row extends AttachmentProjectionRow,
>(): AttachmentProjectionController<Row> {
  return new TabAttachmentProjectionController<Row>()
}

class TabAttachmentProjectionController<Row extends AttachmentProjectionRow>
  implements AttachmentProjectionController<Row>
{
  private source: AttachmentProjectionSource<Row> | null = null
  private workspaceFence: WorkspaceFence | null = null
  private readonly demands = new Set<TabAttachmentDemand<Row>>()
  private readonly demandsById = new Map<AttachmentId, Set<TabAttachmentDemand<Row>>>()
  private readonly demandCountById = new Map<AttachmentId, number>()
  private readonly rowsById = new Map<AttachmentId, Row>()
  private readonly loadedIds = new Set<AttachmentId>()
  private readonly dirtyIds = new Set<AttachmentId>()
  private readonly inFlightIds = new Set<AttachmentId>()
  private readonly blockedIds = new Set<AttachmentId>()
  private readonly errorsById = new Map<AttachmentId, unknown>()
  private readonly versionById = new Map<AttachmentId, number>()
  private read: { readonly generation: number; readonly controller: AbortController } | null = null
  private generation = 0
  private version = 0
  private drainScheduled = false
  private sourceVerified = false
  private disposed = false

  setSource(source: AttachmentProjectionSource<Row> | null): void {
    if (this.disposed || this.source === source) return
    this.generation += 1
    this.abortRead()
    this.source = source
    this.sourceVerified = false
    this.dirtyIds.clear()
    this.inFlightIds.clear()
    for (const attachmentId of this.demandCountById.keys()) this.blockedIds.add(attachmentId)
    this.publishAll()
  }

  reconcileWorkspace(fence: WorkspaceFence): void {
    if (this.disposed) return
    if (!sameWorkspaceFence(this.workspaceFence, fence)) {
      this.workspaceFence = Object.freeze({ ...fence })
      this.sourceVerified = this.source !== null
      this.resetRows(false)
      if (!this.queueAllDemanded()) this.publishAll()
      else {
        for (const demand of this.demands) demand.refreshWorkspaceFenceIfEmpty()
      }
      return
    }
    this.sourceVerified = this.source !== null
    if (!this.queueAllDemanded()) this.publishAll()
  }

  recoverWorkspace(fence: WorkspaceFence): void {
    if (!sameWorkspaceFence(this.workspaceFence, fence)) {
      this.reconcileWorkspace(fence)
      return
    }
    this.invalidateIds(this.demandCountById.keys())
  }

  observeWorkspaceEffect(change: WorkspaceEffect): void {
    if (this.disposed) return
    if (change.kind === 'replace') return
    if (!this.workspaceFence || !sameWorkspaceFence(change, this.workspaceFence)) return
    if (change.impactByKind === 'all') {
      this.invalidateIds(this.demandCountById.keys())
      return
    }
    const attachmentIds = new Set<AttachmentId>()
    let broad = (change.impactByKind.workspace?.length ?? 0) > 0
    for (const dependency of [
      ...(change.impactByKind.attachment ?? []),
      ...(change.impactByKind['attachment-job'] ?? []),
    ]) {
      if (!dependency.attachmentIds) broad = true
      else for (const attachmentId of dependency.attachmentIds) attachmentIds.add(attachmentId)
    }
    if (broad) {
      this.invalidateIds(this.demandCountById.keys())
      return
    }
    for (const fact of [
      ...(change.factsByKind['attachment-row-changed'] ?? []),
      ...(change.factsByKind['attachment-row-deleted'] ?? []),
    ]) {
      attachmentIds.add(fact.attachmentId)
    }
    this.invalidateIds(attachmentIds)
  }

  demand(attachmentIds: readonly AttachmentId[]): AttachmentDemand<Row> {
    if (this.disposed) throw new Error('AttachmentProjectionControllerDisposed')
    const demand = new TabAttachmentDemand(this)
    this.demands.add(demand)
    demand.update(attachmentIds)
    return demand
  }

  stats(): AttachmentProjectionControllerStats {
    return {
      demands: this.demands.size,
      demandedIds: this.demandCountById.size,
      loadedIds: this.loadedIds.size,
      pendingIds: this.dirtyIds.size,
      inFlightIds: this.inFlightIds.size,
      errorIds: this.errorsById.size,
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.abortRead()
    this.source = null
    this.sourceVerified = false
    this.workspaceFence = null
    for (const demand of [...this.demands]) demand.releaseFromController()
    this.demands.clear()
    this.demandsById.clear()
    this.demandCountById.clear()
    this.rowsById.clear()
    this.loadedIds.clear()
    this.dirtyIds.clear()
    this.inFlightIds.clear()
    this.blockedIds.clear()
    this.errorsById.clear()
    this.versionById.clear()
  }

  updateDemand(
    demand: TabAttachmentDemand<Row>,
    previousIds: readonly AttachmentId[],
    nextIds: readonly AttachmentId[],
  ): void {
    if (this.disposed || !this.demands.has(demand)) return
    const previous = new Set(previousIds)
    const next = new Set(nextIds)
    for (const attachmentId of previous) {
      if (!next.has(attachmentId)) this.releaseId(demand, attachmentId)
    }
    const added: AttachmentId[] = []
    for (const attachmentId of next) {
      if (previous.has(attachmentId)) continue
      this.retainId(demand, attachmentId)
      added.push(attachmentId)
    }
    demand.rebuild()
    if (added.length > 0) this.scheduleDrain()
  }

  releaseDemand(demand: TabAttachmentDemand<Row>, attachmentIds: readonly AttachmentId[]): void {
    if (!this.demands.delete(demand)) return
    for (const attachmentId of attachmentIds) this.releaseId(demand, attachmentId)
  }

  idState(attachmentId: AttachmentId): AttachmentIdState<Row> {
    return {
      loaded: this.loadedIds.has(attachmentId),
      busy: this.dirtyIds.has(attachmentId) || this.inFlightIds.has(attachmentId),
      blocked: this.blockedIds.has(attachmentId),
      row: this.rowsById.get(attachmentId),
      error: this.errorsById.get(attachmentId),
    }
  }

  currentWorkspaceFence(): WorkspaceFence | null {
    return this.workspaceFence
  }

  isSourceVerified(): boolean {
    return this.sourceVerified
  }

  private retainId(demand: TabAttachmentDemand<Row>, attachmentId: AttachmentId): void {
    const indexed = this.demandsById.get(attachmentId)
    if (indexed) indexed.add(demand)
    else this.demandsById.set(attachmentId, new Set([demand]))
    const count = this.demandCountById.get(attachmentId) ?? 0
    this.demandCountById.set(attachmentId, count + 1)
    if (count !== 0) return
    this.versionById.set(attachmentId, ++this.version)
    this.errorsById.delete(attachmentId)
    this.blockedIds.add(attachmentId)
    if (!this.loadedIds.has(attachmentId) && !this.inFlightIds.has(attachmentId)) {
      this.dirtyIds.add(attachmentId)
    }
  }

  private releaseId(demand: TabAttachmentDemand<Row>, attachmentId: AttachmentId): void {
    const indexed = this.demandsById.get(attachmentId)
    indexed?.delete(demand)
    if (indexed?.size === 0) this.demandsById.delete(attachmentId)
    const count = this.demandCountById.get(attachmentId)
    if (count === undefined) return
    if (count > 1) {
      this.demandCountById.set(attachmentId, count - 1)
      return
    }
    this.demandCountById.delete(attachmentId)
    this.rowsById.delete(attachmentId)
    this.loadedIds.delete(attachmentId)
    this.dirtyIds.delete(attachmentId)
    this.blockedIds.delete(attachmentId)
    this.errorsById.delete(attachmentId)
    this.versionById.set(attachmentId, ++this.version)
    if (!this.inFlightIds.has(attachmentId)) this.versionById.delete(attachmentId)
  }

  private invalidateIds(attachmentIds: Iterable<AttachmentId>): void {
    const affected: AttachmentId[] = []
    for (const attachmentId of attachmentIds) {
      if (!this.demandCountById.has(attachmentId)) continue
      this.versionById.set(attachmentId, ++this.version)
      this.errorsById.delete(attachmentId)
      this.dirtyIds.add(attachmentId)
      this.blockedIds.add(attachmentId)
      affected.push(attachmentId)
    }
    if (affected.length === 0) return
    this.publishIds(affected)
    this.scheduleDrain()
  }

  private resetRows(publish = true): void {
    this.generation += 1
    this.abortRead()
    this.rowsById.clear()
    this.loadedIds.clear()
    this.dirtyIds.clear()
    this.inFlightIds.clear()
    this.blockedIds.clear()
    this.errorsById.clear()
    this.versionById.clear()
    if (publish) this.publishAll()
  }

  private queueAllDemanded(): boolean {
    if (!this.source || !this.sourceVerified || !this.workspaceFence) return false
    const ids: AttachmentId[] = []
    for (const attachmentId of this.demandCountById.keys()) {
      this.versionById.set(attachmentId, ++this.version)
      this.errorsById.delete(attachmentId)
      this.dirtyIds.add(attachmentId)
      this.blockedIds.add(attachmentId)
      ids.push(attachmentId)
    }
    if (ids.length === 0) return false
    this.publishIds(ids)
    this.scheduleDrain()
    return true
  }

  private scheduleDrain(): void {
    if (
      this.disposed ||
      this.drainScheduled ||
      this.read ||
      !this.source ||
      !this.sourceVerified ||
      !this.workspaceFence ||
      this.dirtyIds.size === 0
    ) {
      return
    }
    this.drainScheduled = true
    queueMicrotask(() => {
      this.drainScheduled = false
      this.startRead()
    })
  }

  private startRead(): void {
    const source = this.source
    const workspaceFence = this.workspaceFence
    if (
      this.disposed ||
      this.read ||
      !source ||
      !this.sourceVerified ||
      !workspaceFence ||
      this.dirtyIds.size === 0
    ) {
      return
    }
    const attachmentIds: AttachmentId[] = []
    for (const attachmentId of this.dirtyIds) {
      this.dirtyIds.delete(attachmentId)
      if (!this.demandCountById.has(attachmentId)) continue
      attachmentIds.push(attachmentId)
      this.inFlightIds.add(attachmentId)
      if (attachmentIds.length === READ_BATCH_SIZE) break
    }
    if (attachmentIds.length === 0) {
      this.scheduleDrain()
      return
    }
    const versions = attachmentIds.map((attachmentId) => this.versionById.get(attachmentId))
    const generation = this.generation
    const controller = new AbortController()
    this.read = { generation, controller }
    let readPromise: Promise<AttachmentProjectionReadEnvelope<Row>>
    try {
      readPromise = source.loadRows(attachmentIds, controller.signal)
    } catch (error) {
      this.settleRead(
        generation,
        attachmentIds,
        versions,
        undefined,
        error ?? new Error('AttachmentProjectionReadFailed'),
      )
      return
    }
    void readPromise.then(
      (envelope) => {
        if (!sameWorkspaceFence(envelope, workspaceFence)) {
          this.settleRead(
            generation,
            attachmentIds,
            versions,
            undefined,
            new Error('AttachmentProjectionWorkspaceFenceMismatch'),
          )
          return
        }
        if (envelope.rows.length !== attachmentIds.length) {
          this.settleRead(
            generation,
            attachmentIds,
            versions,
            undefined,
            new Error('AttachmentProjectionReadLengthMismatch'),
          )
          return
        }
        this.settleRead(generation, attachmentIds, versions, envelope.rows)
      },
      (error: unknown) =>
        this.settleRead(
          generation,
          attachmentIds,
          versions,
          undefined,
          error ?? new Error('AttachmentProjectionReadFailed'),
        ),
    )
  }

  private settleRead(
    generation: number,
    attachmentIds: readonly AttachmentId[],
    versions: readonly (number | undefined)[],
    rows?: readonly (Row | undefined)[],
    error?: unknown,
  ): void {
    if (this.read?.generation === generation) this.read = null
    if (this.disposed || generation !== this.generation) return
    const changed: AttachmentId[] = []
    for (let index = 0; index < attachmentIds.length; index += 1) {
      const attachmentId = attachmentIds[index] as AttachmentId
      this.inFlightIds.delete(attachmentId)
      if (!this.demandCountById.has(attachmentId)) {
        this.versionById.delete(attachmentId)
        this.blockedIds.delete(attachmentId)
        continue
      }
      if (this.versionById.get(attachmentId) !== versions[index]) {
        this.dirtyIds.add(attachmentId)
        continue
      }
      if (error !== undefined) {
        this.errorsById.set(attachmentId, error)
        changed.push(attachmentId)
        continue
      }
      const row = rows?.[index]
      if (row !== undefined && row.id !== attachmentId) {
        this.errorsById.set(attachmentId, new Error('AttachmentProjectionReadKeyMismatch'))
        changed.push(attachmentId)
        continue
      }
      if (row === undefined) this.rowsById.delete(attachmentId)
      else this.rowsById.set(attachmentId, row)
      this.loadedIds.add(attachmentId)
      this.errorsById.delete(attachmentId)
      this.blockedIds.delete(attachmentId)
      changed.push(attachmentId)
    }
    if (changed.length > 0) this.publishIds(changed)
    this.scheduleDrain()
  }

  private abortRead(): void {
    this.read?.controller.abort()
    this.read = null
  }

  private publishIds(attachmentIds: readonly AttachmentId[]): void {
    const demands = new Set<TabAttachmentDemand<Row>>()
    for (const attachmentId of attachmentIds) {
      for (const demand of this.demandsById.get(attachmentId) ?? []) demands.add(demand)
    }
    for (const demand of demands) demand.refresh(attachmentIds)
  }

  private publishAll(): void {
    for (const demand of this.demands) demand.rebuild()
  }
}

class TabAttachmentDemand<Row extends AttachmentProjectionRow> implements AttachmentDemand<Row> {
  private readonly controller: TabAttachmentProjectionController<Row>
  private readonly listeners = new Set<() => void>()
  private attachmentIds: readonly AttachmentId[] = Object.freeze([])
  private attachmentIdSet: ReadonlySet<AttachmentId> = new Set()
  private statesById = new Map<AttachmentId, AttachmentIdState<Row>>()
  private rowsById = PersistentStringMap.empty<Row>()
  private errorsById = PersistentStringMap.empty<unknown>()
  private loadedCount = 0
  private busyCount = 0
  private blockedCount = 0
  private errorCount = 0
  private revision = 0
  private released = false
  private snapshot: AttachmentDemandSnapshot<Row> = Object.freeze({
    revision: 0,
    workspaceFence: null,
    status: 'ready',
    interactive: false,
    attachmentIds: Object.freeze([]),
    rowsById: PersistentStringMap.empty<Row>(),
    errorsById: PersistentStringMap.empty<unknown>(),
  })

  constructor(controller: TabAttachmentProjectionController<Row>) {
    this.controller = controller
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.released) return () => undefined
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  readonly getSnapshot = (): AttachmentDemandSnapshot<Row> => this.snapshot

  update(attachmentIds: readonly AttachmentId[]): void {
    if (this.released) throw new Error('AttachmentDemandReleased')
    const nextIds = normalizeAttachmentIds(attachmentIds)
    if (sameIds(this.attachmentIds, nextIds)) return
    const previousIds = this.attachmentIds
    this.attachmentIds = nextIds
    this.attachmentIdSet = new Set(nextIds)
    this.controller.updateDemand(this, previousIds, nextIds)
  }

  release(): void {
    if (this.released) return
    this.released = true
    this.controller.releaseDemand(this, this.attachmentIds)
    this.listeners.clear()
  }

  releaseFromController(): void {
    this.released = true
    this.listeners.clear()
  }

  refreshWorkspaceFenceIfEmpty(): void {
    if (this.attachmentIds.length === 0) this.publish()
  }

  rebuild(): void {
    this.statesById = new Map()
    this.rowsById = PersistentStringMap.empty()
    this.errorsById = PersistentStringMap.empty()
    this.loadedCount = 0
    this.busyCount = 0
    this.blockedCount = 0
    this.errorCount = 0
    for (const attachmentId of this.attachmentIds) {
      const state = this.controller.idState(attachmentId)
      this.statesById.set(attachmentId, state)
      this.addState(attachmentId, state)
    }
    this.publish()
  }

  refresh(attachmentIds: readonly AttachmentId[]): void {
    let changed = false
    for (const attachmentId of attachmentIds) {
      if (!this.attachmentIdSet.has(attachmentId)) continue
      const previous = this.statesById.get(attachmentId)
      const next = this.controller.idState(attachmentId)
      if (sameIdState(previous, next)) continue
      if (previous) this.removeState(attachmentId, previous)
      this.statesById.set(attachmentId, next)
      this.addState(attachmentId, next)
      changed = true
    }
    if (changed) this.publish()
  }

  private addState(attachmentId: AttachmentId, state: AttachmentIdState<Row>): void {
    if (state.loaded) this.loadedCount += 1
    if (state.busy) this.busyCount += 1
    if (state.blocked) this.blockedCount += 1
    if (state.row) this.rowsById = this.rowsById.set(attachmentId, state.row)
    if (state.error !== undefined) {
      this.errorCount += 1
      this.errorsById = this.errorsById.set(attachmentId, state.error)
    }
  }

  private removeState(attachmentId: AttachmentId, state: AttachmentIdState<Row>): void {
    if (state.loaded) this.loadedCount -= 1
    if (state.busy) this.busyCount -= 1
    if (state.blocked) this.blockedCount -= 1
    if (state.row) this.rowsById = this.rowsById.delete(attachmentId)
    if (state.error !== undefined) {
      this.errorCount -= 1
      this.errorsById = this.errorsById.delete(attachmentId)
    }
  }

  private publish(): void {
    this.snapshot = Object.freeze({
      revision: ++this.revision,
      workspaceFence: cloneWorkspaceFence(this.controller.currentWorkspaceFence()),
      status: this.status(),
      interactive:
        this.controller.isSourceVerified() &&
        this.loadedCount === this.attachmentIds.length &&
        this.blockedCount === 0 &&
        this.errorCount === 0,
      attachmentIds: this.attachmentIds,
      rowsById: this.rowsById,
      errorsById: this.errorsById,
    })
    for (const listener of [...this.listeners]) listener()
  }

  private status(): AttachmentDemandStatus {
    if (this.errorCount > 0) return 'error'
    if (this.loadedCount < this.attachmentIds.length) return 'loading'
    if (this.busyCount > 0) return 'refreshing'
    return 'ready'
  }
}

function normalizeAttachmentIds(attachmentIds: readonly AttachmentId[]): readonly AttachmentId[] {
  return Object.freeze([...new Set(attachmentIds)])
}

function sameIds(left: readonly AttachmentId[], right: readonly AttachmentId[]): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

function sameIdState<Row extends AttachmentProjectionRow>(
  left: AttachmentIdState<Row> | undefined,
  right: AttachmentIdState<Row>,
): boolean {
  return (
    left !== undefined &&
    left.loaded === right.loaded &&
    left.busy === right.busy &&
    left.blocked === right.blocked &&
    Object.is(left.row, right.row) &&
    Object.is(left.error, right.error)
  )
}

function sameWorkspaceFence(
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

function cloneWorkspaceFence(fence: WorkspaceFence | null): WorkspaceFence | null {
  return fence ? Object.freeze({ ...fence }) : null
}
