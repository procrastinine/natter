import Dexie from 'dexie'
import {
  WorkspaceReplacementCommittedRecoveryRequiredError,
  WorkspaceReplacementOutcomeUnknownError,
  WorkspaceReplacementUncommittedRecoveryRequiredError,
} from '../core/import-export/errors'
import { postWorkspaceChange } from './broadcast'
import type {
  BrowserWorkspaceReplacementAtomicity,
  BrowserWorkspaceReplacementCommit,
  BrowserWorkspaceReplacementMutationGrant,
  BrowserWorkspaceReplacementOperation,
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
import type { BrowserWorkspaceReplacementStart } from './browser-workspace-maintenance-contract'

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
  browserWorkspaceSlotSwitchingSupported,
  postBrowserWorkspaceSlotQuiesce,
  postBrowserWorkspaceSlotResume,
  tryWithBrowserWorkspaceSelectionGate,
  withBrowserWorkspaceSelectionGate,
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
  isWorkspaceMaintenancePreemptedError,
  runWorkspaceRead,
  type WorkspaceReconcileAuthority,
  type WorkspaceRuntimeActionOptions,
} from './workspace-runtime'
import {
  awaitWorkspaceRuntimeQuiesced,
  getWorkspaceRuntimeControlSnapshot,
  launchImportExportWorkspaceRuntimeReplacementNow,
  tryLaunchMaintenanceWorkspaceRuntimeReplacementIfIdle,
} from './workspace-runtime-control'

let reopenBrowserWorkspace: (() => Promise<void>) | null = null

export function installBrowserWorkspaceReplacementReopen(reopen: () => Promise<void>): void {
  reopenBrowserWorkspace = reopen
}

type BrowserWorkspaceReplacementPreflight = (
  session: BrowserWorkspaceSession,
) => boolean | Promise<boolean>

interface BrowserWorkspaceReplacementLaunchPolicy {
  readonly admission: 'required' | 'if-idle'
  readonly admissionOptions: WorkspaceRuntimeActionOptions
  readonly promote: () => WorkspaceReconcileAuthority | null
}

interface BrowserWorkspaceReplacementPromoted<T> {
  readonly kind: 'promoted'
  readonly transition: BrowserWorkspaceReplacementTransitionController<T>
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
  const started = await launchBrowserWorkspaceReplacement(
    {
      admission: 'required',
      admissionOptions: options,
      promote: () => launchImportExportWorkspaceRuntimeReplacementNow(options),
    },
    preflight,
    operation,
  )
  if (started.kind === 'skipped') throw new Error('BrowserWorkspaceReplacementPreflightSkipped')
  if (started.kind === 'blocked') throw new Error('BrowserWorkspaceReplacementAdmissionBlocked')
  if (started.kind === 'cleanup-required') {
    throw new Error('BrowserWorkspaceReplacementCleanupRequired')
  }
  return started.handoff.completion
}

export function tryStartBrowserWorkspaceReplacementIfIdle<T>(
  preflight: BrowserWorkspaceReplacementPreflight,
  operation: BrowserWorkspaceReplacementOperation<T>,
  options: WorkspaceRuntimeActionOptions = {},
): Promise<BrowserWorkspaceReplacementStart<T>> {
  const authorityOptions = options.lineageId ? { lineageId: options.lineageId } : {}
  return launchBrowserWorkspaceReplacement(
    {
      admission: 'if-idle',
      admissionOptions: options,
      // Promotion closes the maintenance producer; the handoff authority owns execution.
      promote: () => tryLaunchMaintenanceWorkspaceRuntimeReplacementIfIdle(authorityOptions),
    },
    preflight,
    operation,
  )
}

function launchBrowserWorkspaceReplacement<T>(
  policy: BrowserWorkspaceReplacementLaunchPolicy,
  preflight: BrowserWorkspaceReplacementPreflight,
  operation: BrowserWorkspaceReplacementOperation<T>,
): Promise<BrowserWorkspaceReplacementStart<T>> {
  let promoted = false
  let resolveCompletion!: (commit: BrowserWorkspaceReplacementCommit<T>) => void
  let rejectCompletion!: (error: unknown) => void
  return new Promise<BrowserWorkspaceReplacementStart<T>>((resolve, reject) => {
    const onPromoted = () => {
      promoted = true
      const completion = new Promise<BrowserWorkspaceReplacementCommit<T>>(
        (resolveCommit, rejectCommit) => {
          resolveCompletion = resolveCommit
          rejectCompletion = rejectCommit
        },
      )
      void completion.catch(() => undefined)
      resolve({
        kind: 'handoff',
        handoff: { completion },
      })
    }
    void performBrowserWorkspaceReplacementLaunch(policy, preflight, operation, onPromoted).then(
      (result) => {
        if (
          result.kind === 'blocked' ||
          result.kind === 'cleanup-required' ||
          result.kind === 'skipped'
        ) {
          resolve(result)
          return
        }
        void result.transition
          .finalize()
          .then(unwrapBrowserWorkspaceReplacementOutcome)
          .then(resolveCompletion, rejectCompletion)
      },
      (error: unknown) => {
        const failure = browserWorkspaceReplacementError(error)
        if (promoted) rejectCompletion(failure)
        else reject(failure)
      },
    )
  })
}

async function performBrowserWorkspaceReplacementLaunch<T>(
  policy: BrowserWorkspaceReplacementLaunchPolicy,
  preflight: BrowserWorkspaceReplacementPreflight,
  operation: BrowserWorkspaceReplacementOperation<T>,
  onPromoted: () => void,
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
      operation,
      onPromoted,
    )
    if (attempt.kind === 'cleanup-required' && policy.admission === 'required') {
      const cleanup = await cleanPendingBrowserWorkspaceDatabase(policy.admissionOptions.signal)
      if (cleanup.status === 'preparing') return attempt
      continue
    }
    if (attempt.kind !== 'blocked' || policy.admission === 'if-idle') return attempt
    await runWorkspaceRead('import-export', () => undefined, policy.admissionOptions)
  }
}

async function runBrowserWorkspaceReplacementSelectionAttempt<T>(
  policy: BrowserWorkspaceReplacementLaunchPolicy,
  preflight: BrowserWorkspaceReplacementPreflight,
  operation: BrowserWorkspaceReplacementOperation<T>,
  onPromoted: () => void,
): Promise<
  | { readonly kind: 'blocked' }
  | { readonly kind: 'cleanup-required' }
  | { readonly kind: 'skipped' }
  | BrowserWorkspaceReplacementPromoted<T>
> {
  if (policy.admission === 'required') {
    return withBrowserWorkspaceSelectionGate(
      () => runGatedBrowserWorkspaceReplacementAttempt(policy, preflight, operation, onPromoted),
      policy.admissionOptions.signal,
    )
  }
  const result = await tryWithBrowserWorkspaceSelectionGate(
    () => runGatedBrowserWorkspaceReplacementAttempt(policy, preflight, operation, onPromoted),
    policy.admissionOptions.signal,
  )
  return result.acquired ? result.value : { kind: 'blocked' }
}

async function runGatedBrowserWorkspaceReplacementAttempt<T>(
  policy: BrowserWorkspaceReplacementLaunchPolicy,
  preflight: BrowserWorkspaceReplacementPreflight,
  operation: BrowserWorkspaceReplacementOperation<T>,
  onPromoted: () => void,
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
  if (!(await preflight(session))) return { kind: 'skipped' }
  if (policy.admissionOptions.signal?.aborted) throw policy.admissionOptions.signal.reason
  const databaseName = session.databaseName
  const originalWorkspace = workspaceSnapshot({
    workspaceId: snapshot.workspaceId,
    replacementEpoch: snapshot.replacementEpoch,
  })
  if (!browserWorkspaceSlotSwitchingSupported()) {
    const authority = launchReplacementAuthority(policy)
    if (!authority) return { kind: 'blocked' }
    onPromoted()
    const transition = await runUnslottedBrowserWorkspaceReplacement(
      authority,
      databaseName,
      originalWorkspace,
      operation,
    )
    await transition.settleSelection()
    return { kind: 'promoted', transition }
  }
  const begin = await tryBeginBrowserWorkspaceDatabaseReplacement()
  if (begin.kind === 'occupied') {
    return begin.journal.phase === 'preparing' ? { kind: 'blocked' } : { kind: 'cleanup-required' }
  }
  const journal = begin.journal
  let peerQuiescePosted = false
  let cleanupAttempted = false
  try {
    if (journal.sourceDatabaseName !== databaseName) {
      throw new Error(
        `BrowserWorkspaceControlSourceMismatch:${databaseName}:${journal.sourceDatabaseName}`,
      )
    }
    await prepareSlottedDestination(journal, originalWorkspace)
    const authority = launchReplacementAuthority(policy)
    if (!authority) {
      cleanupAttempted = true
      await abandonUnpromotedSlottedReplacement(journal, peerQuiescePosted)
      return { kind: 'cleanup-required' }
    }
    postBrowserWorkspaceSlotQuiesce(journal)
    peerQuiescePosted = true
    onPromoted()
    const transition = await runSlottedBrowserWorkspaceReplacement(
      authority,
      journal,
      originalWorkspace,
      operation,
    ).catch((error: unknown) => {
      throw browserWorkspaceReplacementStageError('execution', error)
    })
    await transition.settleSelection().catch((error: unknown) => {
      throw browserWorkspaceReplacementStageError('selection-settlement', error)
    })
    return { kind: 'promoted', transition }
  } catch (error) {
    if (!cleanupAttempted && getWorkspaceRuntimeControlSnapshot().state === 'RUNNING') {
      try {
        await abandonUnpromotedSlottedReplacement(journal, peerQuiescePosted)
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'BrowserWorkspaceReplacementPreparationFailed',
          { cause: cleanupError },
        )
      }
    }
    throw error
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
  operation: BrowserWorkspaceReplacementOperation<T>,
): Promise<BrowserWorkspaceReplacementTransitionController<T>> {
  const transition = createReplacementTransition<T>(originalWorkspace)
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
      else transition.markUncommitted(error)
    }
  } finally {
    replacementDb.close()
  }
  return transition
}

async function runSlottedBrowserWorkspaceReplacement<T>(
  authority: WorkspaceReconcileAuthority,
  journal: BrowserWorkspaceReplacementPreparing,
  originalWorkspace: BrowserWorkspaceSnapshot,
  operation: BrowserWorkspaceReplacementOperation<T>,
): Promise<BrowserWorkspaceReplacementTransitionController<T>> {
  const transition = createReplacementTransition<T>(originalWorkspace)
  transition.ownAbandon(() => abandonSlottedReplacement(journal))
  transition.ownPeerResume(() => postBrowserWorkspaceSlotResume(journal))
  try {
    transition.beginQuiescing()
    await awaitWorkspaceRuntimeQuiesced()
    transition.markQuiesced()
    await withExclusiveBrowserWorkspaceSlots(
      [journal.sourceDatabaseName, journal.destinationDatabaseName],
      () => runSlottedReplacementCommit(transition, journal, operation, authority.signal),
      authority.signal,
    )
  } catch (error) {
    if (!transition.hasDisposition()) transition.markUncommitted(error)
  }
  return transition
}

async function abandonSlottedReplacement(
  journal: BrowserWorkspaceReplacementPreparing,
): Promise<void> {
  await abandonPreparedBrowserWorkspaceDatabase(journal)
}

async function abandonUnpromotedSlottedReplacement(
  journal: BrowserWorkspaceReplacementPreparing,
  peerQuiescePosted: boolean,
): Promise<void> {
  const outcomes = await Promise.allSettled([
    abandonPreparedBrowserWorkspaceDatabase(journal),
    Promise.resolve().then(() => {
      if (peerQuiescePosted) postBrowserWorkspaceSlotResume(journal)
    }),
  ])
  const failures = outcomes.flatMap((outcome) =>
    outcome.status === 'rejected' ? [browserWorkspaceReplacementError(outcome.reason)] : [],
  )
  if (failures.length > 0) {
    throw new AggregateError(failures, 'BrowserWorkspaceReplacementPreparationCleanupFailed')
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

function browserWorkspaceReplacementStageError(stage: string, reason: unknown): Error {
  if (isWorkspaceMaintenancePreemptedError(reason)) return reason
  return new Error(`BrowserWorkspaceReplacementStageFailed:${stage}`, {
    cause: browserWorkspaceReplacementError(reason),
  })
}

async function prepareSlottedDestination(
  journal: BrowserWorkspaceReplacementPreparing,
  originalWorkspace: BrowserWorkspaceSnapshot,
): Promise<void> {
  await withExclusiveBrowserWorkspaceSlots([journal.destinationDatabaseName], async () => {
    await Dexie.delete(journal.destinationDatabaseName)
    await recreateAndVerifyBrowserWorkspaceDatabase(journal.destinationDatabaseName)
    const replacementDb = new NatterDb(journal.destinationDatabaseName)
    try {
      await replacementDb.open()
      await seedBrowserWorkspaceReplacementMeta(replacementDb, originalWorkspace)
    } finally {
      replacementDb.close()
    }
  })
}

async function runSlottedReplacementCommit<T>(
  transition: BrowserWorkspaceReplacementTransitionController<T>,
  journal: BrowserWorkspaceReplacementPreparing,
  operation: BrowserWorkspaceReplacementOperation<T>,
  signal: AbortSignal,
): Promise<void> {
  const replacementDb = new NatterDb(journal.destinationDatabaseName)
  try {
    await replacementDb.open()
    await withExclusiveGenerationLifetime(
      () =>
        withQuiescedWorkspaceReplacementLock(
          replacementDb,
          async (grant) => {
            const mutation = createReplacementMutationCapability(grant, {
              atomicity: 'slotted-staging',
              begin: () => transition.beginWriting(),
              committed: () => undefined,
            })
            const prepared = await operation(replacementDb, {
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
            })
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
        ),
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
      const result = await operation(mutationGrant)
      if (!transactionCommitted) {
        throw new Error('BrowserWorkspaceReplacementMutationTransactionRequired')
      }
      return result
    },
    requireUsed: () => {
      if (!used) throw new Error('BrowserWorkspaceReplacementMutationRequired')
    },
  }
}

function createReplacementTransition<T>(
  originalWorkspace: BrowserWorkspaceSnapshot,
): BrowserWorkspaceReplacementTransitionController<T> {
  return createBrowserWorkspaceReplacementTransitionController({
    originalWorkspace,
    reopen: reopenCurrentBrowserWorkspace,
    publish: (commit) => postWorkspaceChange({ kind: 'replace', ...commit.workspace }),
  })
}

function unwrapBrowserWorkspaceReplacementOutcome<T>(
  outcome: BrowserWorkspaceReplacementOutcome<T>,
): BrowserWorkspaceReplacementCommit<T> {
  switch (outcome.kind) {
    case 'committed-ready':
      return outcome.commit
    case 'uncommitted-ready':
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
    return await operation(source)
  } finally {
    source.close()
  }
}

async function reopenCurrentBrowserWorkspace(): Promise<BrowserWorkspaceSnapshot> {
  if (!reopenBrowserWorkspace) throw new Error('BrowserWorkspaceReplacementReopenNotInstalled')
  await reopenBrowserWorkspace()
  const snapshot = getWorkspaceRuntimeControlSnapshot()
  if (snapshot.state !== 'RUNNING' || snapshot.workspaceId === null) {
    throw new Error(`BrowserWorkspaceReplacementReopenIncomplete:${snapshot.state}`)
  }
  return {
    workspaceId: snapshot.workspaceId,
    replacementEpoch: snapshot.replacementEpoch,
  }
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
