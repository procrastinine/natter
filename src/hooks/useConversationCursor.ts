import type { ChatId, MessageId } from '../core/types'
import { conversationController } from '../store/conversation-controller'

export function navigateConversationMessage(
  chatId: ChatId,
  messageId: MessageId,
  observedTipId?: MessageId,
): void {
  conversationController.navigate({
    chatId,
    kind: 'message',
    messageId,
    ...(observedTipId ? { observedTipId } : {}),
  })
}

export function navigateConversationSiblingPosition(
  chatId: ChatId,
  parentId: MessageId | null,
  position: number,
): void {
  conversationController.navigate({
    chatId,
    kind: 'sibling-position',
    parentId,
    position,
  })
}

export function resolveConversationSiblingPosition(
  chatId: ChatId,
  parentId: MessageId | null,
  position: number,
): Promise<MessageId | null> {
  return conversationController.resolveSiblingPosition(chatId, parentId, position)
}
