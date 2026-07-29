import { PersistentStringMap } from '../lib/persistent-string-map'
import type { MessageTreeNode } from './active-path'
import { type BranchPathDescriptor, createBranchPath } from './branch-session'
import { validateChildSlotProjection } from './child-list-state'
import type { ChatId, ChildListState, ChildSlotMember, MessageId } from './types'

export type ActiveBranchSelection =
  | { readonly kind: 'default' }
  | {
      readonly kind: 'message'
      readonly messageId: MessageId
      readonly observedTipId?: MessageId
    }
  // A tab tip is the exact end of that tab's selected path; another tab may
  // have added descendants, so it need not be a leaf in the shared graph.
  | { readonly kind: 'tip'; readonly messageId: MessageId }
  | {
      readonly kind: 'sibling-position'
      readonly parentId: MessageId | null
      readonly position: number
      readonly observedTipId?: MessageId
    }

export type ActiveBranchIntentTarget =
  | { readonly kind: 'fixed'; readonly messageId: MessageId | null }
  | { readonly kind: 'selection'; readonly selection: ActiveBranchSelection }

export interface ActiveBranchChildSlot {
  readonly parentId: MessageId | null
  readonly slotVersion: number
  readonly liveCount: number
  readonly nextSiblingIndex: number
}

export interface ActiveBranchForkSlot extends ActiveBranchChildSlot {
  readonly parentId: MessageId | null
  readonly selectedMessageId: MessageId
  readonly position: number
  readonly previousMessageId: MessageId | null
  readonly nextMessageId: MessageId | null
  readonly firstMessageId: MessageId
  readonly lastMessageId: MessageId
}

export interface ActiveBranchForkTarget {
  readonly parentId: MessageId | null
  readonly selectedMessageId: MessageId
}

export function materializeActiveBranchForkSlots(
  chatId: ChatId,
  headers: readonly ActiveBranchHeader[],
  childLists: readonly (ChildListState | undefined)[],
  childMembers: readonly (ChildSlotMember | undefined)[],
): readonly ActiveBranchForkSlot[] {
  if (headers.length !== childLists.length || headers.length !== childMembers.length) {
    throw new Error('ActiveBranchForkSlotInputLengthMismatch')
  }
  const slots: ActiveBranchForkSlot[] = []
  for (let index = 0; index < headers.length; index += 1) {
    const header = headers[index] as ActiveBranchHeader
    const childList = childLists[index]
    const member = childMembers[index]
    if (header.chatId !== chatId || header.deleted || !member || member.id !== header.id) {
      throw new Error(`ActiveBranchForkSlotHeaderInvalid:${header.id}`)
    }
    const projected = validateChildSlotProjection({
      chatId,
      parentId: header.parentId,
      position: member.position,
      state: childList,
      member,
    })
    if (projected.kind !== 'ready') {
      throw new Error(`ActiveBranchForkSlotUnavailable:${header.id}`)
    }
    const slot = Object.freeze({
      parentId: header.parentId,
      selectedMessageId: header.id,
      slotVersion: projected.state.version,
      position: projected.member.position,
      liveCount: projected.state.liveCount,
      nextSiblingIndex: projected.state.nextSiblingIndex,
      previousMessageId: projected.member.previousMessageId,
      nextMessageId: projected.member.nextMessageId,
      firstMessageId: projected.state.firstLiveChildId as MessageId,
      lastMessageId: projected.state.lastLiveChildId as MessageId,
    })
    validateForkSlot(slot, header.id)
    slots.push(slot)
  }
  return Object.freeze(slots)
}

export interface ActiveBranchHeader extends MessageTreeNode {
  readonly chatId: ChatId
  readonly nodeVersion: number
  readonly bodyVersion: number
}

export interface ActiveBranchSpineSnapshot<T extends ActiveBranchHeader> {
  readonly chatId: ChatId
  readonly structuralVersion: number
  // Leaf of this selected path, not necessarily a leaf of the shared graph.
  readonly resolvedLeafId: MessageId | null
  readonly headers: readonly T[]
  readonly terminalChildSlot: ActiveBranchChildSlot
}

export type ActiveBranchTargetUnavailableReason =
  | 'message-missing'
  | 'message-deleted'
  | 'message-chat-mismatch'
  | 'invalid-ancestry'
  | 'ancestry-cycle'
  | 'sibling-position-unavailable'

export interface ActiveBranchTargetUnavailable {
  readonly kind: 'unavailable'
  readonly selection: ActiveBranchSelection
  readonly reason: ActiveBranchTargetUnavailableReason
}

export interface VersionedActiveBranchSpine<T extends ActiveBranchHeader> {
  readonly chatId: ChatId
  readonly structuralVersion: number
  readonly resolvedLeafId: MessageId | null
  readonly path: BranchPathDescriptor<T>
  readonly terminalChildSlot: ActiveBranchChildSlot
  forkFor(messageId: MessageId): ActiveBranchForkSlot | undefined
  forkSlots(): Iterable<ActiveBranchForkSlot>
  withStructuralVersion(structuralVersion: number): VersionedActiveBranchSpine<T>
  replaceHeaders(headers: readonly T[]): VersionedActiveBranchSpine<T>
  replaceForks(forks: Iterable<ActiveBranchForkSlot>): VersionedActiveBranchSpine<T>
  replaceTerminalChildSlot(slot: ActiveBranchChildSlot): VersionedActiveBranchSpine<T>
}

class ImmutableActiveBranchSpine<T extends ActiveBranchHeader>
  implements VersionedActiveBranchSpine<T>
{
  readonly chatId: ChatId
  readonly structuralVersion: number
  readonly resolvedLeafId: MessageId | null
  readonly path: BranchPathDescriptor<T>
  readonly terminalChildSlot: ActiveBranchChildSlot
  private readonly forksBySelectedId: PersistentStringMap<ActiveBranchForkSlot>

  constructor(input: {
    readonly chatId: ChatId
    readonly structuralVersion: number
    readonly resolvedLeafId: MessageId | null
    readonly path: BranchPathDescriptor<T>
    readonly terminalChildSlot: ActiveBranchChildSlot
    readonly forksBySelectedId: PersistentStringMap<ActiveBranchForkSlot>
  }) {
    this.chatId = input.chatId
    this.structuralVersion = input.structuralVersion
    this.resolvedLeafId = input.resolvedLeafId
    this.path = input.path
    this.terminalChildSlot = input.terminalChildSlot
    this.forksBySelectedId = input.forksBySelectedId
  }

  forkFor(messageId: MessageId): ActiveBranchForkSlot | undefined {
    return this.forksBySelectedId.get(messageId)
  }

  *forkSlots(): IterableIterator<ActiveBranchForkSlot> {
    for (const [, fork] of this.forksBySelectedId) yield fork
  }

  withStructuralVersion(structuralVersion: number): VersionedActiveBranchSpine<T> {
    if (!Number.isSafeInteger(structuralVersion) || structuralVersion < this.structuralVersion) {
      throw new Error('ActiveBranchSpineStructuralVersionInvalid')
    }
    if (structuralVersion === this.structuralVersion) return this
    return new ImmutableActiveBranchSpine({
      chatId: this.chatId,
      structuralVersion,
      resolvedLeafId: this.resolvedLeafId,
      path: this.path,
      terminalChildSlot: this.terminalChildSlot,
      forksBySelectedId: this.forksBySelectedId,
    })
  }

  replaceHeaders(headers: readonly T[]): VersionedActiveBranchSpine<T> {
    const replacements = headers.filter((header) => {
      if (!this.path.has(header.id)) return false
      if (header.deleted) throw new Error(`ActiveBranchSpineHeaderDeleted:${header.id}`)
      return true
    })
    const path = this.path.replaceMany(replacements)
    if (path === this.path) return this
    return new ImmutableActiveBranchSpine({
      chatId: this.chatId,
      structuralVersion: this.structuralVersion,
      resolvedLeafId: this.resolvedLeafId,
      path,
      terminalChildSlot: this.terminalChildSlot,
      forksBySelectedId: this.forksBySelectedId,
    })
  }

  replaceForks(forkUpdates: Iterable<ActiveBranchForkSlot>): VersionedActiveBranchSpine<T> {
    let forks = this.forksBySelectedId
    for (const fork of forkUpdates) {
      const selected = this.path.get(fork.selectedMessageId)
      if (!selected) continue
      if (fork.parentId !== selected.parentId) {
        throw new Error(`ActiveBranchSpineForkParentMismatch:${fork.selectedMessageId}`)
      }
      validateForkSlot(fork, fork.selectedMessageId)
      const current = forks.get(fork.selectedMessageId)
      if (current) {
        if (fork.slotVersion < current.slotVersion) continue
        if (fork.slotVersion === current.slotVersion) {
          if (!sameActiveBranchForkSlot(current, fork)) {
            throw new Error(`ActiveBranchSpineForkVersionCollision:${fork.selectedMessageId}`)
          }
          continue
        }
      }
      forks = forks.set(fork.selectedMessageId, Object.freeze({ ...fork }))
    }
    if (forks === this.forksBySelectedId) return this
    return new ImmutableActiveBranchSpine({
      chatId: this.chatId,
      structuralVersion: this.structuralVersion,
      resolvedLeafId: this.resolvedLeafId,
      path: this.path,
      terminalChildSlot: this.terminalChildSlot,
      forksBySelectedId: forks,
    })
  }

  replaceTerminalChildSlot(slot: ActiveBranchChildSlot): VersionedActiveBranchSpine<T> {
    validateActiveBranchChildSlot(slot, this.chatId, this.resolvedLeafId)
    if (slot.slotVersion < this.terminalChildSlot.slotVersion) return this
    if (
      slot.slotVersion === this.terminalChildSlot.slotVersion &&
      sameActiveBranchChildSlot(slot, this.terminalChildSlot)
    ) {
      return this
    }
    if (slot.slotVersion === this.terminalChildSlot.slotVersion) {
      throw new Error(`ActiveBranchSpineTerminalSlotVersionCollision:${this.chatId}`)
    }
    return new ImmutableActiveBranchSpine({
      chatId: this.chatId,
      structuralVersion: this.structuralVersion,
      resolvedLeafId: this.resolvedLeafId,
      path: this.path,
      terminalChildSlot: Object.freeze({ ...slot }),
      forksBySelectedId: this.forksBySelectedId,
    })
  }
}

export function createActiveBranchSpine<T extends ActiveBranchHeader>(
  snapshot: ActiveBranchSpineSnapshot<T>,
): VersionedActiveBranchSpine<T> {
  validateActiveBranchSpineSnapshot(snapshot)
  return createActiveBranchSpineFromPath({
    chatId: snapshot.chatId,
    structuralVersion: snapshot.structuralVersion,
    resolvedLeafId: snapshot.resolvedLeafId,
    path: createBranchPath(snapshot.headers),
    terminalChildSlot: snapshot.terminalChildSlot,
  })
}

export function createActiveBranchSpineFromPath<T extends ActiveBranchHeader>(input: {
  readonly chatId: ChatId
  readonly structuralVersion: number
  readonly resolvedLeafId: MessageId | null
  readonly path: BranchPathDescriptor<T>
  readonly terminalChildSlot: ActiveBranchChildSlot
}): VersionedActiveBranchSpine<T> {
  if (!Number.isSafeInteger(input.structuralVersion) || input.structuralVersion < 0) {
    throw new Error('ActiveBranchSpineStructuralVersionInvalid')
  }
  if (
    (input.path.leaf?.id ?? null) !== input.resolvedLeafId ||
    (input.path.leaf !== null && input.path.leaf.chatId !== input.chatId)
  ) {
    throw new Error('ActiveBranchSpinePathMismatch')
  }
  validateActiveBranchChildSlot(input.terminalChildSlot, input.chatId, input.resolvedLeafId)
  return new ImmutableActiveBranchSpine({
    chatId: input.chatId,
    structuralVersion: input.structuralVersion,
    resolvedLeafId: input.resolvedLeafId,
    path: input.path,
    terminalChildSlot: Object.freeze({ ...input.terminalChildSlot }),
    forksBySelectedId: PersistentStringMap.empty(),
  })
}

function validateActiveBranchSpineSnapshot<T extends ActiveBranchHeader>(
  snapshot: ActiveBranchSpineSnapshot<T>,
): void {
  if (!Number.isSafeInteger(snapshot.structuralVersion) || snapshot.structuralVersion < 0) {
    throw new Error('ActiveBranchSpineStructuralVersionInvalid')
  }
  if ((snapshot.headers.at(-1)?.id ?? null) !== snapshot.resolvedLeafId) {
    throw new Error('ActiveBranchSpineLeafMismatch')
  }
  validateActiveBranchChildSlot(
    snapshot.terminalChildSlot,
    snapshot.chatId,
    snapshot.resolvedLeafId,
  )
  let parentId: MessageId | null = null
  for (const header of snapshot.headers) {
    if (header.chatId !== snapshot.chatId || header.deleted || header.parentId !== parentId) {
      throw new Error(`ActiveBranchSpineNonContiguous:${header.id}`)
    }
    parentId = header.id
  }
}

export function activeBranchChildSlotFromState(
  chatId: ChatId,
  parentId: MessageId | null,
  state: ChildListState | undefined,
): ActiveBranchChildSlot {
  if (!state) return emptyActiveBranchChildSlot(parentId)
  const slot = Object.freeze({
    parentId,
    slotVersion: state.version,
    liveCount: state.liveCount,
    nextSiblingIndex: state.nextSiblingIndex,
  })
  validateActiveBranchChildSlot(slot, chatId, parentId)
  return slot
}

export function emptyActiveBranchChildSlot(parentId: MessageId | null): ActiveBranchChildSlot {
  return Object.freeze({
    parentId,
    slotVersion: 0,
    liveCount: 0,
    nextSiblingIndex: 0,
  })
}

function validateActiveBranchChildSlot(
  slot: ActiveBranchChildSlot,
  chatId: ChatId,
  parentId: MessageId | null,
): void {
  if (
    slot.parentId !== parentId ||
    !Number.isSafeInteger(slot.slotVersion) ||
    slot.slotVersion < 0 ||
    !Number.isSafeInteger(slot.liveCount) ||
    slot.liveCount < 0 ||
    !Number.isSafeInteger(slot.nextSiblingIndex) ||
    slot.nextSiblingIndex < slot.liveCount
  ) {
    throw new Error(`ActiveBranchChildSlotInvalid:${chatId}:${parentId ?? '__root__'}`)
  }
}

function validateForkSlot(fork: ActiveBranchForkSlot, messageId: MessageId): void {
  if (
    !Number.isSafeInteger(fork.position) ||
    !Number.isSafeInteger(fork.liveCount) ||
    !Number.isSafeInteger(fork.slotVersion) ||
    fork.position < 0 ||
    fork.position >= fork.liveCount ||
    fork.liveCount < 1 ||
    fork.slotVersion < 0 ||
    !Number.isSafeInteger(fork.nextSiblingIndex) ||
    fork.nextSiblingIndex < fork.liveCount
  ) {
    throw new Error(`ActiveBranchSpineForkPositionInvalid:${messageId}`)
  }
  if (
    (fork.position === 0) !== (fork.previousMessageId === null) ||
    (fork.position === fork.liveCount - 1) !== (fork.nextMessageId === null) ||
    (fork.position === 0 && fork.firstMessageId !== messageId) ||
    (fork.position === fork.liveCount - 1 && fork.lastMessageId !== messageId)
  ) {
    throw new Error(`ActiveBranchSpineForkBoundaryInvalid:${messageId}`)
  }
}

function sameActiveBranchForkSlot(
  left: ActiveBranchForkSlot,
  right: ActiveBranchForkSlot,
): boolean {
  return (
    left.parentId === right.parentId &&
    left.selectedMessageId === right.selectedMessageId &&
    left.slotVersion === right.slotVersion &&
    left.position === right.position &&
    left.liveCount === right.liveCount &&
    left.nextSiblingIndex === right.nextSiblingIndex &&
    left.previousMessageId === right.previousMessageId &&
    left.nextMessageId === right.nextMessageId &&
    left.firstMessageId === right.firstMessageId &&
    left.lastMessageId === right.lastMessageId
  )
}

function sameActiveBranchChildSlot(
  left: ActiveBranchChildSlot,
  right: ActiveBranchChildSlot,
): boolean {
  return (
    left.parentId === right.parentId &&
    left.slotVersion === right.slotVersion &&
    left.liveCount === right.liveCount &&
    left.nextSiblingIndex === right.nextSiblingIndex
  )
}
