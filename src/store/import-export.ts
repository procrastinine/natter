import { migrateNatterExportEnvelope } from '../backcompat/import-export'

export { WorkspaceReplacementInProgressError } from '../core/import-export/errors'

import type {
  ChatExportEnvelope,
  ChatPresetExportEnvelope,
  WorkspaceBackupEnvelope,
} from '../core/import-export/schema'
import { assertEnvelopeKind } from '../core/import-export/schema'
import type { ChatId, PresetId } from '../core/types'
import { getBrowserImportExportBackend } from './browser-import-export'
import type {
  ImportChatOptions,
  ImportChatPresetOptions,
  ImportChatPresetResult,
  ImportChatResult,
  RestoreWorkspaceBackupOptions,
  RestoreWorkspaceBackupResult,
  WorkspaceImportExportBackend,
} from './import-export-contract'

export type {
  ImportChatOptions,
  ImportChatPresetOptions,
  ImportChatPresetResult,
  ImportChatResult,
  RestoreWorkspaceBackupOptions,
  RestoreWorkspaceBackupResult,
} from './import-export-contract'

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
