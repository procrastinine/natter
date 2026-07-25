// Message-level ops bridge: turn MessageActions callbacks into workspace
// commands or generation intents. Keeps the React surface thin and means
// the ops can be unit-tested by calling these helpers directly.
//
// Three distinct "modify user prompt" semantics, per the user's rule:
//   1. Edit in place — `editInPlace(messageId, text)` mutates `content`
//      on the existing row; NO sibling is created; NO API call.
//   2. Edit & resend — `editAndResend(messageId, text)` atomically prepares
//      the user sibling and its assistant placeholder, then dispatches one
//      generation attempt.
//   3. Regenerate — `regenerate(messageId)` creates a fresh assistant
//      sibling under the existing user parent; old assistant stays as a
//      swipe variant. One API call.

import type { ChatSettingsPatch } from '../core/chat-metadata'
import { writeTextInto } from '../core/message-content'
import type {
  DeleteResult,
  PasteImportInput,
  PasteImportResult,
  StructuralSnapshot,
} from '../core/messages'
import type {
  AttachmentRef,
  ChatId,
  ContentItem,
  Message,
  MessageId,
  ProviderOutputMemberRef,
  ReasoningMemberRef,
} from '../core/types'
import {
  type MessageAttachmentRefMutation,
  mutateMessageAttachmentRef as mutateMessageAttachmentRefThroughAttachmentDomain,
} from './attachments'
import {
  type ConversationCommittedResult,
  conversationCommittedResult,
} from './conversation-repository-adapter'
import type { ConversationRouteOwner } from './conversation-route-owner'
import {
  type GenerationHandle,
  type GenerationIntent,
  type GenerationStartResult,
  generationEngine,
  type PreparedGeneration,
  type PreparedNewChatGeneration,
  type SelectedSendGenerationAdmission,
} from './generation-engine'
import { StreamTargetBusyError } from './repository'
import type { StructuralSnapshotPresentation } from './structural-undo-contract'
import type { MessageMutationCommand, WorkspaceCommandResult } from './workspace-protocol'
import { getWorkspaceRepository } from './workspace-repository'
import { runWorkspaceAction } from './workspace-runtime'

export interface MessageOpsContext {
  readonly chatId: ChatId
}

export interface RegenerateMessageOptions {
  readonly settingsPatch?: ChatSettingsPatch
}

export interface SendContentOptions {
  readonly prefillContent?: ContentItem[]
  readonly attachmentRefs?: AttachmentRef[]
}

export interface SelectedSendContentOptions extends SendContentOptions {
  readonly admission?: SelectedSendGenerationAdmission
}

export function isConversationTargetBusyError(error: unknown): boolean {
  return error instanceof StreamTargetBusyError
}

type SelectingMessageMutationCommand = Extract<
  MessageMutationCommand,
  { kind: 'message.import' | 'message.delete' | 'message.restore-structure' }
>
type PreservingMessageMutationCommand = Exclude<
  MessageMutationCommand,
  SelectingMessageMutationCommand
>

async function executeConversationCommand<C extends PreservingMessageMutationCommand>(
  command: C,
): Promise<WorkspaceCommandResult<C>> {
  const commit = await runWorkspaceAction('message-edit', (permit) =>
    getWorkspaceRepository().execute(permit, command),
  )
  return commit.value
}

async function executeSelectingConversationCommand<C extends SelectingMessageMutationCommand>(
  command: C,
  apply?: (result: ConversationCommittedResult<WorkspaceCommandResult<C>>) => void,
): Promise<ConversationCommittedResult<WorkspaceCommandResult<C>>> {
  const commit = await runWorkspaceAction('message-structure', (permit) =>
    getWorkspaceRepository().execute(
      permit,
      command,
      apply
        ? {
            localApplications: {
              conversation: (committed) => {
                apply(conversationCommittedResult(committed, committed.value.destination.chat.id))
                return 'applied'
              },
            },
          }
        : undefined,
    ),
  )
  return conversationCommittedResult(commit, commit.value.destination.chat.id)
}

export async function editInPlace(
  chatId: ChatId,
  message: Message,
  newText: string,
): Promise<void> {
  const nextContent = writeTextInto(message.content, newText)
  await executeConversationCommand({
    kind: 'message.edit-content',
    input: { chatId, messageId: message.id, content: nextContent },
  })
}

export async function toggleReasoningDetailHidden(
  chatId: ChatId,
  messageId: MessageId,
  member: ReasoningMemberRef,
): Promise<void> {
  await executeConversationCommand({
    kind: 'message.toggle-reasoning-detail',
    chatId,
    messageId,
    member,
  })
}

export async function toggleProviderOutputItemHidden(
  chatId: ChatId,
  messageId: MessageId,
  member: ProviderOutputMemberRef,
): Promise<void> {
  await executeConversationCommand({
    kind: 'message.toggle-provider-output-item',
    chatId,
    messageId,
    member,
  })
}

export async function toggleMessageContextHidden(
  chatId: ChatId,
  messageId: MessageId,
): Promise<void> {
  await executeConversationCommand({
    kind: 'message.toggle-context',
    chatId,
    messageId,
  })
}

export async function dismissMessageGenerationNotice(
  chatId: ChatId,
  messageId: MessageId,
): Promise<void> {
  await executeConversationCommand({
    kind: 'message.dismiss-generation-notice',
    chatId,
    messageId,
  })
}

export async function mutateMessageAttachmentReference(
  chatId: ChatId,
  messageId: MessageId,
  mutation: MessageAttachmentRefMutation,
): Promise<void> {
  await mutateMessageAttachmentRefThroughAttachmentDomain({
    chatId,
    messageId,
    mutation,
  })
}

export function sendMessage(
  chatId: ChatId,
  expectedLeafId: MessageId | null,
  content: ContentItem[],
  options: SendContentOptions = {},
): GenerationStartResult<Extract<GenerationIntent, { readonly kind: 'send' }>> {
  return generationEngine.start({
    intent: {
      kind: 'send',
      chatId,
      expectedLeafId,
      content,
      ...(options.attachmentRefs ? { attachmentRefs: options.attachmentRefs } : {}),
      ...(options.prefillContent?.length ? { prefillContent: options.prefillContent } : {}),
    },
  })
}

export function sendSelectedMessageWhenCapabilitySettles(
  chatId: ChatId,
  content: ContentItem[],
  signal: AbortSignal,
  options: SelectedSendContentOptions = {},
): Promise<GenerationHandle<PreparedGeneration>> {
  return generationEngine.startWhenCapabilitySettles(
    {
      intent: {
        kind: 'selected-send',
        chatId,
        content,
        ...(options.attachmentRefs ? { attachmentRefs: options.attachmentRefs } : {}),
        ...(options.prefillContent?.length ? { prefillContent: options.prefillContent } : {}),
      },
      ...(options.admission ? { admission: options.admission } : {}),
    },
    { signal },
  )
}

export function sendNewChat(
  content: ContentItem[],
  routeOwner: ConversationRouteOwner,
  options: SendContentOptions = {},
): GenerationStartResult<Extract<GenerationIntent, { readonly kind: 'new-chat-send' }>> {
  return generationEngine.start({
    intent: {
      kind: 'new-chat-send',
      content,
      ...(options.attachmentRefs ? { attachmentRefs: options.attachmentRefs } : {}),
      ...(options.prefillContent?.length ? { prefillContent: options.prefillContent } : {}),
    },
    routeOwner,
  })
}

export function sendNewChatWhenCapabilitySettles(
  content: ContentItem[],
  routeOwner: ConversationRouteOwner,
  signal: AbortSignal,
  options: SendContentOptions = {},
): Promise<GenerationHandle<PreparedNewChatGeneration>> {
  return generationEngine.startWhenCapabilitySettles(
    {
      intent: {
        kind: 'new-chat-send',
        content,
        ...(options.attachmentRefs ? { attachmentRefs: options.attachmentRefs } : {}),
        ...(options.prefillContent?.length ? { prefillContent: options.prefillContent } : {}),
      },
      routeOwner,
    },
    { signal },
  )
}

export function replyToMessage(
  chatId: ChatId,
  parentUserId: MessageId,
): GenerationStartResult<Extract<GenerationIntent, { readonly kind: 'reply' }>> {
  return generationEngine.start({ intent: { kind: 'reply', chatId, parentUserId } })
}

export function replyToMessageWhenCapabilitySettles(
  chatId: ChatId,
  parentUserId: MessageId,
  signal: AbortSignal,
): Promise<GenerationHandle<PreparedGeneration>> {
  return generationEngine.startWhenCapabilitySettles(
    { intent: { kind: 'reply', chatId, parentUserId } },
    { signal },
  )
}

export function editAndResend(
  ctx: MessageOpsContext,
  originalUser: Message,
  newText: string,
  options: { prefillContent?: ContentItem[]; attachmentRefs?: AttachmentRef[] } = {},
): GenerationStartResult<Extract<GenerationIntent, { readonly kind: 'edit-resend' }>> {
  return generationEngine.start({
    intent: {
      kind: 'edit-resend',
      chatId: ctx.chatId,
      targetUserId: originalUser.id,
      content: [{ type: 'text', text: newText }],
      ...(options.attachmentRefs ? { attachmentRefs: options.attachmentRefs } : {}),
      ...(options.prefillContent?.length ? { prefillContent: options.prefillContent } : {}),
    },
  })
}

export function regenerateFromMessage(
  ctx: MessageOpsContext,
  assistantMessage: Message,
  options: RegenerateMessageOptions = {},
): GenerationStartResult<Extract<GenerationIntent, { readonly kind: 'regenerate' }>> {
  return generationEngine.start({
    intent: {
      kind: 'regenerate',
      chatId: ctx.chatId,
      targetAssistantId: assistantMessage.id,
      ...(options.settingsPatch ? { settingsPatch: options.settingsPatch } : {}),
    },
  })
}

// Continue in place. Instead of creating a new assistant sibling (which
// requires model-specific prefill semantics that not every model
// supports), the flow is:
//   1. Keep the existing assistant row intact, its generation.model /
//      usage / cost / reasoningDetails are the FACTUAL record of the
//      original turn and must not be mutated.
//   2. Build a one-shot wire body from the active path up to (and
//      including) the target assistant, but with a system prompt that
//      tells the model: "Continue this chat from the last incomplete
//      assistant message. Output only the continuation, nothing else."
//   3. Stream the response. Every chunk APPENDS to the target's
//      `content` text; no new row is created, generation metadata is
//      untouched, and any reasoning is discarded (the continuation
//      call's reasoning is about the instruction, not the original
//      turn, so keeping it would be misleading).
//
// Reasoning discipline: the existing reasoningDetails on the target
// stay untouched (they describe the original partial run). The
// continuation call's reasoning is dropped. If a future phase wants
// reasoning from the continuation, it can be added to the tail of
// reasoningDetails under a new `type: 'reasoning.text'` entry, but
// Phase 8.1 keeps the surface plain.
export function continueFromMessage(
  ctx: MessageOpsContext,
  assistantMessage: Message,
): GenerationStartResult<Extract<GenerationIntent, { readonly kind: 'continue' }>> {
  return generationEngine.start({
    intent: {
      kind: 'continue',
      chatId: ctx.chatId,
      targetAssistantId: assistantMessage.id,
    },
  })
}

export async function importMessagesOp(
  input: PasteImportInput,
  apply?: (result: ConversationCommittedResult<PasteImportResult>) => void,
): Promise<ConversationCommittedResult<PasteImportResult>> {
  return executeSelectingConversationCommand(
    {
      kind: 'message.import',
      input,
    },
    apply,
  )
}

interface DeleteOpArgs {
  chatId: ChatId
  messageId: MessageId
  activeLeafId: MessageId | null
  cascade?: boolean
}

export async function deletePairOp(
  args: DeleteOpArgs,
  apply?: (result: ConversationCommittedResult<DeleteResult>) => void,
) {
  return executeSelectingConversationCommand(
    {
      kind: 'message.delete',
      mode: 'pair',
      input: {
        chatId: args.chatId,
        messageId: args.messageId,
        activeLeafId: args.activeLeafId,
        ...(args.cascade ? { cascade: true } : {}),
      },
    },
    apply,
  )
}
export async function deleteTurnOp(
  args: DeleteOpArgs,
  apply?: (result: ConversationCommittedResult<DeleteResult>) => void,
) {
  return executeSelectingConversationCommand(
    {
      kind: 'message.delete',
      mode: 'turn',
      input: {
        chatId: args.chatId,
        messageId: args.messageId,
        activeLeafId: args.activeLeafId,
        ...(args.cascade ? { cascade: true } : {}),
      },
    },
    apply,
  )
}
export async function deleteVariantOp(
  args: DeleteOpArgs,
  apply?: (result: ConversationCommittedResult<DeleteResult>) => void,
) {
  return executeSelectingConversationCommand(
    {
      kind: 'message.delete',
      mode: 'variant',
      input: {
        chatId: args.chatId,
        messageId: args.messageId,
        activeLeafId: args.activeLeafId,
        ...(args.cascade ? { cascade: true } : {}),
      },
    },
    apply,
  )
}

export async function deleteSingleOp(
  args: DeleteOpArgs,
  apply?: (result: ConversationCommittedResult<DeleteResult>) => void,
) {
  return executeSelectingConversationCommand(
    {
      kind: 'message.delete',
      mode: 'single',
      input: {
        chatId: args.chatId,
        messageId: args.messageId,
        activeLeafId: args.activeLeafId,
        ...(args.cascade ? { cascade: true } : {}),
      },
    },
    apply,
  )
}

export async function restoreStructuralSnapshotOp(
  snapshot: StructuralSnapshot,
  apply?: (result: ConversationCommittedResult<StructuralSnapshotPresentation>) => void,
): Promise<ConversationCommittedResult<StructuralSnapshotPresentation>> {
  return executeSelectingConversationCommand(
    {
      kind: 'message.restore-structure',
      input: { snapshot },
    },
    apply,
  )
}
