import { describe, expect, it } from 'vitest'
import {
  allowedEffortFor,
  allowedVerbosityFor,
  cacheMinTokensFor,
  FULL_EFFORT,
  FULL_VERBOSITY,
  quirksFor,
} from '../../src/core/quirks'

describe('quirks registry', () => {
  it('returns empty entry for an unknown model', () => {
    expect(quirksFor('mistral/large')).toEqual({})
    expect(allowedEffortFor('mistral/large')).toEqual(FULL_EFFORT)
    expect(allowedVerbosityFor('mistral/large')).toEqual(FULL_VERBOSITY)
  })

  it('handles both prefixed and bare model ids', () => {
    const a = quirksFor('anthropic/claude-opus-4.7')
    const b = quirksFor('claude-opus-4.7')
    expect(a).toEqual(b)
    expect(a.adaptiveReasoningOnly).toBe(true)
  })

  it('treats Anthropic compatibility ids with hyphens as the same model', () => {
    expect(quirksFor('anthropic/claude-opus-4-7')).toEqual(quirksFor('anthropic/claude-opus-4.7'))
    expect(allowedEffortFor('claude-sonnet-4-6')).toEqual([])
  })

  it('adaptive-only models narrow allowedEffort to []', () => {
    expect(allowedEffortFor('anthropic/claude-opus-4.7')).toEqual([])
    expect(allowedEffortFor('claude-sonnet-4.6')).toEqual([])
  })

  it('Claude 4.7 verbosity includes "max" and "xhigh"', () => {
    // Per OpenRouter 4.7 migration doc (llms-full.txt line 18450–18451):
    // 4.7 supports both xhigh (new) and max (inherited from 4.6).
    expect(allowedVerbosityFor('claude-opus-4.7')).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
  })

  it('Claude 4.6 verbosity includes "max"', () => {
    expect(allowedVerbosityFor('claude-opus-4.6')).toContain('max')
  })

  it('GPT-5.4 prefers Responses (both APIs accepted) and persists phase', () => {
    // Live probes confirmed gpt-5.4 accepts /chat/completions too (phase drops
    // without Responses, causing early stopping — hence preferApi +
    // persistsResponsesPhase — but the model is not responses-only).
    const q = quirksFor('openai/gpt-5.4')
    expect(q.preferApi).toBe('responses')
    expect(q.persistsResponsesPhase).toBe(true)
    expect(q.requiresResponsesApi).toBeUndefined()
  })

  it('GPT-5.4-pro is responses-only', () => {
    const q = quirksFor('openai/gpt-5.4-pro')
    expect(q.requiresResponsesApi).toBe(true)
    expect(q.responsesSupport).toBe('responses-only')
  })

  it('cacheMinTokens picks up per-variant floors', () => {
    expect(cacheMinTokensFor('anthropic/claude-opus-4.7')).toBe(4096)
    expect(cacheMinTokensFor('anthropic/claude-sonnet-4.6')).toBe(2048)
    expect(cacheMinTokensFor('anthropic/claude-sonnet-4.5')).toBe(1024)
    expect(cacheMinTokensFor('anthropic/claude-haiku-4.5')).toBe(4096)
  })

  it('Gemini 3 Pro allowedEffort is low/medium/high (no minimal, no xhigh)', () => {
    // Per Google's Vertex thinking docs: Gemini 3 Pro / 3.1 Pro have NO
    // `minimal` level — only low/medium/high. Pro cannot be disabled.
    expect(allowedEffortFor('google/gemini-3.1-pro-preview')).toEqual([
      'low',
      'medium',
      'high',
    ])
    // Prefix match also catches -customtools variant.
    expect(allowedEffortFor('google/gemini-3.1-pro-preview-customtools')).toEqual([
      'low',
      'medium',
      'high',
    ])
  })

  it('Gemini 3 Flash allowedEffort includes minimal', () => {
    expect(allowedEffortFor('google/gemini-3.1-flash-lite-preview')).toEqual([
      'minimal',
      'low',
      'medium',
      'high',
    ])
  })

  it('picks the longest matching prefix, not the first', () => {
    // "claude-sonnet-4.6" must not pick up "claude-opus-4.6"'s cacheMinTokens.
    expect(cacheMinTokensFor('anthropic/claude-sonnet-4.6')).toBe(2048)
    expect(cacheMinTokensFor('anthropic/claude-opus-4.6')).toBe(4096)
  })

  it('unknown model returns undefined cacheMinTokens', () => {
    expect(cacheMinTokensFor('mistral/large')).toBeUndefined()
  })

  it('xAI Grok 4.x allowedEffort narrows to low/medium/high', () => {
    // /chat/completions rejects 'none' / 'minimal' / 'xhigh' on these models
    // — upstream clamps silently, so we hide those buttons.
    expect(allowedEffortFor('x-ai/grok-4.20')).toEqual(['low', 'medium', 'high'])
    expect(allowedEffortFor('x-ai/grok-4.1')).toEqual(['low', 'medium', 'high'])
  })

  it('DeepSeek v4 inline reasoning + narrowed effort', () => {
    // Emits <think>…</think> inline; parser lifts to reasoning lane.
    const q = quirksFor('deepseek/deepseek-v4-pro')
    expect(q.reasoningInlineTags).toEqual(['think'])
    expect(q.allowedEffort).toEqual(['high', 'xhigh'])
  })

  it('Qwen3.6 inline reasoning + narrowed effort', () => {
    const q = quirksFor('qwen/qwen3.6-plus')
    expect(q.reasoningInlineTags).toEqual(['think'])
    expect(q.allowedEffort).toEqual(['low', 'medium', 'high'])
  })

  it('Gemma 4 inline tags + effort narrowed', () => {
    // gemma-4 keys on the whole family; any sub-variant matches.
    const q = quirksFor('google/gemma-4-31b-it')
    expect(q.reasoningInlineTags).toEqual(['thought', 'think'])
  })

  it('o-series reasoning is hidden but effort superset unchanged', () => {
    expect(quirksFor('openai/o1').reasoningHidden).toBe(true)
    expect(quirksFor('openai/o3-mini').reasoningHidden).toBe(true)
    expect(quirksFor('openai/o4-mini').reasoningHidden).toBe(true)
  })
})
