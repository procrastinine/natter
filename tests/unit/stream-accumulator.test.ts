import { describe, expect, it } from 'vitest'
import { ApiError } from '../../src/api/errors'
import type { StreamLaneEvent } from '../../src/api/stream-transforms'
import {
  applyStreamAccumulatorEvent,
  createStreamAccumulator,
  markStreamAccumulatorPublished,
  projectStreamAccumulatorFinal,
  projectStreamAccumulatorLive,
  projectStreamGeneration,
  releaseStreamAccumulatorBuffers,
  replayStreamAccumulator,
  shouldPublishStreamAccumulatorLive,
  streamAccumulatorHasCompletionCalibrationBlockers,
  streamAccumulatorReasoningLength,
  streamAccumulatorText,
} from '../../src/core/stream-accumulator'
import type { ChatUsage, ContentItem } from '../../src/core/types'

function applyTrace(
  accumulator: ReturnType<typeof createStreamAccumulator>,
  trace: ReadonlyArray<{ event: StreamLaneEvent; at: number }>,
): void {
  for (const entry of trace) {
    applyStreamAccumulatorEvent(accumulator, entry.event, entry.at)
  }
}

describe('stream accumulator', () => {
  it('publishes the first visible delta immediately and then resumes bounded coalescing', () => {
    const accumulator = createStreamAccumulator({ initialContent: [], now: 100 })

    applyStreamAccumulatorEvent(accumulator, { lane: 'text', text: 'a' }, 101)
    expect(shouldPublishStreamAccumulatorLive(accumulator, 101)).toBe(true)

    markStreamAccumulatorPublished(accumulator, 101)
    applyStreamAccumulatorEvent(accumulator, { lane: 'text', text: 'b' }, 102)
    expect(shouldPublishStreamAccumulatorLive(accumulator, 102)).toBe(false)
    expect(shouldPublishStreamAccumulatorLive(accumulator, 226)).toBe(true)
  })

  it('appends reasoning deltas exactly even when adjacent chunks repeat or overlap', () => {
    const accumulator = createStreamAccumulator({ initialContent: [], now: 0 })
    const repeated = 'abcabcabcabc'
    const overlapping = ['Lorem ipsum dolor sit amet', 'dolor sit amet, consectetur', 'etur']

    for (const textDelta of [repeated, repeated, ...overlapping]) {
      applyStreamAccumulatorEvent(
        accumulator,
        { lane: 'reasoning', textDelta, outputIndex: 0, itemId: 'reasoning-repeat' },
        1,
      )
    }
    for (const summaryDelta of ['sum', 'mary', 'mary']) {
      applyStreamAccumulatorEvent(
        accumulator,
        {
          lane: 'reasoning',
          summaryDelta,
          outputIndex: 0,
          itemId: 'reasoning-repeat',
          summaryIndex: 0,
        },
        1,
      )
    }

    expect(projectStreamAccumulatorFinal(accumulator).reasoningDetails).toEqual([
      {
        type: 'reasoning.text',
        id: 'text#reasoning-repeat',
        index: 0,
        text: `${repeated}${repeated}${overlapping.join('')}`,
      },
      {
        type: 'reasoning.summary',
        id: 'summary#reasoning-repeat#0',
        index: 0,
        summary: 'summarymary',
      },
    ])
  })

  it('appends structured reasoning-detail deltas exactly by stable index', () => {
    const accumulator = createStreamAccumulator({ initialContent: [], now: 0 })
    for (const text of ['ha', 'ha', 'prefix-tail', 'tail-next']) {
      applyStreamAccumulatorEvent(
        accumulator,
        {
          lane: 'reasoning',
          detailsMode: 'delta',
          details: [{ type: 'reasoning.text', index: 0, format: 'unknown', text }],
        },
        1,
      )
    }

    expect(projectStreamAccumulatorFinal(accumulator).reasoningDetails).toEqual([
      {
        type: 'reasoning.text',
        index: 0,
        format: 'unknown',
        text: 'hahaprefix-tailtail-next',
      },
    ])
  })

  it('keeps large incremental reasoning in bounded sections until projection', () => {
    const accumulator = createStreamAccumulator({ initialContent: [], now: 0 })
    const chunk = 'reasoning-'.repeat(16)
    const chunkCount = 1_000

    for (let index = 0; index < chunkCount; index += 1) {
      applyStreamAccumulatorEvent(
        accumulator,
        { lane: 'reasoning', textDelta: chunk, outputIndex: 0 },
        index + 1,
      )
    }

    expect(accumulator.reasoningList).toEqual([
      { type: 'reasoning.text', id: 'text#0', index: 0, text: '' },
    ])
    expect(accumulator.reasoningSegmentsByRow.get(0)?.sections.length).toBeGreaterThan(1)
    expect(streamAccumulatorReasoningLength(accumulator)).toBe(chunk.length * chunkCount)
    const liveReasoningRows = projectStreamAccumulatorLive(accumulator, {
      requestedModel: 'requested/model',
      apiUsed: 'chat',
      now: chunkCount,
    }).reasoningRows
    expect(liveReasoningRows).toHaveLength(1)
    const liveReasoningRow = liveReasoningRows?.[0]
    if (!liveReasoningRow) throw new Error('expected live reasoning row')
    expect(liveReasoningRow.detail).toEqual({
      type: 'reasoning.text',
      id: 'text#0',
      index: 0,
      text: '',
    })
    const valueSections = liveReasoningRow.valueSections
    if (!valueSections) throw new Error('expected live reasoning sections')
    expect(valueSections.length).toBeGreaterThan(0)
    expect(valueSections.every((section) => typeof section === 'string')).toBe(true)
    expect(projectStreamAccumulatorFinal(accumulator).reasoningDetails).toEqual([
      {
        type: 'reasoning.text',
        id: 'text#0',
        index: 0,
        text: chunk.repeat(chunkCount),
      },
    ])
  })

  it('replaces 100k cumulative Claude reasoning snapshots without replay or concatenation', () => {
    const accumulator = createStreamAccumulator({ initialContent: [], now: 0 })
    let cumulative = ''

    for (let index = 0; index < 100_000; index += 1) {
      cumulative += String(index % 10)
      applyStreamAccumulatorEvent(
        accumulator,
        {
          lane: 'reasoning',
          details: [
            {
              type: 'reasoning.text',
              index: 0,
              format: 'anthropic-claude-v1',
              text: cumulative,
            },
          ],
        },
        index + 1,
      )
    }
    applyStreamAccumulatorEvent(
      accumulator,
      {
        lane: 'reasoning',
        details: [
          {
            type: 'reasoning.text',
            index: 0,
            format: 'anthropic-claude-v1',
            signature: 'final-signature',
          },
        ],
      },
      100_001,
    )

    expect(accumulator.reasoningList).toHaveLength(1)
    expect(accumulator.reasoningSegmentsByRow.size).toBe(0)
    expect(streamAccumulatorReasoningLength(accumulator)).toBe(100_000)
    expect(projectStreamAccumulatorFinal(accumulator).reasoningDetails).toEqual([
      {
        type: 'reasoning.text',
        index: 0,
        format: 'anthropic-claude-v1',
        text: cumulative,
        signature: 'final-signature',
      },
    ])
  })

  it('converges a scalar Claude prefix into the later authoritative structured snapshot', () => {
    const accumulator = createStreamAccumulator({ initialContent: [], now: 0 })
    applyStreamAccumulatorEvent(
      accumulator,
      { lane: 'reasoning', textDelta: '1 ', outputIndex: 0 },
      1,
    )
    applyStreamAccumulatorEvent(
      accumulator,
      {
        lane: 'reasoning',
        detailsMode: 'cumulative',
        details: [
          {
            type: 'reasoning.text',
            index: 0,
            format: 'anthropic-claude-v1',
            text: '1 2 ',
          },
        ],
      },
      2,
    )

    expect(projectStreamAccumulatorFinal(accumulator).reasoningDetails).toEqual([
      {
        type: 'reasoning.text',
        id: 'text#0',
        index: 0,
        format: 'anthropic-claude-v1',
        text: '1 2 ',
      },
    ])
  })

  it('preserves non-prefix cumulative details instead of guessing from text overlap', () => {
    const accumulator = createStreamAccumulator({ initialContent: [], now: 0 })
    for (const [index, text] of ['base', 'tail', 'tailX'].entries()) {
      applyStreamAccumulatorEvent(
        accumulator,
        {
          lane: 'reasoning',
          detailsMode: 'cumulative',
          details: [
            {
              type: 'reasoning.text',
              id: 'reasoning-0',
              index: 0,
              format: 'unknown',
              text,
            },
          ],
        },
        index + 1,
      )
    }

    expect(projectStreamAccumulatorFinal(accumulator).reasoningDetails?.[0]).toMatchObject({
      text: 'basetailtailX',
    })
  })

  it('preserves an existing Claude prefix when a cumulative candidate is not authoritative', () => {
    const accumulator = createStreamAccumulator({ initialContent: [], now: 0 })
    applyStreamAccumulatorEvent(
      accumulator,
      {
        lane: 'reasoning',
        detailsMode: 'delta',
        details: [
          {
            type: 'reasoning.text',
            index: 0,
            format: 'anthropic-claude-v1',
            text: 'EARLY ',
          },
        ],
      },
      1,
    )
    applyStreamAccumulatorEvent(
      accumulator,
      {
        lane: 'reasoning',
        detailsMode: 'cumulative',
        details: [
          {
            type: 'reasoning.text',
            index: 0,
            format: 'anthropic-claude-v1',
            text: 'LATER tail',
          },
        ],
      },
      2,
    )

    expect(projectStreamAccumulatorFinal(accumulator).reasoningDetails?.[0]).toMatchObject({
      text: 'EARLY LATER tail',
    })
  })

  it('segments growing text for live projection and collapses it for final projection', () => {
    const initialContent: ContentItem[] = [
      { type: 'text', text: 'prefill-' },
      { type: 'output_text', text: 'continued-' },
      { type: 'image_url', url: 'data:image/png;base64,AA==' },
    ]
    const accumulator = createStreamAccumulator({ initialContent, now: 100 })
    const firstSection = 'a'.repeat(20_000)

    applyStreamAccumulatorEvent(accumulator, { lane: 'text', text: firstSection }, 101)
    applyStreamAccumulatorEvent(accumulator, { lane: 'text', text: 'b' }, 102)

    expect(accumulator.textSections).toEqual([firstSection])
    expect(accumulator.textPendingParts).toEqual(['b'])
    expect(accumulator.textPendingLength).toBe(1)
    expect(accumulator.textLength).toBe(20_001)
    expect(accumulator.firstTextAt).toBe(101)
    expect(streamAccumulatorText(accumulator)).toBe(`${firstSection}b`)
    expect(shouldPublishStreamAccumulatorLive(accumulator, 102)).toBe(true)

    expect(
      projectStreamAccumulatorLive(accumulator, {
        requestedModel: 'requested/model',
        apiUsed: 'responses',
        now: 102,
        generationStartedAt: 90,
      }),
    ).toEqual({
      content: [
        { type: 'output_text', text: `prefill-continued-${firstSection}` },
        { type: 'output_text', text: 'b' },
        { type: 'image_url', url: 'data:image/png;base64,AA==' },
      ],
      generation: {
        id: '',
        model: 'requested/model',
        requestedModel: 'requested/model',
        apiUsed: 'responses',
        delivery: 'streaming',
        status: 'streaming',
        integrity: 'clean',
        costSource: 'stream',
        startedAt: 90,
        firstTextAt: 101,
      },
      textLength: 20_001,
      reasoningLength: 0,
      updatedAt: 102,
    })

    markStreamAccumulatorPublished(accumulator, 102)
    expect(shouldPublishStreamAccumulatorLive(accumulator, 102)).toBe(false)
    applyStreamAccumulatorEvent(accumulator, { lane: 'text', text: 'c' }, 103)
    expect(shouldPublishStreamAccumulatorLive(accumulator, 103)).toBe(false)
    expect(shouldPublishStreamAccumulatorLive(accumulator, 227)).toBe(true)

    expect(projectStreamAccumulatorFinal(accumulator)).toEqual({
      content: [
        { type: 'output_text', text: `prefill-continued-${firstSection}bc` },
        { type: 'image_url', url: 'data:image/png;base64,AA==' },
      ],
    })
  })

  it('folds a mixed trace into stable reasoning, media, tools, provider state, and generation', () => {
    const accumulator = createStreamAccumulator({
      initialContent: [{ type: 'output_text', text: 'seed:' }],
      now: 1_000,
    })
    const usage = {
      prompt_tokens: 12,
      completion_tokens: 8,
      total_tokens: 20,
      cost: 0.004,
    } satisfies ChatUsage

    applyTrace(accumulator, [
      {
        event: {
          lane: 'meta',
          generationId: 'generation-1',
          model: 'served/model',
          provider: 'Provider A',
        },
        at: 1_001,
      },
      { event: { lane: 'text', text: 'answer' }, at: 1_002 },
      {
        event: {
          lane: 'reasoning',
          details: [
            {
              type: 'reasoning.text',
              id: 'legacy-reasoning',
              index: 0,
              format: 'openai-responses-v1',
              text: 'Legacy ',
            },
            { type: 'reasoning.text', id: 'tool_signature', text: 'ignored' },
          ],
        },
        at: 1_003,
      },
      {
        event: {
          lane: 'reasoning',
          details: [
            {
              type: 'reasoning.text',
              id: 'legacy-reasoning',
              index: 0,
              format: 'openai-responses-v1',
              text: 'detail',
            },
          ],
        },
        at: 1_004,
      },
      {
        event: { lane: 'reasoning', textDelta: 'think', outputIndex: 2, itemId: 'reasoning-2' },
        at: 1_005,
      },
      {
        event: { lane: 'reasoning', textDelta: 'ing', outputIndex: 2, itemId: 'reasoning-2' },
        at: 1_006,
      },
      {
        event: {
          lane: 'reasoning',
          summaryDelta: 'sum',
          outputIndex: 2,
          itemId: 'reasoning-2',
          summaryIndex: 1,
        },
        at: 1_007,
      },
      {
        event: {
          lane: 'reasoning',
          summaryDelta: 'mary',
          outputIndex: 2,
          itemId: 'reasoning-2',
          summaryIndex: 1,
        },
        at: 1_008,
      },
      {
        event: {
          lane: 'reasoning',
          encryptedDelta: 'provisional',
          outputIndex: 2,
          itemId: 'reasoning-2',
        },
        at: 1_009,
      },
      {
        event: {
          lane: 'reasoning',
          encryptedDelta: 'authoritative',
          replaceEncrypted: true,
          outputIndex: 2,
          itemId: 'reasoning-2',
        },
        at: 1_010,
      },
      {
        event: { lane: 'content-item', item: { type: 'output_image', url: 'image://one' } },
        at: 1_011,
      },
      {
        event: { lane: 'content-item', item: { type: 'output_video', url: 'video://one' } },
        at: 1_012,
      },
      {
        event: { lane: 'audio-output', format: 'mp3', dataDelta: 'QU', transcriptDelta: 'hel' },
        at: 1_013,
      },
      {
        event: { lane: 'audio-output', dataDelta: 'JD', transcriptDelta: 'lo' },
        at: 1_014,
      },
      {
        event: {
          lane: 'server-tool',
          itemType: 'web_search_call',
          itemId: 'search-1',
          outputIndex: 0,
          status: 'searching',
          partialImageB64: 'partial',
        },
        at: 1_015,
      },
      {
        event: {
          lane: 'output-item-done',
          outputIndex: 0,
          item: { type: 'web_search_call', id: 'search-1', status: 'completed', query: 'cats' },
        },
        at: 1_016,
      },
      {
        event: {
          lane: 'server-tool-output',
          itemType: 'google:code_execution',
          itemId: 'code-tool',
          outputIndex: 1,
          status: 'completed',
          output: { executableCode: { id: 'code-1', language: 'PYTHON', code: '1 + 1' } },
        },
        at: 1_017,
      },
      { event: { lane: 'phase', phase: 'final_answer', outputIndex: 0 }, at: 1_018 },
      { event: { lane: 'usage', usage }, at: 1_019 },
      { event: { lane: 'finish', finishReason: 'stop' }, at: 1_020 },
    ])

    const reasoningDetails = [
      {
        type: 'reasoning.text',
        id: 'legacy-reasoning',
        index: 0,
        format: 'openai-responses-v1',
        text: 'Legacy detail',
      },
      { type: 'reasoning.text', id: 'text#reasoning-2', index: 2, text: 'thinking' },
      {
        type: 'reasoning.summary',
        id: 'summary#reasoning-2#1',
        index: 2,
        summary: 'summary',
      },
      {
        type: 'reasoning.encrypted',
        id: 'encrypted#reasoning-2',
        index: 2,
        data: 'authoritative',
      },
    ]
    const providerOutputItems = [
      {
        dialect: 'openai-responses',
        type: 'web_search_call',
        outputIndex: 0,
        item: { type: 'web_search_call', id: 'search-1', status: 'completed', query: 'cats' },
      },
      {
        dialect: 'google-gemini',
        type: 'google:code_execution',
        outputIndex: 1,
        item: { executableCode: { id: 'code-1', language: 'PYTHON', code: '1 + 1' } },
      },
    ]

    expect(
      projectStreamAccumulatorLive(accumulator, {
        requestedModel: 'requested/model',
        apiUsed: 'responses',
        now: 1_020,
        generationStartedAt: 999,
      }),
    ).toEqual({
      content: [
        { type: 'output_text', text: 'seed:answer' },
        { type: 'output_image', url: 'image://one' },
      ],
      reasoningRows: [
        { detail: reasoningDetails[0] },
        {
          detail: { ...reasoningDetails[1], text: '' },
          valueSections: ['thinking'],
        },
        {
          detail: { ...reasoningDetails[2], summary: '' },
          valueSections: ['summary'],
        },
        {
          detail: { ...reasoningDetails[3], data: '' },
          valueSections: ['authoritative'],
        },
      ],
      generation: {
        id: 'generation-1',
        model: 'served/model',
        requestedModel: 'requested/model',
        provider: 'Provider A',
        apiUsed: 'responses',
        delivery: 'streaming',
        status: 'streaming',
        integrity: 'clean',
        usage,
        cost: 0.004,
        costSource: 'stream',
        startedAt: 999,
        firstTextAt: 1_002,
        reasoningStartedAt: 1_003,
        reasoningFinishedAt: 1_010,
        finishReason: 'stop',
        serverTools: [
          {
            type: 'web_search_call',
            source: 'responses-output',
            id: 'search-1',
            status: 'completed',
            outputIndex: 0,
            output: {
              type: 'web_search_call',
              id: 'search-1',
              status: 'completed',
              query: 'cats',
            },
          },
          {
            type: 'google:code_execution',
            source: 'provider-output',
            id: 'code-tool',
            status: 'completed',
            outputIndex: 1,
            output: { executableCode: { id: 'code-1', language: 'PYTHON', code: '1 + 1' } },
          },
        ],
      },
      textLength: 6,
      reasoningLength: 41,
      updatedAt: 1_020,
    })

    expect(projectStreamAccumulatorFinal(accumulator)).toEqual({
      content: [
        { type: 'output_text', text: 'seed:answer' },
        { type: 'output_image', url: 'image://one' },
        { type: 'output_video', url: 'video://one' },
        {
          type: 'audio_output',
          format: 'mp3',
          transcript: 'hello',
          url: 'data:audio/mp3;base64,QUJD',
        },
      ],
      reasoningDetails,
      phase: 'final_answer',
      providerOutputItems,
    })
    expect(streamAccumulatorReasoningLength(accumulator)).toBe(41)
    expect(streamAccumulatorHasCompletionCalibrationBlockers(accumulator)).toBe(true)

    expect(
      projectStreamGeneration(undefined, accumulator, 'requested/model', {
        apiUsed: 'responses',
        startedAt: 999,
        finishedAt: 1_100,
      }),
    ).toMatchObject({ finishedAt: 1_100, finishReason: 'stop' })
  })

  it('bounds and aggregates integrity events without changing valid output', () => {
    const baseline = createStreamAccumulator({ initialContent: [], now: 0 })
    const observed = createStreamAccumulator({ initialContent: [], now: 0 })
    const validTrace = [
      { event: { lane: 'text', text: 'answer' } satisfies StreamLaneEvent, at: 1 },
      {
        event: {
          lane: 'reasoning',
          summaryDelta: 'summary',
          summaryIndex: 0,
        } satisfies StreamLaneEvent,
        at: 2,
      },
      { event: { lane: 'finish', finishReason: 'stop' } satisfies StreamLaneEvent, at: 3 },
    ]
    applyTrace(baseline, validTrace)
    applyTrace(observed, validTrace)

    for (let index = 0; index < 3; index += 1) {
      applyStreamAccumulatorEvent(
        observed,
        {
          lane: 'integrity',
          integrity: {
            category: 'malformed-json-frame',
            adapter: 'responses',
            eventType: 'response.output_text.delta',
            count: 1,
            fingerprint: 'fnv1a32:repeated',
            characterCount: 11,
          },
        },
        4 + index,
      )
    }
    for (let index = 0; index < 20; index += 1) {
      applyStreamAccumulatorEvent(
        observed,
        {
          lane: 'integrity',
          integrity: {
            category: 'malformed-json-frame',
            adapter: 'chat-completions',
            eventType: 'message',
            count: 1,
            fingerprint: `fnv1a32:${index.toString(16).padStart(8, '0')}`,
            characterCount: index + 1,
          },
        },
        10 + index,
      )
    }

    expect(projectStreamAccumulatorFinal(observed)).toEqual(projectStreamAccumulatorFinal(baseline))
    expect(observed.integritySummary).toMatchObject({
      count: 23,
      characterCount: 243,
    })
    expect(observed.integritySummary.entries).toHaveLength(16)
    expect(observed.integritySummary.entries[0]).toEqual({
      category: 'malformed-json-frame',
      adapter: 'responses',
      eventType: 'response.output_text.delta',
      count: 3,
      fingerprint: 'fnv1a32:repeated',
      characterCount: 33,
    })
  })

  it('replays durable events, derives usage-only tools, and releases only owned buffers', () => {
    const error = new ApiError({
      kind: 'provider_error',
      code: 'STREAM_FAILED',
      message: 'stream failed',
      midStream: true,
      retryable: true,
    })
    const usage = {
      prompt_tokens: 5,
      completion_tokens: 3,
      total_tokens: 8,
      server_tool_use: {
        web_search_requests: 2,
        web_fetch_requests: 0,
        custom_requests: 1,
      },
    } satisfies ChatUsage
    const replayed = replayStreamAccumulator({
      initialContent: [{ type: 'text', text: 'before-' }],
      now: 10,
      entries: [
        { event: null, createdAt: 10 },
        { event: { lane: 'unknown' }, createdAt: 10 },
        { event: { lane: 'meta', generationId: 'generation-replayed' }, createdAt: 11 },
        { event: { lane: 'text', text: 'after' }, createdAt: 12 },
        { event: { lane: 'reasoning', textDelta: 'thought' }, createdAt: 13 },
        { event: { lane: 'phase', phase: 'commentary', outputIndex: 0 }, createdAt: 14 },
        { event: { lane: 'phase', phase: null, outputIndex: 0 }, createdAt: 15 },
        { event: { lane: 'keepalive', comment: 'ping' }, createdAt: 16 },
        { event: { lane: 'tool-call', index: 0, argumentsDelta: '{}' }, createdAt: 17 },
        { event: { lane: 'usage', usage }, createdAt: 18 },
        { event: { lane: 'finish', finishReason: 'stop' }, createdAt: 19 },
        { event: { lane: 'error', error }, createdAt: 20 },
      ],
    })

    expect(replayed.finishedCleanly).toBe(true)
    expect(replayed.final).toEqual({
      content: [{ type: 'output_text', text: 'before-after' }],
      reasoningDetails: [{ type: 'reasoning.text', id: 'text#default', index: 0, text: 'thought' }],
      providerOutputItems: [
        {
          dialect: 'unknown',
          type: 'incomplete_function_call',
          outputIndex: 0,
          hidden: true,
          item: {
            type: 'incomplete_function_call',
            index: 0,
            arguments: '{}',
          },
        },
      ],
    })
    expect(replayed.accumulator.midStreamError).toBe(error)
    expect(
      projectStreamGeneration(undefined, replayed.accumulator, 'requested/model', {
        startedAt: 9,
      }),
    ).toEqual({
      id: 'generation-replayed',
      model: 'requested/model',
      requestedModel: 'requested/model',
      apiUsed: 'chat',
      delivery: 'streaming',
      status: 'streaming',
      integrity: 'clean',
      usage,
      costSource: 'stream',
      startedAt: 9,
      firstTextAt: 12,
      reasoningStartedAt: 13,
      reasoningFinishedAt: 13,
      finishReason: 'stop',
      serverTools: [
        {
          type: 'openrouter:web_search',
          source: 'usage',
          status: 'completed',
          requestCount: 2,
          output: { web_search_requests: 2 },
        },
        {
          type: 'custom_requests',
          source: 'usage',
          status: 'completed',
          requestCount: 1,
          output: { custom_requests: 1 },
        },
      ],
    })

    releaseStreamAccumulatorBuffers(replayed.accumulator)
    expect(replayed.accumulator).toMatchObject({
      initialContent: [],
      textSections: [],
      textLength: 0,
      reasoningList: [],
      toolCallRows: [],
      toolCallArgumentsLength: 0,
      generatedContent: [],
      serverTools: [],
      providerOutputItems: [],
      integritySummary: { count: 0, characterCount: 0, entries: [] },
      generationId: 'generation-replayed',
      finishReason: 'stop',
      usage,
      firstTextAt: 12,
      reasoningStartedAt: 13,
      reasoningFinishedAt: 13,
      midStreamError: error,
    })
    expect(replayed.accumulator.reasoningRowById.size).toBe(0)
    expect(replayed.accumulator.audioOutput).toBeUndefined()
  })

  it('merges interleaved tool-call rows by index and id and prefers authoritative arguments', () => {
    const accumulator = createStreamAccumulator({ initialContent: [], now: 0 })
    applyStreamAccumulatorEvent(
      accumulator,
      { lane: 'tool-call', index: 1, type: 'function', argumentsDelta: '{"second":' },
      1,
    )
    applyStreamAccumulatorEvent(
      accumulator,
      {
        lane: 'tool-call',
        index: 0,
        id: 'call-first',
        type: 'function',
        name: 'first',
        argumentsDelta: '{"stale":true}',
      },
      2,
    )
    applyStreamAccumulatorEvent(
      accumulator,
      { lane: 'tool-call', index: 1, id: 'call-second', name: 'second' },
      3,
    )
    applyStreamAccumulatorEvent(
      accumulator,
      { lane: 'tool-call', index: 1, argumentsDelta: '2}' },
      4,
    )
    applyStreamAccumulatorEvent(
      accumulator,
      {
        lane: 'tool-call',
        index: 0,
        id: 'call-first',
        type: 'function',
        name: 'first',
        argumentsSnapshot: '{"canonical":true}',
      },
      5,
    )

    expect(projectStreamAccumulatorFinal(accumulator).toolCalls).toEqual([
      {
        id: 'call-first',
        type: 'function',
        function: { name: 'first', arguments: '{"canonical":true}' },
      },
      {
        id: 'call-second',
        type: 'function',
        function: { name: 'second', arguments: '{"second":2}' },
      },
    ])
    expect(
      projectStreamAccumulatorLive(accumulator, {
        requestedModel: 'model',
        apiUsed: 'chat',
        now: 6,
      }).toolCallRows,
    ).toEqual([
      {
        index: 1,
        id: 'call-second',
        type: 'function',
        name: 'second',
        argumentSections: [],
        pendingArguments: '{"second":2}',
        argumentLength: 12,
      },
      {
        index: 0,
        id: 'call-first',
        type: 'function',
        name: 'first',
        argumentSections: [],
        pendingArguments: '{"canonical":true}',
        argumentLength: 18,
      },
    ])
  })

  it('keeps a million-character tool argument segmented until final projection', () => {
    const accumulator = createStreamAccumulator({ initialContent: [], now: 0 })
    const fragment = 'argument-fragment-'.repeat(8)
    const chunks = 8_000
    applyStreamAccumulatorEvent(
      accumulator,
      { lane: 'tool-call', index: 0, id: 'call-long', type: 'function', name: 'long_call' },
      1,
    )
    for (let index = 0; index < chunks; index += 1) {
      applyStreamAccumulatorEvent(
        accumulator,
        { lane: 'tool-call', index: 0, argumentsDelta: fragment },
        index + 2,
      )
    }

    const expectedLength = fragment.length * chunks
    const buffer = accumulator.toolCallArgumentsByRow.get(0)
    expect(expectedLength).toBeGreaterThan(1_000_000)
    expect(buffer?.length).toBe(expectedLength)
    expect(buffer?.sections.length).toBeGreaterThan(1)
    expect(buffer?.sections.every((section) => section.length === 20_000)).toBe(true)
    expect(buffer?.pendingLength).toBeLessThan(20_000)
    expect(accumulator.toolCallRows[0]).not.toHaveProperty('arguments')

    const call = projectStreamAccumulatorFinal(accumulator).toolCalls?.[0]
    expect(call?.function.arguments.length).toBe(expectedLength)
    expect(call?.function.arguments).toBe(fragment.repeat(chunks))
  })

  it('replays chat [DONE] terminal evidence as clean without inventing a finish reason', () => {
    const replayed = replayStreamAccumulator({
      initialContent: [],
      now: 10,
      entries: [
        { event: { lane: 'text', text: 'complete' }, createdAt: 11 },
        { event: { lane: 'terminal', evidence: 'done-sentinel' }, createdAt: 12 },
      ],
    })

    expect(replayed.finishedCleanly).toBe(true)
    expect(replayed.accumulator.finishReason).toBeUndefined()
    expect(replayed.final.content).toEqual([{ type: 'output_text', text: 'complete' }])
  })

  it('wraps PCM16 output in a deterministic WAV container', () => {
    const accumulator = createStreamAccumulator({ initialContent: [], now: 0 })
    applyStreamAccumulatorEvent(
      accumulator,
      { lane: 'audio-output', format: 'pcm16', dataDelta: 'AAA=', transcriptDelta: 'silence' },
      1,
    )

    expect(projectStreamAccumulatorFinal(accumulator)).toEqual({
      content: [
        { type: 'output_text', text: '' },
        {
          type: 'audio_output',
          format: 'pcm16',
          transcript: 'silence',
          url: 'data:audio/wav;base64,UklGRiYAAABXQVZFZm10IBAAAAABAAEAwF0AAIC7AAACABAAZGF0YQIAAAAAAA==',
        },
      ],
    })
  })

  it('keeps a large audio transcript fragmented until final projection', () => {
    const accumulator = createStreamAccumulator({ initialContent: [], now: 0 })
    const fragment = 'audio words '
    for (let index = 0; index < 10_000; index += 1) {
      applyStreamAccumulatorEvent(
        accumulator,
        { lane: 'audio-output', transcriptDelta: fragment },
        1,
      )
    }

    expect(accumulator.audioOutput?.transcriptLength).toBe(fragment.length * 10_000)
    expect(accumulator.audioOutput?.transcriptSections.length).toBeGreaterThan(1)
    expect(accumulator.audioOutput?.transcriptSections.every((part) => part.length <= 20_000)).toBe(
      true,
    )
    expect(projectStreamAccumulatorFinal(accumulator).content).toContainEqual({
      type: 'audio_output',
      format: 'pcm16',
      transcript: fragment.repeat(10_000),
    })
  })
})
