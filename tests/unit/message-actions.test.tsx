import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
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

function renderActions(props: Partial<Parameters<typeof MessageActions>[0]> = {}) {
  return render(
    <MessageActions
      message={assistantMessage()}
      showInfo={false}
      onToggleInfo={() => {}}
      isEditing={false}
      onBeginEdit={() => {}}
      hasConnection
      chatId="chat-1"
      cursor={{}}
      {...props}
    />,
  )
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('MessageActions', () => {
  it('disables generation actions while another request is active for the chat', () => {
    renderActions({
      generationBusy: true,
      onRegenerate: vi.fn(),
      onContinue: vi.fn(),
    })

    expect(screen.getByRole('button', { name: 'Regenerate response' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Continue from here' })).toBeDisabled()
  })

  it('shows a temporary copied state after writing message text to the clipboard', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    renderActions()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy message' }))
      await Promise.resolve()
    })

    expect(writeText).toHaveBeenCalledWith('partial')
    expect(screen.getByRole('button', { name: 'Copied' })).toHaveAttribute('title', 'Copied')

    act(() => {
      vi.advanceTimersByTime(2500)
    })

    expect(screen.getByRole('button', { name: 'Copy message' })).toHaveAttribute('title', 'Copy')
  })

  it('shows the copied state after a custom copy handler succeeds', async () => {
    const onCopy = vi.fn().mockResolvedValue(undefined)
    renderActions({ onCopy })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy message' }))
      await Promise.resolve()
    })

    expect(onCopy).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy()
  })
})
