import type { ChatTextExport } from '../core/branch-flatten'
import type { ChatId, MessageId } from '../core/types'
import { exportActiveBranchAsTxt, exportLastUpdatedBranchAsTxt } from './branch-flatten'
import { getWorkspaceRepository } from './workspace-repository'

export function readChatTextExport(
  chatId: ChatId,
  leafId: MessageId | null,
): Promise<ChatTextExport> {
  return exportActiveBranchAsTxt(getWorkspaceRepository(), chatId, leafId)
}

export function readLastUpdatedChatTextExport(chatId: ChatId): Promise<ChatTextExport> {
  return exportLastUpdatedBranchAsTxt(getWorkspaceRepository(), chatId)
}
