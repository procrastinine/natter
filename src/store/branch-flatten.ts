import { branchTextBodyExport, branchTextExport, type ChatTextExport } from '../core/branch-flatten'
import type { ChatId, MessageId } from '../core/types'
import { readBranchText, readLastUpdatedBranchText } from './branch-text'
import type { WorkspaceReadAuthority, WorkspaceRepository } from './workspace-protocol'
import { runWorkspaceRead } from './workspace-runtime'

export function exportActiveBranchAsTxt(
  repo: WorkspaceRepository,
  chatId: ChatId,
  leafId: MessageId | null,
  authority?: WorkspaceReadAuthority,
): Promise<ChatTextExport> {
  const read = async (permit: WorkspaceReadAuthority): Promise<ChatTextExport> => {
    const snapshot = await readBranchText(repo, permit, chatId, leafId)
    if (!snapshot) throw new Error(`ChatMissing:${chatId}`)
    return snapshot.branchLeafId === null
      ? branchTextExport(snapshot.chat, [])
      : branchTextBodyExport(snapshot.chat, snapshot.textContent)
  }
  return authority ? read(authority) : runWorkspaceRead('import-export', read)
}

export function exportLastUpdatedBranchAsTxt(
  repo: WorkspaceRepository,
  chatId: ChatId,
  authority?: WorkspaceReadAuthority,
): Promise<ChatTextExport> {
  const read = async (permit: WorkspaceReadAuthority): Promise<ChatTextExport> => {
    const fresh = await readLastUpdatedBranchText(repo, permit, chatId)
    if (!fresh) throw new Error(`ChatMissing:${chatId}`)
    return fresh.branchLeafId === null
      ? branchTextExport(fresh.chat, [])
      : branchTextBodyExport(fresh.chat, fresh.textContent)
  }
  return authority ? read(authority) : runWorkspaceRead('import-export', read)
}
