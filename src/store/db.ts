// Dexie schema + open/close. Schema kept in lockstep with `plan/03-storage.md §3.1`.
//
// The module exports a single default-name singleton for production. Tests that
// need isolation use `createDbForTests(name)` to mint a uniquely-named instance
// and close it when they're done.

import Dexie, { type Table } from 'dexie'
import {
  attachmentRefsBackfillMarker,
  migrateAttachmentRefRows,
  normalizeLegacyAttachmentRefs,
} from '../backcompat/attachment-refs'
import { migrateCurrentChatSettingsSnapshot } from '../backcompat/chat-settings'
import {
  globalSettingsBackfillMarker,
  migrateGlobalSettingsRows,
} from '../backcompat/global-settings'
import {
  backfillMissingMessageBodies,
  messageBodySplitBackfillMarker,
  migrateInlineMessageBodies,
} from '../backcompat/message-body-split'
import {
  migrateProviderApiModeProfile,
  migrateProviderApiModeSettings,
} from '../backcompat/provider-api-modes'
import {
  migrateProviderOutputItemRows,
  migrateProviderOutputItemsFromGeneration,
  providerOutputItemsBackfillMarker,
} from '../backcompat/provider-output-items'
import {
  migrateProviderSettingsRow,
  providerCacheKey,
} from '../backcompat/provider-settings-migration'
import {
  migrateProviderToolSettings,
  migrateProviderToolSettingsRows,
  providerToolSettingsBackfillMarker,
} from '../backcompat/provider-tools'
import {
  canonicalizeTokenCalibrationRows,
  rebuildTokenCalibrationGlobalRows,
  tokenCalibrationCanonicalizeBackfillMarker,
  tokenCalibrationGlobalBackfillMarker,
} from '../backcompat/token-calibration-global'
import { findLastUpdatedLeafId } from '../core/active-path'
import { buildBranchMessages } from '../core/branch-flatten'
import {
  DEFAULT_CONTINUE_SYSTEM_PROMPT,
  DEFAULT_CONTINUE_USER_PROMPT,
} from '../core/global-settings'
import {
  normalizeRenderingPreferences,
  RENDERING_PREFERENCES_KEY,
} from '../core/rendering-preferences'
import type {
  Attachment,
  AttachmentArtifact,
  AttachmentBlob,
  AttachmentJob,
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
import { hydrateMessages, type MessageBodyRow, type MessageHeaderRow } from './message-storage'
import type { StreamChunkRow, StreamLeaseRow } from './repository'

export interface CachedModelsRow {
  profileId: string
  queryKey: string
  fetchedAt: number
  payload: unknown
}

export interface CachedEndpointsRow {
  profileId: string
  modelId: string
  fetchedAt: number
  payload: unknown
}

export interface CachedPrivacyPolicyRow {
  profileId: string
  modelId: string
  fetchedAt: number
  payload: unknown
}

export interface CachedProvidersRow {
  profileId: string
  fetchedAt: number
  payload: unknown
}

interface CachedGenerationRow {
  id: string
  chatId: string
  gen_id: string
  fetchedAt: number
  payload: unknown
}

export interface SettingsRow {
  key: string
  value: unknown
}

export class NatterDb extends Dexie {
  chats!: Table<Chat, string>
  messages!: Table<MessageHeaderRow, string>
  messageBodies!: Table<MessageBodyRow, string>
  childLists!: Table<ChildListState, string>
  attachments!: Table<Attachment, string>
  attachmentBlobs!: Table<AttachmentBlob, string>
  attachmentArtifacts!: Table<AttachmentArtifact, string>
  attachmentJobs!: Table<AttachmentJob, string>
  profiles!: Table<ConnectionProfile, string>
  presets!: Table<ChatPreset, string>
  promptPresets!: Table<PromptPreset, string>
  folders!: Table<ChatFolder, string>
  tags!: Table<ChatTag, string>
  chatBranchCache!: Table<ChatBranchCache, string>
  keys!: Table<KeyRecord, string>
  settings!: Table<SettingsRow, string>
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
        globalSettingsBackfillMarker(),
        providerOutputItemsBackfillMarker(),
        providerToolSettingsBackfillMarker(),
        tokenCalibrationGlobalBackfillMarker(),
        tokenCalibrationCanonicalizeBackfillMarker(),
      ])
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

      const messages = tx.table<LegacyMessageV1>('messages')
      await messages.toCollection().modify((row) => {
        if (row.nodeVersion === undefined) {
          ;(row as Message).nodeVersion = 0
        }
      })

      const childLists = tx.table<ChildListState>('childLists')
      const messageRows = await messages.toArray()
      const seen = new Set<string>()
      for (const row of messageRows) {
        const id = childListKey(row.chatId, row.parentId)
        if (seen.has(id)) continue
        seen.add(id)
        await childLists.put({
          id,
          chatId: row.chatId,
          parentId: row.parentId,
          version: 0,
          updatedAt: 0,
        })
      }
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
      const endpointsRows = await tx.table<CachedEndpointsRow>('endpoints').toArray()
      const privacyRows = await tx.table<CachedPrivacyPolicyRow>('privacyPolicies').toArray()
      const profiles = await tx.table<ConnectionProfile>('profiles').toArray()
      const endpointsByKey = new Map<string, CachedEndpointsRow>()
      const privacyByKey = new Map<string, CachedPrivacyPolicyRow>()
      const profilesById = new Map(profiles.map((profile) => [profile.id, profile]))
      for (const row of endpointsRows)
        endpointsByKey.set(providerCacheKey(row.profileId, row.modelId), row)
      for (const row of privacyRows)
        privacyByKey.set(providerCacheKey(row.profileId, row.modelId), row)

      await tx
        .table<Chat>('chats')
        .toCollection()
        .modify((chat) => {
          const result = migrateProviderSettingsRow(
            chat.settings,
            chat.settings.profileId,
            chat.settings.model,
            {
              endpointsByKey,
              privacyByKey,
              profilesById,
            },
          )
          if (result.changed) chat.settings = result.settings
        })

      await tx
        .table<ChatPreset>('presets')
        .toCollection()
        .modify((preset) => {
          const result = migrateProviderSettingsRow(
            preset.settings,
            preset.connectionProfileId,
            preset.settings.model,
            { endpointsByKey, privacyByKey, profilesById },
          )
          if (result.changed) preset.settings = result.settings
        })
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
      const now = Date.now()
      const blobs = tx.table<AttachmentBlob>('attachmentBlobs')
      const attachmentTable = tx.table<Record<string, unknown>>('attachments')
      const attachmentRows = await attachmentTable.toArray()
      for (const row of attachmentRows) {
        const id = String(row.id)
        const createdAt = numberOr(row.createdAt, now)
        const updatedAt = numberOr(row.updatedAt, createdAt)
        const blob = legacyBlob(row.blob)
        const blobId = storageBlobId(row.storage) ?? (blob ? `${id}:original` : undefined)
        const contentHash = typeof row.contentHash === 'string' ? row.contentHash : undefined
        if (blob && blobId && contentHash && !(await blobs.get(blobId))) {
          await blobs.put({
            id: blobId,
            attachmentId: id,
            role: 'original',
            mime: typeof row.mime === 'string' ? row.mime : 'application/octet-stream',
            contentHash,
            sizeBytes: typeof row.sizeBytes === 'number' ? row.sizeBytes : blob.size,
            blob,
            createdAt,
          })
        }

        delete row.blob
        delete row.thumbnailB64
        row.kind = row.kind === 'file' ? 'other' : (row.kind ?? 'other')
        row.origin = row.origin ?? 'import'
        row.createdAt = createdAt
        row.updatedAt = updatedAt
        row.extension = row.extension ?? extensionFromFilename(row.filename)
        row.sizeBytes = row.sizeBytes ?? blob?.size
        row.artifacts = Array.isArray(row.artifacts) ? row.artifacts : []
        row.processing = Array.isArray(row.processing) ? row.processing : []
        row.storage =
          row.storage ??
          (blobId
            ? { kind: 'local-blob', blobId }
            : { kind: 'missing', reason: 'import-missing', missingSince: now })
        row.refCount = 0
        await attachmentTable.put(row)
      }

      const refCounts = new Map<string, number>()
      await tx
        .table<Record<string, unknown>>('messages')
        .toCollection()
        .modify((row) => {
          const refs =
            normalizeLegacyAttachmentRefs(row.attachmentRefs, {
              messageId: String(row.id),
              createdAt: numberOr(row.createdAt, now),
            }) ?? []
          row.attachmentRefs = refs
          for (const ref of refs ?? []) {
            if (ref.deletedAt !== undefined) continue
            refCounts.set(ref.attachmentId, (refCounts.get(ref.attachmentId) ?? 0) + 1)
          }
        })
      await tx
        .table<Record<string, unknown>>('drafts')
        .toCollection()
        .modify((row) => {
          const refs =
            normalizeLegacyAttachmentRefs(row.attachmentRefs, {
              draftChatId: String(row.chatId),
              createdAt: numberOr(row.updatedAt, now),
            }) ?? []
          row.attachmentRefs = refs
          for (const ref of refs ?? []) {
            if (ref.deletedAt !== undefined) continue
            refCounts.set(ref.attachmentId, (refCounts.get(ref.attachmentId) ?? 0) + 1)
          }
        })
      await tx
        .table<Attachment>('attachments')
        .toCollection()
        .modify((row) => {
          row.refCount = refCounts.get(row.id) ?? 0
        })
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
      const [endpointsRows, privacyRows, profiles] = await Promise.all([
        tx.table<CachedEndpointsRow>('endpoints').toArray(),
        tx.table<CachedPrivacyPolicyRow>('privacyPolicies').toArray(),
        tx.table<ConnectionProfile>('profiles').toArray(),
      ])
      const endpointsByKey = new Map<string, CachedEndpointsRow>()
      const privacyByKey = new Map<string, CachedPrivacyPolicyRow>()
      const profilesById = new Map(profiles.map((profile) => [profile.id, profile]))
      for (const row of endpointsRows)
        endpointsByKey.set(providerCacheKey(row.profileId, row.modelId), row)
      for (const row of privacyRows)
        privacyByKey.set(providerCacheKey(row.profileId, row.modelId), row)

      await tx
        .table<Chat>('chats')
        .toCollection()
        .modify((chat) => {
          const result = migrateProviderSettingsRow(
            chat.settings,
            chat.settings.profileId,
            chat.settings.model,
            {
              endpointsByKey,
              privacyByKey,
              profilesById,
            },
          )
          if (result.changed) chat.settings = result.settings
        })

      await tx
        .table<ChatPreset>('presets')
        .toCollection()
        .modify((preset) => {
          const result = migrateProviderSettingsRow(
            preset.settings,
            preset.connectionProfileId,
            preset.settings.model,
            { endpointsByKey, privacyByKey, profilesById },
          )
          if (result.changed) preset.settings = result.settings
        })
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
      const endpointsRows = await tx.table<CachedEndpointsRow>('endpoints').toArray()
      const privacyRows = await tx.table<CachedPrivacyPolicyRow>('privacyPolicies').toArray()
      const profiles = await tx.table<ConnectionProfile>('profiles').toArray()
      const endpointsByKey = new Map<string, CachedEndpointsRow>()
      const privacyByKey = new Map<string, CachedPrivacyPolicyRow>()
      const profilesById = new Map(profiles.map((profile) => [profile.id, profile]))
      for (const row of endpointsRows)
        endpointsByKey.set(providerCacheKey(row.profileId, row.modelId), row)
      for (const row of privacyRows)
        privacyByKey.set(providerCacheKey(row.profileId, row.modelId), row)

      await tx
        .table<Chat>('chats')
        .toCollection()
        .modify((chat) => {
          const result = migrateProviderSettingsRow(
            chat.settings,
            chat.settings.profileId,
            chat.settings.model,
            {
              endpointsByKey,
              privacyByKey,
              profilesById,
            },
          )
          if (result.changed) chat.settings = result.settings
        })

      await tx
        .table<ChatPreset>('presets')
        .toCollection()
        .modify((preset) => {
          const result = migrateProviderSettingsRow(
            preset.settings,
            preset.connectionProfileId,
            preset.settings.model,
            { endpointsByKey, privacyByKey, profilesById },
          )
          if (result.changed) preset.settings = result.settings
        })
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

      const headers = await tx.table<MessageHeaderRow>('messages').toArray()
      const headersById = new Map(headers.map((header) => [header.id, header]))
      await tx
        .table<MessageBodyRow>('messageBodies')
        .toCollection()
        .modify((body) => {
          const migrated = migrateProviderOutputItemsFromGeneration(
            headersById.get(body.id)?.generation,
            (body as { providerOutputItems?: unknown }).providerOutputItems,
          )
          if (migrated) {
            ;(
              body as MessageBodyRow & {
                providerOutputItems: typeof migrated
              }
            ).providerOutputItems = migrated
          }
        })
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
      const profileRows = await tx.table<ConnectionProfile>('profiles').toArray()
      const profilesById = new Map(profileRows.map((profile) => [profile.id, profile]))

      await tx
        .table<Chat>('chats')
        .toCollection()
        .modify((chat) => {
          const result = migrateProviderApiModeSettings(
            chat.settings,
            profilesById.get(chat.settings.profileId),
          )
          if (result.changed) chat.settings = result.settings
        })

      await tx
        .table<ChatPreset>('presets')
        .toCollection()
        .modify((preset) => {
          const profile = profilesById.get(preset.connectionProfileId)
          const result = migrateProviderApiModeSettings(preset.settings, profile)
          const profileChanged = result.settings.profileId !== preset.connectionProfileId
          if (result.changed || profileChanged) {
            preset.settings = { ...result.settings, profileId: preset.connectionProfileId }
          }
        })

      await tx
        .table<ConnectionProfile>('profiles')
        .toCollection()
        .modify((profile) => {
          const result = migrateProviderApiModeProfile(profile)
          if (!result.changed) return
          const row = profile as ConnectionProfile & Record<string, unknown>
          Object.assign(row, result.profile)
          delete row.usesResponsesApiByDefault
          delete row.geminiMode
          delete row.responsesDefaults
          delete row.geminiDefaults
        })
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
      const table = tx.table<ChatPreset>('presets')
      const rows = await table.toArray()
      rows.sort((left, right) => {
        const bySort =
          numberOr(left.sortIndex, left.createdAt) - numberOr(right.sortIndex, right.createdAt)
        if (bySort !== 0) return bySort
        const byCreatedAt = left.createdAt - right.createdAt
        return byCreatedAt !== 0 ? byCreatedAt : left.id.localeCompare(right.id)
      })
      await table.bulkPut(rows.map((row, sortIndex) => ({ ...row, sortIndex })))
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
}

function organizationDefaultsPatch(
  chat: Chat & Record<string, unknown>,
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

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

const PREVIEW_MAX_CHARS = 240

async function computePreviewText(
  db: NatterDb,
  rows: readonly MessageHeaderRow[],
): Promise<string> {
  let earliestHeader: MessageHeaderRow | undefined
  for (const header of rows) {
    if (header.deleted || header.role !== 'user') continue
    if (!earliestHeader || header.createdAt < earliestHeader.createdAt) earliestHeader = header
  }
  if (!earliestHeader) return ''
  const body = await db.messageBodies.get(earliestHeader.id)
  const parts: string[] = []
  for (const item of body?.content ?? []) {
    if (item.type === 'text' || item.type === 'output_text') parts.push(item.text)
  }
  const trimmed = parts.join('').replace(/\s+/g, ' ').trim()
  return trimmed.length > PREVIEW_MAX_CHARS
    ? `${trimmed.slice(0, PREVIEW_MAX_CHARS - 1)}…`
    : trimmed
}

function extensionFromFilename(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const filename = value.split(/[\\/]/).pop() ?? value
  const dot = filename.lastIndexOf('.')
  if (dot <= 0 || dot === filename.length - 1) return undefined
  return filename.slice(dot + 1).toLowerCase()
}

function storageBlobId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const storage = value as { kind?: unknown; blobId?: unknown }
  return storage.kind === 'local-blob' && typeof storage.blobId === 'string'
    ? storage.blobId
    : undefined
}

function legacyBlob(value: unknown): Blob | undefined {
  if (value instanceof Blob) return value
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as { size?: unknown; arrayBuffer?: unknown; type?: unknown }
  if (typeof candidate.size !== 'number' || typeof candidate.arrayBuffer !== 'function') {
    return undefined
  }
  return value as Blob
}

export function childListKey(chatId: string, parentId: string | null): string {
  return `${chatId}:${parentId ?? '__root__'}`
}

let singleton: NatterDb | null = null
let organizationFieldsBackfillPromise: Promise<void> | null = null
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
export async function openDb(): Promise<NatterDb> {
  const db = getDb()
  if (!db.isOpen()) await db.open()
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
  organizationFieldsBackfillPromise ??= backfillOrganizationFields(db).catch((err) => {
    organizationFieldsBackfillPromise = null
    throw err
  })
  await organizationFieldsBackfillPromise
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

  const { chats, messageHeaders } = await db.transaction('r', db.chats, db.messages, async () => {
    const chatRows = await db.chats.toArray()
    const headers = await db.messages.toArray()
    return { chats: chatRows, messageHeaders: headers }
  })
  const messagesByChat = new Map<string, MessageHeaderRow[]>()
  for (const message of messageHeaders) {
    const list = messagesByChat.get(message.chatId) ?? []
    list.push(message)
    messagesByChat.set(message.chatId, list)
  }

  const chatPatches: Array<{ chat: Chat; patch: Partial<Chat> }> = []
  for (const chat of chats) {
    const rows = messagesByChat.get(chat.id) ?? []
    const nextLeafId = findLastUpdatedLeafId(rows as unknown as Message[])
    const branchHeaders =
      nextLeafId !== null
        ? (buildBranchMessages(rows as unknown as Message[], nextLeafId) as MessageHeaderRow[])
        : []
    const messageBodies =
      branchHeaders.length > 0
        ? (await db.messageBodies.bulkGet(branchHeaders.map((message) => message.id))).filter(
            (row): row is MessageBodyRow => row !== undefined,
          )
        : []
    const branch = hydrateMessages(branchHeaders, messageBodies)
    const totalCostUsd = rows.reduce(
      (total, message) => total + (message.deleted ? 0 : (message.generation?.cost ?? 0)),
      0,
    )
    const patch = organizationDefaultsPatch(chat as Chat & Record<string, unknown>, rows, {
      lastUpdatedLeafId: nextLeafId,
      previewText:
        chat.previewText === undefined ? await computePreviewText(db, rows) : chat.previewText,
      wordCount: countMessagesWords(branch),
      totalCostUsd,
    })
    if (patch) chatPatches.push({ chat, patch })
  }

  await db.transaction('rw', db.chats, db.settings, async () => {
    const patchedChats = chatPatches.map(({ chat, patch }) => ({ ...chat, ...patch }))
    if (patchedChats.length > 0) await db.chats.bulkPut(patchedChats)
    await db.settings.put(organizationFieldsBackfillMarker())
  })
}
