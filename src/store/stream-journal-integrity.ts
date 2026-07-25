import Dexie, { type Table } from 'dexie'
import { recordBrowserCommandBackfillSettingMutation } from './browser-command-mutation-journal'
import { recordObsoleteByteOwnerValues } from './byte-owner-mutation'
import type { SettingsRow } from './db-rows'
import {
  type CapabilityTables,
  type FencedTransaction,
  physicalStorageTables,
} from './physical-storage-tables'
import type { StreamJournalFrameRow, StreamLeaseRow } from './repository'
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

export class StreamJournalIntegrityPlanChangedError extends Error {}

export interface StreamJournalIntegrityResult {
  readonly scannedStreamIds: number
  readonly deletedStreamIds: readonly string[]
  readonly deletedFrames: number
  readonly done: boolean
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

export async function readStreamJournalIntegrityPlan(source: {
  table<Row, Key>(name: string): { get(key: Key): Promise<Row | undefined> }
}): Promise<StreamJournalIntegrityPlan> {
  const row = await source
    .table<SettingsRow, string>('settings')
    .get(STREAM_JOURNAL_INTEGRITY_SETTING_KEY)
  return streamJournalIntegrityPlan(parseStreamJournalIntegrityState(row?.value))
}

export async function reconcileStreamJournalIntegrityPage(
  tx: StreamJournalIntegrityTransaction,
  requestedLimit: number,
  expectedPlan: Exclude<StreamJournalIntegrityPlan, { kind: 'complete' }>,
): Promise<StreamJournalIntegrityResult> {
  const limit = Math.max(1, Math.min(128, Math.floor(requestedLimit)))
  const settings = tx.table<SettingsRow, string>('settings')
  const row = await settings.get(STREAM_JOURNAL_INTEGRITY_SETTING_KEY)
  if (!row) throw new Error('StreamJournalIntegrityStateInvalid')
  const state = parseStreamJournalIntegrityState(row.value)
  if (!sameStreamJournalIntegrityPlan(streamJournalIntegrityPlan(state), expectedPlan)) {
    throw new StreamJournalIntegrityPlanChangedError()
  }
  if (expectedPlan.kind === 'retire') {
    if (
      state.phase !== 'retiring' ||
      state.streamId !== expectedPlan.streamId ||
      state.completeAfterRetirement !== expectedPlan.completeAfterRetirement
    ) {
      throw new StreamJournalIntegrityPlanChangedError()
    }
    const retired = await retireStreamJournalOwnershipPage(tx, {
      kind: 'lease-absent-stream',
      streamId: state.streamId,
    })
    if (retired.outcome === 'ineligible' && retired.reason !== 'lease-present') {
      throw new Error(`StreamJournalIntegrityRetirementInvalid:${state.streamId}`)
    }
    if (retired.outcome === 'progress') {
      return {
        scannedStreamIds: 0,
        deletedStreamIds: [],
        deletedFrames: retired.deletedFrames,
        done: false,
      }
    }
    const done = state.completeAfterRetirement === true
    await writeStreamJournalIntegrityState(
      tx,
      settings,
      row,
      done
        ? completedStreamJournalIntegrityState()
        : pendingStreamJournalIntegrityState(state.streamId),
    )
    return {
      scannedStreamIds: 0,
      deletedStreamIds:
        retired.outcome === 'complete' && retired.deletedFrames > 0 ? [state.streamId] : [],
      deletedFrames: retired.deletedFrames,
      done,
    }
  }
  const streamIds = (await tx
    .table<StreamJournalFrameRow, string>('streamChunks')
    .where('streamId')
    .above(expectedPlan.afterStreamId ?? Dexie.minKey)
    .limit(limit)
    .uniqueKeys()) as string[]
  const leases = await tx.table<StreamLeaseRow, string>('streamLeases').bulkGet(streamIds)
  const orphanIndex = leases.findIndex((lease) => lease === undefined)
  if (orphanIndex >= 0) {
    const streamId = streamIds[orphanIndex]
    if (!streamId) throw new Error('StreamJournalIntegrityStreamIdMissing')
    await writeStreamJournalIntegrityState(tx, settings, row, {
      version: STREAM_JOURNAL_INTEGRITY_VERSION,
      phase: 'retiring',
      streamId,
      completeAfterRetirement: orphanIndex === streamIds.length - 1 && streamIds.length < limit,
    })
    return {
      scannedStreamIds: orphanIndex + 1,
      deletedStreamIds: [],
      deletedFrames: 0,
      done: false,
    }
  }
  const done = streamIds.length < limit
  await writeStreamJournalIntegrityState(
    tx,
    settings,
    row,
    done
      ? completedStreamJournalIntegrityState()
      : pendingStreamJournalIntegrityState(streamIds.at(-1)),
  )
  return {
    scannedStreamIds: streamIds.length,
    deletedStreamIds: [],
    deletedFrames: 0,
    done,
  }
}

async function writeStreamJournalIntegrityState(
  tx: StreamJournalIntegrityTransaction,
  settings: Table<SettingsRow, string>,
  previous: SettingsRow,
  state: StreamJournalIntegrityState,
): Promise<void> {
  await recordObsoleteByteOwnerValues(tx, [previous])
  await settings.put({ key: STREAM_JOURNAL_INTEGRITY_SETTING_KEY, value: state })
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

function sameStreamJournalIntegrityPlan(
  left: StreamJournalIntegrityPlan,
  right: StreamJournalIntegrityPlan,
): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'complete' || right.kind === 'complete') return true
  if (left.kind === 'retire' && right.kind === 'retire') {
    return (
      left.streamId === right.streamId &&
      left.completeAfterRetirement === right.completeAfterRetirement
    )
  }
  return left.kind === 'scan' && right.kind === 'scan' && left.afterStreamId === right.afterStreamId
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
