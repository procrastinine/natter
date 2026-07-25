import { describe, expect, it } from 'vitest'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import {
  rebaseEffectiveEndpointRouting,
  resolveEffectiveEndpointRouting,
} from '../../src/core/effective-endpoint-routing'
import type { PrivacyFilterResult, WireProviderPrivacy } from '../../src/core/privacy-filter'
import { EMPTY_MESSAGE_CONTEXT_ROUTE_FACTS } from '../../src/core/reasoning'
import type {
  CapabilityDescriptor,
  ChatSettings,
  ConnectionProfile,
  EndpointsDescriptor,
  ModelEndpoint,
} from '../../src/core/types'

function profile(kind: ConnectionProfile['kind'] = 'openrouter'): ConnectionProfile {
  return {
    id: 'profile',
    name: 'Test',
    kind,
    baseUrl:
      kind === 'openrouter'
        ? 'https://openrouter.ai/api/v1'
        : kind === 'google'
          ? 'https://generativelanguage.googleapis.com/v1beta'
          : 'https://example.test/v1',
    defaultHeaders: {},
    appTitle: '',
    appUrl: '',
    supportsEndpointsApi: kind === 'openrouter',
    supportsGenerationApi: false,
    supportsPrivacyScrape: false,
    createdAt: 0,
    updatedAt: 0,
  }
}

function settings(patch: Partial<ChatSettings> = {}): ChatSettings {
  return {
    ...cloneDefaultChatSettings(),
    profileId: 'profile',
    model: 'z-ai/glm-5.1',
    ...patch,
  }
}

function endpoint(
  provider_slug: string,
  supported_parameters: string[] = ['temperature'],
  patch: Partial<ModelEndpoint> = {},
): ModelEndpoint {
  return {
    provider_name: provider_slug,
    provider_slug,
    supported_parameters,
    context_length: 128_000,
    pricing: {},
    ...patch,
  }
}

function descriptor(endpoints: ModelEndpoint[]): EndpointsDescriptor {
  return { modelId: 'z-ai/glm-5.1', endpoints }
}

function resolveOpenRouter(input: {
  endpoints: ModelEndpoint[]
  settings?: ChatSettings
  wire?: WireProviderPrivacy
  filter?: PrivacyFilterResult
  indexedEndpoint?: (endpoint: ModelEndpoint) => void
  selectedEndpoint?: (endpoint: ModelEndpoint) => void
}) {
  return resolveEffectiveEndpointRouting({
    profile: profile(),
    settings: input.settings ?? settings(),
    contextFacts: EMPTY_MESSAGE_CONTEXT_ROUTE_FACTS,
    descriptor: descriptor(input.endpoints),
    ...(input.wire === undefined ? {} : { providerWire: input.wire }),
    ...(input.filter === undefined ? {} : { filter: input.filter }),
    ...(input.selectedEndpoint || input.indexedEndpoint
      ? {
          workProbe: {
            indexedEndpoint: input.indexedEndpoint ?? (() => {}),
            selectedEndpoint: input.selectedEndpoint ?? (() => {}),
          },
        }
      : {}),
  })
}

describe('effective endpoint routing', () => {
  it('gives an exact provider slug precedence over a colliding display candidate', () => {
    const exact = endpoint('foo', ['temperature'], { provider_name: 'Exact' })
    const collision = endpoint('bar', ['top_p'], { provider_name: 'foo' })
    const routing = resolveOpenRouter({
      endpoints: [exact, collision],
      wire: { only: ['foo'], zeroEligible: false },
    })
    expect(routing.selectedEndpoints).toEqual([exact])
    expect([...routing.capability!.supportedParameters]).toEqual(['temperature'])
  })

  it('applies ignore before only and blocks an unknown-only selection', () => {
    const a = endpoint('a')
    const b = endpoint('b')
    const selected = resolveOpenRouter({
      endpoints: [a, b],
      wire: { only: ['a', 'b'], ignore: ['a'], zeroEligible: false },
    })
    expect(selected.selectedEndpoints).toEqual([b])
    expect(selected.providerWire).toMatchObject({ only: ['b'], ignore: ['a'] })

    const missing = resolveOpenRouter({
      endpoints: [a, b],
      wire: { only: ['missing'], zeroEligible: false },
    })
    expect(missing.selectedEndpoints).toEqual([])
    expect(missing.endpointAvailability).toBe('filtered-empty')
    expect(missing.providerWire?.zeroEligible).toBe(true)
  })

  it('distinguishes an empty catalog from endpoints removed by routing', () => {
    const empty = resolveOpenRouter({ endpoints: [] })
    expect(empty.endpointAvailability).toBe('catalog-empty')
    expect(empty.catalogCapability).toBeNull()
    expect(empty.providerWire?.zeroEligible).toBe(false)

    const available = endpoint('available', ['temperature'])
    const filtered = resolveOpenRouter({
      endpoints: [available],
      wire: { only: ['missing'], zeroEligible: false },
    })
    expect(filtered.endpointAvailability).toBe('filtered-empty')
    expect(filtered.capability).toBeNull()
    expect([...(filtered.catalogCapability?.supportedParameters ?? [])]).toEqual(['temperature'])
    expect(filtered.providerWire?.zeroEligible).toBe(true)
  })

  it('keeps training denial hard even when the picker owns selection', () => {
    const denied = endpoint('training')
    const allowed = endpoint('allowed')
    const filter: PrivacyFilterResult = {
      model: 'z-ai/glm-5.1',
      kept: [{ endpoint: structuredClone(allowed), policy: undefined, policySynthesized: false }],
      excluded: [
        {
          endpoint: structuredClone(denied),
          policy: undefined,
          policySynthesized: false,
          reasons: ['training'],
        },
      ],
      zeroEligible: false,
    }
    const routing = resolveOpenRouter({
      endpoints: [denied, allowed],
      settings: settings({
        providerPrefs: { ignoreOverridesFilter: true, only: ['training', 'allowed'] },
      }),
      filter,
      wire: { only: ['training', 'allowed'], zeroEligible: false },
    })
    expect(routing.selectedEndpoints).toEqual([allowed])
    expect(routing.providerWire).toMatchObject({ only: ['allowed'], ignore: ['training'] })
  })

  it('fails closed when privacy evidence belongs to another model', () => {
    const allowed = endpoint('allowed')
    const routing = resolveOpenRouter({
      endpoints: [allowed],
      settings: settings({ providerPrefs: { ignoreOverridesFilter: true } }),
      filter: {
        model: 'other/model',
        kept: [{ endpoint: allowed, policy: undefined, policySynthesized: false }],
        excluded: [],
        zeroEligible: false,
      },
    })
    expect(routing.selectedEndpoints).toEqual([])
    expect(routing.endpointAvailability).toBe('filtered-empty')
  })

  it('unions selected endpoint parameters normally and intersects them in strict mode', () => {
    const endpoints = [endpoint('a', ['temperature', 'top_p']), endpoint('b', ['temperature'])]
    const normal = resolveOpenRouter({ endpoints })
    const strict = resolveOpenRouter({
      endpoints,
      settings: settings({ strictProviderRouting: true }),
    })
    expect([...normal.capability!.supportedParameters].sort()).toEqual(['temperature', 'top_p'])
    expect([...strict.capability!.supportedParameters]).toEqual(['temperature'])
  })

  it('uses transport-only OpenRouter prefill and typed direct endpoint markers', () => {
    const openRouter = resolveOpenRouter({ endpoints: [endpoint('a')] })
    expect(openRouter.prefillPlan).toMatchObject({
      availability: 'supported',
      basis: 'transport',
      serialization: { kind: 'assistant-tail', marker: 'none' },
      semanticRetry: 'never',
    })

    const directCapability: CapabilityDescriptor = {
      supportedParameters: [],
      streaming: 'supported',
      prefill: { kind: 'assistant-tail', marker: 'prefix' },
    }
    const direct = resolveEffectiveEndpointRouting({
      profile: profile('custom'),
      settings: settings(),
      contextFacts: EMPTY_MESSAGE_CONTEXT_ROUTE_FACTS,
      capability: directCapability,
    })
    expect(direct.prefillPlan).toMatchObject({
      availability: 'supported',
      basis: 'endpoint-capability',
      serialization: { kind: 'assistant-tail', marker: 'prefix' },
    })
  })

  it('keeps the exact Gemini exceptions separate from supported Gemini prefill', () => {
    for (const model of ['google/gemini-3.6-flash', 'google/gemini-3.5-flash-lite']) {
      const routing = resolveEffectiveEndpointRouting({
        profile: profile('google'),
        settings: settings({ model }),
        contextFacts: EMPTY_MESSAGE_CONTEXT_ROUTE_FACTS,
        capability: { supportedParameters: [], streaming: 'supported' },
      })
      expect(routing.prefillPlan).toMatchObject({
        availability: 'unsupported',
        basis: 'model-quirk',
      })
    }
    const supported = resolveEffectiveEndpointRouting({
      profile: profile('google'),
      settings: settings({ model: 'google/gemini-3.5-flash' }),
      contextFacts: EMPTY_MESSAGE_CONTEXT_ROUTE_FACTS,
      capability: { supportedParameters: [], streaming: 'supported' },
    })
    expect(supported.prefillPlan).toMatchObject({
      availability: 'supported',
      serialization: { kind: 'native-model-tail' },
    })

    const endpointDenied = resolveEffectiveEndpointRouting({
      profile: profile('google'),
      settings: settings({ model: 'google/gemini-3.5-flash' }),
      contextFacts: EMPTY_MESSAGE_CONTEXT_ROUTE_FACTS,
      capability: {
        supportedParameters: [],
        streaming: 'supported',
        prefill: { kind: 'unsupported' },
      },
    })
    expect(endpointDenied.prefillPlan).toMatchObject({
      availability: 'unsupported',
      basis: 'endpoint-capability',
    })
  })

  it('rebases route context without revisiting endpoint evidence', () => {
    let visits = 0
    const routing = resolveOpenRouter({
      endpoints: [endpoint('a'), endpoint('b')],
      selectedEndpoint: () => {
        visits += 1
      },
    })
    expect(visits).toBe(2)
    const rebased = rebaseEffectiveEndpointRouting(routing, EMPTY_MESSAGE_CONTEXT_ROUTE_FACTS)
    expect(visits).toBe(2)
    expect(rebased.selectedEndpoints).toBe(routing.selectedEndpoints)
    expect(rebased.capability).toBe(routing.capability)
  })

  it('does exactly one capability visit per selected row at 10,000 endpoints', () => {
    const endpoints = Array.from({ length: 10_000 }, (_, index) => endpoint(`provider-${index}`))
    let indexed = 0
    let visits = 0
    const routing = resolveOpenRouter({
      endpoints,
      indexedEndpoint: () => {
        indexed += 1
      },
      selectedEndpoint: () => {
        visits += 1
      },
    })
    expect(indexed).toBe(10_000)
    expect(visits).toBe(10_000)
    expect(routing.selectedEndpoints).toHaveLength(10_000)
  })
})
