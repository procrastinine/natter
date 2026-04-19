// Preferred-provider tiebreaker ordering. See `plan/09-privacy.md §9.7` and
// `src/core/preferred-providers.ts`.
//
// These rules only fire when Pareto leaves multiple kept endpoints. They
// reorder but never add or remove.

import { describe, expect, it } from 'vitest'
import {
  applyPreferredOrdering,
  findPreferredRule,
  PROVIDER_PREFERENCE,
} from '../../src/core/preferred-providers'

describe('findPreferredRule', () => {
  it('matches Gemini models', () => {
    expect(findPreferredRule('google/gemini-3.1-flash-lite-preview')?.order).toEqual([
      'Google AI Studio',
      'Google',
    ])
    expect(findPreferredRule('google/gemini-2.0-pro')?.order).toEqual([
      'Google AI Studio',
      'Google',
    ])
  })

  it('matches DeepSeek models', () => {
    expect(findPreferredRule('deepseek/deepseek-r1')?.order).toEqual([
      'DeepInfra',
      'Novita',
      'Chutes',
      'DeepSeek',
    ])
  })

  it('returns null for models without a curated preference rule', () => {
    expect(findPreferredRule('mistralai/mistral-large')).toBeNull()
    expect(findPreferredRule('meta-llama/llama-3.3-70b')).toBeNull()
  })
})

describe('applyPreferredOrdering', () => {
  it('places Google AI Studio before Google Vertex on Gemini', () => {
    const ordered = applyPreferredOrdering('google/gemini-3.1-flash-lite-preview', [
      'Google Vertex',
      'Google AI Studio',
    ])
    expect(ordered).toEqual(['Google AI Studio', 'Google Vertex'])
  })

  it('returns a new array; never mutates input', () => {
    const input = ['Google', 'Google AI Studio']
    const ordered = applyPreferredOrdering('google/gemini-2.0-flash', input)
    expect(ordered).not.toBe(input)
    expect(input).toEqual(['Google', 'Google AI Studio'])
  })

  it('preserves non-rule providers at the tail in their original order', () => {
    const ordered = applyPreferredOrdering('deepseek/deepseek-r1', [
      'DeepSeek',
      'Random Host',
      'DeepInfra',
      'Another Host',
      'Novita',
    ])
    expect(ordered).toEqual([
      'DeepInfra',
      'Novita',
      'DeepSeek',
      'Random Host',
      'Another Host',
    ])
  })

  it('is a no-op on models without a preference rule', () => {
    const input = ['Host A', 'Host B']
    const ordered = applyPreferredOrdering('mistralai/mistral-large', input)
    expect(ordered).toEqual(input)
  })

  it('is a no-op on a single kept provider', () => {
    const ordered = applyPreferredOrdering('google/gemini-3.1-pro', ['Google AI Studio'])
    expect(ordered).toEqual(['Google AI Studio'])
  })

  it('never re-adds names absent from kept', () => {
    // DeepInfra is in the preference rule but NOT in the kept set (e.g.
    // user manually ignored it). Result must not include DeepInfra.
    const ordered = applyPreferredOrdering('deepseek/deepseek-r1', ['Novita', 'DeepSeek'])
    expect(ordered).toEqual(['Novita', 'DeepSeek'])
  })
})

describe('OpenAI rule', () => {
  it('puts Azure before OpenAI direct', () => {
    const ordered = applyPreferredOrdering('openai/gpt-5.4', ['OpenAI', 'Azure'])
    expect(ordered).toEqual(['Azure', 'OpenAI'])
  })
})

describe('Anthropic rule', () => {
  it('Bedrock first, then Google Vertex, then Anthropic direct', () => {
    const ordered = applyPreferredOrdering('anthropic/claude-opus-4.7', [
      'Anthropic',
      'Google',
      'Amazon Bedrock',
    ])
    expect(ordered).toEqual(['Amazon Bedrock', 'Google', 'Anthropic'])
  })

  it('falls back to Google when Bedrock is unavailable (Claude 3.7 case)', () => {
    const ordered = applyPreferredOrdering('anthropic/claude-3.7-sonnet', [
      'Anthropic',
      'Google',
    ])
    expect(ordered).toEqual(['Google', 'Anthropic'])
  })
})

describe('PROVIDER_PREFERENCE (frozen contract)', () => {
  it('declares OpenAI, Anthropic, Gemini, DeepSeek', () => {
    // If a rule gets added, the test needs updating — that pressure is
    // intentional per plan/09 §9.7 "Add as real ties are discovered."
    expect(PROVIDER_PREFERENCE.length).toBe(4)
  })
})
