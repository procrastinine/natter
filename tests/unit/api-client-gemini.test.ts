// Contract: `buildHeaders` DOES NOT infer Gemini-native auth from `kind`; the
// transport adapter (api/gemini-native.ts) passes `authScheme: 'gemini-native'`
// explicitly. This way the same Google profile can serve both transports:
//   - native → `x-goog-api-key`
//   - openai-compat shim → `Authorization: Bearer`

import { describe, expect, it } from 'vitest'
import { buildHeaders } from '../../src/api/client'
import type { ConnectionProfile } from '../../src/core/types'

function profile(overrides: Partial<ConnectionProfile> = {}): ConnectionProfile {
  return {
    id: 'g',
    name: 'Gemini',
    kind: 'google',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    apiKeyRef: 'k',
    defaultHeaders: {},
    appTitle: 'natter',
    appUrl: 'http://localhost:5173',
    supportsEndpointsApi: false,
    supportsGenerationApi: false,
    supportsPrivacyScrape: false,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

describe('buildHeaders — Gemini native branch', () => {
  it("authScheme: 'gemini-native' → x-goog-api-key, NO Authorization", () => {
    const h = buildHeaders(profile(), 'AQ.Ab8RN6test', { authScheme: 'gemini-native' })
    expect(h['x-goog-api-key']).toBe('AQ.Ab8RN6test')
    expect(h.Authorization).toBeUndefined()
  })

  it('default auth scheme is Bearer (backwards compat with OpenAI-compat shim)', () => {
    const h = buildHeaders(profile(), 'K')
    expect(h.Authorization).toBe('Bearer K')
    expect(h['x-goog-api-key']).toBeUndefined()
  })

  it("explicit authScheme: 'bearer' also yields Authorization", () => {
    const h = buildHeaders(profile(), 'K', { authScheme: 'bearer' })
    expect(h.Authorization).toBe('Bearer K')
    expect(h['x-goog-api-key']).toBeUndefined()
  })

  it('gemini-native scheme does NOT add HTTP-Referer / X-OpenRouter-Title', () => {
    const h = buildHeaders(profile(), 'K', { authScheme: 'gemini-native' })
    expect(h['HTTP-Referer']).toBeUndefined()
    expect(h['X-OpenRouter-Title']).toBeUndefined()
  })

  it('defaultHeaders can override both Authorization and x-goog-api-key', () => {
    const h = buildHeaders(
      profile({ defaultHeaders: { 'x-goog-api-key': 'override', 'X-Custom': 'c' } }),
      'should-be-overridden',
      { authScheme: 'gemini-native' },
    )
    expect(h['x-goog-api-key']).toBe('override')
    expect(h['X-Custom']).toBe('c')
  })

  it('overrideHeaders win over defaultHeaders', () => {
    const h = buildHeaders(profile({ defaultHeaders: { 'X-Custom': 'from-default' } }), 'K', {
      overrideHeaders: { 'X-Custom': 'from-override' },
      authScheme: 'gemini-native',
    })
    expect(h['X-Custom']).toBe('from-override')
  })

  it('Content-Type is set on POST regardless of scheme', () => {
    const h = buildHeaders(profile(), 'K', { method: 'POST', authScheme: 'gemini-native' })
    expect(h['Content-Type']).toBe('application/json')
  })
})
