import type { ChatId, ChildListState, ChildSlotMember, MessageId } from './types'

export interface ChildListProjectionNode {
  readonly id: MessageId
  readonly chatId: ChatId
  readonly parentId: MessageId | null
  readonly siblingIndex: number
  readonly deleted: boolean
}

export interface ChildListAggregate {
  readonly liveCount: number
  readonly firstLiveChildId: MessageId | null
  readonly lastLiveChildId: MessageId | null
  readonly nextSiblingIndex: number
}

export interface ChildSlotProjection {
  readonly states: readonly ChildListState[]
  readonly members: readonly ChildSlotMember[]
}

export type ChildSlotProjectionLookup =
  | { readonly kind: 'unavailable' }
  | {
      readonly kind: 'ready'
      readonly state: ChildListState
      readonly member: ChildSlotMember
    }

export function childListKey(chatId: ChatId, parentId: MessageId | null): string {
  return `${chatId}:${parentId ?? '__root__'}`
}

export function validateChildSlotProjection(input: {
  readonly chatId: ChatId
  readonly parentId: MessageId | null
  readonly position: number
  readonly state: ChildListState | undefined
  readonly member: ChildSlotMember | undefined
}): ChildSlotProjectionLookup {
  const { chatId, parentId, position, state, member } = input
  if (!Number.isSafeInteger(position) || position < 0) {
    throw new Error(`ChildSlotProjectionPositionInvalid:${chatId}:${position}`)
  }
  if (!state && !member) return Object.freeze({ kind: 'unavailable' })
  const parentKey = childListKey(chatId, parentId)
  if (
    !state ||
    state.id !== parentKey ||
    state.chatId !== chatId ||
    state.parentId !== parentId ||
    !Number.isSafeInteger(state.version) ||
    state.version < 0 ||
    !Number.isSafeInteger(state.liveCount) ||
    state.liveCount < 0 ||
    !Number.isSafeInteger(state.nextSiblingIndex) ||
    state.nextSiblingIndex < 0 ||
    state.nextSiblingIndex < state.liveCount ||
    (state.liveCount === 0) !== (state.firstLiveChildId === null) ||
    (state.liveCount === 0) !== (state.lastLiveChildId === null)
  ) {
    throw new Error(`ChildSlotProjectionStateInvalid:${chatId}:${position}`)
  }
  const inRange = position < state.liveCount
  if (inRange !== (member !== undefined)) {
    throw new Error(`ChildSlotProjectionMembershipInvalid:${chatId}:${position}`)
  }
  if (!inRange) return Object.freeze({ kind: 'unavailable' })
  const liveMember = member as ChildSlotMember
  if (
    liveMember.chatId !== chatId ||
    liveMember.parentId !== parentId ||
    liveMember.parentKey !== parentKey ||
    liveMember.position !== position ||
    (liveMember.previousMessageId === null) !== (position === 0) ||
    (liveMember.nextMessageId === null) !== (position === state.liveCount - 1) ||
    (position === 0 && state.firstLiveChildId !== liveMember.id) ||
    (position === state.liveCount - 1 && state.lastLiveChildId !== liveMember.id)
  ) {
    throw new Error(`ChildSlotProjectionMemberInvalid:${chatId}:${position}`)
  }
  return Object.freeze({ kind: 'ready', state, member: liveMember })
}

export function emptyChildListAggregate(): ChildListAggregate {
  return {
    liveCount: 0,
    firstLiveChildId: null,
    lastLiveChildId: null,
    nextSiblingIndex: 0,
  }
}

export function buildChildSlotProjection(
  chatId: ChatId,
  rows: readonly ChildListProjectionNode[],
  options: {
    readonly updatedAt: number
    readonly defaultVersion?: number
    readonly existing?: readonly ChildListState[]
  },
): ChildSlotProjection {
  const slots = new Map<string, ChildListState>()
  const defaultVersion = options.defaultVersion ?? 0
  const addSlot = (parentId: MessageId | null, existing?: ChildListState): ChildListState => {
    const id = childListKey(chatId, parentId)
    const known = slots.get(id)
    if (known) return known
    const state: ChildListState = {
      id,
      chatId,
      parentId,
      version: existing?.version ?? defaultVersion,
      updatedAt: existing?.updatedAt ?? options.updatedAt,
      ...emptyChildListAggregate(),
    }
    slots.set(id, state)
    return state
  }

  addSlot(null)
  for (const existing of options.existing ?? []) {
    if (existing.chatId !== chatId) continue
    addSlot(existing.parentId, existing)
  }
  for (const row of rows) {
    if (row.chatId !== chatId) throw new Error(`ChildListProjectionChatMismatch:${row.id}`)
    addSlot(row.parentId)
  }

  const firstBySlot = new Map<string, ChildListProjectionNode>()
  const lastBySlot = new Map<string, ChildListProjectionNode>()
  const counts = new Map<string, number>()
  const nextSiblingIndexes = new Map<string, number>()
  for (const row of rows) {
    const id = childListKey(chatId, row.parentId)
    nextSiblingIndexes.set(id, Math.max(nextSiblingIndexes.get(id) ?? 0, row.siblingIndex + 1))
    if (row.deleted) continue
    counts.set(id, (counts.get(id) ?? 0) + 1)
    const first = firstBySlot.get(id)
    if (!first || compareSiblingOrder(row, first) < 0) firstBySlot.set(id, row)
    const last = lastBySlot.get(id)
    if (!last || compareSiblingOrder(row, last) > 0) lastBySlot.set(id, row)
  }

  const states = Object.freeze(
    [...slots.values()].map((state) =>
      Object.freeze({
        ...state,
        liveCount: counts.get(state.id) ?? 0,
        firstLiveChildId: firstBySlot.get(state.id)?.id ?? null,
        lastLiveChildId: lastBySlot.get(state.id)?.id ?? null,
        nextSiblingIndex: nextSiblingIndexes.get(state.id) ?? 0,
      }),
    ),
  )
  const liveBySlot = new Map<string, ChildListProjectionNode[]>()
  for (const row of rows) {
    if (row.deleted) continue
    const id = childListKey(chatId, row.parentId)
    const members = liveBySlot.get(id) ?? []
    members.push(row)
    liveBySlot.set(id, members)
  }
  const members: ChildSlotMember[] = []
  for (const [id, slotRows] of liveBySlot) {
    slotRows.sort(compareSiblingOrder)
    for (let position = 0; position < slotRows.length; position += 1) {
      const row = slotRows[position] as ChildListProjectionNode
      members.push(
        Object.freeze({
          id: row.id,
          chatId,
          parentId: row.parentId,
          parentKey: id,
          position,
          previousMessageId: slotRows[position - 1]?.id ?? null,
          nextMessageId: slotRows[position + 1]?.id ?? null,
        }),
      )
    }
  }
  return Object.freeze({ states, members: Object.freeze(members) })
}

function compareSiblingOrder(
  left: Pick<ChildListProjectionNode, 'id' | 'siblingIndex'>,
  right: Pick<ChildListProjectionNode, 'id' | 'siblingIndex'>,
): number {
  return (
    left.siblingIndex - right.siblingIndex || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  )
}
