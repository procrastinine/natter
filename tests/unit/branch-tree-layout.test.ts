import { describe, expect, it } from 'vitest'
import { type BranchTreeSourceNode, layoutBranchTree } from '../../src/core/branch-tree-layout'
import { createMessageTopologyIndex } from '../../src/core/message-topology'

function topology(rows: readonly BranchTreeSourceNode[]) {
  return createMessageTopologyIndex(rows, {
    sameStructure: (left, right) =>
      left.id === right.id &&
      left.parentId === right.parentId &&
      left.siblingIndex === right.siblingIndex &&
      left.deleted === right.deleted,
  })
}

function node(
  id: string,
  parentId: string | null,
  siblingIndex: number,
  overrides: Partial<BranchTreeSourceNode> = {},
): BranchTreeSourceNode {
  return {
    id,
    parentId,
    siblingIndex,
    createdAt: siblingIndex,
    role: 'assistant',
    deleted: false,
    ...overrides,
  }
}

function measuredWideLayout(size: number): { reads: number; nodes: number } {
  let reads = 0
  const tracked = (
    id: string,
    parentId: string | null,
    siblingIndex: number,
  ): BranchTreeSourceNode => {
    const values: BranchTreeSourceNode = {
      id,
      parentId,
      siblingIndex,
      createdAt: siblingIndex,
      role: 'assistant',
      deleted: false,
    }
    const row = {} as BranchTreeSourceNode
    for (const key of Object.keys(values) as Array<keyof BranchTreeSourceNode>) {
      Object.defineProperty(row, key, {
        enumerable: true,
        get: () => {
          reads += 1
          return values[key]
        },
      })
    }
    return row
  }
  const rows = [tracked('root', null, 0)]
  for (let index = 0; index < size; index += 1) {
    rows.push(tracked(`child-${index}`, 'root', (index * 4_829) % size))
  }
  const layout = layoutBranchTree(topology(rows))
  return { reads, nodes: layout.nodes.length }
}

describe('layoutBranchTree', () => {
  it('lays parents above children, siblings left-to-right, and centers a parent over its span', () => {
    const layout = layoutBranchTree(
      topology([
        node('root', null, 0),
        node('right', 'root', 1),
        node('left', 'root', 0),
        node('left-leaf', 'left', 0),
        node('right-leaf', 'right', 0),
      ]),
    )
    const root = layout.byId.get('root')
    const left = layout.byId.get('left')
    const right = layout.byId.get('right')
    expect(root).toBeDefined()
    expect(left).toBeDefined()
    expect(right).toBeDefined()
    expect((root?.y ?? 0) < (left?.y ?? 0)).toBe(true)
    expect((left?.x ?? 0) < (right?.x ?? 0)).toBe(true)
    expect(root?.x).toBe(((left?.x ?? 0) + (right?.x ?? 0)) / 2)
  })

  it('rejects a live node whose structural parent is deleted', () => {
    const projection = topology([
      node('deleted', null, 0, { deleted: true }),
      node('orphan', 'deleted', 0, { role: 'user' }),
    ])
    expect(() => layoutBranchTree(projection)).toThrow('BranchTreeTopologyUnreachable:orphan')
  })

  it('rejects malformed cycles instead of repairing topology in the layout layer', () => {
    const projection = topology([node('b', 'a', 1), node('a', 'b', 0), node('tail', 'b', 0)])
    expect(() => layoutBranchTree(projection)).toThrow('BranchTreeTopologyUnreachable:a')
  })

  it('uses iterative traversal for very deep conversations', () => {
    const rows: BranchTreeSourceNode[] = []
    for (let index = 0; index < 20_000; index += 1) {
      rows.push(node(`n${index}`, index === 0 ? null : `n${index - 1}`, 0))
    }
    const layout = layoutBranchTree(topology(rows))
    expect(layout.nodes).toHaveLength(20_000)
    expect(layout.maxDepth).toBe(19_999)
  })

  it('scales wide-fork work near linearly rather than quadratically', () => {
    const smaller = measuredWideLayout(2_048)
    const larger = measuredWideLayout(4_096)
    expect(smaller.nodes).toBe(2_049)
    expect(larger.nodes).toBe(4_097)
    expect(larger.reads).toBeLessThan(smaller.reads * 2.7)
  })
})
