import type { ChatPreset, ChatSettings } from '../core/types'
import { newId } from '../lib/ulid'
import { discardEmptyDraftChat, materializeTemporaryChat } from './chats'
import {
  type ConfigurationIntent,
  configurationController,
  readyActiveConfigurationSelection,
} from './configuration-controller'
import type { ConversationRouteDelivery, ConversationRouteHandoff } from './conversation-controller'
import { conversationController } from './conversation-controller'
import type { ConversationRouteOwner } from './conversation-route-owner'

export interface ResolvedNewChatSeed {
  readonly intent: ConfigurationIntent
  readonly preset: ChatPreset | null
  readonly settings: ChatSettings
}

export interface MaterializedTemporaryChat {
  readonly chatId: string
  readonly seed: ResolvedNewChatSeed
  readonly routeHandoff: ConversationRouteHandoff
}

export async function materializeTemporaryNewChat(
  routeOwner: ConversationRouteOwner,
): Promise<MaterializedTemporaryChat | null> {
  const signal = routeOwner.signal
  const seed = await acquireNewChatSeed(signal)
  if (!seed || signal.aborted) return null
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
    const result = await materializeTemporaryChat(
      {
        chatId,
        settings: seed.settings,
        ...(seed.preset ? { presetId: seed.preset.id } : {}),
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
    if (!routeDelivery) throw new Error('TemporaryChatRouteDeliveryMissing')
    if (routeDelivery.kind === 'superseded' || routeOwnerCancelled(routeOwner)) {
      if (routeDelivery.kind === 'handoff') routeDelivery.handoff.cancel()
      await discardEmptyDraftChat(result.destination.chat.id)
      return null
    }
    routeHandoffTransferred = true
    return {
      chatId: result.destination.chat.id,
      seed,
      routeHandoff: routeDelivery.handoff,
    }
  } finally {
    if (!routeHandoffTransferred && routeDelivery?.kind === 'handoff') {
      routeDelivery.handoff.cancel()
    }
    conversationController.cancelOperation(operation)
  }
}

function routeOwnerCancelled(routeOwner: ConversationRouteOwner): boolean {
  return routeOwner.signal.aborted
}

export async function acquireNewChatSeed(
  signal?: AbortSignal,
): Promise<ResolvedNewChatSeed | null> {
  if (configurationController.getSnapshot().frame.target.kind !== 'new-chat') {
    throw new Error('NewChatSeedTargetUnavailable')
  }
  const intent = configurationController.claimIntent()
  while (!signal?.aborted) {
    if (!configurationController.intentIsCurrent(intent)) return null
    const snapshot = configurationController.getSnapshot()
    if (snapshot.frame.target.kind !== 'new-chat') return null
    const selection = readyActiveConfigurationSelection(snapshot.frame)
    if (selection?.target.kind === 'new-chat') {
      return Object.freeze({
        intent,
        preset: selection.value.preset,
        settings: structuredClone(selection.target.settings),
      })
    }
    if (snapshot.frame.selection.status === 'error') {
      throw new Error(snapshot.frame.selection.error)
    }
    await configurationController.waitForSnapshotChange(snapshot, signal)
  }
  return null
}
