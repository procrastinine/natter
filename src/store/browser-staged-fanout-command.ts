import type { BrowserCommandReadConflictScope } from './browser-command-mutation-journal'
import type { ConfigurationDomainCommand } from './configuration-domain-contract'
import type { CommitEnvelope, WorkspaceCommand, WorkspaceCommandResult } from './workspace-protocol'

export interface BrowserStagedCommandConflictEvidence {
  readonly readAddresses: readonly string[]
  readonly readScopes: readonly BrowserCommandReadConflictScope[]
  readonly mutationAddresses: readonly string[]
}

export interface BrowserStagedCommandExecution<C extends WorkspaceCommand> {
  readonly commit: CommitEnvelope<WorkspaceCommandResult<C>>
  readonly conflictEvidence: BrowserStagedCommandConflictEvidence
}

const STAGED_WORKSPACE_COMMAND_KINDS = Object.freeze([
  'attachment.bundle.write',
  'attachment.bytes.delete',
  'attachment.delete-if-unreferenced',
  'attachment.delete-many',
  'attachment.reap',
  'attachment.ref.add',
  'attachment.ref.detach',
  'attachment.ref.relink',
  'attachment.ref.set-visibility',
  'chat.calibration.clear-all',
  'chat.calibration.clear-family',
  'chat.fork',
  'folder.delete',
  'folder.ensure-and-move-chats',
  'generated-output.localization-claim',
  'generated-output.localization-complete',
  'generated-output.localization-fail',
  'generated-output.localization-retry',
  'generated-output.video-expand',
  'maintenance.prune-empty-draft-chats',
  'maintenance.reconcile-attachment-integrity',
  'message.delete',
  'message.import',
  'message.restore-structure',
] satisfies readonly WorkspaceCommand['kind'][])

const STAGED_CONFIGURATION_COMMAND_KINDS = Object.freeze([
  'connection.delete',
  'prompt-preset.delete',
  'prompt-preset.overwrite-and-pin',
  'text-template.delete',
] satisfies readonly ConfigurationDomainCommand['kind'][])

export type BrowserWorkspaceStagedFanoutCommand = WorkspaceCommand

export function isBrowserWorkspaceStagedFanoutCommand(
  command: WorkspaceCommand,
): command is BrowserWorkspaceStagedFanoutCommand {
  if (command.kind !== 'configuration.execute') {
    return (STAGED_WORKSPACE_COMMAND_KINDS as readonly WorkspaceCommand['kind'][]).includes(
      command.kind,
    )
  }
  return (
    STAGED_CONFIGURATION_COMMAND_KINDS as readonly ConfigurationDomainCommand['kind'][]
  ).includes(command.input.kind)
}

export const BROWSER_WORKSPACE_STAGED_FANOUT_SEMANTIC_VARIANTS = Object.freeze([
  'attachment.bundle.write',
  'attachment.bytes.delete',
  'attachment.delete-if-unreferenced',
  'attachment.delete-many',
  'attachment.reap',
  'attachment.ref.add',
  'attachment.ref.detach',
  'attachment.ref.relink',
  'attachment.ref.set-visibility',
  'chat.calibration.clear-all',
  'chat.calibration.clear-family',
  'chat.fork',
  'connection.delete',
  'folder.delete',
  'folder.ensure-and-move-chats',
  'generated-output.localization-claim',
  'generated-output.localization-complete',
  'generated-output.localization-fail',
  'generated-output.localization-retry',
  'generated-output.video-expand',
  'maintenance.prune-empty-draft-chats',
  'maintenance.reconcile-attachment-integrity',
  'message.delete',
  'message.import',
  'message.restore-structure',
  'prompt-preset.delete',
  'prompt-preset.overwrite-and-pin',
  'text-template.delete',
])
