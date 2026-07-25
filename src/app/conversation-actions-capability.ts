import type { conversationActions as conversationActionsValue } from './conversation-actions'

export type ConversationActions = typeof conversationActionsValue

let loaded: ConversationActions | null = null

export async function loadConversationActions(): Promise<ConversationActions> {
  if (loaded) return loaded
  const module = await import('./conversation-actions')
  loaded = module.conversationActions
  return loaded
}

export function requireConversationActions(): ConversationActions {
  if (!loaded) throw new Error('ConversationActionsCapabilityNotReady')
  return loaded
}
