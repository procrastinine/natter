// Dexie schema + open/close. Schema kept in lockstep with `plan/03-storage.md §3.1`.
//
// The module exports a single default-name singleton for production. Tests that
// need isolation use `createDbForTests(name)` to mint a uniquely-named instance
// and close it when they're done.

import Dexie, { type Table } from 'dexie'
import type {
  Attachment,
  Chat,
  ChatBranchCache,
  ChatFolder,
  ChatPreset,
  ChatTag,
  ConnectionProfile,
  DraftRow,
  KeyRecord,
  Message,
  PresetResolution,
} from '../core/types'

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
  attachments!: Table<Attachment, string>
  profiles!: Table<ConnectionProfile, string>
  presets!: Table<ChatPreset, string>
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
}

let singleton: NatterDb | null = null

export function getDb(): NatterDb {
  if (!singleton) singleton = new NatterDb()
  return singleton
}

// Explicit open — resolves when the underlying IDBDatabase is ready and the
// schema has settled. Safe to call repeatedly; Dexie caches the open call.
export async function openDb(): Promise<NatterDb> {
  const db = getDb()
  if (!db.isOpen()) await db.open()
  return db
}

// Test-only reset so unit tests can swap in their own jsdom-backed IDB.
export function __resetDbForTests(): void {
  if (singleton) {
    singleton.close()
    singleton = null
  }
}

// Mint a uniquely-named Dexie instance for integration tests that want to
// assert migrations or multi-chat concurrency without polluting the singleton.
// Caller is responsible for `await db.delete()` on teardown.
export function createDbForTests(name: string): NatterDb {
  return new NatterDb(name)
}
