import Dexie from 'dexie'
import { afterEach, describe, expect, it } from 'vitest'
import { migrateWaveADerivedRowsV94 } from '../../src/backcompat/wave-a-derived-storage-v94'
import {
  finalizeWaveAStorageEpochRowsV94,
  migrateWaveAStorageEpochRowsV94,
  migrateWaveAStorageSingletonsV94,
  WAVE_A_V94_STORES,
  type WaveAStorageEpochMigrationCapabilitiesV94,
  type WaveAStorageSingletonMigrationResultV94,
} from '../../src/backcompat/wave-a-storage-epoch-v94'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import { RECENT_MODEL_RECENCY_KEY } from '../../src/core/global-settings'
import { tokenCalibrationKey } from '../../src/core/model-ids'
import {
  EMPTY_TEXT_TEMPLATE,
  LEGACY_SAVED_TEXT_TEMPLATES_KEY,
  type SavedTextTemplate,
} from '../../src/core/text-templates'
import type {
  Chat,
  ChildListState,
  GlobalTokenCalibration,
  Message,
  TextTemplateId,
} from '../../src/core/types'
import { waveACompletionSettingsV94 } from '../../src/store/browser-workspace-schema-v94'
import {
  BROWSER_WORKSPACE_CURRENT_COMPLETION_KEY,
  WAVE_B_V97_STORES,
} from '../../src/store/browser-workspace-schema-v97'
import {
  type ChatSidebarProjectionRow,
  chatSidebarFolderKey,
  isValidChatSidebarProjectionRow,
  isValidChatSidebarWorkspaceAggregateRow,
} from '../../src/store/chat-sidebar-projection'
import {
  CURRENT_DB_VERSION,
  createDbForTests,
  prepareBrowserWorkspaceSchema,
} from '../../src/store/db'
import type { SettingsRow } from '../../src/store/db-rows'
import { type MessageHeaderRow, splitMessageForStorage } from '../../src/store/message-storage'
import {
  BROWSER_WORKSPACE_CATCHUP_JOURNAL_TABLE_NAMES,
  BROWSER_WORKSPACE_CATCHUP_SOURCE_TABLE_NAMES,
} from '../../src/store/physical-storage-tables'
import type { WorkspaceFence } from '../../src/store/repository'
import type { StorageRetentionStateRow } from '../../src/store/storage-retention-state'
import {
  OBSERVED_WAVE_A_PHYSICAL_BOUNDARIES,
  observedWaveAStorageCohorts,
  observedWaveAStoreSpec,
} from '../helpers/wave-a-observed-storage-v25-v93'

const databaseNames: string[] = []
const OBSERVED_WAVE_B_V96_STORES = Object.freeze({
  ...WAVE_A_V94_STORES,
  ...Object.fromEntries(
    BROWSER_WORKSPACE_CATCHUP_SOURCE_TABLE_NAMES.map((tableName) => [
      `replacementCatchup__${tableName}`,
      '&id',
    ]),
  ),
})

afterEach(async () => {
  await Promise.all(databaseNames.splice(0).map((name) => Dexie.delete(name)))
})

describe('Wave A final storage epoch migration', () => {
  it('partitions v25-v93 into exactly the 35 observed physical manifests', () => {
    const cohorts = observedWaveAStorageCohorts()
    expect(cohorts).toHaveLength(35)
    expect(cohorts.map(({ firstVersion }) => firstVersion)).toEqual([
      ...OBSERVED_WAVE_A_PHYSICAL_BOUNDARIES,
    ])
    expect(
      cohorts.flatMap(({ firstVersion, lastVersion }) =>
        Array.from({ length: lastVersion - firstVersion + 1 }, (_, index) => firstVersion + index),
      ),
    ).toEqual(Array.from({ length: 93 - 25 + 1 }, (_, index) => 25 + index))

    const signatures = cohorts.map(({ firstVersion }) => observedStorageManifestJson(firstVersion))
    expect(new Set(signatures)).toHaveLength(35)
    expect(fnv1a32(observedStorageManifestJson(25))).toBe('fnv1a32:80d67d7e')

    const finalObserved = observedWaveAStoreSpec(87)
    expect(observedWaveAStoreSpec(93)).toEqual(finalObserved)
    expect(finalObserved).not.toEqual(normalizedStoreSpec(WAVE_A_V94_STORES))
    expect(Object.keys(finalObserved).sort()).toEqual(
      Object.keys(activeStoreSpec(WAVE_A_V94_STORES)).sort(),
    )
  })

  it('opens every committed-wave physical manifest through the one production cutover', async () => {
    const expectedTables = Object.keys(activeStoreSpec(WAVE_B_V97_STORES)).sort()
    const completionKeys = [
      ...waveACompletionSettingsV94().map((row) => row.key),
      BROWSER_WORKSPACE_CURRENT_COMPLETION_KEY,
    ]

    for (const { firstVersion, lastVersion } of observedWaveAStorageCohorts()) {
      const name = databaseName()
      const legacy = new Dexie(name)
      legacy.version(firstVersion).stores(observedWaveAStoreSpec(firstVersion))
      await legacy.open()
      await legacy.table('settings').put({
        key: 'manifest-proof:canonical-sentinel',
        value: { firstVersion, lastVersion },
      })
      legacy.close()

      const db = createDbForTests(name)
      await prepareBrowserWorkspaceSchema(db)
      await db.open()

      expect(db.verno, `observed v${firstVersion}-v${lastVersion}`).toBe(CURRENT_DB_VERSION)
      expect(
        db.tables.map((table) => table.name).sort(),
        `observed v${firstVersion}-v${lastVersion}`,
      ).toEqual(expectedTables)
      expect(
        await db.settings.bulkGet(completionKeys),
        `observed v${firstVersion}-v${lastVersion}`,
      ).not.toContain(undefined)
      expect(await db.settings.get('manifest-proof:canonical-sentinel')).toEqual({
        key: 'manifest-proof:canonical-sentinel',
        value: { firstVersion, lastVersion },
      })
      db.close()
    }
  }, 60_000)

  it.each([94, 94.1])(
    'opens the observed intermediate v%s manifest through the final production cutover',
    async (intermediateVersion) => {
      const name = databaseName()
      const intermediate = new Dexie(name)
      intermediate.version(intermediateVersion).stores(WAVE_A_V94_STORES)
      await intermediate.open()
      await intermediate.table('settings').put({
        key: 'manifest-proof:intermediate-sentinel',
        value: { intermediateVersion },
      })
      intermediate.close()

      const db = createDbForTests(name)
      await prepareBrowserWorkspaceSchema(db)
      await db.open()

      expect(db.verno).toBe(CURRENT_DB_VERSION)
      expect(await db.settings.get('manifest-proof:intermediate-sentinel')).toEqual({
        key: 'manifest-proof:intermediate-sentinel',
        value: { intermediateVersion },
      })
      expect(
        await db.settings.bulkGet(waveACompletionSettingsV94().map((row) => row.key)),
      ).not.toContain(undefined)
      db.close()
    },
  )

  it.each([95, 95.1, 95.2, 95.3, 95.4, 95.5, 95.6, 95.7, 95.8, 96])(
    'opens observed current v%s data through the one fixed Wave-B epoch and reopens it in place',
    async (observedVersion) => {
      const name = databaseName()
      const observed = new Dexie(name)
      observed
        .version(observedVersion)
        .stores(observedVersion === 96 ? OBSERVED_WAVE_B_V96_STORES : WAVE_A_V94_STORES)
      await observed.open()
      await observed.table('settings').put({
        key: 'manifest-proof:wave-b-sentinel',
        value: { observedVersion },
      })
      observed.close()

      const migrated = createDbForTests(name)
      await prepareBrowserWorkspaceSchema(migrated)
      await migrated.open()

      expect(migrated.verno).toBe(CURRENT_DB_VERSION)
      expect(migrated.tables.map((table) => table.name).sort()).toEqual(
        Object.keys(activeStoreSpec(WAVE_B_V97_STORES)).sort(),
      )
      expect(await migrated.settings.get('manifest-proof:wave-b-sentinel')).toEqual({
        key: 'manifest-proof:wave-b-sentinel',
        value: { observedVersion },
      })
      expect(
        await Promise.all(
          BROWSER_WORKSPACE_CATCHUP_JOURNAL_TABLE_NAMES.map((tableName) =>
            migrated.table(tableName).count(),
          ),
        ),
      ).toEqual(BROWSER_WORKSPACE_CATCHUP_JOURNAL_TABLE_NAMES.map(() => 0))
      expect(await migrated.settings.get(BROWSER_WORKSPACE_CURRENT_COMPLETION_KEY)).toBeDefined()
      migrated.close()

      const reopened = createDbForTests(name)
      await prepareBrowserWorkspaceSchema(reopened)
      await reopened.open()
      expect(reopened.verno).toBe(CURRENT_DB_VERSION)
      expect(await reopened.settings.get('manifest-proof:wave-b-sentinel')).toEqual({
        key: 'manifest-proof:wave-b-sentinel',
        value: { observedVersion },
      })
      reopened.close()
    },
  )

  it('atomically rolls back a late mixed 4,096-row cutover and retries the same production database', async () => {
    const name = databaseName()
    const oversizedSource = 'x'.repeat(4 * 1024 * 1024 + 1)
    const legacyTemplates = Array.from({ length: 4_096 }, (_, index) =>
      savedTemplate(
        `user:legacy-${index}`,
        index === 2 ? oversizedSource : `legacy source ${index}`,
        index === 1 ? 30 : 10,
      ),
    )
    const currentNewer = savedTemplate('user:legacy-0', 'current newer', 40)
    const currentOlder = savedTemplate('user:legacy-1', 'current older', 20)
    const currentOnly = savedTemplate('user:current-only', 'current only', 50)

    const legacy = new Dexie(name)
    legacy.version(87).stores(observedWaveAStoreSpec(87))
    await legacy.open()
    await Promise.all([
      legacy.table('settings').bulkPut([
        {
          key: LEGACY_SAVED_TEXT_TEMPLATES_KEY,
          value: legacyTemplates,
        },
        {
          key: 'workspace-meta',
          value: { workspaceId: 'rollback-workspace', replacementEpoch: 3 },
        },
        { key: 'global:auto-scroll', value: true },
      ]),
      legacy.table('workspaceFence').put({
        id: 'global',
        workspaceId: 'rollback-workspace',
        replacementEpoch: 3,
      }),
      legacy.table('textTemplates').bulkPut([currentNewer, currentOlder, currentOnly]),
    ])
    legacy.close()

    const migrated = createDbForTests(name)
    const finalMarkerKey = waveACompletionSettingsV94()[0]?.key
    const failFinalMarker = (key: unknown) => {
      if (key === finalMarkerKey) throw new Error('InjectedWaveAFinalizationFailure')
    }
    migrated.settings.hook.creating.subscribe(failFinalMarker)
    await prepareBrowserWorkspaceSchema(migrated)
    await expect(migrated.open()).rejects.toThrow('InjectedWaveAFinalizationFailure')
    migrated.close()

    const inspector = new Dexie(name)
    inspector.version(87).stores(observedWaveAStoreSpec(87))
    await inspector.open()
    expect(inspector.verno).toBe(87)
    const settings = inspector.table<SettingsRow, string>('settings')
    const rolledBackLegacy = (await settings.get(LEGACY_SAVED_TEXT_TEMPLATES_KEY)) as
      | { value: SavedTextTemplate[] }
      | undefined
    const rolledBackTemplates = await inspector
      .table<SavedTextTemplate, TextTemplateId>('textTemplates')
      .toArray()
    const rolledBackWorkspaceMeta = await settings.get('workspace-meta')
    const rolledBackAutoScroll = await settings.get('global:auto-scroll')
    const rolledBackFence = await inspector
      .table<WorkspaceFence, string>('workspaceFence')
      .get('global')
    const rolledBackMarkers = await settings.bulkGet(
      waveACompletionSettingsV94().map((row) => row.key),
    )
    inspector.close()

    expect(rolledBackLegacy?.value).toHaveLength(4_096)
    const oversizedTemplate = rolledBackLegacy?.value.at(2)
    if (!oversizedTemplate) throw new Error('Expected oversized legacy template')
    expect(oversizedTemplate.config.template).toHaveLength(oversizedSource.length)
    expect(rolledBackTemplates.sort(byTemplateId)).toEqual(
      [currentNewer, currentOlder, currentOnly].sort(byTemplateId),
    )
    expect(rolledBackWorkspaceMeta).toEqual({
      key: 'workspace-meta',
      value: { workspaceId: 'rollback-workspace', replacementEpoch: 3 },
    })
    expect(rolledBackAutoScroll).toEqual({
      key: 'global:auto-scroll',
      value: true,
    })
    expect(rolledBackFence).toEqual({
      id: 'global',
      workspaceId: 'rollback-workspace',
      replacementEpoch: 3,
    })
    expect(rolledBackMarkers).toEqual(waveACompletionSettingsV94().map(() => undefined))

    migrated.settings.hook.creating.unsubscribe(failFinalMarker)
    await migrated.open()
    expect(migrated.verno).toBe(CURRENT_DB_VERSION)
    expect(
      await migrated.settings.bulkGet(waveACompletionSettingsV94().map((row) => row.key)),
    ).toEqual(waveACompletionSettingsV94())
    expect(await migrated.settings.get(LEGACY_SAVED_TEXT_TEMPLATES_KEY)).toBeUndefined()
    expect(await migrated.textTemplates.count()).toBe(4_097)
    expect(await migrated.textTemplates.get(currentNewer.id)).toEqual(currentNewer)
    expect(await migrated.textTemplates.get(currentOlder.id)).toEqual(legacyTemplates[1])
    expect(await migrated.textTemplates.get(currentOnly.id)).toEqual(currentOnly)
    expect(
      (await migrated.textTemplates.get(legacyTemplates[2]?.id as TextTemplateId))?.config.template,
    ).toHaveLength(oversizedSource.length)
    expect(await migrated.settings.get('workspace-meta')).toBeUndefined()
    expect(await migrated.settings.get('global:auto-scroll')).toBeUndefined()
    expect((await migrated.settings.get('global:auto-scroll-stream'))?.value).toBe(true)
    migrated.close()
  }, 60_000)

  it('normalizes exact singleton rows without scanning or overwriting user settings', async () => {
    const name = databaseName()
    const legacy = legacyDatabase(name)
    await legacy.open()
    await legacy.table('settings').bulkPut([
      {
        key: 'workspace-meta',
        value: { workspaceId: 'workspace-preserved', replacementEpoch: 7 },
      },
      { key: 'backfill:current-schema-manifest-v1', value: 'stale' },
      { key: 'global:auto-scroll', value: true },
      { key: 'global:auto-scroll-open', value: false },
      { key: 'sidebar:sort-key', value: 'updated-desc' },
      {
        key: 'global:pinned-models',
        value: [
          'openai/gpt-5.4',
          'anthropic/claude-opus-4.7',
          'deepseek/deepseek-v4-pro',
          'google/gemini-3.1-pro-preview',
          'google/gemini-3.1-flash-lite-preview',
        ],
      },
      { key: 'global:recent-models', value: ['model-b', 'model-a'] },
      { key: 'unrelated:user-setting', value: { retained: true } },
      {
        key: 'storage-compaction-state-v1',
        value: {
          formatVersion: 1,
          knownReclaimableBytes: 100,
          lastCompactedLiveBytes: 50,
          requestRevision: 3,
        },
      },
    ])
    await legacy.table('browserLocks').bulkPut([
      { name: 'workspace-writer', ownerClientId: 'stale' },
      { name: 'unexpected', ownerClientId: 'stale' },
    ])
    await legacy.table('storageRetentionState').put({ task: 'stale', phase: 'active' })
    legacy.close()

    const { db, result } = await upgradeDatabase(name)
    expect(result.requiresCompactionControlTransfer).toBe(true)
    expect(result.delayedMarkers.map((row) => row.key)).toEqual([
      'backfill:global-settings-v1',
      'backfill:pinned-model-default-v2',
      'backfill:recent-model-recency-v1',
    ])
    expect(await db.table('workspaceFence').toArray()).toEqual([
      { id: 'global', workspaceId: 'workspace-preserved', replacementEpoch: 7 },
    ])
    expect(await db.table('browserLocks').toArray()).toEqual([
      {
        name: 'workspace-writer',
        ownerClientId: null,
        leaseId: null,
        fencingToken: 0,
        acquiredAt: 0,
        heartbeatAt: 0,
        expiresAt: 0,
      },
    ])
    expect(
      (await db.table<StorageRetentionStateRow, string>('storageRetentionState').toArray())
        .map((row) => row.task)
        .sort(),
    ).toEqual(['attachment-reap', 'empty-draft-prune', 'terminal-stream-prune'])

    const settings = db.table<SettingsRow, string>('settings')
    expect(await settings.get('backfill:current-schema-manifest-v1')).toBeUndefined()
    expect(await settings.get('workspace-meta')).toBeUndefined()
    expect(await settings.get('global:auto-scroll')).toBeUndefined()
    expect(await settings.get('global:auto-scroll-open')).toBeUndefined()
    expect((await settings.get('global:auto-scroll-stream'))?.value).toBe(true)
    expect((await settings.get('sidebar:sort-key'))?.value).toBe('updatedAt-desc')
    expect((await settings.get('global:pinned-models'))?.value).not.toContain(
      'google/gemini-3.1-pro-preview',
    )
    expect((await settings.get(RECENT_MODEL_RECENCY_KEY))?.value).toEqual({
      version: 1,
      entries: [
        { modelId: 'model-b', usedAt: 0, streamId: 'legacy:20' },
        { modelId: 'model-a', usedAt: 0, streamId: 'legacy:19' },
      ],
    })
    expect((await settings.get('unrelated:user-setting'))?.value).toEqual({ retained: true })
    expect(await settings.get('backfill:global-settings-v1')).toBeUndefined()
    expect(await settings.get('backfill:pinned-model-default-v2')).toBeUndefined()
    expect(await settings.get('backfill:recent-model-recency-v1')).toBeUndefined()
    expect(await settings.get('backfill:storage-compaction-control-v1')).toBeUndefined()
    expect((await settings.get('storage-compaction-state-v1'))?.value).toEqual({
      formatVersion: 2,
      knownReclaimableBytes: 100,
      lastCompactedLiveBytes: 50,
      requestRevision: 3,
      completedRevision: 0,
    })
    db.close()
  })

  it('preserves a valid fence and custom pins while retiring transferred compaction state', async () => {
    const name = databaseName()
    const legacy = legacyDatabase(name)
    await legacy.open()
    await legacy.table('workspaceFence').put({
      id: 'global',
      workspaceId: 'current-workspace',
      replacementEpoch: 11,
    })
    await legacy.table('settings').bulkPut([
      {
        key: 'workspace-meta',
        value: { workspaceId: 'older-workspace', replacementEpoch: 2 },
      },
      { key: 'global:pinned-models', value: ['custom/model'] },
      { key: 'backfill:storage-compaction-control-v1', value: true },
      { key: 'storage-compaction-state-v1', value: { malformed: true } },
    ])
    legacy.close()

    const { db, result } = await upgradeDatabase(name)
    expect(result.requiresCompactionControlTransfer).toBe(false)
    expect(await db.table('workspaceFence').get('global')).toEqual({
      id: 'global',
      workspaceId: 'current-workspace',
      replacementEpoch: 11,
    })
    const settings = db.table<SettingsRow, string>('settings')
    expect((await settings.get('global:pinned-models'))?.value).toEqual(['custom/model'])
    expect(await settings.get('storage-compaction-state-v1')).toBeUndefined()
    db.close()
  })

  it('composes every final-epoch stage while leaving completion markers delayed', async () => {
    const name = databaseName()
    const legacy = legacyDatabase(name)
    await legacy.open()
    legacy.close()

    const db = legacyDatabase(name)
    let result: WaveAStorageSingletonMigrationResultV94 | undefined
    const capabilities: WaveAStorageEpochMigrationCapabilitiesV94 = {
      observedAt: 100,
      recordObsoleteBytes: () => undefined,
    }
    db.version(2)
      .stores(WAVE_A_V94_STORES)
      .upgrade(async (tx) => {
        result = await migrateWaveAStorageEpochRowsV94(tx, capabilities)
      })
    await db.open()

    expect(result?.delayedMarkers.map((row) => row.key)).toEqual([
      'backfill:global-settings-v1',
      'backfill:pinned-model-default-v2',
      'backfill:recent-model-recency-v1',
      'backfill:storage-compaction-control-v1',
      'backfill:stream-journal-frames-v83',
      'backfill:stream-journal-integrity-v1',
    ])
    const settings = db.table<SettingsRow, string>('settings')
    expect(await settings.bulkGet(result?.delayedMarkers.map((row) => row.key) ?? [])).toEqual(
      Array.from({ length: result?.delayedMarkers.length ?? 0 }, () => undefined),
    )
    expect(await settings.get('backfill:current-schema-manifest-v1')).toBeUndefined()
    db.close()
  })

  it('writes completion markers only after a prepared compaction transfer and every stage', async () => {
    const name = databaseName()
    const legacy = legacyDatabase(name)
    await legacy.open()
    await legacy.table('settings').put({
      key: 'storage-compaction-state-v1',
      value: {
        formatVersion: 2,
        knownReclaimableBytes: 100,
        lastCompactedLiveBytes: 50,
        requestRevision: 3,
        completedRevision: 0,
      },
    })
    legacy.close()

    const db = legacyDatabase(name)
    db.version(2)
      .stores(WAVE_A_V94_STORES)
      .upgrade(async (tx) => {
        const result = await migrateWaveAStorageEpochRowsV94(tx, {
          observedAt: 100,
          recordObsoleteBytes: () => undefined,
          compactionControlTransferPrepared: true,
        })
        await finalizeWaveAStorageEpochRowsV94(tx, result)
      })
    await db.open()

    const settings = db.table<SettingsRow, string>('settings')
    expect(await settings.get('storage-compaction-state-v1')).toBeUndefined()
    expect((await settings.get('backfill:storage-compaction-control-v1'))?.value).toBe(true)
    expect((await settings.get('backfill:stream-journal-frames-v83'))?.value).toBe(true)
    expect((await settings.get('backfill:stream-journal-integrity-v1'))?.value).toEqual({
      version: 1,
      phase: 'complete',
    })
    db.close()
  })

  it('opens a physical v25 database through the one production cutover', async () => {
    const name = databaseName()
    const legacy = new Dexie(name)
    legacy.version(25).stores({ settings: '&key' })
    await legacy.open()
    await legacy.table('settings').put({
      key: 'storage-compaction-state-v1',
      value: {
        formatVersion: 1,
        knownReclaimableBytes: 200,
        lastCompactedLiveBytes: 100,
        requestRevision: 2,
      },
    })
    legacy.close()

    const db = createDbForTests(name)
    await prepareBrowserWorkspaceSchema(db)
    await db.open()

    expect(db.verno).toBe(CURRENT_DB_VERSION)
    expect(db.tables).toHaveLength(88)
    expect(await db.settings.get('storage-compaction-state-v1')).toBeUndefined()
    expect((await db.settings.get('backfill:storage-compaction-control-v1'))?.value).toBe(true)
    expect(
      await db.settings.bulkGet(waveACompletionSettingsV94().map((row) => row.key)),
    ).not.toContain(undefined)
    db.close()
  })

  it('rebuilds poisoned derived rows and converts legacy templates with bounded owners', async () => {
    const name = databaseName()
    const db = new Dexie(name)
    db.version(1).stores(WAVE_A_V94_STORES)
    await db.open()
    const settings = cloneDefaultChatSettings()
    settings.profileId = 'profile'
    settings.model = 'test/model'
    const chat: Chat = {
      id: 'chat',
      title: 'Derived state',
      titleStatus: 'manual',
      createdAt: 1,
      updatedAt: 10,
      lastViewedAt: 9,
      wordCount: 2,
      totalCostUsd: 0,
      metaVersion: 0,
      summaryVersion: 0,
      structuralVersion: 0,
      configurationVersion: 0,
      settings,
      lastUpdatedLeafId: 'assistant-a',
      lastBranchUpdatedAt: 8,
      previewText: 'hello',
      archived: false,
      pinned: true,
      folderId: 'folder',
      tags: ['tag'],
    }
    const messages = [
      message('user', null, 0, 'user', false),
      message('assistant-a', 'user', 0, 'assistant', false),
      message('assistant-deleted', 'user', 1, 'assistant', true),
      message('assistant-b', 'user', 2, 'assistant', false),
    ]
    const storedMessages = messages.map((row) => splitMessageForStorage(row))
    await db.table('chats').put(chat)
    await Promise.all([
      db.table('messages').bulkPut(storedMessages.map(({ header }) => header)),
      db.table('messagePreviews').bulkPut(storedMessages.map(({ preview }) => preview)),
    ])
    await Promise.all([
      db.table('childLists').put({ id: 'poison', chatId: 'wrong', liveCount: 99 }),
      db.table('childSlotMembers').put({ id: 'poison', parentKey: 'wrong', position: 0 }),
      db.table('chatSidebarRows').put({ id: 'poison', title: 'wrong' }),
      db.table('chatSidebarAggregates').put({ id: 'workspace', kind: 'workspace', totalCount: 99 }),
      db.table('models').put({
        profileId: 'profile',
        queryKey: 'all',
        fetchedAt: 1,
        payloadId: 'payload',
      }),
      db.table('discoveryPayloads').put({ id: 'payload', byteLength: 1 }),
      db.table('settings').put({
        key: 'global:text-templates:v1',
        value: [
          {
            id: 'user:test',
            name: 'Saved',
            config: {
              userPrefix: '',
              userSuffix: '',
              assistantPrefix: '',
              assistantSuffix: '',
              systemPrefix: '',
              systemSuffix: '',
              bos: '',
              stop: [],
              template: '{% for message in messages %}{{ message.content }}{% endfor %}',
              includeSystemPrompt: false,
            },
            createdAt: 1,
            updatedAt: 2,
          },
        ],
      }),
    ])

    let obsoleteBytes = 0
    await db.transaction('rw', db.tables, (tx) =>
      migrateWaveADerivedRowsV94(tx, {
        observedAt: 100,
        recordObsoleteBytes: (byteLength) => {
          obsoleteBytes += byteLength
        },
      }),
    )

    expect(
      (await db.table<ChildListState, string>('childLists').toArray()).map((row) => row.id).sort(),
    ).toEqual(['chat:__root__', 'chat:user'])
    expect(await db.table('childLists').get('chat:user')).toMatchObject({
      liveCount: 2,
      firstLiveChildId: 'assistant-a',
      lastLiveChildId: 'assistant-b',
      nextSiblingIndex: 3,
    })
    expect(await db.table('childSlotMembers').count()).toBe(3)
    expect(await db.table('childSlotMembers').get('assistant-a')).toMatchObject({
      position: 0,
      previousMessageId: null,
      nextMessageId: 'assistant-b',
    })
    expect(await db.table('childSlotMembers').get('assistant-b')).toMatchObject({
      position: 1,
      previousMessageId: 'assistant-a',
      nextMessageId: null,
    })
    const sidebarRow = await db
      .table<ChatSidebarProjectionRow, string>('chatSidebarRows')
      .get('chat')
    if (!sidebarRow) throw new Error('Expected rebuilt sidebar row')
    expect(isValidChatSidebarProjectionRow(sidebarRow)).toBe(true)
    expect(await db.table('chats').get('chat')).toMatchObject({ folderId: null })
    expect(sidebarRow).toMatchObject({ folderId: null, folderKey: chatSidebarFolderKey(null) })
    expect(
      isValidChatSidebarWorkspaceAggregateRow(
        await db.table('chatSidebarAggregates').get('workspace'),
        1,
      ),
    ).toBe(true)
    expect(await db.table('models').count()).toBe(0)
    expect(await db.table('discoveryPayloads').count()).toBe(0)
    expect(await db.table('discoveryCacheState').count()).toBe(1)
    expect(await db.table('settings').get('global:text-templates:v1')).toBeUndefined()
    expect(await db.table('textTemplates').get('user:test')).toMatchObject({ name: 'Saved' })
    expect(await db.table('chats').get('chat')).toMatchObject({
      folderId: null,
      lastUpdatedLeafId: 'assistant-b',
      previewText: 'user',
      wordCount: 3,
      totalCostUsd: 0,
    })
    expect(obsoleteBytes).toBeGreaterThan(0)
    db.close()
  })

  it('canonicalizes chat and message calibration in their existing bounded passes', async () => {
    const name = databaseName()
    const db = new Dexie(name)
    db.version(1).stores(WAVE_A_V94_STORES)
    await db.open()
    const settings = cloneDefaultChatSettings()
    settings.profileId = 'profile'
    settings.model = 'anthropic/claude-fable-5'
    const calibrationKey = tokenCalibrationKey('anthropic/claude-fable-5')
    const chat: Chat = {
      id: 'chat',
      title: 'Calibration',
      titleStatus: 'manual',
      createdAt: 1,
      updatedAt: 1,
      lastViewedAt: 1,
      wordCount: 0,
      totalCostUsd: 0,
      metaVersion: 0,
      summaryVersion: 0,
      structuralVersion: 0,
      configurationVersion: 0,
      settings,
      lastUpdatedLeafId: 'user',
      lastBranchUpdatedAt: 1,
      archived: false,
      pinned: false,
      folderId: null,
      tags: [],
      tokenCalibration: {
        'anthropic:claude-fable-5': calibrationSample(300, 100, 1, 10),
        'anthropic:anthropic:claude-fable-5': calibrationSample(600, 200, 2, 20),
      },
    }
    const stored = splitMessageForStorage({
      ...message('user', null, 0, 'user', false),
      originalCalibrationKey: 'anthropic:anthropic:claude-fable-5',
    })
    await Promise.all([
      db.table('chats').put(chat),
      db.table('messages').put(stored.header),
      db.table('messageBodies').put(stored.body),
      db.table('messagePreviews').put(stored.preview),
    ])

    await db.transaction('rw', db.tables, (tx) =>
      migrateWaveAStorageEpochRowsV94(tx, {
        observedAt: 100,
        recordObsoleteBytes: () => undefined,
      }),
    )

    expect((await db.table<Chat, string>('chats').get('chat'))?.tokenCalibration).toEqual({
      [calibrationKey]: calibrationSample(900, 300, 3, 20),
    })
    expect(
      (await db.table<MessageHeaderRow, string>('messages').get('user'))?.originalCalibrationKey,
    ).toBe(calibrationKey)
    const global = (await db.table<SettingsRow, string>('settings').get('global:token-calibration'))
      ?.value as GlobalTokenCalibration
    expect(global.byModel).toEqual({
      [calibrationKey]: calibrationSample(900, 300, 3, 20),
    })
    db.close()
  })
})

function calibrationSample(
  totalTextChars: number,
  totalTextTokens: number,
  sampleCount: number,
  updatedAt: number,
) {
  return { totalTextChars, totalTextTokens, sampleCount, lastRatio: 3, updatedAt }
}

function savedTemplate(id: TextTemplateId, template: string, updatedAt: number): SavedTextTemplate {
  return {
    id,
    name: id,
    config: { ...EMPTY_TEXT_TEMPLATE, template },
    createdAt: 1,
    updatedAt,
  }
}

function byTemplateId(left: SavedTextTemplate, right: SavedTextTemplate): number {
  return left.id.localeCompare(right.id)
}

function message(
  id: string,
  parentId: string | null,
  siblingIndex: number,
  role: 'user' | 'assistant',
  deleted: boolean,
): Message {
  return {
    id,
    chatId: 'chat',
    parentId,
    siblingIndex,
    turnId: `turn:${id}`,
    turnIndex: siblingIndex,
    createdAt: siblingIndex + 1,
    role,
    origin: role === 'user' ? 'user' : 'generated',
    content: [{ type: 'text', text: id }],
    nodeVersion: 0,
    deleted,
  }
}

function databaseName(): string {
  const name = `wave-a-v94-singletons-${crypto.randomUUID()}`
  databaseNames.push(name)
  return name
}

function legacyDatabase(name: string): Dexie {
  const db = new Dexie(name)
  db.version(1).stores({
    settings: '&key',
    workspaceFence: '&id',
    browserLocks: '&name',
    storageRetentionState: '&task',
  })
  return db
}

function activeStoreSpec(
  stores: Readonly<Record<string, string | null>>,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(stores).filter((entry): entry is [string, string] => entry[1] !== null),
  )
}

let schemaBlueprintSequence = 0

function normalizedStoreSpec(
  stores: Readonly<Record<string, string | null>>,
): Readonly<Record<string, string>> {
  const blueprint = new Dexie(`wave-a-v94-schema-blueprint:${schemaBlueprintSequence++}`)
  blueprint.version(1).stores(stores)
  const normalized = Object.fromEntries(
    blueprint.tables.map((table) => [
      table.name,
      [table.schema.primKey.src, ...table.schema.indexes.map((index) => index.src)].join(', '),
    ]),
  )
  blueprint.close()
  return normalized
}

function observedStorageManifestJson(version: number): string {
  return JSON.stringify(
    Object.entries(observedWaveAStoreSpec(version)).sort(([a], [b]) => a.localeCompare(b)),
  )
}

function fnv1a32(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`
}

async function upgradeDatabase(name: string): Promise<{
  db: Dexie
  result: WaveAStorageSingletonMigrationResultV94
}> {
  const db = legacyDatabase(name)
  let result: WaveAStorageSingletonMigrationResultV94 | undefined
  db.version(2)
    .stores(WAVE_A_V94_STORES)
    .upgrade(async (tx) => {
      result = await migrateWaveAStorageSingletonsV94(tx)
    })
  await db.open()
  if (!result) throw new Error('WaveAStorageSingletonMigrationDidNotRun')
  return { db, result }
}
