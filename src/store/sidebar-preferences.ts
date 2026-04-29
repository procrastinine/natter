import {
  DEFAULT_SIDEBAR_SORT_MODE,
  parseSidebarSortMode,
  type SidebarSortMode,
} from '../core/sidebar-sort'
import type { FolderId } from '../core/types'
import { getSetting, setSetting, updateSetting } from './settings'

export const SIDEBAR_SORT_SETTING_KEY = 'sidebar:sort-key'
export const SIDEBAR_COLLAPSED_FOLDERS_SETTING_KEY = 'sidebar:collapsed-folders'

export async function readSidebarSortMode(): Promise<SidebarSortMode> {
  try {
    return parseSidebarSortMode(await getSetting<unknown>(SIDEBAR_SORT_SETTING_KEY))
  } catch (error) {
    if (error instanceof Error && error.name === 'DatabaseClosedError') {
      return DEFAULT_SIDEBAR_SORT_MODE
    }
    throw error
  }
}

export async function writeSidebarSortMode(mode: SidebarSortMode): Promise<void> {
  await setSetting(SIDEBAR_SORT_SETTING_KEY, mode)
}

export async function readCollapsedSidebarFolderIds(): Promise<FolderId[]> {
  try {
    return normalizeFolderIds(await getSetting<unknown>(SIDEBAR_COLLAPSED_FOLDERS_SETTING_KEY))
  } catch (error) {
    if (error instanceof Error && error.name === 'DatabaseClosedError') return []
    throw error
  }
}

export async function updateCollapsedSidebarFolderIds(
  updater: (current: readonly FolderId[]) => readonly FolderId[],
): Promise<FolderId[]> {
  const next =
    (await updateSetting<FolderId[]>(SIDEBAR_COLLAPSED_FOLDERS_SETTING_KEY, (current) =>
      normalizeFolderIds(updater(normalizeFolderIds(current))),
    )) ?? []
  return next
}

function normalizeFolderIds(value: unknown): FolderId[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item): item is string => typeof item === 'string'))].sort()
}
