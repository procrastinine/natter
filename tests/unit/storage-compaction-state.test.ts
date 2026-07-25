import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BROWSER_WORKSPACE_CONTROL_DATABASE_NAME } from '../../src/lib/origin-storage-names'
import { runBrowserCommandTransaction } from '../../src/store/browser-command-mutation-journal'
import {
  applyUnslottedBrowserWorkspaceReplacementStorageBaseline,
  claimBrowserWorkspaceCompactionAttempt,
  deleteBrowserWorkspaceCompactionState,
  migrateBrowserWorkspaceCompactionState,
  recordBrowserWorkspaceCompactionDebt,
} from '../../src/store/browser-workspace-database-control'
import {
  addPhysicalStorageRow,
  deletePhysicalStorageCollection,
  putPhysicalStorageRow,
} from '../../src/store/byte-owner-mutation'
import { createDbForTests, type NatterDb } from '../../src/store/db'
import { resumeLockRuntime } from '../../src/store/locks'
import type { MessageBodyRow } from '../../src/store/message-storage'
import {
  __resetStorageCompactionStateForTests,
  assertStorageCompactionDebtRuntimeClosed,
  awaitStorageCompactionDebtIdle,
  awaitStorageCompactionIntentOwnerIdle,
  closeStorageCompactionDebtRuntime,
  finishStorageCompactionDebtRuntimeClosure,
  publishStorageCompactionRequest,
  readStorageCompactionState,
  recoverStorageCompactionDebtIntents,
  STORAGE_COMPACTION_MIN_RECLAIMABLE_BYTES,
  startStorageCompactionIntentOwner,
  stopStorageCompactionIntentOwner,
  storageCompactionDebtThreshold,
  storageCompactionRecoveryIntentKey,
  subscribeStorageCompactionRequests,
} from '../../src/store/storage-compaction-state'
import { estimateStoredValueBytes } from '../../src/store/storage-size-estimate'
import { resumeLocalTransactionAdmissions } from '../../src/store/transaction-activity'

let db: NatterDb | null = null

class TestStorage implements Storage {
  private readonly values = new Map<string, string>()

  get length(): number {
    return this.values.size
  }

  clear(): void {
    this.values.clear()
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

async function overwriteStoredCompactionState(value: Record<string, unknown>): Promise<void> {
  const controlDb = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(BROWSER_WORKSPACE_CONTROL_DATABASE_NAME)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)
  })
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = controlDb.transaction('compactionStates', 'readwrite')
      transaction.onabort = () => reject(transaction.error)
      transaction.onerror = () => reject(transaction.error)
      transaction.oncomplete = () => resolve()
      transaction.objectStore('compactionStates').put(value)
    })
  } finally {
    controlDb.close()
  }
}

beforeEach(async () => {
  vi.stubGlobal('localStorage', new TestStorage())
  localStorage.clear()
  resumeLockRuntime()
  resumeLocalTransactionAdmissions()
  await __resetStorageCompactionStateForTests()
})

afterEach(async () => {
  vi.restoreAllMocks()
  await __resetStorageCompactionStateForTests()
  localStorage.clear()
  vi.unstubAllGlobals()
  const current = db
  db = null
  if (!current) return
  const name = current.name
  current.close()
  await deleteBrowserWorkspaceCompactionState(name)
  await Dexie.delete(name)
})

describe('storage compaction state', () => {
  it('caps small-workspace deferred garbage at 64 MiB', () => {
    expect(STORAGE_COMPACTION_MIN_RECLAIMABLE_BYTES).toBe(64 * 1024 * 1024)
  })

  it('seeds a fresh workspace without requesting a physical copy', async () => {
    db = createDbForTests(`natter-compaction-fresh-${crypto.randomUUID()}`)
    await db.open()

    await expect(readStorageCompactionState(db)).resolves.toEqual({
      databaseName: db.name,
      formatVersion: 2,
      knownReclaimableBytes: 0,
      lastCompactedLiveBytes: 0,
      requestRevision: 0,
      attemptedRevision: 0,
      completedRevision: 0,
    })
  })

  it('derives the last attempted revision from a legacy completed revision', async () => {
    db = createDbForTests(`natter-compaction-migrate-${crypto.randomUUID()}`)
    await db.open()

    await expect(
      migrateBrowserWorkspaceCompactionState(db.name, {
        knownReclaimableBytes: 11,
        lastCompactedLiveBytes: 22,
        requestRevision: 4,
        completedRevision: 2,
      }),
    ).resolves.toEqual({
      databaseName: db.name,
      formatVersion: 2,
      knownReclaimableBytes: 11,
      lastCompactedLiveBytes: 22,
      requestRevision: 4,
      attemptedRevision: 2,
      completedRevision: 2,
    })
  })

  it('recovers invalid revision orderings to one conservative current request', async () => {
    db = createDbForTests(`natter-compaction-invalid-${crypto.randomUUID()}`)
    await db.open()
    await readStorageCompactionState(db)
    const conservative = {
      databaseName: db.name,
      formatVersion: 2,
      knownReclaimableBytes: STORAGE_COMPACTION_MIN_RECLAIMABLE_BYTES,
      lastCompactedLiveBytes: 0,
      requestRevision: 1,
      attemptedRevision: 0,
      completedRevision: 0,
    }

    for (const revisions of [
      { requestRevision: 2, attemptedRevision: 1, completedRevision: 2 },
      { requestRevision: 2, attemptedRevision: 3, completedRevision: 1 },
    ]) {
      await overwriteStoredCompactionState({
        databaseName: db.name,
        formatVersion: 2,
        knownReclaimableBytes: 7,
        lastCompactedLiveBytes: 9,
        ...revisions,
      })
      await expect(readStorageCompactionState(db)).resolves.toEqual(conservative)
      await expect(readStorageCompactionState(db)).resolves.toEqual(conservative)
    }
  })

  it('durably requests once per exact threshold crossing without scanning workspace rows', async () => {
    db = createDbForTests(`natter-compaction-threshold-${crypto.randomUUID()}`)
    await db.open()
    const threshold = STORAGE_COMPACTION_MIN_RECLAIMABLE_BYTES

    const before = await recordBrowserWorkspaceCompactionDebt(db.name, threshold - 1)
    const crossing = await recordBrowserWorkspaceCompactionDebt(db.name, 1)
    const withinBucket = await recordBrowserWorkspaceCompactionDebt(db.name, threshold - 1)
    const secondCrossing = await recordBrowserWorkspaceCompactionDebt(db.name, 1)

    expect(before).toMatchObject({ requested: false, state: { requestRevision: 0 } })
    expect(crossing).toMatchObject({ requested: true, state: { requestRevision: 1 } })
    expect(withinBucket).toMatchObject({ requested: false, state: { requestRevision: 1 } })
    expect(secondCrossing).toMatchObject({ requested: true, state: { requestRevision: 2 } })
  })

  it('atomically requeues only the exact uncommitted attempt without new debt', async () => {
    db = createDbForTests(`natter-compaction-release-${crypto.randomUUID()}`)
    await db.open()
    await recordBrowserWorkspaceCompactionDebt(db.name, STORAGE_COMPACTION_MIN_RECLAIMABLE_BYTES)
    const first = await claimBrowserWorkspaceCompactionAttempt(db.name)
    if (first.kind !== 'claimed') throw new Error('Expected first compaction claim')

    const released = await first.claim.release()
    expect(released).toMatchObject({
      released: true,
      state: { requestRevision: 2, attemptedRevision: 0, completedRevision: 0 },
    })
    const retry = await claimBrowserWorkspaceCompactionAttempt(db.name)
    if (retry.kind !== 'claimed') throw new Error('Expected retry compaction claim')
    expect(retry.claim.revision).toBe(2)
    await applyUnslottedBrowserWorkspaceReplacementStorageBaseline(db.name, {
      kind: 'carry-source',
      liveBytes: 0,
    })

    await expect(retry.claim.release()).resolves.toMatchObject({
      released: false,
      state: { requestRevision: 2, attemptedRevision: 2, completedRevision: 2 },
    })
    await first.claim.release()
    await expect(readStorageCompactionState(db)).resolves.toMatchObject({
      requestRevision: 2,
      attemptedRevision: 2,
      completedRevision: 2,
    })
  })

  it('publishes one synchronous compaction wake to each current subscriber', () => {
    const first = vi.fn()
    const second = vi.fn()
    const unsubscribeFirst = subscribeStorageCompactionRequests(first)
    const unsubscribeSecond = subscribeStorageCompactionRequests(second)

    publishStorageCompactionRequest()
    expect(first).toHaveBeenCalledOnce()
    expect(second).toHaveBeenCalledOnce()
    unsubscribeFirst()
    publishStorageCompactionRequest()
    expect(first).toHaveBeenCalledOnce()
    expect(second).toHaveBeenCalledTimes(2)
    unsubscribeSecond()
  })

  it('resets after a copy and scales future churn to half of measured live bytes', async () => {
    db = createDbForTests(`natter-compaction-reset-${crypto.randomUUID()}`)
    await db.open()
    const liveBytes = 8 * STORAGE_COMPACTION_MIN_RECLAIMABLE_BYTES

    await migrateBrowserWorkspaceCompactionState(db.name, {
      knownReclaimableBytes: 0,
      lastCompactedLiveBytes: liveBytes,
      requestRevision: 0,
      completedRevision: 0,
    })
    expect(storageCompactionDebtThreshold(liveBytes)).toBe(liveBytes / 2)
    const before = await recordBrowserWorkspaceCompactionDebt(db.name, liveBytes / 2 - 1)
    const crossing = await recordBrowserWorkspaceCompactionDebt(db.name, 1)

    expect(before.requested).toBe(false)
    expect(crossing).toMatchObject({
      requested: true,
      state: {
        knownReclaimableBytes: liveBytes / 2,
        lastCompactedLiveBytes: liveBytes,
        requestRevision: 1,
      },
    })
  })

  it('coalesces every replaced value in one transaction into one post-commit debt write', async () => {
    db = createDbForTests(`natter-compaction-ledger-${crypto.randomUUID()}`)
    await db.open()
    const first = { chatId: 'chat-first', text: 'old first', attachmentRefs: [], updatedAt: 1 }
    const second = { chatId: 'chat-second', text: 'old second', attachmentRefs: [], updatedAt: 1 }
    await db.drafts.bulkAdd([first, second])
    const transaction = IDBDatabase.prototype.transaction
    const debtTransactions: string[] = []
    const transactionSpy = vi
      .spyOn(IDBDatabase.prototype, 'transaction')
      .mockImplementation(function (this: IDBDatabase, storeNames, ...args) {
        const names = typeof storeNames === 'string' ? [storeNames] : [...storeNames]
        if (
          this.name === 'natter-control' &&
          names.includes('compactionStates') &&
          args[0] === 'readwrite'
        ) {
          debtTransactions.push(this.name)
        }
        return transaction.call(this, storeNames, ...args)
      })
    const setItem = vi.spyOn(localStorage, 'setItem')
    const removeItem = vi.spyOn(localStorage, 'removeItem')

    await db.transaction('rw', db.drafts, async (tx) => {
      await putPhysicalStorageRow(
        tx,
        'drafts',
        { ...first, text: 'next first', updatedAt: 2 },
        first,
      )
      await putPhysicalStorageRow(
        tx,
        'drafts',
        { ...second, text: 'next second', updatedAt: 2 },
        second,
      )
    })
    await awaitStorageCompactionDebtIdle()

    expect(debtTransactions).toHaveLength(1)
    transactionSpy.mockRestore()
    expect(await readStorageCompactionState(db)).toMatchObject({
      knownReclaimableBytes: estimateStoredValueBytes(first) + estimateStoredValueBytes(second),
    })
    expect(
      setItem.mock.calls.filter(([key]) =>
        String(key).startsWith('natter:storage-compaction-intent:v1:'),
      ),
    ).toHaveLength(1)
    expect(
      removeItem.mock.calls.filter(([key]) =>
        String(key).startsWith('natter:storage-compaction-intent:v1:'),
      ),
    ).toHaveLength(1)
  })

  it('closes failed debt ownership without retaining a stale database session', async () => {
    const name = `natter-compaction-reopen-${crypto.randomUUID()}`
    db = createDbForTests(name)
    await db.open()
    const previous = { chatId: 'reopen', text: 'old', attachmentRefs: [], updatedAt: 1 }
    await db.drafts.add(previous)
    const put = IDBObjectStore.prototype.put
    const failDebtWrite = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      value,
      key,
    ) {
      if (this.name === 'compactionStates') throw new Error('debt-write-failed')
      return key === undefined ? put.call(this, value) : put.call(this, value, key)
    })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    await db.transaction('rw', db.drafts, (tx) =>
      putPhysicalStorageRow(
        tx,
        'drafts',
        { ...previous, text: 'committed', updatedAt: 2 },
        previous,
      ),
    )
    closeStorageCompactionDebtRuntime()
    await awaitStorageCompactionDebtIdle()
    expect(consoleError).toHaveBeenCalled()

    expect(() => assertStorageCompactionDebtRuntimeClosed()).toThrow(
      'StorageCompactionDebtRuntimeNotClosed',
    )
    finishStorageCompactionDebtRuntimeClosure()
    expect(() => assertStorageCompactionDebtRuntimeClosed()).not.toThrow()
    expect(
      Array.from({ length: localStorage.length }, (_value, index) =>
        localStorage.key(index),
      ).filter((key) => key?.startsWith('natter:storage-compaction-intent:v1:')),
    ).toHaveLength(1)

    failDebtWrite.mockRestore()
    consoleError.mockRestore()
    db.close()
    db = createDbForTests(name)
    await db.open()
    await expect(
      recoverStorageCompactionDebtIntents(db, { isOwnerLive: async () => false }),
    ).resolves.toBe(true)
    expect(await readStorageCompactionState(db)).toMatchObject({
      knownReclaimableBytes: STORAGE_COMPACTION_MIN_RECLAIMABLE_BYTES,
      requestRevision: 1,
    })

    const committed = { ...previous, text: 'committed', updatedAt: 2 }
    await db.transaction('rw', db.drafts, (tx) =>
      putPhysicalStorageRow(
        tx,
        'drafts',
        { ...committed, text: 'committed again', updatedAt: 3 },
        committed,
      ),
    )
    await awaitStorageCompactionDebtIdle()
    expect((await readStorageCompactionState(db)).knownReclaimableBytes).toBeGreaterThan(
      STORAGE_COMPACTION_MIN_RECLAIMABLE_BYTES,
    )
  })

  it('does not create debt or a recovery marker for append-only physical rows', async () => {
    db = createDbForTests(`natter-compaction-append-${crypto.randomUUID()}`)
    await db.open()
    const setItem = vi.spyOn(localStorage, 'setItem')

    await db.transaction('rw', db.drafts, (tx) =>
      addPhysicalStorageRow(tx, 'drafts', {
        chatId: 'append-only',
        text: 'new',
        attachmentRefs: [],
        updatedAt: 1,
      }),
    )
    await awaitStorageCompactionDebtIdle()

    expect(await readStorageCompactionState(db)).toMatchObject({ knownReclaimableBytes: 0 })
    expect(
      setItem.mock.calls.some(([key]) =>
        String(key).startsWith('natter:storage-compaction-intent:v1:'),
      ),
    ).toBe(false)
  })

  it('derives exact deletion facts and byte debt from one collection traversal', async () => {
    db = createDbForTests(`natter-compaction-delete-${crypto.randomUUID()}`)
    await db.open()
    const rows: MessageBodyRow[] = [
      {
        id: 'message-a',
        chatId: 'chat-a',
        bodyVersion: 1,
        updatedAt: 1,
        content: [{ type: 'text', text: 'first cold body' }],
      },
      {
        id: 'message-b',
        chatId: 'chat-a',
        bodyVersion: 1,
        updatedAt: 1,
        content: [{ type: 'text', text: 'second cold body' }],
      },
    ]
    const survivor: MessageBodyRow = {
      id: 'message-c',
      chatId: 'chat-b',
      bodyVersion: 1,
      updatedAt: 1,
      content: [{ type: 'text', text: 'unrelated cold body' }],
    }
    await db.messageBodies.bulkAdd([...rows, survivor])

    const result = await db.transaction('rw', db.messageBodies, (tx) =>
      runBrowserCommandTransaction(tx, async () => {
        const collection = tx
          .table<MessageBodyRow, string>('messageBodies')
          .where('chatId')
          .equals('chat-a')
        const each = vi.spyOn(collection, 'each')
        const toArray = vi.spyOn(collection, 'toArray')
        const primaryKeys = vi.spyOn(collection, 'primaryKeys')
        const deleted = await deletePhysicalStorageCollection(tx, 'messageBodies', collection)
        expect(each).toHaveBeenCalledTimes(1)
        expect(toArray).not.toHaveBeenCalled()
        expect(primaryKeys).not.toHaveBeenCalled()
        return deleted
      }),
    )
    await awaitStorageCompactionDebtIdle()

    expect(result.value).toBe(2)
    expect(result.facts.physicalMutations).toEqual(
      rows.map((row) => ({
        tableName: 'messageBodies',
        address: `messageBodies\0s:${row.id.length}:${row.id}`,
        operation: 'delete',
        key: row.id,
        rowId: row.id,
        chatId: row.chatId,
        messageId: row.id,
      })),
    )
    expect(await db.messageBodies.where('chatId').equals('chat-a').count()).toBe(0)
    expect(await db.messageBodies.get(survivor.id)).toEqual(survivor)
    expect(await readStorageCompactionState(db)).toEqual({
      databaseName: db.name,
      formatVersion: 2,
      knownReclaimableBytes: rows.reduce((total, row) => total + estimateStoredValueBytes(row), 0),
      lastCompactedLiveBytes: 0,
      requestRevision: 0,
      attemptedRevision: 0,
      completedRevision: 0,
    })
  })

  it('clears the sole recovery marker when its semantic transaction aborts', async () => {
    db = createDbForTests(`natter-compaction-abort-${crypto.randomUUID()}`)
    await db.open()
    const previous = { chatId: 'aborted', text: 'old', attachmentRefs: [], updatedAt: 1 }
    await db.drafts.add(previous)

    await expect(
      db.transaction('rw', db.drafts, async (tx) => {
        await putPhysicalStorageRow(tx, 'drafts', { ...previous, text: 'not committed' }, previous)
        throw new Error('abort transaction')
      }),
    ).rejects.toThrow('abort transaction')
    await new Promise<void>((resolve) => queueMicrotask(resolve))

    expect(
      Object.keys(localStorage).filter((key) =>
        key.startsWith('natter:storage-compaction-intent:v1:'),
      ),
    ).toEqual([])
    expect(await readStorageCompactionState(db)).toMatchObject({ knownReclaimableBytes: 0 })
  })

  it('forces one compaction request for a stale crash marker on a large workspace', async () => {
    db = createDbForTests(`natter-compaction-recovery-${crypto.randomUUID()}`)
    await db.open()
    const liveBytes = 600 * 1024 * 1024
    await migrateBrowserWorkspaceCompactionState(db.name, {
      knownReclaimableBytes: 0,
      lastCompactedLiveBytes: liveBytes,
      requestRevision: 0,
      completedRevision: 0,
    })
    const key = storageCompactionRecoveryIntentKey('crashed-tab')
    localStorage.setItem(key, 'crashed-intent')

    await expect(
      recoverStorageCompactionDebtIntents(db, { isOwnerLive: async () => false }),
    ).resolves.toBe(true)
    expect(await readStorageCompactionState(db)).toEqual({
      databaseName: db.name,
      formatVersion: 2,
      knownReclaimableBytes: liveBytes / 2,
      lastCompactedLiveBytes: liveBytes,
      requestRevision: 1,
      attemptedRevision: 0,
      completedRevision: 0,
    })
    expect(localStorage.getItem(key)).toBeNull()
    await expect(
      recoverStorageCompactionDebtIntents(db, { isOwnerLive: async () => false }),
    ).resolves.toBe(false)
  })

  it('leaves a live tab marker untouched and never guesses debt for it', async () => {
    db = createDbForTests(`natter-compaction-live-owner-${crypto.randomUUID()}`)
    await db.open()
    const key = storageCompactionRecoveryIntentKey('live-tab')
    localStorage.setItem(key, 'live-intent')

    await expect(
      recoverStorageCompactionDebtIntents(db, { isOwnerLive: async () => true }),
    ).resolves.toBe(false)

    expect(localStorage.getItem(key)).toBe('live-intent')
    expect(await readStorageCompactionState(db)).toMatchObject({
      knownReclaimableBytes: 0,
      requestRevision: 0,
    })
  })

  it('commits recovered uncertainty before conditionally clearing the observed marker', async () => {
    db = createDbForTests(`natter-compaction-recovery-race-${crypto.randomUUID()}`)
    await db.open()
    const key = storageCompactionRecoveryIntentKey('restarted-tab')
    localStorage.setItem(key, 'stale-intent')
    const put = IDBObjectStore.prototype.put
    const replaceMarker = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      value,
      primaryKey,
    ) {
      if (this.name === 'compactionStates') localStorage.setItem(key, 'new-live-intent')
      return primaryKey === undefined ? put.call(this, value) : put.call(this, value, primaryKey)
    })

    await recoverStorageCompactionDebtIntents(db, { isOwnerLive: async () => false })

    replaceMarker.mockRestore()
    expect(await readStorageCompactionState(db)).toMatchObject({ requestRevision: 1 })
    expect(localStorage.getItem(key)).toBe('new-live-intent')
  })

  it('holds one tab-liveness lock for the owner lifetime and releases it on close', async () => {
    db = createDbForTests(`natter-compaction-owner-${crypto.randomUUID()}`)
    await db.open()

    await startStorageCompactionIntentOwner(db)
    expect(
      await db.browserLocks
        .filter((row) => row.name.includes('storage-compaction-intent-owner:v1:'))
        .count(),
    ).toBe(1)

    stopStorageCompactionIntentOwner()
    await awaitStorageCompactionIntentOwnerIdle()
    expect(
      await db.browserLocks
        .filter((row) => row.name.includes('storage-compaction-intent-owner:v1:'))
        .count(),
    ).toBe(0)
  })
})
