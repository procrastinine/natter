import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assertNoInlineMessageBodies } from '../../src/backcompat/message-body-split'
import { migrateProviderOutputItemRows } from '../../src/backcompat/provider-output-items'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type { Chat, ChatPreset, Message } from '../../src/core/types'
import type { NatterDb } from '../../src/store/db'
import {
  __resetDbForTests,
  backfillOrganizationFields,
  createDbForTests,
  openDb,
  registerSchema,
} from '../../src/store/db'
import { splitMessageForStorage } from '../../src/store/message-storage'

// Unique DB name per test so migrations start from a clean slate. Pre-existing
// data is deleted at the top of each test so repeated runs don't pick up stale
// state from fake-indexeddb's in-memory persistence.
async function freshDb(name: string): Promise<NatterDb> {
  await Dexie.delete(name)
  return createDbForTests(name)
}

afterEach(() => {
  __resetDbForTests()
})

describe('Dexie schema', () => {
  beforeEach(async () => {
    await Dexie.delete('natter')
  })

  it('opens on a fresh IndexedDB with all declared tables', async () => {
    const db = await openDb()
    expect(db.isOpen()).toBe(true)
    const names = db.tables.map((t) => t.name).sort()
    expect(names).toEqual(
      [
        'attachmentArtifacts',
        'attachmentBlobs',
        'attachmentJobs',
        'attachments',
        'chatBranchCache',
        'chats',
        'childLists',
        'drafts',
        'endpoints',
        'folders',
        'generations',
        'keys',
        'messageBodies',
        'messages',
        'models',
        'presets',
        'presetResolutions',
        'privacyPolicies',
        'profiles',
        'promptPresets',
        'providers',
        'settings',
        'streamChunks',
        'streamLeases',
        'tags',
      ].sort(),
    )
  })

  it('is idempotent across repeated open calls', async () => {
    const a = await openDb()
    const b = await openDb()
    expect(a).toBe(b)
    expect(a.isOpen()).toBe(true)
  })

  it('reopens a previously-written DB and reads existing rows', async () => {
    const name = `natter-test-reopen-${Math.random().toString(36).slice(2)}`
    const first = await freshDb(name)
    await first.open()
    await first.settings.put({ key: 'hello', value: 'world' })
    first.close()

    const second = createDbForTests(name)
    await second.open()
    const row = await second.settings.get('hello')
    expect(row?.value).toBe('world')
    expect(second.tables.map((t) => t.name)).toContain('childLists')
    await second.delete()
  })
})

// Synthetic post-schema upgrades exercised through plain Dexie instances.
// Subclassing is avoided (it trips "Type instantiation is excessively deep" under
// the NatterDb branded Table types); versions are declared directly on the base Db.

interface MinimalProfile {
  id: string
  name: string
  appTitle?: string
  [k: string]: unknown
}
interface MinimalSetting {
  key: string
  value: unknown
}

function registerV1(db: Dexie): void {
  registerSchema(db)
}

function registerV1Through3(db: Dexie): void {
  registerSchema(db)
  db.version(17)
    .stores({ profiles: 'id, name, kind, lastUsedAt, archived' })
    .upgrade(async (tx) => {
      await tx
        .table<MinimalProfile>('profiles')
        .toCollection()
        .modify((row) => {
          if (row.appTitle === undefined) row.appTitle = 'Natter'
        })
    })
  db.version(18)
    .stores({ settings: '&key' })
    .upgrade(async (tx) => {
      const settings = tx.table<MinimalSetting>('settings')
      const existing = await settings.get('schemaTag')
      if (!existing) await settings.put({ key: 'schemaTag', value: 'v3' })
    })
}

function registerLegacyProviderPrefsV3(db: Dexie): void {
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
}

function registerLegacyAttachmentsV5(db: Dexie): void {
  db.version(5).stores({
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
}

function registerLegacyChatSettingsV14(db: Dexie): void {
  db.version(14).stores({
    chats:
      'id, updatedAt, createdAt, lastViewedAt, lastUpdatedLeafId, lastBranchUpdatedAt, wordCount, totalCostUsd, archived, pinned, presetId, folderId, *tags',
    presets: 'id, name, connectionProfileId, lastUsedAt, archived',
    profiles: 'id, name, kind, lastUsedAt, archived',
    settings: '&key',
  })
}

describe('Dexie migrations', () => {
  it('opens a fresh DB at the highest declared version without replaying upgrade callbacks', async () => {
    // Dexie's contract: on a truly fresh IDB, it creates the union of all
    // declared tables at the latest version and skips upgrade() callbacks —
    // there's no data to migrate. This test pins that contract so the
    // migration-backfill tests below can rely on "upgrades only fire when
    // transitioning from a lower on-disk version."
    const name = `natter-test-mig-fresh-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)
    const db = new Dexie(name)
    registerV1Through3(db)
    await db.open()
    expect(db.verno).toBe(18)
    expect(db.tables.map((t) => t.name).includes('settings')).toBe(true)
    const tag = await db.table<MinimalSetting>('settings').get('schemaTag')
    expect(tag).toBeUndefined()
    await db.delete()
  })

  it('is idempotent across re-opens — upgrade callbacks do not rerun on already-migrated data', async () => {
    const name = `natter-test-mig-reopen-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)

    const v1 = new Dexie(name)
    registerV1(v1)
    await v1.open()
    await v1.table<MinimalProfile>('profiles').put({
      id: 'P1',
      name: 'Existing',
      kind: 'openrouter',
      baseUrl: 'https://example',
      apiKeyRef: 'K1',
      defaultHeaders: {},
      appTitle: 'CustomTitle',
      appUrl: '',
      usesResponsesApiByDefault: false,
      supportsEndpointsApi: false,
      supportsGenerationApi: false,
      supportsPrivacyScrape: false,
      createdAt: 1,
      updatedAt: 1,
    })
    await v1.table<MinimalSetting>('settings').put({ key: 'schemaTag', value: 'preexisting' })
    v1.close()

    const up = new Dexie(name)
    registerV1Through3(up)
    await up.open()
    expect(up.verno).toBe(18)
    const profile = await up.table<MinimalProfile>('profiles').get('P1')
    expect(profile?.appTitle).toBe('CustomTitle') // preserved — synthetic bump only fills undefined
    const tag = await up.table<MinimalSetting>('settings').get('schemaTag')
    expect(tag?.value).toBe('preexisting') // later synthetic bump only seeds when absent
    up.close()

    const reopen = new Dexie(name)
    registerV1Through3(reopen)
    await reopen.open()
    expect(reopen.verno).toBe(18)
    const tag2 = await reopen.table<MinimalSetting>('settings').get('schemaTag')
    expect(tag2?.value).toBe('preexisting')
    await reopen.delete()
  })

  it('backfills defaults only for rows missing the field (second synthetic bump is a no-op when fields are present)', async () => {
    const name = `natter-test-mig-backfill-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)
    const v1 = new Dexie(name)
    registerV1(v1)
    await v1.open()
    await v1.table<MinimalProfile>('profiles').put({
      id: 'P2',
      name: 'Bare',
      kind: 'openrouter',
      baseUrl: 'https://example',
      apiKeyRef: 'K1',
      defaultHeaders: {},
      // deliberately omit appTitle — synthetic bump must set it
      appUrl: '',
      usesResponsesApiByDefault: false,
      supportsEndpointsApi: false,
      supportsGenerationApi: false,
      supportsPrivacyScrape: false,
      createdAt: 1,
      updatedAt: 1,
    })
    v1.close()

    const up = new Dexie(name)
    registerV1Through3(up)
    await up.open()
    const row = await up.table<MinimalProfile>('profiles').get('P2')
    expect(row?.appTitle).toBe('Natter') // synthetic bump backfilled
    await up.delete()
  })

  it('deletes the retired open-scroll preference during schema upgrade', async () => {
    const name = `natter-test-open-scroll-mig-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)

    const legacy = new Dexie(name)
    registerLegacyChatSettingsV14(legacy)
    await legacy.open()
    await legacy.table<MinimalSetting>('settings').bulkPut([
      { key: 'global:auto-scroll-open', value: false },
      { key: 'global:auto-scroll-stream', value: false },
    ])
    legacy.close()

    const migrated = createDbForTests(name)
    await migrated.open()
    expect(await migrated.settings.get('global:auto-scroll-open')).toBeUndefined()
    expect((await migrated.settings.get('global:auto-scroll-stream'))?.value).toBe(false)
    await migrated.delete()
  })

  it('migrates legacy privacy provider refs on chats and presets into providerPrefs', async () => {
    const name = `natter-test-provider-mig-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)
    const profileId = 'profile-1'
    const modelId = 'anthropic/claude-opus-4.7'
    const baseSettings = {
      ...cloneDefaultChatSettings(),
      profileId,
      model: modelId,
      privacy: {
        ...cloneDefaultChatSettings().privacy,
        ignoreProviders: ['Anthropic'],
        onlyProviders: [],
      },
    }

    const v3 = new Dexie(name)
    registerLegacyProviderPrefsV3(v3)
    await v3.open()
    await v3.table('endpoints').put({
      profileId,
      modelId,
      fetchedAt: 1,
      payload: {
        data: {
          id: modelId,
          endpoints: [
            legacyEndpoint('Amazon Bedrock', 'amazon-bedrock', {}),
            legacyEndpoint('Anthropic', 'anthropic', { requiresUserIDs: true }),
            legacyEndpoint('Anthropic', 'anthropic/2', { requiresUserIDs: true }),
          ],
        },
      },
    })
    await v3.table<Chat>('chats').put({
      id: 'chat-1',
      title: '',
      titleStatus: 'untitled',
      createdAt: 1,
      updatedAt: 1,
      lastViewedAt: 1,
      wordCount: 0,
      totalCostUsd: 0,
      metaVersion: 0,
      summaryVersion: 0,
      settings: structuredClone(baseSettings),
      lastUpdatedLeafId: null,
      lastBranchUpdatedAt: 1,
      archived: false,
      pinned: false,
      folderId: null,
      tags: [],
    })
    await v3.table<ChatPreset>('presets').put({
      id: 'preset-1',
      name: 'Preset',
      connectionProfileId: profileId,
      settings: structuredClone(baseSettings),
      createdAt: 1,
      updatedAt: 1,
    })
    v3.close()

    const migrated = createDbForTests(name)
    await migrated.open()
    const chat = await migrated.chats.get('chat-1')
    const preset = await migrated.presets.get('preset-1')
    expect('ignoreProviders' in (chat?.settings.privacy ?? {})).toBe(false)
    expect('onlyProviders' in (chat?.settings.privacy ?? {})).toBe(false)
    expect(chat?.settings.providerPrefs?.ignoreOverridesFilter).toBe(true)
    expect(chat?.settings.providerPrefs?.ignore).toEqual(['anthropic', 'anthropic/2'])
    expect('ignoreProviders' in (preset?.settings.privacy ?? {})).toBe(false)
    expect(preset?.settings.providerPrefs?.ignore).toEqual(['anthropic', 'anthropic/2'])
    await migrated.delete()
  })

  it('migrates missing OpenRouter provider sort on old chats and presets', async () => {
    const name = `natter-test-provider-sort-mig-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)
    const openRouterProfileId = 'profile-openrouter'
    const directProfileId = 'profile-direct'
    const baseSettings = cloneDefaultChatSettings()
    baseSettings.profileId = openRouterProfileId
    baseSettings.model = 'anthropic/claude-opus-4.7'
    baseSettings.privacy = {
      ...baseSettings.privacy,
      usePreferredOrdering: true,
    } as unknown as Chat['settings']['privacy']
    const directSettings = cloneDefaultChatSettings()
    directSettings.profileId = directProfileId
    directSettings.model = 'gpt-4o'
    directSettings.privacy = {
      ...directSettings.privacy,
      usePreferredOrdering: false,
    } as unknown as Chat['settings']['privacy']

    const legacy = new Dexie(name)
    registerLegacyAttachmentsV5(legacy)
    await legacy.open()
    await legacy.table('profiles').bulkPut([
      {
        id: openRouterProfileId,
        name: 'OpenRouter',
        kind: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKeyRef: 'K1',
        defaultHeaders: {},
        appTitle: 'Natter',
        appUrl: '',
        usesResponsesApiByDefault: false,
        supportsEndpointsApi: true,
        supportsGenerationApi: true,
        supportsPrivacyScrape: true,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: directProfileId,
        name: 'OpenAI',
        kind: 'openai-compatible',
        baseUrl: 'https://api.openai.com/v1',
        apiKeyRef: 'K2',
        defaultHeaders: {},
        appTitle: 'Natter',
        appUrl: '',
        usesResponsesApiByDefault: true,
        supportsEndpointsApi: false,
        supportsGenerationApi: false,
        supportsPrivacyScrape: false,
        createdAt: 1,
        updatedAt: 1,
      },
    ])
    await legacy.table<Chat>('chats').bulkPut([
      {
        id: 'chat-or',
        title: '',
        titleStatus: 'untitled',
        createdAt: 1,
        updatedAt: 1,
        lastViewedAt: 1,
        wordCount: 0,
        totalCostUsd: 0,
        metaVersion: 0,
        summaryVersion: 0,
        settings: structuredClone(baseSettings),
        lastUpdatedLeafId: null,
        lastBranchUpdatedAt: 1,
        archived: false,
        pinned: false,
        folderId: null,
        tags: [],
      },
      {
        id: 'chat-direct',
        title: '',
        titleStatus: 'untitled',
        createdAt: 1,
        updatedAt: 1,
        lastViewedAt: 1,
        wordCount: 0,
        totalCostUsd: 0,
        metaVersion: 0,
        summaryVersion: 0,
        settings: structuredClone(directSettings),
        lastUpdatedLeafId: null,
        lastBranchUpdatedAt: 1,
        archived: false,
        pinned: false,
        folderId: null,
        tags: [],
      },
    ])
    await legacy.table<ChatPreset>('presets').bulkPut([
      {
        id: 'preset-or',
        name: 'OpenRouter Preset',
        connectionProfileId: openRouterProfileId,
        settings: structuredClone(baseSettings),
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'preset-direct',
        name: 'Direct Preset',
        connectionProfileId: directProfileId,
        settings: structuredClone(directSettings),
        createdAt: 1,
        updatedAt: 1,
      },
    ])
    legacy.close()

    const migrated = createDbForTests(name)
    await migrated.open()
    const openRouterChat = await migrated.chats.get('chat-or')
    const openRouterPreset = await migrated.presets.get('preset-or')
    const directChat = await migrated.chats.get('chat-direct')
    const directPreset = await migrated.presets.get('preset-direct')

    expect(openRouterChat?.settings.providerPrefs).toEqual({ sort: 'price' })
    expect(openRouterPreset?.settings.providerPrefs).toEqual({ sort: 'price' })
    expect(directChat?.settings.providerPrefs).toBeUndefined()
    expect(directPreset?.settings.providerPrefs).toBeUndefined()
    expect('usePreferredOrdering' in (openRouterChat?.settings.privacy ?? {})).toBe(false)
    expect('usePreferredOrdering' in (openRouterPreset?.settings.privacy ?? {})).toBe(false)
    expect('usePreferredOrdering' in (directChat?.settings.privacy ?? {})).toBe(false)
    expect('usePreferredOrdering' in (directPreset?.settings.privacy ?? {})).toBe(false)
    await migrated.delete()
  })

  it('migrates legacy shared server-tool settings into provider-scoped buckets', async () => {
    const name = `natter-test-provider-tools-mig-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)
    const legacySettings = cloneDefaultChatSettings() as Chat['settings'] & {
      tools?: unknown
      enabledServerToolIds?: string[]
      toolChoice?: string
      parallelToolCalls?: boolean
    }
    delete (legacySettings as { tools?: unknown }).tools
    legacySettings.enabledServerToolIds = ['datetime', 'web-fetch']
    legacySettings.toolChoice = 'auto'
    legacySettings.parallelToolCalls = false

    const legacy = new Dexie(name)
    registerLegacyAttachmentsV5(legacy)
    await legacy.open()
    await legacy.table<Chat>('chats').put({
      id: 'chat-tools',
      title: '',
      titleStatus: 'untitled',
      createdAt: 1,
      updatedAt: 1,
      lastViewedAt: 1,
      wordCount: 0,
      totalCostUsd: 0,
      metaVersion: 0,
      summaryVersion: 0,
      settings: structuredClone(legacySettings),
      lastUpdatedLeafId: null,
      lastBranchUpdatedAt: 1,
      archived: false,
      pinned: false,
      folderId: null,
      tags: [],
    })
    await legacy.table<ChatPreset>('presets').put({
      id: 'preset-tools',
      name: 'Tools',
      connectionProfileId: 'profile-tools',
      settings: structuredClone(legacySettings),
      createdAt: 1,
      updatedAt: 1,
    })
    legacy.close()

    const migrated = createDbForTests(name)
    await migrated.open()
    const chat = await migrated.chats.get('chat-tools')
    const preset = await migrated.presets.get('preset-tools')

    expect(chat?.settings.tools.openrouter).toEqual({
      enabledServerToolIds: ['datetime', 'web-fetch'],
      toolChoice: 'auto',
      parallelToolCalls: false,
    })
    expect(preset?.settings.tools.openrouter).toEqual(chat?.settings.tools.openrouter)
    expect(chat?.settings.tools.openai).toEqual({ enabledServerToolIds: [] })
    expect(chat?.settings.tools.anthropic).toEqual({ enabledServerToolIds: [] })
    expect(chat?.settings.tools.google).toEqual({ enabledServerToolIds: [] })
    expect(chat?.settings.toolCallContext).toEqual({ include: true })
    expect(preset?.settings.toolCallContext).toEqual({ include: true })
    expect('enabledServerToolIds' in ((chat?.settings ?? {}) as Record<string, unknown>)).toBe(
      false,
    )
    expect('toolChoice' in ((chat?.settings ?? {}) as Record<string, unknown>)).toBe(false)
    expect('parallelToolCalls' in ((chat?.settings ?? {}) as Record<string, unknown>)).toBe(false)
    await migrated.delete()
  })

  it('completes chat and preset settings snapshots in the v15 schema migration', async () => {
    const name = `natter-test-chat-settings-snapshot-mig-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)
    const profileId = 'profile-settings-snapshot'
    const legacySettings = cloneDefaultChatSettings() as Chat['settings'] & {
      enabledServerToolIds?: string[]
      toolChoice?: string
    }
    legacySettings.profileId = profileId
    legacySettings.model = 'openai/gpt-5.4-nano'
    legacySettings.reasoning = {
      mode: 'default',
      exclude: false,
      summary: 'auto',
      carryForward: 'plaintext',
    } as unknown as Chat['settings']['reasoning']
    legacySettings.privacy = {
      ...legacySettings.privacy,
      usePreferredOrdering: true,
    } as unknown as Chat['settings']['privacy']
    legacySettings.tools = {
      openai: {
        enabledServerToolIds: ['web-search'],
        config: { 'web-search': { includeSources: true } },
      },
    } as unknown as Chat['settings']['tools']
    legacySettings.enabledServerToolIds = ['datetime']
    legacySettings.toolChoice = 'auto'
    delete (legacySettings as Partial<Chat['settings']>).toolCallContext
    delete (legacySettings as Partial<Chat['settings']>).defaultPrefill
    delete (legacySettings as Partial<Chat['settings']>).continuePrefill
    delete (legacySettings as Partial<Chat['settings']>).mediaEchoN
    delete (legacySettings as Partial<Chat['settings']>).toolContextSummarizeAfterN
    delete (legacySettings as Partial<Chat['settings']>).serviceTier

    const legacy = new Dexie(name)
    registerLegacyChatSettingsV14(legacy)
    await legacy.open()
    await legacy.table('profiles').put({
      id: profileId,
      name: 'OpenRouter',
      kind: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKeyRef: 'K1',
      defaultHeaders: {},
      appTitle: 'Natter',
      appUrl: '',
      usesResponsesApiByDefault: false,
      supportsEndpointsApi: true,
      supportsGenerationApi: true,
      supportsPrivacyScrape: true,
      createdAt: 1,
      updatedAt: 1,
    })
    await legacy.table<Chat>('chats').put({
      id: 'chat-settings-snapshot',
      title: '',
      titleStatus: 'untitled',
      createdAt: 1,
      updatedAt: 1,
      lastViewedAt: 1,
      wordCount: 0,
      totalCostUsd: 0,
      metaVersion: 0,
      summaryVersion: 0,
      settings: structuredClone(legacySettings),
      lastUpdatedLeafId: null,
      lastBranchUpdatedAt: 1,
      archived: false,
      pinned: false,
      folderId: null,
      tags: [],
    })
    const presetSettings = structuredClone(legacySettings)
    presetSettings.profileId = 'stale-profile'
    await legacy.table<ChatPreset>('presets').put({
      id: 'preset-settings-snapshot',
      name: 'Snapshot',
      connectionProfileId: profileId,
      settings: presetSettings,
      createdAt: 1,
      updatedAt: 1,
    })
    legacy.close()

    const migrated = createDbForTests(name)
    await migrated.open()
    expect(migrated.verno).toBe(16)
    const chat = await migrated.chats.get('chat-settings-snapshot')
    const preset = await migrated.presets.get('preset-settings-snapshot')
    for (const settings of [chat?.settings, preset?.settings]) {
      expect(settings?.defaultPrefill).toBe('')
      expect(settings?.continuePrefill).toBe(false)
      expect(settings?.mediaEchoN).toBe(5)
      expect(settings?.toolContextSummarizeAfterN).toBe(6)
      expect(settings?.toolCallContext).toEqual({ include: true })
      expect(settings?.serviceTier).toBe('auto')
      expect(settings?.tools.openrouter).toEqual({
        enabledServerToolIds: ['datetime'],
        toolChoice: 'auto',
      })
      expect(settings?.tools.openai).toEqual({
        enabledServerToolIds: ['web-search'],
        config: { 'web-search': { includeSources: true } },
      })
      expect(settings?.tools.anthropic).toEqual({ enabledServerToolIds: [] })
      expect(settings?.tools.google).toEqual({ enabledServerToolIds: [] })
      expect(settings?.reasoning.include).toEqual({
        encrypted: false,
        summary: true,
        text: true,
      })
      expect('carryForward' in ((settings?.reasoning ?? {}) as Record<string, unknown>)).toBe(false)
      expect('usePreferredOrdering' in ((settings?.privacy ?? {}) as Record<string, unknown>)).toBe(
        false,
      )
      expect('enabledServerToolIds' in ((settings ?? {}) as Record<string, unknown>)).toBe(false)
      expect('toolChoice' in ((settings ?? {}) as Record<string, unknown>)).toBe(false)
    }
    expect(preset?.settings.profileId).toBe(profileId)
    await migrated.delete()
  })

  it('adds provider output items to message bodies during the provider-tools schema migration', async () => {
    const name = `natter-test-provider-output-items-mig-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)
    const legacy = new Dexie(name)
    registerLegacyAttachmentsV5(legacy)
    await legacy.open()
    await legacy.table<Chat>('chats').put({
      id: 'chat-provider-output',
      title: '',
      titleStatus: 'untitled',
      createdAt: 1,
      updatedAt: 1,
      lastViewedAt: 1,
      wordCount: 0,
      totalCostUsd: 0,
      metaVersion: 0,
      summaryVersion: 0,
      settings: cloneDefaultChatSettings(),
      lastUpdatedLeafId: 'a1',
      lastBranchUpdatedAt: 1,
      archived: false,
      pinned: false,
      folderId: null,
      tags: [],
    })
    await legacy.table<Message>('messages').put({
      id: 'a1',
      chatId: 'chat-provider-output',
      parentId: null,
      siblingIndex: 0,
      turnId: 'turn-a1',
      turnIndex: 1,
      createdAt: 1,
      role: 'assistant',
      origin: 'generated',
      content: [{ type: 'output_text', text: '55' }],
      generation: {
        id: 'gen-a1',
        model: 'gpt-5.4-nano',
        requestedModel: 'gpt-5.4-nano',
        apiUsed: 'responses',
        delivery: 'streaming',
        costSource: 'stream',
        startedAt: 1,
        finishedAt: 2,
        serverTools: [
          {
            type: 'code_interpreter_call',
            source: 'responses-output',
            id: 'ci_1',
            status: 'completed',
            outputIndex: 0,
            output: {
              id: 'ci_1',
              type: 'code_interpreter_call',
              status: 'completed',
              code: 'sum(i*i for i in range(6))',
              outputs: [{ type: 'logs', logs: '55' }],
            },
          },
        ],
      },
      nodeVersion: 0,
      deleted: false,
    })
    legacy.close()

    const migrated = createDbForTests(name)
    await migrated.open()
    const body = await migrated.messageBodies.get('a1')
    expect(body?.providerOutputItems).toEqual([
      {
        dialect: 'openai-responses',
        type: 'code_interpreter_call',
        outputIndex: 0,
        item: {
          id: 'ci_1',
          type: 'code_interpreter_call',
          status: 'completed',
          code: 'sum(i*i for i in range(6))',
          outputs: [{ type: 'logs', logs: '55' }],
        },
      },
    ])
    await migrated.delete()
  })

  it('backfills provider output items once on an already-current schema', async () => {
    const name = `natter-test-provider-output-items-backfill-${Math.random().toString(36).slice(2)}`
    const db = await freshDb(name)
    await db.open()
    const message = {
      id: 'a1',
      chatId: 'chat-provider-output',
      parentId: null,
      siblingIndex: 0,
      turnId: 'turn-a1',
      turnIndex: 1,
      createdAt: 1,
      role: 'assistant',
      origin: 'generated',
      content: [{ type: 'output_text', text: '55' }],
      generation: {
        id: 'gen-a1',
        model: 'gpt-5.4-nano',
        requestedModel: 'gpt-5.4-nano',
        apiUsed: 'responses',
        delivery: 'streaming',
        costSource: 'stream',
        startedAt: 1,
        finishedAt: 2,
        serverTools: [
          {
            type: 'code_interpreter_call',
            source: 'responses-output',
            id: 'ci_1',
            status: 'completed',
            outputIndex: 0,
            output: {
              id: 'ci_1',
              type: 'code_interpreter_call',
              status: 'completed',
              code: 'sum(i*i for i in range(6))',
              outputs: [{ type: 'logs', logs: '55' }],
            },
          },
        ],
      },
      nodeVersion: 0,
      deleted: false,
    } as Message
    const { header, body } = splitMessageForStorage(message)
    delete body.providerOutputItems
    await db.messages.put(header)
    await db.messageBodies.put(body)
    await db.settings.delete('backfill:provider-output-items-v1')

    await migrateProviderOutputItemRows(db)
    await migrateProviderOutputItemRows(db)

    expect((await db.settings.get('backfill:provider-output-items-v1'))?.value).toBe(1)
    expect((await db.messageBodies.get('a1'))?.providerOutputItems).toEqual([
      {
        dialect: 'openai-responses',
        type: 'code_interpreter_call',
        outputIndex: 0,
        item: {
          id: 'ci_1',
          type: 'code_interpreter_call',
          status: 'completed',
          code: 'sum(i*i for i in range(6))',
          outputs: [{ type: 'logs', logs: '55' }],
        },
      },
    ])
    await db.delete()
  })

  it('migrates old attachment-free and prototype attachment IndexedDB rows automatically', async () => {
    const name = `natter-test-attachments-mig-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)

    const legacy = new Dexie(name)
    registerLegacyAttachmentsV5(legacy)
    await legacy.open()
    await legacy.table<Chat>('chats').put({
      id: 'chat-old',
      title: 'Old chat',
      titleStatus: 'untitled',
      createdAt: 1,
      updatedAt: 1,
      lastViewedAt: 1,
      wordCount: 0,
      totalCostUsd: 0,
      metaVersion: 0,
      summaryVersion: 0,
      settings: cloneDefaultChatSettings(),
      lastUpdatedLeafId: 'msg-proto',
      lastBranchUpdatedAt: 1,
      archived: false,
      pinned: false,
      folderId: null,
      tags: [],
    })
    await legacy.table('messages').bulkPut([
      {
        id: 'msg-empty',
        chatId: 'chat-old',
        parentId: null,
        siblingIndex: 0,
        turnId: 'turn-empty',
        turnIndex: 0,
        createdAt: 2,
        role: 'user',
        origin: 'user',
        content: [{ type: 'text', text: 'old text-only message' }],
        nodeVersion: 0,
        deleted: false,
      },
      {
        id: 'msg-proto',
        chatId: 'chat-old',
        parentId: 'msg-empty',
        siblingIndex: 0,
        turnId: 'turn-proto',
        turnIndex: 0,
        createdAt: 3,
        role: 'user',
        origin: 'user',
        content: [{ type: 'text', text: 'old attachment message' }],
        attachmentRefs: ['att-old'],
        nodeVersion: 0,
        deleted: false,
      },
    ])
    await legacy.table('drafts').put({
      chatId: 'chat-old',
      text: 'legacy draft',
      attachmentRefs: ['att-old'],
      updatedAt: 4,
    })
    await legacy.table('attachments').put({
      id: 'att-old',
      contentHash: 'hash-old',
      kind: 'file',
      mime: 'text/plain',
      filename: 'old.txt',
      sizeBytes: 3,
      createdAt: 5,
      blob: new Blob(['old']),
      refCount: 0,
    })
    legacy.close()

    const migrated = createDbForTests(name)
    await migrated.open()
    expect(migrated.tables.map((t) => t.name)).toEqual(
      expect.arrayContaining(['attachmentBlobs', 'attachmentArtifacts', 'attachmentJobs']),
    )

    const emptyMessage = await migrated.messages.get('msg-empty')
    expect(Object.hasOwn(emptyMessage ?? {}, 'content')).toBe(false)
    expect(emptyMessage?.attachmentRefs).toEqual([])
    expect(await migrated.messageBodies.get('msg-empty')).toMatchObject({
      id: 'msg-empty',
      chatId: 'chat-old',
      content: [{ type: 'text', text: 'old text-only message' }],
    })

    const prototypeMessage = await migrated.messages.get('msg-proto')
    expect(Object.hasOwn(prototypeMessage ?? {}, 'content')).toBe(false)
    expect(prototypeMessage?.attachmentRefs).toEqual([
      expect.objectContaining({
        refId: 'legacy:msg-proto:0',
        attachmentId: 'att-old',
        includeInContext: true,
        presentation: {},
      }),
    ])
    expect(await migrated.messageBodies.get('msg-proto')).toMatchObject({
      id: 'msg-proto',
      chatId: 'chat-old',
      content: [{ type: 'text', text: 'old attachment message' }],
    })
    await expect(assertNoInlineMessageBodies(migrated)).resolves.toBeUndefined()

    const draft = await migrated.drafts.get('chat-old')
    expect(draft?.attachmentRefs).toEqual([
      expect.objectContaining({
        refId: 'legacy:chat-old:0',
        attachmentId: 'att-old',
        includeInContext: true,
      }),
    ])

    const attachment = await migrated.attachments.get('att-old')
    expect(attachment).toMatchObject({
      id: 'att-old',
      contentHash: 'hash-old',
      kind: 'other',
      origin: 'import',
      artifacts: [],
      processing: [],
      refCount: 2,
    })
    expect(Object.hasOwn(attachment ?? {}, 'blob')).toBe(false)

    // Real browser IndexedDB preserves Blob values; fake-indexeddb's older
    // structured clone path may not. Either path is compatible: bytes migrate
    // when available, otherwise the stored object becomes a recoverable
    // missing attachment instead of breaking old chats.
    if (attachment?.storage.kind === 'local-blob') {
      expect(attachment.storage.blobId).toBe('att-old:original')
      const blob = await migrated.attachmentBlobs.get('att-old:original')
      expect(blob).toMatchObject({
        id: 'att-old:original',
        attachmentId: 'att-old',
        role: 'original',
        contentHash: 'hash-old',
        sizeBytes: 3,
      })
    } else {
      expect(attachment?.storage).toMatchObject({
        kind: 'missing',
        reason: 'import-missing',
      })
      expect(await migrated.attachmentBlobs.count()).toBe(0)
    }

    await migrated.delete()
  })

  it('backfills legacy chat organization fields idempotently without materializing cache rows', async () => {
    const name = `natter-test-org-backfill-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)
    const db = await freshDb(name)
    await db.open()
    const chatRows = db.table<Record<string, unknown>>('chats')
    await chatRows.bulkPut([
      {
        id: 'empty',
        title: '',
        createdAt: 1,
        updatedAt: 5,
        metaVersion: 0,
        summaryVersion: 0,
        settings: cloneDefaultChatSettings(),
        lastUpdatedLeafId: 'old-leaf',
        wordCount: 123,
        totalCostUsd: 999,
        archived: false,
        pinned: false,
      },
      {
        id: 'titled',
        title: 'Model title',
        createdAt: 1,
        updatedAt: 6,
        metaVersion: 0,
        summaryVersion: 0,
        settings: cloneDefaultChatSettings(),
        archived: false,
        pinned: false,
      },
      {
        id: 'legacy-default',
        title: 'Untitled chat',
        createdAt: 1,
        updatedAt: 6,
        metaVersion: 0,
        summaryVersion: 0,
        settings: cloneDefaultChatSettings(),
        archived: false,
        pinned: false,
      },
      {
        id: 'imported',
        title: 'Imported title',
        createdAt: 1,
        updatedAt: 7,
        metaVersion: 0,
        summaryVersion: 0,
        settings: cloneDefaultChatSettings(),
        archived: false,
        pinned: false,
      },
      {
        id: 'pinned-archived',
        title: 'Pinned archive',
        createdAt: 1,
        updatedAt: 8,
        metaVersion: 0,
        summaryVersion: 0,
        settings: cloneDefaultChatSettings(),
        archived: true,
        pinned: true,
      },
      {
        id: 'branchy',
        title: 'Branch',
        createdAt: 1,
        updatedAt: 9,
        metaVersion: 0,
        summaryVersion: 0,
        settings: cloneDefaultChatSettings(),
        archived: false,
        pinned: false,
      },
      {
        id: 'tombstoned-descendants',
        title: 'Tombstones',
        createdAt: 1,
        updatedAt: 10,
        metaVersion: 0,
        summaryVersion: 0,
        settings: cloneDefaultChatSettings(),
        archived: false,
        pinned: false,
      },
    ])
    const messages = [
      legacyMessage({ id: 'i1', chatId: 'imported', origin: 'imported', text: 'imported text' }),
      legacyMessage({ id: 'root', chatId: 'branchy', text: 'root text', createdAt: 1, cost: 0.1 }),
      legacyMessage({
        id: 'old-leaf',
        chatId: 'branchy',
        parentId: 'root',
        siblingIndex: 0,
        text: 'old leaf',
        createdAt: 2,
        cost: 0.2,
      }),
      legacyMessage({
        id: 'new-leaf',
        chatId: 'branchy',
        parentId: 'root',
        siblingIndex: 1,
        text: 'new leaf',
        createdAt: 3,
        cost: 0.3,
      }),
      legacyMessage({
        id: 'tomb-root',
        chatId: 'tombstoned-descendants',
        text: 'live root',
        createdAt: 1,
        cost: 0.4,
      }),
      legacyMessage({
        id: 'tomb-child',
        chatId: 'tombstoned-descendants',
        parentId: 'tomb-root',
        text: 'deleted child',
        createdAt: 5,
        cost: 1,
        deleted: true,
      }),
      legacyMessage({
        id: 'tomb-grandchild',
        chatId: 'tombstoned-descendants',
        parentId: 'tomb-child',
        text: 'deleted grandchild',
        createdAt: 6,
        cost: 1,
        deleted: true,
      }),
    ]
    const splitMessages = messages.map((message) => splitMessageForStorage(message))
    await db.messages.bulkPut(splitMessages.map((message) => message.header))
    await db.messageBodies.bulkPut(splitMessages.map((message) => message.body))
    await db.messageBodies.delete('old-leaf')
    await db.settings.delete('backfill:organization-fields-v1')

    await backfillOrganizationFields(db)
    await backfillOrganizationFields(db)

    const empty = await db.chats.get('empty')
    expect(empty).toMatchObject({
      folderId: null,
      tags: [],
      titleStatus: 'untitled',
      lastViewedAt: 5,
      lastUpdatedLeafId: null,
      lastBranchUpdatedAt: 0,
      wordCount: 0,
      totalCostUsd: 0,
    })
    expect((await db.chats.get('titled'))?.titleStatus).toBe('auto')
    expect((await db.chats.get('legacy-default'))?.titleStatus).toBe('untitled')
    expect((await db.chats.get('imported'))?.titleStatus).toBe('untitled')
    expect(await db.chats.get('pinned-archived')).toMatchObject({
      archived: true,
      pinned: true,
      folderId: null,
      tags: [],
    })
    const branchy = await db.chats.get('branchy')
    expect(branchy).toMatchObject({
      lastUpdatedLeafId: 'new-leaf',
      wordCount: 4,
      totalCostUsd: 0.6,
    })
    expect(await db.chats.get('tombstoned-descendants')).toMatchObject({
      lastUpdatedLeafId: 'tomb-root',
      wordCount: 2,
      totalCostUsd: 0.4,
    })
    expect((await db.settings.get('backfill:organization-fields-v1'))?.value).toBe(1)
    expect(await db.chatBranchCache.count()).toBe(0)
    await db.delete()
  })

  it('backfills organization fields on an empty DB and a 1000-chat DB', async () => {
    const emptyName = `natter-test-org-empty-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(emptyName)
    const empty = await freshDb(emptyName)
    await empty.open()
    await backfillOrganizationFields(empty)
    expect(await empty.chats.count()).toBe(0)
    expect((await empty.settings.get('backfill:organization-fields-v1'))?.value).toBe(1)
    await empty.delete()

    const bulkName = `natter-test-org-1000-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(bulkName)
    const db = await freshDb(bulkName)
    await db.open()
    await db.table<Record<string, unknown>>('chats').bulkPut(
      Array.from({ length: 1000 }, (_, index) => ({
        id: `bulk-${index}`,
        title: index % 2 === 0 ? '' : `Bulk ${index}`,
        createdAt: index,
        updatedAt: index + 10,
        metaVersion: 0,
        summaryVersion: 0,
        settings: cloneDefaultChatSettings(),
        archived: index % 3 === 0,
        pinned: index % 5 === 0,
      })),
    )
    await db.settings.delete('backfill:organization-fields-v1')

    await backfillOrganizationFields(db)

    expect(await db.chats.count()).toBe(1000)
    expect(await db.chats.get('bulk-0')).toMatchObject({
      titleStatus: 'untitled',
      lastViewedAt: 10,
      lastUpdatedLeafId: null,
      folderId: null,
      tags: [],
      archived: true,
      pinned: true,
    })
    expect(await db.chats.get('bulk-999')).toMatchObject({
      titleStatus: 'auto',
      lastViewedAt: 1009,
      wordCount: 0,
      totalCostUsd: 0,
      archived: true,
      pinned: false,
    })
    expect(await db.chatBranchCache.count()).toBe(0)
    expect((await db.settings.get('backfill:organization-fields-v1'))?.value).toBe(1)
    await db.delete()
  }, 15_000)
})

function legacyEndpoint(
  provider_name: string,
  tag: string,
  policyOverrides: Record<string, unknown>,
): Record<string, unknown> {
  return {
    provider_name,
    tag,
    supported_parameters: ['provider', 'temperature'],
    context_length: 200_000,
    pricing: {},
    data_policy: {
      training: false,
      trainingOpenRouter: false,
      retainsPrompts: false,
      canPublish: false,
      termsOfServiceURL: '',
      privacyPolicyURL: '',
      ...policyOverrides,
    },
  }
}

function legacyMessage(input: {
  id: string
  chatId: string
  parentId?: string | null
  siblingIndex?: number
  text: string
  origin?: Message['origin']
  createdAt?: number
  cost?: number
  deleted?: boolean
}): Message {
  return {
    id: input.id,
    chatId: input.chatId,
    parentId: input.parentId ?? null,
    siblingIndex: input.siblingIndex ?? 0,
    turnId: `turn-${input.id}`,
    turnIndex: 0,
    createdAt: input.createdAt ?? 1,
    role: 'user',
    origin: input.origin ?? 'user',
    content: [{ type: 'text', text: input.text }],
    ...(input.cost !== undefined
      ? {
          generation: {
            id: `gen-${input.id}`,
            model: 'test',
            requestedModel: 'test',
            apiUsed: 'chat' as const,
            delivery: 'buffered' as const,
            cost: input.cost,
            costSource: 'estimated' as const,
            startedAt: 1,
          },
        }
      : {}),
    nodeVersion: 0,
    deleted: input.deleted ?? false,
  }
}
