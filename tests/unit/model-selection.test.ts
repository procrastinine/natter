import { describe, expect, it } from 'vitest'
import {
  forceEquivalentModelIdForConnection,
  modelLooksForeignForProfile,
  pickEquivalentModelId,
} from '../../src/core/model-selection'

describe('model selection identity', () => {
  it('selects crosswalk-equivalent ids without widening to sibling models', () => {
    expect(
      pickEquivalentModelId('openai/gpt-5.4', [
        { id: 'gpt-5.4-pro' },
        { id: 'gpt-5.4' },
        { id: 'gpt-4o' },
      ]),
    ).toBe('gpt-5.4')
    expect(pickEquivalentModelId('openai/gpt-5.4', [{ id: 'gpt-5.4-pro' }])).toBeNull()
    expect(
      pickEquivalentModelId('anthropic/claude-opus-4.7', [
        { id: 'claude-opus-4.7' },
        { id: 'claude-sonnet-4.6' },
      ]),
    ).toBe('claude-opus-4.7')
    expect(
      pickEquivalentModelId('claude-opus-4.7', [
        { id: 'anthropic/claude-opus-4.7' },
        { id: 'anthropic/claude-sonnet-4.6' },
      ]),
    ).toBe('anthropic/claude-opus-4.7')
  })

  it('matches Gemini OpenRouter ids against Google resource-name ids in either direction', () => {
    expect(
      pickEquivalentModelId('google/gemini-3.1-flash-lite-preview', [
        { id: 'models/gemini-3.1-flash-lite-preview' },
        { id: 'models/gemini-3.1-pro' },
      ]),
    ).toBe('models/gemini-3.1-flash-lite-preview')
    expect(
      pickEquivalentModelId('models/gemini-3.1-flash-lite-preview', [
        { id: 'google/gemini-3.1-flash-lite-preview' },
        { id: 'google/gemini-3.1-pro' },
      ]),
    ).toBe('google/gemini-3.1-flash-lite-preview')
  })

  it('detects provider-shaped ids left on the wrong active profile', () => {
    expect(modelLooksForeignForProfile('openai-compatible', 'openai/gpt-5.4')).toBe(false)
    expect(modelLooksForeignForProfile('openai-compatible', 'anthropic/claude-opus-4.6')).toBe(true)
    expect(modelLooksForeignForProfile('anthropic', 'openai/gpt-5.4')).toBe(true)
    expect(modelLooksForeignForProfile('google', 'google/gemini-3.1-pro-preview')).toBe(false)
    expect(modelLooksForeignForProfile('openrouter', 'claude-opus-4.6')).toBe(true)
    expect(modelLooksForeignForProfile('openrouter', 'anthropic/claude-opus-4.6')).toBe(false)
  })

  it('prefers the non-variant OpenRouter id unless the exact variant was selected', () => {
    expect(
      pickEquivalentModelId('gpt-5.4', [{ id: 'openai/gpt-5.4:free' }, { id: 'openai/gpt-5.4' }]),
    ).toBe('openai/gpt-5.4')
    expect(
      pickEquivalentModelId('openai/gpt-5.4:free', [
        { id: 'openai/gpt-5.4:free' },
        { id: 'openai/gpt-5.4' },
      ]),
    ).toBe('openai/gpt-5.4:free')
  })

  it('forces cross-provider equivalents without live model discovery', () => {
    expect(forceEquivalentModelIdForConnection('openai/gpt-5.4', 'openai-compatible')).toBe(
      'gpt-5.4',
    )
    expect(forceEquivalentModelIdForConnection('anthropic/claude-opus-4.7', 'anthropic')).toBe(
      'claude-opus-4.7',
    )
    expect(forceEquivalentModelIdForConnection('gpt-5.4', 'openrouter')).toBe('openai/gpt-5.4')
    expect(forceEquivalentModelIdForConnection('openai/gpt-5.4', 'anthropic')).toBeNull()
  })

  it('forces direct-provider equivalents against bundled candidate ids', () => {
    expect(
      forceEquivalentModelIdForConnection('openai/gpt-5.4', 'openai-compatible', [
        { id: 'gpt-5.4' },
      ]),
    ).toBe('gpt-5.4')
    expect(
      forceEquivalentModelIdForConnection('anthropic/claude-opus-4.6', 'anthropic', [
        { id: 'claude-opus-4.6' },
      ]),
    ).toBe('claude-opus-4.6')
    expect(
      forceEquivalentModelIdForConnection('google/gemini-3.1-pro-preview', 'google', [
        { id: 'gemini-3.1-pro-preview' },
      ]),
    ).toBe('models/gemini-3.1-pro-preview')
  })

  it('normalizes GPT-5.6 standard tiers without inventing native Pro slugs', () => {
    expect(
      forceEquivalentModelIdForConnection('openai/gpt-5.6', 'openai-compatible', [
        { id: 'gpt-5.6-sol' },
        { id: 'gpt-5.6-terra' },
        { id: 'gpt-5.6-luna' },
      ]),
    ).toBe('gpt-5.6-sol')
    for (const tier of ['sol', 'terra', 'luna']) {
      expect(
        forceEquivalentModelIdForConnection(`openai/gpt-5.6-${tier}`, 'openai-compatible', [
          { id: `gpt-5.6-${tier}` },
        ]),
      ).toBe(`gpt-5.6-${tier}`)
      expect(
        forceEquivalentModelIdForConnection(`gpt-5.6-${tier}`, 'openrouter', [
          { id: `openai/gpt-5.6-${tier}` },
        ]),
      ).toBe(`openai/gpt-5.6-${tier}`)
      expect(
        forceEquivalentModelIdForConnection(`openai/gpt-5.6-${tier}-pro`, 'openai-compatible', [
          { id: `gpt-5.6-${tier}` },
        ]),
      ).toBeNull()
    }
  })
})
