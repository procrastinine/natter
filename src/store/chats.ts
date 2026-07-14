// These helpers own chat-row CRUD and the read-side APIs that sit above the
// repository boundary. Visible chat-row writes go through `WorkspaceRepository`
// so browser mode already matches the future daemon contract.

import { activePath } from '../core/active-path'
import { cloneDefaultChatSettings } from '../core/defaults'
import { tokenCalibrationKeyForStoredRecordKey } from '../core/model-ids'
import { normalizeReasoningSettings } from '../core/reasoning'
import {
  aggregateCalibrationSamples,
  readTokenCalibrationGlobal,
  subtractSamplesFromTokenCalibrationGlobal,
  writeTokenCalibrationGlobal,
} from '../core/token-calibration'
import type {
  Chat,
  ChatId,
  ChatSettings,
  ChatSidebarRow,
  ChatTag,
  FolderId,
  Message,
  MessageId,
  PresetId,
  TagId,
  TokenCalibrationSample,
} from '../core/types'
import { newId } from '../lib/ulid'
import {
  CHAT_SIDEBAR_PROJECTION_BACKFILL_KEY,
  CHAT_SIDEBAR_PROJECTION_MANIFEST_KEY,
  type ChatSidebarProjectionRow,
  isValidChatSidebarProjectionManifest,
  isValidChatSidebarProjectionRow,
  projectChatSidebarRow,
  publicChatSidebarRow,
  rebuildChatSidebarProjection,
} from './chat-sidebar-projection'
import { getDb } from './db'
import {
  hydrateMessage,
  hydrateMessages,
  type MessageBodyRow,
  type MessageHeaderRow,
  messageHeaderTreeKey,
} from './message-storage'
import type {
  ActiveBranchBodyPage,
  ActiveBranchSnapshot,
  KnownBranchPageResult,
} from './repository'
import { ChatMissingError } from './repository'
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
  return (
    candidate?.name === 'DatabaseClosedError' || candidate?.inner?.name === 'DatabaseClosedError'
  )
}

interface ChatSidebarListOptions {
  limit?: number
  offset?: number
  orderBy?: 'updatedAt' | 'createdAt' | 'lastViewedAt'
  direction?: 'asc' | 'desc'
}

interface CreateChatInput {
  id?: ChatId
  title?: string
  settings?: ChatSettings
  presetId?: PresetId
  temporary?: boolean
  now?: number
}

// Allocate a fresh Chat row with the Phase-0 defaults. The message table is
// left empty — the caller's first `sendUserMessage` produces the root user
// message. Returns the full Chat for the caller to hold in Zustand.
export async function createChat(input: CreateChatInput = {}): Promise<Chat> {
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
    previewText: '',
  }
  if (input.presetId !== undefined) chat.presetId = input.presetId
  if (input.temporary === true) chat.temporary = true
  return getWorkspaceRepository().createChat(chat)
}

// The store/ layer is the abstraction boundary — UI code goes through
// these functions rather than touching Dexie directly. Reads still call
// `getDb()` inline here (not through the repo's async `openDb().then(...)`
// wrapper) because reactive queries rely on Dexie's synchronous table-
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

export { projectChatSidebarRow }

let chatSidebarProjectionRepair: Promise<void> | null = null

export async function listChatSidebarRows(
  options: ChatSidebarListOptions = {},
): Promise<ChatSidebarRow[]> {
  try {
    const db = getDb()
    let result = await readChatSidebarProjection(db, options)
    if (!result.valid) {
      chatSidebarProjectionRepair ??= rebuildChatSidebarProjection(db).finally(() => {
        chatSidebarProjectionRepair = null
      })
      await chatSidebarProjectionRepair
      result = await readChatSidebarProjection(db, options)
    }
    if (!result.valid) throw new Error('ChatSidebarProjectionIntegrityError')
    return result.rows.map(publicChatSidebarRow)
  } catch (error) {
    if (isDatabaseClosedError(error)) return []
    throw error
  }
}

async function readChatSidebarProjection(
  db: ReturnType<typeof getDb>,
  options: ChatSidebarListOptions,
): Promise<{ valid: boolean; rows: ChatSidebarProjectionRow[] }> {
  return db.transaction('r', db.chatSidebarRows, db.settings, async () => {
    const [marker, manifest, actualCount] = await Promise.all([
      db.settings.get(CHAT_SIDEBAR_PROJECTION_BACKFILL_KEY),
      db.settings.get(CHAT_SIDEBAR_PROJECTION_MANIFEST_KEY),
      db.chatSidebarRows.count(),
    ])
    const orderBy = options.orderBy
    let rows: ChatSidebarProjectionRow[]
    if (orderBy) {
      let collection = db.chatSidebarRows.orderBy(orderBy)
      if (options.direction !== 'asc') collection = collection.reverse()
      if (options.offset && options.offset > 0) collection = collection.offset(options.offset)
      if (options.limit !== undefined) collection = collection.limit(options.limit)
      rows = await collection.toArray()
    } else {
      rows = await db.chatSidebarRows.toArray()
      const offset = options.offset ?? 0
      if (offset > 0 || options.limit !== undefined) {
        rows = rows.slice(offset, options.limit === undefined ? undefined : offset + options.limit)
      }
    }
    return {
      valid:
        marker?.value === 1 &&
        isValidChatSidebarProjectionManifest(manifest?.value, actualCount) &&
        rows.every(isValidChatSidebarProjectionRow),
      rows,
    }
  })
}

export async function discardEmptyDraftChat(chatId: ChatId): Promise<boolean> {
  const deleted = await discardEmptyDraftChats({ chatIds: [chatId] })
  return deleted.includes(chatId)
}

export async function discardEmptyDraftChats({
  chatIds,
  exceptChatId = null,
}: {
  chatIds?: readonly ChatId[] | undefined
  exceptChatId?: ChatId | null | undefined
} = {}): Promise<ChatId[]> {
  return getWorkspaceRepository().discardEmptyDraftChats({
    ...(chatIds === undefined ? {} : { chatIds }),
    exceptChatId,
  })
}

export async function markChatPermanent(chatId: ChatId): Promise<void> {
  const repo = getWorkspaceRepository()
  try {
    await repo.runMutation([{ kind: 'chat-meta', chatId }], async (ctx) => {
      const chat = await ctx.getChat(chatId)
      if (!chat?.temporary) return
      ctx.patchChatMeta(chatId, { temporary: false })
    })
  } catch (error) {
    if (error instanceof ChatMissingError && error.chatId === chatId) return
    throw error
  }
}

// Load every message row for a chat, including tombstones. Callers filter
// `!deleted` per op (search + cache writers want tombstones; active-path
// renderers want only live nodes).
export async function loadChatMessages(chatId: ChatId): Promise<Message[]> {
  try {
    const db = getDb()
    return await db.transaction('r', db.messages, db.messageBodies, async () => {
      const headers = await db.messages.where('chatId').equals(chatId).toArray()
      const bodies = (await db.messageBodies.bulkGet(headers.map((header) => header.id))).filter(
        (row): row is NonNullable<typeof row> => row !== undefined,
      )
      return hydrateMessages(headers, bodies)
    })
  } catch (error) {
    if (isDatabaseClosedError(error)) return []
    throw error
  }
}

export async function getMessage(messageId: MessageId): Promise<Message | undefined> {
  try {
    const db = getDb()
    return await db.transaction('r', db.messages, db.messageBodies, async () => {
      const [header, body] = await Promise.all([
        db.messages.get(messageId),
        db.messageBodies.get(messageId),
      ])
      return header && body ? hydrateMessage(header, body) : undefined
    })
  } catch (error) {
    if (isDatabaseClosedError(error)) return undefined
    throw error
  }
}

export async function loadMessageHeaders(
  chatId: ChatId,
  options: { signal?: AbortSignal } = {},
): Promise<MessageHeaderRow[]> {
  return getWorkspaceRepository().listMessageHeaders(chatId, options)
}

export async function loadActiveBranchSnapshot(
  chatId: ChatId,
  cursor: Record<string, MessageId>,
): Promise<ActiveBranchSnapshot> {
  try {
    const db = getDb()
    return await db.transaction('r', db.messages, db.messageBodies, async () => {
      const headers = await db.messages.where('chatId').equals(chatId).toArray()
      const branchHeaders = activePath(headers as unknown as Message[], cursor).map(
        (message) => message as unknown as MessageHeaderRow,
      )
      const bodies = (
        await db.messageBodies.bulkGet(branchHeaders.map((header) => header.id))
      ).filter((row): row is MessageBodyRow => row !== undefined)
      return {
        chatId,
        allHeaders: headers,
        branchHeaders,
        branch: hydrateMessages(branchHeaders, bodies),
        siblingGroups: siblingGroupsForBranch(headers, branchHeaders),
        treeKey: messageHeaderTreeKey(headers),
      }
    })
  } catch (error) {
    if (isDatabaseClosedError(error)) {
      return {
        chatId,
        allHeaders: [],
        branchHeaders: [],
        branch: [],
        siblingGroups: [],
        treeKey: '',
      }
    }
    throw error
  }
}

export async function loadKnownBranchPageSnapshot(
  chatId: ChatId,
  pathMessageIds: readonly MessageId[],
  page: ActiveBranchBodyPage,
): Promise<KnownBranchPageResult> {
  return getWorkspaceRepository().getKnownBranchPageSnapshot(chatId, pathMessageIds, page)
}

function siblingGroupsForBranch(
  headers: readonly MessageHeaderRow[],
  branchHeaders: readonly MessageHeaderRow[],
): ActiveBranchSnapshot['siblingGroups'] {
  const parentIds = new Set<MessageId | null>([null])
  for (const header of branchHeaders) parentIds.add(header.parentId)
  const byParent = new Map<MessageId | null, MessageHeaderRow[]>()
  for (const header of headers) {
    if (!parentIds.has(header.parentId)) continue
    const bucket = byParent.get(header.parentId)
    if (bucket) bucket.push(header)
    else byParent.set(header.parentId, [header])
  }
  for (const bucket of byParent.values()) {
    bucket.sort((left, right) => left.siblingIndex - right.siblingIndex)
  }
  return [...parentIds].map((parentId) => ({
    parentId,
    siblings: byParent.get(parentId) ?? [],
  }))
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

export async function deleteArchivedChatPermanently(
  chatId: ChatId,
  now = Date.now(),
): Promise<boolean> {
  const repo = getWorkspaceRepository()
  const chat = await repo.getChat(chatId)
  const deleted = await repo.deleteArchivedChat(chatId)
  if (deleted) {
    await subtractSamplesFromTokenCalibrationGlobal(chat?.tokenCalibration, now)
  }
  return deleted
}

export async function emptyArchivedChats(now = Date.now()): Promise<ChatId[]> {
  const repo = getWorkspaceRepository()
  const archivedById = new Map(
    (await repo.listChats()).filter((chat) => chat.archived).map((chat) => [chat.id, chat]),
  )
  const result = await repo.emptyArchivedChats()
  const removedCalibration: Record<string, TokenCalibrationSample> = {}
  for (const chatId of result.deletedChatIds) {
    accumulateCalibrationSamples(removedCalibration, archivedById.get(chatId)?.tokenCalibration)
  }
  await subtractSamplesFromTokenCalibrationGlobal(removedCalibration, now)
  return result.deletedChatIds
}

export async function moveChatToFolder(
  chatId: ChatId,
  folderId: FolderId | null,
  now = Date.now(),
): Promise<boolean> {
  const repo = getWorkspaceRepository()
  const result = { changed: false }
  await repo.runMutation([{ kind: 'chat-meta', chatId }], async (ctx) => {
    const chat = await ctx.getChat(chatId)
    if (!chat) return
    if ((chat.folderId ?? null) === folderId) return
    result.changed = true
    ctx.patchChatMeta(chatId, { folderId, updatedAt: now })
  })
  if (result.changed && folderId) {
    await repo.updateFolder(folderId, { lastUsedAt: now, now })
  }
  return result.changed
}

export async function moveChatsToFolder(
  chatIds: readonly ChatId[],
  folderId: FolderId | null,
  now = Date.now(),
): Promise<boolean> {
  const uniqueChatIds = [...new Set(chatIds)]
  if (uniqueChatIds.length === 0) return false
  const repo = getWorkspaceRepository()
  const result = { changed: false }
  await repo.runMutation(
    uniqueChatIds.map((chatId) => ({ kind: 'chat-meta' as const, chatId })),
    async (ctx) => {
      for (const chatId of uniqueChatIds) {
        const chat = await ctx.getChat(chatId)
        if (!chat || (chat.folderId ?? null) === folderId) continue
        result.changed = true
        ctx.patchChatMeta(chatId, { folderId, updatedAt: now })
      }
    },
  )
  if (result.changed && folderId) {
    await repo.updateFolder(folderId, { lastUsedAt: now, now })
  }
  return result.changed
}

async function setChatTags(
  chatId: ChatId,
  tagIds: readonly TagId[],
  now = Date.now(),
): Promise<boolean> {
  const uniqueTagIds = [...new Set(tagIds)]
  const repo = getWorkspaceRepository()
  const result = { changed: false }
  await repo.runMutation([{ kind: 'chat-meta', chatId }], async (ctx) => {
    const chat = await ctx.getChat(chatId)
    if (!chat) return
    if (sameStringList(chat.tags, uniqueTagIds)) return
    result.changed = true
    ctx.patchChatMeta(chatId, { tags: uniqueTagIds }, { touchSummary: false })
  })
  if (result.changed) {
    await Promise.all(uniqueTagIds.map((tagId) => repo.updateTag(tagId, { lastUsedAt: now, now })))
  }
  return result.changed
}

export async function setChatTagsFromNames(
  chatId: ChatId,
  names: readonly string[],
  now = Date.now(),
): Promise<TagId[]> {
  const repo = getWorkspaceRepository()
  const tagIds = await resolveChatTagIds(repo, names, now)
  await setChatTags(chatId, tagIds, now)
  await pruneUnusedTags(repo)
  return tagIds
}

export async function setChatsTagsFromNames(
  chatIds: readonly ChatId[],
  names: readonly string[],
  now = Date.now(),
): Promise<TagId[]> {
  const uniqueChatIds = [...new Set(chatIds)]
  const repo = getWorkspaceRepository()
  const tagIds = await resolveChatTagIds(repo, names, now)
  const uniqueTagIds = [...new Set(tagIds)]
  if (uniqueChatIds.length > 0) {
    const result = { changed: false }
    await repo.runMutation(
      uniqueChatIds.map((chatId) => ({ kind: 'chat-meta' as const, chatId })),
      async (ctx) => {
        for (const chatId of uniqueChatIds) {
          const chat = await ctx.getChat(chatId)
          if (!chat || sameStringList(chat.tags, uniqueTagIds)) continue
          result.changed = true
          ctx.patchChatMeta(chatId, { tags: uniqueTagIds }, { touchSummary: false })
        }
      },
    )
    if (result.changed) {
      await Promise.all(
        uniqueTagIds.map((tagId) => repo.updateTag(tagId, { lastUsedAt: now, now })),
      )
    }
  }
  await pruneUnusedTags(repo)
  return uniqueTagIds
}

async function resolveChatTagIds(
  repo: Pick<ReturnType<typeof getWorkspaceRepository>, 'listTags' | 'createTag'>,
  names: readonly string[],
  now: number,
): Promise<TagId[]> {
  const normalizedNames = uniqueTagNames(names)
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
  return tagIds
}

export async function clearChatTokenCalibration(
  chatId: ChatId,
  calibrationKey?: string,
  now = Date.now(),
): Promise<boolean> {
  const repo = getWorkspaceRepository()
  const result = { changed: false }
  const removedSamples: Record<string, TokenCalibrationSample> = {}
  await repo.runMutation([{ kind: 'chat-meta', chatId }], async (ctx) => {
    const chat = await ctx.getChat(chatId)
    if (!chat) return
    const current = chat.tokenCalibration ?? {}
    const entries = Object.entries(current)
    if (!calibrationKey) {
      if (entries.length === 0) return
      result.changed = true
      Object.assign(removedSamples, current)
      ctx.patchChatMeta(
        chatId,
        { tokenCalibration: {} },
        { touchVisibleState: false, broadcast: true },
      )
      return
    }

    const next: Record<string, TokenCalibrationSample> = {}
    for (const [storedKey, sample] of entries) {
      if (tokenCalibrationKeyForStoredRecordKey(storedKey) === calibrationKey) {
        result.changed = true
        removedSamples[storedKey] = sample
        continue
      }
      next[storedKey] = sample
    }
    if (!result.changed) return
    ctx.patchChatMeta(
      chatId,
      { tokenCalibration: aggregateCalibrationSamples(next) },
      { touchVisibleState: false, broadcast: true },
    )
  })
  if (result.changed) {
    await subtractSamplesFromTokenCalibrationGlobal(removedSamples, now)
  }
  return result.changed
}

export async function clearTokenCalibrationFamilyEverywhere(
  calibrationKey: string,
  now = Date.now(),
): Promise<{ globalChanged: boolean; chatCount: number }> {
  const repo = getWorkspaceRepository()
  const [global, chats] = await Promise.all([readTokenCalibrationGlobal(), repo.listChats()])
  const globalNext = calibrationRecordWithoutFamily(global.byModel, calibrationKey)
  if (globalNext.changed) {
    await writeTokenCalibrationGlobal({
      version: 1,
      updatedAt: now,
      byModel: globalNext.samples,
    })
  }
  const affected = chats
    .map((chat) => ({
      chat,
      next: calibrationRecordWithoutFamily(chat.tokenCalibration, calibrationKey),
    }))
    .filter((row) => row.next.changed)
  if (affected.length > 0) {
    await repo.runMutation(
      affected.map(({ chat }) => ({ kind: 'chat-meta' as const, chatId: chat.id })),
      (ctx) => {
        for (const { chat, next } of affected) {
          ctx.patchChatMeta(
            chat.id,
            { tokenCalibration: aggregateCalibrationSamples(next.samples) },
            { touchVisibleState: false, broadcast: true },
          )
        }
      },
    )
  }
  return { globalChanged: globalNext.changed, chatCount: affected.length }
}

export async function clearAllTokenCalibrationEverywhere(
  now = Date.now(),
): Promise<{ globalChanged: boolean; chatCount: number }> {
  const repo = getWorkspaceRepository()
  const [global, chats] = await Promise.all([readTokenCalibrationGlobal(), repo.listChats()])
  const globalChanged = Object.keys(global.byModel).length > 0
  if (globalChanged) {
    await writeTokenCalibrationGlobal({ version: 1, updatedAt: now, byModel: {} })
  }
  const affected = chats.filter((chat) => Object.keys(chat.tokenCalibration ?? {}).length > 0)
  if (affected.length > 0) {
    await repo.runMutation(
      affected.map((chat) => ({ kind: 'chat-meta' as const, chatId: chat.id })),
      (ctx) => {
        for (const chat of affected) {
          ctx.patchChatMeta(
            chat.id,
            { tokenCalibration: {} },
            { touchVisibleState: false, broadcast: true },
          )
        }
      },
    )
  }
  return { globalChanged, chatCount: affected.length }
}

function calibrationRecordWithoutFamily(
  samples: Record<string, TokenCalibrationSample> | undefined,
  calibrationKey: string,
): { changed: boolean; samples: Record<string, TokenCalibrationSample> } {
  const next: Record<string, TokenCalibrationSample> = {}
  let changed = false
  for (const [storedKey, sample] of Object.entries(samples ?? {})) {
    if (tokenCalibrationKeyForStoredRecordKey(storedKey) === calibrationKey) {
      changed = true
      continue
    }
    next[storedKey] = sample
  }
  return { changed, samples: next }
}

function accumulateCalibrationSamples(
  target: Record<string, TokenCalibrationSample>,
  samples: Record<string, TokenCalibrationSample> | undefined,
): void {
  for (const [key, sample] of Object.entries(aggregateCalibrationSamples(samples))) {
    const current = target[key]
    if (!current) {
      target[key] = { ...sample }
      continue
    }
    current.totalTextChars += sample.totalTextChars
    current.totalTextTokens += sample.totalTextTokens
    current.sampleCount += sample.sampleCount
    if (sample.updatedAt >= current.updatedAt) {
      current.updatedAt = sample.updatedAt
      if (sample.lastRatio !== undefined) current.lastRatio = sample.lastRatio
      else delete current.lastRatio
    }
  }
}

// A chat-open event bumps `lastViewedAt` only. It is explicitly non-visible: it
// does not advance summary/meta versions or emit a chat-mutated event.
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
// non-empty; the helper defensively short-circuits if it is anyway.
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
// consistent with other settings edits.
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
// metadata intact (usage, model, reasoning details). Used for the explicit
// dismiss button on the abort banner.
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

export async function applyChatPreset(
  chatId: ChatId,
  presetId: PresetId,
  settings: ChatSettings,
  now = Date.now(),
): Promise<boolean> {
  const repo = getWorkspaceRepository()
  let changed = false
  await repo.runMutation([{ kind: 'chat-meta', chatId }], async (ctx) => {
    const chat = await ctx.getChat(chatId)
    if (!chat) return
    const nextSettings = normalizeChatSettings(structuredClone(settings))
    if ((chat.presetId ?? null) === presetId && sameChatSettings(chat.settings, nextSettings)) {
      return
    }
    changed = true
    ctx.patchChatMeta(chatId, {
      settings: nextSettings,
      presetId,
      updatedAt: now,
    })
  })
  return changed
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
    let nextSettings = { ...chat.settings }
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
    if (sameChatSettings(chat.settings, nextSettings)) return
    changed = true
    ctx.patchChatMeta(chatId, {
      settings: nextSettings,
      updatedAt: now,
    })
  })
  return changed
}

// Complete persisted-schema changes belong in Dexie migrations. This write
// boundary only repairs full-object UI patches that omit required nested
// reasoning sub-fields before they reach downstream readers.
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

function sameChatSettings(prev: ChatSettings, next: ChatSettings): boolean {
  return stableSettingsString(prev) === stableSettingsString(next)
}

function stableSettingsString(value: unknown): string {
  return JSON.stringify(sortObjectKeys(value))
}

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObjectKeys)
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    const child = (value as Record<string, unknown>)[key]
    if (child !== undefined) out[key] = sortObjectKeys(child)
  }
  return out
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
