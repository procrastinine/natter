import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import type {
  ActiveBranchForkSlot,
  ActiveBranchForkTarget,
  ActiveBranchSelection,
} from '../../src/core/active-branch-spine'
import { emptyActiveBranchChildSlot } from '../../src/core/active-branch-spine'
import type { BranchPathWindow } from '../../src/core/branch-session'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import {
  type ConversationDestinationPoint,
  type ConversationProvedSelection,
  type ConversationSelectionProofTarget,
  sealConversationSelection,
} from '../../src/core/messages'
import {
  initialTranscriptWorkBudget,
  type TranscriptWorkBudget,
} from '../../src/core/transcript-work-budget'
import type { Chat, ChatId, Message, MessageId } from '../../src/core/types'
import {
  useConversationFrame,
  useConversationTranscriptDemand,
} from '../../src/hooks/useConversationFrame'
import {
  type ConversationController,
  type ConversationMessagePresentation,
  type ConversationNavigationPort,
  type ConversationProjectionOpenResult,
  type ConversationProjectionSource,
  type ConversationReadEnvelope,
  type ConversationRouteArrival,
  type ConversationTranscriptFrame,
  type ConversationTranscriptPage,
  type ConversationTranscriptPageResult,
  createConversationController,
  type MessageTextPreview,
  type TreePreviewTarget,
} from '../../src/store/conversation-controller'
import { type MessageHeaderRow, splitMessageForStorage } from '../../src/store/message-storage'
import { transcriptBodyWindowRows } from '../../src/store/transcript-window'
import { testChildSlotsForHeaders } from '../helpers/message-storage'

const CHAT_ID = 'chat-background-fill'
const FENCE = Object.freeze({ workspaceId: 'workspace-background-fill', replacementEpoch: 0 })
const BASE_BUDGET = initialTranscriptWorkBudget(10, 360)
const READY_PRESENTATION_RESOURCES = Object.freeze({
  get: () => Object.freeze({ kind: 'ready' as const }),
  request: () => undefined,
  subscribe: () => () => undefined,
})

describe('conversation destination-first background fill', () => {
  beforeEach(() => {
    sessionStorage.clear()
  })

  for (const scenario of [
    { name: 'short messages', bodyLength: 8 },
    { name: 'huge messages', bodyLength: 200_000 },
  ] as const) {
    it(`paints one destination row, then fills at least ten rows without scrolling for ${scenario.name}`, async () => {
      const rows = linearMessages(20, scenario.bodyLength)
      const source = new DestinationFirstProjectionSource(rows)
      const navigation = new TestNavigationPort()
      const controller = createConversationController()
      controller.reconcileWorkspace(FENCE)
      controller.setProjectionSource(source)
      controller.setNavigationPort(navigation)
      controller.installPresentationResourcePort(READY_PRESENTATION_RESOURCES)

      const view = render(<Harness controller={controller} />)
      act(() => navigation.arrive('arrival-1', rows.at(-1)?.id as MessageId))

      await waitFor(() => expect(source.selectionCalls).toHaveLength(1))
      expect(source.pageCalls).toEqual([])
      expect(screen.getByTestId('exact-row-count')).toHaveTextContent('1')
      expect(screen.getByTestId('interaction-state')).toHaveTextContent('inert')
      const destinationNode = screen.getByTestId('destination-row')
      expect(destinationNode).toHaveTextContent(rows.at(-1)?.id as string)
      expect(navigation.getArrival().route?.targetMessageId).toBe(rows.at(-1)?.id)
      expect(navigation.replacements).toEqual([])

      await act(async () => {
        source.releaseSelection()
        await settle()
      })

      await waitFor(() => expect(projectedMessages(controller)).toHaveLength(1))
      await waitFor(() => expect(source.pageCalls).toHaveLength(1))
      expect(transcriptIsFilling(controller)).toBe(true)
      const initialSeal = controller.getSnapshot().active?.presentation.residents.transcript?.seal
      expect(initialSeal).toBeDefined()
      expect(screen.getByTestId('exact-row-count')).toHaveTextContent('1')
      expect(screen.getByTestId('interaction-state')).toHaveTextContent('interactive')
      expect(screen.getByTestId('destination-row')).toBe(destinationNode)
      const backgroundWindow = source.pageCalls[0]?.window
      if (!backgroundWindow) throw new Error('BackgroundWindowMissing')
      expect(backgroundWindow.branchLength).toBe(20)
      expect(backgroundWindow.limit).toBe(19 - backgroundWindow.offset)
      expect(20 - backgroundWindow.offset).toBeGreaterThanOrEqual(10)
      expect(source.pageCalls[0]?.window.nodes.map((header) => header.id)).toEqual(
        rows.slice(backgroundWindow.offset, 19).map((row) => row.id),
      )

      await act(async () => {
        source.releaseBackgroundPage()
        await settle()
      })

      await waitFor(() =>
        expect(screen.getByTestId('exact-row-count')).toHaveTextContent(
          String(20 - backgroundWindow.offset),
        ),
      )
      expect(projectedMessages(controller).map((row) => row.id)).toEqual(
        rows.slice(backgroundWindow.offset).map((row) => row.id),
      )
      expect(screen.getByTestId('destination-row')).toBe(destinationNode)
      expect(source.pageCalls).toHaveLength(1)
      expect(transcriptIsFilling(controller)).toBe(false)
      expect(controller.getSnapshot().active?.presentation.residents.transcript?.seal).toBe(
        initialSeal,
      )
      view.unmount()
    })
  }

  it('drains multiple fixed-size pages without scrolling or publishing partial prepends', async () => {
    const rows = linearMessages(80, 200_000)
    const source = new DestinationFirstProjectionSource(rows)
    const navigation = new TestNavigationPort()
    const controller = createConversationController()
    controller.reconcileWorkspace(FENCE)
    controller.setProjectionSource(source)
    controller.setNavigationPort(navigation)
    const publishedWindows: string[][] = []
    const unsubscribe = controller.subscribe(() => {
      const ids = projectedMessages(controller).map((row) => row.id)
      if (ids.length === 0) return
      const prior = publishedWindows.at(-1)
      if (!prior || prior.length !== ids.length || prior.some((id, index) => id !== ids[index])) {
        publishedWindows.push(ids)
      }
    })

    const view = render(
      <Harness controller={controller} budget={initialTranscriptWorkBudget(50, 360)} />,
    )
    act(() => navigation.arrive('arrival-multiple-pages', rows.at(-1)?.id as MessageId))
    await waitFor(() => expect(source.selectionCalls).toHaveLength(1))

    await act(async () => {
      source.releaseSelection()
      await settle()
    })

    await waitFor(() => expect(source.pageCalls).toHaveLength(1))
    expect(screen.getByTestId('exact-row-count')).toHaveTextContent('1')
    expect(source.pageCalls[0]?.window.limit).toBe(24)

    for (let pageIndex = 0; pageIndex < 3; pageIndex += 1) {
      await act(async () => {
        source.releaseBackgroundPage(pageIndex)
        await settle()
      })
      if (pageIndex < 2) {
        await waitFor(() => expect(source.pageCalls).toHaveLength(pageIndex + 2))
        expect(screen.getByTestId('exact-row-count')).toHaveTextContent('1')
      }
    }

    expect(source.pageCalls.map((call) => call.window.limit)).toEqual([24, 24, 1])
    await waitFor(() => expect(screen.getByTestId('exact-row-count')).toHaveTextContent('50'))
    expect(projectedMessages(controller)).toHaveLength(50)
    const requestedIds = [...source.pageCalls]
      .sort((left, right) => left.window.offset - right.window.offset)
      .flatMap((call) => call.window.nodes.map((header) => header.id))
    expect(source.pageCalls.every((call) => call.window.nodes.length <= 24)).toBe(true)
    expect(requestedIds).toEqual(rows.slice(30, 79).map((row) => row.id))
    expect(new Set(requestedIds).size).toBe(requestedIds.length)
    expect(requestedIds).not.toContain(rows.at(-1)?.id)
    expect(publishedWindows.map((ids) => ids.length)).toEqual([1, 50])
    unsubscribe()
    view.unmount()
  })

  it('separates mounted surface identity from event-driven transcript and tree work ownership', async () => {
    const rows = linearMessages(20, 8)
    const source = new DestinationFirstProjectionSource(rows)
    const navigation = new TestNavigationPort()
    const controller = createConversationController()
    controller.reconcileWorkspace(FENCE)
    controller.setProjectionSource(source)
    controller.setNavigationPort(navigation)
    controller.installPresentationResourcePort(READY_PRESENTATION_RESOURCES)

    const view = render(
      <Harness controller={controller} budget={initialTranscriptWorkBudget(20, 360)} demanded />,
    )
    act(() => navigation.arrive('arrival-recycle', rows.at(-1)?.id as MessageId))
    await waitFor(() => expect(source.selectionCalls).toHaveLength(1))
    await act(async () => {
      source.releaseSelection()
      await settle()
    })
    await waitFor(() => expect(source.pageCalls).toHaveLength(1))
    await act(async () => {
      source.releaseBackgroundPage()
      await settle()
    })
    await waitFor(() => expect(projectedMessages(controller)).toHaveLength(20))

    const expanded = controller.getSnapshot().active?.presentation.residents.transcript
    if (!expanded) throw new Error('ExpandedTranscriptResidentMissing')
    const terminalMessage = [...transcriptBodyWindowRows(expanded.window)].at(-1)?.message
    controller.requestPresentation({ chatId: CHAT_ID, surface: 'tree' })
    await waitFor(() =>
      expect(controller.getSnapshot().active?.presentation.painted?.binding.surface).toBe('tree'),
    )
    expect(controller.getSnapshot().active?.presentation.residents.transcript?.window).toBe(
      expanded.window,
    )

    view.rerender(
      <Harness
        controller={controller}
        budget={initialTranscriptWorkBudget(20, 360)}
        demanded={false}
      />,
    )
    await act(settle)

    const recycled = controller.getSnapshot().active?.presentation.residents.transcript
    if (!recycled) throw new Error('RecycledTranscriptResidentMissing')
    expect(recycled).toMatchObject({
      currency: 'retained',
      selectionEpoch: expanded.selectionEpoch,
      viewportRevision: expanded.viewportRevision,
      window: { offset: 10, rowCount: 10 },
    })
    expect(recycled.seal).toBe(expanded.seal)
    expect(recycled.spine).toBe(expanded.spine)
    expect([...transcriptBodyWindowRows(recycled.window)].at(-1)?.message).toBe(terminalMessage)
    expect(source.pageCalls).toHaveLength(1)

    controller.requestPresentation({ chatId: CHAT_ID, surface: 'transcript' })
    const returned = controller.getSnapshot().active?.presentation
    expect(returned).toMatchObject({
      visibleReady: true,
      painted: { binding: { surface: 'transcript', currency: 'current' } },
      editorRetention: null,
      mounted: { transcript: true, tree: true },
    })
    expect(returned?.residents.transcript?.window).toBe(recycled.window)
    expect(returned?.residents.tree?.topology.nodes).toHaveLength(0)
    view.unmount()
  })

  it('keeps one monotonic suffix while adjacent explicit demand grows and never shrinks it', async () => {
    const rows = linearMessages(40, 200_000)
    const source = new DestinationFirstProjectionSource(rows)
    const navigation = new TestNavigationPort()
    const controller = createConversationController()
    controller.reconcileWorkspace(FENCE)
    controller.setProjectionSource(source)
    controller.setNavigationPort(navigation)

    const view = render(
      <Harness controller={controller} budget={initialTranscriptWorkBudget(20, 360)} />,
    )
    act(() => navigation.arrive('arrival-monotonic', rows.at(-1)?.id as MessageId))
    await waitFor(() => expect(source.selectionCalls).toHaveLength(1))
    await act(async () => {
      source.releaseSelection()
      await settle()
    })
    await waitFor(() => expect(source.pageCalls).toHaveLength(1))
    await act(async () => {
      source.releaseBackgroundPage(0)
      await settle()
    })
    await waitFor(() => expect(projectedWindow(controller)?.offset).toBe(20))
    const retainedTwenty = projectedWindow(controller)

    view.rerender(<Harness controller={controller} budget={initialTranscriptWorkBudget(10, 360)} />)
    await act(settle)
    expect(projectedWindow(controller)).toBe(retainedTwenty)
    expect(source.pageCalls).toHaveLength(1)

    view.rerender(<Harness controller={controller} budget={initialTranscriptWorkBudget(40, 360)} />)
    await waitFor(() => expect(source.pageCalls).toHaveLength(2))
    const adjacent = source.pageCalls[1]?.window
    if (!adjacent) throw new Error('AdjacentTranscriptPageMissing')
    expect(adjacent.offset + adjacent.limit).toBe(20)
    expect(adjacent.offset).toBe(0)
    expect(transcriptIsFilling(controller)).toBe(true)

    await act(async () => {
      source.releaseBackgroundPage(1)
      await settle()
    })
    await waitFor(() => expect(projectedWindow(controller)?.offset).toBe(0))
    expect(projectedMessages(controller)).toHaveLength(40)
    expect(transcriptIsFilling(controller)).toBe(false)
    view.unmount()
  })

  it('rejects a stale point after newer tab intent and after workspace replacement', async () => {
    const rows = linearMessages(3, 16)
    const source = new DestinationFirstProjectionSource(rows, { deferDestinations: true })
    const navigation = new TestNavigationPort()
    const controller = createConversationController()
    controller.reconcileWorkspace(FENCE)
    controller.setProjectionSource(source)
    controller.setNavigationPort(navigation)

    const view = render(<Harness controller={controller} />)
    act(() => navigation.arrive('arrival-stale-a', rows[1]?.id as MessageId))
    act(() => navigation.arrive('arrival-stale-b', rows[2]?.id as MessageId))
    expect(source.pendingDestinationCount()).toBe(2)

    act(() => source.releaseDestination(0))
    expect(screen.getByTestId('exact-row-count')).toHaveTextContent('0')
    act(() => source.releaseDestination(1))
    expect(screen.getByTestId('destination-row')).toHaveTextContent(rows[2]?.id as string)

    act(() => {
      controller.reconcileWorkspace({ workspaceId: 'replacement', replacementEpoch: 1 })
      source.releaseDestination(2)
    })
    expect(controller.getSnapshot()).toMatchObject({
      workspaceId: 'replacement',
      workspaceEpoch: 1,
      active: { transcript: { kind: 'absent' } },
    })
    view.unmount()
  })
})

function Harness({
  controller,
  budget = BASE_BUDGET,
  demanded = true,
}: {
  controller: ConversationController
  budget?: TranscriptWorkBudget
  demanded?: boolean
}) {
  const frame = useConversationFrame({
    chatId: CHAT_ID,
    controller,
  })
  useConversationTranscriptDemand(
    frame && demanded
      ? {
          chatId: CHAT_ID,
          selectionRevision: frame.selectionRevision,
          selectionEpoch: frame.transcriptSelectionEpoch,
          budget,
        }
      : null,
    controller,
  )
  const transcript = frame?.transcript
  const window = transcript && transcript.kind !== 'absent' ? transcript.window : null
  const messages = window ? [...transcriptBodyWindowRows(window)].map((row) => row.message) : []
  return (
    <>
      <output data-testid="exact-row-count">{messages.length}</output>
      <output data-testid="interaction-state">
        {transcript?.kind === 'point' ? 'inert' : 'interactive'}
      </output>
      {messages.map((message) => (
        <article
          key={message.id}
          data-testid={message.id === window?.leafId ? 'destination-row' : undefined}
        >
          {message.id}
        </article>
      ))}
    </>
  )
}

function projectedWindow(controller: ConversationController): ConversationTranscriptFrame | null {
  const transcript = controller.getSnapshot().active?.transcript
  return transcript && transcript.kind !== 'absent' ? transcript.window : null
}

function projectedMessages(controller: ConversationController): readonly Message[] {
  const window = projectedWindow(controller)
  return window ? [...transcriptBodyWindowRows(window)].map((row) => row.message) : []
}

function transcriptIsFilling(controller: ConversationController): boolean {
  const transcript = controller.getSnapshot().active?.transcript
  return transcript?.kind === 'ready' && transcript.filling
}

class TestNavigationPort implements ConversationNavigationPort {
  private arrival: ConversationRouteArrival = Object.freeze({ id: 'arrival-0', route: null })
  private readonly listeners = new Set<() => void>()
  readonly replacements: Array<{ chatId: ChatId; targetMessageId?: MessageId }> = []

  getArrival = () => this.arrival

  subscribeArrival = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  replaceConversationUrl = (chatId: ChatId, targetMessageId?: MessageId) => {
    this.replacements.push({ chatId, ...(targetMessageId ? { targetMessageId } : {}) })
  }

  arrive(id: string, targetMessageId: MessageId) {
    this.arrival = Object.freeze({ id, route: { chatId: CHAT_ID, targetMessageId } })
    for (const listener of this.listeners) listener()
  }
}

class DestinationFirstProjectionSource implements ConversationProjectionSource {
  readonly selectionCalls: ConversationSelectionProofTarget[] = []
  readonly pageCalls: Array<{
    leafId: MessageId
    structuralVersion: number
    window: BranchPathWindow<MessageHeaderRow>
  }> = []

  private readonly presentations: readonly ConversationMessagePresentation[]
  private readonly selectionRead =
    deferred<ConversationReadEnvelope<ConversationProjectionOpenResult>>()
  private readonly backgroundPageReads: Array<{
    readonly structuralVersion: number
    readonly window: BranchPathWindow<MessageHeaderRow>
    readonly read: ReturnType<
      typeof deferred<ConversationReadEnvelope<ConversationTranscriptPageResult>>
    >
  }> = []
  private readonly rows: readonly Message[]
  private readonly deferDestinations: boolean
  private readonly destinationReads: Array<{
    point: ConversationDestinationPoint
    publish: (envelope: ConversationReadEnvelope<ConversationDestinationPoint>) => void
  }> = []
  private pendingSelectionValue: ConversationReadEnvelope<ConversationProjectionOpenResult> | null =
    null

  constructor(rows: readonly Message[], options: { deferDestinations?: boolean } = {}) {
    this.rows = rows
    this.deferDestinations = options.deferDestinations === true
    this.presentations = Object.freeze(
      rows.map((row) => {
        const split = splitMessageForStorage(row)
        return Object.freeze({
          header: split.header,
          message: row,
          bodyVersion: split.header.bodyVersion,
        })
      }),
    )
  }

  openSelection(
    _chatId: ChatId,
    target: ConversationSelectionProofTarget,
    onPoint: ((point: ConversationReadEnvelope<ConversationDestinationPoint>) => void) | undefined,
    _signal: AbortSignal,
  ) {
    this.selectionCalls.push(target)
    const destination = this.targetPresentation(target)
    if (destination && onPoint) {
      const point = Object.freeze({
        kind: 'tip-point' as const,
        chat: chat(this.rows.at(-1)?.id ?? null),
        target,
        structuralVersion: 1,
        presentation: destination,
      })
      if (this.deferDestinations) this.destinationReads.push({ point, publish: onPoint })
      else onPoint(this.envelope(point))
    }
    const path = destination ? this.pathTo(destination.header.id) : []
    const provedSelection: ConversationProvedSelection = {
      kind: 'ready',
      chat: chat(this.rows.at(-1)?.id ?? null),
      target,
      proof: {
        chatId: CHAT_ID,
        structuralVersion: 1,
        tipId: destination?.header.id ?? null,
        pathHeaders: path.map((row) => row.header),
      },
      presentations: destination ? [destination] : [],
      forks: path.map((row) => singletonFork(row.header)),
      terminalChildSlot: emptyActiveBranchChildSlot(destination?.header.id ?? null),
    }
    this.pendingSelectionValue = this.envelope(sealConversationSelection(provedSelection))
    return this.selectionRead.promise
  }

  async loadChat() {
    return this.envelope(chat(this.rows.at(-1)?.id ?? null))
  }

  async loadForks(
    _chatId: ChatId,
    structuralVersion: number,
    targets: readonly ActiveBranchForkTarget[],
  ) {
    const headersById = new Map(this.presentations.map((row) => [row.header.id, row.header]))
    return this.envelope({
      kind: 'ready' as const,
      structuralVersion,
      forks: targets.flatMap((target) => {
        const header = headersById.get(target.selectedMessageId)
        return header ? [singletonFork(header)] : []
      }),
    })
  }

  async loadChildAtPosition() {
    return this.envelope(null)
  }

  async loadTopology() {
    const headers = this.presentations.map((row) => row.header)
    return this.envelope({
      kind: 'ready' as const,
      chat: chat(this.rows.at(-1)?.id ?? null),
      structuralVersion: 1,
      headers,
      childSlots: testChildSlotsForHeaders(CHAT_ID, headers),
    })
  }

  loadTranscriptPage(
    _chatId: ChatId,
    leafId: MessageId,
    structuralVersion: number,
    window: BranchPathWindow<MessageHeaderRow>,
  ) {
    this.pageCalls.push({ leafId, structuralVersion, window })
    const read = deferred<ConversationReadEnvelope<ConversationTranscriptPageResult>>()
    this.backgroundPageReads.push({ structuralVersion, window, read })
    return read.promise
  }

  async loadInspector(_chatId: ChatId, messageId: MessageId) {
    return this.envelope(this.presentations.find((row) => row.message.id === messageId) ?? null)
  }

  async loadPreviews(_chatId: ChatId, targets: readonly TreePreviewTarget[]) {
    const byId = new Map(this.presentations.map((row) => [row.message.id, row]))
    return this.envelope(
      targets.flatMap((target) => {
        const row = byId.get(target.messageId)
        return row
          ? [
              {
                messageId: target.messageId,
                bodyVersion: row.bodyVersion,
                text: messageText(row.message),
              },
            ]
          : []
      }) satisfies MessageTextPreview[],
    )
  }

  releaseSelection() {
    if (!this.pendingSelectionValue) throw new Error('SelectionNotRequested')
    this.selectionRead.resolve(this.pendingSelectionValue)
  }

  pendingDestinationCount() {
    return this.destinationReads.length
  }

  releaseDestination(index: number) {
    const destination = this.destinationReads[index]
    if (!destination) throw new Error('DestinationNotRequested')
    destination.publish(this.envelope(destination.point))
  }

  releaseBackgroundPage(index = 0) {
    const call = this.backgroundPageReads[index]
    if (!call) throw new Error('BackgroundPageNotRequested')
    const selected = this.presentations.slice(
      call.window.offset,
      call.window.offset + call.window.nodes.length,
    )
    call.read.resolve(
      this.envelope({
        kind: 'ready',
        structuralVersion: call.structuralVersion,
        page: this.page(selected, call.window.offset),
        material: selected,
      }),
    )
  }

  private page(
    selected: readonly ConversationMessagePresentation[],
    offset: number,
  ): ConversationTranscriptPage {
    return Object.freeze({
      chatId: CHAT_ID,
      leafId: this.rows.at(-1)?.id ?? null,
      branchLength: this.rows.length,
      offset,
      headers: Object.freeze(selected.map((row) => row.header)),
      messages: Object.freeze(selected.map((row) => row.message)),
    })
  }

  private destinationPresentation(selection: ActiveBranchSelection) {
    if (selection.kind === 'default') return this.presentations.at(-1)
    if (selection.kind === 'tip' || selection.kind === 'message') {
      return this.presentations.find((row) => row.header.id === selection.messageId)
    }
    return undefined
  }

  private targetPresentation(target: ConversationSelectionProofTarget) {
    if (target.kind === 'fixed-empty') return undefined
    if (target.kind === 'fixed-tip') {
      return this.presentations.find((row) => row.header.id === target.messageId)
    }
    return this.destinationPresentation(target.selection)
  }

  private pathTo(messageId: MessageId): readonly ConversationMessagePresentation[] {
    const index = this.presentations.findIndex((row) => row.header.id === messageId)
    return index < 0 ? [] : this.presentations.slice(0, index + 1)
  }

  private envelope<T>(value: T): ConversationReadEnvelope<T> {
    return Object.freeze({ ...FENCE, value })
  }
}

function singletonFork(header: MessageHeaderRow): ActiveBranchForkSlot {
  return Object.freeze({
    parentId: header.parentId,
    selectedMessageId: header.id,
    slotVersion: header.nodeVersion + 1,
    position: 0,
    liveCount: 1,
    nextSiblingIndex: 1,
    previousMessageId: null,
    nextMessageId: null,
    firstMessageId: header.id,
    lastMessageId: header.id,
  })
}

function linearMessages(count: number, bodyLength: number): readonly Message[] {
  const body = 'x'.repeat(bodyLength)
  return Object.freeze(
    Array.from({ length: count }, (_, index) => {
      const role = index % 2 === 0 ? 'user' : 'assistant'
      const id = `message-${String(index).padStart(2, '0')}`
      return Object.freeze({
        id,
        chatId: CHAT_ID,
        parentId: index === 0 ? null : `message-${String(index - 1).padStart(2, '0')}`,
        siblingIndex: 0,
        turnId: `turn-${index}`,
        turnIndex: index,
        createdAt: index + 1,
        role,
        origin: role === 'assistant' ? 'generated' : 'user',
        content: [{ type: role === 'assistant' ? 'output_text' : 'text', text: body }],
        nodeVersion: 0,
        deleted: false,
      }) as Message
    }),
  )
}

function chat(lastUpdatedLeafId: MessageId | null): Chat {
  return {
    id: CHAT_ID,
    title: 'Background fill',
    titleStatus: 'manual',
    createdAt: 1,
    updatedAt: 1,
    lastViewedAt: 1,
    wordCount: 0,
    totalCostUsd: 0,
    metaVersion: 0,
    summaryVersion: 0,
    structuralVersion: 1,
    configurationVersion: 0,
    settings: cloneDefaultChatSettings(),
    lastUpdatedLeafId,
    lastBranchUpdatedAt: 1,
    archived: false,
    pinned: false,
    folderId: null,
    tags: [],
  }
}

function messageText(message: Message): string {
  return message.content
    .flatMap((item) => (item.type === 'text' || item.type === 'output_text' ? [item.text] : []))
    .join('')
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve()
}
