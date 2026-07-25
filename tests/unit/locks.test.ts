import Dexie from 'dexie'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { MutationScope } from '../../src/core/types'
import { BROWSER_WRITER_LOCK_NAME, type BrowserLockRow } from '../../src/store/browser-lock-record'
import { createDbForTests } from '../../src/store/db'
import {
  __resetLockTrackerForTests,
  __setLockBackendForTests,
  assertAcquireOrder,
  awaitLockRuntimeIdle,
  createIndexedDbLockBackend,
  disposeLockRuntime,
  type LockBackend,
  LockFenceLostError,
  normalizeMutationScopes,
  resumeLockRuntime,
  ScopeOrderError,
  scopeResourceName,
  withMutationLocks,
  withNamedLock,
  withQuiescedWorkspaceReplacementLock,
  withTrackedScopes,
} from '../../src/store/locks'
import { resumeLocalTransactionAdmissions } from '../../src/store/transaction-activity'

beforeAll(() => {
  resumeLocalTransactionAdmissions()
})

afterEach(() => {
  __resetLockTrackerForTests({ admissionsOpen: true })
})

describe('scopeResourceName', () => {
  it('formats every mutation scope key deterministically', () => {
    expect(scopeResourceName({ kind: 'chat-meta', chatId: 'C1' })).toBe('chat-meta:C1')
    expect(scopeResourceName({ kind: 'message', messageId: 'M1' })).toBe('message:M1')
    expect(scopeResourceName({ kind: 'children', chatId: 'C1', parentId: null })).toBe(
      'children:C1:__root__',
    )
    expect(scopeResourceName({ kind: 'children', chatId: 'C1', parentId: 'M1' })).toBe(
      'children:C1:M1',
    )
    expect(scopeResourceName({ kind: 'draft', chatId: 'C1' })).toBe('draft:C1')
    expect(scopeResourceName({ kind: 'attachment', attachmentId: 'A1' })).toBe('attachment:A1')
  })
})

describe('normalizeMutationScopes', () => {
  it('dedupes and sorts by canonical kind order, then key', () => {
    const scopes: MutationScope[] = [
      { kind: 'attachment', attachmentId: 'A1' },
      { kind: 'message', messageId: 'M2' },
      { kind: 'children', chatId: 'C1', parentId: 'P1' },
      { kind: 'chat-meta', chatId: 'C1' },
      { kind: 'message', messageId: 'M1' },
      { kind: 'message', messageId: 'M2' },
    ]
    expect(normalizeMutationScopes(scopes).map(scopeResourceName)).toEqual([
      'chat-meta:C1',
      'message:M1',
      'message:M2',
      'children:C1:P1',
      'attachment:A1',
    ])
  })
})

describe('tracked acquisition order', () => {
  it('allows nested acquisition only in canonical order', async () => {
    await withTrackedScopes([{ kind: 'chat-meta', chatId: 'C1' }], async () => {
      await expect(
        withTrackedScopes([{ kind: 'message', messageId: 'M1' }], async () => 'ok'),
      ).resolves.toBe('ok')
    })
  })

  it('rejects descending order', async () => {
    await withTrackedScopes([{ kind: 'message', messageId: 'M1' }], async () => {
      await expect(
        withTrackedScopes([{ kind: 'chat-meta', chatId: 'C1' }], async () => 'boom'),
      ).rejects.toBeInstanceOf(ScopeOrderError)
    })
  })

  it('rejects re-acquiring the same scope', async () => {
    await withTrackedScopes([{ kind: 'message', messageId: 'M1' }], async () => {
      await expect(
        withTrackedScopes([{ kind: 'message', messageId: 'M1' }], async () => 'boom'),
      ).rejects.toBeInstanceOf(ScopeOrderError)
    })
  })

  it('assertAcquireOrder accepts raw resource names for tests', async () => {
    await withTrackedScopes([{ kind: 'chat-meta', chatId: 'C1' }], async () => {
      expect(() => assertAcquireOrder('message:M1')).not.toThrow()
      expect(() => assertAcquireOrder('chat-meta:C1')).toThrow(ScopeOrderError)
    })
  })

  it('releases tracked scopes after errors', async () => {
    await expect(
      withTrackedScopes([{ kind: 'children', chatId: 'C1', parentId: 'P1' }], async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    await expect(
      withTrackedScopes([{ kind: 'children', chatId: 'C1', parentId: 'P1' }], async () => 'ok'),
    ).resolves.toBe('ok')
  })
})

describe('lock runtime disposal', () => {
  it('gates and drains the primary mutation-lock path', async () => {
    const entered = deferred()
    const release = deferred()
    let disposed = false
    const backend: LockBackend = {
      kind: 'web-locks',
      run: async (logicalNames, fn) => {
        if (disposed) throw new Error('backend disposed')
        expect(logicalNames).toEqual(['message:M1'])
        return fn({
          kind: 'web-locks',
          logicalNames,
          runTransaction: async (_db, _tables, transactionFn) => transactionFn({} as never),
        })
      },
      runAuthoritativeCommandSession: async (_database, operation, options = {}) => {
        if (options.signal?.aborted) throw options.signal.reason
        return operation({
          kind: 'web-locks',
          withResourceLocks: (resourceNames, child) => backend.run(resourceNames, child, options),
        })
      },
      dispose: () => {
        disposed = true
      },
    }
    __setLockBackendForTests(backend)
    const operation = withMutationLocks([{ kind: 'message', messageId: 'M1' }], async () => {
      entered.resolve()
      await release.promise
    })
    await entered.promise

    disposeLockRuntime()
    await expect(
      withMutationLocks([{ kind: 'message', messageId: 'M2' }], async () => {}),
    ).rejects.toThrow('LockRuntimeDisposed')
    let drained = false
    const drain = awaitLockRuntimeIdle().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)

    release.resolve()
    await operation
    await drain
    expect(drained).toBe(true)
    __setLockBackendForTests(null)
    resumeLockRuntime()
  })
})

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function lockDatabases() {
  const name = `natter-lock-${Math.random().toString(36).slice(2)}`
  const left = createDbForTests(name)
  const right = createDbForTests(name)
  await left.open()
  await right.open()
  return {
    left,
    right,
    async close() {
      left.close()
      right.close()
      await Dexie.delete(name)
    },
  }
}

describe('IndexedDB fallback fencing', () => {
  it('serializes different logical resources across independent page backends', async () => {
    const databases = await lockDatabases()
    const releaseLeft = deferred()
    const leftEntered = deferred()
    let rightEntered = false
    const left = createIndexedDbLockBackend({
      openDatabase: async () => databases.left,
      clientId: 'left-page',
      leaseMs: 1_000,
      renewMs: 100,
      retryMs: 5,
    })
    const right = createIndexedDbLockBackend({
      openDatabase: async () => databases.right,
      clientId: 'right-page',
      leaseMs: 1_000,
      renewMs: 100,
      retryMs: 5,
    })

    const first = left.run(['message:M1'], async () => {
      leftEntered.resolve()
      await releaseLeft.promise
    })
    await leftEntered.promise
    const second = right.run(['profile:P1'], async () => {
      rightEntered = true
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(rightEntered).toBe(false)
    releaseLeft.resolve()
    await Promise.all([first, second])
    expect(rightEntered).toBe(true)

    left.dispose?.()
    right.dispose?.()
    await databases.close()
  })

  it('wakes a fallback follower on release without polling the lock row', async () => {
    const databases = await lockDatabases()
    const releaseLeft = deferred()
    const leftEntered = deferred()
    const rightEntered = deferred()
    const left = createIndexedDbLockBackend({
      openDatabase: async () => databases.left,
      clientId: 'left-page',
      leaseMs: 10_000,
      renewMs: 1_000,
      retryMs: 5,
    })
    const right = createIndexedDbLockBackend({
      openDatabase: async () => databases.right,
      clientId: 'right-page',
      leaseMs: 10_000,
      renewMs: 1_000,
      retryMs: 5,
    })
    const rightTransactions = vi.spyOn(databases.right, 'transaction')

    const first = left.run(['maintenance'], async () => {
      leftEntered.resolve()
      await releaseLeft.promise
    })
    await leftEntered.promise
    const second = right.run(['maintenance'], async () => {
      rightEntered.resolve()
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(rightTransactions).toHaveBeenCalledTimes(1)

    releaseLeft.resolve()
    await rightEntered.promise
    await Promise.all([first, second])
    expect(rightTransactions).toHaveBeenCalledTimes(3)

    left.dispose?.()
    right.dispose?.()
    await databases.close()
  })

  it('does not wake a fallback waiter from a release in another database', async () => {
    const waitingDatabases = await lockDatabases()
    const unrelatedDatabases = await lockDatabases()
    const now = Date.now()
    await waitingDatabases.left.browserLocks.put({
      name: BROWSER_WRITER_LOCK_NAME,
      ownerClientId: 'waiting-owner',
      leaseId: 'waiting-lease',
      fencingToken: 1,
      acquiredAt: now,
      heartbeatAt: now,
      expiresAt: now + 60_000,
    })
    const controller = new AbortController()
    const waitingBackend = createIndexedDbLockBackend({
      openDatabase: async () => waitingDatabases.right,
      clientId: 'waiting-page',
      leaseMs: 1_000,
      renewMs: 100,
      retryMs: 5,
    })
    const firstAttempt = deferred()
    const observeFirstRead = (row: BrowserLockRow | undefined): BrowserLockRow | undefined => {
      firstAttempt.resolve()
      return row
    }
    waitingDatabases.right.browserLocks.hook('reading', observeFirstRead)
    const transactions = vi.spyOn(waitingDatabases.right, 'transaction')
    const waiting = waitingBackend.run(['maintenance'], async () => {}, {
      signal: controller.signal,
    })
    await firstAttempt.promise
    waitingDatabases.right.browserLocks.hook('reading').unsubscribe(observeFirstRead)
    expect(transactions).toHaveBeenCalledTimes(1)

    const unrelatedBackend = createIndexedDbLockBackend({
      openDatabase: async () => unrelatedDatabases.left,
      clientId: 'unrelated-page',
      leaseMs: 1_000,
      renewMs: 100,
      retryMs: 5,
    })
    await unrelatedBackend.run(['maintenance'], async () => {})
    await unrelatedBackend.awaitIdle?.()
    await Promise.resolve()
    expect(transactions).toHaveBeenCalledTimes(1)

    const reason = new Error('waiting-cancelled')
    controller.abort(reason)
    await expect(waiting).rejects.toBe(reason)
    waitingBackend.dispose?.()
    unrelatedBackend.dispose?.()
    await waitingDatabases.close()
    await unrelatedDatabases.close()
  })

  it('takes over an abandoned fallback lease at its persisted expiry without release events', async () => {
    const databases = await lockDatabases()
    const now = Date.now()
    await databases.left.browserLocks.put({
      name: BROWSER_WRITER_LOCK_NAME,
      ownerClientId: 'crashed-page',
      leaseId: 'crashed-lease',
      fencingToken: 7,
      acquiredAt: now,
      heartbeatAt: now,
      expiresAt: now + 80,
    })
    const backend = createIndexedDbLockBackend({
      openDatabase: async () => databases.right,
      clientId: 'successor-page',
      leaseMs: 1_000,
      renewMs: 100,
      retryMs: 5,
    })
    const transactions = vi.spyOn(databases.right, 'transaction')

    await backend.run(['maintenance'], async () => {})

    expect(transactions).toHaveBeenCalledTimes(3)
    expect(await databases.left.browserLocks.get(BROWSER_WRITER_LOCK_NAME)).toMatchObject({
      ownerClientId: null,
      fencingToken: 8,
    })
    backend.dispose?.()
    await databases.close()
  })

  it('rejects a stale owner inside the same transaction before domain writes', async () => {
    const databases = await lockDatabases()
    let now = 0
    const leftGrantReady = deferred()
    const letLeftWrite = deferred()
    const rightClaimed = deferred()
    const releaseRight = deferred()
    const left = createIndexedDbLockBackend({
      openDatabase: async () => databases.left,
      clientId: 'left-page',
      now: () => now,
      leaseMs: 100,
      renewMs: 50,
      retryMs: 5,
    })
    const right = createIndexedDbLockBackend({
      openDatabase: async () => databases.right,
      clientId: 'right-page',
      now: () => now,
      leaseMs: 100,
      renewMs: 50,
      retryMs: 5,
    })

    const leftWrite = left.run(['message:M1'], async (grant) => {
      leftGrantReady.resolve()
      await letLeftWrite.promise
      await grant.runTransaction(databases.left, [databases.left.settings], async (tx) => {
        await tx.table('settings').put({ key: 'left-write', value: true })
      })
    })
    await leftGrantReady.promise
    now = 101
    const rightWrite = right.run(['message:M1'], async (grant) => {
      await grant.runTransaction(databases.right, [databases.right.settings], async (tx) => {
        await tx.table('settings').put({ key: 'right-write', value: true })
      })
      rightClaimed.resolve()
      await releaseRight.promise
    })
    await rightClaimed.promise
    letLeftWrite.resolve()
    await expect(leftWrite).rejects.toBeInstanceOf(LockFenceLostError)
    expect(await databases.left.settings.get('left-write')).toBeUndefined()
    expect((await databases.left.settings.get('right-write'))?.value).toBe(true)
    releaseRight.resolve()
    await rightWrite

    left.dispose?.()
    right.dispose?.()
    await databases.close()
  })

  it('notifies a long-lived coordination callback when its fallback lease is lost', async () => {
    const databases = await lockDatabases()
    let now = 0
    const leftEntered = deferred()
    const rightEntered = deferred()
    const releaseRight = deferred()
    const left = createIndexedDbLockBackend({
      openDatabase: async () => databases.left,
      clientId: 'left-page',
      now: () => now,
      leaseMs: 100,
      renewMs: 20,
      retryMs: 5,
    })
    const right = createIndexedDbLockBackend({
      openDatabase: async () => databases.right,
      clientId: 'right-page',
      now: () => now,
      leaseMs: 100,
      renewMs: 20,
      retryMs: 5,
    })

    let lossReason: unknown
    const first = left.run(['maintenance'], async (grant) => {
      const ownershipLost = grant.ownershipLost
      if (!ownershipLost) throw new Error('FallbackOwnershipSignalMissing')
      leftEntered.resolve()
      await new Promise<void>((resolve) => {
        ownershipLost.addEventListener(
          'abort',
          () => {
            lossReason = ownershipLost.reason
            resolve()
          },
          { once: true },
        )
      })
    })
    await leftEntered.promise
    now = 101
    const second = right.run(['maintenance'], async () => {
      rightEntered.resolve()
      await releaseRight.promise
    })

    await rightEntered.promise
    await first
    expect(lossReason).toBeInstanceOf(LockFenceLostError)
    releaseRight.resolve()
    await second

    left.dispose?.()
    right.dispose?.()
    await databases.close()
  })

  it('retains and increments the fencing token across release and reopen', async () => {
    const databases = await lockDatabases()
    const first = createIndexedDbLockBackend({
      openDatabase: async () => databases.left,
      clientId: 'left-page',
      leaseMs: 1_000,
      renewMs: 100,
      retryMs: 5,
    })
    await first.run(['message:M1'], async () => {})
    const released = await databases.left.browserLocks.get(BROWSER_WRITER_LOCK_NAME)
    expect(released).toMatchObject({
      ownerClientId: null,
      leaseId: null,
      fencingToken: 1,
      expiresAt: 0,
    })
    first.dispose?.()
    databases.left.close()
    await databases.left.open()
    const second = createIndexedDbLockBackend({
      openDatabase: async () => databases.left,
      clientId: 'reopened-page',
      leaseMs: 1_000,
      renewMs: 100,
      retryMs: 5,
    })
    await second.run(['message:M1'], async () => {})
    expect((await databases.left.browserLocks.get(BROWSER_WRITER_LOCK_NAME))?.fencingToken).toBe(2)
    second.dispose?.()
    await databases.close()
  })

  it('settles a waiting acquisition when its backend is disposed', async () => {
    const databases = await lockDatabases()
    const releaseOwner = deferred()
    const ownerEntered = deferred()
    const owner = createIndexedDbLockBackend({
      openDatabase: async () => databases.left,
      clientId: 'owner',
      leaseMs: 10_000,
      renewMs: 1_000,
      retryMs: 5,
    })
    const waiter = createIndexedDbLockBackend({
      openDatabase: async () => databases.right,
      clientId: 'waiter',
      leaseMs: 10_000,
      renewMs: 1_000,
      retryMs: 10_000,
    })
    const owned = owner.run(['message:M1'], async () => {
      ownerEntered.resolve()
      await releaseOwner.promise
    })
    await ownerEntered.promise
    const waiting = waiter.run(['message:M1'], async () => {})
    await new Promise((resolve) => setTimeout(resolve, 10))
    waiter.dispose?.()
    await expect(waiting).rejects.toThrow('LockBackendDisposed')
    releaseOwner.resolve()
    await owned
    owner.dispose?.()
    await databases.close()
  })

  it('settles same-backend FIFO waiters when an active callback outlives disposal', async () => {
    const databases = await lockDatabases()
    const ownerEntered = deferred()
    const releaseOwner = deferred()
    const backend = createIndexedDbLockBackend({
      openDatabase: async () => databases.left,
      clientId: 'same-page',
      leaseMs: 10_000,
      renewMs: 1_000,
      retryMs: 10_000,
    })
    const owner = backend.run(['message:M1'], async () => {
      ownerEntered.resolve()
      await releaseOwner.promise
    })
    await ownerEntered.promise
    const waiting = backend.run(['message:M2'], async () => {})
    backend.dispose?.()
    await expect(waiting).rejects.toThrow('LockBackendDisposed')
    releaseOwner.resolve()
    await owner
    await databases.close()
  })

  it('drains accepted fallback work through its physical callback finally', async () => {
    const databases = await lockDatabases()
    const entered = deferred()
    const release = deferred()
    const backend = createIndexedDbLockBackend({
      openDatabase: async () => databases.left,
      clientId: 'draining-page',
      leaseMs: 10_000,
      renewMs: 1_000,
      retryMs: 5,
    })
    const operation = backend.run(['message:M1'], async () => {
      entered.resolve()
      await release.promise
    })
    await entered.promise
    backend.dispose?.()
    let drained = false
    const drain = backend.awaitIdle?.().then(() => {
      drained = true
    })

    await Promise.resolve()
    expect(drained).toBe(false)
    await expect(backend.run(['message:M2'], async () => {})).rejects.toThrow('LockBackendDisposed')
    release.resolve()
    await operation
    await drain
    expect(drained).toBe(true)
    expect(
      (await databases.left.browserLocks.get(BROWSER_WRITER_LOCK_NAME))?.ownerClientId,
    ).toBeNull()
    await databases.close()
  })

  it('fails a grant transaction after its backend is disposed', async () => {
    const databases = await lockDatabases()
    const grantReady = deferred()
    const continueCallback = deferred()
    const backend = createIndexedDbLockBackend({
      openDatabase: async () => databases.left,
      clientId: 'disposed-owner',
      leaseMs: 10_000,
      renewMs: 1_000,
      retryMs: 5,
    })
    const operation = backend.run(['message:M1'], async (grant) => {
      grantReady.resolve()
      await continueCallback.promise
      await grant.runTransaction(databases.left, [databases.left.settings], async (tx) => {
        await tx.table('settings').put({ key: 'must-not-write', value: true })
      })
    })
    await grantReady.promise
    backend.dispose?.()
    continueCallback.resolve()
    await expect(operation).rejects.toThrow('LockBackendDisposed')
    expect(await databases.left.settings.get('must-not-write')).toBeUndefined()
    await databases.close()
  })

  it('fails closed before invoking a callback when IndexedDB cannot open', async () => {
    let called = false
    const backend = createIndexedDbLockBackend({
      openDatabase: async () => {
        throw new Error('database unavailable')
      },
    })
    await expect(
      backend.run(['message:M1'], async () => {
        called = true
      }),
    ).rejects.toThrow('database unavailable')
    expect(called).toBe(false)
    backend.dispose?.()
  })

  it('settles a hanging database opener and every FIFO waiter on disposal', async () => {
    const opening = deferred<Dexie>()
    const openerStarted = deferred()
    let callbackCalls = 0
    const backend = createIndexedDbLockBackend({
      openDatabase: () => {
        openerStarted.resolve()
        return opening.promise
      },
    })
    const first = backend.run(['message:M1'], async () => {
      callbackCalls += 1
    })
    await openerStarted.promise
    const second = backend.run(['message:M2'], async () => {
      callbackCalls += 1
    })

    backend.dispose?.()

    await expect(first).rejects.toThrow('LockBackendDisposed')
    await expect(second).rejects.toThrow('LockBackendDisposed')
    expect(callbackCalls).toBe(0)
    opening.reject(new Error('late open failure'))
    await Promise.resolve()
  })

  it('preserves the callback error when best-effort release fails', async () => {
    const databases = await lockDatabases()
    const backend = createIndexedDbLockBackend({
      openDatabase: async () => databases.left,
      clientId: 'closing-owner',
      leaseMs: 1_000,
      renewMs: 100,
      retryMs: 5,
    })
    await expect(
      backend.run(['message:M1'], async () => {
        databases.left.close()
        throw new Error('callback failure')
      }),
    ).rejects.toThrow('callback failure')
    backend.dispose?.()
    await databases.close()
  })

  it('allows a transaction that began under a valid fence to finish after wall-clock expiry', async () => {
    const databases = await lockDatabases()
    let now = 0
    const left = createIndexedDbLockBackend({
      openDatabase: async () => databases.left,
      clientId: 'left',
      now: () => now,
      leaseMs: 1_000,
      renewMs: 500,
      retryMs: 5,
    })
    await left.run(['message:M1'], (grant) =>
      grant.runTransaction(databases.left, [databases.left.settings], async (tx) => {
        const settings = tx.table('settings')
        await settings.put({ key: 'long-write-start', value: true })
        now = 1_001
        await settings.put({ key: 'long-write-finish', value: true })
      }),
    )
    expect((await databases.left.settings.get('long-write-start'))?.value).toBe(true)
    expect((await databases.left.settings.get('long-write-finish'))?.value).toBe(true)
    left.dispose?.()
    await databases.close()
  })

  it('cancels only a pending fallback replacement lock acquisition', async () => {
    const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks')
    Reflect.deleteProperty(navigator, 'locks')
    const databases = await lockDatabases()
    const releaseOwner = deferred()
    const ownerEntered = deferred()
    const owner = createIndexedDbLockBackend({
      openDatabase: async () => databases.left,
      clientId: 'replacement-blocker',
      leaseMs: 10_000,
      renewMs: 1_000,
      retryMs: 5,
    })
    const owned = owner.run(['db:global'], async () => {
      ownerEntered.resolve()
      await releaseOwner.promise
    })
    await ownerEntered.promise
    const controller = new AbortController()
    const reason = new Error('replacement-cancelled-while-pending')
    let called = false
    const waiting = withQuiescedWorkspaceReplacementLock(
      databases.right,
      async () => {
        called = true
      },
      { signal: controller.signal },
    )

    controller.abort(reason)
    await expect(waiting).rejects.toBe(reason)
    expect(called).toBe(false)

    releaseOwner.resolve()
    await owned
    owner.dispose?.()
    await databases.close()
    if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks)
  })

  it('does not interrupt a fallback replacement callback after lock entry', async () => {
    const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks')
    Reflect.deleteProperty(navigator, 'locks')
    const databases = await lockDatabases()
    const entered = deferred()
    const release = deferred()
    const controller = new AbortController()
    const reason = new Error('replacement-cancelled-after-entry')
    const operation = withQuiescedWorkspaceReplacementLock(
      databases.left,
      async () => {
        entered.resolve()
        await release.promise
        return 'committed'
      },
      { signal: controller.signal },
    )

    await entered.promise
    controller.abort(reason)
    release.resolve()
    await expect(operation).resolves.toBe('committed')

    await databases.close()
    if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks)
  })
})

class WorkspaceGateLockManager {
  private shared = 0
  private exclusive = false
  private readonly queue: Array<{
    mode: LockMode
    run: () => void
  }> = []

  request<T>(
    name: string,
    optionsOrCallback: LockOptions | ((lock: Lock | null) => T | PromiseLike<T>),
    maybeCallback?: (lock: Lock | null) => T | PromiseLike<T>,
  ): Promise<T> {
    const options = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback
    const callback =
      typeof optionsOrCallback === 'function'
        ? optionsOrCallback
        : (maybeCallback as NonNullable<typeof maybeCallback>)
    if (name !== 'workspace:authoritative') return Promise.resolve(callback(null))
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        mode: options.mode ?? 'exclusive',
        run: () => {
          const mode = options.mode ?? 'exclusive'
          if (mode === 'shared') this.shared += 1
          else this.exclusive = true
          void Promise.resolve(callback(null))
            .then(resolve, reject)
            .finally(() => {
              if (mode === 'shared') this.shared -= 1
              else this.exclusive = false
              this.drain()
            })
        },
      })
      this.drain()
    })
  }

  private drain(): void {
    if (this.exclusive || this.queue.length === 0) return
    const next = this.queue[0]
    if (!next) return
    if (next.mode === 'exclusive') {
      if (this.shared !== 0) return
      this.queue.shift()?.run()
      return
    }
    while (this.queue[0]?.mode === 'shared') this.queue.shift()?.run()
  }
}

describe('Web Locks workspace gate', () => {
  it('lets ordinary mutations share the gate and makes replacement exclusive', async () => {
    const original = Object.getOwnPropertyDescriptor(navigator, 'locks')
    const manager = new WorkspaceGateLockManager()
    Object.defineProperty(navigator, 'locks', { configurable: true, value: manager })
    __resetLockTrackerForTests({ admissionsOpen: true })
    const releaseOrdinary = deferred()
    const ordinaryEntered = deferred()
    const secondOrdinaryEntered = deferred()
    let replacementEntered = false
    const ordinary = withNamedLock('message:M1', async () => {
      ordinaryEntered.resolve()
      await releaseOrdinary.promise
    })
    await ordinaryEntered.promise
    const secondOrdinary = withNamedLock('message:M2', async () => {
      secondOrdinaryEntered.resolve()
    })
    await secondOrdinaryEntered.promise
    await secondOrdinary
    const replacement = withNamedLock('db:global', async () => {
      replacementEntered = true
    })
    await Promise.resolve()
    expect(replacementEntered).toBe(false)
    releaseOrdinary.resolve()
    await Promise.all([ordinary, replacement])
    expect(replacementEntered).toBe(true)
    if (original) Object.defineProperty(navigator, 'locks', original)
    else Reflect.deleteProperty(navigator, 'locks')
    __resetLockTrackerForTests({ admissionsOpen: true })
  })
})
