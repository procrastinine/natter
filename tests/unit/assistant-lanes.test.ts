import { describe, expect, it } from 'vitest'
import type { AnthropicStreamChunk } from '../../src/api/anthropic-types'
import { splitAssistantStream } from '../../src/api/assistant-lanes'
import type { AssistantStreamChunk } from '../../src/api/assistant-stream'
import type { GeminiStreamChunk } from '../../src/api/gemini-types'
import {
  type StreamLaneEvent,
  splitAnthropicStream,
  splitChatStream,
  splitGeminiStream,
  splitResponsesStream,
} from '../../src/api/stream-transforms'
import type { ChatStreamChunk, ResponsesStreamChunk } from '../../src/api/types'
import type { ApiRoute } from '../../src/core/api-choice'

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
    return splitResponsesStream(source as AsyncIterable<ResponsesStreamChunk>)
  }
  if (transport === 'gemini-native') {
    return splitGeminiStream(source as AsyncIterable<GeminiStreamChunk>)
  }
  if (transport === 'anthropic') {
    return splitAnthropicStream(source as AsyncIterable<AnthropicStreamChunk>)
  }
  return splitChatStream(source as AsyncIterable<ChatStreamChunk>)
}

async function expectExactRouting(input: {
  transport: LaneTransport
  chunks: readonly AssistantStreamChunk[]
  hint?: ApiRoute['transport']
}): Promise<StreamLaneEvent[]> {
  const expected = await collect(splitDirectly(input.transport, input.chunks))
  const actual = await collect(splitAssistantStream(fromChunks(input.chunks), input.hint))
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

    const events = await collect(splitAssistantStream(source, 'openai-responses'))

    expect(events).toEqual([
      { lane: 'text', text: 'first' },
      { lane: 'text', text: 'second' },
    ])
    expect(yielded).toBe(2)
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
    it(`uses the ${testCase.name} first-chunk tag ahead of a contradictory hint`, async () => {
      const events = await expectExactRouting({
        transport: testCase.transport,
        chunks: testCase.chunks,
        hint: testCase.transport === 'openai-chat' ? 'openai-responses' : 'openai-chat',
      })
      expect(events.some((event) => event.lane === 'text')).toBe(true)
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
    it(`detects a buffered ${testCase.name} result ahead of a contradictory hint`, async () => {
      const chunks = [
        { type: 'buffered_result', result: testCase.result },
      ] as unknown as AssistantStreamChunk[]
      const events = await expectExactRouting({
        transport: testCase.transport,
        chunks,
        hint: testCase.transport === 'openai-chat' ? 'openai-responses' : 'openai-chat',
      })
      expect(events.some((event) => event.lane === 'text')).toBe(true)
    })
  }

  for (const testCase of taggedCases) {
    it(`uses the ${testCase.name} route hint after an ambiguous keepalive`, async () => {
      const chunks: AssistantStreamChunk[] = [
        { type: 'keepalive', comment: 'processing' },
        ...testCase.chunks,
      ]
      const hint: ApiRoute['transport'] =
        testCase.transport === 'openai-chat' ? 'openai-text' : testCase.transport
      const events = await expectExactRouting({
        transport: testCase.transport,
        chunks,
        hint,
      })
      expect(events[0]).toEqual({ lane: 'keepalive', comment: 'processing' })
      expect(events.some((event) => event.lane === 'text')).toBe(true)
    })
  }

  for (const hint of [undefined, 'openai-chat', 'openrouter-video'] as const) {
    it(`falls back to chat lanes for an ambiguous first chunk with ${hint ?? 'no'} hint`, async () => {
      const chunks: AssistantStreamChunk[] = [
        { type: 'keepalive', comment: 'processing' },
        { type: 'delta', chunk: { choices: [{ delta: { content: 'chat fallback' } }] } },
      ]
      await expectExactRouting({
        transport: 'openai-chat',
        chunks,
        ...(hint === undefined ? {} : { hint }),
      })
    })
  }

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

    await expect(collect(splitAssistantStream(source, 'anthropic'))).resolves.toEqual([])
    expect(opened).toBe(1)
  })

  it('routes a terminal-only chat stream without requiring a content chunk', async () => {
    await expect(
      collect(
        splitAssistantStream(
          fromChunks<AssistantStreamChunk>([
            { type: 'transport_terminal', evidence: 'done-sentinel' },
          ]),
        ),
      ),
    ).resolves.toEqual([{ lane: 'terminal', evidence: 'done-sentinel' }])
  })
})
