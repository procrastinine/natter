import { describe, expect, it } from 'vitest'
import { assert, assertNever } from '../../src/lib/assert'

describe('assert', () => {
  it('is a no-op when the condition is truthy', () => {
    expect(() => assert(true, 'unused')).not.toThrow()
    expect(() => assert(1, 'unused')).not.toThrow()
    expect(() => assert('x', 'unused')).not.toThrow()
    expect(() => assert({}, 'unused')).not.toThrow()
  })

  it('throws with "Assertion failed: <message>" on falsy values', () => {
    expect(() => assert(false, 'nope')).toThrow('Assertion failed: nope')
    expect(() => assert(0, 'nope')).toThrow('Assertion failed: nope')
    expect(() => assert('', 'nope')).toThrow('Assertion failed: nope')
    expect(() => assert(null, 'nope')).toThrow('Assertion failed: nope')
    expect(() => assert(undefined, 'nope')).toThrow('Assertion failed: nope')
  })

  it('narrows the type for TypeScript callers', () => {
    const v: string | null = 'x'
    assert(v !== null, 'v is null')
    // After the assert, v must be typed as string — the real test is that this
    // file compiles under strict mode; the expect is incidental.
    expect(v.length).toBe(1)
  })
})

describe('assertNever', () => {
  it('throws with the unexpected variant stringified', () => {
    expect(() => assertNever('surprise' as never)).toThrow(/Unexpected variant: surprise/)
    expect(() => assertNever(42 as never)).toThrow(/Unexpected variant: 42/)
  })

  it('serves as exhaustive switch guard', () => {
    type Kind = 'a' | 'b'
    const handle = (k: Kind): number => {
      switch (k) {
        case 'a':
          return 1
        case 'b':
          return 2
        default:
          return assertNever(k)
      }
    }
    expect(handle('a')).toBe(1)
    expect(handle('b')).toBe(2)
    expect(() => handle('c' as Kind)).toThrow(/Unexpected variant: c/)
  })
})
