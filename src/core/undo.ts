// Undo helpers for structural ops (delete-pair / delete-variant /
// delete-turn / insert-*). The contract is intentionally simple: a
// `StructuralSnapshot` captures the set of rows that a mutation was
// about to overwrite or tombstone; `applyStructuralSnapshot` restores
// them row-by-row via the scoped mutation executor so a 5-second undo
// toast can cleanly unwind the structural change.
//
// Rationale: the 8.1 spec calls for "5s undo toasts" on structural ops
// but doesn't mandate a full operation-journal. A tight
// "here's what was overwritten" snapshot is enough for the common case
// and matches the plan's 5s horizon. Edits that happened after the user
// walked away are not undone.

import { getWorkspaceRepository } from '../store/workspace-repository'
import type { AttachmentId, ChatId, Message, MessageId, MutationScope } from './types'

export interface StructuralSnapshot {
  chatId: ChatId
  // Row-by-row restore list. Each entry is an exact `Message` that was
  // alive (or tombstoned) immediately before the mutation; on undo it
  // is put back. Rows created by the mutation are not restored. The
  // caller lists them in `newMessageIds` so the undo path deletes them.
  previousRows: Message[]
  newMessageIds: MessageId[]
  attachmentIds: AttachmentId[]
}

// Collect the authoritative "as-was" rows for every message id the caller
// is about to mutate. Used by delete flows: snapshot the rows, run the
// mutation, stash the snapshot in the undo toast.
export async function snapshotMessages(
  chatId: ChatId,
  ids: readonly MessageId[],
): Promise<Message[]> {
  const repo = getWorkspaceRepository()
  const rows: Message[] = []
  for (const id of ids) {
    const row = await repo.getMessage(id)
    if (row && row.chatId === chatId) rows.push(row)
  }
  return rows
}

// Reverse the structural change captured in `snapshot`. Restores any
// rows the op overwrote and removes any rows the op introduced. Runs
// under the same `message:` + `children:` scopes the op claimed so
// concurrent edits from another tab serialize cleanly.
export async function applyStructuralSnapshot(snapshot: StructuralSnapshot): Promise<void> {
  const repo = getWorkspaceRepository()
  const scopes: MutationScope[] = []
  const parentSlots = new Set<string>()
  for (const row of snapshot.previousRows) {
    scopes.push({ kind: 'message', messageId: row.id })
    const parentKey = row.parentId ?? '__root__'
    if (!parentSlots.has(parentKey)) {
      parentSlots.add(parentKey)
      scopes.push({ kind: 'children', chatId: snapshot.chatId, parentId: row.parentId })
    }
  }
  for (const id of snapshot.newMessageIds) {
    scopes.push({ kind: 'message', messageId: id })
  }
  await repo.runMutation(scopes, async (ctx) => {
    for (const id of snapshot.newMessageIds) {
      await ctx.deleteMessage(id)
    }
    for (const row of snapshot.previousRows) {
      await ctx.putMessage(row)
    }
  })
}
