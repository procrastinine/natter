import type { Transaction } from 'dexie'
import type { Chat, ChatId } from '../core/types'
import {
  addLinkedSemanticByteOwnerBatch,
  replaceLinkedSemanticByteOwnerBatch,
  replaceLinkedSemanticByteOwnerPreservingLinksBatch,
} from './byte-owner-mutation'
import {
  applyChatSidebarProjectionTransitions,
  CHAT_SIDEBAR_PROJECTION_TRANSACTION_CAPABILITY,
  type ChatSidebarProjectionTransition,
} from './chat-sidebar-projection'
import { currentChatRowForTransaction, type TransactionCurrentChat } from './chat-storage-codec'
import { CONFIGURATION_LINK_MUTATION_TRANSACTION_CAPABILITY } from './configuration-profile-usage-projection'
import { physicalStorageTables } from './physical-storage-tables'

export const CHAT_ROW_PRESERVING_LINKS_TRANSACTION_CAPABILITY = physicalStorageTables(
  'chats',
  ...CHAT_SIDEBAR_PROJECTION_TRANSACTION_CAPABILITY.tableNames,
)

export const CHAT_ROW_LINKED_TRANSACTION_CAPABILITY = physicalStorageTables(
  ...CHAT_ROW_PRESERVING_LINKS_TRANSACTION_CAPABILITY.tableNames,
  ...CONFIGURATION_LINK_MUTATION_TRANSACTION_CAPABILITY.tableNames,
)

const chatRowWriteTransitionBrand: unique symbol = Symbol('ChatRowWriteTransition')

export type ChatRowWriteTransitionInput =
  | {
      readonly kind: 'add-linked'
      readonly next: Chat
    }
  | {
      readonly kind: 'replace-linked'
      readonly previous: Chat
      readonly next: Chat
    }
  | {
      readonly kind: 'replace-preserving-links'
      readonly previous: Chat
      readonly next: Chat
    }

type ChatRowWriteTransition = (
  | {
      readonly kind: 'add-linked'
      readonly next: Chat
    }
  | {
      readonly kind: 'replace-linked'
      readonly previous: TransactionCurrentChat
      readonly next: Chat
    }
  | {
      readonly kind: 'replace-preserving-links'
      readonly previous: TransactionCurrentChat
      readonly next: Chat
    }
) & {
  readonly [chatRowWriteTransitionBrand]: true
}

function chatRowWriteTransition(
  tx: Transaction,
  input: ChatRowWriteTransitionInput,
): ChatRowWriteTransition {
  if (input.kind === 'add-linked') {
    return Object.freeze({ ...input, [chatRowWriteTransitionBrand]: true as const })
  }
  return Object.freeze({
    ...input,
    previous: currentChatRowForTransaction(tx, input.previous),
    [chatRowWriteTransitionBrand]: true as const,
  })
}

export async function applyChatRowWriteTransitions(
  tx: Transaction,
  inputs: readonly ChatRowWriteTransitionInput[],
): Promise<void> {
  if (inputs.length === 0) return
  const transitions = inputs.map((input) => chatRowWriteTransition(tx, input))
  const ids = new Set<ChatId>()
  const additions: Chat[] = []
  const linkedReplacements: Chat[] = []
  const linkedPrevious: Chat[] = []
  const preservingReplacements: Chat[] = []
  const preservingPrevious: Chat[] = []
  const projectionTransitions: ChatSidebarProjectionTransition[] = []
  for (const transition of transitions) {
    if (transition.kind !== 'add-linked') {
      currentChatRowForTransaction(tx, transition.previous)
    }
    const id = transition.next.id
    if (ids.has(id)) throw new Error(`ChatRowWriteTransitionDuplicate:${id}`)
    ids.add(id)
    if (transition.kind === 'add-linked') {
      additions.push(transition.next)
      projectionTransitions.push({ kind: 'add', next: transition.next })
      continue
    }
    if (transition.previous.id !== id) {
      throw new Error(`ChatRowWriteTransitionIdentityMismatch:${id}`)
    }
    projectionTransitions.push({
      kind: 'replace',
      previous: transition.previous,
      next: transition.next,
    })
    if (transition.kind === 'replace-linked') {
      linkedReplacements.push(transition.next)
      linkedPrevious.push(transition.previous)
    } else {
      preservingReplacements.push(transition.next)
      preservingPrevious.push(transition.previous)
    }
  }
  if (preservingReplacements.length > 0) {
    await replaceLinkedSemanticByteOwnerPreservingLinksBatch(
      tx,
      'chats',
      preservingReplacements,
      preservingPrevious,
    )
  }
  if (additions.length > 0) {
    await addLinkedSemanticByteOwnerBatch(tx, 'chats', additions)
  }
  if (linkedReplacements.length > 0) {
    await replaceLinkedSemanticByteOwnerBatch(tx, 'chats', linkedReplacements, linkedPrevious)
  }
  await applyChatSidebarProjectionTransitions(tx, projectionTransitions)
}
