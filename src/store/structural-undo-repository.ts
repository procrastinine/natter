import type { ConversationProvedSelection, MessageMutationRepository } from '../core/messages'
import { TreeChangedError } from '../core/tree-ops'
import type { MessageId, MutationScope } from '../core/types'
import type { MessageHeaderRow } from './message-storage'
import type {
  RestoreStructuralSnapshotInput,
  StructuralSnapshotPresentation,
} from './structural-undo-contract'

function parentSlotKey(parentId: MessageId | null): string {
  return parentId === null ? 'root' : `message:${parentId}`
}

function sameIds(left: readonly MessageId[], right: readonly MessageId[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

function dedupeScopes(scopes: readonly MutationScope[]): MutationScope[] {
  const seen = new Set<string>()
  const result: MutationScope[] = []
  for (const scope of scopes) {
    const key =
      scope.kind === 'message'
        ? `message:${scope.messageId}`
        : scope.kind === 'chat-topology'
          ? `message-topology:${scope.chatId}`
          : scope.kind === 'children'
            ? `children:${scope.chatId}:${parentSlotKey(scope.parentId)}`
            : scope.kind === 'attachment'
              ? `attachment:${scope.attachmentId}`
              : scope.kind === 'draft'
                ? `draft:${scope.chatId}`
                : `chat-meta:${scope.chatId}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(scope)
  }
  return result
}

export async function applyStructuralSnapshotInRepository(
  repo: MessageMutationRepository,
  input: RestoreStructuralSnapshotInput,
): Promise<StructuralSnapshotPresentation> {
  const { snapshot } = input
  const targetIds = new Set<MessageId>()
  for (const row of snapshot.previousRows) {
    if (row.chatId !== snapshot.chatId || targetIds.has(row.id)) {
      throw new TreeChangedError(snapshot.chatId, `invalid undo row ${row.id}`)
    }
    targetIds.add(row.id)
  }
  for (const id of snapshot.newMessageIds) {
    if (targetIds.has(id)) {
      throw new TreeChangedError(snapshot.chatId, `duplicate undo row ${id}`)
    }
    targetIds.add(id)
  }

  const targetIdList = [...targetIds]
  const { scopes, affectedParents, childIdsBeforeByParent, beforeById } =
    await repo.readStructurePreflight(async (reader) => {
      const targetRows = await reader.getMessageHeaders(targetIdList)
      const currentTargets = new Map<MessageId, MessageHeaderRow>()
      for (let index = 0; index < targetIdList.length; index += 1) {
        const id = targetIdList[index] as MessageId
        const row = targetRows[index]
        if (!row) throw new TreeChangedError(snapshot.chatId, `undo target ${id} unavailable`)
        if (row.chatId !== snapshot.chatId) {
          throw new TreeChangedError(snapshot.chatId, `undo target ${id} unavailable`)
        }
        currentTargets.set(id, row)
      }

      const scopes: MutationScope[] = []
      const affectedParents = new Map<string, MessageId | null>()
      const addAffectedParent = (parentId: MessageId | null): void => {
        affectedParents.set(parentSlotKey(parentId), parentId)
      }
      for (const row of snapshot.previousRows) {
        addAffectedParent(row.parentId)
        addAffectedParent((currentTargets.get(row.id) as MessageHeaderRow).parentId)
      }
      for (const id of snapshot.newMessageIds) {
        addAffectedParent((currentTargets.get(id) as MessageHeaderRow).parentId)
      }

      const childIdsBeforeByParent = new Map<string, MessageId[]>()
      const beforeById = new Map<MessageId, MessageHeaderRow>(currentTargets)
      for (const [key, parentId] of affectedParents) {
        const children = await reader.listChildHeaders(snapshot.chatId, parentId)
        childIdsBeforeByParent.set(
          key,
          children.map((row) => row.id),
        )
        scopes.push({ kind: 'children', chatId: snapshot.chatId, parentId })
        for (const row of children) {
          if (row.chatId !== snapshot.chatId) {
            throw new TreeChangedError(snapshot.chatId, `undo child ${row.id} unavailable`)
          }
          beforeById.set(row.id, row)
          scopes.push({ kind: 'message', messageId: row.id })
        }
      }
      for (const id of targetIds) scopes.push({ kind: 'message', messageId: id })

      return {
        scopes: dedupeScopes(scopes),
        affectedParents,
        childIdsBeforeByParent,
        beforeById,
      }
    })

  const result = await repo.runMutation<
    { structuralHeaders: MessageHeaderRow[] },
    {
      destination: ConversationProvedSelection
      structuralHeaders: MessageHeaderRow[]
    }
  >(
    scopes,
    async (ctx) => {
      const expectedRows = snapshot.expectedRows ?? []
      const expectedCurrent = await ctx.getMessageHeaders(expectedRows.map((row) => row.id))
      for (let index = 0; index < expectedRows.length; index += 1) {
        const expected = expectedRows[index] as (typeof expectedRows)[number]
        const current = expectedCurrent[index]
        if (
          !current ||
          current.chatId !== snapshot.chatId ||
          current.parentId !== expected.parentId ||
          current.siblingIndex !== expected.siblingIndex ||
          current.deleted !== expected.deleted ||
          current.requestContextVersion !== expected.requestContextVersion
        ) {
          throw new TreeChangedError(snapshot.chatId, `undo target ${expected.id} changed`)
        }
      }

      const candidateIds = [...beforeById.keys()]
      const currentCandidates = await ctx.getMessageHeaders(candidateIds)
      for (let index = 0; index < candidateIds.length; index += 1) {
        const id = candidateIds[index] as MessageId
        const before = beforeById.get(id) as MessageHeaderRow
        const current = currentCandidates[index]
        if (
          !current ||
          current.chatId !== snapshot.chatId ||
          current.parentId !== before.parentId ||
          current.siblingIndex !== before.siblingIndex ||
          current.deleted !== before.deleted
        ) {
          throw new TreeChangedError(snapshot.chatId, `undo target ${id} changed`)
        }
      }

      for (const [key, parentId] of affectedParents) {
        const currentChildIds = (await ctx.listChildHeaders(snapshot.chatId, parentId)).map(
          (row) => row.id,
        )
        if (!sameIds(currentChildIds, childIdsBeforeByParent.get(key) ?? [])) {
          throw new TreeChangedError(
            snapshot.chatId,
            `undo children of ${parentId ?? 'root'} changed`,
          )
        }
      }

      for (const row of snapshot.previousRows) {
        await ctx.patchMessageStructure(row.id, {
          parentId: row.parentId,
          siblingIndex: row.siblingIndex,
          deleted: row.deleted,
        })
      }
      for (const id of snapshot.newMessageIds)
        await ctx.patchMessageStructure(id, { deleted: true })

      for (const parentId of affectedParents.values()) {
        const siblings = await ctx.listChildHeaders(snapshot.chatId, parentId)
        siblings.sort((left, right) => {
          if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt
          return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
        })
        for (let index = 0; index < siblings.length; index += 1) {
          const sibling = siblings[index] as MessageHeaderRow
          if (sibling.siblingIndex !== index) {
            await ctx.patchMessageStructure(sibling.id, { siblingIndex: index })
          }
        }
      }

      const afterRows = await ctx.getMessageHeaders(candidateIds)
      const structuralHeaders = afterRows.filter((row, index): row is MessageHeaderRow => {
        if (!row) return false
        const before = beforeById.get(candidateIds[index] as MessageId)
        return Boolean(
          before &&
            (before.parentId !== row.parentId ||
              before.siblingIndex !== row.siblingIndex ||
              before.deleted !== row.deleted),
        )
      })
      return { structuralHeaders }
    },
    async (ctx, value) => {
      const chat = await ctx.getFinalChat(snapshot.chatId)
      if (!chat) throw new TreeChangedError(snapshot.chatId, 'committed chat unavailable')
      const destination = await ctx.sealCommittedDestination({
        chat,
        tipId: snapshot.selectedTipId,
      })
      return {
        ...value,
        destination,
      }
    },
  )
  return result.value
}
