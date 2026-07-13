import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __apiKeyRequestBuilderPendingForTests,
  buildHeaders,
  computeBackoffMs,
  fetchWithApiKeyFallback,
  fetchWithKeyFallback,
  fetchWithRetry,
  fetchWithTimeout,
  isKeyFallbackTrigger,
  readErrorResponseJson,
  readResponseJson,
} from '../../src/api/client'
import { ApiError } from '../../src/api/errors'
import { parseSSE } from '../../src/api/sse'
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
  it('marks loopback fetches with the loopback target address space', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok'))
    vi.stubGlobal('fetch', fetchMock)
    await fetchWithTimeout('http://127.0.0.1:8080/v1/models', {}, { timeoutMs: 0 })
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit & { targetAddressSpace?: string }
    expect(init.targetAddressSpace).toBe('loopback')
  })

  it('marks private-LAN fetches with the local target address space', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok'))
    vi.stubGlobal('fetch', fetchMock)
    await fetchWithTimeout('http://192.168.1.20:8080/v1/models', {}, { timeoutMs: 0 })
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit & { targetAddressSpace?: string }
    expect(init.targetAddressSpace).toBe('local')
  })

  it('does not mark public API fetches as local-network requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok'))
    vi.stubGlobal('fetch', fetchMock)
    await fetchWithTimeout('https://openrouter.ai/api/v1/models', {}, { timeoutMs: 0 })
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit & { targetAddressSpace?: string }
    expect(init.targetAddressSpace).toBeUndefined()
  })

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

  it('keeps the original timeout deadline across headers and a stalled JSON body', async () => {
    vi.useFakeTimers()
    let canceled = false
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          setTimeout(
            () =>
              resolve(
                new Response(
                  new ReadableStream<Uint8Array>({
                    cancel() {
                      canceled = true
                    },
                  }),
                  { headers: { 'content-type': 'application/json' } },
                ),
              ),
            60,
          )
        }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const responsePromise = fetchWithTimeout('https://x', {}, { timeoutMs: 100 })
    await vi.advanceTimersByTimeAsync(60)
    const response = await responsePromise
    const bodyPromise = readResponseJson<unknown>(response)
    let settled = false
    void bodyPromise.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )

    await vi.advanceTimersByTimeAsync(39)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await expect(bodyPromise).rejects.toMatchObject({
      kind: 'timeout',
      code: 'TIMEOUT',
      midStream: false,
      retryable: true,
    })
    expect(canceled).toBe(true)
  })

  it('cancels a stalled buffered body and preserves a post-header user abort', async () => {
    let canceled = false
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              cancel() {
                canceled = true
              },
            }),
            { headers: { 'content-type': 'application/json' } },
          ),
      ),
    )
    const controller = new AbortController()
    const response = await fetchWithTimeout(
      'https://x',
      {},
      { signal: controller.signal, timeoutMs: 60_000 },
    )
    const bodyPromise = readResponseJson<unknown>(response)
    controller.abort()

    await expect(bodyPromise).rejects.toMatchObject({
      kind: 'abort',
      code: 'ABORTED',
      midStream: false,
      retryable: false,
    })
    expect(canceled).toBe(true)
  })

  it('bounds stalled error bodies without replacing timeout classification with HTTP status', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(new ReadableStream<Uint8Array>({}), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    )
    const response = await fetchWithTimeout('https://x', {}, { timeoutMs: 25 })
    const bodyPromise = readErrorResponseJson(response)
    const expectation = expect(bodyPromise).rejects.toMatchObject({
      kind: 'timeout',
      httpStatus: undefined,
    })
    await vi.advanceTimersByTimeAsync(25)
    await expectation
  })

  it('does not apply the request deadline to SSE reads after headers', async () => {
    vi.useFakeTimers()
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                stream = controller
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          ),
      ),
    )
    const response = await fetchWithTimeout('https://x', {}, { timeoutMs: 10 })
    const eventsPromise = (async () => {
      const events = []
      for await (const event of parseSSE(response)) events.push(event)
      return events
    })()

    await vi.advanceTimersByTimeAsync(10_000)
    stream?.enqueue(new TextEncoder().encode('data: late\n\n'))
    stream?.close()
    await expect(eventsPromise).resolves.toEqual([{ kind: 'data', data: 'late' }])
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

  it('cancels an unused retryable response body before opening the next request', async () => {
    const cancel = vi.fn()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream({
            cancel,
          }),
          { status: 503 },
        ),
      )
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      fetchWithRetry('https://x', { method: 'GET' }, { retry: { attempts: 2, backoffMs: 1 } }),
    ).resolves.toMatchObject({ status: 200 })
    expect(cancel).toHaveBeenCalledOnce()
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

  it('aborts immediately during retry backoff without opening another request', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async () => new Response('', { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    const promise = fetchWithRetry(
      'https://x',
      { method: 'GET' },
      {
        signal: controller.signal,
        retry: { attempts: 3, backoffMs: 30_000 },
      },
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledOnce()
    controller.abort()

    await expect(promise).rejects.toMatchObject({
      kind: 'abort',
      code: 'ABORTED',
      midStream: false,
      retryable: false,
    })
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})

describe('fetchWithKeyFallback', () => {
  function response(
    status: number,
    headers: Record<string, string> = {},
    body: BodyInit | null = '',
  ): Response {
    return new Response(body, { status, headers })
  }

  it('tries opaque candidates in order and returns the selected candidate and index', async () => {
    const candidates = [
      { ref: 'ref-1', secret: 'secret-1' },
      { ref: 'ref-2', secret: 'secret-2' },
      { ref: 'ref-3', secret: 'secret-3' },
    ] as const
    const buildOrder: number[] = []
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(401))
      .mockResolvedValueOnce(response(403))
      .mockResolvedValueOnce(response(200))
    vi.stubGlobal('fetch', fetchMock)
    const result = await fetchWithKeyFallback(candidates, (candidate, index) => {
      buildOrder.push(index)
      return {
        url: 'https://x',
        init: { headers: { Authorization: `Bearer ${candidate.secret}` } },
      }
    })
    expect(result.response.status).toBe(200)
    expect(result.candidate).toBe(candidates[2])
    expect(result.candidateIndex).toBe(2)
    expect(buildOrder).toEqual([0, 1, 2])
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const authHeaders = fetchMock.mock.calls.map((call) => {
      const init = call[1] as RequestInit
      return (init.headers as Record<string, string>).Authorization
    })
    expect(authHeaders).toEqual(['Bearer secret-1', 'Bearer secret-2', 'Bearer secret-3'])
  })

  it.each([
    400, 408, 418, 429, 500, 502, 503,
  ])('does not rotate on non-triggering HTTP %i', async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(response(status))
    vi.stubGlobal('fetch', fetchMock)
    const result = await fetchWithKeyFallback(['ref-1', 'ref-2'], (candidate) => ({
      url: 'https://x',
      init: { headers: { Authorization: `Bearer ${candidate}` } },
    }))
    expect(result.response.status).toBe(status)
    expect(result.candidate).toBe('ref-1')
    expect(result.candidateIndex).toBe(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    undefined,
    '1',
    'not-a-number',
  ])('makes exactly one request for an ordinary 429 with limit %s', async (limit) => {
    const headers = limit === undefined ? {} : { 'x-ratelimit-limit': limit }
    const fetchMock = vi.fn().mockResolvedValue(response(429, headers))
    vi.stubGlobal('fetch', fetchMock)
    const result = await fetchWithKeyFallback(['ref-1', 'ref-2'], (candidate) => ({
      url: 'https://x',
      init: { headers: { Authorization: `Bearer ${candidate}` } },
    }))
    expect(result.response.status).toBe(429)
    expect(result.candidateIndex).toBe(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rotates on a 429 whose x-ratelimit-limit parses to numeric zero', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(429, { 'x-ratelimit-limit': '0.0' }))
      .mockResolvedValueOnce(response(200))
    vi.stubGlobal('fetch', fetchMock)
    const result = await fetchWithKeyFallback(['ref-1', 'ref-2'], (candidate) => ({
      url: 'https://x',
      init: { headers: { Authorization: `Bearer ${candidate}` } },
    }))
    expect(result.response.status).toBe(200)
    expect(result.candidate).toBe('ref-2')
    expect(result.candidateIndex).toBe(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('reuses byte-identical request bodies and methods while rebuilding candidate headers', async () => {
    const body = JSON.stringify({ model: 'model', messages: [{ role: 'user', content: 'hello' }] })
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(401))
      .mockResolvedValueOnce(response(200))
    vi.stubGlobal('fetch', fetchMock)
    await fetchWithKeyFallback(['ref-1', 'ref-2'], (candidate) => ({
      url: 'https://x',
      init: {
        method: 'POST',
        body,
        headers: { Authorization: `Bearer ${candidate}` },
      },
    }))
    expect(fetchMock).toHaveBeenCalledTimes(2)
    for (const call of fetchMock.mock.calls) {
      const init = call[1] as RequestInit
      expect(init.method).toBe('POST')
      expect(init.body).toBe(body)
    }
  })

  it('releases the request builder at response headers before key metadata settles', async () => {
    let releaseMetadata: (() => void) | undefined
    const metadataBlocked = new Promise<void>((resolve) => {
      releaseMetadata = resolve
    })
    let metadataStarted: (() => void) | undefined
    const metadataStart = new Promise<void>((resolve) => {
      metadataStarted = resolve
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(200)))
    const body = JSON.stringify({ prompt: 'x'.repeat(100_000) })
    const requested = fetchWithApiKeyFallback(
      {
        apiKey: 'key',
        onKeyCandidateSelected: async () => {
          metadataStarted?.()
          await metadataBlocked
        },
      },
      (apiKey) => ({
        url: 'https://x',
        init: { method: 'POST', body, headers: { Authorization: `Bearer ${apiKey}` } },
      }),
    )

    expect(__apiKeyRequestBuilderPendingForTests(requested)).toBe(true)
    await metadataStart
    expect(__apiKeyRequestBuilderPendingForTests(requested)).toBe(false)

    releaseMetadata?.()
    await expect(requested).resolves.toMatchObject({ response: { status: 200 } })
  })

  it('supports lazy async candidate resolution and resolves only attempted candidates', async () => {
    const candidates = [
      { ref: 'ref-1', resolve: vi.fn<() => Promise<string>>().mockResolvedValue('secret-1') },
      { ref: 'ref-2', resolve: vi.fn<() => Promise<string>>().mockResolvedValue('secret-2') },
      { ref: 'ref-3', resolve: vi.fn<() => Promise<string>>().mockResolvedValue('secret-3') },
    ]
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(401))
      .mockResolvedValueOnce(response(200))
    vi.stubGlobal('fetch', fetchMock)
    const result = await fetchWithKeyFallback(candidates, async (candidate) => {
      const secret = await candidate.resolve()
      return {
        url: 'https://x',
        init: { headers: { Authorization: `Bearer ${secret}` } },
      }
    })
    expect(result.candidate).toBe(candidates[1])
    expect(candidates[0]?.resolve).toHaveBeenCalledTimes(1)
    expect(candidates[1]?.resolve).toHaveBeenCalledTimes(1)
    expect(candidates[2]?.resolve).not.toHaveBeenCalled()
  })

  it('cancels a rejected response body before trying the next candidate', async () => {
    const cancel = vi.fn()
    const rejected = response(401, {}, new ReadableStream({ cancel }))
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(rejected)
      .mockImplementationOnce(() => {
        expect(cancel).toHaveBeenCalledTimes(1)
        return Promise.resolve(response(200))
      })
    vi.stubGlobal('fetch', fetchMock)
    await fetchWithKeyFallback(['ref-1', 'ref-2'], (candidate) => ({
      url: 'https://x',
      init: { headers: { Authorization: `Bearer ${candidate}` } },
    }))
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('does not retry when the rejected response body cannot be canceled', async () => {
    const cancel = vi.fn().mockRejectedValue(new Error('cancel failed'))
    const rejected = response(401, {}, new ReadableStream({ cancel }))
    const fetchMock = vi.fn().mockResolvedValue(rejected)
    vi.stubGlobal('fetch', fetchMock)
    const result = await fetchWithKeyFallback(['ref-1', 'ref-2'], (candidate) => ({
      url: 'https://x',
      init: { headers: { Authorization: `Bearer ${candidate}` } },
    }))
    expect(result.response).toBe(rejected)
    expect(result.candidateIndex).toBe(0)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('returns the last response unread when all candidates are exhausted', async () => {
    const firstCancel = vi.fn()
    const lastCancel = vi.fn()
    const lastResponse = response(403, {}, new ReadableStream({ cancel: lastCancel }))
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(401, {}, new ReadableStream({ cancel: firstCancel })))
      .mockResolvedValueOnce(lastResponse)
    vi.stubGlobal('fetch', fetchMock)
    const result = await fetchWithKeyFallback(['ref-1', 'ref-2'], (candidate) => ({
      url: 'https://x',
      init: { headers: { Authorization: `Bearer ${candidate}` } },
    }))
    expect(result.response).toBe(lastResponse)
    expect(result.candidate).toBe('ref-2')
    expect(result.candidateIndex).toBe(1)
    expect(result.response.bodyUsed).toBe(false)
    expect(firstCancel).toHaveBeenCalledTimes(1)
    expect(lastCancel).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('stops on first success without trying subsequent keys', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await fetchWithKeyFallback(['k1', 'k2', 'k3'], (key) => ({
      url: 'https://x',
      init: { headers: { Authorization: `Bearer ${key}` } },
    }))
    expect(result.candidate).toBe('k1')
    expect(result.candidateIndex).toBe(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not rotate after response-body consumption has begun', async () => {
    const consumed = response(401, {}, 'already consumed')
    await consumed.text()
    const fetchMock = vi.fn().mockResolvedValue(consumed)
    vi.stubGlobal('fetch', fetchMock)
    const result = await fetchWithKeyFallback(['ref-1', 'ref-2'], (candidate) => ({
      url: 'https://x',
      init: { headers: { Authorization: `Bearer ${candidate}` } },
    }))
    expect(result.response).toBe(consumed)
    expect(result.candidateIndex).toBe(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not rotate after a network failure', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      fetchWithKeyFallback(['ref-1', 'ref-2'], (candidate) => ({
        url: 'https://x',
        init: { headers: { Authorization: `Bearer ${candidate}` } },
      })),
    ).rejects.toMatchObject({ kind: 'network' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('checks an already-aborted signal before building or fetching the first attempt', async () => {
    const controller = new AbortController()
    controller.abort()
    const build = vi.fn(() => ({ url: 'https://x', init: {} }))
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      fetchWithKeyFallback(['ref-1', 'ref-2'], build, { signal: controller.signal }),
    ).rejects.toMatchObject({ kind: 'abort', retryable: false })
    expect(build).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('checks abort again after asynchronous candidate preparation and before fetch', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      fetchWithKeyFallback(
        ['ref-1', 'ref-2'],
        async (candidate) => {
          controller.abort()
          return {
            url: 'https://x',
            init: { headers: { Authorization: `Bearer ${candidate}` } },
          }
        },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ kind: 'abort', retryable: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('stops immediately when aborted between candidate attempts', async () => {
    const controller = new AbortController()
    const cancel = vi.fn(() => controller.abort())
    const build = vi.fn((candidate: string) => ({
      url: 'https://x',
      init: { headers: { Authorization: `Bearer ${candidate}` } },
    }))
    const fetchMock = vi.fn().mockResolvedValue(response(401, {}, new ReadableStream({ cancel })))
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      fetchWithKeyFallback(['ref-1', 'ref-2'], build, { signal: controller.signal }),
    ).rejects.toMatchObject({ kind: 'abort', retryable: false })
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(build).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('throws when given an empty candidate list', async () => {
    await expect(fetchWithKeyFallback([], () => ({ url: 'https://x', init: {} }))).rejects.toThrow(
      /at least one candidate/,
    )
  })
})

describe('isKeyFallbackTrigger', () => {
  it('true for 401/403', () => {
    expect(isKeyFallbackTrigger(new Response('', { status: 401 }))).toBe(true)
    expect(isKeyFallbackTrigger(new Response('', { status: 403 }))).toBe(true)
  })
  it.each([
    '0',
    '0.0',
    '0e0',
    '-0',
  ])('true for 429 when x-ratelimit-limit %s parses to numeric zero', (limit) => {
    expect(
      isKeyFallbackTrigger(
        new Response('', {
          status: 429,
          headers: { 'x-ratelimit-limit': limit },
        }),
      ),
    ).toBe(true)
  })
  it.each([
    undefined,
    '',
    '1',
    '-1',
    'NaN',
    '0, 1',
  ])('false for 429 with nonzero, missing, or malformed limit %s', (limit) => {
    const headers = limit === undefined ? {} : { 'x-ratelimit-limit': limit }
    expect(isKeyFallbackTrigger(new Response('', { status: 429, headers }))).toBe(false)
  })
  it('does not treat a missing limit as account exhaustion', () => {
    expect(isKeyFallbackTrigger(new Response('', { status: 429 }))).toBe(false)
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
