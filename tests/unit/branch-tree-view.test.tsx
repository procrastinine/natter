import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Message, MessageId, MessageRole } from '../../src/core/types'
import type { MessageHeaderRow } from '../../src/store/message-storage'
import { getStreamClientId } from '../../src/store/stream-leases'
import { useStreamStore } from '../../src/store/zustand/streamStore'
import { BranchTreeInspector } from '../../src/ui/chat/BranchTreeInspector'
import { type BranchTreeRepository, BranchTreeView } from '../../src/ui/chat/BranchTreeView'

function header(
  id: string,
  parentId: string | null,
  siblingIndex: number,
  role: MessageRole,
  createdAt = siblingIndex,
): MessageHeaderRow {
  return {
    id,
    chatId: 'chat-1',
    parentId,
    siblingIndex,
    turnId: `turn-${id}`,
    turnIndex: createdAt,
    createdAt,
    role,
    origin: role === 'user' ? 'user' : 'generated',
    textPreview: `Preview ${id}`,
    nodeVersion: 1,
    deleted: false,
  }
}

function repository(overrides: Partial<BranchTreeRepository> = {}): BranchTreeRepository {
  return {
    getMessage: vi.fn(async (messageId: string): Promise<Message | undefined> => {
      return fullMessageFor(messageId)
    }),
    getMessageTextPreview: vi.fn(async (messageId: string) => `Preview ${messageId}`),
    searchChatMessageText: vi.fn(async () => []),
    ...overrides,
  }
}

const smallTree = [
  header('root', null, 0, 'user', 1),
  header('left', 'root', 0, 'assistant', 2),
  header('right', 'root', 1, 'assistant', 3),
]

afterEach(() => {
  useStreamStore.getState().reset()
  BranchTreeView.__setComputationProbeForTests(undefined)
  BranchTreeInspector.__setComputationProbeForTests(undefined)
})

function fullMessageFor(messageId: string): Message | undefined {
  const row = smallTree.find((header) => header.id === messageId)
  return row ? { ...row, content: [{ type: 'text', text: `Full ${messageId}` }] } : undefined
}

function streamingGeneration(): NonNullable<Message['generation']> {
  return {
    id: 'generation-streaming',
    model: 'vendor/tree-model',
    requestedModel: 'vendor/tree-model',
    apiUsed: 'chat',
    delivery: 'streaming',
    status: 'streaming',
    costSource: 'stream',
    startedAt: 4,
  }
}

describe('BranchTreeView', () => {
  it('keeps bodies cold in compact mode and uses one shared hover preview', async () => {
    const getMessageTextPreview = vi.fn(async (messageId: string) => `Preview ${messageId}`)
    render(
      <BranchTreeView
        chatId="chat-1"
        headers={smallTree}
        cursor={{ root: 'left' }}
        expanded={false}
        repository={repository({ getMessageTextPreview })}
        onActivateNode={() => undefined}
      />,
    )

    expect(getMessageTextPreview).not.toHaveBeenCalled()
    fireEvent.pointerEnter(screen.getByRole('link', { name: 'User message' }))
    await waitFor(() =>
      expect(document.querySelector('[data-ui="branch-tree-preview"]')).toHaveTextContent(
        'Preview root',
      ),
    )
    expect(getMessageTextPreview).toHaveBeenCalledTimes(1)

    const firstAssistant = screen.getAllByRole('link', { name: 'Assistant message' }).at(0)
    expect(firstAssistant).toBeDefined()
    if (!firstAssistant) throw new Error('Missing assistant node')
    fireEvent.pointerEnter(firstAssistant)
    await waitFor(() =>
      expect(document.querySelector('[data-ui="branch-tree-preview"]')).toHaveTextContent(
        /^Assistant/,
      ),
    )
    expect(document.querySelectorAll('[data-ui="branch-tree-preview"]')).toHaveLength(1)
  })

  it('publishes completed expanded previews back into visible cards', async () => {
    let renderCount = 0
    const operations: string[] = []
    BranchTreeView.__setComputationProbeForTests((operation) => {
      operations.push(operation)
      if (operation === 'render') renderCount += 1
    })
    const getMessageTextPreview = vi.fn(async (messageId: string) => `Loaded ${messageId}`)
    render(
      <BranchTreeView
        chatId="chat-1"
        headers={smallTree}
        cursor={{ root: 'left' }}
        expanded
        repository={repository({ getMessageTextPreview })}
        onActivateNode={() => undefined}
      />,
    )

    await waitFor(() => expect(getMessageTextPreview).toHaveBeenCalledTimes(3))
    await waitFor(() =>
      expect(operations.filter((entry) => entry === 'preview-complete')).toHaveLength(3),
    )
    await waitFor(() =>
      expect(operations.filter((entry) => entry === 'preview-publish')).toHaveLength(1),
    )
    await waitFor(() => {
      const publishIndex = operations.lastIndexOf('preview-publish')
      expect(operations.slice(publishIndex + 1)).toContain('render')
    })
    expect(renderCount).toBeGreaterThan(1)
    await waitFor(() =>
      expect(
        document.querySelector('[data-message-id="left"] [data-ui="branch-tree-node-preview"]'),
      ).toHaveTextContent('Loaded left'),
    )
  })

  it('does not reuse wrapped previews across repository identities', async () => {
    const first = render(
      <BranchTreeView
        chatId="chat-1"
        headers={smallTree}
        cursor={{ root: 'left' }}
        expanded
        repository={repository({ getMessageTextPreview: async (id) => `First ${id}` })}
        onActivateNode={() => undefined}
      />,
    )

    await waitFor(() =>
      expect(
        document.querySelector('[data-message-id="left"] [data-ui="branch-tree-node-preview"]'),
      ).toHaveTextContent('First left'),
    )
    first.unmount()

    render(
      <BranchTreeView
        chatId="chat-1"
        headers={smallTree}
        cursor={{ root: 'left' }}
        expanded
        repository={repository({ getMessageTextPreview: async (id) => `Second ${id}` })}
        onActivateNode={() => undefined}
      />,
    )

    await waitFor(() =>
      expect(
        document.querySelector('[data-message-id="left"] [data-ui="branch-tree-node-preview"]'),
      ).toHaveTextContent('Second left'),
    )
  })

  it('keeps inspection distinct from branch activation while preserving real deep links', async () => {
    const activate = vi.fn()
    render(
      <BranchTreeView
        chatId="chat-1"
        headers={smallTree}
        cursor={{ root: 'left' }}
        expanded={false}
        repository={repository()}
        onActivateNode={activate}
      />,
    )

    const root = screen.getByRole('link', { name: 'User message' })
    const canvas = document.querySelector<HTMLElement>('[data-ui="branch-tree-scroll"]')
    if (!canvas) throw new Error('Missing tree canvas')
    canvas.scrollLeft = 137
    canvas.scrollTop = 91
    expect(root).toHaveAttribute('href', '#/chat/chat-1/message/root')
    expect(fireEvent.click(root, { metaKey: true })).toBe(true)
    expect(
      fireEvent(root, new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 })),
    ).toBe(true)
    expect(activate).not.toHaveBeenCalled()
    expect(root).not.toHaveAttribute('data-selected')
    expect(document.querySelector('[data-ui="branch-tree-inspector"]')).not.toBeInTheDocument()
    fireEvent.click(root)
    expect(canvas.scrollLeft).toBe(137)
    expect(canvas.scrollTop).toBe(91)
    expect(activate).not.toHaveBeenCalled()
    expect(root).toHaveAttribute('data-selected', 'true')
    expect(root).not.toHaveAttribute('data-current-leaf')
    const activeLeaf = document.querySelector('[data-message-id="left"]')
    expect(activeLeaf).toHaveAttribute('data-current-leaf', 'true')
    expect(activeLeaf).not.toHaveAttribute('data-selected')
    await waitFor(
      () => expect(document.querySelector('[data-ui="branch-tree-inspector"]')).toBeInTheDocument(),
      { timeout: 5_000 },
    )
    fireEvent.doubleClick(root)
    expect(activate).toHaveBeenCalledWith('root')

    fireEvent.click(document.querySelector('[data-ui="branch-tree-scroll"]') as HTMLElement)
    await waitFor(() =>
      expect(document.querySelector('[data-ui="branch-tree-inspector"]')).not.toBeInTheDocument(),
    )
  })

  it('marks context-hidden nodes without hydrating their bodies', () => {
    const getMessage = vi.fn(async (messageId: string) => fullMessageFor(messageId))
    const hiddenHeaders = smallTree.map((row) =>
      row.id === 'root' ? { ...row, hiddenFromContext: true, nodeVersion: 2 } : row,
    )
    const view = render(
      <BranchTreeView
        chatId="chat-1"
        headers={hiddenHeaders}
        cursor={{ root: 'left' }}
        expanded={false}
        repository={repository({ getMessage })}
        onActivateNode={() => undefined}
      />,
    )

    const hiddenNode = screen.getByRole('link', {
      name: 'User message, hidden from context',
    })
    expect(hiddenNode).toHaveAttribute('data-hidden-from-context', 'true')
    expect(hiddenNode.querySelector('[data-ui="branch-tree-node-visibility"]')).toBeInTheDocument()
    expect(getMessage).not.toHaveBeenCalled()

    view.rerender(
      <BranchTreeView
        chatId="chat-1"
        headers={smallTree}
        cursor={{ root: 'left' }}
        expanded
        repository={repository({ getMessage })}
        onActivateNode={() => undefined}
      />,
    )

    const visibleNode = screen.getByRole('link', { name: 'User message' })
    expect(visibleNode).not.toHaveAttribute('data-hidden-from-context')
    expect(
      visibleNode.querySelector('[data-ui="branch-tree-node-visibility"]'),
    ).not.toBeInTheDocument()
    expect(getMessage).not.toHaveBeenCalled()
  })

  it('follows a request-created active leaf into the inspector', async () => {
    let resolveRequest: ((messageId: MessageId) => void) | undefined
    const regenerate = vi.fn(
      () =>
        new Promise<MessageId>((resolve) => {
          resolveRequest = resolve
        }),
    )
    let headers = smallTree
    const getMessage = vi.fn(async (messageId: string): Promise<Message | undefined> => {
      const row = headers.find((header) => header.id === messageId)
      return row
        ? { ...row, content: [{ type: 'output_text', text: `Full ${messageId}` }] }
        : undefined
    })
    const treeRepository = repository({ getMessage })
    const view = render(
      <BranchTreeView
        chatId="chat-1"
        headers={headers}
        cursor={{ root: 'left' }}
        expanded={false}
        repository={treeRepository}
        onActivateNode={() => undefined}
        onRegenerateMessage={regenerate}
        hasConnection
      />,
    )

    fireEvent.click(document.querySelector('[data-message-id="left"]') as Element)
    fireEvent.click(await screen.findByRole('button', { name: 'Regenerate response' }))
    expect(regenerate).toHaveBeenCalledOnce()

    headers = [...smallTree, header('regenerated', 'root', 2, 'assistant', 4)]
    act(() => {
      useStreamStore.getState().setActive({
        streamId: 'new-tree-request',
        chatId: 'chat-1',
        messageId: 'regenerated',
        startedAt: 4,
        ownerClientId: getStreamClientId(),
      })
    })
    view.rerender(
      <BranchTreeView
        chatId="chat-1"
        headers={headers}
        cursor={{ root: 'regenerated' }}
        expanded={false}
        repository={treeRepository}
        onActivateNode={() => undefined}
        onRegenerateMessage={regenerate}
        hasConnection
      />,
    )

    await waitFor(() =>
      expect(document.querySelector('[data-message-id="regenerated"]')).toHaveAttribute(
        'data-selected',
        'true',
      ),
    )
    await waitFor(() =>
      expect(document.querySelector('[data-ui="branch-tree-inspector"]')).toHaveAttribute(
        'data-message-id',
        'regenerated',
      ),
    )

    act(() => resolveRequest?.('regenerated'))
  })

  it('opens the current streaming leaf when tree view mounts mid-response', async () => {
    act(() => {
      useStreamStore.getState().setActive({
        streamId: 'already-streaming',
        chatId: 'chat-1',
        messageId: 'left',
        startedAt: 4,
        ownerClientId: getStreamClientId(),
      })
      useStreamStore.getState().setLiveSnapshot({
        streamId: 'already-streaming',
        chatId: 'chat-1',
        messageId: 'left',
        content: [{ type: 'output_text', text: 'Already streaming in transcript mode.' }],
        textLength: 37,
        reasoningLength: 0,
        updatedAt: 5,
      })
    })

    render(
      <StrictMode>
        <BranchTreeView
          chatId="chat-1"
          headers={smallTree}
          cursor={{ root: 'left' }}
          expanded={false}
          repository={repository()}
          onActivateNode={() => undefined}
        />
      </StrictMode>,
    )

    await waitFor(() =>
      expect(document.querySelector('[data-message-id="left"]')).toHaveAttribute(
        'data-selected',
        'true',
      ),
    )
    await waitFor(() =>
      expect(document.querySelector('[data-ui="branch-tree-inspector"]')).toHaveAttribute(
        'data-message-id',
        'left',
      ),
    )
    expect(document.querySelector('[data-ui="branch-tree-inspector"]')).toHaveTextContent(
      'Already streaming in transcript mode.',
    )
  })

  it('follows an initially untargeted stream once its target header becomes available', async () => {
    let headers = smallTree
    const getMessage = vi.fn(async (messageId: string): Promise<Message | undefined> => {
      const row = headers.find((candidate) => candidate.id === messageId)
      return row
        ? { ...row, content: [{ type: 'output_text', text: `Full ${messageId}` }] }
        : undefined
    })
    const treeRepository = repository({ getMessage })
    act(() => {
      useStreamStore.getState().setActive({
        streamId: 'waiting-for-target',
        chatId: 'chat-1',
        startedAt: 4,
        ownerClientId: getStreamClientId(),
      })
    })
    const view = render(
      <BranchTreeView
        chatId="chat-1"
        headers={headers}
        cursor={{ root: 'left' }}
        expanded={false}
        repository={treeRepository}
        onActivateNode={() => undefined}
      />,
    )
    expect(document.querySelector('[data-selected="true"]')).not.toBeInTheDocument()

    act(() => {
      useStreamStore.getState().setActive({
        streamId: 'waiting-for-target',
        chatId: 'chat-1',
        messageId: 'stream-leaf',
        startedAt: 4,
        ownerClientId: getStreamClientId(),
      })
    })
    await act(async () => Promise.resolve())
    expect(document.querySelector('[data-selected="true"]')).not.toBeInTheDocument()

    headers = [...smallTree, header('stream-leaf', 'root', 2, 'assistant', 5)]
    view.rerender(
      <BranchTreeView
        chatId="chat-1"
        headers={headers}
        cursor={{ root: 'stream-leaf' }}
        expanded={false}
        repository={treeRepository}
        onActivateNode={() => undefined}
      />,
    )

    await waitFor(() =>
      expect(document.querySelector('[data-message-id="stream-leaf"]')).toHaveAttribute(
        'data-selected',
        'true',
      ),
    )
    await waitFor(() =>
      expect(document.querySelector('[data-ui="branch-tree-inspector"]')).toHaveAttribute(
        'data-message-id',
        'stream-leaf',
      ),
    )
  })

  it('follows an existing stream that hydrates after the initial empty render', async () => {
    let headers: MessageHeaderRow[] = []
    const getMessage = vi.fn(async (messageId: string): Promise<Message | undefined> => {
      const row = headers.find((candidate) => candidate.id === messageId)
      return row
        ? { ...row, content: [{ type: 'output_text', text: `Hydrated ${messageId}` }] }
        : undefined
    })
    const treeRepository = repository({ getMessage })
    const view = render(
      <StrictMode>
        <BranchTreeView
          chatId="chat-1"
          headers={headers}
          cursor={{}}
          expanded={false}
          repository={treeRepository}
          onActivateNode={() => undefined}
        />
      </StrictMode>,
    )
    expect(document.querySelector('[data-selected="true"]')).not.toBeInTheDocument()

    act(() => {
      useStreamStore.getState().setActive({
        streamId: 'late-hydrated-stream',
        chatId: 'chat-1',
        messageId: 'hydrated-leaf',
        startedAt: 4,
        ownerClientId: 'remote-client',
      })
    })
    headers = [
      header('hydrated-root', null, 0, 'user', 1),
      {
        ...header('hydrated-leaf', 'hydrated-root', 0, 'assistant', 2),
        generation: streamingGeneration(),
      },
    ]
    view.rerender(
      <StrictMode>
        <BranchTreeView
          chatId="chat-1"
          headers={headers}
          cursor={{ 'hydrated-root': 'hydrated-leaf' }}
          expanded={false}
          repository={treeRepository}
          onActivateNode={() => undefined}
        />
      </StrictMode>,
    )

    await waitFor(() =>
      expect(document.querySelector('[data-message-id="hydrated-leaf"]')).toHaveAttribute(
        'data-selected',
        'true',
      ),
    )
    expect(document.querySelector('[data-ui="branch-tree-inspector"]')).toHaveAttribute(
      'data-message-id',
      'hydrated-leaf',
    )
  })

  it('does not steal focus for a stream that starts after opening an idle tree', async () => {
    let headers: MessageHeaderRow[] = smallTree
    const treeRepository = repository({
      getMessage: vi.fn(async (messageId: string): Promise<Message | undefined> => {
        const row = headers.find((candidate) => candidate.id === messageId)
        return row ? { ...row, content: [{ type: 'text', text: `Full ${messageId}` }] } : undefined
      }),
    })
    const view = render(
      <StrictMode>
        <BranchTreeView
          chatId="chat-1"
          headers={headers}
          cursor={{ root: 'left' }}
          expanded={false}
          repository={treeRepository}
          onActivateNode={() => undefined}
        />
      </StrictMode>,
    )
    expect(document.querySelector('[data-selected="true"]')).not.toBeInTheDocument()

    const startedAfterTreeOpened = Date.now() + 60_000
    act(() => {
      useStreamStore.getState().setActive({
        streamId: 'future-stream',
        chatId: 'chat-1',
        messageId: 'left',
        startedAt: startedAfterTreeOpened,
        ownerClientId: 'remote-client',
      })
    })
    headers = headers.map((row) =>
      row.id === 'left'
        ? {
            ...row,
            generation: { ...streamingGeneration(), startedAt: startedAfterTreeOpened },
          }
        : row,
    )
    view.rerender(
      <StrictMode>
        <BranchTreeView
          chatId="chat-1"
          headers={headers}
          cursor={{ root: 'left' }}
          expanded={false}
          repository={treeRepository}
          onActivateNode={() => undefined}
        />
      </StrictMode>,
    )

    await waitFor(() =>
      expect(document.querySelector('[data-message-id="left"]')).toHaveAttribute(
        'data-streaming',
        'true',
      ),
    )
    expect(document.querySelector('[data-selected="true"]')).not.toBeInTheDocument()
    expect(document.querySelector('[data-ui="branch-tree-inspector"]')).not.toBeInTheDocument()
  })

  it('ignores off-path and other-chat streams when choosing an initial inspector target', async () => {
    act(() => {
      useStreamStore.getState().setActive({
        streamId: 'off-path',
        chatId: 'chat-1',
        messageId: 'right',
        startedAt: 4,
        ownerClientId: getStreamClientId(),
      })
      useStreamStore.getState().setActive({
        streamId: 'other-chat',
        chatId: 'chat-elsewhere',
        messageId: 'left',
        startedAt: 5,
        ownerClientId: 'client-2',
      })
    })

    render(
      <BranchTreeView
        chatId="chat-1"
        headers={smallTree}
        cursor={{ root: 'left' }}
        expanded={false}
        repository={repository()}
        onActivateNode={() => undefined}
      />,
    )
    await act(async () => Promise.resolve())

    expect(document.querySelector('[data-selected="true"]')).not.toBeInTheDocument()
    expect(document.querySelector('[data-ui="branch-tree-inspector"]')).not.toBeInTheDocument()
  })

  it('inspects an off-path stream without activating its branch', async () => {
    const activate = vi.fn()
    act(() => {
      useStreamStore.getState().setActive({
        streamId: 'inspect-off-path',
        chatId: 'chat-1',
        messageId: 'right',
        startedAt: 4,
        ownerClientId: getStreamClientId(),
      })
    })

    render(
      <BranchTreeView
        chatId="chat-1"
        headers={smallTree}
        cursor={{ root: 'left' }}
        expanded={false}
        repository={repository()}
        onActivateNode={activate}
      />,
    )

    fireEvent.click(document.querySelector('[data-message-id="right"]') as Element)

    expect(document.querySelector('[data-message-id="right"]')).toHaveAttribute(
      'data-selected',
      'true',
    )
    expect(document.querySelector('[data-message-id="left"]')).toHaveAttribute(
      'data-current-leaf',
      'true',
    )
    expect(activate).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(document.querySelector('[data-ui="branch-tree-inspector"]')).toHaveAttribute(
        'data-message-id',
        'right',
      ),
    )
    expect(
      document.querySelector('[data-ui="branch-tree-inspector-stream-status"]'),
    ).toHaveTextContent('Streaming on another branch. Open this branch to follow live output.')
    fireEvent.click(screen.getByRole('button', { name: 'Open this branch' }))
    expect(activate).toHaveBeenCalledOnce()
    expect(activate).toHaveBeenCalledWith('right')
  })

  it('does not let a late stream target replace an explicit manual selection', async () => {
    act(() => {
      useStreamStore.getState().setActive({
        streamId: 'late-manual-target',
        chatId: 'chat-1',
        startedAt: 4,
        ownerClientId: getStreamClientId(),
      })
    })
    render(
      <BranchTreeView
        chatId="chat-1"
        headers={smallTree}
        cursor={{ root: 'left' }}
        expanded={false}
        repository={repository()}
        onActivateNode={() => undefined}
      />,
    )
    fireEvent.click(document.querySelector('[data-message-id="root"]') as Element)
    await waitFor(() =>
      expect(document.querySelector('[data-ui="branch-tree-inspector"]')).toHaveAttribute(
        'data-message-id',
        'root',
      ),
    )

    act(() => {
      useStreamStore.getState().setActive({
        streamId: 'late-manual-target',
        chatId: 'chat-1',
        messageId: 'left',
        startedAt: 4,
        ownerClientId: getStreamClientId(),
      })
    })
    await act(async () => Promise.resolve())

    expect(document.querySelector('[data-message-id="root"]')).toHaveAttribute(
      'data-selected',
      'true',
    )
    expect(document.querySelector('[data-ui="branch-tree-inspector"]')).toHaveAttribute(
      'data-message-id',
      'root',
    )
  })

  it('keeps an explicitly closed streaming inspector closed', async () => {
    act(() => {
      useStreamStore.getState().setActive({
        streamId: 'closed-stream',
        chatId: 'chat-1',
        messageId: 'left',
        startedAt: 4,
        ownerClientId: getStreamClientId(),
      })
    })
    render(
      <BranchTreeView
        chatId="chat-1"
        headers={smallTree}
        cursor={{ root: 'left' }}
        expanded={false}
        repository={repository()}
        onActivateNode={() => undefined}
      />,
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Close message inspector' }))
    await waitFor(() =>
      expect(document.querySelector('[data-ui="branch-tree-inspector"]')).not.toBeInTheDocument(),
    )

    act(() => {
      useStreamStore.getState().setActive({
        streamId: 'closed-stream',
        chatId: 'chat-1',
        messageId: 'left',
        startedAt: 4,
        heartbeatAt: 6,
        ownerClientId: getStreamClientId(),
      })
    })
    await act(async () => Promise.resolve())

    expect(document.querySelector('[data-selected="true"]')).not.toBeInTheDocument()
    expect(document.querySelector('[data-ui="branch-tree-inspector"]')).not.toBeInTheDocument()
  })

  it('does not cache an empty preview while its message is streaming', async () => {
    let committed = false
    const getMessageTextPreview = vi.fn(async (messageId: string) => {
      if (messageId === 'left') return committed ? 'Committed streaming output' : ''
      return `Preview ${messageId}`
    })
    act(() => {
      useStreamStore.getState().setActive({
        streamId: 'empty-preview-stream',
        chatId: 'chat-1',
        messageId: 'left',
        startedAt: 4,
        ownerClientId: getStreamClientId(),
      })
    })
    render(
      <BranchTreeView
        chatId="chat-1"
        headers={smallTree}
        cursor={{ root: 'left' }}
        expanded
        repository={repository({ getMessageTextPreview })}
        onActivateNode={() => undefined}
      />,
    )

    const leftPreview = () =>
      document.querySelector('[data-message-id="left"] [data-ui="branch-tree-node-preview"]')
    await waitFor(() => expect(leftPreview()).not.toHaveTextContent('Loading preview…'))
    expect(leftPreview()).not.toHaveTextContent('No text content')
    const callsWhileStreaming = getMessageTextPreview.mock.calls.filter(
      ([messageId]) => messageId === 'left',
    ).length

    committed = true
    act(() => useStreamStore.getState().clearActive('empty-preview-stream'))

    await waitFor(() =>
      expect(
        getMessageTextPreview.mock.calls.filter(([messageId]) => messageId === 'left'),
      ).toHaveLength(callsWhileStreaming + 1),
    )
    await waitFor(() => expect(leftPreview()).toHaveTextContent('Committed streaming output'))
  })

  it('bounds retained preview text even if a repository violates the preview-length contract', async () => {
    render(
      <BranchTreeView
        chatId="chat-1"
        headers={smallTree}
        cursor={{ root: 'left' }}
        expanded={false}
        repository={repository({ getMessageTextPreview: async () => 'x'.repeat(10_000) })}
        onActivateNode={() => undefined}
      />,
    )

    fireEvent.pointerEnter(screen.getByRole('link', { name: 'User message' }))
    await waitFor(() =>
      expect(document.querySelector('[data-ui="branch-tree-preview"]')).toHaveTextContent(/…$/),
    )
    const tooltip = document.querySelector('[data-ui="branch-tree-preview"]')
    if (!tooltip) throw new Error('Missing preview')
    expect(tooltip.textContent.length).toBeLessThan(1_000)
  })

  it('sorts search hits by depth and horizontal position and cycles in both directions', async () => {
    const searchChatMessageText = vi.fn<BranchTreeRepository['searchChatMessageText']>(async () => [
      'right',
      'left',
      'root',
    ])
    const treeRepository = repository({ searchChatMessageText })
    const view = render(
      <BranchTreeView
        chatId="chat-1"
        headers={smallTree}
        cursor={{ root: 'left' }}
        expanded={false}
        repository={treeRepository}
        onActivateNode={() => undefined}
      />,
    )

    const input = screen.getByRole('searchbox', { name: 'Search messages in this chat' })
    fireEvent.change(input, { target: { value: '  preview  ' } })
    await waitFor(() => expect(screen.getByText('1 / 3')).toBeInTheDocument())
    const searchCall = searchChatMessageText.mock.calls.at(0)
    expect(searchCall?.[0]).toBe('chat-1')
    expect(searchCall?.[1]).toBe('preview')
    expect(searchCall?.[2]?.signal).toBeInstanceOf(AbortSignal)
    expect(document.querySelector('[data-current-match="true"]')).toHaveAttribute(
      'data-message-id',
      'root',
    )
    expect(document.querySelector('[data-message-id="root"]')).toHaveAttribute(
      'data-selected',
      'true',
    )
    expect(document.querySelector('[data-ui="branch-tree-inspector-slot"]')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Next matching message' }))
    expect(document.querySelector('[data-current-match="true"]')).toHaveAttribute(
      'data-message-id',
      'left',
    )
    expect(document.querySelector('[data-message-id="left"]')).toHaveAttribute(
      'data-selected',
      'true',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Previous matching message' }))
    expect(document.querySelector('[data-current-match="true"]')).toHaveAttribute(
      'data-message-id',
      'root',
    )

    fireEvent.click(screen.getByRole('button', { name: 'Next matching message' }))
    view.rerender(
      <BranchTreeView
        chatId="chat-1"
        headers={smallTree.map((row) =>
          row.id === 'root' ? { ...row, nodeVersion: row.nodeVersion + 1 } : row,
        )}
        cursor={{ root: 'left' }}
        expanded={false}
        repository={treeRepository}
        onActivateNode={() => undefined}
      />,
    )
    await waitFor(() => expect(searchChatMessageText).toHaveBeenCalledTimes(2))
    expect(document.querySelector('[data-current-match="true"]')).toHaveAttribute(
      'data-message-id',
      'left',
    )
    expect(document.querySelector('[data-message-id="left"]')).toHaveAttribute(
      'data-selected',
      'true',
    )

    fireEvent.keyDown(window, { key: 'f', metaKey: true })
    expect(input).toHaveFocus()

    fireEvent.change(input, { target: { value: '   ' } })
    await waitFor(() => expect(screen.getByText('0 / 0')).toBeInTheDocument())
    expect(searchChatMessageText).toHaveBeenCalledTimes(2)
  })

  it('aborts superseded searches and ignores their late results', async () => {
    const pending = new Map<string, (ids: string[]) => void>()
    const signals = new Map<string, AbortSignal | undefined>()
    const searchChatMessageText = vi.fn<BranchTreeRepository['searchChatMessageText']>(
      async (_chatId, query, options) => {
        signals.set(query, options?.signal)
        return new Promise<string[]>((resolve) => pending.set(query, resolve))
      },
    )
    render(
      <BranchTreeView
        chatId="chat-1"
        headers={smallTree}
        cursor={{ root: 'left' }}
        expanded={false}
        repository={repository({ searchChatMessageText })}
        onActivateNode={() => undefined}
      />,
    )
    const input = screen.getByRole('searchbox', { name: 'Search messages in this chat' })
    fireEvent.change(input, { target: { value: 'first' } })
    await waitFor(() => expect(pending.has('first')).toBe(true))
    fireEvent.change(input, { target: { value: 'second' } })
    await waitFor(() => expect(pending.has('second')).toBe(true))
    expect(signals.get('first')?.aborted).toBe(true)

    await act(async () => pending.get('second')?.(['right']))
    await waitFor(() => expect(screen.getByText('1 / 1')).toBeInTheDocument())
    expect(document.querySelector('[data-current-match="true"]')).toHaveAttribute(
      'data-message-id',
      'right',
    )
    await act(async () => pending.get('first')?.(['left']))
    expect(document.querySelector('[data-current-match="true"]')).toHaveAttribute(
      'data-message-id',
      'right',
    )
  })

  it('serializes inspector body reads and skips superseded queued selections', async () => {
    const pending = new Map<string, (message: Message | undefined) => void>()
    const getMessage = vi.fn(
      async (messageId: string) =>
        new Promise<Message | undefined>((resolve) => pending.set(messageId, resolve)),
    )
    render(
      <BranchTreeView
        chatId="chat-1"
        headers={smallTree}
        cursor={{ root: 'left' }}
        expanded={false}
        repository={repository({ getMessage })}
        onActivateNode={() => undefined}
      />,
    )

    fireEvent.click(document.querySelector('[data-message-id="root"]') as Element)
    await waitFor(() => expect(pending.has('root')).toBe(true))
    fireEvent.click(document.querySelector('[data-message-id="right"]') as Element)
    expect(pending.has('right')).toBe(false)
    await act(async () => pending.get('root')?.(fullMessageFor('root')))
    await waitFor(() => expect(pending.has('right')).toBe(true))
    await act(async () => pending.get('right')?.(fullMessageFor('right')))
    await waitFor(() =>
      expect(document.querySelector('[data-ui="branch-tree-inspector"]')).toHaveAttribute(
        'data-message-id',
        'right',
      ),
    )
    expect(document.querySelector('[data-ui="branch-tree-inspector"]')).toHaveAttribute(
      'data-message-id',
      'right',
    )
  })

  it('does not recenter a direct click when selection is parent-controlled', () => {
    const onSelectNode = vi.fn()
    const view = render(
      <BranchTreeView
        chatId="chat-1"
        headers={smallTree}
        cursor={{ root: 'left' }}
        expanded={false}
        selectedNodeId={null}
        repository={repository()}
        onActivateNode={() => undefined}
        onSelectNode={onSelectNode}
      />,
    )
    const canvas = document.querySelector<HTMLElement>('[data-ui="branch-tree-scroll"]')
    if (!canvas) throw new Error('Missing tree canvas')
    canvas.scrollLeft = 137
    canvas.scrollTop = 91
    fireEvent.click(document.querySelector('[data-message-id="root"]') as Element)
    expect(onSelectNode).toHaveBeenCalledWith('root')

    view.rerender(
      <BranchTreeView
        chatId="chat-1"
        headers={smallTree}
        cursor={{ root: 'left' }}
        expanded={false}
        selectedNodeId="root"
        repository={repository()}
        onActivateNode={() => undefined}
        onSelectNode={onSelectNode}
      />,
    )
    expect(canvas.scrollLeft).toBe(137)
    expect(canvas.scrollTop).toBe(91)
  })

  it('refreshes an inspected body when the selected node version changes', async () => {
    let bodyText = 'Body version one'
    let bodyNodeVersion = 1
    const getMessage = vi.fn(async (messageId: string): Promise<Message | undefined> => {
      const row = smallTree.find((header) => header.id === messageId)
      return row
        ? {
            ...row,
            nodeVersion: bodyNodeVersion,
            content: [{ type: 'text', text: bodyText }],
          }
        : undefined
    })
    const treeRepository = repository({ getMessage })
    const view = render(
      <BranchTreeView
        chatId="chat-1"
        headers={smallTree}
        cursor={{ root: 'left' }}
        expanded={false}
        repository={treeRepository}
        onActivateNode={() => undefined}
      />,
    )

    fireEvent.click(document.querySelector('[data-message-id="root"]') as Element)
    await waitFor(() =>
      expect(document.querySelector('[data-ui="branch-tree-inspector"]')).toHaveTextContent(
        'Body version one',
      ),
    )

    bodyText = 'Body version two'
    bodyNodeVersion = 2
    view.rerender(
      <BranchTreeView
        chatId="chat-1"
        headers={smallTree.map((row) =>
          row.id === 'root' ? { ...row, nodeVersion: row.nodeVersion + 1 } : row,
        )}
        cursor={{ root: 'left' }}
        expanded={false}
        repository={treeRepository}
        onActivateNode={() => undefined}
      />,
    )

    await waitFor(() => expect(getMessage).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(document.querySelector('[data-ui="branch-tree-inspector"]')).toHaveTextContent(
        'Body version two',
      ),
    )
  })

  it('exposes distinct shared-trunk and per-child insertion targets', () => {
    const insertShared = vi.fn()
    const insertChild = vi.fn()
    render(
      <BranchTreeView
        chatId="chat-1"
        headers={smallTree}
        cursor={{ root: 'left' }}
        expanded={false}
        repository={repository()}
        onActivateNode={() => undefined}
        onInsertAtSharedTrunk={insertShared}
        onInsertAtChildLeg={insertChild}
      />,
    )

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Insert after this parent before all of its children',
      }),
    )
    expect(insertShared).toHaveBeenCalledWith('root')

    const childLegs = screen.getAllByRole('button', { name: 'Insert before this child only' })
    expect(childLegs).toHaveLength(2)
    const rightLeg = childLegs.at(1)
    if (!rightLeg) throw new Error('Missing right child connector')
    fireEvent.click(rightLeg)
    expect(insertChild).toHaveBeenCalledWith('right')
    expect(document.querySelectorAll('[data-ui="branch-tree-connector-add"]')).toHaveLength(3)
  })

  it('exposes a keyboard-operable append target after every leaf', () => {
    const insertAfterLeaf = vi.fn()
    render(
      <BranchTreeView
        chatId="chat-1"
        headers={smallTree}
        cursor={{ root: 'left' }}
        expanded={false}
        repository={repository()}
        onActivateNode={() => undefined}
        onInsertAfterLeaf={insertAfterLeaf}
      />,
    )

    const leafTargets = screen.getAllByRole('button', { name: 'Add message after this leaf' })
    expect(leafTargets).toHaveLength(2)
    expect(leafTargets[0]).toHaveAttribute('data-parent-id', 'left')
    expect(leafTargets[1]).toHaveAttribute('data-parent-id', 'right')
    expect(document.querySelectorAll('[data-ui="branch-tree-leaf-add"]')).toHaveLength(2)

    fireEvent.click(leafTargets[0] as Element)
    fireEvent.keyDown(leafTargets[1] as Element, { key: 'Enter' })
    expect(insertAfterLeaf).toHaveBeenNthCalledWith(1, 'left')
    expect(insertAfterLeaf).toHaveBeenNthCalledWith(2, 'right')
  })

  it('treats deleted-only children as leaves and disables append while that leaf streams', () => {
    const insertAfterLeaf = vi.fn()
    useStreamStore.getState().setActive({
      streamId: 'root-stream',
      chatId: 'chat-1',
      messageId: 'root',
      startedAt: 1,
      ownerClientId: 'client-1',
    })
    render(
      <BranchTreeView
        chatId="chat-1"
        headers={[
          header('root', null, 0, 'user', 1),
          { ...header('deleted-child', 'root', 0, 'assistant', 2), deleted: true },
        ]}
        cursor={{}}
        expanded={false}
        repository={repository()}
        onActivateNode={() => undefined}
        onInsertAfterLeaf={insertAfterLeaf}
      />,
    )

    const leafTarget = screen.getByRole('button', { name: 'Add message after this leaf' })
    expect(leafTarget).toHaveAttribute('data-parent-id', 'root')
    expect(leafTarget).toHaveAttribute('aria-disabled', 'true')
    expect(leafTarget).toHaveAttribute('tabindex', '-1')
    fireEvent.click(leafTarget)
    expect(insertAfterLeaf).not.toHaveBeenCalled()
  })

  it('treats an uncommitted persisted streaming generation as busy without an active lease', async () => {
    const streamingLeaf = {
      ...header('left', 'root', 0, 'assistant', 2),
      generation: streamingGeneration(),
    }
    const headers = [header('root', null, 0, 'user', 1), streamingLeaf]
    const getMessage = vi.fn(async (messageId: string): Promise<Message | undefined> => {
      const row = headers.find((candidate) => candidate.id === messageId)
      return row
        ? { ...row, content: [{ type: 'output_text', text: 'Persisted prefix.' }] }
        : undefined
    })
    render(
      <BranchTreeView
        chatId="chat-1"
        headers={headers}
        cursor={{ root: 'left' }}
        expanded={false}
        repository={repository({ getMessage })}
        onActivateNode={() => undefined}
        onInsertAfterLeaf={() => undefined}
        onEditMessage={() => undefined}
        onDeleteNode={() => undefined}
        onContinueMessage={() => undefined}
        hasConnection
      />,
    )

    const append = screen.getByRole('button', { name: 'Add message after this leaf' })
    expect(append).toHaveAttribute('data-parent-id', 'left')
    expect(append).toHaveAttribute('aria-disabled', 'true')

    fireEvent.click(document.querySelector('[data-message-id="left"]') as Element)
    await waitFor(() =>
      expect(
        document.querySelector('[data-ui="branch-tree-inspector-stream-status"]'),
      ).toHaveTextContent('Preparing response…'),
    )
    expect(screen.getByRole('button', { name: 'Edit message' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Delete message' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Continue from here' })).toBeDisabled()
  })

  it('uses one centered insertion target for a parent with only one child', () => {
    const insertShared = vi.fn()
    const insertChild = vi.fn()
    render(
      <BranchTreeView
        chatId="chat-1"
        headers={[header('root', null, 0, 'user', 1), header('only', 'root', 0, 'assistant', 2)]}
        cursor={{ root: 'only' }}
        expanded={false}
        repository={repository()}
        onActivateNode={() => undefined}
        onInsertAtSharedTrunk={insertShared}
        onInsertAtChildLeg={insertChild}
      />,
    )

    const target = screen.getByRole('button', {
      name: 'Insert after this parent before all of its children',
    })
    expect(target).toHaveAttribute('data-parent-id', 'root')
    expect(screen.queryByRole('button', { name: 'Insert before this child only' })).toBeNull()
    expect(document.querySelectorAll('[data-ui="branch-tree-connector-add"]')).toHaveLength(1)
    fireEvent.click(target)
    expect(insertShared).toHaveBeenCalledWith('root')
    expect(insertChild).not.toHaveBeenCalled()
  })

  it('matches compact selection outlines to each node shape', () => {
    render(
      <BranchTreeView
        chatId="chat-1"
        headers={[
          header('user', null, 0, 'user', 1),
          header('assistant', null, 1, 'assistant', 2),
          header('tool', null, 2, 'tool', 3),
        ]}
        cursor={{ __root__: 'user' }}
        expanded={false}
        repository={repository()}
        onActivateNode={() => undefined}
      />,
    )

    const userOutline = document.querySelector(
      '[data-message-id="user"] [data-ui="branch-tree-node-selection-ring"]',
    )
    const assistantOutline = document.querySelector(
      '[data-message-id="assistant"] [data-ui="branch-tree-node-selection-ring"]',
    )
    const toolOutline = document.querySelector(
      '[data-message-id="tool"] [data-ui="branch-tree-node-selection-ring"]',
    )
    expect(userOutline?.tagName).toBe('rect')
    expect(userOutline).toHaveAttribute('data-shape', 'rounded-square')
    expect(userOutline).toHaveAttribute('rx', '11')
    expect(assistantOutline?.tagName).toBe('circle')
    expect(assistantOutline).toHaveAttribute('data-shape', 'circle')
    expect(assistantOutline).toHaveAttribute('r', '21')
    expect(toolOutline?.tagName).toBe('polygon')
    expect(toolOutline).toHaveAttribute('data-shape', 'hexagon')
  })

  it('exposes selected-node deletion in the inspector separately from connector insertion', async () => {
    const deleteNode = vi.fn()
    render(
      <BranchTreeView
        chatId="chat-1"
        headers={smallTree}
        cursor={{ root: 'left' }}
        expanded={false}
        repository={repository()}
        onActivateNode={() => undefined}
        onDeleteNode={deleteNode}
      />,
    )

    expect(
      screen.queryByRole('button', {
        name: 'Insert after this parent before all of its children',
      }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Insert before this child only' }),
    ).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('link', { name: 'User message' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete message' }))
    expect(deleteNode).toHaveBeenCalledWith('root')
  })

  it('renders viewport-sized DOM for a very wide tree and only previews visible expanded cards', async () => {
    const headers: MessageHeaderRow[] = [header('root', null, 0, 'user', 1)]
    for (let index = 0; index < 2_000; index += 1) {
      headers.push(header(`child-${index}`, 'root', index, 'assistant', index + 2))
    }
    const getMessageTextPreview = vi.fn(async (messageId: string) => `Preview ${messageId}`)
    render(
      <BranchTreeView
        chatId="chat-1"
        headers={headers}
        cursor={{ root: 'child-1999' }}
        expanded
        repository={repository({ getMessageTextPreview })}
        onActivateNode={() => undefined}
        onInsertAtSharedTrunk={() => undefined}
        onInsertAtChildLeg={() => undefined}
        onInsertAfterLeaf={() => undefined}
      />,
    )

    await waitFor(() => expect(getMessageTextPreview).toHaveBeenCalled())
    await waitFor(() =>
      expect(document.querySelector('[data-ui="branch-tree-node-preview"]')).not.toHaveTextContent(
        'Loading preview…',
      ),
    )
    const renderedNodes = document.querySelectorAll('[data-ui="branch-tree-node"]').length
    expect(renderedNodes).toBeLessThan(50)
    expect(getMessageTextPreview.mock.calls.length).toBeLessThan(50)
    expect(document.querySelectorAll('[data-ui="branch-tree-connector"]').length).toBeLessThan(100)
    expect(document.querySelectorAll('[data-connector-hit]').length).toBeLessThan(100)
    expect(document.querySelectorAll('[data-ui="branch-tree-leaf-add"]').length).toBeLessThan(50)
    expect(document.querySelectorAll('[data-ui="branch-tree-node"]')).not.toHaveLength(
      headers.length,
    )
  })

  it('keeps deep-tree nodes, connectors, and leaf controls bounded to the viewport', () => {
    const headers: MessageHeaderRow[] = []
    for (let index = 0; index < 2_000; index += 1) {
      headers.push(
        header(
          `node-${index}`,
          index === 0 ? null : `node-${index - 1}`,
          0,
          index % 2 === 0 ? 'user' : 'assistant',
          index + 1,
        ),
      )
    }
    render(
      <BranchTreeView
        chatId="chat-1"
        headers={headers}
        cursor={Object.fromEntries(
          headers.slice(0, -1).map((row, index) => [row.id, `node-${index + 1}`]),
        )}
        expanded={false}
        repository={repository()}
        onActivateNode={() => undefined}
        onInsertAtSharedTrunk={() => undefined}
        onInsertAfterLeaf={() => undefined}
      />,
    )

    expect(document.querySelectorAll('[data-ui="branch-tree-node"]').length).toBeLessThan(30)
    expect(document.querySelectorAll('[data-ui="branch-tree-connector"]').length).toBeLessThan(60)
    expect(document.querySelectorAll('[data-connector-hit]').length).toBeLessThan(30)
    expect(document.querySelectorAll('[data-ui="branch-tree-leaf-add"]')).toHaveLength(1)
  })

  it('globally caps expanded preview reads while rapid panning replaces queued windows', async () => {
    const headers: MessageHeaderRow[] = [header('root', null, 0, 'user', 1)]
    for (let index = 0; index < 600; index += 1) {
      headers.push(header(`child-${index}`, 'root', index, 'assistant', index + 2))
    }
    let inFlight = 0
    let maxInFlight = 0
    const pending: Array<() => void> = []
    const getMessageTextPreview = vi.fn(
      async (messageId: string) =>
        new Promise<string>((resolve) => {
          inFlight += 1
          maxInFlight = Math.max(maxInFlight, inFlight)
          pending.push(() => {
            inFlight -= 1
            resolve(`Preview ${messageId}`)
          })
        }),
    )
    render(
      <BranchTreeView
        chatId="chat-1"
        headers={headers}
        cursor={{ root: 'child-0' }}
        expanded
        repository={repository({ getMessageTextPreview })}
        onActivateNode={() => undefined}
      />,
    )
    await waitFor(() => expect(getMessageTextPreview).toHaveBeenCalled())
    const canvas = document.querySelector<HTMLElement>('[data-ui="branch-tree-scroll"]')
    if (!canvas) throw new Error('Missing tree canvas')

    for (const left of [10_000, 20_000, 30_000, 40_000]) {
      canvas.scrollLeft = left
      fireEvent.scroll(canvas)
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
    }

    expect(getMessageTextPreview.mock.calls.length).toBeLessThanOrEqual(6)
    expect(maxInFlight).toBeLessThanOrEqual(6)
    const firstWaveCount = getMessageTextPreview.mock.calls.length
    await act(async () => {
      for (const resolve of pending.splice(0)) resolve()
    })
    await waitFor(() =>
      expect(getMessageTextPreview.mock.calls.length).toBeGreaterThan(firstWaveCount),
    )
    expect(getMessageTextPreview.mock.calls.length).toBeLessThanOrEqual(firstWaveCount + 6)
    expect(maxInFlight).toBeLessThanOrEqual(6)
  })

  it('keeps topology work and the inspector isolated from non-structural activity', async () => {
    const treeComputations: string[] = []
    const inspectorComputations: string[] = []
    BranchTreeView.__setComputationProbeForTests((operation) => treeComputations.push(operation))
    BranchTreeInspector.__setComputationProbeForTests((operation) =>
      inspectorComputations.push(operation),
    )
    const treeRepository = repository()
    const activate = vi.fn()
    const view = render(
      <BranchTreeView
        chatId="chat-1"
        headers={smallTree}
        cursor={{ root: 'left' }}
        expanded={false}
        repository={treeRepository}
        onActivateNode={activate}
      />,
    )
    fireEvent.click(document.querySelector('[data-message-id="root"]') as Element)
    await waitFor(() =>
      expect(document.querySelector('[data-ui="branch-tree-inspector"]')).toBeInTheDocument(),
    )
    const initialLayouts = treeComputations.filter((entry) => entry === 'layout').length
    const initialIndexes = treeComputations.filter((entry) => entry === 'connector-index').length
    const initialInspectorRenders = inspectorComputations.filter(
      (entry) => entry === 'render',
    ).length
    const initialTreeRenders = treeComputations.filter((entry) => entry === 'render').length

    view.rerender(
      <BranchTreeView
        chatId="chat-1"
        headers={smallTree.map((row) =>
          row.id === 'right'
            ? { ...row, hiddenFromContext: true, nodeVersion: row.nodeVersion + 1 }
            : row,
        )}
        cursor={{ root: 'left' }}
        expanded={false}
        repository={treeRepository}
        onActivateNode={activate}
      />,
    )
    const treeRendersAfterHeaderChange = treeComputations.filter(
      (entry) => entry === 'render',
    ).length
    act(() => {
      useStreamStore.getState().setActive({
        streamId: 'unrelated',
        chatId: 'chat-elsewhere',
        messageId: 'other-message',
        startedAt: 1,
        ownerClientId: 'client-1',
      })
      useStreamStore.getState().setLiveSnapshot({
        streamId: 'unrelated',
        chatId: 'chat-elsewhere',
        messageId: 'other-message',
        content: [{ type: 'output_text', text: 'Elsewhere' }],
        textLength: 9,
        reasoningLength: 0,
        updatedAt: 2,
      })
    })
    expect(treeComputations.filter((entry) => entry === 'render')).toHaveLength(
      treeRendersAfterHeaderChange,
    )
    const canvas = document.querySelector<HTMLElement>('[data-ui="branch-tree-scroll"]')
    if (!canvas) throw new Error('Missing tree canvas')
    canvas.scrollLeft = 12
    fireEvent.scroll(canvas)
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))

    expect(treeComputations.filter((entry) => entry === 'layout')).toHaveLength(initialLayouts)
    expect(treeComputations.filter((entry) => entry === 'connector-index')).toHaveLength(
      initialIndexes,
    )
    expect(inspectorComputations.filter((entry) => entry === 'render')).toHaveLength(
      initialInspectorRenders,
    )
    expect(treeComputations.filter((entry) => entry === 'render').length).toBeGreaterThan(
      initialTreeRenders,
    )
  })

  it('pans the empty canvas without activating a node or clearing the inspector', async () => {
    const activate = vi.fn()
    render(
      <BranchTreeView
        chatId="chat-1"
        headers={smallTree}
        cursor={{ root: 'left' }}
        expanded={false}
        repository={repository()}
        onActivateNode={activate}
      />,
    )
    const canvas = document.querySelector<HTMLElement>('[data-ui="branch-tree-scroll"]')
    if (!canvas) throw new Error('Missing tree canvas')
    fireEvent.click(document.querySelector('[data-message-id="root"]') as HTMLElement)
    await waitFor(() =>
      expect(document.querySelector('[data-ui="branch-tree-inspector"]')).toBeInTheDocument(),
    )
    canvas.scrollLeft = 120
    canvas.scrollTop = 90
    canvas.setPointerCapture = vi.fn()
    canvas.hasPointerCapture = vi.fn(() => true)
    canvas.releasePointerCapture = vi.fn()

    fireEvent.pointerDown(canvas, { button: 0, pointerId: 7, clientX: 200, clientY: 180 })
    fireEvent.pointerMove(canvas, { pointerId: 7, clientX: 150, clientY: 140 })
    expect(canvas).toHaveAttribute('data-panning', 'true')
    expect(canvas.scrollLeft).toBe(170)
    expect(canvas.scrollTop).toBe(130)
    fireEvent.pointerUp(canvas, { pointerId: 7, clientX: 150, clientY: 140 })
    expect(canvas).not.toHaveAttribute('data-panning')
    fireEvent.click(canvas)
    expect(document.querySelector('[data-ui="branch-tree-inspector"]')).toBeInTheDocument()
    expect(activate).not.toHaveBeenCalled()

    fireEvent.pointerDown(canvas, { button: 0, pointerId: 8, clientX: 200, clientY: 180 })
    expect(canvas).toHaveAttribute('data-panning', 'true')
    fireEvent.lostPointerCapture(canvas, { pointerId: 8 })
    expect(canvas).not.toHaveAttribute('data-panning')
  })

  it('leaves native scrollbar gutters available for scrollbar dragging', () => {
    render(
      <BranchTreeView
        chatId="chat-1"
        headers={smallTree}
        cursor={{ root: 'left' }}
        expanded={false}
        repository={repository()}
        onActivateNode={() => undefined}
      />,
    )
    const canvas = document.querySelector<HTMLElement>('[data-ui="branch-tree-scroll"]')
    if (!canvas) throw new Error('Missing tree canvas')
    Object.defineProperties(canvas, {
      offsetWidth: { configurable: true, value: 200 },
      clientWidth: { configurable: true, value: 184 },
      offsetHeight: { configurable: true, value: 160 },
      clientHeight: { configurable: true, value: 144 },
    })
    canvas.getBoundingClientRect = vi.fn(
      () => ({ left: 0, top: 0, right: 200, bottom: 160, width: 200, height: 160 }) as DOMRect,
    )
    canvas.setPointerCapture = vi.fn()

    fireEvent.pointerDown(canvas, { button: 0, pointerId: 8, clientX: 195, clientY: 80 })
    expect(canvas.setPointerCapture).not.toHaveBeenCalled()
    expect(canvas).not.toHaveAttribute('data-panning')

    fireEvent.pointerDown(canvas, { button: 0, pointerId: 9, clientX: 80, clientY: 155 })
    expect(canvas.setPointerCapture).not.toHaveBeenCalled()
    expect(canvas).not.toHaveAttribute('data-panning')
  })
})
