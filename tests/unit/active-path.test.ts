import { describe, expect, it } from 'vitest'
import {
  activePath,
  cursorKeyOf,
  findLastUpdatedLeafId,
  groupByParent,
  indexById,
  isOnPathToLeaf,
  liveLeaves,
  pickDefaultChild,
  ROOT_CURSOR_KEY,
} from '../../src/core/active-path'
import type { CursorMap, Message, MessageId } from '../../src/core/types'

function mkMessage(over: Partial<Message> & Pick<Message, 'id'>): Message {
  return {
    chatId: 'C',
    parentId: null,
    siblingIndex: 0,
    turnId: over.id,
    turnIndex: 0,
    createdAt: 0,
    role: 'user',
    origin: 'user',
    content: [{ type: 'text', text: 'x' }],
    deleted: false,
    ...over,
  } as Message
}

// Deterministic fixed-length ids so greater-id tiebreaks are predictable.
const M = (n: number) => `M-${n.toString().padStart(4, '0')}`

describe('cursorKeyOf', () => {
  it('returns ROOT_CURSOR_KEY for null parent and the id for a normal parent', () => {
    expect(cursorKeyOf(null)).toBe(ROOT_CURSOR_KEY)
    expect(cursorKeyOf('abc')).toBe('abc')
  })
})

describe('groupByParent / indexById', () => {
  it('buckets messages and sorts siblings by siblingIndex', () => {
    const msgs: Message[] = [
      mkMessage({ id: M(1), parentId: null, siblingIndex: 0 }),
      mkMessage({ id: M(2), parentId: null, siblingIndex: 2 }),
      mkMessage({ id: M(3), parentId: null, siblingIndex: 1 }),
      mkMessage({ id: M(4), parentId: M(1), siblingIndex: 0 }),
    ]
    const byParent = groupByParent(msgs)
    expect((byParent.get(null) ?? []).map((m) => m.id)).toEqual([M(1), M(3), M(2)])
    expect((byParent.get(M(1)) ?? []).map((m) => m.id)).toEqual([M(4)])

    const byId = indexById(msgs)
    expect(byId.get(M(2))?.siblingIndex).toBe(2)
    expect(byId.get('missing')).toBeUndefined()
  })
})

describe('pickDefaultChild', () => {
  it('picks the child whose subtree has the greatest live-leaf createdAt', () => {
    const msgs: Message[] = [
      mkMessage({ id: M(1), parentId: null, siblingIndex: 0, createdAt: 1 }),
      mkMessage({ id: M(2), parentId: null, siblingIndex: 1, createdAt: 2 }),
      // M(1)'s subtree contains a later leaf than M(2)'s solo createdAt.
      mkMessage({ id: M(3), parentId: M(1), siblingIndex: 0, createdAt: 10 }),
    ]
    const byParent = groupByParent(msgs)
    const byId = indexById(msgs)
    const kids = (byParent.get(null) ?? []).filter((m) => !m.deleted)
    const chosen = pickDefaultChild(kids, byParent, byId)
    expect(chosen.id).toBe(M(1))
  })

  it('breaks ties by greater siblingIndex, then greater id', () => {
    const msgs: Message[] = [
      mkMessage({ id: M(1), parentId: null, siblingIndex: 0, createdAt: 5 }),
      mkMessage({ id: M(2), parentId: null, siblingIndex: 1, createdAt: 5 }),
    ]
    const byParent = groupByParent(msgs)
    const byId = indexById(msgs)
    const chosen = pickDefaultChild(byParent.get(null) ?? [], byParent, byId)
    expect(chosen.id).toBe(M(2)) // higher siblingIndex wins on tied score
  })
})

describe('activePath', () => {
  it('derives the leaf chain with no cursor entries via the default-child rule', () => {
    // Tree:
    //   (root) → M1 (C:1) → M3 (C:5)
    //          → M2 (C:4)
    const msgs: Message[] = [
      mkMessage({ id: M(1), parentId: null, siblingIndex: 0, createdAt: 1 }),
      mkMessage({ id: M(2), parentId: null, siblingIndex: 1, createdAt: 4 }),
      mkMessage({ id: M(3), parentId: M(1), siblingIndex: 0, createdAt: 5 }),
    ]
    const path = activePath(msgs, {})
    expect(path.map((m) => m.id)).toEqual([M(1), M(3)])
  })

  it('honors a valid cursor entry even when it points away from the max-createdAt branch', () => {
    const msgs: Message[] = [
      mkMessage({ id: M(1), parentId: null, siblingIndex: 0, createdAt: 1 }),
      mkMessage({ id: M(2), parentId: null, siblingIndex: 1, createdAt: 4 }),
      mkMessage({ id: M(3), parentId: M(1), siblingIndex: 0, createdAt: 10 }),
    ]
    const cursor: CursorMap = { [ROOT_CURSOR_KEY]: M(2) }
    const path = activePath(msgs, cursor)
    expect(path.map((m) => m.id)).toEqual([M(2)])
  })

  it('falls back to default when the cursor points at a tombstoned or missing id', () => {
    const msgs: Message[] = [
      mkMessage({ id: M(1), parentId: null, siblingIndex: 0, createdAt: 10 }),
      mkMessage({ id: M(2), parentId: null, siblingIndex: 1, createdAt: 5, deleted: true }),
    ]
    // Tombstoned target → ignored → fallback picks M(1) (only live).
    let path = activePath(msgs, { [ROOT_CURSOR_KEY]: M(2) })
    expect(path.map((m) => m.id)).toEqual([M(1)])
    // Missing target → ignored → fallback.
    path = activePath(msgs, { [ROOT_CURSOR_KEY]: 'nope' })
    expect(path.map((m) => m.id)).toEqual([M(1)])
  })

  it('returns an empty path when the chat has no live messages', () => {
    expect(activePath([], {})).toEqual([])
    expect(activePath([mkMessage({ id: M(1), deleted: true })], {})).toEqual([])
  })
})

describe('liveLeaves / findLastUpdatedLeafId', () => {
  it('finds live leaves and picks the greatest-createdAt one (tiebreak: greater id)', () => {
    const msgs: Message[] = [
      mkMessage({ id: M(1), parentId: null, siblingIndex: 0, createdAt: 1 }),
      mkMessage({ id: M(2), parentId: M(1), siblingIndex: 0, createdAt: 5 }),
      mkMessage({ id: M(3), parentId: M(1), siblingIndex: 1, createdAt: 5 }),
      mkMessage({ id: M(4), parentId: M(1), siblingIndex: 2, createdAt: 3, deleted: true }),
    ]
    const leaves = liveLeaves(msgs).map((m) => m.id)
    expect(leaves.sort()).toEqual([M(2), M(3)])
    // Same createdAt (5); tiebreak to M(3) (greater id).
    expect(findLastUpdatedLeafId(msgs)).toBe(M(3))
  })

  it('returns null for an empty chat or a fully-tombstoned chat', () => {
    expect(findLastUpdatedLeafId([])).toBeNull()
    expect(findLastUpdatedLeafId([mkMessage({ id: M(1), deleted: true })])).toBeNull()
  })
})

describe('isOnPathToLeaf', () => {
  it('follows parentId and returns true only for ancestors of the leaf', () => {
    const msgs: Message[] = [
      mkMessage({ id: M(1), parentId: null }),
      mkMessage({ id: M(2), parentId: M(1) }),
      mkMessage({ id: M(3), parentId: M(2) }),
      mkMessage({ id: M(4), parentId: M(1) }),
    ]
    const byId = indexById(msgs)
    expect(isOnPathToLeaf(M(1), M(3), byId)).toBe(true)
    expect(isOnPathToLeaf(M(2), M(3), byId)).toBe(true)
    expect(isOnPathToLeaf(M(3), M(3), byId)).toBe(true)
    expect(isOnPathToLeaf(M(4), M(3), byId)).toBe(false)
  })

  it('returns false when the leaf id does not resolve to a known message', () => {
    const byId = new Map<MessageId, Message>()
    expect(isOnPathToLeaf('X', 'ghost', byId)).toBe(false)
  })
})
