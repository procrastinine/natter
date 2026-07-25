import type { IndexableType, Table, Transaction } from 'dexie'
import type { Chat, ConnectionProfile, GenerationMeta, MessageId } from '../core/types'
import { seedRecoveryPendingStreamLease } from '../store/attempt-availability'
import {
  type BoundedIdbCursorEntry,
  type BoundedIdbCursorReader,
  createBoundedBatchWriter,
  forEachBoundedIdbCursorPage,
  forEachBoundedIdbCursorReaderPage,
  openBoundedIdbCursorReader,
} from '../store/bounded-idb-cursor'
import type { SettingsRow } from '../store/db-rows'
import {
  exactCompoundPrefixKeyRange,
  scalarCompoundIndexKeyRange,
} from '../store/indexeddb-key-ranges'
import type { MessageBodyRow, MessageHeaderRow } from '../store/message-storage'
import {
  CURRENT_STREAM_JOURNAL_EVENT_VERSION,
  type PersistedStreamEventV2,
  persistedStreamEventV2FromUnknown,
} from '../store/persisted-stream-event'
import { requireStreamLeaseRow, type StreamLeaseRow } from '../store/repository'
import { estimateStoredValueBytes } from '../store/storage-size-estimate'
import {
  type CanonicalStreamJournalFrameRow,
  createStreamJournalFrameCursor,
  estimateStreamJournalV83FrameStorageBytes,
  isStreamJournalFrameRow,
  requireCanonicalStreamJournalFrame,
  type StreamJournalFrameCursor,
  StreamJournalFrameDecoder,
  streamJournalFrameId,
  streamJournalStableIdentity,
} from '../store/stream-journal-codec'
import { completedStreamJournalIntegritySetting } from '../store/stream-journal-integrity'
import { BROWSER_WORKSPACE_FENCE_ID, type BrowserWorkspaceFenceRow } from '../store/workspace-meta'
import type { CanonicalStreamEventV1 } from './generation-stream-events-v1'
import { persistedStreamEventV1FromUnknown } from './persisted-stream-event-v1'
import {
  normalizeReasoningCarryForwardV92,
  normalizeReasoningVisibilityV92,
  type ReasoningAttemptV92Context,
} from './reasoning-contract-normalizer-v92'
import { upgradeCanonicalStreamEventV1ToV2 } from './reasoning-journal-persistence-v93'
import { streamJournalFramesBackfillMarker } from './stream-journal-frames'
import {
  convertV88JournalEvent,
  createV88JournalEventConverter,
  type V88JournalEventConverter,
  type V89ProfileIdentity,
  v88JournalIntegrityEvent,
} from './stream-journal-semantics-v89'
import {
  requireV67StreamLeaseRow,
  requireV88StreamLeaseRow,
  requireV89StreamLeaseRow,
  requireV90StreamLeaseRow,
  requireV91StreamLeaseRow,
  requireV92StreamLeaseRow,
  type V88StreamLeaseRow,
} from './stream-lease-schema-versions'
import type { WaveAStorageEpochMigrationCapabilitiesV94 } from './wave-a-storage-capabilities-v94'

export type WaveAExplicitJournalSemanticsV94 =
  | 'legacy-unversioned'
  | 'persisted-v1'
  | 'persisted-v2'

export type DecodedExplicitWaveALeaseV94 =
  | Readonly<{
      kind: 'nonterminal'
      lease: StreamLeaseRow
      structuralV88: V88StreamLeaseRow
      journalSemantics: WaveAExplicitJournalSemanticsV94
    }>
  | Readonly<{
      kind: 'terminal'
      candidate: StreamLeaseRow
      structuralV88: V88StreamLeaseRow
      journalSemantics: WaveAExplicitJournalSemanticsV94
    }>

export interface DecodeExplicitWaveALeaseInputV94 {
  readonly value: unknown
  readonly replacementEpoch: number
  readonly observedAt: number
}

interface DecodedExplicitWaveALeaseSourceV94 {
  readonly raw: Record<string, unknown>
  readonly structuralV88: V88StreamLeaseRow
  readonly journalSemantics: WaveAExplicitJournalSemanticsV94
}

export function decodeExplicitWaveALeaseV94(
  input: DecodeExplicitWaveALeaseInputV94,
): DecodedExplicitWaveALeaseV94 | undefined {
  const decoded = decodeExplicitWaveALeaseSourceV94(input.value)
  if (!decoded) return undefined
  const candidate = currentExplicitLeaseCandidateV94(decoded.raw)
  if (candidate.phase === 'reserved' || candidate.phase === 'active') {
    return Object.freeze({
      kind: 'nonterminal',
      lease: seedRecoveryPendingStreamLease({
        lease: candidate,
        replacementEpoch: input.replacementEpoch,
        handedOffAt: input.observedAt,
      }),
      structuralV88: decoded.structuralV88,
      journalSemantics: decoded.journalSemantics,
    })
  }
  return Object.freeze({
    kind: 'terminal',
    candidate,
    structuralV88: decoded.structuralV88,
    journalSemantics: decoded.journalSemantics,
  })
}

export function normalizeWaveAStoredStreamEventV94(
  value: unknown,
  createdAt: number,
  converter: V88JournalEventConverter,
  context: ReasoningAttemptV92Context,
): PersistedStreamEventV2 {
  const current = persistedStreamEventV2FromUnknown(value)
  if (current) return current
  const event =
    persistedStreamEventV1FromUnknown(value)?.event ??
    convertV88JournalEvent(value, createdAt, converter)
  return persistUpgradedEventV94(event, context)
}

export function waveAStreamIntegrityEventV94(
  converter: V88JournalEventConverter,
  streamId: string,
  context: ReasoningAttemptV92Context,
): PersistedStreamEventV2 {
  return persistUpgradedEventV94(v88JournalIntegrityEvent(converter, streamId), context)
}

export function createWaveAJournalEventConverterV94(
  lease: V88StreamLeaseRow,
  profile: V89ProfileIdentity | undefined,
): V88JournalEventConverter {
  return createV88JournalEventConverter(lease, profile)
}

export type WaveAStreamStorageMigrationCapabilitiesV94 = Pick<
  WaveAStorageEpochMigrationCapabilitiesV94,
  'observedAt' | 'recordObsoleteBytes' | 'reportProgress'
>

export interface WaveAStreamStorageMigrationResultV94 {
  readonly delayedMarkers: readonly SettingsRow[]
}

interface NormalizedLeaseV94 {
  readonly lease: StreamLeaseRow
  readonly journalSemantics: WaveAExplicitJournalSemanticsV94
  readonly priorityKind: 'explicit' | 'orphan'
  readonly priorityHeartbeatAt: number
}

interface LeaseReconciliationStageV94 {
  readonly groupKey: string
  readonly targetOwnerKey?: string
  readonly journalSemantics: WaveAExplicitJournalSemanticsV94
  readonly priorityKind: 'explicit' | 'orphan'
  readonly priorityHeartbeatAt: number
}

interface StagedLeaseV94 {
  readonly stored: StoredRecord
  readonly lease: StreamLeaseRow
  readonly stage: LeaseReconciliationStageV94
  readonly primaryKey: IDBValidKey
}

interface MigratedJournalV94 {
  readonly journalMaxSeq: number
  readonly journalStorageBytes: number
}

type StoredRecord = Record<string, unknown>

const WAVE_A_STREAM_PAGE_MAX_ROWS_V94 = 128
const WAVE_A_STREAM_PAGE_MAX_BYTES_V94 = 4 * 1024 * 1024
const STREAM_ADMISSION_SEQUENCE_KEY_V94 = 'stream-admission-sequence'
const LEASE_RECONCILIATION_STAGE_FIELD_V94 = '__waveAStreamLeaseV94'
const LEASE_RECONCILIATION_STAGE_TAG_V94 = 'backcompat:v94:lease-target'

export async function migrateWaveAOperationalStreamRowsV94(
  tx: Transaction,
  capabilities: WaveAStreamStorageMigrationCapabilitiesV94,
): Promise<WaveAStreamStorageMigrationResultV94> {
  const settings = tx.table<SettingsRow, string>('settings')
  const leases = tx.table<StoredRecord, string>('streamLeases')
  const delayedMarkers = [
    streamJournalFramesBackfillMarker(),
    completedStreamJournalIntegritySetting(),
  ]
  const staleMarkers = await settings.bulkGet(delayedMarkers.map((row) => row.key))
  for (const marker of staleMarkers) {
    if (marker) capabilities.recordObsoleteBytes(estimateStoredValueBytes(marker))
  }
  await settings.bulkDelete(delayedMarkers.map((row) => row.key))

  const fence = await requireWaveAWorkspaceFenceV94(tx)
  const sequenceRow = await settings.get(STREAM_ADMISSION_SEQUENCE_KEY_V94)
  let admissionSequence = nonNegativeIntegerV94(sequenceRow?.value) ?? 0
  await forEachBoundedIdbCursorPage<StoredRecord>(
    tx.idbtrans.objectStore('streamLeases'),
    boundedStreamCursorOptionsV94('LeaseSequenceCensus', capabilities),
    (page) => {
      for (const entry of page.entries) {
        admissionSequence = Math.max(
          admissionSequence,
          nonNegativeIntegerV94(entry.value.admissionSequence) ?? 0,
        )
      }
      return Promise.resolve()
    },
  )
  await forEachBoundedIdbCursorPage<StoredRecord>(
    tx.idbtrans.objectStore('streamLeases'),
    boundedStreamCursorOptionsV94('LeaseNormalization', capabilities),
    async (page) => {
      const messageIds = uniqueStringsV94(
        page.entries.map((entry) => nonEmptyStringV94(entry.value.messageId)),
      )
      const headerRows = await tx.table<MessageHeaderRow, MessageId>('messages').bulkGet(messageIds)
      const headers = definedByIdV94(headerRows)
      const chatIds = uniqueStringsV94(headerRows.map((header) => header?.chatId))
      const chatRows = await tx.table<Chat, string>('chats').bulkGet(chatIds)
      const chats = definedByIdV94(chatRows)
      const staged: StoredRecord[] = []
      for (const entry of page.entries) {
        const streamId = nonEmptyStringV94(entry.value.streamId)
        if (!streamId) {
          await retireStoredLeaseV94(tx, entry.value, capabilities, entry.primaryKey)
          continue
        }
        const stored = entry.value
        const messageId = nonEmptyStringV94(stored.messageId)
        const header = messageId ? headers.get(messageId) : undefined
        const chat = header ? chats.get(header.chatId) : undefined
        if (!exactLeaseTargetV94(stored, header, chat)) {
          await retireStoredLeaseV94(tx, stored, capabilities, entry.primaryKey)
          continue
        }
        let prepared = stored
        if (nonNegativeIntegerV94(stored.admissionSequence) === undefined) {
          admissionSequence = nextAdmissionSequenceV94(admissionSequence)
          prepared = { ...stored, admissionSequence }
        }
        const normalized = normalizeStoredLeaseV94({
          stored: prepared,
          header: header as MessageHeaderRow,
          chat: chat as Chat,
          replacementEpoch: fence.replacementEpoch,
          observedAt: capabilities.observedAt,
        })
        if (!normalized) {
          await retireStoredLeaseV94(tx, stored, capabilities, entry.primaryKey)
          continue
        }
        if (
          !(await exactNormalizedLeaseTargetV94(tx, normalized.lease, header as MessageHeaderRow))
        ) {
          await retireStoredLeaseV94(tx, stored, capabilities, entry.primaryKey)
          continue
        }
        admissionSequence = Math.max(admissionSequence, normalized.lease.admissionSequence)
        staged.push(stageNormalizedLeaseV94(normalized))
        capabilities.recordObsoleteBytes(estimateStoredValueBytes(stored))
      }
      if (staged.length > 0) await leases.bulkPut(staged)
    },
  )

  admissionSequence = await recoverOrphanStreamJournalsV94(
    tx,
    fence,
    admissionSequence,
    capabilities,
  )

  await reconcileStagedStreamLeasesV94(tx, capabilities)

  await removeOrphanStreamJournalsV94(tx, capabilities)
  await terminalizeStrandedGenerationHeadersV94(tx, capabilities)
  if (!sequenceRow || sequenceRow.value !== admissionSequence) {
    if (sequenceRow) capabilities.recordObsoleteBytes(estimateStoredValueBytes(sequenceRow))
    await settings.put({ key: STREAM_ADMISSION_SEQUENCE_KEY_V94, value: admissionSequence })
  }
  return { delayedMarkers }
}

function stageNormalizedLeaseV94(normalized: NormalizedLeaseV94): StoredRecord {
  const targetOwnerKey =
    normalized.lease.phase === 'reserved' ||
    normalized.lease.phase === 'active' ||
    normalized.lease.phase === 'terminal-decided'
      ? normalized.lease.messageId
      : undefined
  const groupKey = targetOwnerKey
    ? `target:${JSON.stringify(targetOwnerKey)}`
    : `terminal:${JSON.stringify(normalized.lease.streamId)}`
  return {
    ...normalized.lease,
    targetOwnerKey: [LEASE_RECONCILIATION_STAGE_TAG_V94, groupKey, normalized.lease.streamId],
    [LEASE_RECONCILIATION_STAGE_FIELD_V94]: {
      groupKey,
      ...(targetOwnerKey ? { targetOwnerKey } : {}),
      journalSemantics: normalized.journalSemantics,
      priorityKind: normalized.priorityKind,
      priorityHeartbeatAt: normalized.priorityHeartbeatAt,
    } satisfies LeaseReconciliationStageV94,
  }
}

async function reconcileStagedStreamLeasesV94(
  tx: Transaction,
  capabilities: WaveAStreamStorageMigrationCapabilitiesV94,
): Promise<void> {
  const pending: StagedLeaseV94[] = []
  let winner: StagedLeaseV94 | undefined
  const flush = async (): Promise<void> => {
    if (pending.length === 0) return
    await finalizeStagedStreamLeasesV94(tx, pending.splice(0), capabilities)
  }
  const enqueue = async (next: StagedLeaseV94): Promise<void> => {
    pending.push(next)
    if (pending.length >= WAVE_A_STREAM_PAGE_MAX_ROWS_V94) await flush()
  }
  await forEachBoundedIdbCursorPage<StoredRecord>(
    tx.idbtrans.objectStore('streamLeases').index('targetOwnerKey'),
    {
      ...boundedStreamCursorOptionsV94('LeaseTargetReconciliation', capabilities),
      query: exactCompoundPrefixKeyRange([LEASE_RECONCILIATION_STAGE_TAG_V94]),
    },
    async (page) => {
      for (const entry of page.entries) {
        const candidate = stagedLeaseFromStoredV94(entry.value, entry.primaryKey)
        if (!candidate) {
          await retireStoredLeaseV94(tx, entry.value, capabilities, entry.primaryKey)
          continue
        }
        if (!winner || winner.stage.groupKey !== candidate.stage.groupKey) {
          if (winner) await enqueue(winner)
          winner = candidate
          continue
        }
        if (
          compareLeasePriorityV94(candidate.lease, candidate.stage, winner.lease, winner.stage) > 0
        ) {
          await retireStoredLeaseV94(tx, winner.stored, capabilities, winner.primaryKey)
          winner = candidate
        } else {
          await retireStoredLeaseV94(tx, candidate.stored, capabilities, candidate.primaryKey)
        }
      }
    },
  )
  if (winner) await enqueue(winner)
  await flush()
}

function stagedLeaseFromStoredV94(
  stored: StoredRecord,
  primaryKey: IDBValidKey,
): StagedLeaseV94 | undefined {
  const rawStage = record(stored[LEASE_RECONCILIATION_STAGE_FIELD_V94])
  const groupKey = nonEmptyStringV94(rawStage?.groupKey)
  const targetOwnerKey = nonEmptyStringV94(rawStage?.targetOwnerKey)
  const journalSemantics = journalSemanticsV94(rawStage?.journalSemantics)
  const priorityKind =
    rawStage?.priorityKind === 'explicit' || rawStage?.priorityKind === 'orphan'
      ? rawStage.priorityKind
      : undefined
  const priorityHeartbeatAt = nonNegativeIntegerV94(rawStage?.priorityHeartbeatAt)
  if (!groupKey || !journalSemantics || !priorityKind || priorityHeartbeatAt === undefined) {
    return undefined
  }
  const {
    [LEASE_RECONCILIATION_STAGE_FIELD_V94]: _stage,
    targetOwnerKey: _temporaryTargetOwnerKey,
    ...withoutStage
  } = stored
  const lease = valid(() =>
    requireStreamLeaseRow({
      ...withoutStage,
      ...(targetOwnerKey ? { targetOwnerKey } : {}),
    }),
  )
  if (!lease) return undefined
  const expectedGroupKey = targetOwnerKey
    ? `target:${JSON.stringify(targetOwnerKey)}`
    : `terminal:${JSON.stringify(lease.streamId)}`
  if (
    groupKey !== expectedGroupKey ||
    (targetOwnerKey !== undefined && targetOwnerKey !== lease.messageId) ||
    indexedDB.cmp(primaryKey, lease.streamId) !== 0
  ) {
    return undefined
  }
  return {
    stored,
    lease,
    stage: {
      groupKey,
      ...(targetOwnerKey ? { targetOwnerKey } : {}),
      journalSemantics,
      priorityKind,
      priorityHeartbeatAt,
    },
    primaryKey,
  }
}

async function finalizeStagedStreamLeasesV94(
  tx: Transaction,
  winners: readonly StagedLeaseV94[],
  capabilities: WaveAStreamStorageMigrationCapabilitiesV94,
): Promise<void> {
  const profileIds = uniqueStringsV94(
    winners.map(({ lease }) =>
      lease.phase === 'canonical' || lease.phase === 'metadata-committed'
        ? undefined
        : lease.postCommit.profileId,
    ),
  )
  const profileRows = await tx.table<ConnectionProfile, string>('profiles').bulkGet(profileIds)
  const profiles = definedByIdV94(profileRows)
  const leases = tx.table<StreamLeaseRow, string>('streamLeases')
  for (const winner of winners) {
    const lease = winner.lease
    let next: StreamLeaseRow
    if (lease.phase === 'canonical' || lease.phase === 'metadata-committed') {
      await deleteStreamFramesV94(tx, lease.streamId, capabilities)
      next = leaseWithoutJournalProjectionV94(lease)
    } else {
      const profile = profiles.get(lease.postCommit.profileId)
      const structuralV88 = structuralV88FromVersionedV94(lease as unknown as StoredRecord)
      const converter = createWaveAJournalEventConverterV94(structuralV88, profile)
      const journal = await migrateStreamJournalV94(
        tx,
        lease,
        winner.stage.journalSemantics,
        converter,
        profile,
        capabilities,
      )
      next = leaseWithJournalProjectionV94(lease, journal)
    }
    await leases.put(next)
  }
}

async function exactNormalizedLeaseTargetV94(
  tx: Transaction,
  lease: StreamLeaseRow,
  header: MessageHeaderRow,
): Promise<boolean> {
  if (lease.attemptKind === 'generation') {
    const finished = header.generation?.finishedAt !== undefined
    return lease.phase === 'canonical' || lease.phase === 'metadata-committed'
      ? finished
      : header.generation !== undefined && !finished
  }
  if (lease.phase !== 'canonical' && lease.phase !== 'metadata-committed') return true
  const body = await tx.table<MessageBodyRow, MessageId>('messageBodies').get(header.id)
  return Boolean(
    body &&
      body.chatId === header.chatId &&
      body.bodyVersion === header.bodyVersion &&
      body.continuationAttempts?.some((attempt) => attempt.streamId === lease.streamId),
  )
}

interface OrphanJournalCandidateV94 {
  readonly streamId: string
  readonly chatId: string
  readonly messageId: MessageId
  readonly startedAt: number
  readonly recencyAt: number
}

interface OrphanJournalInspectionV94 {
  readonly streamId: string
  chatId?: string
  messageId?: MessageId
  startedAt?: number
  recencyAt?: number
  validIdentity: boolean
  rows: number
}

async function recoverOrphanStreamJournalsV94(
  tx: Transaction,
  fence: BrowserWorkspaceFenceRow,
  initialAdmissionSequence: number,
  capabilities: WaveAStreamStorageMigrationCapabilitiesV94,
): Promise<number> {
  const leases = tx.table<StoredRecord, string>('streamLeases')
  let admissionSequence = initialAdmissionSequence
  const pending: OrphanJournalInspectionV94[] = []
  let current: OrphanJournalInspectionV94 | undefined
  const flush = async (): Promise<void> => {
    if (pending.length === 0) return
    const inspections = pending.splice(0)
    const retained = await leases.bulkGet(inspections.map(({ streamId }) => streamId))
    const candidates = inspections.map((inspection, index) =>
      retained[index] ? undefined : orphanJournalCandidateV94(inspection),
    )
    const messageIds = uniqueStringsV94(candidates.map((candidate) => candidate?.messageId))
    const headerRows = await tx.table<MessageHeaderRow, MessageId>('messages').bulkGet(messageIds)
    const headers = definedByIdV94(headerRows)
    const chatIds = uniqueStringsV94(headerRows.map((header) => header?.chatId))
    const chatRows = await tx.table<Chat, string>('chats').bulkGet(chatIds)
    const chats = definedByIdV94(chatRows)
    const staged: StoredRecord[] = []
    for (let index = 0; index < inspections.length; index += 1) {
      if (retained[index]) continue
      const inspection = inspections[index]
      const candidate = candidates[index]
      if (!inspection || !candidate) {
        if (inspection) await deleteStreamFramesV94(tx, inspection.streamId, capabilities)
        continue
      }
      const header = headers.get(candidate.messageId)
      const chat = header ? chats.get(header.chatId) : undefined
      if (
        !header ||
        !chat ||
        header.deleted ||
        header.role !== 'assistant' ||
        header.chatId !== candidate.chatId ||
        header.generation === undefined ||
        header.generation.finishedAt !== undefined
      ) {
        await deleteStreamFramesV94(tx, candidate.streamId, capabilities)
        continue
      }
      const nextAdmissionSequence = nextAdmissionSequenceV94(admissionSequence)
      const generation = header.generation
      const prepared = requireStreamLeaseRow({
        streamId: candidate.streamId,
        chatId: candidate.chatId,
        messageId: candidate.messageId,
        targetOwnerKey: candidate.messageId,
        custody: 'writer',
        ownerClientId: 'backcompat:v94',
        fenceToken: `backcompat:v94:${candidate.streamId}`,
        replacementEpoch: fence.replacementEpoch,
        startedAt: candidate.startedAt,
        heartbeatAt: candidate.recencyAt,
        admissionSequence: nextAdmissionSequence,
        revision: 0,
        controlRevision: 0,
        journalEventVersion: CURRENT_STREAM_JOURNAL_EVENT_VERSION,
        attemptKind: 'generation',
        phase: 'active',
        postCommit: {
          usedAt: candidate.startedAt,
          profileId: chat.settings.profileId,
        },
        dispatch: {
          targetCommittedAt: candidate.startedAt,
          requestedModel: generation.requestedModel ?? generation.model ?? chat.settings.model,
          apiUsed: generation.apiUsed ?? 'chat',
          reasoningCarryForward: normalizeReasoningCarryForwardV92(
            generation.reasoningCarryForward,
          ),
          reasoningVisibility: normalizeReasoningVisibilityV92(generation.reasoningVisibility),
        },
      })
      const recovered = seedRecoveryPendingStreamLease({
        lease: prepared,
        replacementEpoch: fence.replacementEpoch,
        handedOffAt: capabilities.observedAt,
      })
      staged.push(
        stageNormalizedLeaseV94({
          lease: recovered,
          journalSemantics: 'legacy-unversioned',
          priorityKind: 'orphan',
          priorityHeartbeatAt: candidate.recencyAt,
        }),
      )
      admissionSequence = nextAdmissionSequence
    }
    if (staged.length > 0) await leases.bulkAdd(staged)
  }
  const enqueue = async (inspection: OrphanJournalInspectionV94): Promise<void> => {
    pending.push(inspection)
    if (pending.length >= WAVE_A_STREAM_PAGE_MAX_ROWS_V94) await flush()
  }
  await forEachBoundedIdbCursorPage<StoredRecord>(
    streamFrameIndexV94(tx),
    boundedStreamCursorOptionsV94('RecoverOrphanJournals', capabilities),
    async (page) => {
      for (const entry of page.entries) {
        const streamId = nonEmptyStringV94(entry.key)
        if (!streamId) continue
        if (!current || current.streamId !== streamId) {
          if (current) await enqueue(current)
          current = {
            streamId,
            validIdentity: true,
            rows: 0,
          }
        }
        addOrphanJournalEntryV94(current, entry.value)
      }
    },
  )
  if (current) await enqueue(current)
  await flush()
  return admissionSequence
}

function addOrphanJournalEntryV94(inspection: OrphanJournalInspectionV94, row: StoredRecord): void {
  inspection.rows += 1
  const chatId = nonEmptyStringV94(row.chatId)
  const messageId = nonEmptyStringV94(row.messageId)
  const createdAt = nonNegativeIntegerV94(row.createdAt)
  if (
    !chatId ||
    !messageId ||
    createdAt === undefined ||
    (inspection.chatId !== undefined && inspection.chatId !== chatId) ||
    (inspection.messageId !== undefined && inspection.messageId !== messageId)
  ) {
    inspection.validIdentity = false
    return
  }
  inspection.chatId = chatId
  inspection.messageId = messageId
  inspection.startedAt =
    inspection.startedAt === undefined ? createdAt : Math.min(inspection.startedAt, createdAt)
  inspection.recencyAt =
    inspection.recencyAt === undefined ? createdAt : Math.max(inspection.recencyAt, createdAt)
}

function orphanJournalCandidateV94(
  inspection: OrphanJournalInspectionV94,
): OrphanJournalCandidateV94 | undefined {
  return inspection.validIdentity &&
    inspection.rows > 0 &&
    inspection.chatId &&
    inspection.messageId &&
    inspection.startedAt !== undefined &&
    inspection.recencyAt !== undefined
    ? {
        streamId: inspection.streamId,
        chatId: inspection.chatId,
        messageId: inspection.messageId,
        startedAt: inspection.startedAt,
        recencyAt: inspection.recencyAt,
      }
    : undefined
}

async function terminalizeStrandedGenerationHeadersV94(
  tx: Transaction,
  capabilities: WaveAStreamStorageMigrationCapabilitiesV94,
): Promise<void> {
  const headers = tx.table<MessageHeaderRow, MessageId>('messages')
  const writer = createBoundedBatchWriter<MessageHeaderRow>({
    maxRows: WAVE_A_STREAM_PAGE_MAX_ROWS_V94,
    maxBytes: WAVE_A_STREAM_PAGE_MAX_BYTES_V94,
    operation: 'WaveAStreamTerminalizeStrandedHeaders',
    write: (rows) => headers.bulkPut([...rows]).then(() => undefined),
  })
  const headerReader = openBoundedIdbCursorReader<MessageHeaderRow>(
    tx.idbtrans.objectStore('messages').openCursor(),
    'WaveAStreamStrandedHeaders:messages',
  )
  const leaseReader = openBoundedIdbCursorReader<StreamLeaseRow>(
    tx.idbtrans.objectStore('streamLeases').index('targetOwnerKey').openCursor(),
    'WaveAStreamStrandedHeaders:leases',
  )
  let headerEntry = await headerReader.next()
  let leaseEntry = await leaseReader.next()
  while (headerEntry) {
    while (leaseEntry && indexedDB.cmp(leaseEntry.key, headerEntry.primaryKey) < 0) {
      leaseEntry = await leaseReader.next()
    }
    const matchingLease =
      leaseEntry && indexedDB.cmp(leaseEntry.key, headerEntry.primaryKey) === 0
        ? requireStreamLeaseRow(leaseEntry.value)
        : undefined
    const header = headerEntry.value
    if (
      !header.deleted &&
      header.role === 'assistant' &&
      header.generation !== undefined &&
      header.generation.finishedAt === undefined &&
      !(
        matchingLease?.attemptKind === 'generation' &&
        (matchingLease.phase === 'reserved' ||
          matchingLease.phase === 'active' ||
          matchingLease.phase === 'terminal-decided')
      )
    ) {
      const startedAt = nonNegativeIntegerV94(header.generation.startedAt) ?? 0
      await writer.add({
        ...header,
        generation: {
          ...header.generation,
          status: 'interrupted',
          abortReason: 'tab-close',
          integrity: header.generation.integrity ?? 'clean',
          finishedAt: Math.max(startedAt, capabilities.observedAt),
        },
      })
      capabilities.recordObsoleteBytes(headerEntry.estimatedBytes)
    }
    headerEntry = await headerReader.next()
  }
  await writer.flush()
}

async function requireWaveAWorkspaceFenceV94(tx: Transaction): Promise<BrowserWorkspaceFenceRow> {
  const fence = await tx
    .table<BrowserWorkspaceFenceRow, string>('workspaceFence')
    .get(BROWSER_WORKSPACE_FENCE_ID)
  if (
    !fence ||
    !nonEmptyStringV94(fence.workspaceId) ||
    nonNegativeIntegerV94(fence.replacementEpoch) === undefined
  ) {
    throw new Error('WaveAWorkspaceFenceInvalid')
  }
  return fence
}

function exactLeaseTargetV94(
  stored: StoredRecord,
  header: MessageHeaderRow | undefined,
  chat: Chat | undefined,
): boolean {
  return Boolean(
    header &&
      chat &&
      !header.deleted &&
      header.role === 'assistant' &&
      header.chatId === stored.chatId &&
      chat.id === header.chatId,
  )
}

function normalizeStoredLeaseV94(input: {
  readonly stored: StoredRecord
  readonly header: MessageHeaderRow
  readonly chat: Chat
  readonly replacementEpoch: number
  readonly observedAt: number
}): NormalizedLeaseV94 | undefined {
  const explicit = decodeExplicitWaveALeaseV94({
    value: input.stored,
    replacementEpoch: input.replacementEpoch,
    observedAt: input.observedAt,
  })
  if (explicit) {
    const lease = explicit.kind === 'nonterminal' ? explicit.lease : explicit.candidate
    if (
      lease.attemptKind === 'generation' &&
      (lease.phase === 'reserved' || lease.phase === 'active') &&
      input.header.generation?.finishedAt !== undefined
    ) {
      return undefined
    }
    return {
      lease,
      journalSemantics: explicit.journalSemantics,
      priorityKind: 'explicit',
      priorityHeartbeatAt: nonNegativeIntegerV94(input.stored.heartbeatAt) ?? 0,
    }
  }
  return normalizeLegacyLeaseV94(input)
}

function normalizeLegacyLeaseV94(input: {
  readonly stored: StoredRecord
  readonly header: MessageHeaderRow
  readonly chat: Chat
  readonly replacementEpoch: number
  readonly observedAt: number
}): NormalizedLeaseV94 | undefined {
  const raw = input.stored
  const streamId = nonEmptyStringV94(raw.streamId)
  const ownerClientId = nonEmptyStringV94(raw.ownerClientId)
  const startedAt = nonNegativeIntegerV94(raw.startedAt)
  const heartbeatAt = nonNegativeIntegerV94(raw.heartbeatAt)
  const admissionSequence = nonNegativeIntegerV94(raw.admissionSequence)
  if (!streamId || !ownerClientId || startedAt === undefined || admissionSequence === undefined) {
    return undefined
  }
  const attemptKind =
    raw.attemptKind === 'generation' || raw.attemptKind === 'continuation'
      ? raw.attemptKind
      : input.header.generation && input.header.generation.finishedAt === undefined
        ? 'generation'
        : undefined
  if (!attemptKind) return undefined
  if (attemptKind === 'generation' && input.header.generation?.finishedAt !== undefined) {
    return undefined
  }
  const targetCommittedAt = nonNegativeIntegerV94(raw.targetCommittedAt) ?? startedAt
  const continuationStrategy = raw.continuationStrategy
  const baseNodeVersion = nonNegativeIntegerV94(raw.baseNodeVersion)
  const baseBodyVersion = nonNegativeIntegerV94(raw.baseBodyVersion)
  if (
    attemptKind === 'continuation' &&
    ((continuationStrategy !== 'prompt' && continuationStrategy !== 'prefill') ||
      baseNodeVersion === undefined ||
      baseBodyVersion === undefined)
  ) {
    return undefined
  }
  const requestedModel =
    nonEmptyStringV94(raw.requestedModel) ??
    input.header.generation?.requestedModel ??
    input.header.generation?.model ??
    input.chat.settings.model
  const apiUsed = generationApiV94(raw.apiUsed ?? input.header.generation?.apiUsed) ?? 'chat'
  const postCommit = record(raw.postCommit)
  const common = {
    streamId,
    chatId: input.header.chatId,
    messageId: input.header.id,
    targetOwnerKey: input.header.id,
    custody: 'writer' as const,
    ownerClientId,
    fenceToken: nonEmptyStringV94(raw.fenceToken) ?? `legacy:${streamId}`,
    replacementEpoch: input.replacementEpoch,
    startedAt,
    heartbeatAt: heartbeatAt ?? startedAt,
    admissionSequence,
    revision: nonNegativeIntegerV94(raw.revision) ?? 0,
    controlRevision: 0,
    journalEventVersion: CURRENT_STREAM_JOURNAL_EVENT_VERSION,
    attemptKind,
    postCommit: {
      usedAt: nonNegativeIntegerV94(postCommit?.usedAt) ?? startedAt,
      profileId: nonEmptyStringV94(postCommit?.profileId) ?? input.chat.settings.profileId,
    },
  }
  const dispatch = {
    targetCommittedAt,
    requestedModel,
    apiUsed,
    reasoningCarryForward: normalizeReasoningCarryForwardV92(
      record(raw.dispatch)?.reasoningCarryForward,
    ),
    reasoningVisibility: normalizeReasoningVisibilityV92(record(raw.dispatch)?.reasoningVisibility),
    ...(attemptKind === 'continuation'
      ? { continuationStrategy, baseNodeVersion, baseBodyVersion }
      : {}),
  }
  const candidate = requireStreamLeaseRow({
    ...common,
    phase: 'active',
    dispatch,
  })
  const decoded = decodeExplicitWaveALeaseV94({
    value: candidate,
    replacementEpoch: input.replacementEpoch,
    observedAt: input.observedAt,
  })
  if (decoded?.kind !== 'nonterminal') return undefined
  return {
    lease: decoded.lease,
    journalSemantics: 'legacy-unversioned',
    priorityKind: 'explicit',
    priorityHeartbeatAt: heartbeatAt ?? 0,
  }
}

function compareLeasePriorityV94(
  candidate: StreamLeaseRow,
  candidateStage: LeaseReconciliationStageV94,
  competing: StreamLeaseRow,
  competingStage: LeaseReconciliationStageV94,
): number {
  if (candidateStage.priorityKind !== competingStage.priorityKind) {
    return candidateStage.priorityKind === 'explicit' ? 1 : -1
  }
  if (
    candidateStage.priorityKind === 'orphan' &&
    candidateStage.priorityHeartbeatAt !== competingStage.priorityHeartbeatAt
  ) {
    return candidateStage.priorityHeartbeatAt - competingStage.priorityHeartbeatAt
  }
  if (candidate.admissionSequence !== competing.admissionSequence) {
    return candidate.admissionSequence - competing.admissionSequence
  }
  if (candidate.startedAt !== competing.startedAt) return candidate.startedAt - competing.startedAt
  return candidate.streamId.localeCompare(competing.streamId)
}

async function migrateStreamJournalV94(
  tx: Transaction,
  lease: StreamLeaseRow,
  journalSemantics: WaveAExplicitJournalSemanticsV94,
  converter: V88JournalEventConverter,
  profile: ConnectionProfile | undefined,
  capabilities: WaveAStreamStorageMigrationCapabilitiesV94,
): Promise<MigratedJournalV94> {
  if (journalSemantics === 'persisted-v2') {
    const retained = await inspectCurrentJournalV94(tx, lease, capabilities)
    if (retained) {
      await deleteStreamFramesAfterV94(tx, lease.streamId, retained.journalMaxSeq, capabilities)
      return retained
    }
  }
  return rewriteStreamJournalV94(tx, lease, converter, profile, capabilities)
}

async function inspectCurrentJournalV94(
  tx: Transaction,
  lease: StreamLeaseRow,
  capabilities: WaveAStreamStorageMigrationCapabilitiesV94,
): Promise<MigratedJournalV94 | undefined> {
  const cutoff = authoritativeJournalCutoffV94(lease)
  const decoder = new StreamJournalFrameDecoder(streamJournalStableIdentity(lease))
  let journalMaxSeq = -1
  let journalStorageBytes = 0
  let observedRows = 0
  const inspection = { validCurrent: true }
  await forEachBoundedIdbCursorPage<StoredRecord>(
    streamFrameSequenceIndexV94(tx),
    {
      ...boundedStreamCursorOptionsV94(`InspectJournal:${lease.streamId}`, capabilities),
      query: streamFrameSequenceRangeV94(lease.streamId),
    },
    async (page) => {
      for (const entry of page.entries) {
        const seq = nonNegativeIntegerV94(entry.value.seq)
        if (seq === undefined || (cutoff !== undefined && seq > cutoff)) continue
        observedRows += 1
        try {
          if (!isStreamJournalFrameRow(entry.value)) throw new Error('LegacyFrame')
          const frame = requireCanonicalStreamJournalFrame(entry.value)
          const decoded = await waitForWaveAExternalV94(tx, decoder.accept(frame))
          if (decoded && !persistedStreamEventV2FromUnknown(decoded.event)) {
            throw new Error('LegacySemanticEvent')
          }
          journalMaxSeq = frame.seq
          journalStorageBytes = addStreamBytesV94(
            journalStorageBytes,
            estimateStreamJournalV83FrameStorageBytes(frame),
          )
        } catch {
          inspection.validCurrent = false
        }
      }
    },
  )
  if (!inspection.validCurrent) return undefined
  const expectedFinal = cutoff ?? journalMaxSeq
  if (journalMaxSeq !== expectedFinal || observedRows !== expectedFinal + 1) return undefined
  try {
    decoder.finish({ allowTruncatedTail: false, expectedFinalPhysicalSeq: expectedFinal })
  } catch {
    return undefined
  }
  return { journalMaxSeq, journalStorageBytes }
}

async function rewriteStreamJournalV94(
  tx: Transaction,
  lease: StreamLeaseRow,
  converter: V88JournalEventConverter,
  profile: ConnectionProfile | undefined,
  capabilities: WaveAStreamStorageMigrationCapabilitiesV94,
): Promise<MigratedJournalV94> {
  const frames = tx.table<StoredRecord, IndexableType>('streamChunks')
  const tempStreamId = `backcompat:v94:temporary:${globalThis.crypto.randomUUID()}:${lease.streamId}`
  if (
    (await frames.where('streamId').equals(tempStreamId).count()) !== 0 ||
    (await tx.table<StoredRecord, string>('streamLeases').get(tempStreamId)) !== undefined
  ) {
    throw new Error('WaveAStreamTemporaryIdentityCollision')
  }
  let stagedPosition = 0
  let conversionReader: BoundedIdbCursorReader<StoredRecord> | undefined
  let conversionFirstEntry: Promise<BoundedIdbCursorEntry<StoredRecord> | undefined> | undefined
  await forEachBoundedIdbCursorPage<StoredRecord>(
    streamFrameSequenceIndexV94(tx),
    {
      ...boundedStreamCursorOptionsV94(`StageJournal:${lease.streamId}`, capabilities),
      query: streamFrameSequenceRangeV94(lease.streamId),
      onFinalPageVisited: () => {
        conversionReader = openBoundedIdbCursorReader(
          streamFrameSequenceIndexV94(tx).openCursor(streamFrameSequenceRangeV94(tempStreamId)),
          `WaveAStreamConvertJournal:${lease.streamId}`,
        )
        conversionFirstEntry = conversionReader.next()
      },
    },
    async (page) => {
      const staged = page.entries.map((entry) => {
        const row = structuredClone(entry.value)
        const next = {
          ...row,
          id: streamJournalFrameId(tempStreamId, stagedPosition),
          streamId: tempStreamId,
        }
        stagedPosition += 1
        return next
      })
      if (staged.length > 0) await frames.bulkAdd(staged)
      for (const entry of page.entries) {
        capabilities.recordObsoleteBytes(entry.estimatedBytes)
      }
      await frames.bulkDelete(page.entries.map((entry) => entry.primaryKey as IndexableType))
    },
  )

  const cutoff = authoritativeJournalCutoffV94(lease)
  const apiUsed = lease.phase === 'reserved' ? undefined : (lease.dispatch?.apiUsed ?? undefined)
  const context = {
    ...(apiUsed ? { apiUsed } : {}),
    ...(profile ? { profile } : {}),
  }
  const outputFence = {
    ownerClientId: 'backcompat:v94',
    fenceToken: `backcompat:v94:${lease.streamId}`,
    replacementEpoch: lease.replacementEpoch,
    admissionSequence: lease.admissionSequence,
  }
  let inputMode: 'frames' | 'raw' | undefined
  let decoder: StreamJournalFrameDecoder | undefined
  let expectedRawSeq = 0
  let lastAcceptedSeq = -1
  let lastCreatedAt = lease.startedAt
  let nextPhysicalSeq = 0
  let nextLogicalSeq = 0
  let journalStorageBytes = 0
  const conversion = { malformed: false }
  if (!conversionReader || !conversionFirstEntry) {
    throw new Error(`WaveAStreamConversionCursorMissing:${lease.streamId}`)
  }
  await forEachBoundedIdbCursorReaderPage<StoredRecord>(
    conversionReader,
    boundedStreamCursorOptionsV94(`ConvertJournal:${lease.streamId}`, capabilities),
    async (page) => {
      for (const entry of page.entries) {
        capabilities.recordObsoleteBytes(entry.estimatedBytes)
        if (conversion.malformed) continue
        const raw = entry.value
        const seq = nonNegativeIntegerV94(raw.seq)
        if (
          seq === undefined ||
          nonEmptyStringV94(raw.chatId) !== lease.chatId ||
          nonEmptyStringV94(raw.messageId) !== lease.messageId
        ) {
          conversion.malformed = true
          continue
        }
        if (cutoff !== undefined && seq > cutoff) continue
        let persisted: PersistedStreamEventV2
        let createdAt: number
        try {
          if (isStreamJournalFrameRow(raw)) {
            if (inputMode === 'raw') throw new Error('WaveAStreamJournalEncodingMixed')
            inputMode = 'frames'
            decoder ??= new StreamJournalFrameDecoder()
            const decoded = await waitForWaveAExternalV94(
              tx,
              decoder.accept(requireCanonicalStreamJournalFrame(raw)),
            )
            lastAcceptedSeq = seq
            if (!decoded) continue
            lastCreatedAt = Math.max(lastCreatedAt, decoded.createdAt)
            createdAt = decoded.createdAt
            persisted = normalizeWaveAStoredStreamEventV94(
              decoded.event,
              createdAt,
              converter,
              context,
            )
          } else {
            if (inputMode === 'frames' || seq !== expectedRawSeq) {
              throw new Error('WaveAStreamJournalRawSequenceInvalid')
            }
            inputMode = 'raw'
            expectedRawSeq += 1
            lastAcceptedSeq = seq
            createdAt = nonNegativeIntegerV94(raw.createdAt) ?? lease.startedAt
            lastCreatedAt = Math.max(lastCreatedAt, createdAt)
            persisted = normalizeWaveAStoredStreamEventV94(raw.event, createdAt, converter, context)
          }
        } catch {
          conversion.malformed = true
          continue
        }
        const written = await writeWaveAStreamEventV94(
          tx,
          frames,
          lease,
          outputFence,
          persisted,
          createdAt,
          nextPhysicalSeq,
          nextLogicalSeq,
        )
        nextPhysicalSeq = written.nextPhysicalSeq
        nextLogicalSeq = written.nextLogicalSeq
        journalStorageBytes = addStreamBytesV94(journalStorageBytes, written.storageBytes)
      }
      await frames.bulkDelete(page.entries.map((entry) => entry.primaryKey as IndexableType))
    },
    conversionFirstEntry,
  )
  const expectedFinal = cutoff ?? lastAcceptedSeq
  if (!conversion.malformed && lastAcceptedSeq !== expectedFinal) {
    conversion.malformed = true
  }
  if (!conversion.malformed && decoder) {
    try {
      const finished = decoder.finish({
        allowTruncatedTail: true,
        expectedFinalPhysicalSeq: expectedFinal,
      })
      conversion.malformed = finished.truncated
    } catch {
      conversion.malformed = true
    }
  }
  if (conversion.malformed) {
    const integrity = waveAStreamIntegrityEventV94(converter, lease.streamId, context)
    const written = await writeWaveAStreamEventV94(
      tx,
      frames,
      lease,
      outputFence,
      integrity,
      lastCreatedAt,
      nextPhysicalSeq,
      nextLogicalSeq,
    )
    nextPhysicalSeq = written.nextPhysicalSeq
    nextLogicalSeq = written.nextLogicalSeq
    journalStorageBytes = addStreamBytesV94(journalStorageBytes, written.storageBytes)
  }
  return { journalMaxSeq: nextPhysicalSeq - 1, journalStorageBytes }
}

async function writeWaveAStreamEventV94(
  tx: Transaction,
  frames: Table<StoredRecord, IndexableType>,
  lease: StreamLeaseRow,
  fence: Readonly<{
    ownerClientId: string
    fenceToken: string
    replacementEpoch: number
    admissionSequence: number
  }>,
  event: PersistedStreamEventV2,
  createdAt: number,
  startPhysicalSeq: number,
  startLogicalSeq: number,
): Promise<
  Readonly<{
    nextPhysicalSeq: number
    nextLogicalSeq: number
    storageBytes: number
  }>
> {
  const cursor = createStreamJournalFrameCursor({
    streamId: lease.streamId,
    chatId: lease.chatId,
    messageId: lease.messageId,
    fence,
    entries: [{ createdAt, event }],
    startPhysicalSeq,
    startLogicalSeq,
  })
  let storageBytes = 0
  for (;;) {
    const batch = await waitForWaveAExternalV94(tx, readWaveAOutputFrameBatchV94(cursor))
    if (batch.length === 0) break
    await frames.bulkAdd(batch.map((frame) => ({ ...frame })))
    for (const frame of batch) {
      cursor.acknowledge(frame)
      storageBytes = addStreamBytesV94(
        storageBytes,
        estimateStreamJournalV83FrameStorageBytes(frame),
      )
    }
  }
  return {
    nextPhysicalSeq: cursor.nextPhysicalSeq,
    nextLogicalSeq: cursor.nextLogicalSeq,
    storageBytes,
  }
}

async function waitForWaveAExternalV94<T>(tx: Transaction, promise: Promise<T>): Promise<T> {
  let outcome:
    | Readonly<{ ok: true; value: T }>
    | Readonly<{ ok: false; error: unknown }>
    | undefined
  void promise.then(
    (value) => {
      outcome = { ok: true, value }
    },
    (error: unknown) => {
      outcome = { ok: false, error }
    },
  )
  while (!outcome) {
    await tx.table<SettingsRow, string>('settings').get(STREAM_ADMISSION_SEQUENCE_KEY_V94)
  }
  if (!outcome.ok) throw outcome.error
  return outcome.value
}

async function readWaveAOutputFrameBatchV94(
  cursor: StreamJournalFrameCursor,
): Promise<readonly CanonicalStreamJournalFrameRow[]> {
  const frames: CanonicalStreamJournalFrameRow[] = []
  let bytes = 0
  for (let offset = 0; offset < WAVE_A_STREAM_PAGE_MAX_ROWS_V94; offset += 1) {
    const frame = await cursor.frameAt(offset)
    if (!frame) break
    const frameBytes = estimateStreamJournalV83FrameStorageBytes(frame)
    if (frames.length > 0 && bytes + frameBytes > WAVE_A_STREAM_PAGE_MAX_BYTES_V94) break
    frames.push(frame)
    bytes = addStreamBytesV94(bytes, frameBytes)
    if (bytes >= WAVE_A_STREAM_PAGE_MAX_BYTES_V94) break
  }
  return frames
}

function leaseWithJournalProjectionV94(
  lease: StreamLeaseRow,
  journal: MigratedJournalV94,
): StreamLeaseRow {
  const base = leaseWithoutJournalProjectionV94(lease)
  const projected =
    journal.journalMaxSeq < 0
      ? base
      : {
          ...base,
          journalMaxSeq: journal.journalMaxSeq,
          journalStorageBytes: journal.journalStorageBytes,
        }
  if (projected.phase !== 'terminal-decided') return requireStreamLeaseRow(projected)
  return requireStreamLeaseRow({
    ...projected,
    terminal: { ...projected.terminal, journalMaxSeq: journal.journalMaxSeq },
  })
}

function leaseWithoutJournalProjectionV94(lease: StreamLeaseRow): StreamLeaseRow {
  const {
    journalMaxSeq: _journalMaxSeq,
    journalStorageBytes: _journalStorageBytes,
    ...withoutJournal
  } = lease
  if (withoutJournal.phase !== 'terminal-decided') return requireStreamLeaseRow(withoutJournal)
  return requireStreamLeaseRow({
    ...withoutJournal,
    terminal: { ...withoutJournal.terminal, journalMaxSeq: -1 },
  })
}

function authoritativeJournalCutoffV94(lease: StreamLeaseRow): number | undefined {
  if (lease.phase === 'terminal-decided') return lease.terminal.journalMaxSeq
  return lease.journalMaxSeq
}

async function retireStoredLeaseV94(
  tx: Transaction,
  stored: StoredRecord,
  capabilities: WaveAStreamStorageMigrationCapabilitiesV94,
  primaryKey: IDBValidKey,
): Promise<void> {
  const streamId = nonEmptyStringV94(stored.streamId)
  capabilities.recordObsoleteBytes(estimateStoredValueBytes(stored))
  await tx.table<StoredRecord, IndexableType>('streamLeases').delete(primaryKey as IndexableType)
  if (streamId) await deleteStreamFramesV94(tx, streamId, capabilities)
}

async function deleteStreamFramesV94(
  tx: Transaction,
  streamId: string,
  capabilities: WaveAStreamStorageMigrationCapabilitiesV94,
): Promise<void> {
  const frames = tx.table<StoredRecord, IndexableType>('streamChunks')
  await forEachBoundedIdbCursorPage<StoredRecord>(
    streamFrameIndexV94(tx),
    {
      ...boundedStreamCursorOptionsV94(`DeleteJournal:${streamId}`, capabilities),
      query: IDBKeyRange.only(streamId),
    },
    async (page) => {
      for (const entry of page.entries) capabilities.recordObsoleteBytes(entry.estimatedBytes)
      await frames.bulkDelete(page.entries.map((entry) => entry.primaryKey as IndexableType))
    },
  )
}

async function deleteStreamFramesAfterV94(
  tx: Transaction,
  streamId: string,
  retainedMaxSeq: number,
  capabilities: WaveAStreamStorageMigrationCapabilitiesV94,
): Promise<void> {
  await deleteMatchingStreamFramesV94(
    tx,
    streamId,
    (row) => (nonNegativeIntegerV94(row.seq) ?? Number.MAX_SAFE_INTEGER) > retainedMaxSeq,
    capabilities,
  )
}

async function deleteMatchingStreamFramesV94(
  tx: Transaction,
  streamId: string,
  matches: (row: StoredRecord) => boolean,
  capabilities: WaveAStreamStorageMigrationCapabilitiesV94,
): Promise<void> {
  const frames = tx.table<StoredRecord, IndexableType>('streamChunks')
  await forEachBoundedIdbCursorPage<StoredRecord>(
    streamFrameSequenceIndexV94(tx),
    {
      ...boundedStreamCursorOptionsV94(`DeleteJournal:${streamId}`, capabilities),
      query: streamFrameSequenceRangeV94(streamId),
    },
    async (page) => {
      const removed = page.entries.filter((entry) => matches(entry.value))
      for (const entry of removed) capabilities.recordObsoleteBytes(entry.estimatedBytes)
      if (removed.length > 0) {
        await frames.bulkDelete(removed.map((entry) => entry.primaryKey as IndexableType))
      }
    },
  )
}

async function removeOrphanStreamJournalsV94(
  tx: Transaction,
  capabilities: WaveAStreamStorageMigrationCapabilitiesV94,
): Promise<void> {
  const leases = tx.table<StoredRecord, string>('streamLeases')
  await forEachBoundedIdbCursorPage<StoredRecord>(
    streamFrameIndexV94(tx),
    {
      ...boundedStreamCursorOptionsV94('OrphanJournals', capabilities),
      direction: 'nextunique',
    },
    async (page) => {
      const streamIds = [
        ...new Set(
          page.entries.flatMap((entry) => {
            const streamId = nonEmptyStringV94(entry.value.streamId)
            return streamId ? [streamId] : []
          }),
        ),
      ]
      const retained = await leases.bulkGet(streamIds)
      for (let index = 0; index < streamIds.length; index += 1) {
        const streamId = streamIds[index]
        if (streamId && !retained[index]) {
          await deleteStreamFramesV94(tx, streamId, capabilities)
        }
      }
    },
  )
}

function streamFrameIndexV94(tx: Transaction): IDBIndex {
  return tx.idbtrans.objectStore('streamChunks').index('streamId')
}

function streamFrameSequenceIndexV94(tx: Transaction): IDBIndex {
  return tx.idbtrans.objectStore('streamChunks').index('[streamId+seq]')
}

function streamFrameSequenceRangeV94(streamId: string): IDBKeyRange {
  return scalarCompoundIndexKeyRange([streamId, 0], [streamId], 2)
}

function boundedStreamCursorOptionsV94(
  operation: string,
  capabilities: WaveAStreamStorageMigrationCapabilitiesV94,
): {
  readonly maxRows: number
  readonly maxBytes: number
  readonly operation: string
  readonly onPageVisited: (page: {
    readonly entries: readonly unknown[]
    readonly estimatedBytes: number
  }) => void
} {
  let processedRows = 0
  let processedBytes = 0
  return {
    maxRows: WAVE_A_STREAM_PAGE_MAX_ROWS_V94,
    maxBytes: WAVE_A_STREAM_PAGE_MAX_BYTES_V94,
    operation: `WaveAStream${operation}`,
    onPageVisited: (page) => {
      processedRows += page.entries.length
      processedBytes = addStreamBytesV94(processedBytes, page.estimatedBytes)
      capabilities.reportProgress?.({
        phase: 'streams',
        operation,
        processedRows,
        processedBytes,
      })
    },
  }
}

function nextAdmissionSequenceV94(current: number): number {
  if (current >= Number.MAX_SAFE_INTEGER) throw new Error('StreamAdmissionSequenceExhausted')
  return current + 1
}

function nonNegativeIntegerV94(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : undefined
}

function nonEmptyStringV94(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function uniqueStringsV94(values: readonly (string | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => value !== undefined))]
}

function definedByIdV94<T extends Readonly<{ id: string }>>(
  rows: readonly (T | undefined)[],
): Map<string, T> {
  return new Map(rows.flatMap((row) => (row ? [[row.id, row] as const] : [])))
}

function journalSemanticsV94(value: unknown): WaveAExplicitJournalSemanticsV94 | undefined {
  return value === 'legacy-unversioned' || value === 'persisted-v1' || value === 'persisted-v2'
    ? value
    : undefined
}

function generationApiV94(value: unknown): NonNullable<GenerationMeta['apiUsed']> | undefined {
  return value === 'chat' ||
    value === 'responses' ||
    value === 'gemini-native' ||
    value === 'anthropic-messages' ||
    value === 'completion' ||
    value === 'video-generation'
    ? value
    : undefined
}

function addStreamBytesV94(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right)
}

function decodeExplicitWaveALeaseSourceV94(
  value: unknown,
): DecodedExplicitWaveALeaseSourceV94 | undefined {
  const raw = record(value)
  if (!raw) return undefined
  if (raw.journalEventVersion === 2) {
    if (
      !valid(() => requireStreamLeaseRow(value)) &&
      !valid(() => requireV92StreamLeaseRow(value)) &&
      !valid(() => requireV91StreamLeaseRow(value))
    ) {
      return undefined
    }
    return {
      raw,
      structuralV88: structuralV88FromVersionedV94(raw),
      journalSemantics: 'persisted-v2',
    }
  }
  if (raw.journalEventVersion === 1) {
    if (
      !valid(() => requireV90StreamLeaseRow(value)) &&
      !valid(() => requireV89StreamLeaseRow(value))
    ) {
      return undefined
    }
    return {
      raw,
      structuralV88: structuralV88FromVersionedV94(raw),
      journalSemantics: 'persisted-v1',
    }
  }
  if (raw.journalEventVersion !== undefined) return undefined
  if (raw.controlRevision !== undefined) {
    const structuralV88 = valid(() => requireV88StreamLeaseRow(value))
    return structuralV88
      ? { raw, structuralV88, journalSemantics: 'legacy-unversioned' }
      : undefined
  }
  const v67 = valid(() => requireV67StreamLeaseRow(value))
  if (!v67) return undefined
  return {
    raw,
    structuralV88: requireV88StreamLeaseRow({ ...raw, controlRevision: 0 }),
    journalSemantics: 'legacy-unversioned',
  }
}

function structuralV88FromVersionedV94(raw: Record<string, unknown>): V88StreamLeaseRow {
  const { journalEventVersion: _journalEventVersion, ...withoutVersion } = raw
  const structuralCustody =
    withoutVersion.custody === 'recovery-pending' &&
    withoutVersion.handoffReason === 'owner-unavailable'
      ? { ...withoutVersion, handoffReason: 'cleanup-failed' }
      : withoutVersion
  const structuralTarget =
    structuralCustody.phase === 'metadata-committed'
      ? structuralCustody
      : { ...structuralCustody, targetOwnerKey: structuralCustody.messageId }
  const dispatch = record(structuralTarget.dispatch)
  if (!dispatch) return requireV88StreamLeaseRow(structuralTarget)
  const {
    reasoningCarryForward: _reasoningCarryForward,
    reasoningVisibility: _reasoningVisibility,
    ...structuralDispatch
  } = dispatch
  return requireV88StreamLeaseRow({ ...structuralTarget, dispatch: structuralDispatch })
}

function currentExplicitLeaseCandidateV94(raw: Record<string, unknown>): StreamLeaseRow {
  const dispatch = record(raw.dispatch)
  return requireStreamLeaseRow({
    ...raw,
    ...(raw.phase === 'reserved' || raw.phase === 'active' || raw.phase === 'terminal-decided'
      ? { targetOwnerKey: raw.messageId }
      : { targetOwnerKey: undefined }),
    journalEventVersion: CURRENT_STREAM_JOURNAL_EVENT_VERSION,
    controlRevision: raw.controlRevision ?? 0,
    ...(dispatch
      ? {
          dispatch: {
            ...dispatch,
            reasoningCarryForward: normalizeReasoningCarryForwardV92(
              dispatch.reasoningCarryForward,
            ),
            reasoningVisibility: normalizeReasoningVisibilityV92(dispatch.reasoningVisibility),
          },
        }
      : {}),
  })
}

function persistUpgradedEventV94(
  event: CanonicalStreamEventV1,
  context: ReasoningAttemptV92Context,
): PersistedStreamEventV2 {
  const persisted = persistedStreamEventV2FromUnknown({
    version: CURRENT_STREAM_JOURNAL_EVENT_VERSION,
    event: upgradeCanonicalStreamEventV1ToV2(event, context),
  })
  if (!persisted) throw new Error('WaveAStreamEventV94Invalid')
  return persisted
}

function valid<T>(read: () => T): T | undefined {
  try {
    return read()
  } catch {
    return undefined
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
