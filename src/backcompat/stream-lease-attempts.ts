import type { Transaction } from 'dexie'
import type { Chat, ChatId, ContinuationStrategy, GenerationMeta } from '../core/types'
import type { MessageHeaderRow } from '../store/message-storage'
import type { StreamPostCommitEvidence, StreamPostCommitPlan } from '../store/repository'
import { forEachTableBatch } from './batched-table'
import { requireV67StreamLeaseRow, type V67StreamLeaseRow } from './stream-lease-schema-versions'
import { readLegacyBrowserWorkspaceMetaFromTransaction } from './workspace-meta'

interface LegacyStreamLeaseRow {
  streamId: string
  chatId: ChatId
  messageId?: string
  ownerClientId: string
  fenceToken?: string
  replacementEpoch?: number
  startedAt: number
  heartbeatAt: number
  admissionSequence?: number
  revision?: number
  attemptKind?: 'generation' | 'continuation'
  targetCommittedAt?: number
  continuationStrategy?: ContinuationStrategy
  baseNodeVersion?: number
  baseBodyVersion?: number
  requestedModel?: string
  apiUsed?: GenerationMeta['apiUsed']
  canonicalAt?: number
  postCommit?: StreamPostCommitEvidence
  metadataCommittedAt?: number
  journalStorageBytes?: number
  journalMaxSeq?: number
}

type NormalizedLegacyStreamLeaseRow = LegacyStreamLeaseRow &
  Required<
    Pick<
      LegacyStreamLeaseRow,
      | 'messageId'
      | 'fenceToken'
      | 'replacementEpoch'
      | 'admissionSequence'
      | 'revision'
      | 'attemptKind'
    >
  >

interface LegacyStreamJournalFrameRow {
  id: string
  streamId: string
  chatId: ChatId
  messageId: string
  seq: number
  createdAt: number
  event: unknown
  ownerClientId?: string
  fenceToken?: string
  replacementEpoch?: number
  admissionSequence?: number
}

type LeaseTargetHeader = Pick<
  MessageHeaderRow,
  'id' | 'chatId' | 'deleted' | 'role' | 'generation' | 'nodeVersion' | 'bodyVersion'
>

function classifyLegacyStreamLeaseAttempt(
  lease: LegacyStreamLeaseRow,
  header: LeaseTargetHeader | undefined,
): LegacyStreamLeaseRow {
  if (lease.attemptKind === 'generation' || lease.attemptKind === 'continuation') {
    return structuredClone(lease)
  }

  const next = structuredClone(lease)
  if (header?.generation && header.generation.finishedAt === undefined) {
    next.attemptKind = 'generation'
    return next
  }

  next.attemptKind = 'continuation'
  if (header && Number.isSafeInteger(header.nodeVersion) && header.nodeVersion >= 0) {
    next.baseNodeVersion = header.nodeVersion
  }
  return next
}

export async function migrateStreamLeaseAttempts(tx: Transaction): Promise<void> {
  const leases = tx.table<LegacyStreamLeaseRow, string>('streamLeases')
  const messages = tx.table<MessageHeaderRow, string>('messages')
  const replacementEpoch = (await readLegacyBrowserWorkspaceMetaFromTransaction(tx))
    .replacementEpoch
  const fencesByStreamId = new Map<string, { fenceToken: string; replacementEpoch: number }>()
  await forEachTableBatch(leases, async (rows) => {
    const messageIds = [
      ...new Set(
        rows.flatMap((lease) =>
          lease.attemptKind === undefined && lease.messageId ? [lease.messageId] : [],
        ),
      ),
    ]
    const headersById = new Map<string, MessageHeaderRow>()
    for (const header of await messages.bulkGet(messageIds)) {
      if (header) headersById.set(header.id, header)
    }
    const normalizedLeases = rows.map((lease) => {
      const classified = classifyLegacyStreamLeaseAttempt(
        lease,
        lease.messageId ? headersById.get(lease.messageId) : undefined,
      )
      return {
        ...classified,
        fenceToken:
          typeof classified.fenceToken === 'string'
            ? classified.fenceToken
            : `legacy:${classified.streamId}`,
        replacementEpoch: nonNegativeSafeInteger(classified.replacementEpoch) ?? replacementEpoch,
      }
    })
    if (normalizedLeases.length > 0) await leases.bulkPut(normalizedLeases)
    for (const lease of normalizedLeases) {
      fencesByStreamId.set(lease.streamId, {
        fenceToken: lease.fenceToken,
        replacementEpoch: lease.replacementEpoch,
      })
    }
  })
  await tx
    .table<LegacyStreamJournalFrameRow, string>('streamChunks')
    .toCollection()
    .modify((chunk) => {
      const leaseFence = fencesByStreamId.get(chunk.streamId)
      chunk.fenceToken =
        typeof chunk.fenceToken === 'string'
          ? chunk.fenceToken
          : (leaseFence?.fenceToken ?? `legacy:${chunk.streamId}`)
      chunk.replacementEpoch =
        nonNegativeSafeInteger(chunk.replacementEpoch) ??
        leaseFence?.replacementEpoch ??
        replacementEpoch
    })
}

export async function migrateStreamLeaseLifecycleState(tx: Transaction): Promise<void> {
  const legacyLeases = tx.table<NormalizedLegacyStreamLeaseRow, string>('streamLeases')
  const currentLeases = tx.table<V67StreamLeaseRow, string>('streamLeases')
  const chunks = tx.table<LegacyStreamJournalFrameRow, string>('streamChunks')
  const chats = tx.table<Chat, ChatId>('chats')
  const messages = tx.table<MessageHeaderRow, string>('messages')

  await forEachTableBatch(legacyLeases, async (rows) => {
    const chatIds = [
      ...new Set(rows.flatMap((lease) => (nonEmptyString(lease.chatId) ? [lease.chatId] : []))),
    ]
    const messageIds = [
      ...new Set(
        rows.flatMap((lease) => (nonEmptyString(lease.messageId) ? [lease.messageId] : [])),
      ),
    ]
    const [loadedChats, loadedHeaders] = await Promise.all([
      chats.bulkGet(chatIds),
      messages.bulkGet(messageIds),
    ])
    const chatById = new Map(
      loadedChats.flatMap((chat) => (chat ? [[chat.id, chat] as const] : [])),
    )
    const headerById = new Map(
      loadedHeaders.flatMap((header) => (header ? [[header.id, header] as const] : [])),
    )
    const migrated: V67StreamLeaseRow[] = []
    const invalidStreamIds: string[] = []
    for (const legacy of rows) {
      const chat = chatById.get(legacy.chatId)
      const header = headerById.get(legacy.messageId)
      if (
        !nonEmptyString(legacy.streamId) ||
        !nonEmptyString(legacy.chatId) ||
        !nonEmptyString(legacy.messageId) ||
        !chat ||
        !header ||
        header.deleted ||
        header.role !== 'assistant' ||
        header.chatId !== legacy.chatId
      ) {
        invalidStreamIds.push(legacy.streamId)
        continue
      }
      try {
        migrated.push(migrateLegacyStreamLeaseLifecycle(legacy, chat, header))
      } catch {
        invalidStreamIds.push(legacy.streamId)
      }
    }
    if (migrated.length > 0) await currentLeases.bulkPut(migrated)
    if (invalidStreamIds.length > 0) {
      await chunks.where('streamId').anyOf(invalidStreamIds).delete()
      await legacyLeases.bulkDelete(invalidStreamIds)
    }
  })
}

function migrateLegacyStreamLeaseLifecycle(
  legacy: NormalizedLegacyStreamLeaseRow,
  chat: Chat,
  header: MessageHeaderRow,
): V67StreamLeaseRow {
  const postCommit = legacyPostCommitPlan(legacy)
  const canonicalAt = nonNegativeSafeInteger(legacy.canonicalAt)
  const metadataCommittedAt = nonNegativeSafeInteger(legacy.metadataCommittedAt)
  const targetCommittedAt = nonNegativeSafeInteger(legacy.targetCommittedAt)
  const journalStorageBytes = nonNegativeSafeInteger(legacy.journalStorageBytes)
  const journalMaxSeq = nonNegativeSafeInteger(legacy.journalMaxSeq)
  if (
    !nonEmptyString(legacy.streamId) ||
    !nonEmptyString(legacy.chatId) ||
    !nonEmptyString(legacy.messageId) ||
    !nonEmptyString(legacy.ownerClientId) ||
    !nonEmptyString(legacy.fenceToken) ||
    nonNegativeSafeInteger(legacy.replacementEpoch) === undefined ||
    nonNegativeSafeInteger(legacy.startedAt) === undefined ||
    nonNegativeSafeInteger(legacy.heartbeatAt) === undefined ||
    nonNegativeSafeInteger(legacy.admissionSequence) === undefined ||
    nonNegativeSafeInteger(legacy.revision) === undefined ||
    (legacy.targetCommittedAt !== undefined && targetCommittedAt === undefined) ||
    (legacy.canonicalAt !== undefined && canonicalAt === undefined) ||
    (legacy.metadataCommittedAt !== undefined && metadataCommittedAt === undefined) ||
    (legacy.journalStorageBytes !== undefined && journalStorageBytes === undefined) ||
    (legacy.journalMaxSeq !== undefined && journalMaxSeq === undefined) ||
    (metadataCommittedAt !== undefined && canonicalAt === undefined) ||
    (legacy.postCommit?.final !== undefined && canonicalAt === undefined)
  ) {
    throw new Error('LegacyStreamLeaseLifecycleInvalid')
  }
  if (
    legacy.attemptKind === 'generation' &&
    canonicalAt === undefined &&
    targetCommittedAt !== undefined &&
    nonNegativeSafeInteger(header.generation?.finishedAt) !== undefined
  ) {
    throw new Error('LegacyStreamLeaseFinishedGenerationStillActive')
  }
  const continuationStrategy = legacy.continuationStrategy
  const baseNodeVersion = nonNegativeSafeInteger(legacy.baseNodeVersion)
  const baseBodyVersion = nonNegativeSafeInteger(legacy.baseBodyVersion)
  if (
    targetCommittedAt !== undefined &&
    legacy.attemptKind === 'continuation' &&
    ((continuationStrategy !== 'prompt' && continuationStrategy !== 'prefill') ||
      baseNodeVersion === undefined ||
      baseBodyVersion === undefined)
  ) {
    throw new Error('LegacyContinuationDispatchEvidenceInvalid')
  }
  const dispatch =
    targetCommittedAt === undefined
      ? null
      : legacy.attemptKind === 'generation'
        ? {
            targetCommittedAt,
            requestedModel:
              legacy.requestedModel ??
              header.generation?.requestedModel ??
              header.generation?.model ??
              chat.settings.model,
            apiUsed: legacy.apiUsed ?? header.generation?.apiUsed ?? 'chat',
          }
        : {
            targetCommittedAt,
            requestedModel: legacy.requestedModel ?? chat.settings.model,
            apiUsed: legacy.apiUsed ?? 'chat',
            continuationStrategy,
            baseNodeVersion,
            baseBodyVersion,
          }
  const custody = legacy.ownerClientId.startsWith('recovery:') ? 'recovery' : 'writer'
  const common = {
    streamId: legacy.streamId,
    chatId: legacy.chatId,
    messageId: legacy.messageId,
    custody,
    ownerClientId: legacy.ownerClientId,
    fenceToken: legacy.fenceToken,
    replacementEpoch: legacy.replacementEpoch,
    startedAt: legacy.startedAt,
    heartbeatAt: legacy.heartbeatAt,
    admissionSequence: legacy.admissionSequence,
    revision: legacy.revision,
    attemptKind: legacy.attemptKind,
    ...(journalStorageBytes === undefined ? {} : { journalStorageBytes }),
    ...(journalMaxSeq === undefined ? {} : { journalMaxSeq }),
  }
  if (canonicalAt !== undefined) {
    const final = legacy.postCommit?.final ?? {
      completionAllowed: false,
      expectedNodeVersion: header.nodeVersion,
      expectedBodyVersion: header.bodyVersion,
    }
    return requireV67StreamLeaseRow({
      ...common,
      phase: metadataCommittedAt === undefined ? 'canonical' : 'metadata-committed',
      ...(metadataCommittedAt === undefined ? { targetOwnerKey: legacy.messageId } : {}),
      ...(metadataCommittedAt === undefined ? {} : { terminalRetentionAt: canonicalAt }),
      dispatch,
      canonicalAt,
      ...(metadataCommittedAt === undefined ? {} : { metadataCommittedAt }),
      postCommit: { ...postCommit, final },
    })
  }
  if (dispatch !== null) {
    return requireV67StreamLeaseRow({
      ...common,
      phase: 'active',
      targetOwnerKey: legacy.messageId,
      dispatch,
      postCommit,
    })
  }
  return requireV67StreamLeaseRow({
    ...common,
    phase: 'reserved',
    targetOwnerKey: legacy.messageId,
    postCommit,
  })
}

function legacyPostCommitPlan(legacy: NormalizedLegacyStreamLeaseRow): StreamPostCommitPlan {
  const evidence = legacy.postCommit
  const usedAt = nonNegativeSafeInteger(evidence?.usedAt)
  if (!evidence || usedAt === undefined || !nonEmptyString(evidence.profileId)) {
    throw new Error('LegacyStreamLeasePostCommitInvalid')
  }
  return {
    usedAt,
    profileId: evidence.profileId,
    ...(evidence.presetId ? { presetId: evidence.presetId } : {}),
    ...(evidence.recentModelId ? { recentModelId: evidence.recentModelId } : {}),
    ...(evidence.selectedKeyId ? { selectedKeyId: evidence.selectedKeyId } : {}),
    ...(evidence.calibration ? { calibration: structuredClone(evidence.calibration) } : {}),
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function nonNegativeSafeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : undefined
}
