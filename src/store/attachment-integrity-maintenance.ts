import type { Collection, IndexableType, Table, Transaction } from 'dexie'
import type { AttachmentId, AttachmentReferenceEdge, DraftRow, MessageId } from '../core/types'
import {
  type AttachmentCatalogAggregateRow,
  type AttachmentCatalogProjectionRow,
  type AttachmentReferenceSummary,
  accumulateAttachmentCatalogProjection,
  emptyAttachmentCatalogAggregateRow,
  refreshAttachmentCatalogProjectionsForRepair,
} from './attachment-catalog-projection'
import {
  edgesForOwner,
  reconcileAttachmentRefCountSummaryForRepair,
} from './attachment-reference-edges'
import type { AttachmentHeaderRow } from './attachment-storage'
import {
  recordBrowserCommandAttachmentIntegrityMaintenance,
  recordBrowserCommandInvalidation,
} from './browser-command-mutation-journal'
import {
  deletePhysicalStorageRows,
  putPhysicalStorageRow,
  putPhysicalStorageRows,
} from './byte-owner-mutation'
import type { MessageHeaderRow } from './message-storage'
import { physicalStorageTables } from './physical-storage-tables'
import { estimateStoredValueBytes } from './storage-size-estimate'
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
const ATTACHMENT_INTEGRITY_EDGE_PAGE_ROWS = 16
const ATTACHMENT_INTEGRITY_EDGE_PAGE_BYTES = 256 * 1024

type AttachmentIntegrityPhase =
  | 'messages'
  | 'drafts'
  | 'edges'
  | 'attachments'
  | 'catalog'
  | 'aggregate'
  | 'complete'

interface AttachmentOwnerRepairCursor {
  readonly ownerKind: AttachmentReferenceEdge['ownerKind']
  readonly ownerId: string
  readonly chatId: string
  readonly revision: number
  readonly stage: 'existing' | 'desired'
  readonly observedDesiredCount: number
  readonly afterRefId?: string
  readonly afterOrdinal?: number
}

interface AttachmentReferenceCountCursor {
  readonly attachmentId: AttachmentId
  readonly projectionFingerprint: string
  readonly summary: AttachmentReferenceSummary
  readonly afterEdge?: [
    AttachmentReferenceEdge['ownerKind'],
    AttachmentReferenceEdge['ownerId'],
    AttachmentReferenceEdge['refId'],
  ]
  readonly lastOwner?: [AttachmentReferenceEdge['ownerKind'], AttachmentReferenceEdge['ownerId']]
}

export interface AttachmentIntegrityStateRow {
  readonly id: typeof ATTACHMENT_INTEGRITY_STATE_ID
  readonly repairVersion: typeof ATTACHMENT_INTEGRITY_REPAIR_VERSION
  readonly phase: AttachmentIntegrityPhase
  readonly afterMessageId?: MessageId
  readonly afterDraftId?: string
  readonly afterEdge?: [AttachmentReferenceEdge['ownerKind'], string, string]
  readonly afterAttachmentId?: AttachmentId
  readonly afterCatalogId?: AttachmentId
  readonly ownerCursor?: AttachmentOwnerRepairCursor
  readonly referenceCountCursor?: AttachmentReferenceCountCursor
  readonly aggregateRevision?: number
  readonly aggregateAfterId?: AttachmentId
  readonly aggregate?: AttachmentCatalogAggregateRow
}

export interface AttachmentIntegrityPageExecution {
  readonly observedState: AttachmentIntegrityStateRow
  readonly result: AttachmentIntegrityMaintenanceResult
}

export async function reconcileAttachmentIntegrityPage(
  tx: Transaction,
  requestedLimit: number,
  observedAt: number,
): Promise<AttachmentIntegrityPageExecution> {
  const limit = Math.max(1, Math.min(128, Math.floor(requestedLimit)))
  const states = tx.table<AttachmentIntegrityStateRow, string>('attachmentIntegrityState')
  const state = await states.get(ATTACHMENT_INTEGRITY_STATE_ID)
  if (!state) throw new Error('AttachmentIntegrityStateMissing')
  recordBrowserCommandAttachmentIntegrityMaintenance(tx)
  let result: AttachmentIntegrityMaintenanceResult
  switch (state.phase) {
    case 'messages':
      result = await reconcileMessageOwnerPage(tx, state, limit)
      break
    case 'drafts':
      result = await reconcileDraftOwnerPage(tx, state, limit)
      break
    case 'edges':
      result = await reconcileEdgePage(tx, state, limit)
      break
    case 'attachments':
      result = await reconcileAttachmentPage(tx, state, limit, observedAt)
      break
    case 'catalog':
      result = await reconcileCatalogPage(tx, state, limit)
      break
    case 'aggregate':
      result = await reconcileAggregatePage(tx, state, limit)
      break
    case 'complete':
      result = { phase: 'complete', scanned: 0, repairedAttachmentIds: [], done: true }
      break
  }
  if (result.repairedAttachmentIds.length > 0) {
    recordBrowserCommandInvalidation(tx, {
      kind: 'attachment',
      attachmentIds: result.repairedAttachmentIds,
    })
  } else if (state.phase === 'aggregate' && result.done) {
    recordBrowserCommandInvalidation(tx, { kind: 'attachment' })
  }
  return { observedState: state, result }
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
  const messages = tx.table<MessageHeaderRow, MessageId>('messages')
  const resumed =
    state.ownerCursor?.ownerKind === 'message'
      ? await messages.get(state.ownerCursor.ownerId)
      : undefined
  const message =
    resumed ??
    (state.afterMessageId === undefined
      ? await messages.orderBy(':id').first()
      : await messages.where(':id').above(state.afterMessageId).first())
  if (!message) {
    await putPhysicalStorageRow(
      tx,
      'attachmentIntegrityState',
      attachmentIntegrityState('drafts'),
      state,
    )
    return { phase: 'messages', scanned: 0, repairedAttachmentIds: [], done: false }
  }
  const owner = {
    ownerKind: 'message' as const,
    ownerId: message.id,
    chatId: message.chatId,
    refs: message.attachmentRefs,
  }
  const cursor =
    state.ownerCursor?.ownerKind === 'message' &&
    state.ownerCursor.ownerId === message.id &&
    state.ownerCursor.revision === message.nodeVersion
      ? state.ownerCursor
      : initialAttachmentOwnerRepairCursor(owner, message.nodeVersion)
  const page = await reconcileAttachmentOwnerEdgePage(tx, owner, cursor, limit)
  await putPhysicalStorageRow<AttachmentIntegrityStateRow, string>(
    tx,
    'attachmentIntegrityState',
    page.done
      ? {
          id: ATTACHMENT_INTEGRITY_STATE_ID,
          repairVersion: ATTACHMENT_INTEGRITY_REPAIR_VERSION,
          phase: 'messages',
          afterMessageId: message.id,
        }
      : {
          id: ATTACHMENT_INTEGRITY_STATE_ID,
          repairVersion: ATTACHMENT_INTEGRITY_REPAIR_VERSION,
          phase: 'messages',
          ...(state.afterMessageId === undefined ? {} : { afterMessageId: state.afterMessageId }),
          ownerCursor: page.cursor,
        },
    state,
  )
  return {
    phase: 'messages',
    scanned: page.scanned,
    repairedAttachmentIds: page.repairedAttachmentIds,
    done: false,
  }
}

async function reconcileDraftOwnerPage(
  tx: Transaction,
  state: AttachmentIntegrityStateRow,
  limit: number,
): Promise<AttachmentIntegrityMaintenanceResult> {
  const drafts = tx.table<DraftRow, string>('drafts')
  const resumed =
    state.ownerCursor?.ownerKind === 'draft'
      ? await drafts.get(state.ownerCursor.ownerId)
      : undefined
  const draft =
    resumed ??
    (state.afterDraftId === undefined
      ? await drafts.orderBy(':id').first()
      : await drafts.where(':id').above(state.afterDraftId).first())
  if (!draft) {
    await putPhysicalStorageRow(
      tx,
      'attachmentIntegrityState',
      attachmentIntegrityState('edges'),
      state,
    )
    return { phase: 'drafts', scanned: 0, repairedAttachmentIds: [], done: false }
  }
  const owner = {
    ownerKind: 'draft' as const,
    ownerId: draft.chatId,
    chatId: draft.chatId,
    refs: draft.attachmentRefs,
  }
  const cursor =
    state.ownerCursor?.ownerKind === 'draft' &&
    state.ownerCursor.ownerId === draft.chatId &&
    state.ownerCursor.revision === draft.updatedAt
      ? state.ownerCursor
      : initialAttachmentOwnerRepairCursor(owner, draft.updatedAt)
  const page = await reconcileAttachmentOwnerEdgePage(tx, owner, cursor, limit)
  await putPhysicalStorageRow<AttachmentIntegrityStateRow, string>(
    tx,
    'attachmentIntegrityState',
    page.done
      ? {
          id: ATTACHMENT_INTEGRITY_STATE_ID,
          repairVersion: ATTACHMENT_INTEGRITY_REPAIR_VERSION,
          phase: 'drafts',
          afterDraftId: draft.chatId,
        }
      : {
          id: ATTACHMENT_INTEGRITY_STATE_ID,
          repairVersion: ATTACHMENT_INTEGRITY_REPAIR_VERSION,
          phase: 'drafts',
          ...(state.afterDraftId === undefined ? {} : { afterDraftId: state.afterDraftId }),
          ownerCursor: page.cursor,
        },
    state,
  )
  return {
    phase: 'drafts',
    scanned: page.scanned,
    repairedAttachmentIds: page.repairedAttachmentIds,
    done: false,
  }
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
  const missingMessageOwners = new Set(
    messageOwners.flatMap((owner, index) => (messages[index] ? [] : [owner.ownerId])),
  )
  const missingDraftOwners = new Set(
    draftOwners.flatMap((owner, index) => (drafts[index] ? [] : [owner.ownerId])),
  )
  const orphanEdges = page.filter((edge) =>
    edge.ownerKind === 'message'
      ? missingMessageOwners.has(edge.ownerId)
      : missingDraftOwners.has(edge.ownerId),
  )
  await deletePhysicalStorageRows(
    tx,
    'attachmentRefEdges',
    orphanEdges.map((edge) => [edge.ownerKind, edge.ownerId, edge.refId]),
    orphanEdges,
  )
  const repairedAttachmentIds = [...new Set(orphanEdges.map((edge) => edge.attachmentId))]
  const done = page.length < limit
  await putPhysicalStorageRow<AttachmentIntegrityStateRow, string>(
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
  observedAt: number,
): Promise<AttachmentIntegrityMaintenanceResult> {
  const table = tx.table<AttachmentHeaderRow, AttachmentId>('attachments')
  const resumed = state.referenceCountCursor
    ? await table.get(state.referenceCountCursor.attachmentId)
    : undefined
  const attachment =
    resumed ??
    (state.afterAttachmentId === undefined
      ? await table.orderBy(':id').first()
      : await table.where(':id').above(state.afterAttachmentId).first())
  if (!attachment) {
    await putPhysicalStorageRow(
      tx,
      'attachmentIntegrityState',
      attachmentIntegrityState('catalog'),
      state,
    )
    return { phase: 'attachments', scanned: 0, repairedAttachmentIds: [], done: false }
  }
  const page = await reconcileAttachmentReferenceCountPage(
    tx,
    attachment,
    state.referenceCountCursor,
    limit,
    observedAt,
  )
  await putPhysicalStorageRow<AttachmentIntegrityStateRow, string>(
    tx,
    'attachmentIntegrityState',
    page.done
      ? {
          id: ATTACHMENT_INTEGRITY_STATE_ID,
          repairVersion: ATTACHMENT_INTEGRITY_REPAIR_VERSION,
          phase: 'attachments',
          afterAttachmentId: attachment.id,
        }
      : {
          id: ATTACHMENT_INTEGRITY_STATE_ID,
          repairVersion: ATTACHMENT_INTEGRITY_REPAIR_VERSION,
          phase: 'attachments',
          ...(state.afterAttachmentId === undefined
            ? {}
            : { afterAttachmentId: state.afterAttachmentId }),
          referenceCountCursor: page.cursor,
        },
    state,
  )
  return {
    phase: 'attachments',
    scanned: page.scanned,
    repairedAttachmentIds: page.repairedAttachmentIds,
    done: false,
  }
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
  const repairedAttachmentIds = await refreshAttachmentCatalogProjectionsForRepair(tx, orphanIds)
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
    repairedAttachmentIds,
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

function initialAttachmentOwnerRepairCursor(
  owner: {
    readonly ownerKind: AttachmentReferenceEdge['ownerKind']
    readonly ownerId: string
    readonly chatId: string
  },
  revision: number,
): AttachmentOwnerRepairCursor {
  return {
    ownerKind: owner.ownerKind,
    ownerId: owner.ownerId,
    chatId: owner.chatId,
    revision,
    stage: 'existing',
    observedDesiredCount: 0,
  }
}

async function reconcileAttachmentOwnerEdgePage(
  tx: Transaction,
  owner: {
    readonly ownerKind: AttachmentReferenceEdge['ownerKind']
    readonly ownerId: string
    readonly chatId: string
    readonly refs: MessageHeaderRow['attachmentRefs']
  },
  cursor: AttachmentOwnerRepairCursor,
  requestedLimit: number,
): Promise<{
  readonly done: boolean
  readonly scanned: number
  readonly repairedAttachmentIds: readonly AttachmentId[]
  readonly cursor: AttachmentOwnerRepairCursor
}> {
  const limit = Math.min(requestedLimit, ATTACHMENT_INTEGRITY_EDGE_PAGE_ROWS)
  const table = tx.table<
    AttachmentReferenceEdge,
    [
      AttachmentReferenceEdge['ownerKind'],
      AttachmentReferenceEdge['ownerId'],
      AttachmentReferenceEdge['refId'],
    ]
  >('attachmentRefEdges')
  const desired = edgesForOwner(owner)
  if (cursor.stage === 'existing') {
    const desiredByRefId = new Map(desired.map((edge) => [edge.refId, edge]))
    const lower = [owner.ownerKind, owner.ownerId, cursor.afterRefId ?? ''] as [
      AttachmentReferenceEdge['ownerKind'],
      AttachmentReferenceEdge['ownerId'],
      AttachmentReferenceEdge['refId'],
    ]
    const upper = [owner.ownerKind, owner.ownerId, []] as [
      AttachmentReferenceEdge['ownerKind'],
      AttachmentReferenceEdge['ownerId'],
      readonly never[],
    ]
    const page = await readBoundedCollection(
      table.where(':id').between(lower, upper, cursor.afterRefId === undefined, true),
      limit,
    )
    const deleted: AttachmentReferenceEdge[] = []
    const replaced: AttachmentReferenceEdge[] = []
    const stored: AttachmentReferenceEdge[] = []
    const repairedAttachmentIds = new Set<AttachmentId>()
    let observedDesiredCount = cursor.observedDesiredCount
    for (const previous of page.rows) {
      const next = desiredByRefId.get(previous.refId)
      if (next) observedDesiredCount += 1
      if (next && sameAttachmentReferenceEdge(previous, next)) continue
      repairedAttachmentIds.add(previous.attachmentId)
      if (next) {
        repairedAttachmentIds.add(next.attachmentId)
        replaced.push(previous)
        stored.push(next)
      } else {
        deleted.push(previous)
      }
    }
    await requireAttachmentTargets(
      tx,
      stored.map((edge) => edge.attachmentId),
    )
    await deletePhysicalStorageRows(
      tx,
      'attachmentRefEdges',
      deleted.map((edge) => [edge.ownerKind, edge.ownerId, edge.refId]),
      deleted,
    )
    await putPhysicalStorageRows(tx, 'attachmentRefEdges', stored, replaced)
    if (!page.exhausted) {
      return {
        done: false,
        scanned: page.rows.length,
        repairedAttachmentIds: [...repairedAttachmentIds],
        cursor: {
          ...cursor,
          observedDesiredCount,
          afterRefId: requiredLast(page.rows, 'owner-existing-edge').refId,
        },
      }
    }
    if (observedDesiredCount === desired.length) {
      return {
        done: true,
        scanned: page.rows.length,
        repairedAttachmentIds: [...repairedAttachmentIds],
        cursor,
      }
    }
    return {
      done: false,
      scanned: page.rows.length,
      repairedAttachmentIds: [...repairedAttachmentIds],
      cursor: {
        ownerKind: cursor.ownerKind,
        ownerId: cursor.ownerId,
        chatId: cursor.chatId,
        revision: cursor.revision,
        stage: 'desired',
        observedDesiredCount,
      },
    }
  }

  const remaining = desired.filter((edge) => edge.ordinal > (cursor.afterOrdinal ?? -1))
  const page = boundedValues(remaining, limit)
  const keys = page.rows.map(
    (edge) =>
      [edge.ownerKind, edge.ownerId, edge.refId] as [
        AttachmentReferenceEdge['ownerKind'],
        AttachmentReferenceEdge['ownerId'],
        AttachmentReferenceEdge['refId'],
      ],
  )
  const previous = await table.bulkGet(keys)
  const changes = page.rows.flatMap((next, index) => {
    const before = previous[index]
    return before && sameAttachmentReferenceEdge(before, next) ? [] : [{ before, next }]
  })
  await requireAttachmentTargets(
    tx,
    changes.map(({ next }) => next.attachmentId),
  )
  await putPhysicalStorageRows(
    tx,
    'attachmentRefEdges',
    changes.map(({ next }) => next),
    changes.flatMap(({ before }) => (before ? [before] : [])),
  )
  const repairedAttachmentIds = new Set<AttachmentId>()
  for (const { before, next } of changes) {
    if (before) repairedAttachmentIds.add(before.attachmentId)
    repairedAttachmentIds.add(next.attachmentId)
  }
  return {
    done: page.exhausted,
    scanned: page.rows.length,
    repairedAttachmentIds: [...repairedAttachmentIds],
    cursor: page.exhausted
      ? cursor
      : {
          ...cursor,
          afterOrdinal: requiredLast(page.rows, 'owner-desired-edge').ordinal,
        },
  }
}

async function reconcileAttachmentReferenceCountPage(
  tx: Transaction,
  attachment: AttachmentHeaderRow,
  previousCursor: AttachmentReferenceCountCursor | undefined,
  requestedLimit: number,
  observedAt: number,
): Promise<{
  readonly done: boolean
  readonly scanned: number
  readonly repairedAttachmentIds: readonly AttachmentId[]
  readonly cursor: AttachmentReferenceCountCursor
}> {
  const catalog = await tx
    .table<AttachmentCatalogProjectionRow, AttachmentId>('attachmentCatalogRows')
    .get(attachment.id)
  const projectionFingerprint = attachmentProjectionFingerprint(catalog)
  const cursor =
    previousCursor?.attachmentId === attachment.id &&
    previousCursor.projectionFingerprint === projectionFingerprint
      ? previousCursor
      : {
          attachmentId: attachment.id,
          projectionFingerprint,
          summary: emptyAttachmentReferenceSummary(),
        }
  const lower = cursor.afterEdge
    ? ([attachment.id, ...cursor.afterEdge] as [
        AttachmentId,
        AttachmentReferenceEdge['ownerKind'],
        AttachmentReferenceEdge['ownerId'],
        AttachmentReferenceEdge['refId'],
      ])
    : ([attachment.id, '', '', ''] as [AttachmentId, string, string, string])
  const upper = [attachment.id, [], [], []] as [
    AttachmentId,
    readonly never[],
    readonly never[],
    readonly never[],
  ]
  const page = await readBoundedCollection(
    tx
      .table<AttachmentReferenceEdge>('attachmentRefEdges')
      .where('[attachmentId+ownerKind+ownerId+refId]')
      .between(lower, upper, cursor.afterEdge === undefined, true),
    Math.min(requestedLimit, ATTACHMENT_INTEGRITY_EDGE_PAGE_ROWS),
  )
  const summary = { ...cursor.summary }
  let lastOwner = cursor.lastOwner
  for (const edge of page.rows) {
    const newOwner = lastOwner?.[0] !== edge.ownerKind || lastOwner[1] !== edge.ownerId
    summary.refCount += 1
    summary.messageRefCount += Number(newOwner && edge.ownerKind === 'message')
    summary.draftRefCount += Number(newOwner && edge.ownerKind === 'draft')
    summary.visibleRefCount += Number(edge.includeInContext)
    lastOwner = [edge.ownerKind, edge.ownerId]
  }
  if (page.exhausted) {
    const repairedAttachmentIds = await reconcileAttachmentRefCountSummaryForRepair(
      tx,
      attachment.id,
      summary,
      observedAt,
    )
    return {
      done: true,
      scanned: page.rows.length,
      repairedAttachmentIds,
      cursor,
    }
  }
  const last = requiredLast(page.rows, 'attachment-reference-edge')
  return {
    done: false,
    scanned: page.rows.length,
    repairedAttachmentIds: [],
    cursor: {
      ...cursor,
      summary,
      afterEdge: [last.ownerKind, last.ownerId, last.refId],
      ...(lastOwner ? { lastOwner } : {}),
    },
  }
}

async function readBoundedCollection<Row, Key>(
  collection: Collection<Row, Key>,
  limit: number,
): Promise<{ readonly rows: readonly Row[]; readonly exhausted: boolean }> {
  const rows: Row[] = []
  let bytes = 0
  let bounded = false
  await collection
    .until((row) => {
      const rowBytes = estimateStoredValueBytes(row)
      const stop =
        rows.length >= limit ||
        (rows.length > 0 && bytes + rowBytes > ATTACHMENT_INTEGRITY_EDGE_PAGE_BYTES)
      if (stop) bounded = true
      return stop
    })
    .each((row) => {
      const rowBytes = estimateStoredValueBytes(row)
      rows.push(row)
      bytes += rowBytes
    })
  return { rows, exhausted: !bounded }
}

function boundedValues<Row>(
  values: readonly Row[],
  limit: number,
): { readonly rows: readonly Row[]; readonly exhausted: boolean } {
  const rows: Row[] = []
  let bytes = 0
  for (const value of values) {
    const valueBytes = estimateStoredValueBytes(value)
    if (
      rows.length >= limit ||
      (rows.length > 0 && bytes + valueBytes > ATTACHMENT_INTEGRITY_EDGE_PAGE_BYTES)
    ) {
      return { rows, exhausted: false }
    }
    rows.push(value)
    bytes += valueBytes
  }
  return { rows, exhausted: true }
}

async function requireAttachmentTargets(
  tx: Transaction,
  attachmentIds: readonly AttachmentId[],
): Promise<void> {
  const ids = [...new Set(attachmentIds)]
  if (ids.length === 0) return
  const headers = await tx.table<AttachmentHeaderRow, AttachmentId>('attachments').bulkGet(ids)
  for (let index = 0; index < ids.length; index += 1) {
    if (!headers[index]) throw new Error(`AttachmentMissing:${ids[index]}`)
  }
}

function sameAttachmentReferenceEdge(
  left: AttachmentReferenceEdge,
  right: AttachmentReferenceEdge,
): boolean {
  return (
    left.ownerKind === right.ownerKind &&
    left.ownerId === right.ownerId &&
    left.chatId === right.chatId &&
    left.refId === right.refId &&
    left.attachmentId === right.attachmentId &&
    left.ordinal === right.ordinal &&
    left.includeInContext === right.includeInContext &&
    left.refUpdatedAt === right.refUpdatedAt
  )
}

function attachmentProjectionFingerprint(row: AttachmentCatalogProjectionRow | undefined): string {
  return row
    ? `${row.refCount}:${row.messageRefCount}:${row.draftRefCount}:${row.visibleRefCount}`
    : 'missing'
}

function emptyAttachmentReferenceSummary(): AttachmentReferenceSummary {
  return { refCount: 0, messageRefCount: 0, draftRefCount: 0, visibleRefCount: 0 }
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
