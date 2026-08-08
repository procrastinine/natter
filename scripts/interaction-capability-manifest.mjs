export const INTERACTION_SCOPE_KINDS = Object.freeze([
  'tab-local',
  'durable-workspace',
  'mixed-tab-and-durable',
  'browser-external',
  'unknown',
])

export const INTERACTION_EFFECT_KINDS = Object.freeze([
  'command',
  'navigation',
  'query',
  'visual',
  'browser-io',
  'unknown',
])

export const INTERACTION_REVIEW_BASELINE = Object.freeze({
  schemaVersion: 5,
  exactSiteCount: 845,
  sourceCount: 59,
  exactSiteIdSha256: '8ba87a7027512c0e0fcdf18850f88e8be7a8f9ed3bee30f7f0c4a4f130646de9',
  sourceFactSha256: 'c5555f366a798c173cabe2a2950fd05a7a7c579cc3f8681cfc4508a883862b47',
  presentationDefinitionSha256: '149f270b61a932f0ff2c6459725df46c9abc50fc7b9e793436e6b388d0a3b767',
  interactionOutcomeSha256: 'b638103c2140ad72628469c25fc7c756d891ae6e01a59465e78377e728709dc2',
  disposition:
    'Any source interaction or analyzed handler-fact drift reopens classification review before the baseline may be updated.',
})

export const INTERACTION_CLASSIFICATION_RULES = Object.freeze([
  rule(
    'recovery-bootstrap',
    { paths: ['src/app/WorkspaceBootstrap.tsx'] },
    'recovery-bootstrap',
    null,
    [],
    true,
    'Bootstrap recovery controls must remain available without the Shell or a workspace session.',
  ),
  rule(
    'application-shell',
    { pathPrefixes: ['src/app/'], excludedPaths: ['src/app/WorkspaceBootstrap.tsx'] },
    'application-shell',
    null,
    [],
    true,
    'Shell interactions own tab routes and presentation; durable and generation facets are classified from exact handler facts.',
  ),
  rule(
    'attachments',
    { pathPrefixes: ['src/ui/attachments/'] },
    'attachments',
    'attachment-workspace',
    ['browser-io', 'command', 'query'],
    true,
    'Attachment UI uses attachment capability only for query, command, or browser-I/O effects; local disclosure remains tab-only.',
  ),
  rule(
    'branch-tree',
    {
      pathPrefixes: [
        'src/ui/chat/BranchControls',
        'src/ui/chat/BranchTree',
        'src/ui/chat/TreeDensityToggle',
      ],
    },
    'branch-tree',
    'conversation-projection',
    ['browser-io', 'command', 'navigation', 'query'],
    true,
    'Branch navigation and mutations use the conversation projection, while geometry and hover gestures stay tab-local.',
  ),
  rule(
    'transcript-and-composer',
    {
      pathPrefixes: ['src/ui/chat/'],
      excludedPathPrefixes: [
        'src/ui/chat/BranchControls',
        'src/ui/chat/BranchTree',
        'src/ui/chat/TreeDensityToggle',
      ],
    },
    'transcript-and-composer',
    'conversation-projection',
    ['browser-io', 'command', 'query'],
    true,
    'Transcript commands and reads use the conversation projection; already-painted editing, focus, and scrolling stay tab-local.',
  ),
  rule(
    'configuration',
    { pathPrefixes: ['src/ui/header/', 'src/ui/settings/'] },
    'configuration',
    'configuration-projection',
    ['browser-io', 'command', 'query'],
    false,
    'Configuration reads and writes use the configuration projection; open panels, tabs, inputs, and disclosures remain tab-local.',
  ),
  rule(
    'catalog',
    { pathPrefixes: ['src/ui/sidebar/'] },
    'catalog',
    'catalog-projection',
    ['browser-io', 'command', 'query'],
    true,
    'Catalog reads and organization writes use the catalog projection; selection, menus, and route intent remain tab-local.',
  ),
  rule(
    'storage-administration',
    { pathPrefixes: ['src/ui/storage/'] },
    'storage-administration',
    'storage-administration',
    ['browser-io', 'command', 'query'],
    true,
    'Storage queries, mutation, transfer, and reclamation use storage administration; table selection and navigation stay tab-local.',
  ),
  rule(
    'shared-presentation',
    { pathPrefixes: ['src/ui/primitives/'] },
    'shared-presentation',
    null,
    [],
    false,
    'Shared dialog and SVG primitives expose presentation contracts and inherit capability requirements from their caller.',
  ),
])

export const INTERACTION_CLASSIFICATION_EXCEPTIONS = Object.freeze([
  ...localScrollExceptions([
    [
      'attachment-draft-remove',
      'src/ui/attachments/AttachmentDraftTray.tsx#AttachmentDraftTray|jsx-handler|onClick|IconButton|fnv1a32:0b9f4ddc:1',
    ],
    [
      'composer-draft-attachment-remove',
      'src/ui/chat/Composer.tsx#Composer|jsx-handler|onRemove|AttachmentDraftTray|fnv1a32:5246b530:1',
    ],
    [
      'inline-editor-draft-attachment-remove',
      'src/ui/chat/InlineEditor.tsx#InlineEditor|jsx-handler|onRemove|AttachmentDraftTray|fnv1a32:5246b530:1',
    ],
    [
      'message-list-open-insert',
      'src/ui/chat/MessageList.tsx#<module>|jsx-handler|onInsert|Message|fnv1a32:d3ffcde4:1',
    ],
    [
      'message-action-open-insert-before',
      'src/ui/chat/MessageActions.tsx#MessageEditTreeActions|jsx-handler|onClick|Button|fnv1a32:e9e1a371:1',
    ],
    [
      'message-action-open-insert-after',
      'src/ui/chat/MessageActions.tsx#MessageEditTreeActions|jsx-handler|onClick|Button|fnv1a32:cf6d6a48:1',
    ],
    [
      'message-action-open-insert-sibling',
      'src/ui/chat/MessageActions.tsx#MessageEditTreeActions|jsx-handler|onClick|Button|fnv1a32:c73fd070:1',
    ],
  ]),
  ...localSettingsExceptions([
    [
      'connection-editor-open-delete-confirmation',
      'src/ui/header/ConnectionHeader.tsx#ConnectionHeader|jsx-handler|onDelete|ConnectionEditor|fnv1a32:de9094d9:1',
    ],
    [
      'connection-viewer-open-delete-confirmation',
      'src/ui/header/ConnectionHeader.tsx#ConnectionHeader|jsx-handler|onDelete|ConnectionViewer|fnv1a32:de9094d9:1',
    ],
    [
      'connection-delete-reassignment-selection',
      'src/ui/header/ConnectionHeader.tsx#ConnectionHeader|jsx-handler|onReassignTo|ConnectionDeleteDialog|fnv1a32:fa723e69:1',
    ],
    [
      'connection-viewer-delete-button',
      'src/ui/header/ConnectionHeader.tsx#ConnectionViewer|jsx-handler|onClick|Button|fnv1a32:dd1df26e:1',
    ],
    [
      'connection-editor-delete-button',
      'src/ui/header/ConnectionHeader.tsx#ConnectionEditor|jsx-handler|onClick|Button|fnv1a32:dd1df26e:1',
    ],
    [
      'connections-settings-delete-reassignment-selection',
      'src/ui/settings/ConnectionsSettings.tsx#ConnectionsSettings|jsx-handler|onReassignTo|ConnectionDeleteDialog|fnv1a32:fa723e69:1',
    ],
  ]),
  browserPickerException(
    'storage-restore-upload-picker',
    'src/ui/storage/StorageView.tsx#AttachmentManager|jsx-handler|onRestoreUpload|AttachmentDetails|fnv1a32:837b8688:1',
  ),
  browserPickerException(
    'storage-replace-upload-picker',
    'src/ui/storage/StorageView.tsx#AttachmentManager|jsx-handler|onReplaceUpload|AttachmentDetails|fnv1a32:9c419f26:1',
  ),
])

export const INTERACTION_SCANNER_LIMITATIONS = Object.freeze([
  limitation(
    'recognized-source-scope',
    'The closed set is explicit JSX onX attributes and literal addEventListener calls in production TSX under src/app and src/ui discovered by the test-evidence scanner; JSX spread callbacks, hooks, stores, non-literal events, property assignment, observers, timers, and third-party gesture registration are outside this scanner.',
  ),
  limitation(
    'bounded-local-resolution',
    'Production handler resolution follows TypeScript-checker-resolved local callables, local useCallback/useMemo bodies, and exact local returned-object projections to depth two and at most 24 declarations; imported and runtime callback implementations are not inlined. The standalone source helper remains syntax-only for identity tests.',
  ),
  limitation(
    'static-effect-inference',
    'Effects and capabilities are reviewed static obligations derived from exact event, owner, call, attribute, and guard facts; they do not prove which runtime branch executes.',
  ),
  limitation(
    'gate-visibility',
    'Local gate discovery sees disabled, aria-disabled, inert, and readOnly attributes in the same JSX tree; component-internal gates, CSS pointer suppression, portals, and browser actionability are not inferred.',
  ),
  limitation(
    'async-return-visibility',
    'General classification records only source-visible async ownership. The presentation source contract additionally resolves checker-visible PromiseLike action flow and local or imported commit signatures, fails closed on opaque commit input, rejects detached or async commit work, and inherits total settlement only from its separately evidenced controller; opaque runtime internals remain outside proof.',
  ),
  limitation(
    'behavioral-outcome-separation',
    'A reviewed classification and a compiler-resolved total run lifecycle never become exact gesture-outcome evidence. Exact outcomes remain in their separate proof queue until exact behavioral evidence closes them.',
  ),
])

export const INTERACTION_CLASSIFICATION_CLOSURE_CRITERIA = Object.freeze([
  criterion(
    'exact-source-baseline',
    'Exact site count, source count, site-id digest, and analyzed source-fact digest match the reviewed baseline.',
  ),
  criterion(
    'one-disposition-per-site',
    'Every discovered exact site matches exactly one reviewed cluster rule and at most one explicit exact-site exception.',
  ),
  criterion(
    'complete-facets',
    'Every site has a reviewed semantic identity, cluster, scope, effects, minimum capabilities, continuity obligations, gates, and async/error-owner disposition with no unknown facet.',
  ),
  criterion(
    'global-gate-separated',
    'The aggregate Shell gate is forbidden and absent; exact local gates remain reported separately from minimum capability requirements.',
  ),
  criterion(
    'outcomes-remain-separate',
    'Classification closure does not require or imply behavioral outcome closure; source-contract proofs and all remaining missing exact outcome proofs stay enumerated separately.',
  ),
])

export const INTERACTION_CAPABILITIES = Object.freeze([
  capability(
    'bootstrap-control',
    'bootstrap-mounted',
    'Recovery, retry, reload, and reset controls must work without a running workspace.',
  ),
  capability(
    'tab-presentation',
    'bootstrap-mounted',
    'Tab-local focus, menus, disclosure, drafts, and scroll state need no repository handle.',
  ),
  capability(
    'tab-navigation',
    'bootstrap-mounted',
    'Route intent, including a background-tab first activation, is owned by the tab.',
  ),
  capability(
    'repository-read',
    'repository-readiness',
    'Cold workspace projections and detail reads require only repository read capability.',
  ),
  capability(
    'catalog-projection',
    'catalog-projection-ready',
    'Sidebar browse and search use the projected catalog surface.',
  ),
  capability(
    'configuration-projection',
    'configuration-projection-ready',
    'Connection, preset, provider, model, and global-setting controls use retained configuration projections.',
  ),
  capability(
    'conversation-projection',
    'route-presentation-ready',
    'Transcript, branch tree, message detail, and attachment views use the active conversation projection.',
  ),
  capability(
    'durable-write',
    'durable-write-ready',
    'A workspace mutation requires a transaction, writer arbitration, and publication capability.',
  ),
  capability(
    'generation-attempt',
    'attempt-control-ready',
    'Send, regenerate, continue, and abort require an independently owned generation attempt.',
  ),
  capability(
    'attachment-workspace',
    'attachment-projection-ready',
    'Attachment selection, upload, localization, and reference mutation use the attachment workspace.',
  ),
  capability(
    'storage-administration',
    'storage-administration-ready',
    'Destructive storage actions, import/export, persistence, and reclamation use storage administration.',
  ),
  capability(
    'browser-io',
    'browser-api-available',
    'Clipboard, file picker, download, media, and external-link effects use browser APIs.',
  ),
  capability(
    'unknown',
    'manual-classification-required',
    'The derived classifier cannot identify a safe capability boundary.',
  ),
])

export const INTERACTION_CONTINUITY_OBLIGATIONS = Object.freeze([
  obligation(
    'first-input-not-discarded',
    'The first user intent must either complete or enter an explicit pending state; it cannot merely wake a runtime.',
  ),
  obligation(
    'focus-continuity',
    'Focus remains on the initiating control or moves to an intentional, deterministic destination.',
  ),
  obligation(
    'scroll-continuity',
    'The interaction cannot cause a discontinuous transcript or catalog scroll jump.',
  ),
  obligation(
    'paint-continuity',
    'Already painted controls, icons, settings, and content remain painted while capability work resolves.',
  ),
  obligation(
    'unrelated-controls-remain-interactive',
    'Pending work disables only the conflicting capability, never the whole shell.',
  ),
  obligation(
    'tab-intent-isolation',
    'The interaction cannot overwrite another tab cursor, route, draft, or local selection.',
  ),
])

export const KNOWN_INTERACTION_GATES = Object.freeze([])

export const FORBIDDEN_INTERACTION_GATES = Object.freeze([
  Object.freeze({
    id: 'aggregate-workspace-running-shell-inert',
    kind: 'forbidden-inherited-global',
    path: 'src/app/Shell.tsx',
    locator: 'inert={!workspaceInteractive || undefined}',
    appliesTo: 'Every production interaction rendered beneath the Shell root.',
    architecturalDisposition:
      'resolved boundary: aggregate runtime readiness must never block unrelated tab-local and capability-local controls',
    expectedOccurrences: 0,
  }),
])

export const INTERACTION_OUTCOME_CONTRACTS = Object.freeze([
  Object.freeze({
    id: 'presentation-total-v1',
    outcome:
      'One typed presentation owner settles success, failure, cancellation, supersession, and conflicting pending work exactly once.',
    evidence: Object.freeze([
      Object.freeze({
        path: 'tests/unit/presentation-interaction-controller.test.ts',
        testLocator:
          "it('owns synchronous and asynchronous failures exactly once without rejecting settlement'",
        assertionLocator:
          "await expect(asynchronous.settled).resolves.toMatchObject({ kind: 'failed' })",
      }),
      Object.freeze({
        path: 'tests/e2e/send-flow.spec.ts',
        testLocator: "test('happy path: streamed SSE renders and persists the final row'",
        assertionLocator:
          "await expect(assistant.locator('[data-ui=\"message-body\"]')).toHaveText('Hello world')",
      }),
    ]),
  }),
  Object.freeze({
    id: 'synchronous-controlled-v1',
    outcome:
      'A synchronous controlled interaction either changes its exact local state or invokes its exact typed callback during the initiating dispatch.',
    evidence: Object.freeze([
      Object.freeze({
        path: 'tests/unit/interaction-surfaces.test.tsx',
        testLocator:
          "it('applies EditTreeToolbar cascade and exit actions to the tab-local UI store'",
        assertionLocator: 'expect(useUiStore.getState().cascadeDelete).toBe(true)',
      }),
    ]),
  }),
  Object.freeze({
    id: 'route-navigation-v1',
    outcome:
      'A route gesture is delivered through a real anchor or one synchronous tab-local route intent and swaps the exact destination surface.',
    evidence: Object.freeze([
      Object.freeze({
        path: 'tests/e2e/sidebar.spec.ts',
        testLocator: "test('clicking a chat row navigates to it and swaps the main pane'",
        assertionLocator:
          'await expect(page.locator(\'[data-ui="message"][data-role="user"]\')).toContainText(\'first\')',
      }),
    ]),
  }),
  Object.freeze({
    id: 'browser-default-io-v1',
    outcome:
      'A browser-owned file, link, clipboard, media, or download interaction retains its native delivery boundary and presents completion through the public surface.',
    evidence: Object.freeze([
      Object.freeze({
        path: 'tests/e2e/attachment-manager.spec.ts',
        testLocator:
          "test('attachment manager searches, filters, bulk deletes, and relinks through built UI'",
        assertionLocator:
          "await expect(details).toContainText('1 message · 0 draft · 1 in context')",
      }),
    ]),
  }),
  Object.freeze({
    id: 'continuous-observer-v1',
    outcome:
      'A continuous pointer, keyboard, focus, resize, or scroll observer updates only its exact retained presentation owner without dropping later input.',
    evidence: Object.freeze([
      Object.freeze({
        path: 'tests/e2e/scroll.spec.ts',
        testLocator:
          "test('streaming text keeps the scroll region in follow state; scrolling up flips to pinned with a Jump chip'",
        assertionLocator: 'await expect(jumpChip).toBeVisible()\n  await uiJourney.intent(page, {',
      }),
    ]),
  }),
])

export const INTERACTION_SOURCE_CONTRACTS = Object.freeze([
  Object.freeze({
    id: 'presentation-total-v1',
    factory: Object.freeze({
      path: 'src/store/presentation-interaction-controller.ts',
      name: 'definePresentationInteraction',
      startMember: 'PresentationInteractionController.start',
    }),
    hook: Object.freeze({
      path: 'src/hooks/usePresentationInteraction.ts',
      name: 'usePresentationInteraction',
      runMember: 'PresentationInteractionHandle.run',
    }),
    execution: Object.freeze({
      path: 'src/app/presentation-interactions.ts',
      name: 'startPresentationInteraction',
    }),
    evidence: Object.freeze([
      Object.freeze({
        path: 'tests/unit/presentation-interaction-controller.test.ts',
        testLocator:
          "it('owns synchronous and asynchronous failures exactly once without rejecting settlement'",
        assertionLocator:
          "await expect(asynchronous.settled).resolves.toMatchObject({ kind: 'failed' })",
      }),
      Object.freeze({
        path: 'tests/unit/presentation-interaction-controller.test.ts',
        testLocator: "it('replaces only the same target and suppresses a stale completion commit'",
        assertionLocator: "expect(commits).toEqual(['independent', 'current'])",
      }),
      Object.freeze({
        path: 'tests/unit/presentation-interaction-controller.test.ts',
        testLocator: "it('rejects a conflicting destructive command without invoking it'",
        assertionLocator:
          "await expect(rejected.settled).resolves.toEqual({ kind: 'rejected-pending' })",
      }),
      Object.freeze({
        path: 'tests/unit/presentation-interaction-controller.test.ts',
        testLocator: "it('isolates throwing subscribers from start and settlement'",
        assertionLocator:
          "await expect(claim.settled).resolves.toEqual({ kind: 'succeeded', value: 7 })",
      }),
      Object.freeze({
        path: 'tests/unit/presentation-interaction-controller.test.ts',
        testLocator:
          "it('releases only the mounted commit while retaining operation and failure ownership'",
        assertionLocator:
          "expect(presented).toEqual([{ message: 'Save: write failed', tone: 'danger' }])",
      }),
      Object.freeze({
        path: 'tests/unit/presentation-interaction-controller.test.ts',
        testLocator:
          "it('cancels presenter-owned work and releases its retained commit when the presenter leaves'",
        assertionLocator: "expect(controller.isPending(capability, 'picker')).toBe(false)",
      }),
      Object.freeze({
        path: 'tests/unit/presentation-interaction-controller.test.ts',
        testLocator:
          "it('removes every old-fence claim atomically and publishes once per capability'",
        assertionLocator: 'expect(publications).toBe(1)',
      }),
      Object.freeze({
        path: 'tests/unit/presentation-interaction-controller.test.ts',
        testLocator: "it('turns a throwing commit into one total failed outcome'",
        assertionLocator: "expect(controller.isPending(capability, 'row')).toBe(false)",
      }),
      Object.freeze({
        path: 'tests/unit/presentation-interaction-controller.test.ts',
        testLocator: "it('settles failure even when description and presentation ports throw'",
        assertionLocator: "expect(controller.isPending(capability, 'workspace')).toBe(false)",
      }),
      Object.freeze({
        path: 'tests/unit/presentation-interaction-controller.test.ts',
        testLocator:
          "it('cancels only the explicit claim with its typed reason and preserves reentrant replacement'",
        assertionLocator: "expect(abortReason).toBe('caller')",
      }),
      Object.freeze({
        path: 'tests/unit/presentation-interaction-controller.test.ts',
        testLocator:
          "it('keeps work owned across hook unmount and a recreated capability subscriber'",
        assertionLocator:
          "await expect(rejected?.settled).resolves.toEqual({ kind: 'rejected-pending' })",
      }),
    ]),
    disposition:
      'Compiler-resolved capability definitions carry a reviewed typed lifetime: presenter work cancels when its presenter leaves, workspace-tab work survives presenter release, and all work is atomically fenced by workspace replacement. Hook bindings, run invocations and their exact gesture closures inherit the controller total-outcome proof only when every visible async signal is owned by the run action or a local catch.',
  }),
])

export const INTERACTION_CLASSIFICATION_OVERRIDES = Object.freeze([])

function rule(
  id,
  match,
  architecturalCluster,
  projectionCapability,
  projectionEffects,
  scrollSensitive,
  rationale,
) {
  return Object.freeze({
    id,
    match: Object.freeze({
      paths: Object.freeze([...(match.paths ?? [])]),
      pathPrefixes: Object.freeze([...(match.pathPrefixes ?? [])]),
      excludedPaths: Object.freeze([...(match.excludedPaths ?? [])]),
      excludedPathPrefixes: Object.freeze([...(match.excludedPathPrefixes ?? [])]),
    }),
    architecturalCluster,
    projectionCapability,
    projectionEffects: Object.freeze([...projectionEffects]),
    scrollSensitive,
    rationale,
  })
}

function limitation(id, boundary) {
  return Object.freeze({ id, boundary })
}

function criterion(id, requirement) {
  return Object.freeze({ id, requirement })
}

function localScrollExceptions(entries) {
  return entries.map(([id, siteId]) =>
    classificationException(
      id,
      siteId,
      'tab-local',
      ['visual'],
      ['tab-presentation'],
      ['first-input-not-discarded', 'focus-continuity', 'paint-continuity', 'scroll-continuity'],
      'This exact handler only changes an in-memory editor or opens the insert UI; persistence begins at the later save or import command.',
    ),
  )
}

function localSettingsExceptions(entries) {
  return entries.map(([id, siteId]) =>
    classificationException(
      id,
      siteId,
      'tab-local',
      ['visual'],
      ['tab-presentation'],
      ['first-input-not-discarded', 'focus-continuity', 'paint-continuity'],
      'This exact handler opens the confirmation UI or changes its local reassignment choice; the confirmed delete owns the durable write.',
    ),
  )
}

function browserPickerException(id, siteId) {
  return classificationException(
    id,
    siteId,
    'browser-external',
    ['browser-io', 'visual'],
    ['browser-io', 'tab-presentation'],
    ['first-input-not-discarded', 'focus-continuity', 'paint-continuity', 'scroll-continuity'],
    'This exact handler only opens the browser file picker; storage mutation begins in the later file-change handler.',
  )
}

function classificationException(
  id,
  siteId,
  scope,
  effects,
  requiredCapabilities,
  continuityObligations,
  rationale,
) {
  return Object.freeze({
    id,
    siteId,
    scope,
    effects: Object.freeze([...effects]),
    requiredCapabilities: Object.freeze([...requiredCapabilities]),
    continuityObligations: Object.freeze([...continuityObligations]),
    errorOwnership: Object.freeze({
      owner: 'reviewed-local-handler',
      reviewDisposition: 'reviewed-static-owner',
      rationale,
    }),
    rationale,
    reviewerDisposition: 'exact-site-reviewed-exception',
  })
}

function capability(id, targetReadiness, rationale) {
  return Object.freeze({ id, targetReadiness, rationale })
}

function obligation(id, rationale) {
  return Object.freeze({ id, rationale })
}
