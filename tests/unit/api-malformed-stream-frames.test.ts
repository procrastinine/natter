import { afterEach, describe, expect, it, vi } from 'vitest'
import { anthropicOnce, anthropicStream } from '../../src/api/anthropic-messages'
import { splitAssistantStream } from '../../src/api/assistant-lanes'
import type { AssistantStreamChunk } from '../../src/api/assistant-stream'
import { chatCompletions, chatCompletionsOnce } from '../../src/api/chat-completions'
import { ApiError } from '../../src/api/errors'
import { geminiOnce, geminiStream } from '../../src/api/gemini-native'
import { responses, responsesOnce } from '../../src/api/responses'
import type { StreamLaneEvent } from '../../src/api/stream-transforms'
import { textCompletions, textCompletionsOnce } from '../../src/api/text-completions'
import { videoGeneration } from '../../src/api/video-generation'
import type { ApiRoute } from '../../src/core/api-choice'
import type { ConnectionProfile } from '../../src/core/types'
import { redactDiagnosticValue } from '../../src/lib/diagnostic-redaction'

function profile(kind: ConnectionProfile['kind'], baseUrl: string): ConnectionProfile {
  return {
    id: `profile-${kind}`,
    name: kind,
    kind,
    baseUrl,
    apiKeyRef: 'key-ref',
    defaultHeaders: {},
    appTitle: 'natter',
    appUrl: '',
    supportsEndpointsApi: false,
    supportsGenerationApi: false,
    supportsPrivacyScrape: false,
    createdAt: 0,
    updatedAt: 0,
  }
}

function sseResponse(
  malformedData: string,
  malformedEventType: string,
  validFrames: ReadonlyArray<{ eventType?: string; data: string }>,
): Response {
  const lines = [`event: ${malformedEventType}`, `data: ${malformedData}`, '']
  for (const frame of validFrames) {
    if (frame.eventType) lines.push(`event: ${frame.eventType}`)
    lines.push(`data: ${frame.data}`, '')
  }
  lines.push('')
  const body = lines.join('\n')
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body))
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

async function collectLanes(stream: AsyncIterable<StreamLaneEvent>): Promise<StreamLaneEvent[]> {
  const lanes: StreamLaneEvent[] = []
  for await (const lane of stream) lanes.push(lane)
  return lanes
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of stream) {
    /* drain */
  }
}

async function captureFailure(run: () => Promise<void>): Promise<unknown> {
  try {
    await run()
    return undefined
  } catch (error) {
    return error
  }
}

afterEach(() => vi.restoreAllMocks())

describe('malformed stream-frame diagnostics', () => {
  const malformedData =
    '{"authorization":"Bearer frame-secret","nested":{"apiKey":"frame-key"},"prompt":"full private prompt"'
  const cases: Array<{
    name: string
    adapter:
      | 'chat-completions'
      | 'responses'
      | 'anthropic-messages'
      | 'gemini-native'
      | 'text-completions'
    malformedEventType: string
    expectedEventType: string
    transportHint: ApiRoute['transport']
    validFrames: ReadonlyArray<{ eventType?: string; data: string }>
    validLanes: StreamLaneEvent[]
    run: () => AsyncIterable<AssistantStreamChunk>
  }> = [
    {
      name: 'chat completions',
      adapter: 'chat-completions',
      malformedEventType: 'private-full-private-prompt',
      expectedEventType: 'unknown',
      transportHint: 'openai-chat',
      validFrames: [{ data: '{"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}' }],
      validLanes: [
        { lane: 'text', text: 'ok' },
        { lane: 'finish', finishReason: 'stop' },
      ],
      run: () =>
        chatCompletions(
          {
            profile: profile('openai-compatible', 'https://example.test/v1'),
            apiKey: 'request-secret',
          },
          { model: 'model', messages: [], stream: true },
        ),
    },
    {
      name: 'Responses',
      adapter: 'responses',
      malformedEventType: 'response.output_text.delta',
      expectedEventType: 'response.output_text.delta',
      transportHint: 'openai-responses',
      validFrames: [
        {
          eventType: 'response.output_text.delta',
          data: '{"type":"response.output_text.delta","delta":"ok","output_index":0,"content_index":0}',
        },
        {
          eventType: 'response.completed',
          data: '{"type":"response.completed","response":{"status":"completed"}}',
        },
      ],
      validLanes: [
        { lane: 'text', text: 'ok', outputIndex: 0, contentIndex: 0 },
        { lane: 'finish', finishReason: 'stop' },
      ],
      run: () =>
        responses(
          {
            profile: profile('openai-compatible', 'https://example.test/v1'),
            apiKey: 'request-secret',
          },
          { model: 'model', input: 'input', stream: true },
        ),
    },
    {
      name: 'Anthropic Messages',
      adapter: 'anthropic-messages',
      malformedEventType: 'content_block_delta',
      expectedEventType: 'content_block_delta',
      transportHint: 'anthropic',
      validFrames: [
        {
          eventType: 'content_block_start',
          data: '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":"ok"}}',
        },
        { eventType: 'message_stop', data: '{"type":"message_stop"}' },
      ],
      validLanes: [
        { lane: 'text', text: 'ok', outputIndex: 0, contentIndex: 0 },
        { lane: 'finish', finishReason: 'stop' },
      ],
      run: () =>
        anthropicStream(
          {
            profile: profile('anthropic', 'https://example.test/v1'),
            apiKey: 'request-secret',
          },
          { model: 'model', max_tokens: 1, messages: [] },
        ),
    },
    {
      name: 'Gemini native',
      adapter: 'gemini-native',
      malformedEventType: 'message',
      expectedEventType: 'message',
      transportHint: 'gemini-native',
      validFrames: [
        {
          data: '{"candidates":[{"content":{"role":"model","parts":[{"text":"ok"}]},"finishReason":"STOP"}]}',
        },
      ],
      validLanes: [
        { lane: 'text', text: 'ok' },
        { lane: 'finish', finishReason: 'stop' },
      ],
      run: () =>
        geminiStream(
          {
            profile: profile('google', 'https://example.test/v1beta'),
            apiKey: 'request-secret',
          },
          { contents: [] },
          'model',
        ),
    },
    {
      name: 'text completions',
      adapter: 'text-completions',
      malformedEventType: 'private-full-private-prompt',
      expectedEventType: 'unknown',
      transportHint: 'openai-text',
      validFrames: [{ data: '{"choices":[{"text":"ok","finish_reason":"stop"}]}' }],
      validLanes: [
        { lane: 'text', text: 'ok' },
        { lane: 'finish', finishReason: 'stop' },
      ],
      run: () =>
        textCompletions(
          {
            profile: profile('llama-server', 'https://example.test/v1'),
            apiKey: 'request-secret',
          },
          { model: 'model', prompt: 'input', stream: true },
        ),
    },
  ]

  for (const adapter of cases) {
    it(`${adapter.name} reports the bad frame and still emits the exact valid finish trace`, async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          sseResponse(malformedData, adapter.malformedEventType, adapter.validFrames),
        ),
      )
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const lanes = await collectLanes(splitAssistantStream(adapter.run(), adapter.transportHint))

      const integrityLane = lanes[0]
      expect(integrityLane).toMatchObject({
        lane: 'integrity',
        integrity: {
          category: 'malformed-json-frame',
          adapter: adapter.adapter,
          eventType: adapter.expectedEventType,
          count: 1,
          characterCount: malformedData.length,
        },
      })
      if (integrityLane?.lane !== 'integrity') throw new Error('expected stream integrity lane')
      expect(integrityLane.integrity.fingerprint).toMatch(/^fnv1a32:[0-9a-f]{8}$/u)
      expect(lanes.slice(1)).toEqual(adapter.validLanes)
      expect(warn).toHaveBeenCalledTimes(1)
      const warning = warn.mock.calls[0]?.[1] as Record<string, unknown>
      expect(warning).toMatchObject({
        eventType: adapter.expectedEventType,
        characterCount: malformedData.length,
        error: { name: 'SyntaxError' },
      })
      expect(warning.fingerprint).toMatch(/^fnv1a32:[0-9a-f]{8}$/u)
      const serialized = JSON.stringify({ warnings: warn.mock.calls, lanes })
      expect(serialized).not.toContain(malformedData)
      expect(serialized).not.toContain('private-full-private-prompt')
      expect(serialized).not.toContain('frame-secret')
      expect(serialized).not.toContain('frame-key')
      expect(serialized).not.toContain('full private prompt')
      expect(serialized).not.toContain('request-secret')
    })
  }

  it('redacts secret-like keys recursively without hiding token counts', () => {
    const redacted = redactDiagnosticValue({
      headers: {
        Authorization: 'Bearer nested-secret',
        'x-goog-api-key': 'google-secret',
        Accept: 'application/json',
      },
      nested: [{ password: 'password-secret', completion_tokens: 42 }],
    })

    expect(redacted).toEqual({
      headers: {
        Authorization: '<redacted>',
        'x-goog-api-key': '<redacted>',
        Accept: 'application/json',
      },
      nested: [{ password: '<redacted>', completion_tokens: 42 }],
    })
  })
})

describe('provider JSON boundary errors', () => {
  const cases: Array<{
    name: string
    runBuffered: () => Promise<void>
    runOnce?: () => Promise<unknown>
  }> = [
    {
      name: 'chat completions',
      runBuffered: () =>
        drain(
          chatCompletions(
            {
              profile: profile('openai-compatible', 'https://example.test/v1'),
              apiKey: 'request-secret',
            },
            { model: 'model', messages: [], stream: true },
          ),
        ),
      runOnce: () =>
        chatCompletionsOnce(
          {
            profile: profile('openai-compatible', 'https://example.test/v1'),
            apiKey: 'request-secret',
          },
          { model: 'model', messages: [] },
        ),
    },
    {
      name: 'Responses',
      runBuffered: () =>
        drain(
          responses(
            {
              profile: profile('openai-compatible', 'https://example.test/v1'),
              apiKey: 'request-secret',
            },
            { model: 'model', input: 'input', stream: true },
          ),
        ),
      runOnce: () =>
        responsesOnce(
          {
            profile: profile('openai-compatible', 'https://example.test/v1'),
            apiKey: 'request-secret',
          },
          { model: 'model', input: 'input' },
        ),
    },
    {
      name: 'Anthropic Messages',
      runBuffered: () =>
        drain(
          anthropicStream(
            {
              profile: profile('anthropic', 'https://example.test/v1'),
              apiKey: 'request-secret',
            },
            { model: 'model', max_tokens: 1, messages: [] },
          ),
        ),
      runOnce: () =>
        anthropicOnce(
          {
            profile: profile('anthropic', 'https://example.test/v1'),
            apiKey: 'request-secret',
          },
          { model: 'model', max_tokens: 1, messages: [] },
        ),
    },
    {
      name: 'Gemini native',
      runBuffered: () =>
        drain(
          geminiStream(
            {
              profile: profile('google', 'https://example.test/v1beta'),
              apiKey: 'request-secret',
            },
            { contents: [] },
            'model',
          ),
        ),
      runOnce: () =>
        geminiOnce(
          {
            profile: profile('google', 'https://example.test/v1beta'),
            apiKey: 'request-secret',
          },
          { contents: [] },
          'model',
        ),
    },
    {
      name: 'text completions',
      runBuffered: () =>
        drain(
          textCompletions(
            {
              profile: profile('llama-server', 'https://example.test/v1'),
              apiKey: 'request-secret',
            },
            { model: 'model', prompt: 'input', stream: true },
          ),
        ),
      runOnce: () =>
        textCompletionsOnce(
          {
            profile: profile('llama-server', 'https://example.test/v1'),
            apiKey: 'request-secret',
          },
          { model: 'model', prompt: 'input' },
        ),
    },
    {
      name: 'video generation',
      runBuffered: () =>
        drain(
          videoGeneration(
            {
              profile: profile('openrouter', 'https://example.test/v1'),
              apiKey: 'request-secret',
            },
            { model: 'video-model', prompt: 'input' },
          ),
        ),
    },
  ]
  const invalidResponseCases = [
    {
      name: 'invalid JSON',
      createResponse: () =>
        new Response('{"prompt":"private-buffered-prompt"', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    },
    {
      name: 'no body',
      createResponse: () =>
        new Response(null, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    },
  ]

  for (const adapter of cases) {
    for (const responseCase of invalidResponseCases) {
      const paths = adapter.runOnce ? 'buffered and once paths' : 'buffered path'
      it(`${adapter.name} normalizes ${responseCase.name} for ${paths}`, async () => {
        vi.stubGlobal(
          'fetch',
          vi.fn(async () => responseCase.createResponse()),
        )

        const failures = [await captureFailure(adapter.runBuffered)]
        const runOnce = adapter.runOnce
        if (runOnce) {
          failures.push(await captureFailure(async () => void (await runOnce())))
        }

        for (const failure of failures) {
          expect(failure).toBeInstanceOf(ApiError)
          expect(failure).toMatchObject({
            kind: 'protocol',
            code: 'PROTOCOL',
            message: 'Provider response could not be decoded',
            midStream: false,
            retryable: false,
          })
          expect(JSON.stringify(failure)).not.toContain('private-buffered-prompt')
          expect(JSON.stringify(failure)).not.toContain('request-secret')
        }
      })
    }
  }
})
