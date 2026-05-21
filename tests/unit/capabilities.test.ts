import { describe, expect, it } from 'vitest'
import { resolveBundledCapability } from '../../src/capabilities'
import { DEFAULT_CUSTOM_CAPABILITY } from '../../src/capabilities/custom'
import {
  effectiveCapabilityFromDescriptor,
  effectiveCapabilityFromEndpoints,
  validateChatSettings,
} from '../../src/core/capabilities'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type { ChatSettings, ModelEndpoint } from '../../src/core/types'

function makeEndpoint(overrides: Partial<ModelEndpoint> = {}): ModelEndpoint {
  return {
    provider_name: 'OpenAI',
    supported_parameters: ['temperature', 'top_p', 'max_tokens', 'stop'],
    context_length: 128000,
    pricing: { prompt: '0.0000025', completion: '0.00001' },
    ...overrides,
  }
}

describe('effectiveCapabilityFromEndpoints', () => {
  it('collapses to the single row when one endpoint is given', () => {
    const ep = makeEndpoint()
    const cap = effectiveCapabilityFromEndpoints('openai/gpt-4o', [ep])
    expect(cap.supportedParameters.has('temperature')).toBe(true)
    expect(cap.supportedParameters.has('reasoning')).toBe(false)
    expect(cap.contextLength).toBe(128000)
    expect(cap.singleProviderPin).toBe('OpenAI')
  })

  it('unions supported_parameters across multiple endpoints by default (upper bound)', () => {
    const a = makeEndpoint({
      provider_name: 'OpenAI',
      supported_parameters: ['temperature', 'top_p', 'stop'],
    })
    const b = makeEndpoint({
      provider_name: 'Azure',
      supported_parameters: ['temperature', 'stop', 'logit_bias'],
    })
    const cap = effectiveCapabilityFromEndpoints('openai/gpt-4o', [a, b])
    expect([...cap.supportedParameters].sort()).toEqual([
      'logit_bias',
      'stop',
      'temperature',
      'top_p',
    ])
    expect(cap.singleProviderPin).toBeUndefined()
  })

  it('intersects supported_parameters in strict mode (lower bound)', () => {
    const a = makeEndpoint({
      provider_name: 'OpenAI',
      supported_parameters: ['temperature', 'top_p', 'stop'],
    })
    const b = makeEndpoint({
      provider_name: 'Azure',
      supported_parameters: ['temperature', 'stop', 'logit_bias'],
    })
    const cap = effectiveCapabilityFromEndpoints('openai/gpt-4o', [a, b], { strict: true })
    expect([...cap.supportedParameters].sort()).toEqual(['stop', 'temperature'])
  })

  it('takes max() of numeric caps across endpoints (upper bound)', () => {
    const a = makeEndpoint({ context_length: 200000, max_completion_tokens: 16000 })
    const b = makeEndpoint({ context_length: 128000, max_completion_tokens: 4096 })
    const cap = effectiveCapabilityFromEndpoints('x/y', [a, b])
    expect(cap.contextLength).toBe(200000)
    expect(cap.maxCompletionTokens).toBe(16000)
  })

  it('ignores zero numeric caps from non-token media-generation endpoints', () => {
    const cap = effectiveCapabilityFromEndpoints('google/veo-3.1-lite', [
      makeEndpoint({
        context_length: 0,
        max_prompt_tokens: 0,
        max_completion_tokens: 0,
        architecture: { output_modalities: ['video'] },
      }),
    ])
    expect(cap.contextLength).toBeUndefined()
    expect(cap.maxPromptTokens).toBeUndefined()
    expect(cap.maxCompletionTokens).toBeUndefined()
    expect(cap.outputModalities.has('video')).toBe(true)
  })

  it('uses top-level descriptor architecture when endpoint rows omit media modalities', () => {
    const cap = effectiveCapabilityFromEndpoints(
      'google/veo-3.1-lite',
      [
        makeEndpoint({
          provider_name: 'Google',
          supported_parameters: ['max_tokens', 'temperature', 'seed'],
          context_length: 0,
          max_prompt_tokens: 0,
          max_completion_tokens: 0,
        }),
      ],
      {
        architecture: {
          input_modalities: ['text', 'image'],
          output_modalities: ['video'],
        },
      },
    )
    expect(cap.inputModalities.has('image')).toBe(true)
    expect(cap.outputModalities.has('video')).toBe(true)
    expect(cap.contextLength).toBeUndefined()
  })

  it('takes min() of numeric caps in strict mode (lower bound)', () => {
    const a = makeEndpoint({ context_length: 200000, max_completion_tokens: 16000 })
    const b = makeEndpoint({ context_length: 128000, max_completion_tokens: 4096 })
    const cap = effectiveCapabilityFromEndpoints('x/y', [a, b], { strict: true })
    expect(cap.contextLength).toBe(128000)
    expect(cap.maxCompletionTokens).toBe(4096)
  })

  it('supportsImplicitCaching only when ALL endpoints support it', () => {
    const a = makeEndpoint({ supports_implicit_caching: true })
    const b = makeEndpoint({ supports_implicit_caching: true })
    const c = makeEndpoint({ supports_implicit_caching: false })
    expect(effectiveCapabilityFromEndpoints('x/y', [a, b]).supportsImplicitCaching).toBe(true)
    expect(effectiveCapabilityFromEndpoints('x/y', [a, b, c]).supportsImplicitCaching).toBe(false)
  })

  it('empty endpoints list leaves caps undefined and flags empty modalities', () => {
    const cap = effectiveCapabilityFromEndpoints('x/y', [])
    expect([...cap.supportedParameters]).toEqual([])
    expect(cap.contextLength).toBeUndefined()
    expect(cap.inputModalities.size).toBe(0)
    expect(cap.supportsImplicitCaching).toBe(false)
  })

  it('applies quirks narrowing on allowedEffort/allowedVerbosity', () => {
    const ep = makeEndpoint({
      provider_name: 'Anthropic',
      supported_parameters: ['max_tokens', 'verbosity', 'thinking'],
    })
    const cap = effectiveCapabilityFromEndpoints('anthropic/claude-opus-4.7', [ep])
    expect(cap.allowedEffort).toEqual([])
    // 4.7 supports all four extension levels — xhigh (4.7-exclusive) and
    // max (inherited from 4.6+). See llms-full.txt line 18451.
    expect(cap.allowedVerbosity).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(cap.quirks.adaptiveReasoningOnly).toBe(true)
  })

  it('aggregates pricing range from multiple endpoints', () => {
    const a = makeEndpoint({ pricing: { prompt: '0.001', completion: '0.003' } })
    const b = makeEndpoint({ pricing: { prompt: '0.002', completion: '0.004' } })
    const cap = effectiveCapabilityFromEndpoints('x/y', [a, b])
    expect(cap.pricingMin?.prompt).toBe(0.001)
    expect(cap.pricingRange?.prompt).toEqual({ min: 0.001, max: 0.002 })
  })
})

describe('effectiveCapabilityFromDescriptor', () => {
  it('translates a bundled descriptor into the same shape', () => {
    const cap = effectiveCapabilityFromDescriptor('custom/model', DEFAULT_CUSTOM_CAPABILITY)
    expect(cap.supportedParameters.has('temperature')).toBe(true)
    expect(cap.supportedParameters.has('reasoning')).toBe(true)
    expect(cap.supportedParameters.has('tools')).toBe(true)
    expect(cap.outputModalities.has('text')).toBe(true)
  })
})

describe('resolveBundledCapability', () => {
  it('returns the permissive default for unknown custom-kind model', () => {
    const cap = resolveBundledCapability(
      {
        id: 'p',
        name: 'Custom',
        kind: 'custom',
        baseUrl: 'http://localhost:11434/v1',
        apiKeyRef: 'k',
        defaultHeaders: {},
        appTitle: '',
        appUrl: '',
        supportsEndpointsApi: false,
        supportsGenerationApi: false,
        supportsPrivacyScrape: false,
        createdAt: 0,
        updatedAt: 0,
      },
      'some/unknown-model',
    )
    expect(cap.supportedParameters).toContain('temperature')
    expect(cap.supportedParameters).toContain('reasoning')
  })

  it('applies ConnectionProfile.capabilityOverrides', () => {
    const cap = resolveBundledCapability(
      {
        id: 'p',
        name: 'OpenAI',
        kind: 'openai-compatible',
        baseUrl: 'https://api.openai.com/v1',
        apiKeyRef: 'k',
        defaultHeaders: {},
        appTitle: '',
        appUrl: '',
        supportsEndpointsApi: false,
        supportsGenerationApi: false,
        supportsPrivacyScrape: false,
        capabilityOverrides: {
          'gpt-4o': {
            maxCompletionTokens: 8192,
            pricing: { prompt: '0.00001' },
          },
        },
        createdAt: 0,
        updatedAt: 0,
      },
      'gpt-4o',
    )
    expect(cap.maxCompletionTokens).toBe(8192)
    expect(cap.pricing?.prompt).toBe('0.00001')
    // Override does not wipe the bundled completion pricing:
    expect(cap.pricing?.completion).toBe('0.00001')
  })

  it('matches Anthropic compatibility ids that use hyphens instead of dots', () => {
    const cap = resolveBundledCapability(
      {
        id: 'p',
        name: 'Anthropic',
        kind: 'anthropic',
        baseUrl: 'https://api.anthropic.com/v1',
        apiKeyRef: 'k',
        defaultHeaders: {},
        appTitle: '',
        appUrl: '',
        supportsEndpointsApi: false,
        supportsGenerationApi: false,
        supportsPrivacyScrape: false,
        createdAt: 0,
        updatedAt: 0,
      },
      'claude-opus-4-7',
    )
    expect(cap.supportedParameters).toContain('thinking')
    expect(cap.maxCompletionTokens).toBe(32000)
  })

  it('matches versioned Anthropic compatibility ids instead of falling back to custom defaults', () => {
    const cap = resolveBundledCapability(
      {
        id: 'p',
        name: 'Anthropic',
        kind: 'anthropic',
        baseUrl: 'https://api.anthropic.com/v1',
        apiKeyRef: 'k',
        defaultHeaders: {},
        appTitle: '',
        appUrl: '',
        supportsEndpointsApi: false,
        supportsGenerationApi: false,
        supportsPrivacyScrape: false,
        createdAt: 0,
        updatedAt: 0,
      },
      'claude-haiku-4-5-20251001',
    )
    expect(cap.supportedParameters).not.toContain('reasoning')
    expect(cap.supportedParameters).toContain('stop_sequences')
    expect(cap.maxCompletionTokens).toBe(8192)
  })

  it('advertises Gemini thinking without exposing OpenAI reasoning on Google direct', () => {
    const cap = resolveBundledCapability(
      {
        id: 'p',
        name: 'Google',
        kind: 'google',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        apiKeyRef: 'k',
        defaultHeaders: {},
        appTitle: '',
        appUrl: '',
        supportsEndpointsApi: false,
        supportsGenerationApi: false,
        supportsPrivacyScrape: false,
        createdAt: 0,
        updatedAt: 0,
      },
      'gemini-2.5-flash',
    )
    expect(cap.supportedParameters).not.toContain('reasoning')
    expect(cap.supportedParameters).toContain('thinking')
  })

  it('bundles Gemini 3.5 Flash for Google direct profiles', () => {
    const cap = resolveBundledCapability(
      {
        id: 'p',
        name: 'Google',
        kind: 'google',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        apiKeyRef: 'k',
        defaultHeaders: {},
        appTitle: '',
        appUrl: '',
        supportsEndpointsApi: false,
        supportsGenerationApi: false,
        supportsPrivacyScrape: false,
        createdAt: 0,
        updatedAt: 0,
      },
      'gemini-3.5-flash',
    )
    expect(cap.supportedParameters).toContain('thinking')
    expect(cap.maxCompletionTokens).toBe(65536)
    expect(cap.contextLength).toBe(1_048_576)
  })
})

describe('validateChatSettings', () => {
  function baseSettings(): ChatSettings {
    return cloneDefaultChatSettings()
  }

  it('drops stored sampling keys not in supported_parameters', () => {
    const s: ChatSettings = {
      ...baseSettings(),
      sampling: { temperature: 0.7, top_k: 40, frequency_penalty: 0.1 },
    }
    const ep = makeEndpoint({ supported_parameters: ['temperature', 'top_p'] })
    const cap = effectiveCapabilityFromEndpoints('x', [ep])
    const result = validateChatSettings(s, cap)
    expect(result.changed).toBe(true)
    expect(result.settings.sampling).toEqual({ temperature: 0.7 })
    expect(result.issues.map((i) => i.field)).toEqual(
      expect.arrayContaining(['sampling.top_k', 'sampling.frequency_penalty']),
    )
  })

  it('clamps reasoning.effort to the allowed subset, preferring the closest value', () => {
    const s: ChatSettings = {
      ...baseSettings(),
      reasoning: { ...baseSettings().reasoning, effort: 'xhigh' },
    }
    const ep = makeEndpoint({ supported_parameters: ['reasoning'] })
    const cap = effectiveCapabilityFromEndpoints('google/gemini-3.1-pro', [ep])
    const result = validateChatSettings(s, cap)
    expect(result.changed).toBe(true)
    expect(result.settings.reasoning.effort).toBe('high')
  })

  it('drops reasoning.effort entirely on adaptive-only models', () => {
    const s: ChatSettings = {
      ...baseSettings(),
      reasoning: { ...baseSettings().reasoning, effort: 'medium' },
    }
    const ep = makeEndpoint({
      provider_name: 'Anthropic',
      supported_parameters: ['max_tokens', 'reasoning', 'verbosity'],
    })
    const cap = effectiveCapabilityFromEndpoints('anthropic/claude-opus-4.7', [ep])
    const result = validateChatSettings(s, cap)
    expect(result.settings.reasoning.effort).toBeUndefined()
    expect(result.issues.some((i) => i.field === 'reasoning.effort')).toBe(true)
  })

  it('clamps reasoning.mode=off away from reasoning-required models', () => {
    const s: ChatSettings = {
      ...baseSettings(),
      model: 'deepseek/deepseek-r1',
      reasoning: { ...baseSettings().reasoning, mode: 'off' },
    }
    const ep = makeEndpoint({ supported_parameters: ['reasoning'] })
    const cap = effectiveCapabilityFromEndpoints('deepseek/deepseek-r1', [ep])
    const result = validateChatSettings(s, cap)
    expect(result.changed).toBe(true)
    expect(result.settings.reasoning.mode).toBe('enabled')
    expect(result.issues.some((i) => i.field === 'reasoning.mode')).toBe(true)
  })

  it('clamps reasoning.mode=off away from Gemini models', () => {
    const s: ChatSettings = {
      ...baseSettings(),
      model: 'google/gemini-3.1-flash-lite-preview',
      reasoning: { ...baseSettings().reasoning, mode: 'off' },
    }
    const ep = makeEndpoint({ supported_parameters: ['reasoning'] })
    const cap = effectiveCapabilityFromEndpoints('google/gemini-3.1-flash-lite-preview', [ep])
    const result = validateChatSettings(s, cap)
    expect(result.changed).toBe(true)
    expect(result.settings.reasoning.mode).toBe('enabled')
    expect(result.issues.some((i) => i.field === 'reasoning.mode')).toBe(true)
  })

  it('drops verbosity when supported_parameters lacks it', () => {
    const s: ChatSettings = { ...baseSettings(), verbosity: 'high' }
    const ep = makeEndpoint({ supported_parameters: ['temperature'] })
    const cap = effectiveCapabilityFromEndpoints('x', [ep])
    const result = validateChatSettings(s, cap)
    expect(result.settings.verbosity).toBeUndefined()
    expect(result.issues[0]?.field).toBe('verbosity')
  })

  it('clamps maxCompletionTokens to the live cap', () => {
    const s: ChatSettings = { ...baseSettings(), maxCompletionTokens: 50000 }
    const ep = makeEndpoint({
      supported_parameters: ['max_tokens'],
      max_completion_tokens: 16384,
    })
    const cap = effectiveCapabilityFromEndpoints('x', [ep])
    const result = validateChatSettings(s, cap)
    expect(result.settings.maxCompletionTokens).toBe(16384)
  })

  it('is a no-op when everything is already valid', () => {
    const s: ChatSettings = {
      ...baseSettings(),
      sampling: { temperature: 0.7 },
      verbosity: 'medium',
    }
    const ep = makeEndpoint({
      supported_parameters: ['temperature', 'verbosity'],
    })
    const cap = effectiveCapabilityFromEndpoints('x', [ep])
    const result = validateChatSettings(s, cap)
    expect(result.changed).toBe(false)
    expect(result.settings).toBe(s)
  })
})
