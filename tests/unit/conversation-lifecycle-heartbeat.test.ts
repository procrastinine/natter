import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ActiveBranchForkSlot,
  ActiveBranchForkTarget,
  ActiveBranchSelection,
} from '../../src/core/active-branch-spine'
import type { BranchPathWindow } from '../../src/core/branch-session'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import {
  type ConversationDestinationPoint,
  type ConversationProvedSelection,
  type ConversationSelectionProofTarget,
  sealConversationSelection,
} from '../../src/core/messages'
import type { Chat, ChatId, Message, MessageId } from '../../src/core/types'
import {
  type ConversationNavigationPort,
  type ConversationProjectionOpenResult,
  type ConversationProjectionSource,
  type ConversationReadEnvelope,
  type ConversationRouteArrival,
  type ConversationTranscriptPage,
  type ConversationTranscriptPageResult,
  createConversationController,
  type MessageTextPreview,
  type TreePreviewTarget,
} from '../../src/store/conversation-controller'
import type { WorkspaceMessageMaterialCoordinator } from '../../src/store/generation-prompt-material'
import { type MessageHeaderRow, splitMessageForStorage } from '../../src/store/message-storage'
import type {
  ConversationForksResult,
  ConversationTopologyResult,
} from '../../src/store/workspace-protocol'

const FENCE = Object.freeze({ workspaceId: 'workspace-a', replacementEpoch: 0 })
const CHAT_ID = 'chat-a'

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

function message(
  id: string,
  parentId: MessageId | null,
  siblingIndex: number,
  createdAt: number,
): Message {
  const role = parentId === null || createdAt % 2 === 1 ? 'user' : 'assistant'
  return {
    id,
    chatId: CHAT_ID,
    parentId,
    siblingIndex,
    turnId: `turn-${id}`,
    turnIndex: createdAt,
    createdAt,
    role,
    origin: role === 'assistant' ? 'generated' : 'user',
    content: [{ type: role === 'assistant' ? 'output_text' : 'text', text: id }],
    nodeVersion: 0,
    deleted: false,
  }
}

function chat(lastUpdatedLeafId: MessageId | null): Chat {
  return {
    id: CHAT_ID,
    title: 'Conversation',
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

function presentation(row: Message, bodyVersion = 1) {
  const split = splitMessageForStorage(row, { bodyVersion })
  return Object.freeze({ header: split.header, message: row, bodyVersion })
}

class TestNavigationPort implements ConversationNavigationPort {
  private arrival: ConversationRouteArrival = Object.freeze({ id: 'arrival-0', route: null })
  private readonly listeners = new Set<() => void>()

  getArrival = () => this.arrival
  subscribeArrival = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  replaceConversationUrl = vi.fn()

  arrive(id: string, targetMessageId: MessageId): void {
    this.arrival = Object.freeze({
      id,
      route: Object.freeze({ chatId: CHAT_ID, targetMessageId }),
    })
    for (const listener of this.listeners) listener()
  }
}

class TestProjectionSource implements ConversationProjectionSource {
  private readonly rows = new Map<MessageId, ReturnType<typeof presentation>>()
  currentChat = chat(null)
  nextTopologyGate: Deferred<void> | null = null
  nextForkGate: Deferred<void> | null = null
  openSelectionFailuresRemaining = 0
  readonly topologySignals: AbortSignal[] = []
  readonly forkSignals: AbortSignal[] = []

  readonly loadChat = vi.fn(async (_chatId: ChatId, _signal: AbortSignal) =>
    this.envelope(structuredClone(this.currentChat)),
  )

  readonly openSelection = vi.fn(
    async (
      _chatId: ChatId,
      target: ConversationSelectionProofTarget,
      onPoint:
        | ((point: ConversationReadEnvelope<ConversationDestinationPoint>) => void)
        | undefined,
      _signal: AbortSignal,
    ): Promise<ConversationReadEnvelope<ConversationProjectionOpenResult>> => {
      const pointId = this.resolveSelection(target.selection)
      const point = pointId ? this.rows.get(pointId) : undefined
      if (onPoint) {
        onPoint(
          this.envelope(
            point
              ? {
                  kind: 'tip-point',
                  chat: structuredClone(this.currentChat),
                  target,
                  structuralVersion: this.currentChat.structuralVersion,
                  presentation: point,
                }
              : {
                  kind: 'empty-point',
                  chat: structuredClone(this.currentChat),
                  target,
                  structuralVersion: this.currentChat.structuralVersion,
                },
          ),
        )
      }
      if (this.openSelectionFailuresRemaining > 0) {
        this.openSelectionFailuresRemaining -= 1
        throw new Error('planned-open-selection-failure')
      }
      const tipId =
        target.kind === 'fixed-empty'
          ? null
          : target.kind === 'fixed-tip'
            ? target.messageId
            : this.resolveSelection(target.selection)
      const path = tipId ? this.pathTo(tipId) : []
      const tip = path.at(-1)
      const destination: ConversationProvedSelection = {
        kind: 'ready',
        chat: structuredClone(this.currentChat),
        target,
        proof: {
          chatId: CHAT_ID,
          structuralVersion: this.currentChat.structuralVersion,
          tipId,
          pathHeaders: Object.freeze(path.map((row) => row.header)),
        },
        presentations: Object.freeze(tip ? [tip] : []),
      }
      return this.envelope(sealConversationSelection(destination))
    },
  )

  readonly loadForks = vi.fn(
    async (
      _chatId: ChatId,
      structuralVersion: number,
      targets: readonly ActiveBranchForkTarget[],
      signal: AbortSignal,
    ): Promise<ConversationReadEnvelope<ConversationForksResult>> => {
      this.forkSignals.push(signal)
      const gate = this.nextForkGate
      this.nextForkGate = null
      if (gate) await gate.promise
      if (signal.aborted) throw signal.reason
      return this.envelope({
        kind: 'ready',
        structuralVersion,
        forks: Object.freeze(targets.map((target) => this.forkFor(target))),
      })
    },
  )

  readonly loadChildAtPosition = vi.fn(
    async (_chatId: ChatId, parentId: MessageId | null, position: number, _signal: AbortSignal) =>
      this.envelope(this.children(parentId)[position]?.header.id ?? null),
  )

  readonly loadTopology = vi.fn(
    async (
      _chatId: ChatId,
      signal: AbortSignal,
    ): Promise<ConversationReadEnvelope<ConversationTopologyResult>> => {
      this.topologySignals.push(signal)
      const gate = this.nextTopologyGate
      this.nextTopologyGate = null
      if (gate) await gate.promise
      if (signal.aborted) throw signal.reason
      return this.envelope({
        kind: 'ready',
        chat: structuredClone(this.currentChat),
        structuralVersion: this.currentChat.structuralVersion,
        headers: Object.freeze([...this.rows.values()].map((row) => row.header)),
      })
    },
  )

  readonly loadTranscriptPage = vi.fn(
    async (
      _chatId: ChatId,
      leafId: MessageId,
      structuralVersion: number,
      window: BranchPathWindow<MessageHeaderRow>,
      material: WorkspaceMessageMaterialCoordinator,
      signal: AbortSignal,
    ): Promise<ConversationReadEnvelope<ConversationTranscriptPageResult>> => {
      const path = this.pathTo(leafId)
      const selected = path.slice(window.offset, window.offset + window.nodes.length)
      const exact = await material.read(
        material,
        selected.map((row) => row.header),
        async (headers, sharedSignal) => {
          sharedSignal.throwIfAborted()
          return Object.freeze({
            ...FENCE,
            material: Object.freeze(headers.map((header) => this.rows.get(header.id))),
          })
        },
        signal,
      )
      const presentations = exact.map((row, index) => {
        if (!row) throw new Error(`missing transcript material:${selected[index]?.header.id}`)
        return row
      })
      const page: ConversationTranscriptPage = Object.freeze({
        chatId: CHAT_ID,
        leafId,
        branchLength: path.length,
        offset: window.offset,
        headers: Object.freeze(selected.map((row) => row.header)),
        messages: Object.freeze(selected.map((row) => row.message)),
      })
      return this.envelope({
        kind: 'ready',
        structuralVersion,
        page,
        material: Object.freeze(presentations),
      })
    },
  )

  readonly loadInspector = vi.fn(async () => this.envelope(null))
  readonly loadPreviews = vi.fn(async (_chatId: ChatId, _targets: readonly TreePreviewTarget[]) =>
    this.envelope(Object.freeze([]) as readonly MessageTextPreview[]),
  )

  seed(rows: readonly Message[], latestId: MessageId): void {
    this.rows.clear()
    for (const row of rows) this.rows.set(row.id, presentation(row))
    this.currentChat = chat(latestId)
  }

  put(row: Message): ReturnType<typeof presentation> {
    const next = presentation(row)
    this.rows.set(row.id, next)
    this.currentChat = Object.freeze({
      ...this.currentChat,
      lastUpdatedLeafId: row.id,
      lastBranchUpdatedAt: row.createdAt,
      metaVersion: this.currentChat.metaVersion + 1,
      structuralVersion: this.currentChat.structuralVersion + 1,
    })
    return next
  }

  private resolveSelection(selection: ActiveBranchSelection): MessageId | null {
    if (selection.kind === 'default') return this.currentChat.lastUpdatedLeafId
    if (selection.kind === 'tip') return selection.messageId
    if (selection.kind === 'message') return selection.observedTipId ?? selection.messageId
    return this.children(selection.parentId)[selection.position]?.header.id ?? null
  }

  private pathTo(messageId: MessageId): ReturnType<typeof presentation>[] {
    const path: ReturnType<typeof presentation>[] = []
    const seen = new Set<MessageId>()
    let current = this.rows.get(messageId)
    while (current && !seen.has(current.header.id)) {
      seen.add(current.header.id)
      path.push(current)
      current = current.header.parentId ? this.rows.get(current.header.parentId) : undefined
    }
    return path.reverse()
  }

  private children(parentId: MessageId | null) {
    return [...this.rows.values()]
      .filter((row) => !row.header.deleted && row.header.parentId === parentId)
      .sort((left, right) => left.header.siblingIndex - right.header.siblingIndex)
  }

  private forkFor(target: ActiveBranchForkTarget): ActiveBranchForkSlot {
    const siblings = this.children(target.parentId)
    const position = siblings.findIndex((row) => row.header.id === target.selectedMessageId)
    if (position < 0) throw new Error(`missing fork target:${target.selectedMessageId}`)
    const first = siblings[0]
    const last = siblings.at(-1)
    if (!first || !last) throw new Error(`empty fork slot:${target.selectedMessageId}`)
    return Object.freeze({
      parentId: target.parentId,
      selectedMessageId: target.selectedMessageId,
      slotVersion: siblings.reduce((sum, row) => sum + row.header.nodeVersion + 1, 0),
      position,
      liveCount: siblings.length,
      previousMessageId: siblings[position - 1]?.header.id ?? null,
      nextMessageId: siblings[position + 1]?.header.id ?? null,
      firstMessageId: first.header.id,
      lastMessageId: last.header.id,
    })
  }

  private envelope<T>(value: T): ConversationReadEnvelope<T> {
    return Object.freeze({ ...FENCE, value })
  }
}

function harness(rows: readonly Message[], selectedId: MessageId) {
  const controller = createConversationController()
  const source = new TestProjectionSource()
  const navigation = new TestNavigationPort()
  source.seed(rows, selectedId)
  controller.reconcileWorkspace(FENCE)
  controller.setProjectionSource(source)
  controller.setNavigationPort(navigation)
  return { controller, source, navigation }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 16; index += 1) await Promise.resolve()
}

beforeEach(() => {
  sessionStorage.clear()
})

describe('conversation lifecycle heartbeat', () => {
  it('re-enters topology demand after withdrawing its first in-flight read', async () => {
    const root = message('root', null, 0, 1)
    const leaf = message('leaf', root.id, 0, 2)
    const { controller, source, navigation } = harness([root, leaf], leaf.id)
    navigation.arrive('arrival-1', leaf.id)
    await settle()

    const gate = deferred<void>()
    source.nextTopologyGate = gate
    controller.requestPresentation({ chatId: CHAT_ID, surface: 'tree' })
    await settle()
    expect(source.loadTopology).toHaveBeenCalledTimes(1)

    controller.requestPresentation({ chatId: CHAT_ID, surface: 'transcript' })
    expect(source.topologySignals[0]?.aborted).toBe(true)
    controller.requestPresentation({ chatId: CHAT_ID, surface: 'tree' })
    await settle()

    expect(source.loadTopology).toHaveBeenCalledTimes(2)
    expect(controller.getSnapshot().active?.topologyLoaded).toBe(true)
    gate.resolve()
    await settle()
    expect(controller.getSnapshot().active?.topologyLoaded).toBe(true)
  })

  it('does not cancel a relevant pending fork read for an off-path child-slot invalidation', async () => {
    const root = message('root', null, 0, 1)
    const selected = message('selected', root.id, 0, 2)
    const sibling = message('sibling', root.id, 1, 3)
    const offPathChild = message('off-path-child', sibling.id, 0, 4)
    const { controller, source, navigation } = harness(
      [root, selected, sibling, offPathChild],
      selected.id,
    )
    const gate = deferred<void>()
    source.nextForkGate = gate
    navigation.arrive('arrival-1', selected.id)
    await settle()

    expect(source.loadForks).toHaveBeenCalledTimes(1)
    expect(source.forkSignals[0]?.aborted).toBe(false)
    controller.applyCommittedEffect({
      ...FENCE,
      chatId: CHAT_ID,
      source: 'invalidation',
      kind: 'changed',
      structural: { kind: 'none' },
      refresh: { forkParentIds: [sibling.id] },
    })
    expect(source.forkSignals[0]?.aborted).toBe(false)
    expect(source.loadForks).toHaveBeenCalledTimes(1)

    gate.resolve()
    await settle()
    const destination = controller.getSnapshot().active?.destination
    expect(destination?.kind).toBe('ready')
    if (destination?.kind !== 'ready') throw new Error('expected ready destination')
    expect(destination.spine.forkFor(selected.id)?.liveCount).toBe(2)
  })

  it('keeps a fixed local selection when a remote newer sibling arrives', async () => {
    const root = message('root', null, 0, 1)
    const selected = message('selected', root.id, 0, 2)
    const { controller, source, navigation } = harness([root, selected], selected.id)
    navigation.arrive('arrival-1', selected.id)
    await settle()
    expect(controller.getSnapshot().active?.destination.kind).toBe('ready')

    const remote = source.put(message('remote-newer', root.id, 1, 10))
    controller.applyCommittedEffect({
      ...FENCE,
      chatId: CHAT_ID,
      source: 'remote',
      kind: 'changed',
      structural: {
        kind: 'exact-delta',
        toVersion: source.currentChat.structuralVersion,
        structuralVersions: [source.currentChat.structuralVersion],
        messageIds: [remote.header.id],
      },
      chat: structuredClone(source.currentChat),
      revisions: [
        {
          header: remote.header,
          structuralVersion: source.currentChat.structuralVersion,
          presentation: remote,
        },
      ],
      refresh: { forkParentIds: [root.id] },
    })
    await settle()

    const destination = controller.getSnapshot().active?.destination
    expect(destination?.kind).toBe('ready')
    if (destination?.kind !== 'ready') throw new Error('expected ready destination')
    expect(controller.getSnapshot().active?.chat?.lastUpdatedLeafId).toBe(remote.header.id)
    expect(destination.spine.resolvedLeafId).toBe(selected.id)
  })

  it('does no work and cannot steer when the strongest remote refresh targets another chat', async () => {
    const root = message('root', null, 0, 1)
    const selected = message('selected', root.id, 0, 2)
    const { controller, source, navigation } = harness([root, selected], selected.id)
    navigation.arrive('arrival-1', selected.id)
    await settle()
    const before = controller.getSnapshot()
    const beforeCalls = projectionReadCounts(source)
    const published = vi.fn()
    const unsubscribe = controller.subscribe(published)
    published.mockClear()
    navigation.replaceConversationUrl.mockClear()

    controller.applyCommittedEffect({
      ...FENCE,
      chatId: 'chat-b',
      source: 'remote',
      kind: 'changed',
      structural: {
        kind: 'incomplete',
        toVersion: null,
        scope: true,
      },
      refresh: { chat: true, headers: true, bodies: true, previews: true, forkParentIds: true },
    })
    await settle()

    expect(controller.getSnapshot()).toBe(before)
    expect(projectionReadCounts(source)).toEqual(beforeCalls)
    expect(published).not.toHaveBeenCalled()
    expect(navigation.replaceConversationUrl).not.toHaveBeenCalled()
    const destination = controller.getSnapshot().active?.destination
    expect(destination?.kind).toBe('ready')
    if (destination?.kind !== 'ready') throw new Error('expected ready destination')
    expect(destination.spine.resolvedLeafId).toBe(selected.id)
    unsubscribe()
  })

  it('holds a failed selection read until one explicit invalidation retries it', async () => {
    const root = message('root', null, 0, 1)
    const leaf = message('leaf', root.id, 0, 2)
    const { controller, source, navigation } = harness([root, leaf], leaf.id)
    navigation.arrive('arrival-1', leaf.id)
    await settle()
    expect(source.openSelection).toHaveBeenCalledTimes(1)
    expect(controller.getSnapshot().active?.destination.kind).toBe('ready')

    source.openSelectionFailuresRemaining = 1
    controller.applyCommittedEffect({
      ...FENCE,
      chatId: CHAT_ID,
      source: 'invalidation',
      kind: 'changed',
      structural: { kind: 'none' },
      refresh: { headers: true },
    })
    await settle()

    expect(source.openSelection).toHaveBeenCalledTimes(2)
    expect(controller.getSnapshot().active?.destination.kind).toBe('failed')
    await settle()
    expect(source.openSelection).toHaveBeenCalledTimes(2)

    controller.applyCommittedEffect({
      ...FENCE,
      chatId: CHAT_ID,
      source: 'invalidation',
      kind: 'changed',
      structural: { kind: 'none' },
      refresh: { headers: true },
    })
    await settle()
    expect(source.openSelection).toHaveBeenCalledTimes(3)
    expect(controller.getSnapshot().active?.destination.kind).toBe('ready')
    await settle()
    expect(source.openSelection).toHaveBeenCalledTimes(3)
  })
})

function projectionReadCounts(source: TestProjectionSource): readonly number[] {
  return [
    source.loadChat,
    source.openSelection,
    source.loadForks,
    source.loadChildAtPosition,
    source.loadTopology,
    source.loadTranscriptPage,
    source.loadInspector,
    source.loadPreviews,
  ].map((reader) => reader.mock.calls.length)
}
