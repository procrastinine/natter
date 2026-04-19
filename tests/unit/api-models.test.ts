import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchEndpoints, fetchModels, fetchProviders } from '../../src/api/models'
import {
  normalizeEndpoint,
  normalizeEndpointsResponse,
  normalizeModelsResponse,
} from '../../src/api/providers'
import type { ConnectionProfile } from '../../src/core/types'

function makeProfile(overrides: Partial<ConnectionProfile> = {}): ConnectionProfile {
  return {
    id: 'p',
    name: 'OpenRouter',
    kind: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyRef: 'k',
    defaultHeaders: {},
    appTitle: 'llm-api-frontend',
    appUrl: 'http://localhost:5173',
    usesResponsesApiByDefault: false,
    supportsEndpointsApi: true,
    supportsGenerationApi: true,
    supportsPrivacyScrape: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('normalizeEndpoint', () => {
  it('returns null for rows missing required fields', () => {
    expect(normalizeEndpoint(null)).toBeNull()
    expect(normalizeEndpoint({ provider_name: 'x' })).toBeNull()
    expect(normalizeEndpoint({ provider_name: 'x', context_length: 1 })).toBeNull()
  })

  it('normalizes a fully-populated row', () => {
    const normalized = normalizeEndpoint({
      provider_name: 'Azure',
      supported_parameters: ['temperature'],
      context_length: 128000,
      max_prompt_tokens: 120000,
      max_completion_tokens: 16000,
      pricing: { prompt: '0.0000025', completion: '0.00001' },
      supports_implicit_caching: true,
      latency_last_30m: { p50: 1.2, p99: 5.4 },
      architecture: {
        input_modalities: ['text', 'image'],
        output_modalities: ['text'],
        tokenizer: 'cl100k_base',
      },
    })
    expect(normalized).toMatchObject({
      provider_name: 'Azure',
      context_length: 128000,
      supports_implicit_caching: true,
      latency_last_30m: { p50: 1.2, p99: 5.4 },
    })
    expect(normalized?.architecture?.input_modalities).toEqual(['text', 'image'])
  })
})

describe('normalizeEndpointsResponse', () => {
  it('unwraps the `data` envelope', () => {
    const desc = normalizeEndpointsResponse({
      data: {
        id: 'openai/gpt-4o',
        name: 'GPT-4o',
        context_length: 128000,
        endpoints: [
          {
            provider_name: 'Azure',
            supported_parameters: ['temperature'],
            context_length: 128000,
            pricing: {},
          },
        ],
      },
    })
    expect(desc?.modelId).toBe('openai/gpt-4o')
    expect(desc?.endpoints).toHaveLength(1)
  })

  it('returns null when id is missing', () => {
    expect(normalizeEndpointsResponse({})).toBeNull()
  })

  it('skips endpoint rows that fail to normalize', () => {
    const desc = normalizeEndpointsResponse({
      id: 'x',
      endpoints: [
        null,
        {
          provider_name: 'OK',
          supported_parameters: ['temperature'],
          context_length: 1,
          pricing: {},
        },
      ],
    })
    expect(desc?.endpoints).toHaveLength(1)
  })
})

describe('normalizeModelsResponse', () => {
  it('extracts model ids + capability fields', () => {
    const models = normalizeModelsResponse({
      data: [
        {
          id: 'openai/gpt-4o',
          name: 'GPT-4o',
          context_length: 128000,
          supported_parameters: ['temperature', 'top_p'],
          architecture: { input_modalities: ['text', 'image'] },
          pricing: { prompt: '0.0000025' },
          default_parameters: { temperature: 0.7 },
        },
        { id: 'anthropic/claude-opus-4.7' },
        { bogus: true },
      ],
    })
    expect(models).toHaveLength(2)
    expect(models[0]?.supportedParameters).toEqual(['temperature', 'top_p'])
    expect(models[0]?.architecture?.inputModalities).toEqual(['text', 'image'])
    expect(models[0]?.defaultParameters).toEqual({ temperature: 0.7 })
    expect(models[1]?.id).toBe('anthropic/claude-opus-4.7')
  })

  it('returns [] for malformed input', () => {
    expect(normalizeModelsResponse(null)).toEqual([])
    expect(normalizeModelsResponse({ data: 'nope' })).toEqual([])
  })
})

describe('fetch adapters', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('fetchModels builds the right URL and passes auth', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ data: [] }))
    await fetchModels(
      { profile: makeProfile(), apiKey: 'sk-test' },
      { output_modalities: 'text,image' },
    )
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0] ?? []
    expect(url).toBe('https://openrouter.ai/api/v1/models?output_modalities=text%2Cimage')
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer sk-test')
  })

  it('fetchEndpoints uses the model id in the URL', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ data: { id: 'x' } }))
    await fetchEndpoints({ profile: makeProfile(), apiKey: 'sk-test' }, 'anthropic/claude-opus-4.7')
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      'https://openrouter.ai/api/v1/models/anthropic/claude-opus-4.7/endpoints',
    )
  })

  it('fetchProviders hits the /providers endpoint', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ data: [] }))
    await fetchProviders({ profile: makeProfile(), apiKey: 'sk-test' })
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('https://openrouter.ai/api/v1/providers')
  })

  it('raises an ApiError on non-2xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 429, message: 'slow down' } }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      }),
    )
    await expect(fetchModels({ profile: makeProfile(), apiKey: 'sk-test' })).rejects.toThrow()
  })
})
