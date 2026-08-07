import Dexie from 'dexie'
import { sameValue } from '../lib/same-value'
import {
  recordBrowserCommandOwnerInvalidation,
  recordBrowserCommandPhysicalDeletionRows,
  recordBrowserCommandStreamJournalRetirementPage,
} from './browser-command-mutation-journal'
import {
  addPhysicalStorageRow,
  addPhysicalStorageRows,
  deletePhysicalStorageKeys,
  recordObsoleteByteOwnerBytes,
  replacePhysicalStorageRow,
} from './byte-owner-mutation'
import { exactCompoundPrefixBetween } from './indexeddb-key-ranges'
import {
  type CapabilityTables,
  type FencedTransaction,
  physicalStorageTables,
} from './physical-storage-tables'
import {
  type CanonicalStreamJournalFrameRow,
  type FencedStreamLeaseRow,
  requireStreamLeaseRow,
  type StreamJournalFrameRow,
  type StreamLeaseRow,
  type StreamWriteFence,
  streamJournalFrameId,
  streamLeaseHasWriteFence,
  streamLeaseMatchesWriteFence,
} from './repository'
import {
  type SemanticOperationReceiptFragment,
  semanticOperationReceiptFragment,
} from './semantic-operation-capability'
import {
  estimateStoredValueBytes,
  estimateStreamJournalFrameStorageBytes,
} from './storage-size-estimate'
import {
  assertStreamJournalFrameTransition,
  type CanonicalStreamJournalFrameBatch,
  requireCanonicalStreamJournalFrame,
  type StreamJournalWriterAuthority,
  sameStreamJournalStableIdentity,
  sameStreamJournalWriterAuthority,
  streamJournalWriterAuthority,
} from './stream-journal-codec'
import { STREAM_LEASE_HEARTBEAT_COALESCE_MS } from './stream-lease-policy'

export const STREAM_JOURNAL_RETIREMENT_MAX_ROWS = 64

export const STREAM_LEASE_MUTATION_TRANSACTION_CAPABILITY = physicalStorageTables('streamLeases')
export const STREAM_JOURNAL_MUTATION_TRANSACTION_CAPABILITY = physicalStorageTables(
  'streamLeases',
  'streamChunks',
)

type StreamLeaseMutationTransaction = FencedTransaction<
  CapabilityTables<typeof STREAM_LEASE_MUTATION_TRANSACTION_CAPABILITY>
>
type StreamJournalMutationTransaction = FencedTransaction<
  CapabilityTables<typeof STREAM_JOURNAL_MUTATION_TRANSACTION_CAPABILITY>
>

type ActiveFencedStreamLease = FencedStreamLeaseRow & { readonly phase: 'active' }

export interface StreamJournalAppendResult {
  readonly lease?: ActiveFencedStreamLease
  readonly authority: StreamJournalWriterAuthority
  readonly acceptedFrameIds: readonly string[]
  readonly appendedFrameIds: readonly string[]
  readonly lookupFrameIds: readonly string[]
  readonly receipt: SemanticOperationReceiptFragment<'streamLeases' | 'streamChunks'>
}

export async function putStreamLeaseByteOwner(
  tx: StreamLeaseMutationTransaction,
  next: StreamLeaseRow,
  previous: StreamLeaseRow | undefined,
): Promise<void> {
  if (!previous) {
    await addPhysicalStorageRow<StreamLeaseRow, string>(tx, 'streamLeases', next)
  } else {
    await replacePhysicalStorageRow<StreamLeaseRow, string>(tx, 'streamLeases', next, previous)
  }
  recordBrowserCommandOwnerInvalidation(tx, {
    kind: 'stream-lease',
    chatId: next.chatId,
    streamIds: [next.streamId],
  })
  if (next.phase === 'metadata-committed' && previous?.phase !== 'metadata-committed') {
    recordBrowserCommandOwnerInvalidation(tx, {
      kind: 'storage-maintenance',
      tasks: ['prune-terminal-streams'],
    })
  }
}

export async function appendStreamJournalFrames(
  tx: StreamJournalMutationTransaction,
  frames: CanonicalStreamJournalFrameBatch,
  observedAt: number,
): Promise<StreamJournalAppendResult> {
  if (!Number.isSafeInteger(observedAt) || observedAt < 0) {
    throw new Error('StreamJournalObservedAtInvalid')
  }
  const first = frames[0]
  if (!first) throw new Error('StreamJournalAppendBatchEmpty')
  const identity = streamJournalWriterAuthority(first)
  for (const frame of frames) {
    if (!sameStreamJournalWriterAuthority(identity, streamJournalWriterAuthority(frame))) {
      throw streamJournalAppendInvariantError(frame.streamId, 'writer-authority')
    }
  }
  const streamId = identity.streamId
  const leases = tx.table<StreamLeaseRow, string>('streamLeases')
  const lease = requireActiveStreamJournalAppendLease(await leases.get(streamId), identity)
  const streamFrames = tx.table<StreamJournalFrameRow, string>('streamChunks')
  const journalMaxSeq = lease.journalMaxSeq ?? -1
  const overlapFrames = frames.filter((frame) => frame.seq <= journalMaxSeq)
  const newFrames = frames.filter((frame) => frame.seq > journalMaxSeq)
  const lookupFrameIds = overlapFrames.map((frame) => frame.id)
  if (newFrames.length > 0 && journalMaxSeq >= 0) {
    const tailId = streamJournalFrameId(streamId, journalMaxSeq)
    if (!lookupFrameIds.includes(tailId)) lookupFrameIds.push(tailId)
  }
  const existingRows = lookupFrameIds.length === 0 ? [] : await streamFrames.bulkGet(lookupFrameIds)
  const existingById = new Map(
    lookupFrameIds.flatMap((id, index) => {
      const row = existingRows[index]
      return row ? ([[id, row]] as const) : []
    }),
  )
  for (const frame of overlapFrames) {
    const existing = existingById.get(frame.id)
    if (!existing) {
      throw new Error(`StreamJournalFrameMissing:${frame.streamId}:${frame.seq}`)
    }
    if (!sameValue(requireCanonicalStreamJournalFrame(existing), frame)) {
      throw new Error(`StreamJournalFrameConflict:${frame.streamId}:${frame.seq}`)
    }
  }
  let previous: CanonicalStreamJournalFrameRow | undefined
  if (newFrames.length > 0 && journalMaxSeq >= 0) {
    const row = existingById.get(streamJournalFrameId(streamId, journalMaxSeq))
    if (!row) throw streamJournalAppendInvariantError(streamId, 'previous-frame')
    previous = requireCanonicalStreamJournalFrame(row)
  }
  let appendedBytes = 0
  for (const frame of newFrames) {
    assertStreamJournalFrameTransition(previous, frame)
    previous = frame
    appendedBytes = saturatingAdd(appendedBytes, estimateStreamJournalFrameStorageBytes(frame))
  }
  const refreshHeartbeat =
    newFrames.length > 0 && observedAt - lease.heartbeatAt > STREAM_LEASE_HEARTBEAT_COALESCE_MS
  if (newFrames.length === 0) {
    return streamJournalAppendResult(lease, frames, [], lookupFrameIds, false)
  }
  const appendedTail = newFrames.at(-1)
  if (!appendedTail) throw streamJournalAdvanceInvariantError(streamId, 'appended-tail')
  const next = requireStreamLeaseRow({
    ...lease,
    journalMaxSeq: appendedTail.seq,
    journalStorageBytes: saturatingAdd(lease.journalStorageBytes ?? 0, appendedBytes),
    ...(refreshHeartbeat ? { heartbeatAt: observedAt } : {}),
  })
  if (next.phase !== 'active' || next.custody === 'recovery-pending') {
    throw streamJournalAdvanceInvariantError(streamId, 'constructed-state')
  }
  await replacePhysicalStorageRow<StreamLeaseRow, string>(tx, 'streamLeases', next, lease)
  await addPhysicalStorageRows<CanonicalStreamJournalFrameRow, string>(
    tx,
    'streamChunks',
    newFrames,
  )
  recordBrowserCommandOwnerInvalidation(tx, {
    kind: 'stream-chunks',
    chatId: next.chatId,
    streamIds: [streamId],
  })
  if (next.heartbeatAt !== lease.heartbeatAt) {
    recordBrowserCommandOwnerInvalidation(tx, {
      kind: 'stream-lease',
      chatId: next.chatId,
      streamIds: [streamId],
    })
  }
  return streamJournalAppendResult(next, frames, newFrames, lookupFrameIds, refreshHeartbeat)
}

function streamJournalAppendResult(
  lease: ActiveFencedStreamLease,
  frames: CanonicalStreamJournalFrameBatch,
  appendedFrames: readonly CanonicalStreamJournalFrameRow[],
  lookupFrameIds: readonly string[],
  heartbeatChanged: boolean,
): StreamJournalAppendResult {
  const dependencies = [
    ...(appendedFrames.length > 0
      ? [
          {
            kind: 'stream-chunks' as const,
            chatId: lease.chatId,
            streamIds: [lease.streamId],
          },
        ]
      : []),
    ...(heartbeatChanged
      ? [
          {
            kind: 'stream-lease' as const,
            chatId: lease.chatId,
            streamIds: [lease.streamId],
          },
        ]
      : []),
  ]
  return Object.freeze({
    ...(appendedFrames.length > 0 ? { lease } : {}),
    authority: streamJournalWriterAuthority(lease),
    acceptedFrameIds: Object.freeze(frames.map((frame) => frame.id)),
    appendedFrameIds: Object.freeze(appendedFrames.map((frame) => frame.id)),
    lookupFrameIds: Object.freeze([...lookupFrameIds]),
    receipt: semanticOperationReceiptFragment({
      dependencies,
      physicalMutations: [
        ...(appendedFrames.length > 0
          ? [
              {
                tableName: 'streamLeases' as const,
                operation: 'write' as const,
                key: lease.streamId,
              },
            ]
          : []),
        ...appendedFrames.map((frame) => ({
          tableName: 'streamChunks' as const,
          operation: 'write' as const,
          key: frame.id,
        })),
      ],
      physicalReads: [
        {
          tableName: 'streamLeases',
          indexKind: 'primary',
          operation: 'get',
          requestCount: 1,
          rowCount: 1,
        },
        ...(lookupFrameIds.length > 0
          ? [
              {
                tableName: 'streamChunks' as const,
                indexKind: 'primary' as const,
                operation: 'get-many' as const,
                requestCount: 1,
                rowCount: lookupFrameIds.length,
              },
            ]
          : []),
      ],
    }),
  })
}

export type StreamJournalRetirementRequest =
  | {
      readonly kind: 'owned-metadata-committed'
      readonly streamId: string
      readonly fence: StreamWriteFence
      readonly maxFrameRows: number
    }
  | {
      readonly kind: 'retention-candidate'
      readonly streamId: string
      readonly expectedRevision: number
      readonly expectedTerminalRetentionAt: number
      readonly cutoff: number
      readonly maxFrameRows: number
    }
  | {
      readonly kind: 'lease-absent-stream'
      readonly streamId: string
      readonly maxFrameRows: number
    }
  | { readonly kind: 'orphan-chat-closure'; readonly chatIds: readonly string[] }

export interface StreamJournalRetirementResult {
  readonly deletedFrames: number
  readonly deletedLeases: number
  readonly obsoleteBytes: number
}

export type StreamJournalRetirementPageResult = StreamJournalRetirementResult &
  (
    | { readonly outcome: 'progress'; readonly done: false }
    | { readonly outcome: 'complete'; readonly done: true }
    | {
        readonly outcome: 'ineligible'
        readonly done: true
        readonly reason:
          | 'lease-changed'
          | 'lease-present'
          | 'lease-missing'
          | 'not-metadata-committed'
      }
  )

export type StreamJournalRetirementPageTransition =
  | {
      readonly kind: 'single-stream'
      readonly result: StreamJournalRetirementPageResult
      readonly receipt: SemanticOperationReceiptFragment<'streamLeases' | 'streamChunks'>
    }
  | {
      readonly kind: 'orphan-chat-closure'
      readonly result: StreamJournalRetirementPageResult
    }

export async function retireStreamJournalOwnershipPage(
  tx: StreamJournalMutationTransaction,
  request: StreamJournalRetirementRequest,
): Promise<StreamJournalRetirementPageTransition> {
  if (request.kind === 'orphan-chat-closure') {
    return {
      kind: 'orphan-chat-closure',
      result: await retireOrphanChatStreamJournalPage(tx, request.chatIds),
    }
  }
  return retireOneStreamJournalPage(tx, request)
}

async function retireOneStreamJournalPage(
  tx: StreamJournalMutationTransaction,
  request: Exclude<StreamJournalRetirementRequest, { kind: 'orphan-chat-closure' }>,
): Promise<Extract<StreamJournalRetirementPageTransition, { kind: 'single-stream' }>> {
  const { streamId } = request
  const maxFrameRows = boundedStreamJournalRetirementRows(request.maxFrameRows)
  const frames = tx.table<StreamJournalFrameRow, string>('streamChunks')
  const leases = tx.table<StreamLeaseRow, string>('streamLeases')
  const [lease, rows] = await Dexie.Promise.all([
    leases.get(streamId),
    frames
      .where('streamId')
      .equals(streamId)
      .limit(maxFrameRows + 1)
      .toArray(),
  ])
  const physicalReads = [
    {
      tableName: 'streamLeases' as const,
      indexKind: 'primary' as const,
      operation: 'get' as const,
      requestCount: 1,
      rowCount: 1,
    },
    {
      tableName: 'streamChunks' as const,
      indexKind: 'secondary' as const,
      indexName: 'streamId',
      operation: 'query' as const,
      requestCount: 1,
      rowCount: rows.length,
    },
  ]
  if (!lease && rows.length === 0) {
    return singleStreamJournalRetirementTransition(
      completedStreamJournalRetirementPage(),
      semanticOperationReceiptFragment({ physicalReads }),
    )
  }
  const ineligible = streamJournalRetirementIneligibility(request, lease, rows.length > 0)
  if (ineligible) {
    return singleStreamJournalRetirementTransition(
      ineligibleStreamJournalRetirementPage(ineligible),
      semanticOperationReceiptFragment({ physicalReads }),
    )
  }
  const page = rows.slice(0, maxFrameRows)
  const done = rows.length <= maxFrameRows
  let measuredJournalBytes = 0
  const frameIds = page.map((frame) => frame.id)
  let frameMutationAddress: string | undefined
  if (frameIds.length > 0) {
    frameMutationAddress = recordBrowserCommandStreamJournalRetirementPage(tx, frameIds, {
      kind: 'stream',
      streamId,
      ...(lease ? { chatId: lease.chatId } : {}),
    })
    for (const row of page) {
      const frame = requireCanonicalStreamJournalFrame(row)
      if (
        frame.streamId !== streamId ||
        (lease && !sameStreamJournalStableIdentity(lease, frame))
      ) {
        throw streamJournalAppendInvariantError(streamId, 'retirement-identity')
      }
      measuredJournalBytes = saturatingAdd(
        measuredJournalBytes,
        estimateStreamJournalFrameStorageBytes(frame),
      )
    }
    await deletePhysicalStorageKeys<StreamJournalFrameRow, string>(tx, 'streamChunks', frameIds)
  }
  const deleteLease = done && lease !== undefined && request.kind !== 'lease-absent-stream'
  if (deleteLease) {
    recordBrowserCommandPhysicalDeletionRows(tx, 'streamLeases', [streamId], [lease])
    await deletePhysicalStorageKeys<StreamLeaseRow, string>(tx, 'streamLeases', [streamId])
  }
  const obsoleteBytes = saturatingAdd(
    measuredJournalBytes,
    deleteLease ? estimateStoredValueBytes(lease) : 0,
  )
  recordObsoleteByteOwnerBytes(tx, obsoleteBytes)
  if (deleteLease) {
    recordBrowserCommandOwnerInvalidation(tx, {
      kind: 'stream-lease',
      chatId: lease.chatId,
      streamIds: [streamId],
    })
  }
  if (frameIds.length > 0) {
    recordBrowserCommandOwnerInvalidation(tx, {
      kind: 'stream-chunks',
      ...(lease ? { chatId: lease.chatId } : {}),
      streamIds: [streamId],
    })
  }
  return singleStreamJournalRetirementTransition(
    {
      outcome: done ? 'complete' : 'progress',
      deletedFrames: frameIds.length,
      deletedLeases: deleteLease ? 1 : 0,
      obsoleteBytes,
      done,
    } as StreamJournalRetirementPageResult,
    semanticOperationReceiptFragment({
      dependencies: [
        ...(frameIds.length > 0
          ? [
              {
                kind: 'stream-chunks' as const,
                ...(lease ? { chatId: lease.chatId } : {}),
                streamIds: [streamId],
              },
            ]
          : []),
        ...(deleteLease
          ? [
              {
                kind: 'stream-lease' as const,
                chatId: lease.chatId,
                streamIds: [streamId],
              },
            ]
          : []),
      ],
      physicalMutations: [
        ...(frameMutationAddress
          ? [
              {
                tableName: 'streamChunks' as const,
                operation: 'delete-group' as const,
                address: frameMutationAddress,
                affectedRows: frameIds.length,
              },
            ]
          : []),
        ...(deleteLease
          ? [
              {
                tableName: 'streamLeases' as const,
                operation: 'delete' as const,
                key: streamId,
              },
            ]
          : []),
      ],
      physicalReads,
    }),
  )
}

async function retireOrphanChatStreamJournalPage(
  tx: StreamJournalMutationTransaction,
  requestedChatIds: readonly string[],
): Promise<StreamJournalRetirementPageResult> {
  const chatIds = [...new Set(requestedChatIds)]
  if (chatIds.length === 0) {
    return completedStreamJournalRetirementPage()
  }
  const chatIdSet = new Set(chatIds)
  const leases = tx.table<StreamLeaseRow, string>('streamLeases')
  for (const chatId of chatIds) {
    const lease = await leases
      .where('[chatId+streamId]')
      .between(...exactCompoundPrefixBetween([chatId]))
      .first()
    if (lease) return ineligibleStreamJournalRetirementPage('lease-present')
  }
  const frames = tx.table<StreamJournalFrameRow, string>('streamChunks')
  let obsoleteBytes = 0
  const rows = await frames
    .where('chatId')
    .anyOf(chatIds)
    .limit(STREAM_JOURNAL_RETIREMENT_MAX_ROWS + 1)
    .toArray()
  const page = rows.slice(0, STREAM_JOURNAL_RETIREMENT_MAX_ROWS)
  const done = rows.length <= STREAM_JOURNAL_RETIREMENT_MAX_ROWS
  const canonical = page.map(requireCanonicalStreamJournalFrame)
  const frameIds = canonical.map((frame) => frame.id)
  if (frameIds.length > 0) {
    recordBrowserCommandStreamJournalRetirementPage(tx, frameIds, {
      kind: 'orphan-chat-closure',
      chatIds,
    })
    for (const frame of canonical) {
      if (!chatIdSet.has(frame.chatId)) {
        throw streamJournalAppendInvariantError(frame.streamId, 'chat-retirement-identity')
      }
      obsoleteBytes = saturatingAdd(obsoleteBytes, estimateStreamJournalFrameStorageBytes(frame))
    }
    await deletePhysicalStorageKeys<StreamJournalFrameRow, string>(tx, 'streamChunks', frameIds)
  }
  recordObsoleteByteOwnerBytes(tx, obsoleteBytes)
  if (frameIds.length > 0) {
    for (const chatId of chatIds) {
      recordBrowserCommandOwnerInvalidation(tx, { kind: 'stream-chunks', chatId })
    }
  }
  return {
    outcome: done ? 'complete' : 'progress',
    deletedFrames: frameIds.length,
    deletedLeases: 0,
    obsoleteBytes,
    done,
  } as StreamJournalRetirementPageResult
}

function streamJournalRetirementIneligibility(
  request: Exclude<StreamJournalRetirementRequest, { kind: 'orphan-chat-closure' }>,
  lease: StreamLeaseRow | undefined,
  hasFrames: boolean,
): Extract<StreamJournalRetirementPageResult, { outcome: 'ineligible' }>['reason'] | undefined {
  if (request.kind === 'lease-absent-stream') return lease ? 'lease-present' : undefined
  if (!lease) return hasFrames ? 'lease-missing' : undefined
  if (request.kind === 'owned-metadata-committed') {
    if (!streamLeaseMatchesWriteFence(lease, request.fence)) return 'lease-changed'
    return lease.phase === 'metadata-committed' ? undefined : 'not-metadata-committed'
  }
  if (lease.phase !== 'metadata-committed') return 'not-metadata-committed'
  return lease.revision === request.expectedRevision &&
    lease.terminalRetentionAt === request.expectedTerminalRetentionAt &&
    lease.terminalRetentionAt < request.cutoff
    ? undefined
    : 'lease-changed'
}

function completedStreamJournalRetirementPage(): StreamJournalRetirementPageResult {
  return {
    outcome: 'complete',
    done: true,
    deletedFrames: 0,
    deletedLeases: 0,
    obsoleteBytes: 0,
  }
}

function ineligibleStreamJournalRetirementPage(
  reason: Extract<StreamJournalRetirementPageResult, { outcome: 'ineligible' }>['reason'],
): StreamJournalRetirementPageResult {
  return {
    outcome: 'ineligible',
    reason,
    done: true,
    deletedFrames: 0,
    deletedLeases: 0,
    obsoleteBytes: 0,
  }
}

function singleStreamJournalRetirementTransition(
  result: StreamJournalRetirementPageResult,
  receipt: SemanticOperationReceiptFragment<'streamLeases' | 'streamChunks'>,
): Extract<StreamJournalRetirementPageTransition, { kind: 'single-stream' }> {
  return Object.freeze({
    kind: 'single-stream',
    result: Object.freeze(result),
    receipt,
  })
}

function boundedStreamJournalRetirementRows(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('StreamJournalRetirementLimitInvalid')
  }
  return Math.min(value, STREAM_JOURNAL_RETIREMENT_MAX_ROWS)
}

function streamJournalAppendInvariantError(streamId: string, reason: string): Error {
  return new Error(`StreamJournalAppendInvariantError:${streamId}:${reason}`)
}

function requireActiveStreamJournalAppendLease(
  value: unknown,
  identity: StreamJournalWriterAuthority,
): ActiveFencedStreamLease {
  let lease: StreamLeaseRow
  try {
    lease = requireStreamLeaseRow(value)
  } catch {
    throw new Error(`StreamFenceLost:${identity.streamId}`)
  }
  if (
    lease.phase !== 'active' ||
    !streamLeaseHasWriteFence(lease) ||
    !sameStreamJournalWriterAuthority(streamJournalWriterAuthority(lease), identity)
  ) {
    throw new Error(`StreamFenceLost:${identity.streamId}`)
  }
  return lease
}

function streamJournalAdvanceInvariantError(streamId: string, reason: string): Error {
  return new Error(`StreamJournalAdvanceInvariantError:${streamId}:${reason}`)
}

function saturatingAdd(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right)
}
