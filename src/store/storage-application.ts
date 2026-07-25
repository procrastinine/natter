import { executeAttachmentBulkDelete, planAttachmentBulkDelete } from './attachment-bulk-delete'
import {
  batchRelinkAttachmentRefs,
  deleteReferencedAttachmentBytes,
  deleteUnreferencedAttachment,
  detachAttachmentRef,
  getAttachmentBundle,
  ingestAttachmentBytes,
  relinkAttachmentRef,
  replaceAttachmentBytes,
  restoreMissingAttachment,
  setAttachmentRefVisibility,
} from './attachments'
import { catalogApplication } from './catalog-application'
import { catalogSessionWorkspace } from './catalog-session-workspace'
import {
  archiveChats,
  clearAllTokenCalibrationEverywhere,
  clearChatTokenCalibration,
  clearTokenCalibrationFamilyEverywhere,
  deleteArchivedChatPermanently,
  deleteArchivedChatsPermanently,
  emptyArchivedChats,
  moveChatsToFolder,
  setChatsTagsFromNames,
  unarchiveChat,
  unarchiveChats,
} from './chats'
import { interchangeApplication } from './interchange-application'
import { ChatStreamBusyError } from './repository'
import { clearLocalWorkspaceStorage } from './storage-administration'
import { storageCatalogSessionWorkspace } from './storage-catalog-session-workspace'

const sessions = Object.freeze({
  chatCatalog: storageCatalogSessionWorkspace.chatCatalog,
  archiveCatalog: storageCatalogSessionWorkspace.archiveCatalog,
  attachmentSearch: () => catalogSessionWorkspace.attachmentSearchFor('storage-manager'),
  attachmentManagerDetail: storageCatalogSessionWorkspace.attachmentManagerDetail,
  overviewCatalog: storageCatalogSessionWorkspace.overviewCatalog,
})

const chat = Object.freeze({
  ...catalogApplication.chat,
  archiveMany: archiveChats,
  unarchive: unarchiveChat,
  unarchiveMany: unarchiveChats,
  deleteArchived: deleteArchivedChatPermanently,
  deleteArchivedMany: deleteArchivedChatsPermanently,
  emptyArchive: emptyArchivedChats,
  moveManyToFolder: moveChatsToFolder,
  setManyTagsFromNames: setChatsTagsFromNames,
})

const attachment = Object.freeze({
  ingestBytes: ingestAttachmentBytes,
  replaceBytes: replaceAttachmentBytes,
  getBundle: getAttachmentBundle,
  setRefVisibility: setAttachmentRefVisibility,
  detachRef: detachAttachmentRef,
  relinkRef: relinkAttachmentRef,
  batchRelinkRefs: batchRelinkAttachmentRefs,
  deleteReferencedBytes: deleteReferencedAttachmentBytes,
  restoreMissing: restoreMissingAttachment,
  deleteUnreferenced: deleteUnreferencedAttachment,
  planBulkDelete: planAttachmentBulkDelete,
  executeBulkDelete: executeAttachmentBulkDelete,
})

const calibration = Object.freeze({
  clearChat: clearChatTokenCalibration,
  clearFamilyEverywhere: clearTokenCalibrationFamilyEverywhere,
  clearAllEverywhere: clearAllTokenCalibrationEverywhere,
})

const errors = Object.freeze({
  isChatStreamBusy: (error: unknown): error is ChatStreamBusyError =>
    error instanceof ChatStreamBusyError,
})

export const storageApplication = Object.freeze({
  tab: catalogApplication.tab,
  sessions,
  chat,
  folder: catalogApplication.folder,
  attachment,
  calibration,
  errors,
  transfer: interchangeApplication,
  storage: Object.freeze({ clearAll: clearLocalWorkspaceStorage }),
})
