import type { Message, MessageId } from './types'

export type MessageTreeNode = Pick<
  Message,
  'id' | 'parentId' | 'siblingIndex' | 'createdAt' | 'deleted'
>

function bucketTreeNodesByParent<T extends MessageTreeNode>(
  messages: readonly T[],
): Map<MessageId | null, T[]> {
  const buckets = new Map<MessageId | null, T[]>()
  for (const message of messages) {
    const bucket = buckets.get(message.parentId)
    if (bucket) bucket.push(message)
    else buckets.set(message.parentId, [message])
  }
  return buckets
}

function indexTreeNodesById<T extends MessageTreeNode>(messages: readonly T[]): Map<MessageId, T> {
  const map = new Map<MessageId, T>()
  for (const message of messages) map.set(message.id, message)
  return map
}

export function indexById(messages: readonly Message[]): Map<MessageId, Message> {
  return indexTreeNodesById(messages)
}

export interface MessageTreeProjection<T extends MessageTreeNode = MessageTreeNode> {
  readonly nodes: readonly T[]
  readonly byParent: ReadonlyMap<MessageId | null, readonly T[]>
  readonly liveByParent: ReadonlyMap<MessageId | null, readonly T[]>
  readonly byId: ReadonlyMap<MessageId, T>
}

export function compareLiveLeafRecency(
  left: Pick<MessageTreeNode, 'createdAt' | 'id'>,
  right: Pick<MessageTreeNode, 'createdAt' | 'id'>,
): number {
  return left.createdAt - right.createdAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
}

function liveLeaves(messages: readonly Message[]): Message[] {
  const byParent = bucketTreeNodesByParent(messages)
  const leaves: Message[] = []
  for (const message of messages) {
    if (message.deleted) continue
    const children = byParent.get(message.id)
    const hasLiveChild = children?.some((child) => !child.deleted) ?? false
    if (!hasLiveChild) leaves.push(message)
  }
  return leaves
}

export function findLastUpdatedLeafId(messages: readonly Message[]): MessageId | null {
  let best: Message | null = null
  for (const leaf of liveLeaves(messages)) {
    if (!best || compareLiveLeafRecency(leaf, best) > 0) best = leaf
  }
  return best?.id ?? null
}
