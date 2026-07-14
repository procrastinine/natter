import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CursorMap } from '../../src/core/types'
import {
  __setPersistentCursorEnumerationProbeForTests,
  patchPersistentCursor,
  persistentCursorTreeStats,
  toPersistentCursor,
} from '../../src/store/zustand/persistentCursor'

function cursorWithEntries(count: number): CursorMap {
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `parent-${index.toString().padStart(6, '0')}`,
      `child-${index}`,
    ]),
  )
}

afterEach(() => {
  __setPersistentCursorEnumerationProbeForTests(undefined)
})

describe('persistent tab cursor', () => {
  it('path-copies an immutable snapshot without changing older readers', () => {
    const first = toPersistentCursor({ __root__: 'M1', M1: 'M2' })
    const second = patchPersistentCursor(first, { __root__: 'M9', M2: 'M3' })

    expect(first).toEqual({ __root__: 'M1', M1: 'M2' })
    expect(second).toEqual({ __root__: 'M9', M1: 'M2', M2: 'M3' })
    const mutableFirst = first as CursorMap
    expect(() => {
      mutableFirst.__root__ = 'MUTATED'
    }).toThrow(TypeError)
    expect(first.__root__).toBe('M1')
    expect(second.__root__).toBe('M9')
  })

  it('keeps single-entry updates logarithmic and never enumerates the existing cursor', () => {
    const count = 16_383
    const cursor = toPersistentCursor(cursorWithEntries(count))
    const stats = persistentCursorTreeStats(cursor)
    const enumerationProbe = vi.fn()
    const measurement = { nodeVisits: 0 }
    __setPersistentCursorEnumerationProbeForTests(enumerationProbe)

    const next = patchPersistentCursor(cursor, { 'parent-008191': 'replacement' }, measurement)

    expect(stats.size).toBe(count)
    expect(stats.height).toBeLessThanOrEqual(2 * Math.ceil(Math.log2(count + 1)))
    expect(measurement.nodeVisits).toBeLessThanOrEqual(stats.height + 1)
    expect(enumerationProbe).not.toHaveBeenCalled()
    expect(next['parent-008191']).toBe('replacement')
    expect(cursor['parent-008191']).toBe('child-8191')
  })

  it('supports logarithmic deletion while retaining Record-compatible boundaries', () => {
    const count = 4_095
    const cursor = toPersistentCursor(cursorWithEntries(count))
    const stats = persistentCursorTreeStats(cursor)
    const measurement = { nodeVisits: 0 }
    const next = patchPersistentCursor(cursor, { 'parent-002047': undefined }, measurement)

    expect(measurement.nodeVisits).toBeLessThanOrEqual(stats.height * 2 + 1)
    expect(next['parent-002047']).toBeUndefined()
    expect(Object.keys(next)).toHaveLength(count - 1)
    expect({ ...next }['parent-002048']).toBe('child-2048')
  })

  it('matches a reference map through deterministic mixed insert, replace, and delete churn', () => {
    let randomState = 0x5eed1234
    const random = (): number => {
      randomState = (Math.imul(randomState, 1_664_525) + 1_013_904_223) >>> 0
      return randomState
    }
    let cursor = toPersistentCursor({})
    const reference = new Map<string, string>()
    const retained: Array<{ cursor: Readonly<CursorMap>; entries: Array<[string, string]> }> = []

    for (let operation = 0; operation < 5_000; operation += 1) {
      const key = `fork-${(random() % 257).toString().padStart(3, '0')}`
      const remove = random() % 5 < 2
      const value = `child-${random() % 1_009}`
      const before = persistentCursorTreeStats(cursor)
      const measurement = { nodeVisits: 0 }
      const previous = cursor
      cursor = patchPersistentCursor(cursor, { [key]: remove ? undefined : value }, measurement)
      if (remove) reference.delete(key)
      else reference.set(key, value)

      const visitBudget = remove ? before.height * 2 + 1 : before.height + 1
      expect(measurement.nodeVisits).toBeLessThanOrEqual(Math.max(1, visitBudget))
      if (operation % 311 === 0) {
        retained.push({ cursor: previous, entries: Object.entries(previous) })
      }
      if (operation % 97 === 0) {
        const expected = [...reference].sort(([left], [right]) => left.localeCompare(right))
        expect(Object.entries(cursor)).toEqual(expected)
        const stats = persistentCursorTreeStats(cursor)
        expect(stats.size).toBe(reference.size)
        if (stats.size > 0) {
          expect(stats.height).toBeLessThanOrEqual(2 * Math.ceil(Math.log2(stats.size + 1)))
        }
      }
    }

    for (const snapshot of retained) {
      expect(Object.entries(snapshot.cursor)).toEqual(snapshot.entries)
    }
  })
})
