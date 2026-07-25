import { describe, expect, it } from 'vitest'
import type { ContinuationAttempt, Message } from '../../src/core/types'
import {
  canonicalMessageHeaderRow,
  hydrateMessage,
  hydrateMessages,
  MESSAGE_BODY_KEYS,
  MESSAGE_TEXT_PREVIEW_MAX_CHARS,
  type MessageHeaderRow,
  previewTextFromContent,
  previewTextFromStoredProjection,
  rebaseHydratedMessageHeader,
  sameMessageHeaderValue,
  splitMessageForStorage,
} from '../../src/store/message-storage'
import { reasoningEnvelopeFromDetailsForTest } from '../helpers/reasoning-events'

const continuationAttempts: ContinuationAttempt[] = [
  {
    streamId: 'continue-stream-1',
    strategy: 'prompt',
    status: 'done',
    requestedModel: 'model-a',
    model: 'model-a-provider-version',
    apiUsed: 'responses',
    provider: 'provider-a',
    generationId: 'continue-generation-1',
    startedAt: 4,
    firstTextAt: 5,
    reasoningStartedAt: 4.5,
    reasoningFinishedAt: 4.75,
    finishedAt: 6,
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    cost: 0.0002,
    costSource: 'stream',
    finishReason: 'stop',
    nativeFinishReason: 'completed',
    reasoningEnvelope: reasoningEnvelopeFromDetailsForTest(
      [
        {
          type: 'reasoning.summary',
          format: 'openai-responses-v1',
          summary: 'continuation thought',
        },
      ],
      'openai-responses',
    ),
    toolCalls: [
      {
        id: 'continuation-call-1',
        type: 'function',
        function: { name: 'lookup', arguments: '{"query":"natter"}' },
      },
    ],
    phase: 'final_answer',
    reasoningCarryForward: 'none',
    reasoningVisibility: { disclosure: 'unknown' },
    application: { kind: 'applied' },
    providerOutputItems: [
      {
        dialect: 'openai-responses',
        type: 'reasoning',
        outputIndex: 0,
        item: { id: 'continue-item-1', encrypted_content: 'opaque' },
      },
    ],
  },
  {
    streamId: 'continue-stream-2',
    strategy: 'prefill',
    status: 'error',
    requestedModel: 'model-b',
    apiUsed: 'chat',
    startedAt: 7,
    finishedAt: 8,
    reasoningCarryForward: 'none',
    reasoningVisibility: { disclosure: 'unknown' },
    application: { kind: 'applied' },
    error: {
      category: 'provider',
      code: 'provider_error',
      message: 'failed',
      statusCode: 500,
    },
  },
  {
    streamId: 'continue-stream-3',
    strategy: 'prompt',
    status: 'abort',
    requestedModel: 'model-c',
    apiUsed: 'gemini-native',
    startedAt: 9,
    finishedAt: 10,
    reasoningCarryForward: 'none',
    reasoningVisibility: { disclosure: 'unknown' },
    application: { kind: 'applied' },
    abortReason: 'user',
  },
  {
    streamId: 'continue-stream-4',
    strategy: 'unknown',
    status: 'interrupted',
    startedAt: 11,
    finishedAt: 12,
    reasoningCarryForward: 'none',
    reasoningVisibility: { disclosure: 'unknown' },
    application: { kind: 'applied' },
  },
]

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    chatId: 'chat-1',
    parentId: null,
    siblingIndex: 0,
    turnId: 'turn-1',
    turnIndex: 0,
    createdAt: 1,
    editedAt: 2,
    role: 'assistant',
    origin: 'generated',
    generation: {
      id: 'gen-1',
      model: 'model-a',
      requestedModel: 'model-a',
      apiUsed: 'chat',
      delivery: 'streaming',
      costSource: 'stream',
      reasoningCarryForward: 'none',
      reasoningVisibility: { disclosure: 'unknown' },
      startedAt: 1,
      finishedAt: 3,
      cost: 0.001,
    },
    content: [{ type: 'output_text', text: 'hello' }],
    reasoningEnvelope: reasoningEnvelopeFromDetailsForTest(
      [{ type: 'reasoning.summary', format: 'unknown', summary: 'short thought' }],
      'unknown',
    ),
    toolCalls: [{ id: 'tool-1', type: 'function', function: { name: 'search', arguments: '{}' } }],
    refusal: 'no',
    phase: 'final_answer',
    providerOutputItems: [
      {
        dialect: 'openai-responses',
        type: 'message',
        outputIndex: 0,
        item: { type: 'message', id: 'item-1', status: 'completed' },
      },
    ],
    continuationAttempts,
    attachmentRefs: [
      {
        refId: 'ref-1',
        attachmentId: 'att-1',
        includeInContext: true,
        presentation: { label: 'doc.txt' },
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    approval: { state: 'approved', approvedAt: 2 },
    nodeVersion: 4,
    pinCache: true,
    hiddenFromContext: true,
    deleted: false,
    originalCharCount: 5,
    originalTokenEstimate: 2,
    originalModelId: 'model-a',
    originalCalibrationKey: 'family-a',
    charCountDelta: 1,
    cachedTokenEstimate: 3,
    cachedMediaTokens: 4,
    ...overrides,
  }
}

describe('message storage split', () => {
  it('canonicalizes absent attachment refs at the storage split boundary', () => {
    const source = message()
    delete source.attachmentRefs
    const { header } = splitMessageForStorage(source)
    const rawHeader = { ...header }
    delete rawHeader.attachmentRefs
    const fromRawRow = canonicalMessageHeaderRow(rawHeader)
    const fromProjectedRow = canonicalMessageHeaderRow({ ...header, attachmentRefs: [] })

    expect(header.attachmentRefs).toEqual([])
    expect(fromRawRow.attachmentRefs).toEqual([])
    expect(sameMessageHeaderValue(fromRawRow, fromProjectedRow)).toBe(true)
  })

  it('splits body fields away from header fields and hydrates the original domain shape', () => {
    const source = message()
    const { header, body } = splitMessageForStorage(source, { updatedAt: 9 })

    for (const key of MESSAGE_BODY_KEYS) {
      expect(header).not.toHaveProperty(key)
    }
    expect(header).toMatchObject({
      id: source.id,
      chatId: source.chatId,
      parentId: source.parentId,
      siblingIndex: source.siblingIndex,
      generation: source.generation,
      attachmentRefs: source.attachmentRefs,
      nodeVersion: source.nodeVersion,
      bodyVersion: source.nodeVersion,
    })
    expect(body).toMatchObject({
      id: source.id,
      chatId: source.chatId,
      bodyVersion: source.nodeVersion,
      updatedAt: 9,
      content: source.content,
      reasoningEnvelope: source.reasoningEnvelope,
      toolCalls: source.toolCalls,
      refusal: source.refusal,
      phase: source.phase,
      providerOutputItems: source.providerOutputItems,
      continuationAttempts: source.continuationAttempts,
    })
    expect(hydrateMessage(header, body)).toEqual(source)
  })

  it('does not mutate or alias the input message', () => {
    const source = message()
    const { header, body } = splitMessageForStorage(source)
    body.content[0] = { type: 'output_text', text: 'changed' }
    const attemptItem = body.continuationAttempts?.[0]?.providerOutputItems?.[0]?.item as
      | { id: string }
      | undefined
    if (attemptItem) attemptItem.id = 'changed'
    const firstRef = header.attachmentRefs?.[0]
    if (firstRef && typeof firstRef !== 'string') {
      firstRef.presentation.label = 'changed'
    }
    expect(source.content).toEqual([{ type: 'output_text', text: 'hello' }])
    expect(source.continuationAttempts?.[0]?.providerOutputItems?.[0]?.item).toMatchObject({
      id: 'continue-item-1',
    })
    expect(source.attachmentRefs?.[0]).toMatchObject({ presentation: { label: 'doc.txt' } })

    const hydrated = hydrateMessage(header, body)
    const hydratedAttemptItem = hydrated.continuationAttempts?.[0]?.providerOutputItems?.[0]
      ?.item as { id: string } | undefined
    if (hydratedAttemptItem) hydratedAttemptItem.id = 'hydrated-change'
    expect(body.continuationAttempts?.[0]?.providerOutputItems?.[0]?.item).toMatchObject({
      id: 'changed',
    })
  })

  it('keeps absent optional body fields absent', () => {
    const source = message({ content: [{ type: 'text', text: 'user text' }] })
    delete source.reasoningEnvelope
    delete source.toolCalls
    delete source.refusal
    delete source.phase
    delete source.providerOutputItems
    delete source.continuationAttempts
    const { header, body } = splitMessageForStorage(source)
    expect(body).not.toHaveProperty('reasoningEnvelope')
    expect(body).not.toHaveProperty('toolCalls')
    expect(body).not.toHaveProperty('refusal')
    expect(body).not.toHaveProperty('phase')
    expect(body).not.toHaveProperty('providerOutputItems')
    expect(body).not.toHaveProperty('continuationAttempts')
    expect(hydrateMessage(header, body)).toEqual(source)
  })

  it('rejects missing and mismatched bodies instead of providing legacy fallbacks', () => {
    const { header, body } = splitMessageForStorage(message())
    expect(() => hydrateMessages([header], [])).toThrow('MessageBodyMissing:msg-1')
    expect(() => hydrateMessage(header, { ...body, id: 'other' })).toThrow(
      'MessageBodyMismatch:msg-1:other',
    )
    expect(() => hydrateMessage(header, { ...body, chatId: 'other-chat' })).toThrow(
      'MessageBodyChatMismatch:msg-1:chat-1:other-chat',
    )
    expect(() => hydrateMessage(header, { ...body, bodyVersion: 5 })).toThrow(
      'MessageBodyVersionMismatch:msg-1:4:5',
    )
  })

  it('makes header rows assignable without body fields', () => {
    const { header } = splitMessageForStorage(message())
    const row: MessageHeaderRow = header
    expect(row.id).toBe('msg-1')
  })

  it('stores a bounded text projection without cloning the cold body to read shorter previews', () => {
    const content = [{ type: 'output_text' as const, text: `  ${'x'.repeat(30_000)}  ` }]
    const { preview } = splitMessageForStorage(message({ content }))

    expect(preview.text).toHaveLength(MESSAGE_TEXT_PREVIEW_MAX_CHARS)
    expect(preview.text).toBe(`${'x'.repeat(MESSAGE_TEXT_PREVIEW_MAX_CHARS - 1)}…`)
    expect(previewTextFromStoredProjection(preview.text, 240)).toBe(`${'x'.repeat(239)}…`)
    expect(previewTextFromStoredProjection('short preview', 240)).toBe('short preview')
  })

  it('keeps bounded server-tool metadata hot and exact provider payloads in the cold body', () => {
    const baseGeneration = message().generation
    if (!baseGeneration) throw new Error('Expected generation fixture')
    const source = message({
      generation: {
        ...baseGeneration,
        serverTools: [
          { type: 'usage-only', source: 'usage', requestCount: 2 },
          {
            type: 'web_search_call',
            source: 'responses-output',
            id: 'search-1',
          },
        ],
      },
      providerOutputItems: [
        {
          dialect: 'openai-responses',
          type: 'web_search_call',
          outputIndex: 1,
          item: { id: 'search-1', results: [{ title: 'result' }] },
        },
      ],
    })
    const { header, body } = splitMessageForStorage(source)

    expect(header.generation?.serverTools).toEqual([
      { type: 'usage-only', source: 'usage', requestCount: 2 },
      {
        type: 'web_search_call',
        source: 'responses-output',
        id: 'search-1',
      },
    ])
    expect(header).not.toHaveProperty('providerOutputItems')
    expect(body.providerOutputItems).toEqual([
      {
        dialect: 'openai-responses',
        type: 'web_search_call',
        outputIndex: 1,
        item: { id: 'search-1', results: [{ title: 'result' }] },
      },
    ])
    expect(hydrateMessage(header, body)).toEqual(source)
  })

  it('rebases canonical header metadata without replacing cold provider payloads', () => {
    const baseGeneration = message().generation
    if (!baseGeneration) throw new Error('Expected generation fixture')
    const source = message({
      generation: {
        ...baseGeneration,
        serverTools: [
          {
            type: 'web_search_call',
            source: 'responses-output',
            id: 'search-1',
          },
        ],
      },
      providerOutputItems: [
        {
          dialect: 'openai-responses',
          type: 'web_search_call',
          outputIndex: 0,
          item: { id: 'search-1', results: [{ url: 'https://example.com/result' }] },
        },
      ],
    })
    const { header, body } = splitMessageForStorage(source)
    const hydrated = hydrateMessage(header, body)
    const hydratedProviderOutput = hydrated.providerOutputItems
    const canonicalGeneration = header.generation
    if (!canonicalGeneration) throw new Error('Expected canonical generation metadata')
    const canonicalHeader = {
      ...header,
      nodeVersion: header.nodeVersion + 1,
      cachedTokenEstimate: 12,
      generation: {
        ...canonicalGeneration,
        provider: 'canonical-provider',
      },
    }

    const rebased = rebaseHydratedMessageHeader(hydrated, canonicalHeader)

    expect(rebased).toMatchObject({
      nodeVersion: canonicalHeader.nodeVersion,
      cachedTokenEstimate: 12,
      generation: {
        provider: 'canonical-provider',
        serverTools: [{ type: 'web_search_call' }],
      },
    })
    expect(rebased.providerOutputItems).toBe(hydratedProviderOutput)
    expect(rebased.providerOutputItems?.[0]?.item).toEqual({
      id: 'search-1',
      results: [{ url: 'https://example.com/result' }],
    })
    expect(canonicalHeader).not.toHaveProperty('providerOutputItems')
  })

  it('preserves the existing preview normalization and truncation semantics', () => {
    const content = [
      { type: 'text' as const, text: ' \t first\n' },
      { type: 'image_url' as const, url: 'ignored' },
      { type: 'output_text' as const, text: ' second\r\nthird  ' },
    ]
    const legacy = content
      .filter((item) => item.type === 'text' || item.type === 'output_text')
      .map((item) => ('text' in item ? item.text : ''))
      .join('')
      .replace(/\s+/g, ' ')
      .trim()

    expect(previewTextFromContent(content)).toBe(legacy)
    expect(previewTextFromContent([{ type: 'text', text: 'x'.repeat(1_000_000) }])).toBe(
      `${'x'.repeat(239)}…`,
    )
    expect(previewTextFromContent([{ type: 'text', text: 'x'.repeat(240) }])).toBe('x'.repeat(240))
    expect(previewTextFromContent([{ type: 'text', text: 'x'.repeat(2_000) }], 960)).toBe(
      `${'x'.repeat(959)}…`,
    )
  })
})
