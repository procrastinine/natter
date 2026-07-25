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
  deletePairOp,
  deleteSingleOp,
  deleteTurnOp,
  deleteVariantOp,
  dismissMessageGenerationNotice,
  editInPlace,
  importMessagesOp,
  isConversationTargetBusyError,
  mutateMessageAttachmentReference,
  replyToMessage,
  replyToMessageWhenCapabilitySettles,
  restoreStructuralSnapshotOp,
  sendMessage,
  sendNewChat,
  sendNewChatWhenCapabilitySettles,
  sendSelectedMessageWhenCapabilitySettles,
  editAndResend as startEditAndResend,
  regenerateFromMessage as startRegenerateFromMessage,
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
  ImportChatOptions,
  ImportChatResult,
  MessageAttachmentRefMutation,
  RegenerateMessageOptions,
  WorkspaceFence,
} from '../store/presentation-contracts'
import { runWorkspaceActionAtFence } from '../store/workspace-runtime'
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
  const controller = new AbortController()
  let transcriptRetention: ReturnType<
    typeof conversationController.claimTranscriptRetention
  > | null = null
  let released = false
  let resolveHold!: () => void
  let resolveAdmitted!: () => void
  let rejectAdmitted!: (error: unknown) => void
  const hold = new Promise<void>((resolve) => {
    resolveHold = resolve
  })
  const admitted = new Promise<void>((resolve, reject) => {
    resolveAdmitted = resolve
    rejectAdmitted = reject
  })
  let admissionSettled = false
  let completion: Promise<void>
  try {
    completion = runWorkspaceActionAtFence(
      'message-edit',
      workspaceFence,
      async () => {
        transcriptRetention = conversationController.claimTranscriptRetention({
          chatId,
          messageId,
        })
        admissionSettled = true
        resolveAdmitted()
        await hold
      },
      { signal: controller.signal },
    )
  } catch (error) {
    const normalized = actionError('Message edit', error)
    rejectAdmitted(normalized)
    completion = Promise.reject(normalized)
  }
  void completion.catch((error: unknown) => {
    if (!admissionSettled) rejectAdmitted(error)
  })
  return Object.freeze({
    admitted,
    release: () => {
      if (released) return
      released = true
      transcriptRetention?.release()
      resolveHold()
      controller.abort(new DOMException('Message edit session released', 'AbortError'))
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

export interface CommittedConversationImport {
  readonly kind: 'conversation-import-committed'
  readonly result: ConversationCommittedResult<ImportChatResult>
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

async function commitConversationImport(
  value: unknown,
  routeOwner: ConversationRouteOwner,
  options: ImportChatOptions = {},
): Promise<CommittedConversationImport> {
  const chatId = newId()
  const operation = conversationController.claimOperation({
    chatId,
    steering: 'select-result',
    selectionDelivery: 'route-handoff',
    routeOwner,
  })
  let routeDelivery: ConversationRouteDelivery | undefined
  let routeHandoffTransferred = false
  try {
    const result = await interchangeApplication.importChat(
      value,
      { ...options, destinationChatId: chatId },
      (committed) => {
        const receipt = conversationController.acceptLocalResult(operation, {
          kind: 'select-committed',
          receipt: committed,
          committedEffect: committed.committedEffect,
        })
        if (receipt.accepted) routeDelivery = receipt.routeDelivery
      },
    )
    if (!routeDelivery) throw new Error('ConversationImportRouteDeliveryMissing')
    routeHandoffTransferred = routeDelivery.kind === 'handoff'
    return Object.freeze({ kind: 'conversation-import-committed', result, routeDelivery })
  } finally {
    if (!routeHandoffTransferred && routeDelivery?.kind === 'handoff') {
      routeDelivery.handoff.cancel()
    }
    conversationController.cancelOperation(operation)
  }
}

function acceptCommittedConversationImport(
  commit: CommittedConversationImport,
): ConversationRouteDelivery {
  return commit.routeDelivery
}

export const conversationActions = {
  beginMessageEditSession,
  sendMessage,
  sendSelectedMessageWhenCapabilitySettles,
  sendNewChat,
  sendNewChatWhenCapabilitySettles,
  replyToMessage,
  replyToMessageWhenCapabilitySettles,
  commitConversationImport,
  acceptCommittedConversationImport,

  async editMessage(chatId: ChatId, message: Message, text: string): Promise<void> {
    try {
      await editInPlace(chatId, message, text)
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

  regenerate(chatId: ChatId, message: Message, options: RegenerateMessageOptions = {}) {
    return startRegenerateFromMessage({ chatId }, message, options)
  },

  continueMessage(chatId: ChatId, message: Message) {
    return continueFromMessage({ chatId }, message)
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

  toggleContext(chatId: ChatId, message: Message): Promise<void> {
    return runConversationAction('Context visibility update', async () => {
      await toggleMessageContextHidden(chatId, message.id)
    })
  },

  toggleReasoning(chatId: ChatId, message: Message, member: ReasoningMemberRef): Promise<void> {
    return runConversationAction('Reasoning visibility update', async () => {
      await toggleReasoningDetailHidden(chatId, message.id, member)
    })
  },

  toggleProviderOutput(
    chatId: ChatId,
    message: Message,
    member: ProviderOutputMemberRef,
  ): Promise<void> {
    return runConversationAction('Tool visibility update', async () => {
      await toggleProviderOutputItemHidden(chatId, message.id, member)
    })
  },

  dismissGenerationNotice(chatId: ChatId, message: Message): Promise<void> {
    return runConversationAction('Dismiss', () =>
      dismissMessageGenerationNotice(chatId, message.id),
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
        const result = await execute(
          {
            chatId,
            messageId,
            activeLeafId: previousLeafId,
            ...(useUiStore.getState().cascadeDelete ? { cascade: true } : {}),
          },
          (committed) => {
            conversationController.acceptLocalResult(operation, {
              kind: 'select-committed',
              receipt: committed,
              committedEffect: committed.committedEffect,
            })
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

  async forkMessage(chatId: ChatId, message: Message): Promise<void> {
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
      const operation = conversationController.claimOperation({
        chatId: forkChatId,
        steering: 'select-result',
        selectionDelivery: 'route-handoff',
        routeOwner: routeIntentOwner(routeIntent),
      })
      let routeDelivery: ConversationRouteDelivery | undefined
      let routeHandoffTransferred = false
      try {
        const result = await forkChatFromMessage(
          {
            chatId,
            messageId: message.id,
            title,
            destinationChatId: forkChatId,
          },
          (committed) => {
            const receipt = conversationController.acceptLocalResult(operation, {
              kind: 'select-committed',
              receipt: committed,
              committedEffect: committed.committedEffect,
            })
            if (receipt.accepted) routeDelivery = receipt.routeDelivery
          },
        )
        if (!isRouteIntentCurrent(routeIntent)) {
          if (routeDelivery?.kind === 'handoff') routeDelivery.handoff.cancel()
          return
        }
        if (!routeDelivery) throw new Error('ForkRouteDeliveryMissing')
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
