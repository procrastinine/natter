import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type OriginStorageWipeReport, wipeOriginStorage } from '../../src/lib/storage-wipe'
import {
  awaitStorageAdministrationReady,
  StorageAdministration,
  type StorageAdministrationBarrier,
  type StorageAdministrationMessage,
  type StorageAdministrationTransport,
} from '../../src/store/storage-administration'

async function openRawDb(name: string, version = 1): Promise<IDBDatabase> {
  const request = indexedDB.open(name, version)
  return new Promise((resolve, reject) => {
    request.onupgradeneeded = () => request.result.createObjectStore('rows')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

const EMPTY_REPORT: OriginStorageWipeReport = {
  deletedDatabaseNames: [],
  deletedCacheNames: [],
  deletedOpfsEntryNames: [],
  deletedStorageBucketNames: [],
  unregisteredServiceWorkerScopes: [],
}

const originalStorageDescriptor = Object.getOwnPropertyDescriptor(navigator, 'storage')
const originalStorageBucketsDescriptor = Object.getOwnPropertyDescriptor(
  navigator,
  'storageBuckets',
)

function setNavigatorCapability(name: 'storage' | 'storageBuckets', value: unknown): void {
  Object.defineProperty(navigator, name, { configurable: true, value })
}

function restoreNavigatorCapability(
  name: 'storage' | 'storageBuckets',
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) Object.defineProperty(navigator, name, descriptor)
  else Reflect.deleteProperty(navigator, name)
}

describe('wipeOriginStorage', () => {
  beforeEach(() => {
    ;(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory()
    localStorage.clear()
    sessionStorage.clear()
  })

  afterEach(() => {
    restoreNavigatorCapability('storage', originalStorageDescriptor)
    restoreNavigatorCapability('storageBuckets', originalStorageBucketsDescriptor)
  })

  it('physically deletes every enumerated database plus the known Natter database', async () => {
    const natter = await openRawDb('natter')
    const auxiliary = await openRawDb('natter-auxiliary')
    natter.close()
    auxiliary.close()
    localStorage.setItem('local-probe', 'value')
    sessionStorage.setItem('session-probe', 'value')

    const report = await wipeOriginStorage()

    expect(report.deletedDatabaseNames).toEqual([
      'natter',
      'natter-auxiliary',
      'natter-control',
      'natter-workspace-a',
      'natter-workspace-b',
    ])
    expect(await indexedDB.databases()).toEqual([])
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })

  it('clears and verifies OPFS plus every named Storage Bucket when the browser exposes them', async () => {
    const opfsEntries = new Map<string, unknown>([
      ['sstables', {}],
      ['attachments', {}],
    ])
    const removeEntry = vi.fn(async (name: string, options?: { recursive?: boolean }) => {
      expect(options).toEqual({ recursive: true })
      opfsEntries.delete(name)
    })
    const root = {
      async *entries(): AsyncIterableIterator<[string, unknown]> {
        yield* opfsEntries.entries()
      },
      removeEntry,
    }
    const storageBuckets = new Set(['cold-cache', 'legacy-workspace'])
    const deleteBucket = vi.fn(async (name: string) => {
      storageBuckets.delete(name)
    })
    setNavigatorCapability('storage', { getDirectory: async () => root })
    setNavigatorCapability('storageBuckets', {
      keys: async () => [...storageBuckets],
      delete: deleteBucket,
    })

    const report = await wipeOriginStorage()

    expect(report.deletedOpfsEntryNames).toEqual(['attachments', 'sstables'])
    expect(report.deletedStorageBucketNames).toEqual(['cold-cache', 'legacy-workspace'])
    expect(removeEntry).toHaveBeenCalledTimes(2)
    expect(deleteBucket).toHaveBeenCalledTimes(2)
    expect(opfsEntries.size).toBe(0)
    expect(storageBuckets.size).toBe(0)
  })

  it('fails verification instead of claiming that a named Storage Bucket was erased', async () => {
    setNavigatorCapability('storageBuckets', {
      keys: async () => ['undeleted-bucket'],
      delete: async () => {},
    })

    await expect(wipeOriginStorage()).rejects.toThrow(
      'StorageBucketDeleteVerificationFailed:undeleted-bucket',
    )
  })

  it('drains every admitted destructive operation before reporting one sibling failure', async () => {
    const buckets = new Set(['failed-bucket', 'slow-bucket'])
    const slowDelete = deferred<void>()
    const deleteBucket = vi.fn(async (name: string) => {
      if (name === 'failed-bucket') {
        buckets.delete(name)
        throw new Error('StorageBucketDeleteFailed:failed-bucket')
      }
      await slowDelete.promise
      buckets.delete(name)
    })
    setNavigatorCapability('storageBuckets', {
      keys: async () => [...buckets],
      delete: deleteBucket,
    })
    let settled = false
    const wiping = wipeOriginStorage()
    void wiping.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )

    await vi.waitFor(() => expect(deleteBucket).toHaveBeenCalledTimes(2))
    expect(settled).toBe(false)

    slowDelete.resolve(undefined)
    await expect(wiping).rejects.toThrow('StorageBucketDeleteFailed:failed-bucket')
    expect(settled).toBe(true)
    expect(buckets.size).toBe(0)
  })

  it('fails visibly instead of claiming success while another connection blocks deletion', async () => {
    const otherTab = await openRawDb('natter')
    otherTab.onversionchange = () => {}

    await expect(wipeOriginStorage()).rejects.toThrow('IndexedDBDeleteBlocked:natter')

    otherTab.close()
  })

  it('treats a database recreated after quiescence as an ownership invariant violation', async () => {
    const enumerate = indexedDB.databases.bind(indexedDB)
    vi.spyOn(indexedDB, 'databases')
      .mockImplementationOnce(enumerate)
      .mockResolvedValueOnce([{ name: 'recreated-after-delete', version: 1 }])

    await expect(wipeOriginStorage()).rejects.toThrow(
      'IndexedDBDeleteOwnershipInvariantViolated:recreated-after-delete',
    )
  })
})

describe('StorageAdministration', () => {
  it('quiesces every registered tab before entering the physical wipe', async () => {
    const events: string[] = []
    const bus = new TestStorageAdministrationBus()
    const barrier = new TestStorageAdministrationBarrier(2, events)
    const firstReload = vi.fn()
    const secondReload = vi.fn()
    const first = new StorageAdministration({
      clientId: 'first-tab',
      transport: bus.endpoint('first-tab'),
      barrier: barrier.handle('first-tab'),
      quiesce: async () => {
        events.push('first-tab:quiesce')
      },
      terminalize: async () => {
        events.push('first-tab:presentation-suspended')
        events.push('first-tab:seal')
      },
      resume: async () => {
        events.push('first-tab:resume')
      },
      wipe: async () => {
        events.push('wipe')
        return EMPTY_REPORT
      },
      recreateAndVerify: async () => {
        events.push('recreate-and-verify')
      },
      clearSessionStorage: () => events.push('first-tab:session-cleared'),
      reload: firstReload,
    })
    const second = new StorageAdministration({
      clientId: 'second-tab',
      transport: bus.endpoint('second-tab'),
      barrier: barrier.handle('second-tab'),
      quiesce: async () => {
        events.push('second-tab:quiesce')
      },
      terminalize: async () => {
        events.push('second-tab:presentation-suspended')
        events.push('second-tab:seal')
      },
      resume: async () => {
        events.push('second-tab:resume')
      },
      wipe: async () => {
        throw new Error('remote tab must not wipe')
      },
      recreateAndVerify: async () => {
        throw new Error('remote tab must not recreate')
      },
      clearSessionStorage: () => events.push('second-tab:session-cleared'),
      reload: secondReload,
    })
    first.installResponder()
    second.installResponder()
    await Promise.all([first.ready(), second.ready()])

    await first.clearAll({ skipReload: true })

    expect(events.indexOf('first-tab:released')).toBeLessThan(events.indexOf('wipe'))
    expect(events.indexOf('second-tab:released')).toBeLessThan(events.indexOf('wipe'))
    expect(events.indexOf('first-tab:presentation-suspended')).toBeLessThan(
      events.indexOf('first-tab:seal'),
    )
    expect(events.indexOf('second-tab:presentation-suspended')).toBeLessThan(
      events.indexOf('second-tab:seal'),
    )
    expect(events.indexOf('first-tab:seal')).toBeLessThan(events.indexOf('wipe'))
    expect(events.indexOf('wipe')).toBeLessThan(events.indexOf('recreate-and-verify'))
    expect(firstReload).not.toHaveBeenCalled()
    expect(secondReload).toHaveBeenCalledOnce()
  })

  it('cancels before commit, resumes the workspace, and rearms presence', async () => {
    const events: string[] = []
    let readyCount = 0
    const reload = vi.fn()
    const admin = new StorageAdministration({
      clientId: 'only-tab',
      transport: new TestStorageAdministrationBus().endpoint('only-tab'),
      barrier: {
        ready: async () => {
          readyCount += 1
          events.push('presence-ready')
        },
        releasePresence: async () => {
          events.push('presence-released')
        },
        runExclusive: async () => {
          throw new Error('StorageAdministrationExclusiveTimedOut')
        },
      },
      quiesce: async () => {
        events.push('quiesce')
      },
      terminalize: async () => {
        events.push('presentation-suspended')
        events.push('seal')
      },
      resume: async () => {
        events.push('resume')
      },
      wipe: async () => EMPTY_REPORT,
      recreateAndVerify: async () => {
        events.push('recreate-and-verify')
      },
      clearSessionStorage: () => events.push('session-cleared'),
      reload,
    })

    await expect(admin.clearAll({ skipReload: true })).rejects.toThrow(
      'StorageAdministrationPhaseTimedOut:exclusive-acquire',
    )

    expect(events).toEqual([
      'presence-ready',
      'quiesce',
      'presence-released',
      'presence-ready',
      'resume',
    ])
    expect(readyCount).toBe(2)
    expect(reload).not.toHaveBeenCalled()
  })

  it('classifies failures after commit as terminal and forces a reload', async () => {
    const bus = new TestStorageAdministrationBus()
    const reload = vi.fn()
    const resume = vi.fn(async () => {})
    const admin = new StorageAdministration({
      clientId: 'only-tab',
      transport: bus.endpoint('only-tab'),
      barrier: {
        ready: async () => {},
        releasePresence: async () => {},
        runExclusive: async (operation) => operation(),
      },
      quiesce: async () => {},
      terminalize: async () => {},
      resume,
      wipe: async () => {
        throw new Error('wipe exploded')
      },
      recreateAndVerify: async () => {},
      clearSessionStorage: () => {},
      reload,
    })

    await expect(admin.clearAll({ skipReload: true })).rejects.toThrow(
      'StorageAdministrationPhaseFailed:origin-storage-wipe:wipeexploded',
    )

    expect(bus.messages.map((message) => message.kind)).toEqual([
      'wipe-request',
      'wipe-commit',
      'wipe-committed-failure',
    ])
    expect(resume).not.toHaveBeenCalled()
    expect(reload).toHaveBeenCalledOnce()
  })

  it('does not detach a non-abortable precommit quiesce behind a phase timeout', async () => {
    vi.useFakeTimers()
    try {
      const bus = new TestStorageAdministrationBus()
      const events: string[] = []
      const quiesce = deferred<void>()
      const wipe = vi.fn(async () => {
        events.push('wipe')
        return EMPTY_REPORT
      })
      const reload = vi.fn()
      const admin = new StorageAdministration({
        clientId: 'only-tab',
        transport: bus.endpoint('only-tab'),
        barrier: {
          ready: async () => {
            events.push('presence-ready')
          },
          releasePresence: async () => {
            events.push('presence-released')
          },
          runExclusive: async (operation) => operation(),
        },
        quiesce: async () => {
          events.push('quiesce-start')
          await quiesce.promise
          events.push('quiesce-settled')
        },
        terminalize: async () => {
          events.push('presentation-suspended')
          events.push('seal')
        },
        resume: async () => {},
        wipe,
        recreateAndVerify: async () => {
          events.push('verify')
        },
        clearSessionStorage: () => {},
        reload,
      })

      const clearing = admin.clearAll({ skipReload: true, phaseTimeoutMs: 10 })
      await vi.advanceTimersByTimeAsync(100)

      expect(events).toEqual(['presence-ready', 'quiesce-start'])
      expect(wipe).not.toHaveBeenCalled()
      expect(bus.messages.map((message) => message.kind)).toEqual(['wipe-request'])

      quiesce.resolve(undefined)
      await expect(clearing).resolves.toEqual(EMPTY_REPORT)

      expect(events).toEqual([
        'presence-ready',
        'quiesce-start',
        'quiesce-settled',
        'presence-released',
        'presentation-suspended',
        'seal',
        'wipe',
        'verify',
      ])
      expect(bus.messages.map((message) => message.kind)).toEqual([
        'wipe-request',
        'wipe-commit',
        'wipe-complete',
      ])
      expect(reload).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('awaits committed wipe and verification instead of detaching them at a deadline', async () => {
    vi.useFakeTimers()
    try {
      const bus = new TestStorageAdministrationBus()
      const wipe = deferred<OriginStorageWipeReport>()
      const verify = deferred<void>()
      const events: string[] = []
      const reload = vi.fn()
      const admin = new StorageAdministration({
        clientId: 'only-tab',
        transport: bus.endpoint('only-tab'),
        barrier: {
          ready: async () => {},
          releasePresence: async () => {},
          runExclusive: async (operation) => operation(),
        },
        quiesce: async () => {},
        terminalize: async () => {
          events.push('presentation-suspended')
          events.push('sealed')
        },
        resume: async () => {},
        wipe: async () => {
          events.push('wipe-start')
          return wipe.promise
        },
        recreateAndVerify: async () => {
          events.push('verify-start')
          await verify.promise
          events.push('verify-settled')
        },
        clearSessionStorage: () => {},
        reload,
      })

      const clearing = admin.clearAll({ skipReload: true, committedLeaseMs: 10 })
      await vi.advanceTimersByTimeAsync(100)

      expect(events).toEqual(['presentation-suspended', 'sealed', 'wipe-start'])
      expect(reload).not.toHaveBeenCalled()
      expect(bus.messages.map((message) => message.kind)).toEqual(['wipe-request', 'wipe-commit'])

      wipe.resolve(EMPTY_REPORT)
      await vi.advanceTimersByTimeAsync(100)
      expect(events).toEqual(['presentation-suspended', 'sealed', 'wipe-start', 'verify-start'])
      expect(reload).not.toHaveBeenCalled()

      verify.resolve(undefined)
      await expect(clearing).resolves.toEqual(EMPTY_REPORT)
      expect(events.at(-1)).toBe('verify-settled')
      expect(bus.messages.map((message) => message.kind)).toEqual([
        'wipe-request',
        'wipe-commit',
        'wipe-complete',
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds remote precommit ownership and resumes when its initiator disappears', async () => {
    vi.useFakeTimers()
    try {
      const bus = new TestStorageAdministrationBus()
      const events: string[] = []
      const reload = vi.fn()
      const admin = new StorageAdministration({
        clientId: 'remote-tab',
        transport: bus.endpoint('remote-tab'),
        barrier: {
          ready: async () => {
            events.push('presence-ready')
          },
          releasePresence: async () => {
            events.push('presence-released')
          },
          runExclusive: async (operation) => operation(),
        },
        quiesce: async () => {
          events.push('quiesce')
        },
        terminalize: async () => {
          events.push('presentation-suspended')
          events.push('seal')
        },
        resume: async () => {
          events.push('resume')
        },
        wipe: async () => EMPTY_REPORT,
        recreateAndVerify: async () => {},
        clearSessionStorage: () => events.push('session-cleared'),
        reload,
      })
      admin.installResponder()
      await admin.ready()
      const initiator = bus.endpoint('initiator')

      initiator.post({
        kind: 'wipe-request',
        requestId: 'abandoned',
        senderId: 'initiator',
        deadlineAt: Date.now() + 100,
      })
      await vi.advanceTimersByTimeAsync(0)
      initiator.post({
        kind: 'wipe-request',
        requestId: 'competing',
        senderId: 'initiator',
        deadlineAt: Date.now() + 100,
      })

      expect(
        bus.messages.some(
          (message) =>
            message.kind === 'wipe-rejected' &&
            message.requestId === 'competing' &&
            message.code === 'StorageWipeBusy',
        ),
      ).toBe(true)
      expect(events.filter((event) => event === 'quiesce')).toHaveLength(1)

      await vi.advanceTimersByTimeAsync(100)

      expect(events).toContain('resume')
      expect(events.filter((event) => event === 'presence-ready')).toHaveLength(2)
      expect(reload).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reloads a sealed remote tab when a committed initiator disappears', async () => {
    vi.useFakeTimers()
    try {
      const bus = new TestStorageAdministrationBus()
      const events: string[] = []
      const reload = vi.fn()
      const admin = new StorageAdministration({
        clientId: 'remote-tab',
        transport: bus.endpoint('remote-tab'),
        barrier: {
          ready: async () => {},
          releasePresence: async () => {},
          runExclusive: async (operation) => operation(),
        },
        quiesce: async () => {
          events.push('quiesce')
        },
        terminalize: async () => {
          events.push('presentation-suspended')
          events.push('seal')
        },
        resume: async () => {
          events.push('resume')
        },
        wipe: async () => EMPTY_REPORT,
        recreateAndVerify: async () => {},
        clearSessionStorage: () => events.push('session-cleared'),
        reload,
      })
      admin.installResponder()
      const initiator = bus.endpoint('initiator')
      initiator.post({
        kind: 'wipe-request',
        requestId: 'committed',
        senderId: 'initiator',
        deadlineAt: Date.now() + 1_000,
      })
      await vi.advanceTimersByTimeAsync(0)
      initiator.post({
        kind: 'wipe-commit',
        requestId: 'committed',
        senderId: 'initiator',
        deadlineAt: Date.now() + 100,
      })
      await vi.advanceTimersByTimeAsync(0)

      expect(events).toContain('seal')
      expect(events).toContain('session-cleared')
      await vi.advanceTimersByTimeAsync(100)

      expect(reload).toHaveBeenCalledOnce()
      expect(events).not.toContain('resume')
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails closed when Web Locks are unavailable', async () => {
    const locks = Object.getOwnPropertyDescriptor(navigator, 'locks')
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined })
    try {
      await expect(awaitStorageAdministrationReady()).rejects.toThrow(
        'StorageAdministrationWebLocksRequired',
      )
    } finally {
      if (locks) Object.defineProperty(navigator, 'locks', locks)
      else Reflect.deleteProperty(navigator, 'locks')
    }
  })
})

class TestStorageAdministrationBus {
  readonly messages: StorageAdministrationMessage[] = []
  private readonly listeners = new Map<
    string,
    Set<(message: StorageAdministrationMessage) => void>
  >()

  endpoint(clientId: string): StorageAdministrationTransport {
    return {
      subscribe: (listener) => {
        const listeners = this.listeners.get(clientId) ?? new Set()
        listeners.add(listener)
        this.listeners.set(clientId, listeners)
        return () => listeners.delete(listener)
      },
      post: (message) => {
        this.messages.push(message)
        for (const [targetId, listeners] of this.listeners) {
          if (targetId === clientId) continue
          for (const listener of [...listeners]) listener(message)
        }
      },
    }
  }
}

function deferred<T>(): {
  readonly promise: Promise<T>
  resolve(value: T): void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

class TestStorageAdministrationBarrier {
  private remaining: number
  private releaseAll: (() => void) | null = null
  private readonly allReleased: Promise<void>
  private readonly events: string[]

  constructor(count: number, events: string[]) {
    this.remaining = count
    this.events = events
    this.allReleased = new Promise((resolve) => {
      this.releaseAll = resolve
    })
  }

  handle(clientId: string): StorageAdministrationBarrier {
    let released = false
    return {
      ready: () => Promise.resolve(),
      releasePresence: async () => {
        if (released) return
        released = true
        this.events.push(`${clientId}:released`)
        this.remaining -= 1
        if (this.remaining === 0) this.releaseAll?.()
      },
      runExclusive: async (operation) => {
        await this.allReleased
        return operation()
      },
    }
  }
}
