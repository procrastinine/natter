import Dexie, { type Transaction } from 'dexie'
import { normalizeModelsResponse } from '../api/providers'
import { modelCatalogQueryForConnectionKind, modelsCacheKey } from '../core/cache-keys'
import {
  applyChatSettingsFieldPatches,
  applyLocalPromptValue,
  applySerializedChatSettingsPatch,
  normalizeChatSettings,
  promptPresetSlotForKind,
  sameChatSettings,
} from '../core/chat-metadata'
import {
  advanceRecentModelState,
  emptyRecentModelRecency,
  PINNED_MODELS_KEY,
  RECENT_MODEL_RECENCY_KEY,
  RECENT_MODELS_KEY,
  SAMPLE_PROMPTS_DISMISSED_KEY,
} from '../core/global-settings'
import { customImageOriginsFromStored, IMAGE_ALLOWLIST_KEY } from '../core/image-allowlist'
import { resolveModelIdFromCatalog } from '../core/model-selection'
import { withProfileApiDefaults } from '../core/provider-defaults'
import {
  normalizeRenderingPreferences,
  RENDERING_PREFERENCES_KEY,
} from '../core/rendering-preferences'
import {
  isStaticTextTemplateId,
  normalizeTextTemplateConfig,
  type SavedTextTemplate,
} from '../core/text-templates'
import type {
  Chat,
  ChatId,
  ChatPreset,
  ChatSettings,
  ConfigurationRequestRevision,
  ConnectionProfile,
  KeyId,
  KeyRecord,
  PresetId,
  ProfileId,
  PromptPreset,
  PromptPresetId,
  TextTemplateId,
} from '../core/types'
import {
  recordBrowserCommandInvalidation,
  recordBrowserCommandKeyRequestMaterialAffectedSet,
} from './browser-command-mutation-journal'
import type { BrowserCommandSessionPort } from './browser-domain-mutations'
import {
  addLinkedSemanticByteOwner,
  addSemanticByteOwner,
  addTextTemplateByteOwner,
  type ConfigurationOwnerLinkMutationReceipt,
  deleteLinkedSemanticByteOwner,
  deleteSemanticByteOwner,
  deleteTextTemplateByteOwner,
  deleteUserSettingByteOwner,
  emptyConfigurationOwnerLinkMutationReceipt,
  putSemanticByteOwner,
  putUserSettingByteOwner,
  putUserSettingByteOwners,
  replaceLinkedSemanticByteOwner,
  replaceLinkedSemanticByteOwnerBatch,
  replaceLinkedSemanticByteOwnerPreservingLinksBatch,
  replaceSemanticByteOwner,
  replaceTextTemplateByteOwner,
} from './byte-owner-mutation'
import {
  CHAT_ROW_LINKED_TRANSACTION_CAPABILITY,
  type LinkedChatMutationOwner,
  type LinkedChatRowMutationReceipt,
  openLinkedChatMutation,
} from './chat-row-transition'
import {
  applyConfigurationPresetCatalogProjectionDeletion,
  applyConfigurationPresetCatalogProjectionTransition,
  applyConfigurationProfileCatalogProjectionDeletion,
  applyConfigurationProfileCatalogProjectionTransition,
  applyConfigurationPromptPresetCatalogProjectionDeletion,
  applyConfigurationPromptPresetCatalogProjectionTransition,
  applyConfigurationPromptPresetRecencyCatalogProjectionTransition,
  CONFIGURATION_PRESET_CATALOG_TRANSACTION_CAPABILITY,
  CONFIGURATION_PROFILE_CATALOG_TRANSACTION_CAPABILITY,
  CONFIGURATION_PROMPT_PRESET_CATALOG_TRANSACTION_CAPABILITY,
  CONFIGURATION_PROMPT_PRESET_RECENCY_TRANSACTION_CAPABILITY,
  type ConfigurationCatalogProjectionMutationReceipt,
  type ConfigurationPresetCatalogMutationReceipt,
  readDefaultConfigurationProfileId,
} from './configuration-catalog-projection'
import {
  applyConnectionProfilePatch,
  type ConfigurationDomainCommand,
  type ConfigurationDomainHandlerMap,
  type ConfigurationDomainResult,
  type ConfigurationLink,
  configurationLinksForChat,
  configurationLinksForPreset,
  configurationLinksForProfile,
  configurationRequestRevisionFor,
  configurationRequestRevisionKey,
  configurationTargetKey,
  configurationTargetResourceNamesForLinks,
  sameConfigurationValue,
} from './configuration-domain-contract'
import {
  CONFIGURATION_LINK_MUTATION_TRANSACTION_CAPABILITY,
  CONFIGURATION_PROFILE_MANAGER_STATE_ID,
  type ConfigurationProfileUsageProjectionRow,
  configurationProfileUsageResourceNamesForLinks,
  emptyConfigurationProfileUsageProjectionRow,
} from './configuration-profile-usage-projection'
import type { CachedModelsStorageRow, SettingsRow } from './db-rows'
import {
  clearDiscoveryCacheProfileRows,
  DISCOVERY_CACHE_MUTATION_TRANSACTION_CAPABILITY,
  type DiscoveryCacheProfileClearReceipt,
  type DiscoveryCacheReadEvidence,
  readDiscoveryCacheRowWithEvidence,
} from './discovery-cache-storage'
import { exactCompoundPrefixBetween } from './indexeddb-key-ranges'
import {
  type CapabilityTables,
  type FencedTransaction,
  type PhysicalStorageTableName,
  type PhysicalTransactionCapability,
  physicalStorageTables,
} from './physical-storage-tables'
import {
  appendPresetOrderEntry,
  emptyPresetOrderMutationReceipt,
  movePresetOrderEntry,
  PRESET_ORDER_MUTATION_TRANSACTION_CAPABILITY,
  type PresetOrderMutationReceipt,
  removePresetOrderEntry,
} from './preset-order'
import {
  boundSemanticOperationExactReceiptAccumulator,
  configurationSemanticOperationKind,
  createSemanticOperationExactReceiptAccumulator,
  type SemanticOperationExactPhysicalRead,
  type SemanticOperationExactPlan,
  type SemanticOperationExactReceipt,
  type SemanticOperationExecution,
  type SemanticOperationReceiptFragment,
  semanticOperationDescriptor,
  semanticOperationExactPlan,
  semanticOperationExactReceipt,
  semanticOperationExactReceiptContracts,
  semanticOperationExactReceiptReplayContract,
  semanticOperationExactReceiptReplayProofContract,
  semanticOperationExecution,
  semanticOperationReceiptFragment,
} from './semantic-operation-capability'
import { TransactionChatUpdateClock } from './transaction-order'
import {
  normalizeWorkspaceDependencies,
  type WorkspaceDependency,
  workspaceDependenciesForConfigurationSemanticMutation,
} from './workspace-protocol'

type ConfigurationCommandMetaPort = BrowserCommandSessionPort

const CONFIGURATION_SETTING_TRANSACTION = physicalStorageTables('settings')
const CONFIGURATION_KEY_ENTITY_TRANSACTION = physicalStorageTables('keys')
const CONFIGURATION_KEY_MATERIAL_TRANSACTION = physicalStorageTables('keys')
const CONFIGURATION_TEXT_TEMPLATE_ENTITY_TRANSACTION = physicalStorageTables('textTemplates')
type ChatRowLinkedTable = CapabilityTables<typeof CHAT_ROW_LINKED_TRANSACTION_CAPABILITY>
const CONFIGURATION_MODELS_CACHE_READ_TRANSACTION = physicalStorageTables(
  'discoveryPayloadMetadata',
  'discoveryPayloads',
  'models',
)
const KEY_MATERIAL_OPERATION_RECEIPT = Symbol('KeyMaterialOperationReceipt')
const CHAT_CONFIGURATION_OPERATION_RECEIPT = Symbol('ChatConfigurationOperationReceipt')
const CATALOGED_CONFIGURATION_OPERATION_RECEIPT = Symbol('CatalogedConfigurationOperationReceipt')

interface KeyTouchOperationInput {
  readonly keyId: KeyId
}

interface KeyMaterialOperationInput {
  readonly keyId: KeyId
  readonly operationKind: 'key.put' | 'key.material-replace' | 'key.delete'
  readonly expectedMaterialRevision: number | null
  readonly materialRevision: number | null
}

interface KeyMaterialOperationReceipt {
  readonly [KEY_MATERIAL_OPERATION_RECEIPT]: true
  readonly previous: KeyRecord | undefined
  readonly next: KeyRecord | undefined
  readonly mutation: 'write' | 'delete' | 'none'
}

interface TextTemplateEntityOperationInput {
  readonly templateId: TextTemplateId
}

interface ChatConfigurationOperationInput {
  readonly chatId: ChatId
  readonly introducedTargetResources: readonly string[]
}

interface ChatConfigurationOperationReceipt {
  readonly [CHAT_CONFIGURATION_OPERATION_RECEIPT]: true
  readonly previous: Chat | undefined
  readonly next: Chat | undefined
  readonly mutation: 'write' | 'none'
  readonly transition: LinkedChatRowMutationReceipt | undefined
}

type ChatRequestTargetOperationKind = 'chat.switch-profile' | 'chat.resolve-model'

interface ChatRequestTargetOperationInput {
  readonly operationKind: ChatRequestTargetOperationKind
  readonly chatId: ChatId
  readonly profileId: ProfileId
  readonly requestKeyId: KeyId | null
  readonly previousProfileId: ProfileId | null
  readonly previousModelResolutionTarget: ConfigurationRequestRevision | null
  readonly nextModelResolutionTarget: ConfigurationRequestRevision | null
  readonly readModelsCache: boolean
  readonly modelsHeaderKey: readonly [ProfileId, string] | null
}

interface ChatRequestTargetOperationReceipt {
  readonly operationKind: ChatRequestTargetOperationKind
  readonly chatId: ChatId
  readonly profileId: ProfileId
  readonly requestKeyId: KeyId | null
  readonly observedKey: KeyRecord | undefined
  readonly previousProfile: ConnectionProfile | undefined
  readonly nextProfile: ConnectionProfile | undefined
  readonly profileMutation: 'write' | 'none'
  readonly profileProjection: ConfigurationCatalogProjectionMutationReceipt | undefined
  readonly chat: ChatConfigurationOperationReceipt
  readonly modelsCacheRead: Omit<DiscoveryCacheReadEvidence<unknown>, 'row'> | undefined
  readonly modelsHeader: CachedModelsStorageRow | undefined
}

type ConfigurationTargetFanoutOperationKind =
  | 'prompt-preset.overwrite-and-pin'
  | 'prompt-preset.delete'
  | 'text-template.delete'

type ConfigurationTargetFanoutOperationCommand = Extract<
  ConfigurationDomainCommand,
  { kind: ConfigurationTargetFanoutOperationKind }
>

type ConfigurationTargetFanoutSource = PromptPreset | SavedTextTemplate

interface ConfigurationTargetFanoutOperationInput {
  readonly operationKind: ConfigurationTargetFanoutOperationKind
  readonly sourceKind: 'prompt-preset' | 'text-template'
  readonly sourceId: string
  readonly selectedChatId: ChatId | null
}

interface ConfigurationTargetFanoutOperationReceipt {
  readonly operationKind: ConfigurationTargetFanoutOperationKind
  readonly sourceKind: 'prompt-preset' | 'text-template'
  readonly sourceId: string
  readonly selectedChatId: ChatId | null
  readonly previousSource: ConfigurationTargetFanoutSource | undefined
  readonly nextSource: ConfigurationTargetFanoutSource | undefined
  readonly sourceMutation: 'write' | 'delete' | 'none'
  readonly sourceProjection: ConfigurationCatalogProjectionMutationReceipt | undefined
  readonly targetQueryExecuted: boolean
  readonly targetQueryRequests: number
  readonly targetLinkIds: readonly string[]
  readonly chatReadRequests: number
  readonly chatReadIds: readonly ChatId[]
  readonly presetReadRequests: number
  readonly presetReadIds: readonly PresetId[]
  readonly writtenPresetIds: readonly PresetId[]
  readonly writtenChatIds: readonly ChatId[]
  readonly targetFragment: SemanticOperationReceiptFragment<PhysicalStorageTableName>
}

type ConnectionProfileLifecycleOperationKind =
  | 'connection.create'
  | 'connection.edit'
  | 'connection.duplicate'

type ConnectionProfileLifecycleOperationCommand = Extract<
  ConfigurationDomainCommand,
  { kind: ConnectionProfileLifecycleOperationKind }
>

interface ConnectionProfileLifecycleOperationInput {
  readonly operationKind: ConnectionProfileLifecycleOperationKind
  readonly profileId: ProfileId
  readonly sourceProfileId: ProfileId | null
  readonly keyIdToValidate: KeyId | null
  readonly initialPresetId: PresetId | null
  readonly resetChatId: ChatId | null
  readonly requestMaterialMayChange: boolean
  readonly resourceNames: readonly string[]
}

interface ConnectionProfileLifecycleOperationReceipt {
  readonly operationKind: ConnectionProfileLifecycleOperationKind
  readonly profileId: ProfileId
  readonly sourceProfileId: ProfileId | null
  readonly sourceProfile: ConnectionProfile | undefined
  readonly previousProfile: ConnectionProfile | undefined
  readonly nextProfile: ConnectionProfile | undefined
  readonly profileMutation: 'write' | 'none'
  readonly profileLinks: ConfigurationOwnerLinkMutationReceipt
  readonly profileProjection: ConfigurationCatalogProjectionMutationReceipt | undefined
  readonly key: KeyMaterialOperationReceipt | undefined
  readonly initialPreset: PresetLifecycleOperationReceipt | undefined
  readonly resetChat: ChatConfigurationOperationReceipt
  readonly discovery: DiscoveryCacheProfileClearReceipt | undefined
  readonly fallbackProfileId: ProfileId | null | undefined
}

interface ConnectionDeleteKeyReceipt {
  readonly keyId: KeyId
  readonly targetQueryExecuted: boolean
  readonly remainingProfileIds: readonly ProfileId[]
  readonly previous: KeyRecord | undefined
  readonly deleted: boolean
}

interface ConnectionDeleteOperationInput {
  readonly profileId: ProfileId
  readonly replacementProfileId: ProfileId | null
  readonly resourceNames: readonly string[]
}

interface ConnectionDeleteOperationReceipt {
  readonly operationKind: 'connection.delete'
  readonly profileId: ProfileId
  readonly replacementProfileId: ProfileId | null
  readonly sourceQueryExecuted: boolean
  readonly previousProfile: ConnectionProfile | undefined
  readonly replacementProfile: ConnectionProfile | undefined
  readonly replacementQueryExecuted: boolean
  readonly usage: ConfigurationProfileUsageProjectionRow
  readonly targetQueryExecuted: boolean
  readonly targetQueryRequests: number
  readonly targetLinkIds: readonly string[]
  readonly presetReadRequests: number
  readonly presetReadIds: readonly PresetId[]
  readonly chatReadRequests: number
  readonly chatReadIds: readonly ChatId[]
  readonly writtenPresetIds: readonly PresetId[]
  readonly writtenChatIds: readonly ChatId[]
  readonly targetFragment: SemanticOperationReceiptFragment<PhysicalStorageTableName>
  readonly profileLinks: ConfigurationOwnerLinkMutationReceipt
  readonly profileCatalog: ConfigurationCatalogProjectionMutationReceipt | undefined
  readonly discovery: DiscoveryCacheProfileClearReceipt | undefined
  readonly keys: readonly ConnectionDeleteKeyReceipt[]
  readonly fallbackProfileId: ProfileId | null | undefined
}

type ChatSelectionOperationKind =
  | 'text-template.create-and-select'
  | 'chat-preset.apply'
  | 'prompt-preset.load-and-pin'
  | 'prompt-preset.create-and-pin'

type ChatSelectionSourceTable = 'textTemplates' | 'presets' | 'promptPresets'
type ChatSelectionSourceRow = SavedTextTemplate | ChatPreset | PromptPreset

interface ChatSelectionOperationInput {
  readonly chatId: ChatId
  readonly sourceId: string
  readonly resourceNames: readonly string[]
}

interface ChatSelectionOperationReceipt {
  readonly operationKind: ChatSelectionOperationKind
  readonly chatId: ChatId
  readonly sourceId: string
  readonly sourceTable: ChatSelectionSourceTable
  readonly previousSource: ChatSelectionSourceRow | undefined
  readonly nextSource: ChatSelectionSourceRow | undefined
  readonly sourceMutation: 'write' | 'none'
  readonly projection: ConfigurationCatalogProjectionMutationReceipt | undefined
  readonly chat: ChatConfigurationOperationReceipt
}

type CatalogedConfigurationOperationKind = 'connection.touch' | 'prompt-preset.rename'

type CatalogedConfigurationEntityKind = 'profile' | 'preset' | 'prompt-preset'

interface CatalogedConfigurationOperationInput {
  readonly entityKind: CatalogedConfigurationEntityKind
  readonly entityId: string
}

interface CatalogedConfigurationOperationReceipt {
  readonly [CATALOGED_CONFIGURATION_OPERATION_RECEIPT]: true
  readonly entityKind: CatalogedConfigurationEntityKind
  readonly previous: CatalogedConfigurationEntityRow | undefined
  readonly next: CatalogedConfigurationEntityRow | undefined
  readonly entityMutation: 'write' | 'none'
  readonly projection: ConfigurationCatalogProjectionMutationReceipt | undefined
}

type CatalogedConfigurationEntityRow = ConnectionProfile | ChatPreset | PromptPreset

interface CatalogedConfigurationTransition<Row, Result> {
  readonly next: Row | undefined
  readonly result: Result
}

interface PresetOrderMoveOperationInput {
  readonly presetId: PresetId
  readonly afterPresetId: PresetId | null
}

type PresetLifecycleOperationKind =
  | 'chat-preset.create'
  | 'chat-preset.create-and-link'
  | 'chat-preset.delete'
  | 'chat-preset.update'
  | 'chat-preset.duplicate'
  | 'chat-preset.set-archived'
  | 'chat-preset.save'

interface PresetLifecycleOperationInput {
  readonly presetId: PresetId
  readonly chatId?: ChatId
  readonly resourceNames: readonly string[]
}

interface PresetLifecycleOperationReceipt {
  readonly operationKind: PresetLifecycleOperationKind
  readonly presetId: PresetId
  readonly previous: ChatPreset | undefined
  readonly next: ChatPreset | undefined
  readonly presetReadRequests: number
  readonly profileReadRequests: number
  readonly links: ConfigurationOwnerLinkMutationReceipt
  readonly catalog: ConfigurationPresetCatalogMutationReceipt | undefined
  readonly order: PresetOrderMutationReceipt
  readonly chat: ChatConfigurationOperationReceipt
  readonly targetQueryExecuted: boolean
  readonly targetLinkIds: readonly string[]
  readonly chatReadIds: readonly ChatId[]
  readonly writtenChatIds: readonly ChatId[]
  readonly chats: LinkedChatRowMutationReceipt | undefined
}

function presetLifecycleOperationDescriptor(operationKind: PresetLifecycleOperationKind) {
  const transaction = presetLifecycleTransaction(operationKind)
  return semanticOperationDescriptor<
    ReturnType<typeof configurationSemanticOperationKind>,
    PhysicalTransactionCapability,
    PresetLifecycleOperationInput,
    SemanticOperationExactReceipt<PhysicalStorageTableName>
  >({
    operationKind: configurationSemanticOperationKind(operationKind),
    transaction,
    resources: ({ resourceNames }) => resourceNames,
    permittedWrites: transaction.tableNames,
    requiredWritesWhenMutated: ['presets'],
    ...semanticOperationExactReceiptContracts<
      PresetLifecycleOperationInput,
      PhysicalStorageTableName
    >(),
    replay: semanticOperationExactReceiptReplayProofContract<PresetLifecycleOperationInput>(
      assertConfigurationSingleAttemptReplayProof,
    ),
  })
}

function presetLifecycleOperationExactPlan(
  operationKind: PresetLifecycleOperationKind,
): SemanticOperationExactPlan {
  const unboundedFanout = operationKind === 'chat-preset.delete'
  return semanticOperationExactPlan({
    replay: { kind: 'single-attempt', reason: 'unfenced-relative-update' },
    bounds: {
      reads: {
        maxRequests: unboundedFanout ? Number.MAX_SAFE_INTEGER : 64,
        maxRows: unboundedFanout ? Number.MAX_SAFE_INTEGER : 512,
        maxBatchRows: unboundedFanout ? Number.MAX_SAFE_INTEGER : 256,
        maxBytes: Number.MAX_SAFE_INTEGER,
      },
      writes: {
        maxRequests: unboundedFanout ? Number.MAX_SAFE_INTEGER : 512,
        maxRows: unboundedFanout ? Number.MAX_SAFE_INTEGER : 512,
        maxBatchRows: unboundedFanout ? Number.MAX_SAFE_INTEGER : 9,
        maxBytes: Number.MAX_SAFE_INTEGER,
      },
    },
  })
}

function presetLifecycleOperationDependencies(
  input: PresetLifecycleOperationInput,
  receipt: PresetLifecycleOperationReceipt,
): readonly WorkspaceDependency[] {
  const presetChanged = receipt.next !== receipt.previous
  const profileIds = [
    ...new Set(receipt.links.profileUsageMutations.map(({ profileId }) => profileId)),
  ].sort()
  return normalizeWorkspaceDependencies([
    ...(presetChanged
      ? workspaceDependenciesForConfigurationSemanticMutation({
          kind: 'preset',
          previous: receipt.previous,
          next: receipt.next,
        })
      : []),
    ...(profileIds.length > 0
      ? [
          {
            kind: 'profile' as const,
            profileIds,
            facets: ['dependent-counts' as const],
          },
        ]
      : []),
    ...(receipt.order.changed
      ? [
          {
            kind: 'preset' as const,
            presetIds: [input.presetId],
            facets: ['catalog-order' as const],
          },
        ]
      : []),
    ...(input.chatId
      ? linkedChatTransitionDependencies(input.chatId, receipt.chat.transition)
      : []),
    ...linkedChatTransitionsDependencies(receipt.writtenChatIds, receipt.chats),
  ])
}

function presetLifecycleOperationPhysicalMutations(
  input: PresetLifecycleOperationInput,
  receipt: PresetLifecycleOperationReceipt,
) {
  const catalog = receipt.catalog
  return [
    ...(receipt.next !== receipt.previous
      ? receipt.next
        ? [
            {
              tableName: 'presets' as const,
              operation: 'write' as const,
              key: input.presetId,
            },
          ]
        : [
            {
              tableName: 'presets' as const,
              operation: 'delete' as const,
              key: input.presetId,
            },
          ]
      : []),
    ...receipt.links.removedLinkIds.map((key) => ({
      tableName: 'configurationLinks' as const,
      operation: 'delete' as const,
      key,
    })),
    ...receipt.links.writtenLinkIds.map((key) => ({
      tableName: 'configurationLinks' as const,
      operation: 'write' as const,
      key,
    })),
    ...receipt.links.profileUsageMutations.map(({ profileId: key, operation }) => ({
      tableName: 'configurationProfileUsageRows' as const,
      operation,
      key,
    })),
    ...(receipt.links.profileManagerRevisionChanged
      ? [
          {
            tableName: 'configurationCatalogAggregates' as const,
            operation: 'write' as const,
            key: CONFIGURATION_PROFILE_MANAGER_STATE_ID,
          },
        ]
      : []),
    ...(catalog && catalog.projection.projectionMutation !== 'none'
      ? [
          {
            tableName: catalog.projection.projectionTable,
            operation: catalog.projection.projectionMutation,
            key: catalog.projection.projectionId,
          },
        ]
      : []),
    ...receipt.order.mutations,
    ...(catalog?.order.mutations ?? []),
    ...(input.chatId && receipt.chat.transition
      ? linkedChatTransitionPhysicalMutations(input.chatId, receipt.chat.transition)
      : []),
    ...(receipt.chats
      ? linkedChatTransitionsPhysicalMutations(receipt.writtenChatIds, receipt.chats)
      : []),
  ]
}

function presetLifecycleOperationPhysicalReads(
  input: PresetLifecycleOperationInput,
  receipt: PresetLifecycleOperationReceipt,
): readonly SemanticOperationExactPhysicalRead[] {
  return aggregateExactPhysicalReads([
    ...(receipt.presetReadRequests > 0
      ? [
          {
            tableName: 'presets' as const,
            indexKind: 'primary' as const,
            operation: 'get' as const,
            requestCount: receipt.presetReadRequests,
            rowCount: receipt.presetReadRequests,
          },
        ]
      : []),
    ...(receipt.profileReadRequests > 0
      ? [
          {
            tableName: 'profiles' as const,
            indexKind: 'primary' as const,
            operation: 'get' as const,
            requestCount: receipt.profileReadRequests,
            rowCount: receipt.profileReadRequests,
          },
        ]
      : []),
    ...(receipt.targetQueryExecuted
      ? [
          {
            tableName: 'configurationLinks' as const,
            indexKind: 'secondary' as const,
            indexName: 'targetKey',
            operation: 'query' as const,
            requestCount: 1,
            rowCount: receipt.targetLinkIds.length,
          },
        ]
      : []),
    ...(receipt.chatReadIds.length > 0
      ? [
          {
            tableName: 'chats' as const,
            indexKind: 'primary' as const,
            operation: 'get-many' as const,
            requestCount: 1,
            rowCount: receipt.chatReadIds.length,
          },
        ]
      : []),
    ...(receipt.links.ownerQueryRequests > 0
      ? [
          {
            tableName: 'configurationLinks' as const,
            indexKind: 'secondary' as const,
            indexName: 'ownerKey',
            operation: 'open-cursor' as const,
            requestCount: receipt.links.ownerQueryRequests,
            rowCount: receipt.links.ownerQueryRowCount,
          },
        ]
      : []),
    ...(receipt.links.profileUsageReadRequests > 0
      ? [
          {
            tableName: 'configurationProfileUsageRows' as const,
            indexKind: 'primary' as const,
            operation: 'get-many' as const,
            requestCount: receipt.links.profileUsageReadRequests,
            rowCount: receipt.links.profileUsageMutations.length,
          },
        ]
      : []),
    ...(receipt.links.profileManagerRevisionChanged
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
    ...receipt.order.reads.map((read) => ({ ...read, indexKind: 'primary' as const })),
    ...(receipt.catalog?.order.reads ?? []).map((read) => ({
      ...read,
      indexKind: 'primary' as const,
    })),
    ...(input.chatId
      ? [
          {
            tableName: 'chats' as const,
            indexKind: 'primary' as const,
            operation: 'get' as const,
            requestCount: 1,
            rowCount: 1,
          },
          ...linkedChatTransitionPhysicalReads(receipt.chat.transition),
        ]
      : []),
    ...linkedChatTransitionPhysicalReads(receipt.chats),
  ])
}

function presetLifecycleOperationExactReceipt(
  plan: SemanticOperationExactPlan,
  operationKind: PresetLifecycleOperationKind,
  input: PresetLifecycleOperationInput,
  receipt: PresetLifecycleOperationReceipt,
): SemanticOperationExactReceipt<PhysicalStorageTableName> {
  const didMutateStorage =
    receipt.next !== receipt.previous ||
    receipt.chat.mutation === 'write' ||
    receipt.writtenChatIds.length > 0
  assertPresetLifecycleOperationReceipt(operationKind, input, didMutateStorage, receipt)
  return semanticOperationExactReceipt(plan, {
    dependencies: didMutateStorage ? presetLifecycleOperationDependencies(input, receipt) : [],
    physicalMutations: didMutateStorage
      ? presetLifecycleOperationPhysicalMutations(input, receipt)
      : [],
    physicalReads: presetLifecycleOperationPhysicalReads(input, receipt),
  })
}

function presetLifecycleTransaction(
  operationKind: PresetLifecycleOperationKind,
): PhysicalTransactionCapability {
  if (operationKind === 'chat-preset.save') {
    return physicalStorageTables(
      ...CHAT_ROW_LINKED_TRANSACTION_CAPABILITY.tableNames,
      'presets',
      'profiles',
    )
  }
  if (operationKind === 'chat-preset.update') {
    return physicalStorageTables(
      ...CONFIGURATION_LINK_MUTATION_TRANSACTION_CAPABILITY.tableNames,
      ...CONFIGURATION_PRESET_CATALOG_TRANSACTION_CAPABILITY.tableNames,
      'presets',
      'profiles',
    )
  }
  if (operationKind === 'chat-preset.delete') {
    return physicalStorageTables(
      ...CHAT_ROW_LINKED_TRANSACTION_CAPABILITY.tableNames,
      ...CONFIGURATION_LINK_MUTATION_TRANSACTION_CAPABILITY.tableNames,
      ...CONFIGURATION_PRESET_CATALOG_TRANSACTION_CAPABILITY.tableNames,
      ...PRESET_ORDER_MUTATION_TRANSACTION_CAPABILITY.tableNames,
      'presets',
    )
  }
  return physicalStorageTables(
    ...(operationKind === 'chat-preset.create-and-link'
      ? CHAT_ROW_LINKED_TRANSACTION_CAPABILITY.tableNames
      : []),
    ...CONFIGURATION_LINK_MUTATION_TRANSACTION_CAPABILITY.tableNames,
    ...CONFIGURATION_PRESET_CATALOG_TRANSACTION_CAPABILITY.tableNames,
    ...PRESET_ORDER_MUTATION_TRANSACTION_CAPABILITY.tableNames,
    'presets',
    ...(operationKind === 'chat-preset.create' || operationKind === 'chat-preset.create-and-link'
      ? (['profiles'] as const)
      : []),
  )
}

function assertPresetLifecycleOperationReceipt(
  operationKind: PresetLifecycleOperationKind,
  input: PresetLifecycleOperationInput,
  didMutateStorage: boolean,
  receipt: PresetLifecycleOperationReceipt,
): void {
  const presetChanged = receipt.next !== receipt.previous
  const chatChanged = receipt.chat.mutation === 'write'
  const linkedChatsChanged = receipt.writtenChatIds.length > 0
  const catalogExpected = presetChanged && operationKind !== 'chat-preset.save'
  const removedTargetLinks = new Set(receipt.chats?.links.removedLinkIds ?? [])
  if (input.chatId) {
    assertChatConfigurationOperationReceipt(input.chatId, chatChanged, receipt.chat)
  }
  if (
    receipt.operationKind !== operationKind ||
    receipt.presetId !== input.presetId ||
    (receipt.previous !== undefined && receipt.previous.id !== input.presetId) ||
    (receipt.next !== undefined && receipt.next.id !== input.presetId) ||
    (presetChanged || chatChanged || linkedChatsChanged) !== didMutateStorage ||
    catalogExpected !== (receipt.catalog !== undefined) ||
    (!input.chatId &&
      (receipt.chat.previous !== undefined ||
        receipt.chat.next !== undefined ||
        receipt.chat.mutation !== 'none')) ||
    (receipt.catalog !== undefined &&
      (receipt.catalog.projection.projectionId !== input.presetId ||
        receipt.catalog.projection.projectionTable !== 'configurationPresetCatalogRows' ||
        receipt.catalog.projection.aggregateIds.length !== 0)) ||
    linkedChatsChanged !== (receipt.chats !== undefined) ||
    (receipt.chats !== undefined &&
      !sameConfigurationValue(receipt.chats.sidebar.mutatedRowIds, receipt.writtenChatIds)) ||
    (!receipt.targetQueryExecuted && receipt.targetLinkIds.length > 0) ||
    (operationKind === 'chat-preset.delete' &&
      receipt.targetLinkIds.some((id) => !removedTargetLinks.has(id))) ||
    (!presetChanged &&
      (receipt.links.removedLinkIds.length > 0 ||
        receipt.links.writtenLinkIds.length > 0 ||
        receipt.links.profileUsageMutations.length > 0 ||
        receipt.links.profileManagerRevisionChanged ||
        receipt.order.changed ||
        receipt.targetLinkIds.length > 0 ||
        receipt.writtenChatIds.length > 0))
  ) {
    throw new Error(`PresetLifecycleOperationReceiptInvalid:${operationKind}:${input.presetId}`)
  }
}

function presetLifecycleOperationReceipt(
  operationKind: PresetLifecycleOperationKind,
  presetId: PresetId,
  values: {
    readonly previous?: ChatPreset
    readonly next?: ChatPreset
    readonly presetReadRequests: number
    readonly profileReadRequests?: number
    readonly links?: ConfigurationOwnerLinkMutationReceipt
    readonly catalog?: ConfigurationPresetCatalogMutationReceipt
    readonly order?: PresetOrderMutationReceipt
    readonly chat?: ChatConfigurationOperationReceipt
    readonly targetQueryExecuted?: boolean
    readonly targetLinkIds?: readonly string[]
    readonly chatReadIds?: readonly ChatId[]
    readonly writtenChatIds?: readonly ChatId[]
    readonly chats?: LinkedChatRowMutationReceipt
  },
): PresetLifecycleOperationReceipt {
  return Object.freeze({
    operationKind,
    presetId,
    previous: values.previous,
    next: operationKind === 'chat-preset.delete' ? undefined : values.next,
    presetReadRequests: values.presetReadRequests,
    profileReadRequests: values.profileReadRequests ?? 0,
    links: values.links ?? emptyConfigurationOwnerLinkMutationReceipt(),
    catalog: values.catalog,
    order: values.order ?? emptyPresetOrderMutationReceipt(presetId),
    chat: values.chat ?? chatConfigurationOperationReceipt(undefined, undefined),
    targetQueryExecuted: values.targetQueryExecuted ?? false,
    targetLinkIds: Object.freeze([...(values.targetLinkIds ?? [])]),
    chatReadIds: Object.freeze([...(values.chatReadIds ?? [])]),
    writtenChatIds: Object.freeze([...(values.writtenChatIds ?? [])]),
    chats: values.chats,
  })
}

function executePresetLifecycleOperation<Result>(
  commandMeta: ConfigurationCommandMetaPort,
  operationKind: PresetLifecycleOperationKind,
  input: PresetLifecycleOperationInput,
  transition: (
    tx: FencedTransaction<PhysicalStorageTableName>,
  ) => Promise<SemanticOperationExecution<Result, PresetLifecycleOperationReceipt>>,
): Promise<Result> {
  const exactPlan = presetLifecycleOperationExactPlan(operationKind)
  return commandMeta.executeSemanticOperation(
    presetLifecycleOperationDescriptor(operationKind),
    input,
    async (tx) => {
      const execution = await transition(tx)
      return semanticOperationExecution(
        execution.value,
        presetLifecycleOperationExactReceipt(exactPlan, operationKind, input, execution.receipt),
      )
    },
  )
}

const presetOrderMoveOperationDescriptor = semanticOperationDescriptor<
  'configuration:chat-preset.move',
  PhysicalTransactionCapability,
  PresetOrderMoveOperationInput,
  SemanticOperationExactReceipt<PhysicalStorageTableName>
>({
  operationKind: 'configuration:chat-preset.move',
  transaction: physicalStorageTables(
    ...PRESET_ORDER_MUTATION_TRANSACTION_CAPABILITY.tableNames,
    'presets',
  ),
  resources: ({ presetId, afterPresetId }: PresetOrderMoveOperationInput) => [
    'preset-order',
    `preset:${presetId}`,
    ...(afterPresetId ? [`preset:${afterPresetId}`] : []),
  ],
  permittedWrites: PRESET_ORDER_MUTATION_TRANSACTION_CAPABILITY.tableNames,
  requiredWritesWhenMutated: ['presetOrderState', 'presetOrderBlocks'],
  ...semanticOperationExactReceiptContracts<
    PresetOrderMoveOperationInput,
    PhysicalStorageTableName
  >(),
  replay: semanticOperationExactReceiptReplayProofContract<PresetOrderMoveOperationInput>(
    assertConfigurationSingleAttemptReplayProof,
  ),
})

function presetOrderMoveOperationExactPlan(): SemanticOperationExactPlan {
  return semanticOperationExactPlan({
    replay: { kind: 'single-attempt', reason: 'unfenced-relative-update' },
    bounds: {
      reads: {
        maxRequests: 64,
        maxRows: 512,
        maxBatchRows: 512,
        maxBytes: Number.MAX_SAFE_INTEGER,
      },
      writes: {
        maxRequests: 512,
        maxRows: 512,
        maxBatchRows: 512,
        maxBytes: Number.MAX_SAFE_INTEGER,
      },
    },
  })
}

function presetOrderMoveOperationExactReceipt(
  plan: SemanticOperationExactPlan,
  input: PresetOrderMoveOperationInput,
  receipt: PresetOrderMutationReceipt,
): SemanticOperationExactReceipt<PhysicalStorageTableName> {
  if (receipt.presetId !== input.presetId || receipt.changed !== receipt.mutations.length > 0) {
    throw new Error(`PresetOrderMoveReceiptInvalid:${input.presetId}`)
  }
  return semanticOperationExactReceipt(plan, {
    dependencies: receipt.changed
      ? [
          {
            kind: 'preset',
            presetIds: [input.presetId],
            facets: ['catalog-order'],
          },
        ]
      : [],
    physicalMutations: receipt.mutations,
    physicalReads: [
      ...(input.presetId === input.afterPresetId
        ? []
        : [
            {
              tableName: 'presets' as const,
              indexKind: 'primary' as const,
              operation: 'get' as const,
              requestCount: input.afterPresetId ? 2 : 1,
              rowCount: input.afterPresetId ? 2 : 1,
            },
          ]),
      ...receipt.reads.map((read) => ({
        ...read,
        indexKind: 'primary' as const,
      })),
    ],
  })
}

const keyTouchOperationDescriptor = semanticOperationDescriptor({
  operationKind: 'configuration:key.touch',
  transaction: CONFIGURATION_KEY_ENTITY_TRANSACTION,
  resources: ({ keyId }: KeyTouchOperationInput) => [`key:${keyId}`],
  permittedWrites: ['keys'],
  requiredWritesWhenMutated: ['keys'],
  ...semanticOperationExactReceiptContracts<KeyTouchOperationInput, 'keys'>(),
  replay: semanticOperationExactReceiptReplayProofContract<KeyTouchOperationInput>(
    assertConfigurationSingleAttemptReplayProof,
  ),
})

function keyMaterialOperationDescriptor(
  operationKind: 'key.put' | 'key.material-replace' | 'key.delete',
) {
  return semanticOperationDescriptor({
    operationKind: configurationSemanticOperationKind(operationKind),
    transaction: CONFIGURATION_KEY_MATERIAL_TRANSACTION,
    resources: ({ keyId }: KeyMaterialOperationInput) => [`key:${keyId}`],
    permittedWrites: ['keys'],
    requiredWritesWhenMutated: ['keys'],
    ...semanticOperationExactReceiptContracts<KeyMaterialOperationInput, 'keys'>(),
    replay: semanticOperationExactReceiptReplayContract(keyMaterialOperationReplayPlan),
  })
}

function keyMaterialOperationReplayPlan(
  input: KeyMaterialOperationInput,
): SemanticOperationExactPlan['replay'] {
  return input.operationKind === 'key.delete'
    ? ({ kind: 'single-attempt', reason: 'unfenced-relative-update' } as const)
    : ({
        kind: 'fenced-convergent',
        owner: `key:${input.keyId}`,
        fence: [input.expectedMaterialRevision],
        desired: [configurationSemanticOperationKind(input.operationKind), input.materialRevision],
        alreadyApplied: 'return-current-or-conflict',
      } as const)
}

function keyMaterialOperationExactPlan(
  input: KeyMaterialOperationInput,
): SemanticOperationExactPlan {
  return semanticOperationExactPlan({
    replay: keyMaterialOperationReplayPlan(input),
    bounds: {
      reads: {
        maxRequests: 1,
        maxRows: 1,
        maxBatchRows: 1,
        maxBytes: Number.MAX_SAFE_INTEGER,
      },
      writes: { maxRequests: 1, maxRows: 1, maxBatchRows: 1, maxBytes: Number.MAX_SAFE_INTEGER },
    },
  })
}

function keyMaterialOperationExactReceipt(
  plan: SemanticOperationExactPlan,
  keyId: KeyId,
  receipt: KeyMaterialOperationReceipt,
): SemanticOperationExactReceipt<'keys'> {
  const didMutateStorage = receipt.mutation !== 'none'
  assertKeyMaterialOperationReceipt(keyId, didMutateStorage, receipt)
  return semanticOperationExactReceipt(plan, {
    dependencies: didMutateStorage
      ? workspaceDependenciesForConfigurationSemanticMutation({
          kind: 'key',
          previous: receipt.previous,
          next: receipt.next,
        })
      : [],
    physicalMutations:
      receipt.mutation === 'none'
        ? []
        : [{ tableName: 'keys', operation: receipt.mutation, key: keyId }],
    physicalReads: [
      {
        tableName: 'keys',
        indexKind: 'primary',
        operation: 'get',
        requestCount: 1,
        rowCount: 1,
      },
    ],
  })
}

function assertKeyMaterialOperationReceipt(
  keyId: KeyId,
  didMutateStorage: boolean,
  receipt: KeyMaterialOperationReceipt,
): void {
  if (
    (receipt.previous?.id ?? receipt.next?.id ?? keyId) !== keyId ||
    (receipt.mutation !== 'none') !== didMutateStorage
  ) {
    throw new Error(`KeyMaterialOperationReceiptInvalid:${keyId}`)
  }
}

function keyMaterialOperationReceipt(
  previous: KeyRecord | undefined,
  next: KeyRecord | undefined,
  mutation: KeyMaterialOperationReceipt['mutation'],
): KeyMaterialOperationReceipt {
  return Object.freeze({
    [KEY_MATERIAL_OPERATION_RECEIPT]: true as const,
    previous,
    next,
    mutation,
  })
}

function chatConfigurationOperationDescriptor(
  operationKind:
    | 'chat.settings-patch'
    | 'chat.settings-fields-patch'
    | 'chat.settings-replace'
    | 'prompt-preset.local-commit',
) {
  return semanticOperationDescriptor({
    operationKind: configurationSemanticOperationKind(operationKind),
    transaction: CHAT_ROW_LINKED_TRANSACTION_CAPABILITY,
    resources: ({ chatId, introducedTargetResources }: ChatConfigurationOperationInput) => [
      `chat-meta:${chatId}`,
      ...introducedTargetResources,
    ],
    permittedWrites: [...CHAT_ROW_LINKED_TRANSACTION_CAPABILITY.tableNames],
    requiredWritesWhenMutated: ['chats', 'chatSidebarRows'],
    ...semanticOperationExactReceiptContracts<
      ChatConfigurationOperationInput,
      ChatRowLinkedTable
    >(),
    replay: semanticOperationExactReceiptReplayProofContract<ChatConfigurationOperationInput>(
      assertConfigurationSingleAttemptReplayProof,
    ),
  })
}

function chatConfigurationOperationExactPlan(): SemanticOperationExactPlan {
  return semanticOperationExactPlan({
    replay: { kind: 'single-attempt', reason: 'unfenced-relative-update' },
    bounds: {
      reads: { maxRequests: 31, maxRows: 41, maxBatchRows: 9, maxBytes: Number.MAX_SAFE_INTEGER },
      writes: { maxRequests: 24, maxRows: 24, maxBatchRows: 9, maxBytes: Number.MAX_SAFE_INTEGER },
    },
  })
}

function chatConfigurationOperationExactReceipt(
  plan: SemanticOperationExactPlan,
  input: ChatConfigurationOperationInput,
  receipt: ChatConfigurationOperationReceipt,
): SemanticOperationExactReceipt<ChatRowLinkedTable> {
  const didMutateStorage = receipt.mutation === 'write'
  assertChatConfigurationOperationReceipt(input.chatId, didMutateStorage, receipt)
  return semanticOperationExactReceipt(plan, {
    dependencies: linkedChatTransitionDependencies(input.chatId, receipt.transition),
    physicalMutations: receipt.transition
      ? linkedChatTransitionPhysicalMutations(input.chatId, receipt.transition)
      : [],
    physicalReads: [
      {
        tableName: 'chats',
        indexKind: 'primary',
        operation: 'get',
        requestCount: 1,
        rowCount: 1,
      },
      ...linkedChatTransitionPhysicalReads(receipt.transition),
    ],
  })
}

function assertChatConfigurationOperationReceipt(
  chatId: ChatId,
  didMutateStorage: boolean,
  receipt: ChatConfigurationOperationReceipt,
): void {
  const linksChanged =
    receipt.previous &&
    receipt.next &&
    !sameConfigurationValue(
      configurationLinksForChat(receipt.previous),
      configurationLinksForChat(receipt.next),
    )
  if (
    (receipt.previous !== undefined && receipt.previous.id !== chatId) ||
    (receipt.next !== undefined && receipt.next.id !== chatId) ||
    (receipt.mutation === 'write') !== didMutateStorage ||
    (receipt.mutation === 'write') !== (receipt.transition !== undefined) ||
    (receipt.transition !== undefined &&
      (receipt.transition.sidebar.rowReadRequests !== 1 ||
        receipt.transition.sidebar.rowReadCount !== 1 ||
        receipt.transition.sidebar.mutatedRowIds.length !== 1 ||
        receipt.transition.sidebar.mutatedRowIds[0] !== chatId ||
        receipt.transition.sidebar.aggregateReadRequests !== 1)) ||
    (receipt.transition !== undefined &&
      receipt.transition.links.ownerQueryRequests !== (linksChanged ? 1 : 0))
  ) {
    throw new Error(`ChatConfigurationOperationReceiptInvalid:${chatId}`)
  }
}

function chatConfigurationOperationReceipt(
  previous: Chat | undefined,
  next: Chat | undefined,
  transition?: LinkedChatRowMutationReceipt,
): ChatConfigurationOperationReceipt {
  return Object.freeze({
    [CHAT_CONFIGURATION_OPERATION_RECEIPT]: true as const,
    previous,
    next,
    mutation: transition ? ('write' as const) : ('none' as const),
    transition,
  })
}

function linkedChatTransitionDependencies(
  chatId: ChatId,
  transition: LinkedChatRowMutationReceipt | undefined,
): readonly WorkspaceDependency[] {
  return linkedChatTransitionsDependencies([chatId], transition)
}

function linkedChatTransitionsDependencies(
  chatIds: readonly ChatId[],
  transition: LinkedChatRowMutationReceipt | undefined,
): readonly WorkspaceDependency[] {
  if (!transition) return []
  const profileIds = sortedUnique(
    transition.links.profileUsageMutations.map(({ profileId }) => profileId),
  )
  return normalizeWorkspaceDependencies([
    { kind: 'chat', chatIds },
    { kind: 'sidebar', chatIds },
    ...(profileIds.length > 0
      ? [
          {
            kind: 'profile' as const,
            profileIds,
            facets: ['dependent-counts' as const],
          },
        ]
      : []),
  ])
}

function linkedChatTransitionPhysicalMutations(
  chatId: ChatId,
  transition: LinkedChatRowMutationReceipt,
) {
  return linkedChatTransitionsPhysicalMutations([chatId], transition)
}

function linkedChatTransitionsPhysicalMutations(
  chatIds: readonly ChatId[],
  transition: LinkedChatRowMutationReceipt,
) {
  return [
    ...chatIds.map((key) => ({
      tableName: 'chats' as const,
      operation: 'write' as const,
      key,
    })),
    ...transition.links.removedLinkIds.map((key) => ({
      tableName: 'configurationLinks' as const,
      operation: 'delete' as const,
      key,
    })),
    ...transition.links.writtenLinkIds.map((key) => ({
      tableName: 'configurationLinks' as const,
      operation: 'write' as const,
      key,
    })),
    ...transition.links.profileUsageMutations.map(({ profileId: key, operation }) => ({
      tableName: 'configurationProfileUsageRows' as const,
      operation,
      key,
    })),
    ...(transition.links.profileManagerRevisionChanged
      ? [
          {
            tableName: 'configurationCatalogAggregates' as const,
            operation: 'write' as const,
            key: CONFIGURATION_PROFILE_MANAGER_STATE_ID,
          },
        ]
      : []),
    ...transition.sidebar.mutatedRowIds.map((key) => ({
      tableName: 'chatSidebarRows' as const,
      operation: 'write' as const,
      key,
    })),
    ...transition.sidebar.aggregateMutations.map(({ id: key, operation }) => ({
      tableName: 'chatSidebarAggregates' as const,
      operation,
      key,
    })),
  ]
}

function linkedChatTransitionPhysicalReads(transition: LinkedChatRowMutationReceipt | undefined) {
  if (!transition) return []
  return [
    {
      tableName: 'chats' as const,
      indexKind: 'secondary' as const,
      indexName: 'updatedAt',
      operation: 'query' as const,
      requestCount: 1,
      rowCount: 1,
    },
    ...(transition.links.ownerQueryRequests > 0
      ? [
          {
            tableName: 'configurationLinks' as const,
            indexKind: 'secondary' as const,
            indexName: 'ownerKey',
            operation: 'open-cursor' as const,
            requestCount: transition.links.ownerQueryRequests,
            rowCount: transition.links.ownerQueryRowCount,
          },
        ]
      : []),
    ...(transition.links.profileUsageReadRequests > 0
      ? [
          {
            tableName: 'configurationProfileUsageRows' as const,
            indexKind: 'primary' as const,
            operation: 'get-many' as const,
            requestCount: transition.links.profileUsageReadRequests,
            rowCount: transition.links.profileUsageMutations.length,
          },
        ]
      : []),
    ...(transition.links.profileManagerRevisionChanged
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
    {
      tableName: 'chatSidebarRows' as const,
      indexKind: 'primary' as const,
      operation: 'get-many' as const,
      requestCount: transition.sidebar.rowReadRequests,
      rowCount: transition.sidebar.rowReadCount,
    },
    ...(transition.sidebar.aggregateReadRequests > 0
      ? [
          {
            tableName: 'chatSidebarAggregates' as const,
            indexKind: 'primary' as const,
            operation: 'get-many' as const,
            requestCount: transition.sidebar.aggregateReadRequests,
            rowCount: transition.sidebar.aggregateReadCount,
          },
        ]
      : []),
    ...transition.sidebar.extremaReads.map(({ indexName, operation, requestCount, rowCount }) => ({
      tableName: 'chatSidebarRows' as const,
      indexKind: 'secondary' as const,
      indexName,
      operation,
      requestCount,
      rowCount,
    })),
  ]
}

function aggregateExactPhysicalReads(
  reads: readonly SemanticOperationExactPhysicalRead[],
): readonly SemanticOperationExactPhysicalRead[] {
  const aggregated = new Map<string, SemanticOperationExactPhysicalRead>()
  for (const read of reads) {
    const identity = JSON.stringify([
      read.tableName,
      read.indexKind,
      read.indexName ?? null,
      read.operation,
    ])
    const current = aggregated.get(identity)
    aggregated.set(
      identity,
      current
        ? {
            ...current,
            requestCount: current.requestCount + read.requestCount,
            rowCount: current.rowCount + read.rowCount,
          }
        : read,
    )
  }
  return [...aggregated.values()]
}

function chatSelectionOperationTransaction(
  operationKind: ChatSelectionOperationKind,
): PhysicalTransactionCapability {
  switch (operationKind) {
    case 'text-template.create-and-select':
      return physicalStorageTables(
        ...CHAT_ROW_LINKED_TRANSACTION_CAPABILITY.tableNames,
        'textTemplates',
      )
    case 'chat-preset.apply':
      return physicalStorageTables(...CHAT_ROW_LINKED_TRANSACTION_CAPABILITY.tableNames, 'presets')
    case 'prompt-preset.load-and-pin':
      return physicalStorageTables(
        ...CHAT_ROW_LINKED_TRANSACTION_CAPABILITY.tableNames,
        ...CONFIGURATION_PROMPT_PRESET_RECENCY_TRANSACTION_CAPABILITY.tableNames,
        'promptPresets',
      )
    case 'prompt-preset.create-and-pin':
      return physicalStorageTables(
        ...CHAT_ROW_LINKED_TRANSACTION_CAPABILITY.tableNames,
        ...CONFIGURATION_PROMPT_PRESET_CATALOG_TRANSACTION_CAPABILITY.tableNames,
        'promptPresets',
      )
  }
}

function chatSelectionRequiredWrites(
  operationKind: ChatSelectionOperationKind,
): readonly PhysicalStorageTableName[] {
  switch (operationKind) {
    case 'text-template.create-and-select':
      return ['textTemplates']
    case 'chat-preset.apply':
      return ['chats', 'chatSidebarRows']
    case 'prompt-preset.load-and-pin':
      return []
    case 'prompt-preset.create-and-pin':
      return [
        'promptPresets',
        'configurationPromptPresetCatalogRows',
        'configurationCatalogAggregates',
      ]
  }
}

function chatSelectionOperationDescriptor(operationKind: ChatSelectionOperationKind) {
  const transaction = chatSelectionOperationTransaction(operationKind)
  return semanticOperationDescriptor<
    ReturnType<typeof configurationSemanticOperationKind>,
    PhysicalTransactionCapability,
    ChatSelectionOperationInput,
    SemanticOperationExactReceipt<PhysicalStorageTableName>
  >({
    operationKind: configurationSemanticOperationKind(operationKind),
    transaction,
    resources: ({ resourceNames }) => resourceNames,
    permittedWrites: transaction.tableNames,
    requiredWritesWhenMutated: chatSelectionRequiredWrites(operationKind),
    ...semanticOperationExactReceiptContracts<
      ChatSelectionOperationInput,
      PhysicalStorageTableName
    >(),
    replay: semanticOperationExactReceiptReplayProofContract<ChatSelectionOperationInput>(
      assertConfigurationSingleAttemptReplayProof,
    ),
  })
}

function chatSelectionOperationExactPlan(): SemanticOperationExactPlan {
  return semanticOperationExactPlan({
    replay: { kind: 'single-attempt', reason: 'unfenced-relative-update' },
    bounds: {
      reads: { maxRequests: 40, maxRows: 50, maxBatchRows: 9, maxBytes: Number.MAX_SAFE_INTEGER },
      writes: { maxRequests: 30, maxRows: 30, maxBatchRows: 9, maxBytes: Number.MAX_SAFE_INTEGER },
    },
  })
}

function chatSelectionOperationExactReceipt(
  plan: SemanticOperationExactPlan,
  operationKind: ChatSelectionOperationKind,
  input: ChatSelectionOperationInput,
  receipt: ChatSelectionOperationReceipt,
): SemanticOperationExactReceipt<PhysicalStorageTableName> {
  const didMutateStorage = receipt.sourceMutation === 'write' || receipt.chat.mutation === 'write'
  assertChatSelectionOperationReceipt(operationKind, input, didMutateStorage, receipt)
  const projection = receipt.projection
  return semanticOperationExactReceipt(plan, {
    dependencies: didMutateStorage
      ? normalizeWorkspaceDependencies([
          ...(receipt.sourceTable === 'textTemplates' && receipt.sourceMutation === 'write'
            ? [
                {
                  kind: 'text-template' as const,
                  templateIds: [receipt.sourceId],
                },
              ]
            : []),
          ...(receipt.sourceTable === 'promptPresets' && receipt.sourceMutation === 'write'
            ? workspaceDependenciesForConfigurationSemanticMutation({
                kind: 'prompt-preset',
                previous: receipt.previousSource as PromptPreset | undefined,
                next: receipt.nextSource as PromptPreset,
              })
            : []),
          ...linkedChatTransitionDependencies(input.chatId, receipt.chat.transition),
        ])
      : [],
    physicalMutations: [
      ...(receipt.sourceMutation === 'write'
        ? [
            {
              tableName: receipt.sourceTable,
              operation: 'write' as const,
              key: receipt.sourceId,
            },
          ]
        : []),
      ...(projection?.projectionMutation === 'write'
        ? [
            {
              tableName: projection.projectionTable,
              operation: 'write' as const,
              key: projection.projectionId,
            },
          ]
        : []),
      ...(projection?.aggregateIds ?? []).map((key) => ({
        tableName: 'configurationCatalogAggregates' as const,
        operation: 'write' as const,
        key,
      })),
      ...(receipt.chat.transition
        ? linkedChatTransitionPhysicalMutations(input.chatId, receipt.chat.transition)
        : []),
    ],
    physicalReads: [
      {
        tableName: 'chats',
        indexKind: 'primary',
        operation: 'get',
        requestCount: 1,
        rowCount: 1,
      },
      {
        tableName: receipt.sourceTable,
        indexKind: 'primary',
        operation: 'get',
        requestCount: 1,
        rowCount: 1,
      },
      ...(projection?.aggregateIds.length
        ? [
            {
              tableName: 'configurationCatalogAggregates' as const,
              indexKind: 'primary' as const,
              operation: 'get' as const,
              requestCount: projection.aggregateIds.length,
              rowCount: projection.aggregateIds.length,
            },
          ]
        : []),
      ...linkedChatTransitionPhysicalReads(receipt.chat.transition),
    ],
  })
}

function assertChatSelectionOperationReceipt(
  operationKind: ChatSelectionOperationKind,
  input: ChatSelectionOperationInput,
  didMutateStorage: boolean,
  receipt: ChatSelectionOperationReceipt,
): void {
  const expectedSourceTable = chatSelectionSourceTable(operationKind)
  const sourceChanged = receipt.sourceMutation === 'write'
  const chatChanged = receipt.chat.mutation === 'write'
  assertChatConfigurationOperationReceipt(input.chatId, chatChanged, receipt.chat)
  if (
    receipt.operationKind !== operationKind ||
    receipt.chatId !== input.chatId ||
    receipt.sourceId !== input.sourceId ||
    receipt.sourceTable !== expectedSourceTable ||
    (receipt.previousSource !== undefined && receipt.previousSource.id !== input.sourceId) ||
    (receipt.nextSource !== undefined && receipt.nextSource.id !== input.sourceId) ||
    didMutateStorage !== (sourceChanged || chatChanged) ||
    (receipt.projection !== undefined) !==
      (sourceChanged && receipt.sourceTable === 'promptPresets') ||
    (receipt.projection !== undefined &&
      (receipt.projection.projectionId !== input.sourceId ||
        receipt.projection.projectionTable !== 'configurationPromptPresetCatalogRows' ||
        receipt.projection.projectionMutation !== 'write'))
  ) {
    throw new Error(`ChatSelectionOperationReceiptInvalid:${operationKind}:${input.sourceId}`)
  }
}

function chatSelectionSourceTable(
  operationKind: ChatSelectionOperationKind,
): ChatSelectionSourceTable {
  switch (operationKind) {
    case 'text-template.create-and-select':
      return 'textTemplates'
    case 'chat-preset.apply':
      return 'presets'
    case 'prompt-preset.load-and-pin':
    case 'prompt-preset.create-and-pin':
      return 'promptPresets'
  }
}

function chatSelectionOperationReceipt(
  operationKind: ChatSelectionOperationKind,
  input: ChatSelectionOperationInput,
  values: {
    readonly previousSource?: ChatSelectionSourceRow | undefined
    readonly nextSource?: ChatSelectionSourceRow | undefined
    readonly sourceMutation?: 'write'
    readonly projection?: ConfigurationCatalogProjectionMutationReceipt | undefined
    readonly chat?: ChatConfigurationOperationReceipt
  },
): ChatSelectionOperationReceipt {
  return Object.freeze({
    operationKind,
    chatId: input.chatId,
    sourceId: input.sourceId,
    sourceTable: chatSelectionSourceTable(operationKind),
    previousSource: values.previousSource,
    nextSource: values.nextSource,
    sourceMutation: values.sourceMutation ?? ('none' as const),
    projection: values.projection,
    chat: values.chat ?? chatConfigurationOperationReceipt(undefined, undefined),
  })
}

function executeChatSelectionOperation<Result>(
  commandMeta: ConfigurationCommandMetaPort,
  operationKind: ChatSelectionOperationKind,
  input: ChatSelectionOperationInput,
  operation: (
    tx: FencedTransaction<PhysicalStorageTableName>,
  ) => Promise<SemanticOperationExecution<Result, ChatSelectionOperationReceipt>>,
): Promise<Result> {
  const exactPlan = chatSelectionOperationExactPlan()
  return commandMeta.executeSemanticOperation(
    chatSelectionOperationDescriptor(operationKind),
    input,
    async (tx) => {
      const execution = await operation(tx)
      return semanticOperationExecution(
        execution.value,
        chatSelectionOperationExactReceipt(exactPlan, operationKind, input, execution.receipt),
      )
    },
  )
}

async function selectedChatConfigurationTransition(
  tx: FencedTransaction<PhysicalStorageTableName>,
  chatMutation: LinkedChatMutationOwner,
  current: Chat,
  transformed: Chat,
  now: number,
): Promise<ChatConfigurationOperationReceipt> {
  if (!chatConfigurationChanged(current, transformed)) {
    return chatConfigurationOperationReceipt(current, current)
  }
  const written = await configuredChat(tx, current, transformed, now)
  chatMutation.replaceLinked(current.id, () => written)
  const transition = await chatMutation.commit()
  return chatConfigurationOperationReceipt(current, written, transition)
}

function chatRequestTargetOperationTransaction(
  operationKind: ChatRequestTargetOperationKind,
  input: ChatRequestTargetOperationInput,
): PhysicalTransactionCapability {
  const base = [
    ...CHAT_ROW_LINKED_TRANSACTION_CAPABILITY.tableNames,
    ...(input.requestKeyId ? (['keys'] as const) : []),
    'profiles' as const,
  ]
  return operationKind === 'chat.switch-profile'
    ? physicalStorageTables(
        ...base,
        ...CONFIGURATION_PROFILE_CATALOG_TRANSACTION_CAPABILITY.tableNames,
        ...(input.readModelsCache ? CONFIGURATION_MODELS_CACHE_READ_TRANSACTION.tableNames : []),
      )
    : physicalStorageTables(...base, ...(input.modelsHeaderKey ? (['models'] as const) : []))
}

function chatRequestTargetResourceNames(input: ChatRequestTargetOperationInput): readonly string[] {
  const profileIds = sortedUnique(
    [input.previousProfileId, input.profileId].filter(
      (profileId): profileId is ProfileId => profileId !== null,
    ),
  )
  const modelResolutionTargets = [
    input.previousModelResolutionTarget,
    input.nextModelResolutionTarget,
  ].filter((target): target is ConfigurationRequestRevision => target !== null)
  return sortedUnique([
    `chat-meta:${input.chatId}`,
    `profile:${input.profileId}`,
    ...profileIds.map(
      (profileId) => `configuration-target:${configurationTargetKey('profile', profileId)}`,
    ),
    ...(input.requestKeyId
      ? [
          `key:${input.requestKeyId}`,
          `configuration-target:${configurationTargetKey('key', input.requestKeyId)}`,
        ]
      : []),
    ...modelResolutionTargets.map(
      (target) =>
        `configuration-target:${configurationTargetKey(
          'model-resolution',
          configurationRequestRevisionKey(target),
        )}`,
    ),
  ])
}

function chatRequestTargetOperationDescriptor(
  operationKind: ChatRequestTargetOperationKind,
  input: ChatRequestTargetOperationInput,
) {
  const transaction = chatRequestTargetOperationTransaction(operationKind, input)
  return semanticOperationDescriptor<
    ReturnType<typeof configurationSemanticOperationKind>,
    PhysicalTransactionCapability,
    ChatRequestTargetOperationInput,
    SemanticOperationExactReceipt<PhysicalStorageTableName>
  >({
    operationKind: configurationSemanticOperationKind(operationKind),
    transaction,
    resources: chatRequestTargetResourceNames,
    permittedWrites: transaction.tableNames,
    requiredWritesWhenMutated: [],
    ...semanticOperationExactReceiptContracts<
      ChatRequestTargetOperationInput,
      PhysicalStorageTableName
    >(),
    replay: semanticOperationExactReceiptReplayProofContract<ChatRequestTargetOperationInput>(
      assertConfigurationSingleAttemptReplayProof,
    ),
  })
}

function chatRequestTargetOperationExactPlan(): SemanticOperationExactPlan {
  return semanticOperationExactPlan({
    replay: { kind: 'single-attempt', reason: 'unfenced-relative-update' },
    bounds: {
      reads: { maxRequests: 40, maxRows: 50, maxBatchRows: 9, maxBytes: Number.MAX_SAFE_INTEGER },
      writes: { maxRequests: 30, maxRows: 30, maxBatchRows: 9, maxBytes: Number.MAX_SAFE_INTEGER },
    },
  })
}

function chatRequestTargetOperationExactReceipt(
  plan: SemanticOperationExactPlan,
  operationKind: ChatRequestTargetOperationKind,
  input: ChatRequestTargetOperationInput,
  receipt: ChatRequestTargetOperationReceipt,
): SemanticOperationExactReceipt<PhysicalStorageTableName> {
  const didMutateStorage = receipt.chat.mutation === 'write' || receipt.profileMutation === 'write'
  assertChatRequestTargetOperationReceipt(operationKind, input, didMutateStorage, receipt)
  const projection = receipt.profileProjection
  return semanticOperationExactReceipt(plan, {
    dependencies: didMutateStorage
      ? normalizeWorkspaceDependencies([
          ...linkedChatTransitionDependencies(input.chatId, receipt.chat.transition),
          ...sortedUnique(
            [input.previousModelResolutionTarget, input.nextModelResolutionTarget]
              .filter((target): target is ConfigurationRequestRevision => target !== null)
              .map((target) =>
                configurationTargetKey('model-resolution', configurationRequestRevisionKey(target)),
              ),
          ).map((targetKey) => ({
            kind: 'model-resolution' as const,
            targetKeys: [targetKey],
          })),
          ...(receipt.profileMutation === 'write'
            ? workspaceDependenciesForConfigurationSemanticMutation({
                kind: 'profile' as const,
                previous: receipt.previousProfile,
                next: receipt.nextProfile,
              })
            : []),
        ])
      : [],
    physicalMutations: [
      ...(receipt.chat.transition
        ? linkedChatTransitionPhysicalMutations(input.chatId, receipt.chat.transition)
        : []),
      ...(receipt.profileMutation === 'write'
        ? [
            {
              tableName: 'profiles' as const,
              operation: 'write' as const,
              key: input.profileId,
            },
          ]
        : []),
      ...(projection?.projectionMutation === 'write'
        ? [
            {
              tableName: projection.projectionTable,
              operation: 'write' as const,
              key: projection.projectionId,
            },
          ]
        : []),
      ...(projection?.aggregateIds ?? []).map((key) => ({
        tableName: 'configurationCatalogAggregates' as const,
        operation: 'write' as const,
        key,
      })),
    ],
    physicalReads: aggregateExactPhysicalReads([
      {
        tableName: 'chats',
        indexKind: 'primary',
        operation: 'get',
        requestCount: 1,
        rowCount: 1,
      },
      {
        tableName: 'profiles',
        indexKind: 'primary',
        operation: 'get',
        requestCount: 1,
        rowCount: 1,
      },
      ...(input.requestKeyId
        ? [
            {
              tableName: 'keys' as const,
              indexKind: 'primary' as const,
              operation: 'get' as const,
              requestCount: 1,
              rowCount: 1,
            },
          ]
        : []),
      ...(projection?.aggregateIds.length
        ? [
            {
              tableName: 'configurationCatalogAggregates' as const,
              indexKind: 'primary' as const,
              operation: 'get' as const,
              requestCount: projection.aggregateIds.length,
              rowCount: projection.aggregateIds.length,
            },
          ]
        : []),
      ...(receipt.modelsCacheRead
        ? [
            {
              tableName: 'models' as const,
              indexKind: 'primary' as const,
              operation: 'get' as const,
              requestCount: 1,
              rowCount: 1,
            },
            ...(receipt.modelsCacheRead.headerFound
              ? [
                  {
                    tableName: 'discoveryPayloadMetadata' as const,
                    indexKind: 'primary' as const,
                    operation: 'get' as const,
                    requestCount: 1,
                    rowCount: receipt.modelsCacheRead.metadataFound ? 1 : 0,
                  },
                  {
                    tableName: 'discoveryPayloads' as const,
                    indexKind: 'primary' as const,
                    operation: 'get' as const,
                    requestCount: 1,
                    rowCount: receipt.modelsCacheRead.payloadFound ? 1 : 0,
                  },
                ]
              : []),
          ]
        : []),
      ...(!input.readModelsCache && input.modelsHeaderKey
        ? [
            {
              tableName: 'models' as const,
              indexKind: 'primary' as const,
              operation: 'get' as const,
              requestCount: 1,
              rowCount: 1,
            },
          ]
        : []),
      ...linkedChatTransitionPhysicalReads(receipt.chat.transition),
    ]),
  })
}

function assertChatRequestTargetOperationReceipt(
  operationKind: ChatRequestTargetOperationKind,
  input: ChatRequestTargetOperationInput,
  didMutateStorage: boolean,
  receipt: ChatRequestTargetOperationReceipt,
): void {
  const chatChanged = receipt.chat.mutation === 'write'
  const profileChanged = receipt.profileMutation === 'write'
  assertChatConfigurationOperationReceipt(input.chatId, chatChanged, receipt.chat)
  if (
    receipt.operationKind !== operationKind ||
    receipt.chatId !== input.chatId ||
    receipt.profileId !== input.profileId ||
    receipt.requestKeyId !== input.requestKeyId ||
    (receipt.previousProfile !== undefined &&
      (receipt.modelsCacheRead !== undefined) !== input.readModelsCache) ||
    (receipt.previousProfile === undefined && receipt.modelsCacheRead !== undefined) ||
    (receipt.observedKey !== undefined &&
      (input.requestKeyId === null || receipt.observedKey.id !== input.requestKeyId)) ||
    (receipt.modelsHeader !== undefined &&
      (input.modelsHeaderKey === null ||
        receipt.modelsHeader.profileId !== input.modelsHeaderKey[0] ||
        receipt.modelsHeader.queryKey !== input.modelsHeaderKey[1])) ||
    (receipt.previousProfile !== undefined && receipt.previousProfile.id !== input.profileId) ||
    (receipt.nextProfile !== undefined && receipt.nextProfile.id !== input.profileId) ||
    profileChanged !== (receipt.profileProjection !== undefined) ||
    (profileChanged &&
      (!receipt.previousProfile ||
        !receipt.nextProfile ||
        !sameConfigurationValue(
          configurationLinksForProfile(receipt.previousProfile),
          configurationLinksForProfile(receipt.nextProfile),
        ))) ||
    (!profileChanged && receipt.nextProfile !== receipt.previousProfile) ||
    (receipt.profileProjection !== undefined &&
      (receipt.profileProjection.projectionTable !== 'configurationProfileCatalogRows' ||
        receipt.profileProjection.projectionId !== input.profileId)) ||
    didMutateStorage !== (chatChanged || profileChanged)
  ) {
    throw new Error(`ChatRequestTargetOperationReceiptInvalid:${operationKind}:${input.chatId}`)
  }
}

function chatRequestTargetOperationReceipt(
  input: ChatRequestTargetOperationInput,
  values: {
    readonly observedKey?: KeyRecord | undefined
    readonly previousProfile?: ConnectionProfile | undefined
    readonly nextProfile?: ConnectionProfile | undefined
    readonly profileProjection?: ConfigurationCatalogProjectionMutationReceipt | undefined
    readonly chat?: ChatConfigurationOperationReceipt | undefined
    readonly modelsCacheRead?: Omit<DiscoveryCacheReadEvidence<unknown>, 'row'> | undefined
    readonly modelsHeader?: CachedModelsStorageRow | undefined
  },
): ChatRequestTargetOperationReceipt {
  return Object.freeze({
    operationKind: input.operationKind,
    chatId: input.chatId,
    profileId: input.profileId,
    requestKeyId: input.requestKeyId,
    observedKey: values.observedKey,
    previousProfile: values.previousProfile,
    nextProfile: values.nextProfile ?? values.previousProfile,
    profileMutation: values.profileProjection ? ('write' as const) : ('none' as const),
    profileProjection: values.profileProjection,
    chat: values.chat ?? chatConfigurationOperationReceipt(undefined, undefined),
    modelsCacheRead: values.modelsCacheRead,
    modelsHeader: values.modelsHeader,
  })
}

function executeChatRequestTargetOperation<Result>(
  commandMeta: ConfigurationCommandMetaPort,
  operationKind: ChatRequestTargetOperationKind,
  input: ChatRequestTargetOperationInput,
  operation: (
    tx: FencedTransaction<PhysicalStorageTableName>,
  ) => Promise<SemanticOperationExecution<Result, ChatRequestTargetOperationReceipt>>,
): Promise<Result> {
  const exactPlan = chatRequestTargetOperationExactPlan()
  return commandMeta.executeSemanticOperation(
    chatRequestTargetOperationDescriptor(operationKind, input),
    input,
    async (tx) => {
      const execution = await operation(tx)
      if (execution.receipt.chat.mutation === 'write') {
        for (const targetKey of sortedUnique(
          [input.previousModelResolutionTarget, input.nextModelResolutionTarget]
            .filter((target): target is ConfigurationRequestRevision => target !== null)
            .map((target) =>
              configurationTargetKey('model-resolution', configurationRequestRevisionKey(target)),
            ),
        )) {
          recordBrowserCommandInvalidation(tx, {
            kind: 'model-resolution',
            targetKeys: [targetKey],
          })
        }
      }
      return semanticOperationExecution(
        execution.value,
        chatRequestTargetOperationExactReceipt(exactPlan, operationKind, input, execution.receipt),
      )
    },
  )
}

function configurationTargetFanoutOperationInput(
  command: ConfigurationTargetFanoutOperationCommand,
): ConfigurationTargetFanoutOperationInput {
  if (command.kind === 'text-template.delete') {
    return {
      operationKind: command.kind,
      sourceKind: 'text-template',
      sourceId: command.templateId,
      selectedChatId: null,
    }
  }
  return {
    operationKind: command.kind,
    sourceKind: 'prompt-preset',
    sourceId: command.presetId,
    selectedChatId: command.kind === 'prompt-preset.overwrite-and-pin' ? command.chatId : null,
  }
}

function configurationTargetFanoutOperationTransaction(
  input: ConfigurationTargetFanoutOperationInput,
): PhysicalTransactionCapability {
  if (input.sourceKind === 'text-template') {
    return physicalStorageTables(
      ...CHAT_ROW_LINKED_TRANSACTION_CAPABILITY.tableNames,
      ...CONFIGURATION_LINK_MUTATION_TRANSACTION_CAPABILITY.tableNames,
      'presets',
      'textTemplates',
    )
  }
  return physicalStorageTables(
    ...CHAT_ROW_LINKED_TRANSACTION_CAPABILITY.tableNames,
    ...CONFIGURATION_PROMPT_PRESET_CATALOG_TRANSACTION_CAPABILITY.tableNames,
    'presets',
    'promptPresets',
  )
}

function configurationTargetFanoutOperationReceiptCompiler(
  input: ConfigurationTargetFanoutOperationInput,
) {
  return Object.freeze({
    dependencies: (
      didMutateStorage: boolean,
      receipt: ConfigurationTargetFanoutOperationReceipt,
    ) => {
      assertConfigurationTargetFanoutOperationReceipt(input, didMutateStorage, receipt)
      if (!didMutateStorage) return []
      return normalizeWorkspaceDependencies([
        ...(receipt.sourceKind === 'prompt-preset' && receipt.sourceMutation !== 'none'
          ? workspaceDependenciesForConfigurationSemanticMutation({
              kind: 'prompt-preset' as const,
              previous: receipt.previousSource as PromptPreset | undefined,
              next: receipt.nextSource as PromptPreset | undefined,
            })
          : []),
        ...(receipt.sourceKind === 'text-template' &&
        (receipt.sourceMutation !== 'none' || receipt.targetLinkIds.length > 0)
          ? [{ kind: 'text-template' as const, templateIds: [receipt.sourceId] }]
          : []),
        ...receipt.targetFragment.dependencies,
      ])
    },
    physicalMutations: (
      didMutateStorage: boolean,
      receipt: ConfigurationTargetFanoutOperationReceipt,
    ) => {
      assertConfigurationTargetFanoutOperationReceipt(input, didMutateStorage, receipt)
      const projection = receipt.sourceProjection
      return [
        ...(receipt.sourceMutation === 'write'
          ? [
              {
                tableName:
                  input.sourceKind === 'prompt-preset'
                    ? ('promptPresets' as const)
                    : ('textTemplates' as const),
                operation: 'write' as const,
                key: receipt.sourceId,
              },
            ]
          : receipt.sourceMutation === 'delete'
            ? [
                {
                  tableName:
                    input.sourceKind === 'prompt-preset'
                      ? ('promptPresets' as const)
                      : ('textTemplates' as const),
                  operation: 'delete' as const,
                  key: receipt.sourceId,
                },
              ]
            : []),
        ...(projection?.projectionMutation === 'write'
          ? [
              {
                tableName: projection.projectionTable,
                operation: 'write' as const,
                key: projection.projectionId,
              },
            ]
          : projection?.projectionMutation === 'delete'
            ? [
                {
                  tableName: projection.projectionTable,
                  operation: 'delete' as const,
                  key: projection.projectionId,
                },
              ]
            : []),
        ...(projection?.aggregateIds ?? []).map((key) => ({
          tableName: 'configurationCatalogAggregates' as const,
          operation: 'write' as const,
          key,
        })),
        ...receipt.targetFragment.physicalMutations,
      ]
    },
    physicalReads: (receipt: ConfigurationTargetFanoutOperationReceipt) => {
      assertConfigurationTargetFanoutOperationReceipt(
        input,
        configurationTargetFanoutDidMutate(receipt),
        receipt,
      )
      return aggregateExactPhysicalReads([
        {
          tableName:
            input.sourceKind === 'prompt-preset'
              ? ('promptPresets' as const)
              : ('textTemplates' as const),
          indexKind: 'primary' as const,
          operation: 'get' as const,
          requestCount: 1,
          rowCount: 1,
        },
        ...(receipt.targetQueryExecuted
          ? [
              {
                tableName: 'configurationLinks' as const,
                indexKind: 'secondary' as const,
                indexName: '[targetKey+id]',
                operation: 'query' as const,
                requestCount: receipt.targetQueryRequests,
                rowCount: receipt.targetLinkIds.length,
              },
            ]
          : []),
        ...(receipt.chatReadIds.length > 0
          ? [
              {
                tableName: 'chats' as const,
                indexKind: 'primary' as const,
                operation: 'get-many' as const,
                requestCount: receipt.chatReadRequests,
                rowCount: receipt.chatReadIds.length,
              },
            ]
          : []),
        ...(receipt.presetReadIds.length > 0
          ? [
              {
                tableName: 'presets' as const,
                indexKind: 'primary' as const,
                operation: 'get-many' as const,
                requestCount: receipt.presetReadRequests,
                rowCount: receipt.presetReadIds.length,
              },
            ]
          : []),
        ...(receipt.sourceProjection?.aggregateIds.length
          ? [
              {
                tableName: 'configurationCatalogAggregates' as const,
                indexKind: 'primary' as const,
                operation: 'get' as const,
                requestCount: receipt.sourceProjection.aggregateIds.length,
                rowCount: receipt.sourceProjection.aggregateIds.length,
              },
            ]
          : []),
        ...receipt.targetFragment.physicalReads,
      ])
    },
  })
}

function configurationTargetFanoutOperationDescriptor(
  input: ConfigurationTargetFanoutOperationInput,
) {
  const transaction = configurationTargetFanoutOperationTransaction(input)
  return semanticOperationDescriptor<
    ReturnType<typeof configurationSemanticOperationKind>,
    PhysicalTransactionCapability,
    ConfigurationTargetFanoutOperationInput,
    SemanticOperationExactReceipt<PhysicalStorageTableName>
  >({
    operationKind: configurationSemanticOperationKind(input.operationKind),
    transaction,
    resources: ({ sourceKind, sourceId, selectedChatId }) => [
      configurationTargetResourceName(sourceKind, sourceId),
      ...(sourceKind === 'prompt-preset' ? [`prompt-preset:${sourceId}`] : []),
      ...(selectedChatId ? [`chat-meta:${selectedChatId}`] : []),
    ],
    permittedWrites: transaction.tableNames,
    requiredWritesWhenMutated: [],
    ...semanticOperationExactReceiptContracts<
      ConfigurationTargetFanoutOperationInput,
      PhysicalStorageTableName
    >(),
    replay:
      semanticOperationExactReceiptReplayProofContract<ConfigurationTargetFanoutOperationInput>(
        assertConfigurationSingleAttemptReplayProof,
      ),
  })
}

function configurationTargetFanoutOperationExactPlan(): SemanticOperationExactPlan {
  const bound = {
    maxRequests: Number.MAX_SAFE_INTEGER,
    maxRows: Number.MAX_SAFE_INTEGER,
    maxBatchRows: Number.MAX_SAFE_INTEGER,
    maxBytes: Number.MAX_SAFE_INTEGER,
  }
  return semanticOperationExactPlan({
    replay: { kind: 'single-attempt', reason: 'unfenced-relative-update' },
    bounds: { reads: bound, writes: bound },
  })
}

function configurationTargetFanoutOperationExactReceipt(
  plan: SemanticOperationExactPlan,
  input: ConfigurationTargetFanoutOperationInput,
  receipt: ConfigurationTargetFanoutOperationReceipt,
): SemanticOperationExactReceipt<PhysicalStorageTableName> {
  const didMutateStorage = configurationTargetFanoutDidMutate(receipt)
  const compiler = configurationTargetFanoutOperationReceiptCompiler(input)
  return semanticOperationExactReceipt(plan, {
    dependencies: compiler.dependencies(didMutateStorage, receipt),
    physicalMutations: compiler.physicalMutations(didMutateStorage, receipt),
    physicalReads: compiler.physicalReads(receipt),
  })
}

function configurationTargetFanoutDidMutate(
  receipt: ConfigurationTargetFanoutOperationReceipt,
): boolean {
  return receipt.sourceMutation !== 'none' || receipt.targetFragment.physicalMutations.length > 0
}

function assertConfigurationTargetFanoutOperationReceipt(
  input: ConfigurationTargetFanoutOperationInput,
  didMutateStorage: boolean,
  receipt: ConfigurationTargetFanoutOperationReceipt,
): void {
  const sourceChanged = receipt.sourceMutation !== 'none'
  const writtenPresetIds = new Set(receipt.writtenPresetIds)
  const writtenChatIds = new Set(receipt.writtenChatIds)
  const readPresetIds = new Set(receipt.presetReadIds)
  const readChatIds = new Set(receipt.chatReadIds)
  const physicalMutations = receipt.targetFragment.physicalMutations
  const removedTargetLinks = new Set(
    physicalMutations.flatMap((mutation) =>
      mutation.tableName === 'configurationLinks' && mutation.operation === 'delete'
        ? [mutation.key]
        : [],
    ),
  )
  const physicallyWrittenPresetIds = new Set(
    physicalMutations.flatMap((mutation) =>
      mutation.tableName === 'presets' && mutation.operation === 'write' ? [mutation.key] : [],
    ),
  )
  const physicallyWrittenChatIds = new Set(
    physicalMutations.flatMap((mutation) =>
      mutation.tableName === 'chats' && mutation.operation === 'write' ? [mutation.key] : [],
    ),
  )
  if (
    receipt.operationKind !== input.operationKind ||
    receipt.sourceKind !== input.sourceKind ||
    receipt.sourceId !== input.sourceId ||
    receipt.selectedChatId !== input.selectedChatId ||
    (receipt.previousSource !== undefined && receipt.previousSource.id !== input.sourceId) ||
    (receipt.nextSource !== undefined && receipt.nextSource.id !== input.sourceId) ||
    (input.sourceKind === 'prompt-preset'
      ? sourceChanged !== (receipt.sourceProjection !== undefined)
      : receipt.sourceProjection !== undefined) ||
    (receipt.sourceMutation === 'write' &&
      (receipt.previousSource === undefined || receipt.nextSource === undefined)) ||
    (receipt.sourceMutation === 'delete' &&
      (receipt.previousSource === undefined || receipt.nextSource !== undefined)) ||
    (receipt.sourceMutation === 'none' && receipt.nextSource !== receipt.previousSource) ||
    !sameConfigurationValue(receipt.targetLinkIds, sortedUnique(receipt.targetLinkIds)) ||
    !sameConfigurationValue(receipt.chatReadIds, sortedUnique(receipt.chatReadIds)) ||
    !sameConfigurationValue(receipt.presetReadIds, sortedUnique(receipt.presetReadIds)) ||
    !sameConfigurationValue(receipt.writtenChatIds, sortedUnique(receipt.writtenChatIds)) ||
    !sameConfigurationValue(receipt.writtenPresetIds, sortedUnique(receipt.writtenPresetIds)) ||
    receipt.writtenPresetIds.some(
      (id) => !readPresetIds.has(id) || !physicallyWrittenPresetIds.has(id),
    ) ||
    receipt.writtenChatIds.some(
      (id) => !readChatIds.has(id) || !physicallyWrittenChatIds.has(id),
    ) ||
    physicallyWrittenPresetIds.size !== writtenPresetIds.size ||
    physicallyWrittenChatIds.size !== writtenChatIds.size ||
    didMutateStorage !== configurationTargetFanoutDidMutate(receipt) ||
    (!receipt.targetQueryExecuted &&
      (receipt.targetQueryRequests !== 0 || receipt.targetLinkIds.length > 0)) ||
    (receipt.targetQueryExecuted && receipt.targetQueryRequests < 1) ||
    (receipt.chatReadIds.length === 0) !== (receipt.chatReadRequests === 0) ||
    (receipt.chatReadIds.length > 0 && receipt.chatReadRequests < 1) ||
    (receipt.presetReadIds.length === 0) !== (receipt.presetReadRequests === 0) ||
    (receipt.presetReadIds.length > 0 && receipt.presetReadRequests < 1) ||
    ((input.operationKind === 'prompt-preset.delete' ||
      input.operationKind === 'text-template.delete') &&
      receipt.targetLinkIds.some((id) => !removedTargetLinks.has(id)))
  ) {
    throw new Error(
      `ConfigurationTargetFanoutOperationReceiptInvalid:${input.operationKind}:${input.sourceId}`,
    )
  }
}

function configurationTargetFanoutOperationReceipt(
  input: ConfigurationTargetFanoutOperationInput,
  values: Partial<
    Omit<
      ConfigurationTargetFanoutOperationReceipt,
      'operationKind' | 'sourceKind' | 'sourceId' | 'selectedChatId' | 'sourceMutation'
    >
  > & {
    readonly sourceMutation?: ConfigurationTargetFanoutOperationReceipt['sourceMutation']
  },
): ConfigurationTargetFanoutOperationReceipt {
  return Object.freeze({
    operationKind: input.operationKind,
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    selectedChatId: input.selectedChatId,
    previousSource: values.previousSource,
    nextSource:
      values.sourceMutation === 'delete' ? undefined : (values.nextSource ?? values.previousSource),
    sourceMutation: values.sourceMutation ?? 'none',
    sourceProjection: values.sourceProjection,
    targetQueryExecuted: values.targetQueryExecuted ?? false,
    targetQueryRequests: values.targetQueryRequests ?? 0,
    targetLinkIds: Object.freeze([...(values.targetLinkIds ?? [])]),
    chatReadRequests: values.chatReadRequests ?? 0,
    chatReadIds: Object.freeze([...(values.chatReadIds ?? [])]),
    presetReadRequests: values.presetReadRequests ?? 0,
    presetReadIds: Object.freeze([...(values.presetReadIds ?? [])]),
    writtenPresetIds: Object.freeze([...(values.writtenPresetIds ?? [])]),
    writtenChatIds: Object.freeze([...(values.writtenChatIds ?? [])]),
    targetFragment: values.targetFragment ?? semanticOperationReceiptFragment({}),
  })
}

function executeConfigurationTargetFanoutOperation<
  Command extends ConfigurationTargetFanoutOperationCommand,
>(
  commandMeta: ConfigurationCommandMetaPort,
  command: Command,
): Promise<ConfigurationDomainResult<Command['kind']>> {
  const input = configurationTargetFanoutOperationInput(command)
  const exactPlan = configurationTargetFanoutOperationExactPlan()
  return commandMeta.executeSemanticOperation(
    configurationTargetFanoutOperationDescriptor(input),
    input,
    async (tx) => {
      const current =
        input.sourceKind === 'prompt-preset'
          ? await tx.table<PromptPreset, PromptPresetId>('promptPresets').get(input.sourceId)
          : await tx.table<SavedTextTemplate, TextTemplateId>('textTemplates').get(input.sourceId)
      if (!current && input.sourceKind === 'prompt-preset') {
        return semanticOperationExecution(
          { kind: 'missing', entity: 'prompt-preset', id: input.sourceId } as const,
          configurationTargetFanoutOperationExactReceipt(
            exactPlan,
            input,
            configurationTargetFanoutOperationReceipt(input, {}),
          ),
        )
      }
      const execution = await commitConfigurationTargetFanoutOperation(tx, command, input, current)
      return semanticOperationExecution(
        execution.value,
        configurationTargetFanoutOperationExactReceipt(exactPlan, input, execution.receipt),
      )
    },
  ) as Promise<ConfigurationDomainResult<Command['kind']>>
}

function nextPromptPresetTargetSource(
  command: Exclude<ConfigurationTargetFanoutOperationCommand, { kind: 'text-template.delete' }>,
  current: PromptPreset,
): PromptPreset | undefined {
  switch (command.kind) {
    case 'prompt-preset.overwrite-and-pin': {
      const next = {
        ...current,
        text: command.text,
        updatedAt: command.now,
        lastUsedAt: command.now,
      }
      return sameConfigurationValue(current, next) ? current : next
    }
    case 'prompt-preset.delete':
      return undefined
  }
}

const CONFIGURATION_TARGET_FANOUT_PAGE_SIZE = 64

async function readConfigurationTargetFanoutLinks(
  tx: Transaction,
  kind: ConfigurationLink['targetKind'],
  id: string,
): Promise<{
  readonly links: readonly ConfigurationLink[]
  readonly requestCount: number
}> {
  const table = tx.table<ConfigurationLink, string>('configurationLinks')
  const targetKey = configurationTargetKey(kind, id)
  const [, upper] = exactCompoundPrefixBetween([targetKey])
  const links: ConfigurationLink[] = []
  let afterId: string | undefined
  let requestCount = 0
  for (;;) {
    const page = await table
      .where('[targetKey+id]')
      .between(
        afterId === undefined ? [targetKey] : [targetKey, afterId],
        upper,
        afterId === undefined,
        false,
      )
      .limit(CONFIGURATION_TARGET_FANOUT_PAGE_SIZE)
      .toArray()
    requestCount += 1
    links.push(...page)
    if (page.length < CONFIGURATION_TARGET_FANOUT_PAGE_SIZE) break
    afterId = page[page.length - 1]?.id
  }
  return { links: Object.freeze(links), requestCount }
}

function configurationTargetFanoutPages<Value>(
  values: readonly Value[],
): readonly (readonly Value[])[] {
  const pages: Value[][] = []
  for (let offset = 0; offset < values.length; offset += CONFIGURATION_TARGET_FANOUT_PAGE_SIZE) {
    pages.push(values.slice(offset, offset + CONFIGURATION_TARGET_FANOUT_PAGE_SIZE))
  }
  return pages
}

function configurationPresetTargetMutationFragment(
  presetIds: readonly PresetId[],
  links: ConfigurationOwnerLinkMutationReceipt,
): SemanticOperationReceiptFragment<PhysicalStorageTableName> {
  return semanticOperationReceiptFragment({
    physicalMutations: [
      ...presetIds.map((key) => ({
        tableName: 'presets' as const,
        operation: 'write' as const,
        key,
      })),
      ...links.removedLinkIds.map((key) => ({
        tableName: 'configurationLinks' as const,
        operation: 'delete' as const,
        key,
      })),
      ...links.writtenLinkIds.map((key) => ({
        tableName: 'configurationLinks' as const,
        operation: 'write' as const,
        key,
      })),
      ...links.profileUsageMutations.map(({ profileId: key, operation }) => ({
        tableName: 'configurationProfileUsageRows' as const,
        operation,
        key,
      })),
      ...(links.profileManagerRevisionChanged
        ? [
            {
              tableName: 'configurationCatalogAggregates' as const,
              operation: 'write' as const,
              key: CONFIGURATION_PROFILE_MANAGER_STATE_ID,
            },
          ]
        : []),
    ],
    physicalReads: [
      ...(links.ownerQueryRequests > 0
        ? [
            {
              tableName: 'configurationLinks' as const,
              indexKind: 'secondary' as const,
              indexName: 'ownerKey',
              operation: 'open-cursor' as const,
              requestCount: links.ownerQueryRequests,
              rowCount: links.ownerQueryRowCount,
            },
          ]
        : []),
      ...(links.profileUsageReadRequests > 0
        ? [
            {
              tableName: 'configurationProfileUsageRows' as const,
              indexKind: 'primary' as const,
              operation: 'get-many' as const,
              requestCount: links.profileUsageReadRequests,
              rowCount: links.profileUsageMutations.length,
            },
          ]
        : []),
      ...(links.profileManagerRevisionChanged
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
    ],
  })
}

function configurationTargetPhysicalFragment(
  fragment: SemanticOperationReceiptFragment<PhysicalStorageTableName>,
): SemanticOperationReceiptFragment<PhysicalStorageTableName> {
  return semanticOperationReceiptFragment({
    physicalMutations: fragment.physicalMutations,
    physicalReads: fragment.physicalReads,
    physicalWrites: fragment.physicalWrites,
  })
}

async function commitConfigurationTargetFanoutOperation(
  tx: FencedTransaction<PhysicalStorageTableName>,
  command: ConfigurationTargetFanoutOperationCommand,
  input: ConfigurationTargetFanoutOperationInput,
  current: ConfigurationTargetFanoutSource | undefined,
): Promise<
  SemanticOperationExecution<
    ConfigurationDomainResult<ConfigurationTargetFanoutOperationKind>,
    ConfigurationTargetFanoutOperationReceipt
  >
> {
  if (command.kind === 'text-template.delete') {
    return commitTextTemplateTargetFanout(
      tx,
      command,
      input,
      current as SavedTextTemplate | undefined,
    )
  }
  const promptPreset = current as PromptPreset
  const nextSource = nextPromptPresetTargetSource(command, promptPreset)
  const sourceMutation =
    nextSource === undefined
      ? ('delete' as const)
      : nextSource === current
        ? ('none' as const)
        : ('write' as const)
  const textChanged = nextSource !== undefined && nextSource.text !== promptPreset.text
  const targetQueryExecuted = textChanged || command.kind === 'prompt-preset.delete'
  const targetQuery = targetQueryExecuted
    ? await readConfigurationTargetFanoutLinks(tx, 'prompt-preset', promptPreset.id)
    : { links: Object.freeze([]), requestCount: 0 }
  const targetLinks = targetQuery.links
  const targetLinkIds = targetLinks.map(({ id }) => id).sort()
  for (const link of targetLinks) {
    if (link.ownerKind !== 'chat' && link.ownerKind !== 'chat-preset') {
      throw new Error(`ConfigurationLinkOwnerUnsupported:${link.ownerKey}`)
    }
  }
  const linkedChatIds = sortedUnique(
    targetLinks.filter(({ ownerKind }) => ownerKind === 'chat').map(({ ownerId }) => ownerId),
  )
  const linkedPresetIds = sortedUnique(
    targetLinks
      .filter(({ ownerKind }) => ownerKind === 'chat-preset')
      .map(({ ownerId }) => ownerId),
  )
  const chatReadIds = sortedUnique([
    ...linkedChatIds,
    ...(input.selectedChatId ? [input.selectedChatId] : []),
  ])
  const presetReadIds = sortedUnique(linkedPresetIds)
  const slot = promptPresetSlotForKind(promptPreset.kind)
  const targetFragment = createSemanticOperationExactReceiptAccumulator<PhysicalStorageTableName>()
  const chatClock = new TransactionChatUpdateClock()
  const linkedChatIdSet = new Set(linkedChatIds)
  const writtenChatIds: ChatId[] = []
  const writtenPresetIds: PresetId[] = []
  const sidebarChatIds = new Set<ChatId>()
  const affectedProfileIds = new Set<ProfileId>()
  let chatReadRequests = 0
  let presetReadRequests = 0
  let selectedConfigurationVersion: number | undefined

  const processChatPage = async (page: readonly ChatId[]): Promise<boolean> => {
    if (page.length === 0) return true
    const chatMutation = openLinkedChatMutation(tx)
    const chatRows = await chatMutation.readMany(page)
    chatReadRequests += 1
    if (chatRows.some((chat) => !chat)) {
      const missingIndex = chatRows.findIndex((chat) => !chat)
      const missingId = page[missingIndex] as ChatId
      if (missingId === input.selectedChatId) return false
      const link = targetLinks.find(
        ({ ownerKind, ownerId }) => ownerKind === 'chat' && ownerId === missingId,
      )
      throw new Error(`ConfigurationLinkOwnerMissing:${link?.ownerKey ?? missingId}`)
    }
    let pageChanged = false
    for (const previous of chatRows as readonly Chat[]) {
      const linked = linkedChatIdSet.has(previous.id)
      const settings = { ...previous.settings }
      if (linked && textChanged) {
        ;(settings as unknown as Record<string, unknown>)[slot.textKey] = nextSource.text
      }
      if (linked && command.kind === 'prompt-preset.delete') {
        delete (settings as Partial<ChatSettings>)[slot.pinKey]
      }
      if (command.kind === 'prompt-preset.overwrite-and-pin' && previous.id === command.chatId) {
        ;(settings as unknown as Record<string, unknown>)[slot.textKey] = command.text
        ;(settings as unknown as Record<string, unknown>)[slot.pinKey] = promptPreset.id
      }
      const transformed = withModelResolutionCancellation({ ...previous, settings }, true)
      if (!chatConfigurationChanged(previous, transformed)) {
        if (previous.id === input.selectedChatId) {
          selectedConfigurationVersion = previous.configurationVersion ?? 0
        }
        continue
      }
      const next = await configuredChat(tx, previous, transformed, command.now, chatClock)
      chatMutation.replaceLinked(previous.id, () => next)
      writtenChatIds.push(previous.id)
      pageChanged = true
      if (previous.id === input.selectedChatId) {
        selectedConfigurationVersion = next.configurationVersion ?? 0
      }
    }
    if (pageChanged) {
      const receipt = await chatMutation.commit()
      targetFragment.absorb(configurationTargetPhysicalFragment(receipt.fragment))
      if (
        receipt.sidebar.mutatedRowIds.length > 0 ||
        receipt.sidebar.aggregateMutations.length > 0
      ) {
        for (const { chatId } of receipt.chatWrites) sidebarChatIds.add(chatId)
      }
      for (const { profileId } of receipt.links.profileUsageMutations) {
        affectedProfileIds.add(profileId)
      }
    }
    return true
  }

  if (input.selectedChatId) {
    const selectedExists = await processChatPage([input.selectedChatId])
    if (!selectedExists) {
      return semanticOperationExecution(
        { kind: 'missing', entity: 'chat', id: input.selectedChatId } as const,
        configurationTargetFanoutOperationReceipt(input, {
          previousSource: promptPreset,
          targetQueryExecuted,
          targetQueryRequests: targetQuery.requestCount,
          targetLinkIds,
          chatReadRequests,
          chatReadIds: [input.selectedChatId],
        }),
      )
    }
  }
  const remainingChatIds = input.selectedChatId
    ? chatReadIds.filter((chatId) => chatId !== input.selectedChatId)
    : chatReadIds
  for (const page of configurationTargetFanoutPages(remainingChatIds)) {
    await processChatPage(page)
  }

  for (const page of configurationTargetFanoutPages(presetReadIds)) {
    const rows = await tx.table<ChatPreset, PresetId>('presets').bulkGet([...page])
    presetReadRequests += 1
    if (rows.some((preset) => !preset)) {
      const missingIndex = rows.findIndex((preset) => !preset)
      const missingId = page[missingIndex] as PresetId
      const link = targetLinks.find(
        ({ ownerKind, ownerId }) => ownerKind === 'chat-preset' && ownerId === missingId,
      )
      throw new Error(`ConfigurationLinkOwnerMissing:${link?.ownerKey ?? missingId}`)
    }
    const previousRows = rows as ChatPreset[]
    const nextRows: ChatPreset[] = []
    const changedPreviousRows: ChatPreset[] = []
    for (const previous of previousRows) {
      const settings = { ...previous.settings }
      if (textChanged) {
        ;(settings as unknown as Record<string, unknown>)[slot.textKey] = nextSource.text
      }
      if (command.kind === 'prompt-preset.delete') {
        delete (settings as Partial<ChatSettings>)[slot.pinKey]
      }
      if (sameChatSettings(previous.settings, settings)) continue
      changedPreviousRows.push(previous)
      nextRows.push({ ...previous, settings, updatedAt: command.now })
    }
    if (nextRows.length === 0) continue
    const links = await replaceLinkedSemanticByteOwnerBatch(
      tx,
      'presets',
      nextRows,
      changedPreviousRows,
    )
    const pageIds = nextRows.map(({ id }) => id)
    writtenPresetIds.push(...pageIds)
    for (const { profileId } of links.profileUsageMutations) affectedProfileIds.add(profileId)
    targetFragment.absorb(configurationPresetTargetMutationFragment(pageIds, links))
  }

  if (writtenChatIds.length > 0) {
    targetFragment.physicalRead({
      tableName: 'chats',
      indexKind: 'secondary',
      indexName: 'updatedAt',
      operation: 'query',
      requestCount: 1,
      rowCount: 1,
    })
  }
  targetFragment.dependency(
    ...(writtenChatIds.length > 0
      ? [{ kind: 'chat' as const, chatIds: [...writtenChatIds].sort() }]
      : []),
    ...(sidebarChatIds.size > 0
      ? [{ kind: 'sidebar' as const, chatIds: [...sidebarChatIds].sort() }]
      : []),
    ...(writtenPresetIds.length > 0
      ? [
          {
            kind: 'preset' as const,
            presetIds: [...writtenPresetIds].sort(),
            facets: ['selected-detail' as const],
          },
        ]
      : []),
    ...(affectedProfileIds.size > 0
      ? [
          {
            kind: 'profile' as const,
            profileIds: [...affectedProfileIds].sort(),
            facets: ['dependent-counts' as const],
          },
        ]
      : []),
  )

  let sourceProjection: ConfigurationCatalogProjectionMutationReceipt | undefined
  if (sourceMutation === 'write') {
    await replaceSemanticByteOwner(tx, 'promptPresets', nextSource as PromptPreset, promptPreset)
    sourceProjection = await applyConfigurationPromptPresetCatalogProjectionTransition(
      tx,
      promptPreset,
      nextSource as PromptPreset,
    )
  } else if (sourceMutation === 'delete') {
    await deleteSemanticByteOwner(tx, 'promptPresets', promptPreset.id, promptPreset)
    sourceProjection = await applyConfigurationPromptPresetCatalogProjectionDeletion(
      tx,
      promptPreset,
    )
  }
  writtenChatIds.sort()
  writtenPresetIds.sort()
  const sealedTargetFragment = targetFragment.sealFragment()
  const result =
    command.kind === 'prompt-preset.overwrite-and-pin'
      ? {
          kind: 'prompt-preset-saved' as const,
          preset: nextSource as PromptPreset,
          chatId: command.chatId,
          configurationVersion: selectedConfigurationVersion ?? 0,
          affectedChatIds: writtenChatIds,
          affectedPresetIds: writtenPresetIds,
          affectedChatCount: writtenChatIds.length,
          affectedPresetCount: writtenPresetIds.length,
        }
      : {
          kind: 'prompt-preset-saved' as const,
          ...(nextSource ? { preset: nextSource } : {}),
          affectedChatIds: writtenChatIds,
          affectedPresetIds: writtenPresetIds,
          affectedChatCount: writtenChatIds.length,
          affectedPresetCount: writtenPresetIds.length,
        }
  return semanticOperationExecution(
    result,
    configurationTargetFanoutOperationReceipt(input, {
      previousSource: promptPreset,
      nextSource,
      sourceMutation,
      sourceProjection,
      targetQueryExecuted,
      targetQueryRequests: targetQuery.requestCount,
      targetLinkIds,
      chatReadRequests,
      chatReadIds,
      presetReadRequests,
      presetReadIds,
      writtenPresetIds,
      writtenChatIds,
      targetFragment: sealedTargetFragment,
    }),
  )
}

async function commitTextTemplateTargetFanout(
  tx: FencedTransaction<PhysicalStorageTableName>,
  command: Extract<ConfigurationDomainCommand, { kind: 'text-template.delete' }>,
  input: ConfigurationTargetFanoutOperationInput,
  previousTemplate: SavedTextTemplate | undefined,
): Promise<
  SemanticOperationExecution<
    ConfigurationDomainResult<'text-template.delete'>,
    ConfigurationTargetFanoutOperationReceipt
  >
> {
  const targetQuery = await readConfigurationTargetFanoutLinks(tx, 'text-template', input.sourceId)
  const targetLinks = targetQuery.links
  const targetLinkIds = targetLinks.map(({ id }) => id).sort()
  for (const link of targetLinks) {
    if (link.ownerKind !== 'chat' && link.ownerKind !== 'chat-preset') {
      throw new Error(`ConfigurationLinkOwnerInvalid:${link.ownerKey}`)
    }
  }
  const chatReadIds = sortedUnique(
    targetLinks.filter(({ ownerKind }) => ownerKind === 'chat').map(({ ownerId }) => ownerId),
  )
  const presetReadIds = sortedUnique(
    targetLinks
      .filter(({ ownerKind }) => ownerKind === 'chat-preset')
      .map(({ ownerId }) => ownerId),
  )
  const targetFragment = createSemanticOperationExactReceiptAccumulator<PhysicalStorageTableName>()
  const chatClock = new TransactionChatUpdateClock()
  const writtenChatIds: ChatId[] = []
  const writtenPresetIds: PresetId[] = []
  const sidebarChatIds = new Set<ChatId>()
  const affectedProfileIds = new Set<ProfileId>()
  let chatReadRequests = 0
  let presetReadRequests = 0
  for (const page of configurationTargetFanoutPages(chatReadIds)) {
    const chatMutation = openLinkedChatMutation(tx)
    const rows = await chatMutation.readMany(page)
    chatReadRequests += 1
    if (rows.some((chat) => !chat)) {
      const missingIndex = rows.findIndex((chat) => !chat)
      const missingId = page[missingIndex] as ChatId
      const link = targetLinks.find(
        ({ ownerKind, ownerId }) => ownerKind === 'chat' && ownerId === missingId,
      )
      throw new Error(`ConfigurationLinkOwnerMissing:${link?.ownerKey ?? missingId}`)
    }
    for (const previous of rows as readonly Chat[]) {
      const transformed = withModelResolutionCancellation(
        {
          ...previous,
          settings: { ...previous.settings, textTemplate: 'chatml' },
        },
        true,
      )
      const next = await configuredChat(tx, previous, transformed, command.now, chatClock)
      chatMutation.replaceLinked(previous.id, () => next)
      writtenChatIds.push(previous.id)
    }
    const receipt = await chatMutation.commit()
    targetFragment.absorb(configurationTargetPhysicalFragment(receipt.fragment))
    if (receipt.sidebar.mutatedRowIds.length > 0 || receipt.sidebar.aggregateMutations.length > 0) {
      for (const { chatId } of receipt.chatWrites) sidebarChatIds.add(chatId)
    }
    for (const { profileId } of receipt.links.profileUsageMutations) {
      affectedProfileIds.add(profileId)
    }
  }
  for (const page of configurationTargetFanoutPages(presetReadIds)) {
    const rows = await tx.table<ChatPreset, PresetId>('presets').bulkGet([...page])
    presetReadRequests += 1
    if (rows.some((preset) => !preset)) {
      const missingIndex = rows.findIndex((preset) => !preset)
      const missingId = page[missingIndex] as PresetId
      const link = targetLinks.find(
        ({ ownerKind, ownerId }) => ownerKind === 'chat-preset' && ownerId === missingId,
      )
      throw new Error(`ConfigurationLinkOwnerMissing:${link?.ownerKey ?? missingId}`)
    }
    const previousRows = rows as ChatPreset[]
    const nextRows = previousRows.map(
      (preset): ChatPreset => ({
        ...preset,
        settings: { ...preset.settings, textTemplate: 'chatml' },
        updatedAt: command.now,
      }),
    )
    const links = await replaceLinkedSemanticByteOwnerBatch(tx, 'presets', nextRows, previousRows)
    const pageIds = nextRows.map(({ id }) => id)
    writtenPresetIds.push(...pageIds)
    for (const { profileId } of links.profileUsageMutations) affectedProfileIds.add(profileId)
    targetFragment.absorb(configurationPresetTargetMutationFragment(pageIds, links))
  }
  if (writtenChatIds.length > 0) {
    targetFragment.physicalRead({
      tableName: 'chats',
      indexKind: 'secondary',
      indexName: 'updatedAt',
      operation: 'query',
      requestCount: 1,
      rowCount: 1,
    })
  }
  targetFragment.dependency(
    ...(writtenChatIds.length > 0
      ? [{ kind: 'chat' as const, chatIds: [...writtenChatIds].sort() }]
      : []),
    ...(sidebarChatIds.size > 0
      ? [{ kind: 'sidebar' as const, chatIds: [...sidebarChatIds].sort() }]
      : []),
    ...(writtenPresetIds.length > 0
      ? [
          {
            kind: 'preset' as const,
            presetIds: [...writtenPresetIds].sort(),
            facets: ['selected-detail' as const],
          },
        ]
      : []),
    ...(affectedProfileIds.size > 0
      ? [
          {
            kind: 'profile' as const,
            profileIds: [...affectedProfileIds].sort(),
            facets: ['dependent-counts' as const],
          },
        ]
      : []),
  )

  if (previousTemplate) {
    await deleteTextTemplateByteOwner(tx, previousTemplate.id, previousTemplate)
  }

  writtenChatIds.sort()
  writtenPresetIds.sort()
  const receipt = configurationTargetFanoutOperationReceipt(input, {
    previousSource: previousTemplate,
    sourceMutation: previousTemplate ? 'delete' : 'none',
    targetQueryExecuted: true,
    targetQueryRequests: targetQuery.requestCount,
    targetLinkIds,
    chatReadRequests,
    chatReadIds,
    presetReadRequests,
    presetReadIds,
    writtenPresetIds,
    writtenChatIds,
    targetFragment: targetFragment.sealFragment(),
  })
  return semanticOperationExecution(
    {
      kind: 'text-template-saved',
      templateId: command.templateId,
      changed: previousTemplate !== undefined || targetLinks.length > 0,
      deleted: previousTemplate !== undefined,
      affectedChatIds: writtenChatIds,
      affectedPresetIds: writtenPresetIds,
    } as const,
    receipt,
  )
}

const CONNECTION_REQUEST_MATERIAL_PATCH_KEYS = new Set<keyof ConnectionProfile>([
  'kind',
  'baseUrl',
  'apiKeyRef',
  'apiKeyFallbackRefs',
  'managementApiKeyRef',
  'defaultHeaders',
  'appTitle',
  'appUrl',
  'appCategories',
  'supportsEndpointsApi',
  'supportsGenerationApi',
  'supportsPrivacyScrape',
  'capabilityOverrides',
])

function connectionEditRequestMaterialMayChange(
  command: Extract<ConnectionProfileLifecycleOperationCommand, { kind: 'connection.edit' }>,
): boolean {
  return Object.keys(command.patch).some((key) =>
    CONNECTION_REQUEST_MATERIAL_PATCH_KEYS.has(key as keyof ConnectionProfile),
  )
}

function connectionProfileLifecycleOperationInput(
  command: ConnectionProfileLifecycleOperationCommand,
): ConnectionProfileLifecycleOperationInput {
  switch (command.kind) {
    case 'connection.create': {
      const initialPreset = command.initialPreset
        ? {
            ...command.initialPreset,
            createdAt: command.now,
            updatedAt: command.now,
          }
        : undefined
      const links = [
        ...configurationLinksForProfile(command.profile),
        ...(initialPreset ? configurationLinksForPreset(initialPreset) : []),
      ]
      const keyIdToValidate = command.key?.id ?? command.profile.apiKeyRef ?? null
      return {
        operationKind: command.kind,
        profileId: command.profile.id,
        sourceProfileId: null,
        keyIdToValidate,
        initialPresetId: initialPreset?.id ?? null,
        resetChatId: null,
        requestMaterialMayChange: false,
        resourceNames: configurationLockNames(
          [
            `profile:${command.profile.id}`,
            ...(keyIdToValidate ? [`key:${keyIdToValidate}`] : []),
            ...(initialPreset ? ['preset-order', `preset:${initialPreset.id}`] : []),
          ],
          links,
        ),
      }
    }
    case 'connection.edit': {
      const patchKeyIds = [
        command.replacementKey?.id,
        command.patch.apiKeyRef,
        ...(command.patch.apiKeyFallbackRefs ?? []),
        command.patch.managementApiKeyRef,
      ].filter((keyId): keyId is KeyId => typeof keyId === 'string' && keyId.length > 0)
      const requestMaterialMayChange = connectionEditRequestMaterialMayChange(command)
      return {
        operationKind: command.kind,
        profileId: command.profileId,
        sourceProfileId: command.profileId,
        keyIdToValidate:
          command.replacementKey?.id ??
          (typeof command.patch.apiKeyRef === 'string' ? command.patch.apiKeyRef : null),
        initialPresetId: null,
        resetChatId: command.resetModelChatId ?? null,
        requestMaterialMayChange,
        resourceNames: sortedUnique([
          `profile:${command.profileId}`,
          ...(command.resetModelChatId ? [`chat-meta:${command.resetModelChatId}`] : []),
          ...patchKeyIds.flatMap((keyId) => [
            `configuration-target:${configurationTargetKey('key', keyId)}`,
            `key:${keyId}`,
          ]),
          ...(requestMaterialMayChange
            ? [
                `discovery-cache:models:${command.profileId}`,
                `discovery-cache:endpoints:${command.profileId}`,
                `discovery-cache:privacyPolicies:${command.profileId}`,
              ]
            : []),
        ]),
      }
    }
    case 'connection.duplicate':
      return {
        operationKind: command.kind,
        profileId: command.copyId,
        sourceProfileId: command.sourceId,
        keyIdToValidate: null,
        initialPresetId: null,
        resetChatId: null,
        requestMaterialMayChange: false,
        resourceNames: sortedUnique([`profile:${command.sourceId}`, `profile:${command.copyId}`]),
      }
  }
}

function connectionProfileLifecycleOperationTransaction(
  input: ConnectionProfileLifecycleOperationInput,
): PhysicalTransactionCapability {
  if (input.operationKind === 'connection.create') {
    return physicalStorageTables(
      ...CONFIGURATION_LINK_MUTATION_TRANSACTION_CAPABILITY.tableNames,
      ...CONFIGURATION_PROFILE_CATALOG_TRANSACTION_CAPABILITY.tableNames,
      'profiles',
      ...(input.keyIdToValidate ? (['keys'] as const) : []),
      ...(input.initialPresetId
        ? [
            ...CONFIGURATION_PRESET_CATALOG_TRANSACTION_CAPABILITY.tableNames,
            ...PRESET_ORDER_MUTATION_TRANSACTION_CAPABILITY.tableNames,
            'presets' as const,
          ]
        : []),
    )
  }
  if (input.operationKind === 'connection.edit') {
    return physicalStorageTables(
      ...CONFIGURATION_LINK_MUTATION_TRANSACTION_CAPABILITY.tableNames,
      ...CONFIGURATION_PROFILE_CATALOG_TRANSACTION_CAPABILITY.tableNames,
      'profiles',
      ...(input.keyIdToValidate ? (['keys'] as const) : []),
      ...(input.resetChatId ? CHAT_ROW_LINKED_TRANSACTION_CAPABILITY.tableNames : []),
      ...(input.requestMaterialMayChange
        ? DISCOVERY_CACHE_MUTATION_TRANSACTION_CAPABILITY.tableNames
        : []),
    )
  }
  return physicalStorageTables(
    ...CONFIGURATION_LINK_MUTATION_TRANSACTION_CAPABILITY.tableNames,
    ...CONFIGURATION_PROFILE_CATALOG_TRANSACTION_CAPABILITY.tableNames,
    'profiles',
  )
}

function connectionProfileLifecycleOperationDescriptor(
  input: ConnectionProfileLifecycleOperationInput,
) {
  const transaction = connectionProfileLifecycleOperationTransaction(input)
  return semanticOperationDescriptor<
    ReturnType<typeof configurationSemanticOperationKind>,
    PhysicalTransactionCapability,
    ConnectionProfileLifecycleOperationInput,
    SemanticOperationExactReceipt<PhysicalStorageTableName>
  >({
    operationKind: configurationSemanticOperationKind(input.operationKind),
    transaction,
    resources: ({ resourceNames }) => resourceNames,
    permittedWrites: transaction.tableNames,
    requiredWritesWhenMutated: [],
    ...semanticOperationExactReceiptContracts<
      ConnectionProfileLifecycleOperationInput,
      PhysicalStorageTableName
    >(),
    replay:
      semanticOperationExactReceiptReplayProofContract<ConnectionProfileLifecycleOperationInput>(
        assertConfigurationSingleAttemptReplayProof,
      ),
  })
}

function connectionProfileLifecycleOperationExactPlan(): SemanticOperationExactPlan {
  return semanticOperationExactPlan({
    replay: { kind: 'single-attempt', reason: 'unfenced-relative-update' },
    bounds: {
      reads: {
        maxRequests: 4_096,
        maxRows: 4_096,
        maxBatchRows: 529,
        maxBytes: Number.MAX_SAFE_INTEGER,
      },
      writes: {
        maxRequests: 8_192,
        maxRows: 8_192,
        maxBatchRows: 529,
        maxBytes: Number.MAX_SAFE_INTEGER,
      },
    },
  })
}

function connectionProfileLifecycleOperationDependencies(
  input: ConnectionProfileLifecycleOperationInput,
  receipt: ConnectionProfileLifecycleOperationReceipt,
): readonly WorkspaceDependency[] {
  const initialPreset = receipt.initialPreset
  const dependentProfileIds = sortedUnique([
    ...receipt.profileLinks.profileUsageMutations.map(({ profileId }) => profileId),
    ...(initialPreset?.links.profileUsageMutations.map(({ profileId }) => profileId) ?? []),
    ...(receipt.resetChat.transition?.links.profileUsageMutations.map(
      ({ profileId }) => profileId,
    ) ?? []),
  ])
  return normalizeWorkspaceDependencies([
    ...(receipt.profileMutation === 'write'
      ? workspaceDependenciesForConfigurationSemanticMutation({
          kind: 'profile' as const,
          previous: receipt.previousProfile,
          next: receipt.nextProfile,
        })
      : []),
    ...(receipt.key?.mutation === 'write'
      ? workspaceDependenciesForConfigurationSemanticMutation({
          kind: 'key' as const,
          previous: receipt.key.previous,
          next: receipt.key.next,
        })
      : []),
    ...(initialPreset?.next
      ? workspaceDependenciesForConfigurationSemanticMutation({
          kind: 'preset' as const,
          previous: initialPreset.previous,
          next: initialPreset.next,
        })
      : []),
    ...(initialPreset?.order.changed || initialPreset?.catalog?.order.changed
      ? [
          {
            kind: 'preset' as const,
            presetIds: [initialPreset.presetId],
            facets: ['catalog-order' as const],
          },
        ]
      : []),
    ...linkedChatTransitionDependencies(input.resetChatId ?? '', receipt.resetChat.transition),
    ...(dependentProfileIds.length > 0
      ? [
          {
            kind: 'profile' as const,
            profileIds: dependentProfileIds,
            facets: ['dependent-counts' as const],
          },
        ]
      : []),
    ...(receipt.discovery
      ? [
          {
            kind: 'discovery-cache' as const,
            cacheKinds: ['endpoints' as const, 'models' as const, 'privacy' as const],
            profileIds: [receipt.discovery.profileId],
          },
        ]
      : []),
    ...(receipt.discovery?.repairRequired
      ? [
          {
            kind: 'storage-maintenance' as const,
            tasks: ['prune-discovery-cache'] as const,
          },
        ]
      : []),
  ])
}

function configurationOwnerLinkPhysicalReads(
  receipt: ConfigurationOwnerLinkMutationReceipt,
): readonly SemanticOperationExactPhysicalRead[] {
  return [
    ...(receipt.ownerQueryRequests > 0
      ? [
          {
            tableName: 'configurationLinks' as const,
            indexKind: 'secondary' as const,
            indexName: 'ownerKey',
            operation: 'open-cursor' as const,
            requestCount: receipt.ownerQueryRequests,
            rowCount: receipt.ownerQueryRowCount,
          },
        ]
      : []),
    ...(receipt.profileUsageReadRequests > 0
      ? [
          {
            tableName: 'configurationProfileUsageRows' as const,
            indexKind: 'primary' as const,
            operation: 'get-many' as const,
            requestCount: receipt.profileUsageReadRequests,
            rowCount: receipt.profileUsageMutations.length,
          },
        ]
      : []),
    ...(receipt.profileManagerRevisionChanged
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
  ]
}

function configurationCatalogProjectionPhysicalReads(
  receipt: ConfigurationCatalogProjectionMutationReceipt | undefined,
): readonly SemanticOperationExactPhysicalRead[] {
  return receipt && receipt.aggregateIds.length > 0
    ? [
        {
          tableName: 'configurationCatalogAggregates',
          indexKind: 'primary',
          operation: 'get',
          requestCount: receipt.aggregateIds.length,
          rowCount: receipt.aggregateIds.length,
        },
      ]
    : []
}

function connectionProfileLifecycleOperationExactReceipt(
  tx: FencedTransaction<PhysicalStorageTableName>,
  plan: SemanticOperationExactPlan,
  input: ConnectionProfileLifecycleOperationInput,
  receipt: ConnectionProfileLifecycleOperationReceipt,
): SemanticOperationExactReceipt<PhysicalStorageTableName> {
  const accumulator = boundSemanticOperationExactReceiptAccumulator<PhysicalStorageTableName>(tx)
  const fragment = accumulator?.snapshotFragment()
  const didMutateStorage = accumulator
    ? (fragment?.physicalMutations.length ?? 0) > 0
    : receipt.profileMutation === 'write' ||
      receipt.key?.mutation === 'write' ||
      (receipt.initialPreset?.next !== undefined &&
        receipt.initialPreset.next !== receipt.initialPreset.previous) ||
      receipt.resetChat.mutation === 'write' ||
      (receipt.discovery !== undefined &&
        (receipt.discovery.deleted > 0 || receipt.discovery.repairRequired))
  assertConnectionProfileLifecycleOperationReceipt(input, didMutateStorage, receipt)
  return semanticOperationExactReceipt(plan, {
    dependencies: didMutateStorage
      ? normalizeWorkspaceDependencies([
          ...(fragment?.dependencies ?? []),
          ...connectionProfileLifecycleOperationDependencies(input, receipt),
        ])
      : [],
    physicalMutations: fragment?.physicalMutations ?? [],
    physicalReads: aggregateExactPhysicalReads([
      ...(fragment?.physicalReads ?? []),
      ...configurationOwnerLinkPhysicalReads(receipt.profileLinks),
      ...configurationCatalogProjectionPhysicalReads(receipt.profileProjection),
      ...(receipt.initialPreset
        ? presetLifecycleOperationPhysicalReads(
            {
              presetId: receipt.initialPreset.presetId,
              resourceNames: [],
            },
            receipt.initialPreset,
          )
        : []),
      ...linkedChatTransitionPhysicalReads(receipt.resetChat.transition),
    ]),
  })
}

function recordConnectionProfileLifecyclePhysicalRead(
  tx: FencedTransaction<PhysicalStorageTableName>,
  read: SemanticOperationExactPhysicalRead,
): void {
  const accumulator = boundSemanticOperationExactReceiptAccumulator<PhysicalStorageTableName>(tx)
  accumulator?.physicalRead(read)
}

function connectionProfileLifecycleOperationReceipt(
  input: ConnectionProfileLifecycleOperationInput,
  values: Partial<
    Omit<
      ConnectionProfileLifecycleOperationReceipt,
      'operationKind' | 'profileId' | 'sourceProfileId' | 'profileMutation'
    >
  >,
): ConnectionProfileLifecycleOperationReceipt {
  const previousProfile = values.previousProfile
  const nextProfile = values.nextProfile ?? previousProfile
  return Object.freeze({
    operationKind: input.operationKind,
    profileId: input.profileId,
    sourceProfileId: input.sourceProfileId,
    sourceProfile: values.sourceProfile,
    previousProfile,
    nextProfile,
    profileMutation:
      nextProfile !== undefined && nextProfile !== previousProfile ? ('write' as const) : 'none',
    profileLinks: values.profileLinks ?? emptyConfigurationOwnerLinkMutationReceipt(),
    profileProjection: values.profileProjection,
    key: values.key,
    initialPreset: values.initialPreset,
    resetChat: values.resetChat ?? chatConfigurationOperationReceipt(undefined, undefined),
    discovery: values.discovery,
    fallbackProfileId: values.fallbackProfileId,
  })
}

function assertConnectionProfileLifecycleOperationReceipt(
  input: ConnectionProfileLifecycleOperationInput,
  didMutateStorage: boolean,
  receipt: ConnectionProfileLifecycleOperationReceipt,
): void {
  const profileChanged = receipt.profileMutation === 'write'
  const keyChanged = receipt.key?.mutation === 'write'
  const presetChanged =
    receipt.initialPreset?.next !== undefined &&
    receipt.initialPreset.next !== receipt.initialPreset.previous
  const chatChanged = receipt.resetChat.mutation === 'write'
  const discoveryChanged =
    receipt.discovery !== undefined &&
    (receipt.discovery.deleted > 0 || receipt.discovery.repairRequired)
  if (receipt.key) {
    const keyId = receipt.key.next?.id ?? receipt.key.previous?.id
    if (!keyId || input.keyIdToValidate !== keyId) {
      throw new Error(
        `ConnectionProfileLifecycleKeyIdentityInvalid:${input.operationKind}:${input.profileId}`,
      )
    }
    assertKeyMaterialOperationReceipt(keyId, keyChanged, receipt.key)
  }
  if (
    receipt.operationKind !== input.operationKind ||
    receipt.profileId !== input.profileId ||
    receipt.sourceProfileId !== input.sourceProfileId ||
    (receipt.previousProfile !== undefined && receipt.previousProfile.id !== input.profileId) ||
    (receipt.sourceProfile !== undefined &&
      (input.sourceProfileId === null || receipt.sourceProfile.id !== input.sourceProfileId)) ||
    (receipt.nextProfile !== undefined && receipt.nextProfile.id !== input.profileId) ||
    profileChanged !== (receipt.profileProjection !== undefined) ||
    (receipt.key !== undefined &&
      keyChanged !==
        (receipt.key.next !== undefined && receipt.key.next !== receipt.key.previous)) ||
    (receipt.initialPreset !== undefined &&
      (input.initialPresetId === null ||
        receipt.initialPreset.presetId !== input.initialPresetId)) ||
    (input.resetChatId === null && chatChanged) ||
    (input.resetChatId !== null &&
      ((receipt.resetChat.previous !== undefined &&
        receipt.resetChat.previous.id !== input.resetChatId) ||
        (receipt.resetChat.next !== undefined &&
          receipt.resetChat.next.id !== input.resetChatId))) ||
    (receipt.discovery !== undefined &&
      (!input.requestMaterialMayChange ||
        receipt.discovery.profileId !== (input.sourceProfileId ?? input.profileId))) ||
    didMutateStorage !==
      (profileChanged || keyChanged || Boolean(presetChanged) || chatChanged || discoveryChanged)
  ) {
    throw new Error(
      `ConnectionProfileLifecycleOperationReceiptInvalid:${input.operationKind}:${input.profileId}`,
    )
  }
}

function executeConnectionProfileLifecycleOperation<
  Command extends ConnectionProfileLifecycleOperationCommand,
>(
  commandMeta: ConfigurationCommandMetaPort,
  command: Command,
): Promise<ConfigurationDomainResult<Command['kind']>> {
  const plan = connectionProfileLifecycleOperationExactPlan()
  const input = connectionProfileLifecycleOperationInput(command)
  return commandMeta.executeSemanticOperation(
    connectionProfileLifecycleOperationDescriptor(input),
    input,
    async (tx) => {
      const execution = await commitConnectionProfileLifecycleOperation(tx, command, input)
      return semanticOperationExecution(
        execution.value,
        connectionProfileLifecycleOperationExactReceipt(tx, plan, input, execution.receipt),
      )
    },
  ) as Promise<ConfigurationDomainResult<Command['kind']>>
}

function connectionDeleteOperationInput(
  command: Extract<ConfigurationDomainCommand, { kind: 'connection.delete' }>,
): ConnectionDeleteOperationInput {
  const replacementProfileId = command.reassignTo ?? null
  return {
    profileId: command.profileId,
    replacementProfileId,
    resourceNames: sortedUnique([
      `profile:${command.profileId}`,
      configurationTargetResourceName('profile', command.profileId),
      `discovery-cache:models:${command.profileId}`,
      `discovery-cache:endpoints:${command.profileId}`,
      `discovery-cache:privacyPolicies:${command.profileId}`,
      ...(replacementProfileId
        ? [
            'preset-order',
            `profile:${replacementProfileId}`,
            configurationTargetResourceName('profile', replacementProfileId),
          ]
        : []),
    ]),
  }
}

function connectionDeleteOperationTransaction(
  input: ConnectionDeleteOperationInput,
): PhysicalTransactionCapability {
  return physicalStorageTables(
    ...CONFIGURATION_LINK_MUTATION_TRANSACTION_CAPABILITY.tableNames,
    ...CONFIGURATION_PROFILE_CATALOG_TRANSACTION_CAPABILITY.tableNames,
    ...DISCOVERY_CACHE_MUTATION_TRANSACTION_CAPABILITY.tableNames,
    'keys',
    'profiles',
    ...(input.replacementProfileId
      ? [
          ...CHAT_ROW_LINKED_TRANSACTION_CAPABILITY.tableNames,
          ...CONFIGURATION_PRESET_CATALOG_TRANSACTION_CAPABILITY.tableNames,
          'presets' as const,
        ]
      : []),
  )
}

function connectionDeleteOperationDescriptor(input: ConnectionDeleteOperationInput) {
  const transaction = connectionDeleteOperationTransaction(input)
  return semanticOperationDescriptor<
    ReturnType<typeof configurationSemanticOperationKind>,
    PhysicalTransactionCapability,
    ConnectionDeleteOperationInput,
    SemanticOperationExactReceipt<PhysicalStorageTableName>
  >({
    operationKind: configurationSemanticOperationKind('connection.delete'),
    transaction,
    resources: ({ resourceNames }) => resourceNames,
    permittedWrites: transaction.tableNames,
    requiredWritesWhenMutated: [],
    ...semanticOperationExactReceiptContracts<
      ConnectionDeleteOperationInput,
      PhysicalStorageTableName
    >(),
    replay: semanticOperationExactReceiptReplayProofContract<ConnectionDeleteOperationInput>(
      assertConfigurationSingleAttemptReplayProof,
    ),
  })
}

function connectionDeleteOperationExactPlan(): SemanticOperationExactPlan {
  return semanticOperationExactPlan({
    replay: { kind: 'single-attempt', reason: 'unfenced-relative-update' },
    bounds: {
      reads: {
        maxRequests: Number.MAX_SAFE_INTEGER,
        maxRows: Number.MAX_SAFE_INTEGER,
        maxBatchRows: Number.MAX_SAFE_INTEGER,
        maxBytes: Number.MAX_SAFE_INTEGER,
      },
      writes: {
        maxRequests: Number.MAX_SAFE_INTEGER,
        maxRows: Number.MAX_SAFE_INTEGER,
        maxBatchRows: Number.MAX_SAFE_INTEGER,
        maxBytes: Number.MAX_SAFE_INTEGER,
      },
    },
  })
}

function connectionDeleteOperationDependencies(
  receipt: ConnectionDeleteOperationReceipt,
): readonly WorkspaceDependency[] {
  const profileIds = sortedUnique([
    ...receipt.profileLinks.profileUsageMutations.map(({ profileId }) => profileId),
  ])
  return normalizeWorkspaceDependencies([
    ...workspaceDependenciesForConfigurationSemanticMutation({
      kind: 'profile' as const,
      previous: receipt.previousProfile,
      next: undefined,
    }),
    ...receipt.targetFragment.dependencies,
    ...receipt.keys
      .filter(({ deleted }) => deleted)
      .flatMap(({ previous }) =>
        workspaceDependenciesForConfigurationSemanticMutation({
          kind: 'key' as const,
          previous,
          next: undefined,
        }),
      ),
    ...(profileIds.length > 0
      ? [
          {
            kind: 'profile' as const,
            profileIds,
            facets: ['dependent-counts' as const],
          },
        ]
      : []),
    ...(receipt.discovery
      ? [
          {
            kind: 'discovery-cache' as const,
            cacheKinds: ['endpoints' as const, 'models' as const, 'privacy' as const],
            profileIds: [receipt.discovery.profileId],
          },
        ]
      : []),
    ...(receipt.discovery?.repairRequired
      ? [
          {
            kind: 'storage-maintenance' as const,
            tasks: ['prune-discovery-cache'] as const,
          },
        ]
      : []),
  ])
}

function connectionDeleteOperationReceipt(
  input: ConnectionDeleteOperationInput,
  values: Partial<
    Omit<
      ConnectionDeleteOperationReceipt,
      'operationKind' | 'profileId' | 'replacementProfileId' | 'usage'
    >
  > & {
    readonly usage?: ConfigurationProfileUsageProjectionRow
  },
): ConnectionDeleteOperationReceipt {
  return Object.freeze({
    operationKind: 'connection.delete',
    profileId: input.profileId,
    replacementProfileId: input.replacementProfileId,
    sourceQueryExecuted: values.sourceQueryExecuted ?? false,
    previousProfile: values.previousProfile,
    replacementProfile: values.replacementProfile,
    replacementQueryExecuted: values.replacementQueryExecuted ?? false,
    usage: values.usage ?? emptyConfigurationProfileUsageProjectionRow(input.profileId),
    targetQueryExecuted: values.targetQueryExecuted ?? false,
    targetQueryRequests: values.targetQueryRequests ?? 0,
    targetLinkIds: Object.freeze([...(values.targetLinkIds ?? [])]),
    presetReadRequests: values.presetReadRequests ?? 0,
    presetReadIds: Object.freeze([...(values.presetReadIds ?? [])]),
    chatReadRequests: values.chatReadRequests ?? 0,
    chatReadIds: Object.freeze([...(values.chatReadIds ?? [])]),
    writtenPresetIds: Object.freeze([...(values.writtenPresetIds ?? [])]),
    writtenChatIds: Object.freeze([...(values.writtenChatIds ?? [])]),
    targetFragment: values.targetFragment ?? semanticOperationReceiptFragment({}),
    profileLinks: values.profileLinks ?? emptyConfigurationOwnerLinkMutationReceipt(),
    profileCatalog: values.profileCatalog,
    discovery: values.discovery,
    keys: Object.freeze([...(values.keys ?? [])]),
    fallbackProfileId: values.fallbackProfileId,
  })
}

function assertConnectionDeleteOperationReceipt(
  input: ConnectionDeleteOperationInput,
  didMutateStorage: boolean,
  receipt: ConnectionDeleteOperationReceipt,
): void {
  const sourceDeleted = receipt.profileCatalog !== undefined
  const removedTargetLinks = new Set(
    receipt.targetFragment.physicalMutations.flatMap((mutation) =>
      mutation.tableName === 'configurationLinks' &&
      (mutation.operation === 'delete' || mutation.operation === 'write')
        ? [mutation.key]
        : [],
    ),
  )
  const physicallyWrittenPresetIds = new Set(
    receipt.targetFragment.physicalMutations.flatMap((mutation) =>
      mutation.tableName === 'presets' && mutation.operation === 'write' ? [mutation.key] : [],
    ),
  )
  const physicallyWrittenChatIds = new Set(
    receipt.targetFragment.physicalMutations.flatMap((mutation) =>
      mutation.tableName === 'chats' && mutation.operation === 'write' ? [mutation.key] : [],
    ),
  )
  if (
    receipt.profileId !== input.profileId ||
    receipt.replacementProfileId !== input.replacementProfileId ||
    (receipt.previousProfile !== undefined && !receipt.sourceQueryExecuted) ||
    (receipt.previousProfile !== undefined && receipt.previousProfile.id !== input.profileId) ||
    (receipt.replacementProfile !== undefined &&
      receipt.replacementProfile.id !== input.replacementProfileId) ||
    (receipt.replacementProfile !== undefined && !receipt.replacementQueryExecuted) ||
    (receipt.replacementQueryExecuted && input.replacementProfileId === null) ||
    sourceDeleted !== didMutateStorage ||
    sourceDeleted !== (receipt.discovery !== undefined) ||
    sourceDeleted !== (receipt.fallbackProfileId !== undefined) ||
    sourceDeleted !== receipt.profileLinks.ownerQueryRequests > 0 ||
    !sameConfigurationValue(receipt.targetLinkIds, sortedUnique(receipt.targetLinkIds)) ||
    !sameConfigurationValue(receipt.presetReadIds, sortedUnique(receipt.presetReadIds)) ||
    !sameConfigurationValue(receipt.chatReadIds, sortedUnique(receipt.chatReadIds)) ||
    !sameConfigurationValue(receipt.writtenPresetIds, sortedUnique(receipt.writtenPresetIds)) ||
    !sameConfigurationValue(receipt.writtenChatIds, sortedUnique(receipt.writtenChatIds)) ||
    receipt.writtenPresetIds.some(
      (id) => !receipt.presetReadIds.includes(id) || !physicallyWrittenPresetIds.has(id),
    ) ||
    receipt.writtenChatIds.some(
      (id) => !receipt.chatReadIds.includes(id) || !physicallyWrittenChatIds.has(id),
    ) ||
    physicallyWrittenPresetIds.size !== receipt.writtenPresetIds.length ||
    physicallyWrittenChatIds.size !== receipt.writtenChatIds.length ||
    (!receipt.targetQueryExecuted &&
      (receipt.targetQueryRequests !== 0 || receipt.targetLinkIds.length > 0)) ||
    (receipt.targetQueryExecuted && receipt.targetQueryRequests < 1) ||
    (receipt.presetReadIds.length === 0) !== (receipt.presetReadRequests === 0) ||
    (receipt.presetReadIds.length > 0 && receipt.presetReadRequests < 1) ||
    (receipt.chatReadIds.length === 0) !== (receipt.chatReadRequests === 0) ||
    (receipt.chatReadIds.length > 0 && receipt.chatReadRequests < 1) ||
    receipt.targetLinkIds.some((id) => !removedTargetLinks.has(id)) ||
    receipt.keys.some(
      ({ targetQueryExecuted, remainingProfileIds, previous, deleted }) =>
        !targetQueryExecuted ||
        deleted !== (previous !== undefined && remainingProfileIds.length === 0),
    )
  ) {
    throw new Error(
      `ConnectionDeleteOperationReceiptInvalid:${input.profileId}:${JSON.stringify({
        didMutateStorage,
        sourceDeleted,
        discovery: receipt.discovery !== undefined,
        fallback: receipt.fallbackProfileId !== undefined,
        profileOwnerQueries: receipt.profileLinks.ownerQueryRequests,
        readPresets: receipt.presetReadIds.length,
        writtenPresets: receipt.writtenPresetIds.length,
        writtenChats: receipt.writtenChatIds.length,
        targetLinks: receipt.targetLinkIds.length,
        removedTargetLinks: removedTargetLinks.size,
        keys: receipt.keys.map(({ keyId, remainingProfileIds, previous, deleted }) => ({
          keyId,
          remainingProfiles: remainingProfileIds.length,
          previous: previous !== undefined,
          deleted,
        })),
      })}`,
    )
  }
}

function connectionDeleteCatalogPhysicalReads(
  receipt: ConfigurationPresetCatalogMutationReceipt,
): readonly SemanticOperationExactPhysicalRead[] {
  return [
    ...configurationCatalogProjectionPhysicalReads(receipt.projection),
    ...receipt.order.reads.map((read) => ({ ...read, indexKind: 'primary' as const })),
  ]
}

function connectionDeleteOperationPhysicalReads(
  input: ConnectionDeleteOperationInput,
  receipt: ConnectionDeleteOperationReceipt,
): readonly SemanticOperationExactPhysicalRead[] {
  return aggregateExactPhysicalReads([
    ...(receipt.sourceQueryExecuted
      ? [
          {
            tableName: 'profiles' as const,
            indexKind: 'primary' as const,
            operation: 'get' as const,
            requestCount: 1,
            rowCount: 1,
          },
          {
            tableName: 'configurationProfileUsageRows' as const,
            indexKind: 'primary' as const,
            operation: 'get' as const,
            requestCount: 1,
            rowCount: 1,
          },
        ]
      : []),
    ...(receipt.replacementQueryExecuted
      ? [
          {
            tableName: 'profiles' as const,
            indexKind: 'primary' as const,
            operation: 'get' as const,
            requestCount: 1,
            rowCount: 1,
          },
        ]
      : []),
    ...(receipt.targetQueryExecuted
      ? [
          {
            tableName: 'configurationLinks' as const,
            indexKind: 'secondary' as const,
            indexName: '[targetKey+id]',
            operation: 'query' as const,
            requestCount: receipt.targetQueryRequests,
            rowCount: receipt.targetLinkIds.length,
          },
        ]
      : []),
    ...(receipt.presetReadIds.length > 0
      ? [
          {
            tableName: 'presets' as const,
            indexKind: 'primary' as const,
            operation: 'get-many' as const,
            requestCount: receipt.presetReadRequests,
            rowCount: receipt.presetReadIds.length,
          },
        ]
      : []),
    ...(receipt.chatReadIds.length > 0
      ? [
          {
            tableName: 'chats' as const,
            indexKind: 'primary' as const,
            operation: 'get-many' as const,
            requestCount: receipt.chatReadRequests,
            rowCount: receipt.chatReadIds.length,
          },
        ]
      : []),
    ...receipt.targetFragment.physicalReads,
    ...configurationOwnerLinkPhysicalReads(receipt.profileLinks),
    ...configurationCatalogProjectionPhysicalReads(receipt.profileCatalog),
    ...(receipt.fallbackProfileId !== undefined && input.replacementProfileId === null
      ? [
          {
            tableName: 'configurationProfileCatalogRows' as const,
            indexKind: 'secondary' as const,
            indexName: '[activeKey+mruSortKey+nameSortKey+id]',
            operation: 'query' as const,
            requestCount: 1,
            rowCount: receipt.fallbackProfileId === null ? 0 : 1,
          },
        ]
      : []),
    ...receipt.keys.flatMap(({ remainingProfileIds }) => [
      {
        tableName: 'configurationLinks' as const,
        indexKind: 'secondary' as const,
        indexName: '[targetKey+id]',
        operation: 'query' as const,
        requestCount: 1,
        rowCount: remainingProfileIds.length,
      },
      ...(remainingProfileIds.length === 0
        ? [
            {
              tableName: 'keys' as const,
              indexKind: 'primary' as const,
              operation: 'get' as const,
              requestCount: 1,
              rowCount: 1,
            },
          ]
        : []),
    ]),
  ])
}

function connectionDeleteOperationExactReceipt(
  tx: FencedTransaction<PhysicalStorageTableName>,
  plan: SemanticOperationExactPlan,
  input: ConnectionDeleteOperationInput,
  receipt: ConnectionDeleteOperationReceipt,
): SemanticOperationExactReceipt<PhysicalStorageTableName> {
  const accumulator = boundSemanticOperationExactReceiptAccumulator<PhysicalStorageTableName>(tx)
  const fragment = accumulator?.snapshotFragment()
  const didMutateStorage = (fragment?.physicalMutations.length ?? 0) > 0
  assertConnectionDeleteOperationReceipt(input, didMutateStorage, receipt)
  return semanticOperationExactReceipt(plan, {
    dependencies: didMutateStorage
      ? normalizeWorkspaceDependencies([
          ...(fragment?.dependencies ?? []),
          ...connectionDeleteOperationDependencies(receipt),
        ])
      : [],
    physicalMutations: fragment?.physicalMutations ?? [],
    physicalReads: aggregateExactPhysicalReads([
      ...(fragment?.physicalReads ?? []),
      ...connectionDeleteOperationPhysicalReads(input, receipt),
    ]),
  })
}

function executeConnectionDeleteOperation(
  commandMeta: ConfigurationCommandMetaPort,
  command: Extract<ConfigurationDomainCommand, { kind: 'connection.delete' }>,
): Promise<ConfigurationDomainResult<'connection.delete'>> {
  const plan = connectionDeleteOperationExactPlan()
  const input = connectionDeleteOperationInput(command)
  return commandMeta.executeSemanticOperation(
    connectionDeleteOperationDescriptor(input),
    input,
    async (tx) => {
      const execution = await commitConnectionDeleteOperation(tx, command, input)
      return semanticOperationExecution(
        execution.value,
        connectionDeleteOperationExactReceipt(tx, plan, input, execution.receipt),
      )
    },
  )
}

async function commitConnectionDeleteOperation(
  tx: FencedTransaction<PhysicalStorageTableName>,
  command: Extract<ConfigurationDomainCommand, { kind: 'connection.delete' }>,
  input: ConnectionDeleteOperationInput,
): Promise<
  SemanticOperationExecution<
    ConfigurationDomainResult<'connection.delete'>,
    ConnectionDeleteOperationReceipt
  >
> {
  if (input.replacementProfileId === input.profileId) {
    return semanticOperationExecution(
      { kind: 'invalid', reason: 'profile-reassign-self' } as const,
      connectionDeleteOperationReceipt(input, {}),
    )
  }
  const [profile, storedUsage] = await Dexie.Promise.all([
    tx.table<ConnectionProfile, ProfileId>('profiles').get(input.profileId),
    tx
      .table<ConfigurationProfileUsageProjectionRow, ProfileId>('configurationProfileUsageRows')
      .get(input.profileId),
  ])
  const usage = storedUsage ?? emptyConfigurationProfileUsageProjectionRow(input.profileId)
  if (!profile) {
    return semanticOperationExecution(
      { kind: 'missing', entity: 'profile', id: input.profileId } as const,
      connectionDeleteOperationReceipt(input, { sourceQueryExecuted: true, usage }),
    )
  }
  if (!input.replacementProfileId && (usage.presetCount > 0 || usage.chatCount > 0)) {
    return semanticOperationExecution(
      {
        kind: 'connection-delete-blocked',
        profileId: profile.id,
        presetCount: usage.presetCount,
        chatCount: usage.chatCount,
      } as const,
      connectionDeleteOperationReceipt(input, {
        sourceQueryExecuted: true,
        previousProfile: profile,
        usage,
      }),
    )
  }

  const replacementProfile = input.replacementProfileId
    ? await tx.table<ConnectionProfile, ProfileId>('profiles').get(input.replacementProfileId)
    : undefined
  if (input.replacementProfileId && !replacementProfile) {
    return semanticOperationExecution(
      { kind: 'missing', entity: 'profile', id: input.replacementProfileId } as const,
      connectionDeleteOperationReceipt(input, {
        sourceQueryExecuted: true,
        previousProfile: profile,
        replacementQueryExecuted: true,
        usage,
      }),
    )
  }
  if (replacementProfile?.archived === true) {
    return semanticOperationExecution(
      { kind: 'invalid', reason: 'profile-reassign-archived' } as const,
      connectionDeleteOperationReceipt(input, {
        sourceQueryExecuted: true,
        previousProfile: profile,
        replacementProfile,
        replacementQueryExecuted: true,
        usage,
      }),
    )
  }

  const targetQuery = input.replacementProfileId
    ? await readConfigurationTargetFanoutLinks(tx, 'profile', profile.id)
    : { links: Object.freeze([]), requestCount: 0 }
  const targetLinks = targetQuery.links
  for (const link of targetLinks) {
    if (link.ownerKind !== 'chat-preset' && link.ownerKind !== 'chat') {
      throw new Error(`ConfigurationLinkOwnerInvalid:${link.ownerKey}`)
    }
  }
  const targetLinkIds = targetLinks.map(({ id }) => id).sort()
  const presetReadIds = sortedUnique(
    targetLinks
      .filter(({ ownerKind }) => ownerKind === 'chat-preset')
      .map(({ ownerId }) => ownerId),
  )
  const chatReadIds = sortedUnique(
    targetLinks.filter(({ ownerKind }) => ownerKind === 'chat').map(({ ownerId }) => ownerId),
  )
  if (usage.presetCount !== presetReadIds.length || usage.chatCount !== chatReadIds.length) {
    throw new Error(`ConfigurationProfileUsageIntegrityError:${profile.id}`)
  }
  const targetFragment = createSemanticOperationExactReceiptAccumulator<PhysicalStorageTableName>()
  const writtenPresetIds: PresetId[] = []
  const writtenChatIds: ChatId[] = []
  const sidebarChatIds = new Set<ChatId>()
  let presetReadRequests = 0
  let chatReadRequests = 0
  for (const page of configurationTargetFanoutPages(presetReadIds)) {
    const rows = await tx.table<ChatPreset, PresetId>('presets').bulkGet([...page])
    presetReadRequests += 1
    if (rows.some((preset) => !preset)) {
      const missingIndex = rows.findIndex((preset) => !preset)
      const missingId = page[missingIndex] as PresetId
      const link = targetLinks.find(
        ({ ownerKind, ownerId }) => ownerKind === 'chat-preset' && ownerId === missingId,
      )
      throw new Error(`ConfigurationLinkOwnerMissing:${link?.ownerKey ?? missingId}`)
    }
    const previousRows = rows as ChatPreset[]
    const nextRows = previousRows.map(
      (preset): ChatPreset => ({
        ...preset,
        connectionProfileId: input.replacementProfileId as ProfileId,
        settings: {
          ...preset.settings,
          profileId: input.replacementProfileId as ProfileId,
        },
        updatedAt: command.now,
      }),
    )
    const links = await replaceLinkedSemanticByteOwnerBatch(tx, 'presets', nextRows, previousRows)
    const pageIds = nextRows.map(({ id }) => id)
    writtenPresetIds.push(...pageIds)
    targetFragment.absorb(configurationPresetTargetMutationFragment(pageIds, links))
    for (const [index, next] of nextRows.entries()) {
      const catalog = await applyConfigurationPresetCatalogProjectionTransition(
        tx,
        previousRows[index],
        next,
      )
      targetFragment.absorb(
        semanticOperationReceiptFragment({
          physicalReads: connectionDeleteCatalogPhysicalReads(catalog),
        }),
      )
    }
  }
  const chatClock = new TransactionChatUpdateClock()
  for (const page of configurationTargetFanoutPages(chatReadIds)) {
    const chatMutation = openLinkedChatMutation(tx)
    const rows = await chatMutation.readMany(page)
    chatReadRequests += 1
    if (rows.some((chat) => !chat)) {
      const missingIndex = rows.findIndex((chat) => !chat)
      const missingId = page[missingIndex] as ChatId
      const link = targetLinks.find(
        ({ ownerKind, ownerId }) => ownerKind === 'chat' && ownerId === missingId,
      )
      throw new Error(`ConfigurationLinkOwnerMissing:${link?.ownerKey ?? missingId}`)
    }
    for (const previous of rows as readonly Chat[]) {
      const transformed = withModelResolutionCancellation(
        {
          ...previous,
          settings: {
            ...previous.settings,
            profileId: input.replacementProfileId as ProfileId,
          },
        },
        true,
      )
      const next = await configuredChat(tx, previous, transformed, command.now, chatClock)
      chatMutation.replaceLinked(previous.id, () => next)
      writtenChatIds.push(previous.id)
    }
    const receipt = await chatMutation.commit()
    targetFragment.absorb(configurationTargetPhysicalFragment(receipt.fragment))
    if (receipt.sidebar.mutatedRowIds.length > 0 || receipt.sidebar.aggregateMutations.length > 0) {
      for (const { chatId } of receipt.chatWrites) sidebarChatIds.add(chatId)
    }
  }
  if (writtenChatIds.length > 0) {
    targetFragment.physicalRead({
      tableName: 'chats',
      indexKind: 'secondary',
      indexName: 'updatedAt',
      operation: 'query',
      requestCount: 1,
      rowCount: 1,
    })
  }
  targetFragment.dependency(
    ...(writtenChatIds.length > 0
      ? [{ kind: 'chat' as const, chatIds: [...writtenChatIds].sort() }]
      : []),
    ...(sidebarChatIds.size > 0
      ? [{ kind: 'sidebar' as const, chatIds: [...sidebarChatIds].sort() }]
      : []),
  )
  const sealedTargetFragment = targetFragment.sealFragment()

  const profileLinks = await deleteLinkedSemanticByteOwner(tx, 'profiles', profile.id, profile)
  const profileCatalog = await applyConfigurationProfileCatalogProjectionDeletion(tx, profile)
  const fallbackProfileId =
    input.replacementProfileId ?? (await readDefaultConfigurationProfileId(tx))
  const discovery = await clearDiscoveryCacheProfileRows(
    tx,
    ['models', 'endpoints', 'privacyPolicies'],
    profile.id,
    boundSemanticOperationExactReceiptAccumulator<PhysicalStorageTableName>(tx),
  )

  const keyIds = sortedUnique(
    configurationLinksForProfile(profile)
      .filter(({ targetKind }) => targetKind === 'key')
      .map(({ targetId }) => targetId),
  )
  const keys: ConnectionDeleteKeyReceipt[] = []
  const keyTable = tx.table<KeyRecord, KeyId>('keys')
  for (const keyId of keyIds) {
    const remainingLink = await readFirstTargetLinkFromTransaction(tx, 'key', keyId)
    if (remainingLink && remainingLink.ownerKind !== 'profile') {
      throw new Error(`ConfigurationLinkOwnerInvalid:${remainingLink.ownerKey}`)
    }
    const remainingProfileIds = remainingLink ? ([remainingLink.ownerId] as const) : []
    const previous = remainingProfileIds.length === 0 ? await keyTable.get(keyId) : undefined
    if (previous) await deleteSemanticByteOwner(tx, 'keys', keyId, previous)
    keys.push({
      keyId,
      targetQueryExecuted: true,
      remainingProfileIds,
      previous,
      deleted: previous !== undefined,
    })
  }

  const receipt = connectionDeleteOperationReceipt(input, {
    sourceQueryExecuted: true,
    previousProfile: profile,
    replacementProfile,
    replacementQueryExecuted: input.replacementProfileId !== null,
    usage,
    targetQueryExecuted: input.replacementProfileId !== null,
    targetQueryRequests: targetQuery.requestCount,
    targetLinkIds,
    presetReadRequests,
    presetReadIds,
    chatReadRequests,
    chatReadIds,
    writtenPresetIds: writtenPresetIds.sort(),
    writtenChatIds,
    targetFragment: sealedTargetFragment,
    profileLinks,
    profileCatalog,
    discovery,
    keys,
    fallbackProfileId,
  })
  return semanticOperationExecution(
    {
      kind: 'connection-deleted',
      profileId: profile.id,
      affectedPresetIds: presetReadIds,
      affectedChatIds: chatReadIds,
      deletedKeyIds: keys.filter(({ deleted }) => deleted).map(({ keyId }) => keyId),
      fallbackProfileId,
    } as const,
    receipt,
  )
}

async function commitConnectionProfileLifecycleOperation(
  tx: FencedTransaction<PhysicalStorageTableName>,
  command: ConnectionProfileLifecycleOperationCommand,
  input: ConnectionProfileLifecycleOperationInput,
): Promise<
  SemanticOperationExecution<
    ConfigurationDomainResult<ConnectionProfileLifecycleOperationKind>,
    ConnectionProfileLifecycleOperationReceipt
  >
> {
  switch (command.kind) {
    case 'connection.create':
      return commitConnectionCreateOperation(tx, command, input)
    case 'connection.edit':
      return commitConnectionEditOperation(tx, command, input)
    case 'connection.duplicate':
      return commitConnectionDuplicateOperation(tx, command, input)
  }
}

function finalizeConnectionKeyTransition(
  tx: FencedTransaction<PhysicalStorageTableName>,
  previous: KeyRecord | undefined,
  next: KeyRecord,
): KeyMaterialOperationReceipt {
  const receipt = keyMaterialOperationReceipt(previous, next, 'write')
  recordBrowserCommandKeyRequestMaterialAffectedSet(tx, next.id)
  return receipt
}

async function commitConnectionCreateOperation(
  tx: FencedTransaction<PhysicalStorageTableName>,
  command: Extract<ConnectionProfileLifecycleOperationCommand, { kind: 'connection.create' }>,
  input: ConnectionProfileLifecycleOperationInput,
): Promise<
  SemanticOperationExecution<
    ConfigurationDomainResult<'connection.create'>,
    ConnectionProfileLifecycleOperationReceipt
  >
> {
  const { profile, key, initialPreset } = command
  if (key && profile.apiKeyRef !== key.id) {
    return semanticOperationExecution(
      { kind: 'invalid', reason: 'profile-key-mismatch' } as const,
      connectionProfileLifecycleOperationReceipt(input, {}),
    )
  }
  if (
    initialPreset &&
    (initialPreset.connectionProfileId !== profile.id ||
      initialPreset.settings.profileId !== profile.id)
  ) {
    return semanticOperationExecution(
      { kind: 'invalid', reason: 'preset-profile-mismatch' } as const,
      connectionProfileLifecycleOperationReceipt(input, {}),
    )
  }
  const profiles = tx.table<ConnectionProfile, ProfileId>('profiles')
  const currentProfile = await profiles.get(profile.id)
  recordConnectionProfileLifecyclePhysicalRead(tx, {
    tableName: 'profiles',
    indexKind: 'primary',
    operation: 'get',
    requestCount: 1,
    rowCount: 1,
  })
  if (currentProfile) {
    return semanticOperationExecution(
      { kind: 'conflict', reason: 'profile-request-revision' } as const,
      connectionProfileLifecycleOperationReceipt(input, {
        previousProfile: currentProfile,
      }),
    )
  }
  let currentKey: KeyRecord | undefined
  if (input.keyIdToValidate) {
    currentKey = await tx.table<KeyRecord, KeyId>('keys').get(input.keyIdToValidate)
    recordConnectionProfileLifecyclePhysicalRead(tx, {
      tableName: 'keys',
      indexKind: 'primary',
      operation: 'get',
      requestCount: 1,
      rowCount: 1,
    })
    if (key) {
      if (currentKey) {
        return semanticOperationExecution(
          { kind: 'conflict', reason: 'key-material-revision' } as const,
          connectionProfileLifecycleOperationReceipt(input, {
            key: keyMaterialOperationReceipt(currentKey, currentKey, 'none'),
          }),
        )
      }
    } else if (!currentKey) {
      return semanticOperationExecution(
        { kind: 'missing', entity: 'key', id: input.keyIdToValidate } as const,
        connectionProfileLifecycleOperationReceipt(input, {}),
      )
    }
  }
  const presets = initialPreset ? tx.table<ChatPreset, PresetId>('presets') : undefined
  const currentPreset = initialPreset ? await presets?.get(initialPreset.id) : undefined
  if (currentPreset) {
    return semanticOperationExecution(
      { kind: 'conflict', reason: 'link-changed' } as const,
      connectionProfileLifecycleOperationReceipt(input, {
        key: input.keyIdToValidate
          ? keyMaterialOperationReceipt(currentKey, currentKey, 'none')
          : undefined,
        initialPreset: presetLifecycleOperationReceipt('chat-preset.create', currentPreset.id, {
          previous: currentPreset,
          next: currentPreset,
          presetReadRequests: 1,
        }),
      }),
    )
  }
  const writtenProfile: ConnectionProfile = {
    ...structuredClone(profile),
    requestRevision: profile.requestRevision ?? 0,
  }
  const writtenKey = key
    ? {
        ...structuredClone(key),
        materialRevision: key.materialRevision ?? 0,
      }
    : undefined
  if (writtenKey) await addSemanticByteOwner(tx, 'keys', writtenKey)
  const profileLinks = await addLinkedSemanticByteOwner(tx, 'profiles', writtenProfile)
  const profileProjection = await applyConfigurationProfileCatalogProjectionTransition(
    tx,
    undefined,
    writtenProfile,
  )
  let writtenPreset: ChatPreset | undefined
  let presetReceipt: PresetLifecycleOperationReceipt | undefined
  if (initialPreset) {
    writtenPreset = {
      ...structuredClone(initialPreset),
      createdAt: command.now,
      updatedAt: command.now,
    }
    const links = await addLinkedSemanticByteOwner(tx, 'presets', writtenPreset)
    const order = await appendPresetOrderEntry(tx, writtenPreset.id)
    const catalog = await applyConfigurationPresetCatalogProjectionTransition(
      tx,
      undefined,
      writtenPreset,
    )
    presetReceipt = presetLifecycleOperationReceipt('chat-preset.create', writtenPreset.id, {
      next: writtenPreset,
      presetReadRequests: 1,
      links,
      catalog,
      order,
    })
  }
  const keyReceipt = writtenKey
    ? finalizeConnectionKeyTransition(tx, currentKey, writtenKey)
    : input.keyIdToValidate
      ? keyMaterialOperationReceipt(currentKey, currentKey, 'none')
      : undefined
  return semanticOperationExecution(
    {
      kind: 'connection-saved',
      profile: writtenProfile,
      ...(key ? { key: structuredClone(key) } : {}),
      ...(writtenPreset ? { initialPreset: writtenPreset } : {}),
    } as const,
    connectionProfileLifecycleOperationReceipt(input, {
      nextProfile: writtenProfile,
      profileLinks,
      profileProjection,
      key: keyReceipt,
      initialPreset: presetReceipt,
    }),
  )
}

async function commitConnectionEditOperation(
  tx: FencedTransaction<PhysicalStorageTableName>,
  command: Extract<ConnectionProfileLifecycleOperationCommand, { kind: 'connection.edit' }>,
  input: ConnectionProfileLifecycleOperationInput,
): Promise<
  SemanticOperationExecution<
    ConfigurationDomainResult<'connection.edit'>,
    ConnectionProfileLifecycleOperationReceipt
  >
> {
  const profiles = tx.table<ConnectionProfile, ProfileId>('profiles')
  const current = await profiles.get(command.profileId)
  recordConnectionProfileLifecyclePhysicalRead(tx, {
    tableName: 'profiles',
    indexKind: 'primary',
    operation: 'get',
    requestCount: 1,
    rowCount: 1,
  })
  if (!current) {
    return semanticOperationExecution(
      { kind: 'missing', entity: 'profile', id: command.profileId } as const,
      connectionProfileLifecycleOperationReceipt(input, {}),
    )
  }
  if (
    command.expectedRequestRevision !== undefined &&
    (current.requestRevision ?? 0) !== command.expectedRequestRevision
  ) {
    return semanticOperationExecution(
      {
        kind: 'conflict',
        reason: 'profile-request-revision',
        currentVersion: current.requestRevision ?? 0,
      } as const,
      connectionProfileLifecycleOperationReceipt(input, {
        previousProfile: current,
      }),
    )
  }
  const written = applyConnectionProfilePatch(current, command.patch, command.now)
  const discoveryChanged = (written.requestRevision ?? 0) !== (current.requestRevision ?? 0)
  if (discoveryChanged && !input.requestMaterialMayChange) {
    throw new Error(`ConnectionProfileLifecycleRequestMaterialClassificationInvalid:${current.id}`)
  }
  if (command.replacementKey && written.apiKeyRef !== command.replacementKey.id) {
    return semanticOperationExecution(
      { kind: 'invalid', reason: 'profile-key-mismatch' } as const,
      connectionProfileLifecycleOperationReceipt(input, {
        previousProfile: current,
      }),
    )
  }

  let keyReceipt: KeyMaterialOperationReceipt | undefined
  let replacementKeyPrevious: KeyRecord | undefined
  let replacementKeyNext: KeyRecord | undefined
  const primaryKeyChanged = written.apiKeyRef !== current.apiKeyRef
  if (command.replacementKey) {
    const keys = tx.table<KeyRecord, KeyId>('keys')
    const existing = await keys.get(command.replacementKey.id)
    recordConnectionProfileLifecyclePhysicalRead(tx, {
      tableName: 'keys',
      indexKind: 'primary',
      operation: 'get',
      requestCount: 1,
      rowCount: 1,
    })
    const expectedRevision = command.replacementKey.materialRevision ?? 0
    if (
      (existing && (existing.materialRevision ?? 0) + 1 !== expectedRevision) ||
      (!existing && expectedRevision !== 0)
    ) {
      return semanticOperationExecution(
        {
          kind: 'conflict',
          reason: 'key-material-revision',
          currentVersion: existing?.materialRevision ?? 0,
        } as const,
        connectionProfileLifecycleOperationReceipt(input, {
          previousProfile: current,
          key: keyMaterialOperationReceipt(existing, existing, 'none'),
        }),
      )
    }
    const nextKey = structuredClone(command.replacementKey)
    await putSemanticByteOwner(tx, 'keys', nextKey, existing)
    replacementKeyPrevious = existing
    replacementKeyNext = nextKey
  } else if (primaryKeyChanged && written.apiKeyRef) {
    const existing = await tx.table<KeyRecord, KeyId>('keys').get(written.apiKeyRef)
    recordConnectionProfileLifecyclePhysicalRead(tx, {
      tableName: 'keys',
      indexKind: 'primary',
      operation: 'get',
      requestCount: 1,
      rowCount: 1,
    })
    if (!existing) {
      return semanticOperationExecution(
        { kind: 'missing', entity: 'key', id: written.apiKeyRef } as const,
        connectionProfileLifecycleOperationReceipt(input, {
          previousProfile: current,
        }),
      )
    }
    keyReceipt = keyMaterialOperationReceipt(existing, existing, 'none')
  }

  const chatMutation = openLinkedChatMutation(tx)
  const resetChat = input.resetChatId ? await chatMutation.read(input.resetChatId) : undefined
  if (input.resetChatId) {
    recordConnectionProfileLifecyclePhysicalRead(tx, {
      tableName: 'chats',
      indexKind: 'primary',
      operation: 'get',
      requestCount: 1,
      rowCount: 1,
    })
  }
  const profileChanged = !sameConfigurationValue(current, written)
  let profileLinks = emptyConfigurationOwnerLinkMutationReceipt()
  let profileProjection: ConfigurationCatalogProjectionMutationReceipt | undefined
  if (profileChanged) {
    profileLinks = await replaceLinkedSemanticByteOwner(tx, 'profiles', written, current)
    profileProjection = await applyConfigurationProfileCatalogProjectionTransition(
      tx,
      current,
      written,
    )
  }
  if (replacementKeyNext) {
    keyReceipt = finalizeConnectionKeyTransition(tx, replacementKeyPrevious, replacementKeyNext)
  }
  const fallbackProfileId =
    current.archived !== true && written.archived === true
      ? await readDefaultConfigurationProfileId(tx)
      : undefined
  if (current.archived !== true && written.archived === true) {
    recordConnectionProfileLifecyclePhysicalRead(tx, {
      tableName: 'configurationProfileCatalogRows',
      indexKind: 'secondary',
      indexName: '[activeKey+mruSortKey+nameSortKey+id]',
      operation: 'query',
      requestCount: 1,
      rowCount: fallbackProfileId ? 1 : 0,
    })
  }
  let discovery: DiscoveryCacheProfileClearReceipt | undefined
  if (discoveryChanged) {
    const cleared = await clearDiscoveryCacheProfileRows(
      tx,
      ['models', 'endpoints', 'privacyPolicies'],
      written.id,
      boundSemanticOperationExactReceiptAccumulator<PhysicalStorageTableName>(tx),
    )
    discovery = cleared
  }
  let resetChatReceipt = chatConfigurationOperationReceipt(resetChat, resetChat)
  if (resetChat?.settings.profileId === written.id) {
    const transformed = withModelResolutionCancellation(
      { ...resetChat, settings: { ...resetChat.settings, model: '' } },
      true,
    )
    resetChatReceipt = await selectedChatConfigurationTransition(
      tx,
      chatMutation,
      resetChat,
      transformed,
      command.now,
    )
  }
  const affectedChatIds =
    resetChatReceipt.mutation === 'write' && resetChatReceipt.next ? [resetChatReceipt.next.id] : []
  return semanticOperationExecution(
    {
      kind: 'connection-saved',
      profile: written,
      ...(fallbackProfileId === undefined ? {} : { fallbackProfileId }),
      ...(affectedChatIds.length > 0 ? { affectedChatIds } : {}),
      ...(command.replacementKey ? { key: structuredClone(command.replacementKey) } : {}),
    } as const,
    connectionProfileLifecycleOperationReceipt(input, {
      previousProfile: current,
      nextProfile: profileChanged ? written : current,
      profileLinks,
      profileProjection,
      key: keyReceipt,
      resetChat: resetChatReceipt,
      discovery,
      fallbackProfileId,
    }),
  )
}

async function commitConnectionDuplicateOperation(
  tx: FencedTransaction<PhysicalStorageTableName>,
  command: Extract<ConnectionProfileLifecycleOperationCommand, { kind: 'connection.duplicate' }>,
  input: ConnectionProfileLifecycleOperationInput,
): Promise<
  SemanticOperationExecution<
    ConfigurationDomainResult<'connection.duplicate'>,
    ConnectionProfileLifecycleOperationReceipt
  >
> {
  const profiles = tx.table<ConnectionProfile, ProfileId>('profiles')
  const source = await profiles.get(command.sourceId)
  recordConnectionProfileLifecyclePhysicalRead(tx, {
    tableName: 'profiles',
    indexKind: 'primary',
    operation: 'get',
    requestCount: 1,
    rowCount: 1,
  })
  if (!source) {
    return semanticOperationExecution(
      { kind: 'missing', entity: 'profile', id: command.sourceId } as const,
      connectionProfileLifecycleOperationReceipt(input, {}),
    )
  }
  const currentCopy = await profiles.get(command.copyId)
  recordConnectionProfileLifecyclePhysicalRead(tx, {
    tableName: 'profiles',
    indexKind: 'primary',
    operation: 'get',
    requestCount: 1,
    rowCount: 1,
  })
  if (currentCopy) {
    return semanticOperationExecution(
      { kind: 'conflict', reason: 'link-changed' } as const,
      connectionProfileLifecycleOperationReceipt(input, {
        sourceProfile: source,
        previousProfile: currentCopy,
      }),
    )
  }
  const profile = duplicateConnectionProfile(source, command.copyId, command.name, command.now)
  const profileLinks = await addLinkedSemanticByteOwner(tx, 'profiles', profile)
  const profileProjection = await applyConfigurationProfileCatalogProjectionTransition(
    tx,
    undefined,
    profile,
  )
  return semanticOperationExecution(
    { kind: 'connection-saved', profile } as const,
    connectionProfileLifecycleOperationReceipt(input, {
      sourceProfile: source,
      nextProfile: profile,
      profileLinks,
      profileProjection,
    }),
  )
}

function catalogedConfigurationOperationDescriptor(
  operationKind: CatalogedConfigurationOperationKind,
) {
  const definition = catalogedConfigurationOperationDefinition(operationKind)
  return semanticOperationDescriptor<
    ReturnType<typeof configurationSemanticOperationKind>,
    PhysicalTransactionCapability,
    CatalogedConfigurationOperationInput,
    SemanticOperationExactReceipt<PhysicalStorageTableName>
  >({
    operationKind: configurationSemanticOperationKind(operationKind),
    transaction: definition.transaction,
    resources: ({ entityKind, entityId }: CatalogedConfigurationOperationInput) => [
      catalogedConfigurationEntityResourceName(entityKind, entityId),
    ],
    permittedWrites: definition.transaction.tableNames,
    requiredWritesWhenMutated: [definition.entityTable],
    ...semanticOperationExactReceiptContracts<
      CatalogedConfigurationOperationInput,
      PhysicalStorageTableName
    >(),
    replay: semanticOperationExactReceiptReplayProofContract<CatalogedConfigurationOperationInput>(
      assertConfigurationSingleAttemptReplayProof,
    ),
  })
}

function catalogedConfigurationOperationExactPlan(): SemanticOperationExactPlan {
  return semanticOperationExactPlan({
    replay: { kind: 'single-attempt', reason: 'unfenced-relative-update' },
    bounds: {
      reads: { maxRequests: 4, maxRows: 4, maxBatchRows: 1, maxBytes: Number.MAX_SAFE_INTEGER },
      writes: { maxRequests: 5, maxRows: 5, maxBatchRows: 1, maxBytes: Number.MAX_SAFE_INTEGER },
    },
  })
}

function catalogedConfigurationOperationExactReceipt(
  plan: SemanticOperationExactPlan,
  operationKind: CatalogedConfigurationOperationKind,
  input: CatalogedConfigurationOperationInput,
  receipt: CatalogedConfigurationOperationReceipt,
): SemanticOperationExactReceipt<PhysicalStorageTableName> {
  const didMutateStorage = receipt.entityMutation === 'write'
  assertCatalogedConfigurationOperationReceipt(operationKind, input, didMutateStorage, receipt)
  const definition = catalogedConfigurationOperationDefinition(operationKind)
  const projection = receipt.projection
  return semanticOperationExactReceipt(plan, {
    dependencies: didMutateStorage ? catalogedConfigurationOperationDependencies(receipt) : [],
    physicalMutations:
      didMutateStorage && projection
        ? [
            {
              tableName: definition.entityTable,
              operation: 'write',
              key: input.entityId,
            },
            ...(projection.projectionMutation === 'write'
              ? [
                  {
                    tableName: projection.projectionTable,
                    operation: 'write' as const,
                    key: projection.projectionId,
                  },
                ]
              : []),
            ...projection.aggregateIds.map((key) => ({
              tableName: 'configurationCatalogAggregates' as const,
              operation: 'write' as const,
              key,
            })),
          ]
        : [],
    physicalReads: [
      {
        tableName: definition.entityTable,
        indexKind: 'primary',
        operation: 'get',
        requestCount: 1,
        rowCount: 1,
      },
      ...(projection && projection.aggregateIds.length > 0
        ? [
            {
              tableName: 'configurationCatalogAggregates' as const,
              indexKind: 'primary' as const,
              operation: 'get' as const,
              requestCount: projection.aggregateIds.length,
              rowCount: projection.aggregateIds.length,
            },
          ]
        : []),
    ],
  })
}

function catalogedConfigurationOperationDefinition(
  operationKind: CatalogedConfigurationOperationKind,
) {
  switch (operationKind) {
    case 'connection.touch':
      return {
        entityKind: 'profile' as const,
        entityTable: 'profiles' as const,
        projectionTable: 'configurationProfileCatalogRows' as const,
        transaction: physicalStorageTables(
          ...CONFIGURATION_PROFILE_CATALOG_TRANSACTION_CAPABILITY.tableNames,
          'profiles',
        ),
      }
    case 'prompt-preset.rename':
      return {
        entityKind: 'prompt-preset' as const,
        entityTable: 'promptPresets' as const,
        projectionTable: 'configurationPromptPresetCatalogRows' as const,
        transaction: physicalStorageTables(
          ...CONFIGURATION_PROMPT_PRESET_CATALOG_TRANSACTION_CAPABILITY.tableNames,
          'promptPresets',
        ),
      }
  }
}

function catalogedConfigurationEntityResourceName(
  entityKind: CatalogedConfigurationEntityKind,
  entityId: string,
): string {
  switch (entityKind) {
    case 'profile':
      return `profile:${entityId}`
    case 'preset':
      return `preset:${entityId}`
    case 'prompt-preset':
      return `prompt-preset:${entityId}`
  }
}

function assertCatalogedConfigurationOperationReceipt(
  operationKind: CatalogedConfigurationOperationKind,
  input: CatalogedConfigurationOperationInput,
  didMutateStorage: boolean,
  receipt: CatalogedConfigurationOperationReceipt,
): void {
  const definition = catalogedConfigurationOperationDefinition(operationKind)
  const projection = receipt.projection
  if (
    input.entityKind !== definition.entityKind ||
    receipt.entityKind !== definition.entityKind ||
    (receipt.previous !== undefined && receipt.previous.id !== input.entityId) ||
    (receipt.next !== undefined && receipt.next.id !== input.entityId) ||
    (receipt.entityMutation === 'write') !== didMutateStorage ||
    (receipt.entityMutation === 'write') !== (projection !== undefined) ||
    (projection !== undefined &&
      (projection.projectionTable !== definition.projectionTable ||
        projection.projectionId !== input.entityId ||
        new Set(projection.aggregateIds).size !== projection.aggregateIds.length ||
        (projection.projectionMutation === 'none' && projection.aggregateIds.length !== 0)))
  ) {
    throw new Error(
      `CatalogedConfigurationOperationReceiptInvalid:${operationKind}:${input.entityId}`,
    )
  }
}

function catalogedConfigurationOperationDependencies(
  receipt: CatalogedConfigurationOperationReceipt,
): readonly WorkspaceDependency[] {
  switch (receipt.entityKind) {
    case 'profile':
      return workspaceDependenciesForConfigurationSemanticMutation({
        kind: 'profile',
        previous: receipt.previous as ConnectionProfile | undefined,
        next: receipt.next as ConnectionProfile | undefined,
      })
    case 'preset':
      return workspaceDependenciesForConfigurationSemanticMutation({
        kind: 'preset',
        previous: receipt.previous as ChatPreset | undefined,
        next: receipt.next as ChatPreset | undefined,
      })
    case 'prompt-preset':
      return workspaceDependenciesForConfigurationSemanticMutation({
        kind: 'prompt-preset',
        previous: receipt.previous as PromptPreset | undefined,
        next: receipt.next as PromptPreset | undefined,
      })
  }
}

function catalogedConfigurationOperationReceipt(
  entityKind: CatalogedConfigurationEntityKind,
  previous: CatalogedConfigurationEntityRow | undefined,
  next: CatalogedConfigurationEntityRow | undefined,
  projection?: ConfigurationCatalogProjectionMutationReceipt,
): CatalogedConfigurationOperationReceipt {
  return Object.freeze({
    [CATALOGED_CONFIGURATION_OPERATION_RECEIPT]: true as const,
    entityKind,
    previous,
    next,
    entityMutation: projection ? ('write' as const) : ('none' as const),
    projection,
  })
}

async function executeCatalogedConfigurationOperation<
  Row extends CatalogedConfigurationEntityRow,
  Result,
>(
  commandMeta: ConfigurationCommandMetaPort,
  operationKind: CatalogedConfigurationOperationKind,
  entityId: string,
  transition: (current: Row | undefined) => CatalogedConfigurationTransition<Row, Result>,
): Promise<Result> {
  const definition = catalogedConfigurationOperationDefinition(operationKind)
  const input: CatalogedConfigurationOperationInput = {
    entityKind: definition.entityKind,
    entityId,
  }
  const exactPlan = catalogedConfigurationOperationExactPlan()
  const exactReceipt = (receipt: CatalogedConfigurationOperationReceipt) =>
    catalogedConfigurationOperationExactReceipt(exactPlan, operationKind, input, receipt)
  return commandMeta.executeSemanticOperation(
    catalogedConfigurationOperationDescriptor(operationKind),
    input,
    async (
      tx,
    ): Promise<
      SemanticOperationExecution<Result, SemanticOperationExactReceipt<PhysicalStorageTableName>>
    > => {
      const current = (await tx
        .table<CatalogedConfigurationEntityRow, string>(definition.entityTable)
        .get(entityId)) as Row | undefined
      const projected = transition(current)
      if (projected.next === undefined) {
        return semanticOperationExecution(
          projected.result,
          exactReceipt(
            catalogedConfigurationOperationReceipt(definition.entityKind, current, current),
          ),
        )
      }
      await writeCatalogedConfigurationEntity(tx, definition.entityKind, current, projected.next)
      const projection = await applyCatalogedConfigurationProjectionTransition(
        tx,
        operationKind,
        current,
        projected.next,
      )
      return semanticOperationExecution(
        projected.result,
        exactReceipt(
          catalogedConfigurationOperationReceipt(
            definition.entityKind,
            current,
            projected.next,
            projection,
          ),
        ),
      )
    },
  )
}

async function writeCatalogedConfigurationEntity(
  tx: FencedTransaction<PhysicalStorageTableName>,
  entityKind: CatalogedConfigurationEntityKind,
  previous: CatalogedConfigurationEntityRow | undefined,
  next: CatalogedConfigurationEntityRow,
): Promise<void> {
  switch (entityKind) {
    case 'profile':
      if (!previous) throw new Error(`CatalogedConfigurationEntityMissing:profile:${next.id}`)
      await replaceLinkedSemanticByteOwner(
        tx,
        'profiles',
        next as ConnectionProfile,
        previous as ConnectionProfile,
      )
      return
    case 'preset':
      if (!previous) throw new Error(`CatalogedConfigurationEntityMissing:preset:${next.id}`)
      await replaceLinkedSemanticByteOwner(
        tx,
        'presets',
        next as ChatPreset,
        previous as ChatPreset,
      )
      return
    case 'prompt-preset':
      return putSemanticByteOwner(
        tx,
        'promptPresets',
        next as PromptPreset,
        previous as PromptPreset | undefined,
      )
  }
}

function applyCatalogedConfigurationProjectionTransition(
  tx: FencedTransaction<PhysicalStorageTableName>,
  operationKind: CatalogedConfigurationOperationKind,
  previous: CatalogedConfigurationEntityRow | undefined,
  next: CatalogedConfigurationEntityRow,
): Promise<ConfigurationCatalogProjectionMutationReceipt> {
  switch (operationKind) {
    case 'connection.touch':
      return applyConfigurationProfileCatalogProjectionTransition(
        tx,
        previous as ConnectionProfile | undefined,
        next as ConnectionProfile,
      )
    case 'prompt-preset.rename':
      return applyConfigurationPromptPresetCatalogProjectionTransition(
        tx,
        previous as PromptPreset | undefined,
        next as PromptPreset,
      )
  }
}

const CHAT_CONFIGURATION_PROMPT_TARGET_KEYS = [
  'systemPromptPresetId',
  'appendPromptPresetId',
  'continueSystemPromptPresetId',
  'continueUserPromptPresetId',
  'defaultPrefillPresetId',
] as const

function configurationTargetResourceName(
  kind: ConfigurationLink['targetKind'],
  id: string,
): string {
  return `configuration-target:${configurationTargetKey(kind, id)}`
}

function chatSettingsIntroducedTargetResources(settings: Partial<ChatSettings>): readonly string[] {
  const resources: string[] = []
  if (typeof settings.profileId === 'string') {
    resources.push(configurationTargetResourceName('profile', settings.profileId))
  }
  for (const key of CHAT_CONFIGURATION_PROMPT_TARGET_KEYS) {
    const presetId = settings[key]
    if (typeof presetId === 'string') {
      resources.push(configurationTargetResourceName('prompt-preset', presetId))
    }
  }
  const templateId = settings.textTemplate
  if (typeof templateId === 'string' && !isStaticTextTemplateId(templateId)) {
    resources.push(configurationTargetResourceName('text-template', templateId))
  }
  return sortedUnique(resources)
}

function serializedChatSettingsIntroducedTargetResources(
  patch: Extract<ConfigurationDomainCommand, { kind: 'chat.settings-patch' }>['patch'],
): readonly string[] {
  return chatSettingsIntroducedTargetResources(patch.set)
}

function chatSettingsFieldIntroducedTargetResources(
  patches: Extract<ConfigurationDomainCommand, { kind: 'chat.settings-fields-patch' }>['patches'],
): readonly string[] {
  const settings: Partial<ChatSettings> = {}
  for (const patch of patches) {
    if (patch.path.length !== 1 || patch.membership || typeof patch.value !== 'string') continue
    const key = patch.path[0]
    if (
      key === 'profileId' ||
      key === 'textTemplate' ||
      CHAT_CONFIGURATION_PROMPT_TARGET_KEYS.includes(
        key as (typeof CHAT_CONFIGURATION_PROMPT_TARGET_KEYS)[number],
      )
    ) {
      ;(settings as Record<string, unknown>)[key] = patch.value
    }
  }
  return chatSettingsIntroducedTargetResources(settings)
}

function replacementChatSettingsIntroducedTargetResources(
  settings: ChatSettings,
  presetId: PresetId | null | undefined,
): readonly string[] {
  return sortedUnique([
    ...chatSettingsIntroducedTargetResources(settings),
    ...(presetId ? [configurationTargetResourceName('chat-preset', presetId)] : []),
  ])
}

function textTemplateEntityOperationDescriptor(
  operationKind: 'text-template.create' | 'text-template.update',
) {
  return semanticOperationDescriptor({
    operationKind: configurationSemanticOperationKind(operationKind),
    transaction: CONFIGURATION_TEXT_TEMPLATE_ENTITY_TRANSACTION,
    resources: ({ templateId }: TextTemplateEntityOperationInput) => [
      `configuration-target:${configurationTargetKey('text-template', templateId)}`,
    ],
    permittedWrites: ['textTemplates'],
    requiredWritesWhenMutated: ['textTemplates'],
    ...semanticOperationExactReceiptContracts<TextTemplateEntityOperationInput, 'textTemplates'>(),
    replay: semanticOperationExactReceiptReplayProofContract<TextTemplateEntityOperationInput>(
      assertConfigurationSingleAttemptReplayProof,
    ),
  })
}

function assertConfigurationSingleAttemptReplayProof(
  _input: unknown,
  receipt: SemanticOperationExactReceipt,
): void {
  const replay = receipt.plan.replay
  if (replay.kind !== 'single-attempt' || replay.reason !== 'unfenced-relative-update') {
    throw new Error('ConfigurationSingleAttemptReplayProofMismatch')
  }
}

function configurationEntityOperationExactPlan(
  _operationKind: 'key.touch' | 'text-template.create' | 'text-template.update',
  _id: string,
): SemanticOperationExactPlan {
  return semanticOperationExactPlan({
    replay: { kind: 'single-attempt', reason: 'unfenced-relative-update' },
    bounds: {
      reads: { maxRequests: 1, maxRows: 1, maxBatchRows: 1, maxBytes: Number.MAX_SAFE_INTEGER },
      writes: { maxRequests: 1, maxRows: 1, maxBatchRows: 1, maxBytes: Number.MAX_SAFE_INTEGER },
    },
  })
}

function configurationEntityOperationExactReceipt<Tables extends 'keys' | 'textTemplates'>(
  plan: SemanticOperationExactPlan,
  tableName: Tables,
  key: string,
  dependency: WorkspaceDependency,
  changed: boolean,
): SemanticOperationExactReceipt<Tables> {
  return semanticOperationExactReceipt(plan, {
    dependencies: changed ? [dependency] : [],
    physicalMutations: changed ? [{ tableName, operation: 'write' as const, key }] : [],
    physicalReads: [
      {
        tableName,
        indexKind: 'primary' as const,
        operation: 'get' as const,
        requestCount: 1,
        rowCount: 1,
      },
    ],
  })
}

interface SettingRowsOperationInput {
  readonly keys: readonly string[]
  readonly operation: 'write' | 'delete'
}

interface SettingRowsWriteTransition<Result> {
  readonly kind: 'write'
  project(current: readonly (SettingsRow | undefined)[]): readonly SettingsRow[]
  result(changed: boolean, next: readonly SettingsRow[]): Result
}

interface SettingRowsDeleteTransition<Result> {
  readonly kind: 'delete'
  result(changed: boolean): Result
}

type SettingRowsTransition<Result> =
  | SettingRowsWriteTransition<Result>
  | SettingRowsDeleteTransition<Result>

function settingRowsOperationDescriptor(operationKind: ConfigurationDomainCommand['kind']) {
  return semanticOperationDescriptor({
    operationKind: configurationSemanticOperationKind(operationKind),
    transaction: CONFIGURATION_SETTING_TRANSACTION,
    resources: ({ keys: settingKeys }: SettingRowsOperationInput) =>
      settingKeys.map((key) => `setting:${key}`),
    permittedWrites: ['settings'],
    requiredWritesWhenMutated: ['settings'],
    ...semanticOperationExactReceiptContracts<SettingRowsOperationInput, 'settings'>(),
    replay: semanticOperationExactReceiptReplayProofContract<SettingRowsOperationInput>(
      assertSettingRowsSingleAttemptReplayProof,
    ),
  })
}

function assertSettingRowsSingleAttemptReplayProof(
  _input: SettingRowsOperationInput,
  receipt: SemanticOperationExactReceipt,
): void {
  const replay = receipt.plan.replay
  if (replay.kind !== 'single-attempt' || replay.reason !== 'unfenced-relative-update') {
    throw new Error('SettingRowsSingleAttemptReplayProofMismatch')
  }
}

function settingRowsOperationExactPlan(
  _operationKind: ConfigurationDomainCommand['kind'],
  input: SettingRowsOperationInput,
): SemanticOperationExactPlan {
  return semanticOperationExactPlan({
    replay: { kind: 'single-attempt', reason: 'unfenced-relative-update' },
    bounds: {
      reads: {
        maxRequests: 1,
        maxRows: input.keys.length,
        maxBatchRows: input.keys.length,
        maxBytes: Number.MAX_SAFE_INTEGER,
      },
      writes: {
        maxRequests: input.keys.length,
        maxRows: input.keys.length,
        maxBatchRows: input.operation === 'delete' ? 1 : input.keys.length,
        maxBytes: Number.MAX_SAFE_INTEGER,
      },
    },
  })
}

function settingRowsOperationExactReceipt(
  plan: SemanticOperationExactPlan,
  input: SettingRowsOperationInput,
  mutationKeys: readonly string[],
  transactionExecuted: boolean,
): SemanticOperationExactReceipt<'settings'> {
  return semanticOperationExactReceipt(plan, {
    dependencies:
      mutationKeys.length === 0 ? [] : [{ kind: 'setting' as const, keys: mutationKeys }],
    physicalMutations: mutationKeys.map((key) => ({
      tableName: 'settings' as const,
      operation: input.operation,
      key,
    })),
    physicalReads: transactionExecuted
      ? [
          {
            tableName: 'settings' as const,
            indexKind: 'primary' as const,
            operation: 'get-many' as const,
            requestCount: 1,
            rowCount: input.keys.length,
          },
        ]
      : [],
  })
}

function executeSettingRowsOperation<Result>(
  commandMeta: ConfigurationCommandMetaPort,
  operationKind: ConfigurationDomainCommand['kind'],
  keys: readonly string[],
  transition: SettingRowsTransition<Result>,
): Promise<Result> {
  const input = { keys: canonicalSettingKeys(keys), operation: transition.kind } as const
  const descriptor = settingRowsOperationDescriptor(operationKind)
  const exactPlan = settingRowsOperationExactPlan(operationKind, input)
  return commandMeta.executeSemanticOperation(descriptor, input, async (tx) => {
    const table = tx.table<SettingsRow, string>('settings')
    const current = await table.bulkGet([...input.keys])
    if (transition.kind === 'delete') {
      const existing = current.filter((row): row is SettingsRow => row !== undefined)
      for (const row of existing) await deleteUserSettingByteOwner(tx, row)
      return semanticOperationExecution(
        transition.result(existing.length > 0),
        settingRowsOperationExactReceipt(
          exactPlan,
          input,
          existing.map(({ key }) => key),
          true,
        ),
      )
    }
    const next = [...transition.project(current)]
    assertSettingRowsProjection(input.keys, next)
    const changed = next.some((row, index) => {
      const previous = current[index]
      return !previous || !sameValue(previous.value, row.value)
    })
    if (changed) {
      if (next.length === 1) {
        const row = next[0]
        if (!row) throw new Error('SettingRowsProjectionMissing')
        await putUserSettingByteOwner(tx, row, current[0])
      } else await putUserSettingByteOwners(tx, next, current)
    }
    return semanticOperationExecution(
      transition.result(changed, next),
      settingRowsOperationExactReceipt(exactPlan, input, changed ? input.keys : [], true),
    )
  })
}

function completeSettingRowsOperation<Result>(
  commandMeta: ConfigurationCommandMetaPort,
  operationKind: ConfigurationDomainCommand['kind'],
  keys: readonly string[],
  operation: SettingRowsOperationInput['operation'],
  result: Result,
): Promise<Result> {
  const input = { keys: canonicalSettingKeys(keys), operation } as const
  const exactPlan = settingRowsOperationExactPlan(operationKind, input)
  return commandMeta.completeSemanticOperation(
    settingRowsOperationDescriptor(operationKind),
    input,
    result,
    settingRowsOperationExactReceipt(exactPlan, input, [], false),
  )
}

function canonicalSettingKeys(keys: readonly string[]): readonly string[] {
  const values = [...new Set(keys)].sort()
  if (values.length === 0 || values.length > 2) throw new Error('SettingRowsKeyCountInvalid')
  return values
}

function assertSettingRowsProjection(keys: readonly string[], rows: readonly SettingsRow[]): void {
  if (rows.length !== keys.length || rows.some((row, index) => row.key !== keys[index])) {
    throw new Error('SettingRowsProjectionIdentityMismatch')
  }
}

const configurationDomainHandlers = {
  'connection.create': createConnection,
  'connection.edit': editConnection,
  'connection.duplicate': duplicateConnection,
  'connection.touch': touchConnection,
  'connection.delete': deleteConnection,
  'key.put': putKey,
  'key.touch': touchKey,
  'key.material-replace': replaceKeyMaterial,
  'key.delete': deleteKey,
  'chat.switch-profile': switchChatProfile,
  'chat.resolve-model': resolveChatModel,
  'chat.settings-patch': (command, commandMeta) =>
    mutateChatConfiguration(
      command.kind,
      command.chatId,
      command.now,
      serializedChatSettingsIntroducedTargetResources(command.patch),
      (chat) =>
        withModelResolutionCancellation(
          {
            ...chat,
            settings: applySerializedChatSettingsPatch(chat.settings, command.patch),
          },
          command.cancelModelResolution,
        ),
      commandMeta,
    ),
  'chat.settings-fields-patch': (command, commandMeta) =>
    mutateChatConfiguration(
      command.kind,
      command.chatId,
      command.now,
      chatSettingsFieldIntroducedTargetResources(command.patches),
      (chat) =>
        withModelResolutionCancellation(
          {
            ...chat,
            settings: applyChatSettingsFieldPatches(chat.settings, command.patches),
          },
          command.cancelModelResolution,
        ),
      commandMeta,
    ),
  'chat.settings-replace': (command, commandMeta) =>
    mutateChatConfiguration(
      command.kind,
      command.chatId,
      command.now,
      replacementChatSettingsIntroducedTargetResources(command.settings, command.presetId),
      (chat) => {
        const next = withModelResolutionCancellation(
          {
            ...chat,
            settings: normalizeChatSettings(structuredClone(command.settings)),
          },
          command.cancelModelResolution,
        )
        if (command.presetId === null) delete next.presetId
        else if (command.presetId !== undefined) next.presetId = command.presetId
        return next
      },
      commandMeta,
    ),
  'image-allowlist.add': mutateImageAllowlist,
  'image-allowlist.remove': mutateImageAllowlist,
  'rendering-preferences.patch': patchRenderingPreferences,
  'sample-prompts.set-dismissed': (command, commandMeta) =>
    saveWorkspaceSetting(
      command.kind,
      SAMPLE_PROMPTS_DISMISSED_KEY,
      command.dismissed,
      commandMeta,
    ),
  'install-secret.ensure': (command, commandMeta) =>
    mutateWorkspaceSetting(
      command.kind,
      'install-secret',
      (current) => (typeof current === 'string' && current ? current : command.fresh),
      commandMeta,
    ),
  'global-preference.set': (command, commandMeta) =>
    isRecentModelSettingKey(command.key)
      ? completeSettingRowsOperation(commandMeta, command.kind, [command.key], 'write', {
          kind: 'invalid',
          reason: 'coupled-setting-command-required',
        } as const)
      : saveWorkspaceSetting(command.kind, command.key, command.value, commandMeta),
  'pinned-model.set-membership': (command, commandMeta) =>
    mutateWorkspaceSetting<string[]>(
      command.kind,
      PINNED_MODELS_KEY,
      (current) => {
        const ids = normalizeStringIds(current)
        if (command.pinned) return ids.includes(command.modelId) ? ids : [...ids, command.modelId]
        return ids.filter((id) => id !== command.modelId)
      },
      commandMeta,
    ),
  'pinned-model.move': (command, commandMeta) =>
    mutateWorkspaceSetting<string[]>(
      command.kind,
      PINNED_MODELS_KEY,
      (current) => {
        const ids = normalizeStringIds(current)
        const from = ids.indexOf(command.modelId)
        if (from < 0) return ids
        const to = Math.max(0, Math.min(ids.length - 1, from + command.delta))
        if (to === from) return ids
        const next = [...ids]
        next.splice(from, 1)
        next.splice(to, 0, command.modelId)
        return next
      },
      commandMeta,
    ),
  'recent-model.clear': (command, commandMeta) => clearRecentModelState(command.kind, commandMeta),
  'sidebar-preference.set-sort': (command, commandMeta) =>
    saveWorkspaceSetting(command.kind, 'sidebar:sort-key', command.mode, commandMeta),
  'sidebar-preference.set-folder-collapsed': (command, commandMeta) =>
    mutateWorkspaceSetting<string[]>(
      command.kind,
      'sidebar:collapsed-folders',
      (current) => {
        const ids = normalizeStringIds(current)
        const next = command.collapsed
          ? [...ids.filter((id) => id !== command.folderId), command.folderId]
          : ids.filter((id) => id !== command.folderId)
        return [...new Set(next)].sort()
      },
      commandMeta,
    ),
  'text-template.create': createTextTemplate,
  'text-template.create-and-select': createAndSelectTextTemplate,
  'text-template.update': updateTextTemplate,
  'text-template.delete': deleteTextTemplate,
  'chat-preset.create': createChatPreset,
  'chat-preset.create-and-link': createAndLinkChatPreset,
  'chat-preset.update': updateChatPreset,
  'chat-preset.duplicate': duplicateChatPreset,
  'chat-preset.move': moveChatPreset,
  'chat-preset.set-archived': setChatPresetArchived,
  'chat-preset.delete': deleteChatPreset,
  'chat-preset.apply': applyChatPreset,
  'chat-preset.save': saveChatPreset,
  'prompt-preset.local-commit': commitLocalPrompt,
  'prompt-preset.load-and-pin': loadAndPinPrompt,
  'prompt-preset.overwrite-and-pin': overwriteAndPinPrompt,
  'prompt-preset.create-and-pin': createAndPinPrompt,
  'prompt-preset.rename': renamePromptPreset,
  'prompt-preset.delete': deletePromptPreset,
} satisfies ConfigurationDomainHandlerMap<ConfigurationCommandMetaPort>

export function executeConfigurationCommandInBrowser<Command extends ConfigurationDomainCommand>(
  command: Command,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<Command['kind']>> {
  const handler = configurationDomainHandlers[command.kind] as unknown as (
    exactCommand: Command,
    meta: ConfigurationCommandMetaPort,
  ) => Promise<ConfigurationDomainResult<Command['kind']>>
  return handler(command, commandMeta)
}

function withModelResolutionCancellation(
  chat: Chat,
  cancelModelResolution: boolean | undefined,
): Chat {
  if (cancelModelResolution === false || chat.modelResolution === undefined) return chat
  const next = { ...chat }
  delete next.modelResolution
  return next
}

async function createConnection(
  command: Extract<ConfigurationDomainCommand, { kind: 'connection.create' }>,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'connection.create'>> {
  return executeConnectionProfileLifecycleOperation(commandMeta, command)
}

async function editConnection(
  command: Extract<ConfigurationDomainCommand, { kind: 'connection.edit' }>,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'connection.edit'>> {
  return executeConnectionProfileLifecycleOperation(commandMeta, command)
}

async function duplicateConnection(
  command: Extract<ConfigurationDomainCommand, { kind: 'connection.duplicate' }>,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'connection.duplicate'>> {
  return executeConnectionProfileLifecycleOperation(commandMeta, command)
}

function duplicateConnectionProfile(
  source: ConnectionProfile,
  copyId: ProfileId,
  name: string | undefined,
  now: number,
): ConnectionProfile {
  const profile: ConnectionProfile = {
    ...structuredClone(source),
    id: copyId,
    name: name ?? `${source.name} (copy)`,
    requestRevision: source.requestRevision ?? 0,
    createdAt: now,
    updatedAt: now,
    archived: false,
  }
  delete profile.lastUsedAt
  return profile
}

async function touchConnection(
  command: Extract<ConfigurationDomainCommand, { kind: 'connection.touch' }>,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'connection.touch'>> {
  return executeCatalogedConfigurationOperation<
    ConnectionProfile,
    ConfigurationDomainResult<'connection.touch'>
  >(commandMeta, command.kind, command.profileId, (current) => {
    if (!current) {
      return {
        next: undefined,
        result: { kind: 'missing', entity: 'profile', id: command.profileId },
      }
    }
    const lastUsedAt = Math.max(current.lastUsedAt ?? 0, command.now)
    if (lastUsedAt === current.lastUsedAt) {
      return {
        next: undefined,
        result: { kind: 'connection-saved', profile: current },
      }
    }
    const profile = { ...current, lastUsedAt }
    return {
      next: profile,
      result: { kind: 'connection-saved', profile },
    }
  })
}

async function deleteConnection(
  command: Extract<ConfigurationDomainCommand, { kind: 'connection.delete' }>,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'connection.delete'>> {
  return executeConnectionDeleteOperation(commandMeta, command)
}

async function putKey(
  command: Extract<ConfigurationDomainCommand, { kind: 'key.put' }>,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'key.put'>> {
  return executeKeyMaterialOperation(commandMeta, command)
}

async function replaceKeyMaterial(
  command: Extract<ConfigurationDomainCommand, { kind: 'key.material-replace' }>,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'key.material-replace'>> {
  return executeKeyMaterialOperation(commandMeta, command)
}

async function touchKey(
  command: Extract<ConfigurationDomainCommand, { kind: 'key.touch' }>,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'key.touch'>> {
  return executeConfigurationEntityRowOperation(commandMeta, command)
}

async function deleteKey(
  command: Extract<ConfigurationDomainCommand, { kind: 'key.delete' }>,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'key.delete'>> {
  return executeKeyMaterialOperation(commandMeta, command)
}

type KeyMaterialCommand = Extract<
  ConfigurationDomainCommand,
  { kind: 'key.put' | 'key.material-replace' | 'key.delete' }
>

function executeKeyMaterialOperation(
  commandMeta: ConfigurationCommandMetaPort,
  command: Extract<KeyMaterialCommand, { kind: 'key.put' }>,
): Promise<ConfigurationDomainResult<'key.put'>>
function executeKeyMaterialOperation(
  commandMeta: ConfigurationCommandMetaPort,
  command: Extract<KeyMaterialCommand, { kind: 'key.material-replace' }>,
): Promise<ConfigurationDomainResult<'key.material-replace'>>
function executeKeyMaterialOperation(
  commandMeta: ConfigurationCommandMetaPort,
  command: Extract<KeyMaterialCommand, { kind: 'key.delete' }>,
): Promise<ConfigurationDomainResult<'key.delete'>>
async function executeKeyMaterialOperation(
  commandMeta: ConfigurationCommandMetaPort,
  command: KeyMaterialCommand,
): Promise<ConfigurationDomainResult<KeyMaterialCommand['kind']>> {
  const keyId = command.kind === 'key.delete' ? command.keyId : command.key.id
  const descriptor = keyMaterialOperationDescriptor(command.kind)
  const input: KeyMaterialOperationInput = {
    keyId,
    operationKind: command.kind,
    expectedMaterialRevision:
      command.kind === 'key.delete' ? null : command.expectedMaterialRevision,
    materialRevision: command.kind === 'key.delete' ? null : (command.key.materialRevision ?? 0),
  }
  const exactPlan = keyMaterialOperationExactPlan(input)
  return commandMeta.executeSemanticOperation<
    'configurationLinks' | 'keys',
    KeyMaterialOperationInput,
    SemanticOperationExactReceipt<'keys'>,
    ConfigurationDomainResult<KeyMaterialCommand['kind']>
  >(descriptor, input, async (tx) => {
    const keys = tx.table<KeyRecord, KeyId>('keys')
    const current = await keys.get(keyId)
    if (command.kind === 'key.delete') {
      if (!current) {
        return semanticOperationExecution(
          keySavedResult(keyId, undefined, false, true),
          keyMaterialOperationExactReceipt(
            exactPlan,
            keyId,
            keyMaterialOperationReceipt(undefined, undefined, 'none'),
          ),
        )
      }
      await deleteSemanticByteOwner(tx, 'keys', keyId, current)
      const receipt = keyMaterialOperationReceipt(current, undefined, 'delete')
      recordBrowserCommandKeyRequestMaterialAffectedSet(tx, keyId)
      return semanticOperationExecution(
        keySavedResult(keyId, undefined, true, true),
        keyMaterialOperationExactReceipt(exactPlan, keyId, receipt),
      )
    }
    const currentRevision = current?.materialRevision ?? null
    if (currentRevision !== command.expectedMaterialRevision) {
      return semanticOperationExecution(
        {
          kind: 'conflict',
          reason: 'key-material-revision',
          ...(currentRevision === null ? {} : { currentVersion: currentRevision }),
        } as const,
        keyMaterialOperationExactReceipt(
          exactPlan,
          keyId,
          keyMaterialOperationReceipt(current, current, 'none'),
        ),
      )
    }
    const expectedNextRevision = (command.expectedMaterialRevision ?? -1) + 1
    if ((command.key.materialRevision ?? 0) !== expectedNextRevision) {
      return semanticOperationExecution(
        {
          kind: 'conflict',
          reason: 'key-material-revision',
          ...(currentRevision === null ? {} : { currentVersion: currentRevision }),
        } as const,
        keyMaterialOperationExactReceipt(
          exactPlan,
          keyId,
          keyMaterialOperationReceipt(current, current, 'none'),
        ),
      )
    }
    const next = structuredClone(command.key)
    await putSemanticByteOwner(tx, 'keys', next, current)
    const receipt = keyMaterialOperationReceipt(current, next, 'write')
    recordBrowserCommandKeyRequestMaterialAffectedSet(tx, keyId)
    return semanticOperationExecution(
      keySavedResult(next.id, next, true, false),
      keyMaterialOperationExactReceipt(exactPlan, keyId, receipt),
    )
  })
}

function keySavedResult(
  keyId: KeyId,
  key: KeyRecord | undefined,
  changed: boolean,
  deleted: boolean,
): Extract<ConfigurationDomainResult, { kind: 'key-saved' }> {
  return {
    kind: 'key-saved',
    keyId,
    ...(key ? { key } : {}),
    changed,
    deleted,
  }
}

async function switchChatProfile(
  command: Extract<ConfigurationDomainCommand, { kind: 'chat.switch-profile' }>,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'chat.switch-profile'>> {
  if (
    command.target.profileId !== command.profileId ||
    (command.target.key.kind === 'material' && command.target.key.keyId !== command.requestKeyId) ||
    (command.model.kind === 'pending' &&
      !sameValue(command.target, command.model.resolution.target))
  ) {
    return { kind: 'invalid', reason: 'model-resolution-target-mismatch' }
  }
  const input: ChatRequestTargetOperationInput = {
    operationKind: command.kind,
    chatId: command.chatId,
    profileId: command.profileId,
    requestKeyId: command.requestKeyId,
    previousProfileId: command.previousProfileId,
    previousModelResolutionTarget: command.previousModelResolutionTarget,
    nextModelResolutionTarget:
      command.model.kind === 'pending' ? command.model.resolution.target : null,
    readModelsCache: command.model.kind === 'pending',
    modelsHeaderKey: null,
  }
  return executeChatRequestTargetOperation<ConfigurationDomainResult<'chat.switch-profile'>>(
    commandMeta,
    command.kind,
    input,
    async (tx) => {
      const chatMutation = openLinkedChatMutation(tx)
      const [currentChat, currentProfile, currentKey] = await Dexie.Promise.all([
        chatMutation.read(command.chatId),
        tx.table<ConnectionProfile, ProfileId>('profiles').get(command.profileId),
        command.requestKeyId
          ? tx.table<KeyRecord, KeyId>('keys').get(command.requestKeyId)
          : Dexie.Promise.resolve(undefined),
      ])
      const modelsCache =
        input.readModelsCache && currentProfile
          ? await readDiscoveryCacheRowWithEvidence(tx, 'models', [
              currentProfile.id,
              modelsCacheKey(modelCatalogQueryForConnectionKind(currentProfile.kind)),
            ])
          : undefined
      const modelsCacheRead = modelsCache
        ? {
            headerFound: modelsCache.headerFound,
            metadataFound: modelsCache.metadataFound,
            payloadFound: modelsCache.payloadFound,
          }
        : undefined
      const receipt = (values: Parameters<typeof chatRequestTargetOperationReceipt>[1]) =>
        chatRequestTargetOperationReceipt(input, {
          ...values,
          observedKey: currentKey,
          previousProfile: currentProfile,
          modelsCacheRead,
          chat:
            values.chat ??
            (currentChat ? chatConfigurationOperationReceipt(currentChat, currentChat) : undefined),
        })
      if (
        !currentProfile ||
        (currentProfile.apiKeyRef ?? null) !== command.requestKeyId ||
        !sameValue(configurationRequestRevisionFor(currentProfile, currentKey), command.target)
      ) {
        return semanticOperationExecution(
          { kind: 'invalid', reason: 'model-resolution-target-mismatch' } as const,
          receipt({}),
        )
      }
      if (!currentChat) {
        return semanticOperationExecution(
          { kind: 'missing', entity: 'chat', id: command.chatId } as const,
          receipt({}),
        )
      }
      if (
        currentChat.settings.profileId !== command.previousProfileId ||
        !sameValue(
          currentChat.modelResolution?.target ?? null,
          command.previousModelResolutionTarget,
        )
      ) {
        return semanticOperationExecution(
          { kind: 'invalid', reason: 'model-resolution-target-mismatch' } as const,
          receipt({}),
        )
      }
      const currentVersion = currentChat.configurationVersion ?? 0
      if (currentVersion !== command.expectedConfigurationVersion) {
        return semanticOperationExecution(
          {
            kind: 'conflict',
            reason: 'configuration-version',
            currentVersion,
          } as const,
          receipt({ chat: chatConfigurationOperationReceipt(currentChat, currentChat) }),
        )
      }
      const chat = await selectedChatConfigurationTransition(
        tx,
        chatMutation,
        currentChat,
        switchedProfileChat(
          currentChat,
          currentProfile,
          modelsCache?.row?.profileRevision === configurationRequestRevisionKey(command.target)
            ? modelsCache.row.payload
            : undefined,
          command,
        ),
        command.now,
      )
      const lastUsedAt = Math.max(currentProfile.lastUsedAt ?? 0, command.now)
      let nextProfile = currentProfile
      let profileProjection: ConfigurationCatalogProjectionMutationReceipt | undefined
      if (lastUsedAt !== currentProfile.lastUsedAt) {
        nextProfile = { ...currentProfile, lastUsedAt }
        await replaceLinkedSemanticByteOwnerPreservingLinksBatch(
          tx,
          'profiles',
          [nextProfile],
          [currentProfile],
        )
        profileProjection = await applyConfigurationProfileCatalogProjectionTransition(
          tx,
          currentProfile,
          nextProfile,
        )
      }
      return semanticOperationExecution(
        {
          ...chatUpdatedResult(chat.next ?? currentChat, chat.mutation === 'write'),
          ...(profileProjection ? { affectedProfileIds: [currentProfile.id] } : {}),
        },
        receipt({
          nextProfile,
          profileProjection,
          chat,
        }),
      )
    },
  )
}

function switchedProfileChat(
  chat: Chat,
  profile: ConnectionProfile,
  cachedModelsPayload: unknown,
  command: Extract<ConfigurationDomainCommand, { kind: 'chat.switch-profile' }>,
): Chat {
  const model =
    command.model.kind === 'pending' && cachedModelsPayload !== undefined
      ? {
          kind: 'resolved' as const,
          id: resolveModelIdFromCatalog(
            command.model.resolution.sourceModelId,
            profile.kind,
            normalizeModelsResponse(cachedModelsPayload),
          ),
        }
      : command.model
  const settings: ChatSettings = {
    ...chat.settings,
    profileId: command.profileId,
    api: command.api,
    model: model.kind === 'resolved' ? model.id : model.immediateId,
  }
  const transformed = withModelResolutionCancellation({ ...chat, settings }, true)
  if (model.kind === 'pending') {
    transformed.modelResolution = {
      ...structuredClone(model.resolution),
      expectedConfigurationVersion: (chat.configurationVersion ?? 0) + 1,
    }
  }
  return transformed
}

async function resolveChatModel(
  command: Extract<ConfigurationDomainCommand, { kind: 'chat.resolve-model' }>,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'chat.resolve-model'>> {
  if (
    command.pendingTarget.profileId !== command.target.profileId ||
    command.catalog.profileRevision !== configurationRequestRevisionKey(command.target) ||
    (command.target.key.kind === 'material' && command.target.key.keyId !== command.requestKeyId)
  ) {
    return { kind: 'invalid', reason: 'model-resolution-target-mismatch' }
  }
  const input: ChatRequestTargetOperationInput = {
    operationKind: command.kind,
    chatId: command.chatId,
    profileId: command.target.profileId,
    requestKeyId: command.requestKeyId,
    previousProfileId: null,
    previousModelResolutionTarget: command.pendingTarget,
    nextModelResolutionTarget: command.target,
    readModelsCache: false,
    modelsHeaderKey: [command.target.profileId, command.catalog.queryKey],
  }
  return executeChatRequestTargetOperation<ConfigurationDomainResult<'chat.resolve-model'>>(
    commandMeta,
    command.kind,
    input,
    async (tx) => {
      const chatMutation = openLinkedChatMutation(tx)
      const [currentChat, currentProfile, currentKey, modelsHeader] = await Dexie.Promise.all([
        chatMutation.read(command.chatId),
        tx.table<ConnectionProfile, ProfileId>('profiles').get(command.target.profileId),
        command.requestKeyId
          ? tx.table<KeyRecord, KeyId>('keys').get(command.requestKeyId)
          : Dexie.Promise.resolve(undefined),
        tx
          .table<CachedModelsStorageRow, [ProfileId, string]>('models')
          .get([command.target.profileId, command.catalog.queryKey]),
      ])
      const receipt = (chat?: ChatConfigurationOperationReceipt) =>
        chatRequestTargetOperationReceipt(input, {
          observedKey: currentKey,
          previousProfile: currentProfile,
          modelsHeader,
          chat:
            chat ??
            (currentChat ? chatConfigurationOperationReceipt(currentChat, currentChat) : undefined),
        })
      if (!currentProfile) {
        return semanticOperationExecution(
          { kind: 'missing', entity: 'profile', id: command.target.profileId } as const,
          receipt(),
        )
      }
      if (
        (currentProfile.apiKeyRef ?? null) !== command.requestKeyId ||
        !sameValue(configurationRequestRevisionFor(currentProfile, currentKey), command.target)
      ) {
        return semanticOperationExecution(
          { kind: 'invalid', reason: 'model-resolution-target-mismatch' } as const,
          receipt(),
        )
      }
      const expectedQueryKey = modelsCacheKey(
        modelCatalogQueryForConnectionKind(currentProfile.kind),
      )
      const catalogChanged =
        command.catalog.queryKey !== expectedQueryKey ||
        (command.catalog.kind === 'cached'
          ? !modelsHeader ||
            modelsHeader.profileRevision !== command.catalog.profileRevision ||
            modelsHeader.payloadId !== command.catalog.payloadId ||
            modelsHeader.payloadByteLength !== command.catalog.payloadByteLength ||
            modelsHeader.fetchedAt !== command.catalog.fetchedAt
          : modelsHeader?.profileRevision === command.catalog.profileRevision &&
            modelsHeader.fetchedAt >= command.catalog.fetchedAt)
      if (catalogChanged) {
        return semanticOperationExecution(
          { kind: 'invalid', reason: 'model-resolution-catalog-changed' } as const,
          receipt(),
        )
      }
      if (!currentChat) {
        return semanticOperationExecution(
          { kind: 'missing', entity: 'chat', id: command.chatId } as const,
          receipt(),
        )
      }
      const noChatChange = chatConfigurationOperationReceipt(currentChat, currentChat)
      const currentVersion = currentChat.configurationVersion ?? 0
      if (currentVersion !== command.expectedConfigurationVersion) {
        return semanticOperationExecution(
          {
            kind: 'conflict',
            reason: 'configuration-version',
            currentVersion,
          } as const,
          receipt(noChatChange),
        )
      }
      const pending = currentChat.modelResolution
      if (!pending || pending.intentId !== command.intentId) {
        return semanticOperationExecution(
          { kind: 'conflict', reason: 'model-resolution-intent' } as const,
          receipt(noChatChange),
        )
      }
      if (!sameValue(pending.target, command.pendingTarget)) {
        return semanticOperationExecution(
          { kind: 'invalid', reason: 'model-resolution-target-mismatch' } as const,
          receipt(noChatChange),
        )
      }
      const transformed = withModelResolutionCancellation(
        {
          ...currentChat,
          settings: { ...currentChat.settings, model: command.modelId },
        },
        true,
      )
      const chat = await selectedChatConfigurationTransition(
        tx,
        chatMutation,
        currentChat,
        transformed,
        command.now,
      )
      return semanticOperationExecution(
        chatUpdatedResult(chat.next ?? currentChat, chat.mutation === 'write'),
        receipt(chat),
      )
    },
  )
}

type ChatConfigurationTransformResult =
  | Chat
  | Extract<ConfigurationDomainResult, { kind: 'conflict' | 'invalid' }>

async function mutateChatConfiguration(
  operationKind:
    | 'chat.settings-patch'
    | 'chat.settings-fields-patch'
    | 'chat.settings-replace'
    | 'prompt-preset.local-commit',
  chatId: ChatId,
  now: number,
  introducedTargetResources: readonly string[],
  transform: (chat: Chat) => ChatConfigurationTransformResult,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'chat.settings-patch'>> {
  const input: ChatConfigurationOperationInput = {
    chatId,
    introducedTargetResources: sortedUnique(introducedTargetResources),
  }
  const exactPlan = chatConfigurationOperationExactPlan()
  const exactReceipt = (receipt: ChatConfigurationOperationReceipt) =>
    chatConfigurationOperationExactReceipt(exactPlan, input, receipt)
  return commandMeta.executeSemanticOperation<
    ChatRowLinkedTable,
    ChatConfigurationOperationInput,
    SemanticOperationExactReceipt<ChatRowLinkedTable>,
    ConfigurationDomainResult<'chat.settings-patch'>
  >(
    chatConfigurationOperationDescriptor(operationKind),
    input,
    async (
      tx,
    ): Promise<
      SemanticOperationExecution<
        ConfigurationDomainResult<'chat.settings-patch'>,
        SemanticOperationExactReceipt<ChatRowLinkedTable>
      >
    > => {
      const chatMutation = openLinkedChatMutation(tx)
      const current = await chatMutation.read(chatId)
      if (!current) {
        return semanticOperationExecution(
          { kind: 'missing', entity: 'chat', id: chatId } as const,
          exactReceipt(chatConfigurationOperationReceipt(undefined, undefined)),
        )
      }
      const transformed = transform(structuredClone(current))
      if (isConfigurationErrorResult(transformed)) {
        return semanticOperationExecution(
          transformed,
          exactReceipt(chatConfigurationOperationReceipt(current, current)),
        )
      }
      if (!chatConfigurationChanged(current, transformed)) {
        return semanticOperationExecution(
          chatUpdatedResult(current, false),
          exactReceipt(chatConfigurationOperationReceipt(current, current)),
        )
      }
      const written = await configuredChat(tx, current, transformed, now)
      chatMutation.replaceLinked(chatId, () => written)
      const transition = await chatMutation.commit()
      return semanticOperationExecution(
        chatUpdatedResult(written, true),
        exactReceipt(chatConfigurationOperationReceipt(current, written, transition)),
      )
    },
  )
}

async function mutateImageAllowlist(
  command: Extract<
    ConfigurationDomainCommand,
    { kind: 'image-allowlist.add' | 'image-allowlist.remove' }
  >,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'image-allowlist.add'>> {
  const key = IMAGE_ALLOWLIST_KEY
  return mutateWorkspaceSetting<string[]>(
    command.kind,
    key,
    (current) => {
      const values = customImageOriginsFromStored(current)
      if (command.kind === 'image-allowlist.add') {
        return values.includes(command.origin) ? values : [...values, command.origin]
      }
      return values.filter((value) => value !== command.origin)
    },
    commandMeta,
  )
}

async function patchRenderingPreferences(
  command: Extract<ConfigurationDomainCommand, { kind: 'rendering-preferences.patch' }>,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'rendering-preferences.patch'>> {
  return mutateWorkspaceSetting(
    command.kind,
    RENDERING_PREFERENCES_KEY,
    (current) =>
      normalizeRenderingPreferences({
        ...normalizeRenderingPreferences(current),
        ...command.patch,
      }),
    commandMeta,
  )
}

async function saveWorkspaceSetting(
  operationKind: ConfigurationDomainCommand['kind'],
  key: string,
  value: unknown,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'global-preference.set'>> {
  return mutateWorkspaceSetting(operationKind, key, () => structuredClone(value), commandMeta)
}

async function mutateWorkspaceSetting<T>(
  operationKind: ConfigurationDomainCommand['kind'],
  key: string,
  mutate: (current: unknown) => T,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'global-preference.set'>> {
  return executeSettingRowsOperation(commandMeta, operationKind, [key], {
    kind: 'write',
    project: ([current]) => [{ key, value: mutate(current?.value) }],
    result: (changed, [next]) => ({
      kind: 'workspace-setting-saved',
      key,
      value: next?.value as T,
      changed,
    }),
  })
}

async function clearRecentModelState(
  operationKind: Extract<ConfigurationDomainCommand, { kind: 'recent-model.clear' }>['kind'],
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'recent-model.clear'>> {
  return mutateRecentModelState(operationKind, null, 0, commandMeta)
}

async function mutateRecentModelState(
  operationKind: Extract<ConfigurationDomainCommand, { kind: 'recent-model.clear' }>['kind'],
  candidate: {
    readonly modelId: string
    readonly usedAt: number
    readonly streamId: string
  } | null,
  limit: number,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'recent-model.clear'>> {
  return executeSettingRowsOperation(
    commandMeta,
    operationKind,
    [RECENT_MODELS_KEY, RECENT_MODEL_RECENCY_KEY],
    {
      kind: 'write',
      project: (rows) => {
        const byKey = new Map(rows.flatMap((row) => (row ? [[row.key, row] as const] : [])))
        const publicRow = byKey.get(RECENT_MODELS_KEY)
        const recencyRow = byKey.get(RECENT_MODEL_RECENCY_KEY)
        const next = candidate
          ? advanceRecentModelState(publicRow?.value, recencyRow?.value, candidate, limit)
          : {
              changed:
                !publicRow ||
                !recencyRow ||
                !sameValue(publicRow.value, []) ||
                !sameValue(recencyRow.value, emptyRecentModelRecency()),
              models: [],
              recency: emptyRecentModelRecency(),
            }
        return [
          { key: RECENT_MODEL_RECENCY_KEY, value: next.recency },
          { key: RECENT_MODELS_KEY, value: next.models },
        ]
      },
      result: (changed, rows) => ({
        kind: 'workspace-setting-saved',
        key: RECENT_MODELS_KEY,
        value: rows.find((row) => row.key === RECENT_MODELS_KEY)?.value ?? [],
        changed,
      }),
    },
  )
}

function isRecentModelSettingKey(key: string): boolean {
  return key === RECENT_MODELS_KEY || key === RECENT_MODEL_RECENCY_KEY
}

async function createTextTemplate(
  command: Extract<ConfigurationDomainCommand, { kind: 'text-template.create' }>,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'text-template.create'>> {
  return executeConfigurationEntityRowOperation(commandMeta, command)
}

function executeConfigurationEntityRowOperation(
  commandMeta: ConfigurationCommandMetaPort,
  command: Extract<ConfigurationDomainCommand, { kind: 'key.touch' }>,
): Promise<ConfigurationDomainResult<'key.touch'>>
function executeConfigurationEntityRowOperation(
  commandMeta: ConfigurationCommandMetaPort,
  command: Extract<ConfigurationDomainCommand, { kind: 'text-template.create' }>,
): Promise<ConfigurationDomainResult<'text-template.create'>>
function executeConfigurationEntityRowOperation(
  commandMeta: ConfigurationCommandMetaPort,
  command: Extract<ConfigurationDomainCommand, { kind: 'text-template.update' }>,
): Promise<ConfigurationDomainResult<'text-template.update'>>
async function executeConfigurationEntityRowOperation(
  commandMeta: ConfigurationCommandMetaPort,
  command: Extract<
    ConfigurationDomainCommand,
    { kind: 'key.touch' | 'text-template.create' | 'text-template.update' }
  >,
): Promise<
  ConfigurationDomainResult<'key.touch' | 'text-template.create' | 'text-template.update'>
> {
  switch (command.kind) {
    case 'key.touch': {
      const input = { keyId: command.keyId }
      const exactPlan = configurationEntityOperationExactPlan(command.kind, command.keyId)
      return commandMeta.executeSemanticOperation<
        'keys',
        KeyTouchOperationInput,
        SemanticOperationExactReceipt<'keys'>,
        ConfigurationDomainResult<'key.touch'>
      >(keyTouchOperationDescriptor, input, async (tx) => {
        const current = await tx.table<KeyRecord, KeyId>('keys').get(command.keyId)
        if (!current) {
          return semanticOperationExecution(
            { kind: 'missing', entity: 'key', id: command.keyId } as const,
            configurationEntityOperationExactReceipt(
              exactPlan,
              'keys',
              command.keyId,
              { kind: 'key', keyIds: [command.keyId], facets: ['usage'] },
              false,
            ),
          )
        }
        const lastUsedAt = Math.max(current.lastUsedAt ?? 0, command.now)
        if (lastUsedAt === current.lastUsedAt) {
          return semanticOperationExecution(
            keySavedResult(current.id, current, false, false),
            configurationEntityOperationExactReceipt(
              exactPlan,
              'keys',
              command.keyId,
              { kind: 'key', keyIds: [command.keyId], facets: ['usage'] },
              false,
            ),
          )
        }
        const next = { ...current, lastUsedAt }
        await replaceSemanticByteOwner(tx, 'keys', next, current)
        return semanticOperationExecution(
          keySavedResult(next.id, next, true, false),
          configurationEntityOperationExactReceipt(
            exactPlan,
            'keys',
            command.keyId,
            { kind: 'key', keyIds: [command.keyId], facets: ['usage'] },
            true,
          ),
        )
      })
    }
    case 'text-template.create': {
      const input = { templateId: command.template.id }
      const exactPlan = configurationEntityOperationExactPlan(command.kind, command.template.id)
      return commandMeta.executeSemanticOperation<
        'textTemplates',
        TextTemplateEntityOperationInput,
        SemanticOperationExactReceipt<'textTemplates'>,
        ConfigurationDomainResult<'text-template.create'>
      >(textTemplateEntityOperationDescriptor(command.kind), input, async (tx) => {
        const table = tx.table<SavedTextTemplate, TextTemplateId>('textTemplates')
        if (await table.get(command.template.id)) {
          return semanticOperationExecution(
            { kind: 'conflict', reason: 'link-changed' } as const,
            configurationEntityOperationExactReceipt(
              exactPlan,
              'textTemplates',
              command.template.id,
              { kind: 'text-template', templateIds: [command.template.id] },
              false,
            ),
          )
        }
        await addTextTemplateByteOwner(tx, structuredClone(command.template))
        return semanticOperationExecution(
          {
            kind: 'text-template-saved',
            templateId: command.template.id,
            changed: true,
          } as const,
          configurationEntityOperationExactReceipt(
            exactPlan,
            'textTemplates',
            command.template.id,
            { kind: 'text-template', templateIds: [command.template.id] },
            true,
          ),
        )
      })
    }
    case 'text-template.update': {
      const input = { templateId: command.templateId }
      const exactPlan = configurationEntityOperationExactPlan(command.kind, command.templateId)
      return commandMeta.executeSemanticOperation<
        'textTemplates',
        TextTemplateEntityOperationInput,
        SemanticOperationExactReceipt<'textTemplates'>,
        ConfigurationDomainResult<'text-template.update'>
      >(textTemplateEntityOperationDescriptor(command.kind), input, async (tx) => {
        const table = tx.table<SavedTextTemplate, TextTemplateId>('textTemplates')
        const current = await table.get(command.templateId)
        if (!current) {
          return semanticOperationExecution(
            { kind: 'missing', entity: 'text-template', id: command.templateId } as const,
            configurationEntityOperationExactReceipt(
              exactPlan,
              'textTemplates',
              command.templateId,
              { kind: 'text-template', templateIds: [command.templateId] },
              false,
            ),
          )
        }
        const next: SavedTextTemplate = {
          ...current,
          ...(command.patch.name === undefined
            ? {}
            : { name: command.patch.name.trim() || current.name }),
          ...(command.patch.config === undefined
            ? {}
            : { config: normalizeTextTemplateConfig(command.patch.config) }),
          updatedAt: command.now,
        }
        if (sameValue(current, { ...next, updatedAt: current.updatedAt })) {
          return semanticOperationExecution(
            {
              kind: 'text-template-saved',
              templateId: command.templateId,
              changed: false,
            } as const,
            configurationEntityOperationExactReceipt(
              exactPlan,
              'textTemplates',
              command.templateId,
              { kind: 'text-template', templateIds: [command.templateId] },
              false,
            ),
          )
        }
        await replaceTextTemplateByteOwner(tx, next, current)
        return semanticOperationExecution(
          {
            kind: 'text-template-saved',
            templateId: command.templateId,
            changed: true,
          } as const,
          configurationEntityOperationExactReceipt(
            exactPlan,
            'textTemplates',
            command.templateId,
            { kind: 'text-template', templateIds: [command.templateId] },
            true,
          ),
        )
      })
    }
  }
}

async function updateTextTemplate(
  command: Extract<ConfigurationDomainCommand, { kind: 'text-template.update' }>,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'text-template.update'>> {
  return executeConfigurationEntityRowOperation(commandMeta, command)
}

async function createAndSelectTextTemplate(
  command: Extract<ConfigurationDomainCommand, { kind: 'text-template.create-and-select' }>,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'text-template.create-and-select'>> {
  const input: ChatSelectionOperationInput = {
    chatId: command.chatId,
    sourceId: command.template.id,
    resourceNames: [
      `chat-meta:${command.chatId}`,
      configurationTargetResourceName('text-template', command.template.id),
    ],
  }
  return executeChatSelectionOperation<
    ConfigurationDomainResult<'text-template.create-and-select'>
  >(commandMeta, command.kind, input, async (tx) => {
    const chatMutation = openLinkedChatMutation(tx)
    const [chat, currentTemplate] = await Dexie.Promise.all([
      chatMutation.read(command.chatId),
      tx.table<SavedTextTemplate, TextTemplateId>('textTemplates').get(command.template.id),
    ])
    if (!chat) {
      return semanticOperationExecution(
        { kind: 'missing', entity: 'chat', id: command.chatId } as const,
        chatSelectionOperationReceipt(command.kind, input, {
          previousSource: currentTemplate,
          nextSource: currentTemplate,
        }),
      )
    }
    if (currentTemplate) {
      return semanticOperationExecution(
        { kind: 'conflict', reason: 'link-changed' } as const,
        chatSelectionOperationReceipt(command.kind, input, {
          previousSource: currentTemplate,
          nextSource: currentTemplate,
          chat: chatConfigurationOperationReceipt(chat, chat),
        }),
      )
    }
    const template = structuredClone(command.template)
    await addTextTemplateByteOwner(tx, template)
    const chatReceipt = await selectedChatConfigurationTransition(
      tx,
      chatMutation,
      chat,
      withModelResolutionCancellation(
        {
          ...chat,
          settings: { ...chat.settings, textTemplate: template.id },
        },
        true,
      ),
      command.now,
    )
    const affectedChatIds = chatReceipt.mutation === 'write' ? [chat.id] : []
    return semanticOperationExecution(
      {
        kind: 'text-template-saved',
        templateId: template.id,
        changed: true,
        affectedChatIds,
      } as const,
      chatSelectionOperationReceipt(command.kind, input, {
        nextSource: template,
        sourceMutation: 'write',
        chat: chatReceipt,
      }),
    )
  })
}

async function deleteTextTemplate(
  command: Extract<ConfigurationDomainCommand, { kind: 'text-template.delete' }>,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'text-template.delete'>> {
  return executeConfigurationTargetFanoutOperation(commandMeta, command)
}

async function createChatPreset(
  command: Extract<ConfigurationDomainCommand, { kind: 'chat-preset.create' }>,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'chat-preset.create'>> {
  const operationKind = command.kind
  const profileId = command.preset.connectionProfileId
  const provisional: ChatPreset = {
    ...structuredClone(command.preset),
    settings: { ...normalizeChatSettings(command.preset.settings), profileId },
    createdAt: command.now,
    updatedAt: command.now,
  }
  const input: PresetLifecycleOperationInput = {
    presetId: provisional.id,
    resourceNames: configurationLockNames(
      ['preset-order', `preset:${provisional.id}`, `profile:${profileId}`],
      configurationLinksForPreset(provisional),
    ),
  }
  return executePresetLifecycleOperation<ConfigurationDomainResult<'chat-preset.create'>>(
    commandMeta,
    operationKind,
    input,
    async (tx) => {
      const currentProfile = await tx.table<ConnectionProfile, ProfileId>('profiles').get(profileId)
      if (!currentProfile) {
        return semanticOperationExecution(
          { kind: 'missing', entity: 'profile', id: profileId } as const,
          presetLifecycleOperationReceipt(operationKind, provisional.id, {
            presetReadRequests: 0,
            profileReadRequests: 1,
          }),
        )
      }
      const presets = tx.table<ChatPreset, PresetId>('presets')
      const current = await presets.get(provisional.id)
      if (current) {
        return semanticOperationExecution(
          { kind: 'conflict', reason: 'link-changed' } as const,
          presetLifecycleOperationReceipt(operationKind, provisional.id, {
            previous: current,
            next: current,
            presetReadRequests: 1,
            profileReadRequests: 1,
          }),
        )
      }
      const preset: ChatPreset = {
        ...provisional,
        settings: withProfileApiDefaults(
          { ...normalizeChatSettings(command.preset.settings), profileId: currentProfile.id },
          currentProfile,
        ),
      }
      const links = await addLinkedSemanticByteOwner(tx, 'presets', preset)
      const order = await appendPresetOrderEntry(tx, preset.id)
      const catalog = await applyConfigurationPresetCatalogProjectionTransition(
        tx,
        undefined,
        preset,
      )
      return semanticOperationExecution(
        {
          kind: 'chat-preset-saved',
          preset,
          affectedPresetIds: [preset.id],
        } as const,
        presetLifecycleOperationReceipt(operationKind, preset.id, {
          next: preset,
          presetReadRequests: 1,
          profileReadRequests: 1,
          links,
          catalog,
          order,
        }),
      )
    },
  )
}

async function updateChatPreset(
  command: Extract<ConfigurationDomainCommand, { kind: 'chat-preset.update' }>,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'chat-preset.update'>> {
  const operationKind = command.kind
  const introducedProfileId = command.patch.connectionProfileId
  const introducedSettings = command.patch.settings
  const input: PresetLifecycleOperationInput = {
    presetId: command.presetId,
    resourceNames: sortedUnique([
      'preset-order',
      `preset:${command.presetId}`,
      ...(introducedProfileId
        ? [
            `profile:${introducedProfileId}`,
            configurationTargetResourceName('profile', introducedProfileId),
          ]
        : []),
      ...(introducedSettings ? chatSettingsIntroducedTargetResources(introducedSettings) : []),
    ]),
  }
  return executePresetLifecycleOperation<ConfigurationDomainResult<'chat-preset.update'>>(
    commandMeta,
    operationKind,
    input,
    async (tx) => {
      const current = await tx.table<ChatPreset, PresetId>('presets').get(command.presetId)
      if (!current) {
        return semanticOperationExecution(
          { kind: 'missing', entity: 'chat-preset', id: command.presetId } as const,
          presetLifecycleOperationReceipt(operationKind, command.presetId, {
            presetReadRequests: 1,
          }),
        )
      }
      const profileId = command.patch.connectionProfileId ?? current.connectionProfileId
      const profile = await tx.table<ConnectionProfile, ProfileId>('profiles').get(profileId)
      if (!profile) {
        return semanticOperationExecution(
          { kind: 'missing', entity: 'profile', id: profileId } as const,
          presetLifecycleOperationReceipt(operationKind, command.presetId, {
            previous: current,
            next: current,
            presetReadRequests: 1,
            profileReadRequests: 1,
          }),
        )
      }
      const next = configuredPreset(current, command.patch, profile, command.now)
      const links = await replaceLinkedSemanticByteOwner(tx, 'presets', next, current)
      const catalog = await applyConfigurationPresetCatalogProjectionTransition(tx, current, next)
      return semanticOperationExecution(
        {
          kind: 'chat-preset-saved',
          preset: next,
          affectedPresetIds: [next.id],
        } as const,
        presetLifecycleOperationReceipt(operationKind, next.id, {
          previous: current,
          next,
          presetReadRequests: 1,
          profileReadRequests: 1,
          links,
          catalog,
        }),
      )
    },
  )
}

async function duplicateChatPreset(
  command: Extract<ConfigurationDomainCommand, { kind: 'chat-preset.duplicate' }>,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'chat-preset.duplicate'>> {
  const operationKind = command.kind
  const input: PresetLifecycleOperationInput = {
    presetId: command.copyId,
    resourceNames: sortedUnique([
      'preset-order',
      `preset:${command.sourceId}`,
      `preset:${command.copyId}`,
    ]),
  }
  return executePresetLifecycleOperation<ConfigurationDomainResult<'chat-preset.duplicate'>>(
    commandMeta,
    operationKind,
    input,
    async (tx) => {
      const presets = tx.table<ChatPreset, PresetId>('presets')
      const source = await presets.get(command.sourceId)
      if (!source) {
        return semanticOperationExecution(
          { kind: 'missing', entity: 'chat-preset', id: command.sourceId } as const,
          presetLifecycleOperationReceipt(operationKind, command.copyId, {
            presetReadRequests: 1,
          }),
        )
      }
      const existing = await presets.get(command.copyId)
      if (existing) {
        return semanticOperationExecution(
          { kind: 'conflict', reason: 'link-changed' } as const,
          presetLifecycleOperationReceipt(operationKind, command.copyId, {
            previous: existing,
            next: existing,
            presetReadRequests: 2,
          }),
        )
      }
      const preset = {
        ...structuredClone(source),
        id: command.copyId,
        name: command.name ?? `${source.name} (copy)`,
        createdAt: command.now,
        updatedAt: command.now,
        archived: false,
      }
      delete preset.lastUsedAt
      const links = await addLinkedSemanticByteOwner(tx, 'presets', preset)
      const order = await appendPresetOrderEntry(tx, preset.id)
      const catalog = await applyConfigurationPresetCatalogProjectionTransition(
        tx,
        undefined,
        preset,
      )
      return semanticOperationExecution(
        {
          kind: 'chat-preset-saved',
          preset,
          affectedPresetIds: [preset.id],
        } as const,
        presetLifecycleOperationReceipt(operationKind, preset.id, {
          next: preset,
          presetReadRequests: 2,
          links,
          catalog,
          order,
        }),
      )
    },
  )
}

async function moveChatPreset(
  command: Extract<ConfigurationDomainCommand, { kind: 'chat-preset.move' }>,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'chat-preset.move'>> {
  const plan = presetOrderMoveOperationExactPlan()
  const input: PresetOrderMoveOperationInput = {
    presetId: command.presetId,
    afterPresetId: command.afterPresetId,
  }
  return commandMeta.executeSemanticOperation(
    presetOrderMoveOperationDescriptor,
    input,
    async (
      tx,
    ): Promise<
      SemanticOperationExecution<
        ConfigurationDomainResult<'chat-preset.move'>,
        SemanticOperationExactReceipt<PhysicalStorageTableName>
      >
    > => {
      if (command.afterPresetId === command.presetId) {
        return semanticOperationExecution(
          { kind: 'invalid', reason: 'preset-order-anchor-self' } as const,
          presetOrderMoveOperationExactReceipt(
            plan,
            input,
            emptyPresetOrderMutationReceipt(command.presetId),
          ),
        )
      }
      const table = tx.table<ChatPreset, PresetId>('presets')
      const [current, after] = await Dexie.Promise.all([
        table.get(command.presetId),
        command.afterPresetId ? table.get(command.afterPresetId) : undefined,
      ])
      if (!current) {
        return semanticOperationExecution(
          { kind: 'missing', entity: 'chat-preset', id: command.presetId } as const,
          presetOrderMoveOperationExactReceipt(
            plan,
            input,
            emptyPresetOrderMutationReceipt(command.presetId),
          ),
        )
      }
      if (current.archived === true) {
        return semanticOperationExecution(
          { kind: 'invalid', reason: 'preset-order-target-archived' } as const,
          presetOrderMoveOperationExactReceipt(
            plan,
            input,
            emptyPresetOrderMutationReceipt(command.presetId),
          ),
        )
      }
      if (command.afterPresetId && !after) {
        return semanticOperationExecution(
          { kind: 'missing', entity: 'chat-preset', id: command.afterPresetId } as const,
          presetOrderMoveOperationExactReceipt(
            plan,
            input,
            emptyPresetOrderMutationReceipt(command.presetId),
          ),
        )
      }
      if (after?.archived === true) {
        return semanticOperationExecution(
          { kind: 'invalid', reason: 'preset-order-anchor-archived' } as const,
          presetOrderMoveOperationExactReceipt(
            plan,
            input,
            emptyPresetOrderMutationReceipt(command.presetId),
          ),
        )
      }
      const receipt = await movePresetOrderEntry(tx, current.id, command.afterPresetId)
      if (!receipt.changed) {
        return semanticOperationExecution(
          { kind: 'configuration-noop' } as const,
          presetOrderMoveOperationExactReceipt(plan, input, receipt),
        )
      }
      return semanticOperationExecution(
        {
          kind: 'chat-preset-saved',
          preset: current,
          affectedPresetIds: [current.id],
        } as const,
        presetOrderMoveOperationExactReceipt(plan, input, receipt),
      )
    },
  )
}

async function setChatPresetArchived(
  command: Extract<ConfigurationDomainCommand, { kind: 'chat-preset.set-archived' }>,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'chat-preset.set-archived'>> {
  const operationKind = command.kind
  const input: PresetLifecycleOperationInput = {
    presetId: command.presetId,
    resourceNames: ['preset-order', `preset:${command.presetId}`],
  }
  return executePresetLifecycleOperation<ConfigurationDomainResult<'chat-preset.set-archived'>>(
    commandMeta,
    operationKind,
    input,
    async (tx) => {
      const current = await tx.table<ChatPreset, PresetId>('presets').get(command.presetId)
      if (!current) {
        return semanticOperationExecution(
          { kind: 'missing', entity: 'chat-preset', id: command.presetId } as const,
          presetLifecycleOperationReceipt(operationKind, command.presetId, {
            presetReadRequests: 1,
          }),
        )
      }
      if ((current.archived === true) === command.archived) {
        return semanticOperationExecution(
          { kind: 'configuration-noop' } as const,
          presetLifecycleOperationReceipt(operationKind, command.presetId, {
            previous: current,
            next: current,
            presetReadRequests: 1,
          }),
        )
      }
      const preset: ChatPreset = {
        ...current,
        archived: command.archived,
        updatedAt: command.now,
      }
      const links = await replaceLinkedSemanticByteOwner(tx, 'presets', preset, current)
      const order = command.archived
        ? await removePresetOrderEntry(tx, preset.id)
        : await appendPresetOrderEntry(tx, preset.id)
      const catalog = await applyConfigurationPresetCatalogProjectionTransition(tx, current, preset)
      return semanticOperationExecution(
        {
          kind: 'chat-preset-saved',
          preset,
          affectedPresetIds: [preset.id],
        } as const,
        presetLifecycleOperationReceipt(operationKind, preset.id, {
          previous: current,
          next: preset,
          presetReadRequests: 1,
          links,
          catalog,
          order,
        }),
      )
    },
  )
}

async function deleteChatPreset(
  command: Extract<ConfigurationDomainCommand, { kind: 'chat-preset.delete' }>,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'chat-preset.delete'>> {
  const operationKind = command.kind
  const input: PresetLifecycleOperationInput = {
    presetId: command.presetId,
    resourceNames: sortedUnique([
      'preset-order',
      `preset:${command.presetId}`,
      configurationTargetResourceName('chat-preset', command.presetId),
    ]),
  }
  return executePresetLifecycleOperation<ConfigurationDomainResult<'chat-preset.delete'>>(
    commandMeta,
    operationKind,
    input,
    async (tx) => {
      const chatMutation = openLinkedChatMutation(tx)
      const preset = await tx.table<ChatPreset, PresetId>('presets').get(command.presetId)
      if (!preset) {
        return semanticOperationExecution(
          { kind: 'missing', entity: 'chat-preset', id: command.presetId } as const,
          presetLifecycleOperationReceipt(operationKind, command.presetId, {
            presetReadRequests: 1,
          }),
        )
      }
      const targetLinks = await readTargetLinksFromTransaction(tx, 'chat-preset', command.presetId)
      for (const link of targetLinks) {
        if (link.ownerKind !== 'chat') {
          throw new Error(`ConfigurationLinkOwnerInvalid:${link.ownerKey}`)
        }
      }
      const targetLinkIds = targetLinks.map(({ id }) => id).sort()
      const chatReadIds = sortedUnique(targetLinks.map(({ ownerId }) => ownerId))
      const chatRows = chatReadIds.length > 0 ? await chatMutation.readMany(chatReadIds) : []
      if (chatRows.some((chat) => !chat)) {
        const missingIndex = chatRows.findIndex((chat) => !chat)
        const missingId = chatReadIds[missingIndex]
        const link = targetLinks.find(({ ownerId }) => ownerId === missingId)
        throw new Error(`ConfigurationLinkOwnerMissing:${link?.ownerKey ?? missingId}`)
      }

      const chatClock = new TransactionChatUpdateClock()
      const chatWrites: Array<{
        readonly previous: Chat
        readonly next: Chat
      }> = []
      for (const previous of chatRows as Chat[]) {
        const transformed = { ...previous }
        delete transformed.presetId
        chatWrites.push({
          previous,
          next: await configuredChat(tx, previous, transformed, command.now, chatClock),
        })
      }
      for (const { previous, next } of chatWrites) {
        chatMutation.replaceLinked(previous.id, () => next)
      }
      const chats = chatWrites.length > 0 ? await chatMutation.commit() : undefined
      const writtenChatIds = chatWrites.map(({ next }) => next.id)
      const order =
        preset.archived === true
          ? emptyPresetOrderMutationReceipt(preset.id)
          : await removePresetOrderEntry(tx, preset.id)
      const links = await deleteLinkedSemanticByteOwner(tx, 'presets', preset.id, preset)
      const catalog = await applyConfigurationPresetCatalogProjectionDeletion(tx, preset)
      return semanticOperationExecution(
        {
          kind: 'chat-preset-saved',
          preset,
          affectedPresetIds: [preset.id],
          affectedChatIds: writtenChatIds,
          ...(writtenChatIds.length === 1 ? { chatId: writtenChatIds[0], chatChanged: true } : {}),
        } as const,
        presetLifecycleOperationReceipt(operationKind, preset.id, {
          previous: preset,
          presetReadRequests: 1,
          links,
          catalog,
          order,
          targetQueryExecuted: true,
          targetLinkIds,
          chatReadIds,
          writtenChatIds,
          ...(chats ? { chats } : {}),
        }),
      )
    },
  )
}

function configuredPreset(
  current: ChatPreset,
  patch: Extract<ConfigurationDomainCommand, { kind: 'chat-preset.update' }>['patch'],
  profile: ConnectionProfile,
  now: number,
): ChatPreset {
  const next: ChatPreset = {
    ...current,
    ...structuredClone(patch),
    id: current.id,
    createdAt: current.createdAt,
    updatedAt: now,
  }
  if (patch.connectionProfileId !== undefined || patch.settings !== undefined) {
    next.connectionProfileId = profile.id
    next.settings = withProfileApiDefaults(
      { ...normalizeChatSettings(next.settings), profileId: profile.id },
      profile,
    )
  }
  return next
}

async function createAndLinkChatPreset(
  command: Extract<ConfigurationDomainCommand, { kind: 'chat-preset.create-and-link' }>,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'chat-preset.create-and-link'>> {
  if (command.preset.connectionProfileId !== command.preset.settings.profileId) {
    return { kind: 'invalid', reason: 'preset-profile-mismatch' }
  }
  const operationKind = command.kind
  const profileId = command.preset.connectionProfileId
  const provisional: ChatPreset = {
    ...structuredClone(command.preset),
    settings: { ...normalizeChatSettings(command.preset.settings), profileId },
    createdAt: command.now,
    updatedAt: command.now,
  }
  const input: PresetLifecycleOperationInput = {
    presetId: provisional.id,
    chatId: command.chatId,
    resourceNames: sortedUnique([
      'preset-order',
      `chat-meta:${command.chatId}`,
      `preset:${provisional.id}`,
      `profile:${profileId}`,
      configurationTargetResourceName('chat-preset', provisional.id),
      ...configurationTargetResourceNamesForLinks(configurationLinksForPreset(provisional)),
    ]),
  }
  return executePresetLifecycleOperation<ConfigurationDomainResult<'chat-preset.create-and-link'>>(
    commandMeta,
    operationKind,
    input,
    async (tx) => {
      const chatMutation = openLinkedChatMutation(tx)
      const [profile, chat, currentPreset] = await Dexie.Promise.all([
        tx.table<ConnectionProfile, ProfileId>('profiles').get(profileId),
        chatMutation.read(command.chatId),
        tx.table<ChatPreset, PresetId>('presets').get(provisional.id),
      ])
      if (!profile) {
        return semanticOperationExecution(
          { kind: 'missing', entity: 'profile', id: profileId } as const,
          presetLifecycleOperationReceipt(operationKind, provisional.id, {
            ...(currentPreset ? { previous: currentPreset, next: currentPreset } : {}),
            presetReadRequests: 1,
            profileReadRequests: 1,
            chat: chat
              ? chatConfigurationOperationReceipt(chat, chat)
              : chatConfigurationOperationReceipt(undefined, undefined),
          }),
        )
      }
      if (!chat) {
        return semanticOperationExecution(
          { kind: 'missing', entity: 'chat', id: command.chatId } as const,
          presetLifecycleOperationReceipt(operationKind, provisional.id, {
            ...(currentPreset ? { previous: currentPreset, next: currentPreset } : {}),
            presetReadRequests: 1,
            profileReadRequests: 1,
          }),
        )
      }
      if (currentPreset) {
        return semanticOperationExecution(
          { kind: 'conflict', reason: 'link-changed' } as const,
          presetLifecycleOperationReceipt(operationKind, provisional.id, {
            previous: currentPreset,
            next: currentPreset,
            presetReadRequests: 1,
            profileReadRequests: 1,
            chat: chatConfigurationOperationReceipt(chat, chat),
          }),
        )
      }
      const preset: ChatPreset = {
        ...provisional,
        settings: withProfileApiDefaults(provisional.settings, profile),
      }
      const links = await addLinkedSemanticByteOwner(tx, 'presets', preset)
      const order = await appendPresetOrderEntry(tx, preset.id)
      const catalog = await applyConfigurationPresetCatalogProjectionTransition(
        tx,
        undefined,
        preset,
      )
      const chatReceipt = await selectedChatConfigurationTransition(
        tx,
        chatMutation,
        chat,
        withModelResolutionCancellation({ ...chat, presetId: preset.id }, true),
        command.now,
      )
      const writtenChat = chatReceipt.next as Chat
      return semanticOperationExecution(
        {
          kind: 'chat-preset-saved',
          preset,
          chatId: writtenChat.id,
          chatChanged: chatReceipt.mutation === 'write',
          configurationVersion: writtenChat.configurationVersion ?? 0,
          affectedPresetIds: [preset.id],
        } as const,
        presetLifecycleOperationReceipt(operationKind, preset.id, {
          next: preset,
          presetReadRequests: 1,
          profileReadRequests: 1,
          links,
          catalog,
          order,
          chat: chatReceipt,
        }),
      )
    },
  )
}

async function applyChatPreset(
  command: Extract<ConfigurationDomainCommand, { kind: 'chat-preset.apply' }>,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'chat-preset.apply'>> {
  const input: ChatSelectionOperationInput = {
    chatId: command.chatId,
    sourceId: command.presetId,
    resourceNames: [`chat-meta:${command.chatId}`, `preset:${command.presetId}`],
  }
  return executeChatSelectionOperation<ConfigurationDomainResult<'chat-preset.apply'>>(
    commandMeta,
    command.kind,
    input,
    async (tx) => {
      const chatMutation = openLinkedChatMutation(tx)
      const [chat, preset] = await Dexie.Promise.all([
        chatMutation.read(command.chatId),
        tx.table<ChatPreset, PresetId>('presets').get(command.presetId),
      ])
      if (!preset) {
        return semanticOperationExecution(
          { kind: 'missing', entity: 'chat-preset', id: command.presetId } as const,
          chatSelectionOperationReceipt(command.kind, input, {
            chat: chat
              ? chatConfigurationOperationReceipt(chat, chat)
              : chatConfigurationOperationReceipt(undefined, undefined),
          }),
        )
      }
      if (!chat) {
        return semanticOperationExecution(
          { kind: 'missing', entity: 'chat', id: command.chatId } as const,
          chatSelectionOperationReceipt(command.kind, input, {
            previousSource: preset,
            nextSource: preset,
          }),
        )
      }
      const chatReceipt = await selectedChatConfigurationTransition(
        tx,
        chatMutation,
        chat,
        withModelResolutionCancellation(
          {
            ...chat,
            settings: normalizeChatSettings(structuredClone(preset.settings)),
            presetId: preset.id,
          },
          true,
        ),
        command.now,
      )
      const written = chatReceipt.next as Chat
      return semanticOperationExecution(
        {
          kind: 'chat-preset-saved',
          preset,
          chatId: written.id,
          chatChanged: chatReceipt.mutation === 'write',
          configurationVersion: written.configurationVersion ?? 0,
          affectedPresetIds: [preset.id],
        } as const,
        chatSelectionOperationReceipt(command.kind, input, {
          previousSource: preset,
          nextSource: preset,
          chat: chatReceipt,
        }),
      )
    },
  )
}

async function saveChatPreset(
  command: Extract<ConfigurationDomainCommand, { kind: 'chat-preset.save' }>,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'chat-preset.save'>> {
  const operationKind = command.kind
  const profileId = command.settings.profileId
  const chatId = command.chatModel?.chatId
  const input: PresetLifecycleOperationInput = {
    presetId: command.presetId,
    ...(chatId ? { chatId } : {}),
    resourceNames: sortedUnique([
      `preset:${command.presetId}`,
      `profile:${profileId}`,
      ...(chatId ? [`chat-meta:${chatId}`] : []),
      ...chatSettingsIntroducedTargetResources(command.settings),
    ]),
  }
  return executePresetLifecycleOperation<ConfigurationDomainResult<'chat-preset.save'>>(
    commandMeta,
    operationKind,
    input,
    async (tx) => {
      const chatMutation = openLinkedChatMutation(tx)
      const [preset, profile, chat] = await Dexie.Promise.all([
        tx.table<ChatPreset, PresetId>('presets').get(command.presetId),
        tx.table<ConnectionProfile, ProfileId>('profiles').get(profileId),
        chatId ? chatMutation.read(chatId) : Dexie.Promise.resolve(undefined),
      ])
      const unchangedChat = chat
        ? chatConfigurationOperationReceipt(chat, chat)
        : chatConfigurationOperationReceipt(undefined, undefined)
      if (!preset) {
        return semanticOperationExecution(
          { kind: 'missing', entity: 'chat-preset', id: command.presetId } as const,
          presetLifecycleOperationReceipt(operationKind, command.presetId, {
            presetReadRequests: 1,
            profileReadRequests: 1,
            chat: unchangedChat,
          }),
        )
      }
      if (preset.connectionProfileId !== profileId) {
        return semanticOperationExecution(
          { kind: 'invalid', reason: 'preset-profile-mismatch' } as const,
          presetLifecycleOperationReceipt(operationKind, command.presetId, {
            previous: preset,
            next: preset,
            presetReadRequests: 1,
            profileReadRequests: 1,
            chat: unchangedChat,
          }),
        )
      }
      if (!profile) {
        return semanticOperationExecution(
          { kind: 'missing', entity: 'profile', id: profileId } as const,
          presetLifecycleOperationReceipt(operationKind, command.presetId, {
            previous: preset,
            next: preset,
            presetReadRequests: 1,
            profileReadRequests: 1,
            chat: unchangedChat,
          }),
        )
      }
      if (chatId && !chat) {
        return semanticOperationExecution(
          { kind: 'missing', entity: 'chat', id: chatId } as const,
          presetLifecycleOperationReceipt(operationKind, command.presetId, {
            previous: preset,
            next: preset,
            presetReadRequests: 1,
            profileReadRequests: 1,
          }),
        )
      }
      const nextPreset: ChatPreset = {
        ...preset,
        settings: withProfileApiDefaults(
          normalizeChatSettings(structuredClone(command.settings)),
          profile,
        ),
        updatedAt: command.now,
      }
      const links = await replaceLinkedSemanticByteOwner(tx, 'presets', nextPreset, preset)
      const chatReceipt =
        chat && command.chatModel
          ? await selectedChatConfigurationTransition(
              tx,
              chatMutation,
              chat,
              withModelResolutionCancellation(
                {
                  ...chat,
                  settings: { ...chat.settings, model: command.chatModel.modelId },
                },
                true,
              ),
              command.now,
            )
          : unchangedChat
      const writtenChat = chatReceipt.next
      return semanticOperationExecution(
        {
          kind: 'chat-preset-saved',
          preset: nextPreset,
          ...(writtenChat && chatReceipt.mutation === 'write'
            ? {
                chatId: writtenChat.id,
                chatChanged: true,
                configurationVersion: writtenChat.configurationVersion ?? 0,
              }
            : {}),
          affectedPresetIds: [nextPreset.id],
        } as const,
        presetLifecycleOperationReceipt(operationKind, nextPreset.id, {
          previous: preset,
          next: nextPreset,
          presetReadRequests: 1,
          profileReadRequests: 1,
          links,
          chat: chatReceipt,
        }),
      )
    },
  )
}

async function commitLocalPrompt(
  command: Extract<ConfigurationDomainCommand, { kind: 'prompt-preset.local-commit' }>,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'prompt-preset.local-commit'>> {
  const result = await mutateChatConfiguration(
    command.kind,
    command.chatId,
    command.now,
    [],
    (chat) => ({
      ...chat,
      settings: applyLocalPromptValue(chat.settings, command.slot, command.text),
    }),
    commandMeta,
  )
  if (result.kind !== 'chat-updated') return result
  return {
    kind: 'prompt-preset-saved',
    chatId: result.chatId,
    configurationVersion: result.configurationVersion,
    affectedChatIds: result.changed ? [result.chatId] : [],
    affectedChatCount: result.changed ? 1 : 0,
  }
}

async function loadAndPinPrompt(
  command: Extract<ConfigurationDomainCommand, { kind: 'prompt-preset.load-and-pin' }>,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'prompt-preset.load-and-pin'>> {
  const input: ChatSelectionOperationInput = {
    chatId: command.chatId,
    sourceId: command.presetId,
    resourceNames: [
      `chat-meta:${command.chatId}`,
      configurationTargetResourceName('prompt-preset', command.presetId),
      `prompt-preset:${command.presetId}`,
    ],
  }
  return executeChatSelectionOperation<ConfigurationDomainResult<'prompt-preset.load-and-pin'>>(
    commandMeta,
    command.kind,
    input,
    async (tx) => {
      const chatMutation = openLinkedChatMutation(tx)
      const [chat, currentPreset] = await Dexie.Promise.all([
        chatMutation.read(command.chatId),
        tx.table<PromptPreset, PromptPresetId>('promptPresets').get(command.presetId),
      ])
      if (!chat) {
        return semanticOperationExecution(
          { kind: 'missing', entity: 'chat', id: command.chatId } as const,
          chatSelectionOperationReceipt(command.kind, input, {
            previousSource: currentPreset,
            nextSource: currentPreset,
          }),
        )
      }
      if (!currentPreset) {
        return semanticOperationExecution(
          { kind: 'missing', entity: 'prompt-preset', id: command.presetId } as const,
          chatSelectionOperationReceipt(command.kind, input, {
            chat: chatConfigurationOperationReceipt(chat, chat),
          }),
        )
      }
      const slot = promptPresetSlotForKind(currentPreset.kind)
      const settings = { ...chat.settings }
      ;(settings as unknown as Record<string, unknown>)[slot.textKey] = currentPreset.text
      ;(settings as unknown as Record<string, unknown>)[slot.pinKey] = currentPreset.id
      const touched =
        (currentPreset.lastUsedAt ?? 0) >= command.now
          ? currentPreset
          : { ...currentPreset, lastUsedAt: command.now }
      let projection: ConfigurationCatalogProjectionMutationReceipt | undefined
      if (touched !== currentPreset) {
        await replaceSemanticByteOwner(tx, 'promptPresets', touched, currentPreset)
        projection = await applyConfigurationPromptPresetRecencyCatalogProjectionTransition(
          tx,
          currentPreset,
          touched,
        )
      }
      const chatReceipt = await selectedChatConfigurationTransition(
        tx,
        chatMutation,
        chat,
        withModelResolutionCancellation({ ...chat, settings }, true),
        command.now,
      )
      const written = chatReceipt.next as Chat
      const affectedChatIds = chatReceipt.mutation === 'write' ? [written.id] : []
      return semanticOperationExecution(
        {
          kind: 'prompt-preset-saved',
          preset: touched,
          chatId: written.id,
          configurationVersion: written.configurationVersion ?? 0,
          affectedChatIds,
          affectedChatCount: affectedChatIds.length,
        } as const,
        chatSelectionOperationReceipt(command.kind, input, {
          previousSource: currentPreset,
          nextSource: touched,
          ...(touched !== currentPreset ? { sourceMutation: 'write', projection } : {}),
          chat: chatReceipt,
        }),
      )
    },
  )
}

async function overwriteAndPinPrompt(
  command: Extract<ConfigurationDomainCommand, { kind: 'prompt-preset.overwrite-and-pin' }>,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'prompt-preset.overwrite-and-pin'>> {
  return executeConfigurationTargetFanoutOperation(commandMeta, command)
}

async function createAndPinPrompt(
  command: Extract<ConfigurationDomainCommand, { kind: 'prompt-preset.create-and-pin' }>,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'prompt-preset.create-and-pin'>> {
  const input: ChatSelectionOperationInput = {
    chatId: command.chatId,
    sourceId: command.preset.id,
    resourceNames: [
      `chat-meta:${command.chatId}`,
      configurationTargetResourceName('prompt-preset', command.preset.id),
      `prompt-preset:${command.preset.id}`,
    ],
  }
  return executeChatSelectionOperation<ConfigurationDomainResult<'prompt-preset.create-and-pin'>>(
    commandMeta,
    command.kind,
    input,
    async (tx) => {
      const chatMutation = openLinkedChatMutation(tx)
      const [chat, currentPreset] = await Dexie.Promise.all([
        chatMutation.read(command.chatId),
        tx.table<PromptPreset, PromptPresetId>('promptPresets').get(command.preset.id),
      ])
      if (!chat) {
        return semanticOperationExecution(
          { kind: 'missing', entity: 'chat', id: command.chatId } as const,
          chatSelectionOperationReceipt(command.kind, input, {
            previousSource: currentPreset,
            nextSource: currentPreset,
          }),
        )
      }
      if (currentPreset) {
        return semanticOperationExecution(
          { kind: 'conflict', reason: 'link-changed' } as const,
          chatSelectionOperationReceipt(command.kind, input, {
            previousSource: currentPreset,
            nextSource: currentPreset,
            chat: chatConfigurationOperationReceipt(chat, chat),
          }),
        )
      }
      const preset = structuredClone(command.preset)
      await addSemanticByteOwner(tx, 'promptPresets', preset)
      const projection = await applyConfigurationPromptPresetCatalogProjectionTransition(
        tx,
        undefined,
        preset,
      )
      const slot = promptPresetSlotForKind(preset.kind)
      const settings = { ...chat.settings }
      ;(settings as unknown as Record<string, unknown>)[slot.textKey] = preset.text
      ;(settings as unknown as Record<string, unknown>)[slot.pinKey] = preset.id
      const chatReceipt = await selectedChatConfigurationTransition(
        tx,
        chatMutation,
        chat,
        withModelResolutionCancellation({ ...chat, settings }, true),
        command.now,
      )
      const written = chatReceipt.next as Chat
      const affectedChatIds = chatReceipt.mutation === 'write' ? [written.id] : []
      return semanticOperationExecution(
        {
          kind: 'prompt-preset-saved',
          preset,
          chatId: written.id,
          configurationVersion: written.configurationVersion ?? 0,
          affectedChatIds,
          affectedChatCount: affectedChatIds.length,
        } as const,
        chatSelectionOperationReceipt(command.kind, input, {
          nextSource: preset,
          sourceMutation: 'write',
          projection,
          chat: chatReceipt,
        }),
      )
    },
  )
}

async function renamePromptPreset(
  command: Extract<ConfigurationDomainCommand, { kind: 'prompt-preset.rename' }>,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'prompt-preset.rename'>> {
  return executeCatalogedConfigurationOperation<
    PromptPreset,
    ConfigurationDomainResult<'prompt-preset.rename'>
  >(commandMeta, command.kind, command.presetId, (preset) => {
    if (!preset) {
      return {
        next: undefined,
        result: { kind: 'missing', entity: 'prompt-preset', id: command.presetId },
      }
    }
    const name = command.name.trim()
    if (preset.name === name) {
      return { next: undefined, result: { kind: 'prompt-preset-saved', preset } }
    }
    const next = { ...preset, name, updatedAt: command.now }
    return {
      next,
      result: { kind: 'prompt-preset-saved', preset: next },
    }
  })
}

async function deletePromptPreset(
  command: Extract<ConfigurationDomainCommand, { kind: 'prompt-preset.delete' }>,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'prompt-preset.delete'>> {
  return executeConfigurationTargetFanoutOperation(commandMeta, command)
}

async function configuredChat(
  tx: Transaction,
  current: Chat,
  transformed: Chat,
  now: number,
  clock: TransactionChatUpdateClock = new TransactionChatUpdateClock(),
): Promise<Chat> {
  return {
    ...transformed,
    id: current.id,
    createdAt: current.createdAt,
    settings: normalizeChatSettings(structuredClone(transformed.settings)),
    configurationVersion: (current.configurationVersion ?? 0) + 1,
    metaVersion: current.metaVersion + 1,
    summaryVersion: current.summaryVersion + 1,
    updatedAt: await clock.next(tx, now),
  }
}

function chatConfigurationChanged(current: Chat, next: Chat): boolean {
  return (
    !sameChatSettings(current.settings, next.settings) ||
    current.presetId !== next.presetId ||
    !sameValue(current.modelResolution, next.modelResolution)
  )
}

function chatUpdatedResult(
  chat: Chat,
  changed: boolean,
): Extract<ConfigurationDomainResult<'chat.settings-patch'>, { kind: 'chat-updated' }> {
  return {
    kind: 'chat-updated',
    chatId: chat.id,
    chat: structuredClone(chat),
    changed,
    configurationVersion: chat.configurationVersion ?? 0,
    ...(chat.modelResolution ? { pendingModelResolution: chat.modelResolution } : {}),
  }
}

async function readTargetLinksFromTransaction(
  tx: Transaction,
  kind: ConfigurationLink['targetKind'],
  id: string,
): Promise<ConfigurationLink[]> {
  return tx
    .table<ConfigurationLink, string>('configurationLinks')
    .where('targetKey')
    .equals(configurationTargetKey(kind, id))
    .toArray()
}

async function readFirstTargetLinkFromTransaction(
  tx: Transaction,
  kind: ConfigurationLink['targetKind'],
  id: string,
): Promise<ConfigurationLink | undefined> {
  return tx
    .table<ConfigurationLink, string>('configurationLinks')
    .where('[targetKey+id]')
    .between(...exactCompoundPrefixBetween([configurationTargetKey(kind, id)]))
    .first()
}

function configurationLockNames(
  base: readonly string[],
  links: readonly ConfigurationLink[],
): string[] {
  return sortedUnique([
    ...base,
    ...configurationTargetResourceNamesForLinks(links),
    ...configurationProfileUsageResourceNamesForLinks(links),
  ])
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort()
}

function normalizeStringIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item): item is string => typeof item === 'string'))]
}

function sameValue(left: unknown, right: unknown): boolean {
  return sameConfigurationValue(left, right)
}

function isConfigurationErrorResult(
  value: unknown,
): value is Extract<ConfigurationDomainResult, { kind: 'conflict' | 'invalid' }> {
  if (!value || typeof value !== 'object') return false
  const kind = (value as { kind?: unknown }).kind
  return kind === 'conflict' || kind === 'invalid'
}
