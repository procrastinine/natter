import type { Table, Transaction } from 'dexie'
import type { AttachmentBlob, DraftRow, MessageAttachmentRef } from '../core/types'
import type { SettingsRow } from '../store/db-rows'
import type { MessageHeaderRow } from '../store/message-storage'
import { forEachTableBatch } from './batched-table'

const ATTACHMENT_REFS_BACKFILL_KEY = 'backfill:attachment-refs-v1'

export function attachmentRefsBackfillMarker(): SettingsRow {
  return { key: ATTACHMENT_REFS_BACKFILL_KEY, value: 1 }
}

export async function normalizeAttachmentRefOwners(tx: Transaction): Promise<void> {
  await tx
    .table<MessageHeaderRow>('messages')
    .toCollection()
    .modify((row) => {
      const refs = normalizeLegacyAttachmentRefs(row.attachmentRefs, {
        messageId: String(row.id),
        createdAt: numberOr(row.createdAt, 0),
      })
      if (refs !== undefined) row.attachmentRefs = refs
    })
  await tx
    .table<DraftRow>('drafts')
    .toCollection()
    .modify((row) => {
      const refs = normalizeLegacyAttachmentRefs(row.attachmentRefs, {
        draftChatId: String(row.chatId),
        createdAt: numberOr(row.updatedAt, 0),
      })
      if (refs !== undefined) row.attachmentRefs = refs
    })
}

export async function migrateLegacyAttachmentStorage(tx: Transaction): Promise<void> {
  const now = Date.now()
  const attachments = tx.table<Record<string, unknown>, string>('attachments')
  const blobs = tx.table<AttachmentBlob, string>('attachmentBlobs')
  await forEachTableBatch(attachments, async (rows) => {
    const blobIds = new Set<string>()
    const candidates: Array<{ id: string; row: AttachmentBlob }> = []
    for (const row of rows) {
      const id = String(row.id)
      const blob = legacyBlob(row.blob)
      const blobId = storageBlobId(row.storage) ?? (blob ? `${id}:original` : undefined)
      const contentHash = typeof row.contentHash === 'string' ? row.contentHash : undefined
      if (!blob || !blobId || !contentHash || blobIds.has(blobId)) continue
      blobIds.add(blobId)
      const createdAt = numberOr(row.createdAt, now)
      candidates.push({
        id: blobId,
        row: {
          id: blobId,
          attachmentId: id,
          role: 'original',
          mime: typeof row.mime === 'string' ? row.mime : 'application/octet-stream',
          contentHash,
          sizeBytes: typeof row.sizeBytes === 'number' ? row.sizeBytes : blob.size,
          blob,
          createdAt,
        },
      })
    }
    const existing = await blobs.bulkGet(candidates.map((candidate) => candidate.id))
    const missing = candidates.flatMap((candidate, index) =>
      existing[index] ? [] : [candidate.row],
    )
    if (missing.length > 0) await blobs.bulkPut(missing)

    const migrated = rows.map((source) => {
      const row = { ...source }
      const id = String(row.id)
      const createdAt = numberOr(row.createdAt, now)
      const updatedAt = numberOr(row.updatedAt, createdAt)
      const blob = legacyBlob(row.blob)
      const blobId = storageBlobId(row.storage) ?? (blob ? `${id}:original` : undefined)
      delete row.blob
      delete row.thumbnailB64
      row.kind = row.kind === 'file' ? 'other' : (row.kind ?? 'other')
      row.origin = row.origin ?? 'import'
      row.createdAt = createdAt
      row.updatedAt = updatedAt
      row.extension = row.extension ?? extensionFromFilename(row.filename)
      row.sizeBytes = row.sizeBytes ?? blob?.size
      row.artifacts = Array.isArray(row.artifacts) ? row.artifacts : []
      row.processing = Array.isArray(row.processing) ? row.processing : []
      row.storage =
        row.storage ??
        (blobId
          ? { kind: 'local-blob', blobId }
          : { kind: 'missing', reason: 'import-missing', missingSince: now })
      row.refCount = 0
      return row
    })
    await attachments.bulkPut(migrated)
  })

  await normalizeLegacyOwnerRefsAndCounts(
    tx.table<Record<string, unknown>, string>('messages'),
    attachments,
    (row) => ({ messageId: String(row.id), createdAt: numberOr(row.createdAt, now) }),
  )
  await normalizeLegacyOwnerRefsAndCounts(
    tx.table<Record<string, unknown>, string>('drafts'),
    attachments,
    (row) => ({ draftChatId: String(row.chatId), createdAt: numberOr(row.updatedAt, now) }),
  )
}

async function normalizeLegacyOwnerRefsAndCounts(
  owners: Table<Record<string, unknown>, string>,
  attachments: Table<Record<string, unknown>, string>,
  ownerFor: (row: Record<string, unknown>) => {
    messageId?: string
    draftChatId?: string
    createdAt: number
  },
): Promise<void> {
  await forEachTableBatch(owners, async (rows) => {
    const counts = new Map<string, number>()
    const migrated = rows.map((source) => {
      const refs = normalizeLegacyAttachmentRefs(source.attachmentRefs, ownerFor(source)) ?? []
      for (const ref of refs) {
        if (ref.deletedAt === undefined) {
          counts.set(ref.attachmentId, (counts.get(ref.attachmentId) ?? 0) + 1)
        }
      }
      return { ...source, attachmentRefs: refs }
    })
    await owners.bulkPut(migrated)
    const ids = [...counts.keys()]
    const attachmentRows = await attachments.bulkGet(ids)
    const changed = attachmentRows.flatMap((row, index) => {
      if (!row) return []
      return [{ ...row, refCount: numberOr(row.refCount, 0) + (counts.get(ids[index] ?? '') ?? 0) }]
    })
    if (changed.length > 0) await attachments.bulkPut(changed)
  })
}

function normalizeLegacyAttachmentRefs(
  value: unknown,
  owner: { messageId?: string; draftChatId?: string; createdAt: number },
): MessageAttachmentRef[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value
    .map((raw, index): MessageAttachmentRef | undefined => {
      if (typeof raw === 'string') {
        return {
          refId: `legacy:${owner.messageId ?? owner.draftChatId ?? 'unknown'}:${index}`,
          attachmentId: raw,
          includeInContext: true,
          presentation: {},
          createdAt: owner.createdAt,
          updatedAt: owner.createdAt,
        }
      }
      if (!raw || typeof raw !== 'object') return undefined
      const ref = raw as Partial<MessageAttachmentRef>
      if (typeof ref.attachmentId !== 'string') return undefined
      return {
        refId:
          typeof ref.refId === 'string'
            ? ref.refId
            : `legacy:${owner.messageId ?? owner.draftChatId ?? 'unknown'}:${index}`,
        attachmentId: ref.attachmentId,
        includeInContext: ref.includeInContext !== false,
        presentation: ref.presentation ?? {},
        ...(ref.tokenEstimate ? { tokenEstimate: ref.tokenEstimate } : {}),
        ...(ref.missingResolution ? { missingResolution: ref.missingResolution } : {}),
        createdAt: numberOr(ref.createdAt, owner.createdAt),
        updatedAt: numberOr(ref.updatedAt, owner.createdAt),
        ...(typeof ref.deletedAt === 'number' ? { deletedAt: ref.deletedAt } : {}),
      }
    })
    .filter((ref): ref is MessageAttachmentRef => ref !== undefined)
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function extensionFromFilename(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const filename = value.split(/[\\/]/).pop() ?? value
  const dot = filename.lastIndexOf('.')
  if (dot <= 0 || dot === filename.length - 1) return undefined
  return filename.slice(dot + 1).toLowerCase()
}

function storageBlobId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const storage = value as { kind?: unknown; blobId?: unknown }
  return storage.kind === 'local-blob' && typeof storage.blobId === 'string'
    ? storage.blobId
    : undefined
}

function legacyBlob(value: unknown): Blob | undefined {
  if (value instanceof Blob) return value
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as { size?: unknown; arrayBuffer?: unknown }
  if (typeof candidate.size !== 'number' || typeof candidate.arrayBuffer !== 'function') {
    return undefined
  }
  return value as Blob
}
