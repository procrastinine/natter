// The module exports a single default-name singleton for production. Tests that
// need isolation use `createDbForTests(name)` to mint a uniquely-named instance
// and close it when they're done.

import Dexie, { type Table } from 'dexie'
import { migrateAttachmentHeaderProjection } from '../backcompat/attachment-header-projection'
import {
  rebuildAttachmentReferenceEdges,
  scrubMissingAttachmentByteReferences,
} from '../backcompat/attachment-reference-edges'
import {
  attachmentRefsBackfillMarker,
  migrateLegacyAttachmentStorage,
  normalizeAttachmentRefOwners,
} from '../backcompat/attachment-refs'
import { migrateBrowserWriterLock } from '../backcompat/browser-writer-lock'
import { migrateChatPreviewProjection } from '../backcompat/chat-preview-projection'
import { migrateCurrentChatSettingsSnapshot } from '../backcompat/chat-settings'
import { migrateChatSidebarProjection } from '../backcompat/chat-sidebar-projection'
import { migrateLegacyChildLists } from '../backcompat/child-lists'
import { migrateGenerationAttemptOutcomes } from '../backcompat/generation-attempt-outcomes'
import { migrateInlineMessageBodies } from '../backcompat/message-body-split'
import { migrateMessageBodyVersions } from '../backcompat/message-body-version'
import { migrateMessageHeaderProjections } from '../backcompat/message-header-projections'
import { migrateMessageRequestContextVersions } from '../backcompat/message-request-context-version'
import {
  migrateLegacyPresetSortOrder,
  PRESET_SORT_MIGRATION_INDEX,
} from '../backcompat/preset-sort-order'
import { migrateProviderApiModeTables } from '../backcompat/provider-api-modes'
import { migrateProviderSettingsTables } from '../backcompat/provider-settings-migration'
import { migrateProviderToolSettings } from '../backcompat/provider-tools'
import { runOnceBackfillInTransaction } from '../backcompat/run-once'
import type * as SidebarFolderPresentationV98 from '../backcompat/sidebar-folder-presentation-v98'
import { migrateStreamLeaseAttempts } from '../backcompat/stream-lease-attempts'
import { migrateWorkspaceReplacementEpoch } from '../backcompat/workspace-meta'
import {
  DEFAULT_CONTINUE_SYSTEM_PROMPT,
  DEFAULT_CONTINUE_USER_PROMPT,
} from '../core/continue-prompts'
import {
  emptyRecentModelRecency,
  RECENT_MODEL_RECENCY_KEY,
  RECENT_MODELS_KEY,
} from '../core/global-settings'
import {
  normalizeRenderingPreferences,
  RENDERING_PREFERENCES_KEY,
} from '../core/rendering-preferences'
import type { SavedTextTemplate } from '../core/text-templates'
import type {
  AttachmentArtifact,
  AttachmentBlob,
  AttachmentJob,
  AttachmentReferenceEdge,
  Chat,
  ChatFolder,
  ChatPreset,
  ChatTag,
  ChildListState,
  ChildSlotMember,
  ConnectionProfile,
  DraftRow,
  KeyRecord,
  Message,
  PresetId,
  PromptPreset,
} from '../core/types'
import type { BrowserWorkspaceDatabaseName } from '../lib/origin-storage-names'
import {
  ATTACHMENT_CATALOG_AGGREGATE_ID,
  type AttachmentCatalogAggregateRow,
  type AttachmentCatalogProjectionRow,
  emptyAttachmentCatalogAggregateRow,
} from './attachment-catalog-projection'
import {
  type AttachmentIntegrityStateRow,
  completedAttachmentIntegrityState,
} from './attachment-integrity-maintenance'
import type { AttachmentHeaderRow } from './attachment-storage'
import { configureBroadcastFallbackReader, seedBroadcastWorkspaceSnapshot } from './broadcast'
import { installBrowserCommandMutationJournal } from './browser-command-mutation-journal'
import { type BrowserLockRow, emptyBrowserWriterLockRow } from './browser-lock-record'
import {
  assertBrowserWorkspaceBootstrapAuthority,
  assertBrowserWorkspaceBootstrapAuthorityOwned,
  type BrowserWorkspaceBootstrapAuthority,
} from './browser-workspace-bootstrap-authority'
import { probeBrowserWorkspaceCurrent } from './browser-workspace-current-probe'
import { readExistingIndexedDb } from './browser-workspace-database-control'
import type {
  BrowserWorkspaceMigrationProgress,
  BrowserWorkspaceOpenOptions,
  BrowserWorkspaceOpenProgress,
} from './browser-workspace-open-contract'
import {
  WAVE_A_STORAGE_VERSION,
  WAVE_A_V94_STORES,
  waveACompletionSettingsV94,
} from './browser-workspace-schema-v94'
import {
  browserWorkspaceCurrentCompletionSettingV97,
  WAVE_B_STORAGE_VERSION,
  WAVE_B_V97_STORES,
} from './browser-workspace-schema-v97'
import {
  BROWSER_WORKSPACE_CURRENT_COMPLETION_KEY,
  BROWSER_WORKSPACE_PREVIOUS_COMPLETION_KEY,
  browserWorkspaceCurrentCompletionSettingV98,
  isBrowserWorkspaceCurrentCompletionValueV98,
  WAVE_C_STORAGE_VERSION,
  WAVE_C_V98_STORES,
} from './browser-workspace-schema-v98'
import {
  type BrowserWorkspaceRegisteredUpgradeStrategy,
  CURRENT_BROWSER_WORKSPACE_STORAGE_EPOCH,
  registeredBrowserWorkspaceUpgradeRouteFrom,
  registeredBrowserWorkspaceUpgradeStrategyFrom,
} from './browser-workspace-upgrade-strategy'
import {
  CHAT_SIDEBAR_AGGREGATE_ID,
  type ChatSidebarAggregateProjectionRow,
  type ChatSidebarProjectionRow,
  chatSidebarProjectionBackfillMarker,
  emptyChatSidebarAggregateRow,
  rebuildChatSidebarProjectionRowsInTransaction,
} from './chat-sidebar-projection'
import { installChatStorageCodec } from './chat-storage-codec'
import {
  CONFIGURATION_CATALOG_AGGREGATE_ID,
  type ConfigurationCatalogMetadataRow,
  type ConfigurationPresetCatalogProjectionRow,
  type ConfigurationProfileCatalogProjectionRow,
  type ConfigurationPromptPresetCatalogProjectionRow,
  emptyConfigurationCatalogMetadataRows,
} from './configuration-catalog-projection'
import type { ConfigurationLink } from './configuration-domain-contract'
import type { ConfigurationProfileUsageProjectionRow } from './configuration-profile-usage-projection'
import type {
  CachedEndpointsStorageRow,
  CachedModelsStorageRow,
  CachedPrivacyPolicyStorageRow,
  DiscoveryCacheStateStorageRow,
  DiscoveryPayloadMetadataStorageRow,
  DiscoveryPayloadStorageRow,
  SettingsRow,
} from './db-rows'
import { seedEmptyDiscoveryCacheState } from './discovery-cache-storage'
import { configureLockDatabaseRunner } from './locks'
import {
  installMessageStorageCodec,
  type MessageBodyRow,
  type MessageHeaderRow,
  type MessageTextPreviewRow,
} from './message-storage'
import {
  BROWSER_WORKSPACE_CATCHUP_JOURNAL_TABLE_NAMES,
  CANONICAL_PHYSICAL_STORAGE_TABLE_NAMES,
  REPAIRABLE_PHYSICAL_STORAGE_TABLE_NAMES,
} from './physical-storage-tables'
import {
  emptyPresetOrderState,
  PRESET_ORDER_STATE_ID,
  type PresetOrderBlockRow,
  type PresetOrderMembershipRow,
  type PresetOrderStateRow,
} from './preset-order'
import {
  type StreamJournalFrameRow,
  type StreamLeaseRow,
  type WorkspaceFence,
  WorkspaceSessionClosedError,
} from './repository'
import { accumulateStorageCompactionDebt } from './storage-compaction-state'
import {
  freshStorageRetentionStateRows,
  type StorageRetentionStateRow,
  type StorageRetentionTask,
} from './storage-retention-state'
import {
  type BrowserWorkspaceFenceRow,
  browserWorkspaceFenceRow,
  readBrowserWorkspaceMeta,
} from './workspace-meta'

export type { SettingsRow } from './db-rows'

export const CURRENT_DB_VERSION = CURRENT_BROWSER_WORKSPACE_STORAGE_EPOCH.storageVersion

export class NatterDb extends Dexie {
  chats!: Table<Chat, string>
  chatSidebarRows!: Table<ChatSidebarProjectionRow, string>
  chatSidebarAggregates!: Table<ChatSidebarAggregateProjectionRow, string>
  messages!: Table<MessageHeaderRow, string>
  messageBodies!: Table<MessageBodyRow, string>
  messagePreviews!: Table<MessageTextPreviewRow, string>
  childLists!: Table<ChildListState, string>
  childSlotMembers!: Table<ChildSlotMember, string>
  attachments!: Table<AttachmentHeaderRow, string>
  attachmentCatalogRows!: Table<AttachmentCatalogProjectionRow, string>
  attachmentCatalogAggregate!: Table<AttachmentCatalogAggregateRow, string>
  attachmentBlobs!: Table<AttachmentBlob, string>
  attachmentArtifacts!: Table<AttachmentArtifact, string>
  attachmentJobs!: Table<AttachmentJob, string>
  attachmentRefEdges!: Table<
    AttachmentReferenceEdge,
    [AttachmentReferenceEdge['ownerKind'], string, string]
  >
  attachmentIntegrityState!: Table<AttachmentIntegrityStateRow, string>
  profiles!: Table<ConnectionProfile, string>
  configurationProfileCatalogRows!: Table<ConfigurationProfileCatalogProjectionRow, string>
  configurationProfileUsageRows!: Table<ConfigurationProfileUsageProjectionRow, string>
  configurationCatalogAggregates!: Table<ConfigurationCatalogMetadataRow, string>
  presets!: Table<ChatPreset, string>
  configurationPresetCatalogRows!: Table<ConfigurationPresetCatalogProjectionRow, string>
  presetOrderState!: Table<PresetOrderStateRow, typeof PRESET_ORDER_STATE_ID>
  presetOrderBlocks!: Table<PresetOrderBlockRow, string>
  presetOrderMembership!: Table<PresetOrderMembershipRow, PresetId>
  promptPresets!: Table<PromptPreset, string>
  configurationPromptPresetCatalogRows!: Table<
    ConfigurationPromptPresetCatalogProjectionRow,
    string
  >
  folders!: Table<ChatFolder, string>
  tags!: Table<ChatTag, string>
  keys!: Table<KeyRecord, string>
  settings!: Table<SettingsRow, string>
  storageRetentionState!: Table<StorageRetentionStateRow, StorageRetentionTask>
  workspaceFence!: Table<BrowserWorkspaceFenceRow, string>
  browserLocks!: Table<BrowserLockRow, string>
  streamLeases!: Table<StreamLeaseRow, string>
  streamChunks!: Table<StreamJournalFrameRow, string>
  models!: Table<CachedModelsStorageRow, [string, string]>
  endpoints!: Table<CachedEndpointsStorageRow, [string, string]>
  privacyPolicies!: Table<CachedPrivacyPolicyStorageRow, [string, string]>
  discoveryPayloads!: Table<DiscoveryPayloadStorageRow, string>
  discoveryPayloadMetadata!: Table<DiscoveryPayloadMetadataStorageRow, string>
  discoveryCacheState!: Table<DiscoveryCacheStateStorageRow, string>
  drafts!: Table<DraftRow, string>
  configurationLinks!: Table<ConfigurationLink, string>
  textTemplates!: Table<SavedTextTemplate, string>

  constructor(name = 'natter') {
    super(name)
    installBrowserCommandMutationJournal(this)
    registerSchema(this)
    installChatStorageCodec(this)
    installMessageStorageCodec(this)
  }
}

interface BrowserWorkspaceIndexManifest {
  readonly keyPath: string
  readonly unique: boolean
  readonly multiEntry: boolean
}

interface BrowserWorkspaceStoreManifest {
  readonly name: string
  readonly keyPath: string
  readonly autoIncrement: boolean
  readonly indexes: readonly BrowserWorkspaceIndexManifest[]
}

type BrowserWorkspaceSchemaManifest = readonly BrowserWorkspaceStoreManifest[]

const CANONICAL_BROWSER_WORKSPACE_STORES = new Set<string>([
  ...CANONICAL_PHYSICAL_STORAGE_TABLE_NAMES,
  ...BROWSER_WORKSPACE_CATCHUP_JOURNAL_TABLE_NAMES,
])
const DERIVED_BROWSER_WORKSPACE_STORES = new Set<string>(REPAIRABLE_PHYSICAL_STORAGE_TABLE_NAMES)
const RETIRED_BROWSER_WORKSPACE_STORES = new Set([
  'chatBranchCache',
  'generations',
  'presetResolutions',
  'providers',
  'storageMaintenanceState',
])
const CURRENT_BROWSER_WORKSPACE_NATIVE_VERSION = CURRENT_DB_VERSION * 10

interface BrowserWorkspaceSchemaPreflight {
  readonly physicalVersion?: number
  readonly repairStores: readonly string[]
  readonly compactionControlTransferPrepared: boolean
}

interface WaveAUpgradePreflight {
  readonly compactionControlTransferPrepared: boolean
  readonly observedAt: number
  readonly physicalVersion?: number
}

const waveAUpgradePreflights = new WeakMap<Dexie, WaveAUpgradePreflight>()
const waveAUpgradeProgressPorts = new WeakMap<
  Dexie,
  (progress: BrowserWorkspaceOpenProgress) => void
>()
let loadedSidebarFolderPresentationV98: typeof SidebarFolderPresentationV98 | null = null

class BrowserWorkspaceSchemaIntegrityError extends Error {
  readonly detail: string

  constructor(detail: string) {
    super(`BrowserWorkspaceSchemaIntegrity:${detail}`)
    this.name = 'BrowserWorkspaceSchemaIntegrityError'
    this.detail = detail
  }
}

function registeredBrowserWorkspaceSchema(db: NatterDb): BrowserWorkspaceSchemaManifest {
  return Object.freeze(
    db.tables
      .map((table) =>
        Object.freeze({
          name: table.name,
          keyPath: schemaKeyPath(table.schema.primKey.keyPath),
          autoIncrement: table.schema.primKey.auto === true,
          indexes: Object.freeze(
            table.schema.indexes
              .map((index) =>
                Object.freeze({
                  keyPath: schemaKeyPath(index.keyPath),
                  unique: index.unique === true,
                  multiEntry: index.multi === true,
                }),
              )
              .sort(compareIndexManifest),
          ),
        }),
      )
      .sort((left, right) => left.name.localeCompare(right.name)),
  )
}

function verifyBrowserWorkspaceSchema(
  db: NatterDb,
  expected: BrowserWorkspaceSchemaManifest,
): void {
  const backend = db.backendDB()
  const actualStoreNames = [...backend.objectStoreNames].sort((left, right) =>
    left.localeCompare(right),
  )
  const expectedStoreNames = expected.map((store) => store.name)
  if (!sameStringArray(actualStoreNames, expectedStoreNames)) {
    const actual = new Set(actualStoreNames)
    const registered = new Set(expectedStoreNames)
    const missing = expectedStoreNames.filter((name) => !actual.has(name))
    const unexpected = actualStoreNames.filter((name) => !registered.has(name))
    throw new BrowserWorkspaceSchemaIntegrityError(
      `stores:missing=${missing.join(',')}:unexpected=${unexpected.join(',')}`,
    )
  }
  let transaction: IDBTransaction
  try {
    transaction = backend.transaction(actualStoreNames, 'readonly')
  } catch {
    throw new BrowserWorkspaceSchemaIntegrityError('transaction')
  }
  for (const expectedStore of expected) {
    let actualStore: IDBObjectStore
    try {
      actualStore = transaction.objectStore(expectedStore.name)
    } catch {
      throw new BrowserWorkspaceSchemaIntegrityError(`store:${expectedStore.name}`)
    }
    if (
      schemaKeyPath(actualStore.keyPath) !== expectedStore.keyPath ||
      actualStore.autoIncrement !== expectedStore.autoIncrement
    ) {
      throw new BrowserWorkspaceSchemaIntegrityError(`primary:${expectedStore.name}`)
    }
    const actualIndexes = [...actualStore.indexNames]
      .map((name) => {
        const index = actualStore.index(name)
        return {
          keyPath: schemaKeyPath(index.keyPath),
          unique: index.unique,
          multiEntry: index.multiEntry,
        }
      })
      .sort(compareIndexManifest)
    if (
      actualIndexes.length !== expectedStore.indexes.length ||
      actualIndexes.some((index, position) => {
        const expectedIndex = expectedStore.indexes[position]
        return (
          !expectedIndex ||
          index.keyPath !== expectedIndex.keyPath ||
          index.unique !== expectedIndex.unique ||
          index.multiEntry !== expectedIndex.multiEntry
        )
      })
    ) {
      throw new BrowserWorkspaceSchemaIntegrityError(`indexes:${expectedStore.name}`)
    }
  }
}

async function preflightBrowserWorkspaceSchema(
  db: NatterDb,
  expected: BrowserWorkspaceSchemaManifest,
): Promise<BrowserWorkspaceSchemaPreflight> {
  const current = await probeBrowserWorkspaceCurrent(db.name)
  if (current.kind === 'absent') {
    return {
      repairStores: Object.freeze([]),
      compactionControlTransferPrepared: false,
    }
  }
  if (current.kind === 'future') {
    throw new BrowserWorkspaceSchemaIntegrityError(`future-version:${current.physicalVersion}`)
  }
  if (current.kind === 'current') {
    return {
      physicalVersion: current.physicalVersion,
      repairStores: Object.freeze([]),
      compactionControlTransferPrepared: false,
    }
  }
  if (current.kind === 'upgrade-required') {
    return {
      physicalVersion: current.physicalVersion,
      repairStores: Object.freeze([]),
      compactionControlTransferPrepared: false,
    }
  }
  if (current.kind === 'strategy-missing') {
    throw new BrowserWorkspaceSchemaIntegrityError(
      `upgrade-strategy-missing:${current.physicalVersion}:${CURRENT_BROWSER_WORKSPACE_NATIVE_VERSION}`,
    )
  }
  const physical = await readPhysicalBrowserWorkspaceSchema(db.name)
  if (!physical) throw new BrowserWorkspaceSchemaIntegrityError('preflight-database-missing')
  const compactionControlTransferPrepared =
    physical.version >= 250 && physical.version < CURRENT_BROWSER_WORKSPACE_NATIVE_VERSION
      ? await prepareWaveACompactionControlTransfer(db.name)
      : false
  // Older authored versions may legitimately predate a canonical store; only
  // the registered version-gated upgrade is allowed to create and migrate it.
  const expectedNames = new Set(expected.map((store) => store.name))
  const missing = [...expectedNames].filter((name) => !physical.storeNames.has(name)).sort()
  const missingCanonical =
    physical.version < CURRENT_BROWSER_WORKSPACE_NATIVE_VERSION
      ? []
      : missing.filter((name) => CANONICAL_BROWSER_WORKSPACE_STORES.has(name))
  if (missingCanonical.length > 0) {
    throw new BrowserWorkspaceSchemaIntegrityError(
      `canonical-stores-missing:${missingCanonical.join(',')}`,
    )
  }
  const unclassifiedExpected = [...expectedNames].filter(
    (name) =>
      !CANONICAL_BROWSER_WORKSPACE_STORES.has(name) && !DERIVED_BROWSER_WORKSPACE_STORES.has(name),
  )
  if (unclassifiedExpected.length > 0) {
    throw new BrowserWorkspaceSchemaIntegrityError(
      `store-classification-missing:${unclassifiedExpected.sort().join(',')}`,
    )
  }
  const derivedRepairStores = new Set(
    missing.filter((name) => DERIVED_BROWSER_WORKSPACE_STORES.has(name)),
  )
  const unknownUnexpected: string[] = []
  for (const name of physical.storeNames) {
    if (expectedNames.has(name)) continue
    if (RETIRED_BROWSER_WORKSPACE_STORES.has(name)) derivedRepairStores.add(name)
    else unknownUnexpected.push(name)
  }
  if (unknownUnexpected.length > 0) {
    throw new BrowserWorkspaceSchemaIntegrityError(
      `unexpected-stores:${unknownUnexpected.sort().join(',')}`,
    )
  }
  for (const store of expected) {
    const actualPrimary = physical.primaryKeys.get(store.name)
    if (!actualPrimary) continue
    const primaryMatches =
      actualPrimary.keyPath === store.keyPath && actualPrimary.autoIncrement === store.autoIncrement
    if (primaryMatches) continue
    if (
      CANONICAL_BROWSER_WORKSPACE_STORES.has(store.name) &&
      physical.version >= CURRENT_BROWSER_WORKSPACE_NATIVE_VERSION
    ) {
      throw new BrowserWorkspaceSchemaIntegrityError(`canonical-primary:${store.name}`)
    }
    derivedRepairStores.add(store.name)
  }
  for (const store of expected) {
    const actualIndexes = physical.indexes.get(store.name)
    if (actualIndexes && !sameIndexManifests(actualIndexes, store.indexes)) {
      derivedRepairStores.add(store.name)
    }
  }
  const repairable = Object.freeze([...derivedRepairStores].sort())
  if (physical.version >= CURRENT_BROWSER_WORKSPACE_NATIVE_VERSION && repairable.length > 0) {
    throw new BrowserWorkspaceSchemaIntegrityError(
      `current-derived-repair-required:${repairable.join(',')}`,
    )
  }
  if (physical.version === CURRENT_BROWSER_WORKSPACE_NATIVE_VERSION) {
    throw new BrowserWorkspaceSchemaIntegrityError('current-completion-missing')
  }
  return {
    physicalVersion: physical.version,
    repairStores: repairable,
    compactionControlTransferPrepared,
  }
}

async function prepareWaveACompactionControlTransfer(databaseName: string): Promise<boolean> {
  const migration = await import('../backcompat/storage-compaction-control')
  return migration.prepareStorageCompactionStateControlTransfer(databaseName)
}

function readPhysicalBrowserWorkspaceSchema(name: string): Promise<{
  readonly version: number
  readonly storeNames: ReadonlySet<string>
  readonly primaryKeys: ReadonlyMap<
    string,
    { readonly keyPath: string; readonly autoIncrement: boolean }
  >
  readonly indexes: ReadonlyMap<string, readonly BrowserWorkspaceIndexManifest[]>
} | null> {
  return readExistingIndexedDb(name, (database) => {
    const storeNames = [...database.objectStoreNames]
    const primaryKeys = new Map<
      string,
      { readonly keyPath: string; readonly autoIncrement: boolean }
    >()
    const indexes = new Map<string, readonly BrowserWorkspaceIndexManifest[]>()
    if (storeNames.length === 0) {
      return {
        kind: 'value',
        value: {
          version: database.version,
          storeNames: new Set(),
          primaryKeys,
          indexes,
        },
      } as const
    }
    return {
      kind: 'transaction',
      storeNames,
      read: (transaction) => {
        for (const storeName of storeNames) {
          const store = transaction.objectStore(storeName)
          primaryKeys.set(storeName, {
            keyPath: schemaKeyPath(store.keyPath),
            autoIncrement: store.autoIncrement,
          })
          indexes.set(
            storeName,
            [...store.indexNames]
              .map((indexName) => {
                const index = store.index(indexName)
                return {
                  keyPath: schemaKeyPath(index.keyPath),
                  unique: index.unique,
                  multiEntry: index.multiEntry,
                }
              })
              .sort(compareIndexManifest),
          )
        }
        return {
          version: database.version,
          storeNames: new Set(storeNames),
          primaryKeys,
          indexes,
        }
      },
    } as const
  })
}

function schemaKeyPath(value: string | string[] | null | undefined): string {
  if (Array.isArray(value)) return JSON.stringify(value)
  return value ?? ''
}

function compareIndexManifest(
  left: BrowserWorkspaceIndexManifest,
  right: BrowserWorkspaceIndexManifest,
): number {
  return (
    left.keyPath.localeCompare(right.keyPath) ||
    Number(left.unique) - Number(right.unique) ||
    Number(left.multiEntry) - Number(right.multiEntry)
  )
}

function sameIndexManifests(
  left: readonly BrowserWorkspaceIndexManifest[],
  right: readonly BrowserWorkspaceIndexManifest[],
): boolean {
  return (
    left.length === right.length &&
    left.every((index, position) => {
      const expected = right[position]
      return (
        expected !== undefined &&
        index.keyPath === expected.keyPath &&
        index.unique === expected.unique &&
        index.multiEntry === expected.multiEntry
      )
    })
  )
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

// Schema registration is pulled out so test-only subclasses can replay v1 and
// then tack on synthetic v2/v3 upgrades.
export function registerSchema(db: Dexie): void {
  db.on('populate', async (tx) => {
    await Dexie.Promise.all([
      tx.table<SettingsRow>('settings').bulkPut(freshWorkspaceSettingsRows()),
      tx.table<BrowserWorkspaceFenceRow>('workspaceFence').put(browserWorkspaceFenceRow()),
      tx.table<BrowserLockRow>('browserLocks').put(emptyBrowserWriterLockRow()),
      tx
        .table<AttachmentCatalogAggregateRow>('attachmentCatalogAggregate')
        .put(emptyAttachmentCatalogAggregateRow()),
      tx
        .table<AttachmentIntegrityStateRow>('attachmentIntegrityState')
        .put(completedAttachmentIntegrityState()),
      tx
        .table<ChatSidebarAggregateProjectionRow>('chatSidebarAggregates')
        .put(emptyChatSidebarAggregateRow()),
      tx
        .table<ConfigurationCatalogMetadataRow>('configurationCatalogAggregates')
        .bulkPut(emptyConfigurationCatalogMetadataRows()),
      tx.table<PresetOrderStateRow>('presetOrderState').put(emptyPresetOrderState()),
      tx
        .table<StorageRetentionStateRow>('storageRetentionState')
        .bulkPut([...freshStorageRetentionStateRows()]),
      seedEmptyDiscoveryCacheState(tx),
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

      const messages = tx.table<LegacyMessageV1, string>('messages')
      await messages.toCollection().modify((row) => {
        if (row.nodeVersion === undefined) {
          ;(row as Message).nodeVersion = 0
        }
      })

      const childLists = tx.table<ChildListState, string>('childLists')
      await migrateLegacyChildLists(messages, childLists)
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
      await migrateProviderSettingsTables(tx)
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
      await migrateLegacyAttachmentStorage(tx)
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
      await migrateProviderSettingsTables(tx)
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
      await migrateProviderSettingsTables(tx)
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
        { key: 'global:message-initial-render-work', value: 10 },
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
      await migrateProviderApiModeTables(tx)
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
      presets: `id, name, connectionProfileId, sortIndex, lastUsedAt, archived, ${PRESET_SORT_MIGRATION_INDEX}`,
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
      await migrateLegacyPresetSortOrder(tx.table<ChatPreset, string>('presets'))
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

  // v22: generation/continuation attempts gained explicit terminal/integrity
  // state, fallback writes gained one persisted fence row, and attachment
  // owners gained a normalized live-edge projection and consistent missing-byte
  // bundles, and stale chat previews gained a one-time repair. Compose them so
  // this implementation block has one schema bump.
  db.version(22)
    .stores({
      chats:
        'id, updatedAt, createdAt, lastViewedAt, lastUpdatedLeafId, lastBranchUpdatedAt, wordCount, totalCostUsd, archived, pinned, presetId, folderId, *tags',
      chatSidebarRows:
        '&id, updatedAt, createdAt, lastViewedAt, lastUpdatedLeafId, lastBranchUpdatedAt, wordCount, totalCostUsd, archived, pinned, folderId, *tags',
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
      browserLocks: '&name',
      attachmentRefEdges:
        '&[ownerKind+ownerId+refId], attachmentId, [attachmentId+ownerKind], [ownerKind+ownerId], chatId',
      streamLeases: '&streamId, chatId, messageId, ownerClientId, heartbeatAt',
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
      await migrateWorkspaceReplacementEpoch(tx)
      await migrateStreamLeaseAttempts(tx)
      await migrateGenerationAttemptOutcomes(tx)
      await migrateBrowserWriterLock(tx)
      await runOnceBackfillInTransaction(tx, {
        marker: attachmentRefsBackfillMarker(),
        run: async (transaction) => {
          await normalizeAttachmentRefOwners(transaction)
          await scrubMissingAttachmentByteReferences(transaction)
          await rebuildAttachmentReferenceEdges(transaction)
        },
      })
      await migrateChatPreviewProjection(tx)
      await migrateChatSidebarProjection(tx)
    })

  // v23: add bounded message-header text previews and move potentially large
  // provider-hosted tool outputs into the cold message body.
  db.version(23).upgrade(async (tx) => {
    await migrateMessageHeaderProjections(tx)
    await migrateAttachmentHeaderProjection(tx)
  })

  // v24: structural header revisions no longer invalidate cold message bodies.
  // Body coherence and the branch word-count projection are explicit header
  // fields so tree-only mutations never have to read or rewrite payload rows.
  db.version(24)
    .stores({
      chats:
        'id, updatedAt, createdAt, lastViewedAt, lastUpdatedLeafId, lastBranchUpdatedAt, wordCount, totalCostUsd, archived, pinned, presetId, folderId, *tags',
      chatSidebarRows:
        '&id, updatedAt, createdAt, lastViewedAt, lastUpdatedLeafId, lastBranchUpdatedAt, wordCount, totalCostUsd, archived, pinned, folderId, *tags',
      messages:
        'id, chatId, parentId, turnId, [chatId+parentId], [chatId+createdAt], [chatId+turnId], [chatId+deleted]',
      messageBodies: '&id, chatId, updatedAt, bodyVersion',
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
      browserLocks: '&name',
      attachmentRefEdges:
        '&[ownerKind+ownerId+refId], attachmentId, [attachmentId+ownerKind], [ownerKind+ownerId], chatId',
      streamLeases: '&streamId, chatId, messageId, ownerClientId, heartbeatAt',
      streamChunks: '&id, streamId, chatId, messageId, [streamId+seq], createdAt',
      models: '&[profileId+queryKey], fetchedAt',
      endpoints: '&[profileId+modelId], fetchedAt',
      privacyPolicies: '&[profileId+modelId], fetchedAt',
      providers: '&profileId, fetchedAt',
      generations: 'id, chatId, gen_id',
      presetResolutions: '&[profileId+presetSlug], fetchedAt',
      drafts: '&chatId, updatedAt',
    })
    .upgrade(migrateMessageBodyVersions)

  // v25: request freshness has its own semantic revision. Generic header
  // metadata, sibling renumbering, and derived calibration no longer
  // impersonate a changed outbound prompt.
  db.version(25).upgrade(migrateMessageRequestContextVersions)

  db.version(WAVE_A_STORAGE_VERSION)
    .stores(WAVE_A_V94_STORES)
    .upgrade(async (tx) => {
      const migration = await Dexie.waitFor(import('../backcompat/wave-a-storage-epoch-v94'))
      const preflight = waveAUpgradePreflights.get(db)
      const report = waveAUpgradeProgressPorts.get(db)
      const reportProgress = report
        ? (progress: BrowserWorkspaceMigrationProgress) =>
            report({
              kind: 'database-upgrade',
              databaseName: db.name as BrowserWorkspaceDatabaseName,
              ...(preflight?.physicalVersion === undefined
                ? {}
                : { fromVersion: preflight.physicalVersion / 10 }),
              targetVersion: WAVE_A_STORAGE_VERSION,
              ...progress,
            })
        : undefined
      const result = await migration.migrateWaveAStorageEpochRowsV94(tx, {
        observedAt: preflight?.observedAt ?? Date.now(),
        recordObsoleteBytes: (byteLength) => accumulateStorageCompactionDebt(tx, byteLength),
        compactionControlTransferPrepared: preflight?.compactionControlTransferPrepared === true,
        ...(reportProgress ? { reportProgress } : {}),
      })
      await migration.finalizeWaveAStorageEpochRowsV94(tx, result, reportProgress)
    })

  db.version(WAVE_B_STORAGE_VERSION)
    .stores(WAVE_B_V97_STORES)
    .upgrade(async (tx) => {
      const preflight = waveAUpgradePreflights.get(db)
      if ((preflight?.physicalVersion ?? 0) > WAVE_A_STORAGE_VERSION * 10) {
        const migration = await Dexie.waitFor(import('../backcompat/wave-a-storage-epoch-v94'))
        const report = waveAUpgradeProgressPorts.get(db)
        const reportProgress = report
          ? (progress: BrowserWorkspaceMigrationProgress) =>
              report({
                kind: 'database-upgrade',
                databaseName: db.name as BrowserWorkspaceDatabaseName,
                ...(preflight?.physicalVersion === undefined
                  ? {}
                  : { fromVersion: preflight.physicalVersion / 10 }),
                targetVersion: WAVE_B_STORAGE_VERSION,
                ...progress,
              })
          : undefined
        const result = await migration.migrateWaveAStorageEpochRowsV94(tx, {
          observedAt: preflight?.observedAt ?? Date.now(),
          recordObsoleteBytes: (byteLength) => accumulateStorageCompactionDebt(tx, byteLength),
          compactionControlTransferPrepared: preflight?.compactionControlTransferPrepared === true,
          ...(reportProgress ? { reportProgress } : {}),
        })
        await migration.finalizeWaveAStorageEpochRowsV94(tx, result, reportProgress)
      }
      await tx
        .table<SettingsRow, string>('settings')
        .put(browserWorkspaceCurrentCompletionSettingV97())
    })

  db.version(WAVE_C_STORAGE_VERSION)
    .stores(WAVE_C_V98_STORES)
    .upgrade(async (tx) => {
      const migration =
        loadedSidebarFolderPresentationV98 ??
        (await Dexie.waitFor(import('../backcompat/sidebar-folder-presentation-v98')))
      const preflight = waveAUpgradePreflights.get(db)
      const report = waveAUpgradeProgressPorts.get(db)
      const reportProgress = report
        ? (progress: BrowserWorkspaceMigrationProgress) =>
            report({
              kind: 'database-upgrade',
              databaseName: db.name as BrowserWorkspaceDatabaseName,
              ...(preflight?.physicalVersion === undefined
                ? {}
                : { fromVersion: preflight.physicalVersion / 10 }),
              targetVersion: WAVE_C_STORAGE_VERSION,
              ...progress,
            })
        : undefined
      await migration.migrateSidebarFolderPresentationV98(
        {
          aggregates: tx.table<unknown, string>('chatSidebarAggregates'),
          folders: tx.table<ChatFolder, string>('folders'),
          settings: tx.table<SettingsRow, string>('settings'),
        },
        reportProgress,
        {
          ...(preflight?.physicalVersion !== undefined &&
          preflight.physicalVersion < WAVE_B_STORAGE_VERSION * 10
            ? { rebuildLegacyProjection: () => rebuildChatSidebarProjectionRowsInTransaction(tx) }
            : {}),
        },
      )
    })
}

function freshWorkspaceSettingsRows(): SettingsRow[] {
  return [
    ...waveACompletionSettingsV94(),
    chatSidebarProjectionBackfillMarker(),
    browserWorkspaceCurrentCompletionSettingV98(),
    { key: RECENT_MODELS_KEY, value: [] },
    { key: RECENT_MODEL_RECENCY_KEY, value: emptyRecentModelRecency() },
  ]
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export { childListKey } from '../core/child-list-state'

let singleton: NatterDb | null = null
let configuredBrowserWorkspaceDatabaseName: BrowserWorkspaceDatabaseName | null = null
let configuredBrowserWorkspaceCurrentPhysicalVersion: number | null = null
let currentSession: BrowserWorkspaceSessionImpl | null = null
let invalidatedSession: BrowserWorkspaceSessionImpl | null = null
let browserWorkspaceAdmissionsOpen = false
let browserWorkspaceRepositoryAdmissionsOpen = false
let activeBrowserWorkspaceRepositoryOperations = 0
let browserWorkspaceRepositoryIdlePromise: Promise<void> = Promise.resolve()
let resolveBrowserWorkspaceRepositoryIdle: (() => void) | null = null
let nextSessionGeneration = 0
declare const browserWorkspaceFatalInvalidationOwnerBrand: unique symbol

export interface BrowserWorkspaceFatalInvalidationOwner {
  readonly [browserWorkspaceFatalInvalidationOwnerBrand]: true
}

interface BrowserWorkspaceFatalInvalidationOwnerRecord {
  readonly handler: (event: BrowserWorkspaceFatalInvalidation) => void
  active: boolean
}

let browserWorkspaceFatalInvalidationOwner: BrowserWorkspaceFatalInvalidationOwnerRecord | null =
  null

export interface BrowserWorkspaceFatalInvalidation {
  readonly databaseName: string
  readonly sessionGeneration: number
  readonly kind: 'unexpected-close' | 'unexpected-versionchange'
  readonly oldVersion?: number
  readonly newVersion?: number | null
}

export function claimBrowserWorkspaceFatalInvalidationOwner(
  handler: (event: BrowserWorkspaceFatalInvalidation) => void,
): BrowserWorkspaceFatalInvalidationOwner {
  if (browserWorkspaceFatalInvalidationOwner) {
    throw new Error('BrowserWorkspaceFatalInvalidationOwnerAlreadyInstalled')
  }
  const owner: BrowserWorkspaceFatalInvalidationOwnerRecord = { handler, active: true }
  browserWorkspaceFatalInvalidationOwner = owner
  return owner as unknown as BrowserWorkspaceFatalInvalidationOwner
}

export function releaseBrowserWorkspaceFatalInvalidationOwner(
  handle: BrowserWorkspaceFatalInvalidationOwner,
): void {
  const owner = handle as unknown as BrowserWorkspaceFatalInvalidationOwnerRecord
  if (!owner.active) return
  if (browserWorkspaceFatalInvalidationOwner !== owner) {
    throw new Error('BrowserWorkspaceFatalInvalidationOwnerMismatch')
  }
  owner.active = false
  browserWorkspaceFatalInvalidationOwner = null
}

export async function recreateAndVerifyBrowserWorkspaceDatabase(name = 'natter'): Promise<void> {
  const db = new NatterDb(name)
  const schema = registeredBrowserWorkspaceSchema(db)
  try {
    await db.open()
    verifyBrowserWorkspaceSchema(db, schema)
    await verifyFreshBrowserWorkspace(db)
  } finally {
    db.close()
  }
}

export async function upgradeRegisteredBrowserWorkspaceDatabase(
  databaseName: BrowserWorkspaceDatabaseName,
  options: {
    readonly expectedPhysicalVersion: number
    readonly signal: AbortSignal
    readonly onProgress?: (progress: BrowserWorkspaceOpenProgress) => void
    readonly onBlocked?: (event: IDBVersionChangeEvent) => void
  },
): Promise<void> {
  const declared = registeredBrowserWorkspaceUpgradeStrategyFrom(options.expectedPhysicalVersion)
  if (!declared) {
    throw new BrowserWorkspaceSchemaIntegrityError(
      `registered-upgrade-source:${options.expectedPhysicalVersion}`,
    )
  }
  const before = await probeBrowserWorkspaceCurrent(databaseName)
  if (before.kind === 'current') return
  if (
    before.kind !== 'upgrade-required' ||
    before.physicalVersion !== options.expectedPhysicalVersion ||
    before.strategyId !== declared.id
  ) {
    throw new BrowserWorkspaceSchemaIntegrityError(`registered-upgrade-proof:${before.kind}`)
  }
  await loadRegisteredBrowserWorkspaceUpgradeImplementations(
    registeredBrowserWorkspaceUpgradeRouteFrom(before.physicalVersion),
  )

  const db = new NatterDb(databaseName)
  const registeredSchema = registeredBrowserWorkspaceSchema(db)
  const preflight: BrowserWorkspaceSchemaPreflight = {
    physicalVersion: before.physicalVersion,
    repairStores: Object.freeze([]),
    compactionControlTransferPrepared: false,
  }
  registerPreflightBrowserWorkspaceSchema(db, preflight)
  options.onProgress?.({
    kind: 'database-open',
    databaseName,
    fromVersion: before.physicalVersion / 10,
    targetVersion: CURRENT_BROWSER_WORKSPACE_STORAGE_EPOCH.storageVersion,
  })
  const receiveBlocked = (event: IDBVersionChangeEvent) => {
    options.onProgress?.({
      kind: 'database-selection',
      operation: 'wait-for-open-connections',
      databaseName,
    })
    options.onBlocked?.(event)
  }
  const cancelOpen = () => db.close()
  db.on.blocked.subscribe(receiveBlocked)
  options.signal.addEventListener('abort', cancelOpen, { once: true })
  if (options.onProgress) waveAUpgradeProgressPorts.set(db, options.onProgress)
  try {
    options.signal.throwIfAborted()
    try {
      await db.open()
    } catch (error) {
      options.signal.throwIfAborted()
      throw error
    }
    options.signal.throwIfAborted()
    verifyBrowserWorkspaceSchema(db, registeredSchema)
    const completion = await db.settings.get(CURRENT_BROWSER_WORKSPACE_STORAGE_EPOCH.completionKey)
    if (!CURRENT_BROWSER_WORKSPACE_STORAGE_EPOCH.completionIsValid(completion?.value)) {
      throw new BrowserWorkspaceSchemaIntegrityError('registered-upgrade-completion')
    }
  } finally {
    waveAUpgradeProgressPorts.delete(db)
    options.signal.removeEventListener('abort', cancelOpen)
    db.on.blocked.unsubscribe(receiveBlocked)
    db.close()
  }
}

async function loadRegisteredBrowserWorkspaceUpgradeImplementations(
  route: readonly BrowserWorkspaceRegisteredUpgradeStrategy[],
): Promise<void> {
  await Promise.all(
    route.map((strategy) => {
      if (strategy.implementationId === 'sidebar-folder-presentation-v98') {
        return import('../backcompat/sidebar-folder-presentation-v98').then((migration) => {
          loadedSidebarFolderPresentationV98 = migration
        })
      }
      throw new BrowserWorkspaceSchemaIntegrityError(
        `registered-upgrade-implementation:${strategy.implementationId}`,
      )
    }),
  )
}

export async function normalizeInactiveBrowserWorkspaceDatabase(
  databaseName: BrowserWorkspaceDatabaseName,
  options: {
    readonly fromVersion: number
    readonly onProgress?: (progress: BrowserWorkspaceOpenProgress) => void
  },
): Promise<void> {
  const compactionControlTransferPrepared =
    await prepareWaveACompactionControlTransfer(databaseName)
  const [migration, folderMigration] = await Promise.all([
    import('../backcompat/wave-a-storage-epoch-v94'),
    import('../backcompat/sidebar-folder-presentation-v98'),
  ])
  const db = new NatterDb(databaseName)
  const registeredSchema = registeredBrowserWorkspaceSchema(db)
  try {
    await db.open()
    await db.transaction('rw', db.tables, async (tx) => {
      const reportProgress = options.onProgress
        ? (progress: BrowserWorkspaceMigrationProgress) =>
            options.onProgress?.({
              kind: 'database-upgrade',
              databaseName,
              fromVersion: options.fromVersion / 10,
              targetVersion: WAVE_C_STORAGE_VERSION,
              ...progress,
            })
        : undefined
      await tx
        .table<SettingsRow, string>('settings')
        .delete(BROWSER_WORKSPACE_CURRENT_COMPLETION_KEY)
      await tx
        .table<SettingsRow, string>('settings')
        .delete(BROWSER_WORKSPACE_PREVIOUS_COMPLETION_KEY)
      const result = await migration.migrateWaveAStorageEpochRowsV94(tx, {
        observedAt: Date.now(),
        recordObsoleteBytes: (byteLength) => accumulateStorageCompactionDebt(tx, byteLength),
        compactionControlTransferPrepared,
        ...(reportProgress ? { reportProgress } : {}),
      })
      await migration.finalizeWaveAStorageEpochRowsV94(tx, result, reportProgress)
      await folderMigration.migrateSidebarFolderPresentationV98(
        {
          aggregates: tx.table<unknown, string>('chatSidebarAggregates'),
          folders: tx.table<ChatFolder, string>('folders'),
          settings: tx.table<SettingsRow, string>('settings'),
        },
        reportProgress,
      )
    })
    verifyBrowserWorkspaceSchema(db, registeredSchema)
    const completion = await db.settings.get(BROWSER_WORKSPACE_CURRENT_COMPLETION_KEY)
    if (!isBrowserWorkspaceCurrentCompletionValueV98(completion?.value)) {
      throw new BrowserWorkspaceSchemaIntegrityError('current-completion')
    }
  } finally {
    db.close()
  }
}

async function verifyFreshBrowserWorkspace(db: NatterDb): Promise<void> {
  await readBrowserWorkspaceMeta(db)
  const expectedSettings = freshWorkspaceSettingsRows()
  const settings = await db.settings.bulkGet(expectedSettings.map((row) => row.key))
  if (settings.some((row) => row === undefined)) {
    throw new BrowserWorkspaceSchemaIntegrityError('populate:settings')
  }
  const writerLock = emptyBrowserWriterLockRow()
  const [
    storedWriterLock,
    attachmentAggregate,
    sidebarAggregate,
    configurationAggregate,
    activePresetOrder,
  ] = await Promise.all([
    db.browserLocks.get(writerLock.name),
    db.attachmentCatalogAggregate.get(ATTACHMENT_CATALOG_AGGREGATE_ID),
    db.chatSidebarAggregates.get(CHAT_SIDEBAR_AGGREGATE_ID),
    db.configurationCatalogAggregates.get(CONFIGURATION_CATALOG_AGGREGATE_ID),
    db.presetOrderState.get(PRESET_ORDER_STATE_ID),
  ])
  if (!storedWriterLock) throw new BrowserWorkspaceSchemaIntegrityError('populate:writer-lock')
  if (!attachmentAggregate) {
    throw new BrowserWorkspaceSchemaIntegrityError('populate:attachment-aggregate')
  }
  if (!sidebarAggregate) {
    throw new BrowserWorkspaceSchemaIntegrityError('populate:sidebar-aggregate')
  }
  if (!configurationAggregate) {
    throw new BrowserWorkspaceSchemaIntegrityError('populate:configuration-aggregate')
  }
  if (!activePresetOrder) {
    throw new BrowserWorkspaceSchemaIntegrityError('populate:preset-order')
  }
  const unexpectedDomainRows = await Promise.all([
    db.chats.count(),
    db.messages.count(),
    db.attachments.count(),
    db.profiles.count(),
    db.presets.count(),
    db.keys.count(),
  ])
  if (unexpectedDomainRows.some((count) => count !== 0)) {
    throw new BrowserWorkspaceSchemaIntegrityError('populate:domain-rows')
  }
}

export function getDb(): NatterDb {
  assertBrowserWorkspaceAdmissionsOpen()
  if (!configuredBrowserWorkspaceDatabaseName) {
    throw new Error('BrowserWorkspaceDatabaseSelectionRequired')
  }
  if (!singleton) singleton = new NatterDb(configuredBrowserWorkspaceDatabaseName)
  return singleton
}

export function configureBrowserWorkspaceDatabaseName(
  databaseName: BrowserWorkspaceDatabaseName,
  currentPhysicalVersion?: number,
): void {
  if (singleton && singleton.name !== databaseName) {
    throw new Error(
      `BrowserWorkspaceDatabaseSelectionAlreadyOpen:${singleton.name}:${databaseName}`,
    )
  }
  configuredBrowserWorkspaceDatabaseName = databaseName
  configuredBrowserWorkspaceCurrentPhysicalVersion = currentPhysicalVersion ?? null
}

export function getConfiguredBrowserWorkspaceDatabaseName(): BrowserWorkspaceDatabaseName {
  if (!configuredBrowserWorkspaceDatabaseName) {
    throw new Error('BrowserWorkspaceDatabaseSelectionRequired')
  }
  return configuredBrowserWorkspaceDatabaseName
}

export class BrowserWorkspaceSessionClosedError extends WorkspaceSessionClosedError {
  constructor(cause?: unknown) {
    super('BrowserWorkspaceSessionClosed', cause)
    this.name = 'BrowserWorkspaceSessionClosedError'
  }
}

export interface BrowserWorkspaceSession {
  readonly generation: number
  readonly databaseName: string
  isCurrent(): boolean
  isOpen(): boolean
  assertCurrent(): void
  bindWorkspaceFence(authority: BrowserWorkspaceBootstrapAuthority, fence: WorkspaceFence): void
  getWorkspaceFence(): WorkspaceFence
  open(options?: OpenDbOptions): Promise<NatterDb>
  runOperation<T>(operation: (db: NatterDb) => T): T
}

export interface InvalidatedBrowserWorkspaceSession {
  readonly generation: number
  readonly databaseName: string
  waitForIdle(): Promise<void>
}

type BrowserWorkspaceSessionState = 'current' | 'invalidated' | 'closed'

class BrowserWorkspaceSessionImpl implements BrowserWorkspaceSession {
  readonly generation: number
  readonly databaseName: string
  readonly database: NatterDb
  readonly registeredSchema: BrowserWorkspaceSchemaManifest
  schemaPreflight: Promise<BrowserWorkspaceSchemaPreflight> | null = null
  schemaRegistrationConfigured = false
  private state: BrowserWorkspaceSessionState = 'current'
  private activeOperations = 0
  private idlePromise = Promise.resolve()
  private resolveIdle: (() => void) | null = null
  private databaseOpenInFlight = 0
  private fatalInvalidationReported = false
  private schemaVerified = false
  private workspaceFence: WorkspaceFence | null = null
  private readonly fatalInvalidationOwner: BrowserWorkspaceFatalInvalidationOwnerRecord | null

  constructor(database: NatterDb) {
    this.generation = ++nextSessionGeneration
    this.databaseName = database.name
    this.database = database
    this.fatalInvalidationOwner = browserWorkspaceFatalInvalidationOwner
    this.registeredSchema = registeredBrowserWorkspaceSchema(database)
    database.on.close.subscribe(this.receiveDatabaseClose)
    database.on.versionchange.subscribe(this.receiveDatabaseVersionChange)
  }

  isCurrent(): boolean {
    return (
      this.state === 'current' &&
      browserWorkspaceAdmissionsOpen &&
      currentSession === this &&
      singleton === this.database
    )
  }

  isOpen(): boolean {
    return this.database.isOpen()
  }

  open(options: OpenDbOptions = {}): Promise<NatterDb> {
    return this.runOperation(() => openSessionDatabase(this, options, () => this.assertCurrent()))
  }

  openForBootstrap(
    authority: BrowserWorkspaceBootstrapAuthority,
    options: OpenDbOptions = {},
  ): Promise<NatterDb> {
    return this.runBootstrapOperation(authority, () =>
      openSessionDatabase(this, options, () => this.assertBootstrapCurrent(authority)),
    )
  }

  runOperation<T>(operation: (db: NatterDb) => T): T {
    if (!this.isCurrent()) throw new BrowserWorkspaceSessionClosedError()
    this.beginOperation()
    try {
      const result = operation(this.database)
      if (isPromiseLike(result)) {
        return Promise.resolve(result)
          .catch((error: unknown) => {
            throw this.normalizeOperationError(error)
          })
          .finally(() => this.endOperation()) as T
      }
      this.endOperation()
      return result
    } catch (error) {
      this.endOperation()
      throw this.normalizeOperationError(error)
    }
  }

  invalidate(): void {
    if (this.state !== 'current') return
    this.state = 'invalidated'
    if (this.databaseOpenInFlight > 0 && !this.database.isOpen()) this.database.close()
  }

  assertCurrent(): void {
    if (!this.isCurrent()) throw new BrowserWorkspaceSessionClosedError()
  }

  bindWorkspaceFence(authority: BrowserWorkspaceBootstrapAuthority, fence: WorkspaceFence): void {
    this.assertBootstrapCurrent(authority)
    const current = this.workspaceFence
    if (
      current &&
      (current.workspaceId !== fence.workspaceId ||
        current.replacementEpoch !== fence.replacementEpoch)
    ) {
      throw new Error('BrowserWorkspaceSessionFenceAlreadyBound')
    }
    this.workspaceFence ??= Object.freeze({
      workspaceId: fence.workspaceId,
      replacementEpoch: fence.replacementEpoch,
    })
  }

  getWorkspaceFence(): WorkspaceFence {
    this.assertCurrent()
    if (!this.workspaceFence) throw new Error('BrowserWorkspaceSessionFenceUnbound')
    return this.workspaceFence
  }

  assertBootstrapCurrent(authority: BrowserWorkspaceBootstrapAuthority): void {
    assertBrowserWorkspaceBootstrapAuthority(authority)
    if (this.state !== 'current' || currentSession !== this || singleton !== this.database) {
      throw new BrowserWorkspaceSessionClosedError()
    }
  }

  assertBootstrapOwned(authority: BrowserWorkspaceBootstrapAuthority): void {
    assertBrowserWorkspaceBootstrapAuthorityOwned(authority)
    if (this.state !== 'current' || currentSession !== this || singleton !== this.database) {
      throw new BrowserWorkspaceSessionClosedError()
    }
  }

  beginDatabaseOpen(): void {
    this.databaseOpenInFlight += 1
  }

  endDatabaseOpen(): void {
    this.databaseOpenInFlight -= 1
  }

  verifySchema(preflight: BrowserWorkspaceSchemaPreflight): void {
    if (this.schemaVerified) return
    if (
      preflight.physicalVersion === this.database.backendDB().version &&
      preflight.repairStores.length === 0
    ) {
      this.schemaVerified = true
      return
    }
    verifyBrowserWorkspaceSchema(this.database, this.registeredSchema)
    this.schemaVerified = true
  }

  waitForIdle(): Promise<void> {
    return this.idlePromise
  }

  closeAfterIdle(): void {
    if (this.activeOperations !== 0) {
      throw new Error('BrowserWorkspaceSessionStillActive')
    }
    this.state = 'closed'
    this.database.close()
  }

  forceClose(): void {
    this.state = 'closed'
    this.database.close()
  }

  private beginOperation(): void {
    if (this.activeOperations === 0) {
      this.idlePromise = new Promise<void>((resolve) => {
        this.resolveIdle = resolve
      })
    }
    this.activeOperations += 1
  }

  private runBootstrapOperation<T>(
    authority: BrowserWorkspaceBootstrapAuthority,
    operation: (db: NatterDb) => T,
  ): T {
    this.assertBootstrapCurrent(authority)
    this.beginOperation()
    try {
      const result = operation(this.database)
      if (isPromiseLike(result)) {
        return Promise.resolve(result)
          .catch((error: unknown) => {
            throw this.normalizeOperationError(error)
          })
          .finally(() => this.endOperation()) as T
      }
      this.endOperation()
      return result
    } catch (error) {
      this.endOperation()
      throw this.normalizeOperationError(error)
    }
  }

  private endOperation(): void {
    this.activeOperations -= 1
    if (this.activeOperations !== 0) return
    const resolve = this.resolveIdle
    this.resolveIdle = null
    resolve?.()
  }

  private normalizeOperationError(error: unknown): unknown {
    if (error instanceof BrowserWorkspaceSessionClosedError) return error
    if (!isDatabaseClosedError(error)) return error
    if (this.isCurrent() && this.database.isOpen()) return error
    return new BrowserWorkspaceSessionClosedError(error)
  }

  private readonly receiveDatabaseClose = (): void => {
    if (this.databaseOpenInFlight > 0) return
    this.reportFatalInvalidation({ kind: 'unexpected-close' })
  }

  private readonly receiveDatabaseVersionChange = (event: IDBVersionChangeEvent): void => {
    this.reportFatalInvalidation({
      kind: 'unexpected-versionchange',
      oldVersion: event.oldVersion,
      newVersion: event.newVersion,
    })
  }

  private reportFatalInvalidation(
    detail: Pick<BrowserWorkspaceFatalInvalidation, 'kind' | 'oldVersion' | 'newVersion'>,
  ): void {
    if (
      this.fatalInvalidationReported ||
      this.state !== 'current' ||
      currentSession !== this ||
      singleton !== this.database
    ) {
      return
    }
    this.fatalInvalidationReported = true
    this.state = 'invalidated'
    browserWorkspaceAdmissionsOpen = false
    browserWorkspaceRepositoryAdmissionsOpen = false
    invalidatedSession ??= currentSession
    currentSession = null
    const event: BrowserWorkspaceFatalInvalidation = {
      databaseName: this.databaseName,
      sessionGeneration: this.generation,
      kind: detail.kind,
      ...(detail.oldVersion === undefined ? {} : { oldVersion: detail.oldVersion }),
      ...(detail.newVersion === undefined ? {} : { newVersion: detail.newVersion }),
    }
    const owner = this.fatalInvalidationOwner
    queueMicrotask(() => {
      if (owner?.active && browserWorkspaceFatalInvalidationOwner === owner) owner.handler(event)
    })
  }
}

export function getBrowserWorkspaceSession(): BrowserWorkspaceSession {
  assertBrowserWorkspaceAdmissionsOpen()
  currentSession ??= new BrowserWorkspaceSessionImpl(getDb())
  return currentSession
}

function getBrowserWorkspaceSessionForBootstrap(
  authority: BrowserWorkspaceBootstrapAuthority,
): BrowserWorkspaceSessionImpl {
  assertBrowserWorkspaceBootstrapAuthority(authority)
  if (!configuredBrowserWorkspaceDatabaseName) {
    throw new Error('BrowserWorkspaceDatabaseSelectionRequired')
  }
  if (!singleton) singleton = new NatterDb(configuredBrowserWorkspaceDatabaseName)
  currentSession ??= new BrowserWorkspaceSessionImpl(singleton)
  currentSession.assertBootstrapCurrent(authority)
  return currentSession
}

export function runBrowserWorkspaceRepositoryOperation<T>(operation: () => T): T {
  return runBrowserWorkspaceLifecycleOperation(operation)
}

function runBrowserWorkspaceLifecycleOperation<T>(operation: () => T): T {
  if (!browserWorkspaceRepositoryAdmissionsOpen) {
    throw new BrowserWorkspaceSessionClosedError()
  }
  if (activeBrowserWorkspaceRepositoryOperations === 0) {
    browserWorkspaceRepositoryIdlePromise = new Promise<void>((resolve) => {
      resolveBrowserWorkspaceRepositoryIdle = resolve
    })
  }
  activeBrowserWorkspaceRepositoryOperations += 1
  try {
    const result = operation()
    if (isPromiseLike(result)) {
      return Promise.resolve(result).finally(finishBrowserWorkspaceRepositoryOperation) as T
    }
    finishBrowserWorkspaceRepositoryOperation()
    return result
  } catch (error) {
    finishBrowserWorkspaceRepositoryOperation()
    throw error
  }
}

export function stopBrowserWorkspaceRepositoryAdmissions(): void {
  browserWorkspaceRepositoryAdmissionsOpen = false
}

export function awaitBrowserWorkspaceRepositoryIdle(): Promise<void> {
  return browserWorkspaceRepositoryIdlePromise
}

export function resumeBrowserWorkspaceRepositoryAdmissions(): void {
  if (activeBrowserWorkspaceRepositoryOperations !== 0) {
    throw new Error('BrowserWorkspaceRepositoryStillActive')
  }
  browserWorkspaceRepositoryAdmissionsOpen = true
}

export function assertBrowserWorkspaceRepositoryAdmissionsClosed(): void {
  if (
    browserWorkspaceRepositoryAdmissionsOpen ||
    activeBrowserWorkspaceRepositoryOperations !== 0
  ) {
    throw new Error('BrowserWorkspaceRepositoryAdmissionsNotClosed')
  }
}

export function assertBrowserWorkspaceSessionAdmissionsClosed(): void {
  if (browserWorkspaceAdmissionsOpen || invalidatedSession) {
    throw new Error('BrowserWorkspaceSessionAdmissionsNotClosed')
  }
}

function finishBrowserWorkspaceRepositoryOperation(): void {
  activeBrowserWorkspaceRepositoryOperations -= 1
  if (activeBrowserWorkspaceRepositoryOperations !== 0) return
  const resolve = resolveBrowserWorkspaceRepositoryIdle
  resolveBrowserWorkspaceRepositoryIdle = null
  resolve?.()
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' && value !== null && 'then' in value) ||
    (typeof value === 'function' && 'then' in value)
  )
}

function isDatabaseClosedError(error: unknown): boolean {
  const pending = [error]
  const seen = new Set<object>()
  for (let index = 0; index < pending.length && index < 16; index += 1) {
    const candidate = pending[index]
    if (
      typeof candidate === 'object' &&
      candidate !== null &&
      'name' in candidate &&
      candidate.name === Dexie.errnames.DatabaseClosed
    ) {
      return true
    }
    if (!candidate || typeof candidate !== 'object' || seen.has(candidate)) continue
    seen.add(candidate)
    const wrapped = candidate as { cause?: unknown; inner?: unknown }
    if (wrapped.cause !== undefined) pending.push(wrapped.cause)
    if (wrapped.inner !== undefined) pending.push(wrapped.inner)
  }
  return false
}

function assertBrowserWorkspaceAdmissionsOpen(): void {
  if (!browserWorkspaceAdmissionsOpen) throw new BrowserWorkspaceSessionClosedError()
}

export function invalidateBrowserWorkspaceSession(): InvalidatedBrowserWorkspaceSession | null {
  browserWorkspaceAdmissionsOpen = false
  if (invalidatedSession) return invalidatedSession

  const session = currentSession ?? (singleton ? new BrowserWorkspaceSessionImpl(singleton) : null)
  currentSession = null
  if (!session) return null
  session.invalidate()
  invalidatedSession = session
  return session
}

export async function closeInvalidatedBrowserWorkspaceSession(
  handle: InvalidatedBrowserWorkspaceSession,
): Promise<void> {
  if (!(handle instanceof BrowserWorkspaceSessionImpl) || invalidatedSession !== handle) {
    throw new Error('InvalidBrowserWorkspaceSessionHandle')
  }
  await handle.waitForIdle()
  handle.closeAfterIdle()
  if (singleton === handle.database) singleton = null
  invalidatedSession = null
}

export function resumeBrowserWorkspaceSessionAdmissions(): void {
  if (invalidatedSession) throw new Error('BrowserWorkspaceSessionShutdownIncomplete')
  browserWorkspaceAdmissionsOpen = true
}

// Explicit open — resolves when the underlying IDBDatabase is ready and the
// schema has settled. Safe to call repeatedly; Dexie caches the open call.
export type OpenDbOptions = BrowserWorkspaceOpenOptions

export async function openDb(options: OpenDbOptions = {}): Promise<NatterDb> {
  return runBrowserWorkspaceRepositoryOperation(() => getBrowserWorkspaceSession().open(options))
}

export async function bootstrapBrowserWorkspace(
  authority: BrowserWorkspaceBootstrapAuthority,
  options: OpenDbOptions = {},
): Promise<{ workspaceId: string; replacementEpoch: number }> {
  const session = getBrowserWorkspaceSessionForBootstrap(authority)
  const db = await session.openForBootstrap(authority, options)
  session.assertBootstrapCurrent(authority)
  options.onProgress?.({
    kind: 'workspace-metadata',
    databaseName: session.databaseName as BrowserWorkspaceDatabaseName,
  })
  const workspace = await readBrowserWorkspaceMeta(db)
  session.assertBootstrapCurrent(authority)
  session.bindWorkspaceFence(authority, workspace)
  seedBroadcastWorkspaceSnapshot(workspace)
  return {
    workspaceId: workspace.workspaceId,
    replacementEpoch: workspace.replacementEpoch,
  }
}

export async function discardBrowserWorkspaceBootstrapSession(
  authority: BrowserWorkspaceBootstrapAuthority,
): Promise<void> {
  assertBrowserWorkspaceBootstrapAuthorityOwned(authority)
  const session = currentSession
  if (!session) return
  session.assertBootstrapOwned(authority)
  await session.waitForIdle()
  session.forceClose()
  currentSession = null
  if (singleton === session.database) singleton = null
}

function configurePreflightBrowserWorkspaceSchema(
  session: BrowserWorkspaceSessionImpl,
  preflight: BrowserWorkspaceSchemaPreflight,
): void {
  if (session.schemaRegistrationConfigured) return
  session.schemaRegistrationConfigured = true
  registerPreflightBrowserWorkspaceSchema(session.database, preflight)
}

function registerPreflightBrowserWorkspaceSchema(
  database: NatterDb,
  preflight: BrowserWorkspaceSchemaPreflight,
): void {
  waveAUpgradePreflights.set(database, {
    compactionControlTransferPrepared: preflight.compactionControlTransferPrepared,
    observedAt: Date.now(),
    ...(preflight.physicalVersion === undefined
      ? {}
      : { physicalVersion: preflight.physicalVersion }),
  })
  const physicalVersion = preflight.physicalVersion
  if (physicalVersion === undefined || physicalVersion < CURRENT_BROWSER_WORKSPACE_NATIVE_VERSION) {
    return
  }
  if (physicalVersion > CURRENT_BROWSER_WORKSPACE_NATIVE_VERSION) {
    throw new BrowserWorkspaceSchemaIntegrityError(`future-version:${physicalVersion}`)
  }
}

export async function prepareBrowserWorkspaceSchema(db: NatterDb): Promise<void> {
  const registeredSchema = registeredBrowserWorkspaceSchema(db)
  const preflight = await preflightBrowserWorkspaceSchema(db, registeredSchema)
  registerPreflightBrowserWorkspaceSchema(db, preflight)
}

async function openSessionDatabase(
  session: BrowserWorkspaceSessionImpl,
  options: OpenDbOptions,
  assertCurrent: () => void,
): Promise<NatterDb> {
  assertCurrent()
  const db = session.database
  const blocked = options.onBlocked
  if (blocked) db.on.blocked.subscribe(blocked)
  try {
    options.onProgress?.({
      kind: 'schema-preflight',
      databaseName: session.databaseName as BrowserWorkspaceDatabaseName,
    })
    session.schemaPreflight ??=
      configuredBrowserWorkspaceDatabaseName === session.databaseName &&
      configuredBrowserWorkspaceCurrentPhysicalVersion !== null
        ? Promise.resolve({
            physicalVersion: configuredBrowserWorkspaceCurrentPhysicalVersion,
            repairStores: Object.freeze([]),
            compactionControlTransferPrepared: false,
          })
        : preflightBrowserWorkspaceSchema(db, session.registeredSchema)
    const preflight = await session.schemaPreflight
    assertCurrent()
    configurePreflightBrowserWorkspaceSchema(session, preflight)
    options.onProgress?.({
      kind: 'database-open',
      databaseName: session.databaseName as BrowserWorkspaceDatabaseName,
      ...(preflight.physicalVersion === undefined
        ? {}
        : { fromVersion: preflight.physicalVersion / 10 }),
      targetVersion: CURRENT_DB_VERSION,
    })
    if (!db.isOpen()) {
      session.beginDatabaseOpen()
      if (options.onProgress) waveAUpgradeProgressPorts.set(db, options.onProgress)
      try {
        await db.open()
      } finally {
        waveAUpgradeProgressPorts.delete(db)
        session.endDatabaseOpen()
      }
    }
    assertCurrent()
    session.verifySchema(preflight)
  } finally {
    if (blocked) db.on.blocked.unsubscribe(blocked)
  }
  return db
}

configureLockDatabaseRunner((operation) => {
  const session = getBrowserWorkspaceSession()
  if (!session.isOpen()) {
    return session.runOperation(async (db) => {
      await session.open()
      return operation(db)
    })
  }
  return session.runOperation((db) => operation(db))
})
configureBroadcastFallbackReader(() =>
  runBrowserWorkspaceLifecycleOperation(async () => {
    const session = getBrowserWorkspaceSession()
    const db = await session.open()
    const { workspaceId, replacementEpoch } = await readBrowserWorkspaceMeta(db)
    return { workspaceId, replacementEpoch }
  }),
)

function __forceCloseDbForTests(
  databaseName: BrowserWorkspaceDatabaseName | null,
  admissionsOpen: boolean,
): void {
  browserWorkspaceAdmissionsOpen = false
  browserWorkspaceRepositoryAdmissionsOpen = false
  const session = invalidatedSession ?? currentSession
  currentSession = null
  invalidatedSession = null
  if (session) session.forceClose()
  else singleton?.close()
  singleton = null
  configuredBrowserWorkspaceDatabaseName = databaseName
  configuredBrowserWorkspaceCurrentPhysicalVersion = null
  browserWorkspaceAdmissionsOpen = admissionsOpen
  browserWorkspaceRepositoryAdmissionsOpen = admissionsOpen
}

// Test-only reset so unit tests can swap in their own jsdom-backed IDB.
export function __resetDbForTests(
  options: { databaseName?: BrowserWorkspaceDatabaseName | null; admissionsOpen?: boolean } = {},
): void {
  __forceCloseDbForTests(
    options.databaseName === undefined ? 'natter' : options.databaseName,
    options.admissionsOpen ?? false,
  )
}

export function __resetBrowserWorkspaceFatalInvalidationOwnerForTests(): void {
  if (!browserWorkspaceFatalInvalidationOwner) return
  browserWorkspaceFatalInvalidationOwner.active = false
  browserWorkspaceFatalInvalidationOwner = null
}

// Mint a uniquely-named Dexie instance for integration tests that want to
// assert migrations or multi-chat concurrency without polluting the singleton.
// Caller is responsible for `await db.delete()` on teardown.
export function createDbForTests(name: string): NatterDb {
  return new NatterDb(name)
}
