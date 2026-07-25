import { normalizeCollapsedSidebarFolderIds, type SidebarSortMode } from '../core/sidebar-sort'
import type { FolderId } from '../core/types'
import { configurationApplication } from './configuration-application'

export async function writeSidebarSortMode(mode: SidebarSortMode): Promise<void> {
  await configurationApplication.execute({
    kind: 'sidebar-preference.set-sort',
    mode,
    now: Date.now(),
  })
}

export async function setSidebarFolderCollapsed(
  folderId: FolderId,
  collapsed: boolean,
): Promise<FolderId[]> {
  const result = await configurationApplication.execute({
    kind: 'sidebar-preference.set-folder-collapsed',
    folderId,
    collapsed,
    now: Date.now(),
  })
  if (result.kind !== 'workspace-setting-saved') {
    throw new Error(`SidebarFolderPreferenceFailed:${folderId}`)
  }
  return normalizeCollapsedSidebarFolderIds(result.value)
}
