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
