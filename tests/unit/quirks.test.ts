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

  it('GPT-5.4 requires the Responses API', () => {
    const q = quirksFor('openai/gpt-5.4')
    expect(q.requiresResponsesApi).toBe(true)
    expect(q.persistsResponsesPhase).toBe(true)
  })

  it('cacheMinTokens picks up per-variant floors', () => {
    expect(cacheMinTokensFor('anthropic/claude-opus-4.7')).toBe(4096)
    expect(cacheMinTokensFor('anthropic/claude-sonnet-4.6')).toBe(2048)
    expect(cacheMinTokensFor('anthropic/claude-sonnet-4.5')).toBe(1024)
    expect(cacheMinTokensFor('anthropic/claude-haiku-4.5')).toBe(4096)
  })

  it('Gemini 3 allowedEffort excludes xhigh and none', () => {
    expect(allowedEffortFor('google/gemini-3.1-pro')).toEqual(['minimal', 'low', 'medium', 'high'])
  })

  it('picks the longest matching prefix, not the first', () => {
    // "claude-sonnet-4.6" must not pick up "claude-opus-4.6"'s cacheMinTokens.
    expect(cacheMinTokensFor('anthropic/claude-sonnet-4.6')).toBe(2048)
    expect(cacheMinTokensFor('anthropic/claude-opus-4.6')).toBe(4096)
  })

  it('unknown model returns undefined cacheMinTokens', () => {
    expect(cacheMinTokensFor('mistral/large')).toBeUndefined()
  })

  it('xAI Grok 3/4 allowedEffort narrows to low/medium/high', () => {
    // Plan §5.5 bundled entry: jan cross-ref confirms /chat/completions
    // rejects 'none' / 'minimal' / 'xhigh' on these models — upstream
    // clamps silently, so we hide those buttons.
    expect(allowedEffortFor('x-ai/grok-4')).toEqual(['low', 'medium', 'high'])
    expect(allowedEffortFor('x-ai/grok-3')).toEqual(['low', 'medium', 'high'])
  })

  it('DeepSeek-R1 inline reasoning + narrowed effort', () => {
    // Emits <think>…</think> inline; parser lifts to reasoning lane.
    // allowedEffort matches plan §5.5 bundled entry.
    const q = quirksFor('deepseek/deepseek-r1')
    expect(q.reasoningInlineTags).toBe(true)
    expect(q.allowedEffort).toEqual(['low', 'medium', 'high'])
  })

  it('Qwen3 inline reasoning + narrowed effort', () => {
    const q = quirksFor('qwen/qwen3-coder')
    expect(q.reasoningInlineTags).toBe(true)
    expect(q.allowedEffort).toEqual(['low', 'medium', 'high'])
  })

  it('Gemma inline tags but no effort narrowing (no reasoning knob)', () => {
    const q = quirksFor('google/gemma-3-27b')
    expect(q.reasoningInlineTags).toBe(true)
    // Gemma has no reasoning parameter; effort list falls through to superset.
    expect(q.allowedEffort).toBeUndefined()
  })

  it('o-series reasoning is hidden but effort superset unchanged', () => {
    expect(quirksFor('openai/o1').reasoningHidden).toBe(true)
    expect(quirksFor('openai/o3-mini').reasoningHidden).toBe(true)
    expect(quirksFor('openai/o4-mini').reasoningHidden).toBe(true)
  })
})
