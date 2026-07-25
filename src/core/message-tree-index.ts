import type { MessageTreeNode } from './active-path'
import type { ChatId } from './types'

type MessageTreeLiveKey = 0 | 1
const ROOT_TREE_PARENT_KEY = '__root__'

export interface MessageTreeIndexFields {
  readonly treeParentKey: string
  readonly treeLive: MessageTreeLiveKey
}

export interface ProjectableMessageTreeNode extends MessageTreeNode {
  readonly chatId: ChatId
}

export function treeParentKey(parentId: MessageTreeNode['parentId']): string {
  return parentId ?? ROOT_TREE_PARENT_KEY
}

function treeLiveKey(deleted: boolean): MessageTreeLiveKey {
  return deleted ? 0 : 1
}

export function messageTreeIndexFields(
  row: Pick<ProjectableMessageTreeNode, 'parentId' | 'deleted'>,
): MessageTreeIndexFields {
  return {
    treeParentKey: treeParentKey(row.parentId),
    treeLive: treeLiveKey(row.deleted),
  }
}
