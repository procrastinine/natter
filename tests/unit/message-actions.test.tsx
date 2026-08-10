import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GenerationSubmission } from '../../src/app/presentation-interactions'
import { createAppliedMessageView } from '../../src/core/continuation-content'
import type { Message } from '../../src/core/types'
import { MessageActions, MessageEditTreeActions } from '../../src/ui/chat/MessageActions'
import {
  createInteractionSettlementHarness,
  succeededInteractionSettlement,
} from '../helpers/presentation-interactions'

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

function startedGeneration(): GenerationSubmission {
  return Object.freeze({
    kind: 'started',
    admission: Promise.resolve(Object.freeze({ kind: 'admitted' as const })),
    completion: Promise.resolve(Object.freeze({ kind: 'prepared' as const })),
    generationSettled: Promise.resolve(),
    cancel: () => undefined,
  })
}

function generationAction() {
  return vi.fn(() => startedGeneration())
}

function renderActions(props: Partial<Parameters<typeof MessageActions>[0]> = {}) {
  const message = props.message ?? assistantMessage()
  return render(
    <MessageActions
      {...props}
      message={message}
      appliedView={props.appliedView ?? createAppliedMessageView(message)}
      showInfo={props.showInfo ?? false}
      onToggleInfo={props.onToggleInfo ?? (() => {})}
      isEditing={props.isEditing ?? false}
      onBeginEdit={props.onBeginEdit ?? (() => {})}
      onDelete={props.onDelete ?? (() => succeededInteractionSettlement())}
    />,
  )
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.resetAllMocks()
})

describe('MessageActions', () => {
  it('lets a new generation intent replace another request still preparing for the chat', () => {
    const onRegenerate = generationAction()
    const onContinue = generationAction()
    renderActions({
      generationBusy: true,
      onRegenerate,
      onContinue,
    })

    const regenerate = screen.getByRole('button', { name: 'Regenerate response' })
    const continuation = screen.getByRole('button', { name: 'Continue from here' })
    expect(regenerate).toBeEnabled()
    expect(continuation).toBeEnabled()

    fireEvent.click(regenerate)
    fireEvent.click(continuation)

    expect(onRegenerate).toHaveBeenCalledOnce()
    expect(onContinue).toHaveBeenCalledOnce()
  })

  it('keeps generation gestures live while the displayed body is only a retained snapshot', () => {
    const onRegenerate = generationAction()
    const onContinue = generationAction()
    renderActions({
      mutationDisabled: true,
      onRegenerate,
      onContinue,
    })

    const regenerate = screen.getByRole('button', { name: 'Regenerate response' })
    const continuation = screen.getByRole('button', { name: 'Continue from here' })
    expect(regenerate).toBeEnabled()
    expect(continuation).toBeEnabled()

    fireEvent.click(regenerate)
    fireEvent.click(continuation)

    expect(onRegenerate).toHaveBeenCalledOnce()
    expect(onContinue).toHaveBeenCalledOnce()
  })

  it('keeps replacement generation actions live on the active stream target', () => {
    const onRegenerate = generationAction()
    const onContinue = generationAction()
    renderActions({
      streamTargetBusy: true,
      onRegenerate,
      onContinue,
    })

    expect(screen.getByRole('button', { name: 'Edit message' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Delete message' })).toBeDisabled()
    const continuation = screen.getByRole('button', { name: 'Continue from here' })
    const regenerate = screen.getByRole('button', { name: 'Regenerate response' })
    expect(continuation).toBeEnabled()
    expect(regenerate).toBeEnabled()

    fireEvent.click(continuation)
    fireEvent.click(regenerate)

    expect(onContinue).toHaveBeenCalledOnce()
    expect(onRegenerate).toHaveBeenCalledOnce()
  })

  it('turns a pending structural delete into an explicit cancellation action', () => {
    const onCancelStructuralMutation = vi.fn()
    renderActions({
      structuralDisabled: true,
      structuralMutationPending: true,
      onCancelStructuralMutation,
    })

    const cancel = screen.getByRole('button', { name: 'Cancel conversation update' })
    expect(cancel).toBeEnabled()
    fireEvent.click(cancel)

    expect(onCancelStructuralMutation).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
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
      reasoningCarryForward: 'none',
      reasoningVisibility: { disclosure: 'unknown' },
    }
    message.continuationAttempts = [
      {
        streamId: 'successful-continuation',
        strategy: 'prompt',
        status: 'done',
        startedAt: 3,
        finishedAt: 4,
        reasoningCarryForward: 'none',
        reasoningVisibility: { disclosure: 'unknown' },
        application: { kind: 'applied' },
      },
    ]

    renderActions({ message, onContinue: generationAction() })

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

    expect(onCopy).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: 'Copied' })).toBeVisible()
  })

  it('delegates the confirmed default pair delete to its mutation owner', async () => {
    const onDelete = vi.fn(() => succeededInteractionSettlement())
    renderActions({ onDelete })

    fireEvent.click(screen.getByRole('button', { name: 'Delete message' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
      await Promise.resolve()
    })

    expect(onDelete).toHaveBeenCalledWith('pair')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('retains an actionable delete dialog when the mutation owner reports failure', async () => {
    const settlements = createInteractionSettlementHarness()
    const onDelete = vi.fn(() => settlements.fail(new Error('delete denied')))
    renderActions({ onDelete })

    fireEvent.click(screen.getByRole('button', { name: 'Delete message' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(settlements.presented).toHaveLength(1))
    expect(settlements.presented).toEqual([
      { message: 'Test interaction: delete denied', tone: 'danger' },
    ])
    expect(onDelete).toHaveBeenCalledWith('pair')
    expect(screen.getByRole('dialog', { name: 'Delete message?' })).toBeVisible()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled())
  })

  it('forces a role-mismatch confirmation to a single-message delete', async () => {
    const onDelete = vi.fn(() => succeededInteractionSettlement())
    renderActions({ roleMismatch: true, onDelete })

    fireEvent.click(screen.getByRole('button', { name: 'Delete message' }))
    expect(screen.getByRole('checkbox')).toBeDisabled()
    expect(screen.getByRole('checkbox')).not.toBeChecked()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
      await Promise.resolve()
    })

    expect(onDelete).toHaveBeenCalledWith('single')
  })
})

describe('MessageEditTreeActions', () => {
  it('delegates explicit variant and turn deletion modes to its mutation owner', () => {
    const onDelete = vi.fn(() => succeededInteractionSettlement())
    render(<MessageEditTreeActions onDelete={onDelete} />)

    fireEvent.click(screen.getByRole('button', { name: 'Delete variant' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete turn' }))

    expect(onDelete.mock.calls).toEqual([['variant'], ['turn']])
  })

  it('replaces pending edit-tree deletes with the same cancellation owner', () => {
    const onCancelStructuralMutation = vi.fn()
    render(
      <MessageEditTreeActions
        onDelete={() => succeededInteractionSettlement()}
        structuralMutationPending
        onCancelStructuralMutation={onCancelStructuralMutation}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Cancel update' }))

    expect(onCancelStructuralMutation).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: 'Delete variant' })).not.toBeInTheDocument()
  })
})
