import { describe, expect, it } from 'vitest'
import { isFreeModel } from '../../src/core/model-predicates'

describe('isFreeModel', () => {
  it('matches slugs ending in ":free"', () => {
    expect(isFreeModel('meta-llama/llama-3.3-70b:free')).toBe(true)
    expect(isFreeModel('deepseek/deepseek-v3.2:free')).toBe(true)
  })

  it('matches ":free" followed by another variant tag', () => {
    expect(isFreeModel('meta-llama/llama-3.3-70b:free:nitro')).toBe(true)
    expect(isFreeModel('foo/bar:free:beta')).toBe(true)
  })

  it('does not match paid slugs', () => {
    expect(isFreeModel('anthropic/claude-sonnet-4.6')).toBe(false)
    expect(isFreeModel('openai/gpt-5.2')).toBe(false)
    expect(isFreeModel('google/gemini-3-flash:nitro')).toBe(false)
  })

  it('does not match ":freely" / ":freeform" etc.', () => {
    expect(isFreeModel('foo/bar:freely')).toBe(false)
    expect(isFreeModel('foo/bar:freeform')).toBe(false)
  })

  it('does not match "free" elsewhere in the slug without the colon prefix', () => {
    expect(isFreeModel('freeway/model-free')).toBe(false)
    expect(isFreeModel('freeway/free-model')).toBe(false)
  })

  it('is false for the empty string', () => {
    expect(isFreeModel('')).toBe(false)
  })
})
