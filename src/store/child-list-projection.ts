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
import {
  type SemanticOperationReceiptFragment,
  semanticOperationReceiptFragment,
} from './semantic-operation-capability'
import type { WorkspaceLocalChildSlotEvidence } from './workspace-protocol'

const ALL_SIBLING_INDEX = '[chatId+treeParentKey+siblingIndex+id]'

export interface MessageChildSlotChange {
  readonly messageId: MessageId
  readonly before: MessageHeaderRow | undefined
}

export interface ChildSlotProjectionReceipt {
  readonly slots: readonly WorkspaceLocalChildSlotEvidence[]
  readonly fragment: SemanticOperationReceiptFragment<
    'messages' | 'childLists' | 'childSlotMembers'
  >
}

export async function maintainChildSlotProjections(
  tx: Transaction,
  changes: readonly MessageChildSlotChange[],
  pendingStates: ReadonlyMap<string, ChildListState>,
): Promise<ChildSlotProjectionReceipt> {
  if (pendingStates.size === 0) {
    return Object.freeze({
      slots: Object.freeze([]),
      fragment: semanticOperationReceiptFragment<'messages' | 'childLists' | 'childSlotMembers'>(
        {},
      ),
    })
  }
  const messages = tx.table<MessageHeaderRow, MessageId>('messages')
  const members = tx.table<ChildSlotMember, MessageId>('childSlotMembers')
  const states = tx.table<ChildListState, string>('childLists')
  const currentRows = await messages.bulkGet(changes.map((change) => change.messageId))
  const currentById = new Map<MessageId, MessageHeaderRow | undefined>()
  const slots: WorkspaceLocalChildSlotEvidence[] = []
  const physicalMutations: Array<{
    readonly tableName: 'childLists' | 'childSlotMembers'
    readonly operation: 'write' | 'delete'
    readonly key: string
  }> = []
  const reads: Array<{
    readonly tableName: 'messages' | 'childLists' | 'childSlotMembers'
    readonly indexKind: 'primary' | 'secondary'
    readonly indexName?: string
    readonly operation: 'get' | 'get-many' | 'query'
    readonly requestCount: number
    readonly rowCount: number
  }> = [
    {
      tableName: 'messages',
      indexKind: 'primary',
      operation: 'get-many',
      requestCount: 1,
      rowCount: changes.length,
    },
  ]
  for (const [index, change] of changes.entries()) {
    currentById.set(change.messageId, currentRows[index])
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
    reads.push({
      tableName: 'childLists',
      indexKind: 'primary',
      operation: 'get',
      requestCount: 1,
      rowCount: 1,
    })
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
        reads.push({
          tableName: 'childSlotMembers',
          indexKind: 'primary',
          operation: 'get',
          requestCount: 1,
          rowCount: 1,
        })
        if (!prior || prior.parentKey !== pending.id || prior.nextMessageId !== null) {
          throw new Error(`ChildSlotProjectionTailMismatch:${pending.id}`)
        }
        beforeTail = prior
        const updatedPrior = { ...prior, nextMessageId: appended[0]?.id ?? null }
        await putPhysicalStorageRow(tx, 'childSlotMembers', updatedPrior, prior)
        memberUpserts.push(updatedPrior)
        physicalMutations.push({
          tableName: 'childSlotMembers',
          operation: 'write',
          key: updatedPrior.id,
        })
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
      physicalMutations.push(
        ...appendedMembers.map(({ id: key }) => ({
          tableName: 'childSlotMembers' as const,
          operation: 'write' as const,
          key,
        })),
      )
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
      physicalMutations.push({
        tableName: 'childLists',
        operation: 'write',
        key: nextState.id,
      })
      const evidence: WorkspaceLocalChildSlotEvidence = {
        before: previous,
        beforeTail,
        state: nextState,
        mode: 'append',
        upserts: memberUpserts,
        removedMessageIds: [],
      }
      recordBrowserCommandChildSlotEvidence(tx, evidence)
      slots.push(evidence)
      continue
    }

    const rows = await messages
      .where(ALL_SIBLING_INDEX)
      .between(...exactCompoundPrefixBetween([pending.chatId, treeParentKey(pending.parentId)]))
      .toArray()
    reads.push({
      tableName: 'messages',
      indexKind: 'secondary',
      indexName: ALL_SIBLING_INDEX,
      operation: 'query',
      requestCount: 1,
      rowCount: rows.length,
    })
    const projection = buildChildSlotProjection(pending.chatId, rows, {
      updatedAt: pending.updatedAt,
      defaultVersion: pending.version,
      existing: [pending],
    })
    const state = projection.states.find((candidate) => candidate.id === pending.id)
    if (!state) throw new Error(`ChildSlotProjectionStateMissing:${pending.id}`)
    const previousMembers = await members.where('parentKey').equals(pending.id).toArray()
    reads.push({
      tableName: 'childSlotMembers',
      indexKind: 'secondary',
      indexName: 'parentKey',
      operation: 'query',
      requestCount: 1,
      rowCount: previousMembers.length,
    })
    const previousMembersById = new Map(previousMembers.map((member) => [member.id, member]))
    const nextMemberIds = new Set(projection.members.map((member) => member.id))
    const removedMembers = previousMembers.filter((member) => !nextMemberIds.has(member.id))
    const changedMembers = projection.members.filter((member) => {
      const prior = previousMembersById.get(member.id)
      return !prior || !sameChildSlotMember(prior, member)
    })
    await deletePhysicalStorageRows(
      tx,
      'childSlotMembers',
      removedMembers.map((member) => member.id),
      removedMembers,
    )
    await putPhysicalStorageRows(
      tx,
      'childSlotMembers',
      changedMembers,
      changedMembers.flatMap((member) => {
        const prior = previousMembersById.get(member.id)
        return prior ? [prior] : []
      }),
    )
    const nextState = { ...state, version: pending.version, updatedAt: pending.updatedAt }
    await putPhysicalStorageRow(tx, 'childLists', nextState, previous)
    physicalMutations.push(
      ...removedMembers.map(({ id: key }) => ({
        tableName: 'childSlotMembers' as const,
        operation: 'delete' as const,
        key,
      })),
      ...changedMembers.map(({ id: key }) => ({
        tableName: 'childSlotMembers' as const,
        operation: 'write' as const,
        key,
      })),
      {
        tableName: 'childLists',
        operation: 'write',
        key: nextState.id,
      },
    )
    const evidence: WorkspaceLocalChildSlotEvidence = {
      ...(previous ? { before: previous } : {}),
      state: nextState,
      mode: 'replace',
      upserts: projection.members,
      removedMessageIds: removedMembers.map((member) => member.id),
    }
    recordBrowserCommandChildSlotEvidence(tx, evidence)
    slots.push(evidence)
  }
  const fragment = semanticOperationReceiptFragment({
    dependencies: slots.map(({ state }) => ({
      kind: 'child-slot' as const,
      chatId: state.chatId,
      parentIds: [state.parentId],
    })),
    physicalMutations,
    physicalReads: reads,
  })
  return Object.freeze({ slots: Object.freeze(slots), fragment })
}

function sameChildSlotMember(left: ChildSlotMember, right: ChildSlotMember): boolean {
  return (
    left.id === right.id &&
    left.chatId === right.chatId &&
    left.parentId === right.parentId &&
    left.parentKey === right.parentKey &&
    left.position === right.position &&
    left.previousMessageId === right.previousMessageId &&
    left.nextMessageId === right.nextMessageId
  )
}

function compareSiblingOrder(
  left: Pick<MessageHeaderRow, 'id' | 'siblingIndex'>,
  right: Pick<MessageHeaderRow, 'id' | 'siblingIndex'>,
): number {
  return (
    left.siblingIndex - right.siblingIndex || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  )
}
