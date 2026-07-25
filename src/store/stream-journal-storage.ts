import { sameValue } from '../lib/same-value'
import {
  recordBrowserCommandOwnerInvalidation,
  recordBrowserCommandStreamJournalRetirementPage,
} from './browser-command-mutation-journal'
import { recordObsoleteByteOwnerBytes, recordObsoleteByteOwnerValues } from './byte-owner-mutation'
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
import {
  STREAM_LEASE_HEARTBEAT_COALESCE_MS,
  STREAM_LEASE_HEARTBEAT_MS,
} from './stream-lease-policy'

const STREAM_JOURNAL_DELETE_PAGE_ROWS = 64

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

export async function putStreamLeaseByteOwner(
  tx: StreamLeaseMutationTransaction,
  next: StreamLeaseRow,
  previous: StreamLeaseRow | undefined,
): Promise<void> {
  const leases = tx.table<StreamLeaseRow, string>('streamLeases')
  if (!previous) {
    await leases.add(next)
  } else {
    await recordObsoleteByteOwnerValues(tx, [previous])
    await leases.put(next)
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
): Promise<ActiveFencedStreamLease | undefined> {
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
  const existingRows = await streamFrames.bulkGet(frames.map((frame) => frame.id))
  const newFrames: CanonicalStreamJournalFrameRow[] = []
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index]
    if (!frame) continue
    const existing = existingRows[index]
    if (existing) {
      const canonicalExisting = requireCanonicalStreamJournalFrame(existing)
      if (!sameValue(canonicalExisting, frame) || frame.seq > (lease.journalMaxSeq ?? -1)) {
        throw new Error(`StreamJournalFrameConflict:${frame.streamId}:${frame.seq}`)
      }
      continue
    }
    if (frame.seq <= (lease.journalMaxSeq ?? -1)) {
      throw new Error(`StreamJournalFrameMissing:${frame.streamId}:${frame.seq}`)
    }
    newFrames.push(frame)
  }
  let previous: CanonicalStreamJournalFrameRow | undefined
  if (newFrames.length > 0 && (lease.journalMaxSeq ?? -1) >= 0) {
    const row = await streamFrames.get(streamJournalFrameId(streamId, lease.journalMaxSeq ?? 0))
    if (!row) throw streamJournalAppendInvariantError(streamId, 'previous-frame')
    previous = requireCanonicalStreamJournalFrame(row)
  }
  let appendedBytes = 0
  for (const frame of newFrames) {
    assertStreamJournalFrameTransition(previous, frame)
    previous = frame
    appendedBytes = saturatingAdd(appendedBytes, estimateStreamJournalFrameStorageBytes(frame))
  }
  const elapsed = observedAt - lease.heartbeatAt
  const renewHeartbeat =
    elapsed < 0 || elapsed >= STREAM_LEASE_HEARTBEAT_MS - STREAM_LEASE_HEARTBEAT_COALESCE_MS
  if (newFrames.length === 0 && !renewHeartbeat) return undefined
  const next = requireStreamLeaseRow({
    ...lease,
    ...(previous === undefined
      ? {}
      : {
          journalMaxSeq: previous.seq,
          journalStorageBytes: saturatingAdd(lease.journalStorageBytes ?? 0, appendedBytes),
        }),
    ...(renewHeartbeat
      ? { heartbeatAt: observedAt, revision: nextStreamLeaseRevision(lease) }
      : {}),
  })
  if (next.phase !== 'active' || next.custody === 'recovery-pending') {
    throw streamJournalAdvanceInvariantError(streamId, 'constructed-state')
  }
  await recordObsoleteByteOwnerBytes(tx, estimateStoredValueBytes(lease))
  await leases.put(next)
  if (newFrames.length > 0) await streamFrames.bulkAdd(newFrames)
  if (newFrames.length > 0) {
    recordBrowserCommandOwnerInvalidation(tx, {
      kind: 'stream-chunks',
      chatId: next.chatId,
      streamIds: [streamId],
    })
  }
  if (next.heartbeatAt !== lease.heartbeatAt || next.revision !== lease.revision) {
    recordBrowserCommandOwnerInvalidation(tx, {
      kind: 'stream-lease',
      chatId: next.chatId,
      streamIds: [streamId],
    })
  }
  return next
}

export type StreamJournalRetirementRequest =
  | {
      readonly kind: 'owned-metadata-committed'
      readonly streamId: string
      readonly fence: StreamWriteFence
    }
  | {
      readonly kind: 'retention-candidate'
      readonly streamId: string
      readonly expectedRevision: number
      readonly expectedTerminalRetentionAt: number
      readonly cutoff: number
    }
  | { readonly kind: 'lease-absent-stream'; readonly streamId: string }
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

export async function retireStreamJournalOwnershipPage(
  tx: StreamJournalMutationTransaction,
  request: StreamJournalRetirementRequest,
): Promise<StreamJournalRetirementPageResult> {
  if (request.kind === 'orphan-chat-closure') {
    return retireOrphanChatStreamJournalPage(tx, request.chatIds)
  }
  return retireOneStreamJournalPage(tx, request)
}

async function retireOneStreamJournalPage(
  tx: StreamJournalMutationTransaction,
  request: Exclude<StreamJournalRetirementRequest, { kind: 'orphan-chat-closure' }>,
): Promise<StreamJournalRetirementPageResult> {
  const { streamId } = request
  const frames = tx.table<StreamJournalFrameRow, string>('streamChunks')
  const leases = tx.table<StreamLeaseRow, string>('streamLeases')
  const [lease, rows] = await Promise.all([
    leases.get(streamId),
    frames
      .where('streamId')
      .equals(streamId)
      .limit(STREAM_JOURNAL_DELETE_PAGE_ROWS + 1)
      .toArray(),
  ])
  if (!lease && rows.length === 0) return completedStreamJournalRetirementPage()
  const ineligible = streamJournalRetirementIneligibility(request, lease, rows.length > 0)
  if (ineligible) return ineligibleStreamJournalRetirementPage(ineligible)
  const page = rows.slice(0, STREAM_JOURNAL_DELETE_PAGE_ROWS)
  const done = rows.length <= STREAM_JOURNAL_DELETE_PAGE_ROWS
  let measuredJournalBytes = 0
  const frameIds = page.map((frame) => frame.id)
  if (frameIds.length > 0) {
    recordBrowserCommandStreamJournalRetirementPage(tx, frameIds, {
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
    await frames.bulkDelete(frameIds)
  }
  const deleteLease = done && lease !== undefined && request.kind !== 'lease-absent-stream'
  if (deleteLease) await leases.delete(streamId)
  const obsoleteBytes = saturatingAdd(
    measuredJournalBytes,
    deleteLease ? estimateStoredValueBytes(lease) : 0,
  )
  await recordObsoleteByteOwnerBytes(tx, obsoleteBytes)
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
  return {
    outcome: done ? 'complete' : 'progress',
    deletedFrames: frameIds.length,
    deletedLeases: deleteLease ? 1 : 0,
    obsoleteBytes,
    done,
  } as StreamJournalRetirementPageResult
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
    .limit(STREAM_JOURNAL_DELETE_PAGE_ROWS + 1)
    .toArray()
  const page = rows.slice(0, STREAM_JOURNAL_DELETE_PAGE_ROWS)
  const done = rows.length <= STREAM_JOURNAL_DELETE_PAGE_ROWS
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
    await frames.bulkDelete(frameIds)
  }
  await recordObsoleteByteOwnerBytes(tx, obsoleteBytes)
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

function nextStreamLeaseRevision(lease: Pick<StreamLeaseRow, 'streamId' | 'revision'>): number {
  if (lease.revision >= Number.MAX_SAFE_INTEGER) {
    throw streamJournalAdvanceInvariantError(lease.streamId, 'revision-exhausted')
  }
  return lease.revision + 1
}

function saturatingAdd(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right)
}
