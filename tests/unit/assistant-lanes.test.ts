import { describe, expect, it } from 'vitest'
import type { AnthropicStreamChunk } from '../../src/api/anthropic-types'
import { splitAssistantStream } from '../../src/api/assistant-lanes'
import type { AssistantStreamChunk } from '../../src/api/assistant-stream'
import type { GeminiStreamChunk } from '../../src/api/gemini-types'
import {
  splitAnthropicStream,
  splitChatStream,
  splitGeminiStream,
  splitResponsesStream,
} from '../../src/api/stream-transforms'
import type { ChatStreamChunk, ResponsesStreamChunk } from '../../src/api/types'
import {
  type AssistantAttemptContract,
  sealAssistantAttemptContract,
} from '../../src/core/api-choice'
import type { StreamLaneEvent } from '../../src/core/generation-stream-live-events'
import {
  ANTHROPIC_PROVIDER_OUTPUT_CONTRACT,
  GOOGLE_PROVIDER_OUTPUT_CONTRACT,
  OPENAI_RESPONSES_PROVIDER_OUTPUT_CONTRACT,
} from '../../src/core/provider-tool-context'
import {
  anthropicReasoningContract,
  anthropicRouteContract,
  chatReasoningContract,
  chatRouteContract,
  geminiReasoningContract,
  geminiRouteContract,
  responsesReasoningContract,
  responsesRouteContract,
  textRouteContract,
  videoRouteContract,
} from '../helpers/reasoning-contracts'

type LaneTransport = 'openai-chat' | 'openai-responses' | 'gemini-native' | 'anthropic'

async function* fromChunks<T>(chunks: readonly T[]): AsyncGenerator<T> {
  for (const chunk of chunks) yield chunk
}

async function collect(source: AsyncIterable<StreamLaneEvent>): Promise<StreamLaneEvent[]> {
  const events: StreamLaneEvent[] = []
  for await (const event of source) events.push(event)
  return events
}

function splitDirectly(
  transport: LaneTransport,
  chunks: readonly AssistantStreamChunk[],
): AsyncIterable<StreamLaneEvent> {
  const source = fromChunks(chunks)
  if (transport === 'openai-responses') {
    return splitResponsesStream(
      source as AsyncIterable<ResponsesStreamChunk>,
      responsesReasoningContract(),
      OPENAI_RESPONSES_PROVIDER_OUTPUT_CONTRACT,
    )
  }
  if (transport === 'gemini-native') {
    return splitGeminiStream(
      source as AsyncIterable<GeminiStreamChunk>,
      geminiReasoningContract(),
      GOOGLE_PROVIDER_OUTPUT_CONTRACT,
    )
  }
  if (transport === 'anthropic') {
    return splitAnthropicStream(
      source as AsyncIterable<AnthropicStreamChunk>,
      anthropicReasoningContract(),
      ANTHROPIC_PROVIDER_OUTPUT_CONTRACT,
    )
  }
  return splitChatStream(source as AsyncIterable<ChatStreamChunk>, {
    reasoning: chatReasoningContract(),
  })
}

function routeForTransport(transport: LaneTransport): AssistantAttemptContract {
  if (transport === 'openai-responses') return responsesRouteContract()
  if (transport === 'gemini-native') return geminiRouteContract()
  if (transport === 'anthropic') return anthropicRouteContract()
  return chatRouteContract()
}

async function expectExactRouting(input: {
  transport: LaneTransport
  chunks: readonly AssistantStreamChunk[]
}): Promise<StreamLaneEvent[]> {
  const expected = await collect(splitDirectly(input.transport, input.chunks))
  const actual = await collect(
    splitAssistantStream(fromChunks(input.chunks), routeForTransport(input.transport)),
  )
  expect(actual).toEqual(expected)
  return actual
}

describe('splitAssistantStream', () => {
  it('replays the first chunk exactly once and continues the same iterator', async () => {
    let yielded = 0
    const source = (async function* (): AsyncGenerator<AssistantStreamChunk> {
      yielded += 1
      yield { type: 'delta', chunk: { choices: [{ delta: { content: 'first' } }] } }
      yielded += 1
      yield { type: 'delta', chunk: { choices: [{ delta: { content: 'second' } }] } }
    })()

    const events = await collect(splitAssistantStream(source, chatRouteContract()))

    expect(events).toEqual([
      { lane: 'text', text: 'first' },
      { lane: 'text', text: 'second' },
    ])
    expect(yielded).toBe(2)
  })

  it('preserves unexpected visible reasoning and reports one bounded contract mismatch', async () => {
    const base = chatRouteContract({
      carrier: 'openrouter-reasoning-details',
      originDialect: 'openrouter-chat',
      targetFormat: 'anthropic-claude-v1',
    })
    const contract = sealAssistantAttemptContract(base, {
      disclosure: 'absent',
      unexpectedVisibleKind: 'text',
      reason: 'request-display',
    })
    const events = await collect(
      splitAssistantStream(
        fromChunks<AssistantStreamChunk>([
          {
            type: 'delta',
            chunk: {
              choices: [
                {
                  index: 0,
                  delta: {
                    reasoning_details: [
                      {
                        type: 'reasoning.encrypted',
                        id: 'carrier-only',
                        format: 'anthropic-claude-v1',
                        data: 'opaque',
                      },
                    ],
                  },
                },
              ],
            },
          },
          { type: 'delta', chunk: { choices: [{ index: 0, delta: { reasoning: 'first' } }] } },
          { type: 'delta', chunk: { choices: [{ index: 0, delta: { reasoning: 'second' } }] } },
        ]),
        contract,
      ),
    )

    const mismatches = events.filter(
      (event) =>
        event.lane === 'integrity' && event.integrity.eventType === 'unexpected-visible-reasoning',
    )
    expect(mismatches).toEqual([
      {
        lane: 'integrity',
        integrity: {
          category: 'malformed-event-shape',
          adapter: 'chat-completions',
          eventType: 'unexpected-visible-reasoning',
          count: 1,
          fingerprint: 'visibility-contract:chat-completions:text',
          characterCount: 5,
        },
      },
    ])
    const reasoning = events
      .filter((event) => event.lane === 'reasoning-observation')
      .flatMap((event) => event.batch.observations)
    expect(reasoning.some((observation) => observation.kind === 'carrier')).toBe(true)
    expect(
      reasoning
        .filter((observation) => observation.kind === 'visible')
        .map((observation) => observation.value),
    ).toEqual(['first', 'second'])
  })

  const taggedCases: Array<{
    name: string
    transport: LaneTransport
    chunks: AssistantStreamChunk[]
  }> = [
    {
      name: 'chat',
      transport: 'openai-chat',
      chunks: [{ type: 'delta', chunk: { choices: [{ delta: { content: 'chat' } }] } }],
    },
    {
      name: 'Responses',
      transport: 'openai-responses',
      chunks: [
        {
          type: 'event',
          event: {
            type: 'response.output_text.delta',
            output_index: 0,
            content_index: 0,
            item_id: 'message-1',
            delta: 'responses',
          },
        },
      ],
    },
    {
      name: 'Gemini',
      transport: 'gemini-native',
      chunks: [
        {
          type: 'chunk',
          chunk: {
            candidates: [{ content: { role: 'model', parts: [{ text: 'gemini' }] } }],
          },
        },
      ],
    },
    {
      name: 'Anthropic',
      transport: 'anthropic',
      chunks: [
        {
          type: 'anthropic_event',
          event: {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: 'anthropic' },
          },
        },
      ],
    },
  ]

  for (const testCase of taggedCases) {
    it(`rejects a ${testCase.name} first chunk that contradicts the admitted route`, async () => {
      const contradictory =
        testCase.transport === 'openai-chat' ? responsesRouteContract() : chatRouteContract()
      await expect(
        collect(splitAssistantStream(fromChunks(testCase.chunks), contradictory)),
      ).rejects.toThrow('AssistantStreamTransportMismatch')
    })
  }

  const bufferedCases: Array<{
    name: string
    transport: LaneTransport
    result: Record<string, unknown>
  }> = [
    {
      name: 'chat',
      transport: 'openai-chat',
      result: {
        choices: [
          {
            finish_reason: 'stop',
            message: { content: 'buffered chat' },
          },
        ],
      },
    },
    {
      name: 'Responses',
      transport: 'openai-responses',
      result: {
        status: 'completed',
        output: [
          {
            type: 'message',
            id: 'message-1',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'buffered responses' }],
          },
        ],
      },
    },
    {
      name: 'Gemini',
      transport: 'gemini-native',
      result: {
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'buffered gemini' }] },
            finishReason: 'STOP',
          },
        ],
      },
    },
    {
      name: 'Anthropic',
      transport: 'anthropic',
      result: {
        content: [{ type: 'text', text: 'buffered anthropic' }],
        stop_reason: 'end_turn',
      },
    },
  ]

  for (const testCase of bufferedCases) {
    it(`routes a buffered ${testCase.name} result through its admitted route`, async () => {
      const chunks = [
        { type: 'buffered_result', result: testCase.result },
      ] as unknown as AssistantStreamChunk[]
      const events = await expectExactRouting({
        transport: testCase.transport,
        chunks,
      })
      expect(
        events.some(
          (event) =>
            event.lane === 'text' ||
            (event.lane === 'result-snapshot' &&
              event.payload.kind === 'replace' &&
              event.payload.textParts.some((part) => part.text.length > 0)),
        ),
      ).toBe(true)
    })
  }

  for (const testCase of taggedCases) {
    it(`uses the admitted ${testCase.name} route after an ambiguous keepalive`, async () => {
      const chunks: AssistantStreamChunk[] = [
        { type: 'keepalive', comment: 'processing' },
        ...testCase.chunks,
      ]
      const events = await expectExactRouting({
        transport: testCase.transport,
        chunks,
      })
      expect(events[0]).toEqual({ lane: 'keepalive', comment: 'processing' })
      expect(events.some((event) => event.lane === 'text')).toBe(true)
    })
  }

  for (const contract of [chatRouteContract(), textRouteContract(), videoRouteContract()]) {
    it(`uses ${contract.transport} for an ambiguous chat-shaped first chunk`, async () => {
      const chunks: AssistantStreamChunk[] = [
        { type: 'keepalive', comment: 'processing' },
        { type: 'delta', chunk: { choices: [{ delta: { content: 'chat fallback' } }] } },
      ]
      const expected = await collect(splitDirectly('openai-chat', chunks))
      await expect(collect(splitAssistantStream(fromChunks(chunks), contract))).resolves.toEqual(
        expected,
      )
    })
  }

  it('rejects a non-empty stream without an admitted route contract', async () => {
    await expect(
      collect(
        splitAssistantStream(
          fromChunks<AssistantStreamChunk>([{ type: 'keepalive', comment: 'processing' }]),
          null,
        ),
      ),
    ).rejects.toThrow('AssistantStreamContractMissing')
  })

  it('emits nothing for an empty source', async () => {
    let opened = 0
    const source: AsyncIterable<AssistantStreamChunk> = {
      [Symbol.asyncIterator]() {
        opened += 1
        return {
          async next(): Promise<IteratorResult<AssistantStreamChunk>> {
            return { done: true, value: undefined }
          },
        }
      },
    }

    await expect(collect(splitAssistantStream(source, anthropicRouteContract()))).resolves.toEqual(
      [],
    )
    expect(opened).toBe(1)
  })

  it('routes a terminal-only chat stream without requiring a content chunk', async () => {
    await expect(
      collect(
        splitAssistantStream(
          fromChunks<AssistantStreamChunk>([
            { type: 'transport_terminal', evidence: 'done-sentinel' },
          ]),
          chatRouteContract(),
        ),
      ),
    ).resolves.toEqual([{ lane: 'terminal', evidence: 'done-sentinel' }])
  })
})
