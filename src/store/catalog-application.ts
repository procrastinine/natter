import { DEFAULT_SIDEBAR_SORT_MODE, type SidebarSortMode } from '../core/sidebar-sort'
import type { ChatFolder, ChatId, ChatSidebarRow, ChatTag, FolderId } from '../core/types'
import { type ChatSearchSurface, catalogSessionWorkspace } from './catalog-session-workspace'
import {
  archiveChat,
  moveChatToFolder,
  setManualTitle as persistManualTitle,
  setChatTagsFromNames,
} from './chats'
import {
  createFolder,
  deleteFolderWithDisposition,
  ensureFolderAndMoveChats,
  updateFolder,
} from './folders'
import type { OrganizationCatalogPageRequest } from './repository'
import { setSidebarFolderCollapsed, writeSidebarSortMode } from './sidebar-preferences'
import { subscribeWorkspaceEffects, WORKSPACE_EFFECT_RECOVERY_OWNED } from './workspace-effect-hub'
import type { ConfigurationPreferencesProjection, ReadEnvelope } from './workspace-protocol'
import { getWorkspaceRepository } from './workspace-repository'
import { runWorkspaceRead, type WorkspaceReadPermit } from './workspace-runtime'
import { registerWorkspaceTabSessionParticipant } from './workspace-tab-session'

export interface CatalogTabSnapshot {
  readonly revision: number
  readonly manualTitleProjections: Readonly<Record<ChatId, string>>
}

interface CatalogTabPort {
  readonly setSidebarSortMode: (mode: SidebarSortMode) => Promise<void>
  readonly setFolderCollapsed: (
    folderId: FolderId,
    collapsed: boolean,
  ) => Promise<readonly FolderId[]>
  readonly setManualTitle: (chatId: ChatId, title: string) => Promise<boolean>
}

interface ManualTitleProjection {
  readonly revision: number
  readonly title: string
  readonly settlement: 'pending' | 'committed'
}

const MAX_COMMITTED_TITLE_PROJECTIONS = 64

export class CatalogTabController {
  private readonly listeners = new Set<() => void>()
  private readonly port: CatalogTabPort
  private readonly manualTitleProjections = new Map<ChatId, ManualTitleProjection>()
  private intentRevision = 0
  private revision = 0
  private snapshot: CatalogTabSnapshot = this.buildSnapshot()

  constructor(port: CatalogTabPort) {
    this.port = port
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  readonly getSnapshot = (): CatalogTabSnapshot => this.snapshot

  setSidebarSortMode(mode: SidebarSortMode): Promise<void> {
    return this.port.setSidebarSortMode(mode)
  }

  setFolderCollapsed(folderId: FolderId, collapsed: boolean): Promise<readonly FolderId[]> {
    return this.port.setFolderCollapsed(folderId, collapsed)
  }

  setManualTitle(chatId: ChatId, title: string): Promise<boolean> {
    const trimmed = title.trim()
    if (trimmed.length === 0) return Promise.resolve(false)
    const revision = ++this.intentRevision
    this.manualTitleProjections.delete(chatId)
    this.manualTitleProjections.set(chatId, {
      revision,
      title: trimmed,
      settlement: 'pending',
    })
    this.publish()
    return this.port.setManualTitle(chatId, trimmed).then(
      (changed) => {
        const current = this.manualTitleProjections.get(chatId)
        if (current?.revision === revision) {
          this.manualTitleProjections.set(chatId, {
            ...current,
            settlement: 'committed',
          })
          this.pruneCommittedTitleProjections()
          this.publish()
        }
        return changed
      },
      (error: unknown) => {
        if (this.manualTitleProjections.get(chatId)?.revision === revision) {
          this.manualTitleProjections.delete(chatId)
          this.publish()
        }
        throw error
      },
    )
  }

  observeChatRows(rows: readonly CatalogTitleRow[]): void {
    let changed = false
    for (const row of rows) {
      const projection = this.manualTitleProjections.get(row.id)
      if (
        projection?.settlement !== 'committed' ||
        row.title !== projection.title ||
        row.titleStatus !== 'manual'
      ) {
        continue
      }
      this.manualTitleProjections.delete(row.id)
      changed = true
    }
    if (changed) this.publish()
  }

  resetWorkspace(): void {
    if (this.manualTitleProjections.size === 0) return
    this.manualTitleProjections.clear()
    this.publish()
  }

  deleteChat(chatId: ChatId): void {
    if (!this.manualTitleProjections.delete(chatId)) return
    this.publish()
  }

  private pruneCommittedTitleProjections(): void {
    let committed = 0
    for (const projection of this.manualTitleProjections.values()) {
      if (projection.settlement === 'committed') committed += 1
    }
    if (committed <= MAX_COMMITTED_TITLE_PROJECTIONS) return
    for (const [chatId, projection] of this.manualTitleProjections) {
      if (projection.settlement !== 'committed') continue
      this.manualTitleProjections.delete(chatId)
      committed -= 1
      if (committed <= MAX_COMMITTED_TITLE_PROJECTIONS) return
    }
  }

  private publish(): void {
    this.revision += 1
    this.snapshot = this.buildSnapshot()
    for (const listener of [...this.listeners]) listener()
  }

  private buildSnapshot(): CatalogTabSnapshot {
    const manualTitleProjections: Record<ChatId, string> = {}
    for (const [chatId, projection] of this.manualTitleProjections) {
      manualTitleProjections[chatId] = projection.title
    }
    return Object.freeze({
      revision: this.revision,
      manualTitleProjections: Object.freeze(manualTitleProjections),
    })
  }
}

type CatalogTitleRow = Pick<ChatSidebarRow, 'id' | 'title' | 'titleStatus'>

export function catalogChatPresentation<T extends CatalogTitleRow>(
  tab: CatalogTabSnapshot,
  row: T,
): T {
  const title = tab.manualTitleProjections[row.id]
  if (title === undefined || (row.title === title && row.titleStatus === 'manual')) return row
  return Object.freeze({ ...row, title, titleStatus: 'manual' })
}

export function catalogSidebarSortMode(
  _tab: CatalogTabSnapshot,
  preferences: ConfigurationPreferencesProjection | null,
): SidebarSortMode {
  return preferences?.sidebarSortMode ?? DEFAULT_SIDEBAR_SORT_MODE
}

export function catalogCollapsedFolderIds(
  _tab: CatalogTabSnapshot,
  preferences: ConfigurationPreferencesProjection | null,
): readonly FolderId[] {
  return preferences?.collapsedFolderIds ?? Object.freeze([])
}

const catalogTabController = new CatalogTabController({
  setSidebarSortMode: writeSidebarSortMode,
  setFolderCollapsed: setSidebarFolderCollapsed,
  setManualTitle: persistManualTitle,
})
registerWorkspaceTabSessionParticipant({
  resetWorkspace: () => catalogTabController.resetWorkspace(),
  deleteChat: (chatId) => catalogTabController.deleteChat(chatId),
})

const sessions = Object.freeze({
  sidebar: () => catalogSessionWorkspace.sidebarCatalog(),
  chatSearch: (surface: ChatSearchSurface) => catalogSessionWorkspace.chatSearchFor(surface),
})

const chat = Object.freeze({
  archive: archiveChat,
  moveToFolder: moveChatToFolder,
  setManualTitle: (chatId: ChatId, title: string) =>
    catalogTabController.setManualTitle(chatId, title),
  setTagsFromNames: setChatTagsFromNames,
})

const folder = Object.freeze({
  create: createFolder,
  update: updateFolder,
  deleteWithDisposition: deleteFolderWithDisposition,
  ensureAndMoveChats: ensureFolderAndMoveChats,
})

type OrganizationCatalogPage<Row> = ReadEnvelope<{
  readonly rows: readonly Row[]
  readonly nextCursor?: string
}>

function readOrganizationCatalogPage<Row>(
  query: (permit: WorkspaceReadPermit) => Promise<OrganizationCatalogPage<Row>>,
  signal: AbortSignal,
): Promise<OrganizationCatalogPage<Row>> {
  return runWorkspaceRead('repository-query', query, { signal })
}

const organization = Object.freeze({
  readFolderPage: (
    request: OrganizationCatalogPageRequest,
    signal: AbortSignal,
  ): Promise<OrganizationCatalogPage<ChatFolder>> =>
    readOrganizationCatalogPage(
      (permit) =>
        getWorkspaceRepository().query(
          permit,
          { kind: 'folder.catalog-page', request },
          { signal: permit.signal },
        ),
      signal,
    ),
  readTagPage: (
    request: OrganizationCatalogPageRequest,
    signal: AbortSignal,
  ): Promise<OrganizationCatalogPage<ChatTag>> =>
    readOrganizationCatalogPage(
      (permit) =>
        getWorkspaceRepository().query(
          permit,
          { kind: 'tag.catalog-page', request },
          { signal: permit.signal },
        ),
      signal,
    ),
  subscribe: (listener: () => void): (() => void) =>
    subscribeWorkspaceEffects({
      owner: 'sidebar-organization-catalog',
      impactKinds: ['folder', 'tag'],
      replacements: false,
      apply: listener,
      recover: () => WORKSPACE_EFFECT_RECOVERY_OWNED,
    }),
})

export const catalogApplication = Object.freeze({
  tab: catalogTabController,
  sessions,
  chat,
  folder,
  organization,
})
