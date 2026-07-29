import type {
  ActiveBranchChildSlot,
  ActiveBranchForkSlot,
  ActiveBranchForkTarget,
  ActiveBranchIntentTarget,
  ActiveBranchTargetUnavailableReason,
} from '../core/active-branch-spine'
import type { AttemptTerminalDecision, AttemptTerminalReceipt } from '../core/attempt-outcome'
import type { BranchPathWindow } from '../core/branch-session'
import type { ChatSettingsFieldPatch, ChatSettingsPatch } from '../core/chat-metadata'
import type { AppliedMessageSemanticEffect } from '../core/continuation-content'
import type { CorsProxyConfig } from '../core/cors-proxy'
import {
  GLOBAL_PREFERENCE_KEYS,
  type GlobalPreferences,
  RECENT_MODEL_RECENCY_KEY,
  RECENT_MODELS_KEY,
  SAMPLE_PROMPTS_DISMISSED_KEY,
} from '../core/global-settings'
import { IMAGE_ALLOWLIST_KEY } from '../core/image-allowlist'
import type {
  ChatExportEnvelope,
  ChatPresetExportEnvelope,
  ConnectionProfileExportEnvelope,
  WorkspaceBackupEnvelope,
} from '../core/import-export/schema'
import type { KeyDispatchProof, KeyDispatchRevision } from '../core/key-dispatch-proof'
import type {
  ConversationAppendSelectionTransition,
  ConversationDestinationHeaderPoint,
  ConversationProvedSelection,
  ConversationSelectionProofTarget,
  DeleteInput,
  DeleteResult,
  EditMessageInput,
  EditMessageResult,
  MessageBodyMutationInput,
  PasteImportInput,
  PasteImportResult,
} from '../core/messages'

import { RENDERING_PREFERENCES_KEY, type RenderingPreferences } from '../core/rendering-preferences'
import type { MessageCorpusSearchRequest, MessageCorpusSearchResult } from '../core/search-query'
import {
  SIDEBAR_COLLAPSED_FOLDERS_SETTING_KEY,
  SIDEBAR_SORT_SETTING_KEY,
  type SidebarSortMode,
} from '../core/sidebar-sort'
import type { SavedTextTemplateCatalogRow } from '../core/text-templates'
import { type CalibrationMode, GLOBAL_TOKEN_CALIBRATION_KEY } from '../core/token-calibration'
import type {
  Attachment,
  AttachmentBlob,
  AttachmentId,
  AttachmentJob,
  AttachmentMissingReason,
  AttachmentRef,
  AttachmentReferenceEdge,
  Chat,
  ChatFolder,
  ChatId,
  ChatPreset,
  ChatSettings,
  ChatSidebarRow,
  ChatTag,
  ChatTitleStatus,
  ChatVersions,
  ChildListState,
  ChildSlotMember,
  ConfigurationRequestRevision,
  ConnectionHttpProfile,
  ConnectionProfile,
  ContentAnnotation,
  ContentItem,
  ContinuationAttemptDraft,
  DispatchedGenerationMeta,
  DraftRow,
  FolderId,
  GeneratedOutputLocalizationTask,
  GenerationMeta,
  GlobalTokenCalibration,
  KeyId,
  KeyRecord,
  Message,
  MessageAttachmentRef,
  MessageId,
  ModelListEntry,
  PresetId,
  ProfileId,
  PromptPreset,
  PromptPresetId,
  PromptPresetKind,
  TagId,
  TextTemplateConfig,
  TextTemplateId,
} from '../core/types'
import { assertNever } from '../lib/assert'
import {
  type ConfigurationDomainCommand,
  type ConfigurationDomainCommandKind,
  type ConfigurationDomainResult,
  configurationRequestRevisionKey,
  profileRequestMaterialChanged,
  sameConfigurationValue,
} from './configuration-domain-contract'
import type { CachedEndpointsRow, CachedModelsRow, CachedPrivacyPolicyRow } from './db-rows'
import type {
  ImportChatOptions,
  ImportChatPresetOptions,
  ImportChatPresetResult,
  ImportChatRequest,
  ImportChatResult,
  ImportConnectionProfileOptions,
  ImportConnectionProfileResult,
  RestoreWorkspaceBackupOptions,
  RestoreWorkspaceBackupResult,
} from './import-export-contract'
import type {
  MessageBodyFields,
  MessageHeaderRow,
  MessagePresentation as StoredMessagePresentation,
} from './message-storage'
import type {
  AttachmentArtifactSummary,
  AttachmentBundle,
  AttachmentBundleWriteMode,
  AttachmentBundleWriteResult,
  AttachmentCatalogAggregate,
  AttachmentCatalogPage,
  AttachmentCatalogRow,
  AttachmentCatalogSearchRequest,
  AttachmentDispatchBundle,
  AttachmentJobSummary,
  ChatSidebarAggregate,
  ChatSidebarCatalogPage,
  ChatSidebarCatalogRequest,
  ChatTokenCalibrationProjection,
  CreateFolderInput,
  DeleteFolderResult,
  EnsureFolderAndMoveChatsInput,
  EnsureFolderAndMoveChatsResult,
  ForkChatFromMessageInput,
  ForkChatFromMessageResult,
  GenerationAttachmentTokenEvidence,
  GenerationMessageReadProof,
  GenerationPromptReadSet,
  GenerationSavedTextTemplateReadProof,
  KnownBranchPageStructuralResult,
  MessageTextPreviewSnapshot,
  MessageTextPreviewTarget,
  SidebarCreatedAtGroupCountRequest,
  SidebarPresentationPage,
  SidebarPresentationRequest,
  StorageMaintenanceRequestTaskKind,
  StreamJournalFramePage,
  StreamJournalFrameRow,
  StreamLeaseAdmission,
  StreamLeaseHandoffReason,
  StreamLeaseHeartbeat,
  StreamLeaseRow,
  StreamPostCommitCalibrationPlan,
  StreamPostCommitUsageEvidence,
  StreamWriteFence,
  TerminalDecidedStreamLeaseRow,
  UpdateFolderInput,
  WorkspaceMeta,
  WriterActiveStreamLeaseRow,
  WriterReservedStreamLeaseRow,
} from './repository'

export type { StorageMaintenanceRequestTaskKind, StorageMaintenanceTaskKind } from './repository'

import type {
  RestoreStructuralSnapshotInput,
  StructuralSnapshotPresentation,
} from './structural-undo-contract'
import type {
  WorkspaceReadPermit,
  WorkspaceReconcileAuthority,
  WorkspaceReservedPermit,
  WorkspaceWritePermit,
} from './workspace-runtime'

export type WorkspaceReadAuthority = WorkspaceReadPermit | WorkspaceReconcileAuthority
export type WorkspaceWriteAuthority =
  | WorkspaceWritePermit
  | WorkspaceReservedPermit
  | WorkspaceReconcileAuthority

interface WorkspaceStamp {
  readonly workspaceId: string
  readonly replacementEpoch: number
  readonly commitId: string | null
}

export interface ReadEnvelope<T> {
  readonly workspaceId: string
  readonly replacementEpoch: number
  readonly value: T
}

export type WorkspaceQueryStage<Q extends WorkspaceQuery> = Q extends {
  kind: 'branch.open'
  bodyDemand: 'terminal'
}
  ? ConversationDestinationHeaderPoint
  : never

export type WorkspaceQueryOptions<Q extends WorkspaceQuery = WorkspaceQuery> = {
  signal?: AbortSignal
} & ([WorkspaceQueryStage<Q>] extends [never]
  ? { onStage?: never }
  : { onStage?: (stage: ReadEnvelope<WorkspaceQueryStage<Q>>) => void })

export interface WorkspaceReplacementEnvelope<T> extends WorkspaceStamp {
  value: T
}

export type MessagePresentation = StoredMessagePresentation

export interface WorkspaceLocalMessageRevision {
  readonly before?: MessageHeaderRow
  readonly header: MessageHeaderRow
  readonly structuralVersion: number
  readonly changed: {
    readonly structure: boolean
    readonly body: boolean
  }
  readonly presentation?: MessagePresentation
}

export type WorkspaceLocalChildSlotEvidence =
  | {
      readonly before: ChildListState
      readonly beforeTail: ChildSlotMember | null
      readonly state: ChildListState
      readonly mode: 'append'
      readonly upserts: readonly ChildSlotMember[]
      readonly removedMessageIds: readonly MessageId[]
    }
  | {
      readonly before?: ChildListState
      readonly state: ChildListState
      readonly mode: 'replace'
      readonly upserts: readonly ChildSlotMember[]
      readonly removedMessageIds: readonly MessageId[]
    }

export interface WorkspaceLocalReceipt {
  chats: readonly Chat[]
  constructions: readonly Chat[]
  messageRevisions: readonly WorkspaceLocalMessageRevision[]
  childSlots: readonly WorkspaceLocalChildSlotEvidence[]
}

export type ProfileDependencyFacet =
  | 'request-material'
  | 'selected-detail'
  | 'catalog-membership'
  | 'catalog-order'
  | 'catalog-display'
  | 'profile-count'
  | 'dependent-counts'
  | 'usage'

export type PresetDependencyFacet =
  | 'selected-detail'
  | 'catalog-membership'
  | 'catalog-order'
  | 'catalog-display'
  | 'usage'

export type PromptPresetDependencyFacet =
  | 'selected-detail'
  | 'catalog-membership'
  | 'catalog-order'
  | 'catalog-display'
  | 'usage'

export type KeyDependencyFacet = 'request-material' | 'selected-detail' | 'membership' | 'usage'
export type OrganizationDependencyFacet = 'definition' | 'membership'

export type WorkspaceDependency =
  | { kind: 'workspace' }
  | { kind: 'chat'; chatIds?: readonly ChatId[] }
  | { kind: 'sidebar'; chatIds?: readonly ChatId[] }
  | { kind: 'message-header'; chatId?: ChatId; messageIds?: readonly MessageId[] }
  | { kind: 'message-body'; chatId?: ChatId; messageIds?: readonly MessageId[] }
  | { kind: 'message-preview'; chatId?: ChatId; messageIds?: readonly MessageId[] }
  | { kind: 'child-slot'; chatId: ChatId; parentIds?: readonly (MessageId | null)[] }
  | { kind: 'draft'; chatIds?: readonly ChatId[] }
  | { kind: 'attachment'; attachmentIds?: readonly AttachmentId[] }
  | { kind: 'attachment-job'; attachmentIds?: readonly AttachmentId[]; jobIds?: readonly string[] }
  | {
      kind: 'profile'
      profileIds?: readonly ProfileId[]
      facets?: readonly ProfileDependencyFacet[]
    }
  | { kind: 'preset'; presetIds?: readonly PresetId[]; facets?: readonly PresetDependencyFacet[] }
  | {
      kind: 'prompt-preset'
      presetIds?: readonly PromptPresetId[]
      facets?: readonly PromptPresetDependencyFacet[]
    }
  | { kind: 'text-template'; templateIds?: readonly TextTemplateId[] }
  | {
      kind: 'folder'
      folderIds?: readonly FolderId[]
      facets?: readonly OrganizationDependencyFacet[]
    }
  | { kind: 'tag'; tagIds?: readonly TagId[]; facets?: readonly OrganizationDependencyFacet[] }
  | { kind: 'key'; keyIds?: readonly KeyId[]; facets?: readonly KeyDependencyFacet[] }
  | { kind: 'setting'; keys?: readonly string[] }
  | { kind: 'stream-lease'; chatId?: ChatId; streamIds?: readonly string[] }
  | { kind: 'stream-chunks'; chatId?: ChatId; streamIds?: readonly string[] }
  | { kind: 'model-resolution'; targetKeys?: readonly string[] }
  | {
      kind: 'discovery-cache'
      cacheKinds?: readonly DiscoveryCacheKind[]
      profileIds?: readonly ProfileId[]
      keys?: readonly string[]
    }
  | {
      kind: 'storage-maintenance'
      tasks: readonly [StorageMaintenanceRequestTaskKind, ...StorageMaintenanceRequestTaskKind[]]
    }

type WorkspaceDependencySelectorKey =
  | 'chatIds'
  | 'messageIds'
  | 'parentIds'
  | 'attachmentIds'
  | 'jobIds'
  | 'profileIds'
  | 'presetIds'
  | 'templateIds'
  | 'folderIds'
  | 'tagIds'
  | 'keyIds'
  | 'keys'
  | 'streamIds'
  | 'targetKeys'
  | 'cacheKinds'
  | 'facets'
  | 'tasks'

export function normalizeWorkspaceDependencies(
  dependencies: readonly WorkspaceDependency[],
): readonly WorkspaceDependency[] {
  const candidates: {
    readonly dependency: WorkspaceDependency
    readonly scopeKey: string
    readonly exactKey: string
    readonly broad: boolean
    readonly globallyBroad: boolean
  }[] = []
  const broadScopes = new Set<string>()
  const globallyBroadKinds = new Set<WorkspaceDependency['kind']>()
  for (const dependency of dependencies) {
    if (dependency.kind === 'workspace') {
      return Object.freeze([Object.freeze({ kind: 'workspace' as const })])
    }
    const record = dependency as unknown as Record<string, unknown>
    const selectorKeys = workspaceDependencySelectorKeys(dependency.kind)
    if (
      selectorKeys.some(
        (key) =>
          Object.hasOwn(record, key) && Array.isArray(record[key]) && record[key].length === 0,
      )
    ) {
      continue
    }
    const chatId = typeof record.chatId === 'string' ? record.chatId : undefined
    const normalized: Record<string, unknown> = { kind: dependency.kind }
    if (chatId) normalized.chatId = chatId
    for (const selectorKey of selectorKeys) {
      const selector = record[selectorKey]
      if (!Object.hasOwn(record, selectorKey) || !Array.isArray(selector)) continue
      normalized[selectorKey] = Object.freeze(
        [...new Set(selector)].sort(compareWorkspaceSelectorValues),
      )
    }
    const scopeKey = `${dependency.kind}\u0000${chatId ?? '*'}`
    const broad = selectorKeys.every((key) => !Object.hasOwn(normalized, key))
    const globallyBroad = broad && chatId === undefined
    if (broad) broadScopes.add(scopeKey)
    if (globallyBroad) globallyBroadKinds.add(dependency.kind)
    const canonical = Object.freeze(normalized) as unknown as WorkspaceDependency
    candidates.push({
      dependency: canonical,
      scopeKey,
      exactKey: JSON.stringify(canonical),
      broad,
      globallyBroad,
    })
  }
  const seen = new Set<string>()
  return Object.freeze(
    candidates.flatMap((candidate) => {
      if (globallyBroadKinds.has(candidate.dependency.kind) && !candidate.globallyBroad) {
        return []
      }
      if (broadScopes.has(candidate.scopeKey) && !candidate.broad) return []
      if (seen.has(candidate.exactKey)) return []
      seen.add(candidate.exactKey)
      return [candidate.dependency]
    }),
  )
}

function compareWorkspaceSelectorValues(left: unknown, right: unknown): number {
  if (left === right) return 0
  if (left === null) return -1
  if (right === null) return 1
  if (typeof left !== 'string' || typeof right !== 'string') {
    throw new Error('WorkspaceDependencySelectorValueInvalid')
  }
  return left.localeCompare(right)
}

function workspaceDependencySelectorKeys(
  kind: WorkspaceDependency['kind'],
): readonly WorkspaceDependencySelectorKey[] {
  switch (kind) {
    case 'workspace':
      return []
    case 'chat':
    case 'sidebar':
    case 'draft':
      return ['chatIds']
    case 'message-header':
    case 'message-body':
    case 'message-preview':
      return ['messageIds']
    case 'child-slot':
      return ['parentIds']
    case 'attachment':
      return ['attachmentIds']
    case 'attachment-job':
      return ['attachmentIds', 'jobIds']
    case 'profile':
      return ['profileIds', 'facets']
    case 'preset':
    case 'prompt-preset':
      return ['presetIds', 'facets']
    case 'text-template':
      return ['templateIds']
    case 'folder':
      return ['folderIds', 'facets']
    case 'tag':
      return ['tagIds', 'facets']
    case 'key':
      return ['keyIds', 'facets']
    case 'setting':
      return ['keys']
    case 'stream-lease':
    case 'stream-chunks':
      return ['streamIds']
    case 'model-resolution':
      return ['targetKeys']
    case 'discovery-cache':
      return ['cacheKinds', 'profileIds', 'keys']
    case 'storage-maintenance':
      return ['tasks']
  }
}

export type ConfigurationSemanticMutation =
  | {
      readonly kind: 'profile'
      readonly previous: ConnectionProfile | undefined
      readonly next: ConnectionProfile | undefined
    }
  | {
      readonly kind: 'preset'
      readonly previous: ChatPreset | undefined
      readonly next: ChatPreset | undefined
    }
  | {
      readonly kind: 'prompt-preset'
      readonly previous: PromptPreset | undefined
      readonly next: PromptPreset | undefined
    }
  | {
      readonly kind: 'key'
      readonly previous: KeyRecord | undefined
      readonly next: KeyRecord | undefined
    }

export function workspaceDependenciesForConfigurationSemanticMutation(
  mutation: ConfigurationSemanticMutation,
): readonly WorkspaceDependency[] {
  const id = mutation.next?.id ?? mutation.previous?.id
  if (!id) return []
  if (mutation.kind === 'prompt-preset') {
    const facets: PromptPresetDependencyFacet[] = []
    const { previous, next } = mutation
    if (!previous || !next) {
      facets.push(
        'selected-detail',
        'catalog-membership',
        'catalog-order',
        'catalog-display',
        'usage',
      )
    } else {
      if (
        previous.kind !== next.kind ||
        previous.name !== next.name ||
        previous.text !== next.text ||
        previous.createdAt !== next.createdAt
      ) {
        facets.push('selected-detail')
      }
      if (previous.kind !== next.kind) facets.push('catalog-membership')
      if (previous.name !== next.name) facets.push('catalog-order')
      if (
        previous.kind !== next.kind ||
        previous.name !== next.name ||
        previous.createdAt !== next.createdAt
      ) {
        facets.push('catalog-display')
      }
      if (previous.lastUsedAt !== next.lastUsedAt) facets.push('usage')
    }
    return facets.length > 0 ? [{ kind: 'prompt-preset', presetIds: [id], facets }] : []
  }
  if (mutation.kind === 'profile') {
    const facets: ProfileDependencyFacet[] = []
    const { previous, next } = mutation
    if (!previous || !next) {
      facets.push(
        'request-material',
        'selected-detail',
        'catalog-membership',
        'catalog-order',
        'catalog-display',
        'profile-count',
        'usage',
      )
    } else {
      if (profileRequestMaterialChanged(previous, next)) facets.push('request-material')
      if (
        !sameConfigurationValue(
          selectedProfileDependencyValue(previous),
          selectedProfileDependencyValue(next),
        )
      ) {
        facets.push('selected-detail')
      }
      if (previous.archived !== next.archived) facets.push('catalog-membership')
      if (previous.name !== next.name) facets.push('catalog-order')
      if (previous.name !== next.name || previous.kind !== next.kind) facets.push('catalog-display')
      if (previous.lastUsedAt !== next.lastUsedAt) facets.push('usage')
    }
    return facets.length > 0 ? [{ kind: 'profile', profileIds: [id], facets }] : []
  }
  if (mutation.kind === 'preset') {
    const facets: PresetDependencyFacet[] = []
    const { previous, next } = mutation
    if (!previous || !next) {
      facets.push(
        'selected-detail',
        'catalog-membership',
        'catalog-order',
        'catalog-display',
        'usage',
      )
    } else {
      if (
        !sameConfigurationValue(
          selectedPresetDependencyValue(previous),
          selectedPresetDependencyValue(next),
        )
      ) {
        facets.push('selected-detail')
      }
      if (previous.archived !== next.archived) facets.push('catalog-membership')
      if (
        previous.name !== next.name ||
        previous.connectionProfileId !== next.connectionProfileId
      ) {
        facets.push('catalog-display')
      }
      if (previous.lastUsedAt !== next.lastUsedAt) facets.push('usage')
    }
    return facets.length > 0 ? [{ kind: 'preset', presetIds: [id], facets }] : []
  }
  const facets: KeyDependencyFacet[] = []
  const { previous, next } = mutation
  if (!previous || !next) {
    facets.push('request-material', 'selected-detail', 'membership', 'usage')
  } else {
    if (!sameConfigurationValue(keyRequestMaterial(previous), keyRequestMaterial(next))) {
      facets.push('request-material')
    }
    if (
      !sameConfigurationValue(withoutConfigurationUsage(previous), withoutConfigurationUsage(next))
    ) {
      facets.push('selected-detail')
    }
    if (previous.lastUsedAt !== next.lastUsedAt) facets.push('usage')
  }
  return facets.length > 0 ? [{ kind: 'key', keyIds: [id], facets }] : []
}

function withoutConfigurationUsage<Row extends { readonly lastUsedAt?: number }>(
  row: Row,
): Omit<Row, 'lastUsedAt'> {
  const { lastUsedAt: _lastUsedAt, ...rest } = row
  return rest
}

function selectedProfileDependencyValue(
  profile: ConnectionProfile,
): Omit<ConnectionProfile, 'lastUsedAt' | 'requestRevision' | 'archived'> {
  const {
    lastUsedAt: _lastUsedAt,
    requestRevision: _requestRevision,
    archived: _archived,
    ...selected
  } = profile
  return selected
}

function selectedPresetDependencyValue(
  preset: ChatPreset,
): Omit<ChatPreset, 'lastUsedAt' | 'archived'> {
  const { lastUsedAt: _lastUsedAt, archived: _archived, ...selected } = preset
  return selected
}

function keyRequestMaterial(key: KeyRecord): unknown {
  return {
    ciphertext: key.ciphertext,
    iv: key.iv,
    salt: key.salt,
    algorithm: key.algorithm,
    kdf: key.kdf,
    materialRevision: key.materialRevision ?? 0,
  }
}

export type WorkspaceDeltaFact =
  | { kind: 'chat-deleted'; chatId: ChatId }
  | { kind: 'conversation-created'; chatId: ChatId }
  | { kind: 'sidebar-row-changed'; chatId: ChatId }
  | { kind: 'sidebar-row-deleted'; chatId: ChatId }
  | { kind: 'attachment-row-changed'; attachmentId: AttachmentId }
  | { kind: 'attachment-row-deleted'; attachmentId: AttachmentId }
  | {
      kind: 'attempt-target-committed'
      streamId: string
      chatId: ChatId
      messageId: MessageId
      attemptKind: 'generation' | 'continuation'
      admissionSequence: number
      leaseRevision: number
      bodyVersion: number
    }
  | {
      kind: 'attempt-stop-requested'
      streamId: string
      chatId: ChatId
      messageId: MessageId
      attemptKind: 'generation' | 'continuation'
      admissionSequence: number
      controlRevision: number
      requestId: string
      requestedBy: string
      requestedAt: number
      reason: 'user'
    }
  | {
      kind: 'message-revision'
      chatId: ChatId
      structuralVersion: number
      header: MessageHeaderRow
      changed: {
        readonly structure: boolean
        readonly body: boolean
      }
    }

export interface WorkspaceDelta {
  facts: readonly WorkspaceDeltaFact[]
  invalidations: readonly WorkspaceDependency[]
}

export interface CommitEnvelope<T> extends WorkspaceStamp {
  readonly effectScope: 'none' | 'workspace'
  readonly value: T
  readonly receipt: WorkspaceLocalReceipt
  readonly delta: WorkspaceDelta
}

export interface ChatMetadataWriteResult<T> {
  readonly value: T
  readonly affectedChatIds: readonly ChatId[]
  readonly chatVersions: Readonly<Record<ChatId, ChatVersions>>
}

export interface ChatTagAssignmentResult extends ChatMetadataWriteResult<readonly TagId[]> {
  readonly affectedTagIds: readonly TagId[]
  readonly deletedTagIds: readonly TagId[]
}

export type ChatCalibrationEverywhereResult = ChatMetadataWriteResult<{
  globalChanged: boolean
  chatCount: number
}>

export interface DeleteChatClosureMetadataResult {
  readonly deletedChatIds: readonly ChatId[]
  readonly affectedAttachmentIds: readonly AttachmentId[]
}

export type DeleteArchivedChatMetadataResult = DeleteChatClosureMetadataResult

interface DeleteChatClosurePageResult extends DeleteChatClosureMetadataResult {
  readonly scannedChatIds: number
  readonly nextAfterChatId?: ChatId
  readonly done: boolean
}

interface EmptyDraftChatClosurePageResult extends DeleteChatClosureMetadataResult {
  readonly scannedChatIds: number
  readonly retiredStreamFrames: number
  readonly earliestDeferredAt?: number
  readonly done: boolean
}

export type WorkspaceChange =
  | { kind: 'commit'; stamp: WorkspaceStamp; delta: WorkspaceDelta }
  | {
      kind: 'invalidate'
      workspaceId: string
      replacementEpoch: number
      dependencies: readonly WorkspaceDependency[] | 'all'
    }
  | {
      kind: 'replace'
      workspaceId: string
      replacementEpoch: number
    }

export function workspaceDependenciesOverlap(
  dependencies: readonly WorkspaceDependency[],
  changedDependencies: readonly WorkspaceDependency[] | 'all',
): boolean {
  if (dependencies.length === 0) return false
  if (changedDependencies === 'all') return true
  return dependencies.some((dependency) =>
    changedDependencies.some((changed) => workspaceDependencyOverlaps(dependency, changed)),
  )
}

export function workspaceDependenciesForDeltaFact(
  fact: WorkspaceDeltaFact,
): readonly WorkspaceDependency[] {
  switch (fact.kind) {
    case 'chat-deleted':
      return [{ kind: 'chat', chatIds: [fact.chatId] }]
    case 'conversation-created':
      return [
        { kind: 'chat', chatIds: [fact.chatId] },
        { kind: 'sidebar', chatIds: [fact.chatId] },
        { kind: 'message-header', chatId: fact.chatId },
        { kind: 'message-body', chatId: fact.chatId },
        { kind: 'message-preview', chatId: fact.chatId },
        { kind: 'child-slot', chatId: fact.chatId },
      ]
    case 'sidebar-row-changed':
    case 'sidebar-row-deleted':
      return [{ kind: 'sidebar', chatIds: [fact.chatId] }]
    case 'attachment-row-changed':
    case 'attachment-row-deleted':
      return [{ kind: 'attachment', attachmentIds: [fact.attachmentId] }]
    case 'attempt-target-committed':
      return [
        { kind: 'stream-lease', chatId: fact.chatId, streamIds: [fact.streamId] },
        { kind: 'message-body', chatId: fact.chatId, messageIds: [fact.messageId] },
      ]
    case 'attempt-stop-requested':
      return [{ kind: 'stream-lease', chatId: fact.chatId, streamIds: [fact.streamId] }]
    case 'message-revision':
      return [
        { kind: 'message-header', chatId: fact.chatId, messageIds: [fact.header.id] },
        ...(fact.changed.body
          ? [
              {
                kind: 'message-body' as const,
                chatId: fact.chatId,
                messageIds: [fact.header.id],
              },
            ]
          : []),
      ]
  }
}

function workspaceDependencyOverlaps(
  left: WorkspaceDependency,
  right: WorkspaceDependency,
): boolean {
  if (right.kind === 'workspace') return true
  if (left.kind === 'workspace') return false
  if (left.kind !== right.kind) return false
  const leftRecord = left as unknown as Record<string, unknown>
  const rightRecord = right as unknown as Record<string, unknown>
  for (const key of Object.keys(leftRecord)) {
    if (key === 'kind') continue
    const leftValue = leftRecord[key]
    const rightValue = rightRecord[key]
    if (leftValue === undefined || rightValue === undefined) continue
    if (Array.isArray(leftValue) && Array.isArray(rightValue)) {
      if (!workspaceSelectorArraysOverlap(leftValue, rightValue)) return false
    } else if (!Array.isArray(leftValue) && !Array.isArray(rightValue)) {
      if (leftValue !== rightValue) return false
    }
  }
  return true
}

function workspaceSelectorArraysOverlap(
  left: readonly unknown[],
  right: readonly unknown[],
): boolean {
  if (left.length === 0 || right.length === 0) return false
  const shorter = left.length <= right.length ? left : right
  const longer = shorter === left ? right : left
  if (shorter.length <= 8) {
    for (const value of shorter) {
      if (longer.includes(value)) return true
    }
    return false
  }
  const lookup = new Set(longer)
  for (const value of shorter) {
    if (lookup.has(value)) return true
  }
  return false
}

export interface GenerationPlanningSnapshot {
  chat: Chat
  profile: ConnectionProfile
  keyRecords: readonly (KeyRecord | undefined)[]
  preferredDispatchKeyId: KeyId | null
  discovery: {
    revision: ConfigurationRequestRevision
    models: {
      queryKey: string
      rows: readonly ModelListEntry[]
    } | null
    endpoints: CachedEndpointsRow | null
    privacy: CachedPrivacyPolicyRow | null
  }
  calibration: {
    modelId: string
    calibrationKey: string
    mode: CalibrationMode
    chatGeneration: number
    global: GlobalTokenCalibration
  }
  proxy: CorsProxyConfig
  savedTextTemplate?: GenerationSavedTextTemplateReadProof
}

export interface PreparedGenerationPrompt {
  readonly leafId: MessageId | null
  readonly headers: readonly MessageHeaderRow[]
  readonly messageProofs: readonly GenerationMessageReadProof[]
  readonly knownPresentations: readonly StoredMessagePresentation[]
}

export interface GenerationPostCommitMetadataInput {
  streamId: string
  fence: StreamWriteFence
  resourceProof: GenerationPostCommitMetadataResourceProof
}

export interface GenerationPostCommitMetadataResourceProof {
  readonly chatId: ChatId
  readonly messageId: MessageId
  readonly profileId: ProfileId
  readonly presetId?: PresetId
  readonly selectedKeyId?: KeyId
  readonly settingKeys: readonly string[]
}

export function generationPostCommitMetadataResourceProof(
  lease: StreamLeaseRow,
): GenerationPostCommitMetadataResourceProof {
  if (lease.phase !== 'canonical' && lease.phase !== 'metadata-committed') {
    throw new Error(`GenerationMetadataLeasePhaseInvalid:${lease.streamId}:${lease.phase}`)
  }
  const evidence = lease.postCommit
  return {
    chatId: lease.chatId,
    messageId: lease.messageId,
    profileId: evidence.profileId,
    ...(evidence.presetId ? { presetId: evidence.presetId } : {}),
    ...(evidence.final.selectedKeyId ? { selectedKeyId: evidence.final.selectedKeyId } : {}),
    settingKeys: [
      ...(evidence.recentModelId === undefined
        ? []
        : [RECENT_MODEL_RECENCY_KEY, RECENT_MODELS_KEY]),
      ...(evidence.calibration === undefined ? [] : [GLOBAL_TOKEN_CALIBRATION_KEY]),
    ],
  }
}

export interface StreamNoteSelectedKeyInput {
  streamId: string
  fence: StreamWriteFence
  selectedKeyId: KeyId
}

export interface StreamHandoffRecoveryInput {
  streamId: string
  fence: StreamWriteFence
  handoffId: string
  handedOffAt: number
  reason: StreamLeaseHandoffReason
}

export interface StreamFinishCleanupResult {
  readonly deletedLease: boolean
  readonly deletedFrames: number
  readonly done: boolean
}

export type GenerationPostCommitMetadataResult =
  | { outcome: 'stale' }
  | { outcome: 'already-applied'; lease: StreamLeaseRow }
  | {
      outcome: 'applied'
      lease: StreamLeaseRow
      chatId: ChatId
      messageId: MessageId
      profileId: ProfileId
      presetId?: PresetId
      selectedKeyId?: KeyId
      settingKeys: readonly string[]
      calibration: {
        attempted: boolean
        promptAccepted: boolean
        completionAccepted: boolean
      }
      chatVersions?: ChatVersions
      header?: MessageHeaderRow
    }

interface ContinuationPrepareProof {
  streamId: string
  messageId: MessageId
  baseNodeVersion: number
  baseBodyVersion: number
}

export interface PendingPromptFieldIntent {
  readonly field: PromptPresetKind
  readonly value: string
  readonly revision: number
}

export interface PendingPromptConfiguration {
  readonly promptFields: readonly PendingPromptFieldIntent[]
}

export interface PendingPromptConfigurationAcknowledgement {
  readonly promptFields: readonly Pick<PendingPromptFieldIntent, 'field' | 'revision'>[]
}

export interface PendingChatSettingsFieldIntent {
  readonly fieldKey: string
  readonly patches: readonly ChatSettingsFieldPatch[]
  readonly revision: number
}

export interface PendingChatSettingsReplacementIntent {
  readonly settings: ChatSettings
  readonly presetId?: PresetId | null
  readonly revision: number
}

export interface PendingWorkspaceSettingIntent {
  readonly key: string
  readonly value: unknown
  readonly revision: number
}

export interface PendingWorkspaceSettingAcknowledgement
  extends Pick<PendingWorkspaceSettingIntent, 'key' | 'revision'> {
  readonly accepted?: {
    readonly value: unknown
  }
}

export interface PendingTextTemplateConfigIntent {
  readonly templateId: TextTemplateId
  readonly config: TextTemplateConfig
  readonly revision: number
}

export interface PendingConfigurationAcknowledgement
  extends PendingPromptConfigurationAcknowledgement {
  readonly acceptedChatConfigurationVersion?: number
  readonly chatSettingsReplacement?: Pick<PendingChatSettingsReplacementIntent, 'revision'>
  readonly chatSettingsFields?: readonly Pick<
    PendingChatSettingsFieldIntent,
    'fieldKey' | 'revision'
  >[]
  readonly workspaceSettings?: readonly PendingWorkspaceSettingAcknowledgement[]
  readonly textTemplateConfigs?: readonly Pick<
    PendingTextTemplateConfigIntent,
    'templateId' | 'revision'
  >[]
}

export interface PrepareAttemptConfigurationIntent {
  readonly preferredDispatchKeyId: KeyId | null
}

export interface PrepareAttemptPlacementIntent {
  readonly chatId: ChatId
  readonly createdAt: number
  readonly assistantMessageId: MessageId
  readonly user?: {
    readonly messageId: MessageId
    readonly content: readonly ContentItem[]
    readonly attachmentRefs: readonly AttachmentRef[]
  }
  readonly prefillContent: readonly ContentItem[]
}

export type GenerationPromptPathReadHintHeader = GenerationMessageReadProof

export interface GenerationPromptPathReadHint {
  readonly chatId: ChatId
  readonly structuralVersion: number
  readonly leafId: MessageId | null
  readonly headers: readonly GenerationPromptPathReadHintHeader[]
  readonly placementSlot: ActiveBranchChildSlot | null
  readonly targetTurn: {
    readonly turnId: string
    readonly turnIndex: number
  } | null
}

export type GenerationPromptPathRequirement =
  | {
      readonly kind: 'new-chat-send'
      readonly surface: 'new-chat'
      readonly target: { readonly kind: 'root' }
      readonly childSlot: 'empty'
    }
  | {
      readonly kind: 'send'
      readonly surface: 'chat'
      readonly chatId: ChatId
      readonly target: ActiveBranchIntentTarget
      readonly childSlot: 'append'
    }
  | {
      readonly kind: 'reply'
      readonly surface: 'chat'
      readonly chatId: ChatId
      readonly target: {
        readonly kind: 'include'
        readonly messageId: MessageId
        readonly role: 'user'
      }
      readonly childSlot: 'append'
    }
  | {
      readonly kind: 'regenerate'
      readonly surface: 'chat'
      readonly chatId: ChatId
      readonly target: {
        readonly kind: 'exclude'
        readonly messageId: MessageId
        readonly role: 'assistant'
      }
      readonly childSlot: 'append'
    }
  | {
      readonly kind: 'edit-resend'
      readonly surface: 'chat'
      readonly chatId: ChatId
      readonly target: {
        readonly kind: 'exclude'
        readonly messageId: MessageId
        readonly role: 'user'
      }
      readonly childSlot: 'append'
    }
  | {
      readonly kind: 'continue'
      readonly surface: 'chat'
      readonly chatId: ChatId
      readonly target: {
        readonly kind: 'include'
        readonly messageId: MessageId
        readonly role: 'assistant'
      }
      readonly childSlot: 'none'
    }

export interface GenerationPromptPathProof {
  readonly requirement: GenerationPromptPathRequirement
  readonly pathHint: GenerationPromptPathReadHint
}

type ExistingChatPrepareConfiguration = {
  readonly configurationIntent: PrepareAttemptConfigurationIntent & {
    readonly settingsPatch?: ChatSettingsPatch
  }
}

export type PrepareAttemptInput = (
  | {
      strategy: 'new-chat-send'
      chat: Chat
      lease: StreamLeaseAdmission
      placement: PrepareAttemptPlacementIntent
      configurationIntent: PrepareAttemptConfigurationIntent & {
        readonly settings: ChatSettings
        readonly presetId: PresetId | null
      }
    }
  | ({
      strategy: 'send'
      lease: StreamLeaseAdmission
      placement: PrepareAttemptPlacementIntent
    } & ExistingChatPrepareConfiguration)
  | ({
      strategy: 'reply'
      lease: StreamLeaseAdmission
      placement: PrepareAttemptPlacementIntent
    } & ExistingChatPrepareConfiguration)
  | ({
      strategy: 'regenerate'
      lease: StreamLeaseAdmission
      placement: PrepareAttemptPlacementIntent
    } & ExistingChatPrepareConfiguration)
  | ({
      strategy: 'edit-resend'
      lease: StreamLeaseAdmission
      placement: PrepareAttemptPlacementIntent
    } & ExistingChatPrepareConfiguration)
  | ({
      strategy: 'continue'
      lease: StreamLeaseAdmission
    } & ExistingChatPrepareConfiguration)
) & {
  readonly promptPath: GenerationPromptPathProof
}

interface AttemptPrepareResultBase<Lease extends WriterReservedStreamLeaseRow> {
  lease: Lease
  user?: Message
  userHeader?: MessageHeaderRow
  assistantHeader: MessageHeaderRow
  prompt: PreparedGenerationPrompt
  planning: GenerationPlanningSnapshot
}

export type AttemptPrepareResult =
  | (AttemptPrepareResultBase<
      Extract<WriterReservedStreamLeaseRow, { attemptKind: 'continuation' }>
    > & {
      strategy: 'continue'
      user?: never
      assistant?: never
      continuationBase: ContinuationPrepareProof
    })
  | (AttemptPrepareResultBase<
      Extract<WriterReservedStreamLeaseRow, { attemptKind: 'generation' }>
    > & {
      strategy: Exclude<PrepareAttemptInput['strategy'], 'continue'>
      assistant: Message
      continuationBase?: never
      selectionTransition: ConversationAppendSelectionTransition
    })

export interface AttemptDispatchInput {
  streamId: string
  fence: StreamWriteFence
  target: {
    readonly messageId: MessageId
    readonly attemptKind: 'generation' | 'continuation'
  }
  readSet: GenerationPromptReadSet
  generation: DispatchedGenerationMeta
  dispatchedAt: number
  postCommitCalibration?: StreamPostCommitCalibrationPlan
  continuation?: {
    strategy: 'prompt' | 'prefill'
    prepareProof: ContinuationPrepareProof
  }
}

export interface AttemptDispatchResult {
  lease: WriterActiveStreamLeaseRow
  header: MessageHeaderRow
}

export interface AttemptSealTerminalInput {
  readonly streamId: string
  readonly fence: StreamWriteFence
  readonly finishedAt: number
  readonly decision: AttemptTerminalDecision
  readonly journalCompleteness: 'settled'
}

export interface AttemptRequestStopInput {
  readonly streamId: string
  readonly chatId: ChatId
  readonly messageId: MessageId
  readonly attemptKind: 'generation' | 'continuation'
  readonly replacementEpoch: number
  readonly admissionSequence: number
  readonly requestId: string
  readonly requestedBy: string
  readonly requestedAt: number
  readonly reason: 'user'
}

export type AttemptRequestStopResult =
  | {
      readonly outcome: 'accepted' | 'already-requested'
      readonly lease: StreamLeaseRow
    }
  | {
      readonly outcome: 'terminal'
      readonly lease: StreamLeaseRow
    }
  | { readonly outcome: 'stale'; readonly lease?: StreamLeaseRow }
  | { readonly outcome: 'missing' }

interface AttemptTerminalProjectionBase {
  streamId: string
  fence: StreamWriteFence
  chatId: ChatId
  messageId: MessageId
  terminal: AttemptTerminalReceipt
  postCommit: {
    selectedKeyId?: KeyId
    usage?: StreamPostCommitUsageEvidence
    completionAllowed: boolean
  }
}

export type AttemptTerminalProjection =
  | (AttemptTerminalProjectionBase & {
      kind: 'generation'
      body: MessageBodyFields
      generation: GenerationMeta
      baseline:
        | {
            readonly kind: 'exact'
            readonly bodyVersion: number
            readonly body: MessageBodyFields
            readonly semanticEffect: AppliedMessageSemanticEffect
          }
        | { readonly kind: 'unavailable' }
      generatedOutput?: GeneratedOutputPreparedWrite
    })
  | (AttemptTerminalProjectionBase & {
      kind: 'continuation'
      continuationText: string
      continuationAnnotations: readonly ContentAnnotation[]
      attempt: ContinuationAttemptDraft
    })

export interface AttemptFinalizeResult {
  outcome: 'committed' | 'already-canonical' | 'target-missing'
  presentation?: MessagePresentation
  lease: StreamLeaseRow
}

export type PreparedAttachmentBundle = AttachmentBundle

export type AttachmentMediaPurpose = 'message-output' | 'preview'

export interface AttachmentMediaProjection {
  readonly id: AttachmentId
  attachment: Pick<Attachment, 'id' | 'kind' | 'mime' | 'filename' | 'storage'>
  blob?: AttachmentBlob
}

export type AttachmentRefOwner =
  | { kind: 'message'; chatId: ChatId; messageId: MessageId }
  | { kind: 'draft'; chatId: ChatId }

export type AttachmentRefMutationOwner =
  | { kind: 'message'; messageId: MessageId; expectedChatId?: ChatId }
  | { kind: 'draft'; chatId: ChatId }

export interface AttachmentReferenceRow {
  ownerKind: 'message' | 'draft'
  chatId: ChatId
  chatTitle: string
  chatTitleStatus: ChatTitleStatus
  messageId?: MessageId
  draftChatId?: ChatId
  role?: Message['role']
  messageCreatedAt?: number
  ref: MessageAttachmentRef
}

export interface AttachmentManagerDetail {
  row: AttachmentCatalogRow
  artifacts: readonly AttachmentArtifactSummary[]
  jobs: readonly AttachmentJobSummary[]
  references: readonly AttachmentReferenceRow[]
}

export interface AttachmentBundleWriteInput {
  bundle: PreparedAttachmentBundle
  mode: AttachmentBundleWriteMode
}

export type { AttachmentBundleWriteResult }

export interface AttachmentRefAddInput {
  owner: AttachmentRefMutationOwner
  ref: MessageAttachmentRef
  afterRefId?: string
  now: number
}

export interface AttachmentRefVisibilityInput {
  owner: AttachmentRefMutationOwner
  refId: string
  expectedAttachmentId: AttachmentId
  includeInContext: boolean
  now: number
}

export interface AttachmentRefDetachInput {
  owner: AttachmentRefMutationOwner
  refId: string
  expectedAttachmentId: AttachmentId
  now: number
}

interface AttachmentRefRelinkSpec {
  owner: AttachmentRefMutationOwner
  refId: string
  expectedAttachmentId: AttachmentId
}

export interface AttachmentRefRelinkInput {
  refs: readonly AttachmentRefRelinkSpec[]
  newAttachmentId: AttachmentId
  supersedeAttachmentId?: AttachmentId
  now: number
}

export interface AttachmentRefWriteResult {
  ref?: MessageAttachmentRef
  header?: MessageHeaderRow
  draft?: DraftRow
}

export interface AttachmentRefRelinkResult {
  refs: readonly MessageAttachmentRef[]
  headers: readonly MessageHeaderRow[]
  drafts: readonly DraftRow[]
}

export interface AttachmentDeleteBytesInput {
  attachmentId: AttachmentId
  reason: AttachmentMissingReason
  now: number
}

export interface AttachmentDeleteManyInput {
  attachmentIds: readonly AttachmentId[]
  expectedCatalogRevision: number
  reason: AttachmentMissingReason
  now: number
}

export interface AttachmentDeleteManyResult {
  readonly deletedAttachmentIds: readonly AttachmentId[]
  readonly stubbedAttachmentIds: readonly AttachmentId[]
  readonly absentAttachmentIds: readonly AttachmentId[]
  readonly catalogRevision: number
}

export interface AttachmentDeleteIfUnreferencedResult {
  deleted: boolean
  refs: { messages: number; drafts: number }
}

export interface AttachmentReapResult {
  readonly scanned: number
  readonly deletedAttachmentIds: readonly AttachmentId[]
  readonly earliestDeferredAt?: number
  readonly done: boolean
}

export interface AttachmentIntegrityMaintenanceResult {
  readonly phase:
    | 'messages'
    | 'drafts'
    | 'edges'
    | 'attachments'
    | 'catalog'
    | 'aggregate'
    | 'complete'
  readonly scanned: number
  readonly repairedAttachmentIds: readonly AttachmentId[]
  readonly done: boolean
}

interface DraftPutInput {
  draft: DraftRow
  expectedUpdatedAt: number | null
}

export interface GeneratedOutputPreparedWrite {
  content: Message['content']
  attachmentRefs: readonly MessageAttachmentRef[]
  attachmentBundles: readonly PreparedAttachmentBundle[]
}

export interface GeneratedOutputLocalizationQueueSnapshot {
  readyJobs: readonly GeneratedOutputLocalizationTarget[]
  nextWakeAt?: number
}

export interface GeneratedOutputLocalizationTarget {
  jobId: string
  attachmentId: AttachmentId
}

export interface GeneratedOutputLocalizationClaim {
  job: AttachmentJob & { task: GeneratedOutputLocalizationTask; attemptCount: number }
  attachment: Pick<Attachment, 'id' | 'kind' | 'mime' | 'filename' | 'storage' | 'sourceUrl'>
  profileIds: readonly ProfileId[]
}

export interface GeneratedOutputLocalizationClaimInput {
  jobId: string
  attachmentId: AttachmentId
  leaseId: string
  now: number
  leaseExpiresAt: number
}

export interface GeneratedOutputLocalizationRetryInput {
  jobId: string
  attachmentId: AttachmentId
  leaseId: string
  error: { code: string; message: string }
  nextAttemptAt: number
  now: number
}

export interface GeneratedOutputLocalizationFailInput {
  jobId: string
  attachmentId: AttachmentId
  leaseId: string
  error: { code: string; message: string }
  now: number
}

export interface GeneratedOutputLocalizationCompleteInput {
  jobId: string
  attachmentId: AttachmentId
  leaseId: string
  bundle: PreparedAttachmentBundle
  now: number
}

export interface GeneratedOutputVideoExpandInput {
  jobId: string
  attachmentId: AttachmentId
  leaseId: string
  attachmentBundles: readonly PreparedAttachmentBundle[]
  now: number
}

export type GeneratedOutputLocalizationJobResult =
  | { outcome: 'committed'; attachmentId: AttachmentId }
  | { outcome: 'stale' | 'missing'; attachmentId?: AttachmentId }

export interface GeneratedOutputVideoExpandResult {
  outcome: 'committed' | 'stale' | 'missing' | 'plan-changed'
  attachmentId?: AttachmentId
  presentations: readonly MessagePresentation[]
  drafts: readonly DraftRow[]
  changedAttachmentIds: readonly AttachmentId[]
}

export type DiscoveryCacheKind = 'models' | 'endpoints' | 'privacy'

export function discoveryCacheKey(
  cacheKind: DiscoveryCacheKind,
  profileId: ProfileId,
  discriminator?: string,
): string {
  return JSON.stringify(
    discriminator === undefined ? [cacheKind, profileId] : [cacheKind, profileId, discriminator],
  )
}

export type ConnectionDiscoveryRevision = ConfigurationRequestRevision

export function connectionDiscoveryRevisionKey(revision: ConnectionDiscoveryRevision): string {
  return configurationRequestRevisionKey(revision)
}

export interface ConnectionDiscoverySnapshot {
  profile: ConnectionHttpProfile & Pick<ConnectionProfile, 'id'>
  revision: ConnectionDiscoveryRevision
  primaryKey?: Readonly<KeyDispatchProof>
}

export interface ConfigurationModelCatalogProjection {
  profile: ConnectionProfile
  revision: ConnectionDiscoveryRevision
  models?: CachedModelsRow
}

export interface ConfigurationModelRoutingProjection {
  profileId: ProfileId
  revision: ConnectionDiscoveryRevision
  modelId: string
  endpoints?: CachedEndpointsRow
  privacy?: CachedPrivacyPolicyRow
  proxy: CorsProxyConfig
}

export interface ConfigurationPreferencesProjection {
  global: GlobalPreferences
  rendering: RenderingPreferences
  sidebarSortMode: SidebarSortMode
  collapsedFolderIds: readonly FolderId[]
  imageAllowlist: readonly string[]
  samplePromptsDismissed: boolean
}

export interface ConfigurationShellProjection {
  readonly preferences: ConfigurationPreferencesProjection
  readonly totalProfileCount: number
}

export type ConfigurationSelectionQueryTarget =
  | {
      readonly kind: 'chat'
      readonly profileId: ProfileId | null
      readonly presetId: PresetId | null
      readonly promptPresets: readonly ConfigurationPromptPresetReference[]
      readonly textTemplateId: TextTemplateId | null
    }
  | {
      readonly kind: 'new-chat'
      readonly profileId: ProfileId | null
      readonly presetId: PresetId | null
      readonly fallback: 'full' | 'missing-profile' | 'none'
      readonly promptPresets: readonly ConfigurationPromptPresetReference[]
      readonly textTemplateId: TextTemplateId | null
    }

export interface ConfigurationPromptPresetReference {
  readonly id: PromptPresetId
  readonly kind: PromptPresetKind
}

export type ConfigurationSelectedProfile = Omit<ConnectionProfile, 'lastUsedAt' | 'requestRevision'>
export type ConfigurationSelectedPreset = Omit<ChatPreset, 'lastUsedAt' | 'archived'>
export type ConfigurationSelectedPromptPreset = Omit<
  ConfigurationPromptPresetCatalogRow,
  'lastUsedAt'
>

export type ConfigurationSelectedTextTemplate = GenerationSavedTextTemplateReadProof

export interface ConfigurationActiveSelectionProjection {
  readonly profile: ConfigurationSelectedProfile | null
  readonly preset: ConfigurationSelectedPreset | null
  readonly requestRevision: ConfigurationRequestRevision | null
  readonly dispatchKeyRevisions: readonly KeyDispatchRevision[]
  readonly promptPresets: readonly ConfigurationSelectedPromptPreset[]
  readonly textTemplate: ConfigurationSelectedTextTemplate | null
}

export interface ConfigurationDiscoveryPayloadToken {
  readonly profileRevision: string
  readonly payloadId: string
  readonly payloadByteLength: number
  readonly fetchedAt: number
}

export type ConfigurationDiscoveryPayloadProjection<Row> =
  | { readonly kind: 'not-requested' }
  | { readonly kind: 'missing' }
  | {
      readonly kind: 'unchanged'
      readonly token: ConfigurationDiscoveryPayloadToken
    }
  | {
      readonly kind: 'loaded'
      readonly token: ConfigurationDiscoveryPayloadToken
      readonly row: Row
    }

export interface ConfigurationActiveModelKnownPayloads {
  readonly models?: ConfigurationDiscoveryPayloadToken
  readonly endpoints?: ConfigurationDiscoveryPayloadToken
  readonly privacy?: ConfigurationDiscoveryPayloadToken
}

export interface ConfigurationActiveModelProjection {
  readonly revision: ConnectionDiscoveryRevision
  readonly modelId: string | null
  readonly models: ConfigurationDiscoveryPayloadProjection<CachedModelsRow>
  readonly endpoints: ConfigurationDiscoveryPayloadProjection<CachedEndpointsRow>
  readonly privacy: ConfigurationDiscoveryPayloadProjection<CachedPrivacyPolicyRow>
}

export type ConfigurationActiveModelRead =
  | {
      readonly kind: 'ready'
      readonly projection: ConfigurationActiveModelProjection
    }
  | { readonly kind: 'stale-selection' }
  | { readonly kind: 'missing-profile' }

export interface ConfigurationProfileSwitchPlan {
  chat: Pick<Chat, 'settings' | 'configurationVersion' | 'modelResolution'>
  profile: Pick<ConnectionProfile, 'kind' | 'baseUrl'>
  target: ConnectionDiscoveryRevision
  requestKeyId: KeyId | null
  cachedModels?: CachedModelsRow
}

export const CONFIGURATION_MODEL_RESOLUTION_PAGE_SIZE = 64

export interface ConfigurationPendingModelResolution {
  readonly chatId: ChatId
  readonly intentId: string
  readonly target: ConfigurationRequestRevision
  readonly sourceModelId: string
  readonly expectedConfigurationVersion: number
}

export type ConfigurationModelResolutionPage =
  | { readonly kind: 'unavailable' }
  | {
      readonly kind: 'ready'
      readonly profileKind: ConnectionProfile['kind']
      readonly target: ConfigurationRequestRevision
      readonly requestKeyId: KeyId | null
      readonly models: ConfigurationDiscoveryPayloadProjection<CachedModelsRow>
      readonly pending: readonly ConfigurationPendingModelResolution[]
      readonly pageFull: boolean
    }

export type ConfigurationModelResolutionHead =
  | { readonly kind: 'empty' }
  | { readonly kind: 'blocked'; readonly linkId: string }
  | {
      readonly kind: 'pending'
      readonly profileId: ProfileId
      readonly profileRevision: string
    }

export type ConfigurationProfileCatalogRow = Pick<
  ConnectionProfile,
  'id' | 'name' | 'kind' | 'lastUsedAt'
> & { archived?: boolean }

export type ConfigurationPresetCatalogRow = Pick<
  ChatPreset,
  'id' | 'name' | 'connectionProfileId' | 'createdAt'
>

export type ConfigurationPromptPresetCatalogRow = Pick<
  PromptPreset,
  'id' | 'kind' | 'name' | 'createdAt'
>

export const CONFIGURATION_CATALOG_MAX_PAGE_SIZE = 256
export const CONFIGURATION_CATALOG_MAX_ADDRESSED_ROWS = 8
export const CONFIGURATION_CATALOG_MAX_REFRESH_ANCHORS = 8

export interface ConfigurationCatalogPageRequest<Id extends string = string> {
  readonly cursor?: string
  readonly anchorIds?: readonly Id[]
  readonly direction: 'forward' | 'backward'
  readonly limit: number
  readonly addressedIds?: readonly Id[]
}

export interface ConfigurationCatalogAddress<Row> {
  readonly id: string
  readonly row: Row | null
}

export interface ConfigurationCatalogPageValue<Row> {
  readonly kind: 'page'
  readonly catalogRevision: number
  readonly exactCount: number
  readonly rows: readonly Row[]
  readonly addressedRows: readonly ConfigurationCatalogAddress<Row>[]
  readonly previousCursor?: string
  readonly nextCursor?: string
}

export interface ConfigurationCatalogStaleCursor<Row> {
  readonly kind: 'stale-cursor'
  readonly catalogRevision: number
  readonly exactCount: number
  readonly addressedRows: readonly ConfigurationCatalogAddress<Row>[]
}

export interface ConfigurationCatalogAnchorMissing<Row> {
  readonly kind: 'anchor-missing'
  readonly catalogRevision: number
  readonly exactCount: number
  readonly addressedRows: readonly ConfigurationCatalogAddress<Row>[]
}

export type ConfigurationCatalogPage<Row> =
  | ConfigurationCatalogPageValue<Row>
  | ConfigurationCatalogStaleCursor<Row>
  | ConfigurationCatalogAnchorMissing<Row>

export type ConfigurationProfileCatalogPage =
  ConfigurationCatalogPage<ConfigurationProfileCatalogRow>
export type ConfigurationPresetCatalogPage = ConfigurationCatalogPage<ConfigurationPresetCatalogRow>
export type ConfigurationPromptPresetCatalogPage =
  ConfigurationCatalogPage<ConfigurationPromptPresetCatalogRow>

export interface ConfigurationConnectionManagerRow {
  readonly id: ProfileId
  readonly name: string
  readonly kind: ConnectionProfile['kind']
  readonly archived: boolean
  readonly presetCount: number
  readonly activePresetCount: number
  readonly chatCount: number
  readonly activeChatCount: number
}

export type ConfigurationConnectionManagerPage =
  ConfigurationCatalogPage<ConfigurationConnectionManagerRow>

interface GeneratedOutputNetworkAccess {
  profileKind: ConnectionProfile['kind'] | null
  credentialKey?: Readonly<KeyDispatchProof>
  polling: boolean
}

export interface DiscoveryCacheWriteGuard<Row> {
  expectedProfileRevision?: ConnectionDiscoveryRevision | null
  expectedCurrent?: Row | null
}

export interface DiscoveryModelsPutResult {
  readonly accepted: boolean
  readonly cacheChanged: boolean
  readonly cached: boolean
  readonly repairRequired: boolean
  readonly evictions: readonly DiscoveryCacheEviction[]
}

export interface DiscoveryCacheEviction {
  readonly cacheKind: DiscoveryCacheKind
  readonly profileId: ProfileId
  readonly discriminator: string
}

export interface DiscoveryCachePutResult {
  readonly accepted: boolean
  readonly cacheChanged: boolean
  readonly cached: boolean
  readonly repairRequired: boolean
  readonly evictions: readonly DiscoveryCacheEviction[]
}

export interface DiscoveryCacheMaintenanceResult {
  readonly scanned: number
  readonly deletedPayloads: number
  readonly evictions: readonly DiscoveryCacheEviction[]
  readonly done: boolean
}

export type DiscoveryCacheCommand =
  | {
      kind: 'discovery.models.put'
      row: CachedModelsRow
      guard?: DiscoveryCacheWriteGuard<CachedModelsRow>
    }
  | {
      kind: 'discovery.models.delete'
      profileId: ProfileId
      queryKey: string
    }
  | {
      kind: 'discovery.endpoints.put'
      row: CachedEndpointsRow
      guard?: DiscoveryCacheWriteGuard<CachedEndpointsRow>
    }
  | {
      kind: 'discovery.privacy.put'
      row: CachedPrivacyPolicyRow
      guard?: DiscoveryCacheWriteGuard<CachedPrivacyPolicyRow>
    }

type ConfigQuery =
  | { kind: 'configuration.discovery-snapshot'; profileId: ProfileId }
  | { kind: 'configuration.shell' }
  | { kind: 'configuration.global-token-calibration' }
  | { kind: 'configuration.text-template-catalog' }
  | {
      kind: 'configuration.active-selection'
      target: ConfigurationSelectionQueryTarget
    }
  | {
      kind: 'configuration.active-model'
      profileId: ProfileId
      modelId: string | null
      revision: ConnectionDiscoveryRevision
      includeModels: boolean
      knownPayloads?: ConfigurationActiveModelKnownPayloads
    }
  | { kind: 'configuration.profile-switch-plan'; chatId: ChatId; profileId: ProfileId }
  | { kind: 'configuration.model-resolution-head' }
  | {
      kind: 'configuration.model-resolution-page'
      profileId: ProfileId
      profileRevision: string
      knownModels?: ConfigurationDiscoveryPayloadToken
    }
  | {
      kind: 'configuration.profile-catalog-page'
      request: ConfigurationCatalogPageRequest
    }
  | {
      kind: 'configuration.preset-catalog-page'
      request: ConfigurationCatalogPageRequest
    }
  | {
      kind: 'configuration.prompt-preset-catalog-page'
      promptKind: PromptPresetKind
      request: ConfigurationCatalogPageRequest
    }
  | {
      kind: 'configuration.connection-manager-page'
      request: ConfigurationCatalogPageRequest
    }
  | {
      kind: 'configuration.generated-output-network-access'
      profileIds: readonly ProfileId[]
      url: string
      requestCredential?: { profileId: ProfileId; selectedKeyId: KeyId }
    }
  | { kind: 'key.get'; keyId: KeyId }
  | { kind: 'setting.get'; key: string }
  | { kind: 'setting.get-many'; keys: readonly string[] }
  | { kind: 'folder.list' }
  | { kind: 'tag.list' }

type MessageQuery =
  | { kind: 'message.presentation'; messageId: MessageId }
  | { kind: 'message.presentations'; messageIds: readonly MessageId[] }
  | {
      kind: 'message.preview-window'
      targets: readonly MessageTextPreviewTarget[]
      maxChars?: number
    }
  | { kind: 'message.search-corpus'; request: MessageCorpusSearchRequest }
  | { kind: 'message.headers-by-chat'; chatId: ChatId }

export type ConversationOpenResult =
  | {
      readonly kind: 'missing'
      readonly chatId: ChatId
      readonly target: ConversationSelectionProofTarget
    }
  | {
      readonly kind: 'unavailable'
      readonly chat: Chat
      readonly target: ConversationSelectionProofTarget
      readonly reason: ActiveBranchTargetUnavailableReason
    }
  | {
      readonly kind: 'stale'
      readonly chat: Chat
      readonly target: ConversationSelectionProofTarget
      readonly retryTarget: ConversationSelectionProofTarget
    }
  | ConversationProvedSelection

export type ConversationTopologyResult =
  | {
      readonly kind: 'ready'
      readonly chat: Chat
      readonly structuralVersion: number
      readonly headers: readonly MessageHeaderRow[]
      readonly childSlots: readonly ChildListState[]
    }
  | { readonly kind: 'stale' }
  | { readonly kind: 'missing'; readonly chatId: ChatId }

export type ConversationForksResult =
  | {
      readonly kind: 'ready'
      readonly structuralVersion: number
      readonly forks: readonly ActiveBranchForkSlot[]
    }
  | { readonly kind: 'stale-selection' }

type BranchQuery =
  | {
      kind: 'branch.open'
      chatId: ChatId
      target: ConversationSelectionProofTarget
      bodyDemand: 'terminal' | 'none'
    }
  | {
      kind: 'branch.forks'
      chatId: ChatId
      structuralVersion: number
      targets: readonly ActiveBranchForkTarget[]
    }
  | {
      kind: 'branch.page-structure'
      chatId: ChatId
      resolvedTipId: MessageId
      structuralVersion: number
      window: BranchPathWindow<MessageHeaderRow>
    }
  | {
      kind: 'branch.child-at-position'
      chatId: ChatId
      parentId: MessageId | null
      position: number
    }

type StreamQuery =
  | { kind: 'stream.lease'; streamId: string }
  | { kind: 'stream.lease-head' }
  | { kind: 'stream.leases-by-id'; streamIds: readonly string[] }
  | { kind: 'stream.leases'; chatId?: ChatId }
  | {
      kind: 'stream.journal-frame-page'
      streamId: string
      afterSeq: number
      throughSeq: number
    }

type AttachmentQuery =
  | { kind: 'attachment.catalog-rows'; attachmentIds: readonly AttachmentId[] }
  | { kind: 'attachment.catalog-aggregate' }
  | { kind: 'attachment.manager-detail'; attachmentId: AttachmentId }
  | { kind: 'attachment.catalog-page'; search: AttachmentCatalogSearchRequest }
  | {
      kind: 'attachment.catalog-evaluate'
      search: AttachmentCatalogSearchRequest
      attachmentIds: readonly AttachmentId[]
    }
  | { kind: 'attachment.get'; attachmentId: AttachmentId }
  | { kind: 'attachment.get-many'; attachmentIds: readonly AttachmentId[] }
  | { kind: 'attachment.generation-token-evidence'; attachmentId: AttachmentId }
  | {
      kind: 'attachment.media'
      attachmentId: AttachmentId
      purpose: AttachmentMediaPurpose
    }
  | {
      kind: 'attachment.media-many'
      attachmentIds: readonly AttachmentId[]
      purpose: AttachmentMediaPurpose
    }
  | { kind: 'attachment.bundle'; attachmentId: AttachmentId }
  | { kind: 'attachment.dispatch-bundle'; attachmentId: AttachmentId }
  | {
      kind: 'attachment.find-hash'
      filename: string
      contentHash: string
      excludeId?: AttachmentId
    }
  | { kind: 'attachment.references'; attachmentId: AttachmentId }
  | { kind: 'attachment.reference-rows'; attachmentId: AttachmentId }
  | { kind: 'generated-output.localization-queue'; now: number; limit: number }

type DiscoveryQuery =
  | { kind: 'discovery.models'; profileId: ProfileId; queryKey: string }
  | { kind: 'discovery.endpoints'; profileId: ProfileId; modelId: string }
  | { kind: 'discovery.privacy'; profileId: ProfileId; modelId: string }

export type WorkspaceQuery =
  | { kind: 'workspace.meta' }
  | { kind: 'interchange.export-chat'; chatId: ChatId }
  | { kind: 'interchange.export-chat-preset'; presetId: PresetId }
  | { kind: 'interchange.export-connection-profile'; profileId: ProfileId }
  | { kind: 'interchange.export-workspace-backup' }
  | { kind: 'chat.get'; chatId: ChatId }
  | { kind: 'chat.token-calibrations'; chatIds: readonly ChatId[] }
  | { kind: 'sidebar.rows-by-id'; chatIds: readonly ChatId[] }
  | { kind: 'sidebar.catalog-page'; request: ChatSidebarCatalogRequest }
  | { kind: 'sidebar.presentation-page'; request: SidebarPresentationRequest }
  | { kind: 'sidebar.aggregate' }
  | { kind: 'sidebar.created-at-group-count'; request: SidebarCreatedAtGroupCountRequest }
  | { kind: 'chat.next-fork-title'; baseTitle: string }
  | ConfigQuery
  | MessageQuery
  | BranchQuery
  | StreamQuery
  | AttachmentQuery
  | DiscoveryQuery

export function workspaceQueryDependencies(query: WorkspaceQuery): readonly WorkspaceDependency[] {
  switch (query.kind) {
    case 'workspace.meta':
    case 'interchange.export-chat':
    case 'interchange.export-chat-preset':
    case 'interchange.export-connection-profile':
    case 'interchange.export-workspace-backup':
      return [{ kind: 'workspace' }]
    case 'chat.get':
      return [{ kind: 'chat', chatIds: [query.chatId] }]
    case 'chat.token-calibrations':
      return [{ kind: 'chat', chatIds: query.chatIds }]
    case 'chat.next-fork-title':
      return [{ kind: 'sidebar' }]
    case 'sidebar.rows-by-id':
      return [{ kind: 'sidebar', chatIds: query.chatIds }]
    case 'sidebar.catalog-page':
    case 'sidebar.presentation-page':
    case 'sidebar.aggregate':
    case 'sidebar.created-at-group-count':
      return [{ kind: 'sidebar' }]
    case 'configuration.discovery-snapshot':
      return [
        {
          kind: 'profile',
          profileIds: [query.profileId],
          facets: ['request-material', 'catalog-membership'],
        },
      ]
    case 'configuration.shell':
      return [
        { kind: 'profile', facets: ['profile-count'] },
        {
          kind: 'setting',
          keys: [
            ...GLOBAL_PREFERENCE_KEYS,
            IMAGE_ALLOWLIST_KEY,
            RENDERING_PREFERENCES_KEY,
            SAMPLE_PROMPTS_DISMISSED_KEY,
            SIDEBAR_SORT_SETTING_KEY,
            SIDEBAR_COLLAPSED_FOLDERS_SETTING_KEY,
          ],
        },
      ]
    case 'configuration.global-token-calibration':
      return [{ kind: 'setting', keys: [GLOBAL_TOKEN_CALIBRATION_KEY] }]
    case 'configuration.text-template-catalog':
      return [{ kind: 'text-template' }]
    case 'configuration.active-selection': {
      const derivesProfile =
        query.target.kind === 'new-chat' &&
        query.target.fallback !== 'none' &&
        query.target.profileId === null
      const derivesPreset =
        query.target.kind === 'new-chat' &&
        query.target.fallback === 'full' &&
        query.target.presetId === null
      const derivesPromptPresets =
        query.target.kind === 'new-chat' &&
        query.target.fallback === 'full' &&
        query.target.promptPresets.length === 0
      const derivesTextTemplate =
        query.target.kind === 'new-chat' &&
        query.target.fallback === 'full' &&
        query.target.textTemplateId === null
      return [
        ...(query.target.profileId
          ? [
              {
                kind: 'profile' as const,
                profileIds: [query.target.profileId],
                facets: ['request-material', 'selected-detail', 'catalog-membership'] as const,
              },
            ]
          : []),
        ...(query.target.presetId
          ? [
              {
                kind: 'preset' as const,
                presetIds: [query.target.presetId],
                facets: ['selected-detail', 'catalog-membership'] as const,
              },
            ]
          : []),
        ...(derivesProfile
          ? [
              {
                kind: 'profile' as const,
                facets: [
                  'request-material',
                  'selected-detail',
                  'catalog-membership',
                  'catalog-order',
                  'usage',
                ] as const,
              },
            ]
          : []),
        ...(derivesPreset
          ? [
              {
                kind: 'preset' as const,
                facets: [
                  'selected-detail',
                  'catalog-membership',
                  'catalog-order',
                  'usage',
                ] as const,
              },
            ]
          : []),
        ...(query.target.promptPresets.length > 0
          ? [
              {
                kind: 'prompt-preset' as const,
                presetIds: query.target.promptPresets.map((reference) => reference.id),
                facets: ['selected-detail', 'catalog-membership'] as const,
              },
            ]
          : derivesPromptPresets
            ? [
                {
                  kind: 'prompt-preset' as const,
                  facets: ['selected-detail', 'catalog-membership'] as const,
                },
              ]
            : []),
        ...(query.target.textTemplateId
          ? [
              {
                kind: 'text-template' as const,
                templateIds: [query.target.textTemplateId],
              },
            ]
          : derivesTextTemplate
            ? [
                {
                  kind: 'text-template' as const,
                },
              ]
            : []),
      ]
    }
    case 'configuration.active-model':
      return [
        {
          kind: 'profile',
          profileIds: [query.profileId],
          facets: ['request-material', 'catalog-membership'],
        },
        ...(query.includeModels
          ? [
              {
                kind: 'discovery-cache' as const,
                cacheKinds: ['models'] as const,
                profileIds: [query.profileId],
              },
            ]
          : []),
        ...(query.modelId
          ? [
              {
                kind: 'discovery-cache' as const,
                cacheKinds: ['endpoints'] as const,
                profileIds: [query.profileId],
                keys: [discoveryCacheKey('endpoints', query.profileId, query.modelId)],
              },
              {
                kind: 'discovery-cache' as const,
                cacheKinds: ['privacy'] as const,
                profileIds: [query.profileId],
                keys: [discoveryCacheKey('privacy', query.profileId, query.modelId)],
              },
            ]
          : []),
      ]
    case 'configuration.profile-switch-plan':
      return [
        { kind: 'chat', chatIds: [query.chatId] },
        {
          kind: 'profile',
          profileIds: [query.profileId],
          facets: ['request-material', 'catalog-membership'],
        },
        {
          kind: 'discovery-cache',
          cacheKinds: ['models'],
          profileIds: [query.profileId],
        },
      ]
    case 'configuration.model-resolution-head':
      return [{ kind: 'chat' }]
    case 'configuration.model-resolution-page':
      return [
        { kind: 'chat' },
        {
          kind: 'profile',
          profileIds: [query.profileId],
          facets: ['request-material'],
        },
        {
          kind: 'discovery-cache',
          cacheKinds: ['models'],
          profileIds: [query.profileId],
        },
      ]
    case 'configuration.profile-catalog-page':
      return [
        {
          kind: 'profile',
          facets: ['catalog-membership', 'catalog-order', 'catalog-display', 'usage'],
        },
      ]
    case 'configuration.preset-catalog-page':
      return [
        {
          kind: 'preset',
          facets: ['catalog-membership', 'catalog-order', 'catalog-display'],
        },
      ]
    case 'configuration.prompt-preset-catalog-page':
      return [
        {
          kind: 'prompt-preset',
          facets: ['catalog-membership', 'catalog-order', 'catalog-display'],
        },
      ]
    case 'configuration.connection-manager-page':
      return [
        {
          kind: 'profile',
          facets: ['catalog-membership', 'catalog-order', 'catalog-display', 'dependent-counts'],
        },
      ]
    case 'configuration.generated-output-network-access':
      return [
        {
          kind: 'profile',
          profileIds: query.requestCredential
            ? [...new Set([...query.profileIds, query.requestCredential.profileId])]
            : query.profileIds,
          facets: ['request-material', 'catalog-membership'],
        },
        query.requestCredential
          ? {
              kind: 'key',
              keyIds: [query.requestCredential.selectedKeyId],
              facets: ['request-material'],
            }
          : { kind: 'key', facets: ['request-material'] },
      ]
    case 'key.get':
      return [{ kind: 'key', keyIds: [query.keyId] }]
    case 'setting.get':
      return [{ kind: 'setting', keys: [query.key] }]
    case 'setting.get-many':
      return [{ kind: 'setting', keys: query.keys }]
    case 'folder.list':
      return [{ kind: 'folder' }]
    case 'tag.list':
      return [{ kind: 'tag' }]
    case 'message.presentation':
      return [
        { kind: 'message-header', messageIds: [query.messageId] },
        { kind: 'message-body', messageIds: [query.messageId] },
      ]
    case 'message.presentations':
      return [
        { kind: 'message-header', messageIds: query.messageIds },
        { kind: 'message-body', messageIds: query.messageIds },
      ]
    case 'message.preview-window': {
      const messageIds = query.targets.map((target) => target.messageId)
      return [
        { kind: 'message-header', messageIds },
        { kind: 'message-preview', messageIds },
      ]
    }
    case 'message.search-corpus':
      return [
        { kind: 'message-header', chatId: query.request.chatId },
        { kind: 'message-body', chatId: query.request.chatId },
      ]
    case 'message.headers-by-chat':
      return [
        { kind: 'chat', chatIds: [query.chatId] },
        { kind: 'message-header', chatId: query.chatId },
      ]
    case 'branch.open':
      return [
        { kind: 'chat', chatIds: [query.chatId] },
        { kind: 'message-header', chatId: query.chatId },
        { kind: 'message-body', chatId: query.chatId },
        { kind: 'child-slot', chatId: query.chatId },
      ]
    case 'branch.forks': {
      return [
        { kind: 'chat', chatIds: [query.chatId] },
        {
          kind: 'message-header',
          chatId: query.chatId,
          messageIds: query.targets.map((target) => target.selectedMessageId),
        },
        {
          kind: 'child-slot',
          chatId: query.chatId,
          parentIds: query.targets.map((target) => target.parentId),
        },
      ]
    }
    case 'branch.page-structure': {
      const messageIds = query.window.nodes.map((node) => node.id)
      return [
        { kind: 'chat', chatIds: [query.chatId] },
        { kind: 'message-header', chatId: query.chatId, messageIds },
      ]
    }
    case 'branch.child-at-position':
      return [{ kind: 'child-slot', chatId: query.chatId, parentIds: [query.parentId] }]
    case 'stream.lease':
      return [{ kind: 'stream-lease', streamIds: [query.streamId] }]
    case 'stream.lease-head':
      return [{ kind: 'stream-lease' }]
    case 'stream.leases-by-id':
      return [{ kind: 'stream-lease', streamIds: query.streamIds }]
    case 'stream.leases':
      return [{ kind: 'stream-lease', ...(query.chatId ? { chatId: query.chatId } : {}) }]
    case 'stream.journal-frame-page':
      return [{ kind: 'stream-chunks', streamIds: [query.streamId] }]
    case 'attachment.catalog-rows':
      return [{ kind: 'attachment', attachmentIds: query.attachmentIds }]
    case 'attachment.catalog-evaluate':
      return [{ kind: 'attachment', attachmentIds: query.attachmentIds }]
    case 'attachment.catalog-aggregate':
    case 'attachment.catalog-page':
      return [{ kind: 'attachment' }]
    case 'attachment.manager-detail':
      return [
        { kind: 'attachment', attachmentIds: [query.attachmentId] },
        { kind: 'attachment-job', attachmentIds: [query.attachmentId] },
        { kind: 'chat' },
        { kind: 'message-header' },
        { kind: 'draft' },
      ]
    case 'attachment.get':
    case 'attachment.generation-token-evidence':
    case 'attachment.media':
    case 'attachment.references':
      return [{ kind: 'attachment', attachmentIds: [query.attachmentId] }]
    case 'attachment.get-many':
    case 'attachment.media-many':
      return [{ kind: 'attachment', attachmentIds: query.attachmentIds }]
    case 'attachment.bundle':
    case 'attachment.dispatch-bundle':
      return [
        { kind: 'attachment', attachmentIds: [query.attachmentId] },
        { kind: 'attachment-job', attachmentIds: [query.attachmentId] },
      ]
    case 'attachment.find-hash':
      return [{ kind: 'attachment' }]
    case 'attachment.reference-rows':
      return [
        { kind: 'attachment', attachmentIds: [query.attachmentId] },
        { kind: 'chat' },
        { kind: 'message-header' },
        { kind: 'draft' },
      ]
    case 'generated-output.localization-queue':
      return [{ kind: 'attachment-job' }]
    case 'discovery.models':
      return [
        {
          kind: 'discovery-cache',
          cacheKinds: ['models'],
          profileIds: [query.profileId],
          keys: [discoveryCacheKey('models', query.profileId, query.queryKey)],
        },
      ]
    case 'discovery.endpoints':
      return [
        {
          kind: 'discovery-cache',
          cacheKinds: ['endpoints'],
          profileIds: [query.profileId],
          keys: [discoveryCacheKey('endpoints', query.profileId, query.modelId)],
        },
      ]
    case 'discovery.privacy':
      return [
        {
          kind: 'discovery-cache',
          cacheKinds: ['privacy'],
          profileIds: [query.profileId],
          keys: [discoveryCacheKey('privacy', query.profileId, query.modelId)],
        },
      ]
    default:
      return assertNever(query)
  }
}

export type WorkspaceProtocolDependencyProbe = typeof workspaceQueryDependencies

export type WorkspaceQueryResult<Q extends WorkspaceQuery> = Q extends { kind: 'workspace.meta' }
  ? WorkspaceMeta
  : Q extends { kind: 'interchange.export-chat' }
    ? ChatExportEnvelope
    : Q extends { kind: 'interchange.export-chat-preset' }
      ? ChatPresetExportEnvelope
      : Q extends { kind: 'interchange.export-connection-profile' }
        ? ConnectionProfileExportEnvelope
        : Q extends { kind: 'interchange.export-workspace-backup' }
          ? WorkspaceBackupEnvelope
          : Q extends { kind: 'chat.get' }
            ? Chat | undefined
            : Q extends { kind: 'chat.token-calibrations' }
              ? Array<ChatTokenCalibrationProjection | undefined>
              : Q extends { kind: 'sidebar.rows-by-id' }
                ? Array<ChatSidebarRow | undefined>
                : Q extends { kind: 'sidebar.catalog-page' }
                  ? ChatSidebarCatalogPage
                  : Q extends { kind: 'sidebar.presentation-page' }
                    ? SidebarPresentationPage
                    : Q extends { kind: 'sidebar.aggregate' }
                      ? ChatSidebarAggregate
                      : Q extends { kind: 'sidebar.created-at-group-count' }
                        ? number
                        : Q extends { kind: 'chat.next-fork-title' }
                          ? string
                          : Q extends { kind: 'configuration.discovery-snapshot' }
                            ? ConnectionDiscoverySnapshot | undefined
                            : Q extends { kind: 'configuration.shell' }
                              ? ConfigurationShellProjection
                              : Q extends { kind: 'configuration.global-token-calibration' }
                                ? GlobalTokenCalibration
                                : Q extends { kind: 'configuration.text-template-catalog' }
                                  ? readonly SavedTextTemplateCatalogRow[]
                                  : Q extends { kind: 'configuration.active-selection' }
                                    ? ConfigurationActiveSelectionProjection
                                    : Q extends { kind: 'configuration.active-model' }
                                      ? ConfigurationActiveModelRead
                                      : Q extends { kind: 'configuration.profile-switch-plan' }
                                        ? ConfigurationProfileSwitchPlan | undefined
                                        : Q extends { kind: 'configuration.model-resolution-head' }
                                          ? ConfigurationModelResolutionHead
                                          : Q extends {
                                                kind: 'configuration.model-resolution-page'
                                              }
                                            ? ConfigurationModelResolutionPage
                                            : Q extends {
                                                  kind: 'configuration.profile-catalog-page'
                                                }
                                              ? ConfigurationProfileCatalogPage
                                              : Q extends {
                                                    kind: 'configuration.preset-catalog-page'
                                                  }
                                                ? ConfigurationPresetCatalogPage
                                                : Q extends {
                                                      kind: 'configuration.prompt-preset-catalog-page'
                                                    }
                                                  ? ConfigurationPromptPresetCatalogPage
                                                  : Q extends {
                                                        kind: 'configuration.connection-manager-page'
                                                      }
                                                    ? ConfigurationConnectionManagerPage
                                                    : Q extends {
                                                          kind: 'configuration.generated-output-network-access'
                                                        }
                                                      ? GeneratedOutputNetworkAccess
                                                      : Q extends { kind: 'key.get' }
                                                        ? KeyRecord | undefined
                                                        : Q extends { kind: 'setting.get' }
                                                          ? unknown
                                                          : Q extends {
                                                                kind: 'setting.get-many'
                                                              }
                                                            ? Record<string, unknown>
                                                            : Q extends {
                                                                  kind: 'folder.list'
                                                                }
                                                              ? ChatFolder[]
                                                              : Q extends {
                                                                    kind: 'tag.list'
                                                                  }
                                                                ? ChatTag[]
                                                                : Q extends {
                                                                      kind: 'message.presentation'
                                                                    }
                                                                  ? MessagePresentation | undefined
                                                                  : Q extends {
                                                                        kind: 'message.presentations'
                                                                      }
                                                                    ? Array<
                                                                        | MessagePresentation
                                                                        | undefined
                                                                      >
                                                                    : Q extends {
                                                                          kind: 'message.preview-window'
                                                                        }
                                                                      ? Array<
                                                                          | MessageTextPreviewSnapshot
                                                                          | undefined
                                                                        >
                                                                      : Q extends {
                                                                            kind: 'message.search-corpus'
                                                                          }
                                                                        ? MessageCorpusSearchResult
                                                                        : Q extends {
                                                                              kind: 'message.headers-by-chat'
                                                                            }
                                                                          ? ConversationTopologyResult
                                                                          : Q extends {
                                                                                kind: 'branch.open'
                                                                              }
                                                                            ? ConversationOpenResult
                                                                            : Q extends {
                                                                                  kind: 'branch.forks'
                                                                                }
                                                                              ? ConversationForksResult
                                                                              : Q extends {
                                                                                    kind: 'branch.page-structure'
                                                                                  }
                                                                                ? KnownBranchPageStructuralResult
                                                                                : Q extends {
                                                                                      kind: 'branch.child-at-position'
                                                                                    }
                                                                                  ? MessageId | null
                                                                                  : Q extends {
                                                                                        kind: 'stream.lease'
                                                                                      }
                                                                                    ?
                                                                                        | StreamLeaseRow
                                                                                        | undefined
                                                                                    : Q extends {
                                                                                          kind: 'stream.leases-by-id'
                                                                                        }
                                                                                      ? Array<
                                                                                          | StreamLeaseRow
                                                                                          | undefined
                                                                                        >
                                                                                      : Q extends {
                                                                                            kind: 'stream.lease-head'
                                                                                          }
                                                                                        ?
                                                                                            | StreamLeaseRow
                                                                                            | undefined
                                                                                        : Q extends {
                                                                                              kind: 'stream.leases'
                                                                                            }
                                                                                          ? StreamLeaseRow[]
                                                                                          : Q extends {
                                                                                                kind: 'stream.journal-frame-page'
                                                                                              }
                                                                                            ? StreamJournalFramePage
                                                                                            : Q extends {
                                                                                                  kind: 'attachment.catalog-rows'
                                                                                                }
                                                                                              ? Array<
                                                                                                  | AttachmentCatalogRow
                                                                                                  | undefined
                                                                                                >
                                                                                              : Q extends {
                                                                                                    kind: 'attachment.catalog-aggregate'
                                                                                                  }
                                                                                                ? AttachmentCatalogAggregate
                                                                                                : Q extends {
                                                                                                      kind: 'attachment.manager-detail'
                                                                                                    }
                                                                                                  ?
                                                                                                      | AttachmentManagerDetail
                                                                                                      | undefined
                                                                                                  : Q extends {
                                                                                                        kind: 'attachment.catalog-page'
                                                                                                      }
                                                                                                    ? AttachmentCatalogPage
                                                                                                    : Q extends {
                                                                                                          kind: 'attachment.catalog-evaluate'
                                                                                                        }
                                                                                                      ? Array<
                                                                                                          | AttachmentCatalogRow
                                                                                                          | undefined
                                                                                                        >
                                                                                                      : Q extends {
                                                                                                            kind: 'attachment.get'
                                                                                                          }
                                                                                                        ?
                                                                                                            | Attachment
                                                                                                            | undefined
                                                                                                        : Q extends {
                                                                                                              kind: 'attachment.generation-token-evidence'
                                                                                                            }
                                                                                                          ?
                                                                                                              | GenerationAttachmentTokenEvidence
                                                                                                              | undefined
                                                                                                          : Q extends {
                                                                                                                kind: 'attachment.get-many'
                                                                                                              }
                                                                                                            ? Array<
                                                                                                                | Attachment
                                                                                                                | undefined
                                                                                                              >
                                                                                                            : Q extends {
                                                                                                                  kind: 'attachment.media-many'
                                                                                                                }
                                                                                                              ? Array<
                                                                                                                  | AttachmentMediaProjection
                                                                                                                  | undefined
                                                                                                                >
                                                                                                              : Q extends {
                                                                                                                    kind: 'attachment.media'
                                                                                                                  }
                                                                                                                ?
                                                                                                                    | AttachmentMediaProjection
                                                                                                                    | undefined
                                                                                                                : Q extends {
                                                                                                                      kind: 'attachment.bundle'
                                                                                                                    }
                                                                                                                  ?
                                                                                                                      | AttachmentBundle
                                                                                                                      | undefined
                                                                                                                  : Q extends {
                                                                                                                        kind: 'attachment.dispatch-bundle'
                                                                                                                      }
                                                                                                                    ?
                                                                                                                        | AttachmentDispatchBundle
                                                                                                                        | undefined
                                                                                                                    : Q extends {
                                                                                                                          kind: 'attachment.find-hash'
                                                                                                                        }
                                                                                                                      ?
                                                                                                                          | AttachmentId
                                                                                                                          | undefined
                                                                                                                      : Q extends {
                                                                                                                            kind: 'attachment.references'
                                                                                                                          }
                                                                                                                        ? AttachmentReferenceEdge[]
                                                                                                                        : Q extends {
                                                                                                                              kind: 'attachment.reference-rows'
                                                                                                                            }
                                                                                                                          ? AttachmentReferenceRow[]
                                                                                                                          : Q extends {
                                                                                                                                kind: 'generated-output.localization-queue'
                                                                                                                              }
                                                                                                                            ? GeneratedOutputLocalizationQueueSnapshot
                                                                                                                            : Q extends {
                                                                                                                                  kind: 'discovery.models'
                                                                                                                                }
                                                                                                                              ?
                                                                                                                                  | CachedModelsRow
                                                                                                                                  | undefined
                                                                                                                              : Q extends {
                                                                                                                                    kind: 'discovery.endpoints'
                                                                                                                                  }
                                                                                                                                ?
                                                                                                                                    | CachedEndpointsRow
                                                                                                                                    | undefined
                                                                                                                                : Q extends {
                                                                                                                                      kind: 'discovery.privacy'
                                                                                                                                    }
                                                                                                                                  ?
                                                                                                                                      | CachedPrivacyPolicyRow
                                                                                                                                      | undefined
                                                                                                                                  : never

type OrganizationCommand =
  | { kind: 'folder.create'; input: CreateFolderInput }
  | { kind: 'folder.update'; folderId: FolderId; patch: UpdateFolderInput }
  | {
      kind: 'folder.delete'
      folderId: FolderId
      chatDisposition?: 'move-top-level' | 'archive'
      now?: number
    }
  | { kind: 'folder.ensure-and-move-chats'; input: EnsureFolderAndMoveChatsInput }

export type MessageMutationCommand =
  | { kind: 'message.edit-content'; input: EditMessageInput }
  | MessageBodyMutationInput
  | { kind: 'message.import'; input: PasteImportInput }
  | {
      kind: 'message.delete'
      mode: 'pair' | 'single' | 'turn' | 'variant'
      input: DeleteInput
    }
  | { kind: 'message.restore-structure'; input: RestoreStructuralSnapshotInput }

export type AttachmentCommand =
  | { kind: 'attachment.bundle.write'; input: AttachmentBundleWriteInput }
  | { kind: 'attachment.ref.add'; input: AttachmentRefAddInput }
  | { kind: 'attachment.ref.set-visibility'; input: AttachmentRefVisibilityInput }
  | { kind: 'attachment.ref.detach'; input: AttachmentRefDetachInput }
  | { kind: 'attachment.ref.relink'; input: AttachmentRefRelinkInput }
  | { kind: 'attachment.bytes.delete'; input: AttachmentDeleteBytesInput }
  | { kind: 'attachment.delete-if-unreferenced'; attachmentId: AttachmentId }
  | { kind: 'attachment.delete-many'; input: AttachmentDeleteManyInput }
  | {
      kind: 'attachment.reap'
      now: number
      maxAgeMs: number
      limit?: number
    }
  | { kind: 'draft.put'; input: DraftPutInput }
  | {
      kind: 'generated-output.localization-claim'
      input: GeneratedOutputLocalizationClaimInput
    }
  | {
      kind: 'generated-output.localization-retry'
      input: GeneratedOutputLocalizationRetryInput
    }
  | {
      kind: 'generated-output.localization-fail'
      input: GeneratedOutputLocalizationFailInput
    }
  | {
      kind: 'generated-output.localization-complete'
      input: GeneratedOutputLocalizationCompleteInput
    }
  | { kind: 'generated-output.video-expand'; input: GeneratedOutputVideoExpandInput }

export type ConfigurationWorkspaceCommand<
  Kind extends ConfigurationDomainCommandKind = ConfigurationDomainCommandKind,
> = {
  [ExactKind in Kind]: {
    kind: 'configuration.execute'
    input: ConfigurationDomainCommand<ExactKind>
  }
}[Kind]

export interface MaterializeTemporaryChatInput {
  readonly chatId: ChatId
  readonly settings: ChatSettings
  readonly presetId?: PresetId
  readonly now: number
}

export interface MaterializeTemporaryChatResult {
  readonly destination: ConversationProvedSelection
}

export type AttemptMutationCommand =
  | { kind: 'attempt.prepare'; input: PrepareAttemptInput }
  | { kind: 'attempt.dispatch'; input: AttemptDispatchInput }
  | { kind: 'attempt.finalize'; input: AttemptTerminalProjection }

export type ScopeDerivedMutationCommand =
  | { kind: 'chat.materialize-temporary'; input: MaterializeTemporaryChatInput }
  | MessageMutationCommand
  | AttemptMutationCommand
  | AttachmentCommand

export type WorkspaceCommand =
  | {
      kind: 'interchange.import-chat'
      envelope: ChatExportEnvelope
      options: ImportChatOptions
    }
  | {
      kind: 'interchange.import-chat'
      imports: readonly ImportChatRequest[]
    }
  | {
      kind: 'interchange.import-chat-preset'
      envelope: ChatPresetExportEnvelope
      options: ImportChatPresetOptions
    }
  | {
      kind: 'interchange.import-connection-profile'
      envelope: ConnectionProfileExportEnvelope
      options: ImportConnectionProfileOptions
    }
  | {
      kind: 'chat.discard-empty-drafts'
      chatIds: readonly ChatId[]
      now: number
    }
  | ScopeDerivedMutationCommand
  | { kind: 'chat.set-archived'; chatIds: readonly ChatId[]; archived: boolean; now: number }
  | { kind: 'chat.delete-archived'; chatIds: readonly ChatId[]; now: number }
  | { kind: 'chat.empty-archive'; afterChatId?: ChatId; limit: number; now: number }
  | {
      kind: 'chat.move-to-folder'
      chatIds: readonly ChatId[]
      folderId: FolderId | null
      now: number
    }
  | {
      kind: 'chat.set-tags-from-names'
      chatIds: readonly ChatId[]
      names: readonly string[]
      now: number
    }
  | { kind: 'chat.touch-viewed'; chatId: ChatId; now: number }
  | { kind: 'chat.set-manual-title'; chatId: ChatId; title: string; now: number }
  | { kind: 'chat.calibration.clear'; chatId: ChatId; calibrationKey?: string; now: number }
  | { kind: 'chat.calibration.clear-family'; calibrationKey: string; now: number }
  | { kind: 'chat.calibration.clear-all'; now: number }
  | { kind: 'chat.fork'; input: ForkChatFromMessageInput }
  | { kind: 'attempt.request-stop'; input: AttemptRequestStopInput }
  | { kind: 'attempt.seal-terminal'; input: AttemptSealTerminalInput }
  | { kind: 'generation.post-commit-metadata'; input: GenerationPostCommitMetadataInput }
  | { kind: 'stream.note-selected-key'; input: StreamNoteSelectedKeyInput }
  | { kind: 'stream.renew'; heartbeat: StreamLeaseHeartbeat }
  | { kind: 'stream.handoff-recovery'; input: StreamHandoffRecoveryInput }
  | { kind: 'stream.claim-recovery'; expected: StreamLeaseRow; now: number }
  | {
      kind: 'stream.append-journal-frames'
      frames: readonly StreamJournalFrameRow[]
      observedAt: number
    }
  | {
      kind: 'stream.finish-cleanup'
      streamId: string
      fence: StreamWriteFence
    }
  | { kind: 'maintenance.reconcile-stream-journal-integrity'; limit: number }
  | {
      kind: 'maintenance.prune-terminal-stream-journals'
      now: number
      maxAgeMs: number
      limit: number
    }
  | {
      kind: 'maintenance.prune-empty-draft-chats'
      maxAgeMs: number
      limit: number
      now: number
    }
  | {
      kind: 'maintenance.prune-discovery-cache'
      limit: number
    }
  | {
      kind: 'maintenance.reconcile-attachment-integrity'
      limit: number
      now: number
    }
  | DiscoveryCacheCommand
  | ConfigurationWorkspaceCommand
  | OrganizationCommand

export type WorkspaceCommandResult<C extends WorkspaceCommand> = C extends {
  kind: 'interchange.import-chat'
  imports: readonly ImportChatRequest[]
}
  ? readonly ImportChatResult[]
  : C extends {
        kind: 'interchange.import-chat'
      }
    ? ImportChatResult
    : C extends { kind: 'interchange.import-chat-preset' }
      ? ImportChatPresetResult
      : C extends { kind: 'interchange.import-connection-profile' }
        ? ImportConnectionProfileResult
        : C extends { kind: 'chat.discard-empty-drafts' }
          ? DeleteChatClosureMetadataResult
          : C extends { kind: 'chat.materialize-temporary' }
            ? MaterializeTemporaryChatResult
            : C extends { kind: 'chat.set-archived' }
              ? ChatMetadataWriteResult<readonly ChatId[]>
              : C extends { kind: 'chat.delete-archived' }
                ? DeleteArchivedChatMetadataResult
                : C extends { kind: 'chat.empty-archive' }
                  ? DeleteChatClosurePageResult
                  : C extends { kind: 'chat.move-to-folder' }
                    ? ChatMetadataWriteResult<boolean>
                    : C extends { kind: 'chat.set-tags-from-names' }
                      ? ChatTagAssignmentResult
                      : C extends {
                            kind:
                              | 'chat.touch-viewed'
                              | 'chat.set-manual-title'
                              | 'chat.calibration.clear'
                          }
                        ? ChatMetadataWriteResult<boolean>
                        : C extends {
                              kind: 'chat.calibration.clear-family' | 'chat.calibration.clear-all'
                            }
                          ? ChatCalibrationEverywhereResult
                          : C extends { kind: 'chat.fork' }
                            ? ForkChatFromMessageResult
                            : C extends { kind: 'message.edit-content' }
                              ? EditMessageResult
                              : C extends {
                                    kind:
                                      | 'message.toggle-reasoning-detail'
                                      | 'message.toggle-provider-output-item'
                                      | 'message.toggle-context'
                                      | 'message.dismiss-generation-notice'
                                  }
                                ? MessagePresentation | undefined
                                : C extends { kind: 'message.import' }
                                  ? PasteImportResult
                                  : C extends { kind: 'message.delete' }
                                    ? DeleteResult
                                    : C extends { kind: 'message.restore-structure' }
                                      ? StructuralSnapshotPresentation
                                      : C extends { kind: 'attempt.prepare' }
                                        ? AttemptPrepareResult
                                        : C extends { kind: 'attempt.dispatch' }
                                          ? AttemptDispatchResult
                                          : C extends { kind: 'attempt.request-stop' }
                                            ? AttemptRequestStopResult
                                            : C extends { kind: 'attempt.seal-terminal' }
                                              ? TerminalDecidedStreamLeaseRow
                                              : C extends { kind: 'attempt.finalize' }
                                                ? AttemptFinalizeResult
                                                : C extends {
                                                      kind: 'generation.post-commit-metadata'
                                                    }
                                                  ? GenerationPostCommitMetadataResult
                                                  : C extends { kind: 'stream.note-selected-key' }
                                                    ? StreamLeaseRow
                                                    : C extends { kind: 'stream.renew' }
                                                      ? StreamLeaseRow
                                                      : C extends {
                                                            kind: 'stream.handoff-recovery'
                                                          }
                                                        ? StreamLeaseRow
                                                        : C extends {
                                                              kind: 'stream.claim-recovery'
                                                            }
                                                          ? StreamLeaseRow | undefined
                                                          : C extends {
                                                                kind: 'stream.append-journal-frames'
                                                              }
                                                            ? undefined
                                                            : C extends {
                                                                  kind: 'stream.finish-cleanup'
                                                                }
                                                              ? StreamFinishCleanupResult
                                                              : C extends {
                                                                    kind: 'maintenance.reconcile-stream-journal-integrity'
                                                                  }
                                                                ? {
                                                                    scannedStreamIds: number
                                                                    deletedStreamIds: string[]
                                                                    deletedFrames: number
                                                                    done: boolean
                                                                  }
                                                                : C extends {
                                                                      kind: 'maintenance.prune-terminal-stream-journals'
                                                                    }
                                                                  ? {
                                                                      scanned: number
                                                                      deletedStreamIds: string[]
                                                                      deletedFrames: number
                                                                      earliestDeferredAt?: number
                                                                      done: boolean
                                                                    }
                                                                  : C extends {
                                                                        kind: 'maintenance.prune-empty-draft-chats'
                                                                      }
                                                                    ? EmptyDraftChatClosurePageResult
                                                                    : C extends {
                                                                          kind: 'attachment.bundle.write'
                                                                        }
                                                                      ? AttachmentBundleWriteResult
                                                                      : C extends {
                                                                            kind:
                                                                              | 'attachment.ref.add'
                                                                              | 'attachment.ref.set-visibility'
                                                                              | 'attachment.ref.detach'
                                                                          }
                                                                        ? AttachmentRefWriteResult
                                                                        : C extends {
                                                                              kind: 'attachment.ref.relink'
                                                                            }
                                                                          ? AttachmentRefRelinkResult
                                                                          : C extends {
                                                                                kind: 'attachment.bytes.delete'
                                                                              }
                                                                            ? Attachment | undefined
                                                                            : C extends {
                                                                                  kind: 'attachment.delete-if-unreferenced'
                                                                                }
                                                                              ? AttachmentDeleteIfUnreferencedResult
                                                                              : C extends {
                                                                                    kind: 'attachment.reap'
                                                                                  }
                                                                                ? AttachmentReapResult
                                                                                : C extends {
                                                                                      kind: 'attachment.delete-many'
                                                                                    }
                                                                                  ? AttachmentDeleteManyResult
                                                                                  : C extends {
                                                                                        kind: 'draft.put'
                                                                                      }
                                                                                    ? DraftRow
                                                                                    : C extends {
                                                                                          kind: 'generated-output.localization-claim'
                                                                                        }
                                                                                      ?
                                                                                          | GeneratedOutputLocalizationClaim
                                                                                          | undefined
                                                                                      : C extends {
                                                                                            kind:
                                                                                              | 'generated-output.localization-retry'
                                                                                              | 'generated-output.localization-fail'
                                                                                              | 'generated-output.localization-complete'
                                                                                          }
                                                                                        ? GeneratedOutputLocalizationJobResult
                                                                                        : C extends {
                                                                                              kind: 'generated-output.video-expand'
                                                                                            }
                                                                                          ? GeneratedOutputVideoExpandResult
                                                                                          : C extends {
                                                                                                kind: 'discovery.models.delete'
                                                                                              }
                                                                                            ? boolean
                                                                                            : C extends {
                                                                                                  kind: 'discovery.models.put'
                                                                                                }
                                                                                              ? DiscoveryModelsPutResult
                                                                                              : C extends {
                                                                                                    kind:
                                                                                                      | 'discovery.endpoints.put'
                                                                                                      | 'discovery.privacy.put'
                                                                                                  }
                                                                                                ? DiscoveryCachePutResult
                                                                                                : C extends {
                                                                                                      kind: 'maintenance.prune-discovery-cache'
                                                                                                    }
                                                                                                  ? DiscoveryCacheMaintenanceResult
                                                                                                  : C extends {
                                                                                                        kind: 'configuration.execute'
                                                                                                        input: infer Input extends
                                                                                                          ConfigurationDomainCommand
                                                                                                      }
                                                                                                    ? ConfigurationDomainResult<
                                                                                                        Input['kind']
                                                                                                      >
                                                                                                    : C extends {
                                                                                                          kind: 'folder.create'
                                                                                                        }
                                                                                                      ? ChatFolder
                                                                                                      : C extends {
                                                                                                            kind: 'folder.update'
                                                                                                          }
                                                                                                        ?
                                                                                                            | ChatFolder
                                                                                                            | undefined
                                                                                                        : C extends {
                                                                                                              kind: 'folder.delete'
                                                                                                            }
                                                                                                          ? DeleteFolderResult
                                                                                                          : C extends {
                                                                                                                kind: 'folder.ensure-and-move-chats'
                                                                                                              }
                                                                                                            ? EnsureFolderAndMoveChatsResult
                                                                                                            : C extends {
                                                                                                                  kind: 'maintenance.reconcile-attachment-integrity'
                                                                                                                }
                                                                                                              ? AttachmentIntegrityMaintenanceResult
                                                                                                              : never

export type WorkspaceReplacement = {
  kind: 'interchange.restore-workspace-backup'
  envelope: WorkspaceBackupEnvelope
  options: RestoreWorkspaceBackupOptions
}

export type WorkspaceReplacementResult<R extends WorkspaceReplacement> = R extends {
  kind: 'interchange.restore-workspace-backup'
}
  ? RestoreWorkspaceBackupResult
  : never

export interface WorkspaceChangeSubscriptionOptions {
  readonly delivery?: 'all' | 'remote'
}

export type WorkspaceLocalCommitApplicationDisposition = 'applied' | 'inactive'

export type WorkspaceLocalCommitApplication<T = unknown> = (
  commit: CommitEnvelope<T>,
) => WorkspaceLocalCommitApplicationDisposition

export interface WorkspaceCommandExecutionOptions<T = unknown> {
  readonly localApplications?: {
    readonly conversation?: WorkspaceLocalCommitApplication<T>
  }
}

export interface WorkspaceRepository {
  query<Q extends WorkspaceQuery>(
    permit: WorkspaceReadAuthority,
    query: Q,
    options?: WorkspaceQueryOptions<Q>,
  ): Promise<ReadEnvelope<WorkspaceQueryResult<Q>>>
  execute<C extends WorkspaceCommand>(
    permit: WorkspaceWriteAuthority,
    command: C,
    options?: WorkspaceCommandExecutionOptions<WorkspaceCommandResult<C>>,
  ): Promise<CommitEnvelope<WorkspaceCommandResult<C>>>
  replace<R extends WorkspaceReplacement>(
    replacement: R,
  ): Promise<WorkspaceReplacementEnvelope<WorkspaceReplacementResult<R>>>
  subscribeChanges(
    listener: (change: WorkspaceChange) => void,
    options?: WorkspaceChangeSubscriptionOptions,
  ): () => void
}
