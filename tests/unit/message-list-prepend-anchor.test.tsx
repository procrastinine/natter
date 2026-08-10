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
    generationSettled: Promise.resolve(),
    cancel: () => undefined,
  })
const mutationSettlements = createInteractionSettlementHarness()
let deliverResize: () => void
let resizeCallbacks = new Set<ResizeObserverCallback>()
const RUN_MUTATION: ConversationMutationRunner = (_intent, action, commit) =>
  mutationSettlements.run(async () => {
    await action(new AbortController().signal, () => undefined)
    commit?.()
  })

beforeEach(() => {
  resetAttemptControllerForTests()
  useToastStore.getState().reset()
  useUiStore.getState().reset()
  resizeCallbacks = new Set()
  deliverResize = () => {
    for (const callback of resizeCallbacks) callback([], {} as ResizeObserver)
  }
  vi.stubGlobal(
    'ResizeObserver',
    class {
      readonly callback: ResizeObserverCallback

      constructor(callback: ResizeObserverCallback) {
        this.callback = callback
        resizeCallbacks.add(callback)
      }

      observe() {}
      unobserve() {}
      disconnect() {
        resizeCallbacks.delete(this.callback)
      }
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

  it('retains the visible row while an upward boundary gesture waits for more content', async () => {
    const fixture = branchFixture(8)
    const initial = fixture.window(6, 2)
    const ref = createRef<ScrollRegionHandle>()
    const view = render(viewportElement(fixture, initial, 0, ref))
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

    act(() => view.rerender(viewportElement(fixture, initial, 0, ref)))
    act(() => {
      fireEvent.wheel(region)
      region.scrollTop = 0
      fireEvent.scroll(region)
    })
    await act(nextTask)
    expect(ref.current?.getState()).toBe('pinned')
    expect(retained.getBoundingClientRect().top).toBe(20)

    act(() => {
      fireEvent.wheel(region, { deltaY: -100 })
      retainedDocumentTop += 300
      scrollHeight += 300
      deliverResize()
    })

    expect(region.scrollTop).toBe(300)
    expect(retained.getBoundingClientRect().top).toBe(20)
  })

  it('admits history demand when no semantic anchor can be captured', async () => {
    const fixture = branchFixture(8)
    const initial = fixture.window(6, 2)
    const ref = createRef<ScrollRegionHandle>()
    const loadOlder = vi.fn()
    const view = render(viewportElement(fixture, initial, 0, ref, loadOlder))
    const region = requireRegion(view.container)
    installRegionGeometry(region, () => 1_000)

    act(() => view.rerender(viewportElement(fixture, initial, 0, ref, loadOlder)))
    act(() => {
      fireEvent.wheel(region)
      region.scrollTop = 0
      fireEvent.scroll(region)
    })
    await act(nextTask)
    expect(ref.current?.getState()).toBe('pinned')
    for (const message of view.container.querySelectorAll<HTMLElement>('[data-ui="message"]')) {
      message.getBoundingClientRect = () => rect({ top: -100, bottom: -80 })
    }

    fireEvent.click(view.getByRole('button', { name: 'Load more' }))

    expect(loadOlder).toHaveBeenCalledTimes(1)
  })

  it('captures the wheel-owned text anchor before pinned state publishes', () => {
    const fixture = branchFixture(8)
    const initial = fixture.window(6, 2)
    const ref = createRef<ScrollRegionHandle>()
    const loadOlder = vi.fn()
    const view = render(viewportElement(fixture, initial, 0, ref, loadOlder))
    const region = requireRegion(view.container)
    installRegionGeometry(region, () => 1_000)
    const retained = requireMessage(view.container, 'message-6')
    retained.getBoundingClientRect = () =>
      rect({
        top: 920 - region.scrollTop,
        bottom: 940 - region.scrollTop,
      })

    act(() => view.rerender(viewportElement(fixture, initial, 0, ref, loadOlder)))
    expect(region.scrollTop).toBe(900)

    act(() => {
      fireEvent.wheel(region, { deltaY: -320 })
      fireEvent.click(view.getByRole('button', { name: 'Load more' }))
    })

    expect(loadOlder).toHaveBeenCalledTimes(1)
    expect(view.container.querySelector('[data-ui="message-list"]')).toHaveAttribute(
      'data-history-demand-anchor-id',
      'message-6',
    )
  })

  it('preserves a physical prepend when controller preannouncement authority does not match', async () => {
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
    expect(region.scrollTop).toBe(900)
    act(() => {
      fireEvent.wheel(region)
      region.scrollTop = 200
      fireEvent.scroll(region)
    })
    await act(nextTask)
    expect(retained.getBoundingClientRect().top).toBe(40)

    let preparation: ReturnType<ScrollRegionHandle['prepareLayoutChange']> | undefined
    act(() => {
      preparation = ref.current?.prepareLayoutChange({
        workspaceEpoch: 0,
        chatId: CHAT_ID,
        revision: 1,
        fromSelectionKey: 'other-tab-selection',
        toSelectionKey: 'other-tab-selection',
        kind: 'prepend',
      })
      retainedDocumentTop += 300
      scrollHeight += 300
      snapshot = prepended
      viewportRevision = 1
      view.rerender(element())
      deliverResize()
    })

    expect(preparation).toEqual({ kind: 'unavailable' })
    expect(view.container.querySelector('[data-message-id="message-6"]')).toBe(retained)
    expect(region.scrollTop).toBe(500)
    expect(retained.getBoundingClientRect().top).toBe(40)
    expect(ref.current?.getState()).toBe('pinned')
  })

  it('reconciles a user text anchor in the layout commit of an unannounced passive fill', async () => {
    const fixture = branchFixture(8)
    const initial = fixture.window(7, 1)
    const filled = fixture.window(0, 8)
    const ref = createRef<ScrollRegionHandle>()
    let viewportRevision = 0
    let snapshot = initial
    const element = () => viewportElement(fixture, snapshot, viewportRevision, ref)
    const view = render(element())
    const region = requireRegion(view.container)
    let scrollHeight = 1_000
    installRegionGeometry(region, () => scrollHeight)
    const retained = requireMessage(view.container, 'message-7')
    let retainedDocumentTop = 920
    retained.getBoundingClientRect = () =>
      rect({
        top: retainedDocumentTop - region.scrollTop,
        bottom: retainedDocumentTop + 20 - region.scrollTop,
      })

    act(() => view.rerender(element()))
    expect(region.scrollTop).toBe(900)
    act(() => {
      fireEvent.wheel(region, { deltaY: -20 })
      region.scrollTop = 880
      fireEvent.scroll(region)
    })
    expect(ref.current?.getState()).toBe('pinned')
    expect(retained.getBoundingClientRect().top).toBe(40)

    act(() => {
      retainedDocumentTop += 300
      scrollHeight += 300
      snapshot = filled
      viewportRevision = 1
      view.rerender(element())
    })

    expect(region.scrollTop).toBe(1_180)
    expect(retained.getBoundingClientRect().top).toBe(40)
  })

  it('measures newly materialized history before paint while user scrolling is active', async () => {
    const measuredMessageIds = new Set<string>()
    const rowHeight = vi
      .spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
      .mockImplementation(function (this: HTMLElement) {
        if (this.dataset.ui !== 'message-virtual-row') return 0
        const messageId = this.querySelector<HTMLElement>('[data-message-id]')?.dataset.messageId
        if (messageId) measuredMessageIds.add(messageId)
        return 1_000
      })
    try {
      const fixture = branchFixture(20)
      const initial = fixture.window(10, 10)
      const prepended = prependTranscriptBodyPage(initial, fixture.page(0, 10))
      const ref = createRef<ScrollRegionHandle>()
      let viewportRevision = 0
      let snapshot = initial
      const loadOlder = vi.fn()
      const element = () => viewportElement(fixture, snapshot, viewportRevision, ref, loadOlder)
      const view = render(element())
      const region = requireRegion(view.container)
      let scrollHeight = 10_000
      installRegionGeometry(region, () => scrollHeight)
      const retained = requireMessage(view.container, 'message-10')
      retained.getBoundingClientRect = () => rect({ top: 20, bottom: 40 })

      act(() => view.rerender(element()))
      act(() => {
        fireEvent.wheel(region, { deltaY: -180 })
        region.scrollTop = 0
        fireEvent.scroll(region)
      })
      await act(nextTask)
      expect(ref.current?.getState()).toBe('pinned')

      act(() => {
        fireEvent.wheel(region, { deltaY: -180 })
        fireEvent.click(view.getByRole('button', { name: 'Load more' }))
      })
      expect(loadOlder).toHaveBeenCalledTimes(1)
      expect(view.container.querySelector('[data-ui="message-list"]')).toHaveAttribute(
        'data-history-demand-anchor-id',
        'message-10',
      )

      act(() => {
        scrollHeight = 20_000
        snapshot = prepended
        viewportRevision = 1
        fireEvent.scroll(region)
        view.rerender(element())
      })

      expect(
        [...measuredMessageIds].filter((messageId) => /^message-[0-9]$/u.test(messageId)),
      ).toEqual(Array.from({ length: 10 }, (_, index) => `message-${index}`))
    } finally {
      rowHeight.mockRestore()
    }
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
  onLoadOlderMessages: () => void = () => {},
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
        onLoadOlderMessages={onLoadOlderMessages}
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
