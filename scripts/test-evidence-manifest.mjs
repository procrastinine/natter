export const DECLARED_TEST_DOMAINS = Object.freeze({
  'tests/e2e/abort.spec.ts': ['conversation', 'generation', 'workspace'],
  'tests/e2e/advanced-generation-routing.spec.ts': [
    'generation',
    'provider-configuration',
    'provider-io',
  ],
  'tests/e2e/attachment-manager.spec.ts': ['attachments', 'presentation-system'],
  'tests/e2e/branch-tree-streaming.spec.ts': ['conversation', 'generation', 'presentation-system'],
  'tests/e2e/branch-tree.spec.ts': ['conversation', 'presentation-state', 'presentation-system'],
  'tests/e2e/chat-header-layout.spec.ts': ['presentation-system', 'provider-configuration'],
  'tests/e2e/composer.spec.ts': ['conversation', 'presentation-system'],
  'tests/e2e/concurrent-ops.spec.ts': [
    'conversation',
    'generation',
    'presentation-state',
    'workspace',
  ],
  'tests/e2e/dev-preview-parity.spec.ts': [
    'application-shell',
    'build-environment',
    'conversation',
    'generation',
    'provider-io',
    'workspace',
  ],
  'tests/e2e/destination-frame-budget-recorder.ts': [
    'build-environment',
    'conversation',
    'presentation-state',
    'workspace',
  ],
  'tests/e2e/connection-manager.spec.ts': ['presentation-system', 'provider-configuration'],
  'tests/e2e/error-boundary.spec.ts': ['application-shell', 'diagnostics'],
  'tests/e2e/fake-stream-provider.ts': ['build-environment', 'provider-io'],
  'tests/e2e/first-run-seed.spec.ts': ['application-shell', 'provider-configuration', 'workspace'],
  'tests/e2e/fixtures.ts': ['build-environment', 'diagnostics'],
  'tests/e2e/focus-mode-layout.spec.ts': ['presentation-state', 'presentation-system'],
  'tests/e2e/foreground-gesture.ts': [
    'build-environment',
    'presentation-state',
    'presentation-system',
  ],
  'tests/e2e/full-generation-routing.spec.ts': [
    'generation',
    'provider-configuration',
    'provider-io',
  ],
  'tests/e2e/generated-workspace-state.ts': ['build-environment', 'workspace'],
  'tests/e2e/helpers.ts': ['build-environment', 'workspace'],
  'tests/e2e/indexeddb-dump-provider-picker.spec.ts': [
    'provider-configuration',
    'schema-evolution',
    'workspace',
  ],
  'tests/e2e/inline-title.spec.ts': ['conversation', 'presentation-system'],
  'tests/e2e/legacy-import-recovery.spec.ts': ['interchange', 'schema-evolution', 'workspace'],
  'tests/e2e/large-workspace.setup.ts': ['build-environment', 'interchange', 'workspace'],
  'tests/e2e/large-workspace-startup.spec.ts': [
    'application-shell',
    'catalog',
    'conversation',
    'presentation-system',
    'workspace',
  ],
  'tests/e2e/lifecycle-drain.ts': ['build-environment', 'diagnostics'],
  'tests/e2e/markdown.spec.ts': ['presentation-system'],
  'tests/e2e/message-header.spec.ts': ['conversation', 'presentation-system'],
  'tests/e2e/mobile-shell.spec.ts': ['application-shell', 'presentation-system'],
  'tests/e2e/multi-turn.spec.ts': ['conversation', 'generation', 'provider-io'],
  'tests/e2e/orphan-recovery.spec.ts': ['generation', 'workspace'],
  'tests/e2e/persistence.spec.ts': ['conversation', 'generation', 'workspace'],
  'tests/e2e/production-startup.spec.ts': ['application-shell', 'build-environment'],
  'tests/e2e/provider-crosswalk-switching.spec.ts': [
    'provider-configuration',
    'provider-discovery',
  ],
  'tests/e2e/provider-tool-fixture-replay.spec.ts': [
    'generation',
    'provider-configuration',
    'provider-io',
  ],
  'tests/e2e/reactive-storage-stress.spec.ts': [
    'presentation-state',
    'presentation-system',
    'workspace',
  ],
  'tests/e2e/reasoning-ui.spec.ts': ['generation', 'presentation-system', 'provider-io'],
  'tests/e2e/render-window-loading.spec.ts': [
    'conversation',
    'presentation-state',
    'presentation-system',
  ],
  'tests/e2e/render-window-streaming.spec.ts': [
    'conversation',
    'generation',
    'presentation-system',
  ],
  'tests/e2e/render-window.spec.ts': [
    'catalog',
    'conversation',
    'presentation-state',
    'presentation-system',
  ],
  'tests/e2e/safety-ui.spec.ts': ['application-shell', 'presentation-system'],
  'tests/e2e/scroll.spec.ts': [
    'conversation',
    'generation',
    'presentation-state',
    'presentation-system',
  ],
  'tests/e2e/send-performance.spec.ts': ['conversation', 'generation', 'provider-io'],
  'tests/e2e/send-flow.spec.ts': ['conversation', 'generation', 'provider-io'],
  'tests/e2e/sidebar.spec.ts': ['catalog', 'organization', 'presentation-system'],
  'tests/e2e/startup-recovery.spec.ts': ['application-shell', 'schema-evolution', 'workspace'],
  'tests/e2e/storage-reclamation.spec.ts': [
    'attachments',
    'conversation',
    'generation',
    'presentation-state',
    'storage-administration',
    'workspace',
  ],
  'tests/e2e/stream-overflow.spec.ts': ['generation', 'presentation-system'],
  'tests/e2e/stream-ownership-admission.spec.ts': ['generation', 'workspace'],
  'tests/e2e/stream-retention.spec.ts': ['generation', 'presentation-system', 'workspace'],
  'tests/e2e/system-prompt.spec.ts': ['generation', 'provider-configuration'],
  'tests/e2e/ui-journey-invariant-recorder.ts': [
    'build-environment',
    'presentation-state',
    'presentation-system',
  ],
  'tests/integration/committed-write-delivery.test.ts': ['workspace'],
  'tests/helpers/protocol-contract-facts.ts': ['build-environment', 'shared-contracts'],
  'tests/unit/architecture-coverage-audit.test.ts': ['build-environment', 'shared-contracts'],
  'tests/unit/architecture-inventory-closure-audit.test.ts': [
    'build-environment',
    'shared-contracts',
    'shared-runtime',
  ],
  'tests/unit/audit-result-state.test.ts': ['build-environment', 'shared-contracts'],
  'tests/unit/backcompat-boundary.test.ts': ['schema-evolution'],
  'tests/unit/browser-command-mutation-journal.test.ts': ['workspace'],
  'tests/unit/configuration-protocol-audit.test.ts': ['provider-configuration'],
  'tests/unit/debug-buffer.test.ts': ['build-environment', 'diagnostics'],
  'tests/unit/durable-command-pipeline-audit.test.ts': ['workspace'],
  'tests/unit/e2e-browser-storage-inventory.test.ts': [
    'build-environment',
    'storage-administration',
    'workspace',
  ],
  'tests/unit/e2e-lifecycle-drain.test.ts': ['build-environment', 'diagnostics'],
  'tests/unit/fake-stream-server.test.ts': ['build-environment', 'provider-io'],
  'tests/unit/generation-path-audit.test.ts': ['conversation', 'generation'],
  'tests/unit/generated-workspace-fixture.test.ts': [
    'build-environment',
    'interchange',
    'workspace',
  ],
  'tests/unit/hidden-tab-visual-continuity-audit.test.ts': [
    'application-shell',
    'presentation-system',
    'shared-runtime',
  ],
  'tests/unit/interaction-capability-audit.test.ts': ['application-shell', 'presentation-system'],
  'tests/unit/interaction-inventory.test.ts': ['application-shell', 'presentation-system'],
  'tests/unit/legacy-test-migration-ledger.test.ts': ['build-environment'],
  'tests/unit/local-module-graph.test.ts': ['build-environment', 'shared-contracts'],
  'tests/unit/navigation-boundary.test.ts': [
    'application-shell',
    'presentation-state',
    'workspace',
  ],
  'tests/unit/presentation-capability-boundary.test.ts': [
    'application-shell',
    'presentation-system',
  ],
  'tests/unit/production-coordination-audit.test.ts': ['shared-runtime', 'workspace'],
  'tests/unit/production-async-ownership-audit.test.ts': ['build-environment', 'shared-runtime'],
  'tests/unit/production-module-inventory.test.ts': ['build-environment'],
  'tests/unit/production-protocol-audit.test.ts': [
    'build-environment',
    'shared-contracts',
    'shared-runtime',
    'workspace',
  ],
  'tests/unit/protocol-contract-fact-bundle.test.ts': [
    'build-environment',
    'provider-configuration',
    'shared-contracts',
    'workspace',
  ],
  'tests/unit/production-runtime-effects-audit.test.ts': ['build-environment', 'shared-runtime'],
  'tests/unit/production-time-semantics-audit.test.ts': ['build-environment', 'shared-runtime'],
  'tests/unit/production-work-memory-audit.test.ts': [
    'build-environment',
    'presentation-system',
    'shared-runtime',
    'workspace',
  ],
  'tests/unit/run-slice-verification.test.ts': ['build-environment', 'shared-contracts'],
  'tests/unit/run-checkpoint-verification.test.ts': ['build-environment', 'shared-contracts'],
  'tests/unit/launch-slice-verification.test.ts': ['build-environment', 'shared-contracts'],
  'tests/unit/scroll-continuity-audit.test.ts': [
    'conversation',
    'presentation-state',
    'presentation-system',
  ],
  'tests/unit/startup-readiness-audit.test.ts': ['application-shell', 'workspace'],
  'tests/unit/storage-ownership-reclamation-audit.test.ts': [
    'build-environment',
    'storage-administration',
    'workspace',
  ],
  'tests/unit/tab-cross-tab-locality-audit.test.ts': [
    'conversation',
    'presentation-state',
    'shared-runtime',
    'workspace',
  ],
  'tests/unit/style-discipline.test.ts': ['presentation-system'],
  'tests/unit/test-runtime-isolation.test.ts': ['build-environment', 'workspace'],
  'tests/unit/test-evidence-audit.test.ts': ['build-environment'],
  'tests/unit/tokens-css.test.ts': ['presentation-system'],
  'tests/unit/ui-journey-invariant-recorder.test.ts': ['presentation-state', 'presentation-system'],
  'tests/unit/verification-runner.test.ts': ['build-environment'],
  'tests/unit/verification-assurance-audit.test.ts': ['build-environment', 'shared-contracts'],
  'tests/unit/verification-candidate-workspace.test.ts': ['build-environment', 'shared-contracts'],
  'tests/unit/verification-dependency-image.test.ts': ['build-environment', 'shared-contracts'],
  'tests/unit/verification-process-lease.test.ts': ['build-environment', 'shared-contracts'],
  'tests/unit/verification-git-comparison.test.ts': ['build-environment', 'shared-contracts'],
  'tests/unit/verification-impact-plan.test.ts': ['build-environment', 'shared-contracts'],
  'tests/unit/stream-profile-evaluator.test.ts': [
    'build-environment',
    'generation',
    'storage-administration',
    'workspace',
  ],
})

export const TEST_GUARANTEE_CLAIMS = Object.freeze([
  {
    id: 'verification-runs-independent-stages-after-failure',
    status: 'covered',
    requiredProofKinds: ['static', 'unit'],
    rationale:
      'The runner is invoked through a test double and the assertion proves that both advisory and blocking failures do not suppress a later independent stage.',
    evidence: [
      {
        path: 'tests/unit/verification-runner.test.ts',
        locator: "it('runs every independent stage after advisory and blocking failures'",
      },
    ],
  },
  {
    id: 'local-and-ci-share-one-verification-entrypoint',
    status: 'covered',
    requiredProofKinds: ['static'],
    rationale:
      'GitHub invokes the same package script exposed to local callers; the audit validates the exact workflow, package script, and runner paths.',
    evidence: [
      {
        path: '.github/workflows/verify.yml',
        locator: 'run: pnpm verify:ci',
      },
      {
        path: 'package.json',
        locator: '"verify:ci": "node scripts/run-ci-verification.mjs"',
      },
      {
        path: 'scripts/run-ci-verification.mjs',
        locator: "import('./verification-candidate-preparation.mjs')",
      },
      {
        path: 'scripts/run-ci-verification.mjs',
        locator: "runnerKind: 'checkpoint'",
      },
      {
        path: 'scripts/run-checkpoint-verification.mjs',
        locator: 'finalValidator: () =>',
      },
    ],
  },
  {
    id: 'built-browser-tests-use-external-provider-and-no-source-module-hook',
    status: 'covered',
    requiredProofKinds: ['browser', 'static'],
    rationale:
      'Playwright builds and previews the artifact, starts the standalone fake-provider server, and a browser assertion rejects source-module and development-hook exposure.',
    evidence: [
      {
        path: 'playwright.config.ts',
        locator: 'command: applicationServerCommand',
      },
      {
        path: 'playwright.config.ts',
        locator: '$' + '{packageManagerCommand} fake-provider',
      },
      {
        path: 'tests/e2e/production-startup.spec.ts',
        locator: "test('production artifact excludes source modules and development tools'",
      },
    ],
  },
  {
    id: 'startup-active-stream-shell-clickability',
    status: 'covered',
    requiredProofKinds: ['browser', 'performance'],
    rationale:
      'A built-browser active-stream reload journey measures bounded first-gesture latency while workspace opening remains pending.',
    evidence: [
      {
        path: 'tests/e2e/reactive-storage-stress.spec.ts',
        locator:
          "test('reload during an active stream keeps pure UI controls actionable within bounded latency while opening is pending'",
      },
    ],
  },
  {
    id: 'hidden-tab-projection-visual-continuity',
    status: 'covered',
    requiredProofKinds: ['browser'],
    rationale:
      'The generic visibility journey runs in ordinary Chromium and in a blocking headed Xvfb plus window-manager project that requires native hidden state, exact first-foreground markup, decoded pixels within renderer-noise bounds, screenshots and bounded exact first gestures across every explicit palette.',
    evidence: [
      {
        path: 'tests/e2e/reactive-storage-stress.spec.ts',
        locator:
          "test('visibility leaves the live workspace attached and the first foreground gesture exact'",
      },
      {
        path: 'playwright.config.ts',
        locator: "name: 'chromium-headed-visibility'",
      },
      {
        path: 'playwright.config.ts',
        locator: 'headless: false',
      },
      {
        path: 'scripts/run-verification.mjs',
        locator: "stage(\n    'headed-hidden-tab-visual-continuity',",
      },
      {
        path: 'tests/e2e/reactive-storage-stress.spec.ts',
        locator: 'expect(diff.changedPixelRatio).toBeLessThanOrEqual(0.25)',
      },
      {
        path: 'tests/e2e/reactive-storage-stress.spec.ts',
        locator: 'expect(gesture.clickAt - gesture.visibleAt).toBeLessThanOrEqual(250)',
      },
    ],
  },
  {
    id: 'background-new-chat-first-activation',
    status: 'covered',
    requiredProofKinds: ['browser', 'multi-tab'],
    rationale:
      'A browser journey verifies the New chat anchor, preserves the source tab while the new surface starts in a background tab, activates it, and proves its first foreground gesture.',
    evidence: [
      {
        path: 'tests/e2e/sidebar.spec.ts',
        locator:
          "test('background New chat startup preserves the source tab and the first foreground gesture'",
      },
    ],
  },
  {
    id: 'destination-first-transcript-prepend-scroll-continuity',
    status: 'covered',
    requiredProofKinds: ['browser', 'performance'],
    rationale:
      'One browser journey combines destination-first paint, passive fill, repeated variable-height automatic prepends, and arbitrary remeasurement while bounding one semantic viewport.',
    evidence: [
      {
        path: 'tests/e2e/render-window-loading.spec.ts',
        locator:
          "test('destination-first passive fill and repeated variable-height auto prepends preserve one viewport'",
      },
    ],
  },
  {
    id: 'pending-generation-capability-preserves-first-submit-intent',
    status: 'partial',
    requiredProofKinds: ['integration', 'browser', 'multi-tab'],
    rationale:
      'One frozen submit intent now survives delayed configuration and destination authority, admits exactly once, retains an unaccepted draft, and releases cleanly on cancellation or same-leaf loss. Its affected built-browser packet was green before the final Shell refinement and therefore remains invalidated rather than checkpoint evidence.',
    evidence: [
      {
        path: 'tests/integration/generation-intent-io-contract.test.ts',
        locator: "it('retains one frozen first submit while new-chat configuration settles'",
      },
      {
        path: 'tests/unit/composer.test.tsx',
        locator: "it('owns one pending first submit and clears only after admission'",
      },
      {
        path: 'tests/e2e/composer.spec.ts',
        locator:
          "test('one new-chat Enter waits for configuration and clears only after admission'",
      },
      {
        path: 'tests/e2e/concurrent-ops.spec.ts',
        locator:
          "test('one Enter keeps its claimed branch while destination and a remote publication settle'",
      },
    ],
    missing:
      'Rerun the registered delayed-configuration, delayed-destination and same-leaf browser packet against the unchanged built candidate after the final Shell/presentation refinements.',
  },
  {
    id: 'destination-frame-complete-window-budget',
    status: 'partial',
    requiredProofKinds: ['browser', 'performance'],
    rationale:
      'The logical controller proof and one bounded browser recorder now cover first paint, atomic passive fill, exact rows, transactions, body bytes, long tasks, and control-versus-4k unrelated-workspace invariance through public sidebar navigation. The real built-browser executions remain open in the current loopback-restricted environment.',
    evidence: [
      {
        path: 'tests/integration/conversation-background-fill.test.tsx',
        locator:
          "it('drains multiple fixed-size pages without scrolling or publishing partial prepends'",
      },
      {
        path: 'tests/e2e/render-window-loading.spec.ts',
        locator:
          "test('one sidebar destination gesture bounds the complete configured transcript window'",
      },
      {
        path: 'tests/e2e/large-workspace-startup.spec.ts',
        locator:
          "test('startup work and first interaction stay cardinality-bounded in a 4k-chat workspace'",
      },
    ],
    missing:
      'Execute the registered Chromium and Chromium large-workspace proof stages against the unchanged built candidate; source presence alone does not close the runtime guarantee.',
  },
  {
    id: 'durable-write-automatically-implies-local-and-cross-tab-publication',
    status: 'covered',
    requiredProofKinds: ['static', 'integration', 'multi-tab'],
    rationale:
      'The transaction-local DBCore journal derives didWrite from successful mutations in the exact committed transaction; the AST audit rejects manual markers and command-transaction bypasses, while repository and real-tab tests prove delivery.',
    evidence: [
      {
        path: 'tests/unit/browser-command-mutation-journal.test.ts',
        locator: "it('returns transaction-local facts only after a non-empty mutation commits'",
      },
      {
        path: 'tests/unit/durable-command-pipeline-audit.test.ts',
        locator:
          "it('inventories every command and every required pipeline stage without hiding gaps'",
      },
      {
        path: 'tests/integration/committed-write-delivery.test.ts',
        locator: "it('derives workspace publication from the physical command transaction'",
      },
      {
        path: 'tests/e2e/concurrent-ops.spec.ts',
        locator:
          "test('a remote extension then newer sibling keeps each tab on its own branch without flashing'",
      },
    ],
  },
  {
    id: 'remote-change-never-steers-tab-local-route-or-cursor',
    status: 'partial',
    requiredProofKinds: ['browser', 'multi-tab'],
    rationale:
      'The complete source-derived publication matrix proves addressing and one six-family real-consumer browser matrix now preserves route, branch, draft, focus, selection, scroll, and local stream ownership while shared projections refresh. Runtime closure remains partial until that registered matrix executes against the unchanged built candidate.',
    evidence: [
      {
        path: 'tests/e2e/concurrent-ops.spec.ts',
        locator:
          "test('a remote extension then newer sibling keeps each tab on its own branch without flashing'",
      },
      {
        path: 'tests/e2e/concurrent-ops.spec.ts',
        locator: "test('simultaneous regenerates keep route, cursor, and counts local to each tab'",
      },
      {
        path: 'tests/e2e/reactive-storage-stress.spec.ts',
        locator:
          "test('reactive storage survives lifecycle churn, abort, reload, and peer writes exactly'",
      },
      {
        path: 'tests/e2e/attachment-manager.spec.ts',
        locator:
          "test('remote attachment publication refreshes projections without steering an active chat'",
      },
      {
        path: 'tests/e2e/full-generation-routing.spec.ts',
        locator:
          "test('GUI OpenRouter video model uses parent /endpoints architecture for UI and send routing'",
      },
      {
        path: 'tests/e2e/storage-reclamation.spec.ts',
        locator:
          "test('normal use catches up foreground work without repeating the physical copy and preserves two-tab state'",
      },
      {
        path: 'tests/e2e/storage-reclamation.spec.ts',
        locator:
          "test('clear all reloads into a fresh workspace that can fetch and select models again'",
      },
      {
        path: 'tests/e2e/stream-ownership-admission.spec.ts',
        locator: "test('a remote Stop request converges and the branch admits the next generation'",
      },
    ],
    missing:
      'Execute the registered six-family Chromium outcome matrix against the unchanged built candidate; source presence and synthetic hub addressing do not close the real-tab runtime guarantee.',
  },
  {
    id: 'physical-storage-compaction-retries-without-blocking-peer-work',
    status: 'partial',
    requiredProofKinds: ['browser', 'multi-tab', 'performance'],
    rationale:
      'One public browser journey creates real attachment replacement debt, overlaps a held peer stream, writes a normal title after its source table was staged, observes one compaction revision, and verifies catch-up, the committed slot switch, physical source-database deletion, route/cursor/draft continuity, and reload persistence. Browser quota estimates are telemetry rather than a correctness assertion.',
    evidence: [
      {
        path: 'tests/e2e/storage-reclamation.spec.ts',
        locator:
          "test('normal use catches up foreground work without repeating the physical copy and preserves two-tab state'",
      },
      {
        path: 'tests/unit/storage-retention.test.ts',
        locator: "it('keeps foreground work live without repeating the physical copy'",
      },
    ],
    missing:
      'Execute the registered Chromium journey against the unchanged built candidate; source registration and unit settlement do not close the real-browser lifecycle.',
  },
  {
    id: 'dev-and-built-artifact-exercise-equivalent-application-paths',
    status: 'covered',
    requiredProofKinds: ['browser', 'static'],
    rationale:
      'One blocking checkpoint stage executes the same public startup, generation, view, persistence, and external-provider journey against Vite dev and the already-built preview; source analysis permits only the server-required privacy proxy to differ.',
    evidence: [
      {
        path: 'tests/e2e/dev-preview-parity.spec.ts',
        locator:
          "test('public startup, generation, view roundtrip, and reload use one runtime path'",
      },
      {
        path: 'playwright.config.ts',
        locator: "name: 'chromium-preview-parity'",
      },
      {
        path: 'playwright.config.ts',
        locator: "name: 'chromium-dev-parity'",
      },
      {
        path: 'scripts/run-verification.mjs',
        locator: "'dev-preview-parity',",
      },
    ],
  },
  {
    id: 'verification-hygiene-failures-affect-exit-code',
    status: 'covered',
    requiredProofKinds: ['static', 'unit'],
    rationale:
      'Formatting, semantic lint, and repository-wide dead-code are blocking stages in the shared non-fail-fast runner; peer-dependency drift remains the only explicitly advisory hygiene report.',
    evidence: [
      {
        path: 'tests/unit/verification-runner.test.ts',
        locator: "it('keeps peer dependency drift advisory and makes repository hygiene blocking'",
      },
      {
        path: 'scripts/run-verification.mjs',
        locator: "stage('formatting', 'Check formatting and Biome lint', 'blocking'",
      },
    ],
  },
  {
    id: 'verification-performance-stage-measures-current-runtime',
    status: 'covered',
    requiredProofKinds: ['performance', 'browser'],
    rationale:
      'One explicit production build feeds built Chromium and both real-browser stream profiles; the reporter accepts only path-bounded artifacts and timings from that exact run and makes profile, topology, and delivery-budget failures blocking.',
    evidence: [
      {
        path: 'tests/unit/verification-runner.test.ts',
        locator: "it('persists exact same-run performance inputs before the reporter executes'",
      },
      {
        path: 'tests/unit/stream-profile-evaluator.test.ts',
        locator:
          "it('accepts exact application admission with transport-local provider concurrency'",
      },
      {
        path: 'tests/e2e/large-workspace-startup.spec.ts',
        locator:
          "test('startup work and first interaction stay cardinality-bounded in a 4k-chat workspace'",
      },
    ],
  },
  {
    id: 'isolated-interaction-critical-path-latency',
    status: 'covered',
    requiredProofKinds: ['performance', 'browser'],
    rationale:
      'The strict Chromium folder/render-window and warm-send budgets run serially in one single-worker project after the complete engine suite, while Firefox warm-send remains isolated after its engine suite, so unrelated stress-worker scheduling cannot enter their wall clock.',
    evidence: [
      {
        path: 'tests/e2e/send-performance.spec.ts',
        locator: "test('bounds every warm existing-chat preparation phase and provider dispatch'",
      },
      {
        path: 'tests/e2e/render-window.spec.ts',
        locator:
          "test('a folder larger than one page expands gap-free without stealing the top-first viewport'",
      },
      {
        path: 'playwright.config.ts',
        locator: "name: 'chromium-send-performance'",
      },
      {
        path: 'playwright.config.ts',
        locator: "name: 'firefox-send-performance'",
      },
      {
        path: 'tests/unit/e2e-runtime-boundary.test.ts',
        locator:
          "expect(config).toContain('testMatch: [sendPerformanceSpec, renderWindowPerformanceSpec]')",
      },
    ],
  },
  {
    id: 'every-presentation-interaction-site-has-outcome-proof',
    status: 'gap',
    requiredProofKinds: ['static', 'unit', 'browser'],
    rationale:
      'The interaction inventory binds a source file to at least one behavioral test, but one test in a large component cannot prove every JSX handler or DOM listener in that source.',
    touchedBy: [
      {
        path: 'tests/unit/interaction-inventory.test.ts',
        locator: "it('binds every implemented interaction source to named behavioral evidence'",
      },
    ],
  },
])

export const ALLOWED_DEV_BUILT_DIVERGENCES = Object.freeze([
  {
    id: 'privacy-proxy-server-route',
    category: 'privacy-proxy',
    path: 'vite.config.ts',
    locator: "'/_or_scrape': {",
    rationale: 'The provider privacy page has no CORS support and requires a running proxy.',
  },
  {
    id: 'privacy-proxy-runtime-default',
    category: 'privacy-proxy',
    path: 'src/core/global-settings.ts',
    locator: 'import.meta.env.DEV',
    rationale: 'Only Vite serve can supply the same-origin privacy scrape route by default.',
  },
  {
    id: 'privacy-proxy-settings-presentation',
    category: 'privacy-proxy',
    path: 'src/ui/settings/GeneralSettings.tsx',
    locator: 'import.meta.env.DEV',
    rationale: 'The settings presentation reflects whether the runtime proxy route exists.',
  },
])
