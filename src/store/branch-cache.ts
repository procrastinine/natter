import { buildBranchCacheRow } from '../core/branch-flatten'
import type { ChatBranchCache, ChatId } from '../core/types'
import { onEvent } from './broadcast'
import { chatMatchesBranchCacheWriteGuard, readChatBranchCacheSource } from './repository'
import { getWorkspaceRepository } from './workspace-repository'

let cacheByChat = new Map<ChatId, ChatBranchCache | undefined>()
let unsubscribe: (() => void) | null = null
let invalidationEpoch = 0

function ensureListener(): void {
  if (unsubscribe) return
  unsubscribe = onEvent((event) => {
    if (event.kind === 'workspace-invalidated' || event.kind === 'workspace-replaced') {
      invalidationEpoch += 1
      cacheByChat.clear()
      return
    }
    if (event.kind === 'branch-cache-refreshed' || event.kind === 'chat-mutated') {
      invalidationEpoch += 1
      cacheByChat.delete(event.chatId)
    }
  })
}

async function getChatBranchCache(chatId: ChatId): Promise<ChatBranchCache | undefined> {
  ensureListener()
  for (;;) {
    if (cacheByChat.has(chatId)) return cacheByChat.get(chatId)
    const epoch = invalidationEpoch
    const row = await getWorkspaceRepository().getChatBranchCache(chatId)
    if (epoch !== invalidationEpoch) continue
    cacheByChat.set(chatId, row)
    return row
  }
}

export function isChatBranchCacheFresh(
  chat: { lastUpdatedLeafId: string | null; lastBranchUpdatedAt: number },
  cache: ChatBranchCache | undefined,
): boolean {
  return (
    cache !== undefined &&
    cache.branchLeafId === chat.lastUpdatedLeafId &&
    cache.generatedAt >= chat.lastBranchUpdatedAt
  )
}

export async function readFreshChatBranchCache(
  chatId: ChatId,
): Promise<ChatBranchCache | undefined> {
  ensureListener()
  const repo = getWorkspaceRepository()
  for (;;) {
    const { chat, expected } = await readChatBranchCacheSource(repo, chatId)
    if (!chat) return undefined
    const existing = await getChatBranchCache(chatId)
    if ((await repo.getWorkspaceMeta()).replacementEpoch !== expected.replacementEpoch) continue
    if (existing && isChatBranchCacheFresh(chat, existing)) return existing
    return refreshChatBranchCache(chatId)
  }
}

export async function refreshChatBranchCache(chatId: ChatId): Promise<ChatBranchCache | undefined> {
  ensureListener()
  const repo = getWorkspaceRepository()
  for (;;) {
    const { chat, expected } = await readChatBranchCacheSource(repo, chatId)
    if (!chat) {
      await repo.deleteChatBranchCache(chatId, expected)
      const current = await readChatBranchCacheSource(repo, chatId)
      if (
        current.expected.replacementEpoch !== expected.replacementEpoch ||
        current.chat !== undefined
      ) {
        continue
      }
      cacheByChat.delete(chatId)
      return undefined
    }
    if (chat.lastUpdatedLeafId === null) {
      await repo.deleteChatBranchCache(chatId, expected)
      const current = await readChatBranchCacheSource(repo, chatId)
      if (
        current.expected.replacementEpoch !== expected.replacementEpoch ||
        !current.chat ||
        !chatMatchesBranchCacheWriteGuard(current.chat, expected)
      ) {
        continue
      }
      cacheByChat.delete(chatId)
      return undefined
    }
    const messages = await repo.getBranchByLeaf(chatId, chat.lastUpdatedLeafId)
    const row = buildBranchCacheRow({
      chatId,
      branchLeafId: chat.lastUpdatedLeafId,
      messages,
      generatedAt: Math.max(Date.now(), chat.lastBranchUpdatedAt),
    })
    const written = await repo.putChatBranchCache(row, expected)
    if (!written) continue
    return written
  }
}

export function __resetBranchCacheStoreForTests(): void {
  cacheByChat = new Map()
  invalidationEpoch = 0
  unsubscribe?.()
  unsubscribe = null
}
