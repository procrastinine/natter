import {
  type AttachmentDetailController,
  createAttachmentDetailController,
} from './attachment-detail-session'
import {
  createStorageChatCatalogSessionController,
  type StorageChatCatalogSessionController,
} from './storage-chat-catalog-session'
import {
  createStorageOverviewController,
  type StorageOverviewController,
} from './storage-overview-controller'
import { registerLoadedWorkspaceSessionOwner } from './workspace-session-owner'

class StorageCatalogSessionWorkspace {
  private archive: StorageChatCatalogSessionController | null = null
  private chats: StorageChatCatalogSessionController | null = null
  private attachmentDetail: AttachmentDetailController | null = null
  private overview: StorageOverviewController | null = null
  private terminal = false

  archiveCatalog(): StorageChatCatalogSessionController {
    this.assertOpen()
    if (this.archive) return this.archive
    this.archive = createStorageChatCatalogSessionController()
    return this.archive
  }

  chatCatalog(): StorageChatCatalogSessionController {
    this.assertOpen()
    if (this.chats) return this.chats
    this.chats = createStorageChatCatalogSessionController()
    return this.chats
  }

  attachmentManagerDetail(): AttachmentDetailController {
    this.assertOpen()
    if (this.attachmentDetail) return this.attachmentDetail
    this.attachmentDetail = createAttachmentDetailController()
    return this.attachmentDetail
  }

  overviewCatalog(): StorageOverviewController {
    this.assertOpen()
    if (this.overview) return this.overview
    this.overview = createStorageOverviewController()
    return this.overview
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
    this.archive?.dispose()
    this.archive = null
    this.chats?.dispose()
    this.chats = null
    this.attachmentDetail?.dispose()
    this.attachmentDetail = null
    this.overview?.dispose()
    this.overview = null
  }

  private assertOpen(): void {
    if (this.terminal) throw new Error('StorageCatalogSessionWorkspaceDisposed')
  }
}

const workspace = new StorageCatalogSessionWorkspace()

registerLoadedWorkspaceSessionOwner('storage-catalog', workspace)

export const storageCatalogSessionWorkspace = Object.freeze({
  archiveCatalog: () => workspace.archiveCatalog(),
  chatCatalog: () => workspace.chatCatalog(),
  attachmentManagerDetail: () => workspace.attachmentManagerDetail(),
  overviewCatalog: () => workspace.overviewCatalog(),
})
