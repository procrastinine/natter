import { describe, expect, it } from 'vitest'
import { newId } from '../../src/lib/ulid'

describe('newId', () => {
  it('returns a 26-character uppercase Crockford base32 string', () => {
    const id = newId()
    expect(id).toHaveLength(26)
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
  })

  it('produces unique ids', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 1000; i += 1) ids.add(newId())
    expect(ids.size).toBe(1000)
  })

  it('is strictly monotonic: consecutive ids always sort ascending', () => {
    let prev = newId()
    for (let i = 0; i < 10_000; i += 1) {
      const next = newId()
      expect(next > prev).toBe(true)
      prev = next
    }
  })
})
