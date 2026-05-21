import { describe, expect, it } from 'vitest'
import {
  allowedEffortFor,
  allowedVerbosityFor,
  cacheMinTokensFor,
  FULL_EFFORT,
  FULL_VERBOSITY,
  prefillClassFor,
  quirksFor,
  reasoningToggleableFor,
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
    expect(quirksFor('claude-opus-4.6').adaptiveReasoningOnly).toBeUndefined()
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
    expect(allowedEffortFor('google/gemini-3.1-pro-preview')).toEqual(['low', 'medium', 'high'])
    // Prefix match also catches -customtools variant.
    expect(allowedEffortFor('google/gemini-3.1-pro-preview-customtools')).toEqual([
      'low',
      'medium',
      'high',
    ])
    expect(allowedEffortFor('google/gemini-3.5-pro-preview')).toEqual([
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
    expect(allowedEffortFor('google/gemini-3.5-flash')).toEqual([
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
    // /chat/completions rejects 'none' / 'minimal' / 'xhigh' on these models.
    // Upstream clamps silently, so those buttons stay hidden.
    expect(allowedEffortFor('x-ai/grok-4.20')).toEqual(['low', 'medium', 'high'])
    expect(allowedEffortFor('x-ai/grok-4.1')).toEqual(['low', 'medium', 'high'])
  })

  it('classifies assistant-prefill support by model family', () => {
    expect(prefillClassFor('anthropic/claude-haiku-4.5')).toBe('native')
    expect(prefillClassFor('anthropic/claude-opus-4.7')).toBe('unsupported')
    expect(prefillClassFor('openai/gpt-5.4')).toBe('unsupported')
    expect(prefillClassFor('openai/gpt-oss-120b')).toBe('unsupported')
    expect(prefillClassFor('google/gemini-3.1-flash-lite-preview')).toBe('native')
    expect(prefillClassFor('google/gemini-3.5-flash')).toBe('native')
    expect(prefillClassFor('deepseek/deepseek-r1')).toBe('oss-reasoning-required')
    expect(prefillClassFor('z-ai/glm-5.1')).toBe('oss-toggleable')
  })

  it('marks reasoning-required models as non-toggleable', () => {
    expect(reasoningToggleableFor('deepseek/deepseek-r1')).toBe(false)
    expect(reasoningToggleableFor('google/gemini-3.1-flash-lite-preview')).toBe(false)
    expect(reasoningToggleableFor('google/gemini-3.5-flash')).toBe(false)
    expect(reasoningToggleableFor('z-ai/glm-5.1')).toBe(true)
  })

  // OSS thinking-model families fall through to the pattern-based default
  // in `quirksFor` (see OSS_THINKING_FAMILIES + GEMMA_PATTERN). Any current
  // OR future version of these labs gets the same `<think>` lifting +
  // low/medium/high effort + `unknown` preservation format without a per-
  // version registry entry. Tests below cover the family root + a couple of
  // hypothetical future versions to keep that contract stable.
  it('DeepSeek family — pattern matches all versions', () => {
    for (const slug of [
      'deepseek/deepseek-v4-pro',
      'deepseek/deepseek-v5',
      'deepseek/deepseek-r1', // legacy slug still works
    ]) {
      const q = quirksFor(slug)
      expect(q.reasoningInlineTags).toEqual(['think'])
      expect(q.allowedEffort).toEqual(['low', 'medium', 'high'])
      expect(q.reasoningPreservationFormat).toBe('unknown')
    }
  })

  it('Qwen family — pattern matches versions with no separator (qwen3, qwen3.6)', () => {
    for (const slug of ['qwen/qwen3.6-plus', 'qwen/qwen-4', 'qwen/qwen3-thinking']) {
      const q = quirksFor(slug)
      expect(q.reasoningInlineTags).toEqual(['think'])
      expect(q.allowedEffort).toEqual(['low', 'medium', 'high'])
    }
  })

  it('Kimi / GLM / MiniMax families — pattern matches future versions', () => {
    for (const slug of [
      'moonshotai/kimi-k3', // hypothetical future version
      'moonshotai/kimi-k2.6',
      'zhipuai/glm-6',
      'minimax/minimax-m3',
    ]) {
      const q = quirksFor(slug)
      expect(q.reasoningInlineTags).toEqual(['think'])
      expect(q.allowedEffort).toEqual(['low', 'medium', 'high'])
    }
  })

  it('Gemma family — uses <thought> tag and matches future versions', () => {
    for (const slug of ['google/gemma-4-31b-it', 'google/gemma-5', 'google/gemma-5-9b']) {
      const q = quirksFor(slug)
      expect(q.reasoningInlineTags).toEqual(['thought', 'think'])
      expect(q.allowedEffort).toEqual(['low', 'medium', 'high'])
    }
  })

  it('non-OSS-family slugs do NOT get the OSS default', () => {
    // Negative cases — names that look similar but aren't in the family list.
    expect(quirksFor('openai/gpt-5.4-pro').reasoningInlineTags).toBeUndefined()
    expect(quirksFor('anthropic/claude-haiku-4.5').reasoningInlineTags).toBeUndefined()
    // Pattern requires version-suffix (digit/separator/end) so a name that
    // happens to start with a family prefix but continues into letters is safe.
    expect(quirksFor('deepseekx/something').reasoningInlineTags).toBeUndefined()
  })

  it('o-series reasoning is hidden but effort superset unchanged', () => {
    expect(quirksFor('openai/o1').reasoningHidden).toBe(true)
    expect(quirksFor('openai/o3-mini').reasoningHidden).toBe(true)
    expect(quirksFor('openai/o4-mini').reasoningHidden).toBe(true)
  })
})
