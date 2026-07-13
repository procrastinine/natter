import type { IndexableType, Table } from 'dexie'

export const BACKCOMPAT_BATCH_SIZE = 128

export interface BatchScanStats {
  rowCount: number
  batchCount: number
  maxBatchSize: number
}

export async function forEachTableBatch<T, TKey extends IndexableType>(
  table: Table<T, TKey>,
  visit: (rows: readonly T[]) => void | Promise<void>,
  batchSize = BACKCOMPAT_BATCH_SIZE,
): Promise<BatchScanStats> {
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new RangeError('BackcompatBatchSizeInvalid')
  }

  let after: TKey | undefined
  const stats: BatchScanStats = { rowCount: 0, batchCount: 0, maxBatchSize: 0 }
  for (;;) {
    const rows: T[] = []
    let lastPrimaryKey: TKey | undefined
    const collection = after === undefined ? table.orderBy(':id') : table.where(':id').above(after)
    await collection.limit(batchSize).each((row, cursor) => {
      rows.push(row)
      lastPrimaryKey = cursor.primaryKey
    })
    if (rows.length === 0) return stats

    stats.rowCount += rows.length
    stats.batchCount += 1
    stats.maxBatchSize = Math.max(stats.maxBatchSize, rows.length)
    await visit(rows)
    if (rows.length < batchSize) return stats
    if (lastPrimaryKey === undefined) throw new Error('BackcompatPrimaryKeyMissing')
    after = lastPrimaryKey
  }
}
