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

function compareSource(left: BranchTreeSourceNode, right: BranchTreeSourceNode): number {
  return (
    left.siblingIndex - right.siblingIndex ||
    left.createdAt - right.createdAt ||
    left.id.localeCompare(right.id)
  )
}

function breakParentCycles(
  ordered: readonly BranchTreeSourceNode[],
  sourceById: ReadonlyMap<MessageId, BranchTreeSourceNode>,
  effectiveParentById: Map<MessageId, MessageId | null>,
  orphanedIds: Set<MessageId>,
): void {
  const resolved = new Set<MessageId>()
  for (const start of ordered) {
    if (resolved.has(start.id)) continue
    const path: MessageId[] = []
    const indexInPath = new Map<MessageId, number>()
    let currentId: MessageId | null = start.id
    while (currentId !== null && !resolved.has(currentId)) {
      const repeatedAt = indexInPath.get(currentId)
      if (repeatedAt !== undefined) {
        const cycle = path.slice(repeatedAt)
        let breakId = cycle[0] as MessageId
        for (const candidate of cycle.slice(1)) {
          const left = sourceById.get(candidate)
          const right = sourceById.get(breakId)
          if (left && right && compareSource(left, right) < 0) breakId = candidate
        }
        effectiveParentById.set(breakId, null)
        orphanedIds.add(breakId)
        break
      }
      indexInPath.set(currentId, path.length)
      path.push(currentId)
      currentId = effectiveParentById.get(currentId) ?? null
    }
    for (const id of path) resolved.add(id)
  }
}

export function layoutBranchTree(
  source: readonly BranchTreeSourceNode[],
  overrides: Partial<BranchTreeLayoutOptions> = {},
): BranchTreeLayout {
  const options = { ...DEFAULT_OPTIONS, ...overrides }
  const ordered = source.filter((node) => !node.deleted).sort(compareSource)
  if (ordered.length === 0) {
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

  const sourceById = new Map(ordered.map((node) => [node.id, node]))
  const effectiveParentById = new Map<MessageId, MessageId | null>()
  const orphanedIds = new Set<MessageId>()
  for (const node of ordered) {
    if (node.parentId === null) {
      effectiveParentById.set(node.id, null)
      continue
    }
    const parent = sourceById.get(node.parentId)
    if (!parent) {
      effectiveParentById.set(node.id, null)
      orphanedIds.add(node.id)
      continue
    }
    effectiveParentById.set(node.id, parent.id)
  }
  breakParentCycles(ordered, sourceById, effectiveParentById, orphanedIds)

  const childIdsByParent = new Map<MessageId | null, MessageId[]>()
  for (const node of ordered) {
    const parentId = effectiveParentById.get(node.id) ?? null
    const bucket = childIdsByParent.get(parentId)
    if (bucket) bucket.push(node.id)
    else childIdsByParent.set(parentId, [node.id])
  }
  for (const bucket of childIdsByParent.values()) {
    bucket.sort((leftId, rightId) => {
      const left = sourceById.get(leftId) as BranchTreeSourceNode
      const right = sourceById.get(rightId) as BranchTreeSourceNode
      return compareSource(left, right)
    })
  }

  const slotById = new Map<MessageId, number>()
  const depthById = new Map<MessageId, number>()
  let nextLeafSlot = 0
  let maxDepth = 0
  const roots = childIdsByParent.get(null) ?? []
  const stack: Array<{ id: MessageId; depth: number; exiting: boolean }> = []
  for (let index = roots.length - 1; index >= 0; index -= 1) {
    stack.push({ id: roots[index] as MessageId, depth: 0, exiting: false })
  }
  while (stack.length > 0) {
    const entry = stack.pop() as { id: MessageId; depth: number; exiting: boolean }
    const children = childIdsByParent.get(entry.id) ?? []
    if (!entry.exiting) {
      depthById.set(entry.id, entry.depth)
      maxDepth = Math.max(maxDepth, entry.depth)
      stack.push({ ...entry, exiting: true })
      for (let index = children.length - 1; index >= 0; index -= 1) {
        stack.push({ id: children[index] as MessageId, depth: entry.depth + 1, exiting: false })
      }
      continue
    }
    if (children.length === 0) {
      slotById.set(entry.id, nextLeafSlot)
      nextLeafSlot += 1
      continue
    }
    const first = slotById.get(children[0] as MessageId) as number
    const last = slotById.get(children.at(-1) as MessageId) as number
    slotById.set(entry.id, (first + last) / 2)
  }

  const horizontalStride = options.nodeWidth + options.horizontalGap
  const verticalStride = options.nodeHeight + options.verticalGap
  const nodes = ordered.map((node): BranchTreeLayoutNode => {
    const slot = slotById.get(node.id) as number
    const depth = depthById.get(node.id) as number
    return {
      id: node.id,
      source: node,
      parentId: effectiveParentById.get(node.id) ?? null,
      depth,
      x: options.padding + slot * horizontalStride,
      y: options.padding + depth * verticalStride,
      width: options.nodeWidth,
      height: options.nodeHeight,
      orphaned: orphanedIds.has(node.id),
    }
  })
  nodes.sort(
    (left, right) =>
      left.depth - right.depth || left.x - right.x || left.id.localeCompare(right.id),
  )
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const childrenByParent = new Map<MessageId | null, BranchTreeLayoutNode[]>()
  for (const [parentId, childIds] of childIdsByParent) {
    childrenByParent.set(
      parentId,
      childIds.map((id) => byId.get(id) as BranchTreeLayoutNode),
    )
  }
  const rowsByDepth: BranchTreeLayoutNode[][] = []
  for (const node of nodes) {
    const row = rowsByDepth[node.depth]
    if (row) row.push(node)
    else rowsByDepth[node.depth] = [node]
  }
  for (const row of rowsByDepth) row.sort((left, right) => left.x - right.x)

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
