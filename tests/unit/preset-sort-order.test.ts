import Dexie from 'dexie'
import { afterEach, describe, expect, it } from 'vitest'
import {
  migrateLegacyPresetSortOrder,
  PRESET_SORT_MIGRATION_INDEX,
  type PresetSortMigrationStats,
} from '../../src/backcompat/preset-sort-order'

interface LegacyPresetRow {
  id: string
  createdAt: number
  sortIndex?: number
  migrationV19SortValue?: number
}

const names = new Set<string>()

afterEach(async () => {
  for (const name of names) await Dexie.delete(name)
  names.clear()
})

describe('v19 preset sort-order migration', () => {
  it('matches the prior global comparator while bounding every materialized batch', async () => {
    const name = databaseName('large')
    const rows = Array.from(
      { length: 1_041 },
      (_, index): LegacyPresetRow => ({
        id: generatedId(index),
        createdAt: (index * 37) % 29,
        ...(index % 4 === 0 ? {} : { sortIndex: (index * 13) % 11 }),
      }),
    )
    const expected = [...rows].sort(compareLegacyPresetOrder).map((row) => row.id)

    const legacy = new Dexie(name)
    legacy.version(1).stores({ presets: 'id' })
    await legacy.open()
    await legacy.table<LegacyPresetRow, string>('presets').bulkPut([...rows].reverse())
    legacy.close()

    let stats: PresetSortMigrationStats | undefined
    const migrated = migrationDatabase(name, async (table) => {
      stats = await migrateLegacyPresetSortOrder(table, 17)
    })
    await migrated.open()

    const stored = await migrated.table<LegacyPresetRow, string>('presets').toArray()
    const ordered = [...stored].sort((left, right) => sortIndexOf(left) - sortIndexOf(right))
    expect(ordered.map((row) => row.id)).toEqual(expected)
    expect(ordered.map((row) => row.sortIndex)).toEqual(
      Array.from({ length: rows.length }, (_, index) => index),
    )
    expect(stored.every((row) => row.migrationV19SortValue === undefined)).toBe(true)
    expect(migrated.table('presets').schema.indexes.map((index) => index.src)).not.toContain(
      PRESET_SORT_MIGRATION_INDEX,
    )
    expect(stats).toEqual({
      prepare: { rowCount: 1_041, batchCount: 62, maxBatchSize: 17 },
      order: { rowCount: 1_041, batchCount: 62, maxBatchSize: 17 },
      cleanup: { rowCount: 1_041, batchCount: 62, maxBatchSize: 17 },
    })
    migrated.close()
  }, 15_000)

  it('rolls completed batches back on poison, then retries once without rerunning after reopen', async () => {
    const name = databaseName('rollback')
    const original = Array.from(
      { length: 7 },
      (_, index): LegacyPresetRow => ({
        id: generatedId(index),
        createdAt: index === 5 ? Number.NaN : 20 - index,
      }),
    )
    const legacy = new Dexie(name)
    legacy.version(1).stores({ presets: 'id' })
    await legacy.open()
    await legacy.table<LegacyPresetRow, string>('presets').bulkPut(original)
    legacy.close()

    const attempted = migrationDatabase(name, async (table) => {
      await migrateLegacyPresetSortOrder(table, 2)
    })
    await expect(attempted.open()).rejects.toThrow('LegacyPresetCreatedAtInvalid')
    attempted.close()

    const inspection = new Dexie(name)
    inspection.version(1).stores({ presets: 'id' })
    await inspection.open()
    const afterFailure = await inspection.table<LegacyPresetRow, string>('presets').toArray()
    expect(afterFailure.every((row) => row.sortIndex === undefined)).toBe(true)
    expect(afterFailure.every((row) => row.migrationV19SortValue === undefined)).toBe(true)
    await inspection.table<LegacyPresetRow, string>('presets').update(generatedId(5), {
      createdAt: 15,
    })
    inspection.close()

    let upgradeRuns = 0
    const retried = migrationDatabase(name, async (table) => {
      upgradeRuns += 1
      await migrateLegacyPresetSortOrder(table, 2)
    })
    await retried.open()
    expect(upgradeRuns).toBe(1)
    expect(
      (await retried.table<LegacyPresetRow, string>('presets').toArray())
        .sort((left, right) => sortIndexOf(left) - sortIndexOf(right))
        .map((row) => row.sortIndex),
    ).toEqual(Array.from({ length: original.length }, (_, index) => index))
    retried.close()
    await retried.open()
    expect(upgradeRuns).toBe(1)
    retried.close()
  })
})

function migrationDatabase(
  name: string,
  upgrade: (table: Dexie.Table<LegacyPresetRow, string>) => void | Promise<void>,
): Dexie {
  const db = new Dexie(name)
  db.version(1).stores({ presets: 'id' })
  db.version(2)
    .stores({ presets: `id, sortIndex, ${PRESET_SORT_MIGRATION_INDEX}` })
    .upgrade((tx) => upgrade(tx.table<LegacyPresetRow, string>('presets')))
  db.version(3).stores({ presets: 'id, sortIndex' })
  return db
}

function databaseName(label: string): string {
  const name = `natter-test-preset-sort-${label}-${Math.random().toString(36).slice(2)}`
  names.add(name)
  return name
}

function generatedId(index: number): string {
  return index.toString().padStart(26, '0')
}

function compareLegacyPresetOrder(left: LegacyPresetRow, right: LegacyPresetRow): number {
  const leftSort = finiteSortIndexOrCreatedAt(left)
  const rightSort = finiteSortIndexOrCreatedAt(right)
  const bySort = leftSort - rightSort
  if (bySort !== 0) return bySort
  const byCreatedAt = left.createdAt - right.createdAt
  return byCreatedAt !== 0 ? byCreatedAt : left.id.localeCompare(right.id)
}

function finiteSortIndexOrCreatedAt(row: LegacyPresetRow): number {
  return typeof row.sortIndex === 'number' && Number.isFinite(row.sortIndex)
    ? row.sortIndex
    : row.createdAt
}

function sortIndexOf(row: LegacyPresetRow): number {
  return row.sortIndex as number
}
