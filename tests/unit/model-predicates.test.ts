import { describe, expect, it } from 'vitest'
import {
  isAnthropicOnBedrockOrVertex,
  isFreeModel,
  isPresetSlug,
} from '../../src/core/model-predicates'

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

describe('isPresetSlug', () => {
  it('matches "@preset/..." references', () => {
    expect(isPresetSlug('@preset/my-preset')).toBe(true)
    expect(isPresetSlug('@preset/anything')).toBe(true)
  })

  it('does not match regular slugs', () => {
    expect(isPresetSlug('anthropic/claude-sonnet-4.6')).toBe(false)
    expect(isPresetSlug('@openrouter/auto')).toBe(false)
  })

  it('is false for the empty string', () => {
    expect(isPresetSlug('')).toBe(false)
  })
})

describe('isAnthropicOnBedrockOrVertex', () => {
  it('matches anthropic/* on Amazon Bedrock', () => {
    expect(
      isAnthropicOnBedrockOrVertex('anthropic/claude-opus-4.7', {
        provider_name: 'Amazon Bedrock',
      }),
    ).toBe(true)
  })

  it('matches anthropic/* on Google Vertex', () => {
    expect(
      isAnthropicOnBedrockOrVertex('anthropic/claude-opus-4.7', {
        provider_name: 'Google Vertex',
      }),
    ).toBe(true)
  })

  it('matches the historical "Google" rename for Vertex', () => {
    expect(
      isAnthropicOnBedrockOrVertex('anthropic/claude-opus-4.7', { provider_name: 'Google' }),
    ).toBe(true)
  })

  it('does not match anthropic/* on Anthropic direct', () => {
    expect(
      isAnthropicOnBedrockOrVertex('anthropic/claude-opus-4.7', { provider_name: 'Anthropic' }),
    ).toBe(false)
  })

  it('does not match non-anthropic models even on Bedrock/Vertex', () => {
    expect(
      isAnthropicOnBedrockOrVertex('openai/gpt-5.2', { provider_name: 'Amazon Bedrock' }),
    ).toBe(false)
    expect(
      isAnthropicOnBedrockOrVertex('google/gemini-3-flash', { provider_name: 'Google Vertex' }),
    ).toBe(false)
  })

  it('returns false when endpoint is omitted or has no provider_name', () => {
    expect(isAnthropicOnBedrockOrVertex('anthropic/claude-opus-4.7')).toBe(false)
    expect(isAnthropicOnBedrockOrVertex('anthropic/claude-opus-4.7', undefined)).toBe(false)
    expect(isAnthropicOnBedrockOrVertex('anthropic/claude-opus-4.7', { provider_name: '' })).toBe(
      false,
    )
  })
})
