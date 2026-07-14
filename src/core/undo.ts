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

import type { MessageHeaderRow } from '../store/message-storage'
import { getWorkspaceRepository } from '../store/workspace-repository'
import { TreeChangedError } from './tree-ops'
import type { AttachmentId, ChatId, Message, MessageId, MutationScope } from './types'

type StructuralSnapshotExpectedRow = Pick<
  Message,
  'id' | 'parentId' | 'siblingIndex' | 'deleted' | 'nodeVersion'
>

export interface StructuralSnapshot {
  chatId: ChatId
  // Row-by-row structural restore list. Rows created by the mutation are
  // listed separately so the undo path can delete them.
  previousRows: StructuralSnapshotRow[]
  newMessageIds: MessageId[]
  attachmentIds: AttachmentId[]
  expectedRows?: StructuralSnapshotExpectedRow[]
}

export type StructuralSnapshotRow = Pick<
  Message,
  'attachmentRefs' | 'chatId' | 'deleted' | 'id' | 'nodeVersion' | 'parentId' | 'siblingIndex'
>

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
// rows the op overwrote and removes any rows the op introduced. Runs
// under the same `message:` + `children:` scopes the op claimed so
// concurrent edits from another tab serialize cleanly.
export async function applyStructuralSnapshot(snapshot: StructuralSnapshot): Promise<void> {
  const repo = getWorkspaceRepository()
  const currentRows = (
    await Promise.all(
      [...snapshot.previousRows.map((row) => row.id), ...snapshot.newMessageIds].map((id) =>
        repo.getMessageHeader(id),
      ),
    )
  ).filter((row): row is MessageHeaderRow => row !== undefined && row.chatId === snapshot.chatId)
  const scopes: MutationScope[] = []
  const parentSlots = new Set<string>()
  const addParentScope = (row: Pick<Message, 'parentId'>): void => {
    const parentKey = row.parentId ?? '__root__'
    if (parentSlots.has(parentKey)) return
    parentSlots.add(parentKey)
    scopes.push({ kind: 'children', chatId: snapshot.chatId, parentId: row.parentId })
  }
  for (const row of [...snapshot.previousRows, ...currentRows]) {
    scopes.push({ kind: 'message', messageId: row.id })
    addParentScope(row)
  }
  for (const id of snapshot.newMessageIds) {
    scopes.push({ kind: 'message', messageId: id })
  }
  const attachmentIds = new Set<AttachmentId>(snapshot.attachmentIds)
  for (const row of [...snapshot.previousRows, ...currentRows]) {
    for (const ref of row.attachmentRefs ?? []) {
      if (ref.deletedAt === undefined) attachmentIds.add(ref.attachmentId)
    }
  }
  for (const attachmentId of attachmentIds) {
    scopes.push({ kind: 'attachment', attachmentId })
  }
  await repo.runMutation(scopes, async (ctx) => {
    for (const expected of snapshot.expectedRows ?? []) {
      const current = await ctx.getMessageHeader(expected.id)
      if (
        !current ||
        current.chatId !== snapshot.chatId ||
        current.parentId !== expected.parentId ||
        current.siblingIndex !== expected.siblingIndex ||
        current.deleted !== expected.deleted ||
        current.nodeVersion !== expected.nodeVersion
      ) {
        throw new TreeChangedError(snapshot.chatId, `undo target ${expected.id} changed`)
      }
    }
    for (const id of snapshot.newMessageIds) {
      await ctx.deleteMessage(id)
    }
    for (const row of snapshot.previousRows) {
      await ctx.patchMessageStructure(row.id, {
        parentId: row.parentId,
        siblingIndex: row.siblingIndex,
        deleted: row.deleted,
      })
    }
  })
}
