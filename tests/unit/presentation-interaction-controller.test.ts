import { act, renderHook, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import {
  conversationMutationInteraction,
  conversationMutationTarget,
} from '../../src/app/presentation-interactions'
import { usePresentationInteraction } from '../../src/hooks/usePresentationInteraction'
import {
  definePresentationInteraction as defineProductionPresentationInteraction,
  type PresentationInteractionCapability,
  type PresentationInteractionClaim,
  type PresentationInteractionCommit,
  type PresentationInteractionConcurrency,
  PresentationInteractionController,
  type PresentationInteractionFailure,
  type PresentationInteractionFailurePort,
  type PresentationInteractionLifetime,
  type PresentationInteractionPresenter,
  type PresentationInteractionStart,
  type PresentationInteractionWorkspaceStart,
} from '../../src/store/presentation-interaction-controller'
import type { WorkspaceFence } from '../../src/store/repository'
import {
  reconcileWorkspaceTabSessionStorage,
  registerWorkspaceTabSessionParticipant,
  subscribeWorkspaceTabSession,
} from '../../src/store/workspace-tab-session'

type AsyncCommitIsRejected =
  (() => Promise<void>) extends PresentationInteractionCommit<void> ? false : true

interface TestPresentationInteractionController {
  start<Target extends PropertyKey, Value>(
    input: Omit<PresentationInteractionStart<Target, Value>, 'presenter'>,
  ): PresentationInteractionClaim<Value>
  startWithPresenter<Target extends PropertyKey, Value>(
    presenter: PresentationInteractionPresenter,
    input: Omit<PresentationInteractionStart<Target, Value>, 'presenter'>,
  ): PresentationInteractionClaim<Value>
  createPresenter(): PresentationInteractionPresenter
  releasePresenter(presenter: PresentationInteractionPresenter): void
  reconcileWorkspace(fence: WorkspaceFence | null): void
  setWorkspaceFence(fence: WorkspaceFence | null): void
  isPending<Target extends PropertyKey>(
    capability: PresentationInteractionCapability<Target>,
    target: Target,
  ): boolean
  subscribe<Target extends PropertyKey>(
    capability: PresentationInteractionCapability<Target>,
    listener: () => void,
  ): () => void
  getRevision<Target extends PropertyKey>(
    capability: PresentationInteractionCapability<Target>,
  ): number
}

const DEFAULT_WORKSPACE_FENCE = Object.freeze({
  workspaceId: 'presentation-interaction-test',
  replacementEpoch: 1,
})

function definePresentationInteraction<Target extends PropertyKey>(definition: {
  readonly id: string
  readonly label: string
  readonly concurrency: PresentationInteractionConcurrency
  readonly lifetime?: PresentationInteractionLifetime
  readonly workspaceStart?: PresentationInteractionWorkspaceStart
  readonly pendingMessage?: string
  readonly describeFailure?: (error: unknown) => PresentationInteractionFailure
}): PresentationInteractionCapability<Target> {
  const lifetime = definition.lifetime ?? 'workspace-tab'
  return lifetime === 'presenter'
    ? defineProductionPresentationInteraction<Target>({ ...definition, lifetime })
    : defineProductionPresentationInteraction<Target>({ ...definition, lifetime })
}

function createTestController(
  failurePort: PresentationInteractionFailurePort,
  initialFence: WorkspaceFence | null = DEFAULT_WORKSPACE_FENCE,
): TestPresentationInteractionController {
  let fence = initialFence
  const controller = new PresentationInteractionController(failurePort, {
    currentFence: () => fence,
  })
  const defaultPresenter = controller.createPresenter(fence)
  return {
    start: (input) => controller.start({ ...input, presenter: defaultPresenter }),
    startWithPresenter: (presenter, input) => controller.start({ ...input, presenter }),
    createPresenter: () => controller.createPresenter(fence),
    releasePresenter: (presenter) => controller.releasePresenter(presenter),
    reconcileWorkspace: (nextFence) => controller.reconcileWorkspace(nextFence),
    setWorkspaceFence: (nextFence) => {
      fence = nextFence
    },
    isPending: (capability, target) => controller.isPending(capability, target),
    subscribe: (capability, listener) => controller.subscribe(capability, listener),
    getRevision: (capability) => controller.getRevision(capability),
  }
}

function harness() {
  const presented: PresentationInteractionFailure[] = []
  const controller = createTestController({
    describe(capability, error) {
      return {
        message: `${capability.label}: ${error instanceof Error ? error.message : 'unknown'}`,
        tone: 'danger',
      }
    },
    present(failure) {
      presented.push(failure)
    },
  })
  return { controller, presented }
}

function deferred<Value>() {
  let resolve!: (value: Value) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('PresentationInteractionController', () => {
  it('makes asynchronous commits unrepresentable at the typed boundary', () => {
    const asyncCommitIsRejected: AsyncCommitIsRejected = true
    expect(asyncCommitIsRejected).toBe(true)
  })

  it('fails a runtime-erased asynchronous commit without leaking its promise', async () => {
    const { controller, presented } = harness()
    const capability = definePresentationInteraction<string>({
      id: 'test.runtime-async-commit',
      label: 'Commit',
      concurrency: 'reject',
    })
    const erasedAsyncCommit = (() =>
      Promise.resolve()) as unknown as PresentationInteractionCommit<number>
    const claim = controller.start({
      capability,
      target: 'row',
      run: () => 1,
      commit: erasedAsyncCommit,
    })

    await expect(claim.settled).resolves.toMatchObject({
      kind: 'failed',
      failure: { message: 'Commit: PresentationInteractionAsyncCommitForbidden' },
    })
    expect(presented).toEqual([
      { message: 'Commit: PresentationInteractionAsyncCommitForbidden', tone: 'danger' },
    ])
  })

  it('publishes an exact pending claim before invoking work and removes it after success', async () => {
    const { controller, presented } = harness()
    const capability = definePresentationInteraction<string>({
      id: 'test.save',
      label: 'Save',
      concurrency: 'reject',
    })
    const revisions: number[] = []
    controller.subscribe(capability, () => revisions.push(controller.getRevision(capability)))
    let pendingInsideRun = false
    const claim = controller.start({
      capability,
      target: 'row-1',
      run: () => {
        pendingInsideRun = controller.isPending(capability, 'row-1')
        return 42
      },
    })

    expect(pendingInsideRun).toBe(true)
    expect(controller.isPending(capability, 'row-1')).toBe(true)
    await expect(claim.settled).resolves.toEqual({ kind: 'succeeded', value: 42 })
    expect(controller.isPending(capability, 'row-1')).toBe(false)
    expect(revisions).toEqual([1, 2])
    expect(presented).toEqual([])
  })

  it('uses the typed id as logical identity across recreated capability objects', async () => {
    const { controller } = harness()
    const firstCapability = definePresentationInteraction<string>({
      id: 'test.logical-identity',
      label: 'Load',
      concurrency: 'reject',
    })
    const recreatedCapability = definePresentationInteraction<string>({
      id: 'test.logical-identity',
      label: 'Load',
      concurrency: 'reject',
    })
    const work = deferred<void>()
    const observed: boolean[] = []
    controller.subscribe(recreatedCapability, () => {
      observed.push(controller.isPending(recreatedCapability, 'row'))
    })

    const claim = controller.start({
      capability: firstCapability,
      target: 'row',
      run: () => work.promise,
    })

    expect(controller.isPending(recreatedCapability, 'row')).toBe(true)
    work.resolve()
    await expect(claim.settled).resolves.toEqual({ kind: 'succeeded', value: undefined })
    expect(observed).toEqual([true, false])
  })

  it('replaces only the same target and suppresses a stale completion commit', async () => {
    const { controller } = harness()
    const capability = definePresentationInteraction<string>({
      id: 'test.search',
      label: 'Search',
      concurrency: 'replace',
    })
    const first = deferred<string>()
    const second = deferred<string>()
    const commits: string[] = []
    const firstClaim = controller.start({
      capability,
      target: 'query',
      run: () => first.promise,
      commit: (value) => {
        commits.push(value)
        return undefined
      },
    })
    const independent = controller.start({
      capability,
      target: 'other',
      run: () => 'independent',
      commit: (value) => {
        commits.push(value)
        return undefined
      },
    })
    const secondClaim = controller.start({
      capability,
      target: 'query',
      run: () => second.promise,
      commit: (value) => {
        commits.push(value)
        return undefined
      },
    })

    await expect(firstClaim.settled).resolves.toEqual({ kind: 'superseded' })
    await expect(independent.settled).resolves.toEqual({
      kind: 'succeeded',
      value: 'independent',
    })
    first.resolve('stale')
    second.resolve('current')
    await expect(secondClaim.settled).resolves.toEqual({ kind: 'succeeded', value: 'current' })
    expect(commits).toEqual(['independent', 'current'])
  })

  it('keeps replacement pending continuously and lets a reentrant abort choose the latest claim', async () => {
    const { controller } = harness()
    const capability = definePresentationInteraction<string>({
      id: 'test.reentrant-replace',
      label: 'Search',
      concurrency: 'replace',
    })
    const firstWork = deferred<string>()
    const latestWork = deferred<string>()
    const pendingSnapshots: boolean[] = []
    const secondAction = vi.fn(() => 'second')
    let latestClaim: ReturnType<typeof controller.start<string, string>> | undefined
    controller.subscribe(capability, () => {
      pendingSnapshots.push(controller.isPending(capability, 'query'))
    })
    const firstClaim = controller.start({
      capability,
      target: 'query',
      run: ({ signal }) => {
        signal.addEventListener(
          'abort',
          () => {
            latestClaim = controller.start({
              capability,
              target: 'query',
              run: () => latestWork.promise,
            })
          },
          { once: true },
        )
        return firstWork.promise
      },
    })
    const secondClaim = controller.start({
      capability,
      target: 'query',
      run: secondAction,
    })

    await expect(firstClaim.settled).resolves.toEqual({ kind: 'superseded' })
    await expect(secondClaim.settled).resolves.toEqual({ kind: 'superseded' })
    expect(secondAction).not.toHaveBeenCalled()
    expect(latestClaim).toBeDefined()
    expect(controller.isPending(capability, 'query')).toBe(true)
    expect(pendingSnapshots).toEqual([true, true])

    latestWork.resolve('latest')
    await expect(latestClaim?.settled).resolves.toEqual({ kind: 'succeeded', value: 'latest' })
    expect(pendingSnapshots).toEqual([true, true, false])
  })

  it('rejects a conflicting destructive command without invoking it', async () => {
    const { controller, presented } = harness()
    const capability = definePresentationInteraction<string>({
      id: 'test.delete',
      label: 'Delete',
      concurrency: 'reject',
      pendingMessage: 'Delete is already running.',
    })
    const first = deferred<void>()
    const action = vi.fn(() => undefined)
    const firstClaim = controller.start({
      capability,
      target: 'chat-1',
      run: () => first.promise,
    })
    const rejected = controller.start({ capability, target: 'chat-1', run: action })

    await expect(rejected.settled).resolves.toEqual({ kind: 'rejected-pending' })
    expect(action).not.toHaveBeenCalled()
    expect(presented).toEqual([{ message: 'Delete is already running.', tone: 'info' }])
    first.resolve()
    await expect(firstClaim.settled).resolves.toEqual({ kind: 'succeeded', value: undefined })
  })

  it('owns synchronous and asynchronous failures exactly once without rejecting settlement', async () => {
    const { controller, presented } = harness()
    const capability = definePresentationInteraction<string>({
      id: 'test.import',
      label: 'Import',
      concurrency: 'reject',
    })
    const synchronous = controller.start({
      capability,
      target: 'sync',
      run: () => {
        throw new Error('sync failure')
      },
    })
    const asynchronous = controller.start({
      capability,
      target: 'async',
      run: () => Promise.reject(new Error('async failure')),
    })

    await expect(synchronous.settled).resolves.toMatchObject({ kind: 'failed' })
    await expect(asynchronous.settled).resolves.toMatchObject({ kind: 'failed' })
    expect(presented.map((failure) => failure.message)).toEqual([
      'Import: sync failure',
      'Import: async failure',
    ])
  })

  it('composes nested total outcomes without converting them into success or presenting twice', async () => {
    const { controller, presented } = harness()
    const innerCapability = definePresentationInteraction<string>({
      id: 'test.nested-outcome.inner',
      label: 'Inner',
      concurrency: 'reject',
    })
    const outerCapability = definePresentationInteraction<string>({
      id: 'test.nested-outcome.outer',
      label: 'Outer',
      concurrency: 'reject',
    })
    const commit = vi.fn()
    const innerFailed = controller.start<string, number>({
      capability: innerCapability,
      target: 'failed',
      run: () => Promise.reject(new Error('failed')),
    })
    const failed = controller.start<string, number>({
      capability: outerCapability,
      target: 'failed',
      run: () => innerFailed.settled,
      commit,
    })
    const innerSucceeded = controller.start({
      capability: innerCapability,
      target: 'succeeded',
      run: () => 9,
    })
    const succeeded = controller.start({
      capability: outerCapability,
      target: 'succeeded',
      run: () => innerSucceeded.settled,
      commit,
    })

    await expect(failed.settled).resolves.toEqual({
      kind: 'failed',
      failure: { message: 'Inner: failed', tone: 'danger' },
    })
    await expect(succeeded.settled).resolves.toEqual({ kind: 'succeeded', value: 9 })
    expect(commit).toHaveBeenCalledOnce()
    expect(commit).toHaveBeenCalledWith(9)
    expect(presented).toEqual([{ message: 'Inner: failed', tone: 'danger' }])
  })

  it('keeps a domain value with an outcome-shaped kind as an ordinary success value', async () => {
    const { controller } = harness()
    const capability = definePresentationInteraction<string>({
      id: 'test.domain-kind',
      label: 'Read',
      concurrency: 'reject',
    })
    const value = { kind: 'succeeded' as const, payload: 9 }
    const commit = vi.fn()
    const claim = controller.start({ capability, target: 'row', run: () => value, commit })

    await expect(claim.settled).resolves.toEqual({ kind: 'succeeded', value })
    expect(commit).toHaveBeenCalledWith(value)
  })

  it('isolates throwing subscribers from start and settlement', async () => {
    const { controller } = harness()
    const capability = definePresentationInteraction<string>({
      id: 'test.throwing-subscriber',
      label: 'Save',
      concurrency: 'reject',
    })
    const observed: boolean[] = []
    controller.subscribe(capability, () => {
      throw new Error('subscriber failure')
    })
    controller.subscribe(capability, () => {
      observed.push(controller.isPending(capability, 'row'))
    })

    const claim = controller.start({ capability, target: 'row', run: () => 7 })

    await expect(claim.settled).resolves.toEqual({ kind: 'succeeded', value: 7 })
    expect(observed).toEqual([true, false])
  })

  it('notifies a stable listener cohort when a subscriber unsubscribes another subscriber', async () => {
    const { controller } = harness()
    const capability = definePresentationInteraction<string>({
      id: 'test.listener-cohort',
      label: 'Save',
      concurrency: 'reject',
    })
    const first = vi.fn()
    const second = vi.fn()
    let unsubscribeSecond: () => void = () => undefined
    controller.subscribe(capability, () => {
      first()
      unsubscribeSecond()
    })
    unsubscribeSecond = controller.subscribe(capability, second)

    const claim = controller.start({ capability, target: 'row', run: () => 1 })

    await expect(claim.settled).resolves.toEqual({ kind: 'succeeded', value: 1 })
    expect(first).toHaveBeenCalledTimes(2)
    expect(second).toHaveBeenCalledOnce()
  })

  it('releases only the mounted commit while retaining operation and failure ownership', async () => {
    const { controller, presented } = harness()
    const capability = definePresentationInteraction<string>({
      id: 'test.release',
      label: 'Save',
      concurrency: 'reject',
    })
    const work = deferred<number>()
    const commit = vi.fn()
    const claim = controller.start({
      capability,
      target: 'row',
      run: () => work.promise,
      commit,
    })

    claim.releasePresenter()
    expect(controller.isPending(capability, 'row')).toBe(true)
    work.reject(new Error('write failed'))

    await expect(claim.settled).resolves.toMatchObject({ kind: 'failed' })
    expect(commit).not.toHaveBeenCalled()
    expect(presented).toEqual([{ message: 'Save: write failed', tone: 'danger' }])
  })

  it('turns a throwing commit into one total failed outcome', async () => {
    const { controller, presented } = harness()
    const capability = definePresentationInteraction<string>({
      id: 'test.commit-failure',
      label: 'Apply',
      concurrency: 'replace',
    })
    const claim = controller.start({
      capability,
      target: 'row',
      run: () => 1,
      commit: () => {
        throw new Error('commit failed')
      },
    })

    await expect(claim.settled).resolves.toEqual({
      kind: 'failed',
      failure: { message: 'Apply: commit failed', tone: 'danger' },
    })
    expect(presented).toEqual([{ message: 'Apply: commit failed', tone: 'danger' }])
    expect(controller.isPending(capability, 'row')).toBe(false)
  })

  it('reserves success before a commit starts same-target replacement work', async () => {
    const { controller, presented } = harness()
    const capability = definePresentationInteraction<string>({
      id: 'test.commit-replacement',
      label: 'Apply',
      concurrency: 'replace',
    })
    const firstWork = deferred<number>()
    const replacementWork = deferred<number>()
    const observed: boolean[] = []
    let replacement: PresentationInteractionClaim<number> | undefined
    controller.subscribe(capability, () => {
      observed.push(controller.isPending(capability, 'row'))
    })
    const first = controller.start({
      capability,
      target: 'row',
      run: () => firstWork.promise,
      commit: () => {
        replacement = controller.start({
          capability,
          target: 'row',
          run: () => replacementWork.promise,
        })
      },
    })

    firstWork.resolve(1)
    await expect(first.settled).resolves.toEqual({ kind: 'succeeded', value: 1 })
    expect(replacement).toBeDefined()
    expect(controller.isPending(capability, 'row')).toBe(true)
    expect(observed).toEqual([true, true])
    expect(presented).toEqual([])

    replacementWork.resolve(2)
    await expect(replacement?.settled).resolves.toEqual({ kind: 'succeeded', value: 2 })
    expect(observed).toEqual([true, true, false])
  })

  it('owns a commit failure even when that commit starts replacement work', async () => {
    const { controller, presented } = harness()
    const capability = definePresentationInteraction<string>({
      id: 'test.commit-failure-replacement',
      label: 'Apply',
      concurrency: 'replace',
    })
    const replacementWork = deferred<number>()
    let replacement: PresentationInteractionClaim<number> | undefined
    const first = controller.start({
      capability,
      target: 'row',
      run: () => 1,
      commit: () => {
        replacement = controller.start({
          capability,
          target: 'row',
          run: () => replacementWork.promise,
        })
        throw new Error('commit failed')
      },
    })

    await expect(first.settled).resolves.toEqual({
      kind: 'failed',
      failure: { message: 'Apply: commit failed', tone: 'danger' },
    })
    expect(controller.isPending(capability, 'row')).toBe(true)
    expect(presented).toEqual([{ message: 'Apply: commit failed', tone: 'danger' }])
    replacementWork.resolve(2)
    await expect(replacement?.settled).resolves.toEqual({ kind: 'succeeded', value: 2 })
  })

  it('does not present a stale failure when synchronous work replaces itself before throwing', async () => {
    const { controller, presented } = harness()
    const capability = definePresentationInteraction<string>({
      id: 'test.stale-sync-failure',
      label: 'Refresh',
      concurrency: 'replace',
    })
    let replacement: ReturnType<typeof controller.start<string, string>> | undefined
    const stale = controller.start({
      capability,
      target: 'row',
      run: () => {
        replacement = controller.start({
          capability,
          target: 'row',
          run: () => 'current',
        })
        throw new Error('stale failure')
      },
    })

    await expect(stale.settled).resolves.toEqual({ kind: 'superseded' })
    await expect(replacement?.settled).resolves.toEqual({ kind: 'succeeded', value: 'current' })
    expect(presented).toEqual([])
  })

  it('reserves a genuine failure before a presentation callback starts new work', async () => {
    const presented: PresentationInteractionFailure[] = []
    let replacement: ReturnType<TestPresentationInteractionController['start']> | undefined
    const observed: boolean[] = []
    const revisions: number[] = []
    const capability = definePresentationInteraction<string>({
      id: 'test.failure-reentrancy',
      label: 'Refresh',
      concurrency: 'replace',
    })
    const controller = createTestController({
      describe(_, error) {
        return {
          message: error instanceof Error ? error.message : 'unknown',
          tone: 'danger',
        }
      },
      present(failure) {
        presented.push(failure)
        replacement = controller.start({
          capability,
          target: 'row',
          run: () => 'recovered',
        })
      },
    })
    controller.subscribe(capability, () => {
      observed.push(controller.isPending(capability, 'row'))
      revisions.push(controller.getRevision(capability))
    })

    const failed = controller.start({
      capability,
      target: 'row',
      run: () => {
        throw new Error('original failure')
      },
    })

    await expect(failed.settled).resolves.toEqual({
      kind: 'failed',
      failure: { message: 'original failure', tone: 'danger' },
    })
    await expect(replacement?.settled).resolves.toEqual({ kind: 'succeeded', value: 'recovered' })
    expect(presented).toEqual([{ message: 'original failure', tone: 'danger' }])
    expect(observed).toEqual([true, true, false])
    expect(revisions).toEqual([1, 2, 3])
  })

  it('settles failure even when description and presentation ports throw', async () => {
    const controller = createTestController({
      describe() {
        throw new Error('description unavailable')
      },
      present() {
        throw new Error('presentation unavailable')
      },
    })
    const capability = definePresentationInteraction<string>({
      id: 'test.failure-port',
      label: 'Import',
      concurrency: 'reject',
      describeFailure() {
        return Object.defineProperty({ tone: 'danger' }, 'message', {
          get() {
            throw new Error('custom description unavailable')
          },
        }) as PresentationInteractionFailure
      },
    })

    const claim = controller.start({
      capability,
      target: 'workspace',
      run: () => Promise.reject(new Error('original failure')),
    })

    await expect(claim.settled).resolves.toEqual({
      kind: 'failed',
      failure: { message: 'Import failed.', tone: 'danger' },
    })
    expect(controller.isPending(capability, 'workspace')).toBe(false)
  })

  it('cancels only the explicit claim with its typed reason and preserves reentrant replacement', async () => {
    const { controller } = harness()
    const capability = definePresentationInteraction<string>({
      id: 'test.load',
      label: 'Load',
      concurrency: 'replace',
    })
    const firstWork = deferred<number>()
    const replacementWork = deferred<number>()
    const commit = vi.fn()
    const observed: boolean[] = []
    const revisions: number[] = []
    let abortReason: unknown
    let replacement: PresentationInteractionClaim<number> | undefined
    controller.subscribe(capability, () => {
      observed.push(controller.isPending(capability, 'one'))
      revisions.push(controller.getRevision(capability))
    })
    const first = controller.start({
      capability,
      target: 'one',
      run: ({ signal }) => {
        signal.addEventListener(
          'abort',
          () => {
            abortReason = signal.reason
            replacement = controller.start({
              capability,
              target: 'one',
              run: () => replacementWork.promise,
              commit,
            })
          },
          { once: true },
        )
        return firstWork.promise
      },
      commit,
    })

    first.cancel()
    await expect(first.settled).resolves.toEqual({
      kind: 'cancelled',
      reason: 'caller',
    })
    expect(abortReason).toBe('caller')
    expect(observed).toEqual([true, true])
    expect(revisions).toEqual([1, 2])
    firstWork.resolve(1)
    replacementWork.resolve(2)
    await expect(replacement?.settled).resolves.toEqual({ kind: 'succeeded', value: 2 })
    await Promise.resolve()
    expect(commit).toHaveBeenCalledOnce()
    expect(commit).toHaveBeenCalledWith(2)
    expect(controller.isPending(capability, 'one')).toBe(false)
    expect(observed).toEqual([true, true, false])
    expect(revisions).toEqual([1, 2, 3])
  })

  it('cancels presenter-owned work and releases its retained commit when the presenter leaves', async () => {
    const { controller, presented } = harness()
    const capability = definePresentationInteraction<string>({
      id: 'test.presenter-lifetime',
      label: 'Picker read',
      concurrency: 'reject',
      lifetime: 'presenter',
    })
    const presenter = controller.createPresenter()
    const work = deferred<number>()
    const commit = vi.fn()
    const claim = controller.startWithPresenter(presenter, {
      capability,
      target: 'picker',
      run: () => work.promise,
      commit,
    })

    controller.releasePresenter(presenter)

    await expect(claim.settled).resolves.toEqual({
      kind: 'cancelled',
      reason: 'presenter-released',
    })
    expect(controller.isPending(capability, 'picker')).toBe(false)
    work.resolve(1)
    await Promise.resolve()
    expect(commit).not.toHaveBeenCalled()
    expect(presented).toEqual([])
  })

  it('rejects an action from a released presenter before invoking its work', async () => {
    const { controller } = harness()
    const capability = definePresentationInteraction<string>({
      id: 'test.released-presenter',
      label: 'Picker read',
      concurrency: 'reject',
      lifetime: 'presenter',
    })
    const presenter = controller.createPresenter()
    const action = vi.fn(() => 1)
    controller.releasePresenter(presenter)

    const claim = controller.startWithPresenter(presenter, {
      capability,
      target: 'picker',
      run: action,
    })

    await expect(claim.settled).resolves.toEqual({
      kind: 'cancelled',
      reason: 'presenter-released',
    })
    expect(action).not.toHaveBeenCalled()
  })

  it('rejects an old workspace presenter before invoking work after replacement', async () => {
    const { controller } = harness()
    const capability = definePresentationInteraction<string>({
      id: 'test.stale-workspace-presenter',
      label: 'Workspace action',
      concurrency: 'reject',
      lifetime: 'workspace-tab',
    })
    const presenter = controller.createPresenter()
    const replacementFence = {
      workspaceId: 'presentation-interaction-replacement',
      replacementEpoch: 2,
    }
    const action = vi.fn(() => 1)
    controller.setWorkspaceFence(replacementFence)
    controller.reconcileWorkspace(replacementFence)

    const claim = controller.startWithPresenter(presenter, {
      capability,
      target: 'workspace',
      run: action,
    })

    await expect(claim.settled).resolves.toEqual({
      kind: 'cancelled',
      reason: 'workspace-replaced',
    })
    expect(action).not.toHaveBeenCalled()
  })

  it('removes every old-fence claim atomically and publishes once per capability', async () => {
    const { controller } = harness()
    const capability = definePresentationInteraction<string>({
      id: 'test.workspace-replacement',
      label: 'Workspace write',
      concurrency: 'reject',
      lifetime: 'workspace-tab',
    })
    const firstWork = deferred<number>()
    const secondWork = deferred<number>()
    const firstCommit = vi.fn()
    const secondCommit = vi.fn()
    const pendingAtAbort: boolean[][] = []
    let publications = 0
    controller.subscribe(capability, () => {
      publications += 1
    })
    const first = controller.start({
      capability,
      target: 'first',
      run: ({ signal }) => {
        signal.addEventListener('abort', () => {
          pendingAtAbort.push([
            controller.isPending(capability, 'first'),
            controller.isPending(capability, 'second'),
          ])
        })
        return firstWork.promise
      },
      commit: firstCommit,
    })
    const second = controller.start({
      capability,
      target: 'second',
      run: ({ signal }) => {
        signal.addEventListener('abort', () => {
          pendingAtAbort.push([
            controller.isPending(capability, 'first'),
            controller.isPending(capability, 'second'),
          ])
        })
        return secondWork.promise
      },
      commit: secondCommit,
    })
    publications = 0
    const replacementFence = Object.freeze({
      workspaceId: DEFAULT_WORKSPACE_FENCE.workspaceId,
      replacementEpoch: 2,
    })
    controller.setWorkspaceFence(replacementFence)

    controller.reconcileWorkspace(replacementFence)

    await expect(first.settled).resolves.toEqual({
      kind: 'cancelled',
      reason: 'workspace-replaced',
    })
    await expect(second.settled).resolves.toEqual({
      kind: 'cancelled',
      reason: 'workspace-replaced',
    })
    expect(pendingAtAbort).toEqual([
      [false, false],
      [false, false],
    ])
    expect(publications).toBe(1)
    firstWork.resolve(1)
    secondWork.resolve(2)
    await Promise.resolve()
    expect(firstCommit).not.toHaveBeenCalled()
    expect(secondCommit).not.toHaveBeenCalled()
  })

  it('returns a total failure without invoking workspace work before a fence exists', async () => {
    const presented: PresentationInteractionFailure[] = []
    const controller = createTestController(
      {
        describe(capability, error) {
          return {
            message: `${capability.label}: ${error instanceof Error ? error.message : 'unknown'}`,
            tone: 'danger',
          }
        },
        present: (failure) => presented.push(failure),
      },
      null,
    )
    const capability = definePresentationInteraction<string>({
      id: 'test.workspace-unavailable',
      label: 'Workspace write',
      concurrency: 'reject',
      lifetime: 'workspace-tab',
    })
    const action = vi.fn(() => 1)

    const claim = controller.start({ capability, target: 'row', run: action })

    await expect(claim.settled).resolves.toEqual({
      kind: 'failed',
      failure: { message: 'Workspace write: Workspace is not available.', tone: 'danger' },
    })
    expect(action).not.toHaveBeenCalled()
    expect(presented).toEqual([
      { message: 'Workspace write: Workspace is not available.', tone: 'danger' },
    ])
  })

  it('retains a settle-current claim from first ownership through the first workspace fence', async () => {
    const presented: PresentationInteractionFailure[] = []
    const controller = createTestController(
      {
        describe(capability, error) {
          return {
            message: `${capability.label}: ${error instanceof Error ? error.message : 'unknown'}`,
            tone: 'danger',
          }
        },
        present: (failure) => presented.push(failure),
      },
      null,
    )
    const capability = definePresentationInteraction<string>({
      id: 'test.workspace-settle-current',
      label: 'Send',
      concurrency: 'replace',
      lifetime: 'workspace-tab',
      workspaceStart: 'settle-current',
    })
    const work = deferred<number>()
    const commit = vi.fn()
    const initialPresenter = controller.createPresenter()
    const action = vi.fn(() => work.promise)

    const claim = controller.startWithPresenter(initialPresenter, {
      capability,
      target: 'composer',
      run: action,
      commit,
    })

    expect(action).toHaveBeenCalledOnce()
    expect(controller.isPending(capability, 'composer')).toBe(true)
    const firstFence = Object.freeze({
      workspaceId: 'presentation-interaction-first-workspace',
      replacementEpoch: 1,
    })
    controller.setWorkspaceFence(firstFence)
    controller.reconcileWorkspace(firstFence)
    const renewedPresenter = controller.createPresenter()
    controller.releasePresenter(initialPresenter)
    controller.reconcileWorkspace(firstFence)
    expect(controller.isPending(capability, 'composer')).toBe(true)
    expect(claim.signal.aborted).toBe(false)

    const replacementFence = Object.freeze({
      workspaceId: firstFence.workspaceId,
      replacementEpoch: 2,
    })
    controller.setWorkspaceFence(replacementFence)
    controller.reconcileWorkspace(replacementFence)

    await expect(claim.settled).resolves.toEqual({
      kind: 'cancelled',
      reason: 'workspace-replaced',
    })
    expect(claim.signal.aborted).toBe(true)
    expect(controller.isPending(capability, 'composer')).toBe(false)
    controller.releasePresenter(renewedPresenter)
    work.resolve(1)
    await Promise.resolve()
    expect(commit).not.toHaveBeenCalled()
    expect(presented).toEqual([])
  })

  it('reconciles workspace participants before publishing the replacement fence', () => {
    const events: string[] = []
    const unregister = registerWorkspaceTabSessionParticipant({
      resetWorkspace: () => events.push('participant'),
    })
    const unsubscribe = subscribeWorkspaceTabSession(() => events.push('listener'))

    reconcileWorkspaceTabSessionStorage({
      workspaceId: `presentation-order-${crypto.randomUUID()}`,
      replacementEpoch: 1,
    })

    expect(events).toEqual(['participant', 'listener'])
    unsubscribe()
    unregister()
  })

  it('renews a mounted hook presenter on replacement and keeps its stale callback total', async () => {
    reconcileWorkspaceTabSessionStorage({
      workspaceId: `presentation-hook-before-${crypto.randomUUID()}`,
      replacementEpoch: 1,
    })
    const capability = definePresentationInteraction<string>({
      id: 'test.hook-workspace-replacement',
      label: 'Picker action',
      concurrency: 'reject',
      lifetime: 'presenter',
    })
    const rendered = renderHook(() => usePresentationInteraction(capability), {
      wrapper: StrictMode,
    })
    const retainedRun = rendered.result.current.run

    act(() => {
      reconcileWorkspaceTabSessionStorage({
        workspaceId: `presentation-hook-after-${crypto.randomUUID()}`,
        replacementEpoch: 2,
      })
    })
    const currentAction = vi.fn(() => 4)
    let currentClaim: PresentationInteractionClaim<number> | undefined
    act(() => {
      currentClaim = rendered.result.current.run({ target: 'picker', action: currentAction })
    })
    await expect(currentClaim?.settled).resolves.toEqual({ kind: 'succeeded', value: 4 })
    expect(currentAction).toHaveBeenCalledOnce()

    rendered.unmount()
    const staleAction = vi.fn(() => 5)
    const staleClaim = retainedRun({ target: 'picker', action: staleAction })
    await expect(staleClaim.settled).resolves.toEqual({
      kind: 'cancelled',
      reason: 'presenter-released',
    })
    expect(staleAction).not.toHaveBeenCalled()
  })

  it('keeps work owned across hook unmount and a recreated capability subscriber', async () => {
    reconcileWorkspaceTabSessionStorage({
      workspaceId: `presentation-hook-${crypto.randomUUID()}`,
      replacementEpoch: 1,
    })
    const capability = definePresentationInteraction<string>({
      id: 'test.hook-remount',
      label: 'Persist',
      concurrency: 'reject',
    })
    const work = deferred<number>()
    const commit = vi.fn()
    const first = renderHook(() => usePresentationInteraction(capability), { wrapper: StrictMode })
    let claim: PresentationInteractionClaim<number> | undefined
    act(() => {
      claim = first.result.current.run({
        target: 'row',
        action: () => work.promise,
        commit,
      })
    })
    first.unmount()

    const recreatedCapability = definePresentationInteraction<string>({
      id: 'test.hook-remount',
      label: 'Persist',
      concurrency: 'reject',
    })
    const second = renderHook(() => usePresentationInteraction(recreatedCapability), {
      wrapper: StrictMode,
    })
    expect(second.result.current.isPending('row')).toBe(true)
    let rejected: PresentationInteractionClaim<void> | undefined
    act(() => {
      rejected = second.result.current.run({ target: 'row', action: () => undefined })
    })
    await expect(rejected?.settled).resolves.toEqual({ kind: 'rejected-pending' })

    await act(async () => {
      work.resolve(4)
      await claim?.settled
    })
    await waitFor(() => expect(second.result.current.isPending('row')).toBe(false))
    expect(commit).not.toHaveBeenCalled()
    second.unmount()
  })

  it('keeps the production conversation mutation owner exact across remount and workspace replacement', async () => {
    reconcileWorkspaceTabSessionStorage({
      workspaceId: `conversation-mutation-before-${crypto.randomUUID()}`,
      replacementEpoch: 1,
    })
    const target = conversationMutationTarget({
      kind: 'edit',
      chatId: 'conversation-chat',
      messageId: 'conversation-message',
    })
    const firstWork = deferred<void>()
    const firstAction = vi.fn(() => firstWork.promise)
    const firstCommit = vi.fn()
    const first = renderHook(
      () => usePresentationInteraction(conversationMutationInteraction, { observePending: false }),
      { wrapper: StrictMode },
    )
    let firstClaim: PresentationInteractionClaim<void> | undefined
    act(() => {
      firstClaim = first.result.current.run({
        target,
        action: firstAction,
        commit: firstCommit,
      })
    })
    first.unmount()

    const second = renderHook(
      () => usePresentationInteraction(conversationMutationInteraction, { observePending: false }),
      { wrapper: StrictMode },
    )
    expect(second.result.current.isPending(target)).toBe(true)
    const duplicateAction = vi.fn(() => undefined)
    let duplicate: PresentationInteractionClaim<void> | undefined
    act(() => {
      duplicate = second.result.current.run({ target, action: duplicateAction })
    })
    await expect(duplicate?.settled).resolves.toEqual({ kind: 'rejected-pending' })
    expect(duplicateAction).not.toHaveBeenCalled()

    await act(async () => {
      firstWork.resolve(undefined)
      await firstClaim?.settled
    })
    expect(firstAction).toHaveBeenCalledOnce()
    expect(firstCommit).not.toHaveBeenCalled()
    expect(second.result.current.isPending(target)).toBe(false)

    const replacementWork = deferred<void>()
    const replacementCommit = vi.fn()
    let replacementClaim: PresentationInteractionClaim<void> | undefined
    act(() => {
      replacementClaim = second.result.current.run({
        target: conversationMutationTarget({
          kind: 'delete',
          chatId: 'conversation-chat',
        }),
        action: () => replacementWork.promise,
        commit: replacementCommit,
      })
    })
    act(() => {
      reconcileWorkspaceTabSessionStorage({
        workspaceId: `conversation-mutation-after-${crypto.randomUUID()}`,
        replacementEpoch: 2,
      })
    })
    await expect(replacementClaim?.settled).resolves.toEqual({
      kind: 'cancelled',
      reason: 'workspace-replaced',
    })
    replacementWork.resolve(undefined)
    await Promise.resolve()
    expect(replacementCommit).not.toHaveBeenCalled()
    second.unmount()
  })
})
