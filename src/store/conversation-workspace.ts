import { conversationController } from './conversation-controller'
import {
  type ConversationRepositoryAdapter,
  createConversationRepositoryAdapter,
} from './conversation-repository-adapter'
import type { WorkspaceFence } from './repository'
import { getWorkspaceRepository } from './workspace-repository'

let adapter: ConversationRepositoryAdapter | null = null

export function attachConversationWorkspace(fence: WorkspaceFence): void {
  if (adapter) return
  const current = createConversationRepositoryAdapter({
    repository: getWorkspaceRepository(),
    controller: conversationController,
  })
  adapter = current
  try {
    current.attach(fence)
  } catch (error) {
    if (adapter === current) adapter = null
    current.dispose()
    throw error
  }
}

export function disposeConversationWorkspace(): void {
  const current = adapter
  adapter = null
  current?.dispose()
}

export function assertConversationWorkspaceClosed(): void {
  if (adapter) throw new Error('ConversationWorkspaceNotClosed')
}
