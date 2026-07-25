import type { Transaction } from 'dexie'
import { buildChildSlotProjection, childListKey } from '../core/child-list-state'
import { treeParentKey } from '../core/message-tree-index'
import type { ChildListState, ChildSlotMember, MessageId } from '../core/types'
import { recordBrowserCommandChildSlotEvidence } from './browser-command-mutation-journal'
import {
  deletePhysicalStorageRows,
  putPhysicalStorageRow,
  putPhysicalStorageRows,
} from './byte-owner-mutation'
import { exactCompoundPrefixBetween } from './indexeddb-key-ranges'
import type { MessageHeaderRow } from './message-storage'

const ALL_SIBLING_INDEX = '[chatId+treeParentKey+siblingIndex+id]'

export interface MessageChildSlotChange {
  readonly messageId: MessageId
  readonly before: MessageHeaderRow | undefined
}

export async function maintainChildSlotProjections(
  tx: Transaction,
  changes: readonly MessageChildSlotChange[],
  pendingStates: ReadonlyMap<string, ChildListState>,
): Promise<void> {
  if (pendingStates.size === 0) return
  const messages = tx.table<MessageHeaderRow, MessageId>('messages')
  const members = tx.table<ChildSlotMember, MessageId>('childSlotMembers')
  const states = tx.table<ChildListState, string>('childLists')
  const currentRows = await messages.bulkGet(changes.map((change) => change.messageId))
  const currentById = new Map<MessageId, MessageHeaderRow | undefined>()
  for (let index = 0; index < changes.length; index += 1) {
    currentById.set(changes[index]!.messageId, currentRows[index])
  }
  const changesBySlot = new Map<string, MessageChildSlotChange[]>()
  for (const change of changes) {
    const current = currentById.get(change.messageId)
    const slotKeys = new Set<string>()
    if (change.before) {
      slotKeys.add(childListKey(change.before.chatId, change.before.parentId))
    }
    if (current) slotKeys.add(childListKey(current.chatId, current.parentId))
    for (const slotKey of slotKeys) {
      const slotChanges = changesBySlot.get(slotKey)
      if (slotChanges) slotChanges.push(change)
      else changesBySlot.set(slotKey, [change])
    }
  }

  for (const pending of pendingStates.values()) {
    const slotChanges = changesBySlot.get(pending.id) ?? []
    const appended = slotChanges.flatMap((change) => {
      const current = currentById.get(change.messageId)
      return change.before === undefined &&
        current &&
        !current.deleted &&
        current.chatId === pending.chatId &&
        current.parentId === pending.parentId
        ? [current]
        : []
    })
    appended.sort(compareSiblingOrder)
    const previous = await states.get(pending.id)
    const appendOnly =
      previous !== undefined &&
      appended.length === slotChanges.length &&
      appended.every(
        (row, index) =>
          row.siblingIndex >= previous.nextSiblingIndex &&
          (index === 0 || row.siblingIndex > (appended[index - 1]?.siblingIndex ?? -1)),
      )
    if (appendOnly) {
      if (
        (previous.firstLiveChildId === null) !== (previous.liveCount === 0) ||
        (previous.lastLiveChildId === null) !== (previous.liveCount === 0)
      ) {
        throw new Error(`ChildSlotProjectionBoundaryMismatch:${pending.id}`)
      }
      const priorId = previous.lastLiveChildId
      let beforeTail: ChildSlotMember | null = null
      const memberUpserts: ChildSlotMember[] = []
      if (priorId !== null) {
        const prior = await members.get(priorId)
        if (!prior || prior.parentKey !== pending.id || prior.nextMessageId !== null) {
          throw new Error(`ChildSlotProjectionTailMismatch:${pending.id}`)
        }
        beforeTail = prior
        const updatedPrior = { ...prior, nextMessageId: appended[0]?.id ?? null }
        await putPhysicalStorageRow(tx, 'childSlotMembers', updatedPrior, prior)
        memberUpserts.push(updatedPrior)
      }
      const appendedMembers = appended.map(
        (row, index): ChildSlotMember => ({
          id: row.id,
          chatId: pending.chatId,
          parentId: pending.parentId,
          parentKey: pending.id,
          position: previous.liveCount + index,
          previousMessageId: index === 0 ? priorId : (appended[index - 1]?.id ?? null),
          nextMessageId: appended[index + 1]?.id ?? null,
        }),
      )
      await putPhysicalStorageRows(tx, 'childSlotMembers', appendedMembers, [])
      memberUpserts.push(...appendedMembers)
      const last = appended.at(-1)
      let nextSiblingIndex = previous.nextSiblingIndex
      for (const row of appended) {
        nextSiblingIndex = Math.max(nextSiblingIndex, row.siblingIndex + 1)
      }
      const nextState = {
        ...pending,
        liveCount: previous.liveCount + appended.length,
        firstLiveChildId: previous.firstLiveChildId ?? appended[0]?.id ?? null,
        lastLiveChildId: last?.id ?? previous.lastLiveChildId,
        nextSiblingIndex,
      }
      await putPhysicalStorageRow(tx, 'childLists', nextState, previous)
      recordBrowserCommandChildSlotEvidence(tx, {
        before: previous,
        beforeTail,
        state: nextState,
        mode: 'append',
        upserts: memberUpserts,
        removedMessageIds: [],
      })
      continue
    }

    const rows = await messages
      .where(ALL_SIBLING_INDEX)
      .between(...exactCompoundPrefixBetween([pending.chatId, treeParentKey(pending.parentId)]))
      .toArray()
    const projection = buildChildSlotProjection(pending.chatId, rows, {
      updatedAt: pending.updatedAt,
      defaultVersion: pending.version,
      existing: [pending],
    })
    const state = projection.states.find((candidate) => candidate.id === pending.id)
    if (!state) throw new Error(`ChildSlotProjectionStateMissing:${pending.id}`)
    const previousMembers = await members.where('parentKey').equals(pending.id).toArray()
    await deletePhysicalStorageRows(
      tx,
      'childSlotMembers',
      previousMembers.map((member) => member.id),
      previousMembers,
    )
    await putPhysicalStorageRows(tx, 'childSlotMembers', projection.members, [])
    const nextState = { ...state, version: pending.version, updatedAt: pending.updatedAt }
    await putPhysicalStorageRow(tx, 'childLists', nextState, previous)
    const finalMemberIds = new Set(projection.members.map((member) => member.id))
    recordBrowserCommandChildSlotEvidence(tx, {
      ...(previous ? { before: previous } : {}),
      state: nextState,
      mode: 'replace',
      upserts: projection.members,
      removedMessageIds: previousMembers
        .filter((member) => !finalMemberIds.has(member.id))
        .map((member) => member.id),
    })
  }
}

function compareSiblingOrder(
  left: Pick<MessageHeaderRow, 'id' | 'siblingIndex'>,
  right: Pick<MessageHeaderRow, 'id' | 'siblingIndex'>,
): number {
  return (
    left.siblingIndex - right.siblingIndex || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  )
}
