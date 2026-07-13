import { act, render, screen } from '@testing-library/react'
import Dexie, { type ObservabilitySet, RangeSet } from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  RepositoryMutationSubscriber,
  RepositoryQueryDependency,
  RepositoryQuerySnapshot,
} from '../../src/store/reactive-query'
import {
  __setRepositoryMutationSubscriberForTests,
  useRepositoryQueryState,
} from '../../src/store/reactive-query'
import { runWithLocalWriteActivity } from '../../src/store/transaction-activity'

const DATABASE_NAME = 'natter-test'
const WATCHED_SETTING = 'watched'
const SETTINGS_DEPENDENCY = Object.freeze([
  { table: 'settings', keys: [WATCHED_SETTING] },
]) satisfies readonly RepositoryQueryDependency[]
const EMPTY_DEPENDENCIES: readonly RepositoryQueryDependency[] = Object.freeze([])

const mutationHarness = vi.hoisted(() => {
  const listeners = new Set<(parts: ObservabilitySet) => void>()
  let subscriptions = 0
  let unsubscriptions = 0
  const subscribe: RepositoryMutationSubscriber = (listener) => {
    subscriptions += 1
    listeners.add(listener)
    return () => {
      unsubscriptions += 1
      listeners.delete(listener)
    }
  }
  return {
    subscribe,
    emit(parts: ObservabilitySet) {
      for (const listener of [...listeners]) listener(parts)
    },
    reset() {
      listeners.clear()
      subscriptions = 0
      unsubscriptions = 0
    },
    subscriptionCount: () => subscriptions,
    unsubscriptionCount: () => unsubscriptions,
    listenerCount: () => listeners.size,
  }
})

const snapshots: Array<RepositoryQuerySnapshot<string>> = []
const pairedSnapshots: string[] = []

beforeEach(() => {
  snapshots.length = 0
  pairedSnapshots.length = 0
  mutationHarness.reset()
  __setRepositoryMutationSubscriberForTests(mutationHarness.subscribe, DATABASE_NAME)
})

afterEach(() => {
  __setRepositoryMutationSubscriberForTests(undefined)
})

describe('repository reactive query adapter', () => {
  it('shares one immutable changefeed subscription and ref-counts same-key consumers', async () => {
    const query = vi.fn(async () => 'ready')
    const view = render(
      <>
        <StateProbe id="first" queryKey="shared" query={query} />
        <StateProbe id="second" queryKey="shared" query={query} />
      </>,
    )

    expect(mutationHarness.subscriptionCount()).toBe(1)
    expect(screen.getByTestId('first')).toHaveTextContent('loading:initial')
    expect(screen.getByTestId('second')).toHaveTextContent('loading:initial')
    expect(Object.isFrozen(snapshots[0])).toBe(true)

    await flushAdapter()
    expect(query).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('first')).toHaveTextContent('ready:ready')
    expect(screen.getByTestId('second')).toHaveTextContent('ready:ready')
    expect(Object.isFrozen(snapshots.at(-1))).toBe(true)

    view.rerender(<StateProbe id="first" queryKey="shared" query={query} />)
    expect(mutationHarness.unsubscriptionCount()).toBe(0)
    view.unmount()
    expect(mutationHarness.unsubscriptionCount()).toBe(1)
  })

  it('runs reads outside render and publishes through the React scheduler', async () => {
    const query = vi.fn(async () => 'ready-in-same-turn')
    render(<StateProbe id="probe" queryKey="task-shape" query={query} />)

    expect(query).not.toHaveBeenCalled()
    await act(nextTask)
    expect(query).toHaveBeenCalledTimes(1)

    await flushAdapter()
    expect(screen.getByTestId('probe')).toHaveTextContent('ready:ready-in-same-turn')
  })

  it('keeps read scheduling on the platform Promise when the global is temporarily replaced', async () => {
    const query = vi.fn(async () => 'platform-promise')
    render(<StateProbe id="probe" queryKey="platform-promise" query={query} />)
    const platformPromise = globalThis.Promise
    const ambientResolveStacks: string[] = []
    const ambientPromise = new Proxy(platformPromise, {
      get(target, property) {
        if (property === 'resolve') {
          return (value?: unknown) => {
            ambientResolveStacks.push(new Error().stack ?? '')
            return target.resolve(value)
          }
        }
        return target[property as keyof PromiseConstructor]
      },
    })

    try {
      await act(async () => {
        globalThis.Promise = ambientPromise
        await new platformPromise<void>((resolve) => setTimeout(resolve, 20))
      })
    } finally {
      globalThis.Promise = platformPromise
    }

    await flushAdapter()
    expect(query).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('probe')).toHaveTextContent('ready:platform-promise')
    expect(
      ambientResolveStacks.some((stack) => stack.includes('/src/store/reactive-query.ts')),
    ).toBe(false)
  })

  it('atomically swaps all snapshots queued for one scheduler publication', async () => {
    render(<PairedProbe />)
    await flushAdapter()

    expect(screen.getByTestId('paired')).toHaveTextContent('ready:ready')
    expect(pairedSnapshots).not.toContain('ready:loading')
    expect(pairedSnapshots).not.toContain('loading:ready')
  })

  it('escapes the Dexie transaction zone before a mutation-triggered read', async () => {
    await Dexie.delete(DATABASE_NAME)
    const database = new Dexie(DATABASE_NAME)
    database.version(1).stores({ settings: 'key' })
    await database.open()
    const readTransactions: Array<unknown> = []
    const query = vi.fn(async () => {
      readTransactions.push(Dexie.currentTransaction)
      return 'outside-transaction'
    })
    const ignoreTransaction = vi.spyOn(Dexie, 'ignoreTransaction')
    render(<StateProbe id="probe" queryKey="transaction-zone" query={query} />)
    await flushAdapter()
    readTransactions.length = 0

    try {
      await database.transaction('rw', database.table('settings'), async () => {
        mutationHarness.emit(settingMutation(WATCHED_SETTING))
        await database.table('settings').put({ key: WATCHED_SETTING })
      })
      await flushAdapter()

      expect(query).toHaveBeenCalledTimes(2)
      expect(readTransactions).toEqual([null])
      expect(ignoreTransaction).toHaveBeenCalledTimes(2)
    } finally {
      ignoreTransaction.mockRestore()
      database.close()
      await Dexie.delete(DATABASE_NAME)
    }
  })

  it('admits reactive reads only between local write transaction phases', async () => {
    const firstWriteStarted = deferred<void>()
    const firstWriteRelease = deferred<void>()
    const firstWrite = runWithLocalWriteActivity(async () => {
      firstWriteStarted.resolve()
      await firstWriteRelease.promise
    })
    await firstWriteStarted.promise

    const read = deferred<string>()
    const query = vi.fn(() => read.promise)
    render(<StateProbe id="probe" queryKey="write-activity" query={query} />)
    await act(nextTask)
    expect(query).not.toHaveBeenCalled()

    firstWriteRelease.resolve()
    await firstWrite
    await act(nextTask)
    expect(query).toHaveBeenCalledTimes(1)

    let secondWriteDidStart = false
    const secondWrite = runWithLocalWriteActivity(() => {
      secondWriteDidStart = true
    })
    await Promise.resolve()
    expect(secondWriteDidStart).toBe(false)

    read.resolve('between-writes')
    await secondWrite
    await flushAdapter()
    expect(screen.getByTestId('probe')).toHaveTextContent('ready:between-writes')
  })

  it('matches exact mutation keys and keeps identical ready snapshots stable', async () => {
    const query = vi.fn(async () => 'same')
    const view = render(<StateProbe id="probe" queryKey="stable" query={query} />)
    const loadingSnapshot = snapshots.at(-1)
    await flushAdapter()
    const readySnapshot = snapshots.at(-1)

    view.rerender(<StateProbe id="probe" queryKey="stable" query={query} marker="rerender" />)
    expect(snapshots.at(-1)).toBe(readySnapshot)
    expect(loadingSnapshot).not.toBe(readySnapshot)

    mutationHarness.emit(settingMutation('unrelated'))
    await flushAdapter()
    expect(query).toHaveBeenCalledTimes(1)

    mutationHarness.emit(settingMutation(WATCHED_SETTING))
    await flushAdapter()
    expect(query).toHaveBeenCalledTimes(2)
    expect(snapshots.at(-1)).toBe(readySnapshot)

    mutationHarness.emit({
      [`idb://${DATABASE_NAME}/settings/:dels`]: new RangeSet(WATCHED_SETTING),
    })
    await flushAdapter()
    expect(query).toHaveBeenCalledTimes(3)
  })

  it('does not requery a chat for unrelated chat or stream-table mutations', async () => {
    const query = vi.fn(async () => 'chat-a')
    const dependencies = [
      { table: 'messages', index: 'chatId', keys: ['chat-a'] },
      { table: 'messageBodies', index: 'chatId', keys: ['chat-a'] },
    ] satisfies readonly RepositoryQueryDependency[]
    render(
      <StateProbe id="probe" queryKey="active-chat" query={query} dependencies={dependencies} />,
    )
    await flushAdapter()

    mutationHarness.emit({
      [`idb://${DATABASE_NAME}/streamChunks/chatId`]: new RangeSet('chat-a'),
    })
    for (let index = 0; index < 100; index += 1) {
      mutationHarness.emit({
        [`idb://${DATABASE_NAME}/messageBodies/chatId`]: new RangeSet(`chat-${index + 1}`),
      })
    }
    await flushAdapter()
    expect(query).toHaveBeenCalledTimes(1)

    mutationHarness.emit({
      [`idb://${DATABASE_NAME}/messageBodies/chatId`]: new RangeSet('chat-a'),
    })
    await flushAdapter()
    expect(query).toHaveBeenCalledTimes(2)
  })

  it('keeps disabled queries unsubscribed from mutation invalidation', async () => {
    const query = vi.fn(async () => 'disabled')
    render(
      <StateProbe id="probe" queryKey="disabled" query={query} dependencies={EMPTY_DEPENDENCIES} />,
    )
    await flushAdapter()

    mutationHarness.emit({ all: new RangeSet(-Infinity, [[]]) })
    mutationHarness.emit(settingMutation(WATCHED_SETTING))
    await flushAdapter()
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('matches real Dexie PUT parts precisely and uses the chat row as the delete fallback', async () => {
    await Dexie.delete(DATABASE_NAME)
    const database = new Dexie(DATABASE_NAME)
    database.version(1).stores({ chats: 'id', messages: 'id, chatId', messageBodies: 'id, chatId' })
    await database.open()
    await database.table('messages').bulkPut([
      { id: 'active-message', chatId: 'chat-a' },
      { id: 'other-message', chatId: 'chat-b' },
    ])

    const query = vi.fn(async () => 'chat-a')
    const dependencies = [
      { table: 'chats', keys: ['chat-a'] },
      { table: 'messages', index: 'chatId', keys: ['chat-a'] },
      { table: 'messageBodies', index: 'chatId', keys: ['chat-a'] },
    ] satisfies readonly RepositoryQueryDependency[]
    render(
      <StateProbe id="probe" queryKey="real-parts" query={query} dependencies={dependencies} />,
    )
    await flushAdapter()

    try {
      const unrelatedPut = await captureDatabaseMutation(database, () =>
        database.table('messageBodies').put({ id: 'other-message', chatId: 'chat-b' }),
      )
      expect(unrelatedPut[`idb://${DATABASE_NAME}/messageBodies/:dels`]).toBeDefined()
      mutationHarness.emit(unrelatedPut)
      await flushAdapter()
      expect(query).toHaveBeenCalledTimes(1)

      const unrelatedDelete = await captureDatabaseMutation(database, () =>
        database.transaction(
          'rw',
          database.table('chats'),
          database.table('messages'),
          async () => {
            await database.table('messages').delete('other-message')
            await database.table('chats').put({ id: 'chat-b' })
          },
        ),
      )
      mutationHarness.emit(unrelatedDelete)
      await flushAdapter()
      expect(query).toHaveBeenCalledTimes(1)

      const activeDelete = await captureDatabaseMutation(database, () =>
        database.transaction(
          'rw',
          database.table('chats'),
          database.table('messages'),
          async () => {
            await database.table('messages').delete('active-message')
            await database.table('chats').put({ id: 'chat-a' })
          },
        ),
      )
      expect(activeDelete[`idb://${DATABASE_NAME}/messages/chatId`]).toBeUndefined()
      mutationHarness.emit(activeDelete)
      await flushAdapter()
      expect(query).toHaveBeenCalledTimes(2)
    } finally {
      database.close()
      await Dexie.delete(DATABASE_NAME)
    }
  })

  it('publishes errors without discarding the last good value', async () => {
    const query = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce('last-good')
      .mockRejectedValueOnce(new Error('read failed'))
    render(<StateProbe id="probe" queryKey="errors" query={query} />)
    await flushAdapter()
    expect(screen.getByTestId('probe')).toHaveTextContent('ready:last-good')

    mutationHarness.emit(settingMutation(WATCHED_SETTING))
    await flushAdapter()

    expect(screen.getByTestId('probe')).toHaveTextContent('error:last-good:read failed')
    expect(Object.isFrozen(snapshots.at(-1))).toBe(true)
  })

  it('does not resurrect an invalidated pending value when the fresh rerun fails', async () => {
    const publicationTasks: Array<() => void> = []
    __setRepositoryMutationSubscriberForTests(
      mutationHarness.subscribe,
      DATABASE_NAME,
      undefined,
      (task) => publicationTasks.push(task),
    )
    const query = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce('last-good')
      .mockResolvedValueOnce('invalidated-before-publication')
      .mockRejectedValueOnce(new Error('fresh read failed'))
    render(<StateProbe id="probe" queryKey="stale-pending-error" query={query} />)
    await flushReads()
    act(() => publicationTasks.shift()?.())
    expect(screen.getByTestId('probe')).toHaveTextContent('ready:last-good')

    mutationHarness.emit(settingMutation(WATCHED_SETTING))
    await flushReads()
    expect(publicationTasks).toHaveLength(1)
    mutationHarness.emit(settingMutation(WATCHED_SETTING))
    await flushReads()
    act(() => publicationTasks.shift()?.())

    expect(query).toHaveBeenCalledTimes(3)
    expect(screen.getByTestId('probe')).toHaveTextContent('error:last-good:fresh read failed')
    expect(screen.getByTestId('probe')).not.toHaveTextContent('invalidated-before-publication')
  })

  it('does not surface a database-close read from a replaced database', async () => {
    let open = true
    __setRepositoryMutationSubscriberForTests(mutationHarness.subscribe, DATABASE_NAME, () => ({
      isOpen: () => open,
    }))
    const query = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce('last-good')
      .mockRejectedValueOnce(new Dexie.DatabaseClosedError('replaced'))
    render(<StateProbe id="probe" queryKey="database-replaced" query={query} />)
    await flushAdapter()
    expect(screen.getByTestId('probe')).toHaveTextContent('ready:last-good')

    open = false
    mutationHarness.emit(settingMutation(WATCHED_SETTING))
    await flushAdapter()

    expect(query).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('probe')).toHaveTextContent('ready:last-good')
    expect(snapshots.some((snapshot) => snapshot.status === 'error')).toBe(false)
  })

  it('does not surface an AbortError from a database closed during the read', async () => {
    let open = true
    __setRepositoryMutationSubscriberForTests(mutationHarness.subscribe, DATABASE_NAME, () => ({
      isOpen: () => open,
    }))
    const query = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce('last-good')
      .mockRejectedValueOnce(new Dexie.AbortError('closed transaction'))
    render(<StateProbe id="probe" queryKey="database-close-abort" query={query} />)
    await flushAdapter()

    open = false
    mutationHarness.emit(settingMutation(WATCHED_SETTING))
    await flushAdapter()

    expect(query).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('probe')).toHaveTextContent('ready:last-good')
    expect(snapshots.some((snapshot) => snapshot.status === 'error')).toBe(false)
  })

  it('does not surface an AbortError while the document is being replaced', async () => {
    const query = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce('last-good')
      .mockRejectedValueOnce(new Dexie.AbortError('page replacement'))
    render(<StateProbe id="probe" queryKey="page-replacement-abort" query={query} />)
    await flushAdapter()

    window.dispatchEvent(new Event('pagehide'))
    try {
      mutationHarness.emit(settingMutation(WATCHED_SETTING))
      await flushAdapter()
      expect(screen.getByTestId('probe')).toHaveTextContent('ready:last-good')
      expect(snapshots.some((snapshot) => snapshot.status === 'error')).toBe(false)
    } finally {
      window.dispatchEvent(new Event('pageshow'))
    }
  })

  it('still surfaces a DatabaseClosedError while the query database remains open', async () => {
    const query = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce('last-good')
      .mockRejectedValueOnce(new Dexie.DatabaseClosedError('unexpected close error'))
    render(<StateProbe id="probe" queryKey="ordinary-database-close" query={query} />)
    await flushAdapter()

    mutationHarness.emit(settingMutation(WATCHED_SETTING))
    await flushAdapter()

    expect(screen.getByTestId('probe')).toHaveTextContent('error:last-good:unexpected close error')
  })

  it('still surfaces an AbortError while the query database remains open', async () => {
    const query = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce('last-good')
      .mockRejectedValueOnce(new Dexie.AbortError('ordinary read abort'))
    render(<StateProbe id="probe" queryKey="ordinary-abort" query={query} />)
    await flushAdapter()

    mutationHarness.emit(settingMutation(WATCHED_SETTING))
    await flushAdapter()

    expect(screen.getByTestId('probe')).toHaveTextContent('error:last-good:ordinary read abort')
  })

  it('invalidates an in-flight read and publishes only the fresh rerun', async () => {
    const stale = deferred<string>()
    const query = vi
      .fn<() => Promise<string>>()
      .mockImplementationOnce(() => stale.promise)
      .mockResolvedValueOnce('fresh')
    render(<StateProbe id="probe" queryKey="stale-read" query={query} />)
    await nextTask()
    expect(query).toHaveBeenCalledTimes(1)

    mutationHarness.emit(settingMutation(WATCHED_SETTING))
    stale.resolve('stale')
    await flushAdapter()

    expect(query).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('probe')).toHaveTextContent('ready:fresh')
    expect(snapshots.some((snapshot) => snapshot.value === 'stale')).toBe(false)
  })

  it('does not publish after unmount and restarts with the retained snapshot', async () => {
    const firstRead = deferred<string>()
    const query = vi
      .fn<() => Promise<string>>()
      .mockImplementationOnce(() => firstRead.promise)
      .mockResolvedValueOnce('version-2')
    const first = render(<StateProbe id="probe" queryKey="restart" query={query} />)
    await nextTask()
    first.unmount()

    const rendersBeforeLatePublish = snapshots.length
    const second = render(<StateProbe id="probe" queryKey="restart" query={query} />)
    expect(screen.getByTestId('probe')).toHaveTextContent('loading:initial')
    firstRead.resolve('stale-after-unmount')
    await flushAdapter()

    expect(query).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('probe')).toHaveTextContent('ready:version-2')
    expect(
      snapshots
        .slice(rendersBeforeLatePublish)
        .some((snapshot) => snapshot.value === 'stale-after-unmount'),
    ).toBe(false)
    second.unmount()
  })

  it('drops a publication queued before the final consumer unmounts', async () => {
    const read = deferred<string>()
    const first = render(
      <StateProbe id="probe" queryKey="queued-unmount" query={() => read.promise} />,
    )
    await nextTask()
    const rendersBeforeUnmount = snapshots.length
    act(() => {
      read.resolve('must-not-publish')
      first.unmount()
    })
    await flushAdapter()

    expect(snapshots).toHaveLength(rendersBeforeUnmount)
    render(<StateProbe id="probe" queryKey="queued-unmount" query={async () => 'fresh'} />)
    expect(screen.getByTestId('probe')).toHaveTextContent('loading:initial')
  })

  it('changes subscriptions only when the stable key changes', async () => {
    const view = render(<StateProbe id="probe" queryKey="old" query={async () => 'old'} />)
    await flushAdapter()
    view.rerender(<StateProbe id="probe" queryKey="old" query={async () => 'ignored'} />)
    expect(mutationHarness.subscriptionCount()).toBe(1)

    view.rerender(<StateProbe id="probe" queryKey="new" query={async () => 'new'} />)
    expect(mutationHarness.unsubscriptionCount()).toBe(1)
    expect(mutationHarness.subscriptionCount()).toBe(2)
    await flushAdapter()
    expect(screen.getByTestId('probe')).toHaveTextContent('ready:new')
  })

  it('fails loudly when consumers reuse a key with different dependencies', () => {
    render(<StateProbe id="first" queryKey="dependency-contract" query={async () => 'first'} />)

    expect(() =>
      render(
        <StateProbe
          id="second"
          queryKey="dependency-contract"
          query={async () => 'second'}
          dependencies={[{ table: 'profiles' }]}
        />,
      ),
    ).toThrow('RepositoryQueryDependencyMismatch:dependency-contract')
  })
})

function settingMutation(key: string): ObservabilitySet {
  return { [`idb://${DATABASE_NAME}/settings/`]: new RangeSet(key) }
}

async function captureDatabaseMutation(
  database: Dexie,
  write: () => Promise<unknown>,
): Promise<ObservabilitySet> {
  let observed: ObservabilitySet | undefined
  const listener = (parts: ObservabilitySet) => {
    if (Object.keys(parts).some((part) => part.startsWith(`idb://${database.name}/`))) {
      observed = parts
    }
  }
  Dexie.on.storagemutated.subscribe(listener)
  try {
    await write()
  } finally {
    Dexie.on.storagemutated.unsubscribe(listener)
  }
  if (!observed) throw new Error('ExpectedDexieMutation')
  return observed
}

async function flushAdapter(): Promise<void> {
  await act(async () => {
    await nextTask()
    await Promise.resolve()
    await nextTask()
    await Promise.resolve()
    await nextTask()
  })
}

async function flushReads(): Promise<void> {
  await act(async () => {
    await nextTask()
    await Promise.resolve()
    await nextTask()
  })
}

function nextTask(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel()
    channel.port1.onmessage = () => {
      channel.port1.close()
      channel.port2.close()
      resolve()
    }
    channel.port2.postMessage(undefined)
  })
}

function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T): void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

function StateProbe({
  id,
  queryKey,
  query,
  marker: _marker,
  dependencies = SETTINGS_DEPENDENCY,
}: {
  id: string
  queryKey: string
  query: () => Promise<string>
  marker?: string
  dependencies?: readonly RepositoryQueryDependency[]
}) {
  const snapshot = useRepositoryQueryState(queryKey, query, 'initial', dependencies)
  snapshots.push(snapshot)
  return (
    <span data-testid={id}>
      {snapshot.status}:{snapshot.value}
      {snapshot.status === 'error' && snapshot.error instanceof Error
        ? `:${snapshot.error.message}`
        : ''}
    </span>
  )
}

function PairedProbe() {
  const first = useRepositoryQueryState(
    'paired-first',
    async () => 'first',
    'initial-first',
    SETTINGS_DEPENDENCY,
  )
  const second = useRepositoryQueryState(
    'paired-second',
    async () => 'second',
    'initial-second',
    SETTINGS_DEPENDENCY,
  )
  pairedSnapshots.push(`${first.status}:${second.status}`)
  return (
    <span data-testid="paired">
      {first.status}:{second.status}
    </span>
  )
}
