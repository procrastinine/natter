import type { ChatId, ChatTag, TagId } from '../core/types'
import { onEvent } from './broadcast'
import { getDb } from './db'
import type { CreateTagInput, UpdateTagInput } from './repository'
import { getWorkspaceRepository } from './workspace-repository'

let cache: ChatTag[] | null = null
let unsubscribe: (() => void) | null = null

function ensureListener(): void {
  if (unsubscribe) return
  unsubscribe = onEvent((event) => {
    if (event.kind === 'tag-mutated' || event.kind === 'tag-deleted') {
      cache = null
    }
  })
}

export async function listTags(): Promise<ChatTag[]> {
  ensureListener()
  // Keep this read synchronous up to the Dexie table access so useLiveQuery can
  // subscribe to tag writes. The UI still depends only on this store-layer
  // abstraction; daemon mode will replace the store implementation.
  try {
    const rows = await getDb().tags.toArray()
    return sortTags(rows).map((tag) => ({ ...tag }))
  } catch (error) {
    if (error instanceof Error && error.name === 'DatabaseClosedError') return []
    throw error
  }
}

export async function getTag(tagId: TagId): Promise<ChatTag | undefined> {
  ensureListener()
  const cached = cache?.find((tag) => tag.id === tagId)
  if (cached) return { ...cached }
  return getWorkspaceRepository().getTag(tagId)
}

export async function createTag(input: CreateTagInput): Promise<ChatTag> {
  ensureListener()
  return getWorkspaceRepository().createTag(input)
}

export async function updateTag(tagId: TagId, patch: UpdateTagInput): Promise<ChatTag | undefined> {
  ensureListener()
  return getWorkspaceRepository().updateTag(tagId, patch)
}

export async function deleteTag(tagId: TagId): Promise<boolean> {
  ensureListener()
  const result = await getWorkspaceRepository().deleteTag(tagId)
  return result.deleted
}

export interface MergeTagResult {
  merged: boolean
  affectedChatIds: ChatId[]
}

export function mergeTagIds(
  tags: readonly TagId[],
  sourceTagId: TagId,
  targetTagId: TagId,
): TagId[] {
  if (sourceTagId === targetTagId) return [...tags]
  const result: TagId[] = []
  let targetAlreadySeen = false
  for (const tagId of tags) {
    if (tagId === targetTagId) {
      if (!targetAlreadySeen) result.push(tagId)
      targetAlreadySeen = true
      continue
    }
    if (tagId === sourceTagId) {
      if (!targetAlreadySeen) {
        result.push(targetTagId)
        targetAlreadySeen = true
      }
      continue
    }
    result.push(tagId)
  }
  return result
}

export async function mergeTagInto(
  sourceTagId: TagId,
  targetTagId: TagId,
  now = Date.now(),
): Promise<MergeTagResult> {
  ensureListener()
  if (sourceTagId === targetTagId) return { merged: false, affectedChatIds: [] }
  const repo = getWorkspaceRepository()
  const [source, target, chats] = await Promise.all([
    repo.getTag(sourceTagId),
    repo.getTag(targetTagId),
    repo.listChats(),
  ])
  if (!source || !target) return { merged: false, affectedChatIds: [] }
  const affectedChatIds: ChatId[] = []
  for (const chat of chats) {
    if (!chat.tags.includes(sourceTagId)) continue
    const nextTags = mergeTagIds(chat.tags, sourceTagId, targetTagId)
    if (sameStringList(chat.tags, nextTags)) continue
    await repo.runMutation([{ kind: 'chat-meta', chatId: chat.id }], async (ctx) => {
      const current = await ctx.getChat(chat.id)
      if (!current) return
      const currentNext = mergeTagIds(current.tags, sourceTagId, targetTagId)
      if (sameStringList(current.tags, currentNext)) return
      ctx.patchChatMeta(chat.id, { tags: currentNext, updatedAt: now })
    })
    affectedChatIds.push(chat.id)
  }
  await repo.updateTag(targetTagId, { lastUsedAt: now, now })
  const deleted = await repo.deleteTag(sourceTagId)
  return { merged: deleted.deleted, affectedChatIds }
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  return left.every((value, index) => value === right[index])
}

export function __resetTagStoreForTests(): void {
  cache = null
  unsubscribe?.()
  unsubscribe = null
}

function sortTags(rows: ChatTag[]): ChatTag[] {
  return rows.sort((left, right) => {
    const byName = left.nameLower.localeCompare(right.nameLower)
    return byName !== 0 ? byName : left.id.localeCompare(right.id)
  })
}
