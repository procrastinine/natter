export const SCROLL_WRITER_CLASSIFICATIONS = Object.freeze([
  writer(
    'transcript-instant-position',
    'src/ui/chat/ScrollRegion.tsx',
    'container.scrollTop = boundedTop',
    'transcript',
    'automatic-or-explicit',
    'semantic-owner-required',
  ),
  writer(
    'transcript-smooth-bottom',
    'src/ui/chat/ScrollRegion.tsx',
    "container.scrollTo({\n          top,\n          behavior: 'smooth',\n        })",
    'transcript',
    'explicit-navigation',
    'explicit-target',
  ),
  writer(
    'branch-search-result-center',
    'src/ui/chat/BranchTreeInspectorSearch.ts',
    "range?.startContainer.parentElement?.scrollIntoView({ block: 'center', inline: 'nearest' })",
    'branch-tree',
    'explicit-navigation',
    'explicit-target',
  ),
  writer(
    'branch-node-center-horizontal',
    'src/ui/chat/BranchTreeView.tsx',
    'element.scrollLeft = Math.max(0, graphOffsetX + node.x + node.width / 2 - width / 2)',
    'branch-tree',
    'explicit-navigation',
    'explicit-target',
  ),
  writer(
    'branch-node-center-vertical',
    'src/ui/chat/BranchTreeView.tsx',
    'element.scrollTop = Math.max(0, node.y + node.height / 2 - height / 2)',
    'branch-tree',
    'explicit-navigation',
    'explicit-target',
  ),
  writer(
    'branch-pan-horizontal',
    'src/ui/chat/BranchTreeView.tsx',
    'event.currentTarget.scrollLeft = gesture.startScrollLeft - deltaX',
    'branch-tree',
    'user-gesture',
    'user-owned',
  ),
  writer(
    'branch-pan-vertical',
    'src/ui/chat/BranchTreeView.tsx',
    'event.currentTarget.scrollTop = gesture.startScrollTop - deltaY',
    'branch-tree',
    'user-gesture',
    'user-owned',
  ),
  writer(
    'sidebar-top-anchor-correction',
    'src/ui/sidebar/ChatList.tsx',
    'root.scrollTop = 0',
    'sidebar',
    'layout-reconciliation',
    'preserve-anchor',
  ),
  writer(
    'sidebar-bottom-anchor-correction',
    'src/ui/sidebar/ChatList.tsx',
    'root.scrollTop = target',
    'sidebar',
    'layout-reconciliation',
    'preserve-anchor',
  ),
  writer(
    'sidebar-row-anchor-correction',
    'src/ui/sidebar/ChatList.tsx',
    'root.scrollTop += delta',
    'sidebar',
    'layout-reconciliation',
    'preserve-anchor',
  ),
  writer(
    'sidebar-virtual-anchor-fallback',
    'src/ui/sidebar/ChatList.tsx',
    "sidebarVirtualizer.scrollToOffset(offset - anchor.top + root.clientTop, { align: 'start' })",
    'sidebar',
    'layout-reconciliation',
    'preserve-anchor',
  ),
  writer(
    'storage-previous-page-origin',
    'src/ui/storage/StorageChatsSurface.tsx',
    'previousChatCatalogPage()\n              chatTableScrollRef.current?.scrollTo({ top: 0 })',
    'storage-table',
    'explicit-navigation',
    'reset-origin',
  ),
  writer(
    'storage-next-page-origin',
    'src/ui/storage/StorageChatsSurface.tsx',
    'nextChatCatalogPage()\n              chatTableScrollRef.current?.scrollTo({ top: 0 })',
    'storage-table',
    'explicit-navigation',
    'reset-origin',
  ),
])

export const TRANSCRIPT_HEIGHT_PRODUCERS = Object.freeze([
  heightProducer(
    'window-prefix-publication',
    'src/ui/chat/MessageList.tsx',
    'transcriptBodyWindowPages(branchSnapshot)',
    'data-page',
    'preserve-anchor',
  ),
  heightProducer(
    'live-stream-content',
    'src/ui/chat/Message.tsx',
    'liveSnapshot?.baseContent',
    'stream',
    'follow-or-anchor',
  ),
  heightProducer(
    'stream-terminal-renderer-handoff',
    'src/ui/chat/MarkdownView.tsx',
    'if (finalizedStreamingSegments) return finalizedStreamingSegments',
    'stream',
    'follow-or-anchor',
  ),
  heightProducer(
    'progressive-static-event-loop-handoff',
    'src/ui/chat/MarkdownView.tsx',
    'void yieldToEventLoop().then(complete)',
    'async-resource',
    'follow-or-anchor',
  ),
  heightProducer(
    'async-code-highlighting',
    'src/ui/chat/shiki-code-plugin.ts',
    'notifyCallbacks(pending.callbacks, result)',
    'async-resource',
    'follow-or-anchor',
  ),
  heightProducer(
    'async-mermaid-render',
    'src/ui/chat/lazy-mermaid-plugin.ts',
    'return (await load()).render(id, source)',
    'async-resource',
    'follow-or-anchor',
  ),
  heightProducer(
    'remote-markdown-image',
    'src/ui/chat/MarkdownView.tsx',
    'return <img {...props} src={src} alt={alt} />',
    'browser-layout',
    'follow-or-anchor',
  ),
  heightProducer(
    'generated-output-image',
    'src/ui/chat/MessageContent.tsx',
    '{src ? <img src={src} alt={alt} /> : <span data-ui="message-output-image-missing" />}',
    'browser-layout',
    'follow-or-anchor',
  ),
  heightProducer(
    'generated-output-audio',
    'src/ui/chat/MessageContent.tsx',
    "<audio controls src={src} preload={objectUrl ? 'metadata' : 'none'} />",
    'browser-layout',
    'follow-or-anchor',
  ),
  heightProducer(
    'generated-output-video',
    'src/ui/chat/MessageContent.tsx',
    "<video controls src={src} title={title} preload={objectUrl ? 'auto' : 'none'} />",
    'browser-layout',
    'follow-or-anchor',
  ),
  heightProducer(
    'attachment-catalog-resolution',
    'src/ui/attachments/AttachmentRefChips.tsx',
    "if (attachments.status === 'loading') return null",
    'async-resource',
    'follow-or-anchor',
  ),
  heightProducer(
    'reasoning-disclosure',
    'src/ui/chat/ReasoningBlock.tsx',
    'data-ui="reasoning"',
    'user-control',
    'explicit-intent',
  ),
  heightProducer(
    'tool-evidence-disclosure',
    'src/ui/chat/ToolEvidenceBlock.tsx',
    'data-ui="tool-evidence"',
    'user-control',
    'explicit-intent',
  ),
  heightProducer(
    'message-info-disclosure',
    'src/ui/chat/Message.tsx',
    '{showInfo ? (\n          <MessageInfo',
    'user-control',
    'explicit-intent',
  ),
  heightProducer(
    'inline-editor-autosize',
    'src/ui/chat/InlineEditor.tsx',
    'autosize(textareaRef.current)',
    'user-control',
    'explicit-intent',
  ),
  heightProducer(
    'message-collapse-mode',
    'src/ui/chat/Message.tsx',
    'onClick={cycleCollapse}',
    'user-control',
    'explicit-intent',
  ),
  heightProducer(
    'generation-terminal-notices',
    'src/ui/chat/Message.tsx',
    '{error ? (\n          <div data-ui="message-error" data-role="error">',
    'stream',
    'follow-or-anchor',
  ),
  heightProducer(
    'content-visibility-realization',
    'src/styles/messages.css',
    'content-visibility: auto;',
    'browser-layout',
    'follow-or-anchor',
  ),
])

export const SCROLL_HEIGHT_PRODUCER_PROOF_MATRIX = Object.freeze([
  heightProducerProof('window-prefix-publication', 'data-page'),
  heightProducerProof('live-stream-content', 'stream'),
  heightProducerProof('stream-terminal-renderer-handoff', 'stream'),
  heightProducerProof('progressive-static-event-loop-handoff', 'async-resource'),
  heightProducerProof('async-code-highlighting', 'async-resource'),
  heightProducerProof('async-mermaid-render', 'async-resource'),
  heightProducerProof('remote-markdown-image', 'browser-layout'),
  heightProducerProof('generated-output-image', 'browser-layout'),
  heightProducerProof('generated-output-audio', 'browser-layout'),
  heightProducerProof('generated-output-video', 'browser-layout'),
  heightProducerProof('attachment-catalog-resolution', 'async-resource'),
  heightProducerProof('reasoning-disclosure', 'user-control'),
  heightProducerProof('tool-evidence-disclosure', 'user-control'),
  heightProducerProof('message-info-disclosure', 'user-control'),
  heightProducerProof('inline-editor-autosize', 'user-control'),
  heightProducerProof('message-collapse-mode', 'user-control'),
  heightProducerProof('generation-terminal-notices', 'stream'),
  heightProducerProof('content-visibility-realization', 'browser-layout'),
])

export const SCROLL_SEMANTIC_TRANSITIONS = Object.freeze([
  transition(
    'destination-first-demand',
    'src/hooks/useActiveBranchFrame.ts',
    'initialTranscriptWorkBudget(normalizedInitialRowTarget, viewportHeight)',
    'transcript-demand',
    'A new selection first requests only the destination-sized suffix.',
  ),
  transition(
    'destination-settled-floor-demand',
    'src/store/conversation-controller.ts',
    'maxTranscriptWorkBudget(this.settledTranscriptBudget, explicit.budget)',
    'transcript-demand',
    'The controller preserves the settled initial work floor while merging later explicit demand.',
  ),
  transition(
    'prepend-publication-handshake',
    'src/store/conversation-controller.ts',
    "window.offset < previous.window.offset && nextEnd >= previousEnd ? 'prepend' : 'content'",
    'transcript-demand',
    'The controller prepares the exact adjacent-prefix transition before publishing its new body window.',
  ),
  transition(
    'prepend-anchor-capture',
    'src/ui/chat/ScrollRegion.tsx',
    '!capturePinnedLayoutAnchor(undefined, transition)',
    'layout-anchor',
    'The viewport owner captures the pinned semantic edge against the prepared transition before publication.',
  ),
  transition(
    'prepend-anchor-reconcile',
    'src/ui/chat/ScrollRegion.tsx',
    'if (pendingTransition === null || pendingTransition.revision !== viewportRevision) return',
    'layout-anchor',
    'Only the matching committed viewport revision reconciles the prepared continuity lease.',
  ),
  transition(
    'auto-top-demand',
    'src/ui/chat/MessageList.tsx',
    'if (entries.some((entry) => entry.isIntersecting)) loadOlderMessages()',
    'transcript-demand',
    'Top proximity requests the next bounded work budget only after an anchor is accepted.',
  ),
  transition(
    'open-to-leaf',
    'src/ui/chat/ScrollRegion.tsx',
    "const result = reconcileFiniteFollowClaim('open')",
    'selection',
    'Opening a chat creates one bottom claim and releases it after the first overflowing destination lands.',
  ),
  transition(
    'selection-change',
    'src/ui/chat/ScrollRegion.tsx',
    "scrollToBottomNow({ smooth: false, reason: 'selection' })",
    'selection',
    'A selected branch-tail change may move only while follow ownership is still active.',
  ),
  transition(
    'reveal-claim-acquire',
    'src/ui/chat/ScrollRegion.tsx',
    "scrollToFollowPositionNow('reveal-acquire')",
    'stream',
    'A tab-local Save and Send or regenerate claim owns follow before its replacement suffix is published.',
  ),
  transition(
    'stream-claim-acquire',
    'src/ui/chat/ScrollRegion.tsx',
    "scrollToFollowPositionNow('stream')",
    'stream',
    'An active selected-path stream follows only when semantic follow was not revoked by this tab.',
  ),
  transition(
    'reveal-claim-ready',
    'src/ui/chat/ScrollRegion.tsx',
    "setScrollStateNow('follow', 'reveal-ready')",
    'stream',
    'Readiness resolves the already-acquired reveal claim and hands that same claim to the active stream.',
  ),
  transition(
    'stream-terminal-settle',
    'src/ui/chat/ScrollRegion.tsx',
    'const previousLease = continuityLeaseRef.current',
    'layout-anchor',
    'Terminal handoff restores the recorded target edge once and then releases ownership so unrelated later growth is not chased.',
  ),
  transition(
    'content-growth-reconciliation',
    'src/ui/chat/ScrollRegion.tsx',
    "scrollToFollowPositionNow('scheduled-follow')",
    'layout-anchor',
    'Resize and mutation signals share one animation-frame reconciliation.',
  ),
  transition(
    'user-follow-cancel',
    'src/ui/chat/ScrollRegion.tsx',
    "const markUserScrollIntent = (event: 'wheel' | 'touchmove' | 'scrollbar' | 'keyboard') => {",
    'user-intent',
    'Wheel, touch, scrollbar, and keyboard intent revoke automatic follow ownership.',
  ),
  transition(
    'editor-nearest-reveal',
    'src/ui/chat/InlineEditor.tsx',
    'if (actions) scrollRegionCommands?.revealNearest(actions)',
    'editor',
    'Entering edit mode requests only the minimum movement needed to expose its action row.',
  ),
])

export const SCROLL_EXISTING_PROOFS = Object.freeze([
  proof(
    'destination-first-passive-floor',
    'tests/e2e/render-window-loading.spec.ts',
    "test('destination-first transcript loading passively reaches the configured floor for short messages'",
    'browser',
    'Proves row-count fill, but does not bound viewport movement during every intermediate publication.',
  ),
  proof(
    'repeated-mixed-height-prepend',
    'tests/e2e/render-window-loading.spec.ts',
    "test('very long destination paints first, passively fills, and loads older batches manually'",
    'browser',
    'Bounds repeated manual prepend displacement, but not the automatic top-demand sequence reported by the user.',
  ),
  proof(
    'automatic-adjacent-prepend',
    'tests/e2e/render-window-loading.spec.ts',
    "test('destination-first passive fill and repeated variable-height auto prepends preserve one viewport'",
    'browser',
    'Combines destination-first paint, passive fill, repeated automatic prepends, and post-render height changes under one bounded semantic viewport.',
  ),
  proof(
    'delayed-layout-prepend',
    'tests/e2e/render-window-loading.spec.ts',
    "test('manual prepend retains its viewport anchor across delayed layout above it'",
    'browser',
    'Covers one delayed layout source above a manually pinned anchor.',
  ),
  proof(
    'edit-scroll-not-trapped',
    'tests/e2e/scroll.spec.ts',
    "test('an active message edit does not trap transcript scrolling in either direction'",
    'browser',
    'Covers ordinary edit scrolling, not Save and Send handoff to a newly streaming reply.',
  ),
  proof(
    'stream-growth-unit-transition',
    'tests/unit/scroll-region.test.tsx',
    "it('continues following the selected stream through delayed content growth'",
    'component',
    'The state-machine fixture lacks real Markdown, media, content-visibility, and browser layout handoff.',
  ),
  proof(
    'semantic-prepend-anchor-unit',
    'tests/unit/message-list-prepend-anchor.test.tsx',
    "it('preserves a retained row across a controller-preannounced prepend'",
    'component',
    'Proves message-node anchoring with synthetic geometry only.',
  ),
  proof(
    'background-prepend-prepublication-unit',
    'tests/unit/message-list-prepend-anchor.test.tsx',
    "it('keeps the unresolved open-to-leaf claim semantic through background initial fill'",
    'geometry',
    'Proves the retained node is captured before background prefix publication and remains within one pixel.',
  ),
  proof(
    'save-send-prepublication-unit',
    'tests/unit/scroll-region.test.tsx',
    "it('acquires a reveal before its suffix arrives, then settles the ready destination'",
    'component',
    'Proves claim ownership starts before the replacement suffix and readiness consumes the same key once.',
  ),
  proof(
    'generic-scroll-recorder-contract',
    'tests/unit/ui-journey-invariant-recorder.test.ts',
    "it('detects follow-bottom and prepend-anchor discontinuities from one scroll contract'",
    'component',
    'Proves one reusable journey recorder detects follow-bottom and prepend-anchor discontinuities.',
  ),
  proof(
    'single-viewport-continuity-lease-static',
    'src/ui/chat/ScrollRegion.tsx',
    'type ViewportContinuityLease =',
    'static',
    'Open, reveal, stream, manual follow and pinned preservation share one discriminated continuity lease.',
  ),
  proof(
    'filtered-sidebar-semantic-anchor-browser-journey',
    'tests/e2e/sidebar.spec.ts',
    "test('filtered virtual sidebar preserves its anchor across matching peer additions and removals'",
    'browser',
    'Preserves one semantic virtual-row anchor across matching insertion and removal without an empty or searching-status flash.',
  ),
  proof(
    'stream-terminal-continuous-browser',
    'tests/e2e/scroll.spec.ts',
    "test('incremental streams keep following content growth that renders below the ScrollRegion parent'",
    'browser',
    'Keeps one bottom-acquisition invariant active through the final SSE frame, renderer replacement, terminal layout, and delayed stabilization.',
  ),
  proof(
    'save-send-continuous-browser',
    'tests/e2e/scroll.spec.ts',
    'test("Save & Send from a pinned earlier message follows this tab\'s new streaming reply"',
    'browser',
    'Rejects reversal or transient alignment to the edited message while the requested response bottom is acquired.',
  ),
  proof(
    'generic-automatic-scroll-journeys-browser',
    'tests/e2e/ui-journey-invariant-recorder.ts',
    'rejectAlignmentSelector?: string',
    'browser',
    'The shared journey recorder continuously owns follow, acquisition, alternate-target rejection, and prepend-anchor invariants across browser journeys.',
  ),
  proof(
    'height-producer-ownership-matrix-browser',
    'tests/e2e/scroll.spec.ts',
    "test('all inventoried height-producer mechanisms preserve follow and pinned ownership'",
    'browser',
    'Exercises each classified browser height-change mechanism under continuous follow and pinned-anchor ownership.',
  ),
])

export const SCROLL_CONTINUITY_GAPS = Object.freeze([])

export const SCROLL_CONTINUITY_ACCEPTANCE = Object.freeze([
  acceptance(
    'no-unowned-geometry-writers',
    ['static'],
    'Every production scrollTop, scrollLeft, scrollTo, scrollBy, scrollIntoView, or virtual scroll writer is classified by exact source location and semantic owner.',
  ),
  acceptance(
    'no-automatic-discontinuity',
    ['browser', 'geometry'],
    'Every automatic frame preserves the user-visible semantic point; only an explicit navigation intent may discontinuously select another point.',
  ),
  acceptance(
    'destination-first-then-passive-floor',
    ['browser', 'performance'],
    'The destination paints first, then the configured initial work floor fills passively while continuously growing the scroll extent without moving the visible point.',
  ),
  acceptance(
    'unbounded-chat-pagination',
    ['browser', 'performance'],
    'Chats have no hard message maximum; older work grows geometrically in bounded pages with O(page plus visible) CPU and memory.',
  ),
  acceptance(
    'user-intent-revokes-follow',
    ['browser', 'interaction'],
    'Wheel, touch, scrollbar, keyboard, selection, and explicit edit scrolling take ownership immediately and cannot be overridden by late async layout.',
  ),
  acceptance(
    'stream-terminal-continuity',
    ['browser', 'geometry'],
    'Streaming-to-completed renderer handoff preserves the same bottom or pinned semantic edge across Markdown, media, and delayed layout.',
  ),
  acceptance(
    'edit-and-send-continuity',
    ['browser', 'interaction'],
    'Edit mode never traps scrolling, ordinary edit reveals only the nearest action edge, and Save and Send follows the new response bottom exactly once.',
  ),
  acceptance(
    'single-transcript-scroll-authority',
    ['static', 'component', 'browser'],
    'One transition authority consumes selection, stream, reveal, layout, visibility, prepend, and user-intent events and is the only transcript geometry writer.',
  ),
])

function writer(id, path, locator, surface, trigger, continuity) {
  return Object.freeze({ id, path, locator, surface, trigger, continuity })
}

function transition(id, path, locator, owner, effect) {
  return Object.freeze({ id, path, locator, owner, effect })
}

function heightProducer(id, path, locator, timing, anchorRequirement) {
  return Object.freeze({ id, path, locator, timing, anchorRequirement })
}

function heightProducerProof(producerId, mechanism) {
  return Object.freeze({
    producerId,
    mechanism,
    followProofId: 'height-producer-ownership-matrix-browser',
    pinnedProofId: 'height-producer-ownership-matrix-browser',
  })
}

function proof(id, path, locator, kind, limit) {
  return Object.freeze({ id, path, locator, kind, limit })
}

function acceptance(id, proofKinds, invariant) {
  return Object.freeze({ id, proofKinds: Object.freeze(proofKinds), invariant })
}
