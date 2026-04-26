// Dexie schema + open/close. Schema kept in lockstep with `plan/03-storage.md §3.1`.
//
// The module exports a single default-name singleton for production. Tests that
// need isolation use `createDbForTests(name)` to mint a uniquely-named instance
// and close it when they're done.

import Dexie, { type Table } from 'dexie'
import { normalizeEndpointsResponse } from '../api/providers'
import { readCachedPrivacyPayload } from '../api/privacy-scrape'
import { migrateLegacyProviderSettings } from '../core/provider-settings-migration'
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
  MessageAttachmentRef,
  PresetResolution,
  PromptPreset,
} from '../core/types'
import {
  DEFAULT_CONTINUE_SYSTEM_PROMPT,
  DEFAULT_CONTINUE_USER_PROMPT,
} from '../core/global-settings'

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

export interface CachedGenerationRow {
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
  messages!: Table<Message, string>
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

  db.version(3)
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
      const endpointsByKey = new Map<string, CachedEndpointsRow>()
      const privacyByKey = new Map<string, CachedPrivacyPolicyRow>()
      for (const row of endpointsRows) endpointsByKey.set(providerCacheKey(row.profileId, row.modelId), row)
      for (const row of privacyRows) privacyByKey.set(providerCacheKey(row.profileId, row.modelId), row)

      await tx
        .table<Chat>('chats')
        .toCollection()
        .modify((chat) => {
          const result = migrateSettingsRow(chat.settings, chat.settings.profileId, chat.settings.model, {
            endpointsByKey,
            privacyByKey,
          })
          if (result.changed) chat.settings = result.settings
        })

      await tx
        .table<ChatPreset>('presets')
        .toCollection()
        .modify((preset) => {
          const result = migrateSettingsRow(
            preset.settings,
            preset.connectionProfileId,
            preset.settings.model,
            { endpointsByKey, privacyByKey },
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
      await settings.where('key').anyOf([
        'global:continue-system-prompt',
        'global:continue-user-prompt',
        'global:continue-prompt',
      ]).delete()
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
      attachmentJobs: 'id, attachmentId, processorId, status, updatedAt, [attachmentId+processorId+inputHash]',
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
}

function migrateSettingsRow(
  settings: Chat['settings'],
  profileId: string,
  modelId: string,
  caches: {
    endpointsByKey: ReadonlyMap<string, CachedEndpointsRow>
    privacyByKey: ReadonlyMap<string, CachedPrivacyPolicyRow>
  },
): ReturnType<typeof migrateLegacyProviderSettings> {
  const key = providerCacheKey(profileId, modelId)
  const endpoints = normalizeEndpointsResponse(caches.endpointsByKey.get(key)?.payload)?.endpoints
  const policies = readCachedPrivacyPayload(caches.privacyByKey.get(key)?.payload)?.policies
  const context: Parameters<typeof migrateLegacyProviderSettings>[1] = { model: modelId }
  if (endpoints) context.endpoints = endpoints
  if (policies) context.policies = policies
  return migrateLegacyProviderSettings(settings, context)
}

function providerCacheKey(profileId: string, modelId: string): string {
  return `${profileId}\u0000${modelId}`
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
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

function normalizeLegacyAttachmentRefs(
  value: unknown,
  owner: { messageId?: string; draftChatId?: string; createdAt: number },
): MessageAttachmentRef[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value
    .map((raw, index): MessageAttachmentRef | undefined => {
      if (typeof raw === 'string') {
        return {
          refId: `legacy:${owner.messageId ?? owner.draftChatId ?? 'unknown'}:${index}`,
          attachmentId: raw,
          includeInContext: true,
          presentation: {},
          createdAt: owner.createdAt,
          updatedAt: owner.createdAt,
        }
      }
      if (!raw || typeof raw !== 'object') return undefined
      const ref = raw as Partial<MessageAttachmentRef>
      if (typeof ref.attachmentId !== 'string') return undefined
      return {
        refId:
          typeof ref.refId === 'string'
            ? ref.refId
            : `legacy:${owner.messageId ?? owner.draftChatId ?? 'unknown'}:${index}`,
        attachmentId: ref.attachmentId,
        includeInContext: ref.includeInContext !== false,
        presentation: ref.presentation ?? {},
        ...(ref.tokenEstimate ? { tokenEstimate: ref.tokenEstimate } : {}),
        ...(ref.missingResolution ? { missingResolution: ref.missingResolution } : {}),
        createdAt: numberOr(ref.createdAt, owner.createdAt),
        updatedAt: numberOr(ref.updatedAt, owner.createdAt),
        ...(typeof ref.deletedAt === 'number' ? { deletedAt: ref.deletedAt } : {}),
      }
    })
    .filter((ref): ref is MessageAttachmentRef => ref !== undefined)
}

export function childListKey(chatId: string, parentId: string | null): string {
  return `${chatId}:${parentId ?? '__root__'}`
}

let singleton: NatterDb | null = null
let providerSettingsBackfillPromise: Promise<void> | null = null

export function getDb(): NatterDb {
  if (!singleton) singleton = new NatterDb()
  return singleton
}

// Explicit open — resolves when the underlying IDBDatabase is ready and the
// schema has settled. Safe to call repeatedly; Dexie caches the open call.
export async function openDb(): Promise<NatterDb> {
  const db = getDb()
  if (!db.isOpen()) await db.open()
  providerSettingsBackfillPromise ??= backfillProviderSettings(db).catch((err) => {
    providerSettingsBackfillPromise = null
    throw err
  })
  await providerSettingsBackfillPromise
  return db
}

// Test-only reset so unit tests can swap in their own jsdom-backed IDB.
export function __resetDbForTests(): void {
  if (singleton) {
    singleton.close()
    singleton = null
  }
  providerSettingsBackfillPromise = null
}

// Mint a uniquely-named Dexie instance for integration tests that want to
// assert migrations or multi-chat concurrency without polluting the singleton.
// Caller is responsible for `await db.delete()` on teardown.
export function createDbForTests(name: string): NatterDb {
  return new NatterDb(name)
}

export async function backfillProviderSettingsForModel(
  profileId: string,
  modelId: string,
): Promise<void> {
  await runProviderSettingsBackfill(getDb(), { profileId, modelId })
}

async function backfillProviderSettings(db: NatterDb): Promise<void> {
  await runProviderSettingsBackfill(db)
}

async function runProviderSettingsBackfill(
  db: NatterDb,
  scope?: { profileId: string; modelId: string },
): Promise<void> {
  const [endpointsRows, privacyRows] = await Promise.all([
    scope
      ? db.endpoints.where('[profileId+modelId]').equals([scope.profileId, scope.modelId]).toArray()
      : db.endpoints.toArray(),
    scope
      ? db.privacyPolicies.where('[profileId+modelId]').equals([scope.profileId, scope.modelId]).toArray()
      : db.privacyPolicies.toArray(),
  ])
  const endpointsByKey = new Map<string, CachedEndpointsRow>()
  const privacyByKey = new Map<string, CachedPrivacyPolicyRow>()
  for (const row of endpointsRows) endpointsByKey.set(providerCacheKey(row.profileId, row.modelId), row)
  for (const row of privacyRows) privacyByKey.set(providerCacheKey(row.profileId, row.modelId), row)

  await db.transaction('rw', db.chats, db.presets, async () => {
    const chats = scope
      ? db.chats
          .filter(
            (chat) =>
              chat.settings.profileId === scope.profileId && chat.settings.model === scope.modelId,
          )
      : db.chats.toCollection()
    const presets = scope
      ? db.presets
          .filter(
            (preset) =>
              preset.connectionProfileId === scope.profileId &&
              preset.settings.model === scope.modelId,
          )
      : db.presets.toCollection()
    await chats.modify((chat) => {
      const result = migrateSettingsRow(chat.settings, chat.settings.profileId, chat.settings.model, {
        endpointsByKey,
        privacyByKey,
      })
      if (result.changed) chat.settings = result.settings
    })
    await presets.modify((preset) => {
      const result = migrateSettingsRow(
        preset.settings,
        preset.connectionProfileId,
        preset.settings.model,
        { endpointsByKey, privacyByKey },
      )
      if (result.changed) preset.settings = result.settings
    })
  })
}
