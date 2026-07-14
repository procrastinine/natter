import { describe, expect, it } from 'vitest'
import {
  createMessageTreeProjection,
  cursorKeyOf,
  groupByParent,
  indexById,
  ROOT_CURSOR_KEY,
  resolveActiveLeafId,
} from '../../src/core/active-path'
import { resolveLastUpdatedBranchBelow, seedCursorAtMessage } from '../../src/core/branch-resolve'
import { swipe, swipeProjected } from '../../src/core/messages'
import type { CursorMap, Message } from '../../src/core/types'

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

const M = (n: number) => `M-${n.toString().padStart(4, '0')}`

describe('seedCursorAtMessage', () => {
  it('lands on the newest leaf that contains the pinned interior node', () => {
    const msgs: Message[] = [
      mkMessage({ id: M(1), parentId: null, siblingIndex: 0, createdAt: 1 }),
      mkMessage({ id: M(2), parentId: M(1), siblingIndex: 0, createdAt: 2 }),
      mkMessage({ id: M(3), parentId: M(1), siblingIndex: 1, createdAt: 100 }),
      mkMessage({ id: M(4), parentId: M(2), siblingIndex: 0, createdAt: 5 }),
      mkMessage({ id: M(5), parentId: M(2), siblingIndex: 1, createdAt: 9 }),
    ]
    const cursor: CursorMap = {}

    seedCursorAtMessage(msgs, M(2), cursor)

    expect(cursor[ROOT_CURSOR_KEY]).toBe(M(1))
    expect(cursor[M(1)]).toBe(M(2))
    expect(cursor[M(2)]).toBe(M(5))
    expect(resolveActiveLeafId(msgs, cursor)).toBe(M(5))
  })

  it('can replace remembered descendants with the newest containing leaf', () => {
    const msgs: Message[] = [
      mkMessage({ id: M(1), parentId: null, siblingIndex: 0, createdAt: 1 }),
      mkMessage({ id: M(2), parentId: M(1), siblingIndex: 0, createdAt: 2 }),
      mkMessage({ id: M(3), parentId: M(1), siblingIndex: 1, createdAt: 3 }),
      mkMessage({ id: M(4), parentId: M(2), siblingIndex: 0, createdAt: 4 }),
      mkMessage({ id: M(5), parentId: M(2), siblingIndex: 1, createdAt: 8 }),
      mkMessage({ id: M(6), parentId: M(3), siblingIndex: 0, createdAt: 9 }),
      mkMessage({ id: M(7), parentId: M(4), siblingIndex: 0, createdAt: 6 }),
    ]
    const cursor: CursorMap = {
      [M(1)]: M(2),
      [M(2)]: M(4),
      [M(3)]: M(6),
      [M(4)]: M(7),
    }

    seedCursorAtMessage(msgs, M(2), cursor, { preserveDescendantPins: false })

    expect(cursor[ROOT_CURSOR_KEY]).toBe(M(1))
    expect(cursor[M(1)]).toBe(M(2))
    expect(cursor[M(2)]).toBe(M(5))
    expect(cursor[M(3)]).toBe(M(6))
    expect(cursor[M(4)]).toBe(M(7))
    expect(resolveActiveLeafId(msgs, cursor)).toBe(M(5))
  })
})

describe('resolveLastUpdatedBranchBelow', () => {
  it('ignores a newer interior insert-between timestamp when choosing the descendant branch', () => {
    const msgs: Message[] = [
      mkMessage({ id: 'root', parentId: null, siblingIndex: 0, createdAt: 0 }),
      mkMessage({ id: 'branch-a', parentId: 'root', siblingIndex: 0, createdAt: 100 }),
      mkMessage({ id: 'leaf-a', parentId: 'branch-a', siblingIndex: 0, createdAt: 1 }),
      mkMessage({ id: 'branch-b', parentId: 'root', siblingIndex: 1, createdAt: 50 }),
    ]
    const cursor: CursorMap = {}

    resolveLastUpdatedBranchBelow(
      {
        targetId: 'root',
        byParent: groupByParent(msgs),
        byId: indexById(msgs),
      },
      cursor,
    )

    expect(cursor).toEqual({ root: 'branch-b' })
    expect(resolveActiveLeafId(msgs, cursor)).toBe('branch-b')
  })

  it('writes cursor entries for each fork below the target along the max-createdAt chain', () => {
    // Tree:
    //   M1 ── M2 (C:5) ── M4 (C:9)
    //      └─ M3 (C:10)
    const msgs: Message[] = [
      mkMessage({ id: M(1), parentId: null, siblingIndex: 0, createdAt: 1 }),
      mkMessage({ id: M(2), parentId: M(1), siblingIndex: 0, createdAt: 5 }),
      mkMessage({ id: M(3), parentId: M(1), siblingIndex: 1, createdAt: 10 }),
      mkMessage({ id: M(4), parentId: M(2), siblingIndex: 0, createdAt: 9 }),
    ]
    const cursor: CursorMap = {}
    resolveLastUpdatedBranchBelow(
      {
        targetId: M(1),
        byParent: groupByParent(msgs),
        byId: indexById(msgs),
      },
      cursor,
    )
    // From M1, max-createdAt subtree is under M3 (10 > M2's subtree max of 9).
    expect(cursor[M(1)]).toBe(M(3))
    // M3 has no descendants — walk stops here.
    expect(Object.keys(cursor)).toEqual([M(1)])
  })

  it('preserves pre-existing cursor pins and does not overwrite them', () => {
    const msgs: Message[] = [
      mkMessage({ id: M(1), parentId: null, siblingIndex: 0, createdAt: 1 }),
      mkMessage({ id: M(2), parentId: M(1), siblingIndex: 0, createdAt: 5 }),
      mkMessage({ id: M(3), parentId: M(1), siblingIndex: 1, createdAt: 10 }),
    ]
    const cursor: CursorMap = { [M(1)]: M(2) } // pinned to older sibling
    resolveLastUpdatedBranchBelow(
      {
        targetId: M(1),
        byParent: groupByParent(msgs),
        byId: indexById(msgs),
      },
      cursor,
    )
    expect(cursor[M(1)]).toBe(M(2))
  })

  it('falls through a cursor entry that points at a tombstoned child', () => {
    const msgs: Message[] = [
      mkMessage({ id: M(1), parentId: null, siblingIndex: 0, createdAt: 1 }),
      mkMessage({ id: M(2), parentId: M(1), siblingIndex: 0, createdAt: 5, deleted: true }),
      mkMessage({ id: M(3), parentId: M(1), siblingIndex: 1, createdAt: 10 }),
    ]
    const cursor: CursorMap = { [M(1)]: M(2) }
    resolveLastUpdatedBranchBelow(
      {
        targetId: M(1),
        byParent: groupByParent(msgs),
        byId: indexById(msgs),
      },
      cursor,
    )
    expect(cursor[M(1)]).toBe(M(3))
  })

  it('stops at a leaf — a target with no descendants writes no cursor entries', () => {
    const msgs: Message[] = [mkMessage({ id: M(1), parentId: null })]
    const cursor: CursorMap = { [ROOT_CURSOR_KEY]: M(1) }
    resolveLastUpdatedBranchBelow(
      {
        targetId: M(1),
        byParent: groupByParent(msgs),
        byId: indexById(msgs),
      },
      cursor,
    )
    expect(cursor).toEqual({ [ROOT_CURSOR_KEY]: M(1) })
  })

  it('writes cursor entries convergent with activePath when invoked from the root', () => {
    // Two-fork tree with a deeper right branch.
    const msgs: Message[] = [
      mkMessage({ id: M(1), parentId: null, siblingIndex: 0, createdAt: 1 }),
      mkMessage({ id: M(2), parentId: M(1), siblingIndex: 0, createdAt: 5 }),
      mkMessage({ id: M(3), parentId: M(1), siblingIndex: 1, createdAt: 6 }),
      mkMessage({ id: M(4), parentId: M(3), siblingIndex: 0, createdAt: 11 }),
      mkMessage({ id: M(5), parentId: M(3), siblingIndex: 1, createdAt: 12 }),
    ]
    const cursor: CursorMap = {}
    resolveLastUpdatedBranchBelow(
      {
        targetId: M(1),
        byParent: groupByParent(msgs),
        byId: indexById(msgs),
      },
      cursor,
    )
    // Should land on M3 (larger subtree max), then M5 (12 > 11).
    expect(cursor[M(1)]).toBe(M(3))
    expect(cursor[M(3)]).toBe(M(5))
  })
})

describe('projected swipe', () => {
  const messages: Message[] = [
    mkMessage({ id: 'root-a', parentId: null, siblingIndex: 0, createdAt: 1 }),
    mkMessage({ id: 'root-b', parentId: null, siblingIndex: 1, createdAt: 2 }),
    mkMessage({ id: 'a-older', parentId: 'root-a', siblingIndex: 0, createdAt: 10 }),
    mkMessage({ id: 'a-newer', parentId: 'root-a', siblingIndex: 1, createdAt: 30 }),
    mkMessage({ id: 'b-older', parentId: 'root-b', siblingIndex: 0, createdAt: 20 }),
    mkMessage({ id: 'b-newer', parentId: 'root-b', siblingIndex: 1, createdAt: 25 }),
    mkMessage({
      id: 'b-deleted',
      parentId: 'root-b',
      siblingIndex: 2,
      createdAt: 100,
      deleted: true,
    }),
  ]

  it('matches the message-array API across directions and descendant cursor states', () => {
    const projection = createMessageTreeProjection(messages)
    const cases: Array<{ targetId: string; direction: -1 | 1; cursor: CursorMap }> = [
      { targetId: 'root-a', direction: 1, cursor: { [ROOT_CURSOR_KEY]: 'root-a' } },
      { targetId: 'root-b', direction: -1, cursor: { [ROOT_CURSOR_KEY]: 'root-b' } },
      {
        targetId: 'root-a',
        direction: 1,
        cursor: { [ROOT_CURSOR_KEY]: 'root-a', 'root-b': 'b-older' },
      },
      {
        targetId: 'root-a',
        direction: 1,
        cursor: { [ROOT_CURSOR_KEY]: 'root-a', 'root-b': 'b-deleted' },
      },
      { targetId: 'a-older', direction: 1, cursor: { 'root-a': 'a-older' } },
      { targetId: 'b-newer', direction: -1, cursor: { 'root-b': 'b-newer' } },
    ]

    for (const input of cases) {
      const expected = swipe({ messages, ...input })
      const actual = swipeProjected({ projection, ...input })
      expect(actual).toEqual(expected)
      expect({ ...input.cursor, ...actual.cursorUpdates }).toEqual(
        referenceSwipeCursor(messages, input.targetId, input.direction, input.cursor),
      )
    }
  })

  it('builds subtree scores at most once for repeated swipes on one structural projection', () => {
    let scoreBuilds = 0
    const projection = createMessageTreeProjection(messages, {
      onBuildScores: () => {
        scoreBuilds += 1
      },
    })

    expect(scoreBuilds).toBe(0)
    const towardB = swipeProjected({
      projection,
      targetId: 'root-a',
      direction: 1,
      cursor: { [ROOT_CURSOR_KEY]: 'root-a' },
    })
    expect(towardB.cursorUpdates).toMatchObject({
      [ROOT_CURSOR_KEY]: 'root-b',
      'root-b': 'b-newer',
    })
    expect(scoreBuilds).toBe(1)

    const towardA = swipeProjected({
      projection,
      targetId: 'root-b',
      direction: -1,
      cursor: { [ROOT_CURSOR_KEY]: 'root-b' },
    })
    expect(towardA.cursorUpdates).toMatchObject({
      [ROOT_CURSOR_KEY]: 'root-a',
      'root-a': 'a-newer',
    })
    expect(scoreBuilds).toBe(1)
  })
})

function referenceSwipeCursor(
  messages: readonly Message[],
  targetId: string,
  direction: -1 | 1,
  cursor: CursorMap,
): CursorMap {
  const byParent = groupByParent(messages)
  const byId = indexById(messages)
  const target = byId.get(targetId)
  if (!target) throw new Error(`missing reference swipe target ${targetId}`)
  const siblings = (byParent.get(target.parentId) ?? []).filter((message) => !message.deleted)
  const index = siblings.findIndex((message) => message.id === targetId)
  const chosen = siblings[(index + direction + siblings.length) % siblings.length]
  if (!chosen) return { ...cursor }
  const next = { ...cursor, [cursorKeyOf(target.parentId)]: chosen.id }
  resolveLastUpdatedBranchBelow({ targetId: chosen.id, byParent, byId }, next)
  return next
}
