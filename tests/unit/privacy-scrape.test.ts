// The live HTTP fetch is covered separately. This suite covers __NEXT_DATA__
// JSON envelopes, loose JSON objects, and the unrecognized-page fallback.

import { describe, expect, it } from 'vitest'
import {
  fetchPrivacyScrape,
  normalizeDataPolicy,
  parsePrivacyPage,
  privacyScrapeUrl,
  readCachedPrivacyPayload,
} from '../../src/api/privacy-scrape'
import {
  CORS_PROXY_SECRET_HEADER,
  type CorsProxyConfig,
  DEV_CORS_PROXY_URL,
} from '../../src/core/cors-proxy'

function makeProxy(overrides: Partial<CorsProxyConfig> = {}): CorsProxyConfig {
  return { url: DEV_CORS_PROXY_URL, secret: '', ...overrides }
}

describe('privacyScrapeUrl', () => {
  it('uses the /_or_scrape dev proxy path by default', () => {
    // Browsers can't fetch openrouter.ai/{model}/providers cross-origin
    // (no CORS header). The default is the relative proxy path that
    // Vite's dev server rewrites to openrouter.ai. Tests never hit the
    // network; this just pins the contract.
    expect(privacyScrapeUrl(makeProxy(), 'openai/gpt-5.4')).toBe(
      '/_or_scrape/openai/gpt-5.4/providers',
    )
  })

  it('treats an empty proxy URL as live scrape disabled', () => {
    expect(() => privacyScrapeUrl(makeProxy({ url: '' }), 'openai/gpt-5.4')).toThrow(
      'Privacy-page proxy is disabled',
    )
  })

  it('honors a user-configured proxy URL', () => {
    const proxy = makeProxy({ url: 'https://proxy.example.com' })
    expect(privacyScrapeUrl(proxy, 'anthropic/claude-opus-4.7')).toBe(
      'https://proxy.example.com/anthropic/claude-opus-4.7/providers',
    )
  })

  it('trims trailing slashes on the proxy base', () => {
    const proxy = makeProxy({ url: 'https://proxy.example.com/' })
    expect(privacyScrapeUrl(proxy, 'openai/gpt-5.4')).toBe(
      'https://proxy.example.com/openai/gpt-5.4/providers',
    )
  })

  it('substitutes {model} as the literal model id (lets public ?url= proxies work)', () => {
    const proxy = makeProxy({
      url: 'https://corsproxy.io/?url=https://openrouter.ai/{model}/providers',
    })
    expect(privacyScrapeUrl(proxy, 'anthropic/claude-opus-4.7')).toBe(
      'https://corsproxy.io/?url=https://openrouter.ai/anthropic/claude-opus-4.7/providers',
    )
  })

  it('substitutes {path} as the full scrape path', () => {
    const proxy = makeProxy({
      url: 'https://api.allorigins.win/raw?url=https://openrouter.ai/{path}',
    })
    expect(privacyScrapeUrl(proxy, 'openai/gpt-5.4')).toBe(
      'https://api.allorigins.win/raw?url=https://openrouter.ai/openai/gpt-5.4/providers',
    )
  })

  it('does not append /providers in template mode (the template controls the path)', () => {
    const proxy = makeProxy({ url: 'https://example.com/{model}' })
    expect(privacyScrapeUrl(proxy, 'openai/gpt-5.4')).toBe('https://example.com/openai/gpt-5.4')
  })

  it('expands the bare corsproxy.io host into its ?url= template', () => {
    expect(privacyScrapeUrl(makeProxy({ url: 'corsproxy.io' }), 'openai/gpt-5.4')).toBe(
      'https://corsproxy.io/?url=https://openrouter.ai/openai/gpt-5.4/providers',
    )
  })

  it('expands the bare api.allorigins.win host into the /raw template', () => {
    expect(
      privacyScrapeUrl(makeProxy({ url: 'api.allorigins.win' }), 'anthropic/claude-opus-4.7'),
    ).toBe(
      'https://api.allorigins.win/raw?url=https://openrouter.ai/anthropic/claude-opus-4.7/providers',
    )
  })

  it('expands the bare proxy.corsfix.com host into the ?url= template', () => {
    expect(privacyScrapeUrl(makeProxy({ url: 'proxy.corsfix.com' }), 'openai/gpt-5.4')).toBe(
      'https://proxy.corsfix.com/?url=https://openrouter.ai/openai/gpt-5.4/providers',
    )
  })

  it('accepts known-bouncer hosts with explicit https:// scheme', () => {
    expect(privacyScrapeUrl(makeProxy({ url: 'https://corsproxy.io' }), 'openai/gpt-5.4')).toBe(
      'https://corsproxy.io/?url=https://openrouter.ai/openai/gpt-5.4/providers',
    )
  })

  it('accepts known-bouncer hosts case-insensitively', () => {
    expect(privacyScrapeUrl(makeProxy({ url: 'CORSPROXY.IO' }), 'openai/gpt-5.4')).toBe(
      'https://corsproxy.io/?url=https://openrouter.ai/openai/gpt-5.4/providers',
    )
  })

  it('treats a known host with a custom path as a path-prefix base, not a shortcut', () => {
    // The user could conceivably point natter at their own reverse proxy
    // hosted at a known-bouncer domain — pasting anything beyond the bare
    // host opts out of the shortcut.
    expect(
      privacyScrapeUrl(makeProxy({ url: 'https://corsproxy.io/custom' }), 'openai/gpt-5.4'),
    ).toBe('https://corsproxy.io/custom/openai/gpt-5.4/providers')
  })

  it('does not match similar but unknown hosts', () => {
    expect(privacyScrapeUrl(makeProxy({ url: 'corsproxy.com' }), 'openai/gpt-5.4')).toBe(
      'corsproxy.com/openai/gpt-5.4/providers',
    )
  })

  it('lets the explicit corsproxy.io template win over the bare-host shortcut', () => {
    const proxy = makeProxy({
      url: 'https://corsproxy.io/?url=https://openrouter.ai/{model}/providers',
    })
    expect(privacyScrapeUrl(proxy, 'openai/gpt-5.4')).toBe(
      'https://corsproxy.io/?url=https://openrouter.ai/openai/gpt-5.4/providers',
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

  it('picks up policies from live-style RSC flight chunks', () => {
    const chunk =
      '3:["$","endpoint",null,{"provider_display_name":"Live Provider","provider_slug":"live-provider","dataPolicy":{"training":false,"trainingOpenRouter":false,"retainsPrompts":false,"canPublish":false}}]'
    const html = `<script>self.__next_f.push([1,${JSON.stringify(chunk)}])</script>`
    const policies = parsePrivacyPage(html)
    expect(policies['Live Provider']?.training).toBe(false)
    expect(policies['live-provider']?.training).toBe(false)
    expect(policies['Live Provider']?.trainingOpenRouter).toBe(false)
    expect(policies['Live Provider']?.retainsPrompts).toBe(false)
  })

  it('picks up escaped provider JSON when the flight scan cannot decode it', () => {
    const html = String.raw`
      <script>
        window.__RSC_SNAPSHOT__ = "{\"provider_display_name\":\"Escaped Provider\",\"data_policy\":{\"training\":false,\"training_openrouter\":false,\"retains_prompts\":false,\"can_publish\":false}}";
      </script>
    `
    const policies = parsePrivacyPage(html)
    expect(policies['Escaped Provider']?.training).toBe(false)
    expect(policies['Escaped Provider']?.trainingOpenRouter).toBe(false)
    expect(policies['Escaped Provider']?.retainsPrompts).toBe(false)
  })

  it('keeps the /endpoints provider_name key when displayName differs', () => {
    const chunk =
      '3:["$","endpoint",null,{"provider_name":"Provider Canonical","provider_info":{"displayName":"provider.example","dataPolicy":{"training":false,"trainingOpenRouter":false,"retainsPrompts":false,"canPublish":false}},"provider_display_name":"provider.example","data_policy":{"training":false,"trainingOpenRouter":false,"retainsPrompts":false,"canPublish":false}}]'
    const html = `<script>self.__next_f.push([1,${JSON.stringify(chunk)}])</script>`
    const policies = parsePrivacyPage(html)
    expect(policies['Provider Canonical']?.training).toBe(false)
    expect(policies['Provider Canonical']?.retainsPrompts).toBe(false)
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
    const proxy = makeProxy()
    const fetchImpl = async () =>
      new Response(html, { status: 200, headers: { 'content-type': 'text/html' } })
    const result = await fetchPrivacyScrape({ proxy, fetchImpl }, 'openai/gpt-5.4')
    expect(result.modelId).toBe('openai/gpt-5.4')
    expect(result.policies.Azure?.retainsPrompts).toBe(false)
    expect(result.raw.policies.Azure).toEqual(result.policies.Azure)
    expect(result.fetchedAt).toEqual(result.raw.fetchedAt)
  })

  it('surfaces non-2xx as an error', async () => {
    const proxy = makeProxy()
    const fetchImpl = async () => new Response('not found', { status: 404 })
    await expect(fetchPrivacyScrape({ proxy, fetchImpl }, 'unknown/model')).rejects.toThrow()
  })

  it('returns an empty policies map when the page had nothing to parse', async () => {
    const proxy = makeProxy()
    const fetchImpl = async () => new Response('<html></html>', { status: 200 })
    const result = await fetchPrivacyScrape({ proxy, fetchImpl }, 'openai/gpt-5.4')
    expect(result.policies).toEqual({})
  })

  it('sends the X-Proxy-Secret header when a secret is configured', async () => {
    const proxy = makeProxy({
      url: 'https://proxy.example.com',
      secret: 's3kr3t',
    })
    let observed: HeadersInit | undefined
    const fetchImpl = async (_url: string, init: RequestInit) => {
      observed = init.headers
      return new Response('<html></html>', { status: 200 })
    }
    await fetchPrivacyScrape({ proxy, fetchImpl }, 'openai/gpt-5.4')
    expect((observed as Record<string, string>)[CORS_PROXY_SECRET_HEADER]).toBe('s3kr3t')
  })

  it('omits X-Proxy-Secret when the secret is empty', async () => {
    const proxy = makeProxy({ url: 'https://proxy.example.com' })
    let observed: HeadersInit | undefined
    const fetchImpl = async (_url: string, init: RequestInit) => {
      observed = init.headers
      return new Response('<html></html>', { status: 200 })
    }
    await fetchPrivacyScrape({ proxy, fetchImpl }, 'openai/gpt-5.4')
    expect((observed as Record<string, string>)[CORS_PROXY_SECRET_HEADER]).toBeUndefined()
  })
})
