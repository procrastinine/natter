import type { AttachmentId, AttachmentRef, MessageAttachmentRef, MessageId } from '../core/types'
import { newId } from '../lib/ulid'

interface AttachmentRefOwner {
  messageId?: MessageId
  draftChatId?: string
  createdAt?: number
}

export function liveAttachmentRefs(
  refs: readonly AttachmentRef[] | undefined,
): MessageAttachmentRef[] {
  return normalizeAttachmentRefs(refs).filter((ref) => ref.deletedAt === undefined)
}

export function normalizeAttachmentRefs(
  refs: readonly AttachmentRef[] | undefined,
  _owner: AttachmentRefOwner = {},
): MessageAttachmentRef[] {
  if (!refs) return []
  return refs.map((ref) => normalizeAttachmentRef(ref))
}

export function attachmentRefsFromIds(
  ids: readonly AttachmentId[] | undefined,
  opts: AttachmentRefOwner & { existing?: readonly AttachmentRef[] } = {},
): MessageAttachmentRef[] {
  if (!ids || ids.length === 0) return []
  const now = opts.createdAt ?? Date.now()
  const existing = normalizeAttachmentRefs(opts.existing, opts)
  const used = new Set<string>()
  return ids.map((attachmentId) => {
    const reusable = existing.find(
      (ref) => ref.attachmentId === attachmentId && !used.has(ref.refId),
    )
    if (reusable) {
      used.add(reusable.refId)
      return { ...reusable, updatedAt: now }
    }
    return createAttachmentRef(attachmentId, { ...opts, createdAt: now })
  })
}

export function createAttachmentRef(
  attachmentId: AttachmentId,
  owner: AttachmentRefOwner = {},
): MessageAttachmentRef {
  const now = owner.createdAt ?? Date.now()
  return {
    refId: newId(),
    attachmentId,
    includeInContext: true,
    presentation: {},
    createdAt: now,
    updatedAt: now,
  }
}

function normalizeAttachmentRef(ref: AttachmentRef): MessageAttachmentRef {
  return {
    refId: ref.refId,
    attachmentId: ref.attachmentId,
    includeInContext: ref.includeInContext !== false,
    presentation: ref.presentation,
    ...(ref.tokenEstimate ? { tokenEstimate: ref.tokenEstimate } : {}),
    ...(ref.missingResolution ? { missingResolution: ref.missingResolution } : {}),
    createdAt: ref.createdAt,
    updatedAt: ref.updatedAt,
    ...(ref.deletedAt !== undefined ? { deletedAt: ref.deletedAt } : {}),
  }
}
