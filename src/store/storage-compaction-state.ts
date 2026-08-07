import Dexie, { type Transaction } from 'dexie'
import { browserLocalStorage } from '../lib/browser-storage'
import { newId } from '../lib/ulid'
import type { BrowserLockRow } from './browser-lock-record'
import {
  BROWSER_WORKSPACE_COMPACTION_MIN_RECLAIMABLE_BYTES,
  browserWorkspaceCompactionDebtThreshold,
  readBrowserWorkspaceCompactionState,
  recordBrowserWorkspaceCompactionDebt,
} from './browser-workspace-database-control'
import { coordinationLockName, withCoordinationLock } from './locks'

export const STORAGE_COMPACTION_MIN_RECLAIMABLE_BYTES =
  BROWSER_WORKSPACE_COMPACTION_MIN_RECLAIMABLE_BYTES

interface PhysicalMutationLedger {
  readonly databaseName: string
  obsoleteBytes: number
}

let physicalMutationLedgers = new WeakMap<Transaction, PhysicalMutationLedger>()
let physicalMutationTransactionDatabaseNames = new WeakMap<object, string>()
const physicalMutationDebtQueues = new Map<string, PhysicalMutationDebtQueue>()
const storageCompactionRequestListeners = new Set<() => void>()
const STORAGE_COMPACTION_RECOVERY_INTENT_PREFIX = 'natter:storage-compaction-intent:v1:'
const STORAGE_COMPACTION_RECOVERY_COORDINATION_RESOURCE = 'storage-compaction-recovery:v1'
const STORAGE_COMPACTION_INTENT_OWNER_RESOURCE_PREFIX = 'storage-compaction-intent-owner:v1:'
const STORAGE_COMPACTION_WRITE_ADMISSION = Symbol('StorageCompactionWriteAdmission')
const STORAGE_COMPACTION_RECOVERY_INTENT_FORMAT_VERSION = 2
const STORAGE_COMPACTION_DEBT_RETRY_BASE_MS = 1_000
const STORAGE_COMPACTION_DEBT_RETRY_MAX_MS = 60_000
const STORAGE_COMPACTION_DEBT_FLUSH_BYTES = 1024 * 1024
const physicalMutationTabId = createPhysicalMutationTabId()
const physicalMutationMarkerKey = storageCompactionRecoveryIntentKey(physicalMutationTabId)
const physicalMutationMarkerNonce = createPhysicalMutationTabId()
const physicalMutationRecoveryDebtByDatabase = new Map<string, number>()
let physicalMutationMarkerValue: string | null = null
let physicalMutationIntentOutstanding = false
let activePhysicalMutationLedgers = 0
let pendingCompletedPhysicalMutationLedgers = 0
let physicalMutationDebtWork = 0
let physicalMutationDebtIdle: Promise<void> = Promise.resolve()
let resolvePhysicalMutationDebtIdle: (() => void) | null = null
let physicalMutationDebtDrainRequested = false
let physicalMutationDebtClosing = false
let physicalMutationDebtFailure: unknown = null
let physicalMutationDebtRecoveryHandoff = false
let physicalMutationIntentOwnerStart: {
  readonly controller: AbortController
  readonly task: Promise<void>
} | null = null
let physicalMutationIntentOwnerController: AbortController | null = null
let physicalMutationIntentOwnerTask: Promise<void> = Promise.resolve()
let physicalMutationIntentOwnerFailure: unknown = null
let storageCompactionWriteAdmission:
  | {
      readonly databaseName: string
      readonly task: Promise<StorageCompactionWriteAdmission>
    }
  | undefined

type CompletedPhysicalMutationLedger = PhysicalMutationLedger

interface PhysicalMutationDebtQueue {
  readonly databaseName: string
  obsoleteBytes: number
  completedLedgers: number
  settledLedgers: number
  phase: 'scheduled' | 'writing' | 'retry-wait'
  failureCount: number
  task: Promise<void> | null
  timer: ReturnType<typeof setTimeout> | null
}

interface StorageCompactionRecoveryIntent {
  readonly key: string
  readonly value: string
  readonly tabId: string
  readonly exactDebtByDatabase: ReadonlyMap<string, number> | null
}

interface StorageCompactionRecoveryOptions {
  readonly isOwnerLive?: (tabId: string) => Promise<boolean>
  readonly signal?: AbortSignal
}

export interface StorageCompactionWriteAdmission {
  readonly kind: 'storage-compaction-write-admission'
  readonly databaseName: string
  readonly commandPhysicalReads: 0
  readonly [STORAGE_COMPACTION_WRITE_ADMISSION]: true
}

export function storageCompactionRecoveryIntentKey(tabId: string): string {
  if (tabId.length === 0) throw new Error('StorageCompactionRecoveryIntentTabIdInvalid')
  return `${STORAGE_COMPACTION_RECOVERY_INTENT_PREFIX}${tabId}`
}

export function readStorageCompactionState(source: { readonly name: string }) {
  return readBrowserWorkspaceCompactionState(source.name)
}

export function accumulateStorageCompactionDebt(tx: Transaction, obsoleteBytes: number): void {
  if (!Number.isSafeInteger(obsoleteBytes) || obsoleteBytes < 0) {
    throw new Error('StorageCompactionDebtInvalid')
  }
  if (obsoleteBytes === 0) return
  const ledger = physicalMutationLedgers.get(tx) ?? createPhysicalMutationLedger(tx)
  ledger.obsoleteBytes = saturatingAdd(ledger.obsoleteBytes, obsoleteBytes)
}

export function subscribeStorageCompactionRequests(listener: () => void): () => void {
  storageCompactionRequestListeners.add(listener)
  return () => storageCompactionRequestListeners.delete(listener)
}

export function storageCompactionDebtRecoveryPending(): boolean {
  return readStorageCompactionRecoveryIntents().length > 0
}

export function registerPhysicalMutationTransaction(tx: Transaction): void {
  physicalMutationTransactionDatabaseNames.set(tx.idbtrans, tx.db.name)
}

function completeStorageCompactionDebt(
  tx: Transaction,
): CompletedPhysicalMutationLedger | undefined {
  const ledger = physicalMutationLedgers.get(tx)
  if (!ledger) return undefined
  physicalMutationLedgers.delete(tx)
  activePhysicalMutationLedgers -= 1
  addPhysicalMutationRecoveryDebt(ledger.databaseName, ledger.obsoleteBytes)
  syncCurrentStorageCompactionRecoveryIntent()
  return ledger
}

export function discardStorageCompactionDebt(tx: Transaction): void {
  const ledger = physicalMutationLedgers.get(tx)
  if (!ledger) return
  physicalMutationLedgers.delete(tx)
  activePhysicalMutationLedgers -= 1
  endPhysicalMutationDebtWork()
  syncCurrentStorageCompactionRecoveryIntent()
}

function commitCompletedStorageCompactionDebt(
  databaseName: string,
  completed: CompletedPhysicalMutationLedger | undefined,
): Promise<void> {
  if (!completed) return Promise.resolve()
  const queue = physicalMutationDebtQueues.get(databaseName) ?? {
    databaseName,
    obsoleteBytes: 0,
    completedLedgers: 0,
    settledLedgers: 0,
    phase: 'scheduled' as const,
    failureCount: 0,
    task: null,
    timer: null,
  }
  queue.obsoleteBytes = saturatingAdd(queue.obsoleteBytes, completed.obsoleteBytes)
  queue.completedLedgers += 1
  pendingCompletedPhysicalMutationLedgers += 1
  if (!physicalMutationDebtQueues.has(databaseName)) {
    physicalMutationDebtQueues.set(databaseName, queue)
  }
  if (
    physicalMutationDebtClosing ||
    physicalMutationDebtDrainRequested ||
    !physicalMutationIntentOutstanding ||
    queue.obsoleteBytes >= STORAGE_COMPACTION_DEBT_FLUSH_BYTES
  ) {
    schedulePhysicalMutationDebtQueue(queue, 0)
  }
  return physicalMutationDebtIdle
}

export async function recoverStorageCompactionDebtIntents(
  db: Dexie,
  options: StorageCompactionRecoveryOptions = {},
): Promise<boolean> {
  if (options.signal?.aborted) throw storageCompactionError(options.signal.reason)
  if (readStorageCompactionRecoveryIntents().length === 0) return false
  return withCoordinationLock(
    STORAGE_COMPACTION_RECOVERY_COORDINATION_RESOURCE,
    async () => {
      if (options.signal?.aborted) throw storageCompactionError(options.signal.reason)
      const intents = readStorageCompactionRecoveryIntents()
      const stale: StorageCompactionRecoveryIntent[] = []
      for (const intent of intents) {
        if (options.signal?.aborted) throw storageCompactionError(options.signal.reason)
        const live = options.isOwnerLive
          ? await options.isOwnerLive(intent.tabId)
          : await storageCompactionIntentOwnerIsLive(db, intent.tabId)
        if (options.signal?.aborted) throw storageCompactionError(options.signal.reason)
        if (!live) stale.push(intent)
      }
      if (stale.length === 0) return false
      let obsoleteBytes = stale.reduce(
        (total, intent) =>
          intent.exactDebtByDatabase
            ? saturatingAdd(total, intent.exactDebtByDatabase.get(db.name) ?? 0)
            : total,
        0,
      )
      if (stale.some((intent) => intent.exactDebtByDatabase === null)) {
        const state = await readBrowserWorkspaceCompactionState(db.name)
        obsoleteBytes = Math.max(
          obsoleteBytes,
          storageCompactionDebtThreshold(state.lastCompactedLiveBytes),
        )
      }
      const requested =
        obsoleteBytes === 0
          ? false
          : (await recordBrowserWorkspaceCompactionDebt(db.name, obsoleteBytes)).requested
      clearStorageCompactionRecoveryIntents(stale)
      if (requested) publishStorageCompactionRequest()
      return true
    },
    { database: db, ...(options.signal ? { signal: options.signal } : {}) },
  )
}

export async function awaitStorageCompactionDebtIdle(): Promise<void> {
  flushStorageCompactionDebt()
  await physicalMutationDebtIdle
  if (physicalMutationDebtFailure) throw storageCompactionError(physicalMutationDebtFailure)
}

export function flushStorageCompactionDebt(): void {
  if (physicalMutationDebtWork !== 0) physicalMutationDebtDrainRequested = true
  for (const queue of physicalMutationDebtQueues.values()) {
    if (queue.timer !== null) {
      clearTimeout(queue.timer)
      queue.timer = null
    }
    if (!queue.task) schedulePhysicalMutationDebtQueue(queue, 0)
  }
}

export function closeStorageCompactionDebtRuntime(): void {
  physicalMutationDebtClosing = true
  if (physicalMutationDebtWork !== 0) physicalMutationDebtDrainRequested = true
  for (const queue of physicalMutationDebtQueues.values()) {
    if (queue.timer !== null) {
      clearTimeout(queue.timer)
      queue.timer = null
    }
    if (!queue.task) schedulePhysicalMutationDebtQueue(queue, 0)
  }
}

export function resumeStorageCompactionDebtRuntime(): void {
  if (
    activePhysicalMutationLedgers !== 0 ||
    physicalMutationDebtWork !== 0 ||
    physicalMutationDebtQueues.size !== 0
  ) {
    throw new Error('StorageCompactionDebtRuntimeResumeWhileActive')
  }
  physicalMutationDebtClosing = false
  physicalMutationDebtFailure = null
  physicalMutationDebtRecoveryHandoff = false
}

export function finishStorageCompactionDebtRuntimeClosure(): void {
  if (
    activePhysicalMutationLedgers !== 0 ||
    physicalMutationDebtWork !== 0 ||
    resolvePhysicalMutationDebtIdle !== null ||
    [...physicalMutationDebtQueues.values()].some(
      (queue) => queue.task !== null || queue.timer !== null,
    )
  ) {
    throw new Error('StorageCompactionDebtRuntimeStillActive')
  }
  physicalMutationLedgers = new WeakMap<Transaction, PhysicalMutationLedger>()
  physicalMutationTransactionDatabaseNames = new WeakMap<object, string>()
  physicalMutationDebtQueues.clear()
  pendingCompletedPhysicalMutationLedgers = 0
  if (physicalMutationDebtRecoveryHandoff && !physicalMutationIntentOutstanding) {
    throw new Error('StorageCompactionDebtRecoveryHandoffMissing')
  }
  physicalMutationIntentOutstanding = false
  physicalMutationMarkerValue = null
  physicalMutationRecoveryDebtByDatabase.clear()
  physicalMutationDebtClosing = false
  physicalMutationDebtDrainRequested = false
  physicalMutationDebtFailure = null
  physicalMutationDebtRecoveryHandoff = false
  physicalMutationDebtIdle = Promise.resolve()
}

export function assertStorageCompactionDebtRuntimeClosed(): void {
  if (
    activePhysicalMutationLedgers !== 0 ||
    pendingCompletedPhysicalMutationLedgers !== 0 ||
    physicalMutationDebtWork !== 0 ||
    resolvePhysicalMutationDebtIdle !== null ||
    physicalMutationDebtQueues.size !== 0 ||
    physicalMutationDebtDrainRequested ||
    physicalMutationDebtClosing ||
    physicalMutationDebtFailure !== null ||
    physicalMutationDebtRecoveryHandoff ||
    physicalMutationIntentOutstanding ||
    physicalMutationMarkerValue !== null ||
    physicalMutationRecoveryDebtByDatabase.size !== 0 ||
    storageCompactionRequestListeners.size !== 0
  ) {
    throw new Error('StorageCompactionDebtRuntimeNotClosed')
  }
}

export function storageCompactionDebtThreshold(lastCompactedLiveBytes: number): number {
  return browserWorkspaceCompactionDebtThreshold(lastCompactedLiveBytes)
}

export function startStorageCompactionIntentOwner(db: Dexie): Promise<void> {
  if (physicalMutationIntentOwnerStart) return physicalMutationIntentOwnerStart.task
  if (physicalMutationIntentOwnerController) {
    if (!physicalMutationIntentOwnerController.signal.aborted) return Promise.resolve()
  }
  const controller = new AbortController()
  const task = startStorageCompactionIntentOwnerOnce(db, controller).finally(() => {
    if (physicalMutationIntentOwnerStart?.controller === controller) {
      physicalMutationIntentOwnerStart = null
    }
  })
  physicalMutationIntentOwnerStart = { controller, task }
  return task
}

export function activateStorageCompactionWriteAdmission(db: Dexie): void {
  if (storageCompactionWriteAdmission) {
    throw new Error('StorageCompactionWriteAdmissionAlreadyActive')
  }
  const admission = {
    databaseName: db.name,
    task: startStorageCompactionIntentOwner(db).then(() =>
      Object.freeze({
        kind: 'storage-compaction-write-admission' as const,
        databaseName: db.name,
        commandPhysicalReads: 0 as const,
        [STORAGE_COMPACTION_WRITE_ADMISSION]: true as const,
      }),
    ),
  }
  storageCompactionWriteAdmission = admission
  void admission.task.catch(() => undefined)
}

async function startStorageCompactionIntentOwnerOnce(
  db: Dexie,
  controller: AbortController,
): Promise<void> {
  if (physicalMutationIntentOwnerController?.signal.aborted) await physicalMutationIntentOwnerTask
  if (controller.signal.aborted) throw storageCompactionError(controller.signal.reason)
  await recoverStorageCompactionDebtIntents(db, { signal: controller.signal })
  if (storageCompactionOwnerAborted(controller)) {
    throw storageCompactionError(controller.signal.reason)
  }
  physicalMutationIntentOwnerController = controller
  physicalMutationIntentOwnerFailure = null
  let acquired = false
  let resolveAcquired!: () => void
  const acquiredPromise = new Promise<void>((resolve) => {
    resolveAcquired = resolve
  })
  const task = withCoordinationLock(
    storageCompactionIntentOwnerResourceName(physicalMutationTabId),
    async (lease) => {
      acquired = true
      resolveAcquired()
      await waitForStorageCompactionIntentOwnerStop(controller.signal, lease.ownershipLost)
    },
    { signal: controller.signal, database: db },
  )
    .catch((error: unknown) => {
      if (!controller.signal.aborted) physicalMutationIntentOwnerFailure = error
    })
    .finally(() => {
      if (!acquired) resolveAcquired()
      if (physicalMutationIntentOwnerController === controller) {
        physicalMutationIntentOwnerController = null
      }
    })
  physicalMutationIntentOwnerTask = task
  await acquiredPromise
  const startFailure = storageCompactionIntentOwnerFailure()
  if (startFailure) throw storageCompactionError(startFailure)
}

export async function awaitStorageCompactionWriteAdmission(): Promise<StorageCompactionWriteAdmission> {
  const admission = storageCompactionWriteAdmission
  if (!admission) throw new Error('StorageCompactionWriteAdmissionInactive')
  const receipt = await admission.task
  if (storageCompactionWriteAdmission !== admission) {
    throw new Error('StorageCompactionWriteAdmissionClosed')
  }
  const failure = storageCompactionIntentOwnerFailure()
  if (failure) throw storageCompactionError(failure)
  if (!physicalMutationIntentOwnerController) {
    throw new Error('StorageCompactionWriteAdmissionOwnershipLost')
  }
  return receipt
}

export function stagedStorageCompactionWriteAdmission(
  databaseName: string,
): StorageCompactionWriteAdmission {
  if (databaseName.length === 0) throw new Error('StorageCompactionWriteAdmissionDatabaseInvalid')
  return Object.freeze({
    kind: 'storage-compaction-write-admission',
    databaseName,
    commandPhysicalReads: 0,
    [STORAGE_COMPACTION_WRITE_ADMISSION]: true as const,
  })
}

export function stopStorageCompactionIntentOwner(): void {
  storageCompactionWriteAdmission = undefined
  physicalMutationIntentOwnerStart?.controller.abort(
    new Error('StorageCompactionIntentOwnerStopped'),
  )
  physicalMutationIntentOwnerController?.abort(new Error('StorageCompactionIntentOwnerStopped'))
}

export async function awaitStorageCompactionIntentOwnerIdle(): Promise<void> {
  await physicalMutationIntentOwnerStart?.task.catch(() => undefined)
  await physicalMutationIntentOwnerTask
  const idleFailure = storageCompactionIntentOwnerFailure()
  if (idleFailure) throw storageCompactionError(idleFailure)
}

export function assertStorageCompactionIntentOwnerClosed(): void {
  if (
    physicalMutationIntentOwnerStart ||
    physicalMutationIntentOwnerController ||
    physicalMutationIntentOwnerFailure ||
    storageCompactionWriteAdmission
  ) {
    throw new Error('StorageCompactionIntentOwnerNotClosed')
  }
}

export async function __resetStorageCompactionStateForTests(): Promise<void> {
  stopStorageCompactionIntentOwner()
  await physicalMutationIntentOwnerTask
  closeStorageCompactionDebtRuntime()
  await awaitStorageCompactionDebtIdle()
  clearStorageCompactionRecoveryIntents([
    ...(physicalMutationMarkerValue === null
      ? []
      : [{ key: physicalMutationMarkerKey, value: physicalMutationMarkerValue }]),
  ])
  physicalMutationLedgers = new WeakMap<Transaction, PhysicalMutationLedger>()
  physicalMutationTransactionDatabaseNames = new WeakMap<object, string>()
  physicalMutationDebtQueues.clear()
  physicalMutationIntentOutstanding = false
  physicalMutationMarkerValue = null
  physicalMutationRecoveryDebtByDatabase.clear()
  activePhysicalMutationLedgers = 0
  pendingCompletedPhysicalMutationLedgers = 0
  physicalMutationDebtWork = 0
  physicalMutationDebtIdle = Promise.resolve()
  resolvePhysicalMutationDebtIdle = null
  physicalMutationDebtDrainRequested = false
  physicalMutationDebtClosing = false
  physicalMutationDebtFailure = null
  physicalMutationDebtRecoveryHandoff = false
  physicalMutationIntentOwnerStart = null
  physicalMutationIntentOwnerController = null
  physicalMutationIntentOwnerTask = Promise.resolve()
  physicalMutationIntentOwnerFailure = null
  storageCompactionWriteAdmission = undefined
  storageCompactionRequestListeners.clear()
}

function createPhysicalMutationLedger(tx: Transaction): PhysicalMutationLedger {
  activePhysicalMutationLedgers += 1
  beginPhysicalMutationDebtWork()
  const databaseName = physicalMutationTransactionDatabaseNames.get(tx.idbtrans) ?? tx.db.name
  ensureCurrentStorageCompactionRecoveryIntent()
  let settled = false
  const ledger = {
    databaseName,
    obsoleteBytes: 0,
  }
  physicalMutationLedgers.set(tx, ledger)
  tx.on('complete', () => {
    if (settled) return
    settled = true
    void commitCompletedStorageCompactionDebt(databaseName, completeStorageCompactionDebt(tx))
  })
  tx.on('abort', () => {
    if (settled) return
    settled = true
    const current = physicalMutationLedgers.get(tx)
    if (!current) return
    physicalMutationLedgers.delete(tx)
    activePhysicalMutationLedgers -= 1
    endPhysicalMutationDebtWork()
    syncCurrentStorageCompactionRecoveryIntent()
  })
  return ledger
}

function schedulePhysicalMutationDebtQueue(
  queue: PhysicalMutationDebtQueue,
  delayMs: number,
): void {
  if (queue.task || queue.timer !== null) return
  if (delayMs > 0 && !physicalMutationDebtClosing) {
    queue.phase = 'retry-wait'
    queue.timer = setTimeout(() => {
      queue.timer = null
      schedulePhysicalMutationDebtQueue(queue, 0)
    }, delayMs)
    return
  }
  queue.phase = 'scheduled'
  let disposition: 'finish' | 'handoff' | number = 'finish'
  const task = Dexie.ignoreTransaction(() => drainPhysicalMutationDebtQueueBatch(queue))
    .then((succeeded) => {
      if (succeeded) {
        queue.failureCount = 0
        disposition = queue.obsoleteBytes > 0 ? 0 : 'finish'
        return
      }
      queue.failureCount = saturatingAdd(queue.failureCount, 1)
      if (physicalMutationDebtClosing) {
        disposition = 'handoff'
        return
      }
      disposition = storageCompactionDebtRetryDelay(queue.failureCount)
    })
    .finally(() => {
      if (queue.task !== task) return
      queue.task = null
      if (disposition === 'finish') finishPhysicalMutationDebtQueue(queue, false)
      else if (disposition === 'handoff') finishPhysicalMutationDebtQueue(queue, true)
      else {
        schedulePhysicalMutationDebtQueue(queue, disposition)
        releaseSettledPhysicalMutationDebtWork(queue)
      }
    })
  queue.task = task
}

async function drainPhysicalMutationDebtQueueBatch(
  queue: PhysicalMutationDebtQueue,
): Promise<boolean> {
  const obsoleteBytes = queue.obsoleteBytes
  if (obsoleteBytes === 0) return true
  const completedLedgers = queue.completedLedgers
  queue.obsoleteBytes = 0
  queue.completedLedgers = 0
  queue.phase = 'writing'
  try {
    const debt = await recordBrowserWorkspaceCompactionDebt(queue.databaseName, obsoleteBytes)
    if (debt.requested) publishStorageCompactionRequest()
    pendingCompletedPhysicalMutationLedgers -= completedLedgers
    subtractPhysicalMutationRecoveryDebt(queue.databaseName, obsoleteBytes)
    queue.settledLedgers += completedLedgers
    syncCurrentStorageCompactionRecoveryIntent()
    return true
  } catch (error) {
    queue.obsoleteBytes = saturatingAdd(queue.obsoleteBytes, obsoleteBytes)
    queue.completedLedgers += completedLedgers
    console.error('Failed to persist storage compaction debt', error)
    return false
  }
}

function finishPhysicalMutationDebtQueue(
  queue: PhysicalMutationDebtQueue,
  recoveryHandoff: boolean,
): void {
  if (queue.timer !== null) {
    clearTimeout(queue.timer)
    queue.timer = null
  }
  if (recoveryHandoff) {
    pendingCompletedPhysicalMutationLedgers -= queue.completedLedgers
    queue.settledLedgers += queue.completedLedgers
    queue.completedLedgers = 0
    queue.obsoleteBytes = 0
    if (physicalMutationIntentOutstanding) physicalMutationDebtRecoveryHandoff = true
    else physicalMutationDebtFailure ??= new Error('StorageCompactionDebtUnprotectedFailure')
  }
  physicalMutationDebtQueues.delete(queue.databaseName)
  releaseSettledPhysicalMutationDebtWork(queue)
}

function releaseSettledPhysicalMutationDebtWork(queue: PhysicalMutationDebtQueue): void {
  const settledLedgers = queue.settledLedgers
  queue.settledLedgers = 0
  endPhysicalMutationDebtWork(settledLedgers)
}

function storageCompactionDebtRetryDelay(failureCount: number): number {
  const exponent = Math.min(Math.max(0, failureCount - 1), 30)
  return Math.min(
    STORAGE_COMPACTION_DEBT_RETRY_MAX_MS,
    STORAGE_COMPACTION_DEBT_RETRY_BASE_MS * 2 ** exponent,
  )
}

export function publishStorageCompactionRequest(): void {
  for (const listener of [...storageCompactionRequestListeners]) {
    try {
      listener()
    } catch {
      // Maintenance wake delivery cannot affect durable debt accounting.
    }
  }
}

function readStorageCompactionRecoveryIntents(): StorageCompactionRecoveryIntent[] {
  const storage = browserLocalStorage()
  if (!storage) return []
  const intents: StorageCompactionRecoveryIntent[] = []
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (!key?.startsWith(STORAGE_COMPACTION_RECOVERY_INTENT_PREFIX)) continue
    const value = storage.getItem(key)
    const tabId = key.slice(STORAGE_COMPACTION_RECOVERY_INTENT_PREFIX.length)
    if (value && tabId) {
      intents.push({
        key,
        value,
        tabId,
        exactDebtByDatabase: parseStorageCompactionRecoveryIntent(value),
      })
    }
  }
  return intents
}

function clearStorageCompactionRecoveryIntents(
  intents: readonly Pick<StorageCompactionRecoveryIntent, 'key' | 'value'>[],
): void {
  const storage = browserLocalStorage()
  if (!storage) return
  for (const intent of intents) {
    if (storage.getItem(intent.key) === intent.value) {
      storage.removeItem(intent.key)
    }
  }
}

function writeStorageCompactionRecoveryIntent(key: string, value: string): boolean {
  const storage = browserLocalStorage()
  if (!storage) return false
  try {
    storage.setItem(key, value)
    return true
  } catch {
    return false
  }
}

function ensureCurrentStorageCompactionRecoveryIntent(): void {
  writeCurrentStorageCompactionRecoveryIntent(serializeStorageCompactionRecoveryIntent(null))
}

function syncCurrentStorageCompactionRecoveryIntent(): void {
  if (activePhysicalMutationLedgers !== 0) {
    writeCurrentStorageCompactionRecoveryIntent(serializeStorageCompactionRecoveryIntent(null))
  } else if (physicalMutationRecoveryDebtByDatabase.size !== 0) {
    writeCurrentStorageCompactionRecoveryIntent(
      serializeStorageCompactionRecoveryIntent(physicalMutationRecoveryDebtByDatabase),
    )
  } else if (physicalMutationIntentOutstanding && physicalMutationMarkerValue !== null) {
    clearStorageCompactionRecoveryIntents([
      { key: physicalMutationMarkerKey, value: physicalMutationMarkerValue },
    ])
    physicalMutationIntentOutstanding = false
    physicalMutationMarkerValue = null
  }
}

function writeCurrentStorageCompactionRecoveryIntent(value: string): void {
  if (physicalMutationMarkerValue === value && physicalMutationIntentOutstanding) return
  if (!writeStorageCompactionRecoveryIntent(physicalMutationMarkerKey, value)) return
  physicalMutationIntentOutstanding = true
  physicalMutationMarkerValue = value
}

function serializeStorageCompactionRecoveryIntent(
  debtByDatabase: ReadonlyMap<string, number> | null,
): string {
  return JSON.stringify({
    formatVersion: STORAGE_COMPACTION_RECOVERY_INTENT_FORMAT_VERSION,
    nonce: physicalMutationMarkerNonce,
    exactDebt:
      debtByDatabase === null
        ? null
        : [...debtByDatabase.entries()].sort(([left], [right]) => left.localeCompare(right)),
  })
}

function parseStorageCompactionRecoveryIntent(value: string): ReadonlyMap<string, number> | null {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const candidate = parsed as Record<string, unknown>
    if (
      candidate.formatVersion !== STORAGE_COMPACTION_RECOVERY_INTENT_FORMAT_VERSION ||
      typeof candidate.nonce !== 'string' ||
      !Array.isArray(candidate.exactDebt)
    ) {
      return null
    }
    const debts = new Map<string, number>()
    for (const entry of candidate.exactDebt) {
      if (
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        typeof entry[0] !== 'string' ||
        entry[0].length === 0 ||
        !Number.isSafeInteger(entry[1]) ||
        Number(entry[1]) < 0
      ) {
        return null
      }
      debts.set(entry[0], saturatingAdd(debts.get(entry[0]) ?? 0, Number(entry[1])))
    }
    return debts
  } catch {
    return null
  }
}

function addPhysicalMutationRecoveryDebt(databaseName: string, obsoleteBytes: number): void {
  physicalMutationRecoveryDebtByDatabase.set(
    databaseName,
    saturatingAdd(physicalMutationRecoveryDebtByDatabase.get(databaseName) ?? 0, obsoleteBytes),
  )
}

function subtractPhysicalMutationRecoveryDebt(databaseName: string, obsoleteBytes: number): void {
  const remaining = (physicalMutationRecoveryDebtByDatabase.get(databaseName) ?? 0) - obsoleteBytes
  if (remaining < 0) throw new Error('StorageCompactionRecoveryDebtUnderflow')
  if (remaining === 0) physicalMutationRecoveryDebtByDatabase.delete(databaseName)
  else physicalMutationRecoveryDebtByDatabase.set(databaseName, remaining)
}

function beginPhysicalMutationDebtWork(): void {
  if (physicalMutationDebtWork === 0) {
    physicalMutationDebtIdle = Dexie.ignoreTransaction(
      () =>
        new Promise<void>((resolve) => {
          resolvePhysicalMutationDebtIdle = resolve
        }),
    )
  }
  physicalMutationDebtWork += 1
}

function endPhysicalMutationDebtWork(completedLedgers = 1): void {
  if (completedLedgers > physicalMutationDebtWork) {
    throw new Error('StorageCompactionDebtWorkUnderflow')
  }
  physicalMutationDebtWork -= completedLedgers
  if (physicalMutationDebtWork !== 0) return
  physicalMutationDebtDrainRequested = false
  const resolve = resolvePhysicalMutationDebtIdle
  resolvePhysicalMutationDebtIdle = null
  resolve?.()
}

function storageCompactionIntentOwnerResourceName(tabId: string): string {
  return `${STORAGE_COMPACTION_INTENT_OWNER_RESOURCE_PREFIX}${tabId}`
}

async function storageCompactionIntentOwnerIsLive(db: Dexie, tabId: string): Promise<boolean> {
  if (tabId === physicalMutationTabId && physicalMutationIntentOutstanding) return true
  const lockName = coordinationLockName(storageCompactionIntentOwnerResourceName(tabId))
  const manager =
    typeof navigator === 'undefined'
      ? undefined
      : (navigator as Navigator & { locks?: LockManager }).locks
  if (manager && typeof manager.request === 'function') {
    try {
      const available = await manager.request(
        lockName,
        { mode: 'exclusive', ifAvailable: true },
        (lock) => lock !== null,
      )
      return !available
    } catch {
      return true
    }
  }
  const row = await db.table<BrowserLockRow, string>('browserLocks').get(lockName)
  return (
    row?.name === lockName &&
    typeof row.ownerClientId === 'string' &&
    typeof row.leaseId === 'string' &&
    Number.isFinite(row.expiresAt) &&
    row.expiresAt > Date.now()
  )
}

function waitForStorageCompactionIntentOwnerStop(
  stopped: AbortSignal,
  ownershipLost: AbortSignal | undefined,
): Promise<void> {
  if (stopped.aborted) return Promise.resolve()
  if (ownershipLost?.aborted) {
    return Promise.reject(storageCompactionError(ownershipLost.reason))
  }
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      stopped.removeEventListener('abort', stop)
      ownershipLost?.removeEventListener('abort', lose)
    }
    const stop = () => {
      cleanup()
      resolve()
    }
    const lose = () => {
      cleanup()
      reject(storageCompactionError(ownershipLost?.reason))
    }
    stopped.addEventListener('abort', stop, { once: true })
    ownershipLost?.addEventListener('abort', lose, { once: true })
  })
}

function storageCompactionOwnerAborted(controller: AbortController): boolean {
  return controller.signal.aborted
}

function storageCompactionIntentOwnerFailure(): unknown {
  return physicalMutationIntentOwnerFailure
}

function storageCompactionError(reason: unknown): Error {
  return reason instanceof Error
    ? reason
    : new Error('StorageCompactionOperationFailed', { cause: reason })
}

function createPhysicalMutationTabId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : newId()
}

function saturatingAdd(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right)
}
