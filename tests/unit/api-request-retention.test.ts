import { afterEach, describe, expect, it, vi } from 'vitest'
import { anthropicStream } from '../../src/api/anthropic-messages'
import { chatCompletions } from '../../src/api/chat-completions'
import { geminiStream } from '../../src/api/gemini-native'
import { responses } from '../../src/api/responses'
import { textCompletions } from '../../src/api/text-completions'
import { videoGeneration } from '../../src/api/video-generation'
import type { ConnectionProfile } from '../../src/core/types'

function profile(kind: ConnectionProfile['kind'], baseUrl: string): ConnectionProfile {
  return {
    id: `profile-${kind}`,
    name: kind,
    kind,
    baseUrl,
    apiKeyRef: 'key',
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

function sse(body: string): Response {
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}

afterEach(() => vi.restoreAllMocks())

describe('adapter request retention', () => {
  const cases: Array<{
    name: string
    expectedBody: string
    response: () => Response
    open: () => AsyncGenerator<unknown, void, unknown>
  }> = [
    {
      name: 'chat completions',
      expectedBody: JSON.stringify({
        model: 'model',
        messages: [{ role: 'user', content: 'request' }],
        stream: true,
        marker: { value: 1 },
      }),
      response: () => sse('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'),
      open: () =>
        chatCompletions(
          {
            profile: profile('openai-compatible', 'https://example.test/v1'),
            apiKey: 'key',
          },
          {
            model: 'model',
            messages: [{ role: 'user', content: 'request' }],
            stream: true,
            marker: { value: 1 },
          },
        ),
    },
    {
      name: 'Responses',
      expectedBody: JSON.stringify({
        model: 'model',
        input: 'request',
        stream: true,
        marker: { value: 1 },
      }),
      response: () =>
        sse(
          'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\n',
        ),
      open: () =>
        responses(
          {
            profile: profile('openai-compatible', 'https://example.test/v1'),
            apiKey: 'key',
          },
          { model: 'model', input: 'request', stream: true, marker: { value: 1 } },
        ),
    },
    {
      name: 'text completions',
      expectedBody: JSON.stringify({
        model: 'model',
        prompt: 'request',
        stream: true,
        marker: { value: 1 },
      }),
      response: () => sse('data: {"choices":[{"text":"ok"}]}\n\n'),
      open: () =>
        textCompletions(
          {
            profile: profile('llama-server', 'https://example.test/v1'),
            apiKey: 'key',
          },
          { model: 'model', prompt: 'request', stream: true, marker: { value: 1 } },
        ),
    },
    {
      name: 'Gemini native',
      expectedBody: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'request' }] }],
        generationConfig: { maxOutputTokens: 5 },
      }),
      response: () =>
        sse('data: {"candidates":[{"content":{"role":"model","parts":[{"text":"ok"}]}}]}\n\n'),
      open: () =>
        geminiStream(
          {
            profile: profile('google', 'https://example.test/v1beta'),
            apiKey: 'key',
          },
          {
            contents: [{ role: 'user', parts: [{ text: 'request' }] }],
            generationConfig: { maxOutputTokens: 5 },
          },
          'model',
        ),
    },
    {
      name: 'Anthropic Messages',
      expectedBody: JSON.stringify({
        model: 'model',
        max_tokens: 5,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'request' }] }],
        stream: true,
      }),
      response: () =>
        sse(
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
        ),
      open: () =>
        anthropicStream(
          {
            profile: profile('anthropic', 'https://example.test/v1'),
            apiKey: 'key',
          },
          {
            model: 'model',
            max_tokens: 5,
            messages: [{ role: 'user', content: [{ type: 'text', text: 'request' }] }],
          },
        ),
    },
    {
      name: 'video generation',
      expectedBody: JSON.stringify({
        model: 'model',
        prompt: 'request',
        marker: { value: 1 },
      }),
      response: () =>
        new Response(
          JSON.stringify({
            id: 'video',
            status: 'pending',
            polling_url: 'https://example.test/v1/videos/video',
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      open: () =>
        videoGeneration(
          {
            profile: profile('openrouter', 'https://example.test/v1'),
            apiKey: 'key',
          },
          { model: 'model', prompt: 'request', marker: { value: 1 } },
        ),
    },
  ]

  it.each(cases)('$name stays lazy and sends the exact body on its first pull', async ({
    expectedBody,
    response,
    open,
  }) => {
    let body: BodyInit | null | undefined
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      body = init?.body
      return response()
    })
    vi.stubGlobal('fetch', fetchMock)

    const stream = open()
    expect(fetchMock).not.toHaveBeenCalled()

    const first = await stream.next()

    expect(first.done).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(body).toBe(expectedBody)
    await stream.return(undefined)
  })

  it('releases an unstarted request without dispatching when the consumer closes it', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const stream = chatCompletions(
      {
        profile: profile('openai-compatible', 'https://example.test/v1'),
        apiKey: 'key',
      },
      { model: 'model', messages: [], stream: true },
    )

    await stream.return(undefined)

    expect(fetchMock).not.toHaveBeenCalled()
  })
})
