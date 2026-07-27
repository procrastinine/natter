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

type ChatRowWriteTransitionInput =
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
      readonly previous: Chat
      readonly next: Chat
    }
  | {
      readonly kind: 'replace-preserving-links'
      readonly previous: Chat
      readonly next: Chat
    }
) & {
  readonly [chatRowWriteTransitionBrand]: true
}

export interface LinkedChatRowMutationReceipt {
  readonly links: ConfigurationOwnerLinkMutationReceipt
  readonly chatWrites: ChatRowWriteMutationReceipt['chatWrites']
  readonly linkPhases: ChatRowWriteMutationReceipt['linkPhases']
  readonly sidebar: ChatSidebarProjectionMutationReceipt
  readonly fragment: SemanticOperationReceiptFragment<ChatRowWriteReceiptTableName>
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

function chatRowWriteTransition(input: ChatRowWriteTransitionInput): ChatRowWriteTransition {
  return Object.freeze({ ...input, [chatRowWriteTransitionBrand]: true as const })
}

function applyChatRowWriteTransitions(
  tx: Transaction,
  inputs: readonly Extract<
    ChatRowWriteTransitionInput,
    { readonly kind: 'replace-preserving-links' }
  >[],
): Promise<ChatRowWriteMutationReceipt<ChatRowPreservingReceiptTableName>>
function applyChatRowWriteTransitions(
  tx: Transaction,
  inputs: readonly ChatRowWriteTransitionInput[],
): Promise<ChatRowWriteMutationReceipt>
async function applyChatRowWriteTransitions(
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
  const transitions = inputs.map(chatRowWriteTransition)
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

export interface TransactionChatMutationReader {
  read(chatId: ChatId): Promise<Chat | undefined>
  readWithEvidence(chatId: ChatId): Promise<{
    readonly chat: Chat | undefined
    readonly requestCount: 0 | 1
    readonly rowCount: 0 | 1
  }>
  readMany(chatIds: readonly ChatId[]): Promise<readonly (Chat | undefined)[]>
  readAll(): Promise<readonly Chat[]>
  readFolder(folderId: NonNullable<Chat['folderId']>): Promise<readonly Chat[]>
}

export interface PreservingChatMutationOwner extends TransactionChatMutationReader {
  replace(chatId: ChatId, update: (current: Readonly<Chat>) => Chat): Chat
  commit(): Promise<ChatRowWriteMutationReceipt<ChatRowPreservingReceiptTableName>>
}

export interface LinkedChatMutationOwner extends TransactionChatMutationReader {
  add(next: Chat): Promise<void>
  replaceLinked(chatId: ChatId, update: (current: Readonly<Chat>) => Chat): Chat
  replacePreserving(chatId: ChatId, update: (current: Readonly<Chat>) => Chat): Chat
  commit(): Promise<LinkedChatRowMutationReceipt>
}

type StagedReplacementKind = 'replace-linked' | 'replace-preserving-links'

class TransactionChatMutationOwner implements LinkedChatMutationOwner {
  readonly #original = new Map<ChatId, Chat | undefined>()
  readonly #current = new Map<ChatId, Chat | undefined>()
  readonly #staged = new Map<
    ChatId,
    {
      readonly previous: Chat
      readonly kind: StagedReplacementKind
      readonly next: Chat
    }
  >()
  readonly #additions = new Map<ChatId, Chat>()
  #committed = false
  readonly tx: Transaction
  readonly linked: boolean

  constructor(tx: Transaction, linked: boolean) {
    this.tx = tx
    this.linked = linked
  }

  async read(chatId: ChatId): Promise<Chat | undefined> {
    return (await this.readWithEvidence(chatId)).chat
  }

  async readWithEvidence(chatId: ChatId): Promise<{
    readonly chat: Chat | undefined
    readonly requestCount: 0 | 1
    readonly rowCount: 0 | 1
  }> {
    this.#assertOpen()
    const requestCount = this.#original.has(chatId) ? 0 : 1
    if (requestCount === 1) {
      const row = await this.tx.table<Chat, ChatId>('chats').get(chatId)
      this.#register(chatId, row)
    }
    const chat = this.#current.get(chatId)
    return { chat, requestCount, rowCount: requestCount === 1 && chat ? 1 : 0 }
  }

  async readMany(chatIds: readonly ChatId[]): Promise<readonly (Chat | undefined)[]> {
    this.#assertOpen()
    const missing = [...new Set(chatIds.filter((chatId) => !this.#original.has(chatId)))]
    if (missing.length > 0) {
      const rows = await this.tx.table<Chat, ChatId>('chats').bulkGet(missing)
      for (const [index, chatId] of missing.entries()) this.#register(chatId, rows[index])
    }
    return chatIds.map((chatId) => this.#current.get(chatId))
  }

  async readAll(): Promise<readonly Chat[]> {
    this.#assertOpen()
    const rows = await this.tx.table<Chat, ChatId>('chats').toArray()
    for (const row of rows) this.#register(row.id, row)
    return rows.map((row) => this.#current.get(row.id) as Chat)
  }

  async readFolder(folderId: NonNullable<Chat['folderId']>): Promise<readonly Chat[]> {
    this.#assertOpen()
    const rows = await this.tx
      .table<Chat, ChatId>('chats')
      .where('folderId')
      .equals(folderId)
      .toArray()
    for (const row of rows) this.#register(row.id, row)
    return rows.map((row) => this.#current.get(row.id) as Chat)
  }

  async add(next: Chat): Promise<void> {
    this.#assertOpen()
    if (!this.linked) throw new Error('ChatMutationLinkedWriteNotAllowed')
    if (this.#current.get(next.id) || this.#additions.has(next.id)) {
      throw new Error(`ChatMutationAddDuplicate:${next.id}`)
    }
    if (!this.#original.has(next.id)) this.#register(next.id, undefined)
    this.#additions.set(next.id, next)
    this.#current.set(next.id, next)
  }

  replaceLinked(chatId: ChatId, update: (current: Readonly<Chat>) => Chat): Chat {
    if (!this.linked) throw new Error('ChatMutationLinkedWriteNotAllowed')
    return this.#replace(chatId, 'replace-linked', update)
  }

  replacePreserving(chatId: ChatId, update: (current: Readonly<Chat>) => Chat): Chat {
    return this.#replace(chatId, 'replace-preserving-links', update)
  }

  async commit(): Promise<LinkedChatRowMutationReceipt> {
    this.#assertOpen()
    this.#committed = true
    const receipt = await applyChatRowWriteTransitions(this.tx, [
      ...[...this.#additions.values()].map((next) => ({ kind: 'add-linked' as const, next })),
      ...this.#staged.values(),
    ])
    if (receipt.linkPhases.length > 1) throw new Error('ChatMutationMixedLinkPhasesUnsupported')
    return Object.freeze({
      links: receipt.linkPhases[0] ?? emptyConfigurationOwnerLinkMutationReceipt(),
      chatWrites: receipt.chatWrites,
      linkPhases: receipt.linkPhases,
      sidebar: receipt.sidebar,
      fragment: receipt.fragment,
    })
  }

  #replace(
    chatId: ChatId,
    kind: StagedReplacementKind,
    update: (current: Readonly<Chat>) => Chat,
  ): Chat {
    this.#assertOpen()
    const current = this.#current.get(chatId)
    if (!this.#original.has(chatId)) throw new Error(`ChatMutationCurrentNotRead:${chatId}`)
    if (!current) throw new Error(`ChatMutationCurrentMissing:${chatId}`)
    const next = update(current)
    if (next.id !== chatId) throw new Error(`ChatMutationIdentityMismatch:${chatId}:${next.id}`)
    if (this.#additions.has(chatId)) {
      this.#additions.set(chatId, next)
      this.#current.set(chatId, next)
      return next
    }
    const previous = this.#original.get(chatId)
    if (!previous) throw new Error(`ChatMutationCurrentMissing:${chatId}`)
    const priorStage = this.#staged.get(chatId)
    this.#staged.set(chatId, {
      previous,
      kind: priorStage?.kind === 'replace-linked' ? priorStage.kind : kind,
      next,
    })
    this.#current.set(chatId, next)
    return next
  }

  #register(chatId: ChatId, row: Chat | undefined): void {
    if (this.#original.has(chatId)) return
    this.#original.set(chatId, row)
    this.#current.set(chatId, row)
  }

  #assertOpen(): void {
    if (this.#committed) throw new Error('ChatMutationOwnerCommitted')
  }
}

export function openPreservingChatMutation(tx: Transaction): PreservingChatMutationOwner {
  const owner = new TransactionChatMutationOwner(tx, false)
  return {
    read: (chatId) => owner.read(chatId),
    readWithEvidence: (chatId) => owner.readWithEvidence(chatId),
    readMany: (chatIds) => owner.readMany(chatIds),
    readAll: () => owner.readAll(),
    readFolder: (folderId) => owner.readFolder(folderId),
    replace: (chatId, update) => owner.replacePreserving(chatId, update),
    commit: () =>
      owner.commit() as Promise<ChatRowWriteMutationReceipt<ChatRowPreservingReceiptTableName>>,
  }
}

export function openLinkedChatMutation(tx: Transaction): LinkedChatMutationOwner {
  return new TransactionChatMutationOwner(tx, true)
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
