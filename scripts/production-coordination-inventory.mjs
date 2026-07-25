function entries(metadataFor, ids) {
  return Object.freeze(ids.map((id) => Object.freeze({ id, ...metadataFor(id) })))
}

function exactSiteContracts(groups) {
  const contracts = {}
  for (const { ids, ...contract } of groups) {
    for (const id of ids) {
      if (contracts[id]) throw new Error(`CoordinationSiteContractDuplicate:${id}`)
      contracts[id] = Object.freeze(contract)
    }
  }
  return Object.freeze(contracts)
}

const MODULE_MUTABLE_IDS = Object.freeze([
  'src/app/conversation-actions-capability.ts#loaded',
  'src/app/router.ts#committedRouteSnapshot',
  'src/app/router.ts#currentRouteIntent',
  'src/app/router.ts#hashListenerInstalled',
  'src/app/router.ts#routeArrivalRevision',
  'src/app/router.ts#routeArrivalSnapshot',
  'src/core/branch-session.ts#emptyPath',
  'src/core/word-count.ts#segmenter',
  'src/lib/debug-scroll.ts#debugSink',
  'src/lib/debug-streams.ts#requestPlanDebugSink',
  'src/lib/debug-streams.ts#seq',
  'src/lib/debug-streams.ts#streamDebugSink',
  'src/lib/page-lifecycle.ts#pageHiding',
  'src/lib/yield-to-event-loop.ts#yieldChannel',
  'src/store/attachment-catalog-workspace.ts#adapter',
  'src/store/attachment-object-url.ts#acceptedWorkspaceFence',
  'src/store/attachment-object-url.ts#generation',
  'src/store/attempt-workspace.ts#idlePromise',
  'src/store/attempt-workspace.ts#projection',
  'src/store/attempt-workspace.ts#startPromise',
  'src/store/broadcast.ts#broadcastAdmissionsOpen',
  'src/store/broadcast.ts#channel',
  'src/store/broadcast.ts#channelUnavailable',
  'src/store/broadcast.ts#deliveredWorkspaceFence',
  'src/store/broadcast.ts#durableVerificationInFlight',
  'src/store/broadcast.ts#durableVerificationGeneration',
  'src/store/broadcast.ts#durableVerificationPromise',
  'src/store/broadcast.ts#durableVerificationRequested',
  'src/store/broadcast.ts#fallbackSnapshotReader',
  'src/store/broadcast.ts#fallbackVerificationActive',
  'src/store/broadcast.ts#fallbackVerificationAdmissionsOpen',
  'src/store/broadcast.ts#lifecycleListenersInstalled',
  'src/store/broadcast.ts#productionFallbackSnapshotReader',
  'src/store/broadcast.ts#remoteInboundAdmissionsOpen',
  'src/store/broadcast.ts#remoteWorkspaceChangeMissed',
  'src/store/broadcast.ts#storageListenerInstalled',
  'src/store/browser-import-export.ts#materializationMetrics',
  'src/store/browser-repo.ts#singleton',
  'src/store/browser-workspace-database-selection.ts#currentSelection',
  'src/store/browser-workspace-database-selection.ts#selectionPromise',
  'src/store/browser-workspace-lifecycle.ts#activeDatabaseSelection',
  'src/store/browser-workspace-lifecycle.ts#browserWorkspaceLifecycleInstallation',
  'src/store/browser-workspace-lifecycle.ts#currentOpenAttempt',
  'src/store/browser-workspace-lifecycle.ts#fatalWorkspaceReloadScheduled',
  'src/store/browser-workspace-lifecycle.ts#invalidatedWorkspaceSession',
  'src/store/browser-workspace-lifecycle.ts#nextOpenAttemptId',
  'src/store/browser-workspace-lifecycle.ts#shutdownTransition',
  'src/store/browser-workspace-lifecycle.ts#terminalLifecycleFinalization',
  'src/store/browser-workspace-replacement-runner.ts#reopenBrowserWorkspace',
  'src/store/browser-workspace-slot-coordination.ts#activeLease',
  'src/store/browser-workspace-slot-coordination.ts#coordinatorOwner',
  'src/store/configuration-workspace.ts#adapter',
  'src/store/conversation-workspace.ts#adapter',
  'src/store/db.ts#activeBrowserWorkspaceRepositoryOperations',
  'src/store/db.ts#browserWorkspaceAdmissionsOpen',
  'src/store/db.ts#browserWorkspaceFatalInvalidationOwner',
  'src/store/db.ts#browserWorkspaceRepositoryAdmissionsOpen',
  'src/store/db.ts#browserWorkspaceRepositoryIdlePromise',
  'src/store/db.ts#configuredBrowserWorkspaceDatabaseName',
  'src/store/db.ts#currentSession',
  'src/store/db.ts#invalidatedSession',
  'src/store/db.ts#nextSessionGeneration',
  'src/store/db.ts#resolveBrowserWorkspaceRepositoryIdle',
  'src/store/db.ts#singleton',
  'src/store/generated-output-localization-runtime.ts#accepting',
  'src/store/generated-output-localization-runtime.ts#generation',
  'src/store/generated-output-localization-runtime.ts#pumpAgain',
  'src/store/generated-output-localization-runtime.ts#pumpPromise',
  'src/store/generated-output-localization-runtime.ts#runtimeController',
  'src/store/generated-output-localization-runtime.ts#stopChanges',
  'src/store/generated-output-localization-runtime.ts#wakeTimer',
  'src/store/generated-output-localization-runtime.ts#wakeTimerAt',
  'src/store/generated-output-localization-capability.ts#activeCycle',
  'src/store/generated-output-localization-capability.ts#attachedFence',
  'src/store/generated-output-localization-capability.ts#runtime',
  'src/store/generated-output-localization-capability.ts#runtimeLoad',
  'src/store/generated-output-localization-capability.ts#runtimeResumed',
  'src/store/generated-output-localization-capability.ts#unsubscribeEffects',
  'src/store/locks.ts#activeLockRuns',
  'src/store/locks.ts#backendOverride',
  'src/store/locks.ts#disposedBackendDrain',
  'src/store/locks.ts#fallbackBackend',
  'src/store/locks.ts#lockRuntimeController',
  'src/store/locks.ts#lockRuntimeDisposed',
  'src/store/locks.ts#lockRuntimeIdle',
  'src/store/locks.ts#lockWakeChannel',
  'src/store/locks.ts#lockWakeChannelUnavailable',
  'src/store/locks.ts#productionDatabaseRunner',
  'src/store/locks.ts#resolveLockRuntimeIdle',
  'src/store/mounted-projection-lifecycle.ts#fence',
  'src/store/mounted-projection-lifecycle.ts#idlePromise',
  'src/store/mounted-projection-lifecycle.ts#nextProjectionId',
  'src/store/mounted-projection-lifecycle.ts#pendingReconcile',
  'src/store/mounted-projection-lifecycle.ts#phase',
  'src/store/mounted-projection-lifecycle.ts#physicalReads',
  'src/store/mounted-projection-lifecycle.ts#readEpoch',
  'src/store/mounted-projection-lifecycle.ts#resolveIdle',
  'src/store/quota.ts#persistOncePromise',
  'src/store/storage-compaction-state.ts#activePhysicalMutationLedgers',
  'src/store/storage-compaction-state.ts#pendingCompletedPhysicalMutationLedgers',
  'src/store/storage-compaction-state.ts#physicalMutationDebtClosing',
  'src/store/storage-compaction-state.ts#physicalMutationDebtFailure',
  'src/store/storage-compaction-state.ts#physicalMutationDebtIdle',
  'src/store/storage-compaction-state.ts#physicalMutationDebtRecoveryHandoff',
  'src/store/storage-compaction-state.ts#physicalMutationDebtWork',
  'src/store/storage-compaction-state.ts#physicalMutationIntentOutstanding',
  'src/store/storage-compaction-state.ts#physicalMutationIntentOwnerController',
  'src/store/storage-compaction-state.ts#physicalMutationIntentOwnerFailure',
  'src/store/storage-compaction-state.ts#physicalMutationIntentOwnerStart',
  'src/store/storage-compaction-state.ts#physicalMutationIntentOwnerTask',
  'src/store/storage-compaction-state.ts#physicalMutationLedgers',
  'src/store/storage-compaction-state.ts#physicalMutationTransactionDatabaseNames',
  'src/store/storage-compaction-state.ts#resolvePhysicalMutationDebtIdle',
  'src/store/storage-maintenance-runtime.ts#storageMaintenanceRuntimeState',
  'src/store/stream-leases.ts#currentWorkspaceFence',
  'src/store/stream-leases.ts#heartbeatDeadline',
  'src/store/stream-leases.ts#heartbeatTimer',
  'src/store/stream-leases.ts#lockManagerOverride',
  'src/store/stream-leases.ts#resolveStreamLeaseRuntimeIdle',
  'src/store/stream-leases.ts#streamLeaseRuntimeDisposed',
  'src/store/stream-leases.ts#streamLeaseRuntimeIdle',
  'src/store/stream-leases.ts#streamRuntimeWork',
  'src/store/stream-leases.ts#unsubscribeStopControl',
  'src/store/stream-recovery-capability.ts#activeCycle',
  'src/store/stream-recovery-capability.ts#attachedFence',
  'src/store/stream-recovery-capability.ts#runtime',
  'src/store/stream-recovery-capability.ts#runtimeLoad',
  'src/store/stream-recovery-capability.ts#runtimeResumed',
  'src/store/stream-recovery-capability.ts#unsubscribeEffects',
  'src/store/stream-recovery.ts#accepting',
  'src/store/stream-recovery.ts#coordinatorAbortController',
  'src/store/stream-recovery.ts#coordinatorCycle',
  'src/store/stream-recovery.ts#coordinatorPromise',
  'src/store/stream-recovery.ts#coordinatorWorkspaceId',
  'src/store/stream-recovery.ts#fullLeaseScanCause',
  'src/store/stream-recovery.ts#fullLeaseScanRequested',
  'src/store/stream-recovery.ts#installed',
  'src/store/stream-recovery.ts#leaseReadPromise',
  'src/store/stream-recovery.ts#leaseTimer',
  'src/store/stream-recovery.ts#leaseTimerAt',
  'src/store/stream-recovery.ts#pumpScheduled',
  'src/store/stream-recovery.ts#recoveryAbortController',
  'src/store/stream-recovery.ts#recoveryRunsIdle',
  'src/store/stream-recovery.ts#recoveryRuntimeCycle',
  'src/store/stream-recovery.ts#recoveryRuntimeEnabled',
  'src/store/stream-recovery.ts#recoveryWorkspace',
  'src/store/stream-recovery.ts#resolveRecoveryRunsIdle',
  'src/store/stream-recovery.ts#running',
  'src/store/stream-recovery.ts#stopChanges',
  'src/store/transaction-activity.ts#acceptingActivity',
  'src/store/transaction-activity.ts#activePhase',
  'src/store/transaction-activity.ts#idlePromise',
  'src/store/transaction-activity.ts#resolveIdle',
  'src/store/workspace-presentation-lifecycle.ts#generation',
  'src/store/workspace-presentation-lifecycle.ts#pending',
  'src/store/workspace-presentation-lifecycle.ts#root',
  'src/store/workspace-effect-hub.ts#attachedRepository',
  'src/store/workspace-effect-hub.ts#fatalFailureHandler',
  'src/store/workspace-effect-hub.ts#stopRepositoryChanges',
  'src/store/workspace-repository.ts#deliveredRepository',
  'src/store/workspace-repository.ts#deliveredTarget',
  'src/store/workspace-repository.ts#override',
  'src/store/workspace-repository.ts#repositoryFactory',
  'src/store/workspace-tab-session.ts#reconciledWorkspaceFence',
  'src/store/workspace-tab-session.ts#revision',
  'src/store/workspace-tab-session.ts#snapshot',
  'src/store/zustand/announcementStore.ts#counter',
  'src/store/zustand/toastStore.ts#counter',
  'src/ui/chat/BranchTreeInspector.tsx#branchTreeInspectorComputationProbe',
  'src/ui/chat/BranchTreePreview.tsx#measureContext',
  'src/ui/chat/BranchTreePreview.tsx#measureFont',
  'src/ui/chat/BranchTreeView.tsx#branchTreeComputationProbe',
  'src/ui/chat/Message.tsx#messageRenderProbe',
  'src/ui/chat/shiki-code-plugin.ts#highlighterPromise',
  'src/ui/import-export/json-file.ts#jsonIoMetrics',
])

export const MODULE_COLLECTION_CONTRACTS = Object.freeze({
  ...exactSiteContracts([
    {
      ids: [
        'src/backcompat/canonical-stream-event-v1.ts#AUDIO_FORMATS',
        'src/backcompat/canonical-stream-event-v1.ts#CONTENT_ANNOTATION_SOURCES',
        'src/backcompat/canonical-stream-event-v1.ts#GENERATION_FAILURE_KINDS',
        'src/backcompat/canonical-stream-event-v1.ts#INPUT_AUDIO_FORMATS',
        'src/backcompat/canonical-stream-event-v1.ts#INTEGRITY_ADAPTERS',
        'src/backcompat/canonical-stream-event-v1.ts#PROVIDER_OUTPUT_DIALECTS',
        'src/backcompat/canonical-stream-event-v1.ts#REASONING_FORMATS_V1',
        'src/backcompat/canonical-stream-event-v1.ts#REASONING_ORIGIN_DIALECTS_V1',
        'src/backcompat/canonical-stream-event-v1.ts#SERVER_TOOL_SOURCES',
        'src/backcompat/reasoning-carriers-v80.ts#REASONING_FORMATS_V80',
        'src/backcompat/reasoning-contract-normalizer-v92.ts#REASONING_BRIDGES',
        'src/backcompat/reasoning-contract-normalizer-v92.ts#REASONING_DIALECTS',
        'src/backcompat/reasoning-contract-normalizer-v92.ts#REASONING_FORMATS',
        'src/backcompat/reasoning-envelope-v1.ts#REASONING_FORMATS',
        'src/backcompat/reasoning-envelope-v1.ts#REASONING_ORIGIN_DIALECTS',
        'src/backcompat/reasoning-envelope-v89.ts#ORIGIN_DIALECTS',
        'src/backcompat/stream-lease-schema-versions.ts#V89_FAILURE_CATEGORIES',
        'src/backcompat/stream-lease-schema-versions.ts#V89_FAILURE_KINDS',
        'src/backcompat/stream-lease-schema-versions.ts#V89_TERMINAL_DECISION_KEYS',
        'src/backcompat/stream-lease-schema-versions.ts#V89_TERMINAL_FAILURE_KEYS',
        'src/backcompat/stream-lease-schema-versions.ts#V89_TERMINAL_RECEIPT_KEYS',
        'src/backcompat/wave-a-storage-epoch-v94.ts#SENTINEL_WORKSPACE_IDS',
        'src/core/canonical-stream-event.ts#AUDIO_FORMATS',
        'src/core/canonical-stream-event.ts#CONTENT_ANNOTATION_SOURCES',
        'src/core/canonical-stream-event.ts#GENERATION_FAILURE_KINDS',
        'src/core/canonical-stream-event.ts#INPUT_AUDIO_FORMATS',
        'src/core/canonical-stream-event.ts#INTEGRITY_ADAPTERS',
        'src/core/canonical-stream-event.ts#PROVIDER_OUTPUT_DIALECTS',
        'src/core/canonical-stream-event.ts#SERVER_TOOL_SOURCES',
        'src/core/continuation-content.ts#EMPTY_CONTINUATION_ATTEMPTS',
        'src/core/continuation-content.ts#EMPTY_TOOL_CALLS',
        'src/core/effective-endpoint-routing.ts#ROUTING_SOURCES',
        'src/core/import-export/row-validation.ts#INPUT_MODALITIES',
        'src/core/import-export/row-validation.ts#MESSAGE_PHASES',
        'src/core/import-export/row-validation.ts#OUTPUT_MODALITIES',
        'src/core/import-export/row-validation.ts#PREFILL_CAPABILITY_KINDS',
        'src/core/import-export/row-validation.ts#PREFILL_MARKERS',
        'src/core/import-export/row-validation.ts#STREAMING_CAPABILITIES',
        'src/core/provider-tool-context.ts#PROVIDER_OUTPUT_DIALECTS',
        'src/core/provider-tool-context.ts#TOOL_EVIDENCE_KEYS',
        'src/core/quirks.ts#GEMINI_DROPS_SAMPLING_PARAMS',
        'src/core/quirks.ts#PREFILL_UNSUPPORTED_GEMINI_MODELS',
        'src/core/reasoning-envelope.ts#REASONING_FORMATS',
        'src/core/reasoning-envelope.ts#REASONING_ORIGIN_DIALECTS',
        'src/core/reasoning-envelope.ts#REASONING_PRODUCER_BRIDGES',
        'src/core/reasoning.ts#EMPTY_MESSAGE_CONTEXT_ROUTE_FACTS',
        'src/core/reasoning.ts#REASONING_FORMATS',
        'src/store/attempt-controller.ts#EMPTY_EXECUTIONS',
        'src/store/branch-tree-search-session.ts#EMPTY_MATCHES',
        'src/store/conversation-controller.ts#EMPTY_EXACT_TARGET_PRESENTATION_RECEIPTS',
        'src/store/stream-journal-codec.ts#STREAM_JOURNAL_COMMIT_FRAME_KEYS',
        'src/store/stream-journal-codec.ts#STREAM_JOURNAL_INLINE_FRAME_KEYS',
        'src/store/stream-journal-codec.ts#STREAM_JOURNAL_PAGE_FRAME_KEYS',
      ],
      bound: 'static immutable lookup or empty value',
      cleanup: 'process-lifetime immutable value; no runtime entries',
      scope: 'module-static',
    },
  ]),
  'src/api/client.ts#responseBodyContracts': {
    bound: 'weak response contracts',
    cleanup: 'garbage collection releases weak entries; explicit reset drops the owner slot',
    scope: 'module-registry',
  },
  'src/api/request-transforms.ts#ENVELOPE_KEYS': {
    bound: 'static wire lookup',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/api/request-transforms.ts#RESPONSES_ENVELOPE_KEYS': {
    bound: 'static wire lookup',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/api/sse.ts#SAFE_RESPONSES_EVENT_TYPES': {
    bound: 'static event lookup',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/app/router.ts#routeArrivalSubscribers': {
    bound: 'live route subscribers',
    cleanup: 'paired unsubscribe removes each listener; owner teardown clears the registry',
    scope: 'module-registry',
  },
  'src/app/router.ts#routeSnapshotSubscribers': {
    bound: 'live route subscribers',
    cleanup: 'paired unsubscribe removes each listener; owner teardown clears the registry',
    scope: 'module-registry',
  },
  'src/backcompat/generation-attempt-outcomes.ts#GENERATION_STATUSES': {
    bound: 'static migration lookup',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/backcompat/generation-attempt-outcomes.ts#INTEGRITY_STATES': {
    bound: 'static migration lookup',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/core/attachments/process-runtime.ts#ARCHIVE_MIMES': {
    bound: 'static MIME lookup',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/core/attachments/process-runtime.ts#CODE_EXTENSIONS': {
    bound: 'static extension lookup',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/core/attachments/process-runtime.ts#CODE_MIMES': {
    bound: 'static MIME lookup',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/core/attachments/process-runtime.ts#DOCUMENT_MIMES': {
    bound: 'static MIME lookup',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/core/attachments/process-runtime.ts#OFFICE_PACKAGE_MIMES': {
    bound: 'static MIME lookup',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/core/attachments/process-runtime.ts#OPEN_DOCUMENT_MIMES': {
    bound: 'static MIME lookup',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/core/attachments/process-runtime.ts#PRESENTATION_MIMES': {
    bound: 'static MIME lookup',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/core/attachments/process-runtime.ts#SPREADSHEET_MIMES': {
    bound: 'static MIME lookup',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/core/attachments/process-runtime.ts#TEXT_EXTRACTABLE_MIMES': {
    bound: 'static MIME lookup',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/core/attempt-outcome.ts#FAILURE_CATEGORIES': {
    bound: 'static outcome lookup',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/core/attempt-outcome.ts#INTEGRITY_ADAPTERS': {
    bound: 'static outcome lookup',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/core/attempt-outcome.ts#INTEGRITY_CATEGORIES': {
    bound: 'static outcome lookup',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/core/defaults.ts#DEFAULT_CHAT_SETTINGS': {
    bound: 'immutable default settings',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/core/global-settings.ts#DEFAULT_GLOBAL_PREFERENCES': {
    bound: 'immutable default preferences',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/core/import-export/row-validation.ts#ATTACHMENT_KINDS': {
    bound: 'static import validation lookup',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/core/import-export/row-validation.ts#ATTACHMENT_ORIGINS': {
    bound: 'static import validation lookup',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/core/import-export/row-validation.ts#CONNECTION_KINDS': {
    bound: 'static import validation lookup',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/core/import-export/row-validation.ts#CONTENT_TYPES': {
    bound: 'static import validation lookup',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/core/import-export/row-validation.ts#GENERATION_APIS': {
    bound: 'static import validation lookup',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/core/import-export/row-validation.ts#GENERATION_STATUSES': {
    bound: 'static import validation lookup',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/core/import-export/row-validation.ts#MESSAGE_ORIGINS': {
    bound: 'static import validation lookup',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/core/import-export/row-validation.ts#MESSAGE_ROLES': {
    bound: 'static import validation lookup',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/core/import-export/row-validation.ts#PROMPT_PRESET_KINDS': {
    bound: 'static import validation lookup',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/core/model-ids.ts#DECORATION_PROVIDERS': {
    bound: 'static model lookup',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/core/model-ids.ts#TOKENIZER_FAMILY_KEY_SET': {
    bound: 'static model lookup',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/core/prompt-size.ts#EMPTY_FROZEN_MESSAGE_IDS': {
    bound: 'immutable empty value',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/core/provider-tool-context.ts#KNOWN_PROVIDER_TOOL_OUTPUT_TYPES': {
    bound: 'static context lookup',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/core/provider-tool-context.ts#OPENAI_RESPONSES_CONTEXT_TYPES': {
    bound: 'static context lookup',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/core/quirks.ts#CLAUDE_ADAPTIVE_ONLY_QUIRKS': {
    bound: 'static model quirks',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/core/quirks.ts#REASONING_REQUIRED_MODELS': {
    bound: 'static model lookup',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/core/quirks.ts#REGISTRY': {
    bound: 'static model quirks',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/core/reasoning.ts#OPENAI_RESPONSES_FAMILY': {
    bound: 'static reasoning lookup',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/core/search-query.ts#IS_VALUES': {
    bound: 'static search lookup',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/core/search-query.ts#SEARCH_AUTOMATA': {
    bound: 'weak compiled search automata',
    cleanup: 'garbage collection releases weak entries; explicit reset drops the owner slot',
    scope: 'module-registry',
  },
  'src/core/sidebar-sort.ts#VALID_SIDEBAR_SORT_MODES': {
    bound: 'static preference lookup',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/core/text-templates.ts#ALPACA': {
    bound: 'static text template',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/core/text-templates.ts#EMPTY_LEGACY_TEXT_TEMPLATE': {
    bound: 'immutable empty value',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/hooks/useModelCatalog.ts#DEFAULT_PROXY': {
    bound: 'immutable default projection',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/hooks/useStreamStablePromptEstimate.ts#EMPTY_MESSAGE_IDS': {
    bound: 'immutable empty value',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/hooks/useTextTemplateLibrary.ts#EMPTY_TEXT_TEMPLATE_LIBRARY': {
    bound: 'immutable empty value',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/lib/diagnostic-redaction.ts#SENSITIVE_KEYS': {
    bound: 'static redaction lookup',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/lib/preload-recovery.ts#recoveredWithoutStorage': {
    bound: 'bounded build recovery tokens',
    cleanup: 'the stated finite cap, eviction policy, or explicit reset bounds retention',
    scope: 'module-registry',
  },
  'src/lib/yield-to-event-loop.ts#yieldResolvers': {
    bound: 'currently pending cooperative yields',
    cleanup:
      'completion, cancellation, unsubscribe, or workspace quiesce removes each active entry',
    scope: 'module-registry',
  },
  'src/store/attachment-object-url.ts#activeObjectUrls': {
    bound: 'mounted object URL leases',
    cleanup:
      'completion, cancellation, unsubscribe, or workspace quiesce removes each active entry',
    scope: 'module-registry',
  },
  'src/store/attachment-object-url.ts#generationListeners': {
    bound: 'object URL generation subscribers',
    cleanup: 'paired unsubscribe removes each listener; owner teardown clears the registry',
    scope: 'module-registry',
  },
  'src/store/attempt-controller.ts#EMPTY_CHAT_IDS': {
    bound: 'immutable empty value',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/store/broadcast.ts#workspaceChangeSubs': {
    bound: 'live changefeed subscribers',
    cleanup: 'paired unsubscribe removes each listener; owner teardown clears the registry',
    scope: 'module-registry',
  },
  'src/store/broadcast.ts#workspaceApplicationChangeSubs': {
    bound: 'application-lifetime workspace change subscribers',
    cleanup: 'exact application-owner unsubscribe removes each listener',
    scope: 'module-registry',
  },
  'src/store/browser-repo.ts#CALIBRATION_MESSAGE_PATCH_KEYS': {
    bound: 'static mutation guard',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/store/browser-repo.ts#FORBIDDEN_MESSAGE_HEADER_PATCH_KEYS': {
    bound: 'static mutation guard',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/store/browser-workspace-lifecycle.ts#EXPECTED_SHUTDOWN_ERROR_MESSAGES': {
    bound: 'static error lookup',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/store/chat-search.ts#DEFAULT_SEARCH_FILTERS': {
    bound: 'immutable default filters',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/store/chat-storage-codec.ts#currentChatTransactionByRow': {
    bound: 'one weak transaction-identity association per live authoritative chat row',
    cleanup:
      'row collection releases the weak entry; the branded row remains local to its command transaction',
    scope: 'module-transaction-brand-registry',
  },
  'src/store/db.ts#waveAUpgradePreflights': {
    bound: 'one preflight result per reachable opening database',
    cleanup: 'database collection releases the weak entry',
    scope: 'module-weak-registry',
  },
  'src/store/db.ts#waveAUpgradeProgressPorts': {
    bound: 'one scalar progress callback per reachable database while its exact open is active',
    cleanup:
      'the open owner deletes the exact entry in finally; database collection is the weak-key backstop',
    scope: 'module-open-attempt-registry',
  },
  'src/store/configuration-domain.ts#REQUEST_PREPARATION_SETTING_KEYS': {
    bound: 'static preference lookup',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/store/connection-probe-application.ts#PROBE_MODEL_CANDIDATES': {
    bound: 'static probe fallback',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/store/conversation-controller.ts#EMPTY_TOPOLOGY': {
    bound: 'immutable empty value',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/store/db.ts#CANONICAL_BROWSER_WORKSPACE_STORES': {
    bound: 'static schema lookup',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/store/db.ts#DERIVED_BROWSER_WORKSPACE_STORES': {
    bound: 'static schema lookup',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/store/db.ts#RETIRED_BROWSER_WORKSPACE_STORES': {
    bound: 'static schema lookup',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/store/generated-output-localization-runtime.ts#active': {
    bound: 'active localization operations',
    cleanup:
      'completion, cancellation, unsubscribe, or workspace quiesce removes each active entry',
    scope: 'module-registry',
  },
  'src/store/keys.ts#derivedKeyCache': {
    bound: '64-entry LRU derived wrapper keys',
    cleanup: 'the stated finite cap, eviction policy, or explicit reset bounds retention',
    scope: 'module-registry',
  },
  'src/store/locks.ts#TEST_HELD_SCOPES': {
    bound: 'test-only held lock scopes',
    cleanup:
      'the owning module clear, dispose, or completion path removes runtime entries; idle retention is forbidden',
    scope: 'module-registry',
  },
  'src/store/locks.ts#coordinationBackends': {
    bound: 'active fallback lock backends',
    cleanup:
      'completion, cancellation, unsubscribe, or workspace quiesce removes each active entry',
    scope: 'module-registry',
  },
  'src/store/locks.ts#lockWakeListeners': {
    bound: 'active fallback lock waiters',
    cleanup:
      'completion, cancellation, unsubscribe, or workspace quiesce removes each active entry',
    scope: 'module-registry',
  },
  'src/store/mounted-projection-lifecycle.ts#projections': {
    bound: 'mounted projection owners',
    cleanup:
      'completion, cancellation, unsubscribe, or workspace quiesce removes each active entry',
    scope: 'module-registry',
  },
  'src/store/search-session.ts#EMPTY_SEARCH_CHAT_IDS': {
    bound: 'immutable empty value',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/store/search-session.ts#searchRelevantDependencyKinds': {
    bound: 'eight immutable dependency-kind values',
    cleanup: 'process-lifetime lookup index with no workspace values',
    scope: 'module-static',
  },
  'src/store/send-context.ts#EMPTY_PENDING': {
    bound: 'immutable empty value',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/store/storage-compaction-state.ts#physicalMutationDebtQueues': {
    bound: 'post-commit compaction debt awaiting durable flush',
    cleanup:
      'completion, cancellation, unsubscribe, or workspace quiesce removes each active entry',
    scope: 'module-registry',
  },
  'src/store/storage-compaction-state.ts#physicalMutationLedgers': {
    bound: 'weak ledgers owned by active write transactions',
    cleanup: 'garbage collection releases weak entries; explicit reset drops the owner slot',
    scope: 'module-registry',
  },
  'src/store/stream-chunk-writer.ts#sharedStreamJournalAppendQueues': {
    bound: 'active journal append queues keyed by reachable append port',
    cleanup:
      'queue drain removes the exact request chain; append-port collection releases the weak entry',
    scope: 'module-weak-registry',
  },
  'src/store/stream-journal-codec.ts#canonicalFrameInstances': {
    bound: 'canonical identity brands for reachable frame objects',
    cleanup: 'frame collection releases each weak entry',
    scope: 'module-weak-registry',
  },
  'src/store/stream-journal-codec.ts#canonicalFrameStorageBytes': {
    bound: 'one cached scalar size per reachable canonical frame',
    cleanup: 'frame collection releases each weak entry',
    scope: 'module-weak-registry',
  },
  'src/store/stream-leases.ts#leaseWriters': {
    bound: 'active lease writers',
    cleanup:
      'completion, cancellation, unsubscribe, or workspace quiesce removes each active entry',
    scope: 'module-registry',
  },
  'src/store/stream-recovery.ts#recoveryRuns': {
    bound: 'active per-stream recovery runs',
    cleanup:
      'completion, cancellation, unsubscribe, or workspace quiesce removes each active entry',
    scope: 'module-registry',
  },
  'src/store/stream-recovery.ts#leaseDeadlineHeap': {
    bound: 'current lease deadline heap',
    cleanup:
      'completion, cancellation, unsubscribe, or workspace quiesce removes each active entry',
    scope: 'module-registry',
  },
  'src/store/stream-recovery.ts#leaseDeadlines': {
    bound: 'current lease deadlines',
    cleanup:
      'completion, cancellation, unsubscribe, or workspace quiesce removes each active entry',
    scope: 'module-registry',
  },
  'src/store/stream-recovery.ts#queued': {
    bound: 'queued current lease ids',
    cleanup:
      'completion, cancellation, unsubscribe, or workspace quiesce removes each active entry',
    scope: 'module-registry',
  },
  'src/store/transaction-activity.ts#queuedPhases': {
    bound: 'active local transaction phases',
    cleanup:
      'completion, cancellation, unsubscribe, or workspace quiesce removes each active entry',
    scope: 'module-registry',
  },
  'src/store/workspace-tab-session.ts#claimedOneShotNotices': {
    bound: 'bounded tab notices',
    cleanup: 'the stated finite cap, eviction policy, or explicit reset bounds retention',
    scope: 'module-registry',
  },
  'src/store/workspace-tab-session.ts#listeners': {
    bound: 'live tab-session subscribers',
    cleanup: 'paired unsubscribe removes each listener; owner teardown clears the registry',
    scope: 'module-registry',
  },
  'src/store/workspace-tab-session.ts#workspaceParticipants': {
    bound: 'fixed tab-session participants',
    cleanup: 'workspace resource rebind or process teardown replaces the fixed owner set',
    scope: 'module-registry',
  },
  'src/store/zustand/announcementStore.ts#seenEventKeys': {
    bound: 'bounded announcement dedupe',
    cleanup: 'the stated finite cap, eviction policy, or explicit reset bounds retention',
    scope: 'module-registry',
  },
  'src/ui/attachments/useAttachmentCatalogRows.ts#EMPTY_IDS': {
    bound: 'immutable empty value',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/ui/attachments/useAttachmentResolver.ts#EMPTY_ATTACHMENTS': {
    bound: 'immutable empty value',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/ui/attachments/useAttachmentResolver.ts#EMPTY_ATTACHMENT_IDS': {
    bound: 'immutable empty value',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/ui/chat/BranchTreeView.tsx#EMPTY_MESSAGE_IDS': {
    bound: 'immutable empty value',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/ui/chat/BranchTreeView.tsx#EMPTY_MESSAGE_ID_SET': {
    bound: 'static empty membership lookup',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/ui/chat/Composer.tsx#EMPTY_ATTACHMENT_REFS': {
    bound: 'immutable empty value',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/ui/chat/MarkdownView.tsx#pluginCache': {
    bound: 'finite rendering plugin combinations',
    cleanup: 'the stated finite cap, eviction policy, or explicit reset bounds retention',
    scope: 'module-registry',
  },
  'src/ui/chat/MarkdownView.tsx#streamingPluginCache': {
    bound: 'finite streaming plugin combinations',
    cleanup: 'the stated finite cap, eviction policy, or explicit reset bounds retention',
    scope: 'module-registry',
  },
  'src/ui/chat/MessageContent.tsx#EMPTY_CITATION_PROJECTION': {
    bound: 'immutable empty value',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/ui/chat/composer-draft-state.ts#EMPTY_ATTACHMENT_REFS': {
    bound: 'immutable empty value',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/ui/chat/composer-draft-state.ts#draftsByKey': {
    bound: 'bounded composer drafts',
    cleanup: 'the stated finite cap, eviction policy, or explicit reset bounds retention',
    scope: 'module-registry',
  },
  'src/ui/chat/composer-draft-state.ts#listenersByKey': {
    bound: 'live composer subscribers',
    cleanup: 'paired unsubscribe removes each listener; owner teardown clears the registry',
    scope: 'module-registry',
  },
  'src/ui/chat/composer-draft-state.ts#persistenceTimers': {
    bound: 'retained draft timers',
    cleanup: 'timer completion or explicit cancellation deletes the retained handle',
    scope: 'module-registry',
  },
  'src/ui/chat/shiki-code-plugin.ts#allowedThemeSet': {
    bound: 'static theme lookup',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/ui/chat/shiki-code-plugin.ts#languageAliasMap': {
    bound: 'static language lookup',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/ui/chat/shiki-code-plugin.ts#languageLoads': {
    bound: 'finite language loads',
    cleanup: 'the stated finite cap, eviction policy, or explicit reset bounds retention',
    scope: 'module-registry',
  },
  'src/ui/chat/shiki-code-plugin.ts#pendingHighlights': {
    bound: 'bounded pending highlights',
    cleanup: 'the stated finite cap, eviction policy, or explicit reset bounds retention',
    scope: 'module-registry',
  },
  'src/ui/chat/shiki-code-plugin.ts#supportedLanguageSet': {
    bound: 'static language lookup',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/ui/chat/shiki-code-plugin.ts#themeLoads': {
    bound: 'finite theme loads',
    cleanup: 'the stated finite cap, eviction policy, or explicit reset bounds retention',
    scope: 'module-registry',
  },
  'src/ui/settings/ChatModelPanel.tsx#EMPTY_MESSAGES': {
    bound: 'immutable empty value',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/ui/settings/ChatModelPanel.tsx#EMPTY_MESSAGE_HEADERS': {
    bound: 'immutable empty value',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/ui/settings/ChatModelPanel.tsx#EMPTY_PRESET_CATALOG_ROWS': {
    bound: 'immutable empty value',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/ui/storage/StorageChatsSurface.tsx#EMPTY_CHAT_CALIBRATIONS': {
    bound: 'immutable empty value',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/ui/storage/StorageChatsSurface.tsx#EMPTY_CHAT_FOLDERS': {
    bound: 'immutable empty value',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/ui/storage/StorageChatsSurface.tsx#EMPTY_CHAT_ROWS': {
    bound: 'immutable empty value',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/ui/storage/StorageChatsSurface.tsx#EMPTY_CHAT_TAGS': {
    bound: 'immutable empty value',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/core/attempt-outcome.ts#GENERATION_FAILURE_KINDS': {
    bound: 'static terminal-attempt outcome lookup',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/core/attempt-outcome.ts#TERMINAL_DECISION_KEYS': {
    bound: 'static terminal-attempt outcome lookup',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/core/attempt-outcome.ts#TERMINAL_FAILURE_KEYS': {
    bound: 'static terminal-attempt outcome lookup',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/core/attempt-outcome.ts#TERMINAL_RECEIPT_KEYS': {
    bound: 'static terminal-attempt outcome lookup',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/hooks/useConfigurationCatalog.ts#EMPTY_ADDRESSED_IDS': {
    bound: 'immutable empty value',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/store/broadcast.ts#remoteWorkspaceChangeSubs': {
    bound: 'live remote-only changefeed subscribers',
    cleanup:
      'paired unsubscribe removes each listener; broadcast reset or realm teardown clears the registry',
    scope: 'module-registry',
  },
  'src/store/browser-command-mutation-journal.ts#DELETE_KEY_HAS_REQUIRED_IDENTITY': {
    bound: 'static physical-mutation guard and effect lookup',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/store/browser-command-mutation-journal.ts#MESSAGE_IDENTITY_TABLES': {
    bound: 'static physical-mutation guard and effect lookup',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/store/browser-repo.ts#CHAT_METADATA_PATCH_KEYS': {
    bound: 'static physical-mutation guard and effect lookup',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/store/browser-repo.ts#DISCOVERY_CACHE_INTERNAL_MAINTENANCE_TABLES': {
    bound: 'static physical-mutation guard and effect lookup',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/store/byte-owner-mutation.ts#profileUsageRevisionTransactions': {
    bound: 'one weak revision-claim marker per touched transaction',
    cleanup: 'transaction collection releases weak entries',
    scope: 'module-transaction-registry',
  },
  'src/store/physical-storage-tables.ts#PHYSICAL_STORAGE_POLICY': {
    bound: 'one immutable policy row per fixed physical storage table',
    cleanup: 'process-lifetime deeply frozen schema policy; no runtime or workspace rows',
    scope: 'module-static',
  },
  'src/store/physical-storage-tables.ts#physicalTransactionPlanTableNames': {
    bound: 'one weak declared-table set per live physical transaction plan',
    cleanup: 'plan collection releases the weak entry after the command releases the plan',
    scope: 'module-transaction-registry',
  },
  'src/store/preset-order.ts#revisionClaimedTransactions': {
    bound: 'one weak revision-claim marker per touched transaction',
    cleanup: 'transaction collection releases weak entries',
    scope: 'module-transaction-registry',
  },
  'src/store/storage-compaction-state.ts#physicalMutationTransactionDatabaseNames': {
    bound: 'one weak database-name association per live physical mutation transaction',
    cleanup:
      'transaction collection releases weak entries; storage-debt closure replaces the weak owner',
    scope: 'module-transaction-registry',
  },
  'src/store/storage-compaction-state.ts#storageCompactionRequestListeners': {
    bound: 'live compaction-request subscribers',
    cleanup:
      'paired unsubscribe removes each listener; storage-debt closure requires the registry empty',
    scope: 'module-registry',
  },
  'src/store/storage-overview-controller.ts#EMPTY_STORAGE_GLOBAL_CALIBRATION_MODEL': {
    bound: 'immutable empty value',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/store/stream-leases.ts#ownershipReservations': {
    bound: 'active unadopted stream-ownership reservations',
    cleanup:
      'adoption, explicit release, failed reservation, or runtime abort deletes each reservation; closed assertion requires zero',
    scope: 'module-registry',
  },
  'src/store/stream-recovery.ts#pendingLeaseReads': {
    bound: 'at most one coalesced strongest read cause per pending stream ID',
    cleanup:
      'each recovery drain clears the admitted batch; workspace close or reconcile clears all pending reads',
    scope: 'module-registry',
  },
  'src/store/workspace-change-boundary.ts#KEY_FACETS': {
    bound: 'static workspace-boundary enum lookup',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/store/workspace-change-boundary.ts#MESSAGE_ORIGINS': {
    bound: 'static workspace-boundary enum lookup',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/store/workspace-change-boundary.ts#MESSAGE_ROLES': {
    bound: 'static workspace-boundary enum lookup',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/store/workspace-change-boundary.ts#ORGANIZATION_FACETS': {
    bound: 'static workspace-boundary enum lookup',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/store/workspace-change-boundary.ts#PRESET_FACETS': {
    bound: 'static workspace-boundary enum lookup',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/store/workspace-change-boundary.ts#PROFILE_FACETS': {
    bound: 'static workspace-boundary enum lookup',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/store/workspace-change-boundary.ts#STORAGE_MAINTENANCE_TASKS': {
    bound: 'static workspace-boundary enum lookup',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/store/workspace-effect-hub.ts#factIndex': {
    bound:
      'live workspace-effect subscriptions plus their declared fact, residual, impact, group, and replacement memberships',
    cleanup:
      'paired unsubscribe removes the subscription from every index and closes repository delivery when the live set becomes empty; test or realm teardown clears all indexes',
    scope: 'module-registry',
  },
  'src/store/workspace-effect-hub.ts#groupIndex': {
    bound:
      'live workspace-effect subscriptions plus their declared fact, residual, impact, group, and replacement memberships',
    cleanup:
      'paired unsubscribe removes the subscription from every index and closes repository delivery when the live set becomes empty; test or realm teardown clears all indexes',
    scope: 'module-registry',
  },
  'src/store/workspace-effect-hub.ts#impactIndex': {
    bound:
      'live workspace-effect subscriptions plus their declared fact, residual, impact, group, and replacement memberships',
    cleanup:
      'paired unsubscribe removes the subscription from every index and closes repository delivery when the live set becomes empty; test or realm teardown clears all indexes',
    scope: 'module-registry',
  },
  'src/store/workspace-effect-hub.ts#liveSubscriptions': {
    bound:
      'live workspace-effect subscriptions plus their declared fact, residual, impact, group, and replacement memberships',
    cleanup:
      'paired unsubscribe removes the subscription from every index and closes repository delivery when the live set becomes empty; test or realm teardown clears all indexes',
    scope: 'module-registry',
  },
  'src/store/workspace-effect-hub.ts#replacementSubscriptions': {
    bound:
      'live workspace-effect subscriptions plus their declared fact, residual, impact, group, and replacement memberships',
    cleanup:
      'paired unsubscribe removes the subscription from every index and closes repository delivery when the live set becomes empty; test or realm teardown clears all indexes',
    scope: 'module-registry',
  },
  'src/store/workspace-effect-hub.ts#residualIndex': {
    bound:
      'live workspace-effect subscriptions plus their declared fact, residual, impact, group, and replacement memberships',
    cleanup:
      'paired unsubscribe removes the subscription from every index and closes repository delivery when the live set becomes empty; test or realm teardown clears all indexes',
    scope: 'module-registry',
  },
  'src/ui/chat/BranchTreeView.tsx#EMPTY_BRANCH_TREE_LAYOUT': {
    bound: 'immutable empty value',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/ui/chat/BranchTreeView.tsx#EMPTY_CONNECTOR_INDEX': {
    bound: 'immutable empty value',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/ui/chat/BranchTreeView.tsx#EMPTY_TARGETED_ATTEMPTS': {
    bound: 'immutable empty value',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/ui/header/ConnectionHeader.tsx#EMPTY_PROFILE_ADDRESS_IDS': {
    bound: 'immutable empty value',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/ui/settings/PromptPresetEditor.tsx#EMPTY_PROMPT_PRESET_IDS': {
    bound: 'immutable empty value',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/ui/settings/PromptPresetEditor.tsx#EMPTY_PROMPT_PRESET_ROWS': {
    bound: 'immutable empty value',
    cleanup: 'process-lifetime immutable value; no runtime entries',
    scope: 'module-static',
  },
  'src/store/browser-command-mutation-journal.ts#installedDatabases': {
    bound: 'one weak entry per live Dexie database instance',
    cleanup:
      'database collection releases the weak entry; the set stores no enumerable or strongly retained workspace data',
    scope: 'module-weak-registry',
  },
  'src/store/browser-command-mutation-journal.ts#journals': {
    bound: 'one weak entry per active command transaction',
    cleanup:
      'the transaction wrapper deletes the entry in finally; transaction collection is a weak-key backstop',
    scope: 'module-transaction-registry',
  },
})

export const CONTROLLER_COLLECTION_CONTRACTS = Object.freeze({
  'src/backcompat/reasoning-envelope-v89.ts#LinearIdAllocator': {
    fields: ['used'],
    bound: 'one finite migration envelope plus synthesized collision IDs',
    cleanup: 'one row normalization releases the allocator and its claimed ID set',
    scope: 'owner-instance',
  },
  'src/store/browser-workspace-bootstrap-authority.ts#BrowserWorkspaceBootstrapAuthorityRegistry': {
    fields: ['activeAuthorities', 'authorityControllers'],
    bound: 'one exact active bootstrap authority and its abort controller per registry instance',
    cleanup: 'finish deletes both exact weak entries; dropping an isolated registry releases them',
    scope: 'controller-registry',
  },
  'src/store/workspace-runtime-control.ts#createWorkspaceRuntimeControlKernel': {
    fields: ['quiesceFailures', 'reconciliationParticipants', 'resources'],
    bound: 'one fixed resource manifest, participant set, and current quiesce failure batch',
    cleanup:
      'quiesce drains failures and resources; terminal kernel release drops the isolated owner',
    scope: 'workspace-resource-kernel',
  },
  'src/store/workspace-runtime.ts#createWorkspaceRuntimeKernel': {
    fields: [
      'activeChildren',
      'activeRoots',
      'idleListeners',
      'listeners',
      'permitRecords',
      'stateListeners',
    ],
    bound: 'active permits and live subscribers for one exact runtime kernel',
    cleanup:
      'operation completion and paired unsubscribe remove entries; terminal kernel release drops the owner',
    scope: 'workspace-authority-kernel',
  },
  'src/store/workspace-session-owner.ts#LoadedWorkspaceSessionOwnerRegistry': {
    fields: ['owners'],
    bound: 'fixed loaded session owners per explicit registry instance',
    cleanup: 'terminal disposal runs every owner; dropping an isolated registry releases its set',
    scope: 'controller-registry',
  },
  'src/core/branch-session.ts#IndexedBranchPath': {
    fields: ['messageIds'],
    bound: 'one immutable selected branch path',
    cleanup:
      'owning branch frame releases the descriptor; successor descriptors retain only their reachable persistent path state',
    scope: 'owner-instance',
  },
  'src/store/browser-active-branch-spine.ts#BrowserSelectionHeaderReader': {
    fields: ['cache'],
    bound:
      'seed headers plus at most one cached result per distinct ancestor touched by one branch-selection resolution',
    cleanup:
      'the selection read releases the task-local reader and cache on completion, stale retry, or abort',
    scope: 'owner-instance',
  },
  'src/core/message-topology.ts#ImmutableMessageTopology': {
    fields: ['byId', 'byParent', 'liveByParent', 'messageIds'],
    bound: 'one immutable explicit topology projection',
    cleanup:
      'the owning conversation frame releases the immutable projection and its persistent indexes',
    scope: 'owner-instance',
  },
  'src/core/provider-identity.ts#ProviderEndpointIndex': {
    fields: ['displayCounts', 'exactSlug', 'normalizedCandidate'],
    bound: 'one endpoint projection',
    cleanup:
      'the endpoint-planning or configuration projection releases the index after that projection is replaced',
    scope: 'owner-instance',
  },
  'src/core/search-query.ts#IncrementalSearchTextScanner': {
    fields: ['hits', 'reportedTerminals', 'touchedHits', 'touchedTerminals'],
    bound:
      'one boolean hit vector and terminal-count vector sized to the compiled query plus touched indexes for one incremental scan',
    cleanup: 'scan completion releases all query-sized vectors with the scanner instance',
    scope: 'owner-instance',
  },
  'src/store/attachment-detail-session.ts#TabAttachmentDetailController': {
    fields: ['listeners'],
    bound: 'mounted detail session',
    cleanup:
      'dispose aborts the detail read, unsubscribes workspace changes, and clears every listener',
    scope: 'owner-instance',
  },
  'src/store/attachment-projection-controller.ts#TabAttachmentDemand': {
    fields: ['attachmentIdSet', 'attachmentIds', 'listeners', 'snapshot', 'statesById'],
    bound: 'one mounted demand',
    cleanup:
      'release unregisters every demanded attachment from the controller and clears demand listeners',
    scope: 'owner-instance',
  },
  'src/store/attachment-projection-controller.ts#TabAttachmentProjectionController': {
    fields: [
      'blockedIds',
      'demandCountById',
      'demands',
      'demandsById',
      'dirtyIds',
      'errorsById',
      'inFlightIds',
      'loadedIds',
      'rowsById',
      'versionById',
    ],
    bound: 'demanded attachment union',
    cleanup:
      'individual demand release drops zero-count rows; controller dispose aborts the read, releases demands, and clears all indexes',
    scope: 'owner-instance',
  },
  'src/store/attempt-controller.ts#TabAttemptController': {
    fields: [
      'attempts',
      'chatDemandCounts',
      'chatExecutionSnapshots',
      'chatListeners',
      'demandListeners',
      'dirtyChatSnapshots',
      'dirtyTargetAdmissionFrames',
      'leaseCoverageByChat',
      'liveByStreamId',
      'notifyChats',
      'notifyTargets',
      'publishedTargetBodyVersionByStreamId',
      'selectedExecutionByTarget',
      'selectedPresentationByTarget',
      'streamIdsByChat',
      'streamIdsByTarget',
      'targetAdmissionClaims',
      'targetAdmissionFrames',
      'targetListeners',
      'targetSnapshots',
    ],
    bound: 'local active attempts, exact target claims, and demanded chat projections',
    cleanup:
      'terminal removal and workspace replacement clear attempt indexes; final chat-demand release also removes lease coverage and unclaimed admission frames',
    scope: 'owner-instance',
  },
  'src/store/attempt-workspace.ts#AttemptWorkspaceProjection': {
    fields: ['demandedChatIds', 'lockProbes', 'pendingChatIds', 'pendingStreamIds'],
    bound: 'attempt workspace projection',
    cleanup:
      'dispose aborts reloads, unsubscribes repository and demand changes, and clears all pending and demanded IDs',
    scope: 'owner-instance',
  },
  'src/store/branch-tree-search-runtime.ts#TabBranchTreeSearchSession': {
    fields: ['dirtyIds', 'evaluatedVersions', 'listeners', 'matchedIds', 'order', 'targets'],
    bound: 'mounted tree search',
    cleanup:
      'clear or dispose aborts reads and clears target indexes; dispose also unsubscribes changes and clears listeners',
    scope: 'owner-instance',
  },
  'src/store/branch-tree-search-session.ts#LazyBranchTreeSearchSession': {
    fields: ['listeners'],
    bound: 'subscribers to one mounted tree-search capability',
    cleanup: 'dispose releases the loaded delegate and clears every facade subscriber',
    scope: 'owner-instance',
  },
  'src/store/browser-repo.ts#BrowserCommandCommit': {
    fields: [
      'attachmentReapRequestIds',
      'attachmentReferenceStates',
      'attachmentRowsById',
      'chatsById',
      'childSlotsById',
      'committedMutationTables',
      'extraInvalidations',
      'inexactAttachmentReferenceIds',
      'initialChatExistsById',
      'internalMutationEvidence',
      'messageRevisionsById',
      'physicalMutationsByAddress',
      'physicalOwnerScopesById',
    ],
    bound:
      'physical addresses, owner scopes, rows, revisions, child slots, and invalidations touched by one authoritative repository command',
    cleanup: 'command completion releases the commit accumulator and every transaction-local index',
    scope: 'owner-instance',
  },
  'src/store/catalog-application.ts#CatalogTabController': {
    fields: ['listeners', 'manualTitleProjections'],
    bound:
      'one pending title projection per concurrent edited chat plus at most 64 committed projections awaiting canonical catalog observation',
    cleanup:
      'subscription cleanup removes listeners; rejection removes the current projection, canonical catalog observation removes committed projections, and workspace replacement or chat deletion clears ownership',
    scope: 'owner-instance',
  },
  'src/store/chat-search.ts#BranchSearchCollector': {
    fields: ['capturedParts', 'tailChunks'],
    bound: 'one bounded branch excerpt scan',
    cleanup: 'task completion releases the instance and all indexed working state',
    scope: 'owner-instance',
  },
  'src/store/chat-search.ts#BoundedSearchTaskPool': {
    fields: ['active'],
    bound: 'one bounded search',
    cleanup: 'task completion releases the instance and all indexed working state',
    scope: 'owner-instance',
  },
  'src/store/configuration-catalog-session.ts#ConfigurationCatalogSession': {
    fields: ['listeners', 'pages'],
    bound:
      'live subscribers plus at most spec.maxRetainedPages coherent pages for one mounted catalog request',
    cleanup:
      'paired unsubscribe removes listeners; release or dispose aborts reads and detaches changefeed; disposeOwner clears pages and listeners',
    scope: 'owner-instance',
  },
  'src/store/configuration-controller.ts#TabConfigurationController': {
    fields: [
      'catalogListeners',
      'editSessions',
      'listeners',
      'pendingChatSettingsFields',
      'pendingChatSettingsReplacements',
      'pendingPromptFields',
      'pendingPromptGenerationRevisions',
      'pendingTextTemplateConfigs',
      'pendingWorkspaceSettings',
      'selectedGenerationConfigurationClaims',
      'selectedGenerationConfigurationClaimStates',
      'workspaceEditSessions',
    ],
    bound:
      'mounted tab subscribers, unsettled configuration intents, one strong active-claim state plus one weak claim-to-state lookup per live selected-send, keyed by their exact chat, workspace, and field',
    cleanup:
      'settlement removes exact intents; selected admission transfer or cancellation aborts and clears its read and deletes the strong Set entry, after which the WeakMap ephemeron is collectible when the caller releases the claim; workspace reconciliation closes edit sessions, aborts all claim reads, and clears the strong Set and pending collections; paired unsubscribe removes listeners',
    scope: 'owner-instance',
  },
  'src/store/configuration-controller.ts#TabConfigurationEditSession': {
    fields: ['pending'],
    bound: 'one configuration edit session',
    cleanup:
      'each tracked operation removes itself in finally; close flushes or discards and unregisters the session',
    scope: 'owner-instance',
  },
  'src/store/connection-runtime.ts#ConnectionRuntimeKeyPreferenceSession': {
    fields: ['preferredKeyByChat'],
    bound: 'bounded tab-local accepted-key preferences',
    cleanup:
      'fixed-limit oldest-entry eviction bounds the map; chat deletion and workspace reset remove scoped entries',
    scope: 'owner-instance',
  },
  'src/store/conversation-controller.ts#PendingConversationHandoffReducer': {
    fields: ['childSlots', 'revisions'],
    bound:
      'latest exact revision and child-slot evidence per ID while one typed route-delivery handoff remains pending',
    cleanup:
      'handoff consumption, explicit cancel, chat deletion, or workspace reconciliation removes the outer handoff and releases the reducer',
    scope: 'owner-instance',
  },
  'src/store/conversation-controller.ts#PendingConversationStructuralReducer': {
    fields: ['messageIds', 'structuralVersions'],
    bound: 'one unique message ID and structural version per pending typed route handoff',
    cleanup: 'releasing the enclosing handoff releases both sets',
    scope: 'owner-instance',
  },
  'src/store/conversation-controller.ts#PendingConversationInvalidationReducer': {
    fields: ['sequencesById'],
    bound: 'one latest invalidation sequence per addressed ID for one pending route handoff',
    cleanup:
      'global invalidation clears per-ID entries; releasing the enclosing handoff releases the reducer',
    scope: 'owner-instance',
  },
  'src/store/conversation-controller.ts#TabConversationController': {
    fields: [
      'blockedReads',
      'inspectorDemands',
      'listeners',
      'operationClaimCountsByChat',
      'operationClaims',
      'pendingForkParentIds',
      'pendingRouteHandoffsByOwnerId',
      'previewDemands',
      'reads',
      'sessions',
      'transcriptDemands',
      'transcriptRetentions',
    ],
    bound:
      'active chat, mounted projection demands and exact retained-message claims, active or blocked reads, unfinished operation claims, and unconsumed route handoffs keyed by exact synchronous route-owner ID; inactive sessions are persisted then evicted once they have no operation claim',
    cleanup:
      'read completion or abort, mounted-owner cleanup, and retention-claim release remove transient entries; claim terminal or cancel and handoff consume or cancel remove exact owners; chat deletion or workspace reconciliation clears all chat-scoped maps',
    scope: 'owner-instance',
  },
  'src/store/conversation-repository-adapter.ts#ConversationEffectAccumulator': {
    fields: ['childSlots', 'observations', 'structurallyChangedIds'],
    bound:
      'message and slot evidence touched for one demanded chat while reducing one repository commit or change',
    cleanup: 'effect materialization task releases the accumulator and its exact evidence',
    scope: 'owner-instance',
  },
  'src/store/conversation-repository-adapter.ts#ProjectionScopeBuilder': {
    fields: ['ids'],
    bound: 'distinct residual IDs accumulated for one projection scope reduction',
    cleanup:
      'scope materialization task releases the builder; an all-scope transition clears exact IDs immediately',
    scope: 'owner-instance',
  },
  'src/store/generation-admission-controller.ts#TabGenerationAdmissionController': {
    fields: ['adoptedSteeringClaims', 'states'],
    bound:
      'one weak state per reachable generation admission claim and one weak adoption marker per reachable supplied steering claim',
    cleanup:
      'take, accept, fail, or cancel clears retained prompt material; claim collection releases the weak state and steering collection releases its adoption marker',
    scope: 'owner-instance',
  },
  'src/store/generation-prompt-material.ts#PerAttemptGenerationPromptMaterialLease': {
    fields: ['claimedHeaders', 'sealedHeaders'],
    bound:
      'one current claimed header and one immutable sealed-header view per message on one admitted attempt prompt path',
    cleanup:
      'seal replaces claims with the prepared path; release removes coordinator claims, clears claimed headers, and drops the sealed view',
    scope: 'owner-instance',
  },
  'src/store/generation-prompt-material.ts#TabWorkspaceMessageMaterialCoordinator': {
    fields: [
      'activeBatches',
      'claimCounts',
      'claimIdentitiesByLease',
      'leases',
      'loadingByIdentity',
      'reservations',
      'retainedByIdentity',
    ],
    bound:
      'active leases and reservations, their distinct prompt identities, and shared loads and batches for one exact workspace fence',
    cleanup:
      'lease or reservation release decrements claims and prunes retained rows; load settlement removes loading and batch entries; coordinator release aborts work and clears every index',
    scope: 'owner-instance',
  },
  'src/store/generation-prompt-material.ts#TabWorkspaceMessageMaterialReservation': {
    fields: ['identities'],
    bound: 'distinct prompt-material identities captured by one reservation',
    cleanup:
      'release unregisters the reservation and claims; instance teardown releases the identity set',
    scope: 'owner-instance',
  },
  'src/store/generation-planning-reader.ts#GenerationPlanningReader': {
    fields: [
      'attachmentEvidenceReads',
      'attachmentReads',
      'attachmentVersions',
      'endpointReads',
      'privacyReads',
    ],
    bound: 'one admitted request',
    cleanup:
      'attempt completion releases the request-scoped reader and all deduplicated planning promises',
    scope: 'owner-instance',
  },
  'src/store/locks.ts#IndexedDbLockBackend': {
    fields: ['delayRejectors', 'timers'],
    bound: 'active fallback locks',
    cleanup:
      'dispose clears renewal and retry timers, rejects delayed waiters, and resolves pending cleanup waits before drain',
    scope: 'owner-instance',
  },
  'src/store/locks.ts#ScopeOrderError': {
    fields: ['held'],
    bound: 'one immutable lock-scope stack snapshot on one rejected lock acquisition',
    cleanup:
      'the thrown error owns the copied scalar names and releases them when its consumer releases it',
    scope: 'owner-instance',
  },
  'src/store/preset-order.ts#PresetOrderMutation': {
    fields: ['blocks', 'originalBlocks'],
    bound: 'preset-order blocks touched by one authoritative transaction',
    cleanup: 'transaction completion releases original and current block maps after commit',
    scope: 'owner-instance',
  },
  'src/store/prompt-estimate-context-controller.ts#MountedPromptEstimateContextController': {
    fields: ['listeners'],
    bound: 'live subscribers of one mounted prompt-estimate context controller',
    cleanup:
      'paired unsubscribe removes listeners; dispose aborts work, detaches effects, and clears listeners',
    scope: 'owner-instance',
  },
  'src/store/recovery-retry-scheduler.ts#RecoveryRetryScheduler': {
    fields: ['entries', 'heap'],
    bound: 'current scheduled recovery retries',
    cleanup:
      'success or evidence replacement clears individual keys; workspace recovery teardown calls clearAll to cancel the timer and empty both indexes',
    scope: 'owner-instance',
  },
  'src/store/search-session.ts#SearchUpdateBatcher': {
    fields: ['deletedChatIds', 'removals', 'upserts'],
    bound: 'one coalesced search publication batch',
    cleanup:
      'each flush empties pending mutations; search completion or cancellation releases the task-local batcher and candidate sets',
    scope: 'owner-instance',
  },
  'src/store/storage-administration.ts#BrowserStorageAdministrationTransport': {
    fields: ['listeners'],
    bound: 'app-lifetime wipe coordination transport',
    cleanup:
      'subscriber cleanup removes listeners; the lazily installed BroadcastChannel and storage listener intentionally remain for the app lifetime',
    scope: 'owner-instance',
  },
  'src/store/storage-chat-catalog-session.ts#StorageChatCatalogSessionFacade': {
    fields: ['demandIds', 'demandedCalibrations', 'listeners'],
    bound: 'one mounted 200-row page plus visible calibration demand',
    cleanup:
      'demand replacement aborts and clears calibration rows; dispose unsubscribes both sources, disposes the page core, and clears listeners',
    scope: 'owner-instance',
  },
  'src/store/storage-overview-controller.ts#StorageOverviewProjectionController': {
    fields: ['listeners'],
    bound: 'live subscribers of one mounted storage-overview controller',
    cleanup:
      'paired unsubscribe removes listeners; dispose aborts work, detaches effects, and clears listeners',
    scope: 'owner-instance',
  },
  'src/store/storage-maintenance-runtime.ts#StorageMaintenanceController': {
    fields: ['#priorityCursors', '#tasks'],
    bound:
      'exactly one task record per ten declared maintenance kinds and one scalar cursor per four fixed priority lanes while this tab owns maintenance',
    cleanup:
      'ownership teardown awaits the pump, then drops both fixed collections before releasing the ownership lease',
    scope: 'owner-instance',
  },
  'src/store/stream-chunk-writer.ts#BufferedStreamJournalWriter': {
    fields: ['buffer'],
    bound: 'one bounded, coalesced journal buffer for an active stream writer',
    cleanup: 'flush drains the buffer; terminal completion or failure releases the writer',
    scope: 'owner-instance',
  },
  'src/store/stream-journal-codec.ts#CanonicalStreamJournalFrameCursor': {
    fields: ['pending'],
    bound: 'frames for the current bounded logical event page',
    cleanup: 'cursor advancement drains pending frames; cursor completion releases the array',
    scope: 'owner-instance',
  },
  'src/store/stream-journal-codec.ts#StreamJournalValueBuilder': {
    fields: ['stack'],
    bound: 'container depth of one journal value under reconstruction',
    cleanup: 'value completion empties the stack; decode completion releases the builder',
    scope: 'owner-instance',
  },
  'src/store/tab-catalog-session.ts#TabCatalogSession': {
    fields: ['deletedIds', 'dirtyIds', 'effectListeners', 'listeners'],
    bound:
      'live page and effect subscribers plus distinct changed or deleted IDs awaiting one mounted catalog refresh',
    cleanup:
      'point or page drain or release clears dirty and deleted IDs; paired unsubscribe removes listeners; dispose clears both listener sets and indexes',
    scope: 'owner-instance',
  },
  'src/store/workspace-local-evidence.ts#WorkspaceLocalChildSlotAccumulator': {
    fields: ['removedMessageIds', 'upserts'],
    bound:
      'latest exact upsert or removal evidence for one child slot during one local command or effect reduction',
    cleanup:
      'command or effect completion releases the accumulator; replace evidence clears and rebuilds both indexes',
    scope: 'owner-instance',
  },
  'src/store/presentation-interaction-controller.ts#PresentationInteractionController': {
    fields: ['#active', '#listeners', '#revisions'],
    bound:
      'one active claim per capability and target, live listeners per capability, and one scalar revision per declared capability',
    cleanup:
      'terminal settlement removes the exact active target; paired unsubscribe removes listeners; page teardown releases revisions and the controller',
    scope: 'page-presentation-interaction-owner',
  },
  'src/store/transaction-order.ts#TransactionMonotonicAllocator': {
    fields: ['lanes'],
    bound:
      'keys touched by one authoritative mutation transaction, each with one serialized allocation tail and high-watermark',
    cleanup: 'transaction-scoped clock release drops every lane after the command completes',
    scope: 'owner-instance',
  },
  'src/ui/chat/shiki-code-plugin.ts#HighlightResultCache': {
    fields: ['#index', '#recency'],
    bound: 'bounded highlighted-result cache',
    cleanup:
      'explicit cache eviction enforces the fixed result bound; instance teardown releases the indexes',
    scope: 'owner-instance',
  },
})

export const ZUSTAND_COLLECTION_CONTRACTS = Object.freeze({
  'src/store/zustand/announcementStore.ts#useAnnouncementStore.assertive': {
    bound: '24-entry assertive announcement lane',
    cleanup: 'fixed-cap eviction owns retention; the tab store releases the lane at page teardown',
    scope: 'store-instance',
  },
  'src/store/zustand/announcementStore.ts#useAnnouncementStore.polite': {
    bound: '24-entry polite announcement lane',
    cleanup: 'fixed-cap eviction owns retention; the tab store releases the lane at page teardown',
    scope: 'store-instance',
  },
  'src/store/zustand/toastStore.ts#useToastStore.banners': {
    bound: '24-entry visual banner lane',
    cleanup: 'fixed-cap eviction owns retention; the tab store releases the lane at page teardown',
    scope: 'store-instance',
  },
  'src/store/zustand/toastStore.ts#useToastStore.toasts': {
    bound: '24-entry visual toast lane',
    cleanup: 'fixed-cap eviction owns retention; the tab store releases the lane at page teardown',
    scope: 'store-instance',
  },
})

const LIFECYCLE_EXTERNAL_INGRESS_CONTRACTS = exactSiteContracts([
  {
    ids: [
      'src/hooks/useCatalogApplication.ts|useSyncExternalStore<callback>|subscribeWorkspaceRuntime|1',
    ],
    scope: 'mounted-react-external-store-subscription',
    bound: 'one workspace-runtime listener for each mounted useWorkspaceFence consumer',
    installation: 'React useSyncExternalStore installs the subscription for the mounted hook',
    removalOwner: 'React useSyncExternalStore invokes the returned runtime unsubscribe',
    cleanup: 'the returned unsubscribe removes the listener from the workspace-runtime set',
  },
  {
    ids: [
      'src/hooks/useMessageStreamProjection.ts|useEffect<callback>|visibilitychange|requestIfVisible|1',
    ],
    scope: 'mounted-message-stream-effect',
    bound: 'one visibility listener for each enabled uncommitted streamed message projection',
    installation: 'the message projection useEffect installs after an active stream is selected',
    removalOwner: 'the same React effect cleanup on dependency change or unmount',
    cleanup: 'effect cleanup removes requestIfVisible from document visibilitychange',
  },
  {
    ids: [
      'src/lib/page-lifecycle.ts|<module>|beforeunload|<inline>|1',
      'src/lib/page-lifecycle.ts|<module>|pagehide|<inline>|1',
      'src/lib/page-lifecycle.ts|<module>|pageshow|<inline>|1',
    ],
    scope: 'page-lifetime-module-bootstrap',
    bound: 'three scalar page-hiding listeners installed once by ES module evaluation',
    installation: 'page-lifecycle module evaluation installs once in the browser document',
    removalOwner: 'browser page teardown; there is no in-page uninstall API',
    cleanup: 'listeners retain only the module boolean and disappear with the page realm',
  },
  {
    ids: [
      'src/lib/preload-recovery.ts|installPreloadErrorRecovery|vite:preloadError|onPreloadError|1',
    ],
    scope: 'explicit-preload-recovery-installation',
    bound: 'one preload-error listener per installPreloadErrorRecovery invocation',
    installation:
      'main bootstrap invokes the installer once and intentionally keeps it for the page',
    removalOwner: 'installer caller owns the returned remover; main leaves it to page teardown',
    cleanup:
      'the returned remover calls removeEventListener with the exact onPreloadError callback',
  },
  {
    ids: [
      'src/store/broadcast.ts|ensureChannel|BroadcastChannel|CHANNEL_NAME|1',
      'src/store/broadcast.ts|ensureChannel|message|<inline>|1',
      'src/store/broadcast.ts|ensureChannel|messageerror|<inline>|1',
    ],
    scope: 'workspace-broadcast-transport-instance',
    bound: 'one channel and its two listeners while broadcast admissions are open',
    installation: 'ensureChannel lazily creates one channel for the running workspace transport',
    removalOwner: 'broadcast runtime resource finishDispose or channel-failure handling',
    cleanup:
      'closing the channel releases both channel-owned listeners; finishDispose clears the slot',
  },
  {
    ids: [
      'src/store/broadcast.ts|installLifecycleListeners|focus|handleFallbackLifecycleCatchUp|1',
      'src/store/broadcast.ts|installLifecycleListeners|pageshow|handleFallbackLifecycleCatchUp|1',
      'src/store/broadcast.ts|installLifecycleListeners|visibilitychange|handleFallbackVisibilityChange|1',
    ],
    scope: 'active-broadcast-fallback-poll',
    bound: 'three catch-up listeners only while fallback polling has active subscribers',
    installation: 'startFallbackPolling invokes the idempotent lifecycle-listener installer',
    removalOwner: 'stopFallbackPolling via the broadcast runtime resource or last unsubscribe',
    cleanup:
      'removeLifecycleListeners removes all three exact callbacks and clears its install flag',
  },
  {
    ids: ['src/store/broadcast.ts|installStorageListener|storage|handleStorageSignal|1'],
    scope: 'active-broadcast-fallback-poll',
    bound: 'one storage signal listener while fallback polling is active',
    installation: 'startFallbackPolling invokes the idempotent storage-listener installer',
    removalOwner: 'stopFallbackPolling and broadcast runtime finishDispose',
    cleanup: 'removeStorageListener removes handleStorageSignal and clears its install flag',
  },
  {
    ids: ['src/store/browser-repo.ts|subscribeChanges|subscribeWorkspaceChanges|1'],
    scope: 'repository-change-subscriber',
    bound: 'one broadcast subscription per repository subscribeChanges caller',
    installation: 'the repository adapter delegates each explicit subscribeChanges request',
    removalOwner: 'the repository projection caller owns the returned unsubscribe',
    cleanup:
      'the delegated unsubscribe removes the handler and stops fallback polling at zero subscribers',
  },
  {
    ids: [
      'src/store/browser-workspace-lifecycle.ts|installBrowserWorkspaceLifecycle|claimWorkspaceRuntimeDemandBoundary|1',
      'src/store/browser-workspace-lifecycle.ts|installBrowserWorkspaceLifecycle|claimBrowserWorkspaceFatalInvalidationOwner|1',
      'src/store/browser-workspace-lifecycle.ts|installBrowserWorkspaceLifecycle|installBrowserWorkspaceSlotCoordinator|1',
      'src/store/browser-workspace-lifecycle.ts|installBrowserWorkspaceLifecycle|subscribeWorkspaceApplicationChanges|1',
      'src/store/browser-workspace-lifecycle.ts|installBrowserWorkspaceLifecycle|subscribeWorkspaceRuntime|1',
    ],
    scope: 'page-lifetime-workspace-composite-owner',
    bound: 'one exact demand, fatal, slot, application-change, and runtime owner per tab',
    installation:
      'installBrowserWorkspaceLifecycle acquires every reversible owner before manifest commit',
    removalOwner: 'installation rollback or exact terminal lifecycle disposal in reverse order',
    cleanup:
      'exact handles are retained together; stale callbacks cannot release or target a successor owner',
  },
  {
    ids: [
      'src/store/browser-workspace-lifecycle.ts|waitForWorkspaceRuntimeStateChange|subscribeWorkspaceRuntimeState|1',
    ],
    scope: 'one-runtime-state-wait',
    bound: 'one temporary state subscription until the observed transitional state changes',
    installation:
      'runtime demand installs the listener only while reconciliation owns the transition',
    removalOwner: 'the request-local inspect callback',
    cleanup: 'inspect removes the exact subscription before resolving the state wait',
  },
  {
    ids: [
      'src/store/generation-admission-controller.ts|subscribeGenerationAdmissionPublication|subscribeWorkspaceRuntimeState|1',
    ],
    scope: 'one-generation-admission-capability-wait',
    bound: 'at most one runtime-state subscription for one captured workspace dependency',
    installation:
      'the centralized generation-admission publication selector installs it only for the workspace owner',
    removalOwner: 'the request-local composed generation-admission unsubscribe',
    cleanup:
      'settlement or abort removes the exact capability subscription together with the other request-local observers',
  },
  {
    ids: [
      'src/store/browser-workspace-lifecycle.ts|shutdownBrowserWorkspaceWhenIdle|abort|abort|1',
      'src/store/browser-workspace-lifecycle.ts|shutdownBrowserWorkspaceWhenIdle|subscribeWorkspaceRuntime|1',
      'src/store/browser-workspace-lifecycle.ts|shutdownBrowserWorkspaceWhenIdle|subscribeWorkspaceRuntimeIdle|1',
      'src/store/browser-workspace-lifecycle.ts|shutdownBrowserWorkspaceWhenIdle|subscribeWorkspaceRuntimeState|1',
    ],
    scope: 'one-idle-shutdown-request',
    bound: 'three temporary subscriptions and one optional abort listener per shutdown request',
    installation:
      'shutdownBrowserWorkspaceWhenIdle installs the listeners inside its returned promise',
    removalOwner: 'the request-local cleanup invoked by settlement, failure, or owner abort',
    cleanup:
      'cleanup invokes every returned unsubscribe and removes the exact abort callback before settlement',
  },
  {
    ids: [
      'src/store/browser-workspace-slot-coordination.ts|ensureSlotTransport|BroadcastChannel|SLOT_CHANNEL_NAME|1',
      'src/store/browser-workspace-slot-coordination.ts|ensureSlotTransport|message|<inline>|1',
      'src/store/browser-workspace-slot-coordination.ts|ensureSlotTransport|messageerror|<inline>|1',
    ],
    scope: 'page-lifetime-workspace-slot-transport',
    bound: 'one slot channel and its two listeners per exact coordinator owner',
    installation:
      'ensureSlotTransport prepares transport before publishing the exact coordinator owner',
    removalOwner: 'messageerror or exact coordinator rollback/terminal disposal',
    cleanup:
      'channel close releases both listeners and the slot is nulled before fallback transport use',
  },
  {
    ids: [
      'src/store/browser-workspace-slot-coordination.ts|ensureSlotTransport|storage|listener|1',
    ],
    scope: 'page-lifetime-workspace-slot-fallback',
    bound: 'one storage fallback listener per exact coordinator owner',
    installation: 'ensureSlotTransport captures the unpublished exact owner in the listener',
    removalOwner: 'exact coordinator rollback or terminal disposal',
    cleanup:
      'disposal removes the captured callback and queued old-owner events cannot reach a successor',
  },
  {
    ids: [
      'src/store/locks.ts|ensureLockWakeChannel|BroadcastChannel|LOCK_WAKE_CHANNEL_NAME|1',
      'src/store/locks.ts|ensureLockWakeChannel|message|<inline>|1',
      'src/store/locks.ts|ensureLockWakeChannel|messageerror|<inline>|1',
    ],
    scope: 'page-lifetime-lock-wake-transport',
    bound: 'one lock-wake channel and its two channel-owned listeners per tab',
    installation:
      'ensureLockWakeChannel lazily creates the channel on first fallback lock wait or wake',
    removalOwner: 'messageerror closes it; otherwise browser page teardown',
    cleanup:
      'closeLockWakeChannel closes and nulls the failed channel; normal page teardown releases it',
  },
  {
    ids: [
      'src/store/storage-administration.ts|ensureInstalled|BroadcastChannel|STORAGE_ADMIN_CHANNEL|1',
      'src/store/storage-administration.ts|ensureInstalled|message|<inline>|1',
      'src/store/storage-administration.ts|ensureInstalled|messageerror|<inline>|1',
    ],
    scope: 'page-lifetime-storage-administration-transport',
    bound: 'one storage-administration channel and its two channel-owned listeners per tab',
    installation:
      'the singleton responder lazily installs the transport once on readiness or wipe use',
    removalOwner: 'messageerror closes the channel; otherwise browser page teardown',
    cleanup: 'closeChannel closes and nulls the failed channel; normal page teardown releases it',
  },
  {
    ids: ['src/store/storage-administration.ts|ensureInstalled|storage|receiveStorageSignal|1'],
    scope: 'page-lifetime-storage-administration-fallback',
    bound: 'one storage fallback listener guarded by storageListenerInstalled',
    installation: 'the singleton transport installs once when its first subscriber is registered',
    removalOwner:
      'browser page teardown; the app-lifetime transport has no production dispose method',
    cleanup: 'the listener retains the singleton transport only for the lifetime of the page realm',
  },
  {
    ids: [
      'src/store/storage-maintenance-runtime.ts|StorageMaintenanceController|subscribeWorkspaceRuntimeIdle|1',
    ],
    scope: 'active-storage-maintenance-controller',
    bound: 'one runtime-idle subscription while one maintenance controller accepts work',
    installation:
      'the controller constructor stores the returned unsubscribe before ownership work starts',
    removalOwner: 'StorageMaintenanceController.close through the workspace resource manifest',
    cleanup: 'close invokes the stored unsubscribe and clears the slot before controller drain',
  },
  {
    ids: ['src/ui/chat/ScrollRegion.tsx|useEffect<callback>|visibilitychange|onVisibilityChange|1'],
    scope: 'mounted-scroll-region-visibility-listener',
    bound: 'one document visibility listener per mounted chat scroll region',
    installation: 'the scroll-region effect installs when its reconciliation callback is current',
    removalOwner: 'the same React effect cleanup on dependency change or unmount',
    cleanup: 'effect cleanup removes the exact visibility listener from the document',
  },
  {
    ids: [
      'src/ui/chat/composer-draft-state.ts|<module>|pagehide|flushPendingComposerDrafts|1',
      'src/ui/chat/composer-draft-state.ts|<module>|visibilitychange|<inline>|1',
    ],
    scope: 'page-lifetime-composer-draft-flush',
    bound: 'two module listeners sharing the bounded draft and persistence-timer maps',
    installation: 'composer draft module evaluation installs once when window exists',
    removalOwner: 'browser page teardown; there is no in-page uninstall API',
    cleanup: 'listeners retain only bounded module draft state and disappear with the page realm',
  },
])

const LIFECYCLE_EXTERNAL_INGRESS_IDS = Object.freeze(
  Object.keys(LIFECYCLE_EXTERNAL_INGRESS_CONTRACTS).sort(),
)

const LIFECYCLE_DIRECT_CALL_CONTRACTS = exactSiteContracts([
  {
    ids: ['src/app/WorkspaceBootstrap.tsx|useEffect<callback>|registerWorkspacePresentationRoot|1'],
    scope: 'mounted-presentation-root-registration',
    stage: 'presentation-suspension-root-install',
    ownership: 'returned-disposer',
    bound: 'one registered presentation root for the mounted WorkspaceBootstrap',
    cleanup:
      "the useEffect returns registerWorkspacePresentationRoot's unregister function to React",
  },
  {
    ids: ['src/main.tsx|<module>|installBrowserWorkspaceLifecycle|1'],
    scope: 'composition-lifecycle-install',
    stage: 'workspace-lifecycle-owner-install',
    ownership: 'synchronous-idempotent-install',
    bound: 'one composite browser-workspace lifecycle owner per page realm',
    cleanup:
      'terminal lifecycle disposal releases every exact owner acquired by the composite install',
  },
  {
    ids: ['src/main.tsx|prepareWorkspace|openBrowserWorkspace|1'],
    scope: 'workspace-bootstrap-call-edge',
    stage: 'initial-workspace-open',
    ownership: 'awaited',
    bound: 'one open transition per WorkspaceBootstrap open attempt',
    cleanup: 'prepareWorkspace awaits openBrowserWorkspace before resolving the bootstrap attempt',
  },
  {
    ids: [
      'src/store/browser-workspace-lifecycle.ts|installBrowserWorkspaceLifecycle|installWorkspaceRuntimeResources|1',
    ],
    scope: 'workspace-orchestrator-call-edge',
    stage: 'lifecycle-resource-manifest-commit',
    ownership: 'synchronous-final-commit',
    bound: 'one fixed manifest installation after all reversible lifecycle owners are acquired',
    cleanup:
      'the manifest install is the final irreversible linearization point; prior acquisition failures roll back exactly',
  },
  {
    ids: [
      'src/store/browser-workspace-lifecycle.ts|quiesce|shutdownBrowserWorkspaceWhenIdle|1',
      'src/store/browser-workspace-lifecycle.ts|raceWithAbortSignal<callback>|resumeBrowserWorkspace|1',
    ],
    scope: 'cross-tab-slot-callback-edge',
    stage: 'remote-slot-resume-or-idle-quiesce',
    ownership: 'reference-transferred-and-awaited-by-consumer',
    bound: 'one quiesce/resume callback pair in the page-lifetime slot coordinator',
    cleanup:
      'the slot coordinator serializes and awaits each callback on its tracked inbound promise chain',
  },
  {
    ids: [
      'src/store/browser-workspace-lifecycle.ts|attempt|awaitWorkspaceRuntimeQuiesced|1',
      'src/store/browser-workspace-lifecycle.ts|attempt|shutdownBrowserWorkspace|1',
    ],
    scope: 'workspace-orchestrator-call-edge',
    stage: 'idle-shutdown-request-settlement',
    ownership: 'transferred-to-request-settler',
    bound: 'one selected shutdown or existing-quiesce promise per idle-shutdown request',
    cleanup:
      'the request settles from the selected transition and removes all three request-local subscriptions',
  },
  {
    ids: ['src/store/browser-workspace-lifecycle.ts|attempt|getWorkspaceRuntimeControlSnapshot|1'],
    scope: 'workspace-orchestrator-call-edge',
    stage: 'idle-shutdown-state-read',
    ownership: 'synchronous',
    bound: 'one immutable control snapshot per idle-shutdown attempt callback',
    cleanup: 'the snapshot is request-local and retains no asynchronous lifecycle work',
  },
  {
    ids: [
      'src/store/browser-workspace-lifecycle.ts|drainRemoteWorkspaceReconciliation|beginWorkspaceRuntimeQuiesce|1',
    ],
    scope: 'workspace-orchestrator-call-edge',
    stage: 'remote-reconciliation-failure-quiesce',
    ownership: 'synchronous',
    bound: 'one fallback quiesce transition after a reconciliation failure leaves RECONCILING',
    cleanup: 'the synchronous transition is then owned by the module quiesce task slot',
  },
  {
    ids: [
      'src/store/browser-workspace-lifecycle.ts|drainRemoteWorkspaceReconciliation|getWorkspaceRuntimeControlSnapshot|1',
      'src/store/browser-workspace-lifecycle.ts|drainRemoteWorkspaceReconciliation|getWorkspaceRuntimeControlSnapshot|2',
      'src/store/browser-workspace-lifecycle.ts|drainRemoteWorkspaceReconciliation|getWorkspaceRuntimeControlSnapshot|3',
    ],
    scope: 'workspace-orchestrator-call-edge',
    stage: 'remote-reconciliation-loop-state-read',
    ownership: 'synchronous',
    bound: 'three bounded state reads per remote-reconciliation loop iteration and failure path',
    cleanup: 'each immutable snapshot remains on the current loop stack only',
  },
  {
    ids: [
      'src/store/browser-workspace-lifecycle.ts|raceWithAbortSignal<callback>|openBrowserWorkspace|1',
      'src/store/browser-workspace-lifecycle.ts|raceWithAbortSignal<callback>|shutdownBrowserWorkspace|1',
    ],
    scope: 'workspace-orchestrator-call-edge',
    stage: 'remote-reconciliation-shutdown-and-reopen',
    ownership: 'awaited',
    bound: 'one shutdown followed by one reopen for each requested remote fence reconciliation',
    cleanup: 'the loop awaits both transitions before accepting the reconciled fence or retrying',
  },
  {
    ids: [
      'src/store/browser-workspace-lifecycle.ts|settleRemoteWorkspaceReconciliation|getWorkspaceRuntimeControlSnapshot|1',
    ],
    scope: 'workspace-orchestrator-call-edge',
    stage: 'remote-reconciliation-task-finalization-read',
    ownership: 'synchronous',
    bound: 'one state read when the tracked remote-reconciliation promise settles',
    cleanup: 'the finally callback clears the task slot before consulting the immutable snapshot',
  },
  {
    ids: [
      'src/store/browser-workspace-lifecycle.ts|finishDispose|releaseActiveBrowserWorkspaceDatabaseSelection|1',
    ],
    scope: 'workspace-resource-disposal-call-edge',
    stage: 'browser-session-physical-selection-release',
    ownership: 'awaited',
    bound: 'one selection release after the invalidated browser session reaches idle',
    cleanup: 'resource finishDispose awaits release before the quiesce phase can complete',
  },
  {
    ids: [
      'src/store/browser-workspace-lifecycle.ts|performTerminalBrowserWorkspaceLifecycleFinalization|getWorkspaceRuntimeControlSnapshot|1',
      'src/store/browser-workspace-lifecycle.ts|performTerminalBrowserWorkspaceLifecycleFinalization|sealWorkspaceRuntime:reference|1',
    ],
    scope: 'workspace-orchestrator-call-edge',
    stage: 'terminal-workspace-shutdown-seal',
    ownership: 'synchronous',
    bound: 'one state validation and terminal seal for a terminal shutdown transition',
    cleanup:
      'finalization attempts every cleanup step, seals the page, releases the composite owner, then aggregates failures',
  },
  {
    ids: [
      'src/store/browser-workspace-lifecycle.ts|finishTerminalBrowserWorkspaceShutdown|getWorkspaceRuntimeControlSnapshot|1',
    ],
    scope: 'workspace-orchestrator-call-edge',
    stage: 'terminal-transition-settlement-check',
    ownership: 'synchronous',
    bound: 'one state validation when a terminal-marked shutdown transition settles',
    cleanup: 'the immutable snapshot is consumed before terminal finalization and retains no task',
  },
  {
    ids: [
      'src/store/browser-workspace-lifecycle.ts|then<callback>|getWorkspaceRuntimeControlSnapshot|1',
      'src/store/browser-workspace-lifecycle.ts|then<callback>|openBrowserWorkspace|1',
    ],
    scope: 'workspace-orchestrator-call-edge',
    stage: 'tracked-transition-continuation',
    ownership: 'owned-by-parent-promise-chain',
    bound: 'one state read or recursive reopen in each corresponding tracked transition chain',
    cleanup:
      'the continuation is part of the returned open or shutdown promise and cannot outlive it unobserved',
  },
  {
    ids: [
      'src/store/browser-workspace-lifecycle.ts|awaitExpectedBrowserWorkspaceOpenCancellation|getWorkspaceRuntimeControlSnapshot|1',
    ],
    scope: 'workspace-orchestrator-call-edge',
    stage: 'cancelled-open-closure-verification',
    ownership: 'synchronous-after-awaited-attempt',
    bound: 'one closure snapshot after an expected opening cancellation rejects',
    cleanup: 'the immutable snapshot is stack-local and owns no asynchronous work',
  },
  {
    ids: [
      'src/store/browser-workspace-lifecycle.ts|finishBrowserWorkspaceOpenAttemptDesiredState|getWorkspaceRuntimeControlSnapshot|1',
      'src/store/browser-workspace-lifecycle.ts|finishBrowserWorkspaceOpenAttemptDesiredState|openBrowserWorkspace|1',
      'src/store/browser-workspace-lifecycle.ts|finishBrowserWorkspaceOpenAttemptDesiredState|shutdownBrowserWorkspace|1',
      'src/store/browser-workspace-lifecycle.ts|finishBrowserWorkspaceOpenAttemptDesiredState|shutdownBrowserWorkspace|2',
    ],
    scope: 'workspace-orchestrator-call-edge',
    stage: 'cancelled-open-latest-intent-handoff',
    ownership: 'returned-transition',
    bound: 'one state read and at most one follow-up transition for the final desired state',
    cleanup: 'the caller chains the returned transition after the cancelled attempt settles',
  },
  {
    ids: [
      'src/store/browser-workspace-lifecycle.ts|performBrowserWorkspaceOpen|awaitWorkspaceRuntimeQuiesced|1',
      'src/store/browser-workspace-lifecycle.ts|performBrowserWorkspaceOpen|finishWorkspaceRuntimeReconciliation|1',
      'src/store/browser-workspace-lifecycle.ts|performBrowserWorkspaceOpen|prepareBrowserWorkspaceDatabaseSelection|1',
      'src/store/browser-workspace-lifecycle.ts|performBrowserWorkspaceOpen|resumeWorkspaceRuntimeResources|1',
    ],
    scope: 'workspace-orchestrator-call-edge',
    stage: 'workspace-open-ordered-async-stages',
    ownership: 'awaited',
    bound: 'one ordered instance of each open stage per cold workspace open',
    cleanup:
      'performBrowserWorkspaceOpen awaits every stage before advancing or resolving openPromise',
  },
  {
    ids: [
      'src/store/browser-workspace-lifecycle.ts|performBrowserWorkspaceOpen|beginWorkspaceRuntimeReconciliation|1',
    ],
    scope: 'workspace-orchestrator-call-edge',
    stage: 'workspace-open-reconciliation-authority-capture',
    ownership: 'synchronous-result-captured',
    bound: 'one reconciliation authority captured for the opened workspace fence',
    cleanup: 'the authority is passed immediately into the awaited resource-resume stage',
  },
  {
    ids: [
      'src/store/browser-workspace-lifecycle.ts|performBrowserWorkspaceOpen|getWorkspaceRuntimeControlSnapshot|1',
      'src/store/browser-workspace-lifecycle.ts|performBrowserWorkspaceOpen|getWorkspaceRuntimeControlSnapshot|2',
      'src/store/browser-workspace-lifecycle.ts|performBrowserWorkspaceOpen|getWorkspaceRuntimeControlSnapshot|3',
      'src/store/browser-workspace-lifecycle.ts|performBrowserWorkspaceOpen|getWorkspaceRuntimeControlSnapshot|4',
      'src/store/browser-workspace-lifecycle.ts|performBrowserWorkspaceOpen|getWorkspaceRuntimeControlSnapshot|5',
      'src/store/browser-workspace-lifecycle.ts|performBrowserWorkspaceOpen|getWorkspaceRuntimeControlSnapshot|6',
    ],
    scope: 'workspace-orchestrator-call-edge',
    stage: 'workspace-open-state-read',
    ownership: 'synchronous',
    bound: 'six bounded state reads across open admission, failure cleanup, and terminal handoff',
    cleanup: 'each immutable snapshot remains local to performBrowserWorkspaceOpen',
  },
  {
    ids: [
      'src/store/browser-workspace-lifecycle.ts|performBrowserWorkspaceOpen|activateBrowserWorkspaceDatabaseSelection|1',
      'src/store/browser-workspace-lifecycle.ts|performBrowserWorkspaceOpen|releaseOpeningBrowserWorkspaceDatabaseSelection|1',
      'src/store/browser-workspace-lifecycle.ts|performBrowserWorkspaceOpen|sealWorkspaceRuntime|1',
    ],
    scope: 'workspace-orchestrator-call-edge',
    stage: 'workspace-open-selection-ownership-and-failed-open-containment',
    ownership: 'exact-selection-transfer-or-awaited-release',
    bound: 'one opening selection transfers to active ownership or is released exactly once',
    cleanup:
      'failed opening releases its exact selection after bootstrap closure or seals when safe release cannot be proven',
  },
  {
    ids: [
      'src/store/browser-workspace-lifecycle.ts|openBrowserWorkspace|getWorkspaceRuntimeControlSnapshot|1',
      'src/store/browser-workspace-lifecycle.ts|openBrowserWorkspace|installBrowserWorkspaceLifecycle|1',
      'src/store/browser-workspace-lifecycle.ts|shutdownBrowserWorkspace|installBrowserWorkspaceLifecycle|1',
    ],
    scope: 'workspace-orchestrator-call-edge',
    stage: 'public-open-shutdown-admission',
    ownership: 'synchronous-admission-before-transition-return',
    bound: 'one lifecycle-install check and one open-state snapshot per public admission',
    cleanup:
      'the idempotent install owns page resources; returned open or shutdown transitions own asynchronous settlement',
  },
  {
    ids: [
      'src/store/browser-workspace-lifecycle.ts|requestBrowserWorkspaceRunning|getWorkspaceRuntimeControlSnapshot|1',
    ],
    scope: 'workspace-demand-call-edge',
    stage: 'workspace-demand-state-read',
    ownership: 'synchronous',
    bound: 'one state read per operation that demands a running workspace',
    cleanup: 'the snapshot is stack-local and retains no asynchronous work',
  },
  {
    ids: [
      'src/store/browser-workspace-lifecycle.ts|fulfillBrowserWorkspaceRuntimeDemand|getWorkspaceRuntimeControlSnapshot|1',
      'src/store/browser-workspace-lifecycle.ts|fulfillBrowserWorkspaceRuntimeDemand|openBrowserWorkspace|1',
    ],
    scope: 'workspace-demand-call-edge',
    stage: 'workspace-demand-reopen-loop',
    ownership: 'awaited-by-deduplicated-demand-task',
    bound: 'one state read and at most one open attempt per demand-loop iteration',
    cleanup:
      'requestBrowserWorkspaceRunning owns and clears the single runtimeDemandPromise after settlement',
  },
  {
    ids: [
      'src/store/browser-workspace-lifecycle.ts|inspect|getWorkspaceRuntimeControlSnapshot|1',
      'src/store/browser-workspace-lifecycle.ts|waitForWorkspaceRuntimeStateChange|getWorkspaceRuntimeControlSnapshot:reference|1',
    ],
    scope: 'workspace-demand-call-edge',
    stage: 'workspace-demand-state-wait',
    ownership: 'synchronous-reference-and-read',
    bound: 'one snapshot reference and one state read per temporary reconciliation wait',
    cleanup: 'the request-local state subscription releases both references when the state changes',
  },
  {
    ids: ['src/store/browser-workspace-lifecycle.ts|resumeBrowserWorkspace|openBrowserWorkspace|1'],
    scope: 'workspace-orchestrator-call-edge',
    stage: 'public-resume-wrapper',
    ownership: 'awaited',
    bound: 'one underlying open transition per resume invocation',
    cleanup: 'the exported wrapper settles only after its underlying open transition settles',
  },
  {
    ids: [
      'src/store/browser-workspace-lifecycle.ts|shutdownBrowserWorkspace|beginWorkspaceRuntimeQuiesce|1',
      'src/store/browser-workspace-lifecycle.ts|shutdownBrowserWorkspace|getWorkspaceRuntimeControlSnapshot|1',
    ],
    scope: 'workspace-orchestrator-call-edge',
    stage: 'workspace-shutdown-admission-and-state',
    ownership: 'synchronous',
    bound: 'one state read and at most one quiesce admission per shutdown request',
    cleanup: 'shutdown transfers subsequent asynchronous ownership to shutdownTransition.promise',
  },
  {
    ids: [
      'src/store/browser-workspace-lifecycle.ts|startBrowserWorkspaceShutdown|awaitWorkspaceRuntimeQuiesced|1',
    ],
    scope: 'workspace-orchestrator-call-edge',
    stage: 'workspace-shutdown-transition-task',
    ownership: 'tracked-promise-chain',
    bound: 'one quiesce promise chain stored in shutdownTransition',
    cleanup: 'shutdownTransition.promise owns settlement and terminal-finalization chaining',
  },
  {
    ids: [
      'src/store/browser-workspace-lifecycle.ts|startRemoteWorkspaceReconciliation|getWorkspaceRuntimeControlSnapshot|1',
    ],
    scope: 'workspace-orchestrator-call-edge',
    stage: 'remote-reconciliation-start-state-read',
    ownership: 'synchronous',
    bound: 'one state read before creating a remote-reconciliation task',
    cleanup:
      'the snapshot is stack-local; the resulting task is separately stored in remoteReconciliationPromise',
  },
  {
    ids: [
      'src/store/browser-workspace-lifecycle.ts|receiveWorkspaceChange|getWorkspaceRuntimeControlSnapshot|1',
      'src/store/browser-workspace-lifecycle.ts|receiveWorkspaceChange|noteWorkspaceRuntimeGatedChange|1',
    ],
    scope: 'workspace-change-ingress-call-edge',
    stage: 'remote-change-fence-classification-and-gating',
    ownership: 'synchronous',
    bound: 'one snapshot read and at most one gated-change update per delivered workspace change',
    cleanup: 'both operations complete inside the page-lifetime subscription callback',
  },
  {
    ids: [
      'src/store/browser-workspace-lifecycle.ts|activate|settleWorkspaceUsableSurface|1',
      'src/store/browser-workspace-lifecycle.ts|activate|settleWorkspaceUsableSurface|2',
    ],
    scope: 'workspace-capability-activation-call-edge',
    stage: 'active-stop-terminal-settlement',
    ownership: 'synchronous',
    bound: 'one ready or error settlement for the exact active-stop activation attempt',
    cleanup: 'the typed settlement records only a scalar outcome for the current runtime cycle',
  },
  {
    ids: [
      'src/store/browser-workspace-lifecycle.ts|reconcileWorkspaceUsableSurfaces|getWorkspaceRuntimeControlSnapshot|1',
      'src/store/browser-workspace-lifecycle.ts|reconcileWorkspaceUsableSurfaces|settleWorkspaceUsableSurface|1',
      'src/store/browser-workspace-lifecycle.ts|reconcileWorkspaceUsableSurfaces|settleWorkspaceUsableSurface|2',
      'src/store/browser-workspace-lifecycle.ts|reconcileWorkspaceUsableSurfaces|settleWorkspaceUsableSurface|3',
      'src/store/browser-workspace-lifecycle.ts|reconcileWorkspaceUsableSurfaces|settleWorkspaceUsableSurface|4',
      'src/store/browser-workspace-lifecycle.ts|reconcileWorkspaceUsableSurfaces|settleWorkspaceUsableSurface|5',
    ],
    scope: 'workspace-usable-surface-orchestrator-call-edge',
    stage: 'route-and-configuration-terminal-settlement',
    ownership: 'synchronous',
    bound:
      'one current-cycle state read and at most one typed terminal settlement per route or configuration surface',
    cleanup: 'all snapshots and proofs are consumed synchronously without retaining payload rows',
  },
  {
    ids: [
      'src/store/browser-workspace-lifecycle.ts|tryShutdownBrowserWorkspaceIfIdle|getWorkspaceRuntimeControlSnapshot|1',
      'src/store/browser-workspace-lifecycle.ts|tryShutdownBrowserWorkspaceIfIdle|tryBeginWorkspaceRuntimeQuiesceIfIdle|1',
    ],
    scope: 'workspace-orchestrator-call-edge',
    stage: 'atomic-idle-shutdown-admission',
    ownership: 'synchronous',
    bound: 'one state read and one atomic idle admission attempt per idle-shutdown probe',
    cleanup:
      'a successful admission immediately transfers async work to startBrowserWorkspaceShutdown',
  },
  {
    ids: [
      'src/store/browser-workspace-replacement-runner.ts|runSlottedBrowserWorkspaceReplacement|awaitWorkspaceRuntimeQuiesced|1',
      'src/store/browser-workspace-replacement-runner.ts|runUnslottedBrowserWorkspaceReplacement|awaitWorkspaceRuntimeQuiesced|1',
    ],
    scope: 'workspace-replacement-call-edge',
    stage: 'replacement-root-quiesce-wait',
    ownership: 'awaited',
    bound: 'one quiesce wait in either the slotted or unslotted replacement path',
    cleanup:
      'replacement execution does not touch either physical database before the await settles',
  },
  {
    ids: [
      'src/store/browser-workspace-replacement-runner.ts|promote|launchImportExportWorkspaceRuntimeReplacementNow|1',
      'src/store/browser-workspace-replacement-runner.ts|promote|tryLaunchMaintenanceWorkspaceRuntimeReplacementIfIdle|1',
    ],
    scope: 'workspace-replacement-call-edge',
    stage: 'replacement-root-atomic-promotion-and-quiesce',
    ownership: 'synchronous-result-captured',
    bound: 'one of two typed atomic replacement-root promotions per admitted replacement selection',
    cleanup:
      'the exact promoted authority supplies cancellation to every replacement admission boundary',
  },
  {
    ids: [
      'src/store/browser-workspace-replacement-runner.ts|performBrowserWorkspaceReplacementLaunch|getWorkspaceRuntimeControlSnapshot|1',
      'src/store/browser-workspace-replacement-runner.ts|runGatedBrowserWorkspaceReplacementAttempt|getWorkspaceRuntimeControlSnapshot|1',
      'src/store/browser-workspace-replacement-runner.ts|runGatedBrowserWorkspaceReplacementAttempt|getWorkspaceRuntimeControlSnapshot|2',
    ],
    scope: 'workspace-replacement-call-edge',
    stage: 'replacement-admission-and-prepromotion-cleanup-state-read',
    ownership: 'synchronous',
    bound: 'one admission read per launch loop plus two bounded reads around a gated attempt',
    cleanup: 'each immutable snapshot remains local to the active replacement attempt',
  },
  {
    ids: [
      'src/store/browser-workspace-replacement-runner.ts|reopenCurrentBrowserWorkspace|getWorkspaceRuntimeControlSnapshot|1',
      'src/store/browser-workspace-lifecycle.ts|installBrowserWorkspaceLifecycle|openBrowserWorkspace:reference|1',
    ],
    scope: 'workspace-replacement-call-edge',
    stage: 'replacement-reopen-port-and-current-slot-verification',
    ownership: 'synchronous-port-install-then-awaited-reopen',
    bound: 'one installed reopen capability and one state verification per replacement recovery',
    cleanup:
      'the page-lifetime port retains no database handle; each invoked open settles before stack-local verification',
  },
  {
    ids: ['src/store/catalog-session-workspace.ts|<module>|workspaceUsableSurfaceSettlementPort|1'],
    scope: 'catalog-composition-call-edge',
    stage: 'sidebar-first-page-settlement-port-construction',
    ownership: 'page-lifetime-typed-capability',
    bound: 'one stateless sidebar settlement port for the page-lifetime catalog workspace',
    cleanup:
      'the port retains only its surface discriminator and delegates current-cycle validation',
  },
  {
    ids: ['src/store/storage-administration.ts|<module>|resumeBrowserWorkspace:reference|1'],
    scope: 'storage-administration-callback-edge',
    stage: 'wipe-recovery-resume',
    ownership: 'reference-transferred-and-awaited-by-consumer',
    bound: 'one callback reference in the page-lifetime storage-administration singleton',
    cleanup: 'StorageAdministration invokes it through an observed phase that awaits settlement',
  },
  {
    ids: ['src/store/storage-administration.ts|quiesce|shutdownBrowserWorkspace|1'],
    scope: 'storage-administration-callback-edge',
    stage: 'wipe-quiesce',
    ownership: 'returned',
    bound: 'one shutdown promise returned for each local or remote wipe quiesce phase',
    cleanup: 'the dependency callback returns the promise to observeStorageAdministrationPhase',
  },
  {
    ids: ['src/store/storage-administration.ts|terminalize|shutdownBrowserWorkspace|1'],
    scope: 'storage-administration-callback-edge',
    stage: 'wipe-terminalization',
    ownership: 'returned',
    bound: 'one terminal shutdown promise returned for each committed wipe terminalization',
    cleanup: 'the dependency callback returns the promise to observeStorageAdministrationPhase',
  },
  {
    ids: [
      'src/store/browser-workspace-lifecycle.ts|performTerminalBrowserWorkspaceLifecycleFinalization|suspendWorkspacePresentation|1',
      'src/store/browser-workspace-lifecycle.ts|performTerminalBrowserWorkspaceLifecycleFinalization|disposeLoadedWorkspaceSessionOwners:reference|1',
    ],
    scope: 'workspace-terminal-finalization-edge',
    stage: 'presentation-unmount-before-session-owner-disposal',
    ownership: 'awaited-handoff-then-synchronous-disposal',
    bound: 'one memoized presentation handoff and one terminal owner disposal per page lifecycle',
    cleanup:
      'the terminal finalization promise is shared by all callers and does not dispose session owners until presentation suspension settles',
  },
  {
    ids: [
      'src/store/workspace-runtime-control.ts|awaitWorkspaceRuntimeQuiescedImpl|workspaceRuntimeKernel.snapshot|1',
    ],
    scope: 'runtime-control-internal-call-edge',
    stage: 'quiesce-task-admission',
    ownership: 'synchronous',
    bound: 'one state read and at most one abortive quiesce admission before task creation',
    cleanup: 'the public function stores the resulting async task in quiescePromise',
  },
  {
    ids: [
      'src/store/workspace-runtime-control.ts|beginWorkspaceRuntimeQuiesceWithMode|workspaceRuntimeKernel.beginGracefulQuiesce|1',
      'src/store/workspace-runtime-control.ts|beginWorkspaceRuntimeQuiesceWithMode|workspaceRuntimeKernel.beginQuiesce|1',
      'src/store/workspace-runtime-control.ts|beginWorkspaceRuntimeQuiesceWithMode|workspaceRuntimeKernel.snapshot|1',
    ],
    scope: 'runtime-control-internal-call-edge',
    stage: 'quiesce-mode-state-transition',
    ownership: 'synchronous',
    bound: 'one state read and exactly one selected quiesce transition per admitted mode',
    cleanup: 'the transition retains no promise; quiescePromise owns subsequent resource draining',
  },
  {
    ids: [
      'src/store/workspace-runtime-control.ts|beginWorkspaceRuntimeReconciliationImpl|workspaceRuntimeKernel.beginReconciliation|1',
    ],
    scope: 'runtime-control-internal-call-edge',
    stage: 'reconciliation-authority-return',
    ownership: 'synchronous-result-returned',
    bound: 'one authority transition result per reconciliation begin call',
    cleanup: 'the public wrapper returns the authority directly to its orchestrator caller',
  },
  {
    ids: [
      'src/store/workspace-runtime-control.ts|launchWorkspaceRuntimeReplacementNowImpl|workspaceRuntimeKernel.launchReplacementNow|1',
    ],
    scope: 'runtime-control-internal-call-edge',
    stage: 'replacement-root-atomic-promotion',
    ownership: 'synchronous-result-captured-and-returned',
    bound: 'one promoted authority for each idle-aware replacement launch attempt',
    cleanup: 'the wrapper returns the authority directly to the replacement orchestrator',
  },
  {
    ids: [
      'src/store/workspace-runtime-control.ts|finishWorkspaceRuntimeReconciliationImpl|workspaceRuntimeKernel.finishReconciliation|1',
      'src/store/workspace-runtime-control.ts|finishWorkspaceRuntimeReconciliationImpl|workspaceRuntimeKernel.snapshot|1',
      'src/store/workspace-runtime-control.ts|finishWorkspaceRuntimeReconciliationImpl|workspaceRuntimeKernel.abortReconciliation|1',
      'src/store/workspace-runtime-control.ts|finishWorkspaceRuntimeReconciliationImpl|workspaceRuntimeKernel.abortReconciliation|2',
    ],
    scope: 'runtime-control-internal-call-edge',
    stage: 'reconciliation-finish-and-rollback-admission',
    ownership: 'synchronous',
    bound: 'one state read and one finish transition or exact rollback per reconciliation',
    cleanup:
      'capability-attach or commit failure rolls resources back before aborting the same reconciliation',
  },
  {
    ids: [
      'src/store/workspace-runtime-control.ts|abortWorkspaceRuntimeReconciliationImpl|workspaceRuntimeKernel.snapshot|1',
      'src/store/workspace-runtime-control.ts|abortWorkspaceRuntimeReconciliationImpl|workspaceRuntimeKernel.abortReconciliation|1',
    ],
    scope: 'runtime-control-internal-call-edge',
    stage: 'reconciliation-explicit-abort',
    ownership: 'awaited-rollback-then-synchronous-transition',
    bound: 'one state read and at most one exact reconciliation abort per cleanup request',
    cleanup: 'resource rollback settles before the control state is moved out of reconciliation',
  },
  {
    ids: [
      'src/store/workspace-runtime-control.ts|resumeWorkspaceRuntimeResourcesImpl|workspaceRuntimeKernel.abortReconciliation|1',
      'src/store/workspace-runtime-control.ts|resumeWorkspaceRuntimeResourcesImpl|workspaceRuntimeKernel.abortReconciliation|2',
    ],
    scope: 'runtime-control-internal-call-edge',
    stage: 'resource-resume-failure-abort',
    ownership: 'synchronous-after-awaited-rollback',
    bound:
      'one exact reconciliation abort for each failed readiness, preparation, or participant phase',
    cleanup: 'every failed phase rolls resumed resources back before aborting reconciliation',
  },
  {
    ids: [
      'src/store/workspace-runtime-control.ts|getWorkspaceRuntimeControlSnapshotImpl|workspaceRuntimeKernel.snapshot|1',
      'src/store/workspace-runtime-control.ts|installWorkspaceRuntimeResourcesImpl|workspaceRuntimeKernel.snapshot|1',
      'src/store/workspace-runtime-control.ts|capabilityActivationIsCurrent|workspaceRuntimeKernel.snapshot|1',
      'src/store/workspace-runtime-control.ts|claimWorkspaceUsableSurfaceSettlementImpl|workspaceRuntimeKernel.snapshot|1',
      'src/store/workspace-runtime-control.ts|settleWorkspaceUsableSurfaceImpl|workspaceRuntimeKernel.snapshot|1',
    ],
    scope: 'runtime-control-internal-call-edge',
    stage: 'control-state-read',
    ownership: 'synchronous',
    bound: 'one immutable state snapshot per public snapshot or manifest-install call',
    cleanup: 'the snapshot is returned or consumed synchronously and retains no task',
  },
  {
    ids: [
      'src/store/workspace-runtime-control.ts|noteWorkspaceRuntimeGatedChangeImpl|workspaceRuntimeKernel.noteGatedChange|1',
      'src/store/workspace-runtime-control.ts|tryBeginWorkspaceRuntimeQuiesceIfIdleImpl|workspaceRuntimeKernel.tryBeginQuiesceIfIdle|1',
    ],
    scope: 'runtime-control-internal-call-edge',
    stage: 'boolean-control-result-return',
    ownership: 'synchronous-result-returned-or-tested',
    bound: 'one scalar result per gated-change or idle-admission call',
    cleanup: 'the boolean result is returned or tested immediately with no retained async work',
  },
  {
    ids: [
      'src/store/workspace-runtime-control.ts|performWorkspaceRuntimeQuiesce|workspaceRuntimeKernel.awaitDrain|1',
    ],
    scope: 'runtime-control-internal-call-edge',
    stage: 'root-permit-drain',
    ownership: 'awaited-through-all-settled',
    bound: 'one runtime drain promise in the active quiesce task',
    cleanup: 'performWorkspaceRuntimeQuiesce awaits Promise.allSettled before advancing phases',
  },
  {
    ids: [
      'src/store/workspace-runtime-control.ts|performWorkspaceRuntimeQuiesce|workspaceRuntimeKernel.markQuiesced|1',
      'src/store/workspace-runtime-control.ts|sealWorkspaceRuntimeImpl|workspaceRuntimeKernel.seal|1',
    ],
    scope: 'runtime-control-internal-call-edge',
    stage: 'quiesced-or-sealed-terminal-transition',
    ownership: 'synchronous',
    bound: 'one final state transition after successful drain or terminal page shutdown',
    cleanup: 'the transition retains no promise and finalizes the control state synchronously',
  },
  {
    ids: [
      'src/store/workspace-runtime-control.ts|performWorkspaceRuntimeQuiesce|workspaceRuntimeKernel.markFailedClosed|1',
      'src/store/workspace-runtime-control.ts|performWorkspaceRuntimeQuiesce|workspaceRuntimeKernel.sealAfterClosedInvariantFailure|1',
      'src/store/workspace-runtime-control.ts|rollbackResumedResources|workspaceRuntimeKernel.sealAfterClosedInvariantFailure|1',
    ],
    scope: 'runtime-control-internal-call-edge',
    stage: 'resource-closure-failure-containment',
    ownership: 'synchronous-terminal-state-transition',
    bound: 'one failed-closed or sealed containment transition after a complete closure audit',
    cleanup:
      'unproven closure seals the page; proven closure with operational failures remains closed and retryable',
  },
])

const LIFECYCLE_DIRECT_CALL_IDS = Object.freeze(Object.keys(LIFECYCLE_DIRECT_CALL_CONTRACTS).sort())

export const MUTABLE_MODULE_CONTRACTS = Object.freeze({
  'src/app/conversation-actions-capability.ts': {
    scope: 'lazy-application-capability',
    bound: 'one loaded conversation action service reference',
    cleanup:
      'process-lifetime module capability; it retains no chat, message, request, or workspace payload',
  },
  'src/app/router.ts': {
    scope: 'tab-navigation-runtime',
    bound:
      'one current route intent, committed route snapshot, route-arrival snapshot/revision, and listener-install flag',
    cleanup:
      'hash listener is page-lifetime; accepted addresses and arrivals replace their current snapshot, and invalidated intents release their abort owner',
  },
  'src/core/branch-session.ts': {
    scope: 'module-memo',
    bound: 'one lazily constructed immutable empty branch path',
    cleanup: 'process-lifetime singleton with no retained chat or message payload',
  },
  'src/core/word-count.ts': {
    scope: 'module-memo',
    bound: 'one lazily detected Intl segmenter or unsupported sentinel',
    cleanup: 'process-lifetime platform service with no workspace payload',
  },
  'src/lib/debug-scroll.ts': {
    scope: 'diagnostic-hook',
    bound: 'one optional scroll diagnostic sink',
    cleanup: 'debug disable replaces the sink with undefined',
  },
  'src/lib/debug-streams.ts': {
    scope: 'diagnostic-hook',
    bound: 'two optional diagnostic sinks plus one monotonic scalar sequence',
    cleanup: 'debug disable clears both sinks; the scalar retains no payload',
  },
  'src/lib/page-lifecycle.ts': {
    scope: 'tab-lifecycle-snapshot',
    bound: 'one boolean page-hiding snapshot',
    cleanup: 'page lifecycle events replace the scalar; page teardown releases the module',
  },
  'src/lib/yield-to-event-loop.ts': {
    scope: 'tab-scheduler',
    bound: 'one lazily created MessageChannel',
    cleanup: 'process-lifetime scheduler channel; pending resolvers are separately drained',
  },
  'src/store/attachment-catalog-workspace.ts': {
    scope: 'workspace-adapter-slot',
    bound: 'one installed attachment-catalog repository adapter and one activation task',
    cleanup:
      'workspace suspend/dispose clears the adapter and task slot before database replacement',
  },
  'src/store/attachment-object-url.ts': {
    scope: 'workspace-object-url-runtime',
    bound: 'one accepted workspace fence and one scalar generation',
    cleanup:
      'workspace reconcile advances the generation and revokes separately tracked object URLs',
  },
  'src/store/attempt-workspace.ts': {
    scope: 'workspace-projection-runtime',
    bound: 'one active attempt projection, one start task, and one idle barrier',
    cleanup:
      'resource-manifest dispose stops admissions and awaits the idle barrier before replacement',
  },
  'src/store/broadcast.ts': {
    scope: 'cross-tab-changefeed-runtime',
    bound:
      'one broadcast/storage/lifecycle-only transport state, exact admission flags, accepted workspace fence, and coalesced durable-verification task/generation',
    cleanup:
      'resource close disables admissions, removes storage/lifecycle listeners, closes the channel, and awaits the in-flight durable verification task',
  },
  'src/store/browser-import-export.ts': {
    scope: 'diagnostic-counter',
    bound: 'one fixed-shape materialization metrics snapshot',
    cleanup: 'each measurement reset replaces the snapshot; counters retain no imported rows',
  },
  'src/store/browser-repo.ts': {
    scope: 'workspace-repository-slot',
    bound: 'one repository/session singleton pair',
    cleanup:
      'workspace session invalidation and close replace the singleton before slot replacement',
  },
  'src/store/browser-workspace-database-selection.ts': {
    scope: 'workspace-selection-task',
    bound: 'one exact current selection and one shared in-flight physical selection promise',
    cleanup:
      'exact opening or active release waits for owned work and cannot release a successor selection',
  },
  'src/store/browser-workspace-lifecycle.ts': {
    scope: 'workspace-lifecycle-orchestrator',
    bound:
      'one composite installation owner with one scalar promoted-replacement drain, current open/selection, shutdown, and coalesced terminal-finalization transition',
    cleanup:
      'after producer quiescence, terminal finalization closes promoted-handoff admissions, revokes ingress, abort-drains exact slot and remote activity, awaits the promoted-replacement drain, and asserts every owner closed',
  },
  'src/store/browser-workspace-replacement-runner.ts': {
    scope: 'workspace-replacement-reopen-port',
    bound: 'one installed page-lifetime reopen capability',
    cleanup:
      'the capability retains no database handle and is replaced only by lifecycle composition',
  },
  'src/store/browser-workspace-slot-coordination.ts': {
    scope: 'cross-tab-slot-runtime',
    bound:
      'one exact coordinator owning its transport/inbound transition state plus one active shared lease',
    cleanup:
      'exact disposal aborts and drains started inbound work, removes transport, and prevents queued callbacks from reaching a successor',
  },
  'src/store/configuration-workspace.ts': {
    scope: 'workspace-adapter-slot',
    bound: 'one installed configuration repository adapter',
    cleanup: 'workspace dispose clears the adapter before repository replacement',
  },
  'src/store/conversation-workspace.ts': {
    scope: 'workspace-adapter-slot',
    bound: 'one conversation adapter for the active workspace fence',
    cleanup: 'workspace dispose clears the adapter before repository replacement',
  },
  'src/store/db.ts': {
    scope: 'physical-database-session-runtime',
    bound:
      'one exact fatal-invalidation owner, database singleton, current/invalidated session pair, admissions, and idle barrier',
    cleanup:
      'session closure drains operations while exact lifecycle release prevents old queued invalidations from reaching a successor',
  },
  'src/store/generated-output-localization-runtime.ts': {
    scope: 'workspace-producer-runtime',
    bound: 'one abort controller, pump task, subscription, wake timer, and scalar generation',
    cleanup: 'resource abort clears the timer/subscription, aborts work, and awaits the pump',
  },
  'src/store/generated-output-localization-capability.ts': {
    scope: 'workspace-generated-output-capability',
    bound:
      'one attached fence, effect subscription, active scalar probe cycle, cached runtime import, and resumed flag',
    cleanup:
      'resource close aborts the exact probe, removes its subscription, closes a resumed runtime, and awaitIdle drains the probe, import, and localization runtime',
  },
  'src/store/locks.ts': {
    scope: 'workspace-lock-runtime',
    bound: 'one fallback backend, wake channel, abort controller, activity count, and idle barrier',
    cleanup:
      'resource dispose aborts active fallback locks, closes wake transport, and awaits backend drain',
  },
  'src/store/mounted-projection-lifecycle.ts': {
    scope: 'mounted-projection-registry-runtime',
    bound:
      'one lifecycle phase/fence, pending reconcile event, physical-read count, and idle barrier',
    cleanup:
      'workspace suspend blocks reads, drains the idle barrier, and reconciles or disposes mounted owners',
  },
  'src/store/quota.ts': {
    scope: 'browser-capability-memo',
    bound: 'one persistence-request promise for the origin',
    cleanup: 'process-lifetime one-shot capability result; no workspace rows are retained',
  },
  'src/store/storage-compaction-state.ts': {
    scope: 'workspace-compaction-runtime',
    bound:
      'one intent-owner start/task/controller, one debt idle/failure/closing/recovery-handoff state, scalar ledger counts, and weak transaction registries',
    cleanup:
      'owner stop aborts acquisition and ownership; closure flushes debt, awaits work, replaces weak registries, and resets failure/handoff only after idle',
  },
  'src/store/storage-maintenance-runtime.ts': {
    scope: 'workspace-maintenance-runtime',
    bound:
      'one discriminated closed, attached, retiring, or failed state; attached owns one controller and retiring owns that controller plus one drain',
    cleanup:
      'close or abort synchronously retires the controller; awaitIdle drains it and transitions to closed or preserves one failed terminal error',
  },
  'src/store/stream-leases.ts': {
    scope: 'workspace-stream-lease-runtime',
    bound:
      'one heartbeat timer/deadline, exact open-writer set, current fence per writer, active-work count, and idle barrier',
    cleanup:
      'terminal owners commit cleanup or recovery handoff and release exact writer ownership; resource dispose asserts zero open writers before cancelling the heartbeat and sealing the runtime',
  },
  'src/store/stream-recovery-capability.ts': {
    scope: 'workspace-stream-recovery-capability',
    bound:
      'one attached fence, effect subscription, active scalar probe cycle, cached runtime import, and resumed flag',
    cleanup:
      'resource close aborts the exact probe, removes its subscription, closes a resumed runtime, and awaitIdle drains the probe, import, and recovery runtime',
  },
  'src/store/stream-recovery.ts': {
    scope: 'workspace-stream-recovery-runtime',
    bound:
      'one coordinator/pump/timer/read state machine, one coalesced strongest full-scan cause, and one recovery-run idle barrier',
    cleanup:
      'resource close aborts coordinator and recovery controllers, clears timers/subscriptions, and drains runs',
  },
  'src/store/transaction-activity.ts': {
    scope: 'workspace-transaction-runtime',
    bound: 'one active phase, admission flag, and idle barrier',
    cleanup:
      'resource close rejects new phases and resolves the barrier only after the active phase completes',
  },
  'src/store/workspace-presentation-lifecycle.ts': {
    scope: 'tab-presentation-lifecycle',
    bound: 'one registered root, one pending suspension acknowledgement, and one scalar generation',
    cleanup: 'root unregister and suspension completion clear the retained callback/promise',
  },
  'src/store/workspace-effect-hub.ts': {
    scope: 'workspace-effect-delivery-hub',
    bound:
      'one attached repository capability, at most one demand-owned repository unsubscribe, and one page-lifecycle fatal-failure handler',
    cleanup:
      'last subscription stops delivery; repository replacement swaps the source exactly; lifecycle disposal clears the fatal handler',
  },
  'src/store/workspace-repository.ts': {
    scope: 'workspace-repository-delivery-slot',
    bound: 'one installed factory, one override, and one delivered target/repository pair',
    cleanup:
      'composition replacement resets delivered slots; test override reset or repository replacement clears exact delivery state',
  },
  'src/store/workspace-tab-session.ts': {
    scope: 'tab-session-snapshot',
    bound: 'one reconciled fence, revision, and immutable tab-session snapshot',
    cleanup: 'workspace reconcile replaces the snapshot; page teardown releases tab-local state',
  },
  'src/store/zustand/announcementStore.ts': {
    scope: 'tab-presentation-state',
    bound: 'one monotonic scalar event counter',
    cleanup: 'counter retains no event payload; page teardown releases the store',
  },
  'src/store/zustand/toastStore.ts': {
    scope: 'tab-presentation-state',
    bound: 'one monotonic scalar toast counter',
    cleanup: 'counter retains no toast payload; page teardown releases the store',
  },
  'src/ui/chat/BranchTreeInspector.tsx': {
    scope: 'diagnostic-hook',
    bound: 'one optional branch-tree inspector computation probe',
    cleanup: 'test instrumentation replaces or clears the probe',
  },
  'src/ui/chat/BranchTreePreview.tsx': {
    scope: 'render-measurement-cache',
    bound: 'one canvas context and one current font string',
    cleanup: 'process-lifetime renderer cache; it retains no branch or message bodies',
  },
  'src/ui/chat/BranchTreeView.tsx': {
    scope: 'diagnostic-hook',
    bound: 'one optional branch-tree computation probe',
    cleanup: 'test instrumentation replaces or clears the probe',
  },
  'src/ui/chat/Message.tsx': {
    scope: 'diagnostic-hook',
    bound: 'one optional message-render probe',
    cleanup: 'test instrumentation replaces or clears the probe',
  },
  'src/ui/chat/shiki-code-plugin.ts': {
    scope: 'render-service-memo',
    bound: 'one lazily initialized shared syntax highlighter promise',
    cleanup:
      'process-lifetime renderer service; bounded result/theme/language caches are inventoried separately',
  },
  'src/ui/import-export/json-file.ts': {
    scope: 'diagnostic-counter',
    bound: 'one fixed-shape JSON I/O metrics snapshot',
    cleanup:
      'each measurement reset replaces the snapshot; counters retain no imported/exported payload',
  },
})

function mutableMetadata(id) {
  const path = id.split('#', 1)[0]
  const contract = MUTABLE_MODULE_CONTRACTS[path]
  if (!contract) throw new Error(`MutableModuleContractMissing:${path}`)
  return contract
}

function ingressMetadata(id) {
  const contract = LIFECYCLE_EXTERNAL_INGRESS_CONTRACTS[id]
  if (!contract) throw new Error(`LifecycleExternalIngressContractMissing:${id}`)
  return contract
}

function directCallMetadata(id) {
  const contract = LIFECYCLE_DIRECT_CALL_CONTRACTS[id]
  if (!contract) throw new Error(`LifecycleDirectCallContractMissing:${id}`)
  return contract
}

export const MODULE_MUTABLE_STATE = entries(mutableMetadata, MODULE_MUTABLE_IDS)

export const RETAINED_COLLECTIONS = Object.freeze(
  [
    ...Object.entries(MODULE_COLLECTION_CONTRACTS).map(([id, contract]) =>
      Object.freeze({ id, retentionKind: 'module', ...contract }),
    ),
    ...Object.entries(CONTROLLER_COLLECTION_CONTRACTS).flatMap(([owner, contract]) =>
      contract.fields.map((field) =>
        Object.freeze({
          id: `${owner}.${field}`,
          retentionKind: 'controller',
          bound: contract.bound,
          cleanup: contract.cleanup,
          scope: contract.scope,
        }),
      ),
    ),
    ...Object.entries(ZUSTAND_COLLECTION_CONTRACTS).map(([id, contract]) =>
      Object.freeze({ id, retentionKind: 'zustand', ...contract }),
    ),
  ].sort((left, right) => left.id.localeCompare(right.id)),
)

export const RETAINED_COLLECTION_IDS_BY_SCOPE = Object.freeze({
  module: Object.freeze(
    RETAINED_COLLECTIONS.filter((entry) => entry.retentionKind === 'module')
      .map((entry) => entry.id)
      .sort(),
  ),
  controller: Object.freeze(
    RETAINED_COLLECTIONS.filter((entry) => entry.retentionKind === 'controller')
      .map((entry) => entry.id)
      .sort(),
  ),
  zustand: Object.freeze(
    RETAINED_COLLECTIONS.filter((entry) => entry.retentionKind === 'zustand')
      .map((entry) => entry.id)
      .sort(),
  ),
})

export const LIFECYCLE_EXTERNAL_INGRESS = entries(ingressMetadata, LIFECYCLE_EXTERNAL_INGRESS_IDS)

export const LIFECYCLE_DIRECT_CALLS = entries(directCallMetadata, LIFECYCLE_DIRECT_CALL_IDS)

export const COORDINATION_LIFECYCLE_EVENT_NAMES = Object.freeze([
  'beforeunload',
  'focus',
  'message',
  'messageerror',
  'pagehide',
  'pageshow',
  'storage',
  'visibilitychange',
  'vite:preloadError',
])

export const LIFECYCLE_PRIMITIVE_MODULES = Object.freeze({
  'src/store/browser-workspace-database-selection.ts': Object.freeze([
    'activateBrowserWorkspaceDatabaseSelection',
    'prepareBrowserWorkspaceDatabaseSelection',
    'releaseActiveBrowserWorkspaceDatabaseSelection',
    'releaseOpeningBrowserWorkspaceDatabaseSelection',
  ]),
  'src/store/browser-workspace-lifecycle.ts': Object.freeze([
    'installBrowserWorkspaceLifecycle',
    'openBrowserWorkspace',
    'resumeBrowserWorkspace',
    'shutdownBrowserWorkspace',
    'shutdownBrowserWorkspaceWhenIdle',
  ]),
  'src/store/workspace-presentation-lifecycle.ts': Object.freeze([
    'registerWorkspacePresentationRoot',
    'suspendWorkspacePresentation',
  ]),
  'src/store/workspace-session-owner.ts': Object.freeze(['disposeLoadedWorkspaceSessionOwners']),
  'src/store/workspace-runtime-control.ts': Object.freeze([
    'awaitWorkspaceRuntimeQuiesced',
    'beginWorkspaceRuntimeQuiesce',
    'beginWorkspaceRuntimeReconciliation',
    'beginWorkspaceRuntimeReplacement',
    'finishWorkspaceRuntimeReconciliation',
    'getWorkspaceRuntimeControlSnapshot',
    'installWorkspaceRuntimeResources',
    'launchImportExportWorkspaceRuntimeReplacementNow',
    'noteWorkspaceRuntimeGatedChange',
    'resumeWorkspaceRuntimeResources',
    'sealWorkspaceRuntime',
    'settleWorkspaceUsableSurface',
    'tryLaunchMaintenanceWorkspaceRuntimeReplacementIfIdle',
    'tryBeginWorkspaceRuntimeQuiesceIfIdle',
    'workspaceUsableSurfaceSettlementPort',
  ]),
})
