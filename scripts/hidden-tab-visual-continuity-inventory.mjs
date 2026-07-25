export const HIDDEN_TAB_PAINTED_SURFACES = Object.freeze([
  surface(
    'profile-glyph-svg',
    'src/ui/chat/ProfileGlyph.tsx',
    "import { PersonIcon, RobotIcon } from '../icons/Icon'",
    'inline-svg',
    'Message identity and the painted glyph node remain stable across resource recycling.',
  ),
  surface(
    'connection-provider-svg',
    'src/ui/header/ConnectionHeader.tsx',
    'function ConnectionKindIcon({ kind, size }: { kind: ConnectionKind; size: number })',
    'inline-svg',
    'Provider artwork has no network or module-load dependency and remains the same node.',
  ),
  surface(
    'chat-settings-static-bundle',
    'src/app/Shell.tsx',
    "import { ChatModelPanel } from '../ui/settings/ChatModelPanel'",
    'static-import',
    'An already-open chat settings panel does not wait for a code split on foreground.',
  ),
  surface(
    'global-settings-static-bundle',
    'src/app/Shell.tsx',
    "import { GlobalSettingsModal } from '../ui/settings/GlobalSettingsModal'",
    'static-import',
    'Frequently used global settings remain resident with the shell.',
  ),
  surface(
    'retained-model-picker',
    'src/ui/settings/ModelPicker.tsx',
    "data-presentation={retained ? 'retained' : 'current'}",
    'retained-projection',
    'The selected model, search, tabs, rows, focus, and scroll state remain painted.',
  ),
  surface(
    'retained-provider-picker',
    'src/ui/settings/ProviderPicker.tsx',
    "data-routing-presentation={retained ? 'retained' : 'current'}",
    'retained-projection',
    'Provider rows and controls remain painted while their source is rebound.',
  ),
  surface(
    'context-settings-body',
    'src/ui/settings/ContextPanel.tsx',
    '<p data-ui="helper">Waiting for prompt estimate…</p>',
    'conditional-body',
    'A valid accepted estimate and its controls remain current until an atomic replacement exists.',
  ),
  surface(
    'header-privacy-popover',
    'src/ui/chat/HeaderPrivacyBadge.tsx',
    'data-ui="header-privacy-popover"',
    'local-ui-state',
    'Background resource recycling does not close a tab-local open popover.',
  ),
])

export const HIDDEN_TAB_PRESENTATION_TRANSITIONS = Object.freeze([
  transition(
    'live-stream-projection-foreground-refresh',
    'src/hooks/useMessageStreamProjection.ts',
    "document.addEventListener('visibilitychange', requestIfVisible)",
    'stream-projection',
    'Foreground refreshes only the active stream projection and leaves the workspace attached.',
  ),
  transition(
    'scroll-foreground-geometry-reconciliation',
    'src/ui/chat/ScrollRegion.tsx',
    "if (documentVisibleRef.current) scheduleFollowReconciliation('resize')",
    'viewport-continuity',
    'Foreground reconciles geometry under the existing semantic scroll lease without replacing the viewport.',
  ),
  transition(
    'composer-draft-hide-flush',
    'src/ui/chat/composer-draft-state.ts',
    "if (document.visibilityState === 'hidden') flushPendingComposerDrafts()",
    'draft-persistence',
    'Hiding flushes the tab-local draft without detaching or replacing its owner.',
  ),
  transition(
    'message-content-visibility',
    'src/styles/messages.css',
    'content-visibility: auto;',
    'compositor-retention',
    'Chromium may discard offscreen message paint; this is measured only after DOM churn is removed.',
  ),
])

export const HIDDEN_TAB_EXISTING_PROOFS = Object.freeze([
  proof(
    'visibility-live-workspace-and-first-gesture',
    'tests/e2e/reactive-storage-stress.spec.ts',
    "test('visibility leaves the live workspace attached and the first foreground gesture exact'",
    'browser',
    'Proves live attachment, stable shell/transcript identity, and exact first synthetic-foreground gesture.',
  ),
  proof(
    'conversation-exact-paint-retention',
    'tests/unit/conversation-controller.test.ts',
    "it('keeps exact paint current across a same-fence projection-source rebind'",
    'controller',
    'Proves same-fence source replacement retains an exact current projection.',
  ),
  proof(
    'privacy-popover-retention',
    'tests/unit/privacy-policies.test.tsx',
    "it('keeps an open privacy disclosure mounted across retained routing'",
    'component',
    'Proves a retained routing frame does not discard tab-local disclosure identity.',
  ),
  proof(
    'provider-row-retention',
    'tests/unit/privacy-policies.test.tsx',
    "it('keeps retained provider rows mounted and inert instead of flashing Loading'",
    'component',
    'Proves provider rows remain mounted while explicitly accepting an inert interval.',
  ),
  proof(
    'connection-header-retention',
    'tests/unit/connection-header.test.tsx',
    "it('keeps the previous header state visible while the next profile load is still resolving'",
    'component',
    'Covers a profile target transition, not same-target hidden-tab node identity.',
  ),
  proof(
    'active-stream-reload-first-gesture',
    'tests/e2e/reactive-storage-stress.spec.ts',
    "test('reload during an active stream keeps pure UI controls actionable within bounded latency while opening is pending'",
    'browser',
    'Proves active-stream reload leaves independent shell controls actionable within a bounded interval while workspace opening remains pending.',
  ),
  proof(
    'headed-native-visibility-project',
    'playwright.config.ts',
    "name: 'chromium-headed-visibility'",
    'browser',
    'Runs the existing visibility journey in a real headed Chromium page with one worker and native background-renderer behavior.',
    ['headless: false', 'testMatch: /reactive-storage-stress\\.spec\\.ts$/u'],
  ),
  proof(
    'headed-native-visibility-xvfb',
    'package.json',
    'E2E_HEADED_VISIBILITY=1 xvfb-run --auto-servernum',
    'browser',
    'Provides a deterministic display server while a real window manager owns native activation.',
    ['node scripts/run-headed-visibility.mjs', '-screen 0 1440x1000x24'],
  ),
  proof(
    'headed-native-visibility-checkpoint-stage',
    'scripts/run-verification.mjs',
    "stage(\n    'headed-hidden-tab-visual-continuity',",
    'browser',
    'Makes the native visibility journey a blocking immutable-candidate capability.',
    ["['pnpm', 'run', 'e2e:headed-visibility']"],
  ),
  proof(
    'first-foreground-paint-fingerprints',
    'tests/e2e/reactive-storage-stress.spec.ts',
    'const foregroundPaint = await readPaintedSurfaceFingerprints(page)',
    'visual',
    'Compares provider, role-glyph and active-settings markup exactly and decoded pixels within renderer-noise bounds before hide and on the first foreground turn in every explicit palette.',
    [
      'async function requireNativeVisibilityPair(foreground: Page, background: Page)',
      'expect(foregroundPaint).toEqual(baselinePaint)',
      'expect(diff.meanChannelDelta).toBeLessThanOrEqual(2)',
      'expect(diff.changedPixelRatio).toBeLessThanOrEqual(0.25)',
      'expect(gesture.clickAt - gesture.visibleAt).toBeLessThanOrEqual(250)',
      'await testInfo.attach(`baseline-${theme}`',
      'await testInfo.attach(`first-foreground-${theme}`',
    ],
  ),
])

export const HIDDEN_TAB_VISUAL_CONTINUITY_GAPS = Object.freeze([])

export const HIDDEN_TAB_VISUAL_CONTINUITY_ACCEPTANCE = Object.freeze([
  acceptance(
    'paint-independent-of-resource-readiness',
    ['controller', 'component', 'browser'],
    'Same-fence source release and reattach leave accepted DOM, local UI state, and visual values unchanged until an atomic replacement is accepted.',
  ),
  acceptance(
    'capability-scoped-interaction',
    ['component', 'browser'],
    'Shell and tab-local controls remain interactive; only the invoked command acquires its required capability.',
  ),
  acceptance(
    'first-gesture-preserved',
    ['browser', 'timing'],
    'The first foreground pointer or keyboard gesture is processed exactly once without an actionability wait.',
  ),
  acceptance(
    'stateful-ui-continuity',
    ['component', 'browser'],
    'Open panel, tab, popover, edit, focus, selection, and scroll state survive resource recycling.',
  ),
  acceptance(
    'real-tab-first-frame-continuity',
    ['browser', 'visual'],
    'A real tab switch produces no blank, placeholder, or remounted frame in provider icons, profile glyphs, or settings.',
  ),
  acceptance(
    'active-stream-independent',
    ['browser', 'multi-tab'],
    'An active stream remains independently owned and stop/status controls are immediately actionable after reload or foreground.',
  ),
  acceptance(
    'bounded-retained-presentation',
    ['memory', 'performance'],
    'Continuity retains only the bounded painted projection and local UI state, not cold bodies or repository resources.',
  ),
])

function surface(id, path, locator, implementation, targetInvariant) {
  return Object.freeze({ id, path, locator, implementation, targetInvariant })
}

function transition(id, path, locator, owner, effect) {
  return Object.freeze({ id, path, locator, owner, effect })
}

function proof(id, path, locator, kind, limit, requiredLocators = []) {
  return Object.freeze({
    id,
    path,
    locator,
    kind,
    limit,
    requiredLocators: Object.freeze(requiredLocators),
  })
}

function gap(id, path, locator, rationale) {
  return Object.freeze({ id, path, locator, rationale })
}

function acceptance(id, proofKinds, invariant) {
  return Object.freeze({ id, proofKinds: Object.freeze(proofKinds), invariant })
}
