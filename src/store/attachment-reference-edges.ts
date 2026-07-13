import type { Transaction } from 'dexie'
import type { AttachmentId, AttachmentRef, AttachmentReferenceEdge, ChatId } from '../core/types'
import type { AttachmentHeaderRow } from './attachment-storage'

type AttachmentReferenceOwner = {
  ownerKind: AttachmentReferenceEdge['ownerKind']
  ownerId: string
  chatId: ChatId
  refs: readonly AttachmentRef[] | undefined
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

export async function replaceAttachmentReferenceOwner(
  tx: Transaction,
  owner: AttachmentReferenceOwner,
  assertAttachmentScope?: (attachmentId: AttachmentId) => void,
): Promise<void> {
  await replaceAttachmentReferenceOwners(tx, [owner], assertAttachmentScope)
}

export async function replaceAttachmentReferenceOwners(
  tx: Transaction,
  owners: readonly AttachmentReferenceOwner[],
  assertAttachmentScope?: (attachmentId: AttachmentId) => void,
): Promise<void> {
  if (owners.length === 0) return
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

  const existingByOwner = await Promise.all(
    planned.map(({ owner }) =>
      edgeTable.where('[ownerKind+ownerId]').equals([owner.ownerKind, owner.ownerId]).toArray(),
    ),
  )
  const targetIds = new Set<AttachmentId>()
  for (const { edges } of planned) {
    for (const edge of edges) targetIds.add(edge.attachmentId)
  }
  await requireAttachmentTargets(tx, [...targetIds])

  const dirtyIds = new Set<AttachmentId>()
  const changedOwners = new Set<number>()
  for (let index = 0; index < planned.length; index += 1) {
    const nextEdges = planned[index]?.edges ?? []
    const previousEdges = existingByOwner[index] ?? []
    if (sameOwnerEdges(previousEdges, nextEdges)) continue
    changedOwners.add(index)
    for (const attachmentId of changedAttachmentCounts(previousEdges, nextEdges)) {
      assertAttachmentScope?.(attachmentId)
      dirtyIds.add(attachmentId)
    }
  }

  for (let index = 0; index < planned.length; index += 1) {
    if (!changedOwners.has(index)) continue
    const owner = planned[index]?.owner
    if (!owner) continue
    await edgeTable.where('[ownerKind+ownerId]').equals([owner.ownerKind, owner.ownerId]).delete()
  }
  const nextEdges = planned.flatMap(({ edges }, index) => (changedOwners.has(index) ? edges : []))
  if (nextEdges.length > 0) await edgeTable.bulkPut(nextEdges)
  await reconcileAttachmentRefCounts(tx, dirtyIds)
}

async function reconcileAttachmentRefCounts(
  tx: Transaction,
  attachmentIds: Iterable<AttachmentId>,
): Promise<void> {
  const edgeTable = tx.table<AttachmentReferenceEdge>('attachmentRefEdges')
  const attachmentTable = tx.table<AttachmentHeaderRow, AttachmentId>('attachments')
  for (const attachmentId of new Set(attachmentIds)) {
    const [count, attachment] = await Promise.all([
      edgeTable.where('attachmentId').equals(attachmentId).count(),
      attachmentTable.get(attachmentId),
    ])
    if (!attachment) {
      if (count > 0) throw new AttachmentReferenceTargetMissingError(attachmentId)
      continue
    }
    if (attachment.refCount !== count) {
      await attachmentTable.put({ ...attachment, refCount: count })
    }
  }
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
      .count()) === 0
  )
}

export function edgesForOwner(owner: AttachmentReferenceOwner): AttachmentReferenceEdge[] {
  const seenRefIds = new Set<string>()
  const edges: AttachmentReferenceEdge[] = []
  for (let ordinal = 0; ordinal < (owner.refs?.length ?? 0); ordinal += 1) {
    const ref = owner.refs?.[ordinal]
    if (!ref) continue
    if (seenRefIds.has(ref.refId)) {
      throw new DuplicateAttachmentRefIdError(owner.ownerKind, owner.ownerId, ref.refId)
    }
    seenRefIds.add(ref.refId)
    if (ref.deletedAt !== undefined) continue
    edges.push({
      ownerKind: owner.ownerKind,
      ownerId: owner.ownerId,
      chatId: owner.chatId,
      refId: ref.refId,
      attachmentId: ref.attachmentId,
      ordinal,
    })
  }
  return edges
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

function changedAttachmentCounts(
  previous: readonly AttachmentReferenceEdge[],
  next: readonly AttachmentReferenceEdge[],
): AttachmentId[] {
  const before = attachmentCounts(previous)
  const after = attachmentCounts(next)
  const changed: AttachmentId[] = []
  for (const attachmentId of new Set([...before.keys(), ...after.keys()])) {
    if ((before.get(attachmentId) ?? 0) !== (after.get(attachmentId) ?? 0)) {
      changed.push(attachmentId)
    }
  }
  return changed
}

function attachmentCounts(edges: readonly AttachmentReferenceEdge[]): Map<AttachmentId, number> {
  const counts = new Map<AttachmentId, number>()
  for (const edge of edges) {
    counts.set(edge.attachmentId, (counts.get(edge.attachmentId) ?? 0) + 1)
  }
  return counts
}

function sameOwnerEdges(
  previous: readonly AttachmentReferenceEdge[],
  next: readonly AttachmentReferenceEdge[],
): boolean {
  if (previous.length !== next.length) return false
  const previousByRefId = new Map(previous.map((edge) => [edge.refId, edge]))
  return next.every((edge) => {
    const existing = previousByRefId.get(edge.refId)
    return (
      existing?.ownerKind === edge.ownerKind &&
      existing.ownerId === edge.ownerId &&
      existing.chatId === edge.chatId &&
      existing.attachmentId === edge.attachmentId &&
      existing.ordinal === edge.ordinal
    )
  })
}
