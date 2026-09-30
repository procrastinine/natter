import type { Page } from '@playwright/test'
import { IDBDatabase, IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  installNativeWorkspaceStorageFixture,
  type NativeFixtureDatabase,
} from '../../scripts/native-workspace-storage-fixture.mjs'
import { holdIndexedDbStoreGate, readMessages } from '../e2e/helpers'

vi.mock('../e2e/fixtures', () => ({ expect: vi.fn() }))

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

const page = {
  evaluate: (callback: (argument: unknown) => unknown, argument: unknown) => callback(argument),
} as unknown as Page
const events: string[] = []
let factory: IDBFactory
let held: Set<string>
let queued: ReturnType<typeof deferred<void>>
let grant: ReturnType<typeof deferred<void>> | undefined
let manifestReads: string[][]

async function seed(
  name: string,
  stores: Record<string, { key: string; rows: unknown[]; indexes?: string[] }>,
) {
  const request = factory.open(name, 1)
  request.onupgradeneeded = () => {
    for (const [name, definition] of Object.entries(stores)) {
      const store = request.result.createObjectStore(name, { keyPath: definition.key })
      for (const index of definition.indexes ?? []) store.createIndex(index, index)
      for (const row of definition.rows) store.put(row)
    }
  }
  await new Promise<void>((resolve, reject) => {
    request.onsuccess = () => {
      request.result.close()
      resolve()
    }
    request.onerror = () => reject(request.error)
  })
}

async function select(databaseName: string, activationSequence: number) {
  const request = factory.open('natter-control')
  await new Promise<void>((resolve, reject) => {
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const database = request.result
      const transaction = database.transaction('manifests', 'readwrite')
      transaction
        .objectStore('manifests')
        .put({ id: 'workspace', activeDatabaseName: databaseName, activationSequence })
      transaction.oncomplete = () => {
        database.close()
        resolve()
      }
      transaction.onabort = () => {
        database.close()
        reject(transaction.error)
      }
    }
  })
}

beforeEach(async () => {
  factory = new IDBFactory()
  held = new Set()
  queued = deferred()
  grant = undefined
  manifestReads = []
  events.length = 0
  vi.stubGlobal('indexedDB', factory)
  vi.stubGlobal('navigator', {
    locks: {
      async request(
        name: string,
        options: { signal: AbortSignal },
        callback: () => Promise<unknown>,
      ) {
        expect(name).toMatch(/^natter:workspace-slot:/u)
        const barrier = grant
        grant = undefined
        queued.resolve()
        if (barrier) {
          await Promise.race([
            barrier.promise,
            new Promise((_, reject) => {
              if (options.signal.aborted) reject(options.signal.reason)
              else
                options.signal.addEventListener('abort', () => reject(options.signal.reason), {
                  once: true,
                })
            }),
          ])
        }
        options.signal.throwIfAborted()
        held.add(name)
        events.push(`held:${name}`)
        try {
          return await callback()
        } finally {
          held.delete(name)
          events.push(`released:${name}`)
        }
      },
    },
  })
  await seed('natter-control', {
    manifests: {
      key: 'id',
      rows: [{ id: 'workspace', activeDatabaseName: 'A', activationSequence: 1 }],
    },
  })
  for (const name of ['A', 'B'])
    await seed(name, {
      chats: { key: 'id', rows: [{ id: name }] },
      messages: {
        key: 'id',
        indexes: ['chatId'],
        rows: [
          {
            id: 'm',
            chatId: 'chat',
            parentId: null,
            createdAt: 1,
            siblingIndex: 0,
            nodeVersion: 1,
          },
        ],
      },
      messageBodies: {
        key: 'id',
        indexes: ['chatId'],
        rows: [
          { id: 'm', chatId: 'chat', content: [] },
          { id: 'poison', chatId: 'unrelated', content: [] },
        ],
      },
    })
  const originalGet = IDBObjectStore.prototype.get
  vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (
    this: IDBObjectStore,
    key,
  ) {
    if (this.name === 'manifests') manifestReads.push([...held])
    return originalGet.call(this, key)
  })
  const originalClose = IDBDatabase.prototype.close
  vi.spyOn(IDBDatabase.prototype, 'close').mockImplementation(function (this: IDBDatabase) {
    events.push(`closed:${this.name}`)
    return originalClose.call(this)
  })
  installNativeWorkspaceStorageFixture()
})

afterEach(() => {
  globalThis.__natterNativeStorageFixture.dispose()
  Reflect.deleteProperty(globalThis, '__natterNativeStorageFixture')
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('native workspace fixture custody', () => {
  it.each(['selection', 'ABA'] as const)(
    'confirms name and activation sequence after physical custody: %s',
    async (transition) => {
      const barrier = deferred()
      grant = barrier
      const callback = vi.fn(
        (database: NativeFixtureDatabase, _request: unknown, binding: unknown) => ({
          name: database.name,
          binding,
        }),
      )
      const pending = globalThis.__natterNativeStorageFixture.active(
        { purpose: 'read-only-assertion' },
        callback,
      )
      await queued.promise
      await select('B', 2)
      if (transition === 'ABA') await select('A', 3)
      barrier.resolve()
      const name = transition === 'ABA' ? 'A' : 'B'
      expect(await pending).toEqual({
        name,
        binding: { databaseName: name, activationSequence: transition === 'ABA' ? 3 : 2 },
      })
      expect(callback).toHaveBeenCalledTimes(1)
      expect(events.filter((event) => event.startsWith('held:'))).toEqual([
        'held:natter:workspace-slot:A',
        `held:natter:workspace-slot:${name}`,
      ])
      expect(manifestReads).toEqual([
        [],
        ['natter:workspace-slot:A'],
        [],
        [`natter:workspace-slot:${name}`],
      ])
      expect(held.size).toBe(0)
    },
  )

  it('uses the selected database for the actual hold helper and waits for transaction completion before release', async () => {
    const barrier = deferred()
    grant = barrier
    const originalTransaction = IDBDatabase.prototype.transaction
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (
      this: IDBDatabase,
      ...args
    ) {
      const transaction = originalTransaction.apply(this, args)
      if (this.name === 'B')
        transaction.addEventListener('complete', () => events.push('terminal:B'))
      return transaction
    })
    const pending = holdIndexedDbStoreGate(page, ['chats'])
    await queued.promise
    await select('B', 2)
    barrier.resolve()
    const release = await pending
    expect(held.has('natter:workspace-slot:B')).toBe(true)
    const first = release()
    expect(release()).toBe(first)
    await first
    expect(events.slice(-3)).toEqual(['terminal:B', 'closed:B', 'released:natter:workspace-slot:B'])
    expect(held.size).toBe(0)
  })

  it('closes and releases on synchronous transaction construction failure and asynchronous callback failure', async () => {
    await expect(
      globalThis.__natterNativeStorageFixture.active(
        { purpose: 'read-only-assertion' },
        (database) => database.transaction('missing'),
      ),
    ).rejects.toMatchObject({ name: 'NotFoundError' })
    expect(events.slice(-2)).toEqual(['closed:A', 'released:natter:workspace-slot:A'])
    const failure = new Error('callback failed')
    await expect(
      globalThis.__natterNativeStorageFixture.active(
        { purpose: 'fault-injection' },
        async (database) => {
          const transaction = database.transaction('chats', 'readwrite')
          transaction.addEventListener('abort', () => events.push('abort:A'))
          transaction.objectStore('chats').put({ id: 'uncommitted' })
          throw failure
        },
      ),
    ).rejects.toBe(failure)
    expect(events.slice(-3)).toEqual(['abort:A', 'closed:A', 'released:natter:workspace-slot:A'])
  })

  it('projects the exact owned completion promise and rejects a foreign transaction', async () => {
    let foreign!: IDBTransaction
    await globalThis.__natterNativeStorageFixture.active(
      { purpose: 'read-only-assertion' },
      (database) => {
        foreign = database.transaction('chats')
      },
    )
    await globalThis.__natterNativeStorageFixture.active(
      { purpose: 'read-only-assertion' },
      async (database) => {
        expect(() => database.completion(foreign)).toThrow('NativeFixtureTransactionNotOwned')
        const transaction = database.transaction('chats')
        transaction.addEventListener('complete', () => events.push('terminal:A'))
        const terminal = database.completion(transaction)
        expect(database.completion(transaction)).toBe(terminal)
        await terminal
        expect(events.at(-1)).toBe('terminal:A')
        expect(held.has('natter:workspace-slot:A')).toBe(true)
      },
    )
    expect(events.slice(-3)).toEqual(['terminal:A', 'closed:A', 'released:natter:workspace-slot:A'])
    expect(held.size).toBe(0)
  })

  it('drains request promises created before a synchronous callback failure', async () => {
    const failure = new Error('callback failed after requests started')
    await expect(
      globalThis.__natterNativeStorageFixture.active(
        { purpose: 'read-only-assertion' },
        (database, request) => {
          const transaction = database.transaction('chats')
          transaction.addEventListener('abort', () => events.push('abort:A'))
          void request(transaction.objectStore('chats').get('A'))
          void request(transaction.objectStore('chats').get('B'))
          throw failure
        },
      ),
    ).rejects.toBe(failure)
    expect(events.slice(-3)).toEqual(['abort:A', 'closed:A', 'released:natter:workspace-slot:A'])
    expect(held.size).toBe(0)
  })

  it('a failed transaction interrupts callback waiting and releases its physical lease', async () => {
    await expect(
      globalThis.__natterNativeStorageFixture.active(
        { purpose: 'fault-injection' },
        (database, request) => {
          const transaction = database.transaction('chats', 'readwrite')
          transaction.addEventListener('abort', () => events.push('abort:A'))
          void request(transaction.objectStore('chats').add({ id: 'A' }))
          return new Promise(() => {})
        },
      ),
    ).rejects.toMatchObject({ name: 'ConstraintError' })
    expect(events.slice(-3)).toEqual(['abort:A', 'closed:A', 'released:natter:workspace-slot:A'])
    expect(held.size).toBe(0)
  })

  it('cancels an unresolved callback and rejects late transaction admission', async () => {
    const controller = new AbortController()
    const entered = deferred<NativeFixtureDatabase>()
    const continuation = deferred()
    const pending = globalThis.__natterNativeStorageFixture.active(
      { purpose: 'read-only-assertion', signal: controller.signal },
      async (database) => {
        entered.resolve(database)
        await continuation.promise
        database.transaction('chats')
      },
    )
    const database = await entered.promise
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(() => database.transaction('chats')).toThrow('NativeFixtureOperationClosed')
    expect(held.size).toBe(0)
    continuation.resolve()
  })

  it('never recreates missing active or named databases', async () => {
    await select('missing', 2)
    await expect(
      globalThis.__natterNativeStorageFixture.active(
        { purpose: 'read-only-assertion' },
        () => undefined,
      ),
    ).rejects.toThrow('NativeFixtureDatabaseMissing:missing')
    await expect(
      globalThis.__natterNativeStorageFixture.observeNamed(
        { purpose: 'read-only-assertion', databaseName: 'retired' },
        () => undefined,
      ),
    ).rejects.toThrow('NativeFixtureDatabaseMissing:retired')
    expect((await factory.databases()).map((database) => database.name)).toEqual(
      expect.not.arrayContaining(['missing', 'retired']),
    )
    expect(held.size).toBe(0)
  })

  it.each(['blocked', 'cancelled'] as const)(
    'keeps custody of late native open events after %s',
    async (outcome) => {
      const close = vi.fn()
      const abort = vi.fn()
      const native = {
        result: { close },
        transaction: { abort },
        onsuccess: null,
        onerror: null,
        onblocked: null,
        onupgradeneeded: null,
      } as unknown as IDBOpenDBRequest
      vi.spyOn(factory, 'open').mockReturnValue(native)
      const controller = new AbortController()
      const upgrade = vi.fn()
      const pending = globalThis.__natterNativeStorageFixture.offline(
        {
          purpose: 'legacy-fixture',
          databaseName: 'legacy',
          version: 1,
          signal: controller.signal,
          upgrade,
        },
        () => undefined,
      )
      if (outcome === 'blocked')
        native.onblocked?.call(native, new Event('blocked') as IDBVersionChangeEvent)
      else controller.abort()
      await expect(pending).rejects.toBeDefined()
      native.onupgradeneeded?.call(native, new Event('upgradeneeded') as IDBVersionChangeEvent)
      expect(upgrade).not.toHaveBeenCalled()
      expect(abort).toHaveBeenCalledOnce()
      native.onsuccess?.call(native, new Event('success'))
      expect(close).toHaveBeenCalledOnce()
    },
  )

  it('reports a request error even when its default transaction abort is prevented', async () => {
    await expect(
      globalThis.__natterNativeStorageFixture.active({ purpose: 'fault-injection' }, (database) => {
        const transaction = database.transaction('chats', 'readwrite')
        const request = transaction.objectStore('chats').add({ id: 'A' })
        request.addEventListener('error', (event) => event.preventDefault())
      }),
    ).rejects.toMatchObject({ name: 'ConstraintError' })
    expect(events.slice(-2)).toEqual(['closed:A', 'released:natter:workspace-slot:A'])
  })

  it('reads only the requested chat bodies through the actual message helper', async () => {
    const getAll = IDBObjectStore.prototype.getAll
    vi.spyOn(IDBObjectStore.prototype, 'getAll').mockImplementation(function (
      this: IDBObjectStore,
      ...args
    ) {
      if (this.name === 'messageBodies') throw new Error('unbounded body read')
      return getAll.apply(this, args)
    })
    expect((await readMessages(page, 'chat')).map((row) => row.id)).toEqual(['m'])
  })
})
