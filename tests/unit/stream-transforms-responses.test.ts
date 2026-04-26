// Phase 11: `splitResponsesStream` — normalize `ResponsesEventWire` → lane
// events. Fixture-driven using probe 5 + probe 6 captures.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { splitResponsesStream, type StreamLaneEvent } from '../../src/api/stream-transforms'
import type {
  ResponsesEventWire,
  ResponsesResultWire,
  ResponsesStreamChunk,
} from '../../src/api/types'

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

describe('splitResponsesStream — streaming fixture (probe 5)', () => {
  it('emits reasoning (summaryDelta) + text deltas + phase + finish in order', async () => {
    const body = readFileSync(PROBE5, 'utf8')
    const lanes = await collect(splitResponsesStream(asAsync(sseToChunks(body))))

    // 1. First event should be meta with model + generationId.
    const firstMeta = lanes.find((l) => l.lane === 'meta') as
      | Extract<StreamLaneEvent, { lane: 'meta' }>
      | undefined
    expect(firstMeta?.model).toMatch(/gpt-5\.4-nano/)
    expect(firstMeta?.generationId).toMatch(/^resp_/)

    // 2. output-item-added for the reasoning item.
    const reasoningItemAdded = lanes.find(
      (l) => l.lane === 'output-item-added' && l.item.type === 'reasoning',
    )
    expect(reasoningItemAdded).toBeDefined()

    // 3. At least one reasoning summary delta.
    const summaryDeltas = lanes.filter(
      (l): l is Extract<StreamLaneEvent, { lane: 'reasoning' }> =>
        l.lane === 'reasoning' && l.summaryDelta !== undefined,
    )
    expect(summaryDeltas.length).toBeGreaterThan(1)
    expect(summaryDeltas.every((l) => typeof l.itemId === 'string')).toBe(true)
    expect(summaryDeltas.every((l) => typeof l.summaryIndex === 'number')).toBe(true)
    expect(new Set(summaryDeltas.map((l) => l.itemId)).size).toBe(1)
    const joinedSummary = summaryDeltas.map((l) => l.summaryDelta ?? '').join('')
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

    // 6. Terminal finish event.
    const finish = lanes.filter(
      (l): l is Extract<StreamLaneEvent, { lane: 'finish' }> => l.lane === 'finish',
    )
    expect(finish).toHaveLength(1)
    expect(finish[0]?.finishReason).toBe('stop')

    // 7. Last-encrypted-wins: the two reasoning `replaceEncrypted` events are
    //    the INITIAL value (from output_item.added) and the FINAL value
    //    (from output_item.done). They should differ because encrypted_content
    //    grows — see probe 5.
    const encryptedReplaces = lanes.filter(
      (l): l is Extract<StreamLaneEvent, { lane: 'reasoning' }> =>
        l.lane === 'reasoning' && l.replaceEncrypted === true,
    )
    expect(encryptedReplaces.length).toBe(2)
    const [initial, final] = encryptedReplaces
    expect(initial?.encryptedDelta).toBeDefined()
    expect(final?.encryptedDelta).toBeDefined()
    expect(initial?.encryptedDelta).not.toBe(final?.encryptedDelta)
    // Both blobs start with the OpenAI `gAAA` prefix.
    expect(initial?.encryptedDelta).toMatch(/^gAAA/)
    expect(final?.encryptedDelta).toMatch(/^gAAA/)
  })
})

describe('splitResponsesStream — buffered result (probe 6)', () => {
  it('synthesizes output-item + reasoning + text + phase + usage + finish from buffered JSON', async () => {
    const buffered = JSON.parse(readFileSync(PROBE6, 'utf8')) as ResponsesResultWire
    const chunks: ResponsesStreamChunk[] = [
      buffered.id
        ? { type: 'buffered_result', result: buffered, generationId: buffered.id }
        : { type: 'buffered_result', result: buffered },
    ]
    const lanes = await collect(splitResponsesStream(asAsync(chunks)))

    const laneNames = lanes.map((l) => l.lane)
    // Meta + buffered first.
    expect(laneNames[0]).toBe('meta')
    expect(laneNames[1]).toBe('buffered')

    // One output-item-added per item in result.output.
    const adds = lanes.filter((l) => l.lane === 'output-item-added')
    expect(adds).toHaveLength(2)
    expect(
      (adds[0] as Extract<StreamLaneEvent, { lane: 'output-item-added' }>).item.type,
    ).toBe('reasoning')
    expect(
      (adds[1] as Extract<StreamLaneEvent, { lane: 'output-item-added' }>).item.type,
    ).toBe('message')

    // Reasoning lane carries encrypted + summary.
    const reasoning = lanes.filter(
      (l): l is Extract<StreamLaneEvent, { lane: 'reasoning' }> => l.lane === 'reasoning',
    )
    expect(reasoning.some((r) => r.encryptedDelta?.startsWith('gAAA'))).toBe(true)
    expect(reasoning.some((r) => typeof r.summaryDelta === 'string')).toBe(true)
    const bufferedSummary = reasoning.find((r) => typeof r.summaryDelta === 'string')
    expect(bufferedSummary?.itemId).toBe(buffered.output?.[0]?.id)
    expect(bufferedSummary?.summaryIndex).toBe(0)

    // Text lane emits the message content once.
    const text = lanes.filter((l) => l.lane === 'text')
    expect(text).toHaveLength(1)
    expect((text[0] as Extract<StreamLaneEvent, { lane: 'text' }>).text).toMatch(/44 and 46/)

    // Phase event for the message item.
    const phases = lanes.filter((l) => l.lane === 'phase')
    expect(phases).toHaveLength(1)
    expect((phases[0] as Extract<StreamLaneEvent, { lane: 'phase' }>).phase).toBe('final_answer')

    // Finish + usage.
    expect(lanes.some((l) => l.lane === 'finish')).toBe(true)
    expect(lanes.some((l) => l.lane === 'usage')).toBe(true)
  })
})

describe('splitResponsesStream — encrypted_content overwrite contract', () => {
  it('emits replaceEncrypted:true on both output_item.added and output_item.done', async () => {
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
    const reasoning = lanes.filter(
      (l): l is Extract<StreamLaneEvent, { lane: 'reasoning' }> => l.lane === 'reasoning',
    )
    expect(reasoning).toHaveLength(2)
    expect(reasoning[0]).toMatchObject({ encryptedDelta: 'partial', replaceEncrypted: true })
    expect(reasoning[1]).toMatchObject({ encryptedDelta: 'FINAL', replaceEncrypted: true })
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
      (l): l is Extract<StreamLaneEvent, { lane: 'content-item' }> =>
        l.lane === 'content-item',
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
      (l): l is Extract<StreamLaneEvent, { lane: 'content-item' }> =>
        l.lane === 'content-item',
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
    expect(lanes.some((l) => l.lane === 'finish')).toBe(true)
  })
})

describe('splitResponsesStream — error event', () => {
  it('maps response.failed into an error lane event', async () => {
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
    expect(lanes.some((l) => l.lane === 'error')).toBe(true)
  })
})
