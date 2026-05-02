import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { PromptSizeEstimateInput } from '../../src/core/prompt-size'
import type { Message } from '../../src/core/types'
import { useStreamStablePromptEstimate } from '../../src/hooks/useStreamStablePromptEstimate'

function makeMessage(overrides: Partial<Message>): Message {
  return {
    id: 'M',
    chatId: 'C1',
    parentId: null,
    siblingIndex: 0,
    turnId: 'T1',
    turnIndex: 0,
    createdAt: 1,
    role: 'assistant',
    origin: 'generated',
    content: [{ type: 'output_text', text: 'hello' }],
    nodeVersion: 0,
    deleted: false,
    ...overrides,
  }
}

function makeInput(messages: Message[]): PromptSizeEstimateInput {
  return {
    systemPrompt: '',
    activePathMessages: messages,
    draftText: '',
    tokenizer: 'gpt',
    reasoningInclude: { encrypted: false, summary: false, text: false },
    reasoningExcluded: false,
  }
}

describe('useStreamStablePromptEstimate', () => {
  it('freezes streaming message growth until the stream ends, then adopts the final calibrated usage', () => {
    const user = makeMessage({
      id: 'U1',
      role: 'user',
      origin: 'user',
      content: [{ type: 'text', text: 'hello there' }],
      nodeVersion: 0,
    })
    const partialAssistant = makeMessage({
      id: 'A1',
      parentId: 'U1',
      content: [{ type: 'output_text', text: 'short' }],
      nodeVersion: 3,
    })

    const { result, rerender } = renderHook(
      ({ input, streamActivityKey }) =>
        useStreamStablePromptEstimate('C1', input, streamActivityKey),
      {
        initialProps: {
          input: makeInput([user, partialAssistant]),
          streamActivityKey: 'm:A1',
        },
      },
    )

    const frozen = result.current
    expect(frozen).not.toBeNull()

    const finalAssistant = makeMessage({
      id: 'A1',
      parentId: 'U1',
      content: [{ type: 'output_text', text: 'this became much longer while streaming' }],
      nodeVersion: 4,
      generation: {
        id: 'gen-1',
        model: 'openai/gpt-5',
        requestedModel: 'openai/gpt-5',
        apiUsed: 'chat',
        delivery: 'streaming',
        costSource: 'stream',
        startedAt: 1,
        usage: {
          prompt_tokens: 400,
          completion_tokens: 50,
          total_tokens: 450,
        },
      },
    })

    rerender({
      input: makeInput([user, finalAssistant]),
      streamActivityKey: 'm:A1',
    })

    expect(result.current).toEqual(frozen)

    rerender({
      input: makeInput([user, finalAssistant]),
      streamActivityKey: '',
    })

    expect(result.current).not.toEqual(frozen)
    expect(result.current?.total ?? 0).toBeGreaterThan(frozen?.total ?? 0)
  })

  it('still updates during a stream when a different message changes discretely', () => {
    const user = makeMessage({
      id: 'U1',
      role: 'user',
      origin: 'user',
      content: [{ type: 'text', text: 'hello there' }],
      nodeVersion: 0,
    })
    const streamingAssistant = makeMessage({
      id: 'A1',
      parentId: 'U1',
      content: [{ type: 'output_text', text: 'short' }],
      nodeVersion: 2,
    })

    const { result, rerender } = renderHook(
      ({ input, streamActivityKey }) =>
        useStreamStablePromptEstimate('C1', input, streamActivityKey),
      {
        initialProps: {
          input: makeInput([user, streamingAssistant]),
          streamActivityKey: 'm:A1',
        },
      },
    )

    const frozen = result.current
    const editedUser = makeMessage({
      ...user,
      content: [{ type: 'text', text: 'hello there with an edit' }],
      nodeVersion: 1,
    })

    rerender({
      input: makeInput([editedUser, streamingAssistant]),
      streamActivityKey: 'm:A1',
    })

    expect(result.current).not.toEqual(frozen)
    expect(result.current?.total ?? 0).toBeGreaterThan(frozen?.total ?? 0)
  })

  it('updates during a stream when the streamed message itself changes via a discrete visibility toggle', () => {
    const user = makeMessage({
      id: 'U1',
      role: 'user',
      origin: 'user',
      content: [{ type: 'text', text: 'hello there' }],
      nodeVersion: 0,
    })
    const streamingAssistant = makeMessage({
      id: 'A1',
      parentId: 'U1',
      content: [{ type: 'output_text', text: 'short' }],
      nodeVersion: 2,
    })

    const { result, rerender } = renderHook(
      ({ input, streamActivityKey }) =>
        useStreamStablePromptEstimate('C1', input, streamActivityKey),
      {
        initialProps: {
          input: makeInput([user, streamingAssistant]),
          streamActivityKey: 'm:A1',
        },
      },
    )

    const frozen = result.current
    rerender({
      input: makeInput([
        { ...user },
        { ...streamingAssistant, hiddenFromContext: true, nodeVersion: 3 },
      ]),
      streamActivityKey: 'm:A1',
    })

    expect(result.current).not.toEqual(frozen)
    expect(result.current?.total ?? 0).toBeLessThan(frozen?.total ?? Number.POSITIVE_INFINITY)
  })
})
