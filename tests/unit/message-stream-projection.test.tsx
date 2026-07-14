import { act, render, waitFor } from '@testing-library/react'
import { Activity } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import type { Message } from '../../src/core/types'
import {
  __resetMessageStreamProjectionForTests,
  useRetainedMessageStreamProjection,
} from '../../src/hooks/useMessageStreamProjection'
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

function ProjectionProbe({
  view,
  message = pendingMessage,
  bodyVersion = 0,
}: {
  view: string
  message?: Message
  bodyVersion?: number
}) {
  const [, snapshot] = useRetainedMessageStreamProjection(message, bodyVersion)
  const content = snapshot?.content ?? message.content
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

afterEach(() => {
  useStreamStore.getState().reset()
  __resetMessageStreamProjectionForTests()
})

describe('retained message stream projection', () => {
  it('keeps the newest snapshot when live output hands off between retained views', async () => {
    const view = render(<AlternateViews visible="tree" />)
    const tree = () => view.container.querySelector('[data-view="tree"]')
    const transcript = () => view.container.querySelector('[data-view="transcript"]')

    act(() => {
      useStreamStore.getState().setActive({
        streamId: 'projection-stream',
        replacementEpoch: 0,
        chatId: pendingMessage.chatId,
        messageId: pendingMessage.id,
        startedAt: 1,
        ownerClientId: 'projection-client',
      })
      useStreamStore.getState().setLiveSnapshot({
        streamId: 'projection-stream',
        replacementEpoch: 0,
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
        replacementEpoch: 0,
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
      useStreamStore.getState().clearLiveSnapshot(pendingMessage.id, 'projection-stream', 0)
      useStreamStore.getState().clearActive('projection-stream', 0)
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
        replacementEpoch: 0,
        chatId: pendingMessage.chatId,
        messageId: pendingMessage.id,
        startedAt: 1,
        ownerClientId: 'projection-client',
      })
      useStreamStore.getState().setLiveSnapshot({
        streamId: 'old-stream',
        replacementEpoch: 0,
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
      useStreamStore.getState().clearLiveSnapshot(pendingMessage.id, 'old-stream', 0)
      useStreamStore.getState().clearActive('old-stream', 0)
      useStreamStore.getState().setActive({
        streamId: 'new-stream',
        replacementEpoch: 0,
        chatId: pendingMessage.chatId,
        messageId: pendingMessage.id,
        startedAt: 2,
        ownerClientId: 'projection-client',
      })
    })

    await waitFor(() => expect(projection()).toHaveTextContent('Persisted before streaming.'))
    expect(projection()).not.toHaveTextContent('Old live output.')
  })

  it('keeps live output across structural versions and retires it only on a body commit', async () => {
    const view = render(<ProjectionProbe view="single" bodyVersion={4} />)
    const projection = () => view.container.querySelector('[data-view="single"]')
    act(() => {
      useStreamStore.getState().setActive({
        streamId: 'body-version-stream',
        replacementEpoch: 0,
        chatId: pendingMessage.chatId,
        messageId: pendingMessage.id,
        startedAt: 1,
        ownerClientId: 'projection-client',
      })
      useStreamStore.getState().setLiveSnapshot({
        streamId: 'body-version-stream',
        replacementEpoch: 0,
        chatId: pendingMessage.chatId,
        messageId: pendingMessage.id,
        content: [{ type: 'output_text', text: 'Uncommitted live output.' }],
        textLength: 24,
        reasoningLength: 0,
        updatedAt: 5,
      })
    })
    await waitFor(() => expect(projection()).toHaveTextContent('Uncommitted live output.'))

    act(() => {
      useStreamStore.getState().clearLiveSnapshot(pendingMessage.id, 'body-version-stream', 0)
      useStreamStore.getState().clearActive('body-version-stream', 0)
    })
    view.rerender(
      <ProjectionProbe
        view="single"
        bodyVersion={4}
        message={{ ...pendingMessage, nodeVersion: 99 }}
      />,
    )
    expect(projection()).toHaveTextContent('Uncommitted live output.')

    view.rerender(
      <ProjectionProbe
        view="single"
        bodyVersion={5}
        message={{
          ...pendingMessage,
          nodeVersion: 100,
          content: [{ type: 'output_text', text: 'Committed persisted output.' }],
        }}
      />,
    )
    await waitFor(() => expect(projection()).toHaveTextContent('Committed persisted output.'))
    expect(projection()).not.toHaveTextContent('Uncommitted live output.')
  })
})
