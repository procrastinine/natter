import { migrateNatterExportEnvelope } from '../backcompat/import-export'
import type {
  ChatExportEnvelope,
  ChatPresetExportEnvelope,
  WorkspaceBackupEnvelope,
} from '../core/import-export/schema'
import { assertEnvelopeKind } from '../core/import-export/schema'
import type { AttachmentId, ChatId, FolderId, PresetId, ProfileId, TagId } from '../core/types'
import { getBrowserImportExportBackend } from './browser-import-export'

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

function backend(): WorkspaceImportExportBackend {
  return getBrowserImportExportBackend()
}

export function __resetImportExportBackendForTests(): void {
  // Retained for test cleanup symmetry while import/export uses the browser backend directly.
}

function parseChatExportEnvelope(value: unknown): ChatExportEnvelope {
  const envelope = migrateNatterExportEnvelope(value)
  assertEnvelopeKind(envelope, 'chat')
  return envelope
}

function parseChatPresetExportEnvelope(value: unknown): ChatPresetExportEnvelope {
  const envelope = migrateNatterExportEnvelope(value)
  assertEnvelopeKind(envelope, 'chat-preset')
  return envelope
}

function parseWorkspaceBackupEnvelope(value: unknown): WorkspaceBackupEnvelope {
  const envelope = migrateNatterExportEnvelope(value)
  assertEnvelopeKind(envelope, 'workspace-backup')
  return envelope
}

export function exportChat(chatId: ChatId): Promise<ChatExportEnvelope> {
  return backend().exportChat(chatId)
}

export function importChat(
  value: unknown,
  options: ImportChatOptions = {},
): Promise<ImportChatResult> {
  return backend().importChat(parseChatExportEnvelope(value), options)
}

export function exportChatPreset(presetId: PresetId): Promise<ChatPresetExportEnvelope> {
  return backend().exportChatPreset(presetId)
}

export function importChatPreset(
  value: unknown,
  options: ImportChatPresetOptions = {},
): Promise<ImportChatPresetResult> {
  return backend().importChatPreset(parseChatPresetExportEnvelope(value), options)
}

export function exportWorkspaceBackup(): Promise<WorkspaceBackupEnvelope> {
  return backend().exportWorkspaceBackup()
}

export function restoreWorkspaceBackup(
  value: unknown,
  options: RestoreWorkspaceBackupOptions = {},
): Promise<RestoreWorkspaceBackupResult> {
  return backend().restoreWorkspaceBackup(parseWorkspaceBackupEnvelope(value), options)
}
