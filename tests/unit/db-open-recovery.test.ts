import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createChatRow } from '../../src/core/chat-metadata'
import { readBrowserWorkspaceDatabaseManifest } from '../../src/store/browser-workspace-database-control'
import type { BrowserWorkspaceOpenProgress } from '../../src/store/browser-workspace-open-contract'
import { WAVE_A_V94_STORES } from '../../src/store/browser-workspace-schema-v94'
import {
  BROWSER_WORKSPACE_CURRENT_COMPLETION_KEY,
  isBrowserWorkspaceCurrentCompletionValueV97,
  WAVE_B_V97_STORES,
} from '../../src/store/browser-workspace-schema-v97'
import {
  __resetBrowserWorkspaceSlotCoordinatorForTests,
  disposeBrowserWorkspaceSlotCoordinator,
  installBrowserWorkspaceSlotCoordinator,
} from '../../src/store/browser-workspace-slot-coordination'
import { ensureBrowserWorkspaceCurrentForSelection } from '../../src/store/browser-workspace-startup-repair'
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

const originalBroadcastChannel = globalThis.BroadcastChannel
const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks')

class ImmediateLockManager {
  request<T>(
    name: string,
    options: { mode: 'shared' | 'exclusive'; ifAvailable?: boolean; signal?: AbortSignal },
    callback: (lock: Lock) => Promise<T> | T,
  ): Promise<T> {
    return Promise.resolve(callback({ name, mode: options.mode }))
  }
}

class SilentBroadcastChannel extends EventTarget {
  readonly name: string

  constructor(name: string) {
    super()
    this.name = name
  }

  close(): void {}

  postMessage(): void {}
}

beforeEach(() => {
  __resetBrowserWorkspaceFatalInvalidationOwnerForTests()
  __resetDbForTests({ admissionsOpen: true })
  installFreshFakeIndexedDbForTests()
})

afterEach(() => {
  __resetBrowserWorkspaceSlotCoordinatorForTests()
  Object.defineProperty(globalThis, 'BroadcastChannel', {
    configurable: true,
    value: originalBroadcastChannel,
  })
  if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks)
  else Reflect.deleteProperty(navigator, 'locks')
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
      expect(metadataTransactions).toBe(3)
      expect(closedWithActiveMetadata).toBe(false)
    } finally {
      candidate.close()
      await Dexie.delete(name)
    }
  })

  it('uses the selected completion proof without a full-schema transaction after session reopen', async () => {
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

    expect(schemaVerificationTransactions).toHaveLength(0)
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
    ).toHaveLength(0)
  })

  it('normalizes observed v95.8 rows on an inactive destination and deletes only the old slot', async () => {
    const legacy = new Dexie('natter')
    legacy.version(95.8).stores(WAVE_A_V94_STORES)
    await legacy.open()
    await legacy.table('settings').bulkPut([
      { key: 'canonical-proof', value: 'preserved' },
      { key: 'global:auto-scroll', value: true },
      {
        key: 'workspace-meta',
        value: { workspaceId: 'inactive-repair-workspace', replacementEpoch: 4 },
      },
      ...Array.from({ length: 130 }, (_, index) => ({
        key: `page-proof:${index.toString().padStart(3, '0')}`,
        value: index,
      })),
      { key: 'page-proof:oversized', value: 'x'.repeat(1024 * 1024 + 1) },
    ])
    legacy.close()

    const progress: BrowserWorkspaceOpenProgress[] = []
    const proof = await runStartupRepair((event) => progress.push(event))
    expect(proof).toMatchObject({
      databaseName: 'natter-workspace-a',
      activationSequence: 1,
      physicalVersion: 970,
    })
    expect(await readBrowserWorkspaceDatabaseManifest()).toEqual({
      id: 'workspace',
      activeDatabaseName: 'natter-workspace-a',
      activationSequence: 1,
    })
    const repaired = new NatterDb(proof.databaseName)
    await repaired.open()
    expect((await repaired.settings.get('canonical-proof'))?.value).toBe('preserved')
    expect(await repaired.settings.get('global:auto-scroll')).toBeUndefined()
    expect((await repaired.settings.get('global:auto-scroll-stream'))?.value).toBe(true)
    expect((await repaired.settings.get('page-proof:oversized'))?.value).toHaveLength(
      1024 * 1024 + 1,
    )
    expect(await repaired.workspaceFence.get('global')).toEqual({
      id: 'global',
      workspaceId: 'inactive-repair-workspace',
      replacementEpoch: 4,
    })
    expect(
      isBrowserWorkspaceCurrentCompletionValueV97(
        (await repaired.settings.get(BROWSER_WORKSPACE_CURRENT_COMPLETION_KEY))?.value,
      ),
    ).toBe(true)
    repaired.close()
    const copyPages = progress.filter(
      (event): event is Extract<BrowserWorkspaceOpenProgress, { kind: 'database-upgrade' }> =>
        event.kind === 'database-upgrade' &&
        event.phase === 'inactive-copy' &&
        event.operation === 'copy-settings',
    )
    let priorRows = 0
    let priorBytes = 0
    for (const page of copyPages) {
      const pageRows = page.processedRows - priorRows
      const pageBytes = page.processedBytes - priorBytes
      expect(pageRows).toBeLessThanOrEqual(64)
      if (pageBytes > 1024 * 1024) expect(pageRows).toBe(1)
      priorRows = page.processedRows
      priorBytes = page.processedBytes
    }
    expect((await indexedDB.databases()).map((database) => database.name)).not.toContain('natter')
  })

  it('rebuilds poisoned derived rows after a missing current marker without changing the epoch', async () => {
    const source = new NatterDb('natter')
    await source.open()
    await source.settings.put({ key: 'canonical-proof', value: 'current-source' })
    await source.chatSidebarRows.put({ id: 'poison', title: 'poison' } as never)
    await source.settings.delete(BROWSER_WORKSPACE_CURRENT_COMPLETION_KEY)
    source.close()

    const proof = await runStartupRepair()
    const repaired = new NatterDb(proof.databaseName)
    await repaired.open()
    expect(repaired.verno).toBe(97)
    expect((await repaired.settings.get('canonical-proof'))?.value).toBe('current-source')
    expect(await repaired.chatSidebarRows.get('poison')).toBeUndefined()
    repaired.close()
  })

  it('repairs an earlier v97 completion marker and reclaims empty-profile derived rows', async () => {
    const source = new Dexie('natter')
    source.version(97).stores({
      ...WAVE_B_V97_STORES,
      attachmentRefEdges:
        '&[ownerKind+ownerId+refId], attachmentId, [attachmentId+ownerKind], [attachmentId+chatId], [ownerKind+ownerId], chatId',
    })
    await source.open()
    const chat = createChatRow({ id: 'unconfigured-chat' })
    await source.transaction(
      'rw',
      [
        source.table('chats'),
        source.table('configurationLinks'),
        source.table('configurationProfileUsageRows'),
        source.table('settings'),
      ],
      async () => {
        await source.table('chats').put(chat)
        await source.table('configurationLinks').put({
          id: `chat:${chat.id}:profile`,
          ownerKind: 'chat',
          ownerId: chat.id,
          ownerKey: `chat:${chat.id}`,
          targetKind: 'profile',
          targetId: '',
          targetKey: 'profile:',
          slot: 'profile',
          ownerActive: true,
        })
        await source.table('configurationProfileUsageRows').put({
          id: '',
          presetCount: 0,
          activePresetCount: 0,
          chatCount: 1,
          activeChatCount: 1,
        })
        await source.table('settings').put({
          key: BROWSER_WORKSPACE_CURRENT_COMPLETION_KEY,
          value: {
            formatVersion: 2,
            storageVersion: 97,
            phase: 'canonical-and-derived-complete',
          },
        })
      },
    )
    source.close()

    const proof = await runStartupRepair()
    const repaired = new NatterDb(proof.databaseName)
    await repaired.open()
    expect(repaired.verno).toBe(97)
    expect(await repaired.chats.get(chat.id)).toMatchObject({
      id: chat.id,
      settings: { profileId: '' },
    })
    expect(await repaired.configurationLinks.where('targetKey').equals('profile:').count()).toBe(0)
    expect(await repaired.configurationProfileUsageRows.get('')).toBeUndefined()
    expect(repaired.attachmentRefEdges.schema.indexes.map((index) => index.src)).toContain(
      '[attachmentId+ownerKind+ownerId+refId]',
    )
    expect(
      isBrowserWorkspaceCurrentCompletionValueV97(
        (await repaired.settings.get(BROWSER_WORKSPACE_CURRENT_COMPLETION_KEY))?.value,
      ),
    ).toBe(true)
    repaired.close()
  })

  it('keeps a malformed authoritative source selected when inactive normalization fails', async () => {
    const legacy = new Dexie('natter')
    legacy.version(95.8).stores(WAVE_A_V94_STORES)
    await legacy.open()
    await legacy.table('settings').put({ key: 'canonical-proof', value: 'still-source' })
    await legacy.table('messages').put({
      id: 'message-poison',
      chatId: 'chat-poison',
      bodyVersion: 0,
      nodeVersion: 0,
      requestContextVersion: 0,
    })
    legacy.close()

    await expect(runStartupRepair()).rejects.toThrow('WaveAMessageBodyMissing:message-poison')
    expect(await readBrowserWorkspaceDatabaseManifest()).toEqual({
      id: 'workspace',
      activeDatabaseName: 'natter',
      activationSequence: 0,
    })
    const source = await openRawDatabase('natter')
    expect(
      await requestValue(
        source.transaction('settings', 'readonly').objectStore('settings').get('canonical-proof'),
      ),
    ).toEqual({ key: 'canonical-proof', value: 'still-source' })
    source.close()
    expect((await indexedDB.databases()).map((database) => database.name)).not.toContain(
      'natter-workspace-a',
    )
  })

  it('rejects a future physical version without deleting its unclassified rows', async () => {
    await openDb()
    const futureVersion = currentRawVersion() + 1
    __resetDbForTests({ admissionsOpen: true })
    await upgradeRawDatabase('natter', futureVersion, (database) => {
      database.createObjectStore('unknownUserRows', { keyPath: 'id' })
    })

    await expect(openDb()).rejects.toThrow(
      `BrowserWorkspaceSchemaIntegrity:future-version:${futureVersion}`,
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

async function runStartupRepair(onProgress?: (progress: BrowserWorkspaceOpenProgress) => void) {
  Object.defineProperty(globalThis, 'BroadcastChannel', {
    configurable: true,
    value: SilentBroadcastChannel,
  })
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: new ImmediateLockManager(),
  })
  const coordinator = installBrowserWorkspaceSlotCoordinator({
    validateQuiesce: async () => false,
    reconcile: async () => undefined,
  })
  try {
    return await ensureBrowserWorkspaceCurrentForSelection(new AbortController().signal, onProgress)
  } finally {
    disposeBrowserWorkspaceSlotCoordinator(coordinator)
  }
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

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
