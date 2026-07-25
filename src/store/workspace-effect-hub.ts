import { redactDiagnosticValue } from '../lib/diagnostic-redaction'
import type { WorkspaceFence } from './repository'
import {
  adoptCanonicalWorkspaceChange,
  adoptCanonicalWorkspaceCommitChange,
  canonicalizeWorkspaceChange,
  workspaceFenceFromUnknownChange,
} from './workspace-change-boundary'
import { validateAndFreezeWorkspaceLocalCommit } from './workspace-local-evidence'
import type {
  CommitEnvelope,
  WorkspaceChange,
  WorkspaceDeltaFact,
  WorkspaceDependency,
  WorkspaceLocalReceipt,
  WorkspaceRepository,
} from './workspace-protocol'
import {
  normalizeWorkspaceDependencies,
  workspaceDependenciesForDeltaFact,
} from './workspace-protocol'

export type WorkspaceEffectSource = 'local' | 'remote'
export type WorkspaceEffectCause = 'commit' | 'invalidation'
export type WorkspaceFactKind = WorkspaceDeltaFact['kind']
export type WorkspaceDependencyKind = WorkspaceDependency['kind']

export const WORKSPACE_EFFECT_RECOVERY_OWNED = Symbol('WorkspaceEffectRecoveryOwned')
export type WorkspaceEffectRecoveryOwned = typeof WORKSPACE_EFFECT_RECOVERY_OWNED

export type WorkspaceFactBuckets = {
  readonly [Kind in WorkspaceFactKind]?: readonly Extract<WorkspaceDeltaFact, { kind: Kind }>[]
}

export type WorkspaceDependencyBuckets = {
  readonly [Kind in WorkspaceDependencyKind]?: readonly Extract<
    WorkspaceDependency,
    { kind: Kind }
  >[]
}

interface WorkspaceEffectBase extends WorkspaceFence {
  readonly source: WorkspaceEffectSource
}

export type WorkspaceEffect =
  | (WorkspaceEffectBase & { readonly kind: 'replace' })
  | (WorkspaceEffectBase & {
      readonly kind: 'changed'
      readonly cause: WorkspaceEffectCause
      readonly facts: readonly WorkspaceDeltaFact[]
      readonly factsByKind: WorkspaceFactBuckets
      readonly residual: readonly WorkspaceDependency[] | 'all'
      readonly residualByKind: WorkspaceDependencyBuckets | 'all'
      readonly impact: readonly WorkspaceDependency[] | 'all'
      readonly impactByKind: WorkspaceDependencyBuckets | 'all'
      readonly receipt?: WorkspaceLocalReceipt
    })

export interface WorkspaceEffectSubscription {
  readonly owner: string
  readonly group?: string
  readonly sources?: readonly WorkspaceEffectSource[]
  readonly factKinds?: readonly WorkspaceFactKind[]
  readonly residualKinds?: readonly WorkspaceDependencyKind[]
  readonly impactKinds?: readonly WorkspaceDependencyKind[]
  readonly replacements?: boolean
  readonly apply: (effect: WorkspaceEffect) => void
  readonly recover: (error: unknown, effect: WorkspaceEffect) => WorkspaceEffectRecoveryOwned
}

export interface WorkspaceEffectFatalFailure {
  readonly owner: string
  readonly effect: WorkspaceEffect
  readonly error: unknown
  readonly recoveryError: unknown
}

interface LiveWorkspaceEffectSubscription extends WorkspaceEffectSubscription {
  active: boolean
}

const factIndex = new Map<WorkspaceFactKind, Set<LiveWorkspaceEffectSubscription>>()
const residualIndex = new Map<WorkspaceDependencyKind, Set<LiveWorkspaceEffectSubscription>>()
const impactIndex = new Map<WorkspaceDependencyKind, Set<LiveWorkspaceEffectSubscription>>()
const groupIndex = new Map<string, Set<LiveWorkspaceEffectSubscription>>()
const liveSubscriptions = new Set<LiveWorkspaceEffectSubscription>()
const replacementSubscriptions = new Set<LiveWorkspaceEffectSubscription>()
let attachedRepository: WorkspaceRepository | null = null
let stopRepositoryChanges: (() => void) | null = null
let fatalFailureHandler: ((failure: WorkspaceEffectFatalFailure) => void) | null = null

export function installWorkspaceEffectFatalFailureHandler(
  handler: (failure: WorkspaceEffectFatalFailure) => void,
): () => void {
  if (fatalFailureHandler) throw new Error('WorkspaceEffectFatalFailureHandlerAlreadyInstalled')
  fatalFailureHandler = handler
  return () => {
    if (fatalFailureHandler !== handler) return
    fatalFailureHandler = null
  }
}

export function attachWorkspaceEffectSource(repository: WorkspaceRepository): void {
  if (attachedRepository === repository) return
  stopRepositoryChanges?.()
  stopRepositoryChanges = null
  attachedRepository = repository
  attachRepositoryChangesIfDemanded()
}

export function subscribeWorkspaceEffects(subscription: WorkspaceEffectSubscription): () => void {
  const live: LiveWorkspaceEffectSubscription = { ...subscription, active: true }
  liveSubscriptions.add(live)
  for (const kind of subscription.factKinds ?? []) addIndexed(factIndex, kind, live)
  for (const kind of subscription.residualKinds ?? []) addIndexed(residualIndex, kind, live)
  for (const kind of subscription.impactKinds ?? []) addIndexed(impactIndex, kind, live)
  if (subscription.group) addIndexed(groupIndex, subscription.group, live)
  if (subscription.replacements !== false) replacementSubscriptions.add(live)
  attachRepositoryChangesIfDemanded()
  let subscribed = true
  return () => {
    if (!subscribed) return
    subscribed = false
    removeLiveSubscription(live)
  }
}

export interface PreparedWorkspaceEffect {
  readonly change: WorkspaceChange
  readonly effect: WorkspaceEffect
}

export function prepareWorkspaceEffectForLocalCommit(
  commit: CommitEnvelope<unknown>,
): PreparedWorkspaceEffect | null {
  const prepared = adoptCanonicalWorkspaceCommitChange({
    kind: 'commit',
    stamp: {
      workspaceId: commit.workspaceId,
      replacementEpoch: commit.replacementEpoch,
      commitId: commit.commitId,
    },
    delta: commit.delta,
  })
  validateAndFreezeWorkspaceLocalCommit(commit, prepared.normalForm)
  if (commit.effectScope !== 'workspace') return null
  const { change } = prepared
  return Object.freeze({
    change,
    effect: reduceWorkspaceChange(change, 'local', commit.receipt),
  })
}

export function publishPreparedWorkspaceEffect(
  effect: WorkspaceEffect,
  suppressedGroups: ReadonlySet<string> = new Set(),
): void {
  publishWorkspaceEffect(effect, suppressedGroups)
}

export function prepareWorkspaceRecoveryEffectForCommittedWrite(
  commit: Pick<CommitEnvelope<unknown>, 'workspaceId' | 'replacementEpoch'>,
): PreparedWorkspaceEffect {
  return prepareLocalWorkspaceChange({
    kind: 'invalidate',
    workspaceId: commit.workspaceId,
    replacementEpoch: commit.replacementEpoch,
    dependencies: 'all',
  })
}

export function prepareLocalWorkspaceChange(change: WorkspaceChange): PreparedWorkspaceEffect {
  const canonical = adoptCanonicalWorkspaceChange(change)
  return Object.freeze({
    change: canonical,
    effect: reduceWorkspaceChange(canonical, 'local'),
  })
}

export function recoverWorkspaceEffectGroup(
  group: string,
  error: unknown,
  effect: WorkspaceEffect,
): void {
  const subscriptions = subscriptionsForGroup(group)
  for (const subscription of subscriptions) recoverSubscription(subscription, error, effect)
}

export function reduceWorkspaceChange(
  change: WorkspaceChange,
  source: 'local' | 'remote',
  receipt?: WorkspaceLocalReceipt,
): WorkspaceEffect {
  const fence = change.kind === 'commit' ? change.stamp : change
  if (change.kind === 'replace') {
    return Object.freeze({
      kind: 'replace',
      workspaceId: fence.workspaceId,
      replacementEpoch: fence.replacementEpoch,
      source,
    })
  }
  const facts =
    change.kind === 'commit' ? Object.freeze([...change.delta.facts]) : Object.freeze([])
  const residual = change.kind === 'commit' ? change.delta.invalidations : change.dependencies
  const impact =
    residual === 'all'
      ? 'all'
      : normalizeWorkspaceDependencies([
          ...residual,
          ...facts.flatMap((fact) => workspaceDependenciesForDeltaFact(fact)),
        ])
  return Object.freeze({
    kind: 'changed',
    cause: change.kind === 'commit' ? 'commit' : 'invalidation',
    workspaceId: fence.workspaceId,
    replacementEpoch: fence.replacementEpoch,
    source,
    facts,
    factsByKind: bucketFacts(facts),
    residual,
    residualByKind: residual === 'all' ? 'all' : bucketDependencies(residual),
    impact,
    impactByKind: impact === 'all' ? 'all' : bucketDependencies(impact),
    ...(receipt ? { receipt } : {}),
  })
}

function publishWorkspaceEffect(
  effect: WorkspaceEffect,
  suppressedGroups: ReadonlySet<string> = new Set(),
): void {
  const addressed = addressedSubscriptions(effect)
  for (const subscription of addressed) {
    if (!subscription.active) continue
    if (subscription.group && suppressedGroups.has(subscription.group)) continue
    if (!subscriptionAcceptsEffect(subscription, effect)) continue
    try {
      subscription.apply(effect)
    } catch (error) {
      recoverSubscription(subscription, error, effect)
    }
  }
}

function recoverSubscription(
  subscription: LiveWorkspaceEffectSubscription,
  error: unknown,
  effect: WorkspaceEffect,
): boolean {
  try {
    const recovered = subscription.recover(error, effect)
    if (recovered !== WORKSPACE_EFFECT_RECOVERY_OWNED) {
      throw new Error('WorkspaceEffectRecoveryNotOwned')
    }
    return true
  } catch (recoveryError) {
    removeLiveSubscription(subscription)
    reportWorkspaceEffectFailure(subscription.owner, error, recoveryError)
    reportWorkspaceEffectFatalFailure({
      owner: subscription.owner,
      effect,
      error,
      recoveryError,
    })
    return false
  }
}

function addressedSubscriptions(effect: WorkspaceEffect): Set<LiveWorkspaceEffectSubscription> {
  if (effect.kind === 'replace') return new Set(replacementSubscriptions)
  const addressed = new Set<LiveWorkspaceEffectSubscription>()
  for (const kind of Object.keys(effect.factsByKind) as WorkspaceFactKind[]) {
    addSubscriptions(addressed, factIndex.get(kind))
  }
  if (effect.residualByKind === 'all' || Object.hasOwn(effect.residualByKind, 'workspace')) {
    addSubscriptions(addressed, liveSubscriptions)
  } else {
    for (const kind of Object.keys(effect.residualByKind) as WorkspaceDependencyKind[]) {
      addSubscriptions(addressed, residualIndex.get(kind))
    }
  }
  if (effect.impactByKind === 'all' || Object.hasOwn(effect.impactByKind, 'workspace')) {
    addSubscriptions(addressed, liveSubscriptions)
  } else {
    for (const kind of Object.keys(effect.impactByKind) as WorkspaceDependencyKind[]) {
      addSubscriptions(addressed, impactIndex.get(kind))
    }
  }
  return addressed
}

function subscriptionAcceptsEffect(
  subscription: LiveWorkspaceEffectSubscription,
  effect: WorkspaceEffect,
): boolean {
  if (subscription.sources && !subscription.sources.includes(effect.source)) return false
  if (effect.kind === 'replace') return subscription.replacements !== false
  if (
    effect.residualByKind === 'all' ||
    effect.impactByKind === 'all' ||
    Object.hasOwn(effect.residualByKind, 'workspace') ||
    Object.hasOwn(effect.impactByKind, 'workspace')
  ) {
    return true
  }
  return (
    intersectsBuckets(effect.factsByKind, subscription.factKinds) ||
    intersectsBuckets(effect.residualByKind, subscription.residualKinds) ||
    intersectsBuckets(effect.impactByKind, subscription.impactKinds)
  )
}

function intersectsBuckets(
  buckets: Record<string, unknown> | 'all',
  kinds: readonly string[] | undefined,
): boolean {
  if (!kinds || kinds.length === 0) return false
  return buckets === 'all' || kinds.some((kind) => kind in buckets)
}

function bucketFacts(facts: readonly WorkspaceDeltaFact[]): WorkspaceFactBuckets {
  const buckets: Partial<Record<WorkspaceFactKind, WorkspaceDeltaFact[]>> = {}
  for (const fact of facts) {
    const bucket = buckets[fact.kind] ?? []
    bucket.push(fact)
    buckets[fact.kind] = bucket
  }
  for (const bucket of Object.values(buckets)) Object.freeze(bucket)
  return Object.freeze(buckets) as WorkspaceFactBuckets
}

function bucketDependencies(
  dependencies: readonly WorkspaceDependency[],
): WorkspaceDependencyBuckets {
  const buckets: Partial<Record<WorkspaceDependencyKind, WorkspaceDependency[]>> = {}
  for (const dependency of dependencies) {
    const bucket = buckets[dependency.kind] ?? []
    bucket.push(dependency)
    buckets[dependency.kind] = bucket
  }
  for (const bucket of Object.values(buckets)) Object.freeze(bucket)
  return Object.freeze(buckets) as WorkspaceDependencyBuckets
}

function addIndexed<Key>(
  index: Map<Key, Set<LiveWorkspaceEffectSubscription>>,
  key: Key,
  subscription: LiveWorkspaceEffectSubscription,
): void {
  const subscriptions = index.get(key)
  if (subscriptions) subscriptions.add(subscription)
  else index.set(key, new Set([subscription]))
}

function removeIndexed<Key>(
  index: Map<Key, Set<LiveWorkspaceEffectSubscription>>,
  key: Key,
  subscription: LiveWorkspaceEffectSubscription,
): void {
  const subscriptions = index.get(key)
  if (!subscriptions) return
  subscriptions.delete(subscription)
  if (subscriptions.size === 0) index.delete(key)
}

function addSubscriptions(
  target: Set<LiveWorkspaceEffectSubscription>,
  source: Set<LiveWorkspaceEffectSubscription> | undefined,
): void {
  if (!source) return
  for (const subscription of source) target.add(subscription)
}

function subscriptionsForGroup(group: string): Set<LiveWorkspaceEffectSubscription> {
  return groupIndex.get(group) ?? new Set()
}

function attachRepositoryChangesIfDemanded(): void {
  if (stopRepositoryChanges || liveSubscriptions.size === 0 || !attachedRepository) return
  stopRepositoryChanges = attachedRepository.subscribeChanges(
    (change) => {
      try {
        publishWorkspaceEffect(reduceWorkspaceChange(canonicalizeWorkspaceChange(change), 'remote'))
      } catch (error) {
        const fence = workspaceFenceFromUnknownChange(change)
        reportRemoteWorkspaceChangeFailure(error, fence)
        if (!fence) return
        publishWorkspaceEffect(
          reduceWorkspaceChange(
            canonicalizeWorkspaceChange({
              kind: 'invalidate',
              workspaceId: fence.workspaceId,
              replacementEpoch: fence.replacementEpoch,
              dependencies: 'all',
            }),
            'remote',
          ),
        )
      }
    },
    { delivery: 'remote' },
  )
}

export function __resetWorkspaceEffectHubForTests(): void {
  stopRepositoryChanges?.()
  stopRepositoryChanges = null
  attachedRepository = null
  liveSubscriptions.clear()
  factIndex.clear()
  residualIndex.clear()
  impactIndex.clear()
  groupIndex.clear()
  replacementSubscriptions.clear()
}

function removeLiveSubscription(subscription: LiveWorkspaceEffectSubscription): void {
  if (!subscription.active) return
  subscription.active = false
  liveSubscriptions.delete(subscription)
  for (const kind of subscription.factKinds ?? []) removeIndexed(factIndex, kind, subscription)
  for (const kind of subscription.residualKinds ?? []) {
    removeIndexed(residualIndex, kind, subscription)
  }
  for (const kind of subscription.impactKinds ?? []) {
    removeIndexed(impactIndex, kind, subscription)
  }
  if (subscription.group) removeIndexed(groupIndex, subscription.group, subscription)
  replacementSubscriptions.delete(subscription)
  if (liveSubscriptions.size === 0) {
    stopRepositoryChanges?.()
    stopRepositoryChanges = null
  }
}

function reportWorkspaceEffectFailure(owner: string, error: unknown, recoveryError: unknown): void {
  try {
    console.error('Workspace effect recovery failed', {
      owner,
      error: redactDiagnosticValue(error),
      recoveryError: redactDiagnosticValue(recoveryError),
    })
  } catch {
    return
  }
}

function reportRemoteWorkspaceChangeFailure(error: unknown, fence: WorkspaceFence | null): void {
  try {
    console.error('Remote workspace change rejected', {
      ...(fence
        ? { workspaceId: fence.workspaceId, replacementEpoch: fence.replacementEpoch }
        : {}),
      error: redactDiagnosticValue(error),
    })
  } catch {
    return
  }
}

function reportWorkspaceEffectFatalFailure(failure: WorkspaceEffectFatalFailure): void {
  try {
    if (fatalFailureHandler) {
      fatalFailureHandler(failure)
      return
    }
  } catch (error) {
    reportWorkspaceEffectFailure(failure.owner, failure.recoveryError, error)
  }
  const host = globalThis as unknown as {
    readonly location?: Location
    readonly reportError?: (error: unknown) => void
  }
  try {
    if (host.location) {
      host.location.reload()
      return
    }
  } catch {
    // Fall through to the host error reporter when navigation is unavailable.
  }
  host.reportError?.(
    new AggregateError(
      [failure.error, failure.recoveryError],
      `WorkspaceEffectOwnerFailed:${failure.owner}`,
    ),
  )
}
