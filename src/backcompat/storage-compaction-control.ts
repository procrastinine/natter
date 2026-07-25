import {
  BROWSER_WORKSPACE_COMPACTION_MIN_RECLAIMABLE_BYTES,
  migrateBrowserWorkspaceCompactionState,
  readExistingIndexedDb,
} from '../store/browser-workspace-database-control'
import type { SettingsRow } from '../store/db-rows'

export const LEGACY_STORAGE_COMPACTION_STATE_KEY = 'storage-compaction-state-v1'
const STORAGE_COMPACTION_CONTROL_BACKFILL_KEY = 'backfill:storage-compaction-control-v1'

interface LegacyStorageCompactionStateV2 {
  readonly formatVersion: 2
  readonly knownReclaimableBytes: number
  readonly lastCompactedLiveBytes: number
  readonly requestRevision: number
  readonly completedRevision: number
}

export function storageCompactionControlBackfillMarker(): SettingsRow {
  return { key: STORAGE_COMPACTION_CONTROL_BACKFILL_KEY, value: true }
}

export async function prepareStorageCompactionStateControlTransfer(
  databaseName: string,
): Promise<boolean> {
  const row = await readLegacyCompactionStateRow(databaseName)
  if (!row) return false
  await migrateBrowserWorkspaceCompactionState(databaseName, legacyStateFromUnknown(row.value))
  return true
}

function legacyStateFromUnknown(value: unknown): LegacyStorageCompactionStateV2 {
  if (!value || typeof value !== 'object') return conservativeLegacyState()
  const candidate = value as Partial<Record<keyof LegacyStorageCompactionStateV2, unknown>>
  if (
    candidate.formatVersion === 1 &&
    isNonNegativeSafeInteger(candidate.knownReclaimableBytes) &&
    isNonNegativeSafeInteger(candidate.lastCompactedLiveBytes) &&
    isNonNegativeSafeInteger(candidate.requestRevision)
  ) {
    return {
      formatVersion: 2,
      knownReclaimableBytes: candidate.knownReclaimableBytes,
      lastCompactedLiveBytes: candidate.lastCompactedLiveBytes,
      requestRevision: candidate.requestRevision,
      completedRevision: 0,
    }
  }
  if (
    candidate.formatVersion !== 2 ||
    !isNonNegativeSafeInteger(candidate.knownReclaimableBytes) ||
    !isNonNegativeSafeInteger(candidate.lastCompactedLiveBytes) ||
    !isNonNegativeSafeInteger(candidate.requestRevision) ||
    !isNonNegativeSafeInteger(candidate.completedRevision) ||
    candidate.completedRevision > candidate.requestRevision
  ) {
    return conservativeLegacyState()
  }
  return {
    formatVersion: 2,
    knownReclaimableBytes: candidate.knownReclaimableBytes,
    lastCompactedLiveBytes: candidate.lastCompactedLiveBytes,
    requestRevision: candidate.requestRevision,
    completedRevision: candidate.completedRevision,
  }
}

async function readLegacyCompactionStateRow(
  databaseName: string,
): Promise<SettingsRow | undefined> {
  const row = await readExistingIndexedDb<SettingsRow | undefined>(databaseName, (database) => {
    if (!database.objectStoreNames.contains('settings')) {
      return { kind: 'value', value: undefined }
    }
    return {
      kind: 'transaction',
      storeNames: ['settings'],
      read: (transaction) =>
        new Promise<SettingsRow | undefined>((resolve, reject) => {
          const get = transaction.objectStore('settings').get(LEGACY_STORAGE_COMPACTION_STATE_KEY)
          get.onsuccess = () => {
            const value: unknown = get.result
            resolve(value && typeof value === 'object' ? (value as SettingsRow) : undefined)
          }
          get.onerror = () =>
            reject(get.error ?? new Error('StorageCompactionControlPreflightReadFailed'))
        }),
    }
  })
  return row ?? undefined
}

function conservativeLegacyState(): LegacyStorageCompactionStateV2 {
  return {
    formatVersion: 2,
    knownReclaimableBytes: BROWSER_WORKSPACE_COMPACTION_MIN_RECLAIMABLE_BYTES,
    lastCompactedLiveBytes: 0,
    requestRevision: 1,
    completedRevision: 0,
  }
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}
