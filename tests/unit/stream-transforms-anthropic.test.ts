import { describe, expect, it } from 'vitest'
import type { AnthropicStreamChunk } from '../../src/api/anthropic-types'
import { type StreamLaneEvent, splitAnthropicStream } from '../../src/api/stream-transforms'
import {
  applyStreamAccumulatorEvent,
  createStreamAccumulator,
  projectStreamAccumulatorFinal,
} from '../../src/core/stream-accumulator'

async function* asAsync<T>(items: Iterable<T>): AsyncIterable<T> {
  for (const item of items) yield item
}

async function collect(source: AsyncIterable<StreamLaneEvent>): Promise<StreamLaneEvent[]> {
  const out: StreamLaneEvent[] = []
  for await (const event of source) out.push(event)
  return out
}

describe('splitAnthropicStream', () => {
  it('normalizes Messages SSE text, usage, and finish lanes', async () => {
    const chunks: AnthropicStreamChunk[] = [
      {
        type: 'anthropic_event',
        generationId: 'req_1',
        event: {
          type: 'message_start',
          message: {
            id: 'msg_1',
            model: 'claude-haiku-4-5',
            usage: { input_tokens: 12 },
          },
        },
      },
      {
        type: 'anthropic_event',
        generationId: 'req_1',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        },
      },
      {
        type: 'anthropic_event',
        generationId: 'req_1',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'hello' },
        },
      },
      {
        type: 'anthropic_event',
        generationId: 'req_1',
        event: {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 3 },
        },
      },
      { type: 'anthropic_event', generationId: 'req_1', event: { type: 'message_stop' } },
    ]
    const lanes = await collect(splitAnthropicStream(asAsync(chunks)))

    expect(lanes.filter((lane) => lane.lane === 'meta')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ lane: 'meta', generationId: 'req_1' }),
        expect.objectContaining({ lane: 'meta', model: 'claude-haiku-4-5' }),
      ]),
    )
    expect(lanes.filter((lane) => lane.lane === 'text')).toEqual([
      { lane: 'text', text: 'hello', outputIndex: 0, contentIndex: 0 },
    ])
    expect(lanes.some((lane) => lane.lane === 'usage')).toBe(true)
    expect(lanes.filter((lane) => lane.lane === 'finish')).toEqual([
      { lane: 'finish', finishReason: 'stop' },
    ])
  })

  it('preserves ordinary tool_use metadata, streamed JSON, and the authoritative snapshot', async () => {
    const chunks: AnthropicStreamChunk[] = [
      {
        type: 'anthropic_event',
        event: {
          type: 'content_block_start',
          index: 2,
          content_block: { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: {} },
        },
      },
      {
        type: 'anthropic_event',
        event: {
          type: 'content_block_delta',
          index: 2,
          delta: { type: 'input_json_delta', partial_json: '{"query":' },
        },
      },
      {
        type: 'anthropic_event',
        event: {
          type: 'content_block_delta',
          index: 2,
          delta: { type: 'input_json_delta', partial_json: '"natter"}' },
        },
      },
      {
        type: 'anthropic_event',
        event: { type: 'content_block_stop', index: 2 },
      },
    ]
    const lanes = await collect(splitAnthropicStream(asAsync(chunks)))
    const toolCalls = lanes.filter(
      (lane): lane is Extract<StreamLaneEvent, { lane: 'tool-call' }> => lane.lane === 'tool-call',
    )
    expect(toolCalls).toEqual([
      {
        lane: 'tool-call',
        index: 2,
        id: 'toolu_1',
        type: 'function',
        name: 'lookup',
        outputIndex: 2,
      },
      {
        lane: 'tool-call',
        index: 2,
        type: 'function',
        argumentsDelta: '{"query":',
        outputIndex: 2,
      },
      {
        lane: 'tool-call',
        index: 2,
        type: 'function',
        argumentsDelta: '"natter"}',
        outputIndex: 2,
      },
      {
        lane: 'tool-call',
        index: 2,
        id: 'toolu_1',
        type: 'function',
        name: 'lookup',
        argumentsSnapshot: '{"query":"natter"}',
        outputIndex: 2,
      },
    ])

    const accumulator = createStreamAccumulator({ initialContent: [], now: 0 })
    for (const [index, lane] of toolCalls.entries()) {
      applyStreamAccumulatorEvent(accumulator, lane, index + 1)
    }
    expect(projectStreamAccumulatorFinal(accumulator).toolCalls).toEqual([
      {
        id: 'toolu_1',
        type: 'function',
        function: { name: 'lookup', arguments: '{"query":"natter"}' },
      },
    ])
  })

  it('preserves Claude thinking details and server-tool output blocks', async () => {
    const chunks: AnthropicStreamChunk[] = [
      {
        type: 'buffered_result',
        generationId: 'req_2',
        result: {
          id: 'msg_2',
          model: 'claude-haiku-4-5',
          stop_reason: 'end_turn',
          content: [
            { type: 'thinking', thinking: 'signed thought', signature: 'sig_1' },
            {
              type: 'server_tool_use',
              id: 'srvtoolu_1',
              name: 'web_search',
              input: { query: 'natter' },
            },
            {
              type: 'web_search_tool_result',
              tool_use_id: 'srvtoolu_1',
              content: [{ type: 'text', text: 'result text' }],
            },
            { type: 'text', text: 'final' },
          ],
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            server_tool_use: { web_search_requests: 1 },
          },
        },
      },
    ]
    const lanes = await collect(splitAnthropicStream(asAsync(chunks)))

    const reasoning = lanes.filter(
      (lane): lane is Extract<StreamLaneEvent, { lane: 'reasoning' }> => lane.lane === 'reasoning',
    )
    expect(reasoning.some((lane) => lane.textDelta === 'signed thought')).toBe(true)
    expect(
      reasoning.some((lane) =>
        lane.details?.some(
          (detail) =>
            Boolean(detail) &&
            typeof detail === 'object' &&
            (detail as { format?: unknown }).format === 'anthropic-claude-v1',
        ),
      ),
    ).toBe(true)

    const serverToolOutputs = lanes.filter((lane) => lane.lane === 'server-tool-output')
    expect(serverToolOutputs).toEqual([
      expect.objectContaining({
        lane: 'server-tool-output',
        itemType: 'server_tool_use',
        itemId: 'srvtoolu_1',
      }),
      expect.objectContaining({
        lane: 'server-tool-output',
        itemType: 'web_search_tool_result',
        itemId: 'srvtoolu_1',
      }),
    ])
    expect(lanes.some((lane) => lane.lane === 'text' && lane.text === 'final')).toBe(true)
  })

  it('streams 100k Claude thinking once and attaches signature metadata without replay', async () => {
    const part = 'reasoning-'.repeat(10)
    const partCount = 1_000
    const chunks: AnthropicStreamChunk[] = [
      {
        type: 'anthropic_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: '' },
        },
      },
      ...Array.from({ length: partCount }, () => ({
        type: 'anthropic_event' as const,
        event: {
          type: 'content_block_delta' as const,
          index: 0,
          delta: { type: 'thinking_delta', thinking: part },
        },
      })),
      {
        type: 'anthropic_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'signature_delta', signature: 'signature-' },
        },
      },
      {
        type: 'anthropic_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'signature_delta', signature: 'tail' },
        },
      },
      {
        type: 'anthropic_event',
        event: { type: 'content_block_stop', index: 0 },
      },
    ]
    const lanes = await collect(splitAnthropicStream(asAsync(chunks)))
    const reasoning = lanes.filter(
      (lane): lane is Extract<StreamLaneEvent, { lane: 'reasoning' }> => lane.lane === 'reasoning',
    )
    const emittedThinkingCharacters = reasoning.reduce(
      (total, lane) => total + (lane.textDelta?.length ?? 0),
      0,
    )
    expect(emittedThinkingCharacters).toBe(part.length * partCount)
    expect(reasoning.at(-1)?.details).toEqual([
      {
        type: 'reasoning.text',
        id: 'text#anthropic-reasoning-0',
        index: 0,
        format: 'anthropic-claude-v1',
        signature: 'signature-tail',
      },
    ])

    const accumulator = createStreamAccumulator({ initialContent: [], now: 0 })
    for (const [index, lane] of reasoning.entries()) {
      applyStreamAccumulatorEvent(accumulator, lane, index + 1)
    }
    expect(projectStreamAccumulatorFinal(accumulator).reasoningDetails).toEqual([
      {
        type: 'reasoning.text',
        id: 'text#anthropic-reasoning-0',
        index: 0,
        format: 'anthropic-claude-v1',
        text: part.repeat(partCount),
        signature: 'signature-tail',
      },
    ])
  })
})
