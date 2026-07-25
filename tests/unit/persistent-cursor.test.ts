import { describe, expect, it, vi } from 'vitest'
import {
  PersistentStringMap,
  type PersistentStringMapMeasurement,
} from '../../src/lib/persistent-string-map'

function cursorWithEntries(count: number): PersistentStringMap<string> {
  return PersistentStringMap.from(
    Array.from(
      { length: count },
      (_, index) => [`parent-${index.toString().padStart(6, '0')}`, `child-${index}`] as const,
    ),
  )
}

describe('persistent tab cursor storage', () => {
  it('path-copies a typed immutable snapshot without changing older readers', () => {
    const first = PersistentStringMap.empty<string>().set('__root__', 'M1').set('M1', 'M2')
    const second = first.set('__root__', 'M9').set('M2', 'M3')

    expect([...first.entries()]).toEqual([
      ['M1', 'M2'],
      ['__root__', 'M1'],
    ])
    expect([...second.entries()]).toEqual([
      ['M1', 'M2'],
      ['M2', 'M3'],
      ['__root__', 'M9'],
    ])
    expect(first.get('__root__')).toBe('M1')
    expect(second.get('__root__')).toBe('M9')
  })

  it('keeps a single remembered-branch update bounded by tree depth without enumeration', () => {
    const count = 16_383
    const cursor = cursorWithEntries(count)
    const enumeration = vi.spyOn(PersistentStringMap.prototype, 'entries')
    const measurement: PersistentStringMapMeasurement = { nodeVisits: 0 }

    const next = cursor.set('parent-008191', 'replacement', measurement)

    expect(cursor.size).toBe(count)
    expect(measurement.nodeVisits).toBeLessThanOrEqual(cursor.maxDepth())
    expect(enumeration).not.toHaveBeenCalled()
    expect(next.get('parent-008191')).toBe('replacement')
    expect(cursor.get('parent-008191')).toBe('child-8191')
    enumeration.mockRestore()
  })

  it('supports bounded deletion while retaining the typed map boundary', () => {
    const count = 4_095
    const cursor = cursorWithEntries(count)
    const measurement: PersistentStringMapMeasurement = { nodeVisits: 0 }
    const next = cursor.delete('parent-002047', measurement)

    expect(measurement.nodeVisits).toBeLessThanOrEqual(cursor.maxDepth())
    expect(next.get('parent-002047')).toBeUndefined()
    expect(next.size).toBe(count - 1)
    expect(next.get('parent-002048')).toBe('child-2048')
    expect(cursor.get('parent-002047')).toBe('child-2047')
  })

  it('matches a reference map through deterministic insert, replace, and delete churn', () => {
    let randomState = 0x5eed1234
    const random = (): number => {
      randomState = (Math.imul(randomState, 1_664_525) + 1_013_904_223) >>> 0
      return randomState
    }
    let cursor = PersistentStringMap.empty<string>()
    const reference = new Map<string, string>()
    const retained: Array<{
      cursor: PersistentStringMap<string>
      entries: Array<[string, string]>
    }> = []

    for (let operation = 0; operation < 5_000; operation += 1) {
      const key = `fork-${(random() % 257).toString().padStart(3, '0')}`
      const remove = random() % 5 < 2
      const value = `child-${random() % 1_009}`
      const previous = cursor
      const measurement: PersistentStringMapMeasurement = { nodeVisits: 0 }
      cursor = remove ? cursor.delete(key, measurement) : cursor.set(key, value, measurement)
      if (remove) reference.delete(key)
      else reference.set(key, value)

      expect(measurement.nodeVisits).toBeLessThanOrEqual(Math.max(1, previous.maxDepth()))
      if (operation % 311 === 0) {
        retained.push({ cursor: previous, entries: [...previous.entries()] })
      }
      if (operation % 97 === 0) {
        const expected = [...reference].sort(([left], [right]) => left.localeCompare(right))
        expect([...cursor.entries()]).toEqual(expected)
        expect(cursor.size).toBe(reference.size)
      }
    }

    for (const snapshot of retained) {
      expect([...snapshot.cursor.entries()]).toEqual(snapshot.entries)
    }
  })
})
