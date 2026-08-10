import { raceWithAbortSignal } from '../lib/abort'
import { browserLocalStorage } from '../lib/browser-storage'
import { errorFromUnknown } from '../lib/error'
import {
  BROWSER_WORKSPACE_DATABASE_NAMES,
  type BrowserWorkspaceDatabaseName,
} from '../lib/origin-storage-names'
import { newId } from '../lib/ulid'

const SLOT_CHANNEL_NAME = 'natter-workspace-slot-control:v1'
const SLOT_SIGNAL_KEY = 'natter:workspace-slot-control:v1'
const SLOT_LOCK_PREFIX = 'natter:workspace-slot:'
const SLOT_SELECTION_GATE_LOCK = 'natter:workspace-slot-selection:v1'

interface WorkspaceSlotQuiesceMessage {
  readonly kind: 'quiesce'
  readonly senderId: string
  readonly nonce: string
  readonly sourceDatabaseName: BrowserWorkspaceDatabaseName
  readonly destinationDatabaseName: BrowserWorkspaceDatabaseName
}

type WorkspaceSlotMessage = WorkspaceSlotQuiesceMessage

export interface BrowserWorkspaceSlotTransition {
  readonly nonce: string
  readonly sourceDatabaseName: BrowserWorkspaceDatabaseName
  readonly destinationDatabaseName: BrowserWorkspaceDatabaseName
}

interface WorkspaceSlotLifecycle {
  validateQuiesce(transition: BrowserWorkspaceSlotTransition, signal: AbortSignal): Promise<boolean>
  reconcile(transition: BrowserWorkspaceSlotTransition, signal: AbortSignal): Promise<void>
}

declare const browserWorkspaceSlotCoordinatorOwnerBrand: unique symbol

export interface BrowserWorkspaceSlotCoordinatorOwner {
  readonly [browserWorkspaceSlotCoordinatorOwnerBrand]: true
}

interface BrowserWorkspaceSlotCoordinatorOwnerRecord {
  readonly lifecycle: WorkspaceSlotLifecycle
  readonly controller: AbortController
  readonly disposalReason: Error
  inbound: Promise<void>
  channel: BroadcastChannel | null
  channelUnavailable: boolean
  storageListener: ((event: StorageEvent) => void) | null
  active: boolean
}

interface WorkspaceSlotLockManager {
  request<T>(
    name: string,
    options: {
      mode: 'shared' | 'exclusive'
      ifAvailable?: boolean
      signal?: AbortSignal
    },
    callback: (lock: Lock | null) => Promise<T> | T,
  ): Promise<T>
}

declare const browserWorkspaceSelectionGrantBrand: unique symbol

export interface BrowserWorkspaceSelectionGrant {
  readonly mode: 'exclusive'
  readonly [browserWorkspaceSelectionGrantBrand]: true
}

export type BrowserWorkspaceSlotOperation<T> =
  | { readonly kind: 'transient-probe'; readonly run: () => Promise<T> }
  | { readonly kind: 'retained'; readonly run: () => Promise<T> }

declare const browserWorkspaceSlotLeaseBrand: unique symbol

export interface BrowserWorkspaceSlotLeaseHandle {
  readonly databaseName: BrowserWorkspaceDatabaseName
  readonly [browserWorkspaceSlotLeaseBrand]: true
}

interface WorkspaceSlotLease {
  readonly databaseName: BrowserWorkspaceDatabaseName
  readonly release: () => void
  readonly done: Promise<void>
  released: boolean
}

const senderId = newId()
let coordinatorOwner: BrowserWorkspaceSlotCoordinatorOwnerRecord | null = null
let activeLease: WorkspaceSlotLease | null = null

export function installBrowserWorkspaceSlotCoordinator(
  lifecycle: WorkspaceSlotLifecycle,
): BrowserWorkspaceSlotCoordinatorOwner {
  if (coordinatorOwner) throw new Error('BrowserWorkspaceSlotCoordinatorAlreadyInstalled')
  const owner: BrowserWorkspaceSlotCoordinatorOwnerRecord = {
    lifecycle,
    controller: new AbortController(),
    disposalReason: new Error('BrowserWorkspaceSlotCoordinatorDisposed'),
    inbound: Promise.resolve(),
    channel: null,
    channelUnavailable: false,
    storageListener: null,
    active: true,
  }
  ensureSlotTransport(owner)
  coordinatorOwner = owner
  return owner as unknown as BrowserWorkspaceSlotCoordinatorOwner
}

export function disposeBrowserWorkspaceSlotCoordinator(
  handle: BrowserWorkspaceSlotCoordinatorOwner,
): void {
  const owner = handle as unknown as BrowserWorkspaceSlotCoordinatorOwnerRecord
  if (!owner.active) return
  if (coordinatorOwner !== owner) throw new Error('BrowserWorkspaceSlotCoordinatorOwnerMismatch')
  owner.active = false
  coordinatorOwner = null
  owner.controller.abort(owner.disposalReason)
  const failures: unknown[] = []
  const channel = owner.channel
  owner.channel = null
  owner.channelUnavailable = false
  try {
    channel?.close()
  } catch (error) {
    failures.push(error)
  }
  const storageListener = owner.storageListener
  owner.storageListener = null
  if (storageListener && typeof window !== 'undefined') {
    try {
      window.removeEventListener('storage', storageListener)
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'BrowserWorkspaceSlotCoordinatorDisposalFailed')
  }
}

export async function awaitBrowserWorkspaceSlotCoordinatorIdle(
  handle: BrowserWorkspaceSlotCoordinatorOwner,
): Promise<void> {
  const owner = handle as unknown as BrowserWorkspaceSlotCoordinatorOwnerRecord
  await owner.inbound
}

export function browserWorkspaceSlotSwitchingSupported(): boolean {
  return slotLockManager() !== null && slotTransportSupported()
}

export function withBrowserWorkspaceSelectionGate<T>(
  operation: (grant: BrowserWorkspaceSelectionGrant) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) return Promise.reject(workspaceSlotAbortError(signal.reason))
  const manager = slotLockManager()
  if (!manager) return operation({ mode: 'exclusive' } as BrowserWorkspaceSelectionGrant)
  return manager.request(
    SLOT_SELECTION_GATE_LOCK,
    { mode: 'exclusive', ...(signal ? { signal } : {}) },
    (lock) => {
      if (!lock) throw new Error('BrowserWorkspaceSelectionGateUnavailable')
      if (signal?.aborted) throw workspaceSlotAbortError(signal.reason)
      return operation({ mode: 'exclusive' } as BrowserWorkspaceSelectionGrant)
    },
  )
}

export function withBrowserWorkspaceSlotOperation<T>(
  databaseName: BrowserWorkspaceDatabaseName,
  operation: BrowserWorkspaceSlotOperation<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) return Promise.reject(workspaceSlotAbortError(signal.reason))
  if (operation.kind === 'transient-probe') {
    return withBrowserWorkspacePhysicalSlotProbe(databaseName, operation.run, signal)
  }
  const manager = slotLockManager()
  if (!manager) return operation.run()
  return manager.request(
    SLOT_SELECTION_GATE_LOCK,
    { mode: 'shared', ...(signal ? { signal } : {}) },
    (lock) => {
      if (!lock) throw new Error('BrowserWorkspaceSlotProbeAdmissionUnavailable')
      if (signal?.aborted) throw workspaceSlotAbortError(signal.reason)
      return withBrowserWorkspacePhysicalSlotProbe(databaseName, operation.run, signal)
    },
  )
}

function withBrowserWorkspacePhysicalSlotProbe<T>(
  databaseName: BrowserWorkspaceDatabaseName,
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) return Promise.reject(workspaceSlotAbortError(signal.reason))
  const manager = slotLockManager()
  if (!manager) return operation()
  return manager.request(
    slotLockName(databaseName),
    { mode: 'shared', ...(signal ? { signal } : {}) },
    (lock) => {
      if (!lock) throw new Error('BrowserWorkspaceSlotProbeUnavailable')
      if (signal?.aborted) throw workspaceSlotAbortError(signal.reason)
      return operation()
    },
  )
}

export async function tryWithBrowserWorkspaceSelectionGate<T>(
  operation: (grant: BrowserWorkspaceSelectionGrant) => Promise<T>,
  signal?: AbortSignal,
): Promise<{ acquired: false } | { acquired: true; value: T }> {
  if (signal?.aborted) throw workspaceSlotAbortError(signal.reason)
  const manager = slotLockManager()
  if (!manager) return { acquired: false }
  return new Promise((resolve, reject) => {
    let callbackStarted = false
    let settled = false
    const finish = (publish: () => void) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', abort)
      publish()
    }
    const abort = () => {
      if (callbackStarted) return
      finish(() => reject(workspaceSlotAbortError(signal?.reason)))
    }
    signal?.addEventListener('abort', abort, { once: true })
    let request: Promise<{ acquired: false } | { acquired: true; value: T }>
    try {
      request = manager.request(
        SLOT_SELECTION_GATE_LOCK,
        { mode: 'exclusive', ifAvailable: true },
        async (lock) => {
          callbackStarted = true
          signal?.removeEventListener('abort', abort)
          if (!lock) return { acquired: false }
          if (signal?.aborted) throw workspaceSlotAbortError(signal.reason)
          return {
            acquired: true,
            value: await operation({ mode: 'exclusive' } as BrowserWorkspaceSelectionGrant),
          }
        },
      )
    } catch (error) {
      finish(() => reject(errorFromUnknown(error)))
      return
    }
    void request.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(errorFromUnknown(error))),
    )
  })
}

export async function acquireBrowserWorkspaceSlotLease(
  databaseName: BrowserWorkspaceDatabaseName,
  signal?: AbortSignal,
): Promise<BrowserWorkspaceSlotLeaseHandle> {
  if (signal?.aborted) throw workspaceSlotAbortError(signal.reason)
  if (activeLease?.databaseName === databaseName) {
    return activeLease as unknown as BrowserWorkspaceSlotLeaseHandle
  }
  if (activeLease) throw new Error('BrowserWorkspaceSlotLeaseAlreadyHeld')
  const manager = slotLockManager()
  if (!manager) {
    const lease: WorkspaceSlotLease = {
      databaseName,
      release: () => undefined,
      done: Promise.resolve(),
      released: false,
    }
    activeLease = lease
    return lease as unknown as BrowserWorkspaceSlotLeaseHandle
  }
  let release!: () => void
  let resolveReady!: () => void
  let rejectReady!: (error: unknown) => void
  const hold = new Promise<void>((resolve) => {
    release = resolve
  })
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  const done = manager
    .request<void>(
      slotLockName(databaseName),
      { mode: 'shared', ...(signal ? { signal } : {}) },
      async (lock) => {
        if (!lock) throw new Error('BrowserWorkspaceSlotSharedLockUnavailable')
        if (signal?.aborted) throw workspaceSlotAbortError(signal.reason)
        resolveReady()
        await hold
      },
    )
    .catch((error: unknown) => {
      rejectReady(error)
      throw error
    })
  const lease: WorkspaceSlotLease = { databaseName, release, done, released: false }
  activeLease = lease
  try {
    await ready
    return lease as unknown as BrowserWorkspaceSlotLeaseHandle
  } catch (error) {
    if (activeLease === lease) activeLease = null
    lease.released = true
    void done.catch(() => {})
    throw error
  }
}

export async function releaseBrowserWorkspaceSlotLease(
  handle: BrowserWorkspaceSlotLeaseHandle,
): Promise<void> {
  const lease = handle as unknown as WorkspaceSlotLease
  if (lease.released) return
  if (activeLease !== lease) throw new Error('BrowserWorkspaceSlotLeaseOwnerMismatch')
  activeLease = null
  lease.released = true
  lease.release()
  await lease.done
}

export function postBrowserWorkspaceSlotQuiesce(message: {
  nonce: string
  sourceDatabaseName: BrowserWorkspaceDatabaseName
  destinationDatabaseName: BrowserWorkspaceDatabaseName
}): void {
  postSlotMessage({ kind: 'quiesce', senderId, ...message })
}

export async function withExclusiveBrowserWorkspaceSlots<T>(
  _selection: BrowserWorkspaceSelectionGrant,
  databaseNames: readonly BrowserWorkspaceDatabaseName[],
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw workspaceSlotAbortError(signal.reason)
  const manager = slotLockManager()
  if (!manager) throw new Error('BrowserWorkspaceSlotLocksUnavailable')
  const names = [...new Set(databaseNames)].sort((left, right) => left.localeCompare(right))
  const acquire = (index: number): Promise<T> => {
    if (index >= names.length) return operation()
    const databaseName = names[index] as BrowserWorkspaceDatabaseName
    return manager.request(
      slotLockName(databaseName),
      { mode: 'exclusive', ...(signal ? { signal } : {}) },
      (lock) => {
        if (!lock) throw new Error('BrowserWorkspaceSlotExclusiveLockUnavailable')
        if (signal?.aborted) throw workspaceSlotAbortError(signal.reason)
        return acquire(index + 1)
      },
    )
  }
  return acquire(0)
}

export async function tryWithExclusiveBrowserWorkspaceSlot<T>(
  _selection: BrowserWorkspaceSelectionGrant,
  databaseName: BrowserWorkspaceDatabaseName,
  operation: () => Promise<T>,
): Promise<{ acquired: false } | { acquired: true; value: T }> {
  const manager = slotLockManager()
  if (!manager) return { acquired: false }
  return manager.request(
    slotLockName(databaseName),
    { mode: 'exclusive', ifAvailable: true },
    async (lock) => {
      if (!lock) return { acquired: false }
      return { acquired: true, value: await operation() }
    },
  )
}

export function __resetBrowserWorkspaceSlotCoordinatorForTests(): void {
  const owner = coordinatorOwner
  if (owner) {
    disposeBrowserWorkspaceSlotCoordinator(owner as unknown as BrowserWorkspaceSlotCoordinatorOwner)
  }
  const lease = activeLease
  activeLease = null
  if (!lease || lease.released) return
  lease.released = true
  lease.release()
  void lease.done.catch(() => {})
}

function ensureSlotTransport(owner: BrowserWorkspaceSlotCoordinatorOwnerRecord): void {
  const previousChannel = owner.channel
  const previousChannelUnavailable = owner.channelUnavailable
  const previousStorageListener = owner.storageListener
  try {
    if (!owner.channel && !owner.channelUnavailable && typeof BroadcastChannel !== 'undefined') {
      let nextChannel: BroadcastChannel | null = null
      try {
        const openedChannel = new BroadcastChannel(SLOT_CHANNEL_NAME)
        nextChannel = openedChannel
        openedChannel.addEventListener('message', (event) => receiveSlotMessage(owner, event.data))
        openedChannel.addEventListener('messageerror', () => {
          if (owner.channel !== openedChannel) return
          openedChannel.close()
          owner.channel = null
          owner.channelUnavailable = true
        })
        owner.channel = openedChannel
      } catch {
        nextChannel?.close()
        owner.channel = null
        owner.channelUnavailable = true
      }
    }
    if (!owner.storageListener && typeof window !== 'undefined') {
      const listener = (event: StorageEvent) => receiveStorageSignal(owner, event)
      window.addEventListener('storage', listener)
      owner.storageListener = listener
    }
  } catch (error) {
    if (!previousStorageListener && owner.storageListener && typeof window !== 'undefined') {
      window.removeEventListener('storage', owner.storageListener)
    }
    owner.storageListener = previousStorageListener
    if (owner.channel !== previousChannel) owner.channel?.close()
    owner.channel = previousChannel
    owner.channelUnavailable = previousChannelUnavailable
    throw error
  }
}

function slotTransportSupported(): boolean {
  if (typeof BroadcastChannel !== 'undefined') return true
  try {
    const storage = browserLocalStorage()
    if (!storage) return false
    storage.getItem(SLOT_SIGNAL_KEY)
    return true
  } catch {
    return false
  }
}

function postSlotMessage(message: WorkspaceSlotMessage): void {
  const owner = coordinatorOwner
  if (!owner?.active) throw new Error('BrowserWorkspaceSlotCoordinatorUnavailable')
  ensureSlotTransport(owner)
  let delivered = false
  try {
    owner.channel?.postMessage(message)
    delivered = owner.channel !== null
  } catch {
    owner.channel?.close()
    owner.channel = null
    owner.channelUnavailable = true
  }
  if (delivered) return
  try {
    const storage = browserLocalStorage()
    if (!storage) throw new Error('BrowserWorkspaceSlotTransportUnavailable')
    storage.setItem(SLOT_SIGNAL_KEY, JSON.stringify(message))
  } catch {
    throw new Error('BrowserWorkspaceSlotTransportUnavailable')
  }
}

function receiveStorageSignal(
  owner: BrowserWorkspaceSlotCoordinatorOwnerRecord,
  event: StorageEvent,
): void {
  if (event.key !== SLOT_SIGNAL_KEY || event.newValue === null) return
  try {
    receiveSlotMessage(owner, JSON.parse(event.newValue))
  } catch {
    return
  }
}

function receiveSlotMessage(
  owner: BrowserWorkspaceSlotCoordinatorOwnerRecord,
  value: unknown,
): void {
  if (!isSlotMessage(value) || value.senderId === senderId) return
  if (!owner.active || coordinatorOwner !== owner) return
  owner.inbound = owner.inbound
    .then(async () => {
      assertSlotCoordinatorOwnerActive(owner)
      const target = owner.lifecycle
      if (activeLease?.databaseName !== value.sourceDatabaseName) return
      const transition = transitionFromMessage(value)
      const valid = await raceWithAbortSignal(
        () => target.validateQuiesce(transition, owner.controller.signal),
        owner.controller.signal,
      )
      assertSlotCoordinatorOwnerActive(owner)
      if (!valid) return
      await raceWithAbortSignal(
        () => target.reconcile(transition, owner.controller.signal),
        owner.controller.signal,
      )
      assertSlotCoordinatorOwnerActive(owner)
    })
    .catch((error: unknown) => {
      if (!owner.active || coordinatorOwner !== owner) return
      console.error('Browser workspace slot transition failed', error)
      queueMicrotask(() => {
        const location = (globalThis as unknown as { readonly location?: Location }).location
        location?.reload()
      })
    })
}

function assertSlotCoordinatorOwnerActive(owner: BrowserWorkspaceSlotCoordinatorOwnerRecord): void {
  if (owner.active && coordinatorOwner === owner && !owner.controller.signal.aborted) {
    return
  }
  throw owner.disposalReason
}

function isSlotMessage(value: unknown): value is WorkspaceSlotMessage {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<WorkspaceSlotMessage>
  return (
    candidate.kind === 'quiesce' &&
    typeof candidate.senderId === 'string' &&
    typeof candidate.nonce === 'string' &&
    candidate.nonce.length > 0 &&
    BROWSER_WORKSPACE_DATABASE_NAMES.includes(
      candidate.sourceDatabaseName as BrowserWorkspaceDatabaseName,
    ) &&
    BROWSER_WORKSPACE_DATABASE_NAMES.includes(
      candidate.destinationDatabaseName as BrowserWorkspaceDatabaseName,
    ) &&
    candidate.sourceDatabaseName !== candidate.destinationDatabaseName
  )
}

function transitionFromMessage(message: WorkspaceSlotMessage): BrowserWorkspaceSlotTransition {
  return {
    nonce: message.nonce,
    sourceDatabaseName: message.sourceDatabaseName,
    destinationDatabaseName: message.destinationDatabaseName,
  }
}

function slotLockManager(): WorkspaceSlotLockManager | null {
  if (typeof navigator === 'undefined') return null
  const manager = (navigator as unknown as { readonly locks?: WorkspaceSlotLockManager }).locks
  return manager && typeof manager.request === 'function' ? manager : null
}

function workspaceSlotAbortError(reason: unknown): Error {
  return reason instanceof Error
    ? reason
    : new Error('BrowserWorkspaceSlotOperationAborted', { cause: reason })
}

function slotLockName(databaseName: BrowserWorkspaceDatabaseName): string {
  return `${SLOT_LOCK_PREFIX}${databaseName}`
}
