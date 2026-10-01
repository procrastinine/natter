import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createChatRow } from '../../src/core/chat-metadata'
import { probeBrowserWorkspaceCurrent } from '../../src/store/browser-workspace-current-probe'
import { cleanPendingBrowserWorkspaceDatabase } from '../../src/store/browser-workspace-database-cleanup'
import * as browserWorkspaceControl from '../../src/store/browser-workspace-database-control'
import {
  __resetBrowserWorkspaceControlDatabaseForTests,
  readBrowserWorkspaceDatabaseManifest,
  tryBeginBrowserWorkspaceDatabaseReplacement,
} from '../../src/store/browser-workspace-database-control'
import type { BrowserWorkspaceOpenProgress } from '../../src/store/browser-workspace-open-contract'
import { WAVE_A_V94_STORES } from '../../src/store/browser-workspace-schema-v94'
import {
  browserWorkspaceCurrentCompletionSettingV97,
  BROWSER_WORKSPACE_CURRENT_COMPLETION_KEY as V97_COMPLETION_KEY,
  WAVE_B_V97_STORES,
} from '../../src/store/browser-workspace-schema-v97'
import {
  BROWSER_WORKSPACE_CURRENT_COMPLETION_KEY,
  isBrowserWorkspaceCurrentCompletionValueV98,
} from '../../src/store/browser-workspace-schema-v98'
import {
  __resetBrowserWorkspaceSlotCoordinatorForTests,
  disposeBrowserWorkspaceSlotCoordinator,
  installBrowserWorkspaceSlotCoordinator,
} from '../../src/store/browser-workspace-slot-coordination'
import { ensureBrowserWorkspaceCurrentForSelection } from '../../src/store/browser-workspace-startup-repair'
import { isValidChatSidebarFolderAggregateRow } from '../../src/store/chat-sidebar-projection'
import * as browserWorkspaceDb from '../../src/store/db'
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
import { TestWebLockManager } from '../helpers/web-locks'

const originalBroadcastChannel = globalThis.BroadcastChannel
const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks')

class RecordingWebLockManager extends TestWebLockManager {
  readonly requests: { readonly name: string; readonly mode: LockMode }[] = []
  onRequest: ((name: string, options: LockOptions) => void) | null = null

  override request<T>(
    name: string,
    optionsOrCallback: LockOptions | ((lock: Lock | null) => T | PromiseLike<T>),
    callback?: (lock: Lock | null) => T | PromiseLike<T>,
  ): Promise<T> {
    const options = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback
    this.requests.push({ name, mode: options.mode ?? 'exclusive' })
    const requested = super.request(name, optionsOrCallback, callback)
    this.onRequest?.(name, options)
    return requested
  }
}

class RejectingReentrantLockManager extends RecordingWebLockManager {
  private readonly active = new Set<string>()

  override request<T>(
    name: string,
    optionsOrCallback: LockOptions | ((lock: Lock | null) => T | PromiseLike<T>),
    callback?: (lock: Lock | null) => T | PromiseLike<T>,
  ): Promise<T> {
    if (this.active.has(name)) throw new Error(`ReentrantLockRequest:${name}`)
    const operation = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback
    if (!operation) throw new Error('LockCallbackMissing')
    const options = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback
    return super.request(name, options, async (lock) => {
      if (!lock) return operation(lock)
      this.active.add(name)
      try {
        return await operation(lock)
      } finally {
        this.active.delete(name)
      }
    })
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
  __resetBrowserWorkspaceControlDatabaseForTests()
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
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
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
    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenNthCalledWith(
      1,
      "Upgrade 'natter' blocked by other connection holding version 22",
    )
    expect(warn).toHaveBeenNthCalledWith(
      2,
      "Upgrade 'natter' blocked by other connection holding version 22",
    )
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

  it('probes only the current proof and the exact physical predecessor proof', async () => {
    const name = 'natter'
    await createValidV97Workspace(name)
    const settingsKeys: Array<IDBValidKey | IDBKeyRange> = []
    const originalGet = IDBObjectStore.prototype.get
    const get = vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (
      this: IDBObjectStore,
      query,
    ) {
      if (this.name === 'settings') settingsKeys.push(query)
      return originalGet.call(this, query)
    })
    try {
      await expect(probeBrowserWorkspaceCurrent(name)).resolves.toMatchObject({
        kind: 'upgrade-required',
        physicalVersion: 970,
        strategyId: 'v97-to-v98',
      })
      expect(settingsKeys).toEqual([BROWSER_WORKSPACE_CURRENT_COMPLETION_KEY, V97_COMPLETION_KEY])
    } finally {
      get.mockRestore()
      await Dexie.delete(name)
    }
  })

  it('takes the production startup route from valid v97 without reading or rebuilding chat rows', async () => {
    const name = 'natter'
    const legacy = new Dexie(name)
    legacy.version(97).stores(WAVE_B_V97_STORES)
    await legacy.open()
    await legacy.transaction(
      'rw',
      [
        legacy.table('chats'),
        legacy.table('chatSidebarAggregates'),
        legacy.table('folders'),
        legacy.table('settings'),
      ],
      async () => {
        await legacy
          .table('chats')
          .bulkPut(Array.from({ length: 4_096 }, (_, index) => ({ id: `unread-chat-${index}` })))
        await legacy.table('chatSidebarAggregates').put({
          id: 'workspace',
          kind: 'workspace',
          projectionVersion: 2,
          totalCount: 4_096,
          activeCount: 4_096,
          archivedCount: 0,
          pinnedCount: 0,
          visibleCount: 0,
          visiblePinnedCount: 0,
          rootCount: 4_096,
          rootVisibleCount: 0,
          rootVisiblePinnedCount: 0,
        })
        await legacy.table('folders').bulkPut(
          Array.from({ length: 300 }, (_, index) => ({
            id: `folder-${index}`,
            name: `Folder ${index}`,
            sortIndex: index,
            createdAt: 1,
            updatedAt: 2,
            lastUsedAt: 3,
          })),
        )
        await legacy.table('settings').put(browserWorkspaceCurrentCompletionSettingV97())
      },
    )
    legacy.close()

    const originalOpenCursor = IDBObjectStore.prototype.openCursor
    const forbiddenCursor = vi
      .spyOn(IDBObjectStore.prototype, 'openCursor')
      .mockImplementation(function (this: IDBObjectStore, query, direction) {
        if (['chats', 'messages', 'messageBodies', 'chatSidebarRows'].includes(this.name)) {
          throw new Error(`ForbiddenRegisteredUpgradeRead:${this.name}`)
        }
        return originalOpenCursor.call(this, query, direction)
      })
    const progress: BrowserWorkspaceOpenProgress[] = []
    const proof = await runStartupRepair((event) => progress.push(event))
    forbiddenCursor.mockRestore()

    expect(proof).toEqual({
      databaseName: 'natter',
      activationSequence: 0,
      physicalVersion: 980,
    })
    expect(await readBrowserWorkspaceDatabaseManifest()).toEqual({
      id: 'workspace',
      activeDatabaseName: 'natter',
      activationSequence: 0,
    })
    expect(
      progress.some(
        (event) =>
          event.kind === 'database-upgrade' &&
          (event.operation.startsWith('copy-') || event.operation === 'rebuild-child-slots'),
      ),
    ).toBe(false)
    expect(
      progress.filter(
        (event) =>
          event.kind === 'database-upgrade' &&
          event.operation === 'migrate-sidebar-folder-presentation',
      ).length,
    ).toBeGreaterThanOrEqual(3)
    expect((await indexedDB.databases()).map((database) => database.name)).not.toContain(
      'natter-workspace-a',
    )

    const upgraded = new NatterDb(name)
    await upgraded.open()
    expect(await upgraded.chats.get('unread-chat-4095')).toEqual({ id: 'unread-chat-4095' })
    expect((await upgraded.chatSidebarAggregates.get('workspace'))?.projectionVersion).toBe(3)
    expect(
      isValidChatSidebarFolderAggregateRow(
        await upgraded.chatSidebarAggregates.get('folder:folder-299'),
      ),
    ).toBe(true)
    upgraded.close()
    await Dexie.delete(name)
  })

  it('elects one registered upgrader when many startup tabs arrive together', async () => {
    await createValidV97Workspace('natter')
    const progress: BrowserWorkspaceOpenProgress[] = []
    const lockManager = new RecordingWebLockManager()
    const coordinator = installStartupRepairRuntime(lockManager)
    try {
      const proofs = await Promise.all(
        Array.from({ length: 16 }, () =>
          ensureBrowserWorkspaceCurrentForSelection(new AbortController().signal, (event) =>
            progress.push(event),
          ),
        ),
      )
      expect(new Set(proofs.map((proof) => JSON.stringify(proof)))).toEqual(
        new Set([
          JSON.stringify({
            databaseName: 'natter',
            activationSequence: 0,
            physicalVersion: 980,
          }),
        ]),
      )
    } finally {
      disposeBrowserWorkspaceSlotCoordinator(coordinator)
    }
    expect(
      progress.filter((event) => event.kind === 'database-open' && event.fromVersion === 97),
    ).toHaveLength(1)
    expect(
      progress.filter(
        (event) =>
          event.kind === 'database-upgrade' &&
          event.operation === 'write-sidebar-folder-completion',
      ),
    ).toHaveLength(1)
    expect(
      lockManager.requests.filter(
        (request) =>
          request.name === 'natter:workspace-slot:natter' && request.mode === 'exclusive',
      ),
    ).toHaveLength(1)
  })

  it('discards an interrupted inactive repair before upgrading the authoritative v97 slot', async () => {
    await createValidV97Workspace('natter')
    const begin = await tryBeginBrowserWorkspaceDatabaseReplacement()
    if (begin.kind !== 'ready') throw new Error('ExpectedPreparedReplacement')
    const abandoned = new NatterDb(begin.journal.destinationDatabaseName)
    await abandoned.open()
    await abandoned.settings.put({ key: 'abandoned-copy', value: true })
    abandoned.close()

    const proof = await runStartupRepair()
    expect(proof).toEqual({
      databaseName: 'natter',
      activationSequence: 0,
      physicalVersion: 980,
    })
    expect(await readBrowserWorkspaceDatabaseManifest()).toEqual({
      id: 'workspace',
      activeDatabaseName: 'natter',
      activationSequence: 0,
    })
    expect((await indexedDB.databases()).map((database) => database.name)).not.toContain(
      begin.journal.destinationDatabaseName,
    )
  })

  it('waits for an old connection and resumes the registered upgrade when it closes', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await createValidV97Workspace('natter')
    const blocker = await openRawDatabase('natter')
    blocker.onversionchange = () => undefined
    let noteBlocked!: () => void
    const blocked = new Promise<void>((resolve) => {
      noteBlocked = resolve
    })
    let settled = false
    const opening = runStartupRepair(undefined, () => noteBlocked()).finally(() => {
      settled = true
    })
    try {
      await blocked
      expect(settled).toBe(false)
    } finally {
      blocker.close()
    }
    await expect(opening).resolves.toMatchObject({ physicalVersion: 980 })
    expect(warn).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith(
      "Upgrade 'natter' blocked by other connection holding version 97",
    )
  })

  it('rejects an undeclared intermediate epoch instead of defaulting to full repair', async () => {
    await createValidV97Workspace('natter')
    await upgradeRawDatabase('natter', 975, () => undefined)

    await expect(runStartupRepair()).rejects.toThrow(
      'BrowserWorkspaceSchemaIntegrity:upgrade-strategy-missing:975:980',
    )
    expect(await readBrowserWorkspaceDatabaseManifest()).toEqual({
      id: 'workspace',
      activeDatabaseName: 'natter',
      activationSequence: 0,
    })
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

  it('normalizes observed v95.8 rows and hands old-slot deletion to cleanup', async () => {
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
      physicalVersion: 980,
    })
    expect(await readBrowserWorkspaceDatabaseManifest()).toEqual({
      id: 'workspace',
      activeDatabaseName: 'natter-workspace-a',
      activationSequence: 1,
      pending: {
        nonce: expect.any(String) as string,
        phase: 'cleanup',
        sourceDatabaseName: 'natter',
        destinationDatabaseName: 'natter-workspace-a',
      },
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
      isBrowserWorkspaceCurrentCompletionValueV98(
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
    expect(
      progress.some(
        (event) =>
          event.kind === 'database-upgrade' &&
          event.operation === 'migrate-sidebar-folder-presentation',
      ),
    ).toBe(true)
    expect(
      progress.some(
        (event) =>
          event.kind === 'database-upgrade' &&
          event.operation === 'write-sidebar-folder-completion',
      ),
    ).toBe(true)
    expect((await indexedDB.databases()).map((database) => database.name)).toContain('natter')
    await expect(cleanPendingBrowserWorkspaceDatabase()).resolves.toEqual({
      status: 'cleaned',
      phase: 'cleanup',
      databaseName: 'natter',
    })
    expect((await readBrowserWorkspaceDatabaseManifest()).pending).toBeUndefined()
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
    expect(repaired.verno).toBe(98)
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
          key: V97_COMPLETION_KEY,
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
    expect(repaired.verno).toBe(98)
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
      isBrowserWorkspaceCurrentCompletionValueV98(
        (await repaired.settings.get(BROWSER_WORKSPACE_CURRENT_COMPLETION_KEY))?.value,
      ),
    ).toBe(true)
    repaired.close()
  })

  it.each([
    {
      label: 'round DOMException',
      admission: 'round',
      reason: new DOMException('cancel startup', 'AbortError'),
    },
    { label: 'round object', admission: 'round', reason: { caller: 'startup-round' } },
    { label: 'round null', admission: 'round', reason: null },
    {
      label: 'slot DOMException',
      admission: 'slot',
      reason: new DOMException('cancel startup', 'AbortError'),
    },
    { label: 'slot object', admission: 'slot', reason: { caller: 'startup-slot' } },
    { label: 'slot null', admission: 'slot', reason: null },
  ])(
    'settles startup staging on cancellation before $label admission',
    async ({ admission, reason }) => {
      await createLegacyRepairWorkspace()
      const locks = new RecordingWebLockManager()
      const coordinator = installStartupRepairRuntime(locks)
      const controller = new AbortController()
      const slot = 'natter:workspace-slot:natter-workspace-a'
      const held = startupBoundaryGate()
      const release = startupBoundaryGate()
      const queued = startupBoundaryGate()
      const holder = locks.request(slot, { mode: 'shared' }, async () => {
        held.release()
        await release.promise
      })
      await held.promise
      locks.onRequest = (name, options) => {
        if (admission === 'round' && name.startsWith('natter:workspace-slot-round:')) {
          controller.abort(reason)
          queued.release()
        } else if (admission === 'slot' && name === slot && options.mode === 'exclusive') {
          queued.release()
        }
      }
      const disposing = startupBoundaryGate()
      const releaseDisposition = startupBoundaryGate()
      const dispositions: LockManagerSnapshot[] = []
      const originalAbandon = browserWorkspaceControl.abandonPreparedBrowserWorkspaceDatabase
      const abandon = vi
        .spyOn(browserWorkspaceControl, 'abandonPreparedBrowserWorkspaceDatabase')
        .mockImplementation(async (...args) => {
          if (admission === 'slot') {
            disposing.release()
            await releaseDisposition.promise
          }
          await originalAbandon(...args)
          dispositions.push(await locks.query())
        })
      const opening = ensureBrowserWorkspaceCurrentForSelection(controller.signal)
      const observed = opening.then(
        () => ({ kind: 'fulfilled' as const }),
        (failure: unknown) => ({ kind: 'rejected' as const, failure }),
      )
      try {
        await queued.promise
        if (admission === 'slot') {
          expect((await locks.query()).pending).toContainEqual({ name: slot, mode: 'exclusive' })
          controller.abort(reason)
          expect((await locks.query()).pending).not.toContainEqual({
            name: slot,
            mode: 'exclusive',
          })
          const reachedDisposition = await Promise.race([
            disposing.promise.then(() => true),
            observed.then(() => false),
          ])
          expect(reachedDisposition).toBe(true)
          const duringDisposition = await locks.query()
          expect(
            duringDisposition.held?.some((lock) =>
              lock.name?.startsWith('natter:workspace-slot-round:'),
            ),
          ).toBe(true)
          expect(duringDisposition.held).toContainEqual({
            name: 'natter:workspace-slot-selection:v1',
            mode: 'exclusive',
          })
          expect((await readBrowserWorkspaceDatabaseManifest()).pending?.phase).toBe('preparing')
          releaseDisposition.release()
        }
        const outcome = await observed
        expect(outcome.kind).toBe('rejected')
        if (outcome.kind !== 'rejected') throw new Error('Expected startup cancellation')
        expect(outcome.failure).toBe(reason)
        expect(dispositions).toHaveLength(1)
        expect(
          dispositions[0]?.held?.some((lock) =>
            lock.name?.startsWith('natter:workspace-slot-round:'),
          ),
        ).toBe(admission === 'slot')
        expect(await readBrowserWorkspaceDatabaseManifest()).toMatchObject({
          activeDatabaseName: 'natter',
          activationSequence: 0,
          pending: {
            phase: 'discard',
            sourceDatabaseName: 'natter',
            destinationDatabaseName: 'natter-workspace-a',
          },
        })
        expect(await locks.query()).toEqual({ held: [{ name: slot, mode: 'shared' }], pending: [] })
        if (admission === 'round') {
          expect(
            locks.requests.filter(
              (request) =>
                request.name.startsWith('natter:workspace-slot:') && request.mode === 'exclusive',
            ),
          ).toEqual([])
        }
      } finally {
        locks.onRequest = null
        controller.abort(reason)
        releaseDisposition.release()
        release.release()
        await holder
        await observed
        abandon.mockRestore()
        disposeBrowserWorkspaceSlotCoordinator(coordinator)
      }
    },
  )

  it('retains an independent staging-disposition failure when startup cancellation wins admission', async () => {
    await createLegacyRepairWorkspace()
    const locks = new RecordingWebLockManager()
    const coordinator = installStartupRepairRuntime(locks)
    const controller = new AbortController()
    const reason = { caller: 'cancel before round' }
    const cleanupFailure = new Error('control journal unavailable')
    const abandon = vi
      .spyOn(browserWorkspaceControl, 'abandonPreparedBrowserWorkspaceDatabase')
      .mockRejectedValue(cleanupFailure)
    locks.onRequest = (name) => {
      if (name.startsWith('natter:workspace-slot-round:')) controller.abort(reason)
    }
    try {
      const failure = await ensureBrowserWorkspaceCurrentForSelection(controller.signal).then(
        () => {
          throw new Error('Expected startup rejection')
        },
        (error: unknown) => error,
      )
      expect(failure).toBeInstanceOf(AggregateError)
      expect((failure as AggregateError).errors).toHaveLength(2)
      expect((failure as AggregateError).errors[0]).toBe(reason)
      expect((failure as AggregateError).errors[1]).toBe(cleanupFailure)
      expect(abandon).toHaveBeenCalledOnce()
      expect(await readBrowserWorkspaceDatabaseManifest()).toMatchObject({
        activeDatabaseName: 'natter',
        activationSequence: 0,
        pending: { phase: 'preparing' },
      })
      expect(await locks.query()).toEqual({ held: [], pending: [] })
    } finally {
      abandon.mockRestore()
      locks.onRequest = null
      disposeBrowserWorkspaceSlotCoordinator(coordinator)
    }
  })

  it('retains uncertain activation evidence without discarding a possibly committed destination', async () => {
    await createLegacyRepairWorkspace()
    const locks = new RecordingWebLockManager()
    const coordinator = installStartupRepairRuntime(locks)
    const failure = new browserWorkspaceControl.BrowserWorkspaceActivationOutcomeUncertainError([
      new Error('activation inspection unavailable'),
    ])
    const activate = browserWorkspaceControl.activatePreparedBrowserWorkspaceDatabase
    vi.spyOn(
      browserWorkspaceControl,
      'activatePreparedBrowserWorkspaceDatabase',
    ).mockImplementation(async (...args) => {
      await activate(...args)
      throw failure
    })
    const abandon = vi.spyOn(browserWorkspaceControl, 'abandonPreparedBrowserWorkspaceDatabase')
    try {
      await expect(
        ensureBrowserWorkspaceCurrentForSelection(new AbortController().signal),
      ).rejects.toBe(failure)
      expect(abandon).not.toHaveBeenCalled()
      expect(await readBrowserWorkspaceDatabaseManifest()).toMatchObject({
        activeDatabaseName: 'natter-workspace-a',
        activationSequence: 1,
        pending: {
          phase: 'cleanup',
          sourceDatabaseName: 'natter',
          destinationDatabaseName: 'natter-workspace-a',
        },
      })
      expect(await locks.query()).toEqual({ held: [], pending: [] })
    } finally {
      disposeBrowserWorkspaceSlotCoordinator(coordinator)
    }
  })

  it.each(['source-rejection', 'destination-rejection', 'cancel-after-source'] as const)(
    'releases every acquired raw repair handle on %s',
    async (boundary) => {
      await createLegacyRepairWorkspace()
      const locks = new RecordingWebLockManager()
      const coordinator = installStartupRepairRuntime(locks)
      const controller = new AbortController()
      const failure = new Error(`raw repair ${boundary}`)
      const opened: IDBDatabase[] = []
      let rawCopy = false
      let destinationRequests = 0
      const recreate = browserWorkspaceDb.recreateAndVerifyBrowserWorkspaceDatabase
      vi.spyOn(browserWorkspaceDb, 'recreateAndVerifyBrowserWorkspaceDatabase').mockImplementation(
        async (...args) => {
          await recreate(...args)
          rawCopy = true
        },
      )
      const nativeOpen = indexedDB.open.bind(indexedDB)
      const closed = vi.spyOn(IDBDatabase.prototype, 'close')
      vi.spyOn(indexedDB, 'open').mockImplementation((name, version) => {
        if (!rawCopy || version !== undefined)
          return version === undefined ? nativeOpen(name) : nativeOpen(name, version)
        const source = name === 'natter'
        if (!source) destinationRequests += 1
        if (
          (source && boundary === 'source-rejection') ||
          (!source && boundary === 'destination-rejection')
        ) {
          rawCopy = false
          throw failure
        }
        const request = nativeOpen(name)
        request.addEventListener(
          'success',
          () => {
            opened.push(request.result)
            if (source && boundary === 'cancel-after-source') {
              rawCopy = false
              controller.abort(failure)
            }
          },
          { once: true },
        )
        return request
      })
      try {
        await expect(ensureBrowserWorkspaceCurrentForSelection(controller.signal)).rejects.toBe(
          failure,
        )
        expect(opened).toHaveLength(boundary === 'source-rejection' ? 0 : 1)
        for (const database of opened) expect(closed.mock.contexts).toContain(database)
        expect(destinationRequests).toBe(boundary === 'destination-rejection' ? 1 : 0)
        const manifest = await readBrowserWorkspaceDatabaseManifest()
        expect(manifest).toMatchObject({ activeDatabaseName: 'natter', activationSequence: 0 })
        expect(manifest.pending?.phase).toBe('discard')
        expect(await locks.query()).toEqual({ held: [], pending: [] })
        await expect(cleanPendingBrowserWorkspaceDatabase()).resolves.toMatchObject({
          status: 'cleaned',
          phase: 'discard',
          databaseName: 'natter-workspace-a',
        })
        expect((await readBrowserWorkspaceDatabaseManifest()).pending).toBeUndefined()
      } finally {
        disposeBrowserWorkspaceSlotCoordinator(coordinator)
      }
    },
  )

  it('adopts a peer repair completed after both contenders queued for selection', async () => {
    await createLegacyRepairWorkspace()
    const locks = new RecordingWebLockManager()
    const coordinator = installStartupRepairRuntime(locks)
    const selection = 'natter:workspace-slot-selection:v1'
    const held = startupBoundaryGate()
    const release = startupBoundaryGate()
    const queued = startupBoundaryGate()
    const holder = locks.request(selection, { mode: 'exclusive' }, async () => {
      held.release()
      await release.promise
    })
    await held.promise
    let contenders = 0
    locks.onRequest = (name, options) => {
      if (name === selection && options.mode === 'exclusive' && ++contenders === 2) queued.release()
    }
    const activate = vi.spyOn(browserWorkspaceControl, 'activatePreparedBrowserWorkspaceDatabase')
    const openings = [0, 1].map(() =>
      ensureBrowserWorkspaceCurrentForSelection(new AbortController().signal),
    )
    const outcomes = Promise.allSettled(openings)
    try {
      await queued.promise
      expect((await locks.query()).pending).toEqual([
        { name: selection, mode: 'exclusive' },
        { name: selection, mode: 'exclusive' },
      ])
      release.release()
      await holder
      const proof = {
        databaseName: 'natter-workspace-a',
        activationSequence: 1,
        physicalVersion: 980,
      }
      expect(await outcomes).toEqual([
        { status: 'fulfilled', value: proof },
        { status: 'fulfilled', value: proof },
      ])
      expect(activate).toHaveBeenCalledTimes(1)
      expect((await readBrowserWorkspaceDatabaseManifest()).pending?.phase).toBe('cleanup')
      expect((await indexedDB.databases()).map((database) => database.name)).toContain('natter')
      expect(await locks.query()).toEqual({ held: [], pending: [] })
    } finally {
      locks.onRequest = null
      release.release()
      await holder
      await outcomes
      disposeBrowserWorkspaceSlotCoordinator(coordinator)
    }
  })

  it('returns the repaired active source while old-source reclamation waits on an independent holder', async () => {
    await createLegacyRepairWorkspace()
    const locks = new RecordingWebLockManager()
    const coordinator = installStartupRepairRuntime(locks)
    const slot = 'natter:workspace-slot:natter'
    const held = startupBoundaryGate()
    const release = startupBoundaryGate()
    const cleanupQueued = startupBoundaryGate()
    let holder: Promise<void> | undefined
    let cleaning: ReturnType<typeof cleanPendingBrowserWorkspaceDatabase> | undefined
    try {
      const proof = await ensureBrowserWorkspaceCurrentForSelection(new AbortController().signal)
      expect(proof).toMatchObject({
        databaseName: 'natter-workspace-a',
        activationSequence: 1,
        physicalVersion: 980,
      })
      expect((await readBrowserWorkspaceDatabaseManifest()).pending).toMatchObject({
        phase: 'cleanup',
        sourceDatabaseName: 'natter',
      })
      expect((await indexedDB.databases()).map((database) => database.name)).toContain('natter')
      holder = locks.request(slot, { mode: 'shared' }, async () => {
        held.release()
        await release.promise
      })
      await held.promise
      locks.onRequest = (name, options) => {
        if (name === slot && options.mode === 'exclusive') cleanupQueued.release()
      }
      cleaning = cleanPendingBrowserWorkspaceDatabase()
      expect(
        await Promise.race([
          cleanupQueued.promise.then(() => 'queued' as const),
          cleaning.then(() => 'completed' as const),
        ]),
      ).toBe('queued')
      expect((await locks.query()).pending).toContainEqual({ name: slot, mode: 'exclusive' })
      await expect(
        ensureBrowserWorkspaceCurrentForSelection(new AbortController().signal),
      ).resolves.toEqual(proof)
      expect((await locks.query()).held).toContainEqual({ name: slot, mode: 'shared' })
      release.release()
      await holder
      await expect(cleaning).resolves.toEqual({
        status: 'cleaned',
        phase: 'cleanup',
        databaseName: 'natter',
      })
      expect((await readBrowserWorkspaceDatabaseManifest()).pending).toBeUndefined()
      expect((await indexedDB.databases()).map((database) => database.name)).not.toContain('natter')
      expect(await locks.query()).toEqual({ held: [], pending: [] })
    } finally {
      locks.onRequest = null
      release.release()
      await Promise.all([holder, cleaning])
      disposeBrowserWorkspaceSlotCoordinator(coordinator)
    }
  })

  it('reports malformed-source failure before waiting for destination reclamation', async () => {
    const legacy = new Dexie('natter')
    legacy.version(95.8).stores(WAVE_A_V94_STORES)
    await legacy.open()
    await legacy.table('messages').put({
      id: 'held-destination-poison',
      chatId: 'chat-poison',
      bodyVersion: 0,
      nodeVersion: 0,
      requestContextVersion: 0,
    })
    legacy.close()
    const locks = new RecordingWebLockManager()
    const coordinator = installStartupRepairRuntime(locks)
    const slot = 'natter:workspace-slot:natter-workspace-a'
    const held = startupBoundaryGate()
    const release = startupBoundaryGate()
    const cleanupQueued = startupBoundaryGate()
    let holder: Promise<void> | undefined
    let cleaning: ReturnType<typeof cleanPendingBrowserWorkspaceDatabase> | undefined
    let exclusiveRequests = 0
    locks.onRequest = (name, options) => {
      if (name !== slot || options.mode !== 'exclusive') return
      exclusiveRequests += 1
      if (exclusiveRequests === 1) {
        holder = locks.request(slot, { mode: 'shared' }, async () => {
          held.release()
          await release.promise
        })
      } else cleanupQueued.release()
    }
    const observed = ensureBrowserWorkspaceCurrentForSelection(new AbortController().signal).then(
      () => ({ kind: 'fulfilled' as const }),
      (failure: unknown) => ({ kind: 'rejected' as const, failure }),
    )
    try {
      expect(
        await Promise.race([
          held.promise.then(() => 'held' as const),
          observed.then(() => 'settled' as const),
        ]),
      ).toBe('held')
      const beforeCleanupAdmission = await Promise.race([
        observed.then(() => true),
        cleanupQueued.promise.then(() => false),
      ])
      expect(beforeCleanupAdmission).toBe(true)
      const outcome = await observed
      expect(outcome.kind).toBe('rejected')
      if (outcome.kind !== 'rejected') throw new Error('Expected malformed-source failure')
      expect(outcome.failure).toBeInstanceOf(Error)
      expect((outcome.failure as Error).message).toContain(
        'WaveAMessageBodyMissing:held-destination-poison',
      )
      expect((await readBrowserWorkspaceDatabaseManifest()).pending).toMatchObject({
        phase: 'discard',
        sourceDatabaseName: 'natter',
        destinationDatabaseName: 'natter-workspace-a',
      })
      expect(await locks.query()).toEqual({ held: [{ name: slot, mode: 'shared' }], pending: [] })
      cleaning = cleanPendingBrowserWorkspaceDatabase()
      expect(
        await Promise.race([
          cleanupQueued.promise.then(() => 'queued' as const),
          cleaning.then(() => 'completed' as const),
        ]),
      ).toBe('queued')
      expect((await locks.query()).pending).toContainEqual({ name: slot, mode: 'exclusive' })
      release.release()
      await holder
      await expect(cleaning).resolves.toEqual({
        status: 'cleaned',
        phase: 'discard',
        databaseName: 'natter-workspace-a',
      })
      expect(await readBrowserWorkspaceDatabaseManifest()).toEqual({
        id: 'workspace',
        activeDatabaseName: 'natter',
        activationSequence: 0,
      })
      expect(await locks.query()).toEqual({ held: [], pending: [] })
    } finally {
      locks.onRequest = null
      release.release()
      await Promise.all([holder, cleaning, observed])
      disposeBrowserWorkspaceSlotCoordinator(coordinator)
    }
  })

  it('keeps a malformed source selected with durable discard before separate cleanup admission', async () => {
    const locks = new RejectingReentrantLockManager()
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

    await expect(runStartupRepair(undefined, undefined, locks)).rejects.toThrow(
      'WaveAMessageBodyMissing:message-poison',
    )
    expect(
      locks.requests.filter(
        ({ name, mode }) => name === 'natter:workspace-slot-selection:v1' && mode === 'exclusive',
      ),
    ).toHaveLength(1)
    expect(await readBrowserWorkspaceDatabaseManifest()).toEqual({
      id: 'workspace',
      activeDatabaseName: 'natter',
      activationSequence: 0,
      pending: {
        nonce: expect.any(String) as string,
        phase: 'discard',
        sourceDatabaseName: 'natter',
        destinationDatabaseName: 'natter-workspace-a',
      },
    })
    const source = await openRawDatabase('natter')
    expect(
      await requestValue(
        source.transaction('settings', 'readonly').objectStore('settings').get('canonical-proof'),
      ),
    ).toEqual({ key: 'canonical-proof', value: 'still-source' })
    source.close()
    expect((await indexedDB.databases()).map((database) => database.name)).toContain(
      'natter-workspace-a',
    )
    await expect(cleanPendingBrowserWorkspaceDatabase()).resolves.toEqual({
      status: 'cleaned',
      phase: 'discard',
      databaseName: 'natter-workspace-a',
    })
    expect(
      locks.requests.filter(({ name }) => name === 'natter:workspace-slot-selection:v1'),
    ).toHaveLength(2)
    expect((await readBrowserWorkspaceDatabaseManifest()).pending).toBeUndefined()
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
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
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
    expect(warn).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith(
      "Another connection wants to upgrade database 'natter'. Closing db now to resume the upgrade.",
    )
  })

  it('delivers fatal invalidation only to the exact owner captured by the session', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
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
    expect(warn).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith(
      "Another connection wants to upgrade database 'natter'. Closing db now to resume the upgrade.",
    )
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

async function runStartupRepair(
  onProgress?: (progress: BrowserWorkspaceOpenProgress) => void,
  onBlocked?: (event: IDBVersionChangeEvent) => void,
  lockManager: TestWebLockManager = new RecordingWebLockManager(),
) {
  const coordinator = installStartupRepairRuntime(lockManager)
  try {
    return await ensureBrowserWorkspaceCurrentForSelection(
      new AbortController().signal,
      onProgress,
      onBlocked,
    )
  } finally {
    disposeBrowserWorkspaceSlotCoordinator(coordinator)
  }
}

function installStartupRepairRuntime(lockManager: TestWebLockManager) {
  Object.defineProperty(globalThis, 'BroadcastChannel', {
    configurable: true,
    value: SilentBroadcastChannel,
  })
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: lockManager,
  })
  return installBrowserWorkspaceSlotCoordinator({
    foregroundDemandSignal: () => new AbortController().signal,
    preemptMaintenance: () => undefined,
    validateQuiesce: async () => false,
    reconcile: async () => undefined,
  })
}

async function createValidV97Workspace(name: string): Promise<void> {
  const legacy = new Dexie(name)
  legacy.version(97).stores(WAVE_B_V97_STORES)
  await legacy.open()
  await legacy.table('chatSidebarAggregates').put({
    id: 'workspace',
    kind: 'workspace',
    projectionVersion: 2,
    totalCount: 0,
    activeCount: 0,
    archivedCount: 0,
    pinnedCount: 0,
    visibleCount: 0,
    visiblePinnedCount: 0,
    rootCount: 0,
    rootVisibleCount: 0,
    rootVisiblePinnedCount: 0,
  })
  await legacy.table('settings').put(browserWorkspaceCurrentCompletionSettingV97())
  legacy.close()
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

function startupBoundaryGate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

async function createLegacyRepairWorkspace(): Promise<void> {
  const legacy = new Dexie('natter')
  legacy.version(95.8).stores(WAVE_A_V94_STORES)
  try {
    await legacy.open()
    await legacy.table('settings').put({ key: 'canonical-proof', value: 'still-source' })
  } finally {
    legacy.close()
  }
}
