import type { MessageId } from '../core/types'
import type {
  BranchTreeSearchRequest,
  BranchTreeSearchSession,
  BranchTreeSearchSnapshot,
  BranchTreeSearchSource,
  BranchTreeSearchTarget,
} from './branch-tree-search-contract'
import {
  evaluateMessageTexts,
  type MessageTextEvaluation,
  searchChatMessageText,
} from './message-search-service'
import { branchTreeSearchTarget, type MessageHeaderRow } from './message-storage'
import {
  type MountedProjectionLifecycle,
  type MountedProjectionReconcileEvent,
  mountRepositoryProjection,
} from './mounted-projection-lifecycle'
import type { WorkspaceFence } from './repository'
import type { WorkspaceRepository } from './workspace-protocol'
import { getWorkspaceRepository } from './workspace-repository'

interface TargetState {
  readonly nodeVersion: number
  readonly bodyVersion: number
  readonly pending: boolean
}

interface ReadState {
  readonly generation: number
  readonly controller: AbortController
}

const POINT_READ_BATCH_SIZE = 32

export function createLoadedBranchTreeSearchSession(
  source?: BranchTreeSearchSource,
): BranchTreeSearchSession {
  return new TabBranchTreeSearchSession(source ?? createWorkspaceBranchTreeSearchSource())
}

function createWorkspaceBranchTreeSearchSource(
  repository?: WorkspaceRepository,
): BranchTreeSearchSource {
  const currentRepository = () => repository ?? getWorkspaceRepository()
  return {
    searchChatMessageText: (chatId, query, options) =>
      searchChatMessageText(chatId, query, {
        repository: currentRepository(),
        ...(options?.signal ? { signal: options.signal } : {}),
      }),
    evaluateMessageTexts: (chatId, messageIds, query, options) =>
      evaluateMessageTexts(chatId, messageIds, query, {
        repository: currentRepository(),
        ...(options?.signal ? { signal: options.signal } : {}),
      }),
  }
}

class TabBranchTreeSearchSession implements BranchTreeSearchSession {
  private readonly source: BranchTreeSearchSource
  private readonly listeners = new Set<() => void>()
  private readonly lifecycle: MountedProjectionLifecycle
  private readonly targets = new Map<MessageId, TargetState>()
  private readonly evaluatedVersions = new Map<MessageId, TargetState>()
  private readonly matchedIds = new Set<MessageId>()
  private readonly dirtyIds = new Set<MessageId>()
  private order: readonly MessageId[] = Object.freeze([])
  private snapshot: BranchTreeSearchSnapshot | null = null
  private fullRead: ReadState | null = null
  private pointRead: ReadState | null = null
  private inspectedMessageId: MessageId | null = null
  private generation = 0
  private revision = 0
  private revealRevision = 0
  private pointDrainScheduled = false
  private resumeReadPending = false
  private active = true
  private disposed = false

  constructor(source: BranchTreeSearchSource) {
    this.source = source
    this.lifecycle = mountRepositoryProjection({
      suspend: () => this.suspendForRuntime(),
      reconcile: (event) => this.reconcileRuntime(event),
      resume: (event) => this.resumeRuntime(event),
      dispose: () => this.disposeOwner(),
    })
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return () => undefined
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  readonly getSnapshot = (): BranchTreeSearchSnapshot | null => this.snapshot

  setActive(active: boolean): void {
    if (this.disposed || this.active === active) return
    this.active = active
    if (active) return
    this.generation += 1
    this.abortReads()
    this.targets.clear()
    this.evaluatedVersions.clear()
    this.matchedIds.clear()
    this.dirtyIds.clear()
    this.order = Object.freeze([])
    this.resumeReadPending = this.snapshot !== null && this.snapshot.query.length > 0
    if (this.snapshot) {
      this.snapshot = Object.freeze({
        ...this.snapshot,
        revision: ++this.revision,
        status: this.snapshot.query.length > 0 ? 'searching' : 'idle',
        interactive: false,
        matches: Object.freeze([]),
        currentIndex: -1,
        currentMatchId: null,
        error: null,
      })
      this.emit()
    }
  }

  request(request: BranchTreeSearchRequest): void {
    if (this.disposed) throw new Error('BranchTreeSearchSessionDisposed')
    if (!this.active) return
    const query = request.query.trim()
    const sameIdentity =
      this.snapshot !== null &&
      this.snapshot.workspaceId === request.workspaceId &&
      this.snapshot.replacementEpoch === request.replacementEpoch &&
      this.snapshot.chatId === request.chatId &&
      this.snapshot.query === query
    if (sameIdentity) {
      this.replaceTopology(request.targets)
      if (this.resumeReadPending && this.lifecycle.isOpen()) {
        this.resumeReadPending = false
        this.startFullRead(false)
      }
      return
    }
    this.generation += 1
    this.abortReads()
    this.targets.clear()
    this.evaluatedVersions.clear()
    this.matchedIds.clear()
    this.dirtyIds.clear()
    this.replaceTargetState(request.targets)
    this.snapshot = Object.freeze({
      workspaceId: request.workspaceId,
      replacementEpoch: request.replacementEpoch,
      revision: ++this.revision,
      status: query.length === 0 ? 'idle' : 'searching',
      interactive: query.length === 0 && this.lifecycle.isOpen(),
      chatId: request.chatId,
      query,
      matches: Object.freeze([]),
      currentIndex: -1,
      currentMatchId: null,
      revealRevision: this.revealRevision,
      error: null,
    })
    this.emit()
    if (query.length > 0) this.startFullRead(true)
  }

  replaceTopology(targets: readonly BranchTreeSearchTarget[]): void {
    if (this.disposed || !this.snapshot) return
    const previousTargets = new Map(this.targets)
    const previousOrder = this.order
    this.replaceTargetState(targets)
    let membershipChanged = false
    for (const messageId of previousTargets.keys()) {
      if (this.targets.has(messageId)) continue
      this.evaluatedVersions.delete(messageId)
      this.dirtyIds.delete(messageId)
      membershipChanged = this.matchedIds.delete(messageId) || membershipChanged
    }
    if (this.snapshot.query.length > 0) {
      for (const [messageId, target] of this.targets) {
        const previous = previousTargets.get(messageId)
        if (target.pending) {
          this.dirtyIds.delete(messageId)
          continue
        }
        if (
          !previous ||
          previous.nodeVersion !== target.nodeVersion ||
          previous.bodyVersion !== target.bodyVersion ||
          previous.pending
        ) {
          this.dirtyIds.add(messageId)
        }
      }
    }
    if (membershipChanged || !sameMessageIds(previousOrder, this.order)) this.publishMatches(false)
    this.schedulePointDrain()
  }

  observeHeaders(headers: readonly MessageHeaderRow[]): void {
    if (this.disposed || !this.snapshot || this.snapshot.query.length === 0) return
    for (const header of headers) this.acceptHeader(header)
    this.schedulePointDrain()
  }

  observeTargets(targets: readonly BranchTreeSearchTarget[]): void {
    if (this.disposed || !this.snapshot || this.snapshot.query.length === 0) return
    for (const target of targets) this.acceptTarget(target)
    this.schedulePointDrain()
  }

  setInspectedMessageId(messageId: MessageId | null): void {
    this.inspectedMessageId = messageId
  }

  move(delta: -1 | 1): MessageId | null {
    const current = this.snapshot
    if (!current?.interactive || current.matches.length === 0) return null
    const index =
      current.currentIndex < 0
        ? delta > 0
          ? 0
          : current.matches.length - 1
        : (current.currentIndex + delta + current.matches.length) % current.matches.length
    const currentMatchId = current.matches[index] ?? null
    this.snapshot = Object.freeze({
      ...current,
      revision: ++this.revision,
      currentIndex: index,
      currentMatchId,
      revealRevision: ++this.revealRevision,
    })
    this.emit()
    return currentMatchId
  }

  clear(): void {
    if (this.disposed) return
    this.generation += 1
    this.abortReads()
    this.targets.clear()
    this.evaluatedVersions.clear()
    this.matchedIds.clear()
    this.dirtyIds.clear()
    this.order = Object.freeze([])
    this.snapshot = null
    this.emit()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposeOwner()
    this.lifecycle.dispose()
  }

  private disposeOwner(): void {
    if (this.disposed) return
    this.clear()
    this.disposed = true
    this.listeners.clear()
  }

  private replaceTargetState(targets: readonly BranchTreeSearchTarget[]): void {
    this.targets.clear()
    const order: MessageId[] = []
    for (const target of targets) {
      if (target.deleted || this.targets.has(target.id)) continue
      this.targets.set(target.id, {
        nodeVersion: target.nodeVersion,
        bodyVersion: target.bodyVersion,
        pending: target.pending,
      })
      order.push(target.id)
    }
    this.order = Object.freeze(order)
  }

  private acceptHeader(header: MessageHeaderRow): void {
    if (!this.snapshot || header.chatId !== this.snapshot.chatId) return
    this.acceptTarget(branchTreeSearchTarget(header))
  }

  private acceptTarget(target: BranchTreeSearchTarget): void {
    if (target.deleted) {
      this.targets.delete(target.id)
      this.evaluatedVersions.delete(target.id)
      this.dirtyIds.delete(target.id)
      if (this.matchedIds.delete(target.id)) this.publishMatches(false)
      return
    }
    const previous = this.targets.get(target.id)
    this.targets.set(target.id, {
      nodeVersion: target.nodeVersion,
      bodyVersion: target.bodyVersion,
      pending: target.pending,
    })
    if (target.pending) {
      this.dirtyIds.delete(target.id)
      return
    }
    const evaluated = this.evaluatedVersions.get(target.id)
    if (
      !previous ||
      previous.pending ||
      previous.nodeVersion !== target.nodeVersion ||
      previous.bodyVersion !== target.bodyVersion ||
      !evaluated ||
      evaluated.nodeVersion !== target.nodeVersion ||
      evaluated.bodyVersion !== target.bodyVersion
    ) {
      this.dirtyIds.add(target.id)
    }
  }

  private startFullRead(queryChanged: boolean): void {
    const current = this.snapshot
    if (!current || current.query.length === 0 || this.disposed || !this.active) return
    if (!this.lifecycle.isOpen()) {
      this.resumeReadPending = true
      return
    }
    this.fullRead?.controller.abort()
    this.pointRead?.controller.abort()
    this.pointRead = null
    const generation = ++this.generation
    const controller = new AbortController()
    this.fullRead = { generation, controller }
    const versions = new Map(this.targets)
    this.snapshot = Object.freeze({
      ...current,
      revision: ++this.revision,
      status: 'searching',
      interactive: false,
      ...(queryChanged
        ? {
            matches: Object.freeze([]),
            currentIndex: -1,
            currentMatchId: null,
          }
        : {}),
      error: null,
    })
    this.emit()
    void this.lifecycle
      .track(
        this.source.searchChatMessageText(current.chatId, current.query, {
          signal: controller.signal,
        }),
      )
      .then(
        (messageIds) => this.settleFullRead(generation, versions, messageIds, queryChanged),
        (error: unknown) =>
          this.settleFullRead(generation, versions, undefined, queryChanged, error),
      )
  }

  private settleFullRead(
    generation: number,
    versions: ReadonlyMap<MessageId, TargetState>,
    messageIds: readonly MessageId[] | undefined,
    queryChanged: boolean,
    error?: unknown,
  ): void {
    if (this.fullRead?.generation === generation) this.fullRead = null
    if (this.disposed || generation !== this.generation || !this.snapshot) return
    if (error !== undefined) {
      if (!isAbortError(error)) this.publishError(error)
      return
    }
    const hits = new Set(messageIds)
    for (const [messageId, captured] of versions) {
      const current = this.targets.get(messageId)
      if (!current) continue
      if (current.pending) {
        this.dirtyIds.delete(messageId)
        continue
      }
      if (
        current.nodeVersion !== captured.nodeVersion ||
        current.bodyVersion !== captured.bodyVersion ||
        captured.pending
      ) {
        this.dirtyIds.add(messageId)
        continue
      }
      if (hits.has(messageId)) this.matchedIds.add(messageId)
      else this.matchedIds.delete(messageId)
      this.evaluatedVersions.set(messageId, current)
      this.dirtyIds.delete(messageId)
    }
    for (const [messageId, current] of this.targets) {
      if (!versions.has(messageId) && !current.pending) this.dirtyIds.add(messageId)
    }
    for (const messageId of [...this.matchedIds]) {
      if (!this.targets.has(messageId)) this.matchedIds.delete(messageId)
    }
    this.publishMatches(queryChanged)
    this.schedulePointDrain()
  }

  private schedulePointDrain(): void {
    if (
      this.disposed ||
      !this.active ||
      this.pointDrainScheduled ||
      this.pointRead ||
      this.fullRead ||
      this.dirtyIds.size === 0 ||
      !this.snapshot ||
      this.snapshot.query.length === 0
    ) {
      return
    }
    if (!this.lifecycle.isOpen()) {
      this.resumeReadPending = true
      return
    }
    this.pointDrainScheduled = true
    queueMicrotask(() => {
      this.pointDrainScheduled = false
      this.startPointRead()
    })
  }

  private startPointRead(): void {
    const current = this.snapshot
    if (
      this.disposed ||
      !this.active ||
      !current ||
      this.pointRead ||
      this.fullRead ||
      this.dirtyIds.size === 0
    ) {
      return
    }
    if (!this.lifecycle.isOpen()) {
      this.resumeReadPending = true
      return
    }
    const messageIds: MessageId[] = []
    const versions = new Map<MessageId, TargetState>()
    for (const messageId of this.dirtyIds) {
      this.dirtyIds.delete(messageId)
      const target = this.targets.get(messageId)
      if (!target || target.pending) continue
      messageIds.push(messageId)
      versions.set(messageId, target)
      if (messageIds.length === POINT_READ_BATCH_SIZE) break
    }
    if (messageIds.length === 0) {
      if (current.status !== 'ready') this.publishReady()
      return
    }
    const generation = this.generation
    const controller = new AbortController()
    this.pointRead = { generation, controller }
    void this.lifecycle
      .track(
        this.source.evaluateMessageTexts(current.chatId, messageIds, current.query, {
          signal: controller.signal,
        }),
      )
      .then(
        (evaluations) => this.settlePointRead(generation, messageIds, versions, evaluations),
        (error: unknown) =>
          this.settlePointRead(generation, messageIds, versions, undefined, error),
      )
  }

  private settlePointRead(
    generation: number,
    messageIds: readonly MessageId[],
    versions: ReadonlyMap<MessageId, TargetState>,
    evaluations?: readonly MessageTextEvaluation[],
    error?: unknown,
  ): void {
    if (this.pointRead?.generation === generation) this.pointRead = null
    if (this.disposed || generation !== this.generation || !this.snapshot) return
    if (error !== undefined) {
      if (!isAbortError(error)) this.publishError(error)
      return
    }
    if (!evaluations || evaluations.length !== messageIds.length) {
      this.publishError(new Error('BranchTreeSearchPointReadLengthMismatch'))
      return
    }
    let changed = false
    for (let index = 0; index < messageIds.length; index += 1) {
      const messageId = messageIds[index] as MessageId
      const target = this.targets.get(messageId)
      const evaluation = evaluations[index]
      const expected = versions.get(messageId)
      if (
        !target ||
        !expected ||
        !evaluation ||
        target.nodeVersion !== expected.nodeVersion ||
        target.bodyVersion !== expected.bodyVersion
      ) {
        continue
      }
      if (evaluation.messageId !== messageId) {
        this.publishError(new Error('BranchTreeSearchPointReadKeyMismatch'))
        return
      }
      if (evaluation.pending) {
        this.targets.set(messageId, { ...target, pending: true })
        continue
      }
      if (
        evaluation.present &&
        (evaluation.nodeVersion !== target.nodeVersion ||
          evaluation.bodyVersion !== target.bodyVersion)
      ) {
        continue
      }
      const matched = evaluation.present && evaluation.matches
      if (matched) {
        if (!this.matchedIds.has(messageId)) {
          this.matchedIds.add(messageId)
          changed = true
        }
      } else if (this.matchedIds.delete(messageId)) {
        changed = true
      }
      if (evaluation.present && evaluation.bodyVersion !== undefined) {
        this.evaluatedVersions.set(messageId, target)
      } else {
        this.evaluatedVersions.delete(messageId)
      }
    }
    if (changed) this.publishMatches(false)
    else if (this.dirtyIds.size === 0 && this.snapshot.status !== 'ready') this.publishReady()
    this.schedulePointDrain()
  }

  private publishMatches(queryChanged: boolean): void {
    const current = this.snapshot
    if (!current) return
    const matches = Object.freeze(this.order.filter((messageId) => this.matchedIds.has(messageId)))
    const previousMatchId = current.currentMatchId
    const retainedIndex = previousMatchId ? matches.indexOf(previousMatchId) : -1
    const currentIndex = matches.length === 0 ? -1 : retainedIndex >= 0 ? retainedIndex : 0
    const currentMatchId = currentIndex < 0 ? null : (matches[currentIndex] ?? null)
    const reveal =
      (queryChanged && currentMatchId !== null) ||
      (previousMatchId !== null &&
        this.inspectedMessageId === previousMatchId &&
        currentMatchId !== null &&
        currentMatchId !== previousMatchId)
    this.snapshot = Object.freeze({
      ...current,
      revision: ++this.revision,
      status: this.fullRead || this.pointRead || this.dirtyIds.size > 0 ? 'searching' : 'ready',
      interactive:
        this.lifecycle.isOpen() &&
        !this.resumeReadPending &&
        !this.fullRead &&
        !this.pointRead &&
        this.dirtyIds.size === 0,
      matches,
      currentIndex,
      currentMatchId,
      revealRevision: reveal ? ++this.revealRevision : this.revealRevision,
      error: null,
    })
    this.emit()
  }

  private publishReady(): void {
    const current = this.snapshot
    if (!current) return
    this.snapshot = Object.freeze({
      ...current,
      revision: ++this.revision,
      status: 'ready',
      interactive: this.lifecycle.isOpen() && !this.resumeReadPending,
      error: null,
    })
    this.emit()
  }

  private publishError(error: unknown): void {
    const current = this.snapshot
    if (!current) return
    this.snapshot = Object.freeze({
      ...current,
      revision: ++this.revision,
      status: 'error',
      interactive: false,
      error,
    })
    this.emit()
  }

  private suspendForRuntime(): void {
    if (this.disposed) return
    this.resumeReadPending = this.active && this.snapshot !== null && this.snapshot.query.length > 0
    this.generation += 1
    this.abortReads()
    const current = this.snapshot
    if (!current) return
    this.snapshot = Object.freeze({
      ...current,
      revision: ++this.revision,
      status: current.query.length > 0 ? 'searching' : 'idle',
      interactive: false,
      error: null,
    })
    this.emit()
  }

  private reconcileRuntime(event: MountedProjectionReconcileEvent): void {
    const current = this.snapshot
    if (this.disposed || !current) return
    this.resumeReadPending = this.active && current.query.length > 0
    if (sameFence(current, event.fence)) return
    this.generation += 1
    this.abortReads()
    this.targets.clear()
    this.evaluatedVersions.clear()
    this.matchedIds.clear()
    this.dirtyIds.clear()
    this.order = Object.freeze([])
    this.snapshot = Object.freeze({
      ...current,
      workspaceId: event.fence.workspaceId,
      replacementEpoch: event.fence.replacementEpoch,
      revision: ++this.revision,
      status: current.query.length > 0 ? 'searching' : 'idle',
      interactive: false,
      matches: Object.freeze([]),
      currentIndex: -1,
      currentMatchId: null,
      error: null,
    })
    this.emit()
  }

  private resumeRuntime(event: MountedProjectionReconcileEvent): void {
    if (this.disposed) return
    const current = this.snapshot
    if (current && !sameFence(current, event.fence)) this.reconcileRuntime(event)
    if (!this.resumeReadPending || !this.active || !this.snapshot) return
    if (this.targets.size === 0) return
    this.resumeReadPending = false
    this.startFullRead(false)
  }

  private abortReads(): void {
    this.fullRead?.controller.abort()
    this.pointRead?.controller.abort()
    this.fullRead = null
    this.pointRead = null
    this.pointDrainScheduled = false
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

function sameMessageIds(left: readonly MessageId[], right: readonly MessageId[]): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

function sameFence(left: WorkspaceFence, right: WorkspaceFence): boolean {
  return left.workspaceId === right.workspaceId && left.replacementEpoch === right.replacementEpoch
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError'
  )
}
