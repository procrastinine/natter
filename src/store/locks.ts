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
  message: 1,
  children: 2,
  draft: 3,
  attachment: 4,
} as const

const DEFAULT_FALLBACK_LOCK_LEASE_MS = 15_000
const DEFAULT_FALLBACK_LOCK_RENEW_MS = 3_000
const DEFAULT_FALLBACK_LOCK_RETRY_MS = 100
const WORKSPACE_AUTHORITATIVE_GATE = 'workspace:authoritative'
const COORDINATION_LOCK_PREFIX = 'natter:coordination:'

const TEST_HELD_SCOPES: string[] = []
let productionDatabaseOpener: (() => Promise<Dexie>) | null = null

type TransactionTable = { readonly name: string } | string

export interface LockGrant {
  readonly kind: 'web-locks' | 'indexeddb-fence'
  readonly logicalNames: readonly string[]
  runTransaction<T>(
    db: Dexie,
    tables: readonly TransactionTable[],
    fn: (tx: Transaction) => Promise<T> | T,
  ): Promise<T>
}

export interface LockBackend {
  readonly kind: LockGrant['kind']
  run<T>(logicalNames: readonly string[], fn: (grant: LockGrant) => Promise<T> | T): Promise<T>
  dispose?(): void
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
}

interface FenceIdentity {
  ownerClientId: string
  leaseId: string
  fencingToken: number
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

class WebLocksBackend implements LockBackend {
  readonly kind = 'web-locks' as const

  async run<T>(
    logicalNames: readonly string[],
    fn: (grant: LockGrant) => Promise<T> | T,
  ): Promise<T> {
    const manager = navigator.locks
    const grant: LockGrant = {
      kind: this.kind,
      logicalNames,
      runTransaction: (db, tables, transactionFn) =>
        runWithLocalWriteActivity(() =>
          db.transaction('rw', uniqueTransactionTables(db, tables, false), transactionFn),
        ),
    }
    const acquire = async (index: number): Promise<T> => {
      if (index >= logicalNames.length) return fn(grant)
      const name = logicalNames[index] as string
      return manager.request(name, () => acquire(index + 1))
    }
    const mode = logicalNames.includes('db:global') ? 'exclusive' : 'shared'
    return manager.request(WORKSPACE_AUTHORITATIVE_GATE, { mode }, () => acquire(0))
  }
}

class IndexedDbLockBackend implements LockBackend {
  readonly kind = 'indexeddb-fence' as const
  private readonly openDatabase: () => Promise<Dexie>
  private readonly clientId: string
  private readonly now: () => number
  private readonly leaseMs: number
  private readonly renewMs: number
  private readonly retryMs: number
  private readonly recordName: string
  private readonly deleteRecordOnRelease: boolean
  private queue: Promise<void> = Promise.resolve()
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  private readonly delayRejectors = new Map<ReturnType<typeof setTimeout>, (error: Error) => void>()
  private readonly cleanupResolvers = new Map<ReturnType<typeof setTimeout>, () => void>()
  private disposed = false
  private readonly disposedSignal: Promise<void>
  private readonly resolveDisposedSignal: () => void

  constructor(options: IndexedDbLockBackendOptions = {}) {
    let resolveDisposed!: () => void
    this.disposedSignal = new Promise<void>((resolve) => {
      resolveDisposed = resolve
    })
    this.resolveDisposedSignal = resolveDisposed
    this.openDatabase =
      options.openDatabase ??
      (() => {
        if (!productionDatabaseOpener) throw new Error('LockDatabaseUnavailable')
        return productionDatabaseOpener()
      })
    this.clientId = options.clientId ?? newId()
    this.now = options.now ?? Date.now
    this.leaseMs = options.leaseMs ?? DEFAULT_FALLBACK_LOCK_LEASE_MS
    this.renewMs = options.renewMs ?? DEFAULT_FALLBACK_LOCK_RENEW_MS
    this.retryMs = options.retryMs ?? DEFAULT_FALLBACK_LOCK_RETRY_MS
    this.recordName = options.recordName ?? BROWSER_WRITER_LOCK_NAME
    this.deleteRecordOnRelease = options.deleteRecordOnRelease ?? false
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
  ): Promise<T> {
    if (this.disposed) throw new Error('LockBackendDisposed')
    const prior = this.queue
    let releaseQueue!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseQueue = resolve
    })
    this.queue = prior.then(() => gate)
    try {
      const ready = await Promise.race([
        prior.then(() => true),
        this.disposedSignal.then(() => false),
      ])
      if (!ready || this.isDisposed()) throw new Error('LockBackendDisposed')
      const db = await this.openDatabaseUntilDisposed()
      const identity = await this.acquire(db)
      return await this.runOwned(db, identity, logicalNames, fn)
    } finally {
      releaseQueue()
    }
  }

  dispose(): void {
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
    for (const finish of this.cleanupResolvers.values()) finish()
    this.cleanupResolvers.clear()
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

  private async acquire(db: Dexie): Promise<FenceIdentity> {
    for (;;) {
      if (this.disposed) throw new Error('LockBackendDisposed')
      const now = this.now()
      const identity = await runWithLocalWriteActivity(() =>
        db.transaction('rw', db.table('browserLocks'), async () => {
          const table = db.table<BrowserLockRow, string>('browserLocks')
          const stored = await table.get(this.recordName)
          const row = stored ?? emptyBrowserLockRow(this.recordName)
          if (!validLockRow(row, this.recordName)) {
            throw new LockRecordCorruptError(this.recordName)
          }
          if (row.ownerClientId !== null && row.expiresAt > now) return undefined
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
            ownerClientId: next.ownerClientId as string,
            leaseId: next.leaseId as string,
            fencingToken: next.fencingToken,
          }
        }),
      )
      if (identity) return identity
      await this.delay(this.retryMs)
    }
  }

  private async runOwned<T>(
    acquiredDb: Dexie,
    identity: FenceIdentity,
    logicalNames: readonly string[],
    fn: (grant: LockGrant) => Promise<T> | T,
  ): Promise<T> {
    let ownership: OwnershipState = 'held'
    let renewal = Promise.resolve()
    const renew = () => {
      renewal = renewal
        .then(async () => {
          if (ownership !== 'held') return
          const renewed = await this.renew(acquiredDb, identity)
          if (!renewed) ownership = 'lost'
        })
        .catch(() => {
          ownership = 'uncertain'
        })
    }
    const heartbeat = setInterval(renew, this.renewMs)
    this.timers.add(heartbeat)
    const grant: LockGrant = {
      kind: this.kind,
      logicalNames,
      runTransaction: async (db, tables, transactionFn) => {
        if (this.disposed) throw new Error('LockBackendDisposed')
        if (ownership === 'lost') {
          throw new LockFenceLostError(identity.fencingToken, this.recordName)
        }
        if (ownership === 'uncertain') throw new LockOwnershipUncertainError(this.recordName)
        if (db.name !== acquiredDb.name) throw new Error('LockDatabaseMismatch')
        return runWithLocalWriteActivity(() =>
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
                throw new LockFenceLostError(identity.fencingToken, this.recordName)
              }
              return transactionFn(tx)
            },
          ),
        )
      },
    }
    try {
      return await fn(grant)
    } finally {
      clearInterval(heartbeat)
      this.timers.delete(heartbeat)
      await this.settleCleanup(renewal)
      await this.settleCleanup(this.release(acquiredDb, identity))
    }
  }

  private async renew(db: Dexie, identity: FenceIdentity): Promise<boolean> {
    const now = this.now()
    return runWithLocalWriteActivity(() =>
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
    await runWithLocalWriteActivity(() =>
      db.transaction('rw', db.table('browserLocks'), async () => {
        const table = db.table<BrowserLockRow, string>('browserLocks')
        const row = await table.get(this.recordName)
        if (!row || !ownsFence(row, identity, this.recordName)) return
        if (this.deleteRecordOnRelease) {
          await table.delete(this.recordName)
          return
        }
        await table.put({
          ...row,
          ownerClientId: null,
          leaseId: null,
          heartbeatAt: this.now(),
          expiresAt: 0,
        })
      }),
    )
  }

  private delay(ms: number): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('LockBackendDisposed'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.delayRejectors.delete(timer)
        if (this.disposed) reject(new Error('LockBackendDisposed'))
        else resolve()
      }, ms)
      this.delayRejectors.set(timer, reject)
    })
  }

  private settleCleanup(cleanup: Promise<void>): Promise<void> {
    if (this.disposed) {
      void cleanup.catch(() => {})
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.cleanupResolvers.delete(timer)
        resolve()
      }
      const timer = setTimeout(finish, Math.min(this.retryMs, 250))
      this.cleanupResolvers.set(timer, finish)
      void cleanup.then(finish, finish)
    })
  }
}

const webLocksBackend = new WebLocksBackend()
let fallbackBackend: IndexedDbLockBackend | null = null
let backendOverride: LockBackend | null = null

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

function normalizeNamedLocks(resourceNames: readonly string[]): string[] {
  return [...new Set(resourceNames)].sort((left, right) => left.localeCompare(right))
}

export function createIndexedDbLockBackend(options: IndexedDbLockBackendOptions = {}): LockBackend {
  return new IndexedDbLockBackend(options)
}

export function configureLockDatabaseOpener(opener: () => Promise<Dexie>): void {
  productionDatabaseOpener = opener
}

export async function withCoordinationLock<T>(
  resourceName: string,
  fn: () => Promise<T> | T,
  options: { signal?: AbortSignal } = {},
): Promise<T> {
  const lockName = `${COORDINATION_LOCK_PREFIX}${resourceName}`
  if (options.signal?.aborted) throw new DOMException('Coordination aborted', 'AbortError')
  if (hasWebLocks()) {
    return options.signal
      ? navigator.locks.request(lockName, { signal: options.signal }, () => fn())
      : navigator.locks.request(lockName, () => fn())
  }
  const coordinationBackend = new IndexedDbLockBackend({
    recordName: lockName,
    deleteRecordOnRelease: true,
  })
  const abort = () => coordinationBackend.dispose()
  options.signal?.addEventListener('abort', abort, { once: true })
  try {
    return await coordinationBackend.run([lockName], () => fn())
  } finally {
    options.signal?.removeEventListener('abort', abort)
    coordinationBackend.dispose()
  }
}

export async function withNamedLocks<T>(
  resourceNames: readonly string[],
  fn: (grant: LockGrant) => Promise<T> | T,
): Promise<T> {
  return selectedBackend().run(normalizeNamedLocks(resourceNames), fn)
}

export async function withNamedLock<T>(
  resourceName: string,
  fn: (grant: LockGrant) => Promise<T> | T,
): Promise<T> {
  return withNamedLocks([resourceName], fn)
}

export async function withMutationLocks<T>(
  scopes: readonly MutationScope[],
  fn: (grant: LockGrant) => Promise<T> | T,
): Promise<T> {
  const names = normalizeMutationScopes(scopes).map(scopeResourceName)
  return selectedBackend().run(names, fn)
}

export function __setLockBackendForTests(backend: LockBackend | null): void {
  backendOverride?.dispose?.()
  backendOverride = backend
}

export function __resetLockTrackerForTests(): void {
  TEST_HELD_SCOPES.length = 0
  backendOverride?.dispose?.()
  backendOverride = null
  fallbackBackend?.dispose()
  fallbackBackend = null
}
