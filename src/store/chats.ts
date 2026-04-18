// Chat-level persistence helpers. See `plan/02-data-model.md §2.1` and
// `plan/03-storage.md §3.1`.
//
// These helpers own *chat-row* CRUD (create / read / list / soft-delete) and
// the thin read-side API the UI and the message-tree ops use. Anything that
// mutates more than the chat row goes through `withChatLock` from
// `src/store/locks.ts`.

import type { Chat, ChatId, ChatSettings, Message, MessageId, PresetId } from '../core/types'
import { cloneDefaultChatSettings } from '../core/defaults'
import { newId } from '../lib/ulid'
import { postEvent } from './broadcast'
import { getDb, openDb } from './db'

export interface CreateChatInput {
  id?: ChatId
  title?: string
  settings?: ChatSettings
  presetId?: PresetId
  now?: number
}

// Allocate a fresh Chat row with the Phase-0 defaults. The message table is
// left empty — the caller's first `sendUserMessage` produces the root user
// message. Returns the full Chat for the caller to hold in Zustand.
export async function createChat(input: CreateChatInput = {}): Promise<Chat> {
  const db = await openDb()
  const now = input.now ?? Date.now()
  const chat: Chat = {
    id: input.id ?? newId(),
    title: input.title ?? '',
    titleStatus: 'untitled',
    createdAt: now,
    updatedAt: now,
    lastViewedAt: now,
    wordCount: 0,
    totalCostUsd: 0,
    version: 0,
    settings: input.settings ?? cloneDefaultChatSettings(),
    lastUpdatedLeafId: null,
    lastBranchUpdatedAt: now,
    archived: false,
    pinned: false,
    folderId: null,
    tags: [],
  }
  if (input.presetId !== undefined) chat.presetId = input.presetId
  await db.chats.put(chat)
  postEvent({ kind: 'chat-mutated', chatId: chat.id, version: 0 })
  return chat
}

export async function getChat(chatId: ChatId): Promise<Chat | undefined> {
  return getDb().chats.get(chatId)
}

export async function listChats(): Promise<Chat[]> {
  return getDb().chats.toArray()
}

// Load every message row for a chat, including tombstones. Callers filter
// `!deleted` per op (search + cache writers want tombstones; active-path
// renderers want only live nodes).
export async function loadChatMessages(chatId: ChatId): Promise<Message[]> {
  return getDb().messages.where('chatId').equals(chatId).toArray()
}

export async function getMessage(
  messageId: MessageId,
): Promise<Message | undefined> {
  return getDb().messages.get(messageId)
}

// Soft-deletes a chat by setting `archived: true` (the reversible variant).
// Hard chat delete — cascading message + attachment-refcount cleanup — is a
// Phase 5+ concern gated behind the storage settings pane.
export async function archiveChat(chatId: ChatId, now = Date.now()): Promise<void> {
  const db = getDb()
  const chat = await db.chats.get(chatId)
  if (!chat) return
  await db.chats.put({
    ...chat,
    archived: true,
    updatedAt: now,
    version: chat.version + 1,
  })
  postEvent({ kind: 'chat-mutated', chatId, version: chat.version + 1 })
}

export async function unarchiveChat(
  chatId: ChatId,
  now = Date.now(),
): Promise<void> {
  const db = getDb()
  const chat = await db.chats.get(chatId)
  if (!chat) return
  await db.chats.put({
    ...chat,
    archived: false,
    updatedAt: now,
    version: chat.version + 1,
  })
  postEvent({ kind: 'chat-mutated', chatId, version: chat.version + 1 })
}

// Record a chat-open event per §2.1.2 rule 1. Bumps `lastViewedAt` only —
// does NOT touch `lastUpdatedLeafId`, branch cache, or `version`. Written
// OUTSIDE `withChatLock` because it's allowed to race harmlessly: the later
// tab's write wins, which is fine since `lastViewedAt` is monotonic.
export async function touchLastViewed(
  chatId: ChatId,
  now = Date.now(),
): Promise<void> {
  const db = getDb()
  const chat = await db.chats.get(chatId)
  if (!chat) return
  if (chat.lastViewedAt >= now) return
  await db.chats.put({ ...chat, lastViewedAt: now })
}
