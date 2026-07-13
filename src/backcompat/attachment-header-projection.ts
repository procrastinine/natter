import type { Transaction } from 'dexie'
import type { Attachment, AttachmentArtifact } from '../core/types'
import type { AttachmentHeaderRow } from '../store/attachment-storage'
import { splitAttachmentForStorage } from '../store/attachment-storage'
import { forEachTableBatch } from './batched-table'

type LegacyAttachmentRow = Attachment | AttachmentHeaderRow

export async function migrateAttachmentHeaderProjection(tx: Transaction): Promise<void> {
  const attachments = tx.table<LegacyAttachmentRow, string>('attachments')
  const artifacts = tx.table<AttachmentArtifact, string>('attachmentArtifacts')
  await forEachTableBatch(attachments, async (rows) => {
    const artifactRows = rows.flatMap((row) =>
      'artifacts' in row && Array.isArray(row.artifacts) ? row.artifacts : [],
    )
    if (artifactRows.length > 0) await artifacts.bulkPut(artifactRows)
    await attachments.bulkPut(
      rows.map((row) => {
        if ('artifacts' in row && Array.isArray(row.artifacts)) {
          return splitAttachmentForStorage(row)
        }
        return structuredClone(row)
      }),
    )
  })
}
