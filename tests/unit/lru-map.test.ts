import { describe, expect, it } from 'vitest'
import { LruMap } from '../../src/lib/lru-map'

describe('LruMap', () => {
  it('bounds a large visited working set and keeps the most recently read entries', () => {
    const cache = new LruMap<number, { payload: string }>(16)
    for (let index = 0; index < 100; index += 1) {
      cache.set(index, { payload: `${index}:${'x'.repeat(100_000)}` })
    }
    expect(cache.size).toBe(16)
    expect([...cache.keys()]).toEqual(Array.from({ length: 16 }, (_, index) => index + 84))

    const retained = cache.get(84)
    cache.set(100, { payload: 'new' })
    expect(retained?.payload.startsWith('84:')).toBe(true)
    expect(cache.get(84)).toBe(retained)
    expect(cache.get(85)).toBeUndefined()
    expect(cache.size).toBe(16)
  })

  it('supports exact deletion and workspace-wide clearing', () => {
    const cache = new LruMap<string, object>(2)
    const value = {}
    cache.set('chat-a', value)
    cache.set('chat-b', {})
    expect(cache.delete('chat-a')).toBe(true)
    expect(cache.get('chat-a')).toBeUndefined()
    cache.clear()
    expect(cache.size).toBe(0)
  })

  it('rejects invalid limits', () => {
    expect(() => new LruMap(0)).toThrow(RangeError)
    expect(() => new LruMap(1.5)).toThrow(RangeError)
  })
})
