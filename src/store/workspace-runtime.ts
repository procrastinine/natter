import { errorFromUnknown } from '../lib/error'
import type { WorkspaceFence } from './repository'

export type WorkspaceRuntimeState =
  | 'STARTING'
  | 'RECONCILING'
  | 'RUNNING'
  | 'QUIESCING'
  | 'QUIESCED'
  | 'FAILED_CLOSED'
  | 'SEALED'

export type WorkspaceReplacementDisposition = 'block' | 'drain' | 'cancel'

export class WorkspaceMaintenancePreemptedError extends DOMException {
  constructor() {
    super('Foreground intent preempted maintenance', 'AbortError')
  }
}

export function isWorkspaceMaintenancePreemptedError(
  error: unknown,
): error is WorkspaceMaintenancePreemptedError {
  return (
    error instanceof WorkspaceMaintenancePreemptedError ||
    (!!error &&
      typeof error === 'object' &&
      'inner' in error &&
      error.inner instanceof WorkspaceMaintenancePreemptedError)
  )
}

export const WORKSPACE_ROOT_REPLACEMENT_DISPOSITIONS = Object.freeze({
  'conversation-generation': 'block',
  'stream-control': 'drain',
  'message-edit': 'drain',
  'message-structure': 'drain',
  'chat-fork': 'drain',
  'chat-metadata': 'drain',
  'workspace-organization': 'drain',
  configuration: 'drain',
  attachment: 'drain',
  'command-fanout': 'drain',
  'import-export': 'drain',
  'repository-query': 'cancel',
  'search-session': 'cancel',
  'cache-refresh': 'cancel',
  'stream-recovery': 'cancel',
  maintenance: 'cancel',
} as const satisfies Readonly<Record<string, WorkspaceReplacementDisposition>>)

export type WorkspaceRootKind = keyof typeof WORKSPACE_ROOT_REPLACEMENT_DISPOSITIONS

export type WorkspaceReplacementRootKind = Extract<
  WorkspaceRootKind,
  'command-fanout' | 'import-export' | 'maintenance'
>

type WorkspaceRootSubset<Kind extends WorkspaceRootKind> = Kind

export type WorkspaceExclusiveRootKind = WorkspaceRootSubset<
  'conversation-generation' | 'chat-fork'
>

export type WorkspaceChildKind =
  | 'generation-finalizer'
  | 'stream-lease'
  | 'stream-writer'
  | 'post-commit'
  | 'prompt-save'
  | 'attachment-localization'
  | 'recovery-finalizer'

interface WorkspacePermitStamp extends WorkspaceFence {
  readonly runtimeGeneration: number
  readonly lineageId: string
  readonly permitId: string
  readonly signal: AbortSignal
}

declare const workspaceReadPermitBrand: unique symbol
declare const workspaceWritePermitBrand: unique symbol
declare const workspaceReservedPermitBrand: unique symbol
declare const workspaceReconcileAuthorityBrand: unique symbol

export interface WorkspaceReadPermit extends WorkspacePermitStamp {
  readonly [workspaceReadPermitBrand]: true
}

export interface WorkspaceWritePermit extends WorkspaceReadPermit {
  readonly [workspaceWritePermitBrand]: true
}

export interface WorkspaceReservedPermit extends WorkspaceWritePermit {
  readonly [workspaceReservedPermitBrand]: true
}

export interface WorkspaceReconcileAuthority extends WorkspaceWritePermit {
  readonly [workspaceReconcileAuthorityBrand]: true
}

export interface WorkspaceRuntimeActionOptions {
  readonly signal?: AbortSignal
  readonly lineageId?: string
}

declare const workspaceRootAdmissionCapabilityBrand: unique symbol

export type WorkspaceRootAdmissionSource =
  | { readonly kindArgument: 0 }
  | { readonly fixedKind: WorkspaceRootKind }

export type WorkspaceRootAdmissionCapability<
  Signature,
  Source extends WorkspaceRootAdmissionSource,
> = Signature & {
  readonly [workspaceRootAdmissionCapabilityBrand]: Source
}

interface WorkspaceRuntimeDirtySnapshot extends WorkspaceFence {
  readonly broad: boolean
}

export interface WorkspaceRuntimeOpenedEvent {
  readonly kind: 'workspace-runtime-opened'
  readonly runtimeGeneration: number
  readonly workspaceId: string
  readonly replacementEpoch: number
  readonly dirty: WorkspaceRuntimeDirtySnapshot
}

type WorkspaceRuntimeListener = (event: WorkspaceRuntimeOpenedEvent) => void
type WorkspaceRuntimeIdleListener = () => void
type WorkspaceRuntimeStateListener = () => void
type WorkspaceRuntimeRootReleaseListener = () => void
type WorkspaceRuntimeQuiesceMode = 'graceful' | 'abortive'
type WorkspaceRuntimeDemandBoundary = () => Promise<void>

declare const workspaceRuntimeDemandBoundaryOwnerBrand: unique symbol

export interface WorkspaceRuntimeDemandBoundaryOwner {
  readonly [workspaceRuntimeDemandBoundaryOwnerBrand]: true
}

interface WorkspaceRuntimeDemandBoundaryOwnerRecord {
  readonly boundary: WorkspaceRuntimeDemandBoundary
  released: boolean
}

type PermitRecord = RootPermitRecord | ReservedPermitRecord | AuthorityPermitRecord

interface RootPermitRecord {
  readonly type: 'read-root' | 'write-root'
  readonly kind: WorkspaceRootKind
  readonly permit: WorkspaceReadPermit | WorkspaceWritePermit
  readonly controller: AbortController
  readonly unlink: () => void
  repositoryAdmissionOpen: boolean
  active: boolean
}

interface ReservedPermitRecord {
  readonly type: 'reserved-child'
  readonly permit: WorkspaceReservedPermit
  readonly controller: AbortController
  phase: 'reserved' | 'running' | 'released'
}

interface AuthorityPermitRecordBase {
  readonly permit: WorkspaceReconcileAuthority
  readonly controller: AbortController
  readonly unlink: () => void
  active: boolean
}

type AuthorityPermitRecord =
  | (AuthorityPermitRecordBase & {
      readonly type: 'replacement-authority'
      readonly rootKind: WorkspaceReplacementRootKind
    })
  | (AuthorityPermitRecordBase & {
      readonly type: 'reconcile-authority'
    })

interface RuntimeSnapshot {
  readonly state: WorkspaceRuntimeState
  readonly runtimeGeneration: number
  readonly workspaceId: string | null
  readonly replacementEpoch: number
}

interface ReconciliationOrigin {
  readonly state: 'STARTING' | 'QUIESCED' | 'FAILED_CLOSED'
  readonly workspaceId: string | null
  readonly replacementEpoch: number
  readonly gatedDirty: WorkspaceRuntimeDirtySnapshot | null
}

class WorkspaceRuntimeClosedError extends Error {
  readonly state: WorkspaceRuntimeState
  readonly operationKind: WorkspaceRootKind | WorkspaceChildKind | 'repository'

  constructor(
    operationKind: WorkspaceRootKind | WorkspaceChildKind | 'repository',
    runtimeState: WorkspaceRuntimeState,
  ) {
    super(`WorkspaceRuntimeClosed:${operationKind}:${runtimeState}`)
    this.name = 'WorkspaceRuntimeClosedError'
    this.operationKind = operationKind
    this.state = runtimeState
  }
}

class WorkspaceRuntimeEpochChangedError extends Error {
  readonly permitWorkspaceId: string
  readonly currentWorkspaceId: string | null
  readonly permitEpoch: number
  readonly currentEpoch: number

  constructor(
    permitWorkspaceId: string,
    permitEpoch: number,
    currentWorkspaceId: string | null,
    currentEpoch: number,
  ) {
    super(
      `WorkspaceRuntimeEpochChanged:${permitWorkspaceId}:${permitEpoch}:` +
        `${currentWorkspaceId ?? '__none__'}:${currentEpoch}`,
    )
    this.name = 'WorkspaceRuntimeEpochChangedError'
    this.permitWorkspaceId = permitWorkspaceId
    this.currentWorkspaceId = currentWorkspaceId
    this.permitEpoch = permitEpoch
    this.currentEpoch = currentEpoch
  }
}

export class WorkspaceRuntimeReplacementBlockedError extends Error {
  readonly blockerIds: readonly string[]

  constructor(blockerIds: readonly string[]) {
    super(`WorkspaceRuntimeReplacementBlocked:${blockerIds.join(',')}`)
    this.name = 'WorkspaceRuntimeReplacementBlockedError'
    this.blockerIds = Object.freeze([...blockerIds])
  }
}

export function isWorkspaceRuntimeClosedError(error: unknown): boolean {
  return (
    error instanceof WorkspaceRuntimeClosedError ||
    error instanceof WorkspaceRuntimeEpochChangedError
  )
}

export function createWorkspaceRuntimeKernel() {
  const permitRecords = new WeakMap<object, PermitRecord>()
  const activeRoots = new Set<RootPermitRecord>()
  const activeChildren = new Set<ReservedPermitRecord>()
  const listeners = new Set<WorkspaceRuntimeListener>()
  const idleListeners = new Set<WorkspaceRuntimeIdleListener>()
  const stateListeners = new Set<WorkspaceRuntimeStateListener>()
  const rootReleaseListeners = new Set<WorkspaceRuntimeRootReleaseListener>()

  let state: WorkspaceRuntimeState = 'STARTING'
  let runtimeGeneration = 0
  let workspaceId: string | null = null
  let replacementEpoch = 0
  let permitSequence = 0
  let activeCount = 0
  let idlePromise: Promise<void> = Promise.resolve()
  let resolveIdle: (() => void) | null = null
  let authority: AuthorityPermitRecord | null = null
  let gatedDirty: WorkspaceRuntimeDirtySnapshot | null = null
  let runtimeFenceSnapshot: WorkspaceFence | null = null
  let quiesceMode: WorkspaceRuntimeQuiesceMode | null = null
  let runtimeDemandBoundaryOwner: WorkspaceRuntimeDemandBoundaryOwnerRecord | null = null
  let reconciliationOrigin: ReconciliationOrigin | null = null

  function runWorkspaceRead<T>(
    kind: WorkspaceRootKind,
    operation: (permit: WorkspaceReadPermit) => T | PromiseLike<T>,
    options: WorkspaceRuntimeActionOptions = {},
  ): Promise<T> {
    return runRootWhenAvailable(kind, 'read-root', operation, options)
  }

  function runWorkspaceAction<T>(
    kind: WorkspaceRootKind,
    operation: (permit: WorkspaceWritePermit) => T | PromiseLike<T>,
    options: WorkspaceRuntimeActionOptions = {},
  ): Promise<T> {
    return runRootWhenAvailable(kind, 'write-root', operation, options)
  }

  function runWorkspaceActionAtFence<T>(
    kind: WorkspaceRootKind,
    fence: WorkspaceFence,
    operation: (permit: WorkspaceWritePermit) => T | PromiseLike<T>,
    options: WorkspaceRuntimeActionOptions = {},
  ): Promise<T> {
    if (options.signal?.aborted) throw options.signal.reason
    if (state !== 'RUNNING') {
      if (!preemptMaintenanceReplacementForDemand(kind) || !runtimeDemandBoundaryOwner) {
        throw new WorkspaceRuntimeClosedError(kind, state)
      }
      return waitForRootAdmission(kind, 'write-root', operation, options, fence)
    }
    assertRuntimeFence(fence)
    return runRoot(admitRoot(kind, 'write-root', options), operation)
  }

  function assertRuntimeFence(fence: WorkspaceFence): void {
    if (workspaceId !== fence.workspaceId || replacementEpoch !== fence.replacementEpoch) {
      throw new WorkspaceRuntimeEpochChangedError(
        fence.workspaceId,
        fence.replacementEpoch,
        workspaceId,
        replacementEpoch,
      )
    }
  }

  function claimWorkspaceRuntimeDemandBoundary(
    boundary: WorkspaceRuntimeDemandBoundary,
  ): WorkspaceRuntimeDemandBoundaryOwner {
    if (runtimeDemandBoundaryOwner) {
      throw new Error('WorkspaceRuntimeDemandBoundaryAlreadyInstalled')
    }
    const owner: WorkspaceRuntimeDemandBoundaryOwnerRecord = { boundary, released: false }
    runtimeDemandBoundaryOwner = owner
    return owner as unknown as WorkspaceRuntimeDemandBoundaryOwner
  }

  function releaseWorkspaceRuntimeDemandBoundary(
    handle: WorkspaceRuntimeDemandBoundaryOwner,
  ): void {
    const owner = handle as unknown as WorkspaceRuntimeDemandBoundaryOwnerRecord
    if (owner.released) return
    if (runtimeDemandBoundaryOwner !== owner) {
      throw new Error('WorkspaceRuntimeDemandBoundaryOwnerMismatch')
    }
    owner.released = true
    runtimeDemandBoundaryOwner = null
  }

  function tryRunWorkspaceActionIfIdle<T>(
    kind: WorkspaceRootKind,
    operation: (permit: WorkspaceWritePermit) => T | PromiseLike<T>,
    options: WorkspaceRuntimeActionOptions = {},
  ): Promise<T> | null {
    if (state !== 'RUNNING' || !hasNoActiveWork()) return null
    const record = admitRoot(kind, 'write-root', options)
    return runRoot(record, operation)
  }

  function reserveWorkspaceChild(
    parent: WorkspaceWritePermit | WorkspaceReservedPermit,
    kind: WorkspaceChildKind,
  ): WorkspaceReservedPermit {
    if (state !== 'RUNNING' && !(state === 'QUIESCING' && quiesceMode === 'graceful')) {
      throw new WorkspaceRuntimeClosedError(kind, state)
    }
    const parentRecord = permitRecord(parent)
    if (
      (parentRecord.type === 'write-root' &&
        (!parentRecord.active || !parentRecord.repositoryAdmissionOpen)) ||
      (parentRecord.type === 'reserved-child' && parentRecord.phase !== 'running')
    ) {
      throw new WorkspaceRuntimeClosedError(kind, state)
    }
    if (parentRecord.type !== 'write-root' && parentRecord.type !== 'reserved-child') {
      throw new WorkspaceRuntimeClosedError(kind, state)
    }
    assertCurrentEpoch(parent)
    const controller = new AbortController()
    const record = {} as ReservedPermitRecord
    const permit = createPermit<WorkspaceReservedPermit>(
      parent.lineageId,
      controller.signal,
      record,
    )
    Object.assign(record, {
      type: 'reserved-child',
      permit,
      controller,
      phase: 'reserved',
    } satisfies ReservedPermitRecord)
    activeChildren.add(record)
    beginTrackedWork()
    return permit
  }

  function runWorkspacePhase<T>(
    permit: WorkspaceReservedPermit,
    operation: (permit: WorkspaceReservedPermit) => T | PromiseLike<T>,
  ): Promise<T> {
    const record = permitRecord(permit)
    if (record.type !== 'reserved-child' || record.phase !== 'reserved') {
      throw new WorkspaceRuntimeClosedError('repository', state)
    }
    assertCurrentEpoch(permit)
    if (state === 'SEALED' || state === 'STARTING' || state === 'RECONCILING') {
      releaseReservedRecord(record)
      throw new WorkspaceRuntimeClosedError('repository', state)
    }
    record.phase = 'running'
    let result: T | PromiseLike<T>
    try {
      result = operation(permit)
    } catch (error) {
      result = Promise.reject(errorFromUnknown(error))
    }
    return Promise.resolve(result).finally(() => releaseReservedRecord(record))
  }

  function releaseWorkspaceChild(permit: WorkspaceReservedPermit): void {
    const record = permitRecord(permit)
    if (record.type !== 'reserved-child') return
    releaseReservedRecord(record)
  }

  function assertWorkspaceReadPermit(
    value: unknown,
  ): asserts value is WorkspaceReadPermit | WorkspaceReconcileAuthority {
    const record = permitRecord(value)
    assertCurrentEpoch(record.permit)
    if (record.type === 'read-root' || record.type === 'write-root') {
      if (!record.active || !record.repositoryAdmissionOpen) {
        throw new WorkspaceRuntimeClosedError('repository', state)
      }
      return
    }
    if (record.type === 'reserved-child') {
      if (record.phase !== 'running') throw new WorkspaceRuntimeClosedError('repository', state)
      return
    }
    assertAuthorityActive(record as AuthorityPermitRecord)
  }

  function assertWorkspaceExecutionPermit(
    value: unknown,
  ): asserts value is WorkspaceWritePermit | WorkspaceReservedPermit | WorkspaceReconcileAuthority {
    const record = permitRecord(value)
    assertCurrentEpoch(record.permit)
    if (record.type === 'write-root') {
      if (!record.active || !record.repositoryAdmissionOpen) {
        throw new WorkspaceRuntimeClosedError('repository', state)
      }
      return
    }
    if (record.type === 'reserved-child') {
      if (record.phase !== 'running') throw new WorkspaceRuntimeClosedError('repository', state)
      return
    }
    if (record.type === 'replacement-authority' || record.type === 'reconcile-authority') {
      assertAuthorityActive(record)
      return
    }
    throw new WorkspaceRuntimeClosedError('repository', state)
  }

  function subscribeWorkspaceRuntime(listener: WorkspaceRuntimeListener): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  function subscribeWorkspaceRuntimeIdle(listener: WorkspaceRuntimeIdleListener): () => void {
    idleListeners.add(listener)
    return () => idleListeners.delete(listener)
  }

  function subscribeWorkspaceRuntimeState(listener: WorkspaceRuntimeStateListener): () => void {
    stateListeners.add(listener)
    return () => stateListeners.delete(listener)
  }

  function waitForWorkspaceRuntimeReplacementBlockers(
    options: WorkspaceRuntimeActionOptions = {},
  ): Promise<void> {
    if (options.signal?.aborted) return Promise.reject(workspaceRuntimeError(options.signal.reason))
    if (replacementBlockerIds(options.lineageId).length === 0) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const dispose = () => {
        rootReleaseListeners.delete(attempt)
        stateListeners.delete(attempt)
        options.signal?.removeEventListener('abort', onAbort)
      }
      const settle = (operation: () => void) => {
        if (settled) return
        settled = true
        dispose()
        operation()
      }
      const attempt = () => {
        if (options.signal?.aborted) {
          settle(() => reject(workspaceRuntimeError(options.signal?.reason)))
          return
        }
        if (state !== 'RUNNING' || replacementBlockerIds(options.lineageId).length === 0) {
          settle(resolve)
        }
      }
      const onAbort = () => settle(() => reject(workspaceRuntimeError(options.signal?.reason)))
      rootReleaseListeners.add(attempt)
      stateListeners.add(attempt)
      options.signal?.addEventListener('abort', onAbort, { once: true })
      attempt()
    })
  }

  function launchReplacementWhenUnblocked(
    kind: WorkspaceReplacementRootKind,
    options: WorkspaceRuntimeActionOptions & { readonly requireIdle: boolean },
    enterQuiescing: () => void,
  ): Promise<WorkspaceReconcileAuthority | null> {
    if (options.signal?.aborted) return Promise.reject(workspaceRuntimeError(options.signal.reason))
    return new Promise<WorkspaceReconcileAuthority | null>((resolve, reject) => {
      let settled = false
      let promoting = false
      const dispose = () => {
        rootReleaseListeners.delete(attempt)
        idleListeners.delete(attempt)
        stateListeners.delete(attempt)
        options.signal?.removeEventListener('abort', onAbort)
      }
      const settle = (operation: () => void) => {
        if (settled) return
        settled = true
        dispose()
        operation()
      }
      const attempt = () => {
        if (settled || promoting) return
        if (options.signal?.aborted) {
          settle(() => reject(workspaceRuntimeError(options.signal?.reason)))
          return
        }
        if (state !== 'RUNNING') {
          settle(() => resolve(null))
          return
        }
        promoting = true
        try {
          const authority = launchReplacementNow(kind, options, enterQuiescing)
          if (authority) settle(() => resolve(authority))
        } catch (error) {
          if (!(error instanceof WorkspaceRuntimeReplacementBlockedError)) {
            settle(() => reject(workspaceRuntimeError(error)))
          }
        } finally {
          promoting = false
        }
      }
      const onAbort = () => settle(() => reject(workspaceRuntimeError(options.signal?.reason)))
      rootReleaseListeners.add(attempt)
      idleListeners.add(attempt)
      stateListeners.add(attempt)
      options.signal?.addEventListener('abort', onAbort, { once: true })
      attempt()
    })
  }

  function getWorkspaceRuntimeState(): WorkspaceRuntimeState {
    return state
  }

  function getWorkspaceRuntimeFence(): WorkspaceFence | null {
    if (workspaceId === null) {
      runtimeFenceSnapshot = null
      return null
    }
    if (
      runtimeFenceSnapshot?.workspaceId === workspaceId &&
      runtimeFenceSnapshot.replacementEpoch === replacementEpoch
    ) {
      return runtimeFenceSnapshot
    }
    runtimeFenceSnapshot = Object.freeze({ workspaceId, replacementEpoch })
    return runtimeFenceSnapshot
  }

  function isWorkspaceRuntimeReplacementTransitionOwned(): boolean {
    return authority?.type === 'replacement-authority' && authority.active
  }

  function admitRoot(
    kind: WorkspaceRootKind,
    type: RootPermitRecord['type'],
    options: WorkspaceRuntimeActionOptions,
  ): RootPermitRecord {
    if (state !== 'RUNNING') throw new WorkspaceRuntimeClosedError(kind, state)
    if (options.signal?.aborted) throw workspaceRuntimeError(options.signal.reason)
    const controller = new AbortController()
    const unlink = linkAbortSignal(options.signal, controller)
    const record = {} as RootPermitRecord
    const lineageId = options.lineageId ?? nextPermitId('lineage')
    const permit = createPermit<WorkspaceReadPermit | WorkspaceWritePermit>(
      lineageId,
      controller.signal,
      record,
    )
    Object.assign(record, {
      type,
      kind,
      permit,
      controller,
      repositoryAdmissionOpen: true,
      active: true,
      unlink,
    })
    activeRoots.add(record)
    beginTrackedWork()
    return record
  }

  function runRootWhenAvailable<T, P extends WorkspaceReadPermit>(
    kind: WorkspaceRootKind,
    type: RootPermitRecord['type'],
    operation: (permit: P) => T | PromiseLike<T>,
    options: WorkspaceRuntimeActionOptions,
  ): Promise<T> {
    if (options.signal?.aborted) throw options.signal.reason
    if (state === 'SEALED') throw new WorkspaceRuntimeClosedError(kind, 'SEALED')
    if (state === 'RUNNING') {
      return runRoot(admitRoot(kind, type, options), operation)
    }
    preemptMaintenanceReplacementForDemand(kind)
    if (!runtimeDemandBoundaryOwner) throw new WorkspaceRuntimeClosedError(kind, state)
    return waitForRootAdmission(kind, type, operation, options)
  }

  function preemptMaintenanceReplacementForDemand(kind: WorkspaceRootKind): boolean {
    if (WORKSPACE_ROOT_REPLACEMENT_DISPOSITIONS[kind] === 'cancel') return false
    const current = authority
    if (
      current?.type !== 'replacement-authority' ||
      current.rootKind !== 'maintenance' ||
      !current.active
    ) {
      return false
    }
    if (!current.controller.signal.aborted) {
      current.controller.abort(new WorkspaceMaintenancePreemptedError())
    }
    return true
  }

  async function waitForRootAdmission<T, P extends WorkspaceReadPermit>(
    kind: WorkspaceRootKind,
    type: RootPermitRecord['type'],
    operation: (permit: P) => T | PromiseLike<T>,
    options: WorkspaceRuntimeActionOptions,
    fence?: WorkspaceFence,
  ): Promise<T> {
    while (state !== 'RUNNING') {
      if (options.signal?.aborted) throw options.signal.reason
      if (state === 'SEALED') throw new WorkspaceRuntimeClosedError(kind, 'SEALED')
      const owner = runtimeDemandBoundaryOwner
      if (!owner) throw new WorkspaceRuntimeClosedError(kind, state)
      try {
        await waitForDemand(owner.boundary(), options.signal)
      } catch (error) {
        if (options.signal?.aborted) throw options.signal.reason
        if (currentSnapshot().state === 'SEALED') {
          throw new WorkspaceRuntimeClosedError(kind, 'SEALED')
        }
        throw error
      }
      if (runtimeDemandBoundaryOwner !== owner || owner.released) {
        throw new WorkspaceRuntimeClosedError(kind, state)
      }
    }
    if (options.signal?.aborted) throw options.signal.reason
    if (fence) assertRuntimeFence(fence)
    const record = admitRoot(kind, type, options)
    return runRoot(record, operation)
  }

  function waitForDemand(demand: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
    if (!signal) return demand
    if (signal.aborted) return Promise.reject(workspaceRuntimeError(signal.reason))
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (operation: () => void) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', abort)
        operation()
      }
      const abort = () => finish(() => reject(workspaceRuntimeError(signal.reason)))
      signal.addEventListener('abort', abort, { once: true })
      void demand.then(
        () => finish(resolve),
        (error: unknown) => finish(() => reject(workspaceRuntimeError(error))),
      )
    })
  }

  function workspaceRuntimeError(reason: unknown): Error {
    return reason instanceof Error ? reason : new Error('WorkspaceRuntimeFailed', { cause: reason })
  }

  function runRoot<T, P extends WorkspaceReadPermit>(
    record: RootPermitRecord,
    operation: (permit: P) => T | PromiseLike<T>,
  ): Promise<T> {
    let result: T | PromiseLike<T>
    try {
      result = operation(record.permit as P)
    } catch (error) {
      result = Promise.reject(errorFromUnknown(error))
    }
    return Promise.resolve(result).finally(() => releaseRootRecord(record))
  }

  function releaseRootRecord(record: RootPermitRecord): void {
    if (!record.active) return
    record.active = false
    record.unlink()
    activeRoots.delete(record)
    for (const listener of [...rootReleaseListeners]) listener()
    endTrackedWork()
  }

  function releaseReservedRecord(record: ReservedPermitRecord): void {
    if (record.phase === 'released') return
    record.phase = 'released'
    activeChildren.delete(record)
    endTrackedWork()
  }

  function createPermit<T extends WorkspacePermitStamp>(
    lineageId: string,
    signal: AbortSignal,
    record: PermitRecord,
  ): T {
    if (workspaceId === null) throw new WorkspaceRuntimeClosedError('repository', state)
    const permit = {
      runtimeGeneration,
      workspaceId,
      replacementEpoch,
      lineageId,
      permitId: nextPermitId('permit'),
      signal,
    } satisfies WorkspacePermitStamp
    const frozen = Object.freeze(permit) as unknown as T
    permitRecords.set(frozen, record)
    return frozen
  }

  function permitRecord(value: unknown): PermitRecord {
    if (!value || typeof value !== 'object')
      throw new WorkspaceRuntimeClosedError('repository', state)
    const record = permitRecords.get(value)
    if (!record || record.permit !== value) {
      throw new WorkspaceRuntimeClosedError('repository', state)
    }
    return record
  }

  function assertCurrentEpoch(permit: WorkspacePermitStamp): void {
    if (
      permit.runtimeGeneration !== runtimeGeneration ||
      permit.workspaceId !== workspaceId ||
      permit.replacementEpoch !== replacementEpoch
    ) {
      throw new WorkspaceRuntimeEpochChangedError(
        permit.workspaceId,
        permit.replacementEpoch,
        workspaceId,
        replacementEpoch,
      )
    }
  }

  function assertAuthorityActive(record: AuthorityPermitRecord): void {
    if (!record.active || authority !== record)
      throw new WorkspaceRuntimeClosedError('repository', state)
    if (record.type === 'replacement-authority') {
      if (state !== 'QUIESCING' && state !== 'QUIESCED') {
        throw new WorkspaceRuntimeClosedError('repository', state)
      }
      return
    }
    if (state !== 'RECONCILING') throw new WorkspaceRuntimeClosedError('repository', state)
  }

  function beginTrackedWork(): void {
    if (activeCount === 0) {
      idlePromise = new Promise<void>((resolve) => {
        resolveIdle = resolve
      })
    }
    activeCount += 1
  }

  function endTrackedWork(): void {
    activeCount -= 1
    if (activeCount !== 0) return
    const resolve = resolveIdle
    resolveIdle = null
    resolve?.()
    for (const listener of [...idleListeners]) listener()
  }

  function hasNoActiveWork(): boolean {
    const noPermits = activeRoots.size === 0 && activeChildren.size === 0
    if (noPermits !== (activeCount === 0)) throw new Error('WorkspaceRuntimeActivityMismatch')
    return noPermits
  }

  function nextPermitId(prefix: 'lineage' | 'permit'): string {
    permitSequence += 1
    return `${prefix}:${runtimeGeneration}:${permitSequence}`
  }

  function linkAbortSignal(source: AbortSignal | undefined, target: AbortController): () => void {
    if (!source) return () => {}
    if (source.aborted) {
      target.abort(source.reason)
      return () => {}
    }
    const abort = () => target.abort(source.reason)
    source.addEventListener('abort', abort, { once: true })
    return () => source.removeEventListener('abort', abort)
  }

  function currentSnapshot(): RuntimeSnapshot {
    return { state, runtimeGeneration, workspaceId, replacementEpoch }
  }

  function publishRuntimeState(): void {
    for (const listener of [...stateListeners]) listener()
  }

  function beginQuiesce(
    mode: WorkspaceRuntimeQuiesceMode = 'abortive',
    preservedRoot?: RootPermitRecord,
  ): void {
    if (
      state === 'SEALED' ||
      state === 'QUIESCED' ||
      state === 'FAILED_CLOSED' ||
      state === 'QUIESCING'
    ) {
      return
    }
    quiesceMode = mode
    state = 'QUIESCING'
    publishRuntimeState()
    if (workspaceId === null) throw new Error('WorkspaceRuntimeIdentityMissing')
    gatedDirty ??= { workspaceId, replacementEpoch, broad: false }
    if (mode === 'graceful') {
      cancelDisposableReplacementPeers(preservedRoot)
      return
    }
    for (const record of activeRoots) {
      record.repositoryAdmissionOpen = false
      record.controller.abort(new WorkspaceRuntimeClosedError('repository', 'QUIESCING'))
    }
    for (const record of [...activeChildren]) {
      record.controller.abort(new WorkspaceRuntimeClosedError('repository', 'QUIESCING'))
      if (record.phase === 'reserved') releaseReservedRecord(record)
    }
  }

  function cancelDisposableReplacementPeers(preservedRoot?: RootPermitRecord): void {
    const canceledLineages = new Set<string>()
    for (const record of activeRoots) {
      if (record === preservedRoot) continue
      if (WORKSPACE_ROOT_REPLACEMENT_DISPOSITIONS[record.kind] !== 'cancel') continue
      record.repositoryAdmissionOpen = false
      canceledLineages.add(record.permit.lineageId)
      record.controller.abort(new WorkspaceRuntimeClosedError(record.kind, 'QUIESCING'))
    }
    if (canceledLineages.size === 0) return
    for (const record of [...activeChildren]) {
      if (!canceledLineages.has(record.permit.lineageId)) continue
      record.controller.abort(new WorkspaceRuntimeClosedError('repository', 'QUIESCING'))
      if (record.phase === 'reserved') releaseReservedRecord(record)
    }
  }

  function beginGracefulQuiesce(): void {
    beginQuiesce('graceful')
  }

  function tryBeginQuiesceIfIdle(prepare: () => void): boolean {
    if (state !== 'RUNNING' || !hasNoActiveWork()) return false
    prepare()
    beginQuiesce('abortive')
    return true
  }

  async function awaitDrain(): Promise<void> {
    await idlePromise
  }

  function markQuiesced(): void {
    if (state !== 'QUIESCING') throw new Error(`WorkspaceRuntimeNotQuiescing:${state}`)
    if (activeCount !== 0) throw new Error('WorkspaceRuntimeStillActive')
    state = 'QUIESCED'
    publishRuntimeState()
  }

  function markFailedClosed(): void {
    if (state !== 'QUIESCING') throw new Error(`WorkspaceRuntimeNotQuiescing:${state}`)
    if (activeCount !== 0) throw new Error('WorkspaceRuntimeStillActive')
    state = 'FAILED_CLOSED'
    publishRuntimeState()
  }

  function sealAfterClosedInvariantFailure(): void {
    if (state !== 'QUIESCING' && state !== 'RECONCILING') {
      throw new Error(`WorkspaceRuntimeCannotSealAfterClosedInvariantFailure:${state}`)
    }
    if (authority) deactivateAuthorityRecord(authority)
    authority = null
    reconciliationOrigin = null
    state = 'SEALED'
    publishRuntimeState()
  }

  function launchReplacementNow(
    kind: WorkspaceReplacementRootKind,
    options: WorkspaceRuntimeActionOptions & { readonly requireIdle: boolean },
    enterQuiescing: () => void,
  ): WorkspaceReconcileAuthority | null {
    if (options.signal?.aborted) throw options.signal.reason
    const promotedRoot = replacementPromotedRoot(options.lineageId)
    const otherwiseIdle =
      activeChildren.size === 0 &&
      activeRoots.size === (promotedRoot === undefined ? 0 : 1) &&
      activeCount === (promotedRoot === undefined ? 0 : 1)
    if (state !== 'RUNNING' || (options.requireIdle && !otherwiseIdle)) return null
    const blockerIds = replacementBlockerIds(options.lineageId)
    if (blockerIds.length > 0) throw new WorkspaceRuntimeReplacementBlockedError(blockerIds)
    const root = promotedRoot ?? admitRoot(kind, 'write-root', options)
    if (authority) deactivateAuthorityRecord(authority)
    const record = {} as AuthorityPermitRecord
    const next = createPermit<WorkspaceReconcileAuthority>(
      root.permit.lineageId,
      root.controller.signal,
      record,
    )
    const transferredProducerOwnership = promotedRoot?.kind === 'maintenance'
    if (transferredProducerOwnership) root.unlink()
    Object.assign(record, {
      type: 'replacement-authority',
      rootKind: kind,
      permit: next,
      controller: root.controller,
      unlink: transferredProducerOwnership ? () => {} : root.unlink,
      active: true,
    } satisfies AuthorityPermitRecord)
    root.repositoryAdmissionOpen = false
    authority = record
    quiesceMode = 'graceful'
    state = 'QUIESCING'
    if (workspaceId === null) throw new Error('WorkspaceRuntimeIdentityMissing')
    gatedDirty ??= { workspaceId, replacementEpoch, broad: false }
    enterQuiescing()
    cancelDisposableReplacementPeers(root)
    root.active = false
    activeRoots.delete(root)
    publishRuntimeState()
    endTrackedWork()
    return next
  }

  function replacementPromotedRoot(lineageId: string | undefined): RootPermitRecord | undefined {
    const matchingRoots = lineageId
      ? [...activeRoots].filter((candidate) => candidate.permit.lineageId === lineageId)
      : []
    if (matchingRoots.length > 1) {
      throw new Error(`WorkspaceRuntimeReplacementLineageAmbiguous:${lineageId}`)
    }
    return matchingRoots[0]
  }

  function replacementBlockerIds(lineageId: string | undefined): string[] {
    const promotedRoot = replacementPromotedRoot(lineageId)
    return [...activeRoots]
      .filter(
        (candidate) =>
          candidate !== promotedRoot &&
          WORKSPACE_ROOT_REPLACEMENT_DISPOSITIONS[candidate.kind] === 'block',
      )
      .map((candidate) =>
        candidate.permit.lineageId.startsWith('generation:')
          ? candidate.permit.lineageId.slice('generation:'.length)
          : candidate.permit.permitId,
      )
      .sort()
  }

  function beginReconciliation(
    snapshot: {
      workspaceId: string
      replacementEpoch: number
    },
    signal?: AbortSignal,
  ): WorkspaceReconcileAuthority {
    if (signal?.aborted) throw signal.reason
    if (state !== 'STARTING' && state !== 'QUIESCED' && state !== 'FAILED_CLOSED') {
      throw new Error(`WorkspaceRuntimeCannotReconcile:${state}`)
    }
    if (snapshot.workspaceId.length === 0) throw new Error('WorkspaceRuntimeInvalidWorkspaceId')
    if (!Number.isSafeInteger(snapshot.replacementEpoch) || snapshot.replacementEpoch < 0) {
      throw new Error('WorkspaceRuntimeInvalidReplacementEpoch')
    }
    reconciliationOrigin = {
      state,
      workspaceId,
      replacementEpoch,
      gatedDirty,
    }
    runtimeGeneration += 1
    workspaceId = snapshot.workspaceId
    replacementEpoch = snapshot.replacementEpoch
    state = 'RECONCILING'
    quiesceMode = null
    publishRuntimeState()
    if (authority) deactivateAuthorityRecord(authority)
    const record = {} as AuthorityPermitRecord
    const controller = new AbortController()
    const unlink = linkAbortSignal(signal, controller)
    const permit = createPermit<WorkspaceReconcileAuthority>(
      nextPermitId('lineage'),
      controller.signal,
      record,
    )
    Object.assign(record, {
      type: 'reconcile-authority',
      permit,
      controller,
      unlink,
      active: true,
    } satisfies AuthorityPermitRecord)
    authority = record
    gatedDirty = {
      workspaceId,
      replacementEpoch,
      broad: true,
    }
    return permit
  }

  function noteGatedChange(change: {
    workspaceId: string
    replacementEpoch: number
    broad?: boolean
  }): boolean {
    if (change.workspaceId.length === 0) throw new Error('WorkspaceRuntimeInvalidWorkspaceId')
    if (!Number.isSafeInteger(change.replacementEpoch) || change.replacementEpoch < 0) {
      throw new Error('WorkspaceRuntimeInvalidReplacementEpoch')
    }
    if (state === 'RUNNING') return false
    const current = gatedDirty
    const sameWorkspace = current?.workspaceId === change.workspaceId
    gatedDirty = sameWorkspace
      ? {
          workspaceId: change.workspaceId,
          replacementEpoch: Math.max(current.replacementEpoch, change.replacementEpoch),
          broad: true,
        }
      : {
          workspaceId: change.workspaceId,
          replacementEpoch: change.replacementEpoch,
          broad: true,
        }
    return true
  }

  function finishReconciliation(snapshot?: {
    workspaceId: string
    replacementEpoch: number
  }): WorkspaceRuntimeOpenedEvent {
    if (state !== 'RECONCILING') throw new Error(`WorkspaceRuntimeNotReconciling:${state}`)
    if (snapshot) {
      if (snapshot.workspaceId !== workspaceId || snapshot.replacementEpoch !== replacementEpoch) {
        throw new Error('WorkspaceRuntimeReconciliationEpochChanged')
      }
    }
    if (workspaceId === null) throw new Error('WorkspaceRuntimeIdentityMissing')
    const dirty = gatedDirty ?? {
      workspaceId,
      replacementEpoch,
      broad: false,
    }
    if (dirty.workspaceId !== workspaceId || dirty.replacementEpoch > replacementEpoch) {
      throw new Error('WorkspaceRuntimeReconciliationSuperseded')
    }
    if (authority) deactivateAuthorityRecord(authority)
    authority = null
    reconciliationOrigin = null
    state = 'RUNNING'
    gatedDirty = null
    const event: WorkspaceRuntimeOpenedEvent = {
      kind: 'workspace-runtime-opened',
      runtimeGeneration,
      workspaceId,
      replacementEpoch,
      dirty,
    }
    publishRuntimeState()
    for (const listener of [...listeners]) listener(event)
    return event
  }

  function abortReconciliation(): void {
    if (state !== 'RECONCILING') return
    const origin = reconciliationOrigin
    if (!origin) throw new Error('WorkspaceRuntimeReconciliationOriginMissing')
    if (authority) deactivateAuthorityRecord(authority)
    authority = null
    state = origin.state
    workspaceId = origin.workspaceId
    replacementEpoch = origin.replacementEpoch
    gatedDirty = origin.gatedDirty
    reconciliationOrigin = null
    publishRuntimeState()
  }

  function seal(): void {
    if (state !== 'STARTING' && state !== 'QUIESCED' && state !== 'FAILED_CLOSED') {
      throw new Error(`WorkspaceRuntimeCannotSeal:${state}`)
    }
    if (authority) deactivateAuthorityRecord(authority)
    authority = null
    state = 'SEALED'
    publishRuntimeState()
  }

  function deactivateAuthorityRecord(record: AuthorityPermitRecord): void {
    if (!record.active) return
    record.active = false
    record.unlink()
    if (!record.controller.signal.aborted) {
      record.controller.abort(new WorkspaceRuntimeClosedError('repository', state))
    }
  }

  const internal = Object.freeze({
    snapshot: currentSnapshot,
    beginQuiesce,
    beginGracefulQuiesce,
    tryBeginQuiesceIfIdle,
    awaitDrain,
    markQuiesced,
    markFailedClosed,
    sealAfterClosedInvariantFailure,
    launchReplacementNow,
    launchReplacementWhenUnblocked,
    beginReconciliation,
    noteGatedChange,
    finishReconciliation,
    abortReconciliation,
    seal,
  })

  return Object.freeze({
    runWorkspaceRead,
    runWorkspaceAction,
    runWorkspaceActionAtFence,
    claimWorkspaceRuntimeDemandBoundary,
    releaseWorkspaceRuntimeDemandBoundary,
    tryRunWorkspaceActionIfIdle,
    reserveWorkspaceChild,
    runWorkspacePhase,
    releaseWorkspaceChild,
    assertWorkspaceReadPermit,
    assertWorkspaceExecutionPermit,
    subscribeWorkspaceRuntime,
    subscribeWorkspaceRuntimeIdle,
    subscribeWorkspaceRuntimeState,
    waitForWorkspaceRuntimeReplacementBlockers,
    getWorkspaceRuntimeState,
    getWorkspaceRuntimeFence,
    isWorkspaceRuntimeReplacementTransitionOwned,
    internal,
  })
}

export type WorkspaceRuntimeKernel = ReturnType<typeof createWorkspaceRuntimeKernel>

function exposeWorkspaceRootAdmission<Signature>(
  admission: Signature,
): WorkspaceRootAdmissionCapability<Signature, { readonly kindArgument: 0 }> {
  return admission as WorkspaceRootAdmissionCapability<Signature, { readonly kindArgument: 0 }>
}

const productionWorkspaceRuntime: WorkspaceRuntimeKernel = createWorkspaceRuntimeKernel()
const claimProductionWorkspaceRuntimeDemandBoundary =
  productionWorkspaceRuntime.claimWorkspaceRuntimeDemandBoundary
const subscribeProductionWorkspaceRuntime = productionWorkspaceRuntime.subscribeWorkspaceRuntime
const subscribeProductionWorkspaceRuntimeIdle =
  productionWorkspaceRuntime.subscribeWorkspaceRuntimeIdle
const subscribeProductionWorkspaceRuntimeState =
  productionWorkspaceRuntime.subscribeWorkspaceRuntimeState
const waitForProductionWorkspaceRuntimeReplacementBlockers =
  productionWorkspaceRuntime.waitForWorkspaceRuntimeReplacementBlockers
const assertProductionWorkspaceReadPermit: (
  value: unknown,
) => asserts value is WorkspaceReadPermit | WorkspaceReconcileAuthority =
  productionWorkspaceRuntime.assertWorkspaceReadPermit
const assertProductionWorkspaceExecutionPermit: (
  value: unknown,
) => asserts value is WorkspaceWritePermit | WorkspaceReservedPermit | WorkspaceReconcileAuthority =
  productionWorkspaceRuntime.assertWorkspaceExecutionPermit

export const runWorkspaceRead = exposeWorkspaceRootAdmission(
  productionWorkspaceRuntime.runWorkspaceRead,
)

export const runWorkspaceAction = exposeWorkspaceRootAdmission(
  productionWorkspaceRuntime.runWorkspaceAction,
)

export const runWorkspaceActionAtFence = exposeWorkspaceRootAdmission(
  productionWorkspaceRuntime.runWorkspaceActionAtFence,
)

export function claimWorkspaceRuntimeDemandBoundary(
  boundary: WorkspaceRuntimeDemandBoundary,
): WorkspaceRuntimeDemandBoundaryOwner {
  return claimProductionWorkspaceRuntimeDemandBoundary(boundary)
}

export function releaseWorkspaceRuntimeDemandBoundary(
  handle: WorkspaceRuntimeDemandBoundaryOwner,
): void {
  productionWorkspaceRuntime.releaseWorkspaceRuntimeDemandBoundary(handle)
}

export const tryRunWorkspaceActionIfIdle = exposeWorkspaceRootAdmission(
  productionWorkspaceRuntime.tryRunWorkspaceActionIfIdle,
)

export function reserveWorkspaceChild(
  parent: WorkspaceWritePermit | WorkspaceReservedPermit,
  kind: WorkspaceChildKind,
): WorkspaceReservedPermit {
  return productionWorkspaceRuntime.reserveWorkspaceChild(parent, kind)
}

export function runWorkspacePhase<T>(
  permit: WorkspaceReservedPermit,
  operation: (permit: WorkspaceReservedPermit) => T | PromiseLike<T>,
): Promise<T> {
  return productionWorkspaceRuntime.runWorkspacePhase(permit, operation)
}

export function releaseWorkspaceChild(permit: WorkspaceReservedPermit): void {
  productionWorkspaceRuntime.releaseWorkspaceChild(permit)
}

export function assertWorkspaceReadPermit(
  value: unknown,
): asserts value is WorkspaceReadPermit | WorkspaceReconcileAuthority {
  assertProductionWorkspaceReadPermit(value)
}

export function assertWorkspaceExecutionPermit(
  value: unknown,
): asserts value is WorkspaceWritePermit | WorkspaceReservedPermit | WorkspaceReconcileAuthority {
  assertProductionWorkspaceExecutionPermit(value)
}

export function subscribeWorkspaceRuntime(listener: WorkspaceRuntimeListener): () => void {
  return subscribeProductionWorkspaceRuntime(listener)
}

export function subscribeWorkspaceRuntimeIdle(listener: WorkspaceRuntimeIdleListener): () => void {
  return subscribeProductionWorkspaceRuntimeIdle(listener)
}

export function subscribeWorkspaceRuntimeState(
  listener: WorkspaceRuntimeStateListener,
): () => void {
  return subscribeProductionWorkspaceRuntimeState(listener)
}

export function waitForWorkspaceRuntimeReplacementBlockers(
  options: WorkspaceRuntimeActionOptions = {},
): Promise<void> {
  return waitForProductionWorkspaceRuntimeReplacementBlockers(options)
}

export function getWorkspaceRuntimeState(): WorkspaceRuntimeState {
  return productionWorkspaceRuntime.getWorkspaceRuntimeState()
}

export function getWorkspaceRuntimeFence(): WorkspaceFence | null {
  return productionWorkspaceRuntime.getWorkspaceRuntimeFence()
}

export function isWorkspaceRuntimeReplacementTransitionOwned(): boolean {
  return productionWorkspaceRuntime.isWorkspaceRuntimeReplacementTransitionOwned()
}

export const workspaceRuntimeInternal = productionWorkspaceRuntime.internal
