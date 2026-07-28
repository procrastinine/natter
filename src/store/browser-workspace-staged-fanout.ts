import type { IndexableType, Table, Transaction } from 'dexie'
import type {
  BrowserStagedCommandConflictEvidence,
  BrowserStagedCommandExecution,
} from './browser-staged-fanout-command'
import {
  activateBrowserWorkspaceCatchupJournals,
  BROWSER_WORKSPACE_CATCHUP_ACTIVE_ID,
  type BrowserWorkspaceCatchupJournalRow,
  deactivateBrowserWorkspaceCatchupJournals,
} from './browser-workspace-catchup-journal'
import type { BrowserWorkspaceOnlineReplacementOperation } from './browser-workspace-contract'
import type { BrowserWorkspaceReplacementStart } from './browser-workspace-maintenance-contract'
import {
  runBrowserWorkspaceOnlineReplacement,
  startBrowserWorkspaceOnlineReplacement,
} from './browser-workspace-replacement-runner'
import { type BrowserWorkspaceSession, NatterDb } from './db'
import {
  BROWSER_WORKSPACE_CATCHUP_JOURNAL_TABLE_NAMES,
  BROWSER_WORKSPACE_MUTATION_JOURNAL_SOURCE_TABLE_NAMES,
  type BrowserWorkspaceMutationJournalSourceTableName,
  browserWorkspaceCatchupJournalTableName,
  encodePhysicalStorageKey,
  PHYSICAL_STORAGE_TABLE_NAMES,
  physicalStorageMutationAddress,
} from './physical-storage-tables'
import type { WorkspaceFence } from './repository'
import { estimateStoredValueBytes } from './storage-size-estimate'
import { readBrowserWorkspaceMeta } from './workspace-meta'
import type {
  CommitEnvelope,
  WorkspaceCommand,
  WorkspaceCommandResult,
  WorkspaceWriteAuthority,
} from './workspace-protocol'

const STAGED_COPY_MAX_PAGE_ROWS = 64
const STAGED_COPY_MAX_PAGE_BYTES = 1024 * 1024
const STAGED_FINAL_CATCHUP_MAX_ROWS = 256
const STAGED_FINAL_CATCHUP_MAX_BYTES = 4 * 1024 * 1024

const STAGED_COPY_TABLE_NAMES = Object.freeze(
  PHYSICAL_STORAGE_TABLE_NAMES.filter(
    (tableName) => tableName !== 'browserLocks' && tableName !== 'workspaceFence',
  ),
)

interface StagedFanoutPrepared {
  readonly sourceWorkspace: WorkspaceFence
  readonly estimatedLiveBytes: number
  readonly execution: BrowserStagedCommandExecution<WorkspaceCommand>
}

type DestinationTransactionRunner = <T>(
  tableNames: readonly string[],
  operation: (transaction: Transaction) => Promise<T> | T,
) => Promise<T>

type BrowserStagedCommandExecutor = <C extends WorkspaceCommand>(
  database: NatterDb,
  workspace: WorkspaceFence,
  command: C,
) => Promise<BrowserStagedCommandExecution<C>>

export async function executeBrowserWorkspaceStagedFanoutCommand<C extends WorkspaceCommand>(
  permit: WorkspaceWriteAuthority,
  command: C,
  executeBrowserCommandInStagedDatabase: BrowserStagedCommandExecutor,
): Promise<CommitEnvelope<WorkspaceCommandResult<C>>> {
  const committed = await runBrowserWorkspaceOnlineReplacement(
    stagedFanoutPreflight(permit),
    stagedFanoutOperation(permit, command, executeBrowserCommandInStagedDatabase),
    { signal: permit.signal, lineageId: permit.lineageId },
  )
  return committed.value
}

export function startBrowserWorkspaceStagedFanoutCommand<C extends WorkspaceCommand>(
  permit: WorkspaceWriteAuthority,
  command: C,
  executeBrowserCommandInStagedDatabase: BrowserStagedCommandExecutor,
): Promise<BrowserWorkspaceReplacementStart<CommitEnvelope<WorkspaceCommandResult<C>>>> {
  return startBrowserWorkspaceOnlineReplacement(
    stagedFanoutPreflight(permit),
    stagedFanoutOperation(permit, command, executeBrowserCommandInStagedDatabase),
    { signal: permit.signal, lineageId: permit.lineageId },
  )
}

function stagedFanoutPreflight(permit: WorkspaceWriteAuthority) {
  return (session: BrowserWorkspaceSession): boolean => {
    const workspace = session.getWorkspaceFence()
    return (
      workspace.workspaceId === permit.workspaceId &&
      workspace.replacementEpoch === permit.replacementEpoch
    )
  }
}

function stagedFanoutOperation<C extends WorkspaceCommand>(
  permit: WorkspaceWriteAuthority,
  command: C,
  executeBrowserCommandInStagedDatabase: BrowserStagedCommandExecutor,
): BrowserWorkspaceOnlineReplacementOperation<
  StagedFanoutPrepared,
  CommitEnvelope<WorkspaceCommandResult<C>>
> {
  return {
    prepare: async (destination, context): Promise<StagedFanoutPrepared> => {
      context.preactivationCheckpoint()
      return context.withSourceDatabase(async (source) => {
        await activateBrowserWorkspaceCatchupJournals(source)
        const sourceWorkspace = await readBrowserWorkspaceMeta(source)
        assertWorkspaceFence(sourceWorkspace, permit)
        const estimatedLiveBytes = await copyStagedWorkspace(
          source,
          destination,
          context.runDestinationTransaction,
          context.signal,
          context.preactivationCheckpoint,
        )
        const caughtUp = await drainStagedWorkspaceCatchup(
          source,
          context.runDestinationTransaction,
          estimatedLiveBytes,
          {
            mode: 'online',
            signal: context.signal,
            preactivationCheckpoint: context.preactivationCheckpoint,
          },
        )
        const execution = await executeBrowserCommandInStagedDatabase(
          destination,
          sourceWorkspace,
          command,
        )
        const commandCaughtUp = await drainStagedWorkspaceCatchup(
          source,
          context.runDestinationTransaction,
          caughtUp,
          {
            mode: 'online',
            signal: context.signal,
            preactivationCheckpoint: context.preactivationCheckpoint,
            conflictEvidence: execution.conflictEvidence,
          },
        )
        return {
          sourceWorkspace,
          estimatedLiveBytes: commandCaughtUp,
          execution: execution,
        }
      })
    },
    abandon: (sourceDatabaseName) => deactivateSourceCatchupJournals(sourceDatabaseName),
    commit: (destination, context, prepared) =>
      context.mutate((grant) =>
        context.withSourceDatabase(async (source) => {
          const sourceWorkspace = await readBrowserWorkspaceMeta(source)
          assertSameWorkspaceFence(sourceWorkspace, prepared.sourceWorkspace)
          const estimatedLiveBytes = await drainStagedWorkspaceCatchup(
            source,
            (tableNames, operation) => grant.runTransaction(destination, tableNames, operation),
            prepared.estimatedLiveBytes,
            {
              mode: 'final',
              signal: context.signal,
              preactivationCheckpoint: context.preactivationCheckpoint,
              conflictEvidence: prepared.execution.conflictEvidence,
            },
          )
          await grant.runTransaction(
            destination,
            BROWSER_WORKSPACE_CATCHUP_JOURNAL_TABLE_NAMES,
            (tx) =>
              Promise.all(
                BROWSER_WORKSPACE_CATCHUP_JOURNAL_TABLE_NAMES.map((tableName) =>
                  tx.table(tableName).clear(),
                ),
              ).then(() => undefined),
          )
          return {
            workspace: sourceWorkspace,
            storageBaseline: { kind: 'carry-source', liveBytes: estimatedLiveBytes },
            publication: 'deferred' as const,
            value: prepared.execution.commit as CommitEnvelope<WorkspaceCommandResult<C>>,
          }
        }),
      ),
  }
}

async function copyStagedWorkspace(
  source: NatterDb,
  destination: NatterDb,
  runDestinationTransaction: DestinationTransactionRunner,
  signal: AbortSignal,
  preactivationCheckpoint: () => void,
): Promise<number> {
  assertStagedSchema(source)
  assertStagedSchema(destination)
  preactivationCheckpoint()
  await runDestinationTransaction(STAGED_COPY_TABLE_NAMES, (tx) =>
    Promise.all(STAGED_COPY_TABLE_NAMES.map((tableName) => tx.table(tableName).clear())).then(
      () => undefined,
    ),
  )
  let estimatedLiveBytes = 0
  for (const tableName of STAGED_COPY_TABLE_NAMES) {
    let after: IndexableType | undefined
    for (;;) {
      preactivationCheckpoint()
      const page = await readStagedCopyPage(source.table(tableName), after, signal)
      if (page.rows.length === 0) break
      await runDestinationTransaction([tableName], (tx) => tx.table(tableName).bulkPut(page.rows))
      estimatedLiveBytes = saturatingAdd(estimatedLiveBytes, page.estimatedBytes)
      if (page.lastPrimaryKey === undefined) {
        throw new Error(`BrowserWorkspaceStagedCopyPrimaryKeyMissing:${tableName}`)
      }
      after = page.lastPrimaryKey
    }
  }
  return estimatedLiveBytes
}

async function drainStagedWorkspaceCatchup(
  source: NatterDb,
  runDestinationTransaction: DestinationTransactionRunner,
  initialEstimatedLiveBytes: number,
  options: {
    readonly mode: 'online' | 'final'
    readonly signal: AbortSignal
    readonly preactivationCheckpoint: () => void
    readonly conflictEvidence?: BrowserStagedCommandConflictEvidence
  },
): Promise<number> {
  let estimatedLiveBytes = initialEstimatedLiveBytes
  let finalRows = 0
  let finalBytes = 0
  for (const tableName of BROWSER_WORKSPACE_MUTATION_JOURNAL_SOURCE_TABLE_NAMES) {
    let after: string | undefined
    for (;;) {
      options.preactivationCheckpoint()
      const page = await readStagedCatchupPage(source, tableName, after, options.signal)
      if (page.scannedRows === 0) break
      if (options.mode === 'final') {
        finalRows = saturatingAdd(finalRows, page.entries.length)
        finalBytes = saturatingAdd(finalBytes, page.estimatedBytes)
        if (
          finalRows > STAGED_FINAL_CATCHUP_MAX_ROWS ||
          finalBytes > STAGED_FINAL_CATCHUP_MAX_BYTES
        ) {
          throw new Error(`BrowserWorkspaceStagedCatchupBudgetExceeded:${finalRows}:${finalBytes}`)
        }
      }
      estimatedLiveBytes = await applyStagedCatchupPage(
        tableName,
        page.entries,
        runDestinationTransaction,
        estimatedLiveBytes,
        options.conflictEvidence,
      )
      if (options.mode === 'online') {
        await acknowledgeStagedCatchupPage(source, tableName, page.entries)
      }
      if (page.lastId === undefined) {
        throw new Error(`BrowserWorkspaceStagedCatchupPrimaryKeyMissing:${tableName}`)
      }
      after = page.lastId
    }
  }
  return estimatedLiveBytes
}

async function readStagedCatchupPage(
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
  if (signal.aborted) throw stagedReadError(signal.reason)
  const journalName = browserWorkspaceCatchupJournalTableName(tableName)
  return source.transaction(
    'r',
    [source.table(tableName), source.table(journalName)],
    async (tx) => {
      const journal = tx.table<BrowserWorkspaceCatchupJournalRow, string>(journalName)
      const rows = await (after === undefined
        ? journal.where(':id').above(BROWSER_WORKSPACE_CATCHUP_ACTIVE_ID)
        : journal.where(':id').above(after)
      )
        .limit(STAGED_COPY_MAX_PAGE_ROWS)
        .toArray()
      const entries: Array<{
        journal: BrowserWorkspaceCatchupJournalRow
        sourceValue: unknown
      }> = []
      let estimatedBytes = 0
      let lastId: string | undefined
      const sourceTable = tx.table<unknown, IndexableType>(tableName)
      for (const row of rows) {
        if (signal.aborted) throw stagedReadError(signal.reason)
        const current = await journal.get(row.id)
        if (current?.revision !== row.revision) {
          lastId = row.id
          continue
        }
        const sourceValue = await sourceTable.get(row.sourceKey as IndexableType)
        const rowBytes = sourceValue === undefined ? 0 : estimateStoredValueBytes(sourceValue)
        if (entries.length > 0 && estimatedBytes + rowBytes > STAGED_COPY_MAX_PAGE_BYTES) break
        entries.push({ journal: row, sourceValue })
        estimatedBytes = saturatingAdd(estimatedBytes, rowBytes)
        lastId = row.id
        if (estimatedBytes >= STAGED_COPY_MAX_PAGE_BYTES) break
      }
      return {
        entries,
        ...(lastId === undefined ? {} : { lastId }),
        scannedRows: rows.length,
        estimatedBytes,
      }
    },
  )
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

async function applyStagedCatchupPage(
  tableName: BrowserWorkspaceMutationJournalSourceTableName,
  entries: readonly {
    readonly journal: BrowserWorkspaceCatchupJournalRow
    readonly sourceValue: unknown
  }[],
  runDestinationTransaction: DestinationTransactionRunner,
  initialEstimatedLiveBytes: number,
  conflictEvidence: BrowserStagedCommandConflictEvidence | undefined,
): Promise<number> {
  if (entries.length === 0) return initialEstimatedLiveBytes
  return runDestinationTransaction([tableName], async (tx) => {
    const table = tx.table<unknown, IndexableType>(tableName)
    const keys = entries.map(({ journal }) => journal.sourceKey as IndexableType)
    const previous = await table.bulkGet(keys)
    if (conflictEvidence) {
      assertNoStagedCommandConflict(tableName, entries, previous, conflictEvidence)
    }
    const puts = entries.flatMap(({ sourceValue }) =>
      sourceValue === undefined ? [] : [sourceValue],
    )
    const deletes = entries.flatMap(({ journal, sourceValue }) =>
      sourceValue === undefined ? [journal.sourceKey as IndexableType] : [],
    )
    if (puts.length > 0) await table.bulkPut(puts)
    if (deletes.length > 0) await table.bulkDelete(deletes)
    let estimatedLiveBytes = initialEstimatedLiveBytes
    entries.forEach(({ sourceValue }, index) => {
      estimatedLiveBytes = adjustCount(
        estimatedLiveBytes,
        (sourceValue === undefined ? 0 : estimateStoredValueBytes(sourceValue)) -
          (previous[index] === undefined ? 0 : estimateStoredValueBytes(previous[index])),
      )
    })
    return estimatedLiveBytes
  })
}

function assertNoStagedCommandConflict(
  tableName: BrowserWorkspaceMutationJournalSourceTableName,
  entries: readonly {
    readonly journal: BrowserWorkspaceCatchupJournalRow
    readonly sourceValue: unknown
  }[],
  previous: readonly unknown[],
  evidence: BrowserStagedCommandConflictEvidence,
): void {
  const exactAddresses = new Set([...evidence.readAddresses, ...evidence.mutationAddresses])
  const scopes = evidence.readScopes.filter((scope) => scope.tableName === tableName)
  entries.forEach(({ journal, sourceValue }, index) => {
    const address = physicalStorageMutationAddress(tableName, journal.sourceKey)
    if (
      exactAddresses.has(address) ||
      scopes.some(
        (scope) =>
          (previous[index] !== undefined &&
            stagedReadScopeContains(
              scope.keyPath,
              scope.range,
              journal.sourceKey,
              previous[index],
            )) ||
          (sourceValue !== undefined &&
            stagedReadScopeContains(scope.keyPath, scope.range, journal.sourceKey, sourceValue)),
      )
    ) {
      throw new Error(
        `BrowserWorkspaceStagedCommandConflict:${tableName}:${encodePhysicalStorageKey(
          journal.sourceKey,
        )}`,
      )
    }
  })
}

function stagedReadScopeContains(
  keyPath: string | readonly string[] | null,
  range: {
    readonly type: number
    readonly lower: unknown
    readonly lowerOpen?: boolean
    readonly upper: unknown
    readonly upperOpen?: boolean
  },
  primaryKey: unknown,
  value: unknown,
): boolean {
  const key =
    keyPath === null
      ? primaryKey
      : typeof keyPath === 'string'
        ? stagedIndexPart(value, keyPath)
        : keyPath.map((part) => stagedIndexPart(value, part))
  if (key === undefined || (Array.isArray(key) && key.some((part) => part === undefined))) {
    return false
  }
  if (range.type === 4) return false
  if (range.type === 3) return true
  if (range.type === 1) return compareIndexedDbKeys(key, range.lower) === 0
  const lower = compareIndexedDbKeys(key, range.lower)
  const upper = compareIndexedDbKeys(key, range.upper)
  return (
    (lower > 0 || (lower === 0 && range.lowerOpen !== true)) &&
    (upper < 0 || (upper === 0 && range.upperOpen !== true))
  )
}

function stagedIndexPart(value: unknown, keyPath: string): unknown {
  let current = value
  for (const part of keyPath.split('.')) {
    if (!current || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

function compareIndexedDbKeys(left: unknown, right: unknown): number {
  try {
    return indexedDB.cmp(left, right)
  } catch (error) {
    throw new Error('BrowserWorkspaceStagedConflictKeyInvalid', { cause: error })
  }
}

async function acknowledgeStagedCatchupPage(
  source: NatterDb,
  tableName: BrowserWorkspaceMutationJournalSourceTableName,
  entries: readonly { readonly journal: BrowserWorkspaceCatchupJournalRow }[],
): Promise<void> {
  if (entries.length === 0) return
  const journalName = browserWorkspaceCatchupJournalTableName(tableName)
  await source.transaction('rw', source.table(journalName), async (tx) => {
    const table = tx.table<BrowserWorkspaceCatchupJournalRow, string>(journalName)
    const current = await table.bulkGet(entries.map(({ journal }) => journal.id))
    const acknowledged = entries.flatMap(({ journal }, index) =>
      current[index]?.revision === journal.revision ? [journal.id] : [],
    )
    if (acknowledged.length > 0) await table.bulkDelete(acknowledged)
  })
}

function readStagedCopyPage(
  source: Table<unknown, IndexableType>,
  after: IndexableType | undefined,
  signal: AbortSignal,
): Promise<{
  readonly rows: readonly unknown[]
  readonly lastPrimaryKey?: IndexableType
  readonly estimatedBytes: number
}> {
  if (signal.aborted) return Promise.reject(stagedReadError(signal.reason))
  const backend = source.db.backendDB() as IDBDatabase | null
  if (!backend) throw new Error('BrowserWorkspaceStagedCopySourceClosed')
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
    const cleanup = () => signal.removeEventListener('abort', abort)
    const finish = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve({
        rows,
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
        stagedReadError(
          error ??
            request.error ??
            transaction.error ??
            new Error('BrowserWorkspaceStagedCopyReadFailed'),
        ),
      )
    }
    const abort = () => {
      try {
        transaction.abort()
      } catch {
        fail(signal.reason)
        return
      }
      fail(signal.reason)
    }
    signal.addEventListener('abort', abort, { once: true })
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
          (rows.length >= STAGED_COPY_MAX_PAGE_ROWS ||
            estimatedBytes + rowBytes > STAGED_COPY_MAX_PAGE_BYTES)
        ) {
          return
        }
        rows.push(cursor.value)
        primaryKeys.push(cursor.primaryKey as IndexableType)
        estimatedBytes = saturatingAdd(estimatedBytes, rowBytes)
        if (
          rows.length >= STAGED_COPY_MAX_PAGE_ROWS ||
          estimatedBytes >= STAGED_COPY_MAX_PAGE_BYTES
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

function assertStagedSchema(db: NatterDb): void {
  const actual = new Set(db.tables.map((table) => table.name))
  const missing = [
    ...STAGED_COPY_TABLE_NAMES,
    ...BROWSER_WORKSPACE_CATCHUP_JOURNAL_TABLE_NAMES,
  ].filter((tableName) => !actual.has(tableName))
  if (missing.length > 0) {
    throw new Error(`BrowserWorkspaceStagedSchemaMismatch:${missing.join(',')}`)
  }
}

function assertWorkspaceFence(actual: WorkspaceFence, expected: WorkspaceFence): void {
  if (
    actual.workspaceId !== expected.workspaceId ||
    actual.replacementEpoch !== expected.replacementEpoch
  ) {
    throw new Error('BrowserWorkspaceStagedPermitFenceChanged')
  }
}

function assertSameWorkspaceFence(actual: WorkspaceFence, expected: WorkspaceFence): void {
  if (
    actual.workspaceId !== expected.workspaceId ||
    actual.replacementEpoch !== expected.replacementEpoch
  ) {
    throw new Error('BrowserWorkspaceStagedSourceChanged')
  }
}

function stagedReadError(reason: unknown): Error {
  return reason instanceof Error
    ? reason
    : new Error('BrowserWorkspaceStagedReadFailed', { cause: reason })
}

function saturatingAdd(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right)
}

function adjustCount(current: number, delta: number): number {
  return Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, current + delta))
}
