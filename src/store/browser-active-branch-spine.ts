import type { Table, Transaction } from 'dexie'
import type {
  ActiveBranchSelection,
  ActiveBranchTargetUnavailable,
} from '../core/active-branch-spine'
import { compareLiveLeafRecency } from '../core/active-path'
import { childListKey, validateChildSlotProjection } from '../core/child-list-state'
import { treeParentKey } from '../core/message-tree-index'
import {
  type ConversationDestinationPoint,
  type ConversationSelectionProofTarget,
  fixedConversationSelectionTarget,
  type MessagePresentation,
} from '../core/messages'
import type { Chat, ChatId, ChildListState, ChildSlotMember, MessageId } from '../core/types'
import { readActiveBranchPathSlotFrameInTransaction } from './active-branch-fork-storage'
import { proveConversationSelectionFromExactPath } from './conversation-destination-seal'
import { exactCompoundPrefixBetween } from './indexeddb-key-ranges'
import {
  canonicalMessageHeaderRow,
  type MessageHeaderRow,
  sameMessageHeaderValue,
} from './message-storage'
import type { ConversationOpenResult } from './workspace-protocol'

const CHILD_MEMBER_POSITION_INDEX = '[chatId+parentKey+position]'
const PATH_PROOF_FRAME_ROWS = 64
const DESCENDANT_CHILD_PAGE_ROWS = 64

export interface BranchSelectionReadMeasurement {
  pointHeaderReads: number
  pathFrames: number
  pathHeaderReads: number
  descendantPageReads: number
  descendantRowsRead: number
  physicalHeaderReadRequests: number
  physicalHeaderRowsRead: number
  peakCachedHeaderRows: number
  peakTraversalRows: number
}

export function createBranchSelectionReadMeasurement(): BranchSelectionReadMeasurement {
  return {
    pointHeaderReads: 0,
    pathFrames: 0,
    pathHeaderReads: 0,
    descendantPageReads: 0,
    descendantRowsRead: 0,
    physicalHeaderReadRequests: 0,
    physicalHeaderRowsRead: 0,
    peakCachedHeaderRows: 0,
    peakTraversalRows: 0,
  }
}

export type ConversationOpenFrameStore =
  | 'messages'
  | 'childLists'
  | 'childSlotMembers'
  | 'messageBodies'

export type ConversationOpenFrameResult<T> =
  | { readonly kind: 'ready'; readonly value: T }
  | { readonly kind: 'stale' }

export type RunConversationOpenFrame = <T>(
  stores: readonly ConversationOpenFrameStore[],
  read: (tx: Transaction) => Promise<T>,
) => Promise<ConversationOpenFrameResult<T>>

class ConversationOpenFrameStaleError extends Error {}

class BrowserSelectionHeaderReader {
  private readonly cache = new Map<MessageId, MessageHeaderRow | undefined>()
  private readonly runFrame: RunConversationOpenFrame
  private readonly chatId: ChatId
  private readonly signal: AbortSignal | undefined
  private readonly measurement: BranchSelectionReadMeasurement | undefined
  private cachedHeaderRows = 0

  constructor(
    runFrame: RunConversationOpenFrame,
    chatId: ChatId,
    seedHeaders: readonly MessageHeaderRow[],
    signal?: AbortSignal,
    measurement?: BranchSelectionReadMeasurement,
  ) {
    this.runFrame = runFrame
    this.chatId = chatId
    this.signal = signal
    this.measurement = measurement
    for (const header of seedHeaders) this.remember(header.id, header)
  }

  async getHeader(messageId: MessageId): Promise<MessageHeaderRow | undefined> {
    if (this.cache.has(messageId)) return this.cache.get(messageId)
    throwIfAborted(this.signal)
    if (this.measurement) this.measurement.pointHeaderReads += 1
    const frame = await this.runFrame(['messages'], async (tx) =>
      tx.table<MessageHeaderRow, MessageId>('messages').get(messageId),
    )
    if (frame.kind === 'stale') throw new ConversationOpenFrameStaleError()
    const header = frame.value
    throwIfAborted(this.signal)
    if (this.measurement) {
      this.measurement.physicalHeaderReadRequests += 1
      if (header) this.measurement.physicalHeaderRowsRead += 1
    }
    this.remember(messageId, header)
    return this.cache.get(messageId)
  }

  async readLivePath(
    leafId: MessageId,
    selection: ActiveBranchSelection,
  ): Promise<
    | { readonly kind: 'ready'; readonly rows: readonly MessageHeaderRow[] }
    | ActiveBranchTargetUnavailable
  > {
    const reversed: MessageHeaderRow[] = []
    const seen = new Set<MessageId>()
    let messageId: MessageId | null = leafId
    while (messageId !== null) {
      throwIfAborted(this.signal)
      if (this.cache.has(messageId)) {
        const header = this.cache.get(messageId)
        if (!header || header.chatId !== this.chatId || header.deleted) {
          return { kind: 'unavailable', selection, reason: 'invalid-ancestry' }
        }
        if (seen.has(messageId)) {
          return { kind: 'unavailable', selection, reason: 'ancestry-cycle' }
        }
        seen.add(messageId)
        reversed.push(header)
        if (this.measurement) this.measurement.pathHeaderReads += 1
        messageId = header.parentId
        continue
      }
      await this.readParentWalkFrame(messageId)
    }
    reversed.reverse()
    return { kind: 'ready', rows: Object.freeze(reversed) }
  }

  private async readParentWalkFrame(messageId: MessageId): Promise<void> {
    const frame = await this.runFrame(['messages'], async (tx) => {
      const rows: Array<{ readonly id: MessageId; readonly header?: MessageHeaderRow }> = []
      let nextMessageId: MessageId | null = messageId
      for (
        let readCount = 0;
        readCount < PATH_PROOF_FRAME_ROWS && nextMessageId !== null;
        readCount += 1
      ) {
        const currentId: MessageId = nextMessageId
        const header = await tx.table<MessageHeaderRow, MessageId>('messages').get(currentId)
        rows.push(header ? { id: currentId, header } : { id: currentId })
        if (!header || header.chatId !== this.chatId || header.deleted) break
        nextMessageId = header.parentId
      }
      return Object.freeze(rows)
    })
    if (frame.kind === 'stale') throw new ConversationOpenFrameStaleError()
    if (this.measurement) this.measurement.pathFrames += 1
    for (const row of frame.value) {
      if (this.measurement) {
        this.measurement.physicalHeaderReadRequests += 1
        if (row.header) this.measurement.physicalHeaderRowsRead += 1
      }
      this.remember(row.id, row.header)
    }
  }

  async newestDescendantLeafId(selected: MessageHeaderRow): Promise<MessageId | null> {
    interface TraversalFrame {
      readonly parent: MessageHeaderRow
      after: readonly [number, MessageId] | null
      foundLiveChild: boolean
      pageComplete: boolean
      liveChildren: readonly MessageHeaderRow[]
      nextChildIndex: number
    }
    const stack: TraversalFrame[] = [
      {
        parent: selected,
        after: null,
        foundLiveChild: false,
        pageComplete: false,
        liveChildren: Object.freeze([]),
        nextChildIndex: 0,
      },
    ]
    let retainedPageRows = 0
    let best: MessageHeaderRow | null = null
    while (stack.length > 0) {
      throwIfAborted(this.signal)
      const frame = stack.at(-1) as TraversalFrame
      if (frame.nextChildIndex < frame.liveChildren.length) {
        const child = frame.liveChildren[frame.nextChildIndex] as MessageHeaderRow
        frame.nextChildIndex += 1
        stack.push({
          parent: child,
          after: null,
          foundLiveChild: false,
          pageComplete: false,
          liveChildren: Object.freeze([]),
          nextChildIndex: 0,
        })
      } else if (frame.liveChildren.length > 0) {
        retainedPageRows -= frame.liveChildren.length
        frame.liveChildren = Object.freeze([])
        frame.nextChildIndex = 0
        if (frame.pageComplete) {
          stack.pop()
        }
      } else if (frame.pageComplete) {
        if (!frame.foundLiveChild) {
          if (!best || compareLiveLeafRecency(frame.parent, best) > 0) {
            best = frame.parent
          }
        }
        stack.pop()
      } else {
        const page = await this.readChildPage(frame.parent.id, frame.after)
        const liveChildren = Object.freeze(page.rows.filter((header) => !header.deleted))
        frame.after = page.after
        frame.pageComplete = page.complete
        frame.foundLiveChild ||= liveChildren.length > 0
        frame.liveChildren = liveChildren
        frame.nextChildIndex = 0
        retainedPageRows += liveChildren.length
      }
      if (this.measurement) {
        this.measurement.peakTraversalRows = Math.max(
          this.measurement.peakTraversalRows,
          stack.length + retainedPageRows,
        )
      }
    }
    return best?.id ?? null
  }

  private async readChildPage(
    parentId: MessageId,
    after: readonly [number, MessageId] | null,
  ): Promise<{
    readonly rows: readonly MessageHeaderRow[]
    readonly complete: boolean
    readonly after: readonly [number, MessageId] | null
  }> {
    const parentKey = treeParentKey(parentId)
    const range = exactCompoundPrefixBetween([this.chatId, parentKey])
    throwIfAborted(this.signal)
    const frame = await this.runFrame(['messages'], async (tx) =>
      tx
        .table<MessageHeaderRow, MessageId>('messages')
        .where('[chatId+treeParentKey+siblingIndex+id]')
        .between(
          after ? [this.chatId, parentKey, after[0], after[1]] : range[0],
          range[1],
          after === null,
          false,
        )
        .limit(DESCENDANT_CHILD_PAGE_ROWS)
        .toArray(),
    )
    if (frame.kind === 'stale') throw new ConversationOpenFrameStaleError()
    const rows = frame.value.map(canonicalMessageHeaderRow)
    throwIfAborted(this.signal)
    for (const header of rows) {
      if (header.chatId !== this.chatId || header.parentId !== parentId) {
        throw new Error(`ActiveBranchDescendantPageInvalid:${header.id}`)
      }
    }
    if (this.measurement) {
      this.measurement.descendantPageReads += 1
      this.measurement.descendantRowsRead += rows.length
      this.measurement.physicalHeaderReadRequests += 1
      this.measurement.physicalHeaderRowsRead += rows.length
    }
    const last = rows.at(-1)
    return Object.freeze({
      rows: Object.freeze(rows),
      complete: rows.length < DESCENDANT_CHILD_PAGE_ROWS,
      after: last ? Object.freeze([last.siblingIndex, last.id] as const) : null,
    })
  }

  private remember(messageId: MessageId, header: MessageHeaderRow | undefined): void {
    const canonical = header ? canonicalMessageHeaderRow(header) : undefined
    const previous = this.cache.get(messageId)
    if (canonical && !previous) this.cachedHeaderRows += 1
    else if (!canonical && previous) this.cachedHeaderRows -= 1
    this.cache.set(messageId, canonical)
    if (this.measurement) {
      this.measurement.peakCachedHeaderRows = Math.max(
        this.measurement.peakCachedHeaderRows,
        this.cachedHeaderRows,
      )
    }
  }
}

export interface ConversationSelectionReadAccess {
  readonly runFrame: RunConversationOpenFrame
  readTerminalPresentation(
    messageId: MessageId,
    signal?: AbortSignal,
  ): Promise<ConversationOpenFrameResult<MessagePresentation | undefined>>
}

type ConversationOpenTerminalHint =
  | { readonly kind: 'empty' }
  | {
      readonly kind: 'fixed' | 'candidate'
      readonly header: MessageHeaderRow
    }
  | { readonly kind: 'unresolved' }

export type ConversationOpenInitialReceipt =
  | {
      readonly kind: 'missing'
      readonly chatId: ChatId
      readonly target: ConversationSelectionProofTarget
    }
  | {
      readonly kind: 'unavailable'
      readonly chat: Chat
      readonly target: ConversationSelectionProofTarget
      readonly retryTarget: ConversationSelectionProofTarget
      readonly reason: ActiveBranchTargetUnavailable['reason']
    }
  | {
      readonly kind: 'ready'
      readonly chat: Chat
      readonly target: ConversationSelectionProofTarget
      readonly retryTarget: ConversationSelectionProofTarget
      readonly stableSelection: ActiveBranchSelection
      readonly selectedHeader: MessageHeaderRow | null
      readonly selectedLeafState?: 'leaf' | 'internal'
      readonly terminalHint: ConversationOpenTerminalHint
      readonly seedHeaders: readonly MessageHeaderRow[]
    }

export async function readConversationOpenInitialReceiptInTransaction(
  tx: Transaction,
  chatId: ChatId,
  chat: Chat | undefined,
  target: ConversationSelectionProofTarget,
  signal?: AbortSignal,
  measurement?: BranchSelectionReadMeasurement,
): Promise<ConversationOpenInitialReceipt> {
  throwIfAborted(signal)
  if (!chat) {
    return Object.freeze({ kind: 'missing', chatId, target })
  }
  const selection = target.selection
  if (target.kind === 'fixed-empty') {
    return Object.freeze({
      kind: 'ready',
      chat,
      target,
      retryTarget: fixedConversationSelectionTarget(selection, null),
      stableSelection: selection,
      selectedHeader: null,
      terminalHint: Object.freeze({ kind: 'empty' }),
      seedHeaders: Object.freeze([]),
    })
  }
  const messages = tx.table<MessageHeaderRow, MessageId>('messages')
  const readHeader = async (messageId: MessageId) => {
    throwIfAborted(signal)
    const header = await messages.get(messageId)
    if (measurement) {
      measurement.pointHeaderReads += 1
      measurement.physicalHeaderReadRequests += 1
      if (header) measurement.physicalHeaderRowsRead += 1
    }
    return header ? canonicalMessageHeaderRow(header) : undefined
  }
  const fixedTerminalId =
    target.kind === 'fixed-tip'
      ? target.messageId
      : selection.kind === 'default'
        ? chat.lastUpdatedLeafId
        : selection.kind === 'tip'
          ? selection.messageId
          : undefined
  if (fixedTerminalId !== undefined) {
    if (fixedTerminalId === null) {
      return Object.freeze({
        kind: 'ready',
        chat,
        target,
        retryTarget: fixedConversationSelectionTarget(selection, null),
        stableSelection: selection,
        selectedHeader: null,
        terminalHint: Object.freeze({ kind: 'empty' }),
        seedHeaders: Object.freeze([]),
      })
    }
    const terminalHeader = await readHeader(fixedTerminalId)
    const selected = validSelectedHeader(terminalHeader, chatId, selection)
    if (selected.kind === 'unavailable') {
      return Object.freeze({
        kind: 'unavailable',
        chat,
        target,
        retryTarget: fixedConversationSelectionTarget(selection, fixedTerminalId),
        reason: selected.reason,
      })
    }
    return Object.freeze({
      kind: 'ready',
      chat,
      target,
      retryTarget: fixedConversationSelectionTarget(selection, selected.header.id),
      stableSelection: selection,
      selectedHeader: selected.header,
      terminalHint: Object.freeze({ kind: 'fixed', header: selected.header }),
      seedHeaders: Object.freeze([selected.header]),
    })
  }
  if (selection.kind !== 'message' && selection.kind !== 'sibling-position') {
    throw new Error('ConversationOpenSelectionResolutionInvalid')
  }
  const selectedHeader =
    selection.kind === 'sibling-position'
      ? await readLiveChildAtPosition(
          {
            childLists: tx.table<ChildListState, string>('childLists'),
            childSlotMembers: tx.table<ChildSlotMember, MessageId>('childSlotMembers'),
          },
          chatId,
          selection.parentId,
          selection.position,
          readHeader,
          signal,
        )
      : await readHeader(selection.messageId)
  if (selection.kind === 'sibling-position' && selectedHeader === null) {
    return Object.freeze({
      kind: 'unavailable',
      chat,
      target,
      retryTarget: target,
      reason: 'sibling-position-unavailable',
    })
  }
  const selected = validSelectedHeader(selectedHeader ?? undefined, chatId, selection)
  if (selected.kind === 'unavailable') {
    return Object.freeze({
      kind: 'unavailable',
      chat,
      target,
      retryTarget: target,
      reason: selected.reason,
    })
  }
  const stableSelection: ActiveBranchSelection =
    selection.kind === 'sibling-position'
      ? Object.freeze({
          kind: 'message',
          messageId: selected.header.id,
          ...(selection.observedTipId ? { observedTipId: selection.observedTipId } : {}),
        })
      : selection
  const selectedLeafState = await classifyLiveLeafInTransaction(tx, selected.header, signal)
  const retryTarget = fixedConversationSelectionTarget(stableSelection, selected.header.id)
  if (selectedLeafState === 'leaf') {
    return Object.freeze({
      kind: 'ready',
      chat,
      target,
      retryTarget,
      stableSelection,
      selectedHeader: selected.header,
      selectedLeafState,
      terminalHint: Object.freeze({ kind: 'fixed', header: selected.header }),
      seedHeaders: Object.freeze([selected.header]),
    })
  }
  const candidateId = selection.observedTipId ?? chat.lastUpdatedLeafId
  const candidate = candidateId === null ? undefined : await readHeader(candidateId)
  if (!candidate || candidate.chatId !== chatId || candidate.deleted) {
    return Object.freeze({
      kind: 'ready',
      chat,
      target,
      retryTarget,
      stableSelection,
      selectedHeader: selected.header,
      selectedLeafState,
      terminalHint: Object.freeze({ kind: 'unresolved' }),
      seedHeaders: Object.freeze([selected.header]),
    })
  }
  const seedHeaders = new Map<MessageId, MessageHeaderRow>([[selected.header.id, selected.header]])
  seedHeaders.set(candidate.id, candidate)
  return Object.freeze({
    kind: 'ready',
    chat,
    target,
    retryTarget,
    stableSelection,
    selectedHeader: selected.header,
    selectedLeafState,
    terminalHint: Object.freeze({ kind: 'candidate', header: candidate }),
    seedHeaders: Object.freeze([...seedHeaders.values()]),
  })
}

export async function resolveConversationOpenReceipt(
  access: ConversationSelectionReadAccess,
  receipt: ConversationOpenInitialReceipt,
  bodyDemand: 'terminal' | 'none',
  onTerminalPoint?: (point: ConversationDestinationPoint) => void,
  signal?: AbortSignal,
  measurement?: BranchSelectionReadMeasurement,
): Promise<ConversationOpenResult> {
  if (receipt.kind === 'missing') {
    return Object.freeze({ kind: 'missing', chatId: receipt.chatId, target: receipt.target })
  }
  if (receipt.kind === 'unavailable') {
    return Object.freeze({
      kind: 'unavailable',
      chat: receipt.chat,
      target: receipt.target,
      reason: receipt.reason,
    })
  }
  const owned = ownedConversationReadSignal(signal)
  const ownedLegs: Promise<unknown>[] = []
  let retryTarget = receipt.retryTarget
  try {
    if (receipt.terminalHint.kind === 'empty') {
      const slotFrame = await access.runFrame(['childLists'], (tx) =>
        readActiveBranchPathSlotFrameInTransaction(
          tx,
          receipt.chat.id,
          Object.freeze([]),
          owned.signal,
        ),
      )
      if (slotFrame.kind === 'stale') throw new ConversationOpenFrameStaleError()
      if (bodyDemand === 'terminal' && onTerminalPoint) {
        onTerminalPoint(
          Object.freeze({
            kind: 'empty-point',
            chat: receipt.chat,
            target: receipt.target,
            structuralVersion: receipt.chat.structuralVersion,
          }),
        )
      }
      return proveConversationSelectionFromExactPath({
        chat: receipt.chat,
        target: receipt.target,
        tipId: null,
        exactPathHeaders: Object.freeze([]),
        presentations: Object.freeze([]),
        forks: Object.freeze([]),
        terminalChildSlot: slotFrame.value.terminalChildSlot,
        snapshotOwnership: 'adopt',
      })
    }
    const reader = new BrowserSelectionHeaderReader(
      access.runFrame,
      receipt.chat.id,
      receipt.seedHeaders,
      owned.signal,
      measurement,
    )
    let leafHeader: MessageHeaderRow | null = null
    let exactPathHeaders: readonly MessageHeaderRow[] | undefined
    if (receipt.terminalHint.kind === 'fixed') {
      leafHeader = receipt.terminalHint.header
    } else if (receipt.terminalHint.kind === 'candidate' && receipt.selectedHeader) {
      const candidatePath = await reader.readLivePath(
        receipt.terminalHint.header.id,
        receipt.stableSelection,
      )
      if (
        candidatePath.kind === 'ready' &&
        candidatePath.rows.some((header) => header.id === receipt.selectedHeader?.id)
      ) {
        leafHeader = receipt.terminalHint.header
        exactPathHeaders = candidatePath.rows
      }
    }
    if (!leafHeader) {
      const selected = receipt.selectedHeader
      if (!selected) {
        return Object.freeze({
          kind: 'unavailable',
          chat: receipt.chat,
          target: receipt.target,
          reason: 'invalid-ancestry',
        })
      }
      const leafId = await reader.newestDescendantLeafId(selected)
      leafHeader = leafId === null ? null : ((await reader.getHeader(leafId)) ?? null)
      if (!leafHeader || leafHeader.chatId !== receipt.chat.id || leafHeader.deleted) {
        return Object.freeze({
          kind: 'unavailable',
          chat: receipt.chat,
          target: receipt.target,
          reason: 'invalid-ancestry',
        })
      }
    }
    retryTarget = fixedConversationSelectionTarget(receipt.stableSelection, leafHeader.id)
    const terminalPointPromise = (
      bodyDemand === 'terminal'
        ? readConversationTerminalPoint(
            access,
            receipt.chat,
            receipt.target,
            leafHeader,
            owned.signal,
          )
        : Promise.resolve(null)
    )
      .then((point) => {
        if (point) {
          if (onTerminalPoint) onTerminalPoint(point)
        }
        return point
      })
      .catch(() => null)
    ownedLegs.push(terminalPointPromise)
    const path = exactPathHeaders
      ? { kind: 'ready' as const, rows: exactPathHeaders }
      : await reader.readLivePath(leafHeader.id, receipt.stableSelection)
    throwIfAborted(signal)
    if (path.kind === 'unavailable') {
      return Object.freeze({
        kind: 'unavailable',
        chat: receipt.chat,
        target: receipt.target,
        reason: path.reason,
      })
    }
    const slotFramePromise = access.runFrame(['childLists', 'childSlotMembers'], (tx) =>
      readActiveBranchPathSlotFrameInTransaction(tx, receipt.chat.id, path.rows, owned.signal),
    )
    ownedLegs.push(slotFramePromise)
    const [terminalPoint, slotFrame] = await Promise.all([terminalPointPromise, slotFramePromise])
    throwIfAborted(signal)
    if (slotFrame.kind === 'stale') throw new ConversationOpenFrameStaleError()
    return proveConversationSelectionFromExactPath({
      chat: receipt.chat,
      target: receipt.target,
      tipId: leafHeader.id,
      exactPathHeaders: path.rows,
      presentations:
        terminalPoint?.kind === 'tip-point'
          ? Object.freeze([terminalPoint.presentation])
          : Object.freeze([]),
      forks: slotFrame.value.forks,
      terminalChildSlot: slotFrame.value.terminalChildSlot,
      snapshotOwnership: 'adopt',
    })
  } catch (error) {
    if (!(error instanceof ConversationOpenFrameStaleError)) throw error
    return Object.freeze({
      kind: 'stale',
      chat: receipt.chat,
      target: receipt.target,
      retryTarget,
    })
  } finally {
    if (!owned.signal.aborted) {
      owned.controller.abort(new DOMException('Conversation open scope closed', 'AbortError'))
    }
    owned.dispose()
    void Promise.allSettled(ownedLegs)
  }
}

async function readConversationTerminalPoint(
  access: ConversationSelectionReadAccess,
  chat: Chat,
  target: ConversationSelectionProofTarget,
  leafHeader: MessageHeaderRow,
  signal?: AbortSignal,
): Promise<ConversationDestinationPoint | null> {
  const frame = await access.readTerminalPresentation(leafHeader.id, signal)
  if (frame.kind === 'stale' || !frame.value) return null
  const presentation = frame.value
  const tipHeader = presentation.header
  if (
    tipHeader.id !== leafHeader.id ||
    tipHeader.chatId !== chat.id ||
    tipHeader.deleted ||
    presentation.message.id !== tipHeader.id ||
    presentation.message.chatId !== chat.id ||
    presentation.bodyVersion !== tipHeader.bodyVersion
  ) {
    throw new Error(`ConversationDestinationFrameHeaderInvalid:${leafHeader.id}`)
  }
  if (!sameMessageHeaderValue(tipHeader, leafHeader)) return null
  throwIfAborted(signal)
  return Object.freeze({
    kind: 'tip-point',
    chat,
    target,
    structuralVersion: chat.structuralVersion,
    presentation: Object.freeze(presentation),
  })
}

async function classifyLiveLeafInTransaction(
  tx: Transaction,
  header: MessageHeaderRow,
  signal?: AbortSignal,
): Promise<'leaf' | 'internal'> {
  const parentKey = childListKey(header.chatId, header.id)
  throwIfAborted(signal)
  const [state, firstMember] = await Promise.all([
    tx.table<ChildListState, string>('childLists').get(parentKey),
    tx
      .table<ChildSlotMember, MessageId>('childSlotMembers')
      .where(CHILD_MEMBER_POSITION_INDEX)
      .equals([header.chatId, parentKey, 0])
      .first(),
  ])
  throwIfAborted(signal)
  return validateChildSlotProjection({
    chatId: header.chatId,
    parentId: header.id,
    position: 0,
    state,
    member: firstMember,
  }).kind === 'ready'
    ? 'internal'
    : 'leaf'
}

export async function readActiveBranchChildAtPositionInTransaction(
  tx: Transaction,
  chatId: ChatId,
  parentId: MessageId | null,
  position: number,
  signal?: AbortSignal,
): Promise<MessageId | null> {
  const header = await readLiveChildAtPosition(
    {
      childLists: tx.table<ChildListState, string>('childLists'),
      childSlotMembers: tx.table<ChildSlotMember, MessageId>('childSlotMembers'),
    },
    chatId,
    parentId,
    position,
    (messageId) => tx.table<MessageHeaderRow, MessageId>('messages').get(messageId),
    signal,
  )
  return header?.id ?? null
}

async function readLiveChildAtPosition(
  tables: {
    readonly childLists: Table<ChildListState, string>
    readonly childSlotMembers: Table<ChildSlotMember, MessageId>
  },
  chatId: ChatId,
  parentId: MessageId | null,
  position: number,
  getHeader: (messageId: MessageId) => Promise<MessageHeaderRow | undefined>,
  signal?: AbortSignal,
): Promise<MessageHeaderRow | null> {
  if (!Number.isSafeInteger(position) || position < 0) return null
  const parentKey = childListKey(chatId, parentId)
  throwIfAborted(signal)
  const [state, member] = await Promise.all([
    tables.childLists.get(parentKey),
    tables.childSlotMembers
      .where(CHILD_MEMBER_POSITION_INDEX)
      .equals([chatId, parentKey, position])
      .first(),
  ])
  throwIfAborted(signal)
  const projected = validateChildSlotProjection({ chatId, parentId, position, state, member })
  if (projected.kind === 'unavailable') return null
  const header = await getHeader(projected.member.id)
  throwIfAborted(signal)
  if (!header || header.chatId !== chatId || header.deleted || header.parentId !== parentId) {
    throw new Error(`ActiveBranchChildSlotPositionInvalid:${chatId}:${position}`)
  }
  return header
}

function validSelectedHeader(
  header: MessageHeaderRow | undefined,
  chatId: ChatId,
  selection: ActiveBranchSelection,
): { readonly kind: 'ready'; readonly header: MessageHeaderRow } | ActiveBranchTargetUnavailable {
  if (!header) return { kind: 'unavailable', selection, reason: 'message-missing' }
  if (header.chatId !== chatId) {
    return { kind: 'unavailable', selection, reason: 'message-chat-mismatch' }
  }
  if (header.deleted) return { kind: 'unavailable', selection, reason: 'message-deleted' }
  return { kind: 'ready', header }
}

function ownedConversationReadSignal(parent: AbortSignal | undefined): {
  readonly controller: AbortController
  readonly signal: AbortSignal
  readonly dispose: () => void
} {
  const controller = new AbortController()
  if (!parent) return { controller, signal: controller.signal, dispose: () => undefined }
  if (parent.aborted) {
    controller.abort(parent.reason)
    return { controller, signal: controller.signal, dispose: () => undefined }
  }
  const abort = () => controller.abort(parent.reason)
  parent.addEventListener('abort', abort, { once: true })
  return {
    controller,
    signal: controller.signal,
    dispose: () => parent.removeEventListener('abort', abort),
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException('Active branch spine read aborted', 'AbortError')
}
