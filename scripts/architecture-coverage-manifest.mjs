const ALL_DOMAINS = Object.freeze([
  'application-shell',
  'attachments',
  'build-environment',
  'catalog',
  'conversation',
  'diagnostics',
  'generation',
  'interchange',
  'organization',
  'presentation-state',
  'presentation-system',
  'provider-configuration',
  'provider-discovery',
  'provider-io',
  'schema-evolution',
  'shared-contracts',
  'shared-runtime',
  'storage-administration',
  'workspace',
])

export const ARCHITECTURE_DIMENSIONS = Object.freeze([
  dimension(
    'exact-modules-responsibilities',
    'Every production module has one exact domain, layer, and responsibility classification.',
    ['canonical-inventory', 'static-audit'],
  ),
  dimension(
    'public-ingress',
    'Every public domain entry point has an explicit audience and boundary classification.',
    ['canonical-inventory', 'static-audit', 'unit-test', 'integration-test', 'browser-test'],
  ),
  dimension(
    'event-model',
    'Producers, consumers, event scope, ordering, replay, and delivery semantics are inventoried.',
    ['static-audit', 'unit-test', 'integration-test', 'browser-test'],
  ),
  dimension(
    'mutable-ownership',
    'Mutable state has one declared owner, scope, lifetime, and cleanup or replacement rule.',
    ['static-audit', 'unit-test', 'integration-test'],
  ),
  dimension(
    'retained-resource-lifetime',
    'Retained collections and resources have bounded lifetime and deterministic release evidence.',
    ['static-audit', 'unit-test', 'integration-test', 'browser-test', 'performance-test'],
  ),
  dimension(
    'queries-commands-durable-writes',
    'Queries, commands, physical writes, transaction ownership, and bypasses are exhaustively classified.',
    ['static-audit', 'unit-test', 'integration-test', 'browser-test'],
  ),
  dimension(
    'stage-order',
    'Multi-stage work has explicit prerequisites, ordering, commit facts, and terminal states.',
    ['static-audit', 'unit-test', 'integration-test', 'browser-test'],
  ),
  dimension(
    'failure-cancellation-rollback',
    'Failure, cancellation, rollback, retry, and partial-commit behavior has executable evidence.',
    ['unit-test', 'integration-test', 'browser-test'],
  ),
  dimension(
    'tab-cross-tab-locality',
    'Tab-local intent and cross-tab durable propagation are distinguished and exercised in real tabs.',
    ['browser-test'],
  ),
  dimension(
    'temporal-semantics',
    'Timers, clocks, retries, races, debounce, maintenance, and ordering assumptions are inventoried and exercised.',
    ['unit-test', 'integration-test', 'browser-test'],
  ),
  dimension(
    'cpu-complexity',
    'Hot operations have input-shaped complexity evidence rather than only fixed-count timing thresholds.',
    ['unit-test', 'integration-test', 'browser-test', 'performance-test'],
  ),
  dimension(
    'memory-bounds',
    'Retained and peak memory are bounded by named inputs and measured on adversarial workloads.',
    ['unit-test', 'integration-test', 'browser-test', 'performance-test'],
  ),
  dimension(
    'physical-storage-reclamation',
    'Logical bytes, physical browser storage, compaction debt, and observable reclamation are exercised.',
    ['browser-test', 'performance-test'],
  ),
  dimension(
    'behavioral-tests',
    'The domain has executable success, concurrency, and failure-path behavior tests.',
    ['unit-test', 'integration-test', 'browser-test'],
  ),
  dimension(
    'browser-performance-tests',
    'Browser-only behavior or measured performance is exercised outside jsdom and static analysis.',
    ['browser-test', 'performance-test'],
  ),
  dimension(
    'runtime-dev-ci-parity',
    'Development, built preview, and CI use the same application boundary and observable behavior.',
    ['browser-test', 'performance-test', 'workflow'],
  ),
  dimension(
    'legacy-duplicate-bypass-subtraction',
    'Legacy paths, duplicate implementations, direct bypasses, and dead architecture are actively rejected.',
    ['static-audit', 'unit-test', 'integration-test', 'browser-test'],
  ),
])

export const ARCHITECTURE_PROOFS = Object.freeze([
  proof(
    'canonical-production-module-inventory',
    'canonical-inventory',
    'scripts/production-module-inventory.json',
    '"classifications"',
    ALL_DOMAINS,
    ['exact-modules-responsibilities'],
  ),
  proof(
    'workspace-runtime-resource-tests',
    'unit-test',
    'tests/unit/workspace-runtime-resource-manifest.test.ts',
    "describe('workspace runtime resource manifest'",
    ['shared-runtime'],
    ['behavioral-tests'],
  ),
  proof(
    'conversation-controller-tests',
    'unit-test',
    'tests/unit/conversation-controller.test.ts',
    "describe('conversation controller'",
    ['conversation'],
    ['behavioral-tests'],
  ),
  proof(
    'generation-lifecycle-contract',
    'integration-test',
    'tests/integration/generation-lifecycle-contract.test.ts',
    "describe('generation lifecycle contract'",
    ['generation'],
    ['behavioral-tests'],
  ),
  proof(
    'generation-intent-io-contract',
    'integration-test',
    'tests/integration/generation-intent-io-contract.test.ts',
    "describe('generation intent outbound-path and body-I/O contract'",
    ['generation'],
    ['behavioral-tests'],
  ),
  proof(
    'concurrent-tabs-browser-tests',
    'browser-test',
    'tests/e2e/concurrent-ops.spec.ts',
    "test('two tabs streaming different chats run in parallel without aborting each other'",
    ['application-shell', 'conversation', 'generation', 'workspace'],
    ['behavioral-tests', 'browser-performance-tests'],
  ),
  proof(
    'scroll-browser-tests',
    'browser-test',
    'tests/e2e/scroll.spec.ts',
    "test('streaming text keeps the scroll region in follow state",
    ['conversation', 'presentation-system'],
    ['behavioral-tests', 'browser-performance-tests'],
  ),
  proof(
    'render-window-browser-tests',
    'browser-test',
    'tests/e2e/render-window.spec.ts',
    "test('send, regenerate, and continue keep the transcript mounted while readiness settles'",
    ['conversation', 'presentation-system'],
    ['browser-performance-tests'],
  ),
  proof(
    'storage-reclamation-browser-tests',
    'browser-test',
    'tests/e2e/storage-reclamation.spec.ts',
    "test('normal use catches up foreground work without repeating the physical copy and preserves two-tab state'",
    [
      'attachments',
      'conversation',
      'generation',
      'presentation-state',
      'storage-administration',
      'workspace',
    ],
    ['behavioral-tests', 'browser-performance-tests'],
  ),
  proof(
    'schema-cleanup-browser-tests',
    'browser-test',
    'tests/e2e/storage-reclamation.spec.ts',
    "test('records schema cleanup without assuming immediate Chromium quota reclamation'",
    ['schema-evolution', 'storage-administration'],
    ['browser-performance-tests'],
  ),
  proof(
    'attachment-manager-browser-tests',
    'browser-test',
    'tests/e2e/attachment-manager.spec.ts',
    "test('attachment manager searches, filters, bulk deletes, and relinks through built UI'",
    ['attachments', 'presentation-system', 'storage-administration'],
    ['browser-performance-tests'],
  ),
  proof(
    'connection-manager-browser-tests',
    'browser-test',
    'tests/e2e/connection-manager.spec.ts',
    "test('connection manager duplicates and explicitly reassigns before delete'",
    ['presentation-system', 'provider-configuration', 'provider-discovery'],
    ['browser-performance-tests'],
  ),
  proof(
    'branch-tree-browser-tests',
    'browser-test',
    'tests/e2e/branch-tree.spec.ts',
    "test('middle-click opens the newest descendant branch in a background tab'",
    ['conversation', 'presentation-system'],
    ['behavioral-tests', 'browser-performance-tests'],
  ),
  proof(
    'provider-routing-browser-tests',
    'browser-test',
    'tests/e2e/advanced-generation-routing.spec.ts',
    "test('GUI OpenRouter Responses GPT-5.4 xhigh reasoning and Continue stay on the unified planner'",
    ['generation', 'provider-configuration', 'provider-discovery', 'provider-io'],
    ['behavioral-tests', 'browser-performance-tests'],
  ),
  proof(
    'interchange-browser-tests',
    'browser-test',
    'tests/e2e/legacy-import-recovery.spec.ts',
    "test('legacy storage-v25 workspace and portable chat recover through public imports'",
    ['interchange', 'schema-evolution', 'workspace'],
    ['browser-performance-tests'],
  ),
  proof(
    'production-startup-browser-test',
    'browser-test',
    'tests/e2e/production-startup.spec.ts',
    "test('production artifact excludes source modules and development tools'",
    ['application-shell', 'build-environment', 'diagnostics', 'workspace'],
    ['browser-performance-tests'],
  ),
])

export const ARCHITECTURE_COVERAGE = Object.freeze([
  domainCoverage('application-shell', {
    'exact-modules-responsibilities': covered('All shell modules are classified exactly once.', [
      'canonical-production-module-inventory',
    ]),
    'public-ingress': gap(
      'The canonical list declares known application-shell entry points, but no closed-world source scan proves that no other public ingress exists.',
    ),
    'event-model': gap(
      'The cited scans and tests cover recognized lifecycle, UI, or behavior paths, not a closed-world producer-consumer event registry for application-shell.',
    ),
    'mutable-ownership': gap(
      'The coordination scan covers module lets and retained collections, not every scalar instance, React, Zustand, and controller mutation owner in application-shell.',
    ),
    'retained-resource-lifetime': gap(
      'The cited evidence covers retained collections and selected resources, not every promise, listener, timer, controller, object URL, channel, and abort handle in application-shell.',
    ),
    'queries-commands-durable-writes': gap(
      'No shell-specific proof maps every call into commands, queries, and forbidden direct writes.',
    ),
    'stage-order': gap(
      'Bootstrap, presentation commit, hidden-tab release, stream-reload recovery, and teardown do not share one proved stage graph; active-stream reload currently leaves shell controls inert.',
    ),
    'failure-cancellation-rollback': gap(
      'Active-stream reload can leave shell controls inert for seconds, and no fault matrix proves recovery work remains independent from shell interaction.',
    ),
    'tab-cross-tab-locality': gap(
      'Selected multi-tab scenarios pass, but application-shell lacks an entry-by-entry locality matrix; the still-failing background-tab New chat path is direct counterevidence.',
    ),
    'temporal-semantics': gap(
      'Active-stream reload exposes a multi-second coupling between hydration or recovery and shell interactivity; no temporal contract forbids that coupling.',
    ),
    'cpu-complexity': gap('No input-shaped shell bootstrap or navigation complexity proof exists.'),
    'memory-bounds': gap('No adversarial shell lifetime or hidden-tab heap bound is measured.'),
    'physical-storage-reclamation': notApplicable(
      'The shell does not own physical storage; storage-administration and workspace do.',
    ),
    'behavioral-tests': gap(
      'Existing application-shell tests exercise selected paths, but do not form a closed success, concurrency, cancellation, and failure matrix for the whole domain.',
    ),
    'browser-performance-tests': gap(
      'Built startup and selected multi-tab flows are tested, but no browser test proves controls stay immediately clickable while an active stream reloads and recovers.',
    ),
    'runtime-dev-ci-parity': gap(
      'Built preview or CI is exercised for application-shell, but the same scenarios are not replayed against development and built runtimes through identical public paths.',
    ),
    'legacy-duplicate-bypass-subtraction': gap(
      'The cited audit rejects selected application-shell boundaries only; it is not a closed-world proof against every legacy path, duplicate implementation, dead owner, and direct bypass.',
    ),
  }),
  domainCoverage('attachments', {
    'exact-modules-responsibilities': covered(
      'Attachment domain and adapters are exactly classified.',
      ['canonical-production-module-inventory'],
    ),
    'public-ingress': gap(
      'Attachment application and catalog entry points are not yet declared in canonical ingress.',
    ),
    'event-model': gap(
      'The cited scans and tests cover recognized lifecycle, UI, or behavior paths, not a closed-world producer-consumer event registry for attachments.',
    ),
    'mutable-ownership': gap(
      'The coordination scan covers module lets and retained collections, not every scalar instance, React, Zustand, and controller mutation owner in attachments.',
    ),
    'retained-resource-lifetime': gap(
      'The cited evidence covers retained collections and selected resources, not every promise, listener, timer, controller, object URL, channel, and abort handle in attachments.',
    ),
    'queries-commands-durable-writes': gap(
      'Top-level protocol checks do not discover every nested command, direct transaction, physical write, and publication bypass in attachments.',
    ),
    'stage-order': gap(
      'Top-level switch coverage and representative tests do not enumerate every attachments prerequisite, stage, commit fact, cancellation edge, and terminal state.',
    ),
    'failure-cancellation-rollback': gap(
      'Representative attachments failures are tested, but no await-by-await fault matrix proves every cancellation, rollback, retry, and partial-commit path.',
    ),
    'tab-cross-tab-locality': gap(
      'No real two-tab attachment ownership and object-URL lifetime test is registered.',
    ),
    'temporal-semantics': gap(
      'Attachment cleanup and media lifetime timing lack an executable temporal contract.',
    ),
    'cpu-complexity': gap(
      'The cited proof bounds selected attachments operations only; the domain has no closed hot-path inventory with input-shaped complexity evidence for each entry.',
    ),
    'memory-bounds': gap(
      'The cited proof bounds selected attachments allocations only; retained and peak memory are not measured across every owner and adversarial workload.',
    ),
    'physical-storage-reclamation': gap(
      'No browser test measures attachment blob deletion against physical quota usage.',
    ),
    'behavioral-tests': gap(
      'Existing attachments tests exercise selected paths, but do not form a closed success, concurrency, cancellation, and failure matrix for the whole domain.',
    ),
    'browser-performance-tests': covered(
      'Attachment management is exercised in a real built browser.',
      ['attachment-manager-browser-tests'],
    ),
    'runtime-dev-ci-parity': gap(
      'No attachment-specific dev-versus-built parity assertion exists.',
    ),
    'legacy-duplicate-bypass-subtraction': gap(
      'The cited audit rejects selected attachments boundaries only; it is not a closed-world proof against every legacy path, duplicate implementation, dead owner, and direct bypass.',
    ),
  }),
  domainCoverage('build-environment', {
    'exact-modules-responsibilities': covered(
      'Build-facing source declarations are exactly classified.',
      ['canonical-production-module-inventory'],
    ),
    'public-ingress': gap(
      'Build and environment entry surfaces are not represented in canonical ingress.',
    ),
    'event-model': notApplicable('Build configuration has no production event bus.'),
    'mutable-ownership': notApplicable(
      'Build configuration has no retained production mutable owner.',
    ),
    'retained-resource-lifetime': notApplicable(
      'Build configuration does not retain browser runtime resources.',
    ),
    'queries-commands-durable-writes': notApplicable(
      'Build configuration does not issue workspace protocol operations.',
    ),
    'stage-order': gap(
      'Build, preview, fake provider, and browser provisioning stages are not represented in this domain registry.',
    ),
    'failure-cancellation-rollback': gap(
      'No executable build-stage rollback or partial-artifact contract is registered.',
    ),
    'tab-cross-tab-locality': notApplicable('Build configuration has no tab-local state.'),
    'temporal-semantics': gap('Server readiness and teardown timing are not domain-modeled.'),
    'cpu-complexity': gap('Build cost is not input-shaped or ratcheted here.'),
    'memory-bounds': gap('Build peak memory is not measured.'),
    'physical-storage-reclamation': notApplicable(
      'Browser origin reclamation belongs to storage-administration.',
    ),
    'behavioral-tests': gap(
      'Existing build-environment tests exercise selected paths, but do not form a closed success, concurrency, cancellation, and failure matrix for the whole domain.',
    ),
    'browser-performance-tests': covered(
      'The built artifact is launched and inspected in a real browser.',
      ['production-startup-browser-test'],
    ),
    'runtime-dev-ci-parity': gap(
      'Built preview or CI is exercised for build-environment, but the same scenarios are not replayed against development and built runtimes through identical public paths.',
    ),
    'legacy-duplicate-bypass-subtraction': gap(
      'The cited audit rejects selected build-environment boundaries only; it is not a closed-world proof against every legacy path, duplicate implementation, dead owner, and direct bypass.',
    ),
  }),
  domainCoverage('catalog', {
    'exact-modules-responsibilities': covered('Catalog modules are exactly classified.', [
      'canonical-production-module-inventory',
    ]),
    'public-ingress': gap(
      'The canonical list declares known catalog entry points, but no closed-world source scan proves that no other public ingress exists.',
    ),
    'event-model': gap(
      'The cited scans and tests cover recognized lifecycle, UI, or behavior paths, not a closed-world producer-consumer event registry for catalog.',
    ),
    'mutable-ownership': gap(
      'The coordination scan covers module lets and retained collections, not every scalar instance, React, Zustand, and controller mutation owner in catalog.',
    ),
    'retained-resource-lifetime': gap(
      'The cited evidence covers retained collections and selected resources, not every promise, listener, timer, controller, object URL, channel, and abort handle in catalog.',
    ),
    'queries-commands-durable-writes': gap(
      'Top-level protocol checks do not discover every nested command, direct transaction, physical write, and publication bypass in catalog.',
    ),
    'stage-order': gap(
      'Top-level switch coverage and representative tests do not enumerate every catalog prerequisite, stage, commit fact, cancellation edge, and terminal state.',
    ),
    'failure-cancellation-rollback': gap(
      'Representative catalog failures are tested, but no await-by-await fault matrix proves every cancellation, rollback, retry, and partial-commit path.',
    ),
    'tab-cross-tab-locality': gap(
      'No registered real two-tab catalog session isolation test exists.',
    ),
    'temporal-semantics': gap(
      'Representative asynchronous catalog ordering is tested, not every clock, timer, retry, debounce, race, maintenance, and teardown semantic.',
    ),
    'cpu-complexity': gap(
      'The cited proof bounds selected catalog operations only; the domain has no closed hot-path inventory with input-shaped complexity evidence for each entry.',
    ),
    'memory-bounds': gap(
      'The cited proof bounds selected catalog allocations only; retained and peak memory are not measured across every owner and adversarial workload.',
    ),
    'physical-storage-reclamation': notApplicable(
      'Catalog owns projections, not physical storage reclamation.',
    ),
    'behavioral-tests': gap(
      'Existing catalog tests exercise selected paths, but do not form a closed success, concurrency, cancellation, and failure matrix for the whole domain.',
    ),
    'browser-performance-tests': gap(
      'No catalog-specific real-browser latency or heap test is registered.',
    ),
    'runtime-dev-ci-parity': gap('No catalog-specific dev-versus-built parity assertion exists.'),
    'legacy-duplicate-bypass-subtraction': gap(
      'The cited audit rejects selected catalog boundaries only; it is not a closed-world proof against every legacy path, duplicate implementation, dead owner, and direct bypass.',
    ),
  }),
  domainCoverage('conversation', {
    'exact-modules-responsibilities': covered(
      'Conversation domain, application, and presentation adapters are exactly classified.',
      ['canonical-production-module-inventory'],
    ),
    'public-ingress': gap(
      'The canonical list declares known conversation entry points, but no closed-world source scan proves that no other public ingress exists.',
    ),
    'event-model': gap(
      'The cited scans and tests cover recognized lifecycle, UI, or behavior paths, not a closed-world producer-consumer event registry for conversation.',
    ),
    'mutable-ownership': gap(
      'The coordination scan covers module lets and retained collections, not every scalar instance, React, Zustand, and controller mutation owner in conversation.',
    ),
    'retained-resource-lifetime': gap(
      'The cited evidence covers retained collections and selected resources, not every promise, listener, timer, controller, object URL, channel, and abort handle in conversation.',
    ),
    'queries-commands-durable-writes': gap(
      'Top-level protocol checks do not discover every nested command, direct transaction, physical write, and publication bypass in conversation.',
    ),
    'stage-order': gap(
      'Top-level switch coverage and representative tests do not enumerate every conversation prerequisite, stage, commit fact, cancellation edge, and terminal state.',
    ),
    'failure-cancellation-rollback': gap(
      'Representative conversation failures are tested, but no await-by-await fault matrix proves every cancellation, rollback, retry, and partial-commit path.',
    ),
    'tab-cross-tab-locality': gap(
      'Selected real-tab scenarios pass, but no entry-by-entry matrix proves every conversation intent is tab-local and every durable effect propagates without steering other tabs.',
    ),
    'temporal-semantics': gap(
      'Representative asynchronous conversation ordering is tested, not every clock, timer, retry, debounce, race, maintenance, and teardown semantic.',
    ),
    'cpu-complexity': gap(
      'The cited proof bounds selected conversation operations only; the domain has no closed hot-path inventory with input-shaped complexity evidence for each entry.',
    ),
    'memory-bounds': gap(
      'The cited proof bounds selected conversation allocations only; retained and peak memory are not measured across every owner and adversarial workload.',
    ),
    'physical-storage-reclamation': notApplicable(
      'Conversation uses durable storage but does not own physical compaction.',
    ),
    'behavioral-tests': covered('Controller, tree, scroll, and multi-tab behavior are exercised.', [
      'conversation-controller-tests',
      'branch-tree-browser-tests',
      'scroll-browser-tests',
      'concurrent-tabs-browser-tests',
    ]),
    'browser-performance-tests': covered(
      'Real-browser scroll, tree, render-window, and concurrency paths are exercised.',
      [
        'scroll-browser-tests',
        'render-window-browser-tests',
        'branch-tree-browser-tests',
        'concurrent-tabs-browser-tests',
      ],
    ),
    'runtime-dev-ci-parity': gap(
      'No conversation behavior is explicitly replayed against both dev and built artifacts.',
    ),
    'legacy-duplicate-bypass-subtraction': gap(
      'The cited audit rejects selected conversation boundaries only; it is not a closed-world proof against every legacy path, duplicate implementation, dead owner, and direct bypass.',
    ),
  }),
  domainCoverage('diagnostics', {
    'exact-modules-responsibilities': covered('Diagnostics modules are exactly classified.', [
      'canonical-production-module-inventory',
    ]),
    'public-ingress': gap(
      'Diagnostics entry points and audiences are not declared in canonical ingress.',
    ),
    'event-model': gap(
      'The cited scans and tests cover recognized lifecycle, UI, or behavior paths, not a closed-world producer-consumer event registry for diagnostics.',
    ),
    'mutable-ownership': gap(
      'The coordination scan covers module lets and retained collections, not every scalar instance, React, Zustand, and controller mutation owner in diagnostics.',
    ),
    'retained-resource-lifetime': gap(
      'The cited evidence covers retained collections and selected resources, not every promise, listener, timer, controller, object URL, channel, and abort handle in diagnostics.',
    ),
    'queries-commands-durable-writes': notApplicable(
      'Diagnostics does not own workspace protocol writes.',
    ),
    'stage-order': gap(
      'Diagnostic installation, enablement, and disposal are not modeled as one stage graph.',
    ),
    'failure-cancellation-rollback': gap(
      'No domain-wide diagnostic failure isolation contract is registered.',
    ),
    'tab-cross-tab-locality': gap(
      'Debug state locality across tabs is not exercised in real pages.',
    ),
    'temporal-semantics': gap(
      'Diagnostic timestamp and buffer ordering lack a domain-wide behavioral proof.',
    ),
    'cpu-complexity': gap('Logging overhead is not input-shaped or measured.'),
    'memory-bounds': gap(
      'Buffer bounds are unit-tested individually but not registered as a domain-wide adversarial measurement.',
    ),
    'physical-storage-reclamation': notApplicable(
      'Diagnostics does not own browser origin storage.',
    ),
    'behavioral-tests': gap(
      'Existing diagnostics tests exercise selected paths, but do not form a closed success, concurrency, cancellation, and failure matrix for the whole domain.',
    ),
    'browser-performance-tests': covered(
      'Built startup verifies development-only diagnostics do not leak.',
      ['production-startup-browser-test'],
    ),
    'runtime-dev-ci-parity': gap(
      'Built preview or CI is exercised for diagnostics, but the same scenarios are not replayed against development and built runtimes through identical public paths.',
    ),
    'legacy-duplicate-bypass-subtraction': gap(
      'The cited audit rejects selected diagnostics boundaries only; it is not a closed-world proof against every legacy path, duplicate implementation, dead owner, and direct bypass.',
    ),
  }),
  domainCoverage('generation', {
    'exact-modules-responsibilities': covered(
      'Generation domain and application stages are exactly classified.',
      ['canonical-production-module-inventory'],
    ),
    'public-ingress': gap(
      'The canonical list declares known generation entry points, but no closed-world source scan proves that no other public ingress exists.',
    ),
    'event-model': gap(
      'The cited scans and tests cover recognized lifecycle, UI, or behavior paths, not a closed-world producer-consumer event registry for generation.',
    ),
    'mutable-ownership': gap(
      'The coordination scan covers module lets and retained collections, not every scalar instance, React, Zustand, and controller mutation owner in generation.',
    ),
    'retained-resource-lifetime': gap(
      'The cited evidence covers retained collections and selected resources, not every promise, listener, timer, controller, object URL, channel, and abort handle in generation.',
    ),
    'queries-commands-durable-writes': gap(
      'Top-level protocol checks do not discover every nested command, direct transaction, physical write, and publication bypass in generation.',
    ),
    'stage-order': gap(
      'Generation stages do not prove stream reload, hydration, lease arbitration, and presentation recovery can proceed without blocking unrelated UI interaction.',
    ),
    'failure-cancellation-rollback': gap(
      'Generation recovery tests establish eventual outcomes, not independent shell interactivity; active-stream reload currently leaves controls inert for seconds.',
    ),
    'tab-cross-tab-locality': gap(
      'Selected real-tab scenarios pass, but no entry-by-entry matrix proves every generation intent is tab-local and every durable effect propagates without steering other tabs.',
    ),
    'temporal-semantics': gap(
      'Generation recovery has no latency-independent temporal contract; active-stream reload currently couples recovery or lease arbitration to multi-second UI unresponsiveness.',
    ),
    'cpu-complexity': gap(
      'The cited proof bounds selected generation operations only; the domain has no closed hot-path inventory with input-shaped complexity evidence for each entry.',
    ),
    'memory-bounds': gap(
      'The cited proof bounds selected generation allocations only; retained and peak memory are not measured across every owner and adversarial workload.',
    ),
    'physical-storage-reclamation': gap(
      'No browser test ties stream-journal churn to physical quota reclamation.',
    ),
    'behavioral-tests': covered(
      'Lifecycle, I/O, provider routing, and multi-tab behavior are executable.',
      [
        'generation-lifecycle-contract',
        'generation-intent-io-contract',
        'provider-routing-browser-tests',
        'concurrent-tabs-browser-tests',
      ],
    ),
    'browser-performance-tests': gap(
      'Provider routing and concurrent streams run in browsers, but no browser assertion covers immediate control interactivity during active-stream reload and recovery.',
    ),
    'runtime-dev-ci-parity': gap(
      'Generation behavior is not explicitly replayed in both dev and built artifacts.',
    ),
    'legacy-duplicate-bypass-subtraction': gap(
      'The cited audit rejects selected generation boundaries only; it is not a closed-world proof against every legacy path, duplicate implementation, dead owner, and direct bypass.',
    ),
  }),
  domainCoverage('interchange', {
    'exact-modules-responsibilities': covered(
      'Interchange schemas, application, and UI adapters are exactly classified.',
      ['canonical-production-module-inventory'],
    ),
    'public-ingress': gap(
      'The canonical list declares known interchange entry points, but no closed-world source scan proves that no other public ingress exists.',
    ),
    'event-model': gap(
      'The cited scans and tests cover recognized lifecycle, UI, or behavior paths, not a closed-world producer-consumer event registry for interchange.',
    ),
    'mutable-ownership': gap(
      'The coordination scan covers module lets and retained collections, not every scalar instance, React, Zustand, and controller mutation owner in interchange.',
    ),
    'retained-resource-lifetime': gap(
      'The cited evidence covers retained collections and selected resources, not every promise, listener, timer, controller, object URL, channel, and abort handle in interchange.',
    ),
    'queries-commands-durable-writes': gap(
      'Top-level protocol checks do not discover every nested command, direct transaction, physical write, and publication bypass in interchange.',
    ),
    'stage-order': gap(
      'Top-level switch coverage and representative tests do not enumerate every interchange prerequisite, stage, commit fact, cancellation edge, and terminal state.',
    ),
    'failure-cancellation-rollback': gap(
      'Representative interchange failures are tested, but no await-by-await fault matrix proves every cancellation, rollback, retry, and partial-commit path.',
    ),
    'tab-cross-tab-locality': gap('No registered real two-tab import ownership test exists.'),
    'temporal-semantics': gap(
      'Import cancellation and workspace replacement timing lack an explicit temporal contract.',
    ),
    'cpu-complexity': gap(
      'The cited proof bounds selected interchange operations only; the domain has no closed hot-path inventory with input-shaped complexity evidence for each entry.',
    ),
    'memory-bounds': gap(
      'The cited proof bounds selected interchange allocations only; retained and peak memory are not measured across every owner and adversarial workload.',
    ),
    'physical-storage-reclamation': gap(
      'No browser test measures physical storage before and after failed or replaced imports.',
    ),
    'behavioral-tests': gap(
      'Existing interchange tests exercise selected paths, but do not form a closed success, concurrency, cancellation, and failure matrix for the whole domain.',
    ),
    'browser-performance-tests': covered(
      'Legacy and current import paths are exercised in a built browser.',
      ['interchange-browser-tests'],
    ),
    'runtime-dev-ci-parity': gap(
      'Interchange behavior is not explicitly replayed in dev and built artifacts.',
    ),
    'legacy-duplicate-bypass-subtraction': gap(
      'The cited audit rejects selected interchange boundaries only; it is not a closed-world proof against every legacy path, duplicate implementation, dead owner, and direct bypass.',
    ),
  }),
  domainCoverage('organization', {
    'exact-modules-responsibilities': covered('Organization modules are exactly classified.', [
      'canonical-production-module-inventory',
    ]),
    'public-ingress': gap('Folder, tag, and sidebar organization ports are not canonical ingress.'),
    'event-model': gap(
      'The cited scans and tests cover recognized lifecycle, UI, or behavior paths, not a closed-world producer-consumer event registry for organization.',
    ),
    'mutable-ownership': gap(
      'Organization service instance state is not exhaustively represented in the coordination owner audit.',
    ),
    'retained-resource-lifetime': gap(
      'Organization caches and sessions lack a domain-specific lifetime proof.',
    ),
    'queries-commands-durable-writes': gap(
      'Top-level protocol checks do not discover every nested command, direct transaction, physical write, and publication bypass in organization.',
    ),
    'stage-order': gap(
      'Top-level switch coverage and representative tests do not enumerate every organization prerequisite, stage, commit fact, cancellation edge, and terminal state.',
    ),
    'failure-cancellation-rollback': gap(
      'No domain-wide organization rollback and partial-bulk-failure contract is registered.',
    ),
    'tab-cross-tab-locality': gap(
      'No real two-tab folder/tag conflict and local-selection test is registered.',
    ),
    'temporal-semantics': gap(
      'Organization ordering under simultaneous edits lacks an executable temporal proof.',
    ),
    'cpu-complexity': gap('Large folder/tag/catalog operations lack input-shaped work assertions.'),
    'memory-bounds': gap('Large organization projections lack retained-memory bounds.'),
    'physical-storage-reclamation': notApplicable(
      'Organization does not own physical storage compaction.',
    ),
    'behavioral-tests': gap(
      'Existing organization tests exercise selected paths, but do not form a closed success, concurrency, cancellation, and failure matrix for the whole domain.',
    ),
    'browser-performance-tests': gap(
      'No organization-specific browser performance proof is registered.',
    ),
    'runtime-dev-ci-parity': gap(
      'Organization behavior is not explicitly replayed in dev and built artifacts.',
    ),
    'legacy-duplicate-bypass-subtraction': gap(
      'The cited audit rejects selected organization boundaries only; it is not a closed-world proof against every legacy path, duplicate implementation, dead owner, and direct bypass.',
    ),
  }),
  domainCoverage('presentation-state', {
    'exact-modules-responsibilities': covered('Presentation-state stores are exactly classified.', [
      'canonical-production-module-inventory',
    ]),
    'public-ingress': gap(
      'Presentation state store boundaries are not declared in canonical ingress.',
    ),
    'event-model': gap(
      'The cited scans and tests cover recognized lifecycle, UI, or behavior paths, not a closed-world producer-consumer event registry for presentation-state.',
    ),
    'mutable-ownership': gap(
      'The coordination scan covers module lets and retained collections, not every scalar instance, React, Zustand, and controller mutation owner in presentation-state.',
    ),
    'retained-resource-lifetime': gap(
      'The cited evidence covers retained collections and selected resources, not every promise, listener, timer, controller, object URL, channel, and abort handle in presentation-state.',
    ),
    'queries-commands-durable-writes': gap(
      'No proof classifies every presentation-state mutation and durable handoff.',
    ),
    'stage-order': gap(
      'Toast, announcement, and UI-state transitions do not have one stage/order model.',
    ),
    'failure-cancellation-rollback': gap(
      'No domain-wide stale subscription and teardown failure contract is registered.',
    ),
    'tab-cross-tab-locality': gap(
      'No real-tab proof establishes which presentation stores are strictly tab-local.',
    ),
    'temporal-semantics': gap(
      'Notification expiry and UI scheduling semantics lack a unified executable proof.',
    ),
    'cpu-complexity': gap('Store fanout complexity is not input-shaped or measured.'),
    'memory-bounds': gap('Subscriber and dedupe retention bounds are not adversarially measured.'),
    'physical-storage-reclamation': notApplicable(
      'Ephemeral presentation state does not own browser physical storage.',
    ),
    'behavioral-tests': gap(
      'Existing presentation-state tests exercise selected paths, but do not form a closed success, concurrency, cancellation, and failure matrix for the whole domain.',
    ),
    'browser-performance-tests': gap(
      'No presentation-state-specific browser heap or latency proof is registered.',
    ),
    'runtime-dev-ci-parity': gap(
      'Presentation-state behavior is not explicitly compared across dev and built artifacts.',
    ),
    'legacy-duplicate-bypass-subtraction': gap(
      'The cited audit rejects selected presentation-state boundaries only; it is not a closed-world proof against every legacy path, duplicate implementation, dead owner, and direct bypass.',
    ),
  }),
  domainCoverage('presentation-system', {
    'exact-modules-responsibilities': covered(
      'Presentation components and styles are exactly classified.',
      ['canonical-production-module-inventory'],
    ),
    'public-ingress': gap('UI composition surfaces are not declared as canonical domain ingress.'),
    'event-model': gap(
      'The cited scans and tests cover recognized lifecycle, UI, or behavior paths, not a closed-world producer-consumer event registry for presentation-system.',
    ),
    'mutable-ownership': gap(
      'Component-local mutable ownership is intentionally outside the current module coordination scan and remains uninventoried.',
    ),
    'retained-resource-lifetime': gap(
      'Portals, object URLs, observers, editor state, and rendering caches lack one complete UI lifetime inventory.',
    ),
    'queries-commands-durable-writes': gap(
      'No exhaustive proof maps every UI intent to one application command/query and rejects bypasses by intent.',
    ),
    'stage-order': gap(
      'Presentation stages do not separate shell control readiness from transcript hydration and active-stream recovery; reload currently leaves controls inert for seconds.',
    ),
    'failure-cancellation-rollback': gap(
      'Presentation tests do not prove controls remain interactive during failed or delayed stream recovery; eventual repaint is insufficient.',
    ),
    'tab-cross-tab-locality': gap('No UI-wide real-tab locality matrix exists.'),
    'temporal-semantics': gap(
      'No presentation temporal invariant forbids multi-second input blocking while active-stream hydration, recovery, or lease arbitration settles.',
    ),
    'cpu-complexity': gap(
      'The cited proof bounds selected presentation-system operations only; the domain has no closed hot-path inventory with input-shaped complexity evidence for each entry.',
    ),
    'memory-bounds': gap(
      'The cited proof bounds selected presentation-system allocations only; retained and peak memory are not measured across every owner and adversarial workload.',
    ),
    'physical-storage-reclamation': notApplicable(
      'Presentation does not own physical storage reclamation.',
    ),
    'behavioral-tests': gap(
      'Existing presentation-system tests exercise selected paths, but do not form a closed success, concurrency, cancellation, and failure matrix for the whole domain.',
    ),
    'browser-performance-tests': gap(
      'Major surfaces have browser coverage, but no reload-under-stream test asserts that independent controls remain immediately clickable while transcript recovery proceeds.',
    ),
    'runtime-dev-ci-parity': gap(
      'UI interactions are not systematically replayed against both dev and built artifacts.',
    ),
    'legacy-duplicate-bypass-subtraction': gap(
      'The cited audit rejects selected presentation-system boundaries only; it is not a closed-world proof against every legacy path, duplicate implementation, dead owner, and direct bypass.',
    ),
  }),
  domainCoverage('provider-configuration', {
    'exact-modules-responsibilities': covered(
      'Provider configuration policy and adapters are exactly classified.',
      ['canonical-production-module-inventory'],
    ),
    'public-ingress': gap(
      'The canonical list declares known provider-configuration entry points, but no closed-world source scan proves that no other public ingress exists.',
    ),
    'event-model': gap(
      'The cited scans and tests cover recognized lifecycle, UI, or behavior paths, not a closed-world producer-consumer event registry for provider-configuration.',
    ),
    'mutable-ownership': gap(
      'The coordination scan covers module lets and retained collections, not every scalar instance, React, Zustand, and controller mutation owner in provider-configuration.',
    ),
    'retained-resource-lifetime': gap(
      'The cited evidence covers retained collections and selected resources, not every promise, listener, timer, controller, object URL, channel, and abort handle in provider-configuration.',
    ),
    'queries-commands-durable-writes': gap(
      'The top-level protocol audit collapses nested ConfigurationDomainCommand variants under configuration.execute, so nested constructor and write ownership is not closed-world yet.',
    ),
    'stage-order': gap(
      'Top-level configuration.execute switch coverage does not prove exhaustive stage handling for the nested configuration protocol.',
    ),
    'failure-cancellation-rollback': gap(
      'Nested configuration write variants lack per-operation rollback and partial-commit evidence despite surface-level browser behavior.',
    ),
    'tab-cross-tab-locality': gap(
      'No real two-tab configuration edit ownership test is registered.',
    ),
    'temporal-semantics': gap(
      'Discovery refresh, selection, and settled-edit timing lack one executable temporal model.',
    ),
    'cpu-complexity': gap(
      'Large model/provider preference processing lacks input-shaped complexity assertions.',
    ),
    'memory-bounds': gap(
      'The cited proof bounds selected provider-configuration allocations only; retained and peak memory are not measured across every owner and adversarial workload.',
    ),
    'physical-storage-reclamation': gap(
      'No browser test measures model/privacy cache deletion against physical quota.',
    ),
    'behavioral-tests': gap(
      'Existing provider-configuration tests exercise selected paths, but do not form a closed success, concurrency, cancellation, and failure matrix for the whole domain.',
    ),
    'browser-performance-tests': covered(
      'Provider manager and routing behavior run in real built browsers.',
      ['connection-manager-browser-tests', 'provider-routing-browser-tests'],
    ),
    'runtime-dev-ci-parity': gap(
      'Provider configuration is not explicitly replayed against dev and built artifacts.',
    ),
    'legacy-duplicate-bypass-subtraction': gap(
      'The top-level protocol audit cannot reject duplicate or bypassed nested configuration write paths.',
    ),
  }),
  domainCoverage('provider-discovery', {
    'exact-modules-responsibilities': covered(
      'Provider discovery transport modules are exactly classified.',
      ['canonical-production-module-inventory'],
    ),
    'public-ingress': gap(
      'The canonical list declares known provider-discovery entry points, but no closed-world source scan proves that no other public ingress exists.',
    ),
    'event-model': gap(
      'Fetch, cache, dedupe, cancellation, and subscriber events are not represented in one exhaustive event registry.',
    ),
    'mutable-ownership': gap(
      'Only retained discovery collections, not all mutable discovery flight state, are currently classified.',
    ),
    'retained-resource-lifetime': gap(
      'The cited evidence covers retained collections and selected resources, not every promise, listener, timer, controller, object URL, channel, and abort handle in provider-discovery.',
    ),
    'queries-commands-durable-writes': gap(
      'Top-level protocol checks do not discover every nested command, direct transaction, physical write, and publication bypass in provider-discovery.',
    ),
    'stage-order': gap(
      'Top-level switch coverage and representative tests do not enumerate every provider-discovery prerequisite, stage, commit fact, cancellation edge, and terminal state.',
    ),
    'failure-cancellation-rollback': gap(
      'Representative provider-discovery failures are tested, but no await-by-await fault matrix proves every cancellation, rollback, retry, and partial-commit path.',
    ),
    'tab-cross-tab-locality': gap(
      'No real two-tab discovery dedupe and cache propagation test is registered.',
    ),
    'temporal-semantics': gap(
      'TTL, request dedupe, abort, and retry timing lack one executable contract.',
    ),
    'cpu-complexity': gap(
      'Large model and endpoint response processing lacks input-shaped work assertions.',
    ),
    'memory-bounds': gap(
      'In-flight discovery payload and catalog cache peak memory are not measured.',
    ),
    'physical-storage-reclamation': gap(
      'No browser test measures expired discovery cache reclamation physically.',
    ),
    'behavioral-tests': gap(
      'Existing provider-discovery tests exercise selected paths, but do not form a closed success, concurrency, cancellation, and failure matrix for the whole domain.',
    ),
    'browser-performance-tests': covered(
      'Provider fetch and selection run in real built browsers.',
      ['connection-manager-browser-tests', 'provider-routing-browser-tests'],
    ),
    'runtime-dev-ci-parity': gap(
      'Discovery behavior is not explicitly compared across dev proxy and built paths.',
    ),
    'legacy-duplicate-bypass-subtraction': gap(
      'The cited audit rejects selected provider-discovery boundaries only; it is not a closed-world proof against every legacy path, duplicate implementation, dead owner, and direct bypass.',
    ),
  }),
  domainCoverage('provider-io', {
    'exact-modules-responsibilities': covered(
      'Provider wire and stream adapters are exactly classified.',
      ['canonical-production-module-inventory'],
    ),
    'public-ingress': gap(
      'The canonical list declares known provider-io entry points, but no closed-world source scan proves that no other public ingress exists.',
    ),
    'event-model': gap(
      'The cited scans and tests cover recognized lifecycle, UI, or behavior paths, not a closed-world producer-consumer event registry for provider-io.',
    ),
    'mutable-ownership': gap(
      'Provider adapter-local mutable stream state lacks an exhaustive owner inventory.',
    ),
    'retained-resource-lifetime': gap(
      'The cited evidence covers retained collections and selected resources, not every promise, listener, timer, controller, object URL, channel, and abort handle in provider-io.',
    ),
    'queries-commands-durable-writes': gap(
      'Top-level protocol checks do not discover every nested command, direct transaction, physical write, and publication bypass in provider-io.',
    ),
    'stage-order': gap(
      'Top-level switch coverage and representative tests do not enumerate every provider-io prerequisite, stage, commit fact, cancellation edge, and terminal state.',
    ),
    'failure-cancellation-rollback': gap(
      'Representative provider-io failures are tested, but no await-by-await fault matrix proves every cancellation, rollback, retry, and partial-commit path.',
    ),
    'tab-cross-tab-locality': gap(
      'Provider I/O itself lacks an exact real-tab ownership matrix independent of generation.',
    ),
    'temporal-semantics': gap(
      'Representative asynchronous provider-io ordering is tested, not every clock, timer, retry, debounce, race, maintenance, and teardown semantic.',
    ),
    'cpu-complexity': gap(
      'The cited proof bounds selected provider-io operations only; the domain has no closed hot-path inventory with input-shaped complexity evidence for each entry.',
    ),
    'memory-bounds': gap(
      'The cited proof bounds selected provider-io allocations only; retained and peak memory are not measured across every owner and adversarial workload.',
    ),
    'physical-storage-reclamation': notApplicable(
      'Provider transport does not own browser physical storage.',
    ),
    'behavioral-tests': gap(
      'Existing provider-io tests exercise selected paths, but do not form a closed success, concurrency, cancellation, and failure matrix for the whole domain.',
    ),
    'browser-performance-tests': covered(
      'Provider routing and streaming run in a real built browser.',
      ['provider-routing-browser-tests'],
    ),
    'runtime-dev-ci-parity': gap(
      'Transport behavior is not explicitly replayed through dev and built artifacts.',
    ),
    'legacy-duplicate-bypass-subtraction': gap(
      'No static audit proves all provider routes use only the unified assistant-stream facade.',
    ),
  }),
  domainCoverage('schema-evolution', {
    'exact-modules-responsibilities': covered(
      'Every migration and run-once repair module is exactly classified.',
      ['canonical-production-module-inventory'],
    ),
    'public-ingress': gap(
      'Migration and import compatibility entry points are not declared in canonical ingress.',
    ),
    'event-model': notApplicable(
      'Version-gated migrations are invoked by boundaries rather than an application event bus.',
    ),
    'mutable-ownership': gap(
      'Migration-scoped mutable state is not exhaustively owner-classified.',
    ),
    'retained-resource-lifetime': gap(
      'The cited evidence covers retained collections and selected resources, not every promise, listener, timer, controller, object URL, channel, and abort handle in schema-evolution.',
    ),
    'queries-commands-durable-writes': gap(
      'No generated manifest maps every migration to exact stores, markers, batches, and write amplification.',
    ),
    'stage-order': gap(
      'Migration prerequisites, markers, rollback, and resume order lack one exhaustive stage graph.',
    ),
    'failure-cancellation-rollback': gap(
      'Representative schema-evolution failures are tested, but no await-by-await fault matrix proves every cancellation, rollback, retry, and partial-commit path.',
    ),
    'tab-cross-tab-locality': gap(
      'No real-tab upgrade contention and stale-version recovery matrix is registered.',
    ),
    'temporal-semantics': gap(
      'Run-once gating, interrupted migration, and retry timing lack a unified executable contract.',
    ),
    'cpu-complexity': gap(
      'The cited proof bounds selected schema-evolution operations only; the domain has no closed hot-path inventory with input-shaped complexity evidence for each entry.',
    ),
    'memory-bounds': gap(
      'The cited proof bounds selected schema-evolution allocations only; retained and peak memory are not measured across every owner and adversarial workload.',
    ),
    'physical-storage-reclamation': gap(
      'The browser test explicitly avoids claiming immediate quota reclamation; physical proof remains absent.',
    ),
    'behavioral-tests': gap(
      'Existing schema-evolution tests exercise selected paths, but do not form a closed success, concurrency, cancellation, and failure matrix for the whole domain.',
    ),
    'browser-performance-tests': covered(
      'Legacy import and schema cleanup run in a real browser.',
      ['interchange-browser-tests', 'schema-cleanup-browser-tests'],
    ),
    'runtime-dev-ci-parity': gap(
      'Upgrade behavior is not explicitly replayed against dev and built artifacts.',
    ),
    'legacy-duplicate-bypass-subtraction': gap(
      'The cited audit rejects selected schema-evolution boundaries only; it is not a closed-world proof against every legacy path, duplicate implementation, dead owner, and direct bypass.',
    ),
  }),
  domainCoverage('shared-contracts', {
    'exact-modules-responsibilities': covered(
      'The cross-domain schema contract module is exactly classified.',
      ['canonical-production-module-inventory'],
    ),
    'public-ingress': gap(
      'Shared contract consumers and compatibility surface are not declared as canonical ingress.',
    ),
    'event-model': notApplicable('Pure shared contracts do not produce runtime events.'),
    'mutable-ownership': notApplicable('Pure shared contracts do not own mutable runtime state.'),
    'retained-resource-lifetime': notApplicable('Pure shared contracts do not retain resources.'),
    'queries-commands-durable-writes': gap(
      'No proof maps every durable row shape and protocol payload back to one contract definition.',
    ),
    'stage-order': notApplicable('Pure contract declarations do not execute stages.'),
    'failure-cancellation-rollback': notApplicable(
      'Pure contract declarations do not execute failure handling.',
    ),
    'tab-cross-tab-locality': notApplicable('Pure contracts do not own locality.'),
    'temporal-semantics': gap(
      'Timestamp and lease fields lack a centralized semantic audit at the type contract.',
    ),
    'cpu-complexity': notApplicable('Type declarations have no runtime CPU cost.'),
    'memory-bounds': notApplicable('Type declarations retain no runtime memory.'),
    'physical-storage-reclamation': notApplicable(
      'Contract declarations do not own physical storage.',
    ),
    'behavioral-tests': gap(
      'No generated round-trip or invariant suite covers every shared durable contract.',
    ),
    'browser-performance-tests': notApplicable(
      'Pure type contracts have no standalone browser behavior.',
    ),
    'runtime-dev-ci-parity': notApplicable(
      'The same compiled types feed all builds; no runtime surface exists.',
    ),
    'legacy-duplicate-bypass-subtraction': gap(
      'No audit rejects duplicate durable shape declarations outside the shared contract.',
    ),
  }),
  domainCoverage('shared-runtime', {
    'exact-modules-responsibilities': covered('Shared runtime utilities are exactly classified.', [
      'canonical-production-module-inventory',
    ]),
    'public-ingress': gap(
      'Runtime utility entry points and audiences are not declared in canonical ingress.',
    ),
    'event-model': gap(
      'The cited scans and tests cover recognized lifecycle, UI, or behavior paths, not a closed-world producer-consumer event registry for shared-runtime.',
    ),
    'mutable-ownership': gap(
      'The coordination scan covers module lets and retained collections, not every scalar instance, React, Zustand, and controller mutation owner in shared-runtime.',
    ),
    'retained-resource-lifetime': gap(
      'The cited evidence covers retained collections and selected resources, not every promise, listener, timer, controller, object URL, channel, and abort handle in shared-runtime.',
    ),
    'queries-commands-durable-writes': notApplicable(
      'Shared runtime utilities do not own workspace protocol operations.',
    ),
    'stage-order': gap(
      'Top-level switch coverage and representative tests do not enumerate every shared-runtime prerequisite, stage, commit fact, cancellation edge, and terminal state.',
    ),
    'failure-cancellation-rollback': gap(
      'Representative shared-runtime failures are tested, but no await-by-await fault matrix proves every cancellation, rollback, retry, and partial-commit path.',
    ),
    'tab-cross-tab-locality': gap(
      'Shared runtime utility locality is not exercised as an explicit real-tab matrix.',
    ),
    'temporal-semantics': gap(
      'Representative asynchronous shared-runtime ordering is tested, not every clock, timer, retry, debounce, race, maintenance, and teardown semantic.',
    ),
    'cpu-complexity': gap(
      'Scheduler and listener fanout complexity is not input-shaped or measured.',
    ),
    'memory-bounds': gap('Runtime listener/channel retention lacks adversarial heap measurement.'),
    'physical-storage-reclamation': notApplicable('Shared runtime does not own physical storage.'),
    'behavioral-tests': covered('Runtime resource and coordination behavior is executable.', [
      'workspace-runtime-resource-tests',
    ]),
    'browser-performance-tests': gap(
      'No shared-runtime-specific browser performance proof is registered.',
    ),
    'runtime-dev-ci-parity': gap(
      'Shared runtime behavior is not explicitly replayed in dev and built artifacts.',
    ),
    'legacy-duplicate-bypass-subtraction': gap(
      'No audit proves all lifecycle helpers have been absorbed by one runtime owner.',
    ),
  }),
  domainCoverage('storage-administration', {
    'exact-modules-responsibilities': covered(
      'Storage administration modules are exactly classified.',
      ['canonical-production-module-inventory'],
    ),
    'public-ingress': gap(
      'The canonical list declares known storage-administration entry points, but no closed-world source scan proves that no other public ingress exists.',
    ),
    'event-model': gap(
      'The cited scans and tests cover recognized lifecycle, UI, or behavior paths, not a closed-world producer-consumer event registry for storage-administration.',
    ),
    'mutable-ownership': gap(
      'The coordination scan covers module lets and retained collections, not every scalar instance, React, Zustand, and controller mutation owner in storage-administration.',
    ),
    'retained-resource-lifetime': gap(
      'The cited evidence covers retained collections and selected resources, not every promise, listener, timer, controller, object URL, channel, and abort handle in storage-administration.',
    ),
    'queries-commands-durable-writes': gap(
      'Top-level protocol checks do not discover every nested command, direct transaction, physical write, and publication bypass in storage-administration.',
    ),
    'stage-order': gap(
      'Top-level switch coverage and representative tests do not enumerate every storage-administration prerequisite, stage, commit fact, cancellation edge, and terminal state.',
    ),
    'failure-cancellation-rollback': gap(
      'Representative storage-administration failures are tested, but no await-by-await fault matrix proves every cancellation, rollback, retry, and partial-commit path.',
    ),
    'tab-cross-tab-locality': gap(
      'A real two-tab compaction preemption, retry, slot-switch, and reload journey is registered; unchanged-candidate execution and wipe-contention closure remain open.',
    ),
    'temporal-semantics': gap(
      'Representative asynchronous storage-administration ordering is tested, not every clock, timer, retry, debounce, race, maintenance, and teardown semantic.',
    ),
    'cpu-complexity': gap(
      'The cited proof bounds selected storage-administration operations only; the domain has no closed hot-path inventory with input-shaped complexity evidence for each entry.',
    ),
    'memory-bounds': gap(
      'The cited proof bounds selected storage-administration allocations only; retained and peak memory are not measured across every owner and adversarial workload.',
    ),
    'physical-storage-reclamation': gap(
      'The registered browser journey proves replacement debt, physical source-database deletion, and automatic retry, but Chromium quota reclamation remains telemetry-only.',
    ),
    'behavioral-tests': gap(
      'Existing storage-administration tests exercise selected paths, but do not form a closed success, concurrency, cancellation, and failure matrix for the whole domain.',
    ),
    'browser-performance-tests': covered(
      'Storage cleanup and attachment management run in real built browsers.',
      ['storage-reclamation-browser-tests', 'attachment-manager-browser-tests'],
    ),
    'runtime-dev-ci-parity': gap(
      'Storage behavior is not explicitly replayed in dev and built artifacts.',
    ),
    'legacy-duplicate-bypass-subtraction': gap(
      'The cited audit rejects selected storage-administration boundaries only; it is not a closed-world proof against every legacy path, duplicate implementation, dead owner, and direct bypass.',
    ),
  }),
  domainCoverage('workspace', {
    'exact-modules-responsibilities': covered(
      'Workspace protocols, repository, lifecycle, and storage adapters are exactly classified.',
      ['canonical-production-module-inventory'],
    ),
    'public-ingress': gap(
      'The canonical list declares known workspace entry points, but no closed-world source scan proves that no other public ingress exists.',
    ),
    'event-model': gap(
      'The cited scans and tests cover recognized lifecycle, UI, or behavior paths, not a closed-world producer-consumer event registry for workspace.',
    ),
    'mutable-ownership': gap(
      'The coordination scan covers module lets and retained collections, not every scalar instance, React, Zustand, and controller mutation owner in workspace.',
    ),
    'retained-resource-lifetime': gap(
      'The cited evidence covers retained collections and selected resources, not every promise, listener, timer, controller, object URL, channel, and abort handle in workspace.',
    ),
    'queries-commands-durable-writes': gap(
      'Physical write/no-write detection and publication gating are transaction-derived, but exact semantic receipt/delta construction plus per-variant lock, table, rollback, and locality contracts are not yet derived from one command protocol.',
    ),
    'stage-order': gap(
      'Runtime resource phases exist, but durable writes and active-stream reload do not share a proved stage model that keeps shell interaction independent from hydration, recovery, and lease arbitration.',
    ),
    'failure-cancellation-rollback': gap(
      'Distributed writes lack per-variant rollback proof, and active-stream reload currently leaves controls inert while workspace recovery settles.',
    ),
    'tab-cross-tab-locality': gap(
      'Selected multi-tab scenarios pass, but workspace lacks an entry-by-entry locality matrix; the still-failing background-tab New chat path is direct counterevidence.',
    ),
    'temporal-semantics': gap(
      'Workspace recovery has no invariant separating UI readiness from hydration and lease arbitration; active-stream reload currently causes multi-second unclickability.',
    ),
    'cpu-complexity': gap(
      'Workspace open/reconcile/replace work lacks input-shaped complexity proof.',
    ),
    'memory-bounds': gap('Hidden-tab and replacement lifecycle peak heap are not measured.'),
    'physical-storage-reclamation': gap(
      'Logical cleanup is browser-tested, but physical quota reclamation remains explicitly unproved.',
    ),
    'behavioral-tests': gap(
      'Existing workspace tests exercise selected paths, but do not form a closed success, concurrency, cancellation, and failure matrix for the whole domain.',
    ),
    'browser-performance-tests': gap(
      'Startup and recovery scenarios run in browsers, but none asserts immediate shell interactivity during active-stream reload, hydration, and lease recovery.',
    ),
    'runtime-dev-ci-parity': gap(
      'Built preview or CI is exercised for workspace, but the same scenarios are not replayed against development and built runtimes through identical public paths.',
    ),
    'legacy-duplicate-bypass-subtraction': gap(
      'Presentation and legacy boundaries are checked, but distributed durable-write helpers still prevent a closed-world bypass proof for workspace mutations.',
    ),
  }),
])

function dimension(id, description, allowedProofKinds) {
  return Object.freeze({ id, description, allowedProofKinds: Object.freeze(allowedProofKinds) })
}

function proof(id, kind, path, locator, domains, dimensions) {
  return Object.freeze({
    id,
    kind,
    path,
    locator,
    domains: Object.freeze(domains),
    dimensions: Object.freeze(dimensions),
  })
}

function domainCoverage(domain, cells) {
  return Object.freeze({ domain, cells: Object.freeze(cells) })
}

function covered(rationale, proofs) {
  return Object.freeze({ status: 'covered', rationale, proofs: Object.freeze(proofs) })
}

function gap(rationale) {
  return Object.freeze({ status: 'gap', rationale, proofs: Object.freeze([]) })
}

function notApplicable(rationale) {
  return Object.freeze({ status: 'not-applicable', rationale, proofs: Object.freeze([]) })
}
