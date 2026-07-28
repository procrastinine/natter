import { normalizeModelsResponse } from '../api/providers'
import { modelCatalogQueryForConnectionKind, modelsCacheKey } from '../core/cache-keys'
import { resolveModelIdFromCatalog } from '../core/model-selection'
import type { ProfileId } from '../core/types'
import { stableStringify } from '../lib/same-value'
import { executeConfigurationCommand } from './configuration-command-client'
import { configurationRequestRevisionKey } from './configuration-domain-contract'
import type { CachedModelsRow } from './db-rows'
import { withCoordinationLock } from './locks'
import type { WorkspaceFence } from './repository'
import {
  subscribeWorkspaceEffects,
  WORKSPACE_EFFECT_RECOVERY_OWNED,
  type WorkspaceEffect,
} from './workspace-effect-hub'
import { getWorkspaceRepository } from './workspace-repository'
import { runWorkspaceRead } from './workspace-runtime'
import type { WorkspaceRuntimeCapabilityActivation } from './workspace-runtime-control'

interface ModelResolutionCycle {
  readonly fence: WorkspaceFence
  readonly controller: AbortController
  readonly detachActivationAbort: () => void
  requestedRevision: number
  completedRevision: number
  task: Promise<void> | null
}

interface TransientModelCatalog {
  readonly row: CachedModelsRow
  readonly catalogId: string
}

const TRANSIENT_CATALOG_LIMIT = 16

let attachedFence: WorkspaceFence | null = null
let unsubscribeEffects: (() => void) | null = null
let activeCycle: ModelResolutionCycle | null = null
const transientCatalogs = new Map<string, TransientModelCatalog>()

export function attachConfigurationModelResolutionCapability(fence: WorkspaceFence): void {
  if (attachedFence) throw new Error('ConfigurationModelResolutionCapabilityAlreadyAttached')
  attachedFence = Object.freeze({ ...fence })
  unsubscribeEffects = subscribeWorkspaceEffects({
    owner: 'configuration-model-resolution-capability',
    impactKinds: ['model-resolution'],
    replacements: true,
    apply: receiveWorkspaceEffect,
    recover: (_error, effect) => {
      receiveWorkspaceEffect(effect)
      return WORKSPACE_EFFECT_RECOVERY_OWNED
    },
  })
}

export function activateConfigurationModelResolutionCapability(
  activation: WorkspaceRuntimeCapabilityActivation,
): Promise<void> {
  const fence = attachedFence
  if (
    !fence ||
    fence.workspaceId !== activation.workspaceId ||
    fence.replacementEpoch !== activation.replacementEpoch
  ) {
    throw new Error('ConfigurationModelResolutionCapabilityFenceMismatch')
  }
  if (activeCycle) throw new Error('ConfigurationModelResolutionCapabilityAlreadyActive')
  const controller = new AbortController()
  const abort = () => controller.abort(activation.signal.reason)
  if (activation.signal.aborted) abort()
  else activation.signal.addEventListener('abort', abort, { once: true })
  const cycle: ModelResolutionCycle = {
    fence,
    controller,
    detachActivationAbort: () => activation.signal.removeEventListener('abort', abort),
    requestedRevision: 1,
    completedRevision: 0,
    task: null,
  }
  activeCycle = cycle
  ensureDrain(cycle)
  return cycle.task ?? Promise.resolve()
}

export function requestConfigurationModelResolution(transient?: CachedModelsRow): void {
  if (transient) retainTransientCatalog(transient)
  const cycle = activeCycle
  if (!cycle || cycle.controller.signal.aborted) return
  cycle.requestedRevision += 1
  ensureDrain(cycle)
}

export function closeConfigurationModelResolutionCapability(): void {
  const cycle = activeCycle
  activeCycle = null
  cycle?.detachActivationAbort()
  cycle?.controller.abort(
    new DOMException('Configuration model resolution capability closed', 'AbortError'),
  )
  unsubscribeEffects?.()
  unsubscribeEffects = null
  attachedFence = null
  transientCatalogs.clear()
}

export function abortConfigurationModelResolutionCapability(): void {
  closeConfigurationModelResolutionCapability()
}

export async function awaitConfigurationModelResolutionCapabilityIdle(): Promise<void> {
  for (;;) {
    const task = activeCycle?.task ?? null
    if (task) await Promise.allSettled([task])
    if (task === (activeCycle?.task ?? null)) return
  }
}

export function assertConfigurationModelResolutionCapabilityClosed(): void {
  if (attachedFence || unsubscribeEffects || activeCycle || transientCatalogs.size > 0) {
    throw new Error('ConfigurationModelResolutionCapabilityNotClosed')
  }
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
  requestConfigurationModelResolution()
}

function ensureDrain(cycle: ModelResolutionCycle): void {
  if (activeCycle !== cycle || cycle.controller.signal.aborted || cycle.task) return
  const task = drainRequests(cycle)
  cycle.task = task
  const settle = () => {
    if (cycle.task === task) cycle.task = null
    if (
      activeCycle === cycle &&
      !cycle.controller.signal.aborted &&
      cycle.completedRevision < cycle.requestedRevision
    ) {
      ensureDrain(cycle)
    }
  }
  void task.then(settle, settle)
}

async function drainRequests(cycle: ModelResolutionCycle): Promise<void> {
  while (cycleIsCurrent(cycle) && cycle.completedRevision < cycle.requestedRevision) {
    const revision = cycle.requestedRevision
    await withCoordinationLock(
      `configuration-model-resolution:${cycle.fence.workspaceId}`,
      ({ ownershipLost }) => drainPendingTargets(cycle, ownershipLost),
      { signal: cycle.controller.signal },
    )
    cycle.completedRevision = revision
  }
}

async function drainPendingTargets(
  cycle: ModelResolutionCycle,
  ownershipLost: AbortSignal | undefined,
): Promise<void> {
  while (cycleIsCurrent(cycle) && !ownershipLost?.aborted) {
    const head = await readModelResolutionHead(cycle)
    if (head.kind !== 'pending') return
    const progressed = await drainTarget(cycle, head.profileId, head.profileRevision, ownershipLost)
    if (!progressed) return
  }
}

async function drainTarget(
  cycle: ModelResolutionCycle,
  profileId: ProfileId,
  profileRevision: string,
  ownershipLost: AbortSignal | undefined,
): Promise<boolean> {
  let knownModels:
    | {
        readonly profileRevision: string
        readonly payloadId: string
        readonly payloadByteLength: number
        readonly fetchedAt: number
      }
    | undefined
  let candidates: ReturnType<typeof normalizeModelsResponse> | null = null
  let catalog:
    | {
        readonly kind: 'cached'
        readonly queryKey: string
        readonly profileRevision: string
        readonly payloadId: string
        readonly payloadByteLength: number
        readonly fetchedAt: number
      }
    | {
        readonly kind: 'transient'
        readonly queryKey: string
        readonly profileRevision: string
        readonly catalogId: string
        readonly fetchedAt: number
      }
    | null = null
  let targetProgress = false

  for (;;) {
    if (!cycleIsCurrent(cycle) || ownershipLost?.aborted) return targetProgress
    const page = await readModelResolutionPage(cycle, profileId, profileRevision, knownModels)
    if (page.kind !== 'ready') return targetProgress
    const queryKey = modelsCacheKey(modelCatalogQueryForConnectionKind(page.profileKind))
    if (page.models.kind === 'loaded') {
      knownModels = page.models.token
      candidates = normalizeModelsResponse(page.models.row.payload)
      catalog = {
        kind: 'cached',
        queryKey,
        profileRevision: page.models.token.profileRevision,
        payloadId: page.models.token.payloadId,
        payloadByteLength: page.models.token.payloadByteLength,
        fetchedAt: page.models.token.fetchedAt,
      }
    } else if (page.models.kind === 'unchanged') {
      knownModels = page.models.token
    } else {
      const transient = transientCatalogs.get(configurationRequestRevisionKey(page.target))
      if (!transient) return targetProgress
      candidates = normalizeModelsResponse(transient.row.payload)
      catalog = {
        kind: 'transient',
        queryKey,
        profileRevision: transient.row.profileRevision,
        catalogId: transient.catalogId,
        fetchedAt: transient.row.fetchedAt,
      }
    }
    if (!candidates || !catalog) return targetProgress

    let pageProgress = false
    for (const pending of page.pending) {
      if (!cycleIsCurrent(cycle) || ownershipLost?.aborted) return targetProgress
      const result = await executeConfigurationCommand({
        kind: 'chat.resolve-model',
        chatId: pending.chatId,
        intentId: pending.intentId,
        requestKeyId: page.requestKeyId,
        target: page.target,
        pendingTarget: pending.target,
        modelId: resolveModelIdFromCatalog(pending.sourceModelId, page.profileKind, candidates),
        catalog,
        expectedConfigurationVersion: pending.expectedConfigurationVersion,
        now: Date.now(),
      })
      if (result.kind === 'chat-updated' && result.changed) {
        pageProgress = true
        targetProgress = true
      }
    }
    if (!page.pageFull) return targetProgress
    if (!pageProgress) return targetProgress
  }
}

async function readModelResolutionHead(cycle: ModelResolutionCycle) {
  return runWorkspaceRead(
    'repository-query',
    (permit) =>
      getWorkspaceRepository()
        .query(
          permit,
          { kind: 'configuration.model-resolution-head' },
          { signal: cycle.controller.signal },
        )
        .then((envelope) => envelope.value),
    { signal: cycle.controller.signal },
  )
}

async function readModelResolutionPage(
  cycle: ModelResolutionCycle,
  profileId: ProfileId,
  profileRevision: string,
  knownModels:
    | {
        readonly profileRevision: string
        readonly payloadId: string
        readonly payloadByteLength: number
        readonly fetchedAt: number
      }
    | undefined,
) {
  return runWorkspaceRead(
    'repository-query',
    (permit) =>
      getWorkspaceRepository()
        .query(
          permit,
          {
            kind: 'configuration.model-resolution-page',
            profileId,
            profileRevision,
            ...(knownModels ? { knownModels } : {}),
          },
          { signal: cycle.controller.signal },
        )
        .then((envelope) => envelope.value),
    { signal: cycle.controller.signal },
  )
}

function retainTransientCatalog(row: CachedModelsRow): void {
  const key = row.profileRevision
  transientCatalogs.delete(key)
  transientCatalogs.set(key, {
    row: structuredClone(row),
    catalogId: `transient:${stableStringify(
      normalizeModelsResponse(row.payload).map(({ id }) => id),
    )}`,
  })
  while (transientCatalogs.size > TRANSIENT_CATALOG_LIMIT) {
    const oldest = transientCatalogs.keys().next().value
    if (oldest === undefined) return
    transientCatalogs.delete(oldest)
  }
}

function cycleIsCurrent(cycle: ModelResolutionCycle): boolean {
  return activeCycle === cycle && !cycle.controller.signal.aborted
}
