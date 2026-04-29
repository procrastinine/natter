// Attachment backend primitives. UI code should eventually call these through
// the repository/storage-manager surface, not mutate Dexie tables directly.

import {
  fileExtension,
  processAttachment,
  sha256Hex as sha256BytesHex,
} from '../core/attachments/process'
import type {
  AttachmentArtifact as ProcessedArtifact,
  AttachmentProcessingState as ProcessedState,
  ProcessAttachmentResult,
} from '../core/attachments/types'
import type {
  Attachment,
  AttachmentArtifact,
  AttachmentBlob,
  AttachmentId,
  AttachmentJob,
  AttachmentKind,
  AttachmentMissingReason,
  AttachmentOrigin,
  AttachmentRef,
  AttachmentTokenEstimate,
  ChatId,
  ChatTitleStatus,
  Message,
  MessageAttachmentRef,
  MessageId,
  MutationScope,
} from '../core/types'
import { newId } from '../lib/ulid'
import {
  attachmentIdOf,
  attachmentIdsOf,
  attachmentRefsFromIds,
  createAttachmentRef,
  liveAttachmentRefs,
  normalizeAttachmentRefs,
  uniqueAttachmentIdsOf,
} from './attachment-refs'
import { getBrowserRepository } from './browser-repo'
import { openDb } from './db'
import type { MutationContext } from './repository'

const DEFAULT_ORPHAN_GC_AGE_MS = 24 * 60 * 60 * 1000

interface CreateAttachmentInput {
  blob: Blob
  filename: string
  mime: string
  kind: AttachmentKind
  dimensions?: { width: number; height: number }
  durationMs?: number
  pageCount?: number
  createdAt?: number
  origin?: AttachmentOrigin
  sourceUrl?: string
}

interface AttachmentBundle {
  attachment: Attachment
  blobs: AttachmentBlob[]
  artifacts: AttachmentArtifact[]
  jobs: AttachmentJob[]
}

interface IngestAttachmentBytesInput {
  blob: Blob
  filename: string
  declaredMime?: string
  origin?: AttachmentOrigin
  sourceUrl?: string
  id?: AttachmentId
  now?: number
}

interface ReplaceAttachmentBytesInput {
  attachmentId: AttachmentId
  blob: Blob
  filename: string
  declaredMime?: string
  origin?: AttachmentOrigin
  sourceUrl?: string
  now?: number
}

interface ReplaceAttachmentBytesResult {
  bundle: AttachmentBundle
  reusedExisting: boolean
}

interface CreateRemoteAttachmentInput {
  url: string
  filename: string
  mime?: string
  kind?: AttachmentKind
  origin?: AttachmentOrigin
  id?: AttachmentId
  now?: number
}

interface AttachmentRefTarget {
  messageId?: MessageId
  draftChatId?: ChatId
}

interface AddAttachmentRefInput extends AttachmentRefTarget {
  attachmentId: AttachmentId
  afterRefId?: string
  includeInContext?: boolean
  now?: number
}

interface RelinkAttachmentRefInput extends AttachmentRefTarget {
  refId: string
  newAttachmentId: AttachmentId
  now?: number
}

interface BatchRelinkAttachmentRefsInput {
  oldAttachmentId: AttachmentId
  newAttachmentId: AttachmentId
  refs: Array<AttachmentRefTarget & { refId: string }>
  now?: number
}

interface RestoreMissingAttachmentInput {
  missingAttachmentId: AttachmentId
  replacementAttachmentId: AttachmentId
  refs: Array<AttachmentRefTarget & { refId: string }>
  now?: number
}

interface OrphanReapOptions {
  olderThanMs?: number
  now?: number
}

export interface AttachmentReferenceRow {
  ownerKind: 'message' | 'draft'
  chatId: ChatId
  chatTitle: string
  chatTitleStatus: ChatTitleStatus
  messageId?: MessageId
  draftChatId?: ChatId
  role?: Message['role']
  messageCreatedAt?: number
  ref: MessageAttachmentRef
}

type PendingAttachment = Attachment & { blob?: Blob }

export async function sha256Hex(blob: Blob): Promise<string> {
  return sha256BytesHex(new Uint8Array(await blob.arrayBuffer()))
}

export async function buildAttachment(input: CreateAttachmentInput): Promise<PendingAttachment> {
  const now = input.createdAt ?? Date.now()
  const contentHash = await sha256Hex(input.blob)
  const blobId = newId()
  const extension = fileExtension(input.filename)
  return {
    id: newId(),
    contentHash,
    kind: canonicalKind(input.kind),
    mime: input.mime,
    filename: input.filename,
    ...(extension ? { extension } : {}),
    sizeBytes: input.blob.size,
    origin: input.origin ?? 'user-upload',
    ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
    createdAt: now,
    updatedAt: now,
    storage: { kind: 'local-blob', blobId },
    ...(input.dimensions ? { dimensions: input.dimensions } : {}),
    ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
    ...(input.pageCount !== undefined ? { pageCount: input.pageCount } : {}),
    artifacts: [],
    processing: [],
    refCount: 0,
    blob: input.blob,
  }
}

export async function putAttachment(row: PendingAttachment): Promise<void> {
  const { metadata, blobRow } = metadataAndOptionalBlob(row)
  await putAttachmentBundle({
    attachment: metadata,
    blobs: blobRow ? [blobRow] : [],
    artifacts: metadata.artifacts,
    jobs: metadata.processing.map((state) =>
      jobFromProcessing(metadata.id, state, metadata.updatedAt),
    ),
  })
}

export async function ingestAttachmentBytes(
  input: IngestAttachmentBytesInput,
): Promise<AttachmentBundle> {
  const bytes = new Uint8Array(await input.blob.arrayBuffer())
  const contentHash = await sha256BytesHex(bytes)
  if (input.id === undefined) {
    const existing = await findExistingAttachmentBundle(input.filename, contentHash)
    if (existing) return existing
  }
  if (input.id !== undefined) {
    const existing = await getAttachmentBundle(input.id)
    if (existing) return existing
  }
  const id = input.id ?? newId()
  const processed = await processAttachment({
    id,
    filename: input.filename,
    bytes,
    ...(input.declaredMime ? { declaredMime: input.declaredMime } : {}),
    ...(input.origin ? { origin: input.origin } : {}),
    ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
    ...(input.now !== undefined ? { now: input.now } : {}),
  })
  const bundle = bundleFromProcessed(processed, input.blob)
  if (input.id !== undefined) {
    return putAttachmentBundleIfAbsent(bundle)
  }
  await putAttachmentBundle(bundle)
  return bundle
}

export async function replaceAttachmentBytes(
  input: ReplaceAttachmentBytesInput,
): Promise<ReplaceAttachmentBytesResult> {
  const bytes = new Uint8Array(await input.blob.arrayBuffer())
  const contentHash = await sha256BytesHex(bytes)
  const existing = await findExistingAttachmentBundle(
    input.filename,
    contentHash,
    input.attachmentId,
  )
  if (existing) return { bundle: existing, reusedExisting: true }

  const current = await getAttachmentBundle(input.attachmentId)
  if (!current) throw new Error(`AttachmentMissing:${input.attachmentId}`)

  const processed = await processAttachment({
    id: input.attachmentId,
    filename: input.filename,
    bytes,
    ...(input.declaredMime ? { declaredMime: input.declaredMime } : {}),
    ...(input.origin ? { origin: input.origin } : {}),
    ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
    ...(input.now !== undefined ? { now: input.now } : {}),
  })
  const bundle = bundleFromProcessed(processed, input.blob)
  bundle.attachment.createdAt = current.attachment.createdAt
  bundle.attachment.refCount = current.attachment.refCount
  await replaceAttachmentBundle(current, bundle)
  return { bundle, reusedExisting: false }
}

export async function createRemoteAttachment(
  input: CreateRemoteAttachmentInput,
): Promise<Attachment> {
  const now = input.now ?? Date.now()
  const extension = fileExtension(input.filename)
  const attachment: Attachment = {
    id: input.id ?? newId(),
    kind: canonicalKind(input.kind ?? 'other'),
    mime: input.mime ?? 'application/octet-stream',
    filename: input.filename,
    ...(extension ? { extension } : {}),
    origin: input.origin ?? 'user-remote-url',
    sourceUrl: input.url,
    createdAt: now,
    updatedAt: now,
    storage: { kind: 'remote-url', url: input.url },
    artifacts: [],
    processing: [],
    refCount: 0,
  }
  if (input.id !== undefined) {
    return (
      await putAttachmentBundleIfAbsent({
        attachment,
        blobs: [],
        artifacts: [],
        jobs: [],
      })
    ).attachment
  }
  await putAttachmentBundle({ attachment, blobs: [], artifacts: [], jobs: [] })
  return attachment
}

async function putAttachmentBundle(bundle: AttachmentBundle): Promise<void> {
  const repo = getBrowserRepository()
  await repo.runMutation(
    [{ kind: 'attachment', attachmentId: bundle.attachment.id }],
    async (ctx) => {
      await writeAttachmentBundle(ctx, bundle)
    },
  )
}

async function putAttachmentBundleIfAbsent(bundle: AttachmentBundle): Promise<AttachmentBundle> {
  const repo = getBrowserRepository()
  let wrote = false
  await repo.runMutation(
    [{ kind: 'attachment', attachmentId: bundle.attachment.id }],
    async (ctx) => {
      const existing = await ctx.getAttachment(bundle.attachment.id)
      if (existing) return
      await writeAttachmentBundle(ctx, bundle)
      wrote = true
    },
  )
  if (wrote) return bundle
  return (await getAttachmentBundle(bundle.attachment.id)) ?? bundle
}

async function writeAttachmentBundle(
  ctx: MutationContext,
  bundle: AttachmentBundle,
): Promise<void> {
  await ctx.putAttachment(bundle.attachment)
  for (const blob of bundle.blobs) await ctx.putAttachmentBlob(blob)
  for (const artifact of bundle.artifacts) await ctx.putAttachmentArtifact(artifact)
  for (const job of bundle.jobs) await ctx.putAttachmentJob(job)
}

export async function getAttachmentBundle(
  attachmentId: AttachmentId,
): Promise<AttachmentBundle | undefined> {
  const repo = getBrowserRepository()
  return repo.getAttachmentBundle(attachmentId)
}

async function findExistingAttachmentBundle(
  filename: string,
  contentHash: string,
  excludeId?: AttachmentId,
): Promise<AttachmentBundle | undefined> {
  const db = await openDb()
  const row = await db.attachments
    .where('contentHash')
    .equals(contentHash)
    .filter(
      (att) =>
        att.id !== excludeId &&
        att.filename === filename &&
        att.deletedAt === undefined &&
        att.storage.kind !== 'missing',
    )
    .first()
  return row ? getAttachmentBundle(row.id) : undefined
}

async function replaceAttachmentBundle(
  previous: AttachmentBundle,
  next: AttachmentBundle,
): Promise<void> {
  const repo = getBrowserRepository()
  await repo.runMutation(
    [{ kind: 'attachment', attachmentId: previous.attachment.id }],
    async (ctx) => {
      for (const blob of previous.blobs) await ctx.deleteAttachmentBlob(blob.id)
      for (const artifact of previous.artifacts)
        await ctx.deleteAttachmentArtifact(artifact.artifactId)
      for (const job of previous.jobs) await ctx.deleteAttachmentJob(job.id)
      await ctx.putAttachment(next.attachment)
      for (const blob of next.blobs) await ctx.putAttachmentBlob(blob)
      for (const artifact of next.artifacts) await ctx.putAttachmentArtifact(artifact)
      for (const job of next.jobs) await ctx.putAttachmentJob(job)
    },
  )
}

export async function incRefs(
  ctx: MutationContext,
  refs: readonly AttachmentRef[] | undefined,
): Promise<void> {
  const ids = attachmentIdsOf(refs)
  for (const id of ids) {
    const row = await ctx.getAttachment(id)
    if (!row) continue
    await ctx.putAttachment({ ...row, refCount: row.refCount + 1 })
  }
}

export async function decRefs(
  ctx: MutationContext,
  refs: readonly AttachmentRef[] | undefined,
): Promise<void> {
  const ids = attachmentIdsOf(refs)
  for (const id of ids) {
    const row = await ctx.getAttachment(id)
    if (!row) continue
    await ctx.putAttachment({ ...row, refCount: Math.max(0, row.refCount - 1) })
  }
}

export function diffAttachmentRefs(
  previous: readonly AttachmentRef[] | undefined,
  next: readonly AttachmentRef[] | undefined,
): { toInc: AttachmentId[]; toDec: AttachmentId[] } {
  const prev = multiset(attachmentIdsOf(previous))
  const curr = multiset(attachmentIdsOf(next))
  const ids = new Set([...prev.keys(), ...curr.keys()])
  const toInc: AttachmentId[] = []
  const toDec: AttachmentId[] = []
  for (const id of ids) {
    const before = prev.get(id) ?? 0
    const after = curr.get(id) ?? 0
    for (let i = before; i < after; i += 1) toInc.push(id)
    for (let i = after; i < before; i += 1) toDec.push(id)
  }
  return { toInc, toDec }
}

export async function addExistingAttachmentRef(
  input: AddAttachmentRefInput,
): Promise<MessageAttachmentRef> {
  const repo = getBrowserRepository()
  const now = input.now ?? Date.now()
  const target = await resolveRefTarget(input)
  const attachment = await repo.getAttachment(input.attachmentId)
  if (!attachment) throw new Error(`AttachmentMissing:${input.attachmentId}`)
  const created = createAttachmentRef(input.attachmentId, {
    ...(target.kind === 'message'
      ? { messageId: target.message.id }
      : { draftChatId: target.draft.chatId }),
    createdAt: now,
  })
  const ref =
    input.includeInContext === undefined
      ? created
      : { ...created, includeInContext: input.includeInContext }
  await repo.runMutation(scopesForTarget(target, [input.attachmentId]), async (ctx) => {
    if (target.kind === 'message') {
      const message = await mustGetMessage(ctx, target.message.id)
      const refs = normalizeAttachmentRefs(message.attachmentRefs, {
        messageId: message.id,
        createdAt: message.createdAt,
      })
      const next = insertRef(refs, ref, input.afterRefId)
      await ctx.putMessage(messageWithAttachmentRefs(message, next), {
        touchChatSummary: false,
        broadcast: true,
      })
    } else {
      const draft = (await ctx.getDraft(target.draft.chatId)) ?? target.draft
      const refs = normalizeAttachmentRefs(draft.attachmentRefs, {
        draftChatId: draft.chatId,
        createdAt: draft.updatedAt,
      })
      await ctx.putDraft({
        ...draft,
        attachmentRefs: insertRef(refs, ref, input.afterRefId),
        updatedAt: now,
      })
    }
    await incRefs(ctx, [input.attachmentId])
  })
  return ref
}

export async function setAttachmentRefVisibility(
  targetInput: AttachmentRefTarget & { refId: string; includeInContext: boolean; now?: number },
): Promise<MessageAttachmentRef> {
  const repo = getBrowserRepository()
  const now = targetInput.now ?? Date.now()
  const target = await resolveRefTarget(targetInput)
  let updated: MessageAttachmentRef | undefined
  await repo.runMutation(scopesForTarget(target), async (ctx) => {
    if (target.kind === 'message') {
      const message = await mustGetMessage(ctx, target.message.id)
      const refs = normalizeAttachmentRefs(message.attachmentRefs, {
        messageId: message.id,
        createdAt: message.createdAt,
      })
      const next = refs.map((ref) => {
        if (ref.refId !== targetInput.refId) return ref
        updated = { ...ref, includeInContext: targetInput.includeInContext, updatedAt: now }
        return updated
      })
      if (!updated) throw new Error(`AttachmentRefMissing:${targetInput.refId}`)
      await ctx.putMessage(messageWithAttachmentRefs(message, next), {
        touchChatSummary: false,
        broadcast: true,
      })
    } else {
      const draft = (await ctx.getDraft(target.draft.chatId)) ?? target.draft
      const refs = normalizeAttachmentRefs(draft.attachmentRefs, {
        draftChatId: draft.chatId,
        createdAt: draft.updatedAt,
      })
      const next = refs.map((ref) => {
        if (ref.refId !== targetInput.refId) return ref
        updated = { ...ref, includeInContext: targetInput.includeInContext, updatedAt: now }
        return updated
      })
      if (!updated) throw new Error(`AttachmentRefMissing:${targetInput.refId}`)
      await ctx.putDraft({ ...draft, attachmentRefs: next, updatedAt: now })
    }
  })
  return updated as MessageAttachmentRef
}

export async function detachAttachmentRef(
  input: AttachmentRefTarget & { refId: string; now?: number },
): Promise<void> {
  const repo = getBrowserRepository()
  const now = input.now ?? Date.now()
  const target = await resolveRefTarget(input)
  let removed: MessageAttachmentRef | undefined
  await repo.runMutation(scopesForTarget(target), async (ctx) => {
    if (target.kind === 'message') {
      const message = await mustGetMessage(ctx, target.message.id)
      const refs = normalizeAttachmentRefs(message.attachmentRefs, {
        messageId: message.id,
        createdAt: message.createdAt,
      })
      removed = refs.find((ref) => ref.refId === input.refId)
      if (!removed) return
      await ctx.putMessage(
        messageWithAttachmentRefs(
          message,
          refs.filter((ref) => ref.refId !== input.refId),
        ),
        { touchChatSummary: false, broadcast: true },
      )
    } else {
      const draft = (await ctx.getDraft(target.draft.chatId)) ?? target.draft
      const refs = normalizeAttachmentRefs(draft.attachmentRefs, {
        draftChatId: draft.chatId,
        createdAt: draft.updatedAt,
      })
      removed = refs.find((ref) => ref.refId === input.refId)
      if (!removed) return
      await ctx.putDraft({
        ...draft,
        attachmentRefs: refs.filter((ref) => ref.refId !== input.refId),
        updatedAt: now,
      })
    }
    await decRefs(ctx, removed ? [removed] : [])
  })
}

export async function relinkAttachmentRef(
  input: RelinkAttachmentRefInput,
): Promise<MessageAttachmentRef> {
  const result = await batchRelinkAttachmentRefs({
    oldAttachmentId: '',
    newAttachmentId: input.newAttachmentId,
    refs: [input],
    ...(input.now !== undefined ? { now: input.now } : {}),
  })
  const updated = result[0]
  if (!updated) throw new Error(`AttachmentRefMissing:${input.refId}`)
  return updated
}

export async function batchRelinkAttachmentRefs(
  input: BatchRelinkAttachmentRefsInput,
): Promise<MessageAttachmentRef[]> {
  const repo = getBrowserRepository()
  const now = input.now ?? Date.now()
  const targets = await Promise.all(input.refs.map(resolveRefTarget))
  if (!(await repo.getAttachment(input.newAttachmentId))) {
    throw new Error(`AttachmentMissing:${input.newAttachmentId}`)
  }
  const updated: MessageAttachmentRef[] = []
  const oldIds: AttachmentId[] = []
  const scopes = dedupeScopes([
    ...targets.flatMap((target) => scopesForTarget(target)),
    { kind: 'attachment', attachmentId: input.newAttachmentId },
  ])
  await repo.runMutation(scopes, async (ctx) => {
    for (let i = 0; i < targets.length; i += 1) {
      const target = targets[i]
      const spec = input.refs[i]
      if (!target || !spec) continue
      if (target.kind === 'message') {
        const message = await mustGetMessage(ctx, target.message.id)
        const refs = normalizeAttachmentRefs(message.attachmentRefs, {
          messageId: message.id,
          createdAt: message.createdAt,
        })
        const next = refs.map((ref) => {
          if (ref.refId !== spec.refId) return ref
          oldIds.push(ref.attachmentId)
          const relinked = { ...ref, attachmentId: input.newAttachmentId, updatedAt: now }
          updated.push(relinked)
          return relinked
        })
        await ctx.putMessage(messageWithAttachmentRefs(message, next), {
          touchChatSummary: false,
          broadcast: true,
        })
      } else {
        const draft = (await ctx.getDraft(target.draft.chatId)) ?? target.draft
        const refs = normalizeAttachmentRefs(draft.attachmentRefs, {
          draftChatId: draft.chatId,
          createdAt: draft.updatedAt,
        })
        const next = refs.map((ref) => {
          if (ref.refId !== spec.refId) return ref
          oldIds.push(ref.attachmentId)
          const relinked = { ...ref, attachmentId: input.newAttachmentId, updatedAt: now }
          updated.push(relinked)
          return relinked
        })
        await ctx.putDraft({ ...draft, attachmentRefs: next, updatedAt: now })
      }
    }
    await decRefs(ctx, oldIds)
    await incRefs(ctx, updated)
  })
  return updated
}

export async function deleteReferencedAttachmentBytes(
  attachmentId: AttachmentId,
  reason: AttachmentMissingReason = 'deleted',
  now = Date.now(),
): Promise<Attachment | undefined> {
  const repo = getBrowserRepository()
  const blobs = (await repo.getAttachmentBundle(attachmentId))?.blobs ?? []
  let updated: Attachment | undefined
  await repo.runMutation([{ kind: 'attachment', attachmentId }], async (ctx) => {
    const current = await ctx.getAttachment(attachmentId)
    if (!current) return
    for (const blob of blobs) await ctx.deleteAttachmentBlob(blob.id)
    updated = markMissingRow(current, reason, now)
    await ctx.putAttachment(updated)
  })
  return updated
}

export async function restoreMissingAttachment(
  input: RestoreMissingAttachmentInput,
): Promise<MessageAttachmentRef[]> {
  const updated = await batchRelinkAttachmentRefs({
    oldAttachmentId: input.missingAttachmentId,
    newAttachmentId: input.replacementAttachmentId,
    refs: input.refs,
    ...(input.now !== undefined ? { now: input.now } : {}),
  })
  const repo = getBrowserRepository()
  await repo.runMutation(
    [
      { kind: 'attachment', attachmentId: input.missingAttachmentId },
      { kind: 'attachment', attachmentId: input.replacementAttachmentId },
    ],
    async (ctx) => {
      const missing = await ctx.getAttachment(input.missingAttachmentId)
      if (!missing) return
      await ctx.putAttachment({
        ...missing,
        supersededByAttachmentId: input.replacementAttachmentId,
        updatedAt: input.now ?? Date.now(),
      })
    },
  )
  return updated
}

export async function deleteUnreferencedAttachment(
  attachmentId: AttachmentId,
): Promise<{ deleted: boolean; refs: { messages: number; drafts: number } }> {
  const refs = await countLiveRefs(attachmentId)
  if (refs.messages + refs.drafts > 0) return { deleted: false, refs }
  const repo = getBrowserRepository()
  await repo.runMutation([{ kind: 'attachment', attachmentId }], async (ctx) => {
    await ctx.deleteAttachment(attachmentId)
  })
  return { deleted: true, refs }
}

export async function reapOrphanedAttachments(
  opts: OrphanReapOptions = {},
): Promise<AttachmentId[]> {
  const olderThanMs = opts.olderThanMs ?? DEFAULT_ORPHAN_GC_AGE_MS
  const now = opts.now ?? Date.now()
  const cutoff = now - olderThanMs
  const db = await openDb()
  const candidates = await db.attachments
    .where('refCount')
    .equals(0)
    .filter((att) => att.createdAt < cutoff)
    .toArray()
  const deleted: AttachmentId[] = []
  for (const candidate of candidates) {
    const result = await deleteUnreferencedAttachment(candidate.id)
    if (result.deleted) deleted.push(candidate.id)
  }
  return deleted
}

export async function countLiveRefs(
  id: AttachmentId,
): Promise<{ messages: number; drafts: number }> {
  const db = await openDb()
  let messages = 0
  let drafts = 0
  await db.messages.each((m) => {
    if (liveAttachmentRefs(m.attachmentRefs).some((ref) => ref.attachmentId === id)) {
      messages += 1
    }
  })
  await db.drafts.each((d) => {
    if (liveAttachmentRefs(d.attachmentRefs).some((ref) => ref.attachmentId === id)) {
      drafts += 1
    }
  })
  return { messages, drafts }
}

export async function listAttachmentReferences(
  id: AttachmentId,
): Promise<AttachmentReferenceRow[]> {
  const db = await openDb()
  const [chats, messages, drafts] = await Promise.all([
    db.chats.toArray(),
    db.messages.toArray(),
    db.drafts.toArray(),
  ])
  const chatById = new Map(chats.map((chat) => [chat.id, chat]))
  const rows: AttachmentReferenceRow[] = []
  for (const message of messages) {
    const refs = normalizeAttachmentRefs(message.attachmentRefs, {
      messageId: message.id,
      createdAt: message.createdAt,
    }).filter((ref) => ref.attachmentId === id && !ref.deletedAt)
    if (refs.length === 0) continue
    const chat = chatById.get(message.chatId)
    for (const ref of refs) {
      rows.push({
        ownerKind: 'message',
        chatId: message.chatId,
        chatTitle: displayChatTitle(chat),
        chatTitleStatus: chat?.titleStatus ?? 'untitled',
        messageId: message.id,
        role: message.role,
        messageCreatedAt: message.createdAt,
        ref,
      })
    }
  }
  for (const draft of drafts) {
    const refs = normalizeAttachmentRefs(draft.attachmentRefs, {
      draftChatId: draft.chatId,
      createdAt: draft.updatedAt,
    }).filter((ref) => ref.attachmentId === id && !ref.deletedAt)
    if (refs.length === 0) continue
    const chat = chatById.get(draft.chatId)
    for (const ref of refs) {
      rows.push({
        ownerKind: 'draft',
        chatId: draft.chatId,
        chatTitle: displayChatTitle(chat),
        chatTitleStatus: chat?.titleStatus ?? 'untitled',
        draftChatId: draft.chatId,
        ref,
      })
    }
  }
  rows.sort(
    (a, b) => (b.messageCreatedAt ?? b.ref.createdAt) - (a.messageCreatedAt ?? a.ref.createdAt),
  )
  return rows
}

export function attachmentScopes(refs: readonly AttachmentRef[] | undefined): MutationScope[] {
  return uniqueAttachmentIdsOf(refs).map((attachmentId) => ({
    kind: 'attachment',
    attachmentId,
  }))
}

export { attachmentIdOf, attachmentRefsFromIds }

function metadataAndOptionalBlob(row: PendingAttachment): {
  metadata: Attachment
  blobRow?: AttachmentBlob
} {
  const { blob, ...metadata } = row
  if (!blob || metadata.storage.kind !== 'local-blob' || !metadata.contentHash) {
    return { metadata }
  }
  return {
    metadata,
    blobRow: {
      id: metadata.storage.blobId,
      attachmentId: metadata.id,
      role: 'original',
      mime: metadata.mime,
      contentHash: metadata.contentHash,
      sizeBytes: blob.size,
      blob,
      createdAt: metadata.createdAt,
    },
  }
}

function bundleFromProcessed(result: ProcessAttachmentResult, blob: Blob): AttachmentBundle {
  const attachmentId = result.attachment.id
  const blobId = newId()
  const contentHash = result.attachment.contentHash
  if (!contentHash) throw new Error(`AttachmentHashMissing:${attachmentId}`)
  const artifacts = result.artifacts.map((artifact) => artifactFromProcessed(artifact))
  const processing = result.processing.map((state) =>
    processingFromProcessed(state, contentHash, artifacts),
  )
  const attachment: Attachment = {
    id: attachmentId,
    contentHash,
    kind: canonicalKind(result.attachment.kind),
    mime: result.attachment.mime,
    filename: result.attachment.filename,
    ...(result.attachment.extension ? { extension: result.attachment.extension } : {}),
    ...(result.attachment.sizeBytes !== undefined
      ? { sizeBytes: result.attachment.sizeBytes }
      : {}),
    origin: result.attachment.origin,
    ...(result.attachment.sourceUrl ? { sourceUrl: result.attachment.sourceUrl } : {}),
    createdAt: result.attachment.createdAt,
    updatedAt: result.attachment.updatedAt,
    storage: { kind: 'local-blob', blobId },
    ...(result.attachment.dimensions ? { dimensions: result.attachment.dimensions } : {}),
    ...(result.attachment.durationMs !== undefined
      ? { durationMs: result.attachment.durationMs }
      : {}),
    ...(result.attachment.pageCount !== undefined
      ? { pageCount: result.attachment.pageCount }
      : {}),
    ...(result.attachment.textCharCount !== undefined
      ? { textCharCount: result.attachment.textCharCount }
      : {}),
    ...(result.attachment.languageHint ? { languageHint: result.attachment.languageHint } : {}),
    ...(result.attachment.scannedLike !== undefined
      ? { scannedLike: result.attachment.scannedLike }
      : {}),
    artifacts,
    processing,
    refCount: result.attachment.refCount,
  }
  return {
    attachment,
    blobs: [
      {
        id: blobId,
        attachmentId,
        role: 'original',
        mime: result.attachment.mime,
        contentHash,
        sizeBytes: result.attachment.sizeBytes ?? blob.size,
        blob,
        createdAt: result.attachment.createdAt,
      },
    ],
    artifacts,
    jobs: processing.map((state) =>
      jobFromProcessing(attachmentId, state, result.attachment.updatedAt),
    ),
  }
}

function artifactFromProcessed(artifact: ProcessedArtifact): AttachmentArtifact {
  if (artifact.kind === 'text') {
    const text = artifact.text ?? ''
    return {
      kind: 'text',
      artifactId: artifact.id,
      attachmentId: artifact.attachmentId,
      processorId: artifact.processorId,
      text,
      charCount: text.length,
      tokenEstimate: textTokenEstimate(text, artifact.processorId, artifact.createdAt),
      createdAt: artifact.createdAt,
    }
  }
  return {
    kind: 'json',
    artifactId: artifact.id,
    attachmentId: artifact.attachmentId,
    processorId: artifact.processorId,
    value: {
      sourceKind: artifact.kind,
      label: artifact.label,
      ...(artifact.mime ? { mime: artifact.mime } : {}),
      ...(artifact.metadata ? { metadata: artifact.metadata } : {}),
    },
    createdAt: artifact.createdAt,
  }
}

function processingFromProcessed(
  state: ProcessedState,
  fallbackHash: string,
  artifacts: readonly AttachmentArtifact[],
): AttachmentJob['outputArtifactIds'] extends string[]
  ? Omit<AttachmentJob, 'id' | 'attachmentId' | 'updatedAt'>
  : never {
  const status =
    state.status === 'ready' ? 'succeeded' : state.status === 'failed' ? 'failed' : 'skipped'
  return {
    processorId: state.processorId,
    inputHash: state.inputHash ?? fallbackHash,
    status,
    finishedAt: state.updatedAt,
    ...(state.message ? { error: { code: status, message: state.message } } : {}),
    outputArtifactIds: artifacts
      .filter((artifact) => artifact.processorId === state.processorId)
      .map((artifact) => artifact.artifactId),
  }
}

function jobFromProcessing(
  attachmentId: AttachmentId,
  state: Omit<AttachmentJob, 'id' | 'attachmentId' | 'updatedAt'>,
  updatedAt: number,
): AttachmentJob {
  return {
    id: `${attachmentId}:${state.processorId}:${state.inputHash}`,
    attachmentId,
    ...state,
    updatedAt,
  }
}

function textTokenEstimate(
  text: string,
  processorId: string,
  computedAt: number,
): AttachmentTokenEstimate {
  return {
    modelKey: 'family-default',
    modality: 'plaintext',
    contextForm: 'client-extracted-text',
    tokens: Math.max(1, Math.ceil(text.length / 4)),
    source: 'calibrated-text',
    computedAt,
    processorId,
  }
}

function canonicalKind(kind: AttachmentKind): AttachmentKind {
  return kind === 'file' ? 'other' : kind
}

function multiset(ids: readonly AttachmentId[]): Map<AttachmentId, number> {
  const counts = new Map<AttachmentId, number>()
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1)
  return counts
}

function insertRef(
  refs: readonly MessageAttachmentRef[],
  ref: MessageAttachmentRef,
  afterRefId?: string,
): MessageAttachmentRef[] {
  if (!afterRefId) return [...refs, ref]
  const index = refs.findIndex((candidate) => candidate.refId === afterRefId)
  if (index === -1) return [...refs, ref]
  return [...refs.slice(0, index + 1), ref, ...refs.slice(index + 1)]
}

function messageWithAttachmentRefs(
  message: Message,
  attachmentRefs: MessageAttachmentRef[],
): Message {
  const next: Message = { ...message, attachmentRefs }
  delete next.cachedMediaTokens
  return next
}

async function resolveRefTarget(input: AttachmentRefTarget): Promise<
  | { kind: 'message'; message: Message }
  | {
      kind: 'draft'
      draft: { chatId: ChatId; text: string; attachmentRefs: AttachmentRef[]; updatedAt: number }
    }
> {
  const repo = getBrowserRepository()
  if (input.messageId) {
    const message = await repo.getMessage(input.messageId)
    if (!message) throw new Error(`MessageMissing:${input.messageId}`)
    return { kind: 'message', message }
  }
  if (input.draftChatId) {
    const draft = await repo.getDraft(input.draftChatId)
    return {
      kind: 'draft',
      draft: draft ?? { chatId: input.draftChatId, text: '', attachmentRefs: [], updatedAt: 0 },
    }
  }
  throw new Error('AttachmentRefTargetMissing')
}

function scopesForTarget(
  target:
    | { kind: 'message'; message: Message }
    | { kind: 'draft'; draft: { chatId: ChatId; attachmentRefs?: readonly AttachmentRef[] } },
  extraAttachmentIds: readonly AttachmentId[] = [],
): MutationScope[] {
  const base =
    target.kind === 'message'
      ? [{ kind: 'message' as const, messageId: target.message.id }]
      : [{ kind: 'draft' as const, chatId: target.draft.chatId }]
  const refs =
    target.kind === 'message' ? target.message.attachmentRefs : target.draft.attachmentRefs
  return dedupeScopes([
    ...base,
    ...attachmentScopes(refs),
    ...extraAttachmentIds.map((attachmentId) => ({ kind: 'attachment' as const, attachmentId })),
  ])
}

function dedupeScopes(scopes: readonly MutationScope[]): MutationScope[] {
  const seen = new Set<string>()
  const out: MutationScope[] = []
  for (const scope of scopes) {
    const key =
      scope.kind === 'message'
        ? `message:${scope.messageId}`
        : scope.kind === 'children'
          ? `children:${scope.chatId}:${scope.parentId ?? '__root__'}`
          : scope.kind === 'attachment'
            ? `attachment:${scope.attachmentId}`
            : scope.kind === 'draft'
              ? `draft:${scope.chatId}`
              : `chat-meta:${scope.chatId}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(scope)
  }
  return out
}

async function mustGetMessage(ctx: MutationContext, messageId: MessageId): Promise<Message> {
  const message = await ctx.getMessage(messageId)
  if (!message) throw new Error(`MessageMissing:${messageId}`)
  return message
}

function markMissingRow(
  attachment: Attachment,
  reason: AttachmentMissingReason,
  now: number,
): Attachment {
  const lastKnownBlobId =
    attachment.storage.kind === 'local-blob' ? attachment.storage.blobId : undefined
  return {
    ...attachment,
    updatedAt: now,
    storage: {
      kind: 'missing',
      reason,
      missingSince: now,
      ...(lastKnownBlobId ? { lastKnownBlobId } : {}),
    },
  }
}

function displayChatTitle(chat: { title?: string; id: ChatId } | undefined): string {
  const trimmed = chat?.title?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : 'Untitled chat'
}
