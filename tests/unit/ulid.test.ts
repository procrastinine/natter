import { describe, expect, it } from 'vitest'
import { isUlid, newId, nonMonotonicId } from '../../src/lib/ulid'

describe('newId', () => {
  it('returns a 26-character uppercase Crockford base32 string', () => {
    const id = newId()
    expect(id).toHaveLength(26)
    expect(isUlid(id)).toBe(true)
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

describe('nonMonotonicId', () => {
  it('returns valid ULIDs', () => {
    const id = nonMonotonicId()
    expect(isUlid(id)).toBe(true)
    expect(id).toHaveLength(26)
  })
})

describe('isUlid', () => {
  it('accepts valid 26-char Crockford-uppercase ids', () => {
    expect(isUlid('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(true)
  })

  it('rejects wrong length', () => {
    expect(isUlid('01ARZ3NDEKTSV4RRFFQ69G5FA')).toBe(false)
    expect(isUlid('01ARZ3NDEKTSV4RRFFQ69G5FAVX')).toBe(false)
  })

  it('rejects Crockford-excluded letters (I, L, O, U)', () => {
    expect(isUlid('01ARZ3NDEKTSV4RRFFQ69G5FAU')).toBe(false)
    expect(isUlid('01ARZ3NDEKTSV4RRFFQ69G5FAI')).toBe(false)
    expect(isUlid('01ARZ3NDEKTSV4RRFFQ69G5FAL')).toBe(false)
    expect(isUlid('01ARZ3NDEKTSV4RRFFQ69G5FAO')).toBe(false)
  })

  it('accepts lowercase (ulidx regex is case-insensitive per Crockford)', () => {
    expect(isUlid('01arz3ndektsv4rrffq69g5fav')).toBe(true)
  })

  it('rejects the empty string', () => {
    expect(isUlid('')).toBe(false)
  })
})
