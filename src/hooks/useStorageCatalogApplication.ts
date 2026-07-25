import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import type { ChatId, ChatSidebarRow } from '../core/types'
import type {
  AttachmentCatalogAggregate,
  AttachmentCatalogSearchRequest,
  AttachmentDetailSnapshot,
  AttachmentSearchSessionSnapshot,
  ChatSidebarAggregate,
  ChatSidebarCatalogRequest,
  StorageChatCatalogSessionSnapshot,
  StorageGlobalCalibrationModel,
  WorkspaceMeta,
} from '../store/presentation-contracts'
import { storageApplication } from '../store/storage-application'
import {
  EMPTY_STORAGE_ATTACHMENT_AGGREGATE,
  EMPTY_STORAGE_CHAT_AGGREGATE,
  EMPTY_STORAGE_GLOBAL_CALIBRATION_MODEL,
} from '../store/storage-overview-controller'
import { useWorkspaceFence } from './useCatalogApplication'

export interface ArchiveCatalogProjection {
  readonly session: StorageChatCatalogSessionSnapshot | null
  readonly loadMore: () => void
}

export interface AttachmentManagerCatalogProjection {
  readonly search: AttachmentSearchSessionSnapshot | null
  readonly detail: AttachmentDetailSnapshot | null
  readonly detailId: string | null
  readonly loadMore: () => void
}

export interface StorageChatCatalogProjection {
  readonly session: StorageChatCatalogSessionSnapshot | null
  readonly nextPage: () => void
  readonly previousPage: () => void
  readonly demandCalibrations: (chatIds: readonly ChatId[]) => void
  readonly collectMatchingRows: () => Promise<readonly ChatSidebarRow[]>
  readonly resolveRows: (chatIds: readonly ChatId[]) => Promise<readonly ChatSidebarRow[]>
}

export function useStorageChatCatalogApplication(
  catalog: Omit<ChatSidebarCatalogRequest, 'cursor' | 'pageDirection' | 'limit' | 'countMode'>,
): StorageChatCatalogProjection {
  const workspaceFence = useWorkspaceFence()
  const controller = storageApplication.sessions.chatCatalog()
  const session = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  )
  useEffect(() => {
    const fence = workspaceFence
    if (!fence) return
    controller.request({ ...fence, catalog, pageSize: 200 })
  }, [catalog, controller, workspaceFence])
  const nextPage = useCallback(() => controller.nextPage(), [controller])
  const previousPage = useCallback(() => controller.previousPage(), [controller])
  const demandCalibrations = useCallback(
    (chatIds: readonly ChatId[]) => controller.demandCalibrations(chatIds),
    [controller],
  )
  const collectMatchingRows = useCallback(() => controller.collectMatchingRows(), [controller])
  const resolveRows = useCallback(
    (chatIds: readonly ChatId[]) => controller.resolveRows(chatIds),
    [controller],
  )
  return useMemo(
    () => ({
      session,
      nextPage,
      previousPage,
      demandCalibrations,
      collectMatchingRows,
      resolveRows,
    }),
    [collectMatchingRows, demandCalibrations, nextPage, previousPage, resolveRows, session],
  )
}

export function useStorageOverviewCatalogApplication(): {
  readonly chats: ChatSidebarAggregate
  readonly attachments: AttachmentCatalogAggregate
  readonly calibration: StorageGlobalCalibrationModel
  readonly workspace: WorkspaceMeta | null
} {
  const workspaceFence = useWorkspaceFence()
  const controller = storageApplication.sessions.overviewCatalog()
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  )
  useEffect(() => {
    if (!workspaceFence) return
    return controller.request(workspaceFence)
  }, [controller, workspaceFence])
  return {
    chats: snapshot?.chats ?? EMPTY_STORAGE_CHAT_AGGREGATE,
    attachments: snapshot?.attachments ?? EMPTY_STORAGE_ATTACHMENT_AGGREGATE,
    calibration: snapshot?.calibration ?? EMPTY_STORAGE_GLOBAL_CALIBRATION_MODEL,
    workspace: snapshot?.workspace ?? null,
  }
}

export function useArchiveCatalogApplication(): ArchiveCatalogProjection {
  const workspaceFence = useWorkspaceFence()
  const controller = storageApplication.sessions.archiveCatalog()
  const session = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  )
  useEffect(() => {
    const fence = workspaceFence
    if (!fence) return
    controller.request({
      ...fence,
      catalog: { archived: 'only', orderBy: 'updatedAt', direction: 'desc' },
      pageSize: 100,
    })
  }, [controller, workspaceFence])
  const loadMore = useCallback(() => controller.loadMore(), [controller])
  return useMemo(() => ({ session, loadMore }), [loadMore, session])
}

export function useAttachmentManagerCatalogApplication(
  search: Omit<AttachmentCatalogSearchRequest, 'cursor' | 'direction' | 'limit'>,
  selectedId: string | undefined,
): AttachmentManagerCatalogProjection {
  const workspaceFence = useWorkspaceFence()
  const searchController = storageApplication.sessions.attachmentSearch()
  const detailController = storageApplication.sessions.attachmentManagerDetail()
  const searchSnapshot = useSyncExternalStore(
    searchController.subscribe,
    searchController.getSnapshot,
    searchController.getSnapshot,
  )
  const detailSnapshot = useSyncExternalStore(
    detailController.subscribe,
    detailController.getSnapshot,
    detailController.getSnapshot,
  )
  const detailId = selectedId ?? searchSnapshot?.rows[0]?.id ?? null
  useEffect(() => {
    const fence = workspaceFence
    if (!fence) return
    return searchController.request({ ...fence, search, pageSize: 200 })
  }, [search, searchController, workspaceFence])
  useEffect(() => {
    const fence = workspaceFence
    if (!fence) return
    detailController.request(fence, detailId)
  }, [detailController, detailId, workspaceFence])
  const loadMore = useCallback(() => searchController.loadMore(), [searchController])
  return useMemo(
    () => ({
      search: searchSnapshot,
      detail: detailSnapshot,
      detailId,
      loadMore,
    }),
    [detailId, detailSnapshot, loadMore, searchSnapshot],
  )
}
