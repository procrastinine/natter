import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { reduceAttemptAvailability } from '../../src/store/attempt-availability'
import { requestAttemptStop } from '../../src/store/attempt-control-application'
import { attemptController, attemptStopCapability } from '../../src/store/attempt-controller'
import {
  isStreamLeaseRow,
  type StreamLeaseRow,
  type WriterStreamLeaseRow,
} from '../../src/store/repository'
import {
  classifyStreamLeaseWallClockFreshness,
  isFreshStreamLease,
  observeStreamLeaseFreshness,
  streamLeaseRecoveryAuthority,
} from '../../src/store/stream-lease-policy'
import {
  __resetStreamLeasesForTests,
  __runStreamLeaseHeartbeatSchedulerForTests,
  __setStreamLockManagerForTests,
  adoptPreparedStreamLease,
  awaitStreamLeaseRuntimeIdle,
  disposeStreamLeaseRuntime,
  getStreamClientId,
  isRecoveryClaimedStreamLease,
  observeStreamOwnershipLock,
  releaseStreamOwnershipReservation,
  reserveStreamOwnership,
  resumeStreamLeaseRuntime,
  runWithStreamRecoveryCoordinatorLock,
  streamWriteFenceForLease,
  waitForStreamOwnershipRelease,
  withStreamRecoveryLocks,
} from '../../src/store/stream-leases'
import {
  prepareLocalWorkspaceChange,
  publishPreparedWorkspaceEffect,
} from '../../src/store/workspace-effect-hub'
import type {
  ReadEnvelope,
  WorkspaceCommand,
  WorkspaceQuery,
  WorkspaceQueryResult,
  WorkspaceRepository,
} from '../../src/store/workspace-protocol'
import {
  __resetWorkspaceRepositoryForTests,
  __setWorkspaceRepositoryForTests,
} from '../../src/store/workspace-repository'
import {
  reserveWorkspaceChild,
  runWorkspaceAction,
  subscribeWorkspaceRuntimeIdle,
  tryRunWorkspaceActionIfIdle,
  workspaceRuntimeInternal,
} from '../../src/store/workspace-runtime'
import {
  type TestGenerationLeaseInput,
  testContinuationLease,
  testGenerationLease,
  testRecoveryPendingLease,
  testStreamLeaseAdmission,
} from '../helpers/stream-leases'

const FENCE = Object.freeze({ workspaceId: 'stream-lease-workspace', replacementEpoch: 0 })
const LOCAL_APPLICATIONS = {
  postCommitMetadata: () => 'applied' as const,
  cleanup: () => 'applied' as const,
  handoff: () => 'applied' as const,
}

class TestStreamLockManager {
  private readonly held = new Set<string>()
  private readonly queues = new Map<string, Array<() => void>>()
  readonly requested: string[] = []

  request<T>(
    name: string,
    optionsOrCallback: LockOptions | ((lock: Lock | null) => T | PromiseLike<T>),
    maybeCallback?: (lock: Lock | null) => T | PromiseLike<T>,
  ): Promise<T> {
    this.requested.push(name)
    const options = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback
    const callback =
      typeof optionsOrCallback === 'function'
        ? optionsOrCallback
        : (maybeCallback as NonNullable<typeof maybeCallback>)
    if (options.signal?.aborted) return Promise.reject(options.signal.reason)
    if (options.ifAvailable && this.held.has(name)) return Promise.resolve(callback(null))
    return new Promise<T>((resolve, reject) => {
      const acquire = () => {
        if (options.signal?.aborted) {
          reject(options.signal.reason)
          return
        }
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
            this.release(name)
            resolve(value)
          },
          (error) => {
            this.release(name)
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

  private release(name: string): void {
    this.held.delete(name)
    const queue = this.queues.get(name)
    const next = queue?.shift()
    if (queue?.length === 0) this.queues.delete(name)
    next?.()
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function lease(overrides: Omit<TestGenerationLeaseInput, 'phase'> = {}) {
  return testGenerationLease({
    streamId: 'stream-1',
    chatId: 'chat-1',
    messageId: 'message-1',
    ownerClientId: getStreamClientId(),
    fenceToken: 'fence-1',
    replacementEpoch: FENCE.replacementEpoch,
    startedAt: 1,
    heartbeatAt: 1,
    admissionSequence: 1,
    revision: 1,
    targetCommittedAt: 1,
    ...overrides,
  })
}

async function reserveLeaseOwnership(
  currentLease: ReturnType<typeof lease>,
  abortTransport: () => void = () => undefined,
) {
  return runWorkspaceAction('conversation-generation', (permit) =>
    reserveStreamOwnership(
      reserveWorkspaceChild(permit, 'stream-lease'),
      testStreamLeaseAdmission(currentLease),
      abortTransport,
    ),
  )
}

async function adoptLeaseOwnership(
  currentLease: ReturnType<typeof lease>,
  abortTransport: () => void = () => undefined,
) {
  const reservation = await reserveLeaseOwnership(currentLease, abortTransport)
  return adoptPreparedStreamLease(reservation, currentLease, LOCAL_APPLICATIONS)
}

function publishStopRequested(input: {
  streamId?: string
  chatId?: string
  messageId?: string
  attemptKind?: 'generation' | 'continuation'
  admissionSequence?: number
  controlRevision?: number
  workspaceId?: string
  replacementEpoch?: number
}) {
  const workspaceId = input.workspaceId ?? FENCE.workspaceId
  const replacementEpoch = input.replacementEpoch ?? FENCE.replacementEpoch
  const prepared = prepareLocalWorkspaceChange({
    kind: 'commit',
    stamp: {
      workspaceId,
      replacementEpoch,
      commitId: `stop:${input.streamId ?? 'stream-1'}`,
    },
    delta: {
      facts: [
        {
          kind: 'attempt-stop-requested',
          streamId: input.streamId ?? 'stream-1',
          chatId: input.chatId ?? 'chat-1',
          messageId: input.messageId ?? 'message-1',
          attemptKind: input.attemptKind ?? 'generation',
          admissionSequence: input.admissionSequence ?? 1,
          controlRevision: input.controlRevision ?? 1,
          requestId: 'stop-request-1',
          requestedBy: 'remote-tab',
          requestedAt: 2,
          reason: 'user',
        },
      ],
      invalidations: [],
    },
  })
  publishPreparedWorkspaceEffect(prepared.effect)
}

function commit<T>(value: T) {
  return {
    ...FENCE,
    commitId: 'commit-1',
    effectScope: 'none',
    value,
    receipt: { chats: [], constructions: [], messageRevisions: [], childSlots: [] },
    delta: { facts: [], invalidations: [] },
  }
}

function observeLocalLease(lease: StreamLeaseRow): void {
  attemptController.observeLease(lease, {
    workspaceId: FENCE.workspaceId,
    localAuthority: {
      kind: 'writer',
      workspaceId: FENCE.workspaceId,
      lease: lease as WriterStreamLeaseRow,
    },
  })
}

function repositoryWithExecute(
  execute: (command: WorkspaceCommand) => Promise<ReturnType<typeof commit>>,
  readLease?: (streamId: string) => StreamLeaseRow | undefined,
): WorkspaceRepository {
  return {
    query: async <Q extends WorkspaceQuery>(
      _permit: unknown,
      query: Q,
    ): Promise<ReadEnvelope<WorkspaceQueryResult<Q>>> => {
      if (query.kind !== 'stream.lease' || !readLease) {
        throw new Error(`UnexpectedQuery:${query.kind}`)
      }
      return { ...FENCE, value: readLease(query.streamId) } as ReadEnvelope<WorkspaceQueryResult<Q>>
    },
    execute: (_permit: unknown, command: WorkspaceCommand) => execute(command),
    replace: vi.fn(),
    subscribeChanges: () => () => {},
  } as unknown as WorkspaceRepository
}

beforeAll(() => {
  if (workspaceRuntimeInternal.snapshot().state === 'STARTING') {
    workspaceRuntimeInternal.beginReconciliation(FENCE)
    workspaceRuntimeInternal.finishReconciliation(FENCE)
  }
})

beforeEach(() => {
  for (const attempt of attemptController.listRecords()) {
    attemptController.remove(attempt.streamId, attempt)
  }
  attemptController.replaceWorkspace(FENCE)
  __resetStreamLeasesForTests({ admissionsOpen: true })
  resumeStreamLeaseRuntime()
  __resetWorkspaceRepositoryForTests()
})

afterEach(async () => {
  __resetStreamLeasesForTests({ admissionsOpen: true })
  await awaitStreamLeaseRuntimeIdle()
  __resetWorkspaceRepositoryForTests()
  vi.useRealTimers()
})

describe('stream lease value and recovery-lock contracts', () => {
  it('accepts the complete lifecycle cross-product and rejects one-field contradictions', () => {
    const phases = [
      'reserved',
      'active',
      'terminal-decided',
      'canonical',
      'metadata-committed',
    ] as const
    const attempts = ['generation', 'continuation'] as const
    const custodies = ['writer', 'recovery', 'recovery-pending'] as const
    let legalShapeCount = 0
    let rejectedShapeCount = 0

    for (const attemptKind of attempts) {
      for (const phase of phases) {
        for (const custody of custodies) {
          const variants: StreamLeaseRow[] = [
            custody === 'recovery-pending'
              ? testRecoveryPendingLease({ attemptKind, phase })
              : attemptKind === 'generation'
                ? testGenerationLease({ phase, custody })
                : testContinuationLease({ phase, custody }),
          ]
          if (
            phase === 'terminal-decided' ||
            phase === 'canonical' ||
            phase === 'metadata-committed'
          ) {
            variants.push(
              custody === 'recovery-pending'
                ? testRecoveryPendingLease({ attemptKind, phase, dispatched: false })
                : attemptKind === 'generation'
                  ? testGenerationLease({ phase, custody, dispatched: false })
                  : testContinuationLease({ phase, custody, dispatched: false }),
            )
          }

          for (const legal of variants) {
            const label = JSON.stringify({ attemptKind, phase, custody, dispatch: legal.dispatch })
            expect(isStreamLeaseRow(legal), label).toBe(true)
            legalShapeCount += 1
            const stopped = {
              ...legal,
              controlRevision: 1,
              stopControl: {
                requestId: 'request-1',
                requestedBy: 'tab-a',
                requestedAt: 2,
                reason: 'user' as const,
              },
            }
            expect(isStreamLeaseRow(stopped), label).toBe(true)
            legalShapeCount += 1
            const contradictions: Array<Record<string, unknown>> = [
              { ...legal, streamId: '' },
              { ...legal, revision: -1 },
              legal.custody === 'recovery-pending'
                ? { ...legal, ownerClientId: 'forbidden-owner' }
                : { ...legal, fenceToken: undefined },
              phase === 'reserved'
                ? { ...legal, dispatch: null }
                : phase === 'active'
                  ? { ...legal, dispatch: null }
                  : phase === 'terminal-decided'
                    ? { ...legal, terminal: undefined }
                    : phase === 'canonical'
                      ? { ...legal, canonicalAt: undefined }
                      : { ...legal, metadataCommittedAt: undefined },
              phase === 'canonical' || phase === 'metadata-committed'
                ? { ...legal, postCommit: { ...legal.postCommit, final: undefined } }
                : {
                    ...legal,
                    postCommit: {
                      ...legal.postCommit,
                      final: { completionAllowed: false },
                    },
                  },
              { ...legal, controlRevision: 1 },
              { ...legal, stopControl: stopped.stopControl },
              { ...stopped, controlRevision: 0 },
              { ...stopped, stopControl: undefined },
              phase === 'reserved' || phase === 'active' || phase === 'terminal-decided'
                ? { ...legal, targetOwnerKey: undefined }
                : { ...legal, targetOwnerKey: legal.messageId },
            ]
            if (legal.phase !== 'reserved' && legal.dispatch !== null) {
              contradictions.push(
                legal.attemptKind === 'generation'
                  ? {
                      ...legal,
                      dispatch: {
                        ...legal.dispatch,
                        continuationStrategy: 'prompt',
                        baseNodeVersion: 1,
                        baseBodyVersion: 1,
                      },
                    }
                  : {
                      ...legal,
                      dispatch: { ...legal.dispatch, baseBodyVersion: undefined },
                    },
              )
            }
            for (const contradiction of contradictions) {
              expect(isStreamLeaseRow(contradiction), label).toBe(false)
              rejectedShapeCount += 1
            }
          }
        }
      }
    }

    expect(legalShapeCount).toBe(96)
    expect(rejectedShapeCount).toBe(504)
  })

  it('never treats an arbitrary future heartbeat as durable freshness', () => {
    const future = lease({ heartbeatAt: 1_000_000, revision: 1 })
    expect(classifyStreamLeaseWallClockFreshness(future, 1_000)).toBe('future')
    expect(isFreshStreamLease(future, 1_000)).toBe(false)
    expect(
      reduceAttemptAvailability(undefined, {
        workspace: FENCE,
        lease: { kind: 'present', lease: future },
        localAuthority: { kind: 'none' },
        ownershipLock: { kind: 'unsupported' },
        wallNow: 1_000,
        schedulerNow: 1_000,
      }).blocksReplacement,
    ).toBe(true)

    const first = observeStreamLeaseFreshness(future, 1_000, 100)
    const unchanged = observeStreamLeaseFreshness(future, 500, 1_000, first)
    const expired = observeStreamLeaseFreshness(future, 500, first.deadline, unchanged)
    const renewed = observeStreamLeaseFreshness(
      { ...future, revision: 2, heartbeatAt: 500 },
      500,
      first.deadline,
      expired,
    )

    expect(unchanged.deadline).toBe(first.deadline)
    expect(expired.fresh).toBe(false)
    expect(renewed.fresh).toBe(true)
    expect(renewed.epoch).not.toBe(expired.epoch)
  })

  it('derives recovery authority only from ownership release or freshness expiry', () => {
    const progressStates = [
      'reserved',
      'active',
      'terminal-decided',
      'canonical',
      'metadata-committed',
    ] as const

    for (const progress of progressStates) {
      for (const custody of ['writer', 'recovery'] as const) {
        for (const ownershipVerified of [false, true]) {
          for (const freshnessProtected of [false, true]) {
            expect(
              streamLeaseRecoveryAuthority({ custody, ownershipVerified, freshnessProtected }),
              JSON.stringify({ progress, custody, ownershipVerified, freshnessProtected }),
            ).toBe(
              custody === 'recovery' || ownershipVerified || !freshnessProtected
                ? 'recover'
                : 'defer',
            )
          }
        }
      }
    }
  })

  it('projects the complete durable write fence', () => {
    expect(streamWriteFenceForLease(lease())).toEqual({
      ownerClientId: getStreamClientId(),
      fenceToken: 'fence-1',
      replacementEpoch: 0,
      admissionSequence: 1,
    })
  })

  it('recognizes only explicit recovery owners', () => {
    expect(isRecoveryClaimedStreamLease(lease({ custody: 'recovery' }))).toBe(true)
    expect(isRecoveryClaimedStreamLease(testRecoveryPendingLease())).toBe(true)
    expect(isRecoveryClaimedStreamLease(lease({ custody: 'writer' }))).toBe(false)
  })

  it('runs recovery without verification when Web Locks are unavailable', async () => {
    __setStreamLockManagerForTests(null)
    const recover = vi.fn(async (verified: boolean) => verified)

    await expect(withStreamRecoveryLocks(['stream-1'], recover)).resolves.toEqual({
      acquired: true,
      value: false,
    })
    expect(recover).toHaveBeenCalledWith(false)
  })

  it('deduplicates and orders exclusive ownership checks before recovery', async () => {
    const manager = new TestStreamLockManager()
    __setStreamLockManagerForTests(manager)
    const recover = vi.fn(async (verified: boolean) => verified)

    await expect(
      withStreamRecoveryLocks(['stream-b', 'stream-a', 'stream-b'], recover),
    ).resolves.toEqual({ acquired: true, value: true })
    expect(manager.requested).toEqual(['stream-owner:stream-a', 'stream-owner:stream-b'])
    expect(recover).toHaveBeenCalledWith(true)
  })

  it('does not run recovery when any ownership lock is unavailable', async () => {
    const manager = new TestStreamLockManager()
    __setStreamLockManagerForTests(manager)
    const release = deferred()
    const owner = manager.request('stream-owner:stream-b', async () => release.promise)
    const recover = vi.fn(async () => true)

    await expect(withStreamRecoveryLocks(['stream-a', 'stream-b'], recover)).resolves.toEqual({
      acquired: false,
    })
    expect(recover).not.toHaveBeenCalled()
    release.resolve()
    await owner
  })

  it('reports exact ownership-lock evidence without retaining the probe lock', async () => {
    const manager = new TestStreamLockManager()
    __setStreamLockManagerForTests(manager)
    const release = deferred()
    const owner = manager.request('stream-owner:stream-1', async () => release.promise)

    await expect(observeStreamOwnershipLock('stream-1')).resolves.toMatchObject({
      kind: 'held-by-other',
      streamId: 'stream-1',
    })

    release.resolve()
    await owner
    await expect(observeStreamOwnershipLock('stream-1')).resolves.toEqual({
      kind: 'acquired-for-recovery',
      streamId: 'stream-1',
    })
    expect(manager.isHeld('stream-owner:stream-1')).toBe(false)
  })

  it('waits for ownership release and respects cancellation', async () => {
    const manager = new TestStreamLockManager()
    __setStreamLockManagerForTests(manager)
    const release = deferred()
    const owner = manager.request('stream-owner:stream-1', async () => release.promise)
    const controller = new AbortController()
    const waiting = waitForStreamOwnershipRelease('stream-1', controller.signal)

    release.resolve()
    await owner
    await expect(waiting).resolves.toBe(true)

    const cancelled = new AbortController()
    cancelled.abort()
    await expect(waitForStreamOwnershipRelease('stream-1', cancelled.signal)).resolves.toBe(false)
  })

  it('serializes recovery coordination per workspace', async () => {
    const manager = new TestStreamLockManager()
    __setStreamLockManagerForTests(manager)
    const release = deferred()
    const firstStarted = deferred()
    const first = runWithStreamRecoveryCoordinatorLock(
      FENCE.workspaceId,
      new AbortController().signal,
      async () => {
        firstStarted.resolve()
        await release.promise
      },
    )
    await firstStarted.promise
    let secondRan = false
    const second = runWithStreamRecoveryCoordinatorLock(
      FENCE.workspaceId,
      new AbortController().signal,
      async () => {
        secondRan = true
      },
    )
    await Promise.resolve()
    expect(secondRan).toBe(false)

    release.resolve()
    await Promise.all([first, second])
    expect(secondRan).toBe(true)
  })
})

describe('owned stream lease lifetime', () => {
  it('releases the workspace child when ownership reservation is rejected', async () => {
    const onIdle = vi.fn()
    const unsubscribe = subscribeWorkspaceRuntimeIdle(onIdle)
    const failure = await runWorkspaceAction('conversation-generation', async (permit) => {
      const currentLease = lease({ ownerClientId: 'another-stream-client' })
      return reserveStreamOwnership(
        reserveWorkspaceChild(permit, 'stream-lease'),
        testStreamLeaseAdmission(currentLease),
        () => undefined,
      ).catch((error: unknown) => error)
    })

    expect(failure).toEqual(new Error('StreamOwnershipReservationFenceMismatch:stream-1'))
    expect(onIdle).toHaveBeenCalledOnce()
    const next = tryRunWorkspaceActionIfIdle('maintenance', async () => undefined)
    expect(next).not.toBeNull()
    await next
    unsubscribe()
  })

  it('releases the workspace child when stream-lock acquisition fails', async () => {
    const lockFailure = new Error('StreamLockAcquisitionFailed')
    __setStreamLockManagerForTests({
      request: () => Promise.reject(lockFailure),
    })
    const onIdle = vi.fn()
    const unsubscribe = subscribeWorkspaceRuntimeIdle(onIdle)
    const failure = await runWorkspaceAction('conversation-generation', async (permit) =>
      reserveStreamOwnership(
        reserveWorkspaceChild(permit, 'stream-lease'),
        testStreamLeaseAdmission(lease()),
        () => undefined,
      ).catch((error: unknown) => error),
    )

    expect(failure).toBe(lockFailure)
    expect(onIdle).toHaveBeenCalledOnce()
    const next = tryRunWorkspaceActionIfIdle('maintenance', async () => undefined)
    expect(next).not.toBeNull()
    await next
    unsubscribe()
  })

  it('holds stream ownership while the durable lease is still only reserved', async () => {
    const manager = new TestStreamLockManager()
    __setStreamLockManagerForTests(manager)
    const reservation = await reserveLeaseOwnership(lease())

    expect(manager.isHeld('stream-owner:stream-1')).toBe(true)
    expect(() => disposeStreamLeaseRuntime()).toThrow(
      'StreamLeaseWriterLifetimeViolation:runtime-disposal:0:1',
    )

    await releaseStreamOwnershipReservation(reservation)
  })

  it('authenticates pre-adoption Stop evidence against the durable lease before aborting once', async () => {
    let currentLease = lease()
    const abortTransport = vi.fn()
    __setWorkspaceRepositoryForTests(
      repositoryWithExecute(
        async (command) => {
          if (command.kind === 'stream.handoff-recovery') return commit(currentLease)
          throw new Error(`UnexpectedCommand:${command.kind}`)
        },
        () => currentLease,
      ),
    )
    const reservation = await reserveLeaseOwnership(currentLease, abortTransport)

    publishStopRequested({ admissionSequence: 2 })
    publishStopRequested({ chatId: 'other-chat' })
    publishStopRequested({ messageId: 'other-message' })
    publishStopRequested({ attemptKind: 'continuation' })
    publishStopRequested({ replacementEpoch: 1 })
    publishStopRequested({ workspaceId: 'other-workspace' })
    expect(abortTransport).not.toHaveBeenCalled()
    publishStopRequested({})
    publishStopRequested({})
    publishStopRequested({ streamId: 'sibling-stream' })
    expect(abortTransport).not.toHaveBeenCalled()

    currentLease = lease({
      revision: currentLease.revision + 1,
      controlRevision: 1,
      stopControl: {
        requestId: 'stop-request-1',
        requestedBy: 'remote-tab',
        requestedAt: 2,
        reason: 'user',
      },
    })
    const handle = await adoptPreparedStreamLease(reservation, lease(), LOCAL_APPLICATIONS)

    expect(abortTransport).toHaveBeenCalledOnce()
    publishStopRequested({})
    expect(abortTransport).toHaveBeenCalledOnce()
    await handle.retire({ mode: 'handoff', reason: 'finalize-failed' })
  })

  it('does not let stale pre-adoption Stop evidence abort the current admission', async () => {
    const currentLease = lease()
    const abortTransport = vi.fn()
    __setWorkspaceRepositoryForTests(
      repositoryWithExecute(
        async (command) => {
          if (command.kind === 'stream.handoff-recovery') return commit(currentLease)
          throw new Error(`UnexpectedCommand:${command.kind}`)
        },
        () => currentLease,
      ),
    )
    const reservation = await reserveLeaseOwnership(currentLease, abortTransport)
    publishStopRequested({ admissionSequence: 2 })

    const handle = await adoptPreparedStreamLease(reservation, currentLease, LOCAL_APPLICATIONS)

    expect(abortTransport).not.toHaveBeenCalled()
    await handle.retire({ mode: 'handoff', reason: 'finalize-failed' })
  })

  it('claims one exact Stop intent synchronously and commits it without blocking a sibling', async () => {
    attemptController.replaceWorkspace(FENCE)
    const currentLease = lease()
    const siblingLease = lease({
      streamId: 'stream-2',
      messageId: 'message-2',
      fenceToken: 'fence-2',
      admissionSequence: 2,
    })
    observeLocalLease(currentLease)
    observeLocalLease(siblingLease)
    const releaseCommit = deferred()
    const execute = vi.fn(async (command: WorkspaceCommand) => {
      if (command.kind !== 'attempt.request-stop') {
        throw new Error(`UnexpectedCommand:${command.kind}`)
      }
      await releaseCommit.promise
      return commit({
        outcome: 'accepted' as const,
        lease: lease({
          revision: 2,
          controlRevision: 1,
          stopControl: {
            requestId: command.input.requestId,
            requestedBy: command.input.requestedBy,
            requestedAt: command.input.requestedAt,
            reason: 'user',
          },
        }),
      })
    })
    __setWorkspaceRepositoryForTests(repositoryWithExecute(execute))
    const capability = attemptStopCapability(attemptController.getExecution('stream-1'))
    if (!capability || capability.kind !== 'requestable') {
      throw new Error('ExpectedRequestableStopCapability')
    }

    const request = requestAttemptStop(capability, 2)

    expect(request.claimed).toBe(true)
    expect(attemptStopCapability(attemptController.getExecution('stream-1'))?.kind).toBe(
      'requesting',
    )
    expect(attemptStopCapability(attemptController.getExecution('stream-2'))?.kind).toBe(
      'requestable',
    )
    const duplicate = requestAttemptStop(capability, 3)
    expect(duplicate.claimed).toBe(false)
    await expect(duplicate.completed).resolves.toEqual({ outcome: 'stale' })
    expect(execute).toHaveBeenCalledOnce()

    releaseCommit.resolve()
    await expect(request.completed).resolves.toMatchObject({ outcome: 'accepted' })
    expect(attemptStopCapability(attemptController.getExecution('stream-1'))?.kind).toBe(
      'requested',
    )
    expect(attemptStopCapability(attemptController.getExecution('stream-2'))?.kind).toBe(
      'requestable',
    )
  })

  it('interrupts the matching local transport when the Stop intent is claimed', async () => {
    const currentLease = lease()
    const abortTransport = vi.fn()
    const releaseCommit = deferred()
    __setWorkspaceRepositoryForTests(
      repositoryWithExecute(async (command) => {
        if (command.kind === 'stream.handoff-recovery') return commit(currentLease)
        if (command.kind !== 'attempt.request-stop') {
          throw new Error(`UnexpectedCommand:${command.kind}`)
        }
        await releaseCommit.promise
        return commit({
          outcome: 'accepted' as const,
          lease: lease({
            revision: 2,
            controlRevision: 1,
            stopControl: {
              requestId: command.input.requestId,
              requestedBy: command.input.requestedBy,
              requestedAt: command.input.requestedAt,
              reason: 'user',
            },
          }),
        })
      }),
    )
    const handle = await adoptLeaseOwnership(currentLease, abortTransport)
    observeLocalLease(currentLease)
    const capability = attemptStopCapability(attemptController.getExecution('stream-1'))
    if (!capability || capability.kind !== 'requestable') {
      throw new Error('ExpectedRequestableStopCapability')
    }

    const request = requestAttemptStop(capability, 2)

    expect(request.claimed).toBe(true)
    expect(abortTransport).toHaveBeenCalledOnce()
    releaseCommit.resolve()
    await expect(request.completed).resolves.toMatchObject({ outcome: 'accepted' })
    publishStopRequested({})
    expect(abortTransport).toHaveBeenCalledOnce()
    await handle.retire({ mode: 'handoff', reason: 'finalize-failed' })
  })

  it('retains its exact level-triggered Stop intent when the durable command fails', async () => {
    attemptController.replaceWorkspace(FENCE)
    const currentLease = lease()
    observeLocalLease(currentLease)
    const failure = new Error('durable Stop failed')
    __setWorkspaceRepositoryForTests(
      repositoryWithExecute(async (command) => {
        if (command.kind !== 'attempt.request-stop') {
          throw new Error(`UnexpectedCommand:${command.kind}`)
        }
        throw failure
      }),
    )
    const capability = attemptStopCapability(attemptController.getExecution('stream-1'))
    if (!capability || capability.kind !== 'requestable') {
      throw new Error('ExpectedRequestableStopCapability')
    }

    const request = requestAttemptStop(capability, 2)

    expect(attemptStopCapability(attemptController.getExecution('stream-1'))?.kind).toBe(
      'requesting',
    )
    await expect(request.completed).rejects.toBe(failure)
    expect(attemptStopCapability(attemptController.getExecution('stream-1'))?.kind).toBe(
      'requesting',
    )
  })

  it('delivers an exact durable Stop fact to the active writer once', async () => {
    const currentLease = lease()
    const abortTransport = vi.fn()
    __setWorkspaceRepositoryForTests(
      repositoryWithExecute(async (command) => {
        if (command.kind === 'stream.handoff-recovery') return commit(currentLease)
        throw new Error(`UnexpectedCommand:${command.kind}`)
      }),
    )
    const handle = await adoptLeaseOwnership(currentLease, abortTransport)

    publishStopRequested({})
    publishStopRequested({})
    publishStopRequested({ admissionSequence: 2, controlRevision: 2 })

    expect(abortTransport).toHaveBeenCalledOnce()
    await handle.retire({ mode: 'handoff', reason: 'finalize-failed' })
  })

  it('observes missed durable Stop delivery on the existing heartbeat write', async () => {
    const abortTransport = vi.fn()
    let currentLease = lease()
    __setWorkspaceRepositoryForTests(
      repositoryWithExecute(async (command) => {
        if (command.kind === 'stream.renew') {
          currentLease = lease({
            revision: currentLease.revision + 1,
            heartbeatAt: command.heartbeat.heartbeatAt,
            controlRevision: 1,
            stopControl: {
              requestId: 'missed-stop',
              requestedBy: 'remote-tab',
              requestedAt: 2,
              reason: 'user',
            },
          })
          return commit(currentLease)
        }
        if (command.kind === 'stream.handoff-recovery') return commit(currentLease)
        throw new Error(`UnexpectedCommand:${command.kind}`)
      }),
    )
    const handle = await adoptLeaseOwnership(currentLease, abortTransport)

    __runStreamLeaseHeartbeatSchedulerForTests(25_000)
    await vi.waitFor(() => expect(abortTransport).toHaveBeenCalledOnce())
    await handle.retire({ mode: 'handoff', reason: 'finalize-failed' })
  })

  it('rejects contended ownership before the second durable lease can be adopted', async () => {
    const manager = new TestStreamLockManager()
    __setStreamLockManagerForTests(manager)
    const currentLease = lease()
    const first = await reserveLeaseOwnership(currentLease)

    await expect(reserveLeaseOwnership(currentLease)).rejects.toThrow(
      'StreamLeaseAlreadyOwned:stream-1',
    )
    expect(manager.isHeld('stream-owner:stream-1')).toBe(true)

    await releaseStreamOwnershipReservation(first)
  })

  it('releases both stream ownership and its workspace permit before returning', async () => {
    const manager = new TestStreamLockManager()
    __setStreamLockManagerForTests(manager)
    const onIdle = vi.fn()
    const unsubscribe = subscribeWorkspaceRuntimeIdle(onIdle)
    const reservation = await reserveLeaseOwnership(lease())

    expect(manager.isHeld('stream-owner:stream-1')).toBe(true)
    expect(tryRunWorkspaceActionIfIdle('maintenance', async () => undefined)).toBeNull()
    expect(onIdle).not.toHaveBeenCalled()

    await releaseStreamOwnershipReservation(reservation)

    expect(manager.isHeld('stream-owner:stream-1')).toBe(false)
    expect(onIdle).toHaveBeenCalledTimes(1)
    const next = tryRunWorkspaceActionIfIdle('maintenance', async () => undefined)
    expect(next).not.toBeNull()
    await next
    unsubscribe()
  })

  it('rejects a mismatched committed lease and releases its reservation resources', async () => {
    const manager = new TestStreamLockManager()
    __setStreamLockManagerForTests(manager)
    const reservation = await reserveLeaseOwnership(lease())

    await expect(
      adoptPreparedStreamLease(
        reservation,
        lease({ fenceToken: 'different-durable-fence' }),
        LOCAL_APPLICATIONS,
      ),
    ).rejects.toThrow('PreparedStreamLeaseFenceMismatch:stream-1')

    expect(manager.isHeld('stream-owner:stream-1')).toBe(false)
    const next = tryRunWorkspaceActionIfIdle('maintenance', async () => undefined)
    expect(next).not.toBeNull()
    await next
  })

  it('keeps the shared heartbeat scheduler live across wall-clock rollback', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    __setStreamLockManagerForTests(new TestStreamLockManager())
    let currentLease = lease()
    const heartbeats: number[] = []
    __setWorkspaceRepositoryForTests(
      repositoryWithExecute(async (command) => {
        if (command.kind === 'stream.renew') {
          heartbeats.push(command.heartbeat.heartbeatAt)
          currentLease = {
            ...currentLease,
            heartbeatAt: command.heartbeat.heartbeatAt,
            revision: currentLease.revision + 1,
          }
          return commit(currentLease)
        }
        if (command.kind === 'stream.handoff-recovery') return commit(currentLease)
        throw new Error(`UnexpectedCommand:${command.kind}`)
      }),
    )
    const handle = await adoptLeaseOwnership(currentLease)

    vi.setSystemTime(1_000)
    await vi.advanceTimersByTimeAsync(2_000)
    await Promise.resolve()
    await Promise.resolve()

    expect(heartbeats).toEqual([3_000])
    await handle.retire({ mode: 'handoff', reason: 'finalize-failed' })
  })

  it('holds ownership, renews on one shared scheduler, and cleans up once', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    const manager = new TestStreamLockManager()
    __setStreamLockManagerForTests(manager)
    let currentLease = lease()
    const commands: WorkspaceCommand[] = []
    __setWorkspaceRepositoryForTests(
      repositoryWithExecute(async (command) => {
        commands.push(command)
        if (command.kind === 'stream.renew') {
          currentLease = {
            ...currentLease,
            heartbeatAt: command.heartbeat.heartbeatAt,
            revision: currentLease.revision + 1,
          }
          return commit(currentLease)
        }
        if (command.kind === 'stream.note-selected-key') {
          currentLease = {
            ...currentLease,
            postCommit: {
              usedAt: 1,
              profileId: 'profile-1',
              selectedKeyId: command.input.selectedKeyId,
            },
            revision: currentLease.revision + 1,
          }
          return commit(currentLease)
        }
        if (command.kind === 'stream.handoff-recovery') {
          return commit(currentLease)
        }
        throw new Error(`UnexpectedCommand:${command.kind}`)
      }),
    )

    const handle = await adoptLeaseOwnership(currentLease)

    expect(manager.isHeld('stream-owner:stream-1')).toBe(true)
    expect(commands.map((command) => command.kind)).toEqual([])

    await handle.noteSelectedKey('key-1')
    __runStreamLeaseHeartbeatSchedulerForTests(25_000)
    await Promise.resolve()
    await Promise.resolve()
    expect(commands.map((command) => command.kind)).toEqual([
      'stream.note-selected-key',
      'stream.renew',
    ])

    await handle.retire({ mode: 'handoff', reason: 'finalize-failed' })
    expect(commands.map((command) => command.kind)).toEqual([
      'stream.note-selected-key',
      'stream.renew',
      'stream.handoff-recovery',
    ])
    expect(manager.isHeld('stream-owner:stream-1')).toBe(false)
    __runStreamLeaseHeartbeatSchedulerForTests(40_000)
    await Promise.resolve()
    await Promise.resolve()
    expect(commands.map((command) => command.kind)).toEqual([
      'stream.note-selected-key',
      'stream.renew',
      'stream.handoff-recovery',
    ])
  })

  it('rejects duplicate ownership before a second writer can renew', async () => {
    const manager = new TestStreamLockManager()
    __setStreamLockManagerForTests(manager)
    let currentLease = lease()
    __setWorkspaceRepositoryForTests(
      repositoryWithExecute(async (command) => {
        if (command.kind === 'stream.renew') {
          currentLease = { ...currentLease, revision: currentLease.revision + 1 }
          return commit(currentLease)
        }
        if (command.kind === 'stream.handoff-recovery') return commit(currentLease)
        throw new Error(`UnexpectedCommand:${command.kind}`)
      }),
    )
    const first = await adoptLeaseOwnership(currentLease)

    await expect(reserveLeaseOwnership(currentLease)).rejects.toThrow(
      'StreamLeaseAlreadyOwned:stream-1',
    )

    await first.retire({ mode: 'handoff', reason: 'finalize-failed' })
  })

  it('closes admission while disposed and resumes only after runtime work drains', async () => {
    disposeStreamLeaseRuntime()
    await expect(withStreamRecoveryLocks([], async () => true)).rejects.toThrow(
      'StreamLeaseRuntimeDisposed',
    )
    await awaitStreamLeaseRuntimeIdle()
    resumeStreamLeaseRuntime()
    await expect(withStreamRecoveryLocks([], async () => true)).resolves.toEqual({
      acquired: true,
      value: true,
    })
  })

  it('refuses runtime disposal until the terminal owner releases every writer', async () => {
    const manager = new TestStreamLockManager()
    __setStreamLockManagerForTests(manager)
    const currentLease = lease()
    __setWorkspaceRepositoryForTests(
      repositoryWithExecute(async (command) => {
        if (command.kind === 'stream.handoff-recovery') return commit(currentLease)
        throw new Error(`UnexpectedCommand:${command.kind}`)
      }),
    )
    const handle = await adoptLeaseOwnership(currentLease)

    expect(() => disposeStreamLeaseRuntime()).toThrow(
      'StreamLeaseWriterLifetimeViolation:runtime-disposal:1',
    )
    expect(manager.isHeld('stream-owner:stream-1')).toBe(true)

    await handle.retire({ mode: 'handoff', reason: 'finalize-failed' })
    disposeStreamLeaseRuntime()
    await awaitStreamLeaseRuntimeIdle()
    expect(manager.isHeld('stream-owner:stream-1')).toBe(false)
    resumeStreamLeaseRuntime()
  })
})
