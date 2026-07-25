import { describe, expect, it } from 'vitest'
import type { AnthropicStreamChunk } from '../../src/api/anthropic-types'
import { splitAnthropicStream as splitAnthropicStreamWithContract } from '../../src/api/stream-transforms'
import type { StreamLaneEvent } from '../../src/core/generation-stream-live-events'
import { ANTHROPIC_PROVIDER_OUTPUT_CONTRACT } from '../../src/core/provider-tool-context'
import { anthropicReasoningContract } from '../helpers/reasoning-contracts'
import { collectReasoningObservations, foldStreamLaneEvents } from '../helpers/reasoning-events'

function splitAnthropicStream(source: Parameters<typeof splitAnthropicStreamWithContract>[0]) {
  return splitAnthropicStreamWithContract(
    source,
    anthropicReasoningContract(),
    ANTHROPIC_PROVIDER_OUTPUT_CONTRACT,
  )
}

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

    expect(foldStreamLaneEvents(toolCalls).final.toolCalls).toEqual([
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

    const operations = collectReasoningObservations(lanes)
    const visible = operations.filter((operation) => operation.kind === 'visible')
    const carriers = operations.filter((operation) => operation.kind === 'carrier')
    expect(visible).toHaveLength(1)
    expect(visible[0]).toMatchObject({
      kind: 'visible',
      value: 'signed thought',
      visibleKind: 'text',
      format: 'anthropic-claude-v1',
    })
    expect(visible[0]?.source).toMatchObject({ dialect: 'anthropic-messages', blockIndex: 0 })
    expect(carriers).toHaveLength(2)
    expect(carriers.every((operation) => operation.update === 'set')).toBe(true)
    expect(carriers.every((operation) => operation.value === 'sig_1')).toBe(true)
    expect(new Set(carriers.map((operation) => JSON.stringify(operation.memberAliases))).size).toBe(
      1,
    )
    expect(carriers[0]).toMatchObject({
      carrierKind: 'anthropic-signature',
      format: 'anthropic-claude-v1',
      binding: {
        visibleKind: 'text',
      },
    })
    expect(carriers[0]?.binding?.source).toMatchObject({
      dialect: 'anthropic-messages',
      blockIndex: 0,
    })
    const folded = foldStreamLaneEvents(lanes)
    const envelope = folded.final.reasoningEnvelope
    expect(envelope?.visible).toEqual([
      expect.objectContaining({ kind: 'text', text: 'signed thought' }),
    ])
    expect(envelope?.carriers).toEqual([
      expect.objectContaining({ kind: 'anthropic-signature', signature: 'sig_1' }),
    ])
    expect(
      folded.canonical.flatMap((event) =>
        event.lane === 'reasoning'
          ? event.mutations.filter((mutation) => mutation.kind === 'carrier-set')
          : [],
      ),
    ).toHaveLength(1)

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
    expect(folded.final.providerOutputItems?.map((item) => item.type)).toEqual([
      'server_tool_use',
      'web_search_tool_result',
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
    const operations = collectReasoningObservations(lanes)
    const visible = operations.filter((operation) => operation.kind === 'visible')
    const carriers = operations.filter((operation) => operation.kind === 'carrier')
    const emittedThinkingCharacters = visible.reduce(
      (total, operation) => total + operation.value.length,
      0,
    )
    expect(emittedThinkingCharacters).toBe(part.length * partCount)
    expect(new Set(visible.map((operation) => JSON.stringify(operation.memberAliases))).size).toBe(
      1,
    )
    const carrierAppends = carriers.filter((operation) => operation.update === 'append')
    const carrierSets = carriers.filter((operation) => operation.update === 'set')
    expect(carrierAppends.map((operation) => operation.value).join('')).toBe('signature-tail')
    expect(carrierSets.map((operation) => operation.value)).toEqual(['signature-tail'])
    expect(new Set(carriers.map((operation) => JSON.stringify(operation.memberAliases))).size).toBe(
      1,
    )

    const folded = foldStreamLaneEvents(lanes)
    const envelope = folded.final.reasoningEnvelope
    expect(envelope?.visible).toEqual([
      expect.objectContaining({
        kind: 'text',
        text: part.repeat(partCount),
        format: 'anthropic-claude-v1',
      }),
    ])
    expect(envelope?.carriers).toEqual([
      expect.objectContaining({
        kind: 'anthropic-signature',
        signature: 'signature-tail',
        bindsVisiblePartId: envelope?.visible[0]?.id,
      }),
    ])
    expect(
      folded.canonical.flatMap((event) =>
        event.lane === 'reasoning'
          ? event.mutations.filter((mutation) => mutation.kind === 'carrier-set')
          : [],
      ),
    ).toHaveLength(0)
  })

  it('keeps multiple thinking and redacted blocks as distinct visible members and carriers', async () => {
    const chunks: AnthropicStreamChunk[] = [
      {
        type: 'buffered_result',
        result: {
          id: 'msg_multi_thinking',
          stop_reason: 'end_turn',
          content: [
            { type: 'thinking', thinking: 'first thought', signature: 'sig-first' },
            { type: 'redacted_thinking', data: 'redacted-carrier' },
            { type: 'thinking', thinking: 'second thought', signature: 'sig-second' },
          ],
        },
      },
    ]
    const lanes = await collect(splitAnthropicStream(asAsync(chunks)))
    const envelope = foldStreamLaneEvents(lanes).final.reasoningEnvelope
    expect(envelope?.visible.map((part) => [part.source.blockIndex, part.text])).toEqual([
      [0, 'first thought'],
      [2, 'second thought'],
    ])
    expect(envelope?.carriers.map((carrier) => [carrier.source.blockIndex, carrier.kind])).toEqual([
      [0, 'anthropic-signature'],
      [1, 'anthropic-redacted'],
      [2, 'anthropic-signature'],
    ])
    expect(new Set(envelope?.visible.map((part) => part.id)).size).toBe(2)
    expect(new Set(envelope?.carriers.map((carrier) => carrier.id)).size).toBe(3)
  })

  it('projects equivalent streamed and buffered thinking into the same final envelope', async () => {
    const streamed: AnthropicStreamChunk[] = [
      {
        type: 'anthropic_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: '' },
        },
      },
      {
        type: 'anthropic_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'same thought' },
        },
      },
      {
        type: 'anthropic_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'signature_delta', signature: 'same-signature' },
        },
      },
      { type: 'anthropic_event', event: { type: 'content_block_stop', index: 0 } },
    ]
    const buffered: AnthropicStreamChunk[] = [
      {
        type: 'buffered_result',
        result: {
          id: 'msg_buffered_equivalent',
          content: [{ type: 'thinking', thinking: 'same thought', signature: 'same-signature' }],
        },
      },
    ]
    const streamedEnvelope = foldStreamLaneEvents(
      await collect(splitAnthropicStream(asAsync(streamed))),
    ).final.reasoningEnvelope
    const bufferedEnvelope = foldStreamLaneEvents(
      await collect(splitAnthropicStream(asAsync(buffered))),
    ).final.reasoningEnvelope
    expect(streamedEnvelope).toEqual(bufferedEnvelope)
  })
})
