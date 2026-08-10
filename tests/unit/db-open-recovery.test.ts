import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createChatRow } from '../../src/core/chat-metadata'
import { probeBrowserWorkspaceCurrent } from '../../src/store/browser-workspace-current-probe'
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

class SerializedLockManager extends ImmediateLockManager {
  private readonly tails = new Map<string, Promise<void>>()
  readonly requests: { readonly name: string; readonly mode: 'shared' | 'exclusive' }[] = []

  override async request<T>(
    name: string,
    options: { mode: 'shared' | 'exclusive'; ifAvailable?: boolean; signal?: AbortSignal },
    callback: (lock: Lock) => Promise<T> | T,
  ): Promise<T> {
    this.requests.push({ name, mode: options.mode })
    const prior = this.tails.get(name) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = prior.then(() => current)
    this.tails.set(name, tail)
    await prior
    try {
      options.signal?.throwIfAborted()
      return await callback({ name, mode: options.mode })
    } finally {
      release()
      if (this.tails.get(name) === tail) this.tails.delete(name)
    }
  }
}

class RejectingReentrantLockManager extends ImmediateLockManager {
  readonly requests: { readonly name: string; readonly mode: 'shared' | 'exclusive' }[] = []
  private readonly active = new Set<string>()

  override async request<T>(
    name: string,
    options: { mode: 'shared' | 'exclusive'; ifAvailable?: boolean; signal?: AbortSignal },
    callback: (lock: Lock) => Promise<T> | T,
  ): Promise<T> {
    this.requests.push({ name, mode: options.mode })
    if (this.active.has(name)) throw new Error(`ReentrantLockRequest:${name}`)
    this.active.add(name)
    try {
      return await super.request(name, options, callback)
    } finally {
      this.active.delete(name)
    }
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
    const lockManager = new SerializedLockManager()
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
      physicalVersion: 980,
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

  it('keeps a malformed authoritative source selected and cleans under one selection admission', async () => {
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
  lockManager: ImmediateLockManager = new ImmediateLockManager(),
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

function installStartupRepairRuntime(lockManager: ImmediateLockManager) {
  Object.defineProperty(globalThis, 'BroadcastChannel', {
    configurable: true,
    value: SilentBroadcastChannel,
  })
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: lockManager,
  })
  return installBrowserWorkspaceSlotCoordinator({
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
