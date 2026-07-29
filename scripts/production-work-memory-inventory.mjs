const freezeRows = (rows) => Object.freeze(rows.map((row) => Object.freeze(row)))

export const WORK_MEMORY_EVIDENCE_LINKS = freezeRows([
  {
    id: 'persistent-branch-window-linear-predecessors',
    ownerId: 'src/core/branch-session.ts#IndexedBranchPath.windowRange',
    siteIds: ['src/core/branch-session.ts|IndexedBranchPath.windowRange|explicit-loop|for|1'],
    testPath: 'tests/unit/transcript-work-budget.test.ts',
    testLocator:
      "it('walks each predecessor once while background and geometric demand drain fixed pages'",
    assertionLocators: ['expect(measurement.predecessorLinks).toBe(path.length - 1)'],
    proof:
      'A 4,096-header mixed-cost path drains fixed indexed window pages while the explicit row counter equals path length minus one.',
  },
  {
    id: 'active-branch-wide-fork-single-enumeration',
    ownerId:
      'src/store/browser-active-branch-spine.ts#BrowserSelectionHeaderReader.newestDescendantLeafId',
    siteIds: [
      'src/store/browser-active-branch-spine.ts|BrowserSelectionHeaderReader.newestDescendantLeafId|explicit-loop|while|1',
      'src/store/browser-active-branch-spine.ts|BrowserSelectionHeaderReader.newestDescendantLeafId|await-in-traversal|await|1',
      'src/store/browser-active-branch-spine.ts|BrowserSelectionHeaderReader.newestDescendantLeafId|collection-pass|method:filter|1',
    ],
    testPath: 'tests/unit/active-branch-selection.test.ts',
    testLocator:
      "it('visits a 100k-wide unresolved subtree in linear row work with bounded retained traversal'",
    assertionLocators: [
      'expect(work.descendantRowsRead).toBe(leafCount)',
      'expect(work.peakTraversalRows).toBeLessThanOrEqual(66)',
    ],
    proof:
      'The unresolved 100,000-leaf fallback visits every descendant once through bounded pages while retaining at most 66 traversal rows.',
  },
  {
    id: 'active-branch-child-page-bounded-materialization',
    ownerId: 'src/store/browser-active-branch-spine.ts#BrowserSelectionHeaderReader.readChildPage',
    siteIds: [
      'src/store/browser-active-branch-spine.ts|BrowserSelectionHeaderReader.readChildPage|materialization|method:toArray|1',
    ],
    testPath: 'tests/unit/active-branch-selection.test.ts',
    testLocator:
      "it('visits a 100k-wide unresolved subtree in linear row work with bounded retained traversal'",
    assertionLocators: ['expect(work.peakTraversalRows).toBeLessThanOrEqual(66)'],
    proof: 'Each dependent child-page materialization remains within the 66-row traversal bound.',
  },
  {
    id: 'branch-tree-layout-near-linear-wide-fork',
    ownerId: 'src/core/branch-tree-layout.ts#layoutBranchTree',
    siteIds: [
      'src/core/branch-tree-layout.ts|layoutBranchTree|collection-pass|method:map|3',
      'src/core/branch-tree-layout.ts|layoutBranchTree|explicit-loop|for|2',
      'src/core/branch-tree-layout.ts|layoutBranchTree|explicit-loop|for|3',
      'src/core/branch-tree-layout.ts|layoutBranchTree|explicit-loop|while|1',
      'src/core/branch-tree-layout.ts|layoutBranchTree|growth|push|4',
    ],
    testPath: 'tests/unit/branch-tree-layout.test.ts',
    testLocator: "it('scales wide-fork work near linearly rather than quadratically'",
    assertionLocators: ['expect(larger.reads).toBeLessThan(smaller.reads * 2.7)'],
    proof:
      'Getter-read instrumentation compares 2,048 and 4,096 sibling layouts and rejects quadratic source-row access growth.',
  },
  {
    id: 'expanded-tree-viewport-bounds',
    ownerId: 'src/ui/chat/BranchTreeView.tsx#ActiveBranchTreeView',
    siteIds: [
      'src/ui/chat/BranchTreeView.tsx|ActiveBranchTreeView|explicit-loop|while|1',
      'src/ui/chat/BranchTreeView.tsx|ActiveBranchTreeView|explicit-loop|while|2',
      'src/ui/chat/BranchTreeView.tsx|ActiveBranchTreeView|growth|plus-equals|1',
      'src/ui/chat/BranchTreeView.tsx|ActiveBranchTreeView|growth|plus-equals|2',
      'src/ui/chat/BranchTreeView.tsx|ActiveBranchTreeView|growth|push|1',
      'src/ui/chat/BranchTreeView.tsx|ActiveBranchTreeView|growth|push|2',
    ],
    testPath: 'tests/unit/branch-tree-view.test.tsx',
    testLocator:
      "it('renders viewport-sized DOM for a very wide tree and only previews visible expanded cards'",
    assertionLocators: ['expect(getMessageTextPreview.mock.calls.length).toBeLessThan(50)'],
    proof:
      'A 2,001-node expanded tree keeps preview demand and rendered nodes below the explicit viewport-sized thresholds.',
  },
  {
    id: 'message-list-identity-delta-rendering',
    ownerId: 'src/ui/chat/MessageList.tsx#MessageListSurface',
    testPath: 'tests/unit/message-list-performance.test.tsx',
    testLocator: "it('rerenders only the body whose exact revision changed'",
    assertionLocators: ["expect(renderedIds).toEqual(['message-5'])"],
    proof:
      'Exact body-revision identity proves that one changed message rerenders only its own row.',
  },
  {
    id: 'workspace-export-import-bounded-table-pages',
    ownerId: 'src/store/browser-import-export.ts#BrowserImportExportHandler.exportWorkspaceBackup',
    testPath: 'tests/unit/import-export.test.ts',
    testLocator: "it('pages a large public backup without whole-table key materialization'",
    assertionLocators: ['expect(exportMetrics.maxTableReadBatchRows).toBeLessThanOrEqual(128)'],
    proof:
      'Explicit export materialization metrics bound physical table and message-body reads while exporting 640 additional messages.',
  },
  {
    id: 'large-json-file-chunked-input-read',
    ownerId: 'src/ui/import-export/json-file.ts#readJsonFile',
    testPath: 'tests/unit/json-file.test.ts',
    testLocator: "it('streams a large plain JSON file without file.text or whole-file arrayBuffer'",
    assertionLocators: ['expect(metrics.maxFileDecodeChunkBytes).toBeLessThanOrEqual(64 * 1024)'],
    proof:
      'A multi-megabyte file forbids whole-file browser read helpers and measures decode chunks at no more than 64 KiB; it does not prove bounded final JSON parse memory.',
  },
  {
    id: 'json-blob-bounded-document-parts',
    ownerId: 'src/ui/import-export/json-file.ts#jsonDocumentBlob',
    siteIds: ['src/ui/import-export/json-file.ts|jsonDocumentBlob|allocation|new:Blob|1'],
    testPath: 'tests/unit/json-file.test.ts',
    testLocator: "it('bounds JSON and UTF-8 chunks for a multi-megabyte Unicode string'",
    assertionLocators: [
      'Math.max(...chunks.map((chunk) => encoder.encode(chunk).byteLength)),\n    ).toBeLessThanOrEqual(64 * 1024)',
    ],
    proof:
      'The JSON document generator exposes and measures bounded immutable string parts for a multi-megabyte Unicode value.',
  },
  {
    id: 'zip-consumer-sequential-release',
    ownerId: 'src/ui/import-export/json-file.ts#readJsonOrZipFile',
    testPath: 'tests/unit/json-file.test.ts',
    testLocator: "it('returns filename-sorted ZIP values and releases entry wrappers'",
    assertionLocators: ['expect(metrics.parsedZipEntryWrappersReleased).toBe(2)'],
    proof:
      'The batch boundary converts filename-sorted parsed entries to values in place and records release of each wrapper after all entries have been parsed; the fixture does not establish a large-entry peak bound.',
  },
  {
    id: 'preset-migration-bounded-materialized-batches',
    ownerId: 'src/backcompat/preset-sort-order.ts#migrateLegacyPresetSortOrder',
    testPath: 'tests/unit/preset-sort-order.test.ts',
    testLocator: "it('matches the prior global comparator while bounding every materialized batch'",
    assertionLocators: ['prepare: { rowCount: 1_041, batchCount: 62, maxBatchSize: 17 },'],
    proof:
      'Migration stats prove all three phases process 1,041 rows in materialized batches no larger than the supplied 17-row page.',
  },
  {
    id: 'stream-writer-bounded-coalescing-output',
    ownerId: 'src/store/stream-chunk-writer.ts#BufferedStreamJournalWriter.append',
    testPath: 'tests/unit/stream-chunk-writer.test.ts',
    testLocator:
      "it('bounds coalescing sections and reduces a 100k plus 100k trace to twelve rows'",
    assertionLocators: ['expect(rows).toHaveLength(12)'],
    proof:
      'The public append path receives 1,564 text/reasoning chunks and persists exactly twelve coalesced rows.',
  },
  {
    id: 'streaming-markdown-linear-boundary-work',
    ownerId: 'src/ui/chat/MarkdownView.tsx#segmentStreamingMarkdownForTests',
    testPath: 'tests/unit/markdown-view.test.tsx',
    testLocator:
      "it('keeps cumulative prefix boundary work linear and projected blocks logarithmic'",
    assertionLocators: ['expect(finalSegments.length).toBeLessThanOrEqual(segmentBudget)'],
    proof:
      'Instrumented boundary scanning over 64 cumulative sections bounds projected segment count logarithmically and checks total scanned characters separately.',
  },
])

export const WORK_MEMORY_RISK_DECISIONS = freezeRows([
  ...[
    [
      'src/store/browser-active-branch-spine.ts|BrowserSelectionHeaderReader.newestDescendantLeafId|explicit-loop|while|1',
      'open-ended-loop',
    ],
    [
      'src/store/browser-active-branch-spine.ts|BrowserSelectionHeaderReader.newestDescendantLeafId|await-in-traversal|await|1',
      'serial-await-in-traversal',
    ],
    [
      'src/store/browser-active-branch-spine.ts|BrowserSelectionHeaderReader.newestDescendantLeafId|collection-pass|method:filter|1',
      'nested-traversal',
    ],
    [
      'src/store/browser-active-branch-spine.ts|BrowserSelectionHeaderReader.readChildPage|materialization|method:toArray|1',
      'whole-materialization',
    ],
  ].map(([siteId, riskKind]) => ({
    siteId,
    riskKind,
    necessity: 'required-domain-work',
    status: 'accepted',
    rationale:
      'Dependent page order requires serial traversal, but every page is bounded, every row is visited once, and the 100,000-row proof caps retained traversal rows at 66.',
  })),
  ...[
    [
      'src/core/branch-tree-layout.ts|layoutBranchTree|collection-pass|method:map|3',
      'nested-traversal',
    ],
    ['src/core/branch-tree-layout.ts|layoutBranchTree|explicit-loop|for|2', 'nested-traversal'],
    ['src/core/branch-tree-layout.ts|layoutBranchTree|explicit-loop|for|3', 'nested-traversal'],
    ['src/core/branch-tree-layout.ts|layoutBranchTree|explicit-loop|while|1', 'open-ended-loop'],
    ['src/core/branch-tree-layout.ts|layoutBranchTree|growth|push|4', 'nested-accumulation'],
  ].map(([siteId, riskKind]) => ({
    siteId,
    riskKind,
    necessity: 'required-domain-work',
    status: 'accepted',
    rationale:
      'Tree geometry requires a complete topology pass; getter-read instrumentation proves near-linear wide-fork scaling and a separate 20,000-deep fixture proves iterative traversal.',
  })),
  ...[
    [
      'src/ui/chat/BranchTreeView.tsx|ActiveBranchTreeView|explicit-loop|while|1',
      'open-ended-loop',
    ],
    [
      'src/ui/chat/BranchTreeView.tsx|ActiveBranchTreeView|explicit-loop|while|2',
      'open-ended-loop',
    ],
    [
      'src/ui/chat/BranchTreeView.tsx|ActiveBranchTreeView|explicit-loop|while|1',
      'nested-traversal',
    ],
    [
      'src/ui/chat/BranchTreeView.tsx|ActiveBranchTreeView|explicit-loop|while|2',
      'nested-traversal',
    ],
    [
      'src/ui/chat/BranchTreeView.tsx|ActiveBranchTreeView|growth|plus-equals|1',
      'nested-accumulation',
    ],
    [
      'src/ui/chat/BranchTreeView.tsx|ActiveBranchTreeView|growth|plus-equals|2',
      'nested-accumulation',
    ],
    ['src/ui/chat/BranchTreeView.tsx|ActiveBranchTreeView|growth|push|1', 'nested-accumulation'],
    ['src/ui/chat/BranchTreeView.tsx|ActiveBranchTreeView|growth|push|2', 'nested-accumulation'],
  ].map(([siteId, riskKind]) => ({
    siteId,
    riskKind,
    necessity: 'bounded-infrastructure',
    status: 'accepted',
    rationale:
      'These scans advance monotonically through depth rows or connector rows already clipped to viewport and overscan bounds; the 2,001-node browser-DOM fixture keeps each rendered collection below its explicit threshold.',
  })),
  {
    siteId: 'src/ui/import-export/json-file.ts|jsonDocumentBlob|allocation|new:Blob|1',
    riskKind: 'retained-or-large-allocation',
    necessity: 'bounded-infrastructure',
    status: 'accepted',
    rationale:
      'Each loop allocation wraps one measured at-most-64-KiB immutable JSON chunk; the final Blob owns the part list without an additional application-level whole-byte copy.',
  },
  {
    siteId: 'src/lib/same-value.ts|stableStringify|whole-clone|JSON.stringify|1',
    riskKind: 'whole-clone-or-serialization',
    necessity: 'likely-accidental',
    status: 'gap',
    rationale:
      'One unrestricted equality helper serializes values ranging from small revision records to cold message bodies, so call sites can copy arbitrarily large text merely to detect a change.',
    replacementDirection:
      'Replace unrestricted serialization equality with field/version-specific comparisons at mutation-plan boundaries and retain serialization only for explicitly bounded wire values.',
  },
  {
    siteId: 'src/ui/import-export/json-file.ts|readJsonFile|growth|plus-equals|1',
    riskKind: 'growing-string-in-traversal',
    necessity: 'likely-accidental',
    status: 'gap',
    rationale:
      'The browser file read is chunked, but every decoded chunk is appended to one growing string, so peak memory and flattening work still scale with the complete backup.',
    replacementDirection:
      'Feed bounded decoded chunks into an incremental JSON/envelope parser or a table-wise streaming importer instead of constructing one document string.',
  },
  {
    siteId: 'src/ui/import-export/json-file.ts|readJsonFile|whole-clone|JSON.parse|1',
    riskKind: 'whole-clone-or-serialization',
    necessity: 'likely-accidental',
    status: 'gap',
    rationale:
      'The final generic JSON parse necessarily materializes the complete object graph under the current API, defeating the bounded input-read path for large workspace backups.',
    replacementDirection:
      'Use a versioned streaming workspace envelope whose tables can be parsed, validated, and committed in bounded pages; retain generic JSON.parse only for explicitly size-bounded single-object imports.',
  },
])

export const REQUIRED_DOMAIN_WORK = freezeRows([
  {
    id: 'expanded-tree-visible-preview-text',
    siteIds: [
      'src/ui/chat/BranchTreeView.tsx|ActiveBranchTreeView|collection-pass|method:map|1',
      'src/ui/chat/BranchTreeView.tsx|ActiveBranchTreeView|explicit-loop|for-of|4',
    ],
    requirement:
      'Expanded branch cards need the first text projection for every currently visible node, while compact mode needs only the shared hovered preview.',
    minimumWork:
      'Enumerate the viewport-clipped node ids and request their bounded message preview projections; do not hydrate complete bodies merely to paint the cards.',
    boundingStrategy:
      'Two-dimensional viewport/overscan clipping plus the messagePreviews projection bounds simultaneous preview reads without imposing a maximum branch length.',
    allowsFixedTranscriptMaximum: false,
  },
  {
    id: 'branch-tree-search-complete-topology',
    siteIds: [
      'src/ui/chat/BranchTreeView.tsx|ActiveBranchTreeView|collection-pass|method:map|2',
      'src/ui/chat/BranchTreeView.tsx|ActiveBranchTreeView|collection-pass|method:map|3',
      'src/ui/chat/BranchTreeView.tsx|targetsFor|collection-pass|method:flatMap|1',
      'src/store/branch-tree-search-runtime.ts|TabBranchTreeSearchSession.startPointRead|explicit-loop|for-of|1',
      'src/store/branch-tree-search-runtime.ts|TabBranchTreeSearchSession.settlePointRead|explicit-loop|for|1',
    ],
    requirement:
      'An active branch-tree text search must consider every live branch node, including nodes outside the viewport and active transcript path.',
    minimumWork:
      'Enumerate exact topology headers once, then evaluate dirty or initial message-text projections in finite point/full-read batches.',
    boundingStrategy:
      'Topology work is linear in the chat tree; body/text evaluation is demand-driven and batched, with abort and version fences between reads.',
    allowsFixedTranscriptMaximum: false,
  },
  {
    id: 'transcript-destination-first-then-geometric-fill',
    siteIds: [
      'src/core/branch-session.ts|createBranchPath|explicit-loop|for|1',
      'src/core/branch-session.ts|IndexedBranchPath.windowRange|explicit-loop|for|1',
    ],
    requirement:
      'Transcript opening must paint the destination first, passively fill the configured initial render work, and permit demand-driven traversal to any older message.',
    minimumWork:
      'Build the immutable branch descriptor once and walk only the predecessor links needed for each fixed body page.',
    boundingStrategy:
      'Cost-aware destination work, fixed physical body pages, and geometric demand growth bound each turn of work while converging to the complete branch.',
    allowsFixedTranscriptMaximum: false,
  },
])

export const WORK_MEMORY_ACCEPTANCE_CRITERIA = freezeRows([
  {
    id: 'exact-production-source-classification-parity',
    requirement:
      'Every production TypeScript/TSX source module and every discovered work site or owner has exactly one current domain/layer classification.',
    automatedCheck:
      'The audit compares src source paths bidirectionally with the module inventory and rejects missing, duplicate, empty, or stale classifications.',
    closureCondition:
      'The structural problem list is empty after the exact production source snapshot is scanned.',
  },
  {
    id: 'every-risk-candidate-explicitly-disposed',
    requirement:
      'Every discovered quadratic, unbounded, fanout, materialization, serialization, allocation, or accumulation candidate receives an explicit source-site and risk-kind decision.',
    automatedCheck:
      'closureStatus.unreviewedRiskCandidates counts exact risk ids with no manifest decision; inferred unresolved rows remain visible but do not count as reviewed.',
    closureCondition:
      'unreviewedRiskCandidates equals zero and no stale or duplicate decision exists.',
  },
  {
    id: 'accepted-risk-has-exact-support',
    requirement:
      'An accepted risk is supported by a genuinely linked exact source site in either measured evidence or required domain work.',
    automatedCheck:
      'The audit rejects every accepted decision whose siteId is absent from evidence.siteIds and requiredDomainWork.siteIds.',
    closureCondition:
      'unsupportedAcceptedDecisions equals zero; filenames, test titles, and local naming signals alone never close a risk.',
  },
  {
    id: 'zero-active-performance-memory-gaps',
    requirement:
      'No unresolved or likely-accidental CPU, fanout, materialization, serialization, or retention gap remains in the closure snapshot.',
    automatedCheck:
      'Enforce mode exits nonzero for every active gap while inventory mode still emits the complete queue after structural validation.',
    closureCondition:
      'Enforce mode is green with activeGaps equal to zero; a failed individual test cannot truncate the inventory.',
  },
  {
    id: 'local-bounds-never-substitute-for-proof',
    requirement:
      'Page, batch, window, cursor, limit, budget, yield, abort, and loop-condition syntax remains contextual evidence rather than a correctness or complexity proof.',
    automatedCheck:
      'All such syntax is emitted only as localSignals and accepted decisions are independently checked for exact evidence or required-work support.',
    closureCondition:
      'No acceptance path consults localSignals as proof and every bound claim has a direct assertion or requirement link.',
  },
  {
    id: 'no-fixed-transcript-or-message-maximum',
    requirement:
      'Latency and memory bounds use paging, windows, projections, and resumable demand without imposing a hard maximum chat or transcript length.',
    automatedCheck:
      'The audit rejects required-domain-work rows that permit a fixed transcript maximum and exposes every current strategy in the report.',
    closureCondition:
      'Every transcript/tree requirement sets allowsFixedTranscriptMaximum to false and end-to-end demand can reach every message.',
  },
  {
    id: 'opaque-native-peak-memory-measured',
    requirement:
      'Browser-native and dependency work that syntax cannot price has representative runtime CPU and peak/retained-memory evidence at realistic and adversarial cardinalities.',
    automatedCheck:
      'The static report identifies these boundaries as limitations; exact evidence links must name unique tests and assertions rather than infer proof from titles.',
    closureCondition:
      'Each closure-critical opaque path has browser/runtime measurements for scaling, peak bytes, retained bytes, cancellation, and recovery where applicable.',
  },
  {
    id: 'scanner-limitations-remain-explicit',
    requirement:
      'Inventory closure records what syntax, runtime, dispatch, generated code, and receiver-typing questions the scanner cannot decide.',
    automatedCheck:
      'The audit requires a non-empty, uniquely identified limitation registry and emits it with every report.',
    closureCondition:
      'Each material limitation is either covered by a complementary typed/runtime audit or explicitly accepted as outside the production boundary.',
  },
])

export const WORK_MEMORY_LIMITATIONS = freezeRows([
  {
    id: 'syntax-is-not-runtime-cost-proof',
    statement:
      'The inventory proves exact source syntax and local structural signals; it does not infer collection cardinality, browser-engine cost, or asymptotic complexity from names.',
  },
  {
    id: 'library-and-native-work-remain-opaque',
    statement:
      'Work performed inside dependencies, IndexedDB, browser structured cloning, layout, paint, garbage collection, compression, and native parsing remains opaque unless an explicit application measurement is linked.',
  },
  {
    id: 'local-bound-signals-are-not-proof',
    statement:
      'A page, limit, loop condition, abort, or yield in the same function is reported only as a local signal and never promoted to proof without an explicit evidence link.',
  },
  {
    id: 'dynamic-dispatch-and-recursion-need-call-graph-proof',
    statement:
      'Syntax scanning cannot exhaustively resolve dynamic dispatch, mutual recursion, callback re-entry, or input aliasing; those require a typed call graph or runtime measurement.',
  },
  {
    id: 'allocation-size-is-data-dependent',
    statement:
      'Allocation sites are inventoried, but peak retained bytes require browser measurements because input sizes, sharing, copy-on-write behavior, and garbage-collector timing are data dependent.',
  },
  {
    id: 'literal-allocation-scope-is-risk-shaped',
    statement:
      'Array/object literals are recorded when retained beyond a function, repeated inside a discovered traversal, or syntactically large at 32 members; smaller one-shot function-local literals are intentionally omitted and dynamic member sizes remain unknown.',
  },
  {
    id: 'computed-method-and-element-access-is-opaque',
    statement:
      'Computed calls such as value[method]() and proxy-provided collection operations cannot be assigned a stable operation kind by this syntax-only scanner.',
  },
  {
    id: 'method-registry-has-no-receiver-type-proof',
    statement:
      'Named method calls are intentionally inventoried without a TypeScript receiver-type check, so a name such as map or count can over-include unrelated APIs while aliased wrappers can remain under-included.',
  },
  {
    id: 'inventory-records-can-overlap-one-syntax-node',
    statement:
      'Counts are category records rather than unique syntax nodes: one call can deliberately appear as a collection pass plus a materialization, allocation, fanout, growth, or local signal.',
  },
  {
    id: 'production-source-boundary-excludes-emitted-runtime',
    statement:
      'The scanner covers production .ts/.tsx under src; dependencies, generated assets, service-worker/build transforms, and emitted bundle behavior require separate artifact or runtime audits.',
  },
])
