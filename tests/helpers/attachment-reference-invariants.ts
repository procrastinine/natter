import { expect } from 'vitest'
import type { AttachmentId, AttachmentReferenceEdge } from '../../src/core/types'
import type { NatterDb } from '../../src/store/db'

export async function expectAttachmentReferenceInvariants(db: NatterDb): Promise<void> {
  const [messages, drafts, actualEdges, attachments] = await Promise.all([
    db.messages.toArray(),
    db.drafts.toArray(),
    db.attachmentRefEdges.toArray(),
    db.attachments.toArray(),
  ])
  const expectedEdges: AttachmentReferenceEdge[] = []
  for (const message of messages) {
    collectExpectedEdges(
      expectedEdges,
      'message',
      message.id,
      message.chatId,
      message.attachmentRefs,
    )
  }
  for (const draft of drafts) {
    collectExpectedEdges(expectedEdges, 'draft', draft.chatId, draft.chatId, draft.attachmentRefs)
  }
  expect(sortEdges(actualEdges)).toEqual(sortEdges(expectedEdges))

  const counts = new Map<AttachmentId, number>()
  for (const edge of actualEdges) {
    counts.set(edge.attachmentId, (counts.get(edge.attachmentId) ?? 0) + 1)
  }
  for (const attachment of attachments) {
    expect(attachment.refCount, `refCount for ${attachment.id}`).toBe(
      counts.get(attachment.id) ?? 0,
    )
  }
  for (const attachmentId of counts.keys()) {
    expect(
      attachments.some((attachment) => attachment.id === attachmentId),
      `edge target ${attachmentId}`,
    ).toBe(true)
  }
}

function collectExpectedEdges(
  edges: AttachmentReferenceEdge[],
  ownerKind: AttachmentReferenceEdge['ownerKind'],
  ownerId: string,
  chatId: string,
  refs:
    | readonly {
        refId: string
        attachmentId: AttachmentId
        deletedAt?: number
      }[]
    | undefined,
): void {
  const seen = new Set<string>()
  for (const [ordinal, ref] of (refs ?? []).entries()) {
    expect(seen.has(ref.refId), `duplicate ${ownerKind} ref ${ownerId}:${ref.refId}`).toBe(false)
    seen.add(ref.refId)
    if (ref.deletedAt !== undefined) continue
    edges.push({
      ownerKind,
      ownerId,
      chatId,
      refId: ref.refId,
      attachmentId: ref.attachmentId,
      ordinal,
    })
  }
}

function sortEdges(edges: readonly AttachmentReferenceEdge[]): AttachmentReferenceEdge[] {
  return [...edges].sort((left, right) => edgeKey(left).localeCompare(edgeKey(right)))
}

function edgeKey(edge: AttachmentReferenceEdge): string {
  return `${edge.ownerKind}\0${edge.ownerId}\0${edge.refId}`
}
