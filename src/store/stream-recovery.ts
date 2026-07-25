import { normalizeAttemptTerminalDecision } from '../core/attempt-outcome'
import type { CanonicalStreamEventV2 } from '../core/generation-stream-events'
import {
  applyStreamAccumulatorReplayEntry,
  createStreamAccumulator,
  type StreamAccumulator,
} from '../core/stream-accumulator'
import { reduceAttemptAvailability } from './attempt-availability'
import { attemptController } from './attempt-controller'
import {
  type AttemptTerminalDecision,
  type AttemptTerminalPreparation,
  type AttemptTerminalReceipt,
  createRecoveryAttemptTerminalOwner,
  projectAttemptTerminal,
} from './attempt-terminalization'
import type { MessagePresentation } from './message-storage'
import { persistedStreamEventV2FromUnknown } from './persisted-stream-event'
import { RecoveryRetryScheduler, type RecoveryRetryState } from './recovery-retry-scheduler'
import {
  type FencedStreamLeaseRow,
  type StreamLeaseRow,
  streamLeaseDispatchEvidence,
  streamLeaseHasWriteFence,
  streamLeaseReasoningCarryForward,
  streamLeaseReasoningVisibility,
} from './repository'
import { StreamJournalFrameDecoder } from './stream-journal-codec'
import {
  observeStreamLeaseFreshness,
  STREAM_LEASE_TTL_MS,
  streamLeaseFreshnessEpoch,
} from './stream-lease-policy'
import {
  getLocalAttemptAuthority,
  getStreamClientId,
  runWithStreamRecoveryCoordinatorLock,
  streamWriteFenceForLease,
  waitForStreamOwnershipRelease,
  withStreamRecoveryLocks,
} from './stream-leases'
import type { WorkspaceEffect } from './workspace-effect-hub'
import { subscribeWorkspaceEffects, WORKSPACE_EFFECT_RECOVERY_OWNED } from './workspace-effect-hub'
import type { WorkspaceDependency, WorkspaceRepository } from './workspace-protocol'
import { getWorkspaceRepository } from './workspace-repository'
import type { WorkspaceWritePermit } from './workspace-runtime'
import { runWorkspaceAction, runWorkspaceRead } from './workspace-runtime'

const RECOVERY_CONCURRENCY = 4
const LEASE_EXPIRY_EPSILON_MS = 1
const RECOVERY_RETRY_POLICY = {
  baseDelayMs: 2_000,
  maxDelayMs: 60_000,
} as const
const OPERATIONAL_RETRY_POLICY = {
  baseDelayMs: 2_000,
  maxDelayMs: 60_000,
} as const
const COORDINATOR_RETRY_KEY = 'coordinator'
const LEASE_READ_RETRY_KEY = 'lease-read'
const STREAM_RETRY_PREFIX = 'stream:'

function leaseSchedulerNow(): number {
  return globalThis.performance.now()
}

export interface OrphanRecoveryPoint {
  streamId: string
  workspaceId?: string
  replacementEpoch?: number
  freshnessEpoch?: string
  freshnessDeadline?: number
}

export type StreamOrphanRecoveryResult = 'recovered' | 'retry' | 'deferred' | 'resolved'

export async function recoverStreamOrphan(
  point: OrphanRecoveryPoint,
  now = Date.now(),
  signal?: AbortSignal,
): Promise<StreamOrphanRecoveryResult> {
  const active = recoveryRuns.get(point.streamId)
  if (active && !sameRecoveryScope(active.point, point)) {
    signal?.throwIfAborted()
    await active.promise.catch(() => undefined)
    signal?.throwIfAborted()
  }
  return getOrStartRecovery(point, now, signal).promise
}

function getOrStartRecovery(
  point: OrphanRecoveryPoint,
  now: number,
  signal?: AbortSignal,
): RecoveryRun {
  const active = recoveryRuns.get(point.streamId)
  if (active) return active
  const action = runWorkspaceAction(
    'stream-recovery',
    (permit) => recoverStreamOrphanCore(point, now, permit),
    signal ? { signal } : {},
  )
  const run: RecoveryRun = {
    point: Object.freeze({ ...point }),
    promise: action.catch(async (error: unknown) => {
      await scheduleUncoordinatedRecoveryFailure(run, error)
      throw error
    }),
  }
  const { promise } = run
  recoveryRuns.set(point.streamId, run)
  const release = () => {
    if (recoveryRuns.get(point.streamId) !== run) return
    recoveryRuns.delete(point.streamId)
    if (accepting) scheduleRecoveryPump()
  }
  void promise.then(release, release)
  return run
}

async function recoverStreamOrphanCore(
  point: OrphanRecoveryPoint,
  now: number,
  permit: WorkspaceWritePermit,
): Promise<StreamOrphanRecoveryResult> {
  const repo = getWorkspaceRepository()
  const workspace = (await repo.query(permit, { kind: 'workspace.meta' })).value
  if (
    (point.workspaceId !== undefined && point.workspaceId !== workspace.workspaceId) ||
    (point.replacementEpoch !== undefined && point.replacementEpoch !== workspace.replacementEpoch)
  ) {
    return 'resolved'
  }
  const initial = (await repo.query(permit, { kind: 'stream.lease', streamId: point.streamId }))
    .value
  if (!initial) return 'resolved'

  const guarded = await withStreamRecoveryLocks([initial.streamId], async (ownershipVerified) => {
    throwIfRecoveryAborted(permit.signal)
    const current = (await repo.query(permit, { kind: 'stream.lease', streamId: initial.streamId }))
      .value
    if (!current || current.replacementEpoch !== workspace.replacementEpoch) return 'resolved'
    const priorAvailability = attemptController.getExecution(current.streamId)?.availability
    const availability = reduceAttemptAvailability(priorAvailability, {
      workspace: {
        workspaceId: workspace.workspaceId,
        replacementEpoch: workspace.replacementEpoch,
      },
      lease: { kind: 'present', lease: current },
      localAuthority: getLocalAttemptAuthority(current.streamId),
      ownershipLock: ownershipVerified
        ? { kind: 'acquired-for-recovery', streamId: current.streamId }
        : { kind: 'unsupported' },
      wallNow: now,
      schedulerNow: leaseSchedulerNow(),
      ...(point.freshnessEpoch === streamLeaseFreshnessEpoch(current) &&
      point.freshnessDeadline !== undefined
        ? {
            previousFreshness: {
              epoch: point.freshnessEpoch,
              deadline: point.freshnessDeadline,
            },
          }
        : {}),
    })
    if (availability.recovery.kind !== 'claim') {
      return 'deferred'
    }

    const claimed = (
      await repo.execute(
        permit,
        { kind: 'stream.claim-recovery', expected: current, now },
        {
          localApplications: {
            conversation: (committed) => {
              if (!committed.value) return 'inactive'
              attemptController.applyLocalCommittedTransition(
                [
                  {
                    kind: 'observe-lease',
                    lease: committed.value,
                    options: { workspaceId: permit.workspaceId },
                  },
                ],
                () => undefined,
              )
              return 'applied'
            },
          },
        },
      )
    ).value
    if (!claimed || !streamLeaseHasWriteFence(claimed) || claimed.custody !== 'recovery') {
      return 'retry'
    }
    throwIfRecoveryAborted(permit.signal)

    const terminalOwner = createRecoveryAttemptTerminalOwner({
      repository: repo,
      permit,
      lease: claimed,
    })
    const outcome = await terminalOwner.complete({
      prepareTerminal: (receipt) => projectRecoveredAttempt(repo, permit, claimed, now, receipt),
    })
    return outcome.kind === 'retired' ? 'recovered' : 'retry'
  })
  return guarded.acquired ? guarded.value : 'deferred'
}

async function projectRecoveredAttempt(
  repo: WorkspaceRepository,
  permit: WorkspaceWritePermit,
  lease: FencedStreamLeaseRow,
  now: number,
  receipt?: AttemptTerminalReceipt,
): Promise<AttemptTerminalPreparation> {
  const presentationEnvelope = await repo.query(permit, {
    kind: 'message.presentation',
    messageId: lease.messageId,
  })
  const presentation = validRecoveryPresentation(presentationEnvelope.value, lease)
  const terminalNow = receipt?.finishedAt ?? now
  const replayed = await replayRecoveredStreamJournal({
    repo,
    permit,
    lease,
    initialContent:
      lease.attemptKind === 'continuation' ? [] : (presentation?.message.content ?? []),
    now: terminalNow,
    throughSeq: receipt?.journalMaxSeq ?? lease.journalMaxSeq ?? -1,
    allowTruncatedTail: receipt === undefined,
  })
  return lease.attemptKind === 'continuation'
    ? projectRecoveredContinuation(lease, replayed, terminalNow, receipt?.decision)
    : projectRecoveredGeneration(lease, presentation, replayed, terminalNow, receipt?.decision)
}

async function projectRecoveredGeneration(
  lease: FencedStreamLeaseRow,
  presentation: MessagePresentation | undefined,
  replayed: RecoveredStreamJournalReplay,
  now: number,
  decision?: AttemptTerminalDecision,
): Promise<AttemptTerminalPreparation> {
  const currentGeneration = presentation?.message.generation
  const dispatch = streamLeaseDispatchEvidence(lease)
  const requestedModel =
    nonEmpty(dispatch?.requestedModel) ??
    nonEmpty(currentGeneration?.requestedModel) ??
    nonEmpty(currentGeneration?.model) ??
    'unknown'
  const apiUsed = streamLeaseDispatchEvidence(lease)?.apiUsed ?? currentGeneration?.apiUsed
  const selectedKeyId = lease.postCommit.selectedKeyId ?? lease.postCommit.final?.selectedKeyId
  return projectAttemptTerminal({
    kind: 'generation',
    streamId: lease.streamId,
    messageId: lease.messageId,
    fence: streamWriteFenceForLease(lease),
    accumulator: replayed.accumulator,
    baseline: presentation
      ? {
          kind: 'exact',
          bodyVersion: presentation.bodyVersion,
          body: recoveryMessageBody(presentation.message),
        }
      : { kind: 'unavailable' },
    ...(currentGeneration ? { currentGeneration } : {}),
    requestedModel,
    ...(apiUsed ? { apiUsed } : {}),
    startedAt: lease.startedAt,
    finishedAt: now,
    decision: decision ?? recoveredTerminalDecision(lease, replayed),
    reasoningCarryForward: streamLeaseReasoningCarryForward(lease),
    reasoningVisibility: streamLeaseReasoningVisibility(lease),
    ...(selectedKeyId ? { selectedKeyId } : {}),
    ...(presentation?.message.attachmentRefs
      ? { attachmentRefs: presentation.message.attachmentRefs }
      : {}),
    ...(lease.postCommit.profileId && selectedKeyId
      ? {
          requestCredential: {
            profileId: lease.postCommit.profileId,
            selectedKeyId,
          },
        }
      : {}),
  })
}

function recoveryMessageBody(message: MessagePresentation['message'] | undefined) {
  return {
    content: structuredClone(message?.content ?? []),
    ...(message?.reasoningEnvelope
      ? { reasoningEnvelope: structuredClone(message.reasoningEnvelope) }
      : {}),
    ...(message?.toolCalls ? { toolCalls: structuredClone(message.toolCalls) } : {}),
    ...(message?.refusal !== undefined ? { refusal: message.refusal } : {}),
    ...(message?.phase !== undefined ? { phase: message.phase } : {}),
    ...(message?.providerOutputItems
      ? { providerOutputItems: structuredClone(message.providerOutputItems) }
      : {}),
    ...(message?.continuationAttempts
      ? { continuationAttempts: structuredClone(message.continuationAttempts) }
      : {}),
  }
}

async function projectRecoveredContinuation(
  lease: FencedStreamLeaseRow,
  replayed: RecoveredStreamJournalReplay,
  now: number,
  decision?: AttemptTerminalDecision,
): Promise<AttemptTerminalPreparation> {
  const dispatch = streamLeaseDispatchEvidence(lease)
  return projectAttemptTerminal({
    kind: 'continuation',
    streamId: lease.streamId,
    messageId: lease.messageId,
    fence: streamWriteFenceForLease(lease),
    accumulator: replayed.accumulator,
    strategy:
      lease.attemptKind === 'continuation' && dispatch && 'continuationStrategy' in dispatch
        ? dispatch.continuationStrategy
        : 'unknown',
    ...(dispatch?.requestedModel ? { requestedModel: dispatch.requestedModel } : {}),
    ...(dispatch?.apiUsed ? { apiUsed: dispatch.apiUsed } : {}),
    startedAt: lease.startedAt,
    finishedAt: now,
    decision: decision ?? recoveredTerminalDecision(lease, replayed),
    reasoningCarryForward: streamLeaseReasoningCarryForward(lease),
    reasoningVisibility: streamLeaseReasoningVisibility(lease),
  })
}

interface RecoveredStreamJournalReplay {
  readonly accumulator: StreamAccumulator
  readonly finishedCleanly: boolean
}

async function replayRecoveredStreamJournal(input: {
  readonly repo: WorkspaceRepository
  readonly permit: WorkspaceWritePermit
  readonly lease: FencedStreamLeaseRow
  readonly initialContent: MessagePresentation['message']['content']
  readonly now: number
  readonly throughSeq: number
  readonly allowTruncatedTail: boolean
}): Promise<RecoveredStreamJournalReplay> {
  const accumulator = createStreamAccumulator({
    initialContent: input.initialContent,
    now: input.now,
  })
  const decoder = new StreamJournalFrameDecoder({
    streamId: input.lease.streamId,
    chatId: input.lease.chatId,
    messageId: input.lease.messageId,
    replacementEpoch: input.lease.replacementEpoch,
    admissionSequence: input.lease.admissionSequence,
  })
  let finishedCleanly = false
  let journalIntegrityFailed = false
  let afterSeq = -1
  journalPages: for (;;) {
    const page = (
      await input.repo.query(input.permit, {
        kind: 'stream.journal-frame-page',
        streamId: input.lease.streamId,
        afterSeq,
        throughSeq: input.throughSeq,
      })
    ).value
    for (const frame of page.frames) {
      try {
        const entry = await decoder.accept(frame)
        if (!entry) continue
        const persisted = persistedStreamEventV2FromUnknown(entry.event)
        if (!persisted) {
          journalIntegrityFailed = true
          break journalPages
        }
        if (applyStreamAccumulatorReplayEntry(accumulator, { ...entry, event: persisted.event })) {
          finishedCleanly = true
        }
      } catch {
        journalIntegrityFailed = true
        break journalPages
      }
    }
    if (page.done) break
    if (page.nextAfterSeq <= afterSeq) throw new Error('StreamJournalRecoveryPageDidNotAdvance')
    afterSeq = page.nextAfterSeq
  }
  if (!journalIntegrityFailed) {
    try {
      decoder.finish({
        allowTruncatedTail: input.allowTruncatedTail,
        expectedFinalPhysicalSeq: input.throughSeq,
      })
    } catch {
      journalIntegrityFailed = true
    }
  }
  if (journalIntegrityFailed) {
    applyStreamAccumulatorReplayEntry(accumulator, {
      event: STREAM_JOURNAL_INTEGRITY_ERROR_EVENT,
      createdAt: input.now,
    })
  }
  return { accumulator, finishedCleanly: finishedCleanly && !journalIntegrityFailed }
}

const STREAM_JOURNAL_INTEGRITY_ERROR_EVENT = Object.freeze({
  lane: 'error',
  error: Object.freeze({
    name: 'StreamJournalIntegrityError',
    kind: 'integrity',
    code: 'STREAM_JOURNAL_EVENT_INVALID',
    message: 'Stored stream journal integrity validation failed.',
    midStream: true,
    retryable: false,
  }),
}) satisfies CanonicalStreamEventV2

function validRecoveryPresentation(
  presentation: MessagePresentation | undefined,
  lease: StreamLeaseRow,
): MessagePresentation | undefined {
  if (
    !presentation ||
    presentation.header.deleted ||
    presentation.header.role !== 'assistant' ||
    presentation.header.chatId !== lease.chatId
  ) {
    return undefined
  }
  return presentation
}

function recoveredTerminalDecision(
  lease: StreamLeaseRow,
  replayed: RecoveredStreamJournalReplay,
): AttemptTerminalDecision {
  if (lease.phase === 'terminal-decided') return lease.terminal.decision
  if (lease.stopControl) {
    return normalizeAttemptTerminalDecision({ outcome: 'abort', abortReason: 'user' })
  }
  if (replayed.accumulator.midStreamError) {
    return normalizeAttemptTerminalDecision({
      outcome: 'error',
      error: replayed.accumulator.midStreamError,
    })
  }
  return replayed.finishedCleanly
    ? normalizeAttemptTerminalDecision({ outcome: 'done' })
    : normalizeAttemptTerminalDecision({ outcome: 'abort', abortReason: 'tab-close' })
}

function nonEmpty(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined
}

function throwIfRecoveryAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason
}

interface RecoveryQueueEntry {
  streamId: string
  workspaceId?: string
  replacementEpoch?: number
  freshnessEpoch: string
  freshnessDeadline: number
  evidence: string
}

interface RecoveryRun {
  readonly point: OrphanRecoveryPoint
  readonly promise: Promise<StreamOrphanRecoveryResult>
  coordinatorEvidence?: string
}

interface LeaseDeadlineEntry extends OrphanRecoveryPoint {
  deadline: number
  freshnessEpoch: string
  freshnessDeadline: number
  ownershipIdentity: string
  ownershipWatchable: boolean
  heapIndex?: number
  ownershipWatch?: { controller: AbortController }
}

type LeaseReadCause = 'observe' | 'probe-fresh' | 'ownership-released' | 'deadline'
const LEASE_READ_CAUSE_PRIORITY: Readonly<Record<LeaseReadCause, number>> = Object.freeze({
  observe: 0,
  deadline: 1,
  'probe-fresh': 2,
  'ownership-released': 3,
})

type RecoveryRetryPayload =
  | { kind: 'coordinator' }
  | { kind: 'lease-read' }
  | { kind: 'stream'; entry: RecoveryQueueEntry }

const queued = new Map<string, RecoveryQueueEntry>()
const recoveryRuns = new Map<string, RecoveryRun>()
const leaseDeadlines = new Map<string, LeaseDeadlineEntry>()
const leaseDeadlineHeap: LeaseDeadlineEntry[] = []
const pendingLeaseReads = new Map<string, LeaseReadCause>()
const recoveryRetryScheduler = new RecoveryRetryScheduler<RecoveryRetryPayload>(
  handleRecoveryRetryDue,
)
let installed = false
let accepting = false
let running = 0
let pumpScheduled = false
let leaseTimer: ReturnType<typeof setTimeout> | null = null
let leaseTimerAt: number | null = null
let leaseReadPromise: Promise<void> | null = null
let fullLeaseScanRequested = false
let fullLeaseScanCause: LeaseReadCause | null = null
let stopChanges: (() => void) | null = null
let recoveryRuntimeCycle = 0
let recoveryWorkspace: { workspaceId: string; replacementEpoch: number } | null = null
let recoveryAbortController = new AbortController()
let recoveryRuntimeEnabled = false
let coordinatorCycle = 0
let coordinatorAbortController: AbortController | null = null
let coordinatorPromise: Promise<void> | null = null
let coordinatorWorkspaceId: string | null = null
let recoveryRunsIdle: Promise<void> = Promise.resolve()
let resolveRecoveryRunsIdle: (() => void) | null = null

export function installStreamRecoveryRuntime(): void {
  if (installed) return
  installed = true
}

function startRecoveryRuntime(fromRetry = false): void {
  recoveryRuntimeEnabled = true
  if (!fromRetry) recoveryRetryScheduler.clear(COORDINATOR_RETRY_KEY)
  if (accepting) {
    requestFullLeaseScan('probe-fresh')
    return
  }
  if (coordinatorPromise) return
  const cycle = ++coordinatorCycle
  const controller = new AbortController()
  coordinatorAbortController = controller
  const coordinating = runRecoveryCoordinator(cycle, controller.signal)
  coordinatorPromise = coordinating
  const settle = (failure: unknown) => {
    if (coordinatorPromise === coordinating) coordinatorPromise = null
    if (coordinatorAbortController === controller) coordinatorAbortController = null
    if (recoveryRuntimeEnabled && cycle === coordinatorCycle && !controller.signal.aborted) {
      recoveryRetryScheduler.recordFailure(
        COORDINATOR_RETRY_KEY,
        { kind: 'coordinator' },
        coordinatorRetryEvidence(),
        failure,
        OPERATIONAL_RETRY_POLICY,
      )
    }
  }
  void coordinating.then(() => settle(new Error('StreamRecoveryCoordinatorStopped')), settle)
}

async function runRecoveryCoordinator(cycle: number, signal: AbortSignal): Promise<void> {
  const workspace = await runWorkspaceRead(
    'repository-query',
    (permit) => getWorkspaceRepository().query(permit, { kind: 'workspace.meta' }),
    { signal },
  )
  if (!recoveryCoordinatorCurrent(cycle, signal)) return
  coordinatorWorkspaceId = workspace.workspaceId
  await runWithStreamRecoveryCoordinatorLock(workspace.workspaceId, signal, async () => {
    if (!recoveryCoordinatorCurrent(cycle, signal)) return
    const current = await runWorkspaceRead(
      'repository-query',
      (permit) => getWorkspaceRepository().query(permit, { kind: 'workspace.meta' }),
      { signal },
    )
    if (
      !recoveryCoordinatorCurrent(cycle, signal) ||
      current.workspaceId !== workspace.workspaceId
    ) {
      return
    }
    activateRecoveryRuntime()
    await waitForAbort(signal)
    if (cycle === coordinatorCycle) deactivateRecoveryRuntime()
  })
}

function activateRecoveryRuntime(): void {
  if (accepting) return
  recoveryRetryScheduler.clear(COORDINATOR_RETRY_KEY)
  accepting = true
  recoveryRuntimeCycle += 1
  if (recoveryAbortController.signal.aborted) {
    recoveryAbortController = new AbortController()
  }
  stopChanges = subscribeWorkspaceEffects({
    owner: 'stream-recovery-runtime',
    impactKinds: ['workspace', 'stream-lease'],
    replacements: false,
    apply: (effect) => observeWorkspaceEffect(effect),
    recover: (_error, effect) => {
      recoverWorkspaceEffect(effect)
      return WORKSPACE_EFFECT_RECOVERY_OWNED
    },
  })
  requestFullLeaseScan('probe-fresh')
}

function deactivateRecoveryRuntime(): void {
  if (!accepting) return
  accepting = false
  recoveryRuntimeCycle += 1
  recoveryAbortController.abort()
  stopChanges?.()
  stopChanges = null
  queued.clear()
  recoveryRetryScheduler.clearAll()
  clearAllLeaseTracking()
  pendingLeaseReads.clear()
  fullLeaseScanRequested = false
  fullLeaseScanCause = null
  recoveryWorkspace = null
  if (leaseTimer !== null) clearTimeout(leaseTimer)
  leaseTimer = null
  leaseTimerAt = null
}

function stopRecoveryRuntime(): void {
  recoveryRuntimeEnabled = false
  coordinatorCycle += 1
  recoveryRetryScheduler.clearAll()
  coordinatorAbortController?.abort()
  coordinatorAbortController = null
  coordinatorWorkspaceId = null
  deactivateRecoveryRuntime()
}

export function closeStreamRecoveryRuntime(): void {
  stopRecoveryRuntime()
}

export function resumeStreamRecoveryRuntime(): void {
  if (!installed) throw new Error('StreamRecoveryRuntimeNotInstalled')
  startRecoveryRuntime()
}

export function streamRecoveryRuntimeSnapshot(): {
  readonly installed: boolean
  readonly enabled: boolean
  readonly accepting: boolean
  readonly queuedCount: number
  readonly scheduledRetryCount: number
  readonly quarantinedCount: number
} {
  const diagnostics = recoveryRetryScheduler.snapshot()
  return {
    installed,
    enabled: recoveryRuntimeEnabled,
    accepting,
    queuedCount: queued.size,
    scheduledRetryCount: diagnostics.filter((entry) => entry.status === 'scheduled').length,
    quarantinedCount: diagnostics.filter((entry) => entry.status === 'quarantined').length,
  }
}

export function assertStreamRecoveryRuntimeClosed(): void {
  if (
    accepting ||
    recoveryRuntimeEnabled ||
    stopChanges ||
    coordinatorPromise ||
    running !== 0 ||
    queued.size > 0
  ) {
    throw new Error('StreamRecoveryRuntimeNotClosed')
  }
}

export interface StreamRecoveryDiagnostic {
  kind: 'coordinator' | 'lease-read' | 'stream'
  streamId?: string
  status: RecoveryRetryState['status']
  attempts: number
  firstFailureAt: number
  lastFailureAt: number
  nextRetryAt?: number
  diagnostic: RecoveryRetryState['diagnostic']
}

export function streamRecoveryDiagnosticsSnapshot(): readonly StreamRecoveryDiagnostic[] {
  return recoveryRetryScheduler.snapshot().map((entry) => {
    const streamId = streamIdFromRetryKey(entry.key)
    return {
      kind:
        entry.key === COORDINATOR_RETRY_KEY
          ? 'coordinator'
          : entry.key === LEASE_READ_RETRY_KEY
            ? 'lease-read'
            : 'stream',
      ...(streamId === undefined ? {} : { streamId }),
      status: entry.status,
      attempts: entry.attempts,
      firstFailureAt: entry.firstFailureAt,
      lastFailureAt: entry.lastFailureAt,
      ...(entry.nextRetryAt === undefined ? {} : { nextRetryAt: entry.nextRetryAt }),
      diagnostic: { ...entry.diagnostic },
    }
  })
}

export async function awaitStreamRecoveryRuntimeIdle(): Promise<void> {
  for (;;) {
    const coordinator = coordinatorPromise
    const leaseRead = leaseReadPromise
    const runsIdle = recoveryRunsIdle
    const activeRuns = [...recoveryRuns.values()].map((run) => run.promise)
    await Promise.allSettled([
      ...(coordinator ? [coordinator] : []),
      ...(leaseRead ? [leaseRead] : []),
      runsIdle,
      ...activeRuns,
    ])
    if (
      coordinator === coordinatorPromise &&
      leaseRead === leaseReadPromise &&
      running === 0 &&
      recoveryRuns.size === 0
    ) {
      return
    }
  }
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
}

function observeWorkspaceEffect(change: WorkspaceEffect): void {
  if (!accepting) return
  if (change.kind === 'replace') {
    if (coordinatorWorkspaceId !== null && change.workspaceId !== coordinatorWorkspaceId) {
      restartRecoveryCoordinator()
      return
    }
    recoveryRuntimeCycle += 1
    queued.clear()
    recoveryRetryScheduler.clearAll()
    clearAllLeaseTracking()
    recoveryWorkspace = {
      workspaceId: change.workspaceId,
      replacementEpoch: change.replacementEpoch,
    }
    requestFullLeaseScan('probe-fresh')
    return
  }
  observeLeaseInvalidations(change.impact)
}

function recoverWorkspaceEffect(effect: WorkspaceEffect): void {
  if (!accepting) return
  recoveryRuntimeCycle += 1
  queued.clear()
  recoveryRetryScheduler.clearAll()
  clearAllLeaseTracking()
  recoveryWorkspace = {
    workspaceId: effect.workspaceId,
    replacementEpoch: effect.replacementEpoch,
  }
  requestFullLeaseScan('probe-fresh')
}

function restartRecoveryCoordinator(): void {
  if (!recoveryRuntimeEnabled) return
  coordinatorCycle += 1
  recoveryRetryScheduler.clearAll()
  coordinatorAbortController?.abort()
  coordinatorAbortController = null
  coordinatorWorkspaceId = null
  deactivateRecoveryRuntime()
  const restart = () => {
    if (recoveryRuntimeEnabled && !accepting && !coordinatorPromise) startRecoveryRuntime()
  }
  if (coordinatorPromise) void coordinatorPromise.then(restart, restart)
  else queueMicrotask(restart)
}

function observeLeaseInvalidations(dependencies: readonly WorkspaceDependency[] | 'all'): void {
  if (dependencies === 'all') {
    requestFullLeaseScan('probe-fresh')
    return
  }
  if (fullLeaseScanRequested) return
  let pointReadRequested = false
  for (const dependency of dependencies) {
    if (dependency.kind === 'workspace') {
      requestFullLeaseScan('probe-fresh')
      return
    }
    if (dependency.kind !== 'stream-lease') continue
    if (!dependency.streamIds) {
      requestFullLeaseScan('observe')
      return
    }
    for (const streamId of dependency.streamIds) {
      mergePendingLeaseRead(streamId, 'observe')
      pointReadRequested = true
    }
  }
  if (pointReadRequested) ensureLeaseReads()
}

function observeLease(
  lease: StreamLeaseRow,
  cause: LeaseReadCause,
  workspace?: { workspaceId: string; replacementEpoch: number },
): void {
  const wallNow = Date.now()
  const schedulerNow = leaseSchedulerNow()
  const tracked = leaseDeadlines.get(lease.streamId)
  const freshness = observeStreamLeaseFreshness(lease, wallNow, schedulerNow, {
    epoch: tracked?.freshnessEpoch ?? '',
    deadline: tracked?.freshnessDeadline ?? schedulerNow,
  })
  const freshnessEpoch = freshness.epoch
  const freshnessDeadline = freshness.deadline
  const ownershipIdentity = streamOwnershipIdentity(lease)
  const ownedByThisClient =
    streamLeaseHasWriteFence(lease) && lease.ownerClientId === getStreamClientId()
  const entry: RecoveryQueueEntry = {
    streamId: lease.streamId,
    ...(workspace ? { workspaceId: workspace.workspaceId } : {}),
    replacementEpoch: workspace?.replacementEpoch ?? lease.replacementEpoch,
    freshnessEpoch,
    freshnessDeadline,
    evidence: recoveryEvidenceForLease(lease),
  }
  const retryKey = streamRetryKey(lease.streamId)
  const retryEvidence = recoveryRetryScheduler.evidenceFor(retryKey)
  if (retryEvidence === entry.evidence) {
    clearLeaseTracking(lease.streamId)
    return
  }
  if (retryEvidence !== undefined) recoveryRetryScheduler.clear(retryKey)
  if (
    lease.phase === 'canonical' ||
    lease.phase === 'metadata-committed' ||
    lease.custody === 'recovery-pending' ||
    cause === 'ownership-released' ||
    (cause === 'probe-fresh' && !ownedByThisClient) ||
    (cause === 'observe' && tracked === undefined && !ownedByThisClient) ||
    !freshness.fresh
  ) {
    enqueueRecovery(entry)
  }
  const deadline =
    (freshness.fresh ? freshnessDeadline : schedulerNow + STREAM_LEASE_TTL_MS) +
    LEASE_EXPIRY_EPSILON_MS
  setLeaseDeadline({
    streamId: lease.streamId,
    deadline,
    freshnessEpoch,
    freshnessDeadline,
    ownershipIdentity,
    ownershipWatchable: streamLeaseHasWriteFence(lease) && !ownedByThisClient,
    ...(workspace ? { workspaceId: workspace.workspaceId } : {}),
    replacementEpoch: workspace?.replacementEpoch ?? lease.replacementEpoch,
  })
}

function requestFullLeaseScan(cause: LeaseReadCause): void {
  if (!accepting) return
  fullLeaseScanRequested = true
  fullLeaseScanCause = strongerLeaseReadCause(fullLeaseScanCause, cause)
  pendingLeaseReads.clear()
  ensureLeaseReads()
}

function requestLeasePoints(streamIds: readonly string[], cause: LeaseReadCause): void {
  if (!accepting || fullLeaseScanRequested) return
  for (const streamId of streamIds) mergePendingLeaseRead(streamId, cause)
  ensureLeaseReads()
}

function mergePendingLeaseRead(streamId: string, cause: LeaseReadCause): void {
  pendingLeaseReads.set(
    streamId,
    strongerLeaseReadCause(pendingLeaseReads.get(streamId) ?? null, cause),
  )
}

function strongerLeaseReadCause(
  current: LeaseReadCause | null,
  candidate: LeaseReadCause,
): LeaseReadCause {
  if (current === null) return candidate
  return LEASE_READ_CAUSE_PRIORITY[candidate] > LEASE_READ_CAUSE_PRIORITY[current]
    ? candidate
    : current
}

function ensureLeaseReads(fromRetry = false): void {
  if (
    !accepting ||
    leaseReadPromise ||
    (!fromRetry && recoveryRetryScheduler.has(LEASE_READ_RETRY_KEY))
  ) {
    return
  }
  const reading = drainLeaseReads()
  leaseReadPromise = reading
  const clear = () => {
    if (leaseReadPromise === reading) leaseReadPromise = null
    if (accepting) {
      if (
        (fullLeaseScanRequested || pendingLeaseReads.size > 0) &&
        !recoveryRetryScheduler.has(LEASE_READ_RETRY_KEY)
      ) {
        ensureLeaseReads()
      }
      armLeaseTimer()
    }
  }
  void reading.then(clear, clear)
}

async function drainLeaseReads(): Promise<void> {
  while (accepting && (fullLeaseScanRequested || pendingLeaseReads.size > 0)) {
    const cycle = recoveryRuntimeCycle
    const fullScan = fullLeaseScanRequested
    const fullCause = fullLeaseScanCause ?? 'observe'
    fullLeaseScanRequested = false
    fullLeaseScanCause = null
    const pointReads = fullScan ? [] : [...pendingLeaseReads]
    const streamIds = pointReads.map(([streamId]) => streamId)
    if (!fullScan) pendingLeaseReads.clear()
    try {
      if (fullScan) {
        const envelope = await runWorkspaceRead('repository-query', async (permit) =>
          getWorkspaceRepository().query(permit, { kind: 'stream.leases' }),
        )
        if (!recoveryReadCurrent(cycle)) continue
        recoveryWorkspace = envelope
        clearAllLeaseTracking()
        const retained = new Set<string>()
        for (const lease of envelope.value) {
          if (lease.replacementEpoch !== envelope.replacementEpoch) continue
          retained.add(lease.streamId)
          observeLease(lease, fullCause, envelope)
        }
        for (const streamId of queued.keys()) {
          if (!retained.has(streamId)) queued.delete(streamId)
        }
        retainRecoveryRetries(retained)
      } else {
        const envelope = await runWorkspaceRead('repository-query', async (permit) =>
          getWorkspaceRepository().query(permit, { kind: 'stream.leases-by-id', streamIds }),
        )
        if (!recoveryReadCurrent(cycle)) continue
        if (
          !recoveryWorkspace ||
          recoveryWorkspace.workspaceId !== envelope.workspaceId ||
          recoveryWorkspace.replacementEpoch !== envelope.replacementEpoch
        ) {
          recoveryWorkspace = envelope
          requestFullLeaseScan('probe-fresh')
          continue
        }
        for (let index = 0; index < streamIds.length; index += 1) {
          const streamId = streamIds[index]
          if (!streamId) continue
          const lease = envelope.value[index]
          if (
            !lease ||
            lease.streamId !== streamId ||
            lease.replacementEpoch !== envelope.replacementEpoch
          ) {
            clearLeaseTracking(streamId)
            queued.delete(streamId)
            recoveryRetryScheduler.clear(streamRetryKey(streamId))
            continue
          }
          observeLease(lease, pointReads[index]?.[1] ?? 'observe', envelope)
        }
      }
    } catch (error) {
      if (!recoveryReadCurrent(cycle)) continue
      if (fullScan) {
        fullLeaseScanRequested = true
        fullLeaseScanCause = strongerLeaseReadCause(fullLeaseScanCause, fullCause)
      } else {
        for (const [streamId, cause] of pointReads) mergePendingLeaseRead(streamId, cause)
      }
      recoveryRetryScheduler.recordFailure(
        LEASE_READ_RETRY_KEY,
        { kind: 'lease-read' },
        leaseReadRetryEvidence(),
        error,
        OPERATIONAL_RETRY_POLICY,
      )
      return
    }
  }
  recoveryRetryScheduler.clear(LEASE_READ_RETRY_KEY)
}

function setLeaseDeadline(entry: LeaseDeadlineEntry): void {
  const current = leaseDeadlines.get(entry.streamId)
  if (current) {
    if (current.ownershipIdentity !== entry.ownershipIdentity || !entry.ownershipWatchable) {
      current.ownershipWatch?.controller.abort()
      delete current.ownershipWatch
    }
    current.deadline = entry.deadline
    current.freshnessEpoch = entry.freshnessEpoch
    current.freshnessDeadline = entry.freshnessDeadline
    current.ownershipIdentity = entry.ownershipIdentity
    current.ownershipWatchable = entry.ownershipWatchable
    if (entry.workspaceId === undefined) delete current.workspaceId
    else current.workspaceId = entry.workspaceId
    if (entry.replacementEpoch === undefined) delete current.replacementEpoch
    else current.replacementEpoch = entry.replacementEpoch
    if (current.heapIndex === undefined) pushLeaseDeadline(current)
    else repairLeaseDeadline(current.heapIndex)
    armLeaseTimer()
    return
  }
  leaseDeadlines.set(entry.streamId, entry)
  pushLeaseDeadline(entry)
  armLeaseTimer()
}

function clearLeaseTracking(streamId: string): void {
  const entry = leaseDeadlines.get(streamId)
  entry?.ownershipWatch?.controller.abort()
  if (entry?.heapIndex !== undefined) removeLeaseDeadlineAt(entry.heapIndex)
  leaseDeadlines.delete(streamId)
}

function clearAllLeaseTracking(): void {
  for (const entry of leaseDeadlines.values()) {
    entry.ownershipWatch?.controller.abort()
    delete entry.heapIndex
  }
  leaseDeadlines.clear()
  leaseDeadlineHeap.length = 0
}

function armLeaseTimer(): void {
  if (!accepting) return
  const nextAt = leaseDeadlineHeap[0]?.deadline ?? null
  if (nextAt === null) {
    if (leaseTimer !== null) clearTimeout(leaseTimer)
    leaseTimer = null
    leaseTimerAt = null
    return
  }
  if (leaseTimer !== null && leaseTimerAt !== null && leaseTimerAt <= nextAt) return
  if (leaseTimer !== null) clearTimeout(leaseTimer)
  leaseTimerAt = nextAt
  leaseTimer = setTimeout(runLeaseTimer, Math.max(0, nextAt - leaseSchedulerNow()))
}

function runLeaseTimer(): void {
  leaseTimer = null
  leaseTimerAt = null
  if (!accepting) return
  const now = leaseSchedulerNow()
  const due = new Set<string>()
  while (leaseDeadlineHeap[0] && leaseDeadlineHeap[0].deadline <= now) {
    const entry = popLeaseDeadline()
    if (!entry) break
    due.add(entry.streamId)
  }
  if (due.size > 0) requestLeasePoints([...due], 'deadline')
  armLeaseTimer()
}

function pushLeaseDeadline(entry: LeaseDeadlineEntry): void {
  if (entry.heapIndex !== undefined) return
  entry.heapIndex = leaseDeadlineHeap.length
  leaseDeadlineHeap.push(entry)
  bubbleLeaseDeadlineUp(entry.heapIndex)
}

function popLeaseDeadline(): LeaseDeadlineEntry | undefined {
  return removeLeaseDeadlineAt(0)
}

function removeLeaseDeadlineAt(index: number): LeaseDeadlineEntry | undefined {
  const removed = leaseDeadlineHeap[index]
  if (!removed) return undefined
  const last = leaseDeadlineHeap.pop() as LeaseDeadlineEntry
  delete removed.heapIndex
  if (index < leaseDeadlineHeap.length) {
    leaseDeadlineHeap[index] = last
    last.heapIndex = index
    repairLeaseDeadline(index)
  }
  return removed
}

function repairLeaseDeadline(index: number): void {
  const parent = Math.floor((index - 1) / 2)
  const current = leaseDeadlineHeap[index] as LeaseDeadlineEntry
  const parentEntry = leaseDeadlineHeap[parent] as LeaseDeadlineEntry
  if (index > 0 && current.deadline < parentEntry.deadline) {
    bubbleLeaseDeadlineUp(index)
  } else {
    sinkLeaseDeadlineDown(index)
  }
}

function bubbleLeaseDeadlineUp(start: number): void {
  let index = start
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2)
    const parentEntry = leaseDeadlineHeap[parent] as LeaseDeadlineEntry
    const current = leaseDeadlineHeap[index] as LeaseDeadlineEntry
    if (parentEntry.deadline <= current.deadline) break
    swapLeaseDeadlines(index, parent)
    index = parent
  }
}

function sinkLeaseDeadlineDown(start: number): void {
  let index = start
  for (;;) {
    const left = index * 2 + 1
    const right = left + 1
    if (left >= leaseDeadlineHeap.length) return
    const leftEntry = leaseDeadlineHeap[left] as LeaseDeadlineEntry
    const child =
      right < leaseDeadlineHeap.length &&
      (leaseDeadlineHeap[right] as LeaseDeadlineEntry).deadline < leftEntry.deadline
        ? right
        : left
    const current = leaseDeadlineHeap[index] as LeaseDeadlineEntry
    const childEntry = leaseDeadlineHeap[child] as LeaseDeadlineEntry
    if (current.deadline <= childEntry.deadline) return
    swapLeaseDeadlines(index, child)
    index = child
  }
}

function swapLeaseDeadlines(left: number, right: number): void {
  const leftEntry = leaseDeadlineHeap[left] as LeaseDeadlineEntry
  const rightEntry = leaseDeadlineHeap[right] as LeaseDeadlineEntry
  leaseDeadlineHeap[left] = rightEntry
  leaseDeadlineHeap[right] = leftEntry
  rightEntry.heapIndex = left
  leftEntry.heapIndex = right
}

function enqueueRecovery(entry: RecoveryQueueEntry): void {
  if (!accepting) return
  const retryKey = streamRetryKey(entry.streamId)
  const retryEvidence = recoveryRetryScheduler.evidenceFor(retryKey)
  if (retryEvidence === entry.evidence) return
  if (retryEvidence !== undefined) recoveryRetryScheduler.clear(retryKey)
  const active = recoveryRuns.get(entry.streamId)
  if (active) {
    if (active.coordinatorEvidence !== entry.evidence) queued.set(entry.streamId, entry)
    return
  }
  queued.set(entry.streamId, entry)
  scheduleRecoveryPump()
}

function enqueueScheduledRecovery(entry: RecoveryQueueEntry, evidence: string): void {
  if (!accepting || entry.evidence !== evidence) return
  const active = recoveryRuns.get(entry.streamId)
  if (active) {
    if (active.coordinatorEvidence !== entry.evidence) queued.set(entry.streamId, entry)
    return
  }
  queued.set(entry.streamId, entry)
  scheduleRecoveryPump()
}

function scheduleRecoveryPump(): void {
  if (!accepting || pumpScheduled || running >= RECOVERY_CONCURRENCY || queued.size === 0) return
  pumpScheduled = true
  queueMicrotask(() => {
    pumpScheduled = false
    pumpRecoveryQueue()
  })
}

function pumpRecoveryQueue(): void {
  while (accepting && running < RECOVERY_CONCURRENCY && queued.size > 0) {
    const next = takeRunnableRecoveryEntry()
    if (!next) return
    const [streamId, entry] = next
    if (running === 0) {
      recoveryRunsIdle = new Promise<void>((resolve) => {
        resolveRecoveryRunsIdle = resolve
      })
    }
    running += 1
    const cycle = recoveryRuntimeCycle
    const signal = recoveryAbortController.signal
    const run = getOrStartRecovery(entry, Date.now(), signal)
    run.coordinatorEvidence = entry.evidence
    void run.promise
      .then((result) => {
        if (result === 'retry' && accepting && cycle === recoveryRuntimeCycle) {
          scheduleStreamRecoveryFailure(entry, new Error('StreamRecoveryConflict'))
        } else if (result === 'deferred' && accepting && cycle === recoveryRuntimeCycle) {
          recoveryRetryScheduler.clear(streamRetryKey(streamId))
          watchOwnershipRelease(streamId)
        } else if (accepting && cycle === recoveryRuntimeCycle) {
          recoveryRetryScheduler.clear(streamRetryKey(streamId))
          clearLeaseTracking(streamId)
        }
      })
      .catch((error) => {
        if (accepting && cycle === recoveryRuntimeCycle) scheduleStreamRecoveryFailure(entry, error)
      })
      .finally(() => {
        running -= 1
        if (running === 0) {
          const resolveIdle = resolveRecoveryRunsIdle
          resolveRecoveryRunsIdle = null
          resolveIdle?.()
        }
        if (accepting && cycle === recoveryRuntimeCycle) {
          scheduleRecoveryPump()
        } else if (accepting) requestFullLeaseScan('probe-fresh')
      })
  }
}

function takeRunnableRecoveryEntry(): [string, RecoveryQueueEntry] | undefined {
  for (const entry of queued) {
    const active = recoveryRuns.get(entry[0])
    if (
      active &&
      (active.coordinatorEvidence !== undefined || !runAcceptsCoordinatorEntry(active, entry[1]))
    ) {
      continue
    }
    queued.delete(entry[0])
    return entry
  }
  return undefined
}

function sameRecoveryScope(left: OrphanRecoveryPoint, right: OrphanRecoveryPoint): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.replacementEpoch === right.replacementEpoch &&
    left.freshnessEpoch === right.freshnessEpoch &&
    left.freshnessDeadline === right.freshnessDeadline
  )
}

function runAcceptsCoordinatorEntry(run: RecoveryRun, entry: RecoveryQueueEntry): boolean {
  return (
    (run.point.workspaceId === undefined || run.point.workspaceId === entry.workspaceId) &&
    (run.point.replacementEpoch === undefined ||
      run.point.replacementEpoch === entry.replacementEpoch) &&
    (run.point.freshnessEpoch === undefined || run.point.freshnessEpoch === entry.freshnessEpoch) &&
    (run.point.freshnessDeadline === undefined ||
      run.point.freshnessDeadline === entry.freshnessDeadline)
  )
}

function watchOwnershipRelease(streamId: string): void {
  const deadline = leaseDeadlines.get(streamId)
  if (!deadline || !deadline.ownershipWatchable || deadline.ownershipWatch) return
  const watch = { controller: new AbortController() }
  deadline.ownershipWatch = watch
  void waitForStreamOwnershipRelease(streamId, watch.controller.signal).then((released) => {
    const current = leaseDeadlines.get(streamId)
    if (current?.ownershipWatch !== watch) return
    delete current.ownershipWatch
    if (released && accepting) requestLeasePoints([streamId], 'ownership-released')
  })
}

function scheduleStreamRecoveryFailure(entry: RecoveryQueueEntry, failure: unknown): void {
  const newer = queued.get(entry.streamId)
  const retryEntry = newer ?? entry
  if (newer) queued.delete(entry.streamId)
  clearLeaseTracking(entry.streamId)
  recoveryRetryScheduler.recordFailure(
    streamRetryKey(entry.streamId),
    { kind: 'stream', entry: retryEntry },
    retryEntry.evidence,
    failure,
    RECOVERY_RETRY_POLICY,
  )
}

async function scheduleUncoordinatedRecoveryFailure(
  run: RecoveryRun,
  failure: unknown,
): Promise<void> {
  const cycle = recoveryRuntimeCycle
  if (!recoveryReadCurrent(cycle) || recoveryRunIsCoordinated(run)) return
  try {
    const current = await runWorkspaceRead('repository-query', async (permit) => {
      const repo = getWorkspaceRepository()
      const [workspace, lease] = await Promise.all([
        repo.query(permit, { kind: 'workspace.meta' }),
        repo.query(permit, { kind: 'stream.lease', streamId: run.point.streamId }),
      ])
      return { workspace, lease: lease.value }
    })
    if (
      !recoveryReadCurrent(cycle) ||
      recoveryRunIsCoordinated(run) ||
      !current.lease ||
      current.lease.replacementEpoch !== current.workspace.replacementEpoch
    ) {
      return
    }
    if (queued.has(run.point.streamId)) return
    const schedulerNow = leaseSchedulerNow()
    const entry: RecoveryQueueEntry = {
      streamId: current.lease.streamId,
      workspaceId: current.workspace.workspaceId,
      replacementEpoch: current.workspace.replacementEpoch,
      freshnessEpoch: streamLeaseFreshnessEpoch(current.lease),
      freshnessDeadline: schedulerNow,
      evidence: recoveryEvidenceForLease(current.lease),
    }
    queued.delete(entry.streamId)
    clearLeaseTracking(entry.streamId)
    recoveryRetryScheduler.recordFailure(
      streamRetryKey(entry.streamId),
      { kind: 'stream', entry },
      entry.evidence,
      failure,
      RECOVERY_RETRY_POLICY,
    )
  } catch {
    // The coordinator's existing lease scan/retry path remains authoritative if this read races shutdown.
  }
}

function recoveryRunIsCoordinated(run: RecoveryRun): boolean {
  return run.coordinatorEvidence !== undefined
}

function handleRecoveryRetryDue(
  key: string,
  payload: RecoveryRetryPayload,
  evidence: string,
): void {
  if (payload.kind === 'coordinator') {
    if (key === COORDINATOR_RETRY_KEY && recoveryRuntimeEnabled && !coordinatorPromise) {
      startRecoveryRuntime(true)
    }
    return
  }
  if (payload.kind === 'lease-read') {
    if (key === LEASE_READ_RETRY_KEY && accepting) ensureLeaseReads(true)
    return
  }
  if (key === streamRetryKey(payload.entry.streamId)) {
    enqueueScheduledRecovery(payload.entry, evidence)
  }
}

function recoveryEvidenceForLease(lease: StreamLeaseRow): string {
  const dispatch = streamLeaseDispatchEvidence(lease)
  return JSON.stringify([
    lease.custody,
    ...(streamLeaseHasWriteFence(lease)
      ? [lease.ownerClientId, lease.fenceToken]
      : [lease.handoffId, lease.handedOffAt, lease.handoffReason]),
    lease.replacementEpoch,
    lease.admissionSequence,
    lease.streamId,
    lease.messageId,
    lease.attemptKind,
    lease.phase,
    dispatch?.targetCommittedAt ?? null,
    lease.canonicalAt ?? null,
    lease.metadataCommittedAt ?? null,
    dispatch && 'baseNodeVersion' in dispatch ? dispatch.baseNodeVersion : null,
    dispatch && 'baseBodyVersion' in dispatch ? dispatch.baseBodyVersion : null,
    lease.phase === 'canonical' || lease.phase === 'metadata-committed' ? 1 : 0,
    lease.postCommit.final?.expectedNodeVersion ?? null,
    lease.postCommit.final?.expectedBodyVersion ?? null,
  ])
}

function streamOwnershipIdentity(lease: StreamLeaseRow): string {
  return JSON.stringify(
    streamLeaseHasWriteFence(lease)
      ? [
          lease.custody,
          lease.ownerClientId,
          lease.fenceToken,
          lease.replacementEpoch,
          lease.admissionSequence,
        ]
      : [lease.custody, lease.handoffId, lease.replacementEpoch, lease.admissionSequence],
  )
}

function coordinatorRetryEvidence(): string {
  return coordinatorWorkspaceId ?? recoveryWorkspace?.workspaceId ?? 'workspace-unavailable'
}

function recoveryCoordinatorCurrent(cycle: number, signal: AbortSignal): boolean {
  return recoveryRuntimeEnabled && !signal.aborted && cycle === coordinatorCycle
}

function recoveryReadCurrent(cycle: number): boolean {
  return accepting && cycle === recoveryRuntimeCycle
}

function leaseReadRetryEvidence(): string {
  if (recoveryWorkspace) {
    return `${recoveryWorkspace.workspaceId}:${recoveryWorkspace.replacementEpoch}`
  }
  return coordinatorRetryEvidence()
}

function retainRecoveryRetries(retainedStreamIds: ReadonlySet<string>): void {
  recoveryRetryScheduler.retain((key) => {
    const streamId = streamIdFromRetryKey(key)
    return streamId === undefined || retainedStreamIds.has(streamId)
  })
}

function streamRetryKey(streamId: string): string {
  return `${STREAM_RETRY_PREFIX}${streamId}`
}

function streamIdFromRetryKey(key: string): string | undefined {
  return key.startsWith(STREAM_RETRY_PREFIX) ? key.slice(STREAM_RETRY_PREFIX.length) : undefined
}
