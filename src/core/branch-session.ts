import { PersistentStringMap } from '../lib/persistent-string-map'
import type { MessageTreeNode } from './active-path'
import type { ChatId, MessageId } from './types'

export type LiveBranchPathReadResult<T extends MessageTreeNode> =
  | { readonly kind: 'ready'; readonly rows: readonly T[] }
  | {
      readonly kind: 'unavailable'
      readonly reason: 'missing' | 'wrong-chat' | 'deleted' | 'cycle'
      readonly messageId: MessageId
    }

export async function readLiveBranchPath<
  T extends MessageTreeNode & { readonly chatId: ChatId },
>(input: {
  readonly chatId: ChatId
  readonly leafId: MessageId | null
  readonly getHeader: (messageId: MessageId) => Promise<T | undefined>
  readonly signal?: AbortSignal
}): Promise<LiveBranchPathReadResult<T>> {
  if (input.leafId === null) return { kind: 'ready', rows: Object.freeze([]) }
  const reversed: T[] = []
  const seen = new Set<MessageId>()
  let messageId: MessageId | null = input.leafId
  while (messageId !== null) {
    if (input.signal?.aborted) {
      throw new DOMException('Live branch path read aborted', 'AbortError')
    }
    if (seen.has(messageId)) return { kind: 'unavailable', reason: 'cycle', messageId }
    seen.add(messageId)
    const header = await input.getHeader(messageId)
    if (!header) return { kind: 'unavailable', reason: 'missing', messageId }
    if (header.chatId !== input.chatId) {
      return { kind: 'unavailable', reason: 'wrong-chat', messageId }
    }
    if (header.deleted) return { kind: 'unavailable', reason: 'deleted', messageId }
    reversed.push(header)
    messageId = header.parentId
  }
  reversed.reverse()
  return { kind: 'ready', rows: Object.freeze(reversed) }
}

export interface BranchPathSpan {
  readonly branchLength: number
  readonly offset: number
  readonly limit: number
  readonly boundaryParentId: MessageId | null
}

export interface BranchPathWindow<T extends MessageTreeNode> extends BranchPathSpan {
  readonly nodes: readonly T[]
}

export interface BranchPathTraversalMeasurement {
  predecessorLinks: number
}

export interface BranchPathDivergence extends BranchPathSpan {
  readonly commonPrefixLength: number
}

export interface BranchPathDescriptor<T extends MessageTreeNode = MessageTreeNode> {
  readonly identity: object
  readonly length: number
  readonly leaf: T | null
  readonly messageIds: ReadonlySet<MessageId>
  has(messageId: MessageId): boolean
  get(messageId: MessageId): T | undefined
  childOf(parentId: MessageId | null): T | undefined
  indexOf(messageId: MessageId): number
  truncate(parentId: MessageId | null): BranchPathDescriptor<T>
  append(node: T): BranchPathDescriptor<T>
  replace(node: T): BranchPathDescriptor<T>
  replaceMany(nodes: readonly T[]): BranchPathDescriptor<T>
  sameIdentity(other: BranchPathDescriptor<T>): boolean
  sharesNodeValuesThrough(other: BranchPathDescriptor<T>, length: number): boolean
  extensionOffset(previous: BranchPathDescriptor<T>): number | null
  divergenceFrom(previous: BranchPathDescriptor<T>): BranchPathDivergence
  window(
    page: { offset: number; limit: number },
    measurement?: BranchPathTraversalMeasurement,
  ): BranchPathWindow<T>
  backwardWindow(
    page: { endingAt: MessageId; limit: number },
    measurement?: BranchPathTraversalMeasurement,
  ): BranchPathWindow<T>
  tailSpanWhile(include: (node: T, selectedCount: number) => boolean): BranchPathSpan
  materializeNodes(): readonly T[]
  materializeIds(): readonly MessageId[]
}

class PathMessageIdSet implements ReadonlySet<MessageId> {
  private readonly nodes: PersistentVector<MessageTreeNode>
  private readonly indexById: PersistentStringMap<number>

  constructor(nodes: PersistentVector<MessageTreeNode>, indexById: PersistentStringMap<number>) {
    this.nodes = nodes
    this.indexById = indexById
  }

  get size(): number {
    return this.nodes.length
  }

  has(messageId: MessageId): boolean {
    return this.indexById.has(messageId)
  }

  *values(): SetIterator<MessageId> {
    for (let index = 0; index < this.nodes.length; index += 1) {
      yield (this.nodes.get(index) as MessageTreeNode).id
    }
  }

  keys(): SetIterator<MessageId> {
    return this.values()
  }

  *entries(): SetIterator<[MessageId, MessageId]> {
    for (const messageId of this.values()) yield [messageId, messageId]
  }

  forEach(
    callback: (value: MessageId, value2: MessageId, set: ReadonlySet<MessageId>) => void,
    thisArg?: unknown,
  ): void {
    for (const messageId of this.values()) callback.call(thisArg, messageId, messageId, this)
  }

  [Symbol.iterator](): SetIterator<MessageId> {
    return this.values()
  }
}

const VECTOR_BITS = 5
const VECTOR_WIDTH = 2 ** VECTOR_BITS

type PersistentVectorNode<T> = readonly (PersistentVectorNode<T> | T | undefined)[]

class PersistentVector<T> {
  readonly length: number
  private materialized: readonly T[] | null
  private readonly root: PersistentVectorNode<T>
  private readonly shift: number
  private readonly tail: readonly T[]

  private constructor(input: {
    readonly length: number
    readonly root: PersistentVectorNode<T>
    readonly shift: number
    readonly tail: readonly T[]
    readonly materialized?: readonly T[] | null
  }) {
    this.length = input.length
    this.root = input.root
    this.shift = input.shift
    this.tail = input.tail
    this.materialized = input.materialized ?? null
  }

  static empty<T>(): PersistentVector<T> {
    return new PersistentVector({
      length: 0,
      root: Object.freeze([]),
      shift: VECTOR_BITS,
      tail: Object.freeze([]),
      materialized: Object.freeze([]),
    })
  }

  static from<T>(values: readonly T[]): PersistentVector<T> {
    let vector = PersistentVector.empty<T>()
    for (const value of values) vector = vector.append(value)
    vector.materialized = values
    return vector
  }

  get(index: number): T | undefined {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.length) return undefined
    const tailOffset = this.tailOffset()
    if (index >= tailOffset) return this.tail[index - tailOffset]
    let node = this.root
    for (let level = this.shift; level > 0; level -= VECTOR_BITS) {
      const slot = Math.floor(index / 2 ** level) % VECTOR_WIDTH
      const child = node[slot]
      if (!Array.isArray(child)) return undefined
      node = child as PersistentVectorNode<T>
    }
    return node[index % VECTOR_WIDTH] as T | undefined
  }

  append(value: T): PersistentVector<T> {
    if (this.tail.length < VECTOR_WIDTH) {
      return new PersistentVector({
        length: this.length + 1,
        root: this.root,
        shift: this.shift,
        tail: Object.freeze([...this.tail, value]),
      })
    }
    const tailNode = this.tail as PersistentVectorNode<T>
    let root: PersistentVectorNode<T>
    let shift = this.shift
    if (Math.floor(this.length / VECTOR_WIDTH) > 2 ** this.shift) {
      root = frozenVectorNode([this.root, vectorPath(this.shift, tailNode)])
      shift += VECTOR_BITS
    } else {
      root = pushVectorTail(this.shift, this.root, tailNode, this.length)
    }
    return new PersistentVector({
      length: this.length + 1,
      root,
      shift,
      tail: Object.freeze([value]),
    })
  }

  take(length: number): PersistentVector<T> {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.length) {
      throw new Error('PersistentVectorLengthInvalid')
    }
    if (length === this.length) return this
    if (length === 0) return PersistentVector.empty()
    const tailOffset = Math.floor((length - 1) / VECTOR_WIDTH) * VECTOR_WIDTH
    const tail = Object.freeze(
      Array.from({ length: length - tailOffset }, (_, index) => this.get(tailOffset + index) as T),
    )
    let shift = this.shift
    let root =
      tailOffset === 0
        ? (Object.freeze([]) as PersistentVectorNode<T>)
        : takeVectorBlocks(this.root, this.shift, tailOffset / VECTOR_WIDTH)
    while (shift > VECTOR_BITS && root.length === 1 && Array.isArray(root[0])) {
      root = root[0] as PersistentVectorNode<T>
      shift -= VECTOR_BITS
    }
    return new PersistentVector({ length, root, shift, tail })
  }

  toArray(): readonly T[] {
    this.materialized ??= Object.freeze(
      Array.from({ length: this.length }, (_, index) => this.get(index) as T),
    )
    return this.materialized
  }

  private tailOffset(): number {
    return this.length < VECTOR_WIDTH
      ? 0
      : Math.floor((this.length - 1) / VECTOR_WIDTH) * VECTOR_WIDTH
  }
}

function frozenVectorNode<T>(values: readonly (PersistentVectorNode<T> | T | undefined)[]) {
  return Object.freeze([...values]) as PersistentVectorNode<T>
}

function vectorPath<T>(level: number, node: PersistentVectorNode<T>): PersistentVectorNode<T> {
  return level === 0 ? node : frozenVectorNode([vectorPath(level - VECTOR_BITS, node)])
}

function pushVectorTail<T>(
  level: number,
  parent: PersistentVectorNode<T>,
  tail: PersistentVectorNode<T>,
  length: number,
): PersistentVectorNode<T> {
  const slot = Math.floor((length - 1) / 2 ** level) % VECTOR_WIDTH
  const next = [...parent]
  if (level === VECTOR_BITS) {
    next[slot] = tail
  } else {
    const child = parent[slot]
    next[slot] = Array.isArray(child)
      ? pushVectorTail(level - VECTOR_BITS, child as PersistentVectorNode<T>, tail, length)
      : vectorPath(level - VECTOR_BITS, tail)
  }
  return frozenVectorNode(next)
}

function takeVectorBlocks<T>(
  node: PersistentVectorNode<T>,
  level: number,
  blockCount: number,
): PersistentVectorNode<T> {
  if (blockCount <= 0) return Object.freeze([])
  if (level === VECTOR_BITS) return frozenVectorNode(node.slice(0, blockCount))
  const childCapacity = 2 ** (level - VECTOR_BITS)
  const fullChildren = Math.floor(blockCount / childCapacity)
  const remainder = blockCount % childCapacity
  const next = node.slice(0, fullChildren)
  if (remainder > 0) {
    const child = node[fullChildren]
    if (!Array.isArray(child)) throw new Error('PersistentVectorStructureInvalid')
    next.push(takeVectorBlocks(child as PersistentVectorNode<T>, level - VECTOR_BITS, remainder))
  }
  return frozenVectorNode(next)
}

interface BranchPathIdentity {
  readonly length: number
  readonly previous: BranchPathIdentity | null
}

interface BranchPathBase<T extends MessageTreeNode> {
  readonly identity: BranchPathIdentity
  readonly nodes: PersistentVector<T>
  readonly indexById: PersistentStringMap<number>
  readonly messageIds: ReadonlySet<MessageId>
}

class IndexedBranchPath<T extends MessageTreeNode> implements BranchPathDescriptor<T> {
  readonly identity: object
  readonly length: number
  readonly messageIds: ReadonlySet<MessageId>
  private materializedIds: readonly MessageId[] | null = null
  private materializedNodes: readonly T[] | null = null
  private readonly base: BranchPathBase<T>
  private readonly replacements: PersistentStringMap<T>

  constructor(
    base: BranchPathBase<T>,
    replacements: PersistentStringMap<T> = PersistentStringMap.empty(),
  ) {
    this.base = base
    this.identity = base.identity
    this.length = base.nodes.length
    this.messageIds = base.messageIds
    this.replacements = replacements
  }

  get leaf(): T | null {
    return this.effectiveAt(this.length - 1) ?? null
  }

  has(messageId: MessageId): boolean {
    return this.base.indexById.has(messageId)
  }

  get(messageId: MessageId): T | undefined {
    const index = this.base.indexById.get(messageId)
    return index === undefined ? undefined : this.effectiveAt(index)
  }

  childOf(parentId: MessageId | null): T | undefined {
    const index = parentId === null ? 0 : (this.base.indexById.get(parentId) ?? -2) + 1
    return this.effectiveAt(index)
  }

  indexOf(messageId: MessageId): number {
    return this.base.indexById.get(messageId) ?? -1
  }

  truncate(parentId: MessageId | null): BranchPathDescriptor<T> {
    if (parentId === null) return emptyBranchPath()
    const index = this.base.indexById.get(parentId)
    if (index === undefined) return emptyBranchPath()
    if (index === this.length - 1) return this
    const length = index + 1
    const nodes = this.base.nodes.take(length)
    let indexById = this.base.indexById
    let replacements = this.replacements
    for (let removedIndex = length; removedIndex < this.length; removedIndex += 1) {
      const messageId = (this.base.nodes.get(removedIndex) as T).id
      indexById = indexById.delete(messageId)
      replacements = replacements.delete(messageId)
    }
    return new IndexedBranchPath(
      {
        identity:
          pathIdentityAtLength(this.base.identity, length) ?? createPathIdentity(length, null),
        nodes,
        indexById,
        messageIds: new PathMessageIdSet(nodes, indexById),
      },
      replacements,
    )
  }

  append(node: T): BranchPathDescriptor<T> {
    if (node.parentId !== (this.leaf?.id ?? null)) throw new Error('BranchPathNonContiguous')
    if (this.base.indexById.has(node.id)) throw new Error('BranchPathDuplicateMessage')
    const nodes = this.base.nodes.append(node)
    const indexById = this.base.indexById.set(node.id, this.length)
    return new IndexedBranchPath(
      {
        identity: createPathIdentity(nodes.length, this.base.identity),
        nodes,
        indexById,
        messageIds: new PathMessageIdSet(nodes, indexById),
      },
      this.replacements,
    )
  }

  replace(node: T): BranchPathDescriptor<T> {
    return this.replaceMany([node])
  }

  replaceMany(nodes: readonly T[]): BranchPathDescriptor<T> {
    let replacements = this.replacements
    for (const node of nodes) {
      const index = this.base.indexById.get(node.id)
      if (index === undefined) throw new Error(`BranchPathMessageMissing:${node.id}`)
      const base = this.base.nodes.get(index) as T
      const current = replacements.get(node.id) ?? base
      if (node.parentId !== current.parentId) {
        throw new Error(`BranchPathIdentityChanged:${node.id}`)
      }
      if (node === current) continue
      replacements = node === base ? replacements.delete(node.id) : replacements.set(node.id, node)
    }
    return replacements === this.replacements
      ? this
      : new IndexedBranchPath(this.base, replacements)
  }

  sameIdentity(other: BranchPathDescriptor<T>): boolean {
    if (other === this) return true
    if (other instanceof IndexedBranchPath && other.identity === this.identity) return true
    if (other.length !== this.length || other.leaf?.id !== this.leaf?.id) return false
    const otherIds = other.materializeIds()
    for (let index = 0; index < this.length; index += 1) {
      if (this.base.nodes.get(index)?.id !== otherIds[index]) return false
    }
    return true
  }

  sharesNodeValuesThrough(other: BranchPathDescriptor<T>, length: number): boolean {
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > this.length ||
      length > other.length
    ) {
      throw new Error('BranchPathPrefixLengthInvalid')
    }
    if (length === 0 || other === this) return true
    if (!(other instanceof IndexedBranchPath)) return false
    return (
      pathIdentityAtLength(this.base.identity, length) ===
        pathIdentityAtLength(other.base.identity, length) &&
      this.replacements === other.replacements
    )
  }

  extensionOffset(previous: BranchPathDescriptor<T>): number | null {
    if (previous.length > this.length) return null
    if (previous.length === 0) return 0
    if (!(previous instanceof IndexedBranchPath)) return null
    const identity = pathIdentityAtLength(this.base.identity, previous.length)
    return identity === previous.base.identity ? previous.length : null
  }

  divergenceFrom(previous: BranchPathDescriptor<T>): BranchPathDivergence {
    let commonPrefixLength = 0
    let current = this.leaf
    while (current) {
      const index = this.indexOf(current.id)
      const retained = previous.get(current.id)
      if (
        retained &&
        previous.indexOf(current.id) === index &&
        retained.parentId === current.parentId &&
        retained.siblingIndex === current.siblingIndex &&
        retained.createdAt === current.createdAt &&
        retained.deleted === current.deleted
      ) {
        commonPrefixLength = index + 1
        break
      }
      current = current.parentId === null ? null : (this.get(current.parentId) ?? null)
    }
    return Object.freeze({
      commonPrefixLength,
      branchLength: this.length,
      offset: commonPrefixLength,
      limit: this.length - commonPrefixLength,
      boundaryParentId:
        commonPrefixLength === 0 ? null : (this.base.nodes.get(commonPrefixLength - 1)?.id ?? null),
    })
  }

  window(
    page: { offset: number; limit: number },
    measurement?: BranchPathTraversalMeasurement,
  ): BranchPathWindow<T> {
    const limit = Math.max(0, Math.floor(page.limit))
    const requestedOffset = Math.floor(page.offset)
    const offset =
      requestedOffset < 0
        ? Math.max(0, this.length - limit)
        : Math.max(0, Math.min(this.length, requestedOffset))
    const end = Math.min(this.length, offset + limit)
    return this.windowRange(offset, end, limit, measurement)
  }

  backwardWindow(
    page: { endingAt: MessageId; limit: number },
    measurement?: BranchPathTraversalMeasurement,
  ): BranchPathWindow<T> {
    const endingIndex = this.base.indexById.get(page.endingAt)
    if (endingIndex === undefined) throw new Error(`BranchPathMessageMissing:${page.endingAt}`)
    const limit = Math.max(0, Math.floor(page.limit))
    const end = endingIndex + 1
    const offset = Math.max(0, end - limit)
    return this.windowRange(offset, end, end - offset, measurement)
  }

  tailSpanWhile(include: (node: T, selectedCount: number) => boolean): BranchPathSpan {
    let selectedCount = 0
    let index = this.length - 1
    while (index >= 0) {
      const node = this.effectiveAt(index) as T
      if (!include(node, selectedCount)) break
      selectedCount += 1
      index -= 1
    }
    const offset = this.length - selectedCount
    return {
      branchLength: this.length,
      offset,
      limit: selectedCount,
      boundaryParentId: offset === 0 ? null : (this.base.nodes.get(offset - 1)?.id ?? null),
    }
  }

  materializeNodes(): readonly T[] {
    if (this.replacements.size === 0) return this.base.nodes.toArray()
    this.materializedNodes ??= Object.freeze(
      Array.from({ length: this.length }, (_, index) => this.effectiveAt(index) as T),
    )
    return this.materializedNodes
  }

  materializeIds(): readonly MessageId[] {
    this.materializedIds ??= Object.freeze(
      Array.from({ length: this.length }, (_, index) => (this.base.nodes.get(index) as T).id),
    )
    return this.materializedIds
  }

  private effectiveAt(index: number): T | undefined {
    const node = this.base.nodes.get(index)
    return node ? (this.replacements.get(node.id) ?? node) : undefined
  }

  private windowRange(
    offset: number,
    end: number,
    limit: number,
    measurement?: BranchPathTraversalMeasurement,
  ): BranchPathWindow<T> {
    const nodes: T[] = []
    for (let index = offset; index < end; index += 1) {
      const node = this.effectiveAt(index)
      if (node) nodes.push(node)
    }
    if (measurement) measurement.predecessorLinks += nodes.length
    return {
      branchLength: this.length,
      offset,
      limit,
      nodes: Object.freeze(nodes),
      boundaryParentId: offset === 0 ? null : (this.base.nodes.get(offset - 1)?.id ?? null),
    }
  }
}

function createPathIdentity(
  length: number,
  previous: BranchPathIdentity | null,
): BranchPathIdentity {
  return Object.freeze({ length, previous })
}

function pathIdentityAtLength(
  identity: BranchPathIdentity,
  length: number,
): BranchPathIdentity | null {
  let current: BranchPathIdentity | null = identity
  while (current && current.length > length) current = current.previous
  return current?.length === length ? current : null
}

const EMPTY_PATH_IDENTITY = createPathIdentity(0, null)
let emptyPath: BranchPathDescriptor<MessageTreeNode> | null = null

export function emptyBranchPath<T extends MessageTreeNode>(): BranchPathDescriptor<T> {
  if (!emptyPath) {
    const nodes = PersistentVector.empty<MessageTreeNode>()
    const indexById = PersistentStringMap.empty<number>()
    emptyPath = new IndexedBranchPath<MessageTreeNode>({
      identity: EMPTY_PATH_IDENTITY,
      nodes,
      indexById,
      messageIds: new PathMessageIdSet(nodes, indexById),
    })
  }
  return emptyPath as BranchPathDescriptor<T>
}

export function createBranchPath<T extends MessageTreeNode>(
  nodes: readonly T[],
): BranchPathDescriptor<T> {
  if (nodes.length === 0) return emptyBranchPath()
  const frozenNodes = Object.isFrozen(nodes) ? nodes : Object.freeze([...nodes])
  let indexById = PersistentStringMap.empty<number>()
  let parentId: MessageId | null = null
  for (let index = 0; index < frozenNodes.length; index += 1) {
    const node = frozenNodes[index] as T
    if (node.parentId !== parentId) throw new Error('BranchPathNonContiguous')
    if (indexById.has(node.id)) throw new Error('BranchPathDuplicateMessage')
    indexById = indexById.set(node.id, index)
    parentId = node.id
  }
  const persistentNodes = PersistentVector.from(frozenNodes)
  return new IndexedBranchPath({
    identity: createPathIdentity(persistentNodes.length, null),
    nodes: persistentNodes,
    indexById,
    messageIds: new PathMessageIdSet(persistentNodes, indexById),
  })
}
