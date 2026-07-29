import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Message as MessageRow } from '../../src/core/types'
import { attemptController } from '../../src/store/attempt-controller'
import type { WorkspaceFence } from '../../src/store/presentation-contracts'
import { Message as ChatMessageComponent } from '../../src/ui/chat/Message'
import { collapseProfileFor, nextCollapseMode } from '../../src/ui/chat/MessageStreamOverflow'
import { observeTestAttempt, resetAttemptControllerForTests } from '../helpers/attempt-controller'
import { succeededInteractionSettlement } from '../helpers/presentation-interactions'

const ChatMessage = (
  props: Omit<
    Parameters<typeof ChatMessageComponent>[0],
    'bodyVersion' | 'onBeginEdit' | 'onDeleteMessage' | 'onEditInPlace'
  > & {
    onDeleteMessage?: Parameters<typeof ChatMessageComponent>[0]['onDeleteMessage']
    onEditInPlace?: Parameters<typeof ChatMessageComponent>[0]['onEditInPlace']
  },
) => (
  <ChatMessageComponent
    {...props}
    bodyVersion={props.message.nodeVersion}
    onDeleteMessage={props.onDeleteMessage ?? succeededInteractionSettlement}
    onEditInPlace={props.onEditInPlace ?? succeededInteractionSettlement}
    onBeginEdit={() => ({ admitted: Promise.resolve(), release: () => undefined })}
  />
)

let presentationFence: WorkspaceFence

beforeEach(() => {
  presentationFence = resetAttemptControllerForTests()
})

afterEach(() => {
  resetAttemptControllerForTests()
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
      content: [{ type: 'output_text', text: 'x'.repeat(20_001) }],
    })
    observeTestAttempt({
      streamId: 'stream-1',
      chatId: message.chatId,
      messageId: message.id,
    })

    const { container } = render(
      <ChatMessage
        chatId={message.chatId}
        message={message}
        presentationFence={presentationFence}
        longMessageDisplayMode="compact"
        onEditInPlace={succeededInteractionSettlement}
      />,
    )

    expect(container.querySelector('[data-ui="message"]')?.getAttribute('data-collapse-mode')).toBe(
      'full',
    )
    expect(
      container.querySelector('[data-ui="markdown"]')?.getAttribute('data-streaming'),
    ).toBeNull()
  })

  it('does not collapse or remount an oversized message when its active stream finalizes', () => {
    const message = assistantMessage({
      content: [{ type: 'output_text', text: 'x'.repeat(20_001) }],
    })
    observeTestAttempt({
      streamId: 'stream-1',
      chatId: message.chatId,
      messageId: message.id,
    })

    const props = {
      chatId: message.chatId,
      message,
      presentationFence,
      longMessageDisplayMode: 'compact' as const,
      onEditInPlace: succeededInteractionSettlement,
    }
    const view = render(<ChatMessage {...props} />)
    const markdown = view.container.querySelector<HTMLElement>('[data-ui="markdown"]')
    if (!markdown) throw new Error('missing active stream markdown')
    markdown.dataset.finalizationAnchor = 'retained'

    const attempt = attemptController.get('stream-1')
    if (!attempt?.messageId) throw new Error('missing overflow attempt')
    act(() => {
      attemptController.registerTargetCommitHandoff({
        ...presentationFence,
        streamId: attempt.streamId,
        chatId: attempt.chatId,
        messageId: attempt.messageId,
        attemptKind: attempt.kind,
        admissionSequence: attempt.admissionSequence,
        leaseRevision: attempt.leaseRevision + 1,
        bodyVersion: message.nodeVersion + 1,
      })
    })
    view.rerender(
      <ChatMessage
        {...props}
        message={{
          ...message,
          nodeVersion: message.nodeVersion + 1,
        }}
      />,
    )
    act(() => {
      attemptController.publishExactTargetPresentations([
        {
          ...presentationFence,
          streamId: attempt.streamId,
          chatId: attempt.chatId,
          messageId: attempt.messageId,
          bodyVersion: message.nodeVersion + 1,
        },
      ])
    })

    expect(view.container.querySelector('[data-ui="message"]')).toHaveAttribute(
      'data-collapse-mode',
      'full',
    )
    expect(view.container.querySelector('[data-finalization-anchor="retained"]')).toBe(markdown)
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
