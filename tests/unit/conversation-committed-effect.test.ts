import { beforeEach, expect, expectTypeOf, it, vi } from 'vitest'
import type {
  ActiveBranchForkSlot,
  ActiveBranchSelection,
} from '../../src/core/active-branch-spine'
import { childListKey } from '../../src/core/child-list-state'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import {
  type ConversationAppendSelectionTransition,
  type ConversationProvedSelection,
  type ConversationSelectionProofTarget,
  fixedConversationSelectionTarget,
  resolvingConversationSelectionTarget,
  sealConversationSelection,
} from '../../src/core/messages'
import type { Chat, ChatId, Message, MessageId } from '../../src/core/types'
import {
  type ConversationCommittedEffect,
  type ConversationDestinationProjection,
  type ConversationNavigationPort,
  type ConversationProjectionOpenResult,
  type ConversationProjectionSource,
  type ConversationReadEnvelope,
  type ConversationRouteArrival,
  type ConversationStructuralTransition,
  createConversationController,
} from '../../src/store/conversation-controller'
import { conversationCommittedEffectForCommit } from '../../src/store/conversation-repository-adapter'
import { createConversationRouteOwnerController } from '../../src/store/conversation-route-owner'
import { splitMessageForStorage } from '../../src/store/message-storage'
import { transcriptBodyWindowFindRow } from '../../src/store/transcript-window'
import type { CommitEnvelope } from '../../src/store/workspace-protocol'

const FENCE = Object.freeze({ workspaceId: 'workspace-a', replacementEpoch: 0 })
const CHAT_ID = 'chat-a'
const NO_STRUCTURAL_TRANSITION = Object.freeze({
  kind: 'none',
}) satisfies ConversationStructuralTransition

function exactStructuralTransition(
  toVersion: number,
  structuralVersions: readonly number[],
  messageIds: readonly MessageId[],
): ConversationStructuralTransition {
  return Object.freeze({
    kind: 'exact-delta',
    toVersion,
    structuralVersions: Object.freeze(structuralVersions),
    messageIds: Object.freeze(messageIds),
  })
}

function message(
  id: MessageId,
  parentId: MessageId | null,
  siblingIndex: number,
  role: Message['role'],
  text: string,
  createdAt: number,
): Message {
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

function presentation(row: Message) {
  const { header } = splitMessageForStorage(row, { bodyVersion: 1 })
  return Object.freeze({ header, message: row, bodyVersion: header.bodyVersion })
}

function chat(structuralVersion: number, lastUpdatedLeafId: MessageId): Chat {
  return {
    id: CHAT_ID,
    title: 'Conversation',
    titleStatus: 'manual',
    createdAt: 1,
    updatedAt: structuralVersion,
    lastViewedAt: 1,
    wordCount: 0,
    totalCostUsd: 0,
    metaVersion: structuralVersion,
    summaryVersion: 0,
    structuralVersion,
    configurationVersion: 0,
    settings: cloneDefaultChatSettings(),
    lastUpdatedLeafId,
    lastBranchUpdatedAt: structuralVersion,
    archived: false,
    pinned: false,
    folderId: null,
    tags: [],
  }
}

function destination(
  target: ConversationSelectionProofTarget,
  structuralVersion: number,
  rows: readonly ReturnType<typeof presentation>[],
): ConversationProvedSelection {
  const tip = rows.at(-1)
  if (!tip) throw new Error('test destination requires a tip')
  return Object.freeze({
    kind: 'ready',
    chat: chat(structuralVersion, tip.header.id),
    target,
    proof: Object.freeze({
      chatId: CHAT_ID,
      structuralVersion,
      tipId: tip.header.id,
      pathHeaders: Object.freeze(rows.map((row) => row.header)),
    }),
    presentations: Object.freeze([tip]),
    forks: Object.freeze(
      rows.map((row) => ({
        parentId: row.header.parentId,
        selectedMessageId: row.header.id,
        slotVersion: row.header.nodeVersion + 1,
        position: 0,
        liveCount: 1,
        previousMessageId: null,
        nextMessageId: null,
        firstMessageId: row.header.id,
        lastMessageId: row.header.id,
      })),
    ),
  })
}

function selectedLeaf(destinationProjection: ConversationDestinationProjection): MessageId | null {
  if (destinationProjection.kind === 'ready') return destinationProjection.spine.resolvedLeafId
  if (
    destinationProjection.kind === 'resolving' ||
    destinationProjection.kind === 'unresolved' ||
    destinationProjection.kind === 'unavailable' ||
    destinationProjection.kind === 'failed'
  ) {
    return destinationProjection.retained?.spine.resolvedLeafId ?? null
  }
  return null
}

class NavigationPort implements ConversationNavigationPort {
  private arrival: ConversationRouteArrival = Object.freeze({ id: 'initial', route: null })
  private readonly listeners = new Set<() => void>()

  getArrival = () => this.arrival
  subscribeArrival = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  replaceConversationUrl = vi.fn()

  open(chatId: ChatId, handoff?: NonNullable<ConversationRouteArrival['route']>['handoff']): void {
    this.arrival = Object.freeze({
      id: 'open-chat',
      route: Object.freeze({ chatId, ...(handoff ? { handoff } : {}) }),
    })
    for (const listener of this.listeners) listener()
  }
}

function envelope<T>(value: T): ConversationReadEnvelope<T> {
  return Object.freeze({ ...FENCE, value })
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((next, fail) => {
    resolve = next
    reject = fail
  })
  return Object.freeze({ promise, resolve, reject })
}

async function settle(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve()
}

function activeConversation(controller: ReturnType<typeof createConversationController>) {
  const active = controller.getSnapshot().active
  if (!active) throw new Error('expected an active conversation')
  return active
}

beforeEach(() => {
  sessionStorage.clear()
})

it('applies committed facts, then tab-local steering, then refresh exactly once while stale claims cannot steer', async () => {
  const root = presentation(message('root', null, 0, 'user', 'root', 1))
  const oldTip = presentation(message('old-tip', root.header.id, 0, 'assistant', 'old', 2))
  const newTip = presentation(message('new-tip', root.header.id, 1, 'assistant', 'new', 3))
  const durableFact = presentation(
    message('durable-fact', root.header.id, 2, 'assistant', 'durable', 4),
  )
  const staleDurableFact = presentation(
    message('stale-durable-fact', root.header.id, 3, 'assistant', 'stale durable', 5),
  )
  const staleTip = presentation(
    message('stale-tip', root.header.id, 4, 'assistant', 'must not select', 6),
  )
  let currentDestination = destination(
    resolvingConversationSelectionTarget({ kind: 'default' }),
    1,
    [root, oldTip],
  )
  let holdSelectionReads = false
  const heldSelection = deferred<void>()
  const openSelection = vi.fn<ConversationProjectionSource['openSelection']>(
    async (
      _chatId: ChatId,
      target: ConversationSelectionProofTarget,
      _onPoint,
      _signal,
    ): Promise<ConversationReadEnvelope<ConversationProjectionOpenResult>> => {
      if (holdSelectionReads) await heldSelection.promise
      return envelope(
        sealConversationSelection(
          destination(
            target,
            currentDestination.proof.structuralVersion,
            currentDestination.proof.pathHeaders.map((header) => {
              const selected = [root, oldTip, newTip, durableFact, staleDurableFact, staleTip].find(
                (row) => row.header.id === header.id,
              )
              if (!selected) throw new Error(`missing test presentation ${header.id}`)
              return selected
            }),
          ),
        ),
      )
    },
  )
  const never = async (): Promise<never> => await new Promise<never>(() => {})
  const source = {
    loadChat: vi.fn(async () => envelope(currentDestination.chat)),
    openSelection,
    loadForks: vi.fn(never),
    loadChildAtPosition: vi.fn(never),
    loadTopology: vi.fn(never),
    loadTranscriptPage: vi.fn(never),
    loadInspector: vi.fn(never),
    loadPreviews: vi.fn(async () => envelope([])),
  } satisfies ConversationProjectionSource
  const navigation = new NavigationPort()
  const controller = createConversationController()
  controller.reconcileWorkspace(FENCE)
  controller.setProjectionSource(source)
  controller.setNavigationPort(navigation)
  navigation.open(CHAT_ID)
  await settle()

  expect(selectedLeaf(activeConversation(controller).destination)).toBe(oldTip.header.id)
  openSelection.mockClear()
  source.loadChat.mockClear()
  const retainExactFacts = controller.claimOperation({ chatId: CHAT_ID, steering: 'preserve' })
  const currentClaim = controller.claimOperation({ chatId: CHAT_ID, steering: 'select-result' })
  const selectedTarget = fixedConversationSelectionTarget(
    { kind: 'tip', messageId: newTip.header.id },
    newTip.header.id,
  )
  currentDestination = destination(selectedTarget, 2, [root, newTip])
  holdSelectionReads = true
  let publications = 0
  const unsubscribe = controller.subscribe(() => {
    publications += 1
  })

  const accepted = controller.acceptLocalResult(currentClaim, {
    kind: 'select-committed',
    receipt: Object.freeze({ ...FENCE, destination: currentDestination }),
    committedEffect: Object.freeze({
      ...FENCE,
      chatId: CHAT_ID,
      source: 'local',
      kind: 'changed',
      revisions: Object.freeze([
        Object.freeze({
          header: durableFact.header,
          structuralVersion: 2,
          presentation: durableFact,
        }),
      ]),
      refresh: Object.freeze({ chat: true, headers: Object.freeze([newTip.header.id]) }),
      structural: exactStructuralTransition(2, [2], [durableFact.header.id]),
    }),
  })

  expect(accepted).toEqual({ accepted: true })
  expect(publications).toBe(1)
  expect(activeConversation(controller).headerFacts.get(durableFact.header.id)).toEqual(
    durableFact.header,
  )
  expect(selectedLeaf(activeConversation(controller).destination)).toBe(newTip.header.id)
  expect(openSelection).toHaveBeenCalledTimes(1)
  expect(openSelection.mock.calls[0]?.[1]).toMatchObject({
    kind: 'resolve-selection',
    selection: { kind: 'tip', messageId: newTip.header.id } satisfies ActiveBranchSelection,
  })
  expect(source.loadChat).not.toHaveBeenCalled()

  holdSelectionReads = false
  heldSelection.resolve()
  await settle()
  expect(activeConversation(controller).destination.kind).toBe('ready')
  openSelection.mockClear()

  const staleClaim = controller.claimOperation({ chatId: CHAT_ID, steering: 'select-result' })
  const currentClaimAfterStale = controller.claimOperation({
    chatId: CHAT_ID,
    steering: 'select-result',
  })
  const staleTarget = fixedConversationSelectionTarget(
    { kind: 'tip', messageId: staleTip.header.id },
    staleTip.header.id,
  )
  const publicationsBeforeStale = publications
  const rejected = controller.acceptLocalResult(staleClaim, {
    kind: 'select-committed',
    receipt: Object.freeze({
      ...FENCE,
      destination: destination(staleTarget, 3, [root, staleTip]),
    }),
    committedEffect: Object.freeze({
      ...FENCE,
      chatId: CHAT_ID,
      source: 'local',
      kind: 'changed',
      revisions: Object.freeze([
        Object.freeze({
          header: staleDurableFact.header,
          structuralVersion: 3,
          presentation: staleDurableFact,
        }),
      ]),
      structural: exactStructuralTransition(3, [3], [staleDurableFact.header.id]),
    }),
  })

  expect(rejected).toEqual({ accepted: false })
  expect(publications - publicationsBeforeStale).toBe(1)
  expect(activeConversation(controller).headerFacts.get(staleDurableFact.header.id)).toEqual(
    staleDurableFact.header,
  )
  expect(activeConversation(controller).headerFacts.has(staleTip.header.id)).toBe(false)
  expect(selectedLeaf(activeConversation(controller).destination)).toBe(newTip.header.id)
  expect(openSelection).not.toHaveBeenCalled()

  controller.cancelOperation(currentClaimAfterStale)
  controller.cancelOperation(retainExactFacts)
  unsubscribe()
})

it('extends an accepted long path from only the committed suffix', async () => {
  const rows: ReturnType<typeof presentation>[] = []
  let parentId: MessageId | null = null
  for (let index = 0; index < 2_048; index += 1) {
    const row = presentation(
      message(
        `path-${index}`,
        parentId,
        0,
        index % 2 === 0 ? 'user' : 'assistant',
        `path row ${index}`,
        index + 1,
      ),
    )
    rows.push(row)
    parentId = row.header.id
  }
  const initialTarget = Object.freeze({
    kind: 'resolve-selection' as const,
    selection: Object.freeze({ kind: 'default' as const }),
  })
  const initial = destination(initialTarget, 1, rows)
  const never = async (): Promise<never> => await new Promise<never>(() => {})
  const source = {
    loadChat: vi.fn(async () => envelope(initial.chat)),
    openSelection: vi.fn(async () => envelope(sealConversationSelection(initial))),
    loadForks: vi.fn(never),
    loadChildAtPosition: vi.fn(never),
    loadTopology: vi.fn(never),
    loadTranscriptPage: vi.fn(never),
    loadInspector: vi.fn(never),
    loadPreviews: vi.fn(async () => envelope([])),
  } satisfies ConversationProjectionSource
  const navigation = new NavigationPort()
  const controller = createConversationController()
  controller.reconcileWorkspace(FENCE)
  controller.setProjectionSource(source)
  controller.setNavigationPort(navigation)
  navigation.open(CHAT_ID)
  await settle()

  const activeBefore = activeConversation(controller)
  if (activeBefore.destination.kind !== 'ready') throw new Error('expected ready destination')
  const retainedPath = activeBefore.destination.spine.path
  const materializePrefix = vi.spyOn(retainedPath, 'materializeNodes')
  const materializePrefixIds = vi.spyOn(retainedPath, 'materializeIds')
  const user = presentation(
    message('path-user', parentId, 0, 'user', 'one more row', rows.length + 1),
  )
  const assistant = presentation(
    message('path-assistant', user.header.id, 0, 'assistant', '', rows.length + 2),
  )
  const target = fixedConversationSelectionTarget(
    { kind: 'tip', messageId: assistant.header.id },
    assistant.header.id,
  )
  let fallbackHeaderReads = 0
  const fallbackPrefix = new Proxy([...rows.map((row) => row.header), user.header], {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/.test(property)) fallbackHeaderReads += 1
      const value: unknown = Reflect.get(target, property, receiver)
      return value
    },
  })
  const transition: ConversationAppendSelectionTransition = Object.freeze({
    kind: 'append-transition',
    chat: chat(3, assistant.header.id),
    target,
    proof: Object.freeze({
      chatId: CHAT_ID,
      structuralVersion: 3,
      tipId: assistant.header.id,
    }),
    base: Object.freeze({
      chatId: CHAT_ID,
      structuralVersion: 1,
      tipId: parentId,
    }),
    suffixHeaders: Object.freeze([user.header, assistant.header]),
    forks: Object.freeze([
      Object.freeze({
        parentId,
        selectedMessageId: user.header.id,
        slotVersion: 1,
        position: 0,
        liveCount: 1,
        previousMessageId: null,
        nextMessageId: null,
        firstMessageId: user.header.id,
        lastMessageId: user.header.id,
      }),
      Object.freeze({
        parentId: user.header.id,
        selectedMessageId: assistant.header.id,
        slotVersion: 1,
        position: 0,
        liveCount: 1,
        previousMessageId: null,
        nextMessageId: null,
        firstMessageId: assistant.header.id,
        lastMessageId: assistant.header.id,
      }),
    ]),
    presentations: Object.freeze([user, assistant]),
    fallback: Object.freeze({
      prefixHeaders: fallbackPrefix,
      finalHeader: assistant.header,
    }),
  })
  const claim = controller.claimOperation({
    chatId: CHAT_ID,
    steering: 'select-result',
  })

  expect(
    controller.acceptLocalResult(claim, {
      kind: 'select-transition',
      receipt: Object.freeze({ ...FENCE, transition }),
      committedEffect: Object.freeze({
        ...FENCE,
        chatId: CHAT_ID,
        source: 'local',
        kind: 'changed',
        revisions: Object.freeze([
          Object.freeze({
            header: user.header,
            structuralVersion: 2,
            presentation: user,
          }),
          Object.freeze({
            header: assistant.header,
            structuralVersion: 3,
            presentation: assistant,
          }),
        ]),
        structural: exactStructuralTransition(3, [2, 3], [user.header.id, assistant.header.id]),
      }),
    }),
  ).toEqual({ accepted: true })

  const activeAfter = activeConversation(controller)
  expect(selectedLeaf(activeAfter.destination)).toBe(assistant.header.id)
  if (activeAfter.destination.kind !== 'ready') throw new Error('expected ready destination')
  expect(activeAfter.destination.spine.path.length).toBe(rows.length + 2)
  expect(activeAfter.destination.spine.forkFor(user.header.id)).toMatchObject({
    selectedMessageId: user.header.id,
    liveCount: 1,
    position: 0,
  })
  expect(activeAfter.destination.spine.forkFor(assistant.header.id)).toMatchObject({
    selectedMessageId: assistant.header.id,
    liveCount: 1,
    position: 0,
  })
  expect(activeAfter.destination.spine.path.get(rows[1_024]?.header.id as MessageId)).toBe(
    rows[1_024]?.header,
  )
  expect(materializePrefix).not.toHaveBeenCalled()
  expect(materializePrefixIds).not.toHaveBeenCalled()
  expect(fallbackHeaderReads).toBe(0)
  expect(activeAfter.transcript.kind).toBe('ready')
  if (activeAfter.transcript.kind !== 'ready') throw new Error('expected ready transcript')
  expect(
    transcriptBodyWindowFindRow(activeAfter.transcript.window, user.header.id)?.message,
  ).toMatchObject({ id: user.header.id, content: user.message.content })
  expect(
    transcriptBodyWindowFindRow(activeAfter.transcript.window, assistant.header.id)?.message,
  ).toMatchObject({ id: assistant.header.id, content: assistant.message.content })
})

it('publishes a regenerate transition with the exact new sibling slot and no fork reread', async () => {
  const parent = presentation(message('regenerate-parent', null, 0, 'user', 'prompt', 1))
  const oldAssistant = presentation(
    message('regenerate-old', parent.header.id, 0, 'assistant', 'old answer', 2),
  )
  const initial = destination(
    Object.freeze({
      kind: 'resolve-selection' as const,
      selection: Object.freeze({ kind: 'default' as const }),
    }),
    1,
    [parent, oldAssistant],
  )
  const never = async (): Promise<never> => await new Promise<never>(() => {})
  const source = {
    loadChat: vi.fn(async () => envelope(initial.chat)),
    openSelection: vi.fn(async () => envelope(sealConversationSelection(initial))),
    loadForks: vi.fn(never),
    loadChildAtPosition: vi.fn(never),
    loadTopology: vi.fn(never),
    loadTranscriptPage: vi.fn(never),
    loadInspector: vi.fn(never),
    loadPreviews: vi.fn(async () => envelope([])),
  } satisfies ConversationProjectionSource
  const navigation = new NavigationPort()
  const controller = createConversationController()
  controller.reconcileWorkspace(FENCE)
  controller.setProjectionSource(source)
  controller.setNavigationPort(navigation)
  navigation.open(CHAT_ID)
  await settle()

  const newAssistant = presentation(
    message('regenerate-new', parent.header.id, 1, 'assistant', '', 3),
  )
  const parentKey = childListKey(CHAT_ID, parent.header.id)
  const beforeState = Object.freeze({
    id: parentKey,
    chatId: CHAT_ID,
    parentId: parent.header.id,
    version: 1,
    updatedAt: 2,
    liveCount: 1,
    firstLiveChildId: oldAssistant.header.id,
    lastLiveChildId: oldAssistant.header.id,
    nextSiblingIndex: 1,
  })
  const beforeTail = Object.freeze({
    id: oldAssistant.header.id,
    chatId: CHAT_ID,
    parentId: parent.header.id,
    parentKey,
    position: 0,
    previousMessageId: null,
    nextMessageId: null,
  })
  const updatedOldMember = Object.freeze({
    ...beforeTail,
    nextMessageId: newAssistant.header.id,
  })
  const newMember = Object.freeze({
    id: newAssistant.header.id,
    chatId: CHAT_ID,
    parentId: parent.header.id,
    parentKey,
    position: 1,
    previousMessageId: oldAssistant.header.id,
    nextMessageId: null,
  })
  const finalState = Object.freeze({
    ...beforeState,
    version: 2,
    updatedAt: 3,
    liveCount: 2,
    lastLiveChildId: newAssistant.header.id,
    nextSiblingIndex: 2,
  })
  const expectedFork = Object.freeze({
    parentId: parent.header.id,
    selectedMessageId: newAssistant.header.id,
    slotVersion: 2,
    position: 1,
    liveCount: 2,
    previousMessageId: oldAssistant.header.id,
    nextMessageId: null,
    firstMessageId: oldAssistant.header.id,
    lastMessageId: newAssistant.header.id,
  }) satisfies ActiveBranchForkSlot
  const target = fixedConversationSelectionTarget(
    { kind: 'tip', messageId: newAssistant.header.id },
    newAssistant.header.id,
  )
  const transition: ConversationAppendSelectionTransition = Object.freeze({
    kind: 'append-transition',
    chat: chat(2, newAssistant.header.id),
    target,
    proof: Object.freeze({
      chatId: CHAT_ID,
      structuralVersion: 2,
      tipId: newAssistant.header.id,
    }),
    base: Object.freeze({
      chatId: CHAT_ID,
      structuralVersion: 1,
      tipId: parent.header.id,
    }),
    suffixHeaders: Object.freeze([newAssistant.header]),
    forks: Object.freeze([expectedFork]),
    presentations: Object.freeze([newAssistant]),
    fallback: Object.freeze({
      prefixHeaders: Object.freeze([parent.header]),
      finalHeader: newAssistant.header,
    }),
  })
  const publishedForks: Array<ActiveBranchForkSlot | undefined> = []
  const unsubscribe = controller.subscribe(() => {
    const active = activeConversation(controller)
    if (
      active.destination.kind === 'ready' &&
      active.destination.spine.resolvedLeafId === newAssistant.header.id
    ) {
      publishedForks.push(active.destination.spine.forkFor(newAssistant.header.id))
    }
  })
  const forkReadsBefore = source.loadForks.mock.calls.length
  const claim = controller.claimOperation({ chatId: CHAT_ID, steering: 'select-result' })

  expect(
    controller.acceptLocalResult(claim, {
      kind: 'select-transition',
      receipt: Object.freeze({ ...FENCE, transition }),
      committedEffect: Object.freeze({
        ...FENCE,
        chatId: CHAT_ID,
        source: 'local',
        kind: 'changed',
        revisions: Object.freeze([
          Object.freeze({
            header: newAssistant.header,
            structuralVersion: 2,
            presentation: newAssistant,
          }),
        ]),
        childSlots: Object.freeze([
          Object.freeze({
            before: beforeState,
            beforeTail,
            state: finalState,
            mode: 'append' as const,
            upserts: Object.freeze([updatedOldMember, newMember]),
            removedMessageIds: Object.freeze([]),
          }),
        ]),
        structural: exactStructuralTransition(2, [2], [newAssistant.header.id]),
      }),
    }),
  ).toEqual({ accepted: true })
  unsubscribe()

  const active = activeConversation(controller)
  expect(active.destination.kind).toBe('ready')
  if (active.destination.kind !== 'ready') throw new Error('expected ready destination')
  expect(active.destination.spine.resolvedLeafId).toBe(newAssistant.header.id)
  expect(active.destination.spine.forkFor(newAssistant.header.id)).toEqual(expectedFork)
  expect(publishedForks).toEqual([expectedFork])
  expect(source.loadForks).toHaveBeenCalledTimes(forkReadsBefore)
})

it.each([
  {
    name: 'exact presentation followed by invalidation',
    order: 'exact-then-invalidation' as const,
    expectedText: 'updated tip',
    expectedBodyVersion: 2,
    expectedExact: false,
  },
  {
    name: 'invalidation followed by exact presentation',
    order: 'invalidation-then-exact' as const,
    expectedText: 'updated tip',
    expectedBodyVersion: 2,
    expectedExact: true,
  },
  {
    name: 'newer header without a presentation',
    order: 'header-only' as const,
    expectedText: 'original tip',
    expectedBodyVersion: 1,
    expectedExact: false,
  },
])('reduces pending route knowledge causally: $name', ({
  order,
  expectedText,
  expectedBodyVersion,
  expectedExact,
}) => {
  const root = presentation(message('route-root', null, 0, 'user', 'root', 1))
  const originalTipMessage = message('route-tip', root.header.id, 0, 'assistant', 'original tip', 2)
  const originalTip = presentation(originalTipMessage)
  const updatedTip = (() => {
    const next = {
      ...originalTipMessage,
      content: [{ type: 'output_text' as const, text: 'updated tip' }],
      nodeVersion: 1,
    }
    const { header } = splitMessageForStorage(next, { bodyVersion: 2 })
    return Object.freeze({ header, message: next, bodyVersion: 2 })
  })()
  const selected = destination(
    fixedConversationSelectionTarget(
      { kind: 'tip', messageId: originalTip.header.id },
      originalTip.header.id,
    ),
    1,
    [root, originalTip],
  )
  const exactEffect: ConversationCommittedEffect = Object.freeze({
    ...FENCE,
    chatId: CHAT_ID,
    source: 'local',
    kind: 'changed',
    structural: NO_STRUCTURAL_TRANSITION,
    revisions: Object.freeze([
      Object.freeze({
        header: updatedTip.header,
        structuralVersion: 1,
        presentation: updatedTip,
      }),
    ]),
  })
  const invalidationEffect: ConversationCommittedEffect = Object.freeze({
    ...FENCE,
    chatId: CHAT_ID,
    source: 'invalidation',
    kind: 'changed',
    structural: NO_STRUCTURAL_TRANSITION,
    refresh: Object.freeze({ bodies: Object.freeze([originalTip.header.id]) }),
  })
  const headerOnlyEffect: ConversationCommittedEffect = Object.freeze({
    ...FENCE,
    chatId: CHAT_ID,
    source: 'remote',
    kind: 'changed',
    structural: NO_STRUCTURAL_TRANSITION,
    revisions: Object.freeze([Object.freeze({ header: updatedTip.header, structuralVersion: 1 })]),
  })

  let publicationCount = 0
  const readStarts: Array<{ readonly kind: string; readonly publicationCount: number }> = []
  const pendingRead = (kind: string): Promise<never> => {
    readStarts.push({ kind, publicationCount })
    return new Promise<never>(() => {})
  }
  const source = {
    loadChat: vi.fn(async () => pendingRead('chat')),
    openSelection: vi.fn(async () => pendingRead('selection')),
    loadForks: vi.fn(async () => pendingRead('forks')),
    loadChildAtPosition: vi.fn(async () => pendingRead('child-position')),
    loadTopology: vi.fn(async () => pendingRead('topology')),
    loadTranscriptPage: vi.fn(async () => pendingRead('transcript')),
    loadInspector: vi.fn(async () => pendingRead('inspector')),
    loadPreviews: vi.fn(async () => pendingRead('previews')),
  } satisfies ConversationProjectionSource
  const navigation = new NavigationPort()
  const controller = createConversationController()
  controller.reconcileWorkspace(FENCE)
  controller.setProjectionSource(source)
  controller.setNavigationPort(navigation)
  const claim = controller.claimOperation({
    chatId: CHAT_ID,
    steering: 'select-result',
    selectionDelivery: 'route-handoff',
    routeOwner: createConversationRouteOwnerController().owner,
  })
  const receipt = controller.acceptLocalResult(claim, {
    kind: 'select-committed',
    receipt: Object.freeze({ ...FENCE, destination: selected }),
    committedEffect: Object.freeze({
      ...FENCE,
      chatId: CHAT_ID,
      source: 'local',
      kind: 'changed',
      structural: NO_STRUCTURAL_TRANSITION,
    }),
  })
  if (!receipt.accepted) {
    throw new Error('expected a pending route handoff')
  }
  if (receipt.routeDelivery.kind !== 'handoff') {
    throw new Error('expected a live route handoff')
  }
  if (order === 'exact-then-invalidation') {
    controller.applyCommittedEffects([exactEffect, invalidationEffect])
  } else if (order === 'invalidation-then-exact') {
    controller.applyCommittedEffects([invalidationEffect, exactEffect])
  } else {
    controller.applyCommittedEffect(headerOnlyEffect)
  }

  const snapshots: ReturnType<typeof controller.getSnapshot>[] = []
  controller.subscribe(() => {
    publicationCount += 1
    snapshots.push(controller.getSnapshot())
  })
  navigation.open(CHAT_ID, receipt.routeDelivery.handoff)

  expect(publicationCount).toBeGreaterThanOrEqual(1)
  expect(readStarts.length).toBeGreaterThan(0)
  const privateFrameReads = readStarts.filter((read) => read.publicationCount === 0)
  const residualReads = readStarts.filter((read) => read.publicationCount >= 1)
  expect(privateFrameReads).toEqual([{ kind: 'transcript', publicationCount: 0 }])
  expect(residualReads.length).toBeGreaterThan(0)
  expect(residualReads.every((read) => read.publicationCount >= 1)).toBe(true)
  expect(residualReads.some((read) => read.kind === 'forks')).toBe(true)
  expect(source.openSelection).not.toHaveBeenCalled()
  expect(source.loadChat).not.toHaveBeenCalled()
  const active = snapshots[0]?.active
  expect(active?.destination.kind).toBe('ready')
  if (active?.destination.kind !== 'ready' || active.transcript.kind === 'absent') {
    throw new Error('expected the first publication to contain a ready transcript')
  }
  expect(active.chat?.structuralVersion).toBe(active.destination.spine.structuralVersion)
  expect(active.transcript.window.pathIdentity).toBe(active.destination.spine.path.identity)
  const row = transcriptBodyWindowFindRow(active.transcript.window, originalTip.header.id)
  expect(row).toBeDefined()
  const content = row?.message.content[0]
  expect(content && 'text' in content ? content.text : null).toBe(expectedText)
  expect(row?.bodyVersion).toBe(expectedBodyVersion)
  expect(row?.bodyExact).toBe(expectedExact)
  expect(active.transcript.window.staleBodyCount).toBe(expectedExact ? 0 : 1)
})

it('makes the structural transition the only topology invalidation owner', () => {
  const inserted = presentation(message('inserted', null, 0, 'user', 'inserted', 1))
  const revision = Object.freeze({
    header: inserted.header,
    structuralVersion: 2,
    changed: Object.freeze({ structure: true, body: true }),
    presentation: inserted,
  })
  const exactCommit: CommitEnvelope<null> = Object.freeze({
    ...FENCE,
    commitId: 'exact-commit',
    effectScope: 'workspace',
    value: null,
    receipt: Object.freeze({
      chats: Object.freeze([]),
      constructions: Object.freeze([]),
      messageRevisions: Object.freeze([revision]),
      childSlots: Object.freeze([]),
    }),
    delta: Object.freeze({
      facts: Object.freeze([
        Object.freeze({
          kind: 'message-revision' as const,
          chatId: CHAT_ID,
          structuralVersion: 2,
          header: inserted.header,
          changed: revision.changed,
        }),
      ]),
      invalidations: Object.freeze([
        Object.freeze({
          kind: 'message-header' as const,
          chatId: CHAT_ID,
          messageIds: Object.freeze([inserted.header.id]),
        }),
      ]),
    }),
  })

  const exact = conversationCommittedEffectForCommit(exactCommit, CHAT_ID)
  expect(exact).toMatchObject({
    kind: 'changed',
    structural: {
      kind: 'exact-delta',
      toVersion: 2,
      structuralVersions: [2],
      messageIds: [inserted.header.id],
    },
  })
  if (exact.kind !== 'changed') throw new Error('expected changed exact effect')
  expect(exact.refresh).toBeUndefined()

  const incompleteCommit: CommitEnvelope<null> = Object.freeze({
    ...FENCE,
    commitId: 'incomplete-commit',
    effectScope: 'workspace',
    value: null,
    receipt: Object.freeze({
      chats: Object.freeze([]),
      constructions: Object.freeze([]),
      messageRevisions: Object.freeze([]),
      childSlots: Object.freeze([]),
    }),
    delta: Object.freeze({
      facts: Object.freeze([]),
      invalidations: Object.freeze([
        Object.freeze({
          kind: 'message-header' as const,
          chatId: CHAT_ID,
          messageIds: Object.freeze(['unknown-message']),
        }),
      ]),
    }),
  })

  expect(conversationCommittedEffectForCommit(incompleteCommit, CHAT_ID)).toMatchObject({
    kind: 'changed',
    structural: {
      kind: 'incomplete',
      toVersion: null,
      scope: ['unknown-message'],
    },
    refresh: { headers: ['unknown-message'] },
  })
  expectTypeOf<
    Parameters<typeof conversationCommittedEffectForCommit>['length']
  >().toEqualTypeOf<2>()
})

it('keeps the attempt handoff fact out of conversation refresh ownership', () => {
  const commit: CommitEnvelope<null> = Object.freeze({
    ...FENCE,
    commitId: 'attempt-target-committed',
    effectScope: 'workspace',
    value: null,
    receipt: Object.freeze({
      chats: Object.freeze([]),
      constructions: Object.freeze([]),
      messageRevisions: Object.freeze([]),
      childSlots: Object.freeze([]),
    }),
    delta: Object.freeze({
      facts: Object.freeze([
        Object.freeze({
          kind: 'attempt-target-committed' as const,
          streamId: 'stream-a',
          chatId: CHAT_ID,
          messageId: 'assistant',
          attemptKind: 'generation' as const,
          admissionSequence: 4,
          leaseRevision: 7,
          bodyVersion: 2,
        }),
      ]),
      invalidations: Object.freeze([]),
    }),
  })

  expect(conversationCommittedEffectForCommit(commit, CHAT_ID)).toEqual({
    ...FENCE,
    chatId: CHAT_ID,
    source: 'local',
    kind: 'changed',
    structural: { kind: 'none' },
  })
})
