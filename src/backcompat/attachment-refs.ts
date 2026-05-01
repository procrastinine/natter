import type { MessageAttachmentRef } from '../core/types'
import type { NatterDb, SettingsRow } from '../store/db'

const ATTACHMENT_REFS_BACKFILL_KEY = 'backfill:attachment-refs-v1'

export function attachmentRefsBackfillMarker(): SettingsRow {
  return { key: ATTACHMENT_REFS_BACKFILL_KEY, value: 1 }
}

export async function migrateAttachmentRefRows(db: NatterDb): Promise<void> {
  const marker = await db.settings.get(ATTACHMENT_REFS_BACKFILL_KEY)
  if (marker?.value === 1) return

  await db.transaction('rw', db.messages, db.drafts, db.attachments, db.settings, async () => {
    const refCounts = new Map<string, number>()
    await db.messages.toCollection().modify((row) => {
      const refs = normalizeLegacyAttachmentRefs(row.attachmentRefs, {
        messageId: String(row.id),
        createdAt: numberOr(row.createdAt, 0),
      })
      if (refs === undefined) return
      row.attachmentRefs = refs
      for (const ref of refs) {
        if (ref.deletedAt !== undefined) continue
        refCounts.set(ref.attachmentId, (refCounts.get(ref.attachmentId) ?? 0) + 1)
      }
    })
    await db.drafts.toCollection().modify((row) => {
      const refs = normalizeLegacyAttachmentRefs(row.attachmentRefs, {
        draftChatId: String(row.chatId),
        createdAt: numberOr(row.updatedAt, 0),
      })
      if (refs === undefined) return
      row.attachmentRefs = refs
      for (const ref of refs) {
        if (ref.deletedAt !== undefined) continue
        refCounts.set(ref.attachmentId, (refCounts.get(ref.attachmentId) ?? 0) + 1)
      }
    })
    await db.attachments.toCollection().modify((row) => {
      row.refCount = refCounts.get(row.id) ?? 0
    })
    await db.settings.put(attachmentRefsBackfillMarker())
  })
}

export function normalizeLegacyAttachmentRefs(
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
