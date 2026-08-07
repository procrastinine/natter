import {
  BROWSER_WORKSPACE_CURRENT_COMPLETION_KEY as PREVIOUS_COMPLETION_KEY,
  WAVE_B_V97_STORES,
} from './browser-workspace-schema-v97'
import type { SettingsRow } from './db-rows'

export const WAVE_C_STORAGE_VERSION = 98
export const BROWSER_WORKSPACE_CURRENT_COMPLETION_KEY = 'backfill:browser-workspace-current-v98'

const BROWSER_WORKSPACE_CURRENT_COMPLETION_VALUE = Object.freeze({
  formatVersion: 4,
  storageVersion: WAVE_C_STORAGE_VERSION,
  phase: 'canonical-and-derived-complete',
})

const CHAT_SIDEBAR_FOLDER_PRESENTATION_INDEXES = [
  '[folderNameKey+folderSortIndex+folderTitleSortKey+folderKey]',
  '[folderSortIndex+folderTitleSortKey+folderKey]',
  '[kind+presentationPinnedAsc+updatedAtAsc+folderTitleSortKey+folderKey]',
  '[kind+presentationPinnedDesc+updatedAtDesc+folderTitleSortKey+folderKey]',
  '[kind+presentationPinnedAsc+createdAtAsc+folderTitleSortKey+folderKey]',
  '[kind+presentationPinnedDesc+createdAtDesc+folderTitleSortKey+folderKey]',
  '[kind+presentationPinnedAsc+lastViewedAtAsc+folderTitleSortKey+folderKey]',
  '[kind+presentationPinnedDesc+lastViewedAtDesc+folderTitleSortKey+folderKey]',
  '[kind+presentationPinnedAsc+totalCostUsdAsc+folderTitleSortKey+folderKey]',
  '[kind+presentationPinnedDesc+totalCostUsdDesc+folderTitleSortKey+folderKey]',
  '[kind+presentationPinnedAsc+wordCountAsc+folderTitleSortKey+folderKey]',
  '[kind+presentationPinnedDesc+wordCountDesc+folderTitleSortKey+folderKey]',
  '[kind+presentationPinnedAsc+titleAsc+folderTitleSortKey+folderKey]',
  '[kind+presentationPinnedDesc+titleDesc+folderTitleSortKey+folderKey]',
].join(', ')

export const WAVE_C_V98_STORES = Object.freeze({
  ...WAVE_B_V97_STORES,
  chatSidebarAggregates: `&id, kind, ${CHAT_SIDEBAR_FOLDER_PRESENTATION_INDEXES}`,
  presets: '&id, name',
})

export function browserWorkspaceCurrentCompletionSettingV98(): SettingsRow {
  return {
    key: BROWSER_WORKSPACE_CURRENT_COMPLETION_KEY,
    value: BROWSER_WORKSPACE_CURRENT_COMPLETION_VALUE,
  }
}

export function isBrowserWorkspaceCurrentCompletionValueV98(value: unknown): boolean {
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

export const BROWSER_WORKSPACE_PREVIOUS_COMPLETION_KEY = PREVIOUS_COMPLETION_KEY
