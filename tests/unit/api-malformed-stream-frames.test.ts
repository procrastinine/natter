import { afterEach, describe, expect, it, vi } from 'vitest'
import { anthropicOnce, anthropicStream } from '../../src/api/anthropic-messages'
import { splitAssistantStream } from '../../src/api/assistant-lanes'
import type { AssistantStreamChunk } from '../../src/api/assistant-stream'
import { chatCompletions, chatCompletionsOnce } from '../../src/api/chat-completions'
import { ApiError } from '../../src/api/errors'
import { geminiOnce, geminiStream } from '../../src/api/gemini-native'
import {
  validateAnthropicResult,
  validateChatCompletionResult,
  validateGeminiResponse,
  validateResponsesResult,
  validateTextCompletionPayload,
} from '../../src/api/provider-json-boundary'
import { responses, responsesOnce } from '../../src/api/responses'
import { textCompletions, textCompletionsOnce } from '../../src/api/text-completions'
import { videoGeneration } from '../../src/api/video-generation'
import type { AssistantAttemptContract } from '../../src/core/api-choice'
import type { StreamLaneEvent } from '../../src/core/generation-stream-live-events'
import type { ConnectionProfile } from '../../src/core/types'
import { redactDiagnosticValue } from '../../src/lib/diagnostic-redaction'
import {
  anthropicRouteContract,
  chatRouteContract,
  geminiRouteContract,
  responsesRouteContract,
  textRouteContract,
} from '../helpers/reasoning-contracts'

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

function delayedShapeResponse(malformedData: string): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(': upstream still working\n\n'))
      queueMicrotask(() => {
        controller.enqueue(
          encoder.encode(
            [
              'event: response.output_text.delta',
              `data: ${malformedData}`,
              '',
              'event: response.completed',
              'data: {"type":"response.completed","response":{"status":"completed"}}',
              '',
              '',
            ].join('\n'),
          ),
        )
        controller.close()
      })
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
    routeContract: AssistantAttemptContract
    validFrames: ReadonlyArray<{ eventType?: string; data: string }>
    validLanes: StreamLaneEvent[]
    run: () => AsyncIterable<AssistantStreamChunk>
  }> = [
    {
      name: 'chat completions',
      adapter: 'chat-completions',
      malformedEventType: 'private-full-private-prompt',
      expectedEventType: 'unknown',
      routeContract: chatRouteContract(),
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
      routeContract: responsesRouteContract(),
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
        {
          lane: 'result-snapshot',
          payload: { kind: 'retain' },
          outcome: { kind: 'finish', finishReason: 'stop' },
        },
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
      routeContract: anthropicRouteContract(),
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
      routeContract: geminiRouteContract(),
      validFrames: [
        {
          data: '{"candidates":[{"content":{"role":"model","parts":[{"text":"ok"}]},"finishReason":"STOP"}]}',
        },
      ],
      validLanes: [
        { lane: 'text', text: 'ok', outputIndex: 0, contentIndex: 0 },
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
      routeContract: textRouteContract(),
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

      const lanes = await collectLanes(splitAssistantStream(adapter.run(), adapter.routeContract))

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
      expect(warn).not.toHaveBeenCalled()
      const serialized = JSON.stringify({ warnings: warn.mock.calls, lanes })
      expect(serialized).not.toContain(malformedData)
      expect(serialized).not.toContain('private-full-private-prompt')
      expect(serialized).not.toContain('frame-secret')
      expect(serialized).not.toContain('frame-key')
      expect(serialized).not.toContain('full private prompt')
      expect(serialized).not.toContain('request-secret')
    })
  }

  const malformedShapeCases = [
    {
      adapterName: 'chat completions',
      data: '{"choices":{},"authorization":"Bearer shape-secret"}',
      issue: 'choices-not-array',
    },
    {
      adapterName: 'Responses',
      data: '{"type":"response.output_text.delta","delta":null,"output_index":0,"content_index":0,"authorization":"Bearer shape-secret"}',
      issue: 'delta-not-string',
    },
    {
      adapterName: 'Responses',
      data: '{"type":"response.output_item.added","output_index":0,"authorization":"Bearer shape-secret"}',
      issue: 'output-item-invalid',
      eventType: 'response.output_item.added',
    },
    {
      adapterName: 'Anthropic Messages',
      data: '{"type":"content_block_delta","index":0,"authorization":"Bearer shape-secret"}',
      issue: 'content-delta-invalid',
    },
    {
      adapterName: 'Gemini native',
      data: '{"candidates":[{"content":{"parts":[null]}}],"authorization":"Bearer shape-secret"}',
      issue: 'part-invalid',
    },
    {
      adapterName: 'text completions',
      data: '{"choices":[null],"authorization":"Bearer shape-secret"}',
      issue: 'choice-not-object',
    },
    {
      adapterName: 'chat completions',
      data: '{"choices":[{"delta":{"content":"ignored"},"message":{"tool_calls":{}}}],"authorization":"Bearer shape-secret"}',
      issue: 'tool-calls-not-array',
    },
    {
      adapterName: 'Responses',
      data: '{"type":"response.output_item.done","output_index":0,"item":{"type":"message","content":{}},"authorization":"Bearer shape-secret"}',
      issue: 'output-item-invalid',
      eventType: 'response.output_item.done',
    },
    {
      adapterName: 'Anthropic Messages',
      data: '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":{}},"authorization":"Bearer shape-secret"}',
      issue: 'content-block-invalid',
      eventType: 'content_block_start',
    },
    {
      adapterName: 'Gemini native',
      data: '{"candidates":[{"content":{"parts":[{"functionCall":{"name":"tool","args":[]}}]}}],"authorization":"Bearer shape-secret"}',
      issue: 'part-invalid',
    },
    {
      adapterName: 'text completions',
      data: '{"choices":[{"text":{}}],"authorization":"Bearer shape-secret"}',
      issue: 'choice-text-not-string',
    },
  ] as const

  for (const malformed of malformedShapeCases) {
    it(`${malformed.adapterName} narrows ${malformed.issue} before lane transforms`, async () => {
      const adapter = cases.find((entry) => entry.name === malformed.adapterName)
      if (!adapter) throw new Error(`missing adapter fixture: ${malformed.adapterName}`)
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          sseResponse(
            malformed.data,
            'eventType' in malformed ? malformed.eventType : adapter.malformedEventType,
            adapter.validFrames,
          ),
        ),
      )
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const lanes = await collectLanes(splitAssistantStream(adapter.run(), adapter.routeContract))

      const expectedEventType =
        'eventType' in malformed ? malformed.eventType : adapter.expectedEventType
      expect(lanes[0]).toMatchObject({
        lane: 'integrity',
        integrity: {
          category: 'malformed-event-shape',
          adapter: adapter.adapter,
          eventType: expectedEventType,
          count: 1,
          characterCount: malformed.data.length,
        },
      })
      expect(lanes.slice(1)).toEqual(adapter.validLanes)
      expect(warn).not.toHaveBeenCalled()
      expect(JSON.stringify({ warnings: warn.mock.calls, lanes })).not.toContain('shape-secret')
    })
  }

  it('survives a delayed keepalive followed by a malformed first Responses content frame', async () => {
    const malformed =
      '{"type":"response.output_text.delta","delta":{"text":"wrong-shape"},"output_index":0,"content_index":0}'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => delayedShapeResponse(malformed)),
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const lanes = await collectLanes(
      splitAssistantStream(
        responses(
          {
            profile: profile('openai-compatible', 'https://example.test/v1'),
            apiKey: 'request-secret',
          },
          { model: 'model', input: 'input', stream: true },
        ),
        responsesRouteContract(),
      ),
    )

    expect(lanes).toHaveLength(3)
    expect(lanes[0]).toEqual({ lane: 'keepalive', comment: 'upstream still working' })
    expect(lanes[1]).toMatchObject({
      lane: 'integrity',
      integrity: {
        category: 'malformed-event-shape',
        adapter: 'responses',
        eventType: 'response.output_text.delta',
        count: 1,
        characterCount: malformed.length,
      },
    })
    const integrityLane = lanes[1]
    if (integrityLane?.lane !== 'integrity') throw new Error('expected stream integrity lane')
    expect(integrityLane.integrity.fingerprint).toMatch(/^fnv1a32:[0-9a-f]{8}$/u)
    expect(lanes[2]).toEqual({
      lane: 'result-snapshot',
      payload: { kind: 'retain' },
      outcome: { kind: 'finish', finishReason: 'stop' },
    })
    expect(warn).not.toHaveBeenCalled()
  })

  it('preserves terminal text-completion usage on the streaming path', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            'data: {"choices":[{"text":"ok","finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}\n\n',
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          ),
      ),
    )

    const lanes = await collectLanes(
      splitAssistantStream(
        textCompletions(
          {
            profile: profile('llama-server', 'https://example.test/v1'),
            apiKey: 'request-secret',
          },
          { model: 'model', prompt: 'input', stream: true },
        ),
        textRouteContract(),
      ),
    )

    expect(lanes).toEqual([
      { lane: 'text', text: 'ok' },
      { lane: 'finish', finishReason: 'stop' },
      {
        lane: 'usage',
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      },
    ])
  })

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
  const invalidNestedCases = [
    {
      adapterName: 'chat completions',
      body: '{"choices":[{"delta":{"content":"ignored"},"message":{"tool_calls":{}}}]}',
    },
    {
      adapterName: 'Responses',
      body: '{"status":"completed","output":[{"type":"message","content":{}}]}',
    },
    {
      adapterName: 'Anthropic Messages',
      body: '{"content":[{"type":"text","text":{}}]}',
    },
    {
      adapterName: 'Gemini native',
      body: '{"candidates":[{"content":{"parts":[{"functionCall":{"name":"tool","args":[]}}]}}]}',
    },
    {
      adapterName: 'text completions',
      body: '{"choices":[{"text":{}}]}',
    },
  ] as const

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

  for (const adapter of cases.filter((entry) => entry.runOnce !== undefined)) {
    it(`${adapter.name} rejects valid JSON with an invalid top-level buffered shape as a typed protocol error`, async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response('null', {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
        ),
      )

      const failures = [await captureFailure(adapter.runBuffered)]
      const runOnce = adapter.runOnce
      if (runOnce) failures.push(await captureFailure(async () => void (await runOnce())))

      for (const failure of failures) {
        expect(failure).toBeInstanceOf(ApiError)
        expect(failure).toMatchObject({
          kind: 'protocol',
          code: 'PROTOCOL',
          message: 'Provider response could not be decoded',
          midStream: false,
          retryable: false,
        })
      }
    })
  }

  for (const malformed of invalidNestedCases) {
    it(`${malformed.adapterName} rejects a malformed nested buffered shape before downstream access`, async () => {
      const adapter = cases.find((entry) => entry.name === malformed.adapterName)
      if (!adapter?.runOnce) throw new Error(`missing adapter fixture: ${malformed.adapterName}`)
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(malformed.body, {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
        ),
      )

      const failures = [
        await captureFailure(adapter.runBuffered),
        await captureFailure(async () => void (await adapter.runOnce?.())),
      ]
      for (const failure of failures) {
        expect(failure).toBeInstanceOf(ApiError)
        expect(failure).toMatchObject({
          kind: 'protocol',
          code: 'PROTOCOL',
          message: 'Provider response could not be decoded',
          midStream: false,
          retryable: false,
        })
        expect(failure).not.toBeInstanceOf(TypeError)
      }
    })
  }

  for (const adapter of cases.filter((entry) => entry.runOnce !== undefined)) {
    it(`${adapter.name} sanitizes primitive HTTP error metadata at the transport choke point`, async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response('{"error":{"code":403,"message":"blocked","metadata":"invalid"}}', {
              status: 403,
              headers: { 'content-type': 'application/json' },
            }),
        ),
      )

      const failure = await captureFailure(async () => void (await adapter.runOnce?.()))
      expect(failure).toBeInstanceOf(ApiError)
      expect(failure).toMatchObject({
        kind: 'unauthorized',
        code: 403,
        message: 'blocked',
        httpStatus: 403,
      })
      expect((failure as ApiError).metadata).toBeUndefined()
      expect(failure).not.toBeInstanceOf(TypeError)
    })
  }
})

describe('provider JSON boundary forward compatibility', () => {
  it('keeps unknown provider variants opaque while validating known variants', () => {
    expect(
      validateChatCompletionResult({
        choices: [{ message: { content: null, futureContent: { nested: true } } }],
      }),
    ).toMatchObject({ ok: true })
    expect(
      validateTextCompletionPayload({
        choices: [{ text: 'ok', futureChoice: { nested: true } }],
      }),
    ).toMatchObject({ ok: true })
    expect(
      validateResponsesResult({
        output: [{ type: 'future.output_item', content: { future: true } }],
      }),
    ).toMatchObject({ ok: true })
    expect(
      validateAnthropicResult({
        content: [{ type: 'future_content_block', text: { future: true } }],
        stop_reason: null,
      }),
    ).toMatchObject({ ok: true })
    expect(
      validateGeminiResponse({
        candidates: [{ content: { parts: [{ futurePart: { nested: true } }] } }],
      }),
    ).toMatchObject({ ok: true })
  })

  it('rejects null and non-finite indexes before they can become downstream indexes', () => {
    expect(
      validateChatCompletionResult({ choices: [{ index: null, message: { content: 'x' } }] }),
    ).toEqual({ ok: false, issue: 'choice-index-not-number' })
    expect(
      validateGeminiResponse({
        candidates: [{ index: Number.POSITIVE_INFINITY, content: { parts: [] } }],
      }),
    ).toEqual({ ok: false, issue: 'candidate-index-not-number' })
  })
})
