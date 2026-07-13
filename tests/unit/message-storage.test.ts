import { describe, expect, it } from 'vitest'
import type { ContinuationAttempt, Message } from '../../src/core/types'
import {
  contentIncludesCaseInsensitiveText,
  hydrateMessage,
  hydrateMessages,
  MESSAGE_BODY_KEYS,
  MESSAGE_TEXT_PREVIEW_MAX_CHARS,
  type MessageHeaderRow,
  previewTextFromContent,
  previewTextFromStoredProjection,
  splitMessageForStorage,
} from '../../src/store/message-storage'

describe('contentIncludesCaseInsensitiveText', () => {
  it('matches case-insensitively across text-item boundaries without joining the full body', () => {
    expect(
      contentIncludesCaseInsensitiveText(
        [
          { type: 'text', text: `${'x'.repeat(64 * 1024)}Needle` },
          { type: 'output_text', text: 'Across Items' },
        ],
        'needle\nacross',
      ),
    ).toBe(true)
  })

  it('ignores non-text content and observes cancellation while scanning a large body', () => {
    const controller = new AbortController()
    controller.abort()
    expect(() =>
      contentIncludesCaseInsensitiveText(
        [
          { type: 'image_url', url: 'data:image/png;base64,needle' },
          { type: 'text', text: 'x'.repeat(128 * 1024) },
        ],
        'needle',
        controller.signal,
      ),
    ).toThrowError(/Search aborted/)
  })
})

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
    reasoningDetails: [{ type: 'reasoning.summary', summary: 'continuation thought' }],
    toolCalls: [
      {
        id: 'continuation-call-1',
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
    abortReason: 'user',
  },
  {
    streamId: 'continue-stream-4',
    strategy: 'unknown',
    status: 'interrupted',
    startedAt: 11,
    finishedAt: 12,
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
      startedAt: 1,
      finishedAt: 3,
      cost: 0.001,
    },
    content: [{ type: 'output_text', text: 'hello' }],
    reasoningDetails: [{ type: 'reasoning.summary', summary: 'short thought' }],
    toolCalls: [{ id: 'tool-1', type: 'function', function: { name: 'search', arguments: '{}' } }],
    refusal: 'no',
    phase: 'final_answer',
    responsesEchoItem: { type: 'message', id: 'item-1', status: 'completed' },
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
    })
    expect(body).toMatchObject({
      id: source.id,
      chatId: source.chatId,
      nodeVersion: source.nodeVersion,
      updatedAt: 9,
      content: source.content,
      reasoningDetails: source.reasoningDetails,
      toolCalls: source.toolCalls,
      refusal: source.refusal,
      phase: source.phase,
      responsesEchoItem: source.responsesEchoItem,
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
    delete source.reasoningDetails
    delete source.toolCalls
    delete source.refusal
    delete source.phase
    delete source.responsesEchoItem
    delete source.continuationAttempts
    const { header, body } = splitMessageForStorage(source)
    expect(body).not.toHaveProperty('reasoningDetails')
    expect(body).not.toHaveProperty('toolCalls')
    expect(body).not.toHaveProperty('refusal')
    expect(body).not.toHaveProperty('phase')
    expect(body).not.toHaveProperty('responsesEchoItem')
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
    expect(() => hydrateMessage(header, { ...body, nodeVersion: 5 })).toThrow(
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
    const { header } = splitMessageForStorage(message({ content }))

    expect(header.textPreview).toHaveLength(MESSAGE_TEXT_PREVIEW_MAX_CHARS)
    expect(header.textPreview).toBe(`${'x'.repeat(MESSAGE_TEXT_PREVIEW_MAX_CHARS - 1)}…`)
    expect(previewTextFromStoredProjection(header.textPreview, 240)).toBe(`${'x'.repeat(239)}…`)
    expect(previewTextFromStoredProjection('short preview', 240)).toBe('short preview')
  })

  it('moves server-tool outputs into the cold body and restores exact tool order and ownership', () => {
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
            output: { results: [{ title: 'result' }] },
          },
          {
            type: 'shell_call_output',
            source: 'provider-output',
            output: undefined,
          },
        ],
      },
    })
    const { header, body } = splitMessageForStorage(source)

    expect(header.generation?.serverTools).toEqual([
      { type: 'usage-only', source: 'usage', requestCount: 2 },
      {
        type: 'web_search_call',
        source: 'responses-output',
        id: 'search-1',
      },
      { type: 'shell_call_output', source: 'provider-output' },
    ])
    expect(body.generationServerToolOutputs).toEqual([
      { index: 1, output: { results: [{ title: 'result' }] } },
      { index: 2, output: undefined },
    ])
    expect(hydrateMessage(header, body)).toEqual(source)
    expect(
      Object.hasOwn(hydrateMessage(header, body).generation?.serverTools?.[2] ?? {}, 'output'),
    ).toBe(true)
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
