import { describe, expect, it } from 'vitest'
import type { Message } from '../../src/core/types'
import { countMessagesWords } from '../../src/core/word-count'

function countWords(text: string): number {
  const message: Message = {
    id: 'message',
    chatId: 'chat',
    parentId: null,
    siblingIndex: 0,
    turnId: 'turn',
    turnIndex: 0,
    createdAt: 0,
    role: 'user',
    origin: 'user',
    content: [{ type: 'text', text }],
    nodeVersion: 0,
    deleted: false,
  }
  return countMessagesWords([message])
}

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
