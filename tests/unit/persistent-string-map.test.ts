import { describe, expect, it } from 'vitest'
import { PersistentStringMap } from '../../src/lib/persistent-string-map'

describe('PersistentStringMap', () => {
  it('preserves prior snapshots across insert, replacement, prefix, unicode, and delete paths', () => {
    const empty = PersistentStringMap.empty<number>()
    const first = empty.set('', 0).set('a', 1).set('ab', 2).set('å', 3).set('😀', 4)
    const replaced = first.set('ab', 20)
    const deleted = replaced.delete('a').delete('missing')

    expect(empty.size).toBe(0)
    expect(first.size).toBe(5)
    expect(first.get('ab')).toBe(2)
    expect(replaced.get('ab')).toBe(20)
    expect(replaced.get('a')).toBe(1)
    expect(deleted.has('a')).toBe(false)
    expect(deleted.get('ab')).toBe(20)
    expect([...deleted.keys()]).toEqual(['', 'ab', 'å', '😀'])
  })

  it('returns the same snapshot for no-op writes and missing deletes', () => {
    const value = { version: 1 }
    const map = PersistentStringMap.from([['message', value] as const])

    expect(map.set('message', value)).toBe(map)
    expect(map.delete('missing')).toBe(map)
  })
})
