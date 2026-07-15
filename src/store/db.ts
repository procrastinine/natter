// The module exports a single default-name singleton for production. Tests that
// need isolation use `createDbForTests(name)` to mint a uniquely-named instance
// and close it when they're done.

import Dexie, { type Table } from 'dexie'
import { migrateAttachmentHeaderProjection } from '../backcompat/attachment-header-projection'
import {
  rebuildAttachmentReferenceEdges,
  scrubMissingAttachmentByteReferences,
} from '../backcompat/attachment-reference-edges'
import {
  attachmentRefsBackfillMarker,
  migrateAttachmentRefRows,
  migrateLegacyAttachmentStorage,
  normalizeAttachmentRefOwners,
} from '../backcompat/attachment-refs'
import { BACKCOMPAT_BATCH_SIZE, forEachTableBatch } from '../backcompat/batched-table'
import { migrateBrowserWriterLock } from '../backcompat/browser-writer-lock'
import {
  backfillChatPreviewProjection,
  chatPreviewProjectionBackfillMarker,
  migrateChatPreviewProjection,
} from '../backcompat/chat-preview-projection'
import { migrateCurrentChatSettingsSnapshot } from '../backcompat/chat-settings'
import { migrateChatSidebarProjection } from '../backcompat/chat-sidebar-projection'
import { migrateLegacyChildLists } from '../backcompat/child-lists'
import { migrateGenerationAttemptOutcomes } from '../backcompat/generation-attempt-outcomes'
import {
  globalSettingsBackfillMarker,
  migrateGlobalSettingsRows,
} from '../backcompat/global-settings'
import {
  backfillMissingMessageBodies,
  messageBodySplitBackfillMarker,
  migrateInlineMessageBodies,
} from '../backcompat/message-body-split'
import { migrateMessageBodyVersions } from '../backcompat/message-body-version'
import { migrateMessageHeaderProjections } from '../backcompat/message-header-projections'
import { migrateMessageRequestContextVersions } from '../backcompat/message-request-context-version'
import {
  migrateLegacyPresetSortOrder,
  PRESET_SORT_MIGRATION_INDEX,
} from '../backcompat/preset-sort-order'
import { migrateProviderApiModeTables } from '../backcompat/provider-api-modes'
import {
  migrateProviderOutputItemRows,
  migrateProviderOutputItemRowsInTables,
  providerOutputItemsBackfillMarker,
} from '../backcompat/provider-output-items'
import { migrateProviderSettingsTables } from '../backcompat/provider-settings-migration'
import {
  migrateProviderToolSettings,
  migrateProviderToolSettingsRows,
  providerToolSettingsBackfillMarker,
} from '../backcompat/provider-tools'
import { migrateStreamLeaseAttempts } from '../backcompat/stream-lease-attempts'
import {
  canonicalizeTokenCalibrationRows,
  rebuildTokenCalibrationGlobalRows,
  tokenCalibrationCanonicalizeBackfillMarker,
  tokenCalibrationGlobalBackfillMarker,
} from '../backcompat/token-calibration-global'
import { migrateWorkspaceReplacementEpoch } from '../backcompat/workspace-meta'
import { findLastUpdatedLeafId } from '../core/active-path'
import { buildBranchMessages } from '../core/branch-flatten'
import {
  DEFAULT_CONTINUE_SYSTEM_PROMPT,
  DEFAULT_CONTINUE_USER_PROMPT,
} from '../core/continue-prompts'
import {
  normalizeRenderingPreferences,
  RENDERING_PREFERENCES_KEY,
} from '../core/rendering-preferences'
import type {
  Attachment,
  AttachmentArtifact,
  AttachmentBlob,
  AttachmentJob,
  AttachmentReferenceEdge,
  Chat,
  ChatBranchCache,
  ChatFolder,
  ChatPreset,
  ChatTag,
  ChildListState,
  ConnectionProfile,
  DraftRow,
  KeyRecord,
  Message,
  PresetResolution,
  PromptPreset,
} from '../core/types'
import { countMessagesWords } from '../core/word-count'
import { configureBroadcastFallbackReader } from './broadcast'
import { type BrowserLockRow, emptyBrowserWriterLockRow } from './browser-lock-record'
import {
  CHAT_SIDEBAR_PROJECTION_BACKFILL_KEY,
  CHAT_SIDEBAR_PROJECTION_MANIFEST_KEY,
  type ChatSidebarProjectionRow,
  chatSidebarProjectionSettings,
  isValidChatSidebarProjectionManifest,
  putChatSidebarProjection,
  rebuildChatSidebarProjection,
} from './chat-sidebar-projection'
import type {
  CachedEndpointsRow,
  CachedModelsRow,
  CachedPrivacyPolicyRow,
  CachedProvidersRow,
  SettingsRow,
} from './db-rows'
import { configureLockDatabaseOpener } from './locks'
import {
  hydrateMessages,
  type MessageBodyRow,
  type MessageHeaderRow,
  previewTextFromContent,
} from './message-storage'
import type { StreamChunkRow, StreamLeaseRow } from './repository'
import { readBrowserWorkspaceMeta } from './workspace-meta'

export type {
  CachedEndpointsRow,
  CachedModelsRow,
  CachedPrivacyPolicyRow,
  CachedProvidersRow,
  SettingsRow,
} from './db-rows'

interface CachedGenerationRow {
  id: string
  chatId: string
  gen_id: string
  fetchedAt: number
  payload: unknown
}

export class NatterDb extends Dexie {
  chats!: Table<Chat, string>
  chatSidebarRows!: Table<ChatSidebarProjectionRow, string>
  messages!: Table<MessageHeaderRow, string>
  messageBodies!: Table<MessageBodyRow, string>
  childLists!: Table<ChildListState, string>
  attachments!: Table<Attachment, string>
  attachmentBlobs!: Table<AttachmentBlob, string>
  attachmentArtifacts!: Table<AttachmentArtifact, string>
  attachmentJobs!: Table<AttachmentJob, string>
  attachmentRefEdges!: Table<
    AttachmentReferenceEdge,
    [AttachmentReferenceEdge['ownerKind'], string, string]
  >
  profiles!: Table<ConnectionProfile, string>
  presets!: Table<ChatPreset, string>
  promptPresets!: Table<PromptPreset, string>
  folders!: Table<ChatFolder, string>
  tags!: Table<ChatTag, string>
  chatBranchCache!: Table<ChatBranchCache, string>
  keys!: Table<KeyRecord, string>
  settings!: Table<SettingsRow, string>
  browserLocks!: Table<BrowserLockRow, string>
  streamLeases!: Table<StreamLeaseRow, string>
  streamChunks!: Table<StreamChunkRow, string>
  models!: Table<CachedModelsRow, [string, string]>
  endpoints!: Table<CachedEndpointsRow, [string, string]>
  privacyPolicies!: Table<CachedPrivacyPolicyRow, [string, string]>
  providers!: Table<CachedProvidersRow, string>
  generations!: Table<CachedGenerationRow, string>
  presetResolutions!: Table<PresetResolution, [string, string]>
  drafts!: Table<DraftRow, string>

  constructor(name = 'natter') {
    super(name)
    registerSchema(this)
  }
}

// Schema registration is pulled out so test-only subclasses can replay v1 and
// then tack on synthetic v2/v3 upgrades.
export function registerSchema(db: Dexie): void {
  db.on('populate', (tx) => {
    void tx
      .table<SettingsRow>('settings')
      .bulkPut([
        attachmentRefsBackfillMarker(),
        messageBodySplitBackfillMarker(),
        organizationFieldsBackfillMarker(),
        chatPreviewProjectionBackfillMarker(),
        globalSettingsBackfillMarker(),
        providerOutputItemsBackfillMarker(),
        providerToolSettingsBackfillMarker(),
        tokenCalibrationGlobalBackfillMarker(),
        tokenCalibrationCanonicalizeBackfillMarker(),
        ...chatSidebarProjectionSettings(0),
      ])
    void tx.table<BrowserLockRow>('browserLocks').put(emptyBrowserWriterLockRow())
  })

  db.version(1).stores({
    chats:
      'id, updatedAt, createdAt, lastViewedAt, lastUpdatedLeafId, lastBranchUpdatedAt, wordCount, totalCostUsd, archived, pinned, presetId, folderId, *tags',
    messages:
      'id, chatId, parentId, turnId, [chatId+parentId], [chatId+createdAt], [chatId+turnId], [chatId+deleted]',
    attachments: 'id, contentHash, refCount, createdAt',
    profiles: 'id, name, kind, lastUsedAt, archived',
    presets: 'id, name, connectionProfileId, lastUsedAt, archived',
    folders: 'id, name, sortIndex, lastUsedAt',
    tags: 'id, &nameLower, lastUsedAt',
    chatBranchCache: '&chatId, branchLeafId, generatedAt',
    keys: 'id, name',
    settings: '&key',
    models: '&[profileId+queryKey], fetchedAt',
    endpoints: '&[profileId+modelId], fetchedAt',
    privacyPolicies: '&[profileId+modelId], fetchedAt',
    providers: '&profileId, fetchedAt',
    generations: 'id, chatId, gen_id',
    presetResolutions: '&[profileId+presetSlug], fetchedAt',
    drafts: '&chatId, updatedAt',
  })

  interface LegacyChatV1 extends Omit<Chat, 'metaVersion' | 'summaryVersion'> {
    version?: number
  }

  interface LegacyMessageV1 extends Omit<Message, 'nodeVersion'> {
    nodeVersion?: number
  }

  db.version(2)
    .stores({
      chats:
        'id, updatedAt, createdAt, lastViewedAt, lastUpdatedLeafId, lastBranchUpdatedAt, wordCount, totalCostUsd, archived, pinned, presetId, folderId, *tags',
      messages:
        'id, chatId, parentId, turnId, [chatId+parentId], [chatId+createdAt], [chatId+turnId], [chatId+deleted]',
      childLists: 'id, [chatId+parentId], updatedAt',
      attachments: 'id, contentHash, refCount, createdAt',
      profiles: 'id, name, kind, lastUsedAt, archived',
      presets: 'id, name, connectionProfileId, lastUsedAt, archived',
      folders: 'id, name, sortIndex, lastUsedAt',
      tags: 'id, &nameLower, lastUsedAt',
      chatBranchCache: '&chatId, branchLeafId, generatedAt',
      keys: 'id, name',
      settings: '&key',
      models: '&[profileId+queryKey], fetchedAt',
      endpoints: '&[profileId+modelId], fetchedAt',
      privacyPolicies: '&[profileId+modelId], fetchedAt',
      providers: '&profileId, fetchedAt',
      generations: 'id, chatId, gen_id',
      presetResolutions: '&[profileId+presetSlug], fetchedAt',
      drafts: '&chatId, updatedAt',
    })
    .upgrade(async (tx) => {
      const chats = tx.table<LegacyChatV1>('chats')
      await chats.toCollection().modify((row) => {
        const version = row.version ?? 0
        delete row.version
        ;(row as Chat).metaVersion = version
        ;(row as Chat).summaryVersion = version
      })

      const messages = tx.table<LegacyMessageV1, string>('messages')
      await messages.toCollection().modify((row) => {
        if (row.nodeVersion === undefined) {
          ;(row as Message).nodeVersion = 0
        }
      })

      const childLists = tx.table<ChildListState, string>('childLists')
      await migrateLegacyChildLists(messages, childLists)
    })

  db.version(3).stores({
    chats:
      'id, updatedAt, createdAt, lastViewedAt, lastUpdatedLeafId, lastBranchUpdatedAt, wordCount, totalCostUsd, archived, pinned, presetId, folderId, *tags',
    messages:
      'id, chatId, parentId, turnId, [chatId+parentId], [chatId+createdAt], [chatId+turnId], [chatId+deleted]',
    childLists: 'id, [chatId+parentId], updatedAt',
    attachments: 'id, contentHash, refCount, createdAt',
    profiles: 'id, name, kind, lastUsedAt, archived',
    presets: 'id, name, connectionProfileId, lastUsedAt, archived',
    folders: 'id, name, sortIndex, lastUsedAt',
    tags: 'id, &nameLower, lastUsedAt',
    chatBranchCache: '&chatId, branchLeafId, generatedAt',
    keys: 'id, name',
    settings: '&key',
    models: '&[profileId+queryKey], fetchedAt',
    endpoints: '&[profileId+modelId], fetchedAt',
    privacyPolicies: '&[profileId+modelId], fetchedAt',
    providers: '&profileId, fetchedAt',
    generations: 'id, chatId, gen_id',
    presetResolutions: '&[profileId+presetSlug], fetchedAt',
    drafts: '&chatId, updatedAt',
  })

  db.version(4)
    .stores({
      chats:
        'id, updatedAt, createdAt, lastViewedAt, lastUpdatedLeafId, lastBranchUpdatedAt, wordCount, totalCostUsd, archived, pinned, presetId, folderId, *tags',
      messages:
        'id, chatId, parentId, turnId, [chatId+parentId], [chatId+createdAt], [chatId+turnId], [chatId+deleted]',
      childLists: 'id, [chatId+parentId], updatedAt',
      attachments: 'id, contentHash, refCount, createdAt',
      profiles: 'id, name, kind, lastUsedAt, archived',
      presets: 'id, name, connectionProfileId, lastUsedAt, archived',
      folders: 'id, name, sortIndex, lastUsedAt',
      tags: 'id, &nameLower, lastUsedAt',
      chatBranchCache: '&chatId, branchLeafId, generatedAt',
      keys: 'id, name',
      settings: '&key',
      models: '&[profileId+queryKey], fetchedAt',
      endpoints: '&[profileId+modelId], fetchedAt',
      privacyPolicies: '&[profileId+modelId], fetchedAt',
      providers: '&profileId, fetchedAt',
      generations: 'id, chatId, gen_id',
      presetResolutions: '&[profileId+presetSlug], fetchedAt',
      drafts: '&chatId, updatedAt',
    })
    .upgrade(async (tx) => {
      await migrateProviderSettingsTables(tx)
    })

  // v5: promptPresets table + move continue prompts from global settings onto
  // each chat / ChatPreset. The legacy global keys are read once at upgrade
  // time to preserve any user customization, then retired.
  db.version(5)
    .stores({
      chats:
        'id, updatedAt, createdAt, lastViewedAt, lastUpdatedLeafId, lastBranchUpdatedAt, wordCount, totalCostUsd, archived, pinned, presetId, folderId, *tags',
      messages:
        'id, chatId, parentId, turnId, [chatId+parentId], [chatId+createdAt], [chatId+turnId], [chatId+deleted]',
      childLists: 'id, [chatId+parentId], updatedAt',
      attachments: 'id, contentHash, refCount, createdAt',
      profiles: 'id, name, kind, lastUsedAt, archived',
      presets: 'id, name, connectionProfileId, lastUsedAt, archived',
      promptPresets: 'id, kind, name, lastUsedAt',
      folders: 'id, name, sortIndex, lastUsedAt',
      tags: 'id, &nameLower, lastUsedAt',
      chatBranchCache: '&chatId, branchLeafId, generatedAt',
      keys: 'id, name',
      settings: '&key',
      models: '&[profileId+queryKey], fetchedAt',
      endpoints: '&[profileId+modelId], fetchedAt',
      privacyPolicies: '&[profileId+modelId], fetchedAt',
      providers: '&profileId, fetchedAt',
      generations: 'id, chatId, gen_id',
      presetResolutions: '&[profileId+presetSlug], fetchedAt',
      drafts: '&chatId, updatedAt',
    })
    .upgrade(async (tx) => {
      const settings = tx.table<SettingsRow>('settings')
      const legacySystem = await settings.get('global:continue-system-prompt')
      const legacyUser = await settings.get('global:continue-user-prompt')
      const legacySingle = await settings.get('global:continue-prompt')
      const seedSystem =
        typeof legacySystem?.value === 'string'
          ? legacySystem.value
          : typeof legacySingle?.value === 'string'
            ? legacySingle.value
            : DEFAULT_CONTINUE_SYSTEM_PROMPT
      const seedUser =
        typeof legacyUser?.value === 'string'
          ? legacyUser.value
          : typeof legacySingle?.value === 'string'
            ? ''
            : DEFAULT_CONTINUE_USER_PROMPT
      await tx
        .table<Chat>('chats')
        .toCollection()
        .modify((chat) => {
          const s = chat.settings as Chat['settings'] & {
            continueSystemPrompt?: string
            continueUserPrompt?: string
          }
          if (typeof s.continueSystemPrompt !== 'string') s.continueSystemPrompt = seedSystem
          if (typeof s.continueUserPrompt !== 'string') s.continueUserPrompt = seedUser
        })
      await tx
        .table<ChatPreset>('presets')
        .toCollection()
        .modify((preset) => {
          const s = preset.settings as ChatPreset['settings'] & {
            continueSystemPrompt?: string
            continueUserPrompt?: string
          }
          if (typeof s.continueSystemPrompt !== 'string') s.continueSystemPrompt = seedSystem
          if (typeof s.continueUserPrompt !== 'string') s.continueUserPrompt = seedUser
        })
      await settings
        .where('key')
        .anyOf([
          'global:continue-system-prompt',
          'global:continue-user-prompt',
          'global:continue-prompt',
        ])
        .delete()
    })

  // v6: Phase 12 attachment backend. Move bytes out of `attachments.blob`,
  // add artifact/job tables, and normalize prototype `attachmentRefs: string[]`
  // rows to per-message ref objects.
  db.version(6)
    .stores({
      chats:
        'id, updatedAt, createdAt, lastViewedAt, lastUpdatedLeafId, lastBranchUpdatedAt, wordCount, totalCostUsd, archived, pinned, presetId, folderId, *tags',
      messages:
        'id, chatId, parentId, turnId, [chatId+parentId], [chatId+createdAt], [chatId+turnId], [chatId+deleted]',
      childLists: 'id, [chatId+parentId], updatedAt',
      attachments: 'id, contentHash, kind, mime, origin, refCount, createdAt, updatedAt, deletedAt',
      attachmentBlobs: 'id, attachmentId, role, contentHash, createdAt',
      attachmentArtifacts: 'artifactId, attachmentId, kind, processorId, createdAt',
      attachmentJobs:
        'id, attachmentId, processorId, status, updatedAt, [attachmentId+processorId+inputHash]',
      profiles: 'id, name, kind, lastUsedAt, archived',
      presets: 'id, name, connectionProfileId, lastUsedAt, archived',
      promptPresets: 'id, kind, name, lastUsedAt',
      folders: 'id, name, sortIndex, lastUsedAt',
      tags: 'id, &nameLower, lastUsedAt',
      chatBranchCache: '&chatId, branchLeafId, generatedAt',
      keys: 'id, name',
      settings: '&key',
      models: '&[profileId+queryKey], fetchedAt',
      endpoints: '&[profileId+modelId], fetchedAt',
      privacyPolicies: '&[profileId+modelId], fetchedAt',
      providers: '&profileId, fetchedAt',
      generations: 'id, chatId, gen_id',
      presetResolutions: '&[profileId+presetSlug], fetchedAt',
      drafts: '&chatId, updatedAt',
    })
    .upgrade(async (tx) => {
      await migrateLegacyAttachmentStorage(tx)
    })

  // v7: Provider routing sort became an explicit OpenRouter preset field.
  // Backfill the default Price sort for old OpenRouter chats / presets and
  // canonicalize legacy sort object aliases without changing table layout.
  db.version(7)
    .stores({
      chats:
        'id, updatedAt, createdAt, lastViewedAt, lastUpdatedLeafId, lastBranchUpdatedAt, wordCount, totalCostUsd, archived, pinned, presetId, folderId, *tags',
      messages:
        'id, chatId, parentId, turnId, [chatId+parentId], [chatId+createdAt], [chatId+turnId], [chatId+deleted]',
      childLists: 'id, [chatId+parentId], updatedAt',
      attachments: 'id, contentHash, kind, mime, origin, refCount, createdAt, updatedAt, deletedAt',
      attachmentBlobs: 'id, attachmentId, role, contentHash, createdAt',
      attachmentArtifacts: 'artifactId, attachmentId, kind, processorId, createdAt',
      attachmentJobs:
        'id, attachmentId, processorId, status, updatedAt, [attachmentId+processorId+inputHash]',
      profiles: 'id, name, kind, lastUsedAt, archived',
      presets: 'id, name, connectionProfileId, lastUsedAt, archived',
      promptPresets: 'id, kind, name, lastUsedAt',
      folders: 'id, name, sortIndex, lastUsedAt',
      tags: 'id, &nameLower, lastUsedAt',
      chatBranchCache: '&chatId, branchLeafId, generatedAt',
      keys: 'id, name',
      settings: '&key',
      models: '&[profileId+queryKey], fetchedAt',
      endpoints: '&[profileId+modelId], fetchedAt',
      privacyPolicies: '&[profileId+modelId], fetchedAt',
      providers: '&profileId, fetchedAt',
      generations: 'id, chatId, gen_id',
      presetResolutions: '&[profileId+presetSlug], fetchedAt',
      drafts: '&chatId, updatedAt',
    })
    .upgrade(async (tx) => {
      await migrateProviderSettingsTables(tx)
    })

  // v8: appendPrompt slot lands on ChatSettings as a fourth preset-pinnable
  // prompt. Existing rows get a blank string so reads always see the field.
  db.version(8)
    .stores({
      chats:
        'id, updatedAt, createdAt, lastViewedAt, lastUpdatedLeafId, lastBranchUpdatedAt, wordCount, totalCostUsd, archived, pinned, presetId, folderId, *tags',
      messages:
        'id, chatId, parentId, turnId, [chatId+parentId], [chatId+createdAt], [chatId+turnId], [chatId+deleted]',
      childLists: 'id, [chatId+parentId], updatedAt',
      attachments: 'id, contentHash, kind, mime, origin, refCount, createdAt, updatedAt, deletedAt',
      attachmentBlobs: 'id, attachmentId, role, contentHash, createdAt',
      attachmentArtifacts: 'artifactId, attachmentId, kind, processorId, createdAt',
      attachmentJobs:
        'id, attachmentId, processorId, status, updatedAt, [attachmentId+processorId+inputHash]',
      profiles: 'id, name, kind, lastUsedAt, archived',
      presets: 'id, name, connectionProfileId, lastUsedAt, archived',
      promptPresets: 'id, kind, name, lastUsedAt',
      folders: 'id, name, sortIndex, lastUsedAt',
      tags: 'id, &nameLower, lastUsedAt',
      chatBranchCache: '&chatId, branchLeafId, generatedAt',
      keys: 'id, name',
      settings: '&key',
      models: '&[profileId+queryKey], fetchedAt',
      endpoints: '&[profileId+modelId], fetchedAt',
      privacyPolicies: '&[profileId+modelId], fetchedAt',
      providers: '&profileId, fetchedAt',
      generations: 'id, chatId, gen_id',
      presetResolutions: '&[profileId+presetSlug], fetchedAt',
      drafts: '&chatId, updatedAt',
    })
    .upgrade(async (tx) => {
      await tx
        .table<Chat>('chats')
        .toCollection()
        .modify((chat) => {
          const s = chat.settings as Chat['settings'] & { appendPrompt?: string }
          if (typeof s.appendPrompt !== 'string') s.appendPrompt = ''
        })
      await tx
        .table<ChatPreset>('presets')
        .toCollection()
        .modify((preset) => {
          const s = preset.settings as ChatPreset['settings'] & { appendPrompt?: string }
          if (typeof s.appendPrompt !== 'string') s.appendPrompt = ''
        })
    })

  // v9: defaultPrefill joins the prompt-preset family. Existing chats / presets
  // already used `defaultPrefill?: string` so the field is sometimes missing
  // on legacy rows; backfill it to '' so the editor and propagation logic see
  // a stable string.
  db.version(9)
    .stores({
      chats:
        'id, updatedAt, createdAt, lastViewedAt, lastUpdatedLeafId, lastBranchUpdatedAt, wordCount, totalCostUsd, archived, pinned, presetId, folderId, *tags',
      messages:
        'id, chatId, parentId, turnId, [chatId+parentId], [chatId+createdAt], [chatId+turnId], [chatId+deleted]',
      childLists: 'id, [chatId+parentId], updatedAt',
      attachments: 'id, contentHash, kind, mime, origin, refCount, createdAt, updatedAt, deletedAt',
      attachmentBlobs: 'id, attachmentId, role, contentHash, createdAt',
      attachmentArtifacts: 'artifactId, attachmentId, kind, processorId, createdAt',
      attachmentJobs:
        'id, attachmentId, processorId, status, updatedAt, [attachmentId+processorId+inputHash]',
      profiles: 'id, name, kind, lastUsedAt, archived',
      presets: 'id, name, connectionProfileId, lastUsedAt, archived',
      promptPresets: 'id, kind, name, lastUsedAt',
      folders: 'id, name, sortIndex, lastUsedAt',
      tags: 'id, &nameLower, lastUsedAt',
      chatBranchCache: '&chatId, branchLeafId, generatedAt',
      keys: 'id, name',
      settings: '&key',
      models: '&[profileId+queryKey], fetchedAt',
      endpoints: '&[profileId+modelId], fetchedAt',
      privacyPolicies: '&[profileId+modelId], fetchedAt',
      providers: '&profileId, fetchedAt',
      generations: 'id, chatId, gen_id',
      presetResolutions: '&[profileId+presetSlug], fetchedAt',
      drafts: '&chatId, updatedAt',
    })
    .upgrade(async (tx) => {
      await tx
        .table<Chat>('chats')
        .toCollection()
        .modify((chat) => {
          const s = chat.settings as Chat['settings'] & { defaultPrefill?: string }
          if (typeof s.defaultPrefill !== 'string') s.defaultPrefill = ''
        })
      await tx
        .table<ChatPreset>('presets')
        .toCollection()
        .modify((preset) => {
          const s = preset.settings as ChatPreset['settings'] & { defaultPrefill?: string }
          if (typeof s.defaultPrefill !== 'string') s.defaultPrefill = ''
        })
    })

  // v10: split heavy message body fields out of the tree/header row. The
  // public domain Message shape is unchanged; browser storage now stores
  // metadata in `messages` and content/reasoning/tool payloads in
  // `messageBodies`.
  db.version(10)
    .stores({
      chats:
        'id, updatedAt, createdAt, lastViewedAt, lastUpdatedLeafId, lastBranchUpdatedAt, wordCount, totalCostUsd, archived, pinned, presetId, folderId, *tags',
      messages:
        'id, chatId, parentId, turnId, [chatId+parentId], [chatId+createdAt], [chatId+turnId], [chatId+deleted]',
      messageBodies: '&id, chatId, updatedAt, nodeVersion',
      childLists: 'id, [chatId+parentId], updatedAt',
      attachments: 'id, contentHash, kind, mime, origin, refCount, createdAt, updatedAt, deletedAt',
      attachmentBlobs: 'id, attachmentId, role, contentHash, createdAt',
      attachmentArtifacts: 'artifactId, attachmentId, kind, processorId, createdAt',
      attachmentJobs:
        'id, attachmentId, processorId, status, updatedAt, [attachmentId+processorId+inputHash]',
      profiles: 'id, name, kind, lastUsedAt, archived',
      presets: 'id, name, connectionProfileId, lastUsedAt, archived',
      promptPresets: 'id, kind, name, lastUsedAt',
      folders: 'id, name, sortIndex, lastUsedAt',
      tags: 'id, &nameLower, lastUsedAt',
      chatBranchCache: '&chatId, branchLeafId, generatedAt',
      keys: 'id, name',
      settings: '&key',
      models: '&[profileId+queryKey], fetchedAt',
      endpoints: '&[profileId+modelId], fetchedAt',
      privacyPolicies: '&[profileId+modelId], fetchedAt',
      providers: '&profileId, fetchedAt',
      generations: 'id, chatId, gen_id',
      presetResolutions: '&[profileId+presetSlug], fetchedAt',
      drafts: '&chatId, updatedAt',
    })
    .upgrade(migrateInlineMessageBodies)

  // v11: tiny per-stream leases for cross-tab stream ownership/status.
  // Content never lives here; this table only prevents orphan recovery from
  // claiming a currently-owned stream in another tab.
  db.version(11).stores({
    chats:
      'id, updatedAt, createdAt, lastViewedAt, lastUpdatedLeafId, lastBranchUpdatedAt, wordCount, totalCostUsd, archived, pinned, presetId, folderId, *tags',
    messages:
      'id, chatId, parentId, turnId, [chatId+parentId], [chatId+createdAt], [chatId+turnId], [chatId+deleted]',
    messageBodies: '&id, chatId, updatedAt, nodeVersion',
    childLists: 'id, [chatId+parentId], updatedAt',
    attachments: 'id, contentHash, kind, mime, origin, refCount, createdAt, updatedAt, deletedAt',
    attachmentBlobs: 'id, attachmentId, role, contentHash, createdAt',
    attachmentArtifacts: 'artifactId, attachmentId, kind, processorId, createdAt',
    attachmentJobs:
      'id, attachmentId, processorId, status, updatedAt, [attachmentId+processorId+inputHash]',
    profiles: 'id, name, kind, lastUsedAt, archived',
    presets: 'id, name, connectionProfileId, lastUsedAt, archived',
    promptPresets: 'id, kind, name, lastUsedAt',
    folders: 'id, name, sortIndex, lastUsedAt',
    tags: 'id, &nameLower, lastUsedAt',
    chatBranchCache: '&chatId, branchLeafId, generatedAt',
    keys: 'id, name',
    settings: '&key',
    streamLeases: '&streamId, chatId, ownerClientId, heartbeatAt',
    models: '&[profileId+queryKey], fetchedAt',
    endpoints: '&[profileId+modelId], fetchedAt',
    privacyPolicies: '&[profileId+modelId], fetchedAt',
    providers: '&profileId, fetchedAt',
    generations: 'id, chatId, gen_id',
    presetResolutions: '&[profileId+presetSlug], fetchedAt',
    drafts: '&chatId, updatedAt',
  })

  // v12: append-only stream chunks for crash/reload recovery. The canonical
  // `messageBodies` table stays cold during healthy streams; chunks are
  // compacted into the message body on normal finish or stale-stream recovery.
  db.version(12).stores({
    chats:
      'id, updatedAt, createdAt, lastViewedAt, lastUpdatedLeafId, lastBranchUpdatedAt, wordCount, totalCostUsd, archived, pinned, presetId, folderId, *tags',
    messages:
      'id, chatId, parentId, turnId, [chatId+parentId], [chatId+createdAt], [chatId+turnId], [chatId+deleted]',
    messageBodies: '&id, chatId, updatedAt, nodeVersion',
    childLists: 'id, [chatId+parentId], updatedAt',
    attachments: 'id, contentHash, kind, mime, origin, refCount, createdAt, updatedAt, deletedAt',
    attachmentBlobs: 'id, attachmentId, role, contentHash, createdAt',
    attachmentArtifacts: 'artifactId, attachmentId, kind, processorId, createdAt',
    attachmentJobs:
      'id, attachmentId, processorId, status, updatedAt, [attachmentId+processorId+inputHash]',
    profiles: 'id, name, kind, lastUsedAt, archived',
    presets: 'id, name, connectionProfileId, lastUsedAt, archived',
    promptPresets: 'id, kind, name, lastUsedAt',
    folders: 'id, name, sortIndex, lastUsedAt',
    tags: 'id, &nameLower, lastUsedAt',
    chatBranchCache: '&chatId, branchLeafId, generatedAt',
    keys: 'id, name',
    settings: '&key',
    streamLeases: '&streamId, chatId, ownerClientId, heartbeatAt',
    streamChunks: '&id, streamId, chatId, messageId, [streamId+seq], createdAt',
    models: '&[profileId+queryKey], fetchedAt',
    endpoints: '&[profileId+modelId], fetchedAt',
    privacyPolicies: '&[profileId+modelId], fetchedAt',
    providers: '&profileId, fetchedAt',
    generations: 'id, chatId, gen_id',
    presetResolutions: '&[profileId+presetSlug], fetchedAt',
    drafts: '&chatId, updatedAt',
  })

  // v13: remove retired chat-setting fields so the main app only sees
  // the current ChatSettings schema. Backcompat details live in
  // `backcompat/provider-settings-migration.ts` and `backcompat/chat-settings.ts`.
  db.version(13)
    .stores({
      chats:
        'id, updatedAt, createdAt, lastViewedAt, lastUpdatedLeafId, lastBranchUpdatedAt, wordCount, totalCostUsd, archived, pinned, presetId, folderId, *tags',
      messages:
        'id, chatId, parentId, turnId, [chatId+parentId], [chatId+createdAt], [chatId+turnId], [chatId+deleted]',
      messageBodies: '&id, chatId, updatedAt, nodeVersion',
      childLists: 'id, [chatId+parentId], updatedAt',
      attachments: 'id, contentHash, kind, mime, origin, refCount, createdAt, updatedAt, deletedAt',
      attachmentBlobs: 'id, attachmentId, role, contentHash, createdAt',
      attachmentArtifacts: 'artifactId, attachmentId, kind, processorId, createdAt',
      attachmentJobs:
        'id, attachmentId, processorId, status, updatedAt, [attachmentId+processorId+inputHash]',
      profiles: 'id, name, kind, lastUsedAt, archived',
      presets: 'id, name, connectionProfileId, lastUsedAt, archived',
      promptPresets: 'id, kind, name, lastUsedAt',
      folders: 'id, name, sortIndex, lastUsedAt',
      tags: 'id, &nameLower, lastUsedAt',
      chatBranchCache: '&chatId, branchLeafId, generatedAt',
      keys: 'id, name',
      settings: '&key',
      streamLeases: '&streamId, chatId, ownerClientId, heartbeatAt',
      streamChunks: '&id, streamId, chatId, messageId, [streamId+seq], createdAt',
      models: '&[profileId+queryKey], fetchedAt',
      endpoints: '&[profileId+modelId], fetchedAt',
      privacyPolicies: '&[profileId+modelId], fetchedAt',
      providers: '&profileId, fetchedAt',
      generations: 'id, chatId, gen_id',
      presetResolutions: '&[profileId+presetSlug], fetchedAt',
      drafts: '&chatId, updatedAt',
    })
    .upgrade(async (tx) => {
      await migrateProviderSettingsTables(tx)
    })

  // v14: move first-pass OpenRouter hosted-tool settings from the old shared
  // top-level fields into provider-scoped buckets.
  db.version(14)
    .stores({
      chats:
        'id, updatedAt, createdAt, lastViewedAt, lastUpdatedLeafId, lastBranchUpdatedAt, wordCount, totalCostUsd, archived, pinned, presetId, folderId, *tags',
      messages:
        'id, chatId, parentId, turnId, [chatId+parentId], [chatId+createdAt], [chatId+turnId], [chatId+deleted]',
      messageBodies: '&id, chatId, updatedAt, nodeVersion',
      childLists: 'id, [chatId+parentId], updatedAt',
      attachments: 'id, contentHash, kind, mime, origin, refCount, createdAt, updatedAt, deletedAt',
      attachmentBlobs: 'id, attachmentId, role, contentHash, createdAt',
      attachmentArtifacts: 'artifactId, attachmentId, kind, processorId, createdAt',
      attachmentJobs:
        'id, attachmentId, processorId, status, updatedAt, [attachmentId+processorId+inputHash]',
      profiles: 'id, name, kind, lastUsedAt, archived',
      presets: 'id, name, connectionProfileId, lastUsedAt, archived',
      promptPresets: 'id, kind, name, lastUsedAt',
      folders: 'id, name, sortIndex, lastUsedAt',
      tags: 'id, &nameLower, lastUsedAt',
      chatBranchCache: '&chatId, branchLeafId, generatedAt',
      keys: 'id, name',
      settings: '&key',
      streamLeases: '&streamId, chatId, ownerClientId, heartbeatAt',
      streamChunks: '&id, streamId, chatId, messageId, [streamId+seq], createdAt',
      models: '&[profileId+queryKey], fetchedAt',
      endpoints: '&[profileId+modelId], fetchedAt',
      privacyPolicies: '&[profileId+modelId], fetchedAt',
      providers: '&profileId, fetchedAt',
      generations: 'id, chatId, gen_id',
      presetResolutions: '&[profileId+presetSlug], fetchedAt',
      drafts: '&chatId, updatedAt',
    })
    .upgrade(async (tx) => {
      await tx
        .table<Chat>('chats')
        .toCollection()
        .modify((chat) => {
          const result = migrateProviderToolSettings(chat.settings)
          if (result.changed) chat.settings = result.settings
        })

      await tx
        .table<ChatPreset>('presets')
        .toCollection()
        .modify((preset) => {
          const result = migrateProviderToolSettings(preset.settings)
          if (result.changed) preset.settings = result.settings
        })

      await migrateProviderOutputItemRowsInTables(
        tx.table<MessageHeaderRow, string>('messages'),
        tx.table<MessageBodyRow, string>('messageBodies'),
      )
    })

  // v15: ChatPreset.settings is the single full ChatSettings snapshot. Backfill
  // every current defaulted field (including hidden provider-tool buckets) so
  // live code can compare and save whole settings objects without old-shape
  // fallbacks.
  db.version(15)
    .stores({
      chats:
        'id, updatedAt, createdAt, lastViewedAt, lastUpdatedLeafId, lastBranchUpdatedAt, wordCount, totalCostUsd, archived, pinned, presetId, folderId, *tags',
      messages:
        'id, chatId, parentId, turnId, [chatId+parentId], [chatId+createdAt], [chatId+turnId], [chatId+deleted]',
      messageBodies: '&id, chatId, updatedAt, nodeVersion',
      childLists: 'id, [chatId+parentId], updatedAt',
      attachments: 'id, contentHash, kind, mime, origin, refCount, createdAt, updatedAt, deletedAt',
      attachmentBlobs: 'id, attachmentId, role, contentHash, createdAt',
      attachmentArtifacts: 'artifactId, attachmentId, kind, processorId, createdAt',
      attachmentJobs:
        'id, attachmentId, processorId, status, updatedAt, [attachmentId+processorId+inputHash]',
      profiles: 'id, name, kind, lastUsedAt, archived',
      presets: 'id, name, connectionProfileId, lastUsedAt, archived',
      promptPresets: 'id, kind, name, lastUsedAt',
      folders: 'id, name, sortIndex, lastUsedAt',
      tags: 'id, &nameLower, lastUsedAt',
      chatBranchCache: '&chatId, branchLeafId, generatedAt',
      keys: 'id, name',
      settings: '&key',
      streamLeases: '&streamId, chatId, ownerClientId, heartbeatAt',
      streamChunks: '&id, streamId, chatId, messageId, [streamId+seq], createdAt',
      models: '&[profileId+queryKey], fetchedAt',
      endpoints: '&[profileId+modelId], fetchedAt',
      privacyPolicies: '&[profileId+modelId], fetchedAt',
      providers: '&profileId, fetchedAt',
      generations: 'id, chatId, gen_id',
      presetResolutions: '&[profileId+presetSlug], fetchedAt',
      drafts: '&chatId, updatedAt',
    })
    .upgrade(async (tx) => {
      await tx
        .table<Chat>('chats')
        .toCollection()
        .modify((chat) => {
          const result = migrateCurrentChatSettingsSnapshot(chat.settings)
          if (result.changed) chat.settings = result.settings
        })

      await tx
        .table<ChatPreset>('presets')
        .toCollection()
        .modify((preset) => {
          const result = migrateCurrentChatSettingsSnapshot(preset.settings)
          const profileChanged = result.settings.profileId !== preset.connectionProfileId
          const settings = profileChanged
            ? { ...result.settings, profileId: preset.connectionProfileId }
            : result.settings
          if (result.changed || profileChanged) preset.settings = settings
        })
    })

  // v16: Retire the old open-at-leaf preference. Opening a chat at the
  // branch leaf is now invariant, so old rows must not survive in stale DBs.
  db.version(16)
    .stores({
      chats:
        'id, updatedAt, createdAt, lastViewedAt, lastUpdatedLeafId, lastBranchUpdatedAt, wordCount, totalCostUsd, archived, pinned, presetId, folderId, *tags',
      messages:
        'id, chatId, parentId, turnId, [chatId+parentId], [chatId+createdAt], [chatId+turnId], [chatId+deleted]',
      messageBodies: '&id, chatId, updatedAt, nodeVersion',
      childLists: 'id, [chatId+parentId], updatedAt',
      attachments: 'id, contentHash, kind, mime, origin, refCount, createdAt, updatedAt, deletedAt',
      attachmentBlobs: 'id, attachmentId, role, contentHash, createdAt',
      attachmentArtifacts: 'artifactId, attachmentId, kind, processorId, createdAt',
      attachmentJobs:
        'id, attachmentId, processorId, status, updatedAt, [attachmentId+processorId+inputHash]',
      profiles: 'id, name, kind, lastUsedAt, archived',
      presets: 'id, name, connectionProfileId, lastUsedAt, archived',
      promptPresets: 'id, kind, name, lastUsedAt',
      folders: 'id, name, sortIndex, lastUsedAt',
      tags: 'id, &nameLower, lastUsedAt',
      chatBranchCache: '&chatId, branchLeafId, generatedAt',
      keys: 'id, name',
      settings: '&key',
      streamLeases: '&streamId, chatId, ownerClientId, heartbeatAt',
      streamChunks: '&id, streamId, chatId, messageId, [streamId+seq], createdAt',
      models: '&[profileId+queryKey], fetchedAt',
      endpoints: '&[profileId+modelId], fetchedAt',
      privacyPolicies: '&[profileId+modelId], fetchedAt',
      providers: '&profileId, fetchedAt',
      generations: 'id, chatId, gen_id',
      presetResolutions: '&[profileId+presetSlug], fetchedAt',
      drafts: '&chatId, updatedAt',
    })
    .upgrade(async (tx) => {
      await tx.table<SettingsRow>('settings').delete('global:auto-scroll-open')
    })

  // v17: Seed render-window defaults for existing workspaces. Fresh DBs can
  // still rely on read-time defaults because Dexie skips upgrade callbacks
  // when creating the latest version from scratch.
  db.version(17)
    .stores({
      chats:
        'id, updatedAt, createdAt, lastViewedAt, lastUpdatedLeafId, lastBranchUpdatedAt, wordCount, totalCostUsd, archived, pinned, presetId, folderId, *tags',
      messages:
        'id, chatId, parentId, turnId, [chatId+parentId], [chatId+createdAt], [chatId+turnId], [chatId+deleted]',
      messageBodies: '&id, chatId, updatedAt, nodeVersion',
      childLists: 'id, [chatId+parentId], updatedAt',
      attachments: 'id, contentHash, kind, mime, origin, refCount, createdAt, updatedAt, deletedAt',
      attachmentBlobs: 'id, attachmentId, role, contentHash, createdAt',
      attachmentArtifacts: 'artifactId, attachmentId, kind, processorId, createdAt',
      attachmentJobs:
        'id, attachmentId, processorId, status, updatedAt, [attachmentId+processorId+inputHash]',
      profiles: 'id, name, kind, lastUsedAt, archived',
      presets: 'id, name, connectionProfileId, lastUsedAt, archived',
      promptPresets: 'id, kind, name, lastUsedAt',
      folders: 'id, name, sortIndex, lastUsedAt',
      tags: 'id, &nameLower, lastUsedAt',
      chatBranchCache: '&chatId, branchLeafId, generatedAt',
      keys: 'id, name',
      settings: '&key',
      streamLeases: '&streamId, chatId, ownerClientId, heartbeatAt',
      streamChunks: '&id, streamId, chatId, messageId, [streamId+seq], createdAt',
      models: '&[profileId+queryKey], fetchedAt',
      endpoints: '&[profileId+modelId], fetchedAt',
      privacyPolicies: '&[profileId+modelId], fetchedAt',
      providers: '&profileId, fetchedAt',
      generations: 'id, chatId, gen_id',
      presetResolutions: '&[profileId+presetSlug], fetchedAt',
      drafts: '&chatId, updatedAt',
    })
    .upgrade(async (tx) => {
      const settings = tx.table<SettingsRow>('settings')
      const defaults: SettingsRow[] = [
        { key: 'global:message-render-window-size', value: 10 },
        { key: 'global:sidebar-render-window-size', value: 50 },
        { key: 'global:message-render-window-load-mode', value: 'auto' },
        { key: 'global:sidebar-render-window-load-mode', value: 'auto' },
      ]
      for (const row of defaults) {
        if (!(await settings.get(row.key))) await settings.put(row)
      }
    })

  // v18: Provider transport mode is chat/preset state, not connection state.
  // Existing rows are rewritten once so live code never branches on legacy
  // ConnectionProfile mode/default fields.
  db.version(18)
    .stores({
      chats:
        'id, updatedAt, createdAt, lastViewedAt, lastUpdatedLeafId, lastBranchUpdatedAt, wordCount, totalCostUsd, archived, pinned, presetId, folderId, *tags',
      messages:
        'id, chatId, parentId, turnId, [chatId+parentId], [chatId+createdAt], [chatId+turnId], [chatId+deleted]',
      messageBodies: '&id, chatId, updatedAt, nodeVersion',
      childLists: 'id, [chatId+parentId], updatedAt',
      attachments: 'id, contentHash, kind, mime, origin, refCount, createdAt, updatedAt, deletedAt',
      attachmentBlobs: 'id, attachmentId, role, contentHash, createdAt',
      attachmentArtifacts: 'artifactId, attachmentId, kind, processorId, createdAt',
      attachmentJobs:
        'id, attachmentId, processorId, status, updatedAt, [attachmentId+processorId+inputHash]',
      profiles: 'id, name, kind, lastUsedAt, archived',
      presets: 'id, name, connectionProfileId, lastUsedAt, archived',
      promptPresets: 'id, kind, name, lastUsedAt',
      folders: 'id, name, sortIndex, lastUsedAt',
      tags: 'id, &nameLower, lastUsedAt',
      chatBranchCache: '&chatId, branchLeafId, generatedAt',
      keys: 'id, name',
      settings: '&key',
      streamLeases: '&streamId, chatId, ownerClientId, heartbeatAt',
      streamChunks: '&id, streamId, chatId, messageId, [streamId+seq], createdAt',
      models: '&[profileId+queryKey], fetchedAt',
      endpoints: '&[profileId+modelId], fetchedAt',
      privacyPolicies: '&[profileId+modelId], fetchedAt',
      providers: '&profileId, fetchedAt',
      generations: 'id, chatId, gen_id',
      presetResolutions: '&[profileId+presetSlug], fetchedAt',
      drafts: '&chatId, updatedAt',
    })
    .upgrade(async (tx) => {
      await migrateProviderApiModeTables(tx)
    })

  // v19: ChatPreset picker order is a first-class row field. Backfill dense
  // indices once so live preset listing never has to branch on legacy rows.
  db.version(19)
    .stores({
      chats:
        'id, updatedAt, createdAt, lastViewedAt, lastUpdatedLeafId, lastBranchUpdatedAt, wordCount, totalCostUsd, archived, pinned, presetId, folderId, *tags',
      messages:
        'id, chatId, parentId, turnId, [chatId+parentId], [chatId+createdAt], [chatId+turnId], [chatId+deleted]',
      messageBodies: '&id, chatId, updatedAt, nodeVersion',
      childLists: 'id, [chatId+parentId], updatedAt',
      attachments: 'id, contentHash, kind, mime, origin, refCount, createdAt, updatedAt, deletedAt',
      attachmentBlobs: 'id, attachmentId, role, contentHash, createdAt',
      attachmentArtifacts: 'artifactId, attachmentId, kind, processorId, createdAt',
      attachmentJobs:
        'id, attachmentId, processorId, status, updatedAt, [attachmentId+processorId+inputHash]',
      profiles: 'id, name, kind, lastUsedAt, archived',
      presets: `id, name, connectionProfileId, sortIndex, lastUsedAt, archived, ${PRESET_SORT_MIGRATION_INDEX}`,
      promptPresets: 'id, kind, name, lastUsedAt',
      folders: 'id, name, sortIndex, lastUsedAt',
      tags: 'id, &nameLower, lastUsedAt',
      chatBranchCache: '&chatId, branchLeafId, generatedAt',
      keys: 'id, name',
      settings: '&key',
      streamLeases: '&streamId, chatId, ownerClientId, heartbeatAt',
      streamChunks: '&id, streamId, chatId, messageId, [streamId+seq], createdAt',
      models: '&[profileId+queryKey], fetchedAt',
      endpoints: '&[profileId+modelId], fetchedAt',
      privacyPolicies: '&[profileId+modelId], fetchedAt',
      providers: '&profileId, fetchedAt',
      generations: 'id, chatId, gen_id',
      presetResolutions: '&[profileId+presetSlug], fetchedAt',
      drafts: '&chatId, updatedAt',
    })
    .upgrade(async (tx) => {
      await migrateLegacyPresetSortOrder(tx.table<ChatPreset, string>('presets'))
    })

  // v20: rendering-preferences gained a visible line-break option. Normalize
  // any existing blob so old rows have a concrete false default.
  db.version(20)
    .stores({
      chats:
        'id, updatedAt, createdAt, lastViewedAt, lastUpdatedLeafId, lastBranchUpdatedAt, wordCount, totalCostUsd, archived, pinned, presetId, folderId, *tags',
      messages:
        'id, chatId, parentId, turnId, [chatId+parentId], [chatId+createdAt], [chatId+turnId], [chatId+deleted]',
      messageBodies: '&id, chatId, updatedAt, nodeVersion',
      childLists: 'id, [chatId+parentId], updatedAt',
      attachments: 'id, contentHash, kind, mime, origin, refCount, createdAt, updatedAt, deletedAt',
      attachmentBlobs: 'id, attachmentId, role, contentHash, createdAt',
      attachmentArtifacts: 'artifactId, attachmentId, kind, processorId, createdAt',
      attachmentJobs:
        'id, attachmentId, processorId, status, updatedAt, [attachmentId+processorId+inputHash]',
      profiles: 'id, name, kind, lastUsedAt, archived',
      presets: 'id, name, connectionProfileId, sortIndex, lastUsedAt, archived',
      promptPresets: 'id, kind, name, lastUsedAt',
      folders: 'id, name, sortIndex, lastUsedAt',
      tags: 'id, &nameLower, lastUsedAt',
      chatBranchCache: '&chatId, branchLeafId, generatedAt',
      keys: 'id, name',
      settings: '&key',
      streamLeases: '&streamId, chatId, ownerClientId, heartbeatAt',
      streamChunks: '&id, streamId, chatId, messageId, [streamId+seq], createdAt',
      models: '&[profileId+queryKey], fetchedAt',
      endpoints: '&[profileId+modelId], fetchedAt',
      privacyPolicies: '&[profileId+modelId], fetchedAt',
      providers: '&profileId, fetchedAt',
      generations: 'id, chatId, gen_id',
      presetResolutions: '&[profileId+presetSlug], fetchedAt',
      drafts: '&chatId, updatedAt',
    })
    .upgrade(async (tx) => {
      const settings = tx.table<SettingsRow>('settings')
      const row = await settings.get(RENDERING_PREFERENCES_KEY)
      if (!row) return
      const next = normalizeRenderingPreferences(row.value)
      if (!jsonValuesEqual(row.value, next)) {
        await settings.put({ key: RENDERING_PREFERENCES_KEY, value: next })
      }
    })

  // v22: generation/continuation attempts gained explicit terminal/integrity
  // state, fallback writes gained one persisted fence row, and attachment
  // owners gained a normalized live-edge projection and consistent missing-byte
  // bundles, and stale chat previews gained a one-time repair. Compose them so
  // this implementation block has one schema bump.
  db.version(22)
    .stores({
      chats:
        'id, updatedAt, createdAt, lastViewedAt, lastUpdatedLeafId, lastBranchUpdatedAt, wordCount, totalCostUsd, archived, pinned, presetId, folderId, *tags',
      chatSidebarRows:
        '&id, updatedAt, createdAt, lastViewedAt, lastUpdatedLeafId, lastBranchUpdatedAt, wordCount, totalCostUsd, archived, pinned, folderId, *tags',
      messages:
        'id, chatId, parentId, turnId, [chatId+parentId], [chatId+createdAt], [chatId+turnId], [chatId+deleted]',
      messageBodies: '&id, chatId, updatedAt, nodeVersion',
      childLists: 'id, [chatId+parentId], updatedAt',
      attachments: 'id, contentHash, kind, mime, origin, refCount, createdAt, updatedAt, deletedAt',
      attachmentBlobs: 'id, attachmentId, role, contentHash, createdAt',
      attachmentArtifacts: 'artifactId, attachmentId, kind, processorId, createdAt',
      attachmentJobs:
        'id, attachmentId, processorId, status, updatedAt, [attachmentId+processorId+inputHash]',
      profiles: 'id, name, kind, lastUsedAt, archived',
      presets: 'id, name, connectionProfileId, sortIndex, lastUsedAt, archived',
      promptPresets: 'id, kind, name, lastUsedAt',
      folders: 'id, name, sortIndex, lastUsedAt',
      tags: 'id, &nameLower, lastUsedAt',
      chatBranchCache: '&chatId, branchLeafId, generatedAt',
      keys: 'id, name',
      settings: '&key',
      browserLocks: '&name',
      attachmentRefEdges:
        '&[ownerKind+ownerId+refId], attachmentId, [attachmentId+ownerKind], [ownerKind+ownerId], chatId',
      streamLeases: '&streamId, chatId, messageId, ownerClientId, heartbeatAt',
      streamChunks: '&id, streamId, chatId, messageId, [streamId+seq], createdAt',
      models: '&[profileId+queryKey], fetchedAt',
      endpoints: '&[profileId+modelId], fetchedAt',
      privacyPolicies: '&[profileId+modelId], fetchedAt',
      providers: '&profileId, fetchedAt',
      generations: 'id, chatId, gen_id',
      presetResolutions: '&[profileId+presetSlug], fetchedAt',
      drafts: '&chatId, updatedAt',
    })
    .upgrade(async (tx) => {
      await migrateWorkspaceReplacementEpoch(tx)
      await migrateStreamLeaseAttempts(tx)
      await migrateGenerationAttemptOutcomes(tx)
      await migrateBrowserWriterLock(tx)
      await normalizeAttachmentRefOwners(tx)
      await scrubMissingAttachmentByteReferences(tx)
      await rebuildAttachmentReferenceEdges(tx)
      await tx.table<SettingsRow>('settings').put(attachmentRefsBackfillMarker())
      await migrateChatPreviewProjection(tx)
      await migrateChatSidebarProjection(tx)
    })

  // v23: add bounded message-header text previews and move potentially large
  // provider-hosted tool outputs into the cold message body.
  db.version(23).upgrade(async (tx) => {
    await migrateMessageHeaderProjections(tx)
    await migrateAttachmentHeaderProjection(tx)
  })

  // v24: structural header revisions no longer invalidate cold message bodies.
  // Body coherence and the branch word-count projection are explicit header
  // fields so tree-only mutations never have to read or rewrite payload rows.
  db.version(24)
    .stores({
      chats:
        'id, updatedAt, createdAt, lastViewedAt, lastUpdatedLeafId, lastBranchUpdatedAt, wordCount, totalCostUsd, archived, pinned, presetId, folderId, *tags',
      chatSidebarRows:
        '&id, updatedAt, createdAt, lastViewedAt, lastUpdatedLeafId, lastBranchUpdatedAt, wordCount, totalCostUsd, archived, pinned, folderId, *tags',
      messages:
        'id, chatId, parentId, turnId, [chatId+parentId], [chatId+createdAt], [chatId+turnId], [chatId+deleted]',
      messageBodies: '&id, chatId, updatedAt, bodyVersion',
      childLists: 'id, [chatId+parentId], updatedAt',
      attachments: 'id, contentHash, kind, mime, origin, refCount, createdAt, updatedAt, deletedAt',
      attachmentBlobs: 'id, attachmentId, role, contentHash, createdAt',
      attachmentArtifacts: 'artifactId, attachmentId, kind, processorId, createdAt',
      attachmentJobs:
        'id, attachmentId, processorId, status, updatedAt, [attachmentId+processorId+inputHash]',
      profiles: 'id, name, kind, lastUsedAt, archived',
      presets: 'id, name, connectionProfileId, sortIndex, lastUsedAt, archived',
      promptPresets: 'id, kind, name, lastUsedAt',
      folders: 'id, name, sortIndex, lastUsedAt',
      tags: 'id, &nameLower, lastUsedAt',
      chatBranchCache: '&chatId, branchLeafId, generatedAt',
      keys: 'id, name',
      settings: '&key',
      browserLocks: '&name',
      attachmentRefEdges:
        '&[ownerKind+ownerId+refId], attachmentId, [attachmentId+ownerKind], [ownerKind+ownerId], chatId',
      streamLeases: '&streamId, chatId, messageId, ownerClientId, heartbeatAt',
      streamChunks: '&id, streamId, chatId, messageId, [streamId+seq], createdAt',
      models: '&[profileId+queryKey], fetchedAt',
      endpoints: '&[profileId+modelId], fetchedAt',
      privacyPolicies: '&[profileId+modelId], fetchedAt',
      providers: '&profileId, fetchedAt',
      generations: 'id, chatId, gen_id',
      presetResolutions: '&[profileId+presetSlug], fetchedAt',
      drafts: '&chatId, updatedAt',
    })
    .upgrade(migrateMessageBodyVersions)

  // v25: request freshness has its own semantic revision. Generic header
  // metadata, sibling renumbering, and derived calibration no longer
  // impersonate a changed outbound prompt.
  db.version(25).upgrade(migrateMessageRequestContextVersions)
}

function organizationDefaultsPatch(
  chat: Partial<Chat> & Record<string, unknown>,
  messageHeaders: readonly Pick<Message, 'origin'>[],
  computed: {
    lastUpdatedLeafId: string | null
    previewText: string
    wordCount: number
    totalCostUsd: number
  },
): Partial<Chat> | null {
  const patch: Partial<Chat> = {}
  if (
    chat.folderId === undefined ||
    (chat.folderId !== null && typeof chat.folderId !== 'string')
  ) {
    patch.folderId = null
  }
  if (!Array.isArray(chat.tags) || !chat.tags.every((tag) => typeof tag === 'string')) {
    patch.tags = []
  }
  if (!isTitleStatus(chat.titleStatus)) {
    patch.titleStatus = inferLegacyTitleStatus(chat.title, messageHeaders)
  }
  if (!isFiniteNumber(chat.lastViewedAt)) {
    patch.lastViewedAt = isFiniteNumber(chat.updatedAt) ? chat.updatedAt : 0
  }
  if (chat.lastUpdatedLeafId !== computed.lastUpdatedLeafId) {
    patch.lastUpdatedLeafId = computed.lastUpdatedLeafId
  }
  if (chat.previewText === undefined) {
    patch.previewText = computed.previewText
  }
  if (!isFiniteNumber(chat.lastBranchUpdatedAt)) {
    patch.lastBranchUpdatedAt = 0
  }
  if (!isFiniteNumber(chat.wordCount) || chat.wordCount !== computed.wordCount) {
    patch.wordCount = computed.wordCount
  }
  if (!isFiniteNumber(chat.totalCostUsd) || chat.totalCostUsd !== computed.totalCostUsd) {
    patch.totalCostUsd = computed.totalCostUsd
  }
  return Object.keys(patch).length > 0 ? patch : null
}

function isTitleStatus(value: unknown): value is Chat['titleStatus'] {
  return (
    value === 'untitled' ||
    value === 'pending' ||
    value === 'auto' ||
    value === 'manual' ||
    value === 'auto-failed'
  )
}

function inferLegacyTitleStatus(
  value: unknown,
  messageHeaders: readonly Pick<Message, 'origin'>[],
): Chat['titleStatus'] {
  const title = typeof value === 'string' ? value.trim() : ''
  const imported = messageHeaders.some((message) => message.origin === 'imported')
  if (imported || title.length === 0 || title === 'Untitled chat') return 'untitled'
  return 'auto'
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

async function computePreviewText(
  bodies: Table<MessageBodyRow, string>,
  rows: readonly MessageHeaderRow[],
): Promise<string> {
  let earliestHeader: MessageHeaderRow | undefined
  for (const header of rows) {
    if (header.deleted || header.role !== 'user') continue
    if (
      !earliestHeader ||
      header.createdAt < earliestHeader.createdAt ||
      (header.createdAt === earliestHeader.createdAt && header.id < earliestHeader.id)
    ) {
      earliestHeader = header
    }
  }
  if (!earliestHeader) return ''
  const body = await bodies.get(earliestHeader.id)
  return previewTextFromContent(body?.content ?? [])
}

export function childListKey(chatId: string, parentId: string | null): string {
  return `${chatId}:${parentId ?? '__root__'}`
}

let singleton: NatterDb | null = null
let organizationFieldsBackfillPromise: Promise<void> | null = null
let chatPreviewProjectionBackfillPromise: Promise<void> | null = null
let chatSidebarProjectionBackfillPromise: Promise<void> | null = null
let messageBodySplitBackfillPromise: Promise<void> | null = null
let globalSettingsBackfillPromise: Promise<void> | null = null
let attachmentRefsBackfillPromise: Promise<void> | null = null
let providerOutputItemsBackfillPromise: Promise<void> | null = null
let providerToolSettingsBackfillPromise: Promise<void> | null = null
let tokenCalibrationGlobalBackfillPromise: Promise<void> | null = null
let tokenCalibrationCanonicalizeBackfillPromise: Promise<void> | null = null
const ORGANIZATION_FIELDS_BACKFILL_KEY = 'backfill:organization-fields-v1'

function organizationFieldsBackfillMarker(): SettingsRow {
  return { key: ORGANIZATION_FIELDS_BACKFILL_KEY, value: 1 }
}

export function getDb(): NatterDb {
  if (!singleton) singleton = new NatterDb()
  return singleton
}

function resetBackfillState(): void {
  organizationFieldsBackfillPromise = null
  chatPreviewProjectionBackfillPromise = null
  chatSidebarProjectionBackfillPromise = null
  messageBodySplitBackfillPromise = null
  globalSettingsBackfillPromise = null
  attachmentRefsBackfillPromise = null
  providerOutputItemsBackfillPromise = null
  providerToolSettingsBackfillPromise = null
  tokenCalibrationGlobalBackfillPromise = null
  tokenCalibrationCanonicalizeBackfillPromise = null
}

// Explicit open — resolves when the underlying IDBDatabase is ready and the
// schema has settled. Safe to call repeatedly; Dexie caches the open call.
export interface OpenDbOptions {
  onBlocked?: (event: IDBVersionChangeEvent) => void
}

export async function openDb(options: OpenDbOptions = {}): Promise<NatterDb> {
  const db = getDb()
  const blocked = options.onBlocked
  if (blocked) db.on.blocked.subscribe(blocked)
  try {
    if (!db.isOpen()) await db.open()
  } finally {
    if (blocked) db.on.blocked.unsubscribe(blocked)
  }
  attachmentRefsBackfillPromise ??= migrateAttachmentRefRows(db).catch((err) => {
    attachmentRefsBackfillPromise = null
    throw err
  })
  await attachmentRefsBackfillPromise
  messageBodySplitBackfillPromise ??= backfillMissingMessageBodies(db).catch((err) => {
    messageBodySplitBackfillPromise = null
    throw err
  })
  await messageBodySplitBackfillPromise
  chatPreviewProjectionBackfillPromise ??= backfillChatPreviewProjection(db).catch((err) => {
    chatPreviewProjectionBackfillPromise = null
    throw err
  })
  await chatPreviewProjectionBackfillPromise
  organizationFieldsBackfillPromise ??= backfillOrganizationFields(db).catch((err) => {
    organizationFieldsBackfillPromise = null
    throw err
  })
  await organizationFieldsBackfillPromise
  chatSidebarProjectionBackfillPromise ??= ensureChatSidebarProjection(db).catch((err) => {
    chatSidebarProjectionBackfillPromise = null
    throw err
  })
  await chatSidebarProjectionBackfillPromise
  globalSettingsBackfillPromise ??= migrateGlobalSettingsRows(db).catch((err) => {
    globalSettingsBackfillPromise = null
    throw err
  })
  await globalSettingsBackfillPromise
  providerOutputItemsBackfillPromise ??= migrateProviderOutputItemRows(db).catch((err) => {
    providerOutputItemsBackfillPromise = null
    throw err
  })
  await providerOutputItemsBackfillPromise
  providerToolSettingsBackfillPromise ??= migrateProviderToolSettingsRows(db).catch((err) => {
    providerToolSettingsBackfillPromise = null
    throw err
  })
  await providerToolSettingsBackfillPromise
  tokenCalibrationGlobalBackfillPromise ??= rebuildTokenCalibrationGlobalRows(db).catch((err) => {
    tokenCalibrationGlobalBackfillPromise = null
    throw err
  })
  await tokenCalibrationGlobalBackfillPromise
  tokenCalibrationCanonicalizeBackfillPromise ??= canonicalizeTokenCalibrationRows(db).catch(
    (err) => {
      tokenCalibrationCanonicalizeBackfillPromise = null
      throw err
    },
  )
  await tokenCalibrationCanonicalizeBackfillPromise
  return db
}

configureLockDatabaseOpener(openDb)
configureBroadcastFallbackReader(async () => {
  const db = await openDb()
  const { mutationCounter, replacementEpoch } = await readBrowserWorkspaceMeta(db)
  return { db, mutationCounter, replacementEpoch }
})

export function closeDb(): void {
  if (singleton) {
    singleton.close()
    singleton = null
  }
  resetBackfillState()
}

// Test-only reset so unit tests can swap in their own jsdom-backed IDB.
export function __resetDbForTests(): void {
  closeDb()
}

// Mint a uniquely-named Dexie instance for integration tests that want to
// assert migrations or multi-chat concurrency without polluting the singleton.
// Caller is responsible for `await db.delete()` on teardown.
export function createDbForTests(name: string): NatterDb {
  return new NatterDb(name)
}

export async function backfillOrganizationFields(db: NatterDb): Promise<void> {
  const marker = await db.settings.get(ORGANIZATION_FIELDS_BACKFILL_KEY)
  if (marker?.value === 1) return

  await db.transaction(
    'rw',
    db.chats,
    db.chatSidebarRows,
    db.messages,
    db.messageBodies,
    db.settings,
    async (tx) => {
      await forEachTableBatch(db.chats, async (chats) => {
        const patchedChats: Chat[] = []
        for (const chat of chats) {
          const rows = await db.messages.where('chatId').equals(chat.id).toArray()
          const nextLeafId = findLastUpdatedLeafId(rows as unknown as Message[])
          const branchHeaders =
            nextLeafId !== null
              ? (buildBranchMessages(
                  rows as unknown as Message[],
                  nextLeafId,
                ) as unknown as MessageHeaderRow[])
              : []
          let wordCount = 0
          for (let start = 0; start < branchHeaders.length; start += BACKCOMPAT_BATCH_SIZE) {
            const headers = branchHeaders.slice(start, start + BACKCOMPAT_BATCH_SIZE)
            const bodies = (
              await db.messageBodies.bulkGet(headers.map((message) => message.id))
            ).filter((row): row is MessageBodyRow => row !== undefined)
            wordCount += countMessagesWords(hydrateMessages(headers, bodies))
          }
          const totalCostUsd = rows.reduce(
            (total, message) => total + (message.deleted ? 0 : (message.generation?.cost ?? 0)),
            0,
          )
          const patch = organizationDefaultsPatch(
            chat as Partial<Chat> & Record<string, unknown>,
            rows,
            {
              lastUpdatedLeafId: nextLeafId,
              previewText:
                chat.previewText === undefined
                  ? await computePreviewText(db.messageBodies, rows)
                  : chat.previewText,
              wordCount,
              totalCostUsd,
            },
          )
          if (patch) patchedChats.push({ ...chat, ...patch })
        }
        if (patchedChats.length > 0) {
          await db.chats.bulkPut(patchedChats)
          for (const chat of patchedChats) await putChatSidebarProjection(tx, chat)
        }
      })
      await db.settings.put(organizationFieldsBackfillMarker())
    },
  )
}

async function ensureChatSidebarProjection(db: NatterDb): Promise<void> {
  const [marker, manifest, actualCount] = await db.transaction(
    'r',
    db.chatSidebarRows,
    db.settings,
    async () =>
      Promise.all([
        db.settings.get(CHAT_SIDEBAR_PROJECTION_BACKFILL_KEY),
        db.settings.get(CHAT_SIDEBAR_PROJECTION_MANIFEST_KEY),
        db.chatSidebarRows.count(),
      ]),
  )
  if (marker?.value === 1 && isValidChatSidebarProjectionManifest(manifest?.value, actualCount)) {
    return
  }
  await rebuildChatSidebarProjection(db)
}
