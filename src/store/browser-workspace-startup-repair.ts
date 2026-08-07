import Dexie from 'dexie'
import { errorFromUnknown, errorHasName } from '../lib/error'
import type { BrowserWorkspaceDatabaseName } from '../lib/origin-storage-names'
import { probeBrowserWorkspaceCurrent } from './browser-workspace-current-probe'
import { cleanPendingBrowserWorkspaceDatabase } from './browser-workspace-database-cleanup'
import {
  abandonPreparedBrowserWorkspaceDatabase,
  activatePreparedBrowserWorkspaceDatabase,
  type BrowserWorkspaceReplacementPreparing,
  completeBrowserWorkspaceDatabaseCleanup,
  readBrowserWorkspaceDatabaseManifest,
  tryBeginBrowserWorkspaceDatabaseReplacement,
} from './browser-workspace-database-control'
import type { BrowserWorkspaceOpenProgress } from './browser-workspace-open-contract'
import {
  browserWorkspaceSlotSwitchingSupported,
  postBrowserWorkspaceSlotQuiesce,
  withBrowserWorkspaceSelectionGate,
  withBrowserWorkspaceSlotProbe,
  withBrowserWorkspaceSlotVersionChange,
  withExclusiveBrowserWorkspaceSlots,
} from './browser-workspace-slot-coordination'
import { CURRENT_BROWSER_WORKSPACE_STORAGE_EPOCH } from './browser-workspace-upgrade-strategy'
import {
  normalizeInactiveBrowserWorkspaceDatabase,
  recreateAndVerifyBrowserWorkspaceDatabase,
  upgradeRegisteredBrowserWorkspaceDatabase,
} from './db'
import {
  CANONICAL_PHYSICAL_STORAGE_TABLE_NAMES,
  type PhysicalStorageTableName,
} from './physical-storage-tables'
import { estimateStoredValueBytes } from './storage-size-estimate'

const STARTUP_COPY_MAX_PAGE_ROWS = 64
const STARTUP_COPY_MAX_PAGE_BYTES = 1024 * 1024

interface StartupCopyEntry {
  readonly key: IDBValidKey
  readonly value: unknown
}

interface StartupCopyPage {
  readonly entries: readonly StartupCopyEntry[]
  readonly estimatedBytes: number
  readonly complete: boolean
}

export interface BrowserWorkspaceCurrentSelectionProof {
  readonly databaseName: BrowserWorkspaceDatabaseName
  readonly activationSequence: number
  readonly physicalVersion: number
}

export async function ensureBrowserWorkspaceCurrentForSelection(
  signal: AbortSignal,
  onProgress?: (progress: BrowserWorkspaceOpenProgress) => void,
  onBlocked?: (event: IDBVersionChangeEvent) => void,
): Promise<BrowserWorkspaceCurrentSelectionProof> {
  if (signal.aborted) throw signal.reason
  const committed = await runStartupRepairStage('read-committed-manifest', () =>
    readBrowserWorkspaceDatabaseManifest(),
  )
  const committedProbe = await withBrowserWorkspaceSlotProbe(
    committed.activeDatabaseName,
    () =>
      runStartupRepairStage('probe-committed-database', () =>
        probeBrowserWorkspaceCurrent(committed.activeDatabaseName),
      ),
    signal,
  )
  if (committedProbe.kind === 'current') {
    return {
      databaseName: committed.activeDatabaseName,
      activationSequence: committed.activationSequence,
      physicalVersion: committedProbe.physicalVersion,
    }
  }
  if (committedProbe.kind === 'future') {
    throw new Error(
      `BrowserWorkspaceSchemaIntegrity:future-version:${committedProbe.physicalVersion}`,
    )
  }
  if (committedProbe.kind === 'strategy-missing') {
    throw new Error(
      `BrowserWorkspaceSchemaIntegrity:upgrade-strategy-missing:${committedProbe.physicalVersion}:${CURRENT_BROWSER_WORKSPACE_STORAGE_EPOCH.physicalVersion}`,
    )
  }
  if (committedProbe.kind === 'absent' && !committed.pending) {
    return {
      databaseName: committed.activeDatabaseName,
      activationSequence: committed.activationSequence,
      physicalVersion: CURRENT_BROWSER_WORKSPACE_STORAGE_EPOCH.physicalVersion,
    }
  }
  await runStartupRepairStage('settle-pending-replacement', () =>
    settlePendingBrowserWorkspaceReplacement(signal),
  )
  return withBrowserWorkspaceSelectionGate(async () => {
    if (signal.aborted) throw signal.reason
    const manifest = await runStartupRepairStage('read-gated-manifest', () =>
      readBrowserWorkspaceDatabaseManifest(),
    )
    if (manifest.pending) throw new Error('BrowserWorkspaceStartupRepairJournalOccupied')
    const probe = await withBrowserWorkspaceSlotVersionChange(
      manifest.activeDatabaseName,
      async () => {
        const observed = await runStartupRepairStage('probe-gated-database', () =>
          probeBrowserWorkspaceCurrent(manifest.activeDatabaseName),
        )
        if (observed.kind !== 'upgrade-required') return observed
        await upgradeRegisteredBrowserWorkspaceDatabase(manifest.activeDatabaseName, {
          expectedPhysicalVersion: observed.physicalVersion,
          signal,
          ...(onProgress ? { onProgress } : {}),
          ...(onBlocked ? { onBlocked } : {}),
        })
        const upgraded = await probeBrowserWorkspaceCurrent(manifest.activeDatabaseName)
        if (upgraded.kind !== 'current') {
          throw new Error(`BrowserWorkspaceRegisteredUpgradeIncomplete:${upgraded.kind}`)
        }
        return upgraded
      },
      signal,
    )
    if (probe.kind === 'absent') {
      return {
        databaseName: manifest.activeDatabaseName,
        activationSequence: manifest.activationSequence,
        physicalVersion: CURRENT_BROWSER_WORKSPACE_STORAGE_EPOCH.physicalVersion,
      }
    }
    if (probe.kind === 'current') {
      return {
        databaseName: manifest.activeDatabaseName,
        activationSequence: manifest.activationSequence,
        physicalVersion: probe.physicalVersion,
      }
    }
    if (probe.kind === 'future') {
      throw new Error(`BrowserWorkspaceSchemaIntegrity:future-version:${probe.physicalVersion}`)
    }
    if (probe.kind === 'strategy-missing') {
      throw new Error(
        `BrowserWorkspaceSchemaIntegrity:upgrade-strategy-missing:${probe.physicalVersion}:${CURRENT_BROWSER_WORKSPACE_STORAGE_EPOCH.physicalVersion}`,
      )
    }
    if (!browserWorkspaceSlotSwitchingSupported()) {
      throw new Error('BrowserWorkspaceStartupRepairRequiresSlotCoordination')
    }

    const begin = await runStartupRepairStage('begin-replacement', () =>
      tryBeginBrowserWorkspaceDatabaseReplacement(),
    )
    if (begin.kind === 'occupied') throw new Error('BrowserWorkspaceStartupRepairJournalOccupied')
    const journal = begin.journal
    postBrowserWorkspaceSlotQuiesce(journal)
    const activation = { completed: false }
    try {
      await runStartupRepairStage('exclusive-slot-repair', () =>
        withExclusiveBrowserWorkspaceSlots(
          [journal.sourceDatabaseName, journal.destinationDatabaseName],
          async () => {
            const copied = await prepareInactiveBrowserWorkspaceRepair(
              journal,
              probe.physicalVersion,
              signal,
              onProgress,
            )
            if (signal.aborted) throw signal.reason
            onProgress?.({
              kind: 'database-upgrade',
              databaseName: journal.destinationDatabaseName,
              fromVersion: probe.physicalVersion / 10,
              targetVersion: CURRENT_BROWSER_WORKSPACE_STORAGE_EPOCH.storageVersion,
              phase: 'inactive-activation',
              operation: 'activate-repaired-destination',
              processedRows: copied.copiedRows,
              processedBytes: copied.estimatedLiveBytes,
            })
            await activatePreparedBrowserWorkspaceDatabase(journal, {
              kind: 'carry-source',
              liveBytes: copied.estimatedLiveBytes,
            })
            activation.completed = true
            await Dexie.delete(journal.sourceDatabaseName)
            await completeBrowserWorkspaceDatabaseCleanup({ ...journal, phase: 'cleanup' })
          },
          signal,
        ),
      )
    } catch (error) {
      if (activation.completed) throw error
      throw await discardFailedStartupRepair(journal, error, signal)
    }
    const repairedManifest = await readBrowserWorkspaceDatabaseManifest()
    const repaired = await probeBrowserWorkspaceCurrent(repairedManifest.activeDatabaseName)
    if (repaired.kind !== 'current') {
      throw new Error(`BrowserWorkspaceStartupRepairSelectionIncomplete:${repaired.kind}`)
    }
    return {
      databaseName: repairedManifest.activeDatabaseName,
      activationSequence: repairedManifest.activationSequence,
      physicalVersion: repaired.physicalVersion,
    }
  }, signal)
}

async function settlePendingBrowserWorkspaceReplacement(signal: AbortSignal): Promise<void> {
  for (;;) {
    if (signal.aborted) throw signal.reason
    const cleanup = await cleanPendingBrowserWorkspaceDatabase(signal)
    if (cleanup.status === 'none') return
    if (cleanup.status === 'preparing') {
      await withBrowserWorkspaceSelectionGate(() => Promise.resolve(), signal)
    }
  }
}

async function discardFailedStartupRepair(
  journal: BrowserWorkspaceReplacementPreparing,
  failure: unknown,
  signal: AbortSignal,
): Promise<Error> {
  const errors: unknown[] = [failure]
  try {
    await abandonPreparedBrowserWorkspaceDatabase(journal)
    await cleanPendingBrowserWorkspaceDatabase(signal)
  } catch (cleanupError) {
    errors.push(cleanupError)
  }
  return errors.length === 1
    ? errorFromUnknown(failure)
    : new AggregateError(errors, 'BrowserWorkspaceStartupRepairFailedAndCleanupFailed', {
        cause: failure,
      })
}

async function prepareInactiveBrowserWorkspaceRepair(
  journal: BrowserWorkspaceReplacementPreparing,
  sourcePhysicalVersion: number,
  signal: AbortSignal,
  onProgress?: (progress: BrowserWorkspaceOpenProgress) => void,
): Promise<{ readonly copiedRows: number; readonly estimatedLiveBytes: number }> {
  await runStartupRepairStage('recreate-destination-delete', () =>
    Dexie.delete(journal.destinationDatabaseName),
  )
  await runStartupRepairStage('recreate-destination-open', () =>
    recreateAndVerifyBrowserWorkspaceDatabase(journal.destinationDatabaseName),
  )
  const copied = await runStartupRepairStage('copy-canonical-rows', () =>
    copyCanonicalBrowserWorkspaceRows(
      journal.sourceDatabaseName,
      journal.destinationDatabaseName,
      sourcePhysicalVersion,
      signal,
      onProgress,
    ),
  )
  await runStartupRepairStage('normalize-destination', () =>
    normalizeInactiveBrowserWorkspaceDatabase(journal.destinationDatabaseName, {
      fromVersion: sourcePhysicalVersion,
      ...(onProgress ? { onProgress } : {}),
    }),
  )
  const repaired = await runStartupRepairStage('verify-destination', () =>
    probeBrowserWorkspaceCurrent(journal.destinationDatabaseName),
  )
  if (repaired.kind !== 'current') {
    throw new Error(`BrowserWorkspaceStartupRepairIncomplete:${repaired.kind}`)
  }
  return copied
}

async function runStartupRepairStage<Result>(
  operation: string,
  run: () => Promise<Result>,
): Promise<Result> {
  try {
    return await run()
  } catch (error) {
    if (errorHasName(error, 'TransactionInactiveError')) {
      const diagnostic = new Error(
        `BrowserWorkspaceStartupRepairTransactionInactive:${operation}`,
        {
          cause: error,
        },
      )
      diagnostic.name = `BrowserWorkspaceStartupRepairTransactionInactiveError_${operation}`
      throw diagnostic
    }
    throw error
  }
}

async function copyCanonicalBrowserWorkspaceRows(
  sourceDatabaseName: BrowserWorkspaceDatabaseName,
  destinationDatabaseName: BrowserWorkspaceDatabaseName,
  sourcePhysicalVersion: number,
  signal: AbortSignal,
  onProgress?: (progress: BrowserWorkspaceOpenProgress) => void,
): Promise<{ readonly copiedRows: number; readonly estimatedLiveBytes: number }> {
  const source = await openRawDatabase(sourceDatabaseName)
  const destination = await openRawDatabase(destinationDatabaseName)
  let copiedRows = 0
  let estimatedLiveBytes = 0
  try {
    const sourceNames = new Set([...source.objectStoreNames])
    const destinationNames = [...destination.objectStoreNames]
    await clearRawDatabase(destination, destinationNames)
    for (const tableName of CANONICAL_PHYSICAL_STORAGE_TABLE_NAMES) {
      if (signal.aborted) throw signal.reason
      if (!sourceNames.has(tableName) || !destination.objectStoreNames.contains(tableName)) continue
      let after: IDBValidKey | undefined
      for (;;) {
        signal.throwIfAborted()
        const page = await readRawPage(source, tableName, after)
        if (page.entries.length > 0) {
          await writeRawPage(destination, tableName, page.entries)
          copiedRows = saturatingAdd(copiedRows, page.entries.length)
          estimatedLiveBytes = saturatingAdd(estimatedLiveBytes, page.estimatedBytes)
          after = page.entries.at(-1)?.key
          onProgress?.({
            kind: 'database-upgrade',
            databaseName: destinationDatabaseName,
            fromVersion: sourcePhysicalVersion / 10,
            targetVersion: CURRENT_BROWSER_WORKSPACE_STORAGE_EPOCH.storageVersion,
            phase: 'inactive-copy',
            operation: `copy-${tableName}`,
            processedRows: copiedRows,
            processedBytes: estimatedLiveBytes,
          })
        }
        if (page.complete) break
        if (after === undefined)
          throw new Error(`BrowserWorkspaceStartupCopyCursorMissing:${tableName}`)
      }
    }
    return { copiedRows, estimatedLiveBytes }
  } finally {
    source.close()
    destination.close()
  }
}

function openRawDatabase(databaseName: BrowserWorkspaceDatabaseName): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () =>
      reject(request.error ?? new Error(`BrowserWorkspaceRawOpenFailed:${databaseName}`))
  })
}

function clearRawDatabase(database: IDBDatabase, tableNames: readonly string[]): Promise<void> {
  if (tableNames.length === 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([...tableNames], 'readwrite')
    for (const tableName of tableNames) transaction.objectStore(tableName).clear()
    transaction.oncomplete = () => resolve()
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('BrowserWorkspaceStartupClearFailed'))
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('BrowserWorkspaceStartupClearAborted'))
  })
}

function readRawPage(
  database: IDBDatabase,
  tableName: PhysicalStorageTableName,
  after?: IDBValidKey,
): Promise<StartupCopyPage> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(tableName, 'readonly')
    const entries: StartupCopyEntry[] = []
    let estimatedBytes = 0
    let complete = false
    let failed = false
    const request = transaction
      .objectStore(tableName)
      .openCursor(after === undefined ? null : IDBKeyRange.lowerBound(after, true))
    request.onsuccess = () => {
      if (failed) return
      const cursor = request.result
      if (!cursor) {
        complete = true
        return
      }
      const rowBytes = estimateStoredValueBytes(cursor.value)
      if (
        entries.length > 0 &&
        (entries.length >= STARTUP_COPY_MAX_PAGE_ROWS ||
          estimatedBytes + rowBytes > STARTUP_COPY_MAX_PAGE_BYTES)
      ) {
        return
      }
      entries.push({ key: cursor.primaryKey, value: cursor.value })
      estimatedBytes = saturatingAdd(estimatedBytes, rowBytes)
      if (
        entries.length >= STARTUP_COPY_MAX_PAGE_ROWS ||
        estimatedBytes >= STARTUP_COPY_MAX_PAGE_BYTES
      ) {
        return
      }
      cursor.continue()
    }
    request.onerror = () => {
      failed = true
      reject(request.error ?? new Error(`BrowserWorkspaceStartupReadFailed:${tableName}`))
    }
    transaction.oncomplete = () => {
      if (!failed) resolve({ entries, estimatedBytes, complete })
    }
    transaction.onerror = () => {
      failed = true
      reject(transaction.error ?? new Error(`BrowserWorkspaceStartupReadFailed:${tableName}`))
    }
    transaction.onabort = () => {
      failed = true
      reject(transaction.error ?? new Error(`BrowserWorkspaceStartupReadAborted:${tableName}`))
    }
  })
}

function writeRawPage(
  database: IDBDatabase,
  tableName: PhysicalStorageTableName,
  entries: readonly StartupCopyEntry[],
): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(tableName, 'readwrite')
    const store = transaction.objectStore(tableName)
    for (const entry of entries) {
      if (store.keyPath === null) store.put(entry.value, entry.key)
      else store.put(entry.value)
    }
    transaction.oncomplete = () => resolve()
    transaction.onerror = () =>
      reject(transaction.error ?? new Error(`BrowserWorkspaceStartupWriteFailed:${tableName}`))
    transaction.onabort = () =>
      reject(transaction.error ?? new Error(`BrowserWorkspaceStartupWriteAborted:${tableName}`))
  })
}

function saturatingAdd(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right)
}
