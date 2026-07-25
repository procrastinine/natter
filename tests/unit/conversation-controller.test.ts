import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import type {
  ActiveBranchForkSlot,
  ActiveBranchForkTarget,
  ActiveBranchSelection,
  VersionedActiveBranchSpine,
} from '../../src/core/active-branch-spine'
import type { BranchPathWindow } from '../../src/core/branch-session'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type {
  ConversationDestinationPoint,
  ConversationProvedSelection,
  ConversationSelectionProofTarget,
} from '../../src/core/messages'
import { sealConversationSelection } from '../../src/core/messages'
import type { Chat, ChatId, Message, MessageId } from '../../src/core/types'
import type {
  ExactTargetPresentationReceipt,
  TargetPresentationInterest,
} from '../../src/store/attempt-controller'
import {
  type ConversationCommittedEffect,
  type ConversationCurrentSurfaceBinding,
  type ConversationNavigationPort,
  type ConversationPresentationFrame,
  type ConversationPresentationResourcePort,
  type ConversationPresentationResourceState,
  type ConversationProjectionOpenResult,
  type ConversationProjectionSource,
  type ConversationReadEnvelope,
  type ConversationRouteArrival,
  type ConversationStructuralTransition,
  type ConversationSurface,
  type ConversationTargetPresentationPort,
  type ConversationTranscriptFrame,
  type ConversationTranscriptPage,
  type ConversationViewportPort,
  type ConversationViewportTransition,
  type ConversationVisibleSurfaceBinding,
  createConversationController,
  type MessageTextPreview,
  type PreservingLocalResultEffect,
  type TreePreviewTarget,
} from '../../src/store/conversation-controller'
import { createConversationRouteOwnerController } from '../../src/store/conversation-route-owner'
import type { WorkspaceMessageMaterialCoordinator } from '../../src/store/generation-prompt-material'
import { type MessageHeaderRow, splitMessageForStorage } from '../../src/store/message-storage'
import { transcriptBodyWindowRows } from '../../src/store/transcript-window'
import type {
  ConversationForksResult,
  ConversationTopologyResult,
} from '../../src/store/workspace-protocol'
import { CONVERSATION_SESSION_PREFIX } from '../../src/store/workspace-tab-session'

const FENCE = Object.freeze({ workspaceId: 'workspace-a', replacementEpoch: 0 })
const CHAT_ID = 'chat-a'

function message(
  id: string,
  parentId: string | null,
  siblingIndex: number,
  text: string,
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
    content: [{ type: role === 'assistant' ? 'output_text' : 'text', text }],
    nodeVersion: 0,
    deleted: false,
  }
}

function presentation(row: Message, bodyVersion = 1) {
  const split = splitMessageForStorage(row, { bodyVersion })
  return { header: split.header, message: row, bodyVersion }
}

function chat(lastUpdatedLeafId: MessageId | null, chatId: ChatId = CHAT_ID): Chat {
  return {
    id: chatId,
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

function sameMessageIds(actual: readonly MessageId[], expected: readonly MessageId[]): boolean {
  return (
    actual.length === expected.length &&
    actual.every((messageId, index) => messageId === expected[index])
  )
}

function sealTestSelection(selection: ConversationProvedSelection) {
  return sealConversationSelection(selection)
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
  arrive(id: string, route: ConversationRouteArrival['route']) {
    this.arrival = Object.freeze({ id, route })
    for (const listener of [...this.listeners]) listener()
  }
}

class TestProjectionSource implements ConversationProjectionSource {
  readonly presentations = new Map<MessageId, ReturnType<typeof presentation>>()
  private readonly childrenByParent = new Map<MessageId | null, ReturnType<typeof presentation>[]>()
  currentChat = chat(null)
  workspaceFence: { workspaceId: string; replacementEpoch: number } = FENCE
  selectionCompletionGate: Promise<void> | null = null
  childPositionCompletionGate: Promise<void> | null = null
  topologyCompletionGate: Promise<void> | null = null
  forkCompletionGate: Promise<void> | null = null
  readonly childPositionSignals: AbortSignal[] = []
  readonly openSelection = vi.fn(this.readSelection.bind(this))
  readonly loadChat = vi.fn(async (_chatId: ChatId, _signal: AbortSignal) =>
    this.envelope(structuredClone(this.currentChat)),
  )
  readonly loadForks = vi.fn(
    async (
      _chatId: ChatId,
      structuralVersion: number,
      targets: readonly ActiveBranchForkTarget[],
    ): Promise<ConversationReadEnvelope<ConversationForksResult>> => {
      if (this.forkCompletionGate) await this.forkCompletionGate
      return this.envelope({
        kind: 'ready',
        structuralVersion,
        forks: targets.map((target) => this.forkFor(target.selectedMessageId)),
      })
    },
  )
  readonly loadChildAtPosition = vi.fn(
    async (_chatId: ChatId, parentId: MessageId | null, position: number, signal: AbortSignal) => {
      this.childPositionSignals.push(signal)
      if (this.childPositionCompletionGate) await this.childPositionCompletionGate
      if (signal.aborted) throw signal.reason
      return this.envelope(this.children(parentId)[position]?.header.id ?? null)
    },
  )
  readonly loadTopology = vi.fn(
    async (): Promise<ConversationReadEnvelope<ConversationTopologyResult>> => {
      if (this.topologyCompletionGate) await this.topologyCompletionGate
      return this.envelope({
        kind: 'ready',
        chat: structuredClone(this.currentChat),
        structuralVersion: this.currentChat.structuralVersion,
        headers: [...this.presentations.values()].map((row) => row.header),
      })
    },
  )
  readonly loadTranscriptPage = vi.fn(
    async (
      _chatId: ChatId,
      leafId: MessageId,
      structuralVersion: number,
      window: BranchPathWindow<MessageHeaderRow>,
      _material: WorkspaceMessageMaterialCoordinator,
      _signal: AbortSignal,
    ) => {
      const path = this.pathTo(leafId)
      const selected = path.slice(window.offset, window.offset + window.nodes.length)
      return this.envelope({
        kind: 'ready',
        structuralVersion,
        page: this.page(path, selected, window.offset),
        material: Object.freeze(selected),
      } as const)
    },
  )
  readonly loadInspector = vi.fn(async (_chatId: ChatId, messageId: MessageId) =>
    this.envelope(this.presentations.get(messageId) ?? null),
  )
  readonly loadPreviews = vi.fn(async (_chatId: ChatId, targets: readonly TreePreviewTarget[]) =>
    this.envelope(
      targets.flatMap((target) => {
        const row = this.presentations.get(target.messageId)
        return row && row.bodyVersion === target.bodyVersion
          ? [
              {
                messageId: target.messageId,
                bodyVersion: target.bodyVersion,
                text: textOf(row.message),
              },
            ]
          : []
      }) satisfies MessageTextPreview[],
    ),
  )

  seed(rows: readonly Message[], defaultLeafId: MessageId | null = rows.at(-1)?.id ?? null) {
    this.presentations.clear()
    this.childrenByParent.clear()
    for (const row of rows) {
      const stored = presentation(row)
      this.presentations.set(row.id, stored)
      this.indexChild(stored)
    }
    this.currentChat = chat(defaultLeafId, rows[0]?.chatId ?? CHAT_ID)
  }

  put(row: Message, bodyVersion = 1) {
    const previous = this.presentations.get(row.id)
    const structuralChanged =
      !previous ||
      previous.header.parentId !== row.parentId ||
      previous.header.siblingIndex !== row.siblingIndex ||
      previous.header.deleted !== row.deleted
    const next = presentation(row, bodyVersion)
    if (previous) this.removeIndexedChild(previous)
    this.presentations.set(row.id, next)
    this.indexChild(next)
    this.currentChat = {
      ...this.currentChat,
      lastUpdatedLeafId: row.id,
      lastBranchUpdatedAt: Math.max(this.currentChat.lastBranchUpdatedAt, row.createdAt),
      metaVersion: this.currentChat.metaVersion + 1,
      structuralVersion: this.currentChat.structuralVersion + (structuralChanged ? 1 : 0),
    }
    return next
  }

  committedSelection(
    tipId: MessageId | null,
    selectedPresentations?: readonly ReturnType<typeof presentation>[],
  ): ConversationProvedSelection {
    const path = tipId === null ? [] : this.pathTo(tipId)
    const terminal = path.at(-1)
    const presentations = selectedPresentations ?? (terminal ? [terminal] : [])
    return {
      kind: 'ready',
      chat: structuredClone(this.currentChat),
      target:
        tipId === null
          ? { kind: 'fixed-empty', selection: { kind: 'default' } }
          : {
              kind: 'fixed-tip',
              selection: { kind: 'tip', messageId: tipId },
              messageId: tipId,
            },
      proof: {
        chatId: this.currentChat.id,
        structuralVersion: this.currentChat.structuralVersion,
        tipId,
        pathHeaders: path.map((row) => row.header),
      },
      presentations,
    }
  }

  private async readSelection(
    _chatId: ChatId,
    target: ConversationSelectionProofTarget,
    onDestination:
      | ((envelope: ConversationReadEnvelope<ConversationDestinationPoint>) => void)
      | undefined,
    _signal: AbortSignal,
  ): Promise<ConversationReadEnvelope<ConversationProjectionOpenResult>> {
    const selection = target.selection
    if (onDestination) {
      const selectedId = this.pointSelection(selection)
      const selected = selectedId ? this.presentations.get(selectedId) : undefined
      if (selected) {
        onDestination(
          this.envelope({
            kind: 'tip-point',
            chat: structuredClone(this.currentChat),
            target,
            structuralVersion: this.currentChat.structuralVersion,
            presentation: selected,
          }),
        )
      }
    }
    if (this.selectionCompletionGate) await this.selectionCompletionGate
    const targetId =
      target.kind === 'fixed-empty'
        ? null
        : target.kind === 'fixed-tip'
          ? target.messageId
          : this.resolveSelection(selection)
    if (targetId === null) {
      return this.envelope(
        sealTestSelection({
          kind: 'ready',
          chat: structuredClone(this.currentChat),
          target,
          proof: {
            chatId: this.currentChat.id,
            structuralVersion: this.currentChat.structuralVersion,
            tipId: null,
            pathHeaders: [],
          },
          presentations: [],
        }),
      )
    }
    const path = this.pathTo(targetId)
    if (path.length === 0) {
      return this.envelope({
        kind: 'unavailable',
        chat: structuredClone(this.currentChat),
        target,
        reason: 'message-missing',
      })
    }
    const terminal = path.at(-1) as ReturnType<typeof presentation>
    return this.envelope(
      sealTestSelection({
        kind: 'ready',
        chat: structuredClone(this.currentChat),
        target,
        proof: {
          chatId: this.currentChat.id,
          structuralVersion: this.currentChat.structuralVersion,
          tipId: targetId,
          pathHeaders: path.map((row) => row.header),
        },
        presentations: [terminal],
      }),
    )
  }

  private pointSelection(selection: ActiveBranchSelection): MessageId | null {
    if (selection.kind === 'default') return this.currentChat.lastUpdatedLeafId
    if (selection.kind === 'tip') return selection.messageId
    const selected =
      selection.kind === 'message'
        ? this.presentations.get(selection.messageId)
        : this.children(selection.parentId)[selection.position]
    return selected && this.children(selected.header.id).length === 0 ? selected.header.id : null
  }

  private resolveSelection(selection: ActiveBranchSelection): MessageId | null {
    if (selection.kind === 'default') return this.currentChat.lastUpdatedLeafId
    if (selection.kind === 'message') {
      return selection.observedTipId ?? this.newestDescendant(selection.messageId)
    }
    if (selection.kind === 'tip') return selection.messageId
    return this.children(selection.parentId)[selection.position]?.header.id ?? null
  }

  private newestDescendant(messageId: MessageId): MessageId {
    const pending = [messageId]
    let newest = this.presentations.get(messageId)?.header
    while (pending.length > 0) {
      const currentId = pending.pop() as MessageId
      const children = this.children(currentId)
      if (children.length === 0) {
        const candidate = this.presentations.get(currentId)?.header
        if (
          candidate &&
          (!newest ||
            candidate.createdAt > newest.createdAt ||
            (candidate.createdAt === newest.createdAt && candidate.id > newest.id))
        ) {
          newest = candidate
        }
      } else {
        for (const child of children) pending.push(child.header.id)
      }
    }
    return newest?.id ?? messageId
  }

  private page(
    fullPath: readonly ReturnType<typeof presentation>[],
    selected: readonly ReturnType<typeof presentation>[],
    offset: number,
  ): ConversationTranscriptPage {
    const leafId = fullPath.at(-1)?.header.id ?? null
    if (leafId === null) throw new Error('test transcript page requires a leaf')
    return Object.freeze({
      chatId: this.currentChat.id,
      leafId,
      branchLength: fullPath.length,
      offset,
      headers: Object.freeze(selected.map((row) => row.header)),
      messages: Object.freeze(selected.map((row) => row.message)),
    })
  }

  private pathTo(messageId: MessageId): ReturnType<typeof presentation>[] {
    const path: ReturnType<typeof presentation>[] = []
    const seen = new Set<MessageId>()
    let current = this.presentations.get(messageId)
    while (current && !seen.has(current.header.id)) {
      seen.add(current.header.id)
      path.push(current)
      current = current.header.parentId
        ? this.presentations.get(current.header.parentId)
        : undefined
    }
    return path.reverse()
  }

  private children(parentId: MessageId | null) {
    return this.childrenByParent.get(parentId) ?? []
  }

  private indexChild(row: ReturnType<typeof presentation>): void {
    if (row.header.deleted) return
    const siblings = this.childrenByParent.get(row.header.parentId) ?? []
    siblings.push(row)
    siblings.sort((left, right) => left.header.siblingIndex - right.header.siblingIndex)
    this.childrenByParent.set(row.header.parentId, siblings)
  }

  private removeIndexedChild(row: ReturnType<typeof presentation>): void {
    if (row.header.deleted) return
    const siblings = this.childrenByParent.get(row.header.parentId)
    if (!siblings) return
    const index = siblings.findIndex((candidate) => candidate.header.id === row.header.id)
    if (index >= 0) siblings.splice(index, 1)
    if (siblings.length === 0) this.childrenByParent.delete(row.header.parentId)
  }

  private forkFor(messageId: MessageId): ActiveBranchForkSlot {
    const selected = this.presentations.get(messageId)
    if (!selected) throw new Error(`missing selected message ${messageId}`)
    const siblings = this.children(selected.header.parentId)
    const position = siblings.findIndex((row) => row.header.id === messageId)
    if (position < 0) throw new Error(`missing selected sibling ${messageId}`)
    return Object.freeze({
      parentId: selected.header.parentId,
      selectedMessageId: messageId,
      slotVersion: siblings.reduce((sum, row) => sum + row.header.nodeVersion + 1, 0),
      position,
      liveCount: siblings.length,
      previousMessageId: siblings[position - 1]?.header.id ?? null,
      nextMessageId: siblings[position + 1]?.header.id ?? null,
      firstMessageId: siblings[0]?.header.id as MessageId,
      lastMessageId: siblings.at(-1)?.header.id as MessageId,
    })
  }

  private envelope<T>(value: T) {
    return Object.freeze({ ...this.workspaceFence, value })
  }
}

function textOf(row: Message): string {
  return row.content
    .flatMap((item) => (item.type === 'text' || item.type === 'output_text' ? [item.text] : []))
    .join('')
}

async function settle(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve()
}

function expectNoControllerTimers(timeout: { mock: { calls: unknown[][] } }): void {
  const controllerTimers = timeout.mock.calls.filter((args) => {
    const [callback, delay, key] = args
    return !(
      typeof callback === 'function' &&
      callback.name === 'bound _dispatchStorageEvent' &&
      delay === 0 &&
      typeof key === 'string' &&
      key.startsWith(CONVERSATION_SESSION_PREFIX)
    )
  })
  expect(controllerTimers).toEqual([])
}

function harness(
  rows: readonly Message[],
  targetPresentationPort: ConversationTargetPresentationPort | null = null,
) {
  const controller = createConversationController(targetPresentationPort)
  const source = new TestProjectionSource()
  source.seed(rows)
  const navigation = new TestNavigationPort()
  const resources = new TestPresentationResourcePort()
  controller.reconcileWorkspace(FENCE)
  controller.setProjectionSource(source)
  controller.installPresentationResourcePort(resources)
  controller.setNavigationPort(navigation)
  return { controller, source, navigation, resources }
}

class TestPresentationResourcePort implements ConversationPresentationResourcePort {
  private readonly states = new Map<ConversationSurface, ConversationPresentationResourceState>([
    ['transcript', Object.freeze({ kind: 'ready' as const })],
    ['tree', Object.freeze({ kind: 'ready' as const })],
  ])
  private readonly listeners = new Set<() => void>()
  readonly requests: ConversationSurface[] = []

  get = (surface: ConversationSurface) =>
    this.states.get(surface) ?? Object.freeze({ kind: 'idle' as const })
  request = (surface: ConversationSurface) => {
    this.requests.push(surface)
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  set(surface: ConversationSurface, state: ConversationPresentationResourceState) {
    this.states.set(surface, state)
    for (const listener of [...this.listeners]) listener()
  }
}

class TestViewportPort implements ConversationViewportPort {
  readonly preparations: ConversationViewportTransition[] = []
  readonly chatId: ChatId
  private readonly onPrepare: ((transition: ConversationViewportTransition) => void) | undefined

  constructor(
    chatId: ChatId = CHAT_ID,
    onPrepare?: (transition: ConversationViewportTransition) => void,
  ) {
    this.chatId = chatId
    this.onPrepare = onPrepare
  }

  prepare = (transition: ConversationViewportTransition) => {
    this.preparations.push(transition)
    this.onPrepare?.(transition)
    return Object.freeze({ kind: 'prepared' as const })
  }
}

function expectCoherentReadyPresentation(
  presentation: ConversationPresentationFrame | null | undefined,
  expectedSurface: 'transcript',
): Extract<ConversationCurrentSurfaceBinding, { readonly surface: 'transcript' }>
function expectCoherentReadyPresentation(
  presentation: ConversationPresentationFrame | null | undefined,
  expectedSurface: 'tree',
): Extract<ConversationCurrentSurfaceBinding, { readonly surface: 'tree' }>
function expectCoherentReadyPresentation(
  presentation: ConversationPresentationFrame | null | undefined,
  expectedSurface?: ConversationSurface,
): ConversationCurrentSurfaceBinding
function expectCoherentReadyPresentation(
  presentation: ConversationPresentationFrame | null | undefined,
  expectedSurface?: ConversationSurface,
): ConversationCurrentSurfaceBinding {
  if (presentation?.target.kind !== 'ready') {
    throw new Error('expected a ready conversation presentation')
  }
  const binding = presentation.target.binding
  if (expectedSurface && binding.surface !== expectedSurface) {
    throw new Error(`expected ${expectedSurface} presentation, received ${binding.surface}`)
  }
  expect(binding.currency).toBe('current')
  expect(presentation.painted?.binding).toBe(binding)
  expect(presentation.painted?.chat.id).toBe(binding.seal.chatId)
  expect(presentation.residents[binding.surface]).toBe(binding)
  expect(presentation.visibleReady).toBe(binding.reveal === null)
  expect(binding.seal).toMatchObject({
    chatId: binding.spine.chatId,
    structuralVersion: binding.spine.structuralVersion,
    leafId: binding.spine.resolvedLeafId,
  })
  if (binding.surface === 'transcript') {
    expect(binding.window).toMatchObject({
      chatId: binding.seal.chatId,
      leafId: binding.seal.leafId,
      branchLength: binding.spine.path.length,
    })
  }
  return binding
}

function expectRetainedPresentation(
  presentation: ConversationPresentationFrame | null | undefined,
  previous: ConversationVisibleSurfaceBinding,
): ConversationVisibleSurfaceBinding {
  const retained = presentation?.painted?.binding
  if (!retained) throw new Error('expected retained conversation presentation')
  expect(retained).not.toBe(previous)
  expect(retained.surface).toBe(previous.surface)
  expect(retained.currency).toBe('retained')
  expect(retained.reveal).toBeNull()
  expect(retained.seal).toBe(previous.seal)
  expect(retained.spine).toBe(previous.spine)
  expect(presentation.residents[retained.surface]).toBe(retained)
  expect(presentation.visibleReady).toBe(false)
  if (retained.surface === 'transcript' && previous.surface === 'transcript') {
    expect(retained.window).toBe(previous.window)
    expect(retained.selectionEpoch).toBe(previous.selectionEpoch)
    expect(retained.viewportRevision).toBe(previous.viewportRevision)
  } else if (retained.surface === 'tree' && previous.surface === 'tree') {
    expect(retained.headers).toBe(previous.headers)
    expect(retained.topology).toBe(previous.topology)
    expect(retained.changedHeaderKeys).toBe(previous.changedHeaderKeys)
    expect(retained.inspector).toBe(previous.inspector)
    expect(retained.previews).toBe(previous.previews)
  } else {
    throw new Error('retained presentation changed surface')
  }
  return retained
}

function presentedSpine(
  controller: ReturnType<typeof createConversationController>,
): VersionedActiveBranchSpine<MessageHeaderRow> {
  const destination = controller.getSnapshot().active?.destination
  if (!destination) throw new Error('missing active destination')
  if (destination.kind === 'ready') return destination.spine
  const retained = 'retained' in destination ? destination.retained : null
  if (!retained) throw new Error(`destination is not presented: ${destination.kind}`)
  return retained.spine
}

function projectedTranscript(
  controller: ReturnType<typeof createConversationController>,
): ConversationTranscriptFrame | null {
  const transcript = controller.getSnapshot().active?.transcript
  return transcript && transcript.kind !== 'absent' ? transcript.window : null
}

function exactTranscript(
  controller: ReturnType<typeof createConversationController>,
): ConversationTranscriptFrame | null {
  const transcript = controller.getSnapshot().active?.transcript
  return transcript?.kind === 'ready' ? transcript.window : null
}

function transcriptMessages(frame: ConversationTranscriptFrame | null): readonly Message[] {
  return frame ? [...transcriptBodyWindowRows(frame)].map((row) => row.message) : []
}

function localCommittedEffect(
  source: TestProjectionSource,
  presentations: readonly ReturnType<typeof presentation>[],
  headers: readonly MessageHeaderRow[] = presentations.map((row) => row.header),
  structural: ConversationStructuralTransition = headers.length === 0
    ? Object.freeze({ kind: 'none' })
    : Object.freeze({
        kind: 'exact-delta',
        toVersion: source.currentChat.structuralVersion,
        structuralVersions: Object.freeze(
          headers.map(
            (_, index) => source.currentChat.structuralVersion - headers.length + index + 1,
          ),
        ),
        messageIds: Object.freeze(headers.map((header) => header.id)),
      }),
): ConversationCommittedEffect {
  const presentationsById = new Map(presentations.map((row) => [row.header.id, row] as const))
  return Object.freeze({
    ...FENCE,
    chatId: CHAT_ID,
    source: 'local' as const,
    kind: 'changed' as const,
    structural,
    chat: structuredClone(source.currentChat),
    revisions: headers.map((header) => {
      const exact = presentationsById.get(header.id)
      return Object.freeze({
        header,
        structuralVersion: source.currentChat.structuralVersion,
        ...(exact ? { presentation: exact } : {}),
      })
    }),
  })
}

function retainedSessionIds(controller: ReturnType<typeof createConversationController>): string[] {
  return [
    ...(controller as unknown as { sessions: ReadonlyMap<ChatId, unknown> }).sessions.keys(),
  ].sort()
}

beforeEach(() => {
  sessionStorage.clear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('conversation controller', () => {
  it('cancels a superseded sibling-position read through the conversation read owner', async () => {
    const first = message('first', null, 0, 'first', 1)
    const second = message('second', null, 1, 'second', 3)
    const { controller, source } = harness([first, second])
    let release!: () => void
    source.childPositionCompletionGate = new Promise<void>((resolve) => {
      release = resolve
    })

    const superseded = controller.resolveSiblingPosition(CHAT_ID, null, 0)
    await settle()
    const current = controller.resolveSiblingPosition(CHAT_ID, null, 1)

    expect(source.childPositionSignals).toHaveLength(2)
    expect(source.childPositionSignals[0]?.aborted).toBe(true)
    expect(source.childPositionSignals[1]?.aborted).toBe(false)

    release()
    await expect(superseded).resolves.toBeNull()
    await expect(current).resolves.toBe(second.id)
  })

  it('releases inactive sessions after persistence unless an unfinished local operation owns one', async () => {
    const root = message('root', null, 0, 'root', 1)
    const { controller, navigation } = harness([root])

    navigation.arrive('arrival-1', { chatId: CHAT_ID, targetMessageId: root.id })
    await settle()
    expect(retainedSessionIds(controller)).toEqual([CHAT_ID])

    navigation.arrive('arrival-2', null)
    await settle()
    expect(retainedSessionIds(controller)).toEqual([])

    navigation.arrive('arrival-3', { chatId: CHAT_ID, targetMessageId: root.id })
    await settle()
    const operation = controller.claimOperation({ chatId: CHAT_ID, steering: 'select-result' })
    navigation.arrive('arrival-4', null)
    await settle()
    expect(retainedSessionIds(controller)).toEqual([CHAT_ID])

    controller.cancelOperation(operation)
    expect(retainedSessionIds(controller)).toEqual([])

    for (let index = 0; index < 1_000; index += 1) {
      controller.navigate({
        chatId: `inactive-${index}`,
        kind: 'message',
        messageId: `target-${index}`,
      })
    }
    expect(retainedSessionIds(controller)).toEqual([])
  })

  it('applies an existing-chat result to its tab session after navigation without retaining a route handoff', async () => {
    const root = message('root', null, 0, 'root', 1)
    const { controller, navigation, source } = harness([root])
    navigation.arrive('arrival-1', { chatId: CHAT_ID, targetMessageId: root.id })
    await settle()
    const operation = controller.claimOperation({
      chatId: CHAT_ID,
      steering: 'select-result',
      selectionDelivery: 'session',
    })
    navigation.arrive('arrival-2', null)
    await settle()
    const assistant = source.put(message('assistant', root.id, 0, 'answer', 2))

    const receipt = controller.acceptLocalResult(operation, {
      kind: 'select-committed',
      receipt: {
        ...FENCE,
        destination: source.committedSelection(assistant.header.id, [assistant]),
      },
      committedEffect: localCommittedEffect(source, [assistant]),
      revealTargetMessageId: assistant.header.id,
    })

    expect(receipt).toEqual({ accepted: true })
    expect(controller.observedCommitChatIds()).toEqual([])
    navigation.arrive('arrival-3', { chatId: CHAT_ID })
    await settle()
    expect(presentedSpine(controller).resolvedLeafId).toBe(assistant.header.id)
  })

  it('seals a selected destination before navigation without retaining the active route', async () => {
    const root = message('root', null, 0, 'root', 1)
    const { controller, navigation } = harness([root])
    navigation.arrive('arrival-1', { chatId: CHAT_ID, targetMessageId: root.id })
    await settle()

    const destination = controller.claimSelectedDestination({ chatId: CHAT_ID })
    expect(controller.resolveSelectedDestination(destination)).toEqual({
      kind: 'ready',
      expectedLeafId: root.id,
    })
    const promptDestination = controller.resolveSelectedPromptPath(destination)
    expect(promptDestination.kind).toBe('ready')
    if (promptDestination.kind !== 'ready') throw new Error('selected prompt path unavailable')
    expect(
      promptDestination.promptPath.capability({
        kind: 'send',
        chatId: CHAT_ID,
        expectedLeafId: root.id,
      }),
    ).toBe('available')

    navigation.arrive('arrival-2', null)
    await settle()
    expect(controller.resolveOperationDestination(destination.steering)).toEqual({
      kind: 'superseded',
    })
    expect(controller.resolveSelectedDestination(destination)).toEqual({
      kind: 'ready',
      expectedLeafId: root.id,
    })
    const retainedPromptDestination = controller.resolveSelectedPromptPath(destination)
    expect(retainedPromptDestination.kind).toBe('ready')
    if (retainedPromptDestination.kind !== 'ready') {
      throw new Error('retained selected prompt path unavailable')
    }
    expect(retainedPromptDestination.promptPath).toBe(promptDestination.promptPath)

    controller.cancelSelectedDestination(destination)
    expect(retainedSessionIds(controller)).toEqual([])
  })

  it('keeps an exact selected prompt path after a newer branch selection supersedes steering', async () => {
    const root = message('root', null, 0, 'root', 1)
    const first = message('first', root.id, 0, 'first', 2)
    const second = message('second', root.id, 1, 'second', 3)
    const { controller, navigation } = harness([root, first, second])
    navigation.arrive('arrival-1', { chatId: CHAT_ID, targetMessageId: first.id })
    await settle()

    const destination = controller.claimSelectedDestination({ chatId: CHAT_ID })
    const promptDestination = controller.resolveSelectedPromptPath(destination)
    expect(promptDestination.kind).toBe('ready')
    if (promptDestination.kind !== 'ready') throw new Error('selected prompt path unavailable')

    controller.navigate({
      chatId: CHAT_ID,
      kind: 'message',
      messageId: second.id,
    })
    await settle()

    expect(controller.resolveOperationDestination(destination.steering)).toEqual({
      kind: 'superseded',
    })
    expect(controller.resolveSelectedPromptPath(destination)).toEqual(promptDestination)

    controller.cancelSelectedDestination(destination)
    expect(controller.resolveSelectedPromptPath(destination)).toEqual({ kind: 'superseded' })
  })

  it('seals the exact presented destination while the same selection refreshes', async () => {
    const root = message('root', null, 0, 'root', 1)
    const leaf = message('leaf', root.id, 0, 'leaf', 2)
    const { controller, navigation, source } = harness([root, leaf])
    navigation.arrive('arrival-1', { chatId: CHAT_ID, targetMessageId: leaf.id })
    await settle()

    source.selectionCompletionGate = new Promise(() => {})
    controller.applyCommittedEffect({
      ...FENCE,
      chatId: CHAT_ID,
      source: 'invalidation',
      kind: 'changed',
      structural: { kind: 'none' },
      refresh: { headers: true },
    })
    expect(controller.getSnapshot().active?.destination.kind).toBe('resolving')

    const destination = controller.claimSelectedDestination({ chatId: CHAT_ID })
    const promptDestination = controller.resolveSelectedPromptPath(destination)
    expect(promptDestination.kind).toBe('ready')
    if (promptDestination.kind !== 'ready') throw new Error('selected prompt path unavailable')
    expect(promptDestination.expectedLeafId).toBe(leaf.id)
    expect(
      promptDestination.promptPath.capability({
        kind: 'send',
        chatId: CHAT_ID,
        expectedLeafId: leaf.id,
      }),
    ).toBe('available')
  })

  it('keeps a durable result successful while suppressing a superseded route delivery', () => {
    const root = message('root', null, 0, 'root', 1)
    const { controller, source } = harness([root])
    const owner = createConversationRouteOwnerController()
    const operation = controller.claimOperation({
      chatId: CHAT_ID,
      steering: 'select-result',
      selectionDelivery: 'route-handoff',
      routeOwner: owner.owner,
    })
    const assistant = source.put(message('assistant', root.id, 0, 'answer', 2))
    owner.cancel('newer-route')

    const receipt = controller.acceptLocalResult(operation, {
      kind: 'select-committed',
      receipt: {
        ...FENCE,
        destination: source.committedSelection(assistant.header.id, [assistant]),
      },
      committedEffect: localCommittedEffect(source, [assistant]),
    })

    expect(receipt).toEqual({
      accepted: true,
      routeDelivery: { kind: 'superseded' },
    })
    expect(
      (
        controller as unknown as {
          pendingRouteHandoffsByOwnerId: ReadonlyMap<string, unknown>
        }
      ).pendingRouteHandoffsByOwnerId.size,
    ).toBe(0)
  })

  it('hands an inactive committed selection to its route without a repository selection read', () => {
    const root = message('root', null, 0, 'root', 1)
    const { controller, navigation, source } = harness([root])
    const importedChatId = 'imported-chat'
    const importedRoot = presentation({
      ...message('imported-root', null, 0, 'imported root', 1),
      chatId: importedChatId,
    })
    const importedTip = presentation({
      ...message('imported-tip', importedRoot.header.id, 0, 'imported tip', 2),
      chatId: importedChatId,
    })
    const importedChat: Chat = {
      ...chat(importedTip.header.id),
      id: importedChatId,
      structuralVersion: 1,
    }
    const selection: ConversationProvedSelection = {
      kind: 'ready',
      chat: importedChat,
      target: {
        kind: 'fixed-tip',
        selection: { kind: 'tip', messageId: importedTip.header.id },
        messageId: importedTip.header.id,
      },
      proof: {
        chatId: importedChatId,
        structuralVersion: importedChat.structuralVersion,
        tipId: importedTip.header.id,
        pathHeaders: [importedRoot.header, importedTip.header],
      },
      presentations: [importedTip],
    }
    const operation = controller.claimOperation({
      chatId: importedChatId,
      steering: 'select-result',
      selectionDelivery: 'route-handoff',
      routeOwner: createConversationRouteOwnerController().owner,
    })
    const receipt = controller.acceptLocalResult(operation, {
      kind: 'select-committed',
      receipt: { ...FENCE, destination: selection },
      committedEffect: {
        ...FENCE,
        chatId: importedChatId,
        source: 'local',
        kind: 'changed',
        structural: {
          kind: 'exact-delta',
          toVersion: importedChat.structuralVersion,
          structuralVersions: [importedChat.structuralVersion],
          messageIds: [importedRoot.header.id, importedTip.header.id],
        },
        chat: importedChat,
        revisions: [
          {
            header: importedRoot.header,
            structuralVersion: importedChat.structuralVersion,
          },
          {
            header: importedTip.header,
            structuralVersion: importedChat.structuralVersion,
            presentation: importedTip,
          },
        ],
      },
    })
    expect(receipt.accepted).toBe(true)
    if (!receipt.accepted) throw new Error('missing route handoff')
    expect(receipt.routeDelivery.kind).toBe('handoff')
    if (receipt.routeDelivery.kind !== 'handoff') throw new Error('route superseded')

    expect(receipt.routeDelivery.handoff.chatId).toBe(importedChatId)
    const selectionReads = source.openSelection.mock.calls.length
    navigation.arrive('arrival-import', {
      chatId: importedChatId,
      handoff: receipt.routeDelivery.handoff,
    })

    const active = controller.getSnapshot().active
    expect(presentedSpine(controller).path.materializeIds()).toEqual([
      importedRoot.header.id,
      importedTip.header.id,
    ])
    expect(presentedSpine(controller).resolvedLeafId).toBe(importedTip.header.id)
    expect(active?.destination.kind).toBe('ready')
    expect(active?.presentation.target.kind).toBe('ready')
    expect(source.openSelection).toHaveBeenCalledTimes(selectionReads)
  })

  it('rejects a committed destination operation from a replaced workspace', () => {
    const root = message('root', null, 0, 'root', 1)
    const { controller } = harness([root])

    expect(() =>
      controller.claimOperation({
        chatId: 'imported-chat',
        workspaceFence: { workspaceId: 'replaced-workspace', replacementEpoch: 0 },
        steering: 'select-result',
      }),
    ).toThrowError('ConversationOperationWorkspaceMismatch')
    expect(retainedSessionIds(controller)).toEqual([])
  })

  it('keeps exact paint current across a same-fence projection-source rebind', async () => {
    const root = message('root', null, 0, 'root', 1)
    const leaf = message('leaf', root.id, 0, 'leaf', 2)
    const { controller, navigation, source } = harness([root, leaf])
    navigation.arrive('arrival-1', { chatId: CHAT_ID })
    await settle()
    const demandOwner = {}
    const opened = controller.getSnapshot().active
    if (!opened) throw new Error('missing active conversation')
    controller.setTranscriptDemand(demandOwner, {
      chatId: CHAT_ID,
      selectionRevision: opened.selectionRevision,
      selectionEpoch: opened.transcript.selectionEpoch,
      budget: { minimumRowCount: 2, textCharLimit: 100_000, renderCostLimit: 100_000 },
    })
    await settle()

    const exact = exactTranscript(controller)
    expect(transcriptMessages(exact).map((row) => row.id)).toEqual([root.id, leaf.id])
    const visible = expectCoherentReadyPresentation(
      controller.getSnapshot().active?.presentation,
      'transcript',
    )

    controller.setProjectionSource(null)
    expect(projectedTranscript(controller)).toBe(exact)
    expectCoherentReadyPresentation(controller.getSnapshot().active?.presentation, 'transcript')
    expect(controller.getSnapshot().active?.presentation.painted?.binding).toBe(visible)

    let acceptFreshSelection = () => {}
    source.selectionCompletionGate = new Promise<void>((resolve) => {
      acceptFreshSelection = resolve
    })
    const reboundPaintedRowCounts: number[] = []
    const unsubscribe = controller.subscribe(() => {
      const binding = controller.getSnapshot().active?.presentation.painted?.binding
      if (binding?.surface === 'transcript' && binding.seal.chatId === CHAT_ID) {
        reboundPaintedRowCounts.push([...transcriptBodyWindowRows(binding.window)].length)
      }
    })
    controller.setProjectionSource(source)
    expect(transcriptMessages(projectedTranscript(controller)).map((row) => row.id)).toEqual([
      root.id,
      leaf.id,
    ])
    const retained = expectRetainedPresentation(
      controller.getSnapshot().active?.presentation,
      visible,
    )
    expect(retained.surface).toBe('transcript')

    acceptFreshSelection()
    await settle()
    unsubscribe()
    expect(reboundPaintedRowCounts.length).toBeGreaterThan(0)
    expect(reboundPaintedRowCounts).not.toContain(1)
    expect(reboundPaintedRowCounts.at(-1)).toBe(2)
    expect(transcriptMessages(exactTranscript(controller)).map((row) => row.id)).toEqual([
      root.id,
      leaf.id,
    ])
    expectCoherentReadyPresentation(controller.getSnapshot().active?.presentation, 'transcript')
    controller.setTranscriptDemand(demandOwner, null)
  })

  it('retains one inert painted frame until a different chat becomes exact', async () => {
    const firstRoot = message('first-root', null, 0, 'first root', 1)
    const firstLeaf = message('first-leaf', firstRoot.id, 0, 'first leaf', 2)
    const { controller, navigation, source } = harness([firstRoot, firstLeaf])
    navigation.arrive('arrival-first', { chatId: CHAT_ID })
    await settle()

    const first = expectCoherentReadyPresentation(
      controller.getSnapshot().active?.presentation,
      'transcript',
    )
    const firstWindow = first.window
    const secondChatId = 'chat-b'
    const secondRoot = {
      ...message('second-root', null, 0, 'second root', 3),
      chatId: secondChatId,
    }
    const secondLeaf = {
      ...message('second-leaf', secondRoot.id, 0, 'second leaf', 4),
      chatId: secondChatId,
    }
    let releaseSecond: () => void = () => undefined
    source.selectionCompletionGate = new Promise<void>((resolve) => {
      releaseSecond = resolve
    })
    source.seed([secondRoot, secondLeaf])

    navigation.arrive('arrival-second', { chatId: secondChatId })
    const pending = controller.getSnapshot()
    expect(pending.activeChatId).toBe(secondChatId)
    expect(pending.active?.presentation.target.kind).toBe('pending')
    const retained = expectRetainedPresentation(pending.active?.presentation, first)
    expect(pending.active?.presentation.painted?.chat.id).toBe(CHAT_ID)
    if (retained.surface !== 'transcript') throw new Error('expected retained transcript')
    expect(retained.window).toBe(firstWindow)

    releaseSecond()
    source.selectionCompletionGate = null
    await settle()

    const second = expectCoherentReadyPresentation(
      controller.getSnapshot().active?.presentation,
      'transcript',
    )
    expect(controller.getSnapshot().active?.presentation.painted?.chat.id).toBe(secondChatId)
    expect(second.seal.chatId).toBe(secondChatId)
    expect(second.window).not.toBe(firstWindow)
  })

  it('consumes each route arrival once and mirrors selection without generating another arrival', async () => {
    const root = message('root', null, 0, 'root', 1)
    const leaf = message('leaf', root.id, 0, 'leaf', 2)
    const { controller, navigation, source } = harness([root, leaf])

    navigation.arrive('arrival-1', { chatId: CHAT_ID })
    await settle()
    expect(presentedSpine(controller).path.materializeIds()).toEqual(['root', 'leaf'])
    expect(navigation.replacements.at(-1)).toEqual({ chatId: CHAT_ID, targetMessageId: 'leaf' })
    const calls = source.openSelection.mock.calls.length

    navigation.arrive('arrival-1', { chatId: CHAT_ID })
    await settle()
    expect(source.openSelection).toHaveBeenCalledTimes(calls)
  })

  it('cancels a failed route arrival without acknowledging it so the same arrival can retry', () => {
    const controller = createConversationController()
    const source = new TestProjectionSource()
    source.seed([message('root', null, 0, 'root', 1)])
    const navigation = new TestNavigationPort()
    controller.reconcileWorkspace(FENCE)
    controller.setProjectionSource(source)
    controller.setNavigationPort(navigation)
    const releaseFailingResources = controller.installPresentationResourcePort({
      get: () => Object.freeze({ kind: 'ready' as const }),
      request: () => {
        throw new Error('presentation resource failed')
      },
      subscribe: () => () => undefined,
    })
    const cancel = vi.fn()

    expect(() =>
      navigation.arrive('retryable-arrival', {
        chatId: CHAT_ID,
        handoff: {
          id: 'failed-handoff',
          workspaceId: FENCE.workspaceId,
          replacementEpoch: FENCE.replacementEpoch,
          chatId: CHAT_ID,
          cancel,
        },
      }),
    ).toThrow('presentation resource failed')
    expect(cancel).toHaveBeenCalledTimes(1)

    releaseFailingResources()
    controller.installPresentationResourcePort(new TestPresentationResourcePort())
    navigation.arrive('retryable-arrival', { chatId: CHAT_ID })

    expect(controller.getSnapshot().activeChatId).toBe(CHAT_ID)
  })

  it('holds an arrival consumed before its presentation resource through a Strict Mode registration cycle', async () => {
    const root = message('root', null, 0, 'root', 1)
    const leaf = message('leaf', root.id, 0, 'leaf', 2)
    const controller = createConversationController()
    const source = new TestProjectionSource()
    const navigation = new TestNavigationPort()
    const resources = new TestPresentationResourcePort()
    resources.set('transcript', Object.freeze({ kind: 'idle' }))
    source.seed([root, leaf])
    controller.setNavigationPort(navigation)
    controller.reconcileWorkspace(FENCE)
    controller.setProjectionSource(source)
    const uninstallFirst = controller.installPresentationResourcePort(resources)
    const publicationOrder: string[] = []
    const viewport = new TestViewportPort(CHAT_ID, (transition) => {
      publicationOrder.push(`prepare:${transition.revision}`)
    })
    const uninstallViewport = controller.installViewportPort(viewport)
    const unsubscribe = controller.subscribe(() => {
      const binding = controller.getSnapshot().active?.presentation.painted?.binding
      if (binding?.currency === 'current' && binding.surface === 'transcript' && binding.reveal) {
        publicationOrder.push(`reveal:${binding.viewportRevision}`)
      }
    })

    navigation.arrive('arrival-1', { chatId: CHAT_ID, targetMessageId: leaf.id })
    await settle()
    expect(source.openSelection).toHaveBeenCalledTimes(1)
    expect(controller.getSnapshot().active?.presentation).toMatchObject({
      request: { surface: 'transcript' },
      painted: null,
      target: { kind: 'pending', surface: 'transcript', blocker: 'module' },
    })
    expect(presentedSpine(controller).path.materializeIds()).toEqual([root.id, leaf.id])

    resources.set('transcript', Object.freeze({ kind: 'ready' }))
    await settle()
    const firstReady = controller.getSnapshot().active?.presentation
    const firstBinding = expectCoherentReadyPresentation(firstReady, 'transcript')
    expect(firstBinding.seal.leafId).toBe(leaf.id)
    const reveal = firstBinding.reveal
    expect(reveal?.targetMessageId).toBe(leaf.id)
    const revealPublication = `reveal:${firstBinding.viewportRevision}`
    const revealIndex = publicationOrder.indexOf(revealPublication)
    expect(revealIndex).toBeGreaterThan(0)
    expect(publicationOrder[revealIndex - 1]).toBe(`prepare:${firstBinding.viewportRevision}`)

    uninstallFirst()
    const retained = expectRetainedPresentation(
      controller.getSnapshot().active?.presentation,
      firstBinding,
    )
    const uninstallSecond = controller.installPresentationResourcePort(resources)
    const secondBinding = expectCoherentReadyPresentation(
      controller.getSnapshot().active?.presentation,
      'transcript',
    )
    expect(secondBinding).not.toBe(retained)
    expect(secondBinding.window).toBe(firstBinding.window)
    expect(secondBinding.spine).toBe(firstBinding.spine)
    if (!reveal) throw new Error('missing presentation reveal')
    controller.consumePresentationReveal(reveal.id, 'transcript')
    await settle()
    const consumed = expectCoherentReadyPresentation(
      controller.getSnapshot().active?.presentation,
      'transcript',
    )
    expect(consumed.reveal).toBeNull()
    expect(consumed.window).toBe(firstBinding.window)
    expect(source.openSelection).toHaveBeenCalledTimes(1)
    unsubscribe()
    uninstallViewport()
    uninstallSecond()
  })

  it('resolves repeated message arrivals in the same mounted tab without reusing stale selection', async () => {
    const root = message('root', null, 0, 'root', 1)
    const left = message('left', root.id, 0, 'left', 2)
    const right = message('right', root.id, 1, 'right', 4)
    const { controller, navigation } = harness([root, left, right])

    navigation.arrive('arrival-1', { chatId: CHAT_ID, targetMessageId: left.id })
    await settle()
    expect(presentedSpine(controller).path.leaf?.id).toBe(left.id)
    navigation.arrive('arrival-2', { chatId: CHAT_ID, targetMessageId: right.id })
    await settle()
    expect(presentedSpine(controller).path.leaf?.id).toBe(right.id)
    navigation.arrive('arrival-3', { chatId: CHAT_ID, targetMessageId: left.id })
    await settle()
    expect(presentedSpine(controller).path.leaf?.id).toBe(left.id)
  })

  it('loads one bounded suffix to the divergence connector without dropping the common transcript prefix', async () => {
    const root = message('root', null, 0, 'root', 1)
    const oldBranch = message('old-branch', root.id, 0, 'old branch', 2)
    const oldLeaf = message('old-leaf', oldBranch.id, 0, 'old leaf', 3)
    const newBranch = message('new-branch', root.id, 1, 'new branch', 4)
    const newLeaf = message('new-leaf', newBranch.id, 0, 'new leaf', 5)
    const { controller, navigation, source } = harness([
      root,
      oldBranch,
      oldLeaf,
      newBranch,
      newLeaf,
    ])
    navigation.arrive('arrival-old', { chatId: CHAT_ID, targetMessageId: oldLeaf.id })
    await settle()

    const demandOwner = {}
    const opened = controller.getSnapshot().active
    if (!opened) throw new Error('missing opened conversation')
    controller.setTranscriptDemand(demandOwner, {
      chatId: CHAT_ID,
      selectionRevision: opened.selectionRevision,
      selectionEpoch: opened.transcript.selectionEpoch,
      budget: { minimumRowCount: 3, textCharLimit: 100_000, renderCostLimit: 100_000 },
    })
    await settle()
    expect(transcriptMessages(exactTranscript(controller)).map((row) => row.id)).toEqual([
      root.id,
      oldBranch.id,
      oldLeaf.id,
    ])

    source.loadTranscriptPage.mockClear()
    const publications: MessageId[][] = []
    const unsubscribe = controller.subscribe(() => {
      const frame = projectedTranscript(controller)
      if (frame) publications.push(transcriptMessages(frame).map((row) => row.id))
    })

    controller.navigate({
      chatId: CHAT_ID,
      kind: 'message',
      messageId: newLeaf.id,
    })
    const selecting = controller.getSnapshot().active
    if (!selecting) throw new Error('missing selecting conversation')
    controller.setTranscriptDemand(demandOwner, {
      chatId: CHAT_ID,
      selectionRevision: selecting.selectionRevision,
      selectionEpoch: selecting.transcript.selectionEpoch,
      budget: { minimumRowCount: 1, textCharLimit: 1, renderCostLimit: 1 },
    })
    await settle()

    expect(source.loadTranscriptPage).toHaveBeenCalledTimes(1)
    const transitionWindow = source.loadTranscriptPage.mock.calls[0]?.[3]
    expect(transitionWindow).toMatchObject({
      offset: 1,
      limit: 2,
      boundaryParentId: root.id,
    })
    expect(transitionWindow?.nodes.map((header) => header.id)).toEqual([newBranch.id, newLeaf.id])
    expect(transcriptMessages(exactTranscript(controller)).map((row) => row.id)).toEqual([
      root.id,
      newBranch.id,
      newLeaf.id,
    ])
    expect(publications.length).toBeGreaterThan(0)
    expect(publications.every((messageIds) => messageIds.includes(root.id))).toBe(true)

    unsubscribe()
    controller.setTranscriptDemand(demandOwner, null)
  })

  it('remembers a deeper fork when swiping away from and back to its ancestor', async () => {
    const root = message('root', null, 0, 'root', 1)
    const branchA = message('branch-a', root.id, 0, 'branch a', 2)
    const remembered = message('remembered', branchA.id, 0, 'remembered', 3)
    const newer = message('newer', branchA.id, 1, 'newer', 5)
    const branchB = message('branch-b', root.id, 1, 'branch b', 6)
    const { controller, navigation, source } = harness([root, branchA, remembered, newer, branchB])

    navigation.arrive('arrival-1', { chatId: CHAT_ID, targetMessageId: remembered.id })
    await settle()
    controller.navigate({
      chatId: CHAT_ID,
      kind: 'message',
      messageId: branchB.id,
    })
    await settle()
    controller.navigate({
      chatId: CHAT_ID,
      kind: 'message',
      messageId: branchA.id,
    })
    await settle()

    expect(presentedSpine(controller).path.leaf?.id).toBe(remembered.id)
    expect(source.openSelection.mock.calls.at(-1)?.[1]).toEqual({
      kind: 'resolve-selection',
      selection: {
        kind: 'message',
        messageId: branchA.id,
        observedTipId: remembered.id,
      },
    })
  })

  it('resolves an in-tab numeric sibling jump before applying that child remembered terminal', async () => {
    const root = message('root', null, 0, 'root', 1)
    const branchA = message('branch-a', root.id, 0, 'branch a', 2)
    const remembered = message('remembered', branchA.id, 0, 'remembered', 3)
    const branchB = message('branch-b', root.id, 1, 'branch b', 4)
    const { controller, navigation, source } = harness([root, branchA, remembered, branchB])

    navigation.arrive('arrival-remembered', {
      chatId: CHAT_ID,
      targetMessageId: remembered.id,
    })
    await settle()
    controller.navigate({ chatId: CHAT_ID, kind: 'message', messageId: branchB.id })
    await settle()

    source.loadChildAtPosition.mockClear()
    source.openSelection.mockClear()
    controller.navigate({
      chatId: CHAT_ID,
      kind: 'sibling-position',
      parentId: root.id,
      position: 0,
    })
    await settle()

    expect(source.loadChildAtPosition).toHaveBeenCalledTimes(1)
    expect(source.loadChildAtPosition.mock.calls[0]?.slice(0, 3)).toEqual([CHAT_ID, root.id, 0])
    expect(source.openSelection).toHaveBeenCalledTimes(1)
    expect(source.openSelection.mock.calls[0]?.[1]).toEqual({
      kind: 'resolve-selection',
      selection: {
        kind: 'message',
        messageId: branchA.id,
        observedTipId: remembered.id,
      },
    })
    expect(presentedSpine(controller).path.leaf?.id).toBe(remembered.id)
  })

  it('does not let a superseded numeric sibling resolution steal newer navigation', async () => {
    const root = message('root', null, 0, 'root', 1)
    const branchA = message('branch-a', root.id, 0, 'branch a', 2)
    const remembered = message('remembered', branchA.id, 0, 'remembered', 3)
    const branchB = message('branch-b', root.id, 1, 'branch b', 4)
    const branchC = message('branch-c', root.id, 2, 'branch c', 6)
    const { controller, navigation, source } = harness([
      root,
      branchA,
      remembered,
      branchB,
      branchC,
    ])

    navigation.arrive('arrival-remembered', {
      chatId: CHAT_ID,
      targetMessageId: remembered.id,
    })
    await settle()
    controller.navigate({ chatId: CHAT_ID, kind: 'message', messageId: branchB.id })
    await settle()

    let releaseNumeric!: () => void
    source.childPositionCompletionGate = new Promise<void>((resolve) => {
      releaseNumeric = resolve
    })
    source.loadChildAtPosition.mockClear()
    source.openSelection.mockClear()

    controller.navigate({
      chatId: CHAT_ID,
      kind: 'sibling-position',
      parentId: root.id,
      position: 0,
    })
    await settle()
    const numericRevision = controller.getSnapshot().active?.selectionRevision ?? -1
    expect(source.loadChildAtPosition).toHaveBeenCalledTimes(1)
    expect(source.childPositionSignals.at(-1)?.aborted).toBe(false)

    controller.navigate({ chatId: CHAT_ID, kind: 'message', messageId: branchC.id })
    const newerRevision = controller.getSnapshot().active?.selectionRevision ?? -1
    await settle()

    expect(newerRevision).toBeGreaterThan(numericRevision)
    expect(source.childPositionSignals.at(-1)?.aborted).toBe(true)
    expect(presentedSpine(controller).path.leaf?.id).toBe(branchC.id)
    expect(source.openSelection.mock.calls).toHaveLength(1)
    expect(source.openSelection.mock.calls[0]?.[1]).toEqual({
      kind: 'resolve-selection',
      selection: { kind: 'message', messageId: branchC.id },
    })

    releaseNumeric()
    await settle()

    expect(presentedSpine(controller).path.leaf?.id).toBe(branchC.id)
    expect(source.openSelection.mock.calls).toHaveLength(1)
  })

  it('lets a newer exact terminal replace and later re-extend an older remembered path', async () => {
    const root = message('root', null, 0, 'root', 1)
    const branchA = message('branch-a', root.id, 0, 'branch a', 2)
    const exactTip = message('exact-tip', branchA.id, 0, 'exact tip', 3)
    const deeper = message('deeper', exactTip.id, 0, 'deeper', 4)
    const branchB = message('branch-b', root.id, 1, 'branch b', 5)
    const { controller, navigation, source } = harness([root, branchA, exactTip, deeper, branchB])

    navigation.arrive('arrival-1', { chatId: CHAT_ID, targetMessageId: deeper.id })
    await settle()
    const exactOperation = controller.claimOperation({
      chatId: CHAT_ID,
      steering: 'select-result',
    })
    expect(
      controller.acceptLocalResult(exactOperation, {
        kind: 'select-committed',
        receipt: { ...FENCE, destination: source.committedSelection(exactTip.id) },
        committedEffect: localCommittedEffect(source, []),
      }),
    ).toEqual({ accepted: true })
    await settle()

    controller.navigate({ chatId: CHAT_ID, kind: 'message', messageId: branchB.id })
    await settle()
    controller.navigate({ chatId: CHAT_ID, kind: 'message', messageId: branchA.id })
    await settle()
    expect(presentedSpine(controller).path.leaf?.id).toBe(exactTip.id)
    expect(source.openSelection.mock.calls.at(-1)?.[1]).toEqual({
      kind: 'resolve-selection',
      selection: {
        kind: 'message',
        messageId: branchA.id,
        observedTipId: exactTip.id,
      },
    })

    const deeperOperation = controller.claimOperation({
      chatId: CHAT_ID,
      steering: 'select-result',
    })
    expect(
      controller.acceptLocalResult(deeperOperation, {
        kind: 'select-committed',
        receipt: { ...FENCE, destination: source.committedSelection(deeper.id) },
        committedEffect: localCommittedEffect(source, []),
      }),
    ).toEqual({ accepted: true })
    await settle()
    controller.navigate({ chatId: CHAT_ID, kind: 'message', messageId: branchB.id })
    await settle()
    controller.navigate({ chatId: CHAT_ID, kind: 'message', messageId: branchA.id })
    await settle()
    expect(presentedSpine(controller).path.leaf?.id).toBe(deeper.id)
  })

  it('remembers an exact terminal after a remote extension and a local branch roundtrip', async () => {
    const root = message('root', null, 0, 'root', 1)
    const branchA = message('branch-a', root.id, 0, 'branch a', 2)
    const exactTip = message('exact-tip', branchA.id, 0, 'exact tip', 3)
    const branchB = message('branch-b', root.id, 1, 'branch b', 4)
    const { controller, navigation, source } = harness([root, branchA, exactTip, branchB])

    navigation.arrive('arrival-exact', { chatId: CHAT_ID, targetMessageId: exactTip.id })
    await settle()

    const remoteExtension = source.put(
      message('remote-extension', exactTip.id, 0, 'remote extension', 5),
    )
    controller.applyCommittedEffect({
      ...FENCE,
      chatId: CHAT_ID,
      source: 'remote',
      kind: 'changed',
      structural: {
        kind: 'exact-delta',
        toVersion: source.currentChat.structuralVersion,
        structuralVersions: [source.currentChat.structuralVersion],
        messageIds: [remoteExtension.header.id],
      },
      revisions: [
        {
          header: remoteExtension.header,
          structuralVersion: source.currentChat.structuralVersion,
          presentation: remoteExtension,
        },
      ],
    })
    await settle()
    expect(presentedSpine(controller).path.leaf?.id).toBe(exactTip.id)

    controller.navigate({ chatId: CHAT_ID, kind: 'message', messageId: branchB.id })
    await settle()
    controller.navigate({ chatId: CHAT_ID, kind: 'message', messageId: branchA.id })
    await settle()

    expect(presentedSpine(controller).path.leaf?.id).toBe(exactTip.id)
    expect(source.openSelection.mock.calls.at(-1)?.[1]).toEqual({
      kind: 'resolve-selection',
      selection: {
        kind: 'message',
        messageId: branchA.id,
        observedTipId: exactTip.id,
      },
    })
  })

  it('keeps remembered descendant choices independent between controller instances', async () => {
    const root = message('root', null, 0, 'root', 1)
    const branchA = message('branch-a', root.id, 0, 'branch a', 2)
    const left = message('left-tip', branchA.id, 0, 'left', 3)
    const right = message('right-tip', branchA.id, 1, 'right', 4)
    const branchB = message('branch-b', root.id, 1, 'branch b', 5)
    const rows = [root, branchA, left, right, branchB]
    const first = harness(rows)
    const second = harness(rows)

    first.navigation.arrive('first-open', { chatId: CHAT_ID })
    second.navigation.arrive('second-open', { chatId: CHAT_ID })
    await settle()
    first.controller.navigate({
      chatId: CHAT_ID,
      kind: 'message',
      messageId: left.id,
    })
    second.controller.navigate({
      chatId: CHAT_ID,
      kind: 'message',
      messageId: right.id,
    })
    await settle()
    for (const controller of [first.controller, second.controller]) {
      controller.navigate({
        chatId: CHAT_ID,
        kind: 'message',
        messageId: branchB.id,
      })
    }
    await settle()
    for (const controller of [first.controller, second.controller]) {
      controller.navigate({
        chatId: CHAT_ID,
        kind: 'message',
        messageId: branchA.id,
      })
    }
    await settle()

    expect(presentedSpine(first.controller).path.leaf?.id).toBe(left.id)
    expect(presentedSpine(second.controller).path.leaf?.id).toBe(right.id)
  })

  it('makes the newest selection token authoritative and keeps direct navigation immutable', async () => {
    const root = message('root', null, 0, 'root', 1)
    const left = message('left', root.id, 0, 'left', 2)
    const right = message('right', root.id, 1, 'right', 4)
    const { controller, navigation } = harness([root, left, right])
    navigation.arrive('arrival-1', { chatId: CHAT_ID, targetMessageId: left.id })
    await settle()

    controller.navigate({
      chatId: CHAT_ID,
      kind: 'message',
      messageId: left.id,
    })
    const olderRevision = controller.getSnapshot().active?.selectionRevision ?? -1
    controller.navigate({
      chatId: CHAT_ID,
      kind: 'message',
      messageId: right.id,
    })
    const newerSnapshot = controller.getSnapshot().active
    await settle()

    expect(newerSnapshot?.selectionRevision).toBeGreaterThan(olderRevision)
    expect(Object.isFrozen(newerSnapshot)).toBe(true)
    expect(presentedSpine(controller).path.leaf?.id).toBe(right.id)
  })

  it('lets only the latest selecting operation steer while preserve operations cannot', async () => {
    const root = message('root', null, 0, 'root', 1)
    const left = message('left', root.id, 0, 'left', 2)
    const right = message('right', root.id, 1, 'right', 4)
    const { controller, navigation, source } = harness([root, left, right])
    const viewport = new TestViewportPort()
    const uninstallViewport = controller.installViewportPort(viewport)
    navigation.arrive('arrival-1', { chatId: CHAT_ID, targetMessageId: left.id })
    await settle()
    const initialReveal = controller.getSnapshot().active?.presentation.painted?.binding.reveal
    if (initialReveal) controller.consumePresentationReveal(initialReveal.id, 'transcript')

    const older = controller.claimOperation({ chatId: CHAT_ID, steering: 'select-result' })
    const newer = controller.claimOperation({ chatId: CHAT_ID, steering: 'select-result' })
    expect(controller.resolveOperationDestination(older)).toEqual({ kind: 'superseded' })
    expect(controller.resolveOperationDestination(newer)).toEqual({
      kind: 'ready',
      expectedLeafId: left.id,
    })
    expect(
      controller.acceptLocalResult(older, {
        kind: 'select-committed',
        receipt: { ...FENCE, destination: source.committedSelection(left.id) },
        revealTargetMessageId: left.id,
        committedEffect: localCommittedEffect(source, []),
      }),
    ).toEqual({ accepted: false })
    expect(controller.getSnapshot().active?.presentation.painted?.binding.reveal).toBeNull()
    expect(
      controller.acceptLocalResult(newer, {
        kind: 'select-committed',
        receipt: { ...FENCE, destination: source.committedSelection(right.id) },
        revealTargetMessageId: right.id,
        committedEffect: localCommittedEffect(source, []),
      }),
    ).toEqual({ accepted: true })
    await settle()
    expect(presentedSpine(controller).path.leaf?.id).toBe(right.id)
    const selected = expectCoherentReadyPresentation(
      controller.getSnapshot().active?.presentation,
      'transcript',
    )
    expect(selected.reveal?.targetMessageId).toBe(right.id)

    const preserve = controller.claimOperation({ chatId: CHAT_ID, steering: 'preserve' })
    expect(
      controller.acceptLocalResult(preserve, { kind: 'preserve', revealTargetMessageId: left.id }),
    ).toEqual({ accepted: true })
    expect(
      controller.acceptLocalResult(preserve, {
        kind: 'select-target',
        targetMessageId: left.id,
      } as never),
    ).toEqual({ accepted: false })
    expectTypeOf(controller.acceptLocalResult).toBeCallableWith(preserve, {
      kind: 'preserve',
    } satisfies PreservingLocalResultEffect)
    await settle()
    expect(presentedSpine(controller).path.leaf?.id).toBe(right.id)
    uninstallViewport()
  })

  it('does not let a remote sibling or newer workspace leaf steer this tab', async () => {
    const root = message('root', null, 0, 'root', 1)
    const left = message('left', root.id, 0, 'left', 2)
    const { controller, navigation, source } = harness([root, left])
    navigation.arrive('arrival-1', { chatId: CHAT_ID, targetMessageId: left.id })
    await settle()

    const remote = message('remote', root.id, 1, 'remote', 4)
    const committed = source.put(remote)
    controller.applyCommittedEffect({
      ...FENCE,
      chatId: CHAT_ID,
      source: 'remote',
      kind: 'changed',
      structural: {
        kind: 'exact-delta',
        toVersion: source.currentChat.structuralVersion,
        structuralVersions: [source.currentChat.structuralVersion],
        messageIds: [committed.header.id],
      },
      revisions: [
        {
          header: committed.header,
          structuralVersion: source.currentChat.structuralVersion,
          presentation: committed,
        },
      ],
    })
    await settle()

    expect(presentedSpine(controller).path.leaf?.id).toBe(left.id)
    expect(navigation.replacements.at(-1)?.targetMessageId).toBe(left.id)
  })

  it('keeps a local selection operation authoritative across remote extension and view changes', async () => {
    const root = message('root', null, 0, 'root', 1)
    const left = message('left', root.id, 0, 'left', 2)
    const { controller, navigation, source } = harness([root, left])
    navigation.arrive('arrival-1', { chatId: CHAT_ID, targetMessageId: left.id })
    await settle()

    const operation = controller.claimOperation({ chatId: CHAT_ID, steering: 'select-result' })
    expect(controller.resolveOperationDestination(operation)).toEqual({
      kind: 'ready',
      expectedLeafId: left.id,
    })
    const remoteExtension = source.put(message('remote-extension', left.id, 0, 'remote', 3))
    controller.applyCommittedEffect({
      ...FENCE,
      chatId: CHAT_ID,
      source: 'remote',
      kind: 'changed',
      structural: {
        kind: 'exact-delta',
        toVersion: source.currentChat.structuralVersion,
        structuralVersions: [source.currentChat.structuralVersion],
        messageIds: [remoteExtension.header.id],
      },
      revisions: [
        {
          header: remoteExtension.header,
          structuralVersion: source.currentChat.structuralVersion,
          presentation: remoteExtension,
        },
      ],
    })
    expect(controller.resolveOperationDestination(operation)).toEqual({
      kind: 'ready',
      expectedLeafId: left.id,
    })
    let releaseTopology = () => {}
    source.topologyCompletionGate = new Promise<void>((resolve) => {
      releaseTopology = resolve
    })
    const currentTranscript = expectCoherentReadyPresentation(
      controller.getSnapshot().active?.presentation,
      'transcript',
    )
    controller.requestPresentation({ chatId: CHAT_ID, surface: 'tree' })
    const pendingTree = controller.getSnapshot().active?.presentation
    expect(pendingTree).toMatchObject({
      request: { surface: 'tree' },
      visibleReady: true,
      painted: { binding: { surface: 'transcript', currency: 'current' } },
      target: { kind: 'pending', surface: 'tree', blocker: 'topology' },
      mounted: { transcript: true, tree: true },
    })
    expect(pendingTree?.painted?.binding).toBe(currentTranscript)

    const localSibling = source.put(message('local-sibling', root.id, 1, 'local', 4))
    expect(
      controller.acceptLocalResult(operation, {
        kind: 'select-committed',
        receipt: {
          ...FENCE,
          destination: source.committedSelection(localSibling.header.id, [localSibling]),
        },
        committedEffect: localCommittedEffect(source, [localSibling]),
      }),
    ).toEqual({ accepted: true })
    releaseTopology()
    source.topologyCompletionGate = null
    controller.requestPresentation({ chatId: CHAT_ID, surface: 'tree' })
    await settle()

    const treePresentation = controller.getSnapshot().active?.presentation
    expect(treePresentation?.request.surface).toBe('tree')
    const treeBinding = expectCoherentReadyPresentation(treePresentation, 'tree')
    expect(treeBinding.seal.leafId).toBe(localSibling.header.id)
    expect(new Set(treeBinding.topology.nodes.map((node) => node.id))).toEqual(
      new Set([root.id, left.id, remoteExtension.header.id, localSibling.header.id]),
    )
    for (const node of treeBinding.topology.nodes) {
      expect(treeBinding.headers.get(node.id)?.id).toBe(node.id)
    }
    expect(presentedSpine(controller).path.leaf?.id).toBe(localSibling.header.id)
    expect(presentedSpine(controller).forkFor(localSibling.header.id)).toMatchObject({
      position: 1,
      liveCount: 2,
    })
    expect(navigation.replacements.at(-1)?.targetMessageId).toBe(localSibling.header.id)

    controller.requestPresentation({ chatId: CHAT_ID, surface: 'transcript' })
    const transcriptPresentation = controller.getSnapshot().active?.presentation
    expect(transcriptPresentation?.request.surface).toBe('transcript')
    const transcriptBinding = expectCoherentReadyPresentation(transcriptPresentation, 'transcript')
    expect(transcriptBinding.seal.leafId).toBe(localSibling.header.id)
    expect(presentedSpine(controller).path.leaf?.id).toBe(localSibling.header.id)
  })

  it('keeps harmless ready-resource publications constant-work after proving a deep tree path', async () => {
    const rows: Message[] = []
    for (let index = 0; index < 512; index += 1) {
      rows.push(message(`deep-${index}`, rows.at(-1)?.id ?? null, 0, `deep ${index}`, index + 1))
    }
    const leafId = rows.at(-1)?.id
    if (!leafId) throw new Error('missing deep path leaf')
    const { controller, navigation, resources, source } = harness(rows)
    navigation.arrive('arrival-deep', { chatId: CHAT_ID, targetMessageId: leafId })
    await settle()
    controller.requestPresentation({ chatId: CHAT_ID, surface: 'tree' })
    await settle()

    const ready = controller.getSnapshot().active?.presentation.target
    if (ready?.kind !== 'ready' || ready.binding.surface !== 'tree') {
      throw new Error('deep tree presentation did not settle')
    }
    const binding = expectCoherentReadyPresentation(
      controller.getSnapshot().active?.presentation,
      'tree',
    )
    const path = binding.spine.path
    expect(path.length).toBe(rows.length)
    const iterate = vi.spyOn(path.messageIds, Symbol.iterator)
    const materializeIds = vi.spyOn(path, 'materializeIds')
    const materializeNodes = vi.spyOn(path, 'materializeNodes')
    const topologyReads = source.loadTopology.mock.calls.length

    for (let index = 0; index < 8; index += 1) {
      resources.set('tree', Object.freeze({ kind: 'ready' }))
      expect(controller.getSnapshot().active?.presentation.painted?.binding).toBe(binding)
    }

    expect(iterate).not.toHaveBeenCalled()
    expect(materializeIds).not.toHaveBeenCalled()
    expect(materializeNodes).not.toHaveBeenCalled()
    expect(source.loadTopology).toHaveBeenCalledTimes(topologyReads)
  })

  it('installs an exact local presentation before a delayed repository body can replace it', async () => {
    const root = message('root', null, 0, 'root', 1)
    const { controller, navigation, source } = harness([root])
    navigation.arrive('arrival-1', { chatId: CHAT_ID, targetMessageId: root.id })
    await settle()
    const demandOwner = {}
    const snapshot = controller.getSnapshot().active
    if (!snapshot) throw new Error('missing active snapshot')
    controller.setTranscriptDemand(demandOwner, {
      chatId: CHAT_ID,
      selectionRevision: snapshot.selectionRevision,
      selectionEpoch: snapshot.transcript.selectionEpoch,
      budget: { minimumRowCount: 10, textCharLimit: 100_000, renderCostLimit: 100_000 },
    })
    await settle()

    const assistant = message('assistant', root.id, 0, 'local exact body', 2)
    const committed = source.put(assistant)
    const operation = controller.claimOperation({ chatId: CHAT_ID, steering: 'select-result' })
    expect(
      controller.acceptLocalResult(operation, {
        kind: 'select-committed',
        receipt: { ...FENCE, destination: source.committedSelection(assistant.id, [committed]) },
        committedEffect: localCommittedEffect(source, [committed]),
      }),
    ).toEqual({ accepted: true })
    await settle()

    const selected = controller.getSnapshot().active
    if (!selected) throw new Error('missing selected snapshot')
    controller.setTranscriptDemand(demandOwner, {
      chatId: CHAT_ID,
      selectionRevision: selected.selectionRevision,
      selectionEpoch: selected.transcript.selectionEpoch,
      budget: { minimumRowCount: 10, textCharLimit: 100_000, renderCostLimit: 100_000 },
    })
    await settle()

    expect(transcriptMessages(exactTranscript(controller)).at(-1)?.content).toEqual([
      { type: 'output_text', text: 'local exact body' },
    ])
    controller.setTranscriptDemand(demandOwner, null)
  })

  it('contracts the painted transcript when ordinary same-epoch demand releases', async () => {
    const rows: Message[] = []
    for (let index = 0; index < 24; index += 1) {
      rows.push(message(`contract-${index}`, rows.at(-1)?.id ?? null, 0, `row ${index}`, index + 1))
    }
    const leafId = rows.at(-1)?.id
    if (!leafId) throw new Error('missing contraction leaf')
    const { controller, navigation } = harness(rows)
    controller.setSettledTranscriptWorkScale(1)
    navigation.arrive('arrival-contraction', { chatId: CHAT_ID, targetMessageId: leafId })
    await settle()

    const demandOwner = {}
    const opened = controller.getSnapshot().active
    if (!opened) throw new Error('missing contraction snapshot')
    controller.setTranscriptDemand(demandOwner, {
      chatId: CHAT_ID,
      selectionRevision: opened.selectionRevision,
      selectionEpoch: opened.transcript.selectionEpoch,
      budget: { minimumRowCount: 12, textCharLimit: 0, renderCostLimit: 0 },
    })
    await settle()
    expect(
      expectCoherentReadyPresentation(controller.getSnapshot().active?.presentation, 'transcript')
        .window.rowCount,
    ).toBe(12)

    controller.setTranscriptDemand(demandOwner, null)
    await settle()
    const contracted = expectCoherentReadyPresentation(
      controller.getSnapshot().active?.presentation,
      'transcript',
    )
    expect(contracted.window.rowCount).toBe(1)
    expect(transcriptMessages(contracted.window).map((row) => row.id)).toEqual([leafId])
  })

  it('keeps an admitted edit window resident until its exact retention claim releases', async () => {
    const rows: Message[] = []
    for (let index = 0; index < 24; index += 1) {
      rows.push(
        message(`edit-retained-${index}`, rows.at(-1)?.id ?? null, 0, `row ${index}`, index + 1),
      )
    }
    const leafId = rows.at(-1)?.id
    if (!leafId) throw new Error('missing retained edit leaf')
    const { controller, navigation } = harness(rows)
    controller.setSettledTranscriptWorkScale(1)
    navigation.arrive('arrival-edit-retention', { chatId: CHAT_ID, targetMessageId: leafId })
    await settle()

    const demandOwner = {}
    const opened = controller.getSnapshot().active
    if (!opened) throw new Error('missing retained edit snapshot')
    controller.setTranscriptDemand(demandOwner, {
      chatId: CHAT_ID,
      selectionRevision: opened.selectionRevision,
      selectionEpoch: opened.transcript.selectionEpoch,
      budget: { minimumRowCount: 12, textCharLimit: 0, renderCostLimit: 0 },
    })
    await settle()
    const expanded = exactTranscript(controller)
    if (!expanded) throw new Error('missing expanded retained transcript')
    expect(expanded.rowCount).toBe(12)
    const retainedMessageId = transcriptMessages(expanded)[0]?.id
    if (!retainedMessageId) throw new Error('missing retained edit target')

    const retention = controller.claimTranscriptRetention({
      chatId: CHAT_ID,
      messageId: retainedMessageId,
    })
    controller.requestPresentation({ chatId: CHAT_ID, surface: 'tree' })
    await settle()
    controller.setTranscriptDemand(demandOwner, null)
    await settle()
    expect(transcriptMessages(exactTranscript(controller)).map((row) => row.id)).toEqual(
      transcriptMessages(expanded).map((row) => row.id),
    )

    retention.release()
    await settle()
    expect(transcriptMessages(exactTranscript(controller)).map((row) => row.id)).toEqual([leafId])
  })

  it('hands a finalized local body directly into the painted transcript frame', async () => {
    const root = message('root', null, 0, 'prompt', 1)
    const assistant = message('assistant', root.id, 0, '', 2)
    const presentationInterests: TargetPresentationInterest[] = []
    const exactPresentationReceipts: ExactTargetPresentationReceipt[] = []
    const publicationOrder: string[] = []
    const targetPresentationPort: ConversationTargetPresentationPort = {
      targetPresentationInterests: () => presentationInterests,
      publishExactTargetPresentations: (receipts) => {
        exactPresentationReceipts.push(...receipts)
        publicationOrder.push('attempt')
      },
    }
    const { controller, navigation, source } = harness([root, assistant], targetPresentationPort)
    navigation.arrive('arrival-1', { chatId: CHAT_ID, targetMessageId: assistant.id })
    await settle()
    const demandOwner = {}
    const opened = controller.getSnapshot().active
    if (!opened) throw new Error('missing active snapshot')
    controller.setTranscriptDemand(demandOwner, {
      chatId: CHAT_ID,
      selectionRevision: opened.selectionRevision,
      selectionEpoch: opened.transcript.selectionEpoch,
      budget: { minimumRowCount: 10, textCharLimit: 100_000, renderCostLimit: 100_000 },
    })
    await settle()
    const before = exactTranscript(controller)
    if (!before) throw new Error('missing painted transcript')
    const publications: Array<{ exact: boolean; finalText: string | null }> = []
    const unsubscribe = controller.subscribe(() => {
      const frame = exactTranscript(controller)
      publicationOrder.push('conversation')
      publications.push({
        exact: frame !== null,
        finalText: frame ? textOf(transcriptMessages(frame).at(-1) as Message) : null,
      })
    })

    const finalized = source.put(
      {
        ...assistant,
        content: [{ type: 'output_text', text: 'canonical final response' }],
        nodeVersion: 1,
      },
      2,
    )
    presentationInterests.push({
      ...FENCE,
      streamId: 'stream-finalized-assistant',
      chatId: CHAT_ID,
      messageId: assistant.id,
    })
    controller.applyCommittedEffect(
      localCommittedEffect(source, [finalized], [finalized.header], { kind: 'none' }),
    )
    unsubscribe()

    const exact = exactTranscript(controller)
    expect(transcriptMessages(exact)).toHaveLength(before.rowCount)
    expect(textOf(transcriptMessages(exact).at(-1) as Message)).toBe('canonical final response')
    expect(publications).toEqual([{ exact: true, finalText: 'canonical final response' }])
    expect(exactPresentationReceipts).toEqual([
      {
        ...FENCE,
        streamId: 'stream-finalized-assistant',
        chatId: CHAT_ID,
        messageId: assistant.id,
        bodyVersion: 2,
      },
    ])
    expect(publicationOrder).toEqual(['conversation', 'attempt'])
    controller.setTranscriptDemand(demandOwner, null)
  })

  it('publishes one canonical terminal body to tree and retained transcript before receipt', async () => {
    const root = message('root', null, 0, 'prompt', 1)
    const assistant = message('assistant', root.id, 0, '', 2)
    const presentationInterests: TargetPresentationInterest[] = []
    const receiptObservations: Array<{
      receipts: readonly ExactTargetPresentationReceipt[]
      retainedText: string | null
      inspectorText: string | null
    }> = []
    const controllerHolder: {
      current: ReturnType<typeof createConversationController> | null
    } = { current: null }
    const targetPresentationPort: ConversationTargetPresentationPort = {
      targetPresentationInterests: () => presentationInterests,
      publishExactTargetPresentations: (receipts) => {
        const controller = controllerHolder.current
        if (!controller) throw new Error('ConversationControllerMissing')
        const active = controller.getSnapshot().active
        const resident = active?.presentation.residents.transcript
        receiptObservations.push({
          receipts,
          retainedText:
            resident?.surface === 'transcript'
              ? textOf(transcriptMessages(resident.window).at(-1) as Message)
              : null,
          inspectorText: active?.inspector.exact ? textOf(active.inspector.exact.message) : null,
        })
      },
    }
    const test = harness([root, assistant], targetPresentationPort)
    const controller = test.controller
    controllerHolder.current = controller
    const { navigation, source } = test
    navigation.arrive('arrival-1', { chatId: CHAT_ID, targetMessageId: assistant.id })
    await settle()
    const transcriptOwner = {}
    const inspectorOwner = {}
    const opened = controller.getSnapshot().active
    if (!opened) throw new Error('missing active snapshot')
    controller.setTranscriptDemand(transcriptOwner, {
      chatId: CHAT_ID,
      selectionRevision: opened.selectionRevision,
      selectionEpoch: opened.transcript.selectionEpoch,
      budget: { minimumRowCount: 10, textCharLimit: 100_000, renderCostLimit: 100_000 },
    })
    await settle()
    controller.requestPresentation({ chatId: CHAT_ID, surface: 'tree' })
    controller.setInspectorDemand(inspectorOwner, { chatId: CHAT_ID, messageId: assistant.id })
    await settle()
    expectCoherentReadyPresentation(controller.getSnapshot().active?.presentation, 'tree')

    const finalized = source.put(
      {
        ...assistant,
        content: [{ type: 'output_text', text: 'canonical terminal response' }],
        nodeVersion: 1,
      },
      2,
    )
    presentationInterests.push({
      ...FENCE,
      streamId: 'stream-tree-terminal',
      chatId: CHAT_ID,
      messageId: assistant.id,
    })
    controller.applyCommittedEffect(
      localCommittedEffect(source, [finalized], [finalized.header], { kind: 'none' }),
    )

    expect(receiptObservations).toEqual([
      {
        receipts: [
          {
            ...FENCE,
            streamId: 'stream-tree-terminal',
            chatId: CHAT_ID,
            messageId: assistant.id,
            bodyVersion: 2,
          },
        ],
        retainedText: 'canonical terminal response',
        inspectorText: 'canonical terminal response',
      },
    ])
    controller.requestPresentation({ chatId: CHAT_ID, surface: 'transcript' })
    const transcript = expectCoherentReadyPresentation(
      controller.getSnapshot().active?.presentation,
      'transcript',
    )
    expect(textOf(transcriptMessages(transcript.window).at(-1) as Message)).toBe(
      'canonical terminal response',
    )
    controller.setInspectorDemand(inspectorOwner, null)
    controller.setTranscriptDemand(transcriptOwner, null)
  })

  it.each([
    {
      name: 'paste-style reparent',
      prepare(source: TestProjectionSource, root: Message, child: Message, tip: Message) {
        const inserted = source.put(message('inserted', root.id, 0, 'inserted', 4))
        const moved = source.put({ ...child, parentId: inserted.header.id, nodeVersion: 1 })
        const tipPresentation = source.presentations.get(tip.id)
        if (!tipPresentation) throw new Error('tip presentation missing')
        return {
          receiptHeaders: [inserted.header, moved.header],
          receiptPresentations: [inserted],
          selection: source.committedSelection(tip.id, [inserted, tipPresentation]),
          expectedTipId: tip.id,
          expectedPath: [root.id, inserted.header.id, child.id, tip.id],
        }
      },
    },
    {
      name: 'delete-style fallback',
      prepare(source: TestProjectionSource, root: Message, child: Message, tip: Message) {
        const deletedChild = source.put({ ...child, deleted: true, nodeVersion: 1 })
        const deletedTip = source.put({ ...tip, deleted: true, nodeVersion: 1 })
        return {
          receiptHeaders: [deletedChild.header, deletedTip.header],
          receiptPresentations: [],
          selection: source.committedSelection(root.id),
          expectedTipId: root.id,
          expectedPath: [root.id],
        }
      },
    },
  ])('adopts $name proof with exact counts and no repository selection roundtrip', async ({
    prepare,
  }) => {
    const root = message('root', null, 0, 'root', 1)
    const child = message('child', root.id, 0, 'child', 2)
    const tip = message('tip', child.id, 0, 'tip', 3)
    const { controller, navigation, source } = harness([root, child, tip])
    navigation.arrive('arrival-1', { chatId: CHAT_ID, targetMessageId: tip.id })
    await settle()
    const prepared = prepare(source, root, child, tip)
    const selectionReadsBefore = source.openSelection.mock.calls.length
    const operation = controller.claimOperation({ chatId: CHAT_ID, steering: 'select-result' })

    expect(
      controller.acceptLocalResult(operation, {
        kind: 'select-committed',
        receipt: { ...FENCE, destination: prepared.selection },
        committedEffect: localCommittedEffect(
          source,
          prepared.receiptPresentations,
          prepared.receiptHeaders,
        ),
      }),
    ).toEqual({ accepted: true })
    await settle()

    const active = controller.getSnapshot().active
    expect(presentedSpine(controller).path.materializeIds()).toEqual(prepared.expectedPath)
    expect(presentedSpine(controller).resolvedLeafId).toBe(prepared.expectedTipId)
    expect(active?.destination.kind).toBe('ready')
    expect(active?.presentation.target.kind).toBe('ready')
    expect(presentedSpine(controller).forkFor(prepared.expectedTipId)?.liveCount).toBe(1)
    expect(navigation.replacements.at(-1)?.targetMessageId).toBe(prepared.expectedTipId)
    expect(source.openSelection).toHaveBeenCalledTimes(selectionReadsBefore)
  })

  it('adopts exact local send and regenerate selections without a spine reread', async () => {
    const root = message('root', null, 0, 'root', 1)
    const firstAssistant = message('assistant-1', root.id, 0, 'first answer', 2)
    const secondUser = message('user-2', firstAssistant.id, 0, 'second prompt', 3)
    const secondAssistant = message('assistant-2', secondUser.id, 0, 'second answer', 4)
    const { controller, navigation, source } = harness([
      root,
      firstAssistant,
      secondUser,
      secondAssistant,
    ])
    navigation.arrive('arrival-1', {
      chatId: CHAT_ID,
      targetMessageId: secondAssistant.id,
    })
    await settle()
    const demandOwner = {}
    const opened = controller.getSnapshot().active
    if (!opened) throw new Error('missing active snapshot')
    controller.setTranscriptDemand(demandOwner, {
      chatId: CHAT_ID,
      selectionRevision: opened.selectionRevision,
      selectionEpoch: opened.transcript.selectionEpoch,
      budget: { minimumRowCount: 10, textCharLimit: 100_000, renderCostLimit: 100_000 },
    })
    await settle()

    const publishedFrames: Array<{
      selectionRevision: number
      pathLeafId: MessageId | null
      pathLength: number
      frameLeafId: MessageId | null
      frameBranchLength: number
      ids: MessageId[]
      visibleSurface: ConversationSurface | null
      visibleSelectionRevision: number | null
      routeLeafId: MessageId | null
    }> = []
    const unsubscribe = controller.subscribe(() => {
      const active = controller.getSnapshot().active
      const frame = projectedTranscript(controller)
      if (!active || !frame) return
      const spine = presentedSpine(controller)
      publishedFrames.push({
        selectionRevision: active.selectionRevision,
        pathLeafId: spine.path.leaf?.id ?? null,
        pathLength: spine.path.length,
        frameLeafId: frame.leafId,
        frameBranchLength: frame.branchLength,
        ids: [...transcriptMessages(frame)].map((row) => row.id),
        visibleSurface: active.presentation.painted?.binding.surface ?? null,
        visibleSelectionRevision:
          active.presentation.painted?.binding.seal.selectionRevision ?? null,
        routeLeafId: navigation.replacements.at(-1)?.targetMessageId ?? null,
      })
    })
    const selectionReadsBeforeSend = source.openSelection.mock.calls.length
    const thirdUser = source.put(message('user-3', secondAssistant.id, 0, 'third prompt', 5))
    const thirdAssistant = source.put(message('assistant-3', thirdUser.header.id, 0, '', 6))
    const sendOperation = controller.claimOperation({
      chatId: CHAT_ID,
      steering: 'select-result',
    })
    expect(
      controller.acceptLocalResult(sendOperation, {
        kind: 'select-committed',
        receipt: {
          ...FENCE,
          destination: source.committedSelection(thirdAssistant.header.id, [
            thirdUser,
            thirdAssistant,
          ]),
        },
        committedEffect: localCommittedEffect(source, [thirdUser, thirdAssistant]),
      }),
    ).toEqual({ accepted: true })

    expect(transcriptMessages(exactTranscript(controller)).map((row) => row.id)).toEqual([
      root.id,
      firstAssistant.id,
      secondUser.id,
      secondAssistant.id,
      thirdUser.header.id,
      thirdAssistant.header.id,
    ])
    expect(presentedSpine(controller)).toMatchObject({
      resolvedLeafId: thirdAssistant.header.id,
      path: { length: 6, leaf: { id: thirdAssistant.header.id } },
    })
    expect(exactTranscript(controller)).toMatchObject({
      leafId: thirdAssistant.header.id,
      branchLength: 6,
      offset: 0,
    })
    const sentBinding = expectCoherentReadyPresentation(
      controller.getSnapshot().active?.presentation,
      'transcript',
    )
    expect(sentBinding.seal.leafId).toBe(thirdAssistant.header.id)
    expect(navigation.replacements.at(-1)?.targetMessageId).toBe(thirdAssistant.header.id)
    const priorSendPath = [root.id, firstAssistant.id, secondUser.id, secondAssistant.id]
    const provisionalSendPath = [...priorSendPath, thirdUser.header.id, thirdAssistant.header.id]
    expect(publishedFrames.length).toBeGreaterThan(0)
    expect(
      publishedFrames.every(
        (publication) =>
          sameMessageIds(publication.ids, priorSendPath) ||
          (publication.pathLeafId === thirdAssistant.header.id &&
            sameMessageIds(publication.ids, provisionalSendPath)),
      ),
    ).toBe(true)
    expect(
      publishedFrames.every(
        (publication) =>
          publication.pathLeafId === publication.frameLeafId &&
          publication.pathLeafId === publication.routeLeafId &&
          publication.pathLength === publication.frameBranchLength &&
          (publication.visibleSurface === null ||
            (publication.visibleSurface === 'transcript' &&
              publication.visibleSelectionRevision === publication.selectionRevision)),
      ),
    ).toBe(true)

    await settle()
    expect(source.openSelection).toHaveBeenCalledTimes(selectionReadsBeforeSend)
    expect(transcriptMessages(exactTranscript(controller)).map((row) => row.id)).toEqual([
      root.id,
      firstAssistant.id,
      secondUser.id,
      secondAssistant.id,
      thirdUser.header.id,
      thirdAssistant.header.id,
    ])
    const selectionReadsBeforeRegenerate = source.openSelection.mock.calls.length
    const regenerated = source.put(message('assistant-4', thirdUser.header.id, 1, 'replacement', 8))
    publishedFrames.length = 0
    const regenerateOperation = controller.claimOperation({
      chatId: CHAT_ID,
      steering: 'select-result',
    })
    expect(
      controller.acceptLocalResult(regenerateOperation, {
        kind: 'select-committed',
        receipt: {
          ...FENCE,
          destination: source.committedSelection(regenerated.header.id, [regenerated]),
        },
        committedEffect: localCommittedEffect(source, [regenerated]),
      }),
    ).toEqual({ accepted: true })
    expect(transcriptMessages(exactTranscript(controller)).map((row) => row.id)).toEqual([
      root.id,
      firstAssistant.id,
      secondUser.id,
      secondAssistant.id,
      thirdUser.header.id,
      regenerated.header.id,
    ])
    const priorRegeneratePath = provisionalSendPath
    const provisionalRegeneratePath = [
      root.id,
      firstAssistant.id,
      secondUser.id,
      secondAssistant.id,
      thirdUser.header.id,
      regenerated.header.id,
    ]
    expect(publishedFrames.length).toBeGreaterThan(0)
    expect(
      publishedFrames.every(
        (publication) =>
          sameMessageIds(publication.ids, priorRegeneratePath) ||
          (publication.pathLeafId === regenerated.header.id &&
            sameMessageIds(publication.ids, provisionalRegeneratePath)),
      ),
    ).toBe(true)
    expect(
      publishedFrames.every(
        (publication) =>
          publication.pathLeafId === publication.frameLeafId &&
          publication.pathLeafId === publication.routeLeafId &&
          publication.pathLength === publication.frameBranchLength &&
          (publication.visibleSurface === null ||
            (publication.visibleSurface === 'transcript' &&
              publication.visibleSelectionRevision === publication.selectionRevision)),
      ),
    ).toBe(true)
    expect(navigation.replacements.at(-1)?.targetMessageId).toBe(regenerated.header.id)

    await settle()
    expect(source.openSelection).toHaveBeenCalledTimes(selectionReadsBeforeRegenerate)
    unsubscribe()
    controller.setTranscriptDemand(demandOwner, null)
  })

  it('keeps a mounted local tail monotonic when regenerate replaces its last row', async () => {
    const rows: Message[] = []
    for (let index = 0; index < 14; index += 1) {
      rows.push(message(`tail-${index}`, rows.at(-1)?.id ?? null, 0, `tail ${index}`, index + 1))
    }
    const { controller, navigation, source } = harness(rows)
    const initialTipId = rows.at(-1)?.id
    if (!initialTipId) throw new Error('missing initial tail tip')
    navigation.arrive('arrival-tail', {
      chatId: CHAT_ID,
      targetMessageId: initialTipId,
    })
    await settle()
    const demandOwner = {}
    const budget = { minimumRowCount: 10, textCharLimit: 1, renderCostLimit: 1 }
    const demandCurrentSelection = () => {
      const active = controller.getSnapshot().active
      if (!active) throw new Error('missing active tail selection')
      controller.setTranscriptDemand(demandOwner, {
        chatId: CHAT_ID,
        selectionRevision: active.selectionRevision,
        selectionEpoch: active.transcript.selectionEpoch,
        budget,
      })
    }
    demandCurrentSelection()
    await settle()
    expect(transcriptMessages(exactTranscript(controller))).toHaveLength(10)

    const user = source.put(message('tail-user', rows.at(-1)?.id ?? null, 0, 'prompt', 15))
    const assistant = source.put(message('tail-assistant', user.header.id, 0, '', 16))
    const sendOperation = controller.claimOperation({ chatId: CHAT_ID, steering: 'select-result' })
    expect(
      controller.acceptLocalResult(sendOperation, {
        kind: 'select-committed',
        receipt: {
          ...FENCE,
          destination: source.committedSelection(assistant.header.id, [user, assistant]),
        },
        committedEffect: localCommittedEffect(source, [user, assistant]),
      }),
    ).toEqual({ accepted: true })
    demandCurrentSelection()
    await settle()
    expect(transcriptMessages(exactTranscript(controller)).map((row) => row.id)).toEqual([
      ...rows.slice(-10).map((row) => row.id),
      user.header.id,
      assistant.header.id,
    ])

    const regenerated = source.put(message('tail-regenerated', user.header.id, 1, '', 18))
    const regenerateOperation = controller.claimOperation({
      chatId: CHAT_ID,
      steering: 'select-result',
    })
    expect(
      controller.acceptLocalResult(regenerateOperation, {
        kind: 'select-committed',
        receipt: {
          ...FENCE,
          destination: source.committedSelection(regenerated.header.id, [regenerated]),
        },
        committedEffect: localCommittedEffect(source, [regenerated]),
      }),
    ).toEqual({ accepted: true })
    demandCurrentSelection()
    await settle()
    const regeneratedBody = source.put(
      {
        ...regenerated.message,
        content: [{ type: 'output_text', text: 'streamed replacement' }],
        nodeVersion: regenerated.message.nodeVersion + 1,
      },
      regenerated.bodyVersion + 1,
    )
    controller.applyCommittedEffect(
      localCommittedEffect(source, [regeneratedBody], [regeneratedBody.header], { kind: 'none' }),
    )
    expect(transcriptMessages(exactTranscript(controller)).map((row) => row.id)).toEqual([
      ...rows.slice(-10).map((row) => row.id),
      user.header.id,
      regenerated.header.id,
    ])
    controller.setTranscriptDemand(demandOwner, null)
  })

  it('rebases local bodies onto newer metadata but rejects a changed body version', async () => {
    const root = message('root', null, 0, 'body', 1)
    const { controller, navigation, source } = harness([root])
    navigation.arrive('arrival-1', { chatId: CHAT_ID, targetMessageId: root.id })
    await settle()
    const exact = source.presentations.get(root.id)
    if (!exact) throw new Error('missing exact presentation')
    controller.applyCommittedEffect(
      localCommittedEffect(source, [exact], [exact.header], { kind: 'none' }),
    )
    const current = expectCoherentReadyPresentation(
      controller.getSnapshot().active?.presentation,
      'transcript',
    )

    controller.applyCommittedEffect({
      ...FENCE,
      chatId: CHAT_ID,
      source: 'remote',
      kind: 'changed',
      structural: {
        kind: 'exact-delta',
        toVersion: 2,
        structuralVersions: [2],
        messageIds: [root.id],
      },
      revisions: [
        {
          header: { ...exact.header, nodeVersion: 2, siblingIndex: 3 },
          structuralVersion: 2,
        },
      ],
    })
    expect(controller.getSnapshot().active?.headerFacts.get(root.id)?.siblingIndex).toBe(3)
    const retained = controller.getSnapshot().active?.presentation.painted?.binding
    expect(retained).not.toBe(current)
    expect(retained).toMatchObject({ surface: 'transcript', currency: 'retained' })
    if (!retained) throw new Error('missing retained presentation')
    if (retained.surface !== 'transcript') throw new Error('missing retained transcript surface')
    expect([...transcriptBodyWindowRows(retained.window)][0]).toMatchObject({
      bodyVersion: 1,
      bodyExact: true,
    })

    let releaseRecovery!: () => void
    source.selectionCompletionGate = new Promise<void>((resolve) => {
      releaseRecovery = resolve
    })
    const recovered = presentation(
      {
        ...root,
        siblingIndex: 3,
        nodeVersion: 3,
        content: [{ type: 'text', text: 'body v2' }],
      },
      2,
    )
    const newerHeader = recovered.header
    controller.applyCommittedEffect({
      ...FENCE,
      chatId: CHAT_ID,
      source: 'remote',
      kind: 'changed',
      structural: { kind: 'none' },
      revisions: [
        {
          header: newerHeader,
          structuralVersion: 2,
        },
      ],
    })
    const pending = controller.getSnapshot().active?.presentation
    expect(pending?.painted?.binding).toBe(retained)
    expect(pending?.painted?.binding.currency).toBe('retained')
    expect(pending?.painted?.binding.reveal).toBeNull()
    expect(pending?.target).toMatchObject({
      kind: 'pending',
      surface: 'transcript',
      blocker: 'destination',
    })
    expect([...transcriptBodyWindowRows(retained.window)][0]).toMatchObject({
      bodyVersion: 1,
      bodyExact: true,
    })

    const storedRecovery = source.put(recovered.message, recovered.bodyVersion)
    expect(storedRecovery.header).toEqual(newerHeader)
    releaseRecovery()
    source.selectionCompletionGate = null
    await settle()

    const ready = controller.getSnapshot().active?.presentation
    const visible = expectCoherentReadyPresentation(ready, 'transcript')
    expect(visible).not.toBe(retained)
    expect([...transcriptBodyWindowRows(visible.window)][0]).toMatchObject({
      bodyVersion: 2,
      bodyExact: true,
      message: { content: [{ type: 'text', text: 'body v2' }] },
    })
  })

  it('fences stale local receipts and active reads across workspace replacement', async () => {
    const root = message('root', null, 0, 'body', 1)
    const { controller, navigation, source } = harness([root])
    navigation.arrive('arrival-1', { chatId: CHAT_ID, targetMessageId: root.id })
    await settle()
    const exact = source.presentations.get(root.id)
    if (!exact) throw new Error('missing exact presentation')

    controller.reconcileWorkspace({ workspaceId: 'workspace-b', replacementEpoch: 1 })
    controller.applyCommittedEffect(
      localCommittedEffect(source, [exact], [exact.header], { kind: 'none' }),
    )
    expect(controller.getSnapshot().workspaceId).toBe('workspace-b')
    expect(controller.getSnapshot().active?.headerFacts.get(root.id)).toBeUndefined()
  })

  it('retains the painted route without an empty publication across a same-workspace epoch', async () => {
    const root = message('root', null, 0, 'body', 1)
    const { controller, navigation } = harness([root])
    navigation.arrive('arrival-1', { chatId: CHAT_ID, targetMessageId: root.id })
    await settle()
    const current = expectCoherentReadyPresentation(
      controller.getSnapshot().active?.presentation,
      'transcript',
    )
    const publications: Array<{ activeChatId: ChatId | null; active: boolean }> = []
    const unsubscribe = controller.subscribe(() => {
      const snapshot = controller.getSnapshot()
      publications.push({
        activeChatId: snapshot.activeChatId,
        active: snapshot.active !== null,
      })
    })

    controller.setProjectionSource(null)
    controller.reconcileWorkspace({ workspaceId: FENCE.workspaceId, replacementEpoch: 1 })
    unsubscribe()

    expect(publications.length).toBeGreaterThan(0)
    expect(publications).toEqual(publications.map(() => ({ activeChatId: CHAT_ID, active: true })))
    const retained = expectRetainedPresentation(
      controller.getSnapshot().active?.presentation,
      current,
    )
    expect(retained.seal.replacementEpoch).toBe(FENCE.replacementEpoch)
    expect(controller.getSnapshot()).toMatchObject({
      workspaceId: FENCE.workspaceId,
      workspaceEpoch: 1,
      activeChatId: CHAT_ID,
    })
  })

  it('does not publish a smaller painted transcript while a same-workspace replacement refills it', async () => {
    const root = message('root', null, 0, 'root', 1)
    const reply = message('reply', root.id, 0, 'reply', 2)
    const { controller, navigation, source } = harness([root, reply])
    navigation.arrive('arrival-1', { chatId: CHAT_ID, targetMessageId: reply.id })
    await settle()
    expect(
      transcriptMessages(
        expectCoherentReadyPresentation(controller.getSnapshot().active?.presentation, 'transcript')
          .window,
      ),
    ).toHaveLength(2)

    const paintedRowCounts: number[] = []
    const unsubscribe = controller.subscribe(() => {
      const binding = controller.getSnapshot().active?.presentation.painted?.binding
      if (binding?.surface === 'transcript' && binding.seal.chatId === CHAT_ID) {
        paintedRowCounts.push([...transcriptBodyWindowRows(binding.window)].length)
      }
    })
    source.workspaceFence = { workspaceId: FENCE.workspaceId, replacementEpoch: 1 }
    controller.reconcileWorkspace(source.workspaceFence)
    await settle()
    unsubscribe()

    expect(paintedRowCounts.length).toBeGreaterThan(0)
    expect(paintedRowCounts).not.toContain(1)
    expect(paintedRowCounts.at(-1)).toBe(2)
  })

  it('surfaces repository selection failures once without a timer retry loop', async () => {
    vi.useFakeTimers()
    const root = message('root', null, 0, 'body', 1)
    const { controller, navigation, source } = harness([root])
    const timeout = vi.spyOn(globalThis, 'setTimeout')
    source.openSelection.mockRejectedValue(new Error('repository unavailable'))

    navigation.arrive('arrival-1', { chatId: CHAT_ID, targetMessageId: root.id })
    await settle()

    expect(source.openSelection).toHaveBeenCalledOnce()
    expect(controller.getSnapshot().active?.failure).toMatchObject({
      kind: 'selection',
      code: 'read-failed',
    })
    expectNoControllerTimers(timeout)

    await vi.advanceTimersByTimeAsync(60_000)
    await settle()
    expect(source.openSelection).toHaveBeenCalledOnce()
  })

  it('rereads a stale selection once after a newer authoritative observation', async () => {
    const root = message('root', null, 0, 'body', 1)
    const { controller, navigation, source } = harness([root])
    const selection = { kind: 'message', messageId: root.id } as const
    const target: ConversationSelectionProofTarget = {
      kind: 'resolve-selection',
      selection,
    }
    const stale = Object.freeze({
      ...FENCE,
      value: Object.freeze({
        kind: 'stale' as const,
        chat: structuredClone(source.currentChat),
        target,
        retryTarget: target,
      }),
    })
    const newer = { ...root, nodeVersion: 1 }
    const newerPresentation = presentation(newer)
    source.presentations.set(root.id, newerPresentation)
    source.currentChat = { ...source.currentChat, metaVersion: 1 }
    const fresh = await source.openSelection(
      CHAT_ID,
      target,
      undefined,
      new AbortController().signal,
    )
    source.openSelection.mockReset()
    source.openSelection.mockResolvedValueOnce(stale).mockResolvedValue(fresh)

    navigation.arrive('arrival-1', { chatId: CHAT_ID, targetMessageId: root.id })
    controller.applyCommittedEffect({
      ...FENCE,
      chatId: CHAT_ID,
      source: 'remote',
      kind: 'changed',
      structural: { kind: 'none' },
      revisions: [
        {
          header: newerPresentation.header,
          structuralVersion: source.currentChat.structuralVersion,
        },
      ],
    })
    await settle()

    expect(source.openSelection).toHaveBeenCalledTimes(2)
    expect(presentedSpine(controller).path.leaf?.nodeVersion).toBe(1)
    expect(controller.getSnapshot().active?.failure).toBeNull()
  })

  it('blocks a repeated stale selection at one attempt per observed revision', async () => {
    vi.useFakeTimers()
    const root = message('root', null, 0, 'body', 1)
    const { controller, navigation, source } = harness([root])
    const selection = { kind: 'message', messageId: root.id } as const
    const target: ConversationSelectionProofTarget = {
      kind: 'resolve-selection',
      selection,
    }
    const staleReady = await source.openSelection(
      CHAT_ID,
      target,
      undefined,
      new AbortController().signal,
    )
    const newerPresentation = presentation({ ...root, nodeVersion: 1, siblingIndex: 1 })
    source.presentations.set(root.id, newerPresentation)
    source.currentChat = {
      ...source.currentChat,
      structuralVersion: source.currentChat.structuralVersion + 1,
    }
    const stale = Object.freeze({
      ...FENCE,
      value: Object.freeze({
        kind: 'stale' as const,
        chat: { ...source.currentChat, structuralVersion: 1 },
        target,
        retryTarget: target,
      }),
    })
    source.openSelection.mockReset()
    source.openSelection.mockResolvedValueOnce(stale).mockResolvedValue(staleReady)
    const timeout = vi.spyOn(globalThis, 'setTimeout')

    navigation.arrive('arrival-1', { chatId: CHAT_ID, targetMessageId: root.id })
    controller.applyCommittedEffect({
      ...FENCE,
      chatId: CHAT_ID,
      source: 'remote',
      kind: 'changed',
      structural: {
        kind: 'exact-delta',
        toVersion: source.currentChat.structuralVersion,
        structuralVersions: [source.currentChat.structuralVersion],
        messageIds: [newerPresentation.header.id],
      },
      revisions: [
        {
          header: newerPresentation.header,
          structuralVersion: source.currentChat.structuralVersion,
        },
      ],
    })
    await settle()

    expect(source.openSelection).toHaveBeenCalledTimes(2)
    expect(controller.getSnapshot().active?.failure).toMatchObject({
      kind: 'selection',
      code: 'source-invariant',
    })
    expectNoControllerTimers(timeout)

    await vi.advanceTimersByTimeAsync(60_000)
    await settle()
    expect(source.openSelection).toHaveBeenCalledTimes(2)
  })

  it('treats an unavailable default selection as terminal instead of fallback recursion', async () => {
    vi.useFakeTimers()
    const { controller, navigation, source } = harness([])
    const timeout = vi.spyOn(globalThis, 'setTimeout')
    source.openSelection.mockImplementation(async (_chatId, target) => ({
      ...FENCE,
      value: {
        kind: 'unavailable',
        chat: structuredClone(source.currentChat),
        target,
        reason: 'message-missing',
      },
    }))

    navigation.arrive('arrival-1', { chatId: CHAT_ID })
    await settle()

    expect(source.openSelection).toHaveBeenCalledOnce()
    expect(controller.getSnapshot().active?.failure).toMatchObject({
      kind: 'selection',
      code: 'source-invariant',
    })
    expectNoControllerTimers(timeout)

    await vi.advanceTimersByTimeAsync(60_000)
    await settle()
    expect(source.openSelection).toHaveBeenCalledOnce()
  })

  it('waits for a newer observation before retrying a malformed transcript page', async () => {
    vi.useFakeTimers()
    const root = message('root', null, 0, 'root', 1)
    const leaf = message('leaf', root.id, 0, 'leaf', 2)
    const { controller, navigation, source } = harness([root, leaf])
    navigation.arrive('arrival-1', { chatId: CHAT_ID, targetMessageId: leaf.id })
    await settle()
    source.loadTranscriptPage.mockClear()
    source.loadTranscriptPage.mockImplementationOnce(
      async (_chatId, _leafId, structuralVersion, window) => ({
        ...FENCE,
        value: {
          kind: 'ready',
          structuralVersion,
          page: {
            chatId: CHAT_ID,
            leafId: 'wrong-leaf',
            branchLength: window.branchLength,
            offset: window.offset,
            headers: [],
            messages: [],
          },
          material: [],
        },
      }),
    )
    const timeout = vi.spyOn(globalThis, 'setTimeout')
    const active = controller.getSnapshot().active
    if (!active) throw new Error('missing active snapshot')

    controller.applyCommittedEffect({
      ...FENCE,
      chatId: CHAT_ID,
      source: 'invalidation',
      kind: 'changed',
      structural: { kind: 'none' },
      refresh: { bodies: true },
    })
    controller.setTranscriptDemand(
      {},
      {
        chatId: CHAT_ID,
        selectionRevision: active.selectionRevision,
        selectionEpoch: active.transcript.selectionEpoch,
        budget: { minimumRowCount: 2, textCharLimit: 10_000, renderCostLimit: 10_000 },
      },
    )
    await settle()

    expect(source.loadTranscriptPage).toHaveBeenCalledOnce()
    expect(controller.getSnapshot().active?.failure).toMatchObject({
      kind: 'transcript',
      code: 'source-invariant',
    })
    expectNoControllerTimers(timeout)

    await vi.advanceTimersByTimeAsync(60_000)
    await settle()
    expect(source.loadTranscriptPage).toHaveBeenCalledOnce()

    controller.applyCommittedEffect({
      ...FENCE,
      chatId: CHAT_ID,
      source: 'invalidation',
      kind: 'changed',
      structural: { kind: 'none' },
      refresh: { bodies: true },
    })
    await settle()

    expect(source.loadTranscriptPage).toHaveBeenCalledTimes(3)
    expect(
      source.loadTranscriptPage.mock.calls.slice(1).map((call) => ({
        offset: call[3].offset,
        messageIds: call[3].nodes.map((header) => header.id),
      })),
    ).toEqual([
      { offset: 1, messageIds: [leaf.id] },
      { offset: 0, messageIds: [root.id] },
    ])
    expect(controller.getSnapshot().active?.failure).toBeNull()
    expect(transcriptMessages(exactTranscript(controller)).map((row) => row.id)).toEqual([
      root.id,
      leaf.id,
    ])
  })

  it('keeps transcript, tree, inspector, and preview demand separate and bounded', async () => {
    const root = message('root', null, 0, 'root body', 1)
    const leaf = message('leaf', root.id, 0, 'leaf body', 2)
    const { controller, navigation, source } = harness([root, leaf])
    navigation.arrive('arrival-1', { chatId: CHAT_ID, targetMessageId: leaf.id })
    await settle()
    const active = controller.getSnapshot().active
    if (!active) throw new Error('missing active snapshot')
    const transcriptOwner = {}
    const inspectorOwner = {}
    const previewOwner = {}
    controller.setTranscriptDemand(transcriptOwner, {
      chatId: CHAT_ID,
      selectionRevision: active.selectionRevision,
      selectionEpoch: active.transcript.selectionEpoch,
      budget: { minimumRowCount: 1, textCharLimit: 100, renderCostLimit: 100 },
    })
    controller.requestPresentation({ chatId: CHAT_ID, surface: 'tree' })
    controller.setInspectorDemand(inspectorOwner, { chatId: CHAT_ID, messageId: root.id })
    controller.setTreePreviewDemand(previewOwner, {
      chatId: CHAT_ID,
      targets: [{ messageId: leaf.id, bodyVersion: 1 }],
    })
    await settle()

    const next = controller.getSnapshot().active
    expect(transcriptMessages(exactTranscript(controller)).map((row) => row.id)).toEqual([
      'root',
      'leaf',
    ])
    expect(next?.topologyLoaded).toBe(true)
    expect(next?.presentation.target.kind).toBe('ready')
    expect(next?.inspector.exact?.message.id).toBe(root.id)
    expect(next?.previews.get(leaf.id)?.text).toBe('leaf body')
    expect(source.loadPreviews).not.toHaveBeenCalled()
  })

  it('releases exact bodies when a demand owner leaves without changing selection', async () => {
    const root = message('root', null, 0, 'root', 1)
    const leaf = message('leaf', root.id, 0, 'leaf', 2)
    const { controller, navigation } = harness([root, leaf])
    navigation.arrive('arrival-1', { chatId: CHAT_ID, targetMessageId: leaf.id })
    await settle()
    const active = controller.getSnapshot().active
    if (!active) throw new Error('missing active snapshot')
    const owner = {}
    controller.setInspectorDemand(owner, { chatId: CHAT_ID, messageId: root.id })
    await settle()
    expect(controller.getSnapshot().active?.inspector.exact?.message.id).toBe(root.id)

    controller.setInspectorDemand(owner, null)
    await settle()
    expect(controller.getSnapshot().active?.inspector.exact).toBeNull()
    expect(presentedSpine(controller).path.leaf?.id).toBe(leaf.id)
  })

  it('keeps branch counts local to indexed fork refreshes without enumerating unrelated bodies', async () => {
    const root = message('root', null, 0, 'root', 1)
    const left = message('left', root.id, 0, 'left', 2)
    const right = message('right', root.id, 1, 'right', 4)
    const { controller, navigation, source } = harness([root, left, right])
    navigation.arrive('arrival-1', { chatId: CHAT_ID, targetMessageId: left.id })
    await settle()
    expect(presentedSpine(controller).forkFor(left.id)).toMatchObject({
      position: 0,
      liveCount: 2,
      nextMessageId: right.id,
    })

    const third = source.put(message('third', root.id, 2, 'third', 6))
    controller.applyCommittedEffect({
      ...FENCE,
      chatId: CHAT_ID,
      source: 'remote',
      kind: 'changed',
      structural: {
        kind: 'exact-delta',
        toVersion: source.currentChat.structuralVersion,
        structuralVersions: [source.currentChat.structuralVersion],
        messageIds: [third.header.id],
      },
      revisions: [
        {
          header: third.header,
          structuralVersion: source.currentChat.structuralVersion,
          presentation: third,
        },
      ],
      refresh: { forkParentIds: [root.id] },
    })
    await settle()
    expect(presentedSpine(controller).forkFor(left.id)?.liveCount).toBe(3)
    expect(source.loadInspector).not.toHaveBeenCalled()
    expect(source.loadPreviews).not.toHaveBeenCalled()
  })

  it('loads forks for every parent admitted by the first demanded transcript window', async () => {
    const root = message('root', null, 0, 'root', 1)
    const left = message('left', root.id, 0, 'left', 2)
    const leftTip = message('left-tip', left.id, 0, 'left tip', 3)
    const right = message('right', root.id, 1, 'right', 4)
    const rightTip = message('right-tip', right.id, 0, 'right tip', 5)
    const { controller, navigation, source } = harness([root, left, leftTip, right, rightTip])
    let releaseInitialForks = () => {}
    source.forkCompletionGate = new Promise<void>((resolve) => {
      releaseInitialForks = resolve
    })
    navigation.arrive('arrival-1', { chatId: CHAT_ID, targetMessageId: leftTip.id })
    await settle()
    const owner = {}
    const active = controller.getSnapshot().active
    if (!active) throw new Error('missing active snapshot')
    controller.setTranscriptDemand(owner, {
      chatId: CHAT_ID,
      selectionRevision: active.selectionRevision,
      selectionEpoch: active.transcript.selectionEpoch,
      budget: { minimumRowCount: 3, textCharLimit: 100_000, renderCostLimit: 100_000 },
    })
    await settle()
    releaseInitialForks()
    source.forkCompletionGate = null
    await settle()

    expect(transcriptMessages(exactTranscript(controller)).map((row) => row.id)).toEqual([
      root.id,
      left.id,
      leftTip.id,
    ])
    expect(presentedSpine(controller).forkFor(left.id)).toMatchObject({
      position: 0,
      liveCount: 2,
      nextMessageId: right.id,
    })
    expect(
      source.loadForks.mock.calls.some(([, , targets]) =>
        targets.some((target) => target.parentId === root.id),
      ),
    ).toBe(true)
    controller.setTranscriptDemand(owner, null)
  })
})
