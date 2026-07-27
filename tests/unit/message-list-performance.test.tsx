import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createActiveBranchSpine,
  type VersionedActiveBranchSpine,
} from '../../src/core/active-branch-spine'
import { type BranchPathDescriptor, createBranchPath } from '../../src/core/branch-session'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import { PREFILL_UNAVAILABLE_PLAN } from '../../src/core/effective-endpoint-routing'
import { AVAILABLE_GENERATION_CAPABILITY } from '../../src/core/interaction-capability'
import type { ChatSettings, Message, MessageId } from '../../src/core/types'
import type { GenerationCapabilityFrame } from '../../src/store/generation-admission-controller'
import { type MessageHeaderRow, splitMessageForStorage } from '../../src/store/message-storage'
import type { ConversationTranscriptSurface } from '../../src/store/presentation-contracts'
import {
  prependTranscriptBodyPage,
  type TranscriptBodyPage,
  type TranscriptBodyWindow,
  transcriptBodyWindowFromPage,
  withTranscriptBodyRevisions,
} from '../../src/store/transcript-window'
import { useToastStore } from '../../src/store/zustand/toastStore'
import { useUiStore } from '../../src/store/zustand/uiStore'
import { __setMessageRenderProbeForTests } from '../../src/ui/chat/Message'
import { MessageList } from '../../src/ui/chat/MessageList'
import { resetAttemptControllerForTests } from '../helpers/attempt-controller'

vi.mock('../../src/ui/chat/MarkdownView', () => ({
  PROGRESSIVE_STATIC_MARKDOWN_CHARS: 120_000,
  STREAMING_MARKDOWN_SEGMENT_CHARS: 20_000,
  MarkdownView: ({ content }: { content: string }) => <span>{content}</span>,
}))
vi.mock('../../src/ui/attachments/AttachmentRefChips', () => ({ AttachmentRefChips: () => null }))
vi.mock('../../src/ui/chat/ToolEvidenceBlock', () => ({ ToolEvidenceBlock: () => null }))

const CHAT_ID = 'chat-message-list'
const AVAILABLE_CAPABILITY_FRAME: GenerationCapabilityFrame = Object.freeze({
  capability: () => AVAILABLE_GENERATION_CAPABILITY,
})
const BASE_SETTINGS = cloneDefaultChatSettings()
const NOOP_LOAD = () => {}

let renderedIds: MessageId[] = []

beforeEach(() => {
  renderedIds = []
  resetAttemptControllerForTests()
  useToastStore.getState().reset()
  useUiStore.getState().reset()
  __setMessageRenderProbeForTests((messageId) => renderedIds.push(messageId))
})

afterEach(() => {
  __setMessageRenderProbeForTests(undefined)
})

describe('message-list current presentation contract', () => {
  it('exposes the hydrated transcript window through an additions-only log', () => {
    const fixture = branchFixture(5)
    const view = renderList(fixture, fixture.window(2, 3))

    const log = view.getByRole('log')
    expect(log).toHaveAttribute('data-ui', 'message-list')
    expect(log).toHaveAttribute('aria-live', 'polite')
    expect(log).toHaveAttribute('aria-relevant', 'additions')
    expect(log).toHaveAttribute('data-rendered-count', '3')
    expect(log).toHaveAttribute('data-total-count', '5')
  })

  it('keeps work bounded to the supplied body window while the complete path stays header-only', () => {
    const fixture = branchFixture(2_000, { bodyPrefix: 'cold-body' })
    const window = fixture.window(1_994, 6)
    const view = renderList(fixture, window)

    expect(view.container.querySelectorAll('[data-ui="message"]')).toHaveLength(6)
    expect(renderedIds).toEqual([
      'message-1994',
      'message-1995',
      'message-1996',
      'message-1997',
      'message-1998',
      'message-1999',
    ])
    expect(view.getByRole('log')).toHaveAttribute('data-rendered-count', '6')
    expect(view.getByRole('log')).toHaveAttribute('data-total-count', '2000')
    expect(view.getByText('1994 older')).toBeVisible()
    expect(view.queryByText('cold-body 0')).toBeNull()
    expect(view.getByText('cold-body 1999')).toBeVisible()
  })

  it('reuses retained rows when a persistent window prepends a page', () => {
    const fixture = branchFixture(8)
    const initial = fixture.window(6, 2)
    const view = renderList(fixture, initial)
    const retained = view.container.querySelector<HTMLElement>('[data-message-id="message-6"]')
    if (!retained) throw new Error('missing retained transcript row')

    renderedIds = []
    const prepended = prependTranscriptBodyPage(initial, fixture.page(4, 2))
    view.rerender(listElement(fixture, prepended))

    expect(view.container.querySelector('[data-message-id="message-6"]')).toBe(retained)
    expect(renderedIds).toEqual(['message-4', 'message-5'])
  })

  it('materializes the complete context path once across passive window publications', () => {
    const fixture = branchFixture(2_000, { cachedTokenEstimate: 10 })
    const materializeNodes = vi.spyOn(fixture.spine.path, 'materializeNodes')
    const initial = fixture.window(1_998, 2)
    const view = renderList(fixture, initial)

    expect(materializeNodes).toHaveBeenCalledTimes(1)

    const prepended = prependTranscriptBodyPage(initial, fixture.page(1_996, 2))
    view.rerender(listElement(fixture, prepended))

    expect(materializeNodes).toHaveBeenCalledTimes(1)
  })

  it('rerenders only the body whose exact revision changed', () => {
    const fixture = branchFixture(8)
    const initial = fixture.window(0, 8)
    const view = renderList(fixture, initial)

    const current = fixture.messages[5]
    if (!current) throw new Error('missing revision target')
    const changed: Message = {
      ...current,
      content: [{ type: 'output_text', text: 'revised assistant body' }],
      nodeVersion: current.nodeVersion + 1,
      editedAt: 100,
    }
    const header = splitMessageForStorage(changed).header
    const revised = withTranscriptBodyRevisions(initial, [
      {
        header,
        presentation: { header, message: changed, bodyVersion: header.bodyVersion },
      },
    ])

    renderedIds = []
    view.rerender(listElement(fixture, revised))

    expect(renderedIds).toEqual(['message-5'])
    expect(view.getByText('revised assistant body')).toBeVisible()
  })

  it('computes context rings from the complete cold header path', () => {
    const fixture = branchFixture(3, { cachedTokenEstimate: 10 })
    const window = fixture.window(1, 2)
    const settings = {
      ...cloneDefaultChatSettings(),
      customMaxContext: 10,
      maxCompletionTokens: 0,
    }
    const view = renderList(fixture, window, { chatSettings: settings })

    expect(view.container.querySelector('[data-message-id="message-0"]')).toBeNull()
    expect(
      view.container.querySelector('[data-message-id="message-1"] [data-ui="profile-glyph"]'),
    ).toHaveAttribute('data-excluded', 'true')
    expect(
      view.container.querySelector('[data-message-id="message-2"] [data-ui="profile-glyph"]'),
    ).not.toHaveAttribute('data-excluded')
  })

  it('does not invent context exclusions when a cold header lacks a usable estimate', () => {
    const fixture = branchFixture(3)
    const window = fixture.window(1, 2)
    const settings = {
      ...cloneDefaultChatSettings(),
      customMaxContext: 1,
      maxCompletionTokens: 0,
    }
    const view = renderList(fixture, window, { chatSettings: settings })

    expect(
      view.container.querySelectorAll('[data-ui="profile-glyph"][data-excluded="true"]'),
    ).toHaveLength(0)
  })
})

interface BranchFixture {
  readonly messages: readonly Message[]
  readonly headers: readonly MessageHeaderRow[]
  readonly path: BranchPathDescriptor<MessageHeaderRow>
  readonly spine: VersionedActiveBranchSpine<MessageHeaderRow>
  readonly seal: ConversationTranscriptSurface['seal']
  page(offset: number, limit: number): TranscriptBodyPage
  window(offset: number, limit: number): TranscriptBodyWindow
}

function branchFixture(
  count: number,
  options: { bodyPrefix?: string; cachedTokenEstimate?: number } = {},
): BranchFixture {
  const messages: Message[] = []
  for (let index = 0; index < count; index += 1) {
    messages.push(
      makeMessage(
        index,
        messages.at(-1)?.id ?? null,
        options.bodyPrefix,
        options.cachedTokenEstimate,
      ),
    )
  }
  const headers = messages.map((message) => splitMessageForStorage(message).header)
  const path = createBranchPath(headers)
  const spine = createActiveBranchSpine({
    chatId: CHAT_ID,
    structuralVersion: 0,
    resolvedLeafId: headers.at(-1)?.id ?? null,
    headers,
  })
  const seal: ConversationTranscriptSurface['seal'] = Object.freeze({
    workspaceId: 'message-list-performance-workspace',
    replacementEpoch: 0,
    chatId: CHAT_ID,
    selectionRevision: 0,
    structuralVersion: spine.structuralVersion,
    leafId: spine.resolvedLeafId,
  })
  const page = (offset: number, limit: number): TranscriptBodyPage => ({
    chatId: CHAT_ID,
    leafId: headers.at(-1)?.id ?? null,
    branchLength: headers.length,
    offset,
    headers: headers.slice(offset, offset + limit),
    messages: messages.slice(offset, offset + limit),
  })
  return {
    messages,
    headers,
    path,
    spine,
    seal,
    page,
    window: (offset, limit) => transcriptBodyWindowFromPage(page(offset, limit), path),
  }
}

function renderList(
  fixture: BranchFixture,
  branchSnapshot: TranscriptBodyWindow,
  overrides: { readonly chatSettings?: ChatSettings } = {},
) {
  return render(listElement(fixture, branchSnapshot, overrides))
}

function listElement(
  fixture: BranchFixture,
  branchSnapshot: TranscriptBodyWindow,
  overrides: { readonly chatSettings?: ChatSettings } = {},
) {
  return (
    <MessageList
      binding={transcriptBinding(fixture, branchSnapshot)}
      chatSettings={overrides.chatSettings ?? BASE_SETTINGS}
      prefillPlan={PREFILL_UNAVAILABLE_PLAN}
      generationCapabilityFrame={AVAILABLE_CAPABILITY_FRAME}
      messageInitialRenderWork={10}
      messageRenderWindowLoadMode="manual"
      onLoadOlderMessages={NOOP_LOAD}
    />
  )
}

function transcriptBinding(
  fixture: BranchFixture,
  window: TranscriptBodyWindow,
): ConversationTranscriptSurface {
  return Object.freeze({
    surface: 'transcript',
    currency: 'current',
    seal: fixture.seal,
    spine: fixture.spine,
    window,
    selectionEpoch: 0,
    viewportRevision: 0,
    intentPresentations: Object.freeze([]),
    reveal: null,
  })
}

function makeMessage(
  index: number,
  parentId: MessageId | null,
  bodyPrefix = 'message',
  cachedTokenEstimate?: number,
): Message {
  const role = index % 2 === 0 ? 'user' : 'assistant'
  return {
    id: `message-${index}`,
    chatId: CHAT_ID,
    parentId,
    siblingIndex: 0,
    turnId: `turn-${index}`,
    turnIndex: index,
    createdAt: index,
    role,
    origin: role === 'assistant' ? 'generated' : 'user',
    content: [
      { type: role === 'assistant' ? 'output_text' : 'text', text: `${bodyPrefix} ${index}` },
    ],
    nodeVersion: 0,
    deleted: false,
    ...(cachedTokenEstimate === undefined ? {} : { cachedTokenEstimate }),
  }
}
