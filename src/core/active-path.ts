// The active path is the root→leaf walk that the UI renders. It is a pure
// function of (tree, cursor): no IDB reads, no side effects. The cursor is
// an ephemeral per-tab Zustand value; the algorithm receives it as a plain
// `Record<parentKey, childId>` and returns the ordered list of messages on
// the active path. At each fork without a cursor entry the algorithm picks
// the default child — the one whose subtree contains the greatest-`createdAt`
// live leaf (tiebreak: greater `siblingIndex`, then greater `id`).

import type { CursorMap, Message, MessageId } from './types'

export type MessageTreeNode = Pick<
  Message,
  'id' | 'parentId' | 'siblingIndex' | 'createdAt' | 'deleted'
>

export interface ActivePathMeasurement {
  bucketedRows: number
  indexedRows: number
  scoredRows: number
  scoreEdges: number
  pathSteps: number
  childCandidates: number
}

// Cursor keys that would otherwise be `null` (the virtual root's "which
// top-level sibling?" slot) are stored under this sentinel string. ULIDs
// cannot collide with it because they are fixed-length base32.
export const ROOT_CURSOR_KEY = '__root__'

export function cursorKeyOf(parentId: MessageId | null): string {
  return parentId ?? ROOT_CURSOR_KEY
}

function bucketTreeNodesByParent<T extends MessageTreeNode>(
  messages: readonly T[],
): Map<MessageId | null, T[]> {
  const buckets = new Map<MessageId | null, T[]>()
  for (const m of messages) {
    const bucket = buckets.get(m.parentId)
    if (bucket) bucket.push(m)
    else buckets.set(m.parentId, [m])
  }
  return buckets
}

// Group messages by parent id, sorted by siblingIndex. The `null` bucket
// holds top-level messages. Public callers use the stable sibling order;
// internal score/path walks use the unsorted buckets because their choice
// rule already compares siblingIndex explicitly.
function groupTreeNodesByParent<T extends MessageTreeNode>(
  messages: readonly T[],
): Map<MessageId | null, T[]> {
  const buckets = bucketTreeNodesByParent(messages)
  for (const bucket of buckets.values()) {
    bucket.sort((a, b) => a.siblingIndex - b.siblingIndex)
  }
  return buckets
}

function indexTreeNodesById<T extends MessageTreeNode>(messages: readonly T[]): Map<MessageId, T> {
  const map = new Map<MessageId, T>()
  for (const m of messages) map.set(m.id, m)
  return map
}

export function groupByParent(messages: readonly Message[]): Map<MessageId | null, Message[]> {
  return groupTreeNodesByParent(messages)
}

export function indexById(messages: readonly Message[]): Map<MessageId, Message> {
  return indexTreeNodesById(messages)
}

function subtreeScores<T extends MessageTreeNode>(
  byParent: Map<MessageId | null, T[]>,
  byId: Map<MessageId, T>,
): Map<MessageId, number> {
  const scores = new Map<MessageId, number>()
  const remainingChildren = new Map<MessageId, number>()
  const ready: T[] = []
  for (const message of byId.values()) {
    scores.set(message.id, message.deleted ? -Infinity : message.createdAt)
    const childCount = byParent.get(message.id)?.length ?? 0
    remainingChildren.set(message.id, childCount)
    if (childCount === 0) ready.push(message)
  }
  for (let index = 0; index < ready.length; index += 1) {
    const message = ready[index] as T
    if (message.parentId === null) continue
    const parent = byId.get(message.parentId)
    if (!parent) continue
    const childScore = scores.get(message.id) ?? -Infinity
    if (childScore > (scores.get(parent.id) ?? -Infinity)) scores.set(parent.id, childScore)
    const remaining = (remainingChildren.get(parent.id) ?? 1) - 1
    remainingChildren.set(parent.id, remaining)
    if (remaining === 0) ready.push(parent)
  }
  return scores
}

function pickDefaultChildFromScores<T extends MessageTreeNode>(
  liveChildren: readonly T[],
  scores: Map<MessageId, number>,
): T {
  let best = liveChildren[0] as T
  let bestScore = scores.get(best.id) ?? -Infinity
  for (let index = 1; index < liveChildren.length; index += 1) {
    const candidate = liveChildren[index] as T
    const score = scores.get(candidate.id) ?? -Infinity
    if (
      score > bestScore ||
      (score === bestScore &&
        (candidate.siblingIndex > best.siblingIndex ||
          (candidate.siblingIndex === best.siblingIndex && candidate.id > best.id)))
    ) {
      best = candidate
      bestScore = score
    }
  }
  return best
}

// §8.4.3.1 rule 4: pick the child whose subtree contains the greatest
// `createdAt` leaf. Tiebreak: greater `siblingIndex`, then greater `id`.
// Precondition: `liveChildren` is non-empty and all members have `!deleted`.
function pickDefaultTreeChild<T extends MessageTreeNode>(
  liveChildren: readonly T[],
  byParent: Map<MessageId | null, T[]>,
  byId: Map<MessageId, T>,
): T {
  return createDefaultChildPicker(byParent, byId)(liveChildren)
}

export function createDefaultChildPicker<T extends MessageTreeNode>(
  byParent: Map<MessageId | null, T[]>,
  byId: Map<MessageId, T>,
): (liveChildren: readonly T[]) => T {
  const scores = subtreeScores(byParent, byId)
  return (liveChildren) => pickDefaultChildFromScores(liveChildren, scores)
}

export function pickDefaultChild(
  liveChildren: readonly Message[],
  byParent: Map<MessageId | null, Message[]>,
  byId: Map<MessageId, Message>,
): Message {
  return pickDefaultTreeChild(liveChildren, byParent, byId)
}

// Walk root→leaf choosing a live child at each fork: cursor pin if valid,
// else `pickDefaultChild`. Returns the messages on the active path. Empty
// when the chat has no live messages.
export function activePath(
  messages: readonly Message[],
  cursor: CursorMap,
  onMeasure?: (measurement: ActivePathMeasurement) => void,
): Message[] {
  const measurement: ActivePathMeasurement | undefined = onMeasure
    ? {
        bucketedRows: messages.length,
        indexedRows: messages.length,
        scoredRows: messages.length,
        scoreEdges: 0,
        pathSteps: 0,
        childCandidates: 0,
      }
    : undefined
  const byParent = bucketTreeNodesByParent(messages)
  const byId = indexTreeNodesById(messages)
  const scores = subtreeScores(byParent, byId)
  if (measurement) {
    for (const message of messages) {
      if (message.parentId !== null && byId.has(message.parentId)) measurement.scoreEdges += 1
    }
  }
  const path: Message[] = []
  let parentId: MessageId | null = null
  for (;;) {
    const kids: Message[] = (byParent.get(parentId) ?? []).filter((m) => !m.deleted)
    if (kids.length === 0) break
    if (measurement) {
      measurement.pathSteps += 1
      measurement.childCandidates += kids.length
    }
    const pinnedId: MessageId | undefined = cursor[cursorKeyOf(parentId)]
    const pinned: Message | undefined =
      pinnedId !== undefined ? kids.find((k) => k.id === pinnedId) : undefined
    const chosen: Message = pinned ?? pickDefaultChildFromScores(kids, scores)
    path.push(chosen)
    parentId = chosen.id
  }
  if (measurement) onMeasure?.(measurement)
  return path
}

export function resolveActiveLeafId<T extends MessageTreeNode>(
  messages: readonly T[],
  cursor: CursorMap,
): MessageId | null {
  const byParent: Map<MessageId | null, T[]> = bucketTreeNodesByParent(messages)
  const byId: Map<MessageId, T> = indexTreeNodesById(messages)
  const scores = subtreeScores(byParent, byId)
  let parentId: MessageId | null = null
  for (;;) {
    const children: T[] = (byParent.get(parentId) ?? []).filter((message) => !message.deleted)
    if (children.length === 0) return parentId
    const pinnedId: MessageId | undefined = cursor[cursorKeyOf(parentId)]
    const pinned: T | undefined =
      pinnedId === undefined ? undefined : children.find((message) => message.id === pinnedId)
    parentId = (pinned ?? pickDefaultChildFromScores(children, scores)).id
  }
}

// Live leaves in creation order. A leaf is a live message whose direct
// children are all absent or tombstoned. Callers use this to recompute
// `chat.lastUpdatedLeafId` after any op that may have moved the set.
export function liveLeaves(messages: readonly Message[]): Message[] {
  const byParent = bucketTreeNodesByParent(messages)
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
export function findLastUpdatedLeafId(messages: readonly Message[]): MessageId | null {
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
