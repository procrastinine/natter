import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetBroadcastForTests,
  type BroadcastEvent,
  onEvent,
  postEvent,
} from '../../src/store/broadcast'
import type { StreamLeaseRow, WorkspaceRepository } from '../../src/store/repository'
import {
  __flushStreamLeaseWritesForTests,
  __flushStreamOwnershipForTests,
  __resetStreamLeasesForTests,
  __runStreamLeaseHeartbeatSchedulerForTests,
  __setStreamLockManagerForTests,
  __streamLeaseHeartbeatSchedulerStateForTests,
  announceStreamEnded,
  getStreamClientId,
  installStreamLeaseListener,
  onRemoteStreamLeasesExpired,
  onRemoteStreamOwnershipReleased,
  requestAbortForChat,
  startStreamLease,
  stopStreamLease,
  withStreamRecoveryLocks,
} from '../../src/store/stream-leases'
import {
  __resetWorkspaceRepositoryForTests,
  __setWorkspaceRepositoryForTests,
} from '../../src/store/workspace-repository'
import { useStreamStore } from '../../src/store/zustand/streamStore'

beforeEach(() => {
  __resetBroadcastForTests()
  __resetStreamLeasesForTests()
  __resetWorkspaceRepositoryForTests()
  useStreamStore.getState().reset()
})

afterEach(async () => {
  __resetStreamLeasesForTests()
  await Promise.all([__flushStreamLeaseWritesForTests(), __flushStreamOwnershipForTests()])
  __resetBroadcastForTests()
  __resetWorkspaceRepositoryForTests()
  useStreamStore.getState().reset()
  vi.useRealTimers()
})

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function drainMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}

function leaseInput(streamId: string) {
  return {
    streamId,
    chatId: 'C1',
    messageId: `M-${streamId}`,
    startedAt: 1,
  }
}

function persistedLease(lease: StreamLeaseRow): StreamLeaseRow {
  return {
    ...lease,
    fenceToken: lease.fenceToken ?? `fence:${lease.streamId}`,
    replacementEpoch: lease.replacementEpoch ?? 0,
  }
}

class TestStreamLockManager {
  private readonly held = new Set<string>()
  private readonly queues = new Map<string, Array<() => void>>()

  request<T>(
    name: string,
    optionsOrCallback: LockOptions | ((lock: Lock | null) => T | PromiseLike<T>),
    maybeCallback?: (lock: Lock | null) => T | PromiseLike<T>,
  ): Promise<T> {
    const options = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback
    const callback =
      typeof optionsOrCallback === 'function'
        ? optionsOrCallback
        : (maybeCallback as NonNullable<typeof maybeCallback>)
    if (options.ifAvailable && this.held.has(name)) return Promise.resolve(callback(null))
    return new Promise<T>((resolve, reject) => {
      const acquire = () => {
        if (this.held.has(name)) {
          const queue = this.queues.get(name) ?? []
          queue.push(acquire)
          this.queues.set(name, queue)
          return
        }
        this.held.add(name)
        const lock = { name, mode: options.mode ?? 'exclusive' } as Lock
        void Promise.resolve(callback(lock)).then(
          (value) => {
            this.held.delete(name)
            this.queues.get(name)?.shift()?.()
            resolve(value)
          },
          (error) => {
            this.held.delete(name)
            this.queues.get(name)?.shift()?.()
            reject(error)
          },
        )
      }
      acquire()
    })
  }

  isHeld(name: string): boolean {
    return this.held.has(name)
  }
}

describe('stream leases', () => {
  it('awaits message-less admission and retargets the same owned lease', async () => {
    const manager = new TestStreamLockManager()
    __setStreamLockManagerForTests(manager)
    const firstPutStarted = deferred()
    const releaseFirstPut = deferred()
    const written: StreamLeaseRow[] = []
    const writeLease = async (lease: StreamLeaseRow) => {
      if (written.length === 0) {
        firstPutStarted.resolve()
        await releaseFirstPut.promise
      }
      const stored = persistedLease(lease)
      written.push(stored)
      return stored
    }
    __setWorkspaceRepositoryForTests({
      upsertStreamLease: writeLease,
      renewStreamLease: writeLease,
      deleteStreamLease: async () => true,
      deleteOwnedStreamLease: async () => true,
    } as unknown as WorkspaceRepository)

    let admitted = false
    const admission = startStreamLease({ streamId: 'S-admit', chatId: 'C1', startedAt: 1 }).then(
      () => {
        admitted = true
      },
    )
    await firstPutStarted.promise
    expect(admitted).toBe(false)
    expect(manager.isHeld('stream-owner:S-admit')).toBe(true)

    releaseFirstPut.resolve()
    await admission
    expect(written).toHaveLength(1)
    expect(written[0]).not.toHaveProperty('messageId')

    await startStreamLease({
      streamId: 'S-admit',
      chatId: 'C1',
      messageId: 'M-target',
      startedAt: 2,
      attemptKind: 'generation',
    })
    expect(manager.isHeld('stream-owner:S-admit')).toBe(true)
    expect(written.at(-1)).toMatchObject({
      streamId: 'S-admit',
      messageId: 'M-target',
      attemptKind: 'generation',
      startedAt: 1,
    })

    void stopStreamLease('S-admit')
    await Promise.all([__flushStreamLeaseWritesForTests(), __flushStreamOwnershipForTests()])
    expect(manager.isHeld('stream-owner:S-admit')).toBe(false)
  })

  it('releases ownership and admission state when the first lease write fails', async () => {
    const manager = new TestStreamLockManager()
    __setStreamLockManagerForTests(manager)
    let attempts = 0
    __setWorkspaceRepositoryForTests({
      upsertStreamLease: async (lease: StreamLeaseRow) => {
        attempts += 1
        if (attempts === 1) throw new Error('temporary lease write failure')
        return persistedLease(lease)
      },
      renewStreamLease: async (lease: StreamLeaseRow) => persistedLease(lease),
      deleteStreamLease: async () => true,
      deleteOwnedStreamLease: async () => true,
    } as unknown as WorkspaceRepository)

    await expect(startStreamLease(leaseInput('S-retry-admission'))).rejects.toThrow(
      'temporary lease write failure',
    )
    await Promise.all([__flushStreamLeaseWritesForTests(), __flushStreamOwnershipForTests()])
    expect(manager.isHeld('stream-owner:S-retry-admission')).toBe(false)

    await expect(startStreamLease(leaseInput('S-retry-admission'))).resolves.toMatchObject({
      replacementEpoch: 0,
    })
    expect(manager.isHeld('stream-owner:S-retry-admission')).toBe(true)
    void stopStreamLease('S-retry-admission')
    await Promise.all([__flushStreamLeaseWritesForTests(), __flushStreamOwnershipForTests()])
  })

  it('mirrors fresh remote leases into stream status and clears on stream end', () => {
    installStreamLeaseListener()
    const setActive = vi.spyOn(useStreamStore.getState(), 'setActive')

    postEvent({
      kind: 'stream-heartbeat',
      lease: {
        streamId: 'S-remote',
        chatId: 'C1',
        messageId: 'M1',
        ownerClientId: 'other-tab',
        startedAt: 1,
        heartbeatAt: Date.now(),
      },
    })

    expect(useStreamStore.getState().isTargetActive('C1', 'M1')).toBe(true)
    expect(useStreamStore.getState().hasStreamForChat('C1')).toBe(true)
    postEvent({
      kind: 'stream-heartbeat',
      lease: {
        streamId: 'S-remote',
        chatId: 'C1',
        messageId: 'M1',
        ownerClientId: 'other-tab',
        startedAt: 1,
        heartbeatAt: Date.now() + 1,
      },
    })
    expect(setActive).toHaveBeenCalledTimes(1)

    postEvent({
      kind: 'stream-ended',
      chatId: 'C1',
      streamId: 'S-remote',
      messageId: 'M1',
      outcome: 'done',
    })

    expect(useStreamStore.getState().isTargetActive('C1', 'M1')).toBe(false)
    setActive.mockRestore()
  })

  it('locally tombstones before announcing a recovered stream end', () => {
    installStreamLeaseListener()
    const seen: BroadcastEvent[] = []
    const stopListening = onEvent((event) => {
      if (event.kind === 'stream-ended') seen.push(event)
    })
    postEvent({
      kind: 'stream-heartbeat',
      lease: {
        streamId: 'S-announced-end',
        chatId: 'C1',
        messageId: 'M-announced-end',
        ownerClientId: 'other-tab',
        startedAt: 1,
        heartbeatAt: Date.now(),
      },
    })

    announceStreamEnded({
      chatId: 'C1',
      streamId: 'S-announced-end',
      messageId: 'M-announced-end',
      outcome: 'abort',
    })
    postEvent({
      kind: 'stream-heartbeat',
      lease: {
        streamId: 'S-announced-end',
        chatId: 'C1',
        messageId: 'M-announced-end',
        ownerClientId: 'other-tab',
        startedAt: 1,
        heartbeatAt: Date.now() + 1,
      },
    })

    expect(useStreamStore.getState().isTargetActive('C1', 'M-announced-end')).toBe(false)
    expect(seen).toEqual([
      {
        kind: 'stream-ended',
        chatId: 'C1',
        streamId: 'S-announced-end',
        messageId: 'M-announced-end',
        outcome: 'abort',
      },
    ])
    stopListening()
  })

  it('does not run idle lease discovery polling while BroadcastChannel is available', async () => {
    vi.useFakeTimers()
    __setWorkspaceRepositoryForTests({
      listStreamLeases: async () => [],
    } as unknown as WorkspaceRepository)

    installStreamLeaseListener()
    await Promise.resolve()

    expect(vi.getTimerCount()).toBe(0)
  })

  it('moves the expiry timer earlier when an older fresh lease is observed', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(100_000)
    const listStreamLeases = vi.fn(async () => [])
    __setWorkspaceRepositoryForTests({ listStreamLeases } as unknown as WorkspaceRepository)
    installStreamLeaseListener()
    await drainMicrotasks()
    expect(listStreamLeases).toHaveBeenCalledTimes(1)

    postEvent({
      kind: 'stream-heartbeat',
      lease: {
        streamId: 'S-later-expiry',
        chatId: 'C1',
        ownerClientId: 'other-tab',
        startedAt: 1,
        heartbeatAt: 100_000,
      },
    })
    postEvent({
      kind: 'stream-heartbeat',
      lease: {
        streamId: 'S-earlier-expiry',
        chatId: 'C2',
        ownerClientId: 'other-tab',
        startedAt: 1,
        heartbeatAt: 90_001,
      },
    })

    await vi.advanceTimersByTimeAsync(5_001)
    expect(listStreamLeases).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(listStreamLeases).toHaveBeenCalledTimes(2)
  })

  it('backs off a failed expiry refresh instead of retrying in a hot loop', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(100_000)
    let fail = false
    const listStreamLeases = vi.fn(async () => {
      if (fail) throw new Error('temporary lease read failure')
      return []
    })
    __setWorkspaceRepositoryForTests({ listStreamLeases } as unknown as WorkspaceRepository)
    installStreamLeaseListener()
    await drainMicrotasks()
    fail = true
    postEvent({
      kind: 'stream-heartbeat',
      lease: {
        streamId: 'S-refresh-backoff',
        chatId: 'C1',
        ownerClientId: 'other-tab',
        startedAt: 1,
        heartbeatAt: 85_000,
      },
    })

    await vi.advanceTimersByTimeAsync(1)
    expect(listStreamLeases).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1_999)
    expect(listStreamLeases).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(listStreamLeases).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('notifies once when a persisted remote lease actually expires', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(100_000)
    const lease: StreamLeaseRow = {
      streamId: 'S-expired-notification',
      chatId: 'C1',
      messageId: 'M-expired-notification',
      ownerClientId: 'other-tab',
      startedAt: 1,
      heartbeatAt: 100_000,
    }
    __setWorkspaceRepositoryForTests({
      listStreamLeases: async () => [lease],
    } as unknown as WorkspaceRepository)
    const expired = vi.fn()
    const unsubscribeExpired = onRemoteStreamLeasesExpired(expired)
    await drainMicrotasks()

    expect(useStreamStore.getState().isTargetActive('C1', 'M-expired-notification')).toBe(true)
    await vi.advanceTimersByTimeAsync(15_001)
    expect(expired).toHaveBeenCalledTimes(1)
    expect(expired).toHaveBeenCalledWith([lease])
    expect(useStreamStore.getState().isTargetActive('C1', 'M-expired-notification')).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    unsubscribeExpired()
  })

  it('wakes after remote ownership releases and lets recovery reacquire exclusively', async () => {
    const manager = new TestStreamLockManager()
    __setStreamLockManagerForTests(manager)
    const lease: StreamLeaseRow = {
      streamId: 'S-reload-release',
      chatId: 'C1',
      messageId: 'M-reload-release',
      ownerClientId: 'old-page',
      startedAt: 1,
      heartbeatAt: Date.now(),
    }
    __setWorkspaceRepositoryForTests({
      listStreamLeases: async () => [lease],
    } as unknown as WorkspaceRepository)
    const ownerReady = deferred()
    const releaseOwner = deferred()
    const owner = manager.request('stream-owner:S-reload-release', async () => {
      ownerReady.resolve()
      await releaseOwner.promise
    })
    await ownerReady.promise

    const recoveryFinished = deferred()
    let recoveryResult: Awaited<ReturnType<typeof withStreamRecoveryLocks>> | undefined
    const stopObserving = onRemoteStreamOwnershipReleased('C1', () => {
      void withStreamRecoveryLocks(
        ['S-reload-release'],
        async (ownershipVerified) => ownershipVerified,
      ).then((result) => {
        recoveryResult = result
        recoveryFinished.resolve()
      })
    })
    await drainMicrotasks()
    expect(recoveryResult).toBeUndefined()

    releaseOwner.resolve()
    await owner
    await recoveryFinished.promise
    expect(recoveryResult).toEqual({ acquired: true, value: true })
    stopObserving()
  })

  it('aborts a queued ownership-release observation when its chat subscription stops', async () => {
    const lease: StreamLeaseRow = {
      streamId: 'S-observer-teardown',
      chatId: 'C1',
      ownerClientId: 'other-page',
      startedAt: 1,
      heartbeatAt: Date.now(),
    }
    __setWorkspaceRepositoryForTests({
      listStreamLeases: async () => [lease],
    } as unknown as WorkspaceRepository)
    let observedSignal: AbortSignal | undefined
    const manager = {
      request: vi.fn(
        (_name: string, options: LockOptions, _callback: (lock: Lock | null) => unknown) => {
          observedSignal = options.signal
          return new Promise<unknown>((_resolve, reject) => {
            options.signal?.addEventListener(
              'abort',
              () => reject(new DOMException('aborted', 'AbortError')),
              { once: true },
            )
          })
        },
      ),
    }
    __setStreamLockManagerForTests(manager as unknown as Pick<LockManager, 'request'>)

    const stopObserving = onRemoteStreamOwnershipReleased('C1', vi.fn())
    await drainMicrotasks()
    expect(observedSignal?.aborted).toBe(false)
    stopObserving()
    expect(observedSignal?.aborted).toBe(true)
  })

  it('does not resurrect an ended remote stream from a late heartbeat or start event', () => {
    installStreamLeaseListener()
    const clearLiveSnapshot = vi.spyOn(useStreamStore.getState(), 'clearLiveSnapshot')
    postEvent({
      kind: 'stream-ended',
      chatId: 'C1',
      streamId: 'S-ended',
      messageId: 'M-ended',
      outcome: 'done',
    })

    postEvent({
      kind: 'stream-heartbeat',
      lease: {
        streamId: 'S-ended',
        chatId: 'C1',
        messageId: 'M-ended',
        ownerClientId: 'other-tab',
        startedAt: 1,
        heartbeatAt: Date.now(),
      },
    })
    postEvent({
      kind: 'stream-started',
      chatId: 'C1',
      streamId: 'S-ended',
      messageId: 'M-ended',
      ownerClientId: 'other-tab',
    })

    expect(useStreamStore.getState().isTargetActive('C1', 'M-ended')).toBe(false)
    expect(clearLiveSnapshot).not.toHaveBeenCalled()
  })

  it('does not resurrect an ended stream from an older lease refresh result', async () => {
    let releaseList!: (leases: StreamLeaseRow[]) => void
    const listStarted = deferred()
    const leases = new Promise<StreamLeaseRow[]>((resolve) => {
      releaseList = resolve
    })
    __setWorkspaceRepositoryForTests({
      listStreamLeases: async () => {
        listStarted.resolve()
        return leases
      },
    } as unknown as WorkspaceRepository)

    installStreamLeaseListener()
    await listStarted.promise
    postEvent({
      kind: 'stream-ended',
      chatId: 'C1',
      streamId: 'S-refresh-race',
      messageId: 'M-refresh-race',
      outcome: 'done',
    })
    releaseList([
      {
        streamId: 'S-refresh-race',
        chatId: 'C1',
        messageId: 'M-refresh-race',
        ownerClientId: 'other-tab',
        startedAt: 1,
        heartbeatAt: Date.now(),
      },
    ])
    await leases
    await Promise.resolve()

    expect(useStreamStore.getState().isTargetActive('C1', 'M-refresh-race')).toBe(false)
  })

  it('does not regress a newer targeted heartbeat with an older paused refresh row', async () => {
    let releaseList!: (leases: StreamLeaseRow[]) => void
    const listStarted = deferred()
    const leases = new Promise<StreamLeaseRow[]>((resolve) => {
      releaseList = resolve
    })
    __setWorkspaceRepositoryForTests({
      listStreamLeases: async () => {
        listStarted.resolve()
        return leases
      },
    } as unknown as WorkspaceRepository)
    installStreamLeaseListener()
    await listStarted.promise
    postEvent({
      kind: 'stream-heartbeat',
      lease: {
        streamId: 'S-retarget-refresh-race',
        chatId: 'C1',
        messageId: 'M-new-target',
        ownerClientId: 'other-tab',
        startedAt: 1,
        heartbeatAt: Date.now(),
      },
    })
    releaseList([
      {
        streamId: 'S-retarget-refresh-race',
        chatId: 'C1',
        ownerClientId: 'other-tab',
        startedAt: 1,
        heartbeatAt: Date.now() - 1,
      },
    ])
    await leases
    await drainMicrotasks()

    expect(useStreamStore.getState().getActive('S-retarget-refresh-race')).toMatchObject({
      messageId: 'M-new-target',
    })
  })

  it('does not clear a stream observed after a paused refresh began', async () => {
    let releaseList!: (leases: StreamLeaseRow[]) => void
    const listStarted = deferred()
    const leases = new Promise<StreamLeaseRow[]>((resolve) => {
      releaseList = resolve
    })
    __setWorkspaceRepositoryForTests({
      listStreamLeases: async () => {
        listStarted.resolve()
        return leases
      },
    } as unknown as WorkspaceRepository)
    installStreamLeaseListener()
    await listStarted.promise
    postEvent({
      kind: 'stream-started',
      chatId: 'C1',
      streamId: 'S-new-during-refresh',
      messageId: 'M-new-during-refresh',
      ownerClientId: 'other-tab',
    })
    releaseList([])
    await leases
    await drainMicrotasks()

    expect(useStreamStore.getState().isTargetActive('C1', 'M-new-during-refresh')).toBe(true)
  })

  it('preserves a fresh start observed before a refresh whose snapshot is still missing it', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(100_000)
    const listStreamLeases = vi.fn(async () => [])
    __setWorkspaceRepositoryForTests({ listStreamLeases } as unknown as WorkspaceRepository)
    installStreamLeaseListener()
    await drainMicrotasks()
    postEvent({
      kind: 'stream-started',
      chatId: 'C1',
      streamId: 'S-start-before-refresh',
      messageId: 'M-start-before-refresh',
      ownerClientId: 'other-tab',
    })
    postEvent({ kind: 'workspace-invalidated', mutationCounter: 1 })
    await drainMicrotasks()

    expect(listStreamLeases).toHaveBeenCalledTimes(2)
    expect(useStreamStore.getState().isTargetActive('C1', 'M-start-before-refresh')).toBe(true)

    await vi.advanceTimersByTimeAsync(15_001)
    expect(useStreamStore.getState().isTargetActive('C1', 'M-start-before-refresh')).toBe(false)
  })

  it('keeps heartbeat and target observations monotonic', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(100_000)
    const listStreamLeases = vi.fn(async () => [])
    __setWorkspaceRepositoryForTests({ listStreamLeases } as unknown as WorkspaceRepository)
    installStreamLeaseListener()
    await drainMicrotasks()
    postEvent({
      kind: 'stream-heartbeat',
      lease: {
        streamId: 'S-monotonic',
        chatId: 'C1',
        messageId: 'M-monotonic',
        ownerClientId: 'other-tab',
        startedAt: 1,
        heartbeatAt: 100_000,
      },
    })
    postEvent({
      kind: 'stream-heartbeat',
      lease: {
        streamId: 'S-monotonic',
        chatId: 'C1',
        ownerClientId: 'other-tab',
        startedAt: 1,
        heartbeatAt: 90_000,
      },
    })

    expect(useStreamStore.getState().getActive('S-monotonic')).toMatchObject({
      messageId: 'M-monotonic',
    })
    await vi.advanceTimersByTimeAsync(5_002)
    expect(listStreamLeases).toHaveBeenCalledTimes(1)
  })

  it('routes remote abort requests without pretending a remote stream has a local abort', () => {
    installStreamLeaseListener()
    const seen: BroadcastEvent[] = []
    const unsubscribe = onEvent((event) => {
      if (event.kind === 'stream-abort-requested') seen.push(event)
    })

    useStreamStore.getState().setActive({
      streamId: 'S-remote',
      chatId: 'C1',
      messageId: 'M1',
      startedAt: 1,
      heartbeatAt: 2,
      ownerClientId: 'other-tab',
    })

    expect(requestAbortForChat('C1')).toBe(1)
    expect(seen).toEqual([
      {
        kind: 'stream-abort-requested',
        chatId: 'C1',
        streamId: 'S-remote',
        ownerClientId: 'other-tab',
      },
    ])
    unsubscribe()
  })

  it('aborts local streams directly', () => {
    installStreamLeaseListener()
    const abort = vi.fn()
    useStreamStore.getState().setActive({
      streamId: 'S-local',
      chatId: 'C1',
      messageId: 'M1',
      startedAt: 1,
      ownerClientId: getStreamClientId(),
      abort,
    })

    expect(requestAbortForChat('C1')).toBe(1)
    expect(abort).toHaveBeenCalledTimes(1)
  })

  it('orders deletion after an in-flight heartbeat so a stopped lease cannot reappear', async () => {
    const manager = new TestStreamLockManager()
    __setStreamLockManagerForTests(manager)
    const putStarted = deferred()
    const releasePut = deferred()
    const operations: string[] = []
    let stored: StreamLeaseRow | undefined
    const writeLease = async (lease: StreamLeaseRow) => {
      operations.push('put:start')
      putStarted.resolve()
      await releasePut.promise
      stored = persistedLease(lease)
      operations.push('put:commit')
      return stored
    }
    const deleteLease = async () => {
      operations.push('delete')
      stored = undefined
      return true
    }
    __setWorkspaceRepositoryForTests({
      upsertStreamLease: writeLease,
      renewStreamLease: writeLease,
      deleteStreamLease: deleteLease,
      deleteOwnedStreamLease: deleteLease,
    } as unknown as WorkspaceRepository)

    void startStreamLease(leaseInput('S-race'))
    await putStarted.promise
    const stopped = stopStreamLease('S-race')

    expect(operations).toEqual(['put:start'])
    expect(manager.isHeld('stream-owner:S-race')).toBe(true)
    releasePut.resolve()
    await stopped
    await Promise.all([__flushStreamLeaseWritesForTests(), __flushStreamOwnershipForTests()])

    expect(operations).toEqual(['put:start', 'put:commit', 'delete'])
    expect(stored).toBeUndefined()
    expect(manager.isHeld('stream-owner:S-race')).toBe(false)
  })

  it('retries one transient owned-lease deletion before releasing ownership', async () => {
    const manager = new TestStreamLockManager()
    __setStreamLockManagerForTests(manager)
    let deleteAttempts = 0
    __setWorkspaceRepositoryForTests({
      upsertStreamLease: async (lease: StreamLeaseRow) => persistedLease(lease),
      renewStreamLease: async (lease: StreamLeaseRow) => persistedLease(lease),
      deleteStreamLease: async () => true,
      deleteOwnedStreamLease: async () => {
        deleteAttempts += 1
        expect(manager.isHeld('stream-owner:S-delete-retry')).toBe(true)
        if (deleteAttempts === 1) throw new Error('temporary delete failure')
        return true
      },
    } as unknown as WorkspaceRepository)
    await startStreamLease(leaseInput('S-delete-retry'))

    await stopStreamLease('S-delete-retry')
    await Promise.all([__flushStreamLeaseWritesForTests(), __flushStreamOwnershipForTests()])

    expect(deleteAttempts).toBe(2)
    expect(manager.isHeld('stream-owner:S-delete-retry')).toBe(false)
  })

  it('coalesces timer ticks while a heartbeat write is pending', async () => {
    vi.useFakeTimers()
    const firstPutStarted = deferred()
    const releaseFirstPut = deferred()
    let upserts = 0
    let concurrent = 0
    let maxConcurrent = 0
    const writeLease = async (lease: StreamLeaseRow) => {
      upserts += 1
      concurrent += 1
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      if (upserts === 1) {
        firstPutStarted.resolve()
        await releaseFirstPut.promise
      }
      concurrent -= 1
      return persistedLease(lease)
    }
    __setWorkspaceRepositoryForTests({
      upsertStreamLease: writeLease,
      renewStreamLease: writeLease,
      deleteStreamLease: async () => true,
      deleteOwnedStreamLease: async () => true,
    } as unknown as WorkspaceRepository)

    void startStreamLease(leaseInput('S-coalesced'))
    await firstPutStarted.promise
    vi.advanceTimersByTime(8_000)
    await Promise.resolve()

    expect(upserts).toBe(1)
    expect(maxConcurrent).toBe(1)

    releaseFirstPut.resolve()
    await __flushStreamLeaseWritesForTests()
    vi.advanceTimersByTime(2_000)
    await __flushStreamLeaseWritesForTests()

    expect(upserts).toBe(2)
    expect(maxConcurrent).toBe(1)
    void stopStreamLease('S-coalesced')
    await __flushStreamLeaseWritesForTests()
  })

  it('renews 100 leases from one shared wakeup with an individual fence per stream', async () => {
    vi.useFakeTimers()
    __setStreamLockManagerForTests(null)
    const admitted = new Map<string, StreamLeaseRow>()
    const renewals: Array<{ lease: StreamLeaseRow; targetChanged: boolean }> = []
    __setWorkspaceRepositoryForTests({
      upsertStreamLease: async (lease: StreamLeaseRow) => {
        const stored = persistedLease(lease)
        admitted.set(lease.streamId, stored)
        return stored
      },
      renewStreamLease: async (lease: StreamLeaseRow, options: { targetChanged: boolean }) => {
        const original = admitted.get(lease.streamId)
        expect(original).toBeDefined()
        expect(lease.ownerClientId).toBe(original?.ownerClientId)
        expect(lease.fenceToken).toBe(original?.fenceToken)
        expect(lease.replacementEpoch).toBe(original?.replacementEpoch)
        renewals.push({ lease: structuredClone(lease), targetChanged: options.targetChanged })
        const stored = persistedLease(lease)
        admitted.set(lease.streamId, stored)
        return stored
      },
      deleteStreamLease: async () => true,
      deleteOwnedStreamLease: async () => true,
    } as unknown as WorkspaceRepository)

    await Promise.all(
      Array.from({ length: 100 }, (_, index) => startStreamLease(leaseInput(`S-shared-${index}`))),
    )

    expect(__streamLeaseHeartbeatSchedulerStateForTests()).toMatchObject({
      activeWriters: 100,
      timerScheduled: true,
      wakeups: 0,
    })
    expect(vi.getTimerCount()).toBe(1)

    await vi.advanceTimersByTimeAsync(2_000)
    await __flushStreamLeaseWritesForTests()

    expect(renewals).toHaveLength(100)
    expect(renewals.every((renewal) => renewal.targetChanged === false)).toBe(true)
    expect(new Set(renewals.map((renewal) => renewal.lease.streamId)).size).toBe(100)
    expect(__streamLeaseHeartbeatSchedulerStateForTests()).toMatchObject({
      activeWriters: 100,
      timerScheduled: true,
      wakeups: 1,
    })
    expect(vi.getTimerCount()).toBe(1)

    await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        stopStreamLease(`S-shared-${index}`, { deleteRow: false }),
      ),
    )
    expect(__streamLeaseHeartbeatSchedulerStateForTests()).toEqual({
      activeWriters: 0,
      timerScheduled: false,
      deadline: null,
      wakeups: 1,
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('starts all due renewals concurrently from the shared scheduler', async () => {
    vi.useFakeTimers()
    __setStreamLockManagerForTests(null)
    const allRenewalsStarted = deferred()
    const releaseRenewals = deferred()
    let concurrent = 0
    let maxConcurrent = 0
    let renewals = 0
    __setWorkspaceRepositoryForTests({
      upsertStreamLease: async (lease: StreamLeaseRow) => persistedLease(lease),
      renewStreamLease: async (lease: StreamLeaseRow) => {
        renewals += 1
        concurrent += 1
        maxConcurrent = Math.max(maxConcurrent, concurrent)
        if (renewals === 3) allRenewalsStarted.resolve()
        await releaseRenewals.promise
        concurrent -= 1
        return persistedLease(lease)
      },
      deleteStreamLease: async () => true,
      deleteOwnedStreamLease: async () => true,
    } as unknown as WorkspaceRepository)
    await Promise.all(['left', 'middle', 'right'].map((id) => startStreamLease(leaseInput(id))))
    const deadline = __streamLeaseHeartbeatSchedulerStateForTests().deadline
    expect(deadline).not.toBeNull()

    __runStreamLeaseHeartbeatSchedulerForTests(deadline as number)
    await allRenewalsStarted.promise

    expect(renewals).toBe(3)
    expect(maxConcurrent).toBe(3)
    expect(__streamLeaseHeartbeatSchedulerStateForTests()).toMatchObject({
      timerScheduled: true,
      wakeups: 1,
    })

    releaseRenewals.resolve()
    await __flushStreamLeaseWritesForTests()
    await Promise.all(
      ['left', 'middle', 'right'].map((id) => stopStreamLease(id, { deleteRow: false })),
    )
  })

  it('joins later writers to the existing heartbeat deadline instead of adding wakeups', async () => {
    vi.useFakeTimers()
    __setStreamLockManagerForTests(null)
    const renewStreamLease = vi.fn(async (lease: StreamLeaseRow) => persistedLease(lease))
    __setWorkspaceRepositoryForTests({
      upsertStreamLease: async (lease: StreamLeaseRow) => persistedLease(lease),
      renewStreamLease,
      deleteStreamLease: async () => true,
      deleteOwnedStreamLease: async () => true,
    } as unknown as WorkspaceRepository)

    await startStreamLease(leaseInput('early'))
    const sharedDeadline = __streamLeaseHeartbeatSchedulerStateForTests().deadline
    await vi.advanceTimersByTimeAsync(1_500)
    await startStreamLease(leaseInput('late'))

    expect(__streamLeaseHeartbeatSchedulerStateForTests()).toMatchObject({
      activeWriters: 2,
      timerScheduled: true,
      deadline: sharedDeadline,
      wakeups: 0,
    })
    expect(vi.getTimerCount()).toBe(1)

    await vi.advanceTimersByTimeAsync(500)
    await __flushStreamLeaseWritesForTests()

    expect(renewStreamLease).toHaveBeenCalledTimes(2)
    expect(__streamLeaseHeartbeatSchedulerStateForTests()).toMatchObject({ wakeups: 1 })
    await Promise.all(['early', 'late'].map((id) => stopStreamLease(id, { deleteRow: false })))
  })

  it('processes overdue heartbeats once and reschedules from the delayed wake time', async () => {
    vi.useFakeTimers()
    __setStreamLockManagerForTests(null)
    const renewStreamLease = vi.fn(async (lease: StreamLeaseRow) => persistedLease(lease))
    __setWorkspaceRepositoryForTests({
      upsertStreamLease: async (lease: StreamLeaseRow) => persistedLease(lease),
      renewStreamLease,
      deleteStreamLease: async () => true,
      deleteOwnedStreamLease: async () => true,
    } as unknown as WorkspaceRepository)
    await Promise.all(['one', 'two', 'three'].map((id) => startStreamLease(leaseInput(id))))
    const initialDeadline = __streamLeaseHeartbeatSchedulerStateForTests().deadline
    expect(initialDeadline).not.toBeNull()
    const delayedNow = (initialDeadline as number) + 30_000

    __runStreamLeaseHeartbeatSchedulerForTests(delayedNow)
    await __flushStreamLeaseWritesForTests()

    expect(renewStreamLease).toHaveBeenCalledTimes(3)
    expect(__streamLeaseHeartbeatSchedulerStateForTests()).toEqual({
      activeWriters: 3,
      timerScheduled: true,
      deadline: delayedNow + 2_000,
      wakeups: 1,
    })
    __runStreamLeaseHeartbeatSchedulerForTests(delayedNow + 1_999)
    await __flushStreamLeaseWritesForTests()
    expect(renewStreamLease).toHaveBeenCalledTimes(3)

    await Promise.all(
      ['one', 'two', 'three'].map((id) => stopStreamLease(id, { deleteRow: false })),
    )
  })

  it('keeps Web Lock ownership through a renewal failure and disposes the shared timer', async () => {
    vi.useFakeTimers()
    const manager = new TestStreamLockManager()
    __setStreamLockManagerForTests(manager)
    let renewalAttempts = 0
    __setWorkspaceRepositoryForTests({
      upsertStreamLease: async (lease: StreamLeaseRow) => persistedLease(lease),
      renewStreamLease: async (lease: StreamLeaseRow) => {
        renewalAttempts += 1
        if (renewalAttempts === 1) throw new Error('renewal failed')
        return persistedLease(lease)
      },
      deleteStreamLease: async () => true,
      deleteOwnedStreamLease: async () => true,
    } as unknown as WorkspaceRepository)
    await startStreamLease(leaseInput('S-renewal-failure'))
    expect(manager.isHeld('stream-owner:S-renewal-failure')).toBe(true)
    const firstDeadline = __streamLeaseHeartbeatSchedulerStateForTests().deadline as number

    __runStreamLeaseHeartbeatSchedulerForTests(firstDeadline)
    await __flushStreamLeaseWritesForTests()
    expect(renewalAttempts).toBe(1)
    expect(manager.isHeld('stream-owner:S-renewal-failure')).toBe(true)

    const retryDeadline = __streamLeaseHeartbeatSchedulerStateForTests().deadline as number
    __runStreamLeaseHeartbeatSchedulerForTests(retryDeadline)
    await __flushStreamLeaseWritesForTests()
    expect(renewalAttempts).toBe(2)
    expect(manager.isHeld('stream-owner:S-renewal-failure')).toBe(true)

    __resetStreamLeasesForTests()
    expect(__streamLeaseHeartbeatSchedulerStateForTests()).toEqual({
      activeWriters: 0,
      timerScheduled: false,
      deadline: null,
      wakeups: 0,
    })
    expect(vi.getTimerCount()).toBe(0)
    await __flushStreamOwnershipForTests()
    expect(manager.isHeld('stream-owner:S-renewal-failure')).toBe(false)
  })

  it('finishes a preserved lease write before releasing ownership', async () => {
    const manager = new TestStreamLockManager()
    __setStreamLockManagerForTests(manager)
    const putStarted = deferred()
    const releasePut = deferred()
    let stored: StreamLeaseRow | undefined
    const deleteStreamLease = vi.fn(async () => true)
    const writeLease = async (lease: StreamLeaseRow) => {
      putStarted.resolve()
      await releasePut.promise
      stored = persistedLease(lease)
      return stored
    }
    __setWorkspaceRepositoryForTests({
      upsertStreamLease: writeLease,
      renewStreamLease: writeLease,
      deleteStreamLease,
      deleteOwnedStreamLease: deleteStreamLease,
    } as unknown as WorkspaceRepository)

    void startStreamLease(leaseInput('S-preserved'))
    await putStarted.promise
    void stopStreamLease('S-preserved', { deleteRow: false })

    expect(manager.isHeld('stream-owner:S-preserved')).toBe(true)
    releasePut.resolve()
    await Promise.all([__flushStreamLeaseWritesForTests(), __flushStreamOwnershipForTests()])

    expect(stored?.streamId).toBe('S-preserved')
    expect(deleteStreamLease).not.toHaveBeenCalled()
    expect(manager.isHeld('stream-owner:S-preserved')).toBe(false)
  })

  it('does not serialize heartbeat writes for different streams', async () => {
    const bothStarted = deferred()
    const releaseWrites = deferred()
    let concurrent = 0
    let maxConcurrent = 0
    const writeLease = async (lease: StreamLeaseRow) => {
      concurrent += 1
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      if (concurrent === 2) bothStarted.resolve()
      await releaseWrites.promise
      concurrent -= 1
      return persistedLease(lease)
    }
    __setWorkspaceRepositoryForTests({
      upsertStreamLease: writeLease,
      renewStreamLease: writeLease,
      deleteStreamLease: async () => true,
      deleteOwnedStreamLease: async () => true,
    } as unknown as WorkspaceRepository)

    void startStreamLease(leaseInput('S-left'))
    void startStreamLease(leaseInput('S-right'))
    await bothStarted.promise

    expect(maxConcurrent).toBe(2)
    void stopStreamLease('S-left')
    void stopStreamLease('S-right')
    releaseWrites.resolve()
    await __flushStreamLeaseWritesForTests()
  })

  it('holds a per-stream ownership lock and blocks recovery until the stream stops', async () => {
    const manager = new TestStreamLockManager()
    __setStreamLockManagerForTests(manager)
    __setWorkspaceRepositoryForTests({
      upsertStreamLease: async (lease: StreamLeaseRow) => persistedLease(lease),
      renewStreamLease: async (lease: StreamLeaseRow) => persistedLease(lease),
      deleteStreamLease: async () => true,
      deleteOwnedStreamLease: async () => true,
    } as unknown as WorkspaceRepository)
    const recover = vi.fn(async (ownershipVerified: boolean) => {
      expect(ownershipVerified).toBe(true)
      return 'recovered'
    })

    void startStreamLease(leaseInput('S-owned'))
    expect(manager.isHeld('stream-owner:S-owned')).toBe(true)

    await expect(withStreamRecoveryLocks(['S-owned'], recover)).resolves.toEqual({
      acquired: false,
    })
    expect(recover).not.toHaveBeenCalled()

    void stopStreamLease('S-owned', { deleteRow: false })
    await __flushStreamOwnershipForTests()
    await expect(withStreamRecoveryLocks(['S-owned'], recover)).resolves.toEqual({
      acquired: true,
      value: 'recovered',
    })
    expect(recover).toHaveBeenCalledTimes(1)
  })

  it('acquires recovery locks as one sorted guard and releases partial acquisition', async () => {
    const manager = new TestStreamLockManager()
    __setStreamLockManagerForTests(manager)
    __setWorkspaceRepositoryForTests({
      upsertStreamLease: async (lease: StreamLeaseRow) => persistedLease(lease),
      renewStreamLease: async (lease: StreamLeaseRow) => persistedLease(lease),
      deleteStreamLease: async () => true,
      deleteOwnedStreamLease: async () => true,
    } as unknown as WorkspaceRepository)
    void startStreamLease(leaseInput('S-right'))
    const recover = vi.fn(async () => undefined)

    await expect(
      withStreamRecoveryLocks(['S-right', 'S-left', 'S-left'], recover),
    ).resolves.toEqual({ acquired: false })
    expect(recover).not.toHaveBeenCalled()
    await expect(withStreamRecoveryLocks(['S-left'], recover)).resolves.toEqual({
      acquired: true,
      value: undefined,
    })
    expect(recover).toHaveBeenCalledTimes(1)

    void stopStreamLease('S-right', { deleteRow: false })
    await __flushStreamOwnershipForTests()
  })

  it("allows the caller's TTL-based recovery fallback when Web Locks are unavailable", async () => {
    __setStreamLockManagerForTests(null)

    await expect(
      withStreamRecoveryLocks(['S-fallback'], async (ownershipVerified) => {
        expect(ownershipVerified).toBe(false)
        return 42
      }),
    ).resolves.toEqual({ acquired: true, value: 42 })
  })

  it('propagates recovery failures after ownership is acquired', async () => {
    const manager = new TestStreamLockManager()
    __setStreamLockManagerForTests(manager)

    await expect(
      withStreamRecoveryLocks(['S-failing-recovery'], async () => {
        throw new Error('recovery failed')
      }),
    ).rejects.toThrow('recovery failed')
  })
})
