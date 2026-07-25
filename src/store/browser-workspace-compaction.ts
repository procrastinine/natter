import type { IndexableType, Table } from 'dexie'
import {
  type BrowserWorkspaceCompactionAttemptClaim,
  claimBrowserWorkspaceCompactionAttempt,
} from './browser-workspace-database-control'
import type {
  BrowserWorkspaceCompactionResult,
  BrowserWorkspaceReplacementStart,
} from './browser-workspace-maintenance-contract'

export type { BrowserWorkspaceCompactionResult } from './browser-workspace-maintenance-contract'

import { tryStartBrowserWorkspaceReplacementIfIdle } from './browser-workspace-replacement-runner'
import { browserWorkspaceSlotSwitchingSupported } from './browser-workspace-slot-coordination'
import { chatSidebarProjectionBackfillMarker } from './chat-sidebar-projection'
import type { NatterDb } from './db'
import type { SettingsRow } from './db-rows'
import type { LockGrant } from './locks'
import {
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
  isWorkspaceMaintenancePreemptedError,
  type WorkspaceRuntimeActionOptions,
} from './workspace-runtime'

const COMPACTION_COPY_MAX_PAGE_ROWS = 64
const COMPACTION_COPY_MAX_PAGE_BYTES = 1024 * 1024

export function browserWorkspaceCompactionSupported(): boolean {
  return browserWorkspaceSlotSwitchingSupported()
}

export async function tryStartBrowserWorkspaceCompaction(
  options: WorkspaceRuntimeActionOptions = {},
): Promise<BrowserWorkspaceReplacementStart<BrowserWorkspaceCompactionResult>> {
  if (!browserWorkspaceCompactionSupported()) {
    throw new Error('BrowserWorkspaceCompactionUnsupported')
  }
  let claim: BrowserWorkspaceCompactionAttemptClaim | null = null
  const started = await tryStartBrowserWorkspaceReplacementIfIdle(
    async (session) => {
      await awaitStorageCompactionDebtIdle()
      const db = await session.open()
      const state = await readStorageCompactionState(db)
      return state.requestRevision > state.attemptedRevision
    },
    async (destination, context) => {
      context.preactivationCheckpoint()
      if (
        context.atomicity !== 'slotted-staging' ||
        context.sourceDatabaseName === context.destinationDatabaseName
      ) {
        throw new Error('BrowserWorkspaceCompactionRequiresSlots')
      }
      const attempt = await claimBrowserWorkspaceCompactionAttempt(context.sourceDatabaseName)
      if (attempt.kind !== 'claimed') {
        throw new Error('BrowserWorkspaceCompactionAttemptAlreadyClaimed')
      }
      claim = attempt.claim
      return context.mutate((grant) =>
        context.withSourceDatabase(async (source) => {
          const sourceWorkspace = await readBrowserWorkspaceMeta(source)
          context.preactivationCheckpoint()
          const copied = await copyBrowserWorkspace(
            source,
            destination,
            grant,
            context.signal,
            context.preactivationCheckpoint,
          )
          let workspace = sourceWorkspace
          context.preactivationCheckpoint()
          await grant.runTransaction(
            destination,
            [destination.workspaceFence, destination.settings],
            async (tx) => {
              const copiedWorkspace = await readBrowserWorkspaceMetaFromTransaction(tx)
              if (
                copiedWorkspace.workspaceId !== sourceWorkspace.workspaceId ||
                copiedWorkspace.replacementEpoch !== sourceWorkspace.replacementEpoch
              ) {
                throw new Error('BrowserWorkspaceCompactionCopyChanged')
              }
              await tx
                .table<SettingsRow, string>('settings')
                .put(chatSidebarProjectionBackfillMarker())
              workspace = await readBrowserWorkspaceMetaFromTransaction(tx)
            },
          )
          return {
            workspace,
            storageBaseline: { kind: 'carry-source', liveBytes: copied.estimatedLiveBytes },
            value: copied,
          }
        }),
      )
    },
    options,
  )
  if (started.kind !== 'handoff') return started
  return {
    kind: 'handoff',
    handoff: {
      completion: started.handoff.completion.catch(async (error: unknown) => {
        if (!isWorkspaceMaintenancePreemptedError(error) || claim === null) throw error
        const release = await claim.release()
        if (release.released) publishStorageCompactionRequest()
        throw error
      }),
    },
  }
}

async function copyBrowserWorkspace(
  source: NatterDb,
  destination: NatterDb,
  grant: LockGrant,
  signal: AbortSignal,
  preactivationCheckpoint: () => void,
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
  preactivationCheckpoint()
  await grant.runTransaction(destination, clearTableNames, (tx) =>
    Promise.all(clearTableNames.map((name) => tx.table(name).clear())).then(() => undefined),
  )
  let copiedRows = 0
  let estimatedLiveBytes = 0
  for (const name of copyTableNames) {
    preactivationCheckpoint()
    const result = await copyTable(
      source,
      name,
      destination.table<unknown, IndexableType>(name),
      grant,
      signal,
      preactivationCheckpoint,
    )
    copiedRows = saturatingAdd(copiedRows, result.copiedRows)
    estimatedLiveBytes = saturatingAdd(estimatedLiveBytes, result.estimatedLiveBytes)
  }
  return { copiedRows, estimatedLiveBytes }
}

async function copyTable(
  sourceDb: NatterDb,
  tableName: PhysicalStorageTableName,
  destination: Table<unknown, IndexableType>,
  grant: LockGrant,
  signal: AbortSignal,
  preactivationCheckpoint: () => void,
): Promise<BrowserWorkspaceCompactionResult> {
  const source = sourceDb.table<unknown, IndexableType>(tableName)
  let after: IndexableType | undefined
  let copiedRows = 0
  let estimatedLiveBytes = 0
  for (;;) {
    preactivationCheckpoint()
    const page = await readCopyPage(source, after, signal)
    if (page.rows.length === 0) break
    const rows = await filterCompactionRows(sourceDb, tableName, page.rows)
    const keyPath = (
      destination.schema.primKey as unknown as {
        readonly keyPath?: string | readonly string[] | null
      }
    ).keyPath
    if (keyPath == null) {
      throw new Error(`BrowserWorkspaceCompactionOutboundPrimaryKey:${destination.name}`)
    }
    if (rows.length > 0) {
      preactivationCheckpoint()
      await grant.runTransaction(destination.db, [destination], () => destination.bulkPut(rows))
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
  const missing = PHYSICAL_STORAGE_TABLE_NAMES.filter((name) => !actual.has(name))
  const unexpected = [...actual].filter(
    (name) => !PHYSICAL_STORAGE_TABLE_NAMES.includes(name as PhysicalStorageTableName),
  )
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
): Promise<{
  readonly rows: unknown[]
  readonly primaryKeys: IndexableType[]
  readonly lastPrimaryKey?: IndexableType
  readonly estimatedBytes: number
}> {
  if (signal.aborted) return Promise.reject(compactionReadError(signal.reason))
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
    const cleanup = () => signal.removeEventListener('abort', abort)
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
