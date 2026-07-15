import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../src/api/errors'
import type { StreamLaneEvent } from '../../src/api/stream-transforms'
import {
  applyStreamAccumulatorEvent,
  createStreamAccumulator,
  projectStreamAccumulatorFinal,
  replayStreamAccumulator,
} from '../../src/core/stream-accumulator'
import type { StreamChunkRow } from '../../src/store/repository'
import {
  createStreamChunkWriter,
  type StreamChunkAppendPort,
} from '../../src/store/stream-chunk-writer'

afterEach(() => {
  vi.useRealTimers()
})

describe('stream chunk writer', () => {
  it('serializes recoverable lanes, deduplicates metadata, and assigns contiguous rows', async () => {
    const batches: StreamChunkRow[][] = []
    const appendStreamChunks = vi.fn(async (rows: readonly StreamChunkRow[]) => {
      batches.push(structuredClone([...rows]))
    })
    const writer = createWriter({ appendStreamChunks }, 100)
    const hostedItem = {
      lane: 'output-item-added',
      outputIndex: 2,
      item: { type: 'web_search_call', id: 'tool-1', status: 'in_progress' },
    } satisfies StreamLaneEvent
    const textEvent = { lane: 'text', text: 'first' } satisfies StreamLaneEvent

    writer.append(
      { lane: 'meta', generationId: 'generation-1', model: 'model-1', provider: 'provider-1' },
      101,
    )
    writer.append(
      { lane: 'meta', generationId: 'generation-1', model: 'model-1', provider: 'provider-1' },
      102,
    )
    writer.append(
      { lane: 'meta', generationId: 'generation-2', model: 'model-2', provider: 'provider-1' },
      103,
    )
    writer.append(
      {
        lane: 'output-item-done',
        outputIndex: 0,
        item: { type: 'message', id: 'message-1' },
      },
      104,
    )
    writer.append(hostedItem, 105)
    hostedItem.item.status = 'completed'
    writer.append({ lane: 'tool-call', index: 0, argumentsDelta: '{}' }, 106)
    writer.append({ lane: 'keepalive', comment: 'still here' }, 107)
    writer.append({ lane: 'phase', phase: 'commentary', outputIndex: 2 }, 108)
    writer.append(textEvent, 109)
    textEvent.text = 'mutated after append'
    writer.append(
      {
        lane: 'error',
        error: new ApiError({
          kind: 'rate_limited',
          code: 429,
          message: 'slow down',
          metadata: { authorization: 'Bearer must-not-persist', raw: { secret: 'hidden' } },
          midStream: true,
          retryable: true,
        }),
      },
      110,
    )

    await writer.flush()

    expect(appendStreamChunks).toHaveBeenCalledTimes(1)
    expect(batches).toHaveLength(1)
    const rows = batches[0] ?? []
    expect(rows).toHaveLength(7)
    expect(rows.map((row) => row.seq)).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(rows.map((row) => row.id)).toEqual([
      'stream-1:0',
      'stream-1:1',
      'stream-1:2',
      'stream-1:3',
      'stream-1:4',
      'stream-1:5',
      'stream-1:6',
    ])
    expect(rows.map((row) => row.createdAt)).toEqual([101, 103, 105, 106, 108, 109, 110])
    expect(rows.map((row) => row.event)).toEqual([
      {
        lane: 'meta',
        generationId: 'generation-1',
        model: 'model-1',
        provider: 'provider-1',
      },
      { lane: 'meta', model: 'model-2' },
      {
        lane: 'output-item-added',
        outputIndex: 2,
        item: { type: 'web_search_call', id: 'tool-1', status: 'in_progress' },
      },
      { lane: 'tool-call', index: 0, argumentsDelta: '{}' },
      { lane: 'phase', phase: 'commentary', outputIndex: 2 },
      { lane: 'text', text: 'first' },
      {
        lane: 'error',
        error: {
          kind: 'rate_limited',
          code: '429',
          message: 'slow down',
          midStream: true,
          retryable: true,
        },
      },
    ])
  })

  it('persists only bounded allowlisted stream error fields', async () => {
    const batches: StreamChunkRow[][] = []
    const writer = createWriter(
      {
        appendStreamChunks: async (rows) => {
          batches.push(structuredClone([...rows]))
        },
      },
      100,
    )
    writer.append(
      {
        lane: 'error',
        error: new ApiError({
          kind: 'provider_error',
          httpStatus: 502,
          code: 'UPSTREAM',
          message: 'x'.repeat(600),
          metadata: { apiKey: 'must-not-persist', raw: 'must-not-persist' },
          midStream: true,
          retryable: true,
        }),
      },
      101,
    )

    await writer.settle()

    const persisted = batches[0]?.[0]?.event as { error?: Record<string, unknown> }
    expect(persisted.error).toEqual({
      kind: 'provider_error',
      code: 'UPSTREAM',
      message: 'x'.repeat(240),
      httpStatus: 502,
      midStream: true,
      retryable: true,
    })
    expect(Object.keys(persisted.error ?? {})).toEqual([
      'kind',
      'code',
      'message',
      'httpStatus',
      'midStream',
      'retryable',
    ])
  })

  it('persists only the sanitized integrity event', async () => {
    const batches: StreamChunkRow[][] = []
    const writer = createWriter(
      {
        appendStreamChunks: async (rows) => {
          batches.push(structuredClone([...rows]))
        },
      },
      100,
    )
    writer.append(
      {
        lane: 'integrity',
        integrity: {
          category: 'malformed-json-frame',
          adapter: 'responses',
          eventType: 'response.output_text.delta',
          count: 1,
          fingerprint: 'fnv1a32:12345678',
          characterCount: 4096,
        },
      },
      101,
    )

    await writer.settle()

    expect(batches[0]?.[0]?.event).toEqual({
      lane: 'integrity',
      integrity: {
        category: 'malformed-json-frame',
        adapter: 'responses',
        eventType: 'response.output_text.delta',
        count: 1,
        fingerprint: 'fnv1a32:12345678',
        characterCount: 4096,
      },
    })
    expect(JSON.stringify(batches)).not.toMatch(/data|headers|apiKey|prompt|raw/u)
  })

  it('uses the 150 ms trailing flush schedule and settlement drains buffered rows', async () => {
    vi.useFakeTimers()
    const appendStreamChunks = vi.fn(async (_rows: readonly StreamChunkRow[]) => {})
    const writer = createWriter({ appendStreamChunks }, 1_000)

    writer.append({ lane: 'text', text: 'delayed' }, 1_001)
    writer.flush({ mode: 'scheduled', now: 1_001 })
    await vi.advanceTimersByTimeAsync(148)
    expect(appendStreamChunks).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await writer.settle()
    expect(appendStreamChunks).toHaveBeenCalledTimes(1)

    writer.append({ lane: 'text', text: 'buffered' }, 1_100)
    writer.flush({ mode: 'scheduled', now: 1_100 })
    await writer.settle()
    expect(appendStreamChunks).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(appendStreamChunks).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['text', { lane: 'text', text: 'x'.repeat(128 * 1024) } satisfies StreamLaneEvent],
    [
      'reasoning fragments',
      {
        lane: 'reasoning',
        textDelta: 'x'.repeat(64 * 1024),
        summaryDelta: 'y'.repeat(32 * 1024),
        encryptedDelta: 'z'.repeat(32 * 1024),
      } satisfies StreamLaneEvent,
    ],
    [
      'audio fragments',
      {
        lane: 'audio-output',
        dataDelta: 'x'.repeat(96 * 1024),
        transcriptDelta: 'y'.repeat(32 * 1024),
      } satisfies StreamLaneEvent,
    ],
  ])('flushes immediately at the text budget for %s', async (_name, event) => {
    vi.useFakeTimers()
    const appendStreamChunks = vi.fn(async (_rows: readonly StreamChunkRow[]) => {})
    const writer = createWriter({ appendStreamChunks }, 500)

    writer.append(event, 501)
    writer.flush({ mode: 'scheduled', now: 501 })
    await writer.settle()

    expect(appendStreamChunks).toHaveBeenCalledTimes(1)
  })

  it('flushes immediately at 256 logical rows after coalescing them', async () => {
    vi.useFakeTimers()
    const appendStreamChunks = vi.fn(async (_rows: readonly StreamChunkRow[]) => {})
    const writer = createWriter({ appendStreamChunks }, 2_000)

    for (let index = 0; index < 255; index += 1) {
      writer.append({ lane: 'text', text: '' }, 2_001)
    }
    writer.flush({ mode: 'scheduled', now: 2_001 })
    expect(appendStreamChunks).not.toHaveBeenCalled()

    writer.append({ lane: 'text', text: '' }, 2_002)
    writer.flush({ mode: 'scheduled', now: 2_002 })
    await writer.settle()

    expect(appendStreamChunks).toHaveBeenCalledTimes(1)
    expect(appendStreamChunks.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ seq: 0, event: { lane: 'text', text: '' } }),
    ])
  })

  it('replays coalesced exact append lanes identically, including reasoning timing', async () => {
    const trace: Array<{ event: StreamLaneEvent; createdAt: number }> = [
      {
        event: {
          lane: 'reasoning',
          textDelta: 'ab',
          chunkId: 'reason-1',
          outputIndex: 0,
          itemId: 'reasoning-0',
        },
        createdAt: 101,
      },
      {
        event: {
          lane: 'reasoning',
          textDelta: 'ab',
          chunkId: 'reason-2',
          outputIndex: 0,
          itemId: 'reasoning-0',
        },
        createdAt: 102,
      },
      {
        event: {
          lane: 'reasoning',
          textDelta: 'bc',
          chunkId: 'reason-3',
          outputIndex: 0,
          itemId: 'reasoning-0',
        },
        createdAt: 103,
      },
      {
        event: {
          lane: 'reasoning',
          summaryDelta: 'sum',
          chunkId: 'summary-1',
          outputIndex: 0,
          itemId: 'reasoning-0',
          summaryIndex: 0,
        },
        createdAt: 104,
      },
      {
        event: {
          lane: 'reasoning',
          summaryDelta: 'mary',
          chunkId: 'summary-2',
          outputIndex: 0,
          itemId: 'reasoning-0',
          summaryIndex: 0,
        },
        createdAt: 105,
      },
      {
        event: { lane: 'text', text: 'xy', chunkId: 'text-1', outputIndex: 1, contentIndex: 0 },
        createdAt: 106,
      },
      {
        event: { lane: 'text', text: 'xy', chunkId: 'text-2', outputIndex: 1, contentIndex: 0 },
        createdAt: 107,
      },
      {
        event: { lane: 'text', text: 'yz', chunkId: 'text-3', outputIndex: 1, contentIndex: 0 },
        createdAt: 108,
      },
      { event: { lane: 'finish', finishReason: 'stop' }, createdAt: 109 },
    ]
    const rows: StreamChunkRow[] = []
    const writer = createWriter(
      {
        appendStreamChunks: async (batch) => {
          rows.push(...structuredClone([...batch]))
        },
      },
      100,
    )
    for (const entry of trace) writer.append(entry.event, entry.createdAt)

    await writer.settle()

    const original = replayStreamAccumulator({ initialContent: [], now: 100, entries: trace })
    const coalesced = replayStreamAccumulator({ initialContent: [], now: 100, entries: rows })
    expect(coalesced.final).toEqual(original.final)
    expect({
      firstTextAt: coalesced.accumulator.firstTextAt,
      reasoningStartedAt: coalesced.accumulator.reasoningStartedAt,
      reasoningFinishedAt: coalesced.accumulator.reasoningFinishedAt,
      textLength: coalesced.accumulator.textLength,
      reasoningLength: coalesced.accumulator.reasoningLength,
      finishReason: coalesced.accumulator.finishReason,
    }).toEqual({
      firstTextAt: original.accumulator.firstTextAt,
      reasoningStartedAt: original.accumulator.reasoningStartedAt,
      reasoningFinishedAt: original.accumulator.reasoningFinishedAt,
      textLength: original.accumulator.textLength,
      reasoningLength: original.accumulator.reasoningLength,
      finishReason: original.accumulator.finishReason,
    })
    expect(rows).toHaveLength(6)
    expect(rows.map((row) => row.seq)).toEqual([0, 1, 2, 3, 4, 5])
    expect(rows.map((row) => row.event)).toEqual([
      {
        lane: 'reasoning',
        textDelta: 'ababbc',
        outputIndex: 0,
        itemId: 'reasoning-0',
      },
      { lane: 'reasoning' },
      {
        lane: 'reasoning',
        summaryDelta: 'summary',
        outputIndex: 0,
        itemId: 'reasoning-0',
        summaryIndex: 0,
      },
      { lane: 'reasoning' },
      { lane: 'text', text: 'xyxyyz', outputIndex: 1, contentIndex: 0 },
      { lane: 'finish', finishReason: 'stop' },
    ])
  })

  it('keeps distinct reasoning and text output targets as separate rows', async () => {
    const rows: StreamChunkRow[] = []
    const writer = createWriter(
      {
        appendStreamChunks: async (batch) => {
          rows.push(...structuredClone([...batch]))
        },
      },
      100,
    )

    writer.append({ lane: 'reasoning', textDelta: 'one', itemId: 'one', outputIndex: 0 }, 101)
    writer.append({ lane: 'reasoning', textDelta: 'two', itemId: 'two', outputIndex: 0 }, 102)
    writer.append({ lane: 'text', text: 'left', outputIndex: 0, contentIndex: 0 }, 103)
    writer.append({ lane: 'text', text: 'right', outputIndex: 0, contentIndex: 1 }, 104)
    await writer.settle()

    expect(rows.map((row) => row.event)).toEqual([
      { lane: 'reasoning', textDelta: 'one', itemId: 'one', outputIndex: 0 },
      { lane: 'reasoning', textDelta: 'two', itemId: 'two', outputIndex: 0 },
      { lane: 'text', text: 'left', outputIndex: 0, contentIndex: 0 },
      { lane: 'text', text: 'right', outputIndex: 0, contentIndex: 1 },
    ])
  })

  it('coalesces generic structured detail deltas exactly but never Anthropic snapshots', async () => {
    const rows: StreamChunkRow[] = []
    const writer = createWriter(
      {
        appendStreamChunks: async (batch) => {
          rows.push(...structuredClone([...batch]))
        },
      },
      100,
    )
    const pieces = Array.from(
      { length: 1_000 },
      (_, index) => ['ha', 'ha', 'prefix-tail', 'tail-next'][index % 4] as string,
    )
    const trace: Array<{ event: StreamLaneEvent; createdAt: number }> = []
    for (const [index, text] of pieces.entries()) {
      const event: StreamLaneEvent = {
        lane: 'reasoning',
        detailsMode: 'delta',
        details: [{ type: 'reasoning.text', index: 0, format: 'unknown', text }],
      }
      trace.push({ event, createdAt: 101 + index })
      writer.append(event, 101 + index)
    }
    const snapshots: StreamLaneEvent[] = [
      {
        lane: 'reasoning',
        detailsMode: 'snapshot',
        details: [
          {
            type: 'reasoning.text',
            id: 'claude-row',
            index: 1,
            format: 'anthropic-claude-v1',
            text: 'first snapshot',
          },
        ],
      },
      {
        lane: 'reasoning',
        detailsMode: 'snapshot',
        details: [
          {
            type: 'reasoning.text',
            id: 'claude-row',
            index: 1,
            format: 'anthropic-claude-v1',
            text: 'authoritative snapshot',
          },
        ],
      },
    ]
    for (const [index, event] of snapshots.entries()) {
      trace.push({ event, createdAt: 1_101 + index })
      writer.append(event, 1_101 + index)
    }

    await writer.settle()

    const original = replayStreamAccumulator({ initialContent: [], now: 100, entries: trace })
    const replayed = replayStreamAccumulator({ initialContent: [], now: 100, entries: rows })
    expect(replayed.final).toEqual(original.final)
    expect(replayed.accumulator.reasoningFinishedAt).toBe(original.accumulator.reasoningFinishedAt)
    expect(replayed.final.reasoningDetails).toEqual([
      {
        type: 'reasoning.text',
        index: 0,
        format: 'unknown',
        text: pieces.join(''),
      },
      {
        type: 'reasoning.text',
        id: 'claude-row',
        index: 1,
        format: 'anthropic-claude-v1',
        text: 'authoritative snapshot',
      },
    ])
    expect(rows.length).toBeLessThan(12)
    expect(
      rows.filter((row) => {
        const event = row.event as StreamLaneEvent
        return event.lane === 'reasoning' && event.detailsMode === 'snapshot'
      }),
    ).toHaveLength(2)
  })

  it('coalesces details-only Claude deltas without changing their append semantics', async () => {
    const rows: StreamChunkRow[] = []
    const writer = createWriter(
      {
        appendStreamChunks: async (batch) => {
          rows.push(...structuredClone([...batch]))
        },
      },
      100,
    )
    const pieces = Array.from({ length: 1_000 }, (_, index) => 'x'.repeat((index % 10) + 1))
    for (const [index, text] of pieces.entries()) {
      writer.append(
        {
          lane: 'reasoning',
          detailsMode: 'delta',
          details: [{ type: 'reasoning.text', index: 0, format: 'anthropic-claude-v1', text }],
        },
        101 + index,
      )
    }

    await writer.settle()

    expect(rows.length).toBeLessThan(12)
    const replayed = replayStreamAccumulator({ initialContent: [], now: 100, entries: rows })
    expect(replayed.final.reasoningDetails?.[0]).toMatchObject({ text: pieces.join('') })
  })

  it('journals prefix-growing cumulative reasoning in replay-equivalent linear space', async () => {
    const rows: StreamChunkRow[] = []
    const writer = createWriter(
      {
        appendStreamChunks: async (batch) => {
          rows.push(...structuredClone([...batch]))
        },
      },
      100,
    )
    const original = createStreamAccumulator({ initialContent: [], now: 100 })
    const chunkCount = 10_000
    let cumulative = ''

    for (let index = 0; index < chunkCount; index += 1) {
      cumulative += String(index % 10)
      const event: StreamLaneEvent = {
        lane: 'reasoning',
        detailsMode: 'cumulative',
        details: [
          {
            type: 'reasoning.text',
            id: 'claude-reasoning',
            index: 0,
            format: 'anthropic-claude-v1',
            text: cumulative,
            ...(index === 0 ? { hidden: true } : {}),
            ...(index === chunkCount - 1 ? { signature: 'final-signature' } : {}),
          },
        ],
      }
      const createdAt = 101 + index
      applyStreamAccumulatorEvent(original, event, createdAt)
      writer.append(event, createdAt)
    }

    await writer.settle()

    const replayed = replayStreamAccumulator({ initialContent: [], now: 100, entries: rows })
    expect(replayed.final).toEqual(projectStreamAccumulatorFinal(original))
    expect(replayed.accumulator.reasoningFinishedAt).toBe(100 + chunkCount)
    expect(replayed.accumulator.reasoningFinishedAt).toBe(original.reasoningFinishedAt)
    expect(replayed.final.reasoningDetails).toEqual([
      {
        type: 'reasoning.text',
        id: 'claude-reasoning',
        index: 0,
        format: 'anthropic-claude-v1',
        text: cumulative,
        signature: 'final-signature',
        hidden: true,
      },
    ])
    const persistedReasoningCharacters = rows.reduce((sum, row) => {
      const event = row.event as StreamLaneEvent
      if (event.lane !== 'reasoning') return sum
      return (
        sum +
        (event.details ?? []).reduce<number>((detailSum, raw) => {
          if (!raw || typeof raw !== 'object') return detailSum
          const detail = raw as { text?: unknown; summary?: unknown; data?: unknown }
          return (
            detailSum +
            (typeof detail.text === 'string' ? detail.text.length : 0) +
            (typeof detail.summary === 'string' ? detail.summary.length : 0) +
            (typeof detail.data === 'string' ? detail.data.length : 0)
          )
        }, 0)
      )
    }, 0)
    expect(persistedReasoningCharacters).toBe(chunkCount)
    expect(rows.length).toBeLessThan(100)
  })

  it('indexes adversarial changing reasoning ids without per-event row scans or alias growth', async () => {
    let persistedRows = 0
    const writer = createWriter(
      {
        appendStreamChunks: async (batch) => {
          persistedRows += batch.length
        },
      },
      100,
    )
    const rowCount = 20_000

    for (let index = 0; index < rowCount; index += 1) {
      writer.append(
        {
          lane: 'reasoning',
          detailsMode: 'delta',
          details: [
            {
              type: 'reasoning.text',
              id: `changing-id-${index}`,
              index: 0,
              format: 'unknown',
              text: 'x',
            },
          ],
        },
        101 + index,
      )
    }

    expect(writer.inspect()).toMatchObject({
      trackedReasoningRows: rowCount,
      trackedReasoningIds: rowCount,
    })
    await writer.settle()

    expect(persistedRows).toBe(rowCount)
  })

  it('keeps one canonical reasoning identity for a long stable-id stream', async () => {
    const writer = createWriter({ appendStreamChunks: async () => undefined }, 100)
    const chunkCount = 20_000

    for (let index = 0; index < chunkCount; index += 1) {
      writer.append(
        {
          lane: 'reasoning',
          detailsMode: 'delta',
          details: [
            {
              type: 'reasoning.text',
              id: 'stable-reasoning-id',
              index: 0,
              format: 'unknown',
              text: 'x',
            },
          ],
        },
        101 + index,
      )
    }

    expect(writer.inspect()).toMatchObject({ trackedReasoningRows: 1, trackedReasoningIds: 1 })
    await writer.settle()
  })

  it('replays an equal cumulative mirror after a scalar delta without duplication', async () => {
    const rows: StreamChunkRow[] = []
    const writer = createWriter(
      {
        appendStreamChunks: async (batch) => {
          rows.push(...structuredClone([...batch]))
        },
      },
      100,
    )
    const trace: Array<{ event: StreamLaneEvent; createdAt: number }> = [
      {
        event: {
          lane: 'reasoning',
          detailsMode: 'delta',
          details: [{ type: 'reasoning.text', index: 0, text: 'a' }],
        },
        createdAt: 101,
      },
      { event: { lane: 'reasoning', textDelta: 'b' }, createdAt: 102 },
      {
        event: {
          lane: 'reasoning',
          detailsMode: 'cumulative',
          details: [{ type: 'reasoning.text', index: 0, text: 'ab' }],
        },
        createdAt: 103,
      },
    ]
    for (const entry of trace) writer.append(entry.event, entry.createdAt)

    await writer.settle()

    const original = replayStreamAccumulator({ initialContent: [], now: 100, entries: trace })
    const replayed = replayStreamAccumulator({ initialContent: [], now: 100, entries: rows })
    expect(replayed.final).toEqual(original.final)
    expect(replayed.final.reasoningDetails?.[0]).toMatchObject({ text: 'ab' })
  })

  it('bounds coalescing sections and reduces a 100k plus 100k trace to twelve rows', async () => {
    const rows: StreamChunkRow[] = []
    const writer = createWriter(
      {
        appendStreamChunks: async (batch) => {
          rows.push(...batch)
        },
      },
      100,
    )
    const chunkChars = 128
    const laneChars = 100_000
    const chunksPerLane = Math.ceil(laneChars / chunkChars)
    for (let index = 0; index < chunksPerLane; index += 1) {
      const length = Math.min(chunkChars, laneChars - index * chunkChars)
      writer.append(
        { lane: 'reasoning', textDelta: 'r'.repeat(length), chunkId: `reason-${index}` },
        101 + index,
      )
    }
    for (let index = 0; index < chunksPerLane; index += 1) {
      const length = Math.min(chunkChars, laneChars - index * chunkChars)
      writer.append(
        { lane: 'text', text: 't'.repeat(length), chunkId: `text-${index}` },
        101 + chunksPerLane + index,
      )
    }

    await writer.settle()

    expect(chunksPerLane * 2).toBe(1_564)
    expect(rows).toHaveLength(12)
    expect(
      rows.reduce((sum, row) => {
        const event = row.event as StreamLaneEvent
        return sum + (event.lane === 'text' ? event.text.length : 0)
      }, 0),
    ).toBe(laneChars)
    expect(
      rows.reduce((sum, row) => {
        const event = row.event as StreamLaneEvent
        return sum + (event.lane === 'reasoning' ? (event.textDelta?.length ?? 0) : 0)
      }, 0),
    ).toBe(laneChars)
  })

  it('coalesces a million-character tool-call lane and crash-replays every argument byte', async () => {
    const rows: StreamChunkRow[] = []
    const writer = createWriter(
      {
        appendStreamChunks: async (batch) => {
          rows.push(...structuredClone([...batch]))
        },
      },
      100,
    )
    const fragment = 'tool-argument-fragment-'.repeat(6)
    const chunks = 8_000
    for (let index = 0; index < chunks; index += 1) {
      writer.append(
        {
          lane: 'tool-call',
          index: 3,
          ...(index === 0 ? { id: 'call-long', type: 'function' as const, name: 'long_tool' } : {}),
          argumentsDelta: fragment,
          chunkId: `tool-${index}`,
        },
        101 + index,
      )
    }

    await writer.settle()

    expect(fragment.length * chunks).toBeGreaterThan(1_000_000)
    expect(rows.length).toBeLessThan(chunks / 100)
    expect(rows.every((row) => (row.event as StreamLaneEvent).lane === 'tool-call')).toBe(true)
    const replayed = replayStreamAccumulator({ initialContent: [], now: 100, entries: rows })
    expect(replayed.final.toolCalls).toEqual([
      {
        id: 'call-long',
        type: 'function',
        function: { name: 'long_tool', arguments: fragment.repeat(chunks) },
      },
    ])
  })

  it('never coalesces across a successful flush boundary', async () => {
    const batches: StreamChunkRow[][] = []
    const writer = createWriter(
      {
        appendStreamChunks: async (rows) => {
          batches.push(structuredClone([...rows]))
        },
      },
      100,
    )
    writer.append({ lane: 'text', text: 'a' }, 101)
    writer.append({ lane: 'text', text: 'b' }, 102)
    await writer.flush()
    writer.append({ lane: 'text', text: 'c' }, 103)
    writer.append({ lane: 'text', text: 'd' }, 104)
    await writer.flush()

    expect(batches.map((batch) => batch.map((row) => row.event))).toEqual([
      [{ lane: 'text', text: 'ab' }],
      [{ lane: 'text', text: 'cd' }],
    ])
    expect(batches.flat().map((row) => row.seq)).toEqual([0, 1])
  })

  it('requeues a failed batch ahead of rows received during the write', async () => {
    vi.useFakeTimers()
    const firstWrite = deferred<void>()
    const batches: StreamChunkRow[][] = []
    const appendStreamChunks = vi.fn((rows: readonly StreamChunkRow[]) => {
      batches.push([...rows])
      return batches.length === 1 ? firstWrite.promise : Promise.resolve()
    })
    const writer = createWriter({ appendStreamChunks }, 100)

    writer.append({ lane: 'text', text: 'first' }, 101)
    const flush = writer.flush()
    expect(writer.inspect()).toMatchObject({ status: 'flushing', bufferedRows: 0 })
    writer.append({ lane: 'text', text: 'second' }, 102)
    writer.flush({ mode: 'scheduled', now: 102 })
    firstWrite.reject(new Error('write failed'))

    await expect(flush).rejects.toThrow('write failed')
    const degraded = writer.inspect()
    expect(degraded).toMatchObject({
      status: 'degraded',
      bufferedRows: 2,
    })
    expect(degraded.failure).toBeInstanceOf(Error)
    if (!(degraded.failure instanceof Error)) throw new Error('expected writer failure')
    expect(degraded.failure.message).toBe('write failed')
    await writer.flush()

    expect(batches).toHaveLength(2)
    expect(batches[0]?.map((row) => row.event)).toEqual([{ lane: 'text', text: 'first' }])
    expect(batches[1]?.map((row) => row.event)).toEqual([
      { lane: 'text', text: 'first' },
      { lane: 'text', text: 'second' },
    ])
    expect(batches[1]?.map((row) => row.seq)).toEqual([0, 1])
    expect(writer.inspect()).toMatchObject({ status: 'open', bufferedRows: 0 })
  })

  it('retries already-materialized coalesced rows without copying or reordering their tail', async () => {
    vi.useFakeTimers()
    const firstWrite = deferred<void>()
    const batches: StreamChunkRow[][] = []
    const appendStreamChunks = vi.fn((rows: readonly StreamChunkRow[]) => {
      batches.push(structuredClone([...rows]))
      return batches.length === 1 ? firstWrite.promise : Promise.resolve()
    })
    const writer = createWriter({ appendStreamChunks }, 100)

    writer.append({ lane: 'text', text: 'a', chunkId: 'a' }, 101)
    writer.append({ lane: 'text', text: 'b', chunkId: 'b' }, 102)
    writer.append({ lane: 'text', text: 'c', chunkId: 'c' }, 103)
    const flush = writer.flush()
    writer.append({ lane: 'text', text: 'd', chunkId: 'd' }, 104)
    writer.append({ lane: 'text', text: 'e', chunkId: 'e' }, 105)
    firstWrite.reject(new Error('write failed'))

    await expect(flush).rejects.toThrow('write failed')
    await writer.flush()

    expect(batches.map((batch) => batch.map((row) => row.event))).toEqual([
      [{ lane: 'text', text: 'abc' }],
      [
        { lane: 'text', text: 'abc' },
        { lane: 'text', text: 'de' },
      ],
    ])
    expect(batches[1]?.map((row) => row.seq)).toEqual([0, 1])
    expect(batches[1]?.[0]).toEqual(batches[0]?.[0])
  })

  it('batches independent stream writers that flush through the same port instance', async () => {
    const write = deferred<void>()
    const batches: StreamChunkRow[][] = []
    const port: StreamChunkAppendPort = {
      appendStreamChunks: vi.fn((rows: readonly StreamChunkRow[]) => {
        batches.push(structuredClone([...rows]))
        return write.promise
      }),
    }
    const first = createWriter(port, 100)
    const second = createStreamChunkWriter({
      port,
      chatId: 'chat-2',
      streamId: 'stream-2',
      messageId: 'message-2',
      now: 100,
      fence: testFence('stream-2'),
    })
    first.append({ lane: 'text', text: 'first' }, 101)
    second.append({ lane: 'text', text: 'second' }, 102)

    const firstFlush = first.flush()
    const secondFlush = second.flush()
    expect(port.appendStreamChunks).not.toHaveBeenCalled()
    await Promise.resolve()

    expect(port.appendStreamChunks).toHaveBeenCalledTimes(1)
    expect(batches[0]?.map((row) => row.streamId)).toEqual(['stream-1', 'stream-2'])
    write.resolve()

    await expect(Promise.all([firstFlush, secondFlush])).resolves.toEqual([undefined, undefined])
  })

  it('bounds the aggregate transaction size across many ready writers', async () => {
    const batches: StreamChunkRow[][] = []
    const port: StreamChunkAppendPort = {
      appendStreamChunks: vi.fn(async (rows: readonly StreamChunkRow[]) => {
        batches.push(structuredClone([...rows]))
      }),
    }
    const writers = Array.from({ length: 24 }, (_, index) =>
      createStreamChunkWriter({
        port,
        chatId: `chat-${index}`,
        streamId: `stream-${index}`,
        messageId: `message-${index}`,
        now: 100,
        fence: testFence(`stream-${index}`),
      }),
    )
    for (const [index, writer] of writers.entries()) {
      writer.append({ lane: 'text', text: `${index % 10}`.repeat(100_000) }, 101)
    }

    await Promise.all(writers.map((writer) => writer.flush()))

    expect(batches.length).toBeGreaterThan(1)
    expect(batches.flat()).toHaveLength(writers.length)
    expect(new Set(batches.flat().map((row) => row.streamId)).size).toBe(writers.length)
  })

  it('starts the next same-port batch immediately after an in-flight write', async () => {
    const writes = [deferred<void>(), deferred<void>()]
    const batches: StreamChunkRow[][] = []
    const port: StreamChunkAppendPort = {
      appendStreamChunks: vi.fn((rows: readonly StreamChunkRow[]) => {
        batches.push(structuredClone([...rows]))
        return writes[batches.length - 1]?.promise ?? Promise.resolve()
      }),
    }
    const first = createWriter(port, 100)
    const second = createStreamChunkWriter({
      port,
      chatId: 'chat-2',
      streamId: 'stream-2',
      messageId: 'message-2',
      now: 100,
      fence: testFence('stream-2'),
    })
    first.append({ lane: 'text', text: 'first' }, 101)

    const firstFlush = first.flush()
    await Promise.resolve()
    expect(port.appendStreamChunks).toHaveBeenCalledTimes(1)

    second.append({ lane: 'text', text: 'second' }, 102)
    const secondFlush = second.flush()
    await Promise.resolve()
    expect(port.appendStreamChunks).toHaveBeenCalledTimes(1)

    writes[0]?.resolve()
    await firstFlush
    expect(port.appendStreamChunks).toHaveBeenCalledTimes(2)
    expect(batches.map((batch) => batch[0]?.streamId)).toEqual(['stream-1', 'stream-2'])

    writes[1]?.resolve()
    await expect(secondFlush).resolves.toBeUndefined()
  })

  it('applies lossless backpressure while an append is pending', async () => {
    const firstWrite = deferred<void>()
    const committed: StreamChunkRow[] = []
    let writes = 0
    const port: StreamChunkAppendPort = {
      appendStreamChunks: vi.fn(async (rows: readonly StreamChunkRow[]) => {
        writes += 1
        if (writes === 1) await firstWrite.promise
        committed.push(...structuredClone([...rows]))
      }),
    }
    const writer = createWriter(port, 100)

    writer.append({ lane: 'text', text: 'a'.repeat(128 * 1024) }, 101)
    writer.flush({ mode: 'scheduled', now: 101 })
    await drainMicrotasks()
    expect(port.appendStreamChunks).toHaveBeenCalledTimes(1)

    let pressure: Promise<void> | undefined
    let appendedTail = ''
    for (let index = 0; pressure === undefined; index += 1) {
      const text = `${index % 10}`.repeat(1_024)
      appendedTail += text
      writer.append({ lane: 'text', text }, 102 + index)
      writer.flush({ mode: 'scheduled', now: 102 + index })
      pressure = writer.backpressure()
      expect(writer.inspect().bufferedBytes).toBeLessThan(270 * 1024)
    }

    let pressureSettled = false
    void pressure.then(() => {
      pressureSettled = true
    })
    await drainMicrotasks()
    expect(pressureSettled).toBe(false)

    firstWrite.resolve()
    await pressure
    await writer.settle()

    expect(writer.inspect()).toMatchObject({ status: 'open', bufferedRows: 0, bufferedBytes: 0 })
    expect(committed.map((row) => row.seq)).toEqual(
      Array.from({ length: committed.length }, (_, index) => index),
    )
    const replay = replayStreamAccumulator({
      initialContent: [],
      now: 100,
      entries: committed,
    })
    expect(replay.final.content).toEqual([
      { type: 'output_text', text: `${'a'.repeat(128 * 1024)}${appendedTail}` },
    ])
  })

  it('retries one transient append failure under backpressure without dropping the stream tail', async () => {
    const committed: StreamChunkRow[] = []
    let writes = 0
    const writer = createWriter(
      {
        appendStreamChunks: vi.fn(async (rows: readonly StreamChunkRow[]) => {
          writes += 1
          if (writes === 1) throw new Error('transient IndexedDB failure')
          committed.push(...structuredClone([...rows]))
        }),
      },
      100,
    )
    for (let index = 0; index < 512; index += 1) {
      writer.append({ lane: 'text', text: 'x' }, 100 + index)
    }

    await expect(writer.backpressure()).resolves.toBeUndefined()
    await writer.settle()

    expect(writes).toBe(2)
    expect(writer.inspect()).toMatchObject({ status: 'open', bufferedRows: 0, bufferedBytes: 0 })
    const replay = replayStreamAccumulator({ initialContent: [], now: 100, entries: committed })
    expect(replay.final.content).toEqual([{ type: 'output_text', text: 'x'.repeat(512) }])
  })

  it('bounds and exactly drains 100 writers sharing one slow append port', async () => {
    const firstWrite = deferred<void>()
    const committed: StreamChunkRow[] = []
    let writes = 0
    const port: StreamChunkAppendPort = {
      appendStreamChunks: vi.fn(async (rows: readonly StreamChunkRow[]) => {
        writes += 1
        if (writes === 1) await firstWrite.promise
        committed.push(...structuredClone([...rows]))
      }),
    }
    const writers = Array.from({ length: 100 }, (_, index) =>
      createStreamChunkWriter({
        port,
        chatId: `chat-${index}`,
        streamId: `stream-${index}`,
        messageId: `message-${index}`,
        now: 100,
        fence: testFence(`stream-${index}`),
      }),
    )

    for (const writer of writers) {
      for (let index = 0; index < 256; index += 1) {
        writer.append({ lane: 'text', text: '' }, 101 + index)
      }
      writer.flush({ mode: 'scheduled', now: 356 })
    }
    await drainMicrotasks()
    expect(port.appendStreamChunks).toHaveBeenCalledTimes(1)

    const pressure = writers.map((writer) => {
      for (let index = 0; index < 512; index += 1) {
        writer.append({ lane: 'text', text: '' }, 357 + index)
        writer.flush({ mode: 'scheduled', now: 357 + index })
      }
      const waiting = writer.backpressure()
      expect(waiting).toBeInstanceOf(Promise)
      expect(writer.inspect()).toMatchObject({ bufferedRows: 512 })
      return waiting as Promise<void>
    })

    firstWrite.resolve()
    await Promise.all(pressure)
    await Promise.all(writers.map((writer) => writer.settle()))

    expect(port.appendStreamChunks).toHaveBeenCalledTimes(2)
    for (let index = 0; index < writers.length; index += 1) {
      const rows = committed.filter((row) => row.streamId === `stream-${index}`)
      expect(rows.map((row) => row.seq)).toEqual([0, 1, 2])
      expect(rows.map((row) => row.event)).toEqual([
        { lane: 'text', text: '' },
        { lane: 'text', text: '' },
        { lane: 'text', text: '' },
      ])
      expect(writers[index]?.inspect()).toMatchObject({
        status: 'open',
        bufferedRows: 0,
        bufferedBytes: 0,
      })
    }
  })

  it('drains shared requests across queue compaction boundaries in bounded FIFO batches', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const batchSizes: number[] = []
    const committedStreamIds: string[] = []
    const port: StreamChunkAppendPort = {
      appendStreamChunks: vi.fn(async (rows: readonly StreamChunkRow[]) => {
        batchSizes.push(rows.length)
        committedStreamIds.push(...rows.map((row) => row.streamId))
      }),
    }
    const writerCount = 4_097
    const writers = Array.from({ length: writerCount }, (_, index) => {
      const streamId = `compaction-stream-${index}`
      const writer = createStreamChunkWriter({
        port,
        chatId: `compaction-chat-${index}`,
        streamId,
        messageId: `compaction-message-${index}`,
        now: 100,
        fence: testFence(streamId),
      })
      writer.append({ lane: 'text', text: 'x' }, 101)
      return writer
    })

    await Promise.all(writers.map((writer) => writer.flush()))

    expect(batchSizes).toEqual([2_048, 2_048, 1])
    expect(committedStreamIds).toEqual(
      Array.from({ length: writerCount }, (_, index) => `compaction-stream-${index}`),
    )
  })

  it('drains later same-port calls after an in-flight batch fails', async () => {
    const firstWrite = deferred<void>()
    const failure = new Error('first transaction failed')
    const batches: StreamChunkRow[][] = []
    const port: StreamChunkAppendPort = {
      appendStreamChunks: vi.fn((rows: readonly StreamChunkRow[]) => {
        batches.push(structuredClone([...rows]))
        return batches.length === 1 ? firstWrite.promise : Promise.resolve()
      }),
    }
    const first = createWriter(port, 100)
    const second = createStreamChunkWriter({
      port,
      chatId: 'chat-2',
      streamId: 'stream-2',
      messageId: 'message-2',
      now: 100,
      fence: testFence('stream-2'),
    })
    first.append({ lane: 'text', text: 'first' }, 101)

    const firstFlush = first.flush()
    await Promise.resolve()
    expect(port.appendStreamChunks).toHaveBeenCalledTimes(1)

    second.append({ lane: 'text', text: 'second' }, 102)
    const secondFlush = second.flush()
    firstWrite.reject(failure)

    await expect(firstFlush).rejects.toBe(failure)
    await expect(secondFlush).resolves.toBeUndefined()
    expect(port.appendStreamChunks).toHaveBeenCalledTimes(2)
    expect(batches.map((batch) => batch[0]?.streamId)).toEqual(['stream-1', 'stream-2'])
    await expect(first.settle()).resolves.toBeUndefined()
    expect(port.appendStreamChunks).toHaveBeenCalledTimes(3)
  })

  it('lets independent stream writers flush concurrently through different port instances', async () => {
    const writes = [deferred<void>(), deferred<void>()]
    const batches: StreamChunkRow[][] = []
    const appendStreamChunks = vi.fn((rows: readonly StreamChunkRow[]) => {
      batches.push(structuredClone([...rows]))
      return writes[batches.length - 1]?.promise ?? Promise.resolve()
    })
    const first = createWriter({ appendStreamChunks }, 100)
    const second = createStreamChunkWriter({
      port: { appendStreamChunks },
      chatId: 'chat-2',
      streamId: 'stream-2',
      messageId: 'message-2',
      now: 100,
      fence: testFence('stream-2'),
    })
    first.append({ lane: 'text', text: 'first' }, 101)
    second.append({ lane: 'text', text: 'second' }, 102)

    const firstFlush = first.flush()
    const secondFlush = second.flush()
    await Promise.resolve()
    expect(appendStreamChunks).toHaveBeenCalledTimes(2)
    expect(batches.map((batch) => batch[0]?.streamId)).toEqual(['stream-1', 'stream-2'])
    writes[0]?.resolve()
    writes[1]?.resolve()

    await expect(Promise.all([firstFlush, secondFlush])).resolves.toEqual([undefined, undefined])
  })

  it('rejects a failed shared batch and retries every writer without row loss or reordering', async () => {
    const failure = new Error('shared transaction failed')
    const batches: StreamChunkRow[][] = []
    const committed: StreamChunkRow[] = []
    const port: StreamChunkAppendPort = {
      appendStreamChunks: vi.fn(async (rows: readonly StreamChunkRow[]) => {
        const batch = structuredClone([...rows])
        batches.push(batch)
        if (batches.length === 1) throw failure
        committed.push(...batch)
      }),
    }
    const first = createWriter(port, 100)
    const second = createStreamChunkWriter({
      port,
      chatId: 'chat-2',
      streamId: 'stream-2',
      messageId: 'message-2',
      now: 100,
      fence: testFence('stream-2'),
    })
    first.append({ lane: 'text', text: 'first-a' }, 101)
    second.append({ lane: 'text', text: 'second-a' }, 102)

    const firstAttempt = await Promise.allSettled([first.flush(), second.flush()])

    expect(firstAttempt).toEqual([
      { status: 'rejected', reason: failure },
      { status: 'rejected', reason: failure },
    ])
    expect(batches[0]?.map((row) => `${row.streamId}:${row.seq}`)).toEqual([
      'stream-1:0',
      'stream-2:0',
    ])
    first.append({ lane: 'text', text: 'first-b' }, 103)
    second.append({ lane: 'text', text: 'second-b' }, 104)

    await Promise.all([first.settle(), second.settle()])

    expect(port.appendStreamChunks).toHaveBeenCalledTimes(2)
    expect(batches[1]?.map((row) => `${row.streamId}:${row.seq}`)).toEqual([
      'stream-1:0',
      'stream-1:1',
      'stream-2:0',
      'stream-2:1',
    ])
    expect(committed.map((row) => [row.streamId, row.seq, row.event])).toEqual([
      ['stream-1', 0, { lane: 'text', text: 'first-a' }],
      ['stream-1', 1, { lane: 'text', text: 'first-b' }],
      ['stream-2', 0, { lane: 'text', text: 'second-a' }],
      ['stream-2', 1, { lane: 'text', text: 'second-b' }],
    ])
  })

  it('isolates a stale stream fence without failing a healthy writer in the shared batch', async () => {
    const committed: StreamChunkRow[] = []
    const batches: string[][] = []
    const port: StreamChunkAppendPort = {
      appendStreamChunks: vi.fn(async (rows: readonly StreamChunkRow[]) => {
        batches.push(rows.map((row) => row.streamId))
        if (rows.some((row) => row.streamId === 'stream-stale')) {
          throw new Error('StreamFenceLost:stream-stale')
        }
        committed.push(...structuredClone([...rows]))
      }),
    }
    const stale = createStreamChunkWriter({
      port,
      chatId: 'chat-stale',
      streamId: 'stream-stale',
      messageId: 'message-stale',
      now: 100,
      fence: testFence('stream-stale'),
    })
    const healthy = createStreamChunkWriter({
      port,
      chatId: 'chat-healthy',
      streamId: 'stream-healthy',
      messageId: 'message-healthy',
      now: 100,
      fence: testFence('stream-healthy'),
    })
    stale.append({ lane: 'text', text: 'stale' }, 101)
    healthy.append({ lane: 'text', text: 'healthy' }, 101)

    const results = await Promise.allSettled([stale.flush(), healthy.flush()])

    const staleResult = results[0]
    expect(staleResult.status).toBe('rejected')
    if (staleResult.status !== 'rejected') throw new Error('expected stale writer rejection')
    const staleReason: unknown = staleResult.reason
    expect(staleReason).toBeInstanceOf(Error)
    if (!(staleReason instanceof Error)) throw new Error('expected stale writer error')
    expect(staleReason.message).toBe('StreamFenceLost:stream-stale')
    expect(results[1]).toEqual({ status: 'fulfilled', value: undefined })
    expect(batches).toEqual([
      ['stream-stale', 'stream-healthy'],
      ['stream-stale'],
      ['stream-healthy'],
    ])
    expect(committed.map((row) => [row.streamId, row.seq, row.event])).toEqual([
      ['stream-healthy', 0, { lane: 'text', text: 'healthy' }],
    ])
    expect(healthy.inspect()).toMatchObject({ status: 'open', bufferedRows: 0 })
    expect(stale.inspect()).toMatchObject({ status: 'degraded', bufferedRows: 1 })
  })

  it('settlement retries one failed in-flight write and persists its concurrent tail', async () => {
    vi.useFakeTimers()
    const firstWrite = deferred<void>()
    const batches: StreamChunkRow[][] = []
    const appendStreamChunks = vi.fn((rows: readonly StreamChunkRow[]) => {
      batches.push([...rows])
      return batches.length === 1 ? firstWrite.promise : Promise.resolve()
    })
    const writer = createWriter({ appendStreamChunks }, 100)

    writer.append({ lane: 'text', text: 'first' }, 300)
    writer.flush({ mode: 'scheduled', now: 300 })
    writer.append({ lane: 'text', text: 'second' }, 301)
    const settlement = writer.settle()
    firstWrite.reject(new Error('transient write failure'))

    await expect(settlement).resolves.toBeUndefined()
    expect(batches.map((batch) => batch.map((row) => row.event))).toEqual([
      [{ lane: 'text', text: 'first' }],
      [
        { lane: 'text', text: 'first' },
        { lane: 'text', text: 'second' },
      ],
    ])
    expect(writer.inspect()).toMatchObject({ status: 'open', bufferedRows: 0 })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('settlement retries a transient failure from its own forced flush', async () => {
    vi.useFakeTimers()
    const batches: StreamChunkRow[][] = []
    const appendStreamChunks = vi.fn(async (rows: readonly StreamChunkRow[]) => {
      batches.push([...rows])
      if (batches.length === 1) throw new Error('transient write failure')
    })
    const writer = createWriter({ appendStreamChunks }, 100)

    writer.append({ lane: 'text', text: 'tail' }, 101)
    await expect(writer.settle()).resolves.toBeUndefined()

    expect(batches.map((batch) => batch.map((row) => row.event))).toEqual([
      [{ lane: 'text', text: 'tail' }],
      [{ lane: 'text', text: 'tail' }],
    ])
    expect(writer.inspect()).toMatchObject({ status: 'open', bufferedRows: 0 })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('requeues a synchronously thrown port failure', async () => {
    const failure = new Error('synchronous write failure')
    const batches: StreamChunkRow[][] = []
    const appendStreamChunks = vi.fn((rows: readonly StreamChunkRow[]): Promise<void> => {
      batches.push([...rows])
      if (batches.length === 1) throw failure
      return Promise.resolve()
    })
    const writer = createWriter({ appendStreamChunks }, 100)

    writer.append({ lane: 'text', text: 'tail' }, 101)
    await expect(writer.settle()).resolves.toBeUndefined()

    expect(batches.map((batch) => batch.map((row) => row.seq))).toEqual([[0], [0]])
    expect(writer.inspect()).toMatchObject({ status: 'open', bufferedRows: 0 })
  })

  it('checkpoint retries one transient write before acknowledging a visible prefix', async () => {
    const batches: StreamChunkRow[][] = []
    const appendStreamChunks = vi.fn(async (rows: readonly StreamChunkRow[]) => {
      batches.push([...rows])
      if (batches.length === 1) throw new Error('transient write failure')
    })
    const writer = createWriter({ appendStreamChunks }, 100)

    writer.append({ lane: 'text', text: 'visible-prefix' }, 101)
    await expect(writer.checkpoint()).resolves.toBeUndefined()

    expect(batches.map((batch) => batch.map((row) => row.event))).toEqual([
      [{ lane: 'text', text: 'visible-prefix' }],
      [{ lane: 'text', text: 'visible-prefix' }],
    ])
    expect(writer.inspect()).toMatchObject({ status: 'open', bufferedRows: 0 })
  })

  it('surfaces permanent storage failure through flush and settlement', async () => {
    vi.useFakeTimers()
    const firstFailure = new Error('first write failed')
    const permanentFailure = new Error('storage unavailable')
    const appendStreamChunks = vi
      .fn<StreamChunkAppendPort['appendStreamChunks']>()
      .mockRejectedValueOnce(firstFailure)
      .mockRejectedValue(permanentFailure)
    const writer = createWriter({ appendStreamChunks }, 100)

    writer.append({ lane: 'text', text: 'first' }, 300)
    await expect(writer.flush()).rejects.toBe(firstFailure)
    expect(writer.inspect()).toMatchObject({ status: 'degraded', bufferedRows: 1 })

    await expect(writer.flush()).rejects.toBe(permanentFailure)
    expect(writer.inspect()).toMatchObject({
      status: 'failed',
      bufferedRows: 1,
      failure: permanentFailure,
    })
    expect(vi.getTimerCount()).toBe(0)
    await expect(writer.settle()).rejects.toBe(permanentFailure)
    await expect(writer.flush()).rejects.toBe(permanentFailure)

    writer.release()
    expect(writer.inspect()).toMatchObject({ status: 'closed', bufferedRows: 0, bufferedBytes: 0 })
  })

  it('bounds degraded recovery buffering by row count', async () => {
    vi.useFakeTimers()
    const appendStreamChunks = vi.fn(async (_rows: readonly StreamChunkRow[]) => {
      throw new Error('write failed')
    })
    const writer = createWriter({ appendStreamChunks }, 100)

    writer.append({ lane: 'text', text: 'first' }, 101)
    await expect(writer.flush()).rejects.toThrow('write failed')

    let capacityError: unknown
    for (let index = 0; index < 3_000; index += 1) {
      try {
        writer.append({ lane: 'text', text: '' }, 102 + index)
      } catch (error) {
        capacityError = error
        break
      }
    }

    expect(capacityError).toMatchObject({ name: 'StreamChunkRecoveryCapacityError' })
    expect(writer.inspect()).toMatchObject({
      status: 'failed',
      bufferedRows: 2_048,
      failure: capacityError,
    })
    expect(vi.getTimerCount()).toBe(0)
    expect(() => writer.append({ lane: 'text', text: 'too late' }, 10_000)).toThrow(
      'Stream chunk recovery buffer exceeded',
    )
    await expect(writer.settle()).rejects.toBe(capacityError)
  })

  it('bounds degraded recovery buffering by estimated bytes', async () => {
    vi.useFakeTimers()
    const appendStreamChunks = vi.fn(async (_rows: readonly StreamChunkRow[]) => {
      throw new Error('write failed')
    })
    const writer = createWriter({ appendStreamChunks }, 100)

    writer.append({ lane: 'text', text: 'first' }, 101)
    await expect(writer.flush()).rejects.toThrow('write failed')

    expect(() => writer.append({ lane: 'text', text: 'x'.repeat(2 * 1024 * 1024) }, 102)).toThrow(
      'Stream chunk recovery buffer exceeded',
    )
    const failed = writer.inspect()
    expect(failed).toMatchObject({
      status: 'failed',
      bufferedRows: 1,
    })
    expect(failed.failure).toBeInstanceOf(Error)
    if (!(failed.failure instanceof Error)) throw new Error('expected recovery capacity error')
    expect(failed.failure.name).toBe('StreamChunkRecoveryCapacityError')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('release cancels timers, closes acceptance, and cannot be reopened by a late failure', async () => {
    vi.useFakeTimers()
    const delayedAppend = vi.fn(async (_rows: readonly StreamChunkRow[]) => {})
    const delayedWriter = createWriter({ appendStreamChunks: delayedAppend }, 100)
    delayedWriter.append({ lane: 'text', text: 'delayed' }, 101)
    delayedWriter.flush({ mode: 'scheduled', now: 101 })
    expect(vi.getTimerCount()).toBe(1)
    delayedWriter.release()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(delayedAppend).not.toHaveBeenCalled()

    const write = deferred<void>()
    const appendStreamChunks = vi.fn((_rows: readonly StreamChunkRow[]) => write.promise)
    const writer = createWriter({ appendStreamChunks }, 100)

    writer.append({ lane: 'text', text: 'first' }, 300)
    writer.flush({ mode: 'scheduled', now: 300 })
    expect(writer.inspect().status).toBe('flushing')
    writer.release()
    writer.release()
    expect(writer.inspect()).toMatchObject({ status: 'closed', bufferedRows: 0, bufferedBytes: 0 })
    expect(vi.getTimerCount()).toBe(0)

    write.reject(new Error('late write failure'))
    await vi.advanceTimersByTimeAsync(1_000)

    expect(appendStreamChunks).toHaveBeenCalledTimes(1)
    expect(writer.inspect().status).toBe('closed')
    expect(() => writer.append({ lane: 'text', text: 'too late' }, 301)).toThrow(
      'Stream chunk writer is closed',
    )
    await expect(writer.flush()).rejects.toThrow('Stream chunk writer is closed')
    expect(appendStreamChunks).toHaveBeenCalledTimes(1)
  })
})

function createWriter(port: StreamChunkAppendPort, now: number) {
  return createStreamChunkWriter({
    port,
    chatId: 'chat-1',
    streamId: 'stream-1',
    messageId: 'message-1',
    now,
    fence: testFence('stream-1'),
  })
}

function testFence(streamId: string) {
  return {
    ownerClientId: 'test-client',
    fenceToken: `fence:${streamId}`,
    replacementEpoch: 0,
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function drainMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}
