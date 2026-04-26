import { getWorkspaceRepository } from '../store/workspace-repository'
import { exportActiveBranchAsTxt, exportLastUpdatedBranchAsTxt } from './branch-flatten'
import type { ChatId, CursorMap } from './types'

export async function exportCurrentViewAsTxt(
  chatId: ChatId,
  cursor: CursorMap = {},
): Promise<{ filename: string; content: string }> {
  return exportActiveBranchAsTxt(getWorkspaceRepository(), chatId, cursor)
}

export async function exportChatAsTxt(
  chatId: ChatId,
  cursor: CursorMap = {},
): Promise<{ filename: string; content: string }> {
  return exportCurrentViewAsTxt(chatId, cursor)
}

export async function exportLastUpdatedChatAsTxt(
  chatId: ChatId,
): Promise<{ filename: string; content: string }> {
  return exportLastUpdatedBranchAsTxt(getWorkspaceRepository(), chatId)
}

export function triggerBrowserDownload(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
