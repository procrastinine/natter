import type Dexie from 'dexie'
import type { Transaction } from 'dexie'
import type { Chat, ChatId, ChatSidebarRow } from '../core/types'
import type { SettingsRow } from './db-rows'

export const CHAT_SIDEBAR_PROJECTION_BACKFILL_KEY = 'backfill:chat-sidebar-projection-v1'
export const CHAT_SIDEBAR_PROJECTION_MANIFEST_KEY = 'projection:chat-sidebar-v1'

const CHAT_SIDEBAR_PROJECTION_VERSION = 1
const REBUILD_BATCH_SIZE = 128

export interface ChatSidebarProjectionRow extends ChatSidebarRow {
  projectionVersion: typeof CHAT_SIDEBAR_PROJECTION_VERSION
  checksum: string
}

interface ChatSidebarProjectionManifest {
  projectionVersion: typeof CHAT_SIDEBAR_PROJECTION_VERSION
  expectedCount: number
}

export function projectChatSidebarRow(chat: Chat): ChatSidebarRow {
  return {
    id: chat.id,
    title: chat.title,
    titleStatus: chat.titleStatus,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    lastViewedAt: chat.lastViewedAt,
    wordCount: chat.wordCount,
    totalCostUsd: chat.totalCostUsd,
    lastUpdatedLeafId: chat.lastUpdatedLeafId,
    lastBranchUpdatedAt: chat.lastBranchUpdatedAt,
    archived: chat.archived,
    pinned: chat.pinned,
    folderId: chat.folderId,
    tags: [...chat.tags],
    ...(chat.previewText !== undefined ? { previewText: chat.previewText } : {}),
  }
}

export function chatSidebarProjectionRow(chat: Chat): ChatSidebarProjectionRow {
  const row = projectChatSidebarRow(chat)
  return {
    ...row,
    projectionVersion: CHAT_SIDEBAR_PROJECTION_VERSION,
    checksum: sidebarRowChecksum(row),
  }
}

export function chatSidebarProjectionSettings(expectedCount: number): SettingsRow[] {
  return [
    { key: CHAT_SIDEBAR_PROJECTION_BACKFILL_KEY, value: 1 },
    {
      key: CHAT_SIDEBAR_PROJECTION_MANIFEST_KEY,
      value: {
        projectionVersion: CHAT_SIDEBAR_PROJECTION_VERSION,
        expectedCount,
      } satisfies ChatSidebarProjectionManifest,
    },
  ]
}

export function isChatSidebarProjectionSettingKey(key: string): boolean {
  return (
    key === CHAT_SIDEBAR_PROJECTION_BACKFILL_KEY || key === CHAT_SIDEBAR_PROJECTION_MANIFEST_KEY
  )
}

export function isValidChatSidebarProjectionRow(
  row: Omit<ChatSidebarProjectionRow, 'projectionVersion'> & { projectionVersion: number },
): boolean {
  return (
    row.projectionVersion === CHAT_SIDEBAR_PROJECTION_VERSION &&
    row.checksum === sidebarRowChecksum(row)
  )
}

export function isValidChatSidebarProjectionManifest(value: unknown, actualCount: number): boolean {
  if (!value || typeof value !== 'object') return false
  const manifest = value as Partial<ChatSidebarProjectionManifest>
  return (
    manifest.projectionVersion === CHAT_SIDEBAR_PROJECTION_VERSION &&
    manifest.expectedCount === actualCount &&
    Number.isSafeInteger(manifest.expectedCount) &&
    (manifest.expectedCount ?? -1) >= 0
  )
}

export function publicChatSidebarRow(row: ChatSidebarProjectionRow): ChatSidebarRow {
  const { projectionVersion: _projectionVersion, checksum: _checksum, ...chat } = row
  return { ...chat, tags: [...chat.tags] }
}

export async function putChatSidebarProjection(
  tx: Transaction,
  chat: Chat,
  sourceWasCreated = false,
): Promise<void> {
  const table = tx.table<ChatSidebarProjectionRow, ChatId>('chatSidebarRows')
  const next = chatSidebarProjectionRow(chat)
  const current = await table.get(chat.id)
  if (!current || current.checksum !== next.checksum || !isValidChatSidebarProjectionRow(current)) {
    await table.put(next)
  }
  if (sourceWasCreated) await adjustExpectedCount(tx, 1)
}

export async function deleteChatSidebarProjections(
  tx: Transaction,
  deletedSourceChatIds: readonly ChatId[],
): Promise<void> {
  const ids = [...new Set(deletedSourceChatIds)]
  if (ids.length === 0) return
  await tx.table<ChatSidebarProjectionRow, ChatId>('chatSidebarRows').bulkDelete(ids)
  await adjustExpectedCount(tx, -ids.length)
}

export async function rebuildChatSidebarProjection(db: Dexie): Promise<void> {
  await db.transaction('rw', ['chats', 'chatSidebarRows', 'settings'], async (tx) => {
    const chats = tx.table<Chat, ChatId>('chats')
    const rows = tx.table<ChatSidebarProjectionRow, ChatId>('chatSidebarRows')
    await rows.clear()
    let after: ChatId | undefined
    let count = 0
    for (;;) {
      const batch: Chat[] = []
      let lastPrimaryKey: ChatId | undefined
      const collection =
        after === undefined ? chats.orderBy(':id') : chats.where(':id').above(after)
      await collection.limit(REBUILD_BATCH_SIZE).each((chat, cursor) => {
        batch.push(chat)
        lastPrimaryKey = cursor.primaryKey
      })
      if (batch.length === 0) break
      await rows.bulkPut(batch.map(chatSidebarProjectionRow))
      count += batch.length
      if (batch.length < REBUILD_BATCH_SIZE) break
      if (lastPrimaryKey === undefined) throw new Error('ChatSidebarProjectionPrimaryKeyMissing')
      after = lastPrimaryKey
    }
    await tx.table<SettingsRow, string>('settings').bulkPut(chatSidebarProjectionSettings(count))
  })
}

async function adjustExpectedCount(tx: Transaction, delta: number): Promise<void> {
  const settings = tx.table<SettingsRow, string>('settings')
  const row = await settings.get(CHAT_SIDEBAR_PROJECTION_MANIFEST_KEY)
  const value = row?.value
  if (!value || typeof value !== 'object') throw new Error('ChatSidebarProjectionManifestMissing')
  const manifest = value as Partial<ChatSidebarProjectionManifest>
  if (
    manifest.projectionVersion !== CHAT_SIDEBAR_PROJECTION_VERSION ||
    !Number.isSafeInteger(manifest.expectedCount) ||
    (manifest.expectedCount ?? -1) < 0
  ) {
    throw new Error('ChatSidebarProjectionManifestInvalid')
  }
  const expectedCount = (manifest.expectedCount as number) + delta
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 0) {
    throw new Error('ChatSidebarProjectionCountInvalid')
  }
  await settings.put(chatSidebarProjectionSettings(expectedCount)[1] as SettingsRow)
}

function sidebarRowChecksum(row: ChatSidebarRow): string {
  const serialized = JSON.stringify([
    row.id,
    row.title,
    row.titleStatus,
    row.createdAt,
    row.updatedAt,
    row.lastViewedAt,
    row.wordCount,
    row.totalCostUsd,
    row.lastUpdatedLeafId,
    row.lastBranchUpdatedAt,
    row.archived,
    row.pinned,
    row.folderId,
    row.tags,
    row.previewText ?? null,
  ])
  let hash = 0x811c9dc5
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}
