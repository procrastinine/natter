import { render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { Message as MessageRow } from '../../src/core/types'
import { useStreamStore } from '../../src/store/zustand/streamStore'
import { Message as ChatMessage } from '../../src/ui/chat/Message'
import {
  collapseProfileFor,
  DEFAULT_OVERFLOW_THRESHOLD,
  MessageStreamOverflow,
  nextCollapseMode,
} from '../../src/ui/chat/MessageStreamOverflow'

afterEach(() => {
  useStreamStore.getState().reset()
})

describe('MessageStreamOverflow', () => {
  it('renders the full children in full mode', () => {
    const { container } = render(
      <MessageStreamOverflow
        collapseMode="full"
        fullChildren={<div>full</div>}
        compactChildren={<div>compact</div>}
        peekChildren={<div>peek</div>}
      />,
    )
    expect(container.textContent).toBe('full')
  })

  it('renders the compact children in compact mode', () => {
    const { container } = render(
      <MessageStreamOverflow
        collapseMode="compact"
        fullChildren={<div>full-sample</div>}
        compactChildren={<div>compact-sample</div>}
        peekChildren={<div>peek-sample</div>}
      />,
    )
    expect(container.textContent).toBe('compact-sample')
  })

  it('renders the peek children in peek mode', () => {
    const { container } = render(
      <MessageStreamOverflow
        collapseMode="peek"
        fullChildren={<div>full-sample</div>}
        compactChildren={<div>compact-sample</div>}
        peekChildren={<div>peek-sample</div>}
      />,
    )
    expect(container.textContent).toBe('peek-sample')
  })
})

describe('collapseProfileFor', () => {
  it('keeps short messages on a simple full/peek cycle', () => {
    expect(collapseProfileFor(500)).toEqual({
      defaultMode: 'full',
      modes: ['full', 'peek'],
      oversized: false,
    })
  })

  it('gives long messages a three-step cycle', () => {
    expect(collapseProfileFor(6_000)).toEqual({
      defaultMode: 'full',
      modes: ['full', 'compact', 'peek'],
      oversized: false,
    })
  })

  it('keeps truly oversized messages expanded by default', () => {
    expect(collapseProfileFor(25_000)).toEqual({
      defaultMode: 'full',
      modes: ['full', 'compact', 'peek'],
      oversized: true,
    })
  })

  it('honors the compact long-message preference', () => {
    expect(collapseProfileFor(6_000, { longMessageDisplayMode: 'compact' })).toEqual({
      defaultMode: 'compact',
      modes: ['full', 'compact', 'peek'],
      oversized: false,
    })
    expect(collapseProfileFor(25_000, { longMessageDisplayMode: 'compact' })).toEqual({
      defaultMode: 'compact',
      modes: ['full', 'compact', 'peek'],
      oversized: true,
    })
  })

  it('keeps truly oversized active streams expanded by default', () => {
    expect(
      collapseProfileFor(25_000, { streaming: true, longMessageDisplayMode: 'compact' }),
    ).toEqual({
      defaultMode: 'full',
      modes: ['full', 'compact', 'peek'],
      oversized: true,
    })
  })
})

describe('nextCollapseMode', () => {
  it('cycles through the available states', () => {
    expect(nextCollapseMode('full', ['full', 'compact', 'peek'])).toBe('compact')
    expect(nextCollapseMode('compact', ['full', 'compact', 'peek'])).toBe('peek')
    expect(nextCollapseMode('peek', ['full', 'compact', 'peek'])).toBe('full')
  })
})

describe('Message active-stream overflow behavior', () => {
  it('does not auto-compact an oversized assistant message while its stream is active', () => {
    const message = assistantMessage({
      content: [{ type: 'output_text', text: 'x'.repeat(DEFAULT_OVERFLOW_THRESHOLD + 1) }],
    })
    useStreamStore.getState().setActive({
      streamId: 'stream-1',
      chatId: message.chatId,
      messageId: message.id,
      startedAt: 1,
      ownerClientId: 'test',
    })

    const { container } = render(
      <ChatMessage
        chatId={message.chatId}
        message={message}
        hasAnyReasoningDetails={false}
        hasSiblingVariants={false}
        cursor={{}}
        hasConnection={false}
        longMessageDisplayMode="compact"
        onEditInPlace={async () => {}}
      />,
    )

    expect(container.querySelector('[data-ui="message"]')?.getAttribute('data-collapse-mode')).toBe(
      'full',
    )
    expect(
      container.querySelector('[data-ui="markdown"]')?.getAttribute('data-streaming'),
    ).toBeNull()
  })
})

function assistantMessage(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id: 'assistant-1',
    chatId: 'chat-1',
    parentId: 'user-1',
    siblingIndex: 0,
    turnId: 'turn-1',
    turnIndex: 0,
    createdAt: 1,
    role: 'assistant',
    origin: 'generated',
    content: [{ type: 'output_text', text: 'partial' }],
    nodeVersion: 0,
    deleted: false,
    ...overrides,
  }
}
