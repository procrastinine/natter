import { act, fireEvent, render } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ConversationMutationRunner,
  GenerationSubmission,
} from '../../src/app/presentation-interactions'
import {
  createActiveBranchSpine,
  emptyActiveBranchChildSlot,
  type VersionedActiveBranchSpine,
} from '../../src/core/active-branch-spine'
import { type BranchPathDescriptor, createBranchPath } from '../../src/core/branch-session'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import { PREFILL_UNAVAILABLE_PLAN } from '../../src/core/effective-endpoint-routing'
import type { Message, MessageId } from '../../src/core/types'
import { type MessageHeaderRow, splitMessageForStorage } from '../../src/store/message-storage'
import type { ConversationTranscriptSurface } from '../../src/store/presentation-contracts'
import {
  prependTranscriptBodyPage,
  type TranscriptBodyPage,
  type TranscriptBodyWindow,
  transcriptBodyWindowFromPage,
} from '../../src/store/transcript-window'
import { useToastStore } from '../../src/store/zustand/toastStore'
import { useUiStore } from '../../src/store/zustand/uiStore'
import { MessageList } from '../../src/ui/chat/MessageList'
import { ScrollRegion, type ScrollRegionHandle } from '../../src/ui/chat/ScrollRegion'
import { resetAttemptControllerForTests } from '../helpers/attempt-controller'
import { createInteractionSettlementHarness } from '../helpers/presentation-interactions'

vi.mock('../../src/ui/chat/MarkdownView', () => ({
  PROGRESSIVE_STATIC_MARKDOWN_CHARS: 120_000,
  STREAMING_MARKDOWN_SEGMENT_CHARS: 20_000,
  MarkdownView: ({ content }: { content: string }) => <span>{content}</span>,
}))
vi.mock('../../src/ui/attachments/AttachmentRefChips', () => ({ AttachmentRefChips: () => null }))
vi.mock('../../src/ui/chat/ToolEvidenceBlock', () => ({ ToolEvidenceBlock: () => null }))

const CHAT_ID = 'chat-prepend-anchor'
const STARTED_GENERATION = (): GenerationSubmission =>
  Object.freeze({
    kind: 'started',
    admission: Promise.resolve(Object.freeze({ kind: 'admitted' })),
    completion: Promise.resolve(Object.freeze({ kind: 'prepared' })),
    cancel: () => undefined,
  })
const mutationSettlements = createInteractionSettlementHarness()
const RUN_MUTATION: ConversationMutationRunner = (_intent, action, commit) =>
  mutationSettlements.run(async () => {
    await action(new AbortController().signal, () => undefined)
    commit?.()
  })

beforeEach(() => {
  resetAttemptControllerForTests()
  useToastStore.getState().reset()
  useUiStore.getState().reset()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('message-list viewport transition contract', () => {
  it('preserves a retained row across a controller-preannounced prepend', async () => {
    const fixture = branchFixture(8)
    const initial = fixture.window(6, 2)
    const prepended = prependTranscriptBodyPage(initial, fixture.page(2, 4))
    const ref = createRef<ScrollRegionHandle>()
    let viewportRevision = 0
    let snapshot = initial
    const element = () => viewportElement(fixture, snapshot, viewportRevision, ref)
    const view = render(element())
    const region = requireRegion(view.container)
    let scrollHeight = 1_000
    installRegionGeometry(region, () => scrollHeight)
    const retained = requireMessage(view.container, 'message-6')
    let retainedDocumentTop = 20
    retained.getBoundingClientRect = () =>
      rect({
        top: retainedDocumentTop - region.scrollTop,
        bottom: retainedDocumentTop + 20 - region.scrollTop,
      })

    act(() => {
      view.rerender(element())
      view.rerender(element())
    })
    expect(region.scrollTop).toBe(900)
    act(() => {
      fireEvent.wheel(region)
      region.scrollTop = 0
      fireEvent.scroll(region)
    })
    expect(ref.current?.getState()).toBe('pinned')
    await act(nextTask)

    act(() => {
      ref.current?.prepareLayoutChange({
        workspaceEpoch: 0,
        chatId: CHAT_ID,
        revision: 1,
        fromSelectionKey: 'message-7',
        toSelectionKey: 'message-7',
        kind: 'prepend',
      })
      retainedDocumentTop += 300
      scrollHeight += 300
      snapshot = prepended
      viewportRevision = 1
      view.rerender(element())
    })

    expect(view.container.querySelector('[data-message-id="message-6"]')).toBe(retained)
    expect(region.scrollTop).toBe(300)
    expect(retained.getBoundingClientRect().top).toBe(20)
    expect(ref.current?.getState()).toBe('pinned')
  })

  it('keeps the unresolved open-to-leaf claim semantic through background initial fill', () => {
    const fixture = branchFixture(8)
    const terminal = fixture.window(7, 1)
    const filled = fixture.window(0, 8)
    const ref = createRef<ScrollRegionHandle>()
    let viewportRevision = 0
    let snapshot = terminal
    const element = () => viewportElement(fixture, snapshot, viewportRevision, ref)
    const view = render(element())
    const region = requireRegion(view.container)
    let scrollHeight = 80
    installRegionGeometry(region, () => scrollHeight)

    act(() => view.rerender(element()))
    expect(region.scrollTop).toBe(0)
    expect(ref.current?.getState()).toBe('follow')

    act(() => {
      ref.current?.prepareLayoutChange({
        workspaceEpoch: 0,
        chatId: CHAT_ID,
        revision: 1,
        fromSelectionKey: 'message-7',
        toSelectionKey: 'message-7',
        kind: 'prepend',
      })
      scrollHeight = 800
      snapshot = filled
      viewportRevision = 1
      view.rerender(element())
      view.rerender(element())
    })

    expect(region.scrollTop).toBe(700)
    expect(ref.current?.getState()).toBe('follow')
    expect(region).toHaveAttribute('data-scroll-state', 'follow')
  })

  it('rebases an in-flight prepend onto user scrolling before the publication commits', async () => {
    const fixture = branchFixture(8)
    const initial = fixture.window(6, 2)
    const prepended = prependTranscriptBodyPage(initial, fixture.page(2, 4))
    const ref = createRef<ScrollRegionHandle>()
    let viewportRevision = 0
    let snapshot = initial
    const element = () => viewportElement(fixture, snapshot, viewportRevision, ref)
    const view = render(element())
    const region = requireRegion(view.container)
    let scrollHeight = 1_000
    installRegionGeometry(region, () => scrollHeight)
    const retained = requireMessage(view.container, 'message-6')
    let retainedDocumentTop = 240
    retained.getBoundingClientRect = () =>
      rect({
        top: retainedDocumentTop - region.scrollTop,
        bottom: retainedDocumentTop + 20 - region.scrollTop,
      })

    act(() => {
      view.rerender(element())
      view.rerender(element())
    })
    act(() => {
      fireEvent.wheel(region)
      region.scrollTop = 200
      fireEvent.scroll(region)
    })
    await act(nextTask)
    expect(retained.getBoundingClientRect().top).toBe(40)

    act(() => {
      ref.current?.prepareLayoutChange({
        workspaceEpoch: 0,
        chatId: CHAT_ID,
        revision: 1,
        fromSelectionKey: 'message-7',
        toSelectionKey: 'message-7',
        kind: 'prepend',
      })
      fireEvent.wheel(region)
      region.scrollTop = 240
      fireEvent.scroll(region)
    })
    expect(retained.getBoundingClientRect().top).toBe(0)

    act(() => {
      retainedDocumentTop += 300
      scrollHeight += 300
      snapshot = prepended
      viewportRevision = 1
      view.rerender(element())
    })

    expect(view.container.querySelector('[data-message-id="message-6"]')).toBe(retained)
    expect(region.scrollTop).toBe(540)
    expect(retained.getBoundingClientRect().top).toBe(0)
    expect(ref.current?.getState()).toBe('pinned')
  })

  it('ignores a preannouncement whose selection authority does not match the tab', async () => {
    const fixture = branchFixture(8)
    const initial = fixture.window(6, 2)
    const prepended = prependTranscriptBodyPage(initial, fixture.page(2, 4))
    const ref = createRef<ScrollRegionHandle>()
    let viewportRevision = 0
    let snapshot = initial
    const element = () => viewportElement(fixture, snapshot, viewportRevision, ref)
    const view = render(element())
    const region = requireRegion(view.container)
    let scrollHeight = 1_000
    installRegionGeometry(region, () => scrollHeight)

    act(() => {
      view.rerender(element())
      view.rerender(element())
    })
    expect(region.scrollTop).toBe(900)
    act(() => {
      fireEvent.wheel(region)
      region.scrollTop = 200
      fireEvent.scroll(region)
    })
    await act(nextTask)

    act(() => {
      ref.current?.prepareLayoutChange({
        workspaceEpoch: 0,
        chatId: CHAT_ID,
        revision: 1,
        fromSelectionKey: 'other-tab-selection',
        toSelectionKey: 'other-tab-selection',
        kind: 'prepend',
      })
      scrollHeight = 1_300
      snapshot = prepended
      viewportRevision = 1
      view.rerender(element())
    })

    expect(region.scrollTop).toBe(200)
    expect(ref.current?.getState()).toBe('pinned')
  })
})

interface BranchFixture {
  readonly path: BranchPathDescriptor<MessageHeaderRow>
  readonly spine: VersionedActiveBranchSpine<MessageHeaderRow>
  readonly seal: ConversationTranscriptSurface['seal']
  page(offset: number, limit: number): TranscriptBodyPage
  window(offset: number, limit: number): TranscriptBodyWindow
}

function branchFixture(count: number): BranchFixture {
  const messages: Message[] = []
  for (let index = 0; index < count; index += 1) {
    messages.push(makeMessage(index, messages.at(-1)?.id ?? null))
  }
  const headers = messages.map((message) => splitMessageForStorage(message).header)
  const path = createBranchPath(headers)
  const spine = createActiveBranchSpine({
    chatId: CHAT_ID,
    structuralVersion: 0,
    resolvedLeafId: headers.at(-1)?.id ?? null,
    headers,
    terminalChildSlot: emptyActiveBranchChildSlot(headers.at(-1)?.id ?? null),
  })
  const seal: ConversationTranscriptSurface['seal'] = Object.freeze({
    workspaceId: 'message-list-anchor-workspace',
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
    path,
    spine,
    seal,
    page,
    window: (offset, limit) => transcriptBodyWindowFromPage(page(offset, limit), path),
  }
}

function viewportElement(
  fixture: BranchFixture,
  snapshot: TranscriptBodyWindow,
  viewportRevision: number,
  ref: React.RefObject<ScrollRegionHandle | null>,
) {
  return (
    <ScrollRegion
      ref={ref}
      workspaceEpoch={0}
      resetKey={CHAT_ID}
      selectionKey="message-7"
      viewportRevision={viewportRevision}
    >
      <MessageList
        binding={transcriptBinding(fixture, snapshot, viewportRevision)}
        chatSettings={cloneDefaultChatSettings()}
        prefillPlan={PREFILL_UNAVAILABLE_PLAN}
        messageInitialRenderWork={10}
        messageRenderWindowLoadMode="manual"
        onLoadOlderMessages={() => {}}
        runConversationMutation={RUN_MUTATION}
        onEditAndSendMessage={STARTED_GENERATION}
        onRegenerateMessage={STARTED_GENERATION}
        onContinueMessage={STARTED_GENERATION}
      />
    </ScrollRegion>
  )
}

function transcriptBinding(
  fixture: BranchFixture,
  window: TranscriptBodyWindow,
  viewportRevision: number,
): ConversationTranscriptSurface {
  return Object.freeze({
    surface: 'transcript',
    currency: 'current',
    seal: fixture.seal,
    spine: fixture.spine,
    window,
    selectionEpoch: 0,
    viewportRevision,
    reveal: null,
  })
}

function makeMessage(index: number, parentId: MessageId | null): Message {
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
    content: [{ type: role === 'assistant' ? 'output_text' : 'text', text: `message ${index}` }],
    nodeVersion: 0,
    deleted: false,
  }
}

function installRegionGeometry(region: HTMLElement, scrollHeight: () => number): void {
  Object.defineProperty(region, 'clientHeight', { configurable: true, value: 100 })
  Object.defineProperty(region, 'scrollHeight', { configurable: true, get: scrollHeight })
  Object.defineProperty(region, 'scrollTop', { configurable: true, writable: true, value: 0 })
  region.getBoundingClientRect = () => rect({ top: 0, bottom: 100 })
}

function requireRegion(container: HTMLElement): HTMLElement {
  const region = container.querySelector<HTMLElement>('[data-ui="scroll-region"]')
  if (!region) throw new Error('missing scroll region')
  return region
}

function requireMessage(container: HTMLElement, messageId: string): HTMLElement {
  const message = container.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`)
  if (!message) throw new Error(`missing transcript row ${messageId}`)
  return message
}

function rect({ top, bottom }: { top: number; bottom: number }): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    right: 0,
    bottom,
    left: 0,
    width: 0,
    height: bottom - top,
    toJSON: () => ({}),
  }
}

function nextTask(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel()
    channel.port1.onmessage = () => {
      channel.port1.close()
      channel.port2.close()
      resolve()
    }
    channel.port2.postMessage(undefined)
  })
}
