import type { Table, Transaction } from 'dexie'
import { migrateCurrentChatSettingsSnapshot } from './chat-settings'
import {
  canonicalizeGlobalSettingsRows,
  canonicalizePinnedModelSettingsRows,
  canonicalizeRecentModelSettingsRows,
  globalSettingsBackfillMarker,
  globalSettingsMigrationKeys,
  pinnedModelDefaultBackfillMarker,
  recentModelRecencyBackfillMarker,
} from './global-settings'
import {
  LEGACY_STORAGE_COMPACTION_STATE_KEY,
  storageCompactionControlBackfillMarker,
} from './storage-compaction-control'
import { migrateStorageCompactionStateV2 } from './storage-compaction-state-v2'
import {
  appendGlobalCalibrationRow,
  canonicalizeTokenCalibrationSamples,
  createGlobalCalibrationAccumulator,
  GLOBAL_TOKEN_CALIBRATION_KEY,
} from './token-calibration-global'
import { migrateWaveADerivedRowsV94 } from './wave-a-derived-storage-v94'
import { migrateWaveAMessageAndAttachmentRowsV94 } from './wave-a-message-storage-v94'
import {
  beginWaveAPresetOrderV94,
  finishWaveAPresetOrderV94,
  observeWaveAPresetOrderRowsV94,
} from './wave-a-preset-order-v94'
import type { WaveAStorageEpochMigrationCapabilitiesV94 } from './wave-a-storage-capabilities-v94'
import { migrateWaveAOperationalStreamRowsV94 } from './wave-a-stream-storage-v94'
import { readLegacyBrowserWorkspaceMetaFromTransaction } from './workspace-meta'

export type { WaveAStorageEpochMigrationCapabilitiesV94 } from './wave-a-storage-capabilities-v94'

import {
  PINNED_MODELS_KEY,
  RECENT_MODEL_RECENCY_KEY,
  RECENT_MODELS_KEY,
} from '../core/global-settings'
import type {
  Chat,
  ChatId,
  ChatPreset,
  ConnectionProfile,
  KeyId,
  KeyRecord,
  PresetId,
  ProfileId,
  PromptPreset,
  PromptPresetId,
  PromptPresetKind,
} from '../core/types'
import { sameValue } from '../lib/same-value'
import {
  type BoundedBatchWriter,
  createBoundedBatchWriter,
  forEachBoundedIdbCursorPage,
} from '../store/bounded-idb-cursor'
import { type BrowserLockRow, emptyBrowserWriterLockRow } from '../store/browser-lock-record'
import { chatStoragePhysicalIndexFields } from '../store/chat-storage-codec'
import {
  type ConfigurationCatalogMetadataRow,
  type ConfigurationPresetCatalogProjectionRow,
  type ConfigurationProfileCatalogProjectionRow,
  type ConfigurationPromptPresetCatalogProjectionRow,
  configurationCatalogMetadataRowsFromCounts,
  configurationPresetCatalogProjectionRow,
  configurationProfileCatalogProjectionRow,
  configurationPromptPresetCatalogProjectionRow,
} from '../store/configuration-catalog-projection'
import {
  type ConfigurationLink,
  configurationLinksForChat,
  configurationLinksForPreset,
  configurationLinksForProfileIterable,
} from '../store/configuration-domain-contract'
import {
  type ConfigurationProfileUsageDelta,
  type ConfigurationProfileUsageProjectionRow,
  configurationProfileUsageDeltas,
  emptyConfigurationProfileUsageProjectionRow,
} from '../store/configuration-profile-usage-projection'
import type { SettingsRow } from '../store/db-rows'
import {
  freshStorageRetentionStateRows,
  type StorageRetentionStateRow,
  type StorageRetentionTask,
} from '../store/storage-retention-state'
import {
  BROWSER_WORKSPACE_FENCE_ID,
  type BrowserWorkspaceFenceRow,
  createBrowserWorkspaceId,
} from '../store/workspace-meta'

export { WAVE_A_STORAGE_VERSION, WAVE_A_V94_STORES } from '../store/browser-workspace-schema-v94'

import { waveACompletionSettingsV94 } from '../store/browser-workspace-schema-v94'

const WORKSPACE_META_KEY = 'workspace-meta'
const CURRENT_SCHEMA_BACKFILL_MANIFEST_KEY = 'backfill:current-schema-manifest-v1'
const SENTINEL_WORKSPACE_IDS = new Set(['browser-idb', 'browser-idb:natter'])
const WAVE_A_V94_PAGE_MAX_ROWS = 128
const WAVE_A_V94_PAGE_MAX_BYTES = 4 * 1024 * 1024

export interface WaveAStorageSingletonMigrationResultV94 {
  readonly delayedMarkers: readonly SettingsRow[]
  readonly requiresCompactionControlTransfer: boolean
}

export async function migrateWaveAStorageEpochRowsV94(
  tx: Transaction,
  capabilities: WaveAStorageEpochMigrationCapabilitiesV94,
): Promise<WaveAStorageSingletonMigrationResultV94> {
  capabilities.reportProgress?.({
    phase: 'completion-markers-reset',
    operation: 'delete-stale-completion-markers',
    processedRows: 0,
    processedBytes: 0,
  })
  await tx
    .table<SettingsRow, string>('settings')
    .bulkDelete([
      CURRENT_SCHEMA_BACKFILL_MANIFEST_KEY,
      ...waveACompletionSettingsV94().map((row) => row.key),
    ])
  capabilities.reportProgress?.({
    phase: 'singletons',
    operation: 'normalize-singletons',
    processedRows: 0,
    processedBytes: 0,
  })
  const singletons = await migrateWaveAStorageSingletonsV94(
    tx,
    capabilities.compactionControlTransferPrepared === true,
  )
  capabilities.reportProgress?.({
    phase: 'configuration-and-chats',
    operation: 'normalize-configuration-and-chats',
    processedRows: 0,
    processedBytes: 0,
  })
  await migrateWaveAConfigurationAndChatRowsV94(tx, capabilities)
  capabilities.reportProgress?.({
    phase: 'messages-and-attachments',
    operation: 'normalize-messages-and-attachments',
    processedRows: 0,
    processedBytes: 0,
  })
  await migrateWaveAMessageAndAttachmentRowsV94(tx, capabilities)
  capabilities.reportProgress?.({
    phase: 'streams',
    operation: 'normalize-streams',
    processedRows: 0,
    processedBytes: 0,
  })
  const streams = await migrateWaveAOperationalStreamRowsV94(tx, capabilities)
  capabilities.reportProgress?.({
    phase: 'derived-state',
    operation: 'rebuild-derived-state',
    processedRows: 0,
    processedBytes: 0,
  })
  await migrateWaveADerivedRowsV94(tx, capabilities)
  return {
    delayedMarkers: [...singletons.delayedMarkers, ...streams.delayedMarkers],
    requiresCompactionControlTransfer: singletons.requiresCompactionControlTransfer,
  }
}

export async function finalizeWaveAStorageEpochRowsV94(
  tx: Transaction,
  result: WaveAStorageSingletonMigrationResultV94,
  reportProgress?: WaveAStorageEpochMigrationCapabilitiesV94['reportProgress'],
): Promise<void> {
  if (result.requiresCompactionControlTransfer) {
    throw new Error('WaveACompactionControlTransferNotPrepared')
  }
  reportProgress?.({
    phase: 'completion-markers-write',
    operation: 'write-completion-markers',
    processedRows: 0,
    processedBytes: 0,
  })
  await tx.table<SettingsRow, string>('settings').bulkPut([...waveACompletionSettingsV94()])
}

export async function migrateWaveAStorageSingletonsV94(
  tx: Transaction,
  compactionControlTransferPrepared = false,
): Promise<WaveAStorageSingletonMigrationResultV94> {
  const settings = tx.table<SettingsRow, string>('settings')
  await settings.delete(CURRENT_SCHEMA_BACKFILL_MANIFEST_KEY)

  await Promise.all([
    normalizeWorkspaceFenceV94(tx),
    resetBrowserLocksV94(tx),
    resetStorageRetentionV94(tx),
  ])

  const settingKeys = [
    ...globalSettingsMigrationKeys(),
    PINNED_MODELS_KEY,
    RECENT_MODELS_KEY,
    RECENT_MODEL_RECENCY_KEY,
  ]
  const storedRows = (await settings.bulkGet(settingKeys)).filter(
    (row): row is SettingsRow => row !== undefined,
  )
  const rowsByKey = new Map(storedRows.map((row) => [row.key, row] as const))
  const delayedMarkers = [
    globalSettingsBackfillMarker(),
    pinnedModelDefaultBackfillMarker(),
    recentModelRecencyBackfillMarker(),
  ]
  const globalPatch = canonicalizeGlobalSettingsRows(storedRows)
  const pinnedRows = canonicalizePinnedModelSettingsRows(storedRows)
  const recentRows = canonicalizeRecentModelSettingsRows(
    storedRows.filter(
      (row) => row.key === RECENT_MODELS_KEY || row.key === RECENT_MODEL_RECENCY_KEY,
    ),
  ).filter((row) => row.key !== recentModelRecencyBackfillMarker().key)
  const candidatePuts = [...globalPatch.put, ...pinnedRows, ...recentRows]
  const changedPuts = candidatePuts.filter(
    (row) => !sameValue(rowsByKey.get(row.key)?.value, row.value),
  )
  await Promise.all([
    changedPuts.length > 0 ? settings.bulkPut(changedPuts) : Promise.resolve(),
    settings.bulkDelete([...globalPatch.deleteKeys, ...delayedMarkers.map((row) => row.key)]),
  ])

  const compactionMarker = storageCompactionControlBackfillMarker()
  const [storedCompactionMarker, legacyCompactionState] = await Promise.all([
    settings.get(compactionMarker.key),
    settings.get(LEGACY_STORAGE_COMPACTION_STATE_KEY),
  ])
  const compactionControlCurrent = Object.is(storedCompactionMarker?.value, compactionMarker.value)
  if (compactionControlCurrent) {
    if (legacyCompactionState) await settings.delete(LEGACY_STORAGE_COMPACTION_STATE_KEY)
  } else if (legacyCompactionState && compactionControlTransferPrepared) {
    await settings.delete(LEGACY_STORAGE_COMPACTION_STATE_KEY)
  } else {
    await settings.delete(compactionMarker.key)
    if (legacyCompactionState) await migrateStorageCompactionStateV2(tx)
  }

  return {
    delayedMarkers: [
      ...delayedMarkers,
      ...(!compactionControlCurrent && (!legacyCompactionState || compactionControlTransferPrepared)
        ? [compactionMarker]
        : []),
    ],
    requiresCompactionControlTransfer:
      !compactionControlCurrent &&
      legacyCompactionState !== undefined &&
      !compactionControlTransferPrepared,
  }
}

async function normalizeWorkspaceFenceV94(tx: Transaction): Promise<void> {
  const settings = tx.table<SettingsRow, string>('settings')
  const fences = tx.table<BrowserWorkspaceFenceRow, string>('workspaceFence')
  const [current, legacy] = await Promise.all([
    fences.get(BROWSER_WORKSPACE_FENCE_ID),
    readLegacyBrowserWorkspaceMetaFromTransaction(tx),
  ])
  const currentIsValid = validWorkspaceFenceV94(current)
  const workspaceId = currentIsValid
    ? current.workspaceId
    : validWorkspaceIdV94(legacy.workspaceId)
      ? legacy.workspaceId
      : createBrowserWorkspaceId()
  const replacementEpoch = currentIsValid ? current.replacementEpoch : legacy.replacementEpoch
  await fences.clear()
  await Promise.all([
    fences.put({ id: BROWSER_WORKSPACE_FENCE_ID, workspaceId, replacementEpoch }),
    settings.delete(WORKSPACE_META_KEY),
  ])
}

function validWorkspaceFenceV94(
  row: BrowserWorkspaceFenceRow | undefined,
): row is BrowserWorkspaceFenceRow {
  return (
    row?.id === BROWSER_WORKSPACE_FENCE_ID &&
    validWorkspaceIdV94(row.workspaceId) &&
    Number.isSafeInteger(row.replacementEpoch) &&
    row.replacementEpoch >= 0
  )
}

function validWorkspaceIdV94(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !SENTINEL_WORKSPACE_IDS.has(value)
}

async function resetBrowserLocksV94(tx: Transaction): Promise<void> {
  const locks = tx.table<BrowserLockRow, string>('browserLocks')
  await locks.clear()
  await locks.put(emptyBrowserWriterLockRow())
}

async function resetStorageRetentionV94(tx: Transaction): Promise<void> {
  const retention = tx.table<StorageRetentionStateRow, StorageRetentionTask>(
    'storageRetentionState',
  )
  await retention.clear()
  await retention.bulkPut([...freshStorageRetentionStateRows()])
}

export async function migrateWaveAConfigurationAndChatRowsV94(
  tx: Transaction,
  capabilities?: WaveAStorageEpochMigrationCapabilitiesV94,
): Promise<void> {
  const presetOrder = await beginWaveAPresetOrderV94(tx)
  await clearConfigurationDerivedRowsV94(tx)
  const links = boundedTableWriterV94<ConfigurationLink, string>(
    tx.table<ConfigurationLink, string>('configurationLinks'),
    'ConfigurationLinks',
  )
  const counts: MutableConfigurationCountsV94 = {
    totalProfileCount: 0,
    activeProfileCount: 0,
    promptPresetCounts: {
      system: 0,
      append: 0,
      'continue-system': 0,
      'continue-user': 0,
      prefill: 0,
    },
  }

  await normalizeProfilesV94(tx, links, counts)
  await normalizeKeysV94(tx)
  await normalizePresetsV94(tx, links, presetOrder)
  await finishWaveAPresetOrderV94(tx, presetOrder)
  await normalizePromptPresetsV94(tx, counts)
  await normalizeChatsV94(tx, links, capabilities)
  await links.flush()
  await tx
    .table<ConfigurationCatalogMetadataRow, string>('configurationCatalogAggregates')
    .bulkPut([...configurationCatalogMetadataRowsFromCounts(counts)])
}

interface MutableConfigurationCountsV94 {
  totalProfileCount: number
  activeProfileCount: number
  promptPresetCounts: Record<PromptPresetKind, number>
}

async function clearConfigurationDerivedRowsV94(tx: Transaction): Promise<void> {
  await Promise.all(
    [
      'configurationProfileCatalogRows',
      'configurationPresetCatalogRows',
      'configurationPromptPresetCatalogRows',
      'configurationCatalogAggregates',
      'configurationLinks',
      'configurationProfileUsageRows',
    ].map((tableName) => tx.table(tableName).clear()),
  )
}

async function normalizeProfilesV94(
  tx: Transaction,
  links: BoundedBatchWriter<ConfigurationLink>,
  counts: MutableConfigurationCountsV94,
): Promise<void> {
  const profiles = tx.table<ConnectionProfile, ProfileId>('profiles')
  const profileRows = boundedTableWriterV94<ConfigurationProfileCatalogProjectionRow, ProfileId>(
    tx.table<ConfigurationProfileCatalogProjectionRow, ProfileId>(
      'configurationProfileCatalogRows',
    ),
    'ConfigurationProfileCatalog',
  )
  const changed = boundedTableWriterV94<ConnectionProfile, ProfileId>(profiles, 'Profiles')
  await forEachBoundedIdbCursorPage<ConnectionProfile>(
    tx.idbtrans.objectStore('profiles'),
    boundedCursorOptionsV94('Profiles'),
    async (page) => {
      for (const entry of page.entries) {
        const profile = entry.value
        const requestRevision = nonNegativeSafeIntegerV94(profile.requestRevision)
          ? profile.requestRevision
          : 0
        const next =
          requestRevision === profile.requestRevision ? profile : { ...profile, requestRevision }
        if (next !== profile) await changed.add(next)
        const projection = configurationProfileCatalogProjectionRow(next)
        await profileRows.add(projection)
        counts.totalProfileCount += 1
        if (projection.activeKey === 1) counts.activeProfileCount += 1
        for (const link of configurationLinksForProfileIterable(next)) await links.add(link)
      }
    },
  )
  await Promise.all([changed.flush(), profileRows.flush()])
}

async function normalizeKeysV94(tx: Transaction): Promise<void> {
  const keys = tx.table<KeyRecord, KeyId>('keys')
  const changed = boundedTableWriterV94<KeyRecord, KeyId>(keys, 'Keys')
  await forEachBoundedIdbCursorPage<KeyRecord>(
    tx.idbtrans.objectStore('keys'),
    boundedCursorOptionsV94('Keys'),
    async (page) => {
      for (const entry of page.entries) {
        const key = entry.value
        if (nonNegativeSafeIntegerV94(key.materialRevision)) continue
        await changed.add({ ...key, materialRevision: 0 })
      }
    },
  )
  await changed.flush()
}

async function normalizePresetsV94(
  tx: Transaction,
  links: BoundedBatchWriter<ConfigurationLink>,
  presetOrder: Awaited<ReturnType<typeof beginWaveAPresetOrderV94>>,
): Promise<void> {
  const presets = tx.table<ChatPreset, PresetId>('presets')
  const changed = boundedTableWriterV94<ChatPreset, PresetId>(presets, 'Presets')
  const catalog = boundedTableWriterV94<ConfigurationPresetCatalogProjectionRow, PresetId>(
    tx.table<ConfigurationPresetCatalogProjectionRow, PresetId>('configurationPresetCatalogRows'),
    'ConfigurationPresetCatalog',
  )
  await forEachBoundedIdbCursorPage<ChatPreset & { readonly sortIndex?: unknown }>(
    tx.idbtrans.objectStore('presets'),
    boundedCursorOptionsV94('Presets'),
    async (page) => {
      const originalRows = page.entries.map((entry) => entry.value)
      await observeWaveAPresetOrderRowsV94(tx, presetOrder, originalRows)
      const usageDeltas: ConfigurationProfileUsageDelta[] = []
      for (const raw of originalRows) {
        const migrated = migrateCurrentChatSettingsSnapshot(raw.settings)
        const settings =
          migrated.settings.profileId === raw.connectionProfileId
            ? migrated.settings
            : { ...migrated.settings, profileId: raw.connectionProfileId }
        const changedRow =
          migrated.changed || settings !== migrated.settings || Object.hasOwn(raw, 'sortIndex')
        const { sortIndex: _sortIndex, ...withoutSortIndex } = raw
        const next = { ...withoutSortIndex, settings }
        if (changedRow) await changed.add(next)
        await catalog.add(configurationPresetCatalogProjectionRow(next))
        const ownerLinks = configurationLinksForPreset(next)
        for (const link of ownerLinks) await links.add(link)
        usageDeltas.push(...configurationProfileUsageDeltas([], ownerLinks))
      }
      await applyConfigurationProfileUsageDeltasV94(tx, usageDeltas)
    },
  )
  await Promise.all([changed.flush(), catalog.flush()])
}

async function normalizePromptPresetsV94(
  tx: Transaction,
  counts: MutableConfigurationCountsV94,
): Promise<void> {
  const catalog = boundedTableWriterV94<
    ConfigurationPromptPresetCatalogProjectionRow,
    PromptPresetId
  >(
    tx.table<ConfigurationPromptPresetCatalogProjectionRow, PromptPresetId>(
      'configurationPromptPresetCatalogRows',
    ),
    'ConfigurationPromptPresetCatalog',
  )
  await forEachBoundedIdbCursorPage<PromptPreset>(
    tx.idbtrans.objectStore('promptPresets'),
    boundedCursorOptionsV94('PromptPresets'),
    async (page) => {
      for (const { value: preset } of page.entries) {
        counts.promptPresetCounts[preset.kind] += 1
        await catalog.add(configurationPromptPresetCatalogProjectionRow(preset))
      }
    },
  )
  await catalog.flush()
}

type StoredChatV94 = Chat & {
  readonly archivedKey?: unknown
  readonly temporaryKey?: unknown
  readonly temporaryRetentionAt?: unknown
}

async function normalizeChatsV94(
  tx: Transaction,
  links: BoundedBatchWriter<ConfigurationLink>,
  capabilities?: WaveAStorageEpochMigrationCapabilitiesV94,
): Promise<void> {
  const chats = tx.table<StoredChatV94, ChatId>('chats')
  const changed = boundedTableWriterV94<StoredChatV94, ChatId>(chats, 'Chats')
  const globalCalibration = createGlobalCalibrationAccumulator()
  await forEachBoundedIdbCursorPage<StoredChatV94>(
    tx.idbtrans.objectStore('chats'),
    boundedCursorOptionsV94('Chats', capabilities),
    async (page) => {
      const usageDeltas: ConfigurationProfileUsageDelta[] = []
      for (const entry of page.entries) {
        const raw = entry.value
        const migrated = migrateCurrentChatSettingsSnapshot(raw.settings)
        const calibration = canonicalizeTokenCalibrationSamples(raw.tokenCalibration)
        const temporary = legacyHiddenDraftV94(raw) ? true : raw.temporary
        const chat: Chat = {
          ...raw,
          settings: migrated.settings,
          ...(calibration.samples === undefined ? {} : { tokenCalibration: calibration.samples }),
          structuralVersion: nonNegativeSafeIntegerV94(raw.structuralVersion)
            ? raw.structuralVersion
            : 0,
          configurationVersion: nonNegativeSafeIntegerV94(raw.configurationVersion)
            ? raw.configurationVersion
            : 0,
          ...(temporary === undefined ? {} : { temporary }),
        }
        const physical = chatStoragePhysicalIndexFields(chat)
        const next: StoredChatV94 = { ...chat, ...physical }
        appendGlobalCalibrationRow(globalCalibration, chat)
        if (
          migrated.changed ||
          calibration.changed ||
          chat.structuralVersion !== raw.structuralVersion ||
          chat.configurationVersion !== raw.configurationVersion ||
          chat.temporary !== raw.temporary ||
          raw.archivedKey !== physical.archivedKey ||
          raw.temporaryKey !== physical.temporaryKey ||
          raw.temporaryRetentionAt !== physical.temporaryRetentionAt
        ) {
          await changed.add(next)
          capabilities?.recordObsoleteBytes(entry.estimatedBytes)
        }
        const ownerLinks = configurationLinksForChat(chat)
        for (const link of ownerLinks) await links.add(link)
        usageDeltas.push(...configurationProfileUsageDeltas([], ownerLinks))
      }
      await applyConfigurationProfileUsageDeltasV94(tx, usageDeltas)
    },
  )
  await changed.flush()
  await tx.table<SettingsRow, string>('settings').put({
    key: GLOBAL_TOKEN_CALIBRATION_KEY,
    value: globalCalibration,
  })
}

async function applyConfigurationProfileUsageDeltasV94(
  tx: Transaction,
  deltas: readonly ConfigurationProfileUsageDelta[],
): Promise<void> {
  const page = new Map<ProfileId, ConfigurationProfileUsageProjectionRow>()
  for (const delta of deltas) {
    const current = page.get(delta.id) ?? emptyConfigurationProfileUsageProjectionRow(delta.id)
    page.set(delta.id, {
      id: delta.id,
      presetCount: current.presetCount + delta.presetCount,
      activePresetCount: current.activePresetCount + delta.activePresetCount,
      chatCount: current.chatCount + delta.chatCount,
      activeChatCount: current.activeChatCount + delta.activeChatCount,
    })
  }
  const ids = [...page.keys()]
  if (ids.length === 0) return
  const table = tx.table<ConfigurationProfileUsageProjectionRow, ProfileId>(
    'configurationProfileUsageRows',
  )
  const previous = await table.bulkGet(ids)
  await table.bulkPut(
    ids.map((id, index) => {
      const current = previous[index] ?? emptyConfigurationProfileUsageProjectionRow(id)
      const delta = page.get(id) as ConfigurationProfileUsageProjectionRow
      return {
        id,
        presetCount: current.presetCount + delta.presetCount,
        activePresetCount: current.activePresetCount + delta.activePresetCount,
        chatCount: current.chatCount + delta.chatCount,
        activeChatCount: current.activeChatCount + delta.activeChatCount,
      }
    }),
  )
}

function boundedCursorOptionsV94(
  operation: string,
  capabilities?: WaveAStorageEpochMigrationCapabilitiesV94,
): {
  readonly maxRows: number
  readonly maxBytes: number
  readonly operation: string
  readonly onPageVisited?: (page: {
    readonly entries: readonly unknown[]
    readonly estimatedBytes: number
  }) => void
} {
  let processedRows = 0
  let processedBytes = 0
  return {
    maxRows: WAVE_A_V94_PAGE_MAX_ROWS,
    maxBytes: WAVE_A_V94_PAGE_MAX_BYTES,
    operation: `WaveA${operation}`,
    ...(capabilities
      ? {
          onPageVisited: (page: {
            readonly entries: readonly unknown[]
            readonly estimatedBytes: number
          }) => {
            processedRows += page.entries.length
            processedBytes = Math.min(Number.MAX_SAFE_INTEGER, processedBytes + page.estimatedBytes)
            capabilities.reportProgress?.({
              phase: 'configuration-and-chats',
              operation,
              processedRows,
              processedBytes,
            })
          },
        }
      : {}),
  }
}

function boundedTableWriterV94<Row, Key>(
  table: Table<Row, Key>,
  operation: string,
): BoundedBatchWriter<Row> {
  return createBoundedBatchWriter({
    maxRows: WAVE_A_V94_PAGE_MAX_ROWS,
    maxBytes: WAVE_A_V94_PAGE_MAX_BYTES,
    operation: `WaveA${operation}`,
    write: (rows) => table.bulkPut([...rows]).then(() => undefined),
  })
}

function nonNegativeSafeIntegerV94(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function legacyHiddenDraftV94(chat: Chat): boolean {
  return (
    chat.temporary === undefined &&
    !chat.archived &&
    chat.presetId === undefined &&
    typeof chat.title === 'string' &&
    chat.title.trim().length === 0 &&
    chat.titleStatus === 'untitled' &&
    (chat.previewText === undefined || chat.previewText === '')
  )
}
