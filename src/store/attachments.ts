// Attachment backend primitives. UI code should eventually call these through
// the repository/storage-manager surface, not mutate Dexie tables directly.

import {
  fileExtension,
  processAttachment,
  sha256Hex as sha256BytesHex,
} from '../core/attachments/process'
import type {
  ProcessAttachmentResult,
  AttachmentArtifact as ProcessedArtifact,
  AttachmentProcessingState as ProcessedState,
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
  AttachmentReferenceEdge,
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
  attachmentRefsFromIds,
  createAttachmentRef,
  liveAttachmentRefs,
  normalizeAttachmentRefs,
} from './attachment-refs'
import { getBrowserRepository } from './browser-repo'
import { openDb } from './db'
import type { MessagePresentation } from './message-storage'
import type { MutationContext } from './repository'
import { getWorkspaceRepository } from './workspace-repository'

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

export interface PreparedAttachmentBundle {
  attachment: Attachment
  blobs: AttachmentBlob[]
  artifacts: AttachmentArtifact[]
  jobs: AttachmentJob[]
}

type AttachmentBundle = PreparedAttachmentBundle

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

export type MessageAttachmentRefMutation =
  | { kind: 'visibility'; refId: string; includeInContext: boolean }
  | { kind: 'detach'; refId: string }
  | { kind: 'relink'; refId: string; newAttachmentId: AttachmentId }

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

export async function prepareAttachmentBytes(input: {
  blob: Blob
  filename: string
  declaredMime?: string
  origin?: AttachmentOrigin
  sourceUrl?: string
  id: AttachmentId
  now?: number
}): Promise<PreparedAttachmentBundle> {
  const bytes = new Uint8Array(await input.blob.arrayBuffer())
  const processed = await processAttachment({
    id: input.id,
    filename: input.filename,
    bytes,
    ...(input.declaredMime ? { declaredMime: input.declaredMime } : {}),
    ...(input.origin ? { origin: input.origin } : {}),
    ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
    ...(input.now !== undefined ? { now: input.now } : {}),
  })
  return bundleFromProcessed(processed, input.blob)
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
  const attachment = remoteAttachment(input)
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

export function prepareRemoteAttachment(input: {
  url: string
  filename: string
  mime?: string
  kind?: AttachmentKind
  origin?: AttachmentOrigin
  id: AttachmentId
  now?: number
}): PreparedAttachmentBundle {
  return { attachment: remoteAttachment(input), blobs: [], artifacts: [], jobs: [] }
}

export async function persistPreparedAttachmentBundle(
  ctx: MutationContext,
  bundle: PreparedAttachmentBundle,
): Promise<Attachment> {
  const existing = await ctx.getAttachment(bundle.attachment.id)
  if (existing) {
    const references = await ctx.countAttachmentReferences(existing.id)
    if (
      references.occurrences > 0 ||
      preparedAttachmentMatchesExisting(existing, bundle.attachment)
    ) {
      return existing
    }
    await ctx.deleteAttachment(existing.id)
  }
  await writeAttachmentBundle(ctx, bundle)
  return bundle.attachment
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
  const result = { wrote: false }
  await repo.runMutation(
    [{ kind: 'attachment', attachmentId: bundle.attachment.id }],
    async (ctx) => {
      const existing = await ctx.getAttachment(bundle.attachment.id)
      if (existing) return
      await writeAttachmentBundle(ctx, bundle)
      result.wrote = true
    },
  )
  if (result.wrote) return bundle
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

function remoteAttachment(input: CreateRemoteAttachmentInput): Attachment {
  const now = input.now ?? Date.now()
  const extension = fileExtension(input.filename)
  return {
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
}

function preparedAttachmentMatchesExisting(existing: Attachment, prepared: Attachment): boolean {
  if (
    existing.storage.kind === 'local-blob' &&
    prepared.contentHash !== undefined &&
    existing.contentHash === prepared.contentHash
  ) {
    return true
  }
  if (
    existing.storage.kind !== 'missing' &&
    prepared.sourceUrl !== undefined &&
    existing.sourceUrl === prepared.sourceUrl
  ) {
    return true
  }
  return false
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
      const current = await ctx.getAttachment(previous.attachment.id)
      if (!current) throw new Error(`AttachmentMissing:${previous.attachment.id}`)
      await ctx.deleteAttachmentBlobs(previous.attachment.id)
      await ctx.deleteAttachmentArtifacts(previous.attachment.id)
      await ctx.deleteAttachmentJobs(previous.attachment.id)
      await ctx.putAttachment({ ...next.attachment, createdAt: current.createdAt })
      for (const blob of next.blobs) await ctx.putAttachmentBlob(blob)
      for (const artifact of next.artifacts) await ctx.putAttachmentArtifact(artifact)
      for (const job of next.jobs) await ctx.putAttachmentJob(job)
    },
  )
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
  await repo.runMutation(scopesForTarget(target), async (ctx) => {
    if (target.kind === 'message') {
      const message = await mustGetMessage(ctx, target.message.id)
      const refs = normalizeAttachmentRefs(message.attachmentRefs, {
        messageId: message.id,
        createdAt: message.createdAt,
      })
      const removed = refs.find((ref) => ref.refId === input.refId)
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
      const removed = refs.find((ref) => ref.refId === input.refId)
      if (!removed) return
      await ctx.putDraft({
        ...draft,
        attachmentRefs: refs.filter((ref) => ref.refId !== input.refId),
        updatedAt: now,
      })
    }
  })
}

export async function relinkAttachmentRef(
  input: RelinkAttachmentRefInput,
): Promise<MessageAttachmentRef> {
  const result = await mutateAttachmentReferenceTargets({
    newAttachmentId: input.newAttachmentId,
    refs: [input],
    ...(input.now !== undefined ? { now: input.now } : {}),
  })
  const updated = result[0]
  if (!updated) throw new Error(`AttachmentRefMissing:${input.refId}`)
  return updated
}

export async function mutateMessageAttachmentRef(input: {
  chatId: ChatId
  messageId: MessageId
  mutation: MessageAttachmentRefMutation
  now?: number
}): Promise<MessagePresentation | undefined> {
  const repo = getWorkspaceRepository()
  const target = await repo.getMessage(input.messageId)
  if (!target || target.chatId !== input.chatId) return undefined
  const extraAttachmentIds =
    input.mutation.kind === 'relink' ? [input.mutation.newAttachmentId] : []
  const result = await repo.runMutation(
    scopesForTarget({ kind: 'message', message: target }, extraAttachmentIds),
    async (ctx) => {
      const current = await ctx.getMessage(input.messageId)
      if (!current || current.chatId !== input.chatId) return undefined
      const refs = normalizeAttachmentRefs(current.attachmentRefs, {
        messageId: current.id,
        createdAt: current.createdAt,
      })
      const index = refs.findIndex((ref) => ref.refId === input.mutation.refId)
      if (index < 0) return undefined

      const nextRefs = [...refs]
      if (input.mutation.kind === 'detach') {
        nextRefs.splice(index, 1)
      } else {
        const existing = refs[index] as MessageAttachmentRef
        if (input.mutation.kind === 'relink') {
          if (!(await ctx.getAttachment(input.mutation.newAttachmentId))) {
            throw new Error(`AttachmentMissing:${input.mutation.newAttachmentId}`)
          }
          nextRefs[index] = {
            ...existing,
            attachmentId: input.mutation.newAttachmentId,
            updatedAt: input.now ?? Date.now(),
          }
        } else {
          nextRefs[index] = {
            ...existing,
            includeInContext: input.mutation.includeInContext,
            updatedAt: input.now ?? Date.now(),
          }
        }
      }

      await ctx.putMessage(messageWithAttachmentRefs(current, nextRefs), {
        touchChatSummary: false,
        broadcast: true,
      })
      const [header, message] = await Promise.all([
        ctx.getMessageHeader(input.messageId),
        ctx.getMessage(input.messageId),
      ])
      if (!header || !message) return undefined
      return { header, message, bodyVersion: header.bodyVersion }
    },
  )
  return result.value
}

export async function batchRelinkAttachmentRefs(
  input: BatchRelinkAttachmentRefsInput,
): Promise<MessageAttachmentRef[]> {
  return mutateAttachmentReferenceTargets(input)
}

async function mutateAttachmentReferenceTargets(
  input: Omit<BatchRelinkAttachmentRefsInput, 'oldAttachmentId'> & {
    oldAttachmentId?: AttachmentId
    supersedeAttachmentId?: AttachmentId
  },
): Promise<MessageAttachmentRef[]> {
  const repo = getBrowserRepository()
  const now = input.now ?? Date.now()
  const targets = await Promise.all(input.refs.map(resolveRefTarget))
  const scopes = dedupeScopes([
    ...targets.flatMap((target) => scopesForTarget(target)),
    { kind: 'attachment', attachmentId: input.newAttachmentId },
    ...(input.oldAttachmentId
      ? [{ kind: 'attachment' as const, attachmentId: input.oldAttachmentId }]
      : []),
    ...(input.supersedeAttachmentId
      ? [{ kind: 'attachment' as const, attachmentId: input.supersedeAttachmentId }]
      : []),
  ])
  const updatedByIndex = new Map<number, MessageAttachmentRef>()
  await repo.runMutation(scopes, async (ctx) => {
    if (!(await ctx.getAttachment(input.newAttachmentId))) {
      throw new Error(`AttachmentMissing:${input.newAttachmentId}`)
    }

    const grouped = new Map<
      string,
      {
        target: (typeof targets)[number]
        specs: Array<{ index: number; refId: string; expectedAttachmentId: AttachmentId }>
      }
    >()
    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index]
      const spec = input.refs[index]
      if (!target || !spec) throw new Error('AttachmentRelinkTargetMismatch')
      const key =
        target.kind === 'message' ? `message:${target.message.id}` : `draft:${target.draft.chatId}`
      const group = grouped.get(key) ?? { target, specs: [] }
      if (group.specs.some((candidate) => candidate.refId === spec.refId)) {
        throw new Error(`DuplicateAttachmentRelinkSpec:${key}:${spec.refId}`)
      }
      group.specs.push({
        index,
        refId: spec.refId,
        expectedAttachmentId:
          input.oldAttachmentId ?? attachmentIdFromTargetSnapshot(target, spec.refId),
      })
      grouped.set(key, group)
    }

    const writes: Array<
      | { kind: 'message'; message: Message; refs: MessageAttachmentRef[] }
      | {
          kind: 'draft'
          draft: {
            chatId: ChatId
            text: string
            attachmentRefs: AttachmentRef[]
            updatedAt: number
          }
          refs: MessageAttachmentRef[]
        }
    > = []
    for (const { target, specs } of grouped.values()) {
      if (target.kind === 'message') {
        const message = await mustGetMessage(ctx, target.message.id)
        const refs = normalizeAttachmentRefs(message.attachmentRefs, {
          messageId: message.id,
          createdAt: message.createdAt,
        })
        writes.push({
          kind: 'message',
          message,
          refs: relinkOwnerRefs(refs, specs, input, now, updatedByIndex),
        })
      } else {
        const draft = await ctx.getDraft(target.draft.chatId)
        if (!draft) throw new Error(`DraftMissing:${target.draft.chatId}`)
        const refs = normalizeAttachmentRefs(draft.attachmentRefs, {
          draftChatId: draft.chatId,
          createdAt: draft.updatedAt,
        })
        writes.push({
          kind: 'draft',
          draft,
          refs: relinkOwnerRefs(refs, specs, input, now, updatedByIndex),
        })
      }
    }

    for (const write of writes) {
      if (write.kind === 'message') {
        await ctx.putMessage(messageWithAttachmentRefs(write.message, write.refs), {
          touchChatSummary: false,
          broadcast: true,
        })
      } else {
        await ctx.putDraft({ ...write.draft, attachmentRefs: write.refs, updatedAt: now })
      }
    }

    if (input.supersedeAttachmentId) {
      const superseded = await ctx.getAttachment(input.supersedeAttachmentId)
      if (!superseded) throw new Error(`AttachmentMissing:${input.supersedeAttachmentId}`)
      await ctx.putAttachment({
        ...superseded,
        supersededByAttachmentId: input.newAttachmentId,
        updatedAt: now,
      })
    }
  })
  return input.refs.map((spec, index) => {
    const updated = updatedByIndex.get(index)
    if (!updated) throw new Error(`AttachmentRefMissing:${spec.refId}`)
    return updated
  })
}

function relinkOwnerRefs(
  refs: readonly MessageAttachmentRef[],
  specs: readonly { index: number; refId: string; expectedAttachmentId: AttachmentId }[],
  input: { newAttachmentId: AttachmentId },
  now: number,
  updatedByIndex: Map<number, MessageAttachmentRef>,
): MessageAttachmentRef[] {
  const specByRefId = new Map(specs.map((spec) => [spec.refId, spec]))
  const matched = new Set<string>()
  const next = refs.map((ref) => {
    const spec = specByRefId.get(ref.refId)
    if (!spec) return ref
    if (ref.deletedAt !== undefined) {
      throw new Error(`AttachmentRefNotLive:${ref.refId}`)
    }
    if (ref.attachmentId !== spec.expectedAttachmentId) {
      throw new Error(
        `AttachmentRelinkStale:${ref.refId}:${spec.expectedAttachmentId}:${ref.attachmentId}`,
      )
    }
    matched.add(ref.refId)
    const relinked = { ...ref, attachmentId: input.newAttachmentId, updatedAt: now }
    updatedByIndex.set(spec.index, relinked)
    return relinked
  })
  for (const spec of specs) {
    if (!matched.has(spec.refId)) throw new Error(`AttachmentRefMissing:${spec.refId}`)
  }
  return next
}

function attachmentIdFromTargetSnapshot(
  target: Awaited<ReturnType<typeof resolveRefTarget>>,
  refId: string,
): AttachmentId {
  const refs =
    target.kind === 'message'
      ? normalizeAttachmentRefs(target.message.attachmentRefs, {
          messageId: target.message.id,
          createdAt: target.message.createdAt,
        })
      : normalizeAttachmentRefs(target.draft.attachmentRefs, {
          draftChatId: target.draft.chatId,
          createdAt: target.draft.updatedAt,
        })
  const ref = refs.find((candidate) => candidate.refId === refId)
  if (!ref) throw new Error(`AttachmentRefMissing:${refId}`)
  if (ref.deletedAt !== undefined) throw new Error(`AttachmentRefNotLive:${refId}`)
  return ref.attachmentId
}

export async function deleteReferencedAttachmentBytes(
  attachmentId: AttachmentId,
  reason: AttachmentMissingReason = 'deleted',
  now = Date.now(),
): Promise<Attachment | undefined> {
  const repo = getBrowserRepository()
  for (;;) {
    const snapshot = await repo.getAttachmentBundle(attachmentId)
    if (!snapshot) return undefined
    const result = { retry: false, updated: undefined as Attachment | undefined }
    await repo.runMutation([{ kind: 'attachment', attachmentId }], async (ctx) => {
      const current = await ctx.getAttachment(attachmentId)
      if (!current) return
      if (attachmentRevision(current) !== attachmentRevision(snapshot.attachment)) {
        result.retry = true
        return
      }

      const artifacts = snapshot.artifacts.filter((artifact) => artifact.kind !== 'blob')
      const artifactIds = new Set(artifacts.map((artifact) => artifact.artifactId))
      const processing = current.processing.flatMap((state) => {
        const outputArtifactIds = state.outputArtifactIds.filter((id) => artifactIds.has(id))
        return state.outputArtifactIds.length > 0 && outputArtifactIds.length === 0
          ? []
          : [{ ...state, outputArtifactIds }]
      })

      await ctx.deleteAttachmentBlobs(attachmentId)
      for (const artifact of snapshot.artifacts) {
        if (artifact.kind === 'blob') await ctx.deleteAttachmentArtifact(artifact.artifactId)
      }
      for (const job of snapshot.jobs) {
        const outputArtifactIds = job.outputArtifactIds.filter((id) => artifactIds.has(id))
        if (job.outputArtifactIds.length > 0 && outputArtifactIds.length === 0) {
          await ctx.deleteAttachmentJob(job.id)
        } else if (!sameStringArray(outputArtifactIds, job.outputArtifactIds)) {
          await ctx.putAttachmentJob({ ...job, outputArtifactIds, updatedAt: now })
        }
      }

      result.updated = markMissingRow(current, reason, now, artifacts, processing)
      await ctx.putAttachment(result.updated)
    })
    if (!result.retry) return result.updated
  }
}

export async function restoreMissingAttachment(
  input: RestoreMissingAttachmentInput,
): Promise<MessageAttachmentRef[]> {
  return mutateAttachmentReferenceTargets({
    oldAttachmentId: input.missingAttachmentId,
    newAttachmentId: input.replacementAttachmentId,
    refs: input.refs,
    supersedeAttachmentId: input.missingAttachmentId,
    ...(input.now !== undefined ? { now: input.now } : {}),
  })
}

export async function deleteUnreferencedAttachment(
  attachmentId: AttachmentId,
): Promise<{ deleted: boolean; refs: { messages: number; drafts: number } }> {
  const repo = getBrowserRepository()
  let deleted = false
  let refs = { messages: 0, drafts: 0 }
  await repo.runMutation([{ kind: 'attachment', attachmentId }], async (ctx) => {
    const counts = await ctx.countAttachmentReferences(attachmentId)
    refs = { messages: counts.messages, drafts: counts.drafts }
    if (counts.occurrences > 0) return
    if (!(await ctx.getAttachment(attachmentId))) return
    await ctx.deleteAttachment(attachmentId)
    deleted = true
  })
  return { deleted, refs }
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
  const edges = await db.attachmentRefEdges.where('attachmentId').equals(id).toArray()
  return {
    messages: new Set(
      edges.filter((edge) => edge.ownerKind === 'message').map((edge) => edge.ownerId),
    ).size,
    drafts: new Set(edges.filter((edge) => edge.ownerKind === 'draft').map((edge) => edge.ownerId))
      .size,
  }
}

export async function listAttachmentReferences(
  id: AttachmentId,
): Promise<AttachmentReferenceRow[]> {
  const db = await openDb()
  const edges = await listAttachmentReferenceEdges(id)
  if (edges.length === 0) return []
  const messageIds = [
    ...new Set(edges.filter((edge) => edge.ownerKind === 'message').map((edge) => edge.ownerId)),
  ]
  const draftIds = [
    ...new Set(edges.filter((edge) => edge.ownerKind === 'draft').map((edge) => edge.ownerId)),
  ]
  const chatIds = [...new Set(edges.map((edge) => edge.chatId))]
  const [chats, messages, drafts] = await Promise.all([
    db.chats.bulkGet(chatIds),
    db.messages.bulkGet(messageIds),
    db.drafts.bulkGet(draftIds),
  ])
  const chatById = new Map(chats.flatMap((chat) => (chat ? [[chat.id, chat]] : [])))
  const messageById = new Map(
    messages.flatMap((message) => (message ? [[message.id, message]] : [])),
  )
  const draftById = new Map(drafts.flatMap((draft) => (draft ? [[draft.chatId, draft]] : [])))
  const rows: AttachmentReferenceRow[] = []
  for (const edge of edges) {
    if (edge.ownerKind === 'message') {
      const message = messageById.get(edge.ownerId)
      if (!message) throw attachmentEdgeOwnerMissing(edge)
      const ref = normalizeAttachmentRefs(message.attachmentRefs, {
        messageId: message.id,
        createdAt: message.createdAt,
      }).find(
        (candidate) =>
          candidate.refId === edge.refId &&
          candidate.attachmentId === edge.attachmentId &&
          candidate.deletedAt === undefined,
      )
      if (!ref) throw attachmentEdgeRefMissing(edge)
      const chat = chatById.get(message.chatId)
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
    } else {
      const draft = draftById.get(edge.ownerId)
      if (!draft) throw attachmentEdgeOwnerMissing(edge)
      const ref = normalizeAttachmentRefs(draft.attachmentRefs, {
        draftChatId: draft.chatId,
        createdAt: draft.updatedAt,
      }).find(
        (candidate) =>
          candidate.refId === edge.refId &&
          candidate.attachmentId === edge.attachmentId &&
          candidate.deletedAt === undefined,
      )
      if (!ref) throw attachmentEdgeRefMissing(edge)
      const chat = chatById.get(draft.chatId)
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

export async function listAttachmentReferenceEdges(
  id: AttachmentId,
): Promise<AttachmentReferenceEdge[]> {
  const db = await openDb()
  return db.attachmentRefEdges.where('attachmentId').equals(id).toArray()
}

function attachmentEdgeOwnerMissing(edge: AttachmentReferenceEdge): Error {
  return new Error(`AttachmentReferenceOwnerMissing:${edge.ownerKind}:${edge.ownerId}`)
}

function attachmentEdgeRefMissing(edge: AttachmentReferenceEdge): Error {
  return new Error(
    `AttachmentReferenceProjectionMismatch:${edge.ownerKind}:${edge.ownerId}:${edge.refId}`,
  )
}

export function attachmentScopes(refs: readonly AttachmentRef[] | undefined): MutationScope[] {
  return [...new Set(liveAttachmentRefs(refs).map((ref) => ref.attachmentId))].map(
    (attachmentId) => ({
      kind: 'attachment',
      attachmentId,
    }),
  )
}

export { attachmentRefsFromIds }

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
  artifacts: AttachmentArtifact[],
  processing: Attachment['processing'],
): Attachment {
  const lastKnownBlobId =
    attachment.storage.kind === 'local-blob'
      ? attachment.storage.blobId
      : attachment.storage.kind === 'missing'
        ? attachment.storage.lastKnownBlobId
        : undefined
  const next: Attachment = {
    ...attachment,
    updatedAt: now,
    storage: {
      kind: 'missing',
      reason,
      missingSince: now,
      ...(lastKnownBlobId ? { lastKnownBlobId } : {}),
    },
    artifacts,
    processing,
  }
  delete next.thumbnailBlobId
  return next
}

function attachmentRevision(attachment: Attachment): string {
  return JSON.stringify({
    updatedAt: attachment.updatedAt,
    refCount: attachment.refCount,
    contentHash: attachment.contentHash,
    storage: attachment.storage,
    thumbnailBlobId: attachment.thumbnailBlobId,
    artifacts: attachment.artifacts.map((artifact) => [
      artifact.artifactId,
      artifact.kind,
      artifact.kind === 'blob' ? artifact.blobId : undefined,
    ]),
    processing: attachment.processing.map((state) => [
      state.processorId,
      state.inputHash,
      state.status,
      state.outputArtifactIds,
    ]),
  })
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function displayChatTitle(chat: { title?: string; id: ChatId } | undefined): string {
  const trimmed = chat?.title?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : 'Untitled chat'
}
