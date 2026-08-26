import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AssistantPlanningResources } from '../../src/core/assistant-planning-resources'
import { DEV_CORS_PROXY_URL } from '../../src/core/cors-proxy'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type { Chat, ConnectionProfile, DataPolicy, EndpointsDescriptor } from '../../src/core/types'
import {
  buildPrivacyForSendResult,
  PrivacyDiscoveryUnavailableError,
  resolvePrivacyForSend,
} from '../../src/store/request-privacy-planning'

const cloneDefaultPrivacyPrefs = () => cloneDefaultChatSettings().privacy

afterEach(() => {
  vi.useRealTimers()
})

describe('request privacy planning', () => {
  it('skips discovery for non-OpenRouter connections', async () => {
    const resources = planningResources(descriptor(), {})
    const result = await resolvePrivacyForSend({
      chat: chat(),
      profile: profile('openai-compatible'),
      resources,
    })

    expect(result.applicable).toBe(false)
    expect(result.wire).toBeNull()
    expect(resources.resolveEndpoints).not.toHaveBeenCalled()
    expect(resources.resolvePrivacy).not.toHaveBeenCalled()
  })

  it('resolves endpoint capability but skips privacy discovery and provider routing for free models', async () => {
    const resources = planningResources(descriptor(), {})
    const result = await resolvePrivacyForSend({
      chat: chat({ model: 'deepseek/deepseek-r1:free' }),
      profile: profile(),
      resources,
    })

    expect(result.applicable).toBe(false)
    expect(resources.resolveEndpoints).toHaveBeenCalledOnce()
    const endpointCall = vi.mocked(resources.resolveEndpoints).mock.calls[0]
    expect(endpointCall?.[0]).toBe('deepseek/deepseek-r1:free')
    expect(endpointCall?.[1]?.signal).toBeInstanceOf(AbortSignal)
    expect(resources.resolvePrivacy).not.toHaveBeenCalled()
  })

  it('resolves endpoints and policies through the captured planning resources', async () => {
    const resources = planningResources(descriptor(), {
      azure: policy(),
      openai: policy({ retainsPrompts: true, requiresUserIDs: true }),
    })
    const result = await resolvePrivacyForSend({ chat: chat(), profile: profile(), resources })

    const endpointCall = vi.mocked(resources.resolveEndpoints).mock.calls[0]
    expect(endpointCall?.[0]).toBe('openai/gpt-5.4')
    expect(endpointCall?.[1]?.signal).toBeInstanceOf(AbortSignal)
    const privacyCall = vi.mocked(resources.resolvePrivacy).mock.calls[0]
    expect(privacyCall?.[0]).toBe('openai/gpt-5.4')
    expect(privacyCall?.[1].refresh).toBe(true)
    expect(privacyCall?.[1].signal).toBeInstanceOf(AbortSignal)
    expect(result.filter?.kept.map((row) => row.endpoint.provider_name)).toEqual(['Azure'])
    expect(result.wire?.ignore).toContain('openai')
    expect(result.wire?.data_collection).toBe('deny')
  })

  it('does not request a live scrape when the captured proxy is disabled', async () => {
    const resources = planningResources(descriptor(), {}, { proxyUrl: '' })

    await resolvePrivacyForSend({ chat: chat(), profile: profile(), resources })

    const privacyCall = vi.mocked(resources.resolvePrivacy).mock.calls[0]
    expect(privacyCall?.[0]).toBe('openai/gpt-5.4')
    expect(privacyCall?.[1].refresh).toBe(false)
    expect(privacyCall?.[1].signal).toBeInstanceOf(AbortSignal)
  })

  it('does not request a scrape when every endpoint embeds a data policy', async () => {
    const embedded = descriptor([
      endpoint('Azure', 'azure', { data_policy: policy() }),
      endpoint('OpenAI', 'openai', { data_policy: policy() }),
    ])
    const resources = planningResources(embedded, {})

    await resolvePrivacyForSend({ chat: chat(), profile: profile(), resources })

    const privacyCall = vi.mocked(resources.resolvePrivacy).mock.calls[0]
    expect(privacyCall?.[0]).toBe('openai/gpt-5.4')
    expect(privacyCall?.[1].refresh).toBe(false)
    expect(privacyCall?.[1].signal).toBeInstanceOf(AbortSignal)
  })

  it('blocks the send when endpoint discovery fails', async () => {
    const resources = planningResources(descriptor(), {})
    vi.mocked(resources.resolveEndpoints).mockRejectedValueOnce(new Error('network down'))

    await expect(
      resolvePrivacyForSend({ chat: chat(), profile: profile(), resources }),
    ).rejects.toBeInstanceOf(PrivacyDiscoveryUnavailableError)
  })

  it('applies the send deadline without mutating the shared resource promise', async () => {
    vi.useFakeTimers()
    const resources = planningResources(descriptor(), {})
    const shared = new Promise<EndpointsDescriptor | null>(() => {})
    vi.mocked(resources.resolveEndpoints).mockReturnValueOnce(shared)
    const pending = resolvePrivacyForSend({ chat: chat(), profile: profile(), resources })
    const rejection = expect(pending).rejects.toBeInstanceOf(PrivacyDiscoveryUnavailableError)

    await vi.advanceTimersByTimeAsync(15_000)

    await rejection
    expect(resources.resolveEndpoints).toHaveBeenCalledOnce()
  })

  it('lets an aborted send stop waiting through the resource boundary', async () => {
    const resources = planningResources(descriptor(), {})
    vi.mocked(resources.resolveEndpoints).mockReturnValueOnce(
      new Promise<EndpointsDescriptor | null>(() => {}),
    )
    const controller = new AbortController()
    const pending = resolvePrivacyForSend({
      chat: chat(),
      profile: profile(),
      resources,
      signal: controller.signal,
    })

    controller.abort()

    await expect(pending).rejects.toBeInstanceOf(PrivacyDiscoveryUnavailableError)
    const operationSignal = vi.mocked(resources.resolveEndpoints).mock.calls[0]?.[1]?.signal
    expect(operationSignal).not.toBe(controller.signal)
    expect(operationSignal?.aborted).toBe(true)
    expect(operationSignal?.reason).toBe(controller.signal.reason)
  })

  it('flags zero eligible when every endpoint trains on prompts', () => {
    const policies = {
      azure: policy({ training: true, retainsPrompts: true }),
      openai: policy({ training: true, retainsPrompts: true }),
    }

    const result = buildPrivacyForSendResult({
      chat: chat(),
      profile: profile(),
      facts: { descriptor: descriptor(), policies, offlineFallback: false },
    })

    expect(result.filter?.zeroEligible).toBe(true)
    expect(result.wire?.zeroEligible).toBe(true)
  })

  it('uses an explicit provider ignore list verbatim after the user touches the picker', () => {
    const selected = chat()
    selected.settings.providerPrefs = {
      ignore: ['openai'],
      only: ['azure'],
      order: ['azure'],
      ignoreOverridesFilter: true,
    }
    const result = buildPrivacyForSendResult({
      chat: selected,
      profile: profile(),
      facts: {
        descriptor: descriptor(),
        policies: { azure: policy(), openai: policy() },
        offlineFallback: false,
      },
    })

    expect(result.wire?.ignore).toEqual(['openai'])
    expect(result.wire?.only).toEqual(['azure'])
    expect(result.wire?.order).toEqual(['azure'])
  })

  it('does not refresh provider discovery after the user owns the checked set', async () => {
    const selected = chat()
    selected.settings.providerPrefs = {
      ignore: ['openai'],
      order: ['azure'],
      ignoreOverridesFilter: true,
    }
    const resources = planningResources(descriptor(), {
      azure: policy(),
      openai: policy({ retainsPrompts: true, retentionDays: 30, requiresUserIDs: true }),
    })

    const result = await resolvePrivacyForSend({
      chat: selected,
      profile: profile(),
      resources,
    })

    const endpointCall = vi.mocked(resources.resolveEndpoints).mock.calls[0]
    expect(endpointCall?.[0]).toBe('openai/gpt-5.4')
    expect(endpointCall?.[1]?.refresh).toBe(false)
    expect(endpointCall?.[1]?.signal).toBeInstanceOf(AbortSignal)
    const privacyCall = vi.mocked(resources.resolvePrivacy).mock.calls[0]
    expect(privacyCall?.[0]).toBe('openai/gpt-5.4')
    expect(privacyCall?.[1]?.refresh).toBe(false)
    expect(privacyCall?.[1]?.signal).toBeInstanceOf(AbortSignal)
    expect(result.wire?.ignore).toEqual(['openai'])
    expect(result.wire?.order).toEqual(['azure'])
  })

  it('keeps duplicate display names independently addressable by provider slug', () => {
    const duplicateNames = descriptor([
      endpoint('DeepInfra', 'deepinfra/fp8'),
      endpoint('DeepInfra', 'deepinfra/fp4'),
    ])
    const result = buildPrivacyForSendResult({
      chat: chat(),
      profile: profile(),
      facts: {
        descriptor: duplicateNames,
        policies: {
          'deepinfra/fp8': policy({ training: true, retainsPrompts: true }),
          'deepinfra/fp4': policy(),
        },
        offlineFallback: false,
      },
    })

    expect(result.filter?.kept.map((row) => row.endpoint.provider_slug)).toEqual(['deepinfra/fp4'])
    expect(result.wire?.ignore).toContain('deepinfra/fp8')
    expect(result.wire?.ignore).not.toContain('deepinfra/fp4')
  })

  it('adds insufficient-context providers to this request without changing settings', () => {
    const selected = chat()
    const before = structuredClone(selected.settings.providerPrefs)
    const result = buildPrivacyForSendResult({
      chat: selected,
      profile: profile(),
      facts: {
        descriptor: descriptor([
          endpoint('Azure', 'azure', { context_length: 8_000 }),
          endpoint('OpenAI', 'openai', { context_length: 200_000 }),
        ]),
        policies: { azure: policy(), openai: policy() },
        offlineFallback: false,
      },
      neededTokens: 20_000,
    })

    expect(result.contextIgnoredProviders).toEqual(['azure'])
    expect(result.wire?.ignore).toContain('azure')
    expect(selected.settings.providerPrefs).toEqual(before)
  })
})

function planningResources(
  endpoints: EndpointsDescriptor,
  policies: Readonly<Record<string, DataPolicy>>,
  options: { proxyUrl?: string; offlineFallback?: boolean } = {},
): AssistantPlanningResources {
  return {
    proxy: vi.fn(() => ({ url: options.proxyUrl ?? DEV_CORS_PROXY_URL, secret: '' })),
    resolveEndpoints: vi.fn(async () => endpoints),
    resolvePrivacy: vi.fn(async () => ({
      policies,
      offlineFallback: options.offlineFallback ?? false,
    })),
  } as unknown as AssistantPlanningResources
}

function profile(kind: ConnectionProfile['kind'] = 'openrouter'): ConnectionProfile {
  return {
    id: 'prof-1',
    name: 'OpenRouter',
    kind,
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyRef: 'key-1',
    defaultHeaders: {},
    appTitle: 'natter',
    appUrl: '',
    supportsEndpointsApi: kind === 'openrouter',
    supportsGenerationApi: kind === 'openrouter',
    supportsPrivacyScrape: kind === 'openrouter',
    createdAt: 0,
    updatedAt: 0,
  }
}

function chat(overrides: Partial<Chat['settings']> = {}): Chat {
  const settings = cloneDefaultChatSettings()
  settings.profileId = 'prof-1'
  settings.model = 'openai/gpt-5.4'
  settings.privacy = cloneDefaultPrivacyPrefs()
  Object.assign(settings, overrides)
  return {
    id: 'chat-1',
    title: 'test',
    titleStatus: 'manual',
    createdAt: 0,
    updatedAt: 0,
    lastViewedAt: 0,
    wordCount: 0,
    totalCostUsd: 0,
    metaVersion: 0,
    summaryVersion: 0,
    structuralVersion: 0,
    configurationVersion: 0,
    settings,
    lastUpdatedLeafId: null,
    lastBranchUpdatedAt: 0,
    archived: false,
    pinned: false,
    folderId: null,
    tags: [],
    previewText: '',
  }
}

function descriptor(
  endpoints: EndpointsDescriptor['endpoints'] = [
    endpoint('Azure', 'azure'),
    endpoint('OpenAI', 'openai'),
  ],
): EndpointsDescriptor {
  return { modelId: 'openai/gpt-5.4', endpoints }
}

function endpoint(
  providerName: string,
  providerSlug: string,
  overrides: Partial<EndpointsDescriptor['endpoints'][number]> = {},
): EndpointsDescriptor['endpoints'][number] {
  return {
    provider_name: providerName,
    provider_slug: providerSlug,
    supported_parameters: ['temperature'],
    context_length: 200_000,
    pricing: { prompt: '0.0000025', completion: '0.00001' },
    ...overrides,
  }
}

function policy(overrides: Partial<DataPolicy> = {}): DataPolicy {
  return {
    training: false,
    trainingOpenRouter: false,
    retainsPrompts: false,
    canPublish: false,
    termsOfServiceURL: '',
    privacyPolicyURL: '',
    ...overrides,
  }
}
