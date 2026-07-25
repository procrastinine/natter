import { describe, expect, it } from 'vitest'
import { assertNever } from '../../src/lib/assert'

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
