import Dexie, { type Table } from 'dexie'
import { errorFromUnknown } from '../lib/error'
import {
  BROWSER_WORKSPACE_CONTROL_DATABASE_NAME,
  BROWSER_WORKSPACE_DATABASE_NAMES,
  type BrowserWorkspaceDatabaseName,
} from '../lib/origin-storage-names'
import { newId } from '../lib/ulid'

const CONTROL_MANIFEST_ID = 'workspace'
const COMPACTION_STATE_FORMAT_VERSION = 2
const BROWSER_WORKSPACE_COMPACTION_ATTEMPT_CLAIM = Symbol('compaction-attempt-claim')

export const BROWSER_WORKSPACE_COMPACTION_MIN_RECLAIMABLE_BYTES = 64 * 1024 * 1024

export type ExistingIndexedDbReadPlan<Value> =
  | {
      readonly kind: 'value'
      readonly value: Value
    }
  | {
      readonly kind: 'transaction'
      readonly storeNames: readonly string[]
      read(transaction: IDBTransaction): Value | Promise<Value>
    }

export function readExistingIndexedDb<Value>(
  databaseName: string,
  select: (database: IDBDatabase) => ExistingIndexedDbReadPlan<Value>,
): Promise<Value | null> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName)
    let createdByRace = false
    request.onupgradeneeded = () => {
      createdByRace = true
      request.transaction?.abort()
    }
    request.onsuccess = () => {
      const database = request.result
      database.onversionchange = () => database.close()
      let plan: ExistingIndexedDbReadPlan<Value>
      try {
        plan = select(database)
      } catch (error) {
        database.close()
        reject(errorFromUnknown(error))
        return
      }
      if (plan.kind === 'value') {
        database.close()
        resolve(plan.value)
        return
      }
      if (plan.storeNames.length === 0) {
        database.close()
        reject(new Error('ExistingIndexedDbReadStoresMissing'))
        return
      }
      let transaction: IDBTransaction
      try {
        transaction = database.transaction([...plan.storeNames], 'readonly')
      } catch (error) {
        database.close()
        reject(errorFromUnknown(error))
        return
      }
      const completion = new Promise<void>((complete, fail) => {
        transaction.oncomplete = () => complete()
        transaction.onerror = () =>
          fail(transaction.error ?? new Error('ExistingIndexedDbReadTransactionFailed'))
        transaction.onabort = () =>
          fail(transaction.error ?? new Error('ExistingIndexedDbReadTransactionAborted'))
      })
      let read: Promise<Value>
      try {
        read = Promise.resolve(plan.read(transaction))
      } catch (error) {
        read = Promise.reject(errorFromUnknown(error))
      }
      void Promise.all([read, completion]).then(
        ([value]) => {
          database.close()
          resolve(value)
        },
        (error: unknown) => {
          let failure: unknown = error
          try {
            transaction.abort()
          } catch (abortError) {
            if (!(abortError instanceof DOMException) || abortError.name !== 'InvalidStateError') {
              failure = new AggregateError(
                [error, abortError],
                'ExistingIndexedDbReadTransactionAbortFailed',
              )
            }
          }
          database.close()
          reject(errorFromUnknown(failure))
        },
      )
    }
    request.onerror = () => {
      if (createdByRace && request.error?.name === 'AbortError') resolve(null)
      else reject(request.error ?? new Error('ExistingIndexedDbReadOpenFailed'))
    }
  })
}

export interface BrowserWorkspaceCompactionState {
  readonly databaseName: string
  readonly formatVersion: typeof COMPACTION_STATE_FORMAT_VERSION
  readonly knownReclaimableBytes: number
  readonly lastCompactedLiveBytes: number
  readonly requestRevision: number
  readonly attemptedRevision: number
  readonly completedRevision: number
}

export interface BrowserWorkspaceCompactionAttemptClaim {
  readonly databaseName: string
  readonly revision: number
  readonly [BROWSER_WORKSPACE_COMPACTION_ATTEMPT_CLAIM]: true
  release(): Promise<BrowserWorkspaceCompactionAttemptRelease>
}

export type BrowserWorkspaceCompactionAttempt =
  | {
      readonly kind: 'claimed'
      readonly state: BrowserWorkspaceCompactionState
      readonly claim: BrowserWorkspaceCompactionAttemptClaim
    }
  | { readonly kind: 'idle'; readonly state: BrowserWorkspaceCompactionState }

export interface BrowserWorkspaceCompactionAttemptRelease {
  readonly released: boolean
  readonly state: BrowserWorkspaceCompactionState
}

export type BrowserWorkspaceReplacementStorageBaseline =
  | { readonly kind: 'reset'; readonly liveBytes: number }
  | { readonly kind: 'carry-source'; readonly liveBytes: number }

export interface BrowserWorkspaceReplacementPreparing {
  readonly nonce: string
  readonly phase: 'preparing'
  readonly sourceDatabaseName: BrowserWorkspaceDatabaseName
  readonly destinationDatabaseName: BrowserWorkspaceDatabaseName
}

export interface BrowserWorkspaceReplacementDiscard {
  readonly nonce: string
  readonly phase: 'discard'
  readonly sourceDatabaseName: BrowserWorkspaceDatabaseName
  readonly destinationDatabaseName: BrowserWorkspaceDatabaseName
}

export interface BrowserWorkspaceReplacementCleanup {
  readonly nonce: string
  readonly phase: 'cleanup'
  readonly sourceDatabaseName: BrowserWorkspaceDatabaseName
  readonly destinationDatabaseName: BrowserWorkspaceDatabaseName
}

export type BrowserWorkspaceReplacementJournal =
  | BrowserWorkspaceReplacementPreparing
  | BrowserWorkspaceReplacementDiscard
  | BrowserWorkspaceReplacementCleanup

export type BrowserWorkspaceReplacementBegin =
  | {
      readonly kind: 'ready'
      readonly journal: BrowserWorkspaceReplacementPreparing
    }
  | {
      readonly kind: 'occupied'
      readonly journal: BrowserWorkspaceReplacementJournal
    }

export interface BrowserWorkspaceDatabaseManifest {
  readonly id: typeof CONTROL_MANIFEST_ID
  readonly activeDatabaseName: BrowserWorkspaceDatabaseName
  readonly activationSequence: number
  readonly pending?: BrowserWorkspaceReplacementJournal
}

class BrowserWorkspaceControlDb extends Dexie {
  manifests!: Table<BrowserWorkspaceDatabaseManifest, string>
  compactionStates!: Table<BrowserWorkspaceCompactionState, string>

  constructor() {
    super(BROWSER_WORKSPACE_CONTROL_DATABASE_NAME)
    this.version(1).stores({ manifests: '&id' })
    this.version(2).stores({ manifests: '&id', compactionStates: '&databaseName' })
    this.version(3)
      .stores({ manifests: '&id', compactionStates: '&databaseName' })
      .upgrade((tx) =>
        tx
          .table<Record<string, unknown>, string>('compactionStates')
          .toCollection()
          .modify((value) => {
            if (
              value.formatVersion === 1 &&
              isNonNegativeSafeInteger(value.requestRevision) &&
              isNonNegativeSafeInteger(value.completedRevision) &&
              value.completedRevision <= value.requestRevision
            ) {
              value.formatVersion = COMPACTION_STATE_FORMAT_VERSION
              value.attemptedRevision = value.completedRevision
            }
          }),
      )
  }
}

let browserWorkspaceControlDb = new BrowserWorkspaceControlDb()
let browserWorkspaceControlDbOpening: Promise<void> | undefined
let browserWorkspaceControlDbAccepting = true
let browserWorkspaceControlDbActiveOperations = 0
let browserWorkspaceControlDbResolveIdle: (() => void) | undefined
let browserWorkspaceControlDbIdle: Promise<void> = Promise.resolve()
let browserWorkspaceControlDbClose: Promise<void> | undefined

export class BrowserWorkspaceActivationOutcomeUncertainError extends AggregateError {
  constructor(errors: readonly unknown[]) {
    super(errors, 'BrowserWorkspaceActivationOutcomeUncertain')
    this.name = 'BrowserWorkspaceActivationOutcomeUncertainError'
  }
}

export async function readBrowserWorkspaceDatabaseManifest(): Promise<BrowserWorkspaceDatabaseManifest> {
  return withControlDb(async (db) => {
    const stored = await db.manifests.get(CONTROL_MANIFEST_ID)
    if (stored !== undefined) return requireManifest(stored)
    return mutateBrowserWorkspaceControl(
      { readManifest: true },
      ({ manifest: current }) => {
        if (current !== undefined) return { result: requireManifest(current) }
        const initial = initialManifest()
        return { manifest: initial, result: initial }
      },
      db,
    )
  })
}

export function readBrowserWorkspaceCompactionState(
  databaseName: string,
): Promise<BrowserWorkspaceCompactionState> {
  return mutateBrowserWorkspaceCompactionState<BrowserWorkspaceCompactionState>(
    databaseName,
    (stored) => {
      if (stored) {
        try {
          const state = requireCompactionState(stored, databaseName)
          return { result: state }
        } catch {
          const recovered = conservativeCompactionState(databaseName)
          return { state: recovered, result: recovered }
        }
      }
      const initial = freshCompactionState(databaseName)
      return { state: initial, result: initial }
    },
  )
}

export function browserWorkspaceCompactionDemandPending(databaseName: string): Promise<boolean> {
  return withControlDb(async (db) => {
    const stored = await db.compactionStates.get(databaseName)
    if (stored === undefined) return false
    try {
      const state = requireCompactionState(stored, databaseName)
      return state.requestRevision > state.attemptedRevision
    } catch {
      return true
    }
  })
}

export function recordBrowserWorkspaceCompactionDebt(
  databaseName: string,
  obsoleteBytes: number,
): Promise<{ readonly state: BrowserWorkspaceCompactionState; readonly requested: boolean }> {
  if (!Number.isSafeInteger(obsoleteBytes) || obsoleteBytes < 0) {
    return Promise.reject(new Error('StorageCompactionDebtInvalid'))
  }
  return mutateBrowserWorkspaceCompactionState(databaseName, (stored) => {
    const previous = recoverableCompactionState(
      stored ?? freshCompactionState(databaseName),
      databaseName,
    )
    const threshold = browserWorkspaceCompactionDebtThreshold(previous.lastCompactedLiveBytes)
    const knownReclaimableBytes = saturatingAdd(previous.knownReclaimableBytes, obsoleteBytes)
    const crossed =
      Math.floor(knownReclaimableBytes / threshold) >
      Math.floor(previous.knownReclaimableBytes / threshold)
    const requestRevision = crossed
      ? saturatingAdd(previous.requestRevision, 1)
      : previous.requestRevision
    const state: BrowserWorkspaceCompactionState = {
      ...previous,
      knownReclaimableBytes,
      requestRevision,
    }
    return { state, result: { state, requested: crossed } }
  })
}

export function claimBrowserWorkspaceCompactionAttempt(
  databaseName: string,
): Promise<BrowserWorkspaceCompactionAttempt> {
  return mutateBrowserWorkspaceCompactionState<BrowserWorkspaceCompactionAttempt>(
    databaseName,
    (stored) => {
      const previous = recoverableCompactionState(
        stored ?? freshCompactionState(databaseName),
        databaseName,
      )
      if (previous.requestRevision <= previous.attemptedRevision) {
        return { result: { kind: 'idle', state: previous } }
      }
      const state: BrowserWorkspaceCompactionState = {
        ...previous,
        attemptedRevision: previous.requestRevision,
      }
      return {
        state,
        result: {
          kind: 'claimed',
          state,
          claim: createBrowserWorkspaceCompactionAttemptClaim(
            databaseName,
            state.attemptedRevision,
          ),
        },
      }
    },
  )
}

function createBrowserWorkspaceCompactionAttemptClaim(
  databaseName: string,
  revision: number,
): BrowserWorkspaceCompactionAttemptClaim {
  let releaseTask: Promise<BrowserWorkspaceCompactionAttemptRelease> | null = null
  const claim: BrowserWorkspaceCompactionAttemptClaim = {
    databaseName,
    revision,
    [BROWSER_WORKSPACE_COMPACTION_ATTEMPT_CLAIM]: true,
    release: () => {
      if (releaseTask) return releaseTask
      const task = releaseBrowserWorkspaceCompactionAttempt(databaseName, revision)
      releaseTask = task
      void task.catch(() => {
        if (releaseTask === task) releaseTask = null
      })
      return task
    },
  }
  return Object.freeze(claim)
}

function releaseBrowserWorkspaceCompactionAttempt(
  databaseName: string,
  revision: number,
): Promise<BrowserWorkspaceCompactionAttemptRelease> {
  return mutateBrowserWorkspaceCompactionState<BrowserWorkspaceCompactionAttemptRelease>(
    databaseName,
    (stored) => {
      const previous = recoverableCompactionState(
        stored ?? freshCompactionState(databaseName),
        databaseName,
      )
      if (previous.completedRevision >= revision || previous.attemptedRevision !== revision) {
        return { result: { released: false, state: previous } }
      }
      const state: BrowserWorkspaceCompactionState = {
        ...previous,
        requestRevision: Math.max(previous.requestRevision, saturatingAdd(revision, 1)),
        attemptedRevision: previous.completedRevision,
      }
      return { state, result: { released: true, state } }
    },
  )
}

export function applyUnslottedBrowserWorkspaceReplacementStorageBaseline(
  databaseName: string,
  baseline: BrowserWorkspaceReplacementStorageBaseline,
): Promise<BrowserWorkspaceCompactionState> {
  return mutateBrowserWorkspaceControl(
    { compactionStateKeys: [databaseName] },
    ({ compactionStates }) => {
      const state = replacementStorageBaselineState(
        compactionStates.get(databaseName),
        databaseName,
        databaseName,
        baseline,
      )
      return { compactionStates: [state], result: state }
    },
  )
}

export function migrateBrowserWorkspaceCompactionState(
  databaseName: string,
  legacy: {
    readonly knownReclaimableBytes: number
    readonly lastCompactedLiveBytes: number
    readonly requestRevision: number
    readonly completedRevision: number
  },
): Promise<BrowserWorkspaceCompactionState> {
  requireCompactionCounters({ ...legacy, attemptedRevision: legacy.completedRevision })
  return mutateBrowserWorkspaceCompactionState(databaseName, (stored) => {
    const previous = stored
      ? recoverableCompactionState(stored, databaseName)
      : freshCompactionState(databaseName)
    const requestRevision = Math.max(previous.requestRevision, legacy.requestRevision)
    const state: BrowserWorkspaceCompactionState = {
      databaseName,
      formatVersion: COMPACTION_STATE_FORMAT_VERSION,
      knownReclaimableBytes: Math.max(previous.knownReclaimableBytes, legacy.knownReclaimableBytes),
      lastCompactedLiveBytes: Math.max(
        previous.lastCompactedLiveBytes,
        legacy.lastCompactedLiveBytes,
      ),
      requestRevision,
      attemptedRevision: Math.min(
        requestRevision,
        Math.max(previous.attemptedRevision, legacy.completedRevision),
      ),
      completedRevision: Math.min(
        requestRevision,
        Math.max(previous.completedRevision, legacy.completedRevision),
      ),
    }
    return { state, result: state }
  })
}

export function deleteBrowserWorkspaceCompactionState(databaseName: string): Promise<void> {
  return mutateBrowserWorkspaceControl({ useCompactionStateStore: true }, () => ({
    deleteCompactionStateKeys: [databaseName],
    result: undefined,
  }))
}

export function browserWorkspaceCompactionDebtThreshold(lastCompactedLiveBytes: number): number {
  assertCompactionLiveBytes(lastCompactedLiveBytes)
  return Math.max(
    BROWSER_WORKSPACE_COMPACTION_MIN_RECLAIMABLE_BYTES,
    Math.ceil(lastCompactedLiveBytes / 2),
  )
}

export async function beginBrowserWorkspaceDatabaseReplacement(): Promise<BrowserWorkspaceReplacementPreparing> {
  const result = await tryBeginBrowserWorkspaceDatabaseReplacement()
  if (result.kind === 'occupied') {
    throw new Error(`BrowserWorkspaceReplacementJournalBusy:${result.journal.phase}`)
  }
  return result.journal
}

export async function tryBeginBrowserWorkspaceDatabaseReplacement(): Promise<BrowserWorkspaceReplacementBegin> {
  return mutateBrowserWorkspaceControl<BrowserWorkspaceReplacementBegin>(
    { readManifest: true, useCompactionStateStore: true },
    ({ manifest: stored }) => {
      const manifest = requireManifest(stored ?? initialManifest())
      if (manifest.pending) {
        return { result: { kind: 'occupied', journal: manifest.pending } }
      }
      const sourceDatabaseName = manifest.activeDatabaseName
      const sourceIndex = BROWSER_WORKSPACE_DATABASE_NAMES.indexOf(sourceDatabaseName)
      const destinationDatabaseName = BROWSER_WORKSPACE_DATABASE_NAMES[
        (sourceIndex + 1) % BROWSER_WORKSPACE_DATABASE_NAMES.length
      ] as BrowserWorkspaceDatabaseName
      const pending: BrowserWorkspaceReplacementPreparing = {
        nonce: newId(),
        phase: 'preparing',
        sourceDatabaseName,
        destinationDatabaseName,
      }
      return {
        manifest: { ...manifest, pending },
        deleteCompactionStateKeys: [destinationDatabaseName],
        result: { kind: 'ready', journal: pending },
      }
    },
  )
}

export async function activatePreparedBrowserWorkspaceDatabase(
  expected: BrowserWorkspaceReplacementPreparing,
  storageBaseline: BrowserWorkspaceReplacementStorageBaseline,
): Promise<BrowserWorkspaceDatabaseManifest> {
  try {
    const baselineDatabaseName =
      storageBaseline.kind === 'carry-source'
        ? expected.sourceDatabaseName
        : expected.destinationDatabaseName
    return await mutateBrowserWorkspaceControl(
      { readManifest: true, compactionStateKeys: [baselineDatabaseName] },
      ({ manifest: stored, compactionStates }) => {
        const manifest = requireManifest(stored)
        assertPendingReplacement(manifest, expected, 'preparing')
        if (manifest.activationSequence >= Number.MAX_SAFE_INTEGER) {
          throw new Error('BrowserWorkspaceActivationSequenceExhausted')
        }
        const pending: BrowserWorkspaceReplacementCleanup = {
          ...expected,
          phase: 'cleanup',
        }
        const activated: BrowserWorkspaceDatabaseManifest = {
          id: CONTROL_MANIFEST_ID,
          activeDatabaseName: expected.destinationDatabaseName,
          activationSequence: manifest.activationSequence + 1,
          pending,
        }
        const state = replacementStorageBaselineState(
          compactionStates.get(baselineDatabaseName),
          expected.sourceDatabaseName,
          expected.destinationDatabaseName,
          storageBaseline,
        )
        return { manifest: activated, compactionStates: [state], result: activated }
      },
    )
  } catch (activationError) {
    let manifest: BrowserWorkspaceDatabaseManifest
    try {
      manifest = await readBrowserWorkspaceDatabaseManifest()
    } catch (inspectionError) {
      throw new BrowserWorkspaceActivationOutcomeUncertainError([activationError, inspectionError])
    }
    const outcome = classifyBrowserWorkspacePreparedActivationOutcome(manifest, expected)
    if (outcome === 'activated') return manifest
    if (outcome === 'preparing') throw activationError
    throw new BrowserWorkspaceActivationOutcomeUncertainError([activationError])
  }
}

function replacementStorageBaselineState(
  stored: unknown,
  sourceDatabaseName: string,
  destinationDatabaseName: string,
  baseline: BrowserWorkspaceReplacementStorageBaseline,
): BrowserWorkspaceCompactionState {
  assertCompactionLiveBytes(baseline.liveBytes)
  const baselineDatabaseName =
    baseline.kind === 'carry-source' ? sourceDatabaseName : destinationDatabaseName
  const previous = recoverableCompactionState(
    stored ?? freshCompactionState(baselineDatabaseName),
    baselineDatabaseName,
  )
  return {
    databaseName: destinationDatabaseName,
    formatVersion: COMPACTION_STATE_FORMAT_VERSION,
    knownReclaimableBytes: 0,
    lastCompactedLiveBytes: baseline.liveBytes,
    requestRevision: previous.requestRevision,
    attemptedRevision:
      baseline.kind === 'reset' ? previous.requestRevision : previous.attemptedRevision,
    completedRevision:
      baseline.kind === 'reset' ? previous.requestRevision : previous.attemptedRevision,
  }
}

export async function abandonPreparedBrowserWorkspaceDatabase(
  expected: BrowserWorkspaceReplacementPreparing,
): Promise<void> {
  await mutateBrowserWorkspaceControl({ readManifest: true }, ({ manifest: stored }) => {
    const manifest = requireManifest(stored)
    if (samePendingReplacement(manifest.pending, { ...expected, phase: 'discard' })) {
      return { result: undefined }
    }
    assertPendingReplacement(manifest, expected, 'preparing')
    return {
      manifest: {
        id: CONTROL_MANIFEST_ID,
        activeDatabaseName: manifest.activeDatabaseName,
        activationSequence: manifest.activationSequence,
        pending: { ...expected, phase: 'discard' },
      },
      result: undefined,
    }
  })
}

export async function completeBrowserWorkspaceDatabaseCleanup(
  expected: BrowserWorkspaceReplacementDiscard | BrowserWorkspaceReplacementCleanup,
): Promise<void> {
  await mutateBrowserWorkspaceControl(
    { readManifest: true, useCompactionStateStore: true },
    ({ manifest: stored }) => {
      const manifest = requireManifest(stored)
      assertPendingReplacement(manifest, expected, expected.phase)
      const obsoleteDatabaseName =
        expected.phase === 'discard'
          ? expected.destinationDatabaseName
          : expected.sourceDatabaseName
      return {
        manifest: {
          id: CONTROL_MANIFEST_ID,
          activeDatabaseName: manifest.activeDatabaseName,
          activationSequence: manifest.activationSequence,
        },
        deleteCompactionStateKeys: [obsoleteDatabaseName],
        result: undefined,
      }
    },
  )
}

function isBrowserWorkspaceDatabaseName(value: unknown): value is BrowserWorkspaceDatabaseName {
  return (
    typeof value === 'string' &&
    BROWSER_WORKSPACE_DATABASE_NAMES.includes(value as BrowserWorkspaceDatabaseName)
  )
}

function withControlDb<T>(operation: (db: BrowserWorkspaceControlDb) => Promise<T>): Promise<T> {
  if (!browserWorkspaceControlDbAccepting) {
    return Promise.reject(new Error('BrowserWorkspaceControlDatabaseClosed'))
  }
  if (browserWorkspaceControlDbActiveOperations === 0) {
    browserWorkspaceControlDbIdle = new Promise<void>((resolve) => {
      browserWorkspaceControlDbResolveIdle = resolve
    })
  }
  browserWorkspaceControlDbActiveOperations += 1
  return Dexie.ignoreTransaction(async () => {
    try {
      if (!browserWorkspaceControlDb.isOpen()) {
        browserWorkspaceControlDbOpening ??= browserWorkspaceControlDb.open().then(() => undefined)
        try {
          await browserWorkspaceControlDbOpening
        } finally {
          browserWorkspaceControlDbOpening = undefined
        }
      }
      return await operation(browserWorkspaceControlDb)
    } finally {
      browserWorkspaceControlDbActiveOperations -= 1
      if (browserWorkspaceControlDbActiveOperations === 0) {
        const resolveIdle = browserWorkspaceControlDbResolveIdle
        browserWorkspaceControlDbResolveIdle = undefined
        resolveIdle?.()
      }
    }
  })
}

export function closeBrowserWorkspaceControlDatabase(): Promise<void> {
  if (browserWorkspaceControlDbClose) return browserWorkspaceControlDbClose
  browserWorkspaceControlDbAccepting = false
  browserWorkspaceControlDbClose = browserWorkspaceControlDbIdle.then(() => {
    browserWorkspaceControlDb.close()
  })
  return browserWorkspaceControlDbClose
}

export function __resetBrowserWorkspaceControlDatabaseForTests(): void {
  if (browserWorkspaceControlDbActiveOperations !== 0) {
    throw new Error('BrowserWorkspaceControlDatabaseResetWhileActive')
  }
  browserWorkspaceControlDb.close()
  browserWorkspaceControlDb = new BrowserWorkspaceControlDb()
  browserWorkspaceControlDbOpening = undefined
  browserWorkspaceControlDbAccepting = true
  browserWorkspaceControlDbResolveIdle = undefined
  browserWorkspaceControlDbIdle = Promise.resolve()
  browserWorkspaceControlDbClose = undefined
}

interface BrowserWorkspaceControlSnapshot {
  readonly manifest: unknown
  readonly compactionStates: ReadonlyMap<string, unknown>
}

interface BrowserWorkspaceControlMutation<Result> {
  readonly manifest?: BrowserWorkspaceDatabaseManifest
  readonly compactionStates?: readonly BrowserWorkspaceCompactionState[]
  readonly deleteCompactionStateKeys?: readonly string[]
  readonly result: Result
}

function mutateBrowserWorkspaceControl<Result>(
  input: {
    readonly readManifest?: boolean
    readonly compactionStateKeys?: readonly string[]
    readonly useCompactionStateStore?: boolean
  },
  mutate: (snapshot: BrowserWorkspaceControlSnapshot) => BrowserWorkspaceControlMutation<Result>,
  existingDb?: BrowserWorkspaceControlDb,
): Promise<Result> {
  const compactionStateKeys = [...new Set(input.compactionStateKeys ?? [])]
  const storeNames = [
    ...(input.readManifest ? ['manifests'] : []),
    ...(input.useCompactionStateStore || compactionStateKeys.length > 0
      ? ['compactionStates']
      : []),
  ]
  if (storeNames.length === 0) return Promise.reject(new Error('ControlMutationStoresMissing'))
  const run = (db: BrowserWorkspaceControlDb) =>
    new Promise<Result>((resolve, reject) => {
      let transaction: IDBTransaction
      try {
        transaction = db.backendDB().transaction(storeNames, 'readwrite')
      } catch (error) {
        reject(errorFromUnknown(error))
        return
      }
      let failure: Error | undefined
      let result: Result | undefined
      let resultReady = false
      transaction.onabort = () =>
        reject(failure ?? transaction.error ?? new Error('ControlMutationAborted'))
      transaction.onerror = () => undefined
      transaction.oncomplete = () => {
        if (!resultReady) {
          reject(new Error('ControlMutationResultMissing'))
          return
        }
        resolve(result as Result)
      }

      let manifest: unknown
      const compactionStates = new Map<string, unknown>()
      let pendingReads = (input.readManifest ? 1 : 0) + compactionStateKeys.length
      const recordWriteError = (request: IDBRequest, message: string) => {
        request.onerror = () => {
          failure = request.error ?? new Error(message)
        }
      }
      const applyMutation = () => {
        let mutation: BrowserWorkspaceControlMutation<Result>
        try {
          mutation = mutate({ manifest, compactionStates })
          if (mutation.manifest) {
            recordWriteError(
              transaction.objectStore('manifests').put(mutation.manifest),
              'ControlManifestWriteFailed',
            )
          }
          if (mutation.compactionStates || mutation.deleteCompactionStateKeys) {
            const compactionStore = transaction.objectStore('compactionStates')
            for (const state of mutation.compactionStates ?? []) {
              recordWriteError(compactionStore.put(state), 'ControlCompactionStateWriteFailed')
            }
            for (const databaseName of mutation.deleteCompactionStateKeys ?? []) {
              recordWriteError(
                compactionStore.delete(databaseName),
                'ControlCompactionStateDeleteFailed',
              )
            }
          }
          result = mutation.result
          resultReady = true
        } catch (error) {
          failure = errorFromUnknown(error)
          transaction.abort()
        }
      }
      const completeRead = () => {
        pendingReads -= 1
        if (pendingReads === 0) applyMutation()
      }
      if (input.readManifest) {
        const read = transaction.objectStore('manifests').get(CONTROL_MANIFEST_ID)
        read.onerror = () => {
          failure = read.error ?? new Error('ControlManifestReadFailed')
        }
        read.onsuccess = () => {
          manifest = read.result
          completeRead()
        }
      }
      if (compactionStateKeys.length > 0) {
        const store = transaction.objectStore('compactionStates')
        for (const databaseName of compactionStateKeys) {
          const read = store.get(databaseName)
          read.onerror = () => {
            failure = read.error ?? new Error('ControlCompactionStateReadFailed')
          }
          read.onsuccess = () => {
            compactionStates.set(databaseName, read.result)
            completeRead()
          }
        }
      }
      if (pendingReads === 0) applyMutation()
    })
  return existingDb ? run(existingDb) : withControlDb(run)
}

function mutateBrowserWorkspaceCompactionState<Result>(
  databaseName: string,
  mutate: (stored: unknown) => {
    readonly state?: BrowserWorkspaceCompactionState
    readonly result: Result
  },
): Promise<Result> {
  return mutateBrowserWorkspaceControl(
    { compactionStateKeys: [databaseName] },
    ({ compactionStates }) => {
      const mutation = mutate(compactionStates.get(databaseName))
      return {
        ...(mutation.state ? { compactionStates: [mutation.state] } : {}),
        result: mutation.result,
      }
    },
  )
}

function initialManifest(): BrowserWorkspaceDatabaseManifest {
  return {
    id: CONTROL_MANIFEST_ID,
    activeDatabaseName: 'natter',
    activationSequence: 0,
  }
}

function freshCompactionState(databaseName: string): BrowserWorkspaceCompactionState {
  if (databaseName.length === 0) throw new Error('StorageCompactionDatabaseNameInvalid')
  return {
    databaseName,
    formatVersion: COMPACTION_STATE_FORMAT_VERSION,
    knownReclaimableBytes: 0,
    lastCompactedLiveBytes: 0,
    requestRevision: 0,
    attemptedRevision: 0,
    completedRevision: 0,
  }
}

function requireCompactionState(
  value: unknown,
  databaseName: string,
): BrowserWorkspaceCompactionState {
  if (!value || typeof value !== 'object') throw new Error('StorageCompactionStateInvalid')
  const candidate = value as Partial<BrowserWorkspaceCompactionState>
  if (
    candidate.databaseName !== databaseName ||
    candidate.formatVersion !== COMPACTION_STATE_FORMAT_VERSION
  ) {
    throw new Error('StorageCompactionStateInvalid')
  }
  requireCompactionCounters(candidate)
  return { ...(candidate as BrowserWorkspaceCompactionState) }
}

function recoverableCompactionState(
  value: unknown,
  databaseName: string,
): BrowserWorkspaceCompactionState {
  try {
    return requireCompactionState(value, databaseName)
  } catch {
    return conservativeCompactionState(databaseName)
  }
}

function conservativeCompactionState(databaseName: string): BrowserWorkspaceCompactionState {
  return {
    databaseName,
    formatVersion: COMPACTION_STATE_FORMAT_VERSION,
    knownReclaimableBytes: BROWSER_WORKSPACE_COMPACTION_MIN_RECLAIMABLE_BYTES,
    lastCompactedLiveBytes: 0,
    requestRevision: 1,
    attemptedRevision: 0,
    completedRevision: 0,
  }
}

function requireCompactionCounters(value: {
  readonly knownReclaimableBytes?: unknown
  readonly lastCompactedLiveBytes?: unknown
  readonly requestRevision?: unknown
  readonly attemptedRevision?: unknown
  readonly completedRevision?: unknown
}): void {
  if (
    !isNonNegativeSafeInteger(value.knownReclaimableBytes) ||
    !isNonNegativeSafeInteger(value.lastCompactedLiveBytes) ||
    !isNonNegativeSafeInteger(value.requestRevision) ||
    !isNonNegativeSafeInteger(value.attemptedRevision) ||
    !isNonNegativeSafeInteger(value.completedRevision) ||
    value.completedRevision > value.attemptedRevision ||
    value.attemptedRevision > value.requestRevision
  ) {
    throw new Error('StorageCompactionStateInvalid')
  }
}

function assertCompactionLiveBytes(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('StorageCompactionLiveBytesInvalid')
  }
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function saturatingAdd(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right)
}

function requireManifest(value: unknown): BrowserWorkspaceDatabaseManifest {
  if (!value || typeof value !== 'object') throw new Error('BrowserWorkspaceControlManifestInvalid')
  const candidate = value as Partial<BrowserWorkspaceDatabaseManifest>
  if (
    candidate.id !== CONTROL_MANIFEST_ID ||
    !isBrowserWorkspaceDatabaseName(candidate.activeDatabaseName) ||
    !Number.isSafeInteger(candidate.activationSequence) ||
    (candidate.activationSequence ?? -1) < 0
  ) {
    throw new Error('BrowserWorkspaceControlManifestInvalid')
  }
  const pending = candidate.pending
  if (pending !== undefined) {
    const pendingPhase: unknown = (pending as { readonly phase?: unknown }).phase
    if (
      typeof pending.nonce !== 'string' ||
      pending.nonce.length === 0 ||
      (pendingPhase !== 'preparing' && pendingPhase !== 'discard' && pendingPhase !== 'cleanup') ||
      !isBrowserWorkspaceDatabaseName(pending.sourceDatabaseName) ||
      !isBrowserWorkspaceDatabaseName(pending.destinationDatabaseName) ||
      pending.sourceDatabaseName === pending.destinationDatabaseName ||
      (pending.phase === 'preparing' || pending.phase === 'discard'
        ? candidate.activeDatabaseName !== pending.sourceDatabaseName
        : candidate.activeDatabaseName !== pending.destinationDatabaseName)
    ) {
      throw new Error('BrowserWorkspaceControlManifestInvalid')
    }
  }
  return {
    id: CONTROL_MANIFEST_ID,
    activeDatabaseName: candidate.activeDatabaseName,
    activationSequence: candidate.activationSequence as number,
    ...(pending ? { pending: { ...pending } } : {}),
  }
}

function assertPendingReplacement(
  manifest: BrowserWorkspaceDatabaseManifest,
  expected: BrowserWorkspaceReplacementJournal,
  phase: BrowserWorkspaceReplacementJournal['phase'],
): void {
  const pending = manifest.pending
  if (
    !pending ||
    pending.phase !== phase ||
    pending.nonce !== expected.nonce ||
    pending.sourceDatabaseName !== expected.sourceDatabaseName ||
    pending.destinationDatabaseName !== expected.destinationDatabaseName
  ) {
    throw new Error('BrowserWorkspaceReplacementJournalChanged')
  }
}

export function sameBrowserWorkspaceReplacementJournal(
  left: BrowserWorkspaceReplacementJournal | undefined,
  right: BrowserWorkspaceReplacementJournal,
): boolean {
  return samePendingReplacement(left, right)
}

function samePendingReplacement(
  left: BrowserWorkspaceReplacementJournal | undefined,
  right: BrowserWorkspaceReplacementJournal,
): boolean {
  return (
    left?.phase === right.phase &&
    left.nonce === right.nonce &&
    left.sourceDatabaseName === right.sourceDatabaseName &&
    left.destinationDatabaseName === right.destinationDatabaseName
  )
}

export function classifyBrowserWorkspacePreparedActivationOutcome(
  manifest: BrowserWorkspaceDatabaseManifest,
  expected: BrowserWorkspaceReplacementPreparing,
): 'preparing' | 'activated' | 'changed' {
  const pending = manifest.pending
  if (
    !pending ||
    pending.nonce !== expected.nonce ||
    pending.sourceDatabaseName !== expected.sourceDatabaseName ||
    pending.destinationDatabaseName !== expected.destinationDatabaseName
  ) {
    return 'changed'
  }
  if (
    pending.phase === 'preparing' &&
    manifest.activeDatabaseName === expected.sourceDatabaseName
  ) {
    return 'preparing'
  }
  if (
    pending.phase === 'cleanup' &&
    manifest.activeDatabaseName === expected.destinationDatabaseName
  ) {
    return 'activated'
  }
  return 'changed'
}
