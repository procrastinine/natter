// Undo helpers for structural ops (delete-pair / delete-variant /
// delete-turn / insert-*). The contract is intentionally simple: a
// `StructuralSnapshot` captures the structural fields a mutation was
// about to overwrite or tombstone; `applyStructuralSnapshot` restores
// those fields via the scoped mutation executor so a 5-second undo toast
// can cleanly unwind the structural change without clobbering body edits.
//
// Rationale: the 8.1 spec calls for "5s undo toasts" on structural ops
// but doesn't mandate a full operation-journal. A tight
// "here's what was overwritten" snapshot is enough for the common case
// and matches the plan's 5s horizon. Guarded snapshots reject undo if a
// captured row changed after the original operation.

import type { MessageHeaderRow, MessagePresentation } from '../store/message-storage'
import { getWorkspaceRepository } from '../store/workspace-repository'
import { activePathProjected, createMessageTreeProjection } from './active-path'
import { TreeChangedError } from './tree-ops'
import type { AttachmentId, ChatId, CursorMap, Message, MessageId, MutationScope } from './types'

type StructuralSnapshotExpectedRow = Pick<
  MessageHeaderRow,
  'id' | 'parentId' | 'siblingIndex' | 'deleted' | 'requestContextVersion'
>

export interface StructuralSnapshot {
  chatId: ChatId
  // Row-by-row structural restore list. Rows created by the mutation are
  // listed separately so the undo path can tombstone them.
  previousRows: StructuralSnapshotRow[]
  newMessageIds: MessageId[]
  attachmentIds: AttachmentId[]
  expectedRows?: StructuralSnapshotExpectedRow[]
}

function parentSlotKey(parentId: MessageId | null): string {
  return parentId === null ? 'root' : `message:${parentId}`
}

function sameIds(left: readonly MessageId[], right: readonly MessageId[]): boolean {
  if (left.length !== right.length) return false
  const rightIds = new Set(right)
  return left.every((id) => rightIds.has(id))
}

function dedupeScopes(scopes: readonly MutationScope[]): MutationScope[] {
  const seen = new Set<string>()
  const result: MutationScope[] = []
  for (const scope of scopes) {
    const key =
      scope.kind === 'message'
        ? `message:${scope.messageId}`
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

export type StructuralSnapshotRow = Pick<
  Message,
  'attachmentRefs' | 'chatId' | 'deleted' | 'id' | 'nodeVersion' | 'parentId' | 'siblingIndex'
>

export interface StructuralSnapshotPresentation {
  selectedPathHeaders: MessageHeaderRow[]
  structuralHeaders: MessageHeaderRow[]
  presentations: MessagePresentation[]
}

interface ApplyStructuralSnapshotOptions {
  cursor: Readonly<CursorMap>
  presentationWindowLimit: number
}

// Collect rows for callers that already own a safe snapshot boundary.
export async function snapshotMessages(
  chatId: ChatId,
  ids: readonly MessageId[],
): Promise<StructuralSnapshotRow[]> {
  const repo = getWorkspaceRepository()
  const rows: StructuralSnapshotRow[] = []
  for (const id of ids) {
    const row = await repo.getMessageHeader(id)
    if (!row || row.chatId !== chatId) continue
    rows.push({
      id: row.id,
      chatId: row.chatId,
      parentId: row.parentId,
      siblingIndex: row.siblingIndex,
      nodeVersion: row.nodeVersion,
      deleted: row.deleted,
      ...(row.attachmentRefs ? { attachmentRefs: structuredClone(row.attachmentRefs) } : {}),
    })
  }
  return rows
}

// Reverse the structural change captured in `snapshot`. Restores any
// rows the op overwrote and tombstones any rows the op introduced. Runs
// under the same `message:` + `children:` scopes the op claimed so
// concurrent edits from another tab serialize cleanly.
export async function applyStructuralSnapshot(
  snapshot: StructuralSnapshot,
  options?: ApplyStructuralSnapshotOptions,
): Promise<StructuralSnapshotPresentation | undefined> {
  const repo = getWorkspaceRepository()
  const allBefore = await repo.listMessageHeaders(snapshot.chatId)
  const beforeById = new Map(allBefore.map((row) => [row.id, row]))
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

  const currentTargets = new Map<MessageId, MessageHeaderRow>()
  for (const id of targetIds) {
    const row = beforeById.get(id)
    if (!row) throw new TreeChangedError(snapshot.chatId, `undo target ${id} unavailable`)
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
  for (const row of allBefore) {
    const key = parentSlotKey(row.parentId)
    const ids = childIdsBeforeByParent.get(key)
    if (ids) ids.push(row.id)
    else childIdsBeforeByParent.set(key, [row.id])
  }
  for (const [key, parentId] of affectedParents) {
    const childIds = childIdsBeforeByParent.get(key) ?? []
    scopes.push({ kind: 'children', chatId: snapshot.chatId, parentId })
    for (const id of childIds) scopes.push({ kind: 'message', messageId: id })
  }
  for (const id of targetIds) scopes.push({ kind: 'message', messageId: id })

  const attachmentIds = new Set<AttachmentId>(snapshot.attachmentIds)
  for (const row of currentTargets.values()) {
    for (const ref of row.attachmentRefs ?? []) {
      if (ref.deletedAt === undefined) attachmentIds.add(ref.attachmentId)
    }
  }
  for (const attachmentId of attachmentIds) {
    scopes.push({ kind: 'attachment', attachmentId })
  }
  const result = await repo.runMutation(dedupeScopes(scopes), async (ctx) => {
    for (const expected of snapshot.expectedRows ?? []) {
      const current = await ctx.getMessageHeader(expected.id)
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

    for (const [id, before] of currentTargets) {
      const current = await ctx.getMessageHeader(id)
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
    for (const id of snapshot.newMessageIds) {
      await ctx.patchMessageStructure(id, { deleted: true })
    }

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

    if (!options) return undefined
    const allAfter = await ctx.listMessageHeaders(snapshot.chatId)
    const structuralHeaders = allAfter.filter((row) =>
      affectedParents.has(parentSlotKey(row.parentId)),
    )
    const selectedPathHeaders = activePathProjected(
      createMessageTreeProjection(allAfter),
      options.cursor,
    )
    const boundedLimit = Number.isFinite(options.presentationWindowLimit)
      ? Math.max(1, Math.floor(options.presentationWindowLimit))
      : 1
    const presentations: MessagePresentation[] = []
    for (const header of selectedPathHeaders.slice(-boundedLimit)) {
      const message = await ctx.getMessage(header.id)
      if (
        !message ||
        message.chatId !== snapshot.chatId ||
        message.deleted ||
        message.nodeVersion !== header.nodeVersion ||
        message.parentId !== header.parentId ||
        message.siblingIndex !== header.siblingIndex
      ) {
        throw new TreeChangedError(
          snapshot.chatId,
          `undo selected message ${header.id} unavailable`,
        )
      }
      presentations.push({ header, message, bodyVersion: header.bodyVersion })
    }
    return { selectedPathHeaders, structuralHeaders, presentations }
  })
  return result.value
}
