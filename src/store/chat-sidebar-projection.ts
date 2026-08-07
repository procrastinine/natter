import Dexie, { type Table, type Transaction } from 'dexie'
import type {
  SidebarSortExtrema,
  SidebarSortExtremum,
  SidebarSortField,
} from '../core/sidebar-sort'
import { sidebarTitleSortKey } from '../core/sidebar-sort'
import type { Chat, ChatFolder, ChatId, ChatSidebarRow, FolderId } from '../core/types'
import { sameValue } from '../lib/same-value'
import { recordBrowserCommandInvalidation } from './browser-command-mutation-journal'
import {
  deletePhysicalStorageRows,
  putPhysicalStorageRow,
  putPhysicalStorageRows,
} from './byte-owner-mutation'
import type { SettingsRow } from './db-rows'
import { exactCompoundPrefixBetween } from './indexeddb-key-ranges'
import { physicalStorageTables } from './physical-storage-tables'

export const CHAT_SIDEBAR_PROJECTION_TRANSACTION_CAPABILITY = physicalStorageTables(
  'chatSidebarRows',
  'chatSidebarAggregates',
)

export const CHAT_SIDEBAR_PROJECTION_BACKFILL_KEY = 'backfill:chat-sidebar-aggregate-v1'
export const CHAT_SIDEBAR_PROJECTION_LEGACY_BACKFILL_KEY = 'backfill:chat-sidebar-projection-v1'
export const CHAT_SIDEBAR_PROJECTION_LEGACY_MANIFEST_KEY = 'projection:chat-sidebar-v1'
export const CHAT_SIDEBAR_AGGREGATE_ID = 'workspace'

export const CHAT_SIDEBAR_PROJECTION_ROW_VERSION = 4
const CHAT_SIDEBAR_AGGREGATE_VERSION = 3
export const CHAT_SIDEBAR_PROJECTION_MARKER_VERSION = 6
export const CHAT_SIDEBAR_FOLDER_EXTREMA_READ_REQUEST_LIMIT = 24
const REBUILD_BATCH_SIZE = 128
const ROOT_FOLDER_KEY = '\u0000root'

export interface ChatSidebarProjectionRow extends ChatSidebarRow {
  folderKey: string
  archivedKey: number
  pinnedKey: number
  visibleKey: 0 | 1
  titleSortKey: string
  projectionVersion: typeof CHAT_SIDEBAR_PROJECTION_ROW_VERSION
  checksum: string
}

interface ChatSidebarProjectionManifest {
  projectionVersion: 3
  expectedCount: number
}

export interface ChatSidebarWorkspaceAggregateRow {
  id: typeof CHAT_SIDEBAR_AGGREGATE_ID
  kind: 'workspace'
  projectionVersion: typeof CHAT_SIDEBAR_AGGREGATE_VERSION
  totalCount: number
  activeCount: number
  archivedCount: number
  pinnedCount: number
  visibleCount: number
  visiblePinnedCount: number
  rootCount: number
  rootVisibleCount: number
  rootVisiblePinnedCount: number
}

export interface ChatSidebarFolderAggregateRow {
  id: string
  kind: 'folder'
  projectionVersion: typeof CHAT_SIDEBAR_AGGREGATE_VERSION
  folderKey: string
  count: number
  activeCount: number
  visibleCount: number
  visiblePinnedCount: number
  sortExtrema: SidebarSortExtrema | null
  folder: ChatFolder
  folderNameKey: string
  folderSortIndex: number
  folderTitleSortKey: string
  presentationPinnedAsc: 0 | 1
  presentationPinnedDesc: 0 | 1
  updatedAtAsc: number
  updatedAtDesc: number
  createdAtAsc: number
  createdAtDesc: number
  lastViewedAtAsc: number
  lastViewedAtDesc: number
  totalCostUsdAsc: number
  totalCostUsdDesc: number
  wordCountAsc: number
  wordCountDesc: number
  titleAsc: string
  titleDesc: string
}

export interface ChatSidebarFolderAggregateSummary {
  readonly count: number
  readonly activeCount: number
  readonly visibleCount: number
  readonly visiblePinnedCount: number
  readonly sortExtrema: SidebarSortExtrema | null
}

export type ChatSidebarAggregateProjectionRow =
  | ChatSidebarWorkspaceAggregateRow
  | ChatSidebarFolderAggregateRow

export interface ChatSidebarAggregateAccumulator {
  workspace: ChatSidebarWorkspaceAggregateRow
  folders: Map<string, ChatSidebarFolderAggregateRow>
}

export function projectChatSidebarRow(chat: Chat): ChatSidebarRow {
  return {
    id: chat.id,
    title: chat.title,
    titleStatus: chat.titleStatus,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    lastViewedAt: chat.lastViewedAt,
    wordCount: chat.wordCount,
    totalCostUsd: chat.totalCostUsd,
    lastUpdatedLeafId: chat.lastUpdatedLeafId,
    lastBranchUpdatedAt: chat.lastBranchUpdatedAt,
    archived: chat.archived,
    pinned: chat.pinned,
    folderId: chat.folderId,
    tags: [...chat.tags],
    ...(chat.previewText !== undefined ? { previewText: chat.previewText } : {}),
  }
}

export function chatSidebarProjectionRow(chat: Chat): ChatSidebarProjectionRow {
  const row = projectChatSidebarRow(chat)
  return {
    ...row,
    folderKey: chatSidebarFolderKey(row.folderId),
    archivedKey: row.archived ? 1 : 0,
    pinnedKey: row.pinned ? 1 : 0,
    visibleKey: !row.archived && (row.previewText?.length ?? 0) > 0 ? 1 : 0,
    titleSortKey: sidebarTitleSortKey(row.title),
    projectionVersion: CHAT_SIDEBAR_PROJECTION_ROW_VERSION,
    checksum: sidebarRowChecksum(row),
  }
}

export function chatSidebarProjectionSettings(_expectedCount?: number): SettingsRow[] {
  return [chatSidebarProjectionBackfillMarker()]
}

export function chatSidebarProjectionBackfillMarker(): SettingsRow {
  return {
    key: CHAT_SIDEBAR_PROJECTION_BACKFILL_KEY,
    value: CHAT_SIDEBAR_PROJECTION_MARKER_VERSION,
  }
}

export function legacyChatSidebarProjectionSettings(expectedCount: number): SettingsRow[] {
  return [
    { key: CHAT_SIDEBAR_PROJECTION_LEGACY_BACKFILL_KEY, value: 1 },
    {
      key: CHAT_SIDEBAR_PROJECTION_LEGACY_MANIFEST_KEY,
      value: {
        projectionVersion: 3,
        expectedCount,
      } satisfies ChatSidebarProjectionManifest,
    },
  ]
}

export function isChatSidebarProjectionSettingKey(key: string): boolean {
  return (
    key === CHAT_SIDEBAR_PROJECTION_BACKFILL_KEY ||
    key === CHAT_SIDEBAR_PROJECTION_LEGACY_BACKFILL_KEY ||
    key === CHAT_SIDEBAR_PROJECTION_LEGACY_MANIFEST_KEY
  )
}

export function isValidChatSidebarProjectionRow(
  row: Omit<ChatSidebarProjectionRow, 'projectionVersion'> & { projectionVersion: number },
): boolean {
  return (
    row.projectionVersion === CHAT_SIDEBAR_PROJECTION_ROW_VERSION &&
    row.folderKey === chatSidebarFolderKey(row.folderId) &&
    row.archivedKey === (row.archived ? 1 : 0) &&
    row.pinnedKey === (row.pinned ? 1 : 0) &&
    row.visibleKey === (!row.archived && (row.previewText?.length ?? 0) > 0 ? 1 : 0) &&
    row.titleSortKey === sidebarTitleSortKey(row.title) &&
    row.checksum === sidebarRowChecksum(row)
  )
}

export function emptyChatSidebarAggregateRow(): ChatSidebarWorkspaceAggregateRow {
  return {
    id: CHAT_SIDEBAR_AGGREGATE_ID,
    kind: 'workspace',
    projectionVersion: CHAT_SIDEBAR_AGGREGATE_VERSION,
    totalCount: 0,
    activeCount: 0,
    archivedCount: 0,
    pinnedCount: 0,
    visibleCount: 0,
    visiblePinnedCount: 0,
    rootCount: 0,
    rootVisibleCount: 0,
    rootVisiblePinnedCount: 0,
  }
}

export function currentChatSidebarWorkspaceAggregateRow(
  row: Omit<ChatSidebarWorkspaceAggregateRow, 'projectionVersion'>,
): ChatSidebarWorkspaceAggregateRow {
  const current = { ...row, projectionVersion: CHAT_SIDEBAR_AGGREGATE_VERSION }
  if (!isValidChatSidebarWorkspaceAggregateRow(current)) {
    throw new Error('ChatSidebarAggregateInvalid')
  }
  return current
}

export function createChatSidebarAggregateAccumulator(): ChatSidebarAggregateAccumulator {
  return {
    workspace: emptyChatSidebarAggregateRow(),
    folders: new Map(),
  }
}

export function accumulateChatSidebarFolderRows(
  accumulator: ChatSidebarAggregateAccumulator,
  folders: readonly ChatFolder[],
): void {
  for (const folder of folders) {
    const folderKey = chatSidebarFolderKey(folder.id)
    if (accumulator.folders.has(folderKey)) {
      throw new Error(`ChatSidebarFolderProjectionDuplicate:${folder.id}`)
    }
    accumulator.folders.set(folderKey, emptyFolderAggregateRow(folder))
  }
}

export function accumulateChatSidebarAggregateRows(
  accumulator: ChatSidebarAggregateAccumulator,
  rows: readonly ChatSidebarProjectionRow[],
): void {
  for (const row of rows) {
    if (!isValidChatSidebarProjectionRow(row)) throw new Error('ChatSidebarProjectionRowInvalid')
    addWorkspaceContribution(accumulator.workspace, row, 1)
    if (row.folderKey !== ROOT_FOLDER_KEY) {
      const aggregate = accumulator.folders.get(row.folderKey)
      if (!aggregate) throw new Error(`ChatSidebarFolderProjectionMissing:${row.folderKey}`)
      addFolderContribution(aggregate, row, 1)
      if (isVisibleSidebarRow(row)) includeRowInSortExtrema(aggregate, row)
      refreshFolderPresentationFields(aggregate)
      accumulator.folders.set(row.folderKey, aggregate)
    }
  }
}

export function materializeChatSidebarAggregateRows(
  accumulator: ChatSidebarAggregateAccumulator,
): ChatSidebarAggregateProjectionRow[] {
  if (!isValidChatSidebarWorkspaceAggregateRow(accumulator.workspace)) {
    throw new Error('ChatSidebarAggregateInvalid')
  }
  return [
    { ...accumulator.workspace },
    ...[...accumulator.folders.values()].map(cloneFolderAggregateRow),
  ]
}

export function isValidChatSidebarWorkspaceAggregateRow(
  value: unknown,
  expectedCount?: number,
): value is ChatSidebarWorkspaceAggregateRow {
  if (!value || typeof value !== 'object') return false
  const row = value as Partial<ChatSidebarWorkspaceAggregateRow>
  const totalCount = row.totalCount ?? -1
  const activeCount = row.activeCount ?? -1
  const archivedCount = row.archivedCount ?? -1
  const pinnedCount = row.pinnedCount ?? -1
  const visibleCount = row.visibleCount ?? -1
  const visiblePinnedCount = row.visiblePinnedCount ?? -1
  const rootCount = row.rootCount ?? -1
  const rootVisibleCount = row.rootVisibleCount ?? -1
  const rootVisiblePinnedCount = row.rootVisiblePinnedCount ?? -1
  const counts = [
    totalCount,
    activeCount,
    archivedCount,
    pinnedCount,
    visibleCount,
    visiblePinnedCount,
    rootCount,
    rootVisibleCount,
    rootVisiblePinnedCount,
  ]
  return (
    row.id === CHAT_SIDEBAR_AGGREGATE_ID &&
    row.kind === 'workspace' &&
    row.projectionVersion === CHAT_SIDEBAR_AGGREGATE_VERSION &&
    counts.every((count) => Number.isSafeInteger(count) && count >= 0) &&
    activeCount + archivedCount === totalCount &&
    pinnedCount <= totalCount &&
    visibleCount <= activeCount &&
    visiblePinnedCount <= visibleCount &&
    rootCount <= totalCount &&
    rootVisibleCount <= visibleCount &&
    rootVisibleCount <= rootCount &&
    rootVisiblePinnedCount <= rootVisibleCount &&
    (expectedCount === undefined || totalCount === expectedCount)
  )
}

export function isValidChatSidebarFolderAggregateRow(
  value: unknown,
): value is ChatSidebarFolderAggregateRow {
  if (!value || typeof value !== 'object') return false
  const row = value as Partial<ChatSidebarFolderAggregateRow>
  const count = row.count ?? -1
  const activeCount = row.activeCount ?? -1
  const visibleCount = row.visibleCount ?? -1
  const visiblePinnedCount = row.visiblePinnedCount ?? -1
  return (
    row.kind === 'folder' &&
    row.projectionVersion === CHAT_SIDEBAR_AGGREGATE_VERSION &&
    typeof row.folderKey === 'string' &&
    row.folderKey !== ROOT_FOLDER_KEY &&
    row.id === chatSidebarFolderAggregateId(row.folderKey) &&
    Number.isSafeInteger(count) &&
    count >= 0 &&
    Number.isSafeInteger(activeCount) &&
    activeCount >= 0 &&
    activeCount <= count &&
    Number.isSafeInteger(visibleCount) &&
    visibleCount >= 0 &&
    visibleCount <= activeCount &&
    Number.isSafeInteger(visiblePinnedCount) &&
    visiblePinnedCount >= 0 &&
    visiblePinnedCount <= visibleCount &&
    (visibleCount === 0
      ? row.sortExtrema === null
      : isValidChatSidebarSortExtrema(row.sortExtrema)) &&
    isValidFolderPresentationFields(row)
  )
}

export function chatSidebarFolderNameKey(value: string): string {
  return value.trim().normalize('NFKC').toLowerCase()
}

export function chatSidebarFolderAggregateRow(
  folder: ChatFolder,
  summary: ChatSidebarFolderAggregateSummary = {
    count: 0,
    activeCount: 0,
    visibleCount: 0,
    visiblePinnedCount: 0,
    sortExtrema: null,
  },
): ChatSidebarFolderAggregateRow {
  const row: ChatSidebarFolderAggregateRow = {
    id: chatSidebarFolderAggregateId(chatSidebarFolderKey(folder.id)),
    kind: 'folder',
    projectionVersion: CHAT_SIDEBAR_AGGREGATE_VERSION,
    folderKey: chatSidebarFolderKey(folder.id),
    count: summary.count,
    activeCount: summary.activeCount,
    visibleCount: summary.visibleCount,
    visiblePinnedCount: summary.visiblePinnedCount,
    sortExtrema: summary.sortExtrema
      ? {
          updatedAt: { ...summary.sortExtrema.updatedAt },
          createdAt: { ...summary.sortExtrema.createdAt },
          lastViewedAt: { ...summary.sortExtrema.lastViewedAt },
          totalCostUsd: { ...summary.sortExtrema.totalCostUsd },
          wordCount: { ...summary.sortExtrema.wordCount },
          title: { ...summary.sortExtrema.title },
        }
      : null,
    folder: { ...folder },
    folderNameKey: '',
    folderSortIndex: 0,
    folderTitleSortKey: '',
    presentationPinnedAsc: 1,
    presentationPinnedDesc: 0,
    updatedAtAsc: 0,
    updatedAtDesc: 0,
    createdAtAsc: 0,
    createdAtDesc: 0,
    lastViewedAtAsc: 0,
    lastViewedAtDesc: 0,
    totalCostUsdAsc: 0,
    totalCostUsdDesc: 0,
    wordCountAsc: 0,
    wordCountDesc: 0,
    titleAsc: '',
    titleDesc: '',
  }
  refreshFolderPresentationFields(row)
  if (!isValidChatSidebarFolderAggregateRow(row)) {
    throw new Error('ChatSidebarFolderAggregateInvalid')
  }
  return row
}

export async function putChatSidebarFolderProjection(
  tx: Transaction,
  next: ChatFolder,
  previous?: ChatFolder,
): Promise<void> {
  const table = tx.table<ChatSidebarAggregateProjectionRow, string>('chatSidebarAggregates')
  const id = chatSidebarFolderAggregateId(chatSidebarFolderKey(next.id))
  const stored = await table.get(id)
  if (stored !== undefined && !isValidChatSidebarFolderAggregateRow(stored)) {
    throw new Error('ChatSidebarFolderAggregateInvalid')
  }
  if (previous && stored === undefined) throw new Error('ChatSidebarFolderAggregateMissing')
  const row = stored ? cloneFolderAggregateRow(stored) : emptyFolderAggregateRow(next)
  row.folder = { ...next }
  refreshFolderPresentationFields(row)
  if (!isValidChatSidebarFolderAggregateRow(row)) {
    throw new Error('ChatSidebarFolderAggregateInvalid')
  }
  await putPhysicalStorageRow(tx, 'chatSidebarAggregates', row, stored)
}

export async function deleteChatSidebarFolderProjection(
  tx: Transaction,
  folder: ChatFolder,
): Promise<void> {
  const table = tx.table<ChatSidebarAggregateProjectionRow, string>('chatSidebarAggregates')
  const id = chatSidebarFolderAggregateId(chatSidebarFolderKey(folder.id))
  const stored = await table.get(id)
  if (stored === undefined) throw new Error('ChatSidebarFolderAggregateMissing')
  if (!isValidChatSidebarFolderAggregateRow(stored) || stored.count !== 0) {
    throw new Error('ChatSidebarFolderAggregateDeleteInvalid')
  }
  await deletePhysicalStorageRows(tx, 'chatSidebarAggregates', [id], [stored])
}

export function publicChatSidebarRow(row: ChatSidebarProjectionRow): ChatSidebarRow {
  const {
    projectionVersion: _projectionVersion,
    checksum: _checksum,
    folderKey: _folderKey,
    archivedKey: _archivedKey,
    pinnedKey: _pinnedKey,
    visibleKey: _visibleKey,
    titleSortKey: _titleSortKey,
    ...chat
  } = row
  return { ...chat, tags: [...chat.tags] }
}

export function chatSidebarFolderKey(folderId: FolderId | null): string {
  return folderId ?? ROOT_FOLDER_KEY
}

export type ChatSidebarProjectionTransition =
  | {
      readonly kind: 'add'
      readonly next: Chat
    }
  | {
      readonly kind: 'replace'
      readonly previous: Chat
      readonly next: Chat
    }

export interface ChatSidebarProjectionMutationReceipt {
  readonly rowReadRequests: number
  readonly rowReadCount: number
  readonly mutatedRowIds: readonly ChatId[]
  readonly aggregateReadRequests: number
  readonly aggregateReadCount: number
  readonly aggregateMutations: readonly {
    readonly id: string
    readonly operation: 'write' | 'delete'
  }[]
  readonly extremaReads: readonly {
    readonly indexName: string
    readonly operation: 'query' | 'open-cursor'
    readonly requestCount: number
    readonly rowCount: number
  }[]
}

export function emptyChatSidebarProjectionMutationReceipt(): ChatSidebarProjectionMutationReceipt {
  return Object.freeze({
    rowReadRequests: 0,
    rowReadCount: 0,
    mutatedRowIds: Object.freeze([]),
    aggregateReadRequests: 0,
    aggregateReadCount: 0,
    aggregateMutations: Object.freeze([]),
    extremaReads: Object.freeze([]),
  })
}

export async function applyChatSidebarProjectionTransitions(
  tx: Transaction,
  transitions: readonly ChatSidebarProjectionTransition[],
): Promise<ChatSidebarProjectionMutationReceipt> {
  if (transitions.length === 0) return emptyChatSidebarProjectionMutationReceipt()
  const ids = new Set<ChatId>()
  const candidates: ChatSidebarProjectionCandidate[] = []
  for (const transition of transitions) {
    const id = transition.next.id
    if (ids.has(id)) throw new Error(`ChatSidebarProjectionBatchDuplicate:${id}`)
    ids.add(id)
    const next = chatSidebarProjectionRow(transition.next)
    if (transition.kind === 'add') {
      candidates.push({ expected: { kind: 'missing' }, next })
      continue
    }
    if (transition.previous.id !== id) {
      throw new Error(`ChatSidebarProjectionIdentityMismatch:${id}`)
    }
    const previous = chatSidebarProjectionRow(transition.previous)
    if (sameValue(previous, next)) continue
    candidates.push({ expected: { kind: 'exact', row: previous }, next })
  }
  return commitChatSidebarProjectionCandidates(tx, candidates)
}

type ChatSidebarProjectionCandidate = {
  readonly expected:
    | { readonly kind: 'missing' }
    | { readonly kind: 'exact'; readonly row: ChatSidebarProjectionRow }
    | { readonly kind: 'any-valid' }
  readonly next: ChatSidebarProjectionRow
}

type ChatSidebarProjectionChange = {
  readonly previous: ChatSidebarProjectionRow | undefined
  readonly next: ChatSidebarProjectionRow | undefined
}

async function commitChatSidebarProjectionCandidates(
  tx: Transaction,
  candidates: readonly ChatSidebarProjectionCandidate[],
): Promise<ChatSidebarProjectionMutationReceipt> {
  if (candidates.length === 0) return emptyChatSidebarProjectionMutationReceipt()
  const table = tx.table<ChatSidebarProjectionRow, ChatId>('chatSidebarRows')
  const currentRows = await table.bulkGet(candidates.map((candidate) => candidate.next.id))
  const changes: ChatSidebarProjectionChange[] = []
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index] as ChatSidebarProjectionCandidate
    const current = currentRows[index]
    if (current !== undefined && !isValidChatSidebarProjectionRow(current)) {
      throw new Error('ChatSidebarProjectionWriteInvariantInvalid')
    }
    if (candidate.expected.kind === 'missing' && current !== undefined) {
      throw new Error(`ChatSidebarProjectionUnexpectedExisting:${candidate.next.id}`)
    }
    if (
      candidate.expected.kind === 'exact' &&
      (current === undefined || !sameValue(current, candidate.expected.row))
    ) {
      throw new Error(`ChatSidebarProjectionPreviousMismatch:${candidate.next.id}`)
    }
    if (current !== undefined && sameValue(current, candidate.next)) continue
    changes.push({ previous: current, next: candidate.next })
  }
  if (changes.length === 0) {
    return Object.freeze({
      ...emptyChatSidebarProjectionMutationReceipt(),
      rowReadRequests: 1,
      rowReadCount: candidates.length,
    })
  }
  const { workspace, folders } = await readAffectedChatSidebarAggregates(tx, changes)
  await putPhysicalStorageRows(
    tx,
    'chatSidebarRows',
    changes.map((change) => change.next as ChatSidebarProjectionRow),
    changes.flatMap((change) => (change.previous ? [change.previous] : [])),
  )
  const delta = await applyChatSidebarProjectionDeltas(tx, changes, workspace, folders)
  return Object.freeze({
    rowReadRequests: 1,
    rowReadCount: candidates.length,
    mutatedRowIds: Object.freeze(changes.flatMap(({ next }) => (next ? [next.id] : [])).sort()),
    aggregateReadRequests: 1,
    aggregateReadCount: 1 + folders.size,
    aggregateMutations: delta.aggregateMutations,
    extremaReads: delta.extremaReads,
  })
}

export async function deleteChatSidebarProjections(
  tx: Transaction,
  deletedSourceChats: readonly Chat[],
): Promise<void> {
  const chatsById = new Map(deletedSourceChats.map((chat) => [chat.id, chat]))
  const ids = [...chatsById.keys()]
  if (ids.length === 0) return
  const table = tx.table<ChatSidebarProjectionRow, ChatId>('chatSidebarRows')
  const stored = await table.bulkGet(ids)
  const current = stored.filter((row): row is ChatSidebarProjectionRow => row !== undefined)
  const previousRows = stored.map(
    (row, index) => row ?? chatSidebarProjectionRow(chatsById.get(ids[index] as ChatId) as Chat),
  )
  if (current.some((row) => !isValidChatSidebarProjectionRow(row))) {
    throw new Error('ChatSidebarProjectionDeleteInvariantInvalid')
  }
  const changes = previousRows.map((previous) => ({ previous, next: undefined }))
  const { workspace, folders } = await readAffectedChatSidebarAggregates(tx, changes)
  if (current.length > 0) {
    await deletePhysicalStorageRows(
      tx,
      'chatSidebarRows',
      current.map((row) => row.id),
      current,
    )
  }
  await applyChatSidebarProjectionDeltas(tx, changes, workspace, folders)
  recordBrowserCommandInvalidation(tx, { kind: 'sidebar', chatIds: ids })
}

export async function rebuildChatSidebarProjectionRowsInTransaction(
  tx: Transaction,
): Promise<void> {
  const chats = tx.table<Chat, ChatId>('chats')
  const rows = tx.table<ChatSidebarProjectionRow, ChatId>('chatSidebarRows')
  const aggregates = tx.table<ChatSidebarAggregateProjectionRow, string>('chatSidebarAggregates')
  await Dexie.Promise.all([rows.clear(), aggregates.clear()])
  const accumulator = createChatSidebarAggregateAccumulator()
  const folders = tx.table<ChatFolder, FolderId>('folders')
  let afterFolderId: FolderId | undefined
  for (;;) {
    const batch: ChatFolder[] = []
    let lastPrimaryKey: FolderId | undefined
    const collection =
      afterFolderId === undefined
        ? folders.orderBy(':id')
        : folders.where(':id').above(afterFolderId)
    await collection.limit(REBUILD_BATCH_SIZE).each((folder, cursor) => {
      batch.push(folder)
      lastPrimaryKey = cursor.primaryKey
    })
    if (batch.length === 0) break
    accumulateChatSidebarFolderRows(accumulator, batch)
    if (batch.length < REBUILD_BATCH_SIZE) break
    if (lastPrimaryKey === undefined) throw new Error('ChatSidebarFolderPrimaryKeyMissing')
    afterFolderId = lastPrimaryKey
  }
  let after: ChatId | undefined
  for (;;) {
    const batch: Chat[] = []
    let lastPrimaryKey: ChatId | undefined
    const collection = after === undefined ? chats.orderBy(':id') : chats.where(':id').above(after)
    await collection.limit(REBUILD_BATCH_SIZE).each((chat, cursor) => {
      batch.push(chat)
      lastPrimaryKey = cursor.primaryKey
    })
    if (batch.length === 0) break
    const projected = batch.map(chatSidebarProjectionRow)
    await rows.bulkAdd(projected)
    accumulateChatSidebarAggregateRows(accumulator, projected)
    if (batch.length < REBUILD_BATCH_SIZE) break
    if (lastPrimaryKey === undefined) throw new Error('ChatSidebarProjectionPrimaryKeyMissing')
    after = lastPrimaryKey
  }
  const aggregateRows = materializeChatSidebarAggregateRows(accumulator)
  for (let start = 0; start < aggregateRows.length; start += REBUILD_BATCH_SIZE) {
    await aggregates.bulkAdd(aggregateRows.slice(start, start + REBUILD_BATCH_SIZE))
  }
}

async function readAffectedChatSidebarAggregates(
  tx: Transaction,
  changes: readonly ChatSidebarProjectionChange[],
): Promise<{
  readonly workspace: ChatSidebarWorkspaceAggregateRow
  readonly folders: ReadonlyMap<string, ChatSidebarFolderAggregateRow | undefined>
}> {
  const rows = changes.flatMap(({ previous, next }) => [previous, next])
  const folderKeys = [
    ...new Set(
      rows.flatMap((row) => (row && row.folderKey !== ROOT_FOLDER_KEY ? [row.folderKey] : [])),
    ),
  ]
  const table = tx.table<ChatSidebarAggregateProjectionRow, string>('chatSidebarAggregates')
  const aggregates = await table.bulkGet([
    CHAT_SIDEBAR_AGGREGATE_ID,
    ...folderKeys.map(chatSidebarFolderAggregateId),
  ])
  const workspace = aggregates[0]
  if (!isValidChatSidebarWorkspaceAggregateRow(workspace)) {
    throw new Error('ChatSidebarProjectionWriteInvariantInvalid')
  }
  const folders = new Map<string, ChatSidebarFolderAggregateRow | undefined>()
  for (let index = 0; index < folderKeys.length; index += 1) {
    const folderKey = folderKeys[index] as string
    const aggregate = aggregates[index + 1]
    const hasExistingProjectedRow = changes.some(
      ({ previous }) => previous?.folderKey === folderKey,
    )
    if (aggregate === undefined) {
      if (hasExistingProjectedRow) {
        throw new Error('ChatSidebarProjectionWriteInvariantInvalid')
      }
      folders.set(folderKey, undefined)
      continue
    }
    if (!isValidChatSidebarFolderAggregateRow(aggregate)) {
      throw new Error('ChatSidebarProjectionWriteInvariantInvalid')
    }
    folders.set(folderKey, aggregate)
  }
  return { workspace, folders }
}

async function applyChatSidebarProjectionDeltas(
  tx: Transaction,
  changes: readonly ChatSidebarProjectionChange[],
  currentWorkspace?: ChatSidebarWorkspaceAggregateRow,
  currentFolders?: ReadonlyMap<string, ChatSidebarFolderAggregateRow | undefined>,
): Promise<{
  readonly aggregateMutations: ChatSidebarProjectionMutationReceipt['aggregateMutations']
  readonly extremaReads: ChatSidebarProjectionMutationReceipt['extremaReads']
}> {
  if (changes.length === 0) {
    return { aggregateMutations: Object.freeze([]), extremaReads: Object.freeze([]) }
  }
  const table = tx.table<ChatSidebarAggregateProjectionRow, string>('chatSidebarAggregates')
  const current = currentWorkspace ?? (await table.get(CHAT_SIDEBAR_AGGREGATE_ID))
  if (!isValidChatSidebarWorkspaceAggregateRow(current)) {
    throw new Error('ChatSidebarAggregateInvalid')
  }
  const updated: ChatSidebarWorkspaceAggregateRow = { ...current }
  const folderChanges = new Map<
    string,
    Array<{
      previous: ChatSidebarProjectionRow | undefined
      next: ChatSidebarProjectionRow | undefined
    }>
  >()
  for (const { previous, next } of changes) {
    if (previous) {
      addWorkspaceContribution(updated, previous, -1)
      if (previous.folderKey !== ROOT_FOLDER_KEY) {
        const list = folderChanges.get(previous.folderKey) ?? []
        list.push({ previous, next: next?.folderKey === previous.folderKey ? next : undefined })
        folderChanges.set(previous.folderKey, list)
      }
    }
    if (next) {
      addWorkspaceContribution(updated, next, 1)
      if (next.folderKey !== ROOT_FOLDER_KEY && next.folderKey !== previous?.folderKey) {
        const list = folderChanges.get(next.folderKey) ?? []
        list.push({ previous: undefined, next })
        folderChanges.set(next.folderKey, list)
      }
    }
  }
  if (!isValidChatSidebarWorkspaceAggregateRow(updated)) {
    throw new Error('ChatSidebarAggregateDeltaInvalid')
  }
  const aggregateMutations: Array<{
    readonly id: string
    readonly operation: 'write' | 'delete'
  }> = []
  const extremaReads: Array<ChatSidebarProjectionMutationReceipt['extremaReads'][number]> = []
  if (!sameValue(updated, current)) {
    await putPhysicalStorageRow(tx, 'chatSidebarAggregates', updated, current)
    aggregateMutations.push({ id: updated.id, operation: 'write' })
  }
  if (folderChanges.size === 0) {
    return {
      aggregateMutations: Object.freeze(aggregateMutations),
      extremaReads: Object.freeze(extremaReads),
    }
  }
  const entries = [...folderChanges]
  const ids = entries.map(([folderKey]) => chatSidebarFolderAggregateId(folderKey))
  const storedFolders = currentFolders
    ? entries.map(([folderKey]) => currentFolders.get(folderKey))
    : await table.bulkGet(ids)
  const puts: ChatSidebarFolderAggregateRow[] = []
  const replaced: ChatSidebarFolderAggregateRow[] = []
  for (let index = 0; index < entries.length; index += 1) {
    const [folderKey, groupedChanges] = entries[index] as [
      string,
      Array<{
        previous: ChatSidebarProjectionRow | undefined
        next: ChatSidebarProjectionRow | undefined
      }>,
    ]
    const stored = storedFolders[index]
    if (stored !== undefined && !isValidChatSidebarFolderAggregateRow(stored)) {
      throw new Error('ChatSidebarFolderAggregateInvalid')
    }
    if (!stored) throw new Error('ChatSidebarFolderAggregateMissing')
    const nextAggregate = cloneFolderAggregateRow(stored)
    let removedExtremum = false
    for (const change of groupedChanges) {
      if (change.previous) {
        removedExtremum ||=
          isVisibleSidebarRow(change.previous) &&
          rowTouchesSortExtrema(nextAggregate.sortExtrema, change.previous)
        addFolderContribution(nextAggregate, change.previous, -1)
      }
      if (change.next) addFolderContribution(nextAggregate, change.next, 1)
    }
    if (!Number.isSafeInteger(nextAggregate.count) || nextAggregate.count < 0) {
      throw new Error('ChatSidebarFolderAggregateDeltaInvalid')
    }
    if (nextAggregate.count === 0) {
      nextAggregate.sortExtrema = null
      refreshFolderPresentationFields(nextAggregate)
      puts.push(nextAggregate)
      replaced.push(stored)
      continue
    }
    if (nextAggregate.visibleCount === 0) {
      nextAggregate.sortExtrema = null
    } else if (removedExtremum) {
      const read = await readFolderSortExtrema(tx, folderKey)
      nextAggregate.sortExtrema = read.extrema
      extremaReads.push(...read.reads)
    } else {
      for (const change of groupedChanges) {
        if (change.next && isVisibleSidebarRow(change.next)) {
          includeRowInSortExtrema(nextAggregate, change.next)
        }
      }
    }
    refreshFolderPresentationFields(nextAggregate)
    if (!isValidChatSidebarFolderAggregateRow(nextAggregate)) {
      throw new Error('ChatSidebarFolderAggregateDeltaInvalid')
    }
    puts.push(nextAggregate)
    replaced.push(stored)
  }
  await putPhysicalStorageRows(tx, 'chatSidebarAggregates', puts, replaced)
  aggregateMutations.push(...puts.map((row) => ({ id: row.id, operation: 'write' as const })))
  return {
    aggregateMutations: Object.freeze(
      aggregateMutations.sort((left, right) => left.id.localeCompare(right.id)),
    ),
    extremaReads: Object.freeze(extremaReads),
  }
}

function addWorkspaceContribution(
  aggregate: ChatSidebarWorkspaceAggregateRow,
  row: ChatSidebarProjectionRow,
  direction: -1 | 1,
): void {
  aggregate.totalCount += direction
  aggregate.activeCount += row.archived ? 0 : direction
  aggregate.archivedCount += row.archived ? direction : 0
  aggregate.pinnedCount += row.pinned ? direction : 0
  aggregate.visibleCount += isVisibleSidebarRow(row) ? direction : 0
  aggregate.visiblePinnedCount += isVisibleSidebarRow(row) && row.pinned ? direction : 0
  aggregate.rootCount += row.folderKey === ROOT_FOLDER_KEY ? direction : 0
  aggregate.rootVisibleCount +=
    row.folderKey === ROOT_FOLDER_KEY && isVisibleSidebarRow(row) ? direction : 0
  aggregate.rootVisiblePinnedCount +=
    row.folderKey === ROOT_FOLDER_KEY && isVisibleSidebarRow(row) && row.pinned ? direction : 0
}

function emptyFolderAggregateRow(folder: ChatFolder): ChatSidebarFolderAggregateRow {
  return chatSidebarFolderAggregateRow(folder)
}

function cloneFolderAggregateRow(
  row: ChatSidebarFolderAggregateRow,
): ChatSidebarFolderAggregateRow {
  return {
    ...row,
    folder: { ...row.folder },
    sortExtrema: row.sortExtrema
      ? {
          updatedAt: { ...row.sortExtrema.updatedAt },
          createdAt: { ...row.sortExtrema.createdAt },
          lastViewedAt: { ...row.sortExtrema.lastViewedAt },
          totalCostUsd: { ...row.sortExtrema.totalCostUsd },
          wordCount: { ...row.sortExtrema.wordCount },
          title: { ...row.sortExtrema.title },
        }
      : null,
  }
}

function refreshFolderPresentationFields(row: ChatSidebarFolderAggregateRow): void {
  const pinned = row.visiblePinnedCount > 0
  row.folderNameKey = chatSidebarFolderNameKey(row.folder.name)
  row.folderSortIndex = row.folder.sortIndex
  row.folderTitleSortKey = sidebarTitleSortKey(row.folder.name)
  row.presentationPinnedAsc = pinned ? 0 : 1
  row.presentationPinnedDesc = pinned ? 1 : 0
  row.updatedAtAsc = folderPresentationPrimary(row, 'updatedAt', 'asc') as number
  row.updatedAtDesc = folderPresentationPrimary(row, 'updatedAt', 'desc') as number
  row.createdAtAsc = folderPresentationPrimary(row, 'createdAt', 'asc') as number
  row.createdAtDesc = folderPresentationPrimary(row, 'createdAt', 'desc') as number
  row.lastViewedAtAsc = folderPresentationPrimary(row, 'lastViewedAt', 'asc') as number
  row.lastViewedAtDesc = folderPresentationPrimary(row, 'lastViewedAt', 'desc') as number
  row.totalCostUsdAsc = folderPresentationPrimary(row, 'totalCostUsd', 'asc') as number
  row.totalCostUsdDesc = folderPresentationPrimary(row, 'totalCostUsd', 'desc') as number
  row.wordCountAsc = folderPresentationPrimary(row, 'wordCount', 'asc') as number
  row.wordCountDesc = folderPresentationPrimary(row, 'wordCount', 'desc') as number
  row.titleAsc = folderPresentationPrimary(row, 'title', 'asc') as string
  row.titleDesc = folderPresentationPrimary(row, 'title', 'desc') as string
}

function folderPresentationPrimary(
  row: ChatSidebarFolderAggregateRow,
  field: SidebarSortField,
  direction: 'asc' | 'desc',
): number | string {
  const extrema = row.sortExtrema?.[field]
  if (extrema) return extrema[direction === 'asc' ? 'min' : 'max']
  switch (field) {
    case 'updatedAt':
      return finiteOrFallback(row.folder.updatedAt, row.folder.createdAt)
    case 'createdAt':
      return finiteOrFallback(row.folder.createdAt, row.folder.updatedAt)
    case 'lastViewedAt':
      return finiteOrFallback(row.folder.lastUsedAt, row.folder.updatedAt)
    case 'totalCostUsd':
    case 'wordCount':
      return 0
    case 'title':
      return row.folderTitleSortKey
  }
}

function isValidFolderPresentationFields(row: Partial<ChatSidebarFolderAggregateRow>): boolean {
  if (!row.folder || typeof row.folder !== 'object') return false
  if (row.folder.id !== row.folderKey) return false
  const expected = cloneFolderAggregateRowUnchecked(row as ChatSidebarFolderAggregateRow)
  refreshFolderPresentationFields(expected)
  return (
    row.folderNameKey === expected.folderNameKey &&
    row.folderSortIndex === expected.folderSortIndex &&
    row.folderTitleSortKey === expected.folderTitleSortKey &&
    row.presentationPinnedAsc === expected.presentationPinnedAsc &&
    row.presentationPinnedDesc === expected.presentationPinnedDesc &&
    row.updatedAtAsc === expected.updatedAtAsc &&
    row.updatedAtDesc === expected.updatedAtDesc &&
    row.createdAtAsc === expected.createdAtAsc &&
    row.createdAtDesc === expected.createdAtDesc &&
    row.lastViewedAtAsc === expected.lastViewedAtAsc &&
    row.lastViewedAtDesc === expected.lastViewedAtDesc &&
    row.totalCostUsdAsc === expected.totalCostUsdAsc &&
    row.totalCostUsdDesc === expected.totalCostUsdDesc &&
    row.wordCountAsc === expected.wordCountAsc &&
    row.wordCountDesc === expected.wordCountDesc &&
    row.titleAsc === expected.titleAsc &&
    row.titleDesc === expected.titleDesc
  )
}

function cloneFolderAggregateRowUnchecked(
  row: ChatSidebarFolderAggregateRow,
): ChatSidebarFolderAggregateRow {
  return {
    ...row,
    folder: { ...row.folder },
    sortExtrema: row.sortExtrema
      ? {
          updatedAt: { ...row.sortExtrema.updatedAt },
          createdAt: { ...row.sortExtrema.createdAt },
          lastViewedAt: { ...row.sortExtrema.lastViewedAt },
          totalCostUsd: { ...row.sortExtrema.totalCostUsd },
          wordCount: { ...row.sortExtrema.wordCount },
          title: { ...row.sortExtrema.title },
        }
      : null,
  }
}

function addFolderContribution(
  aggregate: ChatSidebarFolderAggregateRow,
  row: ChatSidebarProjectionRow,
  direction: -1 | 1,
): void {
  aggregate.count += direction
  aggregate.activeCount += row.archived ? 0 : direction
  aggregate.visibleCount += isVisibleSidebarRow(row) ? direction : 0
  aggregate.visiblePinnedCount += isVisibleSidebarRow(row) && row.pinned ? direction : 0
}

function isVisibleSidebarRow(row: ChatSidebarProjectionRow): boolean {
  return row.visibleKey === 1
}

function includeRowInSortExtrema(
  aggregate: ChatSidebarFolderAggregateRow,
  row: ChatSidebarProjectionRow,
): void {
  const values = sidebarSortValues(row)
  if (!aggregate.sortExtrema) {
    aggregate.sortExtrema = {
      updatedAt: { min: values.updatedAt, max: values.updatedAt },
      createdAt: { min: values.createdAt, max: values.createdAt },
      lastViewedAt: { min: values.lastViewedAt, max: values.lastViewedAt },
      totalCostUsd: { min: values.totalCostUsd, max: values.totalCostUsd },
      wordCount: { min: values.wordCount, max: values.wordCount },
      title: { min: values.title, max: values.title },
    }
    return
  }
  includeNumericExtremum(aggregate.sortExtrema.updatedAt, values.updatedAt)
  includeNumericExtremum(aggregate.sortExtrema.createdAt, values.createdAt)
  includeNumericExtremum(aggregate.sortExtrema.lastViewedAt, values.lastViewedAt)
  includeNumericExtremum(aggregate.sortExtrema.totalCostUsd, values.totalCostUsd)
  includeNumericExtremum(aggregate.sortExtrema.wordCount, values.wordCount)
  includeStringExtremum(aggregate.sortExtrema.title, values.title)
}

function includeNumericExtremum(extremum: SidebarSortExtremum<number>, value: number): void {
  if (value < extremum.min) extremum.min = value
  if (value > extremum.max) extremum.max = value
}

function includeStringExtremum(extremum: SidebarSortExtremum<string>, value: string): void {
  if (value < extremum.min) extremum.min = value
  if (value > extremum.max) extremum.max = value
}

function rowTouchesSortExtrema(
  extrema: SidebarSortExtrema | null,
  row: ChatSidebarProjectionRow,
): boolean {
  if (!extrema) return false
  const values = sidebarSortValues(row)
  return (
    touchesExtremum(extrema.updatedAt, values.updatedAt) ||
    touchesExtremum(extrema.createdAt, values.createdAt) ||
    touchesExtremum(extrema.lastViewedAt, values.lastViewedAt) ||
    touchesExtremum(extrema.totalCostUsd, values.totalCostUsd) ||
    touchesExtremum(extrema.wordCount, values.wordCount) ||
    touchesExtremum(extrema.title, values.title)
  )
}

function touchesExtremum<T extends number | string>(
  extremum: SidebarSortExtremum<T>,
  value: T,
): boolean {
  return value === extremum.min || value === extremum.max
}

function sidebarSortValues(row: ChatSidebarProjectionRow): {
  updatedAt: number
  createdAt: number
  lastViewedAt: number
  totalCostUsd: number
  wordCount: number
  title: string
} {
  return {
    updatedAt: finiteOrZero(row.updatedAt),
    createdAt: finiteOrFallback(row.createdAt, row.updatedAt),
    lastViewedAt: finiteOrFallback(row.lastViewedAt, row.updatedAt),
    totalCostUsd: finiteOrZero(row.totalCostUsd),
    wordCount: finiteOrZero(row.wordCount),
    title: row.titleSortKey,
  }
}

function finiteOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function finiteOrFallback(value: unknown, fallback: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : finiteOrZero(fallback)
}

async function readFolderSortExtrema(
  tx: Transaction,
  folderKey: string,
): Promise<{
  readonly extrema: SidebarSortExtrema
  readonly reads: ChatSidebarProjectionMutationReceipt['extremaReads']
}> {
  const table = tx.table<ChatSidebarProjectionRow, ChatId>('chatSidebarRows')
  const [updatedAt, createdAt, lastViewedAt, totalCostUsd, wordCount, title] =
    await Dexie.Promise.all([
      readFolderFieldExtremum<number>(
        table,
        folderKey,
        'updatedAt',
        '[folderKey+visibleKey+pinnedKey+updatedAt+titleSortKey+id]',
      ),
      readFolderFieldExtremum<number>(
        table,
        folderKey,
        'createdAt',
        '[folderKey+visibleKey+pinnedKey+createdAt+titleSortKey+id]',
      ),
      readFolderFieldExtremum<number>(
        table,
        folderKey,
        'lastViewedAt',
        '[folderKey+visibleKey+pinnedKey+lastViewedAt+titleSortKey+id]',
      ),
      readFolderFieldExtremum<number>(
        table,
        folderKey,
        'totalCostUsd',
        '[folderKey+visibleKey+pinnedKey+totalCostUsd+titleSortKey+id]',
      ),
      readFolderFieldExtremum<number>(
        table,
        folderKey,
        'wordCount',
        '[folderKey+visibleKey+pinnedKey+wordCount+titleSortKey+id]',
      ),
      readFolderFieldExtremum<string>(
        table,
        folderKey,
        'title',
        '[folderKey+visibleKey+pinnedKey+titleSortKey+id]',
      ),
    ])
  return {
    extrema: {
      updatedAt: updatedAt.extremum,
      createdAt: createdAt.extremum,
      lastViewedAt: lastViewedAt.extremum,
      totalCostUsd: totalCostUsd.extremum,
      wordCount: wordCount.extremum,
      title: title.extremum,
    },
    reads: Object.freeze(
      [updatedAt, createdAt, lastViewedAt, totalCostUsd, wordCount, title].flatMap(
        ({ reads }) => reads,
      ),
    ),
  }
}

async function readFolderFieldExtremum<T extends number | string>(
  table: Table<ChatSidebarProjectionRow, ChatId>,
  folderKey: string,
  field: SidebarSortField,
  indexName: string,
): Promise<{
  readonly extremum: SidebarSortExtremum<T>
  readonly reads: ChatSidebarProjectionMutationReceipt['extremaReads']
}> {
  const results = await Dexie.Promise.all(
    ([0, 1] as const).flatMap((pinnedKey) => {
      const collection = table
        .where(indexName)
        .between(...exactCompoundPrefixBetween([folderKey, 1, pinnedKey]))
      return [collection.first(), collection.last()]
    }),
  )
  const rows = results.filter((row): row is ChatSidebarProjectionRow => row !== undefined)
  const first = rows[0]
  if (!first) throw new Error('ChatSidebarFolderExtremumMissing')
  let min = sidebarSortValues(first)[field] as T
  let max = min
  for (const row of rows.slice(1)) {
    const value = sidebarSortValues(row)[field] as T
    if (value < min) min = value
    if (value > max) max = value
  }
  return {
    extremum: { min, max },
    reads: Object.freeze([
      {
        indexName,
        operation: 'query',
        requestCount: 2,
        rowCount: results.filter((row, index) => index % 2 === 0 && row !== undefined).length,
      },
      {
        indexName,
        operation: 'open-cursor',
        requestCount: 2,
        rowCount: results.filter((row, index) => index % 2 === 1 && row !== undefined).length,
      },
    ]),
  }
}

function isValidChatSidebarSortExtrema(value: unknown): value is SidebarSortExtrema {
  if (!value || typeof value !== 'object') return false
  const extrema = value as Partial<SidebarSortExtrema>
  const numeric = [
    extrema.updatedAt,
    extrema.createdAt,
    extrema.lastViewedAt,
    extrema.totalCostUsd,
    extrema.wordCount,
  ]
  if (
    numeric.some(
      (item) =>
        !item || !Number.isFinite(item.min) || !Number.isFinite(item.max) || item.min > item.max,
    )
  ) {
    return false
  }
  return (
    typeof extrema.title?.min === 'string' &&
    typeof extrema.title.max === 'string' &&
    extrema.title.min <= extrema.title.max
  )
}

function chatSidebarFolderAggregateId(folderKey: string): string {
  return `folder:${folderKey}`
}

function sidebarRowChecksum(row: ChatSidebarRow): string {
  const serialized = JSON.stringify([
    row.id,
    row.title,
    row.titleStatus,
    row.createdAt,
    row.updatedAt,
    row.lastViewedAt,
    row.wordCount,
    row.totalCostUsd,
    row.lastUpdatedLeafId,
    row.lastBranchUpdatedAt,
    row.archived,
    row.pinned,
    row.folderId,
    row.tags,
    row.previewText ?? null,
  ])
  let hash = 0x811c9dc5
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}
