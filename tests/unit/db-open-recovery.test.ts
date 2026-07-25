import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWorkspaceOpenProgress } from '../../src/store/browser-workspace-open-contract'
import {
  __resetBrowserWorkspaceFatalInvalidationOwnerForTests,
  __resetDbForTests,
  claimBrowserWorkspaceFatalInvalidationOwner,
  closeInvalidatedBrowserWorkspaceSession,
  configureBrowserWorkspaceDatabaseName,
  getDb,
  invalidateBrowserWorkspaceSession,
  NatterDb,
  openDb,
  prepareBrowserWorkspaceSchema,
  recreateAndVerifyBrowserWorkspaceDatabase,
  releaseBrowserWorkspaceFatalInvalidationOwner,
  resumeBrowserWorkspaceSessionAdmissions,
} from '../../src/store/db'
import { installFreshFakeIndexedDbForTests } from '../helpers/fake-indexeddb'

beforeEach(() => {
  __resetBrowserWorkspaceFatalInvalidationOwnerForTests()
  __resetDbForTests({ admissionsOpen: true })
  installFreshFakeIndexedDbForTests()
})

afterEach(() => {
  vi.restoreAllMocks()
  __resetDbForTests({ admissionsOpen: true })
  __resetBrowserWorkspaceFatalInvalidationOwnerForTests()
})

describe('openDb recovery events', () => {
  it('keeps the exact fatal owner across ordinary database-session resets', () => {
    const owner = claimBrowserWorkspaceFatalInvalidationOwner(() => {})

    __resetDbForTests({ admissionsOpen: true })

    expect(() => claimBrowserWorkspaceFatalInvalidationOwner(() => {})).toThrow(
      'BrowserWorkspaceFatalInvalidationOwnerAlreadyInstalled',
    )
    releaseBrowserWorkspaceFatalInvalidationOwner(owner)
  })

  it('cannot construct a physical workspace session before explicit database selection', () => {
    __resetDbForTests({ databaseName: null, admissionsOpen: true })

    expect(() => getDb()).toThrow('BrowserWorkspaceDatabaseSelectionRequired')

    configureBrowserWorkspaceDatabaseName('natter-workspace-b')
    expect(getDb().name).toBe('natter-workspace-b')
  })

  it('forwards blocked version changes only for the active open attempt', async () => {
    const db = getDb()
    let rejectOpen!: (reason?: unknown) => void
    const pendingOpen = new Promise<never>((_resolve, reject) => {
      rejectOpen = reject
    })
    const openSpy = vi
      .spyOn(db, 'open')
      .mockReturnValue(pendingOpen as unknown as ReturnType<typeof db.open>)
    const onBlocked = vi.fn()
    const opening = openDb({ onBlocked })
    const event = { oldVersion: 220, newVersion: 230 } as IDBVersionChangeEvent

    db.on.blocked.fire(event)
    expect(onBlocked).toHaveBeenCalledWith(event)

    await vi.waitFor(() => expect(openSpy).toHaveBeenCalledTimes(1))
    rejectOpen(new Error('open failed'))
    await expect(opening).rejects.toThrow('open failed')
    db.on.blocked.fire(event)
    expect(onBlocked).toHaveBeenCalledTimes(1)
  })

  it('creates and physically verifies a fresh current workspace database', async () => {
    await recreateAndVerifyBrowserWorkspaceDatabase('fresh-workspace')

    const database = await openRawDatabase('fresh-workspace')
    expect(database.version).toBe(currentRawVersion())
    expect([...database.objectStoreNames]).toEqual(
      expect.arrayContaining([
        'chats',
        'messages',
        'messageBodies',
        'chatSidebarRows',
        'configurationLinks',
      ]),
    )
    database.close()
  })

  it('does not run or report compatibility work for a fresh or current workspace', async () => {
    const firstProgress = vi.fn<(progress: BrowserWorkspaceOpenProgress) => void>()
    await openDb({ onProgress: firstProgress })
    expect(
      firstProgress.mock.calls.some(([progress]) => progress.kind === 'database-upgrade'),
    ).toBe(false)

    const invalidated = invalidateBrowserWorkspaceSession()
    if (!invalidated) throw new Error('ExpectedInvalidatedBrowserWorkspaceSession')
    await closeInvalidatedBrowserWorkspaceSession(invalidated)
    resumeBrowserWorkspaceSessionAdmissions()

    const reopenedProgress = vi.fn<(progress: BrowserWorkspaceOpenProgress) => void>()
    await openDb({ onProgress: reopenedProgress })
    expect(
      reopenedProgress.mock.calls.some(([progress]) => progress.kind === 'database-upgrade'),
    ).toBe(false)
  })

  it('verifies the physical schema once per session instead of once per operation', async () => {
    const db = await openDb()
    const transactionSpy = vi.spyOn(db.backendDB(), 'transaction')

    await Promise.all(Array.from({ length: 64 }, () => openDb()))

    expect(transactionSpy).not.toHaveBeenCalled()
  })

  it('releases every legacy preflight connection only after its readonly transaction completes', async () => {
    const name = 'schema-preflight-transaction'
    await upgradeRawDatabase(name, 250, (database) => {
      database.createObjectStore('settings', { keyPath: 'key' })
    })

    const originalTransaction = IDBDatabase.prototype.transaction
    const originalClose = IDBDatabase.prototype.close
    const active = new WeakMap<IDBDatabase, Set<IDBTransaction>>()
    let metadataTransactions = 0
    let closedWithActiveMetadata = false
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (
      this: IDBDatabase,
      storeNames,
      mode,
      options,
    ) {
      const transaction = originalTransaction.call(this, storeNames, mode, options)
      const names = typeof storeNames === 'string' ? [storeNames] : Array.from(storeNames)
      if (this.name === name && mode === 'readonly' && names.length > 0) {
        metadataTransactions += 1
        const transactions = active.get(this) ?? new Set<IDBTransaction>()
        transactions.add(transaction)
        active.set(this, transactions)
        const release = () => transactions.delete(transaction)
        transaction.addEventListener('complete', release, { once: true })
        transaction.addEventListener('abort', release, { once: true })
      }
      return transaction
    })
    vi.spyOn(IDBDatabase.prototype, 'close').mockImplementation(function (this: IDBDatabase) {
      if ((active.get(this)?.size ?? 0) > 0) closedWithActiveMetadata = true
      originalClose.call(this)
    })

    const candidate = new NatterDb(name)
    try {
      await prepareBrowserWorkspaceSchema(candidate)
      expect(metadataTransactions).toBe(2)
      expect(closedWithActiveMetadata).toBe(false)
    } finally {
      candidate.close()
      await Dexie.delete(name)
    }
  })

  it('does not inherit the verification cache across a replacement physical session', async () => {
    await openDb()
    const invalidated = invalidateBrowserWorkspaceSession()
    if (!invalidated) throw new Error('ExpectedInvalidatedBrowserWorkspaceSession')
    await closeInvalidatedBrowserWorkspaceSession(invalidated)
    resumeBrowserWorkspaceSessionAdmissions()

    const transactionSpy = vi.spyOn(IDBDatabase.prototype, 'transaction')
    const objectStoreSpy = vi.spyOn(IDBTransaction.prototype, 'objectStore')
    const replacement = await openDb()
    const schemaVerificationTransactions = transactionSpy.mock.results.filter((result) => {
      const transaction: unknown = result.value
      return (
        transaction instanceof IDBTransaction &&
        objectStoreSpy.mock.contexts.filter((context) => context === transaction).length ===
          replacement.tables.length
      )
    })

    expect(schemaVerificationTransactions.length).toBeGreaterThan(0)
    const initialVerificationTransactionCount = schemaVerificationTransactions.length
    await Promise.all(Array.from({ length: 64 }, () => openDb()))
    expect(
      transactionSpy.mock.results.filter((result) => {
        const transaction: unknown = result.value
        return (
          transaction instanceof IDBTransaction &&
          objectStoreSpy.mock.contexts.filter((context) => context === transaction).length ===
            replacement.tables.length
        )
      }),
    ).toHaveLength(initialVerificationTransactionCount)
  })

  it('repairs missing derived stores before runtime and preserves canonical rows', async () => {
    const db = await openDb()
    await db.settings.put({ key: 'canonical-proof', value: 'preserved' })
    const damagedVersion = currentRawVersion() + 1
    __resetDbForTests({ admissionsOpen: true })
    await upgradeRawDatabase('natter', damagedVersion, (database) => {
      database.deleteObjectStore('attachmentCatalogRows')
    })

    const repaired = await openDb()

    expect(repaired.backendDB().objectStoreNames.contains('attachmentCatalogRows')).toBe(true)
    expect((await repaired.settings.get('canonical-proof'))?.value).toBe('preserved')
    expect(Math.round(repaired.verno * 10)).toBe(damagedVersion + 1)
  })

  it('repairs drifted derived indexes at a monotonic physical version', async () => {
    await openDb()
    const damagedVersion = currentRawVersion() + 1
    __resetDbForTests({ admissionsOpen: true })
    await upgradeRawDatabase('natter', damagedVersion, (_database, transaction) => {
      transaction.objectStore('attachmentCatalogRows').deleteIndex('refCount')
    })

    const repaired = await openDb()

    expect(repaired.attachmentCatalogRows.schema.indexes.map((index) => index.src)).toContain(
      'refCount',
    )
    expect(Math.round(repaired.verno * 10)).toBe(damagedVersion + 1)
  })

  it('converges concurrent tab opens on one monotonic repair version', async () => {
    const name = 'concurrent-derived-repair'
    const seed = new NatterDb(name)
    await seed.open()
    await seed.settings.put({ key: 'canonical-proof', value: 'both-tabs' })
    const damagedVersion = Math.round(seed.verno * 10) + 1
    seed.close()
    await upgradeRawDatabase(name, damagedVersion, (database) => {
      database.deleteObjectStore('attachmentCatalogRows')
    })
    const tabA = new NatterDb(name)
    const tabB = new NatterDb(name)

    await Promise.all([prepareBrowserWorkspaceSchema(tabA), prepareBrowserWorkspaceSchema(tabB)])
    await Promise.all([tabA.open(), tabB.open()])

    expect(Math.round(tabA.verno * 10)).toBe(damagedVersion + 1)
    expect(Math.round(tabB.verno * 10)).toBe(damagedVersion + 1)
    expect((await tabA.settings.get('canonical-proof'))?.value).toBe('both-tabs')
    expect((await tabB.settings.get('canonical-proof'))?.value).toBe('both-tabs')
    tabA.close()
    tabB.close()
    await Dexie.delete(name)
  })

  it('drops only explicitly retired stores during automatic schema repair', async () => {
    await openDb()
    const damagedVersion = currentRawVersion() + 1
    __resetDbForTests({ admissionsOpen: true })
    await upgradeRawDatabase('natter', damagedVersion, (database) => {
      database.createObjectStore('chatBranchCache', { keyPath: 'chatId' })
    })

    const repaired = await openDb()

    expect(repaired.backendDB().objectStoreNames.contains('chatBranchCache')).toBe(false)
  })

  it('fails safely when a canonical store is missing', async () => {
    await openDb()
    const damagedVersion = currentRawVersion() + 1
    __resetDbForTests({ admissionsOpen: true })
    await upgradeRawDatabase('natter', damagedVersion, (database) => {
      database.deleteObjectStore('messages')
    })

    await expect(openDb()).rejects.toThrow(
      'BrowserWorkspaceSchemaIntegrity:canonical-stores-missing:messages',
    )
  })

  it('fails safely without deleting an unclassified extra store', async () => {
    await openDb()
    const damagedVersion = currentRawVersion() + 1
    __resetDbForTests({ admissionsOpen: true })
    await upgradeRawDatabase('natter', damagedVersion, (database) => {
      database.createObjectStore('unknownUserRows', { keyPath: 'id' })
    })

    await expect(openDb()).rejects.toThrow(
      'BrowserWorkspaceSchemaIntegrity:unexpected-stores:unknownUserRows',
    )
    __resetDbForTests({ admissionsOpen: true })
    const physical = await openRawDatabase('natter')
    expect(physical.objectStoreNames.contains('unknownUserRows')).toBe(true)
    physical.close()
  })

  it('reports an external version change once for the exact current session', async () => {
    const fatal = vi.fn()
    claimBrowserWorkspaceFatalInvalidationOwner(fatal)
    await openDb()

    const oldVersion = currentRawVersion()
    const newVersion = oldVersion + 1
    const upgraded = openRawDatabase('natter', newVersion)
    await vi.waitFor(() =>
      expect(fatal).toHaveBeenCalledWith(
        expect.objectContaining({
          databaseName: 'natter',
          kind: 'unexpected-versionchange',
          oldVersion,
          newVersion,
        }),
      ),
    )
    ;(await upgraded).close()
    expect(fatal).toHaveBeenCalledTimes(1)
  })

  it('delivers fatal invalidation only to the exact owner captured by the session', async () => {
    const fatalA = vi.fn()
    const ownerA = claimBrowserWorkspaceFatalInvalidationOwner(fatalA)
    expect(() => claimBrowserWorkspaceFatalInvalidationOwner(vi.fn())).toThrow(
      'BrowserWorkspaceFatalInvalidationOwnerAlreadyInstalled',
    )
    releaseBrowserWorkspaceFatalInvalidationOwner(ownerA)

    const fatalB = vi.fn()
    const ownerB = claimBrowserWorkspaceFatalInvalidationOwner(fatalB)
    releaseBrowserWorkspaceFatalInvalidationOwner(ownerA)
    await openDb()

    const oldVersion = currentRawVersion()
    const newVersion = oldVersion + 1
    const upgraded = openRawDatabase('natter', newVersion)
    await vi.waitFor(() => expect(fatalB).toHaveBeenCalledTimes(1))
    ;(await upgraded).close()

    expect(fatalA).not.toHaveBeenCalled()
    releaseBrowserWorkspaceFatalInvalidationOwner(ownerB)
  })

  it('ignores the expected close of an explicitly invalidated session', async () => {
    const fatal = vi.fn()
    claimBrowserWorkspaceFatalInvalidationOwner(fatal)
    await openDb()

    const invalidated = invalidateBrowserWorkspaceSession()
    expect(invalidated).not.toBeNull()
    if (invalidated) await closeInvalidatedBrowserWorkspaceSession(invalidated)
    await Promise.resolve()

    expect(fatal).not.toHaveBeenCalled()
  })
})

function openRawDatabase(name: string, version?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = version === undefined ? indexedDB.open(name) : indexedDB.open(name, version)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function upgradeRawDatabase(
  name: string,
  version: number,
  upgrade: (database: IDBDatabase, transaction: IDBTransaction) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version)
    request.onupgradeneeded = () => {
      const transaction = request.transaction
      if (!transaction) {
        reject(new Error('raw upgrade transaction missing'))
        return
      }
      upgrade(request.result, transaction)
    }
    request.onsuccess = () => {
      request.result.close()
      resolve()
    }
    request.onerror = () => reject(request.error)
  })
}

function currentRawVersion(): number {
  return Math.round(getDb().verno * 10)
}
