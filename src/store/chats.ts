// Chat-level persistence helpers. See `plan/02-data-model.md §2.1` and
// `plan/03-storage.md §3.1`.
//
// These helpers own chat-row CRUD and the read-side APIs that sit above the
// repository boundary. Visible chat-row writes go through `WorkspaceRepository`
// so browser mode already matches the future daemon contract.

import { cloneDefaultChatSettings } from '../core/defaults'
import { normalizeReasoningSettings } from '../core/reasoning'
import type {
  Chat,
  ChatId,
  ChatSettings,
  ChatTag,
  FolderId,
  Message,
  MessageId,
  PresetId,
  TagId,
} from '../core/types'
import { newId } from '../lib/ulid'
import { postEvent } from './broadcast'
import { getDb, openDb } from './db'
import { getWorkspaceRepository } from './workspace-repository'

type OptionalKeys<T> = {
  [K in keyof T]-?: Record<never, never> extends Pick<T, K> ? K : never
}[keyof T]

type ChatSettingsPatch = {
  [K in keyof ChatSettings]?: K extends OptionalKeys<ChatSettings>
    ? ChatSettings[K] | undefined
    : ChatSettings[K]
}

function isDatabaseClosedError(error: unknown): boolean {
  const candidate = error as { name?: unknown; inner?: { name?: unknown } } | null
  return candidate?.name === 'DatabaseClosedError' || candidate?.inner?.name === 'DatabaseClosedError'
}

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
  const settings = normalizeChatSettings(input.settings ?? cloneDefaultChatSettings())
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
    settings,
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

// The store/ layer is the abstraction boundary — UI code goes through
// these functions rather than touching Dexie directly. Reads still call
// `getDb()` inline here (not through the repo's async `openDb().then(...)`
// wrapper) because `useLiveQuery` relies on Dexie's synchronous table-
// access tracking to know when to re-run; inserting an await would lose
// that subscription and the UI would stop updating as messages arrive.
// Writes already route through `getWorkspaceRepository().runMutation(...)`.
// Daemon-mode will swap this file's implementations wholesale — callers
// never change.
export async function getChat(chatId: ChatId): Promise<Chat | undefined> {
  try {
    return await getDb().chats.get(chatId)
  } catch (error) {
    if (isDatabaseClosedError(error)) return undefined
    throw error
  }
}

export async function listChats(): Promise<Chat[]> {
  try {
    return await getDb().chats.toArray()
  } catch (error) {
    if (isDatabaseClosedError(error)) return []
    throw error
  }
}

// Load every message row for a chat, including tombstones. Callers filter
// `!deleted` per op (search + cache writers want tombstones; active-path
// renderers want only live nodes).
export async function loadChatMessages(chatId: ChatId): Promise<Message[]> {
  try {
    return await getDb().messages.where('chatId').equals(chatId).toArray()
  } catch (error) {
    if (isDatabaseClosedError(error)) return []
    throw error
  }
}

export async function getMessage(messageId: MessageId): Promise<Message | undefined> {
  try {
    return await getDb().messages.get(messageId)
  } catch (error) {
    if (isDatabaseClosedError(error)) return undefined
    throw error
  }
}

// Draft reads. Writes go through the repo's runMutation with the `draft`
// scope. Read stays on `getDb()` so `useLiveQuery` can track the drafts
// table for the typing indicator.
export async function getChatDraft(chatId: ChatId) {
  try {
    return await getDb().drafts.get(chatId)
  } catch (error) {
    if (isDatabaseClosedError(error)) return undefined
    throw error
  }
}

// Soft-deletes a chat by setting `archived: true` (the reversible variant).
// Hard chat delete — cascading message + attachment-refcount cleanup — is a
// Phase 5+ concern gated behind the storage settings pane.
export async function archiveChat(chatId: ChatId, now = Date.now()): Promise<void> {
  const repo = getWorkspaceRepository()
  await repo.runMutation([{ kind: 'chat-meta', chatId }], async (ctx) => {
    const chat = await ctx.getChat(chatId)
    if (!chat || chat.archived) return
    ctx.patchChatMeta(chatId, { archived: true, updatedAt: now })
  })
}

export async function unarchiveChat(chatId: ChatId, now = Date.now()): Promise<void> {
  const repo = getWorkspaceRepository()
  await repo.runMutation([{ kind: 'chat-meta', chatId }], async (ctx) => {
    const chat = await ctx.getChat(chatId)
    if (!chat?.archived) return
    ctx.patchChatMeta(chatId, { archived: false, updatedAt: now })
  })
}

export async function deleteArchivedChatPermanently(chatId: ChatId): Promise<boolean> {
  return getWorkspaceRepository().deleteArchivedChat(chatId)
}

export async function emptyArchivedChats(): Promise<ChatId[]> {
  const result = await getWorkspaceRepository().emptyArchivedChats()
  return result.deletedChatIds
}

export async function moveChatToFolder(
  chatId: ChatId,
  folderId: FolderId | null,
  now = Date.now(),
): Promise<boolean> {
  const repo = getWorkspaceRepository()
  let changed = false
  await repo.runMutation([{ kind: 'chat-meta', chatId }], async (ctx) => {
    const chat = await ctx.getChat(chatId)
    if (!chat) return
    if ((chat.folderId ?? null) === folderId) return
    changed = true
    ctx.patchChatMeta(chatId, { folderId, updatedAt: now })
  })
  if (changed && folderId) {
    await repo.updateFolder(folderId, { lastUsedAt: now, now })
  }
  return changed
}

export async function setChatTags(
  chatId: ChatId,
  tagIds: readonly TagId[],
  now = Date.now(),
): Promise<boolean> {
  const uniqueTagIds = [...new Set(tagIds)]
  const repo = getWorkspaceRepository()
  let changed = false
  await repo.runMutation([{ kind: 'chat-meta', chatId }], async (ctx) => {
    const chat = await ctx.getChat(chatId)
    if (!chat) return
    if (sameStringList(chat.tags, uniqueTagIds)) return
    changed = true
    ctx.patchChatMeta(chatId, { tags: uniqueTagIds, updatedAt: now })
  })
  if (changed) {
    await Promise.all(uniqueTagIds.map((tagId) => repo.updateTag(tagId, { lastUsedAt: now, now })))
  }
  return changed
}

export async function setChatTagsFromNames(
  chatId: ChatId,
  names: readonly string[],
  now = Date.now(),
): Promise<TagId[]> {
  const normalizedNames = uniqueTagNames(names)
  const repo = getWorkspaceRepository()
  const knownTags = await repo.listTags()
  const byLower = new Map(knownTags.map((tag) => [tag.nameLower, tag]))
  const tagIds: TagId[] = []
  for (const name of normalizedNames) {
    const lower = name.toLocaleLowerCase()
    const existing = byLower.get(lower)
    if (existing) {
      tagIds.push(existing.id)
      continue
    }
    const created = await repo.createTag({ name, now })
    byLower.set(created.nameLower, created)
    tagIds.push(created.id)
  }
  await setChatTags(chatId, tagIds, now)
  await pruneUnusedTags(repo)
  return tagIds
}

// Record a chat-open event per §2.1.2 rule 1. Bumps `lastViewedAt` only and is
// explicitly non-visible: it does not advance summary/meta versions or emit a
// chat-mutated event.
export async function touchLastViewed(chatId: ChatId, now = Date.now()): Promise<void> {
  const repo = getWorkspaceRepository()
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
  const repo = getWorkspaceRepository()
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
// Link / unlink the breadcrumb preset reference on a chat. Used when the
// user loads a preset into an existing chat or saves the chat's current
// settings as a new preset.
// Flip a message's `hiddenFromContext` flag. Hidden messages are
// excluded from the outgoing request (the transform layer already honors
// the flag) and surfaced with a dashed profile ring in the UI. The
// message stays visible in the chat — this is context visibility, not
// deletion. Idempotent; no-op if the flag is already the desired value.
export async function toggleMessageHidden(messageId: MessageId): Promise<void> {
  const repo = getWorkspaceRepository()
  await repo.runMutation([{ kind: 'message', messageId }], async (ctx) => {
    const current = await ctx.getMessage(messageId)
    if (!current) return
    const next = !current.hiddenFromContext
    if (current.hiddenFromContext === next) return
    await ctx.putMessage({ ...current, hiddenFromContext: next })
  })
}

// Clears `generation.abortReason` and any recorded error on a message,
// removing the "Stream interrupted" banner. Keeps all other generation
// metadata intact (usage, model, reasoning details). Used for the dismiss
// button on the abort banner and auto-cleared after a successful continue.
export async function dismissAbortReason(messageId: MessageId): Promise<void> {
  const repo = getWorkspaceRepository()
  await repo.runMutation([{ kind: 'message', messageId }], async (ctx) => {
    const current = await ctx.getMessage(messageId)
    if (!current) return
    const gen = current.generation
    if (!gen) return
    if (gen.abortReason === undefined && gen.error === undefined) return
    const nextGen = { ...gen }
    delete (nextGen as { abortReason?: unknown }).abortReason
    delete (nextGen as { error?: unknown }).error
    await ctx.putMessage({ ...current, generation: nextGen })
  })
}

export async function setChatPreset(
  chatId: ChatId,
  presetId: PresetId | null,
  now = Date.now(),
): Promise<void> {
  const repo = getWorkspaceRepository()
  await repo.runMutation([{ kind: 'chat-meta', chatId }], async (ctx) => {
    const chat = await ctx.getChat(chatId)
    if (!chat) return
    if ((chat.presetId ?? null) === presetId) return
    // exactOptionalPropertyTypes rejects `{ presetId: undefined }`, so a
    // cast is required when clearing the field so the Partial<Chat> literal
    // doesn't carry the undefined value explicitly.
    const next: Partial<Chat> =
      presetId === null
        ? ({ updatedAt: now, presetId: undefined } as unknown as Partial<Chat>)
        : { updatedAt: now, presetId }
    ctx.patchChatMeta(chatId, next)
  })
}

export async function updateChatSettings(
  chatId: ChatId,
  patch: ChatSettingsPatch,
  now = Date.now(),
): Promise<boolean> {
  const keys = Object.keys(patch) as Array<keyof ChatSettings>
  if (keys.length === 0) return false
  const repo = getWorkspaceRepository()
  let changed = false
  await repo.runMutation([{ kind: 'chat-meta', chatId }], async (ctx) => {
    const chat = await ctx.getChat(chatId)
    if (!chat) return
    let nextSettings = { ...chat.settings } as ChatSettings
    for (const key of keys) {
      const value = patch[key]
      if (value === undefined) delete (nextSettings as Partial<ChatSettings>)[key]
      else (nextSettings as Record<keyof ChatSettings, unknown>)[key] = value
    }
    // Always apply the reasoning normalizer on write — partial reasoning
    // patches (e.g. mode-only updates from the segmented control) can land
    // here without an `include` block, and downstream readers (chooseApi,
    // transforms) expect it. The normalizer is a no-op when the value is
    // already well-formed, so this stays cheap.
    nextSettings = normalizeChatSettings(nextSettings)
    if (sameSettingsFor(chat.settings, nextSettings, keys)) return
    changed = true
    ctx.patchChatMeta(chatId, {
      settings: nextSettings,
      updatedAt: now,
    })
  })
  return changed
}

export async function replaceChatSettings(
  chatId: ChatId,
  settings: ChatSettings,
  now = Date.now(),
): Promise<boolean> {
  const repo = getWorkspaceRepository()
  let changed = false
  await repo.runMutation([{ kind: 'chat-meta', chatId }], async (ctx) => {
    const chat = await ctx.getChat(chatId)
    if (!chat) return
    const nextSettings = normalizeChatSettings(structuredClone(settings))
    if (JSON.stringify(chat.settings) === JSON.stringify(nextSettings)) return
    changed = true
    ctx.patchChatMeta(chatId, {
      settings: nextSettings,
      updatedAt: now,
    })
  })
  return changed
}

// Normalize fields that downstream readers assume are well-formed. Today this
// is just `reasoning` (Phase 11 added required sub-fields after some chat
// rows were already on disk); future additions go here too. Returns the
// input verbatim when nothing needs rewriting so referential equality holds.
function normalizeChatSettings(settings: ChatSettings): ChatSettings {
  const reasoning = normalizeReasoningSettings(settings.reasoning)
  if (reasoning === settings.reasoning) return settings
  return { ...settings, reasoning }
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

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  return left.every((value, index) => value === right[index])
}

function uniqueTagNames(names: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of names) {
    const name = raw.trim()
    if (name.length === 0) continue
    const lower = name.toLocaleLowerCase()
    if (seen.has(lower)) continue
    seen.add(lower)
    result.push(name)
  }
  return result
}

async function pruneUnusedTags(repo: {
  listTags(): Promise<ChatTag[]>
  listChats(): Promise<Chat[]>
  deleteTag(tagId: TagId): Promise<{ deleted: boolean }>
}): Promise<void> {
  const [tags, chats] = await Promise.all([repo.listTags(), repo.listChats()])
  const used = new Set<TagId>()
  for (const chat of chats) {
    for (const tagId of chat.tags) used.add(tagId)
  }
  await Promise.all(tags.filter((tag) => !used.has(tag.id)).map((tag) => repo.deleteTag(tag.id)))
}

// Sidebar preview length cap. Kept here (not in ChatList) because the
// write path owns the canonical truncation — readers just render what the
// chat row carries, no length math in the UI.
const PREVIEW_MAX_CHARS = 240

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
    trimmed.length > PREVIEW_MAX_CHARS ? `${trimmed.slice(0, PREVIEW_MAX_CHARS - 1)}…` : trimmed
  const repo = getWorkspaceRepository()
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
