import { PersistentStringMap } from '../lib/persistent-string-map'
import type { MessageTreeNode, MessageTreeProjection } from './active-path'
import { treeParentKey } from './message-tree-index'
import type { MessageId } from './types'

interface ParentBucket<T> {
  readonly allById: PersistentStringMap<T>
  readonly liveById: PersistentStringMap<T>
  readonly all: readonly T[]
  readonly live: readonly T[]
}

type BucketKind = 'all' | 'live'

class StringMapView<T> implements ReadonlyMap<MessageId, T> {
  private readonly valuesById: PersistentStringMap<T>

  constructor(valuesById: PersistentStringMap<T>) {
    this.valuesById = valuesById
  }

  get size(): number {
    return this.valuesById.size
  }

  get(messageId: MessageId): T | undefined {
    return this.valuesById.get(messageId)
  }

  has(messageId: MessageId): boolean {
    return this.valuesById.has(messageId)
  }

  *entries(): MapIterator<[MessageId, T]> {
    yield* this.valuesById.entries()
  }

  *keys(): MapIterator<MessageId> {
    yield* this.valuesById.keys()
  }

  *values(): MapIterator<T> {
    yield* this.valuesById.values()
  }

  forEach(
    callback: (value: T, key: MessageId, map: ReadonlyMap<MessageId, T>) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, value] of this.valuesById) callback.call(thisArg, value, key, this)
  }

  [Symbol.iterator](): MapIterator<[MessageId, T]> {
    return this.entries()
  }
}

class ParentBucketView<T extends MessageTreeNode>
  implements ReadonlyMap<MessageId | null, readonly T[]>
{
  private readonly buckets: PersistentStringMap<ParentBucket<T>>
  private readonly kind: BucketKind
  readonly size: number

  constructor(buckets: PersistentStringMap<ParentBucket<T>>, kind: BucketKind, size: number) {
    this.buckets = buckets
    this.kind = kind
    this.size = size
  }

  get(parentId: MessageId | null): readonly T[] | undefined {
    const value = this.buckets.get(treeParentKey(parentId))?.[this.kind]
    return value && value.length > 0 ? value : undefined
  }

  has(parentId: MessageId | null): boolean {
    return this.get(parentId) !== undefined
  }

  *entries(): MapIterator<[MessageId | null, readonly T[]]> {
    for (const [key, bucket] of this.buckets) {
      const value = bucket[this.kind]
      if (value.length === 0) continue
      yield [key === treeParentKey(null) ? null : key, value]
    }
  }

  *keys(): MapIterator<MessageId | null> {
    for (const [parentId] of this.entries()) yield parentId
  }

  *values(): MapIterator<readonly T[]> {
    for (const [, value] of this.entries()) yield value
  }

  forEach(
    callback: (
      value: readonly T[],
      key: MessageId | null,
      map: ReadonlyMap<MessageId | null, readonly T[]>,
    ) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, value] of this.entries()) callback.call(thisArg, value, key, this)
  }

  [Symbol.iterator](): MapIterator<[MessageId | null, readonly T[]]> {
    return this.entries()
  }
}

class MessageIdSetView<T> implements ReadonlySet<MessageId> {
  private readonly byId: PersistentStringMap<T>

  constructor(byId: PersistentStringMap<T>) {
    this.byId = byId
  }

  get size(): number {
    return this.byId.size
  }

  has(messageId: MessageId): boolean {
    return this.byId.has(messageId)
  }

  *entries(): SetIterator<[MessageId, MessageId]> {
    for (const messageId of this.byId.keys()) yield [messageId, messageId]
  }

  *keys(): SetIterator<MessageId> {
    yield* this.byId.keys()
  }

  *values(): SetIterator<MessageId> {
    yield* this.byId.keys()
  }

  forEach(
    callback: (value: MessageId, value2: MessageId, set: ReadonlySet<MessageId>) => void,
    thisArg?: unknown,
  ): void {
    for (const messageId of this.byId.keys()) {
      callback.call(thisArg, messageId, messageId, this)
    }
  }

  [Symbol.iterator](): SetIterator<MessageId> {
    return this.values()
  }
}

function lazySiblingArray<T extends MessageTreeNode>(
  valuesById: PersistentStringMap<T>,
): readonly T[] {
  let materialized: readonly T[] | null = null
  const value = () => {
    materialized ??= Object.freeze(
      [...valuesById.values()].sort(
        (left, right) =>
          left.siblingIndex - right.siblingIndex ||
          left.createdAt - right.createdAt ||
          (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
      ),
    )
    return materialized
  }
  const target = new Array<T>(valuesById.size)
  return new Proxy(target, {
    get: (_target, property) => {
      if (property === 'length') return valuesById.size
      const reflected: unknown = Reflect.get(value(), property)
      return reflected
    },
    has: (_target, property) => {
      if (property === 'length') return true
      return Reflect.has(value(), property)
    },
    ownKeys: () => Reflect.ownKeys(value()),
    getOwnPropertyDescriptor: (_target, property) => {
      if (property === 'length') return Reflect.getOwnPropertyDescriptor(target, property)
      const descriptor = Reflect.getOwnPropertyDescriptor(value(), property)
      return descriptor ? { ...descriptor, configurable: true } : undefined
    },
    set: () => false,
    deleteProperty: () => false,
    defineProperty: () => false,
  })
}

function parentBucket<T extends MessageTreeNode>(
  allById: PersistentStringMap<T>,
  liveById: PersistentStringMap<T>,
): ParentBucket<T> {
  return {
    allById,
    liveById,
    all: lazySiblingArray(allById),
    live: lazySiblingArray(liveById),
  }
}

export interface MessageTopologyOptions<T extends MessageTreeNode> {
  sameStructure(left: T, right: T): boolean
  sameValue?(left: T, right: T): boolean
}

export interface MessageTopologyIndex<T extends MessageTreeNode> extends MessageTreeProjection<T> {
  readonly messageIds: ReadonlySet<MessageId>
  applyDelta(
    changedKeys: readonly string[],
    changedRows: readonly (T | undefined)[],
  ): MessageTopologyIndex<T>
  reconcileFull(rows: readonly T[]): MessageTopologyIndex<T>
}

class ImmutableMessageTopology<T extends MessageTreeNode> implements MessageTopologyIndex<T> {
  readonly byId: ReadonlyMap<MessageId, T>
  readonly byParent: ReadonlyMap<MessageId | null, readonly T[]>
  readonly liveByParent: ReadonlyMap<MessageId | null, readonly T[]>
  readonly messageIds: ReadonlySet<MessageId>
  private materializedNodes: readonly T[] | null = null
  private readonly nodeById: PersistentStringMap<T>
  private readonly buckets: PersistentStringMap<ParentBucket<T>>
  private readonly allBucketCount: number
  private readonly liveBucketCount: number
  private readonly options: MessageTopologyOptions<T>

  constructor(
    nodeById: PersistentStringMap<T>,
    buckets: PersistentStringMap<ParentBucket<T>>,
    allBucketCount: number,
    liveBucketCount: number,
    options: MessageTopologyOptions<T>,
  ) {
    this.nodeById = nodeById
    this.buckets = buckets
    this.allBucketCount = allBucketCount
    this.liveBucketCount = liveBucketCount
    this.options = options
    this.byId = new StringMapView(nodeById)
    this.byParent = new ParentBucketView(buckets, 'all', allBucketCount)
    this.liveByParent = new ParentBucketView(buckets, 'live', liveBucketCount)
    this.messageIds = new MessageIdSetView(nodeById)
  }

  get nodes(): readonly T[] {
    this.materializedNodes ??= Object.freeze([...this.nodeById.values()])
    return this.materializedNodes
  }

  applyDelta(
    changedKeys: readonly string[],
    changedRows: readonly (T | undefined)[],
  ): MessageTopologyIndex<T> {
    if (changedKeys.length !== changedRows.length) {
      throw new Error('MessageTopologyDeltaLengthMismatch')
    }

    let byId = this.nodeById
    const mutationsByParent = new Map<
      string,
      { readonly removedIds: Set<MessageId>; readonly upserts: T[] }
    >()
    const mutationFor = (parentId: MessageId | null) => {
      const parentKey = treeParentKey(parentId)
      let mutation = mutationsByParent.get(parentKey)
      if (!mutation) {
        mutation = { removedIds: new Set(), upserts: [] }
        mutationsByParent.set(parentKey, mutation)
      }
      return mutation
    }

    for (let index = 0; index < changedKeys.length; index += 1) {
      const messageId = changedKeys[index] as MessageId
      const current = byId.get(messageId)
      const candidate = changedRows[index]
      if (!candidate) {
        if (!current) continue
        byId = byId.delete(messageId)
        mutationFor(current.parentId).removedIds.add(messageId)
        continue
      }
      if (candidate.id !== messageId) throw new Error('MessageTopologyDeltaKeyMismatch')
      if (
        current &&
        (this.options.sameValue?.(current, candidate) ??
          this.options.sameStructure(current, candidate))
      ) {
        continue
      }
      byId = byId.set(messageId, candidate)
      if (current) mutationFor(current.parentId).removedIds.add(messageId)
      mutationFor(candidate.parentId).upserts.push(candidate)
    }

    if (mutationsByParent.size === 0) return this

    let buckets = this.buckets
    let allBucketCount = this.allBucketCount
    let liveBucketCount = this.liveBucketCount
    for (const [parentKey, mutation] of mutationsByParent) {
      const previous = buckets.get(parentKey)
      let allById = previous?.allById ?? PersistentStringMap.empty<T>()
      let liveById = previous?.liveById ?? PersistentStringMap.empty<T>()
      for (const messageId of mutation.removedIds) {
        allById = allById.delete(messageId)
        liveById = liveById.delete(messageId)
      }
      for (const node of mutation.upserts) {
        allById = allById.set(node.id, node)
        liveById = node.deleted ? liveById.delete(node.id) : liveById.set(node.id, node)
      }
      if ((previous?.allById.size ?? 0) === 0 && allById.size > 0) allBucketCount += 1
      if ((previous?.allById.size ?? 0) > 0 && allById.size === 0) allBucketCount -= 1
      if ((previous?.liveById.size ?? 0) === 0 && liveById.size > 0) liveBucketCount += 1
      if ((previous?.liveById.size ?? 0) > 0 && liveById.size === 0) liveBucketCount -= 1
      buckets =
        allById.size === 0
          ? buckets.delete(parentKey)
          : buckets.set(parentKey, parentBucket(allById, liveById))
    }

    return new ImmutableMessageTopology(
      byId,
      buckets,
      allBucketCount,
      liveBucketCount,
      this.options,
    )
  }

  reconcileFull(rows: readonly T[]): MessageTopologyIndex<T> {
    if (this.nodeById.size === 0) {
      return rows.length === 0 ? this : createMessageTopologyIndex(rows, this.options)
    }
    const seen = new Set<MessageId>()
    const changedKeys: MessageId[] = []
    const changedRows: Array<T | undefined> = []
    for (const row of rows) {
      seen.add(row.id)
      const current = this.nodeById.get(row.id)
      if (
        current &&
        (this.options.sameValue?.(current, row) ?? this.options.sameStructure(current, row))
      ) {
        continue
      }
      changedKeys.push(row.id)
      changedRows.push(row)
    }
    if (seen.size !== this.nodeById.size) {
      for (const messageId of this.nodeById.keys()) {
        if (seen.has(messageId)) continue
        changedKeys.push(messageId)
        changedRows.push(undefined)
      }
    }
    return this.applyDelta(changedKeys, changedRows)
  }
}

export function createMessageTopologyIndex<T extends MessageTreeNode>(
  rows: readonly T[],
  options: MessageTopologyOptions<T>,
): MessageTopologyIndex<T> {
  const mutableBuckets = new Map<string, T[]>()
  for (const row of rows) {
    const parentKey = treeParentKey(row.parentId)
    const bucket = mutableBuckets.get(parentKey)
    if (bucket) bucket.push(row)
    else mutableBuckets.set(parentKey, [row])
  }
  const byId = PersistentStringMap.from(nodeEntries(rows))
  const bucketEntries: Array<readonly [string, ParentBucket<T>]> = []
  let liveBucketCount = 0
  for (const [parentKey, mutableBucket] of mutableBuckets) {
    const only = mutableBucket.length === 1 ? mutableBucket[0] : undefined
    const allById = only
      ? PersistentStringMap.singleton(only.id, only)
      : PersistentStringMap.from(nodeEntries(mutableBucket))
    let liveCount = 0
    let onlyLive: T | undefined
    for (const node of mutableBucket) {
      if (node.deleted) continue
      liveCount += 1
      onlyLive = node
    }
    const liveById =
      liveCount === mutableBucket.length
        ? allById
        : liveCount === 0
          ? PersistentStringMap.empty<T>()
          : liveCount === 1
            ? PersistentStringMap.singleton((onlyLive as T).id, onlyLive as T)
            : PersistentStringMap.from(nodeEntries(mutableBucket, true))
    if (liveById.size > 0) liveBucketCount += 1
    bucketEntries.push([parentKey, parentBucket(allById, liveById)])
  }
  const buckets = PersistentStringMap.from(bucketEntries)
  return new ImmutableMessageTopology(byId, buckets, mutableBuckets.size, liveBucketCount, options)
}

function* nodeEntries<T extends MessageTreeNode>(
  nodes: readonly T[],
  liveOnly = false,
): Generator<readonly [MessageId, T]> {
  for (const node of nodes) {
    if (liveOnly && node.deleted) continue
    yield [node.id, node]
  }
}
