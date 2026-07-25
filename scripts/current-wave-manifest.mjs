import { TEST_COMPILER_COHORT_DESCRIPTOR } from './test-compiler-cohort.mjs'

export const currentWaveManifest = Object.freeze({
  id: 'wave-a-cut-6-runnable-snapshot',
  mode: 'coherence/gate',
  comparison: Object.freeze({
    kind: 'git-commit',
    oid: 'fa2345161009d6142235ccc55e934a9e2327730d',
  }),
  roots: Object.freeze(['src']),
  requiredFiles: Object.freeze([
    'src/core/attempt-outcome.ts',
    'src/store/workspace-protocol.ts',
    'src/store/workspace-change-boundary.ts',
    'src/store/workspace-local-evidence.ts',
    'src/store/workspace-effect-hub.ts',
    'src/store/workspace-repository.ts',
    'src/store/browser-command-mutation-journal.ts',
    'src/store/browser-repo.ts',
    'src/store/conversation-repository-adapter.ts',
    'src/store/conversation-controller.ts',
    'src/store/conversation-destination-seal.ts',
    'src/store/attempt-controller.ts',
    'src/store/attempt-terminalization.ts',
    'src/store/attempt-workspace.ts',
    'src/store/generation-attempt-runner.ts',
    'src/store/generation-admission-controller.ts',
    'src/store/generation-capability-controller.ts',
    'src/store/generation-engine.ts',
    'src/store/stream-leases.ts',
    'src/store/stream-recovery.ts',
    'src/store/conversation-command-client.ts',
    'src/store/configuration-controller.ts',
    'src/store/connection-probe-capability.ts',
    'src/store/connection-probe-contract.ts',
    'src/store/attachment-catalog-workspace.ts',
    'src/store/storage-overview-controller.ts',
    'src/store/prompt-estimate-context-controller.ts',
    'src/store/broadcast.ts',
    'src/store/workspace-runtime-control.ts',
    'src/app/router.ts',
    'src/app/conversation-actions-capability.ts',
    'src/app/Shell.tsx',
    'src/core/transcript-work-budget.ts',
    'src/store/transcript-window.ts',
    'src/store/presentation-contracts.ts',
    'src/hooks/useConversationFrame.ts',
    'src/hooks/useActiveBranchFrame.ts',
    'src/ui/chat/MessageList.tsx',
    'src/ui/chat/Message.tsx',
    'src/ui/chat/BranchTreeView.tsx',
    'src/ui/chat/BranchTreeInspector.tsx',
    'src/ui/chat/ScrollRegion.tsx',
    'src/ui/chat/ChatHeader.tsx',
    'src/core/branch-session.ts',
    'src/core/branch-tree-layout.ts',
    'src/store/browser-query-pages.ts',
    'src/store/generation-prompt-material.ts',
    'src/store/send-context.ts',
  ]),
  forbiddenFiles: Object.freeze([
    'src/store/reactive-query.ts',
    'src/store/reactive-dependencies.ts',
  ]),
  forbiddenMatches: Object.freeze([
    {
      id: 'split-message-header-delta-fact',
      file: 'src/store/workspace-protocol.ts',
      pattern: "kind: 'message-header'\\n\\s+chatId",
    },
    {
      id: 'split-message-body-version-delta-fact',
      file: 'src/store/workspace-protocol.ts',
      pattern: "kind: 'message-body-version'",
    },
    {
      id: 'generic-reactive-query-reference',
      pattern: 'reactive-query',
    },
    {
      id: 'generic-reactive-dependency-reference',
      pattern: 'reactive-dependencies',
    },
    {
      id: 'parallel-local-commit-subscription',
      pattern: 'subscribeWorkspaceLocalCommits',
    },
    {
      id: 'command-result-delta-reducer',
      pattern: 'workspaceDeltaForCommand',
    },
    {
      id: 'unordered-configuration-preference-fact',
      pattern: 'configuration-preference-value',
    },
    {
      id: 'unordered-configuration-profile-fallback-fact',
      pattern: 'configuration-profile-fallback',
    },
    {
      id: 'timer-based-broadcast-fallback',
      file: 'src/store/broadcast.ts',
      pattern: 'setInterval\\(|fallbackPoll|scheduleFallbackPoll|broadcast-fallback-poll',
    },
    {
      id: 'unrestricted-internal-mutation-evidence',
      pattern: 'recordBrowserCommandInternalMutationEvidence',
    },
    {
      id: 'raw-repository-query-runtime-owner',
      pattern: 'repository-queries',
    },
    {
      id: 'generation-finalizer-full-path-copy',
      file: 'src/store/browser-repo.ts',
      pattern: 'exactPathHeaders: \\[\\.\\.\\.value\\.planning\\.headers',
    },
    {
      id: 'controller-full-path-selection-reduction',
      file: 'src/store/conversation-controller.ts',
      pattern: 'destination\\.proof\\.pathHeaders',
    },
    {
      id: 'controller-selection-authority-ledger',
      file: 'src/store/conversation-controller.ts',
      pattern: 'ConversationSelectionAuthorityLedger|authority\\.changed',
    },
    {
      id: 'parallel-sealed-selection-admission',
      file: 'src/store/conversation-controller.ts',
      pattern: 'private admitAuthoritativeSealedSelectionFrame\\(',
    },
    {
      id: 'canonical-attempt-remains-ui-active',
      file: 'src/store/generation-engine.ts',
      pattern: "phase: 'canonical'",
    },
    {
      id: 'removed-finalize-before-dispatch-command',
      pattern: 'attempt\\.finalize-before-dispatch',
    },
    {
      id: 'generic-stream-writer-release-mode',
      file: 'src/store/stream-leases.ts',
      pattern: 'mode:\\s*[\'"]release[\'"]',
    },
    {
      id: 'recovery-bypasses-terminal-custodian',
      file: 'src/store/stream-recovery.ts',
      pattern:
        'kind:\\s*[\'"](?:attempt\\.(?:seal-terminal|finalize)|generation\\.post-commit-metadata|stream\\.finish-cleanup)[\'"]',
    },
    {
      id: 'outgoing-loose-presentation-names',
      pattern:
        '\\b(?:visibleExact|presentationBindingReady|revealClaimReady|revealBySurface|activeBranchLeafId|activeSurfaceTarget)\\b',
    },
    {
      id: 'shell-reconstructs-presentation-readiness',
      file: 'src/app/Shell.tsx',
      pattern:
        'activePresentation\\?\\.visible\\s*===|activeSurfaceTarget\\.binding\\.(?:currency|reveal)',
    },
    {
      id: 'loose-transcript-paint-props',
      file: 'src/ui/chat/MessageList.tsx',
      pattern:
        'interface MessageListProps \\{[^}]*\\n\\s+(?:branchSnapshot|branchSpine|activePath)\\??:',
    },
    {
      id: 'loose-tree-paint-props',
      file: 'src/ui/chat/BranchTreeView.tsx',
      pattern:
        'export interface BranchTreeViewProps \\{[^}]*\\n\\s+(?:projection|acceptedPath|headerById|changedHeaderKeys)\\??:',
    },
    {
      id: 'shell-passes-loose-presentation-props',
      file: 'src/app/Shell.tsx',
      pattern:
        '(?:branchSnapshot|branchSpine|activePath|projection|acceptedPath|headerById|changedHeaderKeys)=\\{',
    },
    {
      id: 'message-list-parallel-presentation-subscription',
      file: 'src/ui/chat/MessageList.tsx',
      pattern:
        '\\b(?:useConversationSnapshot|useConversationFrame|useAttemptsForChat|useAttemptTargetSnapshot)\\s*\\(',
    },
    {
      id: 'message-parallel-presentation-subscription',
      file: 'src/ui/chat/Message.tsx',
      pattern:
        '\\b(?:useConversationSnapshot|useConversationFrame|useAttemptsForChat|useAttemptTargetSnapshot)\\s*\\(',
    },
    {
      id: 'tree-parallel-presentation-subscription',
      file: 'src/ui/chat/BranchTreeView.tsx',
      pattern:
        '\\b(?:useConversationSnapshot|useConversationFrame|useAttemptsForChat|useAttemptTargetSnapshot)\\s*\\(',
    },
    {
      id: 'tree-inspector-parallel-presentation-subscription',
      file: 'src/ui/chat/BranchTreeInspector.tsx',
      pattern:
        '\\b(?:useConversationSnapshot|useConversationFrame|useAttemptsForChat|useAttemptTargetSnapshot)\\s*\\(',
    },
    {
      id: 'detached-generic-tree-action-helper',
      file: 'src/ui/chat/BranchTreeView.tsx',
      pattern: '\\brunAction\\s*\\(',
    },
    {
      id: 'repeat-high-level-active-attempt-pass',
      file: 'src/hooks/useActiveBranchFrame.ts',
      pattern: '\\b(?:activeStreams|attempts)\\.(?:filter|map|flatMap|reduce|forEach)\\s*\\(',
    },
  ]),
  requiredMatches: Object.freeze([
    {
      id: 'one-message-revision-delta-fact',
      file: 'src/store/workspace-protocol.ts',
      pattern: "kind: 'message-revision'",
      count: 1,
    },
    {
      id: 'one-conversation-construction-delta-fact',
      file: 'src/store/workspace-protocol.ts',
      pattern: "kind: 'conversation-created'",
      count: 1,
    },
    {
      id: 'one-workspace-dependency-normalizer',
      file: 'src/store/workspace-protocol.ts',
      pattern: 'export function normalizeWorkspaceDependencies\\(',
      count: 1,
    },
    {
      id: 'one-raw-change-subscription-owner',
      file: 'src/store/workspace-effect-hub.ts',
      pattern: 'attachedRepository\\.subscribeChanges\\(',
      count: 1,
    },
    {
      id: 'one-local-commit-preparation-owner',
      file: 'src/store/workspace-effect-hub.ts',
      pattern: 'export function prepareWorkspaceEffectForLocalCommit\\(',
      count: 1,
    },
    {
      id: 'one-local-commit-delivery-gateway',
      file: 'src/store/workspace-repository.ts',
      pattern: 'function deliverLocalCommit<',
      count: 1,
    },
    {
      id: 'one-physical-mutation-coverage-assertion',
      file: 'src/store/browser-repo.ts',
      pattern: 'function assertPhysicalMutationEvidenceCoverage\\(',
      count: 1,
    },
    {
      id: 'one-exhaustive-physical-storage-policy',
      file: 'src/store/physical-storage-tables.ts',
      pattern: 'export const PHYSICAL_STORAGE_POLICY = Object\\.freeze\\(',
      count: 1,
    },
    {
      id: 'one-controller-revision-admission-owner',
      file: 'src/store/conversation-controller.ts',
      pattern: 'private admitMessageRevisions\\(',
      count: 1,
    },
    {
      id: 'one-controller-append-transition-owner',
      file: 'src/store/conversation-controller.ts',
      pattern: 'private sealAppendSelectionTransition\\(',
      count: 1,
    },
    {
      id: 'one-controller-sealed-selection-admission-owner',
      file: 'src/store/conversation-controller.ts',
      pattern: 'private admitSealedSelectionFrame\\(',
      count: 1,
    },
    {
      id: 'one-broadcast-fallback-verification-resource',
      file: 'src/store/workspace-runtime-control.ts',
      pattern: "'broadcast-fallback-verification'",
      count: 1,
    },
    {
      id: 'one-terminal-receipt-type-owner',
      file: 'src/core/attempt-outcome.ts',
      pattern: 'export interface AttemptTerminalReceipt\\s*\\{',
      count: 1,
    },
    {
      id: 'terminal-receipts-require-settled-journal',
      file: 'src/core/attempt-outcome.ts',
      pattern: "readonly journalCompleteness: 'settled'",
      count: 1,
    },
    {
      id: 'one-terminal-custodian-contract',
      file: 'src/store/attempt-terminalization.ts',
      pattern: 'export interface AttemptTerminalOwner\\s*\\{',
      count: 1,
    },
    {
      id: 'one-shared-terminal-custodian-state-machine',
      file: 'src/store/attempt-terminalization.ts',
      pattern: 'export function createAttemptTerminalOwner\\(',
      count: 1,
    },
    {
      id: 'one-writer-terminal-custodian-adapter',
      file: 'src/store/attempt-terminalization.ts',
      pattern: 'export function createWriterAttemptTerminalOwner\\(',
      count: 1,
    },
    {
      id: 'one-recovery-terminal-custodian-adapter',
      file: 'src/store/attempt-terminalization.ts',
      pattern: 'export function createRecoveryAttemptTerminalOwner\\(',
      count: 1,
    },
    {
      id: 'one-terminal-decision-command',
      file: 'src/store/workspace-protocol.ts',
      pattern: "\\| \\{ kind: 'attempt\\.seal-terminal'; input: AttemptSealTerminalInput \\}",
      count: 1,
    },
    {
      id: 'one-terminal-decision-repository-dispatch',
      file: 'src/store/browser-repo.ts',
      pattern: "case 'attempt\\.seal-terminal':",
      count: 1,
    },
    {
      id: 'one-terminal-decision-repository-transaction-owner',
      file: 'src/store/browser-repo.ts',
      pattern: 'private async sealAttemptTerminal\\(',
      count: 1,
    },
    {
      id: 'one-controller-visible-binding-union',
      file: 'src/store/conversation-controller.ts',
      pattern:
        'export type ConversationVisibleSurfaceBinding =\\n\\s+\\| ConversationTranscriptSurface\\n\\s+\\| ConversationTreeSurface',
      count: 1,
    },
    {
      id: 'one-ready-target-carries-current-binding',
      file: 'src/store/conversation-controller.ts',
      pattern: "readonly kind: 'ready'\\n\\s+readonly binding: ConversationCurrentSurfaceBinding",
      count: 1,
    },
    {
      id: 'one-controller-presentation-frame-owner',
      file: 'src/store/conversation-controller.ts',
      pattern: 'private presentationFrame\\(',
      count: 1,
    },
    {
      id: 'one-central-presentation-ready-decision',
      file: 'src/store/conversation-controller.ts',
      pattern:
        "const visibleReady =\\n\\s+this\\.paintedFrame\\?\\.chat\\.id === active\\.chatId &&\\n\\s+paintedBinding\\?\\.currency === 'current' &&\\n\\s+paintedBinding\\.reveal === null",
      count: 1,
    },
    {
      id: 'one-typed-viewport-preparation-result',
      file: 'src/store/conversation-controller.ts',
      pattern:
        "export type ConversationViewportPreparation =\\n\\s+\\| \\{ readonly kind: 'prepared' \\}\\n\\s+\\| \\{ readonly kind: 'unavailable' \\}",
      count: 1,
    },
    {
      id: 'one-typed-viewport-preparation-port',
      file: 'src/store/conversation-controller.ts',
      pattern:
        'prepare\\(transition: ConversationViewportTransition\\): ConversationViewportPreparation',
      count: 1,
    },
    {
      id: 'viewport-revision-advances-only-after-preparation',
      file: 'src/store/conversation-controller.ts',
      pattern: "if \\(preparation\\.kind === 'prepared'\\)",
      count: 1,
    },
    {
      id: 'one-public-transcript-surface-type',
      file: 'src/store/presentation-contracts.ts',
      pattern: 'ConversationTranscriptSurface,',
      count: 1,
    },
    {
      id: 'one-public-tree-surface-type',
      file: 'src/store/presentation-contracts.ts',
      pattern: 'ConversationTreeSurface,',
      count: 1,
    },
    {
      id: 'one-public-visible-binding-type',
      file: 'src/store/presentation-contracts.ts',
      pattern: 'ConversationVisibleSurfaceBinding,',
      count: 1,
    },
    {
      id: 'one-public-viewport-preparation-type',
      file: 'src/store/presentation-contracts.ts',
      pattern: 'ConversationViewportPreparation,',
      count: 1,
    },
    {
      id: 'one-conversation-snapshot-hook-owner',
      file: 'src/hooks/useConversationFrame.ts',
      pattern: 'export function useConversationSnapshot\\(',
      count: 1,
    },
    {
      id: 'one-active-chat-attempt-subscription',
      file: 'src/hooks/useActiveBranchFrame.ts',
      pattern: 'const activeStreams = useAttemptExecutionsForChat\\(activeChatId\\)',
      count: 1,
    },
    {
      id: 'one-attempt-partition-owner',
      file: 'src/hooks/useActiveBranchFrame.ts',
      pattern: 'function partitionAttempts\\(',
      count: 1,
    },
    {
      id: 'one-pass-over-active-attempts',
      file: 'src/hooks/useActiveBranchFrame.ts',
      pattern: 'for \\(const attempt of attempts\\)',
      count: 1,
    },
    {
      id: 'one-transcript-binding-prop',
      file: 'src/ui/chat/MessageList.tsx',
      pattern: 'binding: ConversationTranscriptSurface',
      count: 1,
    },
    {
      id: 'one-tree-binding-prop',
      file: 'src/ui/chat/BranchTreeView.tsx',
      pattern: 'binding: ConversationTreeSurface',
      count: 1,
    },
    {
      id: 'one-tree-action-settlement-owner',
      file: 'src/ui/chat/BranchTreeView.tsx',
      pattern: 'const settleBranchTreeAction = useCallback\\(',
      count: 1,
    },
    {
      id: 'one-scroll-viewport-preparation-result',
      file: 'src/ui/chat/ScrollRegion.tsx',
      pattern: '\\) => ConversationViewportPreparation',
      count: 1,
    },
    {
      id: 'pinned-anchor-failure-is-unavailable',
      file: 'src/ui/chat/ScrollRegion.tsx',
      pattern:
        "else if \\(!capturePinnedLayoutAnchor\\(undefined, transition\\)\\) \\{\\n\\s+return \\{ kind: 'unavailable' \\}",
      count: 1,
    },
    {
      id: 'shell-observes-central-ready-state',
      file: 'src/app/Shell.tsx',
      pattern:
        'const activeSurfaceReady = activeChatId \\? activePresentation\\?\\.visibleReady === true : true',
      count: 1,
    },
    {
      id: 'one-workspace-message-material-coordinator-factory',
      file: 'src/store/generation-prompt-material.ts',
      pattern: 'export function createWorkspaceMessageMaterialCoordinator\\(',
      count: 1,
    },
    {
      id: 'one-coordinator-material-page-loop',
      file: 'src/store/generation-prompt-material.ts',
      pattern: 'for \\(const page of generationMaterialPages\\(headers\\)\\)',
      count: 1,
    },
    {
      id: 'one-generation-material-page-owner',
      file: 'src/store/generation-prompt-material.ts',
      pattern: 'export function generationMaterialPages\\(',
      count: 1,
    },
    {
      id: 'one-workspace-material-release-owner',
      file: 'src/store/generation-prompt-material.ts',
      pattern:
        "this\\.workspaceAbort\\.abort\\(new Error\\('WorkspaceMessageMaterialCoordinatorReleased'\\)\\)",
      count: 1,
    },
    {
      id: 'one-prompt-material-lease-release-owner',
      file: 'src/store/generation-prompt-material.ts',
      pattern: 'this\\.coordinator\\.removeLease\\(this\\)',
      count: 1,
    },
    {
      id: 'shell-passes-one-transcript-binding',
      file: 'src/app/Shell.tsx',
      pattern: 'binding=\\{transcriptBinding\\}',
      count: 1,
    },
    {
      id: 'shell-passes-one-tree-binding',
      file: 'src/app/Shell.tsx',
      pattern: 'binding=\\{treeBinding\\}',
      count: 1,
    },
    {
      id: 'one-painted-header-leaf-contract',
      file: 'src/ui/chat/ChatHeader.tsx',
      pattern: 'paintedBranchLeafId: MessageId \\| null \\| undefined',
      count: 1,
    },
  ]),
  sourceObligations: Object.freeze([]),
  heartbeatObligations: Object.freeze(['materialize-runnable-current-contract-snapshot']),
  costObligations: Object.freeze([
    'complete-non-fail-fast-github-equivalent-suite',
    'generic-ui-journey-and-scroll-continuity',
    'multi-tab-fake-stream-stress-and-retained-heap',
    'large-workspace-startup-chat-open-and-storage-amplification',
    'dev-preview-and-ci-parity',
  ]),
  compilerCohort: TEST_COMPILER_COHORT_DESCRIPTOR,
  costBounds: Object.freeze([
    Object.freeze({
      id: 'terminal-owner-runs-each-durable-stage-once',
      tests: Object.freeze(['tests/unit/attempt-terminalization.test.ts']),
    }),
    Object.freeze({
      id: 'sealed-terminal-boundary-bounds-recovery-replay',
      tests: Object.freeze(['tests/integration/target-recovery-kind-arbitration.test.ts']),
    }),
    Object.freeze({
      id: 'stream-runtime-retains-no-open-writer-at-disposal',
      tests: Object.freeze(['tests/unit/stream-leases.test.ts']),
    }),
    Object.freeze({
      id: 'effect-reduction-and-long-path-extension-are-prefix-stable',
      tests: Object.freeze(['tests/unit/conversation-committed-effect.test.ts']),
    }),
    Object.freeze({
      id: 'broadcast-fallback-performs-zero-idle-reads',
      tests: Object.freeze(['tests/unit/broadcast.test.ts']),
    }),
    Object.freeze({
      id: 'cold-body-deletion-retains-keys-not-body-graphs',
      tests: Object.freeze(['tests/unit/browser-command-mutation-journal.test.ts']),
    }),
    Object.freeze({
      id: 'readiness-blocks-only-the-dependent-capability',
      tests: Object.freeze([
        'tests/unit/configuration-controller.test.ts',
        'tests/unit/interaction-capability.test.ts',
        'tests/unit/composer.test.tsx',
        'tests/unit/message-actions.test.tsx',
        'tests/unit/branch-tree-inspector.test.tsx',
        'tests/unit/startup-readiness-audit.test.ts',
      ]),
    }),
    Object.freeze({
      id: 'presentation-frame-work-is-demand-bounded-and-prefix-stable',
      tests: Object.freeze([
        'tests/unit/conversation-controller.test.ts',
        'tests/unit/transcript-work-budget.test.ts',
        'tests/unit/navigation-boundary.test.ts',
        'tests/unit/branch-tree-view.test.tsx',
      ]),
    }),
    Object.freeze({
      id: 'attempt-prepare-path-claim-is-one-transaction-and-page-linear',
      tests: Object.freeze([
        'tests/unit/stream-repository.test.ts',
        'tests/unit/attempt-prepare-performance.test.ts',
      ]),
    }),
    Object.freeze({
      id: 'viewport-continuity-and-resident-work-are-demand-bounded',
      tests: Object.freeze([
        'tests/integration/conversation-background-fill.test.tsx',
        'tests/unit/message-list-performance.test.tsx',
        'tests/unit/message-list-prepend-anchor.test.tsx',
        'tests/unit/scroll-region.test.tsx',
        'tests/unit/stream-profile-evaluator.test.ts',
      ]),
    }),
  ]),
  gateObligations: Object.freeze([
    Object.freeze({
      id: 'shared-writer-and-recovery-terminal-custodian',
      tests: Object.freeze([
        'tests/unit/attempt-terminalization.test.ts',
        'tests/integration/generation-lifecycle-contract.test.ts',
        'tests/integration/target-recovery-kind-arbitration.test.ts',
      ]),
    }),
    Object.freeze({
      id: 'terminal-receipt-state-machine-and-local-projection',
      tests: Object.freeze([
        'tests/unit/attempt-controller.test.ts',
        'tests/unit/stream-leases.test.ts',
        'tests/unit/stream-repository.test.ts',
      ]),
    }),
    Object.freeze({
      id: 'physical-write-to-semantic-effect-coverage',
      tests: Object.freeze([
        'tests/unit/browser-command-mutation-journal.test.ts',
        'tests/integration/committed-write-delivery.test.ts',
      ]),
    }),
    Object.freeze({
      id: 'durable-success-survives-projection-failure',
      tests: Object.freeze([
        'tests/unit/workspace-commit-delivery.test.ts',
        'tests/unit/generation-attempt-runner.test.ts',
      ]),
    }),
    Object.freeze({
      id: 'send-regenerate-continue-identity',
      tests: Object.freeze(['tests/integration/generation-mode-contract.test.ts']),
    }),
    Object.freeze({
      id: 'two-tab-local-cursor-and-remote-fact-separation',
      tests: Object.freeze([
        'tests/unit/broadcast.test.ts',
        'tests/unit/conversation-committed-effect.test.ts',
        'tests/integration/generation-mode-contract.test.ts',
      ]),
    }),
    Object.freeze({
      id: 'sealed-controller-owned-tree-and-transcript-presentation',
      tests: Object.freeze([
        'tests/unit/conversation-controller.test.ts',
        'tests/unit/navigation-boundary.test.ts',
        'tests/unit/branch-tree-view.test.tsx',
        'tests/unit/branch-url-sync.test.tsx',
        'tests/unit/interaction-surfaces.test.tsx',
        'tests/unit/preopen-projection-safety.test.tsx',
      ]),
    }),
    Object.freeze({
      id: 'target-qualified-readiness-and-total-action-results',
      tests: Object.freeze([
        'tests/unit/configuration-controller.test.ts',
        'tests/unit/interaction-capability.test.ts',
        'tests/unit/composer.test.tsx',
        'tests/unit/message-actions.test.tsx',
        'tests/unit/branch-tree-inspector.test.tsx',
        'tests/unit/startup-readiness-audit.test.ts',
      ]),
    }),
  ]),
})
