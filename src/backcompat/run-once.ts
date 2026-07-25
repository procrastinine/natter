import type Dexie from 'dexie'
import type { Transaction } from 'dexie'
import type { SettingsRow } from '../store/db-rows'

export interface RunOnceBackfill {
  marker: SettingsRow
  tables: readonly string[]
  isCurrent?(tx: Transaction): boolean | Promise<boolean>
  run(tx: Transaction): void | Promise<void>
}

export async function runOnceBackfill(db: Dexie, backfill: RunOnceBackfill): Promise<boolean> {
  if (!backfill.isCurrent) {
    const stored = await db.table<SettingsRow, string>('settings').get(backfill.marker.key)
    if (Object.is(stored?.value, backfill.marker.value)) return false
  }
  const tables = [...new Set([...backfill.tables, 'settings'])]
  return db.transaction('rw', tables, (tx) => runOnceBackfillInTransaction(tx, backfill))
}

export async function runOnceBackfillInTransaction(
  tx: Transaction,
  backfill: Omit<RunOnceBackfill, 'tables'>,
): Promise<boolean> {
  const settings = tx.table<SettingsRow, string>('settings')
  const stored = await settings.get(backfill.marker.key)
  if (
    Object.is(stored?.value, backfill.marker.value) &&
    (!backfill.isCurrent || (await backfill.isCurrent(tx)))
  ) {
    return false
  }
  await backfill.run(tx)
  await settings.put(backfill.marker)
  return true
}
