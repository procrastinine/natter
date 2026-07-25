import Dexie from 'dexie'
import { registerSchema } from '../../src/store/db'

export const OBSERVED_WAVE_A_PHYSICAL_BOUNDARIES = Object.freeze([
  25, 28, 29, 36, 37, 39, 40, 41, 43, 45, 46, 47, 48, 51, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64,
  65, 68, 69, 70, 71, 72, 73, 74, 75, 76, 87,
] as const)

const POST_V25_STORE_DELTAS = new Map<number, Readonly<Record<string, string | null>>>([
  [
    28,
    {
      streamLeases: '&streamId, &messageId, chatId, ownerClientId, heartbeatAt',
    },
  ],
  [29, { messagePreviews: '&id, chatId' }],
  [
    36,
    {
      attachmentJobs:
        'id, attachmentId, processorId, status, updatedAt, [attachmentId+processorId+inputHash], [processorId+status+nextAttemptAt], [processorId+status+leaseExpiresAt]',
    },
  ],
  [
    37,
    {
      messages:
        'id, chatId, parentId, turnId, [chatId+parentId+siblingIndex+id], [chatId+createdAt+id], [chatId+turnId], [chatId+deleted]',
      streamLeases: '&streamId, &messageId, [chatId+streamId], ownerClientId, heartbeatAt',
    },
  ],
  [39, { providers: null }],
  [
    40,
    {
      chatSidebarRows:
        '&id, title, updatedAt, createdAt, lastViewedAt, lastUpdatedLeafId, lastBranchUpdatedAt, wordCount, totalCostUsd, archived, pinned, folderId, *tags',
      messages:
        'id, chatId, parentId, turnId, [chatId+treeParentKey+siblingIndex+id], [chatId+treeParentKey+treeLive+siblingIndex+id], [chatId+treeParentKey+treeLive+subtreeLeafCreatedAt+subtreeLeafId], [chatId+createdAt+id], [chatId+turnId], [chatId+deleted]',
      attachmentRefEdges:
        '&[ownerKind+ownerId+refId], attachmentId, [attachmentId+ownerKind], [attachmentId+chatId], [ownerKind+ownerId], chatId',
      generations: null,
      presetResolutions: null,
    },
  ],
  [
    41,
    {
      attachments:
        'id, contentHash, kind, mime, origin, refCount, createdAt, updatedAt, deletedAt, [refCount+createdAt]',
      configurationLinks: '&id, ownerKey, targetKey',
    },
  ],
  [
    43,
    {
      chatSidebarRows:
        '&id, title, updatedAt, createdAt, lastViewedAt, lastUpdatedLeafId, lastBranchUpdatedAt, wordCount, totalCostUsd, archivedKey, pinnedKey, folderKey, *tags, [updatedAt+id], [createdAt+id], [lastViewedAt+id], [folderKey+archivedKey]',
      attachmentCatalogRows:
        '&id, kind, mime, origin, storageKind, refCount, createdAt, updatedAt, sizeBytes, lastUsedAt, deletedKey, [createdAt+id], [updatedAt+id], [sizeBytes+id]',
    },
  ],
  [
    45,
    {
      messages:
        'id, chatId, parentId, turnId, [chatId+treeParentKey+siblingIndex+id], [chatId+treeParentKey+treeLive+siblingIndex+id], [chatId+createdAt+id], [chatId+turnId], [chatId+deleted]',
      childLists: 'id, [chatId+parentId], updatedAt',
      childSlotMembers: '&id, parentKey, [chatId+parentKey+position]',
      chatSidebarRows:
        '&id, title, titleSortKey, updatedAt, createdAt, lastViewedAt, lastUpdatedLeafId, lastBranchUpdatedAt, wordCount, totalCostUsd, archivedKey, pinnedKey, visibleKey, folderKey, *tags, [updatedAt+id], [createdAt+id], [lastViewedAt+id], [totalCostUsd+id], [wordCount+id], [folderKey+archivedKey], [visibleKey+pinnedKey+updatedAt+id], [visibleKey+pinnedKey+createdAt+id], [visibleKey+pinnedKey+lastViewedAt+id], [visibleKey+pinnedKey+totalCostUsd+id], [visibleKey+pinnedKey+wordCount+id], [folderKey+visibleKey+pinnedKey+updatedAt+id], [folderKey+visibleKey+pinnedKey+createdAt+id], [folderKey+visibleKey+pinnedKey+lastViewedAt+id], [folderKey+visibleKey+pinnedKey+totalCostUsd+id], [folderKey+visibleKey+pinnedKey+wordCount+id], [archivedKey+updatedAt+id], [archivedKey+createdAt+id], [archivedKey+lastViewedAt+id], [archivedKey+totalCostUsd+id], [archivedKey+wordCount+id]',
      attachmentCatalogRows:
        '&id, kind, mime, origin, storageKind, refCount, createdAt, updatedAt, sizeBytes, lastUsedAt, deletedKey, [createdAt+id], [updatedAt+id], [sizeBytes+id], [origin+sizeBytes+id], [storageKind+sizeBytes+id], [kind+sizeBytes+id], [refCount+sizeBytes+id]',
      attachmentCatalogAggregate: '&id',
    },
  ],
  [
    46,
    {
      configurationProfileCatalogRows: '&id, archived, lastUsedAt',
      configurationPresetCatalogRows:
        '&id, archived, sortIndex, connectionProfileId, [sortIndex+createdAt+id]',
      configurationPromptPresetCatalogRows: '&id, kind, lastUsedAt, [kind+lastUsedAt+id]',
    },
  ],
  [47, { chatSidebarAggregates: '&id, kind' }],
  [
    48,
    {
      chatSidebarRows:
        '&id, title, titleSortKey, updatedAt, createdAt, lastViewedAt, lastUpdatedLeafId, lastBranchUpdatedAt, wordCount, totalCostUsd, archivedKey, pinnedKey, visibleKey, folderKey, *tags, [updatedAt+id], [createdAt+id], [lastViewedAt+id], [totalCostUsd+id], [wordCount+id], [folderKey+archivedKey], [visibleKey+pinnedKey+updatedAt+id], [visibleKey+pinnedKey+createdAt+id], [visibleKey+pinnedKey+lastViewedAt+id], [visibleKey+pinnedKey+totalCostUsd+id], [visibleKey+pinnedKey+wordCount+id], [folderKey+visibleKey+pinnedKey+updatedAt+id], [folderKey+visibleKey+pinnedKey+createdAt+id], [folderKey+visibleKey+pinnedKey+lastViewedAt+id], [folderKey+visibleKey+pinnedKey+totalCostUsd+id], [folderKey+visibleKey+pinnedKey+wordCount+id], [folderKey+visibleKey+pinnedKey+titleSortKey+id], [archivedKey+updatedAt+id], [archivedKey+createdAt+id], [archivedKey+lastViewedAt+id], [archivedKey+totalCostUsd+id], [archivedKey+wordCount+id]',
      chatSidebarAggregates: '&id, kind',
    },
  ],
  [
    51,
    {
      models: '&[profileId+queryKey], profileId, fetchedAt, [profileId+fetchedAt], payloadId',
      endpoints: '&[profileId+modelId], profileId, fetchedAt, [profileId+fetchedAt], payloadId',
      privacyPolicies:
        '&[profileId+modelId], profileId, fetchedAt, [profileId+fetchedAt], payloadId',
      discoveryPayloads: '&id, byteLength',
    },
  ],
  [
    55,
    {
      chatBranchCache: null,
      streamLeases: '&streamId, &messageId, [chatId+streamId]',
      streamChunks: '&id, streamId, chatId, [streamId+seq]',
    },
  ],
  [
    56,
    {
      attachments:
        'id, contentHash, kind, mime, origin, refCount, createdAt, updatedAt, deletedAt, [refCount+createdAt], [refCount+createdAt+id]',
    },
  ],
  [
    57,
    {
      chats:
        'id, updatedAt, createdAt, lastViewedAt, lastUpdatedLeafId, lastBranchUpdatedAt, wordCount, totalCostUsd, archived, pinned, presetId, folderId, *tags, [archivedKey+id]',
      attachments:
        'id, contentHash, kind, mime, origin, refCount, createdAt, updatedAt, deletedAt, [refCount+createdAt], [refCount+createdAt+id]',
    },
  ],
  [
    58,
    {
      chats:
        'id, updatedAt, createdAt, lastViewedAt, lastUpdatedLeafId, lastBranchUpdatedAt, wordCount, totalCostUsd, archived, pinned, presetId, folderId, *tags, [archivedKey+id], [temporaryKey+id]',
    },
  ],
  [
    59,
    {
      discoveryPayloadMetadata: '&id, referenceCount, lastReferencedAt, byteLength',
      discoveryCacheState: '&id',
    },
  ],
  [60, { attachmentIntegrityState: '&id' }],
  [61, { textTemplates: '&id, [createdAt+id+name+updatedAt]' }],
  [
    62,
    {
      attachments:
        'id, contentHash, kind, mime, origin, refCount, createdAt, updatedAt, deletedAt, [refCount+unreferencedAt+id]',
    },
  ],
  [
    63,
    {
      streamLeases: '&streamId, &messageId, [chatId+streamId], [canonicalAt+streamId]',
    },
  ],
  [
    64,
    {
      chats:
        'id, updatedAt, createdAt, lastViewedAt, lastUpdatedLeafId, lastBranchUpdatedAt, wordCount, totalCostUsd, archived, pinned, presetId, folderId, *tags, [archivedKey+id], [temporaryKey+temporaryRetentionAt+id]',
    },
  ],
  [
    65,
    {
      chatSidebarRows:
        '&id, title, titleSortKey, updatedAt, createdAt, lastViewedAt, lastUpdatedLeafId, lastBranchUpdatedAt, wordCount, totalCostUsd, archivedKey, pinnedKey, visibleKey, folderKey, *tags, [updatedAt+id], [createdAt+id], [lastViewedAt+id], [totalCostUsd+id], [wordCount+id], [folderKey+archivedKey], [visibleKey+pinnedKey+updatedAt+id], [visibleKey+pinnedKey+createdAt+id], [visibleKey+pinnedKey+lastViewedAt+id], [visibleKey+pinnedKey+totalCostUsd+id], [visibleKey+pinnedKey+wordCount+id], [visibleKey+pinnedKey+titleSortKey+id], [visibleKey+pinnedKey+updatedAt+titleSortKey+id], [visibleKey+pinnedKey+createdAt+titleSortKey+id], [visibleKey+pinnedKey+lastViewedAt+titleSortKey+id], [visibleKey+pinnedKey+totalCostUsd+titleSortKey+id], [visibleKey+pinnedKey+wordCount+titleSortKey+id], [folderKey+visibleKey+pinnedKey+updatedAt+id], [folderKey+visibleKey+pinnedKey+createdAt+id], [folderKey+visibleKey+pinnedKey+lastViewedAt+id], [folderKey+visibleKey+pinnedKey+totalCostUsd+id], [folderKey+visibleKey+pinnedKey+wordCount+id], [folderKey+visibleKey+pinnedKey+titleSortKey+id], [folderKey+visibleKey+pinnedKey+updatedAt+titleSortKey+id], [folderKey+visibleKey+pinnedKey+createdAt+titleSortKey+id], [folderKey+visibleKey+pinnedKey+lastViewedAt+titleSortKey+id], [folderKey+visibleKey+pinnedKey+totalCostUsd+titleSortKey+id], [folderKey+visibleKey+pinnedKey+wordCount+titleSortKey+id], [archivedKey+updatedAt+id], [archivedKey+createdAt+id], [archivedKey+lastViewedAt+id], [archivedKey+totalCostUsd+id], [archivedKey+wordCount+id]',
    },
  ],
  [68, { workspaceFence: '&id' }],
  [
    69,
    {
      configurationCatalogAggregates: '&id',
      configurationProfileCatalogRows:
        '&id, archived, activeKey, lastUsedAt, [activeKey+mruSortKey+nameSortKey+id]',
      configurationPresetCatalogRows:
        '&id, archived, activeKey, sortIndex, connectionProfileId, [activeKey+defaultTier+defaultTime+id], [connectionProfileId+activeKey+defaultTier+defaultTime+id], [activeKey+sortIndex+createdAt+id], [connectionProfileId+activeKey+sortIndex+createdAt+id]',
      configurationPromptPresetCatalogRows:
        '&id, kind, lastUsedAt, [kind+lastUsedAt+id], [kind+nameSortKey+id]',
    },
  ],
  [
    70,
    {
      presetOrderState: '&id',
      presetOrderBlocks: '&id, tier',
      presetOrderMembership: '&presetId, blockId, tier',
    },
  ],
  [
    71,
    {
      presetOrderState: '&id',
      presetOrderBlocks: '&id',
      presetOrderMembership: '&presetId, blockId',
    },
  ],
  [
    72,
    {
      presets:
        '&id, name, connectionProfileId, sortIndex, lastUsedAt, archived, [sortIndex+createdAt+id]',
      configurationPresetCatalogRows:
        '&id, archived, activeKey, connectionProfileId, [activeKey+defaultTier+defaultTime+id], [connectionProfileId+activeKey+defaultTier+defaultTime+id]',
    },
  ],
  [73, { presets: '&id' }],
  [
    74,
    {
      configurationProfileCatalogRows:
        '&id, archived, activeKey, managerTier, lastUsedAt, [activeKey+mruSortKey+nameSortKey+id], [managerTier+nameSortKey+id]',
      configurationProfileUsageRows: '&id',
    },
  ],
  [75, { storageMaintenanceState: '&id' }],
  [
    76,
    {
      storageMaintenanceState: null,
      storageRetentionState: '&task',
    },
  ],
  [
    87,
    {
      streamLeases: '&streamId, &targetOwnerKey, [chatId+streamId], [terminalRetentionAt+streamId]',
    },
  ],
])

let blueprintSequence = 0
let observedV25StoreSpec: Readonly<Record<string, string>> | undefined
const observedStoreSpecs = new Map<number, Readonly<Record<string, string>>>()

export function observedWaveAStorageCohorts(): readonly Readonly<{
  firstVersion: number
  lastVersion: number
}>[] {
  return OBSERVED_WAVE_A_PHYSICAL_BOUNDARIES.map((firstVersion, index) => {
    const nextVersion = OBSERVED_WAVE_A_PHYSICAL_BOUNDARIES[index + 1]
    return {
      firstVersion,
      lastVersion: nextVersion === undefined ? 93 : nextVersion - 1,
    }
  })
}

export function observedWaveAStoreSpec(version: number): Readonly<Record<string, string>> {
  if (!Number.isInteger(version) || version < 25 || version > 93) {
    throw new Error(`ObservedWaveAStorageVersionInvalid:${version}`)
  }
  const cached = observedStoreSpecs.get(version)
  if (cached) return cached

  const stores: Record<string, string> = { ...waveAV25StoreSpec() }
  for (const [boundary, delta] of POST_V25_STORE_DELTAS) {
    if (boundary > version) break
    for (const [tableName, source] of Object.entries(delta)) {
      if (source === null) delete stores[tableName]
      else stores[tableName] = normalizeDexieStoreSource(source)
    }
  }
  const result = Object.freeze(stores)
  observedStoreSpecs.set(version, result)
  return result
}

function waveAV25StoreSpec(): Readonly<Record<string, string>> {
  if (observedV25StoreSpec) return observedV25StoreSpec
  const blueprint = new Dexie(`wave-a-observed-blueprint:v25:${blueprintSequence++}`)
  registerSchemaThroughV25(blueprint)
  const stores = Object.fromEntries(
    blueprint.tables.map((table) => [
      table.name,
      [table.schema.primKey.src, ...table.schema.indexes.map((index) => index.src)].join(', '),
    ]),
  )
  blueprint.close()
  observedV25StoreSpec = Object.freeze(stores)
  return observedV25StoreSpec
}

function normalizeDexieStoreSource(source: string): string {
  return source.startsWith('&') ? source.slice(1) : source
}

function registerSchemaThroughV25(db: Dexie): void {
  const cutoff = new Error('v26-test-cutoff')
  const facade = new Proxy(db, {
    get(target, property, receiver) {
      if (property === 'version') {
        return (version: number) => {
          if (version > 25) throw cutoff
          return target.version(version)
        }
      }
      const value: unknown = Reflect.get(target, property, receiver)
      return typeof value === 'function'
        ? (...args: unknown[]): unknown => Reflect.apply(value, target, args) as unknown
        : value
    },
  })
  try {
    registerSchema(facade)
  } catch (error) {
    if (error !== cutoff) throw error
  }
  if (db.verno !== 25) throw new Error('ObservedWaveAV25RegistrationFailed')
}
