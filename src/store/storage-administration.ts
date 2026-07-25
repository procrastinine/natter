import { browserLocalStorage } from '../lib/browser-storage'
import { errorFromUnknown } from '../lib/error'
import {
  clearAndVerifySessionStorage,
  type OriginStorageWipeReport,
  wipeOriginStorage,
} from '../lib/storage-wipe'
import { resumeBrowserWorkspace, shutdownBrowserWorkspace } from './browser-workspace-lifecycle'
import { recreateAndVerifyBrowserWorkspaceDatabase } from './db'

const STORAGE_ADMIN_CHANNEL = 'natter-storage-administration'
const STORAGE_ADMIN_SIGNAL_KEY = 'natter:storage-administration'
const STORAGE_ADMIN_LOCK = 'natter:storage-administration'
const STORAGE_ADMIN_PHASE_TIMEOUT_MS = 5_000
const STORAGE_ADMIN_EXCLUSIVE_TIMEOUT_MS = 5_000
const STORAGE_ADMIN_COMMITTED_LEASE_MS = 60_000

export type StorageAdministrationMessage =
  | {
      readonly kind: 'wipe-request'
      readonly requestId: string
      readonly senderId: string
      readonly deadlineAt: number
    }
  | { readonly kind: 'wipe-ready'; readonly requestId: string; readonly senderId: string }
  | {
      readonly kind: 'wipe-rejected'
      readonly requestId: string
      readonly senderId: string
      readonly code: string
    }
  | {
      readonly kind: 'wipe-commit'
      readonly requestId: string
      readonly senderId: string
      readonly deadlineAt: number
    }
  | {
      readonly kind: 'wipe-cancel'
      readonly requestId: string
      readonly senderId: string
      readonly code: string
    }
  | { readonly kind: 'wipe-complete'; readonly requestId: string; readonly senderId: string }
  | {
      readonly kind: 'wipe-committed-failure'
      readonly requestId: string
      readonly senderId: string
      readonly code: string
    }

export interface StorageAdministrationTransport {
  subscribe(listener: (message: StorageAdministrationMessage) => void): () => void
  post(message: StorageAdministrationMessage): void
}

export interface StorageAdministrationBarrier {
  ready(timeoutMs: number): Promise<void>
  releasePresence(timeoutMs: number): Promise<void>
  runExclusive<T>(operation: () => Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T>
}

export interface StorageAdministrationDependencies {
  readonly clientId: string
  readonly transport: StorageAdministrationTransport
  readonly barrier: StorageAdministrationBarrier
  readonly quiesce: () => Promise<void>
  readonly terminalize: () => Promise<void>
  readonly resume: () => Promise<void>
  readonly wipe: () => Promise<OriginStorageWipeReport>
  readonly recreateAndVerify: () => Promise<void>
  readonly clearSessionStorage: () => void
  readonly reload: () => void
}

export interface ClearLocalWorkspaceOptions {
  readonly skipReload?: boolean
  readonly blockedTimeoutMs?: number
  readonly phaseTimeoutMs?: number
  readonly committedLeaseMs?: number
}

interface LocalClearState {
  readonly requestId: string
  readonly abortPrecommit: AbortController
  committed: boolean
  cancelPosted: boolean
  rejectedBy: string | null
}

type RemoteClearState = 'precommit' | 'committed'

interface RemoteClearLease {
  readonly requestId: string
  readonly state: RemoteClearState
  readonly deadlineAt: number
  timer: ReturnType<typeof globalThis.setTimeout> | null
}

export class StorageAdministration {
  private readonly dependencies: StorageAdministrationDependencies
  private remoteLease: RemoteClearLease | null = null
  private unsubscribe: (() => void) | null = null
  private activeClear: Promise<OriginStorageWipeReport> | null = null
  private localClear: LocalClearState | null = null
  private remoteQuiesce: Promise<void> | null = null
  private terminalRequestId: string | null = null

  constructor(dependencies: StorageAdministrationDependencies) {
    this.dependencies = dependencies
  }

  installResponder(): void {
    if (this.unsubscribe) return
    this.unsubscribe = this.dependencies.transport.subscribe((message) => {
      if (message.senderId === this.dependencies.clientId) return
      this.receive(message)
    })
  }

  ready(timeoutMs = STORAGE_ADMIN_PHASE_TIMEOUT_MS): Promise<void> {
    this.installResponder()
    return observeStorageAdministrationPhase('presence-acquire', () =>
      this.dependencies.barrier.ready(timeoutMs),
    )
  }

  clearAll(options: ClearLocalWorkspaceOptions = {}): Promise<OriginStorageWipeReport> {
    if (this.activeClear) return this.activeClear
    const operation = this.performClear(options)
    this.activeClear = operation
    const clear = () => {
      if (this.activeClear === operation) this.activeClear = null
    }
    void operation.then(clear, clear)
    return operation
  }

  private async performClear(
    options: ClearLocalWorkspaceOptions,
  ): Promise<OriginStorageWipeReport> {
    const phaseTimeoutMs = options.phaseTimeoutMs ?? STORAGE_ADMIN_PHASE_TIMEOUT_MS
    await this.ready(phaseTimeoutMs)
    const state: LocalClearState = {
      requestId: randomId(),
      abortPrecommit: new AbortController(),
      committed: false,
      cancelPosted: false,
      rejectedBy: null,
    }
    this.localClear = state
    this.dependencies.transport.post({
      kind: 'wipe-request',
      requestId: state.requestId,
      senderId: this.dependencies.clientId,
      deadlineAt:
        Date.now() +
        precommitLeaseDuration(
          phaseTimeoutMs,
          options.blockedTimeoutMs ?? STORAGE_ADMIN_EXCLUSIVE_TIMEOUT_MS,
        ),
    })

    try {
      await observeStorageAdministrationPhase('local-quiesce', () => this.dependencies.quiesce())
      await observeStorageAdministrationPhase('presence-release', () =>
        this.dependencies.barrier.releasePresence(phaseTimeoutMs),
      )
      this.throwIfPrecommitRejected(state)

      const report = await runStorageAdministrationExclusivePhase(
        this.dependencies.barrier,
        async () => {
          this.throwIfPrecommitRejected(state)
          if (this.terminalRequestId && this.terminalRequestId !== state.requestId) {
            throw new Error(
              `StorageAdministrationPhaseFailed:precommit-check:StorageWipeSuperseded:${this.terminalRequestId}`,
            )
          }
          state.committed = true
          this.terminalRequestId = state.requestId
          this.dependencies.transport.post({
            kind: 'wipe-commit',
            requestId: state.requestId,
            senderId: this.dependencies.clientId,
            deadlineAt: Date.now() + (options.committedLeaseMs ?? STORAGE_ADMIN_COMMITTED_LEASE_MS),
          })
          await observeStorageAdministrationPhase('local-terminalize', () =>
            this.dependencies.terminalize(),
          )
          runStorageAdministrationSynchronousPhase('session-storage-clear', () =>
            this.dependencies.clearSessionStorage(),
          )
          const wiped = await observeStorageAdministrationPhase('origin-storage-wipe', () =>
            this.dependencies.wipe(),
          )
          await observeStorageAdministrationPhase('fresh-database-verify', () =>
            this.dependencies.recreateAndVerify(),
          )
          this.dependencies.transport.post({
            kind: 'wipe-complete',
            requestId: state.requestId,
            senderId: this.dependencies.clientId,
          })
          return wiped
        },
        options.blockedTimeoutMs ?? STORAGE_ADMIN_EXCLUSIVE_TIMEOUT_MS,
        state.abortPrecommit.signal,
      )
      if (!options.skipReload) this.dependencies.reload()
      return report
    } catch (error) {
      if (!state.committed && this.terminalRequestId === null) {
        this.postPrecommitCancel(state, errorCode(error))
        if (this.remoteLease !== null) {
          this.dependencies.reload()
          throw error
        }
        try {
          await this.recoverPrecommit(phaseTimeoutMs)
        } catch (recoveryError) {
          this.dependencies.reload()
          throw recoveryError
        }
        throw error
      }
      if (state.committed) {
        this.dependencies.transport.post({
          kind: 'wipe-committed-failure',
          requestId: state.requestId,
          senderId: this.dependencies.clientId,
          code: errorCode(error),
        })
      }
      this.dependencies.reload()
      throw error
    } finally {
      if (this.localClear === state) this.localClear = null
    }
  }

  private throwIfPrecommitRejected(state: LocalClearState): void {
    if (state.rejectedBy) {
      throw new Error(
        `StorageAdministrationPhaseFailed:precommit-check:StorageWipeRemoteTabRejected:${state.rejectedBy}`,
      )
    }
    if (state.abortPrecommit.signal.aborted) {
      throw new Error(
        'StorageAdministrationPhaseFailed:precommit-check:StorageWipePrecommitCancelled',
      )
    }
  }

  private postPrecommitCancel(state: LocalClearState, code: string): void {
    if (state.cancelPosted) return
    state.cancelPosted = true
    this.dependencies.transport.post({
      kind: 'wipe-cancel',
      requestId: state.requestId,
      senderId: this.dependencies.clientId,
      code,
    })
  }

  private async recoverPrecommit(timeoutMs: number): Promise<void> {
    await observeStorageAdministrationPhase('presence-rearm', () =>
      this.dependencies.barrier.ready(timeoutMs),
    )
    await observeStorageAdministrationPhase('precommit-resume', () => this.dependencies.resume())
  }

  private receive(message: StorageAdministrationMessage): void {
    switch (message.kind) {
      case 'wipe-request':
        this.receiveWipeRequest(message)
        return
      case 'wipe-ready':
        return
      case 'wipe-rejected':
        if (message.requestId === this.localClear?.requestId && !this.localClear.committed) {
          this.localClear.rejectedBy = `${message.senderId}:${message.code}`
          this.localClear.abortPrecommit.abort()
        }
        return
      case 'wipe-commit':
        this.receiveWipeCommit(message)
        return
      case 'wipe-cancel':
        this.receiveWipeCancel(message.requestId)
        return
      case 'wipe-complete':
      case 'wipe-committed-failure':
        if (
          message.requestId === this.terminalRequestId ||
          message.requestId === this.remoteLease?.requestId
        ) {
          this.clearRemoteLease(message.requestId)
          this.dependencies.reload()
        }
    }
  }

  private receiveWipeRequest(
    message: Extract<StorageAdministrationMessage, { kind: 'wipe-request' }>,
  ): void {
    if (this.remoteLease?.requestId === message.requestId) return
    if (this.terminalRequestId !== null || this.remoteLease !== null) {
      this.dependencies.transport.post({
        kind: 'wipe-rejected',
        requestId: message.requestId,
        senderId: this.dependencies.clientId,
        code: 'StorageWipeBusy',
      })
      return
    }
    this.setRemoteLease(message.requestId, 'precommit', message.deadlineAt)
    void this.quiesceForRemoteWipe(message.requestId)
  }

  private receiveWipeCommit(
    message: Extract<StorageAdministrationMessage, { kind: 'wipe-commit' }>,
  ): void {
    if (this.terminalRequestId !== null && this.terminalRequestId !== message.requestId) {
      this.dependencies.reload()
      return
    }
    this.terminalRequestId = message.requestId
    this.setRemoteLease(message.requestId, 'committed', message.deadlineAt)
    if (
      this.localClear &&
      !this.localClear.committed &&
      this.localClear.requestId !== message.requestId
    ) {
      this.localClear.abortPrecommit.abort()
    }
    void this.sealForRemoteWipe(message.requestId)
  }

  private receiveWipeCancel(requestId: string): void {
    if (this.remoteLease?.requestId !== requestId || this.remoteLease.state !== 'precommit') return
    this.clearRemoteLease(requestId)
    if (this.terminalRequestId === null && this.localClear === null) {
      void this.resumeAfterRemoteCancel()
    }
  }

  private async quiesceForRemoteWipe(requestId: string): Promise<void> {
    const timeoutMs = STORAGE_ADMIN_PHASE_TIMEOUT_MS
    try {
      if (!this.remoteQuiesce) {
        const quiesce = this.performRemoteQuiesce(timeoutMs)
        this.remoteQuiesce = quiesce
        void quiesce.catch(() => {
          if (this.remoteQuiesce === quiesce) this.remoteQuiesce = null
        })
      }
      await this.remoteQuiesce
      if (this.remoteLease?.requestId !== requestId || this.remoteLease.state !== 'precommit') {
        return
      }
      this.dependencies.transport.post({
        kind: 'wipe-ready',
        requestId,
        senderId: this.dependencies.clientId,
      })
    } catch (error) {
      this.dependencies.transport.post({
        kind: 'wipe-rejected',
        requestId,
        senderId: this.dependencies.clientId,
        code: errorCode(error),
      })
      if (isStorageAdministrationTimeout(error)) this.dependencies.reload()
    }
  }

  private async performRemoteQuiesce(timeoutMs: number): Promise<void> {
    await observeStorageAdministrationPhase('remote-quiesce', () => this.dependencies.quiesce())
    await observeStorageAdministrationPhase('remote-presence-release', () =>
      this.dependencies.barrier.releasePresence(timeoutMs),
    )
  }

  private async sealForRemoteWipe(requestId: string): Promise<void> {
    const timeoutMs = STORAGE_ADMIN_PHASE_TIMEOUT_MS
    try {
      if (!this.remoteQuiesce) {
        const quiesce = this.performRemoteQuiesce(timeoutMs)
        this.remoteQuiesce = quiesce
      }
      await this.remoteQuiesce
      await observeStorageAdministrationPhase('remote-terminalize', () =>
        this.dependencies.terminalize(),
      )
      runStorageAdministrationSynchronousPhase('remote-session-storage-clear', () =>
        this.dependencies.clearSessionStorage(),
      )
    } catch (error) {
      this.dependencies.transport.post({
        kind: 'wipe-committed-failure',
        requestId,
        senderId: this.dependencies.clientId,
        code: errorCode(error),
      })
      this.dependencies.reload()
    }
  }

  private async resumeAfterRemoteCancel(): Promise<void> {
    const timeoutMs = STORAGE_ADMIN_PHASE_TIMEOUT_MS
    try {
      await this.remoteQuiesce?.catch(() => {})
      await observeStorageAdministrationPhase('remote-presence-rearm', () =>
        this.dependencies.barrier.ready(timeoutMs),
      )
      await observeStorageAdministrationPhase('remote-resume', () => this.dependencies.resume())
      this.remoteQuiesce = null
    } catch {
      this.dependencies.reload()
    }
  }

  private setRemoteLease(requestId: string, state: RemoteClearState, deadlineAt: number): void {
    this.clearRemoteLease()
    const lease: RemoteClearLease = { requestId, state, deadlineAt, timer: null }
    this.remoteLease = lease
    lease.timer = globalThis.setTimeout(
      () => this.expireRemoteLease(lease),
      Math.max(0, deadlineAt - Date.now()),
    )
  }

  private clearRemoteLease(requestId?: string): void {
    const lease = this.remoteLease
    if (!lease || (requestId !== undefined && lease.requestId !== requestId)) return
    if (lease.timer !== null) globalThis.clearTimeout(lease.timer)
    this.remoteLease = null
  }

  private expireRemoteLease(lease: RemoteClearLease): void {
    if (this.remoteLease !== lease) return
    this.clearRemoteLease(lease.requestId)
    if (lease.state === 'committed') {
      this.dependencies.reload()
      return
    }
    if (this.terminalRequestId === null && this.localClear === null) {
      void this.resumeAfterRemoteCancel()
    }
  }
}

class BrowserStorageAdministrationTransport implements StorageAdministrationTransport {
  private readonly listeners = new Set<(message: StorageAdministrationMessage) => void>()
  private channel: BroadcastChannel | null = null
  private storageListenerInstalled = false

  subscribe(listener: (message: StorageAdministrationMessage) => void): () => void {
    this.listeners.add(listener)
    this.ensureInstalled()
    return () => this.listeners.delete(listener)
  }

  post(message: StorageAdministrationMessage): void {
    this.ensureInstalled()
    try {
      this.channel?.postMessage(message)
    } catch {
      this.closeChannel()
    }
    try {
      const storage = browserLocalStorage()
      storage?.setItem(STORAGE_ADMIN_SIGNAL_KEY, JSON.stringify(message))
      storage?.removeItem(STORAGE_ADMIN_SIGNAL_KEY)
    } catch {
      // The Web Lock is the authoritative fail-closed wipe barrier.
    }
  }

  private ensureInstalled(): void {
    if (!this.channel && typeof BroadcastChannel !== 'undefined') {
      try {
        this.channel = new BroadcastChannel(STORAGE_ADMIN_CHANNEL)
        this.channel.addEventListener('message', (event) => this.dispatch(event.data))
        this.channel.addEventListener('messageerror', () => this.closeChannel())
      } catch {
        this.closeChannel()
      }
    }
    if (!this.storageListenerInstalled && typeof window !== 'undefined') {
      window.addEventListener('storage', this.receiveStorageSignal)
      this.storageListenerInstalled = true
    }
  }

  private readonly receiveStorageSignal = (event: StorageEvent): void => {
    if (event.key !== STORAGE_ADMIN_SIGNAL_KEY || !event.newValue) return
    try {
      this.dispatch(JSON.parse(event.newValue))
    } catch {
      // Untrusted storage events outside the protocol are ignored.
    }
  }

  private dispatch(value: unknown): void {
    if (!isStorageAdministrationMessage(value)) return
    for (const listener of [...this.listeners]) listener(value)
  }

  private closeChannel(): void {
    try {
      this.channel?.close()
    } catch {
      // Closing a failed transport cannot affect the wipe barrier.
    }
    this.channel = null
  }
}

interface PresenceLease {
  readonly ready: Promise<void>
  readonly done: Promise<void>
  readonly abort: AbortController
  release(): void
}

class BrowserStorageAdministrationBarrier implements StorageAdministrationBarrier {
  private presence: PresenceLease | null = null

  async ready(timeoutMs: number): Promise<void> {
    const locks = storageAdministrationLockManager()
    if (!locks) throw new Error('StorageAdministrationWebLocksRequired')
    const presence = this.presence ?? this.createPresenceLease(locks)
    this.presence = presence
    try {
      await withDeadline(presence.ready, timeoutMs, 'StorageAdministrationPresenceTimedOut')
    } catch (error) {
      presence.abort.abort()
      if (this.presence === presence) this.presence = null
      await presence.done.catch(() => {})
      throw error
    }
  }

  async releasePresence(timeoutMs: number): Promise<void> {
    const presence = this.presence
    if (!presence) return
    await this.ready(timeoutMs)
    presence.release()
    try {
      await withDeadline(presence.done, timeoutMs, 'StorageAdministrationPresenceReleaseTimedOut')
    } catch (error) {
      await presence.done.catch(() => {})
      throw error
    } finally {
      if (this.presence === presence) this.presence = null
    }
  }

  async runExclusive<T>(
    operation: () => Promise<T>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<T> {
    const locks = storageAdministrationLockManager()
    if (!locks) throw new Error('StorageAdministrationWebLocksRequired')
    if (signal?.aborted) throw new Error('StorageAdministrationExclusiveCancelled')
    const controller = new AbortController()
    const state = { timedOut: false, acquired: false }
    const abortFromCaller = () => controller.abort()
    signal?.addEventListener('abort', abortFromCaller, { once: true })
    const timeout = globalThis.setTimeout(() => {
      state.timedOut = true
      controller.abort()
    }, timeoutMs)
    try {
      return await locks.request(
        STORAGE_ADMIN_LOCK,
        { mode: 'exclusive', signal: controller.signal },
        async () => {
          state.acquired = true
          globalThis.clearTimeout(timeout)
          signal?.removeEventListener('abort', abortFromCaller)
          return operation()
        },
      )
    } catch (error) {
      if (!state.acquired && state.timedOut) {
        throw new Error('StorageAdministrationExclusiveTimedOut', { cause: error })
      }
      if (!state.acquired && abortSignalIsAborted(signal)) {
        throw new Error('StorageAdministrationExclusiveCancelled', { cause: error })
      }
      throw error
    } finally {
      globalThis.clearTimeout(timeout)
      signal?.removeEventListener('abort', abortFromCaller)
    }
  }

  private createPresenceLease(locks: LockManager): PresenceLease {
    const abort = new AbortController()
    let markReady: (() => void) | undefined
    let markFailed: ((error: unknown) => void) | undefined
    let release: (() => void) | undefined
    let acquired = false
    const ready = new Promise<void>((resolve, reject) => {
      markReady = resolve
      markFailed = reject
    })
    const hold = new Promise<void>((resolve) => {
      release = resolve
    })
    const done = locks
      .request(STORAGE_ADMIN_LOCK, { mode: 'shared', signal: abort.signal }, async () => {
        acquired = true
        markReady?.()
        await hold
      })
      .catch((error: unknown) => {
        if (!acquired) markFailed?.(error)
        throw error
      })
    return { ready, done, abort, release: () => release?.() }
  }
}

const browserStorageAdministration = new StorageAdministration({
  clientId: randomId(),
  transport: new BrowserStorageAdministrationTransport(),
  barrier: new BrowserStorageAdministrationBarrier(),
  quiesce: () => shutdownBrowserWorkspace(),
  terminalize: () => shutdownBrowserWorkspace({ terminal: true }),
  resume: resumeBrowserWorkspace,
  wipe: wipeOriginStorage,
  recreateAndVerify: recreateAndVerifyBrowserWorkspaceDatabase,
  clearSessionStorage: clearAndVerifySessionStorage,
  reload: () => location.reload(),
})

export function installStorageAdministrationResponder(): void {
  browserStorageAdministration.installResponder()
}

export function awaitStorageAdministrationReady(): Promise<void> {
  return browserStorageAdministration.ready()
}

export function clearLocalWorkspaceStorage(
  options: ClearLocalWorkspaceOptions = {},
): Promise<OriginStorageWipeReport> {
  return browserStorageAdministration.clearAll(options)
}

function isStorageAdministrationMessage(value: unknown): value is StorageAdministrationMessage {
  if (!value || typeof value !== 'object') return false
  const message = value as Record<string, unknown>
  if (typeof message.requestId !== 'string' || typeof message.senderId !== 'string') return false
  switch (message.kind) {
    case 'wipe-request':
    case 'wipe-commit':
      return typeof message.deadlineAt === 'number' && Number.isFinite(message.deadlineAt)
    case 'wipe-ready':
    case 'wipe-complete':
      return true
    case 'wipe-rejected':
    case 'wipe-cancel':
    case 'wipe-committed-failure':
      return typeof message.code === 'string'
    default:
      return false
  }
}

async function runStorageAdministrationExclusivePhase<T>(
  barrier: StorageAdministrationBarrier,
  operation: () => Promise<T>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<T> {
  try {
    return await barrier.runExclusive(operation, timeoutMs, signal)
  } catch (error) {
    if (isStorageAdministrationPhaseError(error)) throw error
    if (error instanceof Error && error.message === 'StorageAdministrationExclusiveTimedOut') {
      throw new Error('StorageAdministrationPhaseTimedOut:exclusive-acquire', { cause: error })
    }
    throw new Error(`StorageAdministrationPhaseFailed:exclusive-acquire:${errorCode(error)}`, {
      cause: error,
    })
  }
}

async function observeStorageAdministrationPhase<T>(
  phase: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (isStorageAdministrationPhaseError(error)) throw error
    if (error instanceof Error && error.message.endsWith('TimedOut')) {
      throw new Error(`StorageAdministrationPhaseTimedOut:${phase}`, { cause: error })
    }
    throw new Error(`StorageAdministrationPhaseFailed:${phase}:${errorCode(error)}`, {
      cause: error,
    })
  }
}

function runStorageAdministrationSynchronousPhase(phase: string, operation: () => void): void {
  try {
    operation()
  } catch (error) {
    throw new Error(`StorageAdministrationPhaseFailed:${phase}:${errorCode(error)}`, {
      cause: error,
    })
  }
}

function isStorageAdministrationPhaseError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.startsWith('StorageAdministrationPhaseTimedOut:') ||
      error.message.startsWith('StorageAdministrationPhaseFailed:'))
  )
}

function isStorageAdministrationTimeout(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('StorageAdministrationPhaseTimedOut:')
}

function withDeadline<T>(operation: PromiseLike<T>, timeoutMs: number, code: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => reject(new Error(code)), timeoutMs)
    Promise.resolve(operation).then(
      (value) => {
        globalThis.clearTimeout(timeout)
        resolve(value)
      },
      (error: unknown) => {
        globalThis.clearTimeout(timeout)
        reject(
          error instanceof Error
            ? error
            : new Error('StorageAdministrationOperationFailed', { cause: error }),
        )
      },
    )
  })
}

function storageAdministrationLockManager(): LockManager | null {
  if (typeof navigator === 'undefined') return null
  const manager = (navigator as unknown as { readonly locks?: LockManager }).locks
  return manager && typeof manager.request === 'function' ? manager : null
}

function abortSignalIsAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

function errorCode(error: unknown): string {
  return (
    errorFromUnknown(error)
      .message.replace(/[^a-zA-Z0-9:._-]/g, '')
      .slice(0, 160) || 'Error'
  )
}

function randomId(): string {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function precommitLeaseDuration(phaseTimeoutMs: number, exclusiveTimeoutMs: number): number {
  return phaseTimeoutMs * 3 + exclusiveTimeoutMs + 1_000
}
