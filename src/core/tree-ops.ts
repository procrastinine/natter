// These helpers run inside a repository mutation. They do not start
// transactions of their own, do not broadcast, and do not write cursor state.
// They return the data the caller needs to apply those side effects.

import type { ChatId, Message, MessageId } from './types'

type TreeMutationHeader = Pick<
  Message,
  'id' | 'chatId' | 'parentId' | 'siblingIndex' | 'createdAt' | 'deleted'
>

export interface TreeMutationPort {
  getMessageHeader(messageId: MessageId): Promise<TreeMutationHeader | undefined>
  listChildHeaders(chatId: ChatId, parentId: MessageId | null): Promise<TreeMutationHeader[]>
  patchMessageStructure(
    messageId: MessageId,
    patch: Partial<Pick<TreeMutationHeader, 'deleted' | 'parentId' | 'siblingIndex'>>,
  ): Promise<void>
}

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

type MessageTreeRow = Pick<Message, 'id' | 'parentId'>

export function createAncestorOutsideSetResolver<T extends MessageTreeRow>(
  byId: ReadonlyMap<MessageId, T>,
  excluded: ReadonlySet<MessageId>,
  onVisit?: () => void,
): (message: T) => MessageId | null {
  const resolved = new Map<MessageId, MessageId | null>()
  return (message) => {
    const path: MessageId[] = []
    let current: T | undefined = message
    let ancestor: MessageId | null
    for (;;) {
      if (resolved.has(current.id)) {
        ancestor = resolved.get(current.id) ?? null
        break
      }
      onVisit?.()
      path.push(current.id)
      const parentId = current.parentId
      if (parentId === null || !excluded.has(parentId)) {
        ancestor = parentId
        break
      }
      current = byId.get(parentId)
      if (!current) {
        ancestor = null
        break
      }
    }
    for (const messageId of path) resolved.set(messageId, ancestor)
    return ancestor
  }
}

// Re-number all children (live + tombstoned) of `parentId` so they form a
// unique, dense, ascending `siblingIndex` list ordered by `createdAt`. Used
// after splice-up and insert-between reparenting. Caller must have already
// persisted any new/changed children under this parent before calling.
async function renumberSiblingsByCreatedAt(
  ctx: TreeMutationPort,
  chatId: ChatId,
  parentId: MessageId | null,
): Promise<void> {
  const rows = await ctx.listChildHeaders(chatId, parentId)
  rows.sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as TreeMutationHeader
    if (row.siblingIndex !== i) {
      await ctx.patchMessageStructure(row.id, { siblingIndex: i })
    }
  }
}

interface SoftDeleteResult {
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
  ctx: TreeMutationPort,
  chatId: ChatId,
  nodeIdsToDelete: readonly MessageId[],
): Promise<SoftDeleteResult> {
  if (nodeIdsToDelete.length === 0) {
    return { tombstoned: [], reparented: [] }
  }
  const deletedSet = new Set<MessageId>(nodeIdsToDelete)
  const deletedById = new Map<MessageId, TreeMutationHeader>()

  const deletedNodes: TreeMutationHeader[] = []
  for (const id of nodeIdsToDelete) {
    const row = await ctx.getMessageHeader(id)
    if (!row) continue
    if (row.chatId !== chatId) {
      throw new TreeChangedError(chatId, `node ${id} belongs to another chat`)
    }
    deletedNodes.push(row)
    deletedById.set(row.id, row)
  }
  if (deletedNodes.length === 0) {
    return { tombstoned: [], reparented: [] }
  }

  const firstLiveAncestor = createAncestorOutsideSetResolver(deletedById, deletedSet)

  const reparented: SoftDeleteResult['reparented'] = []
  const affectedParents = new Set<MessageId | null>()

  for (const node of deletedNodes) {
    const kids = await ctx.listChildHeaders(chatId, node.id)
    const newParentId = firstLiveAncestor(node)
    for (const kid of kids) {
      if (deletedSet.has(kid.id)) continue
      // Pre-tombstoned kids stay where they are: already dead, and
      // the UI never walks into them, so re-parenting them would
      // only churn scopes (and fail the scope assertion because the
      // scope-collector in messages.ts only declares LIVE kid scopes).
      if (kid.deleted) continue
      reparented.push({
        id: kid.id,
        previousParentId: node.id,
        newParentId,
      })
      await ctx.patchMessageStructure(kid.id, { parentId: newParentId })
      affectedParents.add(newParentId)
    }
  }

  for (const node of deletedNodes) {
    await ctx.patchMessageStructure(node.id, { deleted: true })
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
  ctx: TreeMutationPort,
  chatId: ChatId,
  nodeIdsToDelete: readonly MessageId[],
): Promise<MessageId[]> {
  if (nodeIdsToDelete.length === 0) return []
  const discovered = new Map<MessageId, TreeMutationHeader>()
  const stack: TreeMutationHeader[] = []
  for (const messageId of new Set(nodeIdsToDelete)) {
    const row = await ctx.getMessageHeader(messageId)
    if (!row) continue
    if (row.chatId !== chatId) {
      throw new TreeChangedError(chatId, `node ${messageId} belongs to another chat`)
    }
    discovered.set(row.id, row)
    stack.push(row)
  }
  while (stack.length > 0) {
    const row = stack.pop() as TreeMutationHeader
    const kids = await ctx.listChildHeaders(chatId, row.id)
    for (const kid of kids) {
      if (kid.chatId !== chatId) {
        throw new TreeChangedError(chatId, `node ${kid.id} belongs to another chat`)
      }
      if (discovered.has(kid.id)) continue
      discovered.set(kid.id, kid)
      stack.push(kid)
    }
  }
  const tombstoned: MessageId[] = []
  for (const row of discovered.values()) {
    if (!row.deleted) {
      await ctx.patchMessageStructure(row.id, { deleted: true })
      tombstoned.push(row.id)
    }
  }
  return tombstoned
}
