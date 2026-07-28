import { WAVE_A_V94_STORES } from './browser-workspace-schema-v94'
import type { SettingsRow } from './db-rows'
import {
  BROWSER_WORKSPACE_CATCHUP_JOURNAL_TABLE_NAMES,
  type BrowserWorkspaceCatchupJournalTableName,
} from './physical-storage-tables'

export const WAVE_B_STORAGE_VERSION = 97
export const BROWSER_WORKSPACE_CURRENT_COMPLETION_KEY = 'backfill:browser-workspace-current-v97'

const BROWSER_WORKSPACE_CURRENT_COMPLETION_VALUE = Object.freeze({
  formatVersion: 3,
  storageVersion: WAVE_B_STORAGE_VERSION,
  phase: 'canonical-and-derived-complete',
})

const BROWSER_WORKSPACE_CATCHUP_JOURNAL_STORES = Object.freeze(
  Object.fromEntries(
    BROWSER_WORKSPACE_CATCHUP_JOURNAL_TABLE_NAMES.map((tableName) => [tableName, '&id']),
  ) as Readonly<Record<BrowserWorkspaceCatchupJournalTableName, '&id'>>,
)

export const WAVE_B_V97_STORES = Object.freeze({
  ...WAVE_A_V94_STORES,
  attachmentRefEdges:
    '&[ownerKind+ownerId+refId], attachmentId, [attachmentId+ownerKind], [attachmentId+chatId], [attachmentId+ownerKind+ownerId+refId], [ownerKind+ownerId], chatId',
  configurationLinks: '&id, ownerKey, targetKey, [targetKey+id]',
  ...BROWSER_WORKSPACE_CATCHUP_JOURNAL_STORES,
})

export function browserWorkspaceCurrentCompletionSettingV97(): SettingsRow {
  return {
    key: BROWSER_WORKSPACE_CURRENT_COMPLETION_KEY,
    value: BROWSER_WORKSPACE_CURRENT_COMPLETION_VALUE,
  }
}

export function isBrowserWorkspaceCurrentCompletionValueV97(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const candidate = value as {
    readonly formatVersion?: unknown
    readonly storageVersion?: unknown
    readonly phase?: unknown
  }
  return (
    candidate.formatVersion === BROWSER_WORKSPACE_CURRENT_COMPLETION_VALUE.formatVersion &&
    candidate.storageVersion === BROWSER_WORKSPACE_CURRENT_COMPLETION_VALUE.storageVersion &&
    candidate.phase === BROWSER_WORKSPACE_CURRENT_COMPLETION_VALUE.phase
  )
}
