// Active-path derivation and helpers. See `plan/08-branching.md §8.3` and
// `plan/02-data-model.md §2.1.2`.
//
// The active path is the root→leaf walk that the UI renders. It is a pure
// function of (tree, cursor): no IDB reads, no side effects. The cursor is
// an ephemeral per-tab Zustand value; the algorithm receives it as a plain
// `Record<parentKey, childId>` and returns the ordered list of messages on
// the active path. At each fork without a cursor entry the algorithm picks
// the default child — the one whose subtree contains the greatest-`createdAt`
// live leaf (tiebreak: greater `siblingIndex`, then greater `id`).

import type { CursorMap, Message, MessageId } from './types'

// Cursor keys that would otherwise be `null` (the virtual root's "which
// top-level sibling?" slot) are stored under this sentinel string. ULIDs
// cannot collide with it because they are fixed-length base32.
export const ROOT_CURSOR_KEY = '__root__'

export function cursorKeyOf(parentId: MessageId | null): string {
  return parentId ?? ROOT_CURSOR_KEY
}

// Group messages by parent id, sorted by siblingIndex. The `null` bucket
// holds top-level messages. Sorting up front lets downstream walks assume
// stable ordering without re-sorting at every fork.
export function groupByParent(
  messages: readonly Message[],
): Map<MessageId | null, Message[]> {
  const buckets = new Map<MessageId | null, Message[]>()
  for (const m of messages) {
    const bucket = buckets.get(m.parentId)
    if (bucket) bucket.push(m)
    else buckets.set(m.parentId, [m])
  }
  for (const bucket of buckets.values()) {
    bucket.sort((a, b) => a.siblingIndex - b.siblingIndex)
  }
  return buckets
}

export function indexById(messages: readonly Message[]): Map<MessageId, Message> {
  const map = new Map<MessageId, Message>()
  for (const m of messages) map.set(m.id, m)
  return map
}

// Score at a fork = greatest `createdAt` over the LIVE subtree rooted at a
// child (the child itself if live, else skipped transparently to its own
// live descendants). Used by the unpinned default-child rule.
function subtreeMaxCreatedAt(
  rootId: MessageId,
  byParent: Map<MessageId | null, Message[]>,
  byId: Map<MessageId, Message>,
): number {
  const start = byId.get(rootId)
  let best = start && !start.deleted ? start.createdAt : -Infinity
  const stack: MessageId[] = [rootId]
  while (stack.length > 0) {
    const id = stack.pop() as MessageId
    const kids = byParent.get(id)
    if (!kids) continue
    for (const k of kids) {
      if (!k.deleted && k.createdAt > best) best = k.createdAt
      stack.push(k.id)
    }
  }
  return best
}

// §8.4.3.1 rule 4: pick the child whose subtree contains the greatest
// `createdAt` leaf. Tiebreak: greater `siblingIndex`, then greater `id`.
// Precondition: `liveChildren` is non-empty and all members have `!deleted`.
export function pickDefaultChild(
  liveChildren: readonly Message[],
  byParent: Map<MessageId | null, Message[]>,
  byId: Map<MessageId, Message>,
): Message {
  let best = liveChildren[0] as Message
  let bestScore = subtreeMaxCreatedAt(best.id, byParent, byId)
  for (let i = 1; i < liveChildren.length; i++) {
    const cand = liveChildren[i] as Message
    const score = subtreeMaxCreatedAt(cand.id, byParent, byId)
    if (score > bestScore) {
      best = cand
      bestScore = score
      continue
    }
    if (score === bestScore) {
      if (cand.siblingIndex > best.siblingIndex) {
        best = cand
        continue
      }
      if (cand.siblingIndex === best.siblingIndex && cand.id > best.id) {
        best = cand
      }
    }
  }
  return best
}

// Walk root→leaf choosing a live child at each fork: cursor pin if valid,
// else `pickDefaultChild`. Returns the messages on the active path. Empty
// when the chat has no live messages.
export function activePath(
  messages: readonly Message[],
  cursor: CursorMap,
): Message[] {
  const byParent = groupByParent(messages)
  const byId = indexById(messages)
  const path: Message[] = []
  let parentId: MessageId | null = null
  while (true) {
    const kids: Message[] = (byParent.get(parentId) ?? []).filter((m) => !m.deleted)
    if (kids.length === 0) break
    const pinnedId: MessageId | undefined = cursor[cursorKeyOf(parentId)]
    const pinned: Message | undefined =
      pinnedId !== undefined ? kids.find((k) => k.id === pinnedId) : undefined
    const chosen: Message = pinned ?? pickDefaultChild(kids, byParent, byId)
    path.push(chosen)
    parentId = chosen.id
  }
  return path
}

// Live leaves in creation order. A leaf is a live message whose direct
// children are all absent or tombstoned. Callers use this to recompute
// `chat.lastUpdatedLeafId` after any op that may have moved the set.
export function liveLeaves(messages: readonly Message[]): Message[] {
  const byParent = groupByParent(messages)
  const leaves: Message[] = []
  for (const m of messages) {
    if (m.deleted) continue
    const kids = byParent.get(m.id)
    const hasLiveChild = kids?.some((k) => !k.deleted) ?? false
    if (!hasLiveChild) leaves.push(m)
  }
  return leaves
}

// `chat.lastUpdatedLeafId` per §2.1.2: the live leaf with the greatest
// `createdAt`. Tiebreak: greater ULID id. Returns `null` for empty chats.
export function findLastUpdatedLeafId(
  messages: readonly Message[],
): MessageId | null {
  let best: Message | null = null
  for (const leaf of liveLeaves(messages)) {
    if (!best) {
      best = leaf
      continue
    }
    if (
      leaf.createdAt > best.createdAt ||
      (leaf.createdAt === best.createdAt && leaf.id > best.id)
    ) {
      best = leaf
    }
  }
  return best?.id ?? null
}

// `true` when `messageId` lies on the chain `root → … → leafId` via
// `parentId`. Used by the in-place edit op to decide whether to bump
// `chat.lastBranchUpdatedAt` (§2.1.2 rule 3).
export function isOnPathToLeaf(
  messageId: MessageId,
  leafId: MessageId,
  byId: Map<MessageId, Message>,
): boolean {
  let currentId: MessageId | null = leafId
  while (currentId !== null) {
    if (currentId === messageId) return true
    const cur = byId.get(currentId)
    if (!cur) return false
    currentId = cur.parentId
  }
  return false
}
