import { describe, expect, it } from 'vitest'
import { ApiError } from '../../src/api/errors'
import { buildContinuationAttempt } from '../../src/core/continuation-attempt'
import {
  appendContinuationText,
  createAppliedMessageView,
} from '../../src/core/continuation-content'
import {
  applyStreamAccumulatorEvent,
  createStreamAccumulator,
  projectStreamAccumulatorFinal,
} from '../../src/core/stream-accumulator'
import type { ContentItem, ContinuationAttempt } from '../../src/core/types'
import { reasoningEnvelopeFromDetailsForTest } from '../helpers/reasoning-events'

describe('appendContinuationText', () => {
  it('extends only a final unannotated output block without mutating the source', () => {
    const original: ContentItem[] = [{ type: 'output_text', text: 'partial' }]

    const appended = appendContinuationText(original, ' tail')

    expect(appended).toEqual([{ type: 'output_text', text: 'partial tail' }])
    expect(original).toEqual([{ type: 'output_text', text: 'partial' }])
    expect(appended[0]).not.toBe(original[0])
  })

  it('rebases continuation annotations onto a merged final output block', () => {
    const original: ContentItem[] = [{ type: 'output_text', text: 'partial' }]
    const annotations = [
      {
        type: 'url_citation' as const,
        url: 'https://example.invalid/source',
        startIndex: 1,
        endIndex: 5,
        source: 'openai-chat' as const,
        providerPayload: {
          type: 'url_citation',
          url: 'https://example.invalid/source',
          start_index: 1,
          end_index: 5,
        },
      },
    ]

    const appended = appendContinuationText(original, ' tail', annotations)

    expect(appended).toEqual([
      {
        type: 'output_text',
        text: 'partial tail',
        annotations: [{ ...annotations[0], startIndex: 8, endIndex: 12 }],
      },
    ])
    const output = appended[0]
    if (output?.type !== 'output_text') throw new Error('expected output text fixture')
    expect(output.annotations).not.toBe(annotations)
    expect(output.annotations?.[0]).not.toBe(annotations[0])
  })

  it('preserves annotated and interleaved items in order and deep-clones them', () => {
    const original: ContentItem[] = [
      {
        type: 'output_text',
        text: 'cited',
        annotations: [
          {
            type: 'url_citation',
            url: 'https://example.invalid/source',
            startIndex: 0,
            endIndex: 5,
            source: 'imported',
            providerPayload: {
              type: 'url_citation',
              url: 'https://example.invalid/source',
              start_index: 0,
              end_index: 5,
            },
          },
        ],
      },
      { type: 'output_image', url: 'https://example.invalid/image.png', prompt: 'diagram' },
      { type: 'text', text: 'cached', cacheControl: { type: 'ephemeral', ttl: '1h' } },
      { type: 'audio_output', url: 'https://example.invalid/audio.wav', format: 'wav' },
      {
        type: 'output_text',
        text: 'final citation',
        annotations: [
          {
            type: 'file_citation',
            filename: 'evidence.txt',
            file: { kind: 'unresolved', provider: 'imported' },
            startIndex: 14,
            endIndex: 14,
            source: 'imported',
            providerPayload: { type: 'file_citation', filename: 'evidence.txt' },
          },
        ],
      },
    ]

    const appended = appendContinuationText(original, ' continued')

    expect(appended).toEqual([...original, { type: 'output_text', text: ' continued' }])
    expect(appended.slice(0, original.length)).not.toBe(original)
    for (let index = 0; index < original.length; index += 1) {
      expect(appended[index]).not.toBe(original[index])
    }
    const first = appended[0]
    const originalFirst = original[0]
    if (first?.type !== 'output_text' || originalFirst?.type !== 'output_text') {
      throw new Error('expected output text fixtures')
    }
    expect(first.annotations).not.toBe(originalFirst.annotations)
    expect(first.annotations?.[0]).not.toBe(originalFirst.annotations?.[0])
  })

  it('keeps continuation annotations relative to a new exact output block', () => {
    const original: ContentItem[] = [
      {
        type: 'output_text',
        text: 'cited',
        annotations: [
          {
            type: 'url_citation',
            url: 'https://example.invalid/original',
            startIndex: 0,
            endIndex: 5,
            source: 'openai-chat',
            providerPayload: { type: 'url_citation', url: 'https://example.invalid/original' },
          },
        ],
      },
    ]
    const continuationAnnotation = {
      type: 'url_citation' as const,
      url: 'https://example.invalid/continued',
      startIndex: 1,
      endIndex: 10,
      source: 'openai-chat' as const,
      providerPayload: { type: 'url_citation', url: 'https://example.invalid/continued' },
    }

    expect(appendContinuationText(original, ' continued', [continuationAnnotation])).toEqual([
      ...original,
      {
        type: 'output_text',
        text: ' continued',
        annotations: [continuationAnnotation],
      },
    ])
  })
})

describe('applied continuation selection', () => {
  const attempt = (applied: boolean): ContinuationAttempt => {
    const draft = {
      streamId: 'stream',
      strategy: 'prompt' as const,
      status: 'done' as const,
      startedAt: 1,
      finishedAt: 2,
      reasoningCarryForward: 'unknown' as const,
      reasoningVisibility: { disclosure: 'unknown' as const },
    }
    return applied
      ? { ...draft, application: { kind: 'applied' } }
      : {
          ...draft,
          application: { kind: 'unapplied', reason: 'base-version-changed' },
        }
  }

  it('advances the applied view only for an explicitly applied attempt', () => {
    const applied = attempt(true)
    const unapplied = attempt(false)
    expect(
      createAppliedMessageView({ content: [], continuationAttempts: [applied] }).latestAttempt,
    ).toMatchObject({ kind: 'continuation', metadata: applied })
    expect(
      createAppliedMessageView({ content: [], continuationAttempts: [unapplied] }).latestAttempt,
    ).toMatchObject({ kind: 'generation' })
  })
})

describe('buildContinuationAttempt', () => {
  it('projects streamed continuation provenance without changing the accumulator', () => {
    const accumulator = createStreamAccumulator({ initialContent: [], now: 10 })
    accumulator.generationId = 'generation-1'
    accumulator.model = 'actual-model'
    accumulator.provider = 'provider-a'
    accumulator.firstTextAt = 12
    accumulator.reasoningStartedAt = 11
    accumulator.reasoningFinishedAt = 13
    accumulator.usage = {
      prompt_tokens: 20,
      completion_tokens: 4,
      total_tokens: 24,
      cost: 0.003,
    }
    accumulator.finishReason = 'stop'
    const reasoningEnvelope = reasoningEnvelopeFromDetailsForTest(
      [
        {
          type: 'reasoning.summary',
          format: 'openai-responses-v1',
          id: 'reasoning-1',
          summary: 'continued reasoning',
        },
      ],
      'openai-responses',
    )
    applyStreamAccumulatorEvent(
      accumulator,
      { lane: 'reasoning', mutations: [{ kind: 'replace', envelope: reasoningEnvelope }] },
      13,
    )
    accumulator.phase = 'final_answer'
    accumulator.providerOutputItems.push({
      dialect: 'openai-responses',
      type: 'reasoning',
      outputIndex: 0,
      item: { id: 'provider-item-1', encrypted_content: 'opaque' },
    })
    applyStreamAccumulatorEvent(
      accumulator,
      {
        lane: 'tool-call',
        index: 0,
        id: 'continuation-call',
        type: 'function',
        name: 'lookup',
        argumentsSnapshot: '{"query":"natter"}',
      },
      13,
    )
    const error = new ApiError({
      kind: 'provider_error',
      httpStatus: 502,
      code: 502,
      message: 'provider failed',
      midStream: true,
      retryable: true,
    })

    const attempt = buildContinuationAttempt({
      streamId: 'stream-1',
      strategy: 'prefill',
      status: 'error',
      requestedModel: 'requested-model',
      apiUsed: 'responses',
      startedAt: 10,
      finishedAt: 14,
      reasoningCarryForward: 'carrier',
      reasoningVisibility: { disclosure: 'visible', visibleKind: 'summary' },
      accumulator,
      abortReason: 'network',
      error,
    })

    expect(attempt).toEqual({
      streamId: 'stream-1',
      strategy: 'prefill',
      status: 'error',
      integrity: 'clean',
      requestedModel: 'requested-model',
      model: 'actual-model',
      apiUsed: 'responses',
      provider: 'provider-a',
      generationId: 'generation-1',
      startedAt: 10,
      firstTextAt: 12,
      reasoningStartedAt: 11,
      reasoningFinishedAt: 13,
      finishedAt: 14,
      usage: {
        prompt_tokens: 20,
        completion_tokens: 4,
        total_tokens: 24,
        cost: 0.003,
      },
      cost: 0.003,
      costSource: 'stream',
      finishReason: 'stop',
      error: {
        category: 'provider',
        code: '502',
        message: 'provider failed',
        statusCode: 502,
        retryable: true,
        midStream: true,
      },
      abortReason: 'network',
      reasoningCarryForward: 'carrier',
      reasoningVisibility: { disclosure: 'visible', visibleKind: 'summary' },
      reasoningEnvelope,
      toolCalls: [
        {
          id: 'continuation-call',
          type: 'function',
          function: { name: 'lookup', arguments: '{"query":"natter"}' },
        },
      ],
      phase: 'final_answer',
      providerOutputItems: [
        {
          dialect: 'openai-responses',
          type: 'reasoning',
          outputIndex: 0,
          item: { id: 'provider-item-1', encrypted_content: 'opaque' },
        },
      ],
    })
    expect(attempt.usage).not.toBe(accumulator.usage)
    expect(attempt.reasoningEnvelope).not.toBe(reasoningEnvelope)
    const attemptVisible = attempt.reasoningEnvelope?.visible[0] as { text: string } | undefined
    if (attemptVisible) attemptVisible.text = 'changed after projection'
    expect(attempt.providerOutputItems).not.toBe(accumulator.providerOutputItems)
    expect(accumulator).toMatchObject({
      generationId: 'generation-1',
      model: 'actual-model',
      provider: 'provider-a',
      finishReason: 'stop',
      phase: 'final_answer',
    })
    expect(projectStreamAccumulatorFinal(accumulator).reasoningEnvelope).toEqual(reasoningEnvelope)
    expect(accumulator.providerOutputItems).toHaveLength(1)
  })

  it('uses the requested model only as the actual-model fallback for a known new attempt', () => {
    const accumulator = createStreamAccumulator({ initialContent: [], now: 1 })

    expect(
      buildContinuationAttempt({
        streamId: 'stream-new',
        strategy: 'prompt',
        status: 'done',
        requestedModel: 'requested-model',
        apiUsed: 'chat',
        startedAt: 1,
        finishedAt: 2,
        reasoningCarryForward: 'none',
        reasoningVisibility: {
          disclosure: 'absent',
          unexpectedVisibleKind: 'text',
          reason: 'disabled',
        },
        accumulator,
      }),
    ).toMatchObject({
      requestedModel: 'requested-model',
      model: 'requested-model',
      apiUsed: 'chat',
    })
  })

  it('omits identity that a legacy recovery cannot know and normalizes a streamed error', () => {
    const accumulator = createStreamAccumulator({ initialContent: [], now: 1 })
    const error = new ApiError({
      kind: 'rate_limited',
      httpStatus: 429,
      code: 429,
      message: 'slow down',
      midStream: true,
      retryable: true,
    })
    accumulator.midStreamError = error

    const attempt = buildContinuationAttempt({
      streamId: 'legacy-stream',
      strategy: 'unknown',
      status: 'error',
      startedAt: 1,
      finishedAt: 3,
      reasoningCarryForward: 'unknown',
      reasoningVisibility: { disclosure: 'unknown' },
      accumulator,
    })

    expect(attempt).not.toHaveProperty('requestedModel')
    expect(attempt).not.toHaveProperty('model')
    expect(attempt).not.toHaveProperty('apiUsed')
    expect(attempt).not.toHaveProperty('generationId')
    expect(attempt).not.toHaveProperty('provider')
    expect(attempt.error).toEqual({
      category: 'provider',
      code: '429',
      message: 'slow down',
      statusCode: 429,
      retryable: true,
      midStream: true,
    })
  })
})
