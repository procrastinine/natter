import type { Collection, Table, Transaction } from 'dexie'
import { sha256Hex as sha256BytesHex } from '../core/attachments/process'
import { chatTagNameLower } from '../core/chat-metadata'
import {
  isGeneratedOutputLocalizationJob,
  withGeneratedOutputLocalizationState,
} from '../core/generated-output-localization'
import { WorkspaceReplacementInProgressError } from '../core/import-export/errors'
import { flattenChatSettingsForPortableExport } from '../core/import-export/flatten'
import {
  type ChatExportEnvelope,
  type ChatPresetExportEnvelope,
  type ConnectionProfileExportEnvelope,
  type ConnectionSketch,
  NATTER_EXPORT_SCHEMA_VERSION,
  type NatterExportEnvelope,
  type NatterExportObjectKind,
  type PortableAttachmentBlob,
  type PortableAttachmentBundle,
  type PortableChatPayload,
  type PortableChatPresetPayload,
  type PortableConnectionProfilePayload,
  type PortableFolderSketch,
  type PortableTagSketch,
  type WorkspaceBackupEnvelope,
  type WorkspaceBackupPayload,
  workspaceBackupManifest,
} from '../core/import-export/schema'
import { normalizeWorkspaceCredentialReferences } from '../core/import-export/workspace-credentials'
import {
  validatePortableChatGraph,
  validateWorkspaceBackupGraph,
} from '../core/import-export/workspace-validation'
import { fixedConversationSelectionTarget } from '../core/messages'
import {
  LEGACY_SAVED_TEXT_TEMPLATES_KEY,
  type SavedTextTemplate,
  savedTextTemplatesFromStoredValue,
} from '../core/text-templates'
import type {
  Attachment,
  AttachmentArtifact,
  AttachmentBlob,
  AttachmentId,
  AttachmentJob,
  Chat,
  ChatFolder,
  ChatPreset,
  ChatSettings,
  ChatTag,
  ChildListState,
  ChildSlotMember,
  ConnectionProfile,
  ContentItem,
  FolderId,
  Message,
  MessageAttachmentRef,
  MessageId,
  PresetId,
  ProfileId,
  PromptPresetKind,
  TagId,
} from '../core/types'
import { newId } from '../lib/ulid'
import {
  ATTACHMENT_CATALOG_MUTATION_TRANSACTION_CAPABILITY,
  emptyAttachmentCatalogAggregateRow,
  putAttachmentCatalogProjectionFromHeader,
} from './attachment-catalog-projection'
import { markAttachmentIntegrityRepairComplete } from './attachment-integrity-maintenance'
import { applyAttachmentReferenceOwnerTransitions } from './attachment-reference-edges'
import {
  type AttachmentHeaderRow,
  hydrateAttachment,
  splitAttachmentForStorage,
} from './attachment-storage'
import { reduceAttemptAvailability } from './attempt-availability'
import { recordBrowserCommandAttachmentReferenceState } from './browser-command-mutation-journal'
import type { BrowserCommandSessionPort } from './browser-domain-mutations'
import type { BrowserWorkspaceReplacementMutationGrant } from './browser-workspace-contract'
import { rebuildChildSlotDerivedState } from './browser-workspace-derived-repair'
import {
  addAttachmentArtifactByteOwners,
  addAttachmentBlobByteOwners,
  addAttachmentJobByteOwners,
  addLinkedSemanticByteOwner,
  putAttachmentHeaderByteOwner,
  putChatFolderByteOwner,
  putChatTagByteOwners,
} from './byte-owner-mutation'
import {
  CHAT_ROW_LINKED_TRANSACTION_CAPABILITY,
  openLinkedChatMutation,
} from './chat-row-transition'
import {
  accumulateChatSidebarAggregateRows,
  chatSidebarProjectionRow,
  chatSidebarProjectionSettings,
  createChatSidebarAggregateAccumulator,
  isChatSidebarProjectionSettingKey,
  materializeChatSidebarAggregateRows,
} from './chat-sidebar-projection'
import {
  CONFIGURATION_PRESET_CATALOG_TRANSACTION_CAPABILITY,
  CONFIGURATION_PROFILE_CATALOG_TRANSACTION_CAPABILITY,
  type ConfigurationPresetCatalogProjectionRow,
  configurationCatalogMetadataRowsFromCounts,
  configurationPresetCatalogProjectionRow,
  configurationProfileCatalogProjectionRow,
  configurationPromptPresetCatalogProjectionRow,
  putConfigurationPresetCatalogProjection,
  putConfigurationProfileCatalogProjection,
} from './configuration-catalog-projection'
import {
  buildConnectionProfile,
  configurationLinksForChat,
  configurationLinksForPreset,
  configurationLinksForProfile,
} from './configuration-domain-contract'
import { PresetMissingError } from './configuration-errors'
import {
  CONFIGURATION_LINK_MUTATION_TRANSACTION_CAPABILITY,
  configurationProfileUsageProjectionRows,
} from './configuration-profile-usage-projection'
import { proveConversationSelectionInTransaction } from './conversation-destination-seal'
import type { NatterDb } from './db'
import { seedEmptyDiscoveryCacheState } from './discovery-cache-storage'
import type {
  ImportChatOptions,
  ImportChatPresetOptions,
  ImportChatPresetResult,
  ImportChatResult,
  ImportConnectionProfileOptions,
  ImportConnectionProfileResult,
  RestoreWorkspaceBackupOptions,
  RestoreWorkspaceBackupResult,
} from './import-export-contract'
import {
  type CurrentMessageTransition,
  compileCurrentMessageGraphTransition,
  compileCurrentMessageTransition,
  hydrateMessages,
  type MessageBodyRow,
  type MessageHeaderRow,
  previewTextsByChat,
} from './message-storage'
import { physicalStorageTables } from './physical-storage-tables'
import {
  appendPresetOrderEntry,
  buildPresetOrderOnEmptyTables,
  PRESET_ORDER_MUTATION_TRANSACTION_CAPABILITY,
  readPresetOrderIds,
} from './preset-order'
import type { StreamLeaseRow, WorkspaceMeta } from './repository'
import { semanticOperationDescriptor } from './semantic-operation-capability'
import { discardStorageCompactionDebt } from './storage-compaction-state'
import { freshStorageRetentionStateRows } from './storage-retention-state'
import { estimateStoredValueBytes } from './storage-size-estimate'
import { completedStreamJournalIntegritySetting } from './stream-journal-integrity'
import {
  markBrowserWorkspaceReplaced,
  readBrowserWorkspaceMetaFromTransaction,
} from './workspace-meta'

function isInternalStreamAdmissionSettingKey(key: string): boolean {
  return key === 'stream-admission-sequence'
}

function isPortableWorkspaceSettingKey(key: string): boolean {
  return (
    !isChatSidebarProjectionSettingKey(key) &&
    !isInternalStreamAdmissionSettingKey(key) &&
    key !== 'workspace-meta' &&
    key !== LEGACY_SAVED_TEXT_TEMPLATES_KEY
  )
}

const IMPORT_EXPORT_PAGE_SIZE = 128

const IMPORT_CHAT_TRANSACTION_CAPABILITY = physicalStorageTables(
  ...ATTACHMENT_CATALOG_MUTATION_TRANSACTION_CAPABILITY.tableNames,
  ...CHAT_ROW_LINKED_TRANSACTION_CAPABILITY.tableNames,
  'attachmentArtifacts',
  'attachmentBlobs',
  'attachmentJobs',
  'childLists',
  'childSlotMembers',
  'folders',
  'messageBodies',
  'messagePreviews',
  'messages',
  'profiles',
  'tags',
)
const IMPORT_CONNECTION_PROFILE_TRANSACTION_CAPABILITY = physicalStorageTables(
  ...CONFIGURATION_PROFILE_CATALOG_TRANSACTION_CAPABILITY.tableNames,
  ...CONFIGURATION_LINK_MUTATION_TRANSACTION_CAPABILITY.tableNames,
  'profiles',
)
const IMPORT_CHAT_PRESET_TRANSACTION_CAPABILITY = physicalStorageTables(
  ...CONFIGURATION_PRESET_CATALOG_TRANSACTION_CAPABILITY.tableNames,
  ...CONFIGURATION_LINK_MUTATION_TRANSACTION_CAPABILITY.tableNames,
  ...PRESET_ORDER_MUTATION_TRANSACTION_CAPABILITY.tableNames,
  'presets',
  'profiles',
)

interface ImportConnectionProfileResourceInput {
  readonly profileId: ProfileId
  readonly nameKey: string
}

interface ImportChatPresetResourceInput {
  readonly presetId: PresetId
  readonly nameKey: string
  readonly profileResourceNames: readonly string[]
}

interface ImportChatResourceInput {
  readonly chatId: Chat['id']
  readonly profileResourceNames: readonly string[]
  readonly folderNameKey?: string
  readonly tagNameKeys: readonly string[]
  readonly attachmentFingerprintKeys: readonly string[]
}

function importConnectionProfileResourceNames(
  input: ImportConnectionProfileResourceInput,
): readonly string[] {
  return [`profile:${input.profileId}`, `profile-name:${input.nameKey}`]
}

function importChatPresetResourceNames(input: ImportChatPresetResourceInput): readonly string[] {
  return [
    `preset:${input.presetId}`,
    'preset-order',
    `preset-name:${input.nameKey}`,
    ...input.profileResourceNames,
  ]
}

function importChatResourceNames(input: ImportChatResourceInput): readonly string[] {
  return [
    `chat-meta:${input.chatId}`,
    `message-topology:${input.chatId}`,
    ...input.profileResourceNames,
    ...(input.folderNameKey ? [`folder-name:${input.folderNameKey}`] : []),
    ...input.tagNameKeys.map((nameKey) => `tag-name:${nameKey}`),
    ...input.attachmentFingerprintKeys.map(
      (fingerprint) => `attachment-fingerprint:${fingerprint}`,
    ),
  ]
}

const IMPORT_CONNECTION_PROFILE_OPERATION = semanticOperationDescriptor({
  operationKind: 'interchange.import-connection-profile',
  transaction: IMPORT_CONNECTION_PROFILE_TRANSACTION_CAPABILITY,
  resources: importConnectionProfileResourceNames,
  permittedWrites: IMPORT_CONNECTION_PROFILE_TRANSACTION_CAPABILITY.tableNames,
  requiredWritesWhenMutated: ['profiles', 'configurationProfileCatalogRows'],
  effects: {
    kind: 'effect-kinds',
    permitted: ['profile'],
    requiredWhenMutated: () => ['profile'],
  },
})

const IMPORT_CHAT_PRESET_OPERATION = semanticOperationDescriptor({
  operationKind: 'interchange.import-chat-preset',
  transaction: IMPORT_CHAT_PRESET_TRANSACTION_CAPABILITY,
  resources: importChatPresetResourceNames,
  permittedWrites: IMPORT_CHAT_PRESET_TRANSACTION_CAPABILITY.tableNames,
  requiredWritesWhenMutated: [
    'presets',
    'configurationPresetCatalogRows',
    'presetOrderState',
    'presetOrderBlocks',
    'presetOrderMembership',
  ],
  effects: {
    kind: 'effect-kinds',
    permitted: ['preset', 'profile'],
    requiredWhenMutated: () => ['preset', 'profile'],
  },
})

const IMPORT_CHAT_OPERATION = semanticOperationDescriptor({
  operationKind: 'interchange.import-chat',
  transaction: IMPORT_CHAT_TRANSACTION_CAPABILITY,
  resources: importChatResourceNames,
  permittedWrites: IMPORT_CHAT_TRANSACTION_CAPABILITY.tableNames,
  requiredWritesWhenMutated: ['chats', 'chatSidebarRows'],
  effects: {
    kind: 'effect-kinds',
    permitted: [
      'attachment',
      'attachment-job',
      'chat',
      'child-slot',
      'folder',
      'message-body',
      'message-header',
      'message-preview',
      'profile',
      'sidebar',
      'tag',
    ],
    requiredWhenMutated: () => ['chat', 'sidebar'],
  },
})

interface ImportExportMaterializationMetrics {
  tableReadBatches: number
  tableReadRows: number
  maxTableReadBatchRows: number
  tableWriteBatches: number
  tableWriteRows: number
  maxTableWriteBatchRows: number
  messageBodyReadBatches: number
  maxMessageBodyReadBatchRows: number
  attachmentBlobReadBytes: number
  maxAttachmentBlobReadBytes: number
  attachmentBlobDecodeBytes: number
  maxAttachmentBlobDecodeBytes: number
}

let materializationMetrics = emptyMaterializationMetrics()

export function __resetImportExportMaterializationMetricsForTests(): void {
  materializationMetrics = emptyMaterializationMetrics()
}

export function __importExportMaterializationMetricsForTests(): Readonly<ImportExportMaterializationMetrics> {
  return { ...materializationMetrics }
}

interface StoredAttachmentBundle {
  attachment: Attachment
  blobs: AttachmentBlob[]
  artifacts: AttachmentArtifact[]
  jobs: AttachmentJob[]
}

interface ValidatedPortableAttachmentBlob extends PortableAttachmentBlob {
  blobType: string
}

interface ValidatedAttachmentBundle {
  attachment: Attachment
  blobs: ValidatedPortableAttachmentBlob[]
  artifacts: AttachmentArtifact[]
  jobs: AttachmentJob[]
}

interface ResolvedProfile {
  profileId: ProfileId
  matched: boolean
}

async function selectedSavedTextTemplate(
  db: NatterDb,
  settings: ChatSettings,
): Promise<SavedTextTemplate | undefined> {
  const templateId = settings.textTemplate
  if (!templateId?.startsWith('user:')) return undefined
  const template = await db.textTemplates.get(templateId)
  return template ? structuredClone(template) : undefined
}

interface PreparedImportedAttachmentBundle {
  sourceAttachmentId: AttachmentId
  bundle: ValidatedAttachmentBundle
}

export type BrowserImportExportCommit = BrowserCommandSessionPort

export interface BrowserImportExportRead<T> {
  readonly workspace: WorkspaceMeta
  readonly value: T
}

export class BrowserImportExportHandler {
  private readonly db: NatterDb
  private readonly commit: BrowserImportExportCommit | undefined

  constructor(db: NatterDb, commit?: BrowserImportExportCommit) {
    this.db = db
    this.commit = commit
  }

  async exportChat(chatId: string): Promise<BrowserImportExportRead<ChatExportEnvelope>> {
    const db = this.db
    const snapshot = await db.transaction(
      'r',
      [
        db.attachmentArtifacts,
        db.attachmentBlobs,
        db.attachmentJobs,
        db.attachments,
        db.chats,
        db.folders,
        db.messageBodies,
        db.messages,
        db.profiles,
        db.settings,
        db.textTemplates,
        db.tags,
        db.workspaceFence,
      ],
      async (tx) => {
        const chat = await db.chats.get(chatId)
        if (!chat) throw new Error(`ChatMissing:${chatId}`)
        const messages = sortMessages(
          await hydrateStoredMessagesInPages(
            db,
            await db.messages.where('chatId').equals(chatId).primaryKeys(),
          ),
        )
        const folder = chat.folderId ? await db.folders.get(chat.folderId) : undefined
        const tags = chat.tags.length > 0 ? await db.tags.bulkGet(chat.tags) : []
        const profile = await db.profiles.get(chat.settings.profileId)
        const bundles = await storedAttachmentBundles(db, collectAttachmentIds(messages))
        const savedTextTemplate = await selectedSavedTextTemplate(db, chat.settings)
        const workspace = await readBrowserWorkspaceMetaFromTransaction(tx)
        return {
          chat,
          messages,
          folder,
          tags: tags.filter(isDefined),
          profile,
          bundles,
          savedTextTemplate,
          workspace,
        }
      },
    )

    const payload: PortableChatPayload = {
      chat: {
        sourceChatId: snapshot.chat.id,
        title: snapshot.chat.title,
        createdAt: snapshot.chat.createdAt,
        updatedAt: snapshot.chat.updatedAt,
        settings: flattenChatSettingsForPortableExport(snapshot.chat.settings, {
          ...(snapshot.savedTextTemplate ? { savedTextTemplate: snapshot.savedTextTemplate } : {}),
        }),
        ...(snapshot.chat.color ? { color: snapshot.chat.color } : {}),
        ...(snapshot.chat.favoriteModels
          ? { favoriteModels: [...snapshot.chat.favoriteModels] }
          : {}),
        ...(snapshot.chat.recentModels ? { recentModels: [...snapshot.chat.recentModels] } : {}),
      },
      messages: snapshot.messages,
      ...(snapshot.folder ? { folder: folderSketch(snapshot.folder) } : {}),
      tags: snapshot.tags.map(tagSketch),
      attachments: await portableAttachmentBundles(snapshot.bundles),
      ...(snapshot.profile ? { connectionSketch: connectionSketch(snapshot.profile) } : {}),
    }

    return {
      workspace: snapshot.workspace,
      value: envelope(db, snapshot.workspace.workspaceId, 'chat', payload),
    }
  }

  async importChat(
    envelope: ChatExportEnvelope,
    options: ImportChatOptions = {},
  ): Promise<ImportChatResult> {
    const commit = this.requireCommit()
    const now = options.now ?? Date.now()
    const payload = envelope.payload
    validatePortableChatGraph(payload)
    const attachmentCandidates = await prepareImportedAttachments(payload.attachments, now)
    const chatId = options.destinationChatId ?? newId()
    const messageIdMap = Object.fromEntries(
      payload.messages.map((message) => [message.id, newId()]),
    )
    const importedFolderId = portableFolderCandidateId(payload.folder)
    const missingProfileId = `missing:${newId()}`
    return commit.executeSemanticOperation(
      IMPORT_CHAT_OPERATION,
      {
        chatId,
        profileResourceNames: importedProfileResolutionResourceNames(
          payload.chat.settings,
          payload.connectionSketch,
          options.targetProfileId,
          missingProfileId,
        ),
        ...(payload.folder?.name.trim()
          ? { folderNameKey: importNameKey(payload.folder.name) }
          : {}),
        tagNameKeys: payload.tags
          .map((tag) => tag.name.trim())
          .filter(Boolean)
          .map(chatTagNameLower),
        attachmentFingerprintKeys: attachmentCandidates.map(
          ({ bundle }) => bundle.attachment.contentHash ?? `id:${bundle.attachment.id}`,
        ),
      },
      async (tx) => {
        const profiles = tx.table<ConnectionProfile, ProfileId>('profiles')
        const attachments = tx.table<AttachmentHeaderRow, AttachmentId>('attachments')
        const resolvedProfile = await resolveProfileId(
          profiles,
          payload.chat.settings,
          payload.connectionSketch,
          {
            targetProfileId: options.targetProfileId,
            missingProfileId,
          },
        )
        const attachmentIdMap: Record<string, string> = {}
        for (const candidate of attachmentCandidates) {
          const duplicate = await findExistingAttachment(attachments, candidate.bundle.attachment)
          const attachmentId = duplicate?.id ?? candidate.bundle.attachment.id
          attachmentIdMap[candidate.sourceAttachmentId] = attachmentId
          if (duplicate) continue
          await storeValidatedAttachmentBundle(tx, candidate.bundle)
        }

        const turnIdMap = new Map<string, string>()
        const messages = payload.messages.map((message) =>
          remapImportedMessage(message, {
            chatId,
            messageIdMap,
            turnIdMap,
            attachmentIdMap,
          }),
        )
        const messageGraph = compileCurrentMessageGraphTransition(chatId, messages, now)
        const branchLeafId = messageGraph.lastUpdatedLeafId
        const branchMessages = messageGraph.branchMessages
        const settings = normalizedImportedSettings(
          payload.chat.settings,
          resolvedProfile.profileId,
        )
        const folderResult = await ensurePortableFolder(tx, payload.folder, now, importedFolderId)
        const folderId = folderResult.folderId
        const tagResult = await ensurePortableTags(tx, payload.tags, now)
        const tagIds = tagResult.tagIds
        const chat: Chat = {
          id: chatId,
          title: payload.chat.title,
          titleStatus: 'untitled',
          createdAt: now,
          updatedAt: now,
          lastViewedAt: now,
          wordCount: messageGraph.wordCount,
          totalCostUsd: messageGraph.totalCostUsd,
          metaVersion: 0,
          summaryVersion: 0,
          structuralVersion: messages.length === 0 ? 0 : 1,
          configurationVersion: 0,
          settings,
          lastUpdatedLeafId: branchLeafId,
          lastBranchUpdatedAt: now,
          archived: false,
          pinned: false,
          folderId: folderId ?? null,
          tags: tagIds,
          ...(payload.chat.color ? { color: payload.chat.color } : {}),
          ...(payload.chat.favoriteModels
            ? { favoriteModels: [...payload.chat.favoriteModels] }
            : {}),
          ...(payload.chat.recentModels ? { recentModels: [...payload.chat.recentModels] } : {}),
          previewText: messageGraph.previewText,
        }
        const chatMutation = openLinkedChatMutation(tx)
        await chatMutation.add(chat)
        await chatMutation.commit()
        await storeNewMessageTransitionsInPages(tx, messageGraph.transitions)
        await replaceMessageAttachmentReferenceOwnersInPages(tx, messageGraph.transitions, now)
        await bulkAddInPages(
          tx.table<ChildListState, string>('childLists'),
          messageGraph.childSlots.states,
        )
        await bulkAddInPages(
          tx.table<ChildSlotMember, MessageId>('childSlotMembers'),
          messageGraph.childSlots.members,
        )
        const branchTip = messageGraph.branchTransitions.at(-1)
        const branchTipMessage = branchMessages.at(-1)
        const destination = await proveConversationSelectionInTransaction(tx, {
          chat,
          target: fixedConversationSelectionTarget(
            branchLeafId === null ? { kind: 'default' } : { kind: 'tip', messageId: branchLeafId },
            branchLeafId,
          ),
          tipId: branchLeafId,
          exactPathHeaders: messageGraph.branchTransitions.map(
            (transition) => transition.storage.header,
          ),
          presentations:
            branchTip && branchTipMessage
              ? [
                  {
                    header: branchTip.storage.header,
                    message: branchTipMessage,
                    bodyVersion: branchTip.storage.header.bodyVersion,
                  },
                ]
              : [],
        })
        return {
          chatId,
          destination,
        }
      },
    )
  }

  async exportChatPreset(
    presetId: PresetId,
  ): Promise<BrowserImportExportRead<ChatPresetExportEnvelope>> {
    const db = this.db
    const snapshot = await db.transaction(
      'r',
      [db.presets, db.profiles, db.settings, db.textTemplates, db.workspaceFence],
      async (tx) => {
        const preset = await db.presets.get(presetId)
        if (!preset) throw new PresetMissingError(presetId)
        const profile = await db.profiles.get(preset.connectionProfileId)
        const savedTextTemplate = await selectedSavedTextTemplate(db, preset.settings)
        const workspace = await readBrowserWorkspaceMetaFromTransaction(tx)
        return { preset, profile, savedTextTemplate, workspace }
      },
    )

    return {
      workspace: snapshot.workspace,
      value: envelope(db, snapshot.workspace.workspaceId, 'chat-preset', {
        sourcePresetId: snapshot.preset.id,
        name: snapshot.preset.name,
        settings: flattenChatSettingsForPortableExport(snapshot.preset.settings, {
          ...(snapshot.savedTextTemplate ? { savedTextTemplate: snapshot.savedTextTemplate } : {}),
        }),
        createdAt: snapshot.preset.createdAt,
        updatedAt: snapshot.preset.updatedAt,
        ...(snapshot.profile ? { connectionSketch: connectionSketch(snapshot.profile) } : {}),
      }),
    }
  }

  async exportConnectionProfile(
    profileId: ProfileId,
  ): Promise<BrowserImportExportRead<ConnectionProfileExportEnvelope>> {
    const db = this.db
    const snapshot = await db.transaction('r', [db.profiles, db.workspaceFence], async (tx) => {
      const profile = await db.profiles.get(profileId)
      if (!profile) throw new Error(`ProfileMissing:${profileId}`)
      const workspace = await readBrowserWorkspaceMetaFromTransaction(tx)
      return { profile, workspace }
    })
    const profile = snapshot.profile
    return {
      workspace: snapshot.workspace,
      value: envelope(db, snapshot.workspace.workspaceId, 'connection-profile', {
        sourceProfileId: profile.id,
        name: profile.name,
        kind: profile.kind,
        baseUrl: profile.baseUrl,
        defaultHeaders: portableConnectionHeaders(profile.defaultHeaders),
        appTitle: profile.appTitle,
        appUrl: profile.appUrl,
        ...(profile.appCategories === undefined
          ? {}
          : { appCategories: [...profile.appCategories] }),
        supportsEndpointsApi: profile.supportsEndpointsApi,
        supportsGenerationApi: profile.supportsGenerationApi,
        supportsPrivacyScrape: profile.supportsPrivacyScrape,
        ...(profile.capabilityOverrides === undefined
          ? {}
          : { capabilityOverrides: structuredClone(profile.capabilityOverrides) }),
        ...(profile.debugRequests === undefined ? {} : { debugRequests: profile.debugRequests }),
      }),
    }
  }

  async importConnectionProfile(
    envelope: ConnectionProfileExportEnvelope,
    options: ImportConnectionProfileOptions = {},
  ): Promise<ImportConnectionProfileResult> {
    const commit = this.requireCommit()
    const now = options.now ?? Date.now()
    const payload = envelope.payload
    const profileId = newId()
    return commit.executeSemanticOperation(
      IMPORT_CONNECTION_PROFILE_OPERATION,
      {
        profileId,
        nameKey: importNameKey(payload.name || 'Imported connection'),
      },
      async (tx) => {
        const profile = buildConnectionProfile({
          ...structuredClone(payload),
          id: profileId,
          name: await uniqueConnectionName(
            tx.table<ConnectionProfile, ProfileId>('profiles'),
            payload.name,
          ),
          defaultHeaders: portableConnectionHeaders(payload.defaultHeaders),
          now,
        })
        await addLinkedSemanticByteOwner(tx, 'profiles', profile)
        await putConfigurationProfileCatalogProjection(tx, profile)
        return { profileId }
      },
    )
  }

  async importChatPreset(
    envelope: ChatPresetExportEnvelope,
    options: ImportChatPresetOptions = {},
  ): Promise<ImportChatPresetResult> {
    const commit = this.requireCommit()
    const now = options.now ?? Date.now()
    const payload = envelope.payload
    const presetId = newId()
    const missingProfileId = `missing:${newId()}`
    return commit.executeSemanticOperation(
      IMPORT_CHAT_PRESET_OPERATION,
      {
        presetId,
        nameKey: importNameKey(payload.name || 'Imported preset'),
        profileResourceNames: importedProfileResolutionResourceNames(
          payload.settings,
          payload.connectionSketch,
          options.targetProfileId,
          missingProfileId,
        ),
      },
      async (tx) => {
        const resolvedProfile = await resolveProfileId(
          tx.table<ConnectionProfile, ProfileId>('profiles'),
          payload.settings,
          payload.connectionSketch,
          {
            targetProfileId: options.targetProfileId,
            missingProfileId,
          },
        )
        const importedName = await uniquePresetName(
          tx.table<ConfigurationPresetCatalogProjectionRow, PresetId>(
            'configurationPresetCatalogRows',
          ),
          payload.name,
        )
        const preset: ChatPreset = {
          id: presetId,
          name: importedName,
          connectionProfileId: resolvedProfile.profileId,
          settings: normalizedImportedSettings(payload.settings, resolvedProfile.profileId),
          createdAt: now,
          updatedAt: now,
          archived: false,
        }
        await addLinkedSemanticByteOwner(tx, 'presets', preset)
        await appendPresetOrderEntry(tx, preset.id)
        await putConfigurationPresetCatalogProjection(tx, preset)
        return {
          presetId,
          profileId: resolvedProfile.profileId,
          profileMatched: resolvedProfile.matched,
        }
      },
    )
  }

  async exportWorkspaceBackup(): Promise<BrowserImportExportRead<WorkspaceBackupEnvelope>> {
    const db = this.db
    const snapshot = await db.transaction('r', db.tables, async (tx) => {
      const workspace = await readBrowserWorkspaceMetaFromTransaction(tx)
      const messages = sortMessages(await hydrateAllStoredMessagesInPages(db))
      const drafts = await readTableInPages(db.drafts)
      const attachmentIds = collectWorkspaceAttachmentIds(messages, drafts)
      const allPresets = await readTableInPages(db.presets)
      const presetById = new Map(allPresets.map((preset) => [preset.id, preset]))
      const activePresetIds = await readPresetOrderIds(tx)
      const activePresets = activePresetIds.map((presetId) => {
        const preset = presetById.get(presetId)
        if (!preset) throw new Error(`PresetOrderPresetMissing:${presetId}`)
        if (preset.archived === true) throw new Error(`PresetOrderPresetArchived:${presetId}`)
        presetById.delete(presetId)
        return preset
      })
      const archivedPresets = [...presetById.values()]
        .filter((preset) => preset.archived === true)
        .sort((left, right) => left.id.localeCompare(right.id))
      if (presetById.size !== archivedPresets.length)
        throw new Error('PresetOrderActivePresetMissing')
      return {
        workspace,
        chats: await readTableInPages(db.chats),
        messages,
        attachmentBundles: await storedAttachmentBundles(db, attachmentIds),
        profiles: await readTableInPages(db.profiles),
        presets: [...activePresets, ...archivedPresets],
        promptPresets: await readTableInPages(db.promptPresets),
        folders: await readTableInPages(db.folders),
        tags: await readTableInPages(db.tags),
        drafts,
        keys: await readTableInPages(db.keys),
        textTemplates: await readTableInPages(db.textTemplates),
        settings: (await readTableInPages(db.settings)).filter((row) =>
          isPortableWorkspaceSettingKey(row.key),
        ),
      }
    })

    const attachments = await consumePortableAttachmentBundles(snapshot.attachmentBundles)

    const sourcePayload: WorkspaceBackupPayload = {
      chats: snapshot.chats,
      messages: snapshot.messages,
      childLists: [],
      chatBranchCache: [],
      attachments,
      profiles: snapshot.profiles,
      presets: snapshot.presets,
      promptPresets: snapshot.promptPresets,
      folders: snapshot.folders,
      tags: snapshot.tags,
      drafts: snapshot.drafts,
      keys: snapshot.keys,
      settings: [
        ...snapshot.settings,
        ...(snapshot.textTemplates.length > 0
          ? [
              {
                key: LEGACY_SAVED_TEXT_TEMPLATES_KEY,
                value: snapshot.textTemplates,
              },
            ]
          : []),
      ],
    }
    const normalizedPayload = normalizeWorkspaceCredentialReferences(sourcePayload)
    const payload: WorkspaceBackupPayload = {
      ...normalizedPayload,
      manifest: workspaceBackupManifest(normalizedPayload),
    }
    return {
      workspace: snapshot.workspace,
      value: envelope(db, snapshot.workspace.workspaceId, 'workspace-backup', payload),
    }
  }

  private requireCommit(): BrowserImportExportCommit {
    if (!this.commit) throw new Error('BrowserImportExportCommitRequired')
    return this.commit
  }
}

export interface PreparedBrowserWorkspaceBackup {
  readonly envelope: WorkspaceBackupEnvelope
  readonly validatedBlobTypes: ReadonlyMap<PortableAttachmentBlob, string>
  readonly previewTextByChatId: ReadonlyMap<string, string>
}

export async function prepareBrowserWorkspaceBackup(
  envelope: WorkspaceBackupEnvelope,
): Promise<PreparedBrowserWorkspaceBackup> {
  validateWorkspaceBackupGraph(envelope.payload)
  const validatedBlobTypes = await validatePortableAttachmentBundles(envelope.payload.attachments)
  return {
    envelope,
    validatedBlobTypes,
    previewTextByChatId: previewTextsByChat(envelope.payload.messages),
  }
}

export async function commitPreparedBrowserWorkspaceBackup(
  db: NatterDb,
  grant: BrowserWorkspaceReplacementMutationGrant,
  prepared: PreparedBrowserWorkspaceBackup,
  options: RestoreWorkspaceBackupOptions = {},
  preactivationCheckpoint: () => void = () => undefined,
): Promise<{
  result: RestoreWorkspaceBackupResult
  workspace: WorkspaceMeta
  estimatedLiveBytes: number
}> {
  preactivationCheckpoint()
  const payload = prepared.envelope.payload
  const workspaceTables = db.tables.filter(
    (table) => table.name !== 'browserLocks' && table.name !== 'workspaceFence',
  )
  const transactionTables = [db.workspaceFence, ...workspaceTables]
  const workspace =
    grant.atomicity === 'slotted-staging'
      ? await restorePreparedBrowserWorkspaceRows(
          db,
          prepared,
          options.now ?? Date.now(),
          preactivationCheckpoint,
          (tables, operation) =>
            grant.runTransaction(db, tables, async (tx) => {
              const result = await operation(tx)
              discardStorageCompactionDebt(tx)
              return result
            }),
          workspaceTables,
        )
      : await grant.runTransaction(db, transactionTables, (tx) =>
          restorePreparedBrowserWorkspaceRows(
            db,
            prepared,
            options.now ?? Date.now(),
            preactivationCheckpoint,
            (_tables, operation) => operation(tx),
            workspaceTables,
          ),
        )
  const estimatedLiveBytes = await estimateBrowserWorkspaceLiveBytes(db, preactivationCheckpoint)
  return {
    workspace,
    estimatedLiveBytes,
    result: {
      chatCount: payload.chats.length,
      messageCount: payload.messages.length,
      attachmentCount: payload.attachments.length,
      profileCount: payload.profiles.length,
      presetCount: payload.presets.length,
      promptPresetCount: payload.promptPresets.length,
      keyCount: payload.keys.length,
    },
  }
}

async function restorePreparedBrowserWorkspaceRows(
  db: NatterDb,
  prepared: PreparedBrowserWorkspaceBackup,
  now: number,
  preactivationCheckpoint: () => void,
  runTransaction: <T>(
    tables: readonly Table[],
    operation: (tx: Transaction) => Promise<T>,
  ) => Promise<T>,
  workspaceTables: readonly Table[],
): Promise<WorkspaceMeta> {
  const payload = prepared.envelope.payload
  const textTemplates = savedTextTemplatesFromStoredValue(
    payload.settings.find((row) => row.key === LEGACY_SAVED_TEXT_TEMPLATES_KEY)?.value,
  )
  const recordRestoredValues = (_values: readonly unknown[]) => undefined
  const restoreBulkPut = async <T>(table: Table<T, string>, rows: readonly T[]) => {
    for (const page of pages(rows)) {
      preactivationCheckpoint()
      await runTransaction([table], async (tx) => {
        await tx.table<T, string>(table.name).bulkPut(page)
        recordRestoredValues(page)
        recordTableWrite(page.length)
      })
    }
  }
  const beforeRestoreMeta = await runTransaction(
    [db.workspaceFence, db.streamLeases],
    async (tx) => {
      const workspace = await readBrowserWorkspaceMetaFromTransaction(tx)
      const activeStreamIds = await workspaceReplacementBlockersInTransaction(tx, now)
      if (activeStreamIds.length > 0) {
        throw new WorkspaceReplacementInProgressError(activeStreamIds)
      }
      return workspace
    },
  )
  preactivationCheckpoint()
  await runTransaction(workspaceTables, async (tx) => {
    for (const table of workspaceTables) {
      await tx.table(table.name).clear()
    }
  })
  await runTransaction([db.storageRetentionState, db.discoveryCacheState], async (tx) => {
    const retentionRows = [...freshStorageRetentionStateRows()]
    await tx
      .table<(typeof retentionRows)[number], string>('storageRetentionState')
      .bulkPut(retentionRows)
    recordRestoredValues(retentionRows)
    await seedEmptyDiscoveryCacheState(tx)
  })
  await restoreBulkPut(db.folders, payload.folders)
  await restoreBulkPut(db.tags, payload.tags)
  const profiles = payload.profiles.map((profile) => ({
    ...profile,
    requestRevision: profile.requestRevision ?? 0,
  }))
  const presets = payload.presets.map((preset) => ({
    ...preset,
    settings: structuredClone(preset.settings),
  }))
  const keys = payload.keys.map((key) => ({
    ...key,
    materialRevision: key.materialRevision ?? 0,
  }))
  await restoreBulkPut(db.profiles, profiles)
  await restoreBulkPut(
    db.configurationProfileCatalogRows,
    profiles.map(configurationProfileCatalogProjectionRow),
  )
  const promptPresetCounts: Record<PromptPresetKind, number> = {
    system: 0,
    append: 0,
    'continue-system': 0,
    'continue-user': 0,
    prefill: 0,
  }
  for (const promptPreset of payload.promptPresets) {
    promptPresetCounts[promptPreset.kind] += 1
  }
  const configurationAggregates = configurationCatalogMetadataRowsFromCounts({
    totalProfileCount: profiles.length,
    activeProfileCount: profiles.filter((profile) => profile.archived !== true).length,
    promptPresetCounts,
  })
  await restoreBulkPut(db.configurationCatalogAggregates, configurationAggregates)
  await restoreBulkPut(db.presets, presets)
  await buildPresetOrderOnEmptyTables(
    {
      states: db.presetOrderState,
      blocks: db.presetOrderBlocks,
      memberships: db.presetOrderMembership,
    },
    activePresetIdsInOrder(presets),
    runTransaction,
    preactivationCheckpoint,
  )
  await restoreBulkPut(
    db.configurationPresetCatalogRows,
    presets.map(configurationPresetCatalogProjectionRow),
  )
  await restoreBulkPut(db.promptPresets, payload.promptPresets)
  await restoreBulkPut(
    db.configurationPromptPresetCatalogRows,
    payload.promptPresets.map(configurationPromptPresetCatalogProjectionRow),
  )
  await restoreBulkPut(db.keys, keys)
  await restoreBulkPut(db.textTemplates, textTemplates)
  for (const page of pages(profiles)) {
    await restoreBulkPut(db.configurationLinks, page.flatMap(configurationLinksForProfile))
  }
  for (const page of pages(presets)) {
    await restoreBulkPut(db.configurationLinks, page.flatMap(configurationLinksForPreset))
  }
  for (const page of pages(payload.settings)) {
    const authoritative = page.filter((row) => isPortableWorkspaceSettingKey(row.key))
    await restoreBulkPut(db.settings, authoritative)
  }
  await restoreBulkPut(db.settings, [completedStreamJournalIntegritySetting()])
  const sidebarAggregates = createChatSidebarAggregateAccumulator()
  for (const page of pages(payload.chats)) {
    preactivationCheckpoint()
    const restored = page.map((chat) => ({
      ...chat,
      structuralVersion: chat.structuralVersion,
      configurationVersion: chat.configurationVersion ?? 0,
      previewText: prepared.previewTextByChatId.get(chat.id) ?? '',
    }))
    const projected = restored.map(chatSidebarProjectionRow)
    await runTransaction([db.chats, db.chatSidebarRows, db.configurationLinks], async (tx) => {
      await tx.table('chats').bulkPut(restored)
      await tx.table('chatSidebarRows').bulkPut(projected)
      await tx.table('configurationLinks').bulkPut(restored.flatMap(configurationLinksForChat))
      recordRestoredValues(restored)
      recordRestoredValues(projected)
      recordTableWrite(restored.length)
      recordTableWrite(restored.length)
    })
    accumulateChatSidebarAggregateRows(sidebarAggregates, projected)
  }
  await restoreBulkPut(
    db.configurationProfileUsageRows,
    configurationProfileUsageProjectionRows(presets, payload.chats),
  )
  await restoreBulkPut(
    db.chatSidebarAggregates,
    materializeChatSidebarAggregateRows(sidebarAggregates),
  )
  await restoreBulkPut(db.settings, chatSidebarProjectionSettings())
  await restoreBulkPut(db.attachmentCatalogAggregate, [emptyAttachmentCatalogAggregateRow()])
  for (const bundle of payload.attachments) {
    await storePortableAttachmentBundle(
      db,
      bundle,
      prepared.validatedBlobTypes,
      runTransaction,
      preactivationCheckpoint,
      recordRestoredValues,
    )
  }
  await storeMessagesInPages(
    db,
    payload.messages,
    now,
    preactivationCheckpoint,
    recordRestoredValues,
    runTransaction,
  )
  await restoreBulkPut(db.drafts, payload.drafts)
  for (const page of pages(payload.drafts)) {
    preactivationCheckpoint()
    await runTransaction(
      [
        db.attachmentRefEdges,
        db.attachments,
        db.attachmentCatalogRows,
        db.attachmentCatalogAggregate,
      ],
      (tx) =>
        applyAttachmentReferenceOwnerTransitions(
          tx,
          page.map((draft) => ({
            ownerKind: 'draft' as const,
            ownerId: draft.chatId,
            chatId: draft.chatId,
            previousRefs: undefined,
            nextRefs: draft.attachmentRefs,
          })),
          now,
        ).then(() => undefined),
    )
  }
  await runTransaction([db.chats, db.messages, db.childLists, db.childSlotMembers], (tx) =>
    rebuildChildSlotDerivedState(tx, {
      rebuiltAt: now,
      checkpoint: preactivationCheckpoint,
    }),
  )
  return runTransaction(
    [db.attachmentCatalogAggregate, db.attachmentIntegrityState, db.workspaceFence],
    async (tx) => {
      await markAttachmentIntegrityRepairComplete(tx)
      await markBrowserWorkspaceReplaced(tx, beforeRestoreMeta)
      preactivationCheckpoint()
      discardStorageCompactionDebt(tx)
      return readBrowserWorkspaceMetaFromTransaction(tx)
    },
  )
}

async function estimateBrowserWorkspaceLiveBytes(
  db: NatterDb,
  preactivationCheckpoint: () => void,
): Promise<number> {
  let total = 0
  for (const table of db.tables) {
    if (table.name === 'browserLocks') continue
    let batchRows = 0
    await table.each((row) => {
      if (batchRows === 0) preactivationCheckpoint()
      total = Math.min(Number.MAX_SAFE_INTEGER, total + estimateStoredValueBytes(row))
      batchRows += 1
      if (batchRows !== IMPORT_EXPORT_PAGE_SIZE) return
      recordTableRead(batchRows)
      batchRows = 0
    })
    if (batchRows > 0) recordTableRead(batchRows)
  }
  return total
}

export async function browserWorkspaceReplacementBlockers(
  db: NatterDb,
  now = Date.now(),
): Promise<string[]> {
  return db.transaction('r', [db.streamLeases, db.workspaceFence], (tx) =>
    workspaceReplacementBlockersInTransaction(tx, now),
  )
}

async function workspaceReplacementBlockersInTransaction(
  tx: Transaction,
  now: number,
): Promise<string[]> {
  const blockers = new Set<string>()
  const workspace = await readBrowserWorkspaceMetaFromTransaction(tx)
  await tx.table<StreamLeaseRow, string>('streamLeases').each((lease) => {
    const availability = reduceAttemptAvailability(undefined, {
      workspace,
      lease: { kind: 'present', lease },
      localAuthority: { kind: 'none' },
      ownershipLock: { kind: 'unsupported' },
      wallNow: now,
      schedulerNow: now,
    })
    if (availability.blocksReplacement) blockers.add(lease.streamId)
  })
  return [...blockers].sort()
}

function envelope(
  db: NatterDb,
  workspaceId: string,
  kind: 'chat',
  payload: PortableChatPayload,
): ChatExportEnvelope
function envelope(
  db: NatterDb,
  workspaceId: string,
  kind: 'chat-preset',
  payload: PortableChatPresetPayload,
): ChatPresetExportEnvelope
function envelope(
  db: NatterDb,
  workspaceId: string,
  kind: 'connection-profile',
  payload: PortableConnectionProfilePayload,
): ConnectionProfileExportEnvelope
function envelope(
  db: NatterDb,
  workspaceId: string,
  kind: 'workspace-backup',
  payload: WorkspaceBackupPayload,
): WorkspaceBackupEnvelope
function envelope(
  db: NatterDb,
  workspaceId: string,
  kind: NatterExportObjectKind,
  payload:
    | PortableChatPayload
    | PortableChatPresetPayload
    | PortableConnectionProfilePayload
    | WorkspaceBackupPayload,
): NatterExportEnvelope {
  return {
    objectKind: kind,
    exportSchemaVersion: NATTER_EXPORT_SCHEMA_VERSION,
    appStorageSchemaVersion: db.verno,
    createdAt: Date.now(),
    source: {
      app: 'natter',
      backendKind: 'browser-idb',
      workspaceId,
    },
    payload,
  } as NatterExportEnvelope
}

function portableConnectionHeaders(
  headers: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => {
      const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '')
      return !/(authorization|apikey|token|secret|password|credential|cookie)/.test(normalized)
    }),
  )
}

function connectionSketch(profile: ConnectionProfile): ConnectionSketch {
  return {
    sourceProfileId: profile.id,
    name: profile.name,
    kind: profile.kind,
    baseUrl: profile.baseUrl,
  }
}

function folderSketch(folder: ChatFolder): PortableFolderSketch {
  return {
    name: folder.name,
    ...(folder.color ? { color: folder.color } : {}),
  }
}

function tagSketch(tag: ChatTag): PortableTagSketch {
  return {
    name: tag.name,
    ...(tag.color ? { color: tag.color } : {}),
  }
}

async function resolveProfileId(
  profiles: Table<ConnectionProfile, ProfileId>,
  settings: ChatSettings,
  sketch: ConnectionSketch | undefined,
  options: {
    targetProfileId?: ProfileId | null | undefined
    missingProfileId?: ProfileId
  },
): Promise<ResolvedProfile> {
  if (typeof options.targetProfileId === 'string') {
    return {
      profileId: options.targetProfileId,
      matched: Boolean(await profiles.get(options.targetProfileId)),
    }
  }

  const sourceId = sketch?.sourceProfileId ?? settings.profileId
  if (options.targetProfileId === null) {
    return {
      profileId: sourceId || options.missingProfileId || `missing:${newId()}`,
      matched: false,
    }
  }

  if (sourceId && (await profiles.get(sourceId))) return { profileId: sourceId, matched: true }

  if (sketch) {
    const baseUrl = normalizeBaseUrl(sketch.baseUrl)
    const match = await profiles
      .where('kind')
      .equals(sketch.kind)
      .filter(
        (profile) => profile.archived !== true && normalizeBaseUrl(profile.baseUrl) === baseUrl,
      )
      .first()
    if (match) return { profileId: match.id, matched: true }
  }

  return {
    profileId: sourceId || options.missingProfileId || `missing:${newId()}`,
    matched: false,
  }
}

function importedProfileResolutionResourceNames(
  settings: ChatSettings,
  sketch: ConnectionSketch | undefined,
  targetProfileId: ProfileId | null | undefined,
  missingProfileId: ProfileId,
): readonly string[] {
  if (typeof targetProfileId === 'string') {
    return [`profile:${targetProfileId}`, `configuration-target:profile:${targetProfileId}`]
  }
  const sourceProfileId = sketch?.sourceProfileId ?? settings.profileId
  const fallbackProfileId = sourceProfileId || missingProfileId
  const resources = [
    `profile:${fallbackProfileId}`,
    `configuration-target:profile:${fallbackProfileId}`,
  ]
  if (targetProfileId !== null && sketch) {
    resources.push(
      `profile-match:${JSON.stringify([sketch.kind, normalizeBaseUrl(sketch.baseUrl)])}`,
    )
  }
  return resources
}

function* activePresetIdsInOrder(presets: readonly ChatPreset[]): Iterable<PresetId> {
  for (const preset of presets) {
    if (preset.archived !== true) yield preset.id
  }
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '')
}

function importNameKey(value: string): string {
  return value.trim().normalize('NFKC').toLowerCase()
}

function normalizedImportedSettings(settings: ChatSettings, profileId: ProfileId): ChatSettings {
  const next = flattenChatSettingsForPortableExport(settings)
  next.profileId = profileId
  return next
}

async function ensurePortableFolder(
  tx: Transaction,
  sketch: PortableFolderSketch | undefined,
  now: number,
  createdFolderId: FolderId | undefined,
): Promise<{ folderId: FolderId | undefined; created: boolean }> {
  if (!sketch) return { folderId: undefined, created: false }
  const name = sketch.name.trim()
  if (!name) return { folderId: undefined, created: false }
  const folders = tx.table<ChatFolder, FolderId>('folders')
  const existing = await folders.where('name').equalsIgnoreCase(name).first()
  if (existing) return { folderId: existing.id, created: false }
  const lastFolder = await folders.orderBy('sortIndex').last()
  const sortIndex = (lastFolder?.sortIndex ?? 0) + 1
  const folder: ChatFolder = {
    id: createdFolderId ?? newId(),
    name,
    ...(sketch.color ? { color: sketch.color } : {}),
    sortIndex,
    createdAt: now,
    updatedAt: now,
    lastUsedAt: now,
  }
  await putChatFolderByteOwner(tx, folder, undefined)
  return { folderId: folder.id, created: true }
}

function portableFolderCandidateId(sketch: PortableFolderSketch | undefined): FolderId | undefined {
  return sketch?.name.trim() ? newId() : undefined
}

async function ensurePortableTags(
  tx: Transaction,
  sketches: readonly PortableTagSketch[],
  now: number,
): Promise<{ tagIds: TagId[]; createdTagIds: TagId[] }> {
  const requestedNames = sketches
    .map((sketch) => sketch.name.trim())
    .filter(Boolean)
    .map(chatTagNameLower)
  if (requestedNames.length === 0) return { tagIds: [], createdTagIds: [] }
  const existing = await tx
    .table<ChatTag, TagId>('tags')
    .where('nameLower')
    .anyOf([...new Set(requestedNames)])
    .toArray()
  const byLower = new Map(existing.map((tag) => [tag.nameLower, tag]))
  const tagIds: TagId[] = []
  const createdTags: ChatTag[] = []
  for (const sketch of sketches) {
    const name = sketch.name.trim()
    if (!name) continue
    const nameLower = chatTagNameLower(name)
    const current = byLower.get(nameLower)
    if (current) {
      tagIds.push(current.id)
      continue
    }
    const tag: ChatTag = {
      id: newId(),
      name,
      nameLower,
      ...(sketch.color ? { color: sketch.color } : {}),
      createdAt: now,
      updatedAt: now,
      lastUsedAt: now,
    }
    byLower.set(nameLower, tag)
    tagIds.push(tag.id)
    createdTags.push(tag)
  }
  await putChatTagByteOwners(tx, createdTags, [])
  return { tagIds: [...new Set(tagIds)], createdTagIds: createdTags.map((tag) => tag.id) }
}

async function uniquePresetName(
  presets: Table<ConfigurationPresetCatalogProjectionRow, PresetId>,
  name: string,
): Promise<string> {
  const base = name.trim() || 'Imported preset'
  const existingOrdinals = new Set<number>()
  await presets.each((preset) => {
    const ordinal = importedNameOrdinal(preset.name, base)
    if (ordinal !== undefined) existingOrdinals.add(ordinal)
  })
  if (!existingOrdinals.has(1)) return base
  for (let i = 2; ; i += 1) {
    const candidate = `${base} (${i})`
    if (!existingOrdinals.has(i)) return candidate
  }
}

async function uniqueConnectionName(
  profiles: Table<ConnectionProfile, ProfileId>,
  name: string,
): Promise<string> {
  const base = name.trim() || 'Imported connection'
  if ((await profiles.where('name').equals(base).count()) === 0) return base
  for (let index = 2; ; index += 1) {
    const candidate = `${base} (${index})`
    if ((await profiles.where('name').equals(candidate).count()) === 0) return candidate
  }
}

function importedNameOrdinal(name: string, base: string): number | undefined {
  if (name === base) return 1
  if (!name.startsWith(`${base} (`) || !name.endsWith(')')) return undefined
  const ordinal = Number(name.slice(base.length + 2, -1))
  if (!Number.isSafeInteger(ordinal) || ordinal < 2) return undefined
  return name === `${base} (${ordinal})` ? ordinal : undefined
}

async function storedAttachmentBundles(
  db: NatterDb,
  ids: Iterable<AttachmentId>,
): Promise<StoredAttachmentBundle[]> {
  const bundles: StoredAttachmentBundle[] = []
  for (const id of [...new Set(ids)]) {
    const header = await db.attachments.get(id)
    if (!header) continue
    const artifacts = await readCollectionInPages(
      db.attachmentArtifacts.where('attachmentId').equals(id),
    )
    bundles.push({
      attachment: hydrateAttachment(header, artifacts),
      blobs: await readCollectionInPages(db.attachmentBlobs.where('attachmentId').equals(id)),
      artifacts,
      jobs: await readCollectionInPages(db.attachmentJobs.where('attachmentId').equals(id)),
    })
  }
  return bundles
}

async function portableAttachmentBundles(
  bundles: readonly StoredAttachmentBundle[],
): Promise<PortableAttachmentBundle[]> {
  const portable: PortableAttachmentBundle[] = []
  for (const bundle of bundles) {
    const blobs: PortableAttachmentBlob[] = []
    for (const blob of bundle.blobs) blobs.push(await portableBlob(blob))
    portable.push({
      attachment: structuredClone(bundle.attachment),
      blobs,
      artifacts: structuredClone(bundle.artifacts),
      jobs: structuredClone(bundle.jobs),
    })
  }
  return portable
}

async function consumePortableAttachmentBundles(
  bundles: StoredAttachmentBundle[],
): Promise<PortableAttachmentBundle[]> {
  const portable: PortableAttachmentBundle[] = []
  for (const bundle of bundles) {
    const blobs: PortableAttachmentBlob[] = []
    for (const blob of bundle.blobs) blobs.push(await portableBlob(blob))
    portable.push({
      attachment: bundle.attachment,
      blobs,
      artifacts: bundle.artifacts,
      jobs: bundle.jobs,
    })
    bundle.blobs.length = 0
  }
  return portable
}

async function hydrateStoredMessagesInPages(
  db: NatterDb,
  messageIds: readonly string[],
): Promise<Message[]> {
  const messages: Message[] = []
  for (const ids of pages(messageIds)) {
    const headers = (await db.messages.bulkGet(ids)).filter(
      (row): row is MessageHeaderRow => row !== undefined,
    )
    const bodies = (await db.messageBodies.bulkGet(headers.map((row) => row.id))).filter(
      (row): row is MessageBodyRow => row !== undefined,
    )
    recordMessageBodyRead(headers.length)
    recordTableRead(headers.length)
    recordTableRead(bodies.length)
    messages.push(...hydrateMessages(headers, bodies))
  }
  return messages
}

async function hydrateAllStoredMessagesInPages(db: NatterDb): Promise<Message[]> {
  const messages: Message[] = []
  for await (const headers of tablePages(db.messages)) {
    const bodies = (await db.messageBodies.bulkGet(headers.map((row) => row.id))).filter(
      (row): row is MessageBodyRow => row !== undefined,
    )
    recordMessageBodyRead(headers.length)
    recordTableRead(bodies.length)
    messages.push(...hydrateMessages(headers, bodies))
  }
  return messages
}

async function storeMessagesInPages(
  db: NatterDb,
  messages: readonly Message[],
  now: number,
  preactivationCheckpoint: () => void,
  recordStoredValues: (values: readonly unknown[]) => void,
  runTransaction: <T>(
    tables: readonly Table[],
    operation: (tx: Transaction) => Promise<T>,
  ) => Promise<T>,
): Promise<void> {
  for (const page of pages(messages)) {
    preactivationCheckpoint()
    const transitions = page.map((message) =>
      compileCurrentMessageTransition(message, {
        updatedAt: now,
        timestamp: 'exact',
        custody: { kind: 'available' },
      }),
    )
    const headers = transitions.map((transition) => transition.storage.header)
    const bodies = transitions.map((transition) => transition.storage.body)
    const previews = transitions.map((transition) => transition.storage.preview)
    await runTransaction(
      [
        db.messages,
        db.messageBodies,
        db.messagePreviews,
        db.attachmentRefEdges,
        db.attachments,
        db.attachmentCatalogRows,
        db.attachmentCatalogAggregate,
      ],
      async (tx) => {
        await tx.table('messages').bulkPut(headers)
        await tx.table('messageBodies').bulkPut(bodies)
        await tx.table('messagePreviews').bulkPut(previews)
        await applyAttachmentReferenceOwnerTransitions(
          tx,
          transitions.map((transition) => transition.attachmentOwner),
          now,
        )
      },
    )
    recordStoredValues(headers)
    recordStoredValues(bodies)
    recordStoredValues(previews)
    recordTableWrite(transitions.length)
    recordTableWrite(transitions.length)
    recordTableWrite(transitions.length)
  }
}

async function storeNewMessageTransitionsInPages(
  tx: Transaction,
  transitions: readonly CurrentMessageTransition[],
): Promise<void> {
  const headers = tx.table<MessageHeaderRow, MessageId>('messages')
  const bodies = tx.table<MessageBodyRow, MessageId>('messageBodies')
  const previews = tx.table('messagePreviews')
  for (const page of pages(transitions)) {
    await headers.bulkAdd(page.map((transition) => transition.storage.header))
    await bodies.bulkAdd(page.map((transition) => transition.storage.body))
    await previews.bulkAdd(page.map((transition) => transition.storage.preview))
    recordTableWrite(page.length)
    recordTableWrite(page.length)
    recordTableWrite(page.length)
  }
}

async function replaceMessageAttachmentReferenceOwnersInPages(
  tx: Parameters<typeof applyAttachmentReferenceOwnerTransitions>[0],
  transitions: readonly CurrentMessageTransition[],
  now: number,
): Promise<void> {
  for (const page of pages(transitions)) {
    await applyAttachmentReferenceOwnerTransitions(
      tx,
      page.map((transition) => transition.attachmentOwner),
      now,
    )
  }
}

function* pages<T>(rows: readonly T[]): Generator<T[]> {
  for (let index = 0; index < rows.length; index += IMPORT_EXPORT_PAGE_SIZE) {
    yield rows.slice(index, index + IMPORT_EXPORT_PAGE_SIZE)
  }
}

async function readTableInPages<T>(table: Table<T, string>): Promise<T[]> {
  const rows: T[] = []
  for await (const page of tablePages(table)) rows.push(...page)
  return rows
}

async function* tablePages<T>(table: Table<T, string>): AsyncGenerator<T[]> {
  let after: string | undefined
  for (;;) {
    const page: T[] = []
    let lastPrimaryKey: string | undefined
    const collection = after === undefined ? table.orderBy(':id') : table.where(':id').above(after)
    await collection.limit(IMPORT_EXPORT_PAGE_SIZE).each((row, cursor) => {
      if (typeof cursor.primaryKey !== 'string') {
        throw new Error(`ImportExportPrimaryKeyInvalid:${table.name}`)
      }
      page.push(row)
      lastPrimaryKey = cursor.primaryKey
    })
    if (page.length === 0) return
    recordTableRead(page.length)
    yield page
    if (page.length < IMPORT_EXPORT_PAGE_SIZE) return
    if (lastPrimaryKey === undefined) throw new Error(`ImportExportPrimaryKeyMissing:${table.name}`)
    after = lastPrimaryKey
  }
}

async function readCollectionInPages<T>(collection: Collection<T, string>): Promise<T[]> {
  const rows: T[] = []
  let batchRows = 0
  await collection.clone().each((row) => {
    rows.push(row)
    batchRows += 1
    if (batchRows !== IMPORT_EXPORT_PAGE_SIZE) return
    recordTableRead(batchRows)
    batchRows = 0
  })
  if (batchRows > 0) recordTableRead(batchRows)
  return rows
}

async function bulkAddInPages<T>(table: Table<T, string>, rows: readonly T[]): Promise<void> {
  for (const page of pages(rows)) {
    await table.bulkAdd(page)
    recordTableWrite(page.length)
  }
}

function emptyMaterializationMetrics(): ImportExportMaterializationMetrics {
  return {
    tableReadBatches: 0,
    tableReadRows: 0,
    maxTableReadBatchRows: 0,
    tableWriteBatches: 0,
    tableWriteRows: 0,
    maxTableWriteBatchRows: 0,
    messageBodyReadBatches: 0,
    maxMessageBodyReadBatchRows: 0,
    attachmentBlobReadBytes: 0,
    maxAttachmentBlobReadBytes: 0,
    attachmentBlobDecodeBytes: 0,
    maxAttachmentBlobDecodeBytes: 0,
  }
}

function recordTableRead(rows: number): void {
  materializationMetrics.tableReadBatches += 1
  materializationMetrics.tableReadRows += rows
  materializationMetrics.maxTableReadBatchRows = Math.max(
    materializationMetrics.maxTableReadBatchRows,
    rows,
  )
}

function recordTableWrite(rows: number): void {
  materializationMetrics.tableWriteBatches += 1
  materializationMetrics.tableWriteRows += rows
  materializationMetrics.maxTableWriteBatchRows = Math.max(
    materializationMetrics.maxTableWriteBatchRows,
    rows,
  )
}

function recordMessageBodyRead(rows: number): void {
  materializationMetrics.messageBodyReadBatches += 1
  materializationMetrics.maxMessageBodyReadBatchRows = Math.max(
    materializationMetrics.maxMessageBodyReadBatchRows,
    rows,
  )
}

async function portableBlob(blob: AttachmentBlob): Promise<PortableAttachmentBlob> {
  const bytes = await blobBytes(blob.blob)
  materializationMetrics.attachmentBlobReadBytes += bytes.byteLength
  materializationMetrics.maxAttachmentBlobReadBytes = Math.max(
    materializationMetrics.maxAttachmentBlobReadBytes,
    bytes.byteLength,
  )
  if (bytes.byteLength !== blob.sizeBytes) {
    throw new Error(`ExportAttachmentBlobSizeMismatch:${blob.id}`)
  }
  const contentHash = await sha256BytesHex(bytes)
  if (contentHash !== blob.contentHash) {
    throw new Error(`ExportAttachmentBlobHashMismatch:${blob.id}`)
  }
  return {
    id: blob.id,
    attachmentId: blob.attachmentId,
    role: blob.role,
    mime: blob.mime,
    contentHash,
    sizeBytes: bytes.byteLength,
    dataBase64: bytesToBase64(bytes),
    createdAt: blob.createdAt,
  }
}

async function prepareImportedAttachments(
  bundles: readonly PortableAttachmentBundle[],
  now: number,
): Promise<PreparedImportedAttachmentBundle[]> {
  const prepared: PreparedImportedAttachmentBundle[] = []
  for (const bundle of bundles) {
    const stored = await validatedAttachmentBundleFromPortableWithNewIds(bundle, now)
    prepared.push({
      sourceAttachmentId: bundle.attachment.id,
      bundle: stored,
    })
  }
  return prepared
}

async function findExistingAttachment(
  attachments: Table<AttachmentHeaderRow, AttachmentId>,
  source: Attachment,
): Promise<AttachmentHeaderRow | undefined> {
  if (!source.contentHash) return undefined
  return attachments
    .where('contentHash')
    .equals(source.contentHash)
    .filter(
      (attachment) =>
        attachment.filename === source.filename &&
        attachment.deletedAt === undefined &&
        attachment.storage.kind !== 'missing',
    )
    .first()
}

async function validatePortableAttachmentBundles(
  bundles: readonly PortableAttachmentBundle[],
): Promise<ReadonlyMap<PortableAttachmentBlob, string>> {
  const blobTypes = new Map<PortableAttachmentBlob, string>()
  for (const bundle of bundles) {
    for (const blob of bundle.blobs) {
      blobTypes.set(blob, await validatePortableBlob(blob))
    }
    verifyPortableBundleIntegrity(bundle.attachment, bundle.blobs)
  }
  return blobTypes
}

async function validatedAttachmentBundleFromPortableWithNewIds(
  bundle: PortableAttachmentBundle,
  now: number,
): Promise<ValidatedAttachmentBundle> {
  const source = {
    attachment: structuredClone(bundle.attachment),
    blobs: bundle.blobs.map((blob) => ({ ...blob })),
    artifacts: structuredClone(bundle.artifacts),
    jobs: structuredClone(bundle.jobs),
  }
  const targetAttachmentId = newId()
  const blobIdMap = new Map<string, string>()
  const artifactIdMap = new Map<string, string>()
  const blobs = await validatePortableBlobs(
    source.blobs.map((blob) => {
      const targetBlobId = newId()
      blobIdMap.set(blob.id, targetBlobId)
      return { ...blob, id: targetBlobId, attachmentId: targetAttachmentId }
    }),
  )
  for (const artifact of source.artifacts) artifactIdMap.set(artifact.artifactId, newId())

  let attachment: Attachment = rewriteAttachmentForImport(
    source.attachment,
    targetAttachmentId,
    blobIdMap,
    artifactIdMap,
    now,
  )
  const artifacts = source.artifacts.map((artifact) =>
    rewriteArtifactForImport(artifact, targetAttachmentId, blobIdMap, artifactIdMap),
  )
  const jobs = source.jobs.map((job) =>
    rewriteJobForImport(
      job,
      targetAttachmentId,
      artifactIdMap,
      source.attachment.storage.kind === 'remote-url',
      now,
    ),
  )
  const localizationJob = jobs.find(isGeneratedOutputLocalizationJob)
  if (localizationJob) {
    attachment = {
      ...attachment,
      processing: withGeneratedOutputLocalizationState(attachment.processing, localizationJob),
    }
  }
  verifyPortableBundleIntegrity(attachment, blobs)
  return { attachment, blobs, artifacts, jobs }
}

async function validatePortableBlobs(
  blobs: readonly PortableAttachmentBlob[],
): Promise<ValidatedPortableAttachmentBlob[]> {
  const validated: ValidatedPortableAttachmentBlob[] = []
  for (const blob of blobs) {
    validated.push({ ...blob, blobType: await validatePortableBlob(blob) })
  }
  return validated
}

async function validatePortableBlob(blob: PortableAttachmentBlob): Promise<string> {
  const bytes = base64ToBytes(blob.dataBase64)
  const computedHash = await sha256BytesHex(bytes)
  if (computedHash !== blob.contentHash) {
    throw new Error(`ImportAttachmentBlobHashMismatch:${blob.id}`)
  }
  if (bytes.byteLength !== blob.sizeBytes) {
    throw new Error(`ImportAttachmentBlobSizeMismatch:${blob.id}`)
  }
  return (await makeBlob(new Uint8Array(0), blob.mime)).type
}

function materializeValidatedBlob(blob: ValidatedPortableAttachmentBlob): AttachmentBlob {
  return materializePortableBlob(blob, blob.blobType)
}

function materializePortableBlob(blob: PortableAttachmentBlob, blobType: string): AttachmentBlob {
  const bytes = base64ToBytes(blob.dataBase64)
  return {
    id: blob.id,
    attachmentId: blob.attachmentId,
    role: blob.role,
    mime: blob.mime,
    contentHash: blob.contentHash,
    sizeBytes: blob.sizeBytes,
    blob: makeStoredBlob(bytes, blobType),
    createdAt: blob.createdAt,
  }
}

async function storeValidatedAttachmentBundle(
  tx: Transaction,
  bundle: ValidatedAttachmentBundle,
): Promise<void> {
  const header = splitAttachmentForStorage({ ...bundle.attachment, refCount: 0 })
  await putAttachmentHeaderByteOwner(tx, header, undefined)
  await putAttachmentCatalogProjectionFromHeader(tx, header, undefined)
  recordBrowserCommandAttachmentReferenceState(tx, {
    attachmentId: header.id,
    initial: { exists: false, refCount: 0 },
    final: { exists: true, refCount: 0 },
    projectionChanged: true,
  })
  recordTableWrite(1)
  recordTableWrite(1)
  recordTableWrite(1)
  const blobs = bundle.blobs.map(materializeValidatedBlob)
  await addAttachmentBlobByteOwners(tx, blobs)
  await addAttachmentArtifactByteOwners(tx, bundle.artifacts)
  await addAttachmentJobByteOwners(tx, bundle.jobs)
  if (blobs.length > 0) recordTableWrite(blobs.length)
  if (bundle.artifacts.length > 0) recordTableWrite(bundle.artifacts.length)
  if (bundle.jobs.length > 0) recordTableWrite(bundle.jobs.length)
}

async function storePortableAttachmentBundle(
  db: NatterDb,
  bundle: PortableAttachmentBundle,
  blobTypes: ReadonlyMap<PortableAttachmentBlob, string>,
  runTransaction: <T>(
    tables: readonly Table[],
    operation: (tx: Transaction) => Promise<T>,
  ) => Promise<T>,
  preactivationCheckpoint: () => void = () => undefined,
  recordStoredValues: (values: readonly unknown[]) => void = () => undefined,
): Promise<void> {
  const header = splitAttachmentForStorage({ ...bundle.attachment, refCount: 0 })
  preactivationCheckpoint()
  await runTransaction(
    [db.attachments, db.attachmentCatalogRows, db.attachmentCatalogAggregate],
    async (tx) => {
      await tx.table<AttachmentHeaderRow, string>('attachments').put(header)
      recordStoredValues([header])
      await putAttachmentCatalogProjectionFromHeader(tx, header, undefined)
      recordBrowserCommandAttachmentReferenceState(tx, {
        attachmentId: header.id,
        initial: { exists: false, refCount: 0 },
        final: { exists: true, refCount: 0 },
        projectionChanged: true,
      })
      recordTableWrite(1)
      recordTableWrite(1)
      recordTableWrite(1)
    },
  )
  for (const page of pages(bundle.blobs)) {
    preactivationCheckpoint()
    const stored = page.map((blob) => {
      const blobType = blobTypes.get(blob)
      if (blobType === undefined)
        throw new Error(`ImportAttachmentBlobValidationMissing:${blob.id}`)
      return materializePortableBlob(blob, blobType)
    })
    await runTransaction([db.attachmentBlobs], async (tx) => {
      await tx.table('attachmentBlobs').bulkPut(stored)
      recordStoredValues(stored)
      recordTableWrite(stored.length)
    })
  }
  for (const page of pages(bundle.artifacts)) {
    preactivationCheckpoint()
    await runTransaction([db.attachmentArtifacts], async (tx) => {
      await tx.table('attachmentArtifacts').bulkPut(page)
      recordStoredValues(page)
      recordTableWrite(page.length)
    })
  }
  for (const page of pages(bundle.jobs)) {
    preactivationCheckpoint()
    await runTransaction([db.attachmentJobs], async (tx) => {
      await tx.table('attachmentJobs').bulkPut(page)
      recordStoredValues(page)
      recordTableWrite(page.length)
    })
  }
}

function verifyPortableBundleIntegrity(
  attachment: Attachment,
  blobs: readonly Pick<AttachmentBlob, 'contentHash' | 'id' | 'role'>[],
): void {
  if (!attachment.contentHash) return
  const originalBlobId =
    attachment.storage.kind === 'local-blob'
      ? attachment.storage.blobId
      : blobs.find((blob) => blob.role === 'original')?.id
  const original = originalBlobId ? blobs.find((blob) => blob.id === originalBlobId) : undefined
  if (original && original.contentHash !== attachment.contentHash) {
    throw new Error(`ImportAttachmentHashMismatch:${attachment.id}`)
  }
}

function rewriteAttachmentForImport(
  source: Attachment,
  targetAttachmentId: AttachmentId,
  blobIdMap: ReadonlyMap<string, string>,
  artifactIdMap: ReadonlyMap<string, string>,
  now: number,
): Attachment {
  const attachment = structuredClone(source)
  attachment.id = targetAttachmentId
  attachment.origin = source.origin === 'generated-output' ? 'generated-output' : 'import'
  attachment.refCount = 0
  attachment.artifacts = source.artifacts.map((artifact) =>
    rewriteArtifactForImport(artifact, targetAttachmentId, blobIdMap, artifactIdMap),
  )
  attachment.processing = source.processing.map((state) => ({
    ...structuredClone(state),
    outputArtifactIds: state.outputArtifactIds.map((id) => artifactIdMap.get(id) ?? id),
  }))
  if (attachment.storage.kind === 'local-blob') {
    const blobId = blobIdMap.get(attachment.storage.blobId)
    if (!blobId) {
      attachment.storage = {
        kind: 'missing',
        reason: 'import-missing',
        missingSince: now,
        lastKnownBlobId: attachment.storage.blobId,
      }
    } else {
      attachment.storage = { kind: 'local-blob', blobId }
    }
  }
  if (attachment.thumbnailBlobId) {
    const mapped = blobIdMap.get(attachment.thumbnailBlobId)
    if (mapped) attachment.thumbnailBlobId = mapped
    else delete attachment.thumbnailBlobId
  }
  return attachment
}

function rewriteArtifactForImport(
  artifact: AttachmentArtifact,
  attachmentId: AttachmentId,
  blobIdMap: ReadonlyMap<string, string>,
  artifactIdMap: ReadonlyMap<string, string>,
): AttachmentArtifact {
  const next = structuredClone(artifact)
  next.artifactId = artifactIdMap.get(artifact.artifactId) ?? artifact.artifactId
  next.attachmentId = attachmentId
  if (next.kind === 'blob') next.blobId = blobIdMap.get(next.blobId) ?? next.blobId
  return next
}

function rewriteJobForImport(
  job: AttachmentJob,
  attachmentId: AttachmentId,
  artifactIdMap: ReadonlyMap<string, string>,
  remoteGeneratedOutputLocalization: boolean,
  now: number,
): AttachmentJob {
  const rewritten: AttachmentJob = {
    ...structuredClone(job),
    id: newId(),
    attachmentId,
    outputArtifactIds: job.outputArtifactIds.map((id) => artifactIdMap.get(id) ?? id),
  }
  if (!isGeneratedOutputLocalizationJob(job)) return rewritten
  rewritten.status = remoteGeneratedOutputLocalization ? 'pending' : 'succeeded'
  if (remoteGeneratedOutputLocalization) rewritten.attemptCount = 0
  rewritten.updatedAt = now
  if (remoteGeneratedOutputLocalization) rewritten.nextAttemptAt = now
  else delete rewritten.nextAttemptAt
  delete rewritten.startedAt
  if (remoteGeneratedOutputLocalization) delete rewritten.finishedAt
  else rewritten.finishedAt = now
  delete rewritten.error
  delete rewritten.leaseId
  delete rewritten.leaseExpiresAt
  return rewritten
}

function collectAttachmentIds(messages: readonly Message[]): AttachmentId[] {
  const ids: AttachmentId[] = []
  for (const message of messages) {
    for (const ref of message.attachmentRefs ?? []) ids.push(ref.attachmentId)
    for (const item of message.content) {
      const id = contentAttachmentId(item)
      if (id) ids.push(id)
    }
  }
  return ids
}

function collectWorkspaceAttachmentIds(
  messages: readonly Message[],
  drafts: readonly { readonly attachmentRefs: readonly MessageAttachmentRef[] }[],
): AttachmentId[] {
  const ids = new Set(collectAttachmentIds(messages))
  for (const draft of drafts) {
    for (const ref of draft.attachmentRefs) ids.add(ref.attachmentId)
  }
  return [...ids]
}

function contentAttachmentId(item: ContentItem): AttachmentId | undefined {
  switch (item.type) {
    case 'image_url':
    case 'input_audio':
    case 'file':
    case 'video_url':
    case 'output_image':
    case 'audio_output':
    case 'output_video':
      return item.attachmentId
    case 'text':
    case 'output_text':
      return undefined
  }
}

function remapImportedMessage(
  message: Message,
  maps: {
    chatId: Chat['id']
    messageIdMap: Record<string, string>
    turnIdMap: Map<string, string>
    attachmentIdMap: Record<string, string>
  },
): Message {
  const id = maps.messageIdMap[message.id]
  if (!id) throw new Error(`ImportMessageIdMissing:${message.id}`)
  let parentId: MessageId | null = null
  if (message.parentId !== null) {
    const mappedParentId = maps.messageIdMap[message.parentId]
    if (!mappedParentId) throw new Error(`ImportParentMissing:${message.id}`)
    parentId = mappedParentId
  }
  let turnId = maps.turnIdMap.get(message.turnId)
  if (!turnId) {
    turnId = newId()
    maps.turnIdMap.set(message.turnId, turnId)
  }
  const next: Message = {
    ...structuredClone(message),
    id,
    chatId: maps.chatId,
    parentId,
    turnId,
    nodeVersion: 0,
  }
  next.content = message.content.map((item) => remapContentAttachmentId(item, maps.attachmentIdMap))
  if (message.attachmentRefs) {
    next.attachmentRefs = message.attachmentRefs.map((ref) =>
      remapAttachmentRef(ref, maps.attachmentIdMap),
    )
  }
  return next
}

function remapContentAttachmentId(
  item: ContentItem,
  attachmentIdMap: Record<string, string>,
): ContentItem {
  const next = structuredClone(item)
  const id = contentAttachmentId(next)
  if (!id) return next
  const mapped = attachmentIdMap[id]
  if (!mapped) return next
  switch (next.type) {
    case 'image_url':
    case 'input_audio':
    case 'file':
    case 'video_url':
    case 'output_image':
    case 'audio_output':
    case 'output_video':
      next.attachmentId = mapped
      break
    case 'text':
    case 'output_text':
      break
  }
  return next
}

function remapAttachmentRef(
  ref: MessageAttachmentRef,
  attachmentIdMap: Record<string, string>,
): MessageAttachmentRef {
  return {
    ...structuredClone(ref),
    refId: newId(),
    attachmentId: attachmentIdMap[ref.attachmentId] ?? ref.attachmentId,
  }
}

function sortMessages(messages: Message[]): Message[] {
  return messages.sort((left, right) => {
    if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt
    if (left.turnIndex !== right.turnIndex) return left.turnIndex - right.turnIndex
    if (left.siblingIndex !== right.siblingIndex) return left.siblingIndex - right.siblingIndex
    return left.id.localeCompare(right.id)
  })
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  materializationMetrics.attachmentBlobDecodeBytes += bytes.byteLength
  materializationMetrics.maxAttachmentBlobDecodeBytes = Math.max(
    materializationMetrics.maxAttachmentBlobDecodeBytes,
    bytes.byteLength,
  )
  return bytes
}

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  const withArrayBuffer = blob as Blob & { arrayBuffer?: () => Promise<ArrayBuffer> }
  if (typeof withArrayBuffer.arrayBuffer === 'function') {
    return new Uint8Array(await withArrayBuffer.arrayBuffer())
  }
  if (typeof FileReader !== 'undefined') {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onerror = () => reject(reader.error ?? new Error('BlobReadFailed'))
      reader.onload = () => {
        if (!(reader.result instanceof ArrayBuffer)) {
          reject(new Error('BlobReadFailed'))
          return
        }
        resolve(new Uint8Array(reader.result))
      }
      reader.readAsArrayBuffer(blob)
    })
  }
  throw new Error('BlobReadUnsupported')
}

async function makeBlob(bytes: Uint8Array, mime: string): Promise<Blob> {
  const blobBuffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(blobBuffer).set(bytes)
  if (typeof Response === 'function') {
    const init: ResponseInit = mime ? { headers: { 'content-type': mime } } : {}
    return new Response(blobBuffer, init).blob()
  }
  return new Blob([blobBuffer], { type: mime })
}

function makeStoredBlob(bytes: Uint8Array, mime: string): Blob {
  const blobBuffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(blobBuffer).set(bytes)
  return new Blob([blobBuffer], { type: mime })
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined
}
