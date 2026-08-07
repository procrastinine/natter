import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import {
  __resetBrowserRepositoryForTests,
  getBrowserRepository,
} from '../../src/store/browser-repo'
import {
  openBrowserWorkspace,
  shutdownBrowserWorkspace,
} from '../../src/store/browser-workspace-lifecycle'
import { __resetDbForTests, getDb } from '../../src/store/db'
import type { FencedStreamLeaseRow } from '../../src/store/repository'
import {
  __resetStreamLeasesForTests,
  __setStreamLockManagerForTests,
  getStreamClientId,
} from '../../src/store/stream-leases'
import {
  streamRecoveryDiagnosticsSnapshot,
  streamRecoveryRuntimeSnapshot,
} from '../../src/store/stream-recovery'
import type { WorkspaceCommand, WorkspaceRepository } from '../../src/store/workspace-protocol'
import {
  __resetWorkspaceRepositoryForTests,
  __setWorkspaceRepositoryForTests,
  publishLocalWorkspaceInvalidation,
  readWorkspaceMeta,
} from '../../src/store/workspace-repository'
import { testGenerationLease } from '../helpers/stream-leases'

interface PendingLockRequest {
  acquire(): void
  cancel(): void
}

class ObservableExclusiveLockManager {
  private readonly held = new Set<string>()
  private readonly queues = new Map<string, PendingLockRequest[]>()
  private readonly requests: Array<{ name: string; ifAvailable: boolean }> = []
  private readonly aborts = new Map<string, number>()

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
    this.requests.push({ name, ifAvailable: options.ifAvailable === true })
    if (options.signal?.aborted) return Promise.reject(options.signal.reason)
    if (options.ifAvailable && this.held.has(name)) return Promise.resolve(callback(null))

    return new Promise<T>((resolve, reject) => {
      let settled = false
      let queued = false
      const detachAbort = () => options.signal?.removeEventListener('abort', request.cancel)
      const request: PendingLockRequest = {
        acquire: () => {
          if (settled) return
          queued = false
          if (options.signal?.aborted) {
            request.cancel()
            return
          }
          if (this.held.has(name)) {
            queued = true
            const queue = this.queues.get(name) ?? []
            queue.push(request)
            this.queues.set(name, queue)
            options.signal?.addEventListener('abort', request.cancel, { once: true })
            return
          }
          detachAbort()
          this.held.add(name)
          const lock = { name, mode: options.mode ?? 'exclusive' } as Lock
          void Promise.resolve(callback(lock)).then(
            (value) => {
              if (settled) return
              settled = true
              this.release(name)
              resolve(value)
            },
            (error) => {
              if (settled) return
              settled = true
              this.release(name)
              reject(error)
            },
          )
        },
        cancel: () => {
          if (settled) return
          settled = true
          detachAbort()
          if (queued) {
            const queue = this.queues.get(name)
            const index = queue?.indexOf(request) ?? -1
            if (queue && index >= 0) queue.splice(index, 1)
            if (queue?.length === 0) this.queues.delete(name)
          }
          this.aborts.set(name, (this.aborts.get(name) ?? 0) + 1)
          reject(options.signal?.reason ?? new DOMException('Aborted', 'AbortError'))
        },
      }
      request.acquire()
    })
  }

  hold(name: string): () => void {
    if (this.held.has(name)) throw new Error(`TestLockAlreadyHeld:${name}`)
    this.held.add(name)
    let released = false
    return () => {
      if (released) return
      released = true
      this.release(name)
    }
  }

  pendingCount(name: string): number {
    return this.queues.get(name)?.length ?? 0
  }

  requestCount(name: string): number {
    return this.requests.filter((request) => request.name === name).length
  }

  abortCount(name: string): number {
    return this.aborts.get(name) ?? 0
  }

  private release(name: string): void {
    this.held.delete(name)
    const queue = this.queues.get(name)
    const next = queue?.shift()
    if (queue?.length === 0) this.queues.delete(name)
    next?.acquire()
  }
}

interface LeaseQueryProbe {
  completed(): number
  nextCommandCompletion(kind: WorkspaceCommand['kind']): Promise<void>
}

function installLeaseQueryProbe(): LeaseQueryProbe {
  const target = getBrowserRepository()
  let completed = 0
  const commandWaiters = new Map<WorkspaceCommand['kind'], Set<() => void>>()
  const repository: WorkspaceRepository = {
    query: async (permit, query, options) => {
      const result = await target.query(permit, query, options)
      if (
        query.kind === 'stream.lease-head' ||
        query.kind === 'stream.leases' ||
        query.kind === 'stream.leases-by-id'
      ) {
        completed += 1
      }
      return result
    },
    execute: async (permit, command, options) => {
      const result = await target.execute(permit, command, options)
      const waiters = commandWaiters.get(command.kind)
      commandWaiters.delete(command.kind)
      for (const resolve of waiters ?? []) resolve()
      return result
    },
    replace: target.replace.bind(target),
    subscribeChanges: target.subscribeChanges.bind(target),
  }
  __setWorkspaceRepositoryForTests(repository)
  return {
    completed: () => completed,
    nextCommandCompletion: (kind) =>
      new Promise<void>((resolve) => {
        const waiters = commandWaiters.get(kind) ?? new Set<() => void>()
        waiters.add(resolve)
        commandWaiters.set(kind, waiters)
      }),
  }
}

async function openRecoveryRuntime(
  manager: ObservableExclusiveLockManager,
): Promise<LeaseQueryProbe> {
  __setStreamLockManagerForTests(manager)
  await openBrowserWorkspace()
  return installLeaseQueryProbe()
}

async function freshLease(streamId: string, ownerClientId: string): Promise<FencedStreamLeaseRow> {
  const workspace = await readWorkspaceMeta()
  const now = Date.now()
  return testGenerationLease({
    streamId,
    chatId: `chat:${streamId}`,
    messageId: `message:${streamId}`,
    ownerClientId,
    fenceToken: `fence:${streamId}`,
    replacementEpoch: workspace.replacementEpoch,
    startedAt: now,
    heartbeatAt: now,
    admissionSequence: 1,
    revision: 0,
    phase: 'reserved',
  })
}

async function publishLeaseInvalidation(streamId: string, probe: LeaseQueryProbe): Promise<void> {
  const before = probe.completed()
  const workspace = await readWorkspaceMeta()
  publishLocalWorkspaceInvalidation({
    kind: 'invalidate',
    workspaceId: workspace.workspaceId,
    replacementEpoch: workspace.replacementEpoch,
    dependencies: [{ kind: 'stream-lease', streamIds: [streamId] }],
  })
  await vi.waitFor(() => {
    expect(probe.completed()).toBeGreaterThan(before)
  })
}

async function putAndPublishLease(
  lease: FencedStreamLeaseRow,
  probe: LeaseQueryProbe,
): Promise<void> {
  await getDb().streamLeases.put(lease)
  await publishLeaseInvalidation(lease.streamId, probe)
}

async function waitForOwnershipWaiter(
  manager: ObservableExclusiveLockManager,
  streamId: string,
): Promise<void> {
  const lockName = `stream-owner:${streamId}`
  await vi.waitFor(() => {
    expect(manager.pendingCount(lockName)).toBe(1)
  })
}

async function resetBrowserWorkspace(): Promise<void> {
  __resetWorkspaceRepositoryForTests()
  __resetBrowserRepositoryForTests()
  __resetDbForTests()
  __resetBroadcastForTests()
  __resetStreamLeasesForTests()
  await Dexie.delete('natter')
}

beforeEach(async () => {
  await resetBrowserWorkspace()
})

afterEach(async () => {
  await shutdownBrowserWorkspace()
  await resetBrowserWorkspace()
})

describe('stream recovery lifecycle ownership', () => {
  it('stays cold without a lease, then starts from durable lease evidence and restarts', async () => {
    await openBrowserWorkspace()
    expect(streamRecoveryRuntimeSnapshot()).toMatchObject({
      installed: false,
      enabled: false,
      scheduledRetryCount: 0,
      quarantinedCount: 0,
    })

    const lease = await freshLease('lifecycle-evidence', getStreamClientId())
    const probe = installLeaseQueryProbe()
    await putAndPublishLease(lease, probe)
    await vi.waitFor(() => {
      expect(streamRecoveryRuntimeSnapshot()).toMatchObject({
        installed: true,
        enabled: true,
        accepting: true,
      })
    })

    await shutdownBrowserWorkspace()
    expect(streamRecoveryRuntimeSnapshot()).toMatchObject({
      installed: true,
      enabled: false,
      scheduledRetryCount: 0,
      quarantinedCount: 0,
    })
    expect(streamRecoveryDiagnosticsSnapshot()).toEqual([])

    await openBrowserWorkspace()
    await vi.waitFor(() => {
      expect(streamRecoveryRuntimeSnapshot()).toMatchObject({ installed: true, enabled: true })
    })
  })

  it('arms one waiter for a fresh remote ownership identity and recovers on release without TTL', async () => {
    const manager = new ObservableExclusiveLockManager()
    const probe = await openRecoveryRuntime(manager)
    let lease = await freshLease('remote-heartbeats', 'remote-client')
    const lockName = `stream-owner:${lease.streamId}`
    const release = manager.hold(lockName)

    try {
      await putAndPublishLease(lease, probe)
      await waitForOwnershipWaiter(manager, lease.streamId)
      expect(manager.requestCount(lockName)).toBe(2)

      for (let revision = 1; revision <= 3; revision += 1) {
        lease = {
          ...lease,
          heartbeatAt: lease.heartbeatAt + 1_000,
          revision,
        }
        await putAndPublishLease(lease, probe)
        expect(manager.pendingCount(lockName)).toBe(1)
        expect(manager.requestCount(lockName)).toBe(2)
      }

      const completedBeforeRelease = probe.completed()
      const cleanupCompleted = probe.nextCommandCompletion('stream.finish-cleanup')
      release()
      await vi.waitFor(() => {
        expect(probe.completed()).toBeGreaterThan(completedBeforeRelease)
      })
      await cleanupCompleted
      expect(await getDb().streamLeases.get(lease.streamId)).toBeUndefined()
      expect(manager.pendingCount(lockName)).toBe(0)
    } finally {
      release()
    }
  })

  it("does not arm an ownership waiter for this tab's own fresh lease", async () => {
    const manager = new ObservableExclusiveLockManager()
    const probe = await openRecoveryRuntime(manager)
    const lease = await freshLease('local-owner', getStreamClientId())
    const lockName = `stream-owner:${lease.streamId}`

    await putAndPublishLease(lease, probe)

    expect(manager.pendingCount(lockName)).toBe(0)
    expect(manager.requestCount(lockName)).toBe(0)
    expect(await getDb().streamLeases.get(lease.streamId)).toEqual(lease)
  })

  it.each(['deletion', 'teardown'] as const)(
    '%s aborts the pending ownership waiter',
    async (cause) => {
      const manager = new ObservableExclusiveLockManager()
      const probe = await openRecoveryRuntime(manager)
      const lease = await freshLease(`cancel-on-${cause}`, 'remote-client')
      const lockName = `stream-owner:${lease.streamId}`
      const release = manager.hold(lockName)

      try {
        await putAndPublishLease(lease, probe)
        await waitForOwnershipWaiter(manager, lease.streamId)

        if (cause === 'deletion') {
          await getDb().streamLeases.delete(lease.streamId)
          await publishLeaseInvalidation(lease.streamId, probe)
        } else {
          await shutdownBrowserWorkspace()
        }

        expect(manager.pendingCount(lockName)).toBe(0)
        expect(manager.abortCount(lockName)).toBe(1)
      } finally {
        release()
      }
    },
  )
})
