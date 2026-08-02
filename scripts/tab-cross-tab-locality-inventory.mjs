function locality(input) {
  return Object.freeze({
    initiatingOwner: input.initiatingOwner,
    durableScope: input.durableScope,
    lockTransactionScope: input.lockTransactionScope,
    localPresentationEffect: input.localPresentationEffect,
    crossTabPublication: input.crossTabPublication,
    forbiddenRemoteSteering: Object.freeze([...input.forbiddenRemoteSteering]),
    activeStreamOwnership: input.activeStreamOwnership,
    expectedOtherTabBehavior: input.expectedOtherTabBehavior,
    status: input.status,
    evidence: input.evidence,
    ...(input.gap ? { gap: input.gap } : {}),
  })
}

function records(variants, policy) {
  return Object.freeze(Object.fromEntries(variants.map((variant) => [variant, locality(policy)])))
}

function mergeRecords(...groups) {
  return Object.freeze(Object.assign({}, ...groups))
}

const FORBID_REMOTE_STEERING = Object.freeze(['route', 'cursor', 'draft', 'selection'])

const READ_POLICY = {
  initiatingOwner: 'constructor-site',
  durableScope: 'read-only',
  lockTransactionScope: 'repository-read-permit',
  localPresentationEffect: 'requester-local-projection',
  crossTabPublication: 'none',
  forbiddenRemoteSteering: FORBID_REMOTE_STEERING,
  activeStreamOwnership: 'none',
  expectedOtherTabBehavior: 'unaffected',
  status: 'observed',
  evidence: 'WorkspaceQuery is read-only and returns only to its initiating repository caller.',
}

const QUERY_VARIANTS = Object.freeze([
  'attachment.bundle',
  'attachment.catalog-aggregate',
  'attachment.catalog-evaluate',
  'attachment.catalog-page',
  'attachment.catalog-rows',
  'attachment.dispatch-bundle',
  'attachment.find-hash',
  'attachment.generation-token-evidence',
  'attachment.get',
  'attachment.get-many',
  'attachment.manager-detail',
  'attachment.media',
  'attachment.media-many',
  'attachment.reference-rows',
  'attachment.references',
  'branch.child-at-position',
  'branch.forks',
  'branch.open',
  'branch.page-structure',
  'chat.get',
  'chat.next-fork-title',
  'chat.token-calibrations',
  'configuration.active-model',
  'configuration.active-selection',
  'configuration.connection-manager-page',
  'configuration.discovery-snapshot',
  'configuration.generated-output-network-access',
  'configuration.global-token-calibration',
  'configuration.model-resolution-head',
  'configuration.model-resolution-page',
  'configuration.preset-catalog-page',
  'configuration.profile-switch-plan',
  'configuration.profile-catalog-page',
  'configuration.prompt-preset-catalog-page',
  'configuration.shell',
  'configuration.text-template-catalog',
  'discovery.endpoints',
  'discovery.models',
  'discovery.privacy',
  'folder.list',
  'generated-output.localization-queue',
  'interchange.export-chat',
  'interchange.export-chat-preset',
  'interchange.export-connection-profile',
  'interchange.export-workspace-backup',
  'key.get',
  'message.headers-by-chat',
  'message.presentation',
  'message.presentations',
  'message.preview-window',
  'message.search-corpus',
  'setting.get',
  'setting.get-many',
  'sidebar.aggregate',
  'sidebar.catalog-page',
  'sidebar.created-at-group-count',
  'sidebar.presentation-page',
  'sidebar.rows-by-id',
  'stream.journal-frame-page',
  'stream.lease',
  'stream.lease-head',
  'stream.leases',
  'stream.leases-by-id',
  'tag.list',
  'workspace.meta',
])

const STREAM_READ_VARIANTS = Object.freeze([
  'attachment.dispatch-bundle',
  'attachment.generation-token-evidence',
  'configuration.generated-output-network-access',
  'generated-output.localization-queue',
  'stream.journal-frame-page',
  'stream.lease',
  'stream.lease-head',
  'stream.leases',
  'stream.leases-by-id',
])

export const WORKSPACE_QUERY_LOCALITY = mergeRecords(
  records(
    QUERY_VARIANTS.filter((variant) => !STREAM_READ_VARIANTS.includes(variant)),
    READ_POLICY,
  ),
  records(STREAM_READ_VARIANTS, {
    ...READ_POLICY,
    localPresentationEffect: 'stream-or-background-projection',
    activeStreamOwnership: 'observe-durable-stream-state',
    expectedOtherTabBehavior: 'may-observe-same-durable-attempt-without-owning-or-steering-it',
    evidence:
      'Stream and generation-input queries observe durable state without acquiring ownership.',
  }),
)

const COMMAND_VARIANTS = Object.freeze([
  'attachment.bundle.write',
  'attachment.bytes.delete',
  'attachment.delete-if-unreferenced',
  'attachment.delete-many',
  'attachment.reap',
  'attachment.ref.add',
  'attachment.ref.detach',
  'attachment.ref.relink',
  'attachment.ref.set-visibility',
  'attempt.dispatch',
  'attempt.finalize',
  'attempt.prepare',
  'attempt.request-stop',
  'attempt.seal-terminal',
  'chat.calibration.clear',
  'chat.calibration.clear-all',
  'chat.calibration.clear-family',
  'chat.delete-archived',
  'chat.discard-empty-drafts',
  'chat.empty-archive',
  'chat.fork',
  'chat.materialize-temporary',
  'chat.move-to-folder',
  'chat.set-archived',
  'chat.set-manual-title',
  'chat.set-tags-from-names',
  'chat.touch-viewed',
  'configuration.execute',
  'discovery.endpoints.put',
  'discovery.models.delete',
  'discovery.models.put',
  'discovery.privacy.put',
  'draft.put',
  'folder.create',
  'folder.delete',
  'folder.ensure-and-move-chats',
  'folder.update',
  'generated-output.localization-claim',
  'generated-output.localization-complete',
  'generated-output.localization-fail',
  'generated-output.localization-retry',
  'generated-output.video-expand',
  'generation.post-commit-metadata',
  'interchange.import-chat',
  'interchange.import-chat-preset',
  'interchange.import-connection-profile',
  'maintenance.prune-discovery-cache',
  'maintenance.prune-empty-draft-chats',
  'maintenance.prune-terminal-stream-journals',
  'maintenance.reconcile-attachment-integrity',
  'maintenance.reconcile-stream-journal-integrity',
  'message.delete',
  'message.dismiss-generation-notice',
  'message.edit-body',
  'message.import',
  'message.restore-structure',
  'message.toggle-context',
  'message.toggle-provider-output-item',
  'message.toggle-reasoning-detail',
  'stream.append-journal-frames',
  'stream.claim-recovery',
  'stream.finish-cleanup',
  'stream.handoff-recovery',
  'stream.note-selected-key',
  'stream.renew',
])

const STREAM_COMMAND_VARIANTS = Object.freeze([
  'attempt.dispatch',
  'attempt.finalize',
  'attempt.prepare',
  'attempt.request-stop',
  'attempt.seal-terminal',
  'generation.post-commit-metadata',
  'stream.append-journal-frames',
  'stream.claim-recovery',
  'stream.finish-cleanup',
  'stream.handoff-recovery',
  'stream.note-selected-key',
  'stream.renew',
])

const MAINTENANCE_COMMAND_VARIANTS = Object.freeze([
  'attachment.reap',
  'maintenance.prune-discovery-cache',
  'maintenance.prune-empty-draft-chats',
  'maintenance.prune-terminal-stream-journals',
  'maintenance.reconcile-attachment-integrity',
  'maintenance.reconcile-stream-journal-integrity',
])

const COMMAND_POLICY = {
  initiatingOwner: 'constructor-site',
  durableScope: 'workspace-mutation',
  lockTransactionScope: 'variant-specific-unproven',
  localPresentationEffect: 'local-receipt-then-projection',
  crossTabPublication: 'commit-delta-required-on-write',
  forbiddenRemoteSteering: FORBID_REMOTE_STEERING,
  activeStreamOwnership: 'none',
  expectedOtherTabBehavior:
    'refresh-authoritative-data-without-route-cursor-draft-or-selection-change',
  status: 'gap',
  evidence: 'src/store/workspace-repository.ts#deliverLocalCommit',
  gap: 'Committed physical writes, exact lock scope, and cross-tab publication are not one derived exhaustive command contract.',
}

export const WORKSPACE_COMMAND_LOCALITY = mergeRecords(
  records(
    COMMAND_VARIANTS.filter(
      (variant) =>
        !STREAM_COMMAND_VARIANTS.includes(variant) &&
        !MAINTENANCE_COMMAND_VARIANTS.includes(variant),
    ),
    COMMAND_POLICY,
  ),
  records(STREAM_COMMAND_VARIANTS, {
    ...COMMAND_POLICY,
    localPresentationEffect: 'owner-live-projection-and-durable-attempt-projection',
    activeStreamOwnership: 'stream-fenced-owner-or-explicit-recovery-claim',
    expectedOtherTabBehavior:
      'observe-durable-attempt-progress-without-aborting-own-stream-or-following-owner-selection',
  }),
  records(MAINTENANCE_COMMAND_VARIANTS, {
    ...COMMAND_POLICY,
    initiatingOwner: 'maintenance',
    localPresentationEffect: 'none-until-projection-invalidation',
    activeStreamOwnership: 'must-not-own-or-block-unrelated-active-streams',
    expectedOtherTabBehavior: 'refresh-only-affected-durable-projections',
  }),
)

const CONFIGURATION_VARIANTS = Object.freeze([
  'chat-preset.apply',
  'chat-preset.create',
  'chat-preset.create-and-link',
  'chat-preset.delete',
  'chat-preset.duplicate',
  'chat-preset.move',
  'chat-preset.save',
  'chat-preset.set-archived',
  'chat-preset.update',
  'chat.resolve-model',
  'chat.settings-fields-patch',
  'chat.settings-patch',
  'chat.settings-replace',
  'chat.switch-profile',
  'connection.create',
  'connection.delete',
  'connection.duplicate',
  'connection.edit',
  'connection.touch',
  'global-preference.set',
  'image-allowlist.add',
  'image-allowlist.remove',
  'install-secret.ensure',
  'key.delete',
  'key.material-replace',
  'key.put',
  'key.touch',
  'pinned-model.move',
  'pinned-model.set-membership',
  'prompt-preset.create-and-pin',
  'prompt-preset.delete',
  'prompt-preset.load-and-pin',
  'prompt-preset.local-commit',
  'prompt-preset.overwrite-and-pin',
  'prompt-preset.rename',
  'recent-model.clear',
  'rendering-preferences.patch',
  'sample-prompts.set-dismissed',
  'sidebar-preference.set-folder-collapsed',
  'sidebar-preference.set-sort',
  'text-template.create',
  'text-template.create-and-select',
  'text-template.delete',
  'text-template.update',
])

export const CONFIGURATION_COMMAND_LOCALITY = records(CONFIGURATION_VARIANTS, {
  ...COMMAND_POLICY,
  durableScope: 'configuration-mutation',
  localPresentationEffect: 'initiating-tab-optimistic-or-result-projection',
  expectedOtherTabBehavior:
    'refresh-shared-configuration-without-copying-open-panel-draft-selection-or-route',
  gap: 'Nested configuration variants do not yet have one exact lock/write/publication/local-optimistic contract, and some declared variants have no production constructor.',
})

export const WORKSPACE_ROOT_LOCALITY = mergeRecords(
  records(['repository-query', 'search-session'], {
    initiatingOwner: 'admission-site',
    durableScope: 'read-only',
    lockTransactionScope: 'tab-runtime-read-root',
    localPresentationEffect: 'requester-local-projection',
    crossTabPublication: 'none',
    forbiddenRemoteSteering: FORBID_REMOTE_STEERING,
    activeStreamOwnership: 'none',
    expectedOtherTabBehavior: 'unaffected',
    status: 'observed',
    evidence: 'src/store/workspace-runtime.ts#runWorkspaceRead',
  }),
  records(['conversation-generation'], {
    initiatingOwner: 'tab-local',
    durableScope: 'chat-and-stream-attempt',
    lockTransactionScope: 'tab-runtime-write-root-plus-command-locks',
    localPresentationEffect: 'owner-live-stream-and-local-selection-result',
    crossTabPublication: 'commit-delta-required-on-write',
    forbiddenRemoteSteering: FORBID_REMOTE_STEERING,
    activeStreamOwnership: 'one-tab-owner-per-stream-with-reserved-children',
    expectedOtherTabBehavior:
      'independent-streams-continue-and-remote-tab-never-follows-owner-branch',
    status: 'observed',
    evidence:
      'GenerationIntent admission, ConversationOperationClaim, per-stream lease fences, and typed local result delivery form one ownership lineage.',
  }),
  records(['stream-control'], {
    initiatingOwner: 'tab-local',
    durableScope: 'exact-stream-attempt',
    lockTransactionScope: 'tab-runtime-write-root-plus-attempt-command-lock',
    localPresentationEffect: 'owner-stop-claim-and-committed-stop-result',
    crossTabPublication: 'commit-delta-required-on-write',
    forbiddenRemoteSteering: FORBID_REMOTE_STEERING,
    activeStreamOwnership: 'exact-attempt-stop-claim',
    expectedOtherTabBehavior: 'unrelated-streams-remain-live-and-unaffected',
    status: 'observed',
    evidence: 'src/store/attempt-control-application.ts#requestAttemptStop',
  }),
  records(
    [
      'message-edit',
      'message-structure',
      'chat-fork',
      'chat-metadata',
      'workspace-organization',
      'configuration',
      'attachment',
      'import-export',
      'cache-refresh',
      'stream-recovery',
      'maintenance',
    ],
    {
      initiatingOwner: 'admission-site',
      durableScope: 'workspace-mutation-or-coordinated-read',
      lockTransactionScope: 'tab-runtime-root-plus-variant-specific-locks',
      localPresentationEffect: 'owner-specific',
      crossTabPublication: 'commit-delta-required-on-write',
      forbiddenRemoteSteering: FORBID_REMOTE_STEERING,
      activeStreamOwnership: 'must-not-globalize-unrelated-stream-ownership',
      expectedOtherTabBehavior: 'refresh-only-authoritative-shared-data',
      status: 'gap',
      evidence: 'src/store/workspace-runtime.ts#WorkspaceRootKind',
      gap: 'Mutation roots still rely on command-specific implementations instead of one typed lock, transaction, table, and publication capability contract.',
    },
  ),
)

export const WORKSPACE_CHILD_LOCALITY = mergeRecords(
  records(['generation-finalizer', 'stream-lease', 'stream-writer'], {
    initiatingOwner: 'reservation-site',
    durableScope: 'parent-lineage-continuation',
    lockTransactionScope: 'reserved-parent-permit-then-command-specific-locks',
    localPresentationEffect: 'parent-operation-specific',
    crossTabPublication: 'commit-delta-required-on-write',
    forbiddenRemoteSteering: FORBID_REMOTE_STEERING,
    activeStreamOwnership: 'parent-lineage-only',
    expectedOtherTabBehavior: 'no-unrelated-stream-abort-no-remote-steering',
    status: 'observed',
    evidence: 'src/store/workspace-runtime.ts#reserveWorkspaceChild',
  }),
  records(['post-commit', 'prompt-save', 'attachment-localization', 'recovery-finalizer'], {
    initiatingOwner: 'reservation-site',
    durableScope: 'parent-lineage-continuation',
    lockTransactionScope: 'reserved-parent-permit-then-command-specific-locks',
    localPresentationEffect: 'parent-operation-specific',
    crossTabPublication: 'commit-delta-required-on-write',
    forbiddenRemoteSteering: FORBID_REMOTE_STEERING,
    activeStreamOwnership: 'parent-lineage-only',
    expectedOtherTabBehavior: 'no-unrelated-stream-abort-no-remote-steering',
    status: 'gap',
    evidence: 'src/store/workspace-runtime.ts#WorkspaceChildKind',
    gap: 'The declared child kind has no typed production reservation site and must be connected or removed.',
  }),
)

export const GENERATION_INTENT_LOCALITY = mergeRecords(
  records(['continue'], {
    initiatingOwner: 'tab-local',
    durableScope: 'chat-and-stream-attempt',
    lockTransactionScope: 'conversation-generation-root-plus-stream-fence',
    localPresentationEffect: 'preserve-current-tab-selection-and-append-in-place',
    crossTabPublication: 'commit-delta-required-on-write',
    forbiddenRemoteSteering: FORBID_REMOTE_STEERING,
    activeStreamOwnership: 'initiating-tab-per-stream',
    expectedOtherTabBehavior: 'observe-content-without-owning-aborting-or-following',
    status: 'observed',
    evidence:
      'GenerationIntent and ConversationOperationClaim preserve selection while one fenced stream lineage owns continuation.',
  }),
  records(['new-chat-send', 'send', 'reply', 'regenerate', 'edit-resend'], {
    initiatingOwner: 'tab-local',
    durableScope: 'chat-and-stream-attempt',
    lockTransactionScope: 'conversation-generation-root-plus-stream-fence',
    localPresentationEffect: 'select-result-only-in-initiating-tab',
    crossTabPublication: 'commit-delta-required-on-write',
    forbiddenRemoteSteering: FORBID_REMOTE_STEERING,
    activeStreamOwnership: 'initiating-tab-per-stream',
    expectedOtherTabBehavior: 'observe-shared-tree-and-stream-without-following-new-result',
    status: 'observed',
    evidence:
      'GenerationIntent, ConversationOperationClaim, and typed selection delivery bind result steering to the initiating tab.',
  }),
)

const TAB_LOCAL_POLICY = {
  initiatingOwner: 'tab-local',
  durableScope: 'tab-session-only',
  lockTransactionScope: 'none',
  localPresentationEffect: 'tab-local-navigation-or-selection',
  crossTabPublication: 'none',
  forbiddenRemoteSteering: FORBID_REMOTE_STEERING,
  activeStreamOwnership: 'none',
  expectedOtherTabBehavior: 'unaffected',
  status: 'observed',
  evidence: 'Route and cursor state live in the tab router/controller/session boundary.',
}

export const ROUTE_LOCALITY = records(
  ['chat', 'home', 'new', 'storage', 'unknown'],
  TAB_LOCAL_POLICY,
)
export const STORAGE_ROUTE_LOCALITY = records(
  ['archive', 'attachments', 'backups', 'chats', 'overview'],
  TAB_LOCAL_POLICY,
)
export const ACTIVE_BRANCH_SELECTION_LOCALITY = records(
  ['default', 'message', 'sibling-position', 'tip'],
  TAB_LOCAL_POLICY,
)
export const CONVERSATION_OPERATION_LOCALITY = records(
  ['preserve', 'select-result'],
  TAB_LOCAL_POLICY,
)
export const LOCAL_RESULT_EFFECT_LOCALITY = records(
  ['preserve', 'select-committed', 'select-transition'],
  TAB_LOCAL_POLICY,
)
export const CONVERSATION_SELECTION_DELIVERY_LOCALITY = records(
  ['route-handoff', 'session'],
  TAB_LOCAL_POLICY,
)
export const CONVERSATION_ROUTE_DELIVERY_LOCALITY = records(
  ['handoff', 'superseded'],
  TAB_LOCAL_POLICY,
)

export const WORKSPACE_CHANGE_LOCALITY = mergeRecords(
  records(['commit', 'invalidate'], {
    initiatingOwner: 'background-or-committing-tab',
    durableScope: 'cross-tab-observation',
    lockTransactionScope: 'after-commit-or-durable-verification',
    localPresentationEffect: 'projection-refresh-only',
    crossTabPublication: 'broadcast-or-durable-fallback',
    forbiddenRemoteSteering: FORBID_REMOTE_STEERING,
    activeStreamOwnership: 'observation-only',
    expectedOtherTabBehavior: 'refresh-matching-projections-and-preserve-tab-session-intent',
    status: 'gap',
    evidence: 'src/store/broadcast.ts#fanOutWorkspaceChange',
    gap: 'Payloads exclude tab intent, but consumers are not exhaustively proven incapable of recomputing and following a new default branch.',
  }),
  records(['replace'], {
    initiatingOwner: 'maintenance',
    durableScope: 'whole-workspace-replacement',
    lockTransactionScope: 'replacement-authority',
    localPresentationEffect: 'reconcile-workspace-fence',
    crossTabPublication: 'replacement-required',
    forbiddenRemoteSteering: FORBID_REMOTE_STEERING,
    activeStreamOwnership: 'must-drain-block-or-cancel-by-root-disposition',
    expectedOtherTabBehavior:
      'reconcile-new-workspace-without-adopting-another-tabs-route-or-selection',
    status: 'gap',
    evidence: 'src/store/browser-workspace-replacement-runner.ts',
    gap: 'Replacement currently drives aggregate runtime reconciliation; per-capability presentation continuity and tab-intent preservation are not one guarantee.',
  }),
)

export const WORKSPACE_DELTA_FACT_LOCALITY = records(
  [
    'attachment-row-changed',
    'attachment-row-deleted',
    'attempt-stop-requested',
    'attempt-target-committed',
    'chat-deleted',
    'conversation-created',
    'message-revision',
    'sidebar-row-changed',
    'sidebar-row-deleted',
  ],
  {
    initiatingOwner: 'committing-command',
    durableScope: 'committed-row-fact',
    lockTransactionScope: 'post-commit',
    localPresentationEffect: 'targeted-projection-update',
    crossTabPublication: 'inside-commit-delta',
    forbiddenRemoteSteering: FORBID_REMOTE_STEERING,
    activeStreamOwnership: 'observation-only',
    expectedOtherTabBehavior: 'update-only-addressed-authoritative-data',
    status: 'observed',
    evidence:
      'BrowserCommandCommit derives typed facts from physical mutation evidence and deliverLocalCommit publishes the resulting commit exactly once.',
  },
)

export const WORKSPACE_DEPENDENCY_LOCALITY = mergeRecords(
  records(
    [
      'attachment',
      'attachment-job',
      'chat',
      'child-slot',
      'discovery-cache',
      'draft',
      'folder',
      'key',
      'message-body',
      'message-header',
      'message-preview',
      'preset',
      'profile',
      'prompt-preset',
      'setting',
      'sidebar',
      'storage-maintenance',
      'stream-chunks',
      'stream-lease',
      'tag',
      'text-template',
      'workspace',
    ],
    {
      initiatingOwner: 'query-or-committing-command',
      durableScope: 'dependency-address',
      lockTransactionScope: 'none-after-publication',
      localPresentationEffect: 'invalidate-matching-projection-only',
      crossTabPublication: 'inside-commit-or-invalidate-change',
      forbiddenRemoteSteering: FORBID_REMOTE_STEERING,
      activeStreamOwnership: 'observation-only',
      expectedOtherTabBehavior: 'reload-only-subscribed-dependency',
      status: 'gap',
      evidence: 'src/store/reactive-query.ts',
      gap: 'Dependency matching is explicit, but no exhaustive consumer proof prevents a refresh from mutating route/cursor/draft/selection.',
    },
  ),
  records(['model-resolution'], {
    initiatingOwner: 'committing-command',
    durableScope: 'exact-model-resolution-target',
    lockTransactionScope: 'none-after-publication',
    localPresentationEffect: 'none',
    crossTabPublication: 'inside-commit-delta',
    forbiddenRemoteSteering: FORBID_REMOTE_STEERING,
    activeStreamOwnership: 'none',
    expectedOtherTabBehavior: 'run-only-the-bounded-model-resolution-producer',
    status: 'observed',
    evidence: 'src/store/configuration-model-resolution-capability.ts',
  }),
)

export const RUNTIME_RESOURCE_LOCALITY = mergeRecords(
  records(
    [
      'attempt-workspace',
      'mounted-projections',
      'conversation-workspace',
      'attachment-catalog-workspace',
      'configuration-workspace',
    ],
    {
      initiatingOwner: 'tab-runtime-background',
      durableScope: 'tab-local-projection-or-session',
      lockTransactionScope: 'none-or-read-permit',
      localPresentationEffect: 'mounted-tab-projection',
      crossTabPublication: 'consume-only',
      forbiddenRemoteSteering: FORBID_REMOTE_STEERING,
      activeStreamOwnership: 'observe-only',
      expectedOtherTabBehavior: 'independent-resource-instance',
      status: 'observed',
      evidence: 'src/store/workspace-runtime-control.ts#WORKSPACE_RUNTIME_RESOURCE_IDS',
    },
  ),
  records(
    [
      'broadcast-remote-inbound',
      'broadcast-fallback-verification',
      'broadcast',
      'stream-recovery',
      'generated-output-localization',
      'configuration-model-resolution',
      'storage-maintenance',
      'stream-leases',
      'browser-workspace-repository',
      'workspace-locks',
      'local-transactions',
      'browser-workspace-session',
    ],
    {
      initiatingOwner: 'tab-runtime-background',
      durableScope: 'shared-workspace-capability',
      lockTransactionScope: 'resource-specific',
      localPresentationEffect: 'indirect-capability-or-projection',
      crossTabPublication: 'resource-specific',
      forbiddenRemoteSteering: FORBID_REMOTE_STEERING,
      activeStreamOwnership: 'must-be-per-stream-or-observation-only',
      expectedOtherTabBehavior: 'no-global-serialization-of-unrelated-tabs-or-streams',
      status: 'observed',
      evidence: 'src/store/workspace-runtime-control.ts#WORKSPACE_RUNTIME_RESOURCE_IDS',
    },
  ),
)

export const STREAM_LEASE_OPERATION_LOCALITY = mergeRecords(
  records(['interruptClaimedLocalAttemptTransport'], {
    initiatingOwner: 'tab-local-stop-control',
    durableScope: 'one-claimed-local-attempt-transport',
    lockTransactionScope: 'none',
    localPresentationEffect: 'interrupt-exact-local-transport',
    crossTabPublication: 'none',
    forbiddenRemoteSteering: FORBID_REMOTE_STEERING,
    activeStreamOwnership: 'exact-local-writer-or-reservation-claim',
    expectedOtherTabBehavior: 'unaffected',
    status: 'observed',
    evidence: 'src/store/stream-leases.ts#interruptClaimedLocalAttemptTransport',
  }),
  records(
    [
      'getLocalAttemptAuthority',
      'getStreamClientId',
      'isRecoveryClaimedStreamLease',
      'streamWriteFenceForLease',
      'awaitStreamLeaseRuntimeIdle',
    ],
    {
      initiatingOwner: 'tab-runtime-or-caller',
      durableScope: 'read-or-derived-stream-state',
      lockTransactionScope: 'none',
      localPresentationEffect: 'none',
      crossTabPublication: 'none',
      forbiddenRemoteSteering: FORBID_REMOTE_STEERING,
      activeStreamOwnership: 'inspect-only',
      expectedOtherTabBehavior: 'unaffected',
      status: 'observed',
      evidence: 'src/store/stream-leases.ts',
    },
  ),
  records(
    [
      'withStreamRecoveryLocks',
      'waitForStreamOwnershipRelease',
      'runWithStreamRecoveryCoordinatorLock',
      'adoptPreparedStreamLease',
      'disposeStreamLeaseRuntime',
      'resumeStreamLeaseRuntime',
      'handle.adoptTargetCommit',
      'handle.noteSelectedKey',
      'handle.commitPostCommitMetadata',
      'handle.sealTerminal',
      'handle.retire',
      'assertStreamLeaseRuntimeClosed',
      'finishStreamCleanup',
      'observeStreamOwnershipLock',
      'releaseStreamOwnershipReservation',
      'reserveStreamOwnership',
    ],
    {
      initiatingOwner: 'stream-owner-or-recovery-background',
      durableScope: 'one-stream-or-recovery-set',
      lockTransactionScope: 'per-stream-lock-and-fenced-command',
      localPresentationEffect: 'owner-attempt-lifecycle',
      crossTabPublication: 'commit-delta-required-on-write',
      forbiddenRemoteSteering: FORBID_REMOTE_STEERING,
      activeStreamOwnership: 'explicit-per-stream',
      expectedOtherTabBehavior: 'same-stream-coordinates-unrelated-streams-run-independently',
      status: 'observed',
      evidence:
        'StreamLeaseHandle, ownership reservation, terminal sealing, and recovery locks share the same stream identity and fence.',
    },
  ),
)

export const ATTEMPT_CONTROLLER_OPERATION_LOCALITY = mergeRecords(
  records(
    [
      'subscribeDemand',
      'subscribeChat',
      'subscribeTarget',
      'demandedChatIds',
      'get',
      'getExecution',
      'getTargetAdmissionFrame',
      'getTargetSnapshot',
      'hasTargetSubscribers',
      'isTargetExecuting',
      'listChatExecutions',
      'listExecutions',
      'listRecords',
      'targetPresentationInterests',
    ],
    {
      initiatingOwner: 'tab-local',
      durableScope: 'tab-local-attempt-projection',
      lockTransactionScope: 'none',
      localPresentationEffect: 'read-or-subscribe-tab-projection',
      crossTabPublication: 'none',
      forbiddenRemoteSteering: FORBID_REMOTE_STEERING,
      activeStreamOwnership: 'observe-only',
      expectedOtherTabBehavior: 'independent-controller-instance',
      status: 'observed',
      evidence: 'src/store/attempt-controller.ts#AttemptController',
    },
  ),
  records(
    [
      'claimChatDemand',
      'observeLease',
      'reconcileLeasePoints',
      'reconcileChatLeases',
      'pruneUndemandedRemoteAttempts',
      'setPhase',
      'setLiveProjectionRequester',
      'claimStopRequest',
      'claimTarget',
      'publishExactTargetPresentations',
      'registerTargetCommitHandoff',
      'releaseTargetClaim',
      'removeStopRequest',
      'resetStopRequest',
      'publishLiveProjection',
      'clearLiveProjection',
      'remove',
      'replaceWorkspace',
      'applyLocalCommittedTransition',
    ],
    {
      initiatingOwner: 'tab-stream-owner-or-background-observer',
      durableScope: 'tab-local-projection-of-durable-attempt',
      lockTransactionScope: 'none',
      localPresentationEffect: 'mutate-tab-attempt-projection',
      crossTabPublication: 'none-directly',
      forbiddenRemoteSteering: FORBID_REMOTE_STEERING,
      activeStreamOwnership: 'local-owner-marked-separately-from-remote-observer',
      expectedOtherTabBehavior: 'remote-attempt-observed-without-owning-aborting-or-steering',
      status: 'observed',
      evidence:
        'AttemptController applies typed committed transitions and keeps live projection requesters explicitly local to one controller instance.',
    },
  ),
)

export const ROUTE_ACTION_LOCALITY = records(
  [
    'beginRouteIntent',
    'navigateForIntent',
    'cancelRouteIntent',
    'navigateToChatForIntent',
    'navigate',
    'replaceRoute',
    'navigateHome',
    'navigateNew',
    'subscribeRouteArrival',
    'subscribeRouteChange',
    'browserConversationNavigationPort.replaceConversationUrl',
  ],
  TAB_LOCAL_POLICY,
)

export const OWNER_PATH_CLASSIFICATIONS = Object.freeze({
  maintenance: Object.freeze(['src/store/storage-maintenance-runtime.ts']),
  background: Object.freeze([
    'src/store/attachment-catalog-projection.ts',
    'src/store/attachment-catalog-workspace.ts',
    'src/store/attachment-integrity-maintenance.ts',
    'src/store/attachment-reference-edges.ts',
    'src/store/attempt-terminalization.ts',
    'src/store/attempt-workspace.ts',
    'src/store/broadcast.ts',
    'src/store/browser-active-branch-spine.ts',
    'src/store/browser-catalog-command-runtime.ts',
    'src/store/browser-command-mutation-journal.ts',
    'src/store/browser-catalog-queries.ts',
    'src/store/browser-configuration-domain.ts',
    'src/store/browser-import-export.ts',
    'src/store/browser-generation-command-runtime.ts',
    'src/store/browser-mutation-runtime.ts',
    'src/store/browser-repo.ts',
    'src/store/browser-workspace-replacement-runner.ts',
    'src/store/byte-owner-mutation.ts',
    'src/store/chat-row-transition.ts',
    'src/store/child-list-projection.ts',
    'src/store/configuration-workspace.ts',
    'src/store/configuration-model-resolution-capability.ts',
    'src/store/conversation-repository-adapter.ts',
    'src/store/discovery-cache-storage.ts',
    'src/store/discovery-service.ts',
    'src/store/generated-output-localization-capability.ts',
    'src/store/generated-output-localization-runtime.ts',
    'src/store/models-cache.ts',
    'src/store/preset-order.ts',
    'src/store/storage-chat-catalog-session.ts',
    'src/store/storage-overview-controller.ts',
    'src/store/stream-chunk-writer.ts',
    'src/store/stream-journal-storage.ts',
    'src/store/stream-leases.ts',
    'src/store/stream-recovery-capability.ts',
    'src/store/stream-recovery.ts',
    'src/store/workspace-effect-hub.ts',
    'src/store/workspace-protocol.ts',
    'src/store/workspace-repository.ts',
  ]),
  'tab-local': Object.freeze([
    'src/app/Shell.tsx',
    'src/app/conversation-actions.ts',
    'src/app/router.ts',
    'src/core/messages.ts',
    'src/core/outbound-reasoning.ts',
    'src/hooks/useConversationCursor.ts',
    'src/store/attachment-bulk-delete.ts',
    'src/store/attachment-detail-session.ts',
    'src/store/attachment-search-session.ts',
    'src/store/attempt-control-application.ts',
    'src/store/attachments.ts',
    'src/store/branch-flatten.ts',
    'src/store/branch-text.ts',
    'src/store/chat-fork.ts',
    'src/store/chat-search.ts',
    'src/store/chat-sidebar-projection.ts',
    'src/store/chats.ts',
    'src/store/configuration-application.ts',
    'src/store/configuration-catalog-session.ts',
    'src/store/configuration-command-client.ts',
    'src/store/configuration-controller.ts',
    'src/store/configuration-domain.ts',
    'src/store/connection-probe-planning.ts',
    'src/store/conversation-command-client.ts',
    'src/store/conversation-controller.ts',
    'src/store/folders.ts',
    'src/store/generation-admission-controller.ts',
    'src/store/generation-capability-controller.ts',
    'src/store/generation-engine.ts',
    'src/store/generation-planning-reader.ts',
    'src/store/global-settings.ts',
    'src/store/import-export.ts',
    'src/store/keys.ts',
    'src/store/message-search-service.ts',
    'src/store/new-chat-seed.ts',
    'src/store/privacy-cache.ts',
    'src/store/presentation-interaction-controller.ts',
    'src/store/search-session.ts',
    'src/store/send-context.ts',
    'src/store/settings.ts',
    'src/store/sidebar-preferences.ts',
    'src/store/sidebar-session.ts',
    'src/store/structural-undo-repository.ts',
    'src/store/tags.ts',
    'src/ui/header/ConnectionHeader.tsx',
    'src/ui/sidebar/ChatList.tsx',
    'src/ui/storage/StorageView.tsx',
  ]),
})

export const PUBLICATION_CONSUMER_FILES = Object.freeze({
  'src/store/attachment-catalog-workspace.ts': 'attachment-catalog-projection-refresh',
  'src/store/attachment-detail-session.ts': 'attachment-detail-projection-refresh',
  'src/store/attachment-search-session.ts': 'attachment-search-projection-refresh',
  'src/store/attempt-workspace.ts': 'attempt-projection-refresh',
  'src/store/configuration-workspace.ts': 'configuration-projection-refresh',
  'src/store/configuration-model-resolution-capability.ts': 'configuration-model-resolution-demand',
  'src/store/conversation-repository-adapter.ts': 'conversation-projection-refresh',
  'src/store/generated-output-localization-capability.ts': 'generated-output-job-demand',
  'src/store/generated-output-localization-runtime.ts': 'generated-output-job-wakeup',
  'src/store/prompt-estimate-context-controller.ts': 'prompt-estimate-context-refresh',
  'src/store/search-session.ts': 'sidebar-search-projection-refresh',
  'src/store/sidebar-session.ts': 'sidebar-presentation-refresh',
  'src/store/storage-chat-catalog-session.ts': 'storage-chat-catalog-refresh',
  'src/store/storage-maintenance-runtime.ts': 'maintenance-wakeup',
  'src/store/storage-overview-controller.ts': 'storage-overview-refresh',
  'src/store/stream-leases.ts': 'stream-stop-control-wakeup',
  'src/store/stream-recovery-capability.ts': 'stream-recovery-demand',
  'src/store/stream-recovery.ts': 'stream-recovery-refresh',
})

export const REMOTE_LOCALITY_BROWSER_OUTCOME_MATRIX = Object.freeze([
  remoteBrowserOutcome(
    'conversation',
    ['src/store/conversation-repository-adapter.ts'],
    [
      remoteBrowserJourney(
        'tests/e2e/concurrent-ops.spec.ts',
        "test('a remote extension then newer sibling keeps each tab on its own branch without flashing'",
      ),
    ],
  ),
  remoteBrowserOutcome(
    'catalogs',
    [
      'src/store/search-session.ts',
      'src/store/sidebar-session.ts',
      'src/store/storage-chat-catalog-session.ts',
    ],
    [
      remoteBrowserJourney(
        'tests/e2e/reactive-storage-stress.spec.ts',
        "test('reactive storage survives lifecycle churn, abort, reload, and peer writes exactly'",
      ),
    ],
  ),
  remoteBrowserOutcome(
    'configuration',
    [
      'src/store/configuration-model-resolution-capability.ts',
      'src/store/configuration-workspace.ts',
      'src/store/prompt-estimate-context-controller.ts',
    ],
    [
      remoteBrowserJourney(
        'tests/e2e/reactive-storage-stress.spec.ts',
        "test('reactive storage survives lifecycle churn, abort, reload, and peer writes exactly'",
      ),
    ],
  ),
  remoteBrowserOutcome(
    'attachments',
    [
      'src/store/attachment-catalog-workspace.ts',
      'src/store/attachment-detail-session.ts',
      'src/store/attachment-search-session.ts',
      'src/store/generated-output-localization-capability.ts',
      'src/store/generated-output-localization-runtime.ts',
      'src/store/storage-overview-controller.ts',
    ],
    [
      remoteBrowserJourney(
        'tests/e2e/attachment-manager.spec.ts',
        "test('remote attachment publication refreshes projections without steering an active chat'",
      ),
      remoteBrowserJourney(
        'tests/e2e/full-generation-routing.spec.ts',
        "test('GUI OpenRouter video model uses parent /endpoints architecture for UI and send routing'",
      ),
    ],
  ),
  remoteBrowserOutcome(
    'attempts',
    [
      'src/store/attempt-workspace.ts',
      'src/store/stream-leases.ts',
      'src/store/stream-recovery-capability.ts',
      'src/store/stream-recovery.ts',
    ],
    [
      remoteBrowserJourney(
        'tests/e2e/concurrent-ops.spec.ts',
        "test('two tabs streaming different chats run in parallel without aborting each other'",
      ),
      remoteBrowserJourney(
        'tests/e2e/stream-ownership-admission.spec.ts',
        "test('a remote Stop request converges and the branch admits the next generation'",
      ),
    ],
  ),
  remoteBrowserOutcome(
    'maintenance-replacement',
    ['src/store/storage-maintenance-runtime.ts'],
    [
      remoteBrowserJourney(
        'tests/e2e/attachment-manager.spec.ts',
        "test('remote attachment publication refreshes projections without steering an active chat'",
      ),
      remoteBrowserJourney(
        'tests/e2e/storage-reclamation.spec.ts',
        "test('normal use catches up foreground work without repeating the physical copy and preserves two-tab state'",
      ),
      remoteBrowserJourney(
        'tests/e2e/storage-reclamation.spec.ts',
        "test('clear all reloads into a fresh workspace that can fetch and select models again'",
        true,
      ),
    ],
  ),
])

export const ARCHITECTURE_GAPS = Object.freeze({
  'command-lock-and-transaction-scope-is-not-one-protocol':
    'The 64 workspace and 51 configuration commands do not declare exact lock, transaction, table, retry, and publication locality in one enforced typed capability contract.',
  'remote-refresh-cannot-steer-is-not-proven':
    'Broadcast payloads omit route/cursor/draft/selection, but every projection consumer is not proven incapable of recomputing and adopting a remote newest branch.',
  'declared-protocol-variants-can-be-unreachable':
    'Ten configuration commands and four workspace child kinds are declared without a typed production constructor or reservation site.',
})

export const SCANNER_LIMITATIONS = Object.freeze([
  'Typed constructor discovery sees assignable object literals; computed kinds, opaque helper returns, spreads without a recoverable contextual type, and values crossing an untyped boundary are not inferred.',
  'A constructor or admission location identifies the immediate producer, not necessarily the human interaction, scheduler, or remote event that initiated the full call chain.',
  'Workspace root and child sites require a literal kind argument; dynamically forwarded kinds remain unobserved and must be represented as explicit site gaps or replaced by a typed wrapper protocol.',
  'Route-action discovery is an intra-file call-graph heuristic rooted at history writes and route-intent mutation; it does not prove behavior of external wrappers or browser-native navigation after an unmodified click.',
  'Stream-lease operation discovery covers exported non-test functions plus StreamLeaseHandle methods; private scheduler, writer, and cleanup transitions remain implementation details rather than separately classified ingress.',
  'Attempt-controller operation discovery covers the public AttemptController interface; private projection/index maintenance is not treated as a separate callable locality surface.',
  'Publication-consumer discovery sees direct subscribeWorkspaceEffects identifier calls; aliases, dependency injection, reflective calls, and consumers behind a future adapter require a scanner update before inventory closure.',
  'Dispatch coverage recognizes the exact query.kind and command.kind switches plus the source-derived complement of the typed BrowserInlineQuery boundary; a new delegation form must update that type boundary rather than being silently accepted.',
  'Static classification does not prove runtime ordering, lock granularity, transaction atomicity, event-loop fairness, visual continuity, or the absence of consumer-side steering; those remain executable acceptance obligations.',
])

export const INVENTORY_CLOSURE_ACCEPTANCE = Object.freeze([
  {
    id: 'all-surfaces-exact',
    metric: 'structurallyValid',
    target: true,
    requirement:
      'Every declared variant, public operation, route/cursor action, change fact, dependency, and runtime resource has exactly one locality record.',
  },
  {
    id: 'all-sites-owner-classified',
    metric: 'ownerSiteGaps',
    target: 0,
    requirement:
      'Every typed constructor, root admission, and child reservation site has an explicit tab-local, background, or maintenance initiating-owner classification.',
  },
  {
    id: 'no-unreachable-declarations',
    metric: 'unconstructedOrUnadmittedSites',
    target: 0,
    requirement:
      'Every declared command/fact/root/child is reachable from a typed production ingress or is removed; absence cannot be waived at closure.',
  },
  {
    id: 'no-record-guarantee-gaps',
    metric: 'recordGaps',
    target: 0,
    requirement:
      'Every record has an observed architecture proof for lock/transaction scope, publication, presentation, stream ownership, and other-tab behavior.',
  },
  {
    id: 'no-architecture-class-gaps',
    metric: 'architectureGaps',
    target: 0,
    requirement:
      'The shared write, publication, no-steering, lifecycle-capability, reachability, stream-ownership, fallback, and test-contract gaps are eliminated.',
  },
  {
    id: 'commit-derived-semantic-publication',
    metric: 'committed-write-semantic-delta-is-manual',
    target: false,
    requirement:
      'Committed physical mutations already gate publication automatically; exact local receipts and cross-tab semantic deltas must also be derived so callers cannot omit or misclassify them.',
  },
  {
    id: 'remote-no-steering-boundary',
    metric: 'remote-refresh-cannot-steer-is-not-proven',
    target: false,
    requirement:
      'Remote commits and broad fallback invalidations can refresh shared projections but cannot mutate another tab route, cursor, draft, selection, or active operation handoff.',
  },
  {
    id: 'per-capability-runtime-readiness',
    metric: 'aggregate-runtime-globalizes-capabilities',
    target: false,
    requirement:
      'Slow, failed, quiescing, or reopening resources disable only their capability; the shell, tab-local navigation, and unrelated stream controls stay immediately interactive.',
  },
  {
    id: 'independent-stream-ownership',
    metric: 'stream-ownership-spans-separate-protocols',
    target: false,
    requirement:
      'Generation intent through finalization is one per-stream ownership state machine; tabs can stream independently and only same-stream recovery coordinates ownership.',
  },
  {
    id: 'per-variant-other-tab-tests',
    metric: 'other-tab-outcomes-are-not-executable-contracts',
    target: false,
    requirement:
      'Generated or equivalent integration coverage checks the expected other-tab result for every durable command and stream transition, including broad fallback invalidation.',
  },
  {
    id: 'publication-addressing-matrix-generated',
    metric: 'publication-addressing-matrix-generated',
    target: true,
    requirement:
      'Every direct workspace-effect consumer is source-derived into the complete fact and dependency addressing matrix without a separately maintained consumer selector table.',
  },
  {
    id: 'bounded-locality-work',
    metric: 'performance-locality-proof',
    target: true,
    requirement:
      'Cross-tab delivery, dependency matching, route/cursor preservation, and stream ownership add bounded or linear work and do not introduce workspace-wide serialization or retention maps.',
  },
  {
    id: 'scanner-limitations-closed-or-covered',
    metric: 'scannerLimitations',
    target: 0,
    requirement:
      'Each static scanner limitation is either eliminated by a typed architecture or covered by a deterministic complementary audit and executable test before closure.',
  },
])

export const REQUIRED_LOCALITY_FIELDS = Object.freeze([
  'initiatingOwner',
  'durableScope',
  'lockTransactionScope',
  'localPresentationEffect',
  'crossTabPublication',
  'forbiddenRemoteSteering',
  'activeStreamOwnership',
  'expectedOtherTabBehavior',
  'status',
  'evidence',
])

function remoteBrowserOutcome(id, consumers, journeys) {
  return Object.freeze({
    id,
    consumers: Object.freeze(consumers),
    journeys: Object.freeze(journeys),
  })
}

function remoteBrowserJourney(path, locator, targetMayDisappear = false) {
  return Object.freeze({
    path,
    locator,
    targetMayDisappear,
    outcomes: Object.freeze(
      targetMayDisappear
        ? ['deterministic-local-fallback', 'no-producer-route-copy', 'shared-projection-refresh']
        : [
            'draft-local',
            'focus-local',
            'route-local',
            'scroll-local',
            'selection-local',
            'shared-projection-refresh',
            'stream-local',
          ],
    ),
  })
}
