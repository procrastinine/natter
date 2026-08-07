import type Dexie from 'dexie'
import type { Table, Transaction } from 'dexie'
import type { MutationScope } from '../core/types'
import { newId } from '../lib/ulid'
import {
  BROWSER_WRITER_LOCK_NAME,
  type BrowserLockRow,
  emptyBrowserLockRow,
} from './browser-lock-record'
import { runWithLocalWriteActivity } from './transaction-activity'

const SCOPE_KIND_ORDER = {
  'chat-meta': 0,
  'message-topology': 1,
  message: 2,
  children: 3,
  draft: 4,
  attachment: 5,
} as const

const DEFAULT_FALLBACK_LOCK_LEASE_MS = 15_000
const DEFAULT_FALLBACK_LOCK_RENEW_MS = 3_000
const DEFAULT_FALLBACK_LOCK_RETRY_MS = 100
const WORKSPACE_AUTHORITATIVE_GATE = 'workspace:authoritative'
const GENERATION_LIFETIME_GATE = 'workspace:generation-lifetime'
const COORDINATION_LOCK_PREFIX = 'natter:coordination:'
const LOCK_WAKE_CHANNEL_NAME = 'natter:lock-wake:v1'

const TEST_HELD_SCOPES: string[] = []
const lockWakeListeners = new Map<string, Set<() => void>>()
let lockWakeChannel: BroadcastChannel | null = null
let lockWakeChannelUnavailable = false

export type LockDatabaseRunner = <T>(operation: (db: Dexie) => Promise<T>) => Promise<T>

let productionDatabaseRunner: LockDatabaseRunner | null = null

type TransactionTable = { readonly name: string } | string

export interface LockGrant {
  readonly kind: 'web-locks' | 'indexeddb-fence'
  readonly logicalNames: readonly string[]
  readonly ownershipLost?: AbortSignal
  runTransaction<T>(
    db: Dexie,
    tables: readonly TransactionTable[],
    fn: (tx: Transaction) => Promise<T> | T,
  ): Promise<T>
}

export interface AuthoritativeCommandLockSession {
  readonly kind: LockGrant['kind']
  readonly ownershipLost?: AbortSignal
  withResourceLocks<T>(
    resourceNames: readonly string[],
    operation: (grant: LockGrant) => Promise<T> | T,
  ): Promise<T>
}

export interface ResourceLockBackend {
  readonly kind: LockGrant['kind']
  readonly requiresSessionDatabase?: boolean
  run<T>(
    logicalNames: readonly string[],
    fn: (grant: LockGrant) => Promise<T> | T,
    options?: { database?: Dexie; signal?: AbortSignal },
  ): Promise<T>
  dispose?(): void
  awaitIdle?(): Promise<void>
  disposeAndDrain?(): Promise<void>
}

export interface LockBackend extends ResourceLockBackend {
  runAuthoritativeCommandSession<T>(
    database: Dexie,
    operation: (session: AuthoritativeCommandLockSession) => Promise<T> | T,
    options?: { signal?: AbortSignal },
  ): Promise<T>
}

interface IndexedDbLockBackendOptions {
  openDatabase?: () => Promise<Dexie>
  clientId?: string
  now?: () => number
  leaseMs?: number
  renewMs?: number
  retryMs?: number
  recordName?: string
  deleteRecordOnRelease?: boolean
  trackTransactionActivity?: boolean
  waitForWakeOrDeadline?: (
    wake: Promise<void>,
    delay: number,
    signal: AbortSignal | undefined,
  ) => Promise<void>
}

interface FenceIdentity {
  ownerClientId: string
  leaseId: string
  fencingToken: number
}

interface LockWakeSubscription {
  readonly promise: Promise<void>
  close(): void
}

type OwnershipState = 'held' | 'lost' | 'uncertain'

export class ScopeOrderError extends Error {
  readonly requested: string
  readonly held: string[]

  constructor(requested: string, held: string[]) {
    super(`ScopeOrder:${requested}:${held.join(',')}`)
    this.name = 'ScopeOrderError'
    this.requested = requested
    this.held = [...held]
  }
}

export class LockFenceLostError extends Error {
  readonly lockName: string
  readonly fencingToken: number

  constructor(fencingToken: number, lockName = BROWSER_WRITER_LOCK_NAME) {
    super(`LockFenceLost:${lockName}:${fencingToken}`)
    this.name = 'LockFenceLostError'
    this.lockName = lockName
    this.fencingToken = fencingToken
  }
}

class LockOwnershipUncertainError extends Error {
  readonly lockName: string

  constructor(lockName = BROWSER_WRITER_LOCK_NAME) {
    super(`LockOwnershipUncertain:${lockName}`)
    this.name = 'LockOwnershipUncertainError'
    this.lockName = lockName
  }
}

class LockRecordCorruptError extends Error {
  readonly lockName: string

  constructor(lockName = BROWSER_WRITER_LOCK_NAME) {
    super(`LockRecordCorrupt:${lockName}`)
    this.name = 'LockRecordCorruptError'
    this.lockName = lockName
  }
}

function compareScopeKeys(a: string, b: string): number {
  const [aKind] = a.split(':', 1)
  const [bKind] = b.split(':', 1)
  const aRank = SCOPE_KIND_ORDER[aKind as keyof typeof SCOPE_KIND_ORDER]
  const bRank = SCOPE_KIND_ORDER[bKind as keyof typeof SCOPE_KIND_ORDER]
  if (aRank !== bRank) return aRank - bRank
  return a.localeCompare(b)
}

export function scopeResourceName(scope: MutationScope): string {
  switch (scope.kind) {
    case 'chat-meta':
      return `chat-meta:${scope.chatId}`
    case 'chat-topology':
      return `message-topology:${scope.chatId}`
    case 'message':
      return `message:${scope.messageId}`
    case 'children':
      return `children:${scope.chatId}:${scope.parentId ?? '__root__'}`
    case 'draft':
      return `draft:${scope.chatId}`
    case 'attachment':
      return `attachment:${scope.attachmentId}`
  }
}

export function normalizeMutationScopes(scopes: readonly MutationScope[]): MutationScope[] {
  const keyed = new Map<string, MutationScope>()
  for (const scope of scopes) {
    keyed.set(scopeResourceName(scope), scope)
  }
  return [...keyed.entries()].sort(([a], [b]) => compareScopeKeys(a, b)).map(([, scope]) => scope)
}

export function assertAcquireOrder(resourceName: string): void {
  const lastHeld = TEST_HELD_SCOPES.at(-1)
  if (lastHeld && compareScopeKeys(lastHeld, resourceName) >= 0) {
    throw new ScopeOrderError(resourceName, TEST_HELD_SCOPES)
  }
}

export async function withTrackedScopes<T>(
  scopes: readonly MutationScope[],
  fn: () => Promise<T> | T,
): Promise<T> {
  const normalized = normalizeMutationScopes(scopes)
  const acquired: string[] = []
  for (const scope of normalized) {
    const resourceName = scopeResourceName(scope)
    assertAcquireOrder(resourceName)
    TEST_HELD_SCOPES.push(resourceName)
    acquired.push(resourceName)
  }
  try {
    return await fn()
  } finally {
    for (let i = acquired.length - 1; i >= 0; i -= 1) {
      const resourceName = acquired[i] as string
      const top = TEST_HELD_SCOPES.at(-1)
      if (top === resourceName) {
        TEST_HELD_SCOPES.pop()
      } else {
        const idx = TEST_HELD_SCOPES.lastIndexOf(resourceName)
        if (idx >= 0) TEST_HELD_SCOPES.splice(idx, 1)
      }
    }
  }
}

function uniqueTransactionTables(
  db: Dexie,
  tables: readonly TransactionTable[],
  includeFence: boolean,
): Table[] {
  const byName = new Map<string, Table>()
  for (const tableOrName of tables) {
    const table = db.table(typeof tableOrName === 'string' ? tableOrName : tableOrName.name)
    byName.set(table.name, table)
  }
  if (includeFence) {
    const table = db.table('browserLocks')
    byName.set(table.name, table)
  }
  return [...byName.values()]
}

function validLockRow(row: BrowserLockRow, recordName: string): boolean {
  return (
    row.name === recordName &&
    Number.isSafeInteger(row.fencingToken) &&
    row.fencingToken >= 0 &&
    ((row.ownerClientId === null && row.leaseId === null) ||
      (typeof row.ownerClientId === 'string' && typeof row.leaseId === 'string')) &&
    Number.isFinite(row.acquiredAt) &&
    Number.isFinite(row.heartbeatAt) &&
    Number.isFinite(row.expiresAt)
  )
}

function ownsFence(
  row: BrowserLockRow | undefined,
  identity: FenceIdentity,
  recordName: string,
): boolean {
  return (
    row !== undefined &&
    row.name === recordName &&
    row.ownerClientId === identity.ownerClientId &&
    row.leaseId === identity.leaseId &&
    row.fencingToken === identity.fencingToken
  )
}

function lockWakeKey(databaseName: string, recordName: string): string {
  return `${databaseName}\u0000${recordName}`
}

function subscribeLockWake(databaseName: string, recordName: string): LockWakeSubscription {
  ensureLockWakeChannel()
  const key = lockWakeKey(databaseName, recordName)
  let resolve!: () => void
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  const listeners = lockWakeListeners.get(key) ?? new Set<() => void>()
  const listener = () => resolve()
  listeners.add(listener)
  lockWakeListeners.set(key, listeners)
  return {
    promise,
    close: () => {
      listeners.delete(listener)
      if (listeners.size === 0) lockWakeListeners.delete(key)
    },
  }
}

function publishLockWake(databaseName: string, recordName: string): void {
  dispatchLockWake(databaseName, recordName)
  const channel = ensureLockWakeChannel()
  if (!channel) return
  try {
    channel.postMessage({ databaseName, recordName })
  } catch {
    closeLockWakeChannel(channel)
  }
}

function dispatchLockWake(databaseName: string, recordName: string): void {
  const key = lockWakeKey(databaseName, recordName)
  for (const listener of [...(lockWakeListeners.get(key) ?? [])]) listener()
}

function ensureLockWakeChannel(): BroadcastChannel | null {
  if (lockWakeChannel || lockWakeChannelUnavailable || typeof BroadcastChannel === 'undefined') {
    return lockWakeChannel
  }
  try {
    const channel = new BroadcastChannel(LOCK_WAKE_CHANNEL_NAME)
    channel.addEventListener('message', (event) => {
      const data: unknown = event.data
      if (!data || typeof data !== 'object') return
      const { databaseName, recordName } = data as {
        readonly databaseName?: unknown
        readonly recordName?: unknown
      }
      if (typeof databaseName === 'string' && typeof recordName === 'string') {
        dispatchLockWake(databaseName, recordName)
      }
    })
    channel.addEventListener('messageerror', () => closeLockWakeChannel(channel))
    lockWakeChannel = channel
  } catch {
    lockWakeChannelUnavailable = true
  }
  return lockWakeChannel
}

function closeLockWakeChannel(channel: BroadcastChannel): void {
  if (lockWakeChannel !== channel) return
  lockWakeChannel = null
  lockWakeChannelUnavailable = true
  try {
    channel.close()
  } catch {
    return
  }
}

class WebLocksBackend implements LockBackend {
  readonly kind = 'web-locks' as const

  async run<T>(
    logicalNames: readonly string[],
    fn: (grant: LockGrant) => Promise<T> | T,
    options: { signal?: AbortSignal } = {},
  ): Promise<T> {
    const signal = options.signal
    const mode = logicalNames.includes('db:global') ? 'exclusive' : 'shared'
    return signal
      ? navigator.locks.request(WORKSPACE_AUTHORITATIVE_GATE, { mode, signal }, () =>
          this.runResourceLocks(logicalNames, fn, signal),
        )
      : navigator.locks.request(WORKSPACE_AUTHORITATIVE_GATE, { mode }, () =>
          this.runResourceLocks(logicalNames, fn, signal),
        )
  }

  runAuthoritativeCommandSession<T>(
    _database: Dexie,
    operation: (session: AuthoritativeCommandLockSession) => Promise<T> | T,
    options: { signal?: AbortSignal } = {},
  ): Promise<T> {
    const signal = options.signal
    const run = () =>
      operation(
        createAuthoritativeCommandLockSession(this.kind, undefined, (resourceNames, child) =>
          this.runResourceLocks(resourceNames, child, signal),
        ),
      )
    return signal
      ? navigator.locks.request(WORKSPACE_AUTHORITATIVE_GATE, { mode: 'shared', signal }, run)
      : navigator.locks.request(WORKSPACE_AUTHORITATIVE_GATE, { mode: 'shared' }, run)
  }

  private runResourceLocks<T>(
    logicalNames: readonly string[],
    fn: (grant: LockGrant) => Promise<T> | T,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    const normalized = normalizeNamedLocks(logicalNames)
    const grant: LockGrant = {
      kind: this.kind,
      logicalNames: normalized,
      runTransaction: (db, tables, transactionFn) =>
        runWithLocalWriteActivity(() =>
          db.transaction('rw', uniqueTransactionTables(db, tables, false), transactionFn),
        ),
    }
    const acquire = (index: number): Promise<T> => {
      if (signal?.aborted) return Promise.reject(lockAbortError(signal.reason))
      if (index >= normalized.length) return Promise.resolve(fn(grant))
      const name = normalized[index] as string
      return signal
        ? navigator.locks.request(name, { signal }, () => acquire(index + 1))
        : navigator.locks.request(name, () => acquire(index + 1))
    }
    return acquire(0)
  }
}

class CoordinationWebLocksBackend implements ResourceLockBackend {
  readonly kind = 'web-locks' as const

  async run<T>(
    logicalNames: readonly string[],
    fn: (grant: LockGrant) => Promise<T> | T,
    options: { signal?: AbortSignal } = {},
  ): Promise<T> {
    const manager = navigator.locks
    const signal = options.signal
    const grant: LockGrant = {
      kind: this.kind,
      logicalNames,
      runTransaction: (db, tables, transactionFn) =>
        runWithLocalWriteActivity(() =>
          db.transaction('rw', uniqueTransactionTables(db, tables, false), transactionFn),
        ),
    }
    const acquire = (index: number): Promise<T> => {
      if (signal?.aborted) return Promise.reject(lockAbortError(signal.reason))
      if (index >= logicalNames.length) return Promise.resolve(fn(grant))
      const name = logicalNames[index] as string
      return signal
        ? manager.request(name, { signal }, () => acquire(index + 1))
        : manager.request(name, () => acquire(index + 1))
    }
    return acquire(0)
  }
}

class IndexedDbLockBackend implements LockBackend {
  readonly kind = 'indexeddb-fence' as const
  readonly requiresSessionDatabase: boolean
  private readonly openDatabase: () => Promise<Dexie>
  private readonly clientId: string
  private readonly now: () => number
  private readonly leaseMs: number
  private readonly renewMs: number
  private readonly retryMs: number
  private readonly recordName: string
  private readonly deleteRecordOnRelease: boolean
  private readonly trackTransactionActivity: boolean
  private readonly waitForWakeOrDeadlinePort:
    | IndexedDbLockBackendOptions['waitForWakeOrDeadline']
    | undefined
  private queue: Promise<void> = Promise.resolve()
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  private readonly delayRejectors = new Map<ReturnType<typeof setTimeout>, (error: Error) => void>()
  private disposed = false
  private readonly disposedSignal: Promise<void>
  private readonly resolveDisposedSignal: () => void
  private physicalWork = 0
  private idlePromise: Promise<void> = Promise.resolve()
  private resolveIdle: (() => void) | null = null

  constructor(options: IndexedDbLockBackendOptions = {}) {
    let resolveDisposed!: () => void
    this.disposedSignal = new Promise<void>((resolve) => {
      resolveDisposed = resolve
    })
    this.resolveDisposedSignal = resolveDisposed
    this.requiresSessionDatabase = options.openDatabase === undefined
    this.openDatabase =
      options.openDatabase ??
      (() => {
        throw new Error('LockDatabaseUnavailable')
      })
    this.clientId = options.clientId ?? newId()
    this.now = options.now ?? Date.now
    this.leaseMs = options.leaseMs ?? DEFAULT_FALLBACK_LOCK_LEASE_MS
    this.renewMs = options.renewMs ?? DEFAULT_FALLBACK_LOCK_RENEW_MS
    this.retryMs = options.retryMs ?? DEFAULT_FALLBACK_LOCK_RETRY_MS
    this.recordName = options.recordName ?? BROWSER_WRITER_LOCK_NAME
    this.deleteRecordOnRelease = options.deleteRecordOnRelease ?? false
    this.trackTransactionActivity = options.trackTransactionActivity ?? true
    this.waitForWakeOrDeadlinePort = options.waitForWakeOrDeadline
    if (
      this.leaseMs <= 0 ||
      this.renewMs <= 0 ||
      this.retryMs <= 0 ||
      this.renewMs >= this.leaseMs
    ) {
      throw new Error('InvalidFallbackLockTiming')
    }
  }

  async run<T>(
    logicalNames: readonly string[],
    fn: (grant: LockGrant) => Promise<T> | T,
    options: { database?: Dexie; signal?: AbortSignal } = {},
  ): Promise<T> {
    if (this.disposed) throw new Error('LockBackendDisposed')
    throwIfAborted(options.signal)
    this.beginPhysicalWork()
    const prior = this.queue
    let releaseQueue!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseQueue = resolve
    })
    this.queue = prior.then(() => gate)
    let cleanupOwnsQueue = false
    try {
      await this.waitForQueueTurn(prior, options.signal)
      if (this.isDisposed()) throw new Error('LockBackendDisposed')
      throwIfAborted(options.signal)
      const db = options.database ?? (await this.openDatabaseUntilDisposed())
      if (this.isDisposed()) throw new Error('LockBackendDisposed')
      throwIfAborted(options.signal)
      const identity = await this.acquire(db, options.signal)
      const owned = await this.runOwned(db, identity, logicalNames, fn)
      cleanupOwnsQueue = true
      void owned.cleanup.finally(() => {
        releaseQueue()
        this.endPhysicalWork()
      })
      if (owned.outcome.kind === 'error') throw owned.outcome.error
      return owned.outcome.value
    } finally {
      if (!cleanupOwnsQueue) {
        releaseQueue()
        this.endPhysicalWork()
      }
    }
  }

  runAuthoritativeCommandSession<T>(
    database: Dexie,
    operation: (session: AuthoritativeCommandLockSession) => Promise<T> | T,
    options: { signal?: AbortSignal } = {},
  ): Promise<T> {
    return this.run(
      [],
      (rootGrant) =>
        operation(
          createAuthoritativeCommandLockSession(
            this.kind,
            rootGrant.ownershipLost,
            (resourceNames, child) =>
              Promise.resolve(
                child({
                  ...rootGrant,
                  logicalNames: normalizeNamedLocks(resourceNames),
                }),
              ),
          ),
        ),
      { database, ...(options.signal ? { signal: options.signal } : {}) },
    )
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.resolveDisposedSignal()
    for (const timer of this.timers) {
      clearInterval(timer)
    }
    this.timers.clear()
    for (const [timer, reject] of this.delayRejectors) {
      clearTimeout(timer)
      reject(new Error('LockBackendDisposed'))
    }
    this.delayRejectors.clear()
  }

  awaitIdle(): Promise<void> {
    return this.idlePromise
  }

  async disposeAndDrain(): Promise<void> {
    this.dispose()
    await this.awaitIdle()
  }

  private isDisposed(): boolean {
    return this.disposed
  }

  private async openDatabaseUntilDisposed(): Promise<Dexie> {
    const opening = Promise.resolve().then(this.openDatabase)
    void opening.catch(() => {})
    return Promise.race([
      opening,
      this.disposedSignal.then(() => {
        throw new Error('LockBackendDisposed')
      }),
    ])
  }

  private waitForQueueTurn(prior: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('LockBackendDisposed'))
    if (signal?.aborted) return Promise.reject(abortError(signal))
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (operation: () => void) => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        operation()
      }
      const onAbort = () => finish(() => reject(abortError(signal as AbortSignal)))
      signal?.addEventListener('abort', onAbort, { once: true })
      void prior.then(() => finish(resolve))
      void this.disposedSignal.then(() => finish(() => reject(new Error('LockBackendDisposed'))))
    })
  }

  private async acquire(db: Dexie, signal: AbortSignal | undefined): Promise<FenceIdentity> {
    for (;;) {
      if (this.disposed) throw new Error('LockBackendDisposed')
      throwIfAborted(signal)
      const wake = subscribeLockWake(db.name, this.recordName)
      const now = this.now()
      try {
        const result = await this.runWriteActivity(() =>
          db.transaction('rw', db.table('browserLocks'), async () => {
            const table = db.table<BrowserLockRow, string>('browserLocks')
            const stored = await table.get(this.recordName)
            const row = stored ?? emptyBrowserLockRow(this.recordName)
            if (!validLockRow(row, this.recordName)) {
              throw new LockRecordCorruptError(this.recordName)
            }
            if (row.ownerClientId !== null && row.expiresAt > now) {
              return { kind: 'busy' as const, retryAt: row.expiresAt }
            }
            if (row.fencingToken >= Number.MAX_SAFE_INTEGER) {
              throw new LockRecordCorruptError(this.recordName)
            }
            const next: BrowserLockRow = {
              name: this.recordName,
              ownerClientId: this.clientId,
              leaseId: newId(),
              fencingToken: row.fencingToken + 1,
              acquiredAt: now,
              heartbeatAt: now,
              expiresAt: now + this.leaseMs,
            }
            await table.put(next)
            return {
              kind: 'acquired' as const,
              identity: {
                ownerClientId: next.ownerClientId as string,
                leaseId: next.leaseId as string,
                fencingToken: next.fencingToken,
              },
            }
          }),
        )
        if (result.kind === 'acquired') {
          if (!signal?.aborted) return result.identity
          await this.release(db, result.identity)
          throw abortError(signal)
        }
        await this.waitForWakeOrDeadline(
          wake.promise,
          Math.max(0, result.retryAt - this.now()),
          signal,
        )
      } finally {
        wake.close()
      }
    }
  }

  private async runOwned<T>(
    acquiredDb: Dexie,
    identity: FenceIdentity,
    logicalNames: readonly string[],
    fn: (grant: LockGrant) => Promise<T> | T,
  ): Promise<{
    readonly outcome:
      | { readonly kind: 'value'; readonly value: T }
      | { readonly kind: 'error'; readonly error: unknown }
    readonly cleanup: Promise<void>
  }> {
    let ownership: OwnershipState = 'held'
    const ownershipController = new AbortController()
    const loseOwnership = (reason: Error): void => {
      if (!ownershipController.signal.aborted) ownershipController.abort(reason)
    }
    let renewal = Promise.resolve()
    const renew = () => {
      renewal = renewal
        .then(async () => {
          if (ownership !== 'held') return
          const renewed = await this.renew(acquiredDb, identity)
          if (!renewed) {
            ownership = 'lost'
            loseOwnership(new LockFenceLostError(identity.fencingToken, this.recordName))
          }
        })
        .catch(() => {
          ownership = 'uncertain'
          loseOwnership(new LockOwnershipUncertainError(this.recordName))
        })
    }
    const heartbeat = setInterval(renew, this.renewMs)
    this.timers.add(heartbeat)
    const grant: LockGrant = {
      kind: this.kind,
      logicalNames,
      ownershipLost: ownershipController.signal,
      runTransaction: async (db, tables, transactionFn) => {
        if (this.disposed) throw new Error('LockBackendDisposed')
        if (ownership === 'lost') {
          throw new LockFenceLostError(identity.fencingToken, this.recordName)
        }
        if (ownership === 'uncertain') throw new LockOwnershipUncertainError(this.recordName)
        if (db.name !== acquiredDb.name) throw new Error('LockDatabaseMismatch')
        const run = () =>
          db.transaction(
            'rw',
            uniqueTransactionTables(db, tables, true),
            async (tx: Transaction) => {
              if (this.disposed) throw new Error('LockBackendDisposed')
              const row = await tx
                .table<BrowserLockRow, string>('browserLocks')
                .get(this.recordName)
              if (
                !ownsFence(row, identity, this.recordName) ||
                (row?.expiresAt ?? 0) <= this.now()
              ) {
                ownership = 'lost'
                loseOwnership(new LockFenceLostError(identity.fencingToken, this.recordName))
                throw new LockFenceLostError(identity.fencingToken, this.recordName)
              }
              return transactionFn(tx)
            },
          )
        return this.trackTransactionActivity ? runWithLocalWriteActivity(run) : run()
      },
    }
    let outcome:
      | { readonly kind: 'value'; readonly value: T }
      | { readonly kind: 'error'; readonly error: unknown }
    try {
      outcome = { kind: 'value', value: await fn(grant) }
    } catch (error) {
      outcome = { kind: 'error', error }
    }
    clearInterval(heartbeat)
    this.timers.delete(heartbeat)
    const physicalCleanup = renewal.then(
      () => this.release(acquiredDb, identity),
      () => this.release(acquiredDb, identity),
    )
    void physicalCleanup.catch(() => {})
    const cleanup = Promise.race([physicalCleanup, this.disposedSignal]).then(
      () => undefined,
      () => undefined,
    )
    return { outcome, cleanup }
  }

  private async renew(db: Dexie, identity: FenceIdentity): Promise<boolean> {
    const now = this.now()
    return this.runWriteActivity(() =>
      db.transaction('rw', db.table('browserLocks'), async () => {
        const table = db.table<BrowserLockRow, string>('browserLocks')
        const row = await table.get(this.recordName)
        if (!row || !ownsFence(row, identity, this.recordName) || row.expiresAt <= now) return false
        await table.put({ ...row, heartbeatAt: now, expiresAt: now + this.leaseMs })
        return true
      }),
    )
  }

  private async release(db: Dexie, identity: FenceIdentity): Promise<void> {
    const released = await this.runWriteActivity(() =>
      db.transaction('rw', db.table('browserLocks'), async () => {
        const table = db.table<BrowserLockRow, string>('browserLocks')
        const row = await table.get(this.recordName)
        if (!row || !ownsFence(row, identity, this.recordName)) return false
        if (this.deleteRecordOnRelease) {
          await table.delete(this.recordName)
          return true
        }
        await table.put({
          ...row,
          ownerClientId: null,
          leaseId: null,
          heartbeatAt: this.now(),
          expiresAt: 0,
        })
        return true
      }),
    )
    if (released) publishLockWake(db.name, this.recordName)
  }

  private waitForWakeOrDeadline(
    wake: Promise<void>,
    delay: number,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    if (this.waitForWakeOrDeadlinePort) {
      return this.waitForWakeOrDeadlinePort(wake, delay, signal)
    }
    if (this.disposed) return Promise.reject(new Error('LockBackendDisposed'))
    if (signal?.aborted) return Promise.reject(abortError(signal))
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.delayRejectors.delete(timer)
        signal?.removeEventListener('abort', onAbort)
        if (error) reject(error)
        else resolve()
      }
      const onAbort = () => finish(abortError(signal as AbortSignal))
      const timer = setTimeout(() => finish(), delay)
      this.delayRejectors.set(timer, (error) => finish(error))
      signal?.addEventListener('abort', onAbort, { once: true })
      void wake.then(() => finish())
    })
  }

  private runWriteActivity<T>(run: () => Promise<T>): Promise<T> {
    return this.trackTransactionActivity ? runWithLocalWriteActivity(run) : run()
  }

  private beginPhysicalWork(): void {
    if (this.physicalWork === 0) {
      this.idlePromise = new Promise<void>((resolve) => {
        this.resolveIdle = resolve
      })
    }
    this.physicalWork += 1
  }

  private endPhysicalWork(): void {
    this.physicalWork -= 1
    if (this.physicalWork !== 0) return
    const resolve = this.resolveIdle
    this.resolveIdle = null
    resolve?.()
  }
}

const webLocksBackend = new WebLocksBackend()
const coordinationWebLocksBackend = new CoordinationWebLocksBackend()
let fallbackBackend: IndexedDbLockBackend | null = null
let backendOverride: LockBackend | null = null
let lockRuntimeDisposed = true
let activeLockRuns = 0
let lockRuntimeIdle: Promise<void> = Promise.resolve()
let resolveLockRuntimeIdle: (() => void) | null = null
let disposedBackendDrain: Promise<void> = Promise.resolve()
let lockRuntimeController = new AbortController()
const coordinationBackends = new Set<IndexedDbLockBackend>()

function hasWebLocks(): boolean {
  if (typeof navigator === 'undefined') return false
  const locks = (navigator as unknown as { locks?: LockManager }).locks
  return locks !== undefined && typeof locks.request === 'function'
}

function selectedBackend(): LockBackend {
  if (backendOverride) return backendOverride
  if (hasWebLocks()) return webLocksBackend
  fallbackBackend ??= new IndexedDbLockBackend()
  return fallbackBackend
}

export function normalizeNamedLocks(resourceNames: readonly string[]): string[] {
  return [...new Set(resourceNames)].sort((left, right) => left.localeCompare(right))
}

function createAuthoritativeCommandLockSession(
  kind: LockGrant['kind'],
  ownershipLost: AbortSignal | undefined,
  runResourceLocks: <T>(
    resourceNames: readonly string[],
    operation: (grant: LockGrant) => Promise<T> | T,
  ) => Promise<T>,
): AuthoritativeCommandLockSession {
  let resourceScopeActive = false
  return Object.freeze({
    kind,
    ...(ownershipLost ? { ownershipLost } : {}),
    async withResourceLocks<T>(
      resourceNames: readonly string[],
      operation: (grant: LockGrant) => Promise<T> | T,
    ): Promise<T> {
      if (resourceScopeActive) throw new Error('AuthoritativeCommandNestedResourceLocks')
      if (ownershipLost?.aborted) throw abortError(ownershipLost)
      const normalized = normalizeNamedLocks(resourceNames)
      if (normalized.includes(WORKSPACE_AUTHORITATIVE_GATE) || normalized.includes('db:global')) {
        throw new Error('AuthoritativeCommandGlobalResourceForbidden')
      }
      resourceScopeActive = true
      try {
        return await runResourceLocks(normalized, operation)
      } finally {
        resourceScopeActive = false
      }
    },
  })
}

export function createIndexedDbLockBackend(options: IndexedDbLockBackendOptions = {}): LockBackend {
  return new IndexedDbLockBackend(options)
}

export function configureLockDatabaseRunner(runner: LockDatabaseRunner): void {
  productionDatabaseRunner = runner
}

export async function withCoordinationLock<T>(
  resourceName: string,
  fn: (lease: { readonly ownershipLost?: AbortSignal }) => Promise<T> | T,
  options: { signal?: AbortSignal; database?: Dexie } = {},
): Promise<T> {
  const lockName = coordinationLockName(resourceName)
  if (lockRuntimeDisposed) throw new Error('LockRuntimeDisposed')
  if (options.signal?.aborted) throw new DOMException('Coordination aborted', 'AbortError')
  if (hasWebLocks()) {
    return runWithLockRuntime([lockName], (grant) => fn(grant), {
      backend: coordinationWebLocksBackend,
      signal: options.signal,
      database: options.database,
    })
  }
  const coordinationBackend = new IndexedDbLockBackend({
    recordName: lockName,
    deleteRecordOnRelease: true,
  })
  coordinationBackends.add(coordinationBackend)
  const abort = () => coordinationBackend.dispose()
  options.signal?.addEventListener('abort', abort, { once: true })
  try {
    return await runWithLockRuntime([lockName], (grant) => fn(grant), {
      backend: coordinationBackend,
      signal: options.signal,
      database: options.database,
    })
  } finally {
    options.signal?.removeEventListener('abort', abort)
    await coordinationBackend.disposeAndDrain()
    coordinationBackends.delete(coordinationBackend)
  }
}

export async function withNamedLocks<T>(
  resourceNames: readonly string[],
  fn: (grant: LockGrant) => Promise<T> | T,
  options: { signal?: AbortSignal } = {},
): Promise<T> {
  return runWithLockRuntime(normalizeNamedLocks(resourceNames), fn, options)
}

export function withSharedAuthoritativeCommandSession<T>(
  database: Dexie,
  operation: (session: AuthoritativeCommandLockSession) => Promise<T> | T,
  options: { signal?: AbortSignal } = {},
): Promise<T> {
  return runInsideLockRuntime(options.signal, (signal) =>
    selectedBackend().runAuthoritativeCommandSession(database, operation, { signal }),
  )
}

export function withSharedGenerationLifetime<T>(
  operation: () => Promise<T> | T,
  options: { signal?: AbortSignal } = {},
): Promise<T> {
  const signal = options.signal
  if (signal?.aborted) return Promise.reject(abortError(signal))
  if (!hasWebLocks()) return Promise.resolve().then(operation)
  return navigator.locks.request(
    GENERATION_LIFETIME_GATE,
    { mode: 'shared', ...(signal ? { signal } : {}) },
    operation,
  )
}

export function withExclusiveGenerationLifetime<T>(
  operation: () => Promise<T> | T,
  options: { signal?: AbortSignal } = {},
): Promise<T> {
  const signal = options.signal
  if (signal?.aborted) return Promise.reject(abortError(signal))
  if (!hasWebLocks()) return Promise.reject(new Error('GenerationLifetimeGateUnavailable'))
  return navigator.locks.request(
    GENERATION_LIFETIME_GATE,
    { mode: 'exclusive', ...(signal ? { signal } : {}) },
    operation,
  )
}

async function runWithLockRuntime<T>(
  logicalNames: readonly string[],
  fn: (grant: LockGrant) => Promise<T> | T,
  options: {
    backend?: ResourceLockBackend
    signal?: AbortSignal | undefined
    database?: Dexie | undefined
  } = {},
): Promise<T> {
  return runInsideLockRuntime(options.signal, async (signal) => {
    const backend = options.backend ?? selectedBackend()
    const run = (database?: Dexie) =>
      backend.run(logicalNames, fn, {
        ...(database ? { database } : {}),
        signal,
      })
    if (!backend.requiresSessionDatabase) return run(options.database)
    if (options.database) return run(options.database)
    if (!productionDatabaseRunner) throw new Error('LockDatabaseRunnerUnavailable')
    return productionDatabaseRunner((database) => run(database))
  })
}

async function runInsideLockRuntime<T>(
  externalSignal: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<T> | T,
): Promise<T> {
  if (lockRuntimeDisposed) throw new Error('LockRuntimeDisposed')
  beginLockRuntimeWork()
  const controller = new AbortController()
  const unlinkRuntime = linkAbortSignal(lockRuntimeController.signal, controller)
  const unlinkExternal = linkAbortSignal(externalSignal, controller)
  try {
    throwIfAborted(controller.signal)
    return await operation(controller.signal)
  } finally {
    unlinkExternal()
    unlinkRuntime()
    endLockRuntimeWork()
  }
}

export async function withNamedLock<T>(
  resourceName: string,
  fn: (grant: LockGrant) => Promise<T> | T,
  options: { signal?: AbortSignal } = {},
): Promise<T> {
  return withNamedLocks([resourceName], fn, options)
}

export async function withQuiescedWorkspaceReplacementLock<T>(
  db: Dexie,
  fn: (grant: LockGrant) => Promise<T> | T,
  options: { readonly signal?: AbortSignal } = {},
): Promise<T> {
  const logicalNames = ['db:global'] as const
  const signal = options.signal
  if (signal?.aborted) throw lockAbortError(signal.reason)
  if (hasWebLocks()) {
    const grant: LockGrant = {
      kind: 'web-locks',
      logicalNames,
      runTransaction: (transactionDb, tables, transactionFn) =>
        transactionDb.transaction(
          'rw',
          uniqueTransactionTables(transactionDb, tables, false),
          transactionFn,
        ),
    }
    return navigator.locks.request(
      WORKSPACE_AUTHORITATIVE_GATE,
      { mode: 'exclusive', ...(signal ? { signal } : {}) },
      () => {
        if (signal?.aborted) throw lockAbortError(signal.reason)
        return navigator.locks.request(
          logicalNames[0],
          { mode: 'exclusive', ...(signal ? { signal } : {}) },
          () => {
            if (signal?.aborted) throw lockAbortError(signal.reason)
            return fn(grant)
          },
        )
      },
    )
  }
  const backend = new IndexedDbLockBackend({
    openDatabase: () => Promise.resolve(db),
    trackTransactionActivity: false,
  })
  const admission = { entered: false }
  const abortPending = () => {
    if (!admission.entered) backend.dispose()
  }
  signal?.addEventListener('abort', abortPending, { once: true })
  try {
    return await backend.run(
      logicalNames,
      (grant) => {
        if (signal?.aborted) throw lockAbortError(signal.reason)
        admission.entered = true
        signal?.removeEventListener('abort', abortPending)
        return fn(grant)
      },
      { database: db },
    )
  } catch (error) {
    if (
      !admission.entered &&
      signal?.aborted &&
      error instanceof Error &&
      error.message === 'LockBackendDisposed'
    ) {
      throw lockAbortError(signal.reason)
    }
    throw error
  } finally {
    signal?.removeEventListener('abort', abortPending)
    await backend.disposeAndDrain()
  }
}

function lockAbortError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error('LockOperationAborted', { cause: reason })
}

export function coordinationLockName(resourceName: string): string {
  return `${COORDINATION_LOCK_PREFIX}${resourceName}`
}

export async function withMutationLocks<T>(
  scopes: readonly MutationScope[],
  fn: (grant: LockGrant) => Promise<T> | T,
): Promise<T> {
  const names = normalizeMutationScopes(scopes).map(scopeResourceName)
  return runWithLockRuntime(names, fn)
}

export function __setLockBackendForTests(backend: LockBackend | null): void {
  backendOverride?.dispose?.()
  backendOverride = backend
}

export function disposeLockRuntime(): void {
  if (lockRuntimeDisposed) return
  lockRuntimeDisposed = true
  lockRuntimeController.abort(new Error('LockRuntimeDisposed'))
  const backend = backendOverride ?? fallbackBackend
  backend?.dispose?.()
  for (const coordinationBackend of coordinationBackends) coordinationBackend.dispose()
  disposedBackendDrain = Promise.all([
    backend?.awaitIdle?.() ?? Promise.resolve(),
    ...[...coordinationBackends].map((coordinationBackend) => coordinationBackend.awaitIdle()),
  ]).then(() => {
    coordinationBackends.clear()
  })
  if (backend === fallbackBackend) fallbackBackend = null
}

export async function awaitLockRuntimeIdle(): Promise<void> {
  await Promise.all([lockRuntimeIdle, disposedBackendDrain])
}

export function assertLockRuntimeClosed(): void {
  if (!lockRuntimeDisposed || activeLockRuns !== 0 || coordinationBackends.size > 0) {
    throw new Error('LockRuntimeNotClosed')
  }
}

export function resumeLockRuntime(): void {
  if (activeLockRuns !== 0) throw new Error('LockRuntimeBusy')
  if (coordinationBackends.size !== 0) throw new Error('CoordinationLockRuntimeBusy')
  lockRuntimeDisposed = false
  lockRuntimeController = new AbortController()
  disposedBackendDrain = Promise.resolve()
}

function beginLockRuntimeWork(): void {
  if (activeLockRuns === 0) {
    lockRuntimeIdle = new Promise<void>((resolve) => {
      resolveLockRuntimeIdle = resolve
    })
  }
  activeLockRuns += 1
}

function endLockRuntimeWork(): void {
  activeLockRuns -= 1
  if (activeLockRuns !== 0) return
  const resolve = resolveLockRuntimeIdle
  resolveLockRuntimeIdle = null
  resolve?.()
}

export function __resetLockTrackerForTests(options: { admissionsOpen?: boolean } = {}): void {
  TEST_HELD_SCOPES.length = 0
  backendOverride?.dispose?.()
  backendOverride = null
  fallbackBackend?.dispose()
  fallbackBackend = null
  for (const coordinationBackend of coordinationBackends) coordinationBackend.dispose()
  coordinationBackends.clear()
  lockRuntimeDisposed = !(options.admissionsOpen ?? false)
  lockRuntimeController = new AbortController()
  activeLockRuns = 0
  resolveLockRuntimeIdle?.()
  resolveLockRuntimeIdle = null
  lockRuntimeIdle = Promise.resolve()
  disposedBackendDrain = Promise.resolve()
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

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Lock acquisition aborted', 'AbortError')
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError(signal)
}
