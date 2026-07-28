import type {
  ChatExportEnvelope,
  ChatPresetExportEnvelope,
  ConnectionProfileExportEnvelope,
  WorkspaceBackupEnvelope,
} from '../core/import-export/schema'
import type { ChatId, MessageId, PresetId, ProfileId } from '../core/types'
import { readChatTextExport, readLastUpdatedChatTextExport } from './chat-export'
import type { ConversationCommittedResult } from './conversation-repository-adapter'
import type {
  ImportChatOptions,
  ImportChatPresetOptions,
  ImportChatPresetResult,
  ImportChatResult,
  ImportConnectionProfileOptions,
  ImportConnectionProfileResult,
  RestoreWorkspaceBackupOptions,
  RestoreWorkspaceBackupResult,
} from './import-export-contract'

async function exportChat(chatId: ChatId): Promise<ChatExportEnvelope> {
  return (await import('./import-export')).exportChat(chatId)
}

async function importChat(
  value: unknown,
  options: ImportChatOptions = {},
  apply?: (result: ConversationCommittedResult<ImportChatResult>) => void,
): Promise<ConversationCommittedResult<ImportChatResult>> {
  return (await import('./import-export')).importChat(value, options, apply)
}

async function importChats(
  values: readonly unknown[],
  options: readonly ImportChatOptions[] = [],
  apply?: (results: readonly ConversationCommittedResult<ImportChatResult>[]) => void,
): Promise<readonly ConversationCommittedResult<ImportChatResult>[]> {
  return (await import('./import-export')).importChats(values, options, apply)
}

async function exportChatPreset(presetId: PresetId): Promise<ChatPresetExportEnvelope> {
  return (await import('./import-export')).exportChatPreset(presetId)
}

async function importChatPreset(
  value: unknown,
  options: ImportChatPresetOptions = {},
): Promise<ImportChatPresetResult> {
  return (await import('./import-export')).importChatPreset(value, options)
}

async function exportConnectionProfile(
  profileId: ProfileId,
): Promise<ConnectionProfileExportEnvelope> {
  return (await import('./import-export')).exportConnectionProfile(profileId)
}

async function importConnectionProfile(
  value: unknown,
  options: ImportConnectionProfileOptions = {},
): Promise<ImportConnectionProfileResult> {
  return (await import('./import-export')).importConnectionProfile(value, options)
}

async function exportWorkspaceDocument<T>(
  encode: (envelope: WorkspaceBackupEnvelope) => T,
): Promise<T> {
  return (await import('./import-export')).exportWorkspaceBackupDocument(encode)
}

async function restoreWorkspace(
  value: unknown,
  options: RestoreWorkspaceBackupOptions = {},
): Promise<RestoreWorkspaceBackupResult> {
  return (await import('./import-export')).restoreWorkspaceBackup(value, options)
}

async function exportChatText(
  chatId: ChatId,
  leafId: MessageId | null,
): Promise<{ filename: string; content: string }> {
  return readChatTextExport(chatId, leafId)
}

async function exportLastUpdatedChatText(
  chatId: ChatId,
): Promise<{ filename: string; content: string }> {
  return readLastUpdatedChatTextExport(chatId)
}

export const interchangeApplication = Object.freeze({
  exportChat,
  importChat,
  importChats,
  exportChatPreset,
  importChatPreset,
  exportConnectionProfile,
  importConnectionProfile,
  exportWorkspaceDocument,
  restoreWorkspace,
  exportChatText,
  exportLastUpdatedChatText,
})
