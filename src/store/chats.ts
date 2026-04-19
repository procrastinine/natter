// Chat-level persistence helpers. See `plan/02-data-model.md §2.1` and
// `plan/03-storage.md §3.1`.
//
// These helpers own chat-row CRUD and the read-side APIs that sit above the
// repository boundary. Visible chat-row writes go through `WorkspaceRepository`
// so browser mode already matches the future daemon contract.

import type { Chat, ChatId, ChatSettings, Message, MessageId, PresetId } from '../core/types'
import { cloneDefaultChatSettings } from '../core/defaults'
import { newId } from '../lib/ulid'
import { postEvent } from './broadcast'
import { getBrowserRepository } from './browser-repo'
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
    metaVersion: 0,
    summaryVersion: 0,
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
  postEvent({
    kind: 'chat-mutated',
    chatId: chat.id,
    metaVersion: 0,
    summaryVersion: 0,
    affected: [{ kind: 'chat-meta', chatId: chat.id }],
  })
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
  const repo = getBrowserRepository()
  await repo.runMutation([{ kind: 'chat-meta', chatId }], async (ctx) => {
    const chat = await ctx.getChat(chatId)
    if (!chat || chat.archived) return
    ctx.patchChatMeta(chatId, { archived: true, updatedAt: now })
  })
}

export async function unarchiveChat(
  chatId: ChatId,
  now = Date.now(),
): Promise<void> {
  const repo = getBrowserRepository()
  await repo.runMutation([{ kind: 'chat-meta', chatId }], async (ctx) => {
    const chat = await ctx.getChat(chatId)
    if (!chat?.archived) return
    ctx.patchChatMeta(chatId, { archived: false, updatedAt: now })
  })
}

// Record a chat-open event per §2.1.2 rule 1. Bumps `lastViewedAt` only and is
// explicitly non-visible: it does not advance summary/meta versions or emit a
// chat-mutated event.
export async function touchLastViewed(
  chatId: ChatId,
  now = Date.now(),
): Promise<void> {
  const repo = getBrowserRepository()
  await repo.runMutation([{ kind: 'chat-meta', chatId }], async (ctx) => {
    const chat = await ctx.getChat(chatId)
    if (!chat || chat.lastViewedAt >= now) return
    ctx.patchChatMeta(chatId, { lastViewedAt: now }, { touchVisibleState: false, broadcast: false })
  })
}

// Manual title edit. Sets `titleStatus = 'manual'` and overwrites `title` with
// the trimmed value. Callers must pre-validate that the trimmed title is
// non-empty — the helper defensively short-circuits if it is anyway. See
// plan/02-data-model.md §2.1.1 and plan/10-ui.md §10.3 inline title editor.
export async function setManualTitle(
  chatId: ChatId,
  title: string,
  now = Date.now(),
): Promise<boolean> {
  const trimmed = title.trim()
  if (trimmed.length === 0) return false
  const repo = getBrowserRepository()
  let changed = false
  await repo.runMutation([{ kind: 'chat-meta', chatId }], async (ctx) => {
    const chat = await ctx.getChat(chatId)
    if (!chat) return
    if (chat.title === trimmed && chat.titleStatus === 'manual') {
      return
    }
    changed = true
    ctx.patchChatMeta(chatId, {
      title: trimmed,
      titleStatus: 'manual',
      updatedAt: now,
    })
  })
  return changed
}

// Partial `ChatSettings` patch through the chat-meta scope. Used by the
// settings pane (system prompt edit, rendering pref tweaks, etc.). Returns
// true if anything actually changed. Concurrency is LWW on the chat-meta row,
// consistent with other settings edits. See plan/14-details.md §14.35.5.
export async function updateChatSettings(
  chatId: ChatId,
  patch: Partial<ChatSettings>,
  now = Date.now(),
): Promise<boolean> {
  const keys = Object.keys(patch) as Array<keyof ChatSettings>
  if (keys.length === 0) return false
  const repo = getBrowserRepository()
  let changed = false
  await repo.runMutation([{ kind: 'chat-meta', chatId }], async (ctx) => {
    const chat = await ctx.getChat(chatId)
    if (!chat) return
    const nextSettings = { ...chat.settings, ...patch }
    if (sameSettingsFor(chat.settings, nextSettings, keys)) return
    changed = true
    ctx.patchChatMeta(chatId, {
      settings: nextSettings,
      updatedAt: now,
    })
  })
  return changed
}

function sameSettingsFor(
  prev: ChatSettings,
  next: ChatSettings,
  keys: Array<keyof ChatSettings>,
): boolean {
  for (const key of keys) {
    if (!Object.is(prev[key], next[key])) {
      if (JSON.stringify(prev[key]) !== JSON.stringify(next[key])) return false
    }
  }
  return true
}

// Sidebar preview length cap. Kept here (not in ChatList) because the
// write path owns the canonical truncation — readers just render what the
// chat row carries, no length math in the UI.
const PREVIEW_MAX_CHARS = 80

// Recomputes `chat.previewText` from the earliest live user message and
// writes it back if it changed. Idempotent — safe to over-call. Uses the
// chat-meta scope so it plays nicely with concurrent sends/edits through
// the repository boundary. `touchVisibleState: false` because this is a
// derived cache, not a user-visible edit: it must not bump
// `updatedAt` / `metaVersion` / `summaryVersion` (otherwise the sidebar
// would reorder on every sidebar refresh, and meta-version-gated caches
// would thrash).
export async function refreshChatPreview(chatId: ChatId): Promise<void> {
  const messages = await loadChatMessages(chatId)
  let earliest: Message | undefined
  for (const m of messages) {
    if (m.deleted || m.role !== 'user') continue
    if (!earliest || m.createdAt < earliest.createdAt) earliest = m
  }
  let plain = ''
  if (earliest) {
    const parts: string[] = []
    for (const p of earliest.content) {
      if (p.type === 'text' || p.type === 'output_text') parts.push(p.text)
    }
    plain = parts.join('')
  }
  const trimmed = plain.replace(/\s+/g, ' ').trim()
  const preview =
    trimmed.length > PREVIEW_MAX_CHARS
      ? `${trimmed.slice(0, PREVIEW_MAX_CHARS - 1)}…`
      : trimmed
  const repo = getBrowserRepository()
  await repo.runMutation([{ kind: 'chat-meta', chatId }], async (ctx) => {
    const chat = await ctx.getChat(chatId)
    if (!chat) return
    if (chat.previewText === preview) return
    ctx.patchChatMeta(
      chatId,
      { previewText: preview },
      { touchVisibleState: false, broadcast: false },
    )
  })
}
