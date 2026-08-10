import Dexie, {
  type IndexableType,
  type PromiseExtended,
  type Table,
  type Transaction,
} from 'dexie'
import {
  type BrowserWorkspaceCompactionAttemptClaim,
  claimBrowserWorkspaceCompactionAttempt,
} from './browser-workspace-database-control'
import type {
  BrowserWorkspaceCompactionResult,
  BrowserWorkspaceReplacementStart,
} from './browser-workspace-maintenance-contract'

export type { BrowserWorkspaceCompactionResult } from './browser-workspace-maintenance-contract'

import {
  activateBrowserWorkspaceCatchupJournals,
  BROWSER_WORKSPACE_CATCHUP_ACTIVE_ID,
  type BrowserWorkspaceCatchupJournalRow,
  deactivateBrowserWorkspaceCatchupJournals,
} from './browser-workspace-catchup-journal'
import { tryStartBrowserWorkspaceOnlineReplacementIfIdle } from './browser-workspace-replacement-runner'
import { browserWorkspaceSlotSwitchingSupported } from './browser-workspace-slot-coordination'
import { chatSidebarProjectionBackfillMarker } from './chat-sidebar-projection'
import { NatterDb } from './db'
import type { SettingsRow } from './db-rows'
import {
  ALL_PHYSICAL_STORAGE_TABLE_NAMES,
  BROWSER_WORKSPACE_CATCHUP_SOURCE_TABLE_NAMES,
  type BrowserWorkspaceMutationJournalSourceTableName,
  browserWorkspaceCatchupJournalTableName,
  PHYSICAL_STORAGE_POLICY,
  PHYSICAL_STORAGE_TABLE_NAMES,
  type PhysicalStorageTableName,
  settingsCompactionDisposition,
} from './physical-storage-tables'
import {
  awaitStorageCompactionDebtIdle,
  publishStorageCompactionRequest,
  readStorageCompactionState,
} from './storage-compaction-state'
import { estimateStoredValueBytes } from './storage-size-estimate'
import { readBrowserWorkspaceMeta, readBrowserWorkspaceMetaFromTransaction } from './workspace-meta'
import {
  isWorkspaceForegroundDemandInterruptedError,
  isWorkspaceMaintenancePreemptedError,
  type WorkspaceRuntimeActionOptions,
} from './workspace-runtime'

const COMPACTION_COPY_MAX_PAGE_ROWS = 64
const COMPACTION_COPY_MAX_PAGE_BYTES = 1024 * 1024
const COMPACTION_FINAL_CATCHUP_MAX_ROWS = 256
const COMPACTION_FINAL_CATCHUP_MAX_BYTES = 4 * 1024 * 1024

interface BrowserWorkspaceCompactionPrepared {
  readonly sourceWorkspace: {
    readonly workspaceId: string
    readonly replacementEpoch: number
  }
  readonly copied: BrowserWorkspaceCompactionResult
}

class BrowserWorkspaceCompactionCatchupBudgetExceededError extends Error {
  constructor(rows: number, bytes: number) {
    super(`BrowserWorkspaceCompactionCatchupBudgetExceeded:${rows}:${bytes}`)
    this.name = 'BrowserWorkspaceCompactionCatchupBudgetExceededError'
  }
}

type DestinationTransactionRunner = <T>(
  tableNames: readonly string[],
  operation: (transaction: Transaction) => PromiseExtended<T> | T,
) => Promise<T>

export function browserWorkspaceCompactionSupported(): boolean {
  return browserWorkspaceSlotSwitchingSupported()
}

export async function tryStartBrowserWorkspaceCompaction(
  options: WorkspaceRuntimeActionOptions = {},
): Promise<BrowserWorkspaceReplacementStart<BrowserWorkspaceCompactionResult>> {
  if (!browserWorkspaceCompactionSupported()) {
    throw new Error('BrowserWorkspaceCompactionUnsupported')
  }
  const attemptState: { claim: BrowserWorkspaceCompactionAttemptClaim | null } = { claim: null }
  const started = await tryStartBrowserWorkspaceOnlineReplacementIfIdle(
    async (session) => {
      await awaitStorageCompactionDebtIdle()
      const db = await session.open()
      const state = await readStorageCompactionState(db)
      return state.requestRevision > state.attemptedRevision
    },
    {
      prepare: async (destination, context): Promise<BrowserWorkspaceCompactionPrepared> => {
        const checkpoint = async () => {
          await context.awaitForegroundIdle()
          context.preactivationCheckpoint()
        }
        await checkpoint()
        if (context.sourceDatabaseName === context.destinationDatabaseName) {
          throw new Error('BrowserWorkspaceCompactionRequiresSlots')
        }
        const attempt = await claimBrowserWorkspaceCompactionAttempt(context.sourceDatabaseName)
        if (attempt.kind !== 'claimed') {
          throw new Error('BrowserWorkspaceCompactionAttemptAlreadyClaimed')
        }
        attemptState.claim = attempt.claim
        return context.withSourceDatabase(async (source) => {
          await checkpoint()
          await activateBrowserWorkspaceCatchupJournals(source)
          await checkpoint()
          const sourceWorkspace = await readBrowserWorkspaceMeta(source)
          await checkpoint()
          let copied = await copyBrowserWorkspace(
            source,
            destination,
            context.runDestinationTransaction,
            context.signal,
            checkpoint,
            context.foregroundInterruptionSignal,
          )
          copied = await drainBrowserWorkspaceCatchup(
            source,
            context.runDestinationTransaction,
            copied,
            {
              mode: 'online',
              signal: context.signal,
              preactivationCheckpoint: checkpoint,
            },
          )
          return { sourceWorkspace, copied }
        })
      },
      abandon: (sourceDatabaseName) => deactivateSourceCatchupJournals(sourceDatabaseName),
      commit: async (destination, context, prepared) => {
        context.preactivationCheckpoint()
        if (
          context.atomicity !== 'slotted-staging' ||
          context.sourceDatabaseName === context.destinationDatabaseName
        ) {
          throw new Error('BrowserWorkspaceCompactionRequiresSlots')
        }
        return context.mutate((grant) =>
          context.withSourceDatabase(async (source) => {
            const sourceWorkspace = await readBrowserWorkspaceMeta(source)
            if (
              sourceWorkspace.workspaceId !== prepared.sourceWorkspace.workspaceId ||
              sourceWorkspace.replacementEpoch !== prepared.sourceWorkspace.replacementEpoch
            ) {
              throw new Error('BrowserWorkspaceCompactionSourceChanged')
            }
            let copied = await drainBrowserWorkspaceCatchup(
              source,
              (tableNames, operation) => grant.runTransaction(destination, tableNames, operation),
              prepared.copied,
              {
                mode: 'final',
                signal: context.signal,
                preactivationCheckpoint: context.preactivationCheckpoint,
              },
            )
            context.preactivationCheckpoint()
            const copiedWorkspace = await runDestinationCompactionTransaction(
              (tableNames, operation) => grant.runTransaction(destination, tableNames, operation),
              'observe-final-workspace-meta',
              ['workspaceFence'],
              readBrowserWorkspaceMetaFromTransaction,
            )
            if (
              copiedWorkspace.workspaceId !== sourceWorkspace.workspaceId ||
              copiedWorkspace.replacementEpoch !== sourceWorkspace.replacementEpoch
            ) {
              throw new Error('BrowserWorkspaceCompactionCopyChanged')
            }
            await runDestinationCompactionTransaction(
              (tableNames, operation) => grant.runTransaction(destination, tableNames, operation),
              'finalize-workspace-meta',
              ['settings'],
              (tx) =>
                tx
                  .table<SettingsRow, string>('settings')
                  .put(chatSidebarProjectionBackfillMarker()),
            )
            copied = Object.freeze({ ...copied })
            return {
              workspace: copiedWorkspace,
              storageBaseline: { kind: 'carry-source', liveBytes: copied.estimatedLiveBytes },
              value: copied,
            }
          }),
        )
      },
    },
    options,
  )
  if (started.kind !== 'handoff') {
    if (started.kind === 'cleanup-required' && attemptState.claim !== null) {
      const release = await attemptState.claim.release()
      if (release.released) publishStorageCompactionRequest()
    }
    return started
  }
  return {
    kind: 'handoff',
    handoff: {
      completion: started.handoff.completion.catch(async (error: unknown) => {
        if (!isRetryableBrowserWorkspaceCompactionError(error) || attemptState.claim === null) {
          throw error
        }
        const release = await attemptState.claim.release()
        if (release.released) publishStorageCompactionRequest()
        throw error
      }),
    },
  }
}

async function copyBrowserWorkspace(
  source: NatterDb,
  destination: NatterDb,
  runDestinationTransaction: DestinationTransactionRunner,
  signal: AbortSignal,
  preactivationCheckpoint: () => void | Promise<void>,
  foregroundInterruptionSignal: () => AbortSignal,
): Promise<BrowserWorkspaceCompactionResult> {
  assertPhysicalStorageSchema(source)
  assertPhysicalStorageSchema(destination)
  const clearTableNames = PHYSICAL_STORAGE_TABLE_NAMES.filter((name) => {
    const action = PHYSICAL_STORAGE_POLICY[name].compaction
    return action !== 'preserve-destination' && action !== 'seed'
  })
  const copyTableNames = PHYSICAL_STORAGE_TABLE_NAMES.filter((name) => {
    const action = PHYSICAL_STORAGE_POLICY[name].compaction
    return action === 'copy' || action === 'filtered-copy'
  })
  const destinationNames = new Set(destination.tables.map((table) => table.name))
  if (copyTableNames.some((name) => !destinationNames.has(name))) {
    throw new Error('BrowserWorkspaceCompactionSchemaMismatch')
  }
  await preactivationCheckpoint()
  await runDestinationCompactionTransaction(
    runDestinationTransaction,
    'clear-destination',
    clearTableNames,
    (tx) =>
      Dexie.Promise.all(clearTableNames.map((name) => tx.table(name).clear())).then(
        () => undefined,
      ),
  )
  let copiedRows = 0
  let estimatedLiveBytes = 0
  for (const name of copyTableNames) {
    await preactivationCheckpoint()
    const result = await copyTable(
      source,
      name,
      runDestinationTransaction,
      signal,
      preactivationCheckpoint,
      foregroundInterruptionSignal,
    )
    copiedRows = saturatingAdd(copiedRows, result.copiedRows)
    estimatedLiveBytes = saturatingAdd(estimatedLiveBytes, result.estimatedLiveBytes)
  }
  return { copiedRows, estimatedLiveBytes }
}

async function copyTable(
  sourceDb: NatterDb,
  tableName: PhysicalStorageTableName,
  runDestinationTransaction: DestinationTransactionRunner,
  signal: AbortSignal,
  preactivationCheckpoint: () => void | Promise<void>,
  foregroundInterruptionSignal: () => AbortSignal,
): Promise<BrowserWorkspaceCompactionResult> {
  const source = sourceDb.table<unknown, IndexableType>(tableName)
  let after: IndexableType | undefined
  let copiedRows = 0
  let estimatedLiveBytes = 0
  for (;;) {
    await preactivationCheckpoint()
    let page: Awaited<ReturnType<typeof readCopyPage>>
    try {
      page = await readCopyPage(source, after, signal, foregroundInterruptionSignal())
    } catch (error) {
      if (isWorkspaceForegroundDemandInterruptedError(error)) continue
      throw error
    }
    if (page.rows.length === 0) break
    await preactivationCheckpoint()
    const rows = await filterCompactionRows(sourceDb, tableName, page.rows)
    const keyPath = (
      sourceDb.table(tableName).schema.primKey as unknown as {
        readonly keyPath?: string | readonly string[] | null
      }
    ).keyPath
    if (keyPath == null) {
      throw new Error(`BrowserWorkspaceCompactionOutboundPrimaryKey:${tableName}`)
    }
    if (rows.length > 0) {
      await preactivationCheckpoint()
      await runDestinationCompactionTransaction(
        runDestinationTransaction,
        `copy-table:${tableName}`,
        [tableName],
        (tx) => tx.table<unknown, IndexableType>(tableName).bulkPut(rows),
      )
      copiedRows = saturatingAdd(copiedRows, rows.length)
      for (const row of rows) {
        estimatedLiveBytes = saturatingAdd(estimatedLiveBytes, estimateStoredValueBytes(row))
      }
    }
    if (page.lastPrimaryKey === undefined) {
      throw new Error(`BrowserWorkspaceCompactionPrimaryKeyMissing:${source.name}`)
    }
    after = page.lastPrimaryKey
  }
  return { copiedRows, estimatedLiveBytes }
}

async function drainBrowserWorkspaceCatchup(
  source: NatterDb,
  runDestinationTransaction: DestinationTransactionRunner,
  initial: BrowserWorkspaceCompactionResult,
  options: {
    readonly mode: 'online' | 'final'
    readonly signal: AbortSignal
    readonly preactivationCheckpoint: () => void | Promise<void>
  },
): Promise<BrowserWorkspaceCompactionResult> {
  let copiedRows = initial.copiedRows
  let estimatedLiveBytes = initial.estimatedLiveBytes
  let finalRows = 0
  let finalBytes = 0
  for (const tableName of BROWSER_WORKSPACE_CATCHUP_SOURCE_TABLE_NAMES) {
    let after: string | undefined
    for (;;) {
      await options.preactivationCheckpoint()
      const page = await readBrowserWorkspaceCatchupPage(source, tableName, after, options.signal)
      if (page.scannedRows === 0) break
      if (options.mode === 'final') {
        finalRows = saturatingAdd(finalRows, page.entries.length)
        finalBytes = saturatingAdd(finalBytes, page.estimatedBytes)
        if (
          finalRows > COMPACTION_FINAL_CATCHUP_MAX_ROWS ||
          finalBytes > COMPACTION_FINAL_CATCHUP_MAX_BYTES
        ) {
          throw new BrowserWorkspaceCompactionCatchupBudgetExceededError(finalRows, finalBytes)
        }
      }
      const applied = await applyBrowserWorkspaceCatchupPage(
        source,
        tableName,
        page.entries,
        runDestinationTransaction,
        options.preactivationCheckpoint,
      )
      copiedRows = adjustCount(copiedRows, applied.rowDelta)
      estimatedLiveBytes = adjustCount(estimatedLiveBytes, applied.byteDelta)
      if (options.mode === 'online') {
        await options.preactivationCheckpoint()
        await acknowledgeBrowserWorkspaceCatchupPage(source, tableName, page.entries)
      }
      after = page.lastId
      if (after === undefined) {
        throw new Error(`BrowserWorkspaceCatchupPrimaryKeyMissing:${tableName}`)
      }
    }
  }
  return { copiedRows, estimatedLiveBytes }
}

function isRetryableBrowserWorkspaceCompactionError(error: unknown): boolean {
  if (
    isWorkspaceMaintenancePreemptedError(error) ||
    error instanceof BrowserWorkspaceCompactionCatchupBudgetExceededError
  ) {
    return true
  }
  if (error instanceof AggregateError) {
    return error.errors.some(isRetryableBrowserWorkspaceCompactionError)
  }
  return (
    error instanceof Error &&
    error.cause !== undefined &&
    isRetryableBrowserWorkspaceCompactionError(error.cause)
  )
}

async function readBrowserWorkspaceCatchupPage(
  source: NatterDb,
  tableName: BrowserWorkspaceMutationJournalSourceTableName,
  after: string | undefined,
  signal: AbortSignal,
): Promise<{
  readonly entries: readonly {
    readonly journal: BrowserWorkspaceCatchupJournalRow
    readonly sourceValue: unknown
  }[]
  readonly lastId?: string
  readonly scannedRows: number
  readonly estimatedBytes: number
}> {
  if (signal.aborted) throw compactionReadError(signal.reason)
  const journalName = browserWorkspaceCatchupJournalTableName(tableName)
  const backend = source.backendDB() as IDBDatabase | null
  if (!backend) throw new Error('BrowserWorkspaceCompactionSourceClosed')
  return new Promise<{
    readonly entries: readonly {
      readonly journal: BrowserWorkspaceCatchupJournalRow
      readonly sourceValue: unknown
    }[]
    readonly lastId?: string
    readonly scannedRows: number
    readonly estimatedBytes: number
  }>((resolve, reject) => {
    const transaction = backend.transaction([journalName, tableName], 'readonly')
    const journalStore = transaction.objectStore(journalName)
    const sourceStore = transaction.objectStore(tableName)
    const cursorRequest = journalStore.openCursor(
      after === undefined
        ? IDBKeyRange.lowerBound(BROWSER_WORKSPACE_CATCHUP_ACTIVE_ID, true)
        : IDBKeyRange.lowerBound(after, true),
    )
    const rows: BrowserWorkspaceCatchupJournalRow[] = []
    const sourceValues: unknown[] = []
    let sourceReadsScheduled = false
    let settled = false
    const cleanup = () => signal.removeEventListener('abort', abortForLifetime)
    const fail = (error?: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      reject(
        compactionTransactionError(
          `read-catchup:${tableName}`,
          error ??
            cursorRequest.error ??
            transaction.error ??
            new Error('BrowserWorkspaceCompactionCatchupReadFailed'),
        ),
      )
    }
    const abortForLifetime = () => {
      try {
        transaction.abort()
      } catch {
        fail(signal.reason)
        return
      }
      fail(signal.reason)
    }
    const scheduleSourceReads = () => {
      if (sourceReadsScheduled) return
      sourceReadsScheduled = true
      rows.forEach((journal, index) => {
        const request = sourceStore.get(journal.sourceKey as IDBValidKey)
        request.onerror = () => fail(request.error)
        request.onsuccess = () => {
          sourceValues[index] = request.result
        }
      })
    }
    signal.addEventListener('abort', abortForLifetime, { once: true })
    transaction.onerror = () => fail()
    transaction.onabort = () => fail()
    transaction.oncomplete = () => {
      if (settled) return
      try {
        const entries: {
          journal: BrowserWorkspaceCatchupJournalRow
          sourceValue: unknown
        }[] = []
        let estimatedBytes = 0
        let lastId: string | undefined
        for (let index = 0; index < rows.length; index += 1) {
          const journal = rows[index] as BrowserWorkspaceCatchupJournalRow
          const sourceValue = sourceValues[index]
          const rowBytes = sourceValue === undefined ? 0 : estimateStoredValueBytes(sourceValue)
          if (entries.length > 0 && estimatedBytes + rowBytes > COMPACTION_COPY_MAX_PAGE_BYTES) {
            break
          }
          entries.push({ journal, sourceValue })
          estimatedBytes = saturatingAdd(estimatedBytes, rowBytes)
          lastId = journal.id
          if (estimatedBytes >= COMPACTION_COPY_MAX_PAGE_BYTES) break
        }
        settled = true
        cleanup()
        resolve({
          entries,
          ...(lastId === undefined ? {} : { lastId }),
          scannedRows: rows.length,
          estimatedBytes,
        })
      } catch (error) {
        fail(error)
      }
    }
    cursorRequest.onerror = () => fail(cursorRequest.error)
    cursorRequest.onsuccess = () => {
      try {
        const cursor = cursorRequest.result
        if (!cursor || rows.length >= COMPACTION_COPY_MAX_PAGE_ROWS) {
          scheduleSourceReads()
          return
        }
        rows.push(cursor.value as BrowserWorkspaceCatchupJournalRow)
        if (rows.length >= COMPACTION_COPY_MAX_PAGE_ROWS) scheduleSourceReads()
        else cursor.continue()
      } catch (error) {
        fail(error)
        try {
          transaction.abort()
        } catch {
          // The transaction may have already aborted because the callback threw.
        }
      }
    }
  })
}

async function deactivateSourceCatchupJournals(sourceDatabaseName: string): Promise<void> {
  const source = new NatterDb(sourceDatabaseName)
  try {
    await source.open()
    await deactivateBrowserWorkspaceCatchupJournals(source)
  } finally {
    source.close()
  }
}

async function applyBrowserWorkspaceCatchupPage(
  source: NatterDb,
  tableName: BrowserWorkspaceMutationJournalSourceTableName,
  entries: readonly {
    readonly journal: BrowserWorkspaceCatchupJournalRow
    readonly sourceValue: unknown
  }[],
  runDestinationTransaction: DestinationTransactionRunner,
  preactivationCheckpoint: () => void | Promise<void>,
): Promise<{ readonly rowDelta: number; readonly byteDelta: number }> {
  if (entries.length === 0) return { rowDelta: 0, byteDelta: 0 }
  const presentValues = entries.flatMap(({ sourceValue }) =>
    sourceValue === undefined ? [] : [sourceValue],
  )
  await preactivationCheckpoint()
  const retainedValues = new Set(await filterCompactionRows(source, tableName, presentValues))
  const keys = entries.map(({ journal }) => journal.sourceKey as IndexableType)
  await preactivationCheckpoint()
  const previous = await runDestinationCompactionTransaction(
    runDestinationTransaction,
    `observe-catchup:${tableName}`,
    [tableName],
    (tx) => tx.table<unknown, IndexableType>(tableName).bulkGet(keys),
  )
  const puts: unknown[] = []
  const deletes: IndexableType[] = []
  let rowDelta = 0
  let byteDelta = 0
  entries.forEach(({ journal, sourceValue }, index) => {
    const prior = previous[index]
    const next =
      sourceValue !== undefined && retainedValues.has(sourceValue) ? sourceValue : undefined
    if (next === undefined) deletes.push(journal.sourceKey as IndexableType)
    else puts.push(next)
    if (prior === undefined && next !== undefined) rowDelta += 1
    else if (prior !== undefined && next === undefined) rowDelta -= 1
    byteDelta +=
      (next === undefined ? 0 : estimateStoredValueBytes(next)) -
      (prior === undefined ? 0 : estimateStoredValueBytes(prior))
  })
  await preactivationCheckpoint()
  return runDestinationCompactionTransaction(
    runDestinationTransaction,
    `apply-catchup:${tableName}`,
    [tableName],
    (tx) => {
      const table = tx.table<unknown, IndexableType>(tableName)
      const writes: PromiseExtended<unknown>[] = []
      if (puts.length > 0) writes.push(table.bulkPut(puts))
      if (deletes.length > 0) writes.push(table.bulkDelete(deletes))
      return Dexie.Promise.all(writes).then(() => ({ rowDelta, byteDelta }))
    },
  )
}

async function acknowledgeBrowserWorkspaceCatchupPage(
  source: NatterDb,
  tableName: BrowserWorkspaceMutationJournalSourceTableName,
  entries: readonly {
    readonly journal: BrowserWorkspaceCatchupJournalRow
  }[],
): Promise<void> {
  if (entries.length === 0) return
  const journalName = browserWorkspaceCatchupJournalTableName(tableName)
  const backend = source.backendDB() as IDBDatabase | null
  if (!backend) throw new Error('BrowserWorkspaceCompactionSourceClosed')
  await new Promise<void>((resolve, reject) => {
    const transaction = backend.transaction(journalName, 'readwrite')
    const store = transaction.objectStore(journalName)
    let settled = false
    const fail = (error?: unknown) => {
      if (settled) return
      settled = true
      reject(
        compactionTransactionError(
          `acknowledge-catchup:${tableName}`,
          error ?? transaction.error ?? new Error('BrowserWorkspaceCompactionCatchupAckFailed'),
        ),
      )
    }
    transaction.onerror = () => fail()
    transaction.onabort = () => fail()
    transaction.oncomplete = () => {
      if (settled) return
      settled = true
      resolve()
    }
    for (const { journal } of entries) {
      const request = store.get(journal.id)
      request.onerror = () => fail(request.error)
      request.onsuccess = () => {
        try {
          const current = request.result as BrowserWorkspaceCatchupJournalRow | undefined
          if (current?.revision !== journal.revision) return
          const deletion = store.delete(journal.id)
          deletion.onerror = () => fail(deletion.error)
        } catch (error) {
          fail(error)
          try {
            transaction.abort()
          } catch {
            return
          }
        }
      }
    }
  })
}

function runDestinationCompactionTransaction<T>(
  run: DestinationTransactionRunner,
  stage: string,
  tableNames: readonly string[],
  operation: (transaction: Transaction) => PromiseExtended<T> | T,
): Promise<T> {
  return run(tableNames, operation).catch((error: unknown) => {
    throw compactionTransactionError(stage, error)
  })
}

function compactionTransactionError(stage: string, reason: unknown): Error {
  const error = compactionReadError(reason)
  return new Error(
    `BrowserWorkspaceCompactionTransactionFailed:${stage}:${error.name}:${error.message}`,
    { cause: error },
  )
}

async function filterCompactionRows(
  source: NatterDb,
  tableName: PhysicalStorageTableName,
  rows: readonly unknown[],
): Promise<unknown[]> {
  if (PHYSICAL_STORAGE_POLICY[tableName].compaction !== 'filtered-copy') return [...rows]
  if (tableName === 'settings') {
    return rows.filter((value) => {
      const row = value as Partial<SettingsRow>
      if (typeof row.key !== 'string') throw new Error('BrowserWorkspaceCompactionSettingInvalid')
      const disposition = settingsCompactionDisposition(row.key)
      if (disposition === 'unknown') {
        throw new Error(`BrowserWorkspaceCompactionSettingPolicyMissing:${row.key}`)
      }
      return disposition === 'copy'
    })
  }
  if (
    tableName !== 'attachmentArtifacts' &&
    tableName !== 'attachmentBlobs' &&
    tableName !== 'attachmentJobs'
  ) {
    throw new Error(`BrowserWorkspaceCompactionFilterMissing:${tableName}`)
  }
  const attachmentIds = rows.map((value) => {
    const attachmentId = (value as { readonly attachmentId?: unknown }).attachmentId
    if (typeof attachmentId !== 'string') {
      throw new Error(`BrowserWorkspaceCompactionAttachmentOwnerInvalid:${tableName}`)
    }
    return attachmentId
  })
  const owners = await source.attachments.bulkGet(attachmentIds)
  return rows.filter((_row, index) => owners[index] !== undefined)
}

function assertPhysicalStorageSchema(db: NatterDb): void {
  const actual = new Set(db.tables.map((table) => table.name))
  const expected = new Set<string>(ALL_PHYSICAL_STORAGE_TABLE_NAMES)
  const missing = ALL_PHYSICAL_STORAGE_TABLE_NAMES.filter((name) => !actual.has(name))
  const unexpected = [...actual].filter((name) => !expected.has(name))
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `BrowserWorkspaceCompactionPolicySchemaMismatch:missing=${missing.join(',')}:unexpected=${unexpected.join(',')}`,
    )
  }
}

function readCopyPage(
  source: Table<unknown, IndexableType>,
  after: IndexableType | undefined,
  signal: AbortSignal,
  foregroundInterruptionSignal: AbortSignal,
): Promise<{
  readonly rows: unknown[]
  readonly primaryKeys: IndexableType[]
  readonly lastPrimaryKey?: IndexableType
  readonly estimatedBytes: number
}> {
  if (signal.aborted) return Promise.reject(compactionReadError(signal.reason))
  if (foregroundInterruptionSignal.aborted) {
    return Promise.reject(compactionReadError(foregroundInterruptionSignal.reason))
  }
  const backend = source.db.backendDB() as IDBDatabase | null
  if (!backend) throw new Error('BrowserWorkspaceCompactionSourceClosed')
  return new Promise((resolve, reject) => {
    const transaction = backend.transaction(source.name, 'readonly')
    const store = transaction.objectStore(source.name)
    const request = store.openCursor(
      after === undefined ? undefined : IDBKeyRange.lowerBound(after, true),
    )
    const rows: unknown[] = []
    const primaryKeys: IndexableType[] = []
    let estimatedBytes = 0
    let settled = false
    const cleanup = () => {
      signal.removeEventListener('abort', abortForLifetime)
      foregroundInterruptionSignal.removeEventListener('abort', abortForForegroundDemand)
    }
    const finish = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve({
        rows,
        primaryKeys,
        ...(primaryKeys.at(-1) === undefined
          ? {}
          : { lastPrimaryKey: primaryKeys.at(-1) as IndexableType }),
        estimatedBytes,
      })
    }
    const fail = (error?: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      reject(
        compactionReadError(
          error ??
            request.error ??
            transaction.error ??
            new Error('BrowserWorkspaceCompactionReadFailed'),
        ),
      )
    }
    const abort = (reason: unknown) => {
      try {
        transaction.abort()
      } catch {
        fail(reason)
        return
      }
      fail(reason)
    }
    const abortForLifetime = () => abort(signal.reason)
    const abortForForegroundDemand = () => abort(foregroundInterruptionSignal.reason)
    signal.addEventListener('abort', abortForLifetime, { once: true })
    foregroundInterruptionSignal.addEventListener('abort', abortForForegroundDemand, {
      once: true,
    })
    transaction.onerror = () => fail()
    transaction.onabort = () => fail()
    transaction.oncomplete = finish
    request.onerror = () => fail()
    request.onsuccess = () => {
      try {
        const cursor = request.result
        if (!cursor) return
        const rowBytes = estimateStoredValueBytes(cursor.value)
        if (
          rows.length > 0 &&
          (rows.length >= COMPACTION_COPY_MAX_PAGE_ROWS ||
            estimatedBytes + rowBytes > COMPACTION_COPY_MAX_PAGE_BYTES)
        ) {
          return
        }
        rows.push(cursor.value)
        primaryKeys.push(cursor.primaryKey as IndexableType)
        estimatedBytes = saturatingAdd(estimatedBytes, rowBytes)
        if (
          rows.length >= COMPACTION_COPY_MAX_PAGE_ROWS ||
          estimatedBytes >= COMPACTION_COPY_MAX_PAGE_BYTES
        ) {
          return
        }
        cursor.continue()
      } catch (error) {
        fail(error)
        try {
          transaction.abort()
        } catch {
          // The transaction may have already aborted because the callback threw.
        }
      }
    }
  })
}

function compactionReadError(reason: unknown): Error {
  return reason instanceof Error
    ? reason
    : new Error('BrowserWorkspaceCompactionReadFailed', { cause: reason })
}

function saturatingAdd(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right)
}

function adjustCount(current: number, delta: number): number {
  return Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, current + delta))
}
