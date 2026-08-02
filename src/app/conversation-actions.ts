import type { MessageBodyAuthoringOperations } from '../core/message-body-authoring'
import type { PasteImportSlot } from '../core/messages'
import type {
  ChatId,
  ContentItem,
  Message,
  MessageAttachmentRef,
  MessageId,
  MessageRole,
  ProviderOutputMemberRef,
  ReasoningMemberRef,
} from '../core/types'
import { newId } from '../lib/ulid'
import { forkChatFromMessage } from '../store/chat-fork'
import { getChat, nextForkTitle } from '../store/chat-metadata-application'
import {
  continueFromMessage,
  continueFromMessageWhenCapabilitySettles,
  deletePairOp,
  deleteSingleOp,
  deleteTurnOp,
  deleteVariantOp,
  dismissMessageGenerationNotice,
  editMessageBody,
  editReasoningDetail,
  importMessagesOp,
  isConversationTargetBusyError,
  mutateMessageAttachmentReference,
  replyToMessage,
  replyToMessageWhenCapabilitySettles,
  restoreStructuralSnapshotOp,
  sendMessage,
  sendMessageWhenCapabilitySettles,
  sendNewChat,
  sendNewChatWhenCapabilitySettles,
  editAndResend as startEditAndResend,
  editAndResendWhenCapabilitySettles as startEditAndResendWhenCapabilitySettles,
  regenerateFromMessage as startRegenerateFromMessage,
  regenerateFromMessageWhenCapabilitySettles as startRegenerateFromMessageWhenCapabilitySettles,
  toggleMessageContextHidden,
  toggleProviderOutputItemHidden,
  toggleReasoningDetailHidden,
} from '../store/conversation-command-client'
import {
  conversationController,
  currentConversationDestinationSpine,
} from '../store/conversation-controller'
import { interchangeApplication } from '../store/interchange-application'
import type {
  ConversationCommittedResult,
  ConversationRouteDelivery,
  ConversationRouteOwner,
  GenerationPreparationObserver,
  ImportChatOptions,
  ImportChatResult,
  MessageAttachmentRefMutation,
  RegenerateMessageOptions,
  WorkspaceFence,
} from '../store/presentation-contracts'
import {
  getWorkspaceRuntimeState,
  subscribeWorkspaceRuntimeState,
} from '../store/workspace-runtime'
import { useToastStore } from '../store/zustand/toastStore'
import { useUiStore } from '../store/zustand/uiStore'
import { ConversationActionUnavailableError } from './presentation-interactions'
import {
  beginRouteIntent,
  cancelRouteIntent,
  isRouteIntentCurrent,
  navigateToChatForIntent,
  routeIntentOwner,
} from './router'

export type ConversationDeleteMode = 'pair' | 'single' | 'turn' | 'variant'

export interface EditAndResendOptions {
  readonly prefillText?: string
  readonly attachmentRefs?: MessageAttachmentRef[]
}

export interface ConversationEditSession {
  readonly admitted: Promise<void>
  release(): void
}

function beginMessageEditSession(
  workspaceFence: WorkspaceFence,
  chatId: ChatId,
  messageId: MessageId,
): ConversationEditSession {
  let transcriptRetention: ReturnType<
    typeof conversationController.claimTranscriptRetention
  > | null = null
  let released = false
  let admitted: Promise<void>
  try {
    transcriptRetention = conversationController.claimTranscriptRetention({
      workspaceFence,
      chatId,
      messageId,
    })
    admitted = Promise.resolve()
  } catch (error) {
    const normalized = actionError('Message edit', error)
    admitted = Promise.reject(normalized)
  }
  void admitted.catch(() => undefined)
  return Object.freeze({
    admitted,
    release: () => {
      if (released) return
      released = true
      transcriptRetention?.release()
    },
  })
}

export interface ConversationImportInput {
  readonly chatId: ChatId
  readonly slot: PasteImportSlot
  readonly messages: readonly {
    readonly role: MessageRole
    readonly text: string
  }[]
}

export interface CommittedConversationImports {
  readonly kind: 'conversation-imports-committed'
  readonly results: readonly ConversationCommittedResult<ImportChatResult>[]
  readonly routeDelivery: ConversationRouteDelivery
}

function actionError(label: string, error: unknown): Error {
  const raw = error instanceof Error ? error : new Error('unknown error')
  if (isConversationTargetBusyError(raw)) {
    return new ConversationActionUnavailableError(
      `Wait for this generation to finish before ${label.toLowerCase()}.`,
    )
  }
  if (raw instanceof ConversationActionUnavailableError) return raw
  return new Error(`${label} failed: ${raw.message}`, { cause: raw })
}

async function runConversationAction(label: string, action: () => Promise<void>): Promise<void> {
  try {
    await action()
  } catch (error) {
    throw actionError(label, error)
  }
}

async function commitConversationImports(
  values: readonly unknown[],
  routeOwner: ConversationRouteOwner,
  options: readonly ImportChatOptions[] = [],
): Promise<CommittedConversationImports> {
  if (values.length === 0) throw new Error('ConversationImportBatchEmpty')
  await awaitConversationImportWorkspace(routeOwner)
  const chatIds = values.map(() => newId())
  const chatId = chatIds.at(-1)
  if (!chatId) throw new Error('ConversationImportDestinationMissing')
  const operation = conversationController.claimOperation({
    chatId,
    steering: 'select-result',
    selectionDelivery: 'route-handoff',
    routeOwner,
  })
  let routeDelivery: ConversationRouteDelivery | undefined
  let routeHandoffTransferred = false
  try {
    const results = await interchangeApplication.importChats(
      values,
      chatIds.map((destinationChatId, index) => ({
        ...options[index],
        destinationChatId,
      })),
      (committed) => {
        const selected = committed.at(-1)
        if (!selected) throw new Error('ConversationImportCommittedResultMissing')
        const receipt = conversationController.acceptLocalResult(operation, {
          kind: 'select-committed',
          receipt: selected,
          committedEffect: selected.committedEffect,
        })
        if (receipt.accepted) routeDelivery = receipt.routeDelivery
      },
    )
    const committedRouteDelivery = routeDelivery ?? Object.freeze({ kind: 'superseded' as const })
    routeHandoffTransferred = committedRouteDelivery.kind === 'handoff'
    return Object.freeze({
      kind: 'conversation-imports-committed',
      results,
      routeDelivery: committedRouteDelivery,
    })
  } finally {
    if (!routeHandoffTransferred && routeDelivery?.kind === 'handoff') {
      routeDelivery.handoff.cancel()
    }
    conversationController.cancelOperation(operation)
  }
}

function awaitConversationImportWorkspace(routeOwner: ConversationRouteOwner): Promise<void> {
  if (conversationController.getSnapshot().workspaceId !== null) return Promise.resolve()
  if (routeOwner.signal.aborted)
    return Promise.reject(conversationImportAbortError(routeOwner.signal))
  const runtimeState = getWorkspaceRuntimeState()
  if (runtimeState === 'FAILED_CLOSED' || runtimeState === 'SEALED') {
    return Promise.reject(new Error('The workspace is unavailable. Reload before importing.'))
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false
    let unsubscribeConversation: () => void = () => undefined
    let unsubscribeRuntime: () => void = () => undefined
    const cleanup = () => {
      unsubscribeConversation()
      unsubscribeRuntime()
      routeOwner.signal.removeEventListener('abort', inspect)
    }
    const settle = (publish: () => void) => {
      if (settled) return
      settled = true
      cleanup()
      publish()
    }
    const inspect = () => {
      if (routeOwner.signal.aborted) {
        settle(() => reject(conversationImportAbortError(routeOwner.signal)))
        return
      }
      if (conversationController.getSnapshot().workspaceId !== null) {
        settle(resolve)
        return
      }
      const state = getWorkspaceRuntimeState()
      if (state === 'FAILED_CLOSED' || state === 'SEALED') {
        settle(() => reject(new Error('The workspace is unavailable. Reload before importing.')))
      }
    }
    unsubscribeConversation = conversationController.subscribe(inspect)
    unsubscribeRuntime = subscribeWorkspaceRuntimeState(inspect)
    routeOwner.signal.addEventListener('abort', inspect, { once: true })
    inspect()
  })
}

function conversationImportAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Conversation import aborted.', { cause: signal.reason })
}

function acceptCommittedConversationImports(
  commit: CommittedConversationImports,
): ConversationRouteDelivery {
  return commit.routeDelivery
}

export const conversationActions = {
  beginMessageEditSession,
  sendMessage,
  sendMessageWhenCapabilitySettles,
  sendNewChat,
  sendNewChatWhenCapabilitySettles,
  replyToMessage,
  replyToMessageWhenCapabilitySettles,
  commitConversationImports,
  acceptCommittedConversationImports,

  async editMessage(
    chatId: ChatId,
    message: Message,
    text: string,
    signal?: AbortSignal,
    authoring?: MessageBodyAuthoringOperations,
    attachmentRefs?: MessageAttachmentRef[],
  ): Promise<void> {
    try {
      await editMessageBody(chatId, message, text, signal, authoring, attachmentRefs)
    } catch (error) {
      throw actionError('Edit', error)
    }
  },

  editAndResend(
    chatId: ChatId,
    message: Message,
    text: string,
    options: EditAndResendOptions = {},
  ) {
    const prefillText = options.prefillText ?? ''
    return startEditAndResend({ chatId }, message, text, {
      ...(prefillText.length > 0
        ? { prefillContent: [{ type: 'text', text: prefillText }] satisfies ContentItem[] }
        : {}),
      ...(options.attachmentRefs ? { attachmentRefs: options.attachmentRefs } : {}),
    })
  },

  editAndResendWhenCapabilitySettles(
    chatId: ChatId,
    message: Message,
    text: string,
    signal: AbortSignal,
    options: EditAndResendOptions = {},
    observer?: GenerationPreparationObserver,
  ) {
    const prefillText = options.prefillText ?? ''
    return startEditAndResendWhenCapabilitySettles(
      { chatId },
      message,
      text,
      signal,
      {
        ...(prefillText.length > 0
          ? { prefillContent: [{ type: 'text', text: prefillText }] satisfies ContentItem[] }
          : {}),
        ...(options.attachmentRefs ? { attachmentRefs: options.attachmentRefs } : {}),
      },
      observer,
    )
  },

  regenerate(chatId: ChatId, message: Message, options: RegenerateMessageOptions = {}) {
    return startRegenerateFromMessage({ chatId }, message, options)
  },

  regenerateWhenCapabilitySettles(
    chatId: ChatId,
    message: Message,
    signal: AbortSignal,
    options: RegenerateMessageOptions = {},
    observer?: GenerationPreparationObserver,
  ) {
    return startRegenerateFromMessageWhenCapabilitySettles(
      { chatId },
      message,
      signal,
      options,
      observer,
    )
  },

  continueMessage(chatId: ChatId, message: Message) {
    return continueFromMessage({ chatId }, message)
  },

  continueMessageWhenCapabilitySettles(
    chatId: ChatId,
    message: Message,
    signal: AbortSignal,
    observer?: GenerationPreparationObserver,
  ) {
    return continueFromMessageWhenCapabilitySettles({ chatId }, message, signal, observer)
  },

  async importMessages(input: ConversationImportInput): Promise<void> {
    const operation = conversationController.claimOperation({
      chatId: input.chatId,
      steering: 'select-result',
      selectionDelivery: 'session',
    })
    try {
      const snapshot = conversationController.getSnapshot()
      const path =
        snapshot.active?.chatId === input.chatId
          ? currentConversationDestinationSpine(snapshot.active.destination)?.path
          : null
      const previousLeafId = path?.leaf?.id ?? null
      await importMessagesOp(
        {
          chatId: input.chatId,
          slot: input.slot,
          activeLeafId: previousLeafId,
          messages: input.messages.map((message) => ({
            role: message.role,
            content: [{ type: 'text', text: message.text } satisfies ContentItem],
          })),
        },
        (result) => {
          conversationController.acceptLocalResult(operation, {
            kind: 'select-committed',
            receipt: result,
            committedEffect: result.committedEffect,
            ...(result.insertedTailId ? { revealTargetMessageId: result.insertedTailId } : {}),
          })
        },
      )
    } finally {
      conversationController.cancelOperation(operation)
    }
  },

  toggleContext(chatId: ChatId, message: Message, signal?: AbortSignal): Promise<void> {
    return runConversationAction('Context visibility update', async () => {
      await toggleMessageContextHidden(chatId, message.id, signal)
    })
  },

  toggleReasoning(
    chatId: ChatId,
    message: Message,
    member: ReasoningMemberRef,
    signal?: AbortSignal,
  ): Promise<void> {
    return runConversationAction('Reasoning visibility update', async () => {
      await toggleReasoningDetailHidden(chatId, message.id, member, signal)
    })
  },

  editReasoning(
    chatId: ChatId,
    message: Message,
    member: Extract<ReasoningMemberRef, { kind: 'visible' }>,
    text: string,
    signal?: AbortSignal,
  ): Promise<void> {
    return runConversationAction('Reasoning edit', async () => {
      await editReasoningDetail(chatId, message, member, text, signal)
    })
  },

  toggleProviderOutput(
    chatId: ChatId,
    message: Message,
    member: ProviderOutputMemberRef,
    signal?: AbortSignal,
  ): Promise<void> {
    return runConversationAction('Tool visibility update', async () => {
      await toggleProviderOutputItemHidden(chatId, message.id, member, signal)
    })
  },

  dismissGenerationNotice(chatId: ChatId, message: Message, signal?: AbortSignal): Promise<void> {
    return runConversationAction('Dismiss', () =>
      dismissMessageGenerationNotice(chatId, message.id, signal),
    )
  },

  mutateAttachment(message: Message, mutation: MessageAttachmentRefMutation): Promise<void> {
    return mutateMessageAttachmentReference(message.chatId, message.id, mutation)
  },

  deleteMessage(
    chatId: ChatId,
    messageId: MessageId,
    mode: ConversationDeleteMode,
    roleMismatch = false,
    signal?: AbortSignal,
    reportPhase?: (phase: 'repository-requested' | 'local-applied') => void,
  ): Promise<void> {
    return runConversationAction('Delete', async () => {
      const snapshot = conversationController.getSnapshot()
      const activePath =
        snapshot.activeChatId === chatId && snapshot.active
          ? currentConversationDestinationSpine(snapshot.active.destination)?.path
          : null
      const previousLeafId =
        snapshot.activeChatId === chatId ? (activePath?.leaf?.id ?? null) : null
      const operation = conversationController.claimOperation({
        chatId,
        steering: 'select-result',
        selectionDelivery: 'session',
      })
      const effectiveMode = mode === 'pair' && roleMismatch ? 'single' : mode
      const execute =
        effectiveMode === 'pair'
          ? deletePairOp
          : effectiveMode === 'turn'
            ? deleteTurnOp
            : effectiveMode === 'variant'
              ? deleteVariantOp
              : deleteSingleOp
      try {
        reportPhase?.('repository-requested')
        const result = await execute(
          {
            chatId,
            messageId,
            activeLeafId: previousLeafId,
            ...(useUiStore.getState().cascadeDelete ? { cascade: true } : {}),
            ...(signal ? { signal } : {}),
          },
          (committed) => {
            conversationController.acceptLocalResult(operation, {
              kind: 'select-committed',
              receipt: committed,
              committedEffect: committed.committedEffect,
            })
            reportPhase?.('local-applied')
          },
        )
        useToastStore.getState().push({
          level: 'info',
          text:
            effectiveMode === 'pair'
              ? 'Deleted pair.'
              : effectiveMode === 'variant'
                ? 'Deleted variant.'
                : effectiveMode === 'turn'
                  ? 'Deleted turn.'
                  : 'Deleted message.',
          undo: async () => {
            const undoOperation = conversationController.claimOperation({
              chatId,
              steering: 'select-result',
              selectionDelivery: 'session',
            })
            try {
              await restoreStructuralSnapshotOp(result.preImage, (restored) => {
                conversationController.acceptLocalResult(undoOperation, {
                  kind: 'select-committed',
                  receipt: restored,
                  committedEffect: restored.committedEffect,
                })
              })
            } finally {
              conversationController.cancelOperation(undoOperation)
            }
          },
        })
      } finally {
        conversationController.cancelOperation(operation)
      }
    })
  },

  async forkMessage(
    chatId: ChatId,
    message: Message,
    signal?: AbortSignal,
    reportPhase?: (phase: 'repository-requested' | 'local-applied') => void,
  ): Promise<void> {
    const routeIntent = beginRouteIntent()
    try {
      const sourceChat = await getChat(chatId)
      if (!sourceChat) throw new Error('Chat not found.')
      const defaultTitle = await nextForkTitle(sourceChat.title)
      if (!isRouteIntentCurrent(routeIntent)) return
      const chosen =
        typeof window === 'undefined'
          ? defaultTitle
          : window.prompt('Name the new chat:', defaultTitle)
      if (chosen === null) return
      const title = chosen.trim() || defaultTitle
      const forkChatId = newId()
      reportPhase?.('repository-requested')
      const result = await forkChatFromMessage(
        {
          chatId,
          messageId: message.id,
          title,
          destinationChatId: forkChatId,
        },
        undefined,
        signal,
      )
      if (!isRouteIntentCurrent(routeIntent)) return
      const operation = conversationController.claimOperation({
        chatId: forkChatId,
        steering: 'select-result',
        selectionDelivery: 'route-handoff',
        routeOwner: routeIntentOwner(routeIntent),
      })
      let routeDelivery: ConversationRouteDelivery | undefined
      let routeHandoffTransferred = false
      try {
        const receipt = conversationController.acceptLocalResult(operation, {
          kind: 'select-committed',
          receipt: result,
          committedEffect: result.committedEffect,
        })
        if (receipt.accepted) routeDelivery = receipt.routeDelivery
        if (!routeDelivery) throw new Error('ForkRouteDeliveryMissing')
        reportPhase?.('local-applied')
        useToastStore.getState().push({
          level: 'success',
          text: `Forked to "${title}" (${result.messageCount} messages).`,
        })
        if (routeDelivery.kind === 'handoff') {
          routeHandoffTransferred = navigateToChatForIntent(
            routeIntent,
            result.chatId,
            routeDelivery.handoff,
          )
        }
      } finally {
        if (!routeHandoffTransferred && routeDelivery?.kind === 'handoff') {
          routeDelivery.handoff.cancel()
        }
        conversationController.cancelOperation(operation)
      }
    } catch (error) {
      throw actionError('Fork', error)
    } finally {
      cancelRouteIntent(routeIntent)
    }
  },
}
