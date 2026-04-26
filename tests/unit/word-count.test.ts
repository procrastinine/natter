import { describe, expect, it } from 'vitest'
import { countWords } from '../../src/core/word-count'

describe('word-count', () => {
  it('counts ASCII text', () => {
    expect(countWords('hello, dense chat world')).toBe(4)
  })

  it('counts CJK text with Intl word segmentation when available', () => {
    expect(countWords('你好世界')).toBe(2)
  })

  it('counts code fences as words too', () => {
    expect(countWords('```ts\nconst value = 1\n```')).toBe(4)
  })

  it('returns zero for empty text', () => {
    expect(countWords(' \n\t ')).toBe(0)
  })
})
