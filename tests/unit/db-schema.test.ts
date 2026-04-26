import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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

// Unique DB name per test so migrations start from a clean slate. We delete
// any pre-existing data at the top of each test so repeated runs don't pick
// up stale state from fake-indexeddb's in-memory persistence.
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
        'messages',
        'models',
        'presets',
        'presetResolutions',
        'privacyPolicies',
        'profiles',
        'promptPresets',
        'providers',
        'settings',
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

// Synthetic post-schema upgrades exercised through plain Dexie instances. We avoid
// subclassing (which trips "Type instantiation is excessively deep" under the
// NatterDb branded Table types) and declare versions directly on the base Db.

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
  db.version(7)
    .stores({ profiles: 'id, name, kind, lastUsedAt, archived' })
    .upgrade(async (tx) => {
      await tx
        .table<MinimalProfile>('profiles')
        .toCollection()
        .modify((row) => {
          if (row.appTitle === undefined) row.appTitle = 'Natter'
        })
    })
  db.version(8)
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
    expect(db.verno).toBe(8)
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
    expect(up.verno).toBe(8)
    const profile = await up.table<MinimalProfile>('profiles').get('P1')
    expect(profile?.appTitle).toBe('CustomTitle') // preserved — synthetic bump only fills undefined
    const tag = await up.table<MinimalSetting>('settings').get('schemaTag')
    expect(tag?.value).toBe('preexisting') // later synthetic bump only seeds when absent
    up.close()

    const reopen = new Dexie(name)
    registerV1Through3(reopen)
    await reopen.open()
    expect(reopen.verno).toBe(8)
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
    expect(chat?.settings.privacy.ignoreProviders).toEqual([])
    expect(chat?.settings.privacy.onlyProviders).toEqual([])
    expect(chat?.settings.providerPrefs?.ignoreOverridesFilter).toBe(true)
    expect(chat?.settings.providerPrefs?.ignore).toEqual(['anthropic', 'anthropic/2'])
    expect(preset?.settings.privacy.ignoreProviders).toEqual([])
    expect(preset?.settings.providerPrefs?.ignore).toEqual(['anthropic', 'anthropic/2'])
    await migrated.delete()
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
    expect(emptyMessage?.attachmentRefs).toEqual([])

    const prototypeMessage = await migrated.messages.get('msg-proto')
    expect(prototypeMessage?.attachmentRefs).toEqual([
      expect.objectContaining({
        refId: 'legacy:msg-proto:0',
        attachmentId: 'att-old',
        includeInContext: true,
        presentation: {},
      }),
    ])

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
    await db.table<Message>('messages').bulkPut([
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
    ])

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
  })
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
