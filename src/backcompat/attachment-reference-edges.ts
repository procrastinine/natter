import type { Transaction } from 'dexie'
import type {
  Attachment,
  AttachmentArtifact,
  AttachmentBlob,
  AttachmentJob,
  AttachmentReferenceEdge,
  DraftRow,
  MessageAttachmentRef,
} from '../core/types'
import type { MessageHeaderRow } from '../store/message-storage'
import { forEachTableBatch } from './batched-table'

export type AttachmentReferenceEdgeMigrationErrorCode = 'duplicate-ref-id' | 'missing-attachment'

export class AttachmentReferenceEdgeMigrationError extends Error {
  override readonly name = 'AttachmentReferenceEdgeMigrationError'
  readonly code: AttachmentReferenceEdgeMigrationErrorCode
  readonly ownerKind: AttachmentReferenceEdge['ownerKind']
  readonly ownerId: string
  readonly refId: string
  readonly attachmentId: string

  constructor(
    code: AttachmentReferenceEdgeMigrationErrorCode,
    ownerKind: AttachmentReferenceEdge['ownerKind'],
    ownerId: string,
    refId: string,
    attachmentId: string,
  ) {
    super(
      code === 'duplicate-ref-id'
        ? `DuplicateAttachmentRefId:${ownerKind}:${ownerId}:${refId}`
        : `AttachmentReferenceTargetMissing:${ownerKind}:${ownerId}:${refId}:${attachmentId}`,
    )
    this.code = code
    this.ownerKind = ownerKind
    this.ownerId = ownerId
    this.refId = refId
    this.attachmentId = attachmentId
  }
}

export async function rebuildAttachmentReferenceEdges(tx: Transaction): Promise<void> {
  const attachments = tx.table<Attachment, string>('attachments')
  const edges = tx.table<
    AttachmentReferenceEdge,
    [AttachmentReferenceEdge['ownerKind'], string, string]
  >('attachmentRefEdges')
  const attachmentIds = new Set<string>()
  const refCounts = new Map<string, number>()
  await forEachTableBatch(attachments, (rows) => {
    for (const attachment of rows) attachmentIds.add(attachment.id)
  })

  await edges.clear()
  await forEachTableBatch(tx.table<MessageHeaderRow, string>('messages'), async (rows) => {
    const rebuilt: AttachmentReferenceEdge[] = []
    for (const message of rows) {
      collectOwnerEdges(
        rebuilt,
        refCounts,
        attachmentIds,
        'message',
        message.id,
        message.chatId,
        message.attachmentRefs,
      )
    }
    if (rebuilt.length > 0) await edges.bulkAdd(rebuilt)
  })
  await forEachTableBatch(tx.table<DraftRow, string>('drafts'), async (rows) => {
    const rebuilt: AttachmentReferenceEdge[] = []
    for (const draft of rows) {
      collectOwnerEdges(
        rebuilt,
        refCounts,
        attachmentIds,
        'draft',
        draft.chatId,
        draft.chatId,
        draft.attachmentRefs,
      )
    }
    if (rebuilt.length > 0) await edges.bulkAdd(rebuilt)
  })
  await attachments.toCollection().modify((attachment) => {
    attachment.refCount = refCounts.get(attachment.id) ?? 0
  })
}

export async function scrubMissingAttachmentByteReferences(tx: Transaction): Promise<void> {
  const attachments = tx.table<
    Omit<Attachment, 'storage'> & { storage?: Attachment['storage'] },
    string
  >('attachments')
  const blobs = tx.table<AttachmentBlob, string>('attachmentBlobs')
  const artifacts = tx.table<AttachmentArtifact, string>('attachmentArtifacts')
  const jobs = tx.table<AttachmentJob, string>('attachmentJobs')
  await forEachTableBatch(attachments, async (rows) => {
    for (const attachment of rows) {
      if (attachment.storage?.kind !== 'missing') continue
      const attachmentArtifacts = await artifacts
        .where('attachmentId')
        .equals(attachment.id)
        .toArray()
      const retainedArtifacts = attachmentArtifacts.filter((artifact) => artifact.kind !== 'blob')
      const retainedIds = new Set(retainedArtifacts.map((artifact) => artifact.artifactId))
      const processing = attachment.processing.flatMap((state) => {
        const outputArtifactIds = state.outputArtifactIds.filter((id) => retainedIds.has(id))
        return state.outputArtifactIds.length > 0 && outputArtifactIds.length === 0
          ? []
          : [{ ...state, outputArtifactIds }]
      })

      await blobs.where('attachmentId').equals(attachment.id).delete()
      const removedArtifactIds = attachmentArtifacts
        .filter((artifact) => artifact.kind === 'blob')
        .map((artifact) => artifact.artifactId)
      if (removedArtifactIds.length > 0) await artifacts.bulkDelete(removedArtifactIds)
      for (const job of await jobs.where('attachmentId').equals(attachment.id).toArray()) {
        const outputArtifactIds = job.outputArtifactIds.filter((id) => retainedIds.has(id))
        if (job.outputArtifactIds.length > 0 && outputArtifactIds.length === 0) {
          await jobs.delete(job.id)
        } else if (
          outputArtifactIds.length !== job.outputArtifactIds.length ||
          outputArtifactIds.some((id, index) => id !== job.outputArtifactIds[index])
        ) {
          await jobs.put({ ...job, outputArtifactIds })
        }
      }

      const next: Attachment = {
        ...attachment,
        storage: attachment.storage,
        artifacts: retainedArtifacts,
        processing,
      }
      delete next.thumbnailBlobId
      await attachments.put(next)
    }
  })
}

function collectOwnerEdges(
  edges: AttachmentReferenceEdge[],
  refCounts: Map<string, number>,
  attachmentIds: ReadonlySet<string>,
  ownerKind: AttachmentReferenceEdge['ownerKind'],
  ownerId: string,
  chatId: string,
  refs: readonly MessageAttachmentRef[] | undefined,
): void {
  const refIds = new Set<string>()
  for (const [ordinal, ref] of (refs ?? []).entries()) {
    if (refIds.has(ref.refId)) {
      throw new AttachmentReferenceEdgeMigrationError(
        'duplicate-ref-id',
        ownerKind,
        ownerId,
        ref.refId,
        ref.attachmentId,
      )
    }
    refIds.add(ref.refId)
    if (ref.deletedAt !== undefined) continue
    if (!attachmentIds.has(ref.attachmentId)) {
      throw new AttachmentReferenceEdgeMigrationError(
        'missing-attachment',
        ownerKind,
        ownerId,
        ref.refId,
        ref.attachmentId,
      )
    }
    edges.push({
      ownerKind,
      ownerId,
      chatId,
      refId: ref.refId,
      attachmentId: ref.attachmentId,
      ordinal,
    })
    refCounts.set(ref.attachmentId, (refCounts.get(ref.attachmentId) ?? 0) + 1)
  }
}
