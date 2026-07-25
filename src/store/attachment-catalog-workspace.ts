import type { Attachment } from '../core/types'
import {
  disposeAttachmentObjectUrlWorkspace,
  reconcileAttachmentObjectUrlWorkspace,
} from './attachment-object-url'
import {
  type AttachmentProjectionController,
  createAttachmentProjectionController,
} from './attachment-projection-controller'
import type { AttachmentCatalogRow, WorkspaceFence } from './repository'
import type { WorkspaceEffect } from './workspace-effect-hub'
import { subscribeWorkspaceEffects, WORKSPACE_EFFECT_RECOVERY_OWNED } from './workspace-effect-hub'
import type { AttachmentMediaProjection, WorkspaceRepository } from './workspace-protocol'
import { getWorkspaceRepository } from './workspace-repository'
import { runWorkspaceRead } from './workspace-runtime'

export const attachmentCatalogController: AttachmentProjectionController<AttachmentCatalogRow> =
  createAttachmentProjectionController<AttachmentCatalogRow>()
export const attachmentContextController: AttachmentProjectionController<Attachment> =
  createAttachmentProjectionController<Attachment>()
export const attachmentPreviewMediaController: AttachmentProjectionController<AttachmentMediaProjection> =
  createAttachmentProjectionController<AttachmentMediaProjection>()
export const attachmentMessageMediaController: AttachmentProjectionController<AttachmentMediaProjection> =
  createAttachmentProjectionController<AttachmentMediaProjection>()

let adapter: AttachmentCatalogRepositoryAdapter | null = null

class AttachmentCatalogRepositoryAdapter {
  private readonly repository: WorkspaceRepository
  private unsubscribe: (() => void) | null = null

  constructor(repository: WorkspaceRepository) {
    this.repository = repository
  }

  attach(fence: WorkspaceFence): void {
    if (this.unsubscribe) return
    this.unsubscribe = subscribeWorkspaceEffects({
      owner: 'attachment-catalog-workspace',
      factKinds: ['attachment-row-changed', 'attachment-row-deleted'],
      impactKinds: ['workspace', 'attachment', 'attachment-job'],
      replacements: false,
      apply: (effect) => this.receiveEffect(effect),
      recover: (_error, effect) => {
        this.recoverEffect(effect)
        return WORKSPACE_EFFECT_RECOVERY_OWNED
      },
    })
    attachmentCatalogController.setSource({
      loadRows: (attachmentIds, signal) =>
        runWorkspaceRead(
          'repository-query',
          (permit) =>
            this.repository.query(
              permit,
              { kind: 'attachment.catalog-rows', attachmentIds },
              { signal: permit.signal },
            ),
          { signal },
        ).then((envelope) => ({ ...envelope, rows: envelope.value })),
    })
    attachmentContextController.setSource({
      loadRows: (attachmentIds, signal) =>
        runWorkspaceRead(
          'repository-query',
          (permit) =>
            this.repository.query(
              permit,
              { kind: 'attachment.get-many', attachmentIds },
              { signal: permit.signal },
            ),
          { signal },
        ).then((envelope) => ({ ...envelope, rows: envelope.value })),
    })
    attachmentPreviewMediaController.setSource({
      loadRows: (attachmentIds, signal) =>
        runWorkspaceRead(
          'repository-query',
          (permit) =>
            this.repository.query(
              permit,
              { kind: 'attachment.media-many', attachmentIds, purpose: 'preview' },
              { signal: permit.signal },
            ),
          { signal },
        ).then((envelope) => ({ ...envelope, rows: envelope.value })),
    })
    attachmentMessageMediaController.setSource({
      loadRows: (attachmentIds, signal) =>
        runWorkspaceRead(
          'repository-query',
          (permit) =>
            this.repository.query(
              permit,
              { kind: 'attachment.media-many', attachmentIds, purpose: 'message-output' },
              { signal: permit.signal },
            ),
          { signal },
        ).then((envelope) => ({ ...envelope, rows: envelope.value })),
    })
    attachmentCatalogController.reconcileWorkspace(fence)
    attachmentContextController.reconcileWorkspace(fence)
    attachmentPreviewMediaController.reconcileWorkspace(fence)
    attachmentMessageMediaController.reconcileWorkspace(fence)
  }

  dispose(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    attachmentCatalogController.setSource(null)
    attachmentContextController.setSource(null)
    attachmentPreviewMediaController.setSource(null)
    attachmentMessageMediaController.setSource(null)
  }

  private receiveEffect(effect: WorkspaceEffect): void {
    if (effect.kind === 'replace') {
      attachmentCatalogController.reconcileWorkspace(effect)
      attachmentContextController.reconcileWorkspace(effect)
      attachmentPreviewMediaController.reconcileWorkspace(effect)
      attachmentMessageMediaController.reconcileWorkspace(effect)
      return
    }
    attachmentCatalogController.observeWorkspaceEffect(effect)
    attachmentContextController.observeWorkspaceEffect(effect)
    attachmentPreviewMediaController.observeWorkspaceEffect(effect)
    attachmentMessageMediaController.observeWorkspaceEffect(effect)
  }

  private recoverEffect(effect: WorkspaceEffect): void {
    attachmentCatalogController.recoverWorkspace(effect)
    attachmentContextController.recoverWorkspace(effect)
    attachmentPreviewMediaController.recoverWorkspace(effect)
    attachmentMessageMediaController.recoverWorkspace(effect)
  }
}

export function attachAttachmentCatalogWorkspace(fence: WorkspaceFence): void {
  if (adapter) return
  const current = new AttachmentCatalogRepositoryAdapter(getWorkspaceRepository())
  adapter = current
  try {
    current.attach(fence)
  } catch (error) {
    if (adapter === current) adapter = null
    current.dispose()
    throw error
  }
}

export function reconcileAttachmentCatalogWorkspace(fence: WorkspaceFence): void {
  reconcileAttachmentObjectUrlWorkspace(fence)
}

export function suspendAttachmentCatalogWorkspace(): void {
  const current = adapter
  adapter = null
  current?.dispose()
}

export function disposeAttachmentCatalogWorkspace(): void {
  suspendAttachmentCatalogWorkspace()
  attachmentCatalogController.dispose()
  attachmentContextController.dispose()
  attachmentPreviewMediaController.dispose()
  attachmentMessageMediaController.dispose()
  disposeAttachmentObjectUrlWorkspace()
}

export function assertAttachmentCatalogWorkspaceClosed(): void {
  if (adapter) throw new Error('AttachmentCatalogWorkspaceNotClosed')
}
