import Dexie from 'dexie'
import { recordBrowserCommandBackfillSettingMutation } from './browser-command-mutation-journal'
import { putPhysicalStorageRow } from './byte-owner-mutation'
import type { SettingsRow } from './db-rows'
import {
  type CapabilityTables,
  type FencedTransaction,
  physicalStorageTables,
} from './physical-storage-tables'
import type { StreamJournalFrameRow, StreamLeaseRow } from './repository'
import {
  createSemanticOperationExactReceiptAccumulator,
  type SemanticOperationExactReceiptAccumulator,
  type SemanticOperationReceiptFragment,
  type SemanticOperationReplayPlan,
} from './semantic-operation-capability'
import { retireStreamJournalOwnershipPage } from './stream-journal-storage'

export const STREAM_JOURNAL_INTEGRITY_SETTING_KEY = 'backfill:stream-journal-integrity-v1'
export const STREAM_JOURNAL_INTEGRITY_TRANSACTION_CAPABILITY = physicalStorageTables(
  'settings',
  'streamLeases',
  'streamChunks',
)
type StreamJournalIntegrityTransaction = FencedTransaction<
  CapabilityTables<typeof STREAM_JOURNAL_INTEGRITY_TRANSACTION_CAPABILITY>
>
const STREAM_JOURNAL_INTEGRITY_VERSION = 1

interface StreamJournalIntegrityState {
  readonly version: typeof STREAM_JOURNAL_INTEGRITY_VERSION
  readonly phase: 'pending' | 'complete' | 'retiring'
  readonly afterStreamId?: string
  readonly streamId?: string
  readonly completeAfterRetirement?: boolean
}

export type StreamJournalIntegrityPlan =
  | { readonly kind: 'complete' }
  | { readonly kind: 'scan'; readonly afterStreamId?: string }
  | {
      readonly kind: 'retire'
      readonly streamId: string
      readonly completeAfterRetirement: boolean
    }

export interface StreamJournalIntegrityResult {
  readonly scannedStreamIds: number
  readonly deletedStreamIds: readonly string[]
  readonly deletedFrames: number
  readonly done: boolean
}

export interface StreamJournalIntegrityTransition {
  readonly result: StreamJournalIntegrityResult
  readonly replay: SemanticOperationReplayPlan
  readonly receipt: SemanticOperationReceiptFragment<'settings' | 'streamLeases' | 'streamChunks'>
}

export function completedStreamJournalIntegritySetting(): SettingsRow {
  return {
    key: STREAM_JOURNAL_INTEGRITY_SETTING_KEY,
    value: completedStreamJournalIntegrityState(),
  }
}

export function pendingStreamJournalIntegritySetting(): SettingsRow {
  return {
    key: STREAM_JOURNAL_INTEGRITY_SETTING_KEY,
    value: pendingStreamJournalIntegrityState(),
  }
}

export async function reconcileStreamJournalIntegrityPage(
  tx: StreamJournalIntegrityTransaction,
  requestedLimit: number,
): Promise<StreamJournalIntegrityTransition> {
  const limit = Math.max(1, Math.min(128, Math.floor(requestedLimit)))
  const receipt = createSemanticOperationExactReceiptAccumulator<
    'settings' | 'streamLeases' | 'streamChunks'
  >()
  const settings = tx.table<SettingsRow, string>('settings')
  const row = await settings.get(STREAM_JOURNAL_INTEGRITY_SETTING_KEY)
  if (!row) throw new Error('StreamJournalIntegrityStateInvalid')
  receipt.physicalRead({
    tableName: 'settings',
    indexKind: 'primary',
    operation: 'get',
    requestCount: 1,
    rowCount: 1,
  })
  const state = parseStreamJournalIntegrityState(row.value)
  const expectedPlan = streamJournalIntegrityPlan(state)
  if (expectedPlan.kind === 'complete') {
    return streamJournalIntegrityTransition(
      state,
      limit,
      {
        scannedStreamIds: 0,
        deletedStreamIds: [],
        deletedFrames: 0,
        done: true,
      },
      receipt,
    )
  }
  if (expectedPlan.kind === 'retire') {
    if (
      state.phase !== 'retiring' ||
      state.streamId !== expectedPlan.streamId ||
      state.completeAfterRetirement !== expectedPlan.completeAfterRetirement
    ) {
      throw new Error(`StreamJournalIntegrityStateInvalid:${state.streamId ?? 'missing-stream'}`)
    }
    const retired = await retireStreamJournalOwnershipPage(tx, {
      kind: 'lease-absent-stream',
      streamId: state.streamId,
      maxFrameRows: limit,
    })
    if (retired.kind !== 'single-stream') throw new Error('StreamJournalIntegrityReceiptMissing')
    receipt.absorb(retired.receipt)
    if (retired.result.outcome === 'ineligible' && retired.result.reason !== 'lease-present') {
      throw new Error(`StreamJournalIntegrityRetirementInvalid:${state.streamId}`)
    }
    if (retired.result.outcome === 'progress') {
      return streamJournalIntegrityTransition(
        state,
        limit,
        {
          scannedStreamIds: 0,
          deletedStreamIds: [],
          deletedFrames: retired.result.deletedFrames,
          done: false,
        },
        receipt,
      )
    }
    const done = state.completeAfterRetirement === true
    await writeStreamJournalIntegrityState(
      tx,
      row,
      done
        ? completedStreamJournalIntegrityState()
        : pendingStreamJournalIntegrityState(state.streamId),
    )
    receipt.physicalMutation({
      tableName: 'settings',
      operation: 'write',
      key: STREAM_JOURNAL_INTEGRITY_SETTING_KEY,
    })
    return streamJournalIntegrityTransition(
      state,
      limit,
      {
        scannedStreamIds: 0,
        deletedStreamIds:
          retired.result.outcome === 'complete' && retired.result.deletedFrames > 0
            ? [state.streamId]
            : [],
        deletedFrames: retired.result.deletedFrames,
        done,
      },
      receipt,
    )
  }
  const streamIds = (await tx
    .table<StreamJournalFrameRow, string>('streamChunks')
    .where('streamId')
    .above(expectedPlan.afterStreamId ?? Dexie.minKey)
    .limit(limit)
    .uniqueKeys()) as string[]
  receipt.physicalRead({
    tableName: 'streamChunks',
    indexKind: 'secondary',
    indexName: 'streamId',
    operation: 'open-cursor',
    requestCount: 1,
    rowCount: streamIds.length,
  })
  const leases = await tx.table<StreamLeaseRow, string>('streamLeases').bulkGet(streamIds)
  receipt.physicalRead({
    tableName: 'streamLeases',
    indexKind: 'primary',
    operation: 'get-many',
    requestCount: 1,
    rowCount: streamIds.length,
  })
  const orphanIndex = leases.indexOf(undefined)
  if (orphanIndex >= 0) {
    const streamId = streamIds[orphanIndex]
    if (!streamId) throw new Error('StreamJournalIntegrityStreamIdMissing')
    await writeStreamJournalIntegrityState(tx, row, {
      version: STREAM_JOURNAL_INTEGRITY_VERSION,
      phase: 'retiring',
      streamId,
      completeAfterRetirement: orphanIndex === streamIds.length - 1 && streamIds.length < limit,
    })
    receipt.physicalMutation({
      tableName: 'settings',
      operation: 'write',
      key: STREAM_JOURNAL_INTEGRITY_SETTING_KEY,
    })
    return streamJournalIntegrityTransition(
      state,
      limit,
      {
        scannedStreamIds: orphanIndex + 1,
        deletedStreamIds: [],
        deletedFrames: 0,
        done: false,
      },
      receipt,
    )
  }
  const done = streamIds.length < limit
  await writeStreamJournalIntegrityState(
    tx,
    row,
    done
      ? completedStreamJournalIntegrityState()
      : pendingStreamJournalIntegrityState(streamIds.at(-1)),
  )
  receipt.physicalMutation({
    tableName: 'settings',
    operation: 'write',
    key: STREAM_JOURNAL_INTEGRITY_SETTING_KEY,
  })
  return streamJournalIntegrityTransition(
    state,
    limit,
    {
      scannedStreamIds: streamIds.length,
      deletedStreamIds: [],
      deletedFrames: 0,
      done,
    },
    receipt,
  )
}

function streamJournalIntegrityTransition(
  state: StreamJournalIntegrityState,
  limit: number,
  result: StreamJournalIntegrityResult,
  receipt: SemanticOperationExactReceiptAccumulator<'settings' | 'streamLeases' | 'streamChunks'>,
): StreamJournalIntegrityTransition {
  return Object.freeze({
    result: Object.freeze({
      ...result,
      deletedStreamIds: Object.freeze([...result.deletedStreamIds]),
    }),
    replay: streamJournalIntegrityReplayPlan(state, limit),
    receipt: receipt.sealFragment(),
  })
}

function streamJournalIntegrityReplayPlan(
  state: StreamJournalIntegrityState,
  limit: number,
): SemanticOperationReplayPlan {
  const cursor =
    state.phase === 'pending'
      ? (state.afterStreamId ?? null)
      : state.phase === 'retiring'
        ? (state.streamId ?? null)
        : null
  return {
    kind: 'durable-page-resume',
    owner: 'stream-journal-integrity',
    cycle: STREAM_JOURNAL_INTEGRITY_VERSION,
    revision: state.phase,
    cursor,
    doneMarker:
      state.phase === 'complete'
        ? 'complete'
        : state.phase === 'retiring' && state.completeAfterRetirement
          ? 'complete-after-retirement'
          : 'pending',
    limit,
  }
}

async function writeStreamJournalIntegrityState(
  tx: StreamJournalIntegrityTransaction,
  previous: SettingsRow,
  state: StreamJournalIntegrityState,
): Promise<void> {
  await putPhysicalStorageRow<SettingsRow, string>(
    tx,
    'settings',
    { key: STREAM_JOURNAL_INTEGRITY_SETTING_KEY, value: state },
    previous,
  )
  recordBrowserCommandBackfillSettingMutation(tx, STREAM_JOURNAL_INTEGRITY_SETTING_KEY)
}

function pendingStreamJournalIntegrityState(afterStreamId?: string): StreamJournalIntegrityState {
  return {
    version: STREAM_JOURNAL_INTEGRITY_VERSION,
    phase: 'pending',
    ...(afterStreamId === undefined ? {} : { afterStreamId }),
  }
}

function completedStreamJournalIntegrityState(): StreamJournalIntegrityState {
  return {
    version: STREAM_JOURNAL_INTEGRITY_VERSION,
    phase: 'complete',
  }
}

function streamJournalIntegrityPlan(
  state: StreamJournalIntegrityState,
): StreamJournalIntegrityPlan {
  if (state.phase === 'complete') return { kind: 'complete' }
  if (state.phase === 'retiring') {
    if (!state.streamId || state.completeAfterRetirement === undefined) {
      throw new Error('StreamJournalIntegrityStateInvalid')
    }
    return {
      kind: 'retire',
      streamId: state.streamId,
      completeAfterRetirement: state.completeAfterRetirement,
    }
  }
  return {
    kind: 'scan',
    ...(state.afterStreamId === undefined ? {} : { afterStreamId: state.afterStreamId }),
  }
}

function parseStreamJournalIntegrityState(value: unknown): StreamJournalIntegrityState {
  const record =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
  if (
    !record ||
    record.version !== STREAM_JOURNAL_INTEGRITY_VERSION ||
    (record.phase !== 'pending' && record.phase !== 'complete' && record.phase !== 'retiring') ||
    ('afterStreamId' in record && typeof record.afterStreamId !== 'string') ||
    (record.phase === 'pending' &&
      typeof record.afterStreamId === 'string' &&
      record.afterStreamId.length === 0) ||
    (record.phase !== 'pending' && 'afterStreamId' in record) ||
    ('streamId' in record && typeof record.streamId !== 'string') ||
    ('completeAfterRetirement' in record && typeof record.completeAfterRetirement !== 'boolean') ||
    (record.phase === 'retiring' &&
      (typeof record.streamId !== 'string' ||
        record.streamId.length === 0 ||
        typeof record.completeAfterRetirement !== 'boolean')) ||
    (record.phase !== 'retiring' && ('streamId' in record || 'completeAfterRetirement' in record))
  ) {
    throw new Error('StreamJournalIntegrityStateInvalid')
  }
  return record as unknown as StreamJournalIntegrityState
}
