import { act, fireEvent, render, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { effectiveCapabilityFromEndpoints } from '../../src/core/capabilities'
import type { Message as MessageRow, ModelEndpoint } from '../../src/core/types'
import { __resetMessageStreamProjectionForTests } from '../../src/hooks/useMessageStreamProjection'
import type * as GeneratedImagesModule from '../../src/store/generated-images'
import { getStreamClientId } from '../../src/store/stream-leases'
import { useStreamStore } from '../../src/store/zustand/streamStore'
import { useToastStore } from '../../src/store/zustand/toastStore'
import { Message as ChatMessageComponent } from '../../src/ui/chat/Message'
import { MessageHeader } from '../../src/ui/chat/MessageHeader'
import { MessageInfo } from '../../src/ui/chat/MessageInfo'
import { ReasoningBlock } from '../../src/ui/chat/ReasoningBlock'

function ChatMessage(
  props: Omit<ComponentProps<typeof ChatMessageComponent>, 'bodyVersion'> & {
    bodyVersion?: number
  },
) {
  return (
    <ChatMessageComponent {...props} bodyVersion={props.bodyVersion ?? props.message.nodeVersion} />
  )
}

const generatedImageMocks = vi.hoisted(() => ({
  migrate: vi.fn(async () => {}),
  normalize: vi.fn(async () => {}),
}))

vi.mock('../../src/store/generated-images', async (importOriginal) => {
  const original = await importOriginal<typeof GeneratedImagesModule>()
  return {
    ...original,
    migrateGeneratedOutputAttachments: generatedImageMocks.migrate,
    normalizeGeneratedImageOutputAttachmentRefs: generatedImageMocks.normalize,
  }
})

afterEach(() => {
  __resetMessageStreamProjectionForTests()
  useStreamStore.getState().reset()
  useToastStore.getState().reset()
  generatedImageMocks.migrate.mockClear()
  generatedImageMocks.normalize.mockClear()
})

function makeAssistant(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id: '01HAAAA',
    chatId: '01HCCCC',
    parentId: null,
    siblingIndex: 0,
    turnId: 't',
    turnIndex: 0,
    createdAt: Date.now() - 60_000,
    role: 'assistant',
    origin: 'generated',
    content: [{ type: 'text', text: 'hi' }],
    nodeVersion: 1,
    deleted: false,
    generation: {
      id: 'gen-1',
      model: 'anthropic/claude-opus-4.7',
      requestedModel: 'anthropic/claude-opus-4.7',
      apiUsed: 'chat',
      delivery: 'streaming',
      usage: {
        prompt_tokens: 100,
        completion_tokens: 412,
        total_tokens: 512,
        completion_tokens_details: { reasoning_tokens: 64 },
        prompt_tokens_details: { cached_tokens: 24 },
      },
      cost: 0.0123,
      costSource: 'stream',
      startedAt: Date.now() - 60_000,
      reasoningStartedAt: Date.now() - 58_000,
      firstTextAt: Date.now() - 55_000,
      finishedAt: Date.now() - 52_000,
    },
    ...overrides,
  }
}

function makeUser(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id: '01HBBBB',
    chatId: '01HCCCC',
    parentId: null,
    siblingIndex: 0,
    turnId: 't-u',
    turnIndex: 0,
    createdAt: Date.now() - 90_000,
    role: 'user',
    origin: 'user',
    content: [{ type: 'text', text: 'say hi' }],
    nodeVersion: 1,
    deleted: false,
    ...overrides,
  }
}

function makeEndpoint(overrides: Partial<ModelEndpoint> = {}): ModelEndpoint {
  return {
    provider_name: 'OpenAI',
    supported_parameters: ['reasoning', 'max_tokens'],
    context_length: 128000,
    pricing: {},
    ...overrides,
  }
}

describe('MessageHeader (quiet header — role + state pills only)', () => {
  it('shows the role label, capitalized', () => {
    const { container } = render(<MessageHeader message={makeAssistant()} />)
    expect(container.querySelector('[data-ui="message-role"]')?.textContent).toBe('Assistant')
  })

  it('does NOT render model/tokens/cost chips inline (those belong in the info disclosure)', () => {
    const { container } = render(<MessageHeader message={makeAssistant()} />)
    expect(container.querySelector('[data-ui="message-model"]')).toBeNull()
    expect(container.querySelector('[data-ui="message-token-count"]')).toBeNull()
    expect(container.querySelector('[data-ui="message-cost"]')).toBeNull()
    expect(container.querySelector('[data-ui="message-timestamp"]')).toBeNull()
  })

  it('does NOT render inline "edited" or "imported" pills (they live in the info disclosure)', () => {
    const msg = makeAssistant({ editedAt: Date.now() - 10_000, origin: 'imported' })
    const { container } = render(<MessageHeader message={msg} />)
    expect(container.querySelector('[data-ui="message-edited"]')).toBeNull()
    expect(container.querySelector('[data-ui="message-imported"]')).toBeNull()
  })

  it('uses "User" for user messages', () => {
    const { container } = render(<MessageHeader message={makeUser()} />)
    expect(container.querySelector('[data-ui="message-role"]')?.textContent).toBe('User')
  })

  it('keeps the role label visible in the header', () => {
    const { container } = render(<MessageHeader message={makeAssistant()} />)
    const label = container.querySelector('[data-ui="message-role"]')?.textContent
    expect(label).toBe('Assistant')
  })
})

describe('MessageInfo (revealed by ⓘ — full factual record)', () => {
  it('renders model, prompt+completion+answer+reasoning+cache token counts, timing, and cost', () => {
    const { container } = render(<MessageInfo message={makeAssistant()} />)
    const text = container.textContent
    expect(text).toMatch(/anthropic\/claude-opus-4\.7/)
    expect(text).toMatch(/Prompt tokens/)
    expect(text).toMatch(/100/)
    expect(text).toMatch(/Completion tokens/)
    expect(text).toMatch(/412/)
    expect(text).toMatch(/Answer tokens/)
    expect(text).toMatch(/348/)
    expect(text).toMatch(/Reasoning tokens/)
    expect(text).toMatch(/64/)
    expect(text).toMatch(/Reasoning time/)
    expect(text).toMatch(/before answer/)
    expect(text).toMatch(/Cache read/)
    expect(text).toMatch(/24/)
    expect(text).toMatch(/Cost/)
    expect(text).toMatch(/\$0\.012300/)
  })

  it('marks estimated costs with the ≈ prefix', () => {
    const msg = makeAssistant()
    if (msg.generation) msg.generation.costSource = 'estimated'
    const { container } = render(<MessageInfo message={msg} />)
    expect(container.textContent).toMatch(/≈ \$0\.012300/)
  })

  it('omits model/tokens/cost on user messages but still shows the created timestamp', () => {
    const { container } = render(<MessageInfo message={makeUser()} />)
    const text = container.textContent
    expect(text).not.toMatch(/Model/)
    expect(text).not.toMatch(/Cost/)
    expect(text).toMatch(/Created/)
  })

  it('falls back to reasoning chars when token breakdown is unavailable', () => {
    const msg = makeAssistant({
      reasoningDetails: [{ type: 'reasoning.encrypted', data: 'abcdef' }],
    })
    if (msg.generation?.usage?.completion_tokens_details) {
      delete msg.generation.usage.completion_tokens_details.reasoning_tokens
    }
    const { container } = render(<MessageInfo message={msg} />)
    expect(container.textContent).toMatch(/Reasoning chars/)
    expect(container.textContent).toMatch(/encrypted 6/)
  })

  it('counts overlap-looking reasoning rows independently', () => {
    const msg = makeAssistant({
      reasoningDetails: [
        { type: 'reasoning.text', index: 0, text: 'Let' },
        { type: 'reasoning.text', index: 0, text: 'Let me' },
      ],
    })
    if (msg.generation?.usage?.completion_tokens_details) {
      delete msg.generation.usage.completion_tokens_details.reasoning_tokens
    }
    const { container } = render(<MessageInfo message={msg} />)
    expect(container.textContent).toMatch(/Reasoning chars/)
    expect(container.textContent).toMatch(/text 9/)
  })

  it('renders persisted hosted-tool evidence in message info', () => {
    const msg = makeAssistant()
    if (!msg.generation) throw new Error('expected generation metadata')
    const serializeOutput = vi.fn(() => ({
      type: 'openrouter:web_fetch',
      url: 'https://openrouter.ai/',
      title: 'OpenRouter',
      content: 'The Unified Interface For LLMs',
    }))
    msg.generation.serverTools = [
      {
        type: 'openrouter:web_fetch',
        source: 'responses-output',
        id: 'wf_1',
        status: 'completed',
        outputIndex: 0,
        output: { toJSON: serializeOutput },
      },
    ]
    const { container } = render(<MessageInfo message={msg} />)
    expect(container.textContent).toMatch(/Tool calls/)
    expect(container.textContent).toMatch(/web fetch/)
    expect(container.textContent).toMatch(/wf_1/)
    expect(container.textContent).not.toMatch(/The Unified Interface For LLMs/)
    expect(serializeOutput).not.toHaveBeenCalled()

    const toolDetails = container.querySelector('details[data-ui="tool-call"]')
    if (!(toolDetails instanceof HTMLDetailsElement)) throw new Error('tool details missing')
    toolDetails.open = true
    fireEvent(toolDetails, new Event('toggle'))

    expect(serializeOutput).toHaveBeenCalledOnce()
    expect(container.textContent).toMatch(/The Unified Interface For LLMs/)
  })
})

describe('Message hidden-reasoning footer', () => {
  it('uses the stored message model instead of the chat current-model capability', () => {
    const base = makeAssistant()
    const generation = base.generation
    if (!generation) throw new Error('expected assistant fixture generation metadata')
    const msg = makeAssistant({
      generation: {
        ...generation,
        model: 'openai/o3',
        requestedModel: 'openai/o3',
        apiUsed: 'chat',
      },
      reasoningDetails: [],
    })
    const currentCapability = effectiveCapabilityFromEndpoints('anthropic/claude-haiku-4.5', [
      makeEndpoint({ supported_parameters: ['reasoning'] }),
    ])
    const { container } = render(
      <ChatMessage
        chatId={msg.chatId}
        message={msg}
        hasAnyReasoningDetails={false}
        hasConnection={false}
        capability={currentCapability}
        onEditInPlace={async () => {}}
      />,
    )
    expect(container.querySelector('[data-ui="message-hidden-reasoning"]')?.textContent).toMatch(
      /reasoned internally/i,
    )
  })

  it('hides one raw reasoning row without rewriting adjacent or tool rows', () => {
    const reasoningDetails: NonNullable<MessageRow['reasoningDetails']> = [
      {
        type: 'reasoning.text',
        id: 'block-a',
        index: 0,
        format: 'unknown',
        text: 'abcd',
      },
      { type: 'reasoning.text', id: 'tool_call-1', index: 0, text: 'tool carrier' },
      {
        type: 'reasoning.text',
        id: 'block-b',
        index: 0,
        format: 'anthropic-claude-v1',
        text: 'abcdX',
        signature: 'signature-b',
      },
    ]
    const msg = makeAssistant({ reasoningDetails })
    const onEditInPlace = vi.fn(async () => {})
    const onToggleReasoningDetailHidden = vi.fn(async () => {})
    const { container } = render(
      <ChatMessage
        chatId={msg.chatId}
        message={msg}
        hasAnyReasoningDetails
        hasConnection={false}
        onEditInPlace={onEditInPlace}
        onToggleReasoningDetailHidden={onToggleReasoningDetailHidden}
      />,
    )

    const hideButtons = container.querySelectorAll('[data-ui="reasoning-row-hide"]')
    expect(hideButtons).toHaveLength(2)
    fireEvent.click(hideButtons[1] as HTMLElement)

    expect(onEditInPlace).not.toHaveBeenCalled()
    expect(onToggleReasoningDetailHidden).toHaveBeenCalledWith(msg, 2)
  })
})

describe('Message content refresh', () => {
  it('rerenders static markdown when a persisted message version changes', async () => {
    const first = makeAssistant({ content: [{ type: 'text', text: 'Body version one' }] })
    const props = {
      chatId: first.chatId,
      hasAnyReasoningDetails: false,
      hasSiblingVariants: false,
      cursor: {},
      hasConnection: false,
      onEditInPlace: async () => {},
    }
    const { container, rerender } = render(<ChatMessage {...props} message={first} />)

    await waitFor(() => {
      expect(container.querySelector('[data-ui="message-body"]')?.textContent).toContain(
        'Body version one',
      )
    })

    rerender(
      <ChatMessage
        {...props}
        message={makeAssistant({
          id: first.id,
          nodeVersion: first.nodeVersion + 1,
          content: [{ type: 'text', text: 'Body version two' }],
        })}
      />,
    )

    await waitFor(() => {
      expect(container.querySelector('[data-ui="message-body"]')?.textContent).toContain(
        'Body version two',
      )
    })
  })
})

describe('Message presentation-only snapshots', () => {
  it('retains final stream output until the persisted message version catches up', async () => {
    const message = makeAssistant({
      id: 'final-persistence-order-message',
      content: [{ type: 'output_text', text: 'Old persisted placeholder.' }],
      nodeVersion: 1,
    })
    const generation = message.generation
    if (!generation) throw new Error('expected generation metadata')
    delete generation.finishedAt
    generation.status = 'streaming'

    act(() => {
      useStreamStore.getState().setActive({
        streamId: 'final-persistence-order-stream',
        replacementEpoch: 0,
        chatId: message.chatId,
        messageId: message.id,
        startedAt: generation.startedAt,
        ownerClientId: getStreamClientId(),
      })
      useStreamStore.getState().setLiveSnapshot({
        streamId: 'final-persistence-order-stream',
        replacementEpoch: 0,
        chatId: message.chatId,
        messageId: message.id,
        content: [{ type: 'output_text', text: 'Final live text.' }],
        textLength: 16,
        reasoningLength: 0,
        updatedAt: generation.startedAt + 1,
      })
    })

    const props = {
      chatId: message.chatId,
      hasAnyReasoningDetails: false,
      hasConnection: false,
      onEditInPlace: async () => {},
    }
    const view = render(<ChatMessage {...props} message={message} />)
    const body = () => view.container.querySelector('[data-ui="message-body"]')

    await waitFor(() => expect(body()).toHaveTextContent('Final live text.'))
    expect(body()).not.toHaveTextContent('Old persisted placeholder.')

    view.rerender(
      <ChatMessage
        {...props}
        message={message}
        presentationOnly
        allowPresentationStreamProjection
      />,
    )

    act(() =>
      useStreamStore.getState().clearLiveSnapshot(message.id, 'final-persistence-order-stream', 0),
    )
    expect(body()).toHaveTextContent('Final live text.')
    expect(body()).not.toHaveTextContent('Old persisted placeholder.')

    act(() => useStreamStore.getState().clearActive('final-persistence-order-stream', 0))
    expect(body()).toHaveTextContent('Final live text.')
    expect(body()).not.toHaveTextContent('Old persisted placeholder.')

    view.rerender(
      <ChatMessage
        {...props}
        message={makeAssistant({
          id: message.id,
          content: [{ type: 'output_text', text: 'Canonical persisted text.' }],
          nodeVersion: message.nodeVersion + 1,
        })}
        presentationOnly
        allowPresentationStreamProjection
      />,
    )

    await waitFor(() => expect(body()).toHaveTextContent('Canonical persisted text.'))
    expect(body()).not.toHaveTextContent('Final live text.')
    expect(body()).not.toHaveTextContent('Old persisted placeholder.')
  })

  it('does not run generated-output persistence migrations', async () => {
    const message = makeAssistant({
      content: [{ type: 'output_image', url: 'https://example.test/generated.png' }],
    })

    render(
      <ChatMessage
        chatId={message.chatId}
        message={message}
        hasAnyReasoningDetails={false}
        hasConnection
        presentationOnly
        onEditInPlace={async () => {}}
      />,
    )

    await Promise.resolve()
    expect(generatedImageMocks.migrate).not.toHaveBeenCalled()
    expect(generatedImageMocks.normalize).not.toHaveBeenCalled()
  })

  it('does not publish body-derived recovery banners', async () => {
    const base = makeAssistant()
    const generation = base.generation
    if (!generation) throw new Error('expected generation metadata')
    const message = makeAssistant({
      generation: {
        ...generation,
        error: {
          category: 'provider',
          code: 'STALE_REASONING',
          message: 'invalid encrypted reasoning content',
          statusCode: 400,
        },
      },
    })

    render(
      <ChatMessage
        chatId={message.chatId}
        message={message}
        hasAnyReasoningDetails
        hasConnection
        presentationOnly
        onEditInPlace={async () => {}}
        onRegenerate={async () => {}}
      />,
    )

    await Promise.resolve()
    expect(useToastStore.getState().banners).toEqual([])
  })
})

describe('Message streaming info surface', () => {
  it('marks the streaming message busy until its stream ends', () => {
    const msg = makeAssistant()
    const props = {
      chatId: msg.chatId,
      message: msg,
      hasAnyReasoningDetails: false,
      hasConnection: false,
      onEditInPlace: async () => {},
    }
    const view = render(<ChatMessage {...props} streaming />)

    expect(view.container.querySelector('[data-ui="message"]')).toHaveAttribute('aria-busy', 'true')

    view.rerender(<ChatMessage {...props} streaming={false} />)

    expect(view.container.querySelector('[data-ui="message"]')).not.toHaveAttribute('aria-busy')
  })

  it('keeps MessageInfo unmounted until the info action is clicked', () => {
    const msg = makeAssistant()
    const { container } = render(
      <ChatMessage
        chatId={msg.chatId}
        message={msg}
        hasAnyReasoningDetails={false}
        hasConnection={false}
        onEditInPlace={async () => {}}
      />,
    )

    expect(container.querySelector('[data-ui="message-info"]')).toBeNull()
  })

  it('uses the live streaming snapshot as the message-info source while open', () => {
    const msg = makeAssistant({
      content: [{ type: 'output_text', text: '' }],
      reasoningDetails: [],
    })
    const generation = msg.generation
    if (!generation) throw new Error('expected generation metadata')
    useStreamStore.getState().setActive({
      streamId: 'stream-live',
      replacementEpoch: 0,
      chatId: msg.chatId,
      messageId: msg.id,
      startedAt: generation.startedAt,
      ownerClientId: getStreamClientId(),
    })
    useStreamStore.getState().setLiveSnapshot({
      streamId: 'stream-live',
      replacementEpoch: 0,
      chatId: msg.chatId,
      messageId: msg.id,
      content: [{ type: 'output_text', text: 'live streamed words' }],
      reasoningRows: [
        {
          detail: { type: 'reasoning.text', text: '' },
          valueSections: ['thinking ', 'live'],
        },
      ],
      generation: {
        ...generation,
        provider: 'Live Provider',
        usage: {
          prompt_tokens: 5,
          completion_tokens: 11,
          total_tokens: 16,
        },
      },
      textLength: 19,
      reasoningLength: 13,
      updatedAt: generation.startedAt + 1000,
    })

    const { container, getByRole } = render(
      <ChatMessage
        chatId={msg.chatId}
        message={msg}
        hasAnyReasoningDetails={false}
        hasConnection={false}
        onEditInPlace={async () => {}}
      />,
    )

    fireEvent.click(getByRole('button', { name: 'Show message info' }))

    const text = container.querySelector('[data-ui="message-info"]')?.textContent ?? ''
    expect(text).toMatch(/Live Provider/)
    expect(text).toMatch(/Completion tokens/)
    expect(text).toMatch(/11/)
    expect(text).toMatch(/Reasoning chars/)
    expect(text).toMatch(/text 13/)
    expect(text).toMatch(/Current chars/)
    expect(text).toMatch(/19/)
  })

  it('surfaces a status banner when this message is streaming in another tab', () => {
    const msg = makeAssistant({ content: [] })
    delete msg.generation
    useStreamStore.getState().setActive({
      streamId: 'remote-stream',
      replacementEpoch: 0,
      chatId: msg.chatId,
      messageId: msg.id,
      startedAt: 1,
      ownerClientId: 'other-tab',
    })

    const { container } = render(
      <ChatMessage
        chatId={msg.chatId}
        message={msg}
        hasAnyReasoningDetails={false}
        hasConnection={false}
        onEditInPlace={async () => {}}
      />,
    )

    expect(container.querySelector('[data-ui="message-stream-remote"]')?.textContent).toMatch(
      /currently streaming in another tab/i,
    )
  })

  it('suppresses the original failure banner after an applied successful continuation', () => {
    const msg = makeAssistant()
    const generation = msg.generation
    if (!generation) throw new Error('expected generation metadata')
    msg.generation = {
      ...generation,
      status: 'interrupted',
      abortReason: 'network',
      error: {
        category: 'network',
        code: 'NETWORK',
        message: 'original stream interrupted',
      },
    }
    msg.continuationAttempts = [
      {
        streamId: 'successful-continuation',
        strategy: 'prompt',
        status: 'done',
        startedAt: generation.finishedAt ?? generation.startedAt,
        finishedAt: (generation.finishedAt ?? generation.startedAt) + 1,
      },
    ]

    const { container, getByRole } = render(
      <ChatMessage
        chatId={msg.chatId}
        message={msg}
        hasAnyReasoningDetails={false}
        hasConnection
        onEditInPlace={async () => {}}
        onContinue={async () => {}}
      />,
    )

    expect(container.querySelector('[data-ui="message-error"]')).toBeNull()
    expect(getByRole('button', { name: 'Continue from here' })).toBeTruthy()
  })
})

describe('MessageInfo — Phase B calibration fields', () => {
  it('shows Current chars + Estimated tokens when original fields are populated', () => {
    const { container } = render(
      <MessageInfo
        message={{
          ...makeAssistant(),
          originalCharCount: 200,
          originalTokenEstimate: 57,
          originalModelId: 'anthropic/claude-opus-4.7',
          charCountDelta: 0,
          cachedTokenEstimate: 57,
          cachedMediaTokens: 0,
        }}
      />,
    )
    expect(container.textContent).toMatch(/Current chars/)
    expect(container.textContent).toMatch(/200/)
    expect(container.textContent).toMatch(/Estimated tokens/)
    expect(container.textContent).toMatch(/57 text/)
  })

  it('shows Edit delta only when charCountDelta is non-zero', () => {
    const { container } = render(
      <MessageInfo
        message={{
          ...makeAssistant(),
          originalCharCount: 200,
          originalTokenEstimate: 57,
          originalModelId: 'anthropic/claude-opus-4.7',
          charCountDelta: 37,
          cachedTokenEstimate: 68,
          cachedMediaTokens: 0,
        }}
      />,
    )
    expect(container.textContent).toMatch(/Edit delta/)
    expect(container.textContent).toMatch(/\+37 chars/)
  })

  it('falls back to fresh chars + family-anchor estimate when calibration fields are absent', () => {
    // Pre-Phase-B row: no originalCharCount / cachedTokenEstimate.
    // But MessageInfo still derives chars from content + applies family
    // anchor so the number is visible.
    const msg = makeAssistant()
    msg.content = [{ type: 'text', text: 'A'.repeat(35) }]
    const { container } = render(<MessageInfo message={msg} />)
    expect(container.textContent).toMatch(/Current chars/)
    expect(container.textContent).toMatch(/Estimated tokens \(~\)/)
    // No delta row — message wasn't edited.
    expect(container.textContent).not.toMatch(/Edit delta/)
  })
})

describe('ReasoningBlock', () => {
  it('renders overlap-looking persisted reasoning as distinct rows', () => {
    const { container } = render(
      <ReasoningBlock
        details={[
          { type: 'reasoning.text', index: 0, text: 'Let' },
          { type: 'reasoning.text', index: 0, text: 'Let me' },
        ]}
      />,
    )
    expect(container.querySelector('[data-reasoning-count="2"]')).toBeTruthy()
    expect(container.querySelectorAll('[data-ui="reasoning-row"]')).toHaveLength(2)
    expect(container.textContent).toMatch(/Let/)
    expect(container.textContent).toMatch(/Let me/)
  })
})
