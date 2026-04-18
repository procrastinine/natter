// Canonical leaf-chooser. See `plan/08-branching.md §8.4.3.1`.
//
// Given a target message M and a mutable cursor, write cursor entries from
// M downward so the active-path walk agrees with the "most-recently-updated
// chain below M" choice. Swipe, branch-tree click, search-click, and
// hash-route deep-link all funnel through this helper so the same target
// always resolves to the same descendant chain.
//
// Pure view-state: no IDB, no broadcast, no chat.updatedAt effect. Inputs are
// (target, grouped tree, cursor). The cursor is mutated in place so the caller
// can merge it into Zustand atomically after the IDB transaction (if any) has
// committed.

import { cursorKeyOf, pickDefaultChild } from './active-path'
import type { CursorMap, Message, MessageId } from './types'

export interface ResolveBranchInput {
  targetId: MessageId
  byParent: Map<MessageId | null, Message[]>
  byId: Map<MessageId, Message>
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
export function resolveLastUpdatedBranchBelow(
  input: ResolveBranchInput,
  cursor: CursorMap,
): void {
  const { byParent, byId } = input
  let currentId: MessageId | null = input.targetId
  while (currentId !== null) {
    const kids = (byParent.get(currentId) ?? []).filter((m) => !m.deleted)
    if (kids.length === 0) break
    const key = cursorKeyOf(currentId)
    const pinnedId = cursor[key]
    if (pinnedId !== undefined && kids.some((k) => k.id === pinnedId)) {
      currentId = pinnedId
      continue
    }
    const chosen = pickDefaultChild(kids, byParent, byId)
    cursor[key] = chosen.id
    currentId = chosen.id
  }
}
