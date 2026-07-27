import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  browserConversationNavigationPort,
  navigate,
  subscribeRouteArrival,
} from '../../src/app/router'
import type {
  ActiveBranchForkSlot,
  ActiveBranchForkTarget,
  ActiveBranchSelection,
  VersionedActiveBranchSpine,
} from '../../src/core/active-branch-spine'
import { emptyActiveBranchChildSlot } from '../../src/core/active-branch-spine'
import type { BranchPathWindow } from '../../src/core/branch-session'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type {
  ConversationDestinationPoint,
  ConversationProvedSelection,
  ConversationSelectionProofTarget,
} from '../../src/core/messages'
import { sealConversationSelection } from '../../src/core/messages'
import type { Chat, ChatId, Message, MessageId } from '../../src/core/types'
import {
  type ConversationCommittedEffect,
  type ConversationController,
  type ConversationCurrentSurfaceBinding,
  type ConversationPresentationResourcePort,
  type ConversationProjectionOpenResult,
  type ConversationProjectionSource,
  type ConversationReadEnvelope,
  type ConversationStructuralTransition,
  type ConversationSurface,
  type ConversationTranscriptPage,
  type ConversationViewportPort,
  createConversationController,
  type MessageTextPreview,
  type TreePreviewTarget,
} from '../../src/store/conversation-controller'
import { type MessageHeaderRow, splitMessageForStorage } from '../../src/store/message-storage'
import type {
  ConversationForksResult,
  ConversationTopologyResult,
} from '../../src/store/workspace-protocol'
import { testChildSlotsForHeaders } from '../helpers/message-storage'

const FENCE: Readonly<{ workspaceId: string; replacementEpoch: number }> = Object.freeze({
  workspaceId: 'router-controller-workspace',
  replacementEpoch: 0,
})
const CHAT_ID = 'chat-a'
const controllers = new Set<ConversationController>()

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((next, fail) => {
    resolve = next
    reject = fail
  })
  return { promise, resolve, reject }
}

function message(
  id: string,
  parentId: string | null,
  siblingIndex: number,
  createdAt: number,
): Message {
  const role = parentId === null ? 'user' : 'assistant'
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

function presentation(row: Message) {
  const split = splitMessageForStorage(row)
  return { header: split.header, message: row, bodyVersion: split.header.bodyVersion }
}

function sealTestSelection(selection: ConversationProvedSelection) {
  return sealConversationSelection(selection)
}

class ProjectionSource implements ConversationProjectionSource {
  readonly rows = new Map<MessageId, ReturnType<typeof presentation>>()
  currentChat = chat(null)
  currentFence = FENCE
  readonly selectionSignals: AbortSignal[] = []
  readonly openSelection = vi.fn(this.readSelection.bind(this))
  readonly loadChat = vi.fn(async () => this.envelope(structuredClone(this.currentChat)))
  readonly loadForks = vi.fn(
    async (
      _chatId: ChatId,
      structuralVersion: number,
      targets: readonly ActiveBranchForkTarget[],
    ): Promise<ConversationReadEnvelope<ConversationForksResult>> =>
      this.envelope({
        kind: 'ready',
        structuralVersion,
        forks: targets.map((target) => this.forkFor(target.selectedMessageId)),
      }),
  )
  readonly loadChildAtPosition = vi.fn(
    async (_chatId: ChatId, parentId: MessageId | null, position: number) =>
      this.envelope(this.children(parentId)[position]?.header.id ?? null),
  )
  readonly loadTopology = vi.fn(
    async (): Promise<ConversationReadEnvelope<ConversationTopologyResult>> => {
      const headers = [...this.rows.values()].map((row) => row.header)
      return this.envelope({
        kind: 'ready',
        chat: structuredClone(this.currentChat),
        structuralVersion: this.currentChat.structuralVersion,
        headers,
        childSlots: testChildSlotsForHeaders(CHAT_ID, headers),
      })
    },
  )
  readonly loadTranscriptPage = vi.fn(
    async (
      _chatId: ChatId,
      leafId: MessageId,
      structuralVersion: number,
      window: BranchPathWindow<MessageHeaderRow>,
    ) => {
      const path = this.pathTo(leafId)
      return this.envelope({
        kind: 'ready',
        structuralVersion,
        page: this.page(
          path,
          path.slice(window.offset, window.offset + window.nodes.length),
          window.offset,
        ),
        material: path.slice(window.offset, window.offset + window.nodes.length).map((row) => row),
      } as const)
    },
  )
  readonly loadInspector = vi.fn(async () => this.envelope(null))
  readonly loadPreviews = vi.fn(async (_chatId: ChatId, _targets: readonly TreePreviewTarget[]) =>
    this.envelope([] satisfies MessageTextPreview[]),
  )

  seed(rows: readonly Message[], defaultLeafId: MessageId | null = rows.at(-1)?.id ?? null): void {
    this.rows.clear()
    for (const row of rows) this.rows.set(row.id, presentation(row))
    this.currentChat = chat(defaultLeafId)
  }

  put(row: Message): ReturnType<typeof presentation> {
    const previous = this.rows.get(row.id)
    const structuralChanged =
      !previous ||
      previous.header.parentId !== row.parentId ||
      previous.header.siblingIndex !== row.siblingIndex ||
      previous.header.deleted !== row.deleted
    const next = presentation(row)
    this.rows.set(row.id, next)
    this.currentChat = {
      ...this.currentChat,
      lastUpdatedLeafId: row.id,
      lastBranchUpdatedAt: Math.max(this.currentChat.lastBranchUpdatedAt, row.createdAt),
      metaVersion: this.currentChat.metaVersion + 1,
      structuralVersion: this.currentChat.structuralVersion + (structuralChanged ? 1 : 0),
    }
    return next
  }

  committedSelection(tipId: MessageId | null): ConversationProvedSelection {
    const path = tipId === null ? [] : this.pathTo(tipId)
    const tip = tipId === null ? null : this.rows.get(tipId)
    if (tipId !== null && !tip) throw new Error(`missing committed tip ${tipId}`)
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
        chatId: CHAT_ID,
        structuralVersion: this.currentChat.structuralVersion,
        tipId,
        pathHeaders: path.map((row) => row.header),
      },
      presentations: tip ? [tip] : [],
      forks: path.map((row) => this.forkFor(row.header.id)),
      terminalChildSlot: emptyActiveBranchChildSlot(tipId),
    }
  }

  async readSelection(
    _chatId: ChatId,
    target: ConversationSelectionProofTarget,
    onPoint: ((point: ConversationReadEnvelope<ConversationDestinationPoint>) => void) | undefined,
    signal: AbortSignal,
  ): Promise<ConversationReadEnvelope<ConversationProjectionOpenResult>> {
    this.selectionSignals.push(signal)
    const selection = target.selection
    const targetId = this.resolveSelection(selection)
    if (onPoint) {
      const pointId = this.pointSelection(selection)
      const point = pointId ? this.rows.get(pointId) : undefined
      if (point) {
        onPoint(
          this.envelope({
            kind: 'tip-point',
            chat: structuredClone(this.currentChat),
            target,
            structuralVersion: this.currentChat.structuralVersion,
            presentation: point,
          }),
        )
      }
    }
    if (targetId === null) {
      return this.envelope(
        sealTestSelection({
          kind: 'ready',
          chat: structuredClone(this.currentChat),
          target,
          proof: {
            chatId: CHAT_ID,
            structuralVersion: this.currentChat.structuralVersion,
            tipId: null,
            pathHeaders: [],
          },
          presentations: [],
          forks: [],
          terminalChildSlot: emptyActiveBranchChildSlot(null),
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
    const tip = path.at(-1) as ReturnType<typeof presentation>
    return this.envelope(
      sealTestSelection({
        kind: 'ready',
        chat: structuredClone(this.currentChat),
        target,
        proof: {
          chatId: CHAT_ID,
          structuralVersion: this.currentChat.structuralVersion,
          tipId: targetId,
          pathHeaders: path.map((row) => row.header),
        },
        presentations: [tip],
        forks: path.map((row) => this.forkFor(row.header.id)),
        terminalChildSlot: emptyActiveBranchChildSlot(targetId),
      }),
    )
  }

  private pointSelection(selection: ActiveBranchSelection): MessageId | null {
    if (selection.kind === 'default') return this.currentChat.lastUpdatedLeafId
    if (selection.kind === 'tip') return selection.messageId
    const selected =
      selection.kind === 'message'
        ? this.rows.get(selection.messageId)
        : this.children(selection.parentId)[selection.position]
    return selected && this.children(selected.header.id).length === 0 ? selected.header.id : null
  }

  private resolveSelection(selection: ActiveBranchSelection): MessageId | null {
    if (selection.kind === 'default') return this.currentChat.lastUpdatedLeafId
    if (selection.kind === 'tip') return selection.messageId
    if (selection.kind === 'sibling-position') {
      return this.children(selection.parentId)[selection.position]?.header.id ?? null
    }
    return selection.observedTipId ?? this.newestDescendant(selection.messageId)
  }

  private newestDescendant(messageId: MessageId): MessageId {
    let current = messageId
    for (;;) {
      const child = this.children(current).at(-1)
      if (!child) return current
      current = child.header.id
    }
  }

  private page(
    fullPath: readonly ReturnType<typeof presentation>[],
    selected: readonly ReturnType<typeof presentation>[],
    offset: number,
  ): ConversationTranscriptPage {
    const leafId = fullPath.at(-1)?.header.id ?? null
    if (leafId === null) throw new Error('test transcript page requires a leaf')
    return {
      chatId: CHAT_ID,
      leafId,
      branchLength: fullPath.length,
      offset,
      headers: selected.map((row) => row.header),
      messages: selected.map((row) => row.message),
    }
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

  private children(parentId: MessageId | null): ReturnType<typeof presentation>[] {
    return [...this.rows.values()]
      .filter((row) => !row.header.deleted && row.header.parentId === parentId)
      .sort((left, right) => left.header.siblingIndex - right.header.siblingIndex)
  }

  private forkFor(messageId: MessageId): ActiveBranchForkSlot {
    const selected = this.rows.get(messageId)
    if (!selected) throw new Error(`MissingSelectedMessage:${messageId}`)
    const siblings = this.children(selected.header.parentId)
    const position = siblings.findIndex((row) => row.header.id === messageId)
    if (position < 0) throw new Error(`MissingSelectedSibling:${messageId}`)
    return {
      parentId: selected.header.parentId,
      selectedMessageId: messageId,
      slotVersion: siblings.reduce((sum, row) => sum + row.header.nodeVersion + 1, 0),
      position,
      liveCount: siblings.length,
      nextSiblingIndex:
        Math.max(...siblings.map((row) => row.header.siblingIndex)) + 1,
      previousMessageId: siblings[position - 1]?.header.id ?? null,
      nextMessageId: siblings[position + 1]?.header.id ?? null,
      firstMessageId: siblings[0]?.header.id as MessageId,
      lastMessageId: siblings.at(-1)?.header.id as MessageId,
    }
  }

  private envelope<T>(value: T) {
    return { ...this.currentFence, value }
  }
}

function harness(rows: readonly Message[], defaultLeafId?: MessageId) {
  const controller = createConversationController()
  const source = new ProjectionSource()
  source.seed(rows, defaultLeafId)
  controller.reconcileWorkspace(FENCE)
  controller.setProjectionSource(source)
  controller.installPresentationResourcePort(READY_PRESENTATION_RESOURCES)
  controller.installViewportPort(READY_VIEWPORT)
  controller.setNavigationPort(browserConversationNavigationPort)
  controllers.add(controller)
  return { controller, source }
}

const READY_PRESENTATION_RESOURCES: ConversationPresentationResourcePort = Object.freeze({
  get: () => Object.freeze({ kind: 'ready' }),
  request: () => undefined,
  subscribe: () => () => undefined,
})

const READY_VIEWPORT: ConversationViewportPort = Object.freeze({
  chatId: CHAT_ID,
  prepare: () => Object.freeze({ kind: 'prepared' }),
})

function readyBinding<Surface extends ConversationSurface>(
  controller: ConversationController,
  surface: Surface,
): Extract<ConversationCurrentSurfaceBinding, { readonly surface: Surface }> {
  const presentation = controller.getSnapshot().active?.presentation
  const target = presentation?.target
  if (!presentation || target?.kind !== 'ready' || target.binding.surface !== surface) {
    throw new Error(`missing ready ${surface} binding`)
  }
  if (
    presentation.painted?.binding !== target.binding ||
    presentation.residents[surface] !== target.binding
  ) {
    throw new Error(`incoherent ready ${surface} binding`)
  }
  return target.binding as Extract<ConversationCurrentSurfaceBinding, { readonly surface: Surface }>
}

function activeSpine(
  controller: ConversationController,
): VersionedActiveBranchSpine<MessageHeaderRow> {
  const destination = controller.getSnapshot().active?.destination
  if (!destination) throw new Error('missing active destination')
  if (destination.kind === 'ready') return destination.spine
  const retained = 'retained' in destination ? destination.retained : null
  if (!retained) throw new Error(`destination is not presented: ${destination.kind}`)
  return retained.spine
}

function localCommittedEffect(
  source: ProjectionSource,
  presentations: readonly ReturnType<typeof presentation>[],
  headers: readonly MessageHeaderRow[] = presentations.map((row) => row.header),
  structural: ConversationStructuralTransition = Object.freeze({ kind: 'none' }),
): ConversationCommittedEffect {
  const presentationsById = new Map(presentations.map((row) => [row.header.id, row] as const))
  return Object.freeze({
    ...source.currentFence,
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

function exactStructuralTransition(
  source: ProjectionSource,
  messageIds: readonly MessageId[],
): ConversationStructuralTransition {
  const toVersion = source.currentChat.structuralVersion
  return Object.freeze({
    kind: 'exact-delta',
    toVersion,
    structuralVersions: Object.freeze(
      messageIds.map((_, index) => toVersion - messageIds.length + index + 1),
    ),
    messageIds: Object.freeze([...messageIds]),
  })
}

async function settle(): Promise<void> {
  for (let index = 0; index < 16; index += 1) await Promise.resolve()
}

beforeEach(() => {
  sessionStorage.clear()
  navigate('#/')
})

afterEach(() => {
  for (const controller of controllers) {
    controller.setNavigationPort(null)
    controller.setProjectionSource(null)
  }
  controllers.clear()
})

describe('router and ConversationController integration', () => {
  it('resolves a new URL target from a fresh selection instead of rejecting a retained ready frame', async () => {
    const root = message('root', null, 0, 1)
    const oldLeaf = message('old-leaf', root.id, 0, 2)
    const newLeaf = message('new-leaf', root.id, 1, 3)
    const { controller, source } = harness([root, oldLeaf], oldLeaf.id)
    navigate(`#/chat/${CHAT_ID}/message/${oldLeaf.id}`)
    await settle()
    const retained = activeSpine(controller)
    const pending = deferred<ConversationReadEnvelope<ConversationProjectionOpenResult>>()
    let pendingTarget: ConversationSelectionProofTarget | null = null
    source.openSelection.mockImplementationOnce((_chatId, target, _onPoint, signal) => {
      pendingTarget = target
      source.selectionSignals.push(signal)
      return pending.promise
    })

    navigate(`#/chat/${CHAT_ID}/message/${newLeaf.id}`)
    await Promise.resolve()
    expect(window.location.hash).toBe(`#/chat/${CHAT_ID}/message/${newLeaf.id}`)
    expect(activeSpine(controller)).toBe(retained)

    source.put(newLeaf)
    pending.resolve(
      await source.readSelection(
        CHAT_ID,
        required<ConversationSelectionProofTarget>(pendingTarget, 'pending URL target'),
        undefined,
        new AbortController().signal,
      ),
    )
    await settle()

    expect(activeSpine(controller).path.leaf?.id).toBe(newLeaf.id)
    expect(window.location.hash).toBe(`#/chat/${CHAT_ID}/message/${newLeaf.id}`)
  })

  it('canonicalizes an invalid message pin on an empty chat to the bare chat route', async () => {
    const { controller } = harness([])

    navigate(`#/chat/${CHAT_ID}/message/missing`)
    await settle()

    expect(controller.getSnapshot().active?.destination.kind).toBe('ready')
    expect(activeSpine(controller).resolvedLeafId).toBeNull()
    expect(window.location.hash).toBe(`#/chat/${CHAT_ID}`)
  })

  it('retains a startup message pin across a projection-source lifecycle replay', async () => {
    const root = message('root', null, 0, 1)
    const leaf = message('leaf', root.id, 0, 2)
    const { controller, source } = harness([root, leaf], leaf.id)
    source.openSelection.mockRejectedValueOnce(new DOMException('lifecycle replay', 'AbortError'))
    const href = `#/chat/${CHAT_ID}/message/${leaf.id}`

    navigate(href)
    await settle()
    expect(window.location.hash).toBe(href)

    controller.setProjectionSource(null)
    controller.setProjectionSource(source)
    await settle()
    expect(activeSpine(controller).path.leaf?.id).toBe(leaf.id)
    expect(window.location.hash).toBe(href)
    expect(source.openSelection).toHaveBeenCalledTimes(2)
  })

  it('retries a failed URL-target read only when the same arrival is explicitly reopened', async () => {
    const root = message('root', null, 0, 1)
    const leaf = message('leaf', root.id, 0, 2)
    const { controller, source } = harness([root, leaf], leaf.id)
    source.openSelection.mockRejectedValueOnce(new Error('transient selection failure'))
    const href = `#/chat/${CHAT_ID}/message/${leaf.id}`

    navigate(href)
    await settle()
    expect(controller.getSnapshot().active?.failure).toMatchObject({
      kind: 'selection',
      code: 'read-failed',
    })
    expect(window.location.hash).toBe(href)

    navigate(href)
    await settle()
    expect(activeSpine(controller).path.leaf?.id).toBe(leaf.id)
    expect(controller.getSnapshot().active?.failure).toBeNull()
    expect(source.openSelection).toHaveBeenCalledTimes(2)
  })

  it('cancels an older URL-target read when a newer arrival supersedes it', async () => {
    const root = message('root', null, 0, 1)
    const first = message('first', root.id, 0, 2)
    const second = message('second', root.id, 1, 3)
    const third = message('third', root.id, 2, 4)
    const { controller, source } = harness([root, first, second, third], first.id)
    navigate(`#/chat/${CHAT_ID}/message/${first.id}`)
    await settle()
    const pending = deferred<ConversationReadEnvelope<ConversationProjectionOpenResult>>()
    let olderTarget: ConversationSelectionProofTarget | null = null
    let olderSignal: AbortSignal | null = null
    source.openSelection.mockImplementationOnce((_chatId, target, _onPoint, signal) => {
      olderTarget = target
      olderSignal = signal
      return pending.promise
    })

    navigate(`#/chat/${CHAT_ID}/message/${second.id}`)
    navigate(`#/chat/${CHAT_ID}/message/${third.id}`)
    await settle()
    expect((olderSignal as AbortSignal | null)?.aborted).toBe(true)
    expect(activeSpine(controller).path.leaf?.id).toBe(third.id)

    pending.resolve(
      await source.readSelection(
        CHAT_ID,
        required<ConversationSelectionProofTarget>(olderTarget, 'older URL target'),
        undefined,
        new AbortController().signal,
      ),
    )
    await settle()
    expect(activeSpine(controller).path.leaf?.id).toBe(third.id)
    expect(window.location.hash).toBe(`#/chat/${CHAT_ID}/message/${third.id}`)
  })

  it('cancels a pending URL-target read when the route unmounts', async () => {
    const root = message('root', null, 0, 1)
    const leaf = message('leaf', root.id, 0, 2)
    const { controller, source } = harness([root, leaf], leaf.id)
    const pending = deferred<ConversationReadEnvelope<ConversationProjectionOpenResult>>()
    let signal: AbortSignal | null = null
    source.openSelection.mockImplementationOnce((_chatId, _target, _onPoint, nextSignal) => {
      signal = nextSignal
      return pending.promise
    })

    navigate(`#/chat/${CHAT_ID}/message/${leaf.id}`)
    await Promise.resolve()
    navigate('#/')
    await settle()

    expect((signal as AbortSignal | null)?.aborted).toBe(true)
    expect(controller.getSnapshot().active).toBeNull()
    expect(window.location.hash).toBe('#/')
  })

  it('fences a URL-target completion that ignores abort and settles after unmount', async () => {
    const root = message('root', null, 0, 1)
    const leaf = message('leaf', root.id, 0, 2)
    const { controller, source } = harness([root, leaf], leaf.id)
    const pending = deferred<ConversationReadEnvelope<ConversationProjectionOpenResult>>()
    let target: ConversationSelectionProofTarget | null = null
    source.openSelection.mockImplementationOnce((_chatId, nextTarget) => {
      target = nextTarget
      return pending.promise
    })

    navigate(`#/chat/${CHAT_ID}/message/${leaf.id}`)
    await Promise.resolve()
    navigate('#/')
    pending.resolve(
      await source.readSelection(
        CHAT_ID,
        required<ConversationSelectionProofTarget>(target, 'unmounted URL target'),
        undefined,
        new AbortController().signal,
      ),
    )
    await settle()

    expect(controller.getSnapshot().active).toBeNull()
    expect(window.location.hash).toBe('#/')
  })

  it('ignores a selection completion from an older URL arrival', async () => {
    const root = message('root', null, 0, 1)
    const first = message('first', root.id, 0, 2)
    const second = message('second', root.id, 1, 3)
    const third = message('third', root.id, 2, 4)
    const { controller, source } = harness([root, first, second, third], first.id)
    navigate(`#/chat/${CHAT_ID}/message/${first.id}`)
    await settle()
    const older = deferred<ConversationReadEnvelope<ConversationProjectionOpenResult>>()
    const newer = deferred<ConversationReadEnvelope<ConversationProjectionOpenResult>>()
    const targets: ConversationSelectionProofTarget[] = []
    source.openSelection
      .mockImplementationOnce((_chatId, target) => {
        targets.push(target)
        return older.promise
      })
      .mockImplementationOnce((_chatId, target) => {
        targets.push(target)
        return newer.promise
      })

    navigate(`#/chat/${CHAT_ID}/message/${second.id}`)
    navigate(`#/chat/${CHAT_ID}/message/${third.id}`)
    await Promise.resolve()
    const newerTarget = targets[1]
    if (!newerTarget) throw new Error('missing newer target')
    newer.resolve(
      await source.readSelection(CHAT_ID, newerTarget, undefined, new AbortController().signal),
    )
    await settle()
    expect(activeSpine(controller).path.leaf?.id).toBe(third.id)

    const olderTarget = targets[0]
    if (!olderTarget) throw new Error('missing older target')
    older.resolve(
      await source.readSelection(CHAT_ID, olderTarget, undefined, new AbortController().signal),
    )
    await settle()
    expect(activeSpine(controller).path.leaf?.id).toBe(third.id)
    expect(
      controller.getSnapshot().active?.presentation.painted?.binding.reveal?.targetMessageId,
    ).not.toBe(second.id)
  })

  it('does not let a pending URL read overwrite a newer in-tab navigation', async () => {
    const root = message('root', null, 0, 1)
    const oldLeaf = message('old-leaf', root.id, 0, 2)
    const pendingLeaf = message('pending-leaf', root.id, 1, 3)
    const { controller, source } = harness([root, oldLeaf, pendingLeaf], oldLeaf.id)
    navigate(`#/chat/${CHAT_ID}/message/${oldLeaf.id}`)
    await settle()
    const pending = deferred<ConversationReadEnvelope<ConversationProjectionOpenResult>>()
    let target: ConversationSelectionProofTarget | null = null
    source.openSelection.mockImplementationOnce((_chatId, nextTarget) => {
      target = nextTarget
      return pending.promise
    })

    navigate(`#/chat/${CHAT_ID}/message/${pendingLeaf.id}`)
    controller.navigate({ chatId: CHAT_ID, kind: 'message', messageId: oldLeaf.id })
    pending.resolve(
      await source.readSelection(
        CHAT_ID,
        required<ConversationSelectionProofTarget>(target, 'pending URL target'),
        undefined,
        new AbortController().signal,
      ),
    )
    await settle()

    expect(activeSpine(controller).path.leaf?.id).toBe(oldLeaf.id)
    expect(window.location.hash).toBe(`#/chat/${CHAT_ID}/message/${oldLeaf.id}`)
  })

  it('does not let a never-settling URL read suppress a newer in-tab navigation', async () => {
    const root = message('root', null, 0, 1)
    const oldLeaf = message('old-leaf', root.id, 0, 2)
    const fallback = message('fallback', root.id, 1, 3)
    const { controller, source } = harness([root, oldLeaf, fallback], oldLeaf.id)
    navigate(`#/chat/${CHAT_ID}/message/${oldLeaf.id}`)
    await settle()
    source.openSelection.mockImplementationOnce(() => new Promise(() => undefined))

    navigate(`#/chat/${CHAT_ID}/message/missing`)
    controller.navigate({ chatId: CHAT_ID, kind: 'message', messageId: fallback.id })
    await settle()

    expect(activeSpine(controller).path.leaf?.id).toBe(fallback.id)
    expect(window.location.hash).toBe(`#/chat/${CHAT_ID}/message/${fallback.id}`)
  })

  it('retries a hung URL target when the same deep link is explicitly opened again', async () => {
    const root = message('root', null, 0, 1)
    const oldLeaf = message('old-leaf', root.id, 0, 2)
    const targetLeaf = message('target-leaf', root.id, 1, 3)
    const { controller, source } = harness([root, oldLeaf, targetLeaf], oldLeaf.id)
    navigate(`#/chat/${CHAT_ID}/message/${oldLeaf.id}`)
    await settle()
    let firstSignal: AbortSignal | null = null
    source.openSelection.mockImplementationOnce((_chatId, _target, _onPoint, signal) => {
      firstSignal = signal
      return new Promise(() => undefined)
    })
    const href = `#/chat/${CHAT_ID}/message/${targetLeaf.id}`

    navigate(href)
    await Promise.resolve()
    navigate(href)
    await settle()

    expect((firstSignal as AbortSignal | null)?.aborted).toBe(true)
    expect(activeSpine(controller).path.leaf?.id).toBe(targetLeaf.id)
    expect(window.location.hash).toBe(href)
    expect(source.openSelection).toHaveBeenCalledTimes(3)
  })

  it('reapplies this tab deep link after workspace replacement reuses message ids', async () => {
    const root = message('root', null, 0, 1)
    const leaf = message('leaf', root.id, 0, 2)
    const { controller, source } = harness([root, leaf], leaf.id)
    const href = `#/chat/${CHAT_ID}/message/${leaf.id}`
    navigate(href)
    await settle()
    const replacement = Object.freeze({
      workspaceId: 'router-controller-workspace-b',
      replacementEpoch: 1,
    })

    source.currentFence = replacement
    controller.reconcileWorkspace(replacement)
    navigate(href)
    await settle()

    expect(controller.getSnapshot()).toMatchObject({
      workspaceId: replacement.workspaceId,
      workspaceEpoch: replacement.replacementEpoch,
    })
    expect(activeSpine(controller).path.leaf?.id).toBe(leaf.id)
    expect(window.location.hash).toBe(href)
  })

  it('keeps a rejected URL target authoritative until a newer in-tab navigation', async () => {
    const root = message('root', null, 0, 1)
    const oldLeaf = message('old-leaf', root.id, 0, 2)
    const fallback = message('fallback', root.id, 1, 3)
    const { controller, source } = harness([root, oldLeaf, fallback], oldLeaf.id)
    navigate(`#/chat/${CHAT_ID}/message/${oldLeaf.id}`)
    await settle()
    source.openSelection.mockRejectedValueOnce(new Error('selection rejected'))
    const rejectedHref = `#/chat/${CHAT_ID}/message/missing`

    navigate(rejectedHref)
    await settle()
    expect(window.location.hash).toBe(rejectedHref)
    expect(controller.getSnapshot().active?.failure).toMatchObject({ kind: 'selection' })

    controller.navigate({ chatId: CHAT_ID, kind: 'message', messageId: fallback.id })
    await settle()
    expect(activeSpine(controller).path.leaf?.id).toBe(fallback.id)
    expect(window.location.hash).toBe(`#/chat/${CHAT_ID}/message/${fallback.id}`)
  })

  it('keeps the structural projection stable across body-only header revisions', async () => {
    const root = message('root', null, 0, 1)
    const leaf = message('leaf', root.id, 0, 2)
    const { controller, source } = harness([root, leaf], leaf.id)
    navigate(`#/chat/${CHAT_ID}/message/${leaf.id}`)
    await settle()
    controller.requestPresentation({ chatId: CHAT_ID, surface: 'tree' })
    await settle()
    const initialBinding = readyBinding(controller, 'tree')
    const initialTopology = initialBinding.topology
    const bodyRevision = source.put({
      ...leaf,
      nodeVersion: 1,
      content: [{ type: 'output_text', text: 'body revision' }],
    })

    controller.applyCommittedEffect(localCommittedEffect(source, [bodyRevision]))
    await settle()
    const bodyBinding = readyBinding(controller, 'tree')
    expect(bodyBinding.topology).toBe(initialTopology)
    expect(bodyBinding.spine.path.identity).toBe(initialBinding.spine.path.identity)
    expect(bodyBinding.spine.path.get(leaf.id)?.nodeVersion).toBe(1)

    const structuralRevision = source.put({
      ...bodyRevision.message,
      siblingIndex: 1,
      nodeVersion: 2,
    })
    controller.applyCommittedEffect(
      localCommittedEffect(
        source,
        [structuralRevision],
        undefined,
        exactStructuralTransition(source, [structuralRevision.header.id]),
      ),
    )
    await settle()
    const structuralBinding = readyBinding(controller, 'tree')
    expect(structuralBinding.topology).not.toBe(initialTopology)
    expect(structuralBinding.seal.structuralVersion).toBe(source.currentChat.structuralVersion)
  })

  it('reconciles an arbitrary dangling selection to the observed default branch', async () => {
    const root = message('root', null, 0, 1)
    const leaf = message('leaf', root.id, 0, 2)
    const { controller } = harness([root, leaf], leaf.id)

    navigate(`#/chat/${CHAT_ID}/message/dangling-leaf`)
    await settle()

    expect(activeSpine(controller).path.leaf?.id).toBe(leaf.id)
    expect(window.location.hash).toBe(`#/chat/${CHAT_ID}/message/${leaf.id}`)
  })

  it('preserves an exact current committed branch selection through repository lag', async () => {
    const root = message('root', null, 0, 1)
    const oldLeaf = message('old-leaf', root.id, 0, 2)
    const { controller, source } = harness([root, oldLeaf], oldLeaf.id)
    navigate(`#/chat/${CHAT_ID}/message/${oldLeaf.id}`)
    await settle()
    source.openSelection.mockImplementation(() => new Promise(() => undefined))
    const pendingLeaf = source.put(message('pending-local-leaf', root.id, 1, 3))
    const operation = controller.claimOperation({ chatId: CHAT_ID, steering: 'select-result' })

    expect(
      controller.acceptLocalResult(operation, {
        kind: 'select-committed',
        receipt: {
          ...source.currentFence,
          destination: source.committedSelection(pendingLeaf.header.id),
        },
        committedEffect: localCommittedEffect(
          source,
          [pendingLeaf],
          undefined,
          exactStructuralTransition(source, [pendingLeaf.header.id]),
        ),
      }),
    ).toEqual({ accepted: true })

    expect(activeSpine(controller).path.leaf?.id).toBe(pendingLeaf.header.id)
    expect(window.location.hash).toBe(`#/chat/${CHAT_ID}/message/${pendingLeaf.header.id}`)
  })

  it('never projects an interior operation node as the selected path leaf', async () => {
    const root = message('root', null, 0, 1)
    const interior = message('interior', root.id, 0, 2)
    const descendant = message('descendant', interior.id, 0, 3)
    const { controller, source } = harness([root, interior, descendant], root.id)
    navigate(`#/chat/${CHAT_ID}/message/${root.id}`)
    await settle()
    const operation = controller.claimOperation({ chatId: CHAT_ID, steering: 'select-result' })

    expect(
      controller.acceptLocalResult(operation, {
        kind: 'select-committed',
        receipt: { ...source.currentFence, destination: source.committedSelection(descendant.id) },
        committedEffect: localCommittedEffect(source, []),
      }),
    ).toEqual({ accepted: true })
    expect(activeSpine(controller).path.leaf?.id).toBe(descendant.id)
    expect(window.location.hash).toBe(`#/chat/${CHAT_ID}/message/${descendant.id}`)
    expect(window.location.hash).not.toContain(`/message/${interior.id}`)
  })

  it('clears a stale repository leaf when a committed delete selects an empty path', async () => {
    const root = message('root', null, 0, 1)
    const leaf = message('leaf', root.id, 0, 2)
    const { controller, source } = harness([root, leaf], leaf.id)
    navigate(`#/chat/${CHAT_ID}/message/${leaf.id}`)
    await settle()
    const deletedRoot = source.put({ ...root, deleted: true, nodeVersion: 1 })
    const deletedLeaf = source.put({ ...leaf, deleted: true, nodeVersion: 1 })
    source.currentChat = { ...source.currentChat, lastUpdatedLeafId: null }
    const operation = controller.claimOperation({ chatId: CHAT_ID, steering: 'select-result' })

    expect(
      controller.acceptLocalResult(operation, {
        kind: 'select-committed',
        receipt: { ...source.currentFence, destination: source.committedSelection(null) },
        committedEffect: localCommittedEffect(
          source,
          [],
          [deletedRoot.header, deletedLeaf.header],
          exactStructuralTransition(source, [deletedRoot.header.id, deletedLeaf.header.id]),
        ),
      }),
    ).toEqual({ accepted: true })
    expect(activeSpine(controller).resolvedLeafId).toBeNull()
    expect(window.location.hash).toBe(`#/chat/${CHAT_ID}`)
  })

  it('canonicalizes an interior message URL to its resolved descendant leaf', async () => {
    const root = message('root', null, 0, 1)
    const left = message('left', root.id, 0, 2)
    const right = message('right', root.id, 1, 3)
    const { controller } = harness([root, left, right], right.id)

    navigate(`#/chat/${CHAT_ID}/message/${root.id}`)
    await settle()

    expect(activeSpine(controller).path.materializeIds()).toEqual(['root', 'right'])
    expect(window.location.hash).toBe(`#/chat/${CHAT_ID}/message/${right.id}`)
  })

  it('mirrors an in-tab swipe without publishing a second route arrival', async () => {
    const root = message('root', null, 0, 1)
    const left = message('left', root.id, 0, 2)
    const right = message('right', root.id, 1, 3)
    const { controller } = harness([root, left, right], right.id)
    navigate(`#/chat/${CHAT_ID}/message/${left.id}`)
    await settle()
    let arrivals = 0
    const unsubscribe = subscribeRouteArrival(() => {
      arrivals += 1
    })

    controller.navigate({ chatId: CHAT_ID, kind: 'message', messageId: right.id })
    await settle()
    unsubscribe()

    expect(activeSpine(controller).path.leaf?.id).toBe(right.id)
    expect(window.location.hash).toBe(`#/chat/${CHAT_ID}/message/${right.id}`)
    expect(arrivals).toBe(0)
  })

  it('bootstraps topology once and admits exact metadata publications without rescanning it', async () => {
    const rows: Message[] = []
    for (let index = 0; index < 512; index += 1) {
      rows.push(message(`row-${index}`, rows.at(-1)?.id ?? null, 0, index + 1))
    }
    const leaf = rows.at(-1)
    if (!leaf) throw new Error('missing metadata target')
    const { controller, source } = harness(rows, leaf.id)
    navigate(`#/chat/${CHAT_ID}/message/${leaf.id}`)
    await settle()
    const topology = controller.getSnapshot().active?.structuralTopology
    source.loadTopology.mockClear()
    const selectionReads = source.openSelection.mock.calls.length

    for (let version = 1; version <= 12; version += 1) {
      const revision = source.put({
        ...leaf,
        nodeVersion: version,
        content: [{ type: 'output_text', text: `stream-${version}` }],
      })
      controller.applyCommittedEffect(localCommittedEffect(source, [revision]))
    }
    await settle()

    expect(controller.getSnapshot().active?.headerFacts.get(leaf.id)?.nodeVersion).toBe(12)
    expect(controller.getSnapshot().active?.structuralTopology).toBe(topology)
    expect(source.loadTopology).not.toHaveBeenCalled()
    expect(source.openSelection).toHaveBeenCalledTimes(selectionReads)
  })

  it('falls back to one topology snapshot when a publication lacks exact primary keys', async () => {
    const root = message('root', null, 0, 1)
    const leaf = message('leaf', root.id, 0, 2)
    const sibling = message('sibling', root.id, 1, 3)
    const { controller, source } = harness([root, leaf], leaf.id)
    navigate(`#/chat/${CHAT_ID}/message/${leaf.id}`)
    await settle()
    controller.requestPresentation({ chatId: CHAT_ID, surface: 'tree' })
    await settle()
    source.put(sibling)
    source.loadTopology.mockClear()

    controller.applyCommittedEffect({
      ...source.currentFence,
      chatId: CHAT_ID,
      source: 'invalidation',
      kind: 'changed',
      structural: {
        kind: 'incomplete',
        toVersion: source.currentChat.structuralVersion,
        scope: true,
      },
    })
    await settle()

    expect(source.loadTopology).toHaveBeenCalledOnce()
    expect(controller.getSnapshot().active?.structuralTopology.byId.has(sibling.id)).toBe(true)
    expect(activeSpine(controller).path.leaf?.id).toBe(leaf.id)
  })

  it('does not implicitly pin either of multiple remote continuations', async () => {
    const root = message('root', null, 0, 1)
    const leaf = message('leaf', root.id, 0, 2)
    const { controller, source } = harness([root, leaf], leaf.id)
    navigate(`#/chat/${CHAT_ID}/message/${leaf.id}`)
    await settle()
    const first = source.put(message('first-child', leaf.id, 0, 3))
    const firstVersion = source.currentChat.structuralVersion
    const second = source.put(message('second-child', leaf.id, 1, 4))
    const secondVersion = source.currentChat.structuralVersion

    controller.applyCommittedEffects([
      {
        ...source.currentFence,
        chatId: CHAT_ID,
        source: 'remote',
        kind: 'changed',
        structural: {
          kind: 'exact-delta',
          toVersion: firstVersion,
          structuralVersions: [firstVersion],
          messageIds: [first.header.id],
        },
        revisions: [{ header: first.header, structuralVersion: firstVersion, presentation: first }],
      },
      {
        ...source.currentFence,
        chatId: CHAT_ID,
        source: 'remote',
        kind: 'changed',
        structural: {
          kind: 'exact-delta',
          toVersion: secondVersion,
          structuralVersions: [secondVersion],
          messageIds: [second.header.id],
        },
        chat: structuredClone(source.currentChat),
        revisions: [
          { header: second.header, structuralVersion: secondVersion, presentation: second },
        ],
      },
    ])
    await settle()

    expect(activeSpine(controller).path.leaf?.id).toBe(leaf.id)
    expect(window.location.hash).toBe(`#/chat/${CHAT_ID}/message/${leaf.id}`)
  })

  it('uses the newest descendant when entering an unpinned subtree', async () => {
    const root = message('root', null, 0, 1)
    const olderBranch = message('older-branch', root.id, 0, 2)
    const defaultBranch = message('default-branch', root.id, 1, 3)
    const olderDescendant = message('older-descendant', olderBranch.id, 0, 4)
    const newestDescendant = message('newest-descendant', olderBranch.id, 1, 5)
    const defaultDescendant = message('default-descendant', defaultBranch.id, 0, 6)
    const { controller, source } = harness(
      [root, olderBranch, defaultBranch, olderDescendant, newestDescendant, defaultDescendant],
      defaultDescendant.id,
    )
    navigate(`#/chat/${CHAT_ID}/message/${defaultDescendant.id}`)
    await settle()

    controller.navigate({ chatId: CHAT_ID, kind: 'message', messageId: olderBranch.id })
    await settle()
    expect(activeSpine(controller).path.leaf?.id).toBe(newestDescendant.id)

    const unrelated = source.put(message('unrelated', defaultBranch.id, 1, 7))
    controller.applyCommittedEffect({
      ...source.currentFence,
      chatId: CHAT_ID,
      source: 'remote',
      kind: 'changed',
      structural: exactStructuralTransition(source, [unrelated.header.id]),
      revisions: [
        {
          header: unrelated.header,
          structuralVersion: source.currentChat.structuralVersion,
          presentation: unrelated,
        },
      ],
    })
    await settle()
    expect(activeSpine(controller).path.leaf?.id).toBe(newestDescendant.id)
  })

  it('reuses one ready presentation projection across harmless resource publications', async () => {
    const root = message('root', null, 0, 1)
    const leaf = message('leaf', root.id, 0, 2)
    const { controller } = harness([root, leaf], leaf.id)
    navigate(`#/chat/${CHAT_ID}/message/${leaf.id}`)
    await settle()
    const binding = readyBinding(controller, 'transcript')
    const destination = controller.getSnapshot().active?.destination

    controller.installPresentationResourcePort(READY_PRESENTATION_RESOURCES)
    controller.installPresentationResourcePort(READY_PRESENTATION_RESOURCES)

    expect(readyBinding(controller, 'transcript')).toBe(binding)
    expect(controller.getSnapshot().active?.destination).toBe(destination)
  })

  it('does not let a remote sibling or newer default leaf steer this tab', async () => {
    const root = message('root', null, 0, 1)
    const left = message('left', root.id, 0, 2)
    const { controller, source } = harness([root, left], left.id)
    navigate(`#/chat/${CHAT_ID}/message/${left.id}`)
    await settle()

    const remote = source.put(message('remote', root.id, 1, 4))
    controller.applyCommittedEffect({
      ...FENCE,
      chatId: CHAT_ID,
      source: 'remote',
      kind: 'changed',
      structural: exactStructuralTransition(source, [remote.header.id]),
      revisions: [
        {
          header: remote.header,
          structuralVersion: source.currentChat.structuralVersion,
          presentation: remote,
        },
      ],
    })
    await settle()

    expect(activeSpine(controller).path.leaf?.id).toBe(left.id)
    expect(window.location.hash).toBe(`#/chat/${CHAT_ID}/message/${left.id}`)
  })

  it('keeps an exact tab tip when another tab linearly extends it', async () => {
    const root = message('root', null, 0, 1)
    const left = message('left', root.id, 0, 2)
    const { controller, source } = harness([root, left], left.id)
    navigate(`#/chat/${CHAT_ID}/message/${left.id}`)
    await settle()

    const extension = source.put(message('remote-child', left.id, 0, 4))
    controller.applyCommittedEffect({
      ...FENCE,
      chatId: CHAT_ID,
      source: 'remote',
      kind: 'changed',
      structural: exactStructuralTransition(source, [extension.header.id]),
      revisions: [
        {
          header: extension.header,
          structuralVersion: source.currentChat.structuralVersion,
          presentation: extension,
        },
      ],
    })
    await settle()

    expect(activeSpine(controller).path.leaf?.id).toBe(left.id)
    expect(window.location.hash).toBe(`#/chat/${CHAT_ID}/message/${left.id}`)
  })

  it('selects and reveals the locally generated result through one controller operation', async () => {
    const root = message('root', null, 0, 1)
    const left = message('left', root.id, 0, 2)
    const { controller, source } = harness([root, left], left.id)
    navigate(`#/chat/${CHAT_ID}/message/${left.id}`)
    await settle()
    const operation = controller.claimOperation({ chatId: CHAT_ID, steering: 'select-result' })
    const generated = source.put(message('generated', root.id, 1, 5))

    expect(
      controller.acceptLocalResult(operation, {
        kind: 'select-committed',
        receipt: { ...FENCE, destination: source.committedSelection(generated.header.id) },
        revealTargetMessageId: generated.header.id,
        committedEffect: {
          ...FENCE,
          chatId: CHAT_ID,
          source: 'local',
          kind: 'changed',
          structural: exactStructuralTransition(source, [generated.header.id]),
          chat: structuredClone(source.currentChat),
          revisions: [
            {
              header: generated.header,
              structuralVersion: source.currentChat.structuralVersion,
              presentation: generated,
            },
          ],
        },
      }),
    ).toEqual({ accepted: true })
    await settle()

    expect(activeSpine(controller).path.leaf?.id).toBe(generated.header.id)
    const binding = readyBinding(controller, 'transcript')
    expect(binding.currency).toBe('current')
    expect(binding.seal.leafId).toBe(generated.header.id)
    expect(binding.spine).toBe(activeSpine(controller))
    expect(binding.reveal?.targetMessageId).toBe(generated.header.id)
    expect(window.location.hash).toBe(`#/chat/${CHAT_ID}/message/${generated.header.id}`)
  })

  it('resolves a chat URL without a pin from the durable default leaf once', async () => {
    const root = message('root', null, 0, 1)
    const left = message('left', root.id, 0, 2)
    const right = message('right', root.id, 1, 3)
    const { controller, source } = harness([root, left, right], right.id)

    navigate(`#/chat/${CHAT_ID}`)
    await settle()

    expect(activeSpine(controller).path.leaf?.id).toBe(right.id)
    expect(window.location.hash).toBe(`#/chat/${CHAT_ID}/message/${right.id}`)
    expect(source.openSelection).toHaveBeenCalledOnce()
  })
})

function required<T>(value: T | null, label: string): T {
  if (value === null) throw new Error(`Missing:${label}`)
  return value
}
