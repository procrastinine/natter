import { act, render, waitFor } from '@testing-library/react'
import { Activity } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import type { Message } from '../../src/core/types'
import { useRetainedMessageStreamProjection } from '../../src/hooks/useMessageStreamProjection'
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
}

function ProjectionProbe({ view }: { view: string }) {
  const [, snapshot] = useRetainedMessageStreamProjection(pendingMessage)
  const content = snapshot?.content ?? pendingMessage.content
  const text = content
    .filter((item) => item.type === 'text' || item.type === 'output_text')
    .map((item) => item.text)
    .join('')
  return <output data-view={view}>{text}</output>
}

function AlternateViews({ visible }: { visible: 'tree' | 'transcript' }) {
  return (
    <>
      <Activity mode={visible === 'tree' ? 'visible' : 'hidden'}>
        <ProjectionProbe view="tree" />
      </Activity>
      <Activity mode={visible === 'transcript' ? 'visible' : 'hidden'}>
        <ProjectionProbe view="transcript" />
      </Activity>
    </>
  )
}

afterEach(() => useStreamStore.getState().reset())

describe('retained message stream projection', () => {
  it('keeps the newest snapshot when live output hands off between retained views', async () => {
    const view = render(<AlternateViews visible="tree" />)
    const tree = () => view.container.querySelector('[data-view="tree"]')
    const transcript = () => view.container.querySelector('[data-view="transcript"]')

    act(() => {
      useStreamStore.getState().setActive({
        streamId: 'projection-stream',
        chatId: pendingMessage.chatId,
        messageId: pendingMessage.id,
        startedAt: 1,
        ownerClientId: 'projection-client',
      })
      useStreamStore.getState().setLiveSnapshot({
        streamId: 'projection-stream',
        chatId: pendingMessage.chatId,
        messageId: pendingMessage.id,
        content: [{ type: 'output_text', text: 'Snapshot five.' }],
        textLength: 14,
        reasoningLength: 0,
        updatedAt: 5,
      })
    })
    await waitFor(() => expect(tree()).toHaveTextContent('Snapshot five.'))

    view.rerender(<AlternateViews visible="transcript" />)
    act(() => {
      useStreamStore.getState().setLiveSnapshot({
        streamId: 'projection-stream',
        chatId: pendingMessage.chatId,
        messageId: pendingMessage.id,
        content: [{ type: 'output_text', text: 'Snapshot ten.' }],
        textLength: 13,
        reasoningLength: 0,
        updatedAt: 10,
      })
    })
    await waitFor(() => expect(transcript()).toHaveTextContent('Snapshot ten.'))

    act(() => {
      useStreamStore.getState().clearLiveSnapshot(pendingMessage.id)
      useStreamStore.getState().clearActive('projection-stream')
    })
    view.rerender(<AlternateViews visible="tree" />)

    expect(tree()).toHaveTextContent('Snapshot ten.')
    expect(tree()).not.toHaveTextContent('Snapshot five.')
  })

  it('does not revive an older stream while a new request is waiting for its first byte', async () => {
    const view = render(<ProjectionProbe view="single" />)
    const projection = () => view.container.querySelector('[data-view="single"]')
    act(() => {
      useStreamStore.getState().setActive({
        streamId: 'old-stream',
        chatId: pendingMessage.chatId,
        messageId: pendingMessage.id,
        startedAt: 1,
        ownerClientId: 'projection-client',
      })
      useStreamStore.getState().setLiveSnapshot({
        streamId: 'old-stream',
        chatId: pendingMessage.chatId,
        messageId: pendingMessage.id,
        content: [{ type: 'output_text', text: 'Old live output.' }],
        textLength: 16,
        reasoningLength: 0,
        updatedAt: 5,
      })
    })
    await waitFor(() => expect(projection()).toHaveTextContent('Old live output.'))

    act(() => {
      useStreamStore.getState().clearLiveSnapshot(pendingMessage.id)
      useStreamStore.getState().clearActive('old-stream')
      useStreamStore.getState().setActive({
        streamId: 'new-stream',
        chatId: pendingMessage.chatId,
        messageId: pendingMessage.id,
        startedAt: 2,
        ownerClientId: 'projection-client',
      })
    })

    await waitFor(() => expect(projection()).toHaveTextContent('Persisted before streaming.'))
    expect(projection()).not.toHaveTextContent('Old live output.')
  })
})
