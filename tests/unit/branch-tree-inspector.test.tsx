import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '../../src/core/types'
import { getStreamClientId } from '../../src/store/stream-leases'
import { useStreamStore } from '../../src/store/zustand/streamStore'
import {
  BranchTreeInspector as BranchTreeInspectorComponent,
  type BranchTreeInspectorProps,
} from '../../src/ui/chat/BranchTreeInspector'

const BranchTreeInspector = Object.assign(
  function TestBranchTreeInspector(
    props: Omit<BranchTreeInspectorProps, 'bodyVersion'> & { bodyVersion?: number },
  ) {
    return (
      <BranchTreeInspectorComponent
        {...props}
        bodyVersion={props.bodyVersion ?? props.message.nodeVersion}
      />
    )
  },
  {
    __setComputationProbeForTests: BranchTreeInspectorComponent.__setComputationProbeForTests,
  },
)

const SEARCH_MATCH_HIGHLIGHT = 'branch-tree-inspector-search-match'
const SEARCH_CURRENT_HIGHLIGHT = 'branch-tree-inspector-search-current'

class TestHighlight extends Set<Range> {
  priority = 0
  type: HighlightType = 'highlight'

  constructor(...ranges: Range[]) {
    super(ranges)
  }
}

const highlightRegistry = new Map<string, TestHighlight>()
let cssDescriptor: PropertyDescriptor | undefined
let highlightDescriptor: PropertyDescriptor | undefined
let scrollIntoViewDescriptor: PropertyDescriptor | undefined
let clipboardDescriptor: PropertyDescriptor | undefined
let scrollIntoView: ReturnType<typeof vi.fn>
let writeText: ReturnType<typeof vi.fn>

function restoreProperty(
  target: object,
  name: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) {
    Object.defineProperty(target, name, descriptor)
  } else {
    Reflect.deleteProperty(target, name)
  }
}

beforeEach(() => {
  highlightRegistry.clear()
  cssDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'CSS')
  highlightDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Highlight')
  scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'scrollIntoView',
  )
  clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  const cssGlobal = (globalThis as { CSS?: typeof CSS }).CSS
  const css = Object.create(cssGlobal ?? null) as typeof CSS
  Object.defineProperty(css, 'highlights', {
    configurable: true,
    value: highlightRegistry,
  })
  Object.defineProperty(globalThis, 'CSS', { configurable: true, value: css })
  Object.defineProperty(globalThis, 'Highlight', {
    configurable: true,
    value: TestHighlight,
  })
  scrollIntoView = vi.fn()
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: scrollIntoView,
  })
  writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  })
})

afterEach(() => {
  useStreamStore.getState().reset()
  BranchTreeInspector.__setComputationProbeForTests(undefined)
  restoreProperty(globalThis, 'CSS', cssDescriptor)
  restoreProperty(globalThis, 'Highlight', highlightDescriptor)
  restoreProperty(HTMLElement.prototype, 'scrollIntoView', scrollIntoViewDescriptor)
  restoreProperty(navigator, 'clipboard', clipboardDescriptor)
})

function highlightedText(name: string): string[] {
  return [...(highlightRegistry.get(name) ?? [])].map((range) => range.toString())
}

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: 'message-1',
    chatId: 'chat-1',
    parentId: null,
    siblingIndex: 0,
    turnId: 'turn-1',
    turnIndex: 0,
    createdAt: 1_700_000_000_000,
    role: 'assistant',
    origin: 'generated',
    content: [{ type: 'output_text', text: '# Rendered heading\n\nInspector body.' }],
    generation: {
      id: 'generation-1',
      model: 'vendor/inspector-model',
      requestedModel: 'vendor/inspector-model',
      apiUsed: 'chat',
      delivery: 'streaming',
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      cost: 0.001,
      costSource: 'stream',
      startedAt: 1_700_000_000_000,
      finishedAt: 1_700_000_001_000,
    },
    nodeVersion: 1,
    deleted: false,
    ...overrides,
  }
}

describe('BranchTreeInspector', () => {
  it('renders Markdown and media, and toggles metadata like the transcript action row', () => {
    const onActivate = vi.fn()
    const onClose = vi.fn()
    const imageUrl = 'data:image/png;base64,aW5zcGVjdG9y'
    const row = message({
      content: [
        { type: 'output_text', text: '# Rendered heading\n\nInspector body.' },
        { type: 'output_image', url: imageUrl, prompt: 'Inspector image' },
      ],
    })
    const { container } = render(
      <BranchTreeInspector message={row} onActivate={onActivate} onClose={onClose} />,
    )

    expect(screen.getByRole('heading', { level: 1, name: 'Rendered heading' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: 'Assistant message' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Inspector image' })).toHaveAttribute('src', imageUrl)
    expect(container.querySelector('[data-ui="message-info"]')).not.toBeInTheDocument()
    const info = screen.getByRole('button', { name: 'Show message info' })
    expect(info).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(info)
    expect(container.querySelector('[data-ui="message-info"]')).toHaveTextContent(
      'vendor/inspector-model',
    )
    expect(container.querySelector('[data-ui="message-info"]')).toHaveTextContent('Prompt tokens')
    fireEvent.click(screen.getByRole('button', { name: 'Hide message info' }))
    expect(container.querySelector('[data-ui="message-info"]')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Open this branch' }))
    expect(onActivate).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Close message inspector' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('copies plaintext and exposes the supplied delete action', async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined)
    render(
      <BranchTreeInspector
        message={message({
          content: [
            { type: 'output_text', text: 'Copy **this**.' },
            { type: 'output_text', text: ' And this.' },
          ],
        })}
        onClose={() => undefined}
        onDelete={onDelete}
      />,
    )

    const copy = screen.getByRole('button', { name: 'Copy message' })
    expect(copy).toHaveAttribute('title', 'Copy message text')
    fireEvent.click(copy)
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('Copy **this**. And this.'))

    const remove = screen.getByRole('button', { name: 'Delete message' })
    expect(remove).toHaveAttribute('data-variant', 'danger')
    fireEvent.click(remove)
    await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(1))
  })

  it('renders structured reasoning while keeping in-place edits strictly text-only', async () => {
    const reasoningDetails = [
      {
        type: 'reasoning.summary' as const,
        summary: 'A concise reasoning summary.',
        format: 'openai-responses-v1' as const,
      },
    ]
    const attachmentRefs = [
      {
        refId: 'ref-1',
        attachmentId: 'attachment-1',
        includeInContext: true,
        presentation: { label: 'evidence.txt' },
        createdAt: 1,
        updatedAt: 1,
      },
    ]
    const providerOutputItems = [
      {
        dialect: 'openai-responses' as const,
        type: 'reasoning',
        outputIndex: 0,
        item: { type: 'reasoning', id: 'reasoning-1', encrypted_content: 'sealed' },
      },
    ]
    const row = message({ reasoningDetails, attachmentRefs, providerOutputItems })
    const onEdit = vi.fn().mockResolvedValue(undefined)
    const { container } = render(
      <BranchTreeInspector message={row} onClose={() => undefined} onEdit={onEdit} />,
    )

    expect(container.querySelector('[data-ui="reasoning"]')).toHaveTextContent('Reasoning')
    const reasoning = container.querySelector<HTMLDetailsElement>('[data-ui="reasoning"]')
    if (!reasoning) throw new Error('Reasoning disclosure missing')
    reasoning.open = true
    fireEvent(reasoning, new Event('toggle'))
    expect(container.querySelector('[data-ui="reasoning"]')).toHaveTextContent(
      'A concise reasoning summary.',
    )
    await waitFor(() => {
      const chip = container.querySelector('[data-ui="attachment-chip"]')
      expect(chip).toHaveAttribute('data-storage', 'missing')
      expect(chip).toHaveTextContent('missing')
    })

    fireEvent.click(screen.getByRole('button', { name: 'Edit message' }))
    const editor = screen.getByRole('textbox', { name: 'Edit assistant message' })
    expect(screen.queryByRole('button', { name: 'Upload attachment' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Edit reasoning summary 1')).not.toBeInTheDocument()
    fireEvent.change(editor, { target: { value: '  Updated inspector body.  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(onEdit).toHaveBeenCalledTimes(1))
    expect(onEdit).toHaveBeenCalledWith(row, '  Updated inspector body.  ')
    await waitFor(() =>
      expect(
        screen.queryByRole('textbox', { name: 'Edit assistant message' }),
      ).not.toBeInTheDocument(),
    )
  })

  it('exposes generation, fork, context, reasoning, and provider-tool actions', async () => {
    const onRegenerate = vi.fn().mockResolvedValue(undefined)
    const onContinue = vi.fn().mockResolvedValue(undefined)
    const onForkChat = vi.fn().mockResolvedValue(undefined)
    const onToggleContextVisibility = vi.fn().mockResolvedValue(undefined)
    const onToggleReasoningDetailHidden = vi.fn().mockResolvedValue(undefined)
    const onToggleProviderOutputItemHidden = vi.fn().mockResolvedValue(undefined)
    const row = message({
      reasoningDetails: [
        {
          type: 'reasoning.text',
          text: 'Inspect this reasoning.',
          format: 'anthropic-claude-v1',
        },
      ],
      providerOutputItems: [
        {
          dialect: 'openai-responses',
          type: 'web_search_call',
          outputIndex: 0,
          item: {
            type: 'web_search_call',
            id: 'search-1',
            status: 'completed',
            action: { type: 'search', query: 'tree action parity' },
          },
        },
      ],
    })
    const { container } = render(
      <BranchTreeInspector
        message={row}
        onClose={() => undefined}
        onRegenerate={onRegenerate}
        onContinue={onContinue}
        onForkChat={onForkChat}
        onToggleContextVisibility={onToggleContextVisibility}
        onToggleReasoningDetailHidden={onToggleReasoningDetailHidden}
        onToggleProviderOutputItemHidden={onToggleProviderOutputItemHidden}
        hasConnection
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Regenerate response' }))
    fireEvent.click(screen.getByRole('button', { name: 'Continue from here' }))
    fireEvent.click(screen.getByRole('button', { name: 'Branch this chat from here' }))
    fireEvent.click(screen.getByRole('button', { name: 'Hide from context (never send to model)' }))

    const reasoning = container.querySelector<HTMLDetailsElement>('[data-ui="reasoning"]')
    if (!reasoning) throw new Error('Reasoning disclosure missing')
    reasoning.open = true
    fireEvent(reasoning, new Event('toggle'))
    fireEvent.click(screen.getByRole('button', { name: 'Hide this reasoning block' }))

    const toolEvidence = container.querySelector<HTMLDetailsElement>('[data-ui="tool-evidence"]')
    expect(toolEvidence).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Hide tool call' }))

    await waitFor(() => expect(onRegenerate).toHaveBeenCalledOnce())
    expect(onContinue).toHaveBeenCalledOnce()
    expect(onForkChat).toHaveBeenCalledOnce()
    expect(onToggleContextVisibility).toHaveBeenCalledOnce()
    expect(onToggleReasoningDetailHidden).toHaveBeenCalledWith(0)
    expect(onToggleProviderOutputItemHidden).toHaveBeenCalledWith(0)
  })

  it('shows persisted message, reasoning, and tool visibility states', () => {
    const { container } = render(
      <BranchTreeInspector
        message={message({
          hiddenFromContext: true,
          reasoningDetails: [
            {
              type: 'reasoning.text',
              text: 'Hidden reasoning.',
              hidden: true,
            },
          ],
          providerOutputItems: [
            {
              dialect: 'openai-responses',
              type: 'web_search_call',
              outputIndex: 0,
              hidden: true,
              item: { type: 'web_search_call', id: 'search-hidden', status: 'completed' },
            },
          ],
        })}
        onClose={() => undefined}
        onToggleContextVisibility={() => undefined}
        onToggleReasoningDetailHidden={() => undefined}
        onToggleProviderOutputItemHidden={() => undefined}
      />,
    )

    expect(screen.getByRole('button', { name: 'Show in context (send to model)' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    const reasoning = container.querySelector<HTMLDetailsElement>('[data-ui="reasoning"]')
    if (!reasoning) throw new Error('Reasoning disclosure missing')
    reasoning.open = true
    fireEvent(reasoning, new Event('toggle'))
    expect(screen.getByRole('button', { name: 'Unhide this reasoning block' })).toBeInTheDocument()
    expect(container.querySelector('[data-ui="reasoning-row"]')).toHaveAttribute(
      'data-hidden',
      'true',
    )
    expect(screen.getByRole('button', { name: 'Unhide tool call' })).toBeInTheDocument()
    expect(container.querySelector('[data-ui="tool-evidence-section"]')).toHaveAttribute(
      'data-hidden',
      'true',
    )
  })

  it('offers Save & Send for user edits and keeps the draft open on failure', async () => {
    const userMessage = message({
      role: 'user',
      origin: 'user',
      content: [{ type: 'text', text: 'Original prompt' }],
    })
    const onEditAndSend = vi
      .fn()
      .mockRejectedValueOnce(new Error('Temporary send failure'))
      .mockResolvedValueOnce(undefined)
    render(
      <BranchTreeInspector
        message={userMessage}
        onClose={() => undefined}
        onEdit={() => undefined}
        onEditAndSend={onEditAndSend}
        hasConnection
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Edit message' }))
    const editor = screen.getByRole('textbox', { name: 'Edit user message' })
    fireEvent.change(editor, { target: { value: 'Edited prompt' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save & Send' }))
    await waitFor(() => expect(onEditAndSend).toHaveBeenCalledWith(userMessage, 'Edited prompt'))
    expect(await screen.findByRole('alert')).toHaveTextContent('Temporary send failure')
    expect(screen.getByRole('textbox', { name: 'Edit user message' })).toHaveValue('Edited prompt')

    fireEvent.click(screen.getByRole('button', { name: 'Save & Send' }))
    await waitFor(() => expect(onEditAndSend).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(screen.queryByRole('textbox', { name: 'Edit user message' })).not.toBeInTheDocument(),
    )
  })

  it('preserves an active edit draft when a newer body snapshot arrives', () => {
    const onEdit = vi.fn().mockResolvedValue(undefined)
    const view = render(
      <BranchTreeInspector message={message()} onClose={() => undefined} onEdit={onEdit} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Edit message' }))
    const editor = screen.getByRole('textbox', { name: 'Edit assistant message' })
    fireEvent.change(editor, { target: { value: 'Unsaved local draft' } })

    view.rerender(
      <BranchTreeInspector
        message={message({
          nodeVersion: 2,
          content: [{ type: 'output_text', text: 'New persisted body' }],
        })}
        onClose={() => undefined}
        onEdit={onEdit}
      />,
    )

    expect(screen.getByRole('textbox', { name: 'Edit assistant message' })).toHaveValue(
      'Unsaved local draft',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByText('New persisted body')).toBeInTheDocument()
  })

  it('keeps header-only controls available but disables body-row actions while streaming', async () => {
    const row = message({
      reasoningDetails: [{ type: 'reasoning.text', text: 'Persisted reasoning.' }],
      providerOutputItems: [
        {
          dialect: 'openai-responses',
          type: 'web_search_call',
          item: {
            type: 'web_search_call',
            id: 'stream-search',
            status: 'completed',
            action: { type: 'search', query: 'stream parity' },
          },
        },
      ],
    })
    useStreamStore.getState().setActive({
      streamId: 'stream-1',
      replacementEpoch: 0,
      chatId: row.chatId,
      messageId: row.id,
      attemptKind: 'continuation',
      startedAt: 1,
      ownerClientId: 'client-1',
    })
    useStreamStore.getState().setLiveSnapshot({
      streamId: 'stream-1',
      replacementEpoch: 0,
      chatId: row.chatId,
      messageId: row.id,
      content: [{ type: 'output_text', text: 'Live inspector output.' }],
      reasoningRows: [{ detail: { type: 'reasoning.text', text: 'Live reasoning.' } }],
      textLength: 22,
      reasoningLength: 15,
      updatedAt: 2,
    })

    const view = render(
      <BranchTreeInspector
        message={row}
        onClose={() => undefined}
        onEdit={() => undefined}
        onDelete={() => undefined}
        onRegenerate={() => undefined}
        onContinue={() => undefined}
        onForkChat={() => undefined}
        onToggleContextVisibility={() => undefined}
        onToggleReasoningDetailHidden={() => undefined}
        onToggleProviderOutputItemHidden={() => undefined}
        hasConnection
      />,
    )
    const { container } = view

    expect(container.querySelector('[data-ui="markdown"]')).toHaveTextContent(
      'Live inspector output.',
    )
    expect(container.querySelector('[data-ui="markdown"]')).not.toHaveTextContent('Inspector body.')
    expect(screen.getByRole('button', { name: 'Edit message' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Delete message' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Continue from here' })).toBeDisabled()
    expect(
      screen.getByRole('button', { name: 'Hide from context (never send to model)' }),
    ).toBeEnabled()
    const reasoning = document.querySelector<HTMLDetailsElement>('[data-ui="reasoning"]')
    if (!reasoning) throw new Error('Reasoning disclosure missing')
    reasoning.open = true
    fireEvent(reasoning, new Event('toggle'))
    expect(reasoning).toHaveTextContent('Live reasoning.')
    expect(reasoning).not.toHaveTextContent('Persisted reasoning.')
    expect(screen.getByRole('button', { name: 'Hide this reasoning block' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Hide tool call' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Regenerate response' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Branch this chat from here' })).toBeEnabled()

    useStreamStore.getState().clearLiveSnapshot(row.id, 'stream-1', 0)
    expect(screen.getByRole('button', { name: 'Hide this reasoning block' })).toBeDisabled()
    useStreamStore.getState().clearActive('stream-1', 0)
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Hide this reasoning block' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Hide tool call' })).toBeEnabled()

    view.rerender(
      <BranchTreeInspector
        message={{
          ...row,
          nodeVersion: row.nodeVersion + 1,
          content: [{ type: 'output_text', text: 'Live inspector output.' }],
          reasoningDetails: [{ type: 'reasoning.text', text: 'Live reasoning.' }],
        }}
        onClose={() => undefined}
        onEdit={() => undefined}
        onDelete={() => undefined}
        onRegenerate={() => undefined}
        onContinue={() => undefined}
        onForkChat={() => undefined}
        onToggleContextVisibility={() => undefined}
        onToggleReasoningDetailHidden={() => undefined}
        onToggleProviderOutputItemHidden={() => undefined}
        hasConnection
      />,
    )
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Hide this reasoning block' })).toBeEnabled(),
    )
    expect(screen.getByRole('button', { name: 'Hide tool call' })).toBeEnabled()
  })

  it('distinguishes local waiting, local streaming, off-path, and remote stream states', async () => {
    const row = message()
    act(() => {
      useStreamStore.getState().setActive({
        streamId: 'status-stream',
        replacementEpoch: 0,
        chatId: row.chatId,
        messageId: row.id,
        attemptKind: 'continuation',
        startedAt: 1,
        ownerClientId: getStreamClientId(),
      })
    })
    const view = render(
      <BranchTreeInspector message={row} onClose={() => undefined} streamOnActivePath />,
    )

    expect(screen.getByRole('status')).toHaveTextContent('Waiting for response…')

    act(() => {
      useStreamStore.getState().setLiveSnapshot({
        streamId: 'status-stream',
        replacementEpoch: 0,
        chatId: row.chatId,
        messageId: row.id,
        content: [{ type: 'output_text', text: 'Live status content.' }],
        textLength: 20,
        reasoningLength: 0,
        updatedAt: 2,
      })
    })
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Streaming response…'))

    view.rerender(
      <BranchTreeInspector message={row} onClose={() => undefined} streamOnActivePath={false} />,
    )
    expect(screen.getByRole('status')).toHaveTextContent(
      'Streaming on another branch. Open this branch to follow live output.',
    )

    act(() => {
      useStreamStore.getState().setActive({
        streamId: 'status-stream',
        replacementEpoch: 0,
        chatId: row.chatId,
        messageId: row.id,
        attemptKind: 'continuation',
        startedAt: 1,
        ownerClientId: 'different-tab-client',
      })
    })
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        'This response is currently streaming in another tab.',
      ),
    )
    expect(screen.getByRole('status')).toHaveAttribute(
      'data-ui',
      'branch-tree-inspector-stream-status',
    )
  })

  it('uses the canonical terminal body before the current generation snapshot clears', async () => {
    const completedGeneration = message().generation
    if (!completedGeneration) throw new Error('Expected generated message metadata')
    const { finishedAt: _finishedAt, ...pendingGeneration } = completedGeneration
    const row = message({ generation: { ...pendingGeneration, status: 'streaming' } })
    act(() => {
      useStreamStore.getState().setActive({
        streamId: 'commit-gap-stream',
        replacementEpoch: 0,
        chatId: row.chatId,
        messageId: row.id,
        attemptKind: 'generation',
        startedAt: 1,
        ownerClientId: getStreamClientId(),
      })
      useStreamStore.getState().setLiveSnapshot({
        streamId: 'commit-gap-stream',
        replacementEpoch: 0,
        chatId: row.chatId,
        messageId: row.id,
        content: [{ type: 'output_text', text: 'Last complete live snapshot.' }],
        textLength: 28,
        reasoningLength: 0,
        updatedAt: 2,
      })
    })
    const view = render(
      <BranchTreeInspector message={row} onClose={() => undefined} streamOnActivePath />,
    )
    expect(screen.getByText('Last complete live snapshot.')).toBeInTheDocument()

    view.rerender(
      <BranchTreeInspector
        message={message({
          nodeVersion: 2,
          content: [{ type: 'output_text', text: 'Committed snapshot content.' }],
          generation: {
            ...completedGeneration,
            status: 'done',
            finishedAt: 1_700_000_002_000,
          },
        })}
        onClose={() => undefined}
        streamOnActivePath
      />,
    )

    await waitFor(() => expect(screen.getByText('Committed snapshot content.')).toBeInTheDocument())
    expect(screen.queryByText('Last complete live snapshot.')).not.toBeInTheDocument()

    act(() => {
      useStreamStore.getState().clearLiveSnapshot(row.id, 'commit-gap-stream', 0)
      useStreamStore.getState().clearActive('commit-gap-stream', 0)
    })
    expect(screen.getByText('Committed snapshot content.')).toBeInTheDocument()
  })

  it('settles a committed snapshot before the live store clears under StrictMode', async () => {
    const completedGeneration = message().generation
    if (!completedGeneration) throw new Error('Expected generated message metadata')
    const { finishedAt: _finishedAt, ...pendingGeneration } = completedGeneration
    const pending = message({ generation: { ...pendingGeneration, status: 'streaming' } })
    act(() => {
      useStreamStore.getState().setActive({
        streamId: 'commit-first-stream',
        replacementEpoch: 0,
        chatId: pending.chatId,
        messageId: pending.id,
        attemptKind: 'generation',
        startedAt: 1,
        ownerClientId: getStreamClientId(),
      })
      useStreamStore.getState().setLiveSnapshot({
        streamId: 'commit-first-stream',
        replacementEpoch: 0,
        chatId: pending.chatId,
        messageId: pending.id,
        content: [{ type: 'output_text', text: 'Commit-first live snapshot.' }],
        textLength: 27,
        reasoningLength: 0,
        updatedAt: 2,
      })
    })
    const view = render(
      <StrictMode>
        <BranchTreeInspector message={pending} onClose={() => undefined} onEdit={() => undefined} />
      </StrictMode>,
    )
    expect(screen.getByText('Commit-first live snapshot.')).toBeInTheDocument()

    view.rerender(
      <StrictMode>
        <BranchTreeInspector
          message={message({
            nodeVersion: pending.nodeVersion + 1,
            content: [{ type: 'output_text', text: 'Commit-first persisted snapshot.' }],
            generation: {
              ...completedGeneration,
              status: 'done',
              finishedAt: 1_700_000_002_000,
            },
          })}
          onClose={() => undefined}
          onEdit={() => undefined}
        />
      </StrictMode>,
    )
    expect(screen.getByText('Commit-first persisted snapshot.')).toBeInTheDocument()

    act(() => {
      useStreamStore.getState().clearActive('commit-first-stream', 0)
      useStreamStore.getState().clearLiveSnapshot(pending.id, 'commit-first-stream', 0)
    })
    await waitFor(() => expect(screen.queryByText('Finishing response…')).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Edit message' })).toBeEnabled()
  })

  it('reads the current snapshot across views without retaining a second copy', async () => {
    const completedGeneration = message().generation
    if (!completedGeneration) throw new Error('Expected generated message metadata')
    const { finishedAt: _finishedAt, ...pendingGeneration } = completedGeneration
    const pending = message({ generation: { ...pendingGeneration, status: 'streaming' } })
    act(() => {
      useStreamStore.getState().setActive({
        streamId: 'cross-view-stream',
        replacementEpoch: 0,
        chatId: pending.chatId,
        messageId: pending.id,
        attemptKind: 'generation',
        startedAt: 1,
        ownerClientId: getStreamClientId(),
      })
      useStreamStore.getState().setLiveSnapshot({
        streamId: 'cross-view-stream',
        replacementEpoch: 0,
        chatId: pending.chatId,
        messageId: pending.id,
        content: [{ type: 'output_text', text: 'Visible before changing views.' }],
        textLength: 30,
        reasoningLength: 0,
        updatedAt: 2,
      })
    })
    const firstView = render(<BranchTreeInspector message={pending} onClose={() => undefined} />)
    expect(screen.getByText('Visible before changing views.')).toBeInTheDocument()
    firstView.unmount()

    const nextView = render(<BranchTreeInspector message={pending} onClose={() => undefined} />)
    expect(screen.getByText('Visible before changing views.')).toBeInTheDocument()
    expect(screen.queryByText('Inspector body.')).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Streaming response…')

    nextView.rerender(
      <BranchTreeInspector
        message={message({
          nodeVersion: pending.nodeVersion + 1,
          content: [{ type: 'output_text', text: 'Committed after changing views.' }],
          generation: {
            ...completedGeneration,
            status: 'done',
            finishedAt: 1_700_000_002_000,
          },
        })}
        onClose={() => undefined}
      />,
    )
    await waitFor(() =>
      expect(screen.getByText('Committed after changing views.')).toBeInTheDocument(),
    )
    expect(screen.queryByText('Visible before changing views.')).not.toBeInTheDocument()

    act(() => {
      useStreamStore.getState().clearLiveSnapshot(pending.id, 'cross-view-stream', 0)
      useStreamStore.getState().clearActive('cross-view-stream', 0)
    })
    expect(screen.getByText('Committed after changing views.')).toBeInTheDocument()
  })

  it('treats persisted streaming generation state as target-busy without an active lease', () => {
    const row = message()
    if (!row.generation) throw new Error('Expected generated message metadata')
    const { finishedAt: _finishedAt, ...pendingGeneration } = row.generation
    render(
      <BranchTreeInspector
        message={message({
          generation: {
            ...pendingGeneration,
            status: 'streaming',
          },
        })}
        onClose={() => undefined}
        onEdit={() => undefined}
        onDelete={() => undefined}
        onContinue={() => undefined}
        hasConnection
      />,
    )

    expect(screen.getByRole('status')).toHaveTextContent('Finishing response…')
    expect(screen.getByRole('button', { name: 'Edit message' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Delete message' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Continue from here' })).toBeDisabled()
  })

  it('surfaces committed provider errors and aborts after streaming ends', () => {
    const generation = message().generation
    if (!generation) throw new Error('Expected generated message metadata')
    const view = render(
      <BranchTreeInspector
        message={message({
          content: [],
          generation: {
            ...generation,
            status: 'error',
            error: {
              category: 'provider',
              code: 'upstream_error',
              message: 'Provider rejected the request.',
              statusCode: 503,
            },
          },
        })}
        onClose={() => undefined}
      />,
    )
    expect(screen.getByRole('status')).toHaveTextContent(
      'Error 503: Provider rejected the request.',
    )
    expect(screen.getByRole('status')).toHaveAttribute('data-state', 'error')

    view.rerender(
      <BranchTreeInspector
        message={message({
          content: [],
          generation: { ...generation, status: 'abort', abortReason: 'user' },
        })}
        onClose={() => undefined}
      />,
    )
    expect(screen.getByRole('status')).toHaveTextContent(
      'Cancelled — partial response kept above. Continue to resume.',
    )
    expect(screen.getByRole('status')).toHaveAttribute('data-state', 'warning')
  })

  it('keeps model-request actions available while another message is streaming', () => {
    const onRegenerate = vi.fn()
    const onContinue = vi.fn()
    const row = message()
    act(() => {
      useStreamStore.getState().setActive({
        streamId: 'other-message-stream',
        replacementEpoch: 0,
        chatId: row.chatId,
        messageId: 'other-message',
        startedAt: 1,
        ownerClientId: getStreamClientId(),
      })
    })
    const assistant = render(
      <BranchTreeInspector
        message={row}
        onClose={() => undefined}
        onRegenerate={onRegenerate}
        onContinue={onContinue}
        hasConnection
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Regenerate response' }))
    fireEvent.click(screen.getByRole('button', { name: 'Continue from here' }))
    expect(screen.getByRole('button', { name: 'Regenerate response' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Continue from here' })).toBeEnabled()
    expect(onRegenerate).toHaveBeenCalledOnce()
    expect(onContinue).toHaveBeenCalledOnce()
    assistant.unmount()

    render(
      <BranchTreeInspector
        message={message({ role: 'user', origin: 'user' })}
        onClose={() => undefined}
        onEdit={() => undefined}
        onEditAndSend={() => undefined}
        hasConnection
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Edit message' }))
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Save & Send' })).toBeEnabled()
  })

  it('does not rebuild bounded prefixes or search ranges for cumulative streaming snapshots', () => {
    const operations: string[] = []
    BranchTreeInspector.__setComputationProbeForTests((operation) => operations.push(operation))
    const row = message()
    useStreamStore.getState().setActive({
      streamId: 'stream-projection',
      replacementEpoch: 0,
      chatId: row.chatId,
      messageId: row.id,
      attemptKind: 'continuation',
      startedAt: 1,
      ownerClientId: 'client-1',
    })
    const publish = (length: number, updatedAt: number) => {
      const text = `needle ${'x'.repeat(length - 7)}`
      useStreamStore.getState().setLiveSnapshot({
        streamId: 'stream-projection',
        replacementEpoch: 0,
        chatId: row.chatId,
        messageId: row.id,
        content: [{ type: 'output_text', text }],
        textLength: text.length,
        reasoningLength: 0,
        updatedAt,
      })
    }
    publish(110_000, 2)

    const { container } = render(
      <BranchTreeInspector message={row} searchQuery="needle" onClose={() => undefined} />,
    )
    expect(operations.filter((operation) => operation === 'bounded-projection')).toHaveLength(0)
    expect(operations.filter((operation) => operation === 'search-scan')).toHaveLength(0)
    expect(container).toHaveTextContent('110,000 text characters')
    expect(container).toHaveTextContent(
      'Search highlighting resumes when this response finishes streaming.',
    )

    act(() => {
      publish(120_000, 3)
      publish(130_000, 4)
    })

    expect(container).toHaveTextContent('130,000 text characters')
    expect(operations.filter((operation) => operation === 'bounded-projection')).toHaveLength(0)
    expect(operations.filter((operation) => operation === 'search-scan')).toHaveLength(0)
  })

  it('cancels without saving and keeps the editor open when saving fails', async () => {
    const onEdit = vi.fn().mockRejectedValue(new Error('workspace write failed'))
    render(<BranchTreeInspector message={message()} onClose={() => undefined} onEdit={onEdit} />)

    fireEvent.click(screen.getByRole('button', { name: 'Edit message' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Edit assistant message' }), {
      target: { value: 'Rejected edit.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Edit failed: workspace write failed',
    )
    expect(screen.getByRole('textbox', { name: 'Edit assistant message' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(
      screen.queryByRole('textbox', { name: 'Edit assistant message' }),
    ).not.toBeInTheDocument()
    expect(screen.getByText('Inspector body.')).toBeInTheDocument()
    expect(onEdit).toHaveBeenCalledTimes(1)
  })

  it('restores the rendered message when an edit is cancelled', () => {
    const onEdit = vi.fn()
    render(<BranchTreeInspector message={message()} onClose={() => undefined} onEdit={onEdit} />)

    fireEvent.click(screen.getByRole('button', { name: 'Edit message' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Edit assistant message' }), {
      target: { value: 'Discard this text.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.getByText('Inspector body.')).toBeInTheDocument()
    expect(onEdit).not.toHaveBeenCalled()
  })

  it('highlights rendered occurrences and navigates the current occurrence in both directions', async () => {
    render(
      <BranchTreeInspector
        message={message({
          content: [
            {
              type: 'output_text',
              text: 'Needle first, **needle second**, then NEEDLE third.',
            },
          ],
        })}
        searchQuery="needle"
        onClose={() => undefined}
      />,
    )

    await waitFor(() => expect(screen.getByText('1 / 3')).toBeInTheDocument())
    expect(highlightedText(SEARCH_MATCH_HIGHLIGHT)).toEqual(['needle', 'NEEDLE'])
    expect(highlightedText(SEARCH_CURRENT_HIGHLIGHT)).toEqual(['Needle'])
    expect(scrollIntoView).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Next occurrence in message' }))
    expect(screen.getByText('2 / 3')).toBeInTheDocument()
    expect(highlightedText(SEARCH_MATCH_HIGHLIGHT)).toEqual(['Needle', 'NEEDLE'])
    expect(highlightedText(SEARCH_CURRENT_HIGHLIGHT)).toEqual(['needle'])

    fireEvent.click(screen.getByRole('button', { name: 'Previous occurrence in message' }))
    expect(screen.getByText('1 / 3')).toBeInTheDocument()
    expect(highlightedText(SEARCH_CURRENT_HIGHLIGHT)).toEqual(['Needle'])
    expect(scrollIntoView).toHaveBeenCalledTimes(3)
  })

  it('explains a tree-search match that only exists in Markdown source', async () => {
    render(
      <BranchTreeInspector
        message={message({
          content: [{ type: 'output_text', text: '[visible label](https://example.com/path)' }],
        })}
        onClose={() => undefined}
        searchQuery="example.com"
        searchMatched
      />,
    )

    await waitFor(() =>
      expect(
        screen.getByText(/match is in Markdown source or other non-rendered text/),
      ).toBeVisible(),
    )
    expect(screen.getByText('0 / 0')).toBeVisible()
  })

  it('bounds dense rendered highlights while retaining the exact occurrence count', async () => {
    render(
      <BranchTreeInspector
        message={message({ content: [{ type: 'output_text', text: 'x'.repeat(100_000) }] })}
        searchQuery="x"
        onClose={() => undefined}
      />,
    )

    await waitFor(() => expect(screen.getByText('1 / 1,000+')).toBeInTheDocument())
    expect(
      [...highlightRegistry.values()].reduce((total, highlight) => total + highlight.size, 0),
    ).toBe(1_000)
    expect(screen.getByText(/First 1,000 of 100,000 occurrences highlighted/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Previous occurrence in message' }))
    expect(screen.getByText('1,000 / 1,000+')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Next occurrence in message' }))
    expect(screen.getByText('1 / 1,000+')).toBeInTheDocument()
  })

  it('rebuilds search ranges when an asynchronous renderer replaces Markdown text nodes', async () => {
    const { container } = render(
      <BranchTreeInspector
        message={message({ content: [{ type: 'output_text', text: 'needle before render' }] })}
        searchQuery="needle"
        onClose={() => undefined}
      />,
    )
    await waitFor(() => expect(highlightedText(SEARCH_CURRENT_HIGHLIGHT)).toEqual(['needle']))
    const markdown = container.querySelector('[data-ui="markdown"]')
    if (!markdown) throw new Error('Missing Markdown root')

    markdown.replaceChildren(document.createTextNode('needle after render and another needle'))

    await waitFor(() => expect(screen.getByText('1 / 2')).toBeInTheDocument())
    expect(highlightedText(SEARCH_CURRENT_HIGHLIGHT)).toEqual(['needle'])
    expect(highlightedText(SEARCH_MATCH_HIGHLIGHT)).toEqual(['needle'])
  })

  it('replaces and cleans search highlight registry entries on query, message, and unmount', async () => {
    const view = render(
      <BranchTreeInspector
        message={message({ content: [{ type: 'output_text', text: 'First needle.' }] })}
        searchQuery="needle"
        onClose={() => undefined}
      />,
    )
    await waitFor(() => expect(highlightedText(SEARCH_CURRENT_HIGHLIGHT)).toEqual(['needle']))

    view.rerender(
      <BranchTreeInspector
        message={message({
          id: 'message-2',
          content: [{ type: 'output_text', text: 'Second target.' }],
        })}
        searchQuery="target"
        onClose={() => undefined}
      />,
    )
    await waitFor(() => expect(highlightedText(SEARCH_CURRENT_HIGHLIGHT)).toEqual(['target']))
    expect(highlightedText(SEARCH_MATCH_HIGHLIGHT)).toEqual([])

    view.rerender(
      <BranchTreeInspector
        message={message({
          id: 'message-2',
          content: [{ type: 'output_text', text: 'Second target.' }],
        })}
        searchQuery="   "
        onClose={() => undefined}
      />,
    )
    expect(highlightRegistry.has(SEARCH_MATCH_HIGHLIGHT)).toBe(false)
    expect(highlightRegistry.has(SEARCH_CURRENT_HIGHLIGHT)).toBe(false)

    view.rerender(
      <BranchTreeInspector
        message={message({
          id: 'message-2',
          content: [{ type: 'output_text', text: 'Second target.' }],
        })}
        searchQuery="second"
        onClose={() => undefined}
      />,
    )
    await waitFor(() => expect(highlightRegistry.has(SEARCH_CURRENT_HIGHLIGHT)).toBe(true))
    view.unmount()
    expect(highlightRegistry.has(SEARCH_MATCH_HIGHLIGHT)).toBe(false)
    expect(highlightRegistry.has(SEARCH_CURRENT_HIGHLIGHT)).toBe(false)
  })

  it('renders only a bounded prefix until full display is explicitly requested', async () => {
    const first = `# Large message\n\n${'a'.repeat(60_000)}`
    const second = `${'b'.repeat(50_000)} TAIL_MARKER`
    const totalChars = first.length + second.length
    const row = message({
      id: 'large-1',
      content: [
        { type: 'output_text', text: first },
        { type: 'output_text', text: second },
      ],
    })
    const { container, rerender } = render(
      <BranchTreeInspector message={row} searchQuery="tail_marker" onClose={() => undefined} />,
    )

    const inspector = container.querySelector('[data-ui="branch-tree-inspector"]')
    expect(inspector).toHaveAttribute('data-text-overflow', 'prefix')
    expect(container).toHaveTextContent(`${totalChars.toLocaleString()} text characters`)
    expect(container).toHaveTextContent(
      `Showing the first ${(100_000).toLocaleString()} of ${totalChars.toLocaleString()} text characters.`,
    )
    expect(container).not.toHaveTextContent('TAIL_MARKER')
    expect(screen.getByText('0 / 0')).toBeInTheDocument()
    expect(container).toHaveTextContent(
      'At least one search match is beyond this bounded preview. Show the full message to inspect every occurrence.',
    )

    fireEvent.click(screen.getByRole('button', { name: 'Show full message' }))
    await waitFor(() => expect(container).toHaveTextContent('TAIL_MARKER'))
    await waitFor(() => expect(screen.getByText('1 / 1')).toBeInTheDocument())
    expect(highlightedText(SEARCH_CURRENT_HIGHLIGHT)).toEqual(['TAIL_MARKER'])
    expect(inspector).toHaveAttribute('data-text-overflow', 'full')

    const nextText = `${'c'.repeat(100_001)} SECOND_TAIL`
    rerender(
      <BranchTreeInspector
        message={message({
          id: 'large-2',
          content: [{ type: 'output_text', text: nextText }],
        })}
        searchQuery="SECOND_TAIL"
        onClose={() => undefined}
      />,
    )
    expect(container.querySelector('[data-ui="branch-tree-inspector"]')).toHaveAttribute(
      'data-text-overflow',
      'prefix',
    )
    expect(container.querySelector('[data-ui="markdown"]')).not.toHaveTextContent('SECOND_TAIL')
    expect(screen.getByText('0 / 0')).toBeInTheDocument()
    expect(container).toHaveTextContent('At least one search match is beyond this bounded preview.')
    expect(screen.getByRole('button', { name: 'Show full message' })).toBeInTheDocument()
  })
})
