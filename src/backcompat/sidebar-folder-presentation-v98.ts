import type { Table } from 'dexie'
import type { SidebarSortExtrema } from '../core/sidebar-sort'
import type { ChatFolder, FolderId } from '../core/types'
import { errorHasName } from '../lib/error'
import type { BrowserWorkspaceMigrationProgress } from '../store/browser-workspace-open-contract'
import { BROWSER_WORKSPACE_CURRENT_COMPLETION_KEY as PREVIOUS_COMPLETION_KEY } from '../store/browser-workspace-schema-v97'
import { browserWorkspaceCurrentCompletionSettingV98 } from '../store/browser-workspace-schema-v98'
import {
  CHAT_SIDEBAR_AGGREGATE_ID,
  type ChatSidebarFolderAggregateSummary,
  chatSidebarFolderAggregateRow,
  chatSidebarFolderKey,
  chatSidebarProjectionBackfillMarker,
  currentChatSidebarWorkspaceAggregateRow,
  isValidChatSidebarFolderAggregateRow,
  isValidChatSidebarWorkspaceAggregateRow,
} from '../store/chat-sidebar-projection'
import type { SettingsRow } from '../store/db-rows'
import { estimateStoredValueBytes } from '../store/storage-size-estimate'

const MIGRATION_PAGE_SIZE = 128

interface LegacyWorkspaceAggregateV97 {
  readonly id: typeof CHAT_SIDEBAR_AGGREGATE_ID
  readonly kind: 'workspace'
  readonly projectionVersion: 2
  readonly totalCount: number
  readonly activeCount: number
  readonly archivedCount: number
  readonly pinnedCount: number
  readonly visibleCount: number
  readonly visiblePinnedCount: number
  readonly rootCount: number
  readonly rootVisibleCount: number
  readonly rootVisiblePinnedCount: number
}

interface LegacyFolderAggregateV97 extends ChatSidebarFolderAggregateSummary {
  readonly id: string
  readonly kind: 'folder'
  readonly projectionVersion: 2
  readonly folderKey: string
  readonly sortExtrema: SidebarSortExtrema | null
}

export interface SidebarFolderPresentationAccessV98 {
  readonly aggregates: Table<unknown, string>
  readonly folders: Table<ChatFolder, FolderId>
  readonly settings: Table<SettingsRow, string>
}

export async function migrateSidebarFolderPresentationV98(
  access: SidebarFolderPresentationAccessV98,
  reportProgress?: (progress: BrowserWorkspaceMigrationProgress) => void,
  options: { readonly rebuildLegacyProjection?: () => Promise<void> } = {},
): Promise<void> {
  const { aggregates, folders, settings } = access
  const workspace = await runSidebarFolderMigrationOperation('read-workspace-aggregate', () =>
    aggregates.get(CHAT_SIDEBAR_AGGREGATE_ID),
  )
  let processedRows = workspace === undefined ? 0 : 1
  let processedBytes = workspace === undefined ? 0 : estimateStoredValueBytes(workspace)
  reportProgress?.({
    phase: 'derived-state',
    operation: 'migrate-sidebar-folder-presentation',
    processedRows,
    processedBytes,
  })
  if (isLegacyWorkspaceAggregateV97(workspace)) {
    const { projectionVersion: _projectionVersion, ...workspaceCounts } = workspace
    await runSidebarFolderMigrationOperation('write-workspace-aggregate', () =>
      aggregates.put(currentChatSidebarWorkspaceAggregateRow(workspaceCounts)),
    )
  } else if (!isValidChatSidebarWorkspaceAggregateRow(workspace)) {
    const rebuildLegacyProjection = options.rebuildLegacyProjection
    if (!rebuildLegacyProjection) {
      throw new Error('ChatSidebarLegacyWorkspaceAggregateInvalid')
    }
    await runSidebarFolderMigrationOperation('rebuild-legacy-projection', () =>
      rebuildLegacyProjection(),
    )
    await runSidebarFolderMigrationOperation('write-completion-settings', () =>
      writeCompletionSettings(settings),
    )
    reportProgress?.({
      phase: 'completion-markers-write',
      operation: 'write-sidebar-folder-completion',
      processedRows,
      processedBytes,
    })
    return
  }

  let after: FolderId | undefined
  for (;;) {
    const page = await runSidebarFolderMigrationOperation('read-folder-page', () =>
      (after === undefined ? folders.orderBy(':id') : folders.where(':id').above(after))
        .limit(MIGRATION_PAGE_SIZE)
        .toArray(),
    )
    if (page.length === 0) break
    const stored = await runSidebarFolderMigrationOperation('read-folder-aggregates', () =>
      aggregates.bulkGet(page.map((folder) => `folder:${chatSidebarFolderKey(folder.id)}`)),
    )
    const current = page.map((folder, index) => {
      const legacy = stored[index]
      if (legacy === undefined) return chatSidebarFolderAggregateRow(folder)
      if (isLegacyFolderAggregateV97(legacy, folder.id)) {
        return chatSidebarFolderAggregateRow(folder, legacy)
      }
      if (!isValidChatSidebarFolderAggregateRow(legacy) || legacy.folderKey !== folder.id) {
        throw new Error(`ChatSidebarLegacyFolderAggregateInvalid:${folder.id}`)
      }
      return chatSidebarFolderAggregateRow(folder, legacy)
    })
    await runSidebarFolderMigrationOperation('write-folder-aggregates', () =>
      aggregates.bulkPut(current),
    )
    processedRows += page.length
    processedBytes = page.reduce(
      (total, folder) =>
        Math.min(Number.MAX_SAFE_INTEGER, total + estimateStoredValueBytes(folder)),
      processedBytes,
    )
    reportProgress?.({
      phase: 'derived-state',
      operation: 'migrate-sidebar-folder-presentation',
      processedRows,
      processedBytes,
    })
    if (page.length < MIGRATION_PAGE_SIZE) break
    after = page.at(-1)?.id
    if (!after) throw new Error('ChatSidebarFolderMigrationCursorMissing')
  }
  await runSidebarFolderMigrationOperation('write-completion-settings', () =>
    writeCompletionSettings(settings),
  )
  reportProgress?.({
    phase: 'completion-markers-write',
    operation: 'write-sidebar-folder-completion',
    processedRows,
    processedBytes,
  })
}

async function runSidebarFolderMigrationOperation<Result>(
  operation: string,
  run: () => Promise<Result>,
): Promise<Result> {
  try {
    return await run()
  } catch (error) {
    if (errorHasName(error, 'TransactionInactiveError')) {
      throw new Error(`SidebarFolderMigrationTransactionInactive:${operation}`, { cause: error })
    }
    throw error
  }
}

async function writeCompletionSettings(settings: Table<SettingsRow, string>): Promise<void> {
  await settings.delete(PREVIOUS_COMPLETION_KEY)
  await settings.bulkPut([
    chatSidebarProjectionBackfillMarker(),
    browserWorkspaceCurrentCompletionSettingV98(),
  ])
}

function isLegacyWorkspaceAggregateV97(value: unknown): value is LegacyWorkspaceAggregateV97 {
  if (!value || typeof value !== 'object') return false
  const row = value as Partial<LegacyWorkspaceAggregateV97>
  return (
    row.id === CHAT_SIDEBAR_AGGREGATE_ID &&
    row.kind === 'workspace' &&
    row.projectionVersion === 2 &&
    validCount(row.totalCount) &&
    validCount(row.activeCount) &&
    validCount(row.archivedCount) &&
    validCount(row.pinnedCount) &&
    validCount(row.visibleCount) &&
    validCount(row.visiblePinnedCount) &&
    validCount(row.rootCount) &&
    validCount(row.rootVisibleCount) &&
    validCount(row.rootVisiblePinnedCount)
  )
}

function isLegacyFolderAggregateV97(
  value: unknown,
  folderId: FolderId,
): value is LegacyFolderAggregateV97 {
  if (!value || typeof value !== 'object') return false
  const row = value as Partial<LegacyFolderAggregateV97>
  return (
    row.id === `folder:${folderId}` &&
    row.kind === 'folder' &&
    row.projectionVersion === 2 &&
    row.folderKey === folderId &&
    validCount(row.count) &&
    validCount(row.activeCount) &&
    validCount(row.visibleCount) &&
    validCount(row.visiblePinnedCount) &&
    row.activeCount <= row.count &&
    row.visibleCount <= row.activeCount &&
    row.visiblePinnedCount <= row.visibleCount &&
    (row.visibleCount === 0 ? row.sortExtrema === null : row.sortExtrema !== null)
  )
}

function validCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}
