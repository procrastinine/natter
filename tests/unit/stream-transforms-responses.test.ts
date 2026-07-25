import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { splitResponsesStream as splitResponsesStreamWithContract } from '../../src/api/stream-transforms'
import type {
  ResponsesEventWire,
  ResponsesResultWire,
  ResponsesStreamChunk,
} from '../../src/api/types'
import type { StreamLaneEvent } from '../../src/core/generation-stream-live-events'
import { OPENAI_RESPONSES_PROVIDER_OUTPUT_CONTRACT } from '../../src/core/provider-tool-context'
import { responsesBufferedResult, responsesStreamSse } from '../helpers/protocol-fixtures'
import { responsesReasoningContract } from '../helpers/reasoning-contracts'
import { collectReasoningObservations, foldStreamLaneEvents } from '../helpers/reasoning-events'

function splitResponsesStream(source: Parameters<typeof splitResponsesStreamWithContract>[0]) {
  return splitResponsesStreamWithContract(
    source,
    responsesReasoningContract(),
    OPENAI_RESPONSES_PROVIDER_OUTPUT_CONTRACT,
  )
}

const PROBE5 = resolve(
  __dirname,
  '../../../plan/phase11-probes/05-openai-responses-stream-reasoning.sse',
)
const PROBE6 = resolve(
  __dirname,
  '../../../plan/phase11-probes/06-openrouter-responses-openai.json',
)

// Build a ResponsesStreamChunk iterable from a captured SSE file.
function* sseToChunks(sseBody: string): Iterable<ResponsesStreamChunk> {
  const blocks = sseBody.split(/\r?\n\r?\n/).filter((b) => b.trim().length > 0)
  for (const block of blocks) {
    const lines = block.split(/\r?\n/)
    const dataLines = lines
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
    if (dataLines.length === 0) continue
    const json = dataLines.join('\n')
    const parsed = JSON.parse(json) as ResponsesEventWire
    yield { type: 'event', event: parsed }
  }
}

async function* asAsync<T>(it: Iterable<T>): AsyncIterable<T> {
  for (const value of it) yield value
}

async function collect(source: AsyncIterable<StreamLaneEvent>): Promise<StreamLaneEvent[]> {
  const out: StreamLaneEvent[] = []
  for await (const ev of source) out.push(ev)
  return out
}

describe('splitResponsesStream — representative streaming fixture', () => {
  it('emits source-stable summary/carrier operations plus text, phase, and terminal state', async () => {
    const lanes = await collect(splitResponsesStream(asAsync(sseToChunks(responsesStreamSse))))

    // 1. First event should be meta with model + generationId.
    const firstMeta = lanes.find((l) => l.lane === 'meta')
    expect(firstMeta?.model).toMatch(/gpt-5\.4-nano/)
    expect(firstMeta?.generationId).toMatch(/^resp_/)

    // 2. output-item-added for the reasoning item.
    const reasoningItemAdded = lanes.find(
      (l) => l.lane === 'output-item-added' && l.item.type === 'reasoning',
    )
    expect(reasoningItemAdded).toBeDefined()

    const operations = collectReasoningObservations(lanes)
    const summaryDeltas = operations.filter(
      (operation) => operation.kind === 'visible' && operation.visibleKind === 'summary',
    )
    expect(summaryDeltas.length).toBeGreaterThan(1)
    expect(
      summaryDeltas.every((operation) => operation.source.dialect === 'openai-responses'),
    ).toBe(true)
    expect(summaryDeltas.every((operation) => typeof operation.source.itemId === 'string')).toBe(
      true,
    )
    expect(
      summaryDeltas.every((operation) => typeof operation.source.summaryIndex === 'number'),
    ).toBe(true)
    expect(new Set(summaryDeltas.map((operation) => operation.source.itemId)).size).toBe(1)
    expect(
      new Set(summaryDeltas.map((operation) => JSON.stringify(operation.memberAliases))).size,
    ).toBe(1)
    const joinedSummary = summaryDeltas.map((operation) => operation.value).join('')
    expect(joinedSummary).toMatch(/consecutive/i)

    // 4. At least one text delta for the assistant answer.
    const textDeltas = lanes.filter(
      (l): l is Extract<StreamLaneEvent, { lane: 'text' }> => l.lane === 'text',
    )
    expect(textDeltas.length).toBeGreaterThan(1)

    // 5. Phase event from the message output_item.done.
    const phaseEvents = lanes.filter(
      (l): l is Extract<StreamLaneEvent, { lane: 'phase' }> => l.lane === 'phase',
    )
    expect(phaseEvents.length).toBe(1)
    expect(phaseEvents[0]?.phase).toBe('final_answer')

    const terminal = lanes.filter(
      (event): event is Extract<StreamLaneEvent, { lane: 'result-snapshot' }> =>
        event.lane === 'result-snapshot',
    )
    expect(terminal).toHaveLength(1)
    expect(terminal[0]?.outcome).toEqual({ kind: 'finish', finishReason: 'stop' })

    const encryptedSets = operations.filter(
      (operation) =>
        operation.kind === 'carrier' && operation.carrierKind === 'responses-encrypted',
    )
    expect(encryptedSets).toHaveLength(2)
    expect(encryptedSets.every((operation) => operation.update === 'set')).toBe(true)
    expect(
      new Set(encryptedSets.map((operation) => JSON.stringify(operation.memberAliases))).size,
    ).toBe(1)
    expect(encryptedSets[0]?.value).toMatch(/^gAAA/)
    expect(encryptedSets[1]?.value).toMatch(/^gAAA/)
    expect(encryptedSets[0]?.value).not.toBe(encryptedSets[1]?.value)

    const finalEnvelope = foldStreamLaneEvents(lanes).final.reasoningEnvelope
    expect(finalEnvelope?.visible.map((part) => part.text).join('')).toMatch(/consecutive/i)
    expect(finalEnvelope?.carriers).toHaveLength(1)
    expect(finalEnvelope?.carriers[0]).toMatchObject({
      kind: 'responses-encrypted',
      data: encryptedSets[1]?.value,
    })
  })
})

describe('splitResponsesStream — representative buffered result', () => {
  it('synthesizes one authoritative envelope/text/tool/phase terminal snapshot', async () => {
    const buffered = responsesBufferedResult
    const chunks: ResponsesStreamChunk[] = [
      buffered.id
        ? { type: 'buffered_result', result: buffered, generationId: buffered.id }
        : { type: 'buffered_result', result: buffered },
    ]
    const lanes = await collect(splitResponsesStream(asAsync(chunks)))

    expect(lanes).toHaveLength(1)
    const snapshot = lanes[0]
    expect(snapshot?.lane).toBe('result-snapshot')
    if (snapshot?.lane !== 'result-snapshot' || snapshot.payload.kind !== 'replace') {
      throw new Error('ResponsesBufferedSnapshotMissing')
    }
    expect(snapshot.outcome).toEqual({ kind: 'finish', finishReason: 'stop' })
    expect(snapshot.generationId).toBe(buffered.id)
    expect(snapshot.usage).toBeDefined()
    expect(snapshot.payload.textParts.map((part) => part.text).join('')).toMatch(/44 and 46/)
    expect(snapshot.payload.phase).toBe('final_answer')
    const envelope = foldStreamLaneEvents(lanes).final.reasoningEnvelope
    expect(envelope?.visible[0]).toMatchObject({
      kind: 'summary',
      source: {
        dialect: 'openai-responses',
        itemId: buffered.output?.[0]?.id,
        outputIndex: 0,
        summaryIndex: 0,
      },
    })
    expect(envelope?.carriers[0]).toMatchObject({
      kind: 'responses-encrypted',
      source: {
        dialect: 'openai-responses',
        itemId: buffered.output?.[0]?.id,
        outputIndex: 0,
      },
    })
    expect(envelope).toBeDefined()
  })

  it('isolates equal member indices across multiple reasoning output items', async () => {
    const result: ResponsesResultWire = {
      id: 'resp_multi_reasoning',
      status: 'completed',
      output: [
        {
          id: 'rs_a',
          type: 'reasoning',
          encrypted_content: 'carrier-a',
          summary: [{ type: 'summary_text', text: 'summary a' }],
        },
        {
          id: 'rs_b',
          type: 'reasoning',
          encrypted_content: 'carrier-b',
          summary: [{ type: 'summary_text', text: 'summary b' }],
        },
      ],
    }
    const lanes = await collect(
      splitResponsesStream(asAsync([{ type: 'buffered_result', result }])),
    )
    const envelope = foldStreamLaneEvents(lanes).final.reasoningEnvelope
    expect(envelope?.visible.map((part) => [part.source.itemId, part.text])).toEqual([
      ['rs_a', 'summary a'],
      ['rs_b', 'summary b'],
    ])
    expect(
      envelope?.carriers.map((carrier) => [
        carrier.source.itemId,
        carrier.kind === 'anthropic-signature' ? carrier.signature : carrier.data,
      ]),
    ).toEqual([
      ['rs_a', 'carrier-a'],
      ['rs_b', 'carrier-b'],
    ])
    expect(new Set(envelope?.visible.map((part) => part.id)).size).toBe(2)
    expect(new Set(envelope?.carriers.map((carrier) => carrier.id)).size).toBe(2)
  })

  it('reconciles incremental events and buffered transport to the same terminal envelope', async () => {
    const item = {
      id: 'rs_equivalent',
      type: 'reasoning' as const,
      encrypted_content: 'final-carrier',
      summary: [{ type: 'summary_text', text: 'same summary' }],
    }
    const result: ResponsesResultWire = {
      id: 'resp_equivalent',
      status: 'completed',
      output: [item],
    }
    const streamed = await collect(
      splitResponsesStream(
        asAsync([
          {
            type: 'event',
            event: {
              type: 'response.output_item.added',
              output_index: 0,
              item: { ...item, encrypted_content: 'partial-carrier', summary: [] },
            },
          },
          {
            type: 'event',
            event: {
              type: 'response.reasoning_summary_text.delta',
              output_index: 0,
              item_id: item.id,
              summary_index: 0,
              delta: 'same summary',
            },
          },
          {
            type: 'event',
            event: { type: 'response.output_item.done', output_index: 0, item },
          },
          { type: 'event', event: { type: 'response.completed', response: result } },
        ]),
      ),
    )
    const buffered = await collect(
      splitResponsesStream(asAsync([{ type: 'buffered_result', result }])),
    )
    expect(foldStreamLaneEvents(streamed).final.reasoningEnvelope).toEqual(
      foldStreamLaneEvents(buffered).final.reasoningEnvelope,
    )
  })

  it('retains a streamed summary when the terminal response contains only encrypted reasoning', async () => {
    const lanes = await collect(
      splitResponsesStream(
        asAsync([
          {
            type: 'event',
            event: {
              type: 'response.reasoning_summary_text.delta',
              output_index: 0,
              item_id: 'reasoning-omission',
              summary_index: 0,
              delta: 'retained summary',
            },
          },
          {
            type: 'event',
            event: {
              type: 'response.completed',
              response: {
                id: 'response-omission',
                status: 'completed',
                output: [
                  {
                    id: 'reasoning-omission',
                    type: 'reasoning',
                    encrypted_content: 'terminal-carrier',
                  },
                ],
              },
            },
          },
        ]),
      ),
    )

    const envelope = foldStreamLaneEvents(lanes).final.reasoningEnvelope
    expect(envelope?.visible).toEqual([
      expect.objectContaining({ kind: 'summary', text: 'retained summary' }),
    ])
    expect(envelope?.carriers).toEqual([
      expect.objectContaining({ kind: 'responses-encrypted', data: 'terminal-carrier' }),
    ])
  })
})

if (existsSync(PROBE5)) {
  describe('splitResponsesStream — full local stream capture', () => {
    it('normalizes the complete capture without losing terminal state', async () => {
      const lanes = await collect(
        splitResponsesStream(asAsync(sseToChunks(readFileSync(PROBE5, 'utf8')))),
      )
      expect(collectReasoningObservations(lanes).length).toBeGreaterThan(0)
      expect(lanes.some((lane) => lane.lane === 'text')).toBe(true)
      expect(lanes.at(-1)?.lane).toBe('result-snapshot')
    })
  })
}

if (existsSync(PROBE6)) {
  describe('splitResponsesStream — full local buffered capture', () => {
    it('normalizes the complete capture without losing output items', async () => {
      const buffered = JSON.parse(readFileSync(PROBE6, 'utf8')) as ResponsesResultWire
      const chunk: ResponsesStreamChunk = buffered.id
        ? { type: 'buffered_result', result: buffered, generationId: buffered.id }
        : { type: 'buffered_result', result: buffered }
      const lanes = await collect(splitResponsesStream(asAsync([chunk])))
      expect(lanes).toHaveLength(1)
      const snapshot = lanes[0]
      expect(snapshot?.lane).toBe('result-snapshot')
      if (snapshot?.lane !== 'result-snapshot' || snapshot.payload.kind !== 'replace') {
        throw new Error('ResponsesBufferedSnapshotMissing')
      }
      expect(snapshot.payload.providerOutputItems.length).toBeGreaterThanOrEqual(0)
      expect(snapshot.outcome.kind).toBe('finish')
    })
  })
}

describe('splitResponsesStream — encrypted_content overwrite contract', () => {
  it('sets one stable carrier identity on add and authoritatively replaces it on done', async () => {
    // Synthetic minimal sequence: added → done (each with distinct encrypted_content).
    const events: ResponsesStreamChunk[] = [
      {
        type: 'event',
        event: {
          type: 'response.output_item.added',
          output_index: 0,
          item: { id: 'rs_1', type: 'reasoning', encrypted_content: 'partial' },
        },
      },
      {
        type: 'event',
        event: {
          type: 'response.output_item.done',
          output_index: 0,
          item: { id: 'rs_1', type: 'reasoning', encrypted_content: 'FINAL' },
        },
      },
      {
        type: 'event',
        event: {
          type: 'response.completed',
          response: { status: 'completed', id: 'resp_x' },
        },
      },
    ]
    const lanes = await collect(splitResponsesStream(asAsync(events)))
    const reasoning = collectReasoningObservations(lanes).filter(
      (operation) =>
        operation.kind === 'carrier' && operation.carrierKind === 'responses-encrypted',
    )
    expect(reasoning).toHaveLength(2)
    expect(reasoning.map((operation) => operation.update)).toEqual(['set', 'set'])
    expect(reasoning.map((operation) => operation.value)).toEqual(['partial', 'FINAL'])
    expect(
      new Set(reasoning.map((operation) => JSON.stringify(operation.memberAliases))).size,
    ).toBe(1)
    expect(foldStreamLaneEvents(lanes).final.reasoningEnvelope?.carriers).toEqual([
      expect.objectContaining({ kind: 'responses-encrypted', data: 'FINAL' }),
    ])
  })
})

describe('splitResponsesStream — function calls', () => {
  it('merges output-item metadata, argument deltas, and authoritative completion', async () => {
    const events: ResponsesStreamChunk[] = [
      {
        type: 'event',
        event: {
          type: 'response.output_item.added',
          output_index: 4,
          item: {
            id: 'fc_item_1',
            type: 'function_call',
            call_id: 'call_1',
            name: 'lookup',
            arguments: '',
          },
        },
      },
      {
        type: 'event',
        event: {
          type: 'response.function_call_arguments.delta',
          output_index: 4,
          item_id: 'fc_item_1',
          delta: '{"query":',
        },
      },
      {
        type: 'event',
        event: {
          type: 'response.function_call_arguments.delta',
          output_index: 4,
          item_id: 'fc_item_1',
          delta: '"natter"}',
        },
      },
      {
        type: 'event',
        event: {
          type: 'response.function_call_arguments.done',
          output_index: 4,
          item_id: 'fc_item_1',
          arguments: '{"query":"natter"}',
        },
      },
      {
        type: 'event',
        event: {
          type: 'response.output_item.done',
          output_index: 4,
          item: {
            id: 'fc_item_1',
            type: 'function_call',
            call_id: 'call_1',
            name: 'lookup',
            arguments: '{"query":"natter"}',
          },
        },
      },
    ]
    const lanes = await collect(splitResponsesStream(asAsync(events)))
    const toolCalls = lanes.filter(
      (lane): lane is Extract<StreamLaneEvent, { lane: 'tool-call' }> => lane.lane === 'tool-call',
    )
    const final = foldStreamLaneEvents(toolCalls).final

    expect(toolCalls[0]).toMatchObject({
      index: 4,
      id: 'call_1',
      type: 'function',
      name: 'lookup',
    })
    expect(toolCalls.filter((lane) => lane.argumentsDelta !== undefined)).toHaveLength(2)
    expect(toolCalls.filter((lane) => lane.argumentsSnapshot !== undefined)).toHaveLength(2)
    expect(final.toolCalls).toEqual([
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'lookup', arguments: '{"query":"natter"}' },
      },
    ])
  })

  it('normalizes buffered function_call items into canonical tool calls', async () => {
    const result: ResponsesResultWire = {
      id: 'resp_tools',
      status: 'completed',
      output: [
        {
          id: 'fc_item_2',
          type: 'function_call',
          call_id: 'call_2',
          name: 'calculate',
          arguments: '{"value":42}',
        },
      ],
    }
    const lanes = await collect(
      splitResponsesStream(
        asAsync([{ type: 'buffered_result', result, generationId: 'resp_tools' }]),
      ),
    )
    expect(foldStreamLaneEvents(lanes).final.toolCalls).toEqual([
      {
        id: 'call_2',
        type: 'function',
        function: { name: 'calculate', arguments: '{"value":42}' },
      },
    ])
  })
})

describe('splitResponsesStream — server tools', () => {
  it('emits server-tool lane events for web_search_call add / status / completed', async () => {
    const events: ResponsesStreamChunk[] = [
      {
        type: 'event',
        event: {
          type: 'response.output_item.added',
          output_index: 0,
          item: { id: 'ws_1', type: 'web_search_call' },
        },
      },
      {
        type: 'event',
        event: {
          type: 'response.web_search_call.searching',
          output_index: 0,
          item_id: 'ws_1',
        },
      },
      {
        type: 'event',
        event: {
          type: 'response.web_search_call.completed',
          output_index: 0,
          item_id: 'ws_1',
        },
      },
    ]
    const lanes = await collect(splitResponsesStream(asAsync(events)))
    const serverTool = lanes.filter(
      (l): l is Extract<StreamLaneEvent, { lane: 'server-tool' }> => l.lane === 'server-tool',
    )
    expect(serverTool).toHaveLength(3)
    expect(serverTool.map((s) => s.status)).toEqual(['in_progress', 'searching', 'completed'])
    expect(serverTool.every((s) => s.itemType === 'web_search_call')).toBe(true)
  })

  it('emits server-tool lane events for OpenRouter hosted output items', async () => {
    const events: ResponsesStreamChunk[] = [
      {
        type: 'event',
        event: {
          type: 'response.output_item.added',
          output_index: 0,
          item: { id: 'dt_1', type: 'openrouter:datetime', status: 'in_progress' },
        },
      },
      {
        type: 'event',
        event: {
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            id: 'dt_1',
            type: 'openrouter:datetime',
            status: 'completed',
            datetime: '2026-04-26T00:00:00.000Z',
            timezone: 'UTC',
          },
        },
      },
    ]
    const lanes = await collect(splitResponsesStream(asAsync(events)))
    const serverTool = lanes.filter(
      (l): l is Extract<StreamLaneEvent, { lane: 'server-tool' }> => l.lane === 'server-tool',
    )
    expect(serverTool).toEqual([
      {
        lane: 'server-tool',
        itemType: 'openrouter:datetime',
        status: 'in_progress',
        itemId: 'dt_1',
        outputIndex: 0,
      },
    ])
  })

  it('preserves shell call and output items from buffered Responses results', async () => {
    const result: ResponsesResultWire = {
      id: 'resp_shell',
      status: 'completed',
      output: [
        {
          id: 'sh_1',
          type: 'shell_call',
          status: 'completed',
          call_id: 'call_1',
          action: { type: 'exec', command: 'printf natter-shape-probe.' },
        },
        {
          id: 'sho_1',
          type: 'shell_call_output',
          call_id: 'call_1',
          output: [{ type: 'stdout', text: 'natter-shape-probe.' }],
        },
      ],
    }

    const lanes = await collect(
      splitResponsesStream(
        asAsync([{ type: 'buffered_result', result, generationId: 'resp_shell' }]),
      ),
    )
    const snapshot = lanes[0]
    expect(snapshot?.lane).toBe('result-snapshot')
    if (snapshot?.lane !== 'result-snapshot' || snapshot.payload.kind !== 'replace') {
      throw new Error('ResponsesBufferedSnapshotMissing')
    }
    expect(snapshot.payload.providerOutputItems.map((item) => item.type)).toEqual([
      'shell_call',
      'shell_call_output',
    ])
  })

  it('emits generated image output as a persistable content item', async () => {
    const imageUrl = 'data:image/png;base64,abc123'
    const events: ResponsesStreamChunk[] = [
      {
        type: 'event',
        event: {
          type: 'response.output_item.added',
          output_index: 0,
          item: { id: 'ig_1', type: 'image_generation_call', status: 'in_progress' },
        },
      },
      {
        type: 'event',
        event: {
          type: 'response.image_generation_call.completed',
          output_index: 0,
          item_id: 'ig_1',
        },
      },
      {
        type: 'event',
        event: {
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            id: 'ig_1',
            type: 'image_generation_call',
            status: 'completed',
            result: imageUrl,
          },
        },
      },
    ]
    const lanes = await collect(splitResponsesStream(asAsync(events)))
    const content = lanes.find(
      (l): l is Extract<StreamLaneEvent, { lane: 'content-item' }> => l.lane === 'content-item',
    )
    expect(content).toMatchObject({
      outputIndex: 0,
      itemId: 'ig_1',
      item: { type: 'output_image', url: imageUrl },
    })
  })

  it('wraps raw Responses image_generation_call base64 as a data URL', async () => {
    const events: ResponsesStreamChunk[] = [
      {
        type: 'event',
        event: {
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            id: 'ig_1',
            type: 'image_generation_call',
            status: 'completed',
            result: 'abc123',
          },
        },
      },
    ]
    const lanes = await collect(splitResponsesStream(asAsync(events)))
    const content = lanes.find(
      (l): l is Extract<StreamLaneEvent, { lane: 'content-item' }> => l.lane === 'content-item',
    )
    expect(content?.item).toEqual({ type: 'output_image', url: 'data:image/png;base64,abc123' })
  })
})

describe('splitResponsesStream — forward-compat', () => {
  it('silently drops unknown event types', async () => {
    const events: ResponsesStreamChunk[] = [
      {
        type: 'event',
        event: {
          type: 'response.future_feature.opened',
          random_field: 'value',
        } as ResponsesEventWire,
      },
      {
        type: 'event',
        event: { type: 'response.completed', response: { status: 'completed' } },
      },
    ]
    const lanes = await collect(splitResponsesStream(asAsync(events)))
    expect(
      lanes.some((event) => event.lane === 'result-snapshot' && event.outcome.kind === 'finish'),
    ).toBe(true)
  })
})

describe('splitResponsesStream — error event', () => {
  it('maps response.failed into an authoritative error outcome', async () => {
    const events: ResponsesStreamChunk[] = [
      {
        type: 'event',
        event: {
          type: 'response.failed',
          response: {
            status: 'failed',
            error: { code: 400, message: 'unsupported_value' },
          },
        },
      },
    ]
    const lanes = await collect(splitResponsesStream(asAsync(events)))
    const snapshot = lanes.find(
      (event): event is Extract<StreamLaneEvent, { lane: 'result-snapshot' }> =>
        event.lane === 'result-snapshot',
    )
    expect(snapshot?.outcome.kind).toBe('error')
  })
})
