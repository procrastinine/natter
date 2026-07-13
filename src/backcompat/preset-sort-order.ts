import type { Table } from 'dexie'
import { BACKCOMPAT_BATCH_SIZE, type BatchScanStats, forEachTableBatch } from './batched-table'

export const PRESET_SORT_MIGRATION_INDEX = '[migrationV19SortValue+createdAt+id]'

interface LegacyPresetSortRow {
  id: string
  createdAt: number
  sortIndex?: unknown
  migrationV19SortValue?: number
}

type PresetMigrationOrderKey = readonly [number, number, string]

export interface PresetSortMigrationStats {
  prepare: BatchScanStats
  order: BatchScanStats
  cleanup: BatchScanStats
}

export async function migrateLegacyPresetSortOrder<T extends LegacyPresetSortRow>(
  table: Table<T, string>,
  batchSize = BACKCOMPAT_BATCH_SIZE,
): Promise<PresetSortMigrationStats> {
  const prepare = await forEachTableBatch(
    table,
    async (rows) => {
      await table.bulkPut(
        rows.map((row) => ({
          ...row,
          migrationV19SortValue: legacySortValue(row),
        })),
      )
    },
    batchSize,
  )

  let nextSortIndex = 0
  const order = await forEachMigrationOrderBatch(
    table,
    async (rows) => {
      await table.bulkPut(
        rows.map((row) => ({
          ...row,
          sortIndex: nextSortIndex++,
        })),
      )
    },
    batchSize,
  )
  if (order.rowCount !== prepare.rowCount) throw new Error('LegacyPresetSortProjectionIncomplete')

  const cleanup = await forEachTableBatch(
    table,
    async (rows) => {
      await table.bulkPut(
        rows.map((row) => {
          const current: LegacyPresetSortRow = { ...row }
          delete current.migrationV19SortValue
          return current as T
        }),
      )
    },
    batchSize,
  )

  return { prepare, order, cleanup }
}

async function forEachMigrationOrderBatch<T extends LegacyPresetSortRow>(
  table: Table<T, string>,
  visit: (rows: readonly T[]) => void | Promise<void>,
  batchSize: number,
): Promise<BatchScanStats> {
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new RangeError('BackcompatBatchSizeInvalid')
  }

  let after: PresetMigrationOrderKey | undefined
  const stats: BatchScanStats = { rowCount: 0, batchCount: 0, maxBatchSize: 0 }
  for (;;) {
    const collection =
      after === undefined
        ? table.orderBy(PRESET_SORT_MIGRATION_INDEX)
        : table.where(PRESET_SORT_MIGRATION_INDEX).above(after)
    const rows = await collection.limit(batchSize).toArray()
    if (rows.length === 0) return stats

    stats.rowCount += rows.length
    stats.batchCount += 1
    stats.maxBatchSize = Math.max(stats.maxBatchSize, rows.length)
    await visit(rows)
    if (rows.length < batchSize) return stats
    after = migrationOrderKey(rows.at(-1) as T)
  }
}

function legacySortValue(row: LegacyPresetSortRow): number {
  if (typeof row.id !== 'string') throw new Error('LegacyPresetIdInvalid')
  if (!Number.isFinite(row.createdAt)) throw new Error('LegacyPresetCreatedAtInvalid')
  return typeof row.sortIndex === 'number' && Number.isFinite(row.sortIndex)
    ? row.sortIndex
    : row.createdAt
}

function migrationOrderKey(row: LegacyPresetSortRow): PresetMigrationOrderKey {
  const migrationSortValue = row.migrationV19SortValue
  if (typeof migrationSortValue !== 'number' || !Number.isFinite(migrationSortValue)) {
    throw new Error('LegacyPresetSortValueMissing')
  }
  if (!Number.isFinite(row.createdAt)) throw new Error('LegacyPresetCreatedAtInvalid')
  if (typeof row.id !== 'string') throw new Error('LegacyPresetIdInvalid')
  // v19 preset IDs came from the app's Crockford-uppercase ULID generator. IndexedDB string
  // ordering and the old localeCompare tiebreak agree over that alphabet.
  return [migrationSortValue, row.createdAt, row.id]
}
