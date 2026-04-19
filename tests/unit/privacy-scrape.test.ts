// Privacy-scrape parser. See `plan/09-privacy.md §9.4` and
// `src/api/privacy-scrape.ts`.
//
// We don't test the live HTTP fetch here (that's a live-curl probe per
// CLAUDE.md "Live validation policy"). We DO test the HTML-parsing
// branch: __NEXT_DATA__ JSON envelopes, loose JSON objects, and the
// worst-case "nothing recognizable" fallback.

import { describe, expect, it } from 'vitest'
import {
  fetchPrivacyScrape,
  normalizeDataPolicy,
  parsePrivacyPage,
  privacyScrapeUrl,
  readCachedPrivacyPayload,
} from '../../src/api/privacy-scrape'
import type { ConnectionProfile } from '../../src/core/types'

function makeProfile(overrides: Partial<ConnectionProfile> = {}): ConnectionProfile {
  return {
    id: 'prof-1',
    name: 'test',
    kind: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyRef: 'key-1',
    defaultHeaders: {},
    appTitle: 'natter',
    appUrl: '',
    usesResponsesApiByDefault: false,
    supportsEndpointsApi: true,
    supportsGenerationApi: true,
    supportsPrivacyScrape: true,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

describe('privacyScrapeUrl', () => {
  it('uses the /_or_scrape dev proxy path by default', () => {
    // Browsers can't fetch openrouter.ai/{model}/providers cross-origin
    // (no CORS header). The default is the relative proxy path that
    // Vite's dev server rewrites to openrouter.ai. Tests never hit the
    // network; this just pins the contract.
    expect(privacyScrapeUrl(makeProfile(), 'openai/gpt-5.4')).toBe(
      '/_or_scrape/openai/gpt-5.4/providers',
    )
  })

  it('honors profile.privacyScrapeProxy when set', () => {
    const profile = makeProfile({ privacyScrapeProxy: 'https://proxy.example.com' })
    expect(privacyScrapeUrl(profile, 'anthropic/claude-opus-4.7')).toBe(
      'https://proxy.example.com/anthropic/claude-opus-4.7/providers',
    )
  })

  it('trims trailing slashes on the proxy base', () => {
    const profile = makeProfile({ privacyScrapeProxy: 'https://proxy.example.com/' })
    expect(privacyScrapeUrl(profile, 'openai/gpt-5.4')).toBe(
      'https://proxy.example.com/openai/gpt-5.4/providers',
    )
  })
})

describe('normalizeDataPolicy', () => {
  it('accepts snake_case fields', () => {
    const policy = normalizeDataPolicy({
      training: false,
      training_openrouter: false,
      retains_prompts: true,
      retention_days: 30,
      can_publish: false,
      requires_user_ids: true,
      terms_of_service_url: 'https://example.com/tos',
      privacy_policy_url: 'https://example.com/privacy',
    })
    expect(policy).toEqual({
      training: false,
      trainingOpenRouter: false,
      retainsPrompts: true,
      retentionDays: 30,
      requiresUserIDs: true,
      canPublish: false,
      termsOfServiceURL: 'https://example.com/tos',
      privacyPolicyURL: 'https://example.com/privacy',
    })
  })

  it('accepts camelCase aliases', () => {
    const policy = normalizeDataPolicy({
      training: true,
      trainingOpenRouter: false,
      retainsPrompts: false,
      canPublish: false,
    })
    expect(policy).toEqual({
      training: true,
      trainingOpenRouter: false,
      retainsPrompts: false,
      canPublish: false,
      termsOfServiceURL: '',
      privacyPolicyURL: '',
    })
  })

  it('returns null when no policy-shaped fields are present', () => {
    expect(normalizeDataPolicy({ provider_name: 'Azure' })).toBeNull()
    expect(normalizeDataPolicy({})).toBeNull()
  })

  it('coerces string booleans and numeric retention strings', () => {
    const policy = normalizeDataPolicy({
      training: 'false',
      retains_prompts: 'true',
      retention_days: '60',
      can_publish: 'no',
    })
    expect(policy?.training).toBe(false)
    expect(policy?.retainsPrompts).toBe(true)
    expect(policy?.retentionDays).toBe(60)
    expect(policy?.canPublish).toBe(false)
  })
})

describe('parsePrivacyPage', () => {
  it('picks up policies from inline JSON objects (strategy A)', () => {
    const html = `
      <html><body>
        <script>
          window.__PROVIDERS__ = [
            {"provider_name":"Azure","data_policy":{"training":false,"retains_prompts":false,"can_publish":false}},
            {"provider_name":"OpenAI","data_policy":{"training":false,"retains_prompts":true,"requires_user_ids":true,"can_publish":false}}
          ];
        </script>
      </body></html>
    `
    const policies = parsePrivacyPage(html)
    expect(policies).toHaveProperty('Azure')
    expect(policies).toHaveProperty('OpenAI')
    expect(policies.Azure?.retainsPrompts).toBe(false)
    expect(policies.OpenAI?.retainsPrompts).toBe(true)
    expect(policies.OpenAI?.requiresUserIDs).toBe(true)
  })

  it('picks up policies from __NEXT_DATA__ (strategy B)', () => {
    const html = `
      <html><body>
        <script id="__NEXT_DATA__" type="application/json">
          {"props":{"pageProps":{"endpoints":[
            {"provider_name":"Amazon Bedrock","data_policy":{"training":false,"retains_prompts":false,"can_publish":false}},
            {"provider_name":"Anthropic","data_policy":{"training":false,"retains_prompts":true,"retention_days":30,"requires_user_ids":true,"can_publish":false}}
          ]}}}
        </script>
      </body></html>
    `
    const policies = parsePrivacyPage(html)
    expect(policies).toHaveProperty('Amazon Bedrock')
    expect(policies).toHaveProperty('Anthropic')
    expect(policies.Anthropic?.retentionDays).toBe(30)
  })

  it('first occurrence wins when a provider appears in multiple chunks', () => {
    const html = `
      <script>{"provider_name":"Azure","data_policy":{"training":false,"retains_prompts":false,"can_publish":false}}</script>
      <script>{"provider_name":"Azure","data_policy":{"training":true,"retains_prompts":true,"can_publish":false}}</script>
    `
    const policies = parsePrivacyPage(html)
    expect(policies.Azure?.training).toBe(false)
  })

  it('returns an empty object when no recognizable pattern is present', () => {
    const html = '<html><body><p>No data here.</p></body></html>'
    expect(parsePrivacyPage(html)).toEqual({})
  })
})

describe('readCachedPrivacyPayload', () => {
  it('round-trips the persisted shape', () => {
    const payload = {
      policies: {
        Azure: {
          training: false,
          retainsPrompts: false,
          canPublish: false,
          termsOfServiceURL: '',
          privacyPolicyURL: '',
        },
      },
      fetchedAt: 123,
    }
    const decoded = readCachedPrivacyPayload(payload)
    expect(decoded?.fetchedAt).toBe(123)
    expect(decoded?.policies.Azure?.training).toBe(false)
  })

  it('rejects malformed payloads', () => {
    expect(readCachedPrivacyPayload(null)).toBeNull()
    expect(readCachedPrivacyPayload('oops')).toBeNull()
    expect(readCachedPrivacyPayload({ policies: 'nope' })).toBeNull()
  })

  it('filters out per-provider blobs that are not policy-shaped', () => {
    const payload = {
      policies: {
        Azure: { retains_prompts: true, can_publish: false, training: false },
        BadRow: { note: 'missing policy fields' },
      },
      fetchedAt: 0,
    }
    const decoded = readCachedPrivacyPayload(payload)
    expect(decoded?.policies.Azure).toBeTruthy()
    expect(decoded?.policies.BadRow).toBeUndefined()
  })
})

describe('fetchPrivacyScrape (injected fetch)', () => {
  it('resolves using the injected fetchImpl and parses the HTML', async () => {
    const html = `
      <script id="__NEXT_DATA__" type="application/json">
        {"props":{"pageProps":{"endpoints":[
          {"provider_name":"Azure","data_policy":{"training":false,"retains_prompts":false,"can_publish":false}}
        ]}}}
      </script>
    `
    const profile = makeProfile()
    const fetchImpl = async () =>
      new Response(html, { status: 200, headers: { 'content-type': 'text/html' } })
    const result = await fetchPrivacyScrape({ profile, fetchImpl }, 'openai/gpt-5.4')
    expect(result.modelId).toBe('openai/gpt-5.4')
    expect(result.policies.Azure?.retainsPrompts).toBe(false)
    expect(result.raw.policies.Azure).toEqual(result.policies.Azure)
    expect(result.fetchedAt).toEqual(result.raw.fetchedAt)
  })

  it('surfaces non-2xx as an error', async () => {
    const profile = makeProfile()
    const fetchImpl = async () => new Response('not found', { status: 404 })
    await expect(
      fetchPrivacyScrape({ profile, fetchImpl }, 'unknown/model'),
    ).rejects.toThrow()
  })

  it('returns an empty policies map when the page had nothing to parse', async () => {
    const profile = makeProfile()
    const fetchImpl = async () => new Response('<html></html>', { status: 200 })
    const result = await fetchPrivacyScrape({ profile, fetchImpl }, 'openai/gpt-5.4')
    expect(result.policies).toEqual({})
  })
})
