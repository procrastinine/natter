import { raceWithAbortSignal } from '../lib/abort'
import type { WorkspaceFence } from './repository'

export type PresentationInteractionConcurrency = 'reject' | 'replace'
export type PresentationInteractionLifetime = 'presenter' | 'workspace-tab'
export type PresentationInteractionWorkspaceStart = 'require-current' | 'settle-current'

export type PresentationInteractionFailureTone = 'danger' | 'info' | 'warning'

export interface PresentationInteractionFailure {
  readonly message: string
  readonly tone: PresentationInteractionFailureTone
}

declare const presentationInteractionCapabilityBrand: unique symbol
const presentationInteractionPresenterBrand: unique symbol = Symbol(
  'presentation-interaction-presenter',
)

export interface PresentationInteractionCapability<
  Target extends PropertyKey,
  Lifetime extends PresentationInteractionLifetime = PresentationInteractionLifetime,
> {
  readonly id: string
  readonly label: string
  readonly concurrency: PresentationInteractionConcurrency
  readonly lifetime: Lifetime
  readonly workspaceStart: PresentationInteractionWorkspaceStart
  readonly pendingMessage: string
  readonly describeFailure?: (error: unknown) => PresentationInteractionFailure
  readonly [presentationInteractionCapabilityBrand]: Target
}

export type PresentationInteractionCancellationReason =
  | 'caller'
  | 'presenter-released'
  | 'workspace-replaced'

interface PresentationInteractionPresenterState {
  readonly owner: PresentationInteractionController
  readonly workspaceFence: WorkspaceFence | null
  active: boolean
}

export interface PresentationInteractionPresenter {
  readonly [presentationInteractionPresenterBrand]: PresentationInteractionPresenterState
}

const presentationInteractionOutcomeBrand: unique symbol = Symbol(
  'presentation-interaction-outcome',
)

type PresentationInteractionOutcomeShape<Value> =
  | { readonly kind: 'succeeded'; readonly value: Value }
  | { readonly kind: 'failed'; readonly failure: PresentationInteractionFailure }
  | { readonly kind: 'superseded' }
  | {
      readonly kind: 'cancelled'
      readonly reason: PresentationInteractionCancellationReason
    }
  | { readonly kind: 'rejected-pending' }

export type PresentationInteractionOutcome<Value> = PresentationInteractionOutcomeShape<Value> & {
  readonly [presentationInteractionOutcomeBrand]: true
}

export type PresentationInteractionCallbackResult<Value> =
  | Value
  | PresentationInteractionOutcome<Value>

declare const totalPresentationInteractionPromiseBrand: unique symbol

export type TotalPresentationInteractionPromise<Value> = Promise<
  PresentationInteractionOutcome<Value>
> & {
  readonly [totalPresentationInteractionPromiseBrand]: true
}

export interface PresentationInteractionClaim<Value> {
  readonly id: number
  readonly signal: AbortSignal
  readonly settled: TotalPresentationInteractionPromise<Value>
  releasePresenter(): void
  cancel(): void
}

export interface PresentationInteractionRunContext {
  readonly id: number
  readonly signal: AbortSignal
}

export type PresentationInteractionCommit<Value> = (value: Value) => undefined

export interface PresentationInteractionStart<Target extends PropertyKey, Value> {
  readonly capability: PresentationInteractionCapability<Target>
  readonly presenter: PresentationInteractionPresenter
  readonly target: Target
  readonly run: (
    context: PresentationInteractionRunContext,
  ) =>
    | PresentationInteractionCallbackResult<Value>
    | PromiseLike<PresentationInteractionCallbackResult<Value>>
  readonly commit?: PresentationInteractionCommit<Value>
}

export interface PresentationInteractionFailurePort {
  describe(
    capability: PresentationInteractionCapability<PropertyKey>,
    error: unknown,
  ): PresentationInteractionFailure
  present(failure: PresentationInteractionFailure): void
}

export interface PresentationInteractionWorkspacePort {
  currentFence(): WorkspaceFence | null
}

interface PresentationInteractionDefinition<Lifetime extends PresentationInteractionLifetime> {
  readonly id: string
  readonly label: string
  readonly concurrency: PresentationInteractionConcurrency
  readonly lifetime: Lifetime
  readonly workspaceStart?: PresentationInteractionWorkspaceStart
  readonly pendingMessage?: string
  readonly describeFailure?: (error: unknown) => PresentationInteractionFailure
}

interface ActivePresentationInteraction<Value> {
  readonly id: number
  readonly capability: PresentationInteractionCapability<PropertyKey>
  readonly target: PropertyKey
  readonly controller: AbortController
  readonly settled: TotalPresentationInteractionPromise<Value>
  readonly settle: (outcome: PresentationInteractionOutcome<Value>) => void
  workspaceFence: WorkspaceFence | null
  presenter: PresentationInteractionPresenter | null
  commit: PresentationInteractionCommit<Value> | undefined
  terminal: boolean
}

interface ReservedPresentationInteraction<Value> {
  readonly commit: PresentationInteractionCommit<Value> | undefined
  readonly revision: number
}

export function definePresentationInteraction<Target extends PropertyKey>(
  definition: PresentationInteractionDefinition<'presenter'>,
): PresentationInteractionCapability<Target, 'presenter'>
export function definePresentationInteraction<Target extends PropertyKey>(
  definition: PresentationInteractionDefinition<'workspace-tab'>,
): PresentationInteractionCapability<Target, 'workspace-tab'>
export function definePresentationInteraction<Target extends PropertyKey>(
  definition: PresentationInteractionDefinition<PresentationInteractionLifetime>,
): PresentationInteractionCapability<Target> {
  return Object.freeze({
    id: definition.id,
    label: definition.label,
    concurrency: definition.concurrency,
    lifetime: definition.lifetime,
    workspaceStart: definition.workspaceStart ?? 'require-current',
    pendingMessage: definition.pendingMessage ?? `${definition.label} is already in progress.`,
    ...(definition.describeFailure ? { describeFailure: definition.describeFailure } : {}),
  }) as PresentationInteractionCapability<Target>
}

export class PresentationInteractionController {
  readonly #active = new Map<string, Map<PropertyKey, ActivePresentationInteraction<unknown>>>()
  readonly #listeners = new Map<string, Set<() => void>>()
  readonly #revisions = new Map<string, number>()
  readonly #failurePort: PresentationInteractionFailurePort
  readonly #workspacePort: PresentationInteractionWorkspacePort
  #nextId = 0

  constructor(
    failurePort: PresentationInteractionFailurePort,
    workspacePort: PresentationInteractionWorkspacePort,
  ) {
    this.#failurePort = failurePort
    this.#workspacePort = workspacePort
  }

  createPresenter(workspaceFence: WorkspaceFence | null): PresentationInteractionPresenter {
    const state: PresentationInteractionPresenterState = {
      owner: this,
      workspaceFence: workspaceFence ? Object.freeze({ ...workspaceFence }) : null,
      active: true,
    }
    return Object.freeze({
      [presentationInteractionPresenterBrand]: state,
    })
  }

  releasePresenter(presenter: PresentationInteractionPresenter): void {
    const state = this.#presenterState(presenter)
    if (!state.active) return
    state.active = false
    const owned: ActivePresentationInteraction<unknown>[] = []
    for (const targets of this.#active.values()) {
      for (const active of targets.values()) {
        if (active.presenter === presenter) owned.push(active)
      }
    }
    for (const active of owned) this.#releaseActivePresenter(active)
  }

  reconcileWorkspace(fence: WorkspaceFence | null): void {
    const obsolete: ActivePresentationInteraction<unknown>[] = []
    for (const targets of this.#active.values()) {
      for (const active of targets.values()) {
        if (
          active.workspaceFence === null &&
          fence !== null &&
          active.capability.workspaceStart === 'settle-current'
        ) {
          active.workspaceFence = Object.freeze({ ...fence })
          continue
        }
        if (!sameWorkspaceFence(active.workspaceFence, fence)) {
          obsolete.push(active)
        }
      }
    }
    const changed = new Map<
      string,
      {
        readonly capability: PresentationInteractionCapability<PropertyKey>
        readonly revision: number
      }
    >()
    for (const active of obsolete) {
      if (active.terminal || !this.#isCurrent(active)) continue
      active.terminal = true
      active.presenter = null
      active.commit = undefined
      const key = active.capability.id
      const targets = this.#active.get(key)
      targets?.delete(active.target)
      if (targets?.size === 0) this.#active.delete(key)
      if (!changed.has(key)) {
        changed.set(key, {
          capability: active.capability,
          revision: this.#revisions.get(key) ?? 0,
        })
      }
    }
    for (const active of obsolete) {
      if (!active.terminal) continue
      active.settle(
        createPresentationInteractionOutcome({
          kind: 'cancelled',
          reason: 'workspace-replaced',
        }),
      )
      active.controller.abort('workspace-replaced')
    }
    for (const { capability, revision } of changed.values()) {
      this.#publishIfUnchanged(capability, revision)
    }
  }

  start<Target extends PropertyKey, Value>(
    input: PresentationInteractionStart<Target, Value>,
  ): PresentationInteractionClaim<Value> {
    const capability = input.capability as PresentationInteractionCapability<PropertyKey>
    const presenterState = this.#presenterState(input.presenter)
    if (!presenterState.active) {
      return this.#settledClaim({ kind: 'cancelled', reason: 'presenter-released' })
    }
    const workspaceFence = this.#workspacePort.currentFence()
    const maySettleCurrent =
      capability.workspaceStart === 'settle-current' && presenterState.workspaceFence === null
    if (workspaceFence === null && !maySettleCurrent) {
      return this.#failedStartClaim(capability, new Error('Workspace is not available.'))
    }
    if (!maySettleCurrent && !sameWorkspaceFence(presenterState.workspaceFence, workspaceFence)) {
      presenterState.active = false
      return this.#settledClaim({ kind: 'cancelled', reason: 'workspace-replaced' })
    }
    const capabilityId = input.capability.id
    const activeByTarget = this.#active.get(capabilityId)
    const previous = activeByTarget?.get(input.target)
    if (previous && !previous.terminal) {
      if (input.capability.concurrency === 'reject') {
        try {
          this.#failurePort.present(
            boundedFailure(
              { message: input.capability.pendingMessage, tone: 'info' },
              input.capability.label,
            ),
          )
        } catch {
          // The total rejected outcome does not depend on a visual notice port.
        }
        return this.#settledClaim({ kind: 'rejected-pending' })
      }
    }

    const id = ++this.#nextId
    const controller = new AbortController()
    let resolveSettlement!: (outcome: PresentationInteractionOutcome<Value>) => void
    const settled = new Promise<PresentationInteractionOutcome<Value>>((resolve) => {
      resolveSettlement = resolve
    }) as TotalPresentationInteractionPromise<Value>
    const active: ActivePresentationInteraction<Value> = {
      id,
      capability,
      target: input.target,
      controller,
      settled,
      settle: resolveSettlement,
      workspaceFence,
      presenter: input.presenter,
      commit: input.commit,
      terminal: false,
    }
    const targets = activeByTarget ?? new Map<PropertyKey, ActivePresentationInteraction<unknown>>()
    targets.set(input.target, active as ActivePresentationInteraction<unknown>)
    if (!activeByTarget) this.#active.set(capabilityId, targets)
    if (previous) this.#finish(previous, { kind: 'superseded' })
    const claim = this.#claim(active)
    if (!this.#isCurrent(active)) return claim
    this.#publish(capability)
    if (!this.#isCurrent(active)) return claim

    let result:
      | PresentationInteractionCallbackResult<Value>
      | PromiseLike<PresentationInteractionCallbackResult<Value>>
    try {
      result = input.run({ id, signal: controller.signal })
    } catch (error) {
      this.#fail(active, error)
      return claim
    }
    this.#observe(active, result)
    return claim
  }

  isPending<Target extends PropertyKey>(
    capability: PresentationInteractionCapability<Target>,
    target: Target,
  ): boolean {
    return this.#active.get(capability.id)?.has(target) ?? false
  }

  subscribe<Target extends PropertyKey>(
    capability: PresentationInteractionCapability<Target>,
    listener: () => void,
  ): () => void {
    const key = capability.id
    const listeners = this.#listeners.get(key) ?? new Set<() => void>()
    listeners.add(listener)
    this.#listeners.set(key, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.#listeners.delete(key)
      this.#pruneCapability(key)
    }
  }

  getRevision<Target extends PropertyKey>(
    capability: PresentationInteractionCapability<Target>,
  ): number {
    return this.#revisions.get(capability.id) ?? 0
  }

  #claim<Value>(active: ActivePresentationInteraction<Value>): PresentationInteractionClaim<Value> {
    return Object.freeze({
      id: active.id,
      signal: active.controller.signal,
      settled: active.settled,
      releasePresenter: () => this.#releaseActivePresenter(active),
      cancel: () => {
        if (!this.#isCurrent(active)) return
        this.#finish(active, { kind: 'cancelled', reason: 'caller' })
      },
    })
  }

  #settledClaim<Value>(
    outcome: PresentationInteractionOutcomeShape<Value>,
  ): PresentationInteractionClaim<Value> {
    const controller = new AbortController()
    controller.abort(outcome.kind)
    const settled = Promise.resolve(
      createPresentationInteractionOutcome(outcome),
    ) as TotalPresentationInteractionPromise<Value>
    return Object.freeze({
      id: ++this.#nextId,
      signal: controller.signal,
      settled,
      releasePresenter: () => undefined,
      cancel: () => undefined,
    })
  }

  #failedStartClaim<Value>(
    capability: PresentationInteractionCapability<PropertyKey>,
    error: unknown,
  ): PresentationInteractionClaim<Value> {
    const failure = describePresentationInteractionFailure(this.#failurePort, capability, error)
    try {
      this.#failurePort.present(failure)
    } catch {
      // The total failed outcome does not depend on a visual notice port.
    }
    return this.#settledClaim({ kind: 'failed', failure })
  }

  #presenterState(
    presenter: PresentationInteractionPresenter,
  ): PresentationInteractionPresenterState {
    const state = presenter[presentationInteractionPresenterBrand]
    if (state.owner !== this) throw new Error('PresentationInteractionPresenterOwnerMismatch')
    return state
  }

  #releaseActivePresenter<Value>(active: ActivePresentationInteraction<Value>): void {
    if (!this.#isCurrent(active) || active.presenter === null) return
    active.presenter = null
    active.commit = undefined
    if (active.capability.lifetime === 'presenter') {
      this.#finish(active, { kind: 'cancelled', reason: 'presenter-released' })
    }
  }

  #observe<Value>(
    active: ActivePresentationInteraction<Value>,
    result:
      | PresentationInteractionCallbackResult<Value>
      | PromiseLike<PresentationInteractionCallbackResult<Value>>,
  ): void {
    void raceWithAbortSignal(() => result, active.controller.signal)
      .then(
        (settledResult) => {
          if (!this.#isCurrent(active)) return
          const outcome = presentationInteractionOutcome<Value>(settledResult)
          if (!outcome) {
            this.#succeed(active, settledResult as Value)
          } else if (outcome.kind === 'succeeded') {
            this.#succeed(active, outcome.value)
          } else {
            this.#adoptOutcome(active, outcome)
          }
        },
        (error: unknown) => {
          if (this.#isCurrent(active)) this.#fail(active, error)
        },
      )
      .catch((error: unknown) => {
        if (this.#isCurrent(active)) this.#fail(active, error)
      })
  }

  #isCurrent<Value>(active: ActivePresentationInteraction<Value>): boolean {
    return this.#active.get(active.capability.id)?.get(active.target) === active
  }

  #fail<Value>(active: ActivePresentationInteraction<Value>, error: unknown): void {
    const reserved = this.#reserveCurrent(active)
    if (!reserved) return
    this.#failReserved(active, reserved.revision, error)
  }

  #failReserved<Value>(
    active: ActivePresentationInteraction<Value>,
    revision: number,
    error: unknown,
  ): void {
    const failure = describePresentationInteractionFailure(
      this.#failurePort,
      active.capability,
      error,
    )
    active.settle(createPresentationInteractionOutcome({ kind: 'failed', failure }))
    try {
      this.#failurePort.present(failure)
    } catch {
      // Settlement remains total even if the optional visual failure port is unavailable.
    }
    this.#publishIfUnchanged(active.capability, revision)
  }

  #succeed<Value>(active: ActivePresentationInteraction<Value>, value: Value): void {
    const reserved = this.#reserveCurrent(active)
    if (!reserved) return
    try {
      const result: unknown = reserved.commit?.(value)
      if (isPromiseLike(result)) {
        void Promise.resolve(result).catch(() => undefined)
        throw new Error('PresentationInteractionAsyncCommitForbidden')
      }
    } catch (error) {
      this.#failReserved(active, reserved.revision, error)
      return
    }
    active.settle(createPresentationInteractionOutcome({ kind: 'succeeded', value }))
    this.#publishIfUnchanged(active.capability, reserved.revision)
  }

  #adoptOutcome<Value>(
    active: ActivePresentationInteraction<Value>,
    outcome: PresentationInteractionOutcome<Value>,
  ): void {
    const reserved = this.#reserveCurrent(active)
    if (!reserved) return
    active.settle(outcome)
    if (outcome.kind === 'superseded') active.controller.abort('superseded')
    if (outcome.kind === 'cancelled') active.controller.abort(outcome.reason)
    this.#publishIfUnchanged(active.capability, reserved.revision)
  }

  #reserveCurrent<Value>(
    active: ActivePresentationInteraction<Value>,
  ): ReservedPresentationInteraction<Value> | undefined {
    if (active.terminal || !this.#isCurrent(active)) return undefined
    active.terminal = true
    active.presenter = null
    const commit = active.commit
    active.commit = undefined
    const key = active.capability.id
    const revision = this.#revisions.get(key) ?? 0
    const targets = this.#active.get(key)
    targets?.delete(active.target)
    if (targets?.size === 0) this.#active.delete(key)
    return { commit, revision }
  }

  #finish<Value>(
    active: ActivePresentationInteraction<Value>,
    outcome: PresentationInteractionOutcomeShape<Value> | PresentationInteractionOutcome<Value>,
  ): void {
    if (active.terminal) return
    active.terminal = true
    active.presenter = null
    active.commit = undefined
    const key = active.capability.id
    const revision = this.#revisions.get(key) ?? 0
    const targets = this.#active.get(key)
    const wasCurrent = targets?.get(active.target) === active
    if (wasCurrent) {
      targets.delete(active.target)
      if (targets.size === 0) this.#active.delete(key)
    }
    active.settle(createPresentationInteractionOutcome(outcome))
    if (outcome.kind === 'cancelled') active.controller.abort(outcome.reason)
    if (outcome.kind === 'superseded') active.controller.abort('superseded')
    if (outcome.kind === 'rejected-pending') active.controller.abort('rejected-pending')
    if (wasCurrent) this.#publishIfUnchanged(active.capability, revision)
  }

  #publishIfUnchanged<Target extends PropertyKey>(
    capability: PresentationInteractionCapability<Target>,
    revision: number,
  ): void {
    if ((this.#revisions.get(capability.id) ?? 0) !== revision) return
    this.#publish(capability)
  }

  #publish(capability: PresentationInteractionCapability<PropertyKey>): void {
    const key = capability.id
    this.#revisions.set(key, (this.#revisions.get(key) ?? 0) + 1)
    for (const listener of [...(this.#listeners.get(key) ?? [])]) {
      try {
        listener()
      } catch {
        // A presentation subscriber cannot own or prevent interaction settlement.
      }
    }
    this.#pruneCapability(key)
  }

  #pruneCapability(key: string): void {
    if (this.#active.has(key) || this.#listeners.has(key)) return
    this.#revisions.delete(key)
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    'then' in value &&
    typeof value.then === 'function'
  )
}

function presentationInteractionOutcome<Value>(
  value: unknown,
): PresentationInteractionOutcome<Value> | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  return presentationInteractionOutcomeBrand in value
    ? (value as PresentationInteractionOutcome<Value>)
    : undefined
}

function createPresentationInteractionOutcome<Value>(
  outcome: PresentationInteractionOutcomeShape<Value> | PresentationInteractionOutcome<Value>,
): PresentationInteractionOutcome<Value> {
  const existing = presentationInteractionOutcome<Value>(outcome)
  if (existing) return existing
  const branded = { ...outcome }
  Object.defineProperty(branded, presentationInteractionOutcomeBrand, { value: true })
  return Object.freeze(branded) as PresentationInteractionOutcome<Value>
}

function describePresentationInteractionFailure<Target extends PropertyKey>(
  failurePort: PresentationInteractionFailurePort,
  capability: PresentationInteractionCapability<Target>,
  error: unknown,
): PresentationInteractionFailure {
  try {
    return boundedFailure(
      capability.describeFailure?.(error) ?? failurePort.describe(capability, error),
      capability.label,
    )
  } catch {
    return Object.freeze({ message: `${capability.label} failed.`, tone: 'danger' })
  }
}

function boundedFailure(
  failure: PresentationInteractionFailure,
  fallbackLabel: string,
): PresentationInteractionFailure {
  const message = failure.message.trim() || `${fallbackLabel} failed.`
  return Object.freeze({
    message: message.slice(0, 1_024),
    tone: failure.tone === 'info' || failure.tone === 'warning' ? failure.tone : 'danger',
  })
}

function sameWorkspaceFence(left: WorkspaceFence | null, right: WorkspaceFence | null): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.workspaceId === right.workspaceId &&
      left.replacementEpoch === right.replacementEpoch)
  )
}
