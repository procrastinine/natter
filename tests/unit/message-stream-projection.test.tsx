import { act, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '../../src/core/types'
import { useMessageStreamProjection } from '../../src/hooks/useMessageStreamProjection'
import { useStreamStore } from '../../src/store/zustand/streamStore'

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
    startedAt: 1,
  },
}

function ProjectionProbe({ message = pendingMessage }: { message?: Message }) {
  const [, snapshot] = useMessageStreamProjection(message)
  const content = snapshot?.content ?? message.content
  const text = content
    .filter((item) => item.type === 'text' || item.type === 'output_text')
    .map((item) => item.text)
    .join('')
  return <output>{text}</output>
}

function setActiveStream(attemptKind: 'generation' | 'continuation'): void {
  useStreamStore.getState().setActive({
    streamId: 'projection-stream',
    replacementEpoch: 0,
    chatId: pendingMessage.chatId,
    messageId: pendingMessage.id,
    attemptKind,
    startedAt: 1,
    ownerClientId: 'projection-client',
  })
}

function setLiveSnapshot(text: string): void {
  useStreamStore.getState().setLiveSnapshot({
    streamId: 'projection-stream',
    replacementEpoch: 0,
    chatId: pendingMessage.chatId,
    messageId: pendingMessage.id,
    content: [{ type: 'output_text', text }],
    textLength: text.length,
    reasoningLength: 0,
    updatedAt: 2,
  })
}

afterEach(() => {
  useStreamStore.getState().reset()
  vi.restoreAllMocks()
})

describe('message stream projection', () => {
  it('shows the current snapshot for an active generation placeholder', () => {
    act(() => {
      setActiveStream('generation')
      setLiveSnapshot('Generation live output.')
    })

    const view = render(<ProjectionProbe />)

    expect(view.getByText('Generation live output.')).toBeInTheDocument()
    expect(view.queryByText('Persisted before streaming.')).not.toBeInTheDocument()
  })

  it('does not revive an older snapshot while a replacement waits for its first byte', () => {
    act(() => {
      setActiveStream('generation')
      setLiveSnapshot('Superseded live output.')
    })
    const view = render(<ProjectionProbe />)
    expect(view.getByText('Superseded live output.')).toBeInTheDocument()

    act(() => {
      useStreamStore.getState().clearActive('projection-stream', 0)
      useStreamStore.getState().setActive({
        streamId: 'replacement-stream',
        replacementEpoch: 0,
        chatId: pendingMessage.chatId,
        messageId: pendingMessage.id,
        attemptKind: 'generation',
        startedAt: 3,
        ownerClientId: 'projection-client',
      })
    })

    expect(view.getByText('Persisted before streaming.')).toBeInTheDocument()
    expect(view.queryByText('Superseded live output.')).not.toBeInTheDocument()
  })

  it('uses canonical content when first observing a generation after its body committed', () => {
    const generation = pendingMessage.generation
    if (!generation) throw new Error('Expected generation metadata')
    act(() => {
      setActiveStream('generation')
      setLiveSnapshot('Stale terminal live output.')
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
      setLiveSnapshot('Persisted before streaming. Continued live output.')
    })
    const view = render(<ProjectionProbe message={completed} />)
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
          startedAt: 1,
          finishedAt: 3,
        },
      ],
    }
    view.rerender(<ProjectionProbe message={committed} />)

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
      setLiveSnapshot('Transient live output.')
    })
    const view = render(<ProjectionProbe />)
    expect(view.getByText('Transient live output.')).toBeInTheDocument()

    act(() => {
      useStreamStore.getState().clearLiveSnapshot(pendingMessage.id, 'projection-stream', 0)
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
      useStreamStore
        .getState()
        .setLiveSnapshotRequester('projection-stream', 0, requestLiveSnapshot)
    })
    await waitFor(() => expect(requestLiveSnapshot).toHaveBeenCalledTimes(1))

    visibility = 'hidden'
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(requestLiveSnapshot).toHaveBeenCalledTimes(1)

    visibility = 'visible'
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    await waitFor(() => expect(requestLiveSnapshot).toHaveBeenCalledTimes(2))
  })
})
