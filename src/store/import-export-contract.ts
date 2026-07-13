import type {
  ChatExportEnvelope,
  ChatPresetExportEnvelope,
  WorkspaceBackupEnvelope,
} from '../core/import-export/schema'
import type { AttachmentId, ChatId, FolderId, PresetId, ProfileId, TagId } from '../core/types'

export interface ImportChatOptions {
  now?: number
  targetProfileId?: ProfileId | null
}

export interface ImportChatResult {
  chatId: ChatId
  messageIdMap: Record<string, string>
  attachmentIdMap: Record<string, string>
  createdAttachmentIds: AttachmentId[]
  reusedAttachmentIds: AttachmentId[]
  folderId?: FolderId
  tagIds: TagId[]
  profileId: ProfileId
  profileMatched: boolean
}

export interface ImportChatPresetOptions {
  now?: number
  targetProfileId?: ProfileId | null
}

export interface ImportChatPresetResult {
  presetId: PresetId
  profileId: ProfileId
  profileMatched: boolean
}

export interface RestoreWorkspaceBackupOptions {
  now?: number
}

export interface RestoreWorkspaceBackupResult {
  chatCount: number
  messageCount: number
  attachmentCount: number
  profileCount: number
  presetCount: number
  promptPresetCount: number
  keyCount: number
}

export interface WorkspaceImportExportBackend {
  exportChat(chatId: ChatId): Promise<ChatExportEnvelope>
  importChat(envelope: ChatExportEnvelope, options?: ImportChatOptions): Promise<ImportChatResult>
  exportChatPreset(presetId: PresetId): Promise<ChatPresetExportEnvelope>
  importChatPreset(
    envelope: ChatPresetExportEnvelope,
    options?: ImportChatPresetOptions,
  ): Promise<ImportChatPresetResult>
  exportWorkspaceBackup(): Promise<WorkspaceBackupEnvelope>
  restoreWorkspaceBackup(
    envelope: WorkspaceBackupEnvelope,
    options?: RestoreWorkspaceBackupOptions,
  ): Promise<RestoreWorkspaceBackupResult>
}
