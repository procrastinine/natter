import type { AttachmentId, ChatId } from '../core/types'
import {
  type MountedProjectionLifecycle,
  type MountedProjectionReconcileEvent,
  mountRepositoryProjection,
} from './mounted-projection-lifecycle'
import type { WorkspaceFence } from './repository'
import type { WorkspaceEffect } from './workspace-effect-hub'
import { subscribeWorkspaceEffects, WORKSPACE_EFFECT_RECOVERY_OWNED } from './workspace-effect-hub'
import type {
  AttachmentManagerDetail,
  ReadEnvelope,
  WorkspaceRepository,
} from './workspace-protocol'
import { getWorkspaceRepository } from './workspace-repository'
import { runWorkspaceRead } from './workspace-runtime'

type AttachmentDetailStatus = 'idle' | 'loading' | 'ready' | 'refreshing' | 'error'

export interface AttachmentDetailSnapshot extends WorkspaceFence {
  readonly revision: number
  readonly attachmentId: AttachmentId
  readonly status: AttachmentDetailStatus
  readonly detail: AttachmentManagerDetail | undefined
  readonly interactive: boolean
  readonly error: unknown
}

export interface AttachmentDetailSource {
  readDetail(
    attachmentId: AttachmentId,
    signal: AbortSignal,
  ): Promise<ReadEnvelope<AttachmentManagerDetail | undefined>>
  subscribeEffects(
    apply: (effect: WorkspaceEffect) => void,
    recover: (effect: WorkspaceEffect) => void,
  ): () => void
}

export interface AttachmentDetailController {
  readonly subscribe: (listener: () => void) => () => void
  readonly getSnapshot: () => AttachmentDetailSnapshot | null
  request(fence: WorkspaceFence, attachmentId: AttachmentId | null): void
  refresh(): void
  dispose(): void
}

interface ActiveDetail {
  readonly fence: WorkspaceFence
  readonly attachmentId: AttachmentId
  readonly generation: number
}

function createWorkspaceAttachmentDetailSource(
  repository?: WorkspaceRepository,
): AttachmentDetailSource {
  const currentRepository = () => repository ?? getWorkspaceRepository()
  return {
    readDetail: (attachmentId, signal) =>
      runWorkspaceRead(
        'repository-query',
        (permit) =>
          currentRepository().query(
            permit,
            { kind: 'attachment.manager-detail', attachmentId },
            { signal: permit.signal },
          ),
        { signal },
      ),
    subscribeEffects: (apply, recover) =>
      subscribeWorkspaceEffects({
        owner: 'attachment-detail-session',
        factKinds: ['attachment-row-changed', 'attachment-row-deleted'],
        impactKinds: ['attachment', 'attachment-job', 'chat'],
        replacements: false,
        apply,
        recover: (_error, effect) => {
          recover(effect)
          return WORKSPACE_EFFECT_RECOVERY_OWNED
        },
      }),
  }
}

export function createAttachmentDetailController(
  source: AttachmentDetailSource = createWorkspaceAttachmentDetailSource(),
): AttachmentDetailController {
  return new TabAttachmentDetailController(source)
}

class TabAttachmentDetailController implements AttachmentDetailController {
  private readonly source: AttachmentDetailSource
  private readonly listeners = new Set<() => void>()
  private stopChanges: (() => void) | null = null
  private readonly lifecycle: MountedProjectionLifecycle
  private snapshot: AttachmentDetailSnapshot | null = null
  private active: ActiveDetail | null = null
  private read: { generation: number; controller: AbortController } | null = null
  private generation = 0
  private revision = 0
  private refreshQueued = false
  private resumeReadPending = false
  private disposed = false

  constructor(source: AttachmentDetailSource) {
    this.source = source
    this.lifecycle = mountRepositoryProjection({
      suspend: () => {
        this.detachChangefeed()
        this.suspendForRuntime()
      },
      reconcile: (event) => {
        this.detachChangefeed()
        this.reconcileRuntime(event)
      },
      resume: (event) => {
        this.attachChangefeed()
        this.resumeRuntime(event)
      },
      dispose: () => this.disposeOwner(),
    })
    if (this.lifecycle.isOpen()) this.attachChangefeed()
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return () => undefined
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  readonly getSnapshot = (): AttachmentDetailSnapshot | null => this.snapshot

  request(fence: WorkspaceFence, attachmentId: AttachmentId | null): void {
    if (this.disposed) throw new Error('AttachmentDetailControllerDisposed')
    if (!attachmentId) {
      this.generation += 1
      this.abortRead()
      this.active = null
      this.snapshot = null
      this.emit()
      return
    }
    if (this.active?.attachmentId === attachmentId && sameFence(this.active.fence, fence)) {
      return
    }
    const prior = sameFence(this.snapshot, fence) ? this.snapshot?.detail : undefined
    this.abortRead()
    const active: ActiveDetail = {
      fence: Object.freeze({ ...fence }),
      attachmentId,
      generation: ++this.generation,
    }
    this.active = active
    this.publish({
      ...fence,
      revision: ++this.revision,
      attachmentId,
      status: 'loading',
      detail: prior,
      interactive: false,
      error: null,
    })
    this.startRead(active, false)
  }

  refresh(): void {
    const active = this.active
    if (!active) return
    if (this.read) {
      this.refreshQueued = true
      return
    }
    this.refreshQueued = false
    this.startRead(active, true)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposeOwner()
    this.lifecycle.dispose()
  }

  private disposeOwner(): void {
    if (this.disposed) return
    this.disposed = true
    this.abortRead()
    this.detachChangefeed()
    this.active = null
    this.snapshot = null
    this.listeners.clear()
  }

  private startRead(active: ActiveDetail, refresh: boolean): void {
    if (this.disposed || this.active !== active || this.read) return
    if (!this.lifecycle.isOpen()) {
      this.resumeReadPending = true
      return
    }
    const controller = new AbortController()
    const read = { generation: active.generation, controller }
    this.read = read
    const current = this.snapshot
    if (current) {
      this.publish({
        ...current,
        revision: ++this.revision,
        status: refresh ? 'refreshing' : 'loading',
        interactive: false,
        error: null,
      })
    }
    let promise: Promise<ReadEnvelope<AttachmentManagerDetail | undefined>>
    try {
      promise = this.lifecycle.track(this.source.readDetail(active.attachmentId, controller.signal))
    } catch (error) {
      this.settleRead(active, read, undefined, error)
      return
    }
    void promise.then(
      (envelope) => this.settleRead(active, read, envelope),
      (error: unknown) => this.settleRead(active, read, undefined, error),
    )
  }

  private settleRead(
    active: ActiveDetail,
    read: { generation: number; controller: AbortController },
    envelope?: ReadEnvelope<AttachmentManagerDetail | undefined>,
    error?: unknown,
  ): void {
    if (this.read === read) this.read = null
    if (
      this.disposed ||
      this.active !== active ||
      read.generation !== active.generation ||
      read.controller.signal.aborted
    ) {
      return
    }
    if (envelope && !sameFence(envelope, active.fence)) {
      this.request(envelope, active.attachmentId)
      return
    }
    if (error !== undefined || !envelope) {
      if (!isAbortError(error)) {
        const current = this.snapshot
        if (current) {
          this.publish({
            ...current,
            revision: ++this.revision,
            status: 'error',
            interactive: false,
            error: error ?? new Error('AttachmentDetailReadFailed'),
          })
        }
      }
      this.afterRead()
      return
    }
    this.publish({
      workspaceId: envelope.workspaceId,
      replacementEpoch: envelope.replacementEpoch,
      revision: ++this.revision,
      attachmentId: active.attachmentId,
      status: 'ready',
      detail: envelope.value ? cloneDetail(envelope.value) : undefined,
      interactive: true,
      error: null,
    })
    this.afterRead()
  }

  private afterRead(): void {
    if (!this.refreshQueued) return
    this.refreshQueued = false
    this.refresh()
  }

  private receiveEffect(effect: WorkspaceEffect): void {
    const active = this.active
    if (this.disposed || !active) return
    if (effect.kind === 'replace' || !sameFence(effect, active.fence)) return
    if (detailEffectMatters(effect, active.attachmentId, this.snapshot?.detail)) this.refresh()
  }

  private recoverEffect(effect: WorkspaceEffect): void {
    const active = this.active
    if (this.disposed || !active || !sameFence(effect, active.fence)) return
    this.abortRead()
    const current = this.snapshot
    if (current) {
      this.publish({
        ...current,
        revision: ++this.revision,
        status: current.detail ? 'refreshing' : 'loading',
        interactive: current.detail !== undefined,
        error: null,
      })
    }
    this.startRead(active, current?.detail !== undefined)
  }

  private suspendForRuntime(): void {
    if (this.disposed) return
    this.resumeReadPending = this.active !== null
    this.abortRead()
    const current = this.snapshot
    if (!current) return
    this.publish({
      ...current,
      revision: ++this.revision,
      status: current.detail ? 'refreshing' : 'loading',
      interactive: false,
      error: null,
    })
  }

  private reconcileRuntime(event: MountedProjectionReconcileEvent): void {
    const active = this.active
    if (this.disposed || !active) return
    this.resumeReadPending = true
    if (!sameFence(active.fence, event.fence)) this.request(event.fence, active.attachmentId)
  }

  private resumeRuntime(event: MountedProjectionReconcileEvent): void {
    if (this.disposed) return
    const active = this.active
    if (active && !sameFence(active.fence, event.fence)) {
      this.request(event.fence, active.attachmentId)
    }
    if (!this.active || !this.resumeReadPending) return
    this.resumeReadPending = false
    this.startRead(this.active, this.snapshot?.detail !== undefined)
  }

  private abortRead(): void {
    this.read?.controller.abort()
    this.read = null
    this.refreshQueued = false
  }

  private attachChangefeed(): void {
    if (this.disposed || this.stopChanges) return
    this.stopChanges = this.source.subscribeEffects(
      (effect) => this.receiveEffect(effect),
      (effect) => this.recoverEffect(effect),
    )
  }

  private detachChangefeed(): void {
    this.stopChanges?.()
    this.stopChanges = null
  }

  private publish(snapshot: AttachmentDetailSnapshot): void {
    this.snapshot = Object.freeze(snapshot)
    this.emit()
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

function detailEffectMatters(
  effect: WorkspaceEffect,
  attachmentId: AttachmentId,
  detail: AttachmentManagerDetail | undefined,
): boolean {
  if (effect.kind === 'replace' || effect.impactByKind === 'all') return true
  for (const fact of [
    ...(effect.factsByKind['attachment-row-changed'] ?? []),
    ...(effect.factsByKind['attachment-row-deleted'] ?? []),
  ]) {
    if (fact.attachmentId === attachmentId) return true
  }
  if ((effect.impactByKind.workspace?.length ?? 0) > 0) return true
  for (const dependency of [
    ...(effect.impactByKind.attachment ?? []),
    ...(effect.impactByKind['attachment-job'] ?? []),
  ]) {
    if (!dependency.attachmentIds || dependency.attachmentIds.includes(attachmentId)) return true
  }
  for (const dependency of effect.impactByKind.chat ?? []) {
    if (
      !dependency.chatIds ||
      referencesAnyChat(detail?.references, new Set<ChatId>(dependency.chatIds))
    ) {
      return true
    }
  }
  return false
}

function referencesAnyChat(
  references: readonly { chatId: ChatId }[] | undefined,
  chatIds: ReadonlySet<ChatId>,
): boolean {
  return references?.some((reference) => chatIds.has(reference.chatId)) ?? false
}

function cloneDetail(detail: AttachmentManagerDetail): AttachmentManagerDetail {
  return {
    row: {
      ...detail.row,
      storage: structuredClone(detail.row.storage),
      ...(detail.row.dimensions ? { dimensions: { ...detail.row.dimensions } } : {}),
      processing: detail.row.processing.map((state) => ({ ...state })),
    },
    artifacts: detail.artifacts.map((artifact) => ({ ...artifact })),
    jobs: detail.jobs.map((job) => ({
      ...job,
      ...(job.error ? { error: { ...job.error } } : {}),
      outputArtifactIds: [...job.outputArtifactIds],
    })),
    references: detail.references.map((reference) => ({
      ...reference,
      ref: { ...reference.ref },
    })),
  }
}

function sameFence(
  left: WorkspaceFence | null | undefined,
  right: WorkspaceFence | null | undefined,
): boolean {
  return (
    left !== null &&
    left !== undefined &&
    right !== null &&
    right !== undefined &&
    left.workspaceId === right.workspaceId &&
    left.replacementEpoch === right.replacementEpoch
  )
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : (error as { name?: string } | null)?.name === 'AbortError'
}
