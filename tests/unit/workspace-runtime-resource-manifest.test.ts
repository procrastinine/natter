import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { discoverProductionCoordination } from '../../scripts/audit-production-coordination.mjs'
import { RETAINED_COLLECTION_IDS_BY_SCOPE } from '../../scripts/production-coordination-inventory.mjs'
import { BrowserWorkspaceBootstrapAuthorityRegistry } from '../../src/store/browser-workspace-bootstrap-authority'
import {
  createWorkspaceRuntimeKernel,
  WORKSPACE_ROOT_REPLACEMENT_DISPOSITIONS,
  WorkspaceForegroundDemandInterruptedError,
  WorkspaceMaintenancePreemptedError,
  WorkspaceReplacementContenderPreemptedError,
  type WorkspaceWritePermit,
} from '../../src/store/workspace-runtime'
import {
  createWorkspaceRuntimeControlKernel,
  type tryLaunchMaintenanceWorkspaceRuntimeReplacementIfIdle,
  WORKSPACE_RUNTIME_RECONCILIATION_PARTICIPANT_IDS,
  WORKSPACE_RUNTIME_RESOURCE_IDS,
  type WorkspaceUsableSurfaceId,
} from '../../src/store/workspace-runtime-control'

function createRuntimeHarness() {
  const kernel = createWorkspaceRuntimeKernel()
  const controlKernel = createWorkspaceRuntimeControlKernel(kernel.internal)
  return {
    runtime: Object.freeze({
      ...kernel,
      workspaceRuntimeInternal: kernel.internal,
      WORKSPACE_ROOT_REPLACEMENT_DISPOSITIONS,
    }),
    control: Object.freeze({
      ...controlKernel,
      WORKSPACE_RUNTIME_RESOURCE_IDS,
      WORKSPACE_RUNTIME_RECONCILIATION_PARTICIPANT_IDS,
    }),
  }
}

const retainedCollectionInventory = discoverProductionCoordination({
  root: resolve(__dirname, '../..'),
}).discovered.retainedCollections
const retainedCollectionIdsByScope = Object.freeze({
  module: retainedCollectionInventory
    .filter((entry) => entry.kind === 'module-collection')
    .map((entry) => entry.id)
    .sort(),
  controller: retainedCollectionInventory
    .filter((entry) => entry.kind === 'class-collection' || entry.kind === 'factory-collection')
    .map((entry) => entry.id)
    .sort(),
  zustand: retainedCollectionInventory
    .filter((entry) => entry.kind === 'zustand-collection')
    .map((entry) => entry.id)
    .sort(),
})

describe('workspace runtime resource manifest', () => {
  it('revokes a cancelled bootstrap authority before admitting a fresh attempt', async () => {
    const bootstrap = new BrowserWorkspaceBootstrapAuthorityRegistry()
    const cancelled = bootstrap.begin()
    const reason = new DOMException('cancelled bootstrap', 'AbortError')

    bootstrap.cancel(cancelled, reason)
    expect(() => bootstrap.assert(cancelled)).toThrow(reason)
    expect(() => bootstrap.assertOwned(cancelled)).not.toThrow()
    bootstrap.finish(cancelled)
    expect(() => bootstrap.assertOwned(cancelled)).toThrow(
      'BrowserWorkspaceBootstrapAuthorityInvalid',
    )

    const retry = bootstrap.begin()
    expect(retry.attemptId).toBeGreaterThan(cancelled.attemptId)
    expect(() => bootstrap.assert(retry)).not.toThrow()
    bootstrap.finish(retry)
  })

  it('keeps every module-scope collection in the retention-owner inventory', () => {
    expect(retainedCollectionIdsByScope.module).toEqual(RETAINED_COLLECTION_IDS_BY_SCOPE.module)
  })

  it('keeps every controller collection in the retention-owner inventory', () => {
    expect(retainedCollectionIdsByScope.controller).toEqual(
      RETAINED_COLLECTION_IDS_BY_SCOPE.controller,
    )
  })

  it('keeps every Zustand state collection in the retention-owner inventory', () => {
    expect(retainedCollectionIdsByScope.zustand).toEqual(RETAINED_COLLECTION_IDS_BY_SCOPE.zustand)
  })

  it('keeps runtime listeners, state, and permits inside their exact kernel', async () => {
    const first = createRuntimeHarness().runtime
    const second = createRuntimeHarness().runtime
    const firstStates: string[] = []
    const secondStates: string[] = []
    first.subscribeWorkspaceRuntimeState(() => firstStates.push(first.getWorkspaceRuntimeState()))
    second.subscribeWorkspaceRuntimeState(() =>
      secondStates.push(second.getWorkspaceRuntimeState()),
    )
    first.workspaceRuntimeInternal.beginReconciliation({
      workspaceId: 'first-kernel',
      replacementEpoch: 0,
    })
    first.workspaceRuntimeInternal.finishReconciliation()
    second.workspaceRuntimeInternal.beginReconciliation({
      workspaceId: 'second-kernel',
      replacementEpoch: 0,
    })
    second.workspaceRuntimeInternal.finishReconciliation()
    let captured!: WorkspaceWritePermit
    let release!: () => void
    const active = first.runWorkspaceAction('chat-metadata', async (permit) => {
      captured = permit
      await new Promise<void>((resolve) => {
        release = resolve
      })
    })

    expect(firstStates).toEqual(['RECONCILING', 'RUNNING'])
    expect(secondStates).toEqual(['RECONCILING', 'RUNNING'])
    expect(() => first.assertWorkspaceExecutionPermit(captured)).not.toThrow()
    expect(() => second.assertWorkspaceExecutionPermit(captured)).toThrow(
      'WorkspaceRuntimeClosed:repository:RUNNING',
    )

    release()
    await active
  })

  it('keeps the deleted generic query registry absent and mounted projections active-only', () => {
    expect(existsSync(resolve(__dirname, '../../src/store/reactive-query.ts'))).toBe(false)
    const source = readFileSync(
      resolve(__dirname, '../../src/store/mounted-projection-lifecycle.ts'),
      'utf8',
    )
    expect(source).toMatch(/const projections = new Map/u)
    expect(source).not.toMatch(/retainWhenIdle|MAX_IDLE_QUERIES|idleOrder|pruneIdleEntries/u)
  })

  it('publishes every interaction-authority state transition', async () => {
    const { runtime } = createRuntimeHarness()
    const states: string[] = []
    runtime.subscribeWorkspaceRuntimeState(() => states.push(runtime.getWorkspaceRuntimeState()))
    const fence = { workspaceId: 'workspace-interaction-authority', replacementEpoch: 0 }

    runtime.workspaceRuntimeInternal.beginReconciliation(fence)
    runtime.workspaceRuntimeInternal.finishReconciliation(fence)
    runtime.workspaceRuntimeInternal.beginQuiesce()
    runtime.workspaceRuntimeInternal.markQuiesced()

    expect(states).toEqual(['RECONCILING', 'RUNNING', 'QUIESCING', 'QUIESCED'])
  })

  it('settles usable surfaces through one cycle-bound capability', async () => {
    const { control } = createRuntimeHarness()
    installNoopResourceManifest(control)
    const fence = { workspaceId: 'workspace-usable-surface', replacementEpoch: 0 }
    const open = async () => {
      const authority = control.beginWorkspaceRuntimeReconciliation(fence)
      await control.resumeWorkspaceRuntimeResources(authority)
      await control.finishWorkspaceRuntimeReconciliation(fence)
    }

    await open()
    expect(
      control.claimWorkspaceUsableSurfaceSettlement({
        workspaceId: 'wrong-workspace',
        replacementEpoch: 0,
        surface: 'sidebar-first-page',
      }),
    ).toBeNull()
    const stale = control.claimWorkspaceUsableSurfaceSettlement({
      ...fence,
      surface: 'sidebar-first-page',
    })
    expect(stale).not.toBeNull()

    control.beginWorkspaceRuntimeQuiesce()
    await control.awaitWorkspaceRuntimeQuiesced()
    await open()

    expect(stale?.settle('ready')).toBe(false)
    const current = control.claimWorkspaceUsableSurfaceSettlement({
      ...fence,
      surface: 'sidebar-first-page',
    })
    expectTypeOf<Parameters<NonNullable<typeof current>['settle']>[0]>().toEqualTypeOf<
      'ready' | 'empty' | 'error'
    >()
    expect(current?.settle('ready')).toBe(true)
    expect(current?.settle('empty')).toBe(false)
    expect(
      control.claimWorkspaceUsableSurfaceSettlement({
        ...fence,
        surface: 'sidebar-first-page',
      }),
    ).toBeNull()
    expect(control.getWorkspaceUsableSurfaceSnapshot()?.outcomes['sidebar-first-page']).toBe(
      'ready',
    )
  })

  it('activates a prerequisite-bound resource once from current terminal evidence only', async () => {
    for (const outcome of ['ready', 'empty', 'error'] as const) {
      const { control } = createRuntimeHarness()
      let activations = 0
      installNoopResourceManifest(control, {
        storageMaintenancePrerequisites: ['sidebar-first-page'],
        activateStorageMaintenance: () => {
          activations += 1
        },
      })
      const fence = { workspaceId: `workspace-prerequisite-${outcome}`, replacementEpoch: 0 }
      const open = async () => {
        const authority = control.beginWorkspaceRuntimeReconciliation(fence)
        await control.resumeWorkspaceRuntimeResources(authority)
        await control.finishWorkspaceRuntimeReconciliation(fence)
      }

      await open()
      const stale = control.claimWorkspaceUsableSurfaceSettlement({
        ...fence,
        surface: 'sidebar-first-page',
      })
      expect(resourceStatus(control, 'storage-maintenance')).toBe('waiting')
      expect(activations).toBe(0)

      control.beginWorkspaceRuntimeQuiesce()
      await control.awaitWorkspaceRuntimeQuiesced()
      await open()
      expect(stale?.settle(outcome)).toBe(false)
      expect(resourceStatus(control, 'storage-maintenance')).toBe('waiting')
      expect(activations).toBe(0)

      const current = control.claimWorkspaceUsableSurfaceSettlement({
        ...fence,
        surface: 'sidebar-first-page',
      })
      expect(current?.settle(outcome)).toBe(true)
      expect(current?.settle(outcome)).toBe(false)
      await Promise.resolve()
      expect(resourceStatus(control, 'storage-maintenance')).toBe('ready')
      expect(activations).toBe(1)
    }
  })

  it('coalesces pre-running demand, preserves waiting aborts, and admits each operation once', async () => {
    const { runtime } = createRuntimeHarness()
    const fence = { workspaceId: 'workspace-demand-admission', replacementEpoch: 0 }
    let releaseOpen!: () => void
    const openGate = new Promise<void>((resolve) => {
      releaseOpen = resolve
    })
    let opening: Promise<void> | null = null
    let openAttempts = 0
    runtime.claimWorkspaceRuntimeDemandBoundary(() => {
      opening ??= (async () => {
        openAttempts += 1
        runtime.workspaceRuntimeInternal.beginReconciliation(fence)
        await openGate
        runtime.workspaceRuntimeInternal.finishReconciliation(fence)
      })()
      return opening
    })
    let readCalls = 0
    let actionCalls = 0
    let canceledCalls = 0

    const read = runtime.runWorkspaceRead('repository-query', (permit) => {
      readCalls += 1
      return permit.workspaceId
    })
    const action = runtime.runWorkspaceAction('chat-metadata', (permit) => {
      actionCalls += 1
      return permit.replacementEpoch
    })
    const controller = new AbortController()
    const canceledReason = new Error('waiting-operation-canceled')
    const canceled = runtime.runWorkspaceRead(
      'repository-query',
      () => {
        canceledCalls += 1
      },
      { signal: controller.signal },
    )
    controller.abort(canceledReason)

    expect(runtime.getWorkspaceRuntimeState()).toBe('RECONCILING')
    expect(openAttempts).toBe(1)
    expect(readCalls).toBe(0)
    expect(actionCalls).toBe(0)
    await expect(canceled).rejects.toBe(canceledReason)
    expect(canceledCalls).toBe(0)

    releaseOpen()
    await expect(read).resolves.toBe(fence.workspaceId)
    await expect(action).resolves.toBe(fence.replacementEpoch)
    expect(openAttempts).toBe(1)
    expect(readCalls).toBe(1)
    expect(actionCalls).toBe(1)

    const operationError = new Error('operation-failed-after-admission')
    let failedCalls = 0
    await expect(
      runtime.runWorkspaceAction('chat-metadata', () => {
        failedCalls += 1
        throw operationError
      }),
    ).rejects.toBe(operationError)
    expect(failedCalls).toBe(1)
    expect(openAttempts).toBe(1)
  })

  it('keeps pre-running demand behind one exact lifecycle owner', async () => {
    const { runtime } = createRuntimeHarness()
    const ownerA = runtime.claimWorkspaceRuntimeDemandBoundary(async () => {})

    expect(() => runtime.claimWorkspaceRuntimeDemandBoundary(async () => {})).toThrow(
      'WorkspaceRuntimeDemandBoundaryAlreadyInstalled',
    )
    runtime.releaseWorkspaceRuntimeDemandBoundary(ownerA)

    const fence = { workspaceId: 'workspace-demand-owner', replacementEpoch: 0 }
    let demandCalls = 0
    const ownerB = runtime.claimWorkspaceRuntimeDemandBoundary(async () => {
      demandCalls += 1
      runtime.workspaceRuntimeInternal.beginReconciliation(fence)
      runtime.workspaceRuntimeInternal.finishReconciliation(fence)
    })
    runtime.releaseWorkspaceRuntimeDemandBoundary(ownerA)

    await expect(
      runtime.runWorkspaceRead('repository-query', (permit) => permit.workspaceId),
    ).resolves.toBe(fence.workspaceId)
    expect(demandCalls).toBe(1)
    runtime.releaseWorkspaceRuntimeDemandBoundary(ownerB)
  })

  it('does not admit a pending demand after its exact owner is released', async () => {
    const { runtime } = createRuntimeHarness()
    let releaseDemand!: () => void
    const demand = new Promise<void>((resolve) => {
      releaseDemand = resolve
    })
    const ownerA = runtime.claimWorkspaceRuntimeDemandBoundary(() => demand)
    let readCalls = 0
    const read = runtime.runWorkspaceRead('repository-query', () => {
      readCalls += 1
    })

    runtime.releaseWorkspaceRuntimeDemandBoundary(ownerA)
    const ownerB = runtime.claimWorkspaceRuntimeDemandBoundary(async () => {})
    releaseDemand()

    await expect(read).rejects.toThrow('WorkspaceRuntimeClosed:repository-query:STARTING')
    expect(readCalls).toBe(0)
    runtime.releaseWorkspaceRuntimeDemandBoundary(ownerB)
  })

  it('admits one idle action atomically and signals only exact zero transitions', async () => {
    const { runtime } = createRuntimeHarness()
    const fence = { workspaceId: 'workspace-idle-admission', replacementEpoch: 0 }
    runtime.workspaceRuntimeInternal.beginReconciliation(fence)
    runtime.workspaceRuntimeInternal.finishReconciliation(fence)
    const transitions: string[] = []
    runtime.subscribeWorkspaceRuntimeIdle(() => transitions.push('idle'))
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = runtime.tryRunWorkspaceActionIfIdle('maintenance', async () => gate)

    expect(first).not.toBeNull()
    expect(runtime.tryRunWorkspaceActionIfIdle('maintenance', async () => undefined)).toBeNull()
    expect(transitions).toEqual([])

    release()
    await first
    expect(transitions).toEqual(['idle'])

    const second = runtime.tryRunWorkspaceActionIfIdle('maintenance', async () => undefined)
    expect(second).not.toBeNull()
    await second
    expect(transitions).toEqual(['idle', 'idle'])
  })

  it('holds maintenance checkpoints until every foreground demand owner releases', async () => {
    const { runtime } = createRuntimeHarness()
    const first = runtime.claimWorkspaceForegroundDemand()
    const second = runtime.claimWorkspaceForegroundDemand()
    let resumed = false
    const checkpoint = runtime.awaitWorkspaceForegroundDemandIdle().then(() => {
      resumed = true
    })

    await Promise.resolve()
    expect(resumed).toBe(false)
    runtime.releaseWorkspaceForegroundDemand(first)
    await Promise.resolve()
    expect(resumed).toBe(false)
    runtime.releaseWorkspaceForegroundDemand(second)
    await checkpoint
    expect(resumed).toBe(true)
  })

  it('interrupts the current maintenance page once and opens a fresh interval after demand', () => {
    const { runtime } = createRuntimeHarness()
    const activeInterval = runtime.workspaceForegroundDemandInterruptionSignal()

    const first = runtime.claimWorkspaceForegroundDemand()
    const second = runtime.claimWorkspaceForegroundDemand()

    expect(activeInterval.aborted).toBe(true)
    expect(activeInterval.reason).toBeInstanceOf(WorkspaceForegroundDemandInterruptedError)
    expect(runtime.workspaceForegroundDemandInterruptionSignal()).toBe(activeInterval)
    runtime.releaseWorkspaceForegroundDemand(first)
    expect(runtime.workspaceForegroundDemandInterruptionSignal()).toBe(activeInterval)
    runtime.releaseWorkspaceForegroundDemand(second)
    expect(runtime.workspaceForegroundDemandInterruptionSignal()).not.toBe(activeInterval)
    expect(runtime.workspaceForegroundDemandInterruptionSignal().aborted).toBe(false)
  })

  it('lets an admitted replacement producer preempt active maintenance preparation', async () => {
    const { runtime } = createRuntimeHarness()
    const fence = { workspaceId: 'workspace-maintenance-preparation', replacementEpoch: 0 }
    runtime.workspaceRuntimeInternal.beginReconciliation(fence)
    runtime.workspaceRuntimeInternal.finishReconciliation(fence)
    let maintenanceSignal: AbortSignal | undefined
    const maintenance = runtime.tryRunWorkspaceActionIfIdle('maintenance', (permit) => {
      maintenanceSignal = permit.signal
      return new Promise<never>((_resolve, reject) => {
        permit.signal.addEventListener('abort', () => reject(permit.signal.reason), {
          once: true,
        })
      })
    })
    if (!maintenance) throw new Error('Expected maintenance preparation admission')

    await runtime.runWorkspaceAction('workspace-replacement', (permit) => {
      runtime.preemptWorkspaceMaintenancePreparation(permit)
    })

    expect(maintenanceSignal?.aborted).toBe(true)
    expect(maintenanceSignal?.reason).toBeInstanceOf(WorkspaceMaintenancePreemptedError)
    await expect(maintenance).rejects.toBeInstanceOf(WorkspaceMaintenancePreemptedError)
  })

  it('preempts only unpromoted replacement contenders for a durable peer transition', async () => {
    const { runtime } = createRuntimeHarness()
    const fence = { workspaceId: 'workspace-replacement-contender', replacementEpoch: 0 }
    runtime.workspaceRuntimeInternal.beginReconciliation(fence)
    runtime.workspaceRuntimeInternal.finishReconciliation(fence)
    let contenderSignal: AbortSignal | undefined
    const contender = runtime.runWorkspaceAction('workspace-replacement', (permit) => {
      contenderSignal = permit.signal
      return new Promise<never>((_resolve, reject) => {
        permit.signal.addEventListener('abort', () => reject(permit.signal.reason), {
          once: true,
        })
      })
    })
    const unrelated = runtime.runWorkspaceAction('import-export', () => Promise.resolve())

    runtime.preemptWorkspaceReplacementContendersForRemoteTransition()

    expect(contenderSignal?.aborted).toBe(true)
    await expect(contender).rejects.toBeInstanceOf(WorkspaceReplacementContenderPreemptedError)
    await expect(unrelated).resolves.toBeUndefined()
  })

  it('preempts sibling replacement contenders during atomic local promotion', async () => {
    const { control, runtime } = createRuntimeHarness()
    installNoopResourceManifest(control)
    const fence = { workspaceId: 'workspace-local-replacement-contenders', replacementEpoch: 0 }
    runtime.workspaceRuntimeInternal.beginReconciliation(fence)
    runtime.workspaceRuntimeInternal.finishReconciliation(fence)
    let ownerPermit: WorkspaceWritePermit | undefined
    let contenderSignal: AbortSignal | undefined
    let releaseOwner!: () => void
    const ownerGate = new Promise<void>((resolve) => {
      releaseOwner = resolve
    })
    const owner = runtime.runWorkspaceAction('workspace-replacement', async (permit) => {
      ownerPermit = permit
      await ownerGate
    })
    const contender = runtime.runWorkspaceAction('workspace-replacement', (permit) => {
      contenderSignal = permit.signal
      return new Promise<never>((_resolve, reject) => {
        permit.signal.addEventListener('abort', () => reject(permit.signal.reason), {
          once: true,
        })
      })
    })
    if (!ownerPermit) throw new Error('Expected replacement owner permit')

    const authority = control.launchWorkspaceRuntimeReplacementNow('workspace-replacement', {
      lineageId: ownerPermit.lineageId,
      requireIdle: false,
    })

    expect(authority).not.toBeNull()
    expect(contenderSignal?.aborted).toBe(true)
    await expect(contender).rejects.toBeInstanceOf(WorkspaceReplacementContenderPreemptedError)
    releaseOwner()
    await owner
  })

  it('refuses idle quiescence while a generation root is active and never aborts it', async () => {
    const { control, runtime } = createRuntimeHarness()
    const manifest = Object.fromEntries(
      control.WORKSPACE_RUNTIME_RESOURCE_IDS.map((id) => {
        const phase = resourcePhase(id)
        return [
          id,
          {
            id,
            phase,
            closeAdmissions: () => undefined,
            abort: () => undefined,
            awaitIdle: async () => undefined,
            assertClosed: () => undefined,
            ...(isCoreResourcePhase(phase)
              ? { resume: () => undefined }
              : isBackgroundResourceId(id)
                ? { attach: (): void => undefined, prerequisites: [], activate: () => undefined }
                : { attach: (): void => undefined }),
          },
        ]
      }),
    ) as unknown as Parameters<typeof control.installWorkspaceRuntimeResources>[0]
    control.installWorkspaceRuntimeResources(manifest, reconciliationManifest())
    const fence = { workspaceId: 'workspace-idle-quiesce', replacementEpoch: 0 }
    runtime.workspaceRuntimeInternal.beginReconciliation(fence)
    runtime.workspaceRuntimeInternal.finishReconciliation(fence)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let generationAborted = false
    const generation = runtime.runWorkspaceAction('conversation-generation', async (permit) => {
      permit.signal.addEventListener('abort', () => {
        generationAborted = true
      })
      await gate
    })
    let idleQuiesceAdmitted = false
    runtime.subscribeWorkspaceRuntimeIdle(() => {
      idleQuiesceAdmitted = control.tryBeginWorkspaceRuntimeQuiesceIfIdle()
    })

    expect(control.tryBeginWorkspaceRuntimeQuiesceIfIdle()).toBe(false)
    expect(generationAborted).toBe(false)
    release()
    await generation

    expect(idleQuiesceAdmitted).toBe(true)
    expect(generationAborted).toBe(false)
    await control.awaitWorkspaceRuntimeQuiesced()
    expect(control.getWorkspaceRuntimeControlSnapshot()).toMatchObject({
      state: 'QUIESCED',
      resourcesQuiesced: true,
    })
  })

  it('drains durable replacement peers and cancels disposable roots from one exhaustive policy', async () => {
    const { control, runtime } = createRuntimeHarness()
    const manifest = Object.fromEntries(
      control.WORKSPACE_RUNTIME_RESOURCE_IDS.map((id) => {
        const phase = resourcePhase(id)
        return [
          id,
          {
            id,
            phase,
            closeAdmissions: () => undefined,
            abort: () => undefined,
            awaitIdle: async () => undefined,
            assertClosed: () => undefined,
            ...(isCoreResourcePhase(phase)
              ? { resume: () => undefined }
              : isBackgroundResourceId(id)
                ? { attach: (): void => undefined, prerequisites: [], activate: () => undefined }
                : { attach: (): void => undefined }),
          },
        ]
      }),
    ) as unknown as Parameters<typeof control.installWorkspaceRuntimeResources>[0]
    control.installWorkspaceRuntimeResources(manifest, reconciliationManifest())
    const fence = { workspaceId: 'workspace-graceful-replacement', replacementEpoch: 0 }
    runtime.workspaceRuntimeInternal.beginReconciliation(fence)
    runtime.workspaceRuntimeInternal.finishReconciliation(fence)
    let releasePeer!: () => void
    const peerGate = new Promise<void>((resolve) => {
      releasePeer = resolve
    })
    let peerPermit: WorkspaceWritePermit | undefined
    const peer = runtime.runWorkspaceAction('chat-metadata', async (permit) => {
      peerPermit = permit
      await peerGate
    })
    let disposablePermit: WorkspaceWritePermit | undefined
    let disposableAborted = false
    const disposable = runtime.runWorkspaceAction('cache-refresh', async (permit) => {
      disposablePermit = permit
      await new Promise<void>((resolve) => {
        permit.signal.addEventListener(
          'abort',
          () => {
            disposableAborted = true
            resolve()
          },
          { once: true },
        )
      })
    })

    const replacementAuthority = control.launchWorkspaceRuntimeReplacementNow(
      'workspace-replacement',
      { requireIdle: false },
    )
    expect(replacementAuthority).not.toBeNull()
    const replacement = control.awaitWorkspaceRuntimeQuiesced()

    expect(control.getWorkspaceRuntimeControlSnapshot().state).toBe('QUIESCING')
    expect(peerPermit?.signal.aborted).toBe(false)
    expect(disposablePermit?.signal.aborted).toBe(true)
    expect(disposableAborted).toBe(true)
    expect(() => runtime.runWorkspaceRead('repository-query', async () => undefined)).toThrow(
      'WorkspaceRuntimeClosed:repository-query:QUIESCING',
    )
    const child = runtime.reserveWorkspaceChild(
      peerPermit as Parameters<typeof runtime.reserveWorkspaceChild>[0],
      'post-commit',
    )
    await runtime.runWorkspacePhase(child, async () => undefined)

    releasePeer()
    await peer
    await disposable
    await replacement
    expect(peerPermit?.signal.aborted).toBe(false)
    expect(control.getWorkspaceRuntimeControlSnapshot()).toMatchObject({
      state: 'QUIESCED',
      resourcesQuiesced: true,
    })
    expect(runtime.WORKSPACE_ROOT_REPLACEMENT_DISPOSITIONS['conversation-generation']).toBe('block')
    expect(runtime.WORKSPACE_ROOT_REPLACEMENT_DISPOSITIONS['chat-metadata']).toBe('drain')
    expect(runtime.WORKSPACE_ROOT_REPLACEMENT_DISPOSITIONS['cache-refresh']).toBe('cancel')
  })

  it('drains cleanup started by graceful resource abort before proving closure', async () => {
    const { control } = createRuntimeHarness()
    let producerAttached = false
    let producerAborted = false
    let releaseAbortCleanup!: () => void
    const abortCleanup = new Promise<void>((resolve) => {
      releaseAbortCleanup = resolve
    })
    const manifest = Object.fromEntries(
      control.WORKSPACE_RUNTIME_RESOURCE_IDS.map((id) => {
        const phase = resourcePhase(id)
        return [
          id,
          {
            id,
            phase,
            closeAdmissions: () => undefined,
            abort: () => {
              if (id === 'storage-maintenance') producerAborted = true
            },
            awaitIdle: () =>
              id === 'storage-maintenance' && producerAborted
                ? abortCleanup.then(() => {
                    producerAttached = false
                  })
                : Promise.resolve(),
            assertClosed: () => {
              if (id === 'storage-maintenance' && producerAttached) {
                throw new Error('abort cleanup remained active')
              }
            },
            ...(isCoreResourcePhase(phase)
              ? { resume: () => undefined }
              : isBackgroundResourceId(id)
                ? {
                    attach: (): void => {
                      if (id === 'storage-maintenance') producerAttached = true
                    },
                    prerequisites: [],
                    activate: () => undefined,
                  }
                : { attach: (): void => undefined }),
          },
        ]
      }),
    ) as unknown as Parameters<typeof control.installWorkspaceRuntimeResources>[0]
    control.installWorkspaceRuntimeResources(manifest, reconciliationManifest())
    const fence = { workspaceId: 'workspace-abort-cleanup', replacementEpoch: 0 }
    const opening = control.beginWorkspaceRuntimeReconciliation(fence)
    await control.resumeWorkspaceRuntimeResources(opening)
    await control.finishWorkspaceRuntimeReconciliation(fence)

    const replacement = control.launchWorkspaceRuntimeReplacementNow('workspace-replacement', {
      requireIdle: false,
    })
    expect(replacement).not.toBeNull()
    const quiescing = control.awaitWorkspaceRuntimeQuiesced()
    await vi.waitFor(() => expect(producerAborted).toBe(true))
    expect(control.getWorkspaceRuntimeControlSnapshot().state).toBe('QUIESCING')

    releaseAbortCleanup()
    await quiescing
    expect(control.getWorkspaceRuntimeControlSnapshot()).toMatchObject({
      state: 'QUIESCED',
      resourcesQuiesced: true,
    })
  })

  it('attributes a failed closure invariant to its exact resource without losing the cause', async () => {
    const { control, runtime } = createRuntimeHarness()
    const root = new Error('resource stayed open')
    let attached = false
    const manifest = Object.fromEntries(
      control.WORKSPACE_RUNTIME_RESOURCE_IDS.map((id) => {
        const phase = resourcePhase(id)
        return [
          id,
          {
            id,
            phase,
            closeAdmissions: () => undefined,
            abort: () => undefined,
            awaitIdle: async () => undefined,
            assertClosed: () => {
              if (id === 'storage-maintenance' && attached) throw root
            },
            ...(isCoreResourcePhase(phase)
              ? { resume: () => undefined }
              : isBackgroundResourceId(id)
                ? {
                    attach: (): void => {
                      if (id === 'storage-maintenance') attached = true
                    },
                    prerequisites: [],
                    activate: () => undefined,
                  }
                : { attach: (): void => undefined }),
          },
        ]
      }),
    ) as unknown as Parameters<typeof control.installWorkspaceRuntimeResources>[0]
    control.installWorkspaceRuntimeResources(manifest, reconciliationManifest())
    const fence = { workspaceId: 'workspace-closure-attribution', replacementEpoch: 0 }
    const opening = control.beginWorkspaceRuntimeReconciliation(fence)
    await control.resumeWorkspaceRuntimeResources(opening)
    await control.finishWorkspaceRuntimeReconciliation(fence)
    control.beginWorkspaceRuntimeQuiesce()

    const failure = await control.awaitWorkspaceRuntimeQuiesced().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AggregateError)
    const failureErrors: unknown = (failure as AggregateError).errors
    const failureConstituents: readonly unknown[] = Array.isArray(failureErrors)
      ? failureErrors
      : []
    const closure = failureConstituents.find(
      (error: unknown) =>
        error instanceof AggregateError &&
        error.message === 'WorkspaceRuntimeResourceClosureFailed:storage-maintenance',
    )
    expect(closure).toBeInstanceOf(AggregateError)
    const closureErrors: unknown = (closure as AggregateError).errors
    expect(closureErrors).toEqual([root])
    expect((closure as Error).cause).toBe(root)
    expect(runtime.getWorkspaceRuntimeState()).toBe('SEALED')
  })

  it('publishes exact generation-blocker release to a cancellable foreground replacement wait', async () => {
    const { runtime } = createRuntimeHarness()
    const fence = { workspaceId: 'workspace-replacement-blocker-wait', replacementEpoch: 0 }
    runtime.workspaceRuntimeInternal.beginReconciliation(fence)
    runtime.workspaceRuntimeInternal.finishReconciliation(fence)
    let releaseGeneration!: () => void
    const generationGate = new Promise<void>((resolve) => {
      releaseGeneration = resolve
    })
    let generationAborted = false
    const generation = runtime.runWorkspaceAction(
      'conversation-generation',
      async (permit) => {
        permit.signal.addEventListener('abort', () => {
          generationAborted = true
        })
        await generationGate
      },
      { lineageId: 'generation:blocking-stream' },
    )
    const foreground = new AbortController()
    let replacementUnblocked = false
    const waiting = runtime
      .waitForWorkspaceRuntimeReplacementBlockers({
        signal: foreground.signal,
        lineageId: 'foreground-delete',
      })
      .then(() => {
        replacementUnblocked = true
      })

    await Promise.resolve()
    expect(replacementUnblocked).toBe(false)
    expect(generationAborted).toBe(false)

    releaseGeneration()
    await generation
    await waiting

    expect(replacementUnblocked).toBe(true)
    expect(generationAborted).toBe(false)
    expect(runtime.getWorkspaceRuntimeState()).toBe('RUNNING')
  })

  it('atomically promotes a prepared replacement when its last generation blocker releases', async () => {
    const { control, runtime } = createRuntimeHarness()
    installNoopResourceManifest(control)
    const fence = { workspaceId: 'workspace-prepared-promotion', replacementEpoch: 0 }
    runtime.workspaceRuntimeInternal.beginReconciliation(fence)
    runtime.workspaceRuntimeInternal.finishReconciliation(fence)
    let releaseGeneration!: () => void
    const generationGate = new Promise<void>((resolve) => {
      releaseGeneration = resolve
    })
    let generationAborted = false
    const generation = runtime.runWorkspaceAction(
      'conversation-generation',
      async (permit) => {
        permit.signal.addEventListener('abort', () => {
          generationAborted = true
        })
        await generationGate
      },
      { lineageId: 'generation:late-copy-blocker' },
    )
    let promoted = false
    const promotion = control
      .launchWorkspaceRuntimeReplacementWhenUnblocked('workspace-replacement', {
        lineageId: 'foreground-import',
        requireIdle: false,
      })
      .then((authority) => {
        promoted = true
        return authority
      })

    await Promise.resolve()
    expect(promoted).toBe(false)
    expect(generationAborted).toBe(false)
    expect(runtime.getWorkspaceRuntimeState()).toBe('RUNNING')

    releaseGeneration()
    await generation
    const authority = await promotion
    expect(authority).not.toBeNull()
    expect(generationAborted).toBe(false)
    expect(runtime.getWorkspaceRuntimeState()).toBe('QUIESCING')
    expect(() => runtime.runWorkspaceAction('conversation-generation', () => undefined)).toThrow(
      'WorkspaceRuntimeClosed:conversation-generation:QUIESCING',
    )
    await control.awaitWorkspaceRuntimeQuiesced()
  })

  it('promotes maintenance from the settled release of one overlapping local root', async () => {
    const { control, runtime } = createRuntimeHarness()
    installNoopResourceManifest(control)
    const fence = { workspaceId: 'workspace-maintenance-root-release', replacementEpoch: 0 }
    runtime.workspaceRuntimeInternal.beginReconciliation(fence)
    runtime.workspaceRuntimeInternal.finishReconciliation(fence)
    let releaseLocalRoot!: () => void
    const localRootGate = new Promise<void>((resolve) => {
      releaseLocalRoot = resolve
    })
    let promoted = false

    const maintenance = runtime.tryRunWorkspaceActionIfIdle('maintenance', async (permit) => {
      const localRoot = runtime.runWorkspaceAction('chat-metadata', () => localRootGate)
      const promotion = control
        .launchWorkspaceRuntimeReplacementWhenUnblocked('maintenance', {
          signal: permit.signal,
          lineageId: permit.lineageId,
          requireIdle: true,
        })
        .then((authority) => {
          promoted = true
          return authority
        })

      await Promise.resolve()
      expect(promoted).toBe(false)
      expect(runtime.getWorkspaceRuntimeState()).toBe('RUNNING')

      releaseLocalRoot()
      await localRoot
      const authority = await promotion
      expect(authority).not.toBeNull()
    })
    if (!maintenance) throw new Error('Expected maintenance admission')
    await maintenance

    expect(promoted).toBe(true)
    expect(runtime.getWorkspaceRuntimeState()).toBe('QUIESCING')
    await control.awaitWorkspaceRuntimeQuiesced()
  })

  it('cancels a foreground replacement wait without touching its blocking generation', async () => {
    const { runtime } = createRuntimeHarness()
    const fence = { workspaceId: 'workspace-replacement-blocker-cancel', replacementEpoch: 0 }
    runtime.workspaceRuntimeInternal.beginReconciliation(fence)
    runtime.workspaceRuntimeInternal.finishReconciliation(fence)
    let releaseGeneration!: () => void
    const generationGate = new Promise<void>((resolve) => {
      releaseGeneration = resolve
    })
    let generationAborted = false
    const generation = runtime.runWorkspaceAction('conversation-generation', async (permit) => {
      permit.signal.addEventListener('abort', () => {
        generationAborted = true
      })
      await generationGate
    })
    const foreground = new AbortController()
    const reason = new Error('delete-cancelled')
    const waiting = runtime.waitForWorkspaceRuntimeReplacementBlockers({
      signal: foreground.signal,
    })

    foreground.abort(reason)
    await expect(waiting).rejects.toBe(reason)
    expect(generationAborted).toBe(false)

    releaseGeneration()
    await generation
  })

  it('keeps caller cancellation linked after promotion to replacement authority', () => {
    const { control, runtime } = createRuntimeHarness()
    installNoopResourceManifest(control)
    const fence = { workspaceId: 'workspace-replacement-cancellation', replacementEpoch: 0 }
    runtime.workspaceRuntimeInternal.beginReconciliation(fence)
    runtime.workspaceRuntimeInternal.finishReconciliation(fence)
    const caller = new AbortController()
    const reason = new Error('replacement-caller-cancelled')

    const authority = control.launchWorkspaceRuntimeReplacementNow('workspace-replacement', {
      signal: caller.signal,
      requireIdle: false,
    })
    if (!authority) throw new Error('Expected replacement authority')
    expect(authority.signal.aborted).toBe(false)

    caller.abort(reason)

    expect(authority.signal.aborted).toBe(true)
    expect(authority.signal.reason).toBe(reason)
  })

  it('transfers a promoted maintenance root away from producer cancellation', async () => {
    const { control, runtime } = createRuntimeHarness()
    installNoopResourceManifest(control)
    const fence = { workspaceId: 'workspace-maintenance-transfer', replacementEpoch: 0 }
    runtime.workspaceRuntimeInternal.beginReconciliation(fence)
    runtime.workspaceRuntimeInternal.finishReconciliation(fence)
    const producer = new AbortController()
    let authoritySignal: AbortSignal | undefined

    const maintenance = runtime.tryRunWorkspaceActionIfIdle(
      'maintenance',
      (permit) => {
        const authority = control.launchWorkspaceRuntimeReplacementNow('maintenance', {
          lineageId: permit.lineageId,
          requireIdle: false,
        })
        if (!authority) throw new Error('Expected promoted maintenance replacement authority')
        authoritySignal = authority.signal
      },
      { signal: producer.signal },
    )
    if (!maintenance) throw new Error('Expected maintenance admission')
    await maintenance

    producer.abort(new Error('producer resource closed'))

    expect(authoritySignal?.aborted).toBe(false)
    await control.awaitWorkspaceRuntimeQuiesced()
  })

  it('promotes an admitted replacement lineage without a second active root', async () => {
    const { control, runtime } = createRuntimeHarness()
    installNoopResourceManifest(control)
    const fence = { workspaceId: 'workspace-import-replacement', replacementEpoch: 0 }
    runtime.workspaceRuntimeInternal.beginReconciliation(fence)
    runtime.workspaceRuntimeInternal.finishReconciliation(fence)
    let authoritySignal: AbortSignal | undefined
    let permitSignal: AbortSignal | undefined

    await runtime.runWorkspaceAction('workspace-replacement', (permit) => {
      permitSignal = permit.signal
      const authority = control.launchWorkspaceRuntimeReplacementNow('workspace-replacement', {
        lineageId: permit.lineageId,
        requireIdle: false,
      })
      if (!authority) throw new Error('Expected import replacement authority')
      authoritySignal = authority.signal
      expect(control.getWorkspaceRuntimeControlSnapshot().state).toBe('QUIESCING')
    })

    expect(authoritySignal).toBe(permitSignal)
    await control.awaitWorkspaceRuntimeQuiesced()
    expect(control.getWorkspaceRuntimeControlSnapshot()).toMatchObject({
      state: 'QUIESCED',
      resourcesQuiesced: true,
    })
  })

  it('makes maintenance replacement authority options producer-signal-free by type', () => {
    type MaintenanceAuthorityOptions = NonNullable<
      Parameters<typeof tryLaunchMaintenanceWorkspaceRuntimeReplacementIfIdle>[0]
    >

    expectTypeOf<keyof MaintenanceAuthorityOptions>().toEqualTypeOf<'lineageId'>()
  })

  it('preempts maintenance replacement for a foreground intent and admits it after rollback', async () => {
    const { control, runtime } = createRuntimeHarness()
    installNoopResourceManifest(control)
    const fence = { workspaceId: 'workspace-maintenance-preemption', replacementEpoch: 0 }
    const opening = control.beginWorkspaceRuntimeReconciliation(fence)
    await control.resumeWorkspaceRuntimeResources(opening)
    await control.finishWorkspaceRuntimeReconciliation(fence)

    let releaseDemand!: () => void
    const demand = new Promise<void>((resolve) => {
      releaseDemand = resolve
    })
    const demandOwner = runtime.claimWorkspaceRuntimeDemandBoundary(() => demand)
    const maintenance = control.launchWorkspaceRuntimeReplacementNow('maintenance', {
      requireIdle: true,
    })
    if (!maintenance) throw new Error('Expected maintenance replacement authority')

    let admitted = 0
    const foreground = runtime.runWorkspaceAction('message-edit', () => {
      admitted += 1
    })

    expect(maintenance.signal.aborted).toBe(true)
    expect(maintenance.signal.reason).toBeInstanceOf(WorkspaceMaintenancePreemptedError)
    expect(admitted).toBe(0)

    await control.awaitWorkspaceRuntimeQuiesced()
    const rollback = control.beginWorkspaceRuntimeReconciliation(fence)
    await control.resumeWorkspaceRuntimeResources(rollback)
    await control.finishWorkspaceRuntimeReconciliation(fence)
    releaseDemand()
    await foreground

    expect(admitted).toBe(1)
    runtime.releaseWorkspaceRuntimeDemandBoundary(demandOwner)
  })

  it('attaches every capability before RUNNING and starts background work after the commit', async () => {
    const { control, runtime } = createRuntimeHarness()
    const attached = new Set<string>()
    const activated: string[] = []
    let releaseAttemptHydration!: () => void
    const attemptHydration = new Promise<void>((resolve) => {
      releaseAttemptHydration = resolve
    })
    const capabilityIds = control.WORKSPACE_RUNTIME_RESOURCE_IDS.filter(
      (id) => !isCoreResourcePhase(resourcePhase(id)),
    )
    const backgroundIds = capabilityIds.filter(isBackgroundResourceId)
    const manifest = Object.fromEntries(
      control.WORKSPACE_RUNTIME_RESOURCE_IDS.map((id) => {
        const phase = resourcePhase(id)
        return [
          id,
          {
            id,
            phase,
            closeAdmissions: () => undefined,
            abort: () => undefined,
            awaitIdle: async () => undefined,
            assertClosed: () => undefined,
            ...(isCoreResourcePhase(phase)
              ? { resume: () => undefined }
              : isBackgroundResourceId(id)
                ? {
                    attach: () => {
                      attached.add(id)
                    },
                    prerequisites: [],
                    activate: () => {
                      activated.push(id)
                      return id === 'attempt-workspace' ? attemptHydration : undefined
                    },
                  }
                : {
                    attach: () => {
                      attached.add(id)
                    },
                  }),
          },
        ]
      }),
    ) as unknown as Parameters<typeof control.installWorkspaceRuntimeResources>[0]
    control.installWorkspaceRuntimeResources(manifest, reconciliationManifest())
    const fence = { workspaceId: 'workspace-sync-capability-attach', replacementEpoch: 0 }
    const authority = control.beginWorkspaceRuntimeReconciliation(fence)
    await control.resumeWorkspaceRuntimeResources(authority)
    let resolveFirstGesture: () => void = () => undefined
    let rejectFirstGesture: (error: unknown) => void = () => undefined
    const firstGesture = new Promise<void>((resolve, reject) => {
      resolveFirstGesture = resolve
      rejectFirstGesture = reject
    })
    let gestureAttachmentCount = -1
    let gestureActivationCount = -1
    runtime.subscribeWorkspaceRuntimeState(() => {
      if (runtime.getWorkspaceRuntimeState() !== 'RUNNING') return
      void runtime
        .runWorkspaceAction('chat-metadata', () => {
          gestureAttachmentCount = attached.size
          gestureActivationCount = activated.length
        })
        .then(resolveFirstGesture, rejectFirstGesture)
    })

    await control.finishWorkspaceRuntimeReconciliation(fence)
    await firstGesture

    expect([...attached].sort()).toEqual([...capabilityIds].sort())
    expect(gestureAttachmentCount).toBe(capabilityIds.length)
    expect(gestureActivationCount).toBe(0)
    expect([...activated].sort()).toEqual([...backgroundIds].sort())
    expect(runtime.getWorkspaceRuntimeState()).toBe('RUNNING')
    releaseAttemptHydration()
  })

  it('closes every capability without leaking when quiescence begins at the first RUNNING observer', async () => {
    const { control, runtime } = createRuntimeHarness()
    const activated: string[] = []
    const activationAborted: string[] = []
    const manifest = Object.fromEntries(
      control.WORKSPACE_RUNTIME_RESOURCE_IDS.map((id) => {
        const phase = resourcePhase(id)
        return [
          id,
          {
            id,
            phase,
            closeAdmissions: () => undefined,
            abort: () => undefined,
            awaitIdle: async () => undefined,
            assertClosed: () => undefined,
            ...(isCoreResourcePhase(phase)
              ? { resume: () => undefined }
              : isBackgroundResourceId(id)
                ? {
                    attach: (): void => undefined,
                    prerequisites: [],
                    activate: ({ signal }: { signal: AbortSignal }) => {
                      activated.push(id)
                      return new Promise<void>((resolve) => {
                        const finish = () => {
                          activationAborted.push(id)
                          resolve()
                        }
                        if (signal.aborted) finish()
                        else signal.addEventListener('abort', finish, { once: true })
                      })
                    },
                  }
                : {
                    attach: (): void => undefined,
                  }),
          },
        ]
      }),
    ) as unknown as Parameters<typeof control.installWorkspaceRuntimeResources>[0]
    control.installWorkspaceRuntimeResources(manifest, reconciliationManifest())
    const fence = { workspaceId: 'workspace-immediate-capability-close', replacementEpoch: 0 }
    const authority = control.beginWorkspaceRuntimeReconciliation(fence)
    await control.resumeWorkspaceRuntimeResources(authority)
    runtime.subscribeWorkspaceRuntimeState(() => {
      if (runtime.getWorkspaceRuntimeState() === 'RUNNING') {
        control.beginWorkspaceRuntimeQuiesce()
      }
    })

    await control.finishWorkspaceRuntimeReconciliation(fence)
    await control.awaitWorkspaceRuntimeQuiesced()

    expect(activated).toEqual([])
    expect(activationAborted).toEqual([])
    expect(control.getWorkspaceRuntimeControlSnapshot()).toMatchObject({
      state: 'QUIESCED',
      resourcesQuiesced: true,
    })
    expect(control.getWorkspaceRuntimeResourceStatuses()).toEqual(
      control.WORKSPACE_RUNTIME_RESOURCE_IDS.map((id) => ({
        id,
        status: 'closed',
        failed: false,
        failure: null,
      })),
    )
  })

  it('starts supervised background work independently inside the RUNNING commit', async () => {
    const { control } = createRuntimeHarness()
    let releaseTransport!: () => void
    const transportGate = new Promise<void>((resolve) => {
      releaseTransport = resolve
    })
    const activated: string[] = []
    const manifest = Object.fromEntries(
      control.WORKSPACE_RUNTIME_RESOURCE_IDS.map((id) => {
        const phase = resourcePhase(id)
        return [
          id,
          {
            id,
            phase,
            closeAdmissions: () => undefined,
            abort: () => undefined,
            awaitIdle: async () => undefined,
            assertClosed: () => undefined,
            ...(isCoreResourcePhase(phase)
              ? { resume: () => undefined }
              : isBackgroundResourceId(id)
                ? {
                    attach: (): void => undefined,
                    prerequisites: [],
                    activate: () => {
                      activated.push(id)
                      return id === 'storage-maintenance' ? transportGate : undefined
                    },
                  }
                : {
                    attach: (): void => undefined,
                  }),
          },
        ]
      }),
    ) as unknown as Parameters<typeof control.installWorkspaceRuntimeResources>[0]
    control.installWorkspaceRuntimeResources(manifest, reconciliationManifest())
    const fence = { workspaceId: 'workspace-independent-capabilities', replacementEpoch: 0 }
    const authority = control.beginWorkspaceRuntimeReconciliation(fence)
    await control.resumeWorkspaceRuntimeResources(authority)
    await control.finishWorkspaceRuntimeReconciliation(fence)

    expect(activated).toContain('storage-maintenance')
    expect(
      control
        .getWorkspaceRuntimeResourceStatuses()
        .find((resource) => resource.id === 'storage-maintenance'),
    ).toMatchObject({ status: 'opening', failed: false })
    releaseTransport()
  })

  it('keeps the runtime reconciling until core readiness is complete', async () => {
    const { control, runtime } = createRuntimeHarness()
    let releaseReadiness!: () => void
    const readinessGate = new Promise<void>((resolve) => {
      releaseReadiness = resolve
    })
    const resumed: string[] = []
    const attached: string[] = []
    const manifest = Object.fromEntries(
      control.WORKSPACE_RUNTIME_RESOURCE_IDS.map((id) => {
        const phase = resourcePhase(id)
        return [
          id,
          {
            id,
            phase,
            closeAdmissions: () => undefined,
            abort: () => undefined,
            awaitIdle: async () => undefined,
            assertClosed: () => undefined,
            ...(isCoreResourcePhase(phase)
              ? {
                  resume: () => {
                    resumed.push(id)
                    return id === 'browser-workspace-session' ? readinessGate : undefined
                  },
                }
              : isBackgroundResourceId(id)
                ? {
                    attach: () => {
                      attached.push(id)
                    },
                    prerequisites: [],
                    activate: () => undefined,
                  }
                : {
                    attach: () => {
                      attached.push(id)
                    },
                  }),
          },
        ]
      }),
    ) as unknown as Parameters<typeof control.installWorkspaceRuntimeResources>[0]
    control.installWorkspaceRuntimeResources(manifest, reconciliationManifest())
    const fence = { workspaceId: 'workspace-delayed-preparation', replacementEpoch: 0 }
    const authority = control.beginWorkspaceRuntimeReconciliation(fence)
    const resuming = control.resumeWorkspaceRuntimeResources(authority)

    await vi.waitFor(() => expect(resumed).toEqual(['browser-workspace-session']))
    expect(runtime.getWorkspaceRuntimeState()).toBe('RECONCILING')
    expect(attached).toEqual([])
    expect(
      control
        .getWorkspaceRuntimeResourceStatuses()
        .find((resource) => resource.id === 'browser-workspace-session'),
    ).toMatchObject({ status: 'resuming', failed: false })

    releaseReadiness()
    await resuming
    expect(runtime.getWorkspaceRuntimeState()).toBe('RECONCILING')
    expect(attached).toEqual([])
    await control.finishWorkspaceRuntimeReconciliation(fence)
    expect(runtime.getWorkspaceRuntimeState()).toBe('RUNNING')
    expect(attached.sort()).toEqual(
      control.WORKSPACE_RUNTIME_RESOURCE_IDS.filter(
        (id) => !isCoreResourcePhase(resourcePhase(id)),
      ).sort(),
    )
  })

  it('rolls failed core readiness fully closed and retries through the same manifest', async () => {
    const { control, runtime } = createRuntimeHarness()
    const open = new Set<string>()
    let failReadiness = true
    const manifest = Object.fromEntries(
      control.WORKSPACE_RUNTIME_RESOURCE_IDS.map((id) => {
        const phase = resourcePhase(id)
        return [
          id,
          {
            id,
            phase,
            closeAdmissions: () => open.delete(id),
            abort: () => open.delete(id),
            awaitIdle: async () => undefined,
            assertClosed: () => {
              if (open.has(id)) throw new Error(`test resource remained open:${id}`)
            },
            ...(isCoreResourcePhase(phase)
              ? {
                  resume: () => {
                    open.add(id)
                    if (id === 'browser-workspace-session' && failReadiness) {
                      throw new Error('core readiness failed')
                    }
                  },
                }
              : isBackgroundResourceId(id)
                ? {
                    attach: () => {
                      open.add(id)
                    },
                    prerequisites: [],
                    activate: () => undefined,
                  }
                : {
                    attach: () => {
                      open.add(id)
                    },
                  }),
          },
        ]
      }),
    ) as unknown as Parameters<typeof control.installWorkspaceRuntimeResources>[0]
    control.installWorkspaceRuntimeResources(manifest, reconciliationManifest())
    const fence = { workspaceId: 'workspace-preparation-retry', replacementEpoch: 0 }

    const failedAuthority = control.beginWorkspaceRuntimeReconciliation(fence)
    await expect(control.resumeWorkspaceRuntimeResources(failedAuthority)).rejects.toThrow(
      'WorkspaceRuntimeCoreReadinessFailed',
    )
    expect(control.getWorkspaceRuntimeControlSnapshot()).toMatchObject({
      state: 'STARTING',
      resourcesQuiesced: true,
    })
    expect(open).toEqual(new Set())

    failReadiness = false
    const retryAuthority = control.beginWorkspaceRuntimeReconciliation(fence)
    await control.resumeWorkspaceRuntimeResources(retryAuthority)
    await control.finishWorkspaceRuntimeReconciliation(fence)
    expect(runtime.getWorkspaceRuntimeState()).toBe('RUNNING')
  })

  it('links open cancellation to reconciliation authority and never attaches the cancelled cycle', async () => {
    const { control, runtime } = createRuntimeHarness()
    let readinessStarted = false
    let releaseReadiness!: () => void
    const readinessGate = new Promise<void>((resolve) => {
      releaseReadiness = resolve
    })
    const attached: string[] = []
    const manifest = Object.fromEntries(
      control.WORKSPACE_RUNTIME_RESOURCE_IDS.map((id) => {
        const phase = resourcePhase(id)
        return [
          id,
          {
            id,
            phase,
            closeAdmissions: () => undefined,
            abort: () => undefined,
            awaitIdle: async () => undefined,
            assertClosed: () => undefined,
            ...(isCoreResourcePhase(phase)
              ? {
                  resume: () => {
                    if (id !== 'browser-workspace-session') return undefined
                    readinessStarted = true
                    return readinessGate
                  },
                }
              : isBackgroundResourceId(id)
                ? {
                    attach: () => {
                      attached.push(id)
                    },
                    prerequisites: [],
                    activate: () => undefined,
                  }
                : {
                    attach: () => {
                      attached.push(id)
                    },
                  }),
          },
        ]
      }),
    ) as unknown as Parameters<typeof control.installWorkspaceRuntimeResources>[0]
    control.installWorkspaceRuntimeResources(manifest, reconciliationManifest())
    const cancellation = new Error('cancel foreground preparation')
    const controller = new AbortController()
    const fence = { workspaceId: 'workspace-cancel-preparation', replacementEpoch: 0 }
    const authority = control.beginWorkspaceRuntimeReconciliation(fence, {
      signal: controller.signal,
    })
    const resuming = control.resumeWorkspaceRuntimeResources(authority)

    await vi.waitFor(() => expect(readinessStarted).toBe(true))
    controller.abort(cancellation)
    expect(authority.signal.aborted).toBe(true)
    expect(authority.signal.reason).toBe(cancellation)
    releaseReadiness()
    await resuming
    await expect(control.abortWorkspaceRuntimeReconciliation()).resolves.toEqual([])
    expect(attached).toEqual([])
    expect(runtime.getWorkspaceRuntimeState()).toBe('STARTING')
    expect(control.getWorkspaceRuntimeControlSnapshot().resourcesQuiesced).toBe(true)
  })

  it('resumes core resources in ordered phases and parallelizes each phase', async () => {
    const { control } = createRuntimeHarness()
    const events: string[] = []
    const sessionReleases = new Map<string, () => void>()
    const sessionGates = new Map(
      ['browser-workspace-session'].map((id) => [
        id,
        new Promise<void>((resolve) => sessionReleases.set(id, resolve)),
      ]),
    )
    const manifest = Object.fromEntries(
      control.WORKSPACE_RUNTIME_RESOURCE_IDS.map((id) => {
        const phase = resourcePhase(id)
        return [
          id,
          {
            id,
            phase,
            closeAdmissions: () => undefined,
            abort: () => undefined,
            awaitIdle: async () => undefined,
            assertClosed: () => undefined,
            ...(isCoreResourcePhase(phase)
              ? {
                  resume: () => {
                    events.push(`${phase}:${id}`)
                    return sessionGates.get(id)
                  },
                }
              : isBackgroundResourceId(id)
                ? { attach: (): void => undefined, prerequisites: [], activate: () => undefined }
                : { attach: (): void => undefined }),
          },
        ]
      }),
    ) as unknown as Parameters<typeof control.installWorkspaceRuntimeResources>[0]
    control.installWorkspaceRuntimeResources(manifest, reconciliationManifest())
    const authority = control.beginWorkspaceRuntimeReconciliation({
      workspaceId: 'workspace-core-phase-order',
      replacementEpoch: 0,
    })
    const resuming = control.resumeWorkspaceRuntimeResources(authority)

    await vi.waitFor(() => {
      expect(events.filter((event) => event.startsWith('session:'))).toHaveLength(1)
    })
    expect(events.some((event) => event.startsWith('transaction:'))).toBe(false)
    sessionReleases.get('browser-workspace-session')?.()
    await resuming

    const firstTransaction = events.findIndex((event) => event.startsWith('transaction:'))
    const firstLock = events.findIndex((event) => event.startsWith('lock:'))
    const firstRepository = events.findIndex((event) => event.startsWith('repository:'))
    expect(firstTransaction).toBeGreaterThan(0)
    expect(firstLock).toBeGreaterThan(firstTransaction)
    expect(firstRepository).toBeGreaterThan(firstLock)
  })

  it('keeps background capability failure local and leaves gestures admitted', async () => {
    const { control, runtime } = createRuntimeHarness()
    const backgroundFailure = new Error('maintenance-background-failed')
    const started: string[] = []
    const manifest = Object.fromEntries(
      control.WORKSPACE_RUNTIME_RESOURCE_IDS.map((id) => {
        const phase = resourcePhase(id)
        return [
          id,
          {
            id,
            phase,
            closeAdmissions: () => undefined,
            abort: () => undefined,
            awaitIdle: async () => undefined,
            assertClosed: () => undefined,
            ...(isCoreResourcePhase(phase)
              ? { resume: () => undefined }
              : isBackgroundResourceId(id)
                ? {
                    attach: (): void => undefined,
                    prerequisites: [],
                    activate: () => {
                      started.push(id)
                      if (id === 'storage-maintenance') throw backgroundFailure
                    },
                  }
                : {
                    attach: (): void => undefined,
                  }),
          },
        ]
      }),
    ) as unknown as Parameters<typeof control.installWorkspaceRuntimeResources>[0]
    control.installWorkspaceRuntimeResources(manifest, reconciliationManifest())
    const fence = { workspaceId: 'workspace-capability-local-failure', replacementEpoch: 0 }
    const authority = control.beginWorkspaceRuntimeReconciliation(fence)
    await control.resumeWorkspaceRuntimeResources(authority)
    await control.finishWorkspaceRuntimeReconciliation(fence)

    await vi.waitFor(() => {
      expect(started).toEqual(
        expect.arrayContaining([
          'storage-maintenance',
          'attempt-workspace',
          'stream-recovery',
          'generated-output-localization',
        ]),
      )
      expect(
        control
          .getWorkspaceRuntimeResourceStatuses()
          .find((resource) => resource.id === 'storage-maintenance'),
      ).toMatchObject({ status: 'failed', failed: true })
    })
    expect(runtime.getWorkspaceRuntimeState()).toBe('RUNNING')
    await expect(
      runtime.runWorkspaceAction('chat-metadata', (permit) => permit.workspaceId),
    ).resolves.toBe(fence.workspaceId)
  })

  it('keeps the installed resource manifest immutable while running', async () => {
    const {
      control,
      runtime: { workspaceRuntimeInternal },
    } = createRuntimeHarness()
    const events: string[] = []
    const manifest = (label: string) =>
      Object.fromEntries(
        control.WORKSPACE_RUNTIME_RESOURCE_IDS.map((id) => {
          const phase = resourcePhase(id)
          return [
            id,
            {
              id,
              phase,
              closeAdmissions: () => events.push(`${label}:close:${id}`),
              abort: () => events.push(`${label}:abort:${id}`),
              awaitIdle: async () => events.push(`${label}:idle:${id}`),
              assertClosed: () => undefined,
              ...(isCoreResourcePhase(phase)
                ? { resume: () => events.push(`${label}:resume:${id}`) }
                : isBackgroundResourceId(id)
                  ? {
                      attach: () => events.push(`${label}:attach:${id}`),
                      prerequisites: [],
                      activate: () => events.push(`${label}:activate:${id}`),
                    }
                  : { attach: () => events.push(`${label}:attach:${id}`) }),
            },
          ]
        }),
      ) as unknown as Parameters<typeof control.installWorkspaceRuntimeResources>[0]

    control.installWorkspaceRuntimeResources(manifest('old'), reconciliationManifest())
    const fence = { workspaceId: 'workspace-resource-rebind', replacementEpoch: 0 }
    workspaceRuntimeInternal.beginReconciliation(fence)
    workspaceRuntimeInternal.finishReconciliation(fence)
    expect(() =>
      control.installWorkspaceRuntimeResources(manifest('new'), reconciliationManifest()),
    ).toThrow('WorkspaceRuntimeResourceManifestAlreadyInstalled')

    control.beginWorkspaceRuntimeQuiesce()
    await control.awaitWorkspaceRuntimeQuiesced()
    expect(events.some((event) => event.startsWith('new:'))).toBe(false)
    expect(events).toContain('old:close:broadcast-remote-inbound')
    expect(events).toContain('old:idle:broadcast-remote-inbound')
    expect(events).toContain('old:idle:browser-workspace-session')
  })

  it('publishes no partial manifest when reconciliation validation fails', async () => {
    const { control } = createRuntimeHarness()
    const manifest = Object.fromEntries(
      control.WORKSPACE_RUNTIME_RESOURCE_IDS.map((id) => {
        const phase = resourcePhase(id)
        return [
          id,
          {
            id,
            phase,
            closeAdmissions: () => undefined,
            abort: () => undefined,
            awaitIdle: async () => undefined,
            assertClosed: () => undefined,
            ...(isCoreResourcePhase(phase)
              ? { resume: () => undefined }
              : isBackgroundResourceId(id)
                ? { attach: (): void => undefined, prerequisites: [], activate: () => undefined }
                : { attach: (): void => undefined }),
          },
        ]
      }),
    ) as unknown as Parameters<typeof control.installWorkspaceRuntimeResources>[0]

    expect(() =>
      control.installWorkspaceRuntimeResources(manifest, {
        'tab-session': {
          id: 'wrong-participant',
          reconcile: () => undefined,
        },
      } as unknown as Parameters<typeof control.installWorkspaceRuntimeResources>[1]),
    ).toThrow('WorkspaceRuntimeReconciliationParticipantIdMismatch:tab-session')
    expect(control.getWorkspaceRuntimeResourceStatuses()).toEqual([])

    expect(() =>
      control.installWorkspaceRuntimeResources(manifest, reconciliationManifest()),
    ).not.toThrow()
    expect(control.getWorkspaceRuntimeResourceStatuses()).toHaveLength(
      control.WORKSPACE_RUNTIME_RESOURCE_IDS.length,
    )
  })

  it('publishes no partial manifest when a resource closed invariant fails', async () => {
    const { control } = createRuntimeHarness()
    let failClosedInvariant = true
    const manifest = Object.fromEntries(
      control.WORKSPACE_RUNTIME_RESOURCE_IDS.map((id) => {
        const phase = resourcePhase(id)
        return [
          id,
          {
            id,
            phase,
            closeAdmissions: () => undefined,
            abort: () => undefined,
            awaitIdle: async () => undefined,
            assertClosed: () => {
              if (id === 'configuration-workspace' && failClosedInvariant) {
                throw new Error('resource was not closed')
              }
            },
            ...(isCoreResourcePhase(phase)
              ? { resume: () => undefined }
              : isBackgroundResourceId(id)
                ? { attach: (): void => undefined, prerequisites: [], activate: () => undefined }
                : { attach: (): void => undefined }),
          },
        ]
      }),
    ) as unknown as Parameters<typeof control.installWorkspaceRuntimeResources>[0]

    expect(() =>
      control.installWorkspaceRuntimeResources(manifest, reconciliationManifest()),
    ).toThrow('resource was not closed')
    expect(control.getWorkspaceRuntimeResourceStatuses()).toEqual([])

    failClosedInvariant = false
    expect(() =>
      control.installWorkspaceRuntimeResources(manifest, reconciliationManifest()),
    ).not.toThrow()
  })

  it('rolls a failed reconciliation back to closed and retries through the same manifest', async () => {
    const { control, runtime } = createRuntimeHarness()
    const open = new Set<string>()
    const manifest = Object.fromEntries(
      control.WORKSPACE_RUNTIME_RESOURCE_IDS.map((id) => {
        const phase = resourcePhase(id)
        return [
          id,
          {
            id,
            phase,
            closeAdmissions: () => open.delete(id),
            abort: () => open.delete(id),
            awaitIdle: async () => undefined,
            assertClosed: () => {
              if (open.has(id)) throw new Error(`test resource remained open:${id}`)
            },
            ...(isCoreResourcePhase(phase)
              ? { resume: () => open.add(id) }
              : isBackgroundResourceId(id)
                ? {
                    attach: () => open.add(id),
                    prerequisites: [],
                    activate: () => undefined,
                  }
                : {
                    attach: () => open.add(id),
                  }),
          },
        ]
      }),
    ) as unknown as Parameters<typeof control.installWorkspaceRuntimeResources>[0]
    let failReconciliation = true
    control.installWorkspaceRuntimeResources(manifest, {
      'tab-session': {
        id: 'tab-session',
        reconcile: () => {
          if (failReconciliation) throw new Error('reconciliation failed once')
        },
      },
    })
    const fence = { workspaceId: 'workspace-reconciliation-retry', replacementEpoch: 0 }

    const failedAuthority = control.beginWorkspaceRuntimeReconciliation(fence)
    await expect(control.resumeWorkspaceRuntimeResources(failedAuthority)).rejects.toThrow(
      'WorkspaceRuntimeCoreReconciliationFailed',
    )
    expect(control.getWorkspaceRuntimeControlSnapshot()).toMatchObject({
      state: 'STARTING',
      resourcesQuiesced: true,
    })
    expect(open).toEqual(new Set())
    expect(control.getWorkspaceRuntimeResourceStatuses()).toEqual(
      control.WORKSPACE_RUNTIME_RESOURCE_IDS.map((id) => ({
        id,
        status: 'closed',
        failed: false,
        failure: null,
      })),
    )

    failReconciliation = false
    const retryAuthority = control.beginWorkspaceRuntimeReconciliation(fence)
    await control.resumeWorkspaceRuntimeResources(retryAuthority)
    await control.finishWorkspaceRuntimeReconciliation(fence)
    expect(runtime.getWorkspaceRuntimeState()).toBe('RUNNING')

    control.beginWorkspaceRuntimeQuiesce()
    await control.awaitWorkspaceRuntimeQuiesced()
    expect(open).toEqual(new Set())
  })
})

type TestResourcePhase =
  | 'inbound'
  | 'producer'
  | 'stream-writer'
  | 'query'
  | 'repository'
  | 'transport'
  | 'lock'
  | 'transaction'
  | 'session'

function resourcePhase(id: string): TestResourcePhase {
  if (
    id === 'broadcast-remote-inbound' ||
    id === 'attempt-workspace' ||
    id === 'conversation-workspace' ||
    id === 'attachment-catalog-workspace' ||
    id === 'configuration-workspace'
  ) {
    return 'inbound'
  }
  if (
    id === 'configuration-model-resolution' ||
    id === 'stream-recovery' ||
    id === 'generated-output-localization' ||
    id === 'storage-maintenance' ||
    id === 'stream-leases'
  ) {
    return 'producer'
  }
  if (id === 'broadcast-fallback-verification' || id === 'mounted-projections') return 'query'
  if (id === 'browser-workspace-repository') return 'repository'
  if (id === 'broadcast') return 'transport'
  if (id === 'workspace-locks') return 'lock'
  if (id === 'local-transactions') return 'transaction'
  return 'session'
}

function isCoreResourcePhase(phase: TestResourcePhase): boolean {
  return (
    phase === 'session' || phase === 'transaction' || phase === 'lock' || phase === 'repository'
  )
}

function isBackgroundResourceId(id: string): boolean {
  return (
    id === 'attempt-workspace' ||
    id === 'configuration-model-resolution' ||
    id === 'stream-recovery' ||
    id === 'generated-output-localization' ||
    id === 'storage-maintenance'
  )
}

function reconciliationManifest() {
  return {
    'tab-session': {
      id: 'tab-session' as const,
      reconcile: () => undefined,
    },
  }
}

function installNoopResourceManifest(
  control: ReturnType<typeof createRuntimeHarness>['control'],
  options: {
    readonly storageMaintenancePrerequisites?: readonly WorkspaceUsableSurfaceId[]
    readonly activateStorageMaintenance?: () => void
  } = {},
) {
  const manifest = Object.fromEntries(
    control.WORKSPACE_RUNTIME_RESOURCE_IDS.map((id) => {
      const phase = resourcePhase(id)
      return [
        id,
        {
          id,
          phase,
          closeAdmissions: () => undefined,
          abort: () => undefined,
          awaitIdle: async () => undefined,
          assertClosed: () => undefined,
          ...(isCoreResourcePhase(phase)
            ? { resume: () => undefined }
            : isBackgroundResourceId(id)
              ? {
                  attach: (): void => undefined,
                  prerequisites:
                    id === 'storage-maintenance'
                      ? (options.storageMaintenancePrerequisites ?? [])
                      : [],
                  activate:
                    id === 'storage-maintenance'
                      ? (options.activateStorageMaintenance ?? (() => undefined))
                      : (): void => undefined,
                }
              : { attach: (): void => undefined }),
        },
      ]
    }),
  ) as unknown as Parameters<typeof control.installWorkspaceRuntimeResources>[0]
  control.installWorkspaceRuntimeResources(manifest, reconciliationManifest())
}

function resourceStatus(
  control: ReturnType<typeof createRuntimeHarness>['control'],
  id: string,
): string | undefined {
  return control.getWorkspaceRuntimeResourceStatuses().find((resource) => resource.id === id)
    ?.status
}
