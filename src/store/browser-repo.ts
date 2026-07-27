import Dexie, { type IndexableTypePart, type Table, type Transaction } from 'dexie'
import type { ActiveBranchForkTarget } from '../core/active-branch-spine'
import { compareLiveLeafRecency, findLastUpdatedLeafId } from '../core/active-path'
import { messageRenderableTextSemanticsEqual } from '../core/branch-flatten'
import { type BranchPathWindow, readLiveBranchPath } from '../core/branch-session'
import { modelCatalogQueryForConnectionKind, modelsCacheKey } from '../core/cache-keys'
import { computeBranchTitle } from '../core/chat-fork'
import { chatSettingsPromptPresetReferences } from '../core/chat-metadata'
import { connectionDispatchKeyRefs, connectionHttpProfile } from '../core/connection-dispatch-proof'
import {
  type AppliedMessageSemanticEffect,
  appliedMessageRequestSemanticsEqual,
  createAppliedMessageView,
} from '../core/continuation-content'
import {
  GENERATED_OUTPUT_LOCALIZATION_PROCESSOR_ID,
  isGeneratedOutputLocalizationJob,
  isGeneratedVideoPollingUrl,
  profileAuthorizesGeneratedVideoUrl,
  withGeneratedOutputLocalizationState,
} from '../core/generated-output-localization'
import {
  GLOBAL_PREFERENCE_KEYS,
  globalPreferencesFromStored,
  SAMPLE_PROMPTS_DISMISSED_KEY,
} from '../core/global-settings'
import { customImageOriginsFromStored, IMAGE_ALLOWLIST_KEY } from '../core/image-allowlist'
import { keyDispatchProof, keyDispatchRevisions } from '../core/key-dispatch-proof'
import { treeParentKey } from '../core/message-tree-index'
import {
  type ConversationDestinationPoint,
  type ConversationSelectionProofTarget,
  fixedConversationSelectionTarget,
  type MessageMutationRepository,
} from '../core/messages'
import {
  normalizeRenderingPreferences,
  RENDERING_PREFERENCES_KEY,
} from '../core/rendering-preferences'
import {
  normalizeCollapsedSidebarFolderIds,
  parseSidebarSortMode,
  SIDEBAR_COLLAPSED_FOLDERS_SETTING_KEY,
  SIDEBAR_SORT_SETTING_KEY,
  sortChatFolders,
} from '../core/sidebar-sort'
import {
  isStaticTextTemplateId,
  normalizeTextTemplateConfig,
  type SavedTextTemplate,
  type SavedTextTemplateCatalogRow,
} from '../core/text-templates'
import {
  GLOBAL_TOKEN_CALIBRATION_KEY,
  normalizeGlobalTokenCalibration,
} from '../core/token-calibration'
import { TRANSCRIPT_BODY_READ_BATCH_ROWS } from '../core/transcript-work-budget'
import type {
  Attachment,
  AttachmentArtifact,
  AttachmentId,
  AttachmentJob,
  AttachmentReferenceEdge,
  Chat,
  ChatFolder,
  ChatId,
  ChatPreset,
  ChatTag,
  ChatUsage,
  ChildListState,
  ConnectionProfile,
  DispatchedGenerationMeta,
  DraftRow,
  FolderId,
  GenerationMeta,
  GlobalTokenCalibration,
  KeyId,
  KeyRecord,
  Message,
  MessageAttachmentRef,
  MessageId,
  MutationScope,
  PresetId,
  ProfileId,
  PromptPresetId,
  PromptPresetKind,
  TextTemplateId,
} from '../core/types'
import { countMessagesWords } from '../core/word-count'
import { assertNever } from '../lib/assert'
import { sameOrderedValues, sameValue, stableStringify } from '../lib/same-value'
import { newId } from '../lib/ulid'
import { readActiveBranchForksInTransaction } from './active-branch-fork-storage'
import { ATTACHMENT_CATALOG_MUTATION_TRANSACTION_CAPABILITY } from './attachment-catalog-projection'
import {
  ATTACHMENT_INTEGRITY_TRANSACTION_CAPABILITY,
  reconcileAttachmentIntegrityPage,
} from './attachment-integrity-maintenance'
import { liveAttachmentRefs, normalizeAttachmentRefs } from './attachment-refs'
import { type AttachmentHeaderRow, hydrateAttachment } from './attachment-storage'
import { subscribeWorkspaceChanges } from './broadcast'
import {
  type ConversationOpenFrameStore,
  readActiveBranchChildAtPositionInTransaction,
  readConversationOpenInitialReceiptInTransaction,
  resolveConversationOpenReceipt,
} from './browser-active-branch-spine'
import {
  evaluateAttachmentCatalogRows,
  readAttachmentCatalogAggregate,
  readAttachmentCatalogPage,
  readAttachmentCatalogRows,
  readAttachmentManagerCore,
  readSidebarAggregate,
  readSidebarCatalogPage,
  readSidebarCreatedAtGroupCount,
  readSidebarPresentationPage,
  readSidebarRowsById,
} from './browser-catalog-queries'
import {
  type AttachmentReferenceStateFact,
  type BrowserCommandMessageRevisionFact,
  type BrowserCommandMutationFacts,
  type BrowserCommandPhysicalMutation,
  type BrowserCommandPhysicalOwnerScope,
  INTERNAL_ATTACHMENT_INTEGRITY_MAINTENANCE,
  INTERNAL_DISCOVERY_CACHE_MAINTENANCE,
  recordBrowserCommandInvalidation,
  recordBrowserCommandStorageRetentionMutation,
  runBrowserCommandTransaction,
} from './browser-command-mutation-journal'
import {
  type BrowserCommandSessionPort,
  type BrowserGenerationCommandSupport,
  type BrowserLockedCommandPort,
  type BrowserMutationCommandPort,
  type BrowserMutationOperations,
  type BrowserMutationSharedInternals,
  type BrowserMutationTransactionExtension,
  type ChatMutationState,
  type ResolvedGenerationPromptPath,
  VALIDATED_GENERATION_PROMPT_PATH_HEADERS,
  type ValidatedGenerationPromptPath,
  type ValidatedGenerationPromptPathHeaders,
} from './browser-domain-mutations'
import type { BrowserImportExportRead } from './browser-import-export'
import {
  type BrowserMutationTableName,
  GenerationPlanningSeedChangedError,
} from './browser-mutation-plan'
import {
  BODY_READ_PAGE_SIZE,
  HEADER_READ_PAGE_SIZE,
  readBulkGetPages,
  readChatMessageHeaderPages,
  readChildHeaderPages,
  readExactMessageRowsByIdPages,
  readStreamJournalFramePage,
  readStreamLeasePages,
  readStringPrimaryKeyPages,
} from './browser-query-pages'
import {
  boundedMaintenanceLimit,
  MAX_STORAGE_MAINTENANCE_BATCH,
} from './browser-workspace-maintenance-contract'
import { addPhysicalStorageRows, putPhysicalStorageRow } from './byte-owner-mutation'
import {
  CHAT_ROW_LINKED_TRANSACTION_CAPABILITY,
  openLinkedChatMutation,
} from './chat-row-transition'
import { readTemporaryChatIdPage } from './chat-storage-codec'
import {
  CHAT_CLOSURE_BATCH_LIMIT,
  CHAT_CLOSURE_TRANSACTION_CAPABILITY,
  deleteEligibleEmptyDraftChatClosure,
} from './chat-storage-ownership'
import {
  CONFIGURATION_PROFILE_CATALOG_STATE_ID,
  type ConfigurationCatalogStateRow,
  type ConfigurationPresetCatalogProjectionRow,
  type ConfigurationProfileCatalogProjectionRow,
  type ConfigurationPromptPresetCatalogProjectionRow,
  configurationPromptPresetCatalogStateId,
  readDefaultConfigurationProfileId,
} from './configuration-catalog-projection'
import {
  type ConfigurationLink,
  chatConfigurationTargetResourceNames,
  configurationRequestRevisionFor,
  configurationRequestRevisionKey,
  configurationTargetKey,
} from './configuration-domain-contract'
import {
  CONFIGURATION_PROFILE_MANAGER_STATE_ID,
  type ConfigurationProfileUsageProjectionRow,
  emptyConfigurationProfileUsageProjectionRow,
} from './configuration-profile-usage-projection'
import {
  type BrowserWorkspaceSession,
  childListKey,
  getBrowserWorkspaceSession,
  type NatterDb,
  runBrowserWorkspaceRepositoryOperation,
} from './db'
import type {
  CachedEndpointsRow,
  CachedEndpointsStorageRow,
  CachedModelsRow,
  CachedModelsStorageRow,
  CachedPrivacyPolicyRow,
  CachedPrivacyPolicyStorageRow,
  SettingsRow,
} from './db-rows'
import {
  DISCOVERY_CACHE_MUTATION_TRANSACTION_CAPABILITY,
  type DiscoveryCacheReadEvidence,
  type DiscoveryCacheStorageTable,
  deleteDiscoveryCacheRow,
  maintainDiscoveryCache,
  prepareDiscoveryPayload,
  putDiscoveryCacheRow,
  readDiscoveryCacheRow,
  readDiscoveryCacheRowWithEvidence,
  type DiscoveryCacheEviction as StorageDiscoveryCacheEviction,
  type DiscoveryCachePutResult as StorageDiscoveryCachePutResult,
} from './discovery-cache-storage'
import { exactCompoundPrefixBetween, scalarCompoundIndexBetween } from './indexeddb-key-ranges'
import {
  type AuthoritativeCommandLockSession,
  type LockGrant,
  withSharedAuthoritativeCommandSession,
} from './locks'
import {
  deletePairInRepository,
  deleteSingleMessageInRepository,
  deleteTurnInRepository,
  deleteVariantInRepository,
  editMessageContentInRepository,
  mutateMessageBodyInRepository,
  pasteImportInRepository,
} from './message-command-repository'
import { searchMessageCorpusInBrowser } from './message-corpus-search'
import {
  canonicalMessageHeaderRow,
  hydrateMessage,
  hydrateMessages,
  hydrateMessageWithOwnedBody,
  MESSAGE_TEXT_PREVIEW_MAX_CHARS,
  type MessageBodyRow,
  type MessageHeaderRow,
  type MessageTextPreviewRow,
  previewTextFromMessages,
  previewTextFromStoredProjection,
  rebaseHydratedMessageHeader,
  sameMessageHeaderStructure,
  sameMessageHeaderValue,
  splitMessageForStorage,
} from './message-storage'
import {
  assertPhysicalTransactionTablesDeclared,
  bindFencedTransaction,
  type FencedTransaction,
  PHYSICAL_STORAGE_POLICY,
  type PhysicalStorageTableName,
  type PhysicalTransactionPlan,
  physicalStorageTables,
  physicalTransactionPlan,
} from './physical-storage-tables'
import {
  PRESET_ORDER_STATE_ID,
  type PresetOrderBlockRow,
  type PresetOrderMembershipRow,
  type PresetOrderStateRow,
} from './preset-order'
import type {
  AttachmentBundle,
  AttachmentDispatchBundle,
  ChatMetadataPatch,
  CreateFolderInput,
  DeleteFolderResult,
  EnsureFolderAndMoveChatsInput,
  EnsureFolderAndMoveChatsResult,
  FencedStreamLeaseRow,
  ForkChatFromMessageInput,
  ForkChatFromMessageResult,
  GenerationAttachmentTokenEvidence,
  GenerationMessageReadProof,
  KnownBranchPageStructuralResult,
  MessageBodyPatch,
  MessageCalibrationPatch,
  MessageHeaderPatch,
  MessageTextPreviewSnapshot,
  MessageTextPreviewTarget,
  MutationContext,
  MutationFinalizationContext,
  StreamJournalFrameRow,
  StreamLeaseAdmission,
  StreamLeaseHandoffReason,
  StreamLeaseHeartbeat,
  StreamLeaseRow,
  StreamPostCommitEvidence,
  StreamPostCommitUsageEvidence,
  StreamWriteFence,
  TerminalDecidedStreamLeaseRow,
  UpdateFolderInput,
  WorkspaceFence,
  WorkspaceMeta,
  WorkspaceMutationOptions,
  WorkspaceMutationResult,
} from './repository'
import {
  BranchTargetUnavailableError,
  ChatMissingError,
  ExpectedLeafChangedError,
  generationMessageReadProofFromHeader,
  isStreamLeaseRow,
  requireStreamLeaseRow,
  StreamTargetBusyError,
  streamLeaseHasCommittedTarget,
  streamLeaseHasWriteFence,
  streamLeaseMatchesWriteFence,
  WorkspaceReplacementFenceError,
} from './repository'
import {
  assertSemanticOperationCommandLifetimeReceipt,
  assertSemanticOperationEffectKinds,
  assertSemanticOperationExactInvalidations,
  assertSemanticOperationExactPhysicalMutations,
  assertSemanticOperationExactPhysicalReads,
  assertSemanticOperationExactPhysicalWrites,
  assertSemanticOperationReplay,
  assertSemanticOperationWrites,
  attachSemanticOperationExactPhysicalReads,
  attachSemanticOperationPhysicalIo,
  boundSemanticOperationExactReceiptAccumulator,
  collectSemanticOperationPhysicalWrites,
  configurationSemanticOperationKind,
  createSemanticOperationExactReceiptAccumulator,
  type SemanticOperationCommandLifetimeReceipt,
  type SemanticOperationDescriptor,
  type SemanticOperationExactPhysicalRead,
  type SemanticOperationExactReceipt,
  type SemanticOperationExecution,
  type SemanticOperationKind,
  type SemanticOperationPhysicalBounds,
  type SemanticOperationPhysicalRead,
  type SemanticOperationReceiptFragment,
  type SemanticOperationReplayPlan,
  type SemanticOperationReplayToken,
  type SemanticOperationRunner,
  semanticOperationCommandLifetimeReceipt,
  semanticOperationCommandLifetimeReceiptWithPhysicalReads,
  semanticOperationCommandLifetimeReceiptWithPreflight,
  semanticOperationDelegationCapability,
  semanticOperationDescriptor,
  semanticOperationExactPlan,
  semanticOperationExactReceipt,
  semanticOperationExactReceiptContracts,
  semanticOperationExactReceiptReplayContract,
  semanticOperationExactReceiptReplayProofContract,
  semanticOperationExecution,
  semanticOperationExecutionParts,
  semanticOperationReceiptFragment,
  semanticOperationResourceNames,
} from './semantic-operation-capability'
import {
  awaitStorageCompactionWriteAdmission,
  registerPhysicalMutationTransaction,
} from './storage-compaction-state'
import {
  type AttachmentReapCursor,
  advanceStorageRetentionState,
  assertStorageRetentionCycleCurrent,
  readStorageRetentionState,
  type StorageRetentionCursor,
  type StorageRetentionCycle,
  type StorageRetentionStateRowFor,
  type StorageRetentionTask,
  storageRetentionCycle,
} from './storage-retention-state'
import {
  canonicalStreamJournalFrameBatch,
  STREAM_JOURNAL_APPEND_MAX_ROWS,
  type StreamJournalWriterAuthority,
  streamJournalWriterAuthority,
} from './stream-journal-codec'
import {
  reconcileStreamJournalIntegrityPage,
  STREAM_JOURNAL_INTEGRITY_TRANSACTION_CAPABILITY,
} from './stream-journal-integrity'
import {
  appendStreamJournalFrames as persistStreamJournalFrames,
  putStreamLeaseByteOwner,
  retireStreamJournalOwnershipPage,
  STREAM_JOURNAL_MUTATION_TRANSACTION_CAPABILITY,
  STREAM_JOURNAL_RETIREMENT_MAX_ROWS,
  STREAM_LEASE_MUTATION_TRANSACTION_CAPABILITY,
} from './stream-journal-storage'
import { STREAM_LEASE_HEARTBEAT_COALESCE_MS } from './stream-lease-policy'
import { applyStructuralSnapshotInRepository } from './structural-undo-repository'
import { readTextTemplateCatalog } from './text-template-storage'
import { nextChatUpdatedAtInTransaction } from './transaction-order'
import { WorkspaceLocalChildSlotAccumulator } from './workspace-local-evidence'
import { readBrowserWorkspaceMetaFromTransaction } from './workspace-meta'
import type {
  AttachmentBundleWriteInput,
  AttachmentBundleWriteResult,
  AttachmentDeleteBytesInput,
  AttachmentDeleteIfUnreferencedResult,
  AttachmentDeleteManyInput,
  AttachmentDeleteManyResult,
  AttachmentIntegrityMaintenanceResult,
  AttachmentMediaProjection,
  AttachmentReapResult,
  AttachmentRefAddInput,
  AttachmentRefDetachInput,
  AttachmentReferenceRow,
  AttachmentRefOwner,
  AttachmentRefRelinkInput,
  AttachmentRefRelinkResult,
  AttachmentRefVisibilityInput,
  AttachmentRefWriteResult,
  AttemptDispatchInput,
  AttemptDispatchResult,
  AttemptFinalizeResult,
  AttemptPrepareResult,
  AttemptRequestStopInput,
  AttemptRequestStopResult,
  AttemptSealTerminalInput,
  AttemptTerminalProjection,
  ChatCalibrationEverywhereResult,
  ChatMetadataWriteResult,
  ChatTagAssignmentResult,
  CommitEnvelope,
  ConfigurationActiveModelKnownPayloads,
  ConfigurationActiveModelProjection,
  ConfigurationActiveModelRead,
  ConfigurationActiveSelectionProjection,
  ConfigurationCatalogAddress,
  ConfigurationCatalogPage,
  ConfigurationCatalogPageRequest,
  ConfigurationConnectionManagerPage,
  ConfigurationConnectionManagerRow,
  ConfigurationDiscoveryPayloadProjection,
  ConfigurationDiscoveryPayloadToken,
  ConfigurationModelResolutionHead,
  ConfigurationModelResolutionPage,
  ConfigurationPreferencesProjection,
  ConfigurationPresetCatalogPage,
  ConfigurationPresetCatalogRow,
  ConfigurationProfileCatalogPage,
  ConfigurationProfileCatalogRow,
  ConfigurationPromptPresetCatalogPage,
  ConfigurationPromptPresetCatalogRow,
  ConfigurationSelectionQueryTarget,
  ConfigurationShellProjection,
  ConversationForksResult,
  ConversationTopologyResult,
  DeleteArchivedChatMetadataResult,
  DiscoveryCacheCommand,
  DiscoveryCacheEviction,
  DiscoveryCacheMaintenanceResult,
  DiscoveryCachePutResult,
  DiscoveryCacheWriteGuard,
  DiscoveryModelsPutResult,
  GeneratedOutputLocalizationClaim,
  GeneratedOutputLocalizationClaimInput,
  GeneratedOutputLocalizationCompleteInput,
  GeneratedOutputLocalizationFailInput,
  GeneratedOutputLocalizationJobResult,
  GeneratedOutputLocalizationQueueSnapshot,
  GeneratedOutputLocalizationRetryInput,
  GeneratedOutputVideoExpandInput,
  GeneratedOutputVideoExpandResult,
  GenerationPostCommitMetadataInput,
  GenerationPostCommitMetadataResult,
  GenerationPromptPathClaim,
  GenerationPromptPathProof,
  MessagePresentation,
  PrepareAttemptInput,
  PreparedAttachmentBundle,
  PreparedGenerationPrompt,
  ReadEnvelope,
  StorageMaintenanceRequestTaskKind,
  StreamHandoffRecoveryInput,
  StreamNoteSelectedKeyInput,
  WorkspaceChange,
  WorkspaceCommand,
  WorkspaceCommandResult,
  WorkspaceDelta,
  WorkspaceDeltaFact,
  WorkspaceDependency,
  WorkspaceLocalChildSlotEvidence,
  WorkspaceLocalMessageRevision,
  WorkspaceLocalReceipt,
  WorkspaceQuery,
  WorkspaceQueryOptions,
  WorkspaceQueryResult,
  WorkspaceReadAuthority,
  WorkspaceReplacement,
  WorkspaceReplacementEnvelope,
  WorkspaceReplacementResult,
  WorkspaceRepository,
  WorkspaceWriteAuthority,
} from './workspace-protocol'
import {
  CONFIGURATION_CATALOG_MAX_ADDRESSED_ROWS,
  CONFIGURATION_CATALOG_MAX_PAGE_SIZE,
  CONFIGURATION_CATALOG_MAX_REFRESH_ANCHORS,
  CONFIGURATION_MODEL_RESOLUTION_PAGE_SIZE,
  connectionDiscoveryRevisionKey,
  normalizeWorkspaceDependencies,
  workspaceDependenciesForDeltaFact,
} from './workspace-protocol'
import { assertWorkspaceExecutionPermit, assertWorkspaceReadPermit } from './workspace-runtime'

const CONFIGURATION_COMMAND_SEMANTIC_DELEGATION = semanticOperationDelegationCapability<
  Extract<WorkspaceCommand, { kind: 'configuration.execute' }>,
  ReturnType<typeof configurationSemanticOperationKind>
>({
  operationKind: 'configuration.execute',
  childOperationKind: (command) => configurationSemanticOperationKind(command.input.kind),
})

function workspaceCommandSemanticOperationKind(command: WorkspaceCommand): SemanticOperationKind {
  if (command.kind === CONFIGURATION_COMMAND_SEMANTIC_DELEGATION.operationKind) {
    return CONFIGURATION_COMMAND_SEMANTIC_DELEGATION.childOperationKind(command)
  }
  return command.kind
}

const DISCOVERY_CACHE_ROW_WRITE_TRANSACTION_CAPABILITY = physicalStorageTables(
  ...DISCOVERY_CACHE_MUTATION_TRANSACTION_CAPABILITY.tableNames,
  'keys',
  'profiles',
)
interface DiscoveryCacheOperationInput {
  readonly kind: DiscoveryCacheCommand['kind']
  readonly profileId: ProfileId
  readonly discriminator: string
  readonly targetKey: string | null
}

function discoveryCacheOperationTransaction(kind: DiscoveryCacheCommand['kind']) {
  switch (kind) {
    case 'discovery.models.put':
    case 'discovery.endpoints.put':
    case 'discovery.privacy.put':
      return DISCOVERY_CACHE_ROW_WRITE_TRANSACTION_CAPABILITY
    case 'discovery.models.delete':
      return DISCOVERY_CACHE_MUTATION_TRANSACTION_CAPABILITY
  }
}

function discoveryCacheOperationTable(kind: DiscoveryCacheCommand['kind']) {
  switch (kind) {
    case 'discovery.models.put':
    case 'discovery.models.delete':
      return 'models' as const
    case 'discovery.endpoints.put':
      return 'endpoints' as const
    case 'discovery.privacy.put':
      return 'privacyPolicies' as const
  }
}

function discoveryCacheOperationDescriptor(kind: DiscoveryCacheCommand['kind']) {
  const transaction = discoveryCacheOperationTransaction(kind)
  return semanticOperationDescriptor({
    operationKind: kind,
    transaction,
    resources: (input: DiscoveryCacheOperationInput) => [
      'discovery-cache:retention',
      `discovery-cache:${discoveryCacheOperationTable(input.kind)}:${input.profileId}`,
      ...(input.targetKey ? [`configuration-target:${input.targetKey}`] : []),
    ],
    permittedWrites: transaction.tableNames,
    requiredWritesWhenMutated: [],
    ...semanticOperationExactReceiptContracts<
      DiscoveryCacheOperationInput,
      PhysicalStorageTableName
    >(),
    replay: semanticOperationExactReceiptReplayProofContract<DiscoveryCacheOperationInput>(
      (input, receipt) => assertDirectDiscoveryCacheReplayProof(input.kind, receipt),
    ),
  })
}

const DISCOVERY_CACHE_PUT_OPERATION_BOUNDS = Object.freeze({
  reads: Object.freeze({
    maxRequests: 79,
    maxRows: 851,
    maxBatchRows: 260,
    maxBytes: Number.MAX_SAFE_INTEGER,
  }),
  writes: Object.freeze({
    maxRequests: 137,
    maxRows: 198,
    maxBatchRows: 64,
    maxBytes: Number.MAX_SAFE_INTEGER,
  }),
})

const DISCOVERY_CACHE_DELETE_OPERATION_BOUNDS = Object.freeze({
  reads: Object.freeze({
    maxRequests: 7,
    maxRows: 7,
    maxBatchRows: 1,
    maxBytes: Number.MAX_SAFE_INTEGER,
  }),
  writes: Object.freeze({
    maxRequests: 4,
    maxRows: 4,
    maxBatchRows: 1,
    maxBytes: Number.MAX_SAFE_INTEGER,
  }),
})

function discoveryCacheMaintenanceOperationBounds(limit: number): SemanticOperationPhysicalBounds {
  const boundedLimit = boundedMaintenanceLimit(limit)
  return {
    reads: {
      maxRequests: 8 + 4 * boundedLimit,
      maxRows: 1_093 + 1_090 * boundedLimit,
      maxBatchRows: 513,
      maxBytes: Number.MAX_SAFE_INTEGER,
    },
    writes: {
      maxRequests: 2 * boundedLimit + 1,
      maxRows: 2 * boundedLimit + 1,
      maxBatchRows: 1,
      maxBytes: Number.MAX_SAFE_INTEGER,
    },
  }
}

function assertDirectDiscoveryCacheReplayProof(
  kind: DiscoveryCacheCommand['kind'],
  receipt: SemanticOperationExactReceipt,
): void {
  const replay = receipt.plan.replay
  if (replay.kind !== 'single-attempt' || replay.reason !== 'unfenced-relative-update') {
    throw new Error(`DiscoveryCacheReplayProofMismatch:${kind}`)
  }
}

function requireDiscoveryCacheReceiptAccumulator(tx: object) {
  const receipt = boundSemanticOperationExactReceiptAccumulator<PhysicalStorageTableName>(tx)
  if (!receipt) throw new Error('DiscoveryCacheExactReceiptAccumulatorMissing')
  return receipt
}

function discoveryCacheExactReceipt(
  receipt: ReturnType<typeof requireDiscoveryCacheReceiptAccumulator>,
  replay: SemanticOperationReplayPlan,
  bounds: SemanticOperationPhysicalBounds,
): SemanticOperationExactReceipt<PhysicalStorageTableName> {
  const fragment = receipt.snapshotFragment()
  return semanticOperationExactReceipt(
    semanticOperationExactPlan({
      replay,
      bounds,
    }),
    {
      dependencies: fragment.dependencies,
      physicalMutations: fragment.physicalMutations,
      physicalReads: fragment.physicalReads,
    },
  )
}

const STORAGE_RETENTION_STATE_TRANSACTION_CAPABILITY =
  physicalStorageTables('storageRetentionState')
const TERMINAL_STREAM_RETENTION_TRANSACTION_CAPABILITY = physicalStorageTables(
  ...STREAM_JOURNAL_MUTATION_TRANSACTION_CAPABILITY.tableNames,
  ...STORAGE_RETENTION_STATE_TRANSACTION_CAPABILITY.tableNames,
)
const EMPTY_DRAFT_RETENTION_TRANSACTION_CAPABILITY = physicalStorageTables(
  ...CHAT_CLOSURE_TRANSACTION_CAPABILITY.tableNames,
  ...STORAGE_RETENTION_STATE_TRANSACTION_CAPABILITY.tableNames,
)

interface StreamJournalIntegrityResourceInput {
  readonly limit: number
}

interface TerminalStreamRetentionResourceInput {
  readonly limit: number
}

interface TerminalStreamRetentionResult {
  readonly scanned: number
  readonly deletedStreamIds: string[]
  readonly deletedFrames: number
  readonly earliestDeferredAt?: number
  readonly done: boolean
}

function assertDurablePageReplayProof(
  owner: 'stream-journal-integrity' | 'storage-retention:terminal-stream-prune',
  limit: number,
  receipt: SemanticOperationExactReceipt,
): void {
  const replay = receipt.plan.replay
  if (replay.kind !== 'durable-page-resume' || replay.owner !== owner || replay.limit !== limit) {
    throw new Error(`DurablePageReplayProofMismatch:${owner}`)
  }
}

const STREAM_JOURNAL_INTEGRITY_OPERATION_BOUNDS = {
  reads: {
    maxRequests: 3,
    maxRows: 1 + 2 * MAX_STORAGE_MAINTENANCE_BATCH,
    maxBatchRows: MAX_STORAGE_MAINTENANCE_BATCH,
    maxBytes: Number.MAX_SAFE_INTEGER,
  },
  writes: {
    maxRequests: 2,
    maxRows: STREAM_JOURNAL_RETIREMENT_MAX_ROWS + 1,
    maxBatchRows: STREAM_JOURNAL_RETIREMENT_MAX_ROWS,
    maxBytes: Number.MAX_SAFE_INTEGER,
  },
} as const

const STREAM_JOURNAL_INTEGRITY_OPERATION = semanticOperationDescriptor({
  operationKind: 'maintenance.reconcile-stream-journal-integrity',
  transaction: STREAM_JOURNAL_INTEGRITY_TRANSACTION_CAPABILITY,
  resources: () => ['stream-journal-integrity:maintenance'],
  permittedWrites: STREAM_JOURNAL_INTEGRITY_TRANSACTION_CAPABILITY.tableNames,
  requiredWritesWhenMutated: [],
  ...semanticOperationExactReceiptContracts<
    StreamJournalIntegrityResourceInput,
    'settings' | 'streamLeases' | 'streamChunks'
  >(),
  replay: semanticOperationExactReceiptReplayProofContract<StreamJournalIntegrityResourceInput>(
    (input, receipt) =>
      assertDurablePageReplayProof('stream-journal-integrity', input.limit, receipt),
  ),
})

const TERMINAL_STREAM_RETENTION_OPERATION_BOUNDS = {
  reads: {
    maxRequests: 5,
    maxRows: STREAM_JOURNAL_RETIREMENT_MAX_ROWS + 5,
    maxBatchRows: STREAM_JOURNAL_RETIREMENT_MAX_ROWS + 1,
    maxBytes: Number.MAX_SAFE_INTEGER,
  },
  writes: {
    maxRequests: 3,
    maxRows: STREAM_JOURNAL_RETIREMENT_MAX_ROWS + 2,
    maxBatchRows: STREAM_JOURNAL_RETIREMENT_MAX_ROWS,
    maxBytes: Number.MAX_SAFE_INTEGER,
  },
} as const

function terminalStreamRetentionReplayPlan(
  cycle: StorageRetentionCycle<'terminal-stream-prune'>,
  limit: number,
): SemanticOperationReplayPlan {
  return {
    kind: 'durable-page-resume',
    owner: 'storage-retention:terminal-stream-prune',
    cycle: cycle.cycleNow,
    revision: cycle.expectedRevision,
    cursor: stableStringify(cycle.cursor ?? null),
    doneMarker: `cutoff:${cycle.cutoff}`,
    limit,
  }
}

const TERMINAL_STREAM_RETENTION_OPERATION = semanticOperationDescriptor({
  operationKind: 'maintenance.prune-terminal-stream-journals',
  transaction: TERMINAL_STREAM_RETENTION_TRANSACTION_CAPABILITY,
  resources: () => ['storage-retention:terminal-stream-prune'],
  permittedWrites: TERMINAL_STREAM_RETENTION_TRANSACTION_CAPABILITY.tableNames,
  requiredWritesWhenMutated: [],
  ...semanticOperationExactReceiptContracts<
    TerminalStreamRetentionResourceInput,
    'storageRetentionState' | 'streamLeases' | 'streamChunks'
  >(),
  replay: semanticOperationExactReceiptReplayProofContract<TerminalStreamRetentionResourceInput>(
    (input, receipt) =>
      assertDurablePageReplayProof('storage-retention:terminal-stream-prune', input.limit, receipt),
  ),
})

const EMPTY_DRAFT_RETENTION_OPERATION = semanticOperationDescriptor({
  operationKind: 'maintenance.prune-empty-draft-chats',
  transaction: EMPTY_DRAFT_RETENTION_TRANSACTION_CAPABILITY,
  resources: () => ['storage-retention:empty-draft-prune'],
  permittedWrites: EMPTY_DRAFT_RETENTION_TRANSACTION_CAPABILITY.tableNames,
  requiredWritesWhenMutated: [],
  effects: {
    kind: 'effect-kinds',
    permitted: ['attachment', 'chat', 'draft', 'profile', 'setting', 'sidebar', 'stream-chunks'],
    requiredWhenMutated: () => [],
  },
})

interface DiscoveryCacheMaintenanceResourceInput {
  readonly limit: number
}

function assertDiscoveryCacheMaintenanceReplayProof(
  input: DiscoveryCacheMaintenanceResourceInput,
  receipt: SemanticOperationExactReceipt,
): void {
  const replay = receipt.plan.replay
  if (
    replay.kind !== 'durable-page-resume' ||
    replay.owner !== 'discovery-cache:maintenance' ||
    replay.limit !== input.limit
  ) {
    throw new Error('DiscoveryCacheMaintenanceReplayProofMismatch')
  }
}

const DISCOVERY_CACHE_MAINTENANCE_OPERATION = semanticOperationDescriptor({
  operationKind: 'maintenance.prune-discovery-cache',
  transaction: DISCOVERY_CACHE_MUTATION_TRANSACTION_CAPABILITY,
  resources: () => ['discovery-cache:retention'],
  permittedWrites: DISCOVERY_CACHE_MUTATION_TRANSACTION_CAPABILITY.tableNames,
  requiredWritesWhenMutated: [],
  ...semanticOperationExactReceiptContracts<
    DiscoveryCacheMaintenanceResourceInput,
    PhysicalStorageTableName
  >(),
  replay: semanticOperationExactReceiptReplayProofContract<DiscoveryCacheMaintenanceResourceInput>(
    assertDiscoveryCacheMaintenanceReplayProof,
  ),
})

const ATTACHMENT_INTEGRITY_OPERATION = semanticOperationDescriptor({
  operationKind: 'maintenance.reconcile-attachment-integrity',
  transaction: ATTACHMENT_INTEGRITY_TRANSACTION_CAPABILITY,
  resources: () => ['attachment-integrity:maintenance'],
  permittedWrites: ATTACHMENT_INTEGRITY_TRANSACTION_CAPABILITY.tableNames,
  requiredWritesWhenMutated: [],
  effects: {
    kind: 'effect-kinds',
    permitted: ['attachment'],
    requiredWhenMutated: () => ['attachment'],
  },
})

interface StreamOperationResourceInput {
  readonly streamId: string
}

interface StreamLeaseOperationResourceInput extends StreamOperationResourceInput {
  readonly replay: SemanticOperationReplayPlan
}

interface StreamJournalAppendResourceInput extends StreamOperationResourceInput {
  readonly replay: SemanticOperationReplayPlan
}

function streamOperationResourceNames(input: StreamOperationResourceInput): readonly string[] {
  return [`stream-journal:${input.streamId}`]
}

function streamLeaseOperationDescriptor<
  const Kind extends
    | 'attempt.request-stop'
    | 'attempt.seal-terminal'
    | 'stream.note-selected-key'
    | 'stream.renew'
    | 'stream.handoff-recovery'
    | 'stream.claim-recovery',
>(operationKind: Kind, replayContract: 'exact' | 'receipt-proof' | undefined = undefined) {
  return semanticOperationDescriptor({
    operationKind,
    transaction: STREAM_LEASE_MUTATION_TRANSACTION_CAPABILITY,
    resources: streamOperationResourceNames,
    permittedWrites: STREAM_LEASE_MUTATION_TRANSACTION_CAPABILITY.tableNames,
    requiredWritesWhenMutated: ['streamLeases'],
    ...semanticOperationExactReceiptContracts<StreamLeaseOperationResourceInput, 'streamLeases'>(),
    ...(replayContract === 'exact'
      ? {
          replay: semanticOperationExactReceiptReplayContract<StreamLeaseOperationResourceInput>(
            ({ replay }) => replay,
          ),
        }
      : replayContract === 'receipt-proof'
        ? {
            replay:
              semanticOperationExactReceiptReplayProofContract<StreamLeaseOperationResourceInput>(
                assertStreamLeaseReplayProof,
              ),
          }
        : {}),
  })
}

const STREAM_LEASE_OPERATION_BOUNDS = Object.freeze({
  reads: Object.freeze({
    maxRequests: 1,
    maxRows: 1,
    maxBatchRows: 1,
    maxBytes: Number.MAX_SAFE_INTEGER,
  }),
  writes: Object.freeze({
    maxRequests: 1,
    maxRows: 1,
    maxBatchRows: 1,
    maxBytes: Number.MAX_SAFE_INTEGER,
  }),
})

const STREAM_JOURNAL_APPEND_OPERATION_BOUNDS = Object.freeze({
  reads: Object.freeze({
    maxRequests: 2,
    maxRows: STREAM_JOURNAL_APPEND_MAX_ROWS + 1,
    maxBatchRows: STREAM_JOURNAL_APPEND_MAX_ROWS,
    maxBytes: Number.MAX_SAFE_INTEGER,
  }),
  writes: Object.freeze({
    maxRequests: 2,
    maxRows: STREAM_JOURNAL_APPEND_MAX_ROWS + 1,
    maxBatchRows: STREAM_JOURNAL_APPEND_MAX_ROWS,
    maxBytes: Number.MAX_SAFE_INTEGER,
  }),
})

function streamWriteFenceReplayTokens(
  fence: StreamWriteFence,
): readonly SemanticOperationReplayToken[] {
  return [fence.ownerClientId, fence.fenceToken, fence.replacementEpoch, fence.admissionSequence]
}

function streamJournalAppendReplayPlan(
  authority: StreamJournalWriterAuthority,
  frameIds: readonly string[],
): SemanticOperationReplayPlan {
  return {
    kind: 'append-by-key',
    owner: `stream:${authority.streamId}`,
    fence: [
      authority.ownerClientId,
      authority.fenceToken,
      authority.replacementEpoch,
      authority.admissionSequence,
    ],
    keys: frameIds,
    equality: 'canonical-equal-or-conflict',
    lifecycle: 'active-writer',
  }
}

function selectedKeyReplayPlan(
  streamId: string,
  fence: readonly SemanticOperationReplayToken[],
  selectedKeyId: string,
): SemanticOperationReplayPlan {
  return {
    kind: 'fenced-convergent',
    owner: `stream:${streamId}`,
    fence,
    desired: [selectedKeyId],
    alreadyApplied: 'return-current-or-conflict',
  }
}

function observedSelectedKeyReplayPlan(lease: StreamLeaseRow): SemanticOperationReplayPlan {
  if (!streamLeaseHasWriteFence(lease)) {
    throw new Error(`StreamSelectedKeyReplayFenceMissing:${lease.streamId}`)
  }
  const evidence = requiredStreamPostCommitEvidence(lease)
  const selectedKeyId = evidence.selectedKeyId ?? evidence.final?.selectedKeyId
  if (!selectedKeyId) throw new Error(`StreamSelectedKeyReplayValueMissing:${lease.streamId}`)
  return selectedKeyReplayPlan(lease.streamId, streamWriteFenceReplayTokens(lease), selectedKeyId)
}

function handoffReplayPlan(
  streamId: string,
  replacementEpoch: number,
  admissionSequence: number,
  handoffId: string,
  handedOffAt: number,
  reason: StreamLeaseHandoffReason,
): SemanticOperationReplayPlan {
  return {
    kind: 'fenced-convergent',
    owner: `stream:${streamId}`,
    fence: [replacementEpoch, admissionSequence],
    desired: [handoffId, handedOffAt, reason],
    alreadyApplied: 'return-current-or-conflict',
  }
}

function observedHandoffReplayPlan(lease: StreamLeaseRow): SemanticOperationReplayPlan {
  if (lease.custody !== 'recovery-pending') {
    throw new Error(`StreamHandoffReplayCustodyInvalid:${lease.streamId}`)
  }
  return handoffReplayPlan(
    lease.streamId,
    lease.replacementEpoch,
    lease.admissionSequence,
    lease.handoffId,
    lease.handedOffAt,
    lease.handoffReason,
  )
}

function assertStreamLeaseReplayProof(
  input: StreamLeaseOperationResourceInput,
  receipt: SemanticOperationExactReceipt,
): void {
  const expected = input.replay
  const observed = receipt.plan.replay
  if (expected.kind === 'compare-and-swap' && observed.kind === 'compare-and-swap') {
    if (
      expected.outcome !== 'request' ||
      expected.owner !== observed.owner ||
      observed.outcome === 'request'
    ) {
      throw new Error('StreamLeaseReplayProofMismatch')
    }
    if (observed.outcome === 'applied') {
      if (
        stableStringify(expected.expected) !== stableStringify(observed.expected) ||
        stableStringify(expected.desired) !== stableStringify(observed.desired) ||
        receipt.physicalMutations.length === 0
      ) {
        throw new Error('StreamLeaseReplayProofMismatch')
      }
      return
    }
    if (receipt.physicalMutations.length !== 0) {
      throw new Error('StreamLeaseReplayProofMismatch')
    }
    return
  }
  if (expected.kind === 'level-triggered-merge' && observed.kind === 'level-triggered-merge') {
    if (
      expected.outcome !== 'request' ||
      expected.owner !== observed.owner ||
      stableStringify(expected.desired) !== stableStringify(observed.desired) ||
      observed.outcome === 'request'
    ) {
      throw new Error('StreamLeaseReplayProofMismatch')
    }
    if (observed.outcome === 'applied') {
      if (
        stableStringify(expected.target) !== stableStringify(observed.target) ||
        receipt.physicalMutations.length === 0
      ) {
        throw new Error('StreamLeaseReplayProofMismatch')
      }
      return
    }
    if (
      (observed.outcome === 'already-applied' || observed.outcome === 'terminal') &&
      stableStringify(expected.target) !== stableStringify(observed.target)
    ) {
      throw new Error('StreamLeaseReplayProofMismatch')
    }
    if (receipt.physicalMutations.length !== 0) {
      throw new Error('StreamLeaseReplayProofMismatch')
    }
    return
  }
  if (expected.kind === 'caller-at-most-once' && observed.kind === 'caller-at-most-once') {
    if (
      expected.outcome !== 'request' ||
      expected.owner !== observed.owner ||
      expected.localConvergence !== observed.localConvergence ||
      expected.recovery !== observed.recovery ||
      stableStringify(expected.target) !== stableStringify(observed.target) ||
      observed.outcome === 'request'
    ) {
      throw new Error('StreamLeaseReplayProofMismatch')
    }
    if ((observed.outcome === 'applied') !== receipt.physicalMutations.length > 0) {
      throw new Error('StreamLeaseReplayProofMismatch')
    }
    return
  }
  throw new Error('StreamLeaseReplayProofMismatch')
}

function renewReplayPlan(
  streamId: string,
  expected: readonly SemanticOperationReplayToken[],
  desired: readonly SemanticOperationReplayToken[],
  outcome: 'request' | 'applied' | 'rejected',
): SemanticOperationReplayPlan {
  return {
    kind: 'compare-and-swap',
    owner: `stream:${streamId}`,
    expected,
    desired,
    outcome,
  }
}

function requestedRenewReplayPlan(heartbeat: StreamLeaseHeartbeat): SemanticOperationReplayPlan {
  return renewReplayPlan(
    heartbeat.streamId,
    [
      heartbeat.fence.replacementEpoch,
      heartbeat.fence.admissionSequence,
      heartbeat.expectedRevision,
    ],
    [heartbeat.heartbeatAt],
    'request',
  )
}

function observedRenewReplayPlan(
  current: StreamLeaseRow | undefined,
  decision: StreamLeaseOperationDecision<StreamLeaseRow>,
): SemanticOperationReplayPlan {
  const next = decision.next
  if (next) {
    return renewReplayPlan(
      next.streamId,
      [next.replacementEpoch, next.admissionSequence, next.revision - 1],
      [next.heartbeatAt ?? null],
      'applied',
    )
  }
  return renewReplayPlan(
    decision.value.streamId,
    current ? [current.replacementEpoch, current.admissionSequence, current.revision] : [],
    [decision.value.heartbeatAt ?? null],
    'rejected',
  )
}

function claimRecoveryReplayPlan(
  streamId: string,
  expected: readonly SemanticOperationReplayToken[],
  outcome: 'request' | 'applied' | 'rejected',
): SemanticOperationReplayPlan {
  return {
    kind: 'compare-and-swap',
    owner: `stream:${streamId}`,
    expected,
    desired: ['claim-recovery'],
    outcome,
  }
}

function requestedClaimRecoveryReplayPlan(expected: StreamLeaseRow): SemanticOperationReplayPlan {
  return claimRecoveryReplayPlan(
    expected.streamId,
    [expected.replacementEpoch, expected.admissionSequence, expected.revision],
    'request',
  )
}

function observedClaimRecoveryReplayPlan(
  current: StreamLeaseRow | undefined,
  decision: StreamLeaseOperationDecision<StreamLeaseRow | undefined>,
  streamId: string,
): SemanticOperationReplayPlan {
  const next = decision.next
  if (next) {
    return claimRecoveryReplayPlan(
      next.streamId,
      [next.replacementEpoch, next.admissionSequence, next.revision - 1],
      'applied',
    )
  }
  return claimRecoveryReplayPlan(
    streamId,
    current ? [current.replacementEpoch, current.admissionSequence, current.revision] : [],
    'rejected',
  )
}

function attemptStopTarget(
  value: Pick<
    AttemptRequestStopInput,
    'chatId' | 'messageId' | 'attemptKind' | 'replacementEpoch' | 'admissionSequence'
  >,
): readonly SemanticOperationReplayToken[] {
  return [
    value.chatId,
    value.messageId,
    value.attemptKind,
    value.replacementEpoch,
    value.admissionSequence,
  ]
}

function attemptStopReplayPlan(
  streamId: string,
  target: readonly SemanticOperationReplayToken[],
  outcome: 'request' | 'applied' | 'already-applied' | 'terminal' | 'stale' | 'missing',
): SemanticOperationReplayPlan {
  return {
    kind: 'level-triggered-merge',
    owner: `stream:${streamId}`,
    target,
    desired: ['stop-requested'],
    outcome,
  }
}

function observedAttemptStopReplayPlan(
  current: StreamLeaseRow | undefined,
  decision: StreamLeaseOperationDecision<AttemptRequestStopResult>,
  streamId: string,
): SemanticOperationReplayPlan {
  const lease = decision.next ?? ('lease' in decision.value ? decision.value.lease : current)
  const outcome =
    decision.value.outcome === 'accepted'
      ? 'applied'
      : decision.value.outcome === 'already-requested'
        ? 'already-applied'
        : decision.value.outcome
  return attemptStopReplayPlan(streamId, lease ? attemptStopTarget(lease) : [], outcome)
}

function attemptTerminalReplayPlan(
  streamId: string,
  target: readonly SemanticOperationReplayToken[],
  outcome: 'request' | 'applied' | 'already-applied',
): SemanticOperationReplayPlan {
  return {
    kind: 'caller-at-most-once',
    owner: `stream:${streamId}`,
    target,
    localConvergence: 'canonical-equal-or-conflict',
    recovery: 'resume-from-durable-phase',
    outcome,
  }
}

function observedAttemptTerminalReplayPlan(
  lease: TerminalDecidedStreamLeaseRow,
  didApply: boolean,
): SemanticOperationReplayPlan {
  if (!streamLeaseHasWriteFence(lease)) {
    throw new Error('AttemptTerminalReplayFenceMissing')
  }
  return attemptTerminalReplayPlan(
    lease.streamId,
    streamWriteFenceReplayTokens(lease),
    didApply ? 'applied' : 'already-applied',
  )
}

interface StreamLeaseOperationDecision<Result> {
  readonly value: Result
  readonly next?: StreamLeaseRow
}

async function executeStreamLeaseOperation<Result>(
  commit: BrowserCommandCommit,
  descriptor: SemanticOperationDescriptor<
    SemanticOperationKind,
    'streamLeases',
    StreamLeaseOperationResourceInput,
    SemanticOperationExactReceipt<'streamLeases'>
  >,
  streamId: string,
  replay: SemanticOperationReplayPlan,
  decide: (
    current: StreamLeaseRow | undefined,
  ) => Promise<StreamLeaseOperationDecision<Result>> | StreamLeaseOperationDecision<Result>,
  observedReplay?: (
    current: StreamLeaseRow | undefined,
    decision: StreamLeaseOperationDecision<Result>,
  ) => SemanticOperationReplayPlan,
): Promise<Result> {
  return commit.executeSemanticOperation(descriptor, { streamId, replay }, async (tx) => {
    const current = await tx.table<StreamLeaseRow, string>('streamLeases').get(streamId)
    const decision = await decide(current)
    if (decision.next) await putStreamLeaseByteOwner(tx, decision.next, current)
    return semanticOperationExecution(
      decision.value,
      semanticOperationExactReceipt(
        semanticOperationExactPlan({
          replay: observedReplay ? observedReplay(current, decision) : replay,
          bounds: STREAM_LEASE_OPERATION_BOUNDS,
        }),
        {
          dependencies: decision.next
            ? [
                {
                  kind: 'stream-lease',
                  chatId: decision.next.chatId,
                  streamIds: [streamId],
                },
              ]
            : [],
          physicalMutations: decision.next
            ? [{ tableName: 'streamLeases', operation: 'write', key: streamId }]
            : [],
          physicalReads: [
            {
              tableName: 'streamLeases',
              indexKind: 'primary',
              operation: 'get',
              requestCount: 1,
              rowCount: 1,
            },
          ],
        },
      ),
    )
  })
}

const ATTEMPT_REQUEST_STOP_OPERATION = streamLeaseOperationDescriptor(
  'attempt.request-stop',
  'receipt-proof',
)
const ATTEMPT_SEAL_TERMINAL_OPERATION = streamLeaseOperationDescriptor(
  'attempt.seal-terminal',
  'receipt-proof',
)
const STREAM_NOTE_SELECTED_KEY_OPERATION = streamLeaseOperationDescriptor(
  'stream.note-selected-key',
  'exact',
)
const STREAM_RENEW_OPERATION = streamLeaseOperationDescriptor('stream.renew', 'receipt-proof')
const STREAM_HANDOFF_RECOVERY_OPERATION = streamLeaseOperationDescriptor(
  'stream.handoff-recovery',
  'exact',
)
const STREAM_CLAIM_RECOVERY_OPERATION = streamLeaseOperationDescriptor(
  'stream.claim-recovery',
  'receipt-proof',
)

const STREAM_APPEND_JOURNAL_FRAMES_OPERATION = semanticOperationDescriptor({
  operationKind: 'stream.append-journal-frames',
  transaction: STREAM_JOURNAL_MUTATION_TRANSACTION_CAPABILITY,
  resources: streamOperationResourceNames,
  permittedWrites: STREAM_JOURNAL_MUTATION_TRANSACTION_CAPABILITY.tableNames,
  requiredWritesWhenMutated: ['streamLeases'],
  ...semanticOperationExactReceiptContracts<
    StreamJournalAppendResourceInput,
    'streamLeases' | 'streamChunks'
  >(),
  replay: semanticOperationExactReceiptReplayContract<StreamJournalAppendResourceInput>(
    ({ replay }) => replay,
  ),
})

interface StreamFinishCleanupResourceInput {
  readonly streamId: string
  readonly fence: StreamWriteFence
  readonly maxFrameRows: number
  readonly replay: SemanticOperationReplayPlan
}

function streamFinishCleanupReplayPlan(
  streamId: string,
  fence: StreamWriteFence,
  maxFrameRows: number,
  outcome: 'request' | 'applied' | 'already-applied',
): SemanticOperationReplayPlan {
  return {
    kind: 'level-triggered-merge',
    owner: `stream:${streamId}`,
    target: streamWriteFenceReplayTokens(fence),
    desired: ['journal-absent', maxFrameRows],
    outcome,
  }
}

function assertStreamFinishCleanupReplayProof(
  input: StreamFinishCleanupResourceInput,
  receipt: SemanticOperationExactReceipt,
): void {
  const expected = input.replay
  const observed = receipt.plan.replay
  if (
    expected.kind !== 'level-triggered-merge' ||
    expected.outcome !== 'request' ||
    observed.kind !== 'level-triggered-merge' ||
    observed.outcome === 'request' ||
    stableStringify({
      owner: expected.owner,
      target: expected.target,
      desired: expected.desired,
    }) !==
      stableStringify({
        owner: observed.owner,
        target: observed.target,
        desired: observed.desired,
      }) ||
    (observed.outcome === 'applied') !== receipt.physicalMutations.length > 0
  ) {
    throw new Error('StreamFinishCleanupReplayProofMismatch')
  }
}

const STREAM_FINISH_CLEANUP_OPERATION_BOUNDS = {
  reads: {
    maxRequests: 2,
    maxRows: STREAM_JOURNAL_RETIREMENT_MAX_ROWS + 2,
    maxBatchRows: STREAM_JOURNAL_RETIREMENT_MAX_ROWS + 1,
    maxBytes: Number.MAX_SAFE_INTEGER,
  },
  writes: {
    maxRequests: 2,
    maxRows: STREAM_JOURNAL_RETIREMENT_MAX_ROWS + 1,
    maxBatchRows: STREAM_JOURNAL_RETIREMENT_MAX_ROWS,
    maxBytes: Number.MAX_SAFE_INTEGER,
  },
} as const

const STREAM_FINISH_CLEANUP_OPERATION = semanticOperationDescriptor({
  operationKind: 'stream.finish-cleanup',
  transaction: STREAM_JOURNAL_MUTATION_TRANSACTION_CAPABILITY,
  resources: streamOperationResourceNames,
  permittedWrites: STREAM_JOURNAL_MUTATION_TRANSACTION_CAPABILITY.tableNames,
  requiredWritesWhenMutated: [],
  ...semanticOperationExactReceiptContracts<
    StreamFinishCleanupResourceInput,
    'streamLeases' | 'streamChunks'
  >(),
  replay: semanticOperationExactReceiptReplayProofContract<StreamFinishCleanupResourceInput>(
    assertStreamFinishCleanupReplayProof,
  ),
})
const FORK_CHAT_TRANSACTION_CAPABILITY = physicalStorageTables(
  ...ATTACHMENT_CATALOG_MUTATION_TRANSACTION_CAPABILITY.tableNames,
  ...CHAT_ROW_LINKED_TRANSACTION_CAPABILITY.tableNames,
  'childLists',
  'childSlotMembers',
  'messages',
  'messageBodies',
  'messagePreviews',
)
interface ChatForkResourceInput {
  readonly sourceChatId: ChatId
  readonly targetMessageId: MessageId
  readonly destinationChatId: ChatId
}

function chatForkResourceNames(input: ChatForkResourceInput): readonly string[] {
  return [
    `chat-meta:${input.sourceChatId}`,
    `message-topology:${input.sourceChatId}`,
    `message:${input.targetMessageId}`,
    `chat-meta:${input.destinationChatId}`,
    `message-topology:${input.destinationChatId}`,
  ]
}

const CHAT_FORK_OPERATION = semanticOperationDescriptor({
  operationKind: 'chat.fork',
  transaction: FORK_CHAT_TRANSACTION_CAPABILITY,
  resources: chatForkResourceNames,
  permittedWrites: FORK_CHAT_TRANSACTION_CAPABILITY.tableNames,
  requiredWritesWhenMutated: [
    'chats',
    'childLists',
    'childSlotMembers',
    'messages',
    'messageBodies',
    'messagePreviews',
  ],
  effects: {
    kind: 'effect-kinds',
    permitted: [
      'attachment',
      'chat',
      'child-slot',
      'message-body',
      'message-header',
      'message-preview',
      'profile',
      'sidebar',
    ],
    requiredWhenMutated: () => [
      'chat',
      'child-slot',
      'message-body',
      'message-header',
      'message-preview',
      'sidebar',
    ],
  },
})
type BrowserInterchangeQuery = Extract<WorkspaceQuery, { kind: `interchange.${string}` }>
type BrowserConversationEnvelopeQuery = Extract<
  WorkspaceQuery,
  {
    kind: 'message.headers-by-chat' | 'branch.open' | 'branch.forks' | 'branch.page-structure'
  }
>
type BrowserInlineQuery = Exclude<
  WorkspaceQuery,
  BrowserInterchangeQuery | BrowserConversationEnvelopeQuery | { kind: 'workspace.meta' }
>

interface BrowserWorkspaceReadFrame {
  readonly db: NatterDb
  readonly permit: WorkspaceReadAuthority
  readonly signal: AbortSignal
  readonly workspace: WorkspaceMeta
}

function isBrowserInterchangeQuery(query: WorkspaceQuery): query is BrowserInterchangeQuery {
  return query.kind.startsWith('interchange.')
}

function requiredUnreferencedAt(attachment: AttachmentHeaderRow): number {
  if (typeof attachment.unreferencedAt !== 'number') {
    throw new Error(`AttachmentReapEligibilityMissing:${attachment.id}`)
  }
  return attachment.unreferencedAt
}

const ATTACHMENT_REAP_PREFLIGHT_TRANSACTION_PLAN = physicalTransactionPlan(
  physicalStorageTables('attachments', 'storageRetentionState'),
)
const attachmentReapPlanBrand: unique symbol = Symbol('AttachmentReapPlan')

interface AttachmentReapPlan {
  readonly cycle: StorageRetentionCycle<'attachment-reap'>
  readonly limit: number
  readonly candidates: readonly {
    readonly id: AttachmentId
    readonly unreferencedAt: number
  }[]
  readonly [attachmentReapPlanBrand]: true
}

function attachmentReapReplayPlan(
  cycle: StorageRetentionCycle<'attachment-reap'>,
  limit: number,
): SemanticOperationReplayPlan {
  return {
    kind: 'durable-page-resume',
    owner: 'storage-retention:attachment-reap',
    cycle: cycle.cycleNow,
    revision: cycle.expectedRevision,
    cursor: stableStringify(cycle.cursor ?? null),
    doneMarker: `cutoff:${cycle.cutoff}`,
    limit,
  }
}

async function readAttachmentReapPlan(
  commit: BrowserCommandSessionPort,
  now: number,
  maxAgeMs: number,
  limit: number,
): Promise<AttachmentReapPlan> {
  return commit.readSemanticOperationPreflight(
    ATTACHMENT_REAP_PREFLIGHT_TRANSACTION_PLAN,
    async (tx) => {
      const state = await readStorageRetentionState(tx, 'attachment-reap')
      const cycle = storageRetentionCycle(state, now, maxAgeMs)
      const lower = cycle.cursor ? [0, cycle.cursor.unreferencedAt, cycle.cursor.attachmentId] : [0]
      const rows = await tx
        .table<AttachmentHeaderRow, AttachmentId>('attachments')
        .where('[refCount+unreferencedAt+id]')
        .between(lower, [0, cycle.cutoff], false, false)
        .limit(limit)
        .toArray()
      return Object.freeze({
        cycle,
        limit,
        candidates: Object.freeze(
          rows.map((row) =>
            Object.freeze({
              id: row.id,
              unreferencedAt: requiredUnreferencedAt(row),
            }),
          ),
        ),
        [attachmentReapPlanBrand]: true as const,
      })
    },
    (plan) => [
      {
        tableName: 'storageRetentionState',
        indexKind: 'primary',
        operation: 'get',
        requestCount: 1,
        rowCount: 1,
      },
      {
        tableName: 'attachments',
        indexKind: 'secondary',
        indexName: '[refCount+unreferencedAt+id]',
        operation: 'query',
        requestCount: 1,
        rowCount: plan.candidates.length,
      },
    ],
  )
}

function protocolDiscoveryCacheEvictions(
  evictions: readonly StorageDiscoveryCacheEviction[],
): DiscoveryCacheEviction[] {
  return evictions.map((eviction) => ({
    cacheKind: eviction.tableName === 'privacyPolicies' ? 'privacy' : eviction.tableName,
    profileId: eviction.profileId,
    discriminator: eviction.discriminator,
  }))
}

function protocolDiscoveryCachePutResult(
  result: StorageDiscoveryCachePutResult,
): DiscoveryCachePutResult {
  return {
    accepted: result.accepted,
    cacheChanged: result.cacheChanged,
    cached: result.cached,
    repairRequired: result.repairRequired,
    evictions: protocolDiscoveryCacheEvictions(result.evictions),
  }
}

function emptyDiscoveryCachePutResult(): DiscoveryCachePutResult {
  return {
    accepted: false,
    cacheChanged: false,
    cached: false,
    repairRequired: false,
    evictions: [],
  }
}

async function commitStorageRetentionPage<Task extends StorageRetentionTask>(
  tx: Transaction,
  cycle: StorageRetentionCycle<Task>,
  outcome:
    | { readonly done: false; readonly cursor?: StorageRetentionCursor<Task> }
    | { readonly done: true; readonly earliestDeferredAt?: number },
): Promise<SemanticOperationReceiptFragment<'storageRetentionState'>> {
  const previous = await readStorageRetentionState(tx, cycle.task)
  assertStorageRetentionCycleCurrent(previous, cycle)
  const next = advanceStorageRetentionState(cycle, outcome)
  await putPhysicalStorageRow<StorageRetentionStateRowFor<Task>, StorageRetentionTask>(
    tx,
    'storageRetentionState',
    next,
    previous,
  )
  recordBrowserCommandStorageRetentionMutation(tx, cycle.task)
  return semanticOperationReceiptFragment({
    physicalMutations: [
      {
        tableName: 'storageRetentionState',
        operation: 'write',
        key: cycle.task,
      },
    ],
    physicalReads: [
      {
        tableName: 'storageRetentionState',
        indexKind: 'primary',
        operation: 'get',
        requestCount: 1,
        rowCount: 1,
      },
    ],
  })
}

export function __messageRequestContextChangedForTests(
  existingHeader: MessageHeaderRow,
  existingBody: MessageBodyRow,
  nextHeader: MessageHeaderRow,
  nextBody: MessageBodyRow,
): boolean {
  return messageSemanticEffect(existingHeader, existingBody, nextHeader, nextBody)
    .requestContextChanged
}

function messageSemanticEffect(
  existingHeader: MessageHeaderRow,
  existingBody: MessageBodyRow | undefined,
  nextHeader: MessageHeaderRow,
  nextBody: MessageBodyRow,
  appliedBodyEffect?: AppliedMessageSemanticEffect,
): AppliedMessageSemanticEffect {
  const requestHeaderChanged =
    existingHeader.id !== nextHeader.id ||
    existingHeader.chatId !== nextHeader.chatId ||
    existingHeader.parentId !== nextHeader.parentId ||
    existingHeader.role !== nextHeader.role ||
    existingHeader.origin !== nextHeader.origin ||
    !sameValue(existingHeader.attachmentRefs, nextHeader.attachmentRefs) ||
    !sameValue(existingHeader.approval, nextHeader.approval) ||
    existingHeader.pinCache !== nextHeader.pinCache ||
    existingHeader.hiddenFromContext !== nextHeader.hiddenFromContext ||
    existingHeader.deleted !== nextHeader.deleted
  const corpusHeaderChanged =
    existingHeader.role !== nextHeader.role ||
    !sameValue(existingHeader.attachmentRefs, nextHeader.attachmentRefs)
  if (appliedBodyEffect) {
    return {
      requestContextChanged: requestHeaderChanged || appliedBodyEffect.requestContextChanged,
      branchCorpusChanged: corpusHeaderChanged || appliedBodyEffect.branchCorpusChanged,
    }
  }
  if (!existingBody) {
    return { requestContextChanged: true, branchCorpusChanged: true }
  }
  const existingView = createAppliedMessageView(existingBody)
  const nextView = createAppliedMessageView(nextBody)
  return {
    requestContextChanged:
      requestHeaderChanged || !appliedMessageRequestSemanticsEqual(existingView, nextView),
    branchCorpusChanged:
      corpusHeaderChanged ||
      existingView.phase !== nextView.phase ||
      !messageRenderableTextSemanticsEqual(
        {
          ...existingBody,
          ...(existingHeader.attachmentRefs
            ? { attachmentRefs: existingHeader.attachmentRefs }
            : {}),
        },
        {
          ...nextBody,
          ...(nextHeader.attachmentRefs ? { attachmentRefs: nextHeader.attachmentRefs } : {}),
        },
        existingView,
        nextView,
      ),
  }
}

function nextStreamLeaseRevision(lease: Pick<StreamLeaseRow, 'revision'>): number {
  if (lease.revision >= Number.MAX_SAFE_INTEGER) {
    throw new Error('StreamLeaseRevisionExhausted')
  }
  return lease.revision + 1
}

function assertOwnedStreamFence(
  lease: StreamLeaseRow | undefined,
  fence: StreamWriteFence,
  replacementEpoch: number,
  streamId: string,
): asserts lease is FencedStreamLeaseRow {
  if (!streamLeaseMatchesWriteFence(lease, fence) || replacementEpoch !== fence.replacementEpoch) {
    throw new Error(`StreamFenceLost:${streamId}`)
  }
}

function cloneMessageHeader(message: MessageHeaderRow): MessageHeaderRow {
  return canonicalMessageHeaderRow(message)
}

type MutableMessageHeaderRow = {
  -readonly [K in keyof MessageHeaderRow]: MessageHeaderRow[K]
}

function throwIfReadonlyAborted(signal: AbortSignal | undefined, message: string): void {
  if (signal?.aborted) throw new DOMException(message, 'AbortError')
}

function bindReadonlyTransactionAbort(
  tx: Transaction,
  signal: AbortSignal | undefined,
  message: string,
): () => void {
  if (!signal) return () => undefined
  const abort = () => tx.abort()
  if (signal.aborted) {
    abort()
    throw new DOMException(message, 'AbortError')
  }
  signal.addEventListener('abort', abort, { once: true })
  return () => signal.removeEventListener('abort', abort)
}

function applyMessageHeaderPatch(
  header: MessageHeaderRow,
  patch: MessageHeaderPatch | undefined,
): MessageHeaderRow {
  const next: MutableMessageHeaderRow = cloneMessageHeader(header)
  if (!patch) return next
  for (const key of Object.keys(patch) as Array<keyof MessageHeaderRow>) {
    if (FORBIDDEN_MESSAGE_HEADER_PATCH_KEYS.has(key)) {
      throw new Error(`MessageHeaderPatchForbidden:${header.id}:${String(key)}`)
    }
    const value = patch[key]
    if (value === undefined) delete next[key]
    else next[key] = structuredClone(value) as never
  }
  return next
}

const CALIBRATION_MESSAGE_PATCH_KEYS = new Set<keyof MessageCalibrationPatch>([
  'originalCharCount',
  'originalTokenEstimate',
  'originalModelId',
  'originalCalibrationKey',
  'charCountDelta',
  'cachedTokenEstimate',
  'generation',
])

function applyMessageCalibrationPatch(
  header: MessageHeaderRow,
  patch: MessageCalibrationPatch,
): MessageHeaderRow {
  for (const key of Object.keys(patch) as Array<keyof MessageCalibrationPatch>) {
    if (!CALIBRATION_MESSAGE_PATCH_KEYS.has(key)) {
      throw new Error(`MessageCalibrationPatchForbidden:${header.id}:${String(key)}`)
    }
  }
  if (patch.generation) {
    const { tokenCalibration: _beforeCalibration, ...beforeGeneration } =
      header.generation ?? ({} as NonNullable<Message['generation']>)
    const { tokenCalibration: _afterCalibration, ...afterGeneration } = patch.generation
    if (stableStringify(beforeGeneration) !== stableStringify(afterGeneration)) {
      throw new Error(`MessageCalibrationGenerationPatchForbidden:${header.id}`)
    }
  }
  return applyMessageHeaderPatch(header, patch)
}

function hydrateStoredMessage(header: MessageHeaderRow, body: MessageBodyRow): Message {
  return hydrateMessage(cloneMessageHeader(header), body)
}

async function readStoredMessage<T>(
  db: NatterDb,
  messageId: MessageId,
  signal: AbortSignal | undefined,
  project: (header: MessageHeaderRow, body: MessageBodyRow) => T,
): Promise<T | undefined> {
  throwIfReadonlyAborted(signal, 'Message read aborted')
  return db.transaction('r', db.messages, db.messageBodies, async (tx: Transaction) => {
    const unbind = bindReadonlyTransactionAbort(tx, signal, 'Message read aborted')
    try {
      const [header, body] = await Promise.all([
        db.messages.get(messageId),
        db.messageBodies.get(messageId),
      ])
      throwIfReadonlyAborted(signal, 'Message read aborted')
      return header && body ? project(header, body) : undefined
    } finally {
      unbind()
    }
  })
}

async function readMessageTextPreviewWindow(
  db: NatterDb,
  targets: readonly (MessageTextPreviewTarget | { messageId: MessageId })[],
  options: { maxChars?: number; signal?: AbortSignal },
): Promise<Array<MessageTextPreviewSnapshot | undefined>> {
  throwIfReadonlyAborted(options.signal, 'Message preview read aborted')
  if (targets.length === 0) return []
  const maxChars = Math.min(
    MESSAGE_TEXT_PREVIEW_MAX_CHARS,
    Math.max(1, Math.floor(options.maxChars ?? 240)),
  )
  const rows: Array<MessageTextPreviewSnapshot | undefined> = []
  for (let offset = 0; offset < targets.length; offset += BODY_READ_PAGE_SIZE) {
    throwIfReadonlyAborted(options.signal, 'Message preview read aborted')
    const pageTargets = targets.slice(offset, offset + BODY_READ_PAGE_SIZE)
    const messageIds = pageTargets.map((target) => target.messageId)
    const page = await db.transaction(
      'r',
      db.messages,
      db.messagePreviews,
      async (tx: Transaction) => {
        const unbind = bindReadonlyTransactionAbort(
          tx,
          options.signal,
          'Message preview read aborted',
        )
        try {
          const [headers, previews] = await Promise.all([
            tx.table<MessageHeaderRow, MessageId>('messages').bulkGet(messageIds),
            tx.table<MessageTextPreviewRow, MessageId>('messagePreviews').bulkGet(messageIds),
          ])
          return pageTargets.map((target, index) => {
            const header = headers[index]
            if (!header) return undefined
            if ('bodyVersion' in target && header.bodyVersion !== target.bodyVersion) {
              return undefined
            }
            const preview = previews[index]
            if (!preview) throw new Error(`MessagePreviewMissing:${target.messageId}`)
            if (preview.bodyVersion !== header.bodyVersion) {
              throw new Error(`MessagePreviewVersionMismatch:${target.messageId}`)
            }
            return {
              messageId: target.messageId,
              bodyVersion: header.bodyVersion,
              text: previewTextFromStoredProjection(preview.text, maxChars),
            }
          })
        } finally {
          unbind()
        }
      },
    )
    rows.push(...page)
  }
  return rows
}

function cloneDraft(draft: DraftRow): DraftRow {
  const cloned = structuredClone(draft)
  cloned.attachmentRefs = normalizeAttachmentRefs(cloned.attachmentRefs, {
    draftChatId: cloned.chatId,
    createdAt: cloned.updatedAt,
  })
  return cloned
}

async function hydrateStoredAttachment(
  header: AttachmentHeaderRow,
  artifacts: Table<AttachmentArtifact, string>,
): Promise<Attachment> {
  return hydrateAttachment(header, await artifacts.bulkGet(header.artifactIds))
}

function computeTotalCostUsd(messages: readonly Pick<Message, 'deleted' | 'generation'>[]): number {
  let total = 0
  for (const message of messages) {
    if (message.deleted) continue
    total += message.generation?.cost ?? 0
  }
  return total
}

function sealValidatedGenerationPromptPathHeaders(
  headers: MessageHeaderRow[],
): ValidatedGenerationPromptPathHeaders {
  Object.defineProperty(headers, VALIDATED_GENERATION_PROMPT_PATH_HEADERS, { value: true })
  return Object.freeze(headers) as ValidatedGenerationPromptPathHeaders
}

function appendValidatedGenerationPromptPath(
  path: ValidatedGenerationPromptPath,
  header: MessageHeaderRow,
): ValidatedGenerationPromptPath {
  return Object.freeze({
    headers: sealValidatedGenerationPromptPathHeaders([
      ...path.headers,
      cloneMessageHeader(header),
    ]),
    messageProofs: Object.freeze([
      ...path.messageProofs,
      generationMessageReadProofFromHeader(header),
    ]),
  })
}

async function resolveGenerationPromptPathProof(
  ctx: MutationContext,
  chatId: ChatId,
  proof: GenerationPromptPathProof,
  path: ValidatedGenerationPromptPath,
): Promise<ResolvedGenerationPromptPath> {
  const { headers } = path
  const requirement = proof.requirement
  if (requirement.surface === 'chat' && requirement.chatId !== chatId) {
    throw new GenerationPlanningSeedChangedError(chatId)
  }
  let targetHeader: MessageHeaderRow | undefined
  let leafId: MessageId | null = null
  if (requirement.target.kind !== 'root') {
    targetHeader = await ctx.getMessageHeader(requirement.target.messageId)
    if (
      !targetHeader ||
      targetHeader.chatId !== chatId ||
      targetHeader.deleted ||
      (requirement.target.role !== 'any' && targetHeader.role !== requirement.target.role)
    ) {
      throw new GenerationPlanningSeedChangedError(chatId)
    }
    leafId = requirement.target.kind === 'exclude' ? targetHeader.parentId : targetHeader.id
  }
  if (
    proof.claim.chatId !== chatId ||
    proof.claim.leafId !== leafId ||
    (leafId === null ? headers.length !== 0 : headers.at(-1)?.id !== leafId)
  ) {
    throw new GenerationPlanningSeedChangedError(chatId)
  }
  let slot: ChildListState | undefined
  if (requirement.childSlot !== 'none') {
    slot = await ctx.getChildList(chatId, leafId)
    if (requirement.childSlot === 'empty' && slot.liveCount > 0) {
      throw new ExpectedLeafChangedError(
        chatId,
        leafId,
        leafId === null ? 'root-not-empty' : 'has-live-child',
        slot.firstLiveChildId ?? undefined,
      )
    }
    const claimedSlot = proof.claim.placementSlot
    if (
      !claimedSlot ||
      claimedSlot.parentId !== leafId ||
      claimedSlot.slotVersion !== slot.version ||
      claimedSlot.liveCount !== slot.liveCount ||
      claimedSlot.nextSiblingIndex !== slot.nextSiblingIndex
    ) {
      throw new GenerationPlanningSeedChangedError(chatId)
    }
  } else if (proof.claim.placementSlot !== null) {
    throw new GenerationPlanningSeedChangedError(chatId)
  }
  return {
    ...path,
    leafId,
    ...(targetHeader ? { targetHeader } : {}),
    ...(slot ? { slot } : {}),
  }
}

function requiredPromptPathTarget(
  path: ResolvedGenerationPromptPath,
  chatId: ChatId,
): MessageHeaderRow {
  if (!path.targetHeader) throw new GenerationPlanningSeedChangedError(chatId)
  return path.targetHeader
}

function semanticEffectKindsForMutationFacts(
  facts: BrowserCommandMutationFacts,
): ReadonlySet<WorkspaceDependency['kind']> {
  const kinds = new Set<WorkspaceDependency['kind']>(
    facts.invalidations.map((dependency) => dependency.kind),
  )
  if (facts.chatStates.length > 0) {
    kinds.add('chat')
  }
  if (sidebarChatIdsForMutationFacts(facts).length > 0) kinds.add('sidebar')
  for (const fact of facts.chatStates) {
    if (!fact.initialExists && fact.chat) {
      kinds.add('message-header')
      kinds.add('message-body')
      kinds.add('message-preview')
      kinds.add('child-slot')
    }
  }
  if (facts.attachmentRows.length > 0 || facts.attachmentReferenceStates.length > 0) {
    kinds.add('attachment')
  }
  if (facts.childSlots.length > 0) kinds.add('child-slot')
  for (const revision of facts.messageRevisions) {
    kinds.add('message-header')
    if (!revision.before || revision.before.bodyVersion !== revision.header.bodyVersion) {
      kinds.add('message-body')
      kinds.add('message-preview')
    }
    if (
      !revision.before ||
      revision.before.parentId !== revision.header.parentId ||
      revision.before.siblingIndex !== revision.header.siblingIndex ||
      revision.before.deleted !== revision.header.deleted
    ) {
      kinds.add('child-slot')
    }
  }
  return kinds
}

function semanticDependenciesForMutationFacts(
  facts: BrowserCommandMutationFacts,
): readonly WorkspaceDependency[] {
  const chatIds = facts.chatStates.map((fact) => fact.chatId)
  const sidebarChatIds = sidebarChatIdsForMutationFacts(facts)
  return normalizeWorkspaceDependencies([
    ...facts.invalidations,
    ...(chatIds.length > 0 ? [{ kind: 'chat' as const, chatIds }] : []),
    ...(sidebarChatIds.length > 0 ? [{ kind: 'sidebar' as const, chatIds: sidebarChatIds }] : []),
    ...facts.childSlots.map(({ state }) => ({
      kind: 'child-slot' as const,
      chatId: state.chatId,
      parentIds: [state.parentId],
    })),
    ...facts.messageRevisions.flatMap((revision) => [
      {
        kind: 'message-header' as const,
        chatId: revision.header.chatId,
        messageIds: [revision.header.id],
      },
      ...(!revision.before || revision.before.bodyVersion !== revision.header.bodyVersion
        ? [
            {
              kind: 'message-body' as const,
              chatId: revision.header.chatId,
              messageIds: [revision.header.id],
            },
            {
              kind: 'message-preview' as const,
              chatId: revision.header.chatId,
              messageIds: [revision.header.id],
            },
          ]
        : []),
    ]),
  ])
}

function sidebarChatIdsForMutationFacts(facts: BrowserCommandMutationFacts): readonly ChatId[] {
  const chatIds = new Set(facts.chatStates.map(({ chatId }) => chatId))
  return [
    ...new Set(
      facts.physicalMutations.flatMap((mutation) => {
        if (mutation.tableName !== 'chatSidebarRows' || typeof mutation.key !== 'string') return []
        return chatIds.has(mutation.key) ? [mutation.key as ChatId] : []
      }),
    ),
  ].sort()
}

class BrowserCommandCommit implements BrowserCommandSessionPort {
  private readonly committedMutationTables = new Set<string>()
  private readonly physicalMutationsByAddress = new Map<string, BrowserCommandPhysicalMutation>()
  private readonly physicalOwnerScopesById = new Map<string, BrowserCommandPhysicalOwnerScope>()
  private readonly internalMutationEvidence = new Set<string>()
  private readonly messageRevisionsById = new Map<
    MessageId,
    {
      readonly before?: MessageHeaderRow
      readonly header: MessageHeaderRow
      readonly structuralVersion: number
      readonly presentation?: MessagePresentation
    }
  >()
  private readonly childSlotsById = new Map<string, WorkspaceLocalChildSlotAccumulator>()
  private readonly chatsById = new Map<ChatId, Chat | null>()
  private readonly initialChatExistsById = new Map<ChatId, boolean>()
  private readonly attachmentReferenceStates = new Map<AttachmentId, AttachmentReferenceStateFact>()
  private readonly attachmentRowsById = new Map<AttachmentId, boolean>()
  private readonly inexactAttachmentReferenceIds = new Set<AttachmentId>()
  private readonly attachmentReapRequestIds = new Set<AttachmentId>()
  private readonly extraInvalidations: WorkspaceDependency[] = []
  private readonly db: Dexie
  private readonly lockSession: AuthoritativeCommandLockSession
  private readonly workspaceId: string
  private readonly replacementEpoch: number
  readonly command: WorkspaceCommand
  readonly operationKind: WorkspaceCommand['kind']
  private readonly semanticOperationKind: SemanticOperationKind
  private commandLifetimeReceipt: SemanticOperationCommandLifetimeReceipt
  private executionMode: 'legacy' | 'semantic' | undefined
  private semanticOperationCommitted = false
  readonly commitId: string

  constructor(
    db: Dexie,
    lockSession: AuthoritativeCommandLockSession,
    workspaceId: string,
    replacementEpoch: number,
    commitId: string,
    command: WorkspaceCommand,
    semanticOperationKind: SemanticOperationKind,
    commandLifetimeReceipt: SemanticOperationCommandLifetimeReceipt,
  ) {
    this.db = db
    this.lockSession = lockSession
    this.workspaceId = workspaceId
    this.replacementEpoch = replacementEpoch
    this.commitId = commitId
    this.command = command
    this.operationKind = command.kind
    this.semanticOperationKind = semanticOperationKind
    this.commandLifetimeReceipt = commandLifetimeReceipt
  }

  executeSemanticOperation<Tables extends PhysicalStorageTableName, ResourceInput, Receipt, T>(
    descriptor: SemanticOperationDescriptor<SemanticOperationKind, Tables, ResourceInput, Receipt>,
    resourceInput: ResourceInput,
    operation: SemanticOperationRunner<Tables, T, Receipt>,
  ): Promise<T> {
    const mismatch = this.semanticOperationMismatch(descriptor)
    if (mismatch) return Promise.reject(mismatch)
    this.executionMode = 'semantic'
    this.semanticOperationCommitted = true
    const resourceNames = semanticOperationResourceNames(descriptor, resourceInput)
    return this.lockSession.withResourceLocks(resourceNames, async (grant) => {
      return this.runTransaction(grant, descriptor.transaction, operation, {
        descriptor,
        resourceInput,
        unwrap: (execution) => semanticOperationExecutionParts<T, Receipt>(execution),
      })
    })
  }

  completeSemanticOperation<Tables extends PhysicalStorageTableName, ResourceInput, Receipt, T>(
    descriptor: SemanticOperationDescriptor<SemanticOperationKind, Tables, ResourceInput, Receipt>,
    resourceInput: ResourceInput,
    value: T,
    receipt: Receipt,
  ): Promise<T> {
    const mismatch = this.semanticOperationMismatch(descriptor)
    if (mismatch) return Promise.reject(mismatch)
    this.executionMode = 'semantic'
    this.semanticOperationCommitted = true
    const executableReceipt = attachSemanticOperationPhysicalIo(
      attachSemanticOperationExactPhysicalReads(
        receipt,
        this.commandLifetimeReceipt.exactPhysicalReads,
      ),
      undefined,
      this.commandLifetimeReceipt.physicalReads,
    )
    assertSemanticOperationReplay(descriptor, resourceInput, executableReceipt)
    assertSemanticOperationExactInvalidations(
      descriptor,
      resourceInput,
      [],
      false,
      executableReceipt,
    )
    assertSemanticOperationExactPhysicalMutations(
      descriptor,
      resourceInput,
      [],
      0,
      executableReceipt,
    )
    assertSemanticOperationExactPhysicalReads(
      descriptor,
      resourceInput,
      this.commandLifetimeReceipt.physicalReads,
      this.commandLifetimeReceipt.physicalReads.length > 0,
      executableReceipt,
    )
    assertSemanticOperationExactPhysicalWrites(
      descriptor,
      resourceInput,
      [],
      false,
      executableReceipt,
    )
    return Promise.resolve(value)
  }

  async readSemanticOperationPreflight<Tables extends PhysicalStorageTableName, T>(
    plan: PhysicalTransactionPlan<Tables>,
    operation: (tx: FencedTransaction<Tables>) => Promise<T> | T,
    exactPhysicalReads?: (
      value: T,
    ) => readonly (SemanticOperationExactPhysicalRead & { readonly tableName: Tables })[],
  ): Promise<T> {
    assertSemanticOperationCommandLifetimeReceipt(this.commandLifetimeReceipt, {
      workspaceId: this.workspaceId,
      replacementEpoch: this.replacementEpoch,
      databaseName: this.db.name,
    })
    if (this.executionMode !== undefined || this.semanticOperationCommitted) {
      throw new Error('SemanticOperationPreflightAfterExecution')
    }
    const result = await this.db.transaction(
      'r',
      plan.tableNames.map((tableName) => this.db.table(tableName)),
      async (tx) =>
        runBrowserCommandTransaction(
          tx,
          (transaction) => operation(bindFencedTransaction(transaction, plan)),
          { observePhysicalReads: true, observePhysicalWrites: true },
        ),
    )
    assertPhysicalTransactionTablesDeclared(plan, result.facts.tableNames)
    if (
      result.facts.successfulMutations !== 0 ||
      result.facts.physicalMutations.length !== 0 ||
      result.facts.physicalWrites.length !== 0 ||
      result.facts.invalidations.length !== 0
    ) {
      throw new Error('SemanticOperationPreflightMutationForbidden')
    }
    this.commandLifetimeReceipt = exactPhysicalReads
      ? semanticOperationCommandLifetimeReceiptWithPreflight(
          this.commandLifetimeReceipt,
          result.facts.physicalReads as readonly SemanticOperationPhysicalRead[],
          exactPhysicalReads(result.value),
        )
      : semanticOperationCommandLifetimeReceiptWithPhysicalReads(
          this.commandLifetimeReceipt,
          result.facts.physicalReads as readonly SemanticOperationPhysicalRead[],
        )
    return result.value
  }

  private semanticOperationMismatch<
    Tables extends PhysicalStorageTableName,
    ResourceInput,
    Receipt,
  >(
    descriptor: SemanticOperationDescriptor<SemanticOperationKind, Tables, ResourceInput, Receipt>,
  ): Error | undefined {
    assertSemanticOperationCommandLifetimeReceipt(this.commandLifetimeReceipt, {
      workspaceId: this.workspaceId,
      replacementEpoch: this.replacementEpoch,
      databaseName: this.db.name,
    })
    if (descriptor.operationKind !== this.semanticOperationKind) {
      return new Error(
        `SemanticOperationKindMismatch:${this.semanticOperationKind}:${descriptor.operationKind}`,
      )
    }
    if (this.executionMode === 'legacy') {
      return new Error('SemanticOperationMixedWithLegacyTransaction')
    }
    if (this.semanticOperationCommitted) return new Error('SemanticOperationAlreadyCommitted')
    return undefined
  }

  withLocks<T>(
    resourceNames: readonly string[],
    operation: (locked: BrowserLockedCommandPort) => Promise<T> | T,
  ): Promise<T> {
    if (this.executionMode === 'semantic') {
      return Promise.reject(new Error('LegacyTransactionMixedWithSemanticOperation'))
    }
    this.executionMode = 'legacy'
    return this.lockSession.withResourceLocks(resourceNames, async (grant) => {
      let active = true
      const locked: BrowserLockedCommandPort = Object.freeze({
        runTransaction: <Tables extends PhysicalStorageTableName, Result>(
          plan: PhysicalTransactionPlan<Tables>,
          transactionOperation: (tx: FencedTransaction<Tables>) => Promise<Result> | Result,
        ) => {
          if (!active) return Promise.reject(new Error('BrowserLockedCommandPortExpired'))
          return this.runTransaction(grant, plan, transactionOperation)
        },
      })
      try {
        return await operation(locked)
      } finally {
        active = false
      }
    })
  }

  private async runTransaction<
    Tables extends PhysicalStorageTableName,
    RawResult,
    ResourceInput = never,
    Receipt = undefined,
    PublicResult = RawResult,
  >(
    grant: LockGrant,
    plan: PhysicalTransactionPlan<Tables>,
    operation: (tx: FencedTransaction<Tables>) => Promise<RawResult> | RawResult,
    semanticOperation?: {
      readonly descriptor: SemanticOperationDescriptor<
        SemanticOperationKind,
        Tables,
        ResourceInput,
        Receipt
      >
      readonly resourceInput: ResourceInput
      unwrap(value: RawResult): { readonly value: PublicResult; readonly receipt: Receipt }
    },
  ): Promise<PublicResult> {
    const committed = await grant.runTransaction(this.db, plan.tableNames, async (tx) => {
      registerPhysicalMutationTransaction(tx)
      const result = await runBrowserCommandTransaction(
        tx,
        (transaction) => {
          const fencedTransaction = bindFencedTransaction(transaction, plan)
          return collectSemanticOperationPhysicalWrites(
            fencedTransaction,
            semanticOperation?.descriptor.exactPhysicalWrites?.receiptSource,
            () => operation(fencedTransaction),
          )
        },
        {
          observePhysicalReads: semanticOperation?.descriptor.exactPhysicalReads !== undefined,
          observePhysicalWrites: semanticOperation?.descriptor.exactPhysicalWrites !== undefined,
        },
      )
      assertPhysicalTransactionTablesDeclared(plan, result.facts.tableNames)
      if (semanticOperation) {
        const { descriptor, resourceInput, unwrap } = semanticOperation
        const execution = unwrap(result.value.value)
        const physicalReads = [
          ...this.commandLifetimeReceipt.physicalReads,
          ...result.facts.physicalReads,
        ]
        const receipt = attachSemanticOperationPhysicalIo(
          attachSemanticOperationExactPhysicalReads(
            execution.receipt,
            this.commandLifetimeReceipt.exactPhysicalReads,
          ),
          result.value.fragment,
          physicalReads,
        )
        const tableNames = new Set(result.facts.tableNames)
        const didMutateStorage = result.facts.successfulMutations > 0
        assertSemanticOperationReplay(descriptor, resourceInput, receipt)
        assertSemanticOperationWrites(descriptor, tableNames, didMutateStorage)
        assertSemanticOperationEffectKinds(
          descriptor,
          semanticEffectKindsForMutationFacts(result.facts),
          tableNames,
          didMutateStorage,
        )
        assertSemanticOperationExactInvalidations(
          descriptor,
          resourceInput,
          semanticDependenciesForMutationFacts(result.facts),
          didMutateStorage,
          receipt,
        )
        assertSemanticOperationExactPhysicalMutations(
          descriptor,
          resourceInput,
          result.facts.physicalMutations,
          result.facts.successfulMutations,
          receipt,
        )
        assertSemanticOperationExactPhysicalReads(
          descriptor,
          resourceInput,
          physicalReads,
          true,
          receipt,
        )
        assertSemanticOperationExactPhysicalWrites(
          descriptor,
          resourceInput,
          result.facts.physicalWrites,
          true,
          receipt,
        )
        return { value: execution.value, facts: result.facts }
      }
      return {
        value: result.value.value as unknown as PublicResult,
        facts: result.facts,
      }
    })
    this.recordCommittedMutationFacts(committed.facts)
    return committed.value
  }

  private recordCommittedMutationFacts(facts: BrowserCommandMutationFacts): void {
    for (const tableName of facts.tableNames) this.committedMutationTables.add(tableName)
    for (const scope of facts.physicalOwnerScopes) {
      const previous = this.physicalOwnerScopesById.get(scope.id)
      if (previous && !sameValue(previous, scope)) {
        throw new Error(`BrowserCommandPhysicalOwnerScopeConflict:${scope.id}`)
      }
      this.physicalOwnerScopesById.set(scope.id, structuredClone(scope))
    }
    for (const mutation of facts.physicalMutations) {
      this.physicalMutationsByAddress.set(mutation.address, structuredClone(mutation))
    }
    for (const address of facts.internalMutationEvidence) {
      this.internalMutationEvidence.add(address)
    }
    for (const invalidation of facts.invalidations) this.extraInvalidations.push(invalidation)
    for (const fact of facts.chatStates) {
      if (!this.initialChatExistsById.has(fact.chatId)) {
        this.initialChatExistsById.set(fact.chatId, fact.initialExists)
      }
      this.chatsById.set(fact.chatId, fact.chat ? structuredClone(fact.chat) : null)
    }
    for (const fact of facts.attachmentRows) {
      this.attachmentRowsById.set(fact.attachmentId, fact.exists)
    }
    this.accumulateMessageRevisions(facts.messageRevisions)
    this.accumulateChildSlots(facts.childSlots)
    for (const fact of facts.attachmentReferenceStates) {
      if (
        fact.final.exists &&
        fact.final.refCount === 0 &&
        (!fact.initial.exists || fact.initial.refCount > 0)
      ) {
        this.attachmentReapRequestIds.add(fact.attachmentId)
      }
      const current = this.attachmentReferenceStates.get(fact.attachmentId)
      if (!current) {
        this.attachmentReferenceStates.set(fact.attachmentId, fact)
        continue
      }
      if (this.inexactAttachmentReferenceIds.has(fact.attachmentId)) {
        this.attachmentReferenceStates.set(fact.attachmentId, {
          attachmentId: fact.attachmentId,
          initial: current.initial,
          final: fact.final,
          projectionChanged: current.projectionChanged || fact.projectionChanged,
        })
        continue
      }
      if (
        current.final.exists !== fact.initial.exists ||
        current.final.refCount !== fact.initial.refCount
      ) {
        this.attachmentReferenceStates.set(fact.attachmentId, {
          attachmentId: fact.attachmentId,
          initial: current.initial,
          final: fact.final,
          projectionChanged: current.projectionChanged || fact.projectionChanged,
        })
        this.inexactAttachmentReferenceIds.add(fact.attachmentId)
        continue
      }
      this.attachmentReferenceStates.set(fact.attachmentId, {
        attachmentId: fact.attachmentId,
        initial: current.initial,
        final: fact.final,
        projectionChanged: current.projectionChanged || fact.projectionChanged,
      })
    }
  }

  private accumulateMessageRevisions(
    revisions: readonly BrowserCommandMessageRevisionFact[],
  ): void {
    for (const revision of revisions) {
      const { header } = revision
      const current = this.messageRevisionsById.get(header.id)
      if (
        current &&
        (!revision.before || !sameMessageHeaderValue(current.header, revision.before))
      ) {
        throw new Error(`BrowserCommandMessageRevisionTransitionBroken:${header.id}`)
      }
      const retainedPresentation =
        revision.presentation ??
        (current?.presentation?.bodyVersion === header.bodyVersion
          ? current.presentation
          : undefined)
      this.messageRevisionsById.set(header.id, {
        ...(current
          ? current.before
            ? { before: cloneMessageHeader(current.before) }
            : {}
          : revision.before
            ? { before: cloneMessageHeader(revision.before) }
            : {}),
        header: cloneMessageHeader(header),
        structuralVersion: revision.structuralVersion,
        ...(retainedPresentation ? { presentation: structuredClone(retainedPresentation) } : {}),
      })
    }
  }

  private accumulateChildSlots(evidenceRows: readonly WorkspaceLocalChildSlotEvidence[]): void {
    for (const evidence of evidenceRows) {
      let accumulator = this.childSlotsById.get(evidence.state.id)
      if (!accumulator) {
        accumulator = new WorkspaceLocalChildSlotAccumulator()
        this.childSlotsById.set(evidence.state.id, accumulator)
      }
      accumulator.add(evidence)
    }
  }

  childSlots(excludedChatIds: ReadonlySet<ChatId>): WorkspaceLocalChildSlotEvidence[] {
    return [...this.childSlotsById.values()].flatMap((accumulator) => {
      const evidence = accumulator.materialize()
      return evidence && !excludedChatIds.has(evidence.state.chatId) ? [evidence] : []
    })
  }

  messageRevisions(excludedChatIds: ReadonlySet<ChatId>): WorkspaceLocalMessageRevision[] {
    return [...this.messageRevisionsById.values()].flatMap((revision) => {
      if (excludedChatIds.has(revision.header.chatId)) return []
      const presentation =
        revision.presentation?.bodyVersion === revision.header.bodyVersion
          ? {
              ...structuredClone(revision.presentation),
              header: cloneMessageHeader(revision.header),
              message: rebaseHydratedMessageHeader(revision.presentation.message, revision.header),
            }
          : undefined
      return [
        {
          ...(revision.before ? { before: cloneMessageHeader(revision.before) } : {}),
          header: cloneMessageHeader(revision.header),
          structuralVersion: revision.structuralVersion,
          changed: {
            structure:
              !revision.before || !sameMessageHeaderStructure(revision.before, revision.header),
            body: !revision.before || revision.before.bodyVersion !== revision.header.bodyVersion,
          },
          ...(presentation ? { presentation } : {}),
        },
      ]
    })
  }

  messageDelta(revisions: readonly CommittedMessageRevision[]): WorkspaceDelta {
    return workspaceDeltaForMessageRevisions(revisions)
  }

  materializeChatEvidence(): {
    readonly facts: readonly WorkspaceDeltaFact[]
    readonly invalidations: readonly WorkspaceDependency[]
    readonly receiptChats: readonly Chat[]
    readonly constructions: readonly Chat[]
    readonly constructedChatIds: ReadonlySet<ChatId>
    readonly deletedChatIds: ReadonlySet<ChatId>
  } {
    const facts: WorkspaceDeltaFact[] = []
    const ordinaryChatIds: ChatId[] = []
    const receiptChats: Chat[] = []
    const constructions: Chat[] = []
    const constructedChatIds = new Set<ChatId>()
    const deletedChatIds = new Set<ChatId>()
    const sidebarChatIds = new Set(
      [...this.physicalMutationsByAddress.values()].flatMap((mutation) =>
        mutation.tableName === 'chatSidebarRows' && typeof mutation.key === 'string'
          ? [mutation.key as ChatId]
          : [],
      ),
    )
    const entries = [...this.chatsById.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    )
    for (const [chatId, finalChat] of entries) {
      const initialExists = this.initialChatExistsById.get(chatId)
      if (initialExists === undefined) {
        throw new Error(`BrowserCommandChatInitialStateMissing:${chatId}`)
      }
      if (!finalChat) {
        if (!initialExists) continue
        facts.push({ kind: 'chat-deleted', chatId })
        if (sidebarChatIds.has(chatId)) {
          facts.push({ kind: 'sidebar-row-deleted', chatId })
        }
        deletedChatIds.add(chatId)
        ordinaryChatIds.push(chatId)
        continue
      }
      if (!initialExists) {
        facts.push({ kind: 'conversation-created', chatId })
        constructions.push(structuredClone(finalChat))
        constructedChatIds.add(chatId)
        continue
      }
      if (sidebarChatIds.has(chatId)) {
        facts.push({ kind: 'sidebar-row-changed', chatId })
      }
      ordinaryChatIds.push(chatId)
      receiptChats.push(structuredClone(finalChat))
    }
    return Object.freeze({
      facts: Object.freeze(facts),
      invalidations: Object.freeze(
        ordinaryChatIds.length === 0
          ? []
          : [
              Object.freeze({ kind: 'chat' as const, chatIds: ordinaryChatIds }),
              ...(sidebarChatIds.size > 0
                ? [
                    Object.freeze({
                      kind: 'sidebar' as const,
                      chatIds: ordinaryChatIds.filter((chatId) => sidebarChatIds.has(chatId)),
                    }),
                  ]
                : []),
            ],
      ),
      receiptChats: Object.freeze(receiptChats),
      constructions: Object.freeze(constructions),
      constructedChatIds,
      deletedChatIds,
    })
  }

  attachmentFacts(): WorkspaceDeltaFact[] {
    return [...this.attachmentRowsById]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([attachmentId, exists]) => ({
        kind: exists ? ('attachment-row-changed' as const) : ('attachment-row-deleted' as const),
        attachmentId,
      }))
  }

  assertPhysicalEvidenceCoverage(
    delta: WorkspaceDelta,
    receipt: WorkspaceLocalReceipt,
    terminalChatIds: ReadonlySet<ChatId>,
  ): void {
    assertPhysicalMutationEvidenceCoverage(
      [...this.physicalMutationsByAddress.values()],
      delta,
      receipt,
      terminalChatIds,
      this.physicalOwnerScopesById,
      this.internalMutationEvidence,
    )
  }

  assertReplacementEpoch(expectedReplacementEpoch: number): void {
    if (expectedReplacementEpoch !== this.replacementEpoch) {
      throw new WorkspaceReplacementFenceError()
    }
  }

  finish(): {
    fence: WorkspaceFence
    didMutateStorage: boolean
    extraInvalidations: readonly WorkspaceDependency[]
  } {
    const attachmentRefreshIds = new Set<AttachmentId>(this.inexactAttachmentReferenceIds)
    for (const fact of this.attachmentReferenceStates.values()) {
      if (fact.projectionChanged) attachmentRefreshIds.add(fact.attachmentId)
    }
    const attachmentInvalidations: WorkspaceDependency[] =
      attachmentRefreshIds.size === 0
        ? []
        : [
            {
              kind: 'attachment',
              attachmentIds: [...attachmentRefreshIds],
            },
          ]
    if (this.attachmentReapRequestIds.size > 0) {
      attachmentInvalidations.push({ kind: 'storage-maintenance', tasks: ['reap-attachments'] })
    }
    return {
      fence: {
        workspaceId: this.workspaceId,
        replacementEpoch: this.replacementEpoch,
      },
      didMutateStorage: this.committedMutationTables.size > 0,
      extraInvalidations: [...this.extraInvalidations, ...attachmentInvalidations],
    }
  }
}

function sortTags(rows: ChatTag[]): ChatTag[] {
  return rows.sort((left, right) => {
    const byName = left.nameLower.localeCompare(right.nameLower)
    return byName !== 0 ? byName : left.id.localeCompare(right.id)
  })
}

function configurationPreferencesFromValues(
  values: ReadonlyMap<string, unknown>,
): ConfigurationPreferencesProjection {
  return {
    global: globalPreferencesFromStored(values),
    rendering: normalizeRenderingPreferences(values.get(RENDERING_PREFERENCES_KEY)),
    sidebarSortMode: parseSidebarSortMode(values.get(SIDEBAR_SORT_SETTING_KEY)),
    collapsedFolderIds: normalizeCollapsedSidebarFolderIds(
      values.get(SIDEBAR_COLLAPSED_FOLDERS_SETTING_KEY),
    ),
    imageAllowlist: customImageOriginsFromStored(values.get(IMAGE_ALLOWLIST_KEY)),
    samplePromptsDismissed: values.get(SAMPLE_PROMPTS_DISMISSED_KEY) === true,
  }
}

async function readDefaultConfigurationPresetId(
  tx: Transaction,
  profileId: ProfileId | null,
): Promise<PresetId | null> {
  const table = tx.table<ConfigurationPresetCatalogProjectionRow, PresetId>(
    'configurationPresetCatalogRows',
  )
  const scoped = profileId
    ? await table
        .where('[connectionProfileId+activeKey+defaultTier+defaultTime+id]')
        .between(...scalarCompoundIndexBetween([profileId, 1], [profileId, 1], 5))
        .first()
    : undefined
  if (scoped) return scoped.id
  const global = await table
    .where('[activeKey+defaultTier+defaultTime+id]')
    .between(...scalarCompoundIndexBetween([1], [1], 4))
    .first()
  return global?.id ?? null
}

type ConfigurationCatalogIndexKey = Array<IndexableTypePart>
type ConfigurationCatalogCursorKey = Array<string | number>

interface ConfigurationCatalogIndexCursor {
  readonly revision: number
  readonly key: ConfigurationCatalogCursorKey
}

function configurationCatalogAddressIds(
  request: ConfigurationCatalogPageRequest,
): readonly string[] {
  const rawIds = request.addressedIds ?? []
  if (rawIds.length > CONFIGURATION_CATALOG_MAX_ADDRESSED_ROWS) {
    throw new Error('ConfigurationCatalogAddressLimitExceeded')
  }
  return [...new Set(rawIds)]
}

function configurationCatalogPageLimit(request: ConfigurationCatalogPageRequest): number {
  if (!Number.isSafeInteger(request.limit) || request.limit < 1) {
    throw new Error('ConfigurationCatalogPageLimitInvalid')
  }
  return Math.min(CONFIGURATION_CATALOG_MAX_PAGE_SIZE, request.limit)
}

function projectConfigurationProfileCatalogRow(
  stored: ConfigurationProfileCatalogProjectionRow | undefined,
): ConfigurationProfileCatalogRow | null {
  if (stored?.activeKey !== 1) return null
  return projectAddressedConfigurationProfileCatalogRow(stored)
}

function projectAddressedConfigurationProfileCatalogRow(
  stored: ConfigurationProfileCatalogProjectionRow | undefined,
): ConfigurationProfileCatalogRow | null {
  if (!stored) return null
  const {
    activeKey: _activeKey,
    managerTier: _managerTier,
    mruSortKey: _mruSortKey,
    nameSortKey: _nameSortKey,
    ...row
  } = stored
  return row
}

function projectConfigurationConnectionManagerProfileRow(
  stored: ConfigurationProfileCatalogProjectionRow | undefined,
): ConfigurationConnectionManagerRow | null {
  if (!stored) return null
  return {
    id: stored.id,
    name: stored.name,
    kind: stored.kind,
    archived: stored.archived === true,
    presetCount: 0,
    activePresetCount: 0,
    chatCount: 0,
    activeChatCount: 0,
  }
}

function projectConfigurationPromptPresetCatalogRow(
  stored: ConfigurationPromptPresetCatalogProjectionRow | undefined,
  kind: PromptPresetKind,
): ConfigurationPromptPresetCatalogRow | null {
  if (stored?.kind !== kind) return null
  const { nameSortKey: _nameSortKey, lastUsedAt: _lastUsedAt, ...row } = stored
  return row
}

function projectConfigurationPresetCatalogRow(
  stored: ConfigurationPresetCatalogProjectionRow | undefined,
): ConfigurationPresetCatalogRow | null {
  if (stored?.activeKey !== 1) return null
  const {
    activeKey: _activeKey,
    defaultTier: _defaultTier,
    defaultTime: _defaultTime,
    archived: _archived,
    lastUsedAt: _lastUsedAt,
    ...row
  } = stored
  return row
}

function encodeConfigurationCatalogCursor(
  catalog: string,
  revision: number,
  key: readonly (string | number)[],
): string {
  return `configuration-catalog-v3:${catalog}:${encodeURIComponent(
    JSON.stringify({ revision, key }),
  )}`
}

function decodeConfigurationCatalogCursor(
  cursor: string | undefined,
  catalog: string,
  keyLength: number,
): ConfigurationCatalogIndexCursor | undefined {
  if (!cursor) return undefined
  const prefix = `configuration-catalog-v3:${catalog}:`
  if (!cursor.startsWith(prefix)) throw new Error('ConfigurationCatalogCursorInvalid')
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(cursor.slice(prefix.length)))
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !Number.isSafeInteger((parsed as { revision?: unknown }).revision) ||
      (parsed as { revision: number }).revision < 0 ||
      !Array.isArray((parsed as { key?: unknown }).key) ||
      (parsed as { key: unknown[] }).key.length !== keyLength ||
      (parsed as { key: unknown[] }).key.some(
        (value) => typeof value !== 'string' && typeof value !== 'number',
      )
    ) {
      throw new Error('ConfigurationCatalogCursorInvalid')
    }
    return parsed as ConfigurationCatalogIndexCursor
  } catch (error) {
    if (error instanceof Error && error.message === 'ConfigurationCatalogCursorInvalid') throw error
    throw new Error('ConfigurationCatalogCursorInvalid', { cause: error })
  }
}

async function readConfigurationCatalogIndexPage<Stored, Row>(input: {
  readonly table: Table<Stored, string>
  readonly index: string
  readonly catalog: string
  readonly lower: ConfigurationCatalogIndexKey
  readonly upper: ConfigurationCatalogIndexKey
  readonly request: ConfigurationCatalogPageRequest
  readonly state: ConfigurationCatalogStateRow
  readonly addressedRows: readonly ConfigurationCatalogAddress<Row>[]
  readonly keyFor: (row: Stored) => ConfigurationCatalogCursorKey
  readonly project: (row: Stored) => Row | null
  readonly signal: AbortSignal | undefined
}): Promise<ConfigurationCatalogPage<Row>> {
  input.signal?.throwIfAborted()
  const rawAnchorIds = input.request.anchorIds ?? []
  if (rawAnchorIds.length > CONFIGURATION_CATALOG_MAX_REFRESH_ANCHORS) {
    throw new Error('ConfigurationCatalogAnchorLimitExceeded')
  }
  const anchorIds = [...new Set(rawAnchorIds)]
  if (input.request.cursor && anchorIds.length > 0) {
    throw new Error('ConfigurationCatalogBoundaryAmbiguous')
  }
  if (anchorIds.length > 0 && input.request.direction !== 'forward') {
    throw new Error('ConfigurationCatalogAnchorDirectionInvalid')
  }
  const cursor = decodeConfigurationCatalogCursor(
    input.request.cursor,
    input.catalog,
    input.lower.length,
  )
  if (cursor && cursor.revision !== input.state.revision) {
    return Object.freeze({
      kind: 'stale-cursor',
      catalogRevision: input.state.revision,
      exactCount: input.state.exactCount,
      addressedRows: input.addressedRows,
    })
  }
  let anchorKey: ConfigurationCatalogCursorKey | undefined
  let anchorHasPrevious = false
  if (anchorIds.length > 0) {
    const anchors = await input.table.bulkGet(anchorIds)
    const anchor = anchors.find(
      (row): row is Stored => row !== undefined && input.project(row) !== null,
    )
    if (!anchor) {
      return Object.freeze({
        kind: 'anchor-missing',
        catalogRevision: input.state.revision,
        exactCount: input.state.exactCount,
        addressedRows: input.addressedRows,
      })
    }
    anchorKey = input.keyFor(anchor)
    anchorHasPrevious =
      (await input.table
        .where(input.index)
        .between(input.lower, anchorKey, true, false)
        .limit(1)
        .count()) > 0
  }
  const limit = configurationCatalogPageLimit(input.request)
  const backward = input.request.direction === 'backward'
  const lower = backward ? input.lower : (anchorKey ?? cursor?.key ?? input.lower)
  const upper = backward ? (cursor?.key ?? input.upper) : input.upper
  const includeLower = backward || cursor === undefined
  const includeUpper = !backward || cursor === undefined
  let collection = input.table.where(input.index).between(lower, upper, includeLower, includeUpper)
  if (backward) collection = collection.reverse()
  const fetched = await collection.limit(limit + 1).toArray()
  input.signal?.throwIfAborted()
  const hasMore = fetched.length > limit
  const selected = fetched.slice(0, limit)
  if (backward) selected.reverse()
  const first = selected[0]
  const last = selected[selected.length - 1]
  return Object.freeze({
    kind: 'page',
    catalogRevision: input.state.revision,
    exactCount: input.state.exactCount,
    rows: Object.freeze(
      selected.map((stored) => {
        const row = input.project(stored)
        if (!row) throw new Error('ConfigurationCatalogProjectionInvalid')
        return row
      }),
    ),
    addressedRows: input.addressedRows,
    ...(first && (backward ? hasMore : cursor !== undefined || anchorHasPrevious)
      ? {
          previousCursor: encodeConfigurationCatalogCursor(
            input.catalog,
            input.state.revision,
            input.keyFor(first),
          ),
        }
      : {}),
    ...(last && (backward ? cursor !== undefined : hasMore)
      ? {
          nextCursor: encodeConfigurationCatalogCursor(
            input.catalog,
            input.state.revision,
            input.keyFor(last),
          ),
        }
      : {}),
  })
}

interface ConfigurationPresetOrderEntry {
  readonly presetId: PresetId
  readonly blockId: string
  readonly offset: number
}

async function readConfigurationPresetOrderPage(
  tx: Transaction,
  request: ConfigurationCatalogPageRequest,
  signal?: AbortSignal,
): Promise<ConfigurationPresetCatalogPage> {
  signal?.throwIfAborted()
  const state = await tx
    .table<PresetOrderStateRow, typeof PRESET_ORDER_STATE_ID>('presetOrderState')
    .get(PRESET_ORDER_STATE_ID)
  if (!state) throw new Error('PresetOrderStateMissing')
  const projections = tx.table<ConfigurationPresetCatalogProjectionRow, PresetId>(
    'configurationPresetCatalogRows',
  )
  const addressedIds = configurationCatalogAddressIds(request) as PresetId[]
  const addressed = await projections.bulkGet(addressedIds)
  const addressedRows = Object.freeze(
    addressedIds.map((id, index) => ({
      id,
      row: projectConfigurationPresetCatalogRow(addressed[index]),
    })),
  )
  const rawAnchorIds = request.anchorIds ?? []
  if (rawAnchorIds.length > CONFIGURATION_CATALOG_MAX_REFRESH_ANCHORS) {
    throw new Error('ConfigurationCatalogAnchorLimitExceeded')
  }
  const anchorIds = [...new Set(rawAnchorIds)] as PresetId[]
  if (request.cursor && anchorIds.length > 0) {
    throw new Error('ConfigurationCatalogBoundaryAmbiguous')
  }
  if (anchorIds.length > 0 && request.direction !== 'forward') {
    throw new Error('ConfigurationCatalogAnchorDirectionInvalid')
  }
  const cursor = decodeConfigurationCatalogCursor(request.cursor, 'presets', 3)
  if (cursor && cursor.revision !== state.revision) {
    return Object.freeze({
      kind: 'stale-cursor',
      catalogRevision: state.revision,
      exactCount: state.exactCount,
      addressedRows,
    })
  }
  const limit = configurationCatalogPageLimit(request)
  const backward = request.direction === 'backward'
  const blocks = tx.table<PresetOrderBlockRow, string>('presetOrderBlocks')
  const loaded = new Map<string, PresetOrderBlockRow>()
  const loadBlock = async (blockId: string): Promise<PresetOrderBlockRow> => {
    const cached = loaded.get(blockId)
    if (cached) return cached
    const block = await blocks.get(blockId)
    if (!block) throw new Error(`PresetOrderBlockMissing:${blockId}`)
    if (block.presetIds.length === 0) throw new Error(`PresetOrderBlockEmpty:${blockId}`)
    loaded.set(blockId, block)
    return block
  }

  let blockId: string | null
  let offset: number
  let anchorHasPrevious = false
  if (cursor) {
    const [rawBlockId, rawOffset, rawPresetId] = cursor.key
    if (
      typeof rawBlockId !== 'string' ||
      typeof rawOffset !== 'number' ||
      !Number.isSafeInteger(rawOffset) ||
      typeof rawPresetId !== 'string'
    ) {
      throw new Error('ConfigurationCatalogCursorInvalid')
    }
    const boundary = await loadBlock(rawBlockId)
    if (rawOffset < 0 || boundary.presetIds[rawOffset] !== rawPresetId) {
      throw new Error('ConfigurationCatalogCursorInvalid')
    }
    if (backward) {
      if (rawOffset > 0) {
        blockId = rawBlockId
        offset = rawOffset - 1
      } else {
        blockId = boundary.previousBlockId
        if (blockId) {
          const previous = await loadBlock(blockId)
          if (previous.nextBlockId !== boundary.id) throw new Error('PresetOrderLinkInvalid')
          offset = previous.presetIds.length - 1
        } else {
          offset = -1
        }
      }
    } else if (rawOffset + 1 < boundary.presetIds.length) {
      blockId = rawBlockId
      offset = rawOffset + 1
    } else {
      blockId = boundary.nextBlockId
      if (blockId) {
        const next = await loadBlock(blockId)
        if (next.previousBlockId !== boundary.id) throw new Error('PresetOrderLinkInvalid')
      }
      offset = 0
    }
  } else if (anchorIds.length > 0) {
    const [memberships, projectionsByAnchor] = await Promise.all([
      tx.table<PresetOrderMembershipRow, PresetId>('presetOrderMembership').bulkGet(anchorIds),
      projections.bulkGet(anchorIds),
    ])
    const anchorIndex = anchorIds.findIndex(
      (_, index) =>
        memberships[index] !== undefined &&
        projectConfigurationPresetCatalogRow(projectionsByAnchor[index]) !== null,
    )
    if (anchorIndex < 0) {
      return Object.freeze({
        kind: 'anchor-missing',
        catalogRevision: state.revision,
        exactCount: state.exactCount,
        addressedRows,
      })
    }
    const anchorId = anchorIds[anchorIndex] as PresetId
    const membership = memberships[anchorIndex]
    if (!membership) throw new Error(`PresetOrderMembershipMissing:${anchorId}`)
    const block = await loadBlock(membership.blockId)
    const anchorOffset = block.presetIds.indexOf(anchorId)
    if (anchorOffset < 0) throw new Error(`PresetOrderMembershipMismatch:${anchorId}`)
    blockId = block.id
    offset = anchorOffset
    anchorHasPrevious = anchorOffset > 0 || block.previousBlockId !== null
  } else {
    blockId = backward ? state.tailBlockId : state.headBlockId
    if (blockId && backward) offset = (await loadBlock(blockId)).presetIds.length - 1
    else offset = 0
  }

  const entries: ConfigurationPresetOrderEntry[] = []
  const visitedBlocks = new Set<string>()
  while (blockId && entries.length <= limit) {
    signal?.throwIfAborted()
    if (visitedBlocks.has(blockId)) throw new Error(`PresetOrderBlockCycle:${blockId}`)
    visitedBlocks.add(blockId)
    const block = await loadBlock(blockId)
    if (backward) {
      for (let index = offset; index >= 0 && entries.length <= limit; index -= 1) {
        const presetId = block.presetIds[index]
        if (!presetId) throw new Error(`PresetOrderBlockEntryMissing:${block.id}:${index}`)
        entries.push({ presetId, blockId: block.id, offset: index })
      }
      const previousBlockId = block.previousBlockId
      if (previousBlockId && entries.length <= limit) {
        const previous = await loadBlock(previousBlockId)
        if (previous.nextBlockId !== block.id) throw new Error('PresetOrderLinkInvalid')
        offset = previous.presetIds.length - 1
      }
      blockId = previousBlockId
    } else {
      for (
        let index = offset;
        index < block.presetIds.length && entries.length <= limit;
        index += 1
      ) {
        const presetId = block.presetIds[index]
        if (!presetId) throw new Error(`PresetOrderBlockEntryMissing:${block.id}:${index}`)
        entries.push({ presetId, blockId: block.id, offset: index })
      }
      const nextBlockId = block.nextBlockId
      if (nextBlockId && entries.length <= limit) {
        const next = await loadBlock(nextBlockId)
        if (next.previousBlockId !== block.id) throw new Error('PresetOrderLinkInvalid')
      }
      blockId = nextBlockId
      offset = 0
    }
  }
  const hasMore = entries.length > limit
  let selected = entries.slice(0, limit)
  if (backward) selected = selected.reverse()
  const storedRows = await projections.bulkGet(selected.map((entry) => entry.presetId))
  const rows = Object.freeze(
    storedRows.map((stored, index) => {
      const row = projectConfigurationPresetCatalogRow(stored)
      if (!row || row.id !== selected[index]?.presetId) {
        throw new Error(`PresetOrderProjectionMissing:${selected[index]?.presetId ?? 'unknown'}`)
      }
      return row
    }),
  )
  const first = selected[0]
  const last = selected.at(-1)
  return Object.freeze({
    kind: 'page',
    catalogRevision: state.revision,
    exactCount: state.exactCount,
    rows,
    addressedRows,
    ...(first && (backward ? hasMore : cursor !== undefined || anchorHasPrevious)
      ? {
          previousCursor: encodeConfigurationCatalogCursor('presets', state.revision, [
            first.blockId,
            first.offset,
            first.presetId,
          ]),
        }
      : {}),
    ...(last && (backward ? cursor !== undefined : hasMore)
      ? {
          nextCursor: encodeConfigurationCatalogCursor('presets', state.revision, [
            last.blockId,
            last.offset,
            last.presetId,
          ]),
        }
      : {}),
  })
}

interface ConfigurationDiscoveryStorageHeader {
  readonly profileRevision: string
  readonly payloadId: string
  readonly payloadByteLength: number
  readonly fetchedAt: number
}

function configurationDiscoveryPayloadToken(
  row: ConfigurationDiscoveryStorageHeader,
): ConfigurationDiscoveryPayloadToken {
  return {
    profileRevision: row.profileRevision,
    payloadId: row.payloadId,
    payloadByteLength: row.payloadByteLength,
    fetchedAt: row.fetchedAt,
  }
}

function configurationDiscoveryPayloadUnchanged(
  known: ConfigurationDiscoveryPayloadToken | undefined,
  current: ConfigurationDiscoveryPayloadToken,
): boolean {
  return (
    known?.profileRevision === current.profileRevision &&
    known.payloadId === current.payloadId &&
    known.payloadByteLength === current.payloadByteLength
  )
}

async function readConfigurationModelsPayload(
  tx: Transaction,
  key: [string, string],
  revisionKey: string,
  known: ConfigurationDiscoveryPayloadToken | undefined,
): Promise<ConfigurationDiscoveryPayloadProjection<CachedModelsRow>> {
  const stored = await tx.table<CachedModelsStorageRow, [string, string]>('models').get(key)
  if (!stored || stored.profileRevision !== revisionKey) return { kind: 'missing' }
  const token = configurationDiscoveryPayloadToken(stored)
  if (configurationDiscoveryPayloadUnchanged(known, token)) return { kind: 'unchanged', token }
  const row = await readDiscoveryCacheRow(tx, 'models', key)
  return row ? { kind: 'loaded', token, row } : { kind: 'missing' }
}

async function readConfigurationEndpointsPayload(
  tx: Transaction,
  key: [string, string],
  revisionKey: string,
  known: ConfigurationDiscoveryPayloadToken | undefined,
): Promise<ConfigurationDiscoveryPayloadProjection<CachedEndpointsRow>> {
  const stored = await tx.table<CachedEndpointsStorageRow, [string, string]>('endpoints').get(key)
  if (!stored || stored.profileRevision !== revisionKey) return { kind: 'missing' }
  const token = configurationDiscoveryPayloadToken(stored)
  if (configurationDiscoveryPayloadUnchanged(known, token)) return { kind: 'unchanged', token }
  const row = await readDiscoveryCacheRow(tx, 'endpoints', key)
  return row ? { kind: 'loaded', token, row } : { kind: 'missing' }
}

async function readConfigurationPrivacyPayload(
  tx: Transaction,
  key: [string, string],
  revisionKey: string,
  known: ConfigurationDiscoveryPayloadToken | undefined,
): Promise<ConfigurationDiscoveryPayloadProjection<CachedPrivacyPolicyRow>> {
  const stored = await tx
    .table<CachedPrivacyPolicyStorageRow, [string, string]>('privacyPolicies')
    .get(key)
  if (!stored || stored.profileRevision !== revisionKey) return { kind: 'missing' }
  const token = configurationDiscoveryPayloadToken(stored)
  if (configurationDiscoveryPayloadUnchanged(known, token)) return { kind: 'unchanged', token }
  const row = await readDiscoveryCacheRow(tx, 'privacyPolicies', key)
  return row ? { kind: 'loaded', token, row } : { kind: 'missing' }
}

async function readForkLivePathHeaders(
  table: Table<MessageHeaderRow, MessageId>,
  chatId: ChatId,
  targetId: MessageId,
): Promise<MessageHeaderRow[]> {
  const result = await readLiveBranchPath({
    chatId,
    leafId: targetId,
    getHeader: (messageId) => table.get(messageId),
  })
  if (result.kind === 'unavailable') {
    throw new Error(`fork: ${result.reason} at message ${result.messageId}`)
  }
  return result.rows.map(cloneMessageHeader)
}

function mutationScopeKey(scope: MutationScope): string {
  switch (scope.kind) {
    case 'message':
      return `message:${scope.messageId}`
    case 'chat-topology':
      return `message-topology:${scope.chatId}`
    case 'children':
      return `children:${scope.chatId}:${scope.parentId ?? '__root__'}`
    case 'attachment':
      return `attachment:${scope.attachmentId}`
    case 'draft':
      return `draft:${scope.chatId}`
    case 'chat-meta':
      return `chat-meta:${scope.chatId}`
  }
}

function dedupeMutationScopes(scopes: readonly MutationScope[]): MutationScope[] {
  const seen = new Set<string>()
  return scopes.filter((scope) => {
    const key = mutationScopeKey(scope)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function attachmentOwnerScopes(
  owner: AttachmentRefOwner,
  attachmentIds: readonly AttachmentId[] = [],
): MutationScope[] {
  return dedupeMutationScopes([
    owner.kind === 'message'
      ? { kind: 'message', messageId: owner.messageId }
      : { kind: 'draft', chatId: owner.chatId },
    ...attachmentIds.map((attachmentId) => ({
      kind: 'attachment' as const,
      attachmentId,
    })),
  ])
}

const DRAFT_PUT_PREFLIGHT_TRANSACTION_PLAN = physicalTransactionPlan(
  physicalStorageTables('drafts'),
)
const draftPutPlanBrand: unique symbol = Symbol('DraftPutPlan')

interface DraftPutPlan {
  readonly chatId: ChatId
  readonly expectedUpdatedAt: number | null
  readonly previousAttachmentIds: readonly AttachmentId[]
  readonly nextAttachmentIds: readonly AttachmentId[]
  readonly [draftPutPlanBrand]: true
}

export class DraftPutPlanChangedError extends Error {
  readonly chatId: ChatId

  constructor(chatId: ChatId) {
    super(`DraftPutPlanChanged:${chatId}`)
    this.name = 'DraftPutPlanChangedError'
    this.chatId = chatId
  }
}

function draftPutAttachmentIds(
  refs: readonly MessageAttachmentRef[] | undefined,
): readonly AttachmentId[] {
  return Object.freeze([...new Set(liveAttachmentRefs(refs).map((ref) => ref.attachmentId))].sort())
}

async function readDraftPutPlan(
  commit: BrowserCommandSessionPort,
  input: { readonly draft: DraftRow; readonly expectedUpdatedAt: number | null },
): Promise<DraftPutPlan> {
  const previous = await commit.readSemanticOperationPreflight(
    DRAFT_PUT_PREFLIGHT_TRANSACTION_PLAN,
    (tx) => tx.table<DraftRow, ChatId>('drafts').get(input.draft.chatId),
    (_row) => [
      {
        tableName: 'drafts',
        indexKind: 'primary',
        operation: 'get',
        requestCount: 1,
        rowCount: 1,
      },
    ],
  )
  if ((previous?.updatedAt ?? null) !== input.expectedUpdatedAt) {
    throw new Error(`DraftChanged:${input.draft.chatId}`)
  }
  return Object.freeze({
    chatId: input.draft.chatId,
    expectedUpdatedAt: input.expectedUpdatedAt,
    previousAttachmentIds: draftPutAttachmentIds(previous?.attachmentRefs),
    nextAttachmentIds: draftPutAttachmentIds(input.draft.attachmentRefs),
    [draftPutPlanBrand]: true as const,
  })
}

async function attachmentOwnerMessage(
  ctx: MutationContext,
  owner: Extract<AttachmentRefOwner, { kind: 'message' }>,
): Promise<Message> {
  const message = await ctx.getMessage(owner.messageId)
  if (!message || message.chatId !== owner.chatId || message.deleted) {
    throw new Error(`MessageMissing:${owner.messageId}`)
  }
  return message
}

function insertAttachmentRef(
  refs: readonly MessageAttachmentRef[],
  ref: MessageAttachmentRef,
  afterRefId?: string,
): MessageAttachmentRef[] {
  if (!afterRefId) return [...refs, ref]
  const index = refs.findIndex((candidate) => candidate.refId === afterRefId)
  return index < 0 ? [...refs, ref] : [...refs.slice(0, index + 1), ref, ...refs.slice(index + 1)]
}

function messageWithWorkspaceAttachmentRefs(
  message: Message,
  attachmentRefs: readonly MessageAttachmentRef[],
): Message {
  const next = { ...message, attachmentRefs: [...attachmentRefs] }
  delete next.cachedMediaTokens
  return next
}

async function attachmentMessageRefResult(
  ctx: MutationContext,
  message: Message,
  ref?: MessageAttachmentRef,
): Promise<AttachmentRefWriteResult> {
  const header = await ctx.getMessageHeader(message.id)
  if (!header) throw new Error(`MessageMissing:${message.id}`)
  return {
    ...(ref ? { ref } : {}),
    presentation: { header, message, bodyVersion: header.bodyVersion },
  }
}

function assertExpectedAttachmentReference(
  ref: MessageAttachmentRef,
  expectedAttachmentId: AttachmentId,
): void {
  if (ref.deletedAt !== undefined) throw new Error(`AttachmentRefNotLive:${ref.refId}`)
  if (ref.attachmentId !== expectedAttachmentId) {
    throw new Error(`AttachmentRefChanged:${ref.refId}:${expectedAttachmentId}:${ref.attachmentId}`)
  }
}

function groupAttachmentRelinkSpecs(specs: AttachmentRefRelinkInput['refs']): Map<
  string,
  {
    owner: AttachmentRefOwner
    specs: Array<AttachmentRefRelinkInput['refs'][number] & { inputIndex: number }>
  }
> {
  const groups = new Map<
    string,
    {
      owner: AttachmentRefOwner
      specs: Array<AttachmentRefRelinkInput['refs'][number] & { inputIndex: number }>
    }
  >()
  specs.forEach((spec, inputIndex) => {
    const key =
      spec.owner.kind === 'message'
        ? `message:${spec.owner.messageId}`
        : `draft:${spec.owner.chatId}`
    const group = groups.get(key) ?? { owner: spec.owner, specs: [] }
    if (group.specs.some((candidate) => candidate.refId === spec.refId)) {
      throw new Error(`DuplicateAttachmentRelinkSpec:${key}:${spec.refId}`)
    }
    group.specs.push({ ...spec, inputIndex })
    groups.set(key, group)
  })
  return groups
}

function applyAttachmentRelinks(
  refs: readonly MessageAttachmentRef[],
  specs: readonly (AttachmentRefRelinkInput['refs'][number] & { inputIndex: number })[],
  newAttachmentId: AttachmentId,
  now: number,
  updatedByInput: Map<number, MessageAttachmentRef>,
): MessageAttachmentRef[] {
  const specsByRefId = new Map(specs.map((spec) => [spec.refId, spec]))
  const matched = new Set<string>()
  const next = refs.map((ref) => {
    const spec = specsByRefId.get(ref.refId)
    if (!spec) return ref
    assertExpectedAttachmentReference(ref, spec.expectedAttachmentId)
    matched.add(ref.refId)
    const updated = { ...ref, attachmentId: newAttachmentId, updatedAt: now }
    updatedByInput.set(spec.inputIndex, updated)
    return updated
  })
  for (const spec of specs) {
    if (!matched.has(spec.refId)) throw new Error(`AttachmentRefMissing:${spec.refId}`)
  }
  return next
}

async function persistPreparedAttachmentBundleInMutation(
  ctx: MutationContext,
  bundle: PreparedAttachmentBundle,
  current?: Attachment,
): Promise<void> {
  await ctx.putAttachment({
    ...bundle.attachment,
    ...(current ? { createdAt: current.createdAt, refCount: current.refCount } : {}),
  })
  for (const blob of bundle.blobs) await ctx.putAttachmentBlob(blob)
  for (const artifact of bundle.artifacts) await ctx.putAttachmentArtifact(artifact)
  for (const job of bundle.jobs) await ctx.putAttachmentJob(job)
}

function generatedOutputLocalizationAttachmentProjection(
  attachment: Attachment,
): GeneratedOutputLocalizationClaim['attachment'] {
  return {
    id: attachment.id,
    kind: attachment.kind,
    mime: attachment.mime,
    filename: attachment.filename,
    storage: structuredClone(attachment.storage),
    ...(attachment.sourceUrl ? { sourceUrl: attachment.sourceUrl } : {}),
  }
}

function generatedOutputLocalizationSourceMatches(
  attachment: Attachment,
  job: AttachmentJob,
): boolean {
  return (
    isGeneratedOutputLocalizationJob(job) &&
    attachment.origin === 'generated-output' &&
    attachment.storage.kind === 'remote-url' &&
    attachment.storage.url === job.task.expectedSourceUrl
  )
}

function generatedOutputLocalizationLeaseMatches(
  attachment: Attachment,
  job: AttachmentJob,
  leaseId: string,
): boolean {
  return (
    generatedOutputLocalizationSourceMatches(attachment, job) &&
    job.status === 'running' &&
    job.leaseId === leaseId
  )
}

function runningGeneratedOutputLocalizationJob(
  job: GeneratedOutputLocalizationClaim['job'],
  input: GeneratedOutputLocalizationClaimInput,
): GeneratedOutputLocalizationClaim['job'] {
  const next: GeneratedOutputLocalizationClaim['job'] = {
    ...job,
    status: 'running',
    attemptCount: job.attemptCount + 1,
    startedAt: input.now,
    leaseId: input.leaseId,
    leaseExpiresAt: input.leaseExpiresAt,
    updatedAt: input.now,
  }
  delete next.finishedAt
  delete next.error
  delete next.nextAttemptAt
  return next
}

function retriedGeneratedOutputLocalizationJob(
  job: AttachmentJob,
  input: GeneratedOutputLocalizationRetryInput,
): AttachmentJob {
  const next: AttachmentJob = {
    ...job,
    status: 'pending',
    error: { ...input.error },
    nextAttemptAt: input.nextAttemptAt,
    updatedAt: input.now,
  }
  delete next.finishedAt
  delete next.leaseId
  delete next.leaseExpiresAt
  return next
}

function failedGeneratedOutputLocalizationJob(
  job: AttachmentJob,
  input: GeneratedOutputLocalizationFailInput,
): AttachmentJob {
  const next: AttachmentJob = {
    ...job,
    status: 'failed',
    error: { ...input.error },
    finishedAt: input.now,
    updatedAt: input.now,
  }
  delete next.nextAttemptAt
  delete next.leaseId
  delete next.leaseExpiresAt
  return next
}

function succeededGeneratedOutputLocalizationJob(job: AttachmentJob, now: number): AttachmentJob {
  const next: AttachmentJob = {
    ...job,
    status: 'succeeded',
    finishedAt: now,
    updatedAt: now,
  }
  delete next.error
  delete next.nextAttemptAt
  delete next.leaseId
  delete next.leaseExpiresAt
  return next
}

class GeneratedOutputLocalizationPlanChangedError extends Error {}

function preparedAttachmentIdentityMatches(current: Attachment, prepared: Attachment): boolean {
  if (
    current.id !== prepared.id ||
    current.origin !== 'generated-output' ||
    prepared.origin !== 'generated-output'
  ) {
    return false
  }
  if (current.storage.kind === 'remote-url' && prepared.storage.kind === 'remote-url') {
    return current.storage.url === prepared.storage.url
  }
  return (
    current.storage.kind === 'local-blob' &&
    prepared.storage.kind === 'local-blob' &&
    current.contentHash !== undefined &&
    current.contentHash === prepared.contentHash
  )
}

function replaceGeneratedPollingVideoContent(
  content: readonly Message['content'][number][],
  attachmentId: AttachmentId,
  replacementIds: readonly AttachmentId[],
): { content: Message['content']; changed: boolean } {
  const next: Message['content'] = []
  let changed = false
  for (const item of content) {
    if (item.type !== 'output_video' || item.attachmentId !== attachmentId) {
      next.push(structuredClone(item))
      continue
    }
    changed = true
    for (const replacementId of replacementIds) {
      next.push({
        type: 'output_video',
        attachmentId: replacementId,
        ...(item.prompt ? { prompt: item.prompt } : {}),
      })
    }
  }
  return { content: next, changed }
}

function replaceGeneratedPollingVideoRefs(
  input: readonly MessageAttachmentRef[] | undefined,
  attachmentId: AttachmentId,
  replacementIds: readonly AttachmentId[],
  owner: AttachmentRefOwner,
  now: number,
): { refs: MessageAttachmentRef[]; changed: boolean } {
  const refs = normalizeAttachmentRefs(
    input,
    owner.kind === 'message'
      ? { messageId: owner.messageId, createdAt: now }
      : { draftChatId: owner.chatId, createdAt: now },
  )
  const target = refs.find(
    (ref) => ref.deletedAt === undefined && ref.attachmentId === attachmentId,
  )
  const kept = refs.filter(
    (ref) => ref.deletedAt !== undefined || ref.attachmentId !== attachmentId,
  )
  const replacements = replacementIds.map((replacementId, index) => ({
    ...(target
      ? {
          ...target,
          refId: index === 0 ? target.refId : newId(),
          attachmentId: replacementId,
          updatedAt: now,
        }
      : {
          refId: newId(),
          attachmentId: replacementId,
          includeInContext: true,
          presentation: {},
          createdAt: now,
          updatedAt: now,
        }),
  }))
  return {
    refs: [...kept, ...replacements],
    changed: target !== undefined || replacements.length > 0,
  }
}

function cloneForkMessages(
  ancestors: readonly Message[],
  destinationChatId: ChatId,
  destinationMessageIds: readonly MessageId[],
  now: number,
): Message[] {
  const destinationIdBySourceId = new Map(
    ancestors.map((row, index) => [row.id, destinationMessageIds[index] as MessageId]),
  )
  const destinationTurnIdBySourceTurnId = new Map<string, string>()
  return ancestors.map((source, index) => {
    const clone = structuredClone(source)
    clone.id = destinationMessageIds[index] as MessageId
    clone.chatId = destinationChatId
    clone.parentId = source.parentId ? (destinationIdBySourceId.get(source.parentId) ?? null) : null
    clone.siblingIndex = 0
    let destinationTurnId = destinationTurnIdBySourceTurnId.get(source.turnId)
    if (!destinationTurnId) {
      destinationTurnId = newId()
      destinationTurnIdBySourceTurnId.set(source.turnId, destinationTurnId)
    }
    clone.turnId = destinationTurnId
    clone.createdAt = now - (ancestors.length - index)
    if (clone.editedAt !== undefined) clone.editedAt = now
    clone.nodeVersion = 0
    return clone
  })
}

const FORBIDDEN_MESSAGE_HEADER_PATCH_KEYS = new Set<keyof MessageHeaderRow>([
  'id',
  'chatId',
  'parentId',
  'siblingIndex',
  'turnId',
  'turnIndex',
  'createdAt',
  'role',
  'origin',
  'nodeVersion',
  'requestContextVersion',
  'bodyVersion',
  'bodyWordCount',
  'bodyTextCharCount',
  'bodyMediaCount',
  'bodyRenderCost',
  'contextRouteFacts',
  'treeParentKey',
  'treeLive',
  'deleted',
])

const CHAT_METADATA_PATCH_KEYS = new Set<keyof Chat>([
  'title',
  'titleStatus',
  'lastViewedAt',
  'configurationVersion',
  'settings',
  'presetId',
  'modelResolution',
  'archived',
  'pinned',
  'color',
  'tags',
  'favoriteModels',
  'recentModels',
  'temporary',
])

const DISCOVERY_CACHE_INTERNAL_MAINTENANCE_TABLES = new Set<PhysicalStorageTableName>([
  'discoveryCacheState',
  'discoveryPayloadMetadata',
  'discoveryPayloads',
])

function streamOwnedMessageFieldsChanged(
  existingHeader: MessageHeaderRow,
  existingBody: MessageBodyRow,
  nextHeader: MessageHeaderRow,
  nextBody: MessageBodyRow,
): boolean {
  const comparableHeader = (header: MessageHeaderRow) => {
    const {
      nodeVersion,
      requestContextVersion,
      bodyVersion,
      bodyWordCount,
      bodyTextCharCount,
      bodyMediaCount,
      bodyRenderCost,
      contextRouteFacts,
      treeParentKey: _treeParentKey,
      treeLive,
      hiddenFromContext,
      attachmentRefs,
      cachedMediaTokens,
      ...value
    } = header
    void nodeVersion
    void requestContextVersion
    void bodyVersion
    void bodyWordCount
    void bodyTextCharCount
    void bodyMediaCount
    void bodyRenderCost
    void contextRouteFacts
    void _treeParentKey
    void treeLive
    void hiddenFromContext
    void attachmentRefs
    void cachedMediaTokens
    return value
  }
  const comparableBody = (body: MessageBodyRow) => {
    const { bodyVersion, updatedAt, ...value } = body
    void bodyVersion
    void updatedAt
    return value
  }
  return (
    stableStringify(comparableHeader(existingHeader)) !==
      stableStringify(comparableHeader(nextHeader)) ||
    stableStringify(comparableBody(existingBody)) !== stableStringify(comparableBody(nextBody))
  )
}

function nextBranchUpdatedAt(current: number, now: number): number {
  return Math.max(now, current + 1)
}

async function reserveStreamLeaseTarget(
  tx: FencedTransaction<'settings' | 'streamLeases'>,
  incoming: StreamLeaseAdmission,
): Promise<number> {
  const settings = tx.table<{ key: string; value: unknown }, string>('settings')
  const sequenceRow = await settings.get('stream-admission-sequence')
  const currentSequence =
    typeof sequenceRow?.value === 'number' &&
    Number.isSafeInteger(sequenceRow.value) &&
    sequenceRow.value >= 0
      ? sequenceRow.value
      : 0
  if (currentSequence >= Number.MAX_SAFE_INTEGER)
    throw new Error('StreamAdmissionSequenceExhausted')
  const admissionSequence = currentSequence + 1
  const leaseTable = tx.table<StreamLeaseRow, string>('streamLeases')
  const competing = await leaseTable.where('targetOwnerKey').equals(incoming.messageId).first()
  if (competing) throw new StreamTargetBusyError(incoming.messageId)
  await putPhysicalStorageRow(
    tx,
    'settings',
    { key: 'stream-admission-sequence', value: admissionSequence },
    sequenceRow,
  )
  recordBrowserCommandInvalidation(tx, {
    kind: 'setting',
    keys: ['stream-admission-sequence'],
  })
  return admissionSequence
}

async function assertStreamLeaseWorkspaceTarget(
  tx: Transaction,
  lease: Pick<StreamLeaseRow, 'streamId' | 'chatId' | 'messageId' | 'attemptKind'>,
  chat: Chat | undefined,
): Promise<void> {
  if (!chat) throw new ChatMissingError(lease.chatId)
  const target = await tx.table<MessageHeaderRow, MessageId>('messages').get(lease.messageId)
  if (lease.attemptKind === 'generation' && target) {
    throw new StreamTargetBusyError(lease.messageId)
  }
  if (
    lease.attemptKind === 'continuation' &&
    (!target || target.deleted || target.chatId !== lease.chatId || target.role !== 'assistant')
  ) {
    throw new Error(`ContinuationStreamTargetInvalid:${lease.streamId}:${lease.messageId}`)
  }
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right)
}

function changedPatch<Row extends object>(
  current: Partial<Row>,
  patch: Partial<Row>,
): Partial<Row> | null {
  const next: Partial<Row> = {}
  let changed = false
  for (const key of Object.keys(patch) as Array<keyof Row>) {
    const value = patch[key]
    if (valuesEqual(current[key], value)) continue
    next[key] = value
    changed = true
  }
  return changed ? next : null
}

function cloneMessage(message: Message): Message {
  const cloned = structuredClone(message)
  cloned.attachmentRefs = normalizeAttachmentRefs(cloned.attachmentRefs, {
    messageId: cloned.id,
    createdAt: cloned.createdAt,
  })
  return cloned
}

function assertExistingMessageIdentity(existing: MessageHeaderRow, candidate: Message): void {
  if (
    existing.id !== candidate.id ||
    existing.chatId !== candidate.chatId ||
    existing.turnId !== candidate.turnId ||
    existing.turnIndex !== candidate.turnIndex ||
    existing.createdAt !== candidate.createdAt ||
    existing.role !== candidate.role ||
    existing.origin !== candidate.origin
  ) {
    throw new Error(`ImmutableMessageFieldChanged:${existing.id}`)
  }
  if (
    existing.parentId !== candidate.parentId ||
    existing.siblingIndex !== candidate.siblingIndex ||
    existing.deleted !== candidate.deleted
  ) {
    throw new Error(`MessageStructurePatchRequired:${existing.id}`)
  }
}

async function listChildHeaderRows(
  table: Table<MessageHeaderRow, MessageId>,
  chatId: ChatId,
  parentId: MessageId | null,
): Promise<MessageHeaderRow[]> {
  return table
    .where('[chatId+treeParentKey+siblingIndex+id]')
    .between(...exactCompoundPrefixBetween([chatId, treeParentKey(parentId)]))
    .toArray()
}

function applyMessageBodyPatch(body: MessageBodyRow, patch: MessageBodyPatch): MessageBodyRow {
  const next = structuredClone(body)
  if ('content' in patch) {
    if (patch.content === undefined) throw new Error(`MessageBodyPatchMissingContent:${body.id}`)
    next.content = structuredClone(patch.content)
  }
  if ('reasoningEnvelope' in patch) {
    if (patch.reasoningEnvelope === undefined) delete next.reasoningEnvelope
    else next.reasoningEnvelope = structuredClone(patch.reasoningEnvelope)
  }
  if ('toolCalls' in patch) {
    if (patch.toolCalls === undefined) delete next.toolCalls
    else next.toolCalls = structuredClone(patch.toolCalls)
  }
  if ('refusal' in patch) {
    if (patch.refusal === undefined) delete next.refusal
    else next.refusal = patch.refusal
  }
  if ('phase' in patch) {
    if (patch.phase === undefined) delete next.phase
    else next.phase = patch.phase
  }
  if ('providerOutputItems' in patch) {
    if (patch.providerOutputItems === undefined) delete next.providerOutputItems
    else next.providerOutputItems = structuredClone(patch.providerOutputItems)
  }
  if ('continuationAttempts' in patch) {
    if (patch.continuationAttempts === undefined) delete next.continuationAttempts
    else next.continuationAttempts = structuredClone(patch.continuationAttempts)
  }
  return next
}

function replacementMessageBody(
  header: MessageHeaderRow,
  patch: MessageBodyPatch,
  options: { bodyVersion: number; updatedAt: number },
): MessageBodyRow {
  if (!('content' in patch) || patch.content === undefined) {
    throw new Error(`MessageBodyPatchMissingContent:${header.id}`)
  }
  const body: MessageBodyRow = {
    id: header.id,
    chatId: header.chatId,
    bodyVersion: options.bodyVersion,
    updatedAt: options.updatedAt,
    content: structuredClone(patch.content),
  }
  if (patch.reasoningEnvelope !== undefined) {
    body.reasoningEnvelope = structuredClone(patch.reasoningEnvelope)
  }
  if (patch.toolCalls !== undefined) body.toolCalls = structuredClone(patch.toolCalls)
  if (patch.refusal !== undefined) body.refusal = patch.refusal
  if (patch.phase !== undefined) body.phase = patch.phase
  if (patch.providerOutputItems !== undefined) {
    body.providerOutputItems = structuredClone(patch.providerOutputItems)
  }
  if (patch.continuationAttempts !== undefined) {
    body.continuationAttempts = structuredClone(patch.continuationAttempts)
  }
  return body
}

function transitionMessageGenerationForDispatch(
  header: MessageHeaderRow,
  generation: DispatchedGenerationMeta,
): MessageHeaderRow {
  if (stableStringify(header.generation) === stableStringify(generation)) {
    return cloneMessageHeader(header)
  }
  const current = header.generation
  if (
    header.role !== 'assistant' ||
    header.origin !== 'generated' ||
    header.deleted ||
    !current ||
    current.status !== 'preparing'
  ) {
    throw new Error(`MessageGenerationDispatchSourceInvalid:${header.id}`)
  }
  if (generation.model !== current.model || generation.startedAt !== current.startedAt) {
    throw new Error(`MessageGenerationDispatchTargetInvalid:${header.id}`)
  }
  return {
    ...cloneMessageHeader(header),
    generation: structuredClone(generation),
    nodeVersion: header.nodeVersion + 1,
    requestContextVersion: header.requestContextVersion,
    bodyVersion: header.bodyVersion,
  }
}

async function chatPreviewInTransaction(tx: Transaction, chatId: ChatId): Promise<string> {
  const header = await tx
    .table<MessageHeaderRow, MessageId>('messages')
    .where('[chatId+createdAt+id]')
    .between(...exactCompoundPrefixBetween([chatId]))
    .filter((row) => !row.deleted && row.role === 'user')
    .first()
  if (!header) return ''
  const preview = await tx.table<MessageTextPreviewRow, MessageId>('messagePreviews').get(header.id)
  if (!preview) throw new Error(`MessagePreviewMissing:${header.id}`)
  if (preview.bodyVersion !== header.bodyVersion) {
    throw new Error(`MessagePreviewVersionMismatch:${header.id}`)
  }
  return previewTextFromStoredProjection(preview.text)
}

function messageCost(message: Pick<Message, 'deleted' | 'generation'>): number {
  return message.deleted ? 0 : (message.generation?.cost ?? 0)
}

function recordMessageSummaryDeltas(
  state: ChatMutationState | undefined,
  messageId: MessageId,
  before: Message,
  after: Message,
): boolean {
  if (!state) return false
  const wordCountDelta = countMessagesWords([after]) - countMessagesWords([before])
  const costDelta = messageCost(after) - messageCost(before)
  if (wordCountDelta !== 0) {
    state.wordCountDeltas.set(
      messageId,
      (state.wordCountDeltas.get(messageId) ?? 0) + wordCountDelta,
    )
  }
  state.totalCostDelta += costDelta
  return wordCountDelta !== 0 || costDelta !== 0
}

function recordMessageHeaderSummaryDeltas(
  state: ChatMutationState | undefined,
  messageId: MessageId,
  before: MessageHeaderRow,
  after: MessageHeaderRow,
): boolean {
  if (!state) return false
  const beforeWords = before.deleted ? 0 : before.bodyWordCount
  const afterWords = after.deleted ? 0 : after.bodyWordCount
  const wordCountDelta = afterWords - beforeWords
  const costDelta = messageCost(after) - messageCost(before)
  if (wordCountDelta !== 0) {
    state.wordCountDeltas.set(
      messageId,
      (state.wordCountDeltas.get(messageId) ?? 0) + wordCountDelta,
    )
  }
  state.totalCostDelta += costDelta
  return wordCountDelta !== 0 || costDelta !== 0
}

function requireChatMetadataPatch(patch: ChatMetadataPatch): ChatMetadataPatch {
  for (const key of Object.keys(patch) as Array<keyof Chat>) {
    if (!CHAT_METADATA_PATCH_KEYS.has(key)) throw new Error(`ChatMetadataPatchForbidden:${key}`)
  }
  return patch
}

async function loadChatOrThrow(table: Table<Chat, string>, chatId: ChatId): Promise<Chat> {
  const chat = await table.get(chatId)
  if (!chat) throw new ChatMissingError(chatId)
  return structuredClone(chat)
}

function shouldBumpStructuralLastBranchUpdatedAt(
  beforeChat: Chat,
  previousBranchIds: ReadonlySet<MessageId>,
  nextLeafId: MessageId | null,
  nextBranchHeaders: readonly MessageHeaderRow[],
  changedMessageIds: ReadonlySet<MessageId>,
): boolean {
  if (nextLeafId !== beforeChat.lastUpdatedLeafId) return true
  if (nextLeafId === null) return false
  if (changedMessageIds.size === 0) return false
  const nextBranchIds = new Set(nextBranchHeaders.map((header) => header.id))
  for (const messageId of changedMessageIds) {
    if (previousBranchIds.has(messageId) || nextBranchIds.has(messageId)) return true
  }
  return false
}

function shouldBumpLastBranchUpdatedAtFromHeaders(
  beforeChat: Chat,
  nextLeafId: MessageId | null,
  branchHeaders: readonly MessageHeaderRow[],
  changedMessageIds: ReadonlySet<MessageId>,
): boolean {
  if (nextLeafId !== beforeChat.lastUpdatedLeafId) return true
  if (nextLeafId === null || changedMessageIds.size === 0) return false
  const branchIds = new Set(branchHeaders.map((header) => header.id))
  for (const messageId of changedMessageIds) {
    if (branchIds.has(messageId)) return true
  }
  return false
}

function branchHeaderWordCount(headers: readonly MessageHeaderRow[]): number {
  let wordCount = 0
  for (const header of headers) wordCount += header.bodyWordCount
  return wordCount
}

function canApplyIncrementalBranchAppend(state: ChatMutationState): boolean {
  if (state.incrementalAppends.length === 0) return false
  const appendedIds = new Set(state.incrementalAppends.map((message) => message.id))
  if ([...state.changedMessageIds].some((messageId) => !appendedIds.has(messageId))) return false
  if ([...state.wordCountDeltas.keys()].some((messageId) => !appendedIds.has(messageId))) {
    return false
  }
  let parentId = state.beforeChat.lastUpdatedLeafId
  for (const message of state.incrementalAppends) {
    if (message.deleted || message.parentId !== parentId) return false
    parentId = message.id
  }
  return true
}

async function newestLiveLeafIdInTransaction(
  tx: Transaction,
  chatId: ChatId,
): Promise<MessageId | null> {
  const messages = tx.table<MessageHeaderRow, MessageId>('messages')
  const childLists = tx.table<ChildListState, string>('childLists')
  const prefixRange = exactCompoundPrefixBetween([chatId])
  let before: readonly [number, MessageId] | undefined
  for (;;) {
    const page = await messages
      .where('[chatId+createdAt+id]')
      .between(
        prefixRange[0],
        before ? [chatId, before[0], before[1]] : prefixRange[1],
        true,
        false,
      )
      .reverse()
      .limit(HEADER_READ_PAGE_SIZE)
      .toArray()
    if (page.length === 0) return null
    const live = page.filter((header) => !header.deleted)
    const childStates = await childLists.bulkGet(
      live.map((header) => childListKey(chatId, header.id)),
    )
    for (let index = 0; index < live.length; index += 1) {
      if ((childStates[index]?.liveCount ?? 0) === 0) return live[index]?.id ?? null
    }
    const last = page.at(-1) as MessageHeaderRow
    before = [last.createdAt, last.id]
    if (page.length < HEADER_READ_PAGE_SIZE) return null
  }
}

function messageOutranksLeaf(
  message: Pick<Message, 'createdAt' | 'id'>,
  leaf: Pick<MessageHeaderRow, 'createdAt' | 'id'>,
): boolean {
  return compareLiveLeafRecency(message, leaf) > 0
}

async function readBranchPathInTransaction(
  tx: Transaction,
  chatId: ChatId,
  leafId: MessageId | null,
  signal?: AbortSignal,
): Promise<MessageHeaderRow[]> {
  if (leafId === null) return []
  const table = tx.table<MessageHeaderRow, MessageId>('messages')
  const result = await readLiveBranchPath({
    chatId,
    leafId,
    getHeader: async (messageId) => {
      const header = await table.get(messageId)
      throwIfReadonlyAborted(signal, 'Branch target read aborted')
      return header
    },
    ...(signal ? { signal } : {}),
  })
  if (result.kind === 'unavailable') {
    const reason =
      result.reason === 'cycle'
        ? 'ancestry-cycle'
        : result.messageId !== leafId
          ? 'invalid-ancestry'
          : result.reason === 'missing'
            ? 'message-missing'
            : result.reason === 'wrong-chat'
              ? 'message-chat-mismatch'
              : 'message-deleted'
    throw new BranchTargetUnavailableError(chatId, leafId, reason)
  }
  return result.rows.map(cloneMessageHeader)
}

function assertGenerationPromptPathClaimStructure(
  chatId: ChatId,
  claim: GenerationPromptPathClaim,
): void {
  let parentId: MessageId | null = null
  for (const header of claim.headers) {
    if (header.parentId !== parentId) {
      throw new GenerationPlanningSeedChangedError(chatId)
    }
    parentId = header.messageId
  }
}

async function validateGenerationPromptPathClaim(
  tx: Transaction,
  chatId: ChatId,
  claim: GenerationPromptPathClaim,
): Promise<ValidatedGenerationPromptPath> {
  if (claim.chatId !== chatId) throw new GenerationPlanningSeedChangedError(chatId)
  if (claim.leafId === null) {
    if (claim.headers.length !== 0) throw new GenerationPlanningSeedChangedError(chatId)
    return Object.freeze({
      headers: sealValidatedGenerationPromptPathHeaders([]),
      messageProofs: claim.headers,
    })
  }
  if (claim.headers.at(-1)?.messageId !== claim.leafId) {
    throw new GenerationPlanningSeedChangedError(chatId)
  }
  assertGenerationPromptPathClaimStructure(chatId, claim)
  const table = tx.table<MessageHeaderRow, MessageId>('messages')
  const validated: MessageHeaderRow[] = []
  for (let offset = 0; offset < claim.headers.length; offset += HEADER_READ_PAGE_SIZE) {
    const pageLength = Math.min(HEADER_READ_PAGE_SIZE, claim.headers.length - offset)
    const ids = new Array<MessageId>(pageLength)
    for (let index = 0; index < pageLength; index += 1) {
      const expected = claim.headers[offset + index]
      if (!expected) throw new GenerationPlanningSeedChangedError(chatId)
      ids[index] = expected.messageId
    }
    const rows = await table.bulkGet(ids)
    for (let index = 0; index < pageLength; index += 1) {
      const expected = claim.headers[offset + index]
      const row = rows[index]
      if (
        !row ||
        !expected ||
        row.id !== expected.messageId ||
        row.chatId !== chatId ||
        row.deleted ||
        row.parentId !== expected.parentId ||
        row.requestContextVersion !== expected.requestContextVersion
      ) {
        throw new GenerationPlanningSeedChangedError(chatId)
      }
      validated.push(row)
    }
  }
  return Object.freeze({
    headers: sealValidatedGenerationPromptPathHeaders(validated),
    messageProofs: claim.headers,
  })
}

function assertPhysicalMutationEvidenceCoverage(
  mutations: readonly BrowserCommandPhysicalMutation[],
  delta: WorkspaceDelta,
  receipt: WorkspaceLocalReceipt,
  terminalChatIds: ReadonlySet<ChatId>,
  physicalOwnerScopes: ReadonlyMap<string, BrowserCommandPhysicalOwnerScope>,
  internalMutationEvidence: ReadonlySet<string>,
): void {
  const chatIds = new Set<ChatId>()
  for (const chat of [...receipt.chats, ...receipt.constructions]) chatIds.add(chat.id)
  for (const fact of delta.facts) {
    if (
      fact.kind === 'chat-deleted' ||
      fact.kind === 'conversation-created' ||
      fact.kind === 'sidebar-row-changed'
    ) {
      chatIds.add(fact.chatId)
    }
  }
  const revisions = new Map(
    receipt.messageRevisions.map((revision) => [revision.header.id, revision]),
  )
  const previewIds = new Set<MessageId>()
  const settingKeys = new Set<string>()
  const attachmentIds = new Set<AttachmentId>()
  for (const dependency of delta.invalidations) {
    if (dependency.kind === 'message-preview' && dependency.messageIds) {
      for (const messageId of dependency.messageIds) previewIds.add(messageId)
    } else if (dependency.kind === 'setting' && dependency.keys) {
      for (const key of dependency.keys) settingKeys.add(key)
    } else if (dependency.kind === 'attachment' && dependency.attachmentIds) {
      for (const attachmentId of dependency.attachmentIds) attachmentIds.add(attachmentId)
    }
  }
  for (const fact of delta.facts) {
    if (fact.kind === 'attachment-row-changed' || fact.kind === 'attachment-row-deleted') {
      attachmentIds.add(fact.attachmentId)
    }
  }
  const childSlotIds = new Set<string>()
  const childMemberIds = new Set<MessageId>()
  for (const evidence of receipt.childSlots) {
    childSlotIds.add(evidence.state.id)
    for (const member of evidence.upserts) childMemberIds.add(member.id)
    for (const messageId of evidence.removedMessageIds) childMemberIds.add(messageId)
  }
  const evidenceDependencies = [
    ...delta.invalidations,
    ...delta.facts.flatMap(workspaceDependenciesForDeltaFact),
  ]
  const terminalChatOwnerScopeIds = new Set(
    [...physicalOwnerScopes.values()].flatMap((scope) =>
      scope.ownerIds.length > 0 && scope.ownerIds.every((chatId) => terminalChatIds.has(chatId))
        ? [scope.id]
        : [],
    ),
  )

  for (const mutation of mutations) {
    if (
      internalMutationEvidence.has(mutation.address) ||
      internalMutationGroupCovers(mutation, internalMutationEvidence)
    ) {
      continue
    }
    switch (mutation.tableName) {
      case 'chats': {
        if (!mutation.rowId || !chatIds.has(mutation.rowId)) {
          throw new Error(`BrowserCommandPhysicalChatEvidenceMissing:${mutation.rowId ?? '?'}`)
        }
        break
      }
      case 'messages': {
        if (
          physicalMutationCoveredByTerminalChat(
            mutation,
            terminalChatIds,
            terminalChatOwnerScopeIds,
          )
        )
          break
        if (!mutation.messageId || !revisions.has(mutation.messageId)) {
          throw new Error(
            `BrowserCommandPhysicalMessageEvidenceMissing:${mutation.messageId ?? '?'}`,
          )
        }
        break
      }
      case 'messageBodies': {
        if (
          physicalMutationCoveredByTerminalChat(
            mutation,
            terminalChatIds,
            terminalChatOwnerScopeIds,
          )
        )
          break
        const revision = mutation.messageId ? revisions.get(mutation.messageId) : undefined
        if (
          !revision?.changed.body ||
          !revision.presentation ||
          revision.presentation.bodyVersion !== revision.header.bodyVersion
        ) {
          throw new Error(
            `BrowserCommandPhysicalMessageBodyEvidenceMissing:${mutation.messageId ?? '?'}`,
          )
        }
        break
      }
      case 'messagePreviews': {
        if (
          physicalMutationCoveredByTerminalChat(
            mutation,
            terminalChatIds,
            terminalChatOwnerScopeIds,
          )
        )
          break
        const revision = mutation.messageId ? revisions.get(mutation.messageId) : undefined
        if (
          !mutation.messageId ||
          !revision?.changed.body ||
          !revision.presentation ||
          revision.presentation.bodyVersion !== revision.header.bodyVersion ||
          !previewIds.has(mutation.messageId)
        ) {
          throw new Error(
            `BrowserCommandPhysicalMessagePreviewEvidenceMissing:${mutation.messageId ?? '?'}`,
          )
        }
        break
      }
      case 'childLists':
        if (
          !physicalMutationCoveredByTerminalChat(
            mutation,
            terminalChatIds,
            terminalChatOwnerScopeIds,
          ) &&
          (!mutation.rowId || !childSlotIds.has(mutation.rowId))
        ) {
          throw new Error(`BrowserCommandPhysicalChildSlotEvidenceMissing:${mutation.rowId ?? '?'}`)
        }
        break
      case 'childSlotMembers':
        if (
          !physicalMutationCoveredByTerminalChat(
            mutation,
            terminalChatIds,
            terminalChatOwnerScopeIds,
          ) &&
          (!mutation.messageId || !childMemberIds.has(mutation.messageId))
        ) {
          throw new Error(
            `BrowserCommandPhysicalChildMemberEvidenceMissing:${mutation.messageId ?? '?'}`,
          )
        }
        break
      case 'settings': {
        const key = typeof mutation.key === 'string' ? mutation.key : null
        if (!key || !settingKeys.has(key)) {
          throw new Error(`BrowserCommandPhysicalSettingEvidenceMissing:${key ?? '?'}`)
        }
        break
      }
      case 'attachments':
        if (!mutation.attachmentId || !attachmentIds.has(mutation.attachmentId)) {
          throw new Error(
            `BrowserCommandPhysicalAttachmentEvidenceMissing:${mutation.attachmentId ?? '?'}`,
          )
        }
        break
      default: {
        const allowedKinds =
          PHYSICAL_STORAGE_POLICY[mutation.tableName as PhysicalStorageTableName].effectKinds
        if (
          !evidenceDependencies.some(
            (dependency) =>
              allowedKinds.includes(dependency.kind) &&
              workspaceDependencyCoversPhysicalMutation(dependency, mutation, physicalOwnerScopes),
          )
        ) {
          throw new Error(
            `BrowserCommandPhysicalEffectEvidenceMissing:${mutation.tableName}:${mutation.rowId ?? '?'}`,
          )
        }
      }
    }
  }
}

function internalMutationGroupCovers(
  mutation: BrowserCommandPhysicalMutation,
  evidence: ReadonlySet<string>,
): boolean {
  if (
    evidence.has(INTERNAL_DISCOVERY_CACHE_MAINTENANCE) &&
    DISCOVERY_CACHE_INTERNAL_MAINTENANCE_TABLES.has(mutation.tableName as PhysicalStorageTableName)
  ) {
    return true
  }
  return (
    evidence.has(INTERNAL_ATTACHMENT_INTEGRITY_MAINTENANCE) &&
    mutation.tableName === 'attachmentIntegrityState'
  )
}

function physicalMutationCoveredByTerminalChat(
  mutation: BrowserCommandPhysicalMutation,
  terminalChatIds: ReadonlySet<ChatId>,
  terminalChatOwnerScopeIds: ReadonlySet<string>,
): boolean {
  return (
    (mutation.chatId !== undefined && terminalChatIds.has(mutation.chatId)) ||
    (mutation.ownerScopeId !== undefined && terminalChatOwnerScopeIds.has(mutation.ownerScopeId))
  )
}

function workspaceDependencyCoversPhysicalMutation(
  dependency: WorkspaceDependency,
  mutation: BrowserCommandPhysicalMutation,
  physicalOwnerScopes: ReadonlyMap<string, BrowserCommandPhysicalOwnerScope>,
): boolean {
  switch (dependency.kind) {
    case 'workspace':
      return true
    case 'chat':
    case 'sidebar':
    case 'draft': {
      if (physicalEffectGroupCovers(dependency.kind, mutation.tableName)) return true
      const chatId =
        mutation.chatId ?? (mutation.tableName === 'drafts' ? mutation.rowId : undefined)
      const chatIds = physicalMutationChatIds(mutation, physicalOwnerScopes, chatId)
      return (
        !dependency.chatIds ||
        (chatIds.length > 0 && chatIds.every((id) => dependency.chatIds?.includes(id)))
      )
    }
    case 'message-header':
    case 'message-body':
    case 'message-preview':
      return (
        (!dependency.chatId ||
          physicalMutationChatsMatch(
            mutation,
            physicalOwnerScopes,
            (chatId) => chatId === dependency.chatId,
          )) &&
        (!dependency.messageIds ||
          (mutation.messageId !== undefined && dependency.messageIds.includes(mutation.messageId)))
      )
    case 'child-slot':
      return physicalMutationChatsMatch(
        mutation,
        physicalOwnerScopes,
        (chatId) => chatId === dependency.chatId,
      )
    case 'attachment':
      if (physicalEffectGroupCovers(dependency.kind, mutation.tableName)) return true
      return (
        !dependency.attachmentIds ||
        (mutation.attachmentId !== undefined &&
          dependency.attachmentIds.includes(mutation.attachmentId))
      )
    case 'attachment-job':
      return (
        (!dependency.attachmentIds ||
          (mutation.attachmentId !== undefined &&
            dependency.attachmentIds.includes(mutation.attachmentId))) &&
        (!dependency.jobIds ||
          (mutation.rowId !== undefined && dependency.jobIds.includes(mutation.rowId)))
      )
    case 'profile': {
      if (physicalEffectGroupCovers(dependency.kind, mutation.tableName)) return true
      const profileIds = mutation.profileIds ?? (mutation.profileId ? [mutation.profileId] : [])
      return !dependency.profileIds || dependency.profileIds.some((id) => profileIds.includes(id))
    }
    case 'preset': {
      if (physicalEffectGroupCovers(dependency.kind, mutation.tableName)) return true
      return (
        !dependency.presetIds ||
        dependency.presetIds.some((id) => mutation.presetIds?.includes(id) === true)
      )
    }
    case 'prompt-preset': {
      if (physicalEffectGroupCovers(dependency.kind, mutation.tableName)) return true
      return (
        !dependency.presetIds ||
        dependency.presetIds.some((id) => mutation.promptPresetIds?.includes(id) === true)
      )
    }
    case 'text-template':
      return (
        !dependency.templateIds ||
        dependency.templateIds.some((id) => mutation.templateIds?.includes(id) === true)
      )
    case 'folder':
      return (
        !dependency.folderIds ||
        (mutation.rowId !== undefined && dependency.folderIds.includes(mutation.rowId))
      )
    case 'tag':
      return (
        !dependency.tagIds ||
        (mutation.rowId !== undefined && dependency.tagIds.includes(mutation.rowId))
      )
    case 'key':
      return (
        !dependency.keyIds || dependency.keyIds.some((id) => mutation.keyIds?.includes(id) === true)
      )
    case 'setting':
      return (
        !dependency.keys ||
        (typeof mutation.key === 'string' && dependency.keys.includes(mutation.key))
      )
    case 'stream-lease':
    case 'stream-chunks':
      return (
        (!dependency.chatId ||
          physicalMutationChatsMatch(
            mutation,
            physicalOwnerScopes,
            (chatId) => chatId === dependency.chatId,
          )) &&
        (!dependency.streamIds ||
          (mutation.streamId !== undefined && dependency.streamIds.includes(mutation.streamId)))
      )
    case 'model-resolution':
      return false
    case 'discovery-cache':
      if (physicalEffectGroupCovers(dependency.kind, mutation.tableName)) return true
      return (
        !dependency.profileIds ||
        dependency.profileIds.some(
          (id) => mutation.profileIds?.includes(id) === true || mutation.profileId === id,
        )
      )
    case 'storage-maintenance':
      return (
        mutation.rowId !== undefined &&
        dependency.tasks.includes(mutation.rowId as StorageMaintenanceRequestTaskKind)
      )
  }
}

function physicalMutationChatIds(
  mutation: BrowserCommandPhysicalMutation,
  physicalOwnerScopes: ReadonlyMap<string, BrowserCommandPhysicalOwnerScope>,
  fallbackChatId = mutation.chatId,
): readonly ChatId[] {
  if (fallbackChatId) return [fallbackChatId]
  if (!mutation.ownerScopeId) return []
  const scope = physicalOwnerScopes.get(mutation.ownerScopeId)
  return scope?.kind === 'chat' ? scope.ownerIds : []
}

function physicalMutationChatsMatch(
  mutation: BrowserCommandPhysicalMutation,
  physicalOwnerScopes: ReadonlyMap<string, BrowserCommandPhysicalOwnerScope>,
  predicate: (chatId: ChatId) => boolean,
): boolean {
  const chatIds = physicalMutationChatIds(mutation, physicalOwnerScopes)
  return chatIds.length > 0 && chatIds.every(predicate)
}

function physicalEffectGroupCovers(kind: WorkspaceDependency['kind'], tableName: string): boolean {
  return PHYSICAL_STORAGE_POLICY[tableName as PhysicalStorageTableName].groupEffectKinds.includes(
    kind,
  )
}

function materializeChatMutationState(state: ChatMutationState): Chat {
  const chat = {
    ...state.beforeChat,
    ...state.hiddenMetaPatch,
    ...state.visibleMetaPatch,
  }
  if (state.clearModelResolution) delete chat.modelResolution
  return chat
}

function workspaceDeltaForMessageRevisions(
  authoritativeRevisions: readonly CommittedMessageRevision[],
): WorkspaceDelta {
  if (authoritativeRevisions.length === 0) return { facts: [], invalidations: [] }
  const childSlots = new Map<string, { chatId: ChatId; parentId: MessageId | null }>()
  const previewIdsByChat = new Map<ChatId, MessageId[]>()
  for (const revision of authoritativeRevisions) {
    if (revision.changed.structure) {
      const addSlot = (parentId: MessageId | null) => {
        childSlots.set(`${revision.header.chatId}:${parentId ?? '__root__'}`, {
          chatId: revision.header.chatId,
          parentId,
        })
      }
      if (revision.before) addSlot(revision.before.parentId)
      addSlot(revision.header.parentId)
    }
    if (revision.changed.body) {
      const ids = previewIdsByChat.get(revision.header.chatId) ?? []
      ids.push(revision.header.id)
      previewIdsByChat.set(revision.header.chatId, ids)
    }
  }
  const parentIdsByChat = new Map<ChatId, Array<MessageId | null>>()
  for (const { chatId, parentId } of childSlots.values()) {
    const parentIds = parentIdsByChat.get(chatId) ?? []
    parentIds.push(parentId)
    parentIdsByChat.set(chatId, parentIds)
  }
  return {
    facts: authoritativeRevisions.map(
      (revision): WorkspaceDeltaFact => ({
        kind: 'message-revision',
        chatId: revision.header.chatId,
        structuralVersion: revision.structuralVersion,
        header: revision.header,
        changed: revision.changed,
      }),
    ),
    invalidations: normalizeWorkspaceDependencies([
      ...[...parentIdsByChat].map(
        ([chatId, parentIds]): WorkspaceDependency => ({
          kind: 'child-slot',
          chatId,
          parentIds,
        }),
      ),
      ...[...previewIdsByChat].map(
        ([chatId, messageIds]): WorkspaceDependency => ({
          kind: 'message-preview',
          chatId,
          messageIds,
        }),
      ),
    ]),
  }
}

const browserMutationSharedInternals: BrowserMutationSharedInternals = Object.freeze({
  applyMessageBodyPatch,
  applyMessageHeaderPatch,
  assertExistingMessageIdentity,
  assertOwnedStreamFence,
  assertStreamLeaseWorkspaceTarget,
  branchHeaderWordCount,
  calibrationUsageFromPostCommit,
  canApplyIncrementalBranchAppend,
  changedPatch,
  chatConfigurationTargetResourceNames,
  chatPreviewInTransaction,
  cloneDraft,
  cloneMessage,
  cloneMessageHeader,
  hydrateStoredAttachment,
  hydrateStoredMessage,
  listChildHeaderRows,
  loadChatOrThrow,
  materializeChatMutationState,
  messageCost,
  messageOutranksLeaf,
  messageSemanticEffect,
  newestLiveLeafIdInTransaction,
  nextBranchUpdatedAt,
  nextStreamLeaseRevision,
  readBranchPathInTransaction,
  recordMessageHeaderSummaryDeltas,
  recordMessageSummaryDeltas,
  replacementMessageBody,
  requireChatMetadataPatch,
  requiredStreamPostCommitEvidence,
  reserveStreamLeaseTarget,
  shouldBumpLastBranchUpdatedAtFromHeaders,
  shouldBumpStructuralLastBranchUpdatedAt,
  stableStringify,
  streamOwnedMessageFieldsChanged,
  transitionMessageGenerationForDispatch,
  validateGenerationPromptPathClaim,
})

class BrowserWorkspaceRepository implements WorkspaceRepository {
  private readonly session: BrowserWorkspaceSession
  private databasePromise: Promise<NatterDb> | null = null

  constructor(session: BrowserWorkspaceSession) {
    this.session = session
  }

  private openDb(): Promise<NatterDb> {
    const current = this.databasePromise
    if (current) return current
    const opening = this.session.open()
    this.databasePromise = opening
    void opening.catch(() => {
      if (this.databasePromise === opening) this.databasePromise = null
    })
    return opening
  }

  private async openReadFrame(
    permit: WorkspaceReadAuthority,
    signal: AbortSignal,
  ): Promise<BrowserWorkspaceReadFrame> {
    const db = await this.openDb()
    const sessionWorkspace = this.session.getWorkspaceFence()
    assertPermitFence(permit, sessionWorkspace)
    const frame: BrowserWorkspaceReadFrame = Object.freeze({
      db,
      permit,
      signal,
      workspace: Object.freeze({
        workspaceId: sessionWorkspace.workspaceId,
        replacementEpoch: sessionWorkspace.replacementEpoch,
        backendKind: 'browser-idb' as const,
      }),
    })
    this.assertReadFrameCurrent(frame)
    return frame
  }

  private finishReadFrame<T>(frame: BrowserWorkspaceReadFrame, value: T): ReadEnvelope<T> {
    this.assertReadFrameCurrent(frame)
    return {
      workspaceId: frame.workspace.workspaceId,
      replacementEpoch: frame.workspace.replacementEpoch,
      value,
    }
  }

  private assertReadFrameCurrent(frame: BrowserWorkspaceReadFrame): void {
    this.session.assertCurrent()
    assertWorkspaceReadPermit(frame.permit)
    throwIfWorkspaceQueryAborted(frame.signal)
  }

  async query<Q extends WorkspaceQuery>(
    permit: WorkspaceReadAuthority,
    query: Q,
    options: WorkspaceQueryOptions<Q> = {},
  ): Promise<ReadEnvelope<WorkspaceQueryResult<Q>>> {
    const linkedSignal = linkWorkspaceQuerySignals(permit.signal, options.signal)
    try {
      assertWorkspaceReadPermit(permit)
      throwIfWorkspaceQueryAborted(linkedSignal.signal)
      if (isBrowserInterchangeQuery(query)) {
        const { BrowserImportExportHandler } = await import('./browser-import-export')
        const handler = new BrowserImportExportHandler(await this.openDb())
        const read =
          query.kind === 'interchange.export-chat'
            ? await handler.exportChat(query.chatId)
            : query.kind === 'interchange.export-chat-preset'
              ? await handler.exportChatPreset(query.presetId)
              : query.kind === 'interchange.export-connection-profile'
                ? await handler.exportConnectionProfile(query.profileId)
                : await handler.exportWorkspaceBackup()
        assertWorkspaceReadPermit(permit)
        throwIfWorkspaceQueryAborted(linkedSignal.signal)
        return this.interchangeReadEnvelope(
          permit,
          read as BrowserImportExportRead<WorkspaceQueryResult<Q>>,
        )
      }

      if (query.kind === 'branch.open') {
        return (await this.readConversationOpenEnvelope(
          permit,
          query.chatId,
          query.target,
          query.bodyDemand,
          options.onStage as
            | ((stage: ReadEnvelope<ConversationDestinationPoint>) => void)
            | undefined,
          linkedSignal.signal,
        )) as ReadEnvelope<WorkspaceQueryResult<Q>>
      }

      if (query.kind === 'branch.page-structure') {
        return (await this.readConversationPageStructureEnvelope(
          permit,
          query.chatId,
          query.resolvedTipId,
          query.structuralVersion,
          query.window,
          linkedSignal.signal,
        )) as ReadEnvelope<WorkspaceQueryResult<Q>>
      }

      if (query.kind === 'message.headers-by-chat') {
        return (await this.readConversationTopologyEnvelope(
          permit,
          query.chatId,
          linkedSignal.signal,
        )) as ReadEnvelope<WorkspaceQueryResult<Q>>
      }

      if (query.kind === 'branch.forks') {
        return (await this.readConversationForksEnvelope(
          permit,
          query.chatId,
          query.structuralVersion,
          query.targets,
          linkedSignal.signal,
        )) as ReadEnvelope<WorkspaceQueryResult<Q>>
      }

      const frame = await this.openReadFrame(permit, linkedSignal.signal)
      const value = (
        query.kind === 'workspace.meta' ? frame.workspace : await this.dispatchQuery(query, frame)
      ) as WorkspaceQueryResult<Q>
      return this.finishReadFrame(frame, value)
    } finally {
      linkedSignal.dispose()
    }
  }

  private interchangeReadEnvelope<T>(
    permit: WorkspaceReadAuthority,
    read: BrowserImportExportRead<T>,
  ): ReadEnvelope<T> {
    assertPermitFence(permit, read.workspace)
    return {
      workspaceId: read.workspace.workspaceId,
      replacementEpoch: read.workspace.replacementEpoch,
      value: read.value,
    }
  }

  async execute<C extends WorkspaceCommand>(
    permit: WorkspaceWriteAuthority,
    command: C,
  ): Promise<CommitEnvelope<WorkspaceCommandResult<C>>> {
    assertWorkspaceExecutionPermit(permit)
    const db = this.session.runOperation((database) => database)
    const admission = await awaitStorageCompactionWriteAdmission()
    return withSharedAuthoritativeCommandSession(db, async (lockSession) => {
      const workspace = this.session.getWorkspaceFence()
      assertPermitFence(permit, workspace)
      const commandLifetimeReceipt = semanticOperationCommandLifetimeReceipt(
        workspace,
        db.name,
        admission,
      )
      const commit = new BrowserCommandCommit(
        db,
        lockSession,
        permit.workspaceId,
        permit.replacementEpoch,
        newId(),
        command,
        workspaceCommandSemanticOperationKind(command),
        commandLifetimeReceipt,
      )
      const value = (await this.dispatchCommand(
        command,
        permit.replacementEpoch,
        commit,
      )) as WorkspaceCommandResult<C>
      const chatEvidence = commit.materializeChatEvidence()
      const messageRevisions = commit
        .messageRevisions(chatEvidence.constructedChatIds)
        .filter(
          (revision) =>
            !revision.before || !sameMessageHeaderValue(revision.before, revision.header),
        )
      const messageDelta = commit.messageDelta(messageRevisions)
      const attemptTargetFacts = attemptTargetCommittedFacts(command, value)
      const attemptStopFacts = attemptStopRequestedFacts(command, value)
      const outcome = commit.finish()
      const rawDelta: WorkspaceDelta = outcome.didMutateStorage
        ? {
            facts: [
              ...chatEvidence.facts,
              ...commit.attachmentFacts(),
              ...messageDelta.facts,
              ...attemptTargetFacts,
              ...attemptStopFacts,
            ],
            invalidations: normalizeWorkspaceDependencies([
              ...outcome.extraInvalidations,
              ...chatEvidence.invalidations,
              ...messageDelta.invalidations,
            ]),
          }
        : { facts: [], invalidations: [] }
      const receipt: WorkspaceLocalReceipt = {
        chats: outcome.didMutateStorage ? chatEvidence.receiptChats : [],
        constructions: outcome.didMutateStorage ? chatEvidence.constructions : [],
        messageRevisions,
        childSlots: outcome.didMutateStorage
          ? commit.childSlots(chatEvidence.constructedChatIds)
          : [],
      }
      const terminalChatIds = new Set([
        ...chatEvidence.constructedChatIds,
        ...chatEvidence.deletedChatIds,
      ])
      if (outcome.didMutateStorage) {
        commit.assertPhysicalEvidenceCoverage(rawDelta, receipt, terminalChatIds)
      }
      const delta = outcome.didMutateStorage
        ? collapseConversationConstructionPublication(rawDelta)
        : rawDelta
      const effectScope =
        rawDelta.facts.length > 0 || rawDelta.invalidations.length > 0
          ? ('workspace' as const)
          : ('none' as const)
      const stamp = {
        workspaceId: outcome.fence.workspaceId,
        replacementEpoch: outcome.fence.replacementEpoch,
        commitId: commit.commitId,
      }
      return {
        ...stamp,
        effectScope,
        value,
        receipt,
        delta,
      }
    })
  }

  async replace<R extends WorkspaceReplacement>(
    replacement: R,
  ): Promise<WorkspaceReplacementEnvelope<WorkspaceReplacementResult<R>>> {
    return replaceBrowserRepository(replacement)
  }

  subscribeChanges(
    listener: (change: WorkspaceChange) => void,
    options?: { readonly delivery?: 'all' | 'remote' },
  ): () => void {
    return subscribeWorkspaceChanges(listener, options)
  }

  private async dispatchQuery(
    query: BrowserInlineQuery,
    frame: BrowserWorkspaceReadFrame,
  ): Promise<unknown> {
    const signalOptions = { signal: frame.signal }
    switch (query.kind) {
      case 'chat.get':
        return this.getChat(query.chatId)
      case 'chat.token-calibrations': {
        const db = frame.db
        const chats = await db.chats.bulkGet([...query.chatIds])
        return chats.map((chat) => {
          if (!chat) return undefined
          const tokenCalibration = chat.tokenCalibration
          return {
            chatId: chat.id,
            ...(tokenCalibration
              ? {
                  tokenCalibration: Object.fromEntries(
                    Object.entries(tokenCalibration).map(([key, sample]) => [key, { ...sample }]),
                  ),
                }
              : {}),
          }
        })
      }
      case 'sidebar.rows-by-id': {
        return readSidebarRowsById(frame.db, query.chatIds, frame.signal)
      }
      case 'sidebar.catalog-page': {
        return readSidebarCatalogPage(frame.db, query.request, frame.signal)
      }
      case 'sidebar.presentation-page': {
        return readSidebarPresentationPage(frame.db, query.request, frame.signal)
      }
      case 'sidebar.aggregate': {
        return readSidebarAggregate(frame.db)
      }
      case 'sidebar.created-at-group-count': {
        return readSidebarCreatedAtGroupCount(frame.db, query.request, frame.signal)
      }
      case 'chat.next-fork-title':
        return this.nextForkTitle(query.baseTitle)
      case 'configuration.discovery-snapshot':
        return this.getConnectionDiscoverySnapshot(query.profileId)
      case 'configuration.shell':
        return this.getConfigurationShell(frame.signal)
      case 'configuration.global-token-calibration':
        return this.getConfigurationGlobalTokenCalibration(frame.signal)
      case 'configuration.text-template-catalog':
        return this.getConfigurationTextTemplateCatalog(frame.signal)
      case 'configuration.active-selection':
        return this.getConfigurationActiveSelection(query.target, frame.signal)
      case 'configuration.active-model':
        return this.getConfigurationActiveModel(
          query.profileId,
          query.modelId,
          query.revision,
          query.includeModels,
          query.knownPayloads,
          frame.signal,
        )
      case 'configuration.profile-switch-plan':
        return this.getConfigurationProfileSwitchPlan(query.chatId, query.profileId)
      case 'configuration.model-resolution-head':
        return this.getConfigurationModelResolutionHead(frame.signal)
      case 'configuration.model-resolution-page':
        return this.getConfigurationModelResolutionPage(
          query.profileId,
          query.profileRevision,
          query.knownModels,
          frame.signal,
        )
      case 'configuration.profile-catalog-page':
        return this.getConfigurationProfileCatalogPage(query.request, frame.signal)
      case 'configuration.preset-catalog-page':
        return this.getConfigurationPresetCatalogPage(query.request, frame.signal)
      case 'configuration.prompt-preset-catalog-page':
        return this.getConfigurationPromptPresetCatalogPage(
          query.promptKind,
          query.request,
          frame.signal,
        )
      case 'configuration.connection-manager-page':
        return this.getConfigurationConnectionManagerPage(query.request, frame.signal)
      case 'configuration.generated-output-network-access':
        return this.getGeneratedOutputNetworkAccess(
          query.profileIds,
          query.url,
          query.requestCredential,
        )
      case 'key.get':
        return this.getKey(query.keyId)
      case 'setting.get':
        return this.getSetting(query.key)
      case 'setting.get-many':
        return Object.fromEntries(await this.getSettings(query.keys, signalOptions))
      case 'folder.list':
        return this.listFolders()
      case 'tag.list':
        return this.listTags()
      case 'message.presentation':
        return (await this.getExactMessagePresentations([query.messageId], frame.signal))[0]
      case 'message.presentations':
        return this.getExactMessagePresentations(query.messageIds, frame.signal)
      case 'message.preview-window':
        return this.getMessageTextPreviewWindow(query.targets, {
          ...(query.maxChars === undefined ? {} : { maxChars: query.maxChars }),
          ...signalOptions,
        })
      case 'message.search-corpus':
        return searchMessageCorpusInBrowser(frame.db, query.request, frame.signal)
      case 'branch.child-at-position':
        return this.getActiveBranchChildAtPosition(
          query.chatId,
          query.parentId,
          query.position,
          frame.signal,
        )
      case 'stream.lease':
        return this.getStreamLease(query.streamId)
      case 'stream.lease-head':
        return this.getStreamLeaseHead()
      case 'stream.leases-by-id':
        return this.getStreamLeases(query.streamIds, signalOptions)
      case 'stream.leases':
        return this.listStreamLeases(query.chatId, signalOptions)
      case 'stream.journal-frame-page':
        return readStreamJournalFramePage(frame.db, query, signalOptions)
      case 'attachment.get':
        return this.getAttachment(query.attachmentId)
      case 'attachment.generation-token-evidence':
        return this.getAttachmentGenerationTokenEvidence(query.attachmentId)
      case 'attachment.get-many':
        return this.getAttachments(query.attachmentIds, signalOptions)
      case 'attachment.media':
        return this.getAttachmentMedia(query.attachmentId, query.purpose, frame.signal)
      case 'attachment.media-many':
        return this.getAttachmentMediaMany(query.attachmentIds, query.purpose, frame.signal)
      case 'attachment.bundle':
        return this.getAttachmentBundle(query.attachmentId)
      case 'attachment.dispatch-bundle':
        return this.getAttachmentDispatchBundle(query.attachmentId)
      case 'attachment.find-hash':
        return this.findAttachmentIdByContentHash(
          query.filename,
          query.contentHash,
          query.excludeId,
        )
      case 'attachment.references':
        return this.listAttachmentReferenceEdges(query.attachmentId)
      case 'attachment.reference-rows':
        return this.listAttachmentReferenceRows(query.attachmentId)
      case 'attachment.catalog-rows':
        return readAttachmentCatalogRows(frame.db, query.attachmentIds, frame.signal)
      case 'attachment.catalog-page':
        return readAttachmentCatalogPage(frame.db, query.search, frame.signal)
      case 'attachment.catalog-evaluate':
        return evaluateAttachmentCatalogRows(
          frame.db,
          query.search,
          query.attachmentIds,
          frame.signal,
        )
      case 'attachment.catalog-aggregate':
        return readAttachmentCatalogAggregate(frame.db)
      case 'attachment.manager-detail': {
        const db = frame.db
        return db.transaction(
          'r',
          [
            db.attachmentCatalogRows,
            db.attachmentArtifacts,
            db.attachmentJobs,
            db.attachmentRefEdges,
            db.messages,
            db.drafts,
            db.chats,
          ],
          async () => {
            const core = await readAttachmentManagerCore(db, query.attachmentId)
            if (!core) return undefined
            return {
              ...core,
              references: await this.listAttachmentReferenceRows(query.attachmentId),
            }
          },
        )
      }
      case 'generated-output.localization-queue':
        return this.getGeneratedOutputLocalizationQueue(query.now, query.limit)
      case 'draft.get':
        return this.getDraft(query.chatId)
      case 'discovery.models':
        return this.readDiscoveryCacheRow('models', [query.profileId, query.queryKey])
      case 'discovery.endpoints':
        return this.readDiscoveryCacheRow('endpoints', [query.profileId, query.modelId])
      case 'discovery.privacy':
        return this.readDiscoveryCacheRow('privacyPolicies', [query.profileId, query.modelId])
      default:
        return assertNever(query)
    }
  }

  private messageMutationRepository(commit: BrowserCommandCommit): MessageMutationRepository {
    return {
      getChat: (chatId) => this.getChat(chatId),
      getMessage: (messageId) => this.getMessage(messageId),
      getMessageHeader: (messageId) => this.getMessageHeader(messageId),
      getMessageHeaders: (messageIds) => this.getMessageHeaders(messageIds),
      listChildHeaders: (chatId, parentId) => this.listChildHeaders(chatId, parentId),
      runMutation: (scopes, fn, finalize) =>
        this.runMutation(scopes, fn, undefined, commit, finalize),
    }
  }

  private async dispatchCommand(
    command: WorkspaceCommand,
    replacementEpoch: number,
    commit: BrowserCommandCommit,
  ): Promise<unknown> {
    switch (command.kind) {
      case 'interchange.import-chat': {
        const { BrowserImportExportHandler } = await import('./browser-import-export')
        return new BrowserImportExportHandler(await this.openDb(), commit).importChat(
          command.envelope,
          command.options,
        )
      }
      case 'interchange.import-chat-preset': {
        const { BrowserImportExportHandler } = await import('./browser-import-export')
        return new BrowserImportExportHandler(await this.openDb(), commit).importChatPreset(
          command.envelope,
          command.options,
        )
      }
      case 'interchange.import-connection-profile': {
        const { BrowserImportExportHandler } = await import('./browser-import-export')
        return new BrowserImportExportHandler(await this.openDb(), commit).importConnectionProfile(
          command.envelope,
          command.options,
        )
      }
      case 'chat.discard-empty-drafts':
        return this.discardEmptyDraftChats(command, commit)
      case 'chat.materialize-temporary':
        return this.materializeTemporaryChat(command.input, replacementEpoch, commit)
      case 'chat.set-archived':
        return this.setChatsArchived(command.chatIds, command.archived, command.now, commit)
      case 'chat.delete-archived':
        return this.deleteArchivedChatRows(command.chatIds, command.now, commit)
      case 'chat.empty-archive':
        return this.emptyArchivedChatRows(command, commit)
      case 'chat.move-to-folder':
        return this.moveChatRowsToFolder(command.chatIds, command.folderId, command.now, commit)
      case 'chat.set-tags-from-names':
        return this.setChatRowsTagsFromNames(command.chatIds, command.names, command.now, commit)
      case 'chat.touch-viewed':
        return this.touchChatViewed(command.chatId, command.now, commit)
      case 'chat.set-manual-title':
        return this.setChatManualTitle(command.chatId, command.title, command.now, commit)
      case 'chat.calibration.clear':
        return this.clearChatCalibration(command, commit)
      case 'chat.calibration.clear-family':
        return this.clearCalibrationEverywhere(command, commit)
      case 'chat.calibration.clear-all':
        return this.clearCalibrationEverywhere(command, commit)
      case 'chat.fork':
        return this.forkChatFromMessage(command.input, commit)
      case 'message.edit-content':
        return editMessageContentInRepository(
          this.messageMutationRepository(commit),
          command.input,
          this,
        )
      case 'message.toggle-reasoning-detail':
      case 'message.toggle-provider-output-item':
      case 'message.toggle-context':
      case 'message.dismiss-generation-notice':
        return mutateMessageBodyInRepository(this.messageMutationRepository(commit), command)
      case 'message.import':
        return pasteImportInRepository(this.messageMutationRepository(commit), command.input)
      case 'message.delete': {
        const mode = command.mode
        switch (mode) {
          case 'pair':
            return deletePairInRepository(this.messageMutationRepository(commit), command.input)
          case 'single':
            return deleteSingleMessageInRepository(
              this.messageMutationRepository(commit),
              command.input,
            )
          case 'turn':
            return deleteTurnInRepository(this.messageMutationRepository(commit), command.input)
          case 'variant':
            return deleteVariantInRepository(this.messageMutationRepository(commit), command.input)
        }
        return assertNever(mode)
      }
      case 'message.restore-structure': {
        return applyStructuralSnapshotInRepository(
          this.messageMutationRepository(commit),
          command.input,
        )
      }
      case 'attempt.prepare':
        return this.prepareAttempt(command.input, replacementEpoch, commit)
      case 'attempt.dispatch':
        return this.dispatchAttempt(command.input, replacementEpoch, commit)
      case 'attempt.request-stop':
        return this.requestAttemptStop(command.input, replacementEpoch, commit)
      case 'attempt.seal-terminal':
        return this.sealAttemptTerminal(command.input, replacementEpoch, commit)
      case 'attempt.finalize':
        return this.finalizeAttempt(command.input, replacementEpoch, commit)
      case 'generation.post-commit-metadata':
        return this.commitGenerationMetadata(command.input, replacementEpoch, commit)
      case 'stream.note-selected-key':
        return this.noteStreamSelectedKey(command.input, replacementEpoch, commit)
      case 'stream.renew':
        return this.renewStreamLease(command.heartbeat, commit)
      case 'stream.handoff-recovery':
        return this.handoffStreamLeaseForRecovery(command.input, replacementEpoch, commit)
      case 'stream.claim-recovery':
        return this.claimStreamLeaseForRecovery(command.expected, command.now, commit)
      case 'stream.append-journal-frames':
        return this.appendStreamJournalFrames(command.frames, command.observedAt, commit)
      case 'stream.finish-cleanup':
        return this.deleteStreamJournal(
          command.streamId,
          {
            replacementEpoch,
            streamFence: command.fence,
          },
          commit,
        )
      case 'maintenance.reconcile-stream-journal-integrity':
        return this.reconcileStreamJournalIntegrity(command.limit, commit)
      case 'maintenance.prune-terminal-stream-journals':
        return this.pruneTerminalStreamJournals(
          command.now,
          command.maxAgeMs,
          command.limit,
          commit,
        )
      case 'maintenance.prune-empty-draft-chats':
        return this.pruneEmptyDraftChats(command, commit)
      case 'maintenance.prune-discovery-cache':
        return this.pruneDiscoveryCache(command.limit, commit)
      case 'maintenance.reconcile-attachment-integrity':
        return this.reconcileAttachmentIntegrity(command.limit, command.now, commit)
      case 'attachment.bundle.write':
        return this.writeAttachmentBundle(command.input, commit)
      case 'attachment.ref.add':
        return this.addAttachmentReference(command.input, commit)
      case 'attachment.ref.set-visibility':
        return this.setAttachmentReferenceVisibility(command.input, commit)
      case 'attachment.ref.detach':
        return this.detachAttachmentReference(command.input, commit)
      case 'attachment.ref.relink':
        return this.relinkAttachmentReferences(command.input, commit)
      case 'attachment.bytes.delete':
        return this.deleteAttachmentBytes(command.input, commit)
      case 'attachment.delete-if-unreferenced':
        return this.deleteAttachmentIfUnreferenced(command.attachmentId, commit)
      case 'attachment.delete-many':
        return this.deleteManyAttachments(command.input, commit)
      case 'attachment.reap':
        return this.reapAttachments(command.now, command.maxAgeMs, command.limit, commit)
      case 'draft.put':
        return this.putDraftRow(command.input, commit)
      case 'generated-output.localization-claim':
        return this.claimGeneratedOutputLocalization(command.input, commit)
      case 'generated-output.localization-retry':
        return this.retryGeneratedOutputLocalization(command.input, commit)
      case 'generated-output.localization-fail':
        return this.failGeneratedOutputLocalization(command.input, commit)
      case 'generated-output.localization-complete':
        return this.completeGeneratedOutputLocalization(command.input, commit)
      case 'generated-output.video-expand':
        return this.expandGeneratedOutputVideo(command.input, commit)
      case 'discovery.models.put':
      case 'discovery.endpoints.put':
      case 'discovery.privacy.put':
      case 'discovery.models.delete':
        return this.mutateDiscoveryCache(command, replacementEpoch, commit)
      case 'configuration.execute': {
        const { executeConfigurationCommandInBrowser } = await import(
          './browser-configuration-domain'
        )
        return executeConfigurationCommandInBrowser(command.input, commit)
      }
      case 'folder.create':
        return this.createFolder(command.input, commit)
      case 'folder.update':
        return this.updateFolder(command.folderId, command.patch, commit)
      case 'folder.delete':
        return this.deleteFolder(
          command.folderId,
          command.chatDisposition ?? 'move-top-level',
          command.now ?? Date.now(),
          commit,
        )
      case 'folder.ensure-and-move-chats':
        return this.ensureFolderAndMoveChats(command.input, commit)
      default:
        return assertNever(command)
    }
  }

  private async getExactMessagePresentations(
    messageIds: readonly MessageId[],
    signal?: AbortSignal,
  ): Promise<Array<MessagePresentation | undefined>> {
    if (signal?.aborted) throw signal.reason
    const db = await this.openDb()
    const rows = await readExactMessageRowsByIdPages(db, messageIds, signal ? { signal } : {})
    return rows.map((row) => {
      if (!row) return undefined
      const clonedHeader = cloneMessageHeader(row.header)
      return {
        header: clonedHeader,
        message: hydrateMessageWithOwnedBody(clonedHeader, row.body),
        bodyVersion: clonedHeader.bodyVersion,
      }
    })
  }

  private async prepareAttempt(
    input: PrepareAttemptInput,
    replacementEpoch: number,
    commit: BrowserCommandCommit,
  ): Promise<AttemptPrepareResult> {
    const { prepareBrowserAttempt } = await import('./browser-generation-command-runtime')
    return prepareBrowserAttempt(
      this,
      browserGenerationCommandSupport,
      input,
      replacementEpoch,
      commit,
    )
  }

  private async dispatchAttempt(
    input: AttemptDispatchInput,
    replacementEpoch: number,
    commit: BrowserCommandCommit,
  ): Promise<AttemptDispatchResult> {
    const { dispatchBrowserAttempt } = await import('./browser-generation-command-runtime')
    return dispatchBrowserAttempt(this, input, replacementEpoch, commit)
  }

  private async sealAttemptTerminal(
    input: AttemptSealTerminalInput,
    replacementEpoch: number,
    commit: BrowserCommandCommit,
  ): Promise<TerminalDecidedStreamLeaseRow> {
    if (!Number.isSafeInteger(input.finishedAt) || input.finishedAt < 0) {
      throw new Error(`AttemptTerminalTimestampInvalid:${input.streamId}`)
    }
    const replay = attemptTerminalReplayPlan(
      input.streamId,
      streamWriteFenceReplayTokens(input.fence),
      'request',
    )
    return executeStreamLeaseOperation<TerminalDecidedStreamLeaseRow>(
      commit,
      ATTEMPT_SEAL_TERMINAL_OPERATION,
      input.streamId,
      replay,
      (lease) => {
        assertOwnedStreamFence(lease, input.fence, replacementEpoch, input.streamId)
        const terminal = {
          version: 1 as const,
          finishedAt: Math.max(input.finishedAt, lease.stopControl?.requestedAt ?? 0),
          journalMaxSeq: lease.journalMaxSeq ?? -1,
          journalCompleteness: input.journalCompleteness,
          decision: structuredClone(
            lease.stopControl
              ? { outcome: 'abort' as const, abortReason: lease.stopControl.reason }
              : input.decision,
          ),
        }
        if (lease.phase === 'terminal-decided') {
          if (stableStringify(lease.terminal) !== stableStringify(terminal)) {
            throw new Error(`AttemptTerminalDecisionConflict:${input.streamId}`)
          }
          return { value: structuredClone(lease) }
        }
        if (lease.phase !== 'reserved' && lease.phase !== 'active') {
          throw new Error(`AttemptTerminalSealPhaseInvalid:${input.streamId}:${lease.phase}`)
        }
        const decided = requireStreamLeaseRow({
          ...lease,
          phase: 'terminal-decided',
          dispatch: lease.phase === 'active' ? lease.dispatch : null,
          terminal,
          revision: nextStreamLeaseRevision(lease),
        })
        if (decided.phase !== 'terminal-decided' || !streamLeaseHasWriteFence(decided)) {
          throw new Error(`AttemptTerminalSealInvalid:${input.streamId}`)
        }
        return { value: structuredClone(decided), next: decided }
      },
      (_current, decision) =>
        observedAttemptTerminalReplayPlan(decision.value, decision.next !== undefined),
    )
  }

  private async requestAttemptStop(
    input: AttemptRequestStopInput,
    replacementEpoch: number,
    commit: BrowserCommandCommit,
  ): Promise<AttemptRequestStopResult> {
    if (!Number.isSafeInteger(input.requestedAt) || input.requestedAt < 0) {
      throw new Error(`AttemptStopRequestInvalid:${input.streamId}`)
    }
    if (input.replacementEpoch !== replacementEpoch) return { outcome: 'stale' }
    const replay = attemptStopReplayPlan(input.streamId, attemptStopTarget(input), 'request')
    return executeStreamLeaseOperation<AttemptRequestStopResult>(
      commit,
      ATTEMPT_REQUEST_STOP_OPERATION,
      input.streamId,
      replay,
      (lease) => {
        if (!lease) return { value: { outcome: 'missing' } as const }
        if (
          lease.chatId !== input.chatId ||
          lease.messageId !== input.messageId ||
          lease.attemptKind !== input.attemptKind ||
          lease.replacementEpoch !== input.replacementEpoch ||
          lease.admissionSequence !== input.admissionSequence
        ) {
          return {
            value: { outcome: 'stale', lease: structuredClone(lease) } as const,
          }
        }
        if (lease.phase === 'canonical' || lease.phase === 'metadata-committed') {
          return {
            value: { outcome: 'terminal', lease: structuredClone(lease) } as const,
          }
        }
        if (lease.stopControl) {
          return {
            value: { outcome: 'already-requested', lease: structuredClone(lease) } as const,
          }
        }
        if (lease.controlRevision >= Number.MAX_SAFE_INTEGER) {
          throw new Error(`StreamLeaseControlRevisionExhausted:${input.streamId}`)
        }
        const terminal =
          lease.phase === 'terminal-decided'
            ? {
                ...lease.terminal,
                finishedAt: Math.max(lease.terminal.finishedAt, input.requestedAt),
                decision: {
                  outcome: 'abort' as const,
                  abortReason: input.reason,
                },
              }
            : undefined
        const stopped = requireStreamLeaseRow({
          ...lease,
          ...(terminal ? { terminal } : {}),
          revision: nextStreamLeaseRevision(lease),
          controlRevision: lease.controlRevision + 1,
          stopControl: {
            requestId: input.requestId,
            requestedBy: input.requestedBy,
            requestedAt: input.requestedAt,
            reason: input.reason,
          },
        })
        return {
          value: { outcome: 'accepted', lease: structuredClone(stopped) } as const,
          next: stopped,
        }
      },
      (current, decision) => observedAttemptStopReplayPlan(current, decision, input.streamId),
    )
  }

  private async finalizeAttempt(
    input: AttemptTerminalProjection,
    replacementEpoch: number,
    commit: BrowserCommandCommit,
  ): Promise<AttemptFinalizeResult> {
    const { finalizeBrowserAttempt } = await import('./browser-generation-command-runtime')
    return finalizeBrowserAttempt(
      this,
      browserGenerationCommandSupport,
      input,
      replacementEpoch,
      commit,
    )
  }

  private async commitGenerationMetadata(
    input: GenerationPostCommitMetadataInput,
    replacementEpoch: number,
    commit: BrowserCommandCommit,
  ): Promise<GenerationPostCommitMetadataResult> {
    const { commitBrowserGenerationMetadata } = await import('./browser-generation-command-runtime')
    return commitBrowserGenerationMetadata(
      browserGenerationCommandSupport,
      input,
      replacementEpoch,
      commit,
    )
  }

  private async noteStreamSelectedKey(
    input: StreamNoteSelectedKeyInput,
    replacementEpoch: number,
    commit: BrowserCommandCommit,
  ): Promise<StreamLeaseRow> {
    return executeStreamLeaseOperation<StreamLeaseRow>(
      commit,
      STREAM_NOTE_SELECTED_KEY_OPERATION,
      input.streamId,
      selectedKeyReplayPlan(
        input.streamId,
        streamWriteFenceReplayTokens(input.fence),
        input.selectedKeyId,
      ),
      (lease) => {
        assertOwnedStreamFence(lease, input.fence, replacementEpoch, input.streamId)
        if (!streamLeaseHasCommittedTarget(lease)) {
          throw new Error(`StreamSelectedKeyBeforeDispatch:${input.streamId}`)
        }
        const evidence = requiredStreamPostCommitEvidence(lease)
        const recordedKeyId = evidence.selectedKeyId ?? evidence.final?.selectedKeyId
        if (recordedKeyId !== undefined && recordedKeyId !== input.selectedKeyId) {
          throw new Error(`StreamSelectedKeyMismatch:${input.streamId}`)
        }
        if (
          lease.phase === 'terminal-decided' ||
          lease.phase === 'canonical' ||
          lease.phase === 'metadata-committed'
        ) {
          if (recordedKeyId === input.selectedKeyId) {
            return { value: structuredClone(lease) }
          }
          throw new Error(`StreamSelectedKeyAfterTerminalDecision:${input.streamId}`)
        }
        if (
          evidence.selectedKeyId === input.selectedKeyId &&
          (evidence.final === undefined || evidence.final.selectedKeyId === input.selectedKeyId)
        ) {
          return { value: structuredClone(lease) }
        }
        const noted = requireStreamLeaseRow({
          ...lease,
          revision: nextStreamLeaseRevision(lease),
          postCommit: {
            ...evidence,
            selectedKeyId: input.selectedKeyId,
            ...(evidence.final
              ? {
                  final: {
                    ...evidence.final,
                    selectedKeyId: input.selectedKeyId,
                  },
                }
              : {}),
          },
        })
        return { value: structuredClone(noted), next: noted }
      },
      (lease, decision) => {
        const resultingLease = decision.next ?? lease
        if (!resultingLease)
          throw new Error(`StreamSelectedKeyReplayLeaseMissing:${input.streamId}`)
        return observedSelectedKeyReplayPlan(resultingLease)
      },
    )
  }

  async forkChatFromMessage(
    input: ForkChatFromMessageInput,
    commit: BrowserCommandCommit,
  ): Promise<ForkChatFromMessageResult> {
    const [
      { buildChildSlotProjection },
      { applyAttachmentReferenceOwnerTransitions },
      { proveConversationSelectionInTransaction },
    ] = await Promise.all([
      import('../core/child-list-state'),
      import('./attachment-reference-edges'),
      import('./conversation-destination-seal'),
    ])
    const destinationChatId = input.destinationChatId ?? newId()
    const now = input.now ?? Date.now()
    return commit.executeSemanticOperation(
      CHAT_FORK_OPERATION,
      {
        sourceChatId: input.chatId,
        targetMessageId: input.messageId,
        destinationChatId,
      },
      async (tx) => {
        const chatTable = tx.table<Chat, ChatId>('chats')
        const source = await chatTable.get(input.chatId)
        if (!source) throw new Error(`fork: source chat ${input.chatId} not found`)
        if (await chatTable.get(destinationChatId)) {
          throw new Error(`fork: destination chat ${destinationChatId} already exists`)
        }

        const headers = await readForkLivePathHeaders(
          tx.table<MessageHeaderRow, MessageId>('messages'),
          input.chatId,
          input.messageId,
        )
        if (headers.length === 0) throw new Error('fork: no ancestors to copy')
        const bodies = await tx
          .table<MessageBodyRow, MessageId>('messageBodies')
          .bulkGet(headers.map((header) => header.id))
        const ancestors = hydrateMessages(
          headers,
          bodies.filter((body): body is MessageBodyRow => body !== undefined),
        )
        const destinationMessageIds = ancestors.map(() => newId())
        const messages = cloneForkMessages(ancestors, destinationChatId, destinationMessageIds, now)
        const lastUpdatedLeafId = findLastUpdatedLeafId(messages)
        const selectedTipId = messages.at(-1)?.id ?? null
        const updatedAt = await nextChatUpdatedAtInTransaction(tx, now)
        const chat: Chat = {
          id: destinationChatId,
          title: input.title,
          titleStatus: 'manual',
          createdAt: now,
          updatedAt,
          lastViewedAt: now,
          wordCount: countMessagesWords(messages),
          totalCostUsd: computeTotalCostUsd(messages),
          metaVersion: 0,
          summaryVersion: 1,
          structuralVersion: 1,
          settings: structuredClone(source.settings),
          lastUpdatedLeafId,
          lastBranchUpdatedAt: updatedAt,
          archived: false,
          pinned: false,
          folderId: null,
          tags: [],
          previewText: previewTextFromMessages(messages),
          ...(source.presetId ? { presetId: source.presetId } : {}),
        }

        const chatMutation = openLinkedChatMutation(tx)
        await chatMutation.add(chat)
        await chatMutation.commit()
        const storageRows = messages.map((message) =>
          splitMessageForStorage(message, {
            updatedAt: now,
          }),
        )
        await Promise.all([
          addPhysicalStorageRows(
            tx,
            'messages',
            storageRows.map(({ header }) => header),
          ),
          addPhysicalStorageRows(
            tx,
            'messageBodies',
            storageRows.map(({ body }) => body),
          ),
          addPhysicalStorageRows(
            tx,
            'messagePreviews',
            storageRows.map(({ preview }) => preview),
          ),
        ])
        const childProjection = buildChildSlotProjection(destinationChatId, messages, {
          updatedAt: now,
          defaultVersion: 1,
        })
        await Promise.all([
          addPhysicalStorageRows(tx, 'childLists', childProjection.states),
          addPhysicalStorageRows(tx, 'childSlotMembers', childProjection.members),
        ])
        const selectedStorage = storageRows.at(-1)
        const destination = await proveConversationSelectionInTransaction(tx, {
          chat,
          target: fixedConversationSelectionTarget(
            selectedTipId === null
              ? { kind: 'default' }
              : { kind: 'tip', messageId: selectedTipId },
            selectedTipId,
          ),
          tipId: selectedTipId,
          exactPathHeaders: storageRows.map(({ header }) => header),
          presentations:
            selectedStorage && selectedTipId
              ? [
                  {
                    header: selectedStorage.header,
                    message: messages[messages.length - 1] as Message,
                    bodyVersion: selectedStorage.header.bodyVersion,
                  },
                ]
              : [],
        })
        await applyAttachmentReferenceOwnerTransitions(
          tx,
          messages.map((message) => ({
            ownerKind: 'message' as const,
            ownerId: message.id,
            chatId: message.chatId,
            previousRefs: undefined,
            nextRefs: message.attachmentRefs,
          })),
          now,
        )
        return {
          chatId: destinationChatId,
          messageCount: messages.length,
          destination,
        }
      },
    )
  }

  private async nextForkTitle(baseTitle: string): Promise<string> {
    const base = baseTitle.trim() || 'Untitled chat'
    const rows = await (await this.openDb()).chatSidebarRows
      .where('title')
      .startsWith(`${base} Branch `)
      .toArray()
    return computeBranchTitle(
      base,
      rows.map((row) => row.title),
    )
  }

  private async materializeTemporaryChat(
    input: Extract<WorkspaceCommand, { kind: 'chat.materialize-temporary' }>['input'],
    replacementEpoch: number,
    commit: BrowserCommandCommit,
  ) {
    const runtime = await import('./browser-catalog-command-runtime')
    return runtime.materializeTemporaryChat(this, input, replacementEpoch, commit)
  }

  async discardEmptyDraftChats(
    input: {
      chatIds: readonly ChatId[]
      now?: number
      staleBefore?: number
    },
    commit: BrowserCommandCommit,
  ): Promise<DeleteArchivedChatMetadataResult> {
    const runtime = await import('./browser-catalog-command-runtime')
    return runtime.discardEmptyDraftChats(input, commit)
  }

  private async pruneEmptyDraftChats(
    input: {
      maxAgeMs: number
      limit: number
      now: number
    },
    commit: BrowserCommandCommit,
  ) {
    const limit = Math.min(boundedMaintenanceLimit(input.limit), CHAT_CLOSURE_BATCH_LIMIT)
    return commit.executeSemanticOperation(
      EMPTY_DRAFT_RETENTION_OPERATION,
      undefined,
      async (tx) => {
        const currentState = await readStorageRetentionState(tx, 'empty-draft-prune')
        const cycle = storageRetentionCycle(currentState, input.now, input.maxAgeMs)
        const page = await readTemporaryChatIdPage(tx, {
          ...(cycle.cursor === undefined ? {} : { after: cycle.cursor }),
          cutoff: cycle.cutoff,
          limit,
        })
        const closure = await deleteEligibleEmptyDraftChatClosure(
          tx,
          page.chatIds,
          cycle.cutoff,
          cycle.cycleNow,
        )
        const next = advanceStorageRetentionState(
          cycle,
          page.done
            ? {
                done: true,
                ...(page.earliestDeferredAt === undefined
                  ? {}
                  : { earliestDeferredAt: page.earliestDeferredAt }),
              }
            : {
                done: false,
                ...(page.nextCursor === undefined ? {} : { cursor: page.nextCursor }),
              },
        )
        await putPhysicalStorageRow<
          StorageRetentionStateRowFor<'empty-draft-prune'>,
          StorageRetentionTask
        >(tx, 'storageRetentionState', next, currentState)
        recordBrowserCommandStorageRetentionMutation(tx, 'empty-draft-prune')
        return {
          deletedChatIds: closure.deletedChatIds,
          affectedAttachmentIds: closure.affectedAttachmentIds,
          scannedChatIds: page.chatIds.length,
          ...(page.earliestDeferredAt === undefined
            ? {}
            : { earliestDeferredAt: page.earliestDeferredAt }),
          done: page.done,
        }
      },
    )
  }

  private async getConnectionDiscoverySnapshot(profileId: ProfileId) {
    const db = await this.openDb()
    return db.transaction('r', [db.profiles, db.keys], async (tx: Transaction) => {
      const profile = await tx.table<ConnectionProfile, ProfileId>('profiles').get(profileId)
      if (!profile) return undefined
      const key = profile.apiKeyRef
        ? await tx.table<KeyRecord, KeyId>('keys').get(profile.apiKeyRef)
        : undefined
      return {
        profile: Object.freeze({ id: profile.id, ...connectionHttpProfile(profile) }),
        revision: configurationRequestRevisionFor(profile, key),
        ...(key ? { primaryKey: keyDispatchProof(key) } : {}),
      }
    })
  }

  private async getConfigurationShell(signal?: AbortSignal): Promise<ConfigurationShellProjection> {
    signal?.throwIfAborted()
    const db = await this.openDb()
    return db.transaction(
      'r',
      [db.configurationCatalogAggregates, db.settings],
      async (tx: Transaction) => {
        const keys = [
          ...GLOBAL_PREFERENCE_KEYS,
          IMAGE_ALLOWLIST_KEY,
          RENDERING_PREFERENCES_KEY,
          SAMPLE_PROMPTS_DISMISSED_KEY,
          SIDEBAR_SORT_SETTING_KEY,
          SIDEBAR_COLLAPSED_FOLDERS_SETTING_KEY,
        ]
        const [rows, aggregate] = await Promise.all([
          tx.table<SettingsRow, string>('settings').bulkGet(keys),
          tx
            .table<{ id: string; totalProfileCount: number }, string>(
              'configurationCatalogAggregates',
            )
            .get('global'),
        ])
        signal?.throwIfAborted()
        if (!aggregate) throw new Error('ConfigurationCatalogAggregateMissing')
        return {
          preferences: configurationPreferencesFromValues(
            new Map(keys.map((key, index) => [key, rows[index]?.value] as const)),
          ),
          totalProfileCount: aggregate.totalProfileCount,
        }
      },
    )
  }

  private async getConfigurationGlobalTokenCalibration(
    signal?: AbortSignal,
  ): Promise<GlobalTokenCalibration> {
    signal?.throwIfAborted()
    const row = await (await this.openDb()).settings.get(GLOBAL_TOKEN_CALIBRATION_KEY)
    signal?.throwIfAborted()
    return normalizeGlobalTokenCalibration(row?.value)
  }

  private async getConfigurationTextTemplateCatalog(
    signal?: AbortSignal,
  ): Promise<readonly SavedTextTemplateCatalogRow[]> {
    signal?.throwIfAborted()
    return readTextTemplateCatalog((await this.openDb()).textTemplates, signal)
  }

  private async getConfigurationActiveSelection(
    target: ConfigurationSelectionQueryTarget,
    signal?: AbortSignal,
  ): Promise<ConfigurationActiveSelectionProjection> {
    signal?.throwIfAborted()
    const db = await this.openDb()
    return db.transaction(
      'r',
      [
        db.configurationPresetCatalogRows,
        db.configurationProfileCatalogRows,
        db.configurationPromptPresetCatalogRows,
        db.keys,
        db.presets,
        db.profiles,
        db.textTemplates,
      ],
      async (tx: Transaction) => {
        const profiles = tx.table<ConnectionProfile, ProfileId>('profiles')
        const presets = tx.table<ChatPreset, PresetId>('presets')
        let profile = target.profileId ? ((await profiles.get(target.profileId)) ?? null) : null
        let preset = target.presetId ? ((await presets.get(target.presetId)) ?? null) : null

        if (target.kind === 'chat') {
          if (preset && profile && preset.connectionProfileId !== profile.id) preset = null
        } else {
          if (profile?.archived) profile = null
          if (preset?.archived) preset = null
          if (target.fallback === 'none') {
            if (preset && (!profile || preset.connectionProfileId !== profile.id)) preset = null
          } else if (target.fallback === 'missing-profile') {
            if (profile) {
              if (preset && preset.connectionProfileId !== profile.id) preset = null
            } else {
              preset = null
              const profileId = await readDefaultConfigurationProfileId(tx)
              profile = profileId ? ((await profiles.get(profileId)) ?? null) : null
            }
          } else {
            if (preset && profile && preset.connectionProfileId !== profile.id) preset = null
            let selectedPresetId = preset?.id ?? null
            if (!selectedPresetId) {
              selectedPresetId = await readDefaultConfigurationPresetId(tx, profile?.id ?? null)
            }
            preset = selectedPresetId ? ((await presets.get(selectedPresetId)) ?? null) : null
            if (preset) {
              profile = (await profiles.get(preset.connectionProfileId)) ?? null
            } else if (!profile) {
              const profileId = await readDefaultConfigurationProfileId(tx)
              profile = profileId ? ((await profiles.get(profileId)) ?? null) : null
            }
          }
        }

        const dispatchKeyIds = profile ? connectionDispatchKeyRefs(profile) : []
        const dispatchKeyRows =
          dispatchKeyIds.length > 0
            ? await tx.table<KeyRecord, KeyId>('keys').bulkGet(dispatchKeyIds)
            : []
        const key = profile?.apiKeyRef
          ? dispatchKeyRows[dispatchKeyIds.indexOf(profile.apiKeyRef)]
          : undefined
        const promptPresetReferences =
          target.promptPresets.length > 0
            ? target.promptPresets
            : target.kind === 'new-chat' && target.fallback === 'full' && preset
              ? chatSettingsPromptPresetReferences(preset.settings)
              : []
        const promptPresetRows =
          promptPresetReferences.length === 0
            ? []
            : await tx
                .table<ConfigurationPromptPresetCatalogProjectionRow, PromptPresetId>(
                  'configurationPromptPresetCatalogRows',
                )
                .bulkGet(promptPresetReferences.map((reference) => reference.id))
        const promptPresets = promptPresetRows.flatMap((row, index) => {
          const reference = promptPresetReferences[index]
          return row && reference && row.kind === reference.kind ? [row] : []
        })
        const textTemplateId =
          target.textTemplateId ??
          (target.kind === 'new-chat' && target.fallback === 'full'
            ? (preset?.settings.textTemplate ?? null)
            : null)
        const textTemplateRow =
          textTemplateId && !isStaticTextTemplateId(textTemplateId)
            ? await tx.table<SavedTextTemplate, TextTemplateId>('textTemplates').get(textTemplateId)
            : undefined
        signal?.throwIfAborted()
        const selectedProfile = profile ? structuredClone(profile) : null
        const selectedPreset = preset ? structuredClone(preset) : null
        if (selectedProfile) {
          delete selectedProfile.lastUsedAt
          delete selectedProfile.requestRevision
        }
        if (selectedPreset) {
          delete selectedPreset.lastUsedAt
          delete selectedPreset.archived
        }
        return {
          profile: selectedProfile,
          preset: selectedPreset,
          requestRevision: profile ? configurationRequestRevisionFor(profile, key) : null,
          dispatchKeyRevisions: keyDispatchRevisions(dispatchKeyIds, dispatchKeyRows),
          promptPresets: promptPresets.map(({ lastUsedAt: _lastUsedAt, ...row }) => row),
          textTemplate:
            textTemplateId && !isStaticTextTemplateId(textTemplateId)
              ? {
                  templateId: textTemplateId,
                  config: textTemplateRow
                    ? normalizeTextTemplateConfig(textTemplateRow.config)
                    : null,
                }
              : null,
        }
      },
    )
  }

  private async getConfigurationActiveModel(
    profileId: ProfileId,
    modelId: string | null,
    requestedRevision: ConfigurationActiveModelProjection['revision'],
    includeModels: boolean,
    knownPayloads: ConfigurationActiveModelKnownPayloads | undefined,
    signal?: AbortSignal,
  ): Promise<ConfigurationActiveModelRead> {
    signal?.throwIfAborted()
    const db = await this.openDb()
    return db.transaction(
      'r',
      [
        db.discoveryPayloadMetadata,
        db.discoveryPayloads,
        db.endpoints,
        db.keys,
        db.models,
        db.privacyPolicies,
        db.profiles,
      ],
      async (tx: Transaction) => {
        const profile = await tx.table<ConnectionProfile, ProfileId>('profiles').get(profileId)
        if (!profile) return { kind: 'missing-profile' }
        const key = profile.apiKeyRef
          ? await tx.table<KeyRecord, KeyId>('keys').get(profile.apiKeyRef)
          : undefined
        const revision = configurationRequestRevisionFor(profile, key)
        if (
          configurationRequestRevisionKey(revision) !==
          configurationRequestRevisionKey(requestedRevision)
        ) {
          return { kind: 'stale-selection' }
        }
        const revisionKey = connectionDiscoveryRevisionKey(revision)
        const modelsQueryKey = modelsCacheKey(modelCatalogQueryForConnectionKind(profile.kind))
        const [models, endpoints, privacy] = await Promise.all([
          includeModels
            ? readConfigurationModelsPayload(
                tx,
                [profileId, modelsQueryKey],
                revisionKey,
                knownPayloads?.models,
              )
            : Promise.resolve({ kind: 'not-requested' } as const),
          modelId
            ? readConfigurationEndpointsPayload(
                tx,
                [profileId, modelId],
                revisionKey,
                knownPayloads?.endpoints,
              )
            : Promise.resolve({ kind: 'not-requested' } as const),
          modelId
            ? readConfigurationPrivacyPayload(
                tx,
                [profileId, modelId],
                revisionKey,
                knownPayloads?.privacy,
              )
            : Promise.resolve({ kind: 'not-requested' } as const),
        ])
        signal?.throwIfAborted()
        return {
          kind: 'ready',
          projection: {
            revision,
            modelId,
            models,
            endpoints,
            privacy,
          },
        }
      },
    )
  }

  private async readDiscoveryCacheRow<T extends DiscoveryCacheStorageTable>(
    tableName: T,
    key: [string, string],
  ) {
    const db = await this.openDb()
    return db.transaction(
      'r',
      [db.table(tableName), db.discoveryPayloadMetadata, db.discoveryPayloads],
      (tx) => readDiscoveryCacheRow(tx, tableName, key),
    )
  }

  private async getConfigurationProfileSwitchPlan(chatId: ChatId, profileId: ProfileId) {
    const db = await this.openDb()
    return db.transaction(
      'r',
      [
        db.chats,
        db.discoveryPayloadMetadata,
        db.discoveryPayloads,
        db.profiles,
        db.keys,
        db.models,
      ],
      async (tx: Transaction) => {
        const [chat, profile] = await Promise.all([
          tx.table<Chat, ChatId>('chats').get(chatId),
          tx.table<ConnectionProfile, ProfileId>('profiles').get(profileId),
        ])
        if (!chat || !profile) return undefined
        const key = profile.apiKeyRef
          ? await tx.table<KeyRecord, KeyId>('keys').get(profile.apiKeyRef)
          : undefined
        const target = configurationRequestRevisionFor(profile, key)
        const queryKey = modelsCacheKey(modelCatalogQueryForConnectionKind(profile.kind))
        const cachedModels = await readDiscoveryCacheRow(tx, 'models', [profile.id, queryKey])
        return {
          chat: {
            settings: structuredClone(chat.settings),
            ...(chat.configurationVersion === undefined
              ? {}
              : { configurationVersion: chat.configurationVersion }),
            ...(chat.modelResolution === undefined
              ? {}
              : { modelResolution: structuredClone(chat.modelResolution) }),
          },
          profile: { kind: profile.kind, baseUrl: profile.baseUrl },
          target,
          requestKeyId: profile.apiKeyRef ?? null,
          ...(cachedModels?.profileRevision === connectionDiscoveryRevisionKey(target)
            ? { cachedModels: structuredClone(cachedModels) }
            : {}),
        }
      },
    )
  }

  private async getConfigurationModelResolutionPage(
    profileId: ProfileId,
    requestedProfileRevision: string,
    knownModels: ConfigurationDiscoveryPayloadToken | undefined,
    signal?: AbortSignal,
  ): Promise<ConfigurationModelResolutionPage> {
    signal?.throwIfAborted()
    const db = await this.openDb()
    return db.transaction(
      'r',
      [
        db.chats,
        db.configurationLinks,
        db.discoveryPayloadMetadata,
        db.discoveryPayloads,
        db.keys,
        db.models,
        db.profiles,
      ],
      async (tx: Transaction) => {
        const profile = await tx.table<ConnectionProfile, ProfileId>('profiles').get(profileId)
        if (!profile) return { kind: 'unavailable' }
        const key = profile.apiKeyRef
          ? await tx.table<KeyRecord, KeyId>('keys').get(profile.apiKeyRef)
          : undefined
        const target = configurationRequestRevisionFor(profile, key)
        const queryKey = modelsCacheKey(modelCatalogQueryForConnectionKind(profile.kind))
        const [models, links] = await Promise.all([
          readConfigurationModelsPayload(
            tx,
            [profileId, queryKey],
            connectionDiscoveryRevisionKey(target),
            knownModels,
          ),
          tx
            .table<ConfigurationLink, string>('configurationLinks')
            .where('targetKey')
            .equals(configurationTargetKey('model-resolution', requestedProfileRevision))
            .limit(CONFIGURATION_MODEL_RESOLUTION_PAGE_SIZE)
            .toArray(),
        ])
        const chatIds = [
          ...new Set(
            links.flatMap((link) => (link.ownerKind === 'chat' ? [link.ownerId as ChatId] : [])),
          ),
        ]
        const chats =
          chatIds.length === 0 ? [] : await tx.table<Chat, ChatId>('chats').bulkGet(chatIds)
        const pending = chats.flatMap((chat) => {
          const resolution = chat?.modelResolution
          if (
            !chat ||
            !resolution ||
            resolution.target.profileId !== profileId ||
            configurationRequestRevisionKey(resolution.target) !== requestedProfileRevision ||
            (chat.configurationVersion ?? 0) !== resolution.expectedConfigurationVersion
          ) {
            return []
          }
          return [
            {
              chatId: chat.id,
              intentId: resolution.intentId,
              target: resolution.target,
              sourceModelId: resolution.sourceModelId,
              expectedConfigurationVersion: resolution.expectedConfigurationVersion,
            },
          ]
        })
        signal?.throwIfAborted()
        return {
          kind: 'ready',
          profileKind: profile.kind,
          target,
          requestKeyId: profile.apiKeyRef ?? null,
          models,
          pending,
          pageFull: links.length === CONFIGURATION_MODEL_RESOLUTION_PAGE_SIZE,
        }
      },
    )
  }

  private async getConfigurationModelResolutionHead(
    signal?: AbortSignal,
  ): Promise<ConfigurationModelResolutionHead> {
    signal?.throwIfAborted()
    const db = await this.openDb()
    return db.transaction('r', [db.chats, db.configurationLinks], async (tx: Transaction) => {
      const link = await tx
        .table<ConfigurationLink, string>('configurationLinks')
        .where('targetKey')
        .between('model-resolution:', 'model-resolution:\uffff', true, true)
        .first()
      if (!link) return { kind: 'empty' }
      if (link.ownerKind !== 'chat') return { kind: 'blocked', linkId: link.id }
      const chat = await tx.table<Chat, ChatId>('chats').get(link.ownerId as ChatId)
      const pending = chat?.modelResolution
      if (
        !chat ||
        !pending ||
        configurationTargetKey(
          'model-resolution',
          configurationRequestRevisionKey(pending.target),
        ) !== link.targetKey
      ) {
        return { kind: 'blocked', linkId: link.id }
      }
      signal?.throwIfAborted()
      return {
        kind: 'pending',
        profileId: pending.target.profileId,
        profileRevision: configurationRequestRevisionKey(pending.target),
      }
    })
  }

  private async getConfigurationProfileCatalogPage(
    request: ConfigurationCatalogPageRequest,
    signal?: AbortSignal,
  ): Promise<ConfigurationProfileCatalogPage> {
    const db = await this.openDb()
    return db.transaction(
      'r',
      [db.configurationCatalogAggregates, db.configurationProfileCatalogRows],
      async (tx) => {
        const table = tx.table<ConfigurationProfileCatalogProjectionRow, ProfileId>(
          'configurationProfileCatalogRows',
        )
        const state = await tx
          .table<ConfigurationCatalogStateRow, string>('configurationCatalogAggregates')
          .get(CONFIGURATION_PROFILE_CATALOG_STATE_ID)
        if (!state) throw new Error('ConfigurationProfileCatalogStateMissing')
        const addressedIds = configurationCatalogAddressIds(request) as ProfileId[]
        const addressed = await table.bulkGet(addressedIds)
        const addressedRows = Object.freeze(
          addressedIds.map((id, index) => ({
            id,
            row: projectAddressedConfigurationProfileCatalogRow(addressed[index]),
          })),
        )
        const [lower, upper] = scalarCompoundIndexBetween([1], [1], 4)
        return readConfigurationCatalogIndexPage({
          table,
          state,
          addressedRows,
          index: '[activeKey+mruSortKey+nameSortKey+id]',
          catalog: 'profiles',
          lower,
          upper,
          request,
          keyFor: (row) => [row.activeKey, row.mruSortKey, row.nameSortKey, row.id],
          project: projectConfigurationProfileCatalogRow,
          signal,
        })
      },
    )
  }

  private async getConfigurationPresetCatalogPage(
    request: ConfigurationCatalogPageRequest,
    signal?: AbortSignal,
  ): Promise<ConfigurationPresetCatalogPage> {
    const db = await this.openDb()
    return db.transaction(
      'r',
      [
        db.configurationPresetCatalogRows,
        db.presetOrderBlocks,
        db.presetOrderMembership,
        db.presetOrderState,
      ],
      (tx) => readConfigurationPresetOrderPage(tx, request, signal),
    )
  }

  private async getConfigurationPromptPresetCatalogPage(
    promptKind: PromptPresetKind,
    request: ConfigurationCatalogPageRequest,
    signal?: AbortSignal,
  ): Promise<ConfigurationPromptPresetCatalogPage> {
    const db = await this.openDb()
    return db.transaction(
      'r',
      [db.configurationCatalogAggregates, db.configurationPromptPresetCatalogRows],
      async (tx) => {
        const table = tx.table<ConfigurationPromptPresetCatalogProjectionRow, PromptPresetId>(
          'configurationPromptPresetCatalogRows',
        )
        const state = await tx
          .table<ConfigurationCatalogStateRow, string>('configurationCatalogAggregates')
          .get(configurationPromptPresetCatalogStateId(promptKind))
        if (!state) throw new Error(`ConfigurationPromptPresetCatalogStateMissing:${promptKind}`)
        const addressedIds = configurationCatalogAddressIds(request) as PromptPresetId[]
        const addressed = await table.bulkGet(addressedIds)
        const addressedRows = Object.freeze(
          addressedIds.map((id, index) => ({
            id,
            row: projectConfigurationPromptPresetCatalogRow(addressed[index], promptKind),
          })),
        )
        const [lower, upper] = scalarCompoundIndexBetween([promptKind], [promptKind], 3)
        return readConfigurationCatalogIndexPage({
          table,
          state,
          addressedRows,
          index: '[kind+nameSortKey+id]',
          catalog: `prompt-presets:${promptKind}`,
          lower,
          upper,
          request,
          keyFor: (row) => [row.kind, row.nameSortKey, row.id],
          project: (row) => projectConfigurationPromptPresetCatalogRow(row, promptKind),
          signal,
        })
      },
    )
  }

  private async getConfigurationConnectionManagerPage(
    request: ConfigurationCatalogPageRequest,
    signal?: AbortSignal,
  ): Promise<ConfigurationConnectionManagerPage> {
    signal?.throwIfAborted()
    const db = await this.openDb()
    return db.transaction(
      'r',
      [
        db.configurationCatalogAggregates,
        db.configurationProfileCatalogRows,
        db.configurationProfileUsageRows,
      ],
      async (tx: Transaction) => {
        const profiles = tx.table<ConfigurationProfileCatalogProjectionRow, ProfileId>(
          'configurationProfileCatalogRows',
        )
        const state = await tx
          .table<ConfigurationCatalogStateRow, string>('configurationCatalogAggregates')
          .get(CONFIGURATION_PROFILE_MANAGER_STATE_ID)
        if (!state) throw new Error('ConfigurationProfileManagerStateMissing')
        const addressedIds = configurationCatalogAddressIds(request) as ProfileId[]
        const addressed = await profiles.bulkGet(addressedIds)
        const [lower, upper] = scalarCompoundIndexBetween([0], [1], 3)
        const page = await readConfigurationCatalogIndexPage({
          table: profiles,
          state,
          addressedRows: Object.freeze(
            addressedIds.map((id, index) => ({
              id,
              row: projectConfigurationConnectionManagerProfileRow(addressed[index]),
            })),
          ),
          index: '[managerTier+nameSortKey+id]',
          catalog: 'connection-manager',
          lower,
          upper,
          request,
          keyFor: (row) => [row.managerTier, row.nameSortKey, row.id],
          project: projectConfigurationConnectionManagerProfileRow,
          signal,
        })
        const profileRows = [
          ...new Map(
            [
              ...(page.kind === 'page' ? page.rows : []),
              ...page.addressedRows.flatMap((address) => (address.row ? [address.row] : [])),
            ].map((profile) => [profile.id, profile]),
          ).values(),
        ]
        const usages = await tx
          .table<ConfigurationProfileUsageProjectionRow, ProfileId>('configurationProfileUsageRows')
          .bulkGet(profileRows.map((profile) => profile.id))
        const usageById = new Map(
          profileRows.map((profile, index) => [
            profile.id,
            usages[index] ?? emptyConfigurationProfileUsageProjectionRow(profile.id),
          ]),
        )
        const decorate = (profile: ConfigurationConnectionManagerRow) => ({
          ...profile,
          ...(usageById.get(profile.id) ?? emptyConfigurationProfileUsageProjectionRow(profile.id)),
        })
        return Object.freeze({
          ...page,
          ...(page.kind === 'page' ? { rows: Object.freeze(page.rows.map(decorate)) } : {}),
          addressedRows: Object.freeze(
            page.addressedRows.map((address) => ({
              id: address.id,
              row: address.row ? decorate(address.row) : null,
            })),
          ),
        })
      },
    )
  }

  private async getGeneratedOutputNetworkAccess(
    profileIds: readonly ProfileId[],
    url: string,
    requestCredential?: { profileId: ProfileId; selectedKeyId: KeyId },
  ) {
    const db = await this.openDb()
    const uniqueProfileIds = requestCredential
      ? [requestCredential.profileId]
      : [...new Set(profileIds)]
    return db.transaction('r', [db.profiles, db.keys], async (tx: Transaction) => {
      const profiles = await tx
        .table<ConnectionProfile, ProfileId>('profiles')
        .bulkGet(uniqueProfileIds)
      const profile = profiles.find(
        (candidate): candidate is ConnectionProfile =>
          candidate !== undefined && profileAuthorizesGeneratedVideoUrl(url, candidate.baseUrl),
      )
      if (!profile) return { profileKind: null, polling: false }
      const selectedKeyId = requestCredential?.selectedKeyId ?? profile.apiKeyRef
      const selectedKeyBelongsToProfile =
        selectedKeyId !== undefined &&
        (profile.apiKeyRef === selectedKeyId ||
          profile.apiKeyFallbackRefs?.includes(selectedKeyId) === true)
      const key = selectedKeyBelongsToProfile
        ? await tx.table<KeyRecord, KeyId>('keys').get(selectedKeyId)
        : undefined
      return {
        profileKind: profile.kind,
        ...(key ? { credentialKey: keyDispatchProof(key) } : {}),
        polling: profile.kind === 'openrouter' && isGeneratedVideoPollingUrl(url),
      }
    })
  }

  async getKey(keyId: KeyId): Promise<KeyRecord | undefined> {
    return (await this.openDb()).keys.get(keyId)
  }

  private async mutateDiscoveryCache(
    command: DiscoveryCacheCommand,
    replacementEpoch: number,
    commit: BrowserCommandCommit,
  ): Promise<boolean | number | DiscoveryCachePutResult | DiscoveryModelsPutResult> {
    switch (command.kind) {
      case 'discovery.models.put':
        return this.putModelsDiscoveryCacheRow(command.row, command.guard, replacementEpoch, commit)
      case 'discovery.endpoints.put':
        return this.putDiscoveryCacheRow(
          'endpoints',
          command.row,
          [command.row.profileId, command.row.modelId],
          command.guard,
          replacementEpoch,
          commit,
        )
      case 'discovery.privacy.put':
        return this.putDiscoveryCacheRow(
          'privacyPolicies',
          command.row,
          [command.row.profileId, command.row.modelId],
          command.guard,
          replacementEpoch,
          commit,
        )
      case 'discovery.models.delete':
        return this.deleteDiscoveryCacheRow(
          'models',
          command.profileId,
          [command.profileId, command.queryKey],
          replacementEpoch,
          commit,
        )
    }
  }

  private async putModelsDiscoveryCacheRow(
    row: CachedModelsRow,
    guard: DiscoveryCacheWriteGuard<CachedModelsRow> | undefined,
    replacementEpoch: number,
    commit: BrowserCommandCommit,
  ): Promise<DiscoveryModelsPutResult> {
    commit.assertReplacementEpoch(replacementEpoch)
    const preparedPayload = await prepareDiscoveryPayload('models', row.payload)
    const input: DiscoveryCacheOperationInput = {
      kind: 'discovery.models.put',
      profileId: row.profileId,
      discriminator: row.queryKey,
      targetKey: configurationTargetKey('model-resolution', row.profileRevision),
    }
    return commit.executeSemanticOperation(
      discoveryCacheOperationDescriptor(input.kind),
      input,
      async (
        tx,
      ): Promise<
        SemanticOperationExecution<
          DiscoveryModelsPutResult,
          SemanticOperationExactReceipt<PhysicalStorageTableName>
        >
      > => {
        const receipt = requireDiscoveryCacheReceiptAccumulator(tx)
        const currentProfile =
          (await tx.table<ConnectionProfile, ProfileId>('profiles').get(row.profileId)) ?? null
        receipt.physicalRead({
          tableName: 'profiles',
          indexKind: 'primary',
          operation: 'get',
          requestCount: 1,
          rowCount: 1,
        })
        const currentKey = currentProfile?.apiKeyRef
          ? await tx.table<KeyRecord, KeyId>('keys').get(currentProfile.apiKeyRef)
          : undefined
        if (currentProfile?.apiKeyRef) {
          receipt.physicalRead({
            tableName: 'keys',
            indexKind: 'primary',
            operation: 'get',
            requestCount: 1,
            rowCount: 1,
          })
        }
        const currentRevision = currentProfile
          ? configurationRequestRevisionFor(currentProfile, currentKey)
          : null
        if (
          guard?.expectedProfileRevision !== undefined &&
          stableStringify(currentRevision) !==
            stableStringify(guard.expectedProfileRevision ?? null)
        ) {
          return semanticOperationExecution(
            {
              accepted: false,
              cacheChanged: false,
              cached: false,
              repairRequired: false,
              evictions: [],
            },
            discoveryCacheExactReceipt(
              receipt,
              {
                kind: 'single-attempt',
                reason: 'unfenced-relative-update',
              },
              DISCOVERY_CACHE_PUT_OPERATION_BOUNDS,
            ),
          )
        }
        if (
          currentProfile &&
          currentRevision &&
          row.profileRevision !== connectionDiscoveryRevisionKey(currentRevision)
        ) {
          throw new Error(`DiscoveryCacheRowRevisionMismatch:${row.profileId}`)
        }

        const primaryKey: [ProfileId, string] = [row.profileId, row.queryKey]
        let knownCurrent: DiscoveryCacheReadEvidence<CachedModelsRow> | undefined
        if (guard?.expectedCurrent !== undefined) {
          knownCurrent = await readDiscoveryCacheRowWithEvidence(tx, 'models', primaryKey, receipt)
          if (
            stableStringify(knownCurrent.row ?? null) !==
            stableStringify(guard.expectedCurrent ?? null)
          ) {
            return semanticOperationExecution(
              {
                accepted: false,
                cacheChanged: false,
                cached: false,
                repairRequired: false,
                evictions: [],
              },
              discoveryCacheExactReceipt(
                receipt,
                {
                  kind: 'single-attempt',
                  reason: 'unfenced-relative-update',
                },
                DISCOVERY_CACHE_PUT_OPERATION_BOUNDS,
              ),
            )
          }
        }
        const storageResult = await putDiscoveryCacheRow(tx, 'models', row, preparedPayload, {
          ...(knownCurrent ? { knownCurrent } : {}),
          receipt,
        })
        if (storageResult.accepted) {
          const dependency = {
            kind: 'model-resolution',
            targetKeys: [configurationTargetKey('model-resolution', row.profileRevision)],
          } as const
          receipt.dependency(dependency)
          recordBrowserCommandInvalidation(tx, dependency)
        }
        return semanticOperationExecution(
          {
            accepted: true,
            cacheChanged: storageResult.cacheChanged,
            cached: storageResult.cached,
            repairRequired: storageResult.repairRequired,
            evictions: protocolDiscoveryCacheEvictions(storageResult.evictions),
          },
          discoveryCacheExactReceipt(
            receipt,
            {
              kind: 'single-attempt',
              reason: 'unfenced-relative-update',
            },
            DISCOVERY_CACHE_PUT_OPERATION_BOUNDS,
          ),
        )
      },
    )
  }

  private async putDiscoveryCacheRow<Row extends CachedEndpointsRow | CachedPrivacyPolicyRow>(
    tableName: 'endpoints' | 'privacyPolicies',
    row: Row,
    primaryKey: string | [string, string],
    guard: DiscoveryCacheWriteGuard<Row> | undefined,
    replacementEpoch: number,
    commit: BrowserCommandCommit,
  ): Promise<DiscoveryCachePutResult> {
    commit.assertReplacementEpoch(replacementEpoch)
    const preparedPayload = await prepareDiscoveryPayload(tableName, row.payload)
    const kind =
      tableName === 'endpoints'
        ? ('discovery.endpoints.put' as const)
        : ('discovery.privacy.put' as const)
    const input: DiscoveryCacheOperationInput = {
      kind,
      profileId: row.profileId,
      discriminator: row.modelId,
      targetKey: null,
    }
    return commit.executeSemanticOperation(
      discoveryCacheOperationDescriptor(kind),
      input,
      async (tx) => {
        const receipt = requireDiscoveryCacheReceiptAccumulator(tx)
        if (guard && 'expectedProfileRevision' in guard) {
          const currentProfile =
            (await tx.table<ConnectionProfile, ProfileId>('profiles').get(row.profileId)) ?? null
          receipt.physicalRead({
            tableName: 'profiles',
            indexKind: 'primary',
            operation: 'get',
            requestCount: 1,
            rowCount: 1,
          })
          const currentKey = currentProfile?.apiKeyRef
            ? await tx.table<KeyRecord, KeyId>('keys').get(currentProfile.apiKeyRef)
            : undefined
          if (currentProfile?.apiKeyRef) {
            receipt.physicalRead({
              tableName: 'keys',
              indexKind: 'primary',
              operation: 'get',
              requestCount: 1,
              rowCount: 1,
            })
          }
          const currentRevision = currentProfile
            ? configurationRequestRevisionFor(currentProfile, currentKey)
            : null
          if (
            stableStringify(currentRevision) !==
            stableStringify(guard.expectedProfileRevision ?? null)
          ) {
            return semanticOperationExecution(
              emptyDiscoveryCachePutResult(),
              discoveryCacheExactReceipt(
                receipt,
                {
                  kind: 'single-attempt',
                  reason: 'unfenced-relative-update',
                },
                DISCOVERY_CACHE_PUT_OPERATION_BOUNDS,
              ),
            )
          }
          if (
            currentProfile &&
            'profileRevision' in row &&
            currentRevision &&
            row.profileRevision !== connectionDiscoveryRevisionKey(currentRevision)
          ) {
            throw new Error(`DiscoveryCacheRowRevisionMismatch:${row.profileId}`)
          }
        }
        let knownCurrent: DiscoveryCacheReadEvidence<Row> | undefined
        if (guard && 'expectedCurrent' in guard) {
          knownCurrent = (await readDiscoveryCacheRowWithEvidence(
            tx,
            tableName,
            primaryKey,
            receipt,
          )) as DiscoveryCacheReadEvidence<Row>
          if (
            stableStringify(knownCurrent.row ?? null) !==
            stableStringify(guard.expectedCurrent ?? null)
          ) {
            return semanticOperationExecution(
              emptyDiscoveryCachePutResult(),
              discoveryCacheExactReceipt(
                receipt,
                {
                  kind: 'single-attempt',
                  reason: 'unfenced-relative-update',
                },
                DISCOVERY_CACHE_PUT_OPERATION_BOUNDS,
              ),
            )
          }
        }
        const result = await putDiscoveryCacheRow(tx, tableName, row, preparedPayload, {
          ...(knownCurrent ? { knownCurrent } : {}),
          receipt,
        })
        return semanticOperationExecution(
          protocolDiscoveryCachePutResult(result),
          discoveryCacheExactReceipt(
            receipt,
            {
              kind: 'single-attempt',
              reason: 'unfenced-relative-update',
            },
            DISCOVERY_CACHE_PUT_OPERATION_BOUNDS,
          ),
        )
      },
    )
  }

  private async deleteDiscoveryCacheRow(
    tableName: 'models',
    profileId: ProfileId,
    primaryKey: [string, string],
    replacementEpoch: number,
    commit: BrowserCommandCommit,
  ): Promise<boolean> {
    commit.assertReplacementEpoch(replacementEpoch)
    const input: DiscoveryCacheOperationInput = {
      kind: 'discovery.models.delete',
      profileId,
      discriminator: primaryKey[1],
      targetKey: null,
    }
    return commit.executeSemanticOperation(
      discoveryCacheOperationDescriptor(input.kind),
      input,
      async (tx) => {
        const receipt = requireDiscoveryCacheReceiptAccumulator(tx)
        const result = await deleteDiscoveryCacheRow(tx, tableName, primaryKey, receipt)
        return semanticOperationExecution(
          result.deleted,
          discoveryCacheExactReceipt(
            receipt,
            {
              kind: 'single-attempt',
              reason: 'unfenced-relative-update',
            },
            DISCOVERY_CACHE_DELETE_OPERATION_BOUNDS,
          ),
        )
      },
    )
  }

  async getSetting<T>(key: string): Promise<T | undefined> {
    const row = await (await this.openDb()).settings.get(key)
    return row?.value as T | undefined
  }

  async getSettings(
    keys: readonly string[],
    options: { signal?: AbortSignal } = {},
  ): Promise<ReadonlyMap<string, unknown>> {
    const db = await this.openDb()
    const rows = await readBulkGetPages(db.settings, keys, options)
    return new Map(
      rows.flatMap((row) => (row === undefined ? [] : [[row.key, row.value] as const])),
    )
  }

  async renewStreamLease(
    heartbeat: StreamLeaseHeartbeat,
    commit: BrowserCommandCommit,
  ): Promise<StreamLeaseRow> {
    const { fence } = heartbeat
    commit.assertReplacementEpoch(fence.replacementEpoch)
    if (!Number.isSafeInteger(heartbeat.expectedRevision) || heartbeat.expectedRevision < 0) {
      throw new Error(`StreamLeaseHeartbeatRevisionInvalid:${heartbeat.streamId}`)
    }
    const replay = requestedRenewReplayPlan(heartbeat)
    const row = await executeStreamLeaseOperation<StreamLeaseRow>(
      commit,
      STREAM_RENEW_OPERATION,
      heartbeat.streamId,
      replay,
      (existing) => {
        assertOwnedStreamFence(existing, fence, fence.replacementEpoch, heartbeat.streamId)
        if (existing.revision !== heartbeat.expectedRevision) {
          return { value: structuredClone(existing) }
        }
        const elapsed = heartbeat.heartbeatAt - existing.heartbeatAt
        if (elapsed >= 0 && elapsed <= STREAM_LEASE_HEARTBEAT_COALESCE_MS) {
          return { value: structuredClone(existing) }
        }
        const renewed = requireStreamLeaseRow({
          ...existing,
          heartbeatAt: heartbeat.heartbeatAt,
          revision: nextStreamLeaseRevision(existing),
        })
        return { value: renewed, next: renewed }
      },
      observedRenewReplayPlan,
    )
    return row
  }

  async claimStreamLeaseForRecovery(
    expected: StreamLeaseRow,
    now: number,
    commit: BrowserCommandCommit,
  ): Promise<StreamLeaseRow | undefined> {
    commit.assertReplacementEpoch(expected.replacementEpoch)
    const replay = requestedClaimRecoveryReplayPlan(expected)
    return executeStreamLeaseOperation<StreamLeaseRow | undefined>(
      commit,
      STREAM_CLAIM_RECOVERY_OPERATION,
      expected.streamId,
      replay,
      (existing) => {
        if (
          !existing ||
          existing.replacementEpoch !== expected.replacementEpoch ||
          existing.admissionSequence !== expected.admissionSequence ||
          existing.revision !== expected.revision ||
          existing.custody !== expected.custody ||
          (streamLeaseHasWriteFence(existing) &&
            streamLeaseHasWriteFence(expected) &&
            (existing.ownerClientId !== expected.ownerClientId ||
              existing.fenceToken !== expected.fenceToken ||
              existing.heartbeatAt !== expected.heartbeatAt)) ||
          (existing.custody === 'recovery-pending' &&
            expected.custody === 'recovery-pending' &&
            existing.handoffId !== expected.handoffId)
        ) {
          return { value: undefined }
        }
        const {
          custody: _custody,
          ownerClientId: _ownerClientId,
          fenceToken: _fenceToken,
          heartbeatAt: _heartbeatAt,
          handoffId: _handoffId,
          handedOffAt: _handedOffAt,
          handoffReason: _handoffReason,
          ...leaseState
        } = existing
        const claimed = requireStreamLeaseRow({
          ...leaseState,
          custody: 'recovery',
          ownerClientId: `recovery:${newId()}`,
          fenceToken: newId(),
          heartbeatAt: now,
          revision: nextStreamLeaseRevision(existing),
        })
        return { value: claimed, next: claimed }
      },
      (current, decision) => observedClaimRecoveryReplayPlan(current, decision, expected.streamId),
    )
  }

  async handoffStreamLeaseForRecovery(
    input: StreamHandoffRecoveryInput,
    replacementEpoch: number,
    commit: BrowserCommandCommit,
  ): Promise<StreamLeaseRow> {
    commit.assertReplacementEpoch(replacementEpoch)
    const replay = handoffReplayPlan(
      input.streamId,
      input.fence.replacementEpoch,
      input.fence.admissionSequence,
      input.handoffId,
      input.handedOffAt,
      input.reason,
    )
    return executeStreamLeaseOperation<StreamLeaseRow>(
      commit,
      STREAM_HANDOFF_RECOVERY_OPERATION,
      input.streamId,
      replay,
      (existing) => {
        if (existing?.custody === 'recovery-pending' && existing.handoffId === input.handoffId) {
          if (
            existing.replacementEpoch !== input.fence.replacementEpoch ||
            existing.admissionSequence !== input.fence.admissionSequence ||
            existing.handedOffAt !== input.handedOffAt ||
            existing.handoffReason !== input.reason
          ) {
            throw new Error(`StreamHandoffReplayConflict:${input.streamId}`)
          }
          return { value: structuredClone(existing) }
        }
        assertOwnedStreamFence(existing, input.fence, replacementEpoch, input.streamId)
        if (existing.custody !== 'writer') {
          throw new Error(`StreamHandoffCustodyInvalid:${input.streamId}`)
        }
        const {
          custody: _custody,
          ownerClientId: _ownerClientId,
          fenceToken: _fenceToken,
          heartbeatAt: _heartbeatAt,
          ...leaseState
        } = existing
        const handedOff = requireStreamLeaseRow({
          ...leaseState,
          custody: 'recovery-pending',
          handoffId: input.handoffId,
          handedOffAt: input.handedOffAt,
          handoffReason: input.reason,
          revision: nextStreamLeaseRevision(existing),
        })
        return { value: handedOff, next: handedOff }
      },
      (_current, decision) => observedHandoffReplayPlan(decision.value),
    )
  }

  async listStreamLeases(
    chatId?: ChatId,
    options: { signal?: AbortSignal } = {},
  ): Promise<StreamLeaseRow[]> {
    return readStreamLeasePages(await this.openDb(), chatId, options)
  }

  async getStreamLease(streamId: string): Promise<StreamLeaseRow | undefined> {
    const db = await this.openDb()
    const lease = await db.streamLeases.get(streamId)
    return isStreamLeaseRow(lease) ? { ...lease } : undefined
  }

  async getStreamLeaseHead(): Promise<StreamLeaseRow | undefined> {
    const db = await this.openDb()
    const lease = await db.streamLeases.limit(1).first()
    return isStreamLeaseRow(lease) ? { ...lease } : undefined
  }

  async getStreamLeases(
    streamIds: readonly string[],
    options: { signal?: AbortSignal } = {},
  ): Promise<Array<StreamLeaseRow | undefined>> {
    const rows = await readBulkGetPages((await this.openDb()).streamLeases, streamIds, options)
    return rows.map((row) => (isStreamLeaseRow(row) ? { ...row } : undefined))
  }

  async appendStreamJournalFrames(
    frames: readonly StreamJournalFrameRow[],
    observedAt: number,
    commit: BrowserCommandCommit,
  ): Promise<void> {
    if (frames.length === 0) return
    if (!Number.isSafeInteger(observedAt) || observedAt < 0) {
      throw new Error('StreamJournalObservedAtInvalid')
    }
    const batch = canonicalStreamJournalFrameBatch(frames)
    const first = batch[0]
    if (!first) throw new Error('StreamJournalAppendBatchEmpty')
    const authority = streamJournalWriterAuthority(first)
    const resource = {
      streamId: authority.streamId,
      replay: streamJournalAppendReplayPlan(
        authority,
        batch.map((frame) => frame.id),
      ),
    }
    await commit.executeSemanticOperation(
      STREAM_APPEND_JOURNAL_FRAMES_OPERATION,
      resource,
      async (tx) => {
        const transition = await persistStreamJournalFrames(tx, batch, observedAt)
        return semanticOperationExecution(
          undefined,
          semanticOperationExactReceipt(
            semanticOperationExactPlan({
              replay: streamJournalAppendReplayPlan(
                transition.authority,
                transition.acceptedFrameIds,
              ),
              bounds: STREAM_JOURNAL_APPEND_OPERATION_BOUNDS,
            }),
            transition.receipt,
          ),
        )
      },
    )
  }

  async deleteStreamJournal(
    streamId: string,
    options: {
      replacementEpoch: number
      streamFence: StreamWriteFence
    },
    commit: BrowserCommandCommit,
  ): Promise<{ deletedLease: boolean; deletedFrames: number; done: boolean }> {
    commit.assertReplacementEpoch(options.replacementEpoch)
    const maxFrameRows = STREAM_JOURNAL_RETIREMENT_MAX_ROWS
    const resourceInput: StreamFinishCleanupResourceInput = {
      streamId,
      fence: options.streamFence,
      maxFrameRows,
      replay: streamFinishCleanupReplayPlan(streamId, options.streamFence, maxFrameRows, 'request'),
    }
    return commit.executeSemanticOperation(
      STREAM_FINISH_CLEANUP_OPERATION,
      resourceInput,
      async (tx) => {
        const transition = await retireStreamJournalOwnershipPage(tx, {
          kind: 'owned-metadata-committed',
          streamId,
          fence: options.streamFence,
          maxFrameRows,
        })
        if (transition.kind !== 'single-stream') {
          throw new Error(`StreamCleanupReceiptMissing:${streamId}`)
        }
        const page = transition.result
        if (page.outcome === 'ineligible') {
          if (page.reason === 'not-metadata-committed') {
            throw new Error(`StreamCleanupBeforeMetadata:${streamId}`)
          }
          throw new Error(`StreamFenceLost:${streamId}`)
        }
        return semanticOperationExecution(
          {
            deletedLease: page.deletedLeases > 0,
            deletedFrames: page.deletedFrames,
            done: page.done,
          },
          semanticOperationExactReceipt(
            semanticOperationExactPlan({
              replay: streamFinishCleanupReplayPlan(
                streamId,
                options.streamFence,
                maxFrameRows,
                page.deletedFrames > 0 || page.deletedLeases > 0 ? 'applied' : 'already-applied',
              ),
              bounds: STREAM_FINISH_CLEANUP_OPERATION_BOUNDS,
            }),
            transition.receipt,
          ),
        )
      },
    )
  }

  private async reconcileStreamJournalIntegrity(
    requestedLimit: number,
    commit: BrowserCommandCommit,
  ): Promise<{
    scannedStreamIds: number
    deletedStreamIds: string[]
    deletedFrames: number
    done: boolean
  }> {
    const limit = boundedMaintenanceLimit(requestedLimit)
    return commit.executeSemanticOperation(
      STREAM_JOURNAL_INTEGRITY_OPERATION,
      { limit },
      async (tx) => {
        const transition = await reconcileStreamJournalIntegrityPage(tx, limit)
        return semanticOperationExecution(
          {
            ...transition.result,
            deletedStreamIds: [...transition.result.deletedStreamIds],
          },
          semanticOperationExactReceipt(
            semanticOperationExactPlan({
              replay: transition.replay,
              bounds: STREAM_JOURNAL_INTEGRITY_OPERATION_BOUNDS,
            }),
            transition.receipt,
          ),
        )
      },
    )
  }

  private async pruneTerminalStreamJournals(
    now: number,
    maxAgeMs: number,
    requestedLimit: number,
    commit: BrowserCommandCommit,
  ): Promise<TerminalStreamRetentionResult> {
    const limit = Math.min(
      boundedMaintenanceLimit(requestedLimit),
      STREAM_JOURNAL_RETIREMENT_MAX_ROWS,
    )
    return commit.executeSemanticOperation(
      TERMINAL_STREAM_RETENTION_OPERATION,
      { limit },
      async (tx) => {
        const receipt = createSemanticOperationExactReceiptAccumulator<
          'storageRetentionState' | 'streamLeases' | 'streamChunks'
        >()
        const state = await readStorageRetentionState(tx, 'terminal-stream-prune')
        receipt.physicalRead({
          tableName: 'storageRetentionState',
          indexKind: 'primary',
          operation: 'get',
          requestCount: 1,
          rowCount: 1,
        })
        const cycle = storageRetentionCycle(state, now, maxAgeMs)
        const leases = tx.table<StreamLeaseRow, string>('streamLeases')
        const lower = cycle.cursor ? [cycle.cursor.terminalRetentionAt, cycle.cursor.streamId] : []
        const current = await leases
          .where('[terminalRetentionAt+streamId]')
          .between(lower, [cycle.cutoff], false, false)
          .first()
        receipt.physicalRead({
          tableName: 'streamLeases',
          indexKind: 'secondary',
          indexName: '[terminalRetentionAt+streamId]',
          operation: 'query',
          requestCount: 1,
          rowCount: current ? 1 : 0,
        })
        if (!current) {
          const deferred = await leases
            .where('[terminalRetentionAt+streamId]')
            .aboveOrEqual([cycle.cutoff])
            .first()
          receipt.physicalRead({
            tableName: 'streamLeases',
            indexKind: 'secondary',
            indexName: '[terminalRetentionAt+streamId]',
            operation: 'query',
            requestCount: 1,
            rowCount: deferred ? 1 : 0,
          })
          const earliestDeferredAt = deferred?.terminalRetentionAt
          receipt.absorb(
            await commitStorageRetentionPage(tx, cycle, {
              done: true,
              ...(earliestDeferredAt === undefined ? {} : { earliestDeferredAt }),
            }),
          )
          const result: TerminalStreamRetentionResult = {
            scanned: 0,
            deletedStreamIds: [],
            deletedFrames: 0,
            ...(earliestDeferredAt === undefined ? {} : { earliestDeferredAt }),
            done: true,
          }
          return semanticOperationExecution(
            result,
            receipt.seal(
              semanticOperationExactPlan({
                replay: terminalStreamRetentionReplayPlan(cycle, limit),
                bounds: TERMINAL_STREAM_RETENTION_OPERATION_BOUNDS,
              }),
            ),
          )
        }
        if (current.terminalRetentionAt === undefined) {
          throw new Error(`TerminalStreamRetentionTimestampMissing:${current.streamId}`)
        }
        const transition = await retireStreamJournalOwnershipPage(tx, {
          kind: 'retention-candidate',
          streamId: current.streamId,
          expectedRevision: current.revision,
          expectedTerminalRetentionAt: current.terminalRetentionAt,
          cutoff: cycle.cutoff,
          maxFrameRows: limit,
        })
        if (transition.kind !== 'single-stream') {
          throw new Error(`TerminalStreamRetentionReceiptMissing:${current.streamId}`)
        }
        receipt.absorb(transition.receipt)
        const page = transition.result
        if (page.outcome === 'ineligible') {
          throw new Error(`TerminalStreamRetentionCandidateInvalid:${current.streamId}`)
        }
        if (page.outcome === 'complete') {
          receipt.absorb(
            await commitStorageRetentionPage(tx, cycle, {
              done: false,
              cursor: {
                terminalRetentionAt: current.terminalRetentionAt,
                streamId: current.streamId,
              },
            }),
          )
        }
        const result: TerminalStreamRetentionResult = {
          scanned: 1,
          deletedStreamIds: page.deletedLeases > 0 ? [current.streamId] : [],
          deletedFrames: page.deletedFrames,
          done: false,
        }
        return semanticOperationExecution(
          result,
          receipt.seal(
            semanticOperationExactPlan({
              replay: terminalStreamRetentionReplayPlan(cycle, limit),
              bounds: TERMINAL_STREAM_RETENTION_OPERATION_BOUNDS,
            }),
          ),
        )
      },
    )
  }

  private async pruneDiscoveryCache(
    requestedLimit: number,
    commit: BrowserCommandCommit,
  ): Promise<DiscoveryCacheMaintenanceResult> {
    const limit = boundedMaintenanceLimit(requestedLimit)
    return commit.executeSemanticOperation(
      DISCOVERY_CACHE_MAINTENANCE_OPERATION,
      { limit },
      async (tx) => {
        const receipt = requireDiscoveryCacheReceiptAccumulator(tx)
        const result = await maintainDiscoveryCache(tx, limit, receipt)
        return semanticOperationExecution(
          {
            scanned: result.scanned,
            deletedPayloads: result.deletedPayloads,
            evictions: protocolDiscoveryCacheEvictions(result.evictions),
            done: result.done,
          },
          discoveryCacheExactReceipt(
            receipt,
            result.replay,
            discoveryCacheMaintenanceOperationBounds(limit),
          ),
        )
      },
    )
  }

  private async reconcileAttachmentIntegrity(
    requestedLimit: number,
    now: number,
    commit: BrowserCommandCommit,
  ): Promise<AttachmentIntegrityMaintenanceResult> {
    const limit = boundedMaintenanceLimit(requestedLimit)
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new Error('AttachmentIntegrityObservedAtInvalid')
    }
    return commit.executeSemanticOperation(
      ATTACHMENT_INTEGRITY_OPERATION,
      undefined,
      async (tx) => {
        const result = await reconcileAttachmentIntegrityPage(tx, limit, now)
        return result
      },
    )
  }

  async getChat(chatId: ChatId): Promise<Chat | undefined> {
    return this.openDb().then((db) => db.chats.get(chatId))
  }

  private async setChatsArchived(
    chatIds: readonly ChatId[],
    archived: boolean,
    now: number,
    commit: BrowserCommandCommit,
  ): Promise<ChatMetadataWriteResult<readonly ChatId[]>> {
    const runtime = await import('./browser-catalog-command-runtime')
    return runtime.setChatsArchived(chatIds, archived, now, commit)
  }

  private async touchChatViewed(
    chatId: ChatId,
    now: number,
    commit: BrowserCommandCommit,
  ): Promise<ChatMetadataWriteResult<boolean>> {
    const runtime = await import('./browser-catalog-command-runtime')
    return runtime.touchChatViewed(chatId, now, commit)
  }

  private async setChatManualTitle(
    chatId: ChatId,
    title: string,
    now: number,
    commit: BrowserCommandCommit,
  ): Promise<ChatMetadataWriteResult<boolean>> {
    const runtime = await import('./browser-catalog-command-runtime')
    return runtime.setChatManualTitle(chatId, title, now, commit)
  }

  private async moveChatRowsToFolder(
    chatIds: readonly ChatId[],
    folderId: FolderId | null,
    now: number,
    commit: BrowserCommandCommit,
  ): Promise<ChatMetadataWriteResult<boolean>> {
    const runtime = await import('./browser-catalog-command-runtime')
    return runtime.moveChatRowsToFolder(chatIds, folderId, now, commit)
  }

  private async setChatRowsTagsFromNames(
    chatIds: readonly ChatId[],
    names: readonly string[],
    now: number,
    commit: BrowserCommandCommit,
  ): Promise<ChatTagAssignmentResult> {
    const runtime = await import('./browser-catalog-command-runtime')
    return runtime.setChatRowsTagsFromNames(chatIds, names, now, commit)
  }

  private async clearChatCalibration(
    command: Extract<WorkspaceCommand, { kind: 'chat.calibration.clear' }>,
    commit: BrowserCommandCommit,
  ): Promise<ChatMetadataWriteResult<boolean>> {
    const runtime = await import('./browser-catalog-command-runtime')
    return runtime.clearChatCalibration(command, commit)
  }

  private async clearCalibrationEverywhere(
    command: Extract<
      WorkspaceCommand,
      { kind: 'chat.calibration.clear-family' | 'chat.calibration.clear-all' }
    >,
    commit: BrowserCommandCommit,
  ): Promise<ChatCalibrationEverywhereResult> {
    const runtime = await import('./browser-catalog-command-runtime')
    return runtime.clearCalibrationEverywhere(command, commit)
  }

  private async deleteArchivedChatRows(
    chatIds: readonly ChatId[],
    now: number,
    commit: BrowserCommandCommit,
  ): Promise<DeleteArchivedChatMetadataResult> {
    const runtime = await import('./browser-catalog-command-runtime')
    return runtime.deleteArchivedChatRows(chatIds, now, commit)
  }

  private async emptyArchivedChatRows(
    input: { afterChatId?: ChatId; limit: number; now: number },
    commit: BrowserCommandCommit,
  ) {
    const runtime = await import('./browser-catalog-command-runtime')
    return runtime.emptyArchivedChatRows(input, commit)
  }

  async listFolders(): Promise<ChatFolder[]> {
    const db = await this.openDb()
    return sortChatFolders(await readStringPrimaryKeyPages(db.folders, (folder) => folder.id))
  }

  async createFolder(input: CreateFolderInput, commit: BrowserCommandCommit): Promise<ChatFolder> {
    const runtime = await import('./browser-catalog-command-runtime')
    return runtime.createFolder(input, commit)
  }

  async updateFolder(
    folderId: FolderId,
    patch: UpdateFolderInput,
    commit: BrowserCommandCommit,
  ): Promise<ChatFolder | undefined> {
    const runtime = await import('./browser-catalog-command-runtime')
    return runtime.updateFolder(folderId, patch, commit)
  }

  private async ensureFolderAndMoveChats(
    input: EnsureFolderAndMoveChatsInput,
    commit: BrowserCommandCommit,
  ): Promise<EnsureFolderAndMoveChatsResult> {
    const runtime = await import('./browser-catalog-command-runtime')
    return runtime.ensureFolderAndMoveChats(input, commit)
  }

  async deleteFolder(
    folderId: FolderId,
    chatDisposition: 'move-top-level' | 'archive',
    now: number,
    commit: BrowserCommandCommit,
  ): Promise<DeleteFolderResult> {
    const runtime = await import('./browser-catalog-command-runtime')
    return runtime.deleteFolder(folderId, chatDisposition, now, commit)
  }

  async listTags(): Promise<ChatTag[]> {
    const db = await this.openDb()
    return sortTags(await readStringPrimaryKeyPages(db.tags, (tag) => tag.id))
  }

  async getMessage(
    messageId: MessageId,
    options: { signal?: AbortSignal } = {},
  ): Promise<Message | undefined> {
    return readStoredMessage(await this.openDb(), messageId, options.signal, hydrateStoredMessage)
  }

  async getMessageTextPreviewWindow(
    targets: readonly MessageTextPreviewTarget[],
    options: { maxChars?: number; signal?: AbortSignal } = {},
  ): Promise<Array<MessageTextPreviewSnapshot | undefined>> {
    throwIfReadonlyAborted(options.signal, 'Message preview read aborted')
    if (targets.length === 0) return []
    return readMessageTextPreviewWindow(await this.openDb(), targets, options)
  }

  async getMessageHeader(messageId: MessageId): Promise<MessageHeaderRow | undefined> {
    const db = await this.openDb()
    const header = await db.messages.get(messageId)
    return header ? cloneMessageHeader(header) : undefined
  }

  async getMessageHeaders(
    messageIds: readonly MessageId[],
    options: { signal?: AbortSignal } = {},
  ): Promise<Array<MessageHeaderRow | undefined>> {
    throwIfReadonlyAborted(options.signal, 'Header read aborted')
    const db = await this.openDb()
    const headers = await readBulkGetPages(db.messages, messageIds, options)
    return headers.map((header) => (header ? cloneMessageHeader(header) : undefined))
  }

  async listMessageHeaders(
    chatId: ChatId,
    options: { signal?: AbortSignal } = {},
  ): Promise<MessageHeaderRow[]> {
    throwIfReadonlyAborted(options.signal, 'Header read aborted')
    const db = await this.openDb()
    const headers = await readChatMessageHeaderPages(db, chatId, options)
    throwIfReadonlyAborted(options.signal, 'Header read aborted')
    return headers.map(cloneMessageHeader)
  }

  async listChildHeaders(
    chatId: ChatId,
    parentId: MessageId | null,
    options: { signal?: AbortSignal } = {},
  ): Promise<MessageHeaderRow[]> {
    const rows = await readChildHeaderPages(await this.openDb(), chatId, parentId, options)
    return rows.map(cloneMessageHeader)
  }

  private async readConversationStructuralFrame(
    db: NatterDb,
    permit: WorkspaceReadAuthority,
    chatId: ChatId,
    signal?: AbortSignal,
  ) {
    return db.transaction('r', [db.workspaceFence, db.chats], async (tx: Transaction) => {
      const unbind = bindReadonlyTransactionAbort(tx, signal, 'Conversation frame read aborted')
      try {
        const [workspace, chat] = await Promise.all([
          readBrowserWorkspaceMetaFromTransaction(tx),
          tx.table<Chat, ChatId>('chats').get(chatId),
        ])
        assertPermitFence(permit, workspace)
        throwIfReadonlyAborted(signal, 'Conversation frame read aborted')
        return Object.freeze({
          workspace,
          chat: chat ? Object.freeze(structuredClone(chat)) : undefined,
        })
      } finally {
        unbind()
      }
    })
  }

  private async readConversationOpenFrame<T>(
    db: NatterDb,
    permit: WorkspaceReadAuthority,
    chatId: ChatId,
    expectedStructuralVersion: number,
    stores: readonly ConversationOpenFrameStore[],
    signal: AbortSignal | undefined,
    read: (tx: Transaction) => Promise<T>,
  ) {
    const payloadTables: Table[] = stores.map((store) => {
      switch (store) {
        case 'messages':
          return db.messages
        case 'messageBodies':
          return db.messageBodies
        case 'childLists':
          return db.childLists
        case 'childSlotMembers':
          return db.childSlotMembers
        default:
          return assertNever(store)
      }
    })
    return db.transaction(
      'r',
      [db.workspaceFence, db.chats, ...new Set(payloadTables)],
      async (tx: Transaction) => {
        const unbind = bindReadonlyTransactionAbort(tx, signal, 'Conversation frame read aborted')
        try {
          const workspace = await readBrowserWorkspaceMetaFromTransaction(tx)
          const chat = await tx.table<Chat, ChatId>('chats').get(chatId)
          assertPermitFence(permit, workspace)
          throwIfReadonlyAborted(signal, 'Conversation frame read aborted')
          if (!chat || chat.structuralVersion !== expectedStructuralVersion) {
            return Object.freeze({ kind: 'stale' as const })
          }
          const value = await read(tx)
          throwIfReadonlyAborted(signal, 'Conversation frame read aborted')
          return Object.freeze({ kind: 'ready' as const, value })
        } finally {
          unbind()
        }
      },
    )
  }

  private async readConversationTopologyEnvelope(
    permit: WorkspaceReadAuthority,
    chatId: ChatId,
    signal?: AbortSignal,
  ): Promise<ReadEnvelope<ConversationTopologyResult>> {
    throwIfReadonlyAborted(signal, 'Conversation topology read aborted')
    const db = await this.openDb()
    const initial = await this.readConversationStructuralFrame(db, permit, chatId, signal)
    const [headers, childSlots] = initial.chat
      ? await Promise.all([
          readChatMessageHeaderPages(db, chatId, signal ? { signal } : {}),
          db.childLists.where('chatId').equals(chatId).toArray(),
        ])
      : [[], []]
    const final = await this.readConversationStructuralFrame(db, permit, chatId, signal)
    const value: ConversationTopologyResult =
      initial.chat === undefined
        ? final.chat === undefined
          ? Object.freeze({ kind: 'missing', chatId })
          : Object.freeze({ kind: 'stale' })
        : final.chat === undefined ||
            initial.chat.structuralVersion !== final.chat.structuralVersion
          ? Object.freeze({ kind: 'stale' })
          : Object.freeze({
              kind: 'ready',
              chat: structuredClone(final.chat),
              structuralVersion: final.chat.structuralVersion,
              headers: Object.freeze(headers.map(cloneMessageHeader)),
              childSlots: Object.freeze(childSlots.map((state) => structuredClone(state))),
            })
    return {
      workspaceId: final.workspace.workspaceId,
      replacementEpoch: final.workspace.replacementEpoch,
      value,
    }
  }

  private async readConversationPageStructureEnvelope(
    permit: WorkspaceReadAuthority,
    chatId: ChatId,
    resolvedTipId: MessageId,
    structuralVersion: number,
    pathWindow: BranchPathWindow<MessageHeaderRow>,
    signal?: AbortSignal,
  ) {
    if (pathWindow.nodes.length > TRANSCRIPT_BODY_READ_BATCH_ROWS) {
      throw new Error('BranchPageBatchTooLarge')
    }
    const branchLength = pathWindow.branchLength
    const pageMessageIds = pathWindow.nodes.map((header) => header.id)
    const boundaryParentId = pathWindow.boundaryParentId
    throwIfReadonlyAborted(signal, 'Branch page structure read aborted')
    const db = await this.openDb()
    return db.transaction(
      'r',
      [db.workspaceFence, db.chats, db.messages],
      async (tx: Transaction) => {
        const unbind = bindReadonlyTransactionAbort(
          tx,
          signal,
          'Branch page structure read aborted',
        )
        try {
          const [workspace, chat, storedHeaders] = await Promise.all([
            readBrowserWorkspaceMetaFromTransaction(tx),
            tx.table<Chat, ChatId>('chats').get(chatId),
            tx.table<MessageHeaderRow, MessageId>('messages').bulkGet(pageMessageIds),
          ])
          assertPermitFence(permit, workspace)
          throwIfReadonlyAborted(signal, 'Branch page structure read aborted')
          const structuralValue: KnownBranchPageStructuralResult = (() => {
            if (branchLength === 0) {
              return { kind: 'stale-path', chatId, reason: 'empty-path' }
            }
            if (
              pathWindow.offset + pathWindow.nodes.length === branchLength &&
              pathWindow.nodes.at(-1)?.id !== resolvedTipId
            ) {
              return { kind: 'stale-path', chatId, reason: 'non-contiguous' }
            }

            const seen = new Set<MessageId>()
            const pageHeaders: MessageHeaderRow[] = []
            if (!chat) return { kind: 'stale-path', chatId, reason: 'chat-missing' }
            if (chat.structuralVersion !== structuralVersion) {
              return { kind: 'stale-path', chatId, reason: 'structural-version-mismatch' }
            }
            for (let index = 0; index < pathWindow.nodes.length; index += 1) {
              const expectedHeader = pathWindow.nodes[index] as MessageHeaderRow
              const header = storedHeaders[index]
              if (!header) {
                return {
                  kind: 'stale-path',
                  chatId,
                  reason: 'missing-header',
                  messageId: expectedHeader.id,
                }
              }
              if (seen.has(header.id)) {
                return {
                  kind: 'stale-path',
                  chatId,
                  reason: 'duplicate-id',
                  messageId: header.id,
                }
              }
              seen.add(header.id)
              if (header.chatId !== chatId) {
                return {
                  kind: 'stale-path',
                  chatId,
                  reason: 'wrong-chat',
                  messageId: header.id,
                }
              }
              if (header.deleted) {
                return {
                  kind: 'stale-path',
                  chatId,
                  reason: 'deleted-header',
                  messageId: header.id,
                }
              }
              const expectedParentId =
                index === 0 ? boundaryParentId : (pathWindow.nodes[index - 1]?.id ?? null)
              if (
                !sameMessageHeaderStructure(header, expectedHeader) ||
                header.parentId !== expectedParentId
              ) {
                return {
                  kind: 'stale-path',
                  chatId,
                  reason:
                    header.parentId !== expectedParentId && pathWindow.offset === 0 && index === 0
                      ? 'non-root'
                      : 'non-contiguous',
                  messageId: header.id,
                }
              }
              pageHeaders.push(cloneMessageHeader(header))
            }

            return {
              kind: 'ready',
              snapshot: {
                chatId,
                pageHeaders,
                pageOffset: pathWindow.offset,
                pageLimit: pathWindow.limit,
                branchLength,
              },
            }
          })()
          assertWorkspaceReadPermit(permit)
          throwIfReadonlyAborted(signal, 'Branch page structure read aborted')
          return {
            workspaceId: workspace.workspaceId,
            replacementEpoch: workspace.replacementEpoch,
            value: Object.freeze(structuralValue),
          }
        } finally {
          unbind()
        }
      },
    )
  }

  private async readConversationOpenEnvelope(
    permit: WorkspaceReadAuthority,
    chatId: ChatId,
    target: ConversationSelectionProofTarget,
    bodyDemand: 'terminal' | 'none',
    onStage?: (stage: ReadEnvelope<ConversationDestinationPoint>) => void,
    signal?: AbortSignal,
  ) {
    throwIfReadonlyAborted(signal, 'Conversation open read aborted')
    const db = await this.openDb()
    let stageDelivered = false
    const initial = await db.transaction(
      'r',
      [db.workspaceFence, db.chats, db.messages, db.childLists, db.childSlotMembers],
      async (tx: Transaction) => {
        const unbind = bindReadonlyTransactionAbort(tx, signal, 'Conversation open read aborted')
        try {
          const workspace = await readBrowserWorkspaceMetaFromTransaction(tx)
          const chat = await tx.table<Chat, ChatId>('chats').get(chatId)
          assertPermitFence(permit, workspace)
          const receipt = await readConversationOpenInitialReceiptInTransaction(
            tx,
            chatId,
            chat ? Object.freeze(structuredClone(chat)) : undefined,
            target,
            signal,
          )
          throwIfReadonlyAborted(signal, 'Conversation open read aborted')
          return Object.freeze({ workspace, receipt })
        } finally {
          unbind()
        }
      },
    )
    const expectedStructuralVersion =
      initial.receipt.kind === 'missing' ? -1 : initial.receipt.chat.structuralVersion
    const result = await resolveConversationOpenReceipt(
      {
        runFrame: (stores, read) =>
          this.readConversationOpenFrame(
            db,
            permit,
            chatId,
            expectedStructuralVersion,
            stores,
            signal,
            read,
          ),
        readTerminalPresentation: (messageId, bodySignal) =>
          this.readConversationOpenFrame(
            db,
            permit,
            chatId,
            expectedStructuralVersion,
            ['messages', 'messageBodies'],
            bodySignal,
            async (tx) => {
              const [header, body] = await Promise.all([
                tx.table<MessageHeaderRow, MessageId>('messages').get(messageId),
                tx.table<MessageBodyRow, MessageId>('messageBodies').get(messageId),
              ])
              if (!header || !body) return undefined
              const clonedHeader = cloneMessageHeader(header)
              return Object.freeze({
                header: clonedHeader,
                message: hydrateMessageWithOwnedBody(clonedHeader, body),
                bodyVersion: clonedHeader.bodyVersion,
              })
            },
          ),
      },
      initial.receipt,
      bodyDemand,
      onStage
        ? (point) => {
            if (stageDelivered) return
            assertWorkspaceReadPermit(permit)
            throwIfReadonlyAborted(signal, 'Conversation open read aborted')
            const currentTransaction = (
              Dexie as unknown as { readonly currentTransaction?: Transaction }
            ).currentTransaction
            if (currentTransaction) {
              throw new Error('ConversationOpenStageTransactionLeak')
            }
            stageDelivered = true
            const stage = Object.freeze({
              workspaceId: initial.workspace.workspaceId,
              replacementEpoch: initial.workspace.replacementEpoch,
              value: point,
            })
            try {
              onStage(stage)
            } catch {
              // The terminal point is an optional latency stage; the sealed final result
              // remains authoritative if its consumer has already moved on.
            }
          }
        : undefined,
      signal,
    )
    assertWorkspaceReadPermit(permit)
    throwIfReadonlyAborted(signal, 'Conversation open read aborted')
    return {
      workspaceId: initial.workspace.workspaceId,
      replacementEpoch: initial.workspace.replacementEpoch,
      value: result,
    }
  }

  private async readConversationForksEnvelope(
    permit: WorkspaceReadAuthority,
    chatId: ChatId,
    structuralVersion: number,
    targets: readonly ActiveBranchForkTarget[],
    signal?: AbortSignal,
  ): Promise<ReadEnvelope<ConversationForksResult>> {
    throwIfReadonlyAborted(signal, 'Active branch fork read aborted')
    const db = await this.openDb()
    return db.transaction(
      'r',
      [db.workspaceFence, db.chats, db.messages, db.childLists, db.childSlotMembers],
      async (tx: Transaction) => {
        const unbind = bindReadonlyTransactionAbort(tx, signal, 'Active branch fork read aborted')
        try {
          const [workspace, chat] = await Promise.all([
            readBrowserWorkspaceMetaFromTransaction(tx),
            tx.table<Chat, ChatId>('chats').get(chatId),
          ])
          assertPermitFence(permit, workspace)
          const value: ConversationForksResult =
            !chat || chat.structuralVersion !== structuralVersion
              ? Object.freeze({ kind: 'stale-selection' })
              : Object.freeze({
                  kind: 'ready',
                  structuralVersion,
                  forks: await readActiveBranchForksInTransaction(tx, chatId, targets, signal),
                })
          assertWorkspaceReadPermit(permit)
          throwIfReadonlyAborted(signal, 'Active branch fork read aborted')
          return {
            workspaceId: workspace.workspaceId,
            replacementEpoch: workspace.replacementEpoch,
            value,
          }
        } finally {
          unbind()
        }
      },
    )
  }

  async getActiveBranchChildAtPosition(
    chatId: ChatId,
    parentId: MessageId | null,
    position: number,
    signal?: AbortSignal,
  ): Promise<MessageId | null> {
    throwIfReadonlyAborted(signal, 'Active branch child position read aborted')
    const db = await this.openDb()
    return db.transaction(
      'r',
      [db.messages, db.childLists, db.childSlotMembers],
      async (tx: Transaction) => {
        const unbind = bindReadonlyTransactionAbort(
          tx,
          signal,
          'Active branch child position read aborted',
        )
        try {
          return await readActiveBranchChildAtPositionInTransaction(
            tx,
            chatId,
            parentId,
            position,
            signal,
          )
        } finally {
          unbind()
        }
      },
    )
  }

  private async writeAttachmentBundle(
    input: AttachmentBundleWriteInput,
    commit: BrowserCommandCommit,
  ): Promise<AttachmentBundleWriteResult> {
    const { bundle, mode } = input
    const mutation = await this.runMutation(
      [{ kind: 'attachment', attachmentId: bundle.attachment.id }],
      (ctx) => ctx.writeAttachmentBundle(bundle, mode),
      (mode === 'dedupe' || mode === 'dedupe-or-replace') && bundle.attachment.contentHash
        ? {
            attachmentContentIdentity: {
              attachmentId: bundle.attachment.id,
              contentHash: bundle.attachment.contentHash,
              filename: bundle.attachment.filename,
            },
          }
        : undefined,
      commit,
    )
    return mutation.value
  }

  private async addAttachmentReference(
    input: AttachmentRefAddInput,
    commit: BrowserCommandCommit,
  ): Promise<AttachmentRefWriteResult> {
    const scopes = attachmentOwnerScopes(input.owner, [input.ref.attachmentId])
    const mutation = await this.runMutation(
      scopes,
      async (ctx) => {
        if (!(await ctx.getAttachment(input.ref.attachmentId))) {
          throw new Error(`AttachmentMissing:${input.ref.attachmentId}`)
        }
        if (input.owner.kind === 'message') {
          const message = await attachmentOwnerMessage(ctx, input.owner)
          const refs = normalizeAttachmentRefs(message.attachmentRefs, {
            messageId: message.id,
            createdAt: message.createdAt,
          })
          if (refs.some((ref) => ref.refId === input.ref.refId)) {
            throw new Error(`AttachmentRefAlreadyExists:${input.ref.refId}`)
          }
          const nextRefs = insertAttachmentRef(refs, input.ref, input.afterRefId)
          const written = await ctx.putMessage(
            messageWithWorkspaceAttachmentRefs(message, nextRefs),
            {
              touchChatSummary: false,
            },
          )
          return attachmentMessageRefResult(ctx, written, input.ref)
        }
        const current =
          (await ctx.getDraft(input.owner.chatId)) ??
          ({
            chatId: input.owner.chatId,
            text: '',
            attachmentRefs: [],
            updatedAt: 0,
          } satisfies DraftRow)
        const refs = normalizeAttachmentRefs(current.attachmentRefs, {
          draftChatId: current.chatId,
          createdAt: current.updatedAt,
        })
        if (refs.some((ref) => ref.refId === input.ref.refId)) {
          throw new Error(`AttachmentRefAlreadyExists:${input.ref.refId}`)
        }
        const draft = {
          ...current,
          attachmentRefs: insertAttachmentRef(refs, input.ref, input.afterRefId),
          updatedAt: strictlyMonotonicTimestamp(current.updatedAt, input.now),
        }
        await ctx.putDraft(draft)
        return { ref: input.ref, draft }
      },
      undefined,
      commit,
    )
    return mutation.value
  }

  private async setAttachmentReferenceVisibility(
    input: AttachmentRefVisibilityInput,
    commit: BrowserCommandCommit,
  ): Promise<AttachmentRefWriteResult> {
    return this.mutateSingleAttachmentReference(
      input.owner,
      input.expectedAttachmentId,
      commit,
      (ref) => ({ ...ref, includeInContext: input.includeInContext, updatedAt: input.now }),
      input.refId,
    )
  }

  private async detachAttachmentReference(
    input: AttachmentRefDetachInput,
    commit: BrowserCommandCommit,
  ): Promise<AttachmentRefWriteResult> {
    return this.mutateSingleAttachmentReference(
      input.owner,
      input.expectedAttachmentId,
      commit,
      () => undefined,
      input.refId,
      input.now,
    )
  }

  private async mutateSingleAttachmentReference(
    owner: AttachmentRefOwner,
    expectedAttachmentId: AttachmentId,
    commit: BrowserCommandCommit,
    mutate: (ref: MessageAttachmentRef) => MessageAttachmentRef | undefined,
    refId: string,
    now = Date.now(),
  ): Promise<AttachmentRefWriteResult> {
    const mutation = await this.runMutation(
      attachmentOwnerScopes(owner, [expectedAttachmentId]),
      async (ctx) => {
        if (owner.kind === 'message') {
          const message = await attachmentOwnerMessage(ctx, owner)
          const refs = normalizeAttachmentRefs(message.attachmentRefs, {
            messageId: message.id,
            createdAt: message.createdAt,
          })
          const index = refs.findIndex((ref) => ref.refId === refId)
          if (index < 0) return {}
          const existing = refs[index] as MessageAttachmentRef
          assertExpectedAttachmentReference(existing, expectedAttachmentId)
          const updated = mutate(existing)
          const nextRefs = [...refs]
          if (updated) nextRefs[index] = updated
          else nextRefs.splice(index, 1)
          const written = await ctx.putMessage(
            messageWithWorkspaceAttachmentRefs(message, nextRefs),
            {
              touchChatSummary: false,
            },
          )
          return attachmentMessageRefResult(ctx, written, updated)
        }
        const draft = await ctx.getDraft(owner.chatId)
        if (!draft) return {}
        const refs = normalizeAttachmentRefs(draft.attachmentRefs, {
          draftChatId: draft.chatId,
          createdAt: draft.updatedAt,
        })
        const index = refs.findIndex((ref) => ref.refId === refId)
        if (index < 0) return {}
        const existing = refs[index] as MessageAttachmentRef
        assertExpectedAttachmentReference(existing, expectedAttachmentId)
        const updated = mutate(existing)
        const nextRefs = [...refs]
        if (updated) nextRefs[index] = updated
        else nextRefs.splice(index, 1)
        const next = {
          ...draft,
          attachmentRefs: nextRefs,
          updatedAt: strictlyMonotonicTimestamp(draft.updatedAt, now),
        }
        await ctx.putDraft(next)
        return { ...(updated ? { ref: updated } : {}), draft: next }
      },
      undefined,
      commit,
    )
    return mutation.value
  }

  private async relinkAttachmentReferences(
    input: AttachmentRefRelinkInput,
    commit: BrowserCommandCommit,
  ): Promise<AttachmentRefRelinkResult> {
    const attachmentIds = [
      input.newAttachmentId,
      ...input.refs.map((ref) => ref.expectedAttachmentId),
      ...(input.supersedeAttachmentId ? [input.supersedeAttachmentId] : []),
    ]
    const scopes = dedupeMutationScopes([
      ...input.refs.flatMap((ref) => attachmentOwnerScopes(ref.owner)),
      ...attachmentIds.map((attachmentId) => ({
        kind: 'attachment' as const,
        attachmentId,
      })),
    ])
    const mutation = await this.runMutation(
      scopes,
      async (ctx) => {
        if (!(await ctx.getAttachment(input.newAttachmentId))) {
          throw new Error(`AttachmentMissing:${input.newAttachmentId}`)
        }
        const grouped = groupAttachmentRelinkSpecs(input.refs)
        const updatedByInput = new Map<number, MessageAttachmentRef>()
        const presentations: MessagePresentation[] = []
        const drafts: DraftRow[] = []
        for (const group of grouped.values()) {
          if (group.owner.kind === 'message') {
            const message = await attachmentOwnerMessage(ctx, group.owner)
            const refs = normalizeAttachmentRefs(message.attachmentRefs, {
              messageId: message.id,
              createdAt: message.createdAt,
            })
            const nextRefs = applyAttachmentRelinks(
              refs,
              group.specs,
              input.newAttachmentId,
              input.now,
              updatedByInput,
            )
            const written = await ctx.putMessage(
              messageWithWorkspaceAttachmentRefs(message, nextRefs),
              {
                touchChatSummary: false,
              },
            )
            const result = await attachmentMessageRefResult(ctx, written)
            if (result.presentation) presentations.push(result.presentation)
          } else {
            const draft = await ctx.getDraft(group.owner.chatId)
            if (!draft) throw new Error(`DraftMissing:${group.owner.chatId}`)
            const refs = normalizeAttachmentRefs(draft.attachmentRefs, {
              draftChatId: draft.chatId,
              createdAt: draft.updatedAt,
            })
            const next = {
              ...draft,
              attachmentRefs: applyAttachmentRelinks(
                refs,
                group.specs,
                input.newAttachmentId,
                input.now,
                updatedByInput,
              ),
              updatedAt: strictlyMonotonicTimestamp(draft.updatedAt, input.now),
            }
            await ctx.putDraft(next)
            drafts.push(next)
          }
        }
        if (input.supersedeAttachmentId) {
          const superseded = await ctx.getAttachment(input.supersedeAttachmentId)
          if (!superseded) {
            throw new Error(`AttachmentMissing:${input.supersedeAttachmentId}`)
          }
          await ctx.putAttachment({
            ...superseded,
            supersededByAttachmentId: input.newAttachmentId,
            updatedAt: input.now,
          })
        }
        return {
          refs: input.refs.map((_, index) => {
            const ref = updatedByInput.get(index)
            if (!ref) throw new Error(`AttachmentRelinkResultMissing:${index}`)
            return ref
          }),
          presentations,
          drafts,
        }
      },
      undefined,
      commit,
    )
    return mutation.value
  }

  private async deleteAttachmentBytes(
    input: AttachmentDeleteBytesInput,
    commit: BrowserCommandCommit,
  ): Promise<Attachment | undefined> {
    const mutation = await this.runMutation(
      [{ kind: 'attachment', attachmentId: input.attachmentId }],
      (ctx) => ctx.deleteAttachmentBytes(input.attachmentId, input.reason, input.now),
      undefined,
      commit,
    )
    return mutation.value
  }

  private async deleteAttachmentIfUnreferenced(
    attachmentId: AttachmentId,
    commit: BrowserCommandCommit,
  ): Promise<AttachmentDeleteIfUnreferencedResult> {
    const mutation = await this.runMutation(
      [{ kind: 'attachment', attachmentId }],
      (ctx) => ctx.deleteAttachmentIfUnreferenced(attachmentId),
      undefined,
      commit,
    )
    return mutation.value
  }

  private async deleteManyAttachments(
    input: AttachmentDeleteManyInput,
    commit: BrowserCommandCommit,
  ): Promise<AttachmentDeleteManyResult> {
    const attachmentIds = [...new Set(input.attachmentIds)]
    if (attachmentIds.length === 0 || attachmentIds.length > MAX_STORAGE_MAINTENANCE_BATCH) {
      throw new Error('AttachmentDeleteManyBatchInvalid')
    }
    const mutation = await this.runMutation(
      attachmentIds.map((attachmentId) => ({ kind: 'attachment', attachmentId })),
      async (ctx) => {
        const deletedAttachmentIds: AttachmentId[] = []
        const stubbedAttachmentIds: AttachmentId[] = []
        const absentAttachmentIds: AttachmentId[] = []
        for (const attachmentId of attachmentIds) {
          const disposition = await ctx.deleteAttachmentForStorage(
            attachmentId,
            input.reason,
            input.now,
          )
          switch (disposition) {
            case 'deleted':
              deletedAttachmentIds.push(attachmentId)
              break
            case 'stubbed':
              stubbedAttachmentIds.push(attachmentId)
              break
            case 'absent':
              absentAttachmentIds.push(attachmentId)
              break
          }
        }
        return { deletedAttachmentIds, stubbedAttachmentIds, absentAttachmentIds }
      },
      { expectedAttachmentCatalogRevision: input.expectedCatalogRevision },
      commit,
      async (ctx, result) => ({
        ...result,
        catalogRevision: await ctx.getAttachmentCatalogRevision(),
      }),
    )
    return mutation.value
  }

  private async reapAttachments(
    now: number,
    maxAgeMs: number,
    requestedLimit: number | undefined,
    commit: BrowserCommandCommit,
  ): Promise<AttachmentReapResult> {
    const limit = boundedMaintenanceLimit(requestedLimit ?? MAX_STORAGE_MAINTENANCE_BATCH)
    const plan = await readAttachmentReapPlan(commit, now, maxAgeMs, limit)
    if (plan[attachmentReapPlanBrand] !== true) throw new Error('AttachmentReapPlanInvalid')
    const { candidates, cycle } = plan
    const candidateIds = candidates.map((candidate) => candidate.id)
    type AttachmentReapPageOutcome =
      | { readonly done: false; readonly cursor?: AttachmentReapCursor }
      | { readonly done: true; readonly earliestDeferredAt?: number }
    const mutation = await this.runMutation(
      candidateIds.map((attachmentId) => ({ kind: 'attachment', attachmentId })),
      async (ctx) => {
        const deleted: AttachmentId[] = []
        for (const attachmentId of candidateIds) {
          const disposition = await ctx.reapAttachmentIfEligible(attachmentId, cycle.cutoff)
          if (disposition === 'deleted') {
            deleted.push(attachmentId)
          }
        }
        return deleted
      },
      undefined,
      commit,
      undefined,
      {
        access: {
          readTableNames: ['attachments'],
          writeTableNames: ['attachmentIntegrityState', 'storageRetentionState'],
        },
        receipt: {
          exactOccurrence: true,
          replay: attachmentReapReplayPlan(cycle, limit),
        },
        async commit(tx) {
          const receipt =
            boundSemanticOperationExactReceiptAccumulator<BrowserMutationTableName>(tx)
          if (!receipt) throw new Error('AttachmentReapExactReceiptAccumulatorMissing')
          const last = candidates.at(-1)
          const cursor = last
            ? {
                unreferencedAt: last.unreferencedAt,
                attachmentId: last.id,
              }
            : cycle.cursor
          const lower = cursor ? [0, cursor.unreferencedAt, cursor.attachmentId] : [0]
          const attachmentTable = tx.table<AttachmentHeaderRow, AttachmentId>('attachments')
          const nextDue = await attachmentTable
            .where('[refCount+unreferencedAt+id]')
            .between(lower, [0, cycle.cutoff], false, false)
            .first()
          receipt.physicalRead({
            tableName: 'attachments',
            indexKind: 'secondary',
            indexName: '[refCount+unreferencedAt+id]',
            operation: 'query',
            requestCount: 1,
            rowCount: nextDue ? 1 : 0,
          })
          let outcome: AttachmentReapPageOutcome
          if (nextDue) {
            outcome = { done: false, ...(cursor ? { cursor } : {}) }
          } else {
            const deferred = await attachmentTable
              .where('[refCount+unreferencedAt+id]')
              .between([0, cycle.cutoff], [0, []], true, false)
              .first()
            receipt.physicalRead({
              tableName: 'attachments',
              indexKind: 'secondary',
              indexName: '[refCount+unreferencedAt+id]',
              operation: 'query',
              requestCount: 1,
              rowCount: deferred ? 1 : 0,
            })
            outcome = {
              done: true,
              ...(typeof deferred?.unreferencedAt === 'number'
                ? { earliestDeferredAt: deferred.unreferencedAt }
                : {}),
            }
          }
          receipt.absorb(await commitStorageRetentionPage(tx, cycle, outcome))
          return outcome
        },
      },
    )
    const committedOutcome = mutation.transactionExtensionResult
    return {
      scanned: candidates.length,
      deletedAttachmentIds: mutation.value,
      ...(committedOutcome.done && committedOutcome.earliestDeferredAt !== undefined
        ? { earliestDeferredAt: committedOutcome.earliestDeferredAt }
        : {}),
      done: committedOutcome.done,
    }
  }

  private async putDraftRow(
    input: { draft: DraftRow; expectedUpdatedAt: number | null },
    commit: BrowserCommandCommit,
  ): Promise<DraftRow> {
    const plan = await readDraftPutPlan(commit, input)
    const attachmentIds = [...plan.previousAttachmentIds, ...plan.nextAttachmentIds]
    const mutation = await this.runMutation(
      attachmentOwnerScopes({ kind: 'draft', chatId: input.draft.chatId }, attachmentIds),
      async (ctx, mutation) => {
        const current = await ctx.getDraft(input.draft.chatId)
        if ((current?.updatedAt ?? null) !== input.expectedUpdatedAt) {
          throw new Error(`DraftChanged:${input.draft.chatId}`)
        }
        if (
          plan[draftPutPlanBrand] !== true ||
          plan.chatId !== input.draft.chatId ||
          !sameOrderedValues(
            draftPutAttachmentIds(current?.attachmentRefs),
            plan.previousAttachmentIds,
          )
        ) {
          throw new DraftPutPlanChangedError(input.draft.chatId)
        }
        const draft = {
          ...input.draft,
          updatedAt: current
            ? strictlyMonotonicTimestamp(current.updatedAt, input.draft.updatedAt)
            : input.draft.updatedAt,
        }
        const becameEmpty =
          current !== undefined &&
          (current.text.trim().length > 0 || current.attachmentRefs.length > 0) &&
          draft.text.trim().length === 0 &&
          draft.attachmentRefs.length === 0
        await ctx.putDraft(draft, { validateAttachmentTargets: true })
        if (becameEmpty) mutation.requestStorageMaintenance('prune-empty-drafts')
        return { draft, becameEmpty }
      },
      { storageMaintenanceTasks: ['prune-empty-drafts'] },
      commit,
    )
    return mutation.value.draft
  }

  private async claimGeneratedOutputLocalization(
    input: GeneratedOutputLocalizationClaimInput,
    commit: BrowserCommandCommit,
  ): Promise<GeneratedOutputLocalizationClaim | undefined> {
    const attachmentId = await this.generatedOutputLocalizationAttachmentId(input.jobId, commit)
    if (!attachmentId) return undefined
    const mutation = await this.runMutation(
      [{ kind: 'attachment', attachmentId }],
      async (ctx) => {
        const attachment = await ctx.getAttachment(attachmentId)
        const job = (await ctx.getAttachmentJobs(attachmentId)).find(
          (candidate) => candidate.id === input.jobId,
        )
        if (!attachment || !isGeneratedOutputLocalizationJob(job)) return undefined
        if (!generatedOutputLocalizationSourceMatches(attachment, job)) return undefined
        const claimable =
          (job.status === 'pending' &&
            job.nextAttemptAt !== undefined &&
            job.nextAttemptAt <= input.now) ||
          (job.status === 'running' && (job.leaseExpiresAt ?? 0) <= input.now)
        if (!claimable) return undefined
        const claimed = runningGeneratedOutputLocalizationJob(job, input)
        await ctx.putAttachmentJob(claimed, { affectsWire: false })
        return {
          job: claimed,
          attachment: generatedOutputLocalizationAttachmentProjection(attachment),
        }
      },
      undefined,
      commit,
      undefined,
      {
        access: {
          readTableNames: ['attachmentRefEdges', 'chats'],
        },
        commit: (tx, value) =>
          value
            ? this.generatedOutputLocalizationProfileIds(tx, attachmentId)
            : Promise.resolve([]),
      },
    )
    if (!mutation.value) return undefined
    return {
      ...mutation.value,
      profileIds: mutation.transactionExtensionResult,
    }
  }

  private async retryGeneratedOutputLocalization(
    input: GeneratedOutputLocalizationRetryInput,
    commit: BrowserCommandCommit,
  ): Promise<GeneratedOutputLocalizationJobResult> {
    const attachmentId = await this.generatedOutputLocalizationAttachmentId(input.jobId, commit)
    if (!attachmentId) return { outcome: 'missing' }
    const mutation = await this.runMutation(
      [{ kind: 'attachment', attachmentId }],
      async (ctx) => {
        const attachment = await ctx.getAttachment(attachmentId)
        const job = (await ctx.getAttachmentJobs(attachmentId)).find(
          (candidate) => candidate.id === input.jobId,
        )
        if (!attachment || !job) return { outcome: 'missing' as const }
        if (!generatedOutputLocalizationLeaseMatches(attachment, job, input.leaseId)) {
          return { outcome: 'stale' as const, attachmentId }
        }
        await ctx.putAttachmentJob(retriedGeneratedOutputLocalizationJob(job, input), {
          affectsWire: false,
        })
        return { outcome: 'committed' as const, attachmentId }
      },
      undefined,
      commit,
    )
    return mutation.value
  }

  private async failGeneratedOutputLocalization(
    input: GeneratedOutputLocalizationFailInput,
    commit: BrowserCommandCommit,
  ): Promise<GeneratedOutputLocalizationJobResult> {
    const attachmentId = await this.generatedOutputLocalizationAttachmentId(input.jobId, commit)
    if (!attachmentId) return { outcome: 'missing' }
    const mutation = await this.runMutation(
      [{ kind: 'attachment', attachmentId }],
      async (ctx) => {
        const attachment = await ctx.getAttachment(attachmentId)
        const job = (await ctx.getAttachmentJobs(attachmentId)).find(
          (candidate) => candidate.id === input.jobId,
        )
        if (!attachment || !job) return { outcome: 'missing' as const }
        if (!generatedOutputLocalizationLeaseMatches(attachment, job, input.leaseId)) {
          return { outcome: 'stale' as const, attachmentId }
        }
        const failed = failedGeneratedOutputLocalizationJob(job, input)
        await ctx.putAttachmentJob(failed, { affectsWire: false })
        await ctx.putAttachment({
          ...attachment,
          processing: withGeneratedOutputLocalizationState(attachment.processing, failed),
        })
        return { outcome: 'committed' as const, attachmentId }
      },
      undefined,
      commit,
    )
    return mutation.value
  }

  private async completeGeneratedOutputLocalization(
    input: GeneratedOutputLocalizationCompleteInput,
    commit: BrowserCommandCommit,
  ): Promise<GeneratedOutputLocalizationJobResult> {
    const attachmentId = await this.generatedOutputLocalizationAttachmentId(input.jobId, commit)
    if (!attachmentId) return { outcome: 'missing' }
    const mutation = await this.runMutation(
      [{ kind: 'attachment', attachmentId }],
      async (ctx) => {
        const attachment = await ctx.getAttachment(attachmentId)
        const job = (await ctx.getAttachmentJobs(attachmentId)).find(
          (candidate) => candidate.id === input.jobId,
        )
        if (!attachment || !job) return { outcome: 'missing' as const }
        if (!generatedOutputLocalizationLeaseMatches(attachment, job, input.leaseId)) {
          return { outcome: 'stale' as const, attachmentId }
        }
        if (
          input.bundle.attachment.id !== attachmentId ||
          input.bundle.attachment.storage.kind !== 'local-blob'
        ) {
          throw new Error(`GeneratedOutputLocalizationBundleInvalid:${attachmentId}`)
        }
        const succeeded = succeededGeneratedOutputLocalizationJob(job, input.now)
        const bundle: PreparedAttachmentBundle = {
          ...input.bundle,
          attachment: {
            ...input.bundle.attachment,
            ...(job.task?.expectedSourceUrl ? { sourceUrl: job.task.expectedSourceUrl } : {}),
            processing: withGeneratedOutputLocalizationState(
              input.bundle.attachment.processing,
              succeeded,
            ),
          },
          jobs: [
            ...input.bundle.jobs.filter(
              (candidate) => candidate.processorId !== GENERATED_OUTPUT_LOCALIZATION_PROCESSOR_ID,
            ),
            succeeded,
          ],
        }
        await ctx.deleteAttachmentBlobs(attachmentId)
        await ctx.deleteAttachmentArtifacts(attachmentId)
        await ctx.deleteAttachmentJobs(attachmentId)
        await persistPreparedAttachmentBundleInMutation(ctx, bundle, attachment)
        return { outcome: 'committed' as const, attachmentId }
      },
      undefined,
      commit,
    )
    return mutation.value
  }

  private async expandGeneratedOutputVideo(
    input: GeneratedOutputVideoExpandInput,
    commit: BrowserCommandCommit,
  ): Promise<GeneratedOutputVideoExpandResult> {
    const attachmentId = await this.generatedOutputLocalizationAttachmentId(input.jobId, commit)
    if (!attachmentId) {
      return { outcome: 'missing', presentations: [], drafts: [], changedAttachmentIds: [] }
    }
    if (input.attachmentBundles.length === 0) {
      throw new Error(`GeneratedOutputVideoExpansionEmpty:${attachmentId}`)
    }
    for (;;) {
      const plannedEdges = await this.listAttachmentReferenceEdges(attachmentId)
      const messageIds = [
        ...new Set(
          plannedEdges.flatMap((edge) => (edge.ownerKind === 'message' ? [edge.ownerId] : [])),
        ),
      ]
      const draftChatIds = [
        ...new Set(
          plannedEdges.flatMap((edge) => (edge.ownerKind === 'draft' ? [edge.chatId] : [])),
        ),
      ]
      try {
        const mutation = await this.runMutation(
          dedupeMutationScopes([
            { kind: 'attachment', attachmentId },
            ...input.attachmentBundles.map((bundle) => ({
              kind: 'attachment' as const,
              attachmentId: bundle.attachment.id,
            })),
            ...messageIds.map((messageId) => ({ kind: 'message' as const, messageId })),
            ...draftChatIds.map((chatId) => ({ kind: 'draft' as const, chatId })),
          ]),
          async (ctx) => {
            const attachment = await ctx.getAttachment(attachmentId)
            const job = (await ctx.getAttachmentJobs(attachmentId)).find(
              (candidate) => candidate.id === input.jobId,
            )
            if (!attachment || !job) {
              return {
                outcome: 'missing' as const,
                presentations: [],
                drafts: [],
                changedAttachmentIds: [],
              }
            }
            if (!generatedOutputLocalizationLeaseMatches(attachment, job, input.leaseId)) {
              return {
                outcome: 'stale' as const,
                attachmentId,
                presentations: [],
                drafts: [],
                changedAttachmentIds: [],
              }
            }
            const currentEdges = await ctx.getAttachmentReferenceEdges(attachmentId)
            const currentMessageIds = [
              ...new Set(
                currentEdges.flatMap((edge) =>
                  edge.ownerKind === 'message' ? [edge.ownerId] : [],
                ),
              ),
            ]
            const currentDraftChatIds = [
              ...new Set(
                currentEdges.flatMap((edge) => (edge.ownerKind === 'draft' ? [edge.chatId] : [])),
              ),
            ]
            if (
              currentMessageIds.some((messageId) => !messageIds.includes(messageId)) ||
              currentDraftChatIds.some((chatId) => !draftChatIds.includes(chatId))
            ) {
              throw new GeneratedOutputLocalizationPlanChangedError()
            }
            const replacementIds = input.attachmentBundles.map((bundle) => bundle.attachment.id)
            for (const bundle of input.attachmentBundles) {
              if (bundle.attachment.origin !== 'generated-output') {
                throw new Error(`GeneratedOutputVideoExpansionOrigin:${bundle.attachment.id}`)
              }
              const existing = await ctx.getAttachment(bundle.attachment.id)
              if (existing) {
                if (!preparedAttachmentIdentityMatches(existing, bundle.attachment)) {
                  throw new Error(`GeneratedOutputVideoExpansionCollision:${bundle.attachment.id}`)
                }
              } else {
                await persistPreparedAttachmentBundleInMutation(ctx, bundle)
              }
            }
            const presentations: MessagePresentation[] = []
            for (const messageId of currentMessageIds) {
              const message = await ctx.getMessage(messageId)
              if (!message || message.deleted) continue
              const content = replaceGeneratedPollingVideoContent(
                message.content,
                attachmentId,
                replacementIds,
              )
              const refs = replaceGeneratedPollingVideoRefs(
                message.attachmentRefs,
                attachmentId,
                replacementIds,
                { kind: 'message', chatId: message.chatId, messageId: message.id },
                input.now,
              )
              if (!content.changed && !refs.changed) continue
              const presentation = await ctx.patchMessageBody(
                message.id,
                { content: content.content },
                { headerPatch: { attachmentRefs: refs.refs }, touchChatSummary: false },
              )
              if (presentation) presentations.push(presentation)
            }
            const drafts: DraftRow[] = []
            for (const chatId of currentDraftChatIds) {
              const draft = await ctx.getDraft(chatId)
              if (!draft) continue
              const refs = replaceGeneratedPollingVideoRefs(
                draft.attachmentRefs,
                attachmentId,
                replacementIds,
                { kind: 'draft', chatId },
                input.now,
              )
              if (!refs.changed) continue
              const next = {
                ...draft,
                attachmentRefs: refs.refs,
                updatedAt: strictlyMonotonicTimestamp(draft.updatedAt, input.now),
              }
              await ctx.putDraft(next)
              drafts.push(next)
            }
            const counts = await ctx.countAttachmentReferences(attachmentId)
            if (counts.occurrences === 0) {
              await ctx.deleteAttachment(attachmentId)
            } else {
              await ctx.putAttachmentJob(succeededGeneratedOutputLocalizationJob(job, input.now), {
                affectsWire: false,
              })
            }
            return {
              outcome: 'committed' as const,
              attachmentId,
              presentations,
              drafts,
              changedAttachmentIds: [attachmentId, ...replacementIds],
            }
          },
          undefined,
          commit,
        )
        return mutation.value
      } catch (error) {
        if (error instanceof GeneratedOutputLocalizationPlanChangedError) continue
        throw error
      }
    }
  }

  private async generatedOutputLocalizationAttachmentId(
    jobId: string,
    _commit: BrowserCommandCommit,
  ): Promise<AttachmentId | undefined> {
    const db = await this.openDb()
    const row = await db.transaction('r', db.attachmentJobs, async (tx) => {
      return tx.table<AttachmentJob, string>('attachmentJobs').get(jobId)
    })
    return row?.attachmentId
  }

  private async generatedOutputLocalizationProfileIds(
    tx: FencedTransaction<BrowserMutationTableName>,
    attachmentId: AttachmentId,
  ): Promise<ProfileId[]> {
    const attachmentChatKeys = await tx
      .table<AttachmentReferenceEdge, string>('attachmentRefEdges')
      .where('[attachmentId+chatId]')
      .between(...exactCompoundPrefixBetween([attachmentId]))
      .uniqueKeys()
    const chatIds = attachmentChatKeys.map((key) => {
      if (!Array.isArray(key) || typeof key[1] !== 'string') {
        throw new Error('AttachmentReferenceCompoundKeyInvalid')
      }
      return key[1]
    })
    const chats = await tx.table<Chat, ChatId>('chats').bulkGet(chatIds)
    return [
      ...new Set(
        chats.flatMap((chat) => (chat?.settings.profileId ? [chat.settings.profileId] : [])),
      ),
    ]
  }

  async getAttachment(attachmentId: AttachmentId): Promise<Attachment | undefined> {
    const db = await this.openDb()
    return db.transaction('r', db.attachments, db.attachmentArtifacts, async () => {
      const header = await db.attachments.get(attachmentId)
      return header ? hydrateStoredAttachment(header, db.attachmentArtifacts) : undefined
    })
  }

  async getAttachmentGenerationTokenEvidence(
    attachmentId: AttachmentId,
  ): Promise<GenerationAttachmentTokenEvidence | undefined> {
    const header = await (await this.openDb()).attachments.get(attachmentId)
    if (!header) return undefined
    return {
      attachment: hydrateAttachment(header, []),
      wireVersion: header.wireVersion,
    }
  }

  async getAttachments(
    attachmentIds: readonly AttachmentId[],
    options: { signal?: AbortSignal } = {},
  ): Promise<Array<Attachment | undefined>> {
    if (attachmentIds.length === 0) return []
    throwIfReadonlyAborted(options.signal, 'Attachment context read aborted')
    const uniqueIds = [...new Set(attachmentIds)]
    const db = await this.openDb()
    return db.transaction('r', db.attachments, db.attachmentArtifacts, async () => {
      const [headers, artifacts] = await Promise.all([
        db.attachments.bulkGet(uniqueIds),
        db.attachmentArtifacts.where('attachmentId').anyOf(uniqueIds).toArray(),
      ])
      throwIfReadonlyAborted(options.signal, 'Attachment context read aborted')
      const artifactsByAttachmentId = new Map<AttachmentId, AttachmentArtifact[]>()
      for (const artifact of artifacts) {
        const rows = artifactsByAttachmentId.get(artifact.attachmentId) ?? []
        rows.push(artifact)
        artifactsByAttachmentId.set(artifact.attachmentId, rows)
      }
      const attachmentById = new Map<AttachmentId, Attachment | undefined>()
      for (let index = 0; index < uniqueIds.length; index += 1) {
        if (index % 128 === 0) {
          throwIfReadonlyAborted(options.signal, 'Attachment context read aborted')
        }
        const attachmentId = uniqueIds[index] as AttachmentId
        const header = headers[index]
        attachmentById.set(
          attachmentId,
          header
            ? hydrateAttachment(header, artifactsByAttachmentId.get(attachmentId) ?? [])
            : undefined,
        )
      }
      throwIfReadonlyAborted(options.signal, 'Attachment context read aborted')
      return attachmentIds.map((attachmentId) => attachmentById.get(attachmentId))
    })
  }

  async getAttachmentMedia(
    attachmentId: AttachmentId,
    purpose: 'message-output' | 'preview',
    signal?: AbortSignal,
  ): Promise<AttachmentMediaProjection | undefined> {
    return (await this.getAttachmentMediaMany([attachmentId], purpose, signal))[0]
  }

  async getAttachmentMediaMany(
    attachmentIds: readonly AttachmentId[],
    purpose: 'message-output' | 'preview',
    signal?: AbortSignal,
  ): Promise<readonly (AttachmentMediaProjection | undefined)[]> {
    const db = await this.openDb()
    return db.transaction('r', db.attachments, db.attachmentBlobs, async () => {
      throwIfReadonlyAborted(signal, 'Attachment media read aborted')
      const attachments = await db.attachments.bulkGet([...attachmentIds])
      const blobIds = attachments.flatMap((attachment) => {
        if (attachment?.storage.kind !== 'local-blob') return []
        return [
          purpose === 'preview' && attachment.thumbnailBlobId
            ? attachment.thumbnailBlobId
            : attachment.storage.blobId,
        ]
      })
      const uniqueBlobIds = [...new Set(blobIds)]
      const blobs = await db.attachmentBlobs.bulkGet(uniqueBlobIds)
      const blobsById = new Map(
        uniqueBlobIds.flatMap((blobId, index) => {
          const blob = blobs[index]
          return blob ? [[blobId, blob] as const] : []
        }),
      )
      throwIfReadonlyAborted(signal, 'Attachment media read aborted')
      return attachments.map((attachment): AttachmentMediaProjection | undefined => {
        if (!attachment) return undefined
        const projection: AttachmentMediaProjection = {
          id: attachment.id,
          attachment: {
            id: attachment.id,
            kind: attachment.kind,
            mime: attachment.mime,
            filename: attachment.filename,
            storage: structuredClone(attachment.storage),
          },
        }
        if (attachment.storage.kind !== 'local-blob') return projection
        const blobId =
          purpose === 'preview' && attachment.thumbnailBlobId
            ? attachment.thumbnailBlobId
            : attachment.storage.blobId
        const blob = blobsById.get(blobId)
        return blob ? { ...projection, blob } : projection
      })
    })
  }

  async getGeneratedOutputLocalizationQueue(
    now: number,
    requestedLimit: number,
  ): Promise<GeneratedOutputLocalizationQueueSnapshot> {
    const limit = Math.max(1, Math.min(32, Math.floor(requestedLimit)))
    const db = await this.openDb()
    return db.transaction('r', db.attachmentJobs, async () => {
      const pendingIndex = '[processorId+status+nextAttemptAt]'
      const leaseIndex = '[processorId+status+leaseExpiresAt]'
      const pendingRange = exactCompoundPrefixBetween([
        GENERATED_OUTPUT_LOCALIZATION_PROCESSOR_ID,
        'pending',
      ])
      const runningRange = exactCompoundPrefixBetween([
        GENERATED_OUTPUT_LOCALIZATION_PROCESSOR_ID,
        'running',
      ])
      const pending = await db.attachmentJobs
        .where(pendingIndex)
        .between(
          pendingRange[0],
          [GENERATED_OUTPUT_LOCALIZATION_PROCESSOR_ID, 'pending', now],
          true,
          true,
        )
        .limit(limit)
        .primaryKeys()
      const remaining = limit - pending.length
      const expired =
        remaining > 0
          ? await db.attachmentJobs
              .where(leaseIndex)
              .between(
                runningRange[0],
                [GENERATED_OUTPUT_LOCALIZATION_PROCESSOR_ID, 'running', now],
                true,
                true,
              )
              .limit(remaining)
              .primaryKeys()
          : []
      const [nextPending, nextLease] = await Promise.all([
        db.attachmentJobs
          .where(pendingIndex)
          .between(
            [GENERATED_OUTPUT_LOCALIZATION_PROCESSOR_ID, 'pending', now],
            pendingRange[1],
            false,
            false,
          )
          .first(),
        db.attachmentJobs
          .where(leaseIndex)
          .between(
            [GENERATED_OUTPUT_LOCALIZATION_PROCESSOR_ID, 'running', now],
            runningRange[1],
            false,
            false,
          )
          .first(),
      ])
      const nextWakeAt = Math.min(
        nextPending?.nextAttemptAt ?? Number.POSITIVE_INFINITY,
        nextLease?.leaseExpiresAt ?? Number.POSITIVE_INFINITY,
      )
      return {
        readyJobIds: [...pending, ...expired].map(String),
        ...(Number.isFinite(nextWakeAt) ? { nextWakeAt } : {}),
      }
    })
  }

  async getAttachmentBundle(attachmentId: AttachmentId): Promise<AttachmentBundle | undefined> {
    const db = await this.openDb()
    return db.transaction(
      'r',
      db.attachments,
      db.attachmentBlobs,
      db.attachmentArtifacts,
      db.attachmentJobs,
      async () => {
        const header = await db.attachments.get(attachmentId)
        if (!header) return undefined
        const [blobs, artifacts, jobs] = await Promise.all([
          db.attachmentBlobs.where('attachmentId').equals(attachmentId).toArray(),
          db.attachmentArtifacts.where('attachmentId').equals(attachmentId).toArray(),
          db.attachmentJobs.where('attachmentId').equals(attachmentId).toArray(),
        ])
        const attachment = hydrateAttachment(header, artifacts)
        return { attachment, blobs, artifacts, jobs }
      },
    )
  }

  async getAttachmentDispatchBundle(
    attachmentId: AttachmentId,
  ): Promise<AttachmentDispatchBundle | undefined> {
    const db = await this.openDb()
    return db.transaction(
      'r',
      db.attachments,
      db.attachmentBlobs,
      db.attachmentArtifacts,
      db.attachmentJobs,
      async () => {
        const header = await db.attachments.get(attachmentId)
        if (!header) return undefined
        const [blobs, artifacts, jobs] = await Promise.all([
          db.attachmentBlobs.where('attachmentId').equals(attachmentId).toArray(),
          db.attachmentArtifacts.where('attachmentId').equals(attachmentId).toArray(),
          db.attachmentJobs.where('attachmentId').equals(attachmentId).toArray(),
        ])
        return {
          bundle: {
            attachment: hydrateAttachment(header, artifacts),
            blobs,
            artifacts,
            jobs,
          },
          wireVersion: header.wireVersion,
        }
      },
    )
  }

  async findAttachmentIdByContentHash(
    filename: string,
    contentHash: string,
    excludeId?: AttachmentId,
  ): Promise<AttachmentId | undefined> {
    const db = await this.openDb()
    const row = await db.attachments
      .where('contentHash')
      .equals(contentHash)
      .filter(
        (attachment) =>
          attachment.id !== excludeId &&
          attachment.filename === filename &&
          attachment.deletedAt === undefined &&
          attachment.storage.kind !== 'missing',
      )
      .first()
    return row?.id
  }

  async listAttachmentReferenceEdges(
    attachmentId: AttachmentId,
  ): Promise<AttachmentReferenceEdge[]> {
    return (await this.openDb()).attachmentRefEdges
      .where('attachmentId')
      .equals(attachmentId)
      .toArray()
  }

  async listAttachmentReferenceRows(attachmentId: AttachmentId): Promise<AttachmentReferenceRow[]> {
    const db = await this.openDb()
    return db.transaction(
      'r',
      db.attachmentRefEdges,
      db.messages,
      db.drafts,
      db.chats,
      async () => {
        const edges = await db.attachmentRefEdges
          .where('attachmentId')
          .equals(attachmentId)
          .toArray()
        if (edges.length === 0) return []
        const messageIds = [
          ...new Set(
            edges.filter((edge) => edge.ownerKind === 'message').map((edge) => edge.ownerId),
          ),
        ]
        const draftChatIds = [
          ...new Set(
            edges.filter((edge) => edge.ownerKind === 'draft').map((edge) => edge.ownerId),
          ),
        ]
        const chatIds = [...new Set(edges.map((edge) => edge.chatId))]
        const [messages, drafts, chats] = await Promise.all([
          db.messages.bulkGet(messageIds),
          db.drafts.bulkGet(draftChatIds),
          db.chats.bulkGet(chatIds),
        ])
        const messageById = new Map(
          messages.flatMap((message) => (message ? [[message.id, message] as const] : [])),
        )
        const draftByChatId = new Map(
          drafts.flatMap((draft) => (draft ? [[draft.chatId, draft] as const] : [])),
        )
        const chatById = new Map(chats.flatMap((chat) => (chat ? [[chat.id, chat] as const] : [])))
        const rows: AttachmentReferenceRow[] = []
        for (const edge of edges) {
          if (edge.ownerKind === 'message') {
            const message = messageById.get(edge.ownerId)
            if (!message) {
              throw new Error(`AttachmentReferenceOwnerMissing:message:${edge.ownerId}`)
            }
            const ref = normalizeAttachmentRefs(message.attachmentRefs, {
              messageId: message.id,
              createdAt: message.createdAt,
            }).find(
              (candidate) =>
                candidate.refId === edge.refId &&
                candidate.attachmentId === edge.attachmentId &&
                candidate.deletedAt === undefined,
            )
            if (!ref) {
              throw new Error(
                `AttachmentReferenceProjectionMismatch:message:${edge.ownerId}:${edge.refId}`,
              )
            }
            const chat = chatById.get(message.chatId)
            rows.push({
              ownerKind: 'message',
              chatId: message.chatId,
              chatTitle: workspaceAttachmentChatTitle(chat),
              chatTitleStatus: chat?.titleStatus ?? 'untitled',
              messageId: message.id,
              role: message.role,
              messageCreatedAt: message.createdAt,
              ref,
            })
            continue
          }
          const draft = draftByChatId.get(edge.ownerId)
          if (!draft) throw new Error(`AttachmentReferenceOwnerMissing:draft:${edge.ownerId}`)
          const ref = normalizeAttachmentRefs(draft.attachmentRefs, {
            draftChatId: draft.chatId,
            createdAt: draft.updatedAt,
          }).find(
            (candidate) =>
              candidate.refId === edge.refId &&
              candidate.attachmentId === edge.attachmentId &&
              candidate.deletedAt === undefined,
          )
          if (!ref) {
            throw new Error(
              `AttachmentReferenceProjectionMismatch:draft:${edge.ownerId}:${edge.refId}`,
            )
          }
          const chat = chatById.get(draft.chatId)
          rows.push({
            ownerKind: 'draft',
            chatId: draft.chatId,
            chatTitle: workspaceAttachmentChatTitle(chat),
            chatTitleStatus: chat?.titleStatus ?? 'untitled',
            draftChatId: draft.chatId,
            ref,
          })
        }
        rows.sort(
          (left, right) =>
            (right.messageCreatedAt ?? right.ref.createdAt) -
            (left.messageCreatedAt ?? left.ref.createdAt),
        )
        return rows
      },
    )
  }

  async getDraft(chatId: ChatId): Promise<DraftRow | undefined> {
    return this.openDb().then(async (db) => {
      const row = await db.drafts.get(chatId)
      return row ? cloneDraft(row) : undefined
    })
  }

  async runMutation<T, U = T, ExtensionResult = undefined>(
    scopes: MutationScope[],
    fn: (ctx: MutationContext, operations: BrowserMutationOperations) => Promise<T> | T,
    options: WorkspaceMutationOptions | undefined,
    commandCommit: BrowserMutationCommandPort,
    finalize?: (ctx: MutationFinalizationContext, value: T) => Promise<U> | U,
    transactionExtension?: BrowserMutationTransactionExtension<T, ExtensionResult>,
  ): Promise<
    WorkspaceMutationResult<U> & { readonly transactionExtensionResult: ExtensionResult }
  > {
    const { runBrowserMutation } = await import('./browser-mutation-runtime')
    return runBrowserMutation(
      scopes,
      fn,
      options,
      commandCommit,
      browserMutationSharedInternals,
      finalize,
      transactionExtension,
    )
  }
}

function assertPermitFence(
  permit: { workspaceId: string; replacementEpoch: number },
  durable: { workspaceId: string; replacementEpoch: number },
): void {
  if (
    permit.workspaceId !== durable.workspaceId ||
    permit.replacementEpoch !== durable.replacementEpoch
  ) {
    throw new WorkspaceReplacementFenceError()
  }
}

function linkWorkspaceQuerySignals(
  permitSignal: AbortSignal,
  requestedSignal: AbortSignal | undefined,
): { signal: AbortSignal; dispose: () => void } {
  if (!requestedSignal || requestedSignal === permitSignal) {
    return { signal: permitSignal, dispose: () => undefined }
  }
  const controller = new AbortController()
  const sources = [permitSignal, requestedSignal]
  const disposers: Array<() => void> = []
  for (const source of sources) {
    if (source.aborted) {
      controller.abort(source.reason)
      break
    }
    const abort = () => controller.abort(source.reason)
    source.addEventListener('abort', abort, { once: true })
    disposers.push(() => source.removeEventListener('abort', abort))
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const dispose of disposers) dispose()
    },
  }
}

function throwIfWorkspaceQueryAborted(signal: AbortSignal): void {
  if (!signal.aborted) return
  throw signal.reason ?? new DOMException('Workspace query aborted', 'AbortError')
}

function chatTokenCalibrationGeneration(chat: Pick<Chat, 'tokenCalibrationGeneration'>): number {
  const generation = chat.tokenCalibrationGeneration
  return typeof generation === 'number' && Number.isSafeInteger(generation) && generation >= 0
    ? generation
    : 0
}

function streamFenceMatches(
  lease: StreamLeaseRow | undefined,
  fence: StreamWriteFence,
  replacementEpoch: number,
): lease is FencedStreamLeaseRow {
  return Boolean(
    streamLeaseMatchesWriteFence(lease, fence) && replacementEpoch === fence.replacementEpoch,
  )
}

function requiredStreamPostCommitEvidence(lease: StreamLeaseRow): StreamPostCommitEvidence {
  return lease.postCommit
}

function calibrationUsageFromPostCommit(usage: StreamPostCommitUsageEvidence): ChatUsage {
  return {
    prompt_tokens: usage.promptTokens,
    completion_tokens: usage.completionTokens,
    total_tokens: Math.min(Number.MAX_SAFE_INTEGER, usage.promptTokens + usage.completionTokens),
    ...(usage.reasoningTokens === undefined
      ? {}
      : { completion_tokens_details: { reasoning_tokens: usage.reasoningTokens } }),
  }
}

function monotonicTimestamp(current: number | undefined, next: number): number {
  return Math.max(current ?? 0, next)
}

function strictlyMonotonicTimestamp(current: number, next: number): number {
  return Math.max(current + 1, next)
}

function continuationGlobalCalibration(value: unknown): GlobalTokenCalibration | undefined {
  if (!value || typeof value !== 'object') return undefined
  const calibration = value as Partial<GlobalTokenCalibration>
  if (calibration.version !== 1 || !calibration.byModel) return undefined
  return structuredClone(calibration as GlobalTokenCalibration)
}

function preparedGenerationPrompt(
  leafId: MessageId | null,
  canonicalHeaders: ValidatedGenerationPromptPathHeaders,
  messageProofs: readonly GenerationMessageReadProof[],
  knownPresentations: readonly [] | readonly [MessagePresentation],
): PreparedGenerationPrompt {
  if ((canonicalHeaders.at(-1)?.id ?? null) !== leafId) {
    throw new Error(`PreparedGenerationPromptLeafMismatch:${leafId ?? 'root'}`)
  }
  if (messageProofs.length !== canonicalHeaders.length) {
    throw new Error(`PreparedGenerationPromptProofCountMismatch:${leafId ?? 'root'}`)
  }
  const canonicalPresentations = Object.freeze(
    knownPresentations.flatMap((presentation) => {
      const header = canonicalHeaders.find((candidate) => candidate.id === presentation.header.id)
      if (
        !header ||
        presentation.message.id !== header.id ||
        presentation.message.chatId !== header.chatId ||
        presentation.bodyVersion !== header.bodyVersion
      ) {
        return []
      }
      return [
        Object.freeze({
          header,
          message: rebaseHydratedMessageHeader(structuredClone(presentation.message), header),
          bodyVersion: header.bodyVersion,
        }),
      ]
    }),
  )
  return Object.freeze({
    leafId,
    headers: canonicalHeaders,
    messageProofs,
    knownPresentations: canonicalPresentations,
  })
}

type PreparedAttemptAssistantMessage = Message & {
  generation: GenerationMeta
}

function assertPreparedAttemptMessage(
  message: Message,
  lease: StreamLeaseAdmission,
  role: 'assistant',
  origin: 'generated',
): asserts message is PreparedAttemptAssistantMessage
function assertPreparedAttemptMessage(
  message: Message,
  lease: StreamLeaseAdmission,
  role: 'user',
  origin: 'user',
): void
function assertPreparedAttemptMessage(
  message: Message,
  lease: StreamLeaseAdmission,
  role: 'user' | 'assistant',
  origin: 'user' | 'generated',
): void {
  if (
    message.chatId !== lease.chatId ||
    message.role !== role ||
    message.origin !== origin ||
    message.deleted
  ) {
    throw new Error(`AttemptPreparedMessageInvalid:${message.id}`)
  }
  if (role === 'assistant') {
    const generation = message.generation
    if (
      message.id !== lease.messageId ||
      !generation ||
      generation.id !== undefined ||
      generation.status !== 'preparing' ||
      generation.startedAt !== lease.startedAt ||
      generation.finishedAt !== undefined ||
      !generation.model ||
      !generation.requestedModel
    ) {
      throw new Error(`AttemptPreparedGenerationInvalid:${message.id}`)
    }
  }
}

function assertNewChatAttemptRow(chat: Chat, chatId: ChatId): void {
  if (
    chat.id !== chatId ||
    chat.lastUpdatedLeafId !== null ||
    chat.wordCount !== 0 ||
    chat.totalCostUsd !== 0 ||
    chat.metaVersion !== 0 ||
    chat.summaryVersion !== 0 ||
    chat.structuralVersion !== 0 ||
    chat.archived ||
    chat.temporary === true ||
    !chat.settings.profileId ||
    !chat.settings.model
  ) {
    throw new Error(`AttemptInitialChatInvalid:${chatId}`)
  }
}

const browserGenerationCommandSupport: BrowserGenerationCommandSupport = Object.freeze({
  appendValidatedGenerationPromptPath,
  applyMessageCalibrationPatch,
  assertNewChatAttemptRow,
  assertPreparedAttemptMessage,
  calibrationUsageFromPostCommit,
  chatTokenCalibrationGeneration,
  cloneMessageHeader,
  continuationGlobalCalibration,
  dedupeMutationScopes,
  monotonicTimestamp,
  persistPreparedAttachmentBundleInMutation,
  preparedAttachmentIdentityMatches,
  preparedGenerationPrompt,
  requiredPromptPathTarget,
  resolveGenerationPromptPathProof,
  stableStringify,
  streamFenceMatches,
})

function workspaceAttachmentChatTitle(chat: Pick<Chat, 'title'> | undefined): string {
  const title = chat ? chat.title.trim() : ''
  return title && title.length > 0 ? title : 'Untitled chat'
}

type CommittedMessageRevision = WorkspaceLocalMessageRevision

function attemptTargetCommittedFacts(
  command: WorkspaceCommand,
  value: unknown,
): readonly WorkspaceDeltaFact[] {
  if (command.kind !== 'attempt.finalize') return Object.freeze([])
  const result = value as AttemptFinalizeResult
  const presentation = result.presentation
  if (!presentation || result.outcome === 'target-missing') return Object.freeze([])
  const lease = result.lease
  if (lease.phase !== 'canonical' && lease.phase !== 'metadata-committed') {
    throw new Error(`AttemptTargetCommitLeaseInvalid:${command.input.streamId}`)
  }
  const expectedBodyVersion = lease.postCommit.final.expectedBodyVersion
  if (expectedBodyVersion !== presentation.bodyVersion) {
    throw new Error(`AttemptTargetCommitBodyVersionMismatch:${command.input.streamId}`)
  }
  return Object.freeze([
    Object.freeze({
      kind: 'attempt-target-committed' as const,
      streamId: lease.streamId,
      chatId: lease.chatId,
      messageId: lease.messageId,
      attemptKind: lease.attemptKind,
      admissionSequence: lease.admissionSequence,
      leaseRevision: lease.revision,
      bodyVersion: expectedBodyVersion,
    }),
  ])
}

function attemptStopRequestedFacts(
  command: WorkspaceCommand,
  value: unknown,
): readonly WorkspaceDeltaFact[] {
  if (command.kind !== 'attempt.request-stop') return Object.freeze([])
  const result = value as AttemptRequestStopResult
  if (result.outcome !== 'accepted') return Object.freeze([])
  const lease = result.lease
  const control = lease.stopControl
  if (!control || lease.controlRevision < 1) {
    throw new Error(`AttemptStopCommitEvidenceMissing:${command.input.streamId}`)
  }
  return Object.freeze([
    Object.freeze({
      kind: 'attempt-stop-requested' as const,
      streamId: lease.streamId,
      chatId: lease.chatId,
      messageId: lease.messageId,
      attemptKind: lease.attemptKind,
      admissionSequence: lease.admissionSequence,
      controlRevision: lease.controlRevision,
      requestId: control.requestId,
      requestedBy: control.requestedBy,
      requestedAt: control.requestedAt,
      reason: control.reason,
    }),
  ])
}

function collapseConversationConstructionPublication(delta: WorkspaceDelta): WorkspaceDelta {
  const constructedChatIds = new Set(
    delta.facts.flatMap((fact) => (fact.kind === 'conversation-created' ? [fact.chatId] : [])),
  )
  if (constructedChatIds.size === 0) return delta
  const attachmentChanged =
    delta.facts.some((fact) => fact.kind === 'attachment-row-changed') ||
    delta.invalidations.some((invalidation) => invalidation.kind === 'attachment')
  const attachmentJobsChanged = delta.invalidations.some(
    (invalidation) => invalidation.kind === 'attachment-job',
  )
  const conversationInvalidations = delta.invalidations.flatMap(
    (invalidation): WorkspaceDependency[] => {
      if (invalidation.kind === 'chat' || invalidation.kind === 'sidebar') {
        if (!invalidation.chatIds) return [invalidation]
        const chatIds = invalidation.chatIds.filter((chatId) => !constructedChatIds.has(chatId))
        return chatIds.length > 0 ? [{ ...invalidation, chatIds }] : []
      }
      if (
        invalidation.kind === 'message-header' ||
        invalidation.kind === 'message-body' ||
        invalidation.kind === 'message-preview' ||
        invalidation.kind === 'child-slot'
      ) {
        return invalidation.chatId && constructedChatIds.has(invalidation.chatId)
          ? []
          : [invalidation]
      }
      return [invalidation]
    },
  )
  return {
    facts: delta.facts.filter((fact) => {
      if (fact.kind === 'attachment-row-changed') return false
      if (fact.kind === 'message-revision') return !constructedChatIds.has(fact.chatId)
      if (fact.kind === 'sidebar-row-changed' || fact.kind === 'sidebar-row-deleted') {
        return !constructedChatIds.has(fact.chatId)
      }
      return true
    }),
    invalidations: normalizeWorkspaceDependencies([
      ...conversationInvalidations.filter(
        (invalidation) =>
          invalidation.kind !== 'attachment' && invalidation.kind !== 'attachment-job',
      ),
      ...(attachmentChanged ? [{ kind: 'attachment' as const }] : []),
      ...(attachmentJobsChanged ? [{ kind: 'attachment-job' as const }] : []),
    ]),
  }
}

let singleton: { repository: WorkspaceRepository; session: BrowserWorkspaceSession } | null = null

async function replaceBrowserRepository<R extends WorkspaceReplacement>(
  replacement: R,
): Promise<WorkspaceReplacementEnvelope<WorkspaceReplacementResult<R>>> {
  const { replaceBrowserWorkspace } = await import('./browser-workspace-replacement')
  return replaceBrowserWorkspace(replacement)
}

function bindRepositoryToSession(
  target: BrowserWorkspaceRepository,
  session: BrowserWorkspaceSession,
): WorkspaceRepository {
  const run = <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return runBrowserWorkspaceRepositoryOperation(() => session.runOperation(operation))
    } catch (error) {
      return Promise.reject(
        error instanceof Error
          ? error
          : new Error('BrowserWorkspaceRepositoryOperationFailed', { cause: error }),
      )
    }
  }
  return Object.freeze({
    query: <Q extends WorkspaceQuery>(
      permit: WorkspaceReadAuthority,
      query: Q,
      options?: WorkspaceQueryOptions<Q>,
    ) => run(() => target.query(permit, query, options)),
    execute: <C extends WorkspaceCommand>(permit: WorkspaceWriteAuthority, command: C) =>
      run(() => target.execute(permit, command)),
    replace: <R extends WorkspaceReplacement>(replacement: R) => target.replace(replacement),
    subscribeChanges: (
      listener: (change: WorkspaceChange) => void,
      options?: { readonly delivery?: 'all' | 'remote' },
    ) => target.subscribeChanges(listener, options),
  })
}

function currentBrowserWorkspaceSessionRepository(): WorkspaceRepository {
  const session = getBrowserWorkspaceSession()
  if (singleton?.session !== session) {
    const target = new BrowserWorkspaceRepository(session)
    singleton = { repository: bindRepositoryToSession(target, session), session }
  }
  return singleton.repository
}

const stableBrowserRepository: WorkspaceRepository = Object.freeze({
  query: <Q extends WorkspaceQuery>(
    permit: WorkspaceReadAuthority,
    query: Q,
    options?: WorkspaceQueryOptions<Q>,
  ) => currentBrowserWorkspaceSessionRepository().query(permit, query, options),
  execute: <C extends WorkspaceCommand>(permit: WorkspaceWriteAuthority, command: C) =>
    currentBrowserWorkspaceSessionRepository().execute(permit, command),
  replace: replaceBrowserRepository,
  subscribeChanges: subscribeWorkspaceChanges,
})

export function getBrowserRepository(): WorkspaceRepository {
  return stableBrowserRepository
}

export function __getBrowserWorkspaceSessionRepositoryForTests(): WorkspaceRepository {
  return currentBrowserWorkspaceSessionRepository()
}

function resetBrowserRepository(): void {
  singleton = null
}

export const __resetBrowserRepositoryForTests = resetBrowserRepository
