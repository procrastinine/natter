import type { WorkspaceFence } from './repository'
import type {
  WorkspaceReconcileAuthority,
  WorkspaceReplacementRootKind,
  WorkspaceRootAdmissionCapability,
  WorkspaceRuntimeActionOptions,
  WorkspaceRuntimeKernel,
  WorkspaceRuntimeOpenedEvent,
  WorkspaceRuntimeState,
} from './workspace-runtime'
import { workspaceRuntimeInternal } from './workspace-runtime'

type WorkspaceRuntimeResourcePhase =
  | 'inbound'
  | 'producer'
  | 'stream-writer'
  | 'query'
  | 'repository'
  | 'transport'
  | 'lock'
  | 'transaction'
  | 'session'

export const WORKSPACE_RUNTIME_RESOURCE_IDS = Object.freeze([
  'broadcast-remote-inbound',
  'attempt-workspace',
  'conversation-workspace',
  'attachment-catalog-workspace',
  'configuration-workspace',
  'configuration-model-resolution',
  'stream-recovery',
  'generated-output-localization',
  'storage-maintenance',
  'stream-leases',
  'broadcast-fallback-verification',
  'mounted-projections',
  'browser-workspace-repository',
  'broadcast',
  'workspace-locks',
  'local-transactions',
  'browser-workspace-session',
] as const)

export const WORKSPACE_RUNTIME_RECONCILIATION_PARTICIPANT_IDS = Object.freeze([
  'tab-session',
] as const)

type WorkspaceRuntimeResourceId = (typeof WORKSPACE_RUNTIME_RESOURCE_IDS)[number]
type WorkspaceRuntimeReconciliationParticipantId =
  (typeof WORKSPACE_RUNTIME_RECONCILIATION_PARTICIPANT_IDS)[number]

type WorkspaceRuntimeResourceStatus =
  | 'closed'
  | 'attaching'
  | 'waiting'
  | 'resuming'
  | 'reconciling'
  | 'opening'
  | 'ready'
  | 'failed'

interface WorkspaceRuntimeResourceDefinitionBase {
  readonly id: WorkspaceRuntimeResourceId
  readonly phase: WorkspaceRuntimeResourcePhase
  closeAdmissions(): void
  abort(): void
  awaitIdle(): Promise<void>
  finishDispose?(): void | Promise<void>
  assertClosed(): void
}

export interface WorkspaceRuntimeCapabilityActivation extends WorkspaceRuntimeOpenedEvent {
  readonly signal: AbortSignal
}

export const WORKSPACE_USABLE_SURFACE_IDS = Object.freeze([
  'route-terminal',
  'active-configuration',
  'sidebar-first-page',
  'active-stop',
] as const)

export type WorkspaceUsableSurfaceId = (typeof WORKSPACE_USABLE_SURFACE_IDS)[number]
export type WorkspaceUsableSurfaceOutcome = 'ready' | 'empty' | 'missing' | 'error'

export interface WorkspaceUsableSurfaceOutcomeById {
  readonly 'route-terminal': WorkspaceUsableSurfaceOutcome
  readonly 'active-configuration': Exclude<WorkspaceUsableSurfaceOutcome, 'missing'>
  readonly 'sidebar-first-page': Exclude<WorkspaceUsableSurfaceOutcome, 'missing'>
  readonly 'active-stop': Extract<WorkspaceUsableSurfaceOutcome, 'ready' | 'error'>
}

export type WorkspaceUsableSurfaceProof<
  Surface extends WorkspaceUsableSurfaceId = WorkspaceUsableSurfaceId,
> = {
  readonly [Id in Surface]: WorkspaceFence & {
    readonly runtimeGeneration: number
    readonly surface: Id
    readonly outcome: WorkspaceUsableSurfaceOutcomeById[Id]
  }
}[Surface]

export interface WorkspaceUsableSurfaceSettlement<Surface extends WorkspaceUsableSurfaceId> {
  settle(outcome: WorkspaceUsableSurfaceOutcomeById[Surface]): boolean
}

export interface WorkspaceUsableSurfaceSettlementPort<Surface extends WorkspaceUsableSurfaceId> {
  readonly claim: (fence: WorkspaceFence) => WorkspaceUsableSurfaceSettlement<Surface> | null
}

export interface WorkspaceUsableSurfaceSnapshot extends WorkspaceFence {
  readonly runtimeGeneration: number
  readonly outcomes: Readonly<{
    readonly [Surface in WorkspaceUsableSurfaceId]?: WorkspaceUsableSurfaceOutcomeById[Surface]
  }>
  readonly committed: boolean
}

interface WorkspaceUsableSurfaceCycle extends WorkspaceFence {
  readonly cycle: number
  readonly runtimeGeneration: number
  readonly outcomes: Map<WorkspaceUsableSurfaceId, WorkspaceUsableSurfaceOutcome>
  event: WorkspaceRuntimeOpenedEvent | null
}

type WorkspaceRuntimeCoreResourceId =
  | 'browser-workspace-repository'
  | 'workspace-locks'
  | 'local-transactions'
  | 'browser-workspace-session'

type WorkspaceRuntimeBackgroundResourceId =
  | 'attempt-workspace'
  | 'configuration-model-resolution'
  | 'stream-recovery'
  | 'generated-output-localization'
  | 'storage-maintenance'

type WorkspaceRuntimeResourceDefinition<Id extends WorkspaceRuntimeResourceId> =
  WorkspaceRuntimeResourceDefinitionBase &
    (Id extends WorkspaceRuntimeCoreResourceId
      ? {
          readonly id: Id
          readonly resume: () => void | Promise<void>
          attach?: never
          activate?: never
        }
      : Id extends WorkspaceRuntimeBackgroundResourceId
        ? {
            readonly id: Id
            readonly attach: (fence: WorkspaceFence) => void
            readonly activate: (
              activation: WorkspaceRuntimeCapabilityActivation,
            ) => void | Promise<void>
            readonly prerequisites: readonly WorkspaceUsableSurfaceId[]
            resume?: never
          }
        : {
            readonly id: Id
            readonly attach: (fence: WorkspaceFence) => void
            activate?: never
            resume?: never
          })

interface WorkspaceRuntimeResource extends WorkspaceRuntimeResourceDefinitionBase {
  readonly resume?: () => void | Promise<void>
  readonly attach?: (fence: WorkspaceFence) => void
  readonly activate?: (activation: WorkspaceRuntimeCapabilityActivation) => void | Promise<void>
  prerequisites?: readonly WorkspaceUsableSurfaceId[]
  status: WorkspaceRuntimeResourceStatus
  failure: unknown
  task: Promise<void> | null
  activationController: AbortController | null
  activationCycle: number | null
}

export type WorkspaceRuntimeResourceManifest = {
  readonly [Id in WorkspaceRuntimeResourceId]: WorkspaceRuntimeResourceDefinition<Id>
}

interface WorkspaceRuntimeReconciliationParticipantDefinition {
  readonly id: WorkspaceRuntimeReconciliationParticipantId
  reconcile(authority: WorkspaceReconcileAuthority): void
}

export type WorkspaceRuntimeReconciliationManifest = {
  readonly [Id in WorkspaceRuntimeReconciliationParticipantId]: WorkspaceRuntimeReconciliationParticipantDefinition & {
    readonly id: Id
  }
}

export type WorkspaceRuntimeResourceSubset<Id extends WorkspaceRuntimeResourceId> = Pick<
  WorkspaceRuntimeResourceManifest,
  Id
>

export interface WorkspaceRuntimeControlSnapshot {
  readonly state: WorkspaceRuntimeState
  readonly runtimeGeneration: number
  readonly workspaceId: string | null
  readonly replacementEpoch: number
  readonly resourcesQuiesced: boolean
}

export interface WorkspaceRuntimeResourceStatusSnapshot {
  readonly id: WorkspaceRuntimeResourceId
  readonly status: WorkspaceRuntimeResourceStatus
  readonly failed: boolean
  readonly failure: string | null
}

const CLOSE_PHASES: readonly WorkspaceRuntimeResourcePhase[] = Object.freeze([
  'inbound',
  'producer',
  'stream-writer',
  'query',
  'repository',
  'transport',
  'lock',
  'transaction',
  'session',
])
const OPEN_PHASES: readonly WorkspaceRuntimeResourcePhase[] = Object.freeze([
  'session',
  'transaction',
  'lock',
  'transport',
  'repository',
  'query',
  'stream-writer',
  'producer',
  'inbound',
])
export function createWorkspaceRuntimeControlKernel(runtime: WorkspaceRuntimeKernel['internal']) {
  let resources: readonly WorkspaceRuntimeResource[] = []
  let resourcesByPhase = emptyResourcePhases()
  let resourceManifestInstalled = false
  let reconciliationParticipants: readonly WorkspaceRuntimeReconciliationParticipantDefinition[] =
    []
  let resourcesQuiesced = true
  let quiescePromise: Promise<void> | null = null
  let quiesceMode: 'graceful' | 'abortive' | null = null
  let capabilityCycle = 0
  let capabilityStartupTask: Promise<void> = Promise.resolve()
  let usableSurfaceCycle: WorkspaceUsableSurfaceCycle | null = null
  const quiesceFailures: unknown[] = []

  function installWorkspaceRuntimeResourcesImpl(
    manifest: WorkspaceRuntimeResourceManifest,
    reconciliationManifest: WorkspaceRuntimeReconciliationManifest,
  ): void {
    const state = runtime.snapshot().state
    if (resourceManifestInstalled) {
      throw new Error('WorkspaceRuntimeResourceManifestAlreadyInstalled')
    }
    if (state !== 'STARTING') {
      throw new Error(`WorkspaceRuntimeResourceManifestInitialInstallInvalid:${state}`)
    }

    const nextResources: WorkspaceRuntimeResource[] = []
    const nextByPhase = emptyResourcePhases()
    for (const id of WORKSPACE_RUNTIME_RESOURCE_IDS) {
      const resource = manifest[id]
      if (resource.id !== id) throw new Error(`WorkspaceRuntimeResourceIdMismatch:${id}`)
      const background = isBackgroundResourceId(id)
      const prerequisites = 'prerequisites' in resource ? resource.prerequisites : undefined
      if (isCoreReadinessPhase(resource.phase) && resource.attach) {
        throw new Error(`WorkspaceRuntimeCoreResourceUsesAttachHook:${id}`)
      }
      if (isCoreReadinessPhase(resource.phase) && resource.activate) {
        throw new Error(`WorkspaceRuntimeCoreResourceUsesCapabilityActivation:${id}`)
      }
      if (!isCoreReadinessPhase(resource.phase) && !resource.attach) {
        throw new Error(`WorkspaceRuntimeCapabilityAttachMissing:${id}`)
      }
      if (background && !resource.activate) {
        throw new Error(`WorkspaceRuntimeBackgroundActivationMissing:${id}`)
      }
      if (background && !prerequisites) {
        throw new Error(`WorkspaceRuntimeBackgroundPrerequisitesMissing:${id}`)
      }
      if (!background && !isCoreReadinessPhase(resource.phase) && resource.activate) {
        throw new Error(`WorkspaceRuntimeForegroundUsesBackgroundActivation:${id}`)
      }
      if (!background && prerequisites) {
        throw new Error(`WorkspaceRuntimeForegroundPrerequisitesInvalid:${id}`)
      }
      if (isCoreReadinessPhase(resource.phase) && !resource.resume) {
        throw new Error(`WorkspaceRuntimeCoreResumeMissing:${id}`)
      }
      resource.assertClosed()
      const installed: WorkspaceRuntimeResource = {
        ...resource,
        status: 'closed',
        failure: null,
        task: null,
        activationController: null,
        activationCycle: null,
      }
      nextResources.push(installed)
      nextByPhase[installed.phase].push(installed)
    }
    const nextReconciliationParticipants = Object.freeze(
      WORKSPACE_RUNTIME_RECONCILIATION_PARTICIPANT_IDS.map((id) => {
        const participant = reconciliationManifest[id]
        const participantId: unknown = participant.id
        if (participantId !== id) {
          throw new Error(`WorkspaceRuntimeReconciliationParticipantIdMismatch:${id}`)
        }
        return participant
      }),
    )
    resources = Object.freeze(nextResources)
    resourcesByPhase = nextByPhase
    reconciliationParticipants = nextReconciliationParticipants
    resourceManifestInstalled = true
  }

  function getWorkspaceRuntimeControlSnapshotImpl(): WorkspaceRuntimeControlSnapshot {
    return { ...runtime.snapshot(), resourcesQuiesced }
  }

  function getWorkspaceUsableSurfaceSnapshotImpl(): WorkspaceUsableSurfaceSnapshot | null {
    const current = usableSurfaceCycle
    if (!current) return null
    const outcomes: Partial<Record<WorkspaceUsableSurfaceId, WorkspaceUsableSurfaceOutcome>> = {}
    for (const [surface, outcome] of current.outcomes) outcomes[surface] = outcome
    return Object.freeze({
      runtimeGeneration: current.runtimeGeneration,
      workspaceId: current.workspaceId,
      replacementEpoch: current.replacementEpoch,
      outcomes: Object.freeze(outcomes) as WorkspaceUsableSurfaceSnapshot['outcomes'],
      committed: current.outcomes.size === WORKSPACE_USABLE_SURFACE_IDS.length,
    })
  }

  function settleWorkspaceUsableSurfaceImpl<Surface extends WorkspaceUsableSurfaceId>(
    proof: WorkspaceUsableSurfaceProof<Surface>,
  ): boolean {
    const current = usableSurfaceCycle
    const snapshot = runtime.snapshot()
    if (
      !current ||
      snapshot.state !== 'RUNNING' ||
      snapshot.runtimeGeneration !== current.runtimeGeneration ||
      snapshot.workspaceId !== proof.workspaceId ||
      snapshot.replacementEpoch !== proof.replacementEpoch ||
      proof.runtimeGeneration !== current.runtimeGeneration ||
      proof.workspaceId !== current.workspaceId ||
      proof.replacementEpoch !== current.replacementEpoch ||
      current.outcomes.has(proof.surface)
    ) {
      return false
    }
    current.outcomes.set(proof.surface, proof.outcome)
    startEligibleCapabilityResources(current)
    return true
  }

  function claimWorkspaceUsableSurfaceSettlementImpl<Surface extends WorkspaceUsableSurfaceId>(
    claim: WorkspaceFence & { readonly surface: Surface },
  ): WorkspaceUsableSurfaceSettlement<Surface> | null {
    const current = usableSurfaceCycle
    const snapshot = runtime.snapshot()
    if (
      !current ||
      snapshot.state !== 'RUNNING' ||
      snapshot.runtimeGeneration !== current.runtimeGeneration ||
      snapshot.workspaceId !== claim.workspaceId ||
      snapshot.replacementEpoch !== claim.replacementEpoch ||
      current.workspaceId !== claim.workspaceId ||
      current.replacementEpoch !== claim.replacementEpoch ||
      current.outcomes.has(claim.surface)
    ) {
      return null
    }
    const runtimeGeneration = current.runtimeGeneration
    return Object.freeze({
      settle: (outcome: WorkspaceUsableSurfaceOutcomeById[Surface]) =>
        settleWorkspaceUsableSurfaceImpl({
          runtimeGeneration,
          workspaceId: claim.workspaceId,
          replacementEpoch: claim.replacementEpoch,
          surface: claim.surface,
          outcome,
        }),
    })
  }

  function getWorkspaceRuntimeResourceStatusesImpl(): readonly WorkspaceRuntimeResourceStatusSnapshot[] {
    return resources.map((resource) => ({
      id: resource.id,
      status: resource.status,
      failed: resource.failure !== null,
      failure: workspaceResourceFailureMessage(resource.failure),
    }))
  }

  function workspaceResourceFailureMessage(failure: unknown): string | null {
    if (failure === null) return null
    if (failure instanceof Error) return `${failure.name}:${failure.message}`
    return 'WorkspaceRuntimeResourceFailure'
  }

  function beginWorkspaceRuntimeQuiesceImpl(): void {
    beginWorkspaceRuntimeQuiesceWithMode('abortive')
  }

  function beginWorkspaceRuntimeQuiesceWithMode(mode: 'graceful' | 'abortive'): void {
    assertResourceManifestInstalled()
    const snapshot = runtime.snapshot()
    if (
      snapshot.state === 'SEALED' ||
      snapshot.state === 'QUIESCED' ||
      snapshot.state === 'FAILED_CLOSED'
    ) {
      return
    }
    if (snapshot.state === 'QUIESCING') return
    prepareWorkspaceRuntimeQuiesce(mode)
    if (mode === 'graceful') runtime.beginGracefulQuiesce()
    else runtime.beginQuiesce()
  }

  function prepareWorkspaceRuntimeQuiesce(mode: 'graceful' | 'abortive'): void {
    capabilityCycle += 1
    try {
      abortCapabilityActivations()
    } catch (error) {
      quiesceFailures.push(error)
    }
    quiesceMode = mode
    for (const phase of ['inbound', 'producer'] as const) {
      for (const resource of resourcesInPhase(phase)) {
        if (mode === 'graceful') closeResourceAdmissions(resource, quiesceFailures)
        else closeAndAbort(resource, quiesceFailures)
      }
    }
  }

  function tryBeginWorkspaceRuntimeQuiesceIfIdleImpl(): boolean {
    assertResourceManifestInstalled()
    return runtime.tryBeginQuiesceIfIdle(() => prepareWorkspaceRuntimeQuiesce('abortive'))
  }

  function awaitWorkspaceRuntimeQuiescedImpl(): Promise<void> {
    if (quiescePromise) return quiescePromise
    const snapshot = runtime.snapshot()
    if (snapshot.state === 'QUIESCED' || snapshot.state === 'FAILED_CLOSED') {
      return Promise.resolve()
    }
    if (snapshot.state !== 'QUIESCING') beginWorkspaceRuntimeQuiesceImpl()
    if (!quiesceMode) throw new Error('WorkspaceRuntimeQuiesceModeMissing')
    const quiescing = performWorkspaceRuntimeQuiesce(quiesceMode)
    quiescePromise = quiescing
    void quiescing.then(
      () => {
        if (quiescePromise === quiescing) quiescePromise = null
      },
      () => {
        if (quiescePromise === quiescing) quiescePromise = null
      },
    )
    return quiescing
  }

  function launchWorkspaceRuntimeReplacementNowImpl(
    kind: WorkspaceReplacementRootKind,
    options: WorkspaceRuntimeActionOptions & { readonly requireIdle: boolean },
  ): WorkspaceReconcileAuthority | null {
    assertResourceManifestInstalled()
    return runtime.launchReplacementNow(kind, options, prepareReplacementQuiesce)
  }

  function launchWorkspaceRuntimeReplacementWhenUnblockedImpl(
    kind: WorkspaceReplacementRootKind,
    options: WorkspaceRuntimeActionOptions & { readonly requireIdle: boolean },
  ): Promise<WorkspaceReconcileAuthority | null> {
    assertResourceManifestInstalled()
    return runtime.launchReplacementWhenUnblocked(kind, options, prepareReplacementQuiesce)
  }

  function prepareReplacementQuiesce(): void {
    capabilityCycle += 1
    quiesceMode = 'graceful'
    try {
      abortCapabilityActivations()
    } catch (error) {
      quiesceFailures.push(error)
    }
    for (const phase of ['inbound', 'producer'] as const) {
      for (const resource of resourcesInPhase(phase)) {
        closeResourceAdmissions(resource, quiesceFailures)
      }
    }
  }

  function beginWorkspaceRuntimeReconciliationImpl(
    snapshot: {
      workspaceId: string
      replacementEpoch: number
    },
    options: { readonly signal?: AbortSignal } = {},
  ): WorkspaceReconcileAuthority {
    assertResourceManifestInstalled()
    return runtime.beginReconciliation(snapshot, options.signal)
  }

  async function resumeWorkspaceRuntimeResourcesImpl(
    authority: WorkspaceReconcileAuthority,
  ): Promise<void> {
    const failures: unknown[] = []
    if (resourcesQuiesced) {
      for (const phase of OPEN_PHASES) {
        if (!isCoreReadinessPhase(phase)) continue
        const batch = resourcesInPhase(phase)
        collectRejected(
          failures,
          await Promise.allSettled(batch.map((resource) => resumeCoreResource(resource))),
        )
        if (failures.length > 0) break
      }
    }
    if (failures.length > 0) {
      await rollbackResumedResources(failures)
      runtime.abortReconciliation()
      throw new AggregateError(failures, 'WorkspaceRuntimeCoreReadinessFailed')
    }
    resourcesQuiesced = false
    for (const participant of reconciliationParticipants) {
      try {
        const result = participant.reconcile(authority) as unknown
        if (isPromiseLike(result)) {
          throw new Error(
            `WorkspaceRuntimeReconciliationParticipantMustBeSynchronous:${participant.id}`,
          )
        }
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length > 0) {
      await rollbackResumedResources(failures)
      runtime.abortReconciliation()
      throw new AggregateError(failures, 'WorkspaceRuntimeCoreReconciliationFailed')
    }
  }

  function noteWorkspaceRuntimeGatedChangeImpl(change: {
    workspaceId: string
    replacementEpoch: number
    broad?: boolean
  }): boolean {
    return runtime.noteGatedChange(change)
  }

  async function finishWorkspaceRuntimeReconciliationImpl(snapshot?: {
    workspaceId: string
    replacementEpoch: number
  }): Promise<WorkspaceRuntimeOpenedEvent> {
    const current = runtime.snapshot()
    const fence = snapshot ?? {
      workspaceId: requiredWorkspaceId(current.workspaceId),
      replacementEpoch: current.replacementEpoch,
    }
    const failures = attachCapabilityAdmissions(fence)
    if (failures.length > 0) {
      await rollbackResumedResources(failures)
      runtime.abortReconciliation()
      throw new AggregateError(failures, 'WorkspaceRuntimeCapabilityAttachFailed')
    }
    quiescePromise = null
    quiesceMode = null
    quiesceFailures.length = 0
    try {
      const activation = beginCapabilityResources({
        ...fence,
        runtimeGeneration: current.runtimeGeneration,
      })
      const event = runtime.finishReconciliation(snapshot)
      activation.event = event
      startEligibleCapabilityResources(activation)
      return event
    } catch (error) {
      const failures = [error]
      await rollbackResumedResources(failures)
      runtime.abortReconciliation()
      throw new AggregateError(failures, 'WorkspaceRuntimeOpenCommitFailed', { cause: error })
    }
  }

  async function abortWorkspaceRuntimeReconciliationImpl(): Promise<readonly unknown[]> {
    if (runtime.snapshot().state !== 'RECONCILING') return []
    const failures: unknown[] = []
    await rollbackResumedResources(failures)
    runtime.abortReconciliation()
    return failures
  }

  function sealWorkspaceRuntimeImpl(): void {
    runtime.seal()
  }

  async function performWorkspaceRuntimeQuiesce(mode: 'graceful' | 'abortive'): Promise<void> {
    const failures = quiesceFailures.splice(0)
    await settleResourcePhase('inbound', failures)
    collectRejected(failures, await Promise.allSettled([runtime.awaitDrain()]))
    await settleResourcePhase('producer', failures)
    collectRejected(failures, await Promise.allSettled([awaitCapabilityStartupIdle()]))
    if (mode === 'graceful') {
      for (const phase of ['inbound', 'producer'] as const) {
        for (const resource of resourcesInPhase(phase)) abortResource(resource, failures)
      }
    }
    for (const phase of CLOSE_PHASES) {
      if (phase === 'inbound' || phase === 'producer') continue
      const batch = resourcesInPhase(phase)
      for (const resource of batch) closeAndAbort(resource, failures)
      await settleResources(batch, failures)
    }
    const closedInvariantFailures = collectClosedInvariantFailures()
    failures.push(...closedInvariantFailures)
    if (closedInvariantFailures.length > 0) {
      resourcesQuiesced = false
      runtime.sealAfterClosedInvariantFailure()
      throw new AggregateError(failures, 'WorkspaceRuntimeResourceClosureUnproven')
    }
    resourcesQuiesced = true
    markResourcesClosed()
    if (failures.length > 0) {
      runtime.markFailedClosed()
      throw new AggregateError(failures, 'WorkspaceRuntimeResourceQuiesceFailed')
    }
    runtime.markQuiesced()
  }

  async function settleResourcePhase(
    phase: WorkspaceRuntimeResourcePhase,
    failures: unknown[],
  ): Promise<void> {
    await settleResources(resourcesInPhase(phase), failures)
  }

  async function settleResources(
    batch: readonly WorkspaceRuntimeResource[],
    failures: unknown[],
  ): Promise<void> {
    collectRejected(
      failures,
      await Promise.allSettled(
        batch.map((resource) =>
          Promise.all([
            Promise.resolve().then(() => resource.awaitIdle()),
            resource.task ?? Promise.resolve(),
          ]),
        ),
      ),
    )
    collectRejected(
      failures,
      await Promise.allSettled(
        batch.map((resource) => Promise.resolve().then(() => resource.finishDispose?.())),
      ),
    )
  }

  function closeAndAbort(resource: WorkspaceRuntimeResource, failures?: unknown[]): void {
    closeResourceAdmissions(resource, failures)
    abortResource(resource, failures)
  }

  function closeResourceAdmissions(resource: WorkspaceRuntimeResource, failures?: unknown[]): void {
    try {
      resource.closeAdmissions()
    } catch (error) {
      failures?.push(error)
    }
  }

  function abortResource(resource: WorkspaceRuntimeResource, failures?: unknown[]): void {
    try {
      resource.abort()
    } catch (error) {
      failures?.push(error)
    }
  }

  async function rollbackResumedResources(failures: unknown[]): Promise<void> {
    capabilityCycle += 1
    for (const phase of CLOSE_PHASES) {
      const batch = resourcesInPhase(phase)
      for (const resource of batch) closeAndAbort(resource, failures)
      await settleResources(batch, failures)
    }
    const closedInvariantFailures = collectClosedInvariantFailures()
    failures.push(...closedInvariantFailures)
    if (closedInvariantFailures.length > 0) {
      resourcesQuiesced = false
      runtime.sealAfterClosedInvariantFailure()
      return
    }
    resourcesQuiesced = true
    markResourcesClosed()
  }

  async function resumeCoreResource(resource: WorkspaceRuntimeResource): Promise<void> {
    resource.status = 'resuming'
    resource.failure = null
    const resume = resource.resume
    if (!resume) throw new Error(`WorkspaceRuntimeCoreResumeMissing:${resource.id}`)
    const task = Promise.resolve().then(() => resume())
    resource.task = task
    try {
      await task
      resource.status = 'ready'
    } catch (error) {
      resource.status = 'failed'
      resource.failure = error
      throw error
    }
  }

  function beginCapabilityResources(
    fence: WorkspaceFence & { runtimeGeneration: number },
  ): WorkspaceUsableSurfaceCycle {
    const cycle = ++capabilityCycle
    const activation: WorkspaceUsableSurfaceCycle = {
      cycle,
      runtimeGeneration: fence.runtimeGeneration,
      workspaceId: fence.workspaceId,
      replacementEpoch: fence.replacementEpoch,
      outcomes: new Map<WorkspaceUsableSurfaceId, WorkspaceUsableSurfaceOutcome>(),
      event: null,
    }
    usableSurfaceCycle = activation
    return activation
  }

  function startEligibleCapabilityResources(
    activation: NonNullable<typeof usableSurfaceCycle>,
  ): void {
    const event = activation.event
    if (!event || usableSurfaceCycle !== activation || activation.cycle !== capabilityCycle) return
    for (const resource of resources) {
      if (!resource.activate || resource.activationCycle !== null) continue
      const prerequisites = resource.prerequisites ?? []
      if (prerequisites.some((surface) => !activation.outcomes.has(surface))) continue
      void startCapabilityResource(resource, event, activation.cycle)
    }
    capabilityStartupTask = Promise.all(
      resources.map((resource) => resource.task ?? Promise.resolve()),
    ).then(() => undefined)
  }

  function startCapabilityResource(
    resource: WorkspaceRuntimeResource,
    event: WorkspaceRuntimeOpenedEvent,
    cycle: number,
  ): Promise<void> {
    const activate = resource.activate
    if (!activate) throw new Error(`WorkspaceRuntimeCapabilityActivationMissing:${resource.id}`)
    const controller = new AbortController()
    resource.activationController = controller
    resource.activationCycle = cycle
    resource.status = 'opening'
    resource.failure = null
    let result: void | Promise<void>
    try {
      result = activate(Object.freeze({ ...event, signal: controller.signal }))
    } catch (error) {
      result = Promise.reject(workspaceRuntimeControlError(error))
    }
    const activation = Promise.resolve(result).then(
      () => {
        if (capabilityActivationIsCurrent(resource, cycle, controller)) resource.status = 'ready'
      },
      (error: unknown) => {
        if (!capabilityActivationIsCurrent(resource, cycle, controller)) return
        resource.status = 'failed'
        resource.failure = error
      },
    )
    resource.task = activation
    return activation
  }

  function workspaceRuntimeControlError(reason: unknown): Error {
    return reason instanceof Error
      ? reason
      : new Error('WorkspaceRuntimeCapabilityFailed', { cause: reason })
  }

  async function awaitCapabilityStartupIdle(): Promise<void> {
    await capabilityStartupTask
    await Promise.all(resources.map((resource) => resource.task ?? Promise.resolve()))
  }

  function capabilityActivationIsCurrent(
    resource: WorkspaceRuntimeResource,
    cycle: number,
    controller: AbortController,
  ): boolean {
    return (
      resource.activationCycle === cycle &&
      resource.activationController === controller &&
      !controller.signal.aborted &&
      cycle === capabilityCycle &&
      runtime.snapshot().state === 'RUNNING'
    )
  }

  function abortCapabilityActivations(): void {
    usableSurfaceCycle = null
    const reason = new DOMException('Workspace capability activation closed', 'AbortError')
    for (const resource of resources) {
      const controller = resource.activationController
      resource.activationController = null
      resource.activationCycle = null
      if (controller && !controller.signal.aborted) controller.abort(reason)
    }
  }

  function isCoreReadinessPhase(phase: WorkspaceRuntimeResourcePhase): boolean {
    return (
      phase === 'session' || phase === 'transaction' || phase === 'lock' || phase === 'repository'
    )
  }

  function attachCapabilityAdmissions(fence: WorkspaceFence): unknown[] {
    const failures: unknown[] = []
    for (const phase of OPEN_PHASES) {
      if (isCoreReadinessPhase(phase)) continue
      for (const resource of resourcesInPhase(phase)) {
        resource.status = 'attaching'
        resource.failure = null
        try {
          const result = resource.attach?.(fence) as unknown
          if (isPromiseLike(result)) {
            throw new Error(`WorkspaceRuntimeCapabilityAttachMustBeSynchronous:${resource.id}`)
          }
          resource.status = resource.activate ? 'waiting' : 'ready'
        } catch (error) {
          resource.status = 'failed'
          resource.failure = error
          failures.push(error)
        }
      }
    }
    return failures
  }

  function isBackgroundResourceId(
    id: WorkspaceRuntimeResourceId,
  ): id is WorkspaceRuntimeBackgroundResourceId {
    return (
      id === 'attempt-workspace' ||
      id === 'configuration-model-resolution' ||
      id === 'stream-recovery' ||
      id === 'generated-output-localization' ||
      id === 'storage-maintenance'
    )
  }

  function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
    return (
      (typeof value === 'object' || typeof value === 'function') &&
      value !== null &&
      'then' in value &&
      typeof (value as { then?: unknown }).then === 'function'
    )
  }

  function requiredWorkspaceId(value: string | null): string {
    if (value === null) throw new Error('WorkspaceRuntimeIdentityMissing')
    return value
  }

  function markResourcesClosed(): void {
    for (const resource of resources) {
      resource.status = 'closed'
      resource.failure = null
      resource.task = null
      resource.activationController = null
      resource.activationCycle = null
    }
  }

  function collectClosedInvariantFailures(): unknown[] {
    const failures: unknown[] = []
    for (const resource of resources) {
      try {
        resource.assertClosed()
      } catch (error) {
        resource.status = 'failed'
        resource.failure = error
        failures.push(error)
      }
    }
    return failures
  }

  function resourcesInPhase(
    phase: WorkspaceRuntimeResourcePhase,
  ): readonly WorkspaceRuntimeResource[] {
    return resourcesByPhase[phase]
  }

  function emptyResourcePhases(): Record<
    WorkspaceRuntimeResourcePhase,
    WorkspaceRuntimeResource[]
  > {
    return {
      inbound: [],
      producer: [],
      'stream-writer': [],
      query: [],
      repository: [],
      transport: [],
      lock: [],
      transaction: [],
      session: [],
    }
  }

  function assertResourceManifestInstalled(): void {
    if (!resourceManifestInstalled || resources.length !== WORKSPACE_RUNTIME_RESOURCE_IDS.length) {
      throw new Error('WorkspaceRuntimeResourceManifestMissing')
    }
  }

  function collectRejected(
    failures: unknown[],
    results: readonly PromiseSettledResult<unknown>[],
  ): void {
    for (const result of results) {
      if (result.status === 'rejected') failures.push(result.reason)
    }
  }

  return Object.freeze({
    installWorkspaceRuntimeResources: installWorkspaceRuntimeResourcesImpl,
    getWorkspaceRuntimeControlSnapshot: getWorkspaceRuntimeControlSnapshotImpl,
    getWorkspaceUsableSurfaceSnapshot: getWorkspaceUsableSurfaceSnapshotImpl,
    claimWorkspaceUsableSurfaceSettlement: claimWorkspaceUsableSurfaceSettlementImpl,
    settleWorkspaceUsableSurface: settleWorkspaceUsableSurfaceImpl,
    getWorkspaceRuntimeResourceStatuses: getWorkspaceRuntimeResourceStatusesImpl,
    beginWorkspaceRuntimeQuiesce: beginWorkspaceRuntimeQuiesceImpl,
    tryBeginWorkspaceRuntimeQuiesceIfIdle: tryBeginWorkspaceRuntimeQuiesceIfIdleImpl,
    awaitWorkspaceRuntimeQuiesced: awaitWorkspaceRuntimeQuiescedImpl,
    launchWorkspaceRuntimeReplacementNow: launchWorkspaceRuntimeReplacementNowImpl,
    launchWorkspaceRuntimeReplacementWhenUnblocked:
      launchWorkspaceRuntimeReplacementWhenUnblockedImpl,
    beginWorkspaceRuntimeReconciliation: beginWorkspaceRuntimeReconciliationImpl,
    resumeWorkspaceRuntimeResources: resumeWorkspaceRuntimeResourcesImpl,
    noteWorkspaceRuntimeGatedChange: noteWorkspaceRuntimeGatedChangeImpl,
    finishWorkspaceRuntimeReconciliation: finishWorkspaceRuntimeReconciliationImpl,
    abortWorkspaceRuntimeReconciliation: abortWorkspaceRuntimeReconciliationImpl,
    sealWorkspaceRuntime: sealWorkspaceRuntimeImpl,
  })
}

export type WorkspaceRuntimeControlKernel = ReturnType<typeof createWorkspaceRuntimeControlKernel>

const productionWorkspaceRuntimeControl: WorkspaceRuntimeControlKernel =
  createWorkspaceRuntimeControlKernel(workspaceRuntimeInternal)

type WorkspaceReplacementAdmissionRequiresIdle<Kind extends WorkspaceReplacementRootKind> =
  Kind extends 'maintenance' ? true : false

export type WorkspaceReplacementAuthorityOptions<Kind extends WorkspaceReplacementRootKind> =
  Kind extends 'maintenance'
    ? Pick<WorkspaceRuntimeActionOptions, 'lineageId'>
    : WorkspaceRuntimeActionOptions

function createWorkspaceReplacementAdmission<const Kind extends WorkspaceReplacementRootKind>(
  kind: Kind,
  requireIdle: WorkspaceReplacementAdmissionRequiresIdle<Kind>,
  admission: WorkspaceRuntimeControlKernel['launchWorkspaceRuntimeReplacementNow'],
): WorkspaceRootAdmissionCapability<
  (options?: WorkspaceReplacementAuthorityOptions<Kind>) => WorkspaceReconcileAuthority | null,
  { readonly fixedKind: Kind }
> {
  const fixedAdmission = (options?: WorkspaceReplacementAuthorityOptions<Kind>) =>
    admission(kind, { ...options, requireIdle })
  return fixedAdmission as WorkspaceRootAdmissionCapability<
    typeof fixedAdmission,
    { readonly fixedKind: Kind }
  >
}

export function installWorkspaceRuntimeResources(
  manifest: WorkspaceRuntimeResourceManifest,
  reconciliationManifest: WorkspaceRuntimeReconciliationManifest,
): void {
  productionWorkspaceRuntimeControl.installWorkspaceRuntimeResources(
    manifest,
    reconciliationManifest,
  )
}

export function getWorkspaceRuntimeControlSnapshot(): WorkspaceRuntimeControlSnapshot {
  return productionWorkspaceRuntimeControl.getWorkspaceRuntimeControlSnapshot()
}

export function workspaceUsableSurfaceSettlementPort<Surface extends WorkspaceUsableSurfaceId>(
  surface: Surface,
): WorkspaceUsableSurfaceSettlementPort<Surface> {
  return Object.freeze({
    claim: (fence: WorkspaceFence) =>
      productionWorkspaceRuntimeControl.claimWorkspaceUsableSurfaceSettlement({
        ...fence,
        surface,
      }),
  })
}

export function settleWorkspaceUsableSurface(proof: WorkspaceUsableSurfaceProof): boolean {
  return productionWorkspaceRuntimeControl.settleWorkspaceUsableSurface(proof)
}

export function getWorkspaceRuntimeResourceStatuses(): readonly WorkspaceRuntimeResourceStatusSnapshot[] {
  return productionWorkspaceRuntimeControl.getWorkspaceRuntimeResourceStatuses()
}

export function beginWorkspaceRuntimeQuiesce(): void {
  productionWorkspaceRuntimeControl.beginWorkspaceRuntimeQuiesce()
}

export function tryBeginWorkspaceRuntimeQuiesceIfIdle(): boolean {
  return productionWorkspaceRuntimeControl.tryBeginWorkspaceRuntimeQuiesceIfIdle()
}

export function awaitWorkspaceRuntimeQuiesced(): Promise<void> {
  return productionWorkspaceRuntimeControl.awaitWorkspaceRuntimeQuiesced()
}

export const launchImportExportWorkspaceRuntimeReplacementNow = createWorkspaceReplacementAdmission(
  'import-export',
  false,
  productionWorkspaceRuntimeControl.launchWorkspaceRuntimeReplacementNow,
)

export const launchCommandFanoutWorkspaceRuntimeReplacementNow =
  createWorkspaceReplacementAdmission(
    'command-fanout',
    false,
    productionWorkspaceRuntimeControl.launchWorkspaceRuntimeReplacementNow,
  )

export function launchCommandFanoutWorkspaceRuntimeReplacementWhenUnblocked(
  options: WorkspaceRuntimeActionOptions = {},
): Promise<WorkspaceReconcileAuthority | null> {
  return productionWorkspaceRuntimeControl.launchWorkspaceRuntimeReplacementWhenUnblocked(
    'command-fanout',
    { ...options, requireIdle: false },
  )
}

export const tryLaunchMaintenanceWorkspaceRuntimeReplacementIfIdle =
  createWorkspaceReplacementAdmission(
    'maintenance',
    true,
    productionWorkspaceRuntimeControl.launchWorkspaceRuntimeReplacementNow,
  )

export function beginWorkspaceRuntimeReconciliation(
  snapshot: {
    workspaceId: string
    replacementEpoch: number
  },
  options: { readonly signal?: AbortSignal } = {},
): WorkspaceReconcileAuthority {
  return productionWorkspaceRuntimeControl.beginWorkspaceRuntimeReconciliation(snapshot, options)
}

export function resumeWorkspaceRuntimeResources(
  authority: WorkspaceReconcileAuthority,
): Promise<void> {
  return productionWorkspaceRuntimeControl.resumeWorkspaceRuntimeResources(authority)
}

export function noteWorkspaceRuntimeGatedChange(change: {
  workspaceId: string
  replacementEpoch: number
  broad?: boolean
}): boolean {
  return productionWorkspaceRuntimeControl.noteWorkspaceRuntimeGatedChange(change)
}

export function finishWorkspaceRuntimeReconciliation(snapshot?: {
  workspaceId: string
  replacementEpoch: number
}): Promise<WorkspaceRuntimeOpenedEvent> {
  return productionWorkspaceRuntimeControl.finishWorkspaceRuntimeReconciliation(snapshot)
}

export function abortWorkspaceRuntimeReconciliation(): Promise<readonly unknown[]> {
  return productionWorkspaceRuntimeControl.abortWorkspaceRuntimeReconciliation()
}

export function sealWorkspaceRuntime(): void {
  productionWorkspaceRuntimeControl.sealWorkspaceRuntime()
}
