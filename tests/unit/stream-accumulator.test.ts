import { describe, expect, it } from 'vitest'
import { ApiError } from '../../src/api/errors'
import type { StreamLaneEvent } from '../../src/core/generation-stream-live-events'
import { inspectReasoningEnvelopeState } from '../../src/core/reasoning-envelope'
import {
  type ReasoningObservation,
  reasoningObservationsFromDetails,
} from '../../src/core/reasoning-observation'
import {
  createStreamAccumulator,
  foldStreamAccumulatorEvent,
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
import type { ChatUsage, ContentItem, ReasoningDetail, ReasoningFormat } from '../../src/core/types'

const applyStreamAccumulatorEvent = foldStreamAccumulatorEvent

function reasoningEvent(
  observations: readonly ReasoningObservation[],
): Extract<StreamLaneEvent, { lane: 'reasoning-observation' }> {
  return {
    lane: 'reasoning-observation',
    batch: { observations },
  }
}

function detailReasoningEvent(
  details: readonly ReasoningDetail[],
  mode: 'delta' | 'snapshot' | 'cumulative' = 'delta',
  source: Readonly<{ outputIndex?: number; itemId?: string }> = {},
): Extract<StreamLaneEvent, { lane: 'reasoning-observation' }> {
  return reasoningEvent(
    reasoningObservationsFromDetails({
      details,
      mode,
      dialect: 'openrouter-chat',
      bridge: 'openrouter',
      untypedVisibleKind: 'text',
      source,
    }),
  )
}

function responsesVisibleObservation(input: {
  value: string
  visibleKind: 'text' | 'summary'
  update?: 'append' | 'append-overlap' | 'append-section' | 'set' | 'cumulative'
  outputIndex?: number
  itemId?: string
  memberIndex?: number
  format?: ReasoningFormat
}): Extract<ReasoningObservation, { kind: 'visible' }> {
  const outputIndex = input.outputIndex ?? 0
  const member =
    input.visibleKind === 'summary'
      ? (`summary:${input.memberIndex ?? 0}` as const)
      : (`content:${input.memberIndex ?? 0}` as const)
  return {
    kind: 'visible',
    visibleKind: input.visibleKind,
    update: input.update ?? 'append',
    value: input.value,
    format: input.format ?? 'unknown',
    source: {
      dialect: 'openrouter-responses',
      bridge: 'openrouter',
      outputIndex,
      ...(input.itemId ? { itemId: input.itemId } : {}),
      ...(input.visibleKind === 'summary' ? { summaryIndex: input.memberIndex ?? 0 } : {}),
      ...(input.visibleKind === 'text' ? { contentIndex: input.memberIndex ?? 0 } : {}),
    },
    groupAliases: [
      ...(input.itemId ? [{ kind: 'responses-item' as const, itemId: input.itemId }] : []),
      { kind: 'responses-output', outputIndex },
    ],
    memberAliases: [
      {
        kind: 'responses-member',
        outputIndex,
        ...(input.itemId ? { itemId: input.itemId } : {}),
        member,
      },
    ],
  }
}

function responsesCarrierObservation(input: {
  value: string
  update: 'append' | 'set' | 'cumulative'
  outputIndex?: number
  itemId?: string
}): Extract<ReasoningObservation, { kind: 'carrier' }> {
  const outputIndex = input.outputIndex ?? 0
  return {
    kind: 'carrier',
    carrierKind: 'responses-encrypted',
    update: input.update,
    value: input.value,
    format: 'openai-responses-v1',
    source: {
      dialect: 'openrouter-responses',
      bridge: 'openrouter',
      outputIndex,
      ...(input.itemId ? { itemId: input.itemId } : {}),
    },
    groupAliases: [
      ...(input.itemId ? [{ kind: 'responses-item' as const, itemId: input.itemId }] : []),
      { kind: 'responses-output', outputIndex },
    ],
    memberAliases: [
      {
        kind: 'responses-member',
        outputIndex,
        ...(input.itemId ? { itemId: input.itemId } : {}),
        member: 'encrypted',
      },
    ],
  }
}

function applyTrace(
  accumulator: ReturnType<typeof createStreamAccumulator>,
  trace: ReadonlyArray<{ event: StreamLaneEvent; at: number }>,
): void {
  for (const entry of trace) {
    foldStreamAccumulatorEvent(accumulator, entry.event, entry.at)
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
        reasoningEvent([
          responsesVisibleObservation({
            value: textDelta,
            visibleKind: 'text',
            outputIndex: 0,
            itemId: 'reasoning-repeat',
          }),
        ]),
        1,
      )
    }
    for (const summaryDelta of ['sum', 'mary', 'mary']) {
      applyStreamAccumulatorEvent(
        accumulator,
        reasoningEvent([
          responsesVisibleObservation({
            value: summaryDelta,
            visibleKind: 'summary',
            outputIndex: 0,
            itemId: 'reasoning-repeat',
            memberIndex: 0,
          }),
        ]),
        1,
      )
    }

    expect(projectStreamAccumulatorFinal(accumulator).reasoningEnvelope?.visible).toEqual([
      expect.objectContaining({
        kind: 'text',
        text: `${repeated}${repeated}${overlapping.join('')}`,
      }),
      expect.objectContaining({ kind: 'summary', text: 'summarymary' }),
    ])
  })

  it('appends structured reasoning-detail deltas exactly by stable index', () => {
    const accumulator = createStreamAccumulator({ initialContent: [], now: 0 })
    for (const text of ['ha', 'ha', 'prefix-tail', 'tail-next']) {
      applyStreamAccumulatorEvent(
        accumulator,
        detailReasoningEvent(
          [{ type: 'reasoning.text', index: 0, format: 'unknown', text }],
          'delta',
        ),
        1,
      )
    }

    expect(projectStreamAccumulatorFinal(accumulator).reasoningEnvelope?.visible).toEqual([
      expect.objectContaining({
        kind: 'text',
        format: 'unknown',
        text: 'hahaprefix-tailtail-next',
      }),
    ])
  })

  it('keeps large incremental reasoning in bounded sections until projection', () => {
    const accumulator = createStreamAccumulator({ initialContent: [], now: 0 })
    const chunk = 'reasoning-'.repeat(16)
    const chunkCount = 1_000

    for (let index = 0; index < chunkCount; index += 1) {
      applyStreamAccumulatorEvent(
        accumulator,
        reasoningEvent([
          responsesVisibleObservation({ value: chunk, visibleKind: 'text', outputIndex: 0 }),
        ]),
        index + 1,
      )
    }

    const inspected = inspectReasoningEnvelopeState(accumulator.reasoning.envelope)
    expect(inspected.visibleParts).toBe(1)
    expect(inspected.retainedTextSegments).toBeLessThanOrEqual(Math.ceil(Math.log2(chunkCount)) + 1)
    expect(streamAccumulatorReasoningLength(accumulator)).toBe(chunk.length * chunkCount)
    const liveReasoningRows = projectStreamAccumulatorLive(accumulator, {
      requestedModel: 'requested/model',
      apiUsed: 'chat',
      now: chunkCount,
    }).reasoning?.visible
    expect(liveReasoningRows).toHaveLength(1)
    if (!liveReasoningRows) throw new Error('expected live reasoning rows')
    const liveReasoningRow = liveReasoningRows[0]
    if (!liveReasoningRow) throw new Error('expected live reasoning row')
    expect(liveReasoningRow.part).toMatchObject({ kind: 'text', format: 'unknown' })
    const valueSections = liveReasoningRow.valueSections
    expect(valueSections.length).toBeGreaterThan(0)
    expect(valueSections.every((section) => typeof section === 'string')).toBe(true)
    expect(projectStreamAccumulatorFinal(accumulator).reasoningEnvelope?.visible).toEqual([
      expect.objectContaining({ kind: 'text', text: chunk.repeat(chunkCount) }),
    ])
  })

  it('replaces 100k cumulative Claude reasoning snapshots without replay or concatenation', () => {
    const accumulator = createStreamAccumulator({ initialContent: [], now: 0 })
    let cumulative = ''

    for (let index = 0; index < 100_000; index += 1) {
      cumulative += String(index % 10)
      applyStreamAccumulatorEvent(
        accumulator,
        detailReasoningEvent(
          [
            {
              type: 'reasoning.text',
              index: 0,
              format: 'anthropic-claude-v1',
              text: cumulative,
            },
          ],
          'snapshot',
        ),
        index + 1,
      )
    }
    applyStreamAccumulatorEvent(
      accumulator,
      detailReasoningEvent(
        [
          {
            type: 'reasoning.text',
            index: 0,
            format: 'anthropic-claude-v1',
            signature: 'final-signature',
          },
        ],
        'snapshot',
      ),
      100_001,
    )

    const inspected = inspectReasoningEnvelopeState(accumulator.reasoning.envelope)
    expect(inspected.visibleParts).toBe(1)
    expect(inspected.carriers).toBe(1)
    expect(inspected.retainedTextSegments).toBe(1)
    expect(streamAccumulatorReasoningLength(accumulator)).toBe(100_000 + 'final-signature'.length)
    const envelope = projectStreamAccumulatorFinal(accumulator).reasoningEnvelope
    expect(envelope?.visible).toEqual([
      expect.objectContaining({
        kind: 'text',
        format: 'anthropic-claude-v1',
        text: cumulative,
      }),
    ])
    expect(envelope?.carriers).toEqual([
      expect.objectContaining({
        kind: 'anthropic-signature',
        format: 'anthropic-claude-v1',
        signature: 'final-signature',
        bindsVisiblePartId: envelope?.visible[0]?.id,
      }),
    ])
  })

  it('converges a scalar Claude prefix into the later authoritative structured snapshot', () => {
    const accumulator = createStreamAccumulator({ initialContent: [], now: 0 })
    applyStreamAccumulatorEvent(
      accumulator,
      reasoningEvent([
        {
          kind: 'visible',
          visibleKind: 'text',
          update: 'append',
          value: '1 ',
          format: 'unknown',
          source: { dialect: 'openrouter-chat', bridge: 'openrouter', choiceIndex: 0 },
          groupAliases: [{ kind: 'chat-choice', choiceIndex: 0, memberKind: 'text' }],
          memberAliases: [{ kind: 'chat-scalar', choiceIndex: 0, visibleKind: 'text' }],
        },
      ]),
      1,
    )
    const [structured] = reasoningObservationsFromDetails({
      details: [
        {
          type: 'reasoning.text',
          index: 0,
          format: 'anthropic-claude-v1',
          text: '1 2 ',
        },
      ],
      mode: 'cumulative',
      dialect: 'openrouter-chat',
      bridge: 'openrouter',
      untypedVisibleKind: 'text',
      source: { choiceIndex: 0 },
    })
    if (!structured || structured.kind !== 'visible') {
      throw new Error('expected structured visible reasoning observation')
    }
    applyStreamAccumulatorEvent(
      accumulator,
      reasoningEvent([
        {
          ...structured,
          update: 'append-overlap',
          groupAliases: [
            { kind: 'chat-choice', choiceIndex: 0, memberKind: 'text' },
            ...structured.groupAliases,
          ],
          memberAliases: [
            { kind: 'chat-scalar', choiceIndex: 0, visibleKind: 'text' },
            ...structured.memberAliases,
          ],
        },
      ]),
      2,
    )

    expect(projectStreamAccumulatorFinal(accumulator).reasoningEnvelope?.visible).toEqual([
      expect.objectContaining({
        kind: 'text',
        format: 'anthropic-claude-v1',
        text: '1 2 ',
      }),
    ])
  })

  it('replaces non-prefix cumulative details instead of treating snapshots as deltas', () => {
    const accumulator = createStreamAccumulator({ initialContent: [], now: 0 })
    for (const [index, text] of ['base', 'tail', 'tailX'].entries()) {
      applyStreamAccumulatorEvent(
        accumulator,
        detailReasoningEvent(
          [
            {
              type: 'reasoning.text',
              id: 'reasoning-0',
              index: 0,
              format: 'unknown',
              text,
            },
          ],
          'cumulative',
        ),
        index + 1,
      )
    }

    expect(projectStreamAccumulatorFinal(accumulator).reasoningEnvelope?.visible[0]).toMatchObject({
      text: 'tailX',
    })
  })

  it('replaces an existing Claude prefix when a cumulative candidate is authoritative', () => {
    const accumulator = createStreamAccumulator({ initialContent: [], now: 0 })
    applyStreamAccumulatorEvent(
      accumulator,
      detailReasoningEvent(
        [
          {
            type: 'reasoning.text',
            index: 0,
            format: 'anthropic-claude-v1',
            text: 'EARLY ',
          },
        ],
        'delta',
      ),
      1,
    )
    applyStreamAccumulatorEvent(
      accumulator,
      detailReasoningEvent(
        [
          {
            type: 'reasoning.text',
            index: 0,
            format: 'anthropic-claude-v1',
            text: 'LATER tail',
          },
        ],
        'cumulative',
      ),
      2,
    )

    expect(projectStreamAccumulatorFinal(accumulator).reasoningEnvelope?.visible[0]).toMatchObject({
      text: 'LATER tail',
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
        { type: 'output_text', text: 'prefill-continued-' },
        { type: 'output_text', text: firstSection },
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
        reasoningCarryForward: 'none',
        reasoningVisibility: { disclosure: 'unknown' },
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

  it('bounds cumulative text and reasoning live-projection visits logarithmically', () => {
    const accumulator = createStreamAccumulator({ initialContent: [], now: 0 })
    const section = 'x'.repeat(20_000)
    const sectionCount = 64
    const perProjectionBudget = Math.floor(Math.log2(sectionCount)) + 1
    let textSectionVisits = 0
    let reasoningSectionVisits = 0

    for (let index = 0; index < sectionCount; index += 1) {
      applyStreamAccumulatorEvent(accumulator, { lane: 'text', text: section }, index + 1)
      applyStreamAccumulatorEvent(
        accumulator,
        reasoningEvent([
          responsesVisibleObservation({ value: section, visibleKind: 'text', outputIndex: 0 }),
        ]),
        index + 1,
      )
      const live = projectStreamAccumulatorLive(accumulator, {
        requestedModel: 'requested/model',
        apiUsed: 'chat',
        now: index + 1,
      })
      const textItems = live.content.filter(
        (item) => item.type === 'text' || item.type === 'output_text',
      )
      const reasoningSections = live.reasoning?.visible[0]?.valueSections ?? []
      expect(textItems.length).toBeLessThanOrEqual(perProjectionBudget)
      expect(reasoningSections.length).toBeLessThanOrEqual(perProjectionBudget)
      textSectionVisits += textItems.length
      reasoningSectionVisits += reasoningSections.length
    }

    const cumulativeVisitBudget = sectionCount * perProjectionBudget
    expect(textSectionVisits).toBeLessThanOrEqual(cumulativeVisitBudget)
    expect(reasoningSectionVisits).toBeLessThanOrEqual(cumulativeVisitBudget)
    expect(streamAccumulatorText(accumulator)).toBe(section.repeat(sectionCount))
    expect(projectStreamAccumulatorFinal(accumulator).reasoningEnvelope?.visible[0]).toMatchObject({
      text: section.repeat(sectionCount),
    })
  })

  it('keeps published tool-argument sections immutable across geometric merges', () => {
    const accumulator = createStreamAccumulator({ initialContent: [], now: 0 })
    const firstSection = 'a'.repeat(20_000)
    const secondSection = 'b'.repeat(20_000)
    applyStreamAccumulatorEvent(
      accumulator,
      {
        lane: 'tool-call',
        index: 0,
        id: 'call-0',
        type: 'function',
        name: 'tool',
        argumentsDelta: firstSection,
      },
      1,
    )
    const published = projectStreamAccumulatorLive(accumulator, {
      requestedModel: 'requested/model',
      apiUsed: 'chat',
      now: 1,
    })
    const publishedSections = published.toolCallRows?.[0]?.argumentSections

    applyStreamAccumulatorEvent(
      accumulator,
      { lane: 'tool-call', index: 0, argumentsDelta: secondSection },
      2,
    )

    expect(publishedSections).toEqual([firstSection])
    expect(
      projectStreamAccumulatorLive(accumulator, {
        requestedModel: 'requested/model',
        apiUsed: 'chat',
        now: 2,
      }).toolCallRows?.[0]?.argumentSections,
    ).toEqual([firstSection + secondSection])
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
        event: detailReasoningEvent([
          {
            type: 'reasoning.text',
            id: 'legacy-reasoning',
            index: 0,
            format: 'openai-responses-v1',
            text: 'Legacy ',
          },
          {
            type: 'reasoning.text',
            id: 'tool_signature',
            format: 'openai-responses-v1',
            text: 'ignored',
          },
        ]),
        at: 1_003,
      },
      {
        event: detailReasoningEvent([
          {
            type: 'reasoning.text',
            id: 'legacy-reasoning',
            index: 0,
            format: 'openai-responses-v1',
            text: 'detail',
          },
        ]),
        at: 1_004,
      },
      {
        event: reasoningEvent([
          responsesVisibleObservation({
            value: 'think',
            visibleKind: 'text',
            outputIndex: 2,
            itemId: 'reasoning-2',
          }),
        ]),
        at: 1_005,
      },
      {
        event: reasoningEvent([
          responsesVisibleObservation({
            value: 'ing',
            visibleKind: 'text',
            outputIndex: 2,
            itemId: 'reasoning-2',
          }),
        ]),
        at: 1_006,
      },
      {
        event: reasoningEvent([
          responsesVisibleObservation({
            value: 'sum',
            visibleKind: 'summary',
            outputIndex: 2,
            itemId: 'reasoning-2',
            memberIndex: 1,
          }),
        ]),
        at: 1_007,
      },
      {
        event: reasoningEvent([
          responsesVisibleObservation({
            value: 'mary',
            visibleKind: 'summary',
            outputIndex: 2,
            itemId: 'reasoning-2',
            memberIndex: 1,
          }),
        ]),
        at: 1_008,
      },
      {
        event: reasoningEvent([
          responsesCarrierObservation({
            value: 'provisional',
            update: 'append',
            outputIndex: 2,
            itemId: 'reasoning-2',
          }),
        ]),
        at: 1_009,
      },
      {
        event: reasoningEvent([
          responsesCarrierObservation({
            value: 'authoritative',
            update: 'set',
            outputIndex: 2,
            itemId: 'reasoning-2',
          }),
        ]),
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
          dialect: 'openai-responses',
          outputIndex: 0,
          item: { type: 'web_search_call', id: 'search-1', status: 'completed', query: 'cats' },
        },
        at: 1_016,
      },
      {
        event: {
          lane: 'server-tool-output',
          dialect: 'google-gemini',
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

    const live = projectStreamAccumulatorLive(accumulator, {
      requestedModel: 'requested/model',
      apiUsed: 'responses',
      now: 1_020,
      generationStartedAt: 999,
    })
    expect(live).toMatchObject({
      content: [
        { type: 'output_text', text: 'seed:' },
        { type: 'output_text', text: 'answer' },
        { type: 'output_image', url: 'image://one' },
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
        reasoningCarryForward: 'none',
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
          },
          {
            type: 'google:code_execution',
            source: 'provider-output',
            id: 'code-tool',
            status: 'completed',
            outputIndex: 1,
          },
        ],
      },
      textLength: 6,
      reasoningLength: 41,
      updatedAt: 1_020,
    })
    expect(
      live.reasoning?.visible.map((row) => ({
        kind: row.part.kind,
        value: [...row.valueSections, row.pendingValue ?? ''].join(''),
      })),
    ).toEqual([
      { kind: 'text', value: 'Legacy detail' },
      { kind: 'text', value: 'thinking' },
      { kind: 'summary', value: 'summary' },
    ])
    expect(live.reasoning?.carriers).toEqual([
      expect.objectContaining({ valueLength: 'authoritative'.length }),
    ])

    const final = projectStreamAccumulatorFinal(accumulator)
    expect(final).toMatchObject({
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
      phase: 'final_answer',
      providerOutputItems,
    })
    expect(final.reasoningEnvelope?.visible).toEqual([
      expect.objectContaining({ kind: 'text', text: 'Legacy detail' }),
      expect.objectContaining({ kind: 'text', text: 'thinking' }),
      expect.objectContaining({ kind: 'summary', text: 'summary' }),
    ])
    expect(final.reasoningEnvelope?.carriers).toEqual([
      expect.objectContaining({ kind: 'responses-encrypted', data: 'authoritative' }),
    ])
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
        event: reasoningEvent([
          responsesVisibleObservation({
            value: 'summary',
            visibleKind: 'summary',
            memberIndex: 0,
          }),
        ]),
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
    const canonicalReasoning = foldStreamAccumulatorEvent(
      createStreamAccumulator({ initialContent: [], now: 13 }),
      reasoningEvent([responsesVisibleObservation({ value: 'thought', visibleKind: 'text' })]),
      13,
    )
    const replayed = replayStreamAccumulator({
      initialContent: [{ type: 'text', text: 'before-' }],
      now: 10,
      entries: [
        { event: { lane: 'meta', generationId: 'generation-replayed' }, createdAt: 11 },
        { event: { lane: 'text', text: 'after' }, createdAt: 12 },
        { event: canonicalReasoning, createdAt: 13 },
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
    expect(replayed.final).toMatchObject({
      content: [{ type: 'output_text', text: 'before-after' }],
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
    expect(replayed.final.reasoningEnvelope?.visible).toEqual([
      expect.objectContaining({ kind: 'text', text: 'thought' }),
    ])
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
      reasoningCarryForward: 'none',
      reasoningVisibility: { disclosure: 'unknown' },
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
        },
        {
          type: 'custom_requests',
          source: 'usage',
          status: 'completed',
          requestCount: 1,
        },
      ],
    })

    releaseStreamAccumulatorBuffers(replayed.accumulator)
    expect(replayed.accumulator).toMatchObject({
      initialContent: [],
      textSections: [],
      textLength: 0,
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
    expect(inspectReasoningEnvelopeState(replayed.accumulator.reasoning.envelope)).toEqual({
      visibleParts: 0,
      carriers: 0,
      visibleTextLength: 0,
      carrierByteLength: 0,
      retainedTextSegments: 0,
      retainedCarrierSegments: 0,
    })
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
    expect(buffer?.sections.length).toBeLessThanOrEqual(
      Math.floor(Math.log2(Math.ceil(expectedLength / 20_000))) + 1,
    )
    expect(buffer?.sections.every((section) => section.length % 20_000 === 0)).toBe(true)
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
    expect(accumulator.audioOutput?.transcriptSections.length).toBeLessThanOrEqual(
      Math.floor(Math.log2(Math.ceil((accumulator.audioOutput?.transcriptLength ?? 0) / 20_000))) +
        1,
    )
    expect(
      accumulator.audioOutput?.transcriptSections.every((part) => part.length % 20_000 === 0),
    ).toBe(true)
    expect(projectStreamAccumulatorFinal(accumulator).content).toContainEqual({
      type: 'audio_output',
      format: 'pcm16',
      transcript: fragment.repeat(10_000),
    })
  })
})
