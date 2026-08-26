import { readdirSync, readFileSync, statSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const ROOT = resolve(import.meta.dirname, '..')
const SRC_ROOT = resolve(ROOT, 'src')
const SCHEDULERS = new Set([
  'queueMicrotask',
  'requestAnimationFrame',
  'requestIdleCallback',
  'setImmediate',
  'setInterval',
  'setTimeout',
])
const TEMPORAL_NAME =
  /_MS$|(?:^|_)(?:AGE|BACKOFF|CUTOFF|DEBOUNCE|DEADLINE|DELAY|EXPIRY|GRACE|HEARTBEAT|INTERVAL|LEASE|POLL|RECHECK|RETRY|STALE|THROTTLE|TIMEOUT|TTL)(?:_POLICY)?$/u
const TEMPORAL_INPUT_NAME =
  /(?:^now$|(?:age|backoff|debounce|delay|duration|grace|heartbeat|interval|lease|poll|recheck|retry|stale|throttle|timeout|ttl)Ms$|TTL$|(?:deadline|expires|heartbeat|nextRetry)At$|^(?:age|backoff|cutoff|debounce|deadline|delay|duration|expiry|grace|interval|poll|recheck|stale|throttle|timeout|ttl)$)/iu
const COUNT_BUDGET_NAME =
  /(?:^|_)MAX_(?:ATTEMPTS?|CHECKS?|CYCLES?|FRAMES?|PASSES?|POLLS?|RETRIES|SWEEPS?|TICKS?)(?:_|$)|(?:^|_)REQUIRED_STABLE_FRAMES(?:_|$)/u
const NON_ABORTABLE_DESTRUCTIVE_PHASES = new Set(['origin-storage-wipe', 'fresh-database-verify'])

const TEMPORAL_INVENTORY = {
  'external-deadline-ttl': {
    rationale:
      'A remote/browser boundary, expiring cache fact, persisted retry, or recurring logical-retention deadline; elapsed time is part of the external contract, not local ordering.',
    schedulers: [
      'src/api/client.ts|fetchWithTimeout|setTimeout|timeoutMs|1',
      'src/api/client.ts|consumeResponseBody|setTimeout|remainingMs|1',
      'src/api/sse.ts|armWatchdog|setTimeout|Math.max(0, deadline - monotonicNow())|1',
      'src/api/video-generation.ts|delay|setTimeout|ms|1',
      'src/store/configuration-discovery-coordinator.ts|schedule|setTimeout|delay|1',
      'src/store/generated-output-localization-runtime.ts|withOperationTimeout|setTimeout|OPERATION_TIMEOUT_MS|1',
      'src/store/generated-output-localization-runtime.ts|scheduleWake|setTimeout|Math.max(0, Math.min(2_147_483_647, at - Date.now()))|1',
      'src/store/quota.ts|runStorageProbe|setTimeout|storageProbeTimeout(options)|1',
      'src/store/recovery-retry-scheduler.ts|armTimer|setTimeout|Math.min(MAX_TIMER_DELAY_MS, Math.max(0, nextAt - Date.now()))|1',
      'src/store/request-privacy-planning.ts|awaitSendDiscovery|setTimeout|SEND_DISCOVERY_TIMEOUT_MS|1',
      'src/store/storage-administration.ts|runExclusive|setTimeout|timeoutMs|1',
      'src/store/storage-administration.ts|withDeadline|setTimeout|timeoutMs|1',
      'src/store/storage-compaction-state.ts|schedulePhysicalMutationDebtQueue|setTimeout|delayMs|1',
      'src/store/storage-maintenance-runtime.ts|#scheduleNextWake|setTimeout|Math.max(0, Math.min(MAX_TIMER_DELAY_MS, dueAt - Date.now()))|1',
    ],
    durations: [
      'src/api/client.ts|DEFAULT_TIMEOUT_MS|120_000',
      'src/api/sse.ts|DEFAULT_STREAM_FIRST_BYTE_TIMEOUT_MS|300_000',
      'src/api/sse.ts|DEFAULT_STREAM_IDLE_TIMEOUT_MS|120_000',
      'src/api/video-generation.ts|POLL_INTERVAL_MS|10_000',
      'src/core/defaults.ts|SIXTY_DAYS_MS|60 * 24 * 60 * 60 * 1000',
      'src/store/discovery-cache-policy.ts|MODELS_TTL_MS|60 * 60 * 1000',
      'src/store/discovery-cache-policy.ts|ENDPOINTS_TTL_MS|5 * 60 * 1000',
      'src/store/discovery-cache-policy.ts|PRIVACY_POLICY_TTL_MS|24 * 60 * 60 * 1000',
      'src/store/discovery-cache-policy.ts|EMPTY_PRIVACY_POLICY_RETRY_MS|5 * 60 * 1000',
      'src/store/generated-output-localization-runtime.ts|OPERATION_TIMEOUT_MS|2 * 60_000',
      'src/store/generated-output-localization-runtime.ts|VIDEO_POLL_RETRY_MS|10_000',
      'src/store/generated-output-localization-runtime.ts|MAX_RETRY_DELAY_MS|5 * 60_000',
      'src/store/quota.ts|STORAGE_PROBE_TIMEOUT_MS|3_000',
      'src/store/recovery-retry-scheduler.ts|MAX_TIMER_DELAY_MS|2_147_483_647',
      'src/store/request-privacy-planning.ts|SEND_DISCOVERY_TIMEOUT_MS|15_000',
      'src/store/storage-administration.ts|STORAGE_ADMIN_PHASE_TIMEOUT_MS|5_000',
      'src/store/storage-administration.ts|STORAGE_ADMIN_EXCLUSIVE_TIMEOUT_MS|5_000',
      'src/store/storage-administration.ts|STORAGE_ADMIN_COMMITTED_LEASE_MS|60_000',
      'src/store/storage-compaction-state.ts|STORAGE_COMPACTION_DEBT_RETRY_BASE_MS|1_000',
      'src/store/storage-compaction-state.ts|STORAGE_COMPACTION_DEBT_RETRY_MAX_MS|60_000',
      'src/store/storage-maintenance-runtime.ts|ORPHAN_ATTACHMENT_AGE_MS|24 * 60 * 60 * 1_000',
      'src/store/storage-maintenance-runtime.ts|EMPTY_DRAFT_CHAT_AGE_MS|24 * 60 * 60 * 1_000',
      'src/store/storage-maintenance-runtime.ts|TERMINAL_STREAM_JOURNAL_AGE_MS|24 * 60 * 60 * 1_000',
      'src/store/storage-maintenance-runtime.ts|RETRY_BASE_DELAY_MS|1_000',
      'src/store/storage-maintenance-runtime.ts|RETRY_MAX_DELAY_MS|60_000',
      'src/store/storage-maintenance-runtime.ts|MAX_TIMER_DELAY_MS|2_147_483_647',
      'src/store/storage-maintenance-runtime.ts|COMPACTION_INTENT_RECHECK_MS|60_000',
      `src/store/stream-recovery.ts|RECOVERY_RETRY_POLICY|{
  baseDelayMs: 2_000,
  maxDelayMs: 60_000,
} as const`,
      `src/store/stream-recovery.ts|OPERATIONAL_RETRY_POLICY|{
  baseDelayMs: 2_000,
  maxDelayMs: 60_000,
} as const`,
    ],
  },
  'coordination-lease': {
    rationale:
      'A cross-tab/process ownership lease or wipe phase deadline backed by a durable fence; expiry is failure detection, never the source of write correctness.',
    schedulers: [
      'src/store/locks.ts|runOwned|setInterval|this.renewMs|1',
      'src/store/locks.ts|waitForWakeOrDeadline|setTimeout|delay|1',
      'src/store/storage-administration.ts|setRemoteLease|setTimeout|Math.max(0, deadlineAt - Date.now())|1',
      'src/store/storage-maintenance-runtime.ts|waitForRetry|setTimeout|delay|1',
      'src/store/stream-leases.ts|scheduleHeartbeatTimer|setTimeout|STREAM_LEASE_HEARTBEAT_MS|1',
      'src/store/stream-recovery.ts|armLeaseTimer|setTimeout|Math.max(0, nextAt - leaseSchedulerNow())|1',
    ],
    durations: [
      'src/store/generated-output-localization-runtime.ts|LEASE_TTL_MS|5 * 60_000',
      'src/store/locks.ts|DEFAULT_FALLBACK_LOCK_LEASE_MS|15_000',
      'src/store/locks.ts|DEFAULT_FALLBACK_LOCK_RENEW_MS|3_000',
      'src/store/locks.ts|DEFAULT_FALLBACK_LOCK_RETRY_MS|100',
      'src/store/stream-lease-policy.ts|STREAM_LEASE_TTL_MS|15_000',
      'src/store/stream-lease-policy.ts|STREAM_LEASE_HEARTBEAT_MS|2_000',
      'src/store/stream-lease-policy.ts|STREAM_LEASE_HEARTBEAT_COALESCE_MS|250',
      'src/store/stream-recovery.ts|LEASE_EXPIRY_EPSILON_MS|1',
    ],
  },
  'user-debounce': {
    rationale:
      'A user-controlled burst is coalesced for expensive search, persistence, or estimation; blur, pointer-up, unmount, or explicit flush owns correctness.',
    schedulers: [
      'src/hooks/useSettledConfigurationEdit.ts|schedule|setTimeout|settleMs|1',
      'src/ui/chat/composer-draft-state.ts|scheduleTextPersistence|setTimeout|PERSIST_DEBOUNCE_MS|1',
      'src/ui/settings/PromptPresetEditor.tsx|usePromptSlot|setTimeout|120|1',
    ],
    durations: [
      'src/ui/chat/composer-draft-state.ts|PERSIST_DEBOUNCE_MS|250',
      'src/ui/settings/PromptPresetEditor.tsx|SAVE_DEBOUNCE_MS|300',
    ],
  },
  'catalog-query-transition': {
    rationale:
      'Every chat or attachment catalog query transition crosses one asynchronous timer boundary: the first text query and filter-only transitions use 0ms, subsequent changed text uses the explicit 150ms debounce. Superseding or unmounting cancels only pending work; the accepted visible read is not aborted until its replacement actually starts, so elapsed time never establishes catalog correctness.',
    schedulers: ['src/store/catalog-query-transition.ts|schedule|setTimeout|delay|1'],
    durations: [
      'src/store/attachment-search-session.ts|ATTACHMENT_SEARCH_DEBOUNCE_MS|150',
      'src/store/search-session.ts|SEARCH_DEBOUNCE_MS|150',
    ],
  },
  'render-frame': {
    rationale:
      'DOM measurement, focus, scroll anchoring, resize coalescing, or live-region reveal is intentionally synchronized to a browser paint boundary rather than guessed milliseconds.',
    schedulers: [
      'src/hooks/useActiveBranchFrame.ts|update|requestAnimationFrame||1',
      'src/hooks/useConversationFrame.ts|useConversationTranscriptDemand|requestAnimationFrame||1',
      'src/hooks/useConversationFrame.ts|firstFrame|requestAnimationFrame||1',
      'src/ui/chat/BranchTreeInspector.tsx|scheduleRangeRefresh|requestAnimationFrame||1',
      'src/ui/chat/BranchTreeView.tsx|scheduleViewportRead|requestAnimationFrame||1',
      'src/ui/chat/BranchTreeView.tsx|scheduleInspectorResize|requestAnimationFrame||1',
      'src/ui/chat/Composer.tsx|Composer|requestAnimationFrame||1',
      'src/ui/chat/Composer.tsx|togglePrefill|requestAnimationFrame||1',
      'src/ui/chat/InlineEditor.tsx|togglePrefill|requestAnimationFrame||1',
      'src/ui/primitives/LiveRegions.tsx|LiveRegionLane|requestAnimationFrame||1',
    ],
    durations: [],
  },
  'bounded-batch-yield': {
    rationale:
      'Work is coalesced or yielded at an event-loop/idle boundary, or bounded by a write/render budget; the queue and durable state, not elapsed time, own correctness.',
    schedulers: [
      'src/store/attachment-projection-controller.ts|scheduleDrain|queueMicrotask||1',
      'src/store/branch-tree-search-runtime.ts|schedulePointDrain|queueMicrotask||1',
      'src/store/browser-workspace-lifecycle.ts|shutdownBrowserWorkspaceWhenIdle|queueMicrotask||1',
      'src/store/browser-workspace-lifecycle.ts|scheduleFatalWorkspaceReload|queueMicrotask||1',
      'src/store/browser-workspace-slot-coordination.ts|receiveSlotMessage|queueMicrotask||1',
      'src/store/configuration-controller.ts|releaseDemand|queueMicrotask||1',
      'src/store/conversation-controller.ts|publish|queueMicrotask||1',
      'src/store/db.ts|reportFatalInvalidation|queueMicrotask||1',
      'src/store/generation-attempt-runner.ts|schedule|setTimeout|delay|1',
      'src/store/search-session.ts|scheduleDrain|queueMicrotask||1',
      'src/lib/yield-to-event-loop.ts|yieldToEventLoop|setTimeout|0|1',
      'src/store/stream-chunk-writer.ts|scheduleFlush|setTimeout|dueIn|1',
      'src/store/stream-chunk-writer.ts|appendSharedStreamFrames|queueMicrotask||1',
      'src/store/stream-chunk-writer.ts|drainSharedStreamJournalAppends|queueMicrotask||1',
      'src/store/stream-recovery.ts|restartRecoveryCoordinator|queueMicrotask||1',
      'src/store/stream-recovery.ts|scheduleRecoveryPump|queueMicrotask||1',
      'src/store/tab-catalog-session.ts|schedulePointDrain|queueMicrotask||1',
      'src/ui/chat/BranchTreeInspector.tsx|scheduleRangeRefresh|queueMicrotask||1',
      'src/ui/chat/CitationLink.tsx|openCitationAttachment|queueMicrotask||1',
    ],
    durations: [
      'src/core/stream-accumulator.ts|STREAM_LIVE_UPDATE_INTERVAL_MS|125',
      'src/store/chat-search.ts|SEARCH_YIELD_BUDGET_MS|12',
      'src/store/stream-chunk-writer.ts|STREAM_JOURNAL_FLUSH_INTERVAL_MS|150',
    ],
  },
  'ephemeral-ui': {
    rationale:
      'A visible confirmation, accessibility dwell, or current input gesture expires; no data, navigation, branch, or cross-tab correctness depends on the timer.',
    schedulers: [
      'src/ui/chat/MessageActions.tsx|markCopied|setTimeout|COPY_CONFIRM_MS|1',
      'src/ui/chat/ToastTray.tsx|timers|setTimeout|remaining|1',
      'src/ui/primitives/LiveRegions.tsx|revealFrame|setTimeout|ANNOUNCEMENT_DWELL_MS|1',
      'src/ui/sidebar/ChatList.tsx|markRecentMove|setTimeout|1400|1',
    ],
    durations: [
      'src/ui/chat/MessageActions.tsx|COPY_CONFIRM_MS|2500',
      'src/ui/primitives/LiveRegions.tsx|ANNOUNCEMENT_DWELL_MS|1_000',
    ],
  },
}

const CLOCK_INVENTORY = {
  'monotonic-measurement': {
    rationale:
      'Elapsed network, rendering, probe, or cooperative-yield work uses a monotonic clock; Date.now appears only as a platform fallback.',
    ids: [
      'src/api/client.ts|monotonicNow|performance.now|1',
      'src/api/client.ts|monotonicNow|Date.now|1',
      'src/api/probe.ts|probeLlamaServer|performance.now|1',
      'src/api/probe.ts|probeLlamaServer|performance.now|2',
      'src/api/probe.ts|probeLlamaServer|performance.now|3',
      'src/api/sse.ts|monotonicNow|performance.now|1',
      'src/api/sse.ts|monotonicNow|Date.now|1',
      'src/store/chat-search.ts|searchNowMs|Date.now|1',
      'src/store/chat-search.ts|searchNowMs|performance.now|1',
      'src/store/attempt-controller.ts|attemptSchedulerNow|Date.now|1',
      'src/store/attempt-controller.ts|attemptSchedulerNow|performance.now|1',
      'src/store/connection-probe-application.ts|runConfigurationConnectionProbe|performance.now|1',
      'src/store/connection-probe-application.ts|runConfigurationConnectionProbe|performance.now|2',
      'src/store/stream-leases.ts|heartbeatSchedulerNow|performance.now|1',
      'src/store/stream-recovery.ts|leaseSchedulerNow|performance.now|1',
    ],
  },
  'migration-backfill-timestamp': {
    rationale:
      'A version-gated migration records or synthesizes historical timestamps once; it is not live compatibility control flow.',
    ids: [
      'src/backcompat/attachment-refs.ts|migrateLegacyAttachmentStorage|Date.now|1',
      'src/store/db.ts|registerSchema|Date.now|1',
      'src/store/db.ts|registerSchema|Date.now|2',
      'src/store/db.ts|registerPreflightBrowserWorkspaceSchema|Date.now|1',
      'src/store/db.ts|normalizeInactiveBrowserWorkspaceDatabase|Date.now|1',
    ],
  },
  'external-deadline-freshness': {
    rationale:
      'Wall time is compared with a provider cache TTL, persisted retry/deadline, retention cutoff, or cross-tab lease; durable evidence and fences own correctness.',
    ids: [
      'src/api/privacy-scrape.ts|fetchPrivacyScrape|Date.now|1',
      'src/core/defaults.ts|resolveDefaultModel|Date.now|1',
      'src/store/configuration-discovery-coordinator.ts|evaluate|Date.now|1',
      'src/store/configuration-discovery-coordinator.ts|schedule|Date.now|1',
      'src/store/browser-import-export.ts|browserWorkspaceReplacementBlockers|Date.now|1',
      'src/store/browser-catalog-command-runtime.ts|discardEmptyDraftChats|Date.now|1',
      'src/store/attempt-controller.ts|observeLease|Date.now|1',
      'src/store/attempt-controller.ts|reduceExecutionRecord|Date.now|1',
      'src/store/browser-mutation-runtime.ts|putAttachment|Date.now|1',
      'src/store/discovery-cache-policy.ts|isFresh|Date.now|1',
      'src/store/discovery-service.ts|nextDiscoveryFetchedAt|Date.now|1',
      'src/store/generated-output-localization-capability.ts|drainQueueProbes|Date.now|1',
      'src/store/generated-output-localization-runtime.ts|pump|Date.now|1',
      'src/store/generated-output-localization-runtime.ts|processJobWithPermit|Date.now|1',
      'src/store/generated-output-localization-runtime.ts|retryClaim|Date.now|1',
      'src/store/generated-output-localization-runtime.ts|scheduleWake|Date.now|1',
      'src/store/generation-admission.ts|generationAdmissionDecision|Date.now|1',
      'src/store/generation-admission.ts|capturedPrivacyRowIsFresh|Date.now|1',
      'src/store/generation-admission.ts|capturedEndpointsRowIsFresh|Date.now|1',
      'src/store/recovery-retry-scheduler.ts|recordFailure|Date.now|1',
      'src/store/recovery-retry-scheduler.ts|armTimer|Date.now|1',
      'src/store/recovery-retry-scheduler.ts|runDue|Date.now|1',
      'src/store/storage-administration.ts|performClear|Date.now|1',
      'src/store/storage-administration.ts|performClear|Date.now|2',
      'src/store/storage-administration.ts|setRemoteLease|Date.now|1',
      'src/store/storage-compaction-state.ts|storageCompactionIntentOwnerIsLive|Date.now|1',
      'src/store/storage-maintenance-runtime.ts|#schedulePump|Date.now|1',
      'src/store/storage-maintenance-runtime.ts|#schedulePump|Date.now|2',
      'src/store/storage-maintenance-runtime.ts|#runPump|Date.now|1',
      'src/store/storage-maintenance-runtime.ts|#runSlice|Date.now|1',
      'src/store/storage-maintenance-runtime.ts|#runSlice|Date.now|2',
      'src/store/storage-maintenance-runtime.ts|#runSlice|Date.now|3',
      'src/store/storage-maintenance-runtime.ts|#runAttachmentRetentionSlice|Date.now|1',
      'src/store/storage-maintenance-runtime.ts|#runTerminalRetentionSlice|Date.now|1',
      'src/store/storage-maintenance-runtime.ts|#runDraftRetentionSlice|Date.now|1',
      'src/store/storage-maintenance-runtime.ts|#requestStartupWork|Date.now|1',
      'src/store/storage-maintenance-runtime.ts|#recordFailure|Date.now|1',
      'src/store/storage-maintenance-runtime.ts|#scheduleNextWake|Date.now|1',
      'src/store/stream-lease-policy.ts|classifyStreamLeaseWallClockFreshness|Date.now|1',
      'src/store/stream-lease-policy.ts|isFreshStreamLease|Date.now|1',
      'src/store/stream-leases.ts|enqueueLeaseWrite|Date.now|1',
      'src/store/stream-leases.ts|observeStreamOwnershipLockWithManager|Date.now|1',
      'src/store/stream-recovery.ts|recoverStreamOrphan|Date.now|1',
      'src/store/stream-recovery.ts|observeLease|Date.now|1',
      'src/store/stream-recovery.ts|pumpRecoveryQueue|Date.now|1',
      'src/store/stream-chunk-writer.ts|appendStreamJournalFrames|Date.now|1',
    ],
  },
  'persisted-event-timestamp': {
    rationale:
      'One domain operation records an event/LWW/provenance timestamp and passes it through the authoritative transaction; no sleep or completion race depends on it.',
    ids: [
      'src/core/attachment-refs.ts|attachmentRefsFromIds|Date.now|1',
      'src/core/attachment-refs.ts|createAttachmentRef|Date.now|1',
      'src/core/attachments/process-runtime.ts|processAttachmentLoaded|Date.now|1',
      'src/core/messages.ts|editMessageBodyInRepository|Date.now|1',
      'src/core/messages.ts|pasteImportInRepository|Date.now|1',
      'src/core/stream-accumulator.ts|projectStreamGeneration|Date.now|1',
      'src/store/attempt-control-application.ts|requestAttemptStop|Date.now|1',
      'src/store/configuration-model-resolution-capability.ts|drainTarget|Date.now|1',
      'src/core/token-calibration.ts|addSampleToChat|Date.now|1',
      'src/app/Shell.tsx|task|Date.now|1',
      'src/core/chat-metadata.ts|createChatRow|Date.now|1',
      'src/store/attachment-storage.ts|splitAttachmentForStorage|Date.now|1',
      'src/store/attachments.ts|buildAttachment|Date.now|1',
      'src/store/attachments.ts|remoteAttachment|Date.now|1',
      'src/store/attachments.ts|addExistingAttachmentRef|Date.now|1',
      'src/store/attachments.ts|setAttachmentRefVisibility|Date.now|1',
      'src/store/attachments.ts|detachAttachmentRef|Date.now|1',
      'src/store/attachments.ts|mutateMessageAttachmentRef|Date.now|1',
      'src/store/attachments.ts|mutateAttachmentReferenceTargets|Date.now|1',
      'src/store/attachments.ts|deleteReferencedAttachmentBytes|Date.now|1',
      'src/store/attachment-bulk-delete.ts|executeAttachmentBulkDelete|Date.now|1',
      'src/store/browser-import-export.ts|prepareChatImport|Date.now|1',
      'src/store/browser-import-export.ts|importConnectionProfile|Date.now|1',
      'src/store/browser-import-export.ts|importChatPreset|Date.now|1',
      'src/store/browser-import-export.ts|commitPreparedBrowserWorkspaceBackup|Date.now|1',
      'src/store/browser-import-export.ts|commitPreparedBrowserWorkspaceBackup|Date.now|2',
      'src/store/browser-repo.ts|dispatchCommand|Date.now|1',
      'src/store/browser-repo.ts|forkChatFromMessage|Date.now|1',
      'src/store/browser-catalog-command-runtime.ts|createFolder|Date.now|1',
      'src/store/browser-catalog-command-runtime.ts|updateFolder|Date.now|1',
      'src/store/browser-catalog-command-runtime.ts|ensureFolderAndMoveChats|Date.now|1',
      'src/store/browser-repo.ts|mutateSingleAttachmentReference|Date.now|1',
      'src/store/generation-admission-controller.ts|claimCaptured|Date.now|1',
      'src/store/browser-mutation-runtime.ts|runBrowserMutation|Date.now|1',
      'src/store/browser-workspace-derived-repair.ts|rebuildChildSlotDerivedState|Date.now|1',
      'src/store/browser-workspace-replacement.ts|restoreBrowserWorkspaceBackup|Date.now|1',
      'src/store/browser-workspace-replacement.ts|restoreBrowserWorkspaceBackup|Date.now|2',
      'src/store/browser-workspace-replacement.ts|restoreBrowserWorkspaceBackup|Date.now|3',
      'src/store/chats.ts|materializeTemporaryChat|Date.now|1',
      'src/store/chats.ts|discardEmptyDraftChats|Date.now|1',
      'src/store/chats.ts|archiveChats|Date.now|1',
      'src/store/chats.ts|archiveChat|Date.now|1',
      'src/store/chats.ts|unarchiveChats|Date.now|1',
      'src/store/chats.ts|unarchiveChat|Date.now|1',
      'src/store/chats.ts|deleteArchivedChatsPermanently|Date.now|1',
      'src/store/chats.ts|deleteArchivedChatPermanently|Date.now|1',
      'src/store/chats.ts|emptyArchivedChats|Date.now|1',
      'src/store/chats.ts|moveChatsToFolder|Date.now|1',
      'src/store/chats.ts|moveChatToFolder|Date.now|1',
      'src/store/chats.ts|setChatsTagsFromNames|Date.now|1',
      'src/store/chats.ts|setChatTagsFromNames|Date.now|1',
      'src/store/chats.ts|clearChatTokenCalibration|Date.now|1',
      'src/store/chats.ts|clearTokenCalibrationFamilyEverywhere|Date.now|1',
      'src/store/chats.ts|clearAllTokenCalibrationEverywhere|Date.now|1',
      'src/store/chats.ts|touchLastViewed|Date.now|1',
      'src/store/chats.ts|setManualTitle|Date.now|1',
      'src/store/configuration-domain-contract.ts|buildConnectionProfile|Date.now|1',
      'src/store/configuration-domain.ts|addImageOrigin|Date.now|1',
      'src/store/configuration-domain.ts|removeImageOrigin|Date.now|1',
      'src/store/configuration-domain.ts|patchRenderingPreferences|Date.now|1',
      'src/store/configuration-domain.ts|setSamplePromptsDismissed|Date.now|1',
      'src/store/configuration-domain.ts|createConnection|Date.now|1',
      'src/store/configuration-domain.ts|editConnection|Date.now|1',
      'src/store/configuration-domain.ts|duplicateConnection|Date.now|1',
      'src/store/configuration-domain.ts|archiveConnection|Date.now|1',
      'src/store/configuration-domain.ts|unarchiveConnection|Date.now|1',
      'src/store/configuration-domain.ts|deleteConnection|Date.now|1',
      'src/store/configuration-domain.ts|patchChatSettings|Date.now|1',
      'src/store/configuration-domain.ts|patchChatSettingsFields|Date.now|1',
      'src/store/configuration-domain.ts|replaceChatSettings|Date.now|1',
      'src/store/configuration-domain.ts|switchChatProfile|Date.now|1',
      'src/store/configuration-domain.ts|createAndLinkChatPreset|Date.now|1',
      'src/store/configuration-domain.ts|createChatPreset|Date.now|1',
      'src/store/configuration-domain.ts|duplicateChatPreset|Date.now|1',
      'src/store/configuration-domain.ts|applyChatPreset|Date.now|1',
      'src/store/configuration-domain.ts|saveChatPreset|Date.now|1',
      'src/store/configuration-domain.ts|renameChatPreset|Date.now|1',
      'src/store/configuration-domain.ts|moveChatPreset|Date.now|1',
      'src/store/configuration-domain.ts|archiveChatPreset|Date.now|1',
      'src/store/configuration-domain.ts|unarchiveChatPreset|Date.now|1',
      'src/store/configuration-domain.ts|deleteChatPreset|Date.now|1',
      'src/store/configuration-domain.ts|createTextTemplate|Date.now|1',
      'src/store/configuration-domain.ts|createAndSelectTextTemplate|Date.now|1',
      'src/store/configuration-domain.ts|updateTextTemplate|Date.now|1',
      'src/store/configuration-domain.ts|deleteTextTemplate|Date.now|1',
      'src/store/configuration-domain.ts|commitPromptText|Date.now|1',
      'src/store/configuration-domain.ts|loadPromptPreset|Date.now|1',
      'src/store/configuration-domain.ts|overwriteAndPinPromptPreset|Date.now|1',
      'src/store/configuration-domain.ts|createAndPinPromptPreset|Date.now|1',
      'src/store/configuration-domain.ts|renamePromptPreset|Date.now|1',
      'src/store/configuration-domain.ts|deletePromptPreset|Date.now|1',
      'src/store/connection-probe-application.ts|buildProbeProfile|Date.now|1',
      'src/store/folders.ts|deleteFolderWithDisposition|Date.now|1',
      'src/store/generated-images.ts|materializeGeneratedImageOutputAttachments|Date.now|1',
      'src/store/generated-images.ts|materializeGeneratedAudioVideoOutputAttachments|Date.now|1',
      'src/store/generated-images.ts|mergeGeneratedImageAttachmentRefs|Date.now|1',
      'src/store/generated-images.ts|createOrPrepareGeneratedRemoteAttachment|Date.now|1',
      'src/store/generated-output-localization-runtime.ts|processRemoteDownload|Date.now|1',
      'src/store/generated-output-localization-runtime.ts|processRemoteDownload|Date.now|2',
      'src/store/generated-output-localization-runtime.ts|processVideoPollingJob|Date.now|1',
      'src/store/generated-output-localization-runtime.ts|failClaim|Date.now|1',
      'src/store/global-settings.ts|setPinnedModel|Date.now|1',
      'src/store/global-settings.ts|movePinnedModel|Date.now|1',
      'src/store/global-settings.ts|clearRecentModels|Date.now|1',
      'src/store/global-settings.ts|writeGlobalPreference|Date.now|1',
      'src/store/import-export.ts|canonicalizeImportedGeneratedOutputs|Date.now|1',
      'src/store/keys.ts|initialize|Date.now|1',
      'src/store/keys.ts|prepare|Date.now|1',
      'src/store/keys.ts|create|Date.now|1',
      'src/store/keys.ts|resolve|Date.now|1',
      'src/store/keys.ts|resolve|Date.now|2',
      'src/store/keys.ts|change|Date.now|1',
      'src/store/keys.ts|remove|Date.now|1',
      'src/store/sidebar-preferences.ts|writeSidebarSortMode|Date.now|1',
      'src/store/sidebar-preferences.ts|setSidebarFolderCollapsed|Date.now|1',
      'src/store/stream-leases.ts|handoffOwnedLease|Date.now|1',
      'src/ui/attachments/useAttachmentDrafts.ts|replaceAttachment|Date.now|1',
      'src/ui/attachments/useAttachmentDrafts.ts|toggleAttachment|Date.now|1',
      'src/ui/header/ConnectionHeader.tsx|activateProfile|Date.now|1',
      'src/ui/header/ConnectionHeader.tsx|submit|Date.now|1',
    ],
  },
  'diagnostic-presentation-ephemeral': {
    rationale:
      'The clock labels diagnostics, export names, search lifecycle, relative-date presentation, notification expiry, or collision-resistant ephemeral IDs; authoritative state does not wait on it.',
    ids: [
      'src/core/branch-flatten.ts|exportFilename|Date.now|1',
      'src/lib/debug-streams.ts|nextTraceId|Date.now|1',
      'src/lib/debug-streams.ts|elapsedMs|Date.now|1',
      'src/lib/debug-streams.ts|startStreamDebug|Date.now|1',
      'src/store/broadcast.ts|postFallbackSignal|Date.now|1',
      'src/store/browser-import-export.ts|envelope|Date.now|1',
      'src/store/search-session.ts|receiveChange|Date.now|1',
      'src/store/search-session.ts|startDrain|Date.now|1',
      'src/store/search-session.ts|settleDrain|Date.now|1',
      'src/store/search-session.ts|reconcileRuntime|Date.now|1',
      'src/store/search-session.ts|commitRequest|Date.now|1',
      'src/store/search-session.ts|recoverRequest|Date.now|1',
      'src/store/search-session.ts|abort|Date.now|1',
      'src/store/search-session.ts|nextQueryId|Date.now|1',
      'src/store/storage-administration.ts|randomId|Date.now|1',
      'src/store/zustand/toastStore.ts|nextId|Date.now|1',
      'src/store/zustand/toastStore.ts|push|Date.now|1',
      'src/app/Shell.tsx|ownGenerationSubmission|performance.now|1',
      'src/app/Shell.tsx|reportPhase|performance.now|1',
      'src/ui/chat/ToastTray.tsx|timers|Date.now|1',
      'src/ui/sidebar/chat-organization.ts|formatSidebarRowMeta|Date.now|1',
      'src/ui/sidebar/ChatList.tsx|ChatList|Date.now|1',
    ],
  },
}

const DATE_CONSTRUCTION_INVENTORY = {
  'display-export-date': {
    rationale:
      'Date objects format an already-recorded timestamp or create a display/export filename; no comparison or application ordering uses Date object semantics.',
    ids: [
      'src/app/WorkspaceBootstrap.tsx|nowIso|new Date||1',
      'src/core/branch-flatten.ts|exportFilename|new Date|now|1',
      'src/ui/attachments/format.ts|formatDate|new Date|ms|1',
      'src/ui/chat/ChatHeader.tsx|ChatHeader|new Date|chat.createdAt|1',
      'src/ui/chat/ChatHeader.tsx|ChatHeader|new Date|chat.updatedAt|1',
      'src/ui/chat/MessageInfo.tsx|MessageInfo|new Date|message.createdAt|1',
      'src/ui/chat/MessageInfo.tsx|MessageInfo|new Date|message.editedAt|1',
      'src/ui/import-export/chat-download.ts|exportLastUpdatedChatsAsZip|new Date||1',
      'src/ui/import-export/json-file.ts|natterJsonFilename|new Date||1',
      'src/ui/import-export/json-file.ts|natterZipFilename|new Date||1',
      'src/ui/sidebar/chat-organization.ts|startOfLocalDay|new Date|value|1',
      'src/ui/sidebar/chat-organization.ts|formatRelativeDate|new Date|value|1',
      'src/ui/sidebar/chat-organization.ts|formatRelativeDate|new Date|now|1',
    ],
  },
}

const DATE_OPERATION_INVENTORY = {
  'external-model-expiration': {
    rationale:
      'Provider-supplied expiration dates are parsed once while choosing an onboarding default; the resulting timestamp is compared with an explicit freshness horizon.',
    ids: ['src/core/defaults.ts|freshEnough|Date.parse|model.expirationDate|1'],
  },
  'display-date-format': {
    rationale:
      'Intl date formatters convert already-recorded timestamps to local display text and never participate in application ordering or completion.',
    ids: [
      `src/ui/attachments/format.ts|formatDate|Intl.DateTimeFormat|undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }|1`,
      `src/ui/sidebar/chat-organization.ts|<module>|Intl.DateTimeFormat|undefined, {
  hour: 'numeric',
  minute: '2-digit',
}|1`,
      `src/ui/sidebar/chat-organization.ts|<module>|Intl.DateTimeFormat|undefined, {
  month: 'short',
  day: 'numeric',
}|1`,
      `src/ui/sidebar/chat-organization.ts|<module>|Intl.DateTimeFormat|undefined, {
  month: 'short',
  day: 'numeric',
  year: '2-digit',
}|1`,
    ],
  },
}

const ASYNC_RACE_INVENTORY = {
  'external-deadline-race': {
    rationale:
      'Promise.race couples an external/browser operation to an explicit abort/deadline promise; the loser is canceled or detached and cannot commit state.',
    ids: [
      'src/api/client.ts|consumeResponseBody|Promise.race|1',
      'src/api/sse.ts|readNext|Promise.race|1',
      'src/store/quota.ts|runStorageProbe|Promise.race|1',
    ],
  },
  'bounded-concurrency-race': {
    rationale:
      'Promise.race waits for any member of a bounded task pool to free capacity; task-set membership, not timing, controls progress.',
    ids: ['src/store/chat-search.ts|add|Promise.race|1'],
  },
  'lifecycle-cancellation-race': {
    rationale:
      'The lock queue races its predecessor against an explicit disposal signal so shutdown cannot strand a waiter.',
    ids: [
      'src/store/locks.ts|openDatabaseUntilDisposed|Promise.race|1',
      'src/store/locks.ts|runOwned|Promise.race|1',
    ],
  },
  'generation-admission-settlement': {
    rationale:
      'The UI waits for either explicit generation admission or final claim settlement; both are outcomes of the same owned claim, and settlement resolves non-admission without a clock or detached work.',
    ids: ['src/app/Shell.tsx|ownGenerationSubmission|Promise.race|1'],
  },
}

const RETRY_LOOP_INVENTORY = {
  'publication-driven-admission-settlement': {
    rationale:
      'Generation admission re-evaluates only after an owned capability or destination publication; abort cancels the wait and releases the exact subscription and untransferred steering claim.',
    ids: [
      'src/store/generation-admission-controller.ts|settleCapturedAdmission|ForStatement|unbounded|1',
    ],
  },
  'external-protocol-retry': {
    rationale:
      'A finite configured retry/key chain or provider-owned polling/stream protocol advances on explicit responses and aborts; no guessed local delay establishes correctness.',
    ids: [
      'src/api/client.ts|fetchWithKeyFallback|ForStatement|bounded|1',
      'src/api/video-generation.ts|consumeVideoGeneration|ForStatement|unbounded|1',
      'src/store/generation-attempt-runner.ts|runGenerationAttempt|ForStatement|unbounded|1',
      'src/store/request-planning.ts|prepareAssistantRequestPlanFromContextSelection|ForStatement|unbounded|1',
    ],
  },
  'workspace-slot-revalidation': {
    rationale:
      'Startup reads the committed active slot, acquires its shared lease, and confirms the active database plus activation sequence. A failed confirmation proves an actual committed slot transition; the attempt authority cancels lock acquisition and every retry releases its exact lease.',
    ids: [
      'src/store/browser-workspace-database-selection.ts|selectBrowserWorkspaceDatabase|ForStatement|unbounded|1',
      'src/store/browser-workspace-startup-repair.ts|settlePendingBrowserWorkspaceReplacement|ForStatement|unbounded|1',
    ],
  },
  'replacement-contender-readmission': {
    rationale:
      'A durable peer transition preempts only an unpromoted local contender. The caller preserves the required replacement intent and re-admits only after runtime reconciliation publishes a new stable state; no timer, budget, or hot spin controls progress.',
    ids: [
      'src/store/browser-workspace-replacement-runner.ts|runBrowserWorkspaceReplacement|ForStatement|unbounded|1',
    ],
  },
  'bounded-pagination-scan': {
    rationale:
      'Each iteration consumes a keyset page or bounded maintenance batch and terminates on an explicit done/cursor condition; work is linear and resumable.',
    ids: [
      'src/backcompat/batched-table.ts|forEachTableBatch|ForStatement|unbounded|1',
      'src/backcompat/preset-sort-order.ts|forEachMigrationOrderBatch|ForStatement|unbounded|1',
      'src/backcompat/wave-a-preset-order-v94.ts|rebuildPresetOrderFromStagingV94|ForStatement|unbounded|1',
      'src/backcompat/wave-a-stream-storage-v94.ts|terminalizeStrandedGenerationHeadersV94|WhileStatement|bounded|1',
      'src/backcompat/wave-a-stream-storage-v94.ts|writeWaveAStreamEventV94|ForStatement|unbounded|1',
      'src/store/attachment-bulk-delete.ts|executeAttachmentBulkDelete|ForStatement|bounded|1',
      'src/store/attachment-bulk-delete.ts|planAttachmentBulkDelete|ForStatement|bounded|1',
      'src/store/browser-import-export.ts|tablePages|ForStatement|unbounded|1',
      'src/store/browser-catalog-command-runtime.ts|clearCalibrationEverywhereTransaction|ForStatement|unbounded|1',
      'src/store/browser-configuration-domain.ts|readConfigurationTargetFanoutLinks|ForStatement|unbounded|1',
      'src/store/browser-query-pages.ts|readChatMessageHeaderPages|ForStatement|unbounded|1',
      'src/store/browser-query-pages.ts|readChildHeaderPages|ForStatement|unbounded|1',
      'src/store/browser-query-pages.ts|readStringPrimaryKeyPages|ForStatement|unbounded|1',
      'src/store/browser-query-pages.ts|readStreamLeasePages|ForStatement|unbounded|1',
      'src/store/browser-workspace-compaction.ts|copyTable|ForStatement|unbounded|1',
      'src/store/browser-workspace-compaction.ts|drainBrowserWorkspaceCatchup|ForStatement|unbounded|1',
      'src/store/browser-workspace-derived-repair.ts|rebuildChildSlotDerivedState|ForStatement|unbounded|1',
      'src/store/browser-workspace-derived-repair.ts|forEachPrimaryPage|ForStatement|unbounded|1',
      'src/store/browser-workspace-startup-repair.ts|copyCanonicalBrowserWorkspaceRows|ForStatement|unbounded|1',
      'src/store/chat-search.ts|iterateSearchSidebarPages|ForStatement|unbounded|1',
      'src/store/chat-storage-ownership.ts|deleteKnownChatClosure|ForStatement|unbounded|1',
      'src/store/chat-sidebar-projection.ts|rebuildChatSidebarProjectionRowsInTransaction|ForStatement|unbounded|1',
      'src/store/chat-sidebar-projection.ts|rebuildChatSidebarProjectionRowsInTransaction|ForStatement|unbounded|2',
      'src/backcompat/sidebar-folder-presentation-v98.ts|migrateSidebarFolderPresentationV98|ForStatement|unbounded|1',
      'src/store/configuration-model-resolution-capability.ts|drainTarget|ForStatement|unbounded|1',
      'src/store/chats.ts|emptyArchivedChats|ForStatement|unbounded|1',
      'src/store/message-corpus-search.ts|search|ForStatement|unbounded|1',
      'src/store/preset-order.ts|rebuildPresetOrderMembership|ForStatement|unbounded|1',
      'src/store/search-session.ts|startDrain|ForStatement|unbounded|1',
      'src/store/stream-leases.ts|finishStreamCleanup|ForStatement|unbounded|1',
      'src/store/stream-recovery.ts|replayRecoveredStreamJournal|ForStatement|unbounded|1',
    ],
  },
  'stream-parser-consumer': {
    rationale:
      'A parser/async iterator drains finite input until EOF, terminal protocol evidence, or abort; the loop is not a retry policy.',
    ids: [
      'src/api/assistant-lanes.ts|[Symbol.asyncIterator]|ForStatement|unbounded|1',
      'src/api/client.ts|consumeResponseBody|ForStatement|unbounded|1',
      'src/api/sse.ts|parseSSE|ForStatement|unbounded|1',
      'src/api/sse.ts|parseSSE|ForStatement|unbounded|2',
      'src/core/reasoning-inline.ts|feed|ForStatement|unbounded|1',
      'src/store/branch-text.ts|consumeCanonicalBranchText|ForStatement|unbounded|1',
      'src/store/branch-text.ts|consumeCanonicalBranchText|ForStatement|bounded|1',
      'src/ui/chat/MarkdownView.tsx|guardOversizedCodeFences|ForStatement|unbounded|1',
      'src/ui/chat/MarkdownView.tsx|scanStreamingMarkdownBoundaries|ForStatement|unbounded|1',
    ],
  },
  'algorithmic-traversal': {
    rationale:
      'A graph/string/heap traversal advances an index, visited set, parent pointer, or heap position on every iteration and has no contention retry semantics.',
    ids: [
      'src/backcompat/reasoning-contract-normalizer-v92.ts|normalizeContinuationAttemptsV92|ForStatement|bounded|1',
      'src/backcompat/reasoning-envelope-v89.ts|claim|ForStatement|unbounded|1',
      'src/backcompat/wave-a-stream-storage-v94.ts|flush|ForStatement|bounded|1',
      'src/core/attachment-refs.ts|attachmentRefsFromIds|ForStatement|unbounded|1',
      'src/core/messages.ts|targetedPairFollowers|ForStatement|unbounded|1',
      'src/core/messages.ts|targetedPairFollowers|ForStatement|unbounded|2',
      'src/core/model-ids.ts|stripRepeatedProviderDecoration|ForStatement|unbounded|1',
      'src/core/branch-flatten.ts|messageRenderableTextSemanticsEqual|ForStatement|unbounded|1',
      'src/core/continuation-content.ts|appliedAttemptEnvelopeSequenceEqual|ForStatement|unbounded|1',
      'src/core/continuation-content.ts|appliedAttemptMemberSequenceEqual|ForStatement|unbounded|1',
      'src/core/continuation-content.ts|appliedAttemptMemberSequenceEqual|WhileStatement|bounded|1',
      'src/core/continuation-content.ts|appliedAttemptMemberSequenceEqual|WhileStatement|bounded|2',
      'src/core/provider-tool-context.ts|toolEvidenceSectionsForMessage|ForStatement|bounded|1',
      'src/core/tree-ops.ts|createAncestorOutsideSetResolver|ForStatement|unbounded|1',
      'src/store/attempt-workspace.ts|applyPoints|ForStatement|bounded|1',
      'src/store/attempt-controller.ts|reconcileLeasePoints|ForStatement|bounded|1',
      'src/store/browser-command-mutation-journal.ts|recordSuccessfulStreamJournalRetirements|ForStatement|bounded|1',
      'src/store/browser-repo.ts|newestLiveLeafIdInTransaction|ForStatement|unbounded|1',
      'src/store/browser-repo.ts|readConversationPageStructureEnvelope|ForStatement|bounded|1',
      'src/store/conversation-controller.ts|rememberTerminal|ForStatement|unbounded|1',
      'src/store/recovery-retry-scheduler.ts|runDue|WhileStatement|bounded|1',
      'src/store/recovery-retry-scheduler.ts|sinkDown|ForStatement|unbounded|1',
      'src/store/repository.ts|joinKnownBranchPageMaterial|ForStatement|bounded|1',
      'src/store/storage-maintenance-runtime.ts|#selectRunnableTask|ForStatement|bounded|1',
      'src/store/storage-maintenance-runtime.ts|#selectRunnableTask|ForStatement|bounded|2',
      'src/store/stream-chunk-writer.ts|workers|ForStatement|unbounded|1',
      'src/store/stream-recovery.ts|sinkLeaseDeadlineDown|ForStatement|unbounded|1',
      'src/store/transcript-window.ts|findPageLeaf|ForStatement|unbounded|1',
      'src/store/transcript-window.ts|newestStalePageLeaf|WhileStatement|bounded|1',
      'src/store/transcript-window.ts|newestStalePageLeaf|ForStatement|bounded|1',
    ],
  },
  'collision-free-name-search': {
    rationale:
      'Candidate names/namespaces advance deterministically until an unused value is observed; no elapsed/count cap converts contention into failure.',
    ids: [
      'src/store/browser-import-export.ts|uniquePresetName|ForStatement|unbounded|1',
      'src/store/browser-import-export.ts|uniqueConnectionName|ForStatement|unbounded|1',
      'src/store/import-export.ts|unusedGeneratedOutputNamespace|ForStatement|unbounded|1',
    ],
  },
  'lifecycle-work-drain': {
    rationale:
      'A queue/flush/lease drain repeatedly consumes explicitly pending work and exits when the tracked set/queue is empty or runtime closes.',
    ids: [
      'src/store/configuration-controller.ts|flushUntilSettled|ForStatement|unbounded|1',
      'src/store/configuration-model-resolution-capability.ts|awaitConfigurationModelResolutionCapabilityIdle|ForStatement|unbounded|1',
      'src/store/browser-workspace-lifecycle.ts|fulfillBrowserWorkspaceRuntimeDemand|ForStatement|unbounded|1',
      'src/store/browser-workspace-replacement-runner.ts|performBrowserWorkspaceReplacementLaunch|ForStatement|unbounded|1',
      'src/store/generated-output-localization-capability.ts|awaitGeneratedOutputLocalizationCapabilityIdle|ForStatement|unbounded|1',
      'src/store/generated-output-localization-runtime.ts|awaitGeneratedOutputLocalizationRuntimeIdle|ForStatement|unbounded|1',
      'src/store/stream-recovery-capability.ts|awaitStreamRecoveryCapabilityIdle|ForStatement|unbounded|1',
      'src/store/stream-recovery.ts|awaitStreamRecoveryRuntimeIdle|ForStatement|unbounded|1',
      'src/store/stream-recovery.ts|drainLeaseReads|WhileStatement|bounded|1',
      'src/store/stream-recovery.ts|drainLeaseReads|ForStatement|bounded|1',
      'src/store/stream-recovery.ts|pumpRecoveryQueue|WhileStatement|bounded|1',
      'src/store/stream-chunk-writer.ts|settle|WhileStatement|bounded|1',
    ],
  },
  'coordination-lock-acquire': {
    rationale:
      'Coordination acquisition retries only after a durable lease check or an explicit infrastructure failure; fencing tokens and ownership-loss signals, not retry count, establish exclusivity.',
    ids: [
      'src/store/locks.ts|acquire|ForStatement|unbounded|1',
      'src/store/storage-maintenance-runtime.ts|#runOwnershipLifecycle|WhileStatement|bounded|1',
    ],
  },
}

const CSS_TIMING_INVENTORY = {
  'ui-motion': {
    rationale:
      'Visual-only transitions/animations use centralized motion tokens or explicit spinner/caret cadence; application state never waits for CSS completion.',
    ids: [
      'src/styles/branching.css||transition|fill var(--duration-fast) var(--ease-standard),\n    stroke-width var(--duration-fast) var(--ease-standard)|1',
      'src/styles/branching.css||transition|background var(--duration-fast) var(--ease-standard)|1',
      'src/styles/composer.css||transition|opacity var(--duration-fast) var(--ease-standard)|1',
      'src/styles/header.css||animation|natter-caret-blink 1.2s steps(2, end) infinite|1',
      'src/styles/header.css||transition|transform var(--duration-fast) var(--ease-standard)|1',
      'src/styles/header.css||transition|transform var(--duration-fast) var(--ease-standard)|2',
      'src/styles/icons.css||transition|transform var(--duration-fast) var(--ease-standard)|1',
      'src/styles/motion.css||animation|natter-fade-in var(--duration-fast) var(--ease-standard)|1',
      'src/styles/motion.css||animation|natter-spin 1s linear infinite|1',
      'src/styles/motion.css||animation|natter-spin 1s linear infinite|2',
      'src/styles/motion.css||scroll-behavior|smooth|1',
      'src/styles/pickers.css||transition|background-color var(--duration-fast) var(--ease-standard),\n      border-color var(--duration-fast) var(--ease-standard),\n      box-shadow var(--duration-fast) var(--ease-standard),\n      opacity var(--duration-fast) var(--ease-standard)|1',
      'src/styles/pickers.css||transition|width 120ms ease-out|1',
      'src/styles/primitives.css||transition|background var(--duration-fast) var(--ease-standard),\n    border-color var(--duration-fast) var(--ease-standard)|1',
      'src/styles/reasoning.css||transition|transform var(--duration-fast) var(--ease-standard)|1',
      'src/styles/reasoning.css||transition|transform var(--duration-fast) var(--ease-standard)|2',
      'src/styles/reasoning.css||transition|color var(--duration-fast) var(--ease-standard),\n    background-color var(--duration-fast) var(--ease-standard)|1',
      'src/styles/reasoning.css||transition|transform var(--duration-fast) var(--ease-standard)|3',
      'src/styles/settings-pane.css||transition|transform 120ms ease|1',
      'src/styles/settings-pane.css||transition|transform 120ms ease|2',
      'src/styles/shell.css||transition|opacity var(--duration-fast) var(--ease-standard),\n    background var(--duration-fast) var(--ease-standard),\n    right var(--duration-fast) var(--ease-standard)|1',
      'src/styles/shell.css||transition|background var(--duration-fast) var(--ease-standard)|1',
      'src/styles/shell.css||transition|transform var(--duration-normal) var(--ease-decelerate),\n      opacity var(--duration-fast) var(--ease-standard)|1',
      'src/styles/shell.css||scroll-behavior|auto|1',
      'src/styles/sidebar.css||transition|none|1',
      'src/styles/sidebar.css||transition|none|2',
      'src/styles/tokens.css||--duration-instant|0ms|1',
      'src/styles/tokens.css||--duration-fast|120ms|1',
      'src/styles/tokens.css||--duration-normal|200ms|1',
      'src/styles/tokens.css||--duration-slow|320ms|1',
    ],
  },
  'reduced-motion-override': {
    rationale:
      'Reduced-motion and print/static contexts explicitly zero or remove animations and transitions.',
    ids: [
      'src/styles/motion.css||animation-duration|0ms|1',
      'src/styles/motion.css||transition-duration|0ms|1',
      'src/styles/motion.css||scroll-behavior|auto|1',
      'src/styles/motion.css||animation|none|1',
      'src/styles/motion.css||animation-duration|0ms|2',
      'src/styles/motion.css||transition-duration|0ms|2',
    ],
  },
}

const TEMPORAL_INPUT_INVENTORY = {
  'domain-clock-injection': {
    rationale:
      'The operation accepts/copies one explicit wall-clock instant or injected clock provider so an atomic command and its projections share a time source; it never waits for that value.',
    ids: [
      'src/core/branch-flatten.ts|exportFilename|now|Date.now()|1',
      'src/core/stream-accumulator.ts|replayStreamAccumulatorState|now|input.now|1',
      'src/core/token-calibration.ts|addSampleToChat|now|Date.now()|1',
      'src/store/attempt-terminalization.ts|projectAttemptTerminal|now|input.finishedAt|1',
      'src/store/attachments.ts|ingestAttachmentBytes|now|input.now|1',
      'src/store/attachments.ts|prepareAttachmentBytes|now|input.now|1',
      'src/store/attachments.ts|replaceAttachmentBytes|now|input.now|1',
      'src/store/attachments.ts|relinkAttachmentRef|now|input.now|1',
      'src/store/attachments.ts|deleteReferencedAttachmentBytes|now|Date.now()|1',
      'src/store/attachments.ts|restoreMissingAttachment|now|input.now|1',
      'src/store/browser-import-export.ts|browserWorkspaceReplacementBlockers|now|Date.now()|1',
      'src/store/browser-repo.ts|mutateSingleAttachmentReference|now|Date.now()|1',
      'src/store/browser-catalog-command-runtime.ts|materializeTemporaryChat|now|input.now|1',
      'src/store/chats.ts|materializeTemporaryChat|now|input.now ?? Date.now()|1',
      'src/store/chats.ts|archiveChats|now|Date.now()|1',
      'src/store/chats.ts|archiveChat|now|Date.now()|1',
      'src/store/chats.ts|unarchiveChats|now|Date.now()|1',
      'src/store/chats.ts|unarchiveChat|now|Date.now()|1',
      'src/store/chats.ts|deleteArchivedChatsPermanently|now|Date.now()|1',
      'src/store/chats.ts|deleteArchivedChatPermanently|now|Date.now()|1',
      'src/store/chats.ts|emptyArchivedChats|now|Date.now()|1',
      'src/store/chats.ts|moveChatsToFolder|now|Date.now()|1',
      'src/store/chats.ts|moveChatToFolder|now|Date.now()|1',
      'src/store/chats.ts|setChatsTagsFromNames|now|Date.now()|1',
      'src/store/chats.ts|setChatTagsFromNames|now|Date.now()|1',
      'src/store/chats.ts|clearChatTokenCalibration|now|Date.now()|1',
      'src/store/chats.ts|clearTokenCalibrationFamilyEverywhere|now|Date.now()|1',
      'src/store/chats.ts|clearAllTokenCalibrationEverywhere|now|Date.now()|1',
      'src/store/chats.ts|touchLastViewed|now|Date.now()|1',
      'src/store/chats.ts|setManualTitle|now|Date.now()|1',
      'src/store/configuration-domain.ts|addImageOrigin|now|Date.now()|1',
      'src/store/configuration-domain.ts|removeImageOrigin|now|Date.now()|1',
      'src/store/configuration-domain.ts|patchRenderingPreferences|now|Date.now()|1',
      'src/store/configuration-domain.ts|setSamplePromptsDismissed|now|Date.now()|1',
      'src/store/configuration-domain.ts|duplicateConnection|now|options.now ?? Date.now()|1',
      'src/store/configuration-domain.ts|archiveConnection|now|Date.now()|1',
      'src/store/configuration-domain.ts|unarchiveConnection|now|Date.now()|1',
      'src/store/configuration-domain.ts|deleteConnection|now|options.now ?? Date.now()|1',
      'src/store/configuration-domain.ts|patchChatSettings|now|options.now ?? Date.now()|1',
      'src/store/configuration-domain.ts|patchChatSettingsFields|now|options.now ?? Date.now()|1',
      'src/store/configuration-domain.ts|replaceChatSettings|now|options.now ?? Date.now()|1',
      'src/store/configuration-domain.ts|switchChatProfile|now|input.now ?? Date.now()|1',
      'src/store/configuration-model-resolution-capability.ts|drainTarget|now|Date.now()|1',
      'src/store/configuration-domain.ts|duplicateChatPreset|now|options.now ?? Date.now()|1',
      'src/store/configuration-domain.ts|applyChatPreset|now|Date.now()|1',
      'src/store/configuration-domain.ts|saveChatPreset|now|input.now ?? Date.now()|1',
      'src/store/configuration-domain.ts|renameChatPreset|now|Date.now()|1',
      'src/store/configuration-domain.ts|moveChatPreset|now|Date.now()|1',
      'src/store/configuration-domain.ts|archiveChatPreset|now|Date.now()|1',
      'src/store/configuration-domain.ts|unarchiveChatPreset|now|Date.now()|1',
      'src/store/configuration-domain.ts|deleteChatPreset|now|Date.now()|1',
      'src/store/configuration-domain.ts|updateTextTemplate|now|Date.now()|1',
      'src/store/configuration-domain.ts|deleteTextTemplate|now|Date.now()|1',
      'src/store/configuration-domain.ts|commitPromptText|now|Date.now()|1',
      'src/store/configuration-domain.ts|loadPromptPreset|now|Date.now()|1',
      'src/store/configuration-domain.ts|overwriteAndPinPromptPreset|now|Date.now()|1',
      'src/store/configuration-domain.ts|renamePromptPreset|now|Date.now()|1',
      'src/store/configuration-domain.ts|deletePromptPreset|now|Date.now()|1',
      'src/store/discovery-cache-policy.ts|isFresh|now|Date.now()|1',
      'src/store/folders.ts|deleteFolderWithDisposition|now|Date.now()|1',
      'src/store/generated-images.ts|prepareGeneratedOutputRemoteBundle|now|input.now|1',
      'src/store/generated-images.ts|mergeGeneratedImageAttachmentRefs|now|Date.now()|1',
      'src/store/generated-images.ts|materializeOneGeneratedImage|now|input.now|1',
      'src/store/generated-images.ts|materializeOneGeneratedAudio|now|input.now|1',
      'src/store/generated-images.ts|materializeOneGeneratedVideo|now|input.now|1',
      'src/store/generated-images.ts|materializeOneGeneratedFile|now|input.now|1',
      'src/store/generated-images.ts|createGeneratedImageAttachment|now|input.now|1',
      'src/store/generated-images.ts|createGeneratedImageAttachment|now|input.now|2',
      'src/store/generated-images.ts|createGeneratedAudioAttachment|now|input.now|1',
      'src/store/generated-images.ts|createGeneratedAudioAttachment|now|input.now|2',
      'src/store/generated-images.ts|createGeneratedVideoAttachment|now|input.now|1',
      'src/store/generated-images.ts|createGeneratedVideoAttachment|now|input.now|2',
      'src/store/generated-images.ts|createGeneratedFileAttachment|now|input.now|1',
      'src/store/generated-images.ts|createGeneratedFileAttachment|now|input.now|2',
      'src/store/generated-images.ts|createOrPrepareGeneratedRemoteAttachment|now|input.now ?? Date.now()|1',
      'src/store/generated-output-localization-capability.ts|drainQueueProbes|now|Date.now()|1',
      'src/store/generated-output-localization-runtime.ts|processRemoteDownload|now|Date.now()|1',
      'src/store/generated-output-localization-runtime.ts|processRemoteDownload|now|Date.now()|2',
      'src/store/generated-output-localization-runtime.ts|failClaim|now|Date.now()|1',
      'src/store/generation-admission.ts|capturedPrivacyRowIsFresh|now|Date.now()|1',
      'src/store/generation-admission.ts|capturedEndpointsRowIsFresh|now|Date.now()|1',
      'src/store/generation-attempt-runner.ts|runGenerationAttempt|now|publishNow|1',
      'src/store/generation-attempt-runner.ts|task|now|publishNow|1',
      'src/store/generation-engine.ts|runGeneration|now|preparedState.result.lease.startedAt|1',
      'src/store/generation-engine.ts|runGeneration|now|runtime.lease.startedAt|1',
      'src/store/generation-engine.ts|runGeneration|now|input.now|1',
      'src/store/generation-engine.ts|execution|now|input.now|1',
      'src/store/generation-engine.ts|prepareAttempt|now|createdAt|1',
      'src/store/generation-projection.ts|projectGenerationLiveAttempt|now|input.publishedAt|1',
      'src/store/global-settings.ts|setPinnedModel|now|Date.now()|1',
      'src/store/global-settings.ts|movePinnedModel|now|Date.now()|1',
      'src/store/global-settings.ts|clearRecentModels|now|Date.now()|1',
      'src/store/global-settings.ts|writeGlobalPreference|now|Date.now()|1',
      'src/store/import-export.ts|canonicalizeImportedGeneratedOutputs|now|nextMessage.createdAt|1',
      'src/store/keys.ts|initialize|now|Date.now()|1',
      'src/store/keys.ts|remove|now|Date.now()|1',
      'src/store/recovery-retry-scheduler.ts|recordFailure|now|Date.now()|1',
      'src/store/sidebar-preferences.ts|writeSidebarSortMode|now|Date.now()|1',
      'src/store/sidebar-preferences.ts|setSidebarFolderCollapsed|now|Date.now()|1',
      'src/store/stream-lease-policy.ts|classifyStreamLeaseWallClockFreshness|now|Date.now()|1',
      'src/store/stream-lease-policy.ts|isFreshStreamLease|now|Date.now()|1',
      'src/store/stream-leases.ts|scheduleHeartbeatTimer|now|heartbeatSchedulerNow()|1',
      'src/store/stream-recovery.ts|observeLease|deadline|tracked?.freshnessDeadline ?? schedulerNow|1',
      'src/store/stream-recovery.ts|recoverStreamOrphan|now|Date.now()|1',
      'src/store/stream-recovery.ts|projectRecoveredAttempt|now|terminalNow|1',
      'src/store/stream-recovery.ts|replayRecoveredStreamJournal|now|input.now|1',
      'src/ui/header/ConnectionHeader.tsx|activateProfile|now|Date.now()|1',
      'src/ui/sidebar/chat-organization.ts|formatSidebarRowMeta|now|Date.now()|1',
    ],
  },
  'external-deadline-ttl-lease': {
    rationale:
      'A timeout, cache TTL, retry deadline, retention cutoff, or lease heartbeat is explicit input to an external/durable policy and is not inferred from task completion timing.',
    ids: [
      'src/api/client.ts|dispatchJsonWithApiKeyFallback|timeoutMs|input.timeoutMs|1',
      'src/api/client.ts|dispatchProviderJsonRequest|timeoutMs|input.opts.timeoutMs|1',
      'src/api/generated-output.ts|getGeneratedOutput|timeoutMs|options.timeoutMs|1',
      'src/api/probe.ts|probeLlamaServer|timeoutMs|opts.timeoutMs ?? 3_000|1',
      'src/api/probe.ts|applyServerTemplate|timeoutMs|opts.timeoutMs ?? 5_000|1',
      'src/api/video-generation.ts|getVideoGeneration|timeoutMs|ctx.timeoutMs|1',
      'src/api/video-generation.ts|videoGeneration|timeoutMs|opts.timeoutMs|1',
      "src/core/defaults.ts|<module>|ttl|'5m'|1",
      'src/store/configuration-discovery-coordinator.ts|plans|ttlMs|MODELS_TTL_MS|1',
      'src/store/configuration-discovery-coordinator.ts|plans|ttlMs|ENDPOINTS_TTL_MS|1',
      'src/store/configuration-discovery-coordinator.ts|plans|ttlMs|hasPolicies ? PRIVACY_POLICY_TTL_MS : EMPTY_PRIVACY_POLICY_RETRY_MS|1',
      'src/store/browser-lock-record.ts|emptyBrowserLockRow|heartbeatAt|0|1',
      'src/store/browser-lock-record.ts|emptyBrowserLockRow|expiresAt|0|1',
      'src/store/browser-repo.ts|pruneEmptyDraftChats|cutoff|cycle.cutoff|1',
      'src/store/browser-repo.ts|pruneTerminalStreamJournals|cutoff|cycle.cutoff|1',
      'src/store/browser-repo.ts|runningGeneratedOutputLocalizationJob|leaseExpiresAt|input.leaseExpiresAt|1',
      'src/store/browser-repo.ts|renewStreamLease|heartbeatAt|heartbeat.heartbeatAt|1',
      'src/store/browser-repo.ts|claimStreamLeaseForRecovery|heartbeatAt|now|1',
      'src/store/browser-mutation-runtime.ts|setStreamAdmissionPostCommit|heartbeatAt|now|1',
      'src/store/connection-probe-application.ts|runConfigurationConnectionProbe|timeoutMs|3_000|1',
      'src/store/connection-probe-application.ts|runConfigurationConnectionProbe|timeoutMs|3_000|2',
      'src/store/connection-probe-application.ts|loadConfigurationConnectionModelCatalog|timeoutMs|options.timeoutMs ?? 15_000|1',
      'src/store/connection-probe-planning.ts|resolveEndpoints|timeoutMs|15_000|1',
      'src/store/connection-probe-planning.ts|resolvePrivacy|timeoutMs|15_000|1',
      'src/store/attempt-availability.ts|recoveryDirective|deadline|freshness.deadline|1',
      'src/store/attempt-availability.ts|recoveryDirective|deadline|freshness.deadline|2',
      'src/store/stream-journal-storage.ts|appendStreamJournalFrames|heartbeatAt|observedAt|1',
      'src/store/stream-recovery.ts|recoverStreamOrphanCore|deadline|point.freshnessDeadline|1',
      'src/store/discovery-service.ts|<module>|modelsTtlMs|MODELS_TTL_MS|1',
      'src/store/discovery-service.ts|<module>|endpointsTtlMs|ENDPOINTS_TTL_MS|1',
      'src/store/discovery-service.ts|<module>|privacyTtlMs|PRIVACY_POLICY_TTL_MS|1',
      'src/store/discovery-service.ts|<module>|emptyPrivacyRetryMs|EMPTY_PRIVACY_POLICY_RETRY_MS|1',
      'src/store/discovery-service.ts|resolveModelsDiscovery|timeoutMs|options.timeoutMs|1',
      'src/store/discovery-service.ts|resolveEndpointsDiscovery|timeoutMs|options.timeoutMs|1',
      'src/store/discovery-service.ts|resolvePrivacyDiscovery|timeoutMs|options.timeoutMs|1',
      'src/store/generated-output-localization-runtime.ts|processJobWithPermit|leaseExpiresAt|now + LEASE_TTL_MS|1',
      'src/store/generation-engine.ts|preparedStreamLeaseAdmission|heartbeatAt|startedAt|1',
      'src/store/generation-planning-reader.ts|resolveEndpointsOnce|timeoutMs|15_000|1',
      'src/store/generation-planning-reader.ts|resolvePrivacyOnce|timeoutMs|15_000|1',
      'src/store/locks.ts|acquire|heartbeatAt|now|1',
      'src/store/locks.ts|acquire|expiresAt|now + this.leaseMs|1',
      'src/store/locks.ts|renew|heartbeatAt|now|1',
      'src/store/locks.ts|renew|expiresAt|now + this.leaseMs|1',
      'src/store/locks.ts|release|heartbeatAt|this.now()|1',
      'src/store/locks.ts|release|expiresAt|0|1',
      'src/store/recovery-retry-scheduler.ts|recordFailure|nextRetryAt|undefined|1',
      'src/store/recovery-retry-scheduler.ts|stateFromEntry|nextRetryAt|entry.nextRetryAt|1',
      'src/store/storage-administration.ts|ready|timeoutMs|STORAGE_ADMIN_PHASE_TIMEOUT_MS|1',
      `src/store/storage-administration.ts|performClear|deadlineAt|Date.now() +
        precommitLeaseDuration(
          phaseTimeoutMs,
          options.blockedTimeoutMs ?? STORAGE_ADMIN_EXCLUSIVE_TIMEOUT_MS,
        )|1`,
      'src/store/storage-administration.ts|performClear|deadlineAt|Date.now() + (options.committedLeaseMs ?? STORAGE_ADMIN_COMMITTED_LEASE_MS)|1',
      'src/store/storage-maintenance-runtime.ts|#runAttachmentRetentionSlice|now|Date.now()|1',
      'src/store/storage-maintenance-runtime.ts|#runAttachmentRetentionSlice|maxAgeMs|ORPHAN_ATTACHMENT_AGE_MS|1',
      'src/store/storage-maintenance-runtime.ts|#runTerminalRetentionSlice|now|Date.now()|1',
      'src/store/storage-maintenance-runtime.ts|#runTerminalRetentionSlice|maxAgeMs|TERMINAL_STREAM_JOURNAL_AGE_MS|1',
      'src/store/storage-maintenance-runtime.ts|#runDraftRetentionSlice|now|Date.now()|1',
      'src/store/storage-maintenance-runtime.ts|#runDraftRetentionSlice|maxAgeMs|EMPTY_DRAFT_CHAT_AGE_MS|1',
      'src/store/storage-maintenance-runtime.ts|#runSlice|now|Date.now()|1',
      'src/store/storage-retention-state.ts|storageRetentionCycle|cutoff|row.cutoff|1',
      'src/store/storage-retention-state.ts|storageRetentionCycle|cutoff|Math.max(0, now - maxAgeMs)|1',
      'src/store/storage-retention-state.ts|advanceStorageRetentionState|cutoff|cycle.cutoff|1',
      'src/store/stream-leases.ts|createLeaseWriter|nextHeartbeatAt|null|1',
      'src/store/stream-leases.ts|enqueueLeaseWrite|heartbeatAt|Date.now()|1',
      'src/store/stream-lease-policy.ts|observeStreamLeaseFreshness|deadline|schedulerNow|1',
      'src/store/stream-recovery.ts|<module>|deadline|1|1',
      'src/store/stream-recovery.ts|<module>|baseDelayMs|2_000|1',
      'src/store/stream-recovery.ts|<module>|maxDelayMs|60_000|1',
      'src/store/stream-recovery.ts|<module>|baseDelayMs|2_000|2',
      'src/store/stream-recovery.ts|<module>|maxDelayMs|60_000|2',
      'src/store/stream-recovery.ts|streamRecoveryDiagnosticsSnapshot|nextRetryAt|entry.nextRetryAt|1',
    ],
  },
  'media-duration-metadata': {
    rationale:
      'durationMs describes audio/video media and is copied or derived as content metadata; it never schedules application work.',
    ids: [
      'src/backcompat/generated-output-attachments.ts|canonicalContentItem|durationMs|item.durationMs|1',
      'src/core/attachments/process-runtime.ts|processAttachmentLoaded|durationMs|metadata.durationMs|1',
      'src/core/attachments/process-runtime.ts|collectAudioMetadata|durationMs|wav.durationMs|1',
      'src/core/attachments/process-runtime.ts|wavMetadata|durationMs|Math.round((dataSize / byteRate) * 1000)|1',
      'src/core/attachments/stored-openrouter.ts|storedBundleToProcessResult|durationMs|attachment.durationMs|1',
      'src/store/attachment-catalog-projection.ts|attachmentCatalogProjectionRow|durationMs|attachment.durationMs|1',
      'src/store/attachments.ts|buildAttachment|durationMs|input.durationMs|1',
      'src/store/attachments.ts|bundleFromProcessed|durationMs|result.attachment.durationMs|1',
      'src/store/generated-images.ts|materializeOneGeneratedAudio|durationMs|input.item.durationMs|1',
    ],
  },
  'ephemeral-ui-duration': {
    rationale:
      'durationMs controls only visible toast/confirmation lifetime; no persisted mutation, navigation, or cross-tab state is gated by expiry.',
    ids: [
      'src/store/zustand/toastStore.ts|push|durationMs|t.durationMs ?? 5000|1',
      'src/ui/chat/ChatHeader.tsx|handleExportJson|durationMs|2500|1',
      'src/ui/settings/ChatModelPanel.tsx|saveToExisting|durationMs|2500|1',
      'src/ui/settings/ChatModelPanel.tsx|commit|durationMs|2500|1',
      'src/ui/settings/ChatModelPanel.tsx|exportPresetJson|durationMs|2500|1',
      'src/ui/settings/ChatModelPanel.tsx|importPresetJson|durationMs|3000|1',
      'src/ui/settings/PromptPresetEditor.tsx|saveToExisting|durationMs|2500|1',
      'src/ui/settings/PromptPresetEditor.tsx|saveAsNew|durationMs|2500|1',
      'src/ui/sidebar/ChatList.tsx|handleImportChatFile|durationMs|2500|1',
      'src/ui/storage/StorageView.tsx|handleExportWorkspace|durationMs|2500|1',
      'src/ui/storage/StorageView.tsx|handleImportWorkspaceFile|durationMs|3000|1',
      'src/ui/storage/StorageChatsSurface.tsx|handleExportSelection|durationMs|2500|1',
      'src/ui/storage/StorageChatsSurface.tsx|handleExportSelection|durationMs|2500|2',
      'src/ui/storage/StorageChatsSurface.tsx|handleImportChatFile|durationMs|3000|1',
    ],
  },
  'bounded-yield-input': {
    rationale:
      'A zero-delay task boundary or idle-callback timeout bounds cooperative rendering/search work; correctness remains in the queue/state machine.',
    ids: [],
  },
  'catalog-query-transition-policy': {
    rationale:
      'The attachment catalog passes its explicit 150ms text-burst debounce into the shared transition scheduler; the first text/filter transition is still scheduled at 0ms, pending replacements cancel without aborting the visible active read, and the repository remains the correctness authority.',
    ids: [
      'src/store/attachment-search-session.ts|request|debounceMs|ATTACHMENT_SEARCH_DEBOUNCE_MS|1',
      'src/store/search-session.ts|commitRequest|debounceMs|input.debounceMs ?? SEARCH_DEBOUNCE_MS|1',
    ],
  },
  'ui-scroll-behavior': {
    rationale:
      'Programmatic scrolling explicitly chooses browser animation or immediate positioning; scroll ownership remains event/observer driven and never waits for a guessed duration.',
    ids: ["src/ui/chat/ScrollRegion.tsx|scrollToBottomNow|behavior|'smooth'|1"],
  },
  'migration-lease-timestamp': {
    rationale: 'Version-gated stream migration copies/synthesizes legacy heartbeat evidence once.',
    ids: [
      'src/backcompat/stream-lease-attempts.ts|migrateLegacyStreamLeaseLifecycle|heartbeatAt|legacy.heartbeatAt|1',
      'src/backcompat/wave-a-stream-storage-v94.ts|stageNormalizedLeaseV94|priorityHeartbeatAt|normalized.priorityHeartbeatAt|1',
      'src/backcompat/wave-a-stream-storage-v94.ts|flush|heartbeatAt|candidate.recencyAt|1',
      'src/backcompat/wave-a-stream-storage-v94.ts|flush|priorityHeartbeatAt|candidate.recencyAt|1',
      'src/backcompat/wave-a-stream-storage-v94.ts|normalizeStoredLeaseV94|priorityHeartbeatAt|nonNegativeIntegerV94(input.stored.heartbeatAt) ?? 0|1',
      'src/backcompat/wave-a-stream-storage-v94.ts|normalizeLegacyLeaseV94|heartbeatAt|heartbeatAt ?? startedAt|1',
      'src/backcompat/wave-a-stream-storage-v94.ts|normalizeLegacyLeaseV94|priorityHeartbeatAt|heartbeatAt ?? 0|1',
    ],
  },
}

const MAINTENANCE_INVENTORY = {
  'run-once-version-state': {
    rationale:
      'Compatibility repair reads a durable versioned phase marker first, resumes bounded keyset pages only while pending, and becomes an O(1) completed-state read on later starts.',
    ids: [
      'src/store/storage-maintenance-runtime.ts|#runSlice|maintenance.reconcile-attachment-integrity|1',
      'src/store/storage-maintenance-runtime.ts|#runSlice|maintenance.reconcile-stream-journal-integrity|1',
    ],
  },
  'evidence-deadline-keyset': {
    rationale:
      'Retention work starts from an indexed cutoff, returns the earliest deferred row, and rearms one deadline; it never performs a periodic whole-table sweep.',
    ids: [
      'src/store/storage-maintenance-runtime.ts|#runAttachmentRetentionSlice|attachment.reap|1',
      'src/store/storage-maintenance-runtime.ts|#runTerminalRetentionSlice|maintenance.prune-terminal-stream-journals|1',
      'src/store/storage-maintenance-runtime.ts|#runDraftRetentionSlice|maintenance.prune-empty-draft-chats|1',
    ],
  },
  'invalidated-state-audit': {
    rationale:
      'Discovery maintenance reads one aggregate validity row and returns immediately while valid; only a mutation-marked invalid state resumes bounded audit pages.',
    ids: ['src/store/storage-maintenance-runtime.ts|#runSlice|maintenance.prune-discovery-cache|1'],
  },
}

function sourceFiles(directory = SRC_ROOT) {
  return readdirSync(directory).flatMap((name) => {
    const path = resolve(directory, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.(?:ts|tsx)$/u.test(name) && !name.endsWith('.d.ts') ? [path] : []
  })
}

function cssFiles(directory = SRC_ROOT) {
  return readdirSync(directory).flatMap((name) => {
    const path = resolve(directory, name)
    if (statSync(path).isDirectory()) return cssFiles(path)
    return name.endsWith('.css') ? [path] : []
  })
}

function calleeName(expression) {
  if (ts.isIdentifier(expression)) return expression.text
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text
  return undefined
}

function unwrapExpression(expression) {
  let current = expression
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression
  }
  return current
}

function location(sourceFile, node) {
  const point = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
  return {
    file: relative(ROOT, sourceFile.fileName).replaceAll(sep, '/'),
    line: point.line + 1,
  }
}

function declarationName(node, sourceFile) {
  if (!node) return undefined
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text
  if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return node.text
  return node.getText(sourceFile)
}

function functionOwner(node, sourceFile) {
  let current = node.parent
  while (current) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isGetAccessorDeclaration(current) ||
      ts.isSetAccessorDeclaration(current)
    ) {
      const name = declarationName(current.name, sourceFile)
      if (name) return name
    }
    if (ts.isConstructorDeclaration(current)) return 'constructor'
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      const ownName = declarationName(current.name, sourceFile)
      if (ownName) return ownName
      const parent = current.parent
      if (ts.isVariableDeclaration(parent)) {
        const name = declarationName(parent.name, sourceFile)
        if (name) return name
      }
      if (ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent)) {
        const name = declarationName(parent.name, sourceFile)
        if (name) return name
      }
      if (ts.isCallExpression(parent) && ts.isVariableDeclaration(parent.parent)) {
        const name = declarationName(parent.parent.name, sourceFile)
        if (name) return name
      }
    }
    current = current.parent
  }
  return '<module>'
}

function clockContext(node, sourceFile) {
  let current = node.parent
  while (current) {
    if (ts.isVariableDeclaration(current)) {
      return `variable:${declarationName(current.name, sourceFile) ?? '<unknown>'}`
    }
    if (ts.isPropertyAssignment(current)) {
      return `property:${declarationName(current.name, sourceFile) ?? '<unknown>'}`
    }
    if (ts.isBinaryExpression(current)) {
      return `binary:${current.operatorToken.getText(sourceFile)}`
    }
    if (ts.isReturnStatement(current)) return 'return'
    if (ts.isCallExpression(current) && current !== node) {
      return `argument:${calleeName(current.expression) ?? current.expression.getText(sourceFile)}`
    }
    if (ts.isExpressionStatement(current)) return 'expression'
    if (ts.isStatement(current)) return ts.SyntaxKind[current.kind]
    current = current.parent
  }
  return '<module>'
}

export function discoverProductionTimeFacts() {
  const schedulers = []
  const durations = []
  const dateNowCounts = new Map()
  const clockReads = []
  const temporalInputs = []
  const dateConstructions = []
  const dateOperations = []
  const asyncRaces = []
  const retryLoops = []
  const cssTimings = []
  const countBudgets = []
  const maintenanceCommands = []
  const unsafeDeadlineRaces = []

  for (const file of sourceFiles()) {
    const text = readFileSync(file, 'utf8')
    const sourceFile = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    )
    const visit = (node) => {
      if (ts.isObjectLiteralExpression(node)) {
        const kindProperty = node.properties.find(
          (property) =>
            ts.isPropertyAssignment(property) &&
            declarationName(property.name, sourceFile) === 'kind',
        )
        if (kindProperty && ts.isPropertyAssignment(kindProperty)) {
          const kind = unwrapExpression(kindProperty.initializer)
          if (
            ts.isStringLiteralLike(kind) &&
            (kind.text.startsWith('maintenance.') || kind.text === 'attachment.reap')
          ) {
            maintenanceCommands.push({
              ...location(sourceFile, kindProperty),
              owner: functionOwner(node, sourceFile),
              maintenanceKind: kind.text,
            })
          }
        }
      }
      if (ts.isCallExpression(node)) {
        const name = calleeName(node.expression)
        if (name === 'runStorageAdministrationPhase') {
          const phase = node.arguments[0] ? unwrapExpression(node.arguments[0]) : undefined
          if (
            phase &&
            ts.isStringLiteralLike(phase) &&
            NON_ABORTABLE_DESTRUCTIVE_PHASES.has(phase.text)
          ) {
            unsafeDeadlineRaces.push({
              ...location(sourceFile, node),
              owner: functionOwner(node, sourceFile),
              phase: phase.text,
            })
          }
        }
        if (name && SCHEDULERS.has(name)) {
          const delay =
            name === 'setTimeout' || name === 'setInterval'
              ? (node.arguments[1]?.getText(sourceFile) ?? '<implicit>')
              : undefined
          schedulers.push({
            ...location(sourceFile, node),
            owner: functionOwner(node, sourceFile),
            scheduler: name,
            ...(delay ? { delay } : {}),
          })
        }
        if (
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === 'now' &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === 'Date'
        ) {
          const key = relative(ROOT, file).replaceAll(sep, '/')
          dateNowCounts.set(key, (dateNowCounts.get(key) ?? 0) + 1)
          clockReads.push({
            ...location(sourceFile, node),
            owner: functionOwner(node, sourceFile),
            clock: 'Date.now',
            context: clockContext(node, sourceFile),
          })
        } else if (
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === 'now' &&
          /(?:^|\.)performance$/u.test(node.expression.expression.getText(sourceFile))
        ) {
          clockReads.push({
            ...location(sourceFile, node),
            owner: functionOwner(node, sourceFile),
            clock: 'performance.now',
            context: clockContext(node, sourceFile),
          })
        }
        if (
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === 'Date' &&
          (node.expression.name.text === 'parse' || node.expression.name.text === 'UTC')
        ) {
          dateOperations.push({
            ...location(sourceFile, node),
            owner: functionOwner(node, sourceFile),
            operation: `Date.${node.expression.name.text}`,
            arguments: node.arguments.map((argument) => argument.getText(sourceFile)).join(', '),
          })
        }
        if (
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === 'Promise' &&
          node.expression.name.text === 'race'
        ) {
          asyncRaces.push({
            ...location(sourceFile, node),
            owner: functionOwner(node, sourceFile),
            kind: 'Promise.race',
          })
        }
        if (
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === 'AbortSignal' &&
          node.expression.name.text === 'timeout'
        ) {
          asyncRaces.push({
            ...location(sourceFile, node),
            owner: functionOwner(node, sourceFile),
            kind: 'AbortSignal.timeout',
          })
        }
      }
      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'Date'
      ) {
        dateConstructions.push({
          ...location(sourceFile, node),
          owner: functionOwner(node, sourceFile),
          arguments:
            node.arguments?.map((argument) => argument.getText(sourceFile)).join(', ') ?? '',
        })
      }
      if (
        ts.isNewExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === 'Intl' &&
        /^(?:DateTime|Duration|RelativeTime)Format$/u.test(node.expression.name.text)
      ) {
        dateOperations.push({
          ...location(sourceFile, node),
          owner: functionOwner(node, sourceFile),
          operation: `Intl.${node.expression.name.text}`,
          arguments:
            node.arguments?.map((argument) => argument.getText(sourceFile)).join(', ') ?? '',
        })
      }
      if (ts.isForStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)) {
        const loopText = node.getText(sourceFile)
        const unbounded =
          (ts.isForStatement(node) && node.condition === undefined) ||
          ((ts.isWhileStatement(node) || ts.isDoStatement(node)) &&
            node.expression.kind === ts.SyntaxKind.TrueKeyword)
        if (
          unbounded ||
          /(?:attempt|conflict|plan(?:ned)?(?:\s|[A-Z_])*changed|replan|retry|stale)/iu.test(
            loopText,
          )
        ) {
          retryLoops.push({
            ...location(sourceFile, node),
            owner: functionOwner(node, sourceFile),
            loop: ts.SyntaxKind[node.kind],
            unbounded,
          })
        }
      }
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        TEMPORAL_NAME.test(node.name.text)
      ) {
        durations.push({
          ...location(sourceFile, node),
          name: node.name.text,
          value: node.initializer?.getText(sourceFile) ?? '<uninitialized>',
        })
      }
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        COUNT_BUDGET_NAME.test(node.name.text)
      ) {
        countBudgets.push({
          ...location(sourceFile, node),
          owner: functionOwner(node, sourceFile),
          name: node.name.text,
          value: node.initializer?.getText(sourceFile) ?? '<uninitialized>',
        })
      }
      if (
        ts.isPropertyAssignment(node) &&
        declarationName(node.name, sourceFile) === 'maxAttempts'
      ) {
        countBudgets.push({
          ...location(sourceFile, node),
          owner: functionOwner(node, sourceFile),
          name: 'maxAttempts',
          value: node.initializer.getText(sourceFile),
        })
      }
      if (
        (ts.isPropertyAssignment(node) || ts.isParameter(node) || ts.isPropertyDeclaration(node)) &&
        node.initializer
      ) {
        const name = declarationName(node.name, sourceFile)
        const scrollBehavior =
          name === 'behavior' &&
          ts.isStringLiteralLike(node.initializer) &&
          (node.initializer.text === 'smooth' || node.initializer.text === 'auto')
        if (name && (TEMPORAL_INPUT_NAME.test(name) || scrollBehavior)) {
          temporalInputs.push({
            ...location(sourceFile, node),
            owner: functionOwner(node, sourceFile),
            name,
            value: node.initializer.getText(sourceFile),
            syntax: ts.SyntaxKind[node.kind],
          })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }

  for (const file of cssFiles()) {
    const text = readFileSync(file, 'utf8')
    const declaration =
      /((?:--[\w-]*(?:duration|delay)[\w-]*|animation(?:-duration|-delay)?|scroll-behavior|transition(?:-duration|-delay)?))\s*:\s*([^;}]+)/gmu
    for (const match of text.matchAll(declaration)) {
      const value = match[2]?.trim() ?? ''
      if (!/(?:\d(?:\.\d+)?m?s\b|--duration-|animation|transition|none|smooth|auto)/u.test(value)) {
        continue
      }
      const index = (match.index ?? 0) + match[0].indexOf(match[1] ?? '')
      const before = text.slice(0, index)
      cssTimings.push({
        file: relative(ROOT, file).replaceAll(sep, '/'),
        line: before.split('\n').length,
        property: match[1],
        value,
      })
    }
  }

  schedulers.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line)
  durations.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line)
  clockReads.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line)
  temporalInputs.sort(
    (left, right) => left.file.localeCompare(right.file) || left.line - right.line,
  )
  dateConstructions.sort(
    (left, right) => left.file.localeCompare(right.file) || left.line - right.line,
  )
  dateOperations.sort(
    (left, right) => left.file.localeCompare(right.file) || left.line - right.line,
  )
  asyncRaces.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line)
  retryLoops.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line)
  cssTimings.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line)
  countBudgets.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line)
  maintenanceCommands.sort(
    (left, right) => left.file.localeCompare(right.file) || left.line - right.line,
  )
  unsafeDeadlineRaces.sort(
    (left, right) => left.file.localeCompare(right.file) || left.line - right.line,
  )

  const schedulerSignatureCounts = new Map()
  for (const scheduler of schedulers) {
    const base = [scheduler.file, scheduler.owner, scheduler.scheduler, scheduler.delay ?? ''].join(
      '|',
    )
    const occurrence = (schedulerSignatureCounts.get(base) ?? 0) + 1
    schedulerSignatureCounts.set(base, occurrence)
    scheduler.id = `${base}|${occurrence}`
  }

  for (const duration of durations) {
    duration.id = `${duration.file}|${duration.name}|${duration.value}`
  }

  const clockSignatureCounts = new Map()
  for (const clockRead of clockReads) {
    const base = [clockRead.file, clockRead.owner, clockRead.clock].join('|')
    const occurrence = (clockSignatureCounts.get(base) ?? 0) + 1
    clockSignatureCounts.set(base, occurrence)
    clockRead.id = `${base}|${occurrence}`
  }

  for (const rows of [
    temporalInputs,
    dateConstructions,
    dateOperations,
    asyncRaces,
    retryLoops,
    cssTimings,
    countBudgets,
    maintenanceCommands,
    unsafeDeadlineRaces,
  ]) {
    const counts = new Map()
    for (const row of rows) {
      const detail =
        row.name !== undefined
          ? `${row.name}|${row.value}`
          : row.phase !== undefined
            ? `destructive-deadline-race|${row.phase}`
            : row.maintenanceKind !== undefined
              ? row.maintenanceKind
              : row.operation !== undefined
                ? `${row.operation}|${row.arguments}`
                : row.kind !== undefined
                  ? row.kind
                  : row.loop !== undefined
                    ? `${row.loop}|${row.unbounded ? 'unbounded' : 'bounded'}`
                    : row.property !== undefined
                      ? `${row.property}|${row.value}`
                      : `new Date|${row.arguments}`
      const base = [row.file, row.owner, detail].join('|')
      const occurrence = (counts.get(base) ?? 0) + 1
      counts.set(base, occurrence)
      row.id = `${base}|${occurrence}`
    }
  }

  return {
    schedulers,
    durations,
    clockReads,
    temporalInputs,
    dateConstructions,
    dateOperations,
    asyncRaces,
    retryLoops,
    cssTimings,
    countBudgets,
    maintenanceCommands,
    unsafeDeadlineRaces,
    dateNowCounts: Object.fromEntries([...dateNowCounts].sort()),
  }
}

function categorizedInventory(inventoryByCategory, kind = 'ids') {
  const categorized = new Map()
  const duplicates = []
  for (const [category, inventory] of Object.entries(inventoryByCategory)) {
    if (!inventory.rationale?.trim()) duplicates.push(`<missing rationale:${category}>`)
    for (const id of inventory[kind]) {
      if (categorized.has(id)) duplicates.push(id)
      categorized.set(id, category)
    }
  }
  return { categorized, duplicates }
}

function inventoryFailures(label, inventoryByCategory, actualRows, kind = 'ids') {
  const { categorized, duplicates } = categorizedInventory(inventoryByCategory, kind)
  const actual = new Set(actualRows.map((row) => row.id))
  const failures = duplicates.map((id) => `duplicate ${label} inventory: ${id}`)
  for (const row of actualRows) {
    if (!categorized.has(row.id)) {
      failures.push(`uncategorized ${label} at ${row.file}:${row.line}: ${row.id}`)
    }
  }
  for (const id of categorized.keys()) {
    if (!actual.has(id)) failures.push(`stale ${label} inventory: ${id}`)
  }
  return failures
}

export function evaluateProductionTimeInventory(facts) {
  const failures = [
    ...inventoryFailures('scheduler', TEMPORAL_INVENTORY, facts.schedulers, 'schedulers'),
    ...inventoryFailures('duration', TEMPORAL_INVENTORY, facts.durations, 'durations'),
    ...inventoryFailures('clock read', CLOCK_INVENTORY, facts.clockReads),
    ...inventoryFailures('temporal input', TEMPORAL_INPUT_INVENTORY, facts.temporalInputs),
    ...inventoryFailures('Date construction', DATE_CONSTRUCTION_INVENTORY, facts.dateConstructions),
    ...inventoryFailures('date operation', DATE_OPERATION_INVENTORY, facts.dateOperations),
    ...inventoryFailures('async race/timeout primitive', ASYNC_RACE_INVENTORY, facts.asyncRaces),
    ...inventoryFailures('retry/replan loop', RETRY_LOOP_INVENTORY, facts.retryLoops),
    ...inventoryFailures('CSS timing declaration', CSS_TIMING_INVENTORY, facts.cssTimings),
    ...inventoryFailures(
      'startup/retention maintenance command',
      MAINTENANCE_INVENTORY,
      facts.maintenanceCommands,
    ),
  ]
  for (const budget of facts.countBudgets) {
    failures.push(
      `forbidden count-based temporal budget at ${budget.file}:${budget.line}: ${budget.id}`,
    )
  }
  for (const race of facts.unsafeDeadlineRaces) {
    failures.push(
      `forbidden non-abortable destructive deadline race at ${race.file}:${race.line}: ${race.id}`,
    )
  }
  return Object.freeze({
    ...facts,
    categories: TEMPORAL_INVENTORY,
    clockCategories: CLOCK_INVENTORY,
    temporalInputCategories: TEMPORAL_INPUT_INVENTORY,
    dateConstructionCategories: DATE_CONSTRUCTION_INVENTORY,
    dateOperationCategories: DATE_OPERATION_INVENTORY,
    asyncRaceCategories: ASYNC_RACE_INVENTORY,
    retryLoopCategories: RETRY_LOOP_INVENTORY,
    cssTimingCategories: CSS_TIMING_INVENTORY,
    maintenanceCategories: MAINTENANCE_INVENTORY,
    failures,
  })
}

export function buildProductionTimeInventory() {
  return evaluateProductionTimeInventory(discoverProductionTimeFacts())
}

function runCli() {
  const report = buildProductionTimeInventory()
  const sectionName = process.argv.find((argument) => argument.startsWith('--section='))?.slice(10)
  if (sectionName) {
    if (!(sectionName in report)) {
      throw new Error(`Unknown production-time section: ${sectionName}`)
    }
    process.stdout.write(`${JSON.stringify(report[sectionName], null, 2)}\n`)
  } else if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else if (report.failures.length === 0) {
    process.stdout.write(
      `Production temporal inventory complete: schedulers=${report.schedulers.length}, durations=${report.durations.length}, clocks=${report.clockReads.length}, inputs=${report.temporalInputs.length}, dates=${report.dateConstructions.length + report.dateOperations.length}, async-races=${report.asyncRaces.length}, retry-loops=${report.retryLoops.length}, css=${report.cssTimings.length}, maintenance=${report.maintenanceCommands.length}, forbidden-count-budgets=0, forbidden-destructive-races=0.\n`,
    )
  } else {
    process.stderr.write(`Production temporal inventory failed (${report.failures.length}):\n`)
    for (const failure of report.failures) process.stderr.write(`  ${failure}\n`)
  }
  if (report.failures.length > 0) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli()
}
