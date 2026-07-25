import type { WorkspaceFence } from './repository'

export interface MountedProjectionReconcileEvent {
  readonly fence: WorkspaceFence
  readonly replaced: boolean
}

export interface MountedProjectionLifecycleCallbacks {
  suspend(): void
  reconcile(event: MountedProjectionReconcileEvent): void
  resume(event: MountedProjectionReconcileEvent): void
  dispose(): void
}

export interface MountedProjectionLifecycle {
  isOpen(): boolean
  acceptedFence(): WorkspaceFence | null
  track<T>(promise: Promise<T>): Promise<T>
  dispose(): void
}

type RegistryPhase = 'running' | 'suspended' | 'awaiting-reconcile' | 'awaiting-open'

const projections = new Map<number, MountedProjectionLifecycleHandle>()
let nextProjectionId = 0
let phase: RegistryPhase = 'awaiting-reconcile'
let fence: WorkspaceFence | null = null
let pendingReconcile: MountedProjectionReconcileEvent | null = null
let physicalReads = 0
let readEpoch = 0
let idlePromise: Promise<void> = Promise.resolve()
let resolveIdle: (() => void) | null = null

export function mountRepositoryProjection(
  callbacks: MountedProjectionLifecycleCallbacks,
): MountedProjectionLifecycle {
  const handle = new MountedProjectionLifecycleHandle(++nextProjectionId, callbacks)
  projections.set(handle.id, handle)
  if (phase === 'awaiting-open') {
    const event = pendingReconcile
    if (!event) {
      handle.discardAfterMountFailure()
      throw new Error('MountedProjectionReconciliationMissing')
    }
    try {
      handle.reconcileFromRegistry(event)
    } catch (error) {
      handle.discardAfterMountFailure()
      throw new AggregateError([error], 'Mounted projection mount reconciliation failed', {
        cause: error,
      })
    }
  }
  return handle
}

export function suspendMountedRepositoryProjections(): void {
  if (phase === 'suspended') return
  phase = 'suspended'
  runProjectionPhase('Mounted projection suspension failed', (projection) =>
    projection.suspendFromRegistry(),
  )
}

export function resumeMountedRepositoryProjections(): void {
  phase = 'awaiting-reconcile'
}

export function reconcileMountedRepositoryProjections(nextFence: WorkspaceFence): void {
  const replaced = !sameFence(fence, nextFence)
  fence = Object.freeze({ ...nextFence })
  phase = 'awaiting-open'
  const event: MountedProjectionReconcileEvent = Object.freeze({ fence, replaced })
  pendingReconcile = event
  runProjectionPhase('Mounted projection reconciliation failed', (projection) =>
    projection.reconcileFromRegistry(event),
  )
}

export function openMountedRepositoryProjections(): void {
  const event = pendingReconcile
  if (!event) throw new Error('MountedProjectionReconciliationMissing')
  pendingReconcile = null
  phase = 'running'
  runProjectionPhase('Mounted projection resume failed', (projection) =>
    projection.resumeFromRegistry(event),
  )
}

export function awaitMountedRepositoryProjectionsIdle(): Promise<void> {
  return idlePromise
}

export function attachMountedRepositoryProjections(nextFence: WorkspaceFence): void {
  resumeMountedRepositoryProjections()
  reconcileMountedRepositoryProjections(nextFence)
  openMountedRepositoryProjections()
}

export function assertMountedRepositoryProjectionsClosed(): void {
  if (phase === 'running' || physicalReads !== 0) {
    throw new Error('MountedRepositoryProjectionsNotClosed')
  }
}

export function resetMountedRepositoryProjectionsForTests(): void {
  const mounted = [...projections.values()]
  projections.clear()
  nextProjectionId = 0
  phase = 'awaiting-reconcile'
  fence = null
  pendingReconcile = null
  physicalReads = 0
  readEpoch += 1
  resolveIdle?.()
  resolveIdle = null
  idlePromise = Promise.resolve()
  runProjectionPhase(
    'Mounted projection test reset failed',
    (projection) => projection.disposeFromRegistry(),
    mounted,
  )
}

class MountedProjectionLifecycleHandle implements MountedProjectionLifecycle {
  readonly id: number
  private readonly callbacks: MountedProjectionLifecycleCallbacks
  private disposed = false
  private open = phase === 'running'

  constructor(id: number, callbacks: MountedProjectionLifecycleCallbacks) {
    this.id = id
    this.callbacks = callbacks
  }

  isOpen(): boolean {
    return !this.disposed && this.open
  }

  acceptedFence(): WorkspaceFence | null {
    return cloneFence(fence)
  }

  track<T>(promise: Promise<T>): Promise<T> {
    if (this.disposed) return promise
    const epoch = beginRead()
    return promise.finally(() => endRead(epoch))
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.open = false
    projections.delete(this.id)
  }

  suspendFromRegistry(): void {
    if (this.disposed || !this.open) return
    this.open = false
    this.callbacks.suspend()
  }

  reconcileFromRegistry(event: MountedProjectionReconcileEvent): void {
    if (this.disposed) return
    this.open = false
    this.callbacks.reconcile(event)
  }

  resumeFromRegistry(event: MountedProjectionReconcileEvent): void {
    if (this.disposed) return
    this.open = true
    this.callbacks.resume(event)
  }

  disposeFromRegistry(): void {
    if (this.disposed) return
    this.open = false
    this.disposed = true
    this.callbacks.dispose()
  }

  discardAfterMountFailure(): void {
    this.open = false
    this.disposed = true
    projections.delete(this.id)
  }
}

function runProjectionPhase(
  message: string,
  operation: (projection: MountedProjectionLifecycleHandle) => void,
  mounted: readonly MountedProjectionLifecycleHandle[] = [...projections.values()],
): void {
  const errors: unknown[] = []
  for (const projection of mounted) {
    try {
      operation(projection)
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, message)
}

function beginRead(): number {
  if (physicalReads === 0) {
    idlePromise = new Promise<void>((resolve) => {
      resolveIdle = resolve
    })
  }
  physicalReads += 1
  return readEpoch
}

function endRead(epoch: number): void {
  if (epoch !== readEpoch) return
  physicalReads -= 1
  if (physicalReads !== 0) return
  const resolve = resolveIdle
  resolveIdle = null
  resolve?.()
}

function sameFence(left: WorkspaceFence | null, right: WorkspaceFence): boolean {
  return (
    left !== null &&
    left.workspaceId === right.workspaceId &&
    left.replacementEpoch === right.replacementEpoch
  )
}

function cloneFence(value: WorkspaceFence | null): WorkspaceFence | null {
  return value ? Object.freeze({ ...value }) : null
}
