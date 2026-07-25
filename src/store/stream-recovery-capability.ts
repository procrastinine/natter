import type { WorkspaceFence } from './repository'
import type {
  assertStreamRecoveryRuntimeClosed,
  awaitStreamRecoveryRuntimeIdle,
  closeStreamRecoveryRuntime,
  installStreamRecoveryRuntime,
  resumeStreamRecoveryRuntime,
} from './stream-recovery'
import {
  subscribeWorkspaceEffects,
  WORKSPACE_EFFECT_RECOVERY_OWNED,
  type WorkspaceEffect,
} from './workspace-effect-hub'
import { getWorkspaceRepository } from './workspace-repository'
import { runWorkspaceRead } from './workspace-runtime'
import type { WorkspaceRuntimeCapabilityActivation } from './workspace-runtime-control'

interface StreamRecoveryRuntime {
  readonly assertStreamRecoveryRuntimeClosed: typeof assertStreamRecoveryRuntimeClosed
  readonly awaitStreamRecoveryRuntimeIdle: typeof awaitStreamRecoveryRuntimeIdle
  readonly closeStreamRecoveryRuntime: typeof closeStreamRecoveryRuntime
  readonly installStreamRecoveryRuntime: typeof installStreamRecoveryRuntime
  readonly resumeStreamRecoveryRuntime: typeof resumeStreamRecoveryRuntime
}

interface StreamRecoveryCapabilityCycle {
  readonly fence: WorkspaceFence
  readonly controller: AbortController
  readonly detachActivationAbort: () => void
  requestedRevision: number
  completedRevision: number
  probe: Promise<void> | null
}

let attachedFence: WorkspaceFence | null = null
let unsubscribeEffects: (() => void) | null = null
let activeCycle: StreamRecoveryCapabilityCycle | null = null
let runtime: StreamRecoveryRuntime | null = null
let runtimeLoad: Promise<StreamRecoveryRuntime> | null = null
let runtimeResumed = false

export function attachStreamRecoveryCapability(fence: WorkspaceFence): void {
  if (attachedFence) throw new Error('StreamRecoveryCapabilityAlreadyAttached')
  attachedFence = Object.freeze({ ...fence })
  unsubscribeEffects = subscribeWorkspaceEffects({
    owner: 'stream-recovery-capability',
    impactKinds: ['stream-lease'],
    replacements: true,
    apply: receiveWorkspaceEffect,
    recover: (_error, effect) => {
      receiveWorkspaceEffect(effect)
      return WORKSPACE_EFFECT_RECOVERY_OWNED
    },
  })
}

export function activateStreamRecoveryCapability(
  activation: WorkspaceRuntimeCapabilityActivation,
): Promise<void> {
  const fence = attachedFence
  if (
    !fence ||
    fence.workspaceId !== activation.workspaceId ||
    fence.replacementEpoch !== activation.replacementEpoch
  ) {
    throw new Error('StreamRecoveryCapabilityFenceMismatch')
  }
  if (activeCycle) throw new Error('StreamRecoveryCapabilityAlreadyActive')
  const controller = new AbortController()
  const abort = () => controller.abort(activation.signal.reason)
  if (activation.signal.aborted) abort()
  else activation.signal.addEventListener('abort', abort, { once: true })
  const cycle: StreamRecoveryCapabilityCycle = {
    fence,
    controller,
    detachActivationAbort: () => activation.signal.removeEventListener('abort', abort),
    requestedRevision: 0,
    completedRevision: 0,
    probe: null,
  }
  activeCycle = cycle
  requestLeaseProbe(cycle)
  return cycle.probe ?? Promise.resolve()
}

export function closeStreamRecoveryCapability(): void {
  const cycle = activeCycle
  activeCycle = null
  cycle?.detachActivationAbort()
  cycle?.controller.abort(new DOMException('Stream recovery capability closed', 'AbortError'))
  unsubscribeEffects?.()
  unsubscribeEffects = null
  attachedFence = null
  if (runtimeResumed) runtime?.closeStreamRecoveryRuntime()
  runtimeResumed = false
}

export function abortStreamRecoveryCapability(): void {
  closeStreamRecoveryCapability()
}

export async function awaitStreamRecoveryCapabilityIdle(): Promise<void> {
  for (;;) {
    const probe = activeCycle?.probe ?? null
    const loading = runtimeLoad
    await Promise.allSettled([
      ...(probe ? [probe] : []),
      ...(loading ? [loading] : []),
      ...(runtime ? [runtime.awaitStreamRecoveryRuntimeIdle()] : []),
    ])
    if (probe === (activeCycle?.probe ?? null) && loading === runtimeLoad) return
  }
}

export function assertStreamRecoveryCapabilityClosed(): void {
  if (attachedFence || unsubscribeEffects || activeCycle || runtimeResumed) {
    throw new Error('StreamRecoveryCapabilityNotClosed')
  }
  runtime?.assertStreamRecoveryRuntimeClosed()
}

function receiveWorkspaceEffect(effect: WorkspaceEffect): void {
  const cycle = activeCycle
  if (
    !cycle ||
    effect.workspaceId !== cycle.fence.workspaceId ||
    effect.replacementEpoch !== cycle.fence.replacementEpoch
  ) {
    return
  }
  requestLeaseProbe(cycle)
}

function requestLeaseProbe(cycle: StreamRecoveryCapabilityCycle): void {
  if (activeCycle !== cycle || cycle.controller.signal.aborted || runtimeResumed) return
  cycle.requestedRevision += 1
  ensureLeaseProbe(cycle)
}

function ensureLeaseProbe(cycle: StreamRecoveryCapabilityCycle): void {
  if (activeCycle !== cycle || cycle.controller.signal.aborted || runtimeResumed) return
  if (cycle.probe) return
  const probe = drainLeaseProbes(cycle)
  cycle.probe = probe
  const settle = () => {
    if (cycle.probe === probe) cycle.probe = null
    if (
      activeCycle === cycle &&
      !cycle.controller.signal.aborted &&
      !runtimeResumed &&
      cycle.completedRevision < cycle.requestedRevision
    ) {
      ensureLeaseProbe(cycle)
    }
  }
  void probe.then(settle, settle)
}

async function drainLeaseProbes(cycle: StreamRecoveryCapabilityCycle): Promise<void> {
  while (streamRecoveryCycleNeedsProbe(cycle)) {
    const revision = cycle.requestedRevision
    let leasePresent: boolean
    try {
      const envelope = await runWorkspaceRead(
        'repository-query',
        (permit) =>
          getWorkspaceRepository().query(
            permit,
            { kind: 'stream.lease-head' },
            { signal: cycle.controller.signal },
          ),
        { signal: cycle.controller.signal },
      )
      leasePresent =
        envelope.workspaceId === cycle.fence.workspaceId &&
        envelope.replacementEpoch === cycle.fence.replacementEpoch &&
        envelope.value !== undefined
    } finally {
      cycle.completedRevision = revision
    }
    if (!leasePresent || !streamRecoveryCycleIsCurrent(cycle)) continue
    const loaded = await loadStreamRecoveryRuntime()
    if (!streamRecoveryCycleIsCurrent(cycle)) return
    loaded.installStreamRecoveryRuntime()
    loaded.resumeStreamRecoveryRuntime()
    runtimeResumed = true
  }
}

function streamRecoveryCycleIsCurrent(cycle: StreamRecoveryCapabilityCycle): boolean {
  return activeCycle === cycle && !cycle.controller.signal.aborted
}

function streamRecoveryCycleNeedsProbe(cycle: StreamRecoveryCapabilityCycle): boolean {
  return (
    streamRecoveryCycleIsCurrent(cycle) &&
    !runtimeResumed &&
    cycle.completedRevision < cycle.requestedRevision
  )
}

function loadStreamRecoveryRuntime(): Promise<StreamRecoveryRuntime> {
  if (runtime) return Promise.resolve(runtime)
  if (runtimeLoad) return runtimeLoad
  const loading = import('./stream-recovery')
  runtimeLoad = loading
  void loading.then(
    (loaded) => {
      runtime = loaded
      if (runtimeLoad === loading) runtimeLoad = null
    },
    () => {
      if (runtimeLoad === loading) runtimeLoad = null
    },
  )
  return loading
}
