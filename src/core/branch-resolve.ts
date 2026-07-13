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

import { createDefaultChildPicker, cursorKeyOf, indexById } from './active-path'
import type { CursorMap, Message, MessageId } from './types'

interface ResolveBranchInput {
  targetId: MessageId
  byParent: Map<MessageId | null, Message[]>
  byId: Map<MessageId, Message>
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
  const byId = indexById(messages)
  let cur: Message | undefined = byId.get(targetId)
  if (!cur) return
  while (cur) {
    const parentId: MessageId | null = cur.parentId
    cursor[cursorKeyOf(parentId)] = cur.id
    cur = parentId ? byId.get(parentId) : undefined
  }
  const byParent = new Map<MessageId | null, Message[]>()
  for (const m of messages) {
    const bucket = byParent.get(m.parentId)
    if (bucket) bucket.push(m)
    else byParent.set(m.parentId, [m])
  }
  if (options.preserveDescendantPins === false) {
    const stack = [targetId]
    while (stack.length > 0) {
      const parentId = stack.pop() as MessageId
      delete cursor[cursorKeyOf(parentId)]
      for (const child of byParent.get(parentId) ?? []) stack.push(child.id)
    }
  }
  resolveLastUpdatedBranchBelow({ targetId, byParent, byId }, cursor)
}

// §8.4.3.1 fork rule:
//   1. If `cursor[current]` points at a live child, keep that entry and descend.
//   2. Otherwise pick the child whose subtree has the greatest-`createdAt`
//      live leaf, write `cursor[current] = chosenId`, descend.
// A walk that reaches a leaf (or an all-tombstoned fork) stops.
//
// This routine does NOT write `cursor[parentOfTarget] = target`. That entry is
// the caller's responsibility — it's the swipe/search-click decision. The
// helper only handles `target → leaf` below.
export function resolveLastUpdatedBranchBelow(input: ResolveBranchInput, cursor: CursorMap): void {
  const { byParent, byId } = input
  const pickDefaultChild = createDefaultChildPicker(byParent, byId)
  let currentId: MessageId = input.targetId
  for (;;) {
    const kids = (byParent.get(currentId) ?? []).filter((m) => !m.deleted)
    if (kids.length === 0) break
    const key = cursorKeyOf(currentId)
    const pinnedId = cursor[key]
    if (pinnedId !== undefined && kids.some((k) => k.id === pinnedId)) {
      currentId = pinnedId
      continue
    }
    const chosen = pickDefaultChild(kids)
    cursor[key] = chosen.id
    currentId = chosen.id
  }
}
