import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildHeaders,
  computeBackoffMs,
  fetchWithKeyFallback,
  fetchWithRetry,
  fetchWithTimeout,
  isKeyFallbackTrigger,
} from '../../src/api/client'
import { ApiError } from '../../src/api/errors'
import type { ConnectionProfile } from '../../src/core/types'

function makeProfile(overrides: Partial<ConnectionProfile> = {}): ConnectionProfile {
  return {
    id: 'prof',
    name: 'OpenRouter',
    kind: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyRef: 'key-a',
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

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('buildHeaders', () => {
  it('includes OpenRouter identity defaults for OpenRouter profiles', () => {
    const h = buildHeaders(makeProfile(), 'sk-or-test')
    expect(h.Authorization).toBe('Bearer sk-or-test')
    expect(h['HTTP-Referer']).toBe('http://localhost:5173')
    expect(h['X-OpenRouter-Title']).toBe('llm-api-frontend')
  })

  it('omits OpenRouter-only headers for direct-provider profiles', () => {
    const h = buildHeaders(makeProfile({ kind: 'openai-compatible' }), 'sk-test')
    expect(h.Authorization).toBe('Bearer sk-test')
    expect(h['HTTP-Referer']).toBeUndefined()
    expect(h['X-OpenRouter-Title']).toBeUndefined()
    expect(h['X-OpenRouter-Categories']).toBeUndefined()
  })

  it('adds Anthropic browser-access opt-in for direct Anthropic requests', () => {
    const h = buildHeaders(
      makeProfile({ kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1' }),
      'sk-ant-test',
    )
    expect(h.Authorization).toBe('Bearer sk-ant-test')
    expect(h['anthropic-dangerous-direct-browser-access']).toBe('true')
    expect(h['HTTP-Referer']).toBeUndefined()
    expect(h['X-OpenRouter-Title']).toBeUndefined()
  })

  it('adds Anthropic browser-access opt-in for custom profiles pointed at api.anthropic.com', () => {
    const h = buildHeaders(
      makeProfile({ kind: 'custom', baseUrl: 'https://api.anthropic.com/v1' }),
      'sk-ant-test',
    )
    expect(h['anthropic-dangerous-direct-browser-access']).toBe('true')
  })

  it('adds Content-Type: application/json only for POST', () => {
    expect(buildHeaders(makeProfile(), 'k')['Content-Type']).toBeUndefined()
    expect(buildHeaders(makeProfile(), 'k', { method: 'POST' })['Content-Type']).toBe(
      'application/json',
    )
  })

  it('adds X-OpenRouter-Categories from profile.appCategories', () => {
    const h = buildHeaders(makeProfile({ appCategories: ['chat', 'tools'] }), 'k')
    expect(h['X-OpenRouter-Categories']).toBe('chat,tools')
  })

  it('merges in order: required defaults → profile.defaultHeaders → per-call overrides', () => {
    const profile = makeProfile({
      defaultHeaders: {
        // Profile overrides the required default title.
        'X-OpenRouter-Title': 'custom-from-profile',
        // Profile adds a new header.
        'X-Profile-Only': 'yes',
      },
    })
    const h = buildHeaders(profile, 'k', {
      overrideHeaders: {
        // Per-call override beats profile.
        'X-OpenRouter-Title': 'final-override',
        // Per-call adds another.
        'X-Call-Only': 'yes',
      },
    })
    expect(h['X-OpenRouter-Title']).toBe('final-override')
    expect(h['X-Profile-Only']).toBe('yes')
    expect(h['X-Call-Only']).toBe('yes')
  })

  it('omits HTTP-Referer when profile.appUrl is empty', () => {
    const h = buildHeaders(makeProfile({ appUrl: '' }), 'k')
    expect(h['HTTP-Referer']).toBeUndefined()
  })

  it('omits Authorization when the key is empty', () => {
    const h = buildHeaders(makeProfile({ kind: 'llama-server' }), '')
    expect(h.Authorization).toBeUndefined()
  })
})

describe('fetchWithTimeout', () => {
  it('yields ApiError(kind:timeout) when the timer fires before fetch resolves', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal
            if (!signal) return
            signal.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            )
          }),
      ),
    )
    const promise = fetchWithTimeout('https://x', {}, { timeoutMs: 5 })
    await expect(promise).rejects.toBeInstanceOf(ApiError)
    await promise.catch((err: ApiError) => {
      expect(err.kind).toBe('timeout')
      expect(err.retryable).toBe(true)
    })
  })

  it('yields ApiError(kind:abort) when the user signal fires', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal
            if (!signal) return
            signal.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            )
          }),
      ),
    )
    const controller = new AbortController()
    const promise = fetchWithTimeout(
      'https://x',
      {},
      { signal: controller.signal, timeoutMs: 60_000 },
    )
    // Abort just after the fetch is in flight.
    queueMicrotask(() => controller.abort())
    await expect(promise).rejects.toBeInstanceOf(ApiError)
    await promise.catch((err: ApiError) => {
      expect(err.kind).toBe('abort')
      expect(err.retryable).toBe(false)
    })
  })

  it('yields ApiError(kind:network) when fetch rejects without an abort', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('fetch failed'))),
    )
    const promise = fetchWithTimeout('https://x', {})
    await expect(promise).rejects.toBeInstanceOf(ApiError)
    await promise.catch((err: ApiError) => {
      expect(err.kind).toBe('network')
      expect(err.retryable).toBe(true)
    })
  })
})

describe('fetchWithRetry (GET)', () => {
  it('stops on the first 2xx and returns it', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const res = await fetchWithRetry(
      'https://x',
      { method: 'GET' },
      { retry: { attempts: 3, backoffMs: 1 } },
    )
    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('returns the final non-ok response after exhausting attempts', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)
    const res = await fetchWithRetry(
      'https://x',
      { method: 'GET' },
      { retry: { attempts: 3, backoffMs: 1 } },
    )
    expect(res.status).toBe(503)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('does not retry on non-retryable statuses (400, 404)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 404 }))
    vi.stubGlobal('fetch', fetchMock)
    const res = await fetchWithRetry(
      'https://x',
      { method: 'GET' },
      { retry: { attempts: 5, backoffMs: 1 } },
    )
    expect(res.status).toBe(404)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('stops after the configured attempt count when network errors keep firing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('fetch failed'))),
    )
    await expect(
      fetchWithRetry('https://x', { method: 'GET' }, { retry: { attempts: 2, backoffMs: 1 } }),
    ).rejects.toBeInstanceOf(ApiError)
    // fetch was called twice total — not three, not one.
    expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(
      2,
    )
  })

  it('computes exponential backoff capped at 5000ms', () => {
    expect(computeBackoffMs(0, 250)).toBe(250)
    expect(computeBackoffMs(1, 250)).toBe(500)
    expect(computeBackoffMs(2, 250)).toBe(1000)
    // 250 * 2^6 = 16000 → capped.
    expect(computeBackoffMs(6, 250)).toBe(5000)
  })
})

describe('fetchWithKeyFallback', () => {
  function response(status: number, headers: Record<string, string> = {}): Response {
    return new Response('', { status, headers })
  }

  it('retries on 401 and returns the first successful response', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(401))
      .mockResolvedValueOnce(response(401))
      .mockResolvedValueOnce(response(200))
    vi.stubGlobal('fetch', fetchMock)
    const result = await fetchWithKeyFallback(['k1', 'k2', 'k3'], (key) => ({
      url: 'https://x',
      init: { headers: { Authorization: `Bearer ${key}` } },
    }))
    expect(result.response.status).toBe(200)
    expect(result.keyIndex).toBe(2)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const keysSent = fetchMock.mock.calls.map((call) => {
      const init = call[1] as RequestInit
      const auth = (init.headers as Record<string, string>).Authorization
      return auth
    })
    expect(keysSent).toEqual(['Bearer k1', 'Bearer k2', 'Bearer k3'])
  })

  it('stops immediately on a non-rotating status (e.g. 500) and returns it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(500))
    vi.stubGlobal('fetch', fetchMock)
    const result = await fetchWithKeyFallback(['k1', 'k2'], (key) => ({
      url: 'https://x',
      init: { headers: { Authorization: `Bearer ${key}` } },
    }))
    expect(result.response.status).toBe(500)
    expect(result.keyIndex).toBe(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does NOT rotate on a 429 without x-ratelimit-limit:0 (per-minute throttle)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(429))
    vi.stubGlobal('fetch', fetchMock)
    const result = await fetchWithKeyFallback(['k1', 'k2'], (key) => ({
      url: 'https://x',
      init: { headers: { Authorization: `Bearer ${key}` } },
    }))
    expect(result.response.status).toBe(429)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('DOES rotate on 429 with x-ratelimit-limit:0 (account exhausted)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(429, { 'x-ratelimit-limit': '0' }))
      .mockResolvedValueOnce(response(200))
    vi.stubGlobal('fetch', fetchMock)
    const result = await fetchWithKeyFallback(['k1', 'k2'], (key) => ({
      url: 'https://x',
      init: { headers: { Authorization: `Bearer ${key}` } },
    }))
    expect(result.response.status).toBe(200)
    expect(result.keyIndex).toBe(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('returns the LAST response when all keys trigger rotation', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(401))
    vi.stubGlobal('fetch', fetchMock)
    const result = await fetchWithKeyFallback(['k1', 'k2'], (key) => ({
      url: 'https://x',
      init: { headers: { Authorization: `Bearer ${key}` } },
    }))
    expect(result.response.status).toBe(401)
    expect(result.keyIndex).toBe(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('stops on first success without trying subsequent keys', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await fetchWithKeyFallback(['k1', 'k2', 'k3'], (key) => ({
      url: 'https://x',
      init: { headers: { Authorization: `Bearer ${key}` } },
    }))
    expect(result.keyIndex).toBe(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('throws when given an empty key list', async () => {
    await expect(fetchWithKeyFallback([], () => ({ url: 'https://x', init: {} }))).rejects.toThrow(
      /at least one key/,
    )
  })
})

describe('isKeyFallbackTrigger', () => {
  it('true for 401/403', () => {
    expect(isKeyFallbackTrigger(new Response('', { status: 401 }))).toBe(true)
    expect(isKeyFallbackTrigger(new Response('', { status: 403 }))).toBe(true)
  })
  it('true for 429 with x-ratelimit-limit:0 only', () => {
    expect(isKeyFallbackTrigger(new Response('', { status: 429 }))).toBe(false)
    expect(
      isKeyFallbackTrigger(
        new Response('', {
          status: 429,
          headers: { 'x-ratelimit-limit': '0' },
        }),
      ),
    ).toBe(true)
  })
  it('false for 200, 500, 502', () => {
    expect(isKeyFallbackTrigger(new Response('', { status: 200 }))).toBe(false)
    expect(isKeyFallbackTrigger(new Response('', { status: 500 }))).toBe(false)
    expect(isKeyFallbackTrigger(new Response('', { status: 502 }))).toBe(false)
  })

  beforeEach(() => {
    // keep vi.useRealTimers() default — no fake timers needed for these.
  })
})
