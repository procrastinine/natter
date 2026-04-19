// Low-level tree mutators used by `src/core/messages.ts`. See
// `plan/08-branching.md §8.4.2–§8.4.10` and §8.10 for invariants.
//
// These helpers run inside a repository mutation. They do not start
// transactions of their own, do not broadcast, and do not write cursor state —
// they return the data the caller needs to apply those side effects.

import type { ChatId, Message, MessageId } from './types'
import { groupByParent } from './active-path'
import type { MutationContext } from '../store/repository'

export class TreeChangedError extends Error {
  readonly chatId: ChatId
  readonly detail: string
  constructor(chatId: ChatId, detail: string) {
    super(`TreeChanged:${chatId}:${detail}`)
    this.name = 'TreeChangedError'
    this.chatId = chatId
    this.detail = detail
  }
}

export async function loadChatMessages(
  ctx: MutationContext,
  chatId: ChatId,
): Promise<Message[]> {
  return ctx.listMessages(chatId)
}

// `max(siblingIndex) + 1` across live AND tombstoned children — the uniqueness
// invariant in §2.3.1 requires we stay above tombstones too. Returns 0 when
// the parent has no children at all.
export function nextSiblingIndex(
  byParent: Map<MessageId | null, Message[]>,
  parentId: MessageId | null,
): number {
  const kids = byParent.get(parentId)
  if (!kids || kids.length === 0) return 0
  let max = -1
  for (const k of kids) {
    if (k.siblingIndex > max) max = k.siblingIndex
  }
  return max + 1
}

// Cycle check: walk upward from `parentId` and fail if `childId` appears on
// the chain. Called after any re-parenting to prove the invariant held. The
// plan (§8.10) argues cycles are impossible by construction; this is a
// runtime safety net.
export function assertNoCycle(
  byId: Map<MessageId, Message>,
  childId: MessageId,
  parentId: MessageId | null,
): void {
  let cur: MessageId | null = parentId
  while (cur !== null) {
    if (cur === childId) {
      throw new Error(`Cycle detected: re-parenting ${childId} under ${parentId}`)
    }
    cur = byId.get(cur)?.parentId ?? null
  }
}

// Re-number all children (live + tombstoned) of `parentId` so they form a
// unique, dense, ascending `siblingIndex` list ordered by `createdAt`. Used
// after splice-up and insert-between reparenting. Caller must have already
// persisted any new/changed children under this parent before calling.
export async function renumberSiblingsByCreatedAt(
  ctx: MutationContext,
  chatId: ChatId,
  parentId: MessageId | null,
): Promise<void> {
  const rows = await ctx.listChildren(chatId, parentId)
  rows.sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as Message
    if (row.siblingIndex !== i) {
      await ctx.putMessage({ ...row, siblingIndex: i })
    }
  }
}

export interface SoftDeleteResult {
  tombstoned: MessageId[]
  // For each live direct child that was re-parented, a before/after record.
  // Callers use this to mend cursor entries that named a tombstoned node.
  reparented: Array<{
    id: MessageId
    previousParentId: MessageId | null
    newParentId: MessageId | null
  }>
}

// §8.4.7 splice-up algorithm. Tombstones every id in `nodeIdsToDelete` and
// lifts their non-deleted direct children up to the first live ancestor. See
// the plan for the correctness argument around walking through chains of
// deleted ancestors instead of naively splicing one level up.
export async function softDeleteWithSplice(
  ctx: MutationContext,
  chatId: ChatId,
  nodeIdsToDelete: readonly MessageId[],
): Promise<SoftDeleteResult> {
  if (nodeIdsToDelete.length === 0) {
    return { tombstoned: [], reparented: [] }
  }
  const deletedSet = new Set<MessageId>(nodeIdsToDelete)
  const cache = new Map<MessageId, Message>()

  const deletedNodes: Message[] = []
  for (const id of nodeIdsToDelete) {
    const row = await ctx.getMessage(id)
    if (!row) continue
    if (row.chatId !== chatId) {
      throw new TreeChangedError(chatId, `node ${id} belongs to another chat`)
    }
    deletedNodes.push(row)
    cache.set(row.id, row)
  }
  if (deletedNodes.length === 0) {
    return { tombstoned: [], reparented: [] }
  }

  async function firstLiveAncestor(node: Message): Promise<MessageId | null> {
    let p = node.parentId
    while (p && deletedSet.has(p)) {
      let parent = cache.get(p)
      if (!parent) {
        const fetched = await ctx.getMessage(p)
        if (fetched) {
          parent = fetched
          cache.set(p, fetched)
        }
      }
      p = parent?.parentId ?? null
    }
    return p
  }

  const reparented: SoftDeleteResult['reparented'] = []
  const affectedParents = new Set<MessageId | null>()

  for (const node of deletedNodes) {
    const kids = await ctx.listChildren(chatId, node.id)
    const newParentId = await firstLiveAncestor(node)
    for (const kid of kids) {
      if (deletedSet.has(kid.id)) continue
      // Pre-tombstoned kids stay where they are — they are already dead
      // and the UI never walks into them, so re-parenting them would
      // only churn scopes (and fail the scope assertion because the
      // scope-collector in messages.ts only declares LIVE kid scopes).
      if (kid.deleted) continue
      reparented.push({
        id: kid.id,
        previousParentId: node.id,
        newParentId,
      })
      await ctx.putMessage({ ...kid, parentId: newParentId })
      affectedParents.add(newParentId)
    }
  }

  for (const node of deletedNodes) {
    await ctx.putMessage({ ...node, deleted: true })
  }

  for (const parent of affectedParents) {
    await renumberSiblingsByCreatedAt(ctx, chatId, parent)
  }

  return {
    tombstoned: deletedNodes.map((n) => n.id),
    reparented,
  }
}

// Cascade variant: tombstone every descendant of the requested nodes; do NOT
// splice. The "Also delete descendants" checkbox (§8.4.10) uses this.
export async function cascadeSoftDelete(
  ctx: MutationContext,
  chatId: ChatId,
  nodeIdsToDelete: readonly MessageId[],
): Promise<MessageId[]> {
  if (nodeIdsToDelete.length === 0) return []
  const all = await loadChatMessages(ctx, chatId)
  const byParent = groupByParent(all)
  const toTombstone = new Set<MessageId>(nodeIdsToDelete)
  const stack: MessageId[] = [...nodeIdsToDelete]
  while (stack.length > 0) {
    const id = stack.pop() as MessageId
    const kids = byParent.get(id)
    if (!kids) continue
    for (const kid of kids) {
      if (toTombstone.has(kid.id)) continue
      toTombstone.add(kid.id)
      stack.push(kid.id)
    }
  }
  for (const id of toTombstone) {
    const row = await ctx.getMessage(id)
    if (!row) continue
    if (!row.deleted) {
      await ctx.putMessage({ ...row, deleted: true })
    }
  }
  return [...toTombstone]
}

// Collect every message in the same turn chain as `headId`. The head (the
// `turnIndex: 0` message of the turn) plus every descendant whose `turnId`
// matches. Pure in-memory walk.
export function collectTurnChain(
  head: Message,
  byParent: Map<MessageId | null, Message[]>,
): Message[] {
  const result: Message[] = [head]
  const stack: MessageId[] = [head.id]
  while (stack.length > 0) {
    const parentId = stack.pop() as MessageId
    const kids = byParent.get(parentId)
    if (!kids) continue
    for (const kid of kids) {
      if (kid.turnId === head.turnId) {
        result.push(kid)
        stack.push(kid.id)
      }
    }
  }
  return result
}

// Find the `turnIndex: 0` ancestor of a message — the head of its turn chain.
// The walk goes up via `parentId`, following `turnId === node.turnId`. The
// data model guarantees a turn chain is strictly parent→child under a shared
// `turnId`, so at most one such ancestor exists.
export function turnHeadOf(
  message: Message,
  byId: Map<MessageId, Message>,
): Message {
  let cur: Message = message
  while (cur.turnIndex !== 0) {
    const parent = cur.parentId ? byId.get(cur.parentId) : undefined
    if (!parent || parent.turnId !== cur.turnId) {
      // No matching parent in the same turn — treat `cur` as the head.
      return cur
    }
    cur = parent
  }
  return cur
}
