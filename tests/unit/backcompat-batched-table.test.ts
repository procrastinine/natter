import Dexie from 'dexie'
import { afterEach, describe, expect, it } from 'vitest'
import { forEachTableBatch } from '../../src/backcompat/batched-table'

interface Row {
  id: string
  value: number
}

const names = new Set<string>()

function databaseName(label: string): string {
  const name = `natter-test-${label}-${Math.random().toString(36).slice(2)}`
  names.add(name)
  return name
}

afterEach(async () => {
  for (const name of names) await Dexie.delete(name)
  names.clear()
})

describe('bounded backcompat table scans', () => {
  it('rolls back every completed batch on failure, retries atomically, and does not rescan', async () => {
    const name = databaseName('bounded-atomicity')
    const legacy = new Dexie(name)
    legacy.version(1).stores({ rows: '&id' })
    await legacy.open()
    await legacy
      .table<Row, string>('rows')
      .bulkPut(Array.from({ length: 7 }, (_, index) => ({ id: `row-${index}`, value: 0 })))
    legacy.close()

    const attempted = new Dexie(name)
    attempted.version(1).stores({ rows: '&id' })
    attempted
      .version(2)
      .stores({ rows: '&id' })
      .upgrade(async (tx) => {
        const rows = tx.table<Row, string>('rows')
        await forEachTableBatch(
          rows,
          async (batch) => {
            await rows.bulkPut(batch.map((row) => ({ ...row, value: 1 })))
            if (batch.some((row) => row.id === 'row-3')) throw new Error('SyntheticUpgradeFailure')
          },
          2,
        )
      })
    await expect(attempted.open()).rejects.toThrow('SyntheticUpgradeFailure')
    attempted.close()

    const inspection = new Dexie(name)
    inspection.version(1).stores({ rows: '&id' })
    await inspection.open()
    expect(inspection.verno).toBe(1)
    expect((await inspection.table<Row, string>('rows').toArray()).map((row) => row.value)).toEqual(
      Array(7).fill(0),
    )
    inspection.close()

    let upgradeRuns = 0
    const retried = new Dexie(name)
    retried.version(1).stores({ rows: '&id' })
    retried
      .version(2)
      .stores({ rows: '&id' })
      .upgrade(async (tx) => {
        upgradeRuns += 1
        const rows = tx.table<Row, string>('rows')
        await forEachTableBatch(
          rows,
          async (batch) => {
            await rows.bulkPut(batch.map((row) => ({ ...row, value: 2 })))
          },
          2,
        )
      })
    await retried.open()
    expect((await retried.table<Row, string>('rows').toArray()).map((row) => row.value)).toEqual(
      Array(7).fill(2),
    )
    retried.close()
    await retried.open()
    expect(upgradeRuns).toBe(1)
    retried.close()
  })
})
