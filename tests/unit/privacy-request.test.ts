// Request-time privacy resolution. Covers the cache-read path and the
// guard rails for free-model + non-OpenRouter connections.
//
// The resolver is intentionally pure in the sense that it reads only from
// the two Dexie cache rows (endpoints + privacy policies). It never
// triggers a fetch — the hook layer keeps caches warm. See
// `src/core/privacy-request.ts`.

import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchEndpoints } from '../../src/api/models'
import { fetchPrivacyScrape } from '../../src/api/privacy-scrape'
import { DEFAULT_CORS_PROXY_URL, type CorsProxyConfig } from '../../src/core/cors-proxy'
import {
  PrivacyDiscoveryUnavailableError,
  resolvePrivacyForSend,
} from '../../src/core/privacy-request'
import { cloneDefaultChatSettings, cloneDefaultPrivacyPrefs } from '../../src/core/defaults'
import type { Chat, ConnectionProfile } from '../../src/core/types'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import { __resetDbForTests, openDb } from '../../src/store/db'
import { putCachedEndpoints } from '../../src/store/models-cache'
import {
  __resetPrivacyInFlightForTests,
  putCachedPrivacyPolicy,
} from '../../src/store/privacy-cache'

vi.mock('../../src/api/models', async () => {
  const actual = await vi.importActual<typeof import('../../src/api/models')>('../../src/api/models')
  return { ...actual, fetchEndpoints: vi.fn() }
})

vi.mock('../../src/api/privacy-scrape', async () => {
  const actual = await vi.importActual<typeof import('../../src/api/privacy-scrape')>(
    '../../src/api/privacy-scrape',
  )
  return { ...actual, fetchPrivacyScrape: vi.fn() }
})

const fetchEndpointsMock = vi.mocked(fetchEndpoints)
const fetchPrivacyScrapeMock = vi.mocked(fetchPrivacyScrape)

const DB_NAME = 'natter'

async function resetAll() {
  __resetDbForTests()
  __resetBroadcastForTests()
  __resetPrivacyInFlightForTests()
  await Dexie.delete(DB_NAME)
}

beforeEach(async () => {
  vi.clearAllMocks()
  await resetAll()
  await openDb()
})

afterEach(async () => {
  await resetAll()
})

const TEST_PROXY: CorsProxyConfig = { url: DEFAULT_CORS_PROXY_URL, secret: '' }

function makeProfile(kind: ConnectionProfile['kind'] = 'openrouter'): ConnectionProfile {
  return {
    id: 'prof-1',
    name: 'OpenRouter',
    kind,
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyRef: 'key-1',
    defaultHeaders: {},
    appTitle: 'natter',
    appUrl: '',
    usesResponsesApiByDefault: false,
    supportsEndpointsApi: kind === 'openrouter',
    supportsGenerationApi: kind === 'openrouter',
    supportsPrivacyScrape: kind === 'openrouter',
    createdAt: 0,
    updatedAt: 0,
  }
}

function makeChat(overrides: Partial<Chat['settings']> = {}): Chat {
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
    settings,
    lastUpdatedLeafId: null,
    lastBranchUpdatedAt: 0,
    archived: false,
    pinned: false,
    folderId: null,
    tags: [],
  }
}

describe('resolvePrivacyForSend', () => {
  it('returns { applicable: false } for non-OpenRouter profiles', async () => {
    const chat = makeChat()
    const profile = makeProfile('openai-compatible')
    const r = await resolvePrivacyForSend({ chat, profile, proxy: TEST_PROXY })
    expect(r.applicable).toBe(false)
    expect(r.wire).toBeNull()
    expect(r.filter).toBeNull()
  })

  it('returns { applicable: false } on a free model', async () => {
    const chat = makeChat({ model: 'deepseek/deepseek-r1:free' })
    const profile = makeProfile()
    const r = await resolvePrivacyForSend({ chat, profile, proxy: TEST_PROXY })
    expect(r.applicable).toBe(false)
  })

  it('does not reuse the paid model privacy cache for a :free variant of the same base slug', async () => {
    const profile = makeProfile()
    await putCachedEndpoints('prof-1', 'google/gemma-3-12b-it', {
      id: 'google/gemma-3-12b-it',
      endpoints: [
        {
          provider_name: 'DeepInfra',
          supported_parameters: ['temperature'],
          context_length: 128000,
          pricing: { prompt: '0.000001', completion: '0.000002' },
        },
      ],
    })
    await putCachedPrivacyPolicy('prof-1', 'google/gemma-3-12b-it', {
      policies: {
        DeepInfra: {
          training: false,
          trainingOpenRouter: false,
          retainsPrompts: false,
          canPublish: false,
          termsOfServiceURL: '',
          privacyPolicyURL: '',
        },
      },
      fetchedAt: 0,
    })
    const chat = makeChat({ model: 'google/gemma-3-12b-it:free' })
    const r = await resolvePrivacyForSend({ chat, profile, proxy: TEST_PROXY })
    expect(r.applicable).toBe(false)
    expect(r.wire).toBeNull()
    expect(r.filter).toBeNull()
  })

  it('fetches endpoints and privacy before sending when caches are cold', async () => {
    fetchEndpointsMock.mockResolvedValueOnce({
      id: 'openai/gpt-5.4',
      endpoints: [
        {
          provider_name: 'Azure',
          supported_parameters: ['temperature'],
          context_length: 200000,
          pricing: { prompt: '0.0000025', completion: '0.00001' },
        },
        {
          provider_name: 'OpenAI',
          supported_parameters: ['temperature'],
          context_length: 200000,
          pricing: { prompt: '0.0000025', completion: '0.00001' },
        },
      ],
    })
    fetchPrivacyScrapeMock.mockResolvedValueOnce({
      modelId: 'openai/gpt-5.4',
      policies: {},
      raw: {
        policies: {
          Azure: {
            training: false,
            trainingOpenRouter: false,
            retainsPrompts: false,
            canPublish: false,
            termsOfServiceURL: '',
            privacyPolicyURL: '',
          },
          OpenAI: {
            training: false,
            trainingOpenRouter: false,
            retainsPrompts: true,
            requiresUserIDs: true,
            canPublish: false,
            termsOfServiceURL: '',
            privacyPolicyURL: '',
          },
        },
        fetchedAt: Date.now(),
      },
      fetchedAt: Date.now(),
    })
    const chat = makeChat()
    const profile = makeProfile()
    const r = await resolvePrivacyForSend({ chat, profile, proxy: TEST_PROXY })
    expect(r.applicable).toBe(true)
    expect(fetchEndpointsMock).toHaveBeenCalledTimes(1)
    expect(fetchPrivacyScrapeMock).toHaveBeenCalledTimes(1)
    expect(r.filter?.kept.map((k) => k.endpoint.provider_name)).toEqual(['Azure'])
    expect(r.wire?.ignore).toContain('OpenAI')
    expect(r.wire?.data_collection).toBe('deny')
  })

  it('blocks instead of sending without privacy routing when cold endpoint discovery fails', async () => {
    fetchEndpointsMock.mockRejectedValueOnce(new Error('network down'))
    const chat = makeChat()
    const profile = makeProfile()

    await expect(resolvePrivacyForSend({ chat, profile, proxy: TEST_PROXY })).rejects.toBeInstanceOf(
      PrivacyDiscoveryUnavailableError,
    )
  })

  it('runs the filter and builds a wire block when both caches are warm', async () => {
    const chat = makeChat()
    const profile = makeProfile()
    await putCachedEndpoints('prof-1', 'openai/gpt-5.4', {
      id: 'openai/gpt-5.4',
      endpoints: [
        {
          provider_name: 'Azure',
          supported_parameters: ['temperature'],
          context_length: 200000,
          pricing: { prompt: '0.0000025', completion: '0.00001' },
        },
        {
          provider_name: 'OpenAI',
          supported_parameters: ['temperature'],
          context_length: 200000,
          pricing: { prompt: '0.0000025', completion: '0.00001' },
        },
      ],
    })
    await putCachedPrivacyPolicy('prof-1', 'openai/gpt-5.4', {
      policies: {
        Azure: {
          training: false,
          trainingOpenRouter: false,
          retainsPrompts: false,
          canPublish: false,
          termsOfServiceURL: '',
          privacyPolicyURL: '',
        },
        OpenAI: {
          training: false,
          trainingOpenRouter: false,
          retainsPrompts: true,
          requiresUserIDs: true,
          canPublish: false,
          termsOfServiceURL: '',
          privacyPolicyURL: '',
        },
      },
      fetchedAt: 0,
    })
    const r = await resolvePrivacyForSend({ chat, profile, proxy: TEST_PROXY })
    expect(r.applicable).toBe(true)
    expect(r.filter?.kept.map((k) => k.endpoint.provider_name)).toEqual(['Azure'])
    expect(r.wire?.ignore).toContain('OpenAI')
    expect(r.wire?.data_collection).toBe('deny')
    expect(r.wire?.zeroEligible).toBe(false)
  })

  it('refetches empty privacy-cache rows before request-time routing', async () => {
    const chat = makeChat({ model: 'deepseek/deepseek-v4-flash' })
    const profile = makeProfile()
    await putCachedEndpoints('prof-1', 'deepseek/deepseek-v4-flash', {
      id: 'deepseek/deepseek-v4-flash',
      endpoints: [
        {
          provider_name: 'DeepSeek',
          provider_slug: 'deepseek',
          supported_parameters: ['temperature'],
          context_length: 1048576,
          pricing: {},
        },
        {
          provider_name: 'DeepInfra',
          provider_slug: 'deepinfra/fp4',
          supported_parameters: ['temperature'],
          context_length: 1048576,
          pricing: {},
        },
      ],
    })
    await putCachedPrivacyPolicy(
      'prof-1',
      'deepseek/deepseek-v4-flash',
      { policies: {}, fetchedAt: Date.now() },
      Date.now(),
    )
    fetchPrivacyScrapeMock.mockResolvedValueOnce({
      modelId: 'deepseek/deepseek-v4-flash',
      policies: {},
      raw: {
        policies: {
          deepseek: {
            training: true,
            trainingOpenRouter: false,
            retainsPrompts: true,
            canPublish: false,
            termsOfServiceURL: '',
            privacyPolicyURL: '',
          },
          'deepinfra/fp4': {
            training: false,
            trainingOpenRouter: false,
            retainsPrompts: false,
            canPublish: false,
            termsOfServiceURL: '',
            privacyPolicyURL: '',
          },
        },
        fetchedAt: Date.now(),
      },
      fetchedAt: Date.now(),
    })

    const r = await resolvePrivacyForSend({ chat, profile, proxy: TEST_PROXY })

    expect(fetchPrivacyScrapeMock).toHaveBeenCalledTimes(1)
    expect(r.filter?.kept.map((k) => k.endpoint.provider_name)).toEqual(['DeepInfra'])
    expect(r.wire?.ignore).toContain('deepseek')
    expect(r.wire?.ignore).not.toContain('deepinfra/fp4')
  })

  it('flags zeroEligible when every endpoint is a trainer', async () => {
    const chat = makeChat({ model: 'example/x' })
    const profile = makeProfile()
    await putCachedEndpoints('prof-1', 'example/x', {
      id: 'example/x',
      endpoints: [
        {
          provider_name: 'Trainer A',
          supported_parameters: ['temperature'],
          context_length: 200000,
          pricing: {},
        },
        {
          provider_name: 'Trainer B',
          supported_parameters: ['temperature'],
          context_length: 200000,
          pricing: {},
        },
      ],
    })
    await putCachedPrivacyPolicy('prof-1', 'example/x', {
      policies: {
        'Trainer A': {
          training: true,
          trainingOpenRouter: false,
          retainsPrompts: true,
          canPublish: false,
          termsOfServiceURL: '',
          privacyPolicyURL: '',
        },
        'Trainer B': {
          training: true,
          trainingOpenRouter: false,
          retainsPrompts: true,
          canPublish: false,
          termsOfServiceURL: '',
          privacyPolicyURL: '',
        },
      },
      fetchedAt: 0,
    })
    const r = await resolvePrivacyForSend({ chat, profile, proxy: TEST_PROXY })
    expect(r.filter?.zeroEligible).toBe(true)
    expect(r.wire?.zeroEligible).toBe(true)
  })

  it('uses providerPrefs.ignore verbatim when ignoreOverridesFilter is set', async () => {
    // Unified allow/disallow: `ignoreOverridesFilter: true` signals the
    // user has taken over — the wire uses `ignore` verbatim without
    // re-layering autoIgnore. That lets them re-allow a filter-excluded
    // row by simply leaving it out of `ignore` after touching the picker.
    const chat = makeChat({
      providerPrefs: { ignore: ['Legacy Host'], ignoreOverridesFilter: true },
    })
    const profile = makeProfile()
    await putCachedEndpoints('prof-1', 'openai/gpt-5.4', {
      id: 'openai/gpt-5.4',
      endpoints: [
        {
          provider_name: 'Azure',
          supported_parameters: ['temperature'],
          context_length: 200000,
          pricing: {},
        },
        {
          provider_name: 'OpenAI',
          supported_parameters: ['temperature'],
          context_length: 200000,
          pricing: {},
        },
      ],
    })
    await putCachedPrivacyPolicy('prof-1', 'openai/gpt-5.4', {
      policies: {
        Azure: {
          training: false,
          trainingOpenRouter: false,
          retainsPrompts: false,
          canPublish: false,
          termsOfServiceURL: '',
          privacyPolicyURL: '',
        },
        OpenAI: {
          training: false,
          trainingOpenRouter: false,
          retainsPrompts: true,
          requiresUserIDs: true,
          canPublish: false,
          termsOfServiceURL: '',
          privacyPolicyURL: '',
        },
      },
      fetchedAt: 0,
    })
    const r = await resolvePrivacyForSend({ chat, profile, proxy: TEST_PROXY })
    expect(r.wire?.ignore).toEqual(['Legacy Host'])
  })

  it('resolves duplicate provider display names to exact provider slugs on the wire', async () => {
    const chat = makeChat({
      model: 'anthropic/claude-opus-4.7',
      providerPrefs: { ignore: ['anthropic/2'], ignoreOverridesFilter: true },
    })
    const profile = makeProfile()
    await putCachedEndpoints('prof-1', 'anthropic/claude-opus-4.7', {
      id: 'anthropic/claude-opus-4.7',
      endpoints: [
        {
          provider_name: 'Anthropic',
          provider_slug: 'anthropic/2',
          supported_parameters: ['temperature'],
          context_length: 200000,
          pricing: {},
        },
        {
          provider_name: 'Anthropic',
          provider_slug: 'anthropic',
          supported_parameters: ['temperature'],
          context_length: 200000,
          pricing: {},
        },
      ],
    })
    await putCachedPrivacyPolicy('prof-1', 'anthropic/claude-opus-4.7', {
      policies: {
        'anthropic/2': {
          training: false,
          trainingOpenRouter: false,
          retainsPrompts: false,
          canPublish: false,
          termsOfServiceURL: '',
          privacyPolicyURL: '',
        },
        anthropic: {
          training: false,
          trainingOpenRouter: false,
          retainsPrompts: false,
          canPublish: false,
          termsOfServiceURL: '',
          privacyPolicyURL: '',
        },
      },
      fetchedAt: 0,
    })
    const r = await resolvePrivacyForSend({ chat, profile, proxy: TEST_PROXY })
    expect(r.wire?.ignore).toEqual(['anthropic/2'])
    expect(r.wire?.ignore).not.toContain('Anthropic')
    expect(r.wire?.order).toEqual(['anthropic/2', 'anthropic'])
  })
})
