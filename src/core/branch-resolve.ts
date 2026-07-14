// Given a target message M and a mutable cursor, write cursor entries from
// M downward so the active-path walk agrees with the "most-recently-updated
// chain below M" choice. Swipe, search-click, and
// hash-route deep-link all funnel through this helper so the same target
// always resolves to the same descendant chain.
//
// Pure view-state: no IDB, no broadcast, no chat.updatedAt effect. Inputs are
// (target, grouped tree, cursor). The cursor is mutated in place so the caller
// can merge it into Zustand atomically after the IDB transaction (if any) has
// committed.

import {
  createDefaultChildPicker,
  createMessageTreeProjection,
  cursorKeyOf,
  type DefaultChildPicker,
  type MessageTreeNode,
  type MessageTreeProjection,
} from './active-path'
import { createCursorOverlay } from './cursor-overlay'
import type { CursorMap, CursorPatch, Message, MessageId } from './types'

interface ResolveBranchInput<T extends MessageTreeNode = Message> {
  targetId: MessageId
  byParent: ReadonlyMap<MessageId | null, readonly T[]>
  liveByParent?: ReadonlyMap<MessageId | null, readonly T[]>
  byId: ReadonlyMap<MessageId, T>
  pickDefaultChild?: DefaultChildPicker<T>
}

// Seed the cursor so the given messageId lands on the active path.
// Walks upward from the target writing `cursor[parent] = child` entries
// at every fork (so the upstream ancestors point at this chain), then
// falls through to `resolveLastUpdatedBranchBelow` to fill in the
// descendant chain below the target. Pure view-state mutation — same
// contract as the helper above.
export function seedCursorAtMessage(
  messages: readonly Message[],
  targetId: MessageId,
  cursor: CursorMap,
  options: { preserveDescendantPins?: boolean } = {},
): void {
  const projection = createMessageTreeProjection(messages)
  const patch = seedCursorAtMessageProjected(projection, targetId, cursor, options)
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete cursor[key]
    else cursor[key] = value
  }
}

export function seedCursorAtMessageProjected<T extends MessageTreeNode>(
  projection: MessageTreeProjection<T>,
  targetId: MessageId,
  cursor: Readonly<CursorMap>,
  options: { preserveDescendantPins?: boolean } = {},
): CursorPatch {
  const { byId } = projection
  let cur: T | undefined = byId.get(targetId)
  if (!cur) return {}
  const patch: CursorPatch = {}
  const overlay = createCursorOverlay(cursor)
  while (cur) {
    const parentId: MessageId | null = cur.parentId
    const key = cursorKeyOf(parentId)
    overlay[key] = cur.id
    patch[key] = cur.id
    cur = parentId ? byId.get(parentId) : undefined
  }
  if (options.preserveDescendantPins === false) {
    Object.assign(
      patch,
      resolveLastUpdatedBranchBelow({ ...projection, targetId }, createCursorOverlay({})),
    )
    return patch
  }
  Object.assign(patch, resolveLastUpdatedBranchBelow({ ...projection, targetId }, overlay))
  return patch
}

// §8.4.3.1 fork rule:
//   1. If `cursor[current]` points at a live child, keep that entry and descend.
//   2. Otherwise pick the child whose subtree has the greatest live leaf by
//      (`createdAt`, leaf id), write `cursor[current] = chosenId`, descend.
// A walk that reaches a leaf (or an all-tombstoned fork) stops.
//
// This routine does NOT write `cursor[parentOfTarget] = target`. That entry is
// the caller's responsibility — it's the swipe/search-click decision. The
// helper only handles `target → leaf` below.
export function resolveLastUpdatedBranchBelow<T extends MessageTreeNode>(
  input: ResolveBranchInput<T>,
  cursor: CursorMap,
): CursorMap {
  const { byParent, byId, liveByParent } = input
  const pickDefaultChild =
    input.pickDefaultChild ?? createDefaultChildPicker(byParent, byId, liveByParent)
  const updates: CursorMap = {}
  let currentId: MessageId = input.targetId
  for (;;) {
    const kids = liveByParent
      ? (liveByParent.get(currentId) ?? [])
      : (byParent.get(currentId) ?? []).filter((m) => !m.deleted)
    if (kids.length === 0) break
    const key = cursorKeyOf(currentId)
    const pinnedId = cursor[key]
    if (pinnedId !== undefined && kids.some((k) => k.id === pinnedId)) {
      currentId = pinnedId
      continue
    }
    const chosen = pickDefaultChild(kids)
    cursor[key] = chosen.id
    updates[key] = chosen.id
    currentId = chosen.id
  }
  return updates
}

export function selectBranchProjected<T extends MessageTreeNode>(
  projection: MessageTreeProjection<T>,
  targetId: MessageId,
  cursor: Readonly<CursorMap>,
): CursorMap {
  const target = projection.byId.get(targetId)
  if (!target) return {}
  const key = cursorKeyOf(target.parentId)
  const updates: CursorMap = { [key]: target.id }
  const overlay = createCursorOverlay(cursor)
  overlay[key] = target.id
  Object.assign(
    updates,
    resolveLastUpdatedBranchBelow({ ...projection, targetId: target.id }, overlay),
  )
  return updates
}
