export const STARTUP_OPEN_SEQUENCE = Object.freeze([
  stage(
    'lifecycle-owner-installed',
    'src/main.tsx',
    'installBrowserWorkspaceLifecycle()',
    'synchronous-installation',
  ),
  stage(
    'storage-administration-responder-installed',
    'src/main.tsx',
    'installStorageAdministrationResponder()',
    'synchronous-installation',
  ),
  stage(
    'nonblocking-root-presentation',
    'src/app/WorkspaceBootstrap.tsx',
    "{children}\n      {phase.kind === 'opening' ? (",
    'presentation-readiness',
  ),
  stage(
    'storage-administration-presence',
    'src/main.tsx',
    'await awaitStorageAdministrationReady()',
    'workspace-core-readiness',
  ),
  stage(
    'database-selection',
    'src/store/browser-workspace-lifecycle.ts',
    'attempt.selection = await prepareBrowserWorkspaceDatabaseSelection(\n      attempt.authority,\n      options.onProgress,\n    )',
    'workspace-core-readiness',
  ),
  stage(
    'database-bootstrap',
    'src/store/browser-workspace-lifecycle.ts',
    'const workspace = await bootstrapBrowserWorkspace(',
    'workspace-core-readiness',
  ),
  stage(
    'runtime-reconciliation-begin',
    'src/store/browser-workspace-lifecycle.ts',
    'const authority = beginWorkspaceRuntimeReconciliation(workspace, {',
    'workspace-core-readiness',
  ),
  stage(
    'database-selection-activation',
    'src/store/browser-workspace-lifecycle.ts',
    'activeDatabaseSelection = activateBrowserWorkspaceDatabaseSelection(',
    'workspace-core-readiness',
  ),
  stage(
    'core-resource-readiness',
    'src/store/browser-workspace-lifecycle.ts',
    'await resumeWorkspaceRuntimeResources(authority)',
    'workspace-core-readiness',
  ),
  stage(
    'capability-admissions-attached',
    'src/store/workspace-runtime-control.ts',
    'const failures = attachCapabilityAdmissions(fence)',
    'capability-readiness',
  ),
  stage(
    'workspace-running-commit',
    'src/store/workspace-runtime-control.ts',
    'const event = runtime.finishReconciliation(snapshot)',
    'workspace-core-readiness',
  ),
  stage(
    'eligible-background-activation',
    'src/store/workspace-runtime-control.ts',
    'activation.event = event\n      startEligibleCapabilityResources(activation)',
    'background-capability-readiness',
  ),
  stage(
    'opening-status-retired',
    'src/app/WorkspaceBootstrap.tsx',
    "phase.kind === 'ready' ? null",
    'presentation-readiness',
  ),
])

export const STARTUP_ENTRY_PATHS = Object.freeze([
  pathBranch(
    'terminally-sealed',
    'src/store/browser-workspace-lifecycle.ts',
    "if (snapshot.state === 'SEALED') {\n    return Promise.reject(new Error('BrowserWorkspaceTerminalShutdown'))",
    'Reject future opens after terminal disposal.',
  ),
  pathBranch(
    'already-running',
    'src/store/browser-workspace-lifecycle.ts',
    "installBrowserWorkspaceLifecycle()\n  if (snapshot.state === 'RUNNING') return Promise.resolve()",
    'Reuse the current runtime without reattaching resources.',
  ),
  pathBranch(
    'inflight-terminal-request',
    'src/store/browser-workspace-lifecycle.ts',
    "if (existing.desired === 'sealed') {\n      return Promise.reject(new Error('BrowserWorkspaceTerminalShutdown'))",
    'An in-flight terminal close cannot be reversed by a later open request.',
  ),
  pathBranch(
    'inflight-open-reuse',
    'src/store/browser-workspace-lifecycle.ts',
    "existing.desired = 'open'\n    if (!existing.cancelled) {\n      observeBrowserWorkspaceOpenAttempt(existing, options)\n      return existing.promise\n    }",
    'Concurrent callers share one opening attempt and one bootstrap authority.',
  ),
  pathBranch(
    'cancelled-open-followup',
    'src/store/browser-workspace-lifecycle.ts',
    'return awaitExpectedBrowserWorkspaceOpenCancellation(existing).then(() =>\n      openBrowserWorkspace(options),',
    'A cancelled attempt closes before a new authority is created.',
  ),
  pathBranch(
    'new-open-authority',
    'src/store/browser-workspace-lifecycle.ts',
    'authority: beginBrowserWorkspaceBootstrap(),',
    'Initial open and reopen both receive one owned bootstrap authority.',
  ),
  pathBranch(
    'quiescing-drain',
    'src/store/browser-workspace-lifecycle.ts',
    "if (snapshot.state === 'QUIESCING') {\n      await (shutdownTransition?.promise ?? awaitWorkspaceRuntimeQuiesced())",
    'An open waits for the owned close transition rather than racing it.',
  ),
  pathBranch(
    'unified-stable-open',
    'src/store/browser-workspace-lifecycle.ts',
    "snapshot.state !== 'STARTING' &&\n      snapshot.state !== 'QUIESCED' &&\n      snapshot.state !== 'FAILED_CLOSED'",
    'Initial, quiesced, and failed-closed opens enter the same implementation.',
  ),
  pathBranch(
    'fatal-open-terminal-cleanup',
    'src/store/browser-workspace-lifecycle.ts',
    "if (getWorkspaceRuntimeControlSnapshot().state === 'SEALED') {\n      await finalizeTerminalBrowserWorkspaceLifecycle().catch((cleanupError) => {",
    'A failed open that sealed the runtime enters the same presentation-first terminal finalizer as an explicit terminal shutdown.',
  ),
])

export const UNIFIED_REOPEN_SEQUENCE = Object.freeze([
  stage(
    'reopen-inflight-quiesce-drain',
    'src/store/browser-workspace-lifecycle.ts',
    "if (snapshot.state === 'QUIESCING') {\n      await (shutdownTransition?.promise ?? awaitWorkspaceRuntimeQuiesced())",
    'workspace-core-readiness',
  ),
  stage(
    'reopen-unified-state-gate',
    'src/store/browser-workspace-lifecycle.ts',
    "snapshot.state !== 'STARTING' &&\n      snapshot.state !== 'QUIESCED' &&\n      snapshot.state !== 'FAILED_CLOSED'",
    'workspace-core-readiness',
  ),
  stage(
    'reopen-database-selection',
    'src/store/browser-workspace-lifecycle.ts',
    'attempt.selection = await prepareBrowserWorkspaceDatabaseSelection(\n      attempt.authority,\n      options.onProgress,\n    )',
    'workspace-core-readiness',
  ),
  stage(
    'reopen-database-bootstrap',
    'src/store/browser-workspace-lifecycle.ts',
    'const workspace = await bootstrapBrowserWorkspace(',
    'workspace-core-readiness',
  ),
  stage(
    'reopen-reconciliation-begin',
    'src/store/browser-workspace-lifecycle.ts',
    'const authority = beginWorkspaceRuntimeReconciliation(workspace, {',
    'workspace-core-readiness',
  ),
  stage(
    'reopen-selection-activation',
    'src/store/browser-workspace-lifecycle.ts',
    'activeDatabaseSelection = activateBrowserWorkspaceDatabaseSelection(',
    'workspace-core-readiness',
  ),
  stage(
    'reopen-core-resource-readiness',
    'src/store/browser-workspace-lifecycle.ts',
    'await resumeWorkspaceRuntimeResources(authority)',
    'workspace-core-readiness',
  ),
  stage(
    'reopen-capability-commit',
    'src/store/browser-workspace-lifecycle.ts',
    'await finishWorkspaceRuntimeReconciliation(workspace)',
    'capability-readiness',
  ),
])

export const HIDDEN_LIFECYCLE_SEQUENCE = Object.freeze([
  stage(
    'fallback-verification-admitted',
    'src/store/broadcast.ts',
    'fallbackVerificationAdmissionsOpen = true',
    'cross-tab-inbound-readiness',
  ),
  stage(
    'fallback-lifecycle-listeners-armed',
    'src/store/broadcast.ts',
    'installStorageListener()\n  installLifecycleListeners()\n  requestDurableWorkspaceVerification()',
    'cross-tab-inbound-readiness',
  ),
  stage(
    'pageshow-catch-up-listener',
    'src/store/broadcast.ts',
    "window.addEventListener('pageshow', handleFallbackLifecycleCatchUp)",
    'visibility-lifecycle',
  ),
  stage(
    'visibility-catch-up-listener',
    'src/store/broadcast.ts',
    "document.addEventListener('visibilitychange', handleFallbackVisibilityChange)",
    'visibility-lifecycle',
  ),
  stage(
    'visible-only-durable-verification',
    'src/store/broadcast.ts',
    "if (document.visibilityState === 'visible') handleFallbackLifecycleCatchUp()",
    'cross-tab-inbound-readiness',
  ),
  stage(
    'foreground-verification-request',
    'src/store/broadcast.ts',
    'if (!fallbackVerificationActive || channel !== null) return\n  requestDurableWorkspaceVerification()',
    'cross-tab-inbound-readiness',
  ),
])

export const STARTUP_RUNTIME_RESOURCES = Object.freeze([
  resource('broadcast-remote-inbound', 'inbound', ['attach'], 'src/store/broadcast.ts'),
  resource(
    'attempt-workspace',
    'inbound',
    ['attach', 'activate'],
    'src/store/browser-workspace-lifecycle.ts',
  ),
  resource(
    'conversation-workspace',
    'inbound',
    ['attach'],
    'src/store/browser-workspace-lifecycle.ts',
  ),
  resource(
    'attachment-catalog-workspace',
    'inbound',
    ['attach'],
    'src/store/browser-workspace-lifecycle.ts',
  ),
  resource(
    'configuration-workspace',
    'inbound',
    ['attach'],
    'src/store/browser-workspace-lifecycle.ts',
  ),
  resource(
    'configuration-model-resolution',
    'producer',
    ['attach', 'activate'],
    'src/store/browser-workspace-lifecycle.ts',
  ),
  resource(
    'stream-recovery',
    'producer',
    ['attach', 'activate'],
    'src/store/browser-workspace-lifecycle.ts',
  ),
  resource(
    'generated-output-localization',
    'producer',
    ['attach', 'activate'],
    'src/store/browser-workspace-lifecycle.ts',
  ),
  resource(
    'storage-maintenance',
    'producer',
    ['attach', 'activate'],
    'src/store/browser-workspace-lifecycle.ts',
  ),
  resource('stream-leases', 'producer', ['attach'], 'src/store/browser-workspace-lifecycle.ts'),
  resource('broadcast-fallback-verification', 'query', ['attach'], 'src/store/broadcast.ts'),
  resource('mounted-projections', 'query', ['attach'], 'src/store/browser-workspace-lifecycle.ts'),
  resource(
    'browser-workspace-repository',
    'repository',
    ['resume'],
    'src/store/browser-workspace-lifecycle.ts',
  ),
  resource('broadcast', 'transport', ['attach'], 'src/store/broadcast.ts'),
  resource('workspace-locks', 'lock', ['resume'], 'src/store/browser-workspace-lifecycle.ts'),
  resource(
    'local-transactions',
    'transaction',
    ['resume'],
    'src/store/browser-workspace-lifecycle.ts',
  ),
  resource(
    'browser-workspace-session',
    'session',
    ['resume'],
    'src/store/browser-workspace-lifecycle.ts',
  ),
])

export const STARTUP_RECONCILIATION_PARTICIPANTS = Object.freeze([
  participant('tab-session', ['reconcile'], 'src/store/browser-workspace-lifecycle.ts'),
])

export const STARTUP_CAPABILITIES = Object.freeze([
  capability(
    'opening-status',
    'workspace-bootstrap',
    ['bootstrap-mounted'],
    'src/app/WorkspaceBootstrap.tsx',
    '<h1>Opening local workspace…</h1>',
    'Opening status is a nonblocking presentation layered over the mounted application.',
  ),
  capability(
    'recovery-controls',
    'workspace-bootstrap',
    ['open-failed-or-blocked'],
    'src/app/WorkspaceBootstrap.tsx',
    '<Button tone="accent" appearance="solid" onClick={onRetry}>',
    'Failure and blocking own explicit retry, reload, diagnostics, and reset controls.',
  ),
  capability(
    'shell-chrome',
    'workspace-bootstrap',
    ['bootstrap-mounted'],
    'src/app/WorkspaceBootstrap.tsx',
    "{children}\n      {phase.kind === 'opening' ? (",
    'Shell chrome is mounted independently of workspace opening.',
  ),
  capability(
    'navigation-and-new-chat',
    'conversation-navigation-port',
    ['bootstrap-mounted'],
    'src/main.tsx',
    'conversationController.setNavigationPort(browserConversationNavigationPort)',
    'Route intent remains tab-local while durable work acquires its own capability.',
  ),
  capability(
    'background-new-chat-first-activation',
    'workspace-runtime-demand-boundary',
    ['workspace-demand-boundary'],
    'src/store/browser-workspace-lifecycle.ts',
    'demand = claimWorkspaceRuntimeDemandBoundary(requestBrowserWorkspaceRunning)',
    'The first durable demand owns reopening and preserves the initiating intent.',
  ),
  capability(
    'sidebar-browse',
    'sidebar-session',
    ['sidebar-first-page'],
    'src/store/sidebar-session.ts',
    'dependencies.firstPageSettlement\n      .claim({',
    'Sidebar browsing is ready after its bounded first page settles.',
  ),
  capability(
    'configuration-panels',
    'configuration-controller',
    ['active-configuration'],
    'src/store/configuration-controller.ts',
    'export const configurationController: ConfigurationController = new TabConfigurationController()',
    'Configuration paint is owned by one retained, target-qualified controller frame.',
  ),
  capability(
    'active-transcript',
    'conversation-controller',
    ['route-terminal'],
    'src/store/conversation-controller.ts',
    'export const conversationController = createConversationController(attemptController)',
    'Transcript or tree presentation is owned by one terminal route frame.',
  ),
  capability(
    'composer-draft',
    'composer-draft-state',
    ['bootstrap-mounted'],
    'src/ui/chat/composer-draft-state.ts',
    'export function writeComposerDraftText(key: string | null | undefined, text: string): void {',
    'Draft ownership is tab-local and independent of durable write admission.',
  ),
  capability(
    'durable-write-admission',
    'generation-admission-controller',
    ['generation-admission-ready'],
    'src/store/generation-admission-controller.ts',
    'export const generationAdmissionController: GenerationAdmissionController =',
    'One target-qualified algebra joins workspace, configuration, and prompt-path proofs.',
  ),
  capability(
    'active-stream-control',
    'attempt-controller',
    ['route-terminal', 'active-stop'],
    'src/store/attempt-controller.ts',
    'export const attemptController: AttemptController = createAttemptController()',
    'Stop and status consume the exact active attempt projection without maintenance readiness.',
  ),
  capability(
    'orphan-stream-recovery',
    'stream-recovery',
    ['active-stop', 'stream-recovery-ready'],
    'src/store/stream-recovery.ts',
    'export function resumeStreamRecoveryRuntime(): void {',
    'Recovery activates only after the active-stop surface settles and fails independently.',
  ),
  capability(
    'storage-compaction-and-retention',
    'storage-maintenance',
    ['route-terminal', 'active-configuration', 'sidebar-first-page', 'active-stop'],
    'src/store/storage-maintenance-runtime.ts',
    'export function startStorageMaintenanceRuntime(): void {',
    'Maintenance starts only after every usable surface settles and never gates them.',
  ),
  capability(
    'cross-tab-change-delivery',
    'broadcast-remote-inbound',
    ['broadcast-remote-inbound-ready'],
    'src/store/broadcast.ts',
    "'broadcast-remote-inbound': {",
    "Remote invalidation readiness is independent of this tab's retained route and local intent.",
  ),
])

export const STARTUP_READINESS_GAPS = Object.freeze([])

export const STARTUP_READINESS_ACCEPTANCE = Object.freeze([
  'Shell, navigation, and local drafting paint and accept input while workspace opening is pending.',
  'Core repository readiness is the only blocking open phase; capability admissions attach synchronously and background activation is not awaited.',
  'A failed background activation degrades only that resource and does not reverse the RUNNING commit or unmount retained projections.',
  'No wall-clock delay, lease TTL, retry backoff, debounce, or cleanup timer is a prerequisite for shell clickability.',
  'A hidden tab retains its workspace; visibility and pageshow only request durable fallback verification when BroadcastChannel is unavailable.',
  'Reloading during an active stream exposes the route and attempt projections before orphan recovery activation.',
  'A middle-clicked background New chat tab preserves its route intent and acquires durable readiness through the shared demand boundary.',
])

function stage(id, path, locator, readinessClass) {
  return Object.freeze({ id, path, locator, readinessClass })
}

function resource(id, phase, hooks, owner) {
  return Object.freeze({ id, phase, hooks: Object.freeze([...hooks]), owner })
}

function participant(id, hooks, owner) {
  return Object.freeze({ id, hooks: Object.freeze([...hooks]), owner })
}

function capability(id, owner, gates, path, locator, rationale) {
  const frozenGates = Object.freeze([...gates])
  return Object.freeze({
    id,
    owner,
    currentGates: frozenGates,
    targetGates: frozenGates,
    path,
    locator,
    rationale,
  })
}

function pathBranch(id, path, locator, rationale) {
  return Object.freeze({ id, path, locator, rationale })
}
