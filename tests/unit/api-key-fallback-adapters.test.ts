import { afterEach, describe, expect, it, vi } from 'vitest'
import { anthropicOnce } from '../../src/api/anthropic-messages'
import {
  createAssistantDispatchPlan,
  openAssistantRequestStream,
} from '../../src/api/assistant-stream'
import { chatCompletions } from '../../src/api/chat-completions'
import type { ApiKeyCandidate } from '../../src/api/client'
import { geminiOnce } from '../../src/api/gemini-native'
import { responsesOnce } from '../../src/api/responses'
import { textCompletionsOnce } from '../../src/api/text-completions'
import { videoGeneration } from '../../src/api/video-generation'
import type { ConnectionProfile } from '../../src/core/types'
import { responsesRouteContract } from '../helpers/reasoning-contracts'

interface TestCandidate extends ApiKeyCandidate {
  resolve: ReturnType<typeof vi.fn<() => Promise<string>>>
}

interface SeenRequest {
  url: string
  init: RequestInit
}

interface AdapterContext {
  profile: ConnectionProfile
  apiKey: string
  apiKeyCandidates: readonly ApiKeyCandidate[]
  onKeyCandidateSelected: (
    candidate: ApiKeyCandidate,
    candidateIndex: number,
    apiKey: string,
  ) => void
}

function profile(
  kind: ConnectionProfile['kind'] = 'openrouter',
  baseUrl = 'https://openrouter.ai/api/v1',
): ConnectionProfile {
  return {
    id: 'profile',
    name: kind,
    kind,
    baseUrl,
    apiKeyRef: 'primary',
    apiKeyFallbackRefs: ['fallback'],
    defaultHeaders: {},
    appTitle: 'natter',
    appUrl: 'http://localhost',
    supportsEndpointsApi: false,
    supportsGenerationApi: false,
    supportsPrivacyScrape: false,
    createdAt: 0,
    updatedAt: 0,
  }
}

function candidate(apiKey: string): TestCandidate {
  return {
    resolve: vi.fn(async () => apiKey),
  }
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function sseResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

function recordRequest(seen: SeenRequest[], url: string | URL | Request, init?: RequestInit): void {
  seen.push({
    url: typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
    init: init ?? {},
  })
}

function requestHeaders(request: SeenRequest): Record<string, string> {
  return request.init.headers as Record<string, string>
}

function requestBody(request: SeenRequest): string {
  return request.init.body as string
}

function headerValue(request: SeenRequest, name: string): string | undefined {
  const normalizedName = name.toLowerCase()
  return Object.entries(requestHeaders(request)).find(
    ([headerName]) => headerName.toLowerCase() === normalizedName,
  )?.[1]
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('provider adapter key fallback', () => {
  it('rotates a chat stream before body consumption with identical URL/body and fresh bearer auth', async () => {
    const first = candidate('key-one')
    const second = candidate('key-two')
    const selected = vi.fn()
    const seen: SeenRequest[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        recordRequest(seen, url, init)
        return seen.length === 1
          ? jsonResponse({ error: { message: 'expired' } }, 401)
          : sseResponse('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n')
      }),
    )

    const chunks = []
    for await (const chunk of chatCompletions(
      {
        profile: profile(),
        apiKey: 'legacy-unused',
        apiKeyCandidates: [first, second],
        onKeyCandidateSelected: selected,
      },
      { model: 'm', messages: [], stream: true },
    )) {
      chunks.push(chunk)
    }

    expect(chunks).toEqual([
      expect.objectContaining({ type: 'delta' }),
      { type: 'transport_terminal', evidence: 'done-sentinel' },
    ])
    expect(seen.map((request) => request.url)).toEqual([
      'https://openrouter.ai/api/v1/chat/completions',
      'https://openrouter.ai/api/v1/chat/completions',
    ])
    expect(requestBody(seen[0] as SeenRequest)).toBe(requestBody(seen[1] as SeenRequest))
    expect(requestHeaders(seen[0] as SeenRequest).Authorization).toBe('Bearer key-one')
    expect(requestHeaders(seen[1] as SeenRequest).Authorization).toBe('Bearer key-two')
    expect(selected).toHaveBeenCalledWith(second, 1, 'key-two')
  })

  it('does not rotate after an accepted stream response starts failing mid-body', async () => {
    const first = candidate('key-one')
    const second = candidate('key-two')
    let pullCount = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pullCount === 0) {
          pullCount += 1
          controller.enqueue(
            new TextEncoder().encode('data: {"choices":[{"delta":{"content":"A"}}]}\n\n'),
          )
          return
        }
        controller.error(new Error('mid-stream failure'))
      },
    })
    const fetchMock = vi.fn(async () =>
      Promise.resolve(
        new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    let thrown: unknown
    try {
      for await (const _ of chatCompletions(
        {
          profile: profile(),
          apiKey: 'legacy-unused',
          apiKeyCandidates: [first, second],
        },
        { model: 'm', messages: [], stream: true },
      )) {
        // drain
      }
    } catch (error) {
      thrown = error
    }
    expect(thrown).toMatchObject({
      kind: 'network',
      code: 'NETWORK',
      message: 'Network error',
      midStream: true,
    })
    expect(JSON.stringify(thrown)).not.toContain('mid-stream failure')
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(first.resolve).toHaveBeenCalledOnce()
    expect(second.resolve).not.toHaveBeenCalled()
  })

  it('does not rotate after an accepted buffered response stalls in its body', async () => {
    vi.useFakeTimers()
    const first = candidate('key-one')
    const second = candidate('key-two')
    let canceled = false
    const fetchMock = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              canceled = true
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const promise = responsesOnce(
      {
        profile: profile('openai-compatible', 'https://api.openai.com/v1'),
        apiKey: 'legacy-unused',
        apiKeyCandidates: [first, second],
      },
      { model: 'm', input: 'hi' },
      { timeoutMs: 50 },
    )
    const expectation = expect(promise).rejects.toMatchObject({
      kind: 'timeout',
      code: 'TIMEOUT',
      midStream: false,
    })
    await vi.advanceTimersByTimeAsync(50)

    await expectation
    expect(canceled).toBe(true)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(first.resolve).toHaveBeenCalledOnce()
    expect(second.resolve).not.toHaveBeenCalled()
  })

  it('rotates a buffered Responses request and keeps stream:false identical across attempts', async () => {
    const first = candidate('key-one')
    const second = candidate('key-two')
    const seen: SeenRequest[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        recordRequest(seen, url, init)
        return seen.length === 1
          ? jsonResponse({ error: { message: 'forbidden' } }, 403)
          : jsonResponse({ id: 'resp_1', status: 'completed', output: [] })
      }),
    )

    await responsesOnce(
      {
        profile: profile('openai-compatible', 'https://api.openai.com/v1'),
        apiKey: 'legacy-unused',
        apiKeyCandidates: [first, second],
      },
      { model: 'm', input: 'hi', stream: true },
    )

    expect(seen.map((request) => request.url)).toEqual([
      'https://api.openai.com/v1/responses',
      'https://api.openai.com/v1/responses',
    ])
    expect(requestBody(seen[0] as SeenRequest)).toBe(requestBody(seen[1] as SeenRequest))
    expect(JSON.parse(requestBody(seen[1] as SeenRequest))).toMatchObject({ stream: false })
    expect(requestHeaders(seen[0] as SeenRequest).Authorization).toBe('Bearer key-one')
    expect(requestHeaders(seen[1] as SeenRequest).Authorization).toBe('Bearer key-two')
  })

  it('rejects before consuming an accepted body when selected-key durability fails', async () => {
    const accepted = candidate('accepted-key')
    const failure = new Error('selected-key durability unavailable')
    const selected = vi.fn(async () => {
      throw failure
    })
    let canceled = false
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          canceled = true
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response),
    )

    await expect(
      responsesOnce(
        {
          profile: profile('openai-compatible', 'https://api.openai.com/v1'),
          apiKey: 'legacy-unused',
          apiKeyCandidates: [accepted],
          onKeyCandidateSelected: selected,
        },
        { model: 'm', input: 'hi' },
      ),
    ).rejects.toBe(failure)
    expect(selected).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(canceled).toBe(true))
  })

  it('holds an accepted body unread until selected-key durability settles', async () => {
    const accepted = candidate('accepted-key')
    let releaseDurability: (() => void) | undefined
    const durability = new Promise<void>((resolve) => {
      releaseDurability = resolve
    })
    const selected = vi.fn(() => durability)
    const response = jsonResponse({ id: 'resp_1', status: 'completed', output: [] })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response),
    )

    let settled = false
    const result = responsesOnce(
      {
        profile: profile('openai-compatible', 'https://api.openai.com/v1'),
        apiKey: 'legacy-unused',
        apiKeyCandidates: [accepted],
        onKeyCandidateSelected: selected,
      },
      { model: 'm', input: 'hi' },
    ).finally(() => {
      settled = true
    })
    await vi.waitFor(() => expect(selected).toHaveBeenCalledOnce())
    expect(response.bodyUsed).toBe(false)
    expect(settled).toBe(false)

    releaseDurability?.()
    await expect(result).resolves.toMatchObject({ id: 'resp_1', status: 'completed' })
  })

  it('aborts a pending selected-key handoff and cancels the accepted body', async () => {
    const accepted = candidate('accepted-key')
    const controller = new AbortController()
    const selected = vi.fn(() => new Promise<void>(() => {}))
    let canceled = false
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          canceled = true
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response),
    )

    const result = responsesOnce(
      {
        profile: profile('openai-compatible', 'https://api.openai.com/v1'),
        apiKey: 'legacy-unused',
        apiKeyCandidates: [accepted],
        onKeyCandidateSelected: selected,
      },
      { model: 'm', input: 'hi' },
      { signal: controller.signal },
    )
    await vi.waitFor(() => expect(selected).toHaveBeenCalledOnce())
    expect(response.bodyUsed).toBe(false)

    controller.abort(new DOMException('stopped', 'AbortError'))
    await expect(result).rejects.toMatchObject({ kind: 'abort', code: 'ABORTED' })
    await vi.waitFor(() => expect(canceled).toBe(true))
  })

  it('rotates text completions only for an account-exhaustion 429', async () => {
    const first = candidate('key-one')
    const second = candidate('key-two')
    const seen: SeenRequest[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        recordRequest(seen, url, init)
        return seen.length === 1
          ? jsonResponse({ error: { message: 'exhausted' } }, 429, { 'x-ratelimit-limit': '0' })
          : jsonResponse({ id: 'completion_1', choices: [{ index: 0, text: 'ok' }] })
      }),
    )

    await textCompletionsOnce(
      {
        profile: profile('llama-server', 'http://localhost:8080/v1'),
        apiKey: 'legacy-unused',
        apiKeyCandidates: [first, second],
      },
      { model: 'm', prompt: 'hi', stream: true },
    )

    expect(seen.map((request) => request.url)).toEqual([
      'http://localhost:8080/v1/completions',
      'http://localhost:8080/v1/completions',
    ])
    expect(requestBody(seen[0] as SeenRequest)).toBe(requestBody(seen[1] as SeenRequest))
    expect(requestHeaders(seen[0] as SeenRequest).Authorization).toBe('Bearer key-one')
    expect(requestHeaders(seen[1] as SeenRequest).Authorization).toBe('Bearer key-two')
  })

  it('rebuilds native Gemini x-goog-api-key auth for each candidate', async () => {
    const first = candidate('gemini-one')
    const second = candidate('gemini-two')
    const seen: SeenRequest[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        recordRequest(seen, url, init)
        return seen.length === 1
          ? jsonResponse({ error: { message: 'expired' } }, 401)
          : jsonResponse({ candidates: [] })
      }),
    )

    await geminiOnce(
      {
        profile: profile('google', 'https://generativelanguage.googleapis.com/v1beta'),
        apiKey: 'legacy-unused',
        apiKeyCandidates: [first, second],
      },
      { contents: [] },
      'gemini-flash',
    )

    expect(seen[0]?.url).toBe(seen[1]?.url)
    expect(requestBody(seen[0] as SeenRequest)).toBe(requestBody(seen[1] as SeenRequest))
    expect(requestHeaders(seen[0] as SeenRequest)['x-goog-api-key']).toBe('gemini-one')
    expect(requestHeaders(seen[1] as SeenRequest)['x-goog-api-key']).toBe('gemini-two')
    expect(requestHeaders(seen[1] as SeenRequest).Authorization).toBeUndefined()
  })

  it('rebuilds native Anthropic x-api-key auth for each candidate', async () => {
    const first = candidate('anthropic-one')
    const second = candidate('anthropic-two')
    const seen: SeenRequest[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        recordRequest(seen, url, init)
        return seen.length === 1
          ? jsonResponse({ error: { message: 'expired' } }, 401)
          : jsonResponse({ id: 'msg_1', content: [] })
      }),
    )

    await anthropicOnce(
      {
        profile: profile('anthropic', 'https://api.anthropic.com/v1'),
        apiKey: 'legacy-unused',
        apiKeyCandidates: [first, second],
      },
      { model: 'claude', max_tokens: 64, messages: [] },
    )

    expect(seen[0]?.url).toBe(seen[1]?.url)
    expect(requestBody(seen[0] as SeenRequest)).toBe(requestBody(seen[1] as SeenRequest))
    expect(JSON.parse(requestBody(seen[1] as SeenRequest))).toMatchObject({ stream: false })
    expect(requestHeaders(seen[0] as SeenRequest)['x-api-key']).toBe('anthropic-one')
    expect(requestHeaders(seen[1] as SeenRequest)['x-api-key']).toBe('anthropic-two')
    expect(requestHeaders(seen[1] as SeenRequest).Authorization).toBeUndefined()
  })

  it('pins the successful POST key for every video polling GET', async () => {
    vi.useFakeTimers()
    const first = candidate('key-one')
    const second = candidate('key-two')
    const selected = vi.fn()
    const seen: SeenRequest[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        recordRequest(seen, url, init)
        if (seen.length === 1) return jsonResponse({ error: { message: 'expired' } }, 401)
        if (seen.length === 2) {
          return jsonResponse({
            id: 'video_1',
            status: 'pending',
            polling_url: 'https://openrouter.ai/api/v1/videos/video_1',
          })
        }
        return jsonResponse({
          id: 'video_1',
          status: 'completed',
          polling_url: 'https://openrouter.ai/api/v1/videos/video_1',
          unsigned_urls: ['https://cdn.example/video.mp4'],
        })
      }),
    )

    const iterator = videoGeneration(
      {
        profile: profile(),
        apiKey: 'legacy-unused',
        apiKeyCandidates: [first, second],
        onKeyCandidateSelected: selected,
      },
      { model: 'video-model', prompt: 'hi' },
    )
    expect((await iterator.next()).value).toEqual({
      type: 'keepalive',
      comment: 'video:pending',
    })
    const poll = iterator.next()
    await vi.advanceTimersByTimeAsync(10_000)
    expect((await poll).value).toEqual({ type: 'keepalive', comment: 'video:completed' })
    expect((await iterator.next()).value).toMatchObject({ type: 'delta' })

    expect(seen).toHaveLength(3)
    expect(seen[0]?.url).toBe(seen[1]?.url)
    expect(requestBody(seen[0] as SeenRequest)).toBe(requestBody(seen[1] as SeenRequest))
    expect(requestHeaders(seen[0] as SeenRequest).Authorization).toBe('Bearer key-one')
    expect(requestHeaders(seen[1] as SeenRequest).Authorization).toBe('Bearer key-two')
    expect(seen[2]?.init.method).toBe('GET')
    expect(requestHeaders(seen[2] as SeenRequest).Authorization).toBe('Bearer key-two')
    expect(second.resolve).toHaveBeenCalledOnce()
    expect(selected).toHaveBeenCalledTimes(1)
    expect(selected).toHaveBeenCalledWith(second, 1, 'key-two')
  })

  it.each([
    ['cancelled', 'Video generation was cancelled.'],
    ['expired', 'Video generation expired.'],
  ])('treats video status %s as terminal', async (status, message) => {
    const seen: SeenRequest[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        recordRequest(seen, url, init)
        return jsonResponse({
          id: 'video_terminal',
          status,
          polling_url: 'https://openrouter.ai/api/v1/videos/video_terminal',
        })
      }),
    )

    const iterator = videoGeneration(
      { profile: profile(), apiKey: 'video-key', apiKeyCandidates: [] },
      { model: 'video-model', prompt: 'hi' },
    )
    expect((await iterator.next()).value).toEqual({
      type: 'keepalive',
      comment: `video:${status}`,
    })
    expect((await iterator.next()).value).toMatchObject({
      type: 'delta',
      chunk: {
        error: { code: 'video_generation_failed', message },
      },
    })
    expect((await iterator.next()).done).toBe(true)
    expect(seen).toHaveLength(1)
  })

  it('forwards candidates through the buffered assistant dispatcher', async () => {
    const first = candidate('key-one')
    const second = candidate('key-two')
    const selected = vi.fn()
    const seen: SeenRequest[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        recordRequest(seen, url, init)
        return seen.length === 1
          ? jsonResponse({ error: { message: 'expired' } }, 401)
          : jsonResponse({ id: 'resp_1', status: 'completed', output: [] })
      }),
    )
    const requestPlan = createAssistantDispatchPlan({
      ...responsesRouteContract(),
      requestedModel: 'm',
      wire: { model: 'm', input: 'hi', stream: false },
    })

    const chunks = []
    const stream = openAssistantRequestStream({
      connection: profile('openai-compatible', 'https://api.openai.com/v1'),
      apiKey: 'legacy-unused',
      apiKeyCandidates: [first, second],
      onKeyCandidateSelected: selected,
      requestPlan,
    })
    expect(seen).toEqual([])
    requestPlan.wire = {}
    for await (const chunk of stream) {
      chunks.push(chunk)
    }

    expect(chunks).toEqual([
      { type: 'buffered_result', result: { id: 'resp_1', status: 'completed', output: [] } },
    ])
    expect(seen.map((request) => requestBody(request))).toEqual([
      '{"model":"m","input":"hi","stream":false}',
      '{"model":"m","input":"hi","stream":false}',
    ])
    expect(selected).toHaveBeenCalledWith(second, 1, 'key-two')
  })
})

describe('explicit auth-header overrides', () => {
  const cases: Array<{
    name: string
    kind: ConnectionProfile['kind']
    baseUrl: string
    authHeader: 'Authorization' | 'x-goog-api-key' | 'x-api-key'
    source: 'profile' | 'call'
    invoke: (ctx: AdapterContext, overrideHeaders: Record<string, string>) => Promise<void>
  }> = [
    {
      name: 'chat completions',
      kind: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      authHeader: 'Authorization',
      source: 'call',
      invoke: async (ctx, overrideHeaders) => {
        for await (const _ of chatCompletions(
          ctx,
          { model: 'm', messages: [], stream: true },
          { overrideHeaders },
        )) {
          // drain
        }
      },
    },
    {
      name: 'Responses',
      kind: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      authHeader: 'Authorization',
      source: 'profile',
      invoke: async (ctx) => {
        await responsesOnce(ctx, { model: 'm', input: 'hi' })
      },
    },
    {
      name: 'text completions',
      kind: 'llama-server',
      baseUrl: 'http://localhost:8080/v1',
      authHeader: 'Authorization',
      source: 'call',
      invoke: async (ctx, overrideHeaders) => {
        await textCompletionsOnce(ctx, { model: 'm', prompt: 'hi' }, { overrideHeaders })
      },
    },
    {
      name: 'Gemini native',
      kind: 'google',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      authHeader: 'x-goog-api-key',
      source: 'profile',
      invoke: async (ctx) => {
        await geminiOnce(ctx, { contents: [] }, 'gemini-flash')
      },
    },
    {
      name: 'Anthropic Messages',
      kind: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      authHeader: 'x-api-key',
      source: 'call',
      invoke: async (ctx, overrideHeaders) => {
        await anthropicOnce(
          ctx,
          { model: 'claude', max_tokens: 64, messages: [] },
          { overrideHeaders },
        )
      },
    },
    {
      name: 'video generation',
      kind: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      authHeader: 'Authorization',
      source: 'profile',
      invoke: async (ctx) => {
        await videoGeneration(ctx, { model: 'video-model', prompt: 'hi' }).next()
      },
    },
  ]

  it.each(
    cases,
  )('$name sends exactly one POST when $authHeader is explicitly overridden by $source headers', async ({
    kind,
    baseUrl,
    authHeader,
    source,
    invoke,
  }) => {
    const explicitHeaderName = authHeader.toUpperCase()
    const explicitHeaders = { [explicitHeaderName]: 'fixed-custom-auth' }
    const connection = {
      ...profile(kind, baseUrl),
      defaultHeaders: source === 'profile' ? explicitHeaders : {},
    }
    const primary = candidate('primary-key')
    const fallback = candidate('fallback-key')
    const selected = vi.fn()
    const seen: SeenRequest[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        recordRequest(seen, url, init)
        return jsonResponse({ error: { message: 'fixed credential rejected' } }, 401)
      }),
    )
    const ctx: AdapterContext = {
      profile: connection,
      apiKey: '',
      apiKeyCandidates: [primary, fallback],
      onKeyCandidateSelected: selected,
    }

    await expect(invoke(ctx, source === 'call' ? explicitHeaders : {})).rejects.toThrow(
      /fixed credential rejected/i,
    )

    expect(seen).toHaveLength(1)
    expect(seen[0]?.init.method).toBe('POST')
    expect(headerValue(seen[0] as SeenRequest, authHeader)).toBe('fixed-custom-auth')
    expect(primary.resolve).not.toHaveBeenCalled()
    expect(fallback.resolve).not.toHaveBeenCalled()
    expect(selected).not.toHaveBeenCalled()
  })
})
