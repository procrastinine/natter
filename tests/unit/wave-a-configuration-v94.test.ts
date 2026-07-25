import Dexie from 'dexie'
import { afterEach, describe, expect, it } from 'vitest'
import {
  migrateWaveAConfigurationAndChatRowsV94,
  WAVE_A_V94_STORES,
} from '../../src/backcompat/wave-a-storage-epoch-v94'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type {
  Chat,
  ChatPreset,
  ConnectionProfile,
  KeyRecord,
  PromptPreset,
} from '../../src/core/types'
import type { ConfigurationLink } from '../../src/store/configuration-domain-contract'
import {
  type PresetOrderBlockRow,
  type PresetOrderStateRow,
  readPresetOrderIds,
} from '../../src/store/preset-order'

const databaseNames: string[] = []

afterEach(async () => {
  await Promise.all(databaseNames.splice(0).map((name) => Dexie.delete(name)))
})

describe('Wave A v94 configuration and chat migration', () => {
  it('normalizes one bounded pass and rebuilds ordered projections from canonical rows', async () => {
    const name = `wave-a-v94-configuration-${crypto.randomUUID()}`
    databaseNames.push(name)
    const legacy = legacyConfigurationDatabase(name)
    await legacy.open()
    await legacy.table('profiles').put(profile())
    await legacy.table('keys').put(key())
    const presets = Array.from({ length: 131 }, (_, index) => preset(index))
    await legacy.table('presets').bulkPut(presets)
    await legacy.table('promptPresets').put(promptPreset())
    await legacy.table('chats').put(chat())
    legacy.close()

    const db = legacyConfigurationDatabase(name)
    db.version(2).stores(WAVE_A_V94_STORES).upgrade(migrateWaveAConfigurationAndChatRowsV94)
    await db.open()

    expect((await db.table<ConnectionProfile>('profiles').get('profile-1'))?.requestRevision).toBe(
      0,
    )
    expect((await db.table<KeyRecord>('keys').get('key-1'))?.materialRevision).toBe(0)
    const storedPresets = await db.table<ChatPreset>('presets').toArray()
    expect(storedPresets).toHaveLength(131)
    expect(
      storedPresets.every(
        (row) =>
          row.settings.profileId === row.connectionProfileId && !Object.hasOwn(row, 'sortIndex'),
      ),
    ).toBe(true)
    const storedChat = await db.table<Chat & Record<string, unknown>>('chats').get('chat-1')
    expect(storedChat).toMatchObject({
      structuralVersion: 0,
      configurationVersion: 0,
      temporary: true,
      archivedKey: 0,
      temporaryKey: 1,
    })

    const orderState = await db.table<PresetOrderStateRow>('presetOrderState').get('active')
    expect(orderState).toMatchObject({ exactCount: 130 })
    const blocks = await db.table<PresetOrderBlockRow>('presetOrderBlocks').toArray()
    expect(blocks).toHaveLength(3)
    expect(blocks.every((block) => typeof block.id === 'string')).toBe(true)
    expect(blocks.every((block) => block.presetIds.length <= 64)).toBe(true)
    expect(await db.table('presetOrderMembership').count()).toBe(130)
    expect(await db.table('configurationProfileCatalogRows').count()).toBe(1)
    expect(await db.table('configurationPresetCatalogRows').count()).toBe(131)
    expect(await db.table('configurationPromptPresetCatalogRows').count()).toBe(1)
    const expectedLinkIds = [
      'profile:profile-1:primary-key',
      'profile:profile-1:fallback-key:0',
      'profile:profile-1:fallback-key:1',
      ...presets.map((row) => `chat-preset:${row.id}:profile`),
      'chat:chat-1:profile',
    ].sort()
    expect(
      (await db.table<ConfigurationLink>('configurationLinks').toArray())
        .map((row) => row.id)
        .sort(),
    ).toEqual(expectedLinkIds)
    expect(await db.table('configurationProfileUsageRows').get('profile-1')).toEqual({
      id: 'profile-1',
      presetCount: 131,
      activePresetCount: 130,
      chatCount: 1,
      activeChatCount: 1,
    })
    expect(await db.table('configurationCatalogAggregates').toArray()).toEqual(
      expect.arrayContaining([
        { id: 'global', totalProfileCount: 1 },
        { id: 'profiles:active', revision: 0, exactCount: 1 },
        { id: 'profiles:manager', revision: 0, exactCount: 1 },
        { id: 'prompt-presets:system', revision: 0, exactCount: 1 },
        { id: 'prompt-presets:append', revision: 0, exactCount: 0 },
        { id: 'prompt-presets:continue-system', revision: 0, exactCount: 0 },
        { id: 'prompt-presets:continue-user', revision: 0, exactCount: 0 },
        { id: 'prompt-presets:prefill', revision: 0, exactCount: 0 },
      ]),
    )
    expect(await db.table('configurationCatalogAggregates').count()).toBe(8)
    expect(
      (await db.table('presetOrderBlocks').toCollection().primaryKeys()).every(
        (key) => typeof key === 'string',
      ),
    ).toBe(true)
    expect(
      await db.transaction('r', db.table('presetOrderState'), db.table('presetOrderBlocks'), (tx) =>
        readPresetOrderIds(tx),
      ),
    ).toEqual(
      presets
        .slice(0, 130)
        .reverse()
        .map((row) => row.id),
    )
    db.close()
  })

  it('preserves a structurally valid current order instead of applying legacy ranks again', async () => {
    const name = `wave-a-v94-configuration-${crypto.randomUUID()}`
    databaseNames.push(name)
    const legacy = legacyConfigurationDatabase(name)
    await legacy.open()
    await legacy.table('profiles').put(profile())
    await legacy.table('presets').bulkPut([preset(0), preset(1)])
    await legacy.table('presetOrderState').put({
      id: 'active',
      revision: 9,
      exactCount: 2,
      headBlockId: 'block-1',
      tailBlockId: 'block-1',
    })
    await legacy.table('presetOrderBlocks').put({
      id: 'block-1',
      previousBlockId: null,
      nextBlockId: null,
      presetIds: ['preset-001', 'preset-000'],
    })
    legacy.close()

    const db = legacyConfigurationDatabase(name)
    db.version(2).stores(WAVE_A_V94_STORES).upgrade(migrateWaveAConfigurationAndChatRowsV94)
    await db.open()

    expect(await db.table('presetOrderState').get('active')).toEqual({
      id: 'active',
      revision: 9,
      exactCount: 2,
      headBlockId: 'block-1',
      tailBlockId: 'block-1',
    })
    expect(await db.table('presetOrderBlocks').toArray()).toEqual([
      {
        id: 'block-1',
        previousBlockId: null,
        nextBlockId: null,
        presetIds: ['preset-001', 'preset-000'],
      },
    ])
    expect(await db.table('presetOrderMembership').toArray()).toEqual([
      { presetId: 'preset-000', blockId: 'block-1' },
      { presetId: 'preset-001', blockId: 'block-1' },
    ])
    db.close()
  })

  it('rebuilds a structurally valid chain when its active preset set is incomplete', async () => {
    const name = `wave-a-v94-configuration-${crypto.randomUUID()}`
    databaseNames.push(name)
    const legacy = legacyConfigurationDatabase(name)
    await legacy.open()
    await legacy.table('profiles').put(profile())
    await legacy.table('presets').bulkPut([preset(0), preset(1), preset(2)])
    await legacy.table('presetOrderState').put({
      id: 'active',
      revision: 9,
      exactCount: 1,
      headBlockId: 'block-1',
      tailBlockId: 'block-1',
    })
    await legacy.table('presetOrderBlocks').put({
      id: 'block-1',
      previousBlockId: null,
      nextBlockId: null,
      presetIds: ['preset-001'],
    })
    legacy.close()

    const db = legacyConfigurationDatabase(name)
    db.version(2).stores(WAVE_A_V94_STORES).upgrade(migrateWaveAConfigurationAndChatRowsV94)
    await db.open()

    expect(await db.table('presetOrderState').get('active')).toMatchObject({
      revision: 10,
      exactCount: 3,
    })
    expect(
      await db.transaction('r', db.table('presetOrderState'), db.table('presetOrderBlocks'), (tx) =>
        readPresetOrderIds(tx),
      ),
    ).toEqual(['preset-002', 'preset-001', 'preset-000'])
    expect(
      (await db.table('presetOrderBlocks').toCollection().primaryKeys()).every(
        (key) => typeof key === 'string',
      ),
    ).toBe(true)
    db.close()
  })
})

function legacyConfigurationDatabase(name: string): Dexie {
  const db = new Dexie(name)
  db.version(1).stores({
    profiles: '&id',
    keys: '&id',
    presets: '&id',
    promptPresets: '&id',
    chats: '&id',
    presetOrderState: '&id',
    presetOrderBlocks: '&id',
    presetOrderMembership: '&presetId',
  })
  return db
}

function profile(): ConnectionProfile {
  return {
    id: 'profile-1',
    name: 'OpenRouter',
    kind: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyRef: 'key-1',
    apiKeyFallbackRefs: ['key-2', 'key-2', 'key-3'],
    defaultHeaders: {},
    appTitle: 'natter',
    appUrl: '',
    supportsEndpointsApi: true,
    supportsGenerationApi: true,
    supportsPrivacyScrape: true,
    createdAt: 1,
    updatedAt: 1,
  }
}

function key(): KeyRecord {
  return {
    id: 'key-1',
    name: 'Key',
    ciphertext: 'ciphertext',
    iv: 'iv',
    salt: 'salt',
    algorithm: 'AES-GCM-256',
    kdf: { name: 'PBKDF2', iterations: 200000, hash: 'SHA-256' },
    obscuredPreview: '••••',
    createdAt: 1,
  }
}

function preset(index: number): ChatPreset & { sortIndex: number } {
  return {
    id: `preset-${String(index).padStart(3, '0')}`,
    name: `Preset ${index}`,
    connectionProfileId: 'profile-1',
    settings: { ...cloneDefaultChatSettings(), profileId: 'wrong-profile' },
    createdAt: index + 1,
    updatedAt: index + 1,
    archived: index === 130,
    sortIndex: 130 - index,
  }
}

function promptPreset(): PromptPreset {
  return {
    id: 'prompt-1',
    kind: 'system',
    name: 'System',
    text: 'You are concise.',
    createdAt: 1,
    updatedAt: 1,
  }
}

function chat(): Chat {
  return {
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
    structuralVersion: Number.NaN,
    configurationVersion: Number.NaN,
    settings: { ...cloneDefaultChatSettings(), profileId: 'profile-1' },
    lastUpdatedLeafId: null,
    lastBranchUpdatedAt: 0,
    archived: false,
    pinned: false,
    folderId: null,
    tags: [],
  }
}
