const at = (path, line, text, role) => Object.freeze({ path, line, text, role })

const proof = (siteId, siteText, evidence, identityFlow, rationale) =>
  Object.freeze({
    siteId,
    siteText,
    disposition: 'proved',
    evidence: Object.freeze(evidence),
    identityFlow,
    rationale,
  })

export const productionAsyncOwnershipReviews = Object.freeze([
  proof(
    'src/ui/chat/ReasoningBlock.tsx#saveEdit|detached-promise|fnv1a32:4bba017d|1',
    'void onEdit(draft).then((outcome) => {',
    [
      at(
        'src/store/presentation-interaction-controller.ts',
        301,
        'const settled = new Promise<PresentationInteractionOutcome<Value>>((resolve) => {',
        'non-rejecting-construction',
      ),
      at(
        'src/store/presentation-interaction-controller.ts',
        384,
        'const settled = Promise.resolve(',
        'non-rejecting-construction',
      ),
    ],
    'ReasoningBlock owns the exact busy editor session and onEdit returns only TotalPresentationInteractionPromise; active and immediate settlements are resolve-only',
    'The detached observer updates only the matching local editor state and has no rejection channel.',
  ),
  proof(
    'src/ui/chat/InlineEditor.tsx#<callback:useCallback>|detached-promise|fnv1a32:042752bd|1',
    'void settlement.then((outcome) => {',
    [
      at(
        'src/store/presentation-interaction-controller.ts',
        301,
        'const settled = new Promise<PresentationInteractionOutcome<Value>>((resolve) => {',
        'non-rejecting-construction',
      ),
      at(
        'src/store/presentation-interaction-controller.ts',
        384,
        'const settled = Promise.resolve(',
        'non-rejecting-construction',
      ),
    ],
    'InlineEditor owns one active visual session and receives only TotalPresentationInteractionPromise; the controller constructs both active and immediate settlements through resolve-only promises',
    'Interaction failures are fulfilled discriminated outcomes, so the detached UI observer has no rejection channel.',
  ),
  proof(
    'src/app/Shell.tsx#<callback:useCallback>|detached-promise|fnv1a32:87b2fb54|1',
    'void claim.settled.then((outcome) => {',
    [
      at(
        'src/store/presentation-interaction-controller.ts',
        301,
        'const settled = new Promise<PresentationInteractionOutcome<Value>>((resolve) => {',
        'non-rejecting-construction',
      ),
      at(
        'src/store/presentation-interaction-controller.ts',
        384,
        'const settled = Promise.resolve(',
        'non-rejecting-construction',
      ),
    ],
    'Shell owns the exact mutation claim and observes only TotalPresentationInteractionPromise; active and immediate settlements are resolve-only',
    'The detached observer removes only the matching claim and publishes passive diagnostics, so it has no rejection channel.',
  ),
  proof(
    'src/app/WorkspaceBootstrap.tsx#<anonymous>|detached-promise|fnv1a32:c4c2e7c3|1',
    '<Button appearance="outline" onClick={() => void copyDiagnostics()}>',
    [at('src/app/WorkspaceBootstrap.tsx', 181, '} catch {', 'error-owner')],
    'button callback -> copyDiagnostics; the function catches clipboard rejection and publishes failed UI state',
    'The detached call is total at its local UI boundary.',
  ),
  proof(
    'src/store/browser-active-branch-spine.ts#resolveConversationOpenReceipt|detached-promise|fnv1a32:f26a5897|1',
    'void Promise.allSettled(ownedLegs)',
    [
      at(
        'src/store/browser-active-branch-spine.ts',
        635,
        'const slotFrame = await slotFramePromise',
        'error-owner',
      ),
    ],
    'ownedLegs contains only slotFramePromise, which the same owner awaits before cleanup; allSettled observes cancellation cleanup after the ordinary propagation channel has settled',
    'Closing a conversation-read scope never creates a second rejected leg or leaves the awaited frame unobserved.',
  ),
  proof(
    'src/store/locks.ts#<anonymous>|detached-promise|fnv1a32:9c359d1b|1',
    'void wake.then(() => finish())',
    [
      at(
        'src/store/locks.ts',
        245,
        'const promise = new Promise<void>((settle) => {',
        'non-rejecting-construction',
      ),
      at('src/store/locks.ts', 246, 'resolve = settle', 'identity-retained'),
    ],
    'subscribeLockWake exposes a promise constructed with only a resolve callback; wake is that exact promise',
    'A wake notification cannot reject.',
  ),
  proof(
    'src/store/locks.ts#run|detached-promise|fnv1a32:6ddc1917|1',
    'void owned.cleanup.finally(() => {',
    [
      at(
        'src/store/locks.ts',
        735,
        'const cleanup = Promise.race([physicalCleanup, this.disposedSignal]).then(',
        'non-rejecting-transform',
      ),
      at('src/store/locks.ts', 737, '() => undefined,', 'error-owner'),
      at('src/store/locks.ts', 817, 'private endPhysicalWork(): void {', 'non-throwing-finalizer'),
    ],
    'runOwned returns cleanup after a two-branch normalization; the finalizer only releases the resolve-only queue gate and decrements tracked physical work',
    'The detached cleanup observer is total while the caller receives the command outcome separately.',
  ),
  proof(
    'src/store/locks.ts#<anonymous>|detached-promise|fnv1a32:a6efa43b|1',
    'void prior.then(() => finish(resolve))',
    [
      at(
        'src/store/locks.ts',
        432,
        'private queue: Promise<void> = Promise.resolve()',
        'non-rejecting-construction',
      ),
      at(
        'src/store/locks.ts',
        485,
        'this.queue = prior.then(() => gate)',
        'non-rejecting-transform',
      ),
    ],
    'the fallback lock queue begins fulfilled and is extended only by resolve-only gates, so prior cannot reject; finish only settles the local wait promise once',
    'Queue admission has no detached failure channel.',
  ),
  proof(
    'src/store/locks.ts#<anonymous>|detached-promise|fnv1a32:1e014b5f|1',
    "void this.disposedSignal.then(() => finish(() => reject(new Error('LockBackendDisposed'))))",
    [
      at(
        'src/store/locks.ts',
        444,
        'this.disposedSignal = new Promise<void>((resolve) => {',
        'non-rejecting-construction',
      ),
      at(
        'src/store/locks.ts',
        447,
        'this.resolveDisposedSignal = resolveDisposed',
        'non-rejecting-transform',
      ),
    ],
    'disposedSignal exposes only its resolve capability; its callback settles the enclosing wait promise through the same single-settlement finish function',
    'Disposal wake-up cannot reject independently.',
  ),
  proof(
    'src/store/quota.ts#installPersistenceRequestOnFirstInteraction|detached-promise|fnv1a32:accab561|1',
    'void isPersisted().then((persisted) => {',
    [
      at(
        'src/store/quota.ts',
        64,
        '.then<StorageProbeResult<T>, StorageProbeResult<T>>(',
        'error-owner',
      ),
      at('src/store/quota.ts', 66, "() => ({ status: 'error', reason: 'failed' }),", 'error-owner'),
    ],
    'isPersisted -> probePersisted -> runStorageProbe; runStorageProbe converts operation rejection into a result union',
    'The detached persistence check is total by contract.',
  ),
  proof(
    'src/store/stream-chunk-writer.ts#<callback:queueMicrotask>|detached-promise|fnv1a32:144f53c9|1',
    'void drainSharedStreamJournalAppends(port, queue)',
    [at('src/store/stream-chunk-writer.ts', 692, '} catch (error) {', 'error-owner')],
    'microtask -> drainSharedStreamJournalAppends -> appendSharedFrameBatch; the batch function converts failure into request.reject and returns',
    'Queue request promises, not the detached drain, own append failures.',
  ),
  proof(
    'src/store/stream-chunk-writer.ts#<callback:queueMicrotask>|detached-promise|fnv1a32:144f53c9|2',
    'void drainSharedStreamJournalAppends(port, queue)',
    [at('src/store/stream-chunk-writer.ts', 692, '} catch (error) {', 'error-owner')],
    'reschedule microtask -> drainSharedStreamJournalAppends -> appendSharedFrameBatch; the batch function converts failure into request.reject and returns',
    'Queue request promises, not the detached drain, own append failures.',
  ),
  proof(
    'src/store/stream-leases.ts#adoptPreparedStreamLease|detached-promise|fnv1a32:3bf6af40|1',
    'void releaseStreamOwnershipReservationState(state)',
    [
      at(
        'src/store/stream-leases.ts',
        690,
        'const task = ownership.then(',
        'non-rejecting-transform',
      ),
      at('src/store/stream-leases.ts', 692, '() => {},', 'error-owner'),
      at(
        'src/store/workspace-runtime.ts',
        1082,
        'export function releaseWorkspaceChild(permit: WorkspaceReservedPermit): void {',
        'non-throwing-finalizer',
      ),
    ],
    'reservation release awaits the ownership hold settled promise, which is normalized through both ownership outcomes, and then synchronously releases its idempotent workspace child',
    'Disposed admission returns its explicit rejection while cleanup remains total.',
  ),
  proof(
    'src/store/stream-leases.ts#acquireStreamOwnership|detached-promise|fnv1a32:6b2453e0|1',
    'void task.finally(endStreamRuntimeWork)',
    [
      at(
        'src/store/stream-leases.ts',
        690,
        'const task = ownership.then(',
        'non-rejecting-transform',
      ),
      at('src/store/stream-leases.ts', 692, '() => {},', 'error-owner'),
      at(
        'src/store/stream-leases.ts',
        864,
        'function endStreamRuntimeWork(): void {',
        'non-throwing-finalizer',
      ),
    ],
    'ownership is transformed through both fulfillment and rejection into a void settled task; the synchronous finalizer only decrements tracked stream-runtime work',
    'The ownership acquisition result is carried independently by ready.',
  ),
  proof(
    'src/store/stream-leases.ts#__resetStreamLeasesForTests|detached-promise|fnv1a32:2d0057c1|1',
    'void releaseStreamOwnershipReservationState(reservation)',
    [
      at(
        'src/store/stream-leases.ts',
        690,
        'const task = ownership.then(',
        'non-rejecting-transform',
      ),
      at('src/store/stream-leases.ts', 692, '() => {},', 'error-owner'),
      at(
        'src/store/workspace-runtime.ts',
        1082,
        'export function releaseWorkspaceChild(permit: WorkspaceReservedPermit): void {',
        'non-throwing-finalizer',
      ),
    ],
    'test reset uses the same total reservation-release chain as production disposal: normalized ownership settlement followed by synchronous workspace-child release',
    'Deterministic drain completion is a separate teardown-order concern, not an unowned rejection.',
  ),
  proof(
    'src/store/stream-recovery.ts#watchOwnershipRelease|detached-promise|fnv1a32:496372d9|1',
    'void waitForStreamOwnershipRelease(streamId, watch.controller.signal).then((released) => {',
    [at('src/store/stream-leases.ts', 182, '} catch {', 'error-owner')],
    'watchOwnershipRelease -> waitForStreamOwnershipRelease; the callee converts lock rejection or abort into false',
    'The watcher receives a boolean outcome rather than a rejection.',
  ),
  proof(
    'src/ui/chat/MarkdownView.tsx#<callback:useEffect>|detached-promise|fnv1a32:7ea1f24b|1',
    'void yieldToEventLoop().then(complete)',
    [
      at('src/lib/yield-to-event-loop.ts', 12, '} catch {', 'error-owner'),
      at(
        'src/lib/yield-to-event-loop.ts',
        17,
        'await new Promise<void>((resolve) => {',
        'non-rejecting-construction',
      ),
      at(
        'src/lib/yield-to-event-loop.ts',
        48,
        'await new Promise<void>((resolve) => {',
        'non-rejecting-construction',
      ),
      at('src/ui/chat/MarkdownView.tsx', 300, 'const complete = () => {', 'non-throwing-finalizer'),
    ],
    'the shared no-abort event-loop yield normalizes scheduler failure into resolve-only MessageChannel or timer fallbacks; complete only publishes the still-current local render projection',
    'Progressive rendering cancellation is owned by the effect cleanup flag.',
  ),
  proof(
    'src/ui/chat/Composer.tsx#<callback:useEffect>|detached-promise|fnv1a32:39aeeec3|1',
    'void ingestFiles(droppedFiles.files).finally(() => {',
    [at('src/ui/attachments/useAttachmentDrafts.ts', 110, '} catch (err) {', 'error-owner')],
    'drop effect -> ingestFiles; each typed File is ingested inside the per-file try/catch and failures are materialized in upload state',
    'The FileList conversion is synchronous over a validated browser FileList and the asynchronous work is locally owned.',
  ),
  proof(
    'src/ui/chat/ImportModal.tsx#<anonymous>|detached-promise|fnv1a32:997dd097|1',
    'onClick={() => void commit()}',
    [at('src/ui/chat/ImportModal.tsx', 132, '} catch (err) {', 'error-owner')],
    'import button -> commit; the callback catches materialization and import failures and publishes inline error state',
    'The detached modal command is locally total.',
  ),
  proof(
    'src/ui/settings/ChatModelPanel.tsx#<callback:useEffect>|detached-promise|fnv1a32:b5f6c64c|1',
    'void probeLlamaServer({ baseUrl: profile.baseUrl }).then((result) => {',
    [at('src/api/probe.ts', 148, '} catch (e) {', 'error-owner')],
    'effect -> probeLlamaServer; the probe catches fetch, timeout, parse, and protocol failures into a ProbeResult error variant',
    'The UI consumes a total result union.',
  ),
  proof(
    'src/ui/storage/StorageView.tsx#<callback:useEffect>|detached-promise|fnv1a32:5e75b3d5|1',
    'void probeQuota().then((result) => {',
    [at('src/store/quota.ts', 66, "() => ({ status: 'error', reason: 'failed' }),", 'error-owner')],
    'storage effect -> probeQuota -> runStorageProbe; operation rejection becomes an error result variant',
    'Quota probing is total by contract.',
  ),
  proof(
    'src/ui/storage/StorageView.tsx#<callback:useEffect>|detached-promise|fnv1a32:c5da8c73|1',
    'void probePersisted().then((result) => {',
    [at('src/store/quota.ts', 66, "() => ({ status: 'error', reason: 'failed' }),", 'error-owner')],
    'storage effect -> probePersisted -> runStorageProbe; operation rejection becomes an error result variant',
    'Persistence probing is total by contract.',
  ),
  proof(
    'src/ui/storage/StorageView.tsx#handleRequestPersistence|detached-promise|fnv1a32:87423536|1',
    'void probeQuota().then(setQuotaProbe)',
    [at('src/store/quota.ts', 66, "() => ({ status: 'error', reason: 'failed' }),", 'error-owner')],
    'persistence handler -> probeQuota -> runStorageProbe; operation rejection becomes an error result variant',
    'The follow-up quota refresh is total by contract.',
  ),
  proof(
    'src/ui/storage/StorageView.tsx#<anonymous>|detached-promise|fnv1a32:154935e8|1',
    'onClick={() => void handleRequestPersistence()}',
    [
      at('src/store/quota.ts', 66, "() => ({ status: 'error', reason: 'failed' }),", 'error-owner'),
      at(
        'src/ui/storage/StorageView.tsx',
        307,
        'await requestNotificationPermissionForStoragePersistence()',
        'total-operation',
      ),
      at(
        'src/ui/storage/StorageView.tsx',
        308,
        'const requestResult = await probePersistRequest()',
        'total-operation',
      ),
    ],
    'button -> handleRequestPersistence -> storage probe APIs; every awaited browser request is normalized by runStorageProbe into a result union',
    'The handler has no fallible durable command and finally clears busy state.',
  ),
  proof(
    'src/ui/storage/StorageView.tsx#<anonymous>|detached-promise|fnv1a32:1e6a6806|1',
    'onClick={() => void handleClearWorkspace()}',
    [at('src/ui/storage/StorageView.tsx', 405, '} catch (error) {', 'error-owner')],
    'clear button -> handleClearWorkspace; the handler catches clearAll failure and reports it by toast',
    'Successful clear reloads the page; failed clear restores interactivity.',
  ),
  proof(
    'src/ui/storage/StorageView.tsx#<anonymous>|detached-promise|fnv1a32:088941fc|1',
    'onChange={(event) => void handleImportWorkspaceFile(event)}',
    [at('src/ui/storage/StorageView.tsx', 383, '} catch (error) {', 'error-owner')],
    'file input -> handleImportWorkspaceFile; read and restore failures are caught and shown by toast',
    'Route intent and busy state are released in finally.',
  ),
])
