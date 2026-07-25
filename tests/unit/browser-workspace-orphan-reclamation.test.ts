import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NATTER_INDEXED_DATABASE_NAMES } from '../../src/lib/origin-storage-names'
import {
  activatePreparedBrowserWorkspaceDatabase,
  beginBrowserWorkspaceDatabaseReplacement,
  completeBrowserWorkspaceDatabaseCleanup,
  readBrowserWorkspaceDatabaseManifest,
} from '../../src/store/browser-workspace-database-control'
import { reclaimInactiveBrowserWorkspaceDatabases } from '../../src/store/browser-workspace-orphan-reclamation'
import { __resetBrowserWorkspaceSlotCoordinatorForTests } from '../../src/store/browser-workspace-slot-coordination'

const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks')
const storageBaseline = { kind: 'reset', liveBytes: 0 } as const

class ControllableLockManager {
  selectionBusy = false
  readonly busySlots = new Set<string>()
  beforeSlotAcquired: ((name: string) => Promise<void>) | null = null

  request<T>(
    name: string,
    options: { mode: 'shared' | 'exclusive'; ifAvailable?: boolean },
    callback: (lock: Lock | null) => Promise<T> | T,
  ): Promise<T> {
    const unavailable =
      options.ifAvailable === true && (this.selectionBusy || this.busySlots.has(name))
    return Promise.resolve()
      .then(async () => {
        if (!unavailable && name.startsWith('natter:workspace-slot:')) {
          await this.beforeSlotAcquired?.(name)
        }
      })
      .then(() => callback(unavailable ? null : { name, mode: options.mode }))
  }
}

async function createDatabase(name: string): Promise<void> {
  const db = new Dexie(name)
  db.version(1).stores({ rows: '&id' })
  try {
    await db.table('rows').put({ id: 'retained-proof' })
  } finally {
    db.close()
  }
}

async function deleteAllDatabases(): Promise<void> {
  for (const name of NATTER_INDEXED_DATABASE_NAMES) await Dexie.delete(name)
}

describe('inactive browser workspace database reclamation', () => {
  let locks: ControllableLockManager

  beforeEach(async () => {
    __resetBrowserWorkspaceSlotCoordinatorForTests()
    await deleteAllDatabases()
    locks = new ControllableLockManager()
    Object.defineProperty(navigator, 'locks', { configurable: true, value: locks })
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    __resetBrowserWorkspaceSlotCoordinatorForTests()
    await deleteAllDatabases()
    if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks)
    else Reflect.deleteProperty(navigator, 'locks')
  })

  it('deletes only inactive registered slots without opening workspace tables or deleting active and control databases', async () => {
    await Promise.all([
      createDatabase('natter'),
      createDatabase('natter-workspace-a'),
      createDatabase('natter-workspace-b'),
    ])
    const objectStore = IDBTransaction.prototype.objectStore
    const accessedStores: string[] = []
    const accessSpy = vi
      .spyOn(IDBTransaction.prototype, 'objectStore')
      .mockImplementation(function (this: IDBTransaction, name) {
        accessedStores.push(name)
        return objectStore.call(this, name)
      })

    await expect(reclaimInactiveBrowserWorkspaceDatabases()).resolves.toEqual({
      status: 'swept',
      activeDatabaseName: 'natter',
      deleted: ['natter-workspace-a', 'natter-workspace-b'],
      skipped: [],
      failed: [],
    })
    accessSpy.mockRestore()
    expect(new Set(accessedStores)).toEqual(new Set(['compactionStates', 'manifests']))

    expect(await Dexie.exists('natter-control')).toBe(true)
    expect(await Dexie.exists('natter')).toBe(true)
    expect(await Dexie.exists('natter-workspace-a')).toBe(false)
    expect(await Dexie.exists('natter-workspace-b')).toBe(false)
  })

  it('skips an active peer slot and reclaims it on a later explicit retention pass', async () => {
    await Promise.all([
      createDatabase('natter'),
      createDatabase('natter-workspace-a'),
      createDatabase('natter-workspace-b'),
    ])
    locks.busySlots.add('natter:workspace-slot:natter-workspace-a')

    await expect(reclaimInactiveBrowserWorkspaceDatabases()).resolves.toMatchObject({
      status: 'swept',
      deleted: ['natter-workspace-b'],
      skipped: ['natter-workspace-a'],
      failed: [],
    })
    expect(await Dexie.exists('natter-workspace-a')).toBe(true)

    locks.busySlots.clear()
    await expect(reclaimInactiveBrowserWorkspaceDatabases()).resolves.toMatchObject({
      status: 'swept',
      deleted: ['natter-workspace-a', 'natter-workspace-b'],
      skipped: [],
      failed: [],
    })
    expect(await Dexie.exists('natter-workspace-a')).toBe(false)
  })

  it('does no slot work while a durable replacement journal is pending', async () => {
    await Promise.all([
      createDatabase('natter'),
      createDatabase('natter-workspace-a'),
      createDatabase('natter-workspace-b'),
    ])
    const pending = await beginBrowserWorkspaceDatabaseReplacement()

    await expect(reclaimInactiveBrowserWorkspaceDatabases()).resolves.toEqual({
      status: 'replacement-pending',
      activeDatabaseName: 'natter',
      pendingPhase: pending.phase,
    })
    expect(await Dexie.exists('natter')).toBe(true)
    expect(await Dexie.exists('natter-workspace-a')).toBe(true)
    expect(await Dexie.exists('natter-workspace-b')).toBe(true)
  })

  it('revalidates after the slot lock and never deletes a candidate that became active', async () => {
    await Promise.all([
      createDatabase('natter'),
      createDatabase('natter-workspace-a'),
      createDatabase('natter-workspace-b'),
    ])
    locks.beforeSlotAcquired = async (name) => {
      if (name !== 'natter:workspace-slot:natter-workspace-a') return
      locks.beforeSlotAcquired = null
      const preparing = await beginBrowserWorkspaceDatabaseReplacement()
      const activated = await activatePreparedBrowserWorkspaceDatabase(preparing, storageBaseline)
      if (activated.pending?.phase !== 'cleanup') {
        throw new Error('CleanupJournalMissing')
      }
      await completeBrowserWorkspaceDatabaseCleanup(activated.pending)
    }

    await expect(reclaimInactiveBrowserWorkspaceDatabases()).resolves.toMatchObject({
      status: 'swept',
      deleted: ['natter-workspace-b'],
      skipped: ['natter-workspace-a'],
      failed: [],
    })
    expect((await readBrowserWorkspaceDatabaseManifest()).activeDatabaseName).toBe(
      'natter-workspace-a',
    )
    expect(await Dexie.exists('natter-workspace-a')).toBe(true)
    expect(await Dexie.exists('natter-workspace-b')).toBe(false)
  })

  it('returns immediately without reading or deleting when selection is in progress', async () => {
    await Promise.all([
      createDatabase('natter'),
      createDatabase('natter-workspace-a'),
      createDatabase('natter-workspace-b'),
    ])
    locks.selectionBusy = true

    await expect(reclaimInactiveBrowserWorkspaceDatabases()).resolves.toEqual({
      status: 'selection-busy',
    })
    expect(await Dexie.exists('natter-control')).toBe(false)
    expect(await Dexie.exists('natter-workspace-a')).toBe(true)
    expect(await Dexie.exists('natter-workspace-b')).toBe(true)
  })

  it('contains a delete failure to the failed slot without poisoning other reclamation', async () => {
    await Promise.all([
      createDatabase('natter'),
      createDatabase('natter-workspace-a'),
      createDatabase('natter-workspace-b'),
    ])
    const deleteDatabase = Dexie.delete.bind(Dexie)
    vi.spyOn(Dexie, 'delete').mockImplementation((name) =>
      name === 'natter-workspace-a'
        ? Promise.reject(new DOMException('delete unavailable', 'UnknownError'))
        : deleteDatabase(name),
    )

    await expect(reclaimInactiveBrowserWorkspaceDatabases()).resolves.toMatchObject({
      status: 'swept',
      deleted: ['natter-workspace-b'],
      skipped: [],
      failed: [
        {
          databaseName: 'natter-workspace-a',
          reason: 'UnknownError: delete unavailable',
        },
      ],
    })
    expect(await Dexie.exists('natter-workspace-a')).toBe(true)
    expect(await Dexie.exists('natter-workspace-b')).toBe(false)
    expect((await readBrowserWorkspaceDatabaseManifest()).activeDatabaseName).toBe('natter')
  })
})
