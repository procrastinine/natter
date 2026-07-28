import type { Transaction } from 'dexie'
import type { AttachmentId, AttachmentRef, AttachmentReferenceEdge, ChatId } from '../core/types'
import {
  type AttachmentCatalogReferenceDelta,
  type AttachmentCatalogReferenceMutationReceipt,
  type AttachmentReferenceSummary,
  applyAttachmentCatalogReferenceDeltas,
  readAttachmentCatalogRepairSnapshot,
  refreshAttachmentCatalogProjectionsForRepair,
} from './attachment-catalog-projection'
import type { AttachmentHeaderRow } from './attachment-storage'
import {
  recordBrowserCommandAttachmentReferenceState,
  recordBrowserCommandOwnerInvalidation,
} from './browser-command-mutation-journal'
import {
  deletePhysicalStorageRows,
  putPhysicalStorageRows,
  replaceAttachmentHeaderByteOwnerBatch,
} from './byte-owner-mutation'
import {
  absorbSemanticOperationReceiptFragment,
  type SemanticOperationReceiptFragment,
  semanticOperationReceiptFragment,
} from './semantic-operation-capability'

export interface AttachmentReferenceOwner {
  ownerKind: AttachmentReferenceEdge['ownerKind']
  ownerId: string
  chatId: ChatId
  refs: readonly AttachmentRef[] | undefined
}

export interface AttachmentReferenceOwnerTransition {
  readonly ownerKind: AttachmentReferenceEdge['ownerKind']
  readonly ownerId: string
  readonly chatId: ChatId
  readonly previousRefs: readonly AttachmentRef[] | undefined
  readonly nextRefs: readonly AttachmentRef[] | undefined
}

export interface AttachmentReferenceMutationEffects {
  readonly changedAttachmentIds: readonly AttachmentId[]
  readonly newlyUnreferencedAttachmentIds: readonly AttachmentId[]
}

type AttachmentReferenceReceiptTableName =
  | 'attachments'
  | 'attachmentRefEdges'
  | 'attachmentCatalogRows'
  | 'attachmentCatalogAggregate'

export interface AttachmentReferenceTransitionReceipt extends AttachmentReferenceMutationEffects {
  readonly targetReadIds: readonly AttachmentId[]
  readonly removedEdgeKeys: readonly (readonly [
    AttachmentReferenceEdge['ownerKind'],
    string,
    string,
  ])[]
  readonly writtenEdgeKeys: readonly (readonly [
    AttachmentReferenceEdge['ownerKind'],
    string,
    string,
  ])[]
  readonly headerReadIds: readonly AttachmentId[]
  readonly headerWriteIds: readonly AttachmentId[]
  readonly fragment: SemanticOperationReceiptFragment<AttachmentReferenceReceiptTableName>
}

interface AttachmentReferenceDeltaReceipt extends AttachmentReferenceMutationEffects {
  readonly headerReadIds: readonly AttachmentId[]
  readonly headerWriteIds: readonly AttachmentId[]
  readonly catalog: AttachmentCatalogReferenceMutationReceipt
}

interface AttachmentOwnerReferenceSummary {
  readonly occurrences: number
  readonly visibleOccurrences: number
}

const EMPTY_OWNER_REFERENCE_SUMMARY: AttachmentOwnerReferenceSummary = Object.freeze({
  occurrences: 0,
  visibleOccurrences: 0,
})

interface MutableAttachmentReferenceDelta {
  attachmentId: AttachmentId
  refCount: number
  messageRefCount: number
  draftRefCount: number
  visibleRefCount: number
}

class AttachmentReferenceTargetMissingError extends Error {
  readonly attachmentId: AttachmentId

  constructor(attachmentId: AttachmentId) {
    super(`AttachmentMissing:${attachmentId}`)
    this.name = 'AttachmentReferenceTargetMissingError'
    this.attachmentId = attachmentId
  }
}

class DuplicateAttachmentRefIdError extends Error {
  readonly ownerKind: AttachmentReferenceEdge['ownerKind']
  readonly ownerId: string
  readonly refId: string

  constructor(ownerKind: AttachmentReferenceEdge['ownerKind'], ownerId: string, refId: string) {
    super(`DuplicateAttachmentRefId:${ownerKind}:${ownerId}:${refId}`)
    this.name = 'DuplicateAttachmentRefIdError'
    this.ownerKind = ownerKind
    this.ownerId = ownerId
    this.refId = refId
  }
}

class DuplicateAttachmentReferenceOwnerError extends Error {
  constructor(ownerKind: AttachmentReferenceEdge['ownerKind'], ownerId: string) {
    super(`DuplicateAttachmentReferenceOwner:${ownerKind}:${ownerId}`)
    this.name = 'DuplicateAttachmentReferenceOwnerError'
  }
}

export async function applyAttachmentReferenceOwnerTransitions(
  tx: Transaction,
  transitions: readonly AttachmentReferenceOwnerTransition[],
  observedAt: number,
  assertAttachmentScope?: (attachmentId: AttachmentId) => void,
  validateUnchangedTargets = false,
): Promise<AttachmentReferenceTransitionReceipt> {
  if (transitions.length === 0) {
    return attachmentReferenceTransitionReceipt([], [], [], emptyAttachmentReferenceDeltaReceipt())
  }
  const ownerKeys = new Set<string>()
  const validationTargetIds = new Set<AttachmentId>()
  const planned = transitions.map((transition) => {
    const ownerKey = attachmentOwnerKey(transition.ownerKind, transition.ownerId)
    if (ownerKeys.has(ownerKey)) {
      throw new DuplicateAttachmentReferenceOwnerError(transition.ownerKind, transition.ownerId)
    }
    ownerKeys.add(ownerKey)
    const nextEdges = edgesForOwner({
      ownerKind: transition.ownerKind,
      ownerId: transition.ownerId,
      chatId: transition.chatId,
      refs: transition.nextRefs,
    })
    if (validateUnchangedTargets) {
      for (const edge of nextEdges) validationTargetIds.add(edge.attachmentId)
    }
    return {
      transition,
      previousEdges: edgesForOwner({
        ownerKind: transition.ownerKind,
        ownerId: transition.ownerId,
        chatId: transition.chatId,
        refs: transition.previousRefs,
      }),
      nextEdges,
    }
  })
  await requireAttachmentTargets(tx, [...validationTargetIds])
  const removedEdges: AttachmentReferenceEdge[] = []
  const changedEdges: AttachmentReferenceEdge[] = []
  const replacedEdges: AttachmentReferenceEdge[] = []
  const deltas = new Map<AttachmentId, MutableAttachmentReferenceDelta>()
  for (const { transition, previousEdges, nextEdges } of planned) {
    const previousByRefId = new Map(previousEdges.map((edge) => [edge.refId, edge]))
    const nextByRefId = new Map(nextEdges.map((edge) => [edge.refId, edge]))
    for (const previous of previousEdges) {
      if (!nextByRefId.has(previous.refId)) removedEdges.push(previous)
    }
    for (const next of nextEdges) {
      const previous = previousByRefId.get(next.refId)
      if (!previous || !sameAttachmentReferenceEdge(previous, next)) {
        changedEdges.push(next)
        if (previous) replacedEdges.push(previous)
      }
    }
    const previousSummaries = attachmentOwnerReferenceSummaries(previousEdges)
    const nextSummaries = attachmentOwnerReferenceSummaries(nextEdges)
    const attachmentIds = new Set([...previousSummaries.keys(), ...nextSummaries.keys()])
    for (const attachmentId of attachmentIds) {
      const previous = previousSummaries.get(attachmentId) ?? EMPTY_OWNER_REFERENCE_SUMMARY
      const next = nextSummaries.get(attachmentId) ?? EMPTY_OWNER_REFERENCE_SUMMARY
      const refCount = next.occurrences - previous.occurrences
      const visibleRefCount = next.visibleOccurrences - previous.visibleOccurrences
      const ownerPresence = Number(next.occurrences > 0) - Number(previous.occurrences > 0)
      if (refCount === 0 && visibleRefCount === 0 && ownerPresence === 0) continue
      assertAttachmentScope?.(attachmentId)
      const delta = deltas.get(attachmentId) ?? {
        attachmentId,
        refCount: 0,
        messageRefCount: 0,
        draftRefCount: 0,
        visibleRefCount: 0,
      }
      delta.refCount += refCount
      delta.visibleRefCount += visibleRefCount
      if (transition.ownerKind === 'message') delta.messageRefCount += ownerPresence
      else delta.draftRefCount += ownerPresence
      deltas.set(attachmentId, delta)
    }
  }
  if (deltas.size === 0 && removedEdges.length === 0 && changedEdges.length === 0) {
    const receipt = attachmentReferenceTransitionReceipt(
      [...validationTargetIds],
      [],
      [],
      emptyAttachmentReferenceDeltaReceipt(),
    )
    absorbSemanticOperationReceiptFragment(tx, receipt.fragment)
    return receipt
  }

  await deletePhysicalStorageRows(
    tx,
    'attachmentRefEdges',
    removedEdges.map((edge) => [edge.ownerKind, edge.ownerId, edge.refId]),
    removedEdges,
  )
  await putPhysicalStorageRows(tx, 'attachmentRefEdges', changedEdges, replacedEdges)
  const deltasReceipt = await applyAttachmentReferenceDeltas(tx, [...deltas.values()], observedAt)
  const receipt = attachmentReferenceTransitionReceipt(
    [...validationTargetIds],
    removedEdges,
    changedEdges,
    deltasReceipt,
  )
  for (const dependency of receipt.fragment.dependencies) {
    recordBrowserCommandOwnerInvalidation(tx, dependency)
  }
  absorbSemanticOperationReceiptFragment(tx, receipt.fragment)
  return receipt
}

async function applyAttachmentReferenceDeltas(
  tx: Transaction,
  deltas: readonly MutableAttachmentReferenceDelta[],
  observedAt: number,
): Promise<AttachmentReferenceDeltaReceipt> {
  const attachmentIds = deltas.map((delta) => delta.attachmentId)
  if (attachmentIds.length === 0) {
    return emptyAttachmentReferenceDeltaReceipt()
  }
  const previousHeaders = await tx
    .table<AttachmentHeaderRow, AttachmentId>('attachments')
    .bulkGet(attachmentIds)
  const changedPreviousHeaders: AttachmentHeaderRow[] = []
  const changedNextHeaders: AttachmentHeaderRow[] = []
  const catalogDeltas: AttachmentCatalogReferenceDelta[] = []
  const newlyUnreferencedAttachmentIds: AttachmentId[] = []
  for (let index = 0; index < attachmentIds.length; index += 1) {
    const attachmentId = attachmentIds[index] as AttachmentId
    const previousHeader = previousHeaders[index]
    const delta = deltas[index]
    if (!previousHeader || !delta) throw new AttachmentReferenceTargetMissingError(attachmentId)
    const nextRefCount = previousHeader.refCount + delta.refCount
    if (!Number.isSafeInteger(nextRefCount) || nextRefCount < 0) {
      throw new Error(`AttachmentReferenceCountInvalid:${attachmentId}`)
    }
    const nextHeader = reconcileAttachmentReferenceCount(previousHeader, nextRefCount, observedAt)
    if (nextHeader !== previousHeader) {
      changedPreviousHeaders.push(previousHeader)
      changedNextHeaders.push(nextHeader)
    }
    catalogDeltas.push({ ...delta, previousHeader, nextHeader })
    recordBrowserCommandAttachmentReferenceState(tx, {
      attachmentId,
      initial: { exists: true, refCount: previousHeader.refCount },
      final: { exists: true, refCount: nextHeader.refCount },
      projectionChanged: true,
    })
    if (previousHeader.refCount > 0 && nextHeader.refCount === 0) {
      newlyUnreferencedAttachmentIds.push(attachmentId)
    }
  }
  if (changedNextHeaders.length > 0) {
    await replaceAttachmentHeaderByteOwnerBatch(tx, changedNextHeaders, changedPreviousHeaders)
  }
  const catalog = await applyAttachmentCatalogReferenceDeltas(tx, catalogDeltas)
  return {
    changedAttachmentIds: Object.freeze(attachmentIds),
    newlyUnreferencedAttachmentIds: Object.freeze(newlyUnreferencedAttachmentIds),
    headerReadIds: Object.freeze(attachmentIds),
    headerWriteIds: Object.freeze(changedNextHeaders.map(({ id }) => id)),
    catalog,
  }
}

function emptyAttachmentReferenceDeltaReceipt(): AttachmentReferenceDeltaReceipt {
  return {
    changedAttachmentIds: Object.freeze([]),
    newlyUnreferencedAttachmentIds: Object.freeze([]),
    headerReadIds: Object.freeze([]),
    headerWriteIds: Object.freeze([]),
    catalog: Object.freeze({
      rowReadIds: Object.freeze([]),
      rowWriteIds: Object.freeze([]),
      aggregateRead: false,
      aggregateWrite: false,
      fragment: semanticOperationReceiptFragment<
        'attachmentCatalogRows' | 'attachmentCatalogAggregate'
      >({}),
    }),
  }
}

function attachmentReferenceTransitionReceipt(
  targetReadIds: readonly AttachmentId[],
  removedEdges: readonly AttachmentReferenceEdge[],
  writtenEdges: readonly AttachmentReferenceEdge[],
  delta: AttachmentReferenceDeltaReceipt,
): AttachmentReferenceTransitionReceipt {
  const removedEdgeKeys = removedEdges.map(
    ({ ownerKind, ownerId, refId }) => [ownerKind, ownerId, refId] as const,
  )
  const writtenEdgeKeys = writtenEdges.map(
    ({ ownerKind, ownerId, refId }) => [ownerKind, ownerId, refId] as const,
  )
  const mutationAttachmentIds = [
    ...new Set([
      ...delta.changedAttachmentIds,
      ...removedEdges.map(({ attachmentId }) => attachmentId),
      ...writtenEdges.map(({ attachmentId }) => attachmentId),
    ]),
  ].sort()
  return Object.freeze({
    changedAttachmentIds: Object.freeze([...delta.changedAttachmentIds]),
    newlyUnreferencedAttachmentIds: Object.freeze([...delta.newlyUnreferencedAttachmentIds]),
    targetReadIds: Object.freeze([...targetReadIds]),
    removedEdgeKeys: Object.freeze(removedEdgeKeys),
    writtenEdgeKeys: Object.freeze(writtenEdgeKeys),
    headerReadIds: Object.freeze([...delta.headerReadIds]),
    headerWriteIds: Object.freeze([...delta.headerWriteIds]),
    fragment: semanticOperationReceiptFragment({
      dependencies:
        mutationAttachmentIds.length > 0
          ? [{ kind: 'attachment', attachmentIds: mutationAttachmentIds }]
          : [],
      physicalMutations: [
        ...removedEdgeKeys.map((key) => ({
          tableName: 'attachmentRefEdges' as const,
          operation: 'delete' as const,
          key,
        })),
        ...writtenEdgeKeys.map((key) => ({
          tableName: 'attachmentRefEdges' as const,
          operation: 'write' as const,
          key,
        })),
        ...delta.headerWriteIds.map((key) => ({
          tableName: 'attachments' as const,
          operation: 'write' as const,
          key,
        })),
        ...delta.catalog.fragment.physicalMutations,
      ],
      physicalReads: [
        ...(targetReadIds.length > 0
          ? [
              {
                tableName: 'attachments' as const,
                indexKind: 'primary' as const,
                operation: 'get-many' as const,
                requestCount: 1,
                rowCount: targetReadIds.length,
              },
            ]
          : []),
        ...(delta.headerReadIds.length > 0
          ? [
              {
                tableName: 'attachments' as const,
                indexKind: 'primary' as const,
                operation: 'get-many' as const,
                requestCount: 1,
                rowCount: delta.headerReadIds.length,
              },
            ]
          : []),
        ...delta.catalog.fragment.physicalReads,
      ],
    }),
  })
}

export async function replaceAttachmentReferenceOwnersForRepair(
  tx: Transaction,
  owners: readonly AttachmentReferenceOwner[],
  assertAttachmentScope?: (attachmentId: AttachmentId) => void,
): Promise<AttachmentId[]> {
  if (owners.length === 0) return []
  const edgeTable = tx.table<AttachmentReferenceEdge, [string, string, string]>(
    'attachmentRefEdges',
  )
  const planned = owners.map((owner) => ({ owner, edges: edgesForOwner(owner) }))
  const ownerKeys = new Set<string>()
  for (const { owner } of planned) {
    const key = `${owner.ownerKind}:${owner.ownerId}`
    if (ownerKeys.has(key)) {
      throw new DuplicateAttachmentReferenceOwnerError(owner.ownerKind, owner.ownerId)
    }
    ownerKeys.add(key)
  }

  const existingEdges = await edgeTable
    .where('[ownerKind+ownerId]')
    .anyOf(planned.map(({ owner }) => [owner.ownerKind, owner.ownerId]))
    .toArray()
  const existingByOwner = new Map<string, AttachmentReferenceEdge[]>()
  for (const edge of existingEdges) {
    const key = attachmentOwnerKey(edge.ownerKind, edge.ownerId)
    const rows = existingByOwner.get(key)
    if (rows) rows.push(edge)
    else existingByOwner.set(key, [edge])
  }
  const targetIds = new Set<AttachmentId>()
  for (const { edges } of planned) {
    for (const edge of edges) targetIds.add(edge.attachmentId)
  }
  await requireAttachmentTargets(tx, [...targetIds])

  const dirtyIds = new Set<AttachmentId>()
  const changedOwners = new Set<number>()
  for (let index = 0; index < planned.length; index += 1) {
    const nextEdges = planned[index]?.edges ?? []
    const owner = planned[index]?.owner
    if (!owner) continue
    const previousEdges =
      existingByOwner.get(attachmentOwnerKey(owner.ownerKind, owner.ownerId)) ?? []
    if (sameOwnerEdges(previousEdges, nextEdges)) continue
    changedOwners.add(index)
    for (const attachmentId of changedAttachmentProjections(previousEdges, nextEdges)) {
      assertAttachmentScope?.(attachmentId)
      dirtyIds.add(attachmentId)
    }
  }

  const changedOwnerKeys = new Set(
    [...changedOwners].flatMap((index) => {
      const owner = planned[index]?.owner
      return owner ? [attachmentOwnerKey(owner.ownerKind, owner.ownerId)] : []
    }),
  )
  const obsoleteKeys = existingEdges
    .filter((edge) => changedOwnerKeys.has(attachmentOwnerKey(edge.ownerKind, edge.ownerId)))
    .map(
      (edge) =>
        [edge.ownerKind, edge.ownerId, edge.refId] as [
          AttachmentReferenceEdge['ownerKind'],
          string,
          string,
        ],
    )
  const obsoleteEdges = existingEdges.filter((edge) =>
    changedOwnerKeys.has(attachmentOwnerKey(edge.ownerKind, edge.ownerId)),
  )
  await deletePhysicalStorageRows(tx, 'attachmentRefEdges', obsoleteKeys, obsoleteEdges)
  const nextEdges = planned.flatMap(({ edges }, index) => (changedOwners.has(index) ? edges : []))
  await putPhysicalStorageRows(tx, 'attachmentRefEdges', nextEdges, [])
  return [...dirtyIds]
}

export async function deleteAttachmentReferenceEdgesForChats(
  tx: Transaction,
  chatIds: readonly ChatId[],
  observedAt: number,
): Promise<AttachmentId[]> {
  const uniqueChatIds = [...new Set(chatIds)]
  if (uniqueChatIds.length === 0) return []
  const edgeTable = tx.table<AttachmentReferenceEdge, [string, string, string]>(
    'attachmentRefEdges',
  )
  const edges = await edgeTable.where('chatId').anyOf(uniqueChatIds).toArray()
  if (edges.length === 0) return []
  const deltas = new Map<AttachmentId, MutableAttachmentReferenceDelta>()
  const ownerAttachments = new Set<string>()
  for (const edge of edges) {
    const delta = deltas.get(edge.attachmentId) ?? {
      attachmentId: edge.attachmentId,
      refCount: 0,
      messageRefCount: 0,
      draftRefCount: 0,
      visibleRefCount: 0,
    }
    delta.refCount -= 1
    if (edge.includeInContext) delta.visibleRefCount -= 1
    const ownerAttachment = `${attachmentOwnerKey(edge.ownerKind, edge.ownerId)}\u0000${edge.attachmentId}`
    if (!ownerAttachments.has(ownerAttachment)) {
      ownerAttachments.add(ownerAttachment)
      if (edge.ownerKind === 'message') delta.messageRefCount -= 1
      else delta.draftRefCount -= 1
    }
    deltas.set(edge.attachmentId, delta)
  }
  await deletePhysicalStorageRows(
    tx,
    'attachmentRefEdges',
    edges.map((edge) => [edge.ownerKind, edge.ownerId, edge.refId]),
    edges,
  )
  const effects = await applyAttachmentReferenceDeltas(tx, [...deltas.values()], observedAt)
  return [...effects.changedAttachmentIds]
}

export async function reconcileAttachmentRefCountsForRepair(
  tx: Transaction,
  attachmentIds: Iterable<AttachmentId>,
  observedAt: number,
): Promise<readonly AttachmentId[]> {
  const ids = [...new Set(attachmentIds)]
  if (ids.length === 0) return []
  const snapshot = await readAttachmentCatalogRepairSnapshot(tx, ids)
  const attachments = snapshot.headers
  const nextHeaders = [...attachments]
  const changed: AttachmentHeaderRow[] = []
  for (let index = 0; index < ids.length; index += 1) {
    const attachmentId = ids[index] as AttachmentId
    const attachment = attachments[index]
    const count = snapshot.summaries.get(attachmentId)?.refCount ?? 0
    if (!attachment) {
      if (count > 0) throw new AttachmentReferenceTargetMissingError(attachmentId)
      continue
    }
    const reconciled = reconcileAttachmentReferenceCount(attachment, count, observedAt)
    nextHeaders[index] = reconciled
    if (reconciled !== attachment) changed.push(reconciled)
  }
  if (changed.length > 0) {
    const changedIds = new Set(changed.map((attachment) => attachment.id))
    await replaceAttachmentHeaderByteOwnerBatch(
      tx,
      changed,
      attachments.filter(
        (attachment): attachment is AttachmentHeaderRow =>
          attachment !== undefined && changedIds.has(attachment.id),
      ),
    )
  }
  const changedCatalogIds = await refreshAttachmentCatalogProjectionsForRepair(tx, ids, {
    headers: nextHeaders,
    summaries: snapshot.summaries,
  })
  return [...new Set([...changed.map((attachment) => attachment.id), ...changedCatalogIds])]
}

export async function reconcileAttachmentRefCountSummaryForRepair(
  tx: Transaction,
  attachmentId: AttachmentId,
  summary: AttachmentReferenceSummary,
  observedAt: number,
): Promise<readonly AttachmentId[]> {
  const attachment = await tx
    .table<AttachmentHeaderRow, AttachmentId>('attachments')
    .get(attachmentId)
  if (!attachment) {
    if (summary.refCount > 0) throw new AttachmentReferenceTargetMissingError(attachmentId)
    return refreshAttachmentCatalogProjectionsForRepair(tx, [attachmentId], {
      headers: [undefined],
      summaries: new Map([[attachmentId, summary]]),
    })
  }
  const reconciled = reconcileAttachmentReferenceCount(attachment, summary.refCount, observedAt)
  if (reconciled !== attachment) {
    await replaceAttachmentHeaderByteOwnerBatch(tx, [reconciled], [attachment])
  }
  const changedCatalogIds = await refreshAttachmentCatalogProjectionsForRepair(tx, [attachmentId], {
    headers: [reconciled],
    summaries: new Map([[attachmentId, summary]]),
  })
  return [...new Set([...(reconciled === attachment ? [] : [attachmentId]), ...changedCatalogIds])]
}

export function reconcileAttachmentReferenceCount(
  attachment: AttachmentHeaderRow,
  count: number,
  observedAt: number,
): AttachmentHeaderRow {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`AttachmentReferenceCountInvalid:${attachment.id}`)
  }
  const unreferencedAt =
    count > 0
      ? null
      : attachment.refCount === 0 && typeof attachment.unreferencedAt === 'number'
        ? attachment.unreferencedAt
        : observedAt
  return attachment.refCount === count && attachment.unreferencedAt === unreferencedAt
    ? attachment
    : { ...attachment, refCount: count, unreferencedAt }
}

function attachmentOwnerKey(
  ownerKind: AttachmentReferenceEdge['ownerKind'],
  ownerId: string,
): string {
  return `${ownerKind}\u0000${ownerId}`
}

function attachmentOwnerReferenceSummaries(
  edges: readonly AttachmentReferenceEdge[],
): Map<AttachmentId, AttachmentOwnerReferenceSummary> {
  const summaries = new Map<AttachmentId, AttachmentOwnerReferenceSummary>()
  for (const edge of edges) {
    const previous = summaries.get(edge.attachmentId) ?? EMPTY_OWNER_REFERENCE_SUMMARY
    summaries.set(edge.attachmentId, {
      occurrences: previous.occurrences + 1,
      visibleOccurrences: previous.visibleOccurrences + Number(edge.includeInContext),
    })
  }
  return summaries
}

function sameAttachmentReferenceEdge(
  previous: AttachmentReferenceEdge,
  next: AttachmentReferenceEdge,
): boolean {
  return (
    previous.ownerKind === next.ownerKind &&
    previous.ownerId === next.ownerId &&
    previous.chatId === next.chatId &&
    previous.refId === next.refId &&
    previous.attachmentId === next.attachmentId &&
    previous.ordinal === next.ordinal &&
    previous.includeInContext === next.includeInContext &&
    previous.refUpdatedAt === next.refUpdatedAt
  )
}

export async function attachmentReferenceCounts(
  tx: Transaction,
  attachmentId: AttachmentId,
): Promise<{ messages: number; drafts: number; occurrences: number }> {
  const edges = await tx
    .table<AttachmentReferenceEdge>('attachmentRefEdges')
    .where('attachmentId')
    .equals(attachmentId)
    .toArray()
  const messageOwners = new Set<string>()
  const draftOwners = new Set<string>()
  for (const edge of edges) {
    if (edge.ownerKind === 'message') messageOwners.add(edge.ownerId)
    else draftOwners.add(edge.ownerId)
  }
  return {
    messages: messageOwners.size,
    drafts: draftOwners.size,
    occurrences: edges.length,
  }
}

export async function requireNoAttachmentReferences(
  tx: Transaction,
  attachmentId: AttachmentId,
): Promise<boolean> {
  return (
    (await tx
      .table<AttachmentReferenceEdge>('attachmentRefEdges')
      .where('attachmentId')
      .equals(attachmentId)
      .first()) === undefined
  )
}

export function edgesForOwner(owner: AttachmentReferenceOwner): AttachmentReferenceEdge[] {
  return [...attachmentReferenceEdgesForOwner(owner)]
}

export function* attachmentReferenceEdgesForOwner(
  owner: AttachmentReferenceOwner,
): Iterable<AttachmentReferenceEdge> {
  const seenRefIds = new Set<string>()
  for (let ordinal = 0; ordinal < (owner.refs?.length ?? 0); ordinal += 1) {
    const ref = owner.refs?.[ordinal]
    if (!ref) continue
    if (seenRefIds.has(ref.refId)) {
      throw new DuplicateAttachmentRefIdError(owner.ownerKind, owner.ownerId, ref.refId)
    }
    seenRefIds.add(ref.refId)
    if (ref.deletedAt !== undefined) continue
    yield {
      ownerKind: owner.ownerKind,
      ownerId: owner.ownerId,
      chatId: owner.chatId,
      refId: ref.refId,
      attachmentId: ref.attachmentId,
      ordinal,
      includeInContext: ref.includeInContext,
      refUpdatedAt: ref.updatedAt,
    }
  }
}

async function requireAttachmentTargets(
  tx: Transaction,
  attachmentIds: readonly AttachmentId[],
): Promise<void> {
  if (attachmentIds.length === 0) return
  const rows = await tx
    .table<AttachmentHeaderRow, AttachmentId>('attachments')
    .bulkGet([...attachmentIds])
  for (let index = 0; index < attachmentIds.length; index += 1) {
    if (!rows[index]) {
      throw new AttachmentReferenceTargetMissingError(attachmentIds[index] as AttachmentId)
    }
  }
}

function changedAttachmentProjections(
  previous: readonly AttachmentReferenceEdge[],
  next: readonly AttachmentReferenceEdge[],
): AttachmentId[] {
  const previousByAttachment = attachmentOwnerProjectionSummaries(previous)
  const nextByAttachment = attachmentOwnerProjectionSummaries(next)
  return [...new Set([...previousByAttachment.keys(), ...nextByAttachment.keys()])].filter(
    (attachmentId) =>
      !sameAttachmentOwnerProjection(
        previousByAttachment.get(attachmentId),
        nextByAttachment.get(attachmentId),
      ),
  )
}

interface AttachmentOwnerProjectionSummary {
  occurrences: number
  visibleOccurrences: number
  latestRefUpdatedAt: number | null
}

function attachmentOwnerProjectionSummaries(
  edges: readonly AttachmentReferenceEdge[],
): Map<AttachmentId, AttachmentOwnerProjectionSummary> {
  const summaries = new Map<AttachmentId, AttachmentOwnerProjectionSummary>()
  for (const edge of edges) {
    const summary = summaries.get(edge.attachmentId) ?? {
      occurrences: 0,
      visibleOccurrences: 0,
      latestRefUpdatedAt: null,
    }
    summary.occurrences += 1
    if (edge.includeInContext) summary.visibleOccurrences += 1
    summary.latestRefUpdatedAt =
      summary.latestRefUpdatedAt === null
        ? edge.refUpdatedAt
        : Math.max(summary.latestRefUpdatedAt, edge.refUpdatedAt)
    summaries.set(edge.attachmentId, summary)
  }
  return summaries
}

function sameAttachmentOwnerProjection(
  previous: AttachmentOwnerProjectionSummary | undefined,
  next: AttachmentOwnerProjectionSummary | undefined,
): boolean {
  return (
    previous?.occurrences === next?.occurrences &&
    previous?.visibleOccurrences === next?.visibleOccurrences &&
    previous?.latestRefUpdatedAt === next?.latestRefUpdatedAt
  )
}

function sameOwnerEdges(
  previous: readonly AttachmentReferenceEdge[],
  next: readonly AttachmentReferenceEdge[],
): boolean {
  if (previous.length !== next.length) return false
  const previousByRefId = new Map(previous.map((edge) => [edge.refId, edge]))
  return next.every((edge) => {
    const existing = previousByRefId.get(edge.refId)
    return existing !== undefined && sameAttachmentReferenceEdge(existing, edge)
  })
}
