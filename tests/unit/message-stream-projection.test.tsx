import { act, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '../../src/core/types'
import { useMessageStreamProjection } from '../../src/hooks/useMessageStreamProjection'
import { attemptController } from '../../src/store/attempt-controller'
import type { WorkspaceFence } from '../../src/store/presentation-contracts'
import {
  clearTestLiveProjection,
  observeTestAttempt,
  publishTestLiveProjection,
  removeTestAttempt,
  resetAttemptControllerForTests,
} from '../helpers/attempt-controller'

const pendingMessage: Message = {
  id: 'projection-message',
  chatId: 'projection-chat',
  parentId: null,
  siblingIndex: 0,
  turnId: 'projection-turn',
  turnIndex: 0,
  createdAt: 1,
  role: 'assistant',
  origin: 'generated',
  content: [{ type: 'output_text', text: 'Persisted before streaming.' }],
  nodeVersion: 0,
  deleted: false,
  generation: {
    id: 'projection-generation',
    model: 'test/model',
    requestedModel: 'test/model',
    apiUsed: 'chat',
    delivery: 'streaming',
    status: 'streaming',
    costSource: 'stream',
    reasoningCarryForward: 'none',
    reasoningVisibility: { disclosure: 'unknown' },
    startedAt: 1,
  },
}

let workspaceFence: WorkspaceFence

function ProjectionProbe({ message = pendingMessage }: { message?: Message }) {
  const { execution, presentation, liveProjection } = useMessageStreamProjection(
    message,
    workspaceFence,
  )
  const content = liveProjection?.content ?? message.content
  const text = content
    .filter((item) => item.type === 'text' || item.type === 'output_text')
    .map((item) => item.text)
    .join('')
  return (
    <output
      data-execution={execution?.streamId ?? 'none'}
      data-presentation={presentation?.streamId ?? 'none'}
    >
      {text}
    </output>
  )
}

function setActiveStream(attemptKind: 'generation' | 'continuation'): void {
  observeTestAttempt({
    streamId: 'projection-stream',
    chatId: pendingMessage.chatId,
    messageId: pendingMessage.id,
    kind: attemptKind,
  })
}

function setLiveSnapshot(text: string): void {
  publishTestLiveProjection({
    streamId: 'projection-stream',
    chatId: pendingMessage.chatId,
    messageId: pendingMessage.id,
    content: [{ type: 'output_text', text }],
  })
}

function registerTargetCommitHandoff(bodyVersion: number): void {
  const attempt = attemptController.get('projection-stream')
  if (!attempt?.messageId) throw new Error('Expected active projection attempt')
  attemptController.registerTargetCommitHandoff({
    ...workspaceFence,
    streamId: attempt.streamId,
    chatId: attempt.chatId,
    messageId: attempt.messageId,
    attemptKind: attempt.kind,
    admissionSequence: attempt.admissionSequence,
    leaseRevision: attempt.leaseRevision + 1,
    bodyVersion,
  })
}

function publishExactTarget(bodyVersion: number): void {
  attemptController.publishExactTargetPresentations([
    {
      ...workspaceFence,
      streamId: 'projection-stream',
      chatId: pendingMessage.chatId,
      messageId: pendingMessage.id,
      bodyVersion,
    },
  ])
}

beforeEach(() => {
  workspaceFence = resetAttemptControllerForTests()
})

afterEach(() => {
  resetAttemptControllerForTests()
  vi.restoreAllMocks()
})

describe('message stream projection', () => {
  it('shows the current snapshot for an active generation placeholder', () => {
    act(() => {
      setActiveStream('generation')
    })

    const view = render(<ProjectionProbe />)
    act(() => setLiveSnapshot('Generation live output.'))

    expect(view.getByText('Generation live output.')).toBeInTheDocument()
    expect(view.queryByText('Persisted before streaming.')).not.toBeInTheDocument()
  })

  it('does not revive an older snapshot while a replacement waits for its first byte', () => {
    act(() => {
      setActiveStream('generation')
    })
    const view = render(<ProjectionProbe />)
    act(() => setLiveSnapshot('Superseded live output.'))
    expect(view.getByText('Superseded live output.')).toBeInTheDocument()

    act(() => {
      removeTestAttempt('projection-stream')
      observeTestAttempt({
        streamId: 'replacement-stream',
        chatId: pendingMessage.chatId,
        messageId: pendingMessage.id,
        kind: 'generation',
      })
    })

    expect(view.getByText('Persisted before streaming.')).toBeInTheDocument()
    expect(view.queryByText('Superseded live output.')).not.toBeInTheDocument()
  })

  it('keeps live generation output until the exact committed body is published', () => {
    const generation = pendingMessage.generation
    if (!generation) throw new Error('Expected generation metadata')
    act(() => {
      setActiveStream('generation')
    })
    const committed: Message = {
      ...pendingMessage,
      content: [{ type: 'output_text', text: 'Canonical terminal output.' }],
      nodeVersion: pendingMessage.nodeVersion + 1,
      generation: {
        ...generation,
        status: 'done',
        finishedAt: 3,
      },
    }

    const view = render(<ProjectionProbe message={committed} />)
    act(() => setLiveSnapshot('Stale terminal live output.'))

    expect(view.getByText('Stale terminal live output.')).toBeInTheDocument()
    act(() => registerTargetCommitHandoff(4))
    expect(view.getByText('Stale terminal live output.')).toHaveAttribute(
      'data-presentation',
      'projection-stream',
    )
    expect(view.getByText('Stale terminal live output.')).toHaveAttribute('data-execution', 'none')
    act(() => publishExactTarget(4))
    expect(view.getByText('Canonical terminal output.')).toBeInTheDocument()
    expect(view.queryByText('Stale terminal live output.')).not.toBeInTheDocument()
  })

  it('keeps an active continuation live until its matching attempt commits', () => {
    const generation = pendingMessage.generation
    if (!generation) throw new Error('Expected generation metadata')
    const completed: Message = {
      ...pendingMessage,
      generation: {
        ...generation,
        status: 'done',
        finishedAt: 2,
      },
    }
    act(() => {
      setActiveStream('continuation')
    })
    const view = render(<ProjectionProbe message={completed} />)
    act(() => setLiveSnapshot('Persisted before streaming. Continued live output.'))
    expect(view.getByText('Persisted before streaming. Continued live output.')).toBeInTheDocument()

    const committed: Message = {
      ...completed,
      content: [
        { type: 'output_text', text: 'Persisted before streaming. Canonical continuation.' },
      ],
      nodeVersion: completed.nodeVersion + 1,
      continuationAttempts: [
        {
          streamId: 'projection-stream',
          strategy: 'prompt',
          status: 'done',
          reasoningCarryForward: 'none',
          reasoningVisibility: { disclosure: 'unknown' },
          application: { kind: 'applied' },
          startedAt: 1,
          finishedAt: 3,
        },
      ],
    }
    view.rerender(<ProjectionProbe message={committed} />)

    expect(view.getByText('Persisted before streaming. Continued live output.')).toBeInTheDocument()
    act(() => registerTargetCommitHandoff(5))
    expect(view.getByText('Persisted before streaming. Continued live output.')).toBeInTheDocument()
    act(() => publishExactTarget(5))
    expect(
      view.getByText('Persisted before streaming. Canonical continuation.'),
    ).toBeInTheDocument()
    expect(
      view.queryByText('Persisted before streaming. Continued live output.'),
    ).not.toBeInTheDocument()
  })

  it('falls back to canonical content as soon as the current snapshot clears', () => {
    act(() => {
      setActiveStream('generation')
    })
    const view = render(<ProjectionProbe />)
    act(() => setLiveSnapshot('Transient live output.'))
    expect(view.getByText('Transient live output.')).toBeInTheDocument()

    act(() => {
      clearTestLiveProjection('projection-stream')
    })

    expect(view.getByText('Persisted before streaming.')).toBeInTheDocument()
    expect(view.queryByText('Transient live output.')).not.toBeInTheDocument()
  })

  it('requests one current snapshot on mount and again when the document becomes visible', async () => {
    let visibility: DocumentVisibilityState = 'visible'
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
    const requestLiveSnapshot = vi.fn(async () => {})
    act(() => {
      setActiveStream('generation')
    })

    render(<ProjectionProbe />)
    expect(requestLiveSnapshot).not.toHaveBeenCalled()

    act(() => {
      attemptController.setLiveProjectionRequester('projection-stream', requestLiveSnapshot)
    })
    await waitFor(() => expect(requestLiveSnapshot).toHaveBeenCalledTimes(1))

    visibility = 'hidden'
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(requestLiveSnapshot).toHaveBeenCalledTimes(1)

    visibility = 'visible'
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await waitFor(() => expect(requestLiveSnapshot).toHaveBeenCalledTimes(2))
  })
})
