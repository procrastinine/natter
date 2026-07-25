import type {
  abortGeneratedOutputLocalizationRuntime,
  assertGeneratedOutputLocalizationRuntimeClosed,
  awaitGeneratedOutputLocalizationRuntimeIdle,
  closeGeneratedOutputLocalizationRuntime,
  resumeGeneratedOutputLocalizationRuntime,
  startGeneratedOutputLocalizationRuntime,
} from './generated-output-localization-runtime'
import type { WorkspaceFence } from './repository'
import {
  subscribeWorkspaceEffects,
  WORKSPACE_EFFECT_RECOVERY_OWNED,
  type WorkspaceEffect,
} from './workspace-effect-hub'
import { getWorkspaceRepository } from './workspace-repository'
import { runWorkspaceRead } from './workspace-runtime'
import type { WorkspaceRuntimeCapabilityActivation } from './workspace-runtime-control'

interface GeneratedOutputLocalizationRuntime {
  readonly abortGeneratedOutputLocalizationRuntime: typeof abortGeneratedOutputLocalizationRuntime
  readonly assertGeneratedOutputLocalizationRuntimeClosed: typeof assertGeneratedOutputLocalizationRuntimeClosed
  readonly awaitGeneratedOutputLocalizationRuntimeIdle: typeof awaitGeneratedOutputLocalizationRuntimeIdle
  readonly closeGeneratedOutputLocalizationRuntime: typeof closeGeneratedOutputLocalizationRuntime
  readonly resumeGeneratedOutputLocalizationRuntime: typeof resumeGeneratedOutputLocalizationRuntime
  readonly startGeneratedOutputLocalizationRuntime: typeof startGeneratedOutputLocalizationRuntime
}

interface GeneratedOutputLocalizationCapabilityCycle {
  readonly fence: WorkspaceFence
  readonly controller: AbortController
  readonly detachActivationAbort: () => void
  requestedRevision: number
  completedRevision: number
  probe: Promise<void> | null
}

let attachedFence: WorkspaceFence | null = null
let unsubscribeEffects: (() => void) | null = null
let activeCycle: GeneratedOutputLocalizationCapabilityCycle | null = null
let runtime: GeneratedOutputLocalizationRuntime | null = null
let runtimeLoad: Promise<GeneratedOutputLocalizationRuntime> | null = null
let runtimeResumed = false

export function attachGeneratedOutputLocalizationCapability(fence: WorkspaceFence): void {
  if (attachedFence) throw new Error('GeneratedOutputLocalizationCapabilityAlreadyAttached')
  attachedFence = Object.freeze({ ...fence })
  unsubscribeEffects = subscribeWorkspaceEffects({
    owner: 'generated-output-localization-capability',
    impactKinds: ['attachment-job'],
    replacements: true,
    apply: receiveWorkspaceEffect,
    recover: (_error, effect) => {
      receiveWorkspaceEffect(effect)
      return WORKSPACE_EFFECT_RECOVERY_OWNED
    },
  })
}

export function activateGeneratedOutputLocalizationCapability(
  activation: WorkspaceRuntimeCapabilityActivation,
): Promise<void> {
  const fence = attachedFence
  if (
    !fence ||
    fence.workspaceId !== activation.workspaceId ||
    fence.replacementEpoch !== activation.replacementEpoch
  ) {
    throw new Error('GeneratedOutputLocalizationCapabilityFenceMismatch')
  }
  if (activeCycle) throw new Error('GeneratedOutputLocalizationCapabilityAlreadyActive')
  const controller = new AbortController()
  const abort = () => controller.abort(activation.signal.reason)
  if (activation.signal.aborted) abort()
  else activation.signal.addEventListener('abort', abort, { once: true })
  const cycle: GeneratedOutputLocalizationCapabilityCycle = {
    fence,
    controller,
    detachActivationAbort: () => activation.signal.removeEventListener('abort', abort),
    requestedRevision: 0,
    completedRevision: 0,
    probe: null,
  }
  activeCycle = cycle
  requestQueueProbe(cycle)
  return cycle.probe ?? Promise.resolve()
}

export function closeGeneratedOutputLocalizationCapability(): void {
  const cycle = activeCycle
  activeCycle = null
  cycle?.detachActivationAbort()
  cycle?.controller.abort(
    new DOMException('Generated output localization capability closed', 'AbortError'),
  )
  unsubscribeEffects?.()
  unsubscribeEffects = null
  attachedFence = null
  if (runtimeResumed) runtime?.closeGeneratedOutputLocalizationRuntime()
  runtimeResumed = false
}

export function abortGeneratedOutputLocalizationCapability(): void {
  closeGeneratedOutputLocalizationCapability()
  runtime?.abortGeneratedOutputLocalizationRuntime()
}

export async function awaitGeneratedOutputLocalizationCapabilityIdle(): Promise<void> {
  for (;;) {
    const probe = activeCycle?.probe ?? null
    const loading = runtimeLoad
    await Promise.allSettled([
      ...(probe ? [probe] : []),
      ...(loading ? [loading] : []),
      ...(runtime ? [runtime.awaitGeneratedOutputLocalizationRuntimeIdle()] : []),
    ])
    if (probe === (activeCycle?.probe ?? null) && loading === runtimeLoad) return
  }
}

export function assertGeneratedOutputLocalizationCapabilityClosed(): void {
  if (attachedFence || unsubscribeEffects || activeCycle || runtimeResumed) {
    throw new Error('GeneratedOutputLocalizationCapabilityNotClosed')
  }
  runtime?.assertGeneratedOutputLocalizationRuntimeClosed()
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
  requestQueueProbe(cycle)
}

function requestQueueProbe(cycle: GeneratedOutputLocalizationCapabilityCycle): void {
  if (activeCycle !== cycle || cycle.controller.signal.aborted || runtimeResumed) return
  cycle.requestedRevision += 1
  ensureQueueProbe(cycle)
}

function ensureQueueProbe(cycle: GeneratedOutputLocalizationCapabilityCycle): void {
  if (activeCycle !== cycle || cycle.controller.signal.aborted || runtimeResumed) return
  if (cycle.probe) return
  const probe = drainQueueProbes(cycle)
  cycle.probe = probe
  const settle = () => {
    if (cycle.probe === probe) cycle.probe = null
    if (
      activeCycle === cycle &&
      !cycle.controller.signal.aborted &&
      !runtimeResumed &&
      cycle.completedRevision < cycle.requestedRevision
    ) {
      ensureQueueProbe(cycle)
    }
  }
  void probe.then(settle, settle)
}

async function drainQueueProbes(cycle: GeneratedOutputLocalizationCapabilityCycle): Promise<void> {
  while (generatedOutputCycleNeedsProbe(cycle)) {
    const revision = cycle.requestedRevision
    let workPresent: boolean
    try {
      const envelope = await runWorkspaceRead(
        'repository-query',
        (permit) =>
          getWorkspaceRepository().query(
            permit,
            {
              kind: 'generated-output.localization-queue',
              now: Date.now(),
              limit: 1,
            },
            { signal: cycle.controller.signal },
          ),
        { signal: cycle.controller.signal },
      )
      workPresent =
        envelope.workspaceId === cycle.fence.workspaceId &&
        envelope.replacementEpoch === cycle.fence.replacementEpoch &&
        (envelope.value.readyJobIds.length > 0 || envelope.value.nextWakeAt !== undefined)
    } finally {
      cycle.completedRevision = revision
    }
    if (!workPresent || !generatedOutputCycleIsCurrent(cycle)) continue
    const loaded = await loadGeneratedOutputLocalizationRuntime()
    if (!generatedOutputCycleIsCurrent(cycle)) return
    loaded.resumeGeneratedOutputLocalizationRuntime()
    loaded.startGeneratedOutputLocalizationRuntime()
    runtimeResumed = true
    unsubscribeEffects?.()
    unsubscribeEffects = null
  }
}

function generatedOutputCycleIsCurrent(cycle: GeneratedOutputLocalizationCapabilityCycle): boolean {
  return activeCycle === cycle && !cycle.controller.signal.aborted
}

function generatedOutputCycleNeedsProbe(
  cycle: GeneratedOutputLocalizationCapabilityCycle,
): boolean {
  return (
    generatedOutputCycleIsCurrent(cycle) &&
    !runtimeResumed &&
    cycle.completedRevision < cycle.requestedRevision
  )
}

function loadGeneratedOutputLocalizationRuntime(): Promise<GeneratedOutputLocalizationRuntime> {
  if (runtime) return Promise.resolve(runtime)
  if (runtimeLoad) return runtimeLoad
  const loading = import('./generated-output-localization-runtime')
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
