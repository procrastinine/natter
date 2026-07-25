import { describe, expect, it } from 'vitest'
import { detectStaleReasoning, staleReasoningBannerText } from '../../src/core/stale-reasoning'

describe('detectStaleReasoning', () => {
  it('recognizes OpenAI encrypted_content rejections', () => {
    expect(detectStaleReasoning({ message: 'Invalid encrypted reasoning content' })).toBe('openai')
    expect(
      detectStaleReasoning({
        message: 'The reasoning.encrypted_content attestation has expired',
      }),
    ).toBe('openai')
  })

  it('recognizes Gemini missing thought_signature rejections', () => {
    expect(detectStaleReasoning({ message: 'missing a thought_signature' })).toBe('gemini')
    expect(detectStaleReasoning({ message: 'Invalid thoughtSignature on part 0' })).toBe('gemini')
  })

  it('classifies a generic 400 as stale-reasoning only when reasoning was in flight', () => {
    const err = { message: 'Bad request', statusCode: 400 }
    expect(detectStaleReasoning(err, 'carrier')).toBe('generic')
    expect(detectStaleReasoning(err, 'visible-only')).toBe('generic')
    expect(detectStaleReasoning(err, 'none')).toBeNull()
    expect(detectStaleReasoning(err, 'unknown')).toBeNull()
    expect(detectStaleReasoning(err)).toBeNull()
  })

  it('returns null for unrelated errors', () => {
    expect(detectStaleReasoning({ message: 'rate limit exceeded', statusCode: 429 })).toBeNull()
    expect(detectStaleReasoning({ message: 'Invalid API key', statusCode: 401 })).toBeNull()
    expect(detectStaleReasoning(null)).toBeNull()
    expect(detectStaleReasoning(undefined)).toBeNull()
  })

  it('has a banner-text variant per provider', () => {
    expect(staleReasoningBannerText('openai')).toMatch(/preserved reasoning/i)
    expect(staleReasoningBannerText('gemini')).toMatch(/thoughtSignature/i)
    expect(staleReasoningBannerText('generic')).toMatch(/rejected/i)
  })
})
