import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { TranscriptWorkBudget } from '../core/transcript-work-budget'
import type { ChatId, MessageId } from '../core/types'
import { conversationController } from '../store/conversation-controller'
import type {
  ConversationChatSnapshot,
  ConversationController,
  ConversationSnapshot,
  TreePreviewTarget,
} from '../store/presentation-contracts'

export function useConversationSnapshot(
  controller: ConversationController = conversationController,
): ConversationSnapshot {
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
}

export interface ConversationTranscriptDemand {
  readonly chatId: ChatId
  readonly selectionRevision: number
  readonly selectionEpoch: number
  readonly budget: TranscriptWorkBudget
}

export function useConversationTranscriptDemand(
  demand: ConversationTranscriptDemand | null,
  controller: ConversationController = conversationController,
  rendererAvailable = true,
): void {
  const owner = useRef({})
  useEffect(() => {
    controller.setTranscriptDemand(owner.current, rendererAvailable ? demand : null)
  }, [controller, demand, rendererAvailable])
  useEffect(() => () => controller.setTranscriptDemand(owner.current, null), [controller])
}

export function useConversationInspectorDemand(
  chatId: ChatId | null,
  messageId: MessageId | null | undefined,
  controller: ConversationController = conversationController,
): void {
  const owner = useRef({})
  useLayoutEffect(() => {
    controller.setInspectorDemand(owner.current, chatId && messageId ? { chatId, messageId } : null)
  }, [chatId, controller, messageId])
  useLayoutEffect(() => () => controller.setInspectorDemand(owner.current, null), [controller])
}

export function useConversationTreePreviewDemand(
  chatId: ChatId | null,
  targets: readonly TreePreviewTarget[] | undefined,
  controller: ConversationController = conversationController,
): void {
  const owner = useRef({})
  const demand = useMemo(
    () => (chatId && targets && targets.length > 0 ? { chatId, targets } : null),
    [chatId, targets],
  )
  useLayoutEffect(() => {
    controller.setTreePreviewDemand(owner.current, demand)
  }, [controller, demand])
  useLayoutEffect(() => () => controller.setTreePreviewDemand(owner.current, null), [controller])
}

export interface UseConversationFrameOptions {
  chatId: ChatId | null
  inspectorMessageId?: MessageId | null
  treePreviewTargets?: readonly TreePreviewTarget[]
  controller?: ConversationController
}

export function useConversationFrame({
  chatId,
  inspectorMessageId,
  treePreviewTargets,
  controller = conversationController,
}: UseConversationFrameOptions): ConversationChatSnapshot | null {
  const snapshot = useConversationSnapshot(controller)
  const active = snapshot.active?.chatId === chatId ? snapshot.active : null
  useConversationInspectorDemand(chatId, inspectorMessageId, controller)
  useConversationTreePreviewDemand(chatId, treePreviewTargets, controller)

  return active
}
