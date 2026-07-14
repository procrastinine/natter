import type { CursorMap, CursorPatch, MessageId } from '../../core/types'

interface CursorNode {
  readonly key: string
  readonly value: MessageId
  readonly left: CursorNode | null
  readonly right: CursorNode | null
  readonly height: number
  readonly size: number
}

const roots = new WeakMap<object, CursorNode | null>()
let enumerationProbe: ((entryCount: number) => void) | undefined

interface PersistentCursorPatchMeasurement {
  nodeVisits: number
}

function height(node: CursorNode | null): number {
  return node?.height ?? 0
}

function size(node: CursorNode | null): number {
  return node?.size ?? 0
}

function makeNode(
  key: string,
  value: MessageId,
  left: CursorNode | null,
  right: CursorNode | null,
): CursorNode {
  return {
    key,
    value,
    left,
    right,
    height: Math.max(height(left), height(right)) + 1,
    size: size(left) + size(right) + 1,
  }
}

function rotateLeft(node: CursorNode): CursorNode {
  const right = node.right as CursorNode
  const moved = makeNode(node.key, node.value, node.left, right.left)
  return makeNode(right.key, right.value, moved, right.right)
}

function rotateRight(node: CursorNode): CursorNode {
  const left = node.left as CursorNode
  const moved = makeNode(node.key, node.value, left.right, node.right)
  return makeNode(left.key, left.value, left.left, moved)
}

function balance(node: CursorNode): CursorNode {
  const tilt = height(node.left) - height(node.right)
  if (tilt > 1) {
    const left = node.left as CursorNode
    const prepared =
      height(left.left) < height(left.right)
        ? makeNode(node.key, node.value, rotateLeft(left), node.right)
        : node
    return rotateRight(prepared)
  }
  if (tilt < -1) {
    const right = node.right as CursorNode
    const prepared =
      height(right.right) < height(right.left)
        ? makeNode(node.key, node.value, node.left, rotateRight(right))
        : node
    return rotateLeft(prepared)
  }
  return node
}

function find(node: CursorNode | null, key: string): MessageId | undefined {
  let current = node
  while (current) {
    if (key === current.key) return current.value
    current = key < current.key ? current.left : current.right
  }
  return undefined
}

function setNode(
  node: CursorNode | null,
  key: string,
  value: MessageId,
  measurement?: PersistentCursorPatchMeasurement,
): CursorNode {
  if (measurement) measurement.nodeVisits += 1
  if (!node) return makeNode(key, value, null, null)
  if (key === node.key) {
    return node.value === value ? node : makeNode(key, value, node.left, node.right)
  }
  if (key < node.key) {
    const left = setNode(node.left, key, value, measurement)
    return left === node.left ? node : balance(makeNode(node.key, node.value, left, node.right))
  }
  const right = setNode(node.right, key, value, measurement)
  return right === node.right ? node : balance(makeNode(node.key, node.value, node.left, right))
}

function smallest(node: CursorNode, measurement?: PersistentCursorPatchMeasurement): CursorNode {
  let current = node
  for (;;) {
    if (measurement) measurement.nodeVisits += 1
    if (!current.left) return current
    current = current.left
  }
}

function deleteNode(
  node: CursorNode | null,
  key: string,
  measurement?: PersistentCursorPatchMeasurement,
): CursorNode | null {
  if (measurement) measurement.nodeVisits += 1
  if (!node) return node
  if (key < node.key) {
    const left = deleteNode(node.left, key, measurement)
    return left === node.left ? node : balance(makeNode(node.key, node.value, left, node.right))
  }
  if (key > node.key) {
    const right = deleteNode(node.right, key, measurement)
    return right === node.right ? node : balance(makeNode(node.key, node.value, node.left, right))
  }
  if (!node.left) return node.right
  if (!node.right) return node.left
  const successor = smallest(node.right, measurement)
  return balance(
    makeNode(
      successor.key,
      successor.value,
      node.left,
      deleteNode(node.right, successor.key, measurement),
    ),
  )
}

function visitKeys(node: CursorNode | null, keys: string[]): void {
  if (!node) return
  visitKeys(node.left, keys)
  keys.push(node.key)
  visitKeys(node.right, keys)
}

function rootOf(cursor: Readonly<CursorMap>): CursorNode | null | undefined {
  return roots.get(cursor)
}

function cursorView(root: CursorNode | null): Readonly<CursorMap> {
  const target = Object.create(null) as CursorMap
  const view = new Proxy(target, {
    get: (_target, property) => (typeof property === 'string' ? find(root, property) : undefined),
    has: (_target, property) => typeof property === 'string' && find(root, property) !== undefined,
    ownKeys: () => {
      enumerationProbe?.(size(root))
      const keys: string[] = []
      visitKeys(root, keys)
      return keys
    },
    getOwnPropertyDescriptor: (_target, property) => {
      if (typeof property !== 'string') return undefined
      const value = find(root, property)
      return value === undefined
        ? undefined
        : { configurable: true, enumerable: true, value, writable: false }
    },
    set: () => false,
    deleteProperty: () => false,
    defineProperty: () => false,
    setPrototypeOf: () => false,
    preventExtensions: () => false,
  })
  roots.set(view, root)
  return view
}

const EMPTY_CURSOR = cursorView(null)

export function toPersistentCursor(cursor: Readonly<CursorMap>): Readonly<CursorMap> {
  if (rootOf(cursor) !== undefined) return cursor
  let root: CursorNode | null = null
  for (const [key, value] of Object.entries(cursor)) root = setNode(root, key, value)
  return root ? cursorView(root) : EMPTY_CURSOR
}

export function patchPersistentCursor(
  cursor: Readonly<CursorMap>,
  patch: Readonly<CursorPatch>,
  measurement?: PersistentCursorPatchMeasurement,
): Readonly<CursorMap> {
  const owned = toPersistentCursor(cursor)
  let root = rootOf(owned) as CursorNode | null
  for (const [key, value] of Object.entries(patch)) {
    root =
      value === undefined
        ? deleteNode(root, key, measurement)
        : setNode(root, key, value, measurement)
  }
  return root === rootOf(owned) ? owned : root ? cursorView(root) : EMPTY_CURSOR
}

export function persistentCursorSize(cursor: Readonly<CursorMap>): number {
  const root = rootOf(cursor)
  return root === undefined ? Object.keys(cursor).length : size(root)
}

export function isPersistentCursor(cursor: Readonly<CursorMap>): boolean {
  return rootOf(cursor) !== undefined
}

export function persistentCursorTreeStats(cursor: Readonly<CursorMap>): {
  size: number
  height: number
} {
  const root = rootOf(toPersistentCursor(cursor)) as CursorNode | null
  return { size: size(root), height: height(root) }
}

export function __setPersistentCursorEnumerationProbeForTests(
  probe: ((entryCount: number) => void) | undefined,
): void {
  if (import.meta.env.MODE === 'test') enumerationProbe = probe
}
