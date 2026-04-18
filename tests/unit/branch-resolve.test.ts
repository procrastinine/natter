import { describe, expect, it } from 'vitest'
import {
  ROOT_CURSOR_KEY,
  groupByParent,
  indexById,
} from '../../src/core/active-path'
import { resolveLastUpdatedBranchBelow } from '../../src/core/branch-resolve'
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

describe('resolveLastUpdatedBranchBelow', () => {
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
