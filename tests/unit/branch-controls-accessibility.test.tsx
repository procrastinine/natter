import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createActiveBranchSpine } from '../../src/core/active-branch-spine'
import type { Message } from '../../src/core/types'
import { splitMessageForStorage } from '../../src/store/message-storage'
import { useAnnouncementStore } from '../../src/store/zustand/announcementStore'
import { BranchControls } from '../../src/ui/chat/BranchControls'

const cursor = vi.hoisted(() => ({
  navigateMessage: vi.fn(),
  navigateSiblingPosition: vi.fn(),
  resolveSiblingPosition: vi.fn(),
}))

vi.mock('../../src/hooks/useConversationCursor', () => ({
  navigateConversationMessage: cursor.navigateMessage,
  navigateConversationSiblingPosition: cursor.navigateSiblingPosition,
  resolveConversationSiblingPosition: cursor.resolveSiblingPosition,
}))

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
  vi.clearAllMocks()
})

describe('BranchControls accessibility', () => {
  it('names unavailable arrows and announces the selected variant once', () => {
    const first = message('message-a', 0)
    const second = message('message-b', 1)
    const firstHeader = splitMessageForStorage(first).header
    const context = createActiveBranchSpine({
      chatId: CHAT_ID,
      structuralVersion: 1,
      resolvedLeafId: first.id,
      headers: [firstHeader],
    }).replaceForks([
      {
        parentId: null,
        selectedMessageId: first.id,
        slotVersion: 1,
        position: 0,
        liveCount: 2,
        previousMessageId: null,
        nextMessageId: second.id,
        firstMessageId: first.id,
        lastMessageId: second.id,
      },
    ])
    const fork = context.forkFor(first.id)
    if (!fork) throw new Error('missing fork')
    render(<BranchControls chatId={CHAT_ID} message={first} context={fork} />)

    expect(screen.getByRole('button', { name: 'First variant unavailable' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Previous variant unavailable' })).toBeDisabled()

    fireEvent.click(screen.getByRole('link', { name: 'Next variant' }))

    expect(cursor.navigateMessage).toHaveBeenCalledWith(CHAT_ID, second.id)
    expect(useAnnouncementStore.getState().polite.map((event) => event.text)).toEqual([
      'Variant 2 of 2.',
    ])
  })
})
