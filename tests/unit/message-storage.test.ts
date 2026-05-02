import { describe, expect, it } from 'vitest'
import type { Message } from '../../src/core/types'
import {
  hydrateMessage,
  hydrateMessages,
  MESSAGE_BODY_KEYS,
  type MessageHeaderRow,
  splitMessageForStorage,
} from '../../src/store/message-storage'

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
    })
    expect(hydrateMessage(header, body)).toEqual(source)
  })

  it('does not mutate or alias the input message', () => {
    const source = message()
    const { header, body } = splitMessageForStorage(source)
    body.content[0] = { type: 'output_text', text: 'changed' }
    const firstRef = header.attachmentRefs?.[0]
    if (firstRef && typeof firstRef !== 'string') {
      firstRef.presentation.label = 'changed'
    }
    expect(source.content).toEqual([{ type: 'output_text', text: 'hello' }])
    expect(source.attachmentRefs?.[0]).toMatchObject({ presentation: { label: 'doc.txt' } })
  })

  it('keeps absent optional body fields absent', () => {
    const source = message({ content: [{ type: 'text', text: 'user text' }] })
    delete source.reasoningDetails
    delete source.toolCalls
    delete source.refusal
    delete source.phase
    delete source.responsesEchoItem
    const { header, body } = splitMessageForStorage(source)
    expect(body).not.toHaveProperty('reasoningDetails')
    expect(body).not.toHaveProperty('toolCalls')
    expect(body).not.toHaveProperty('refusal')
    expect(body).not.toHaveProperty('phase')
    expect(body).not.toHaveProperty('responsesEchoItem')
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
})
