import { describe, expect, it } from 'vitest'
import {
  BRANCH_EXPLICIT_CLEAR_FIELDS,
  BRANCH_EXPLICIT_COPY_FIELDS,
  cloneForExplicitBranch,
} from '../../src/core/branching'
import type { Message, MessageAttachmentRef } from '../../src/core/types'

function attachmentRef(attachmentId: string, createdAt = 1): MessageAttachmentRef {
  return {
    refId: `ref-${attachmentId}-${createdAt}`,
    attachmentId,
    includeInContext: true,
    presentation: {},
    createdAt,
    updatedAt: createdAt,
  }
}

function fixtureAssistant(): Message {
  return {
    id: 'MSG_A',
    chatId: 'CHAT_1',
    parentId: 'MSG_ROOT',
    siblingIndex: 0,
    turnId: 'TURN_1',
    turnIndex: 0,
    createdAt: 1_000,
    editedAt: 2_000,
    role: 'assistant',
    origin: 'generated',
    content: [{ type: 'text', text: 'hello' }],
    nodeVersion: 0,
    generation: {
      id: 'gen_abc',
      model: 'anthropic/claude-opus-4.7',
      requestedModel: 'anthropic/claude-opus-4.7',
      apiUsed: 'responses',
      delivery: 'streaming',
      costSource: 'stream',
      startedAt: 900,
      finishedAt: 1_500,
      finishReason: 'stop',
    },
    reasoningDetails: [{ type: 'reasoning.summary', summary: 'thinking...' }],
    toolCalls: [{ id: 'tc_1', type: 'function', function: { name: 'search', arguments: '{}' } }],
    phase: 'final_answer',
    responsesEchoItem: { type: 'message', id: 'out_1' },
    attachmentRefs: [attachmentRef('ATT_1')],
    pinCache: true,
    hiddenFromContext: false,
    deleted: false,
  }
}

describe('cloneForExplicitBranch', () => {
  it('copies the user-authored fields', () => {
    const source = fixtureAssistant()
    const cloned = cloneForExplicitBranch(source, {
      id: 'MSG_B',
      turnId: 'TURN_2',
      turnIndex: 0,
      parentId: 'MSG_ROOT',
      siblingIndex: 1,
      createdAt: 3_000,
    })

    for (const field of BRANCH_EXPLICIT_COPY_FIELDS) {
      expect(cloned[field]).toEqual(source[field])
    }
    expect(cloned.role).toBe('assistant')
    expect(cloned.content).not.toBe(source.content)
  })

  it('clears every generation-specific field', () => {
    const source = fixtureAssistant()
    const cloned = cloneForExplicitBranch(source, {
      id: 'MSG_B',
      turnId: 'TURN_2',
      turnIndex: 0,
      parentId: 'MSG_ROOT',
      siblingIndex: 1,
      createdAt: 3_000,
    })

    for (const field of BRANCH_EXPLICIT_CLEAR_FIELDS) {
      expect(cloned[field]).toBeUndefined()
    }
  })

  it('marks origin as imported and sets the new tree coordinates', () => {
    const source = fixtureAssistant()
    const cloned = cloneForExplicitBranch(source, {
      id: 'MSG_B',
      turnId: 'TURN_2',
      turnIndex: 3,
      parentId: 'MSG_PARENT',
      siblingIndex: 5,
      createdAt: 9_000,
    })

    expect(cloned.id).toBe('MSG_B')
    expect(cloned.parentId).toBe('MSG_PARENT')
    expect(cloned.siblingIndex).toBe(5)
    expect(cloned.turnId).toBe('TURN_2')
    expect(cloned.turnIndex).toBe(3)
    expect(cloned.createdAt).toBe(9_000)
    expect(cloned.origin).toBe('imported')
    expect(cloned.deleted).toBe(false)
  })

  it('mutating the clone does not affect the source', () => {
    const source = fixtureAssistant()
    const cloned = cloneForExplicitBranch(source, {
      id: 'MSG_B',
      turnId: 'TURN_2',
      turnIndex: 0,
      parentId: 'MSG_ROOT',
      siblingIndex: 1,
      createdAt: 3_000,
    })

    ;(cloned.content[0] as { type: 'text'; text: string }).text = 'mutated'
    cloned.attachmentRefs?.push(attachmentRef('ATT_NEW'))

    expect((source.content[0] as { type: 'text'; text: string }).text).toBe('hello')
    expect(source.attachmentRefs).toEqual([attachmentRef('ATT_1')])
  })

  it('omits optional fields that are absent on the source', () => {
    const { attachmentRefs, pinCache, hiddenFromContext, ...rest } = fixtureAssistant()
    void attachmentRefs
    void pinCache
    void hiddenFromContext
    const source = rest as Message
    const cloned = cloneForExplicitBranch(source, {
      id: 'MSG_B',
      turnId: 'TURN_2',
      turnIndex: 0,
      parentId: 'MSG_ROOT',
      siblingIndex: 1,
      createdAt: 3_000,
    })

    expect('attachmentRefs' in cloned).toBe(false)
    expect('pinCache' in cloned).toBe(false)
    expect('hiddenFromContext' in cloned).toBe(false)
  })
})
