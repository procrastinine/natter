import { describe, expect, it } from 'vitest'
import {
  endpointMatchesProviderRef,
  providerDisplayLabel,
  providerDisplayName,
  providerEndpointKey,
  providerRoutingRef,
  resolveProviderRefsToRoutingRefs,
} from '../../src/core/provider-identity'
import type { ModelEndpoint } from '../../src/core/types'

function ep(overrides: Partial<ModelEndpoint>): ModelEndpoint {
  return {
    provider_name: 'Anthropic',
    supported_parameters: ['temperature'],
    context_length: 200_000,
    pricing: {},
    ...overrides,
  }
}

function endpointAt(endpoints: readonly ModelEndpoint[], index: number): ModelEndpoint {
  const endpoint = endpoints[index]
  if (!endpoint) throw new Error(`missing endpoint at index ${index}`)
  return endpoint
}

describe('provider identity helpers', () => {
  it('uses provider_slug as the canonical routing ref and endpoint key', () => {
    const endpoint = ep({
      provider_display_name: 'Anthropic',
      provider_slug: 'anthropic/2',
      provider_model_id: 'claude-opus-4-7',
      id: 'endpoint-row-id',
    })
    expect(providerDisplayName(endpoint)).toBe('Anthropic')
    expect(providerRoutingRef(endpoint)).toBe('anthropic/2')
    expect(providerEndpointKey(endpoint)).toBe('anthropic/2')
    expect(endpointMatchesProviderRef(endpoint, 'Anthropic')).toBe(true)
    expect(endpointMatchesProviderRef(endpoint, 'anthropic/2')).toBe(true)
    expect(endpointMatchesProviderRef(endpoint, 'claude-opus-4-7')).toBe(true)
  })

  it('expands legacy display-name refs while preserving unknown refs', () => {
    const endpoints = [
      ep({ provider_slug: 'anthropic/2' }),
      ep({ provider_slug: 'anthropic' }),
      ep({ provider_name: 'Amazon Bedrock', provider_slug: 'amazon-bedrock' }),
    ]
    expect(resolveProviderRefsToRoutingRefs(endpoints, ['Anthropic'])).toEqual([
      'anthropic/2',
      'anthropic',
    ])
    expect(
      resolveProviderRefsToRoutingRefs(endpoints, ['Anthropic', 'missing-host'], {
        preserveUnknown: true,
      }),
    ).toEqual(['anthropic/2', 'anthropic', 'missing-host'])
  })

  it('treats exact live slugs as endpoint refs before legacy display-name fallback', () => {
    const endpoints = [
      ep({ provider_slug: 'anthropic/2' }),
      ep({ provider_slug: 'anthropic' }),
    ]
    expect(endpointMatchesProviderRef(endpointAt(endpoints, 0), 'anthropic', endpoints)).toBe(false)
    expect(endpointMatchesProviderRef(endpointAt(endpoints, 1), 'anthropic', endpoints)).toBe(true)
    expect(resolveProviderRefsToRoutingRefs(endpoints, ['anthropic'])).toEqual(['anthropic'])
    expect(resolveProviderRefsToRoutingRefs(endpoints, ['Anthropic'])).toEqual([
      'anthropic/2',
      'anthropic',
    ])
  })

  it('disambiguates duplicate display labels with the endpoint key', () => {
    const endpoints = [ep({ provider_slug: 'anthropic/2' }), ep({ provider_slug: 'anthropic' })]
    expect(providerDisplayLabel(endpointAt(endpoints, 0), endpoints)).toBe('Anthropic (anthropic/2)')
    expect(providerDisplayLabel(endpointAt(endpoints, 1), endpoints)).toBe('Anthropic (anthropic)')
  })
})
