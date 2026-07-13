import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { cursorKeyOf } from '../../src/core/active-path'
import type { Message } from '../../src/core/types'
import { useAnnouncementStore } from '../../src/store/zustand/announcementStore'
import { useChatStore } from '../../src/store/zustand/chatStore'
import { BranchControls } from '../../src/ui/chat/BranchControls'

const CHAT_ID = 'chat-branch-controls'

function message(id: string, siblingIndex: number): Message {
  return {
    id,
    chatId: CHAT_ID,
    parentId: null,
    siblingIndex,
    turnId: `turn-${id}`,
    turnIndex: 0,
    createdAt: siblingIndex,
    role: 'assistant',
    origin: 'generated',
    content: [{ type: 'text', text: id }],
    nodeVersion: 1,
    deleted: false,
  }
}

afterEach(() => {
  useAnnouncementStore.getState().reset()
  useChatStore.getState().reset()
})

describe('BranchControls accessibility', () => {
  it('names unavailable arrows and announces the selected variant once', () => {
    const first = message('message-a', 0)
    const second = message('message-b', 1)
    const messages = [first, second]
    render(
      <BranchControls
        chatId={CHAT_ID}
        message={first}
        context={{
          messages,
          byParent: new Map([[null, messages]]),
          byId: new Map(messages.map((candidate) => [candidate.id, candidate])),
        }}
      />,
    )

    expect(screen.getByRole('button', { name: 'First variant unavailable' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Previous variant unavailable' })).toBeDisabled()

    fireEvent.click(screen.getByRole('link', { name: 'Next variant' }))

    expect(useChatStore.getState().getCursor(CHAT_ID)?.[cursorKeyOf(null)]).toBe(second.id)
    expect(useAnnouncementStore.getState().polite.map((event) => event.text)).toEqual([
      'Variant 2 of 2.',
    ])
  })
})
