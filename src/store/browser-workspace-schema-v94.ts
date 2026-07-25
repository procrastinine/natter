import type { SettingsRow } from './db-rows'

// v94 and the derived-repair v94.1 were opened by intermediate Wave-A builds.
// The final cutover is therefore monotonic v95 while this frozen manifest remains
// the decoder input/output contract for every observed v25-v94.1 shape.
export const WAVE_A_STORAGE_VERSION = 95

export const WAVE_A_V94_STORES = Object.freeze({
  attachmentArtifacts: 'artifactId, attachmentId, kind, processorId, createdAt',
  attachmentBlobs: 'id, attachmentId, role, contentHash, createdAt',
  attachmentCatalogAggregate: '&id',
  attachmentCatalogRows:
    '&id, kind, mime, origin, storageKind, refCount, createdAt, updatedAt, sizeBytes, lastUsedAt, deletedKey, [createdAt+id], [updatedAt+id], [sizeBytes+id], [origin+sizeBytes+id], [storageKind+sizeBytes+id], [kind+sizeBytes+id], [refCount+sizeBytes+id]',
  attachmentIntegrityState: '&id',
  attachmentJobs:
    'id, attachmentId, processorId, status, updatedAt, [attachmentId+processorId+inputHash], [processorId+status+nextAttemptAt], [processorId+status+leaseExpiresAt]',
  attachmentRefEdges:
    '&[ownerKind+ownerId+refId], attachmentId, [attachmentId+ownerKind], [attachmentId+chatId], [ownerKind+ownerId], chatId',
  attachments:
    'id, contentHash, kind, mime, origin, refCount, createdAt, updatedAt, deletedAt, [refCount+unreferencedAt+id]',
  browserLocks: '&name',
  chatSidebarAggregates: '&id, kind',
  chatSidebarRows:
    '&id, title, titleSortKey, updatedAt, createdAt, lastViewedAt, lastUpdatedLeafId, lastBranchUpdatedAt, wordCount, totalCostUsd, archivedKey, pinnedKey, visibleKey, folderKey, *tags, [titleSortKey+id], [updatedAt+titleSortKey+id], [createdAt+titleSortKey+id], [lastViewedAt+titleSortKey+id], [totalCostUsd+titleSortKey+id], [wordCount+titleSortKey+id], [folderKey+archivedKey], [visibleKey+pinnedKey+titleSortKey+id], [visibleKey+pinnedKey+updatedAt+titleSortKey+id], [visibleKey+pinnedKey+createdAt+titleSortKey+id], [visibleKey+pinnedKey+lastViewedAt+titleSortKey+id], [visibleKey+pinnedKey+totalCostUsd+titleSortKey+id], [visibleKey+pinnedKey+wordCount+titleSortKey+id], [folderKey+visibleKey+pinnedKey+titleSortKey+id], [folderKey+visibleKey+pinnedKey+updatedAt+titleSortKey+id], [folderKey+visibleKey+pinnedKey+createdAt+titleSortKey+id], [folderKey+visibleKey+pinnedKey+lastViewedAt+titleSortKey+id], [folderKey+visibleKey+pinnedKey+totalCostUsd+titleSortKey+id], [folderKey+visibleKey+pinnedKey+wordCount+titleSortKey+id], [archivedKey+titleSortKey+id], [archivedKey+updatedAt+titleSortKey+id], [archivedKey+createdAt+titleSortKey+id], [archivedKey+lastViewedAt+titleSortKey+id], [archivedKey+totalCostUsd+titleSortKey+id], [archivedKey+wordCount+titleSortKey+id]',
  chats:
    'id, updatedAt, createdAt, lastViewedAt, lastUpdatedLeafId, lastBranchUpdatedAt, wordCount, totalCostUsd, archived, pinned, presetId, folderId, *tags, [archivedKey+id], [temporaryKey+temporaryRetentionAt+id]',
  childLists: 'id, [chatId+parentId], updatedAt',
  childSlotMembers: '&id, parentKey, [chatId+parentKey+position]',
  configurationCatalogAggregates: '&id',
  configurationLinks: '&id, ownerKey, targetKey',
  configurationPresetCatalogRows:
    '&id, archived, activeKey, connectionProfileId, [activeKey+defaultTier+defaultTime+id], [connectionProfileId+activeKey+defaultTier+defaultTime+id]',
  configurationProfileCatalogRows:
    '&id, archived, activeKey, managerTier, lastUsedAt, [activeKey+mruSortKey+nameSortKey+id], [managerTier+nameSortKey+id]',
  configurationProfileUsageRows: '&id',
  configurationPromptPresetCatalogRows:
    '&id, kind, lastUsedAt, [kind+lastUsedAt+id], [kind+nameSortKey+id]',
  discoveryCacheState: '&id',
  discoveryPayloadMetadata: '&id, referenceCount, lastReferencedAt, byteLength',
  discoveryPayloads: '&id, byteLength',
  drafts: '&chatId, updatedAt',
  endpoints: '&[profileId+modelId], profileId, fetchedAt, [profileId+fetchedAt], payloadId',
  folders: 'id, name, sortIndex, lastUsedAt',
  keys: 'id, name',
  messageBodies: '&id, chatId, updatedAt, bodyVersion',
  messagePreviews: '&id, chatId',
  messages:
    'id, chatId, parentId, turnId, [chatId+treeParentKey+siblingIndex+id], [chatId+treeParentKey+treeLive+siblingIndex+id], [chatId+createdAt+id], [chatId+turnId], [chatId+deleted]',
  models: '&[profileId+queryKey], profileId, fetchedAt, [profileId+fetchedAt], payloadId',
  presetOrderBlocks: '&id',
  presetOrderMembership: '&presetId, blockId',
  presetOrderState: '&id',
  presets: '&id',
  privacyPolicies: '&[profileId+modelId], profileId, fetchedAt, [profileId+fetchedAt], payloadId',
  profiles: 'id, name, kind, lastUsedAt, archived',
  promptPresets: 'id, kind, name, lastUsedAt',
  settings: '&key',
  storageRetentionState: '&task',
  streamChunks: '&id, streamId, chatId, [streamId+seq]',
  streamLeases: '&streamId, &targetOwnerKey, [chatId+streamId], [terminalRetentionAt+streamId]',
  tags: 'id, &nameLower, lastUsedAt',
  textTemplates: '&id, [createdAt+id+name+updatedAt]',
  workspaceFence: '&id',
  chatBranchCache: null,
  generations: null,
  presetResolutions: null,
  providers: null,
  storageMaintenanceState: null,
} as const satisfies Readonly<Record<string, string | null>>)

export function waveACompletionSettingsV94(): readonly SettingsRow[] {
  return [
    { key: 'backfill:attachment-refs-v1', value: 1 },
    { key: 'backfill:attachment-refs-canonical-v2', value: 1 },
    { key: 'backfill:message-body-split-v1', value: 1 },
    { key: 'backfill:organization-fields-v1', value: 1 },
    { key: 'backfill:chat-preview-projection-v1', value: 1 },
    { key: 'backfill:global-settings-v1', value: 1 },
    { key: 'backfill:pinned-model-default-v2', value: 1 },
    { key: 'backfill:recent-model-recency-v1', value: 1 },
    { key: 'backfill:provider-output-items-v1', value: 4 },
    { key: 'backfill:provider-tool-settings-v2', value: 1 },
    { key: 'backfill:token-calibration-global-v1', value: 1 },
    { key: 'backfill:token-calibration-canonicalize-v1', value: 1 },
    {
      key: 'backfill:stream-journal-integrity-v1',
      value: { version: 1, phase: 'complete' },
    },
    { key: 'backfill:stream-journal-frames-v83', value: true },
    { key: 'backfill:storage-compaction-control-v1', value: true },
    { key: 'backfill:chat-sidebar-aggregate-v1', value: 5 },
  ]
}
