import { buildBranchCacheRow } from '../core/branch-flatten'
import type { ChatBranchCache, ChatId } from '../core/types'
import { onEvent } from './broadcast'
import { getWorkspaceRepository } from './workspace-repository'

let cacheByChat = new Map<ChatId, ChatBranchCache | undefined>()
let unsubscribe: (() => void) | null = null

function ensureListener(): void {
  if (unsubscribe) return
  unsubscribe = onEvent((event) => {
    if (event.kind === 'branch-cache-refreshed' || event.kind === 'chat-mutated') {
      cacheByChat.delete(event.chatId)
    }
  })
}

export async function getChatBranchCache(chatId: ChatId): Promise<ChatBranchCache | undefined> {
  ensureListener()
  if (cacheByChat.has(chatId)) return cacheByChat.get(chatId)
  const row = await getWorkspaceRepository().getChatBranchCache(chatId)
  cacheByChat.set(chatId, row)
  return row
}

export function isChatBranchCacheFresh(
  chat: { lastUpdatedLeafId: string | null; lastBranchUpdatedAt: number },
  cache: ChatBranchCache | undefined,
): cache is ChatBranchCache {
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
  const chat = await repo.getChat(chatId)
  if (!chat) return undefined
  const existing = await getChatBranchCache(chatId)
  if (isChatBranchCacheFresh(chat, existing)) return existing
  return refreshChatBranchCache(chatId)
}

export async function refreshChatBranchCache(chatId: ChatId): Promise<ChatBranchCache | undefined> {
  ensureListener()
  const repo = getWorkspaceRepository()
  const chat = await repo.getChat(chatId)
  if (!chat) {
    await repo.deleteChatBranchCache(chatId)
    cacheByChat.delete(chatId)
    return undefined
  }
  if (chat.lastUpdatedLeafId === null) {
    await repo.deleteChatBranchCache(chatId)
    cacheByChat.set(chatId, undefined)
    return undefined
  }
  const messages = await repo.getBranchByLeaf(chatId, chat.lastUpdatedLeafId)
  const row = buildBranchCacheRow({
    chatId,
    branchLeafId: chat.lastUpdatedLeafId,
    messages,
  })
  const saved = await repo.putChatBranchCache(row)
  cacheByChat.set(chatId, saved)
  return saved
}

export function __resetBranchCacheStoreForTests(): void {
  cacheByChat = new Map()
  unsubscribe?.()
  unsubscribe = null
}
