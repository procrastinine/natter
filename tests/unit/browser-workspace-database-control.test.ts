import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NATTER_INDEXED_DATABASE_NAMES } from '../../src/lib/origin-storage-names'
import {
  type BrowserWorkspaceBootstrapAuthority,
  beginBrowserWorkspaceBootstrap,
  finishBrowserWorkspaceBootstrap,
} from '../../src/store/browser-workspace-bootstrap-authority'
import {
  cleanPendingBrowserWorkspaceDatabase,
  recoverQuiescedBrowserWorkspaceReplacement,
} from '../../src/store/browser-workspace-database-cleanup'
import {
  abandonPreparedBrowserWorkspaceDatabase,
  activatePreparedBrowserWorkspaceDatabase,
  beginBrowserWorkspaceDatabaseReplacement,
  classifyBrowserWorkspacePreparedActivationOutcome,
  completeBrowserWorkspaceDatabaseCleanup,
  readBrowserWorkspaceDatabaseManifest,
} from '../../src/store/browser-workspace-database-control'
import {
  __resetBrowserWorkspaceDatabaseSelectionForTests,
  type OpeningBrowserWorkspaceDatabaseSelection,
  prepareBrowserWorkspaceDatabaseSelection,
  releaseOpeningBrowserWorkspaceDatabaseSelection,
} from '../../src/store/browser-workspace-database-selection'
import { __resetBrowserWorkspaceSlotCoordinatorForTests } from '../../src/store/browser-workspace-slot-coordination'
import {
  __resetDbForTests,
  getConfiguredBrowserWorkspaceDatabaseName,
  recreateAndVerifyBrowserWorkspaceDatabase,
} from '../../src/store/db'

const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks')
const storageBaseline = { kind: 'reset', liveBytes: 0 } as const
let bootstrapAuthority: BrowserWorkspaceBootstrapAuthority | null = null
let openingSelection: OpeningBrowserWorkspaceDatabaseSelection | null = null

class ImmediateLockManager {
  request<T>(
    _name: string,
    _options: { mode: 'shared' | 'exclusive'; ifAvailable?: boolean },
    callback: (lock: Lock) => Promise<T> | T,
  ): Promise<T> {
    return Promise.resolve(callback({ name: _name, mode: _options.mode }))
  }
}

class TrackingLockManager extends ImmediateLockManager {
  readonly requests: string[] = []

  override request<T>(
    name: string,
    options: { mode: 'shared' | 'exclusive'; ifAvailable?: boolean },
    callback: (lock: Lock) => Promise<T> | T,
  ): Promise<T> {
    this.requests.push(`${options.mode}:${name}`)
    return super.request(name, options, callback)
  }
}

class DeferredExclusiveSlotLockManager extends ImmediateLockManager {
  private releaseBlocked!: () => void
  private markBlocked!: () => void
  readonly blocked = new Promise<void>((resolve) => {
    this.markBlocked = resolve
  })
  private readonly released = new Promise<void>((resolve) => {
    this.releaseBlocked = resolve
  })

  override request<T>(
    name: string,
    options: { mode: 'shared' | 'exclusive'; ifAvailable?: boolean },
    callback: (lock: Lock) => Promise<T> | T,
  ): Promise<T> {
    if (name === 'natter:workspace-slot:natter' && options.mode === 'exclusive') {
      this.markBlocked()
      return this.released.then(() => callback({ name, mode: options.mode }))
    }
    return super.request(name, options, callback)
  }

  release(): void {
    this.releaseBlocked()
  }
}

class HeldSelectionGateLockManager {
  private held = true
  private readonly waiters: Array<() => void> = []

  request<T>(
    name: string,
    options: { mode: 'shared' | 'exclusive'; ifAvailable?: boolean },
    callback: (lock: Lock | null) => Promise<T> | T,
  ): Promise<T> {
    if (name !== 'natter:workspace-slot-selection:v1' || !this.held) {
      return Promise.resolve(callback({ name, mode: options.mode }))
    }
    if (options.ifAvailable) return Promise.resolve(callback(null))
    return new Promise<T>((resolve, reject) => {
      this.waiters.push(() => {
        void Promise.resolve(callback({ name, mode: options.mode })).then(resolve, reject)
      })
    })
  }

  release(): void {
    this.held = false
    for (const waiter of this.waiters.splice(0)) waiter()
  }
}

describe('browser workspace database control', () => {
  beforeEach(async () => {
    for (const name of NATTER_INDEXED_DATABASE_NAMES) await Dexie.delete(name)
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: new ImmediateLockManager(),
    })
    __resetBrowserWorkspaceDatabaseSelectionForTests()
    __resetBrowserWorkspaceSlotCoordinatorForTests()
    __resetDbForTests()
  })

  afterEach(async () => {
    if (openingSelection) {
      await releaseOpeningBrowserWorkspaceDatabaseSelection(openingSelection)
      openingSelection = null
    }
    if (bootstrapAuthority) {
      finishBrowserWorkspaceBootstrap(bootstrapAuthority)
      bootstrapAuthority = null
    }
    __resetBrowserWorkspaceSlotCoordinatorForTests()
    __resetBrowserWorkspaceDatabaseSelectionForTests()
    __resetDbForTests()
    if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks)
    else Reflect.deleteProperty(navigator, 'locks')
  })

  it('keeps the source authoritative until the prepared slot is atomically activated', async () => {
    const prepared = await beginBrowserWorkspaceDatabaseReplacement()

    expect(prepared).toMatchObject({
      phase: 'preparing',
      sourceDatabaseName: 'natter',
      destinationDatabaseName: 'natter-workspace-a',
    })
    expect(await readBrowserWorkspaceDatabaseManifest()).toMatchObject({
      activeDatabaseName: 'natter',
      activationSequence: 0,
      pending: prepared,
    })
    expect(
      classifyBrowserWorkspacePreparedActivationOutcome(
        await readBrowserWorkspaceDatabaseManifest(),
        prepared,
      ),
    ).toBe('preparing')

    await activatePreparedBrowserWorkspaceDatabase(prepared, storageBaseline)

    expect(await readBrowserWorkspaceDatabaseManifest()).toMatchObject({
      activeDatabaseName: 'natter-workspace-a',
      activationSequence: 1,
      pending: { ...prepared, phase: 'cleanup' },
    })
    expect(
      classifyBrowserWorkspacePreparedActivationOutcome(
        await readBrowserWorkspaceDatabaseManifest(),
        prepared,
      ),
    ).toBe('activated')
    expect(
      classifyBrowserWorkspacePreparedActivationOutcome(
        await readBrowserWorkspaceDatabaseManifest(),
        { ...prepared, nonce: 'different' },
      ),
    ).toBe('changed')
  })

  it('reuses only the three fixed workspace slots across repeated replacements', async () => {
    for (const destinationDatabaseName of [
      'natter-workspace-a',
      'natter-workspace-b',
      'natter',
    ] as const) {
      const prepared = await beginBrowserWorkspaceDatabaseReplacement()
      expect(prepared.destinationDatabaseName).toBe(destinationDatabaseName)
      await activatePreparedBrowserWorkspaceDatabase(prepared, storageBaseline)
      await completeBrowserWorkspaceDatabaseCleanup({ ...prepared, phase: 'cleanup' })
    }

    expect(await readBrowserWorkspaceDatabaseManifest()).toEqual({
      id: 'workspace',
      activeDatabaseName: 'natter',
      activationSequence: 3,
    })
  })

  it('opens the authoritative source before reclaiming an abandoned prepared slot', async () => {
    await recreateAndVerifyBrowserWorkspaceDatabase('natter')
    const prepared = await beginBrowserWorkspaceDatabaseReplacement()
    const partial = await openRawDatabase(prepared.destinationDatabaseName)
    partial.close()
    const locks = new TrackingLockManager()
    Object.defineProperty(navigator, 'locks', { configurable: true, value: locks })

    await prepareSelection()

    expect(getConfiguredBrowserWorkspaceDatabaseName()).toBe('natter')
    expect(await readBrowserWorkspaceDatabaseManifest()).toMatchObject({
      id: 'workspace',
      activeDatabaseName: 'natter',
      activationSequence: 0,
      pending: prepared,
    })
    expect(locks.requests).not.toContain('exclusive:natter:workspace-slot-selection:v1')
    await expect(cleanPendingBrowserWorkspaceDatabase()).resolves.toMatchObject({
      status: 'cleaned',
      phase: 'discard',
      databaseName: prepared.destinationDatabaseName,
    })
    await expect(databaseNames()).resolves.not.toContain(prepared.destinationDatabaseName)
  })

  it('opens the committed source while a replacement still owns selection', async () => {
    await recreateAndVerifyBrowserWorkspaceDatabase('natter')
    const prepared = await beginBrowserWorkspaceDatabaseReplacement()
    const partial = await openRawDatabase(prepared.destinationDatabaseName)
    partial.close()
    const locks = new HeldSelectionGateLockManager()
    Object.defineProperty(navigator, 'locks', { configurable: true, value: locks })
    bootstrapAuthority = beginBrowserWorkspaceBootstrap()
    const progress: string[] = []
    openingSelection = await prepareBrowserWorkspaceDatabaseSelection(
      bootstrapAuthority,
      (event) => {
        if (event.kind === 'database-selection') progress.push(event.operation)
      },
    )

    expect(progress).toEqual(['read-active-slot', 'acquire-active-slot', 'confirm-active-slot'])
    expect(getConfiguredBrowserWorkspaceDatabaseName()).toBe('natter')
    expect(await readBrowserWorkspaceDatabaseManifest()).toMatchObject({ pending: prepared })
    await expect(databaseNames()).resolves.toContain(prepared.destinationDatabaseName)

    locks.release()
    await expect(cleanPendingBrowserWorkspaceDatabase()).resolves.toMatchObject({
      status: 'cleaned',
      phase: 'discard',
      databaseName: prepared.destinationDatabaseName,
    })
    await expect(databaseNames()).resolves.not.toContain(prepared.destinationDatabaseName)
  })

  it('reopens the activated destination before asynchronously cleaning the old source', async () => {
    await recreateAndVerifyBrowserWorkspaceDatabase('natter')
    const prepared = await beginBrowserWorkspaceDatabaseReplacement()
    await recreateAndVerifyBrowserWorkspaceDatabase(prepared.destinationDatabaseName)
    await activatePreparedBrowserWorkspaceDatabase(prepared, storageBaseline)

    await prepareSelection()

    expect(getConfiguredBrowserWorkspaceDatabaseName()).toBe('natter-workspace-a')
    expect(await readBrowserWorkspaceDatabaseManifest()).toEqual({
      id: 'workspace',
      activeDatabaseName: 'natter-workspace-a',
      activationSequence: 1,
      pending: { ...prepared, phase: 'cleanup' },
    })
    await expect(databaseNames()).resolves.toContain('natter')
    await expect(databaseNames()).resolves.toContain('natter-workspace-a')

    await expect(cleanPendingBrowserWorkspaceDatabase()).resolves.toEqual({
      status: 'cleaned',
      phase: 'cleanup',
      databaseName: 'natter',
    })
    await expect(databaseNames()).resolves.not.toContain('natter')
    expect((await readBrowserWorkspaceDatabaseManifest()).pending).toBeUndefined()
  })

  it('waits on durable selection ownership then resumes before discarding an abandoned destination', async () => {
    const prepared = await beginBrowserWorkspaceDatabaseReplacement()
    const destination = await openRawDatabase(prepared.destinationDatabaseName)
    destination.close()
    const locks = new HeldSelectionGateLockManager()
    Object.defineProperty(navigator, 'locks', { configurable: true, value: locks })
    let settled = false
    const recovery = recoverQuiescedBrowserWorkspaceReplacement(prepared).finally(() => {
      settled = true
    })

    await Promise.resolve()
    expect(settled).toBe(false)
    expect(await Dexie.exists(prepared.destinationDatabaseName)).toBe(true)

    locks.release()
    await expect(recovery).resolves.toEqual({
      kind: 'uncommitted',
      databaseName: prepared.sourceDatabaseName,
      activationSequence: 0,
    })
    expect(await Dexie.exists(prepared.destinationDatabaseName)).toBe(true)
    expect((await readBrowserWorkspaceDatabaseManifest()).pending).toEqual({
      ...prepared,
      phase: 'discard',
    })

    await expect(cleanPendingBrowserWorkspaceDatabase()).resolves.toMatchObject({
      status: 'cleaned',
      phase: 'discard',
      databaseName: prepared.destinationDatabaseName,
    })
    expect(await Dexie.exists(prepared.destinationDatabaseName)).toBe(false)
  })

  it('recovers an activated quiesced peer before obsolete source cleanup', async () => {
    const source = await openRawDatabase('natter')
    source.close()
    const prepared = await beginBrowserWorkspaceDatabaseReplacement()
    const destination = await openRawDatabase(prepared.destinationDatabaseName)
    destination.close()
    await activatePreparedBrowserWorkspaceDatabase(prepared, storageBaseline)

    await expect(recoverQuiescedBrowserWorkspaceReplacement(prepared)).resolves.toEqual({
      kind: 'committed',
      databaseName: prepared.destinationDatabaseName,
      activationSequence: 1,
    })
    expect(await Dexie.exists(prepared.sourceDatabaseName)).toBe(true)
    expect(await Dexie.exists(prepared.destinationDatabaseName)).toBe(true)
    expect((await readBrowserWorkspaceDatabaseManifest()).pending).toEqual({
      ...prepared,
      phase: 'cleanup',
    })

    await expect(cleanPendingBrowserWorkspaceDatabase()).resolves.toMatchObject({
      status: 'cleaned',
      phase: 'cleanup',
      databaseName: prepared.sourceDatabaseName,
    })
    expect(await Dexie.exists(prepared.sourceDatabaseName)).toBe(false)
  })

  it('keeps active-slot selection ready while old-slot deletion waits on a peer', async () => {
    await recreateAndVerifyBrowserWorkspaceDatabase('natter')
    const prepared = await beginBrowserWorkspaceDatabaseReplacement()
    await recreateAndVerifyBrowserWorkspaceDatabase(prepared.destinationDatabaseName)
    await activatePreparedBrowserWorkspaceDatabase(prepared, storageBaseline)
    const locks = new DeferredExclusiveSlotLockManager()
    Object.defineProperty(navigator, 'locks', { configurable: true, value: locks })

    const cleanup = cleanPendingBrowserWorkspaceDatabase()
    await locks.blocked
    await prepareSelection()

    expect(getConfiguredBrowserWorkspaceDatabaseName()).toBe('natter-workspace-a')
    expect(await readBrowserWorkspaceDatabaseManifest()).toMatchObject({
      activeDatabaseName: 'natter-workspace-a',
      pending: { ...prepared, phase: 'cleanup' },
    })
    expect(await Dexie.exists('natter')).toBe(true)

    locks.release()
    await expect(cleanup).resolves.toMatchObject({ status: 'cleaned', databaseName: 'natter' })
  })

  it('cleans one journaled slot without enumerating or opening workspace stores', async () => {
    const prepared = await beginBrowserWorkspaceDatabaseReplacement()
    const destination = await openRawDatabase(prepared.destinationDatabaseName)
    destination.close()
    await abandonPreparedBrowserWorkspaceDatabase(prepared)
    const objectStore = IDBTransaction.prototype.objectStore
    const accessedStores: string[] = []
    const accessSpy = vi
      .spyOn(IDBTransaction.prototype, 'objectStore')
      .mockImplementation(function (this: IDBTransaction, name) {
        accessedStores.push(name)
        return objectStore.call(this, name)
      })
    const databaseEnumeration = vi.spyOn(indexedDB, 'databases')

    await cleanPendingBrowserWorkspaceDatabase()

    expect(new Set(accessedStores)).toEqual(new Set(['compactionStates', 'manifests']))
    expect(databaseEnumeration).not.toHaveBeenCalled()
    accessSpy.mockRestore()
    databaseEnumeration.mockRestore()
  })

  it('rejects a cleanup acknowledgement that does not match the durable journal', async () => {
    const prepared = await beginBrowserWorkspaceDatabaseReplacement()
    await activatePreparedBrowserWorkspaceDatabase(prepared, storageBaseline)

    await expect(
      completeBrowserWorkspaceDatabaseCleanup({
        ...prepared,
        nonce: 'stale-nonce',
        phase: 'cleanup',
      }),
    ).rejects.toThrow('BrowserWorkspaceReplacementJournalChanged')
  })
})

async function prepareSelection(): Promise<void> {
  bootstrapAuthority = beginBrowserWorkspaceBootstrap()
  openingSelection = await prepareBrowserWorkspaceDatabaseSelection(bootstrapAuthority)
}

function openRawDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1)
    request.onupgradeneeded = () => request.result.createObjectStore('rows')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function databaseNames(): Promise<string[]> {
  return (await indexedDB.databases()).flatMap((database) =>
    database.name === undefined ? [] : [database.name],
  )
}
