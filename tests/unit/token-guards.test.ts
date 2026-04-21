import { describe, expect, it } from 'vitest'
import {
  clampTokens,
  isFiniteNonNegNumber,
  MAX_PLAUSIBLE_TOKENS,
  safeContent,
  safeLen,
  safeServerTokens,
} from '../../src/core/token-guards'

describe('safeLen', () => {
  it('returns length of a string', () => {
    expect(safeLen('hello')).toBe(5)
    expect(safeLen('')).toBe(0)
  })

  it('returns 0 for non-string inputs', () => {
    expect(safeLen(null)).toBe(0)
    expect(safeLen(undefined)).toBe(0)
    expect(safeLen(42)).toBe(0)
    expect(safeLen({})).toBe(0)
    expect(safeLen([])).toBe(0)
    expect(safeLen(true)).toBe(0)
  })
})

describe('isFiniteNonNegNumber', () => {
  it('accepts finite non-negative numbers', () => {
    expect(isFiniteNonNegNumber(0)).toBe(true)
    expect(isFiniteNonNegNumber(1)).toBe(true)
    expect(isFiniteNonNegNumber(3.14)).toBe(true)
    expect(isFiniteNonNegNumber(1_000_000)).toBe(true)
  })

  it('rejects negatives, NaN, Infinity, and non-numbers', () => {
    expect(isFiniteNonNegNumber(-1)).toBe(false)
    expect(isFiniteNonNegNumber(Number.NaN)).toBe(false)
    expect(isFiniteNonNegNumber(Number.POSITIVE_INFINITY)).toBe(false)
    expect(isFiniteNonNegNumber(Number.NEGATIVE_INFINITY)).toBe(false)
    expect(isFiniteNonNegNumber('5')).toBe(false)
    expect(isFiniteNonNegNumber(null)).toBe(false)
    expect(isFiniteNonNegNumber(undefined)).toBe(false)
  })
})

describe('safeServerTokens', () => {
  it('returns floored finite non-negative ints', () => {
    expect(safeServerTokens(100)).toBe(100)
    expect(safeServerTokens(100.7)).toBe(100)
    expect(safeServerTokens(0)).toBe(0)
  })

  it('returns undefined for negative / NaN / Infinity / non-number', () => {
    expect(safeServerTokens(-1)).toBeUndefined()
    expect(safeServerTokens(-500)).toBeUndefined()
    expect(safeServerTokens(Number.NaN)).toBeUndefined()
    expect(safeServerTokens(Number.POSITIVE_INFINITY)).toBeUndefined()
    expect(safeServerTokens('100')).toBeUndefined()
    expect(safeServerTokens(null)).toBeUndefined()
    expect(safeServerTokens(undefined)).toBeUndefined()
    expect(safeServerTokens({})).toBeUndefined()
  })

  it('caps absurdly large values at MAX_PLAUSIBLE_TOKENS', () => {
    expect(safeServerTokens(1e12)).toBe(MAX_PLAUSIBLE_TOKENS)
    expect(safeServerTokens(MAX_PLAUSIBLE_TOKENS + 1)).toBe(MAX_PLAUSIBLE_TOKENS)
    expect(safeServerTokens(MAX_PLAUSIBLE_TOKENS)).toBe(MAX_PLAUSIBLE_TOKENS)
  })
})

describe('clampTokens', () => {
  it('passes through finite non-negative values under the cap', () => {
    expect(clampTokens(0)).toBe(0)
    expect(clampTokens(1)).toBe(1)
    expect(clampTokens(123.4)).toBe(123.4)
  })

  it('clamps NaN / Infinity / negatives to 0', () => {
    expect(clampTokens(Number.NaN)).toBe(0)
    expect(clampTokens(Number.POSITIVE_INFINITY)).toBe(0)
    expect(clampTokens(Number.NEGATIVE_INFINITY)).toBe(0)
    expect(clampTokens(-1)).toBe(0)
    expect(clampTokens(-999999)).toBe(0)
  })

  it('caps above-cap values at MAX_PLAUSIBLE_TOKENS', () => {
    expect(clampTokens(1e12)).toBe(MAX_PLAUSIBLE_TOKENS)
    expect(clampTokens(MAX_PLAUSIBLE_TOKENS + 1)).toBe(MAX_PLAUSIBLE_TOKENS)
  })
})

describe('safeContent', () => {
  it('returns the array verbatim when content is an array', () => {
    const arr = [{ type: 'text', text: 'hi' }] as const
    expect(safeContent(arr)).toBe(arr)
  })

  it('returns empty array for non-array inputs', () => {
    expect(safeContent(null)).toEqual([])
    expect(safeContent(undefined)).toEqual([])
    expect(safeContent('string content')).toEqual([])
    expect(safeContent({ type: 'text', text: 'oops' })).toEqual([])
    expect(safeContent(42)).toEqual([])
  })
})
