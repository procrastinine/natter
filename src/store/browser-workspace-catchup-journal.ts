import Dexie, {
  type DBCore,
  type DBCoreMutateRequest,
  type DBCoreMutateResponse,
  type DBCoreTransaction,
  type Dexie as DexieDatabase,
} from 'dexie'
import { newId } from '../lib/ulid'
import {
  BROWSER_WORKSPACE_CATCHUP_JOURNAL_TABLE_NAMES,
  BROWSER_WORKSPACE_MUTATION_JOURNAL_SOURCE_TABLE_NAMES,
  type BrowserWorkspaceMutationJournalSourceTableName,
  browserWorkspaceCatchupJournalTableName,
  encodePhysicalStorageKey,
  type PhysicalStorageTableName,
} from './physical-storage-tables'

export interface BrowserWorkspaceCatchupJournalRow {
  readonly id: string
  readonly sourceTableName: BrowserWorkspaceMutationJournalSourceTableName
  readonly sourceKey: unknown
  readonly revision: string
}

export const BROWSER_WORKSPACE_CATCHUP_ACTIVE_ID = '!active'

export function browserWorkspaceCatchupTransactionTableNames(
  sourceTableNames: readonly string[],
): readonly string[] {
  return Object.freeze([
    ...sourceTableNames,
    ...sourceTableNames.flatMap((tableName) =>
      isBrowserWorkspaceCatchupSourceTableName(tableName)
        ? [browserWorkspaceCatchupJournalTableName(tableName)]
        : [],
    ),
  ])
}

export async function recordBrowserWorkspaceCatchupMutations(
  core: DBCore,
  transaction: DBCoreTransaction,
  sourceTableName: string,
  extractKey: ((value: unknown) => unknown) | null,
  request: DBCoreMutateRequest,
  response: DBCoreMutateResponse,
  activeByTable: Map<string, boolean>,
): Promise<void> {
  if (!isBrowserWorkspaceCatchupSourceTableName(sourceTableName)) return
  if (request.type === 'deleteRange') {
    throw new Error(`BrowserWorkspaceCatchupDeleteRangeForbidden:${sourceTableName}`)
  }
  const journal = core.table(browserWorkspaceCatchupJournalTableName(sourceTableName))
  let active = activeByTable.get(sourceTableName)
  if (active === undefined) {
    active =
      (await journal.get({
        trans: transaction,
        key: BROWSER_WORKSPACE_CATCHUP_ACTIVE_ID,
      })) !== undefined
    activeByTable.set(sourceTableName, active)
  }
  if (!active) return
  const revision = newId()
  const rows = new Map<string, BrowserWorkspaceCatchupJournalRow>()
  const keys = request.keys as readonly unknown[] | undefined
  const results = response.results as readonly unknown[] | undefined
  const values = request.type === 'delete' ? undefined : (request.values as readonly unknown[])
  const count = request.type === 'delete' ? request.keys.length : request.values.length
  for (let index = 0; index < count; index += 1) {
    if (response.failures[index]) continue
    const value = values?.[index]
    const sourceKey =
      keys?.[index] ??
      (value !== undefined && extractKey ? extractKey(value) : undefined) ??
      results?.[index]
    if (sourceKey === undefined) {
      throw new Error(`BrowserWorkspaceCatchupMutationKeyMissing:${sourceTableName}:${index}`)
    }
    const id = encodePhysicalStorageKey(sourceKey)
    rows.set(id, {
      id,
      sourceTableName,
      sourceKey: structuredClone(sourceKey),
      revision,
    })
  }
  if (rows.size === 0) return
  const result = await journal.mutate({
    trans: transaction,
    type: 'put',
    values: [...rows.values()],
  })
  if (result.numFailures > 0) {
    throw new Error(
      `BrowserWorkspaceCatchupJournalWriteFailed:${sourceTableName}:${result.numFailures}`,
    )
  }
}

export function activateBrowserWorkspaceCatchupJournals(db: DexieDatabase): Promise<void> {
  return db.transaction(
    'rw',
    BROWSER_WORKSPACE_CATCHUP_JOURNAL_TABLE_NAMES.map((tableName) => db.table(tableName)),
    () =>
      Dexie.Promise.all(
        BROWSER_WORKSPACE_MUTATION_JOURNAL_SOURCE_TABLE_NAMES.map((sourceTableName) => {
          const table = db.table<BrowserWorkspaceCatchupJournalRow, string>(
            browserWorkspaceCatchupJournalTableName(sourceTableName),
          )
          return table.clear().then(() =>
            table.put({
              id: BROWSER_WORKSPACE_CATCHUP_ACTIVE_ID,
              sourceTableName,
              sourceKey: BROWSER_WORKSPACE_CATCHUP_ACTIVE_ID,
              revision: BROWSER_WORKSPACE_CATCHUP_ACTIVE_ID,
            }),
          )
        }),
      ).then(() => undefined),
  )
}

export function deactivateBrowserWorkspaceCatchupJournals(db: DexieDatabase): Promise<void> {
  return db.transaction(
    'rw',
    BROWSER_WORKSPACE_CATCHUP_JOURNAL_TABLE_NAMES.map((tableName) => db.table(tableName)),
    () =>
      Dexie.Promise.all(
        BROWSER_WORKSPACE_CATCHUP_JOURNAL_TABLE_NAMES.map((tableName) =>
          db.table(tableName).clear(),
        ),
      ).then(() => undefined),
  )
}

export function isBrowserWorkspaceCatchupSourceTableName(
  tableName: string,
): tableName is BrowserWorkspaceMutationJournalSourceTableName {
  return BROWSER_WORKSPACE_MUTATION_JOURNAL_SOURCE_TABLE_NAMES.some(
    (sourceTableName) => sourceTableName === (tableName as PhysicalStorageTableName),
  )
}
