import Dexie from 'dexie'
import {
  WorkspaceReplacementCommittedRecoveryRequiredError,
  WorkspaceReplacementOutcomeUnknownError,
  WorkspaceReplacementUncommittedRecoveryRequiredError,
} from '../core/import-export/errors'
import { postWorkspaceChange } from './broadcast'
import type {
  BrowserWorkspaceOnlineReplacementOperation,
  BrowserWorkspaceReplacementAtomicity,
  BrowserWorkspaceReplacementCommit,
  BrowserWorkspaceReplacementContext,
  BrowserWorkspaceReplacementMutationGrant,
  BrowserWorkspaceReplacementOperation,
  BrowserWorkspaceReplacementReopenOutcome,
  BrowserWorkspaceReplacementRuntimeRequest,
  BrowserWorkspaceSnapshot,
} from './browser-workspace-contract'
import { cleanPendingBrowserWorkspaceDatabase } from './browser-workspace-database-cleanup'
import {
  abandonPreparedBrowserWorkspaceDatabase,
  activatePreparedBrowserWorkspaceDatabase,
  applyUnslottedBrowserWorkspaceReplacementStorageBaseline,
  BrowserWorkspaceActivationOutcomeUncertainError,
  type BrowserWorkspaceReplacementPreparing,
  tryBeginBrowserWorkspaceDatabaseReplacement,
} from './browser-workspace-database-control'
import type {
  BrowserWorkspaceReplacementStart,
  BrowserWorkspaceReplacementTerminalOutcome,
} from './browser-workspace-maintenance-contract'
import type { BrowserWorkspaceOpenTarget } from './browser-workspace-open-contract'

export type {
  BrowserWorkspaceReplacementHandoff,
  BrowserWorkspaceReplacementStart,
} from './browser-workspace-maintenance-contract'

import {
  type BrowserWorkspaceReplacementOutcome,
  type BrowserWorkspaceReplacementTransitionController,
  createBrowserWorkspaceReplacementTransitionController,
} from './browser-workspace-replacement-transition'
import {
  type BrowserWorkspaceSelectionGrant,
  browserWorkspaceSlotSwitchingSupported,
  tryWithBrowserWorkspaceSelectionGate,
  withBrowserWorkspaceSelectionGate,
  withBrowserWorkspaceSlotRound,
  withExclusiveBrowserWorkspaceSlots,
} from './browser-workspace-slot-coordination'
import {
  type BrowserWorkspaceSession,
  getBrowserWorkspaceSession,
  NatterDb,
  prepareBrowserWorkspaceSchema,
  recreateAndVerifyBrowserWorkspaceDatabase,
} from './db'
import {
  type LockGrant,
  withExclusiveGenerationLifetime,
  withQuiescedWorkspaceReplacementLock,
} from './locks'
import { readBrowserWorkspaceMeta, seedBrowserWorkspaceReplacementMeta } from './workspace-meta'
import {
  awaitWorkspaceForegroundDemandIdle,
  claimWorkspaceReplacementContinuation,
  isWorkspaceReplacementContenderPreemptedError,
  preemptWorkspaceMaintenancePreparation,
  releaseWorkspaceReplacementContinuation,
  runWorkspaceAction,
  runWorkspaceRead,
  tryRunWorkspaceActionIfIdle,
  WorkspaceMaintenancePreemptedError,
  type WorkspaceReconcileAuthority,
  type WorkspaceReplacementContinuation,
  type WorkspaceRuntimeActionOptions,
  type WorkspaceWritePermit,
  waitForWorkspaceRuntimeReplacementBlockers,
  workspaceForegroundDemandInterruptionSignal,
} from './workspace-runtime'
import {
  awaitWorkspaceRuntimeQuiesced,
  getWorkspaceRuntimeControlSnapshot,
  launchRequiredWorkspaceRuntimeReplacementNow,
  tryLaunchMaintenanceWorkspaceRuntimeReplacementIfIdle,
} from './workspace-runtime-control'

let settleBrowserWorkspace:
  | ((
      request: BrowserWorkspaceReplacementRuntimeRequest,
      continuation: WorkspaceReplacementContinuation,
    ) => Promise<BrowserWorkspaceReplacementReopenOutcome>)
  | null = null

export function installBrowserWorkspaceReplacementSettlement(
  settle: (
    request: BrowserWorkspaceReplacementRuntimeRequest,
    continuation: WorkspaceReplacementContinuation,
  ) => Promise<BrowserWorkspaceReplacementReopenOutcome>,
): void {
  settleBrowserWorkspace = settle
}

type BrowserWorkspaceReplacementPreflight = (
  session: BrowserWorkspaceSession,
) => boolean | Promise<boolean>

type BrowserWorkspaceReplacementLaunchPolicy =
  | {
      readonly admission: 'required'
      readonly admissionOptions: WorkspaceRuntimeActionOptions
      readonly promote: () => WorkspaceReconcileAuthority | null
    }
  | {
      readonly admission: 'if-idle'
      readonly admissionOptions: WorkspaceRuntimeActionOptions
      readonly promote: () => WorkspaceReconcileAuthority | null
    }

interface BrowserWorkspaceReplacementPromoted<T> {
  readonly kind: 'promoted'
  readonly transition: BrowserWorkspaceReplacementTransitionController<T>
}

type BrowserWorkspaceReplacementWork<T> =
  | {
      readonly kind: 'quiesced'
      readonly continuation: WorkspaceReplacementContinuation
      readonly operation: BrowserWorkspaceReplacementOperation<T>
    }
  | {
      readonly kind: 'online'
      readonly continuation: WorkspaceReplacementContinuation
      readonly operation: BrowserWorkspaceOnlineReplacementOperation<unknown, T>
    }

function quiescedBrowserWorkspaceReplacementWork<T>(
  operation: BrowserWorkspaceReplacementOperation<T>,
  continuation: WorkspaceReplacementContinuation,
): BrowserWorkspaceReplacementWork<T> {
  return { kind: 'quiesced', operation, continuation } satisfies BrowserWorkspaceReplacementWork<T>
}

function onlineBrowserWorkspaceReplacementWork<Prepared, T>(
  operation: BrowserWorkspaceOnlineReplacementOperation<Prepared, T>,
  continuation: WorkspaceReplacementContinuation,
): BrowserWorkspaceReplacementWork<T> {
  return {
    kind: 'online',
    continuation,
    operation: operation,
  } satisfies BrowserWorkspaceReplacementWork<T>
}

type BrowserWorkspaceReplacementLaunchResult<T> =
  | { readonly kind: 'blocked' }
  | { readonly kind: 'cleanup-required' }
  | { readonly kind: 'skipped' }
  | BrowserWorkspaceReplacementPromoted<T>

export async function runBrowserWorkspaceReplacement<T>(
  preflight: BrowserWorkspaceReplacementPreflight,
  operation: BrowserWorkspaceReplacementOperation<T>,
  options: WorkspaceRuntimeActionOptions = {},
): Promise<BrowserWorkspaceReplacementCommit<T>> {
  for (;;) {
    try {
      const started = await runWorkspaceAction(
        'workspace-replacement',
        (permit) => {
          preemptWorkspaceMaintenancePreparation(permit)
          const continuation = claimWorkspaceReplacementContinuation(permit)
          const authorityOptions = { signal: permit.signal, lineageId: permit.lineageId }
          return launchBrowserWorkspaceReplacement(
            {
              admission: 'required',
              admissionOptions: authorityOptions,
              promote: () =>
                launchRequiredWorkspaceRuntimeReplacementNow({
                  continuation,
                  lineageId: permit.lineageId,
                }),
            },
            preflight,
            quiescedBrowserWorkspaceReplacementWork(operation, continuation),
          )
        },
        options,
      )
      if (started.kind === 'skipped') {
        throw new Error('BrowserWorkspaceReplacementPreflightSkipped')
      }
      if (started.kind === 'blocked') {
        throw new Error('BrowserWorkspaceReplacementAdmissionBlocked')
      }
      if (started.kind === 'cleanup-required') {
        throw new Error('BrowserWorkspaceReplacementCleanupRequired')
      }
      if (started.kind === 'cancelled') throw started.reason
      return started.handoff.completion.then(unwrapBrowserWorkspaceReplacementOutcome)
    } catch (error) {
      if (!isWorkspaceReplacementContenderPreemptedError(error)) throw error
      await runWorkspaceRead('workspace-replacement', () => undefined, options)
    }
  }
}

export function tryStartBrowserWorkspaceOnlineReplacementIfIdle<Prepared, T>(
  preflight: BrowserWorkspaceReplacementPreflight,
  operation: BrowserWorkspaceOnlineReplacementOperation<Prepared, T>,
  options: WorkspaceRuntimeActionOptions = {},
): Promise<BrowserWorkspaceReplacementStart<T>> {
  const started = tryRunWorkspaceActionIfIdle(
    'maintenance',
    (permit) => {
      const continuation = claimWorkspaceReplacementContinuation(permit)
      return launchBrowserWorkspaceReplacement(
        maintenanceReplacementPolicy(permit, continuation),
        preflight,
        onlineBrowserWorkspaceReplacementWork(operation, continuation),
      )
    },
    options,
  )
  return started ?? Promise.resolve({ kind: 'blocked' })
}

function maintenanceReplacementPolicy(
  permit: WorkspaceWritePermit,
  continuation: WorkspaceReplacementContinuation,
): BrowserWorkspaceReplacementLaunchPolicy {
  return {
    admission: 'if-idle',
    admissionOptions: { signal: permit.signal, lineageId: permit.lineageId },
    promote: () =>
      tryLaunchMaintenanceWorkspaceRuntimeReplacementIfIdle({
        continuation,
        lineageId: permit.lineageId,
      }),
  }
}

function launchBrowserWorkspaceReplacement<T>(
  policy: BrowserWorkspaceReplacementLaunchPolicy,
  preflight: BrowserWorkspaceReplacementPreflight,
  work: BrowserWorkspaceReplacementWork<T>,
): Promise<BrowserWorkspaceReplacementStart<T>> {
  return Dexie.ignoreTransaction(() => {
    let handedOff = false
    let resolveCompletion!: (outcome: BrowserWorkspaceReplacementTerminalOutcome<T>) => void
    let rejectCompletion!: (error: unknown) => void
    return new Promise<BrowserWorkspaceReplacementStart<T>>((resolve, reject) => {
      const transferHandoff = () => {
        if (handedOff) return
        handedOff = true
        const completion = new Promise<BrowserWorkspaceReplacementTerminalOutcome<T>>(
          (resolveOutcome, rejectOutcome) => {
            resolveCompletion = resolveOutcome
            rejectCompletion = rejectOutcome
          },
        )
        void completion.catch(() => undefined)
        resolve({ kind: 'handoff', handoff: { completion } })
      }
      const executing = performBrowserWorkspaceReplacementLaunch(
        policy,
        preflight,
        work,
        transferHandoff,
      )
        .then(
          async (result) => {
            if (result.kind !== 'promoted') {
              resolve(result)
              return
            }
            const outcome = await result.transition.finalize()
            if (outcome.kind === 'online-ready')
              throw new Error('BrowserWorkspaceTerminalOutcomeRequired')
            resolveCompletion(outcome)
          },
          async (error: unknown) => {
            if (error instanceof WorkspaceReplacementCommittedRecoveryRequiredError) {
              transferHandoff()
              rejectCompletion(error)
              return
            }
            if (error instanceof WorkspaceReplacementUncommittedRecoveryRequiredError) {
              transferHandoff()
              resolveCompletion({ kind: 'uncommitted-recovery-required', failures: error.errors })
              return
            }
            if (error instanceof WorkspaceReplacementOutcomeUnknownError) {
              transferHandoff()
              resolveCompletion({ kind: 'outcome-unknown', failures: error.errors })
              return
            }
            if (work.continuation.signal.aborted && error === work.continuation.signal.reason) {
              if (!handedOff) resolve({ kind: 'cancelled', reason: error })
              else {
                try {
                  const settled = await settleCurrentBrowserWorkspace(
                    { kind: 'observe-cancellation' },
                    work.continuation,
                  )
                  resolveCompletion({
                    kind: 'cancelled',
                    reason: error,
                    readiness: settled.kind === 'ready' ? 'ready' : 'closed',
                  })
                } catch (settlementFailure) {
                  resolveCompletion({
                    kind: 'uncommitted-recovery-required',
                    failures: [error, settlementFailure],
                  })
                }
              }
              return
            }
            const failure = browserWorkspaceReplacementError(error)
            if (handedOff) rejectCompletion(failure)
            else reject(failure)
          },
        )
        .finally(() => {
          releaseWorkspaceReplacementContinuation(work.continuation)
        })
      void executing.catch((error: unknown) => {
        const failure = browserWorkspaceReplacementError(error)
        if (handedOff) rejectCompletion(failure)
        else reject(failure)
      })
    })
  })
}

async function performBrowserWorkspaceReplacementLaunch<T>(
  policy: BrowserWorkspaceReplacementLaunchPolicy,
  preflight: BrowserWorkspaceReplacementPreflight,
  work: BrowserWorkspaceReplacementWork<T>,
  transferHandoff: () => void,
): Promise<BrowserWorkspaceReplacementLaunchResult<T>> {
  for (;;) {
    const snapshot = getWorkspaceRuntimeControlSnapshot()
    if (snapshot.state !== 'RUNNING') {
      if (policy.admission === 'if-idle') return { kind: 'blocked' }
      await runWorkspaceRead('import-export', () => undefined, policy.admissionOptions)
      continue
    }
    const attempt = await runBrowserWorkspaceReplacementSelectionAttempt(
      policy,
      preflight,
      work,
      transferHandoff,
    )
    if (attempt.kind === 'cleanup-required' && policy.admission === 'required') {
      const cleanup = await cleanPendingBrowserWorkspaceDatabase(policy.admissionOptions.signal)
      if (cleanup.status === 'preparing') continue
      continue
    }
    if (attempt.kind !== 'blocked' || policy.admission === 'if-idle') return attempt
    await runWorkspaceRead('import-export', () => undefined, policy.admissionOptions)
  }
}

async function runBrowserWorkspaceReplacementSelectionAttempt<T>(
  policy: BrowserWorkspaceReplacementLaunchPolicy,
  preflight: BrowserWorkspaceReplacementPreflight,
  work: BrowserWorkspaceReplacementWork<T>,
  transferHandoff: () => void,
): Promise<
  | { readonly kind: 'blocked' }
  | { readonly kind: 'cleanup-required' }
  | { readonly kind: 'skipped' }
  | BrowserWorkspaceReplacementPromoted<T>
> {
  if (policy.admission === 'required') {
    return withBrowserWorkspaceSelectionGate(
      (selection) =>
        runGatedBrowserWorkspaceReplacementAttempt(
          selection,
          policy,
          preflight,
          work,
          transferHandoff,
        ),
      policy.admissionOptions.signal,
    )
  }
  const result = await tryWithBrowserWorkspaceSelectionGate(
    (selection) =>
      runGatedBrowserWorkspaceReplacementAttempt(
        selection,
        policy,
        preflight,
        work,
        transferHandoff,
      ),
    policy.admissionOptions.signal,
  )
  return result.acquired ? result.value : { kind: 'blocked' }
}

async function runGatedBrowserWorkspaceReplacementAttempt<T>(
  selection: BrowserWorkspaceSelectionGrant,
  policy: BrowserWorkspaceReplacementLaunchPolicy,
  preflight: BrowserWorkspaceReplacementPreflight,
  work: BrowserWorkspaceReplacementWork<T>,
  transferHandoff: () => void,
): Promise<
  | { readonly kind: 'blocked' }
  | { readonly kind: 'cleanup-required' }
  | { readonly kind: 'skipped' }
  | BrowserWorkspaceReplacementPromoted<T>
> {
  if (policy.admissionOptions.signal?.aborted) throw policy.admissionOptions.signal.reason
  const snapshot = getWorkspaceRuntimeControlSnapshot()
  if (snapshot.state !== 'RUNNING' || snapshot.workspaceId === null) return { kind: 'blocked' }
  const session = getBrowserWorkspaceSession()
  if (work.kind === 'online') {
    await awaitWorkspaceForegroundDemandIdle(policy.admissionOptions.signal)
  }
  if (!(await preflight(session))) return { kind: 'skipped' }
  if (policy.admissionOptions.signal?.aborted) throw policy.admissionOptions.signal.reason
  if (work.kind === 'online') {
    await awaitWorkspaceForegroundDemandIdle(policy.admissionOptions.signal)
  }
  const databaseName = session.databaseName
  const originalWorkspace = workspaceSnapshot({
    workspaceId: snapshot.workspaceId,
    replacementEpoch: snapshot.replacementEpoch,
  })
  if (!browserWorkspaceSlotSwitchingSupported()) {
    const authority = launchReplacementAuthority(policy)
    if (!authority) return { kind: 'blocked' }
    transferHandoff()
    const transition = await runUnslottedBrowserWorkspaceReplacement(
      authority,
      databaseName,
      originalWorkspace,
      work.continuation,
      work.kind === 'quiesced'
        ? work.operation
        : () => Promise.reject(new Error('BrowserWorkspaceOnlineReplacementRequiresSlots')),
    )
    await transition.settleSelection()
    return { kind: 'promoted', transition }
  }
  const begin = await tryBeginBrowserWorkspaceDatabaseReplacement()
  if (begin.kind === 'occupied') {
    return begin.journal.phase === 'preparing' && policy.admission === 'if-idle'
      ? { kind: 'blocked' }
      : { kind: 'cleanup-required' }
  }
  const journal = begin.journal
  let ownsStaging = true
  try {
    if (journal.sourceDatabaseName !== databaseName) {
      throw new Error(
        `BrowserWorkspaceControlSourceMismatch:${databaseName}:${journal.sourceDatabaseName}`,
      )
    }
    if (work.kind === 'online') {
      await awaitWorkspaceForegroundDemandIdle(policy.admissionOptions.signal)
    }
    await prepareSlottedDestination(selection, journal, originalWorkspace, work.continuation.signal)
    const onlinePrepared =
      work.kind === 'online'
        ? await runOnlineSlottedReplacement(
            selection,
            journal,
            work.operation.prepare,
            policy.admissionOptions.signal,
          )
        : undefined
    let transition = await runReplacementRound(
      selection,
      policy,
      journal,
      originalWorkspace,
      work,
      onlinePrepared,
      transferHandoff,
    )
    for (;;) {
      await transition.settleSelection()
      if (!transition.isDeferred()) {
        ownsStaging = false
        return { kind: 'promoted', transition }
      }
      const resumed = await transition.finalize()
      if (resumed.kind !== 'online-ready') {
        ownsStaging = false
        return { kind: 'promoted', transition }
      }
      if (work.kind !== 'online') throw new Error('BrowserWorkspaceOnlineContinuationRequired')
      const continuation = work.continuation
      let nextRound: Promise<BrowserWorkspaceReplacementTransitionController<T>> | null = null
      while (!nextRound) {
        await awaitWorkspaceForegroundDemandIdle(continuation.signal)
        await waitForWorkspaceRuntimeReplacementBlockers({
          signal: continuation.signal,
          requireIdle: true,
        })
        if (getWorkspaceRuntimeControlSnapshot().state !== 'RUNNING') {
          if (continuation.signal.aborted) throw continuation.signal.reason
          await runWorkspaceRead('maintenance', () => undefined, { signal: continuation.signal })
          continue
        }
        nextRound = tryRunWorkspaceActionIfIdle(
          'maintenance',
          async (permit) => {
            return runReplacementRound(
              selection,
              maintenanceReplacementPolicy(permit, continuation),
              journal,
              originalWorkspace,
              work,
              onlinePrepared,
              transferHandoff,
            )
          },
          { signal: continuation.signal },
        )
      }
      transition = await nextRound
    }
  } catch (error) {
    if (ownsStaging) {
      try {
        await abandonUnpromotedSlottedReplacement(journal, work)
      } catch (cleanupError) {
        throw new WorkspaceReplacementUncommittedRecoveryRequiredError([error, cleanupError])
      }
    }
    if (
      work.continuation.signal.aborted &&
      (error === work.continuation.signal.reason ||
        (policy.admissionOptions.signal?.aborted &&
          error === policy.admissionOptions.signal.reason))
    ) {
      throw work.continuation.signal.reason
    }
    throw error
  }
}

async function runReplacementRound<T>(
  selection: BrowserWorkspaceSelectionGrant,
  policy: BrowserWorkspaceReplacementLaunchPolicy,
  journal: BrowserWorkspaceReplacementPreparing,
  originalWorkspace: BrowserWorkspaceSnapshot,
  work: BrowserWorkspaceReplacementWork<T>,
  onlinePrepared: unknown,
  transferHandoff: () => void,
): Promise<BrowserWorkspaceReplacementTransitionController<T>> {
  for (;;) {
    await waitForWorkspaceRuntimeReplacementBlockers({
      ...policy.admissionOptions,
      requireIdle: policy.admission === 'if-idle',
    })
    if (work.kind === 'online') {
      await runOnlineSlottedReplacement(
        selection,
        journal,
        (db, context) => work.operation.refresh(db, context, onlinePrepared),
        policy.admissionOptions.signal,
      )
    }
    const result = await withExclusiveGenerationLifetime(
      () =>
        withBrowserWorkspaceSlotRound(
          journal,
          async (quiesce) => {
            const authority = launchReplacementAuthority(policy)
            if (!authority) return null
            transferHandoff()
            return runSlottedBrowserWorkspaceReplacement(
              selection,
              authority,
              journal,
              originalWorkspace,
              work,
              onlinePrepared,
              quiesce,
            )
          },
          policy.admissionOptions.signal,
        ),
      policy.admissionOptions.signal ? { signal: policy.admissionOptions.signal } : {},
    )
    if (result) return result
  }
}

function launchReplacementAuthority(
  policy: BrowserWorkspaceReplacementLaunchPolicy,
): WorkspaceReconcileAuthority | null {
  if (policy.admissionOptions.signal?.aborted) throw policy.admissionOptions.signal.reason
  return policy.promote()
}

async function runUnslottedBrowserWorkspaceReplacement<T>(
  authority: WorkspaceReconcileAuthority,
  databaseName: string,
  originalWorkspace: BrowserWorkspaceSnapshot,
  continuation: WorkspaceReplacementContinuation,
  operation: BrowserWorkspaceReplacementOperation<T>,
): Promise<BrowserWorkspaceReplacementTransitionController<T>> {
  const transition = createReplacementTransition<T>(originalWorkspace, continuation)
  const replacementDb = new NatterDb(databaseName)
  const mutationState = { authoritativeMutationCommitted: false }
  try {
    transition.beginQuiescing()
    await awaitWorkspaceRuntimeQuiesced()
    transition.markQuiesced()
    await replacementDb.open()
    const prepared = await withQuiescedWorkspaceReplacementLock(
      replacementDb,
      async (grant) => {
        const mutation = createReplacementMutationCapability(grant, {
          atomicity: 'in-place-atomic',
          begin: () => transition.beginWriting(),
          committed: () => {
            mutationState.authoritativeMutationCommitted = true
          },
        })
        const prepared = await operation(replacementDb, {
          sourceDatabaseName: databaseName,
          destinationDatabaseName: databaseName,
          atomicity: 'in-place-atomic',
          signal: authority.signal,
          preactivationCheckpoint: () => {
            if (authority.signal.aborted) throw authority.signal.reason
          },
          withSourceDatabase: () =>
            Promise.reject(new Error('BrowserWorkspaceReplacementSourceRequiresSlots')),
          mutate: mutation.run,
        })
        mutation.requireUsed()
        return prepared
      },
      { signal: authority.signal },
    )
    const verified = workspaceSnapshot(await readBrowserWorkspaceMeta(replacementDb))
    if (!sameWorkspaceSnapshot(verified, prepared.workspace)) {
      throw new Error('BrowserWorkspaceReplacementVerificationFailed')
    }
    await applyUnslottedBrowserWorkspaceReplacementStorageBaseline(
      databaseName,
      prepared.storageBaseline,
    )
    transition.markPrepared()
    transition.beginCommitting()
    transition.markCommitted(prepared)
  } catch (error) {
    if (!transition.hasDisposition()) {
      if (mutationState.authoritativeMutationCommitted) transition.markOutcomeUnknown(error)
      else if (continuation.signal.aborted && error === continuation.signal.reason) {
        transition.markCancelled(error)
      } else transition.markUncommitted(replacementExecutionFailure(error, authority.signal))
    }
  } finally {
    replacementDb.close()
  }
  return transition
}

async function runSlottedBrowserWorkspaceReplacement<T>(
  selection: BrowserWorkspaceSelectionGrant,
  authority: WorkspaceReconcileAuthority,
  journal: BrowserWorkspaceReplacementPreparing,
  originalWorkspace: BrowserWorkspaceSnapshot,
  work: BrowserWorkspaceReplacementWork<T>,
  onlinePrepared: unknown,
  quiesce: () => void,
): Promise<BrowserWorkspaceReplacementTransitionController<T>> {
  const transition = createReplacementTransition<T>(
    originalWorkspace,
    work.continuation,
    work.kind === 'online'
      ? {
          kind: 'retained-source',
          selection,
          journal,
          workspace: originalWorkspace,
        }
      : { kind: 'active' },
  )
  transition.ownAbandon(() => abandonSlottedReplacement(journal, work))
  try {
    transition.beginQuiescing()
    quiesce()
    await awaitWorkspaceRuntimeQuiesced()
    transition.markQuiesced()
    await withExclusiveBrowserWorkspaceSlots(
      selection,
      [journal.sourceDatabaseName, journal.destinationDatabaseName],
      () =>
        runSlottedReplacementCommit(transition, journal, work, onlinePrepared, authority.signal),
      authority.signal,
    )
  } catch (error) {
    if (!transition.hasDisposition()) {
      if (work.continuation.signal.aborted && error === work.continuation.signal.reason) {
        const reason: unknown = work.continuation.signal.reason
        transition.markCancelled(reason)
      } else if (
        work.kind === 'online' &&
        error === authority.signal.reason &&
        authority.signal.reason instanceof WorkspaceMaintenancePreemptedError
      ) {
        transition.markDeferred()
      } else {
        transition.markUncommitted(replacementExecutionFailure(error, authority.signal))
      }
    }
  }
  return transition
}

async function abandonSlottedReplacement<T>(
  journal: BrowserWorkspaceReplacementPreparing,
  work: BrowserWorkspaceReplacementWork<T>,
): Promise<void> {
  const outcomes = await Promise.allSettled([
    abandonPreparedBrowserWorkspaceDatabase(journal),
    abandonOnlineReplacementSource(work, journal.sourceDatabaseName),
  ])
  throwReplacementCleanupFailures(outcomes, 'BrowserWorkspaceReplacementCleanupFailed')
}

async function abandonUnpromotedSlottedReplacement<T>(
  journal: BrowserWorkspaceReplacementPreparing,
  work: BrowserWorkspaceReplacementWork<T>,
): Promise<void> {
  const outcomes = await Promise.allSettled([
    abandonPreparedBrowserWorkspaceDatabase(journal),
    abandonOnlineReplacementSource(work, journal.sourceDatabaseName),
  ])
  throwReplacementCleanupFailures(outcomes, 'BrowserWorkspaceReplacementPreparationCleanupFailed')
}

function abandonOnlineReplacementSource<T>(
  work: BrowserWorkspaceReplacementWork<T>,
  sourceDatabaseName: string,
): Promise<void> {
  return work.kind === 'online' ? work.operation.abandon(sourceDatabaseName) : Promise.resolve()
}

function throwReplacementCleanupFailures(
  outcomes: readonly PromiseSettledResult<unknown>[],
  message: string,
): void {
  const failures = outcomes.flatMap((outcome) =>
    outcome.status === 'rejected' ? [browserWorkspaceReplacementError(outcome.reason)] : [],
  )
  if (failures.length > 0) {
    throw new AggregateError(failures, message)
  }
}

function browserWorkspaceReplacementError(reason: unknown): Error {
  if (reason instanceof Error) return reason
  if (reason && typeof reason === 'object') {
    const candidate = reason as { readonly name?: unknown; readonly message?: unknown }
    const name = typeof candidate.name === 'string' ? candidate.name : ''
    const message = typeof candidate.message === 'string' ? candidate.message : ''
    if (message.length > 0) {
      return new Error(name.length > 0 ? `${name}: ${message}` : message, { cause: reason })
    }
  }
  return new Error('BrowserWorkspaceReplacementFailed', { cause: reason })
}

function replacementExecutionFailure(error: unknown, signal: AbortSignal): unknown {
  if (!signal.aborted || signal.reason === error) return error
  return new AggregateError(
    [error, signal.reason],
    'BrowserWorkspaceReplacementExecutionFailedAndAuthorityAborted',
    { cause: error },
  )
}

async function prepareSlottedDestination(
  selection: BrowserWorkspaceSelectionGrant,
  journal: BrowserWorkspaceReplacementPreparing,
  originalWorkspace: BrowserWorkspaceSnapshot,
  signal: AbortSignal,
): Promise<void> {
  await withExclusiveBrowserWorkspaceSlots(
    selection,
    [journal.destinationDatabaseName],
    async () => {
      signal.throwIfAborted()
      await Dexie.delete(journal.destinationDatabaseName)
      signal.throwIfAborted()
      await recreateAndVerifyBrowserWorkspaceDatabase(journal.destinationDatabaseName)
      signal.throwIfAborted()
      const replacementDb = new NatterDb(journal.destinationDatabaseName)
      try {
        await replacementDb.open()
        signal.throwIfAborted()
        await seedBrowserWorkspaceReplacementMeta(replacementDb, originalWorkspace)
      } finally {
        replacementDb.close()
      }
    },
    signal,
  )
}

async function runOnlineSlottedReplacement<Prepared>(
  selection: BrowserWorkspaceSelectionGrant,
  journal: BrowserWorkspaceReplacementPreparing,
  operation: BrowserWorkspaceOnlineReplacementOperation<Prepared, unknown>['prepare'],
  requestedSignal: AbortSignal | undefined,
): Promise<Prepared> {
  const fallbackController = new AbortController()
  const signal = requestedSignal ?? fallbackController.signal
  return withExclusiveBrowserWorkspaceSlots(
    selection,
    [journal.destinationDatabaseName],
    async () => {
      const destination = new NatterDb(journal.destinationDatabaseName)
      try {
        await destination.open()
        return await operation(destination, {
          sourceDatabaseName: journal.sourceDatabaseName,
          destinationDatabaseName: journal.destinationDatabaseName,
          signal,
          preactivationCheckpoint: () => {
            if (signal.aborted) throw signal.reason
          },
          awaitForegroundIdle: () => awaitWorkspaceForegroundDemandIdle(signal),
          foregroundInterruptionSignal: workspaceForegroundDemandInterruptionSignal,
          withSourceDatabase: (sourceOperation) =>
            withBrowserWorkspaceSourceDatabase(journal.sourceDatabaseName, sourceOperation),
          runDestinationTransaction: (tableNames, transactionOperation) =>
            destination.transaction(
              'rw!',
              tableNames.map((tableName) => destination.table(tableName)),
              transactionOperation,
            ),
        })
      } finally {
        if (!requestedSignal) fallbackController.abort()
        destination.close()
      }
    },
    signal,
  )
}

async function runSlottedReplacementCommit<T>(
  transition: BrowserWorkspaceReplacementTransitionController<T>,
  journal: BrowserWorkspaceReplacementPreparing,
  work: BrowserWorkspaceReplacementWork<T>,
  onlinePrepared: unknown,
  signal: AbortSignal,
): Promise<void> {
  const replacementDb = new NatterDb(journal.destinationDatabaseName)
  try {
    await replacementDb.open()
    await withQuiescedWorkspaceReplacementLock(
      replacementDb,
      async (grant) => {
        const mutation = createReplacementMutationCapability(grant, {
          atomicity: 'slotted-staging',
          begin: () => transition.beginWriting(),
          committed: () => undefined,
        })
        const context: BrowserWorkspaceReplacementContext = {
          sourceDatabaseName: journal.sourceDatabaseName,
          destinationDatabaseName: journal.destinationDatabaseName,
          atomicity: 'slotted-staging',
          signal,
          preactivationCheckpoint: () => {
            if (signal.aborted) throw signal.reason
          },
          withSourceDatabase: (sourceOperation) =>
            withBrowserWorkspaceSourceDatabase(journal.sourceDatabaseName, sourceOperation),
          mutate: mutation.run,
        }
        const result =
          work.kind === 'online'
            ? await work.operation.tryCommit(replacementDb, context, onlinePrepared)
            : {
                kind: 'prepared' as const,
                replacement: await work.operation(replacementDb, context),
              }
        if (result.kind === 'resume-online') {
          transition.markDeferred()
          return
        }
        const prepared = result.replacement
        mutation.requireUsed()
        const verified = workspaceSnapshot(await readBrowserWorkspaceMeta(replacementDb))
        if (!sameWorkspaceSnapshot(verified, prepared.workspace)) {
          throw new Error('BrowserWorkspaceReplacementVerificationFailed')
        }
        if (signal.aborted) throw signal.reason
        transition.markPrepared()
        transition.beginCommitting()
        try {
          await activatePreparedBrowserWorkspaceDatabase(journal, prepared.storageBaseline)
        } catch (error) {
          if (error instanceof BrowserWorkspaceActivationOutcomeUncertainError) {
            transition.markOutcomeUnknown(error)
          } else {
            transition.markUncommitted(error)
          }
          return
        }
        transition.markCommitted(prepared)
      },
      { signal },
    )
  } finally {
    replacementDb.close()
  }
}

function createReplacementMutationCapability(
  grant: LockGrant,
  lifecycle: {
    atomicity: BrowserWorkspaceReplacementAtomicity
    begin(): void
    committed(): void
  },
): {
  readonly run: <T>(
    operation: (grant: BrowserWorkspaceReplacementMutationGrant) => Promise<T>,
  ) => Promise<T>
  requireUsed(): void
} {
  let used = false
  let transactionCommitted = false
  const mutationGrant: BrowserWorkspaceReplacementMutationGrant = {
    kind: grant.kind,
    logicalNames: grant.logicalNames,
    atomicity: lifecycle.atomicity,
    ...(grant.ownershipLost ? { ownershipLost: grant.ownershipLost } : {}),
    runTransaction: async (db, tables, operation) => {
      if (lifecycle.atomicity === 'in-place-atomic' && transactionCommitted) {
        throw new Error('BrowserWorkspaceReplacementAtomicTransactionAlreadyCommitted')
      }
      const result = await grant.runTransaction(db, tables, operation)
      if (!transactionCommitted) {
        transactionCommitted = true
        lifecycle.committed()
      }
      return result
    },
  }
  return {
    run: async (operation) => {
      if (used) throw new Error('BrowserWorkspaceReplacementMutationAlreadyStarted')
      used = true
      lifecycle.begin()
      return operation(mutationGrant)
    },
    requireUsed: () => {
      if (!used) throw new Error('BrowserWorkspaceReplacementMutationRequired')
      if (!transactionCommitted)
        throw new Error('BrowserWorkspaceReplacementMutationTransactionRequired')
    },
  }
}

function createReplacementTransition<T>(
  originalWorkspace: BrowserWorkspaceSnapshot,
  continuation: WorkspaceReplacementContinuation,
  retainedTarget: BrowserWorkspaceOpenTarget = { kind: 'active' },
): BrowserWorkspaceReplacementTransitionController<T> {
  return createBrowserWorkspaceReplacementTransitionController({
    originalWorkspace,
    reopen: (retained) =>
      settleCurrentBrowserWorkspace(
        { kind: 'reopen', target: retained ? retainedTarget : { kind: 'active' } },
        continuation,
      ),
    publish: (commit) => {
      if (commit.publication === 'deferred') return
      postWorkspaceChange({ kind: 'replace', ...commit.workspace })
    },
  })
}

function unwrapBrowserWorkspaceReplacementOutcome<T>(
  outcome: BrowserWorkspaceReplacementOutcome<T>,
): BrowserWorkspaceReplacementCommit<T> {
  switch (outcome.kind) {
    case 'committed-ready':
    case 'committed-closed':
      return outcome.commit
    case 'online-ready':
      throw new Error('BrowserWorkspaceTerminalOutcomeRequired')
    case 'cancelled':
      throw outcome.reason
    case 'uncommitted-ready':
    case 'uncommitted-closed':
      throw outcome.error
    case 'committed-recovery-required':
      throw new WorkspaceReplacementCommittedRecoveryRequiredError(
        outcome.commit.workspace,
        outcome.failures,
      )
    case 'uncommitted-recovery-required':
      throw new WorkspaceReplacementUncommittedRecoveryRequiredError(outcome.failures)
    case 'outcome-unknown':
      throw new WorkspaceReplacementOutcomeUnknownError(outcome.failures)
  }
}

async function withBrowserWorkspaceSourceDatabase<T>(
  databaseName: string,
  operation: (source: NatterDb) => Promise<T>,
): Promise<T> {
  const source = new NatterDb(databaseName)
  try {
    await prepareBrowserWorkspaceSchema(source)
    await source.open()
    return await Dexie.ignoreTransaction(() => operation(source))
  } finally {
    source.close()
  }
}

function settleCurrentBrowserWorkspace(
  request: BrowserWorkspaceReplacementRuntimeRequest,
  continuation: WorkspaceReplacementContinuation,
): Promise<BrowserWorkspaceReplacementReopenOutcome> {
  if (!settleBrowserWorkspace) throw new Error('BrowserWorkspaceReplacementSettlementNotInstalled')
  return settleBrowserWorkspace(request, continuation)
}

function sameWorkspaceSnapshot(
  left: BrowserWorkspaceSnapshot,
  right: BrowserWorkspaceSnapshot,
): boolean {
  return left.workspaceId === right.workspaceId && left.replacementEpoch === right.replacementEpoch
}

function workspaceSnapshot(workspace: BrowserWorkspaceSnapshot): BrowserWorkspaceSnapshot {
  return {
    workspaceId: workspace.workspaceId,
    replacementEpoch: workspace.replacementEpoch,
  }
}
