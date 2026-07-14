import { migrateNatterExportEnvelope } from '../backcompat/import-export'

export { WorkspaceReplacementInProgressError } from '../core/import-export/errors'

import type {
  ChatExportEnvelope,
  ChatPresetExportEnvelope,
  WorkspaceBackupEnvelope,
} from '../core/import-export/schema'
import { assertEnvelopeKind } from '../core/import-export/schema'
import type { ChatId, PresetId } from '../core/types'
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

let backendPromise: Promise<WorkspaceImportExportBackend> | undefined

function backend(): Promise<WorkspaceImportExportBackend> {
  backendPromise ??= import('./browser-import-export').then((module) =>
    module.getBrowserImportExportBackend(),
  )
  void backendPromise.catch(() => {
    backendPromise = undefined
  })
  return backendPromise
}

export function __resetImportExportBackendForTests(): void {
  backendPromise = undefined
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
  return backend().then((value) => value.exportChat(chatId))
}

export function importChat(
  value: unknown,
  options: ImportChatOptions = {},
): Promise<ImportChatResult> {
  const envelope = parseChatExportEnvelope(value)
  return backend().then((backend) => backend.importChat(envelope, options))
}

export function exportChatPreset(presetId: PresetId): Promise<ChatPresetExportEnvelope> {
  return backend().then((value) => value.exportChatPreset(presetId))
}

export function importChatPreset(
  value: unknown,
  options: ImportChatPresetOptions = {},
): Promise<ImportChatPresetResult> {
  const envelope = parseChatPresetExportEnvelope(value)
  return backend().then((backend) => backend.importChatPreset(envelope, options))
}

export function exportWorkspaceBackup(): Promise<WorkspaceBackupEnvelope> {
  return backend().then((value) => value.exportWorkspaceBackup())
}

export function restoreWorkspaceBackup(
  value: unknown,
  options: RestoreWorkspaceBackupOptions = {},
): Promise<RestoreWorkspaceBackupResult> {
  const envelope = parseWorkspaceBackupEnvelope(value)
  return backend().then((backend) => backend.restoreWorkspaceBackup(envelope, options))
}
