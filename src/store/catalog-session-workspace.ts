import {
  type AttachmentSearchSessionController,
  createAttachmentSearchSessionController,
} from './attachment-search-session'
import { createSearchSessionController, type SearchSessionController } from './search-session'
import { createSidebarSessionController, type SidebarSessionController } from './sidebar-session'
import { workspaceUsableSurfaceSettlementPort } from './workspace-runtime-control'
import { registerLoadedWorkspaceSessionOwner } from './workspace-session-owner'

export type ChatSearchSurface = 'sidebar' | 'storage-chats'
export type AttachmentSearchSurface =
  | 'storage-manager'
  | 'picker-composer'
  | 'picker-draft-tray'
  | 'picker-inline-editor'
  | 'picker-message-reference'
  | 'picker-storage-reference'

const sidebarFirstPageSettlement = workspaceUsableSurfaceSettlementPort('sidebar-first-page')

class CatalogSessionWorkspace {
  private sidebar: SidebarSessionController | null = null
  private readonly chatSearch: Record<ChatSearchSurface, SearchSessionController | null> = {
    sidebar: null,
    'storage-chats': null,
  }
  private readonly attachmentSearch: Record<
    AttachmentSearchSurface,
    AttachmentSearchSessionController | null
  > = {
    'storage-manager': null,
    'picker-composer': null,
    'picker-draft-tray': null,
    'picker-inline-editor': null,
    'picker-message-reference': null,
    'picker-storage-reference': null,
  }
  private terminal = false

  chatSearchFor(surface: ChatSearchSurface): SearchSessionController {
    this.assertOpen()
    const current = this.chatSearch[surface]
    if (current) return current
    const created = createSearchSessionController()
    this.chatSearch[surface] = created
    return created
  }

  sidebarCatalog(): SidebarSessionController {
    this.assertOpen()
    if (this.sidebar) return this.sidebar
    this.sidebar = createSidebarSessionController({
      firstPageSettlement: sidebarFirstPageSettlement,
    })
    return this.sidebar
  }

  attachmentSearchFor(surface: AttachmentSearchSurface): AttachmentSearchSessionController {
    this.assertOpen()
    const current = this.attachmentSearch[surface]
    if (current) return current
    const created = createAttachmentSearchSessionController()
    this.attachmentSearch[surface] = created
    return created
  }

  disposeTerminal(): void {
    if (this.terminal) return
    this.disposeSessions()
    this.terminal = true
  }

  resetForTests(): void {
    this.disposeSessions()
    this.terminal = false
  }

  private disposeSessions(): void {
    this.sidebar?.dispose()
    this.sidebar = null
    for (const surface of Object.keys(this.chatSearch) as ChatSearchSurface[]) {
      this.chatSearch[surface]?.dispose()
      this.chatSearch[surface] = null
    }
    for (const surface of Object.keys(this.attachmentSearch) as AttachmentSearchSurface[]) {
      this.attachmentSearch[surface]?.dispose()
      this.attachmentSearch[surface] = null
    }
  }

  private assertOpen(): void {
    if (this.terminal) throw new Error('CatalogSessionWorkspaceDisposed')
  }
}

const workspace = new CatalogSessionWorkspace()

registerLoadedWorkspaceSessionOwner('catalog-core', workspace)

export const catalogSessionWorkspace = Object.freeze({
  sidebarCatalog: () => workspace.sidebarCatalog(),
  chatSearchFor: (surface: ChatSearchSurface) => workspace.chatSearchFor(surface),
  attachmentSearchFor: (surface: AttachmentSearchSurface) => workspace.attachmentSearchFor(surface),
})
