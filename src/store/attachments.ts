// Attachment store primitives. See `plan/03-storage.md §3.3`.
//
// Three responsibilities:
//   1. Content-hash a Blob deterministically (SHA-256 over the raw bytes).
//   2. Ref-count increment/decrement inside the chat mutation transaction.
//   3. Orphan GC that defensively walks messages + drafts before deleting.
//
// The ref count is authoritative for "are we still using this?", but GC rescans
// both tables before a delete so a bug elsewhere can't silently lose data.

import type { Attachment, AttachmentId, AttachmentKind, ChatId } from '../core/types'
import { newId } from '../lib/ulid'
import { getDb } from './db'
import type { MutationContext } from './repository'

export const DEFAULT_ORPHAN_GC_AGE_MS = 24 * 60 * 60 * 1000

export interface CreateAttachmentInput {
  blob: Blob
  filename: string
  mime: string
  kind: AttachmentKind
  dimensions?: { width: number; height: number }
  durationMs?: number
  pageCount?: number
  thumbnailB64?: string
  createdAt?: number
}

// SHA-256 hex digest over the blob's raw bytes. Stable across browsers: the
// Web Crypto API normalizes endianness. We wrap the raw buffer in a Uint8Array
// because some environments (jsdom's SubtleCrypto in particular) reject a bare
// ArrayBuffer that originated in a different realm than the crypto instance.
export async function sha256Hex(blob: Blob): Promise<string> {
  const input = new Uint8Array(await blob.arrayBuffer())
  const digest = await crypto.subtle.digest('SHA-256', input)
  const bytes = new Uint8Array(digest)
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

// Build a fresh attachment row with `refCount: 0`. Callers increment the ref
// count the moment they persist a reference (message, draft) inside the chat
// lock that created that reference.
export async function buildAttachment(input: CreateAttachmentInput): Promise<Attachment> {
  const contentHash = await sha256Hex(input.blob)
  const row: Attachment = {
    id: newId(),
    contentHash,
    kind: input.kind,
    mime: input.mime,
    filename: input.filename,
    sizeBytes: input.blob.size,
    createdAt: input.createdAt ?? Date.now(),
    blob: input.blob,
    refCount: 0,
  }
  if (input.dimensions) row.dimensions = input.dimensions
  if (input.durationMs !== undefined) row.durationMs = input.durationMs
  if (input.pageCount !== undefined) row.pageCount = input.pageCount
  if (input.thumbnailB64) row.thumbnailB64 = input.thumbnailB64
  return row
}

// Persist a freshly-built attachment row outside any chat lock. Safe because
// new rows start at `refCount: 0` and are only reachable after a subsequent
// `incRefs` call inside the chat lock that attaches them.
export async function putAttachment(row: Attachment): Promise<void> {
  await getDb().attachments.put(row)
}

export async function incRefs(ctx: MutationContext, ids: readonly AttachmentId[]): Promise<void> {
  if (ids.length === 0) return
  for (const id of ids) {
    const row = await ctx.getAttachment(id)
    if (!row) continue
    await ctx.putAttachment({ ...row, refCount: row.refCount + 1 })
  }
}

export async function decRefs(ctx: MutationContext, ids: readonly AttachmentId[]): Promise<void> {
  if (ids.length === 0) return
  for (const id of ids) {
    const row = await ctx.getAttachment(id)
    if (!row) continue
    const next = row.refCount - 1
    await ctx.putAttachment({ ...row, refCount: next < 0 ? 0 : next })
  }
}

export interface OrphanReapOptions {
  olderThanMs?: number
  now?: number
}

// Reap attachments whose `refCount === 0` and `createdAt` is older than the
// cutoff. Defensively re-scans messages AND drafts for stray references before
// deleting — a bug that left a message pointing at a supposedly-unreferenced
// attachment should keep the attachment alive, not lose the data.
export async function reapOrphanedAttachments(
  opts: OrphanReapOptions = {},
): Promise<AttachmentId[]> {
  const olderThanMs = opts.olderThanMs ?? DEFAULT_ORPHAN_GC_AGE_MS
  const now = opts.now ?? Date.now()
  const cutoff = now - olderThanMs
  const db = getDb()
  return db.transaction('rw', db.attachments, db.messages, db.drafts, async () => {
    const candidates = await db.attachments
      .where('refCount')
      .equals(0)
      .filter((att) => att.createdAt < cutoff)
      .toArray()
    if (candidates.length === 0) return []
    const ids = new Set(candidates.map((a) => a.id))
    await db.messages.each((m) => {
      if (m.attachmentRefs) {
        for (const ref of m.attachmentRefs) ids.delete(ref)
      }
    })
    await db.drafts.each((d) => {
      if (d.attachmentRefs) {
        for (const ref of d.attachmentRefs) ids.delete(ref)
      }
    })
    const toDelete = [...ids]
    for (const id of toDelete) await db.attachments.delete(id)
    return toDelete
  })
}

// Quick lookup: count of live references across both tables. Not used on the
// hot path — exists for the settings storage pane and tests.
export async function countLiveRefs(
  id: AttachmentId,
): Promise<{ messages: number; drafts: number }> {
  const db = getDb()
  let messages = 0
  let drafts = 0
  await db.messages.each((m) => {
    if (m.attachmentRefs?.includes(id)) messages += 1
  })
  await db.drafts.each((d) => {
    if (d.attachmentRefs?.includes(id)) drafts += 1
  })
  return { messages, drafts }
}

export interface DraftAttachmentOps {
  chatId: ChatId
  newRefs: readonly AttachmentId[]
  oldRefs: readonly AttachmentId[]
}

// Compute the delta between two attachment-ref lists so callers can apply ref
// count changes without counting every id. Used by the draft autosave path
// and the chat-lock message-write path.
export function diffAttachmentRefs(
  previous: readonly AttachmentId[] | undefined,
  next: readonly AttachmentId[] | undefined,
): { toInc: AttachmentId[]; toDec: AttachmentId[] } {
  const prev = new Set(previous ?? [])
  const curr = new Set(next ?? [])
  const toInc: AttachmentId[] = []
  const toDec: AttachmentId[] = []
  for (const id of curr) if (!prev.has(id)) toInc.push(id)
  for (const id of prev) if (!curr.has(id)) toDec.push(id)
  return { toInc, toDec }
}
