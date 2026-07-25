import Dexie from 'dexie'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createBoundedBatchWriter,
  forEachBoundedIdbCursorPage,
  forEachBoundedIdbKeyedPairPage,
} from '../../src/store/bounded-idb-cursor'

interface CursorRow {
  readonly id: string
  readonly group: string
  readonly bytes: number
}

const databaseNames: string[] = []

afterEach(async () => {
  await Promise.all(databaseNames.splice(0).map((name) => Dexie.delete(name)))
})

describe('bounded IndexedDB cursor', () => {
  it('bounds rows and bytes, admits one oversized row, and supports index cursors', async () => {
    const name = `bounded-idb-cursor-${crypto.randomUUID()}`
    databaseNames.push(name)
    const db = new Dexie(name)
    db.version(1).stores({ rows: '&id, group', observations: '&id' })
    await db.open()
    const rows = db.table<CursorRow, string>('rows')
    await rows.bulkPut([
      { id: 'a', group: 'x', bytes: 4 },
      { id: 'b', group: 'x', bytes: 5 },
      { id: 'c', group: 'x', bytes: 20 },
      { id: 'd', group: 'x', bytes: 3 },
      { id: 'e', group: 'y', bytes: 3 },
    ])

    const pages: Array<{
      ids: string[]
      keys: IDBValidKey[]
      primaryKeys: IDBValidKey[]
      bytes: number
    }> = []
    await db.transaction('rw', db.table('rows'), db.table('observations'), async (tx) => {
      const source = tx.idbtrans.objectStore('rows').index('group')
      await forEachBoundedIdbCursorPage<CursorRow>(
        source,
        {
          maxRows: 2,
          maxBytes: 10,
          query: IDBKeyRange.only('x'),
          operation: 'test',
          estimateBytes: (row) => row.bytes,
        },
        async (page) => {
          pages.push({
            ids: page.entries.map((entry) => entry.value.id),
            keys: page.entries.map((entry) => entry.key),
            primaryKeys: page.entries.map((entry) => entry.primaryKey),
            bytes: page.estimatedBytes,
          })
          await tx.table('observations').put({ id: String(pages.length) })
        },
      )
    })

    expect(pages).toEqual([
      { ids: ['a', 'b'], keys: ['x', 'x'], primaryKeys: ['a', 'b'], bytes: 9 },
      { ids: ['c'], keys: ['x'], primaryKeys: ['c'], bytes: 20 },
      { ids: ['d'], keys: ['x'], primaryKeys: ['d'], bytes: 3 },
    ])
    expect(await db.table('observations').count()).toBe(3)
    db.close()
  })

  it('rejects an estimator failure instead of leaving the cursor reader pending', async () => {
    const name = `bounded-idb-cursor-${crypto.randomUUID()}`
    databaseNames.push(name)
    const db = new Dexie(name)
    db.version(1).stores({ rows: '&id' })
    await db.open()
    await db.table('rows').put({ id: 'a', group: 'x', bytes: 1 })

    await expect(
      db.transaction('r', db.table('rows'), async (tx) => {
        await forEachBoundedIdbCursorPage<CursorRow>(
          tx.idbtrans.objectStore('rows'),
          {
            maxRows: 1,
            maxBytes: 1,
            operation: 'throwing-estimator',
            estimateBytes: () => {
              throw new Error('estimate failed')
            },
          },
          async () => undefined,
        )
      }),
    ).rejects.toThrow('estimate failed')
    db.close()
  })

  it('hands off an exhausted cursor exactly once for empty and nonempty sources', async () => {
    const name = `bounded-idb-cursor-${crypto.randomUUID()}`
    databaseNames.push(name)
    const db = new Dexie(name)
    db.version(1).stores({ rows: '&id', observations: '&id' })
    await db.open()

    for (const [id, rows] of [
      ['empty', []],
      ['nonempty', [{ id: 'a', group: 'x', bytes: 1 }]],
    ] as const) {
      await db.table('rows').clear()
      if (rows.length > 0) await db.table('rows').bulkPut(rows)
      let handoffs = 0
      await db.transaction('rw', db.table('rows'), db.table('observations'), async (tx) => {
        await forEachBoundedIdbCursorPage<CursorRow>(
          tx.idbtrans.objectStore('rows'),
          {
            maxRows: 1,
            maxBytes: 1,
            operation: `handoff-${id}`,
            estimateBytes: (row) => row.bytes,
            onFinalPageVisited: () => {
              handoffs += 1
              void tx.table('observations').put({ id })
            },
          },
          async () => undefined,
        )
      })
      expect(handoffs).toBe(1)
      expect(await db.table('observations').get(id)).toEqual({ id })
    }
    db.close()
  })

  it('bounds output pages and writes one oversized row alone', async () => {
    const pages: CursorRow[][] = []
    const writer = createBoundedBatchWriter<CursorRow>({
      maxRows: 2,
      maxBytes: 10,
      operation: 'test-output',
      estimateBytes: (row) => row.bytes,
      write: async (rows) => {
        pages.push([...rows])
      },
    })
    for (const row of [
      { id: 'a', group: 'x', bytes: 4 },
      { id: 'b', group: 'x', bytes: 5 },
      { id: 'c', group: 'x', bytes: 20 },
      { id: 'd', group: 'x', bytes: 3 },
    ]) {
      await writer.add(row)
    }
    await writer.flush()

    expect(pages.map((page) => page.map((row) => row.id))).toEqual([['a', 'b'], ['c'], ['d']])
  })

  it('merge-joins two stores once with bounded pages and unmatched rows', async () => {
    const name = `bounded-idb-cursor-${crypto.randomUUID()}`
    databaseNames.push(name)
    const db = new Dexie(name)
    db.version(1).stores({ left: '&id', right: '&id' })
    await db.open()
    await db.table('left').bulkPut([
      { id: 'a', group: 'x', bytes: 4 },
      { id: 'c', group: 'x', bytes: 20 },
    ])
    await db.table('right').bulkPut([
      { id: 'b', group: 'x', bytes: 5 },
      { id: 'c', group: 'x', bytes: 3 },
    ])

    const pages: Array<Array<[IDBValidKey, string | undefined, string | undefined]>> = []
    await db.transaction('r', db.table('left'), db.table('right'), async (tx) => {
      await forEachBoundedIdbKeyedPairPage<CursorRow, CursorRow>(
        tx.idbtrans.objectStore('left'),
        tx.idbtrans.objectStore('right'),
        {
          maxRows: 2,
          maxBytes: 10,
          operation: 'pair',
          estimateLeftBytes: (row) => row.bytes,
          estimateRightBytes: (row) => row.bytes,
        },
        async (page) => {
          pages.push(
            page.entries.map((entry) => [entry.key, entry.left?.value.id, entry.right?.value.id]),
          )
        },
      )
    })

    expect(pages).toEqual([
      [
        ['a', 'a', undefined],
        ['b', undefined, 'b'],
      ],
      [['c', 'c', 'c']],
    ])
    db.close()
  })
})
