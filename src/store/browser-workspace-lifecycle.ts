import { isWorkspaceReplacementRecoveryRequiredError } from '../core/import-export/errors'
import { raceWithAbortSignal } from '../lib/abort'
import { errorHasName } from '../lib/error'
import {
  assertAttachmentCatalogWorkspaceClosed,
  attachAttachmentCatalogWorkspace,
  disposeAttachmentCatalogWorkspace,
  reconcileAttachmentCatalogWorkspace,
  suspendAttachmentCatalogWorkspace,
} from './attachment-catalog-workspace'
import {
  assertAttemptWorkspaceClosed,
  attachAttemptWorkspace,
  awaitAttemptWorkspaceIdle,
  disposeAttemptWorkspace,
  startAttemptWorkspace,
} from './attempt-workspace'
import {
  broadcastWorkspaceRuntimeResources,
  subscribeWorkspaceApplicationChanges,
} from './broadcast'
import {
  assertBrowserWorkspaceBootstrapAuthority,
  type BrowserWorkspaceBootstrapAuthority,
  beginBrowserWorkspaceBootstrap,
  cancelBrowserWorkspaceBootstrap,
  finishBrowserWorkspaceBootstrap,
} from './browser-workspace-bootstrap-authority'
import { recoverQuiescedBrowserWorkspaceReplacement } from './browser-workspace-database-cleanup'
import {
  closeBrowserWorkspaceControlDatabase,
  readBrowserWorkspaceDatabaseManifest,
} from './browser-workspace-database-control'
import {
  type ActiveBrowserWorkspaceDatabaseSelection,
  activateBrowserWorkspaceDatabaseSelection,
  type OpeningBrowserWorkspaceDatabaseSelection,
  prepareBrowserWorkspaceDatabaseSelection,
  releaseActiveBrowserWorkspaceDatabaseSelection,
  releaseOpeningBrowserWorkspaceDatabaseSelection,
} from './browser-workspace-database-selection'
import type { BrowserWorkspaceReplacementHandoff } from './browser-workspace-maintenance-contract'
import type {
  BrowserWorkspaceOpenOptions,
  BrowserWorkspaceOpenProgress,
} from './browser-workspace-open-contract'
import { installBrowserWorkspaceReplacementReopen } from './browser-workspace-replacement-runner'
import {
  awaitBrowserWorkspaceSlotCoordinatorIdle,
  type BrowserWorkspaceSlotCoordinatorOwner,
  type BrowserWorkspaceSlotTransition,
  disposeBrowserWorkspaceSlotCoordinator,
  installBrowserWorkspaceSlotCoordinator,
} from './browser-workspace-slot-coordination'
import { configurationController } from './configuration-controller'
import {
  abortConfigurationModelResolutionCapability,
  activateConfigurationModelResolutionCapability,
  assertConfigurationModelResolutionCapabilityClosed,
  attachConfigurationModelResolutionCapability,
  awaitConfigurationModelResolutionCapabilityIdle,
  closeConfigurationModelResolutionCapability,
} from './configuration-model-resolution-capability'
import {
  assertConfigurationWorkspaceClosed,
  attachConfigurationWorkspace,
  disposeConfigurationWorkspace,
} from './configuration-workspace'
import {
  type ConversationDestinationProjection,
  conversationController,
} from './conversation-controller'
import {
  assertConversationWorkspaceClosed,
  attachConversationWorkspace,
  disposeConversationWorkspace,
} from './conversation-workspace'
import {
  assertBrowserWorkspaceRepositoryAdmissionsClosed,
  assertBrowserWorkspaceSessionAdmissionsClosed,
  awaitBrowserWorkspaceRepositoryIdle,
  type BrowserWorkspaceFatalInvalidationOwner,
  bootstrapBrowserWorkspace,
  claimBrowserWorkspaceFatalInvalidationOwner,
  closeInvalidatedBrowserWorkspaceSession,
  discardBrowserWorkspaceBootstrapSession,
  getBrowserWorkspaceSession,
  type InvalidatedBrowserWorkspaceSession,
  invalidateBrowserWorkspaceSession,
  releaseBrowserWorkspaceFatalInvalidationOwner,
  resumeBrowserWorkspaceRepositoryAdmissions,
  resumeBrowserWorkspaceSessionAdmissions,
  stopBrowserWorkspaceRepositoryAdmissions,
} from './db'
import {
  abortGeneratedOutputLocalizationCapability,
  activateGeneratedOutputLocalizationCapability,
  assertGeneratedOutputLocalizationCapabilityClosed,
  attachGeneratedOutputLocalizationCapability,
  awaitGeneratedOutputLocalizationCapabilityIdle,
  closeGeneratedOutputLocalizationCapability,
} from './generated-output-localization-capability'
import {
  assertLockRuntimeClosed,
  awaitLockRuntimeIdle,
  disposeLockRuntime,
  resumeLockRuntime,
} from './locks'
import {
  assertMountedRepositoryProjectionsClosed,
  attachMountedRepositoryProjections,
  awaitMountedRepositoryProjectionsIdle,
  suspendMountedRepositoryProjections,
} from './mounted-projection-lifecycle'
import { type WorkspaceFence, WorkspaceSessionClosedError } from './repository'
import {
  activateStorageCompactionWriteAdmission,
  assertStorageCompactionDebtRuntimeClosed,
  assertStorageCompactionIntentOwnerClosed,
  awaitStorageCompactionDebtIdle,
  awaitStorageCompactionIntentOwnerIdle,
  closeStorageCompactionDebtRuntime,
  finishStorageCompactionDebtRuntimeClosure,
  resumeStorageCompactionDebtRuntime,
  stopStorageCompactionIntentOwner,
} from './storage-compaction-state'
import {
  abortStorageMaintenanceRuntime,
  assertStorageMaintenanceRuntimeClosed,
  attachStorageMaintenanceRuntime,
  awaitStorageMaintenanceRuntimeIdle,
  closeStorageMaintenanceRuntime,
  type StorageMaintenanceReplacementHandoffPort,
  startStorageMaintenanceRuntime,
} from './storage-maintenance-runtime'
import {
  assertStreamLeaseRuntimeClosed,
  awaitStreamLeaseRuntimeIdle,
  disposeStreamLeaseRuntime,
  resumeStreamLeaseRuntime,
} from './stream-leases'
import {
  abortStreamRecoveryCapability,
  activateStreamRecoveryCapability,
  assertStreamRecoveryCapabilityClosed,
  attachStreamRecoveryCapability,
  awaitStreamRecoveryCapabilityIdle,
  closeStreamRecoveryCapability,
} from './stream-recovery-capability'
import {
  assertLocalTransactionAdmissionsClosed,
  LocalTransactionActivityClosedError,
  resumeLocalTransactionAdmissions,
  stopLocalTransactionAdmissions,
  waitForLocalTransactionIdle,
} from './transaction-activity'
import { installWorkspaceEffectFatalFailureHandler } from './workspace-effect-hub'
import { suspendWorkspacePresentation } from './workspace-presentation-lifecycle'
import type { WorkspaceChange } from './workspace-protocol'
import { publishLocalWorkspaceInvalidation } from './workspace-repository'
import {
  claimWorkspaceRuntimeDemandBoundary,
  isWorkspaceMaintenancePreemptedError,
  isWorkspaceRuntimeClosedError,
  isWorkspaceRuntimeReplacementTransitionOwned,
  preemptWorkspaceReplacementContendersForRemoteTransition,
  releaseWorkspaceRuntimeDemandBoundary,
  subscribeWorkspaceRuntime,
  subscribeWorkspaceRuntimeIdle,
  subscribeWorkspaceRuntimeState,
  type WorkspaceRuntimeDemandBoundaryOwner,
} from './workspace-runtime'
import {
  abortWorkspaceRuntimeReconciliation,
  awaitWorkspaceRuntimeQuiesced,
  beginWorkspaceRuntimeQuiesce,
  beginWorkspaceRuntimeReconciliation,
  finishWorkspaceRuntimeReconciliation,
  getWorkspaceRuntimeControlSnapshot,
  installWorkspaceRuntimeResources,
  noteWorkspaceRuntimeGatedChange,
  resumeWorkspaceRuntimeResources,
  sealWorkspaceRuntime,
  settleWorkspaceUsableSurface,
  tryBeginWorkspaceRuntimeQuiesceIfIdle,
  type WorkspaceRuntimeReconciliationManifest,
  type WorkspaceRuntimeResourceManifest,
} from './workspace-runtime-control'
import { disposeLoadedWorkspaceSessionOwners } from './workspace-session-owner'
import {
  deleteChatFromWorkspaceTabSession,
  reconcileWorkspaceTabSessionStorage,
} from './workspace-tab-session'

let invalidatedWorkspaceSession: InvalidatedBrowserWorkspaceSession | null = null
let fatalWorkspaceReloadScheduled = false

interface BrowserWorkspaceLifecycleOwner {
  readonly activity: BrowserWorkspaceLifecycleActivity
  readonly demand: WorkspaceRuntimeDemandBoundaryOwner
  readonly fatalInvalidation: BrowserWorkspaceFatalInvalidationOwner
  readonly promotedReplacementDrain: BrowserWorkspacePromotedReplacementDrain
  readonly slotCoordinator: BrowserWorkspaceSlotCoordinatorOwner
  readonly unsubscribeWorkspaceChanges: () => void
  readonly unsubscribeWorkspaceRuntime: () => void
  readonly unsubscribeUsableSurfaces: () => void
  readonly unsubscribeWorkspaceEffectFailures: () => void
}

interface BrowserWorkspaceLifecycleActivity {
  readonly controller: AbortController
  readonly disposalReason: Error
  active: boolean
  remoteReconciliationRequested: boolean
  remoteReconciliationFence: WorkspaceFence | null
  remoteReconciliationPromise: Promise<void> | null
}

export interface BrowserWorkspacePromotedReplacementDrain {
  readonly handoffs: StorageMaintenanceReplacementHandoffPort
  closeAdmissions(): void
  awaitIdle(): Promise<void>
  assertClosed(): void
}

type BrowserWorkspaceLifecycleInstallation =
  | { readonly kind: 'uninstalled' }
  | { readonly kind: 'installing' }
  | { readonly kind: 'installed'; readonly owner: BrowserWorkspaceLifecycleOwner }
  | { readonly kind: 'failed'; readonly error: unknown }
  | { readonly kind: 'disposed' }

let browserWorkspaceLifecycleInstallation: BrowserWorkspaceLifecycleInstallation = {
  kind: 'uninstalled',
}

function createBrowserWorkspaceResourceManifest(
  replacementHandoffs: StorageMaintenanceReplacementHandoffPort,
): WorkspaceRuntimeResourceManifest {
  return {
    ...broadcastWorkspaceRuntimeResources,
    'attempt-workspace': {
      id: 'attempt-workspace',
      phase: 'inbound',
      closeAdmissions: disposeAttemptWorkspace,
      abort: disposeAttemptWorkspace,
      awaitIdle: awaitAttemptWorkspaceIdle,
      assertClosed: assertAttemptWorkspaceClosed,
      attach: attachAttemptWorkspace,
      prerequisites: [],
      activate: async ({ runtimeGeneration, workspaceId, replacementEpoch, signal }) => {
        try {
          await startAttemptWorkspace({ workspaceId, replacementEpoch }, signal)
          settleWorkspaceUsableSurface({
            runtimeGeneration,
            workspaceId,
            replacementEpoch,
            surface: 'active-stop',
            outcome: 'ready',
          })
        } catch (error) {
          settleWorkspaceUsableSurface({
            runtimeGeneration,
            workspaceId,
            replacementEpoch,
            surface: 'active-stop',
            outcome: 'error',
          })
          throw error
        }
      },
    },
    'conversation-workspace': {
      id: 'conversation-workspace',
      phase: 'inbound',
      closeAdmissions: disposeConversationWorkspace,
      abort: disposeConversationWorkspace,
      awaitIdle: () => Promise.resolve(),
      assertClosed: assertConversationWorkspaceClosed,
      attach: attachConversationWorkspace,
    },
    'attachment-catalog-workspace': {
      id: 'attachment-catalog-workspace',
      phase: 'inbound',
      closeAdmissions: suspendAttachmentCatalogWorkspace,
      abort: suspendAttachmentCatalogWorkspace,
      awaitIdle: () => Promise.resolve(),
      assertClosed: assertAttachmentCatalogWorkspaceClosed,
      attach: (fence) => {
        attachAttachmentCatalogWorkspace(fence)
        reconcileAttachmentCatalogWorkspace(fence)
      },
    },
    'configuration-workspace': {
      id: 'configuration-workspace',
      phase: 'inbound',
      closeAdmissions: disposeConfigurationWorkspace,
      abort: disposeConfigurationWorkspace,
      awaitIdle: () => Promise.resolve(),
      assertClosed: assertConfigurationWorkspaceClosed,
      attach: attachConfigurationWorkspace,
    },
    'configuration-model-resolution': {
      id: 'configuration-model-resolution',
      phase: 'producer',
      closeAdmissions: closeConfigurationModelResolutionCapability,
      abort: abortConfigurationModelResolutionCapability,
      awaitIdle: awaitConfigurationModelResolutionCapabilityIdle,
      assertClosed: assertConfigurationModelResolutionCapabilityClosed,
      attach: attachConfigurationModelResolutionCapability,
      prerequisites: [],
      activate: activateConfigurationModelResolutionCapability,
    },
    'stream-recovery': {
      id: 'stream-recovery',
      phase: 'producer',
      closeAdmissions: closeStreamRecoveryCapability,
      abort: abortStreamRecoveryCapability,
      awaitIdle: awaitStreamRecoveryCapabilityIdle,
      assertClosed: assertStreamRecoveryCapabilityClosed,
      attach: attachStreamRecoveryCapability,
      prerequisites: ['active-stop'],
      activate: activateStreamRecoveryCapability,
    },
    'generated-output-localization': {
      id: 'generated-output-localization',
      phase: 'producer',
      closeAdmissions: closeGeneratedOutputLocalizationCapability,
      abort: abortGeneratedOutputLocalizationCapability,
      awaitIdle: awaitGeneratedOutputLocalizationCapabilityIdle,
      assertClosed: assertGeneratedOutputLocalizationCapabilityClosed,
      attach: attachGeneratedOutputLocalizationCapability,
      prerequisites: [],
      activate: activateGeneratedOutputLocalizationCapability,
    },
    'storage-maintenance': {
      id: 'storage-maintenance',
      phase: 'producer',
      closeAdmissions: closeStorageMaintenanceRuntime,
      abort: abortStorageMaintenanceRuntime,
      awaitIdle: awaitStorageMaintenanceRuntimeIdle,
      assertClosed: assertStorageMaintenanceRuntimeClosed,
      attach: (fence) => attachStorageMaintenanceRuntime(fence, replacementHandoffs),
      prerequisites: [],
      activate: startStorageMaintenanceCapabilities,
    },
    'stream-leases': {
      id: 'stream-leases',
      phase: 'producer',
      closeAdmissions: () => {},
      abort: disposeStreamLeaseRuntime,
      awaitIdle: awaitStreamLeaseRuntimeIdle,
      assertClosed: assertStreamLeaseRuntimeClosed,
      attach: resumeStreamLeaseRuntime,
    },
    'mounted-projections': {
      id: 'mounted-projections',
      phase: 'query',
      closeAdmissions: () => {},
      abort: suspendMountedRepositoryProjections,
      awaitIdle: awaitMountedRepositoryProjectionsIdle,
      assertClosed: assertMountedRepositoryProjectionsClosed,
      attach: attachMountedRepositoryProjections,
    },
    'browser-workspace-repository': {
      id: 'browser-workspace-repository',
      phase: 'repository',
      closeAdmissions: closeBrowserWorkspaceRepositoryCapabilities,
      abort: () => {},
      awaitIdle: awaitBrowserWorkspaceRepositoryCapabilitiesIdle,
      assertClosed: assertBrowserWorkspaceRepositoryCapabilitiesClosed,
      resume: resumeBrowserWorkspaceRepositoryCapabilities,
    },
    'workspace-locks': {
      id: 'workspace-locks',
      phase: 'lock',
      closeAdmissions: () => {},
      abort: disposeLockRuntime,
      awaitIdle: awaitLockRuntimeIdle,
      assertClosed: assertLockRuntimeClosed,
      resume: resumeLockRuntime,
    },
    'local-transactions': {
      id: 'local-transactions',
      phase: 'transaction',
      closeAdmissions: stopLocalTransactionAdmissions,
      abort: () => {},
      awaitIdle: async () => {
        await waitForLocalTransactionIdle()
        closeStorageCompactionDebtRuntime()
        await awaitStorageCompactionDebtIdle()
      },
      finishDispose: finishStorageCompactionDebtRuntimeClosure,
      assertClosed: assertLocalTransactionResourcesClosed,
      resume: () => {
        resumeStorageCompactionDebtRuntime()
        resumeLocalTransactionAdmissions()
      },
    },
    'browser-workspace-session': {
      id: 'browser-workspace-session',
      phase: 'session',
      closeAdmissions: () => {
        invalidatedWorkspaceSession ??= invalidateBrowserWorkspaceSession()
      },
      abort: () => {},
      awaitIdle: () => invalidatedWorkspaceSession?.waitForIdle() ?? Promise.resolve(),
      assertClosed: assertBrowserWorkspaceSessionAdmissionsClosed,
      finishDispose: async () => {
        const session = invalidatedWorkspaceSession
        if (session) await closeInvalidatedBrowserWorkspaceSession(session)
        invalidatedWorkspaceSession = null
        const selection = activeDatabaseSelection
        if (selection) {
          const releasing = releaseActiveBrowserWorkspaceDatabaseSelection(selection)
          activeDatabaseSelection = null
          await releasing
        }
      },
      resume: () => {
        resumeBrowserWorkspaceSessionAdmissions()
        getBrowserWorkspaceSession()
      },
    },
  } satisfies WorkspaceRuntimeResourceManifest
}

const BROWSER_WORKSPACE_RECONCILIATION_MANIFEST = {
  'tab-session': {
    id: 'tab-session',
    reconcile: (authority) => {
      reconcileWorkspaceTabSessionStorage(authority)
    },
  },
} satisfies WorkspaceRuntimeReconciliationManifest

export function installBrowserWorkspaceLifecycle(): void {
  installBrowserWorkspaceReplacementReopen(openBrowserWorkspace)
  const installation = browserWorkspaceLifecycleInstallation
  if (installation.kind === 'installed') return
  if (installation.kind === 'installing') {
    throw new Error('BrowserWorkspaceLifecycleInstallationReentered')
  }
  if (installation.kind === 'disposed') throw new Error('BrowserWorkspaceLifecycleDisposed')
  if (installation.kind === 'failed') throw installation.error

  browserWorkspaceLifecycleInstallation = { kind: 'installing' }
  const activity: BrowserWorkspaceLifecycleActivity = {
    controller: new AbortController(),
    disposalReason: new Error('BrowserWorkspaceLifecycleDisposed'),
    active: true,
    remoteReconciliationRequested: false,
    remoteReconciliationFence: null,
    remoteReconciliationPromise: null,
  }
  const promotedReplacementDrain = createBrowserWorkspacePromotedReplacementDrain()
  let demand: WorkspaceRuntimeDemandBoundaryOwner | null = null
  let fatalInvalidation: BrowserWorkspaceFatalInvalidationOwner | null = null
  let slotCoordinator: BrowserWorkspaceSlotCoordinatorOwner | null = null
  let unsubscribeWorkspaceChanges: (() => void) | null = null
  let unsubscribeWorkspaceRuntime: (() => void) | null = null
  let unsubscribeUsableSurfaces: (() => void) | null = null
  let unsubscribeWorkspaceEffectFailures: (() => void) | null = null
  try {
    demand = claimWorkspaceRuntimeDemandBoundary(requestBrowserWorkspaceRunning)
    fatalInvalidation = claimBrowserWorkspaceFatalInvalidationOwner(
      receiveFatalWorkspaceInvalidation,
    )
    unsubscribeWorkspaceEffectFailures = installWorkspaceEffectFatalFailureHandler(
      receiveFatalWorkspaceEffectFailure,
    )
    slotCoordinator = installBrowserWorkspaceSlotCoordinator({
      validateQuiesce: validateBrowserWorkspaceSlotQuiesce,
      reconcile: reconcileBrowserWorkspaceSlotTransition,
    })
    unsubscribeWorkspaceChanges = subscribeWorkspaceApplicationChanges((change) =>
      receiveWorkspaceChange(activity, change),
    )
    unsubscribeWorkspaceRuntime = subscribeWorkspaceRuntime(() =>
      receiveWorkspaceRuntimeOpened(activity),
    )
    unsubscribeUsableSurfaces = installWorkspaceUsableSurfaceObservers()
    const owner: BrowserWorkspaceLifecycleOwner = {
      activity,
      demand,
      fatalInvalidation,
      promotedReplacementDrain,
      slotCoordinator,
      unsubscribeWorkspaceChanges,
      unsubscribeWorkspaceRuntime,
      unsubscribeUsableSurfaces,
      unsubscribeWorkspaceEffectFailures,
    }
    installWorkspaceRuntimeResources(
      createBrowserWorkspaceResourceManifest(promotedReplacementDrain.handoffs),
      BROWSER_WORKSPACE_RECONCILIATION_MANIFEST,
    )
    browserWorkspaceLifecycleInstallation = { kind: 'installed', owner }
  } catch (error) {
    revokeBrowserWorkspaceLifecycleActivity(activity)
    const rollbackFailures: unknown[] = []
    releaseLifecycleInstallationStep(rollbackFailures, () =>
      promotedReplacementDrain.closeAdmissions(),
    )
    releaseLifecycleInstallationStep(rollbackFailures, () =>
      promotedReplacementDrain.assertClosed(),
    )
    releaseLifecycleInstallationStep(rollbackFailures, unsubscribeWorkspaceRuntime)
    releaseLifecycleInstallationStep(rollbackFailures, unsubscribeUsableSurfaces)
    releaseLifecycleInstallationStep(rollbackFailures, unsubscribeWorkspaceEffectFailures)
    releaseLifecycleInstallationStep(rollbackFailures, unsubscribeWorkspaceChanges)
    const ownedSlotCoordinator = slotCoordinator
    releaseLifecycleInstallationStep(
      rollbackFailures,
      ownedSlotCoordinator
        ? () => disposeBrowserWorkspaceSlotCoordinator(ownedSlotCoordinator)
        : null,
    )
    const ownedFatalInvalidation = fatalInvalidation
    releaseLifecycleInstallationStep(
      rollbackFailures,
      ownedFatalInvalidation
        ? () => releaseBrowserWorkspaceFatalInvalidationOwner(ownedFatalInvalidation)
        : null,
    )
    const ownedDemand = demand
    releaseLifecycleInstallationStep(
      rollbackFailures,
      ownedDemand ? () => releaseWorkspaceRuntimeDemandBoundary(ownedDemand) : null,
    )
    if (rollbackFailures.length === 0) {
      browserWorkspaceLifecycleInstallation = { kind: 'uninstalled' }
      throw error
    }
    const failure = new AggregateError(
      [error, ...rollbackFailures],
      'BrowserWorkspaceLifecycleInstallationRollbackFailed',
    )
    browserWorkspaceLifecycleInstallation = { kind: 'failed', error: failure }
    throw failure
  }
}

async function validateBrowserWorkspaceSlotQuiesce(
  transition: BrowserWorkspaceSlotTransition,
): Promise<boolean> {
  const pending = (await readBrowserWorkspaceDatabaseManifest()).pending
  return (
    pending?.phase === 'preparing' &&
    pending.nonce === transition.nonce &&
    pending.sourceDatabaseName === transition.sourceDatabaseName &&
    pending.destinationDatabaseName === transition.destinationDatabaseName
  )
}

async function reconcileBrowserWorkspaceSlotTransition(
  transition: BrowserWorkspaceSlotTransition,
  signal: AbortSignal,
): Promise<void> {
  preemptWorkspaceReplacementContendersForRemoteTransition()
  await shutdownBrowserWorkspaceWhenIdle({ signal })
  await recoverQuiescedBrowserWorkspaceReplacement(transition, signal)
  await raceWithAbortSignal(() => resumeBrowserWorkspace(), signal)
}

function releaseLifecycleInstallationStep(failures: unknown[], release: (() => void) | null): void {
  if (!release) return
  try {
    release()
  } catch (error) {
    failures.push(error)
  }
}

function receiveFatalWorkspaceInvalidation(): void {
  scheduleFatalWorkspaceReload()
}

function receiveFatalWorkspaceEffectFailure(): void {
  scheduleFatalWorkspaceReload()
}

function assertLocalTransactionResourcesClosed(): void {
  assertLocalTransactionAdmissionsClosed()
  assertStorageCompactionDebtRuntimeClosed()
}

function closeBrowserWorkspaceRepositoryCapabilities(): void {
  stopBrowserWorkspaceRepositoryAdmissions()
  stopStorageCompactionIntentOwner()
}

async function awaitBrowserWorkspaceRepositoryCapabilitiesIdle(): Promise<void> {
  await awaitBrowserWorkspaceRepositoryIdle()
  await awaitStorageCompactionIntentOwnerIdle()
}

function assertBrowserWorkspaceRepositoryCapabilitiesClosed(): void {
  assertBrowserWorkspaceRepositoryAdmissionsClosed()
  assertStorageCompactionIntentOwnerClosed()
}

function resumeBrowserWorkspaceRepositoryCapabilities(): void {
  const session = getBrowserWorkspaceSession()
  session.runOperation((db) => activateStorageCompactionWriteAdmission(db))
  resumeBrowserWorkspaceRepositoryAdmissions()
}

function startStorageMaintenanceCapabilities(): void {
  startStorageMaintenanceRuntime()
}

export type { BrowserWorkspaceOpenOptions } from './browser-workspace-open-contract'

interface WorkspaceShutdownTransition {
  promise: Promise<void>
  terminal: boolean
}

interface BrowserWorkspaceOpenAttempt {
  readonly id: number
  readonly authority: BrowserWorkspaceBootstrapAuthority
  readonly observers: Set<BrowserWorkspaceOpenOptions>
  desired: 'open' | 'closed' | 'sealed'
  cancelled: boolean
  cancellationReason: unknown
  latestBlocked: IDBVersionChangeEvent | null
  latestProgress: BrowserWorkspaceOpenProgress | null
  selection: OpeningBrowserWorkspaceDatabaseSelection | null
  promise: Promise<void>
}

let shutdownTransition: WorkspaceShutdownTransition | null = null
let currentOpenAttempt: BrowserWorkspaceOpenAttempt | null = null
let activeDatabaseSelection: ActiveBrowserWorkspaceDatabaseSelection | null = null
let nextOpenAttemptId = 0
let terminalLifecycleFinalization: Promise<void> | null = null

export function openBrowserWorkspace(options: BrowserWorkspaceOpenOptions = {}): Promise<void> {
  const snapshot = getWorkspaceRuntimeControlSnapshot()
  if (snapshot.state === 'SEALED') {
    return Promise.reject(new Error('BrowserWorkspaceTerminalShutdown'))
  }
  installBrowserWorkspaceLifecycle()
  if (snapshot.state === 'RUNNING') return Promise.resolve()
  const existing = currentOpenAttempt
  if (existing) {
    if (existing.desired === 'sealed') {
      return Promise.reject(new Error('BrowserWorkspaceTerminalShutdown'))
    }
    existing.desired = 'open'
    if (!existing.cancelled) {
      observeBrowserWorkspaceOpenAttempt(existing, options)
      return existing.promise
    }
    return awaitExpectedBrowserWorkspaceOpenCancellation(existing).then(() =>
      openBrowserWorkspace(options),
    )
  }
  const attempt: BrowserWorkspaceOpenAttempt = {
    id: ++nextOpenAttemptId,
    authority: beginBrowserWorkspaceBootstrap(),
    observers: new Set(),
    desired: 'open',
    cancelled: false,
    cancellationReason: null,
    latestBlocked: null,
    latestProgress: null,
    selection: null,
    promise: Promise.resolve(),
  }
  observeBrowserWorkspaceOpenAttempt(attempt, options)
  const opening = performBrowserWorkspaceOpen(
    attempt,
    browserWorkspaceOpenAttemptOptions(attempt),
  ).finally(() => {
    if (currentOpenAttempt === attempt) currentOpenAttempt = null
  })
  attempt.promise = opening
  currentOpenAttempt = attempt
  return opening
}

function observeBrowserWorkspaceOpenAttempt(
  attempt: BrowserWorkspaceOpenAttempt,
  observer: BrowserWorkspaceOpenOptions,
): void {
  attempt.observers.add(observer)
  if (attempt.latestProgress) observer.onProgress?.(attempt.latestProgress)
  if (attempt.latestBlocked) observer.onBlocked?.(attempt.latestBlocked)
}

function browserWorkspaceOpenAttemptOptions(
  attempt: BrowserWorkspaceOpenAttempt,
): BrowserWorkspaceOpenOptions {
  return {
    onProgress: (progress) => {
      attempt.latestProgress = progress
      for (const observer of attempt.observers) observer.onProgress?.(progress)
    },
    onBlocked: (event) => {
      attempt.latestBlocked = event
      for (const observer of attempt.observers) observer.onBlocked?.(event)
    },
  }
}

export function shutdownBrowserWorkspace(options: { terminal?: boolean } = {}): Promise<void> {
  const snapshot = getWorkspaceRuntimeControlSnapshot()
  if (snapshot.state === 'SEALED') {
    return finalizeTerminalBrowserWorkspaceLifecycle()
  }
  installBrowserWorkspaceLifecycle()
  const opening = currentOpenAttempt
  if (opening) {
    if (options.terminal) opening.desired = 'sealed'
    else if (opening.desired !== 'sealed') opening.desired = 'closed'
    opening.cancelled = true
    opening.cancellationReason = new DOMException('Workspace opening cancelled', 'AbortError')
    cancelBrowserWorkspaceBootstrap(opening.authority, opening.cancellationReason)
    return awaitExpectedBrowserWorkspaceOpenCancellation(opening).then(() =>
      finishBrowserWorkspaceOpenAttemptDesiredState(opening),
    )
  }
  if (snapshot.state === 'STARTING' || snapshot.state === 'FAILED_CLOSED') {
    if (options.terminal) return finishTerminalBrowserWorkspaceShutdownBeforeOpen()
    return Promise.resolve()
  }
  if (shutdownTransition) {
    if (options.terminal) shutdownTransition.terminal = true
    const transition = shutdownTransition
    return transition.promise.then(() => finishTerminalBrowserWorkspaceShutdown(transition))
  }
  beginWorkspaceRuntimeQuiesce()
  return startBrowserWorkspaceShutdown(options.terminal ?? false)
}

async function awaitExpectedBrowserWorkspaceOpenCancellation(
  attempt: BrowserWorkspaceOpenAttempt,
): Promise<void> {
  try {
    await attempt.promise
  } catch (error) {
    const snapshot = getWorkspaceRuntimeControlSnapshot()
    const verifiedClosed =
      snapshot.resourcesQuiesced &&
      (snapshot.state === 'STARTING' ||
        snapshot.state === 'QUIESCED' ||
        snapshot.state === 'FAILED_CLOSED')
    if (attempt.cancelled && error === attempt.cancellationReason && verifiedClosed) return
    throw error
  }
}

function finishBrowserWorkspaceOpenAttemptDesiredState(
  attempt: BrowserWorkspaceOpenAttempt,
): Promise<void> {
  if (attempt.desired === 'open') return openBrowserWorkspace()
  const snapshot = getWorkspaceRuntimeControlSnapshot()
  if (attempt.desired === 'sealed') {
    if (
      snapshot.state === 'STARTING' ||
      snapshot.state === 'QUIESCED' ||
      snapshot.state === 'FAILED_CLOSED'
    ) {
      return finishTerminalBrowserWorkspaceShutdownBeforeOpen()
    }
    return shutdownBrowserWorkspace({ terminal: true })
  }
  if (snapshot.state === 'RUNNING') return shutdownBrowserWorkspace()
  return Promise.resolve()
}

function startBrowserWorkspaceShutdown(terminal: boolean): Promise<void> {
  if (shutdownTransition) {
    if (terminal) shutdownTransition.terminal = true
    const transition = shutdownTransition
    return transition.promise.then(() => finishTerminalBrowserWorkspaceShutdown(transition))
  }
  const transition: WorkspaceShutdownTransition = {
    terminal,
    promise: Promise.resolve(),
  }
  transition.promise = awaitWorkspaceRuntimeQuiesced()
    .then(
      () => finishTerminalBrowserWorkspaceShutdown(transition),
      async (error: unknown) => {
        const state = getWorkspaceRuntimeControlSnapshot().state
        let finalizationFailure: unknown = null
        try {
          if (state === 'SEALED') await finalizeTerminalBrowserWorkspaceLifecycle()
          else await finishTerminalBrowserWorkspaceShutdown(transition)
        } catch (finalizationError) {
          finalizationFailure = finalizationError
        } finally {
          if (state === 'SEALED') scheduleFatalWorkspaceReload()
        }
        if (finalizationFailure) {
          throw new AggregateError(
            [error, finalizationFailure],
            'BrowserWorkspaceShutdownAndFinalizationFailed',
          )
        }
        throw error
      },
    )
    .finally(() => {
      if (shutdownTransition === transition) shutdownTransition = null
    })
  shutdownTransition = transition
  return transition.promise
}

function tryShutdownBrowserWorkspaceIfIdle(): Promise<void> | null {
  const snapshot = getWorkspaceRuntimeControlSnapshot()
  if (snapshot.state === 'STARTING' && currentOpenAttempt === null) {
    return Promise.resolve()
  }
  if (snapshot.state === 'QUIESCED' || snapshot.state === 'FAILED_CLOSED') {
    return Promise.resolve()
  }
  if (snapshot.state !== 'RUNNING' || shutdownTransition) return null
  if (!tryBeginWorkspaceRuntimeQuiesceIfIdle()) return null
  return startBrowserWorkspaceShutdown(false)
}

export function shutdownBrowserWorkspaceWhenIdle(
  options: { readonly signal?: AbortSignal } = {},
): Promise<void> {
  const { signal } = options
  if (signal?.aborted) return Promise.reject(workspaceLifecycleError(signal.reason))
  const immediate = tryShutdownBrowserWorkspaceIfIdle()
  if (immediate) return raceWithAbortSignal(() => immediate, signal)
  return new Promise<void>((resolve, reject) => {
    let settled = false
    let transitionSelected = false
    let unsubscribeIdle: () => void = () => undefined
    let unsubscribeOpened: () => void = () => undefined
    let unsubscribeState: () => void = () => undefined
    const cleanup = () => {
      unsubscribeIdle()
      unsubscribeOpened()
      unsubscribeState()
      signal?.removeEventListener('abort', abort)
    }
    const settle = (publish: () => void) => {
      if (settled) return
      settled = true
      cleanup()
      publish()
    }
    const abort = () => settle(() => reject(workspaceLifecycleError(signal?.reason)))
    const settleFrom = (transition: Promise<void>) => {
      if (settled || transitionSelected) return
      transitionSelected = true
      unsubscribeIdle()
      unsubscribeOpened()
      unsubscribeState()
      void transition.then(
        () => settle(resolve),
        (error: unknown) => settle(() => reject(workspaceLifecycleError(error))),
      )
    }
    const fail = (error: unknown) => {
      settle(() => reject(workspaceLifecycleError(error)))
    }
    const attempt = () => {
      if (settled) return
      if (currentOpenAttempt) {
        settleFrom(shutdownBrowserWorkspace())
        return
      }
      const snapshot = getWorkspaceRuntimeControlSnapshot()
      if (
        snapshot.state === 'SEALED' ||
        snapshot.state === 'QUIESCED' ||
        snapshot.state === 'FAILED_CLOSED'
      ) {
        settleFrom(Promise.resolve())
        return
      }
      if (snapshot.state === 'QUIESCING') {
        settleFrom(shutdownTransition?.promise ?? awaitWorkspaceRuntimeQuiesced())
        return
      }
      const transition = tryShutdownBrowserWorkspaceIfIdle()
      if (transition) settleFrom(transition)
    }
    unsubscribeIdle = subscribeWorkspaceRuntimeIdle(attempt)
    unsubscribeOpened = subscribeWorkspaceRuntime(() => {
      const opening = currentOpenAttempt
      if (opening) void opening.promise.then(attempt, fail)
      else queueMicrotask(attempt)
    })
    unsubscribeState = subscribeWorkspaceRuntimeState(attempt)
    signal?.addEventListener('abort', abort, { once: true })
    attempt()
  })
}

function workspaceLifecycleError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error('BrowserWorkspaceLifecycleOperationFailed', { cause: error })
}

function finishTerminalBrowserWorkspaceShutdown(
  transition: WorkspaceShutdownTransition,
): Promise<void> {
  if (!transition.terminal) return Promise.resolve()
  const state = getWorkspaceRuntimeControlSnapshot().state
  if (state !== 'QUIESCED' && state !== 'FAILED_CLOSED') return Promise.resolve()
  return finalizeTerminalBrowserWorkspaceLifecycle()
}

function finishTerminalBrowserWorkspaceShutdownBeforeOpen(): Promise<void> {
  return finalizeTerminalBrowserWorkspaceLifecycle()
}

function finalizeTerminalBrowserWorkspaceLifecycle(): Promise<void> {
  if (terminalLifecycleFinalization) return terminalLifecycleFinalization
  const finalizing = performTerminalBrowserWorkspaceLifecycleFinalization()
  terminalLifecycleFinalization = finalizing
  return finalizing
}

async function performTerminalBrowserWorkspaceLifecycleFinalization(): Promise<void> {
  await suspendWorkspacePresentation()
  const state = getWorkspaceRuntimeControlSnapshot().state
  const failures: unknown[] = []
  const disposal = beginBrowserWorkspaceLifecycleOwnerDisposal(failures)
  releaseLifecycleInstallationStep(failures, disposeLoadedWorkspaceSessionOwners)
  releaseLifecycleInstallationStep(failures, disposeAttachmentCatalogWorkspace)
  if (state !== 'SEALED') {
    releaseLifecycleInstallationStep(failures, sealWorkspaceRuntime)
  }
  if (disposal) {
    const idle = await Promise.allSettled([
      awaitBrowserWorkspaceSlotCoordinatorIdle(disposal.owner.slotCoordinator),
      disposal.remoteReconciliationPromise ?? Promise.resolve(),
      disposal.owner.promotedReplacementDrain.awaitIdle(),
    ])
    for (const result of idle) {
      if (
        result.status === 'rejected' &&
        result.reason !== disposal.owner.activity.disposalReason
      ) {
        failures.push(result.reason)
      }
    }
    releaseLifecycleInstallationStep(failures, () =>
      disposal.owner.promotedReplacementDrain.assertClosed(),
    )
  }
  try {
    await closeBrowserWorkspaceControlDatabase()
  } catch (error) {
    failures.push(error)
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'BrowserWorkspaceTerminalFinalizationFailed')
  }
}

function beginBrowserWorkspaceLifecycleOwnerDisposal(failures: unknown[]): {
  readonly owner: BrowserWorkspaceLifecycleOwner
  readonly remoteReconciliationPromise: Promise<void> | null
} | null {
  const installation = browserWorkspaceLifecycleInstallation
  if (installation.kind === 'disposed') return null
  if (installation.kind === 'uninstalled') {
    browserWorkspaceLifecycleInstallation = { kind: 'disposed' }
    return null
  }
  if (installation.kind === 'installing') {
    throw new Error('BrowserWorkspaceLifecycleDisposalDuringInstallation')
  }
  if (installation.kind === 'failed') throw installation.error
  const { owner } = installation
  const remoteReconciliationPromise = owner.activity.remoteReconciliationPromise
  releaseLifecycleInstallationStep(failures, () => owner.promotedReplacementDrain.closeAdmissions())
  revokeBrowserWorkspaceLifecycleActivity(owner.activity)
  browserWorkspaceLifecycleInstallation = { kind: 'disposed' }
  releaseLifecycleInstallationStep(failures, owner.unsubscribeWorkspaceRuntime)
  releaseLifecycleInstallationStep(failures, owner.unsubscribeUsableSurfaces)
  releaseLifecycleInstallationStep(failures, owner.unsubscribeWorkspaceEffectFailures)
  releaseLifecycleInstallationStep(failures, owner.unsubscribeWorkspaceChanges)
  releaseLifecycleInstallationStep(failures, () =>
    disposeBrowserWorkspaceSlotCoordinator(owner.slotCoordinator),
  )
  releaseLifecycleInstallationStep(failures, () =>
    releaseBrowserWorkspaceFatalInvalidationOwner(owner.fatalInvalidation),
  )
  releaseLifecycleInstallationStep(failures, () =>
    releaseWorkspaceRuntimeDemandBoundary(owner.demand),
  )
  return { owner, remoteReconciliationPromise }
}

export function createBrowserWorkspacePromotedReplacementDrain(): BrowserWorkspacePromotedReplacementDrain {
  let accepting = true
  let activeCount = 0
  let resolveIdle: (() => void) | null = null
  let idle: Promise<void> = Promise.resolve()

  const finish = (): void => {
    activeCount -= 1
    if (activeCount !== 0) return
    const resolve = resolveIdle
    resolveIdle = null
    resolve?.()
  }
  const finishFailure = (error: unknown): void => {
    try {
      if (isWorkspaceReplacementRecoveryRequiredError(error)) scheduleFatalWorkspaceReload()
      else if (
        !isWorkspaceMaintenancePreemptedError(error) &&
        !(error instanceof DOMException && error.name === 'AbortError')
      ) {
        console.error('Promoted workspace replacement failed', error)
      }
    } finally {
      finish()
    }
  }

  const handoffs: StorageMaintenanceReplacementHandoffPort = Object.freeze({
    transfer: <T>(handoff: BrowserWorkspaceReplacementHandoff<T>) => {
      if (!accepting) throw new Error('BrowserWorkspacePromotedReplacementDrainClosed')
      if (activeCount === 0) {
        idle = new Promise<void>((resolve) => {
          resolveIdle = resolve
        })
      }
      activeCount += 1
      void handoff.completion
        .then(
          () => finish(),
          (error: unknown) => finishFailure(error),
        )
        .catch(scheduleFatalWorkspaceReload)
    },
  })

  return Object.freeze({
    handoffs,
    closeAdmissions: () => {
      accepting = false
    },
    awaitIdle: async () => {
      if (accepting) throw new Error('BrowserWorkspacePromotedReplacementDrainAdmissionsOpen')
      await idle
    },
    assertClosed: () => {
      if (accepting || activeCount !== 0 || resolveIdle !== null) {
        throw new Error('BrowserWorkspacePromotedReplacementDrainNotClosed')
      }
    },
  })
}

export async function resumeBrowserWorkspace(): Promise<void> {
  await openBrowserWorkspace()
}

function requestBrowserWorkspaceRunning(): Promise<void> {
  const snapshot = getWorkspaceRuntimeControlSnapshot()
  if (snapshot.state === 'RUNNING') return Promise.resolve()
  if (snapshot.state === 'SEALED')
    return Promise.reject(new Error('BrowserWorkspaceTerminalShutdown'))
  return fulfillBrowserWorkspaceRuntimeDemand()
}

async function fulfillBrowserWorkspaceRuntimeDemand(): Promise<void> {
  for (;;) {
    const snapshot = getWorkspaceRuntimeControlSnapshot()
    if (snapshot.state === 'RUNNING') return
    if (snapshot.state === 'SEALED') throw new Error('BrowserWorkspaceTerminalShutdown')
    const opening = currentOpenAttempt?.promise
    if (opening) {
      await opening
      continue
    }
    if (snapshot.state === 'RECONCILING' || isWorkspaceRuntimeReplacementTransitionOwned()) {
      await waitForWorkspaceRuntimeStateChange(snapshot.state)
      continue
    }
    await openBrowserWorkspace()
  }
}

function waitForWorkspaceRuntimeStateChange(
  observedState: ReturnType<typeof getWorkspaceRuntimeControlSnapshot>['state'],
): Promise<void> {
  return new Promise<void>((resolve) => {
    let unsubscribe: () => void = () => undefined
    const inspect = () => {
      if (getWorkspaceRuntimeControlSnapshot().state === observedState) return
      unsubscribe()
      resolve()
    }
    unsubscribe = subscribeWorkspaceRuntimeState(inspect)
    inspect()
  })
}

function scheduleFatalWorkspaceReload(): void {
  if (fatalWorkspaceReloadScheduled) return
  fatalWorkspaceReloadScheduled = true
  queueMicrotask(() => {
    const location = (globalThis as unknown as { readonly location?: Location }).location
    location?.reload()
  })
}

async function performBrowserWorkspaceOpen(
  attempt: BrowserWorkspaceOpenAttempt,
  options: BrowserWorkspaceOpenOptions,
): Promise<void> {
  let opened = false
  const cleanupFailures: unknown[] = []
  try {
    let snapshot = getWorkspaceRuntimeControlSnapshot()
    if (snapshot.state === 'RUNNING') {
      opened = true
      return
    }
    if (snapshot.state === 'SEALED') throw new Error('BrowserWorkspaceTerminalShutdown')
    if (snapshot.state === 'QUIESCING') {
      await (shutdownTransition?.promise ?? awaitWorkspaceRuntimeQuiesced())
      snapshot = getWorkspaceRuntimeControlSnapshot()
    }
    if (snapshot.state === 'SEALED') throw new Error('BrowserWorkspaceTerminalShutdown')
    if (
      snapshot.state !== 'STARTING' &&
      snapshot.state !== 'QUIESCED' &&
      snapshot.state !== 'FAILED_CLOSED'
    ) {
      throw new Error(`BrowserWorkspaceCannotOpen:${snapshot.state}`)
    }
    shutdownTransition = null
    assertBrowserWorkspaceBootstrapAuthority(attempt.authority)
    attempt.selection = await runBrowserWorkspaceOpenStage('database-selection', () =>
      prepareBrowserWorkspaceDatabaseSelection(
        attempt.authority,
        options.onProgress,
        options.onBlocked,
      ),
    )
    assertBrowserWorkspaceBootstrapAuthority(attempt.authority)
    const workspace = await runBrowserWorkspaceOpenStage('database-bootstrap', () =>
      bootstrapBrowserWorkspace(attempt.authority, options),
    )
    assertBrowserWorkspaceBootstrapAuthority(attempt.authority)
    options.onProgress?.({ kind: 'runtime-resources', operation: 'reconcile' })
    const authority = beginWorkspaceRuntimeReconciliation(workspace, {
      signal: attempt.authority.signal,
    })
    activeDatabaseSelection = activateBrowserWorkspaceDatabaseSelection(
      attempt.selection,
      attempt.authority,
    )
    attempt.selection = null
    options.onProgress?.({ kind: 'runtime-resources', operation: 'activate' })
    await runBrowserWorkspaceOpenStage('runtime-resources-resume', () =>
      resumeWorkspaceRuntimeResources(authority),
    )
    assertBrowserWorkspaceBootstrapAuthority(attempt.authority)
    options.onProgress?.({ kind: 'runtime-resources', operation: 'settle' })
    await runBrowserWorkspaceOpenStage('runtime-reconciliation-finish', () =>
      finishWorkspaceRuntimeReconciliation(workspace),
    )
    const settledManifest = await runBrowserWorkspaceOpenStage('read-settled-manifest', () =>
      readBrowserWorkspaceDatabaseManifest(),
    )
    if (settledManifest.pending) {
      publishLocalWorkspaceInvalidation({
        kind: 'invalidate',
        ...workspace,
        dependencies: [{ kind: 'storage-maintenance', tasks: ['clean-replacement-database'] }],
      })
    }
    opened = true
  } catch (error) {
    if (getWorkspaceRuntimeControlSnapshot().state === 'RECONCILING') {
      cleanupFailures.push(...(await abortWorkspaceRuntimeReconciliation()))
    }
    const cleanup = { bootstrapSessionClosed: true }
    await discardBrowserWorkspaceBootstrapSession(attempt.authority).catch((cleanupError) => {
      cleanup.bootstrapSessionClosed = false
      cleanupFailures.push(cleanupError)
    })
    if (attempt.selection && cleanup.bootstrapSessionClosed) {
      const selection = attempt.selection
      const releasing = releaseOpeningBrowserWorkspaceDatabaseSelection(selection)
      attempt.selection = null
      await releasing.catch((cleanupError) => {
        cleanupFailures.push(cleanupError)
      })
    } else if (attempt.selection) {
      const stable = getWorkspaceRuntimeControlSnapshot().state
      if (stable === 'STARTING' || stable === 'QUIESCED' || stable === 'FAILED_CLOSED') {
        sealWorkspaceRuntime()
      }
    }
    if (getWorkspaceRuntimeControlSnapshot().state === 'SEALED') {
      await finalizeTerminalBrowserWorkspaceLifecycle().catch((cleanupError) => {
        cleanupFailures.push(cleanupError)
      })
      scheduleFatalWorkspaceReload()
    }
    if (cleanupFailures.length === 0) throw error
    throw new AggregateError(
      [error, ...cleanupFailures],
      'BrowserWorkspaceOpenFailedAndCleanupFailed',
      { cause: error },
    )
  } finally {
    finishBrowserWorkspaceBootstrap(attempt.authority)
    if (!opened && attempt.desired === 'sealed') {
      const stable = getWorkspaceRuntimeControlSnapshot().state
      if (stable === 'STARTING' || stable === 'QUIESCED' || stable === 'FAILED_CLOSED') {
        await finishTerminalBrowserWorkspaceShutdownBeforeOpen()
      }
    }
  }
}

async function runBrowserWorkspaceOpenStage<Result>(
  operation: string,
  run: () => Promise<Result>,
): Promise<Result> {
  try {
    return await run()
  } catch (error) {
    if (errorHasName(error, 'TransactionInactiveError')) {
      const diagnostic = new Error(`BrowserWorkspaceOpenTransactionInactive:${operation}`, {
        cause: error,
      })
      diagnostic.name = `BrowserWorkspaceOpenTransactionInactiveError_${operation}`
      throw diagnostic
    }
    throw error
  }
}

function receiveWorkspaceChange(
  activity: BrowserWorkspaceLifecycleActivity,
  change: WorkspaceChange,
): void {
  if (!browserWorkspaceLifecycleActivityIsCurrent(activity)) return
  const stamp = change.kind === 'commit' ? change.stamp : change
  const snapshot = getWorkspaceRuntimeControlSnapshot()
  const fenceChanged =
    snapshot.workspaceId !== null &&
    (stamp.workspaceId !== snapshot.workspaceId ||
      stamp.replacementEpoch !== snapshot.replacementEpoch)
  if (change.kind === 'commit' && !fenceChanged) {
    for (const fact of change.delta.facts) {
      if (fact.kind !== 'chat-deleted') continue
      deleteChatFromWorkspaceTabSession(fact.chatId)
    }
  }
  if (snapshot.state !== 'RUNNING') {
    noteWorkspaceRuntimeGatedChange({
      workspaceId: stamp.workspaceId,
      replacementEpoch: stamp.replacementEpoch,
      broad: change.kind === 'replace' || fenceChanged,
    })
  }
  if (!fenceChanged) return
  activity.remoteReconciliationRequested = true
  activity.remoteReconciliationFence = {
    workspaceId: stamp.workspaceId,
    replacementEpoch: stamp.replacementEpoch,
  }
  if (snapshot.state === 'RUNNING') startRemoteWorkspaceReconciliation(activity)
}

function receiveWorkspaceRuntimeOpened(activity: BrowserWorkspaceLifecycleActivity): void {
  if (!browserWorkspaceLifecycleActivityIsCurrent(activity)) return
  reconcileWorkspaceUsableSurfaces()
  if (activity.remoteReconciliationRequested) startRemoteWorkspaceReconciliation(activity)
}

function installWorkspaceUsableSurfaceObservers(): () => void {
  const unsubscribes = [
    conversationController.subscribe(reconcileWorkspaceUsableSurfaces),
    configurationController.subscribe(reconcileWorkspaceUsableSurfaces),
  ]
  reconcileWorkspaceUsableSurfaces()
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe()
  }
}

function reconcileWorkspaceUsableSurfaces(): void {
  const runtime = getWorkspaceRuntimeControlSnapshot()
  if (runtime.state !== 'RUNNING' || runtime.workspaceId === null) return
  const proof = {
    runtimeGeneration: runtime.runtimeGeneration,
    workspaceId: runtime.workspaceId,
    replacementEpoch: runtime.replacementEpoch,
  }
  const conversation = conversationController.getSnapshot()
  if (
    conversation.workspaceId === proof.workspaceId &&
    conversation.workspaceEpoch === proof.replacementEpoch
  ) {
    if (conversation.activeChatId === null) {
      settleWorkspaceUsableSurface({
        ...proof,
        surface: 'route-terminal',
        outcome: 'empty',
      })
    } else if (
      conversation.active &&
      terminalConversationDestination(conversation.active.destination) &&
      (conversation.active.destination.kind !== 'ready' || conversation.active.chat !== null)
    ) {
      const destination = conversation.active.destination
      settleWorkspaceUsableSurface({
        ...proof,
        surface: 'route-terminal',
        outcome:
          destination.kind === 'ready'
            ? 'ready'
            : destination.kind === 'missing'
              ? 'missing'
              : 'error',
      })
    }
  }
  const configuration = configurationController.getSnapshot()
  if (
    configuration.workspaceFence?.workspaceId !== proof.workspaceId ||
    configuration.workspaceFence.replacementEpoch !== proof.replacementEpoch
  ) {
    return
  }
  const selection = configuration.frame.selection
  if (configuration.loads.shell.status === 'error') {
    settleWorkspaceUsableSurface({
      ...proof,
      surface: 'active-configuration',
      outcome: 'error',
    })
    return
  }
  if (!configuration.frame.shell) return
  const activeChatId = conversation.activeChatId
  const target = configuration.frame.target
  if (
    (activeChatId !== null && (target.kind !== 'chat' || target.chatId !== activeChatId)) ||
    (activeChatId === null && target.kind !== 'new-chat' && target.kind !== 'none')
  ) {
    return
  }
  if (target.kind === 'none' && selection.status === 'absent') {
    settleWorkspaceUsableSurface({
      ...proof,
      surface: 'active-configuration',
      outcome: 'empty',
    })
    return
  }
  if (selection.status === 'ready' || selection.status === 'error') {
    settleWorkspaceUsableSurface({
      ...proof,
      surface: 'active-configuration',
      outcome: selection.status === 'ready' ? 'ready' : 'error',
    })
  }
}

function terminalConversationDestination(destination: ConversationDestinationProjection): boolean {
  return (
    destination.kind === 'ready' ||
    destination.kind === 'missing' ||
    destination.kind === 'unavailable' ||
    destination.kind === 'failed'
  )
}

function startRemoteWorkspaceReconciliation(activity: BrowserWorkspaceLifecycleActivity): void {
  if (!browserWorkspaceLifecycleActivityIsCurrent(activity)) return
  if (activity.remoteReconciliationPromise) return
  const snapshot = getWorkspaceRuntimeControlSnapshot()
  if (
    activity.remoteReconciliationFence &&
    snapshot.workspaceId === activity.remoteReconciliationFence.workspaceId &&
    snapshot.replacementEpoch === activity.remoteReconciliationFence.replacementEpoch
  ) {
    activity.remoteReconciliationRequested = false
    activity.remoteReconciliationFence = null
    return
  }
  const running = drainRemoteWorkspaceReconciliation(activity)
  activity.remoteReconciliationPromise = running
  void running
    .then(
      () => settleRemoteWorkspaceReconciliation(activity, running),
      (error: unknown) => {
        if (activity.remoteReconciliationPromise === running) {
          activity.remoteReconciliationPromise = null
        }
        activity.remoteReconciliationRequested = false
        activity.remoteReconciliationFence = null
        if (
          error === activity.disposalReason ||
          !browserWorkspaceLifecycleActivityIsCurrent(activity)
        ) {
          return
        }
        scheduleFatalWorkspaceReload()
      },
    )
    .catch(scheduleFatalWorkspaceReload)
}

function settleRemoteWorkspaceReconciliation(
  activity: BrowserWorkspaceLifecycleActivity,
  running: Promise<void>,
): void {
  if (activity.remoteReconciliationPromise === running) {
    activity.remoteReconciliationPromise = null
  }
  if (
    browserWorkspaceLifecycleActivityIsCurrent(activity) &&
    activity.remoteReconciliationRequested &&
    getWorkspaceRuntimeControlSnapshot().state === 'RUNNING'
  ) {
    startRemoteWorkspaceReconciliation(activity)
  }
}

async function drainRemoteWorkspaceReconciliation(
  activity: BrowserWorkspaceLifecycleActivity,
): Promise<void> {
  while (activity.remoteReconciliationRequested) {
    assertBrowserWorkspaceLifecycleActivityCurrent(activity)
    const snapshot = getWorkspaceRuntimeControlSnapshot()
    if (snapshot.state === 'STARTING' || snapshot.state === 'RECONCILING') return
    if (snapshot.state === 'SEALED') {
      activity.remoteReconciliationRequested = false
      activity.remoteReconciliationFence = null
      return
    }
    activity.remoteReconciliationRequested = false
    try {
      await raceWithAbortSignal(() => shutdownBrowserWorkspace(), activity.controller.signal)
      assertBrowserWorkspaceLifecycleActivityCurrent(activity)
      await raceWithAbortSignal(() => openBrowserWorkspace(), activity.controller.signal)
      assertBrowserWorkspaceLifecycleActivityCurrent(activity)
      const current = getWorkspaceRuntimeControlSnapshot()
      if (
        activity.remoteReconciliationFence &&
        current.workspaceId === activity.remoteReconciliationFence.workspaceId &&
        current.replacementEpoch === activity.remoteReconciliationFence.replacementEpoch
      ) {
        activity.remoteReconciliationFence = null
      }
    } catch (error) {
      if (
        error === activity.disposalReason ||
        !browserWorkspaceLifecycleActivityIsCurrent(activity)
      ) {
        throw activity.disposalReason
      }
      activity.remoteReconciliationRequested = true
      if (getWorkspaceRuntimeControlSnapshot().state === 'RECONCILING') {
        beginWorkspaceRuntimeQuiesce()
      }
      return
    }
  }
}

function browserWorkspaceLifecycleActivityIsCurrent(
  activity: BrowserWorkspaceLifecycleActivity,
): boolean {
  const installation = browserWorkspaceLifecycleInstallation
  return (
    activity.active &&
    !activity.controller.signal.aborted &&
    installation.kind === 'installed' &&
    installation.owner.activity === activity
  )
}

function assertBrowserWorkspaceLifecycleActivityCurrent(
  activity: BrowserWorkspaceLifecycleActivity,
): void {
  if (browserWorkspaceLifecycleActivityIsCurrent(activity)) return
  throw activity.disposalReason
}

function revokeBrowserWorkspaceLifecycleActivity(
  activity: BrowserWorkspaceLifecycleActivity,
): void {
  if (!activity.active) return
  activity.active = false
  activity.remoteReconciliationRequested = false
  activity.remoteReconciliationFence = null
  activity.controller.abort(activity.disposalReason)
}

const EXPECTED_SHUTDOWN_ERROR_MESSAGES = new Set([
  'LockBackendDisposed',
  'LockRuntimeDisposed',
  'StreamLeaseRuntimeDisposed',
])

export function isExpectedBrowserWorkspaceShutdownError(error: unknown): boolean {
  const pending = [error]
  const seen = new Set<object>()
  for (let index = 0; index < pending.length && index < 32; index += 1) {
    const candidate = pending[index]
    if (
      candidate instanceof WorkspaceSessionClosedError ||
      candidate instanceof LocalTransactionActivityClosedError ||
      isWorkspaceRuntimeClosedError(candidate)
    ) {
      return true
    }
    if (candidate instanceof Error && EXPECTED_SHUTDOWN_ERROR_MESSAGES.has(candidate.message)) {
      return true
    }
    if (!candidate || typeof candidate !== 'object' || seen.has(candidate)) continue
    seen.add(candidate)
    const wrapped = candidate as { cause?: unknown; errors?: unknown; inner?: unknown }
    if (wrapped.cause !== undefined) pending.push(wrapped.cause)
    if (wrapped.inner !== undefined) pending.push(wrapped.inner)
    if (Array.isArray(wrapped.errors)) {
      for (const error of wrapped.errors as unknown[]) pending.push(error)
    }
  }
  return false
}
