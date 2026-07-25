import { render, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { PromptSizeEstimate, PromptSizeEstimateInput } from '../../src/core/prompt-size'
import type { Message } from '../../src/core/types'
import {
  useDeferredStreamStablePromptEstimate,
  useStreamStablePromptEstimate,
} from '../../src/hooks/useStreamStablePromptEstimate'
import { chatRouteContract } from '../helpers/reasoning-contracts'

const ESTIMATE_ROUTE = chatRouteContract({
  include: { encrypted: false, summary: false, text: false },
})

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
    reasoning: ESTIMATE_ROUTE.reasoning,
    providerOutput: ESTIMATE_ROUTE.providerOutput,
  }
}

describe('useStreamStablePromptEstimate', () => {
  it('keeps a mounted deferred estimate visible through semantically identical input churn', () => {
    const user = makeMessage({
      id: 'U1',
      role: 'user',
      origin: 'user',
      content: [{ type: 'text', text: 'stable prompt' }],
      nodeVersion: 0,
    })
    const publications: Array<PromptSizeEstimate | null> = []
    const view = render(
      <DeferredHarness
        chatId="C1"
        input={makeInput([{ ...user }])}
        onRender={(value) => publications.push(value)}
      />,
    )
    expect(publications.at(-1)).not.toBeNull()
    const churnStart = publications.length

    for (let index = 0; index < 20; index += 1) {
      view.rerender(
        <DeferredHarness
          chatId="C1"
          input={makeInput([{ ...user, content: [...user.content] }])}
          onRender={(value) => publications.push(value)}
        />,
      )
    }

    expect(publications.slice(churnStart)).not.toContain(null)
    expect(publications.at(-1)).toEqual(publications[0])
  })

  it('never accepts a deferred estimate owned by the previous chat', () => {
    const input = makeInput([
      makeMessage({
        id: 'U1',
        role: 'user',
        origin: 'user',
        content: [{ type: 'text', text: 'identical across routes' }],
        nodeVersion: 0,
      }),
    ])
    const publications: Array<{
      chatId: string
      value: PromptSizeEstimate | null
    }> = []
    const view = render(
      <DeferredHarness
        chatId="C1"
        input={input}
        onRender={(value) => publications.push({ chatId: 'C1', value })}
      />,
    )
    const firstChatEstimate = publications.at(-1)?.value
    expect(firstChatEstimate).not.toBeNull()

    view.rerender(
      <DeferredHarness
        chatId="C2"
        input={{
          ...input,
          activePathMessages: input.activePathMessages.map((row) => ({ ...row })),
        }}
        onRender={(value) => publications.push({ chatId: 'C2', value })}
      />,
    )

    const secondChatEstimates = publications
      .filter((publication) => publication.chatId === 'C2' && publication.value !== null)
      .map((publication) => publication.value)
    expect(secondChatEstimates.length).toBeGreaterThan(0)
    expect(secondChatEstimates).not.toContain(firstChatEstimate)
  })

  it('retains the last exact estimate through a same-chat source gap without crossing chats', () => {
    const input = makeInput([
      makeMessage({
        id: 'U1',
        role: 'user',
        origin: 'user',
        content: [{ type: 'text', text: 'keep the accepted gauge painted' }],
      }),
    ])
    const { result, rerender } = renderHook<
      PromptSizeEstimate | null,
      { chatId: string; currentInput: PromptSizeEstimateInput | null }
    >(
      ({ chatId, currentInput }) => useDeferredStreamStablePromptEstimate(chatId, currentInput, ''),
      {
        initialProps: { chatId: 'C1', currentInput: input },
      },
    )
    const accepted = result.current
    expect(accepted).not.toBeNull()

    rerender({ chatId: 'C1', currentInput: null })
    expect(result.current).toBe(accepted)

    rerender({ chatId: 'C2', currentInput: null })
    expect(result.current).toBeNull()
  })

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
        reasoningCarryForward: 'none',
        reasoningVisibility: { disclosure: 'unknown' },
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

function DeferredHarness({
  chatId,
  input,
  onRender,
}: {
  chatId: string
  input: PromptSizeEstimateInput | null
  onRender: (value: PromptSizeEstimate | null) => void
}) {
  const estimate = useDeferredStreamStablePromptEstimate(chatId, input, '')
  onRender(estimate)
  return null
}
