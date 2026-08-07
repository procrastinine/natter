import type { Transaction } from 'dexie'
import { messageBodyMutationCapability } from '../core/messages'
import type { AttachmentId, ChatId, MessageId, MutationScope } from '../core/types'
import { assertNever } from '../lib/assert'
import { stableStringify } from '../lib/same-value'
import type { AttachmentHeaderRow } from './attachment-storage'
import {
  CHAT_ROW_LINKED_TRANSACTION_CAPABILITY,
  CHAT_ROW_PRESERVING_LINKS_TRANSACTION_CAPABILITY,
} from './chat-row-transition'
import {
  chatConfigurationTargetResourceNames,
  configurationLinksForChat,
} from './configuration-domain-contract'
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
import {
  type SemanticOperationDescriptor,
  type SemanticOperationEffectKind,
  type SemanticOperationExactPhysicalRead,
  type SemanticOperationExactPlan,
  type SemanticOperationExactReceipt,
  type SemanticOperationReplayPlan,
  semanticOperationCallerSingleAttemptReplayContract,
  semanticOperationDescriptor,
  semanticOperationExactMutationAndInvalidationReceiptContracts,
  semanticOperationExactMutationReceiptContracts,
  semanticOperationExactPlan,
  semanticOperationExactReceiptPhysicalReadContract,
  semanticOperationExactReceiptReplayContract,
} from './semantic-operation-capability'
import type {
  AttemptDispatchInput,
  AttemptTerminalProjection,
  WorkspaceCommand,
} from './workspace-protocol'

const MUTATION_TABLE_ORDER = [
  'attachmentCatalogAggregate',
  'attachmentCatalogRows',
  'attachmentIntegrityState',
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

export interface BrowserMutationTransactionAccess {
  readonly readTableNames?: readonly BrowserMutationTableName[]
  readonly writeTableNames?: readonly BrowserMutationTableName[]
}

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

export interface BrowserMutationSemanticOperationPlan {
  readonly descriptor: SemanticOperationDescriptor<
    WorkspaceCommand['kind'],
    BrowserMutationTableName,
    undefined,
    SemanticOperationExactReceipt<BrowserMutationTableName, SemanticOperationExactPlan | undefined>
  >
  readonly exactPlan?: SemanticOperationExactPlan
  readonly replayPlan?: SemanticOperationReplayPlan
  readonly generationReadSet?: GenerationReadSetTransactionPlan
  readonly assertScope: (scope: MutationScope) => void
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
  extensionAccess?: BrowserMutationTransactionAccess,
): BrowserMutationTransactionPlan {
  const plan = mutationInfrastructurePlan(scopes, options, extensionAccess)
  return {
    transaction: physicalTransactionPlan(plan.transaction),
    ...(plan.generationReadSet ? { generationReadSet: plan.generationReadSet } : {}),
  }
}

export function planMutationSemanticOperation(
  command: WorkspaceCommand,
  scopes: readonly MutationScope[],
  options?: WorkspaceMutationOptions,
  extensionAccess?: BrowserMutationTransactionAccess,
  extensionReceipt?: {
    readonly exactOccurrence: true
    readonly replay: SemanticOperationReplayPlan
  },
): BrowserMutationSemanticOperationPlan {
  const storageProfile =
    command.kind === 'draft.put'
      ? 'draft-reference-update'
      : command.kind === 'attachment.ref.add' ||
          command.kind === 'attachment.ref.detach' ||
          command.kind === 'attachment.ref.relink' ||
          command.kind === 'attachment.ref.set-visibility'
        ? 'attachment-reference-update'
        : command.kind === 'attachment.bytes.delete' || command.kind === 'attachment.bundle.write'
          ? 'attachment-payload'
          : 'complete'
  const plan = mutationInfrastructurePlan(scopes, options, extensionAccess, storageProfile)
  const fixedReceiptPolicy = scopeDerivedMutationReceiptPolicy(command, options)
  if (fixedReceiptPolicy && extensionReceipt) {
    throw new Error(`MutationReceiptCapabilityDuplicated:${command.kind}`)
  }
  const receiptPolicy =
    fixedReceiptPolicy ??
    (extensionReceipt
      ? {
          exactOccurrence: extensionReceipt.exactOccurrence,
          replayPlan: extensionReceipt.replay,
        }
      : undefined)
  const exactPlan = receiptPolicy?.exactPlan
  const replayPlan = receiptPolicy?.replayPlan
  const replayContract = receiptPolicy?.replayReason
    ? semanticOperationCallerSingleAttemptReplayContract<
        undefined,
        SemanticOperationExactReceipt<
          BrowserMutationTableName,
          SemanticOperationExactPlan | undefined
        >
      >(receiptPolicy.replayReason)
    : replayPlan
      ? semanticOperationExactReceiptReplayContract<undefined, BrowserMutationTableName>(
          () => replayPlan,
        )
      : exactPlan
        ? semanticOperationExactReceiptReplayContract<undefined, BrowserMutationTableName>(
            () => exactPlan.replay,
          )
        : undefined
  return {
    descriptor: semanticOperationDescriptor({
      operationKind: command.kind,
      transaction: plan.transaction,
      resources: () => plan.resourceNames,
      permittedWrites: plan.permittedWrites,
      requiredWritesWhenMutated: [],
      effects: {
        kind: 'effect-kinds',
        permitted: plan.permittedEffects,
        requiredWhenMutated: (tableNames) => plan.requiredEffects(tableNames),
      },
      ...(receiptPolicy
        ? semanticOperationExactMutationAndInvalidationReceiptContracts<
            undefined,
            BrowserMutationTableName,
            SemanticOperationExactPlan | undefined
          >()
        : semanticOperationExactMutationReceiptContracts<
            undefined,
            BrowserMutationTableName,
            SemanticOperationExactPlan | undefined
          >()),
      ...(receiptPolicy?.exactOccurrence || receiptPolicy?.exactPlan
        ? {
            exactPhysicalReads: semanticOperationExactReceiptPhysicalReadContract<
              undefined,
              BrowserMutationTableName,
              SemanticOperationExactPlan | undefined
            >(),
          }
        : {}),
      ...(replayContract ? { replay: replayContract } : {}),
    }),
    ...(receiptPolicy?.exactPlan ? { exactPlan: receiptPolicy.exactPlan } : {}),
    ...(receiptPolicy?.replayPlan ? { replayPlan: receiptPolicy.replayPlan } : {}),
    ...(plan.generationReadSet ? { generationReadSet: plan.generationReadSet } : {}),
    assertScope: plan.assertScope,
  }
}

function scopeDerivedMutationReceiptPolicy(
  command: WorkspaceCommand,
  options: WorkspaceMutationOptions | undefined,
):
  | {
      readonly exactOccurrence?: true
      readonly replayReason?: 'random-identity' | 'unfenced-relative-update' | 'non-replayable'
      readonly replayPlan?: SemanticOperationReplayPlan
      readonly exactPlan?: SemanticOperationExactPlan
    }
  | undefined {
  switch (command.kind) {
    case 'chat.materialize-temporary':
      if (!options?.initialChat || options.initialChat.id !== command.input.chatId) {
        throw new Error(`TemporaryChatInitialRowMissing:${command.input.chatId}`)
      }
      return {
        replayReason: 'random-identity',
        exactPlan: materializeTemporaryChatExactPlan(options.initialChat),
      }
    case 'message.toggle-reasoning-detail':
    case 'message.toggle-provider-output-item':
    case 'message.toggle-context':
    case 'message.dismiss-generation-notice': {
      const capability = messageBodyMutationCapability(command)
      return {
        replayReason: capability.replayReason,
        exactPlan: semanticOperationExactPlan({
          replay: { kind: 'single-attempt', reason: capability.replayReason },
          bounds: {
            reads: {
              maxRequests: 5,
              maxRows: 5,
              maxBatchRows: 1,
              maxBytes: Number.MAX_SAFE_INTEGER,
            },
            writes: {
              maxRequests: 3,
              maxRows: 3,
              maxBatchRows: 1,
              maxBytes: Number.MAX_SAFE_INTEGER,
            },
          },
        }),
      }
    }
    case 'attempt.prepare':
      return {
        replayReason: 'random-identity',
      }
    case 'draft.put':
      return {
        exactOccurrence: true,
        replayReason: 'unfenced-relative-update',
      }
    case 'attachment.bytes.delete':
      return {
        exactOccurrence: true,
        replayReason: 'unfenced-relative-update',
      }
    case 'attachment.bundle.write':
      return {
        exactOccurrence: true,
        replayReason: 'unfenced-relative-update',
      }
    case 'attachment.delete-if-unreferenced':
      return {
        exactOccurrence: true,
        replayReason: 'unfenced-relative-update',
      }
    case 'attachment.delete-many':
      return {
        exactOccurrence: true,
        replayReason: 'non-replayable',
      }
    case 'attachment.ref.add':
      return {
        exactOccurrence: true,
        replayReason: 'random-identity',
      }
    case 'attachment.ref.detach':
    case 'attachment.ref.set-visibility':
      return {
        exactOccurrence: true,
        replayReason: 'unfenced-relative-update',
      }
    case 'attachment.ref.relink':
      return {
        exactOccurrence: true,
        replayReason: 'non-replayable',
      }
    case 'message.edit-body':
      return {
        exactOccurrence: true,
        replayReason: 'unfenced-relative-update',
      }
    case 'message.import':
      return {
        exactOccurrence: true,
        replayReason: 'random-identity',
      }
    case 'message.delete':
    case 'message.restore-structure':
      return {
        exactOccurrence: true,
        replayReason: 'non-replayable',
      }
    case 'generated-output.localization-claim':
      return {
        exactOccurrence: true,
        replayReason: 'random-identity',
      }
    case 'generated-output.localization-complete':
    case 'generated-output.localization-fail':
    case 'generated-output.localization-retry':
      return {
        exactOccurrence: true,
        replayReason: 'unfenced-relative-update',
      }
    case 'generated-output.video-expand':
      return {
        exactOccurrence: true,
        replayReason: 'non-replayable',
      }
    case 'attempt.finalize':
      return {
        replayPlan: attemptFinalizeReplayPlan(command.input),
      }
    case 'attempt.dispatch':
      return {
        exactPlan: attemptDispatchExactPlan(command.input),
      }
    case 'attachment.reap':
    case 'attempt.request-stop':
    case 'attempt.seal-terminal':
    case 'chat.calibration.clear':
    case 'chat.calibration.clear-all':
    case 'chat.calibration.clear-family':
    case 'chat.delete-archived':
    case 'chat.discard-empty-drafts':
    case 'chat.empty-archive':
    case 'chat.fork':
    case 'chat.move-to-folder':
    case 'chat.set-archived':
    case 'chat.set-manual-title':
    case 'chat.set-tags-from-names':
    case 'chat.touch-viewed':
    case 'configuration.execute':
    case 'discovery.endpoints.put':
    case 'discovery.models.delete':
    case 'discovery.models.put':
    case 'discovery.privacy.put':
    case 'folder.create':
    case 'folder.delete':
    case 'folder.ensure-and-move-chats':
    case 'folder.update':
    case 'generation.post-commit-metadata':
    case 'interchange.import-chat':
    case 'interchange.import-chat-preset':
    case 'interchange.import-connection-profile':
    case 'maintenance.prune-discovery-cache':
    case 'maintenance.prune-empty-draft-chats':
    case 'maintenance.prune-terminal-stream-journals':
    case 'maintenance.reconcile-attachment-integrity':
    case 'maintenance.reconcile-stream-journal-integrity':
    case 'stream.append-journal-frames':
    case 'stream.claim-recovery':
    case 'stream.finish-cleanup':
    case 'stream.handoff-recovery':
    case 'stream.note-selected-key':
    case 'stream.renew':
      return undefined
    default:
      return assertNever(command)
  }
}

function materializeTemporaryChatExactPlan(
  initialChat: NonNullable<WorkspaceMutationOptions['initialChat']>,
): SemanticOperationExactPlan {
  const links = configurationLinksForChat(initialChat)
  const profileLinks = links.filter((link) => link.targetKind === 'profile').length
  if (profileLinks > 1) throw new Error('TemporaryChatProfileLinkAmbiguous')
  return semanticOperationExactPlan({
    replay: { kind: 'single-attempt', reason: 'random-identity' },
    bounds: {
      reads: {
        maxRequests: 6 + 2 * profileLinks,
        maxRows: 6 + 2 * profileLinks,
        maxBatchRows: 1,
        maxBytes: Number.MAX_SAFE_INTEGER,
      },
      writes: {
        maxRequests: 3 + (links.length > 0 ? 1 : 0) + 2 * profileLinks,
        maxRows: 3 + links.length + 2 * profileLinks,
        maxBatchRows: Math.max(1, links.length),
        maxBytes: Number.MAX_SAFE_INTEGER,
      },
    },
  })
}

function attemptDispatchReplayPlan(input: AttemptDispatchInput): SemanticOperationReplayPlan {
  return {
    kind: 'fenced-convergent',
    owner: `stream:${input.streamId}`,
    fence: [
      input.fence.ownerClientId,
      input.fence.fenceToken,
      input.fence.replacementEpoch,
      input.fence.admissionSequence,
    ],
    desired: [
      'dispatch',
      input.target.messageId,
      input.target.attemptKind,
      stableStringify({
        readSet: input.readSet,
        generation: input.generation,
        dispatchedAt: input.dispatchedAt,
        postCommitCalibration: input.postCommitCalibration ?? null,
        continuation: input.continuation ?? null,
      }),
    ],
    alreadyApplied: 'return-current-or-conflict',
  }
}

function attemptFinalizeReplayPlan(input: AttemptTerminalProjection): SemanticOperationReplayPlan {
  return {
    kind: 'fenced-convergent',
    owner: `stream:${input.streamId}`,
    fence: [
      input.fence.ownerClientId,
      input.fence.fenceToken,
      input.fence.replacementEpoch,
      input.fence.admissionSequence,
    ],
    desired: [
      'finalize',
      input.chatId,
      input.messageId,
      input.kind,
      input.terminal.finishedAt,
      stableStringify(input.terminal.decision),
      stableStringify(input.postCommit),
    ],
    alreadyApplied: 'return-current-or-conflict',
  }
}

function attemptDispatchExactPlan(input: AttemptDispatchInput): SemanticOperationExactPlan {
  const messageRows = input.readSet.messages.length
  const attachmentRows = input.readSet.attachments.length
  const continuation = input.target.attemptKind === 'continuation'
  return semanticOperationExactPlan({
    replay: attemptDispatchReplayPlan(input),
    bounds: {
      reads: {
        maxRequests: continuation ? 5 : 6,
        maxRows: messageRows + attachmentRows + (continuation ? 3 : 4),
        maxBatchRows: Math.max(1, messageRows, attachmentRows),
        maxBytes: Number.MAX_SAFE_INTEGER,
      },
      writes: {
        maxRequests: continuation ? 1 : 2,
        maxRows: continuation ? 1 : 2,
        maxBatchRows: 1,
        maxBytes: Number.MAX_SAFE_INTEGER,
      },
    },
  })
}

interface MutationInfrastructurePlan {
  readonly transaction: PhysicalTransactionCapability<BrowserMutationTableName>
  readonly permittedWrites: readonly BrowserMutationTableName[]
  readonly resourceNames: readonly string[]
  readonly permittedEffects: readonly SemanticOperationEffectKind[]
  readonly requiredEffects: (
    tableNames: ReadonlySet<string>,
  ) => readonly SemanticOperationEffectKind[]
  readonly generationReadSet?: GenerationReadSetTransactionPlan
  readonly assertScope: (scope: MutationScope) => void
}

type MutationScopeStorageProfile =
  | 'complete'
  | 'draft-reference-update'
  | 'attachment-reference-update'
  | 'attachment-payload'

function mutationInfrastructurePlan(
  scopes: readonly MutationScope[],
  options: WorkspaceMutationOptions | undefined,
  extensionAccess: BrowserMutationTransactionAccess | undefined,
  storageProfile: MutationScopeStorageProfile = 'complete',
): MutationInfrastructurePlan {
  const builder = new MutationInfrastructureBuilder()
  const compiledScopes = compileMutationScopes(builder, scopes, storageProfile)
  const generationReadSet = options?.generationReadSet
    ? planGenerationReadSetTransaction(options.generationReadSet)
    : undefined
  if (options?.initialChat) {
    addChatCapabilityTables(builder, CHAT_ROW_LINKED_TRANSACTION_CAPABILITY, 'write')
    builder.requireWhenTableMutates(
      'chats',
      'message-header',
      'message-body',
      'message-preview',
      'child-slot',
    )
  }
  if (options?.promoteChatId) {
    addChatCapabilityTables(builder, CHAT_ROW_PRESERVING_LINKS_TRANSACTION_CAPABILITY, 'write')
  }
  if (options?.requiredProfileId) builder.addReadTable('profiles')
  if (options?.captureGenerationPlanningSnapshot) {
    builder.addReadTables(
      'discoveryPayloadMetadata',
      'discoveryPayloads',
      'endpoints',
      'models',
      'keys',
      'profiles',
      'privacyPolicies',
      'settings',
      'textTemplates',
    )
  }
  if (options?.maintainConfigurationLinksForChatId) addConfigurationLinkMutationTables(builder)
  if (generationReadSet) {
    builder.addReadTable('messages')
    if (generationReadSet.kind === 'messages-and-attachments') {
      builder.addReadTable('attachments')
    }
  }
  if (options?.streamFence) builder.addReadTable('streamLeases')
  if (options?.streamTargetCommit || options?.streamCanonicalCommit || options?.streamAdmission) {
    builder.addMutationTable('streamLeases', 'stream-lease')
  }
  if (options?.streamAdmission) {
    builder.addReadTables('chats', 'messages')
    builder.addMutationTable('settings', 'setting')
  }
  if ((options?.settingReadKeys?.length ?? 0) > 0) builder.addReadTable('settings')
  if (options?.streamTargetCommit || options?.streamCanonicalCommit) {
    builder.addReadTable('messages')
  }
  builder.addReadTables(...(extensionAccess?.readTableNames ?? []))
  builder.addMutationTables(extensionAccess?.writeTableNames ?? [])
  if ((options?.storageMaintenanceTasks?.length ?? 0) > 0) {
    builder.permitEffect('storage-maintenance')
  }
  const tableNames = MUTATION_TABLE_ORDER.filter((name) => builder.hasTable(name))
  const permittedWrites = MUTATION_TABLE_ORDER.filter((name) => builder.canWriteTable(name))
  const streamIds = [
    options?.streamFence?.streamId,
    options?.streamTargetCommit?.streamId,
    options?.streamCanonicalCommit?.streamId,
  ].filter((streamId): streamId is string => streamId !== undefined)
  const contentIdentity = options?.attachmentContentIdentity
  const initialChat = options?.initialChat
  const resourceNames = [
    ...new Set([
      ...compiledScopes.resourceNames,
      ...(initialChat
        ? ['chat-catalog', ...chatConfigurationTargetResourceNames(initialChat)]
        : []),
      ...(initialChat?.folderId ? [`folder:${initialChat.folderId}`] : []),
      ...(initialChat && initialChat.tags.length > 0 ? ['tag-catalog'] : []),
      ...(options?.maintainConfigurationLinksForChatId
        ? [`configuration-owner:chat:${options.maintainConfigurationLinksForChatId}`]
        : []),
      ...(options?.settingReadKeys ?? []).map((key) => `setting:${key}`),
      ...streamIds.map((streamId) => `stream-journal:${streamId}`),
      ...(contentIdentity
        ? [
            contentIdentity.contentHash
              ? `attachment-content:${contentIdentity.contentHash}:${contentIdentity.filename}`
              : `attachment-id:${contentIdentity.attachmentId}`,
          ]
        : []),
    ]),
  ]
  return {
    transaction: physicalStorageTables(...tableNames),
    permittedWrites,
    resourceNames,
    permittedEffects: builder.permittedEffectKinds(),
    requiredEffects: (mutatedTableNames) => builder.requiredEffectKinds(mutatedTableNames),
    ...(generationReadSet ? { generationReadSet } : {}),
    assertScope: compiledScopes.assertScope,
  }
}

function addConfigurationLinkMutationTables(builder: MutationInfrastructureBuilder): void {
  for (const tableName of CONFIGURATION_LINK_MUTATION_TRANSACTION_CAPABILITY.tableNames) {
    if (tableName === 'configurationLinks') {
      builder.addMutationTable(tableName)
      continue
    }
    builder.addMutationTable(tableName, 'profile')
  }
}

function addChatCapabilityTables<Tables extends BrowserMutationTableName>(
  builder: MutationInfrastructureBuilder,
  capability: PhysicalTransactionCapability<Tables>,
  access: 'read' | 'write',
): void {
  for (const tableName of capability.tableNames) {
    if (access === 'read') {
      builder.addReadTable(tableName)
      continue
    }
    if (tableName === 'chats') {
      builder.addMutationTable(tableName, 'chat')
    } else if (tableName === 'chatSidebarAggregates' || tableName === 'chatSidebarRows') {
      builder.addMutationTable(tableName, 'sidebar')
    } else if (tableName === 'configurationLinks') {
      builder.addMutationTable(tableName)
    } else if (
      tableName === 'configurationCatalogAggregates' ||
      tableName === 'configurationProfileUsageRows'
    ) {
      builder.addMutationTable(tableName, 'profile')
    } else {
      builder.addReadTable(tableName)
    }
  }
}

function compileMutationScopes(
  builder: MutationInfrastructureBuilder,
  scopes: readonly MutationScope[],
  storageProfile: MutationScopeStorageProfile = 'complete',
): {
  readonly resourceNames: readonly string[]
  readonly assertScope: (scope: MutationScope) => void
} {
  const allowed = new Set<string>()
  const broadTopologyChats = new Set<ChatId>()
  const resourceNames = new Set<string>()
  for (const scope of scopes) {
    const scopeName = scopeResourceName(scope)
    allowed.add(scopeName)
    if (scope.kind !== 'message' || scope.access !== 'create') resourceNames.add(scopeName)
    switch (scope.kind) {
      case 'attachment':
        builder.addMutationTables(
          ['attachmentCatalogAggregate', 'attachmentCatalogRows'],
          'attachment',
        )
        if (
          storageProfile !== 'draft-reference-update' &&
          storageProfile !== 'attachment-reference-update'
        ) {
          builder.addMutationTables(['attachmentArtifacts', 'attachmentBlobs'], 'attachment')
          builder.addMutationTable('attachmentJobs', 'attachment-job')
        }
        if (storageProfile !== 'attachment-payload') {
          builder.addMutationTable('attachmentRefEdges', 'attachment')
        }
        builder.addMutationTable('attachments', 'attachment')
        break
      case 'chat-meta':
        addChatCapabilityTables(builder, CHAT_ROW_PRESERVING_LINKS_TRANSACTION_CAPABILITY, 'write')
        break
      case 'chat-topology':
        broadTopologyChats.add(scope.chatId)
        addChatCapabilityTables(builder, CHAT_ROW_PRESERVING_LINKS_TRANSACTION_CAPABILITY, 'read')
        builder.addReadTables('messages', 'messageBodies')
        builder.addMutationTables(['childLists', 'childSlotMembers'], 'child-slot')
        break
      case 'children':
        addChatCapabilityTables(builder, CHAT_ROW_PRESERVING_LINKS_TRANSACTION_CAPABILITY, 'read')
        builder.addReadTables('messages', 'messageBodies')
        builder.addMutationTables(['childLists', 'childSlotMembers'], 'child-slot')
        resourceNames.add(`message-topology:${scope.chatId}`)
        break
      case 'draft':
        if (storageProfile === 'complete') {
          addChatCapabilityTables(builder, CHAT_ROW_PRESERVING_LINKS_TRANSACTION_CAPABILITY, 'read')
        }
        builder.addMutationTable('drafts', 'draft')
        break
      case 'message':
        if (storageProfile === 'attachment-reference-update') {
          builder.addReadTable('chats')
          builder.addMutationTable('messages', 'message-header')
          break
        }
        if (scope.access === 'presentation') {
          builder.addReadTable('chats')
        } else {
          addChatCapabilityTables(
            builder,
            CHAT_ROW_PRESERVING_LINKS_TRANSACTION_CAPABILITY,
            'write',
          )
        }
        builder.addMutationTable('messages', 'message-header')
        builder.addMutationTable('messageBodies', 'message-body')
        builder.addMutationTable('messagePreviews', 'message-preview')
        builder.addReadTable('streamLeases')
        break
    }
  }
  return {
    resourceNames: Object.freeze([...resourceNames]),
    assertScope(scope) {
      if (scope.kind === 'children' && broadTopologyChats.has(scope.chatId)) return
      const key = scopeResourceName(scope)
      if (!allowed.has(key)) throw new Error(`UndeclaredScope:${key}`)
    },
  }
}

class MutationInfrastructureBuilder {
  private readonly tableNames = new Set<BrowserMutationTableName>()
  private readonly writableTableNames = new Set<BrowserMutationTableName>()
  private readonly effectsByTable = new Map<
    BrowserMutationTableName,
    Set<SemanticOperationEffectKind>
  >()
  private readonly permittedEffects = new Set<SemanticOperationEffectKind>()

  addReadTable(tableName: BrowserMutationTableName): void {
    this.tableNames.add(tableName)
  }

  addReadTables(...tableNames: readonly BrowserMutationTableName[]): void {
    for (const tableName of tableNames) this.addReadTable(tableName)
  }

  addMutationTable(
    tableName: BrowserMutationTableName,
    ...effectKinds: readonly SemanticOperationEffectKind[]
  ): void {
    this.tableNames.add(tableName)
    this.writableTableNames.add(tableName)
    this.requireWhenTableMutates(tableName, ...effectKinds)
  }

  addMutationTables(
    tableNames: readonly BrowserMutationTableName[],
    ...effectKinds: readonly SemanticOperationEffectKind[]
  ): void {
    for (const tableName of tableNames) this.addMutationTable(tableName, ...effectKinds)
  }

  requireWhenTableMutates(
    tableName: BrowserMutationTableName,
    ...effectKinds: readonly SemanticOperationEffectKind[]
  ): void {
    let effects = this.effectsByTable.get(tableName)
    if (!effects) {
      effects = new Set()
      this.effectsByTable.set(tableName, effects)
    }
    for (const kind of effectKinds) {
      effects.add(kind)
      this.permittedEffects.add(kind)
    }
  }

  hasTable(tableName: BrowserMutationTableName): boolean {
    return this.tableNames.has(tableName)
  }

  canWriteTable(tableName: BrowserMutationTableName): boolean {
    return this.writableTableNames.has(tableName)
  }

  permitEffect(kind: SemanticOperationEffectKind): void {
    this.permittedEffects.add(kind)
  }

  permittedEffectKinds(): readonly SemanticOperationEffectKind[] {
    return Object.freeze([...this.permittedEffects].sort())
  }

  requiredEffectKinds(
    mutatedTableNames: ReadonlySet<string>,
  ): readonly SemanticOperationEffectKind[] {
    const required = new Set<SemanticOperationEffectKind>()
    for (const tableName of mutatedTableNames) {
      const effects = this.effectsByTable.get(tableName as BrowserMutationTableName)
      if (!effects) continue
      for (const kind of effects) required.add(kind)
    }
    return Object.freeze([...required].sort())
  }
}

export async function validateGenerationReadSetTransaction(
  tx: Transaction,
  plan: GenerationReadSetTransactionPlan,
): Promise<
  readonly (SemanticOperationExactPhysicalRead & {
    readonly tableName: 'messages' | 'attachments'
  })[]
> {
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
  return [
    {
      tableName: 'messages',
      indexKind: 'primary',
      operation: 'get-many',
      requestCount: 1,
      rowCount: readSet.messages.length,
    },
    ...(plan.kind === 'messages-and-attachments'
      ? [
          {
            tableName: 'attachments' as const,
            indexKind: 'primary' as const,
            operation: 'get-many' as const,
            requestCount: 1,
            rowCount: readSet.attachments.length,
          },
        ]
      : []),
  ]
}

export function resolveMutationTableNames(
  scopes: readonly MutationScope[],
  options?: WorkspaceMutationOptions,
): readonly BrowserMutationTableName[] {
  return planMutationTransaction(scopes, options).transaction.tableNames
}

export function resolveMutationResourceNames(
  scopes: readonly MutationScope[],
  options?: WorkspaceMutationOptions,
): readonly string[] {
  return mutationInfrastructurePlan(scopes, options, undefined).resourceNames
}

export function createMutationScopeChecker(scopes: readonly MutationScope[]): {
  readonly assertScope: (scope: MutationScope) => void
} {
  return compileMutationScopes(new MutationInfrastructureBuilder(), scopes)
}
