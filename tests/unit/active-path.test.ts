import { describe, expect, it } from 'vitest'
import {
  activePath,
  activePathProjected,
  createMessageTreeProjection,
  cursorKeyOf,
  findLastUpdatedLeafId,
  groupByParent,
  indexById,
  isOnPathToLeaf,
  liveLeaves,
  pickDefaultChild,
  ROOT_CURSOR_KEY,
  resolveActiveLeafId,
  resolveActiveLeafIdProjected,
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

function referenceActivePath(messages: readonly Message[], cursor: CursorMap): Message[] {
  const byParent = groupByParent(messages)
  const byId = indexById(messages)
  const subtreeLeafScore = (
    rootId: MessageId,
  ): { createdAt: number; id: MessageId } | undefined => {
    let best: { createdAt: number; id: MessageId } | undefined
    const stack = [rootId]
    while (stack.length > 0) {
      const id = stack.pop() as MessageId
      const message = byId.get(id)
      if (!message || message.deleted) continue
      const liveChildren = (byParent.get(id) ?? []).filter((child) => !child.deleted)
      if (liveChildren.length > 0) {
        for (const child of liveChildren) stack.push(child.id)
        continue
      }
      if (
        !best ||
        message.createdAt > best.createdAt ||
        (message.createdAt === best.createdAt && message.id > best.id)
      ) {
        best = { createdAt: message.createdAt, id: message.id }
      }
    }
    return best
  }
  const path: Message[] = []
  let parentId: MessageId | null = null
  for (;;) {
    const children: Message[] = (byParent.get(parentId) ?? []).filter((message) => !message.deleted)
    if (children.length === 0) return path
    const pinnedId: MessageId | undefined = cursor[cursorKeyOf(parentId)]
    const pinned: Message | undefined =
      pinnedId === undefined ? undefined : children.find((message) => message.id === pinnedId)
    let chosen: Message = pinned ?? (children[0] as Message)
    if (!pinned) {
      let chosenScore = subtreeLeafScore(chosen.id)
      for (let index = 1; index < children.length; index += 1) {
        const candidate = children[index] as Message
        const candidateScore = subtreeLeafScore(candidate.id)
        const scoreOrder = candidateScore
          ? chosenScore
            ? candidateScore.createdAt - chosenScore.createdAt ||
              (candidateScore.id < chosenScore.id ? -1 : candidateScore.id > chosenScore.id ? 1 : 0)
            : 1
          : chosenScore
            ? -1
            : 0
        if (
          scoreOrder > 0 ||
          (scoreOrder === 0 &&
            (candidate.siblingIndex > chosen.siblingIndex ||
              (candidate.siblingIndex === chosen.siblingIndex && candidate.id > chosen.id)))
        ) {
          chosen = candidate
          chosenScore = candidateScore
        }
      }
    }
    path.push(chosen)
    parentId = chosen.id
  }
}

function seededTree(seed: number, size: number): { messages: Message[]; cursor: CursorMap } {
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
    const parentKey = parentId ?? ROOT_CURSOR_KEY
    const nextSibling = childrenByParent.get(parentKey) ?? 0
    childrenByParent.set(parentKey, nextSibling + 1)
    messages.push(
      mkMessage({
        id: `S${seed}-${index.toString().padStart(4, '0')}`,
        parentId,
        siblingIndex: random() % 7 === 0 ? Math.max(0, nextSibling - 1) : nextSibling,
        createdAt: random() % 23,
        deleted: random() % 6 === 0,
      }),
    )
  }
  const cursor: CursorMap = {}
  for (const [parentId, children] of groupByParent(messages)) {
    if (random() % 3 !== 0 || children.length === 0) continue
    const choice = random() % (children.length + 1)
    const selected = children[choice]
    cursor[cursorKeyOf(parentId)] = selected?.id ?? `missing-${seed}-${parentId ?? 'root'}`
  }
  return { messages, cursor }
}

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

  it('breaks equal-createdAt leaf ties by greater leaf id before sibling order', () => {
    const msgs: Message[] = [
      mkMessage({ id: M(1), parentId: null, siblingIndex: 10, createdAt: 5 }),
      mkMessage({ id: M(2), parentId: null, siblingIndex: 0, createdAt: 5 }),
    ]
    const byParent = groupByParent(msgs)
    const byId = indexById(msgs)
    const chosen = pickDefaultChild(byParent.get(null) ?? [], byParent, byId)
    expect(chosen.id).toBe(M(2))
  })

  it('scores only live leaves when a newer insert-between node is interior', () => {
    const msgs: Message[] = [
      mkMessage({ id: 'branch-a', parentId: null, siblingIndex: 0, createdAt: 100 }),
      mkMessage({ id: 'leaf-a', parentId: 'branch-a', siblingIndex: 0, createdAt: 1 }),
      mkMessage({ id: 'branch-b', parentId: null, siblingIndex: 1, createdAt: 50 }),
    ]
    const byParent = groupByParent(msgs)
    const byId = indexById(msgs)

    expect(pickDefaultChild(byParent.get(null) ?? [], byParent, byId).id).toBe('branch-b')
    expect(activePath(msgs, {}).map((message) => message.id)).toEqual(['branch-b'])
    expect(resolveActiveLeafId(msgs, {})).toBe('branch-b')
    expect(findLastUpdatedLeafId(msgs)).toBe('branch-b')
  })

  it('excludes tombstones from leaf scores but treats a live node with only tombstones as a leaf', () => {
    // Valid post-delete-splice shape: leaf-a has already been promoted beside
    // the tombstone before active-path resolution sees the tree.
    const withLiveDescendant: Message[] = [
      mkMessage({ id: 'branch-a', parentId: null, siblingIndex: 0, createdAt: 100 }),
      mkMessage({ id: 'leaf-a', parentId: 'branch-a', siblingIndex: 0, createdAt: 1 }),
      mkMessage({
        id: 'deleted-a',
        parentId: 'branch-a',
        siblingIndex: 1,
        createdAt: 1_000,
        deleted: true,
      }),
      mkMessage({ id: 'branch-b', parentId: null, siblingIndex: 1, createdAt: 50 }),
    ]
    expect(activePath(withLiveDescendant, {}).at(-1)?.id).toBe('branch-b')

    const withOnlyTombstone = withLiveDescendant.filter((message) => message.id !== 'leaf-a')
    expect(activePath(withOnlyTombstone, {}).at(-1)?.id).toBe('branch-a')
    expect(findLastUpdatedLeafId(withOnlyTombstone)).toBe('branch-a')
  })

  it('uses the newest leaf id before candidate sibling order when leaf timestamps tie', () => {
    const msgs: Message[] = [
      mkMessage({ id: 'branch-a', parentId: null, siblingIndex: 10, createdAt: 1 }),
      mkMessage({ id: 'leaf-a', parentId: 'branch-a', siblingIndex: 0, createdAt: 50 }),
      mkMessage({ id: 'branch-z', parentId: null, siblingIndex: 0, createdAt: 2 }),
      mkMessage({ id: 'leaf-z', parentId: 'branch-z', siblingIndex: 0, createdAt: 50 }),
    ]

    expect(activePath(msgs, {}).map((message) => message.id)).toEqual(['branch-z', 'leaf-z'])
    expect(findLastUpdatedLeafId(msgs)).toBe('leaf-z')
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

  it('matches an independent live-leaf reference across deterministic mixed trees', () => {
    for (let seed = 1; seed <= 100; seed += 1) {
      const { messages, cursor } = seededTree(seed, 50 + (seed % 151))
      expect(activePath(messages, cursor).map((message) => message.id)).toEqual(
        referenceActivePath(messages, cursor).map((message) => message.id),
      )
    }
  })

  it('converges an empty cursor to lastUpdatedLeafId across valid trees', () => {
    for (let seed = 1; seed <= 100; seed += 1) {
      const messages = seededTree(seed, 50 + (seed % 151)).messages.map((message) => ({
        ...message,
        deleted: false,
      }))
      expect(resolveActiveLeafId(messages, {})).toBe(findLastUpdatedLeafId(messages))
    }
  })

  it('walks a deep branch iteratively without copying ancestor rows', () => {
    const messages = Array.from({ length: 10_000 }, (_, index) =>
      mkMessage({
        id: `D-${index.toString().padStart(5, '0')}`,
        parentId: index === 0 ? null : `D-${(index - 1).toString().padStart(5, '0')}`,
        createdAt: index,
      }),
    )

    let measurement: Parameters<NonNullable<Parameters<typeof activePath>[2]>>[0] | undefined
    const path = activePath(messages, {}, (value) => {
      measurement = value
    })
    expect(path).toHaveLength(messages.length)
    expect(path[0]).toBe(messages[0])
    expect(path.at(-1)).toBe(messages.at(-1))
    expect(measurement).toEqual({
      bucketedRows: 10_000,
      indexedRows: 10_000,
      scoredRows: 10_000,
      scoreEdges: 9_999,
      pathSteps: 10_000,
      childCandidates: 10_000,
    })
  })

  it('scores a 10k-wide fork with linear candidate work', () => {
    const messages = Array.from({ length: 10_000 }, (_, index) =>
      mkMessage({
        id: `W-${index.toString().padStart(5, '0')}`,
        parentId: null,
        siblingIndex: index,
        createdAt: index,
      }),
    )
    let measurement: Parameters<NonNullable<Parameters<typeof activePath>[2]>>[0] | undefined
    const path = activePath(messages, {}, (value) => {
      measurement = value
    })

    expect(path.map((message) => message.id)).toEqual(['W-09999'])
    expect(measurement).toEqual({
      bucketedRows: 10_000,
      indexedRows: 10_000,
      scoredRows: 10_000,
      scoreEdges: 0,
      pathSteps: 1,
      childCandidates: 10_000,
    })
  })

  it('reuses one structural projection across cursor-only navigation', () => {
    const messages = [
      mkMessage({ id: M(1), parentId: null, siblingIndex: 0, createdAt: 1 }),
      mkMessage({ id: M(2), parentId: null, siblingIndex: 1, createdAt: 2 }),
      mkMessage({ id: M(3), parentId: M(1), siblingIndex: 0, createdAt: 3 }),
      mkMessage({ id: M(4), parentId: M(2), siblingIndex: 0, createdAt: 4 }),
    ]
    let scoreBuilds = 0
    const projection = createMessageTreeProjection(messages, {
      onBuildScores: () => {
        scoreBuilds += 1
      },
    })

    expect(activePathProjected(projection, {}).map((message) => message.id)).toEqual([M(2), M(4)])
    expect(
      activePathProjected(projection, { [ROOT_CURSOR_KEY]: M(1) }).map((message) => message.id),
    ).toEqual([M(1), M(3)])
    expect(resolveActiveLeafIdProjected(projection, {})).toBe(M(4))
    expect(scoreBuilds).toBe(1)
  })

  it('indexes live siblings once while preserving tombstones in the structural buckets', () => {
    const messages = [
      mkMessage({ id: M(1), parentId: null, siblingIndex: 0, createdAt: 1 }),
      mkMessage({ id: M(2), parentId: M(1), siblingIndex: 0, createdAt: 2, deleted: true }),
      mkMessage({ id: M(3), parentId: M(1), siblingIndex: 1, createdAt: 3 }),
    ]
    const projection = createMessageTreeProjection(messages)
    const liveChildren = projection.liveByParent.get(M(1))

    expect(projection.byParent.get(M(1))?.map((message) => message.id)).toEqual([M(2), M(3)])
    expect(liveChildren?.map((message) => message.id)).toEqual([M(3)])
    expect(activePathProjected(projection, {}).map((message) => message.id)).toEqual([M(1), M(3)])
    expect(projection.liveByParent.get(M(1))).toBe(liveChildren)
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
