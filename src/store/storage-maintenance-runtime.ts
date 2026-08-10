import Dexie from 'dexie'
import { isWorkspaceReplacementRecoveryRequiredError } from '../core/import-export/errors'
import { isPageHiding } from '../lib/page-lifecycle'
import { yieldToEventLoop } from '../lib/yield-to-event-loop'
import { cleanPendingBrowserWorkspaceDatabase } from './browser-workspace-database-cleanup'
import type {
  BrowserWorkspaceCompactionResult,
  BrowserWorkspaceReplacementHandoff,
  BrowserWorkspaceReplacementStart,
} from './browser-workspace-maintenance-contract'
import { reclaimInactiveBrowserWorkspaceDatabases } from './browser-workspace-orphan-reclamation'
import { withBrowserWorkspaceSelectionGate } from './browser-workspace-slot-coordination'
import type { NatterDb } from './db'
import { getBrowserWorkspaceSession } from './db'
import { withCoordinationLock } from './locks'
import type { WorkspaceFence } from './repository'
import {
  awaitStorageCompactionDebtIdle,
  flushStorageCompactionDebt,
  recoverStorageCompactionDebtIntents,
  runStorageBackgroundTask,
  storageCompactionDebtRecoveryPending,
  storageCompactionDemandPending,
  subscribeStorageCompactionRequests,
} from './storage-compaction-state'
import { readStorageRetentionState, type StorageRetentionStateRow } from './storage-retention-state'
import type { WorkspaceEffect } from './workspace-effect-hub'
import { subscribeWorkspaceEffects, WORKSPACE_EFFECT_RECOVERY_OWNED } from './workspace-effect-hub'
import type {
  StorageMaintenanceTaskKind,
  WorkspaceCommand,
  WorkspaceCommandResult,
} from './workspace-protocol'
import { getWorkspaceRepository, publishLocalWorkspaceInvalidation } from './workspace-repository'
import {
  isWorkspaceMaintenancePreemptedError,
  isWorkspaceRuntimeClosedError,
  subscribeWorkspaceRuntimeIdle,
  tryRunWorkspaceActionIfIdle,
} from './workspace-runtime'

const ORPHAN_ATTACHMENT_AGE_MS = 24 * 60 * 60 * 1_000
const EMPTY_DRAFT_CHAT_AGE_MS = 24 * 60 * 60 * 1_000
const TERMINAL_STREAM_JOURNAL_AGE_MS = 24 * 60 * 60 * 1_000
const MAINTENANCE_BATCH_SIZE = 32
const RETRY_BASE_DELAY_MS = 1_000
const RETRY_MAX_DELAY_MS = 60_000
const MAX_TIMER_DELAY_MS = 2_147_483_647
const COMPACTION_INTENT_RECHECK_MS = 60_000

interface StorageMaintenanceTask {
  readonly kind: StorageMaintenanceTaskKind
  requestedRevision: number
  completedRevision: number
  failureCount: number
  retryAt: number | undefined
  nextDueAt: number | undefined
  runningRevision: number | undefined
}

type StorageMaintenanceSliceOutcome =
  | { readonly kind: 'done'; readonly nextDueAt?: number }
  | { readonly kind: 'continue' }
  | { readonly kind: 'blocked'; readonly on: 'runtime-idle' | 'slot'; readonly retryAt?: number }
  | { readonly kind: 'handoff' }

export interface StorageMaintenanceReplacementHandoffPort {
  transfer<T>(handoff: BrowserWorkspaceReplacementHandoff<T>): void
}

const TASK_PRIORITY = Object.freeze([
  Object.freeze(['recover-compaction-intents', 'clean-replacement-database'] as const),
  Object.freeze(['reconcile-attachment-integrity', 'reconcile-stream-integrity'] as const),
  Object.freeze([
    'reclaim-inactive-databases',
    'reap-attachments',
    'prune-terminal-streams',
    'prune-empty-drafts',
    'prune-discovery-cache',
  ] as const),
  Object.freeze(['compact-workspace'] as const),
])

class StorageMaintenanceController {
  readonly #fence: WorkspaceFence
  readonly #replacementHandoffs: StorageMaintenanceReplacementHandoffPort
  readonly #controller = new AbortController()
  #tasks: Map<StorageMaintenanceTaskKind, StorageMaintenanceTask> | null = null
  #priorityCursors: number[] | null = null
  #database: NatterDb | null = null
  #started = false
  #closed = false
  #ownsMaintenance = false
  #ownerGeneration = 0
  #ownerController: AbortController | null = null
  #startupTask: Promise<void> | null = null
  #pumpTask: Promise<void> | null = null
  #wakeTimer: ReturnType<typeof setTimeout> | null = null
  #wakeDueAt: number | null = null
  #waitingForRuntimeIdle = false
  #unsubscribeChanges: (() => void) | null = null
  #unsubscribeRuntimeIdle: (() => void) | null
  #unsubscribeCompactionRequests: (() => void) | null

  constructor(
    fence: WorkspaceFence,
    replacementHandoffs: StorageMaintenanceReplacementHandoffPort,
  ) {
    this.#fence = Object.freeze({ ...fence })
    this.#replacementHandoffs = replacementHandoffs
    this.#unsubscribeRuntimeIdle = subscribeWorkspaceRuntimeIdle(() => this.#receiveRuntimeIdle())
    this.#unsubscribeCompactionRequests = subscribeStorageCompactionRequests(() =>
      this.#publishCompactionWake(),
    )
  }

  start(): void {
    if (this.#closed || this.#started) return
    this.#started = true
    const task = this.#runOwnershipLifecycle()
    this.#startupTask = task
    void task.then(
      () => this.#clearStartupTask(task),
      (error: unknown) => {
        this.#clearStartupTask(task)
        if (!this.#closed && !isAbortError(error)) {
          console.error('Storage maintenance ownership failed', error)
        }
      },
    )
  }

  close(reason: unknown): void {
    if (this.#closed) return
    this.#closed = true
    this.#controller.abort(reason)
    this.#ownerController?.abort(reason)
    this.#clearWakeTimer()
    this.#unsubscribeChanges?.()
    this.#unsubscribeChanges = null
    this.#unsubscribeRuntimeIdle?.()
    this.#unsubscribeRuntimeIdle = null
    this.#unsubscribeCompactionRequests?.()
    this.#unsubscribeCompactionRequests = null
  }

  async awaitIdle(): Promise<void> {
    await Promise.allSettled([
      this.#startupTask ?? Promise.resolve(),
      this.#pumpTask ?? Promise.resolve(),
    ])
  }

  assertClosed(): void {
    if (
      !this.#closed ||
      this.#unsubscribeChanges ||
      this.#unsubscribeRuntimeIdle ||
      this.#unsubscribeCompactionRequests ||
      this.#wakeTimer !== null ||
      this.#startupTask ||
      this.#pumpTask ||
      this.#ownerController ||
      this.#database ||
      this.#tasks ||
      this.#priorityCursors
    ) {
      throw new Error('StorageMaintenanceRuntimeNotClosed')
    }
  }

  async #runOwnershipLifecycle(): Promise<void> {
    try {
      let failures = 0
      while (!this.#controller.signal.aborted) {
        try {
          const database = await getBrowserWorkspaceSession().open()
          if (abortSignalIsAborted(this.#controller.signal)) return
          this.#database = database
          await this.#runMaintenanceOwnership(database)
          failures = 0
        } catch (error) {
          if (abortSignalIsAborted(this.#controller.signal) || isAbortError(error)) return
          failures += 1
          console.error('Storage maintenance owner acquisition failed', error)
          await waitForRetry(retryDelay(failures), this.#controller.signal)
        }
      }
    } finally {
      this.#database = null
    }
  }

  async #runMaintenanceOwnership(database: NatterDb): Promise<void> {
    await withCoordinationLock(
      `storage-maintenance-owner:v1:${this.#fence.workspaceId}`,
      async (lease) => {
        if (this.#controller.signal.aborted) return
        const generation = ++this.#ownerGeneration
        const linkedOwner = linkedAbortController(this.#controller.signal, lease.ownershipLost)
        const ownerController = linkedOwner.controller
        this.#ownerController = ownerController
        try {
          this.#tasks = createStorageMaintenanceTasks()
          this.#priorityCursors = TASK_PRIORITY.map(() => 0)
          this.#ownsMaintenance = true
          this.#unsubscribeChanges = subscribeWorkspaceEffects({
            owner: 'storage-maintenance-runtime',
            impactKinds: ['storage-maintenance'],
            replacements: false,
            apply: (effect) => this.#receiveEffect(effect),
            recover: (_error, effect) => {
              this.#recoverEffect(effect)
              return WORKSPACE_EFFECT_RECOVERY_OWNED
            },
          })
          await this.#requestStartupWork()
          this.#schedulePump()
          await waitForAbort(ownerController.signal)
        } finally {
          this.#ownsMaintenance = false
          this.#unsubscribeChanges?.()
          this.#unsubscribeChanges = null
          this.#clearWakeTimer()
          ownerController.abort(
            new DOMException('Storage maintenance ownership ended', 'AbortError'),
          )
          await this.#pumpTask
          this.#tasks = null
          this.#priorityCursors = null
          this.#waitingForRuntimeIdle = false
          linkedOwner.dispose()
          if (this.#ownerGeneration === generation) this.#ownerController = null
        }
      },
      { database, signal: this.#controller.signal },
    )
  }

  async #requestStartupWork(): Promise<void> {
    const database = this.#requiredDatabase()
    const [
      integrity,
      attachmentReap,
      terminalStreams,
      emptyDrafts,
      firstAttachment,
      firstTemporaryChat,
      firstStreamLease,
      firstStreamChunk,
    ] = await database.transaction(
      'r',
      [
        database.attachmentIntegrityState,
        database.attachments,
        database.chats,
        database.storageRetentionState,
        database.streamChunks,
        database.streamLeases,
      ],
      () =>
        Dexie.Promise.all([
          database.attachmentIntegrityState.get('workspace'),
          readStorageRetentionState(database, 'attachment-reap'),
          readStorageRetentionState(database, 'terminal-stream-prune'),
          readStorageRetentionState(database, 'empty-draft-prune'),
          database.attachments.where('id').above('').firstKey(),
          database.chats
            .where('[temporaryKey+temporaryRetentionAt+id]')
            .between([1], [1, []], true, false)
            .firstKey(),
          database.streamLeases.where('streamId').above('').firstKey(),
          database.streamChunks.where('id').above('').firstKey(),
        ]),
    )
    for (const kind of [
      'recover-compaction-intents',
      'clean-replacement-database',
      'reconcile-stream-integrity',
      'reclaim-inactive-databases',
      'prune-discovery-cache',
      'compact-workspace',
    ] as const) {
      this.#requestTask(this.#task(kind))
    }
    if (integrity?.phase !== 'complete') {
      this.#requestTask(this.#task('reconcile-attachment-integrity'))
    }
    const now = Date.now()
    this.#resumeRetentionTask(
      'reap-attachments',
      attachmentReap,
      ORPHAN_ATTACHMENT_AGE_MS,
      now,
      firstAttachment !== undefined,
    )
    this.#resumeRetentionTask(
      'prune-terminal-streams',
      terminalStreams,
      TERMINAL_STREAM_JOURNAL_AGE_MS,
      now,
      firstStreamLease !== undefined || firstStreamChunk !== undefined,
    )
    this.#resumeRetentionTask(
      'prune-empty-drafts',
      emptyDrafts,
      EMPTY_DRAFT_CHAT_AGE_MS,
      now,
      firstTemporaryChat !== undefined,
    )
  }

  #requestAllTasks(): void {
    for (const task of this.#requiredTasks().values()) this.#requestTask(task)
  }

  #resumeRetentionTask(
    kind: Extract<
      StorageMaintenanceTaskKind,
      'reap-attachments' | 'prune-terminal-streams' | 'prune-empty-drafts'
    >,
    state: StorageRetentionStateRow,
    ageMs: number,
    now: number,
    hasPotentialRows: boolean,
  ): void {
    const task = this.#task(kind)
    if (state.phase === 'active' || (state.revision === 0 && hasPotentialRows)) {
      this.#requestTask(task)
      return
    }
    if (state.earliestDeferredAt === undefined) return
    const dueAt = state.earliestDeferredAt + ageMs + 1
    if (dueAt <= now) this.#requestTask(task)
    else task.nextDueAt = dueAt
  }

  #receiveEffect(effect: WorkspaceEffect): void {
    if (this.#closed || !sameWorkspace(effect, this.#fence) || effect.kind === 'replace') return
    if (effect.impactByKind === 'all') {
      this.#requestAllTasks()
    } else {
      for (const dependency of effect.impactByKind['storage-maintenance'] ?? []) {
        for (const kind of dependency.tasks) this.#requestTask(this.#task(kind))
      }
    }
    this.#schedulePump()
  }

  #recoverEffect(effect: WorkspaceEffect): void {
    if (this.#closed || !sameWorkspace(effect, this.#fence)) return
    this.#requestAllTasks()
    this.#schedulePump()
  }

  #receiveRuntimeIdle(): void {
    flushStorageCompactionDebt()
    if (!this.#waitingForRuntimeIdle) return
    this.#waitingForRuntimeIdle = false
    this.#schedulePump()
  }

  #publishCompactionWake(): void {
    if (this.#closed) return
    publishLocalWorkspaceInvalidation({
      kind: 'invalidate',
      workspaceId: this.#fence.workspaceId,
      replacementEpoch: this.#fence.replacementEpoch,
      dependencies: [{ kind: 'storage-maintenance', tasks: ['compact-workspace'] }],
    })
  }

  #requestTask(task: StorageMaintenanceTask): void {
    const nextRevision = saturatingIncrement(task.runningRevision ?? task.completedRevision)
    task.requestedRevision = Math.max(task.requestedRevision, nextRevision)
    task.nextDueAt = undefined
  }

  #schedulePump(): void {
    if (this.#closed || !this.#ownsMaintenance || this.#pumpTask || this.#waitingForRuntimeIdle) {
      return
    }
    this.#activateDueTasks(Date.now())
    if (!this.#hasRunnableTask(Date.now())) {
      this.#scheduleNextWake()
      return
    }
    this.#clearWakeTimer()
    const generation = this.#ownerGeneration
    const finalized = runStorageMaintenancePump(() => this.#runPump(generation)).finally(() => {
      if (this.#pumpTask === finalized) this.#pumpTask = null
      if (this.#ownerIsCurrent(generation)) this.#schedulePump()
    })
    this.#pumpTask = finalized
    void finalized.catch(() => undefined)
  }

  async #runPump(generation: number): Promise<void> {
    while (this.#ownerIsCurrent(generation)) {
      const now = Date.now()
      this.#activateDueTasks(now)
      const task = this.#selectRunnableTask(now)
      if (!task) return
      const revision = task.requestedRevision
      task.runningRevision = revision
      let outcome: StorageMaintenanceSliceOutcome
      try {
        outcome = await this.#runSlice(task)
      } catch (error) {
        task.runningRevision = undefined
        if (
          !this.#ownerIsCurrent(generation) ||
          isAbortError(error) ||
          isWorkspaceMaintenancePreemptedError(error)
        ) {
          return
        }
        this.#recordFailure(task, error)
        await yieldToEventLoop(this.#ownerSignal())
        continue
      }
      task.runningRevision = undefined
      if (!this.#ownerIsCurrent(generation)) return
      this.#applyOutcome(task, revision, outcome)
      if (outcome.kind === 'handoff') return
      if (outcome.kind === 'blocked' && outcome.on === 'runtime-idle') {
        this.#waitingForRuntimeIdle = true
        return
      }
      await yieldToEventLoop(this.#ownerSignal())
    }
  }

  async #runSlice(task: StorageMaintenanceTask): Promise<StorageMaintenanceSliceOutcome> {
    switch (task.kind) {
      case 'recover-compaction-intents':
        return this.#runIdleSlice(async () => {
          const database = this.#requiredDatabase()
          await recoverStorageCompactionDebtIntents(database, { signal: this.#ownerSignal() })
          return storageCompactionDebtRecoveryPending()
            ? { kind: 'done', nextDueAt: Date.now() + COMPACTION_INTENT_RECHECK_MS }
            : { kind: 'done' }
        })
      case 'clean-replacement-database': {
        const result = await cleanPendingBrowserWorkspaceDatabase(this.#ownerSignal())
        if (result.status === 'changed' || result.status === 'cleaned') return { kind: 'continue' }
        if (result.status === 'preparing') {
          await withBrowserWorkspaceSelectionGate(() => Promise.resolve(), this.#ownerSignal())
          return { kind: 'continue' }
        }
        return { kind: 'done' }
      }
      case 'reconcile-attachment-integrity':
        return this.#runRepositorySlice({
          kind: 'maintenance.reconcile-attachment-integrity',
          limit: MAINTENANCE_BATCH_SIZE,
          now: Date.now(),
        }).then((result) => {
          if (result.kind === 'handoff') return result
          return result.kind === 'result' && !result.value.done ? CONTINUE : done(result)
        })
      case 'reconcile-stream-integrity':
        return this.#runRepositorySlice({
          kind: 'maintenance.reconcile-stream-journal-integrity',
          limit: MAINTENANCE_BATCH_SIZE,
        }).then((result) => {
          if (result.kind === 'handoff') return result
          return result.kind === 'result' && !result.value.done ? CONTINUE : done(result)
        })
      case 'reclaim-inactive-databases':
        return this.#runIdleSlice(async () => {
          const result = await reclaimInactiveBrowserWorkspaceDatabases()
          if (result.status !== 'swept' || result.skipped.length > 0 || result.failed.length > 0) {
            return { kind: 'blocked', on: 'slot', retryAt: Date.now() + RETRY_BASE_DELAY_MS }
          }
          return { kind: 'done' }
        })
      case 'reap-attachments':
        return this.#runAttachmentRetentionSlice()
      case 'prune-terminal-streams':
        return this.#runTerminalRetentionSlice()
      case 'prune-empty-drafts':
        return this.#runDraftRetentionSlice()
      case 'prune-discovery-cache':
        return this.#runRepositorySlice({
          kind: 'maintenance.prune-discovery-cache',
          limit: MAINTENANCE_BATCH_SIZE,
        }).then((result) => {
          if (result.kind === 'handoff') return result
          return result.kind === 'result' && !result.value.done ? CONTINUE : done(result)
        })
      case 'compact-workspace':
        return this.#runCompactionSlice()
    }
  }

  async #runAttachmentRetentionSlice(): Promise<StorageMaintenanceSliceOutcome> {
    const result = await this.#runRepositorySlice({
      kind: 'attachment.reap',
      now: Date.now(),
      maxAgeMs: ORPHAN_ATTACHMENT_AGE_MS,
      limit: MAINTENANCE_BATCH_SIZE,
    })
    if (result.kind === 'blocked' || result.kind === 'handoff') return result
    if (!result.value.done) return CONTINUE
    return {
      kind: 'done',
      ...deadline(result.value.earliestDeferredAt, ORPHAN_ATTACHMENT_AGE_MS),
    }
  }

  async #runTerminalRetentionSlice(): Promise<StorageMaintenanceSliceOutcome> {
    const result = await this.#runRepositorySlice({
      kind: 'maintenance.prune-terminal-stream-journals',
      now: Date.now(),
      maxAgeMs: TERMINAL_STREAM_JOURNAL_AGE_MS,
      limit: MAINTENANCE_BATCH_SIZE,
    })
    if (result.kind === 'blocked' || result.kind === 'handoff') return result
    if (!result.value.done) return CONTINUE
    return {
      kind: 'done',
      ...deadline(result.value.earliestDeferredAt, TERMINAL_STREAM_JOURNAL_AGE_MS),
    }
  }

  async #runDraftRetentionSlice(): Promise<StorageMaintenanceSliceOutcome> {
    const result = await this.#runRepositorySlice({
      kind: 'maintenance.prune-empty-draft-chats',
      now: Date.now(),
      maxAgeMs: EMPTY_DRAFT_CHAT_AGE_MS,
      limit: MAINTENANCE_BATCH_SIZE,
    })
    if (result.kind === 'blocked' || result.kind === 'handoff') return result
    if (!result.value.done) return CONTINUE
    return {
      kind: 'done',
      ...deadline(result.value.earliestDeferredAt, EMPTY_DRAFT_CHAT_AGE_MS),
    }
  }

  async #runCompactionSlice(): Promise<StorageMaintenanceSliceOutcome> {
    await awaitStorageCompactionDebtIdle()
    if (!(await storageCompactionDemandPending(this.#requiredDatabase()))) return { kind: 'done' }
    throwIfPageHiding()
    const compaction = await import('./browser-workspace-compaction')
    throwIfPageHiding()
    if (!compaction.browserWorkspaceCompactionSupported()) return { kind: 'done' }
    let started: BrowserWorkspaceReplacementStart<BrowserWorkspaceCompactionResult>
    try {
      started = await compaction.tryStartBrowserWorkspaceCompaction({
        signal: this.#ownerSignal(),
      })
    } catch (error) {
      this.#requestTask(this.#task('clean-replacement-database'))
      throw error
    }
    if (started.kind === 'cleanup-required') {
      this.#requestTask(this.#task('clean-replacement-database'))
      return { kind: 'blocked', on: 'slot' }
    }
    if (started.kind === 'blocked') return { kind: 'blocked', on: 'runtime-idle' }
    if (started.kind === 'skipped') return { kind: 'done' }
    this.#replacementHandoffs.transfer(started.handoff)
    return { kind: 'handoff' }
  }

  async #runIdleSlice(
    operation: () => Promise<StorageMaintenanceSliceOutcome>,
  ): Promise<StorageMaintenanceSliceOutcome> {
    const started = tryRunWorkspaceActionIfIdle('maintenance', operation, {
      signal: this.#ownerSignal(),
    })
    return started ?? { kind: 'blocked', on: 'runtime-idle' }
  }

  async #runRepositorySlice<Command extends WorkspaceCommand>(
    command: Command,
  ): Promise<
    | { readonly kind: 'blocked'; readonly on: 'runtime-idle' }
    | { readonly kind: 'handoff' }
    | { readonly kind: 'result'; readonly value: WorkspaceCommandResult<Command> }
  > {
    const started = tryRunWorkspaceActionIfIdle(
      'maintenance',
      async (permit) => ({
        kind: 'result' as const,
        value: (await getWorkspaceRepository().execute(permit, command)).value,
      }),
      { signal: this.#ownerSignal() },
    )
    if (!started) return { kind: 'blocked', on: 'runtime-idle' }
    return started
  }

  #applyOutcome(
    task: StorageMaintenanceTask,
    revision: number,
    outcome: StorageMaintenanceSliceOutcome,
  ): void {
    if (outcome.kind === 'continue') {
      task.failureCount = 0
      task.retryAt = undefined
      return
    }
    if (outcome.kind === 'blocked') {
      if (outcome.retryAt !== undefined) task.retryAt = outcome.retryAt
      return
    }
    task.completedRevision = Math.max(task.completedRevision, revision)
    task.failureCount = 0
    task.retryAt = undefined
    task.nextDueAt = outcome.kind === 'done' ? outcome.nextDueAt : undefined
  }

  #recordFailure(task: StorageMaintenanceTask, error: unknown): void {
    task.failureCount = saturatingIncrement(task.failureCount)
    task.retryAt = Date.now() + retryDelay(task.failureCount)
    if (
      !isWorkspaceRuntimeClosedError(error) &&
      !isWorkspaceReplacementRecoveryRequiredError(error)
    ) {
      console.error(`Storage maintenance task failed: ${task.kind}`, error)
    }
  }

  #activateDueTasks(now: number): void {
    for (const task of this.#requiredTasks().values()) {
      if (task.nextDueAt === undefined || task.nextDueAt > now) continue
      task.nextDueAt = undefined
      this.#requestTask(task)
    }
  }

  #hasRunnableTask(now: number): boolean {
    return [...this.#requiredTasks().values()].some(
      (task) => task.requestedRevision > task.completedRevision && (task.retryAt ?? 0) <= now,
    )
  }

  #selectRunnableTask(now: number): StorageMaintenanceTask | undefined {
    const priorityCursors = this.#requiredPriorityCursors()
    for (let priority = 0; priority < TASK_PRIORITY.length; priority += 1) {
      const kinds = TASK_PRIORITY[priority]
      if (!kinds) continue
      const start = priorityCursors[priority] ?? 0
      for (let offset = 0; offset < kinds.length; offset += 1) {
        const index = (start + offset) % kinds.length
        const kind = kinds[index]
        if (!kind) continue
        const task = this.#task(kind)
        if (task.requestedRevision <= task.completedRevision || (task.retryAt ?? 0) > now) continue
        priorityCursors[priority] = (index + 1) % kinds.length
        return task
      }
    }
    return undefined
  }

  #scheduleNextWake(): void {
    const dueAt = [...this.#requiredTasks().values()].reduce<number | undefined>(
      (earliest, task) => {
        const candidates = [task.retryAt, task.nextDueAt].filter(
          (value): value is number => value !== undefined,
        )
        for (const candidate of candidates) {
          if (earliest === undefined || candidate < earliest) earliest = candidate
        }
        return earliest
      },
      undefined,
    )
    if (dueAt === undefined) return
    if (this.#wakeTimer !== null && this.#wakeDueAt !== null && this.#wakeDueAt <= dueAt) return
    this.#clearWakeTimer()
    this.#wakeDueAt = dueAt
    this.#wakeTimer = setTimeout(
      () => {
        this.#wakeTimer = null
        this.#wakeDueAt = null
        this.#schedulePump()
      },
      Math.max(0, Math.min(MAX_TIMER_DELAY_MS, dueAt - Date.now())),
    )
  }

  #clearWakeTimer(): void {
    if (this.#wakeTimer !== null) clearTimeout(this.#wakeTimer)
    this.#wakeTimer = null
    this.#wakeDueAt = null
  }

  #task(kind: StorageMaintenanceTaskKind): StorageMaintenanceTask {
    const task = this.#requiredTasks().get(kind)
    if (!task) throw new Error(`StorageMaintenanceTaskMissing:${kind}`)
    return task
  }

  #requiredTasks(): Map<StorageMaintenanceTaskKind, StorageMaintenanceTask> {
    if (!this.#tasks) throw new Error('StorageMaintenanceOwnerTasksMissing')
    return this.#tasks
  }

  #requiredPriorityCursors(): number[] {
    if (!this.#priorityCursors) throw new Error('StorageMaintenanceOwnerPriorityMissing')
    return this.#priorityCursors
  }

  #requiredDatabase(): NatterDb {
    if (!this.#database) throw new Error('StorageMaintenanceDatabaseMissing')
    return this.#database
  }

  #ownerSignal(): AbortSignal {
    const signal = this.#ownerController?.signal
    if (!signal || signal.aborted)
      throw signal?.reason ?? new Error('StorageMaintenanceOwnerMissing')
    return signal
  }

  #ownerIsCurrent(generation: number): boolean {
    return (
      !this.#closed &&
      this.#ownsMaintenance &&
      generation === this.#ownerGeneration &&
      this.#ownerController?.signal.aborted === false
    )
  }

  #clearStartupTask(task: Promise<void>): void {
    if (this.#startupTask === task) this.#startupTask = null
  }
}

const CONTINUE = Object.freeze({ kind: 'continue' } as const)

type StorageMaintenanceRuntimeState =
  | { readonly kind: 'closed' }
  | { readonly kind: 'attached'; readonly controller: StorageMaintenanceController }
  | {
      readonly kind: 'retiring'
      readonly controller: StorageMaintenanceController
      readonly drain: Promise<void>
    }
  | { readonly kind: 'failed'; readonly error: unknown }

const STORAGE_MAINTENANCE_CLOSED = Object.freeze({ kind: 'closed' } as const)
let storageMaintenanceRuntimeState: StorageMaintenanceRuntimeState = STORAGE_MAINTENANCE_CLOSED

export function attachStorageMaintenanceRuntime(
  fence: WorkspaceFence,
  replacementHandoffs: StorageMaintenanceReplacementHandoffPort,
): void {
  if (storageMaintenanceRuntimeState.kind !== 'closed') {
    throw new Error(
      `StorageMaintenanceRuntimeAlreadyAttached:${storageMaintenanceRuntimeState.kind}`,
    )
  }
  storageMaintenanceRuntimeState = Object.freeze({
    kind: 'attached',
    controller: new StorageMaintenanceController(fence, replacementHandoffs),
  })
}

export function startStorageMaintenanceRuntime(): void {
  if (storageMaintenanceRuntimeState.kind !== 'attached') {
    throw new Error(`StorageMaintenanceRuntimeNotAttached:${storageMaintenanceRuntimeState.kind}`)
  }
  storageMaintenanceRuntimeState.controller.start()
}

export function closeStorageMaintenanceRuntime(): void {
  retireStorageMaintenanceRuntime(new DOMException('Storage maintenance closed', 'AbortError'))
}

export function abortStorageMaintenanceRuntime(): void {
  retireStorageMaintenanceRuntime(new DOMException('Workspace replaced', 'AbortError'))
}

export async function awaitStorageMaintenanceRuntimeIdle(): Promise<void> {
  const state = storageMaintenanceRuntimeState
  if (state.kind === 'closed') return
  if (state.kind === 'attached') throw new Error('StorageMaintenanceRuntimeStillAttached')
  if (state.kind === 'failed') throw state.error
  try {
    await state.drain
  } catch (error) {
    if (storageMaintenanceRuntimeState === state) {
      storageMaintenanceRuntimeState = Object.freeze({ kind: 'failed', error })
    }
    throw error
  }
  if (storageMaintenanceRuntimeState === state) {
    storageMaintenanceRuntimeState = STORAGE_MAINTENANCE_CLOSED
  }
}

export function assertStorageMaintenanceRuntimeClosed(): void {
  if (storageMaintenanceRuntimeState.kind !== 'closed') {
    throw new Error(`StorageMaintenanceRuntimeNotClosed:${storageMaintenanceRuntimeState.kind}`)
  }
}

function retireStorageMaintenanceRuntime(reason: unknown): void {
  const state = storageMaintenanceRuntimeState
  if (state.kind === 'closed' || state.kind === 'retiring' || state.kind === 'failed') return
  const controller = state.controller
  controller.close(reason)
  const drain = controller.awaitIdle().then(() => controller.assertClosed())
  storageMaintenanceRuntimeState = Object.freeze({ kind: 'retiring', controller, drain })
  void drain.catch(() => {})
}

function createStorageMaintenanceTasks(): Map<StorageMaintenanceTaskKind, StorageMaintenanceTask> {
  const kinds: readonly StorageMaintenanceTaskKind[] = [
    'recover-compaction-intents',
    'clean-replacement-database',
    'reconcile-attachment-integrity',
    'reconcile-stream-integrity',
    'reclaim-inactive-databases',
    'reap-attachments',
    'prune-terminal-streams',
    'prune-empty-drafts',
    'prune-discovery-cache',
    'compact-workspace',
  ]
  return new Map(
    kinds.map((kind) => [
      kind,
      {
        kind,
        requestedRevision: 0,
        completedRevision: 0,
        failureCount: 0,
        retryAt: undefined,
        nextDueAt: undefined,
        runningRevision: undefined,
      },
    ]),
  )
}

function done(
  result:
    | { readonly kind: 'blocked'; readonly on: 'runtime-idle' }
    | { readonly kind: 'result'; readonly value: unknown },
): StorageMaintenanceSliceOutcome {
  return result.kind === 'blocked' ? result : { kind: 'done' }
}

function deadline(observedAt: number | undefined, ageMs: number): { readonly nextDueAt?: number } {
  return observedAt === undefined ? {} : { nextDueAt: observedAt + ageMs + 1 }
}

function sameWorkspace(change: WorkspaceFence, fence: WorkspaceFence): boolean {
  return (
    change.workspaceId === fence.workspaceId && change.replacementEpoch === fence.replacementEpoch
  )
}

function linkedAbortController(...signals: readonly (AbortSignal | undefined)[]): {
  readonly controller: AbortController
  dispose(): void
} {
  const controller = new AbortController()
  const listeners = new Map<AbortSignal, () => void>()
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    for (const [source, listener] of listeners) {
      source.removeEventListener('abort', listener)
    }
    listeners.clear()
  }
  const abortFrom = (source: AbortSignal) => {
    if (!controller.signal.aborted) controller.abort(source.reason)
    dispose()
  }
  for (const source of signals.filter(
    (candidate): candidate is AbortSignal => candidate !== undefined,
  )) {
    if (listeners.has(source)) continue
    if (source.aborted) {
      abortFrom(source)
      break
    }
    const listener = () => abortFrom(source)
    listeners.set(source, listener)
    source.addEventListener('abort', listener, { once: true })
  }
  return { controller, dispose }
}

function abortSignalIsAborted(signal: AbortSignal): boolean {
  return signal.aborted
}

export const __linkedStorageMaintenanceAbortControllerForTests = linkedAbortController
export const __runStorageMaintenancePumpForTests = runStorageMaintenancePump

function runStorageMaintenancePump<T>(operation: () => Promise<T>): Promise<T> {
  return runStorageBackgroundTask(operation)
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
}

function waitForRetry(delay: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(finish, delay)
    function finish(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    signal.addEventListener('abort', finish, { once: true })
  })
}

function retryDelay(failureCount: number): number {
  const exponent = Math.min(Math.max(0, failureCount - 1), 30)
  return Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** exponent)
}

function saturatingIncrement(value: number): number {
  return value >= Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : value + 1
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function throwIfPageHiding(): void {
  if (isPageHiding()) throw new DOMException('Page lifecycle ended', 'AbortError')
}
