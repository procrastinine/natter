import type { ChatId } from '../core/types'
import { attemptController } from './attempt-controller'
import type { StreamLeaseRow, WorkspaceFence } from './repository'
import { observeStreamOwnershipLock } from './stream-leases'
import type { WorkspaceEffect } from './workspace-effect-hub'
import { subscribeWorkspaceEffects, WORKSPACE_EFFECT_RECOVERY_OWNED } from './workspace-effect-hub'
import type { ReadEnvelope, WorkspaceDependency, WorkspaceRepository } from './workspace-protocol'
import { getWorkspaceRepository } from './workspace-repository'
import { runWorkspaceRead } from './workspace-runtime'

class AttemptWorkspaceProjection {
  private readonly repository: WorkspaceRepository
  private readonly abortController = new AbortController()
  private unsubscribe: (() => void) | null = null
  private unsubscribeDemand: (() => void) | null = null
  private reloadPromise: Promise<void> | null = null
  private reloadAllRequested = false
  private readonly pendingChatIds = new Set<ChatId>()
  private readonly pendingStreamIds = new Set<string>()
  private readonly lockProbes = new Map<string, Promise<void>>()
  private demandedChatIds = new Set<ChatId>()
  private attached = false
  private disposed = false
  private workspaceId: string | null = null
  private replacementEpoch: number | null = null
  private workspaceRevision = 0

  constructor(repository: WorkspaceRepository) {
    this.repository = repository
  }

  attach(): void {
    if (this.disposed) throw new Error('AttemptWorkspaceProjectionDisposed')
    if (this.attached) return
    this.attached = true
    this.unsubscribe = subscribeWorkspaceEffects({
      owner: 'attempt-workspace',
      sources: ['remote'],
      factKinds: ['attempt-target-committed'],
      impactKinds: ['workspace', 'stream-lease'],
      replacements: false,
      apply: (effect) => this.receive(effect),
      recover: (_error, effect) => {
        this.recover(effect)
        return WORKSPACE_EFFECT_RECOVERY_OWNED
      },
    })
    this.unsubscribeDemand = attemptController.subscribeDemand(() => this.receiveDemand())
    this.demandedChatIds = new Set(attemptController.demandedChatIds())
    attemptController.pruneUndemandedRemoteAttempts(this.demandedChatIds)
  }

  start(): Promise<void> {
    this.attach()
    return this.requestFullReload()
  }

  reconcileWorkspace(fence: WorkspaceFence): void {
    this.replaceWorkspace(fence)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.attached = false
    this.abortController.abort()
    this.unsubscribe?.()
    this.unsubscribe = null
    this.unsubscribeDemand?.()
    this.unsubscribeDemand = null
    this.reloadAllRequested = false
    this.pendingChatIds.clear()
    this.pendingStreamIds.clear()
    this.lockProbes.clear()
    this.demandedChatIds.clear()
  }

  awaitIdle(): Promise<void> {
    return Promise.all([
      this.reloadPromise?.catch(() => {}) ?? Promise.resolve(),
      ...this.lockProbes.values(),
    ]).then(() => undefined)
  }

  private requestFullReload(): Promise<void> {
    this.reloadAllRequested = true
    this.pendingChatIds.clear()
    return this.ensureReload()
  }

  private requestChatReload(chatIds: readonly ChatId[]): Promise<void> {
    if (!this.reloadAllRequested) {
      for (const chatId of chatIds) this.pendingChatIds.add(chatId)
    }
    return this.ensureReload()
  }

  private requestPointReload(streamIds: readonly string[]): Promise<void> {
    for (const streamId of streamIds) this.pendingStreamIds.add(streamId)
    return this.ensureReload()
  }

  private ensureReload(): Promise<void> {
    if (this.reloadPromise) return this.reloadPromise
    const reloading = this.drainReloads()
    this.reloadPromise = reloading
    const clear = () => {
      if (this.reloadPromise === reloading) this.reloadPromise = null
      if (
        !this.disposed &&
        (this.reloadAllRequested || this.pendingChatIds.size > 0 || this.pendingStreamIds.size > 0)
      ) {
        void this.ensureReload().catch(() => {})
      }
    }
    void reloading.then(clear, clear)
    return reloading
  }

  private async drainReloads(): Promise<void> {
    while (
      (this.reloadAllRequested || this.pendingChatIds.size > 0 || this.pendingStreamIds.size > 0) &&
      !this.disposed
    ) {
      const reloadAll = this.reloadAllRequested
      this.reloadAllRequested = false
      const chatIds = reloadAll
        ? [...this.demandedChatIds]
        : [...this.pendingChatIds].filter((chatId) => this.demandedChatIds.has(chatId))
      this.pendingChatIds.clear()
      if (chatIds.length > 0) {
        for (const chatId of chatIds) {
          let readRevision = this.workspaceRevision
          const envelope = await runWorkspaceRead(
            'repository-query',
            (permit) => {
              this.replaceWorkspace(permit)
              readRevision = this.workspaceRevision
              return this.repository.query(
                permit,
                { kind: 'stream.leases', chatId },
                { signal: permit.signal },
              )
            },
            { signal: this.abortController.signal },
          )
          if (this.isDisposed()) return
          if (readRevision !== this.workspaceRevision) continue
          this.applyChatSnapshot(chatId, envelope)
        }
      }
      const streamIds = [...this.pendingStreamIds]
      this.pendingStreamIds.clear()
      if (streamIds.length > 0) {
        let readRevision = this.workspaceRevision
        const envelope = await runWorkspaceRead(
          'repository-query',
          (permit) => {
            this.replaceWorkspace(permit)
            readRevision = this.workspaceRevision
            return this.repository.query(
              permit,
              { kind: 'stream.leases-by-id', streamIds },
              { signal: permit.signal },
            )
          },
          { signal: this.abortController.signal },
        )
        if (this.isDisposed()) return
        if (readRevision !== this.workspaceRevision) continue
        this.applyPoints(streamIds, envelope)
      }
    }
  }

  private receiveDemand(): void {
    if (this.disposed) return
    const next = new Set(attemptController.demandedChatIds())
    const added = [...next].filter((chatId) => !this.demandedChatIds.has(chatId))
    this.demandedChatIds = next
    attemptController.pruneUndemandedRemoteAttempts(next)
    if (added.length > 0) void this.requestChatReload(added).catch(() => {})
  }

  private isDisposed(): boolean {
    return this.disposed
  }

  private receive(change: WorkspaceEffect): void {
    if (this.disposed) return
    this.applyChange(change)
  }

  private applyChatSnapshot(chatId: ChatId, envelope: ReadEnvelope<StreamLeaseRow[]>): void {
    if (!this.demandedChatIds.has(chatId)) return
    if (
      this.workspaceId === envelope.workspaceId &&
      this.replacementEpoch !== null &&
      envelope.replacementEpoch < this.replacementEpoch
    ) {
      return
    }
    if (
      this.workspaceId !== envelope.workspaceId ||
      this.replacementEpoch !== envelope.replacementEpoch
    ) {
      this.replaceWorkspace(envelope)
    }
    attemptController.reconcileChatLeases(envelope, chatId, envelope.value)
    this.scheduleLockProbes(envelope, envelope.value)
  }

  private applyPoints(
    streamIds: readonly string[],
    envelope: ReadEnvelope<Array<StreamLeaseRow | undefined>>,
  ): void {
    if (
      this.workspaceId === envelope.workspaceId &&
      this.replacementEpoch !== null &&
      envelope.replacementEpoch < this.replacementEpoch
    ) {
      return
    }
    if (
      this.workspaceId !== envelope.workspaceId ||
      this.replacementEpoch !== envelope.replacementEpoch
    ) {
      this.replaceWorkspace(envelope)
      void this.requestFullReload().catch(() => {})
      return
    }
    let filtered: Array<StreamLeaseRow | undefined> | undefined
    for (let index = 0; index < envelope.value.length; index += 1) {
      const lease = envelope.value[index]
      if (!lease || this.demandedChatIds.has(lease.chatId)) continue
      const streamId = streamIds[index]
      const availability = streamId
        ? attemptController.getExecution(streamId)?.availability
        : undefined
      if (
        availability?.state === 'reserved' ||
        availability?.state === 'local-executing' ||
        (availability?.state === 'terminalizing' && availability.recovery.kind === 'none')
      ) {
        continue
      }
      filtered ??= [...envelope.value]
      filtered[index] = undefined
    }
    const relevant = filtered ?? envelope.value
    attemptController.reconcileLeasePoints(envelope, streamIds, relevant)
    this.scheduleLockProbes(envelope, relevant)
  }

  private scheduleLockProbes(
    fence: WorkspaceFence,
    leases: readonly (StreamLeaseRow | undefined)[],
  ): void {
    for (const lease of leases) {
      if (!lease || lease.replacementEpoch !== fence.replacementEpoch) continue
      const current = attemptController.getExecution(lease.streamId)
      if (!current || current.leaseRevision !== lease.revision) continue
      if (
        current.availability.state === 'reserved' ||
        current.availability.state === 'local-executing' ||
        (current.availability.state === 'terminalizing' &&
          current.availability.recovery.kind === 'none')
      ) {
        continue
      }
      if (this.lockProbes.has(lease.streamId)) continue
      const probe = observeStreamOwnershipLock(lease.streamId)
        .then((ownershipLock) => {
          if (this.disposed) return
          const latest = attemptController.getExecution(lease.streamId)
          if (
            !latest ||
            latest.workspaceId !== fence.workspaceId ||
            latest.replacementEpoch !== fence.replacementEpoch ||
            latest.admissionSequence !== lease.admissionSequence ||
            latest.leaseRevision !== lease.revision
          ) {
            return
          }
          attemptController.observeLease(lease, {
            workspaceId: fence.workspaceId,
            ownershipLock,
          })
        })
        .catch(() => undefined)
        .finally(() => {
          if (this.lockProbes.get(lease.streamId) === probe) {
            this.lockProbes.delete(lease.streamId)
          }
        })
      this.lockProbes.set(lease.streamId, probe)
    }
  }

  private applyChange(change: WorkspaceEffect): void {
    const stamp = change
    if (
      this.workspaceId === stamp.workspaceId &&
      this.replacementEpoch !== null &&
      stamp.replacementEpoch < this.replacementEpoch
    ) {
      return
    }
    const workspaceChanged =
      this.workspaceId !== stamp.workspaceId || this.replacementEpoch !== stamp.replacementEpoch
    if (workspaceChanged) {
      this.replaceWorkspace(stamp)
      void this.requestFullReload().catch(() => {})
    }
    if (change.kind === 'replace') {
      void this.requestFullReload().catch(() => {})
      return
    }
    for (const fact of change.factsByKind['attempt-target-committed'] ?? []) {
      attemptController.registerTargetCommitHandoff(
        Object.freeze({
          ...fact,
          workspaceId: change.workspaceId,
          replacementEpoch: change.replacementEpoch,
        }),
      )
    }
    this.applyInvalidations(change.impact)
  }

  private recover(effect: WorkspaceEffect): void {
    this.replaceWorkspace(effect)
    void this.requestFullReload().catch(() => {})
    void this.requestPointReload(
      attemptController.listExecutions().map((attempt) => attempt.streamId),
    ).catch(() => {})
  }

  private applyInvalidations(dependencies: readonly WorkspaceDependency[] | 'all'): void {
    if (dependencies === 'all') {
      void this.requestFullReload().catch(() => {})
      void this.requestPointReload(
        attemptController.listExecutions().map((attempt) => attempt.streamId),
      ).catch(() => {})
      return
    }
    let pointReloadRequested = false
    for (const dependency of dependencies) {
      if (dependency.kind === 'workspace') {
        void this.requestFullReload().catch(() => {})
        void this.requestPointReload(
          attemptController.listExecutions().map((attempt) => attempt.streamId),
        ).catch(() => {})
        return
      }
      if (dependency.kind !== 'stream-lease') continue
      if (!dependency.streamIds) {
        void this.requestFullReload().catch(() => {})
        void this.requestPointReload(
          attemptController.listExecutions().map((attempt) => attempt.streamId),
        ).catch(() => {})
        return
      }
      const chatDemanded = dependency.chatId
        ? this.demandedChatIds.has(dependency.chatId)
        : this.demandedChatIds.size > 0
      for (const streamId of dependency.streamIds) {
        if (chatDemanded || attemptController.get(streamId)) {
          this.pendingStreamIds.add(streamId)
          pointReloadRequested = true
        }
      }
    }
    if (pointReloadRequested) void this.ensureReload().catch(() => {})
  }

  private replaceWorkspace(fence: WorkspaceFence): void {
    if (
      this.workspaceId === fence.workspaceId &&
      this.replacementEpoch === fence.replacementEpoch
    ) {
      return
    }
    this.workspaceId = fence.workspaceId
    this.replacementEpoch = fence.replacementEpoch
    this.workspaceRevision += 1
    attemptController.replaceWorkspace(fence)
  }
}

let projection: AttemptWorkspaceProjection | null = null
let startPromise: Promise<void> | null = null
let idlePromise: Promise<void> = Promise.resolve()

export function attachAttemptWorkspace(fence: WorkspaceFence): void {
  if (projection) return
  const current = new AttemptWorkspaceProjection(getWorkspaceRepository())
  projection = current
  try {
    current.reconcileWorkspace(fence)
    current.attach()
  } catch (error) {
    if (projection === current) projection = null
    current.dispose()
    throw error
  }
}

export function startAttemptWorkspace(fence: WorkspaceFence, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(attemptWorkspaceError(signal.reason))
  if (startPromise) return startPromise
  attachAttemptWorkspace(fence)
  const current = projection as AttemptWorkspaceProjection
  const starting = current.start()
  startPromise = starting
  idlePromise = starting.catch(() => {})
  void starting.catch(() => {
    if (projection === current) projection = null
    if (startPromise === starting) startPromise = null
    current.dispose()
  })
  signal?.addEventListener('abort', () => current.dispose(), { once: true })
  return starting
}

function attemptWorkspaceError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error('AttemptWorkspaceAborted', { cause: reason })
}

export function disposeAttemptWorkspace(): void {
  const current = projection
  projection = null
  startPromise = null
  if (!current) return
  current.dispose()
  idlePromise = current.awaitIdle()
}

export function awaitAttemptWorkspaceIdle(): Promise<void> {
  return projection?.awaitIdle() ?? idlePromise
}

export function assertAttemptWorkspaceClosed(): void {
  if (projection || startPromise) throw new Error('AttemptWorkspaceNotClosed')
}
