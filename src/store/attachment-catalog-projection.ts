import Dexie, { type Transaction } from 'dexie'
import type { AttachmentId, AttachmentReferenceEdge } from '../core/types'
import { sameValue } from '../lib/same-value'
import type { AttachmentHeaderRow } from './attachment-storage'
import {
  deletePhysicalStorageRows,
  putPhysicalStorageRow,
  putPhysicalStorageRows,
} from './byte-owner-mutation'
import { physicalStorageTables } from './physical-storage-tables'
import type {
  AttachmentCatalogAggregate,
  AttachmentCatalogProcessingSummary,
  AttachmentCatalogRow,
} from './repository'
import {
  type SemanticOperationReceiptFragment,
  semanticOperationReceiptFragment,
} from './semantic-operation-capability'

export const ATTACHMENT_CATALOG_MUTATION_TRANSACTION_CAPABILITY = physicalStorageTables(
  'attachments',
  'attachmentRefEdges',
  'attachmentCatalogRows',
  'attachmentCatalogAggregate',
)

export interface AttachmentCatalogProjectionRow extends AttachmentCatalogRow {
  storageKind: AttachmentCatalogRow['storage']['kind']
  deletedKey: number
  searchMetadata: string
}

export interface AttachmentReferenceSummary {
  readonly refCount: number
  readonly messageRefCount: number
  readonly draftRefCount: number
  readonly visibleRefCount: number
}

export interface AttachmentCatalogRepairSnapshot {
  readonly headers: readonly (AttachmentHeaderRow | undefined)[]
  readonly summaries: ReadonlyMap<AttachmentId, AttachmentReferenceSummary>
}

export interface AttachmentCatalogReferenceDelta {
  readonly attachmentId: AttachmentId
  readonly refCount: number
  readonly messageRefCount: number
  readonly draftRefCount: number
  readonly visibleRefCount: number
  readonly previousHeader: AttachmentHeaderRow
  readonly nextHeader: AttachmentHeaderRow
}

export interface AttachmentCatalogReferenceMutationReceipt {
  readonly rowReadIds: readonly AttachmentId[]
  readonly rowWriteIds: readonly AttachmentId[]
  readonly aggregateRead: boolean
  readonly aggregateWrite: boolean
  readonly fragment: SemanticOperationReceiptFragment<
    'attachmentCatalogRows' | 'attachmentCatalogAggregate'
  >
}

export const ATTACHMENT_CATALOG_AGGREGATE_ID = 'workspace'

export interface AttachmentCatalogAggregateRow extends AttachmentCatalogAggregate {
  id: typeof ATTACHMENT_CATALOG_AGGREGATE_ID
  projectionRevision: number
  integrityPending?: boolean
}

export function emptyAttachmentCatalogAggregateRow(): AttachmentCatalogAggregateRow {
  return {
    id: ATTACHMENT_CATALOG_AGGREGATE_ID,
    projectionRevision: 0,
    totalCount: 0,
    activeCount: 0,
    deletedCount: 0,
    referencedCount: 0,
    unreferencedCount: 0,
    localCount: 0,
    remoteCount: 0,
    missingCount: 0,
    generatedCount: 0,
    totalSizeBytes: 0,
    localSizeBytes: 0,
  }
}

export async function putAttachmentCatalogProjectionFromHeader(
  tx: Transaction,
  header: AttachmentHeaderRow,
  previousHeader: AttachmentHeaderRow | undefined,
  options?: { readonly previous: AttachmentCatalogProjectionRow },
): Promise<AttachmentCatalogReferenceMutationReceipt> {
  const table = tx.table<AttachmentCatalogProjectionRow, AttachmentId>('attachmentCatalogRows')
  const previous = options?.previous ?? (await table.get(header.id))
  if ((previousHeader === undefined) !== (previous === undefined)) {
    throw new Error(`AttachmentCatalogHeaderStateMismatch:${header.id}`)
  }
  const summary = previous ? attachmentCatalogReferenceSummary(previous) : emptyReferenceSummary()
  if (previousHeader && previousHeader.refCount !== summary.refCount) {
    throw new Error(`AttachmentCatalogReferenceCountMismatch:${header.id}`)
  }
  if (header.refCount !== summary.refCount) {
    throw new Error(`AttachmentCatalogHeaderReferenceCountMismatch:${header.id}`)
  }
  const next = attachmentCatalogProjectionRow(header, summary)
  await putPhysicalStorageRow(tx, 'attachmentCatalogRows', next, previous)
  const aggregate = await applyAttachmentCatalogAggregateDeltas(tx, [{ previous, next }])
  return attachmentCatalogReferenceMutationReceipt(
    options ? [] : [header.id],
    [header.id],
    aggregate.read,
    aggregate.written,
    'get',
  )
}

export async function deleteAttachmentCatalogProjection(
  tx: Transaction,
  attachmentId: AttachmentId,
  options?: { readonly previous: AttachmentCatalogProjectionRow },
): Promise<AttachmentCatalogReferenceMutationReceipt> {
  const table = tx.table<AttachmentCatalogProjectionRow, AttachmentId>('attachmentCatalogRows')
  const previous = options?.previous ?? (await table.get(attachmentId))
  if (!previous) throw new Error(`AttachmentCatalogRowMissing:${attachmentId}`)
  await deletePhysicalStorageRows(tx, 'attachmentCatalogRows', [attachmentId], [previous])
  const aggregate = await applyAttachmentCatalogAggregateDeltas(tx, [{ previous, next: undefined }])
  return attachmentCatalogReferenceMutationReceipt(
    options ? [] : [attachmentId],
    [attachmentId],
    aggregate.read,
    aggregate.written,
    'get',
    'delete',
  )
}

export async function applyAttachmentCatalogReferenceDeltas(
  tx: Transaction,
  deltas: readonly AttachmentCatalogReferenceDelta[],
): Promise<AttachmentCatalogReferenceMutationReceipt> {
  if (deltas.length === 0) {
    return attachmentCatalogReferenceMutationReceipt([], [], false, false)
  }
  const table = tx.table<AttachmentCatalogProjectionRow, AttachmentId>('attachmentCatalogRows')
  const previousRows = await table.bulkGet(deltas.map((delta) => delta.attachmentId))
  const nextRows: AttachmentCatalogProjectionRow[] = []
  const changes: {
    previous: AttachmentCatalogProjectionRow
    next: AttachmentCatalogProjectionRow
  }[] = []
  for (let index = 0; index < deltas.length; index += 1) {
    const delta = deltas[index]
    const previous = previousRows[index]
    if (!delta || !previous) {
      throw new Error(`AttachmentCatalogRowMissing:${delta?.attachmentId ?? 'unknown'}`)
    }
    const before = attachmentCatalogReferenceSummary(previous)
    if (
      before.refCount !== delta.previousHeader.refCount ||
      delta.nextHeader.refCount !== before.refCount + delta.refCount
    ) {
      throw new Error(`AttachmentCatalogReferenceCountMismatch:${delta.attachmentId}`)
    }
    const nextSummary = checkedReferenceSummary(delta.attachmentId, {
      refCount: before.refCount + delta.refCount,
      messageRefCount: before.messageRefCount + delta.messageRefCount,
      draftRefCount: before.draftRefCount + delta.draftRefCount,
      visibleRefCount: before.visibleRefCount + delta.visibleRefCount,
    })
    const next = attachmentCatalogProjectionRow(delta.nextHeader, nextSummary)
    nextRows.push(next)
    changes.push({ previous, next })
  }
  await putPhysicalStorageRows(
    tx,
    'attachmentCatalogRows',
    nextRows,
    previousRows.filter((row): row is AttachmentCatalogProjectionRow => row !== undefined),
  )
  const aggregate = await applyAttachmentCatalogAggregateDeltas(tx, changes)
  return attachmentCatalogReferenceMutationReceipt(
    deltas.map(({ attachmentId }) => attachmentId),
    nextRows.map(({ id }) => id),
    aggregate.read,
    aggregate.written,
  )
}

async function applyAttachmentCatalogAggregateDeltas(
  tx: Transaction,
  changes: readonly {
    previous: AttachmentCatalogProjectionRow | undefined
    next: AttachmentCatalogProjectionRow | undefined
  }[],
): Promise<{ readonly read: boolean; readonly written: boolean }> {
  if (changes.length === 0) return { read: false, written: false }
  const table = tx.table<AttachmentCatalogAggregateRow, string>('attachmentCatalogAggregate')
  const previous = await table.get(ATTACHMENT_CATALOG_AGGREGATE_ID)
  const current = previous ?? emptyAttachmentCatalogAggregateRow()
  const updated: AttachmentCatalogAggregateRow = {
    ...current,
    projectionRevision: nextAttachmentCatalogProjectionRevision(current.projectionRevision),
  }
  if (current.integrityPending) {
    await putPhysicalStorageRow(tx, 'attachmentCatalogAggregate', updated, previous)
    return { read: true, written: true }
  }
  for (const { previous, next } of changes) {
    const before = previous ? attachmentCatalogContribution(previous) : null
    const after = next ? attachmentCatalogContribution(next) : null
    for (const key of ATTACHMENT_AGGREGATE_FIELDS) {
      const value = updated[key] - (before?.[key] ?? 0) + (after?.[key] ?? 0)
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`AttachmentCatalogAggregateInvalid:${key}`)
      }
      updated[key] = value
    }
  }
  await putPhysicalStorageRow(tx, 'attachmentCatalogAggregate', updated, previous)
  return { read: true, written: true }
}

function attachmentCatalogReferenceMutationReceipt(
  rowReadIds: readonly AttachmentId[],
  rowWriteIds: readonly AttachmentId[],
  aggregateRead: boolean,
  aggregateWrite: boolean,
  rowReadOperation: 'get' | 'get-many' = 'get-many',
  rowMutationOperation: 'write' | 'delete' = 'write',
): AttachmentCatalogReferenceMutationReceipt {
  return Object.freeze({
    rowReadIds: Object.freeze([...rowReadIds]),
    rowWriteIds: Object.freeze([...rowWriteIds]),
    aggregateRead,
    aggregateWrite,
    fragment: semanticOperationReceiptFragment({
      dependencies:
        rowWriteIds.length > 0 ? [{ kind: 'attachment', attachmentIds: [...rowWriteIds] }] : [],
      physicalMutations: [
        ...rowWriteIds.map((key) => ({
          tableName: 'attachmentCatalogRows' as const,
          operation: rowMutationOperation,
          key,
        })),
        ...(aggregateWrite
          ? [
              {
                tableName: 'attachmentCatalogAggregate' as const,
                operation: 'write' as const,
                key: ATTACHMENT_CATALOG_AGGREGATE_ID,
              },
            ]
          : []),
      ],
      physicalReads: [
        ...(rowReadIds.length > 0
          ? [
              {
                tableName: 'attachmentCatalogRows' as const,
                indexKind: 'primary' as const,
                operation: rowReadOperation,
                requestCount: 1,
                rowCount: rowReadIds.length,
              },
            ]
          : []),
        ...(aggregateRead
          ? [
              {
                tableName: 'attachmentCatalogAggregate' as const,
                indexKind: 'primary' as const,
                operation: 'get' as const,
                requestCount: 1,
                rowCount: 1,
              },
            ]
          : []),
      ],
    }),
  })
}

function nextAttachmentCatalogProjectionRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value === Number.MAX_SAFE_INTEGER) return 0
  return value + 1
}

const ATTACHMENT_AGGREGATE_FIELDS = [
  'totalCount',
  'activeCount',
  'deletedCount',
  'referencedCount',
  'unreferencedCount',
  'localCount',
  'remoteCount',
  'missingCount',
  'generatedCount',
  'totalSizeBytes',
  'localSizeBytes',
] as const satisfies readonly (keyof AttachmentCatalogAggregate)[]

function attachmentCatalogContribution(
  row: AttachmentCatalogProjectionRow,
): AttachmentCatalogAggregate {
  const referenced = row.refCount > 0
  return {
    totalCount: 1,
    activeCount: row.deletedKey === 0 ? 1 : 0,
    deletedCount: row.deletedKey === 1 ? 1 : 0,
    referencedCount: referenced ? 1 : 0,
    unreferencedCount: referenced ? 0 : 1,
    localCount: row.storageKind === 'local-blob' ? 1 : 0,
    remoteCount: row.storageKind === 'remote-url' ? 1 : 0,
    missingCount: row.storageKind === 'missing' ? 1 : 0,
    generatedCount: row.origin === 'generated-output' ? 1 : 0,
    totalSizeBytes: row.sizeBytes,
    localSizeBytes: row.storageKind === 'local-blob' ? row.sizeBytes : 0,
  }
}

export async function refreshAttachmentCatalogProjectionsForRepair(
  tx: Transaction,
  attachmentIds: Iterable<AttachmentId>,
  suppliedSnapshot?: AttachmentCatalogRepairSnapshot,
): Promise<readonly AttachmentId[]> {
  const ids = [...new Set(attachmentIds)]
  if (ids.length === 0) return []
  const catalog = tx.table<AttachmentCatalogProjectionRow, AttachmentId>('attachmentCatalogRows')
  const [snapshot, previousRows] = await Dexie.Promise.all([
    suppliedSnapshot ?? readAttachmentCatalogRepairSnapshot(tx, ids),
    catalog.bulkGet(ids),
  ])
  if (snapshot.headers.length !== ids.length) {
    throw new Error('AttachmentCatalogRepairSnapshotLengthMismatch')
  }
  const nextRows = snapshot.headers.map((header, index) =>
    header
      ? attachmentCatalogProjectionRow(
          header,
          snapshot.summaries.get(ids[index] as AttachmentId) ?? emptyReferenceSummary(),
        )
      : undefined,
  )
  const changes = ids.flatMap((id, index) => {
    const previous = previousRows[index]
    const next = nextRows[index]
    return sameValue(previous, next) ? [] : [{ id, previous, next }]
  })
  const deleted = changes.filter(
    (
      change,
    ): change is {
      id: AttachmentId
      previous: AttachmentCatalogProjectionRow
      next: undefined
    } => change.previous !== undefined && change.next === undefined,
  )
  const stored = changes.flatMap(({ next }) => (next ? [next] : []))
  const replaced = changes.flatMap(({ previous }) => (previous ? [previous] : []))
  const deletedIds = deleted.map(({ id }) => id)
  const deletedRows = deleted.map(({ previous }) => previous)
  await deletePhysicalStorageRows(tx, 'attachmentCatalogRows', deletedIds, deletedRows)
  await putPhysicalStorageRows(tx, 'attachmentCatalogRows', stored, replaced)
  await applyAttachmentCatalogAggregateDeltas(
    tx,
    changes.map(({ previous, next }) => ({ previous, next })),
  )
  return changes.map(({ id }) => id)
}

export async function readAttachmentCatalogRepairSnapshot(
  tx: Transaction,
  attachmentIds: readonly AttachmentId[],
): Promise<AttachmentCatalogRepairSnapshot> {
  const ids = [...new Set(attachmentIds)]
  const headers = await tx.table<AttachmentHeaderRow, AttachmentId>('attachments').bulkGet(ids)
  const existingIds = ids.filter((_, index) => headers[index] !== undefined)
  const summaries = new Map<AttachmentId, AttachmentReferenceSummary>()
  const lastOwnerByGroup = new Map<string, string>()
  if (existingIds.length > 0) {
    await tx
      .table<AttachmentReferenceEdge>('attachmentRefEdges')
      .where('[attachmentId+ownerKind]')
      .anyOf(
        existingIds.flatMap((attachmentId) => [
          [attachmentId, 'message'],
          [attachmentId, 'draft'],
        ]),
      )
      .each((edge) => {
        const previous = summaries.get(edge.attachmentId) ?? emptyReferenceSummary()
        const groupKey = `${edge.attachmentId}\u0000${edge.ownerKind}`
        // The compound index groups attachment/kind; the primary key then orders ownerId/refId.
        const newOwner = lastOwnerByGroup.get(groupKey) !== edge.ownerId
        if (newOwner) lastOwnerByGroup.set(groupKey, edge.ownerId)
        summaries.set(edge.attachmentId, {
          refCount: previous.refCount + 1,
          messageRefCount:
            previous.messageRefCount + Number(newOwner && edge.ownerKind === 'message'),
          draftRefCount: previous.draftRefCount + Number(newOwner && edge.ownerKind === 'draft'),
          visibleRefCount: previous.visibleRefCount + Number(edge.includeInContext),
        })
      })
  }
  return { headers, summaries }
}

export function accumulateAttachmentCatalogProjection(
  aggregate: AttachmentCatalogAggregateRow,
  row: AttachmentCatalogProjectionRow,
): void {
  const contribution = attachmentCatalogContribution(row)
  for (const key of ATTACHMENT_AGGREGATE_FIELDS) {
    const value = aggregate[key] + contribution[key]
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`AttachmentCatalogAggregateInvalid:${key}`)
    }
    aggregate[key] = value
  }
}

export function attachmentCatalogProjectionRow(
  attachment: AttachmentHeaderRow,
  summary: AttachmentReferenceSummary,
): AttachmentCatalogProjectionRow {
  const checked = checkedReferenceSummary(attachment.id, summary)
  if (checked.refCount !== attachment.refCount) {
    throw new Error(`AttachmentCatalogHeaderReferenceCountMismatch:${attachment.id}`)
  }
  const processing = attachment.processing.map(compactProcessingState)
  const row: AttachmentCatalogRow = {
    id: attachment.id,
    ...(attachment.contentHash ? { contentHash: attachment.contentHash } : {}),
    kind: attachment.kind,
    mime: attachment.mime,
    filename: attachment.filename,
    ...(attachment.extension ? { extension: attachment.extension } : {}),
    sizeBytes: attachment.sizeBytes ?? 0,
    origin: attachment.origin,
    ...(attachment.sourceUrl ? { sourceUrl: attachment.sourceUrl } : {}),
    createdAt: attachment.createdAt,
    updatedAt: attachment.updatedAt,
    storage: structuredClone(attachment.storage),
    ...(attachment.dimensions ? { dimensions: { ...attachment.dimensions } } : {}),
    ...(attachment.durationMs === undefined ? {} : { durationMs: attachment.durationMs }),
    ...(attachment.pageCount === undefined ? {} : { pageCount: attachment.pageCount }),
    ...(attachment.textCharCount === undefined ? {} : { textCharCount: attachment.textCharCount }),
    ...(attachment.languageHint ? { languageHint: attachment.languageHint } : {}),
    ...(attachment.scannedLike === undefined ? {} : { scannedLike: attachment.scannedLike }),
    ...(attachment.thumbnailBlobId ? { thumbnailBlobId: attachment.thumbnailBlobId } : {}),
    refCount: checked.refCount,
    messageRefCount: checked.messageRefCount,
    draftRefCount: checked.draftRefCount,
    visibleRefCount: checked.visibleRefCount,
    hiddenRefCount: checked.refCount - checked.visibleRefCount,
    missingVisibleRefCount: attachment.storage.kind === 'missing' ? checked.visibleRefCount : 0,
    ...(attachment.deletedAt === undefined ? {} : { deletedAt: attachment.deletedAt }),
    ...(attachment.supersededByAttachmentId
      ? { supersededByAttachmentId: attachment.supersededByAttachmentId }
      : {}),
    ...(attachment.lastIntegrityCheckAt === undefined
      ? {}
      : { lastIntegrityCheckAt: attachment.lastIntegrityCheckAt }),
    processing,
  }
  return {
    ...row,
    storageKind: row.storage.kind,
    deletedKey: row.deletedAt === undefined ? 0 : 1,
    searchMetadata: attachmentCatalogMetadataText(row),
  }
}

export function publicAttachmentCatalogRow(
  row: AttachmentCatalogProjectionRow,
): AttachmentCatalogRow {
  const {
    storageKind: _storageKind,
    deletedKey: _deletedKey,
    searchMetadata: _searchMetadata,
    lastUsedAt: _legacyLastUsedAt,
    ...publicRow
  } = row as AttachmentCatalogProjectionRow & { lastUsedAt?: number | null }
  return {
    ...publicRow,
    storage: structuredClone(publicRow.storage),
    ...(publicRow.dimensions ? { dimensions: { ...publicRow.dimensions } } : {}),
    processing: publicRow.processing.map((state) => ({ ...state })),
  }
}

function attachmentCatalogReferenceSummary(
  row: AttachmentCatalogProjectionRow,
): AttachmentReferenceSummary {
  return {
    refCount: row.refCount,
    messageRefCount: row.messageRefCount,
    draftRefCount: row.draftRefCount,
    visibleRefCount: row.visibleRefCount,
  }
}

function emptyReferenceSummary(): AttachmentReferenceSummary {
  return { refCount: 0, messageRefCount: 0, draftRefCount: 0, visibleRefCount: 0 }
}

function checkedReferenceSummary(
  attachmentId: AttachmentId,
  summary: AttachmentReferenceSummary,
): AttachmentReferenceSummary {
  const values = [
    summary.refCount,
    summary.messageRefCount,
    summary.draftRefCount,
    summary.visibleRefCount,
  ]
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error(`AttachmentCatalogReferenceSummaryInvalid:${attachmentId}`)
  }
  if (
    summary.visibleRefCount > summary.refCount ||
    summary.messageRefCount + summary.draftRefCount > summary.refCount
  ) {
    throw new Error(`AttachmentCatalogReferenceSummaryInvalid:${attachmentId}`)
  }
  return summary
}

function compactProcessingState(
  state: AttachmentHeaderRow['processing'][number],
): AttachmentCatalogProcessingSummary {
  return {
    processorId: state.processorId,
    status: state.status,
    ...(state.startedAt === undefined ? {} : { startedAt: state.startedAt }),
    ...(state.finishedAt === undefined ? {} : { finishedAt: state.finishedAt }),
    ...(state.error ? { errorCode: state.error.code } : {}),
  }
}

function attachmentCatalogMetadataText(row: AttachmentCatalogRow): string {
  return [
    row.id,
    row.contentHash,
    row.kind,
    row.mime,
    row.filename,
    row.extension,
    row.origin,
    row.sourceUrl,
    row.storage.kind,
    ...row.processing.map((state) => state.processorId),
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join('\n')
    .toLowerCase()
}
