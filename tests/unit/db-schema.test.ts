import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AttachmentReferenceEdgeMigrationError,
  rebuildAttachmentReferenceEdges,
} from '../../src/backcompat/attachment-reference-edges'
import { forEachTableBatch } from '../../src/backcompat/batched-table'
import { backfillChatPreviewProjection } from '../../src/backcompat/chat-preview-projection'
import {
  migrateGlobalSettingsRows,
  migratePinnedModelDefault,
} from '../../src/backcompat/global-settings'
import {
  assertNoInlineMessageBodies,
  backfillMissingMessageBodies,
} from '../../src/backcompat/message-body-split'
import {
  migrateProviderOutputItemRows,
  providerOutputItemsBackfillMarker,
} from '../../src/backcompat/provider-output-items'
import { migrateProviderToolSettingsRows } from '../../src/backcompat/provider-tools'
import { runOnceBackfill } from '../../src/backcompat/run-once'
import { migrateStreamLeaseLifecycleState } from '../../src/backcompat/stream-lease-attempts'
import {
  canonicalizeTokenCalibrationRows,
  rebuildTokenCalibrationGlobalRows,
} from '../../src/backcompat/token-calibration-global'
import { migrateWaveADerivedRowsV94 } from '../../src/backcompat/wave-a-derived-storage-v94'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import { PINNED_MODELS_KEY } from '../../src/core/global-settings'
import { LATEST_OPENROUTER_MODEL_IDS } from '../../src/core/latest-models'
import { tokenCalibrationKey } from '../../src/core/model-ids'
import { isReasoningEnvelope } from '../../src/core/reasoning-envelope'
import { replayStreamAccumulator } from '../../src/core/stream-accumulator'
import {
  EMPTY_TEXT_TEMPLATE,
  LEGACY_SAVED_TEXT_TEMPLATES_KEY,
  type SavedTextTemplate,
} from '../../src/core/text-templates'
import type {
  Attachment,
  AttachmentArtifact,
  AttachmentReferenceEdge,
  Chat,
  ConnectionProfile,
  GlobalTokenCalibration,
  Message,
  MessageAttachmentRef,
} from '../../src/core/types'
import { hydrateAttachment } from '../../src/store/attachment-storage'
import { BROWSER_WRITER_LOCK_NAME, type BrowserLockRow } from '../../src/store/browser-lock-record'
import {
  CHAT_SIDEBAR_PROJECTION_BACKFILL_KEY,
  CHAT_SIDEBAR_PROJECTION_MARKER_VERSION,
  CHAT_SIDEBAR_PROJECTION_ROW_VERSION,
  chatSidebarProjectionRow,
  emptyChatSidebarAggregateRow,
} from '../../src/store/chat-sidebar-projection'
import { buildChat } from '../../src/store/chats'
import type { NatterDb } from '../../src/store/db'
import {
  __resetDbForTests,
  CURRENT_DB_VERSION,
  createDbForTests,
  openDb,
  prepareBrowserWorkspaceSchema,
  registerSchema,
} from '../../src/store/db'
import {
  hydrateMessage,
  MESSAGE_TEXT_PREVIEW_MAX_CHARS,
  type MessageBodyRow,
  type MessageHeaderRow,
  splitMessageForStorage,
} from '../../src/store/message-storage'
import { persistedStreamEventV2FromUnknown } from '../../src/store/persisted-stream-event'
import { BROWSER_WORKSPACE_CATCHUP_JOURNAL_TABLE_NAMES } from '../../src/store/physical-storage-tables'
import { readPresetOrderIds } from '../../src/store/preset-order'
import type { StreamLeaseRow } from '../../src/store/repository'
import { estimateStreamJournalFrameStorageBytes } from '../../src/store/storage-size-estimate'
import {
  requireCanonicalStreamJournalFrame,
  streamJournalFrameId,
} from '../../src/store/stream-journal-codec'
import { STREAM_JOURNAL_INTEGRITY_SETTING_KEY } from '../../src/store/stream-journal-integrity'
import {
  decodeTestStreamJournalFrames,
  encodeTestStreamJournalEntries,
} from '../helpers/stream-journal'
import { testContinuationLease, testGenerationLease } from '../helpers/stream-leases'
import { observedWaveAStoreSpec } from '../helpers/wave-a-observed-storage-v25-v93'

// Unique DB name per test so migrations start from a clean slate. Pre-existing
// data is deleted at the top of each test so repeated runs don't pick up stale
// state from fake-indexeddb's in-memory persistence.
async function freshDb(name: string): Promise<NatterDb> {
  await Dexie.delete(name)
  return createDbForTests(name)
}

afterEach(() => {
  __resetDbForTests({ admissionsOpen: true })
})

describe('Dexie schema', () => {
  beforeEach(async () => {
    __resetDbForTests({ admissionsOpen: true })
    await Dexie.delete('natter')
  })

  it('opens on a fresh IndexedDB with all declared tables', async () => {
    const db = await openDb()
    expect(db.isOpen()).toBe(true)
    expect(db.verno).toBe(CURRENT_DB_VERSION)
    expect(await db.attachmentIntegrityState.get('workspace')).toEqual(
      expect.objectContaining({ repairVersion: 1, phase: 'complete' }),
    )
    const names = db.tables.map((t) => t.name).sort()
    expect(names).toEqual(
      [
        'attachmentArtifacts',
        'attachmentBlobs',
        'attachmentCatalogAggregate',
        'attachmentCatalogRows',
        'attachmentJobs',
        'attachmentIntegrityState',
        'attachmentRefEdges',
        'attachments',
        'browserLocks',
        'chatSidebarAggregates',
        'chatSidebarRows',
        'chats',
        'childLists',
        'childSlotMembers',
        'configurationCatalogAggregates',
        'configurationLinks',
        'configurationPresetCatalogRows',
        'configurationProfileCatalogRows',
        'configurationProfileUsageRows',
        'configurationPromptPresetCatalogRows',
        'discoveryCacheState',
        'discoveryPayloadMetadata',
        'discoveryPayloads',
        'drafts',
        'endpoints',
        'folders',
        'keys',
        'messageBodies',
        'messagePreviews',
        'messages',
        'models',
        'presets',
        'privacyPolicies',
        'profiles',
        'presetOrderBlocks',
        'presetOrderMembership',
        'presetOrderState',
        'promptPresets',
        ...BROWSER_WORKSPACE_CATCHUP_JOURNAL_TABLE_NAMES,
        'settings',
        'storageRetentionState',
        'streamChunks',
        'streamLeases',
        'tags',
        'textTemplates',
        'workspaceFence',
      ].sort(),
    )
    const physicalNames = [...db.backendDB().objectStoreNames]
    expect(physicalNames).not.toEqual(
      expect.arrayContaining(['chatBranchCache', 'generations', 'presetResolutions', 'providers']),
    )
    expect(db.attachmentRefEdges.schema.primKey.src).toBe('[ownerKind+ownerId+refId]')
    expect(db.attachments.schema.indexes.map((index) => index.src)).toContain(
      '[refCount+unreferencedAt+id]',
    )
    expect(db.chats.schema.indexes.map((index) => index.src)).toContain('[archivedKey+id]')
    expect(db.chats.schema.indexes.map((index) => index.src)).toContain(
      '[temporaryKey+temporaryRetentionAt+id]',
    )
    expect(db.attachmentRefEdges.schema.indexes.map((index) => index.src)).toEqual([
      'attachmentId',
      '[attachmentId+ownerKind]',
      '[attachmentId+chatId]',
      '[attachmentId+ownerKind+ownerId+refId]',
      '[ownerKind+ownerId]',
      'chatId',
    ])
    expect(db.streamLeases.schema.indexes.map((index) => index.src)).toContain('&targetOwnerKey')
    expect(db.streamLeases.schema.indexes.map((index) => index.src)).toContain(
      '[terminalRetentionAt+streamId]',
    )
    expect(db.messageBodies.schema.indexes.map((index) => index.src)).toEqual([
      'chatId',
      'updatedAt',
      'bodyVersion',
    ])
    expect(db.messagePreviews.schema.primKey.src).toBe('id')
    expect(db.messagePreviews.schema.indexes.map((index) => index.src)).toEqual(['chatId'])
    expect(db.childSlotMembers.schema.primKey.src).toBe('id')
    expect(db.childSlotMembers.schema.indexes.map((index) => index.src)).toEqual([
      'parentKey',
      '[chatId+parentKey+position]',
    ])
    expect(db.configurationProfileCatalogRows.schema.indexes.map((index) => index.src)).toEqual([
      'archived',
      'activeKey',
      'managerTier',
      'lastUsedAt',
      '[activeKey+mruSortKey+nameSortKey+id]',
      '[managerTier+nameSortKey+id]',
    ])
    expect(db.configurationLinks.schema.indexes.map((index) => index.src)).toEqual([
      'ownerKey',
      'targetKey',
      '[targetKey+id]',
    ])
    expect(db.textTemplates.schema.indexes.map((index) => index.src)).toEqual([
      '[createdAt+id+name+updatedAt]',
    ])
    expect(db.configurationPresetCatalogRows.schema.indexes.map((index) => index.src)).toEqual([
      'archived',
      'activeKey',
      'connectionProfileId',
      '[activeKey+defaultTier+defaultTime+id]',
      '[connectionProfileId+activeKey+defaultTier+defaultTime+id]',
    ])
    expect(
      db.configurationPromptPresetCatalogRows.schema.indexes.map((index) => index.src),
    ).toEqual(['kind', 'lastUsedAt', '[kind+lastUsedAt+id]', '[kind+nameSortKey+id]'])
    expect(db.configurationCatalogAggregates.schema.primKey.src).toBe('id')
    expect(db.configurationProfileUsageRows.schema.primKey.src).toBe('id')
    expect(db.presetOrderState.schema.primKey.src).toBe('id')
    expect(db.presetOrderBlocks.schema.primKey.src).toBe('id')
    expect(db.presetOrderMembership.schema.primKey.src).toBe('presetId')
    expect(db.presetOrderMembership.schema.indexes.map((index) => index.src)).toEqual(['blockId'])
    expect(db.storageRetentionState.schema.primKey.src).toBe('task')
    expect(db.workspaceFence.schema.primKey.src).toBe('id')
    expect(db.attachmentCatalogRows.schema.indexes.map((index) => index.src)).toEqual(
      expect.arrayContaining([
        '[createdAt+id]',
        '[updatedAt+id]',
        '[sizeBytes+id]',
        '[origin+sizeBytes+id]',
        '[storageKind+sizeBytes+id]',
        '[kind+sizeBytes+id]',
        '[refCount+sizeBytes+id]',
      ]),
    )
    expect(db.attachmentCatalogAggregate.schema.primKey.src).toBe('id')
    expect(db.chatSidebarAggregates.schema.primKey.src).toBe('id')
    expect(db.models.schema.indexes.map((index) => index.src)).toEqual([
      'profileId',
      'fetchedAt',
      '[profileId+fetchedAt]',
      'payloadId',
    ])
    expect(db.endpoints.schema.indexes.map((index) => index.src)).toEqual([
      'profileId',
      'fetchedAt',
      '[profileId+fetchedAt]',
      'payloadId',
    ])
    expect(db.privacyPolicies.schema.indexes.map((index) => index.src)).toEqual([
      'profileId',
      'fetchedAt',
      '[profileId+fetchedAt]',
      'payloadId',
    ])
    expect(db.discoveryPayloads.schema.primKey.src).toBe('id')
    expect(db.discoveryPayloads.schema.indexes.map((index) => index.src)).toEqual(['byteLength'])
    expect(db.discoveryPayloadMetadata.schema.indexes.map((index) => index.src)).toEqual([
      'referenceCount',
      'lastReferencedAt',
      'byteLength',
    ])
    expect(await db.discoveryCacheState.get('global')).toEqual({
      id: 'global',
      formatVersion: 1,
      valid: true,
      headerCounts: { models: 0, endpoints: 0, privacyPolicies: 0 },
      payloadCount: 0,
      payloadByteLength: 0,
    })
    expect(await db.attachmentRefEdges.count()).toBe(0)
    expect(await db.chatSidebarRows.count()).toBe(0)
    expect((await db.settings.get('backfill:attachment-refs-v1'))?.value).toBe(1)
    expect((await db.settings.get('backfill:chat-preview-projection-v1'))?.value).toBe(1)
    expect((await db.settings.get(CHAT_SIDEBAR_PROJECTION_BACKFILL_KEY))?.value).toBe(
      CHAT_SIDEBAR_PROJECTION_MARKER_VERSION,
    )
    expect(await db.settings.get('backfill:chat-sidebar-projection-v1')).toBeUndefined()
    expect(await db.settings.get('projection:chat-sidebar-v1')).toBeUndefined()
    expect(await db.settings.get(STREAM_JOURNAL_INTEGRITY_SETTING_KEY)).toEqual({
      key: STREAM_JOURNAL_INTEGRITY_SETTING_KEY,
      value: { version: 1, phase: 'complete' },
    })
    expect(await db.chatSidebarAggregates.count()).toBe(1)
    expect(await db.browserLocks.get(BROWSER_WRITER_LOCK_NAME)).toEqual({
      name: BROWSER_WRITER_LOCK_NAME,
      ownerClientId: null,
      leaseId: null,
      fencingToken: 0,
      acquiredAt: 0,
      heartbeatAt: 0,
      expiresAt: 0,
    })
  })

  it('keeps the physical archive cursor indexed while exposing only the public chat shape', async () => {
    const db = await openDb()
    const chat = {
      ...buildChat({ id: 'archive-codec', temporary: true, now: 1 }),
      archived: true,
    }
    await db.chats.put(chat)

    expect(await db.chats.get(chat.id)).toEqual(chat)
    expect(await db.chats.get(chat.id)).not.toHaveProperty('archivedKey')
    expect(await db.chats.get(chat.id)).not.toHaveProperty('temporaryKey')
    expect(await db.chats.get(chat.id)).not.toHaveProperty('temporaryRetentionAt')
    expect(await db.chats.where('[archivedKey+id]').equals([1, chat.id]).primaryKeys()).toEqual([
      chat.id,
    ])
    expect(
      await db.chats
        .where('[temporaryKey+temporaryRetentionAt+id]')
        .equals([1, 1, chat.id])
        .count(),
    ).toBe(1)

    const replacement = {
      ...chat,
      archived: false,
      temporary: false,
      title: 'Materialized by put',
      titleStatus: 'manual' as const,
    }
    await db.chats.put(replacement)
    expect(replacement).not.toHaveProperty('archivedKey')
    expect(replacement).not.toHaveProperty('temporaryKey')
    expect(replacement).not.toHaveProperty('temporaryRetentionAt')
    expect(await db.chats.get(chat.id)).toEqual(replacement)

    await db.chats.update(chat.id, {
      archived: false,
      temporary: false,
      title: 'Materialized',
      titleStatus: 'manual',
    })
    expect(await db.chats.where('[archivedKey+id]').equals([1, chat.id]).count()).toBe(0)
    expect(await db.chats.where('[archivedKey+id]').equals([0, chat.id]).count()).toBe(1)
    expect(
      await db.chats
        .where('[temporaryKey+temporaryRetentionAt+id]')
        .equals([1, 1, chat.id])
        .count(),
    ).toBe(0)
    expect(
      await db.chats
        .where('[temporaryKey+temporaryRetentionAt+id]')
        .equals([0, 1, chat.id])
        .count(),
    ).toBe(1)
  })

  it('replaces only the exact retired pinned-model default in the versioned backfill', async () => {
    const db = await openDb()
    const markerKey = 'backfill:pinned-model-default-v2'
    const previousDefault = [
      'openai/gpt-5.4',
      'anthropic/claude-opus-4.7',
      'deepseek/deepseek-v4-pro',
      'google/gemini-3.1-pro-preview',
      'google/gemini-3.1-flash-lite-preview',
    ]
    await db.settings.bulkPut([
      { key: PINNED_MODELS_KEY, value: previousDefault },
      { key: markerKey, value: 0 },
    ])
    await db.transaction('rw', db.settings, (tx) => migratePinnedModelDefault(tx))
    expect((await db.settings.get(PINNED_MODELS_KEY))?.value).toEqual(LATEST_OPENROUTER_MODEL_IDS)

    const customized = [...previousDefault, 'custom/private-model']
    await db.settings.bulkPut([
      { key: PINNED_MODELS_KEY, value: customized },
      { key: markerKey, value: 0 },
    ])
    await db.transaction('rw', db.settings, (tx) => migratePinnedModelDefault(tx))
    expect((await db.settings.get(PINNED_MODELS_KEY))?.value).toEqual(customized)
  })

  it('upgrades the observed attachment-only v56 shape to the archive cursor schema', async () => {
    const name = `natter-test-v56-archive-cursor-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)
    const legacy = new Dexie(name)
    legacy.version(56).stores({
      chats:
        'id, updatedAt, createdAt, lastViewedAt, lastUpdatedLeafId, lastBranchUpdatedAt, wordCount, totalCostUsd, archived, pinned, presetId, folderId, *tags',
      attachments:
        'id, contentHash, kind, mime, origin, refCount, createdAt, updatedAt, deletedAt, [refCount+createdAt], [refCount+createdAt+id]',
    })
    await legacy.open()
    const archived = { ...buildChat({ id: 'v56-archived-chat', now: 1 }), archived: true }
    await legacy.table('chats').put(archived)
    legacy.close()

    const migrated = createDbForTests(name)
    await migrated.open()

    expect(migrated.verno).toBe(CURRENT_DB_VERSION)
    expect(await migrated.chats.get(archived.id)).toEqual(archived)
    expect(
      await migrated.chats.where('[archivedKey+id]').equals([1, archived.id]).primaryKeys(),
    ).toEqual([archived.id])
    expect(migrated.attachments.schema.indexes.map((index) => index.src)).toContain(
      '[refCount+unreferencedAt+id]',
    )
    await migrated.delete()
  })

  it('upgrades the observed v57 archive cursor to the indexed temporary candidate schema', async () => {
    const name = `natter-test-v57-temporary-cursor-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)
    const legacy = new Dexie(name)
    legacy.version(57).stores({
      chats:
        'id, updatedAt, createdAt, lastViewedAt, lastUpdatedLeafId, lastBranchUpdatedAt, wordCount, totalCostUsd, archived, pinned, presetId, folderId, *tags, [archivedKey+id]',
      attachments:
        'id, contentHash, kind, mime, origin, refCount, createdAt, updatedAt, deletedAt, [refCount+createdAt], [refCount+createdAt+id]',
    })
    await legacy.open()
    const temporary = {
      ...buildChat({ id: 'v57-temporary-chat', temporary: true, now: 1 }),
      archivedKey: 0,
    }
    await legacy.table('chats').put(temporary)
    legacy.close()

    const migrated = createDbForTests(name)
    await migrated.open()

    expect(migrated.verno).toBe(CURRENT_DB_VERSION)
    const publicTemporary = await migrated.chats.get(temporary.id)
    expect(publicTemporary).toMatchObject({ id: temporary.id, temporary: true })
    expect(publicTemporary).not.toHaveProperty('archivedKey')
    expect(publicTemporary).not.toHaveProperty('temporaryKey')
    expect(publicTemporary).not.toHaveProperty('temporaryRetentionAt')
    expect(
      await migrated.chats
        .where('[temporaryKey+temporaryRetentionAt+id]')
        .equals([1, 1, temporary.id])
        .primaryKeys(),
    ).toEqual([temporary.id])
    expect(await migrated.settings.get(STREAM_JOURNAL_INTEGRITY_SETTING_KEY)).toEqual({
      key: STREAM_JOURNAL_INTEGRITY_SETTING_KEY,
      value: { version: 1, phase: 'complete' },
    })
    await migrated.delete()
  })

  it('upgrades the observed v58 temporary cursor to bounded discovery cache storage', async () => {
    const name = `natter-test-v58-discovery-retention-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)
    const legacy = new Dexie(name)
    legacy.version(58).stores({
      chats:
        'id, updatedAt, createdAt, lastViewedAt, lastUpdatedLeafId, lastBranchUpdatedAt, wordCount, totalCostUsd, archived, pinned, presetId, folderId, *tags, [archivedKey+id], [temporaryKey+id]',
      models: '&[profileId+queryKey], profileId, fetchedAt, [profileId+fetchedAt], payloadId',
      endpoints: '&[profileId+modelId], profileId, fetchedAt, [profileId+fetchedAt], payloadId',
      privacyPolicies:
        '&[profileId+modelId], profileId, fetchedAt, [profileId+fetchedAt], payloadId',
      discoveryPayloads: '&id, byteLength',
    })
    await legacy.open()
    const chat = buildChat({ id: 'v58-chat', temporary: true, now: 1 })
    await legacy.table('chats').put({ ...chat, archivedKey: 0, temporaryKey: 1 })
    await legacy.table('discoveryPayloads').put({
      id: 'old-payload',
      canonicalJson: JSON.stringify({ data: ['disposable'] }),
      byteLength: 23,
    })
    await legacy.table('models').put({
      profileId: 'old-profile',
      queryKey: 'all',
      fetchedAt: 1,
      payloadId: 'old-payload',
      payloadByteLength: 23,
    })
    legacy.close()

    const migrated = createDbForTests(name)
    await migrated.open()

    expect(migrated.verno).toBe(CURRENT_DB_VERSION)
    expect(await migrated.chats.get(chat.id)).toMatchObject({ id: chat.id, temporary: true })
    expect(await migrated.models.count()).toBe(0)
    expect(await migrated.discoveryPayloads.count()).toBe(0)
    expect(await migrated.discoveryPayloadMetadata.count()).toBe(0)
    expect(await migrated.discoveryCacheState.get('global')).toMatchObject({
      valid: true,
      payloadCount: 0,
      payloadByteLength: 0,
    })
    await migrated.delete()
  })

  it('adds the structural chat revision in v79 exactly once', async () => {
    const name = `natter-test-v78-chat-structural-revision-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)
    const legacy = new Dexie(name)
    legacy.version(78).stores({ chats: 'id' })
    await legacy.open()
    const current = buildChat({ id: 'v78-chat', title: 'Structural revision', now: 1 })
    const { structuralVersion: _structuralVersion, ...withoutStructuralVersion } = current
    await legacy.table('chats').put(withoutStructuralVersion)
    legacy.close()

    const migrated = createDbForTests(name)
    await migrated.open()
    expect(migrated.verno).toBe(CURRENT_DB_VERSION)
    expect((await migrated.chats.get('v78-chat'))?.structuralVersion).toBe(0)
    await migrated.chats.update('v78-chat', { structuralVersion: 7 })
    migrated.close()

    const reopened = createDbForTests(name)
    await reopened.open()
    expect((await reopened.chats.get('v78-chat'))?.structuralVersion).toBe(7)
    await reopened.delete()
  })

  it('moves and deduplicates the legacy text-template setting into canonical v61 rows', async () => {
    const name = `natter-test-v60-text-template-rows-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)
    const legacy = new Dexie(name)
    legacy.version(60).stores({ settings: '&key' })
    await legacy.open()
    const original: SavedTextTemplate = {
      id: 'user:legacy-template',
      name: 'Legacy template',
      config: { ...EMPTY_TEXT_TEMPLATE, template: 'older source' },
      createdAt: 10,
      updatedAt: 20,
    }
    await legacy.table('settings').put({
      key: LEGACY_SAVED_TEXT_TEMPLATES_KEY,
      value: [
        original,
        {
          ...original,
          config: { ...original.config, template: 'newer source' },
          updatedAt: 30,
        },
      ],
    })
    legacy.close()

    const migrated = createDbForTests(name)
    await migrated.open()

    expect(migrated.verno).toBe(CURRENT_DB_VERSION)
    expect(await migrated.settings.get(LEGACY_SAVED_TEXT_TEMPLATES_KEY)).toBeUndefined()
    expect(await migrated.textTemplates.toArray()).toEqual([
      {
        ...original,
        config: { ...original.config, template: 'newer source' },
        updatedAt: 30,
      },
    ])
    expect(await migrated.attachmentIntegrityState.get('workspace')).toEqual(
      expect.objectContaining({ repairVersion: 1, phase: 'complete' }),
    )
    await migrated.delete()
  })

  it('rolls back canonical template rows and preserves the legacy setting when v61 fails', async () => {
    const name = `natter-test-v60-text-template-rollback-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)
    const legacy = new Dexie(name)
    legacy.version(60).stores({ settings: '&key' })
    await legacy.open()
    const template: SavedTextTemplate = {
      id: 'user:rollback-template',
      name: 'Rollback template',
      config: { ...EMPTY_TEXT_TEMPLATE, template: 'must survive' },
      createdAt: 10,
      updatedAt: 10,
    }
    await legacy.table('settings').put({
      key: LEGACY_SAVED_TEXT_TEMPLATES_KEY,
      value: [template],
    })
    legacy.close()

    const migrated = createDbForTests(name)
    const failCreate = () => {
      throw new Error('injected text-template migration failure')
    }
    migrated.textTemplates.hook.creating.subscribe(failCreate)
    await expect(migrated.open()).rejects.toThrow('injected text-template migration failure')
    migrated.close()

    const inspector = new Dexie(name)
    inspector.version(60).stores({ settings: '&key' })
    await inspector.open()
    expect(inspector.verno).toBe(60)
    expect(await inspector.table('settings').get(LEGACY_SAVED_TEXT_TEMPLATES_KEY)).toEqual({
      key: LEGACY_SAVED_TEXT_TEMPLATES_KEY,
      value: [template],
    })
    expect([...inspector.backendDB().objectStoreNames]).not.toContain('textTemplates')
    inspector.close()

    migrated.textTemplates.hook.creating.unsubscribe(failCreate)
    await migrated.open()
    expect(await migrated.textTemplates.get(template.id)).toEqual(template)
    expect(await migrated.settings.get(LEGACY_SAVED_TEXT_TEMPLATES_KEY)).toBeUndefined()
    await migrated.delete()
  })

  it('drops v54 branch caches and disposable discovery payloads without losing canonical rows', async () => {
    const name = `natter-test-v55-retired-storage-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)
    const legacy = new Dexie(name)
    legacy.version(54).stores({
      chats: 'id',
      messages: 'id, chatId',
      messageBodies: '&id, chatId',
      chatBranchCache: '&chatId, branchLeafId, generatedAt',
      attachments: 'id',
      attachmentBlobs: 'id, attachmentId',
      attachmentArtifacts: 'artifactId, attachmentId',
      attachmentJobs: 'id, attachmentId',
      models: '&[profileId+queryKey], payloadId',
      endpoints: '&[profileId+modelId], payloadId',
      privacyPolicies: '&[profileId+modelId], payloadId',
      discoveryPayloads: '&id, byteLength',
      streamLeases: '&streamId, &messageId, [chatId+streamId]',
      streamChunks: '&id, streamId, chatId, [streamId+seq]',
    })
    await legacy.open()
    const chat = {
      ...buildChat({ id: 'canonical-chat', title: 'Canonical chat', now: 1 }),
      archived: true,
    }
    const message: Message = {
      id: 'canonical-message',
      chatId: chat.id,
      parentId: null,
      siblingIndex: 0,
      turnId: 'canonical-turn',
      turnIndex: 0,
      createdAt: 1,
      role: 'user',
      origin: 'user',
      content: [{ type: 'text', text: 'canonical' }],
      nodeVersion: 0,
      deleted: false,
    }
    const storedMessage = splitMessageForStorage(message)
    await legacy.table('chats').put(chat)
    await legacy.table('messages').put(storedMessage.header)
    await legacy.table('messageBodies').put(storedMessage.body)
    await legacy.table('chatBranchCache').put({
      chatId: chat.id,
      branchLeafId: message.id,
      generatedAt: 1,
    })
    await legacy.table('discoveryPayloads').put({
      id: 'payload-1',
      byteLength: 10_000_000,
      payload: 'disposable',
    })
    await legacy.table('models').put({
      profileId: 'profile-1',
      queryKey: 'all',
      payloadId: 'payload-1',
    })
    await legacy.table('endpoints').put({
      profileId: 'profile-1',
      modelId: 'model-1',
      payloadId: 'payload-1',
    })
    await legacy.table('privacyPolicies').put({
      profileId: 'profile-1',
      modelId: 'model-1',
      payloadId: 'payload-1',
    })
    legacy.close()

    const migrated = createDbForTests(name)
    await migrated.open()

    expect(migrated.verno).toBe(CURRENT_DB_VERSION)
    expect([...migrated.backendDB().objectStoreNames]).not.toContain('chatBranchCache')
    expect(await migrated.chats.get(chat.id)).toEqual({
      ...chat,
      wordCount: 1,
      lastUpdatedLeafId: message.id,
      lastBranchUpdatedAt: message.createdAt,
      previewText: 'canonical',
    })
    expect(
      await migrated.chats.where('[archivedKey+id]').equals([1, chat.id]).primaryKeys(),
    ).toEqual([chat.id])
    expect(await migrated.messages.get(message.id)).toMatchObject({
      ...storedMessage.header,
      treeLive: 1,
      treeParentKey: '__root__',
    })
    expect(await migrated.messageBodies.get(message.id)).toMatchObject(storedMessage.body)
    expect(await migrated.discoveryPayloads.count()).toBe(0)
    expect(await migrated.models.count()).toBe(0)
    expect(await migrated.endpoints.count()).toBe(0)
    expect(await migrated.privacyPolicies.count()).toBe(0)
    await migrated.delete()
  })

  it('carries the composed v23 message and attachment projections through the full upgrade', async () => {
    const name = `natter-test-projections-v23-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)
    const legacy = new Dexie(name)
    legacy.version(22).stores({
      messages:
        'id, chatId, parentId, turnId, [chatId+parentId], [chatId+createdAt], [chatId+turnId], [chatId+deleted]',
      messageBodies: '&id, chatId, updatedAt, nodeVersion',
      attachments: 'id, contentHash, kind, mime, origin, refCount, createdAt, updatedAt, deletedAt',
      attachmentArtifacts: 'artifactId, attachmentId, kind, processorId, createdAt',
    })
    await legacy.open()
    const message: Message = {
      id: 'projection-message',
      chatId: 'projection-chat',
      parentId: null,
      siblingIndex: 0,
      turnId: 'projection-turn',
      turnIndex: 0,
      createdAt: 1,
      role: 'assistant',
      origin: 'generated',
      generation: {
        id: 'projection-generation',
        model: 'model',
        requestedModel: 'model',
        apiUsed: 'responses',
        delivery: 'streaming',
        costSource: 'stream',
        reasoningCarryForward: 'none',
        reasoningVisibility: { disclosure: 'unknown' },
        startedAt: 1,
        serverTools: [
          {
            type: 'web_search_call',
            source: 'responses-output',
            outputIndex: 0,
          },
        ],
      },
      content: [{ type: 'output_text', text: `  ${'preview '.repeat(1_000)}  ` }],
      nodeVersion: 0,
      deleted: false,
    }
    const split = splitMessageForStorage(message)
    const legacyHeader = structuredClone(split.header) as unknown as Record<string, unknown>
    delete legacyHeader.bodyVersion
    delete legacyHeader.bodyWordCount
    delete legacyHeader.textPreview
    const legacyGeneration = structuredClone(message.generation) as unknown as Record<
      string,
      unknown
    >
    const legacyServerTools = legacyGeneration.serverTools as Record<string, unknown>[]
    const legacyServerTool = legacyServerTools[0]
    if (!legacyServerTool) throw new Error('ExpectedLegacyServerTool')
    legacyServerTool.output = {
      id: 'ws_projection',
      type: 'web_search_call',
      status: 'completed',
      action: { type: 'search', query: 'projection query' },
    }
    legacyHeader.generation = legacyGeneration
    const legacyBody = structuredClone(split.body) as unknown as Record<string, unknown>
    legacyBody.nodeVersion = split.body.bodyVersion
    delete legacyBody.bodyVersion
    delete legacyBody.generationServerToolOutputs
    await legacy.table('messages').put(legacyHeader)
    await legacy.table('messageBodies').put(legacyBody)

    const artifact: AttachmentArtifact = {
      kind: 'text',
      artifactId: 'projection-artifact',
      attachmentId: 'projection-attachment',
      processorId: 'text-v1',
      text: 'x'.repeat(100_000),
      charCount: 100_000,
      createdAt: 1,
    }
    const attachment: Attachment = {
      id: 'projection-attachment',
      kind: 'document',
      mime: 'text/plain',
      filename: 'projection.txt',
      origin: 'import',
      createdAt: 1,
      updatedAt: 1,
      storage: { kind: 'missing', reason: 'import-missing', missingSince: 1 },
      artifacts: [artifact],
      processing: [],
      refCount: 0,
    }
    await legacy.table('attachments').put(attachment)
    legacy.close()

    const migrated = createDbForTests(name)
    await migrated.open()
    expect(migrated.verno).toBe(CURRENT_DB_VERSION)
    expect(await migrated.settings.get('workspace-meta')).toBeUndefined()
    expect(await migrated.workspaceFence.get('global')).toMatchObject({
      id: 'global',
      replacementEpoch: 0,
    })
    const [header, body, preview, storedAttachment, storedArtifact] = await Promise.all([
      migrated.messages.get(message.id),
      migrated.messageBodies.get(message.id),
      migrated.messagePreviews.get(message.id),
      migrated.attachments.get(attachment.id),
      migrated.attachmentArtifacts.get(artifact.artifactId),
    ])
    expect(header).not.toHaveProperty('textPreview')
    expect(preview).toMatchObject({
      id: message.id,
      chatId: message.chatId,
    })
    expect(preview?.text).toHaveLength(MESSAGE_TEXT_PREVIEW_MAX_CHARS)
    expect(header?.nodeVersion).toBe(message.nodeVersion + 1)
    expect(header?.bodyVersion).toBe(message.nodeVersion + 1)
    expect(header?.bodyWordCount).toBe(1_000)
    expect(body?.bodyVersion).toBe(header?.bodyVersion)
    expect(preview?.bodyVersion).toBe(header?.bodyVersion)
    expect(body).not.toHaveProperty('nodeVersion')
    expect(header?.generation?.serverTools?.[0]).not.toHaveProperty('output')
    const expectedProviderOutputItems = [
      {
        dialect: 'openai-responses' as const,
        type: 'web_search_call',
        outputIndex: 0,
        item: {
          id: 'ws_projection',
          type: 'web_search_call',
          status: 'completed',
          action: { type: 'search', query: 'projection query' },
        },
      },
    ]
    expect(body).not.toHaveProperty('generationServerToolOutputs')
    expect(body?.providerOutputItems).toEqual(expectedProviderOutputItems)
    const expectedHydratedMessage = structuredClone(message)
    expectedHydratedMessage.nodeVersion = message.nodeVersion + 1
    expectedHydratedMessage.providerOutputItems = expectedProviderOutputItems
    expect(header && body ? hydrateMessage(header, body) : undefined).toMatchObject(
      expectedHydratedMessage,
    )
    expect(storedAttachment).not.toHaveProperty('artifacts')
    expect(storedAttachment).toHaveProperty('artifactIds', [artifact.artifactId])
    expect(storedAttachment).toHaveProperty('unreferencedAt', expect.any(Number))
    expect(storedArtifact).toEqual(artifact)
    expect(
      storedAttachment ? hydrateAttachment(storedAttachment, [storedArtifact]) : undefined,
    ).toEqual(attachment)
    migrated.close()

    const reopened = createDbForTests(name)
    await reopened.open()
    expect(reopened.verno).toBe(CURRENT_DB_VERSION)
    expect((await reopened.messageBodies.get(message.id))?.providerOutputItems).toEqual(
      expectedProviderOutputItems,
    )
    expect(await reopened.attachmentArtifacts.count()).toBe(1)
    await reopened.delete()
  })

  it('carries the v25 request-context revision and cold body through the full upgrade', async () => {
    const name = `natter-test-request-context-v25-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)
    const legacy = new Dexie(name)
    legacy.version(24).stores({
      messages:
        'id, chatId, parentId, turnId, [chatId+parentId], [chatId+createdAt], [chatId+turnId], [chatId+deleted]',
      messageBodies: '&id, chatId, updatedAt, bodyVersion',
    })
    await legacy.open()
    const message: Message = {
      id: 'request-context-message',
      chatId: 'request-context-chat',
      parentId: null,
      siblingIndex: 0,
      turnId: 'request-context-turn',
      turnIndex: 0,
      createdAt: 1,
      role: 'user',
      origin: 'user',
      content: [{ type: 'text', text: 'unchanged cold body' }],
      nodeVersion: 7,
      deleted: false,
    }
    const split = splitMessageForStorage(message, { bodyVersion: 3 })
    const legacyHeader = structuredClone(split.header) as unknown as Record<string, unknown>
    delete legacyHeader.requestContextVersion
    legacyHeader.textPreview = 'unchanged cold body'
    await legacy.table('messages').put(legacyHeader)
    await legacy.table('messageBodies').put(split.body)
    legacy.close()

    const migrated = createDbForTests(name)
    await migrated.open()
    expect(migrated.verno).toBe(CURRENT_DB_VERSION)
    expect(await migrated.messages.get(message.id)).toMatchObject({
      nodeVersion: 7,
      bodyVersion: 3,
      requestContextVersion: 0,
    })
    expect(await migrated.messageBodies.get(message.id)).toEqual(split.body)
    migrated.close()

    const reopened = createDbForTests(name)
    await reopened.open()
    expect((await reopened.messages.get(message.id))?.requestContextVersion).toBe(0)
    expect(await reopened.messageBodies.get(message.id)).toEqual(split.body)
    await reopened.delete()
  })

  it('seeds missing legacy workspace metadata before the v26 lease migration requires it', async () => {
    const name = `natter-test-workspace-meta-missing-v25-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)
    const legacy = new Dexie(name)
    legacy.version(25).stores({ settings: '&key' })
    await legacy.open()
    expect(await legacy.table('settings').get('workspace-meta')).toBeUndefined()
    legacy.close()

    const migrated = createDbForTests(name)
    await migrated.open()
    const value = await migrated.workspaceFence.get('global')
    expect(migrated.verno).toBe(CURRENT_DB_VERSION)
    expect(value).toMatchObject({ id: 'global', replacementEpoch: 0 })
    expect(value?.workspaceId).toMatch(/^browser-idb:[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(await migrated.settings.get('workspace-meta')).toBeUndefined()
    await migrated.delete()
  })

  it('cursor-pages large tables in deterministic bounded batches', async () => {
    const name = `natter-test-backcompat-batches-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)
    const db = new Dexie(name)
    db.version(1).stores({ rows: '&id' })
    await db.open()
    const table = db.table<{ id: string; visited: boolean }, string>('rows')
    await table.bulkPut(
      Array.from({ length: 1001 }, (_, index) => ({
        id: `row-${index.toString().padStart(4, '0')}`,
        visited: false,
      })),
    )
    const visited: string[] = []
    const observedBatchSizes: number[] = []
    const stats = await db.transaction('rw', table, async () =>
      forEachTableBatch(
        table,
        async (rows) => {
          observedBatchSizes.push(rows.length)
          visited.push(...rows.map((row) => row.id))
          await table.bulkPut(rows.map((row) => ({ ...row, visited: true })))
        },
        64,
      ),
    )

    expect(stats).toEqual({ rowCount: 1001, batchCount: 16, maxBatchSize: 64 })
    expect(Math.max(...observedBatchSizes)).toBe(64)
    expect(visited).toEqual(
      Array.from({ length: 1001 }, (_, index) => `row-${index.toString().padStart(4, '0')}`),
    )
    expect(await table.filter((row) => !row.visited).count()).toBe(0)
    await db.delete()
  })

  it('adds the browser-writer fence once on v21 to v22 and never resets its token', async () => {
    const name = `natter-test-browser-lock-v22-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)
    const legacy = new Dexie(name)
    legacy.version(21).stores({
      settings: '&key',
      messages: 'id, chatId',
      messageBodies: '&id, chatId',
      streamChunks: '&id, streamId, chatId, messageId, [streamId+seq], createdAt',
    })
    await legacy.open()
    legacy.close()

    const migrated = createDbForTests(name)
    await migrated.open()
    expect(migrated.verno).toBe(CURRENT_DB_VERSION)
    const seeded = await migrated.browserLocks.get(BROWSER_WRITER_LOCK_NAME)
    expect(seeded?.fencingToken).toBe(0)
    await migrated.browserLocks.put({
      ...(seeded as BrowserLockRow),
      ownerClientId: null,
      leaseId: null,
      fencingToken: 41,
      expiresAt: 0,
    })
    migrated.close()

    const reopened = createDbForTests(name)
    await reopened.open()
    expect((await reopened.browserLocks.get(BROWSER_WRITER_LOCK_NAME))?.fencingToken).toBe(41)
    await reopened.delete()
  })

  it('repairs stale previews in the composed v21 to v22 migration', async () => {
    const name = `natter-test-preview-v22-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)
    const legacy = new Dexie(name)
    legacy.version(21).stores({
      chats:
        'id, updatedAt, createdAt, lastViewedAt, lastUpdatedLeafId, lastBranchUpdatedAt, wordCount, totalCostUsd, archived, pinned, presetId, folderId, *tags',
      messages:
        'id, chatId, parentId, turnId, [chatId+parentId], [chatId+createdAt], [chatId+turnId], [chatId+deleted]',
      messageBodies: '&id, chatId, updatedAt, nodeVersion',
      settings: '&key',
      streamChunks: '&id, streamId, chatId, messageId, [streamId+seq], createdAt',
    })
    await legacy.open()
    const chat: Chat = {
      id: 'preview-v22-chat',
      title: 'Preview migration',
      titleStatus: 'manual',
      createdAt: 1,
      updatedAt: 1,
      lastViewedAt: 1,
      wordCount: 2,
      totalCostUsd: 0,
      metaVersion: 0,
      summaryVersion: 0,
      structuralVersion: 0,
      settings: cloneDefaultChatSettings(),
      lastUpdatedLeafId: 'preview-v22-message',
      lastBranchUpdatedAt: 1,
      archived: false,
      pinned: false,
      folderId: null,
      tags: [],
      previewText: 'stale',
    }
    const message: Message = {
      id: 'preview-v22-message',
      chatId: chat.id,
      parentId: null,
      siblingIndex: 0,
      turnId: 'preview-v22-turn',
      turnIndex: 0,
      createdAt: 1,
      role: 'user',
      origin: 'user',
      content: [{ type: 'text', text: ' migrated preview ' }],
      nodeVersion: 0,
      deleted: false,
    }
    const split = splitMessageForStorage(message)
    await legacy.table<Chat>('chats').put(chat)
    await legacy.table('messages').put(split.header)
    await legacy.table('messageBodies').put(split.body)
    legacy.close()

    const migrated = createDbForTests(name)
    await migrated.open()
    expect((await migrated.chats.get(chat.id))?.previewText).toBe('migrated preview')
    expect(await migrated.chatSidebarRows.get(chat.id)).toEqual(
      expect.objectContaining({
        id: chat.id,
        title: chat.title,
        previewText: 'migrated preview',
        projectionVersion: CHAT_SIDEBAR_PROJECTION_ROW_VERSION,
      }),
    )
    expect((await migrated.settings.get('backfill:chat-preview-projection-v1'))?.value).toBe(1)
    expect((await migrated.settings.get(CHAT_SIDEBAR_PROJECTION_BACKFILL_KEY))?.value).toBe(
      CHAT_SIDEBAR_PROJECTION_MARKER_VERSION,
    )
    expect((await migrated.settings.get('backfill:chat-sidebar-projection-v1'))?.value).toBe(1)
    expect((await migrated.settings.get('projection:chat-sidebar-v1'))?.value).toMatchObject({
      projectionVersion: 3,
      expectedCount: 1,
    })
    migrated.close()

    const reopened = createDbForTests(name)
    await reopened.open()
    expect(await reopened.chatSidebarRows.get(chat.id)).toEqual(
      expect.objectContaining({ id: chat.id, previewText: 'migrated preview' }),
    )
    await reopened.delete()
  })

  it('is idempotent across repeated open calls', async () => {
    const a = await openDb()
    const b = await openDb()
    expect(a).toBe(b)
    expect(a.isOpen()).toBe(true)
  })

  it('gives one concurrent connection ownership of a run-once backfill transaction', async () => {
    const name = `natter-test-run-once-owner-${Math.random().toString(36).slice(2)}`
    const first = await freshDb(name)
    await first.open()
    const second = createDbForTests(name)
    await second.open()
    const marker = { key: 'backfill:test-concurrent-owner-v1', value: 1 }
    let owners = 0
    const run = (db: NatterDb) =>
      runOnceBackfill(db, {
        marker,
        tables: [],
        run: async (tx) => {
          owners += 1
          await tx.table('settings').put({ key: 'test:concurrent-owner-result', value: 'complete' })
        },
      })

    const results = await Promise.all([run(first), run(second)])

    expect(results.filter(Boolean)).toHaveLength(1)
    expect(owners).toBe(1)
    expect(await first.settings.get(marker.key)).toEqual(marker)
    expect((await second.settings.get('test:concurrent-owner-result'))?.value).toBe('complete')
    second.close()
    await first.delete()
  })

  it('keeps every current-schema backfill complete across concurrent connections', async () => {
    const name = `natter-test-concurrent-current-backfills-${Math.random().toString(36).slice(2)}`
    const first = await freshDb(name)
    await first.open()
    const second = createDbForTests(name)
    await second.open()

    const legacySettings = structuredClone(cloneDefaultChatSettings()) as unknown as Record<
      string,
      unknown
    >
    delete legacySettings.tools
    delete legacySettings.toolCallContext
    legacySettings.enabledServerToolIds = ['web']
    const chat = {
      ...buildChat({ id: 'concurrent-backfill-chat', title: 'Legacy', now: 1 }),
      settings: legacySettings,
      tokenCalibration: {
        'anthropic:anthropic:claude-fable-5': {
          totalTextChars: 300,
          totalTextTokens: 100,
          sampleCount: 1,
          lastRatio: 3,
          updatedAt: 10,
        },
      },
    } as unknown as Record<string, unknown>
    delete chat.folderId
    delete chat.tags
    delete chat.titleStatus
    delete chat.lastViewedAt
    delete chat.lastUpdatedLeafId
    delete chat.lastBranchUpdatedAt
    delete chat.previewText
    await first.table<Record<string, unknown>>('chats').put(chat)
    await first.presets.put({
      id: 'concurrent-backfill-preset',
      name: 'Legacy preset',
      connectionProfileId: 'profile',
      settings: structuredClone(legacySettings) as unknown as Chat['settings'],
      createdAt: 1,
      updatedAt: 1,
    })

    const user = splitMessageForStorage({
      id: 'concurrent-backfill-user',
      chatId: 'concurrent-backfill-chat',
      parentId: null,
      siblingIndex: 0,
      turnId: 'concurrent-backfill-turn',
      turnIndex: 0,
      createdAt: 1,
      role: 'user',
      origin: 'user',
      content: [{ type: 'text', text: 'legacy preview' }],
      nodeVersion: 0,
      deleted: false,
    })
    await first.table<Record<string, unknown>>('messages').put({
      ...user.header,
      ...user.body,
    })
    const assistant = splitMessageForStorage({
      id: 'concurrent-backfill-assistant',
      chatId: 'concurrent-backfill-chat',
      parentId: 'concurrent-backfill-user',
      siblingIndex: 0,
      turnId: 'concurrent-backfill-turn',
      turnIndex: 1,
      createdAt: 2,
      role: 'assistant',
      origin: 'generated',
      content: [{ type: 'output_text', text: 'done' }],
      generation: {
        id: 'concurrent-backfill-generation',
        model: 'openai/gpt-5.6-luna',
        requestedModel: 'openai/gpt-5.6-luna',
        apiUsed: 'responses',
        delivery: 'streaming',
        costSource: 'stream',
        reasoningCarryForward: 'none',
        reasoningVisibility: { disclosure: 'unknown' },
        cost: 0.25,
        startedAt: 1,
        finishedAt: 2,
        serverTools: [
          {
            type: 'code_interpreter_call',
            source: 'responses-output',
            id: 'ci_concurrent',
            status: 'completed',
            outputIndex: 0,
          },
        ],
      },
      nodeVersion: 0,
      deleted: false,
    })
    delete assistant.body.providerOutputItems
    const legacyAssistantHeader = structuredClone(assistant.header) as unknown as Record<
      string,
      unknown
    >
    const legacyAssistantGeneration = legacyAssistantHeader.generation as Record<string, unknown>
    const legacyAssistantServerTools = legacyAssistantGeneration.serverTools as Record<
      string,
      unknown
    >[]
    const legacyAssistantServerTool = legacyAssistantServerTools[0]
    if (!legacyAssistantServerTool) throw new Error('ExpectedLegacyAssistantServerTool')
    legacyAssistantServerTool.output = {
      id: 'ci_concurrent',
      type: 'code_interpreter_call',
      status: 'completed',
      code: '1 + 1',
      outputs: [{ type: 'logs', logs: '2' }],
    }
    await first.table<Record<string, unknown>>('messages').put(legacyAssistantHeader)
    await first.messageBodies.put(assistant.body)
    await first.settings.bulkPut([
      { key: 'global:auto-scroll', value: true },
      { key: 'sidebar:sort-key', value: 'updated-desc' },
    ])
    await first.settings.bulkDelete([
      'backfill:message-body-split-v1',
      'backfill:chat-preview-projection-v1',
      'backfill:organization-fields-v1',
      'backfill:global-settings-v1',
      'backfill:provider-output-items-v1',
      'backfill:provider-tool-settings-v2',
      'backfill:token-calibration-global-v1',
      'backfill:token-calibration-canonicalize-v1',
    ])

    await Promise.all([
      runAuditedCurrentSchemaBackfills(first),
      runAuditedCurrentSchemaBackfills(second),
    ])

    const canonicalCalibrationKey = tokenCalibrationKey('anthropic/claude-fable-5')
    const storedChat = await first.chats.get('concurrent-backfill-chat')
    expect(storedChat).toMatchObject({
      folderId: null,
      tags: [],
      titleStatus: 'auto',
      lastViewedAt: 1,
      lastUpdatedLeafId: 'concurrent-backfill-assistant',
      lastBranchUpdatedAt: 0,
      previewText: 'legacy preview',
      wordCount: 3,
      totalCostUsd: 0.25,
    })
    expect(storedChat?.settings.tools.openrouter.enabledServerToolIds).toEqual(['web'])
    expect(storedChat?.tokenCalibration?.[canonicalCalibrationKey]?.sampleCount).toBe(1)
    expect(
      (await second.presets.get('concurrent-backfill-preset'))?.settings.tools.openrouter
        .enabledServerToolIds,
    ).toEqual(['web'])
    expect(await first.messageBodies.get('concurrent-backfill-user')).toMatchObject({
      content: [{ type: 'text', text: 'legacy preview' }],
    })
    expect(
      await first.table<Record<string, unknown>>('messages').get('concurrent-backfill-user'),
    ).not.toHaveProperty('content')
    expect(
      (await second.messageBodies.get('concurrent-backfill-assistant'))?.providerOutputItems,
    ).toHaveLength(1)
    expect((await first.settings.get('global:auto-scroll-stream'))?.value).toBe(true)
    expect(await first.settings.get('global:auto-scroll')).toBeUndefined()
    expect((await first.settings.get('sidebar:sort-key'))?.value).toBe('updatedAt-desc')
    const globalCalibration = (await first.settings.get('global:token-calibration'))
      ?.value as GlobalTokenCalibration
    expect(globalCalibration.byModel[canonicalCalibrationKey]).toMatchObject({ sampleCount: 1 })
    expect(await first.chatSidebarRows.get('concurrent-backfill-chat')).toMatchObject({
      previewText: 'legacy preview',
      projectionVersion: CHAT_SIDEBAR_PROJECTION_ROW_VERSION,
    })
    expect(await first.chatSidebarAggregates.get('workspace')).toMatchObject({ totalCount: 1 })
    const markerKeys = [
      'backfill:message-body-split-v1',
      'backfill:chat-preview-projection-v1',
      'backfill:organization-fields-v1',
      'backfill:global-settings-v1',
      'backfill:provider-output-items-v1',
      'backfill:provider-tool-settings-v2',
      'backfill:token-calibration-global-v1',
      'backfill:token-calibration-canonicalize-v1',
    ]
    const providerOutputMarker = providerOutputItemsBackfillMarker()
    expect((await first.settings.bulkGet(markerKeys)).map((row) => row?.value)).toEqual(
      markerKeys.map((key) => (key === providerOutputMarker.key ? providerOutputMarker.value : 1)),
    )
    expect((await first.settings.get(CHAT_SIDEBAR_PROJECTION_BACKFILL_KEY))?.value).toBe(
      CHAT_SIDEBAR_PROJECTION_MARKER_VERSION,
    )

    second.close()
    await first.delete()
  })

  it('does not rerun preview compatibility work after the current schema is open', async () => {
    let db = await openDb()
    const chat: Chat = {
      id: 'preview-backfill-chat',
      title: 'Preview backfill',
      titleStatus: 'manual',
      createdAt: 1,
      updatedAt: 1,
      lastViewedAt: 1,
      wordCount: 0,
      totalCostUsd: 0,
      metaVersion: 0,
      summaryVersion: 0,
      structuralVersion: 0,
      settings: cloneDefaultChatSettings(),
      lastUpdatedLeafId: 'preview-backfill-message',
      lastBranchUpdatedAt: 1,
      archived: false,
      pinned: false,
      folderId: null,
      tags: [],
      previewText: 'stale',
    }
    const message: Message = {
      id: 'preview-backfill-message',
      chatId: chat.id,
      parentId: null,
      siblingIndex: 0,
      turnId: 'preview-backfill-turn',
      turnIndex: 0,
      createdAt: 1,
      role: 'user',
      origin: 'user',
      content: [{ type: 'text', text: ' repaired\n preview ' }],
      nodeVersion: 0,
      deleted: false,
    }
    const split = splitMessageForStorage(message)
    await db.transaction(
      'rw',
      [db.chats, db.chatSidebarAggregates, db.chatSidebarRows, db.settings],
      async () => {
        await db.chats.put(chat)
        await db.chatSidebarRows.put(chatSidebarProjectionRow(chat))
        await db.chatSidebarAggregates.put({
          ...emptyChatSidebarAggregateRow(),
          totalCount: 1,
          activeCount: 1,
          visibleCount: 1,
          rootCount: 1,
          rootVisibleCount: 1,
        })
      },
    )
    await db.messages.put(split.header)
    await db.messageBodies.put(split.body)
    await db.settings.delete('backfill:chat-preview-projection-v1')
    await db.settings.delete('backfill:current-schema-manifest-v1')
    expect((await db.settings.get(CHAT_SIDEBAR_PROJECTION_BACKFILL_KEY))?.value).toBe(
      CHAT_SIDEBAR_PROJECTION_MARKER_VERSION,
    )
    expect((await db.chatSidebarRows.get(chat.id))?.previewText).toBe('stale')

    __resetDbForTests({ admissionsOpen: true })
    db = await openDb()
    expect((await db.chats.get(chat.id))?.previewText).toBe('stale')
    expect((await db.chatSidebarRows.get(chat.id))?.previewText).toBe('stale')
    expect(await db.settings.get('backfill:chat-preview-projection-v1')).toBeUndefined()

    await db.chats.update(chat.id, { previewText: 'current manifest prevents repeat scans' })
    await db.settings.delete('backfill:chat-preview-projection-v1')
    __resetDbForTests({ admissionsOpen: true })
    db = await openDb()
    expect((await db.chats.get(chat.id))?.previewText).toBe(
      'current manifest prevents repeat scans',
    )
    expect(await db.settings.get('backfill:chat-preview-projection-v1')).toBeUndefined()
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

interface LegacyStreamLeaseV20 {
  streamId: string
  chatId: string
  messageId: string
  ownerClientId: string
  startedAt: number
  heartbeatAt: number
  attemptKind?: 'generation' | 'continuation'
  requestedModel?: string
  apiUsed?: 'responses'
}

interface LegacyAttachmentV21 {
  id: string
  kind: 'other'
  mime: 'application/octet-stream'
  filename: string
  origin: 'import'
  createdAt: number
  updatedAt: number
  storage: { kind: 'missing'; reason: 'import-missing'; missingSince: number }
  artifacts: []
  processing: []
  refCount: number
}

function legacyAttachmentV21(id: string, refCount: number): LegacyAttachmentV21 {
  return {
    id,
    kind: 'other',
    mime: 'application/octet-stream',
    filename: `${id}.bin`,
    origin: 'import',
    createdAt: 1,
    updatedAt: 1,
    storage: { kind: 'missing', reason: 'import-missing', missingSince: 1 },
    artifacts: [],
    processing: [],
    refCount,
  }
}

const SYNTHETIC_PROFILE_BACKFILL_VERSION = 1000
const SYNTHETIC_SETTINGS_SEED_VERSION = 1001

function registerV1(db: Dexie): void {
  registerSchema(db)
}

function registerV1Through3(db: Dexie): void {
  registerSchema(db)
  db.version(SYNTHETIC_PROFILE_BACKFILL_VERSION)
    .stores({ profiles: 'id, name, kind, lastUsedAt, archived' })
    .upgrade(async (tx) => {
      await tx
        .table<MinimalProfile>('profiles')
        .toCollection()
        .modify((row) => {
          if (row.appTitle === undefined) row.appTitle = 'Natter'
        })
    })
  db.version(SYNTHETIC_SETTINGS_SEED_VERSION)
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

function registerLegacyStreamLeasesV20(db: Dexie): void {
  db.version(20).stores({
    chats:
      'id, updatedAt, createdAt, lastViewedAt, lastUpdatedLeafId, lastBranchUpdatedAt, wordCount, totalCostUsd, archived, pinned, presetId, folderId, *tags',
    settings: '&key',
    messages:
      'id, chatId, parentId, turnId, [chatId+parentId], [chatId+createdAt], [chatId+turnId], [chatId+deleted]',
    messageBodies: '&id, chatId, updatedAt, nodeVersion',
    streamLeases: '&streamId, chatId, ownerClientId, heartbeatAt',
    streamChunks: '&id, streamId, chatId, messageId, [streamId+seq], createdAt',
  })
}

function registerLegacyStreamLeaseLifecycleV66(db: Dexie): void {
  db.version(66).stores({
    chats: 'id',
    messages: 'id, chatId',
    streamLeases: '&streamId, &messageId, [chatId+streamId], [canonicalAt+streamId]',
    streamChunks: '&id, streamId, chatId, [streamId+seq]',
  })
}

function registerStreamLeaseLifecycleV67(db: Dexie): void {
  registerLegacyStreamLeaseLifecycleV66(db)
  db.version(67)
    .stores({
      streamLeases: '&streamId, &messageId, [chatId+streamId], [canonicalAt+streamId]',
    })
    .upgrade(migrateStreamLeaseLifecycleState)
}

function legacyLeaseChat(id: string): Chat {
  return {
    id,
    title: 'Legacy lease chat',
    titleStatus: 'manual',
    createdAt: 1,
    updatedAt: 1,
    lastViewedAt: 1,
    wordCount: 0,
    totalCostUsd: 0,
    metaVersion: 0,
    summaryVersion: 0,
    structuralVersion: 0,
    settings: { ...cloneDefaultChatSettings(), profileId: 'legacy-profile' },
    lastUpdatedLeafId: null,
    lastBranchUpdatedAt: 0,
    archived: false,
    pinned: false,
    folderId: null,
    tags: [],
  }
}

function legacyAssistantHeaderV20(
  id: string,
  nodeVersion: number,
  siblingIndex: number,
  generation?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id,
    chatId: 'chat-1',
    parentId: null,
    siblingIndex,
    turnId: `turn-${id}`,
    turnIndex: siblingIndex,
    createdAt: siblingIndex + 1,
    role: 'assistant',
    origin: 'generated',
    nodeVersion,
    deleted: false,
    ...(generation
      ? {
          generation: {
            model: 'legacy-model',
            requestedModel: 'legacy-model',
            ...generation,
          },
        }
      : {}),
  }
}

function legacyLeaseLifecycleHeader(
  id: string,
  options: {
    chatId?: string
    role?: string
    deleted?: boolean
    finished?: boolean
    nodeVersion?: number
    bodyVersion?: number
  } = {},
): Record<string, unknown> {
  const nodeVersion = options.nodeVersion ?? 3
  const bodyVersion = options.bodyVersion ?? 4
  return {
    ...legacyAssistantHeaderV20(
      id,
      nodeVersion,
      nodeVersion,
      options.finished ? { startedAt: 1, finishedAt: 2 } : { startedAt: 1 },
    ),
    chatId: options.chatId ?? 'chat-1',
    role: options.role ?? 'assistant',
    deleted: options.deleted ?? false,
    bodyVersion,
  }
}

function legacyLeaseLifecycleRow(
  streamId: unknown,
  messageId: unknown,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    streamId,
    chatId: 'chat-1',
    messageId,
    ownerClientId: `writer:${String(streamId)}`,
    fenceToken: `fence:${String(streamId)}`,
    replacementEpoch: 2,
    startedAt: 10,
    heartbeatAt: 11,
    admissionSequence: 12,
    revision: 13,
    attemptKind: 'generation',
    postCommit: { usedAt: 14, profileId: 'legacy-profile' },
    ...overrides,
  }
}

function legacyLeaseLifecycleChunk(
  streamId: unknown,
  messageId: unknown,
  suffix = '0',
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: `${String(streamId)}:${suffix}`,
    streamId,
    chatId: 'chat-1',
    messageId,
    seq: Number(suffix),
    createdAt: 15,
    event: { lane: 'text', text: String(streamId) },
    ownerClientId: `writer:${String(streamId)}`,
    fenceToken: `fence:${String(streamId)}`,
    replacementEpoch: 2,
    admissionSequence: 12,
    ...overrides,
  }
}

function registerLegacyAttemptOutcomesV21(db: Dexie): void {
  db.version(21).stores({
    settings: '&key',
    messages:
      'id, chatId, parentId, turnId, [chatId+parentId], [chatId+createdAt], [chatId+turnId], [chatId+deleted]',
    messageBodies: '&id, chatId, updatedAt, nodeVersion',
    streamChunks: '&id, streamId, chatId, messageId, [streamId+seq], createdAt',
  })
}

function registerLegacyAttachmentReferenceEdgesV21(db: Dexie): void {
  db.version(21).stores({
    attachments: 'id, refCount',
    attachmentBlobs: 'id, attachmentId',
    attachmentArtifacts: 'artifactId, attachmentId',
    attachmentJobs: 'id, attachmentId',
    messages: 'id, chatId',
    drafts: '&chatId',
    messageBodies: '&id, chatId, updatedAt, nodeVersion',
    streamChunks: '&id, streamId, chatId, messageId, [streamId+seq], createdAt',
  })
}

function canonicalAttachmentRef(
  refId: string,
  attachmentId: string,
  patch: Partial<MessageAttachmentRef> = {},
): MessageAttachmentRef {
  return {
    refId,
    attachmentId,
    includeInContext: true,
    presentation: {},
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  }
}

function legacyAttachmentMessageRows(
  id: string,
  chatId: string,
  createdAt: number,
  attachmentRefs: unknown,
  deleted = false,
): Readonly<{
  header: Record<string, unknown>
  body: Record<string, unknown>
}> {
  const stored = splitMessageForStorage({
    id,
    chatId,
    parentId: null,
    siblingIndex: 0,
    turnId: `turn-${id}`,
    turnIndex: 0,
    createdAt,
    role: 'user',
    origin: 'user',
    content: [],
    nodeVersion: 0,
    deleted,
  })
  return {
    header: {
      ...stored.header,
      attachmentRefs: structuredClone(attachmentRefs),
    },
    body: stored.body as unknown as Record<string, unknown>,
  }
}

function findAttachmentReferenceEdgeMigrationError(
  input: unknown,
): AttachmentReferenceEdgeMigrationError | undefined {
  let current = input
  const seen = new Set<unknown>()
  while (current && typeof current === 'object' && !seen.has(current)) {
    if (current instanceof AttachmentReferenceEdgeMigrationError) return current
    seen.add(current)
    const record = current as { inner?: unknown; cause?: unknown }
    current = record.inner ?? record.cause
  }
  return undefined
}

describe('Dexie migrations', () => {
  it('upgrades every valid v66 stream lease lifecycle phase exactly once in v67', async () => {
    const name = `natter-test-stream-lifecycle-v67-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)
    const legacy = new Dexie(name)
    registerLegacyStreamLeaseLifecycleV66(legacy)
    await legacy.open()
    await legacy.table<Chat>('chats').put(legacyLeaseChat('chat-1'))
    await legacy
      .table<Record<string, unknown>>('messages')
      .bulkPut([
        legacyLeaseLifecycleHeader('message-reserved', { nodeVersion: 1, bodyVersion: 2 }),
        legacyLeaseLifecycleHeader('message-active', { nodeVersion: 5, bodyVersion: 6 }),
        legacyLeaseLifecycleHeader('message-canonical', { nodeVersion: 7, bodyVersion: 8 }),
        legacyLeaseLifecycleHeader('message-metadata', { nodeVersion: 9, bodyVersion: 10 }),
      ])
    const legacyRows = [
      legacyLeaseLifecycleRow('reserved-stream', 'message-reserved'),
      legacyLeaseLifecycleRow('active-stream', 'message-active', {
        ownerClientId: 'recovery:active-stream',
        attemptKind: 'continuation',
        targetCommittedAt: 20,
        requestedModel: 'legacy/active',
        apiUsed: 'responses',
        continuationStrategy: 'prefill',
        baseNodeVersion: 5,
        baseBodyVersion: 6,
      }),
      legacyLeaseLifecycleRow('canonical-stream', 'message-canonical', {
        canonicalAt: 30,
      }),
      legacyLeaseLifecycleRow('metadata-stream', 'message-metadata', {
        ownerClientId: 'recovery:metadata-stream',
        targetCommittedAt: 21,
        requestedModel: 'legacy/metadata',
        apiUsed: 'anthropic-messages',
        canonicalAt: 31,
        metadataCommittedAt: 32,
        journalStorageBytes: 400,
        journalMaxSeq: 0,
        postCommit: {
          usedAt: 14,
          profileId: 'legacy-profile',
          selectedKeyId: 'legacy-key',
          final: {
            selectedKeyId: 'legacy-key',
            usage: { promptTokens: 3, completionTokens: 4 },
            completionAllowed: true,
            expectedNodeVersion: 9,
            expectedBodyVersion: 10,
          },
        },
      }),
    ]
    const retainedChunk = legacyLeaseLifecycleChunk('metadata-stream', 'message-metadata', '0', {
      ownerClientId: 'recovery:metadata-stream',
    })
    await legacy.table<Record<string, unknown>>('streamLeases').bulkPut(legacyRows)
    await legacy.table<Record<string, unknown>>('streamChunks').put(retainedChunk)
    legacy.close()

    const migrated = new Dexie(name)
    registerStreamLeaseLifecycleV67(migrated)
    await migrated.open()
    const rows = await migrated
      .table<StreamLeaseRow, string>('streamLeases')
      .bulkGet(['reserved-stream', 'active-stream', 'canonical-stream', 'metadata-stream'])
    expect(rows).toEqual([
      {
        streamId: 'reserved-stream',
        chatId: 'chat-1',
        messageId: 'message-reserved',
        custody: 'writer',
        ownerClientId: 'writer:reserved-stream',
        fenceToken: 'fence:reserved-stream',
        replacementEpoch: 2,
        startedAt: 10,
        heartbeatAt: 11,
        admissionSequence: 12,
        revision: 13,
        attemptKind: 'generation',
        phase: 'reserved',
        targetOwnerKey: 'message-reserved',
        postCommit: { usedAt: 14, profileId: 'legacy-profile' },
      },
      {
        streamId: 'active-stream',
        chatId: 'chat-1',
        messageId: 'message-active',
        custody: 'recovery',
        ownerClientId: 'recovery:active-stream',
        fenceToken: 'fence:active-stream',
        replacementEpoch: 2,
        startedAt: 10,
        heartbeatAt: 11,
        admissionSequence: 12,
        revision: 13,
        attemptKind: 'continuation',
        phase: 'active',
        targetOwnerKey: 'message-active',
        dispatch: {
          targetCommittedAt: 20,
          requestedModel: 'legacy/active',
          apiUsed: 'responses',
          continuationStrategy: 'prefill',
          baseNodeVersion: 5,
          baseBodyVersion: 6,
        },
        postCommit: { usedAt: 14, profileId: 'legacy-profile' },
      },
      {
        streamId: 'canonical-stream',
        chatId: 'chat-1',
        messageId: 'message-canonical',
        custody: 'writer',
        ownerClientId: 'writer:canonical-stream',
        fenceToken: 'fence:canonical-stream',
        replacementEpoch: 2,
        startedAt: 10,
        heartbeatAt: 11,
        admissionSequence: 12,
        revision: 13,
        attemptKind: 'generation',
        phase: 'canonical',
        targetOwnerKey: 'message-canonical',
        dispatch: null,
        canonicalAt: 30,
        postCommit: {
          usedAt: 14,
          profileId: 'legacy-profile',
          final: {
            completionAllowed: false,
            expectedNodeVersion: 7,
            expectedBodyVersion: 8,
          },
        },
      },
      {
        streamId: 'metadata-stream',
        chatId: 'chat-1',
        messageId: 'message-metadata',
        custody: 'recovery',
        ownerClientId: 'recovery:metadata-stream',
        fenceToken: 'fence:metadata-stream',
        replacementEpoch: 2,
        startedAt: 10,
        heartbeatAt: 11,
        admissionSequence: 12,
        revision: 13,
        journalStorageBytes: 400,
        journalMaxSeq: 0,
        attemptKind: 'generation',
        phase: 'metadata-committed',
        dispatch: {
          targetCommittedAt: 21,
          requestedModel: 'legacy/metadata',
          apiUsed: 'anthropic-messages',
        },
        canonicalAt: 31,
        metadataCommittedAt: 32,
        terminalRetentionAt: 31,
        postCommit: {
          usedAt: 14,
          profileId: 'legacy-profile',
          selectedKeyId: 'legacy-key',
          final: {
            selectedKeyId: 'legacy-key',
            usage: { promptTokens: 3, completionTokens: 4 },
            completionAllowed: true,
            expectedNodeVersion: 9,
            expectedBodyVersion: 10,
          },
        },
      },
    ])
    for (const row of rows) {
      expect(row).not.toHaveProperty('targetCommittedAt')
      expect(row).not.toHaveProperty('requestedModel')
      expect(row).not.toHaveProperty('apiUsed')
      expect(row).not.toHaveProperty('continuationStrategy')
      expect(row).not.toHaveProperty('baseNodeVersion')
      expect(row).not.toHaveProperty('baseBodyVersion')
    }
    expect(await migrated.table('streamChunks').get('metadata-stream:0')).toEqual(retainedChunk)

    const firstRow = rows[0]
    if (!firstRow) throw new Error('expected migrated stream lease')
    const changed = { ...firstRow, revision: firstRow.revision + 1 }
    await migrated.table<StreamLeaseRow, string>('streamLeases').put(changed)
    migrated.close()
    const reopened = new Dexie(name)
    registerStreamLeaseLifecycleV67(reopened)
    await reopened.open()
    expect(await reopened.table('streamLeases').get('reserved-stream')).toEqual(changed)
    await reopened.delete()
  })

  it('retires malformed v66 stream lifecycle rows and their chunks without disturbing valid rows', async () => {
    const name = `natter-test-stream-lifecycle-invalid-v67-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)
    const legacy = new Dexie(name)
    registerLegacyStreamLeaseLifecycleV66(legacy)
    await legacy.open()
    await legacy.table<Chat>('chats').put(legacyLeaseChat('chat-1'))
    await legacy
      .table<Record<string, unknown>>('messages')
      .bulkPut([
        legacyLeaseLifecycleHeader('message-control'),
        legacyLeaseLifecycleHeader('message-numeric-chat'),
        legacyLeaseLifecycleHeader('message-user', { role: 'user' }),
        legacyLeaseLifecycleHeader('message-deleted', { deleted: true }),
        legacyLeaseLifecycleHeader('message-wrong-chat', { chatId: 'chat-2' }),
        legacyLeaseLifecycleHeader('message-ambiguous-continuation'),
        legacyLeaseLifecycleHeader('message-metadata-without-canonical'),
        legacyLeaseLifecycleHeader('message-final-without-canonical'),
        legacyLeaseLifecycleHeader('message-missing-post-commit'),
        legacyLeaseLifecycleHeader('message-finished-generation', { finished: true }),
        legacyLeaseLifecycleHeader('message-invalid-target-time'),
        legacyLeaseLifecycleHeader('message-invalid-canonical-time'),
        legacyLeaseLifecycleHeader('message-invalid-metadata-time'),
        legacyLeaseLifecycleHeader('message-invalid-journal-bytes'),
        legacyLeaseLifecycleHeader('message-invalid-journal-seq'),
      ])
    const missingPostCommit = legacyLeaseLifecycleRow(
      'missing-post-commit',
      'message-missing-post-commit',
    )
    delete missingPostCommit.postCommit
    const invalidRows: Record<string, unknown>[] = [
      legacyLeaseLifecycleRow(42, 99),
      legacyLeaseLifecycleRow('numeric-chat', 'message-numeric-chat', { chatId: 42 }),
      legacyLeaseLifecycleRow('user-target', 'message-user'),
      legacyLeaseLifecycleRow('deleted-target', 'message-deleted'),
      legacyLeaseLifecycleRow('wrong-chat-target', 'message-wrong-chat'),
      legacyLeaseLifecycleRow('ambiguous-continuation', 'message-ambiguous-continuation', {
        attemptKind: 'continuation',
        targetCommittedAt: 20,
        requestedModel: 'legacy/ambiguous',
        apiUsed: 'chat',
        continuationStrategy: 'prompt',
        baseNodeVersion: 3,
      }),
      legacyLeaseLifecycleRow('metadata-without-canonical', 'message-metadata-without-canonical', {
        metadataCommittedAt: 30,
      }),
      legacyLeaseLifecycleRow('final-without-canonical', 'message-final-without-canonical', {
        postCommit: {
          usedAt: 14,
          profileId: 'legacy-profile',
          final: { completionAllowed: false },
        },
      }),
      missingPostCommit,
      legacyLeaseLifecycleRow('finished-generation', 'message-finished-generation', {
        targetCommittedAt: 20,
        requestedModel: 'legacy/finished',
        apiUsed: 'chat',
      }),
      legacyLeaseLifecycleRow('invalid-target-time', 'message-invalid-target-time', {
        targetCommittedAt: -1,
      }),
      legacyLeaseLifecycleRow('invalid-canonical-time', 'message-invalid-canonical-time', {
        canonicalAt: -1,
      }),
      legacyLeaseLifecycleRow('invalid-metadata-time', 'message-invalid-metadata-time', {
        canonicalAt: 30,
        metadataCommittedAt: -1,
      }),
      legacyLeaseLifecycleRow('invalid-journal-bytes', 'message-invalid-journal-bytes', {
        journalStorageBytes: -1,
      }),
      legacyLeaseLifecycleRow('invalid-journal-seq', 'message-invalid-journal-seq', {
        journalMaxSeq: -1,
      }),
    ]
    const control = legacyLeaseLifecycleRow('control-stream', 'message-control')
    const allRows = [control, ...invalidRows]
    const chunks = allRows.map((row) => legacyLeaseLifecycleChunk(row.streamId, row.messageId))
    await legacy.table<Record<string, unknown>>('streamLeases').bulkPut(allRows)
    await legacy.table<Record<string, unknown>>('streamChunks').bulkPut(chunks)
    legacy.close()

    const migrated = new Dexie(name)
    registerStreamLeaseLifecycleV67(migrated)
    await migrated.open()
    expect(await migrated.table('streamLeases').get('control-stream')).toEqual({
      streamId: 'control-stream',
      chatId: 'chat-1',
      messageId: 'message-control',
      custody: 'writer',
      ownerClientId: 'writer:control-stream',
      fenceToken: 'fence:control-stream',
      replacementEpoch: 2,
      startedAt: 10,
      heartbeatAt: 11,
      admissionSequence: 12,
      revision: 13,
      attemptKind: 'generation',
      phase: 'reserved',
      targetOwnerKey: 'message-control',
      postCommit: { usedAt: 14, profileId: 'legacy-profile' },
    })
    expect(await migrated.table('streamChunks').get('control-stream:0')).toEqual(chunks[0])
    for (const row of invalidRows) {
      expect(await migrated.table('streamLeases').get(row.streamId as never)).toBeUndefined()
      expect(await migrated.table('streamChunks').get(`${String(row.streamId)}:0`)).toBeUndefined()
    }
    expect(await migrated.table('streamLeases').count()).toBe(1)
    expect(await migrated.table('streamChunks').count()).toBe(1)
    await migrated.delete()
  })

  it('rebuilds normalized attachment edges and exact refcounts once in v22', async () => {
    const name = `natter-test-attachment-edges-v22-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)

    const messageRefs = [
      canonicalAttachmentRef('message-a-1', 'attachment-a', { includeInContext: false }),
      canonicalAttachmentRef('message-b-deleted', 'attachment-b', { deletedAt: 10 }),
      canonicalAttachmentRef('message-a-2', 'attachment-a'),
    ]
    const draftRefs = [
      canonicalAttachmentRef('draft-b', 'attachment-b'),
      canonicalAttachmentRef('draft-missing-deleted', 'attachment-missing', { deletedAt: 11 }),
    ]

    const legacy = new Dexie(name)
    registerLegacyAttachmentReferenceEdgesV21(legacy)
    await legacy.open()
    const messageRow = legacyAttachmentMessageRows('message-1', 'chat-1', 1, messageRefs, true)
    const legacyStringRow = legacyAttachmentMessageRows('message-legacy-strings', 'chat-1', 12, [
      'attachment-b',
    ])
    await legacy
      .table<LegacyAttachmentV21>('attachments')
      .bulkPut([
        legacyAttachmentV21('attachment-a', 91),
        legacyAttachmentV21('attachment-b', 92),
        legacyAttachmentV21('attachment-unreferenced', 93),
      ])
    await legacy
      .table<Record<string, unknown>>('messages')
      .bulkPut([messageRow.header, legacyStringRow.header])
    await legacy
      .table<Record<string, unknown>>('messageBodies')
      .bulkPut([messageRow.body, legacyStringRow.body])
    await legacy.table<Record<string, unknown>>('drafts').put({
      chatId: 'chat-1',
      attachmentRefs: structuredClone(draftRefs),
    })
    legacy.close()

    const migrated = createDbForTests(name)
    await migrated.open()
    expect(migrated.verno).toBe(CURRENT_DB_VERSION)
    expect(await migrated.attachmentRefEdges.toArray()).toEqual(
      expect.arrayContaining<AttachmentReferenceEdge>([
        {
          ownerKind: 'message',
          ownerId: 'message-1',
          chatId: 'chat-1',
          refId: 'message-a-1',
          attachmentId: 'attachment-a',
          ordinal: 0,
          includeInContext: false,
          refUpdatedAt: 1,
        },
        {
          ownerKind: 'message',
          ownerId: 'message-1',
          chatId: 'chat-1',
          refId: 'message-a-2',
          attachmentId: 'attachment-a',
          ordinal: 2,
          includeInContext: true,
          refUpdatedAt: 1,
        },
        {
          ownerKind: 'draft',
          ownerId: 'chat-1',
          chatId: 'chat-1',
          refId: 'draft-b',
          attachmentId: 'attachment-b',
          ordinal: 0,
          includeInContext: true,
          refUpdatedAt: 1,
        },
        {
          ownerKind: 'message',
          ownerId: 'message-legacy-strings',
          chatId: 'chat-1',
          refId: 'legacy:message-legacy-strings:0',
          attachmentId: 'attachment-b',
          ordinal: 0,
          includeInContext: true,
          refUpdatedAt: 12,
        },
      ]),
    )
    expect(await migrated.attachmentRefEdges.count()).toBe(4)
    expect((await migrated.attachments.get('attachment-a'))?.refCount).toBe(2)
    expect((await migrated.attachments.get('attachment-b'))?.refCount).toBe(2)
    expect((await migrated.attachments.get('attachment-unreferenced'))?.refCount).toBe(0)
    expect((await migrated.messages.get('message-1'))?.attachmentRefs).toEqual(messageRefs)
    expect((await migrated.messages.get('message-legacy-strings'))?.attachmentRefs).toEqual([
      expect.objectContaining({
        refId: 'legacy:message-legacy-strings:0',
        attachmentId: 'attachment-b',
      }),
    ])
    expect((await migrated.drafts.get('chat-1'))?.attachmentRefs).toEqual(draftRefs)
    expect((await migrated.settings.get('backfill:attachment-refs-v1'))?.value).toBe(1)

    const expectedEdges = await migrated.attachmentRefEdges.toArray()
    await migrated.transaction(
      'rw',
      [migrated.attachmentRefEdges, migrated.attachments, migrated.messages, migrated.drafts],
      async (tx) => {
        await rebuildAttachmentReferenceEdges(tx)
        await rebuildAttachmentReferenceEdges(tx)
      },
    )
    expect(await migrated.attachmentRefEdges.toArray()).toEqual(expectedEdges)
    await migrated.attachments.update('attachment-a', { refCount: 19 })
    migrated.close()

    const reopened = createDbForTests(name)
    await reopened.open()
    expect(await reopened.attachmentRefEdges.toArray()).toEqual(expectedEdges)
    expect((await reopened.attachments.get('attachment-a'))?.refCount).toBe(19)
    await reopened.delete()
  })

  it('scrubs stale byte-derived pointers from missing attachments once in v22', async () => {
    const name = `natter-test-missing-attachment-v22-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)
    const textArtifact = {
      kind: 'text',
      artifactId: 'artifact-text',
      attachmentId: 'attachment-missing',
      processorId: 'extract-v1',
      text: 'retained text',
      charCount: 13,
      createdAt: 1,
    }
    const blobArtifact = {
      kind: 'blob',
      artifactId: 'artifact-thumbnail',
      attachmentId: 'attachment-missing',
      processorId: 'thumbnail-v1',
      blobId: 'blob-thumbnail',
      createdAt: 1,
    }
    const legacy = new Dexie(name)
    registerLegacyAttachmentReferenceEdgesV21(legacy)
    await legacy.open()
    await legacy.table('attachments').put({
      id: 'attachment-missing',
      kind: 'plaintext',
      mime: 'text/plain',
      filename: 'missing.txt',
      origin: 'user-upload',
      createdAt: 1,
      updatedAt: 2,
      storage: {
        kind: 'missing',
        reason: 'deleted',
        missingSince: 2,
        lastKnownBlobId: 'blob-original',
      },
      thumbnailBlobId: 'blob-thumbnail',
      artifacts: [textArtifact, blobArtifact],
      processing: [
        {
          processorId: 'mixed-v1',
          inputHash: 'hash',
          status: 'succeeded',
          outputArtifactIds: ['artifact-text', 'artifact-thumbnail'],
        },
        {
          processorId: 'thumbnail-v1',
          inputHash: 'hash',
          status: 'succeeded',
          outputArtifactIds: ['artifact-thumbnail'],
        },
      ],
      refCount: 0,
    })
    await legacy.table('attachmentBlobs').bulkPut([
      { id: 'blob-original', attachmentId: 'attachment-missing' },
      { id: 'blob-thumbnail', attachmentId: 'attachment-missing' },
    ])
    await legacy.table('attachmentArtifacts').bulkPut([textArtifact, blobArtifact])
    await legacy.table('attachmentJobs').bulkPut([
      {
        id: 'arbitrary-mixed-job',
        attachmentId: 'attachment-missing',
        processorId: 'mixed-v1',
        inputHash: 'hash',
        status: 'succeeded',
        outputArtifactIds: ['artifact-text', 'artifact-thumbnail'],
        updatedAt: 2,
      },
      {
        id: 'arbitrary-thumbnail-job',
        attachmentId: 'attachment-missing',
        processorId: 'thumbnail-v1',
        inputHash: 'hash',
        status: 'succeeded',
        outputArtifactIds: ['artifact-thumbnail'],
        updatedAt: 2,
      },
    ])
    legacy.close()

    const migrated = createDbForTests(name)
    await migrated.open()
    const attachment = await migrated.attachments.get('attachment-missing')
    expect(attachment?.thumbnailBlobId).toBeUndefined()
    expect(attachment).not.toHaveProperty('artifacts')
    expect(attachment).toHaveProperty('artifactIds', [textArtifact.artifactId])
    expect(attachment?.processing).toEqual([
      expect.objectContaining({ processorId: 'mixed-v1', outputArtifactIds: ['artifact-text'] }),
    ])
    expect(await migrated.attachmentBlobs.count()).toBe(0)
    expect(await migrated.attachmentArtifacts.toArray()).toEqual([textArtifact])
    expect(await migrated.attachmentJobs.toArray()).toEqual([
      expect.objectContaining({ id: 'arbitrary-mixed-job', outputArtifactIds: ['artifact-text'] }),
    ])

    await migrated.attachments.update('attachment-missing', {
      thumbnailBlobId: 'post-migration-sentinel',
    })
    migrated.close()
    const reopened = createDbForTests(name)
    await reopened.open()
    expect((await reopened.attachments.get('attachment-missing'))?.thumbnailBlobId).toBe(
      'post-migration-sentinel',
    )
    await reopened.delete()
  })

  it.each([
    {
      label: 'duplicate ref IDs',
      expectedCode: 'duplicate-ref-id' as const,
      refs: [
        canonicalAttachmentRef('duplicate', 'attachment-a'),
        canonicalAttachmentRef('duplicate', 'attachment-a', { deletedAt: 9 }),
      ],
    },
    {
      label: 'a missing target for a live ref',
      expectedCode: 'missing-attachment' as const,
      refs: [canonicalAttachmentRef('missing', 'attachment-missing')],
    },
  ])('rejects $label and rolls the entire v22 upgrade back', async ({ expectedCode, refs }) => {
    const name = `natter-test-attachment-edges-poison-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)
    const legacy = new Dexie(name)
    registerLegacyAttachmentReferenceEdgesV21(legacy)
    await legacy.open()
    const poisonRow = legacyAttachmentMessageRows('message-poison', 'chat-poison', 1, refs)
    await legacy
      .table<LegacyAttachmentV21>('attachments')
      .put(legacyAttachmentV21('attachment-a', 77))
    await legacy.table<Record<string, unknown>>('messages').put(poisonRow.header)
    await legacy.table<Record<string, unknown>>('messageBodies').put(poisonRow.body)
    legacy.close()

    const attempted = createDbForTests(name)
    let failure: unknown
    try {
      await attempted.open()
    } catch (error) {
      failure = error
    }
    expect(findAttachmentReferenceEdgeMigrationError(failure)).toMatchObject({
      code: expectedCode,
      ownerKind: 'message',
      ownerId: 'message-poison',
    })
    attempted.close()

    const inspection = new Dexie(name)
    registerLegacyAttachmentReferenceEdgesV21(inspection)
    await inspection.open()
    expect(inspection.verno).toBe(21)
    expect(
      (await inspection.table<Record<string, unknown>>('attachments').get('attachment-a'))
        ?.refCount,
    ).toBe(77)
    expect(inspection.tables.some((table) => table.name === 'attachmentRefEdges')).toBe(false)
    expect(
      (await inspection.table<Record<string, unknown>>('messages').get('message-poison'))
        ?.attachmentRefs,
    ).toEqual(refs)
    if (expectedCode === 'duplicate-ref-id') {
      await inspection.table<Record<string, unknown>>('messages').update('message-poison', {
        attachmentRefs: [structuredClone(refs[0])],
      })
    } else {
      await inspection
        .table<LegacyAttachmentV21>('attachments')
        .put(legacyAttachmentV21('attachment-missing', 0))
    }
    inspection.close()

    const retried = createDbForTests(name)
    await retried.open()
    expect(retried.verno).toBe(CURRENT_DB_VERSION)
    expect(await retried.attachmentRefEdges.count()).toBe(1)
    expect((await retried.settings.get('backfill:attachment-refs-v1'))?.value).toBe(1)
    await retried.delete()
  })

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
    expect(db.verno).toBe(SYNTHETIC_SETTINGS_SEED_VERSION)
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
    expect(up.verno).toBe(SYNTHETIC_SETTINGS_SEED_VERSION)
    const profile = await up.table<MinimalProfile>('profiles').get('P1')
    expect(profile?.appTitle).toBe('CustomTitle') // preserved — synthetic bump only fills undefined
    const tag = await up.table<MinimalSetting>('settings').get('schemaTag')
    expect(tag?.value).toBe('preexisting') // later synthetic bump only seeds when absent
    up.close()

    const reopen = new Dexie(name)
    registerV1Through3(reopen)
    await reopen.open()
    expect(reopen.verno).toBe(SYNTHETIC_SETTINGS_SEED_VERSION)
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

  it('carries a valid v20 lease through classification while retiring ambiguous attempts', async () => {
    const name = `natter-test-stream-lease-v21-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)

    const legacy = new Dexie(name)
    registerLegacyStreamLeasesV20(legacy)
    await legacy.open()
    await legacy.table<Chat>('chats').put(legacyLeaseChat('chat-1'))
    await legacy
      .table<Record<string, unknown>>('messages')
      .bulkPut([
        legacyAssistantHeaderV20('message-generating', 4, 0, { startedAt: 1 }),
        legacyAssistantHeaderV20('message-complete', 7, 1, { startedAt: 1, finishedAt: 2 }),
        legacyAssistantHeaderV20('message-without-generation', 9, 2),
      ])
    await legacy
      .table<Record<string, unknown>>('messageBodies')
      .bulkPut([
        legacyEmptyMessageBody('message-generating', 'chat-1', 4),
        legacyEmptyMessageBody('message-complete', 'chat-1', 7),
        legacyEmptyMessageBody('message-without-generation', 'chat-1', 9),
      ])
    const legacyLeases: LegacyStreamLeaseV20[] = [
      {
        streamId: 'original-stream',
        chatId: 'chat-1',
        messageId: 'message-generating',
        ownerClientId: 'tab-1',
        startedAt: 1,
        heartbeatAt: 2,
      },
      {
        streamId: 'continue-stream',
        chatId: 'chat-1',
        messageId: 'message-complete',
        ownerClientId: 'tab-1',
        startedAt: 3,
        heartbeatAt: 4,
      },
      {
        streamId: 'continue-without-generation',
        chatId: 'chat-1',
        messageId: 'message-without-generation',
        ownerClientId: 'tab-1',
        startedAt: 5,
        heartbeatAt: 6,
      },
      {
        streamId: 'continue-without-header',
        chatId: 'chat-1',
        messageId: 'missing-message',
        ownerClientId: 'tab-1',
        startedAt: 7,
        heartbeatAt: 8,
      },
      {
        streamId: 'already-classified',
        chatId: 'chat-1',
        messageId: 'message-complete',
        ownerClientId: 'tab-2',
        startedAt: 9,
        heartbeatAt: 10,
        attemptKind: 'generation',
        requestedModel: 'model-a',
        apiUsed: 'responses',
      },
    ]
    await legacy.table<LegacyStreamLeaseV20>('streamLeases').bulkPut(legacyLeases)
    legacy.close()

    const migrated = createDbForTests(name)
    await migrated.open()
    expect(migrated.verno).toBe(CURRENT_DB_VERSION)
    const survivingLease = await migrated.streamLeases.get('original-stream')
    expect(survivingLease).toMatchObject({
      streamId: 'original-stream',
      chatId: 'chat-1',
      messageId: 'message-generating',
      startedAt: 1,
      attemptKind: 'generation',
      custody: 'recovery-pending',
      phase: 'active',
      replacementEpoch: 0,
      revision: 1,
      controlRevision: 0,
      journalEventVersion: 2,
      handoffReason: 'owner-unavailable',
      dispatch: {
        targetCommittedAt: 1,
        apiUsed: 'chat',
        reasoningCarryForward: 'unknown',
        reasoningVisibility: { disclosure: 'unknown' },
      },
      postCommit: { usedAt: 1, profileId: 'legacy-profile' },
    })
    expect(typeof survivingLease?.admissionSequence).toBe('number')
    expect(survivingLease?.handoffId).toMatch(/^migration:0:original-stream:\d+$/)
    expect(typeof survivingLease?.handedOffAt).toBe('number')
    expect(typeof survivingLease?.dispatch?.requestedModel).toBe('string')
    expect(survivingLease).not.toHaveProperty('targetCommittedAt')
    expect(survivingLease).not.toHaveProperty('ownerClientId')
    expect(survivingLease).not.toHaveProperty('heartbeatAt')
    expect(survivingLease).not.toHaveProperty('fenceToken')
    expect(
      await migrated.streamLeases.bulkGet(legacyLeases.slice(1).map((row) => row.streamId)),
    ).toEqual([undefined, undefined, undefined, undefined])
    await migrated.delete()
  })

  it('does not rerun legacy lease migrations after the full upgrade is current', async () => {
    const name = `natter-test-stream-lease-v21-idempotent-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)

    const legacy = new Dexie(name)
    registerLegacyStreamLeasesV20(legacy)
    await legacy.open()
    await legacy.table<Chat>('chats').put(legacyLeaseChat('chat-1'))
    await legacy
      .table<Record<string, unknown>>('messages')
      .put(legacyAssistantHeaderV20('message-generating', 7, 0, { startedAt: 1 }))
    await legacy
      .table<Record<string, unknown>>('messageBodies')
      .put(legacyEmptyMessageBody('message-generating', 'chat-1', 7))
    await legacy.table<LegacyStreamLeaseV20>('streamLeases').put({
      streamId: 'generation-stream',
      chatId: 'chat-1',
      messageId: 'message-generating',
      ownerClientId: 'tab-1',
      startedAt: 3,
      heartbeatAt: 4,
    })
    legacy.close()

    const migrated = createDbForTests(name)
    await migrated.open()
    const classified = await migrated.streamLeases.get('generation-stream')
    expect(classified).toMatchObject({ attemptKind: 'generation' })
    if (!classified) throw new Error('expected migrated stream lease')
    const manuallyChanged: StreamLeaseRow = { ...classified, revision: classified.revision + 1 }
    await migrated.streamLeases.put(manuallyChanged)
    migrated.close()

    const reopened = createDbForTests(name)
    await reopened.open()
    expect(await reopened.streamLeases.get('generation-stream')).toEqual(manuallyChanged)
    await reopened.delete()
  })

  it.each([
    20, 21,
  ])('upgrades v%i workspace metadata through replacement epoch and incarnation migrations', async (legacyVersion) => {
    const name = `natter-test-workspace-meta-v${legacyVersion}-v22-${Math.random()
      .toString(36)
      .slice(2)}`
    await Dexie.delete(name)

    const legacy = new Dexie(name)
    if (legacyVersion === 20) registerLegacyStreamLeasesV20(legacy)
    else registerLegacyAttemptOutcomesV21(legacy)
    await legacy.open()
    const legacyValue = {
      workspaceId: 'browser-idb:natter',
      backendKind: 'browser-idb',
      lastMutationAt: 123,
      mutationCounter: 17,
    }
    await legacy.table('settings').put({ key: 'workspace-meta', value: legacyValue })
    legacy.close()

    const migrated = createDbForTests(name)
    await migrated.open()
    const upgradedValue = await migrated.workspaceFence.get('global')
    expect(upgradedValue).toMatchObject({
      id: 'global',
      replacementEpoch: 0,
    })
    expect(upgradedValue?.workspaceId).toMatch(/^browser-idb:[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(await migrated.settings.get('workspace-meta')).toBeUndefined()
    if (!upgradedValue) throw new Error('expected migrated workspace fence')
    await migrated.workspaceFence.put({ ...upgradedValue, replacementEpoch: 9 })
    migrated.close()

    const reopened = createDbForTests(name)
    await reopened.open()
    expect(await reopened.workspaceFence.get('global')).toEqual({
      ...upgradedValue,
      replacementEpoch: 9,
    })
    await reopened.delete()
  })

  it('carries v21 attempt outcomes through orphan recovery and strips raw failure payloads', async () => {
    const name = `natter-test-attempt-outcomes-v22-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)

    const legacy = new Dexie(name)
    registerLegacyAttemptOutcomesV21(legacy)
    await legacy.open()
    await legacy.table<Record<string, unknown>>('messages').bulkPut([
      legacyAssistantHeaderV20('streaming', 0, 0, { startedAt: 1 }),
      legacyAssistantHeaderV20('failed', 0, 1, {
        startedAt: 1,
        finishedAt: 2,
        error: {
          code: 'NETWORK',
          message: 'connection lost',
          raw: { kind: 'network', metadata: { authorization: 'raw-secret' } },
        },
      }),
      legacyAssistantHeaderV20('interrupted', 0, 2, {
        startedAt: 1,
        finishedAt: 2,
        abortReason: 'tab-close',
      }),
      legacyAssistantHeaderV20('done', 0, 3, { startedAt: 1, finishedAt: 2 }),
    ])
    await legacy
      .table<Record<string, unknown>>('messageBodies')
      .bulkPut([
        legacyEmptyMessageBody('streaming', 'chat-1'),
        legacyEmptyMessageBody('interrupted', 'chat-1'),
        legacyEmptyMessageBody('done', 'chat-1'),
      ])
    await legacy.table<Record<string, unknown>>('messageBodies').put({
      id: 'failed',
      chatId: 'chat-1',
      nodeVersion: 0,
      updatedAt: 2,
      content: [],
      continuationAttempts: [
        {
          streamId: 'continue-1',
          strategy: 'prompt',
          status: 'error',
          startedAt: 1,
          finishedAt: 2,
          error: {
            code: 502,
            message: 'Bearer sk-private-value',
            raw: { kind: 'provider_error', metadata: { prompt: 'raw-secret' } },
          },
        },
      ],
    })
    await legacy.table<Record<string, unknown>>('streamChunks').put({
      id: 'stream-1:0',
      streamId: 'stream-1',
      chatId: 'chat-1',
      messageId: 'failed',
      seq: 0,
      createdAt: 2,
      event: {
        lane: 'error',
        error: {
          kind: 'provider_error',
          code: 502,
          message: 'provider failed',
          midStream: true,
          retryable: true,
          metadata: { output: 'raw-secret' },
        },
      },
    })
    legacy.close()

    const migrated = createDbForTests(name)
    await migrated.open()
    expect(migrated.verno).toBe(CURRENT_DB_VERSION)
    expect((await migrated.messages.get('streaming'))?.generation).toMatchObject({
      status: 'interrupted',
      integrity: 'clean',
      abortReason: 'tab-close',
    })
    expect((await migrated.messages.get('failed'))?.generation).toMatchObject({
      status: 'error',
      integrity: 'clean',
      error: {
        category: 'network',
        code: 'NETWORK',
        message: 'connection lost',
      },
    })
    expect((await migrated.messages.get('interrupted'))?.generation).toMatchObject({
      status: 'interrupted',
      integrity: 'clean',
    })
    expect((await migrated.messages.get('done'))?.generation).toMatchObject({
      status: 'done',
      integrity: 'clean',
    })
    const body = await migrated.messageBodies.get('failed')
    expect(body?.continuationAttempts?.[0]).toMatchObject({
      status: 'error',
      integrity: 'clean',
      error: {
        category: 'provider',
        code: '502',
        message: 'Bearer <redacted>',
      },
    })
    const chunk = await migrated.streamChunks.get('stream-1:0')
    expect(chunk).toBeUndefined()
    expect(
      JSON.stringify({ failed: await migrated.messages.get('failed'), body, chunk }),
    ).not.toContain('raw-secret')

    await migrated.messages.update('done', { 'generation.integrity': 'failed' } as never)
    migrated.close()
    const reopened = createDbForTests(name)
    await reopened.open()
    expect((await reopened.messages.get('done'))?.generation?.integrity).toBe('failed')
    await reopened.delete()
  })

  it('moves released-v20 header continuation attempts into message bodies exactly once', async () => {
    const name = `natter-test-v20-continuation-attempt-body-split-${Math.random()
      .toString(36)
      .slice(2)}`
    await Dexie.delete(name)

    const legacy = new Dexie(name)
    registerLegacyStreamLeasesV20(legacy)
    await legacy.open()
    await legacy.table<Record<string, unknown>>('messages').put({
      id: 'continued-message',
      chatId: 'chat-1',
      nodeVersion: 4,
      continuationAttempts: [
        {
          streamId: 'shared-stream',
          strategy: 'prompt',
          status: 'error',
          requestedModel: 'header-requested-model',
          provider: 'header-provider',
          startedAt: 1,
          finishedAt: 2,
          error: {
            code: 'NETWORK',
            message: 'Bearer sk-header-private',
            raw: { kind: 'network', metadata: { prompt: 'raw-header-secret' } },
          },
        },
        {
          streamId: 'header-only-stream',
          strategy: 'prompt',
          status: 'error',
          startedAt: 3,
          finishedAt: 4,
          error: {
            code: 502,
            message: 'Bearer sk-header-only-private',
            raw: { kind: 'provider_error', metadata: { output: 'raw-header-only-secret' } },
          },
        },
      ],
    })
    await legacy.table<Record<string, unknown>>('messageBodies').put({
      id: 'continued-message',
      chatId: 'chat-1',
      nodeVersion: 4,
      updatedAt: 5,
      content: [],
      continuationAttempts: [
        {
          streamId: 'shared-stream',
          strategy: 'prefill',
          status: 'error',
          model: 'body-model',
          startedAt: 10,
          finishedAt: 20,
        },
        {
          streamId: 'body-only-stream',
          strategy: 'prompt',
          status: 'done',
          startedAt: 30,
          finishedAt: 40,
        },
      ],
    })
    legacy.close()

    const migrated = createDbForTests(name)
    await migrated.open()
    expect(migrated.verno).toBe(CURRENT_DB_VERSION)
    const migratedHeader = (await migrated.messages.get('continued-message')) as unknown as Record<
      string,
      unknown
    >
    expect(migratedHeader).not.toHaveProperty('continuationAttempts')
    const migratedBody = await migrated.messageBodies.get('continued-message')
    expect(migratedBody?.continuationAttempts?.map((attempt) => attempt.streamId)).toEqual([
      'shared-stream',
      'body-only-stream',
      'header-only-stream',
    ])
    expect(migratedBody?.continuationAttempts?.[0]).toMatchObject({
      streamId: 'shared-stream',
      strategy: 'prefill',
      status: 'error',
      integrity: 'clean',
      requestedModel: 'header-requested-model',
      model: 'body-model',
      provider: 'header-provider',
      startedAt: 10,
      finishedAt: 20,
      error: {
        category: 'network',
        code: 'NETWORK',
        message: 'Bearer <redacted>',
      },
    })
    expect(migratedBody?.continuationAttempts?.[1]).toMatchObject({
      streamId: 'body-only-stream',
      integrity: 'clean',
    })
    expect(migratedBody?.continuationAttempts?.[2]).toMatchObject({
      streamId: 'header-only-stream',
      integrity: 'clean',
      error: {
        category: 'provider',
        code: '502',
        message: 'Bearer <redacted>',
      },
    })
    expect(JSON.stringify(migratedBody)).not.toContain('raw-header')

    const manuallyEditedAttempts = [
      {
        ...(migratedBody?.continuationAttempts?.[0] ?? {
          streamId: 'shared-stream',
          strategy: 'prefill' as const,
          status: 'error' as const,
          startedAt: 10,
          finishedAt: 20,
          reasoningCarryForward: 'none' as const,
          reasoningVisibility: { disclosure: 'unknown' as const },
          application: { kind: 'applied' as const },
        }),
        model: 'manual-model',
      },
    ]
    await migrated.messageBodies.update('continued-message', {
      continuationAttempts: manuallyEditedAttempts,
    })
    const manuallyRestoredHeaderAttempts = [
      {
        streamId: 'manual-header-stream',
        strategy: 'prompt',
        status: 'done',
        startedAt: 50,
        finishedAt: 60,
      },
    ]
    await migrated.messages.update('continued-message', {
      continuationAttempts: manuallyRestoredHeaderAttempts,
    } as never)
    migrated.close()

    const reopened = createDbForTests(name)
    await reopened.open()
    expect((await reopened.messageBodies.get('continued-message'))?.continuationAttempts).toEqual(
      manuallyEditedAttempts,
    )
    expect(
      (await reopened.messages.get('continued-message')) as unknown as Record<string, unknown>,
    ).toHaveProperty('continuationAttempts', manuallyRestoredHeaderAttempts)
    await reopened.delete()
  })

  it('populates a fresh current database without requiring a legacy lease pass', async () => {
    const name = `natter-test-stream-lease-v21-fresh-${Math.random().toString(36).slice(2)}`
    const db = await freshDb(name)
    await db.open()

    expect(db.verno).toBe(CURRENT_DB_VERSION)
    expect(await db.streamLeases.count()).toBe(0)
    expect((await db.settings.get('backfill:message-body-split-v1'))?.value).toBe(1)
    const lease: StreamLeaseRow = testContinuationLease({
      streamId: 'continue-stream',
      chatId: 'chat-1',
      messageId: 'message-1',
      ownerClientId: 'tab-1',
      fenceToken: 'current-fence',
      replacementEpoch: 0,
      startedAt: 1,
      heartbeatAt: 2,
      admissionSequence: 1,
      revision: 0,
      continuationStrategy: 'prefill',
      baseNodeVersion: 3,
      baseBodyVersion: 3,
      requestedModel: 'model-a',
      apiUsed: 'responses',
      postCommit: { usedAt: 1, profileId: 'profile-a' },
    })
    await db.streamLeases.put(lease)
    expect(await db.streamLeases.get(lease.streamId)).toEqual(lease)
    await db.delete()
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

  it('seeds render-window defaults during schema upgrade', async () => {
    const name = `natter-test-render-window-mig-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)

    const legacy = new Dexie(name)
    registerLegacyChatSettingsV14(legacy)
    await legacy.open()
    await legacy
      .table<MinimalSetting>('settings')
      .put({ key: 'global:message-render-window-size', value: 33 })
    legacy.close()

    const migrated = createDbForTests(name)
    await migrated.open()
    expect(migrated.verno).toBe(CURRENT_DB_VERSION)
    expect((await migrated.settings.get('global:message-render-window-size'))?.value).toBe(33)
    expect((await migrated.settings.get('global:sidebar-render-window-size'))?.value).toBe(50)
    expect((await migrated.settings.get('global:message-render-window-load-mode'))?.value).toBe(
      'auto',
    )
    expect((await migrated.settings.get('global:sidebar-render-window-load-mode'))?.value).toBe(
      'auto',
    )
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
      structuralVersion: 0,
      settings: structuredClone(baseSettings),
      lastUpdatedLeafId: null,
      lastBranchUpdatedAt: 1,
      archived: false,
      pinned: false,
      folderId: null,
      tags: [],
    })
    await v3.table<Record<string, unknown>>('presets').put({
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
        structuralVersion: 0,
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
        structuralVersion: 0,
        settings: structuredClone(directSettings),
        lastUpdatedLeafId: null,
        lastBranchUpdatedAt: 1,
        archived: false,
        pinned: false,
        folderId: null,
        tags: [],
      },
    ])
    await legacy.table<Record<string, unknown>>('presets').bulkPut([
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
      structuralVersion: 0,
      settings: structuredClone(legacySettings),
      lastUpdatedLeafId: null,
      lastBranchUpdatedAt: 1,
      archived: false,
      pinned: false,
      folderId: null,
      tags: [],
    })
    await legacy.table<Record<string, unknown>>('presets').put({
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
      structuralVersion: 0,
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
    await legacy.table<Record<string, unknown>>('presets').put({
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
    expect(migrated.verno).toBe(CURRENT_DB_VERSION)
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

  it('migrates provider API modes from connection profiles into chat and preset settings', async () => {
    const name = `natter-test-provider-api-mode-mig-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)
    const directSettings = cloneDefaultChatSettings()
    directSettings.profileId = 'profile-openai'
    directSettings.model = 'gpt-4o'
    directSettings.api = 'auto'
    directSettings.responses = { includeEncrypted: false, store: false } as unknown as NonNullable<
      Chat['settings']['responses']
    >
    const googleSettings = cloneDefaultChatSettings()
    googleSettings.profileId = 'profile-google'
    googleSettings.model = 'google/gemini-3.1-flash-lite-preview'
    googleSettings.api = 'auto'
    googleSettings.gemini = {
      allowImportedWithoutSignature: false,
    } as unknown as NonNullable<Chat['settings']['gemini']>
    const anthropicSettings = cloneDefaultChatSettings()
    anthropicSettings.profileId = 'profile-anthropic'
    anthropicSettings.model = 'claude-haiku-4.5'
    anthropicSettings.api = 'auto'

    const legacy = new Dexie(name)
    registerLegacyChatSettingsV14(legacy)
    await legacy.open()
    await legacy.table('profiles').bulkPut([
      {
        id: 'profile-openai',
        name: 'OpenAI',
        kind: 'openai-compatible',
        baseUrl: 'https://api.openai.com/v1',
        apiKeyRef: 'K1',
        defaultHeaders: {},
        appTitle: 'Natter',
        appUrl: '',
        usesResponsesApiByDefault: true,
        responsesDefaults: { store: true, includeEncrypted: false },
        supportsEndpointsApi: false,
        supportsGenerationApi: false,
        supportsPrivacyScrape: false,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'profile-google',
        name: 'Google',
        kind: 'google',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        apiKeyRef: 'K2',
        defaultHeaders: {},
        appTitle: 'Natter',
        appUrl: '',
        geminiMode: 'openai-compat',
        geminiDefaults: { allowImportedWithoutSignature: false },
        supportsEndpointsApi: false,
        supportsGenerationApi: false,
        supportsPrivacyScrape: false,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'profile-anthropic',
        name: 'Anthropic',
        kind: 'anthropic',
        baseUrl: 'https://api.anthropic.com/v1',
        apiKeyRef: 'K3',
        defaultHeaders: {},
        appTitle: 'Natter',
        appUrl: '',
        supportsEndpointsApi: false,
        supportsGenerationApi: false,
        supportsPrivacyScrape: false,
        createdAt: 1,
        updatedAt: 1,
      },
    ])
    const chatBase = {
      title: '',
      titleStatus: 'untitled' as const,
      createdAt: 1,
      updatedAt: 1,
      lastViewedAt: 1,
      wordCount: 0,
      totalCostUsd: 0,
      metaVersion: 0,
      summaryVersion: 0,
      structuralVersion: 0,
      lastUpdatedLeafId: null,
      lastBranchUpdatedAt: 1,
      archived: false,
      pinned: false,
      folderId: null,
      tags: [],
    }
    await legacy.table<Chat>('chats').bulkPut([
      { ...chatBase, id: 'chat-openai', settings: directSettings },
      { ...chatBase, id: 'chat-google', settings: googleSettings },
      { ...chatBase, id: 'chat-anthropic', settings: anthropicSettings },
    ])
    await legacy.table<Record<string, unknown>>('presets').put({
      id: 'preset-openai',
      name: 'OpenAI preset',
      connectionProfileId: 'profile-openai',
      settings: { ...directSettings, profileId: 'stale-profile' },
      createdAt: 1,
      updatedAt: 1,
    })
    legacy.close()

    const migrated = createDbForTests(name)
    await migrated.open()
    expect(migrated.verno).toBe(CURRENT_DB_VERSION)
    const openaiChat = await migrated.chats.get('chat-openai')
    const googleChat = await migrated.chats.get('chat-google')
    const anthropicChat = await migrated.chats.get('chat-anthropic')
    const openaiPreset = await migrated.presets.get('preset-openai')
    expect(openaiChat?.settings.api).toBe('responses')
    expect(openaiChat?.settings.responses).toEqual({ store: true })
    expect(
      'includeEncrypted' in ((openaiChat?.settings.responses ?? {}) as Record<string, unknown>),
    ).toBe(false)
    expect(googleChat?.settings.api).toBe('chat')
    expect(googleChat?.settings.gemini).toBeUndefined()
    expect(anthropicChat?.settings.api).toBe('anthropic-messages')
    expect(openaiPreset?.settings.profileId).toBe('profile-openai')
    expect(openaiPreset?.settings.api).toBe('responses')
    expect(openaiPreset?.settings.responses).toEqual({ store: true })
    for (const profile of await migrated.profiles.toArray()) {
      const row = profile as unknown as Record<string, unknown>
      expect(row.usesResponsesApiByDefault).toBeUndefined()
      expect(row.geminiMode).toBeUndefined()
      expect(row.responsesDefaults).toBeUndefined()
      expect(row.geminiDefaults).toBeUndefined()
    }
    await migrated.delete()
  })

  it('migrates chat preset picker order into typed order blocks and removes legacy ranks', async () => {
    const name = `natter-test-preset-sort-index-mig-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)
    const settings = cloneDefaultChatSettings()
    settings.profileId = 'profile-openai'
    settings.model = 'gpt-4o'

    const legacy = new Dexie(name)
    registerLegacyChatSettingsV14(legacy)
    await legacy.open()
    await legacy.table<Record<string, unknown>>('presets').bulkPut([
      {
        id: 'preset-second',
        name: 'Second',
        connectionProfileId: 'profile-openai',
        settings,
        createdAt: 20,
        updatedAt: 20,
      },
      {
        id: 'preset-first',
        name: 'First',
        connectionProfileId: 'profile-openai',
        settings,
        createdAt: 10,
        updatedAt: 10,
      },
    ])
    legacy.close()

    const migrated = createDbForTests(name)
    await migrated.open()
    expect(migrated.verno).toBe(CURRENT_DB_VERSION)
    const orderedIds = await migrated.transaction(
      'r',
      migrated.presetOrderState,
      migrated.presetOrderBlocks,
      (tx) => readPresetOrderIds(tx),
    )
    expect(orderedIds).toEqual(['preset-first', 'preset-second'])
    const rows = await migrated.presets.toArray()
    expect(rows.map((row) => row.id).sort()).toEqual(['preset-first', 'preset-second'])
    expect(
      rows.every((row) => {
        const stored = row as unknown as Record<string, unknown>
        return !('sortIndex' in stored) && !('migrationV19SortValue' in stored)
      }),
    ).toBe(true)
    expect(migrated.presets.schema.indexes.map((index) => index.src)).not.toContain(
      '[migrationV19SortValue+createdAt+id]',
    )
    await migrated.delete()
  })

  it('adds the single-newline rendering preference during schema upgrade', async () => {
    const name = `natter-test-rendering-prefs-mig-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)

    const legacy = new Dexie(name)
    registerLegacyChatSettingsV14(legacy)
    await legacy.open()
    await legacy.table<MinimalSetting>('settings').put({
      key: 'rendering-preferences',
      value: {
        shikiLight: 'tokyo-night',
        shikiDark: 'dracula',
        singleDollarTextMath: true,
      },
    })
    legacy.close()

    const migrated = createDbForTests(name)
    await migrated.open()
    expect(migrated.verno).toBe(CURRENT_DB_VERSION)
    expect((await migrated.settings.get('rendering-preferences'))?.value).toEqual({
      shikiLight: 'tokyo-night',
      shikiDark: 'dracula',
      singleDollarTextMath: true,
      singleNewlineHardBreaks: false,
    })
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
      structuralVersion: 0,
      settings: cloneDefaultChatSettings(),
      lastUpdatedLeafId: 'a1',
      lastBranchUpdatedAt: 1,
      archived: false,
      pinned: false,
      folderId: null,
      tags: [],
    })
    await legacy.table<Record<string, unknown>>('messages').put({
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
        reasoningCarryForward: 'none',
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
    const message: Message = {
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
        reasoningCarryForward: 'none',
        reasoningVisibility: { disclosure: 'unknown' },
        startedAt: 1,
        finishedAt: 2,
        serverTools: [
          {
            type: 'code_interpreter_call',
            source: 'responses-output',
            id: 'ci_1',
            status: 'completed',
            outputIndex: 0,
          },
        ],
      },
      nodeVersion: 0,
      deleted: false,
    }
    const { header, body, preview } = splitMessageForStorage(message)
    delete body.providerOutputItems
    const legacyHeader = structuredClone(header) as unknown as Record<string, unknown>
    const legacyGeneration = legacyHeader.generation as Record<string, unknown>
    const legacyServerTools = legacyGeneration.serverTools as Record<string, unknown>[]
    const legacyServerTool = legacyServerTools[0]
    if (!legacyServerTool) throw new Error('ExpectedLegacyProviderOutputTool')
    legacyServerTool.output = {
      id: 'ci_1',
      type: 'code_interpreter_call',
      status: 'completed',
      code: 'sum(i*i for i in range(6))',
      outputs: [{ type: 'logs', logs: '55' }],
    }
    await db.table<Record<string, unknown>>('messages').put(legacyHeader)
    await db.messageBodies.put(body)
    await db.messagePreviews.put(preview)
    const providerOutputMarker = providerOutputItemsBackfillMarker()
    await db.settings.put({ ...providerOutputMarker, value: 3 })

    await migrateProviderOutputItemRows(db)
    await migrateProviderOutputItemRows(db)

    expect(await db.settings.get(providerOutputMarker.key)).toEqual(providerOutputMarker)
    const [storedHeader, storedBody, storedPreview] = await Promise.all([
      db.messages.get('a1'),
      db.messageBodies.get('a1'),
      db.messagePreviews.get('a1'),
    ])
    expect(storedBody?.providerOutputItems).toEqual([
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
    expect(storedHeader?.bodyVersion).toBe(1)
    expect(storedBody?.bodyVersion).toBe(storedHeader?.bodyVersion)
    expect(storedPreview?.bodyVersion).toBe(storedHeader?.bodyVersion)
    expect(storedPreview?.text).toBe('55')
    await db.delete()
  })

  it('canonicalizes token calibration keys once on an already-current schema', async () => {
    const name = `natter-test-token-calibration-backfill-${Math.random().toString(36).slice(2)}`
    const db = await freshDb(name)
    await db.open()
    const fableKey = tokenCalibrationKey('anthropic/claude-fable-5')
    await db.chats.put({
      id: 'chat-calib',
      title: 'Calib',
      titleStatus: 'untitled',
      createdAt: 1,
      updatedAt: 1,
      lastViewedAt: 1,
      wordCount: 0,
      totalCostUsd: 0,
      metaVersion: 0,
      summaryVersion: 0,
      structuralVersion: 0,
      settings: cloneDefaultChatSettings(),
      lastUpdatedLeafId: 'm1',
      lastBranchUpdatedAt: 1,
      archived: false,
      pinned: false,
      folderId: null,
      tags: [],
      tokenCalibration: {
        'anthropic:claude-fable-5': {
          totalTextChars: 300,
          totalTextTokens: 100,
          sampleCount: 1,
          lastRatio: 3,
          updatedAt: 10,
        },
        'anthropic:anthropic:anthropic:claude-fable-5': {
          totalTextChars: 600,
          totalTextTokens: 200,
          sampleCount: 2,
          lastRatio: 3,
          updatedAt: 20,
        },
      },
    })
    const message = {
      id: 'm1',
      chatId: 'chat-calib',
      parentId: null,
      siblingIndex: 0,
      turnId: 'turn-m1',
      turnIndex: 0,
      createdAt: 1,
      role: 'user',
      origin: 'user',
      content: [{ type: 'text', text: 'hello' }],
      nodeVersion: 0,
      deleted: false,
      originalCalibrationKey: 'anthropic:anthropic:claude-fable-5',
    } as Message
    const { header, body } = splitMessageForStorage(message)
    await db.messages.put(header)
    await db.messageBodies.put(body)
    await db.settings.put({
      key: 'global:token-calibration',
      value: {
        version: 1,
        updatedAt: 20,
        byModel: {
          'anthropic:anthropic:claude-fable-5': {
            totalTextChars: 900,
            totalTextTokens: 300,
            sampleCount: 3,
            lastRatio: 3,
            updatedAt: 20,
          },
        },
      } satisfies GlobalTokenCalibration,
    })
    await db.settings.delete('backfill:token-calibration-canonicalize-v1')

    await canonicalizeTokenCalibrationRows(db)
    await canonicalizeTokenCalibrationRows(db)

    const chat = await db.chats.get('chat-calib')
    expect(chat?.tokenCalibration).toEqual({
      [fableKey]: {
        totalTextChars: 900,
        totalTextTokens: 300,
        sampleCount: 3,
        lastRatio: 3,
        updatedAt: 20,
      },
    })
    expect((await db.messages.get('m1'))?.originalCalibrationKey).toBe(fableKey)
    const global = (await db.settings.get('global:token-calibration'))
      ?.value as GlobalTokenCalibration
    expect(global.byModel[fableKey]).toMatchObject({
      totalTextChars: 900,
      totalTextTokens: 300,
      sampleCount: 3,
      lastRatio: 3,
      updatedAt: 20,
    })
    expect((await db.settings.get('backfill:token-calibration-canonicalize-v1'))?.value).toBe(1)
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
      structuralVersion: 0,
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
      processing: [],
      refCount: 2,
    })
    expect(attachment).toHaveProperty('artifactIds', [])
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

    await runWaveADerivedRowsForTest(db)
    await runWaveADerivedRowsForTest(db)

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
    })
    expect(branchy?.totalCostUsd).toBeCloseTo(0.6)
    expect(await db.chats.get('tombstoned-descendants')).toMatchObject({
      lastUpdatedLeafId: 'tomb-root',
      wordCount: 2,
      totalCostUsd: 0.4,
    })
    expect((await db.settings.get('backfill:organization-fields-v1'))?.value).toBe(1)
    expect(db.tables.map((table) => table.name)).not.toContain('chatBranchCache')
    await db.delete()
  })

  it('backfills organization fields on an empty DB and a 1000-chat DB', async () => {
    const emptyName = `natter-test-org-empty-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(emptyName)
    const empty = await freshDb(emptyName)
    await empty.open()
    await runWaveADerivedRowsForTest(empty)
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

    expect(await db.chatSidebarRows.count()).toBe(0)
    expect(await db.chatSidebarAggregates.toArray()).toEqual([emptyChatSidebarAggregateRow()])
    await runWaveADerivedRowsForTest(db)

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
    expect(db.tables.map((table) => table.name)).not.toContain('chatBranchCache')
    expect((await db.settings.get('backfill:organization-fields-v1'))?.value).toBe(1)
    const chats = (await db.chats.toArray()).sort((left, right) => left.id.localeCompare(right.id))
    expect(
      (await db.chatSidebarRows.toArray()).sort((left, right) => left.id.localeCompare(right.id)),
    ).toEqual(chats.map(chatSidebarProjectionRow))
    expect(await db.chatSidebarAggregates.toArray()).toEqual([
      {
        ...emptyChatSidebarAggregateRow(),
        totalCount: 1000,
        activeCount: 666,
        archivedCount: 334,
        pinnedCount: 200,
        rootCount: 1000,
      },
    ])

    const stableChats = await db.chats.toArray()
    const stableRows = await db.chatSidebarRows.toArray()
    const stableAggregates = await db.chatSidebarAggregates.toArray()
    await runWaveADerivedRowsForTest(db)
    expect(await db.chats.toArray()).toEqual(stableChats)
    expect(await db.chatSidebarRows.toArray()).toEqual(stableRows)
    expect(await db.chatSidebarAggregates.toArray()).toEqual(stableAggregates)
    await db.delete()
  }, 15_000)

  it('upgrades observed v88 journals and reasoning bodies atomically through v94 and does not rerun', async () => {
    const name = `natter-test-v89-reasoning-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)

    const legacy = await openObservedWaveAFixture(name, 88)

    const profile: ConnectionProfile = {
      id: 'google-profile',
      name: 'Google',
      kind: 'google',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      defaultHeaders: {},
      appTitle: 'Natter',
      appUrl: '',
      supportsEndpointsApi: false,
      supportsGenerationApi: false,
      supportsPrivacyScrape: false,
      createdAt: 1,
      updatedAt: 1,
    }
    const stored = splitMessageForStorage(
      {
        id: 'assistant-1',
        chatId: 'chat-1',
        parentId: null,
        siblingIndex: 0,
        turnId: 'turn-1',
        turnIndex: 0,
        createdAt: 2,
        role: 'assistant',
        origin: 'generated',
        generation: {
          model: 'anthropic/claude-sonnet-4.6',
          requestedModel: 'anthropic/claude-sonnet-4.6',
          apiUsed: 'anthropic-messages',
          startedAt: 2,
          status: 'done',
          reasoningCarryForward: 'none',
          reasoningVisibility: { disclosure: 'unknown' },
        },
        content: [{ type: 'output_text', text: 'stored answer' }],
        nodeVersion: 2,
        deleted: false,
      },
      { bodyVersion: 2 },
    )
    const legacyBody = {
      ...stored.body,
      reasoningEnvelope: {
        schemaVersion: 1,
        visible: [
          {
            id: 'stored-gemini-summary',
            groupId: 'stored-gemini-group',
            kind: 'summary',
            text: 'stored Gemini summary',
            format: 'google-gemini-v1',
            source: {
              dialect: 'gemini-native',
              itemId: 'stored-gemini-thought',
              candidateIndex: 0,
              summaryIndex: 0,
              partIndex: 0,
              detailId: 'stored-gemini-summary-detail',
            },
          },
        ],
        carriers: [
          {
            id: 'stored-gemini-carrier',
            groupId: 'stored-gemini-group',
            kind: 'gemini-thought-signature',
            data: 'stored-gemini-signature',
            format: 'google-gemini-v1',
            bindsVisiblePartId: 'stored-gemini-summary',
            source: {
              dialect: 'gemini-native',
              itemId: 'stored-gemini-thought',
              candidateIndex: 0,
              partIndex: 1,
              detailId: 'stored-gemini-carrier-detail',
            },
          },
        ],
      },
      reasoningDetails: [
        {
          type: 'reasoning.text',
          format: 'anthropic-claude-v1',
          text: 'stored thought',
          signature: 'stored-signature',
          id: 'stored-thought-0',
          index: 0,
        },
      ],
    }

    const leaseIdentity = {
      streamId: 'gemini-stream',
      chatId: 'chat-1',
      messageId: 'assistant-1',
      ownerClientId: 'tab-a',
      fenceToken: 'fence-a',
      replacementEpoch: 3,
      admissionSequence: 7,
    } as const
    const frames = await encodeTestStreamJournalEntries({
      ...leaseIdentity,
      fence: {
        ownerClientId: leaseIdentity.ownerClientId,
        fenceToken: leaseIdentity.fenceToken,
        replacementEpoch: leaseIdentity.replacementEpoch,
        admissionSequence: leaseIdentity.admissionSequence,
      },
      entries: [
        { createdAt: 10, event: { lane: 'text', text: 'live answer' } },
        {
          createdAt: 11,
          event: {
            lane: 'reasoning',
            detailsMode: 'snapshot',
            details: [
              {
                type: 'reasoning.summary',
                format: 'google-gemini-v1',
                summary: 'live summary',
                id: 'summary-0',
                providerItemId: 'thought-0',
                providerOutputIndex: 0,
                providerSummaryIndex: 0,
              },
              {
                type: 'reasoning.encrypted',
                format: 'google-gemini-v1',
                data: 'live-thought-signature',
                id: 'carrier-0',
                providerItemId: 'thought-0',
                providerOutputIndex: 0,
              },
            ],
          },
        },
        { createdAt: 12, event: { lane: 'finish', finishReason: 'stop' } },
      ],
    })
    const currentLease = testContinuationLease({
      ...leaseIdentity,
      startedAt: 9,
      heartbeatAt: 12,
      revision: 2,
      journalMaxSeq: lastJournalSeq(frames),
      journalStorageBytes: streamFrameStorageBytes(frames),
      continuationStrategy: 'prefill',
      baseNodeVersion: 2,
      baseBodyVersion: 2,
      requestedModel: 'google/gemini-3.5-flash',
      apiUsed: 'gemini-native',
      postCommit: { usedAt: 9, profileId: profile.id },
    })
    const legacyLease = leaseWithoutJournalVersion(currentLease)

    await legacy.table('profiles').put(profile)
    await legacy.table('chats').put({
      ...buildChat({ id: 'chat-1', title: 'Reasoning migration', now: 1 }),
      settings: { ...cloneDefaultChatSettings(), profileId: profile.id },
      lastUpdatedLeafId: stored.header.id,
    })
    await legacy.table('messages').put(messageHeaderWithoutReasoningCarryForward(stored.header))
    await legacy.table('messageBodies').put(legacyBody)
    await legacy.table('messagePreviews').put(stored.preview)
    await legacy.table('streamChunks').bulkPut(frames)
    await legacy.table('streamLeases').put(legacyLease)
    legacy.close()

    const migrated = await openProductionV94Fixture(name)
    expect(migrated.verno).toBe(CURRENT_DB_VERSION)

    const entries = await currentJournalEvents(migrated, leaseIdentity.streamId)
    const replayed = replayStreamAccumulator({ initialContent: [], now: 9, entries })
    expect(replayed.finishedCleanly, JSON.stringify(entries.map(({ event }) => event))).toBe(true)
    expect(replayed.final.content).toEqual([{ type: 'output_text', text: 'live answer' }])
    expect(replayed.final.reasoningEnvelope).toEqual(
      expect.objectContaining({
        schemaVersion: 2,
        visible: [expect.objectContaining({ kind: 'summary', text: 'live summary' })],
        carriers: [
          expect.objectContaining({
            kind: 'gemini-thought-signature',
            data: 'live-thought-signature',
          }),
        ],
      }),
    )
    expect(isReasoningEnvelope(replayed.final.reasoningEnvelope)).toBe(true)

    const migratedHeader = await migrated.messages.get(stored.header.id)
    const migratedBody = await migrated.messageBodies.get(stored.body.id)
    const migratedPreview = await migrated.messagePreviews.get(stored.preview.id)
    const migratedLease = await migrated.streamLeases.get(leaseIdentity.streamId)
    expect(migratedHeader).toMatchObject({
      nodeVersion: 2,
      bodyVersion: 2,
      requestContextVersion: 2,
      generation: { reasoningCarryForward: 'unknown' },
    })
    expect(migratedBody).toMatchObject({ bodyVersion: 2 })
    expect(migratedPreview).toMatchObject({ bodyVersion: 2 })
    const migratedEnvelope = migratedBody?.reasoningEnvelope
    expect(isReasoningEnvelope(migratedEnvelope)).toBe(true)
    if (!isReasoningEnvelope(migratedEnvelope)) throw new Error('ExpectedReasoningEnvelope')
    expect(
      migratedEnvelope.visible.some(
        (part) => part.kind === 'summary' && part.text === 'stored Gemini summary',
      ),
    ).toBe(true)
    expect(
      migratedEnvelope.visible.some(
        (part) => part.kind === 'text' && part.text === 'stored thought',
      ),
    ).toBe(true)
    expect(
      migratedEnvelope.carriers.some(
        (carrier) =>
          carrier.kind === 'gemini-thought-signature' &&
          carrier.data === 'stored-gemini-signature' &&
          carrier.bindsVisiblePartId === 'stored-gemini-summary',
      ),
    ).toBe(true)
    expect(
      migratedEnvelope.carriers.some(
        (carrier) =>
          carrier.kind === 'anthropic-signature' && carrier.signature === 'stored-signature',
      ),
    ).toBe(true)
    expect(migratedBody).not.toHaveProperty('reasoningDetails')
    const migratedFrames = await migrated.streamChunks
      .where('streamId')
      .equals(leaseIdentity.streamId)
      .sortBy('seq')
    expect(migratedLease).toMatchObject({
      journalEventVersion: 2,
      dispatch: {
        baseNodeVersion: 2,
        baseBodyVersion: 2,
        reasoningCarryForward: 'unknown',
      },
      journalMaxSeq: migratedFrames.at(-1)?.seq,
    })
    expect(migratedLease?.journalStorageBytes).toBe(streamFrameStorageBytes(migratedFrames))
    const firstSnapshot = structuredClone({
      header: migratedHeader,
      body: migratedBody,
      preview: migratedPreview,
      lease: migratedLease,
      frames: migratedFrames,
    })

    migrated.close()
    const reopened = await openProductionV94Fixture(name)
    expect({
      header: await reopened.messages.get(stored.header.id),
      body: await reopened.messageBodies.get(stored.body.id),
      preview: await reopened.messagePreviews.get(stored.preview.id),
      lease: await reopened.streamLeases.get(leaseIdentity.streamId),
      frames: await reopened.streamChunks
        .where('streamId')
        .equals(leaseIdentity.streamId)
        .sortBy('seq'),
    }).toEqual(firstSnapshot)
    await reopened.delete()
  })

  it('converges every v88 lease phase and preserves only valid journal prefixes', async () => {
    const name = `natter-test-v89-journal-phases-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)
    const legacy = await openObservedWaveAFixture(name, 88)

    async function framesFor(streamId: string, events: readonly unknown[]) {
      return encodeTestStreamJournalEntries({
        streamId,
        chatId: 'chat-1',
        messageId: `message:${streamId}`,
        fence: {
          ownerClientId: 'tab-a',
          fenceToken: `fence:${streamId}`,
          replacementEpoch: 0,
          admissionSequence: 1,
        },
        entries: events.map((event, index) => ({ createdAt: index + 1, event })),
      })
    }

    const terminalFrames = await framesFor('terminal-cutoff', [
      { lane: 'text', text: 'kept' },
      { lane: 'text', text: 'must be cut' },
      { lane: 'finish', finishReason: 'stop' },
    ])
    const terminalCutoff = terminalFrames[0]?.seq ?? -1
    const terminalLease = testGenerationLease({
      phase: 'terminal-decided',
      streamId: 'terminal-cutoff',
      chatId: 'chat-1',
      messageId: 'message:terminal-cutoff',
      ownerClientId: 'tab-a',
      fenceToken: 'fence:terminal-cutoff',
      journalMaxSeq: terminalCutoff,
      journalStorageBytes: streamFrameStorageBytes(terminalFrames.slice(0, 1)),
      terminal: {
        version: 1,
        finishedAt: 4,
        journalMaxSeq: terminalCutoff,
        journalCompleteness: 'settled',
        decision: { outcome: 'done' },
      },
    })

    const canonicalFrames = await framesFor('canonical', [{ lane: 'text', text: 'obsolete' }])
    const canonicalLease = {
      ...testGenerationLease({
        phase: 'canonical',
        streamId: 'canonical',
        chatId: 'chat-1',
        messageId: 'message:canonical',
        ownerClientId: 'tab-a',
        fenceToken: 'fence:canonical',
        journalMaxSeq: lastJournalSeq(canonicalFrames),
        journalStorageBytes: streamFrameStorageBytes(canonicalFrames),
      }),
      targetOwnerKey: 'message:canonical',
    }
    const metadataFrames = await framesFor('metadata', [{ lane: 'text', text: 'obsolete' }])
    const metadataLease = testGenerationLease({
      phase: 'metadata-committed',
      streamId: 'metadata',
      chatId: 'chat-1',
      messageId: 'message:metadata',
      ownerClientId: 'tab-a',
      fenceToken: 'fence:metadata',
      journalMaxSeq: lastJournalSeq(metadataFrames),
      journalStorageBytes: streamFrameStorageBytes(metadataFrames),
    })

    const gapFrames = await framesFor('gap', [
      { lane: 'text', text: 'valid prefix' },
      { lane: 'text', text: 'missing middle' },
      { lane: 'text', text: 'unreachable tail' },
    ])
    const gapLease = testGenerationLease({
      streamId: 'gap',
      chatId: 'chat-1',
      messageId: 'message:gap',
      ownerClientId: 'tab-a',
      fenceToken: 'fence:gap',
      journalMaxSeq: lastJournalSeq(gapFrames),
      journalStorageBytes: streamFrameStorageBytes(gapFrames),
    })

    const malformedFrames = await framesFor('malformed-tail', [
      { lane: 'text', text: 'valid prefix' },
      { lane: 'text', text: 'will lose its required field' },
    ])
    expect(malformedFrames.every((frame) => frame.frameKind === 'inline')).toBe(true)
    const malformedRows = malformedFrames.map((frame, index) =>
      index === 1 ? { ...frame, event: { lane: 'text' } } : frame,
    )
    const malformedLease = testGenerationLease({
      streamId: 'malformed-tail',
      chatId: 'chat-1',
      messageId: 'message:malformed-tail',
      ownerClientId: 'tab-a',
      fenceToken: 'fence:malformed-tail',
      journalMaxSeq: lastJournalSeq(malformedFrames),
      journalStorageBytes: streamFrameStorageBytes(malformedFrames),
    })

    const badKeyFrames = await framesFor('bad-key', [{ lane: 'text', text: 'invalid key' }])
    const badKeyRows = badKeyFrames.map((frame) => ({ ...frame, id: '' }))
    const badKeyLease = testGenerationLease({
      streamId: 'bad-key',
      chatId: 'chat-1',
      messageId: 'message:bad-key',
      ownerClientId: 'tab-a',
      fenceToken: 'fence:bad-key',
      journalMaxSeq: lastJournalSeq(badKeyFrames),
      journalStorageBytes: streamFrameStorageBytes(badKeyFrames),
    })

    await seedLegacyGenerationTargets(
      legacy,
      ['terminal-cutoff', 'canonical', 'metadata', 'gap', 'malformed-tail', 'bad-key'],
      new Set(['canonical', 'metadata']),
    )

    await legacy
      .table('streamLeases')
      .bulkPut(
        [terminalLease, canonicalLease, metadataLease, gapLease, malformedLease, badKeyLease].map(
          (lease) => leaseWithoutJournalVersion(lease as unknown as StreamLeaseRow),
        ),
      )
    await legacy
      .table('streamChunks')
      .bulkPut([
        ...terminalFrames,
        ...canonicalFrames,
        ...metadataFrames,
        ...gapFrames.filter((frame) => frame.seq !== 1),
        ...malformedRows,
        ...badKeyRows,
      ])
    legacy.close()

    const migrated = await openProductionV94Fixture(name)

    const terminalEvents = await currentJournalEvents(migrated, 'terminal-cutoff')
    expect(terminalEvents.map(({ event }) => event)).toEqual([{ lane: 'text', text: 'kept' }])
    expect(await migrated.streamLeases.get('terminal-cutoff')).toMatchObject({
      journalEventVersion: 2,
      journalMaxSeq: 0,
      terminal: { journalMaxSeq: 0 },
    })

    expect(await migrated.streamChunks.where('streamId').equals('canonical').count()).toBe(0)
    expect(await migrated.streamLeases.get('canonical')).toEqual(
      expect.objectContaining({ journalEventVersion: 2, phase: 'canonical' }),
    )
    expect(await migrated.streamLeases.get('canonical')).not.toHaveProperty('journalMaxSeq')
    expect(await migrated.streamLeases.get('canonical')).not.toHaveProperty('journalStorageBytes')
    expect(await migrated.streamLeases.get('canonical')).not.toHaveProperty('targetOwnerKey')
    expect(await migrated.streamChunks.where('streamId').equals('metadata').count()).toBe(0)
    expect(await migrated.streamLeases.get('metadata')).toMatchObject({
      streamId: 'metadata',
      phase: 'metadata-committed',
      journalEventVersion: 2,
    })
    expect(await migrated.streamLeases.get('metadata')).not.toHaveProperty('journalMaxSeq')
    expect(await migrated.streamLeases.get('metadata')).not.toHaveProperty('journalStorageBytes')

    const gapEvents = await currentJournalEvents(migrated, 'gap')
    expect(gapEvents.map(({ event }) => event.lane)).toEqual(['text', 'integrity'])
    expect(gapEvents[0]?.event).toEqual({ lane: 'text', text: 'valid prefix' })
    expect(gapEvents[1]?.event).toMatchObject({
      lane: 'integrity',
      integrity: { category: 'malformed-event-shape', eventType: 'stream-journal-v89' },
    })

    const malformedEvents = await currentJournalEvents(migrated, 'malformed-tail')
    expect(malformedEvents.map(({ event }) => event.lane)).toEqual(['text', 'integrity'])
    expect(malformedEvents[0]?.event).toEqual({ lane: 'text', text: 'valid prefix' })
    const badKeyEvents = await currentJournalEvents(migrated, 'bad-key')
    expect(badKeyEvents).toHaveLength(1)
    expect(badKeyEvents[0]?.event).toEqual({ lane: 'text', text: 'invalid key' })

    const allRows = await migrated.streamChunks.toArray()
    expect(allRows.every((row) => row.id === streamJournalFrameId(row.streamId, row.seq))).toBe(
      true,
    )
    expect(allRows.every((row) => !row.streamId.startsWith('backcompat:v94:temporary:'))).toBe(true)
    for (const streamId of ['gap', 'malformed-tail', 'bad-key']) {
      const lease = await migrated.streamLeases.get(streamId)
      const rows = await migrated.streamChunks.where('streamId').equals(streamId).sortBy('seq')
      expect(lease).toMatchObject({
        journalEventVersion: 2,
        journalMaxSeq: rows.at(-1)?.seq,
        journalStorageBytes: streamFrameStorageBytes(rows),
      })
    }

    await migrated.delete()
  })

  it('migrates 49 reasoning bodies without advancing semantic versions or target leases', async () => {
    const name = `natter-test-v89-reasoning-pages-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)
    const legacy = await openObservedWaveAFixture(name, 88)

    const ids = Array.from({ length: 49 }, (_, index) => `assistant-${index}`)
    const storedRows = ids.map((id, index) =>
      splitMessageForStorage(
        {
          id,
          chatId: 'chat-1',
          parentId: index === 0 ? null : (ids[index - 1] ?? null),
          siblingIndex: 0,
          turnId: `turn-${index}`,
          turnIndex: 0,
          createdAt: index + 1,
          role: 'assistant',
          origin: 'generated',
          generation: {
            model: 'test/model',
            requestedModel: 'test/model',
            apiUsed: 'chat',
            startedAt: index + 1,
            finishedAt: index + 1,
            status: 'done',
            reasoningCarryForward: 'none',
            reasoningVisibility: { disclosure: 'unknown' },
          },
          content: [{ type: 'output_text', text: `answer ${index}` }],
          nodeVersion: 1,
          deleted: false,
        },
        { bodyVersion: 1 },
      ),
    )
    await legacy.table('chats').put({
      ...buildChat({ id: 'chat-1', title: 'Reasoning pages', now: 1 }),
      lastUpdatedLeafId: ids.at(-1) ?? null,
    })
    await legacy
      .table('messages')
      .bulkPut(storedRows.map(({ header }) => messageHeaderWithoutReasoningCarryForward(header)))
    await legacy.table('messagePreviews').bulkPut(storedRows.map(({ preview }) => preview))
    await legacy.table('messageBodies').bulkPut(
      storedRows.map(({ body }, index) => ({
        ...body,
        reasoningDetails: [
          {
            type: 'reasoning.text',
            format: 'unknown',
            text: `thought ${index}`,
            id: `thought-${index}`,
          },
        ],
      })),
    )
    await legacy.table('streamLeases').bulkPut(
      ids.map((messageId, index) =>
        leaseWithoutJournalVersion(
          testContinuationLease({
            streamId: `stream-${index}`,
            chatId: 'chat-1',
            messageId,
            ownerClientId: 'tab-a',
            fenceToken: `fence-${index}`,
            admissionSequence: index + 1,
            baseNodeVersion: 1,
            baseBodyVersion: 1,
          }),
        ),
      ),
    )
    legacy.close()

    const migrated = await prepareProductionV94Fixture(name)
    const whereSpy = vi.spyOn(migrated.Table.prototype, 'where')
    await migrated.open()
    const targetLeaseQueries = whereSpy.mock.calls.filter(
      ([index]) => typeof index === 'string' && index === 'targetOwnerKey',
    )
    whereSpy.mockRestore()

    expect(targetLeaseQueries).toHaveLength(0)
    const [headers, bodies, leases] = await Promise.all([
      migrated.messages.bulkGet(ids),
      migrated.messageBodies.bulkGet(ids),
      migrated.streamLeases.bulkGet(ids.map((_id, index) => `stream-${index}`)),
    ])
    for (let index = 0; index < ids.length; index += 1) {
      expect(headers[index]).toMatchObject({
        id: ids[index],
        nodeVersion: 1,
        bodyVersion: 1,
        requestContextVersion: 1,
        generation: { reasoningCarryForward: 'unknown' },
      })
      expect(bodies[index]).toMatchObject({ id: ids[index], bodyVersion: 1 })
      expect(isReasoningEnvelope(bodies[index]?.reasoningEnvelope)).toBe(true)
      expect(bodies[index]).not.toHaveProperty('reasoningDetails')
      expect(leases[index]).toMatchObject({
        journalEventVersion: 2,
        dispatch: {
          baseNodeVersion: 1,
          baseBodyVersion: 1,
          reasoningCarryForward: 'unknown',
        },
      })
    }
    await migrated.delete()
  })

  it('rolls back the whole v94 cutover and cleanly retries after a later upgrade fails', async () => {
    const name = `natter-test-v89-rollback-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)
    const legacy = await openObservedWaveAFixture(name, 88)
    const stored = splitMessageForStorage(
      {
        id: 'assistant-rollback',
        chatId: 'chat-1',
        parentId: null,
        siblingIndex: 0,
        turnId: 'turn-1',
        turnIndex: 0,
        createdAt: 1,
        role: 'assistant',
        origin: 'generated',
        generation: {
          model: 'anthropic/claude-sonnet-4.6',
          requestedModel: 'anthropic/claude-sonnet-4.6',
          apiUsed: 'anthropic-messages',
          startedAt: 1,
          status: 'done',
          reasoningCarryForward: 'none',
          reasoningVisibility: { disclosure: 'unknown' },
        },
        content: [{ type: 'output_text', text: 'answer' }],
        nodeVersion: 4,
        deleted: false,
      },
      { bodyVersion: 4 },
    )
    const legacyBody = {
      ...stored.body,
      reasoningDetails: [
        {
          type: 'reasoning.text',
          format: 'anthropic-claude-v1',
          text: 'rollback thought',
          signature: 'rollback signature',
        },
      ],
    }
    await legacy.table('messages').put(messageHeaderWithoutReasoningCarryForward(stored.header))
    await legacy.table('messageBodies').put(legacyBody)
    await legacy.table('messagePreviews').put(stored.preview)
    legacy.close()

    const attempted = await prepareProductionV94Fixture(name)
    attempted.version(CURRENT_DB_VERSION + 1).upgrade(() => {
      throw new Error('InjectedPostV94Failure')
    })
    await expect(attempted.open()).rejects.toThrow('InjectedPostV94Failure')
    attempted.close()

    const stillV88 = await openObservedWaveAFixture(name, 88)
    expect(stillV88.verno).toBe(88)
    expect(await stillV88.table('messages').get(stored.header.id)).toMatchObject({
      nodeVersion: 4,
      bodyVersion: 4,
    })
    expect(await stillV88.table('messageBodies').get(stored.body.id)).toMatchObject({
      bodyVersion: 4,
      reasoningDetails: legacyBody.reasoningDetails,
    })
    expect(await stillV88.table('messageBodies').get(stored.body.id)).not.toHaveProperty(
      'reasoningEnvelope',
    )
    stillV88.close()

    const retried = await openProductionV94Fixture(name)
    expect(retried.verno).toBe(CURRENT_DB_VERSION)
    expect(await retried.messages.get(stored.header.id)).toMatchObject({
      nodeVersion: 4,
      bodyVersion: 4,
      generation: { reasoningCarryForward: 'unknown' },
    })
    const body = await retried.messageBodies.get(stored.body.id)
    expect(body).toMatchObject({ bodyVersion: 4 })
    expect(body).not.toHaveProperty('reasoningDetails')
    expect(isReasoningEnvelope(body?.reasoningEnvelope)).toBe(true)
    await retried.delete()
  })

  it('migrates one semantic journal event larger than the 4 MiB output batch intact', async () => {
    const name = `natter-test-v89-large-event-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)
    const legacy = await openObservedWaveAFixture(name, 88)

    const streamId = 'large-event'
    const hugeText = `${'x'.repeat(4 * 1024 * 1024)}:exact-tail`
    const frames = await encodeTestStreamJournalEntries({
      streamId,
      chatId: 'chat-1',
      messageId: 'message:large-event',
      fence: {
        ownerClientId: 'tab-a',
        fenceToken: 'fence:large-event',
        replacementEpoch: 0,
        admissionSequence: 1,
      },
      entries: [{ createdAt: 1, event: { lane: 'text', text: hugeText } }],
    })
    const lease = testGenerationLease({
      streamId,
      chatId: 'chat-1',
      messageId: 'message:large-event',
      ownerClientId: 'tab-a',
      fenceToken: 'fence:large-event',
      journalMaxSeq: lastJournalSeq(frames),
      journalStorageBytes: streamFrameStorageBytes(frames),
    })
    await seedLegacyGenerationTargets(legacy, [streamId], new Set())
    await legacy.table('streamChunks').bulkPut(frames)
    await legacy.table('streamLeases').put(leaseWithoutJournalVersion(lease))
    legacy.close()

    const migrated = await openProductionV94Fixture(name)
    const events = await currentJournalEvents(migrated, streamId)
    expect(events).toHaveLength(1)
    expect(events[0]?.event.lane).toBe('text')
    if (events[0]?.event.lane !== 'text') throw new Error('ExpectedLargeTextEvent')
    expect(events[0].event.text.length).toBe(hugeText.length)
    expect(events[0].event.text).toBe(hugeText)
    const migratedFrames = await migrated.streamChunks
      .where('streamId')
      .equals(streamId)
      .sortBy('seq')
    expect(await migrated.streamLeases.get(streamId)).toMatchObject({
      journalEventVersion: 2,
      journalMaxSeq: migratedFrames.at(-1)?.seq,
      journalStorageBytes: streamFrameStorageBytes(migratedFrames),
    })
    await migrated.delete()
  }, 30_000)

  it('migrates 2,048 legacy reasoning bodies through one constant-memory cursor', async () => {
    const name = `natter-test-v89-body-stress-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)
    const legacy = await openObservedWaveAFixture(name, 88)

    const rowCount = 2_048
    const storedRows = Array.from({ length: rowCount }, (_, index) =>
      splitMessageForStorage(
        {
          id: `stress-message-${index}`,
          chatId: `stress-chat-${Math.floor(index / 64)}`,
          parentId: null,
          siblingIndex: 0,
          turnId: `stress-turn-${index}`,
          turnIndex: 0,
          createdAt: index + 1,
          role: 'assistant',
          origin: 'generated',
          generation: {
            model: 'test/model',
            requestedModel: 'test/model',
            apiUsed: 'chat',
            startedAt: index + 1,
            finishedAt: index + 1,
            status: 'done',
            reasoningCarryForward: 'none',
            reasoningVisibility: { disclosure: 'unknown' },
          },
          content: [{ type: 'output_text', text: `answer ${index}` }],
          nodeVersion: 1,
          deleted: false,
        },
        { bodyVersion: 1 },
      ),
    )
    await legacy.table('messages').bulkPut(storedRows.map(({ header }) => header))
    await legacy.table('messagePreviews').bulkPut(storedRows.map(({ preview }) => preview))
    await legacy.table('messageBodies').bulkPut(
      storedRows.map(({ body }, index) => ({
        ...body,
        reasoningDetails: [
          {
            type: 'reasoning.text',
            format: 'unknown',
            text: `thought ${index}`,
          },
        ],
      })),
    )
    legacy.close()

    const migrated = await prepareProductionV94Fixture(name)
    const whereSpy = vi.spyOn(migrated.Table.prototype, 'where')
    const openCursorSpy = vi.spyOn(IDBObjectStore.prototype, 'openCursor')
    await migrated.open()
    const targetLeaseQueries = whereSpy.mock.calls.filter(
      ([index]) => typeof index === 'string' && index === 'targetOwnerKey',
    )
    const messageBodyCursorCalls = openCursorSpy.mock.contexts.filter(
      (context) => context instanceof IDBObjectStore && context.name === 'messageBodies',
    )
    whereSpy.mockRestore()
    openCursorSpy.mockRestore()

    expect(targetLeaseQueries).toHaveLength(0)
    expect(messageBodyCursorCalls).toHaveLength(1)
    const [headers, bodies, previews] = await Promise.all([
      migrated.messages.toArray(),
      migrated.messageBodies.toArray(),
      migrated.messagePreviews.toArray(),
    ])
    expect(headers).toHaveLength(rowCount)
    expect(bodies).toHaveLength(rowCount)
    expect(previews).toHaveLength(rowCount)
    expect(
      headers.every(
        (header) =>
          header.nodeVersion === 1 &&
          header.bodyVersion === 1 &&
          header.requestContextVersion === 1,
      ),
    ).toBe(true)
    expect(
      bodies.every(
        (body) =>
          body.bodyVersion === 1 &&
          isReasoningEnvelope(body.reasoningEnvelope) &&
          !Object.hasOwn(body, 'reasoningDetails'),
      ),
    ).toBe(true)
    expect(previews.every((preview) => preview.bodyVersion === 1)).toBe(true)
    await migrated.delete()
  }, 30_000)

  it('upgrades observed v89 carry-forward evidence through bounded v94 cursor passes', async () => {
    const name = `natter-test-v90-carry-forward-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)
    const legacy = await openObservedWaveAFixture(name, 89)

    const hugeTail = `${'x'.repeat(1024 * 1024)}:v90-tail`
    const stored = splitMessageForStorage(
      {
        id: 'assistant-v90',
        chatId: 'chat-v90',
        parentId: null,
        siblingIndex: 0,
        turnId: 'turn-v90',
        turnIndex: 0,
        createdAt: 11,
        role: 'assistant',
        origin: 'generated',
        generation: {
          model: 'test/model',
          requestedModel: 'test/model',
          apiUsed: 'chat',
          status: 'done',
          startedAt: 11,
          finishedAt: 12,
          reasoningCarryForward: 'none',
          reasoningVisibility: { disclosure: 'unknown' },
        },
        content: [{ type: 'output_text', text: hugeTail }],
        continuationAttempts: [
          {
            streamId: 'continuation-v90-a',
            strategy: 'prompt',
            status: 'done',
            startedAt: 13,
            finishedAt: 14,
            reasoningCarryForward: 'none',
            reasoningVisibility: { disclosure: 'unknown' },
            application: { kind: 'applied' },
          },
          {
            streamId: 'continuation-v90-b',
            strategy: 'prefill',
            status: 'error',
            startedAt: 15,
            finishedAt: 16,
            reasoningCarryForward: 'none',
            reasoningVisibility: { disclosure: 'unknown' },
            application: { kind: 'applied' },
          },
        ],
        nodeVersion: 7,
        deleted: false,
      },
      { bodyVersion: 9, updatedAt: 17 },
    )
    const legacyHeader = messageHeaderWithoutReasoningCarryForward(stored.header)
    const legacyBody = messageBodyWithoutReasoningCarryForward(stored.body, 'invalid')
    const targetRows = [
      splitMessageForStorage(
        {
          id: 'assistant-v90-generation',
          chatId: 'chat-v90',
          parentId: null,
          siblingIndex: 1,
          turnId: 'turn-v90-generation',
          turnIndex: 0,
          createdAt: 20,
          role: 'assistant',
          origin: 'generated',
          generation: {
            model: 'test/model',
            requestedModel: 'test/model',
            apiUsed: 'chat',
            status: 'streaming',
            startedAt: 20,
            reasoningCarryForward: 'none',
            reasoningVisibility: { disclosure: 'unknown' },
          },
          content: [],
          nodeVersion: 1,
          deleted: false,
        },
        { bodyVersion: 1 },
      ),
      splitMessageForStorage(
        {
          id: 'assistant-v90-continuation',
          chatId: 'chat-v90',
          parentId: null,
          siblingIndex: 2,
          turnId: 'turn-v90-continuation',
          turnIndex: 0,
          createdAt: 21,
          role: 'assistant',
          origin: 'generated',
          generation: {
            model: 'test/model',
            requestedModel: 'test/model',
            apiUsed: 'chat',
            status: 'done',
            startedAt: 21,
            finishedAt: 22,
            reasoningCarryForward: 'none',
            reasoningVisibility: { disclosure: 'unknown' },
          },
          content: [{ type: 'output_text', text: 'continuation target' }],
          nodeVersion: 7,
          deleted: false,
        },
        { bodyVersion: 9 },
      ),
      splitMessageForStorage(
        {
          id: 'reserved-target-v90',
          chatId: 'chat-v90',
          parentId: null,
          siblingIndex: 3,
          turnId: 'turn-v90-reserved',
          turnIndex: 0,
          createdAt: 23,
          role: 'assistant',
          origin: 'generated',
          generation: {
            model: 'test/model',
            requestedModel: 'test/model',
            apiUsed: 'chat',
            status: 'streaming',
            startedAt: 23,
            reasoningCarryForward: 'none',
            reasoningVisibility: { disclosure: 'unknown' },
          },
          content: [],
          nodeVersion: 1,
          deleted: false,
        },
        { bodyVersion: 1 },
      ),
      splitMessageForStorage(
        {
          id: 'null-target-v90',
          chatId: 'chat-v90',
          parentId: null,
          siblingIndex: 4,
          turnId: 'turn-v90-null',
          turnIndex: 0,
          createdAt: 24,
          role: 'assistant',
          origin: 'generated',
          generation: {
            model: 'test/model',
            requestedModel: 'test/model',
            apiUsed: 'chat',
            status: 'done',
            startedAt: 24,
            finishedAt: 25,
            reasoningCarryForward: 'none',
            reasoningVisibility: { disclosure: 'unknown' },
          },
          content: [{ type: 'output_text', text: 'terminal target' }],
          nodeVersion: 1,
          deleted: false,
        },
        { bodyVersion: 1 },
      ),
    ]
    const generationLease = {
      ...leaseWithoutReasoningCarryForward(
        testGenerationLease({
          streamId: 'generation-v90',
          chatId: 'chat-v90',
          messageId: 'assistant-v90-generation',
          revision: 4,
          controlRevision: 0,
        }),
      ),
      journalEventVersion: 1,
    }
    const continuationLease = {
      ...leaseWithoutReasoningCarryForward(
        testContinuationLease({
          streamId: 'continuation-v90',
          chatId: 'chat-v90',
          messageId: 'assistant-v90-continuation',
          revision: 5,
          baseNodeVersion: 7,
          baseBodyVersion: 9,
        }),
      ),
      journalEventVersion: 1,
    }
    const reservedLease = testGenerationLease({
      phase: 'reserved',
      streamId: 'reserved-v90',
      chatId: 'chat-v90',
      messageId: 'reserved-target-v90',
      revision: 6,
    })
    const nullDispatchLease = testGenerationLease({
      phase: 'canonical',
      dispatched: false,
      streamId: 'null-dispatch-v90',
      chatId: 'chat-v90',
      messageId: 'null-target-v90',
      revision: 7,
    })

    await legacy.table('chats').put({
      ...buildChat({ id: 'chat-v90', title: 'Carry forward', now: 1 }),
      lastUpdatedLeafId: stored.header.id,
    })
    await legacy
      .table('messages')
      .bulkPut([
        legacyHeader,
        ...targetRows.map(({ header }) => messageHeaderWithoutReasoningCarryForward(header)),
      ])
    await legacy
      .table('messageBodies')
      .bulkPut([
        legacyBody,
        ...targetRows.map(({ body }) => messageBodyWithoutReasoningCarryForward(body)),
      ])
    await legacy
      .table('messagePreviews')
      .bulkPut([stored.preview, ...targetRows.map(({ preview }) => preview)])
    await legacy
      .table('streamLeases')
      .bulkPut([generationLease, continuationLease, reservedLease, nullDispatchLease])
    legacy.close()

    const migrated = await prepareProductionV94Fixture(name)
    const openCursorSpy = vi.spyOn(IDBObjectStore.prototype, 'openCursor')
    const toArraySpy = vi.spyOn(migrated.Table.prototype, 'toArray')
    const whereSpy = vi.spyOn(migrated.Table.prototype, 'where')
    await migrated.open()
    const migrationCursorNames = openCursorSpy.mock.contexts
      .filter((context): context is IDBObjectStore => context instanceof IDBObjectStore)
      .map((context) => context.name)
      .filter(
        (table) => table === 'messages' || table === 'messageBodies' || table === 'streamLeases',
      )
    const migrationToArrayCalls = toArraySpy.mock.calls.length
    const targetOwnerQueries = whereSpy.mock.calls.filter(
      ([index]) => typeof index === 'string' && index === 'targetOwnerKey',
    )
    openCursorSpy.mockRestore()
    toArraySpy.mockRestore()
    whereSpy.mockRestore()

    expect(migrationToArrayCalls).toBe(0)
    expect(targetOwnerQueries).toHaveLength(0)
    expect(migrationCursorNames.filter((table) => table === 'messages').length).toBeLessThanOrEqual(
      4,
    )
    expect(
      migrationCursorNames.filter((table) => table === 'messageBodies').length,
    ).toBeLessThanOrEqual(2)
    expect(
      migrationCursorNames.filter((table) => table === 'streamLeases').length,
    ).toBeLessThanOrEqual(4)

    const [header, body, leases] = await Promise.all([
      migrated.messages.get(stored.header.id),
      migrated.messageBodies.get(stored.body.id),
      migrated.streamLeases.bulkGet([
        'generation-v90',
        'continuation-v90',
        'reserved-v90',
        'null-dispatch-v90',
      ]),
    ])
    expect(header).toMatchObject({
      nodeVersion: 7,
      bodyVersion: 9,
      requestContextVersion: stored.header.requestContextVersion,
      generation: { reasoningCarryForward: 'unknown' },
    })
    expect(body).toMatchObject({ bodyVersion: 9, updatedAt: 17 })
    expect(body?.content[0]).toEqual({ type: 'output_text', text: hugeTail })
    expect(body?.continuationAttempts?.map((attempt) => attempt.reasoningCarryForward)).toEqual([
      'unknown',
      'unknown',
    ])
    expect(leases[0]).toMatchObject({
      custody: 'recovery-pending',
      revision: 5,
      controlRevision: 0,
      dispatch: { reasoningCarryForward: 'unknown' },
      handoffReason: 'owner-unavailable',
    })
    expect(leases[1]).toMatchObject({
      custody: 'recovery-pending',
      revision: 6,
      dispatch: {
        baseNodeVersion: 7,
        baseBodyVersion: 9,
        reasoningCarryForward: 'unknown',
      },
      handoffReason: 'owner-unavailable',
    })
    expect(leases[2]).toMatchObject({
      custody: 'recovery-pending',
      revision: 7,
      handoffReason: 'owner-unavailable',
    })
    expect(leases[3]).toEqual(nullDispatchLease)
    const migratedSnapshot = { header, body, leases }
    migrated.close()

    const reopened = await prepareProductionV94Fixture(name)
    const reopenCursorSpy = vi.spyOn(IDBObjectStore.prototype, 'openCursor')
    await reopened.open()
    const reopenedMigrationCursors = reopenCursorSpy.mock.contexts.filter(
      (context) =>
        context instanceof IDBObjectStore &&
        (context.name === 'messages' ||
          context.name === 'messageBodies' ||
          context.name === 'streamLeases'),
    )
    reopenCursorSpy.mockRestore()
    expect(reopenedMigrationCursors).toHaveLength(0)
    expect({
      header: await reopened.messages.get(stored.header.id),
      body: await reopened.messageBodies.get(stored.body.id),
      leases: await reopened.streamLeases.bulkGet([
        'generation-v90',
        'continuation-v90',
        'reserved-v90',
        'null-dispatch-v90',
      ]),
    }).toEqual(migratedSnapshot)
    await reopened.delete()
  }, 30_000)
})

type ObservedWaveAFixtureVersion = 88 | 89

async function openObservedWaveAFixture(
  name: string,
  version: ObservedWaveAFixtureVersion,
): Promise<Dexie> {
  const db = new Dexie(name)
  db.version(version).stores(observedWaveAStoreSpec(version))
  await db.open()
  if (db.verno !== version) {
    db.close()
    throw new Error(`ObservedWaveAFixtureVersionMismatch:${version}:${db.verno}`)
  }
  return db
}

async function prepareProductionV94Fixture(name: string): Promise<NatterDb> {
  const db = createDbForTests(name)
  await prepareBrowserWorkspaceSchema(db)
  return db
}

async function openProductionV94Fixture(name: string): Promise<NatterDb> {
  const db = await prepareProductionV94Fixture(name)
  await db.open()
  return db
}

function streamFrameStorageBytes(frames: readonly unknown[]): number {
  return frames.reduce<number>(
    (sum, frame) =>
      sum + estimateStreamJournalFrameStorageBytes(requireCanonicalStreamJournalFrame(frame)),
    0,
  )
}

function canonicalJournalFrames(frames: readonly unknown[]) {
  return frames.map(requireCanonicalStreamJournalFrame)
}

function lastJournalSeq(frames: readonly { readonly seq: number }[]): number {
  const last = frames.at(-1)
  if (!last) throw new Error('ExpectedNonEmptyJournalFrames')
  return last.seq
}

function leaseWithoutJournalVersion(lease: StreamLeaseRow): Record<string, unknown> {
  const { journalEventVersion: _journalEventVersion, ...legacy } = lease
  return leaseWithoutReasoningCarryForward(legacy)
}

function leaseWithoutReasoningCarryForward(
  lease: Omit<StreamLeaseRow, 'journalEventVersion'> | StreamLeaseRow,
): Record<string, unknown> {
  if (lease.phase === 'reserved' || lease.dispatch === null) return { ...lease }
  const dispatch = { ...lease.dispatch } as Record<string, unknown>
  delete dispatch.reasoningCarryForward
  delete dispatch.reasoningVisibility
  return { ...lease, dispatch }
}

function messageHeaderWithoutReasoningCarryForward(
  header: MessageHeaderRow,
): Record<string, unknown> {
  if (!header.generation) return { ...header }
  const {
    reasoningCarryForward: _reasoningCarryForward,
    reasoningVisibility: _reasoningVisibility,
    ...generation
  } = header.generation
  return { ...header, generation }
}

function messageBodyWithoutReasoningCarryForward(
  body: MessageBodyRow,
  secondAttemptFact: unknown = undefined,
): Record<string, unknown> {
  if (!body.continuationAttempts) return { ...body }
  return {
    ...body,
    continuationAttempts: body.continuationAttempts.map((attempt, index) => {
      const {
        application: _application,
        reasoningCarryForward: _reasoningCarryForward,
        reasoningVisibility: _reasoningVisibility,
        ...legacy
      } = attempt
      return index === 1 && secondAttemptFact !== undefined
        ? { ...legacy, reasoningCarryForward: secondAttemptFact }
        : legacy
    }),
  }
}

async function currentJournalEvents(db: NatterDb, streamId: string) {
  const frames = await db.streamChunks.where('streamId').equals(streamId).sortBy('seq')
  if (frames.length === 0) return []
  const first = frames[0]
  if (!first) return []
  const decoded = await decodeTestStreamJournalFrames(canonicalJournalFrames(frames), {
    streamId,
    chatId: first.chatId,
    messageId: first.messageId,
    replacementEpoch: first.replacementEpoch,
    admissionSequence: first.admissionSequence,
  })
  return decoded.map((entry) => {
    const persisted = persistedStreamEventV2FromUnknown(entry.event)
    if (!persisted) {
      const raw =
        entry.event && typeof entry.event === 'object'
          ? (entry.event as Record<string, unknown>)
          : undefined
      throw new Error(
        `ExpectedPersistedStreamEventV2:${raw ? Object.keys(raw).join(',') : typeof entry.event}:${first.ownerClientId}:${first.fenceToken}:${frames.length}`,
      )
    }
    return { createdAt: entry.createdAt, event: persisted.event }
  })
}

async function runAuditedCurrentSchemaBackfills(db: NatterDb): Promise<void> {
  await backfillMissingMessageBodies(db)
  await runWaveADerivedRowsForTest(db)
  await backfillChatPreviewProjection(db)
  await migrateGlobalSettingsRows(db)
  await migrateProviderOutputItemRows(db)
  await migrateProviderToolSettingsRows(db)
  await rebuildTokenCalibrationGlobalRows(db)
  await canonicalizeTokenCalibrationRows(db)
}

async function runWaveADerivedRowsForTest(db: NatterDb): Promise<void> {
  await db.transaction('rw', db.tables, (tx) =>
    migrateWaveADerivedRowsV94(tx, {
      observedAt: 1,
      recordObsoleteBytes: () => {},
    }),
  )
  await db.settings.put({ key: 'backfill:organization-fields-v1', value: 1 })
}

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
            reasoningCarryForward: 'none' as const,
            reasoningVisibility: { disclosure: 'unknown' as const },
            startedAt: 1,
          },
        }
      : {}),
    nodeVersion: 0,
    deleted: input.deleted ?? false,
  }
}

function legacyEmptyMessageBody(
  id: string,
  chatId: string,
  nodeVersion = 0,
): Record<string, unknown> {
  return {
    id,
    chatId,
    nodeVersion,
    updatedAt: 1,
    content: [],
  }
}

async function seedLegacyGenerationTargets(
  db: Dexie,
  streamIds: readonly string[],
  finishedStreamIds: ReadonlySet<string>,
): Promise<void> {
  const chat = {
    ...buildChat({ id: 'chat-1', title: 'Stream migration', now: 1 }),
    lastUpdatedLeafId: streamIds.at(-1) ? `message:${streamIds.at(-1)}` : null,
  }
  const stored = streamIds.map((streamId, index) =>
    splitMessageForStorage({
      id: `message:${streamId}`,
      chatId: chat.id,
      parentId: null,
      siblingIndex: index,
      turnId: `turn:${streamId}`,
      turnIndex: index,
      createdAt: index + 1,
      role: 'assistant',
      origin: 'generated',
      content: [{ type: 'output_text', text: '' }],
      generation: {
        id: `generation:${streamId}`,
        model: 'test/model',
        requestedModel: 'test/model',
        apiUsed: 'chat',
        delivery: 'streaming',
        status: finishedStreamIds.has(streamId) ? 'done' : 'streaming',
        costSource: 'stream',
        reasoningCarryForward: 'none',
        reasoningVisibility: { disclosure: 'unknown' },
        startedAt: 1,
        ...(finishedStreamIds.has(streamId) ? { finishedAt: 2 } : {}),
      },
      nodeVersion: 0,
      deleted: false,
    }),
  )
  await db.table('chats').put(chat)
  await db.table('messages').bulkPut(stored.map(({ header }) => header))
  await db.table('messageBodies').bulkPut(stored.map(({ body }) => body))
  await db.table('messagePreviews').bulkPut(stored.map(({ preview }) => preview))
}
