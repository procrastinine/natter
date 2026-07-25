import type { Transaction } from 'dexie'
import type { AttachmentId, ChatId, MessageId, MutationScope } from '../core/types'
import type { AttachmentHeaderRow } from './attachment-storage'
import {
  CHAT_ROW_LINKED_TRANSACTION_CAPABILITY,
  CHAT_ROW_PRESERVING_LINKS_TRANSACTION_CAPABILITY,
} from './chat-row-transition'
import { CONFIGURATION_LINK_MUTATION_TRANSACTION_CAPABILITY } from './configuration-profile-usage-projection'
import { scopeResourceName } from './locks'
import type { MessageHeaderRow } from './message-storage'
import {
  type PhysicalTransactionCapability,
  type PhysicalTransactionPlan,
  physicalStorageTables,
  physicalTransactionPlan,
} from './physical-storage-tables'
import type { WorkspaceMutationOptions } from './repository'

const MUTATION_TABLE_ORDER = [
  'attachmentCatalogAggregate',
  'attachmentCatalogRows',
  'attachmentArtifacts',
  'attachmentBlobs',
  'attachmentJobs',
  'attachmentRefEdges',
  'attachments',
  'chatSidebarAggregates',
  'chatSidebarRows',
  'chats',
  'childLists',
  'childSlotMembers',
  'configurationLinks',
  'configurationCatalogAggregates',
  'configurationProfileUsageRows',
  'discoveryCacheState',
  'discoveryPayloads',
  'discoveryPayloadMetadata',
  'drafts',
  'endpoints',
  'messages',
  'messageBodies',
  'messagePreviews',
  'models',
  'keys',
  'profiles',
  'privacyPolicies',
  'settings',
  'storageRetentionState',
  'streamLeases',
  'streamChunks',
  'textTemplates',
] as const

export type BrowserMutationTableName = (typeof MUTATION_TABLE_ORDER)[number]

export type GenerationReadSetTransactionPlan =
  | {
      readonly kind: 'messages-only'
      readonly readSet: NonNullable<WorkspaceMutationOptions['generationReadSet']>
    }
  | {
      readonly kind: 'messages-and-attachments'
      readonly readSet: NonNullable<WorkspaceMutationOptions['generationReadSet']>
    }

export interface BrowserMutationTransactionPlan {
  readonly transaction: PhysicalTransactionPlan<BrowserMutationTableName>
  readonly generationReadSet?: GenerationReadSetTransactionPlan
}

export class GenerationPlanningSeedChangedError extends Error {
  constructor(chatId: ChatId) {
    super(`GenerationPlanningSeedChanged:${chatId}`)
    this.name = 'GenerationPlanningSeedChangedError'
  }
}

function planGenerationReadSetTransaction(
  readSet: NonNullable<WorkspaceMutationOptions['generationReadSet']>,
): GenerationReadSetTransactionPlan {
  return readSet.attachments.length === 0
    ? { kind: 'messages-only', readSet }
    : { kind: 'messages-and-attachments', readSet }
}

export function planMutationTransaction(
  scopes: readonly MutationScope[],
  options?: WorkspaceMutationOptions,
  additionalTables: readonly BrowserMutationTableName[] = [],
): BrowserMutationTransactionPlan {
  const names = new Set<BrowserMutationTableName>()
  const generationReadSet = options?.generationReadSet
    ? planGenerationReadSetTransaction(options.generationReadSet)
    : undefined
  if (options?.initialChat) {
    addMutationCapabilityTables(names, CHAT_ROW_LINKED_TRANSACTION_CAPABILITY)
  }
  if (options?.promoteChatId) {
    addMutationCapabilityTables(names, CHAT_ROW_PRESERVING_LINKS_TRANSACTION_CAPABILITY)
  }
  if (options?.requiredProfileId) names.add('profiles')
  if (options?.captureGenerationPlanningSnapshot) {
    names.add('chats')
    names.add('discoveryPayloadMetadata')
    names.add('discoveryPayloads')
    names.add('endpoints')
    names.add('messages')
    names.add('models')
    names.add('keys')
    names.add('profiles')
    names.add('privacyPolicies')
    names.add('settings')
  }
  if (options?.configurationLinkChatId) addConfigurationLinkMutationTables(names)
  if (generationReadSet) {
    names.add('chats')
    names.add('messages')
    if (generationReadSet.kind === 'messages-and-attachments') names.add('attachments')
  }
  if (
    options?.streamFence ||
    options?.streamTargetCommit ||
    options?.streamCanonicalCommit ||
    options?.streamAdmission
  ) {
    names.add('streamLeases')
  }
  if (options?.streamAdmission) {
    names.add('chats')
    names.add('messages')
    names.add('settings')
  }
  if ((options?.settingReadKeys?.length ?? 0) > 0) names.add('settings')
  if (options?.streamTargetCommit || options?.streamCanonicalCommit) names.add('messages')
  for (const scope of scopes) {
    switch (scope.kind) {
      case 'attachment':
        names.add('attachmentCatalogAggregate')
        names.add('attachmentCatalogRows')
        names.add('attachmentArtifacts')
        names.add('attachmentBlobs')
        names.add('attachmentJobs')
        names.add('attachmentRefEdges')
        names.add('attachments')
        break
      case 'chat-meta':
        addMutationCapabilityTables(names, CHAT_ROW_PRESERVING_LINKS_TRANSACTION_CAPABILITY)
        break
      case 'chat-topology':
        addMutationCapabilityTables(names, CHAT_ROW_PRESERVING_LINKS_TRANSACTION_CAPABILITY)
        names.add('childLists')
        names.add('childSlotMembers')
        names.add('messages')
        names.add('messageBodies')
        break
      case 'children':
        addMutationCapabilityTables(names, CHAT_ROW_PRESERVING_LINKS_TRANSACTION_CAPABILITY)
        names.add('childLists')
        names.add('childSlotMembers')
        names.add('messages')
        names.add('messageBodies')
        break
      case 'draft':
        addMutationCapabilityTables(names, CHAT_ROW_PRESERVING_LINKS_TRANSACTION_CAPABILITY)
        names.add('drafts')
        break
      case 'message':
        addMutationCapabilityTables(names, CHAT_ROW_PRESERVING_LINKS_TRANSACTION_CAPABILITY)
        names.add('messages')
        names.add('messageBodies')
        names.add('messagePreviews')
        names.add('streamLeases')
        break
    }
  }
  for (const tableName of additionalTables) names.add(tableName)
  if (names.has('chatSidebarRows')) names.add('chatSidebarAggregates')
  const tableNames = MUTATION_TABLE_ORDER.filter((name) => names.has(name))
  return {
    transaction: physicalTransactionPlan(physicalStorageTables(...tableNames)),
    ...(generationReadSet ? { generationReadSet } : {}),
  }
}

function addConfigurationLinkMutationTables(names: Set<BrowserMutationTableName>): void {
  addMutationCapabilityTables(names, CONFIGURATION_LINK_MUTATION_TRANSACTION_CAPABILITY)
}

function addMutationCapabilityTables<Tables extends BrowserMutationTableName>(
  names: Set<BrowserMutationTableName>,
  capability: PhysicalTransactionCapability<Tables>,
): void {
  for (const tableName of capability.tableNames) names.add(tableName)
}

export async function validateGenerationReadSetTransaction(
  tx: Transaction,
  plan: GenerationReadSetTransactionPlan,
): Promise<void> {
  const { readSet } = plan
  const headers = await tx
    .table<MessageHeaderRow, MessageId>('messages')
    .bulkGet(readSet.messages.map((message) => message.messageId))
  const attachmentHeaders =
    plan.kind === 'messages-and-attachments'
      ? await tx
          .table<AttachmentHeaderRow, AttachmentId>('attachments')
          .bulkGet(readSet.attachments.map((attachment) => attachment.attachmentId))
      : []
  for (let index = 0; index < readSet.messages.length; index += 1) {
    const expected = readSet.messages[index]
    const current = headers[index]
    if (
      !expected ||
      !current ||
      current.chatId !== readSet.chatId ||
      current.parentId !== expected.parentId ||
      current.requestContextVersion !== expected.requestContextVersion ||
      current.deleted
    ) {
      throw new Error(`GenerationPromptMessageChanged:${expected?.messageId ?? 'unknown'}`)
    }
  }
  for (let index = 0; index < readSet.attachments.length; index += 1) {
    const expected = readSet.attachments[index]
    const current = attachmentHeaders[index]
    if (
      !expected ||
      (expected.wireVersion === null
        ? current !== undefined
        : current?.wireVersion !== expected.wireVersion)
    ) {
      throw new Error(`GenerationPromptAttachmentChanged:${expected?.attachmentId ?? 'unknown'}`)
    }
  }
}

export function resolveMutationTableNames(
  scopes: readonly MutationScope[],
  options?: WorkspaceMutationOptions,
): readonly BrowserMutationTableName[] {
  return planMutationTransaction(scopes, options).transaction.tableNames
}

export function createMutationScopeChecker(scopes: readonly MutationScope[]): {
  readonly assertScope: (scope: MutationScope) => void
} {
  const allowed = new Set(scopes.map(scopeResourceName))
  const broadTopologyChats = new Set(
    scopes.flatMap((scope) => (scope.kind === 'chat-topology' ? [scope.chatId] : [])),
  )
  return {
    assertScope(scope) {
      if (scope.kind === 'children' && broadTopologyChats.has(scope.chatId)) return
      const key = scopeResourceName(scope)
      if (!allowed.has(key)) throw new Error(`UndeclaredScope:${key}`)
    },
  }
}
