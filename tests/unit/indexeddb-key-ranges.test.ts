// @vitest-environment node

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import Dexie, { type EntityTable } from 'dexie'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  exactCompoundPrefixBetween,
  exactCompoundPrefixKeyRange,
  scalarCompoundIndexBetween,
  scalarCompoundIndexKeyRange,
} from '../../src/store/indexeddb-key-ranges'
import { installFreshFakeIndexedDbForTests } from '../helpers/fake-indexeddb'

interface IndexedRangeRow {
  id: string
  scope: string
  value: string | number
}

class IndexedRangeDb extends Dexie {
  rows!: EntityTable<IndexedRangeRow, 'id'>

  constructor() {
    super('indexed-range-test')
    this.version(1).stores({ rows: 'id, [scope+value]' })
  }
}

let db: IndexedRangeDb

beforeEach(async () => {
  installFreshFakeIndexedDbForTests()
  db = new IndexedRangeDb()
  await db.open()
})

afterEach(async () => {
  db.close()
  await db.delete()
})

describe('exactCompoundPrefixBetween', () => {
  it('queries every string component under one exact prefix without adjacent-prefix bleed', async () => {
    await db.rows.bulkPut([
      { id: 'empty', scope: 'target', value: '' },
      { id: 'plain', scope: 'target', value: 'alpha' },
      { id: 'unicode', scope: 'target', value: '\uffff\uffff' },
      { id: 'adjacent-null', scope: 'target\u0000', value: 'alpha' },
      { id: 'adjacent-suffix', scope: 'target-2', value: 'alpha' },
    ])

    const rows = await db.rows
      .where('[scope+value]')
      .between(...exactCompoundPrefixBetween(['target']))
      .toArray()

    expect(rows.map((row) => row.id)).toEqual(['empty', 'plain', 'unicode'])
  })

  it('queries numeric components and returns an empty result for a missing prefix', async () => {
    await db.rows.bulkPut([
      { id: 'negative', scope: 'numbers', value: -Number.MAX_VALUE },
      { id: 'zero', scope: 'numbers', value: 0 },
      { id: 'positive', scope: 'numbers', value: Number.MAX_VALUE },
      { id: 'other', scope: 'numbers-next', value: 0 },
    ])

    const rows = await db.rows
      .where('[scope+value]')
      .between(...exactCompoundPrefixBetween(['numbers']))
      .toArray()
    const missing = await db.rows
      .where('[scope+value]')
      .between(...exactCompoundPrefixBetween(['missing']))
      .toArray()

    expect(rows.map((row) => row.id)).toEqual(['negative', 'zero', 'positive'])
    expect(missing).toEqual([])
  })

  it('uses a direct empty-array ceiling instead of an environment-dependent Dexie sentinel', () => {
    expect(exactCompoundPrefixBetween(['chat', 'parent'])).toEqual([
      ['chat', 'parent'],
      ['chat', 'parent', []],
      true,
      false,
    ])
  })

  it('constructs valid independent ceilings for every scalar compound component', () => {
    const range = scalarCompoundIndexBetween([1], [1], 4)

    expect(range).toEqual([
      [1, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY],
      [1, [], [], []],
      true,
      false,
    ])
    expect(range[1][1]).not.toBe(range[1][2])
    expect(range[1][2]).not.toBe(range[1][3])
  })

  it('keeps Dexie inclusion flags distinct from native IDB openness flags', () => {
    const exact = exactCompoundPrefixKeyRange(['scope'])
    const scalar = scalarCompoundIndexKeyRange(['scope', 0], ['scope'], 2)

    expect([exact.lowerOpen, exact.upperOpen]).toEqual([false, true])
    expect([scalar.lowerOpen, scalar.upperOpen]).toEqual([false, true])
    expect(scalar.includes(['scope', 0])).toBe(true)
    expect(scalar.includes(['scope', 1])).toBe(true)
    expect(scalar.includes(['scope-next', 0])).toBe(false)
  })

  it('keeps Dexie sentinels out of compound array components', () => {
    const files = sourceFiles(join(process.cwd(), 'src', 'store')).concat(
      sourceFiles(join(process.cwd(), 'src', 'backcompat')),
    )
    const offenders = files.flatMap((file) => {
      const source = readFileSync(file, 'utf8')
      return /\[[^\]]*Dexie\.(?:minKey|maxKey)/s.test(source) ? [file] : []
    })

    expect(offenders).toEqual([])
  })
})

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : []
  })
}
