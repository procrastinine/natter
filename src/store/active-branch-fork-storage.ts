import type { Transaction } from 'dexie'
import {
  type ActiveBranchChildSlot,
  type ActiveBranchForkSlot,
  type ActiveBranchForkTarget,
  activeBranchChildSlotFromState,
  materializeActiveBranchForkSlots,
} from '../core/active-branch-spine'
import { childListKey } from '../core/child-list-state'
import type { ChatId, ChildListState, ChildSlotMember, MessageId } from '../core/types'
import type { MessageHeaderRow } from './message-storage'

export interface ActiveBranchPathSlotFrame {
  readonly forks: readonly ActiveBranchForkSlot[]
  readonly terminalChildSlot: ActiveBranchChildSlot
}

export async function readActiveBranchForksInTransaction(
  tx: Transaction,
  chatId: ChatId,
  targets: readonly ActiveBranchForkTarget[],
  signal?: AbortSignal,
): Promise<readonly ActiveBranchForkSlot[]> {
  if (targets.length === 0) return Object.freeze([])
  throwIfAborted(signal)
  const headers = await tx
    .table<MessageHeaderRow, MessageId>('messages')
    .bulkGet(targets.map((target) => target.selectedMessageId))
  throwIfAborted(signal)
  const selectedHeaders = headers.map((header, index) => {
    const target = targets[index] as ActiveBranchForkTarget
    if (
      !header ||
      header.id !== target.selectedMessageId ||
      header.chatId !== chatId ||
      header.parentId !== target.parentId ||
      header.deleted
    ) {
      throw new Error(`ActiveBranchForkTargetInvalid:${target.selectedMessageId}`)
    }
    return header
  })
  return readActiveBranchForkSlotsForHeadersInTransaction(tx, selectedHeaders, signal)
}

export async function readActiveBranchForkSlotsForHeadersInTransaction(
  tx: Transaction,
  headers: readonly MessageHeaderRow[],
  signal?: AbortSignal,
): Promise<readonly ActiveBranchForkSlot[]> {
  if (headers.length === 0) return Object.freeze([])
  const [members, states] = await Promise.all([
    tx
      .table<ChildSlotMember, MessageId>('childSlotMembers')
      .bulkGet(headers.map((header) => header.id)),
    tx
      .table<ChildListState, string>('childLists')
      .bulkGet(headers.map((header) => childListKey(header.chatId, header.parentId))),
  ])
  throwIfAborted(signal)
  return materializeActiveBranchForkSlots(
    (headers[0] as MessageHeaderRow).chatId,
    headers,
    states,
    members,
  )
}

export async function readActiveBranchPathSlotFrameInTransaction(
  tx: Transaction,
  chatId: ChatId,
  headers: readonly MessageHeaderRow[],
  signal?: AbortSignal,
): Promise<ActiveBranchPathSlotFrame> {
  const terminalId = headers.at(-1)?.id ?? null
  throwIfAborted(signal)
  const [members, states] = await Promise.all([
    headers.length === 0
      ? Promise.resolve([])
      : tx
          .table<ChildSlotMember, MessageId>('childSlotMembers')
          .bulkGet(headers.map((header) => header.id)),
    tx
      .table<ChildListState, string>('childLists')
      .bulkGet([
        ...headers.map((header) => childListKey(chatId, header.parentId)),
        childListKey(chatId, terminalId),
      ]),
  ])
  throwIfAborted(signal)
  const forkStates = states.slice(0, headers.length)
  const terminalState = states.at(-1)
  return Object.freeze({
    forks:
      headers.length === 0
        ? Object.freeze([])
        : materializeActiveBranchForkSlots(chatId, headers, forkStates, members),
    terminalChildSlot: activeBranchChildSlotFromState(chatId, terminalId, terminalState),
  })
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException('Active branch fork read aborted', 'AbortError')
}
