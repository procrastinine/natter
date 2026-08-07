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
      void Promise.all([read, completion])
        .then(([value]) => resolve(value))
        .catch((error: unknown) => {
          try {
            transaction.abort()
          } catch (abortError) {
            if (!(abortError instanceof DOMException) || abortError.name !== 'InvalidStateError') {
              reject(
                new AggregateError(
                  [error, abortError],
                  'ExistingIndexedDbReadTransactionAbortFailed',
                ),
              )
              return
            }
          }
          reject(errorFromUnknown(error))
        })
        .finally(() => database.close())
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

export class BrowserWorkspaceActivationOutcomeUncertainError extends AggregateError {
  constructor(errors: readonly unknown[]) {
    super(errors, 'BrowserWorkspaceActivationOutcomeUncertain')
    this.name = 'BrowserWorkspaceActivationOutcomeUncertainError'
  }
}

export async function readBrowserWorkspaceDatabaseManifest(): Promise<BrowserWorkspaceDatabaseManifest> {
  const stored = await withControlDb((db) => db.manifests.get(CONTROL_MANIFEST_ID))
  if (stored !== undefined) return requireManifest(stored)
  return withControlDb((db) =>
    db.transaction('rw', db.manifests, async () => {
      const current = await db.manifests.get(CONTROL_MANIFEST_ID)
      if (current !== undefined) return requireManifest(current)
      const initial = initialManifest()
      await db.manifests.put(initial)
      return initial
    }),
  )
}

export function readBrowserWorkspaceCompactionState(
  databaseName: string,
): Promise<BrowserWorkspaceCompactionState> {
  return withControlDb((db) =>
    db.transaction('rw', db.compactionStates, async () => {
      const stored = await db.compactionStates.get(databaseName)
      if (stored) {
        try {
          return requireCompactionState(stored, databaseName)
        } catch {
          const recovered = conservativeCompactionState(databaseName)
          await db.compactionStates.put(recovered)
          return recovered
        }
      }
      const initial = freshCompactionState(databaseName)
      await db.compactionStates.put(initial)
      return initial
    }),
  )
}

export function recordBrowserWorkspaceCompactionDebt(
  databaseName: string,
  obsoleteBytes: number,
): Promise<{ readonly state: BrowserWorkspaceCompactionState; readonly requested: boolean }> {
  if (!Number.isSafeInteger(obsoleteBytes) || obsoleteBytes < 0) {
    return Promise.reject(new Error('StorageCompactionDebtInvalid'))
  }
  return withControlDb((db) =>
    db.transaction('rw', db.compactionStates, async () => {
      const previous = recoverableCompactionState(
        (await db.compactionStates.get(databaseName)) ?? freshCompactionState(databaseName),
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
      await db.compactionStates.put(state)
      return { state, requested: crossed }
    }),
  )
}

export function claimBrowserWorkspaceCompactionAttempt(
  databaseName: string,
): Promise<BrowserWorkspaceCompactionAttempt> {
  return withControlDb((db) =>
    db.transaction('rw', db.compactionStates, async () => {
      const previous = recoverableCompactionState(
        (await db.compactionStates.get(databaseName)) ?? freshCompactionState(databaseName),
        databaseName,
      )
      if (previous.requestRevision <= previous.attemptedRevision) {
        return { kind: 'idle', state: previous }
      }
      const state: BrowserWorkspaceCompactionState = {
        ...previous,
        attemptedRevision: previous.requestRevision,
      }
      await db.compactionStates.put(state)
      return {
        kind: 'claimed',
        state,
        claim: createBrowserWorkspaceCompactionAttemptClaim(databaseName, state.attemptedRevision),
      }
    }),
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
  return withControlDb((db) =>
    db.transaction('rw', db.compactionStates, async () => {
      const previous = recoverableCompactionState(
        (await db.compactionStates.get(databaseName)) ?? freshCompactionState(databaseName),
        databaseName,
      )
      if (previous.completedRevision >= revision || previous.attemptedRevision !== revision) {
        return { released: false, state: previous }
      }
      const state: BrowserWorkspaceCompactionState = {
        ...previous,
        requestRevision: Math.max(previous.requestRevision, saturatingAdd(revision, 1)),
        attemptedRevision: previous.completedRevision,
      }
      await db.compactionStates.put(state)
      return { released: true, state }
    }),
  )
}

export function applyUnslottedBrowserWorkspaceReplacementStorageBaseline(
  databaseName: string,
  baseline: BrowserWorkspaceReplacementStorageBaseline,
): Promise<BrowserWorkspaceCompactionState> {
  return withControlDb((db) =>
    db.transaction('rw', db.compactionStates, () =>
      applyReplacementStorageBaseline(db, databaseName, databaseName, baseline),
    ),
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
  return withControlDb((db) =>
    db.transaction('rw', db.compactionStates, async () => {
      const stored = await db.compactionStates.get(databaseName)
      const previous = stored
        ? recoverableCompactionState(stored, databaseName)
        : freshCompactionState(databaseName)
      const requestRevision = Math.max(previous.requestRevision, legacy.requestRevision)
      const state: BrowserWorkspaceCompactionState = {
        databaseName,
        formatVersion: COMPACTION_STATE_FORMAT_VERSION,
        knownReclaimableBytes: Math.max(
          previous.knownReclaimableBytes,
          legacy.knownReclaimableBytes,
        ),
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
      await db.compactionStates.put(state)
      return state
    }),
  )
}

export function deleteBrowserWorkspaceCompactionState(databaseName: string): Promise<void> {
  return withControlDb((db) => db.compactionStates.delete(databaseName))
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
  return withControlDb((db) =>
    db.transaction('rw', [db.manifests, db.compactionStates], async () => {
      const manifest = requireManifest(
        (await db.manifests.get(CONTROL_MANIFEST_ID)) ?? initialManifest(),
      )
      if (manifest.pending) return { kind: 'occupied', journal: manifest.pending }
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
      await db.compactionStates.delete(destinationDatabaseName)
      await db.manifests.put({ ...manifest, pending })
      return { kind: 'ready', journal: pending }
    }),
  )
}

export async function activatePreparedBrowserWorkspaceDatabase(
  expected: BrowserWorkspaceReplacementPreparing,
  storageBaseline: BrowserWorkspaceReplacementStorageBaseline,
): Promise<BrowserWorkspaceDatabaseManifest> {
  try {
    return await withControlDb((db) =>
      db.transaction('rw', [db.manifests, db.compactionStates], async () => {
        const manifest = requireManifest(await db.manifests.get(CONTROL_MANIFEST_ID))
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
        await applyReplacementStorageBaseline(
          db,
          expected.sourceDatabaseName,
          expected.destinationDatabaseName,
          storageBaseline,
        )
        await db.manifests.put(activated)
        return activated
      }),
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

async function applyReplacementStorageBaseline(
  db: BrowserWorkspaceControlDb,
  sourceDatabaseName: string,
  destinationDatabaseName: string,
  baseline: BrowserWorkspaceReplacementStorageBaseline,
): Promise<BrowserWorkspaceCompactionState> {
  assertCompactionLiveBytes(baseline.liveBytes)
  const previous = recoverableCompactionState(
    (await db.compactionStates.get(
      baseline.kind === 'carry-source' ? sourceDatabaseName : destinationDatabaseName,
    )) ??
      freshCompactionState(
        baseline.kind === 'carry-source' ? sourceDatabaseName : destinationDatabaseName,
      ),
    baseline.kind === 'carry-source' ? sourceDatabaseName : destinationDatabaseName,
  )
  const state: BrowserWorkspaceCompactionState = {
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
  await db.compactionStates.put(state)
  return state
}

export async function abandonPreparedBrowserWorkspaceDatabase(
  expected: BrowserWorkspaceReplacementPreparing,
): Promise<void> {
  await withControlDb((db) =>
    db.transaction('rw', db.manifests, async () => {
      const manifest = requireManifest(await db.manifests.get(CONTROL_MANIFEST_ID))
      if (samePendingReplacement(manifest.pending, { ...expected, phase: 'discard' })) return
      assertPendingReplacement(manifest, expected, 'preparing')
      await db.manifests.put({
        id: CONTROL_MANIFEST_ID,
        activeDatabaseName: manifest.activeDatabaseName,
        activationSequence: manifest.activationSequence,
        pending: { ...expected, phase: 'discard' },
      })
    }),
  )
}

export async function completeBrowserWorkspaceDatabaseCleanup(
  expected: BrowserWorkspaceReplacementDiscard | BrowserWorkspaceReplacementCleanup,
): Promise<void> {
  await withControlDb((db) =>
    db.transaction('rw', [db.manifests, db.compactionStates], async () => {
      const manifest = requireManifest(await db.manifests.get(CONTROL_MANIFEST_ID))
      assertPendingReplacement(manifest, expected, expected.phase)
      await db.compactionStates.delete(
        expected.phase === 'discard'
          ? expected.destinationDatabaseName
          : expected.sourceDatabaseName,
      )
      await db.manifests.put({
        id: CONTROL_MANIFEST_ID,
        activeDatabaseName: manifest.activeDatabaseName,
        activationSequence: manifest.activationSequence,
      })
    }),
  )
}

function isBrowserWorkspaceDatabaseName(value: unknown): value is BrowserWorkspaceDatabaseName {
  return (
    typeof value === 'string' &&
    BROWSER_WORKSPACE_DATABASE_NAMES.includes(value as BrowserWorkspaceDatabaseName)
  )
}

function withControlDb<T>(operation: (db: BrowserWorkspaceControlDb) => Promise<T>): Promise<T> {
  return Dexie.ignoreTransaction(() => {
    const db = new BrowserWorkspaceControlDb()
    return db
      .open()
      .then(() => operation(db))
      .finally(() => db.close())
  })
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
