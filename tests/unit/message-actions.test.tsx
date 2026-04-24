import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Message } from '../../src/core/types'
import { MessageActions } from '../../src/ui/chat/MessageActions'

function assistantMessage(): Message {
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
  }
}

describe('MessageActions', () => {
  it('disables generation actions while another request is active for the chat', () => {
    render(
      <MessageActions
        message={assistantMessage()}
        showInfo={false}
        onToggleInfo={() => {}}
        isEditing={false}
        onBeginEdit={() => {}}
        hasConnection
        generationBusy
        onRegenerate={vi.fn()}
        onContinue={vi.fn()}
        chatId="chat-1"
        cursor={{}}
      />,
    )

    expect(screen.getByRole('button', { name: 'Regenerate response' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Continue from here' })).toBeDisabled()
  })
})
