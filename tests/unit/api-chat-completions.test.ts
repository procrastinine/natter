import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type ChatCompletionsContext,
  chatCompletions,
  chatCompletionsOnce,
} from '../../src/api/chat-completions'
import { ApiError } from '../../src/api/errors'
import type { ChatStreamChunk } from '../../src/api/types'
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

function ctx(): ChatCompletionsContext {
  return { profile: makeProfile(), apiKey: 'sk-test' }
}

function sseResponse(body: string, extraHeaders: Record<string, string> = {}): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body))
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      ...extraHeaders,
    },
  })
}

function jsonResponse(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('chatCompletions', () => {
  it('requires stream:true (throws otherwise so callers use chatCompletionsOnce)', async () => {
    await expect(async () => {
      const iter = chatCompletions(ctx(), { model: 'm', messages: [], stream: false })
      await iter.next()
    }).rejects.toThrow(/stream:true/)
  })

  it('yields a synthetic buffered_result when the upstream answers with JSON', async () => {
    const buffered = {
      id: 'gen-1',
      choices: [{ finish_reason: 'stop', message: { content: 'hello' } }],
      usage: { prompt_tokens: 3, completion_tokens: 1 },
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse(buffered))),
    )
    const chunks: ChatStreamChunk[] = []
    for await (const c of chatCompletions(ctx(), {
      model: 'm',
      messages: [],
      stream: true,
    })) {
      chunks.push(c)
    }
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toMatchObject({ type: 'buffered_result' })
    const first = chunks[0]
    if (first?.type !== 'buffered_result') throw new Error('expected buffered_result')
    expect(first.result.id).toBe('gen-1')
  })

  it('parses SSE chunks, skipping malformed JSON without killing the stream', async () => {
    const body = [
      'data: {"id":"gen-x","choices":[{"delta":{"content":"A"}}]}',
      '',
      'data: {not valid json}',
      '',
      'data: {"id":"gen-x","choices":[{"delta":{"content":"B"}}]}',
      '',
      'data: [DONE]',
      '',
      '',
    ].join('\n')
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(sseResponse(body))),
    )
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const chunks: ChatStreamChunk[] = []
    for await (const c of chatCompletions(ctx(), {
      model: 'm',
      messages: [],
      stream: true,
    })) {
      chunks.push(c)
    }
    expect(chunks).toHaveLength(2)
    expect(chunks[0]?.type).toBe('delta')
    expect(chunks[1]?.type).toBe('delta')
    if (chunks[0]?.type === 'delta') {
      expect(chunks[0].chunk.choices?.[0]?.delta?.content).toBe('A')
    }
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('forwards keepalive comments so callers can drive hang detection', async () => {
    const body = [
      ': OPENROUTER PROCESSING',
      '',
      'data: {"choices":[{"delta":{"content":"hi"}}]}',
      '',
      'data: [DONE]',
      '',
      '',
    ].join('\n')
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(sseResponse(body))),
    )
    const chunks: ChatStreamChunk[] = []
    for await (const c of chatCompletions(ctx(), {
      model: 'm',
      messages: [],
      stream: true,
    })) {
      chunks.push(c)
    }
    expect(chunks[0]).toEqual({ type: 'keepalive', comment: 'OPENROUTER PROCESSING' })
    expect(chunks[1]?.type).toBe('delta')
  })

  it('backfills x-generation-id onto chunks that lack an id', async () => {
    const body = [
      'data: {"choices":[{"delta":{"content":"hi"}}]}',
      '',
      'data: [DONE]',
      '',
      '',
    ].join('\n')
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(sseResponse(body, { 'x-generation-id': 'gen-42' }))),
    )
    const chunks: ChatStreamChunk[] = []
    for await (const c of chatCompletions(ctx(), {
      model: 'm',
      messages: [],
      stream: true,
    })) {
      chunks.push(c)
    }
    const first = chunks[0]
    if (first?.type !== 'delta') throw new Error('expected delta')
    expect(first.generationId).toBe('gen-42')
    expect(first.chunk.id).toBe('gen-42')
  })

  it('throws ApiError on HTTP 429 before the body can be consumed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({ error: { code: 429, message: 'slow' } }, 429))),
    )
    await expect(async () => {
      for await (const _ of chatCompletions(ctx(), {
        model: 'm',
        messages: [],
        stream: true,
      })) {
        /* noop */
      }
    }).rejects.toBeInstanceOf(ApiError)
  })

  it('normalizes legacy Google compatibility profiles onto /openai/chat/completions', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse({
          id: 'gen-g',
          choices: [{ finish_reason: 'stop', message: { content: 'hi' } }],
        }),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    await chatCompletionsOnce(
      {
        profile: makeProfile({
          kind: 'google',
          baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        }),
        apiKey: 'gemini-key',
      },
      {
        model: 'gemini-3-flash-preview',
        messages: [],
        stream: true,
      },
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const firstCall = fetchMock.mock.calls[0]
    expect(firstCall).toBeDefined()
    const [url, init] = firstCall as unknown as [string, RequestInit | undefined]
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions')
    const headers = init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer gemini-key')
    expect(headers['X-OpenRouter-Title']).toBeUndefined()
  })
})

describe('chatCompletionsOnce', () => {
  it('forces stream:false on the wire and returns the parsed JSON', async () => {
    const fetchMock = vi.fn(
      (_url: string, _init?: RequestInit): Promise<Response> =>
        Promise.resolve(
          jsonResponse({
            id: 'gen-1',
            choices: [{ finish_reason: 'stop', message: { content: 'hi' } }],
          }),
        ),
    )
    vi.stubGlobal('fetch', fetchMock)
    const result = await chatCompletionsOnce(ctx(), {
      model: 'm',
      messages: [],
      stream: true, // caller sent true; the helper must override to false.
    })
    expect(result.id).toBe('gen-1')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const call = fetchMock.mock.calls[0]
    if (!call) throw new Error('expected one fetch call')
    const init = call[1]
    if (!init) throw new Error('expected init arg')
    const body = JSON.parse(init.body as string) as { stream: boolean }
    expect(body.stream).toBe(false)
  })
})
