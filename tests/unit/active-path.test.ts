import { describe, expect, it } from 'vitest'
import {
  createActiveBranchSpine,
  emptyActiveBranchChildSlot,
} from '../../src/core/active-branch-spine'
import {
  compareLiveLeafRecency,
  findLastUpdatedLeafId,
  indexById,
} from '../../src/core/active-path'
import { createMessageTopologyIndex } from '../../src/core/message-topology'
import { treeParentKey } from '../../src/core/message-tree-index'
import type { Message, MessageId } from '../../src/core/types'
import { splitMessageForStorage } from '../../src/store/message-storage'

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
    nodeVersion: 0,
    deleted: false,
    ...over,
  }
}

const M = (n: number) => `M-${n.toString().padStart(4, '0')}`

function branchTo(messages: readonly Message[], leafId: MessageId): Message[] {
  const byId = indexById(messages)
  const reversed: Message[] = []
  const seen = new Set<MessageId>()
  let currentId: MessageId | null = leafId
  while (currentId !== null) {
    if (seen.has(currentId)) throw new Error(`TestBranchCycle:${currentId}`)
    seen.add(currentId)
    const current = byId.get(currentId)
    if (!current || current.deleted) throw new Error(`TestBranchUnavailable:${currentId}`)
    reversed.push(current)
    currentId = current.parentId
  }
  return reversed.reverse()
}

function exactSpine(messages: readonly Message[], leafId: MessageId) {
  const headers = branchTo(messages, leafId).map(
    (message) => splitMessageForStorage(message).header,
  )
  return createActiveBranchSpine({
    chatId: 'C',
    structuralVersion: 1,
    resolvedLeafId: leafId,
    headers,
    terminalChildSlot: emptyActiveBranchChildSlot(leafId),
  })
}

function referenceLastUpdatedLeafId(messages: readonly Message[]): MessageId | null {
  const liveParentIds = new Set<MessageId>()
  for (const message of messages) {
    if (!message.deleted && message.parentId !== null) liveParentIds.add(message.parentId)
  }
  let newest: Message | null = null
  for (const message of messages) {
    if (message.deleted || liveParentIds.has(message.id)) continue
    if (!newest || compareLiveLeafRecency(message, newest) > 0) newest = message
  }
  return newest?.id ?? null
}

function seededTree(seed: number, size: number): Message[] {
  let state = seed >>> 0
  const random = () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state
  }
  const messages: Message[] = []
  const childrenByParent = new Map<string, number>()
  for (let index = 0; index < size; index += 1) {
    const parentIndex = index === 0 || random() % 5 === 0 ? -1 : random() % index
    const parentId = parentIndex < 0 ? null : (messages[parentIndex]?.id ?? null)
    const parentKey = treeParentKey(parentId)
    const nextSibling = childrenByParent.get(parentKey) ?? 0
    childrenByParent.set(parentKey, nextSibling + 1)
    messages.push(
      mkMessage({
        id: `S${seed}-${index.toString().padStart(4, '0')}`,
        parentId,
        siblingIndex: nextSibling,
        createdAt: random() % 23,
        deleted: random() % 6 === 0,
      }),
    )
  }
  return messages
}

describe('treeParentKey', () => {
  it('uses one canonical root key and preserves normal parent ids', () => {
    expect(treeParentKey(null)).not.toBe('abc')
    expect(treeParentKey('abc')).toBe('abc')
    expect(treeParentKey(null)).toBe(treeParentKey(null))
  })
})

describe('indexById', () => {
  it('indexes messages without copying them', () => {
    const messages = [
      mkMessage({ id: M(1), siblingIndex: 0 }),
      mkMessage({ id: M(2), siblingIndex: 2 }),
      mkMessage({ id: M(3), siblingIndex: 1 }),
    ]
    const byId = indexById(messages)
    expect(byId.get(M(2))).toBe(messages[1])
    expect(byId.get('missing')).toBeUndefined()
  })
})

describe('last-updated branch semantics', () => {
  it('uses the greatest live descendant leaf rather than an interior createdAt', () => {
    const messages = [
      mkMessage({ id: M(1), siblingIndex: 0, createdAt: 1 }),
      mkMessage({ id: M(2), siblingIndex: 1, createdAt: 2 }),
      mkMessage({ id: M(3), parentId: M(1), siblingIndex: 0, createdAt: 10 }),
    ]
    expect(findLastUpdatedLeafId(messages)).toBe(M(3))
  })

  it('breaks equal-createdAt leaf ties by greater leaf id before sibling order', () => {
    const messages = [
      mkMessage({ id: M(1), siblingIndex: 10, createdAt: 5 }),
      mkMessage({ id: M(2), siblingIndex: 0, createdAt: 5 }),
    ]
    expect(findLastUpdatedLeafId(messages)).toBe(M(2))
  })

  it('scores only leaves when a newer insert-between node is interior', () => {
    const messages = [
      mkMessage({ id: 'branch-a', siblingIndex: 0, createdAt: 100 }),
      mkMessage({ id: 'leaf-a', parentId: 'branch-a', siblingIndex: 0, createdAt: 1 }),
      mkMessage({ id: 'branch-b', siblingIndex: 1, createdAt: 50 }),
    ]
    expect(findLastUpdatedLeafId(messages)).toBe('branch-b')
  })

  it('excludes tombstones but treats a live node with only tombstones as a leaf', () => {
    const messages = [
      mkMessage({ id: 'branch-a', siblingIndex: 0, createdAt: 100 }),
      mkMessage({ id: 'leaf-a', parentId: 'branch-a', siblingIndex: 0, createdAt: 1 }),
      mkMessage({
        id: 'deleted-a',
        parentId: 'branch-a',
        siblingIndex: 1,
        createdAt: 1_000,
        deleted: true,
      }),
      mkMessage({ id: 'branch-b', siblingIndex: 1, createdAt: 50 }),
    ]
    expect(findLastUpdatedLeafId(messages)).toBe('branch-b')
    expect(findLastUpdatedLeafId(messages.filter((message) => message.id !== 'leaf-a'))).toBe(
      'branch-a',
    )
  })

  it('uses the newest leaf id before candidate sibling order when timestamps tie', () => {
    const messages = [
      mkMessage({ id: 'branch-a', siblingIndex: 10, createdAt: 1 }),
      mkMessage({ id: 'leaf-a', parentId: 'branch-a', siblingIndex: 0, createdAt: 50 }),
      mkMessage({ id: 'branch-z', siblingIndex: 0, createdAt: 2 }),
      mkMessage({ id: 'leaf-z', parentId: 'branch-z', siblingIndex: 0, createdAt: 50 }),
    ]
    expect(findLastUpdatedLeafId(messages)).toBe('leaf-z')
  })

  it('matches an independent reference across deterministic mixed trees', () => {
    for (let seed = 1; seed <= 100; seed += 1) {
      const messages = seededTree(seed, 50 + (seed % 151))
      expect(findLastUpdatedLeafId(messages)).toBe(referenceLastUpdatedLeafId(messages))
    }
  })

  it('returns null for an empty or fully tombstoned chat', () => {
    expect(findLastUpdatedLeafId([])).toBeNull()
    expect(findLastUpdatedLeafId([mkMessage({ id: M(1), deleted: true })])).toBeNull()
  })
})

describe('exact per-tab branch spines', () => {
  it('keeps an exact tab tip even when a different durable leaf is newer', () => {
    const root = mkMessage({ id: M(1), createdAt: 1 })
    const selected = mkMessage({ id: M(2), parentId: root.id, siblingIndex: 0, createdAt: 2 })
    const newer = mkMessage({ id: M(3), parentId: root.id, siblingIndex: 1, createdAt: 10 })
    const messages = [root, selected, newer]

    expect(findLastUpdatedLeafId(messages)).toBe(newer.id)
    expect(exactSpine(messages, selected.id).path.materializeIds()).toEqual([root.id, selected.id])
  })

  it('rejects a tombstoned exact target instead of silently choosing another branch', () => {
    const root = mkMessage({ id: M(1), createdAt: 1 })
    const deleted = mkMessage({
      id: M(2),
      parentId: root.id,
      createdAt: 2,
      deleted: true,
    })
    expect(() => exactSpine([root, deleted], deleted.id)).toThrow(
      `TestBranchUnavailable:${deleted.id}`,
    )
  })

  it('walks a deep branch iteratively while preserving header identity', () => {
    const messages = Array.from({ length: 10_000 }, (_, index) =>
      mkMessage({
        id: `D-${index.toString().padStart(5, '0')}`,
        parentId: index === 0 ? null : `D-${(index - 1).toString().padStart(5, '0')}`,
        createdAt: index,
      }),
    )
    const spine = exactSpine(messages, messages.at(-1)?.id as MessageId)
    expect(spine.path.length).toBe(messages.length)
    expect(spine.path.leaf?.id).toBe(messages.at(-1)?.id)
  })

  it('selects a 10k-wide durable default with linear leaf work', () => {
    const messages = Array.from({ length: 10_000 }, (_, index) =>
      mkMessage({
        id: `W-${index.toString().padStart(5, '0')}`,
        siblingIndex: index,
        createdAt: index,
      }),
    )
    expect(findLastUpdatedLeafId(messages)).toBe('W-09999')
  })

  it('reuses one immutable topology across cursor-only exact-path changes', () => {
    const messages = [
      mkMessage({ id: M(1), siblingIndex: 0, createdAt: 1 }),
      mkMessage({ id: M(2), siblingIndex: 1, createdAt: 2 }),
      mkMessage({ id: M(3), parentId: M(1), createdAt: 3 }),
      mkMessage({ id: M(4), parentId: M(2), createdAt: 4 }),
    ]
    const topology = createMessageTopologyIndex(messages, {
      sameStructure: (left, right) =>
        left.parentId === right.parentId &&
        left.siblingIndex === right.siblingIndex &&
        left.deleted === right.deleted,
    })
    const leftSpine = exactSpine(messages, M(3))
    const rightSpine = exactSpine(messages, M(4))

    expect(leftSpine.path.materializeIds()).toEqual([M(1), M(3)])
    expect(rightSpine.path.materializeIds()).toEqual([M(2), M(4)])
    expect(topology.byId.get(M(1))).toBe(messages[0])
    expect(topology.byId.get(M(4))).toBe(messages[3])
  })

  it('indexes live siblings once while preserving tombstones in structural buckets', () => {
    const messages = [
      mkMessage({ id: M(1), createdAt: 1 }),
      mkMessage({ id: M(2), parentId: M(1), createdAt: 2, deleted: true }),
      mkMessage({ id: M(3), parentId: M(1), siblingIndex: 1, createdAt: 3 }),
    ]
    const topology = createMessageTopologyIndex(messages, {
      sameStructure: (left, right) =>
        left.parentId === right.parentId &&
        left.siblingIndex === right.siblingIndex &&
        left.deleted === right.deleted,
    })
    const liveChildren = topology.liveByParent.get(M(1))

    expect(topology.byParent.get(M(1))?.map((message) => message.id)).toEqual([M(2), M(3)])
    expect(liveChildren?.map((message) => message.id)).toEqual([M(3)])
    expect(topology.liveByParent.get(M(1))).toBe(liveChildren)
  })
})
