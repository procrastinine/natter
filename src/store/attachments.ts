// Attachment facade. Persistence stays behind WorkspaceRepository.

import { createAttachmentRef, normalizeAttachmentRefs } from '../core/attachment-refs'
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
  AttachmentReferenceEdge,
  AttachmentTokenEstimate,
  ChatId,
  DraftRow,
  MessageAttachmentRef,
  MessageId,
} from '../core/types'
import { newId } from '../lib/ulid'
import type {
  AttachmentMediaProjection,
  AttachmentMediaPurpose,
  AttachmentReferenceRow,
  AttachmentRefOwner,
  MessagePresentation,
  PreparedAttachmentBundle,
  WorkspaceReadAuthority,
} from './workspace-protocol'
import { getWorkspaceRepository } from './workspace-repository'
import { runWorkspaceAction, runWorkspaceRead } from './workspace-runtime'

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

export type { AttachmentReferenceRow, PreparedAttachmentBundle } from './workspace-protocol'

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
  await writeAttachmentBundle(
    {
      attachment: metadata,
      blobs: blobRow ? [blobRow] : [],
      artifacts: metadata.artifacts,
      jobs: metadata.processing.map((state) =>
        jobFromProcessing(metadata.id, state, metadata.updatedAt),
      ),
    },
    'put',
  )
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
  const result = await writeAttachmentBundle(
    bundle,
    input.id === undefined ? 'dedupe' : 'put-if-absent',
  )
  return result.outcome === 'written'
    ? { ...bundle, attachment: result.attachment }
    : ((await getAttachmentBundle(result.attachmentId)) ?? bundle)
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
  const result = await writeAttachmentBundle(bundle, 'dedupe-or-replace')
  if (result.outcome === 'written') {
    return {
      bundle: { ...bundle, attachment: result.attachment },
      reusedExisting: false,
    }
  }
  const existing = await getAttachmentBundle(result.attachmentId)
  if (!existing) throw new Error(`AttachmentMissing:${result.attachmentId}`)
  return {
    bundle: existing,
    reusedExisting: true,
  }
}

export async function createRemoteAttachment(
  input: CreateRemoteAttachmentInput,
): Promise<Attachment> {
  const attachment = remoteAttachment(input)
  const bundle = { attachment, blobs: [], artifacts: [], jobs: [] }
  const result = await writeAttachmentBundle(
    bundle,
    input.id === undefined ? 'put' : 'put-if-absent',
  )
  return result.outcome === 'written'
    ? result.attachment
    : ((await getAttachment(result.attachmentId)) ?? attachment)
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

async function writeAttachmentBundle(
  bundle: AttachmentBundle,
  mode: 'put' | 'put-if-absent' | 'dedupe' | 'replace' | 'dedupe-or-replace',
) {
  return runWorkspaceAction('attachment', (permit) =>
    getWorkspaceRepository()
      .execute(permit, { kind: 'attachment.bundle.write', input: { bundle, mode } })
      .then((commit) => commit.value),
  )
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

export async function getAttachmentBundle(
  attachmentId: AttachmentId,
  authority?: WorkspaceReadAuthority,
): Promise<AttachmentBundle | undefined> {
  const read = (permit: WorkspaceReadAuthority) =>
    getWorkspaceRepository()
      .query(permit, { kind: 'attachment.bundle', attachmentId }, { signal: permit.signal })
      .then((envelope) => envelope.value)
  return authority ? read(authority) : runWorkspaceRead('repository-query', read)
}

export async function getAttachment(
  attachmentId: AttachmentId,
  authority?: WorkspaceReadAuthority,
): Promise<Attachment | undefined> {
  const read = (permit: WorkspaceReadAuthority) =>
    getWorkspaceRepository()
      .query(permit, { kind: 'attachment.get', attachmentId }, { signal: permit.signal })
      .then((envelope) => envelope.value)
  return authority ? read(authority) : runWorkspaceRead('repository-query', read)
}

export async function getAttachmentMedia(
  attachmentId: AttachmentId,
  purpose: AttachmentMediaPurpose,
  authority?: WorkspaceReadAuthority,
): Promise<AttachmentMediaProjection | undefined> {
  const read = (permit: WorkspaceReadAuthority) =>
    getWorkspaceRepository()
      .query(permit, { kind: 'attachment.media', attachmentId, purpose }, { signal: permit.signal })
      .then((envelope) => envelope.value)
  return authority ? read(authority) : runWorkspaceRead('repository-query', read)
}

async function findExistingAttachmentBundle(
  filename: string,
  contentHash: string,
  excludeId?: AttachmentId,
): Promise<AttachmentBundle | undefined> {
  const attachmentId = await runWorkspaceRead('repository-query', (permit) =>
    getWorkspaceRepository()
      .query(
        permit,
        {
          kind: 'attachment.find-hash',
          filename,
          contentHash,
          ...(excludeId === undefined ? {} : { excludeId }),
        },
        { signal: permit.signal },
      )
      .then((envelope) => envelope.value),
  )
  return attachmentId ? getAttachmentBundle(attachmentId) : undefined
}

export async function addExistingAttachmentRef(
  input: AddAttachmentRefInput,
): Promise<MessageAttachmentRef> {
  const now = input.now ?? Date.now()
  const target = await resolveAttachmentRefOwner(input)
  const created = createAttachmentRef(input.attachmentId, {
    ...(target.owner.kind === 'message'
      ? { messageId: target.owner.messageId }
      : { draftChatId: target.owner.chatId }),
    createdAt: now,
  })
  const ref =
    input.includeInContext === undefined
      ? created
      : { ...created, includeInContext: input.includeInContext }
  const commit = await runWorkspaceAction('attachment', (permit) =>
    getWorkspaceRepository().execute(permit, {
      kind: 'attachment.ref.add',
      input: {
        owner: target.owner,
        ref,
        ...(input.afterRefId ? { afterRefId: input.afterRefId } : {}),
        now,
      },
    }),
  )
  if (!commit.value.ref) throw new Error(`AttachmentRefMissing:${ref.refId}`)
  return commit.value.ref
}

export async function setAttachmentRefVisibility(
  targetInput: AttachmentRefTarget & { refId: string; includeInContext: boolean; now?: number },
): Promise<MessageAttachmentRef> {
  const now = targetInput.now ?? Date.now()
  const target = await resolveAttachmentRefOwner(targetInput)
  const expected = requireAttachmentRef(target.refs, targetInput.refId)
  const commit = await runWorkspaceAction('attachment', (permit) =>
    getWorkspaceRepository().execute(permit, {
      kind: 'attachment.ref.set-visibility',
      input: {
        owner: target.owner,
        refId: targetInput.refId,
        expectedAttachmentId: expected.attachmentId,
        includeInContext: targetInput.includeInContext,
        now,
      },
    }),
  )
  if (!commit.value.ref) throw new Error(`AttachmentRefMissing:${targetInput.refId}`)
  return commit.value.ref
}

export async function detachAttachmentRef(
  input: AttachmentRefTarget & { refId: string; now?: number },
): Promise<void> {
  const now = input.now ?? Date.now()
  const target = await resolveAttachmentRefOwner(input)
  const expected = target.refs.find((ref) => ref.refId === input.refId)
  if (!expected) return
  await runWorkspaceAction('attachment', (permit) =>
    getWorkspaceRepository().execute(permit, {
      kind: 'attachment.ref.detach',
      input: {
        owner: target.owner,
        refId: input.refId,
        expectedAttachmentId: expected.attachmentId,
        now,
      },
    }),
  )
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
  const target = await resolveAttachmentRefOwner({ messageId: input.messageId })
  if (target.owner.kind !== 'message' || target.owner.chatId !== input.chatId) return undefined
  const expected = target.refs.find((ref) => ref.refId === input.mutation.refId)
  if (!expected) return undefined
  const now = input.now ?? Date.now()
  return runWorkspaceAction('attachment', async (permit) => {
    if (input.mutation.kind === 'visibility') {
      const commit = await getWorkspaceRepository().execute(permit, {
        kind: 'attachment.ref.set-visibility',
        input: {
          owner: target.owner,
          refId: input.mutation.refId,
          expectedAttachmentId: expected.attachmentId,
          includeInContext: input.mutation.includeInContext,
          now,
        },
      })
      return commit.value.presentation
    }
    if (input.mutation.kind === 'detach') {
      const commit = await getWorkspaceRepository().execute(permit, {
        kind: 'attachment.ref.detach',
        input: {
          owner: target.owner,
          refId: input.mutation.refId,
          expectedAttachmentId: expected.attachmentId,
          now,
        },
      })
      return commit.value.presentation
    }
    const commit = await getWorkspaceRepository().execute(permit, {
      kind: 'attachment.ref.relink',
      input: {
        refs: [
          {
            owner: target.owner,
            refId: input.mutation.refId,
            expectedAttachmentId: expected.attachmentId,
          },
        ],
        newAttachmentId: input.mutation.newAttachmentId,
        now,
      },
    })
    return commit.value.presentations[0]
  })
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
  const now = input.now ?? Date.now()
  const targets = await Promise.all(input.refs.map(resolveAttachmentRefOwner))
  const refs = targets.map((target, index) => {
    const spec = input.refs[index]
    if (!spec) throw new Error('AttachmentRelinkTargetMismatch')
    const expectedAttachmentId =
      input.oldAttachmentId ?? requireAttachmentRef(target.refs, spec.refId).attachmentId
    return { owner: target.owner, refId: spec.refId, expectedAttachmentId }
  })
  const commit = await runWorkspaceAction('attachment', (permit) =>
    getWorkspaceRepository().execute(permit, {
      kind: 'attachment.ref.relink',
      input: {
        refs,
        newAttachmentId: input.newAttachmentId,
        ...(input.supersedeAttachmentId
          ? { supersedeAttachmentId: input.supersedeAttachmentId }
          : {}),
        now,
      },
    }),
  )
  return [...commit.value.refs]
}

export async function deleteReferencedAttachmentBytes(
  attachmentId: AttachmentId,
  reason: AttachmentMissingReason = 'deleted',
  now = Date.now(),
): Promise<Attachment | undefined> {
  const commit = await runWorkspaceAction('attachment', (permit) =>
    getWorkspaceRepository().execute(permit, {
      kind: 'attachment.bytes.delete',
      input: { attachmentId, reason, now },
    }),
  )
  return commit.value
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
  const commit = await runWorkspaceAction('attachment', (permit) =>
    getWorkspaceRepository().execute(permit, {
      kind: 'attachment.delete-if-unreferenced',
      attachmentId,
    }),
  )
  return commit.value
}

export async function countLiveRefs(
  id: AttachmentId,
): Promise<{ messages: number; drafts: number }> {
  const edges = await listAttachmentReferenceEdges(id)
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
  return runWorkspaceRead('repository-query', (permit) =>
    getWorkspaceRepository()
      .query(
        permit,
        { kind: 'attachment.reference-rows', attachmentId: id },
        { signal: permit.signal },
      )
      .then((envelope) => envelope.value),
  )
}

async function listAttachmentReferenceEdges(id: AttachmentId): Promise<AttachmentReferenceEdge[]> {
  return runWorkspaceRead('repository-query', (permit) =>
    getWorkspaceRepository()
      .query(permit, { kind: 'attachment.references', attachmentId: id }, { signal: permit.signal })
      .then((envelope) => envelope.value),
  )
}

export async function putWorkspaceDraft(
  draft: DraftRow,
  expectedUpdatedAt: number | null,
): Promise<DraftRow> {
  const commit = await runWorkspaceAction('attachment', (permit) =>
    getWorkspaceRepository().execute(permit, {
      kind: 'draft.put',
      input: { draft, expectedUpdatedAt },
    }),
  )
  return commit.value
}

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

async function resolveAttachmentRefOwner(input: AttachmentRefTarget): Promise<{
  owner: AttachmentRefOwner
  refs: MessageAttachmentRef[]
}> {
  if (input.messageId) {
    const presentation = await runWorkspaceRead('repository-query', (permit) =>
      getWorkspaceRepository()
        .query(
          permit,
          { kind: 'message.presentation', messageId: input.messageId as MessageId },
          { signal: permit.signal },
        )
        .then((envelope) => envelope.value),
    )
    if (!presentation || presentation.header.deleted) {
      throw new Error(`MessageMissing:${input.messageId}`)
    }
    return {
      owner: {
        kind: 'message',
        chatId: presentation.header.chatId,
        messageId: presentation.header.id,
      },
      refs: normalizeAttachmentRefs(presentation.header.attachmentRefs, {
        messageId: presentation.header.id,
        createdAt: presentation.header.createdAt,
      }),
    }
  }
  if (input.draftChatId) {
    const draft = await runWorkspaceRead('repository-query', (permit) =>
      getWorkspaceRepository()
        .query(
          permit,
          { kind: 'draft.get', chatId: input.draftChatId as ChatId },
          { signal: permit.signal },
        )
        .then((envelope) => envelope.value),
    )
    return {
      owner: { kind: 'draft', chatId: input.draftChatId },
      refs: normalizeAttachmentRefs(draft?.attachmentRefs, {
        draftChatId: input.draftChatId,
        createdAt: draft?.updatedAt ?? 0,
      }),
    }
  }
  throw new Error('AttachmentRefTargetMissing')
}

function requireAttachmentRef(
  refs: readonly MessageAttachmentRef[],
  refId: string,
): MessageAttachmentRef {
  const ref = refs.find((candidate) => candidate.refId === refId)
  if (!ref || ref.deletedAt !== undefined) throw new Error(`AttachmentRefMissing:${refId}`)
  return ref
}
