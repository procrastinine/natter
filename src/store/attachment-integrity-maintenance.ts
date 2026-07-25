import type { IndexableType, Table, Transaction } from 'dexie'
import type { AttachmentId, AttachmentReferenceEdge, DraftRow, MessageId } from '../core/types'
import {
  type AttachmentCatalogAggregateRow,
  type AttachmentCatalogProjectionRow,
  accumulateAttachmentCatalogProjection,
  emptyAttachmentCatalogAggregateRow,
  refreshAttachmentCatalogProjectionsForRepair,
} from './attachment-catalog-projection'
import {
  reconcileAttachmentRefCountsForRepair,
  replaceAttachmentReferenceOwnersForRepair,
} from './attachment-reference-edges'
import type { AttachmentHeaderRow } from './attachment-storage'
import { recordBrowserCommandAttachmentIntegrityMaintenance } from './browser-command-mutation-journal'
import { putPhysicalStorageRow } from './byte-owner-mutation'
import type { MessageHeaderRow } from './message-storage'
import { physicalStorageTables } from './physical-storage-tables'
import type { AttachmentIntegrityMaintenanceResult } from './workspace-protocol'

export const ATTACHMENT_INTEGRITY_TRANSACTION_CAPABILITY = physicalStorageTables(
  'attachmentCatalogAggregate',
  'attachmentCatalogRows',
  'attachmentIntegrityState',
  'attachmentRefEdges',
  'attachments',
  'drafts',
  'messages',
)

const ATTACHMENT_INTEGRITY_STATE_ID = 'workspace'
const ATTACHMENT_INTEGRITY_REPAIR_VERSION = 1

type AttachmentIntegrityPhase =
  | 'messages'
  | 'drafts'
  | 'edges'
  | 'attachments'
  | 'catalog'
  | 'aggregate'
  | 'complete'

export interface AttachmentIntegrityStateRow {
  readonly id: typeof ATTACHMENT_INTEGRITY_STATE_ID
  readonly repairVersion: typeof ATTACHMENT_INTEGRITY_REPAIR_VERSION
  readonly phase: AttachmentIntegrityPhase
  readonly afterMessageId?: MessageId
  readonly afterDraftId?: string
  readonly afterEdge?: [AttachmentReferenceEdge['ownerKind'], string, string]
  readonly afterAttachmentId?: AttachmentId
  readonly afterCatalogId?: AttachmentId
  readonly aggregateRevision?: number
  readonly aggregateAfterId?: AttachmentId
  readonly aggregate?: AttachmentCatalogAggregateRow
}

export async function reconcileAttachmentIntegrityPage(
  tx: Transaction,
  requestedLimit: number,
): Promise<AttachmentIntegrityMaintenanceResult> {
  const limit = Math.max(1, Math.min(128, Math.floor(requestedLimit)))
  const states = tx.table<AttachmentIntegrityStateRow, string>('attachmentIntegrityState')
  const state = await states.get(ATTACHMENT_INTEGRITY_STATE_ID)
  if (!state) throw new Error('AttachmentIntegrityStateMissing')
  recordBrowserCommandAttachmentIntegrityMaintenance(tx)
  switch (state.phase) {
    case 'messages':
      return reconcileMessageOwnerPage(tx, state, limit)
    case 'drafts':
      return reconcileDraftOwnerPage(tx, state, limit)
    case 'edges':
      return reconcileEdgePage(tx, state, limit)
    case 'attachments':
      return reconcileAttachmentPage(tx, state, limit)
    case 'catalog':
      return reconcileCatalogPage(tx, state, limit)
    case 'aggregate':
      return reconcileAggregatePage(tx, state, limit)
    case 'complete':
      return { phase: 'complete', scanned: 0, repairedAttachmentIds: [], done: true }
  }
}

export function pendingAttachmentIntegrityState(): AttachmentIntegrityStateRow {
  return {
    id: ATTACHMENT_INTEGRITY_STATE_ID,
    repairVersion: ATTACHMENT_INTEGRITY_REPAIR_VERSION,
    phase: 'messages',
  }
}

export function completedAttachmentIntegrityState(): AttachmentIntegrityStateRow {
  return {
    id: ATTACHMENT_INTEGRITY_STATE_ID,
    repairVersion: ATTACHMENT_INTEGRITY_REPAIR_VERSION,
    phase: 'complete',
  }
}

export async function markAttachmentIntegrityRepairPending(tx: Transaction): Promise<void> {
  const aggregates = tx.table<AttachmentCatalogAggregateRow, string>('attachmentCatalogAggregate')
  const states = tx.table<AttachmentIntegrityStateRow, string>('attachmentIntegrityState')
  const [previousAggregate, previousState] = await Promise.all([
    aggregates.get(ATTACHMENT_INTEGRITY_STATE_ID),
    states.get(ATTACHMENT_INTEGRITY_STATE_ID),
  ])
  const aggregate = previousAggregate ?? emptyAttachmentCatalogAggregateRow()
  await Promise.all([
    putPhysicalStorageRow(
      tx,
      'attachmentCatalogAggregate',
      { ...aggregate, integrityPending: true },
      previousAggregate,
    ),
    putPhysicalStorageRow(
      tx,
      'attachmentIntegrityState',
      pendingAttachmentIntegrityState(),
      previousState,
    ),
  ])
}

export async function markAttachmentIntegrityRepairComplete(tx: Transaction): Promise<void> {
  const aggregates = tx.table<AttachmentCatalogAggregateRow, string>('attachmentCatalogAggregate')
  const states = tx.table<AttachmentIntegrityStateRow, string>('attachmentIntegrityState')
  const [previousAggregate, previousState] = await Promise.all([
    aggregates.get(ATTACHMENT_INTEGRITY_STATE_ID),
    states.get(ATTACHMENT_INTEGRITY_STATE_ID),
  ])
  const aggregate = previousAggregate ?? emptyAttachmentCatalogAggregateRow()
  await Promise.all([
    putPhysicalStorageRow(
      tx,
      'attachmentCatalogAggregate',
      { ...aggregate, integrityPending: false },
      previousAggregate,
    ),
    putPhysicalStorageRow(
      tx,
      'attachmentIntegrityState',
      completedAttachmentIntegrityState(),
      previousState,
    ),
  ])
}

async function reconcileMessageOwnerPage(
  tx: Transaction,
  state: AttachmentIntegrityStateRow,
  limit: number,
): Promise<AttachmentIntegrityMaintenanceResult> {
  const page = await readPrimaryPage(
    tx.table<MessageHeaderRow, MessageId>('messages'),
    state.afterMessageId,
    limit,
  )
  const owners = page.map((message) => ({
    ownerKind: 'message' as const,
    ownerId: message.id,
    chatId: message.chatId,
    refs: message.attachmentRefs,
  }))
  const repairedAttachmentIds = await replaceAttachmentReferenceOwnersForRepair(tx, owners)
  await putPhysicalStorageRow(
    tx,
    'attachmentIntegrityState',
    page.length < limit
      ? attachmentIntegrityState('drafts')
      : {
          id: ATTACHMENT_INTEGRITY_STATE_ID,
          repairVersion: ATTACHMENT_INTEGRITY_REPAIR_VERSION,
          phase: 'messages',
          afterMessageId: requiredLast(page, 'message-owner').id,
        },
    state,
  )
  return { phase: 'messages', scanned: page.length, repairedAttachmentIds, done: false }
}

async function reconcileDraftOwnerPage(
  tx: Transaction,
  state: AttachmentIntegrityStateRow,
  limit: number,
): Promise<AttachmentIntegrityMaintenanceResult> {
  const page = await readPrimaryPage(
    tx.table<DraftRow, string>('drafts'),
    state.afterDraftId,
    limit,
  )
  const owners = page.map((draft) => ({
    ownerKind: 'draft' as const,
    ownerId: draft.chatId,
    chatId: draft.chatId,
    refs: draft.attachmentRefs,
  }))
  const repairedAttachmentIds = await replaceAttachmentReferenceOwnersForRepair(tx, owners)
  await putPhysicalStorageRow(
    tx,
    'attachmentIntegrityState',
    page.length < limit
      ? attachmentIntegrityState('edges')
      : {
          id: ATTACHMENT_INTEGRITY_STATE_ID,
          repairVersion: ATTACHMENT_INTEGRITY_REPAIR_VERSION,
          phase: 'drafts',
          afterDraftId: requiredLast(page, 'draft-owner').chatId,
        },
    state,
  )
  return { phase: 'drafts', scanned: page.length, repairedAttachmentIds, done: false }
}

async function reconcileEdgePage(
  tx: Transaction,
  state: AttachmentIntegrityStateRow,
  limit: number,
): Promise<AttachmentIntegrityMaintenanceResult> {
  const table = tx.table<
    AttachmentReferenceEdge,
    [AttachmentReferenceEdge['ownerKind'], string, string]
  >('attachmentRefEdges')
  const page = await readPrimaryPage(table, state.afterEdge, limit)
  const ownerKeys = new Map<
    string,
    Pick<AttachmentReferenceEdge, 'ownerKind' | 'ownerId' | 'chatId'>
  >()
  for (const edge of page) {
    ownerKeys.set(`${edge.ownerKind}\u0000${edge.ownerId}`, edge)
  }
  const owners = [...ownerKeys.values()]
  const messageOwners = owners.filter((owner) => owner.ownerKind === 'message')
  const draftOwners = owners.filter((owner) => owner.ownerKind === 'draft')
  const [messages, drafts] = await Promise.all([
    tx
      .table<MessageHeaderRow, MessageId>('messages')
      .bulkGet(messageOwners.map((owner) => owner.ownerId)),
    tx.table<DraftRow, string>('drafts').bulkGet(draftOwners.map((owner) => owner.ownerId)),
  ])
  const orphanOwners = [
    ...messageOwners.flatMap((owner, index) => {
      const message = messages[index]
      return message
        ? []
        : [
            {
              ownerKind: 'message' as const,
              ownerId: owner.ownerId,
              chatId: owner.chatId,
              refs: undefined,
            },
          ]
    }),
    ...draftOwners.flatMap((owner, index) => {
      const draft = drafts[index]
      return draft
        ? []
        : [
            {
              ownerKind: 'draft' as const,
              ownerId: owner.ownerId,
              chatId: owner.chatId,
              refs: undefined,
            },
          ]
    }),
  ]
  const repairedAttachmentIds = await replaceAttachmentReferenceOwnersForRepair(tx, orphanOwners)
  const done = page.length < limit
  await putPhysicalStorageRow(
    tx,
    'attachmentIntegrityState',
    done
      ? attachmentIntegrityState('attachments')
      : {
          id: ATTACHMENT_INTEGRITY_STATE_ID,
          repairVersion: ATTACHMENT_INTEGRITY_REPAIR_VERSION,
          phase: 'edges',
          afterEdge: [
            requiredLast(page, 'edge').ownerKind,
            requiredLast(page, 'edge').ownerId,
            requiredLast(page, 'edge').refId,
          ],
        },
    state,
  )
  return { phase: 'edges', scanned: page.length, repairedAttachmentIds, done: false }
}

async function reconcileAttachmentPage(
  tx: Transaction,
  state: AttachmentIntegrityStateRow,
  limit: number,
): Promise<AttachmentIntegrityMaintenanceResult> {
  const table = tx.table<AttachmentHeaderRow, AttachmentId>('attachments')
  const page = await readPrimaryPage(table, state.afterAttachmentId, limit)
  const ids = page.map((attachment) => attachment.id)
  await reconcileAttachmentRefCountsForRepair(tx, ids)
  const done = page.length < limit
  await putPhysicalStorageRow(
    tx,
    'attachmentIntegrityState',
    done
      ? attachmentIntegrityState('catalog')
      : {
          id: ATTACHMENT_INTEGRITY_STATE_ID,
          repairVersion: ATTACHMENT_INTEGRITY_REPAIR_VERSION,
          phase: 'attachments',
          afterAttachmentId: requiredLast(page, 'attachment').id,
        },
    state,
  )
  return { phase: 'attachments', scanned: page.length, repairedAttachmentIds: ids, done: false }
}

async function reconcileCatalogPage(
  tx: Transaction,
  state: AttachmentIntegrityStateRow,
  limit: number,
): Promise<AttachmentIntegrityMaintenanceResult> {
  const table = tx.table<AttachmentCatalogProjectionRow, AttachmentId>('attachmentCatalogRows')
  const page = await readPrimaryPage(table, state.afterCatalogId, limit)
  const ids = page.map((row) => row.id)
  const headers = await tx.table<AttachmentHeaderRow, AttachmentId>('attachments').bulkGet(ids)
  const orphanIds = ids.filter((_, index) => headers[index] === undefined)
  await refreshAttachmentCatalogProjectionsForRepair(tx, orphanIds)
  const done = page.length < limit
  await putPhysicalStorageRow(
    tx,
    'attachmentIntegrityState',
    done
      ? attachmentIntegrityState('aggregate')
      : {
          id: ATTACHMENT_INTEGRITY_STATE_ID,
          repairVersion: ATTACHMENT_INTEGRITY_REPAIR_VERSION,
          phase: 'catalog',
          afterCatalogId: requiredLast(page, 'catalog').id,
        },
    state,
  )
  return {
    phase: 'catalog',
    scanned: page.length,
    repairedAttachmentIds: orphanIds,
    done: false,
  }
}

async function reconcileAggregatePage(
  tx: Transaction,
  state: AttachmentIntegrityStateRow,
  limit: number,
): Promise<AttachmentIntegrityMaintenanceResult> {
  const aggregateTable = tx.table<AttachmentCatalogAggregateRow, string>(
    'attachmentCatalogAggregate',
  )
  const current =
    (await aggregateTable.get(ATTACHMENT_INTEGRITY_STATE_ID)) ??
    emptyAttachmentCatalogAggregateRow()
  const currentRevision = normalizedProjectionRevision(current.projectionRevision)
  const continuing: AttachmentIntegrityStateRow =
    state.aggregateRevision === currentRevision && state.aggregate !== undefined
      ? state
      : {
          id: ATTACHMENT_INTEGRITY_STATE_ID,
          repairVersion: ATTACHMENT_INTEGRITY_REPAIR_VERSION,
          phase: 'aggregate' as const,
          aggregateRevision: currentRevision,
          aggregate: {
            ...emptyAttachmentCatalogAggregateRow(),
            projectionRevision: currentRevision,
          },
        }
  const page = await readPrimaryPage(
    tx.table<AttachmentCatalogProjectionRow, AttachmentId>('attachmentCatalogRows'),
    continuing.aggregateAfterId,
    limit,
  )
  const aggregate = structuredClone(requiredAggregate(continuing))
  for (const row of page) accumulateAttachmentCatalogProjection(aggregate, row)
  if (page.length < limit) {
    await Promise.all([
      putPhysicalStorageRow(
        tx,
        'attachmentCatalogAggregate',
        {
          ...aggregate,
          projectionRevision: currentRevision,
          integrityPending: false,
        },
        current,
      ),
      putPhysicalStorageRow(
        tx,
        'attachmentIntegrityState',
        completedAttachmentIntegrityState(),
        state,
      ),
    ])
    return { phase: 'aggregate', scanned: page.length, repairedAttachmentIds: [], done: true }
  }
  await putPhysicalStorageRow(
    tx,
    'attachmentIntegrityState',
    {
      id: ATTACHMENT_INTEGRITY_STATE_ID,
      repairVersion: ATTACHMENT_INTEGRITY_REPAIR_VERSION,
      phase: 'aggregate',
      aggregateRevision: currentRevision,
      aggregateAfterId: requiredLast(page, 'aggregate').id,
      aggregate,
    },
    state,
  )
  return { phase: 'aggregate', scanned: page.length, repairedAttachmentIds: [], done: false }
}

function normalizedProjectionRevision(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function requiredAggregate(state: AttachmentIntegrityStateRow): AttachmentCatalogAggregateRow {
  if (!state.aggregate) throw new Error('AttachmentIntegrityAggregateStateMissing')
  return state.aggregate
}

function requiredLast<Row>(rows: readonly Row[], phase: string): Row {
  const row = rows.at(-1)
  if (!row) throw new Error(`AttachmentIntegrityCursorMissing:${phase}`)
  return row
}

function attachmentIntegrityState(
  phase: Exclude<AttachmentIntegrityPhase, 'messages' | 'complete'>,
): AttachmentIntegrityStateRow {
  return {
    id: ATTACHMENT_INTEGRITY_STATE_ID,
    repairVersion: ATTACHMENT_INTEGRITY_REPAIR_VERSION,
    phase,
  }
}

async function readPrimaryPage<Row, Key extends IndexableType>(
  table: Table<Row, Key>,
  after: Key | undefined,
  limit: number,
): Promise<Row[]> {
  return after === undefined
    ? table.orderBy(':id').limit(limit).toArray()
    : table.where(':id').above(after).limit(limit).toArray()
}
