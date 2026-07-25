import { compareLiveLeafRecency, type MessageTreeProjection } from './active-path'
import type { MessageId, MessageRole } from './types'

export interface BranchTreeSourceNode {
  id: MessageId
  parentId: MessageId | null
  siblingIndex: number
  createdAt: number
  role: MessageRole
  deleted: boolean
}

export interface BranchTreeLayoutOptions {
  nodeWidth: number
  nodeHeight: number
  horizontalGap: number
  verticalGap: number
  padding: number
}

export interface BranchTreeLayoutNode {
  id: MessageId
  newestLeafId: MessageId
  source: BranchTreeSourceNode
  parentId: MessageId | null
  depth: number
  x: number
  y: number
  width: number
  height: number
  orphaned: boolean
}

export interface BranchTreeLayout {
  nodes: BranchTreeLayoutNode[]
  byId: Map<MessageId, BranchTreeLayoutNode>
  childrenByParent: Map<MessageId | null, BranchTreeLayoutNode[]>
  rowsByDepth: BranchTreeLayoutNode[][]
  width: number
  height: number
  maxDepth: number
}

const DEFAULT_OPTIONS: BranchTreeLayoutOptions = {
  nodeWidth: 28,
  nodeHeight: 28,
  horizontalGap: 28,
  verticalGap: 58,
  padding: 48,
}

export function layoutBranchTree(
  topology: MessageTreeProjection<BranchTreeSourceNode>,
  overrides: Partial<BranchTreeLayoutOptions> = {},
): BranchTreeLayout {
  const options = { ...DEFAULT_OPTIONS, ...overrides }
  const liveNodeCount = topology.nodes.reduce((count, node) => count + (node.deleted ? 0 : 1), 0)
  if (liveNodeCount === 0) {
    return {
      nodes: [],
      byId: new Map(),
      childrenByParent: new Map(),
      rowsByDepth: [],
      width: options.padding * 2,
      height: options.padding * 2,
      maxDepth: 0,
    }
  }

  const slotById = new Map<MessageId, number>()
  const newestLeafById = new Map<MessageId, MessageId>()
  const depthById = new Map<MessageId, number>()
  const traversalOrder: BranchTreeSourceNode[] = []
  const visited = new Set<MessageId>()
  let nextLeafSlot = 0
  let maxDepth = 0
  const roots = topology.liveByParent.get(null) ?? []
  const stack: Array<{ id: MessageId; depth: number; exiting: boolean }> = []
  for (let index = roots.length - 1; index >= 0; index -= 1) {
    stack.push({ id: (roots[index] as BranchTreeSourceNode).id, depth: 0, exiting: false })
  }
  while (stack.length > 0) {
    const entry = stack.pop() as { id: MessageId; depth: number; exiting: boolean }
    const source = topology.byId.get(entry.id)
    if (!source || source.deleted) throw new Error(`BranchTreeTopologyNodeMissing:${entry.id}`)
    const children = topology.liveByParent.get(entry.id) ?? []
    if (!entry.exiting) {
      if (visited.has(entry.id)) throw new Error(`BranchTreeTopologyCycle:${entry.id}`)
      visited.add(entry.id)
      traversalOrder.push(source)
      depthById.set(entry.id, entry.depth)
      maxDepth = Math.max(maxDepth, entry.depth)
      stack.push({ ...entry, exiting: true })
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const child = children[index] as BranchTreeSourceNode
        if (child.parentId !== entry.id) {
          throw new Error(`BranchTreeTopologyParentMismatch:${child.id}`)
        }
        stack.push({ id: child.id, depth: entry.depth + 1, exiting: false })
      }
      continue
    }
    if (children.length === 0) {
      slotById.set(entry.id, nextLeafSlot)
      newestLeafById.set(entry.id, entry.id)
      nextLeafSlot += 1
      continue
    }
    const first = slotById.get((children[0] as BranchTreeSourceNode).id) as number
    const last = slotById.get((children.at(-1) as BranchTreeSourceNode).id) as number
    slotById.set(entry.id, (first + last) / 2)
    let newestLeafId = newestLeafById.get((children[0] as BranchTreeSourceNode).id) as MessageId
    for (let index = 1; index < children.length; index += 1) {
      const candidateId = newestLeafById.get((children[index] as BranchTreeSourceNode).id)
      if (!candidateId) throw new Error(`BranchTreeLeafMissing:${children[index]?.id}`)
      const candidate = topology.byId.get(candidateId) as BranchTreeSourceNode
      const newest = topology.byId.get(newestLeafId) as BranchTreeSourceNode
      if (compareLiveLeafRecency(candidate, newest) > 0) {
        newestLeafId = candidateId
      }
    }
    newestLeafById.set(entry.id, newestLeafId)
  }
  if (visited.size !== liveNodeCount) {
    const unreachable = topology.nodes.find((node) => !node.deleted && !visited.has(node.id))
    throw new Error(`BranchTreeTopologyUnreachable:${unreachable?.id ?? 'unknown'}`)
  }

  const horizontalStride = options.nodeWidth + options.horizontalGap
  const verticalStride = options.nodeHeight + options.verticalGap
  const nodesByTraversal = traversalOrder.map((node): BranchTreeLayoutNode => {
    const slot = slotById.get(node.id) as number
    const depth = depthById.get(node.id) as number
    return {
      id: node.id,
      newestLeafId: newestLeafById.get(node.id) as MessageId,
      source: node,
      parentId: node.parentId,
      depth,
      x: options.padding + slot * horizontalStride,
      y: options.padding + depth * verticalStride,
      width: options.nodeWidth,
      height: options.nodeHeight,
      orphaned: false,
    }
  })
  const byId = new Map(nodesByTraversal.map((node) => [node.id, node]))
  const childrenByParent = new Map<MessageId | null, BranchTreeLayoutNode[]>()
  for (const [parentId, children] of topology.liveByParent) {
    childrenByParent.set(
      parentId,
      children.map((child) => byId.get(child.id) as BranchTreeLayoutNode),
    )
  }
  const rowsByDepth: BranchTreeLayoutNode[][] = []
  for (const node of nodesByTraversal) {
    const row = rowsByDepth[node.depth]
    if (row) row.push(node)
    else rowsByDepth[node.depth] = [node]
  }
  const nodes = rowsByDepth.flat()

  return {
    nodes,
    byId,
    childrenByParent,
    rowsByDepth,
    width:
      options.padding * 2 + Math.max(0, nextLeafSlot - 1) * horizontalStride + options.nodeWidth,
    height: options.padding * 2 + maxDepth * verticalStride + options.nodeHeight,
    maxDepth,
  }
}
