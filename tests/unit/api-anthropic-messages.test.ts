import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type AnthropicContext,
  anthropicOnce,
  anthropicStream,
} from '../../src/api/anthropic-messages'
import type { AnthropicStreamChunk } from '../../src/api/anthropic-types'
import type { ConnectionProfile } from '../../src/core/types'

function profile(overrides: Partial<ConnectionProfile> = {}): ConnectionProfile {
  return {
    id: 'a',
    name: 'Anthropic',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    apiKeyRef: 'k',
    defaultHeaders: {},
    appTitle: 'natter',
    appUrl: '',
    supportsEndpointsApi: false,
    supportsGenerationApi: false,
    supportsPrivacyScrape: false,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

function ctx(): AnthropicContext {
  return { profile: profile(), apiKey: 'sk-ant-test' }
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
    headers: { 'content-type': 'text/event-stream', ...extraHeaders },
  })
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => vi.restoreAllMocks())

describe('anthropicStream', () => {
  it('posts to /v1/messages with native Anthropic auth and beta headers', async () => {
    const seen: Array<{ url: string; headers: Record<string, string>; body: unknown }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        if (typeof init.body !== 'string') throw new Error('expected string request body')
        seen.push({
          url,
          headers: init.headers as Record<string, string>,
          body: JSON.parse(init.body) as unknown,
        })
        return sseResponse('')
      }),
    )

    for await (const _ of anthropicStream(ctx(), {
      model: 'claude-haiku-4-5',
      max_tokens: 80,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [
        { type: 'web_fetch_20250910', name: 'web_fetch' },
        { type: 'code_execution_20250825', name: 'code_execution' },
        { type: 'advisor_20260301', name: 'advisor', model: 'claude-opus-4-7' },
      ],
    })) {
      // drain
    }

    expect(seen[0]?.url).toBe('https://api.anthropic.com/v1/messages')
    expect(seen[0]?.headers['x-api-key']).toBe('sk-ant-test')
    expect(seen[0]?.headers.Authorization).toBeUndefined()
    expect(seen[0]?.headers['anthropic-version']).toBe('2023-06-01')
    expect(seen[0]?.headers['anthropic-beta']).toBe(
      'web-fetch-2025-09-10,code-execution-2025-08-25,advisor-tool-2026-03-01',
    )
    expect(seen[0]?.headers['anthropic-dangerous-direct-browser-access']).toBe('true')
    expect(seen[0]?.body).toMatchObject({ stream: true })
  })

  it('parses Messages SSE events into Anthropic chunks', async () => {
    const body = [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"msg_1","model":"claude-haiku-4-5","content":[]}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sseResponse(body, { 'anthropic-request-id': 'req_1' })),
    )

    const chunks: AnthropicStreamChunk[] = []
    for await (const chunk of anthropicStream(ctx(), {
      model: 'claude-haiku-4-5',
      max_tokens: 80,
      messages: [],
    })) {
      chunks.push(chunk)
    }

    expect(chunks).toEqual([
      {
        type: 'anthropic_event',
        generationId: 'req_1',
        event: {
          type: 'message_start',
          message: { id: 'msg_1', model: 'claude-haiku-4-5', content: [] },
        },
      },
      {
        type: 'anthropic_event',
        generationId: 'req_1',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      },
      {
        type: 'anthropic_event',
        generationId: 'req_1',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
      },
      { type: 'anthropic_event', generationId: 'req_1', event: { type: 'message_stop' } },
    ])
  })
})

describe('anthropicOnce', () => {
  it('uses buffered Messages body and normalizes 4xx errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ error: { type: 'invalid_request_error', message: 'bad tool' } }, 400),
      ),
    )
    await expect(
      anthropicOnce(ctx(), { model: 'claude-haiku-4-5', max_tokens: 80, messages: [] }),
    ).rejects.toThrow(/bad tool/i)
  })
})
