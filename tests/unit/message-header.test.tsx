import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { Message } from '../../src/core/types'
import { MessageHeader } from '../../src/ui/chat/MessageHeader'
import { MessageInfo } from '../../src/ui/chat/MessageInfo'

function makeAssistant(overrides: Partial<Message> = {}): Message {
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
    },
    ...overrides,
  }
}

function makeUser(overrides: Partial<Message> = {}): Message {
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

describe('MessageHeader (quiet header — role + state pills only)', () => {
  it('shows the role label, capitalized', () => {
    const { container } = render(<MessageHeader message={makeAssistant()} />)
    expect(container.querySelector('[data-ui="message-role"]')?.textContent).toBe(
      'Assistant',
    )
  })

  it('does NOT render model/tokens/cost chips inline (those belong in the info disclosure)', () => {
    const { container } = render(<MessageHeader message={makeAssistant()} />)
    expect(container.querySelector('[data-ui="message-model"]')).toBeNull()
    expect(container.querySelector('[data-ui="message-token-count"]')).toBeNull()
    expect(container.querySelector('[data-ui="message-cost"]')).toBeNull()
    expect(container.querySelector('[data-ui="message-timestamp"]')).toBeNull()
  })

  it('shows "edited" badge with the factual-record tooltip when editedAt is set', () => {
    const msg = makeAssistant({ editedAt: Date.now() - 10_000 })
    const { container } = render(<MessageHeader message={msg} />)
    const badge = container.querySelector('[data-ui="message-edited"]')
    expect(badge?.textContent).toBe('edited')
    expect(badge?.getAttribute('title')).toMatch(
      /Edited in place — original token count and cost unchanged\./,
    )
  })

  it('uses "User" for user messages', () => {
    const { container } = render(<MessageHeader message={makeUser()} />)
    expect(container.querySelector('[data-ui="message-role"]')?.textContent).toBe(
      'User',
    )
  })

  it('uses the role label as the header aria-label', () => {
    const { container } = render(<MessageHeader message={makeAssistant()} />)
    const label = container
      .querySelector('[data-ui="message-header"]')
      ?.getAttribute('aria-label')
    expect(label).toBe('Assistant')
  })

  it('adds an "imported" badge when origin === "imported"', () => {
    const msg = makeAssistant({ origin: 'imported' })
    const { container } = render(<MessageHeader message={msg} />)
    expect(container.querySelector('[data-ui="message-imported"]')).toBeTruthy()
  })
})

describe('MessageInfo (revealed by ⓘ — full factual record)', () => {
  it('renders model, prompt+completion+reasoning+cache token counts, and cost', () => {
    const { container } = render(<MessageInfo message={makeAssistant()} />)
    const text = container.textContent ?? ''
    expect(text).toMatch(/anthropic\/claude-opus-4\.7/)
    expect(text).toMatch(/Prompt tokens/)
    expect(text).toMatch(/100/)
    expect(text).toMatch(/Completion tokens/)
    expect(text).toMatch(/412/)
    expect(text).toMatch(/Reasoning tokens/)
    expect(text).toMatch(/64/)
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
})
