import { describe, expect, it } from 'vitest'
import {
  charPerToken,
  estimateTokens,
  estimateTokensByTokenizer,
  tokenizerFamily,
} from '../../src/core/tokens'

describe('tokenizerFamily', () => {
  it('maps canonical names from /endpoints architecture.tokenizer', () => {
    expect(tokenizerFamily('Claude')).toBe('claude')
    expect(tokenizerFamily('GPT')).toBe('gpt')
    expect(tokenizerFamily('Gemini')).toBe('gemini')
    expect(tokenizerFamily('Llama')).toBe('llama')
    expect(tokenizerFamily('Llama3')).toBe('llama')
    expect(tokenizerFamily('Mistral')).toBe('mistral')
    expect(tokenizerFamily('DeepSeek')).toBe('deepseek')
    expect(tokenizerFamily('Qwen')).toBe('qwen')
  })

  it('maps cl100k_base / o200k_base to the gpt family', () => {
    expect(tokenizerFamily('cl100k_base')).toBe('gpt')
    expect(tokenizerFamily('o200k_base')).toBe('gpt')
  })

  it('is case-insensitive and tolerant of variant suffixes', () => {
    expect(tokenizerFamily('claude')).toBe('claude')
    expect(tokenizerFamily('llama-3')).toBe('llama')
    expect(tokenizerFamily('qwen2')).toBe('qwen')
  })

  it('returns "unknown" for null/undefined/empty or unrecognized names', () => {
    expect(tokenizerFamily(null)).toBe('unknown')
    expect(tokenizerFamily(undefined)).toBe('unknown')
    expect(tokenizerFamily('')).toBe('unknown')
    expect(tokenizerFamily('mystery-tokenizer')).toBe('unknown')
  })
})

describe('charPerToken', () => {
  it('returns the §14.15 table exactly', () => {
    expect(charPerToken('claude')).toBe(3.8)
    expect(charPerToken('gpt')).toBe(3.5)
    expect(charPerToken('gemini')).toBe(4.0)
    expect(charPerToken('llama')).toBe(3.5)
    expect(charPerToken('mistral')).toBe(3.5)
    expect(charPerToken('deepseek')).toBe(3.5)
    expect(charPerToken('qwen')).toBe(3.5)
    expect(charPerToken('unknown')).toBe(4.0)
  })
})

describe('estimateTokens', () => {
  it('returns 0 for empty text', () => {
    expect(estimateTokens('', 'gpt')).toBe(0)
    expect(estimateTokens('', 'claude')).toBe(0)
  })

  it('rounds up partial tokens (over-reports slightly)', () => {
    // 10 chars / 3.5 = 2.857 → 3
    expect(estimateTokens('a'.repeat(10), 'gpt')).toBe(3)
    // 10 chars / 3.8 = 2.631 → 3
    expect(estimateTokens('a'.repeat(10), 'claude')).toBe(3)
    // 10 chars / 4.0 = 2.5 → 3
    expect(estimateTokens('a'.repeat(10), 'gemini')).toBe(3)
  })

  it('scales roughly linearly with length', () => {
    // 1000 chars / 3.5 = 285.71 → 286
    expect(estimateTokens('a'.repeat(1000), 'gpt')).toBe(286)
    // 1000 chars / 3.8 = 263.15 → 264
    expect(estimateTokens('a'.repeat(1000), 'claude')).toBe(264)
    // 1000 chars / 4.0 = 250 → 250
    expect(estimateTokens('a'.repeat(1000), 'gemini')).toBe(250)
  })

  it('is more conservative (higher count) for gpt than for gemini', () => {
    const text = 'a'.repeat(10_000)
    expect(estimateTokens(text, 'gpt')).toBeGreaterThan(estimateTokens(text, 'gemini'))
  })

  it('returns 0 for null / undefined / non-string input (no throw)', () => {
    expect(estimateTokens(null as unknown as string, 'gpt')).toBe(0)
    expect(estimateTokens(undefined as unknown as string, 'gpt')).toBe(0)
    expect(estimateTokens(42 as unknown as string, 'gpt')).toBe(0)
    expect(estimateTokens({} as unknown as string, 'gpt')).toBe(0)
  })
})

describe('estimateTokensByTokenizer', () => {
  it('composes tokenizerFamily + estimateTokens', () => {
    const text = 'a'.repeat(1000)
    expect(estimateTokensByTokenizer(text, 'Claude')).toBe(estimateTokens(text, 'claude'))
    expect(estimateTokensByTokenizer(text, 'cl100k_base')).toBe(estimateTokens(text, 'gpt'))
    expect(estimateTokensByTokenizer(text, null)).toBe(estimateTokens(text, 'unknown'))
  })
})
