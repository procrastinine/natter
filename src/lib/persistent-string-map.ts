interface LeafNode<Value> {
  kind: 'leaf'
  key: string
  value: Value
}

interface BranchNode<Value> {
  kind: 'branch'
  bit: number
  zero: TreeNode<Value>
  one: TreeNode<Value>
}

type TreeNode<Value> = LeafNode<Value> | BranchNode<Value>

export class PersistentStringMap<Value> {
  private readonly root: TreeNode<Value> | null
  readonly size: number

  static empty<Value>(): PersistentStringMap<Value> {
    return new PersistentStringMap<Value>(null, 0)
  }

  static from<Value>(entries: Iterable<readonly [string, Value]>): PersistentStringMap<Value> {
    let result = PersistentStringMap.empty<Value>()
    for (const [key, value] of entries) result = result.set(key, value)
    return result
  }

  private constructor(root: TreeNode<Value> | null, size: number) {
    this.root = root
    this.size = size
  }

  get(key: string): Value | undefined {
    const leaf = findLeaf(this.root, key)
    return leaf?.key === key ? leaf.value : undefined
  }

  has(key: string): boolean {
    return findLeaf(this.root, key)?.key === key
  }

  set(key: string, value: Value): PersistentStringMap<Value> {
    if (!this.root) return new PersistentStringMap({ kind: 'leaf', key, value }, 1)
    const leaf = findLeaf(this.root, key) as LeafNode<Value>
    if (leaf.key === key) {
      if (Object.is(leaf.value, value)) return this
      return new PersistentStringMap(replaceLeaf(this.root, key, value), this.size)
    }
    const bit = firstDifferingBit(key, leaf.key)
    const inserted = insertAtBit(this.root, bit, key, value)
    return new PersistentStringMap(inserted, this.size + 1)
  }

  delete(key: string): PersistentStringMap<Value> {
    if (!this.root || findLeaf(this.root, key)?.key !== key) return this
    return new PersistentStringMap(deleteLeaf(this.root, key), this.size - 1)
  }

  *entries(): IterableIterator<[string, Value]> {
    if (!this.root) return
    yield* entriesFrom(this.root)
  }

  *keys(): IterableIterator<string> {
    for (const [key] of this.entries()) yield key
  }

  *values(): IterableIterator<Value> {
    for (const [, value] of this.entries()) yield value
  }

  forEach(
    callback: (value: Value, key: string, map: PersistentStringMap<Value>) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, value] of this.entries()) callback.call(thisArg, value, key, this)
  }

  [Symbol.iterator](): IterableIterator<[string, Value]> {
    return this.entries()
  }
}

function findLeaf<Value>(node: TreeNode<Value> | null, key: string): LeafNode<Value> | null {
  let current = node
  while (current?.kind === 'branch') {
    current = bitAt(key, current.bit) === 0 ? current.zero : current.one
  }
  return current
}

function replaceLeaf<Value>(node: TreeNode<Value>, key: string, value: Value): TreeNode<Value> {
  if (node.kind === 'leaf') return { kind: 'leaf', key, value }
  if (bitAt(key, node.bit) === 0) {
    return { ...node, zero: replaceLeaf(node.zero, key, value) }
  }
  return { ...node, one: replaceLeaf(node.one, key, value) }
}

function insertAtBit<Value>(
  node: TreeNode<Value>,
  bit: number,
  key: string,
  value: Value,
): TreeNode<Value> {
  if (node.kind === 'branch' && node.bit < bit) {
    if (bitAt(key, node.bit) === 0) {
      return { ...node, zero: insertAtBit(node.zero, bit, key, value) }
    }
    return { ...node, one: insertAtBit(node.one, bit, key, value) }
  }
  const leaf: LeafNode<Value> = { kind: 'leaf', key, value }
  return bitAt(key, bit) === 0
    ? { kind: 'branch', bit, zero: leaf, one: node }
    : { kind: 'branch', bit, zero: node, one: leaf }
}

function deleteLeaf<Value>(node: TreeNode<Value>, key: string): TreeNode<Value> | null {
  if (node.kind === 'leaf') return null
  if (bitAt(key, node.bit) === 0) {
    const zero = deleteLeaf(node.zero, key)
    return zero ? { ...node, zero } : node.one
  }
  const one = deleteLeaf(node.one, key)
  return one ? { ...node, one } : node.zero
}

function* entriesFrom<Value>(node: TreeNode<Value>): IterableIterator<[string, Value]> {
  if (node.kind === 'leaf') {
    yield [node.key, node.value]
    return
  }
  yield* entriesFrom(node.zero)
  yield* entriesFrom(node.one)
}

function firstDifferingBit(left: string, right: string): number {
  const limit = Math.max(left.length, right.length) * 17 + 1
  for (let bit = 0; bit < limit; bit += 1) {
    if (bitAt(left, bit) !== bitAt(right, bit)) return bit
  }
  throw new Error('PersistentStringMapDuplicateKey')
}

function bitAt(key: string, bit: number): 0 | 1 {
  const group = Math.floor(bit / 17)
  if (group >= key.length) return 0
  const offset = bit % 17
  if (offset === 0) return 1
  return ((key.charCodeAt(group) >>> (16 - offset)) & 1) as 0 | 1
}
