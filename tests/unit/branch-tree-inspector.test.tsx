import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GenerationSubmission } from '../../src/app/presentation-interactions'
import { pendingGenerationCapability } from '../../src/core/interaction-capability'
import type { Message } from '../../src/core/types'
import { attemptController } from '../../src/store/attempt-controller'
import type { WorkspaceFence } from '../../src/store/presentation-contracts'
import { reconcileWorkspaceTabSessionStorage } from '../../src/store/workspace-tab-session'
import {
  BranchTreeInspector as BranchTreeInspectorComponent,
  type BranchTreeInspectorProps,
  observeBranchTreeInspectorComputations,
} from '../../src/ui/chat/BranchTreeInspector'
import {
  clearTestLiveProjection,
  observeTestAttempt,
  publishTestLiveProjection,
  removeTestAttempt,
  resetAttemptControllerForTests,
} from '../helpers/attempt-controller'
import {
  createInteractionSettlementHarness,
  succeededInteractionSettlement,
} from '../helpers/presentation-interactions'
import {
  liveReasoningFromDetailsForTest,
  reasoningEnvelopeFromDetailsForTest,
} from '../helpers/reasoning-events'

function BranchTreeInspector(
  props: Omit<BranchTreeInspectorProps, 'bodyVersion' | 'presentationFence'> & {
    bodyVersion?: number
    presentationFence?: WorkspaceFence
  },
) {
  return (
    <BranchTreeInspectorComponent
      {...props}
      presentationFence={props.presentationFence ?? presentationFence}
      bodyVersion={props.bodyVersion ?? props.message.nodeVersion}
    />
  )
}

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
let presentationFence: WorkspaceFence

function registerTestTargetHandoff(streamId: string, bodyVersion: number): void {
  const attempt = attemptController.get(streamId)
  if (!attempt?.messageId) throw new Error(`Expected active attempt:${streamId}`)
  attemptController.registerTargetCommitHandoff({
    ...presentationFence,
    streamId,
    chatId: attempt.chatId,
    messageId: attempt.messageId,
    attemptKind: attempt.kind,
    admissionSequence: attempt.admissionSequence,
    leaseRevision: attempt.leaseRevision + 1,
    bodyVersion,
  })
}

function publishTestExactTarget(streamId: string, bodyVersion: number): void {
  const attempt = attemptController.get(streamId)
  if (!attempt?.messageId) throw new Error(`Expected active attempt:${streamId}`)
  attemptController.publishExactTargetPresentations([
    {
      ...presentationFence,
      streamId,
      chatId: attempt.chatId,
      messageId: attempt.messageId,
      bodyVersion,
    },
  ])
}

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
  presentationFence = resetAttemptControllerForTests()
  reconcileWorkspaceTabSessionStorage(presentationFence)
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
  resetAttemptControllerForTests()
  observeBranchTreeInspectorComputations(undefined)
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
      reasoningCarryForward: 'none',
      reasoningVisibility: { disclosure: 'unknown' },
    },
    nodeVersion: 1,
    deleted: false,
    ...overrides,
  }
}

function startedGeneration(preparationError?: Error): GenerationSubmission {
  return {
    kind: 'started',
    admission: Promise.resolve({ kind: 'admitted' }),
    completion: Promise.resolve(
      preparationError
        ? {
            kind: 'not-prepared',
            reason: 'failed',
            failure: {
              message: preparationError.message,
              diagnosticId: 'generation-submit-test',
            },
          }
        : { kind: 'prepared' },
    ),
    cancel: () => undefined,
  }
}

describe('BranchTreeInspector', () => {
  it('renders Markdown and media carriers, and toggles metadata like the transcript action row', () => {
    const onActivate = vi.fn()
    const onClose = vi.fn()
    const row = message({
      content: [
        { type: 'output_text', text: '# Rendered heading\n\nInspector body.' },
        {
          type: 'output_image',
          attachmentId: 'attachment-inspector',
          prompt: 'Inspector image',
        },
      ],
    })
    const { container } = render(
      <BranchTreeInspector message={row} onActivate={onActivate} onClose={onClose} />,
    )

    expect(screen.getByRole('heading', { level: 1, name: 'Rendered heading' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: 'Assistant message' })).toBeInTheDocument()
    expect(container.querySelector('[data-ui="message-output-image"]')).toBeInTheDocument()
    expect(container.querySelector('[data-ui="message-output-image-missing"]')).toBeInTheDocument()
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
    const onDelete = vi.fn(() => succeededInteractionSettlement())
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

  it('keeps a pending structural mutation explicitly cancellable', () => {
    const onDelete = vi.fn(() => succeededInteractionSettlement())
    const onCancelStructuralMutation = vi.fn()
    render(
      <BranchTreeInspector
        message={message()}
        onClose={() => undefined}
        onDelete={onDelete}
        structuralMutationPending
        onCancelStructuralMutation={onCancelStructuralMutation}
      />,
    )

    const cancel = screen.getByRole('button', { name: 'Cancel conversation update' })
    expect(cancel).toBeEnabled()
    fireEvent.click(cancel)

    expect(onCancelStructuralMutation).toHaveBeenCalledOnce()
    expect(onDelete).not.toHaveBeenCalled()
  })

  it('renders structured reasoning while keeping in-place edits strictly text-only', async () => {
    const reasoningEnvelope = reasoningEnvelopeFromDetailsForTest(
      [
        {
          type: 'reasoning.summary' as const,
          summary: 'A concise reasoning summary.',
          format: 'openai-responses-v1' as const,
        },
      ],
      'openai-responses',
    )
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
    const row = message({ reasoningEnvelope, attachmentRefs, providerOutputItems })
    const onEdit = vi.fn(() => succeededInteractionSettlement())
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
    const onRegenerate = vi.fn(() => startedGeneration())
    const onContinue = vi.fn(() => startedGeneration())
    const onForkChat = vi.fn(() => succeededInteractionSettlement())
    const onToggleContextVisibility = vi.fn(() => succeededInteractionSettlement())
    const onToggleReasoningDetailHidden = vi.fn(() => succeededInteractionSettlement())
    const onToggleProviderOutputItemHidden = vi.fn(() => succeededInteractionSettlement())
    const reasoningEnvelope = reasoningEnvelopeFromDetailsForTest(
      [
        {
          type: 'reasoning.text',
          text: 'Inspect this reasoning.',
          format: 'anthropic-claude-v1',
        },
      ],
      'anthropic-messages',
    )
    const reasoningMember = reasoningEnvelope.visible[0]
    if (!reasoningMember) throw new Error('Expected reasoning member')
    const row = message({
      reasoningEnvelope,
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
    if (!toolEvidence) throw new Error('Tool evidence disclosure missing')
    toolEvidence.open = true
    fireEvent(toolEvidence, new Event('toggle'))
    fireEvent.click(screen.getByRole('button', { name: 'Hide tool call' }))

    await waitFor(() => expect(onRegenerate).toHaveBeenCalledOnce())
    expect(onContinue).toHaveBeenCalledOnce()
    expect(onForkChat).toHaveBeenCalledOnce()
    expect(onToggleContextVisibility).toHaveBeenCalledOnce()
    expect(onToggleReasoningDetailHidden).toHaveBeenCalledWith({
      owner: { kind: 'generation' },
      kind: 'visible',
      id: reasoningMember.id,
    })
    expect(onToggleProviderOutputItemHidden).toHaveBeenCalledWith({
      owner: { kind: 'generation' },
      itemIndex: 0,
    })
  })

  it('shows persisted message, reasoning, and tool visibility states', () => {
    const { container } = render(
      <BranchTreeInspector
        message={message({
          hiddenFromContext: true,
          reasoningEnvelope: reasoningEnvelopeFromDetailsForTest(
            [
              {
                type: 'reasoning.text',
                text: 'Hidden reasoning.',
                hidden: true,
                format: 'unknown',
              },
            ],
            'unknown',
          ),
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
        onToggleContextVisibility={succeededInteractionSettlement}
        onToggleReasoningDetailHidden={succeededInteractionSettlement}
        onToggleProviderOutputItemHidden={succeededInteractionSettlement}
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
    const toolEvidence = container.querySelector<HTMLDetailsElement>('[data-ui="tool-evidence"]')
    if (!toolEvidence) throw new Error('Tool evidence disclosure missing')
    toolEvidence.open = true
    fireEvent(toolEvidence, new Event('toggle'))
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
      .fn<() => GenerationSubmission>()
      .mockImplementationOnce(() => startedGeneration(new Error('Temporary send failure')))
      .mockImplementationOnce(() => startedGeneration())
    render(
      <BranchTreeInspector
        message={userMessage}
        onClose={() => undefined}
        onEdit={succeededInteractionSettlement}
        onEditAndSend={onEditAndSend}
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

  it('keeps Save & Send actionable while the new-node prompt path is pending', async () => {
    const userMessage = message({
      role: 'user',
      origin: 'imported',
      content: [{ type: 'text', text: 'Newly committed prompt' }],
    })
    const onEditAndSend = vi.fn(() => startedGeneration())
    render(
      <BranchTreeInspector
        message={userMessage}
        onClose={() => undefined}
        onEdit={succeededInteractionSettlement}
        onEditAndSend={onEditAndSend}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Edit message' }))
    const saveAndSend = screen.getByRole('button', { name: 'Save & Send' })
    expect(saveAndSend).toBeEnabled()
    fireEvent.click(saveAndSend)

    expect(onEditAndSend).toHaveBeenCalledOnce()
  })

  it('preserves an edit draft and reports when a ready action synchronously does not start', () => {
    const userMessage = message({
      role: 'user',
      origin: 'user',
      content: [{ type: 'text', text: 'Original prompt' }],
    })
    const onEditAndSend = vi.fn(
      (): GenerationSubmission => ({
        kind: 'not-started',
        capability: pendingGenerationCapability('prompt-path'),
      }),
    )
    render(
      <BranchTreeInspector
        message={userMessage}
        onClose={() => undefined}
        onEdit={succeededInteractionSettlement}
        onEditAndSend={onEditAndSend}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Edit message' }))
    const editor = screen.getByRole('textbox', { name: 'Edit user message' })
    fireEvent.change(editor, { target: { value: 'Still local' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save & Send' }))

    expect(onEditAndSend).toHaveBeenCalledWith(userMessage, 'Still local')
    expect(screen.getByRole('textbox', { name: 'Edit user message' })).toHaveValue('Still local')
    expect(screen.getByRole('alert')).toHaveTextContent(
      'This branch is still preparing. Save & Send did not start.',
    )
  })

  it('preserves an active edit draft when a newer body snapshot arrives', () => {
    const onEdit = vi.fn(() => succeededInteractionSettlement())
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

  it('does not let an older Save settlement dismiss a reopened editor for the same message', async () => {
    const settlements = createInteractionSettlementHarness()
    let resolveFirst!: () => void
    const firstSave = new Promise<void>((resolve) => {
      resolveFirst = resolve
    })
    const editedMessage = message({ id: 'message-reopened' })
    const interveningMessage = message({
      id: 'message-second',
      content: [{ type: 'output_text', text: 'Second message body.' }],
    })
    const onEdit = vi.fn((_row: Message) => settlements.run(() => firstSave))
    const view = render(
      <BranchTreeInspector message={editedMessage} onClose={() => undefined} onEdit={onEdit} />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Edit message' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Edit assistant message' }), {
      target: { value: 'First pending edit.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    view.rerender(
      <BranchTreeInspector
        message={interveningMessage}
        onClose={() => undefined}
        onEdit={onEdit}
      />,
    )
    expect(
      screen.queryByRole('textbox', { name: 'Edit assistant message' }),
    ).not.toBeInTheDocument()
    view.rerender(
      <BranchTreeInspector message={editedMessage} onClose={() => undefined} onEdit={onEdit} />,
    )
    const reopenedEditor = screen.getByRole('textbox', { name: 'Edit assistant message' })
    fireEvent.change(reopenedEditor, { target: { value: 'Reopened active edit.' } })

    resolveFirst()
    await waitFor(() => expect(onEdit).toHaveBeenCalledWith(editedMessage, 'First pending edit.'))
    expect(screen.getByRole('textbox', { name: 'Edit assistant message' })).toHaveValue(
      'Reopened active edit.',
    )
  })

  it('updates an exact body version without remounting the inspector body', () => {
    const view = render(<BranchTreeInspector message={message()} onClose={() => undefined} />)
    const body = view.container.querySelector<HTMLElement>('[data-ui="message-body"]')
    const markdown = body?.querySelector<HTMLElement>('[data-ui="markdown"]')
    if (!body || !markdown) throw new Error('Inspector body did not mount')
    body.dataset.retainedAcrossBodyVersion = 'true'
    markdown.dataset.retainedAcrossBodyVersion = 'true'

    view.rerender(
      <BranchTreeInspector
        message={message({
          nodeVersion: 2,
          content: [{ type: 'output_text', text: 'Updated exact inspector body.' }],
        })}
        onClose={() => undefined}
      />,
    )

    const updatedBody = view.container.querySelector<HTMLElement>('[data-ui="message-body"]')
    expect(updatedBody).toBe(body)
    expect(updatedBody).toHaveAttribute('data-retained-across-body-version', 'true')
    expect(updatedBody?.querySelector('[data-ui="markdown"]')).toBe(markdown)
    expect(markdown).toHaveAttribute('data-retained-across-body-version', 'true')
    expect(updatedBody).toHaveTextContent('Updated exact inspector body.')
  })

  it('keeps replacement generation actions live while protecting body mutations during streaming', async () => {
    const row = message({
      reasoningEnvelope: reasoningEnvelopeFromDetailsForTest(
        [{ type: 'reasoning.text', text: 'Persisted reasoning.', format: 'unknown' }],
        'unknown',
      ),
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
    observeTestAttempt({
      streamId: 'stream-1',
      chatId: row.chatId,
      messageId: row.id,
      kind: 'continuation',
    })

    const view = render(
      <BranchTreeInspector
        message={row}
        onClose={() => undefined}
        onEdit={succeededInteractionSettlement}
        onDelete={succeededInteractionSettlement}
        onRegenerate={() => startedGeneration()}
        onContinue={() => startedGeneration()}
        onForkChat={succeededInteractionSettlement}
        onToggleContextVisibility={succeededInteractionSettlement}
        onToggleReasoningDetailHidden={succeededInteractionSettlement}
        onToggleProviderOutputItemHidden={succeededInteractionSettlement}
      />,
    )
    const { container } = view
    act(() => {
      publishTestLiveProjection({
        streamId: 'stream-1',
        chatId: row.chatId,
        messageId: row.id,
        content: [{ type: 'output_text', text: 'Live inspector output.' }],
        reasoning: liveReasoningFromDetailsForTest(
          [{ type: 'reasoning.text', format: 'unknown', text: 'Live reasoning.' }],
          'unknown',
        ),
        textLength: 22,
        reasoningLength: 15,
        updatedAt: 2,
      })
    })

    expect(container.querySelector('[data-ui="markdown"]')).toHaveTextContent(
      'Live inspector output.',
    )
    expect(container.querySelector('[data-ui="markdown"]')).not.toHaveTextContent('Inspector body.')
    expect(screen.getByRole('button', { name: 'Edit message' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Delete message' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Continue from here' })).toBeEnabled()
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
    const toolEvidence = container.querySelector<HTMLDetailsElement>('[data-ui="tool-evidence"]')
    if (!toolEvidence) throw new Error('Tool evidence disclosure missing')
    toolEvidence.open = true
    fireEvent(toolEvidence, new Event('toggle'))
    expect(screen.getByRole('button', { name: 'Hide tool call' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Regenerate response' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Branch this chat from here' })).toBeEnabled()

    clearTestLiveProjection('stream-1')
    expect(screen.getByRole('button', { name: 'Hide this reasoning block' })).toBeDisabled()
    removeTestAttempt('stream-1')
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Hide this reasoning block' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Hide tool call' })).toBeEnabled()

    view.rerender(
      <BranchTreeInspector
        message={{
          ...row,
          nodeVersion: row.nodeVersion + 1,
          content: [{ type: 'output_text', text: 'Live inspector output.' }],
          reasoningEnvelope: reasoningEnvelopeFromDetailsForTest(
            [{ type: 'reasoning.text', text: 'Live reasoning.', format: 'unknown' }],
            'unknown',
          ),
        }}
        onClose={() => undefined}
        onEdit={succeededInteractionSettlement}
        onDelete={succeededInteractionSettlement}
        onRegenerate={() => startedGeneration()}
        onContinue={() => startedGeneration()}
        onForkChat={succeededInteractionSettlement}
        onToggleContextVisibility={succeededInteractionSettlement}
        onToggleReasoningDetailHidden={succeededInteractionSettlement}
        onToggleProviderOutputItemHidden={succeededInteractionSettlement}
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
      observeTestAttempt({
        streamId: 'status-stream',
        chatId: row.chatId,
        messageId: row.id,
        kind: 'continuation',
      })
    })
    const view = render(
      <BranchTreeInspector message={row} onClose={() => undefined} streamOnActivePath />,
    )

    expect(screen.getByRole('status')).toHaveTextContent('Waiting for response…')

    act(() => {
      publishTestLiveProjection({
        streamId: 'status-stream',
        chatId: row.chatId,
        messageId: row.id,
        content: [{ type: 'output_text', text: 'Live status content.' }],
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
      observeTestAttempt({
        streamId: 'status-stream',
        chatId: row.chatId,
        messageId: row.id,
        kind: 'continuation',
        local: false,
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

  it('keeps the last live body until the exact canonical terminal body publishes', async () => {
    const completedGeneration = message().generation
    if (!completedGeneration) throw new Error('Expected generated message metadata')
    const { finishedAt: _finishedAt, ...pendingGeneration } = completedGeneration
    const row = message({ generation: { ...pendingGeneration, status: 'streaming' } })
    act(() => {
      observeTestAttempt({
        streamId: 'commit-gap-stream',
        chatId: row.chatId,
        messageId: row.id,
        kind: 'generation',
      })
    })
    const view = render(
      <BranchTreeInspector message={row} onClose={() => undefined} streamOnActivePath />,
    )
    act(() => {
      publishTestLiveProjection({
        streamId: 'commit-gap-stream',
        chatId: row.chatId,
        messageId: row.id,
        content: [{ type: 'output_text', text: 'Last complete live snapshot.' }],
        updatedAt: 2,
      })
    })
    expect(screen.getByText('Last complete live snapshot.')).toBeInTheDocument()

    act(() => registerTestTargetHandoff('commit-gap-stream', 2))
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

    expect(screen.getByText('Last complete live snapshot.')).toBeInTheDocument()

    act(() => publishTestExactTarget('commit-gap-stream', 2))
    await waitFor(() => expect(screen.getByText('Committed snapshot content.')).toBeInTheDocument())
    expect(screen.queryByText('Last complete live snapshot.')).not.toBeInTheDocument()
    expect(screen.getByText('Committed snapshot content.')).toBeInTheDocument()
  })

  it('settles a committed snapshot before the live store clears under StrictMode', async () => {
    const completedGeneration = message().generation
    if (!completedGeneration) throw new Error('Expected generated message metadata')
    const { finishedAt: _finishedAt, ...pendingGeneration } = completedGeneration
    const pending = message({ generation: { ...pendingGeneration, status: 'streaming' } })
    act(() => {
      observeTestAttempt({
        streamId: 'commit-first-stream',
        chatId: pending.chatId,
        messageId: pending.id,
        kind: 'generation',
      })
    })
    const view = render(
      <StrictMode>
        <BranchTreeInspector
          message={pending}
          onClose={() => undefined}
          onEdit={succeededInteractionSettlement}
        />
      </StrictMode>,
    )
    act(() => {
      publishTestLiveProjection({
        streamId: 'commit-first-stream',
        chatId: pending.chatId,
        messageId: pending.id,
        content: [{ type: 'output_text', text: 'Commit-first live snapshot.' }],
        updatedAt: 2,
      })
    })
    expect(screen.getByText('Commit-first live snapshot.')).toBeInTheDocument()

    act(() => registerTestTargetHandoff('commit-first-stream', 2))
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
          onEdit={succeededInteractionSettlement}
        />
      </StrictMode>,
    )
    expect(screen.getByText('Commit-first live snapshot.')).toBeInTheDocument()

    act(() => publishTestExactTarget('commit-first-stream', 2))
    expect(screen.getByText('Commit-first persisted snapshot.')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText('Finishing response…')).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Edit message' })).toBeEnabled()
  })

  it('reads the current snapshot across views without retaining a second copy', async () => {
    const completedGeneration = message().generation
    if (!completedGeneration) throw new Error('Expected generated message metadata')
    const { finishedAt: _finishedAt, ...pendingGeneration } = completedGeneration
    const pending = message({ generation: { ...pendingGeneration, status: 'streaming' } })
    const requestLiveProjection = vi.fn(async () => {
      publishTestLiveProjection({
        streamId: 'cross-view-stream',
        chatId: pending.chatId,
        messageId: pending.id,
        content: [{ type: 'output_text', text: 'Visible before changing views.' }],
        updatedAt: 2,
      })
    })
    act(() => {
      observeTestAttempt({
        streamId: 'cross-view-stream',
        chatId: pending.chatId,
        messageId: pending.id,
        kind: 'generation',
        requestLiveProjection,
      })
    })
    const firstView = render(<BranchTreeInspector message={pending} onClose={() => undefined} />)
    await waitFor(() =>
      expect(screen.getByText('Visible before changing views.')).toBeInTheDocument(),
    )
    firstView.unmount()

    const nextView = render(<BranchTreeInspector message={pending} onClose={() => undefined} />)
    await waitFor(() =>
      expect(screen.getByText('Visible before changing views.')).toBeInTheDocument(),
    )
    expect(requestLiveProjection).toHaveBeenCalledTimes(2)
    expect(screen.queryByText('Inspector body.')).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Streaming response…')

    act(() => registerTestTargetHandoff('cross-view-stream', 2))
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
    expect(screen.getByText('Visible before changing views.')).toBeInTheDocument()

    act(() => publishTestExactTarget('cross-view-stream', 2))
    await waitFor(() =>
      expect(screen.getByText('Committed after changing views.')).toBeInTheDocument(),
    )
    expect(screen.queryByText('Visible before changing views.')).not.toBeInTheDocument()
    expect(screen.getByText('Committed after changing views.')).toBeInTheDocument()
  })

  it('treats persisted streaming generation state as history without an execution lease', () => {
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
        onEdit={succeededInteractionSettlement}
        onDelete={succeededInteractionSettlement}
        onContinue={() => startedGeneration()}
      />,
    )

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Edit message' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Delete message' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Continue from here' })).toBeEnabled()
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
    const onRegenerate = vi.fn(() => startedGeneration())
    const onContinue = vi.fn(() => startedGeneration())
    const row = message()
    act(() => {
      observeTestAttempt({
        streamId: 'other-message-stream',
        chatId: row.chatId,
        messageId: 'other-message',
      })
    })
    const assistant = render(
      <BranchTreeInspector
        message={row}
        onClose={() => undefined}
        onRegenerate={onRegenerate}
        onContinue={onContinue}
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
        onEdit={succeededInteractionSettlement}
        onEditAndSend={() => startedGeneration()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Edit message' }))
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Save & Send' })).toBeEnabled()
  })

  it('does not rebuild bounded prefixes or search ranges for cumulative streaming snapshots', () => {
    const operations: string[] = []
    observeBranchTreeInspectorComputations((operation) => operations.push(operation))
    const row = message()
    observeTestAttempt({
      streamId: 'stream-projection',
      chatId: row.chatId,
      messageId: row.id,
      kind: 'continuation',
    })
    const publish = (length: number, updatedAt: number) => {
      const text = `needle ${'x'.repeat(length - 7)}`
      publishTestLiveProjection({
        streamId: 'stream-projection',
        chatId: row.chatId,
        messageId: row.id,
        content: [{ type: 'output_text', text }],
        updatedAt,
      })
    }

    const { container } = render(
      <BranchTreeInspector message={row} searchQuery="needle" onClose={() => undefined} />,
    )
    act(() => publish(110_000, 2))
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
    const settlements = createInteractionSettlementHarness()
    const onEdit = vi.fn(() => settlements.fail(new Error('workspace write failed')))
    render(<BranchTreeInspector message={message()} onClose={() => undefined} onEdit={onEdit} />)

    fireEvent.click(screen.getByRole('button', { name: 'Edit message' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Edit assistant message' }), {
      target: { value: 'Rejected edit.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(settlements.presented).toHaveLength(1))
    expect(settlements.presented[0]?.message).toContain('workspace write failed')
    expect(screen.getByRole('textbox', { name: 'Edit assistant message' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(
      screen.queryByRole('textbox', { name: 'Edit assistant message' }),
    ).not.toBeInTheDocument()
    expect(screen.getByText('Inspector body.')).toBeInTheDocument()
    expect(onEdit).toHaveBeenCalledTimes(1)
  })

  it('restores the rendered message when an edit is cancelled', () => {
    const onEdit = vi.fn(() => succeededInteractionSettlement())
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
