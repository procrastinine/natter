import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAppliedMessageView } from '../../src/core/continuation-content'
import {
  AVAILABLE_GENERATION_CAPABILITY,
  failedGenerationCapability,
  type NonReadyGenerationCapability,
  pendingGenerationCapability,
  unavailableGenerationCapability,
} from '../../src/core/interaction-capability'
import type { Message } from '../../src/core/types'
import type { GenerationStartResult } from '../../src/store/generation-engine'
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

function startedGeneration(): GenerationStartResult {
  const prepared = Object.freeze({
    streamId: 'stream-1',
    chatId: 'chat-1',
    assistantMessageId: 'assistant-1',
  })
  return Object.freeze({
    kind: 'started',
    handle: Object.freeze({
      streamId: prepared.streamId,
      chatId: prepared.chatId,
      prepared: Promise.resolve(prepared),
      completed: Promise.resolve(Object.freeze({ ...prepared, outcome: 'done' as const })),
    }),
  })
}

function generationAction() {
  return vi.fn(() => startedGeneration())
}

const NON_READY_ACTION_CASES = [
  ['pending', 'regenerate', pendingGenerationCapability('prompt-path')],
  ['pending', 'continue', pendingGenerationCapability('prompt-path')],
  ['unavailable', 'regenerate', unavailableGenerationCapability('target-unavailable')],
  ['unavailable', 'continue', unavailableGenerationCapability('target-unavailable')],
  ['failed', 'regenerate', failedGenerationCapability('configuration')],
  ['failed', 'continue', failedGenerationCapability('configuration')],
] as const satisfies readonly (readonly [
  'pending' | 'unavailable' | 'failed',
  'regenerate' | 'continue',
  NonReadyGenerationCapability,
])[]

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
      regenerateCapability={props.regenerateCapability ?? AVAILABLE_GENERATION_CAPABILITY}
      continueCapability={props.continueCapability ?? AVAILABLE_GENERATION_CAPABILITY}
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
  it('disables generation actions while another request is active for the chat', () => {
    renderActions({
      generationBusy: true,
      onRegenerate: generationAction(),
      onContinue: generationAction(),
    })

    expect(screen.getByRole('button', { name: 'Regenerate response' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Continue from here' })).toBeDisabled()
  })

  it('blocks every target-mutating action on the active stream target', () => {
    renderActions({
      streamTargetBusy: true,
      onRegenerate: generationAction(),
      onContinue: generationAction(),
    })

    expect(screen.getByRole('button', { name: 'Edit message' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Continue from here' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Delete message' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Regenerate response' })).toBeDisabled()
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

  it.each(
    NON_READY_ACTION_CASES,
  )('keeps unrelated actions live when %s blocks only %s', (_state, blockedAction, capability) => {
    const onRegenerate = generationAction()
    const onContinue = generationAction()
    renderActions({
      regenerateCapability:
        blockedAction === 'regenerate' ? capability : AVAILABLE_GENERATION_CAPABILITY,
      continueCapability:
        blockedAction === 'continue' ? capability : AVAILABLE_GENERATION_CAPABILITY,
      onRegenerate,
      onContinue,
    })

    const regenerate = screen.getByRole('button', { name: 'Regenerate response' })
    const continuation = screen.getByRole('button', { name: 'Continue from here' })
    const blocked = blockedAction === 'regenerate' ? regenerate : continuation
    const independent = blockedAction === 'regenerate' ? continuation : regenerate

    expect(blocked).toBeDisabled()
    expect(independent).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Edit message' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Delete message' })).toBeEnabled()

    fireEvent.click(blocked)
    fireEvent.click(independent)

    expect(blockedAction === 'regenerate' ? onRegenerate : onContinue).not.toHaveBeenCalled()
    expect(blockedAction === 'regenerate' ? onContinue : onRegenerate).toHaveBeenCalledOnce()
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
})
