const TABLE_GAPS = Object.freeze(['logical-debt-does-not-measure-physical-amplification'])

const TABLE_TESTS = Object.freeze(['tests/unit/byte-owner-boundary.test.ts'])

const BASE_STORAGE_TABLE_OWNERSHIP = Object.freeze([
  table('attachmentArtifacts', 'canonical', 'authoritative', 'filtered-copy', 'attachment-domain', {
    ownerPath: 'src/store/attachment-storage.ts',
    sizeDriver: 'Extracted text, generated thumbnails, and processor artifacts per attachment.',
    debtPolicy: 'typed-owner-port',
    retention: 'age-based-retention',
    rebuild: 'authoritative',
    interchange: 'portable-attachment-bundle',
    normalReclamation:
      'Explicit attachment deletion and the 24-hour orphan-attachment reaper delete artifact rows; obsolete pages depend on compaction.',
    multiTab: 'workspace-write-lock-changefeed',
    tests: ['tests/unit/attachment-integrity-maintenance.test.ts'],
  }),
  table('attachmentBlobs', 'canonical', 'authoritative', 'filtered-copy', 'attachment-domain', {
    ownerPath: 'src/store/attachment-storage.ts',
    sizeDriver:
      'Original and derived binary attachment payload bytes; this can dominate live storage.',
    debtPolicy: 'typed-owner-port',
    retention: 'age-based-retention',
    rebuild: 'authoritative',
    interchange: 'portable-attachment-bundle',
    normalReclamation:
      'Explicit attachment deletion and the 24-hour orphan-attachment reaper delete blobs; obsolete backing-store pages depend on compaction.',
    multiTab: 'workspace-write-lock-changefeed',
    tests: ['tests/unit/attachments.test.ts'],
  }),
  table('attachmentCatalogAggregate', 'repairable', 'derived', 'copy', 'attachment-domain', {
    ownerPath: 'src/store/attachment-catalog-projection.ts',
    sizeDriver: 'One aggregate row containing attachment catalog counts and summary state.',
    debtPolicy: 'typed-owner-port',
    retention: 'rebuild-on-repair',
    rebuild: 'derived-from-authoritative',
    interchange: 'rebuilt-on-import',
    normalReclamation:
      'Rows are replaced during catalog maintenance and workspace restore; old physical versions require compaction.',
    multiTab: 'workspace-write-lock-changefeed',
    tests: ['tests/unit/attachment-integrity-maintenance.test.ts'],
  }),
  table('attachmentCatalogRows', 'repairable', 'derived', 'copy', 'attachment-domain', {
    ownerPath: 'src/store/attachment-catalog-projection.ts',
    sizeDriver: 'One projected metadata/search row per attachment.',
    debtPolicy: 'typed-owner-port',
    retention: 'rebuild-on-repair',
    rebuild: 'derived-from-authoritative',
    interchange: 'rebuilt-on-import',
    normalReclamation:
      'Projection repair and attachment deletion remove rows; old physical versions require compaction.',
    multiTab: 'workspace-write-lock-changefeed',
    tests: ['tests/unit/attachment-integrity-maintenance.test.ts'],
  }),
  table('attachmentIntegrityState', 'repairable', 'derived', 'seed', 'attachment-domain', {
    ownerPath: 'src/store/attachment-integrity-maintenance.ts',
    sizeDriver: 'A bounded singleton repair cursor and integrity phase.',
    debtPolicy: 'typed-owner-port',
    retention: 'rebuild-on-repair',
    rebuild: 'journal-recovery',
    interchange: 'reset-on-import',
    normalReclamation:
      'The singleton is overwritten as repair advances and reset after restore; obsolete versions require compaction.',
    multiTab: 'workspace-write-lock-changefeed',
    tests: ['tests/unit/attachment-integrity-maintenance.test.ts'],
  }),
  table('attachmentJobs', 'canonical', 'journal', 'filtered-copy', 'attachment-domain', {
    ownerPath: 'src/store/attachment-storage.ts',
    sizeDriver: 'Persisted processing jobs, status, and bounded diagnostic fields per attachment.',
    debtPolicy: 'typed-owner-port',
    retention: 'age-based-retention',
    rebuild: 'journal-recovery',
    interchange: 'portable-attachment-bundle',
    normalReclamation:
      'Job completion/deletion and orphan-attachment reaping remove rows; obsolete versions require compaction.',
    multiTab: 'workspace-write-lock-changefeed',
    tests: ['tests/unit/attachments.test.ts'],
  }),
  table('attachmentRefEdges', 'repairable', 'derived', 'copy', 'attachment-domain', {
    ownerPath: 'src/store/attachment-reference-edges.ts',
    sizeDriver: 'One edge for each message, draft, or chat owner reference to an attachment.',
    debtPolicy: 'typed-owner-port',
    retention: 'rebuild-on-repair',
    rebuild: 'derived-from-authoritative',
    interchange: 'rebuilt-on-import',
    normalReclamation:
      'Owner mutation, chat deletion, and integrity repair remove stale edges; obsolete pages require compaction.',
    multiTab: 'workspace-write-lock-changefeed',
    tests: ['tests/unit/attachment-integrity-maintenance.test.ts'],
  }),
  table('attachments', 'canonical', 'authoritative', 'copy', 'attachment-domain', {
    ownerPath: 'src/store/attachment-storage.ts',
    sizeDriver:
      'One attachment header per stored attachment, including reference and projection metadata.',
    debtPolicy: 'typed-owner-port',
    retention: 'age-based-retention',
    rebuild: 'authoritative',
    interchange: 'portable-attachment-bundle',
    normalReclamation:
      'Explicit deletion and the 24-hour unreferenced-attachment reaper remove headers and owned payload rows.',
    multiTab: 'workspace-write-lock-changefeed',
    tests: ['tests/unit/attachment-integrity-maintenance.test.ts'],
  }),
  table('browserLocks', 'repairable', 'ephemeral', 'seed', 'coordination-domain', {
    ownerPath: 'src/store/locks.ts',
    sizeDriver: 'Bounded fallback lease rows for concurrently named coordination resources.',
    debtPolicy: 'ephemeral-no-debt',
    retention: 'lease-expiry',
    rebuild: 'ephemeral-recreate',
    interchange: 'omitted-from-import',
    normalReclamation:
      'Expired lease rows are coordination state; workspace replacement seeds an empty destination instead of copying source leases.',
    multiTab: 'coordination-lock',
    tests: ['tests/unit/locks.test.ts'],
    gaps: [],
  }),
  table('chatSidebarAggregates', 'repairable', 'derived', 'copy', 'catalog-domain', {
    ownerPath: 'src/store/chat-sidebar-projection.ts',
    sizeDriver: 'Aggregate rows for sidebar folder, archive, and catalog group counts.',
    debtPolicy: 'typed-owner-port',
    retention: 'rebuild-on-repair',
    rebuild: 'derived-from-authoritative',
    interchange: 'rebuilt-on-import',
    normalReclamation:
      'Projection mutations and repair replace aggregate rows; obsolete pages require compaction.',
    multiTab: 'workspace-write-lock-changefeed',
    tests: ['tests/unit/chat-sidebar-rows.test.ts'],
  }),
  table('chatSidebarRows', 'repairable', 'derived', 'copy', 'catalog-domain', {
    ownerPath: 'src/store/chat-sidebar-projection.ts',
    sizeDriver: 'One bounded title/status/preview projection per chat.',
    debtPolicy: 'typed-owner-port',
    retention: 'rebuild-on-repair',
    rebuild: 'derived-from-authoritative',
    interchange: 'rebuilt-on-import',
    normalReclamation:
      'Chat deletion and projection repair remove rows; obsolete versions require compaction.',
    multiTab: 'workspace-write-lock-changefeed',
    tests: ['tests/unit/chat-sidebar-rows.test.ts'],
  }),
  table('chats', 'canonical', 'authoritative', 'copy', 'conversation-domain', {
    ownerPath: 'src/store/chat-storage-ownership.ts',
    sizeDriver: 'One chat metadata/settings row per chat, including token calibration summaries.',
    debtPolicy: 'typed-owner-port',
    retention: 'explicit-owner-delete',
    rebuild: 'authoritative',
    interchange: 'portable-workspace-table',
    normalReclamation:
      'Explicit chat deletion removes the full chat closure; stale empty draft chats are pruned after 24 hours.',
    multiTab: 'workspace-write-lock-changefeed',
    tests: ['tests/unit/chat-lifecycle-atomicity.test.ts'],
  }),
  table('childLists', 'repairable', 'derived', 'copy', 'conversation-domain', {
    ownerPath: 'src/store/child-list-projection.ts',
    sizeDriver: 'One structural child-list state row per live or tombstoned branch parent.',
    debtPolicy: 'typed-owner-port',
    retention: 'rebuild-on-repair',
    rebuild: 'derived-from-authoritative',
    interchange: 'rebuilt-on-import',
    normalReclamation:
      'Structural operations and chat deletion remove rows; import and migrations rebuild them from message topology.',
    multiTab: 'workspace-write-lock-changefeed',
    tests: ['tests/unit/messages.test.ts'],
  }),
  table('childSlotMembers', 'repairable', 'derived', 'copy', 'conversation-domain', {
    ownerPath: 'src/store/child-list-projection.ts',
    sizeDriver: 'One ordered structural member row per message child slot.',
    debtPolicy: 'typed-owner-port',
    retention: 'rebuild-on-repair',
    rebuild: 'derived-from-authoritative',
    interchange: 'rebuilt-on-import',
    normalReclamation:
      'Structural operations and chat deletion remove rows; import and migrations rebuild them from headers.',
    multiTab: 'workspace-write-lock-changefeed',
    tests: ['tests/unit/messages.test.ts'],
  }),
  table('configurationLinks', 'repairable', 'derived', 'copy', 'configuration-domain', {
    ownerPath: 'src/store/configuration-domain-contract.ts',
    sizeDriver: 'Indexes from chats, profiles, and presets to referenced configuration targets.',
    debtPolicy: 'typed-owner-port',
    retention: 'rebuild-on-repair',
    rebuild: 'derived-from-authoritative',
    interchange: 'rebuilt-on-import',
    normalReclamation:
      'Configuration owner writes/deletes replace links; workspace restore rebuilds all links.',
    multiTab: 'workspace-write-lock-changefeed',
    tests: ['tests/unit/configuration-command-planning.test.ts'],
  }),
  table('configurationCatalogAggregates', 'repairable', 'derived', 'copy', 'configuration-domain', {
    ownerPath: 'src/store/configuration-catalog-projection.ts',
    sizeDriver: 'Bounded singleton rows containing configuration catalog counts and revisions.',
    debtPolicy: 'typed-owner-port',
    retention: 'rebuild-on-repair',
    rebuild: 'derived-from-authoritative',
    interchange: 'rebuilt-on-import',
    normalReclamation:
      'Configuration mutations replace aggregate rows and restore rebuilds them from authoritative configuration tables.',
    multiTab: 'workspace-write-lock-changefeed',
    tests: ['tests/unit/configuration-command-planning.test.ts'],
  }),
  table('configurationPresetCatalogRows', 'repairable', 'derived', 'copy', 'configuration-domain', {
    ownerPath: 'src/store/configuration-catalog-projection.ts',
    sizeDriver: 'One bounded catalog projection row per chat preset.',
    debtPolicy: 'typed-owner-port',
    retention: 'rebuild-on-repair',
    rebuild: 'derived-from-authoritative',
    interchange: 'rebuilt-on-import',
    normalReclamation:
      'Preset writes/deletes maintain rows and restore rebuilds them from authoritative presets.',
    multiTab: 'workspace-write-lock-changefeed',
    tests: ['tests/unit/configuration-command-planning.test.ts'],
  }),
  table(
    'configurationProfileCatalogRows',
    'repairable',
    'derived',
    'copy',
    'configuration-domain',
    {
      ownerPath: 'src/store/configuration-catalog-projection.ts',
      sizeDriver: 'One bounded catalog projection row per connection profile.',
      debtPolicy: 'typed-owner-port',
      retention: 'rebuild-on-repair',
      rebuild: 'derived-from-authoritative',
      interchange: 'rebuilt-on-import',
      normalReclamation:
        'Profile writes/deletes maintain rows and restore rebuilds them from authoritative profiles.',
      multiTab: 'workspace-write-lock-changefeed',
      tests: ['tests/unit/configuration-command-planning.test.ts'],
    },
  ),
  table('configurationProfileUsageRows', 'repairable', 'derived', 'copy', 'configuration-domain', {
    ownerPath: 'src/store/configuration-profile-usage-projection.ts',
    sizeDriver: 'One usage-count projection per connection profile referenced by presets or chats.',
    debtPolicy: 'typed-owner-port',
    retention: 'rebuild-on-repair',
    rebuild: 'derived-from-authoritative',
    interchange: 'rebuilt-on-import',
    normalReclamation:
      'Profile, preset, and chat mutations maintain usage rows; restore rebuilds them from authoritative references.',
    multiTab: 'workspace-write-lock-changefeed',
    tests: ['tests/unit/configuration-command-planning.test.ts'],
  }),
  table(
    'configurationPromptPresetCatalogRows',
    'repairable',
    'derived',
    'copy',
    'configuration-domain',
    {
      ownerPath: 'src/store/configuration-catalog-projection.ts',
      sizeDriver: 'One bounded catalog projection row per prompt preset.',
      debtPolicy: 'typed-owner-port',
      retention: 'rebuild-on-repair',
      rebuild: 'derived-from-authoritative',
      interchange: 'rebuilt-on-import',
      normalReclamation:
        'Prompt-preset writes/deletes maintain rows and restore rebuilds them from authoritative presets.',
      multiTab: 'workspace-write-lock-changefeed',
      tests: ['tests/unit/configuration-command-planning.test.ts'],
    },
  ),
  table('discoveryCacheState', 'repairable', 'cache', 'seed', 'discovery-cache-domain', {
    ownerPath: 'src/store/discovery-cache-storage.ts',
    sizeDriver: 'A bounded singleton containing cache totals and a repair cursor.',
    debtPolicy: 'specialized-cache-port',
    retention: 'bounded-cache',
    rebuild: 'cache-refetch',
    interchange: 'reset-on-import',
    normalReclamation:
      'Cache maintenance repairs or resets the singleton; workspace restore starts it empty.',
    multiTab: 'workspace-write-lock-changefeed',
    tests: ['tests/unit/cache-stores.test.ts'],
  }),
  table('discoveryPayloadMetadata', 'repairable', 'cache', 'drop', 'discovery-cache-domain', {
    ownerPath: 'src/store/discovery-cache-storage.ts',
    sizeDriver: 'One deduplication/reference-count row per unique cached JSON payload.',
    debtPolicy: 'specialized-cache-port',
    retention: 'bounded-cache',
    rebuild: 'cache-refetch',
    interchange: 'omitted-from-import',
    normalReclamation:
      'Reference-counted eviction and maintenance delete unreferenced payload metadata within fixed cache limits.',
    multiTab: 'workspace-write-lock-changefeed',
    tests: ['tests/unit/cache-stores.test.ts'],
  }),
  table('discoveryPayloads', 'repairable', 'cache', 'drop', 'discovery-cache-domain', {
    ownerPath: 'src/store/discovery-cache-storage.ts',
    sizeDriver:
      'Deduplicated canonical JSON bodies, capped at 8 MiB each and 64 MiB unique live bytes.',
    debtPolicy: 'specialized-cache-port',
    retention: 'bounded-cache',
    rebuild: 'cache-refetch',
    interchange: 'omitted-from-import',
    normalReclamation:
      'Reference-counted eviction and maintenance delete unreferenced bodies within fixed cache limits.',
    multiTab: 'workspace-write-lock-changefeed',
    tests: ['tests/unit/cache-stores.test.ts'],
  }),
  table('drafts', 'canonical', 'authoritative', 'copy', 'conversation-domain', {
    ownerPath: 'src/store/browser-repo.ts',
    sizeDriver: 'Persisted per-chat unsent content and attachment references.',
    debtPolicy: 'typed-owner-port',
    retention: 'age-based-retention',
    rebuild: 'authoritative',
    interchange: 'portable-workspace-table',
    normalReclamation:
      'Draft clearing, chat deletion, and 24-hour stale empty-chat pruning remove rows.',
    multiTab: 'workspace-write-lock-changefeed',
    tests: ['tests/unit/chat-lifecycle-atomicity.test.ts'],
  }),
  table('endpoints', 'repairable', 'cache', 'drop', 'discovery-cache-domain', {
    ownerPath: 'src/store/discovery-cache-storage.ts',
    sizeDriver:
      'Bounded endpoint-cache headers per profile/model; bodies are deduplicated payload rows.',
    debtPolicy: 'specialized-cache-port',
    retention: 'bounded-cache',
    rebuild: 'cache-refetch',
    interchange: 'omitted-from-import',
    normalReclamation:
      'Per-profile/global row limits and maintenance evict stale headers and dereference payloads.',
    multiTab: 'workspace-write-lock-changefeed',
    tests: ['tests/unit/cache-stores.test.ts'],
  }),
  table('folders', 'canonical', 'authoritative', 'copy', 'catalog-domain', {
    ownerPath: 'src/store/folders.ts',
    sizeDriver: 'One small metadata row per user-created folder.',
    debtPolicy: 'typed-owner-port',
    retention: 'explicit-owner-delete',
    rebuild: 'authoritative',
    interchange: 'portable-workspace-table',
    normalReclamation:
      'Explicit folder deletion removes the row; obsolete versions require compaction.',
    multiTab: 'workspace-write-lock-changefeed',
    tests: ['tests/unit/organization-repository.test.ts'],
  }),
  table('keys', 'canonical', 'authoritative', 'copy', 'configuration-domain', {
    ownerPath: 'src/store/keys.ts',
    sizeDriver: 'Encrypted provider-key material and metadata per saved key.',
    debtPolicy: 'typed-owner-port',
    retention: 'explicit-owner-delete',
    rebuild: 'authoritative',
    interchange: 'portable-workspace-table',
    normalReclamation:
      'Explicit key deletion removes the row; overwritten ciphertext bytes require compaction.',
    multiTab: 'workspace-write-lock-changefeed',
    tests: ['tests/unit/keys.test.ts'],
  }),
  table('messageBodies', 'canonical', 'authoritative', 'copy', 'conversation-domain', {
    ownerPath: 'src/store/message-storage.ts',
    sizeDriver:
      'Full content, reasoning, tool calls, annotations, and generation payload per message.',
    debtPolicy: 'typed-owner-port',
    retention: 'explicit-owner-delete',
    rebuild: 'authoritative',
    interchange: 'hydrated-into-portable-messages',
    normalReclamation:
      'In-place edits replace bodies and chat deletion removes them; soft message deletion deliberately retains bodies until chat deletion.',
    multiTab: 'workspace-write-lock-changefeed',
    tests: ['tests/unit/message-storage.test.ts'],
  }),
  table('messagePreviews', 'repairable', 'derived', 'copy', 'conversation-domain', {
    ownerPath: 'src/store/message-storage.ts',
    sizeDriver: 'One bounded text-prefix projection per message.',
    debtPolicy: 'typed-owner-port',
    retention: 'rebuild-on-repair',
    rebuild: 'derived-from-authoritative',
    interchange: 'rebuilt-on-import',
    normalReclamation:
      'Message edits update previews and chat deletion removes them; migration/import can rebuild from message content.',
    multiTab: 'workspace-write-lock-changefeed',
    tests: ['tests/unit/message-storage.test.ts'],
  }),
  table('messages', 'canonical', 'authoritative', 'copy', 'conversation-domain', {
    ownerPath: 'src/store/message-storage.ts',
    sizeDriver: 'One structural/version/generation header per message node.',
    debtPolicy: 'typed-owner-port',
    retention: 'explicit-owner-delete',
    rebuild: 'authoritative',
    interchange: 'portable-workspace-table',
    normalReclamation:
      'Chat deletion removes headers; individual delete is a semantic tombstone and intentionally retains the row.',
    multiTab: 'workspace-write-lock-changefeed',
    tests: ['tests/unit/messages.test.ts'],
  }),
  table('models', 'repairable', 'cache', 'drop', 'discovery-cache-domain', {
    ownerPath: 'src/store/discovery-cache-storage.ts',
    sizeDriver:
      'Bounded model-list cache headers per profile/query; bodies are deduplicated payload rows.',
    debtPolicy: 'specialized-cache-port',
    retention: 'bounded-cache',
    rebuild: 'cache-refetch',
    interchange: 'omitted-from-import',
    normalReclamation:
      'Per-profile/global row limits and maintenance evict stale headers and dereference payloads.',
    multiTab: 'workspace-write-lock-changefeed',
    tests: ['tests/unit/cache-stores.test.ts'],
  }),
  table('presets', 'canonical', 'authoritative', 'copy', 'configuration-domain', {
    ownerPath: 'src/store/browser-configuration-domain.ts',
    sizeDriver: 'One complete chat-settings bundle per saved chat preset.',
    debtPolicy: 'typed-owner-port',
    retention: 'explicit-owner-delete',
    rebuild: 'authoritative',
    interchange: 'portable-workspace-table',
    normalReclamation:
      'Explicit preset deletion removes rows and derived catalog/link projections.',
    multiTab: 'workspace-write-lock-changefeed',
    tests: ['tests/unit/presets.test.ts'],
  }),
  table('presetOrderBlocks', 'canonical', 'authoritative', 'copy', 'configuration-domain', {
    ownerPath: 'src/store/preset-order.ts',
    sizeDriver: 'Bounded order blocks containing the user-visible active preset sequence.',
    debtPolicy: 'typed-owner-port',
    retention: 'explicit-owner-delete',
    rebuild: 'authoritative',
    interchange: 'portable-workspace-table',
    normalReclamation:
      'Order mutations replace bounded blocks and delete superseded blocks in the same authoritative transaction.',
    multiTab: 'workspace-write-lock-changefeed',
    tests: ['tests/unit/preset-sort-order.test.ts'],
  }),
  table('presetOrderMembership', 'repairable', 'derived', 'copy', 'configuration-domain', {
    ownerPath: 'src/store/preset-order.ts',
    sizeDriver: 'One block-membership projection per active preset.',
    debtPolicy: 'typed-owner-port',
    retention: 'rebuild-on-repair',
    rebuild: 'derived-from-authoritative',
    interchange: 'rebuilt-on-import',
    normalReclamation:
      'Order mutations replace membership rows and restore rebuilds them from authoritative order blocks.',
    multiTab: 'workspace-write-lock-changefeed',
    tests: ['tests/unit/preset-sort-order.test.ts'],
  }),
  table('presetOrderState', 'canonical', 'authoritative', 'copy', 'configuration-domain', {
    ownerPath: 'src/store/preset-order.ts',
    sizeDriver:
      'A bounded singleton containing authoritative preset-order anchors and revision state.',
    debtPolicy: 'typed-owner-port',
    retention: 'explicit-owner-delete',
    rebuild: 'authoritative',
    interchange: 'portable-workspace-table',
    normalReclamation:
      'Order mutations replace the singleton while compaction reclaims obsolete physical versions.',
    multiTab: 'workspace-write-lock-changefeed',
    tests: ['tests/unit/preset-sort-order.test.ts'],
  }),
  table('privacyPolicies', 'repairable', 'cache', 'drop', 'discovery-cache-domain', {
    ownerPath: 'src/store/discovery-cache-storage.ts',
    sizeDriver:
      'Bounded privacy-policy cache headers per profile/model; bodies are deduplicated payload rows.',
    debtPolicy: 'specialized-cache-port',
    retention: 'bounded-cache',
    rebuild: 'cache-refetch',
    interchange: 'omitted-from-import',
    normalReclamation:
      'Per-profile/global row limits and maintenance evict stale headers and dereference payloads.',
    multiTab: 'workspace-write-lock-changefeed',
    tests: ['tests/unit/cache-stores.test.ts'],
  }),
  table('profiles', 'canonical', 'authoritative', 'copy', 'configuration-domain', {
    ownerPath: 'src/store/browser-configuration-domain.ts',
    sizeDriver: 'Connection metadata, base URL, headers, capability overrides, and key references.',
    debtPolicy: 'typed-owner-port',
    retention: 'explicit-owner-delete',
    rebuild: 'authoritative',
    interchange: 'portable-workspace-table',
    normalReclamation:
      'Explicit profile deletion removes rows and derived catalog/link/cache ownership.',
    multiTab: 'workspace-write-lock-changefeed',
    tests: ['tests/unit/profiles.test.ts'],
  }),
  table('promptPresets', 'canonical', 'authoritative', 'copy', 'configuration-domain', {
    ownerPath: 'src/store/browser-configuration-domain.ts',
    sizeDriver: 'Saved prompt text and metadata per prompt preset.',
    debtPolicy: 'typed-owner-port',
    retention: 'explicit-owner-delete',
    rebuild: 'authoritative',
    interchange: 'portable-workspace-table',
    normalReclamation:
      'Explicit prompt-preset deletion removes rows and derived catalog projections.',
    multiTab: 'workspace-write-lock-changefeed',
    tests: ['tests/unit/prompt-presets.test.ts'],
  }),
  table('settings', 'canonical', 'authoritative', 'filtered-copy', 'workspace-settings-domain', {
    ownerPath: 'src/store/settings.ts',
    sizeDriver:
      'Global preferences plus internal workspace metadata, migration markers, compaction state, integrity state, and calibration.',
    debtPolicy: 'mixed-settings-ports',
    retention: 'mixed',
    rebuild: 'authoritative',
    interchange: 'portable-settings-subset',
    normalReclamation:
      'User settings are overwritten or explicitly cleared; internal singleton/marker rows are replaced or reset by their owning lifecycle.',
    multiTab: 'workspace-write-lock-changefeed',
    tests: [
      'tests/unit/global-settings-continue.test.ts',
      'tests/unit/storage-compaction-state.test.ts',
    ],
  }),
  table('storageRetentionState', 'canonical', 'journal', 'copy', 'storage-maintenance-domain', {
    ownerPath: 'src/store/storage-retention-state.ts',
    sizeDriver: 'Three bounded maintenance cursor rows, one per retention task.',
    debtPolicy: 'typed-owner-port',
    retention: 'mixed',
    rebuild: 'journal-recovery',
    interchange: 'reset-on-import',
    normalReclamation:
      'Each maintenance slice atomically advances or resets its bounded cursor; workspace restore seeds current idle rows.',
    multiTab: 'workspace-write-lock-changefeed',
    tests: ['tests/unit/storage-retention.test.ts'],
  }),
  table('streamChunks', 'canonical', 'journal', 'copy', 'generation-attempt-domain', {
    ownerPath: 'src/store/stream-journal-storage.ts',
    sizeDriver:
      'Incremental content/reasoning/tool journal chunks accumulated during generation attempts.',
    debtPolicy: 'specialized-journal-port',
    retention: 'age-based-retention',
    rebuild: 'journal-recovery',
    interchange: 'omitted-from-import',
    normalReclamation:
      'Successful finalization compacts journal state and terminal journals are pruned after 24 hours; obsolete pages require compaction.',
    multiTab: 'attempt-owner-lock-changefeed',
    tests: ['tests/unit/stream-journal-storage.test.ts'],
  }),
  table('streamLeases', 'canonical', 'journal', 'copy', 'generation-attempt-domain', {
    ownerPath: 'src/store/stream-journal-storage.ts',
    sizeDriver: 'One active or terminal recovery lease/commit ledger per generation attempt.',
    debtPolicy: 'specialized-journal-port',
    retention: 'age-based-retention',
    rebuild: 'journal-recovery',
    interchange: 'omitted-from-import',
    normalReclamation:
      'Lease finalization and the 24-hour terminal-journal retention pass remove old rows.',
    multiTab: 'attempt-owner-lock-changefeed',
    tests: ['tests/unit/stream-journal-storage.test.ts'],
  }),
  table('tags', 'canonical', 'authoritative', 'copy', 'catalog-domain', {
    ownerPath: 'src/store/tags.ts',
    sizeDriver: 'One small metadata row per user-created tag.',
    debtPolicy: 'typed-owner-port',
    retention: 'explicit-owner-delete',
    rebuild: 'authoritative',
    interchange: 'portable-workspace-table',
    normalReclamation:
      'Explicit tag deletion removes the row; obsolete versions require compaction.',
    multiTab: 'workspace-write-lock-changefeed',
    tests: ['tests/unit/organization-repository.test.ts'],
  }),
  table('textTemplates', 'canonical', 'authoritative', 'copy', 'configuration-domain', {
    ownerPath: 'src/store/text-template-storage.ts',
    sizeDriver: 'User-authored request text templates and metadata.',
    debtPolicy: 'typed-owner-port',
    retention: 'explicit-owner-delete',
    rebuild: 'authoritative',
    interchange: 'portable-settings-subset',
    normalReclamation:
      'Explicit template deletion removes the row; overwritten text requires compaction.',
    multiTab: 'workspace-write-lock-changefeed',
    tests: ['tests/unit/saved-text-templates.test.ts'],
  }),
  table(
    'workspaceFence',
    'canonical',
    'authoritative',
    'preserve-destination',
    'coordination-domain',
    {
      ownerPath: 'src/store/workspace-meta.ts',
      sizeDriver: 'A bounded singleton identifying the active workspace and replacement epoch.',
      debtPolicy: 'typed-owner-port',
      retention: 'mixed',
      rebuild: 'authoritative',
      interchange: 'seed',
      normalReclamation:
        'Workspace activation replaces the destination-owned fence; compaction never copies the stale source fence over it.',
      multiTab: 'workspace-write-lock-changefeed',
      tests: ['tests/unit/workspace-repository-contract.test.ts'],
    },
  ),
])

export const STORAGE_TABLE_OWNERSHIP = Object.freeze([
  ...BASE_STORAGE_TABLE_OWNERSHIP,
  ...BASE_STORAGE_TABLE_OWNERSHIP.filter(
    (entry) => entry.compaction === 'copy' || entry.compaction === 'filtered-copy',
  ).map((entry) =>
    table(
      `replacementCatchup__${entry.name}`,
      'canonical',
      'journal',
      'seed',
      'workspace-replacement-catchup',
      {
        ownerPath: 'src/store/browser-workspace-catchup-journal.ts',
        sizeDriver:
          'At most one latest changed-key/revision row per source key since staged-copy admission.',
        debtPolicy: 'specialized-journal-port',
        retention: 'rebuild-on-repair',
        rebuild: 'journal-recovery',
        interchange: 'omitted-from-import',
        normalReclamation:
          'All companion journals clear atomically at staged-copy admission; the destination starts empty and obsolete-slot deletion removes any residual source rows.',
        multiTab: 'workspace-write-lock-changefeed',
        tests: ['tests/unit/browser-command-mutation-journal.test.ts'],
      },
    ),
  ),
])

export const ORIGIN_STORAGE_NAMESPACES = Object.freeze([
  namespace('idb-control', 'indexeddb', 'natter-control', 'src/lib/origin-storage-names.ts', {
    ownership: 'Control manifest and replacement journal.',
    normalReclamation: 'Retained as a bounded singleton control database; Clear all deletes it.',
    wipeCoverage: 'known-name-and-enumeration',
  }),
  namespace('idb-workspace-legacy', 'indexeddb', 'natter', 'src/lib/origin-storage-names.ts', {
    ownership: 'Initial/legacy workspace slot containing every current physical workspace table.',
    normalReclamation:
      'The active slot is retained; every inactive registered slot is exclusively swept by normal background retention.',
    wipeCoverage: 'known-name-and-enumeration',
  }),
  namespace(
    'idb-workspace-a',
    'indexeddb',
    'natter-workspace-a',
    'src/lib/origin-storage-names.ts',
    {
      ownership: 'Alternate workspace slot for atomic replacement and compaction.',
      normalReclamation:
        'The active slot is retained; every inactive registered slot is exclusively swept by normal background retention.',
      wipeCoverage: 'known-name-and-enumeration',
    },
  ),
  namespace(
    'idb-workspace-b',
    'indexeddb',
    'natter-workspace-b',
    'src/lib/origin-storage-names.ts',
    {
      ownership: 'Alternate workspace slot for atomic replacement and compaction.',
      normalReclamation:
        'The active slot is retained; every inactive registered slot is exclusively swept by normal background retention.',
      wipeCoverage: 'known-name-and-enumeration',
    },
  ),
  namespace('idb-other-origin', 'indexeddb-enumerated', '*', 'src/lib/storage-wipe.ts', {
    ownership: 'Databases at the same origin not present in the four-name Natter registry.',
    normalReclamation: 'No normal-operation ownership or reclamation.',
    wipeCoverage: 'enumeration-only',
    gaps: ['unknown-historical-databases-unverifiable-without-enumeration'],
  }),
  namespace(
    'local-workspace-change',
    'local-storage-key',
    'natter:workspace-change',
    'src/store/broadcast.ts',
    {
      ownership: 'One overwritten BroadcastChannel fallback signal.',
      normalReclamation: 'Bounded to one key and overwritten; Clear all clears localStorage.',
      wipeCoverage: 'web-storage-clear',
    },
  ),
  namespace(
    'local-slot-control',
    'local-storage-key',
    'natter:workspace-slot-control:v1',
    'src/store/browser-workspace-slot-coordination.ts',
    {
      ownership: 'One overwritten workspace-slot transport fallback signal.',
      normalReclamation: 'Bounded to one key and overwritten; Clear all clears localStorage.',
      wipeCoverage: 'web-storage-clear',
    },
  ),
  namespace(
    'local-storage-administration',
    'local-storage-key',
    'natter:storage-administration',
    'src/store/storage-administration.ts',
    {
      ownership: 'One overwritten clear-all coordination fallback signal.',
      normalReclamation: 'Bounded to one key and overwritten; Clear all clears localStorage.',
      wipeCoverage: 'web-storage-clear',
    },
  ),
  namespace(
    'local-compaction-intents',
    'local-storage-prefix',
    'natter:storage-compaction-intent:v1:',
    'src/store/storage-compaction-state.ts',
    {
      ownership: 'Per-tab crash markers while obsolete-byte debt is not durably recorded.',
      normalReclamation:
        'Removed after debt persistence or stale-owner recovery; Clear all clears localStorage.',
      wipeCoverage: 'web-storage-clear',
      gaps: [],
    },
  ),
  namespace(
    'session-workspace-fence',
    'session-storage-key',
    'natter:workspace-tab-session:v3',
    'src/store/workspace-tab-session.ts',
    {
      ownership: 'Per-tab workspace incarnation fence.',
      normalReclamation:
        'Overwritten on workspace reconciliation and cleared by Clear all in each coordinated tab.',
      wipeCoverage: 'per-tab-session-clear',
      accessPaths: ['src/store/workspace-tab-session.ts'],
    },
  ),
  namespace(
    'session-conversation',
    'session-storage-prefix',
    'natter:conversation-session:',
    'src/store/workspace-tab-session.ts',
    {
      ownership:
        'Per-tab branch selection, transcript/tree presentation, and reveal intent by chat.',
      normalReclamation:
        'Deleted per chat or workspace replacement and expires with the tab session.',
      wipeCoverage: 'per-tab-session-clear',
      accessPaths: ['src/store/workspace-tab-session.ts', 'src/store/conversation-controller.ts'],
    },
  ),
  namespace(
    'session-composer-draft',
    'session-storage-prefix',
    'natter:composer-draft:',
    'src/store/workspace-tab-session.ts',
    {
      ownership: 'Per-tab composer text by new-chat/chat context.',
      normalReclamation:
        'Deleted when empty, per chat, or workspace replacement and expires with the tab session.',
      wipeCoverage: 'per-tab-session-clear',
      accessPaths: ['src/store/workspace-tab-session.ts', 'src/ui/chat/composer-draft-state.ts'],
    },
  ),
  namespace(
    'session-active-seed',
    'session-storage-key',
    'natter:active-seed',
    'src/store/workspace-tab-session.ts',
    {
      ownership: 'Per-tab active configuration seed for new chats.',
      normalReclamation: 'Overwritten/removed with seed changes and workspace replacement.',
      wipeCoverage: 'per-tab-session-clear',
      accessPaths: ['src/store/workspace-tab-session.ts', 'src/store/configuration-controller.ts'],
    },
  ),
  namespace(
    'session-preload-recovery',
    'session-storage-key',
    'natter:preload-recovery-build',
    'src/lib/preload-recovery.ts',
    {
      ownership: 'One per-tab build token preventing a preload-error reload loop.',
      normalReclamation: 'Overwritten per build and expires with the tab session.',
      wipeCoverage: 'per-tab-session-clear',
      accessPaths: ['src/lib/preload-recovery.ts'],
    },
  ),
  namespace('cache-storage-all', 'cache-storage', '*', 'src/lib/storage-wipe.ts', {
    ownership:
      'No production Natter writer; Clear all treats every same-origin cache as owned cleanup scope.',
    normalReclamation:
      'No Natter normal-operation lifecycle because the app does not populate Cache Storage.',
    wipeCoverage: 'enumerate-delete-verify',
  }),
  namespace('opfs-all', 'opfs', '*', 'src/lib/storage-wipe.ts', {
    ownership:
      'No production Natter writer; Clear all treats every same-origin OPFS entry as owned cleanup scope.',
    normalReclamation:
      'No Natter normal-operation lifecycle because the app does not populate OPFS.',
    wipeCoverage: 'enumerate-delete-verify',
  }),
  namespace('storage-buckets-all', 'storage-buckets', '*', 'src/lib/storage-wipe.ts', {
    ownership:
      'No production Natter writer; Clear all treats every same-origin storage bucket as owned cleanup scope.',
    normalReclamation:
      'No Natter normal-operation lifecycle because the app does not populate storage buckets.',
    wipeCoverage: 'enumerate-delete-verify',
  }),
  namespace('service-workers-all', 'service-workers', '*', 'src/lib/storage-wipe.ts', {
    ownership:
      'No production registration path; Clear all unregisters every same-origin registration.',
    normalReclamation:
      'No Natter normal-operation lifecycle because the app does not register a service worker.',
    wipeCoverage: 'enumerate-unregister-verify',
  }),
  namespace('visible-cookies-all', 'cookies', '*', 'src/lib/storage-wipe.ts', {
    ownership:
      'No production cookie writer; Clear all expires every JavaScript-visible same-origin cookie.',
    normalReclamation:
      'No Natter normal-operation lifecycle because the app does not write cookies.',
    wipeCoverage: 'visible-only-expire-verify',
  }),
])

export const STORAGE_LIFECYCLE_PATHS = Object.freeze([
  lifecycle(
    'control-manifest',
    'src/store/browser-workspace-database-control.ts',
    'class BrowserWorkspaceControlDb extends Dexie',
    'A bounded control database owns active-slot selection and the preparing/discard/cleanup replacement journal.',
    [],
  ),
  lifecycle(
    'recover-preparing-discard',
    'src/store/browser-workspace-database-cleanup.ts',
    "if (journal.phase === 'preparing') {",
    'The independent cleanup owner claims an abandoned preparation as discard work without blocking startup on replacement ownership or physical deletion.',
    [],
  ),
  lifecycle(
    'nonblocking-pending-selection',
    'src/store/browser-workspace-database-selection.ts',
    'confirmed.activationSequence !== current.activationSequence',
    'Startup validates only the active slot fence and remains ready while discard or cleanup work is pending.',
    [],
  ),
  lifecycle(
    'slot-switching-capability',
    'src/store/browser-workspace-slot-coordination.ts',
    'export function browserWorkspaceSlotSwitchingSupported(): boolean {',
    'Atomic slot replacement requires both Web Locks and a BroadcastChannel/localStorage transport.',
    ['compaction-unavailable-without-locks-or-transport'],
  ),
  lifecycle(
    'unslotted-replacement',
    'src/store/browser-workspace-replacement-runner.ts',
    'const replacementDb = new NatterDb(databaseName)',
    'Non-compaction workspace replacement can fall back to same-name quiesced replacement, but compaction itself rejects this path.',
    ['compaction-unavailable-without-locks-or-transport'],
  ),
  lifecycle(
    'post-commit-debt-queue',
    'src/store/storage-compaction-state.ts',
    'function commitCompletedStorageCompactionDebt(',
    'Committed semantic mutations enqueue obsolete-byte estimates for an asynchronous settings-ledger write.',
    ['logical-debt-does-not-measure-physical-amplification'],
  ),
  lifecycle(
    'crash-intent-recovery',
    'src/store/storage-maintenance-runtime.ts',
    "case 'recover-compaction-intents':",
    'One maintenance task owns recovery of stale per-tab compaction-debt intents.',
    [],
  ),
  lifecycle(
    'compaction-threshold',
    'src/store/storage-compaction-state.ts',
    'export function storageCompactionDebtThreshold(',
    'A request revision advances after estimated obsolete bytes cross max(64 MiB, half of last compacted live bytes).',
    ['logical-debt-does-not-measure-physical-amplification'],
  ),
  lifecycle(
    'compaction-attempt-release',
    'src/store/browser-workspace-compaction.ts',
    'function isRetryableBrowserWorkspaceCompactionError(error: unknown): boolean {',
    'The exact claimed revision is released only after typed maintenance preemption, bounded catch-up overflow, or an unpromoted staged-copy cleanup; the idempotent capability creates one newer durable request and publishes the existing maintenance wake, while permanent or uncertain outcomes retain the claim.',
    [],
  ),
  lifecycle(
    'retention-owner',
    'src/store/storage-maintenance-runtime.ts',
    'async #runMaintenanceOwnership(database: NatterDb): Promise<void> {',
    'One cross-tab coordination owner runs bounded retention and compaction admission.',
    [],
  ),
  lifecycle(
    'bounded-retention-pass',
    'src/store/storage-maintenance-runtime.ts',
    'async #runSlice(task: StorageMaintenanceTask): Promise<StorageMaintenanceSliceOutcome> {',
    'Batches repair, orphan attachments, terminal stream journals, empty draft chats, and discovery-cache maintenance. Attachment repair persists owner and reverse-reference cursors and caps each page at 16 edge rows or 256 KiB plus one largest row.',
    [],
  ),
  lifecycle(
    'orphan-workspace-database-sweep',
    'src/store/browser-workspace-orphan-reclamation.ts',
    'export async function reclaimInactiveBrowserWorkspaceDatabases()',
    'A retention pass briefly snapshots selection, then nonblockingly locks and revalidates each of the two inactive registered slots before deletion; peer-held and replacement candidates wait for a later event-driven pass.',
    [],
  ),
  lifecycle(
    'compaction-readiness',
    'src/store/storage-maintenance-runtime.ts',
    '#publishCompactionWake(): void {',
    'The retention owner reads requestRevision and prepares an idle-only replacement request.',
    [],
  ),
  lifecycle(
    'idle-compaction-admission',
    'src/store/storage-maintenance-runtime.ts',
    'async #runCompactionSlice(): Promise<StorageMaintenanceSliceOutcome> {',
    'Compaction starts online only when the aggregate workspace runtime reports idle; later foreground work remains admitted while the staged copy catches up.',
    [],
  ),
  lifecycle(
    'paged-compaction-copy',
    'src/store/browser-workspace-compaction.ts',
    'async function copyBrowserWorkspace(',
    'Applies the physical manifest online in 64-row or 1-MiB pages, batches each catch-up page in one transaction-owned request wave, and bounds the final quiesced activation to 256 rows or 4 MiB.',
    ['logical-debt-does-not-measure-physical-amplification'],
  ),
  lifecycle(
    'retention-owned-slot-cleanup',
    'src/store/browser-workspace-database-cleanup.ts',
    'export async function cleanPendingBrowserWorkspaceDatabase(',
    'The existing cross-tab retention owner locks only the obsolete slot, revalidates the exact journal, deletes it, and acknowledges cleanup outside workspace readiness.',
    [],
  ),
  lifecycle(
    'journal-authorized-peer-recovery',
    'src/store/browser-workspace-database-cleanup.ts',
    'export function recoverQuiescedBrowserWorkspaceReplacement(',
    'A quiesced peer queues on the durable selection Web Lock, reconciles preparing or cleanup state from the authoritative manifest, deletes only the obsolete slot, and reopens the selected database without a resume message or timer.',
    [],
  ),
  lifecycle(
    'clear-all-origin-wipe',
    'src/lib/storage-wipe.ts',
    'export async function wipeOriginStorage(): Promise<OriginStorageWipeReport> {',
    'Clear all deletes known/enumerated IndexedDB databases plus Cache Storage, OPFS, buckets, web storage, visible cookies, and service workers with verification where APIs permit.',
    ['unknown-historical-databases-unverifiable-without-enumeration'],
  ),
  lifecycle(
    'quota-probe',
    'src/store/quota.ts',
    'export async function probeQuota(',
    'The UI reports the browser StorageManager estimate, which is origin-level and not a physical-deletion proof.',
    ['quota-estimate-cannot-prove-reclamation'],
  ),
])

export const STORAGE_COORDINATION_MECHANISMS = Object.freeze([
  coordination(
    'workspace-write-lock',
    'src/store/locks.ts',
    "const WORKSPACE_AUTHORITATIVE_GATE = 'workspace:authoritative'",
    'Web Locks serialize authoritative writes, with browserLocks as the fallback lease store.',
  ),
  coordination(
    'workspace-change-transport',
    'src/store/broadcast.ts',
    "const CHANNEL_NAME = 'llm-api-frontend'",
    'BroadcastChannel carries commits/replacements; localStorage plus polling verifies missed changes.',
  ),
  coordination(
    'lock-wake-transport',
    'src/store/locks.ts',
    "const LOCK_WAKE_CHANNEL_NAME = 'natter:lock-wake:v1'",
    'A bounded BroadcastChannel wake signal accelerates fallback IndexedDB lease acquisition without owning durable data.',
  ),
  coordination(
    'slot-control-transport',
    'src/store/browser-workspace-slot-coordination.ts',
    "const SLOT_CHANNEL_NAME = 'natter-workspace-slot-control:v1'",
    'BroadcastChannel/localStorage quiesces tabs while exclusive slot locks protect replacement.',
  ),
  coordination(
    'storage-administration-transport',
    'src/store/storage-administration.ts',
    "const STORAGE_ADMIN_CHANNEL = 'natter-storage-administration'",
    'A separate channel/lock coordinates destructive origin wipe across all live tabs.',
  ),
  coordination(
    'retention-owner-lock',
    'src/store/storage-maintenance-runtime.ts',
    '`storage-maintenance-owner:v1:$' + '{this.#fence.workspaceId}`',
    'Exactly one tab owns normal retention and compaction checks at a time.',
  ),
])

export const STORAGE_RECLAMATION_GAPS = Object.freeze([
  gap(
    'compaction-unavailable-without-locks-or-transport',
    'src/store/browser-workspace-compaction.ts',
    'if (!browserWorkspaceCompactionSupported()) {',
    'Compaction is rejected when Web Locks or both slot transports are unavailable, with no bounded in-place or close-and-copy fallback.',
  ),
  gap(
    'logical-debt-does-not-measure-physical-amplification',
    'src/store/storage-size-estimate.ts',
    'export function estimateStoredValueBytes(root: unknown): number {',
    'Thresholds and post-copy live bytes estimate serialized row values, not indexes, LevelDB/SSTable fragmentation, write amplification, or the browser physical allocation.',
  ),
  gap(
    'unknown-historical-databases-unverifiable-without-enumeration',
    'src/lib/storage-wipe.ts',
    "const canEnumerate = typeof indexedDB.databases === 'function'",
    'Without indexedDB.databases(), Clear all can delete only the four registered names and cannot discover or verify unknown historical databases.',
  ),
  gap(
    'quota-estimate-cannot-prove-reclamation',
    'tests/e2e/storage-reclamation.spec.ts',
    'expect(measurement.afterDeleteBytes).toBeGreaterThanOrEqual(measurement.beforeBytes)',
    'Chromium may retain origin quota accounting after object-store or database deletion; the app can prove namespace deletion but cannot force or infer engine compaction from StorageManager usage.',
  ),
])

export const STORAGE_RECLAMATION_ACCEPTANCE = Object.freeze([
  'Every physical table has exactly one current ownership/classification/reclamation record.',
  'Every normal physical mutation contributes bounded obsolete-byte evidence or is explicitly ephemeral.',
  'Compaction remains linear in live rows/bytes with bounded copy pages and never hydrates cold message bodies into the UI.',
  'A transient compaction or debt-ledger failure remains retryable without requiring new user churn or a reload.',
  'Known inactive workspace databases are reclaimed during normal operation even when no replacement journal survives.',
  'Multi-tab streams and tab-local branch cursors remain usable across compaction slot switches.',
  'Clear all deletes and verifies every browser namespace available to the origin while reporting unverifiable browser limits honestly.',
  'A real-browser Natter compaction test proves debt, idle admission, slot switch, old-slot deletion, reload, and multi-tab continuity without relying on quota-estimate reduction.',
  'Storage maintenance never gates shell navigation, local drafting, or active stream controls.',
  'Foreground writes during staged compaction are caught up without repeating the whole copy, and activation quiesces only for a bounded residual journal.',
])

function table(name, schemaClass, dataClass, compaction, owner, detail) {
  return Object.freeze({
    name,
    schemaClass,
    dataClass,
    owner,
    ownerPath: detail.ownerPath,
    sizeDriver: detail.sizeDriver,
    debtPolicy: detail.debtPolicy,
    retention: detail.retention,
    rebuild: detail.rebuild,
    interchange: interchangeAction(detail.interchange),
    interchangeDetail: detail.interchange,
    compaction,
    wipeCoverage: 'workspace-database-delete',
    normalReclamation: detail.normalReclamation,
    multiTab: detail.multiTab,
    testEvidence: Object.freeze([...TABLE_TESTS, ...(detail.tests ?? [])]),
    gapIds: Object.freeze([...(detail.gaps ?? TABLE_GAPS)]),
  })
}

function interchangeAction(detail) {
  if (
    detail === 'portable' ||
    detail === 'portable-attachment-bundle' ||
    detail === 'portable-workspace-table' ||
    detail === 'hydrated-into-portable-messages' ||
    detail === 'portable-settings-subset'
  ) {
    return 'portable'
  }
  if (detail === 'rebuild' || detail === 'rebuilt-on-import') return 'rebuild'
  if (detail === 'omit' || detail === 'omitted-from-import') return 'omit'
  if (detail === 'seed' || detail === 'reset-on-import') return 'seed'
  throw new Error(`StorageTableInterchangePolicyInvalid:${detail}`)
}

function namespace(id, kind, key, path, detail) {
  return Object.freeze({
    id,
    kind,
    key,
    path,
    accessPaths: Object.freeze([...(detail.accessPaths ?? [path])]),
    ownership: detail.ownership,
    normalReclamation: detail.normalReclamation,
    wipeCoverage: detail.wipeCoverage,
    gapIds: Object.freeze([...(detail.gaps ?? [])]),
  })
}

function lifecycle(id, path, locator, rationale, gapIds) {
  return Object.freeze({ id, path, locator, rationale, gapIds: Object.freeze([...gapIds]) })
}

function coordination(id, path, locator, rationale) {
  return Object.freeze({ id, path, locator, rationale })
}

function gap(id, path, locator, rationale) {
  return Object.freeze({ id, path, locator, rationale })
}
