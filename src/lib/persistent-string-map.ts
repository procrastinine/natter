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

interface SearchStep<Value> {
  readonly branch: BranchNode<Value>
  readonly direction: 0 | 1
}

export interface PersistentStringMapMeasurement {
  nodeVisits: number
}

export class PersistentStringMap<Value> {
  private readonly root: TreeNode<Value> | null
  readonly size: number

  static empty<Value>(): PersistentStringMap<Value> {
    return new PersistentStringMap<Value>(null, 0)
  }

  static singleton<Value>(key: string, value: Value): PersistentStringMap<Value> {
    return new PersistentStringMap<Value>({ kind: 'leaf', key, value }, 1)
  }

  static from<Value>(entries: Iterable<readonly [string, Value]>): PersistentStringMap<Value> {
    const valuesByKey = new Map<string, Value>()
    for (const [key, value] of entries) valuesByKey.set(key, value)
    if (valuesByKey.size === 0) return PersistentStringMap.empty<Value>()
    if (valuesByKey.size === 1) {
      const [key, value] = valuesByKey.entries().next().value as [string, Value]
      return PersistentStringMap.singleton(key, value)
    }
    const sorted = [...valuesByKey].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    )
    return new PersistentStringMap(
      buildTreeFromSortedEntries(sorted, 0, sorted.length),
      sorted.length,
    )
  }

  private constructor(root: TreeNode<Value> | null, size: number) {
    this.root = root
    this.size = size
  }

  get(key: string, measurement?: PersistentStringMapMeasurement): Value | undefined {
    const leaf = findLeaf(this.root, key, measurement)
    return leaf?.key === key ? leaf.value : undefined
  }

  has(key: string): boolean {
    return findLeaf(this.root, key)?.key === key
  }

  set(
    key: string,
    value: Value,
    measurement?: PersistentStringMapMeasurement,
  ): PersistentStringMap<Value> {
    if (!this.root) return new PersistentStringMap({ kind: 'leaf', key, value }, 1)
    const { leaf, path } = traceLeaf(this.root, key, measurement)
    if (leaf.key === key) {
      if (Object.is(leaf.value, value)) return this
      return new PersistentStringMap(
        rebuildPath(path, path.length, { kind: 'leaf', key, value }),
        this.size,
      )
    }
    const bit = firstDifferingBit(key, leaf.key)
    let insertionDepth = 0
    while (
      insertionDepth < path.length &&
      (path[insertionDepth] as SearchStep<Value>).branch.bit < bit
    ) {
      insertionDepth += 1
    }
    const existing: TreeNode<Value> =
      insertionDepth === path.length ? leaf : (path[insertionDepth] as SearchStep<Value>).branch
    const insertedLeaf: LeafNode<Value> = { kind: 'leaf', key, value }
    const inserted: BranchNode<Value> =
      bitAt(key, bit) === 0
        ? { kind: 'branch', bit, zero: insertedLeaf, one: existing }
        : { kind: 'branch', bit, zero: existing, one: insertedLeaf }
    return new PersistentStringMap(rebuildPath(path, insertionDepth, inserted), this.size + 1)
  }

  delete(key: string, measurement?: PersistentStringMapMeasurement): PersistentStringMap<Value> {
    if (!this.root) return this
    const { leaf, path } = traceLeaf(this.root, key, measurement)
    if (leaf.key !== key) return this
    if (path.length === 0) return PersistentStringMap.empty<Value>()
    const parent = path[path.length - 1] as SearchStep<Value>
    const sibling = parent.direction === 0 ? parent.branch.one : parent.branch.zero
    return new PersistentStringMap(rebuildPath(path, path.length - 1, sibling), this.size - 1)
  }

  maxDepth(): number {
    return treeDepth(this.root)
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

function findLeaf<Value>(
  node: TreeNode<Value> | null,
  key: string,
  measurement?: PersistentStringMapMeasurement,
): LeafNode<Value> | null {
  let current = node
  while (current?.kind === 'branch') {
    if (measurement) measurement.nodeVisits += 1
    current = bitAt(key, current.bit) === 0 ? current.zero : current.one
  }
  if (current && measurement) measurement.nodeVisits += 1
  return current
}

function traceLeaf<Value>(
  root: TreeNode<Value>,
  key: string,
  measurement?: PersistentStringMapMeasurement,
): { leaf: LeafNode<Value>; path: SearchStep<Value>[] } {
  const path: SearchStep<Value>[] = []
  let current = root
  while (current.kind === 'branch') {
    if (measurement) measurement.nodeVisits += 1
    const direction = bitAt(key, current.bit)
    path.push({ branch: current, direction })
    current = direction === 0 ? current.zero : current.one
  }
  if (measurement) measurement.nodeVisits += 1
  return { leaf: current, path }
}

function rebuildPath<Value>(
  path: readonly SearchStep<Value>[],
  ancestorCount: number,
  replacement: TreeNode<Value>,
): TreeNode<Value> {
  let current = replacement
  for (let index = ancestorCount - 1; index >= 0; index -= 1) {
    const step = path[index] as SearchStep<Value>
    current =
      step.direction === 0 ? { ...step.branch, zero: current } : { ...step.branch, one: current }
  }
  return current
}

function treeDepth<Value>(node: TreeNode<Value> | null): number {
  if (!node) return 0
  if (node.kind === 'leaf') return 1
  return Math.max(treeDepth(node.zero), treeDepth(node.one)) + 1
}

function buildTreeFromSortedEntries<Value>(
  entries: readonly (readonly [string, Value])[],
  start: number,
  end: number,
): TreeNode<Value> {
  if (end - start === 1) {
    const [key, value] = entries[start] as readonly [string, Value]
    return { kind: 'leaf', key, value }
  }
  const first = entries[start] as readonly [string, Value]
  const last = entries[end - 1] as readonly [string, Value]
  const bit = firstDifferingBit(first[0], last[0])
  let low = start + 1
  let high = end
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2)
    const entry = entries[middle] as readonly [string, Value]
    if (bitAt(entry[0], bit) === 0) low = middle + 1
    else high = middle
  }
  return {
    kind: 'branch',
    bit,
    zero: buildTreeFromSortedEntries(entries, start, low),
    one: buildTreeFromSortedEntries(entries, low, end),
  }
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
