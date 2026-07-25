import type { Transaction } from 'dexie'
import type { SettingsRow } from '../store/db-rows'
import { LEGACY_STORAGE_COMPACTION_STATE_KEY } from './storage-compaction-control'

interface LegacyStorageCompactionState {
  readonly formatVersion: 1
  readonly knownReclaimableBytes: number
  readonly lastCompactedLiveBytes: number
  readonly requestRevision: number
}

export async function migrateStorageCompactionStateV2(tx: Transaction): Promise<void> {
  const table = tx.table<SettingsRow, string>('settings')
  const row = await table.get(LEGACY_STORAGE_COMPACTION_STATE_KEY)
  if (!row) {
    await table.put({
      key: LEGACY_STORAGE_COMPACTION_STATE_KEY,
      value: freshState(),
    })
    return
  }
  const value = row.value as Partial<Record<keyof LegacyStorageCompactionState, unknown>> & {
    readonly completedRevision?: unknown
  }
  if (value.formatVersion === 2) return
  if (
    value.formatVersion !== 1 ||
    !isNonNegativeSafeInteger(value.knownReclaimableBytes) ||
    !isNonNegativeSafeInteger(value.lastCompactedLiveBytes) ||
    !isNonNegativeSafeInteger(value.requestRevision)
  ) {
    await table.put({
      key: LEGACY_STORAGE_COMPACTION_STATE_KEY,
      value: conservativeState(),
    })
    return
  }
  await table.put({
    key: LEGACY_STORAGE_COMPACTION_STATE_KEY,
    value: {
      formatVersion: 2,
      knownReclaimableBytes: value.knownReclaimableBytes,
      lastCompactedLiveBytes: value.lastCompactedLiveBytes,
      requestRevision: value.requestRevision,
      completedRevision: 0,
    },
  })
}

function freshState(): object {
  return {
    formatVersion: 2,
    knownReclaimableBytes: 0,
    lastCompactedLiveBytes: 0,
    requestRevision: 0,
    completedRevision: 0,
  }
}

function conservativeState(): object {
  return {
    formatVersion: 2,
    knownReclaimableBytes: 64 * 1024 * 1024,
    lastCompactedLiveBytes: 0,
    requestRevision: 1,
    completedRevision: 0,
  }
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}
