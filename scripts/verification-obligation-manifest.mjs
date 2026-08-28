import { PROTOCOL_CONTRACT_STAGE } from './protocol-contract-descriptor.mjs'
import { PUBLICATION_CONSUMER_FILES } from './tab-cross-tab-locality-inventory.mjs'
import { DECLARED_TEST_DOMAINS } from './test-evidence-manifest.mjs'
import {
  VERIFICATION_DEPENDENCY_RECIPE_FILES,
  verificationDependencyRecipeInputPaths,
} from './verification-dependency-image.mjs'

export const VERIFICATION_OBLIGATION_SCHEMA_VERSION = 2

export const VERIFICATION_PROOFS = Object.freeze([
  proof('workspace-runtime-resources', 'unit', {
    runner: 'vitest',
    files: ['tests/unit/workspace-runtime-resource-manifest.test.ts'],
  }),
  proof('stream-recovery-lifecycle', 'unit', {
    runner: 'vitest',
    files: ['tests/unit/stream-recovery-lifecycle.test.ts'],
  }),
  proof('broadcast-lifecycle', 'unit', {
    runner: 'vitest',
    files: ['tests/unit/broadcast.test.ts'],
  }),
  proof('browser-workspace-lifecycle-contract', 'unit', {
    runner: 'vitest',
    files: [
      'tests/integration/committed-write-delivery.test.ts',
      'tests/unit/browser-command-mutation-journal.test.ts',
      'tests/unit/byte-owner-boundary.test.ts',
      'tests/unit/chat-header-import-export.test.tsx',
      'tests/unit/chat-row-transition.test.ts',
      'tests/unit/browser-workspace-database-control.test.ts',
      'tests/unit/browser-workspace-lifecycle-installation.test.ts',
      'tests/unit/browser-workspace-replacement-transition.test.ts',
      'tests/unit/browser-workspace-slot-coordination.test.ts',
      'tests/unit/configuration-command-planning.test.ts',
      'tests/unit/db-open-recovery.test.ts',
      'tests/unit/db-schema.test.ts',
      'tests/unit/first-run-seed.test.ts',
      'tests/unit/import-export.test.ts',
      'tests/unit/loading-poison.test.ts',
      'tests/unit/locks.test.ts',
      'tests/unit/reactive-query.test.tsx',
      'tests/unit/stream-leases.test.ts',
      'tests/unit/storage-compaction-state.test.ts',
      'tests/unit/storage-retention.test.ts',
      'tests/unit/transaction-activity.test.ts',
      'tests/unit/transaction-order.test.ts',
      'tests/unit/workspace-bootstrap.test.tsx',
      'tests/unit/workspace-commit-delivery.test.ts',
      'tests/unit/workspace-repository-contract.test.ts',
    ],
  }),
  proof('browser-workspace-production-startup', 'browser', {
    runner: 'playwright',
    project: 'chromium',
    files: ['tests/e2e/production-startup.spec.ts', 'tests/e2e/startup-recovery.spec.ts'],
  }),
  proof('physical-storage-compaction-browser', 'browser', {
    runner: 'playwright',
    project: 'chromium',
    files: ['tests/e2e/storage-reclamation.spec.ts'],
  }),
  proof('conversation-viewport-presentation-contract', 'integration', {
    runner: 'vitest',
    files: [
      'tests/integration/conversation-background-fill.test.tsx',
      'tests/unit/branch-tree-view.test.tsx',
      'tests/unit/conversation-controller.test.ts',
      'tests/unit/conversation-frame-transcript-demand.test.tsx',
      'tests/unit/message-list-performance.test.tsx',
      'tests/unit/message-list-prepend-anchor.test.tsx',
      'tests/unit/message-stream-projection.test.tsx',
      'tests/unit/scroll-region.test.tsx',
      'tests/unit/transcript-work-budget.test.ts',
      'tests/unit/ui-journey-invariant-recorder.test.ts',
    ],
  }),
  proof('conversation-viewport-presentation-browser', 'browser', {
    runner: 'playwright',
    project: 'chromium',
    files: [
      'tests/e2e/branch-tree-streaming.spec.ts',
      'tests/e2e/branch-tree.spec.ts',
      'tests/e2e/reactive-storage-stress.spec.ts',
      'tests/e2e/render-window-loading.spec.ts',
      'tests/e2e/render-window-streaming.spec.ts',
      'tests/e2e/render-window.spec.ts',
      'tests/e2e/scroll.spec.ts',
      'tests/e2e/stream-retention.spec.ts',
    ],
  }),
  proof('remote-locality-browser', 'browser', {
    runner: 'playwright',
    project: 'chromium',
    files: [
      'tests/e2e/attachment-manager.spec.ts',
      'tests/e2e/concurrent-ops.spec.ts',
      'tests/e2e/full-generation-routing.spec.ts',
      'tests/e2e/reactive-storage-stress.spec.ts',
      'tests/e2e/storage-reclamation.spec.ts',
      'tests/e2e/stream-ownership-admission.spec.ts',
    ],
  }),
  proof('configuration-edit-continuity-unit', 'unit', {
    runner: 'vitest',
    files: [
      'tests/unit/param-form.test.tsx',
      'tests/unit/prompt-preset-editor.test.tsx',
      'tests/unit/router.test.ts',
      'tests/unit/workspace-runtime-resource-manifest.test.ts',
    ],
  }),
  proof('configuration-edit-continuity-chromium', 'browser', {
    runner: 'playwright',
    project: 'chromium',
    files: ['tests/e2e/system-prompt.spec.ts'],
  }),
  proof('configuration-edit-continuity-firefox', 'browser', {
    runner: 'playwright',
    project: 'firefox',
    files: ['tests/e2e/system-prompt.spec.ts'],
  }),
  proof('destination-frame-budget-contract', 'integration', {
    runner: 'vitest',
    files: [
      'tests/integration/conversation-background-fill.test.tsx',
      'tests/unit/generation-prompt-material.test.ts',
      'tests/unit/test-evidence-audit.test.ts',
      'tests/unit/transcript-work-budget.test.ts',
    ],
  }),
  proof('destination-frame-budget-browser', 'browser', {
    runner: 'playwright',
    project: 'chromium',
    files: ['tests/e2e/render-window-loading.spec.ts'],
  }),
  proof('destination-frame-budget-scale-browser', 'browser', {
    runner: 'playwright',
    project: 'chromium-large-workspace',
    files: ['tests/e2e/large-workspace-startup.spec.ts'],
  }),
  proof('terminal-presentation-handoff-contract', 'integration', {
    runner: 'vitest',
    files: [
      'tests/integration/generation-lifecycle-contract.test.ts',
      'tests/unit/attempt-controller.test.ts',
      'tests/unit/attempt-terminalization.test.ts',
      'tests/unit/branch-tree-inspector.test.tsx',
      'tests/unit/broadcast.test.ts',
      'tests/unit/conversation-committed-effect.test.ts',
      'tests/unit/conversation-controller.test.ts',
      'tests/unit/message-header.test.tsx',
      'tests/unit/message-stream-projection.test.tsx',
      'tests/unit/stream-overflow.test.tsx',
      'tests/unit/ui-journey-invariant-recorder.test.ts',
      'tests/unit/workspace-commit-delivery.test.ts',
    ],
  }),
  proof('terminal-presentation-handoff-browser', 'browser', {
    runner: 'playwright',
    project: 'chromium',
    files: [
      'tests/e2e/branch-tree-streaming.spec.ts',
      'tests/e2e/concurrent-ops.spec.ts',
      'tests/e2e/send-flow.spec.ts',
    ],
  }),
  proof('send-critical-path-browser', 'performance', {
    runner: 'playwright',
    project: 'chromium-send-performance',
    files: ['tests/e2e/send-performance.spec.ts'],
  }),
  proof('production-coordination', 'static', {
    runner: 'node',
    argv: ['scripts/audit-production-coordination.mjs'],
  }),
  proof('protocol-contracts', 'static', {
    runner: 'node',
    argv: PROTOCOL_CONTRACT_STAGE.argv.slice(1),
  }),
  proof('protocol-contracts-contract', 'unit', {
    runner: 'vitest',
    files: [
      'tests/unit/configuration-protocol-audit.test.ts',
      'tests/unit/durable-command-pipeline-audit.test.ts',
      'tests/unit/production-discriminated-union-audit.test.ts',
      'tests/unit/production-protocol-audit.test.ts',
      'tests/unit/protocol-contract-fact-bundle.test.ts',
      'tests/unit/tab-cross-tab-locality-audit.test.ts',
    ],
  }),
  proof('test-runtime-isolation', 'static', {
    runner: 'node',
    argv: ['scripts/audit-test-runtime-isolation.mjs'],
  }),
  proof('test-evidence-architecture', 'unit', {
    runner: 'vitest',
    files: [
      'tests/unit/architecture-inventory-closure-audit.test.ts',
      'tests/unit/e2e-runtime-boundary.test.ts',
      'tests/unit/interaction-capability-audit.test.ts',
      'tests/unit/test-evidence-audit.test.ts',
      'tests/unit/verification-assurance-audit.test.ts',
    ],
  }),
  proof('verification-impact-planner', 'unit', {
    runner: 'vitest',
    files: [
      'tests/unit/local-module-graph.test.ts',
      'tests/unit/verification-git-comparison.test.ts',
      'tests/unit/verification-impact-plan.test.ts',
    ],
  }),
  proof('verification-runner', 'unit', {
    runner: 'vitest',
    files: [
      'tests/unit/architecture-inventory-closure-audit.test.ts',
      'tests/unit/e2e-runtime-boundary.test.ts',
      'tests/unit/verification-assurance-audit.test.ts',
      'tests/unit/verification-runner.test.ts',
    ],
  }),
  proof('verification-candidate-execution', 'unit', {
    runner: 'vitest',
    files: [
      'tests/unit/launch-slice-verification.test.ts',
      'tests/unit/run-checkpoint-verification.test.ts',
      'tests/unit/run-slice-verification.test.ts',
      'tests/unit/verification-candidate-workspace.test.ts',
      'tests/unit/verification-dependency-image.test.ts',
      'tests/unit/verification-process-lease.test.ts',
    ],
  }),
  proof('test-compiler-cohort', 'unit', {
    runner: 'vitest',
    files: [
      'tests/unit/legacy-test-migration-ledger.test.ts',
      'tests/unit/run-slice-verification.test.ts',
      'tests/unit/verification-candidate-workspace.test.ts',
    ],
  }),
  proof('current-wave-ownership', 'static', {
    runner: 'node',
    argv: ['scripts/audit-current-wave.mjs'],
  }),
  proof('e2e-browser-storage-ownership', 'static', {
    runner: 'node',
    argv: ['scripts/audit-e2e-browser-storage.mjs'],
  }),
])

export const VERIFICATION_OBLIGATIONS = Object.freeze([
  obligation(
    'configuration-edit-continuity',
    [
      'src/app/router.ts',
      'src/store/conversation-route-owner.ts',
      'src/store/workspace-runtime.ts',
      'src/ui/settings/ChatModelPanel.tsx',
      'src/ui/settings/PromptPresetEditor.tsx',
    ],
    [
      'configuration-edit-continuity-unit',
      'configuration-edit-continuity-chromium',
      'configuration-edit-continuity-firefox',
    ],
  ),
  obligation(
    'workspace-capability-activation-lifecycle',
    [
      'src/app/WorkspaceBootstrap.tsx',
      'src/main.tsx',
      'src/store/active-branch-fork-storage.ts',
      'src/store/attachment-catalog-workspace.ts',
      'src/store/attempt-workspace.ts',
      'src/store/broadcast.ts',
      'src/store/browser-workspace-bootstrap-authority.ts',
      'src/store/browser-workspace-catchup-journal.ts',
      'src/store/browser-workspace-compaction.ts',
      'src/store/browser-workspace-current-probe.ts',
      'src/store/browser-workspace-database-cleanup.ts',
      'src/store/browser-workspace-database-control.ts',
      'src/store/browser-workspace-lifecycle.ts',
      'src/store/browser-workspace-replacement-runner.ts',
      'src/store/browser-workspace-schema-v97.ts',
      'src/store/browser-workspace-slot-coordination.ts',
      'src/store/browser-workspace-startup-repair.ts',
      'src/store/byte-owner-mutation.ts',
      'src/store/chat-row-transition.ts',
      'src/store/chat-storage-codec.ts',
      'src/store/configuration-model-resolution-capability.ts',
      'src/store/configuration-workspace.ts',
      'src/store/conversation-workspace.ts',
      'src/store/db.ts',
      'src/store/generated-output-localization-capability.ts',
      'src/store/generated-output-localization-runtime.ts',
      'src/store/locks.ts',
      'src/store/mounted-projection-lifecycle.ts',
      'src/store/semantic-operation-capability.ts',
      'src/store/tab-catalog-session.ts',
      'src/store/storage-compaction-state.ts',
      'src/store/storage-maintenance-runtime.ts',
      'src/store/stream-leases.ts',
      'src/store/stream-recovery.ts',
      'src/store/transaction-activity.ts',
      'src/store/transaction-order.ts',
      'src/store/workspace-runtime-control.ts',
      'src/store/workspace-runtime.ts',
      'scripts/audit-production-protocol.mjs',
      'scripts/audit-protocol-contracts.mjs',
      'scripts/production-protocol-fact-bundle.mjs',
      'scripts/protocol-contract-descriptor.mjs',
    ],
    [
      'workspace-runtime-resources',
      'stream-recovery-lifecycle',
      'broadcast-lifecycle',
      'browser-workspace-lifecycle-contract',
      'browser-workspace-production-startup',
      'physical-storage-compaction-browser',
      'production-coordination',
      'protocol-contracts',
      'protocol-contracts-contract',
      'test-runtime-isolation',
      'e2e-browser-storage-ownership',
    ],
    'open',
  ),
  obligation(
    'wave-a-cut-5-conversation-viewport-presentation',
    [
      'src/app/Shell.tsx',
      'src/hooks/useActiveBranchFrame.ts',
      'src/store/conversation-controller.ts',
      'src/store/presentation-contracts.ts',
      'src/store/transcript-window.ts',
      'src/ui/chat/BranchTreeView.tsx',
      'src/ui/chat/MessageList.tsx',
      'src/ui/chat/ScrollRegion.tsx',
    ],
    [
      'conversation-viewport-presentation-contract',
      'conversation-viewport-presentation-browser',
      'destination-frame-budget-contract',
      'destination-frame-budget-browser',
      'destination-frame-budget-scale-browser',
    ],
    'open',
  ),
  obligation(
    'wave-a-tab-cross-tab-locality',
    [
      ...Object.keys(PUBLICATION_CONSUMER_FILES),
      'src/store/workspace-effect-hub.ts',
      'src/store/workspace-protocol.ts',
      'scripts/audit-tab-cross-tab-locality.mjs',
      'scripts/tab-cross-tab-locality-inventory.mjs',
    ],
    ['protocol-contracts-contract', 'remote-locality-browser'],
    'open',
  ),
  obligation(
    'wave-a-cut-6-terminal-presentation-handoff',
    [
      'src/hooks/useMessageStreamProjection.ts',
      'src/store/attempt-controller.ts',
      'src/store/attempt-terminalization.ts',
      'src/store/attempt-workspace.ts',
      'src/store/browser-repo.ts',
      'src/store/conversation-controller.ts',
      'src/store/conversation-repository-adapter.ts',
      'src/store/generation-engine.ts',
      'src/store/presentation-contracts.ts',
      'src/store/stream-recovery.ts',
      'src/store/workspace-change-boundary.ts',
      'src/store/workspace-effect-hub.ts',
      'src/store/workspace-protocol.ts',
      'src/store/workspace-repository.ts',
      'src/ui/chat/BranchTreeInspector.tsx',
      'src/ui/chat/Message.tsx',
      'src/ui/chat/MessageStreamOverflow.tsx',
    ],
    [
      'terminal-presentation-handoff-contract',
      'terminal-presentation-handoff-browser',
      'send-critical-path-browser',
    ],
    'open',
  ),
  obligation(
    'verification-impact-selection',
    [
      'scripts/local-module-graph.d.mts',
      'scripts/local-module-graph.mjs',
      'scripts/audit-current-wave.mjs',
      'scripts/current-wave-manifest.mjs',
      'scripts/audit-test-runtime-isolation.mjs',
      'scripts/plan-slice-verification.d.mts',
      'scripts/plan-slice-verification.mjs',
      'scripts/verification-candidate-admission.d.mts',
      'scripts/verification-candidate-admission.mjs',
      'scripts/verification-candidate-execution.d.mts',
      'scripts/verification-candidate-execution.mjs',
      'scripts/verification-candidate-preparation.d.mts',
      'scripts/verification-candidate-preparation.mjs',
      'scripts/verification-candidate-workspace.d.mts',
      'scripts/verification-candidate-workspace.mjs',
      'scripts/verification-dependency-image.d.mts',
      'scripts/verification-dependency-image.mjs',
      'scripts/verification-process-lease.d.mts',
      'scripts/verification-process-lease.mjs',
      'scripts/verification-process-execution.d.mts',
      'scripts/verification-process-execution.mjs',
      'scripts/verification-git-comparison.d.mts',
      'scripts/verification-git-comparison.mjs',
      'scripts/verification-snapshot-schema.d.mts',
      'scripts/verification-snapshot-schema.mjs',
      'scripts/verification-slice-workspace.d.mts',
      'scripts/verification-slice-workspace.mjs',
      'scripts/test-evidence-inventory.d.mts',
      'scripts/test-evidence-inventory.mjs',
      'scripts/test-evidence-manifest.d.mts',
      'scripts/test-evidence-manifest.mjs',
      'scripts/test-compiler-cohort.d.mts',
      'scripts/test-compiler-cohort.mjs',
      'scripts/verification-impact-plan.d.mts',
      'scripts/verification-impact-plan.mjs',
      'scripts/verification-obligation-manifest.d.mts',
      'scripts/verification-obligation-manifest.mjs',
    ],
    [
      'current-wave-ownership',
      'test-compiler-cohort',
      'test-evidence-architecture',
      'test-runtime-isolation',
      'verification-impact-planner',
      'verification-candidate-execution',
    ],
    'open',
  ),
  obligation(
    'verification-runtime-cost-observation',
    [
      'scripts/audit-configuration-protocol.mjs',
      'scripts/audit-durable-command-pipeline.mjs',
      'scripts/audit-production-discriminated-unions.mjs',
      'scripts/audit-production-protocol.mjs',
      'scripts/audit-protocol-contracts.mjs',
      'scripts/audit-protocol-stages.mjs',
      'scripts/audit-tab-cross-tab-locality.mjs',
      'scripts/production-protocol-fact-bundle.mjs',
      'scripts/production-discriminated-union-inventory.mjs',
      'scripts/production-module-inventory.json',
      'scripts/production-typescript-source.mjs',
      'scripts/local-module-graph.d.mts',
      'scripts/local-module-graph.mjs',
      'scripts/protocol-contract-descriptor.mjs',
      'scripts/protocol-contract-fingerprint.d.mts',
      'scripts/protocol-contract-fingerprint.mjs',
      'scripts/run-verification.d.mts',
      'scripts/run-verification.mjs',
      'scripts/tab-cross-tab-locality-inventory.mjs',
      'scripts/test-compiler-cohort.d.mts',
      'scripts/test-compiler-cohort.mjs',
      'scripts/verification-candidate-workspace.d.mts',
      'scripts/verification-candidate-workspace.mjs',
      'scripts/verification-dependency-image.d.mts',
      'scripts/verification-dependency-image.mjs',
      'scripts/verification-process-lease.d.mts',
      'scripts/verification-process-lease.mjs',
    ],
    ['protocol-contracts', 'protocol-contracts-contract', 'verification-runner'],
    'open',
  ),
  obligation(
    'verification-candidate-execution',
    [
      'scripts/run-ci-verification.mjs',
      'scripts/run-checkpoint-verification.d.mts',
      'scripts/run-checkpoint-verification.mjs',
      'scripts/plan-slice-verification.d.mts',
      'scripts/plan-slice-verification.mjs',
      'scripts/launch-slice-verification.d.mts',
      'scripts/launch-slice-verification.mjs',
      'scripts/run-slice-verification.d.mts',
      'scripts/run-slice-verification.mjs',
      'scripts/run-verification.d.mts',
      'scripts/run-verification.mjs',
      'scripts/verification-candidate-execution.d.mts',
      'scripts/verification-candidate-execution.mjs',
      'scripts/verification-candidate-preparation.d.mts',
      'scripts/verification-candidate-preparation.mjs',
      'scripts/verification-candidate-workspace.d.mts',
      'scripts/verification-candidate-workspace.mjs',
      'scripts/verification-dependency-image.d.mts',
      'scripts/verification-dependency-image.mjs',
      'scripts/verification-process-lease.d.mts',
      'scripts/verification-process-lease.mjs',
      'scripts/verification-process-execution.d.mts',
      'scripts/verification-process-execution.mjs',
      'scripts/verification-slice-workspace.d.mts',
      'scripts/verification-slice-workspace.mjs',
    ],
    ['verification-candidate-execution'],
    'open',
  ),
])

const VERIFICATION_FIXED_GLOBAL_INPUTS = Object.freeze([
  '.dependency-cruiser.cjs',
  '.github/workflows/verify.yml',
  '.gitignore',
  'biome.json',
  'eslint.config.js',
  'index.html',
  'jscpd.config.json',
  'jscpd.production.json',
  'knip.json',
  'knip.production.json',
  'playwright.config.ts',
  'tsconfig.app.json',
  'tsconfig.json',
  'tsconfig.node.json',
  'tsconfig.test.json',
  'vite.config.ts',
])

export function verificationGlobalInputPaths(options = {}) {
  const inputs = new Set([
    ...VERIFICATION_FIXED_GLOBAL_INPUTS,
    ...VERIFICATION_DEPENDENCY_RECIPE_FILES,
  ])
  if (options.root) {
    for (const path of verificationDependencyRecipeInputPaths(options.root)) inputs.add(path)
  }
  for (const path of options.allPaths ?? []) {
    if (path.startsWith('patches/')) inputs.add(path)
    if (
      path.startsWith('scripts/') ||
      path.startsWith('src/styles/') ||
      path.startsWith('tests/helpers/') ||
      path === 'tests/setup.ts' ||
      /^tests\/e2e\/[^/]+\.setup\.ts$/u.test(path) ||
      path.startsWith('tools/')
    ) {
      inputs.add(path)
    }
  }
  return Object.freeze([...inputs].sort(compareText))
}

export const VERIFICATION_EXPLICIT_MODULE_EDGES = Object.freeze([
  edge('scripts/audit-architecture-coverage.mjs', 'scripts/architecture-coverage-manifest.mjs'),
  edge(
    'scripts/audit-architecture-inventory-closure.mjs',
    'scripts/architecture-inventory-closure-manifest.mjs',
  ),
  edge(
    'scripts/audit-hidden-tab-visual-continuity.mjs',
    'scripts/hidden-tab-visual-continuity-inventory.mjs',
  ),
  edge(
    'scripts/audit-production-time-semantics.mjs',
    'scripts/production-time-semantics-inventory.mjs',
  ),
  edge('scripts/audit-scroll-continuity.mjs', 'scripts/scroll-continuity-inventory.mjs'),
  edge('scripts/audit-startup-readiness.mjs', 'scripts/startup-readiness-inventory.mjs'),
  edge(
    'scripts/audit-storage-ownership-reclamation.mjs',
    'scripts/storage-ownership-reclamation-inventory.mjs',
  ),
  edge('scripts/audit-e2e-browser-storage.mjs', 'scripts/e2e-browser-storage-inventory.json'),
  ...Object.keys(DECLARED_TEST_DOMAINS)
    .filter((path) => path.startsWith('tests/e2e/'))
    .map((path) => edge('scripts/audit-e2e-browser-storage.mjs', path)),
  edge('scripts/launch-slice-verification.mjs', 'scripts/run-checkpoint-verification.mjs'),
  edge('scripts/launch-slice-verification.mjs', 'scripts/run-slice-verification.mjs'),
])

export const VERIFICATION_OPAQUE_MODULE_REFERENCE_DISPOSITIONS = Object.freeze(
  [
    'scripts/audit-architecture-coverage.mjs',
    'scripts/audit-architecture-inventory-closure.mjs',
    'scripts/audit-hidden-tab-visual-continuity.mjs',
    'scripts/audit-interaction-capabilities.mjs',
    'scripts/audit-production-coordination.mjs',
    'scripts/audit-production-time-semantics.mjs',
    'scripts/audit-production-work-memory.mjs',
    'scripts/audit-scroll-continuity.mjs',
    'scripts/audit-startup-readiness.mjs',
    'scripts/audit-storage-ownership-reclamation.mjs',
  ].map((path) =>
    Object.freeze({
      path,
      code: 'opaque-module-reference',
      expectedCount: 1,
      rationale:
        'The audit accepts one explicit external manifest/inventory override; its production default is a static or registered explicit edge.',
    }),
  ),
)

function proof(id, kind, execution) {
  return Object.freeze({ id, kind, execution: Object.freeze(execution) })
}

function obligation(id, impactModules, proofIds, status = 'covered') {
  return Object.freeze({
    id,
    status,
    impactModules: Object.freeze(impactModules),
    proofIds: Object.freeze(proofIds),
  })
}

function edge(importer, dependency) {
  return Object.freeze({
    importer,
    dependency,
    rationale: 'The default audit input is selected through a runtime file URL.',
  })
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}
