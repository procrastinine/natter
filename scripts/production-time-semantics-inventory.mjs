const covered = (id, semantics, sites) =>
  Object.freeze({
    id,
    ...semantics,
    correctnessFromElapsedTime: false,
    criticalOutcomes: Object.freeze([]),
    status: 'covered',
    sites: freezeSites(sites),
  })

export const TEMPORAL_SEMANTIC_GROUPS = Object.freeze([
  covered(
    'generation-admission-publication-settlement',
    semantics(
      'Workspace or new-chat configuration publications, never elapsed time, wake a captured intent; an existing-chat intent enters its authoritative transaction on the first running-workspace evaluation.',
      'one captured generation admission',
      'tab-local intent with workspace and new-chat configuration publications',
      'generation admission controller',
      'Abort rejects an active workspace or new-chat configuration wait; every wake returns an exact disposer and the terminal path releases prompt material and exact target reservations.',
      'At most one active publication wait per captured admission.',
      'Each continuation follows a workspace or new-chat configuration identity change, while existing-chat durable state is resolved by one repository transaction.',
      'none',
    ),
    {
      asyncRaces: ['src/app/Shell.tsx|ownGenerationSubmission|Promise.race|1'],
      retryLoops: [
        'src/store/generation-admission-controller.ts|settleCapturedAdmission|ForStatement|unbounded|1',
      ],
    },
  ),
  covered(
    'http-request-deadlines',
    semantics(
      'Abort/deadline evidence terminates one external request; successful response bytes, never the deadline, establish the result.',
      'network request only',
      'request-local',
      'API request owner and its AbortController',
      'Clear the timer on settlement and abort or detach the losing read.',
      'One finite deadline policy constant or remaining-deadline consumer per request.',
      'Response EOF, abort, or classified HTTP failure is monotonic progress.',
      'external-deadline',
    ),
    {
      schedulers: [
        'src/api/client.ts|fetchWithTimeout|setTimeout|timeoutMs|1',
        'src/api/client.ts|consumeResponseBody|setTimeout|remainingMs|1',
      ],
      durations: ['src/api/client.ts|DEFAULT_TIMEOUT_MS|120_000'],
      asyncRaces: ['src/api/client.ts|consumeResponseBody|Promise.race|1'],
      retryLoops: ['src/api/client.ts|consumeResponseBody|ForStatement|unbounded|1'],
    },
  ),
  covered(
    'sse-watchdogs-and-parser',
    semantics(
      'The parser advances only on bytes/EOF while first-byte and idle deadlines classify a failed provider stream.',
      'generation network stream only',
      'request-local',
      'SSE iterator and request abort signal',
      'Every watchdog is cleared/rearmed by the iterator and canceled on abort or terminal EOF.',
      'One first-byte deadline and one idle deadline consumer per active iterator.',
      'Each loop consumes buffered bytes, a reader result, EOF, or abort evidence.',
      'external-deadline',
    ),
    {
      schedulers: [
        'src/api/sse.ts|armWatchdog|setTimeout|Math.max(0, deadline - monotonicNow())|1',
      ],
      durations: [
        'src/api/sse.ts|DEFAULT_STREAM_FIRST_BYTE_TIMEOUT_MS|300_000',
        'src/api/sse.ts|DEFAULT_STREAM_IDLE_TIMEOUT_MS|120_000',
      ],
      asyncRaces: ['src/api/sse.ts|readNext|Promise.race|1'],
      retryLoops: [
        'src/api/sse.ts|parseSSE|ForStatement|unbounded|1',
        'src/api/sse.ts|parseSSE|ForStatement|unbounded|2',
      ],
    },
  ),
  covered(
    'video-generation-polling',
    semantics(
      'Provider job status and abort evidence advance polling; delay is provider load policy, not completion evidence.',
      'one generation attempt',
      'attempt-local',
      'video generation consumer',
      'Abort signal rejects the pending delay and terminates the polling loop.',
      'One interval policy constant consumed between provider status reads.',
      'Each iteration consumes a provider response and exits on terminal status or abort.',
      'external-deadline',
    ),
    {
      schedulers: ['src/api/video-generation.ts|delay|setTimeout|ms|1'],
      durations: ['src/api/video-generation.ts|POLL_INTERVAL_MS|10_000'],
      retryLoops: ['src/api/video-generation.ts|consumeVideoGeneration|ForStatement|unbounded|1'],
    },
  ),
  covered(
    'default-model-freshness',
    semantics(
      'A provider expiration timestamp is compared with an onboarding horizon; the selected model still comes from provider data.',
      'new-chat default selection',
      'configuration-read',
      'default model resolver',
      'No scheduled work; the caller owns the synchronous comparison.',
      'One finite freshness policy constant consumed by one model-list scan.',
      'The finite input model list bounds the comparison.',
      'freshness-policy',
    ),
    { durations: ['src/core/defaults.ts|SIXTY_DAYS_MS|60 * 24 * 60 * 60 * 1000'] },
  ),
  covered(
    'stream-live-projection-coalescing',
    semantics(
      'Accumulator revision and dirty-state evidence own projection correctness; the timer only coalesces intermediate paints.',
      'active attempt presentation only',
      'attempt-local',
      'generation attempt live projection publisher',
      'Flush/close clears the timer and explicitly drains the latest requested revision.',
      'One interval policy constant and at most one pending timer per attempt publisher.',
      'Requested and projected revision numbers advance monotonically.',
      'coalescing-policy',
    ),
    {
      schedulers: ['src/store/generation-attempt-runner.ts|schedule|setTimeout|delay|1'],
      durations: ['src/core/stream-accumulator.ts|STREAM_LIVE_UPDATE_INTERVAL_MS|125'],
    },
  ),
  covered(
    'active-branch-frame-measurement',
    semantics(
      'Exact branch-frame revisions own transcript state; animation-frame work only coalesces DOM-facing publication.',
      'tab-local transcript presentation',
      'tab-local',
      'active branch frame hook',
      'Effect cleanup cancels the pending animation frame and superseded revisions are ignored.',
      'At most one pending frame for the mounted branch-frame owner.',
      'Exact branch and body revision comparison controls acceptance.',
      'presentation-policy',
    ),
    { schedulers: ['src/hooks/useActiveBranchFrame.ts|update|requestAnimationFrame||1'] },
  ),
  covered(
    'settled-configuration-edit',
    semantics(
      'The staged value and configuration edit session own correctness; time only coalesces rapid edits.',
      'one configuration control',
      'tab-local edit session',
      'settled configuration edit hook',
      'Blur, pointer-up, explicit flush, and unmount clear the timer and drain the latest value.',
      'One caller-provided debounce consumer and one pending timer per mounted edit session.',
      'The latest staged value and workspace fence key supersede older work.',
      'coalescing-policy',
    ),
    { schedulers: ['src/hooks/useSettledConfigurationEdit.ts|schedule|setTimeout|settleMs|1'] },
  ),
  covered(
    'cooperative-event-loop-yield',
    semantics(
      'Persistent cursor or queue state owns progress; yielding merely returns control to the browser.',
      'background or explicitly paged work',
      'current task',
      'bounded worker invoking yieldToEventLoop',
      'The zero-delay task settles once; owner abort/fence checks run between pages.',
      'One zero-delay yield consumer per completed bounded page plus one measurement policy constant.',
      'Every caller advances a cursor, processed count, or queue head before yielding.',
      'yield-policy',
    ),
    {
      schedulers: ['src/lib/yield-to-event-loop.ts|yieldToEventLoop|setTimeout|0|1'],
      durations: ['src/store/chat-search.ts|SEARCH_YIELD_BUDGET_MS|12'],
    },
  ),
  covered(
    'bounded-microtask-drains',
    semantics(
      'Queued points/chunks and revision watermarks own exact progress; microtasks only avoid recursive drains.',
      'tab or attempt projection work',
      'owning controller instance',
      'attachment, search, catalog, or stream queue owner',
      'Dispose/close clears admissions; scheduled drains re-check owner state before consuming queues.',
      'At most one scheduled drain flag per owner and bounded work per drain.',
      'Queue removal, point revision, or append sequence advances on every drain.',
      'yield-policy',
    ),
    {
      schedulers: [
        'src/store/attachment-projection-controller.ts|scheduleDrain|queueMicrotask||1',
        'src/store/branch-tree-search-runtime.ts|schedulePointDrain|queueMicrotask||1',
        'src/store/configuration-controller.ts|releaseDemand|queueMicrotask||1',
        'src/store/conversation-controller.ts|publish|queueMicrotask||1',
        'src/store/search-session.ts|scheduleDrain|queueMicrotask||1',
        'src/store/stream-chunk-writer.ts|appendSharedStreamFrames|queueMicrotask||1',
        'src/store/stream-chunk-writer.ts|drainSharedStreamJournalAppends|queueMicrotask||1',
        'src/store/tab-catalog-session.ts|schedulePointDrain|queueMicrotask||1',
      ],
    },
  ),
  covered(
    'workspace-runtime-transition-admission',
    semantics(
      'Runtime admission, demand, and custody evidence own lifecycle transitions while the mounted shell remains independently interactive.',
      'workspace runtime transition behind an already mounted shell',
      'workspace-tab',
      'browser workspace lifecycle',
      'Lifecycle closure rejects new admissions, drains only admitted work, and superseded transition cycles cannot publish.',
      'One queued transition per hidden/fatal/slot event plus capability-local runtime demand.',
      'Transition cycle, admission state, active count, and capability demand advance explicitly.',
      'yield-policy',
    ),
    {
      schedulers: [
        'src/store/browser-workspace-lifecycle.ts|shutdownBrowserWorkspaceWhenIdle|queueMicrotask||1',
        'src/store/browser-workspace-lifecycle.ts|scheduleFatalWorkspaceReload|queueMicrotask||1',
        'src/store/browser-workspace-slot-coordination.ts|receiveSlotMessage|queueMicrotask||1',
        'src/store/db.ts|reportFatalInvalidation|queueMicrotask||1',
      ],
      retryLoops: [
        'src/store/browser-workspace-lifecycle.ts|fulfillBrowserWorkspaceRuntimeDemand|ForStatement|unbounded|1',
        'src/store/browser-workspace-replacement-runner.ts|performBrowserWorkspaceReplacementLaunch|ForStatement|unbounded|1',
        'src/store/browser-workspace-replacement-runner.ts|runBrowserWorkspaceReplacement|ForStatement|unbounded|1',
      ],
    },
  ),
  covered(
    'workspace-slot-revalidation',
    semantics(
      'The committed active database name and activation sequence are confirmed under the exact shared slot lease before startup publishes its selection.',
      'workspace database selection only',
      'one browser workspace open attempt',
      'browser workspace database selection',
      'The bootstrap authority aborts lock acquisition; every changed-slot iteration releases its exact shared lease before retrying.',
      'One selected slot lease per observed control-manifest revision, with no retained work between iterations.',
      'Every retry requires a different committed active slot or activation sequence; otherwise the selection returns immediately.',
      'none',
    ),
    {
      retryLoops: [
        'src/store/browser-workspace-database-selection.ts|selectBrowserWorkspaceDatabase|ForStatement|unbounded|1',
        'src/store/browser-workspace-startup-repair.ts|settlePendingBrowserWorkspaceReplacement|ForStatement|unbounded|1',
      ],
    },
  ),
  covered(
    'catalog-query-transition',
    semantics(
      'Query identity, accepted visible result, and repository revision own correctness; delay only coalesces changed text.',
      'sidebar or attachment catalog interaction',
      'tab-local search session',
      'catalog query transition controller',
      'Superseding input/unmount clears pending work; the accepted visible read remains until replacement starts.',
      'One 0ms or finite debounce consumer and one pending timer per search session.',
      'Query ids and accepted revisions reject stale results.',
      'coalescing-policy',
    ),
    {
      schedulers: ['src/store/catalog-query-transition.ts|schedule|setTimeout|delay|1'],
      durations: [
        'src/store/attachment-search-session.ts|ATTACHMENT_SEARCH_DEBOUNCE_MS|150',
        'src/store/search-session.ts|SEARCH_DEBOUNCE_MS|150',
      ],
      retryLoops: ['src/store/search-session.ts|startDrain|ForStatement|unbounded|1'],
    },
  ),
  covered(
    'configuration-discovery-freshness',
    semantics(
      'Repository cache rows and request epochs own discovery correctness; TTL deadlines only choose refresh timing, while failures require target change or explicit retry.',
      'configuration discovery background refresh',
      'workspace plus profile/model key',
      'configuration discovery coordinator',
      'Reschedule clears the prior timer and runtime close aborts in-flight discovery.',
      'One timer per coordinator plus finite TTL policy constants consumed by keyed cache rows.',
      'Captured key, request epoch, and cache row revision reject stale completion.',
      'freshness-policy',
    ),
    {
      schedulers: ['src/store/configuration-discovery-coordinator.ts|schedule|setTimeout|delay|1'],
      durations: [
        'src/store/discovery-cache-policy.ts|MODELS_TTL_MS|60 * 60 * 1000',
        'src/store/discovery-cache-policy.ts|ENDPOINTS_TTL_MS|5 * 60 * 1000',
        'src/store/discovery-cache-policy.ts|PRIVACY_POLICY_TTL_MS|24 * 60 * 60 * 1000',
        'src/store/discovery-cache-policy.ts|EMPTY_PRIVACY_POLICY_RETRY_MS|5 * 60 * 1000',
      ],
    },
  ),
  covered(
    'configuration-model-resolution',
    semantics(
      'Durable pending intents and exact catalog/request revisions own resolution; publication effects only wake the bounded producer.',
      'background model resolution for pending chat switches',
      'workspace-cross-tab target revision',
      'configuration model resolution capability',
      'Runtime close aborts the active cycle and releases its exact subscription and coordination lock.',
      'One 64-row target page, one retained catalog projection, and at most 16 uncached catalogs per workspace runtime.',
      'Each full-page continuation removes or rebases at least one exact pending intent; idle waits follow task identity changes.',
      'none',
    ),
    {
      retryLoops: [
        'src/store/configuration-model-resolution-capability.ts|awaitConfigurationModelResolutionCapabilityIdle|ForStatement|unbounded|1',
        'src/store/configuration-model-resolution-capability.ts|drainTarget|ForStatement|unbounded|1',
      ],
    },
  ),
  covered(
    'generated-output-localization',
    semantics(
      'Durable job claims, lease tokens, provider results, and retryAt evidence own correctness; timers schedule background work only.',
      'background generated-output localization',
      'workspace-cross-tab job key',
      'generated output localization runtime',
      'Runtime close aborts operations and clears the wake timer; timeout races are detached after settlement.',
      'One operation deadline and one earliest-job wake timer; finite lease/timeout/retry policy constants are keyed by durable jobs.',
      'Claim token, attempt count, terminal status, and retryAt advance monotonically.',
      'failure-detection',
    ),
    {
      schedulers: [
        'src/store/generated-output-localization-runtime.ts|withOperationTimeout|setTimeout|OPERATION_TIMEOUT_MS|1',
        'src/store/generated-output-localization-runtime.ts|scheduleWake|setTimeout|Math.max(0, Math.min(2_147_483_647, at - Date.now()))|1',
      ],
      durations: [
        'src/store/generated-output-localization-runtime.ts|LEASE_TTL_MS|5 * 60_000',
        'src/store/generated-output-localization-runtime.ts|OPERATION_TIMEOUT_MS|2 * 60_000',
        'src/store/generated-output-localization-runtime.ts|VIDEO_POLL_RETRY_MS|10_000',
        'src/store/generated-output-localization-runtime.ts|MAX_RETRY_DELAY_MS|5 * 60_000',
      ],
      retryLoops: [
        'src/store/generated-output-localization-capability.ts|awaitGeneratedOutputLocalizationCapabilityIdle|ForStatement|unbounded|1',
        'src/store/generated-output-localization-runtime.ts|awaitGeneratedOutputLocalizationRuntimeIdle|ForStatement|unbounded|1',
      ],
    },
  ),
  covered(
    'fallback-lock-lease-and-wake',
    semantics(
      'Fencing-token revalidation inside every write transaction establishes correctness; lease expiry only detects an abandoned owner.',
      'one admitted durable operation under fallback locking',
      'origin-cross-tab writer lock',
      'IndexedDbLockBackend',
      'Dispose clears heartbeat/wait/cleanup timers; release publishes a wake; every transaction rechecks the fence.',
      'One serialized backend queue, one heartbeat per owner, one wake/deadline wait per contender, and finite lease policy constants.',
      'Fencing token increases on acquisition and every transaction validates current ownership.',
      'failure-detection',
    ),
    {
      schedulers: [
        'src/store/locks.ts|runOwned|setInterval|this.renewMs|1',
        'src/store/locks.ts|waitForWakeOrDeadline|setTimeout|delay|1',
      ],
      durations: [
        'src/store/locks.ts|DEFAULT_FALLBACK_LOCK_LEASE_MS|15_000',
        'src/store/locks.ts|DEFAULT_FALLBACK_LOCK_RENEW_MS|3_000',
        'src/store/locks.ts|DEFAULT_FALLBACK_LOCK_RETRY_MS|100',
      ],
      asyncRaces: [
        'src/store/locks.ts|runOwned|Promise.race|1',
        'src/store/locks.ts|openDatabaseUntilDisposed|Promise.race|1',
      ],
      retryLoops: ['src/store/locks.ts|acquire|ForStatement|unbounded|1'],
    },
  ),
  covered(
    'storage-quota-probe-deadline',
    semantics(
      'Browser storage API result or classified timeout owns the estimate state; elapsed time only bounds an unreliable browser probe.',
      'storage status panel only',
      'one probe call',
      'quota probe owner',
      'The deadline promise is cleared/detached when the browser probe settles.',
      'One finite timeout policy constant and one timer per explicit probe.',
      'One Promise.race settles with browser evidence or timeout classification.',
      'external-deadline',
    ),
    {
      schedulers: ['src/store/quota.ts|runStorageProbe|setTimeout|storageProbeTimeout(options)|1'],
      durations: ['src/store/quota.ts|STORAGE_PROBE_TIMEOUT_MS|3_000'],
      asyncRaces: ['src/store/quota.ts|runStorageProbe|Promise.race|1'],
    },
  ),
  covered(
    'persistent-recovery-retry-heap',
    semantics(
      'Durable nextRetryAt and typed failure evidence own retry correctness; the timer wakes only the earliest due item.',
      'background recovery work',
      'workspace runtime retry key',
      'recovery retry scheduler',
      'Cancel/remove clears the current timer; arming replaces it and runtime shutdown disposes the scheduler.',
      'One max-delay policy constant, one earliest-deadline timer, and a bounded due-prefix heap drain.',
      'Heap removal consumes each due item and recorded retryAt moves failed work forward.',
      'failure-detection',
    ),
    {
      schedulers: [
        'src/store/recovery-retry-scheduler.ts|armTimer|setTimeout|Math.min(MAX_TIMER_DELAY_MS, Math.max(0, nextAt - Date.now()))|1',
      ],
      durations: ['src/store/recovery-retry-scheduler.ts|MAX_TIMER_DELAY_MS|2_147_483_647'],
      retryLoops: ['src/store/recovery-retry-scheduler.ts|runDue|WhileStatement|bounded|1'],
    },
  ),
  covered(
    'send-privacy-discovery-deadline',
    semantics(
      'Captured discovery rows and admission revalidation own routing correctness; the deadline selects a typed unavailable result.',
      'one send-planning operation',
      'attempt-local',
      'privacy request planner',
      'The timeout is cleared when discovery resolves and caller abort closes the wait.',
      'One finite deadline policy constant and one timer per send requiring discovery.',
      'Admission revalidates captured row keys and freshness before the request begins.',
      'external-deadline',
    ),
    {
      schedulers: [
        'src/store/request-privacy-planning.ts|awaitSendDiscovery|setTimeout|SEND_DISCOVERY_TIMEOUT_MS|1',
      ],
      durations: ['src/store/request-privacy-planning.ts|SEND_DISCOVERY_TIMEOUT_MS|15_000'],
    },
  ),
  covered(
    'storage-administration-deadlines',
    semantics(
      'A durable administration intent and lease isolate explicit clear/replace operations while the mounted shell remains independent of their completion.',
      'explicit origin storage administration',
      'origin-cross-tab',
      'storage administration coordinator',
      'Local and remote lease timers are cleared on completion/disposal; non-abortable committed phases keep running after UI deadlines.',
      'One remote lease timer plus finite phase/exclusive/committed-lease policy constants per explicit administration operation.',
      'Durable intent phase, owner evidence, and committed completion advance monotonically.',
      'external-deadline',
    ),
    {
      schedulers: [
        'src/store/storage-administration.ts|setRemoteLease|setTimeout|Math.max(0, deadlineAt - Date.now())|1',
        'src/store/storage-administration.ts|runExclusive|setTimeout|timeoutMs|1',
        'src/store/storage-administration.ts|withDeadline|setTimeout|timeoutMs|1',
      ],
      durations: [
        'src/store/storage-administration.ts|STORAGE_ADMIN_PHASE_TIMEOUT_MS|5_000',
        'src/store/storage-administration.ts|STORAGE_ADMIN_EXCLUSIVE_TIMEOUT_MS|5_000',
        'src/store/storage-administration.ts|STORAGE_ADMIN_COMMITTED_LEASE_MS|60_000',
      ],
    },
  ),
  covered(
    'storage-maintenance-runtime',
    semantics(
      'Indexed cutoffs, durable cursors, and earliest deferred deadlines own retention; time only decides when background evidence becomes eligible.',
      'background storage maintenance',
      'workspace-cross-tab maintenance owner',
      'storage maintenance runtime',
      'Runtime close clears timers/ownership waits; every page checks the current ownership cycle and abort signal.',
      'Age/interval/retry policy constants feed one earliest-deadline timer and bounded keyset maintenance pages.',
      'Every pass advances a durable cursor/done marker or records the next indexed deadline.',
      'retention-policy',
    ),
    {
      schedulers: [
        'src/store/storage-maintenance-runtime.ts|waitForRetry|setTimeout|delay|1',
        'src/store/storage-maintenance-runtime.ts|#scheduleNextWake|setTimeout|Math.max(0, Math.min(MAX_TIMER_DELAY_MS, dueAt - Date.now()))|1',
      ],
      durations: [
        'src/store/storage-maintenance-runtime.ts|ORPHAN_ATTACHMENT_AGE_MS|24 * 60 * 60 * 1_000',
        'src/store/storage-maintenance-runtime.ts|EMPTY_DRAFT_CHAT_AGE_MS|24 * 60 * 60 * 1_000',
        'src/store/storage-maintenance-runtime.ts|TERMINAL_STREAM_JOURNAL_AGE_MS|24 * 60 * 60 * 1_000',
        'src/store/storage-maintenance-runtime.ts|RETRY_BASE_DELAY_MS|1_000',
        'src/store/storage-maintenance-runtime.ts|RETRY_MAX_DELAY_MS|60_000',
        'src/store/storage-maintenance-runtime.ts|MAX_TIMER_DELAY_MS|2_147_483_647',
        'src/store/storage-maintenance-runtime.ts|COMPACTION_INTENT_RECHECK_MS|60_000',
      ],
      retryLoops: [
        'src/store/storage-maintenance-runtime.ts|#runOwnershipLifecycle|WhileStatement|bounded|1',
        'src/store/storage-maintenance-runtime.ts|#selectRunnableTask|ForStatement|bounded|1',
        'src/store/storage-maintenance-runtime.ts|#selectRunnableTask|ForStatement|bounded|2',
      ],
      maintenanceCommands: [
        'src/store/storage-maintenance-runtime.ts|#runAttachmentRetentionSlice|attachment.reap|1',
        'src/store/storage-maintenance-runtime.ts|#runTerminalRetentionSlice|maintenance.prune-terminal-stream-journals|1',
        'src/store/storage-maintenance-runtime.ts|#runDraftRetentionSlice|maintenance.prune-empty-draft-chats|1',
        'src/store/storage-maintenance-runtime.ts|#runSlice|maintenance.prune-discovery-cache|1',
      ],
    },
  ),
  covered(
    'run-once-integrity-maintenance',
    semantics(
      'Versioned phase markers and bounded keyset cursors own repair completion; no elapsed interval can mark a repair complete.',
      'background run-once maintenance',
      'workspace-cross-tab maintenance key',
      'storage retention maintenance owner',
      'Workspace close aborts the current page; pending marker/cursor resumes the next owner.',
      'Version marker plus bounded keyset page and durable done phase; later starts perform an O(1) marker read.',
      'Cursor or versioned phase advances after each committed page.',
      'none',
    ),
    {
      maintenanceCommands: [
        'src/store/storage-maintenance-runtime.ts|#runSlice|maintenance.reconcile-attachment-integrity|1',
        'src/store/storage-maintenance-runtime.ts|#runSlice|maintenance.reconcile-stream-journal-integrity|1',
      ],
    },
  ),
  covered(
    'stream-chunk-flush-queue',
    semantics(
      'Journal sequence numbers and queued chunks own durability; timer/microtask scheduling only batches append work.',
      'active generation durability and projection',
      'attempt-local with shared workspace writer',
      'stream chunk writer',
      'Flush/close clears the timer and drains the queue; runtime disposal rejects pending writers.',
      'One interval policy constant, one earliest-due timer, and bounded queued chunks per writer.',
      'Heap removal and journal sequence advance on each append.',
      'coalescing-policy',
    ),
    {
      schedulers: ['src/store/stream-chunk-writer.ts|scheduleFlush|setTimeout|dueIn|1'],
      durations: ['src/store/stream-chunk-writer.ts|STREAM_JOURNAL_FLUSH_INTERVAL_MS|150'],
      retryLoops: ['src/store/stream-chunk-writer.ts|settle|WhileStatement|bounded|1'],
    },
  ),
  covered(
    'stream-lease-heartbeat',
    semantics(
      'Attempt identity, journal state, and lease commit fencing own stream correctness; TTL detects an absent tab only.',
      'background liveness for one tab stream',
      'attempt plus owning tab',
      'stream lease runtime',
      'Stop/dispose clears the heartbeat timer and queued writes verify current attempt ownership.',
      'Finite TTL/heartbeat/coalesce policy constants and at most one heartbeat timer per owning tab runtime.',
      'Heartbeat revision and attempt ownership evidence advance monotonically.',
      'failure-detection',
    ),
    {
      schedulers: [
        'src/store/stream-leases.ts|scheduleHeartbeatTimer|setTimeout|STREAM_LEASE_HEARTBEAT_MS|1',
      ],
      durations: [
        'src/store/stream-lease-policy.ts|STREAM_LEASE_TTL_MS|15_000',
        'src/store/stream-lease-policy.ts|STREAM_LEASE_HEARTBEAT_MS|2_000',
        'src/store/stream-lease-policy.ts|STREAM_LEASE_HEARTBEAT_COALESCE_MS|250',
      ],
    },
  ),
  covered(
    'stream-recovery-scheduler',
    semantics(
      'Lease/journal/attempt evidence and durable retry records own recovery decisions; timers only wake due work.',
      'background orphan recovery',
      'workspace-cross-tab attempt key',
      'stream recovery coordinator',
      'Runtime close clears lease timers, aborts reads, and invalidates the recovery cycle before queued microtasks run.',
      'One earliest-lease timer, bounded lease-read batches, and finite retry policy constants consumed by durable retry keys.',
      'Lease heap, read queue, retryAt, and recovery state advance on each pump.',
      'failure-detection',
    ),
    {
      schedulers: [
        'src/store/stream-recovery.ts|restartRecoveryCoordinator|queueMicrotask||1',
        'src/store/stream-recovery.ts|armLeaseTimer|setTimeout|Math.max(0, nextAt - leaseSchedulerNow())|1',
        'src/store/stream-recovery.ts|scheduleRecoveryPump|queueMicrotask||1',
      ],
      durations: [
        'src/store/stream-recovery.ts|LEASE_EXPIRY_EPSILON_MS|1',
        'src/store/stream-recovery.ts|RECOVERY_RETRY_POLICY|{\n  baseDelayMs: 2_000,\n  maxDelayMs: 60_000,\n} as const',
        'src/store/stream-recovery.ts|OPERATIONAL_RETRY_POLICY|{\n  baseDelayMs: 2_000,\n  maxDelayMs: 60_000,\n} as const',
      ],
      retryLoops: [
        'src/store/stream-recovery-capability.ts|awaitStreamRecoveryCapabilityIdle|ForStatement|unbounded|1',
        'src/store/stream-recovery.ts|awaitStreamRecoveryRuntimeIdle|ForStatement|unbounded|1',
        'src/store/stream-recovery.ts|drainLeaseReads|WhileStatement|bounded|1',
        'src/store/stream-recovery.ts|drainLeaseReads|ForStatement|bounded|1',
        'src/store/stream-recovery.ts|sinkLeaseDeadlineDown|ForStatement|unbounded|1',
        'src/store/stream-recovery.ts|pumpRecoveryQueue|WhileStatement|bounded|1',
      ],
    },
  ),
  covered(
    'branch-tree-and-scroll-frames',
    semantics(
      'DOM geometry, anchor identity, and current viewport state own presentation; frame scheduling only batches reads/writes around paint.',
      'tab-local branch tree, transcript, composer, and sidebar presentation',
      'mounted component',
      'component frame owner',
      'Unmount/effect cleanup cancels frames or invalidates the current owner before callbacks apply.',
      'At most one or two explicitly tracked frames per mounted geometry owner.',
      'Anchor ids, viewport revision, and current element identity reject stale work.',
      'presentation-policy',
    ),
    {
      schedulers: [
        'src/hooks/useConversationFrame.ts|useConversationTranscriptDemand|requestAnimationFrame||1',
        'src/hooks/useConversationFrame.ts|firstFrame|requestAnimationFrame||1',
        'src/ui/chat/BranchTreeInspector.tsx|scheduleRangeRefresh|requestAnimationFrame||1',
        'src/ui/chat/BranchTreeInspector.tsx|scheduleRangeRefresh|queueMicrotask||1',
        'src/ui/chat/BranchTreeView.tsx|scheduleViewportRead|requestAnimationFrame||1',
        'src/ui/chat/BranchTreeView.tsx|scheduleInspectorResize|requestAnimationFrame||1',
        'src/ui/chat/Composer.tsx|Composer|requestAnimationFrame||1',
        'src/ui/chat/Composer.tsx|togglePrefill|requestAnimationFrame||1',
        'src/ui/chat/InlineEditor.tsx|togglePrefill|requestAnimationFrame||1',
      ],
    },
  ),
  covered(
    'citation-open-microtask',
    semantics(
      'The resolved attachment id and current navigation callback own the action; a microtask avoids nested event dispatch only.',
      'one tab-local citation click',
      'tab-local',
      'citation link action',
      'The callback reads current mounted state and performs no retained recurring work.',
      'One microtask per explicit click.',
      'The action is single-shot and has no retry loop.',
      'yield-policy',
    ),
    { schedulers: ['src/ui/chat/CitationLink.tsx|openCitationAttachment|queueMicrotask||1'] },
  ),
  covered(
    'composer-draft-persistence',
    semantics(
      'The current draft value and explicit flush own persistence; time only coalesces keystrokes.',
      'tab-local composer draft',
      'tab-local chat draft',
      'composer draft state owner',
      'Flush/unmount/chat switch clears the timer and writes the latest draft.',
      'One debounce policy constant and one pending timer per composer draft owner.',
      'Latest draft revision supersedes older scheduled values.',
      'coalescing-policy',
    ),
    {
      schedulers: [
        'src/ui/chat/composer-draft-state.ts|scheduleTextPersistence|setTimeout|PERSIST_DEBOUNCE_MS|1',
      ],
      durations: ['src/ui/chat/composer-draft-state.ts|PERSIST_DEBOUNCE_MS|250'],
    },
  ),
  covered(
    'ephemeral-ui-dwell',
    semantics(
      'These timers expire transient feedback only; no persisted data, navigation, or branch choice depends on them.',
      'ephemeral visible feedback',
      'mounted component or toast id',
      'copy, toast, live-region, prompt, or sidebar feedback owner',
      'Unmount/removal clears the timer or callback rechecks mounted/current notification identity.',
      'One finite dwell policy constant or literal timer per visible feedback item.',
      'Single-shot expiry removes only matching ephemeral state.',
      'presentation-policy',
    ),
    {
      schedulers: [
        'src/ui/chat/MessageActions.tsx|markCopied|setTimeout|COPY_CONFIRM_MS|1',
        'src/ui/chat/ToastTray.tsx|timers|setTimeout|remaining|1',
        'src/ui/primitives/LiveRegions.tsx|LiveRegionLane|requestAnimationFrame||1',
        'src/ui/primitives/LiveRegions.tsx|revealFrame|setTimeout|ANNOUNCEMENT_DWELL_MS|1',
        'src/ui/sidebar/ChatList.tsx|markRecentMove|setTimeout|1400|1',
      ],
      durations: [
        'src/ui/chat/MessageActions.tsx|COPY_CONFIRM_MS|2500',
        'src/ui/primitives/LiveRegions.tsx|ANNOUNCEMENT_DWELL_MS|1_000',
      ],
    },
  ),
  covered(
    'prompt-editor-settle-and-estimate',
    semantics(
      'Edit-session flush owns saved text and current draft owns token estimation; timers only coalesce edits and estimates.',
      'one prompt editor control',
      'tab-local edit session',
      'prompt preset editor hook',
      'Effect cleanup clears the estimate timer and edit-session close flushes the latest draft.',
      'One save debounce policy constant plus one estimate timer per mounted prompt slot.',
      'Current draft/source identity supersedes stale estimates and commits.',
      'coalescing-policy',
    ),
    {
      schedulers: ['src/ui/settings/PromptPresetEditor.tsx|usePromptSlot|setTimeout|120|1'],
      durations: ['src/ui/settings/PromptPresetEditor.tsx|SAVE_DEBOUNCE_MS|300'],
    },
  ),
  covered(
    'stream-and-text-parser-consumers',
    semantics(
      'Finite input, EOF, or abort owns completion; these syntactically unbounded loops are consumers, not time-based retries.',
      'request parsing or bounded message rendering',
      'input-local',
      'async iterator, branch text, reasoning parser, or markdown guard',
      'Caller abort/iterator return closes external sources; pure string loops retain no scheduled work.',
      'Finite stream/string input consumer; no deadline constant is used as successful completion evidence.',
      'Each iteration consumes bytes, a segment, a character range, or reaches EOF/abort.',
      'none',
    ),
    {
      retryLoops: [
        'src/api/assistant-lanes.ts|[Symbol.asyncIterator]|ForStatement|unbounded|1',
        'src/core/reasoning-inline.ts|feed|ForStatement|unbounded|1',
        'src/store/branch-text.ts|consumeCanonicalBranchText|ForStatement|unbounded|1',
        'src/store/branch-text.ts|consumeCanonicalBranchText|ForStatement|bounded|1',
        'src/store/generation-attempt-runner.ts|runGenerationAttempt|ForStatement|unbounded|1',
        'src/ui/chat/MarkdownView.tsx|guardOversizedCodeFences|ForStatement|unbounded|1',
        'src/ui/chat/MarkdownView.tsx|scanStreamingMarkdownBoundaries|ForStatement|unbounded|1',
      ],
    },
  ),
  covered(
    'finite-provider-attempt-chain',
    semantics(
      'Typed provider/key outcomes and abort evidence select the next candidate; delay never implies success.',
      'one generation attempt',
      'attempt-local',
      'API key fallback and generation attempt runner',
      'Caller abort terminates the chain and every request owns its own cleanup.',
      'Finite configured key/candidate consumer even where syntax is open-ended.',
      'Each iteration consumes a key/candidate or a typed terminal/retry outcome.',
      'none',
    ),
    {
      retryLoops: [
        'src/api/client.ts|fetchWithKeyFallback|ForStatement|bounded|1',
        'src/store/request-planning.ts|prepareAssistantRequestPlanFromContextSelection|ForStatement|unbounded|1',
      ],
    },
  ),
  covered(
    'version-gated-database-migration-loops',
    semantics(
      'Schema version and transaction completion own migration correctness; every scan is page/input bounded and runs only for the matching database version.',
      'one version-gated database upgrade',
      'origin database upgrade',
      'Dexie schema migration transaction',
      'Dexie owns transaction abort; committed schema version prevents later startup rescans.',
      'Version marker or schema version plus bounded keyset/input consumer per migration.',
      'Each batch/cursor advances and the schema version commits only after the final batch.',
      'none',
    ),
    {
      retryLoops: [
        'src/backcompat/batched-table.ts|forEachTableBatch|ForStatement|unbounded|1',
        'src/backcompat/preset-sort-order.ts|forEachMigrationOrderBatch|ForStatement|unbounded|1',
        'src/backcompat/wave-a-preset-order-v94.ts|rebuildPresetOrderFromStagingV94|ForStatement|unbounded|1',
        'src/backcompat/wave-a-stream-storage-v94.ts|terminalizeStrandedGenerationHeadersV94|WhileStatement|bounded|1',
        'src/backcompat/wave-a-stream-storage-v94.ts|writeWaveAStreamEventV94|ForStatement|unbounded|1',
      ],
    },
  ),
  covered(
    'finite-algorithmic-traversals',
    semantics(
      'Input length, visited state, parent pointers, or heap position bounds the traversal; no wall clock or retry policy participates.',
      'synchronous domain/repository calculation',
      'input-local',
      'pure algorithm or transaction-local projection owner',
      'No scheduled work is retained; caller cancellation applies only around async repository boundaries.',
      'Finite input collection, ancestor chain, visited set, or heap consumer.',
      'Index/parent/heap position advances or a visited set prevents revisiting on every iteration.',
      'none',
    ),
    {
      retryLoops: [
        'src/core/attachment-refs.ts|attachmentRefsFromIds|ForStatement|unbounded|1',
        'src/backcompat/reasoning-contract-normalizer-v92.ts|normalizeContinuationAttemptsV92|ForStatement|bounded|1',
        'src/backcompat/reasoning-envelope-v89.ts|claim|ForStatement|unbounded|1',
        'src/backcompat/wave-a-stream-storage-v94.ts|flush|ForStatement|bounded|1',
        'src/core/branch-flatten.ts|messageRenderableTextSemanticsEqual|ForStatement|unbounded|1',
        'src/core/continuation-content.ts|appliedAttemptEnvelopeSequenceEqual|ForStatement|unbounded|1',
        'src/core/continuation-content.ts|appliedAttemptMemberSequenceEqual|ForStatement|unbounded|1',
        'src/core/continuation-content.ts|appliedAttemptMemberSequenceEqual|WhileStatement|bounded|1',
        'src/core/continuation-content.ts|appliedAttemptMemberSequenceEqual|WhileStatement|bounded|2',
        'src/core/provider-tool-context.ts|toolEvidenceSectionsForMessage|ForStatement|bounded|1',
        'src/core/messages.ts|targetedPairFollowers|ForStatement|unbounded|1',
        'src/core/messages.ts|targetedPairFollowers|ForStatement|unbounded|2',
        'src/core/model-ids.ts|stripRepeatedProviderDecoration|ForStatement|unbounded|1',
        'src/core/tree-ops.ts|createAncestorOutsideSetResolver|ForStatement|unbounded|1',
        'src/store/attempt-workspace.ts|applyPoints|ForStatement|bounded|1',
        'src/store/attempt-controller.ts|reconcileLeasePoints|ForStatement|bounded|1',
        'src/store/browser-command-mutation-journal.ts|recordSuccessfulStreamJournalRetirements|ForStatement|bounded|1',
        'src/store/browser-repo.ts|newestLiveLeafIdInTransaction|ForStatement|unbounded|1',
        'src/store/browser-repo.ts|readConversationPageStructureEnvelope|ForStatement|bounded|1',
        'src/store/conversation-controller.ts|rememberTerminal|ForStatement|unbounded|1',
        'src/store/recovery-retry-scheduler.ts|sinkDown|ForStatement|unbounded|1',
        'src/store/repository.ts|joinKnownBranchPageMaterial|ForStatement|bounded|1',
        'src/store/stream-chunk-writer.ts|workers|ForStatement|unbounded|1',
        'src/store/transcript-window.ts|findPageLeaf|ForStatement|unbounded|1',
        'src/store/transcript-window.ts|newestStalePageLeaf|WhileStatement|bounded|1',
        'src/store/transcript-window.ts|newestStalePageLeaf|ForStatement|bounded|1',
      ],
    },
  ),
  covered(
    'bounded-user-command-batches',
    semantics(
      'Explicit selected ids or a keyset cursor own completion; elapsed time is irrelevant.',
      'explicit storage/chat command',
      'command-local',
      'attachment/archive command owner',
      'The command transaction aborts atomically; no timer or retained retry survives it.',
      'Finite selected-id consumer or bounded keyset page.',
      'Every iteration consumes one selected id or advances the page cursor.',
      'none',
    ),
    {
      retryLoops: [
        'src/store/attachment-bulk-delete.ts|planAttachmentBulkDelete|ForStatement|bounded|1',
        'src/store/attachment-bulk-delete.ts|executeAttachmentBulkDelete|ForStatement|bounded|1',
        'src/store/chats.ts|emptyArchivedChats|ForStatement|unbounded|1',
      ],
    },
  ),
  covered(
    'keyset-pagination-scans',
    semantics(
      'Stable keyset cursors and finite source pages own exact completion; time is only yielded outside these loops where needed.',
      'explicit import/export/search/query work',
      'request or command-local',
      'page-shaped repository reader/writer',
      'Caller abort or transaction abort stops work; cursor state is local or durably resumable as appropriate.',
      'Bounded keyset page consumer over a finite table/result set.',
      'Every iteration advances afterKey/cursor or consumes one returned page and terminates on done.',
      'none',
    ),
    {
      retryLoops: [
        'src/backcompat/sidebar-folder-presentation-v98.ts|migrateSidebarFolderPresentationV98|ForStatement|unbounded|1',
        'src/store/browser-import-export.ts|tablePages|ForStatement|unbounded|1',
        'src/store/browser-catalog-command-runtime.ts|clearCalibrationEverywhereTransaction|ForStatement|unbounded|1',
        'src/store/browser-configuration-domain.ts|readConfigurationTargetFanoutLinks|ForStatement|unbounded|1',
        'src/store/browser-query-pages.ts|readChatMessageHeaderPages|ForStatement|unbounded|1',
        'src/store/browser-query-pages.ts|readChildHeaderPages|ForStatement|unbounded|1',
        'src/store/browser-query-pages.ts|readStringPrimaryKeyPages|ForStatement|unbounded|1',
        'src/store/browser-query-pages.ts|readStreamLeasePages|ForStatement|unbounded|1',
        'src/store/browser-workspace-derived-repair.ts|rebuildChildSlotDerivedState|ForStatement|unbounded|1',
        'src/store/browser-workspace-derived-repair.ts|forEachPrimaryPage|ForStatement|unbounded|1',
        'src/store/browser-workspace-startup-repair.ts|copyCanonicalBrowserWorkspaceRows|ForStatement|unbounded|1',
        'src/store/chat-search.ts|iterateSearchSidebarPages|ForStatement|unbounded|1',
        'src/store/chat-sidebar-projection.ts|rebuildChatSidebarProjectionRowsInTransaction|ForStatement|unbounded|1',
        'src/store/chat-sidebar-projection.ts|rebuildChatSidebarProjectionRowsInTransaction|ForStatement|unbounded|2',
        'src/store/chat-storage-ownership.ts|deleteKnownChatClosure|ForStatement|unbounded|1',
        'src/store/message-corpus-search.ts|search|ForStatement|unbounded|1',
        'src/store/preset-order.ts|rebuildPresetOrderMembership|ForStatement|unbounded|1',
        'src/store/stream-leases.ts|finishStreamCleanup|ForStatement|unbounded|1',
        'src/store/stream-recovery.ts|replayRecoveredStreamJournal|ForStatement|unbounded|1',
      ],
      asyncRaces: ['src/store/chat-search.ts|add|Promise.race|1'],
    },
  ),
  covered(
    'collision-free-name-search',
    semantics(
      'Finite existing-name sets and monotonically increasing suffix/namespace candidates own termination.',
      'explicit import naming only',
      'command-local',
      'import canonicalization owner',
      'No retained async work; enclosing import transaction owns abort.',
      'Finite occupied-name/namespace set consumer.',
      'Candidate suffix or namespace increases until it is absent from the finite set.',
      'none',
    ),
    {
      retryLoops: [
        'src/store/browser-import-export.ts|uniquePresetName|ForStatement|unbounded|1',
        'src/store/browser-import-export.ts|uniqueConnectionName|ForStatement|unbounded|1',
        'src/store/import-export.ts|unusedGeneratedOutputNamespace|ForStatement|unbounded|1',
      ],
    },
  ),
  covered(
    'configuration-controller-drain',
    semantics(
      'Pending field revision and session ownership own completion; the loop drains accepted work without sleeping.',
      'one configuration edit/session close',
      'tab-local edit session',
      'configuration controller',
      'Session close/fence invalidation stops admissions and the drain observes the latest pending revision.',
      'Pending-revision consumer; no delay, retry counter, or global lock wait is used.',
      'Each iteration commits or supersedes the current pending revision before rereading state.',
      'none',
    ),
    {
      retryLoops: [
        'src/store/configuration-controller.ts|flushUntilSettled|ForStatement|unbounded|1',
      ],
    },
  ),
  covered(
    'storage-compaction-debt-and-copy',
    semantics(
      'A durable compaction intent and table keyset own resumable copying; no timeout establishes completion.',
      'background storage compaction debt recovery',
      'origin-cross-tab compaction owner',
      'browser workspace compaction runner',
      'Intent phase/cursor survives interruption and the transaction aborts the current page.',
      'Durable compaction intent plus bounded keyset table page consumer.',
      'Table index and afterKey cursor advance after each committed page.',
      'failure-detection',
    ),
    {
      schedulers: [
        'src/store/storage-compaction-state.ts|schedulePhysicalMutationDebtQueue|setTimeout|delayMs|1',
      ],
      durations: [
        'src/store/storage-compaction-state.ts|STORAGE_COMPACTION_DEBT_RETRY_BASE_MS|1_000',
        'src/store/storage-compaction-state.ts|STORAGE_COMPACTION_DEBT_RETRY_MAX_MS|60_000',
      ],
      retryLoops: [
        'src/store/browser-workspace-compaction.ts|copyTable|ForStatement|unbounded|1',
        'src/store/browser-workspace-compaction.ts|drainBrowserWorkspaceCatchup|ForStatement|unbounded|1',
      ],
    },
  ),
])

export const TEMPORAL_READINESS_PROOFS = Object.freeze([
  Object.freeze({
    id: 'active-stream-reload-first-gesture-browser-proof',
    timerRelationship: 'source-closed-browser-proof-closed',
    criticalOutcomes: Object.freeze(['shell-clickability', 'navigation', 'painted-projection']),
    rationale:
      'Source ownership mounts the shell before workspace opening, keeps the opening presentation pointer-transparent, starts capability resources independently, and a built-browser journey bounds first-gesture latency during an active-stream reload.',
    evidence: Object.freeze([
      evidence('src/main.tsx', 'await awaitStorageAdministrationReady()'),
      evidence('src/main.tsx', 'createRoot(container).render('),
      evidence('src/app/WorkspaceBootstrap.tsx', '{children}'),
      evidence('src/app/WorkspaceBootstrap.tsx', 'data-presentation="nonblocking"'),
      evidence(
        'src/styles/shell.css',
        `[data-ui="workspace-bootstrap"][data-presentation="nonblocking"] {
  position: fixed;
  right: var(--space-4);
  bottom: var(--space-4);
  z-index: var(--z-toast, 100);
  min-height: 0;
  padding: 0;
  pointer-events: none;`,
      ),
      evidence(
        'src/store/browser-workspace-lifecycle.ts',
        "attempt.selection = await runBrowserWorkspaceOpenStage('database-selection', () =>\n      prepareBrowserWorkspaceDatabaseSelection(\n        attempt.authority,\n        options.onProgress,\n        options.onBlocked,\n      ),\n    )",
      ),
      evidence(
        'src/store/browser-workspace-lifecycle.ts',
        "const workspace = await runBrowserWorkspaceOpenStage('database-bootstrap', () =>\n      bootstrapBrowserWorkspace(attempt.authority, options),\n    )",
      ),
      evidence(
        'src/store/browser-workspace-lifecycle.ts',
        "await runBrowserWorkspaceOpenStage('runtime-resources-resume', () =>\n      resumeWorkspaceRuntimeResources(authority),\n    )",
      ),
      evidence(
        'src/store/browser-workspace-lifecycle.ts',
        "await runBrowserWorkspaceOpenStage('runtime-reconciliation-finish', () =>\n      finishWorkspaceRuntimeReconciliation(workspace),\n    )",
      ),
      evidence(
        'src/store/workspace-runtime-control.ts',
        'await Promise.allSettled(batch.map((resource) => resumeCoreResource(resource)))',
      ),
      evidence(
        'src/store/workspace-runtime-control.ts',
        'void startCapabilityResource(resource, event, activation.cycle)',
      ),
    ]),
    acceptanceEvidence: Object.freeze([
      evidence(
        'tests/e2e/reactive-storage-stress.spec.ts',
        'reload during an active stream keeps pure UI controls actionable within bounded latency while opening is pending',
      ),
    ]),
  }),
])

export const TEMPORAL_READINESS_GAPS = Object.freeze([])

export const TEMPORAL_SEMANTIC_LIMITATIONS = Object.freeze([
  Object.freeze({
    id: 'static-not-browser-proof',
    detail:
      'Source-linked ownership and readiness classification does not measure main-thread stalls or prove real-browser clickability; browser acceptance remains separate.',
  }),
  Object.freeze({
    id: 'operational-sites-not-every-timestamp',
    detail:
      'The semantic expansion covers schedulers, duration policies, async races, candidate retries/consumers, and maintenance commands. Individual event/LWW/display clock reads remain exhaustively categorized by the base audit but are not duplicated as operational paths here.',
  }),
  Object.freeze({
    id: 'manual-readiness-callgraph',
    detail:
      'Critical-path classification is an exact source-linked manual inventory, not a whole-program dynamic callgraph proof; new syntactic temporal sites fail closed, while changed callers require meta-audit review.',
  }),
  Object.freeze({
    id: 'event-driven-recursion-boundary',
    detail:
      'The base detector finds schedulers, timeout races, maintenance commands, and retry-like/open loops; purely event-driven recursive retries without those primitives require a separate lifecycle inventory.',
  }),
])

function semantics(
  correctnessBasis,
  readinessImpact,
  scope,
  lifecycleOwner,
  cancellationCleanup,
  boundInputShape,
  progressEvidence,
  elapsedTimeRole,
) {
  return Object.freeze({
    correctnessBasis,
    readinessImpact,
    scope,
    lifecycleOwner,
    cancellationCleanup,
    boundInputShape,
    progressEvidence,
    elapsedTimeRole,
  })
}

function freezeSites(sites) {
  return Object.freeze(
    Object.fromEntries(Object.entries(sites).map(([kind, ids]) => [kind, Object.freeze([...ids])])),
  )
}

function evidence(path, locator) {
  return Object.freeze({ path, locator })
}
