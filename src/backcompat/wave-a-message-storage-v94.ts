import type { Table, Transaction } from 'dexie'
import { normalizeAttachmentRefs } from '../core/attachment-refs'
import { messageTreeIndexFields } from '../core/message-tree-index'
import { tokenCalibrationKeyForStoredRecordKey } from '../core/model-ids'
import type {
  AttachmentBlob,
  AttachmentId,
  AttachmentJob,
  AttachmentReferenceEdge,
  ChatId,
  ConnectionProfile,
  DraftRow,
  ProfileId,
} from '../core/types'
import { sameValue } from '../lib/same-value'
import {
  type AttachmentCatalogAggregateRow,
  type AttachmentCatalogProjectionRow,
  type AttachmentReferenceSummary,
  accumulateAttachmentCatalogProjection,
  attachmentCatalogProjectionRow,
  emptyAttachmentCatalogAggregateRow,
} from '../store/attachment-catalog-projection'
import { completedAttachmentIntegrityState } from '../store/attachment-integrity-maintenance'
import {
  attachmentReferenceEdgesForOwner,
  reconcileAttachmentReferenceCount,
} from '../store/attachment-reference-edges'
import type { AttachmentHeaderRow } from '../store/attachment-storage'
import {
  type BoundedBatchWriter,
  createBoundedBatchWriter,
  forEachBoundedIdbCursorPage,
  forEachBoundedIdbKeyedPairPage,
  openBoundedIdbCursorReader,
} from '../store/bounded-idb-cursor'
import {
  type ConfigurationLink,
  configurationOwnerKey,
} from '../store/configuration-domain-contract'
import type {
  MessageBodyRow,
  MessageHeaderRow,
  MessageTextPreviewRow,
} from '../store/message-storage'
import { syncMessageHeaderProjections } from '../store/message-storage'
import { normalizeGeneratedOutputAttachmentsForMessageV94 } from './generated-output-attachments'
import {
  type LegacyMessageBodyRow,
  type LegacyMessageHeaderRow,
  normalizeProviderOutputOwnershipRowsV82,
} from './provider-output-items'
import {
  normalizeGenerationReasoningContractV92,
  normalizeMessageReasoningContractV92,
} from './reasoning-contract-normalizer-v92'
import type { WaveAStorageEpochMigrationCapabilitiesV94 } from './wave-a-storage-capabilities-v94'

const WAVE_A_MESSAGE_PAGE_MAX_ROWS_V94 = 128
const WAVE_A_MESSAGE_PAGE_MAX_BYTES_V94 = 4 * 1024 * 1024

type StoredRecord = Record<string, unknown>

export type WaveAMessageStorageMigrationCapabilitiesV94 = Pick<
  WaveAStorageEpochMigrationCapabilitiesV94,
  'observedAt' | 'recordObsoleteBytes' | 'reportProgress'
>

export async function migrateWaveAMessageAndAttachmentRowsV94(
  tx: Transaction,
  capabilities: WaveAMessageStorageMigrationCapabilitiesV94,
): Promise<void> {
  await migrateWaveAMessageRowsV94(tx, capabilities)
  await migrateWaveAAttachmentRowsV94(tx, capabilities)
}

export async function migrateWaveAMessageRowsV94(
  tx: Transaction,
  capabilities: WaveAMessageStorageMigrationCapabilitiesV94,
): Promise<void> {
  await Promise.all([tx.table('messagePreviews').clear(), tx.table('attachmentRefEdges').clear()])
  const headers = tx.table<MessageHeaderRow, string>('messages')
  const bodies = tx.table<MessageBodyRow, string>('messageBodies')
  const previews = boundedTableWriterV94<MessageTextPreviewRow, string>(
    tx.table<MessageTextPreviewRow, string>('messagePreviews'),
    'MessagePreviews',
  )
  const edges = validatedAttachmentEdgeWriterV94(tx)
  let processedRows = 0
  let processedBytes = 0

  await forEachBoundedIdbKeyedPairPage<StoredRecord, StoredRecord>(
    tx.idbtrans.objectStore('messages'),
    tx.idbtrans.objectStore('messageBodies'),
    {
      maxRows: WAVE_A_MESSAGE_PAGE_MAX_ROWS_V94,
      maxBytes: WAVE_A_MESSAGE_PAGE_MAX_BYTES_V94,
      operation: 'WaveAMessagePairs',
      onPageVisited: (page) => {
        processedRows += page.entries.length
        processedBytes = addBytesV94(processedBytes, page.estimatedBytes)
        capabilities.reportProgress?.({
          phase: 'messages-and-attachments',
          operation: 'normalize-message-pairs',
          processedRows,
          processedBytes,
        })
      },
    },
    async (page) => {
      const chatIds = uniqueStringsV94(
        page.entries.map((entry) => recordV94(entry.left?.value)?.chatId),
      )
      const profileLinks = await tx
        .table<ConfigurationLink, string>('configurationLinks')
        .bulkGet(chatIds.map((chatId) => `${configurationOwnerKey('chat', chatId)}:profile`))
      const profileIdByChatId = new Map<ChatId, ProfileId>()
      for (let index = 0; index < chatIds.length; index += 1) {
        const link = profileLinks[index]
        const chatId = chatIds[index]
        if (
          link &&
          chatId &&
          link.ownerKind === 'chat' &&
          link.ownerId === chatId &&
          link.slot === 'profile' &&
          link.targetKind === 'profile'
        ) {
          profileIdByChatId.set(chatId, link.targetId)
        }
      }
      const profileIds = uniqueStringsV94([...profileIdByChatId.values()])
      const profileRows = await tx
        .table<ConnectionProfile, ProfileId>('profiles')
        .bulkGet(profileIds)
      const profileById = new Map<ProfileId, ConnectionProfile>()
      for (let index = 0; index < profileIds.length; index += 1) {
        const profile = profileRows[index]
        const profileId = profileIds[index]
        if (profile && profileId) profileById.set(profileId, profile)
      }

      const changedHeaders: MessageHeaderRow[] = []
      const changedBodies: MessageBodyRow[] = []
      const orphanBodyKeys: IDBValidKey[] = []
      let obsoleteBytes = 0
      for (const entry of page.entries) {
        if (!entry.left) {
          if (entry.right) {
            obsoleteBytes = addBytesV94(obsoleteBytes, entry.right.estimatedBytes)
            orphanBodyKeys.push(entry.key)
          }
          continue
        }
        const storedHeader = requireMessageHeaderV94(entry.left.value, entry.key)
        if (!entry.right) {
          throw new Error(`WaveAMessageBodyMissing:${storedHeader.id}`)
        }
        const storedBody = requireMessageBodyV94(entry.right.value, storedHeader)
        const profileId = profileIdByChatId.get(storedHeader.chatId)
        const profile = profileId ? profileById.get(profileId) : undefined
        const normalized = await normalizeMessagePairV94({
          storedHeader,
          storedBody,
          ...(profile ? { profile } : {}),
          attachments: tx.table<AttachmentHeaderRow, string>('attachments'),
          blobs: tx.table<AttachmentBlob, string>('attachmentBlobs'),
          jobs: tx.table<AttachmentJob, string>('attachmentJobs'),
          observedAt: capabilities.observedAt,
        })
        if (normalized.headerChanged) {
          obsoleteBytes = addBytesV94(obsoleteBytes, entry.left.estimatedBytes)
          changedHeaders.push(normalized.header)
        }
        if (normalized.bodyChanged) {
          obsoleteBytes = addBytesV94(obsoleteBytes, entry.right.estimatedBytes)
          changedBodies.push(normalized.body)
        }
        obsoleteBytes = addBytesV94(obsoleteBytes, normalized.obsoleteBytes)
        await previews.add(normalized.preview)
        for (const edge of attachmentReferenceEdgesForOwner({
          ownerKind: 'message',
          ownerId: normalized.header.id,
          chatId: normalized.header.chatId,
          refs: normalized.header.attachmentRefs,
        })) {
          await edges.add(edge)
        }
      }
      await Promise.all([
        changedHeaders.length > 0 ? headers.bulkPut(changedHeaders) : Promise.resolve(),
        changedBodies.length > 0 ? bodies.bulkPut(changedBodies) : Promise.resolve(),
        deleteRawKeysV94(tx.idbtrans.objectStore('messageBodies'), orphanBodyKeys),
      ])
      if (obsoleteBytes > 0) capabilities.recordObsoleteBytes(obsoleteBytes)
    },
  )

  await migrateDraftAttachmentEdgesV94(tx, edges)
  await Promise.all([previews.flush(), edges.flush()])
}

async function migrateWaveAAttachmentRowsV94(
  tx: Transaction,
  capabilities: WaveAMessageStorageMigrationCapabilitiesV94,
): Promise<void> {
  await Promise.all([
    tx.table('attachmentCatalogRows').clear(),
    tx.table('attachmentCatalogAggregate').clear(),
    tx.table('attachmentIntegrityState').clear(),
  ])
  const attachmentStore = tx.idbtrans.objectStore('attachments')
  const edgeIndex = tx.idbtrans.objectStore('attachmentRefEdges').index('attachmentId')
  const attachments = tx.table<AttachmentHeaderRow, AttachmentId>('attachments')
  const changedAttachments = boundedTableWriterV94<AttachmentHeaderRow, AttachmentId>(
    attachments,
    'Attachments',
  )
  const catalog = boundedTableWriterV94<AttachmentCatalogProjectionRow, AttachmentId>(
    tx.table<AttachmentCatalogProjectionRow, AttachmentId>('attachmentCatalogRows'),
    'AttachmentCatalog',
  )
  const attachmentReader = openBoundedIdbCursorReader<StoredRecord>(
    attachmentStore.openCursor(),
    'WaveAAttachments',
  )
  const edgeReader = openBoundedIdbCursorReader<AttachmentReferenceEdge>(
    edgeIndex.openCursor(),
    'WaveAAttachmentEdges',
  )
  const aggregate = emptyAttachmentCatalogAggregateRow()
  let attachment = await attachmentReader.next()
  let edge = await edgeReader.next()
  let obsoleteBytes = 0
  let processedRows = 0
  let processedBytes = 0
  while (attachment) {
    const attachmentId = requireAttachmentIdV94(attachment.value, attachment.primaryKey)
    while (edge && indexedDB.cmp(edge.key, attachmentId) < 0) {
      throw new Error('WaveAAttachmentEdgeTargetMissing')
    }
    let refCount = 0
    let messageRefCount = 0
    let draftRefCount = 0
    let visibleRefCount = 0
    let previousOwnerKey: string | undefined
    while (edge && indexedDB.cmp(edge.key, attachmentId) === 0) {
      const value = edge.value
      const ownerKey = `${value.ownerKind}\u0000${value.ownerId}`
      refCount += 1
      visibleRefCount += Number(value.includeInContext)
      if (ownerKey !== previousOwnerKey) {
        if (value.ownerKind === 'message') messageRefCount += 1
        else draftRefCount += 1
        previousOwnerKey = ownerKey
      }
      edge = await edgeReader.next()
    }
    const summary: AttachmentReferenceSummary = {
      refCount,
      messageRefCount,
      draftRefCount,
      visibleRefCount,
    }
    const normalized = normalizeAttachmentHeaderV94(
      attachment.value,
      attachmentId,
      refCount,
      capabilities.observedAt,
    )
    if (normalized.changed) {
      obsoleteBytes = addBytesV94(obsoleteBytes, attachment.estimatedBytes)
      await changedAttachments.add(normalized.row)
    }
    const catalogRow = attachmentCatalogProjectionRow(normalized.row, summary)
    accumulateAttachmentCatalogProjection(aggregate, catalogRow)
    await catalog.add(catalogRow)
    processedRows += 1
    processedBytes = addBytesV94(processedBytes, attachment.estimatedBytes)
    if (processedRows % WAVE_A_MESSAGE_PAGE_MAX_ROWS_V94 === 0) {
      capabilities.reportProgress?.({
        phase: 'messages-and-attachments',
        operation: 'normalize-attachments',
        processedRows,
        processedBytes,
      })
    }
    attachment = await attachmentReader.next()
  }
  capabilities.reportProgress?.({
    phase: 'messages-and-attachments',
    operation: 'normalize-attachments',
    processedRows,
    processedBytes,
  })
  if (edge) throw new Error('WaveAAttachmentEdgeTargetMissing')
  await Promise.all([changedAttachments.flush(), catalog.flush()])

  obsoleteBytes = addBytesV94(
    obsoleteBytes,
    await removeOrphanAttachmentChildrenV94(tx, 'attachmentBlobs'),
  )
  obsoleteBytes = addBytesV94(
    obsoleteBytes,
    await removeOrphanAttachmentChildrenV94(tx, 'attachmentArtifacts'),
  )
  obsoleteBytes = addBytesV94(
    obsoleteBytes,
    await removeOrphanAttachmentChildrenV94(tx, 'attachmentJobs'),
  )
  await Promise.all([
    tx.table<AttachmentCatalogAggregateRow, string>('attachmentCatalogAggregate').put(aggregate),
    tx.table('attachmentIntegrityState').put(completedAttachmentIntegrityState()),
  ])
  if (obsoleteBytes > 0) capabilities.recordObsoleteBytes(obsoleteBytes)
}

function normalizeAttachmentHeaderV94(
  stored: StoredRecord,
  attachmentId: AttachmentId,
  refCount: number,
  observedAt: number,
): { readonly row: AttachmentHeaderRow; readonly changed: boolean } {
  const artifactIds = Array.isArray(stored.artifactIds)
    ? stored.artifactIds.filter((id): id is string => typeof id === 'string')
    : []
  const wireVersion = Number.isSafeInteger(stored.wireVersion) ? (stored.wireVersion as number) : 0
  const provisional = {
    ...stored,
    id: attachmentId,
    artifactIds,
    wireVersion,
    unreferencedAt:
      refCount > 0
        ? null
        : typeof stored.unreferencedAt === 'number' &&
            Number.isFinite(stored.unreferencedAt) &&
            stored.unreferencedAt >= 0
          ? stored.unreferencedAt
          : observedAt,
  } as unknown as AttachmentHeaderRow
  delete (provisional as AttachmentHeaderRow & { artifacts?: unknown }).artifacts
  const row = reconcileAttachmentReferenceCount(provisional, refCount, observedAt)
  const changed =
    stored.wireVersion !== wireVersion ||
    !sameValue(stored.artifactIds, artifactIds) ||
    Object.hasOwn(stored, 'artifacts') ||
    stored.refCount !== row.refCount ||
    stored.unreferencedAt !== row.unreferencedAt
  return { row, changed }
}

async function removeOrphanAttachmentChildrenV94(
  tx: Transaction,
  tableName: 'attachmentBlobs' | 'attachmentArtifacts' | 'attachmentJobs',
): Promise<number> {
  let obsoleteBytes = 0
  await forEachBoundedIdbCursorPage<StoredRecord>(
    tx.idbtrans.objectStore(tableName),
    {
      maxRows: WAVE_A_MESSAGE_PAGE_MAX_ROWS_V94,
      maxBytes: WAVE_A_MESSAGE_PAGE_MAX_BYTES_V94,
      operation: `WaveA${tableName}`,
    },
    async (page) => {
      const attachmentIds = uniqueStringsV94(page.entries.map((entry) => entry.value.attachmentId))
      const owners = await tx
        .table<AttachmentHeaderRow, AttachmentId>('attachments')
        .bulkGet(attachmentIds)
      const existing = new Set(attachmentIds.filter((_id, index) => owners[index] !== undefined))
      const orphanKeys: IDBValidKey[] = []
      for (const entry of page.entries) {
        if (
          typeof entry.value.attachmentId === 'string' &&
          existing.has(entry.value.attachmentId)
        ) {
          continue
        }
        orphanKeys.push(entry.primaryKey)
        obsoleteBytes = addBytesV94(obsoleteBytes, entry.estimatedBytes)
      }
      await deleteRawKeysV94(tx.idbtrans.objectStore(tableName), orphanKeys)
    },
  )
  return obsoleteBytes
}

function requireAttachmentIdV94(value: StoredRecord, key: IDBValidKey): AttachmentId {
  if (typeof value.id !== 'string' || value.id !== key) {
    throw new Error('WaveAAttachmentHeaderInvalid')
  }
  return value.id
}

async function normalizeMessagePairV94(input: {
  readonly storedHeader: MessageHeaderRow
  readonly storedBody: MessageBodyRow
  readonly profile?: ConnectionProfile
  readonly attachments: Table<AttachmentHeaderRow, string>
  readonly blobs: Table<AttachmentBlob, string>
  readonly jobs: Table<AttachmentJob, string>
  readonly observedAt: number
}): Promise<{
  readonly header: MessageHeaderRow
  readonly body: MessageBodyRow
  readonly preview: MessageTextPreviewRow
  readonly headerChanged: boolean
  readonly bodyChanged: boolean
  readonly obsoleteBytes: number
}> {
  const refs = normalizeAttachmentRefs(input.storedHeader.attachmentRefs, {
    messageId: input.storedHeader.id,
    createdAt: input.storedHeader.createdAt,
  })
  const tree = messageTreeIndexFields(input.storedHeader)
  let header: MessageHeaderRow = {
    ...input.storedHeader,
    attachmentRefs: refs,
    ...tree,
  }
  delete (header as MessageHeaderRow & { textPreview?: unknown }).textPreview
  delete (header as MessageHeaderRow & { subtreeLeafId?: unknown }).subtreeLeafId
  delete (header as MessageHeaderRow & { subtreeLeafCreatedAt?: unknown }).subtreeLeafCreatedAt
  let body = input.storedBody

  const generated = await normalizeGeneratedOutputAttachmentsForMessageV94({
    header,
    body,
    attachments: input.attachments,
    blobs: input.blobs,
    jobs: input.jobs,
    observedAt: input.observedAt,
  })
  header = generated.header
  body = generated.body

  const providerOutput = normalizeProviderOutputOwnershipRowsV82(
    header as unknown as LegacyMessageHeaderRow,
    body as LegacyMessageBodyRow,
  )
  header = providerOutput.header as unknown as MessageHeaderRow
  body = providerOutput.body as MessageBodyRow

  const storedGeneration = header.generation
  let generation = storedGeneration
  if (storedGeneration) {
    const normalizedGeneration = normalizeGenerationReasoningContractV92(storedGeneration)
    generation = normalizedGeneration
    if (normalizedGeneration !== storedGeneration) {
      header = { ...header, generation: normalizedGeneration }
    }
  }
  const context = {
    ...(typeof generation?.apiUsed === 'string' ? { apiUsed: generation.apiUsed } : {}),
    ...(input.profile ? { profile: input.profile } : {}),
  }
  body = normalizeMessageReasoningContractV92(body, generation, context)
  if (Object.hasOwn(body, 'nodeVersion')) {
    body = { ...body }
    delete (body as MessageBodyRow & { nodeVersion?: unknown }).nodeVersion
  }

  const projectedHeader = { ...header }
  const storedCalibrationKey = projectedHeader.originalCalibrationKey
  let calibrationKeyChanged = false
  if (typeof storedCalibrationKey === 'string' && storedCalibrationKey.length > 0) {
    const canonicalCalibrationKey = tokenCalibrationKeyForStoredRecordKey(storedCalibrationKey)
    if (canonicalCalibrationKey !== storedCalibrationKey) {
      projectedHeader.originalCalibrationKey = canonicalCalibrationKey
      calibrationKeyChanged = true
    }
  }
  const preview = syncMessageHeaderProjections(projectedHeader, body)
  const headerChanged =
    generated.changed ||
    providerOutput.headerChanged ||
    generation !== input.storedHeader.generation ||
    !sameValue(input.storedHeader.attachmentRefs, refs) ||
    input.storedHeader.treeParentKey !== tree.treeParentKey ||
    input.storedHeader.treeLive !== tree.treeLive ||
    Object.hasOwn(input.storedHeader, 'textPreview') ||
    Object.hasOwn(input.storedHeader, 'subtreeLeafId') ||
    Object.hasOwn(input.storedHeader, 'subtreeLeafCreatedAt') ||
    calibrationKeyChanged ||
    input.storedHeader.bodyWordCount !== projectedHeader.bodyWordCount ||
    input.storedHeader.bodyTextCharCount !== projectedHeader.bodyTextCharCount ||
    input.storedHeader.bodyMediaCount !== projectedHeader.bodyMediaCount ||
    input.storedHeader.bodyRenderCost !== projectedHeader.bodyRenderCost ||
    !sameValue(input.storedHeader.contextRouteFacts, projectedHeader.contextRouteFacts)
  return {
    header: projectedHeader,
    body,
    preview,
    headerChanged,
    bodyChanged: generated.changed || providerOutput.bodyChanged || body !== input.storedBody,
    obsoleteBytes: generated.obsoleteBytes,
  }
}

async function migrateDraftAttachmentEdgesV94(
  tx: Transaction,
  edges: BoundedBatchWriter<AttachmentReferenceEdge>,
): Promise<void> {
  const drafts = tx.table<DraftRow, ChatId>('drafts')
  const changed = boundedTableWriterV94<DraftRow, ChatId>(drafts, 'Drafts')
  await forEachBoundedIdbCursorPage<DraftRow>(
    tx.idbtrans.objectStore('drafts'),
    {
      maxRows: WAVE_A_MESSAGE_PAGE_MAX_ROWS_V94,
      maxBytes: WAVE_A_MESSAGE_PAGE_MAX_BYTES_V94,
      operation: 'WaveADrafts',
    },
    async (page) => {
      for (const { value: draft } of page.entries) {
        const refs = normalizeAttachmentRefs(draft.attachmentRefs, {
          draftChatId: draft.chatId,
          createdAt: draft.updatedAt,
        })
        const next = sameValue(draft.attachmentRefs, refs)
          ? draft
          : { ...draft, attachmentRefs: refs }
        if (next !== draft) await changed.add(next)
        for (const edge of attachmentReferenceEdgesForOwner({
          ownerKind: 'draft',
          ownerId: draft.chatId,
          chatId: draft.chatId,
          refs,
        })) {
          await edges.add(edge)
        }
      }
    },
  )
  await changed.flush()
}

async function requireAttachmentTargetsV94(
  tx: Transaction,
  edges: readonly AttachmentReferenceEdge[],
): Promise<void> {
  const attachmentIds = uniqueStringsV94(edges.map((edge) => edge.attachmentId))
  if (attachmentIds.length === 0) return
  const rows = await tx
    .table<AttachmentHeaderRow, AttachmentId>('attachments')
    .bulkGet(attachmentIds)
  for (let index = 0; index < attachmentIds.length; index += 1) {
    if (!rows[index]) throw new Error(`WaveAAttachmentTargetMissing:${attachmentIds[index]}`)
  }
}

function validatedAttachmentEdgeWriterV94(
  tx: Transaction,
): BoundedBatchWriter<AttachmentReferenceEdge> {
  const table = tx.table<
    AttachmentReferenceEdge,
    [AttachmentReferenceEdge['ownerKind'], string, string]
  >('attachmentRefEdges')
  return createBoundedBatchWriter({
    maxRows: WAVE_A_MESSAGE_PAGE_MAX_ROWS_V94,
    maxBytes: WAVE_A_MESSAGE_PAGE_MAX_BYTES_V94,
    operation: 'WaveAAttachmentReferenceEdges',
    write: async (rows) => {
      await requireAttachmentTargetsV94(tx, rows)
      await table.bulkPut([...rows])
    },
  })
}

function requireMessageHeaderV94(value: StoredRecord, key: IDBValidKey): MessageHeaderRow {
  if (
    typeof value.id !== 'string' ||
    value.id !== key ||
    typeof value.chatId !== 'string' ||
    !Number.isSafeInteger(value.bodyVersion) ||
    !Number.isSafeInteger(value.nodeVersion) ||
    !Number.isSafeInteger(value.requestContextVersion)
  ) {
    throw new Error('WaveAMessageHeaderInvalid')
  }
  return value as unknown as MessageHeaderRow
}

function requireMessageBodyV94(value: StoredRecord, header: MessageHeaderRow): MessageBodyRow {
  if (
    value.id !== header.id ||
    value.chatId !== header.chatId ||
    value.bodyVersion !== header.bodyVersion ||
    !Array.isArray(value.content) ||
    typeof value.updatedAt !== 'number' ||
    !Number.isFinite(value.updatedAt)
  ) {
    throw new Error(`WaveAMessageBodyInvalid:${header.id}`)
  }
  return value as unknown as MessageBodyRow
}

function boundedTableWriterV94<Row, Key>(
  table: Table<Row, Key>,
  operation: string,
): BoundedBatchWriter<Row> {
  return createBoundedBatchWriter({
    maxRows: WAVE_A_MESSAGE_PAGE_MAX_ROWS_V94,
    maxBytes: WAVE_A_MESSAGE_PAGE_MAX_BYTES_V94,
    operation: `WaveA${operation}`,
    write: (rows) => table.bulkPut([...rows]).then(() => undefined),
  })
}

function deleteRawKeysV94(store: IDBObjectStore, keys: readonly IDBValidKey[]): Promise<void> {
  if (keys.length === 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    let remaining = keys.length
    let settled = false
    for (const key of keys) {
      const request = store.delete(key)
      request.onerror = () => {
        if (settled) return
        settled = true
        reject(request.error ?? new Error('WaveAMessageBodyDeleteFailed'))
      }
      request.onsuccess = () => {
        if (settled) return
        remaining -= 1
        if (remaining === 0) {
          settled = true
          resolve()
        }
      }
    }
  })
}

function uniqueStringsV94(values: readonly unknown[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string'))]
}

function recordV94(value: unknown): StoredRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as StoredRecord)
    : undefined
}

function addBytesV94(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right)
}
