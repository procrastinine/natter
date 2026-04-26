import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { effectiveCapabilityFromEndpoints } from '../../src/core/capabilities'
import type { Message as MessageRow, ModelEndpoint } from '../../src/core/types'
import { Message as ChatMessage } from '../../src/ui/chat/Message'
import { MessageHeader } from '../../src/ui/chat/MessageHeader'
import { MessageInfo } from '../../src/ui/chat/MessageInfo'
import { ReasoningBlock } from '../../src/ui/chat/ReasoningBlock'

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
    const text = container.textContent ?? ''
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
    const text = container.textContent ?? ''
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

  it('dedupes mirrored reasoning text when counting fallback reasoning chars', () => {
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
    expect(container.textContent).toMatch(/text 6/)
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
        hasSiblingVariants={false}
        cursor={{}}
        hasConnection={false}
        capability={currentCapability}
        onEditInPlace={async () => {}}
      />,
    )
    expect(container.querySelector('[data-ui="message-hidden-reasoning"]')?.textContent).toMatch(
      /reasoned internally/i,
    )
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
  it('dedupes mirrored Claude reasoning rows before rendering', () => {
    const { container } = render(
      <ReasoningBlock
        details={[
          { type: 'reasoning.text', index: 0, text: 'Let' },
          { type: 'reasoning.text', index: 0, text: 'Let me' },
        ]}
      />,
    )
    expect(container.querySelector('[data-reasoning-count="1"]')).toBeTruthy()
    expect(container.textContent).toMatch(/Let me/)
    expect(container.textContent).not.toMatch(/LetLet me/)
  })
})
