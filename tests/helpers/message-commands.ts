import type { PasteImportResult } from '../../src/core/messages'
import type {
  AttachmentId,
  AttachmentRef,
  ChatId,
  ContentItem,
  Message,
  MessageId,
  MessageOrigin,
  MessageRole,
} from '../../src/core/types'
import type { MessageHeaderRow } from '../../src/store/message-storage'
import type {
  MessageMutationCommand,
  WorkspaceCommandResult,
} from '../../src/store/workspace-protocol'
import { getWorkspaceRepository } from '../../src/store/workspace-repository'
import { runWorkspaceAction, runWorkspaceRead } from '../../src/store/workspace-runtime'

export interface LegacyBranchExplicitCommand {
  kind: 'message.branch-explicit'
  input: { chatId: ChatId; messageId: MessageId; now?: number }
}

export interface LegacyInsertSiblingCommand {
  kind: 'message.insert-sibling'
  input: {
    chatId: ChatId
    targetId: MessageId
    content: ContentItem[]
    role?: MessageRole
    origin?: MessageOrigin
    attachmentRefs?: AttachmentRef[]
    now?: number
  }
}

export interface LegacyInsertBetweenCommand {
  kind: 'message.insert-between'
  input: {
    chatId: ChatId
    parentId: MessageId | null
    childId: MessageId
    content: ContentItem[]
    role: MessageRole
    origin?: MessageOrigin
    attachmentRefs?: AttachmentId[]
    now?: number
  }
}

export interface LegacyAppendChildCommand {
  kind: 'message.append-child'
  input: {
    chatId: ChatId
    parentMessageId: MessageId
    content: ContentItem[]
    role: MessageRole
    origin?: MessageOrigin
    attachmentRefs?: AttachmentId[]
    now?: number
  }
}

export type LegacyMessageCommand =
  | LegacyBranchExplicitCommand
  | LegacyInsertSiblingCommand
  | LegacyInsertBetweenCommand
  | LegacyAppendChildCommand

export interface LegacyStructuralInsertResult extends PasteImportResult {
  messageId: MessageId
}

export interface LegacyInsertSiblingResult extends LegacyStructuralInsertResult {
  message: Message
  header: MessageHeaderRow
}

export type LegacyMessageCommandResult<C extends LegacyMessageCommand> =
  C extends LegacyInsertSiblingCommand ? LegacyInsertSiblingResult : LegacyStructuralInsertResult

export function executeMessageCommand<C extends MessageMutationCommand>(
  command: C,
): Promise<WorkspaceCommandResult<C>>
export function executeMessageCommand(
  command: LegacyInsertSiblingCommand,
): Promise<LegacyInsertSiblingResult>
export function executeMessageCommand(
  command: LegacyBranchExplicitCommand | LegacyInsertBetweenCommand | LegacyAppendChildCommand,
): Promise<LegacyStructuralInsertResult>
export function executeMessageCommand(
  command: LegacyMessageCommand,
): Promise<LegacyStructuralInsertResult | LegacyInsertSiblingResult>
export async function executeMessageCommand(
  command: MessageMutationCommand | LegacyMessageCommand,
): Promise<unknown> {
  if (isLegacyMessageCommand(command)) return executeLegacyMessageCommand(command)

  const commit = await runWorkspaceAction(messageCommandRootKind(command), (permit) =>
    getWorkspaceRepository().execute(permit, command),
  )
  return commit.value
}

async function executeLegacyMessageCommand(
  command: LegacyMessageCommand,
): Promise<LegacyStructuralInsertResult | LegacyInsertSiblingResult> {
  const repository = getWorkspaceRepository()
  let role: MessageRole
  let content: ContentItem[]
  let attachmentRefs: AttachmentId[] | undefined
  let slot:
    | { kind: 'sibling'; messageId: MessageId }
    | { kind: 'before'; messageId: MessageId }
    | { kind: 'after'; messageId: MessageId }
  if (command.kind === 'message.branch-explicit') {
    const source = await runWorkspaceRead('repository-query', (permit) =>
      repository
        .query(permit, { kind: 'message.presentation', messageId: command.input.messageId })
        .then((envelope) => envelope.value?.message),
    )
    if (!source || source.chatId !== command.input.chatId || source.deleted) {
      throw new Error(`TreeChanged:${command.input.chatId}`)
    }
    role = source.role
    content = structuredClone(source.content)
    attachmentRefs = source.attachmentRefs?.map((ref) => ref.attachmentId)
    slot = { kind: 'sibling', messageId: source.id }
  } else if (command.kind === 'message.insert-sibling') {
    role = command.input.role ?? 'assistant'
    content = command.input.content
    attachmentRefs = command.input.attachmentRefs?.map((ref) => ref.attachmentId)
    slot = { kind: 'sibling', messageId: command.input.targetId }
  } else if (command.kind === 'message.insert-between') {
    role = command.input.role
    content = command.input.content
    attachmentRefs = command.input.attachmentRefs
    slot = { kind: 'before', messageId: command.input.childId }
  } else {
    role = command.input.role
    content = command.input.content
    attachmentRefs = command.input.attachmentRefs
    slot = { kind: 'after', messageId: command.input.parentMessageId }
  }
  const commit = await runWorkspaceAction('message-structure', (permit) =>
    repository.execute(permit, {
      kind: 'message.import',
      input: {
        chatId: command.input.chatId,
        slot,
        activeLeafId: null,
        messages: [{ role, content, ...(attachmentRefs ? { attachmentRefs } : {}) }],
        ...(command.input.now === undefined ? {} : { now: command.input.now }),
      },
    }),
  )
  const result = commit.value
  const messageId = result.newMessageIds[0]
  if (!messageId) throw new Error('LegacyTestImportMissingMessage')
  const base = { ...result, messageId }
  if (command.kind !== 'message.insert-sibling') return base
  const presentation = result.presentations.find((candidate) => candidate.header.id === messageId)
  if (!presentation) throw new Error('LegacyTestImportMissingPresentation')
  return { ...base, message: presentation.message, header: presentation.header }
}

export function isLegacyMessageCommand(command: { kind: string }): command is LegacyMessageCommand {
  return (
    command.kind === 'message.branch-explicit' ||
    command.kind === 'message.insert-sibling' ||
    command.kind === 'message.insert-between' ||
    command.kind === 'message.append-child'
  )
}

function messageCommandRootKind(
  command: MessageMutationCommand,
): 'message-edit' | 'message-structure' {
  switch (command.kind) {
    case 'message.edit-body':
    case 'message.toggle-reasoning-detail':
    case 'message.toggle-provider-output-item':
    case 'message.toggle-context':
    case 'message.dismiss-generation-notice':
      return 'message-edit'
    case 'message.import':
    case 'message.delete':
    case 'message.restore-structure':
      return 'message-structure'
  }
}
