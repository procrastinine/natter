import type { Transaction } from 'dexie'
import type { Chat, ChatId } from '../core/types'
import {
  addLinkedSemanticByteOwnerBatch,
  type ConfigurationOwnerLinkMutationReceipt,
  emptyConfigurationOwnerLinkMutationReceipt,
  replaceLinkedSemanticByteOwnerBatch,
  replaceLinkedSemanticByteOwnerPreservingLinksBatch,
} from './byte-owner-mutation'
import {
  applyChatSidebarProjectionTransitions,
  CHAT_SIDEBAR_PROJECTION_TRANSACTION_CAPABILITY,
  type ChatSidebarProjectionMutationReceipt,
  type ChatSidebarProjectionTransition,
  emptyChatSidebarProjectionMutationReceipt,
} from './chat-sidebar-projection'
import { currentChatRowForTransaction, type TransactionCurrentChat } from './chat-storage-codec'
import {
  CONFIGURATION_LINK_MUTATION_TRANSACTION_CAPABILITY,
  CONFIGURATION_PROFILE_MANAGER_STATE_ID,
} from './configuration-profile-usage-projection'
import {
  type CapabilityTables,
  type PhysicalStorageTableName,
  physicalStorageTables,
} from './physical-storage-tables'
import {
  type SemanticOperationReceiptFragment,
  semanticOperationReceiptFragment,
} from './semantic-operation-capability'
import { normalizeWorkspaceDependencies } from './workspace-protocol'

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
      readonly previous: TransactionCurrentChat
      readonly next: Chat
    }
  | {
      readonly kind: 'replace-preserving-links'
      readonly previous: TransactionCurrentChat
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

export interface LinkedChatRowMutationReceipt {
  readonly links: ConfigurationOwnerLinkMutationReceipt
  readonly sidebar: ChatSidebarProjectionMutationReceipt
}

type ChatRowWriteReceiptTableName =
  | 'chats'
  | 'configurationLinks'
  | 'configurationProfileUsageRows'
  | 'configurationCatalogAggregates'
  | 'chatSidebarRows'
  | 'chatSidebarAggregates'

type ChatRowPreservingReceiptTableName = CapabilityTables<
  typeof CHAT_ROW_PRESERVING_LINKS_TRANSACTION_CAPABILITY
>

export interface ChatRowWriteMutationReceipt<
  Tables extends PhysicalStorageTableName = ChatRowWriteReceiptTableName,
> {
  readonly chatWrites: readonly {
    readonly chatId: ChatId
    readonly transition: ChatRowWriteTransitionInput['kind']
  }[]
  readonly linkPhases: readonly ConfigurationOwnerLinkMutationReceipt[]
  readonly sidebar: ChatSidebarProjectionMutationReceipt
  readonly fragment: SemanticOperationReceiptFragment<Tables>
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

export function applyChatRowWriteTransitions(
  tx: Transaction,
  inputs: readonly Extract<
    ChatRowWriteTransitionInput,
    { readonly kind: 'replace-preserving-links' }
  >[],
): Promise<ChatRowWriteMutationReceipt<ChatRowPreservingReceiptTableName>>
export function applyChatRowWriteTransitions(
  tx: Transaction,
  inputs: readonly ChatRowWriteTransitionInput[],
): Promise<ChatRowWriteMutationReceipt>
export async function applyChatRowWriteTransitions(
  tx: Transaction,
  inputs: readonly ChatRowWriteTransitionInput[],
): Promise<ChatRowWriteMutationReceipt> {
  if (inputs.length === 0) {
    const sidebar = emptyChatSidebarProjectionMutationReceipt()
    return Object.freeze({
      chatWrites: Object.freeze([]),
      linkPhases: Object.freeze([]),
      sidebar,
      fragment: semanticOperationReceiptFragment<ChatRowWriteReceiptTableName>({}),
    })
  }
  const transitions = inputs.map((input) => chatRowWriteTransition(tx, input))
  const ids = new Set<ChatId>()
  const additions: Chat[] = []
  const linkedReplacements: Chat[] = []
  const linkedPrevious: Chat[] = []
  const preservingReplacements: Chat[] = []
  const preservingPrevious: Chat[] = []
  const projectionTransitions: ChatSidebarProjectionTransition[] = []
  for (const transition of transitions) {
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
  const linkPhases: ConfigurationOwnerLinkMutationReceipt[] = []
  if (preservingReplacements.length > 0) {
    await replaceLinkedSemanticByteOwnerPreservingLinksBatch(
      tx,
      'chats',
      preservingReplacements,
      preservingPrevious,
    )
  }
  if (additions.length > 0) {
    linkPhases.push(await addLinkedSemanticByteOwnerBatch(tx, 'chats', additions))
  }
  if (linkedReplacements.length > 0) {
    linkPhases.push(
      await replaceLinkedSemanticByteOwnerBatch(tx, 'chats', linkedReplacements, linkedPrevious),
    )
  }
  const sidebar = await applyChatSidebarProjectionTransitions(tx, projectionTransitions)
  const chatWrites = Object.freeze(
    transitions.map((transition) =>
      Object.freeze({ chatId: transition.next.id, transition: transition.kind }),
    ),
  )
  const fragment = chatRowWriteMutationReceiptFragment(chatWrites, linkPhases, sidebar)
  return Object.freeze({
    chatWrites,
    linkPhases: Object.freeze(linkPhases),
    sidebar,
    fragment,
  })
}

export async function applyLinkedChatRowReplacement(
  tx: Transaction,
  previous: TransactionCurrentChat,
  next: Chat,
): Promise<LinkedChatRowMutationReceipt> {
  return applyLinkedChatRowReplacements(tx, [{ previous, next }])
}

export async function applyLinkedChatRowReplacements(
  tx: Transaction,
  inputs: readonly { readonly previous: TransactionCurrentChat; readonly next: Chat }[],
): Promise<LinkedChatRowMutationReceipt> {
  const receipt = await applyChatRowWriteTransitions(
    tx,
    inputs.map(({ previous, next }) => ({ kind: 'replace-linked', previous, next })),
  )
  return Object.freeze({
    links: receipt.linkPhases[0] ?? emptyConfigurationOwnerLinkMutationReceipt(),
    sidebar: receipt.sidebar,
  })
}

function chatRowWriteMutationReceiptFragment(
  chatWrites: ChatRowWriteMutationReceipt['chatWrites'],
  linkPhases: readonly ConfigurationOwnerLinkMutationReceipt[],
  sidebar: ChatSidebarProjectionMutationReceipt,
): SemanticOperationReceiptFragment<ChatRowWriteReceiptTableName> {
  const profileIds = [
    ...new Set(
      linkPhases.flatMap((phase) => phase.profileUsageMutations.map(({ profileId }) => profileId)),
    ),
  ].sort()
  return semanticOperationReceiptFragment({
    dependencies: normalizeWorkspaceDependencies([
      ...(chatWrites.length > 0
        ? [{ kind: 'chat' as const, chatIds: chatWrites.map(({ chatId }) => chatId) }]
        : []),
      ...(sidebar.mutatedRowIds.length > 0 || sidebar.aggregateMutations.length > 0
        ? [{ kind: 'sidebar' as const, chatIds: chatWrites.map(({ chatId }) => chatId) }]
        : []),
      ...(profileIds.length > 0
        ? [{ kind: 'profile' as const, profileIds, facets: ['dependent-counts' as const] }]
        : []),
    ]),
    physicalMutations: [
      ...chatWrites.map(({ chatId: key }) => ({
        tableName: 'chats' as const,
        operation: 'write' as const,
        key,
      })),
      ...linkPhases.flatMap((phase) => [
        ...phase.removedLinkIds.map((key) => ({
          tableName: 'configurationLinks' as const,
          operation: 'delete' as const,
          key,
        })),
        ...phase.writtenLinkIds.map((key) => ({
          tableName: 'configurationLinks' as const,
          operation: 'write' as const,
          key,
        })),
        ...phase.profileUsageMutations.map(({ profileId: key, operation }) => ({
          tableName: 'configurationProfileUsageRows' as const,
          operation,
          key,
        })),
        ...(phase.profileManagerRevisionChanged
          ? [
              {
                tableName: 'configurationCatalogAggregates' as const,
                operation: 'write' as const,
                key: CONFIGURATION_PROFILE_MANAGER_STATE_ID,
              },
            ]
          : []),
      ]),
      ...sidebar.mutatedRowIds.map((key) => ({
        tableName: 'chatSidebarRows' as const,
        operation: 'write' as const,
        key,
      })),
      ...sidebar.aggregateMutations.map(({ id: key, operation }) => ({
        tableName: 'chatSidebarAggregates' as const,
        operation,
        key,
      })),
    ],
    physicalReads: [
      ...linkPhases.flatMap((phase) => [
        ...(phase.ownerQueryRequests > 0
          ? [
              {
                tableName: 'configurationLinks' as const,
                indexKind: 'secondary' as const,
                indexName: 'ownerKey',
                operation: 'open-cursor' as const,
                requestCount: phase.ownerQueryRequests,
                rowCount: phase.ownerQueryRowCount,
              },
            ]
          : []),
        ...(phase.profileUsageReadRequests > 0
          ? [
              {
                tableName: 'configurationProfileUsageRows' as const,
                indexKind: 'primary' as const,
                operation: 'get-many' as const,
                requestCount: phase.profileUsageReadRequests,
                rowCount: phase.profileUsageMutations.length,
              },
            ]
          : []),
        ...(phase.profileManagerRevisionChanged
          ? [
              {
                tableName: 'configurationCatalogAggregates' as const,
                indexKind: 'primary' as const,
                operation: 'get' as const,
                requestCount: 1,
                rowCount: 1,
              },
            ]
          : []),
      ]),
      ...(sidebar.rowReadRequests > 0
        ? [
            {
              tableName: 'chatSidebarRows' as const,
              indexKind: 'primary' as const,
              operation: 'get-many' as const,
              requestCount: sidebar.rowReadRequests,
              rowCount: sidebar.rowReadCount,
            },
          ]
        : []),
      ...(sidebar.aggregateReadRequests > 0
        ? [
            {
              tableName: 'chatSidebarAggregates' as const,
              indexKind: 'primary' as const,
              operation: 'get-many' as const,
              requestCount: sidebar.aggregateReadRequests,
              rowCount: sidebar.aggregateReadCount,
            },
          ]
        : []),
      ...sidebar.extremaReads.map(({ indexName, operation, requestCount, rowCount }) => ({
        tableName: 'chatSidebarRows' as const,
        indexKind: 'secondary' as const,
        indexName,
        operation,
        requestCount,
        rowCount,
      })),
    ],
  })
}
