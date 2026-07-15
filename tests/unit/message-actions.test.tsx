import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '../../src/core/types'
import { splitMessageForStorage } from '../../src/store/message-storage'
import { useChatStore } from '../../src/store/zustand/chatStore'
import { __setPersistentCursorEnumerationProbeForTests } from '../../src/store/zustand/persistentCursor'
import { useToastStore } from '../../src/store/zustand/toastStore'
import { MessageActions } from '../../src/ui/chat/MessageActions'

const deleteMocks = vi.hoisted(() => ({
  pair: vi.fn(),
  single: vi.fn(),
  turn: vi.fn(),
  variant: vi.fn(),
}))

const undoMocks = vi.hoisted(() => ({ apply: vi.fn() }))

vi.mock('../../src/hooks/useMessageOps', () => ({
  deletePairOp: deleteMocks.pair,
  deleteSingleOp: deleteMocks.single,
  deleteTurnOp: deleteMocks.turn,
  deleteVariantOp: deleteMocks.variant,
}))

vi.mock('../../src/core/undo', () => ({
  applyStructuralSnapshot: undoMocks.apply,
}))

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

function restoredDeletePresentation() {
  const assistant = assistantMessage()
  const root: Message = {
    ...assistant,
    id: 'user-1',
    parentId: null,
    role: 'user',
    origin: 'user',
    content: [{ type: 'text', text: 'prompt' }],
  }
  const child: Message = {
    ...root,
    id: 'child-1',
    parentId: assistant.id,
    content: [{ type: 'text', text: 'child' }],
  }
  const presentations = [root, assistant, child].map((message) => {
    const { header } = splitMessageForStorage(message)
    return { header, message, bodyVersion: header.bodyVersion }
  })
  return {
    selectedPathHeaders: presentations.map((presentation) => presentation.header),
    structuralHeaders: presentations.map((presentation) => presentation.header),
    presentations,
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
      {...props}
    />,
  )
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.resetAllMocks()
  __setPersistentCursorEnumerationProbeForTests(undefined)
  useChatStore.getState().reset()
  useToastStore.getState().reset()
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

  it('blocks edits, Continue, and deletion only on the active stream target', () => {
    renderActions({
      streamTargetBusy: true,
      onRegenerate: vi.fn(),
      onContinue: vi.fn(),
    })

    expect(screen.getByRole('button', { name: 'Edit message' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Continue from here' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Delete message' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Regenerate response' })).toBeEnabled()
  })

  it('treats an applied successful continuation as resolving the original partial state', () => {
    const message = assistantMessage()
    message.generation = {
      id: 'original-generation',
      model: 'model',
      requestedModel: 'model',
      apiUsed: 'chat',
      delivery: 'streaming',
      costSource: 'stream',
      startedAt: 1,
      finishedAt: 2,
      abortReason: 'network',
    }
    message.continuationAttempts = [
      {
        streamId: 'successful-continuation',
        strategy: 'prompt',
        status: 'done',
        startedAt: 3,
        finishedAt: 4,
      },
    ]

    renderActions({ message, onContinue: vi.fn() })

    expect(screen.getByRole('button', { name: 'Continue from here' })).toHaveAttribute(
      'title',
      'Continue this assistant message',
    )
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

  it('applies delete cursor effects without letting undo overwrite later navigation', async () => {
    const priorCursor = {
      __root__: 'user-1',
      'user-1': 'assistant-1',
      'assistant-1': 'child-1',
    }
    useChatStore.getState().navigateToCursor('chat-1', priorCursor)
    let resolveDelete: ((value: unknown) => void) | undefined
    const pendingDelete = new Promise((resolve) => {
      resolveDelete = resolve
    })
    deleteMocks.pair.mockReturnValue(pendingDelete)
    undoMocks.apply.mockResolvedValue(undefined)
    renderActions()

    fireEvent.click(screen.getByRole('button', { name: 'Delete message' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(deleteMocks.pair).toHaveBeenCalledWith({
      chatId: 'chat-1',
      messageId: 'assistant-1',
      cursor: priorCursor,
    })
    const cursorEnumeration = vi.fn()
    __setPersistentCursorEnumerationProbeForTests(cursorEnumeration)

    const preImage = {
      chatId: 'chat-1',
      previousRows: [assistantMessage()],
      newMessageIds: [],
      attachmentIds: [],
    }
    await act(async () => {
      resolveDelete?.({
        effects: {
          cursorUpdates: { 'user-1': 'replacement' },
          cursorRemoveKeys: ['assistant-1'],
          newMessageIds: [],
          tombstoned: ['assistant-1'],
          reparented: [],
        },
        versions: { metaVersion: 1, summaryVersion: 1 },
        preImage,
        selectedPathHeaders: [],
        structuralHeaders: [],
        presentations: [],
      })
      await pendingDelete
    })

    expect(cursorEnumeration).not.toHaveBeenCalled()
    __setPersistentCursorEnumerationProbeForTests(undefined)
    expect(useChatStore.getState().getCursor('chat-1')).toEqual({
      __root__: 'user-1',
      'user-1': 'replacement',
    })
    const toast = useToastStore.getState().toasts.at(-1)
    expect(toast?.text).toBe('Deleted pair.')
    let resolveUndo: ((value: ReturnType<typeof restoredDeletePresentation>) => void) | undefined
    const pendingUndo = new Promise<ReturnType<typeof restoredDeletePresentation>>((resolve) => {
      resolveUndo = resolve
    })
    undoMocks.apply.mockReturnValueOnce(pendingUndo)
    let undoPromise: Promise<void> | undefined
    await act(async () => {
      undoPromise = Promise.resolve(toast?.undo?.())
      await Promise.resolve()
    })
    const laterCursor = { __root__: 'other-root', 'other-root': 'other-leaf' }
    useChatStore.getState().navigateToCursor('chat-1', laterCursor)
    resolveUndo?.(restoredDeletePresentation())
    await act(async () => undoPromise)
    expect(undoMocks.apply).toHaveBeenCalledWith(preImage, {
      cursor: priorCursor,
      presentationWindowLimit: 10,
    })
    expect(useChatStore.getState().getCursor('chat-1')).toEqual(laterCursor)
  })

  it('restores the pre-delete cursor when undo remains the latest local intent', async () => {
    const priorCursor = {
      __root__: 'user-1',
      'user-1': 'assistant-1',
      'assistant-1': 'child-1',
    }
    useChatStore.getState().navigateToCursor('chat-1', priorCursor)
    undoMocks.apply.mockResolvedValue(restoredDeletePresentation())
    deleteMocks.pair.mockResolvedValue({
      effects: {
        cursorUpdates: { 'user-1': 'child-1' },
        cursorRemoveKeys: ['assistant-1'],
        newMessageIds: [],
        tombstoned: ['assistant-1'],
        reparented: [],
      },
      versions: { metaVersion: 1, summaryVersion: 1 },
      preImage: {
        chatId: 'chat-1',
        previousRows: [assistantMessage()],
        newMessageIds: [],
        attachmentIds: [],
      },
      selectedPathHeaders: [],
      structuralHeaders: [],
      presentations: [],
    })
    renderActions()

    fireEvent.click(screen.getByRole('button', { name: 'Delete message' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
      await Promise.resolve()
    })
    const cursorEnumeration = vi.fn()
    __setPersistentCursorEnumerationProbeForTests(cursorEnumeration)
    await act(async () => {
      await useToastStore.getState().toasts.at(-1)?.undo?.()
    })

    expect(cursorEnumeration).not.toHaveBeenCalled()
    __setPersistentCursorEnumerationProbeForTests(undefined)
    expect(useChatStore.getState().getCursor('chat-1')).toEqual(priorCursor)
    expect(
      useChatStore
        .getState()
        .getCommittedPathPresentation('chat-1')
        ?.pathHeaders.map((header) => header.id),
    ).toEqual(['user-1', 'assistant-1', 'child-1'])
  })

  it('does not let a delayed delete overwrite newer navigation', async () => {
    const priorCursor = { __root__: 'root', root: 'assistant-1' }
    useChatStore.getState().navigateToCursor('chat-1', priorCursor)
    let resolveDelete: ((value: unknown) => void) | undefined
    const pendingDelete = new Promise((resolve) => {
      resolveDelete = resolve
    })
    deleteMocks.pair.mockReturnValue(pendingDelete)
    renderActions()

    fireEvent.click(screen.getByRole('button', { name: 'Delete message' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    const laterCursor = { __root__: 'other-root', 'other-root': 'other-leaf' }
    useChatStore.getState().navigateToCursor('chat-1', laterCursor)

    await act(async () => {
      resolveDelete?.({
        effects: {
          cursorUpdates: { root: 'replacement' },
          cursorRemoveKeys: [],
          newMessageIds: [],
          tombstoned: ['assistant-1'],
          reparented: [],
        },
        versions: { metaVersion: 1, summaryVersion: 1 },
        preImage: {
          chatId: 'chat-1',
          previousRows: [assistantMessage()],
          newMessageIds: [],
          attachmentIds: [],
        },
        selectedPathHeaders: [],
        structuralHeaders: [],
        presentations: [],
      })
      await pendingDelete
    })

    expect(useChatStore.getState().getCursor('chat-1')).toEqual(laterCursor)
  })

  it('leaves the cursor unchanged when delete is rejected', async () => {
    const priorCursor = { __root__: 'root', 'user-1': 'assistant-1' }
    useChatStore.getState().navigateToCursor('chat-1', priorCursor)
    deleteMocks.pair.mockRejectedValue(new Error('tree changed'))
    renderActions()

    fireEvent.click(screen.getByRole('button', { name: 'Delete message' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
      await Promise.resolve()
    })

    expect(useChatStore.getState().getCursor('chat-1')).toEqual(priorCursor)
    expect(useToastStore.getState().toasts.at(-1)).toMatchObject({
      level: 'danger',
      text: 'Delete failed: tree changed',
    })
    expect(undoMocks.apply).not.toHaveBeenCalled()
  })
})
