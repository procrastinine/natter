import type { Table, Transaction } from 'dexie'
import { findLastUpdatedLeafId, indexById, isOnPathToLeaf } from '../core/active-path'
import { buildBranchCacheRow, buildBranchMessages } from '../core/branch-flatten'
import type {
  Attachment,
  AttachmentArtifact,
  AttachmentBlob,
  AttachmentId,
  AttachmentJob,
  Chat,
  ChatBranchCache,
  ChatFolder,
  ChatId,
  ChatTag,
  ChatVersions,
  ChildListState,
  DraftRow,
  FolderId,
  Message,
  MessageId,
  MutationScope,
  TagId,
} from '../core/types'
import { countMessagesWords } from '../core/word-count'
import { newId } from '../lib/ulid'
import { liveAttachmentRefs, normalizeAttachmentRefs } from './attachment-refs'
import { postEvent } from './broadcast'
import { childListKey, type NatterDb, openDb, type SettingsRow } from './db'
import { withMutationLocks } from './locks'
import type {
  AttachmentBundle,
  AttachmentSearchPage,
  AttachmentSearchQuery,
  ChatMutationSummary,
  CreateFolderInput,
  CreateTagInput,
  DeleteArchivedChatsResult,
  DeleteFolderResult,
  DeleteTagResult,
  MutationContext,
  PutMessageOptions,
  UpdateFolderInput,
  UpdateTagInput,
  WorkspaceMeta,
  WorkspaceMutationResult,
  WorkspaceRepository,
} from './repository'

const WORKSPACE_META_KEY = 'workspace-meta'
const WORKSPACE_ID = 'browser-idb:natter'

export class ChatMissingError extends Error {
  readonly chatId: ChatId

  constructor(chatId: ChatId) {
    super(`ChatMissing:${chatId}`)
    this.name = 'ChatMissingError'
    this.chatId = chatId
  }
}

interface StoredWorkspaceMeta extends WorkspaceMeta {
  backendKind: 'browser-idb'
}

interface ChatMutationState {
  beforeChat: Chat
  beforeMessages?: Message[]
  afterMessages?: Message[]
  visibleMetaPatch: Partial<Chat>
  hiddenMetaPatch: Partial<Chat>
  summaryPatch: Partial<Chat>
  visibleMetaDirty: boolean
  summaryVersionDirty: boolean
  messageSummaryDirty: boolean
  broadcast: boolean
  changedMessageIds: Set<MessageId>
  affected: Map<string, ChatMutationSummary>
}

type BrowserMutationTableName =
  | 'attachmentArtifacts'
  | 'attachmentBlobs'
  | 'attachmentJobs'
  | 'attachments'
  | 'chatBranchCache'
  | 'chats'
  | 'childLists'
  | 'drafts'
  | 'messages'
  | 'settings'

const MUTATION_TABLE_ORDER: readonly BrowserMutationTableName[] = [
  'attachmentArtifacts',
  'attachmentBlobs',
  'attachmentJobs',
  'attachments',
  'chatBranchCache',
  'chats',
  'childLists',
  'drafts',
  'messages',
  'settings',
]

function stableStringify(value: unknown): string {
  return JSON.stringify(value)
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right)
}

function changedPatch<Row extends object>(
  current: Partial<Row>,
  patch: Partial<Row>,
): Partial<Row> | null {
  const next: Partial<Row> = {}
  let changed = false
  for (const key of Object.keys(patch) as Array<keyof Row>) {
    const value = patch[key]
    if (valuesEqual(current[key], value)) continue
    next[key] = value
    changed = true
  }
  return changed ? next : null
}

function cloneMessage(message: Message): Message {
  const cloned = structuredClone(message)
  cloned.attachmentRefs = normalizeAttachmentRefs(cloned.attachmentRefs, {
    messageId: cloned.id,
    createdAt: cloned.createdAt,
  })
  return cloned
}

function cloneDraft(draft: DraftRow): DraftRow {
  const cloned = structuredClone(draft)
  cloned.attachmentRefs = normalizeAttachmentRefs(cloned.attachmentRefs, {
    draftChatId: cloned.chatId,
    createdAt: cloned.updatedAt,
  })
  return cloned
}

function replaceMessage(messages: Message[], nextMessage: Message): void {
  const next = cloneMessage(nextMessage)
  const index = messages.findIndex((message) => message.id === next.id)
  if (index === -1) {
    messages.push(next)
    return
  }
  messages[index] = next
}

function removeMessage(messages: Message[], messageId: MessageId): void {
  const index = messages.findIndex((message) => message.id === messageId)
  if (index === -1) return
  messages.splice(index, 1)
}

function computeTotalCostUsd(messages: readonly Message[]): number {
  let total = 0
  for (const message of messages) {
    if (message.deleted) continue
    total += message.generation?.cost ?? 0
  }
  return total
}

function stripMetaPatch(patch: Partial<Chat>): Partial<Chat> {
  const next = { ...patch }
  delete next.updatedAt
  delete next.wordCount
  delete next.totalCostUsd
  delete next.lastUpdatedLeafId
  delete next.lastBranchUpdatedAt
  delete next.summaryVersion
  delete next.metaVersion
  return next
}

function stripSummaryPatch(patch: Partial<Chat>): Partial<Chat> {
  const next = { ...patch }
  delete next.updatedAt
  delete next.metaVersion
  delete next.summaryVersion
  delete next.settings
  delete next.title
  delete next.titleStatus
  delete next.archived
  delete next.pinned
  delete next.folderId
  delete next.tags
  delete next.presetId
  return next
}

function attachmentSearchText(
  attachment: Attachment,
  artifacts: readonly AttachmentArtifact[],
): string {
  return [
    attachment.id,
    attachment.contentHash,
    attachment.kind,
    attachment.mime,
    attachment.filename,
    attachment.extension,
    attachment.origin,
    attachment.sourceUrl,
    attachment.storage.kind,
    ...attachment.processing.map((state) => state.processorId),
    ...artifacts.flatMap((artifact) => [
      artifact.artifactId,
      artifact.kind,
      artifact.processorId,
      artifact.kind === 'text' ? artifact.text : undefined,
      artifact.kind === 'json' ? JSON.stringify(artifact.value) : undefined,
    ]),
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join('\n')
    .toLowerCase()
}

function attachmentSorter(
  sort: AttachmentSearchQuery['sort'],
): (left: Attachment, right: Attachment) => number {
  if (sort === 'created-asc') return (left, right) => left.createdAt - right.createdAt
  if (sort === 'updated-desc') return (left, right) => right.updatedAt - left.updatedAt
  if (sort === 'size-desc') return (left, right) => (right.sizeBytes ?? 0) - (left.sizeBytes ?? 0)
  if (sort === 'size-asc') return (left, right) => (left.sizeBytes ?? 0) - (right.sizeBytes ?? 0)
  return (left, right) => right.createdAt - left.createdAt
}

export function resolveMutationTableNames(
  scopes: readonly MutationScope[],
): BrowserMutationTableName[] {
  const names = new Set<BrowserMutationTableName>(['settings'])
  for (const scope of scopes) {
    switch (scope.kind) {
      case 'attachment':
        names.add('attachmentArtifacts')
        names.add('attachmentBlobs')
        names.add('attachmentJobs')
        names.add('attachments')
        break
      case 'chat-meta':
        names.add('chats')
        break
      case 'children':
        names.add('chatBranchCache')
        names.add('chats')
        names.add('childLists')
        names.add('messages')
        break
      case 'draft':
        names.add('chats')
        names.add('drafts')
        break
      case 'message':
        names.add('chatBranchCache')
        names.add('chats')
        names.add('messages')
        break
    }
  }
  return MUTATION_TABLE_ORDER.filter((name) => names.has(name))
}

function resolveMutationTables(
  db: NatterDb,
  scopes: readonly MutationScope[],
): Table<unknown, unknown>[] {
  return resolveMutationTableNames(scopes).map((name) => {
    switch (name) {
      case 'attachments':
        return db.attachments as Table<unknown, unknown>
      case 'attachmentArtifacts':
        return db.attachmentArtifacts as Table<unknown, unknown>
      case 'attachmentBlobs':
        return db.attachmentBlobs as Table<unknown, unknown>
      case 'attachmentJobs':
        return db.attachmentJobs as Table<unknown, unknown>
      case 'chats':
        return db.chats as Table<unknown, unknown>
      case 'chatBranchCache':
        return db.chatBranchCache as Table<unknown, unknown>
      case 'childLists':
        return db.childLists as Table<unknown, unknown>
      case 'drafts':
        return db.drafts as Table<unknown, unknown>
      case 'messages':
        return db.messages as Table<unknown, unknown>
      case 'settings':
        return db.settings as Table<unknown, unknown>
    }
    const exhaustive: never = name
    throw new Error(`UnknownMutationTable:${exhaustive}`)
  })
}

function affectedKey(summary: ChatMutationSummary): string {
  switch (summary.kind) {
    case 'chat-meta':
      return `chat-meta:${summary.chatId ?? ''}`
    case 'message':
      return `message:${summary.chatId ?? ''}:${summary.messageId ?? ''}`
    case 'children':
      return `children:${summary.chatId ?? ''}:${summary.parentId ?? '__root__'}`
    case 'draft':
      return `draft:${summary.chatId ?? ''}`
    case 'attachment':
      return `attachment:${summary.attachmentId ?? ''}`
  }
}

function scopeResourceName(scope: MutationScope): string {
  switch (scope.kind) {
    case 'chat-meta':
      return `chat-meta:${scope.chatId}`
    case 'message':
      return `message:${scope.messageId}`
    case 'children':
      return `children:${scope.chatId}:${scope.parentId ?? '__root__'}`
    case 'draft':
      return `draft:${scope.chatId}`
    case 'attachment':
      return `attachment:${scope.attachmentId}`
  }
}

function createScopeChecker(scopes: readonly MutationScope[]) {
  const allowed = new Set(scopes.map(scopeResourceName))
  const assertScope = (scope: MutationScope): void => {
    const key = scopeResourceName(scope)
    if (!allowed.has(key)) {
      throw new Error(`UndeclaredScope:${key}`)
    }
  }
  return { assertScope }
}

function upsertAffected(state: ChatMutationState, summary: ChatMutationSummary): void {
  state.affected.set(affectedKey(summary), summary)
}

async function loadChatOrThrow(table: Table<Chat, string>, chatId: ChatId): Promise<Chat> {
  const chat = await table.get(chatId)
  if (!chat) throw new ChatMissingError(chatId)
  return structuredClone(chat)
}

function shouldBumpLastBranchUpdatedAt(
  beforeChat: Chat,
  beforeMessages: readonly Message[],
  afterMessages: readonly Message[],
  changedMessageIds: ReadonlySet<MessageId>,
): boolean {
  const nextLeafId = findLastUpdatedLeafId(afterMessages)
  if (nextLeafId !== beforeChat.lastUpdatedLeafId) return true
  if (nextLeafId === null) return false
  if (changedMessageIds.size === 0) return false
  const beforeById = indexById(beforeMessages)
  const afterById = indexById(afterMessages)
  for (const messageId of changedMessageIds) {
    if (
      isOnPathToLeaf(messageId, nextLeafId, beforeById) ||
      isOnPathToLeaf(messageId, nextLeafId, afterById)
    ) {
      return true
    }
  }
  return false
}

async function writeBranchCacheForSummary(
  tx: Transaction,
  chatId: ChatId,
  branchLeafId: MessageId | null,
  messages: readonly Message[],
  now: number,
): Promise<void> {
  const table = tx.table<ChatBranchCache, ChatId>('chatBranchCache')
  if (branchLeafId === null) {
    await table.delete(chatId)
    return
  }
  await table.put(
    buildBranchCacheRow({
      chatId,
      branchLeafId,
      messages,
      generatedAt: now,
    }),
  )
}

async function getWorkspaceMetaRow(): Promise<StoredWorkspaceMeta> {
  const db = await openDb()
  const stored = (await db.settings.get(WORKSPACE_META_KEY))?.value as
    | StoredWorkspaceMeta
    | undefined
  return (
    stored ?? {
      workspaceId: WORKSPACE_ID,
      backendKind: 'browser-idb',
      lastMutationAt: 0,
      mutationCounter: 0,
    }
  )
}

async function bumpWorkspaceMeta(tx: Transaction, now: number): Promise<void> {
  const settings = tx.table<SettingsRow, string>('settings')
  const stored = (await settings.get(WORKSPACE_META_KEY))?.value as StoredWorkspaceMeta | undefined
  const mutationMeta = stored ?? {
    workspaceId: WORKSPACE_ID,
    backendKind: 'browser-idb' as const,
    lastMutationAt: 0,
    mutationCounter: 0,
  }
  const nextWorkspaceMeta: StoredWorkspaceMeta = {
    ...mutationMeta,
    lastMutationAt: now,
    mutationCounter: mutationMeta.mutationCounter + 1,
  }
  await settings.put({
    key: WORKSPACE_META_KEY,
    value: nextWorkspaceMeta,
  })
}

function normalizeName(value: string, kind: 'Folder' | 'Tag'): string {
  const name = value.trim()
  if (name.length === 0) throw new Error(`${kind}NameRequired`)
  return name
}

function tagNameLower(name: string): string {
  return name.toLocaleLowerCase()
}

function sortFolders(rows: ChatFolder[]): ChatFolder[] {
  return rows.sort((left, right) => {
    if (left.sortIndex !== right.sortIndex) return left.sortIndex - right.sortIndex
    const byName = left.name.localeCompare(right.name)
    return byName !== 0 ? byName : left.id.localeCompare(right.id)
  })
}

function sortTags(rows: ChatTag[]): ChatTag[] {
  return rows.sort((left, right) => {
    const byName = left.nameLower.localeCompare(right.nameLower)
    return byName !== 0 ? byName : left.id.localeCompare(right.id)
  })
}

function patchOptionalString<T extends object>(
  row: T,
  key: keyof T,
  value: string | null | undefined,
): void {
  if (value === null || value === undefined || value.trim().length === 0) {
    delete row[key]
    return
  }
  row[key] = value as T[keyof T]
}

function patchOptionalNumber<T extends object>(
  row: T,
  key: keyof T,
  value: number | null | undefined,
): void {
  if (value === null || value === undefined) {
    delete row[key]
    return
  }
  row[key] = value as T[keyof T]
}

interface ArchivedChatDeleteSnapshot {
  chatId: ChatId
  messageIds: MessageId[]
  attachmentIds: AttachmentId[]
}

async function archivedDeleteSnapshots(
  db: NatterDb,
  chatIds: readonly ChatId[],
): Promise<ArchivedChatDeleteSnapshot[]> {
  const snapshots: ArchivedChatDeleteSnapshot[] = []
  await db.transaction('r', [db.chats, db.messages, db.drafts], async (tx: Transaction) => {
    const chats = tx.table<Chat, ChatId>('chats')
    const messages = tx.table<Message, MessageId>('messages')
    const drafts = tx.table<DraftRow, ChatId>('drafts')
    for (const chatId of chatIds) {
      const chat = await chats.get(chatId)
      if (!chat?.archived) continue
      const rows = await messages.where('chatId').equals(chatId).toArray()
      const draft = await drafts.get(chatId)
      snapshots.push({
        chatId,
        messageIds: rows.map((message) => message.id),
        attachmentIds: attachmentIdsFromDeletedChat(rows, draft),
      })
    }
  })
  return snapshots
}

function attachmentIdsFromDeletedChat(
  messages: readonly Message[],
  draft: DraftRow | undefined,
): AttachmentId[] {
  const ids: AttachmentId[] = []
  for (const message of messages) {
    for (const ref of liveAttachmentRefs(message.attachmentRefs)) ids.push(ref.attachmentId)
  }
  for (const ref of liveAttachmentRefs(draft?.attachmentRefs)) ids.push(ref.attachmentId)
  return ids
}

function countAttachmentIds(ids: readonly AttachmentId[]): Map<AttachmentId, number> {
  const counts = new Map<AttachmentId, number>()
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1)
  return counts
}

class BrowserWorkspaceRepository implements WorkspaceRepository {
  async getWorkspaceMeta(): Promise<WorkspaceMeta> {
    return getWorkspaceMetaRow()
  }

  async listChats(): Promise<Chat[]> {
    return openDb().then((db) => db.chats.toArray())
  }

  async getChat(chatId: ChatId): Promise<Chat | undefined> {
    return openDb().then((db) => db.chats.get(chatId))
  }

  async deleteArchivedChat(chatId: ChatId): Promise<boolean> {
    const result = await this.deleteArchivedChats([chatId])
    return result.deletedChatIds.includes(chatId)
  }

  async emptyArchivedChats(): Promise<DeleteArchivedChatsResult> {
    const db = await openDb()
    const archivedIds = (await db.chats.filter((chat) => chat.archived).toArray()).map(
      (chat) => chat.id,
    )
    return this.deleteArchivedChats(archivedIds)
  }

  private async deleteArchivedChats(
    chatIds: readonly ChatId[],
  ): Promise<DeleteArchivedChatsResult> {
    if (chatIds.length === 0) return { deletedChatIds: [] }
    const db = await openDb()
    const snapshots = await archivedDeleteSnapshots(db, chatIds)
    if (snapshots.length === 0) return { deletedChatIds: [] }
    const scopes: MutationScope[] = []
    const attachmentScopeIds = new Set<AttachmentId>()
    for (const snapshot of snapshots) {
      scopes.push({ kind: 'chat-meta', chatId: snapshot.chatId })
      scopes.push({ kind: 'draft', chatId: snapshot.chatId })
      for (const messageId of snapshot.messageIds) scopes.push({ kind: 'message', messageId })
      for (const attachmentId of snapshot.attachmentIds) {
        if (attachmentScopeIds.has(attachmentId)) continue
        attachmentScopeIds.add(attachmentId)
        scopes.push({ kind: 'attachment', attachmentId })
      }
    }

    const deletedChatIds: ChatId[] = []
    const now = Date.now()
    await withMutationLocks(scopes, async () =>
      db.transaction(
        'rw',
        [
          db.attachmentArtifacts,
          db.attachmentBlobs,
          db.attachmentJobs,
          db.attachments,
          db.chatBranchCache,
          db.chats,
          db.childLists,
          db.drafts,
          db.messages,
          db.settings,
        ],
        async (tx: Transaction) => {
          const chats = tx.table<Chat, ChatId>('chats')
          const messages = tx.table<Message, MessageId>('messages')
          const drafts = tx.table<DraftRow, ChatId>('drafts')
          const attachments = tx.table<Attachment, AttachmentId>('attachments')
          for (const { chatId } of snapshots) {
            const chat = await chats.get(chatId)
            if (!chat?.archived) continue
            const messageRows = await messages.where('chatId').equals(chatId).toArray()
            const draft = await drafts.get(chatId)
            const refCounts = countAttachmentIds(attachmentIdsFromDeletedChat(messageRows, draft))
            for (const [attachmentId, count] of refCounts) {
              const row = await attachments.get(attachmentId)
              if (!row) continue
              await attachments.put({ ...row, refCount: Math.max(0, row.refCount - count) })
            }
            await messages.where('chatId').equals(chatId).delete()
            await drafts.delete(chatId)
            await tx.table<ChatBranchCache, ChatId>('chatBranchCache').delete(chatId)
            await tx
              .table<ChildListState, string>('childLists')
              .filter((row) => row.chatId === chatId)
              .delete()
            await chats.delete(chatId)
            deletedChatIds.push(chatId)
          }
          if (deletedChatIds.length > 0) await bumpWorkspaceMeta(tx, now)
        },
      ),
    )

    for (const chatId of deletedChatIds) {
      postEvent({ kind: 'chat-deleted', chatId })
      postEvent({ kind: 'branch-cache-refreshed', chatId })
    }
    return { deletedChatIds }
  }

  async listFolders(): Promise<ChatFolder[]> {
    const db = await openDb()
    return sortFolders(await db.folders.toArray())
  }

  async getFolder(folderId: FolderId): Promise<ChatFolder | undefined> {
    const db = await openDb()
    return db.folders.get(folderId)
  }

  async createFolder(input: CreateFolderInput): Promise<ChatFolder> {
    const db = await openDb()
    const now = input.now ?? Date.now()
    const folder: ChatFolder = {
      id: input.id ?? newId(),
      name: normalizeName(input.name, 'Folder'),
      sortIndex: input.sortIndex ?? now,
      createdAt: now,
      updatedAt: now,
    }
    if (input.color) folder.color = input.color

    await db.transaction('rw', [db.folders, db.settings], async (tx: Transaction) => {
      await tx.table<ChatFolder, FolderId>('folders').put(folder)
      await bumpWorkspaceMeta(tx, now)
    })
    postEvent({ kind: 'folder-mutated', folderId: folder.id })
    return folder
  }

  async updateFolder(
    folderId: FolderId,
    patch: UpdateFolderInput,
  ): Promise<ChatFolder | undefined> {
    const db = await openDb()
    const now = patch.now ?? Date.now()
    let next: ChatFolder | undefined
    let changed = false
    await db.transaction('rw', [db.folders, db.settings], async (tx: Transaction) => {
      const table = tx.table<ChatFolder, FolderId>('folders')
      const current = await table.get(folderId)
      if (!current) return
      next = { ...current }
      if (patch.name !== undefined) next.name = normalizeName(patch.name, 'Folder')
      if (patch.color !== undefined) patchOptionalString(next, 'color', patch.color)
      if (patch.sortIndex !== undefined) next.sortIndex = patch.sortIndex
      if (patch.lastUsedAt !== undefined) {
        patchOptionalNumber(next, 'lastUsedAt', patch.lastUsedAt)
      }
      if (stableStringify(current) === stableStringify(next)) return
      next.updatedAt = now
      changed = true
      await table.put(next)
      await bumpWorkspaceMeta(tx, now)
    })
    if (changed) postEvent({ kind: 'folder-mutated', folderId })
    return next
  }

  async deleteFolder(folderId: FolderId): Promise<DeleteFolderResult> {
    const db = await openDb()
    const now = Date.now()
    const changedChats: Chat[] = []
    let deleted = false
    await db.transaction('rw', [db.folders, db.chats, db.settings], async (tx: Transaction) => {
      const folders = tx.table<ChatFolder, FolderId>('folders')
      if (!(await folders.get(folderId))) return
      await folders.delete(folderId)
      deleted = true

      const chats = tx.table<Chat, ChatId>('chats')
      const rows = await chats.where('folderId').equals(folderId).toArray()
      for (const row of rows) {
        const next: Chat = {
          ...row,
          folderId: null,
          updatedAt: now,
          metaVersion: row.metaVersion + 1,
          summaryVersion: row.summaryVersion + 1,
        }
        await chats.put(next)
        changedChats.push(next)
      }
      await bumpWorkspaceMeta(tx, now)
    })
    if (deleted) {
      postEvent({ kind: 'folder-deleted', folderId })
      for (const chat of changedChats) {
        postEvent({
          kind: 'chat-mutated',
          chatId: chat.id,
          metaVersion: chat.metaVersion,
          summaryVersion: chat.summaryVersion,
          affected: [{ kind: 'chat-meta', chatId: chat.id }],
        })
      }
    }
    return { deleted, affectedChatIds: changedChats.map((chat) => chat.id) }
  }

  async listTags(): Promise<ChatTag[]> {
    const db = await openDb()
    return sortTags(await db.tags.toArray())
  }

  async getTag(tagId: TagId): Promise<ChatTag | undefined> {
    const db = await openDb()
    return db.tags.get(tagId)
  }

  async createTag(input: CreateTagInput): Promise<ChatTag> {
    const db = await openDb()
    const now = input.now ?? Date.now()
    const name = normalizeName(input.name, 'Tag')
    const tag: ChatTag = {
      id: input.id ?? newId(),
      name,
      nameLower: tagNameLower(name),
      createdAt: now,
      updatedAt: now,
    }
    if (input.color) tag.color = input.color

    await db.transaction('rw', [db.tags, db.settings], async (tx: Transaction) => {
      await tx.table<ChatTag, TagId>('tags').put(tag)
      await bumpWorkspaceMeta(tx, now)
    })
    postEvent({ kind: 'tag-mutated', tagId: tag.id })
    return tag
  }

  async updateTag(tagId: TagId, patch: UpdateTagInput): Promise<ChatTag | undefined> {
    const db = await openDb()
    const now = patch.now ?? Date.now()
    let next: ChatTag | undefined
    let changed = false
    await db.transaction('rw', [db.tags, db.settings], async (tx: Transaction) => {
      const table = tx.table<ChatTag, TagId>('tags')
      const current = await table.get(tagId)
      if (!current) return
      next = { ...current }
      if (patch.name !== undefined) {
        next.name = normalizeName(patch.name, 'Tag')
        next.nameLower = tagNameLower(next.name)
      }
      if (patch.color !== undefined) patchOptionalString(next, 'color', patch.color)
      if (patch.lastUsedAt !== undefined) {
        patchOptionalNumber(next, 'lastUsedAt', patch.lastUsedAt)
      }
      if (stableStringify(current) === stableStringify(next)) return
      next.updatedAt = now
      changed = true
      await table.put(next)
      await bumpWorkspaceMeta(tx, now)
    })
    if (changed) postEvent({ kind: 'tag-mutated', tagId })
    return next
  }

  async deleteTag(tagId: TagId): Promise<DeleteTagResult> {
    const db = await openDb()
    const now = Date.now()
    const changedChats: Chat[] = []
    let deleted = false
    await db.transaction('rw', [db.tags, db.chats, db.settings], async (tx: Transaction) => {
      const tags = tx.table<ChatTag, TagId>('tags')
      if (!(await tags.get(tagId))) return
      await tags.delete(tagId)
      deleted = true

      const chats = tx.table<Chat, ChatId>('chats')
      const rows = await chats.where('tags').equals(tagId).toArray()
      for (const row of rows) {
        const nextTags = row.tags.filter((id) => id !== tagId)
        if (nextTags.length === row.tags.length) continue
        const next: Chat = {
          ...row,
          tags: nextTags,
          updatedAt: now,
          metaVersion: row.metaVersion + 1,
          summaryVersion: row.summaryVersion + 1,
        }
        await chats.put(next)
        changedChats.push(next)
      }
      await bumpWorkspaceMeta(tx, now)
    })
    if (deleted) {
      postEvent({ kind: 'tag-deleted', tagId })
      for (const chat of changedChats) {
        postEvent({
          kind: 'chat-mutated',
          chatId: chat.id,
          metaVersion: chat.metaVersion,
          summaryVersion: chat.summaryVersion,
          affected: [{ kind: 'chat-meta', chatId: chat.id }],
        })
      }
    }
    return { deleted, affectedChatIds: changedChats.map((chat) => chat.id) }
  }

  async getChatBranchCache(chatId: ChatId): Promise<ChatBranchCache | undefined> {
    const db = await openDb()
    return db.chatBranchCache.get(chatId)
  }

  async putChatBranchCache(cache: ChatBranchCache): Promise<ChatBranchCache> {
    const db = await openDb()
    const now = Date.now()
    await db.transaction('rw', [db.chatBranchCache, db.settings], async (tx: Transaction) => {
      await tx.table<ChatBranchCache, ChatId>('chatBranchCache').put(cache)
      await bumpWorkspaceMeta(tx, now)
    })
    postEvent({ kind: 'branch-cache-refreshed', chatId: cache.chatId })
    return cache
  }

  async deleteChatBranchCache(chatId: ChatId): Promise<boolean> {
    const db = await openDb()
    const now = Date.now()
    let deleted = false
    await db.transaction('rw', [db.chatBranchCache, db.settings], async (tx: Transaction) => {
      const table = tx.table<ChatBranchCache, ChatId>('chatBranchCache')
      if (!(await table.get(chatId))) return
      await table.delete(chatId)
      deleted = true
      await bumpWorkspaceMeta(tx, now)
    })
    if (deleted) postEvent({ kind: 'branch-cache-refreshed', chatId })
    return deleted
  }

  async getMessage(messageId: MessageId): Promise<Message | undefined> {
    return openDb().then(async (db) => {
      const row = await db.messages.get(messageId)
      return row ? cloneMessage(row) : undefined
    })
  }

  async listMessages(chatId: ChatId): Promise<Message[]> {
    return openDb().then(async (db) =>
      (await db.messages.where('chatId').equals(chatId).toArray()).map(cloneMessage),
    )
  }

  async getAttachment(attachmentId: AttachmentId): Promise<Attachment | undefined> {
    return openDb().then((db) => db.attachments.get(attachmentId))
  }

  async getAttachmentBundle(attachmentId: AttachmentId): Promise<AttachmentBundle | undefined> {
    return openDb().then(async (db) => {
      const attachment = await db.attachments.get(attachmentId)
      if (!attachment) return undefined
      const [blobs, artifacts, jobs] = await Promise.all([
        db.attachmentBlobs.where('attachmentId').equals(attachmentId).toArray(),
        db.attachmentArtifacts.where('attachmentId').equals(attachmentId).toArray(),
        db.attachmentJobs.where('attachmentId').equals(attachmentId).toArray(),
      ])
      return { attachment, blobs, artifacts, jobs }
    })
  }

  async getAttachmentBlob(blobId: string): Promise<AttachmentBlob | undefined> {
    return openDb().then((db) => db.attachmentBlobs.get(blobId))
  }

  async searchAttachments(query: AttachmentSearchQuery = {}): Promise<AttachmentSearchPage> {
    const db = await openDb()
    const limit = query.limit ?? 100
    const rows = await db.attachments.toArray()
    const artifacts = await db.attachmentArtifacts.toArray()
    const artifactsByAttachment = new Map<AttachmentId, AttachmentArtifact[]>()
    for (const artifact of artifacts) {
      const list = artifactsByAttachment.get(artifact.attachmentId) ?? []
      list.push(artifact)
      artifactsByAttachment.set(artifact.attachmentId, list)
    }
    const terms = query.query?.trim().toLowerCase().split(/\s+/).filter(Boolean) ?? []
    const filtered = rows.filter((attachment) => {
      const filters = query.filters
      if (filters?.kind && attachment.kind !== filters.kind) return false
      if (filters?.mime && attachment.mime !== filters.mime) return false
      if (filters?.origin && attachment.origin !== filters.origin) return false
      if (filters?.storageKind && attachment.storage.kind !== filters.storageKind) return false
      if (
        filters?.minSizeBytes !== undefined &&
        (attachment.sizeBytes ?? 0) < filters.minSizeBytes
      ) {
        return false
      }
      if (
        filters?.maxSizeBytes !== undefined &&
        (attachment.sizeBytes ?? 0) > filters.maxSizeBytes
      ) {
        return false
      }
      if (filters?.minRefCount !== undefined && attachment.refCount < filters.minRefCount) {
        return false
      }
      if (filters?.maxRefCount !== undefined && attachment.refCount > filters.maxRefCount) {
        return false
      }
      if (terms.length === 0) return true
      const haystack = attachmentSearchText(
        attachment,
        artifactsByAttachment.get(attachment.id) ?? [],
      )
      return terms.every((term) => haystack.includes(term))
    })
    filtered.sort(attachmentSorter(query.sort ?? 'created-desc'))
    const start =
      query.cursor === undefined
        ? 0
        : Math.max(0, filtered.findIndex((row) => row.id === query.cursor) + 1)
    const page = filtered.slice(start, start + limit)
    const nextCursor = filtered.length > start + limit ? page.at(-1)?.id : undefined
    return nextCursor ? { rows: page, nextCursor } : { rows: page }
  }

  async getDraft(chatId: ChatId): Promise<DraftRow | undefined> {
    return openDb().then(async (db) => {
      const row = await db.drafts.get(chatId)
      return row ? cloneDraft(row) : undefined
    })
  }

  async runMutation<T>(
    scopes: MutationScope[],
    fn: (ctx: MutationContext) => Promise<T> | T,
  ): Promise<WorkspaceMutationResult<T>> {
    const db = await openDb()
    const now = Date.now()
    const pendingEvents: Array<{
      chatId: ChatId
      versions: ChatVersions
      affected: ChatMutationSummary[]
    }> = []
    const pendingBranchCacheEvents = new Set<ChatId>()
    const mutationTables = resolveMutationTables(db, scopes)

    const result: WorkspaceMutationResult<T> = await withMutationLocks(scopes, async () =>
      db.transaction<WorkspaceMutationResult<T>>('rw', mutationTables, async (tx: Transaction) => {
        const { assertScope } = createScopeChecker(scopes)
        const chatStates = new Map<ChatId, ChatMutationState>()
        const affectedMessageIds = new Set<MessageId>()
        let wroteWorkspaceState = false

        const ensureChatState = async (chatId: ChatId): Promise<ChatMutationState> => {
          const existing = chatStates.get(chatId)
          if (existing) return existing
          const beforeChat = await loadChatOrThrow(tx.table<Chat, ChatId>('chats'), chatId)
          const state: ChatMutationState = {
            beforeChat,
            visibleMetaPatch: {},
            hiddenMetaPatch: {},
            summaryPatch: {},
            visibleMetaDirty: false,
            summaryVersionDirty: false,
            messageSummaryDirty: false,
            broadcast: false,
            changedMessageIds: new Set<MessageId>(),
            affected: new Map<string, ChatMutationSummary>(),
          }
          chatStates.set(chatId, state)
          return state
        }

        const ensureMessageSnapshots = async (
          state: ChatMutationState,
        ): Promise<{ beforeMessages: Message[]; afterMessages: Message[] }> => {
          if (state.beforeMessages && state.afterMessages) {
            return {
              beforeMessages: state.beforeMessages,
              afterMessages: state.afterMessages,
            }
          }
          const snapshot = await tx
            .table<Message, MessageId>('messages')
            .where('chatId')
            .equals(state.beforeChat.id)
            .toArray()
          state.beforeMessages = snapshot.map(cloneMessage)
          state.afterMessages = snapshot.map(cloneMessage)
          return {
            beforeMessages: state.beforeMessages,
            afterMessages: state.afterMessages,
          }
        }

        for (const scope of scopes) {
          if (scope.kind === 'chat-meta' || scope.kind === 'children' || scope.kind === 'draft') {
            await ensureChatState(scope.chatId)
          }
        }

        const requireChatState = (chatId: ChatId): ChatMutationState => {
          const state = chatStates.get(chatId)
          if (!state) {
            throw new Error(`ChatStateUnavailable:${chatId}`)
          }
          return state
        }

        const bumpChildList = async (
          chatId: ChatId,
          parentId: MessageId | null,
          bumpNow = now,
        ): Promise<ChildListState> => {
          assertScope({ kind: 'children', chatId, parentId })
          const table = tx.table<ChildListState, string>('childLists')
          const id = childListKey(chatId, parentId)
          const existing = await table.get(id)
          const next: ChildListState = existing
            ? { ...existing, version: existing.version + 1, updatedAt: bumpNow }
            : { id, chatId, parentId, version: 1, updatedAt: bumpNow }
          await table.put(next)
          wroteWorkspaceState = true
          const state = await ensureChatState(chatId)
          state.broadcast = true
          upsertAffected(state, { kind: 'children', chatId, parentId })
          return next
        }

        const ctx: MutationContext = {
          getChat: async (chatId) => {
            const state = chatStates.get(chatId)
            if (!state) return tx.table<Chat, ChatId>('chats').get(chatId)
            return {
              ...state.beforeChat,
              ...state.hiddenMetaPatch,
              ...state.visibleMetaPatch,
              ...state.summaryPatch,
            }
          },

          patchChatMeta: (chatId, patch, options = {}) => {
            const { touchVisibleState = true, broadcast = touchVisibleState } = options
            assertScope({ kind: 'chat-meta', chatId })
            const state = requireChatState(chatId)
            const current = {
              ...state.beforeChat,
              ...state.hiddenMetaPatch,
              ...state.visibleMetaPatch,
              ...state.summaryPatch,
            }
            if (touchVisibleState) {
              const applied = changedPatch(current, stripMetaPatch(patch))
              if (!applied) return
              state.visibleMetaPatch = {
                ...state.visibleMetaPatch,
                ...applied,
              }
              state.visibleMetaDirty = true
              state.summaryVersionDirty = true
            } else {
              const applied = changedPatch(current, stripMetaPatch(patch))
              if (!applied) return
              state.hiddenMetaPatch = {
                ...state.hiddenMetaPatch,
                ...applied,
              }
            }
            state.broadcast ||= broadcast
            upsertAffected(state, { kind: 'chat-meta', chatId })
          },

          patchChatSummary: (chatId, patch) => {
            const state = requireChatState(chatId)
            const current = {
              ...state.beforeChat,
              ...state.hiddenMetaPatch,
              ...state.visibleMetaPatch,
              ...state.summaryPatch,
            }
            const applied = changedPatch(current, stripSummaryPatch(patch))
            if (!applied) return
            state.summaryPatch = {
              ...state.summaryPatch,
              ...applied,
            }
            state.summaryVersionDirty = true
            state.broadcast = true
            upsertAffected(state, { kind: 'chat-meta', chatId })
          },

          getMessage: async (messageId) => {
            const row = await tx.table<Message, MessageId>('messages').get(messageId)
            return row ? cloneMessage(row) : undefined
          },

          listMessages: async (chatId) =>
            (
              await tx
                .table<Message, MessageId>('messages')
                .where('chatId')
                .equals(chatId)
                .toArray()
            ).map(cloneMessage),

          listChildren: async (chatId, parentId) => {
            const rows =
              parentId === null
                ? await tx
                    .table<Message, MessageId>('messages')
                    .where('chatId')
                    .equals(chatId)
                    .toArray()
                : await tx
                    .table<Message, MessageId>('messages')
                    .where('[chatId+parentId]')
                    .equals([chatId, parentId])
                    .toArray()
            return rows.filter((row) => row.parentId === parentId).map(cloneMessage)
          },

          putMessage: async (message, options: PutMessageOptions = {}) => {
            const { touchChatSummary = true, broadcast = touchChatSummary } = options
            const table = tx.table<Message, MessageId>('messages')
            const existing = await table.get(message.id)
            const chatId = existing?.chatId ?? message.chatId
            const needsChatState = touchChatSummary || broadcast
            const state = needsChatState ? await ensureChatState(chatId) : undefined
            const clone = cloneMessage(message)

            assertScope({ kind: 'message', messageId: clone.id })
            if (existing) {
              if (existing.chatId !== clone.chatId) {
                throw new Error(`CrossChatMessageMove:${clone.id}`)
              }
              const moved =
                existing.parentId !== clone.parentId || existing.siblingIndex !== clone.siblingIndex
              const deletionChanged = existing.deleted !== clone.deleted
              if (!touchChatSummary && (moved || deletionChanged)) {
                throw new Error(`DeferredMessageWriteRequiresStableTree:${clone.id}`)
              }
              if (moved || deletionChanged) {
                assertScope({ kind: 'children', chatId, parentId: existing.parentId })
                assertScope({ kind: 'children', chatId, parentId: clone.parentId })
              }
              const changed = stableStringify(existing) !== stableStringify(clone)
              if (!changed) return
              if (touchChatSummary) {
                await ensureMessageSnapshots(state as ChatMutationState)
              }
              clone.nodeVersion = existing.nodeVersion + 1
              await table.put(clone)
              wroteWorkspaceState = true
              if (state?.afterMessages) {
                replaceMessage(state.afterMessages, clone)
              }
              if (moved || deletionChanged) {
                await bumpChildList(chatId, existing.parentId)
                if (existing.parentId !== clone.parentId) {
                  await bumpChildList(chatId, clone.parentId)
                }
              }
            } else {
              if (!touchChatSummary) {
                throw new Error(`DeferredMessageWriteRequiresExistingRow:${clone.id}`)
              }
              await ensureMessageSnapshots(state as ChatMutationState)
              assertScope({ kind: 'children', chatId, parentId: clone.parentId })
              if (clone.nodeVersion === undefined) clone.nodeVersion = 0
              await table.put(clone)
              wroteWorkspaceState = true
              if (state?.afterMessages) {
                replaceMessage(state.afterMessages, clone)
              }
              await bumpChildList(chatId, clone.parentId)
            }

            if (touchChatSummary && state) {
              state.summaryVersionDirty = true
              state.messageSummaryDirty = true
              state.changedMessageIds.add(clone.id)
            }
            if (broadcast && state) {
              state.broadcast = true
              upsertAffected(state, { kind: 'message', chatId, messageId: clone.id })
            }
            affectedMessageIds.add(clone.id)
          },

          deleteMessage: async (messageId) => {
            assertScope({ kind: 'message', messageId })
            const table = tx.table<Message, MessageId>('messages')
            const existing = await table.get(messageId)
            if (!existing) return
            const state = await ensureChatState(existing.chatId)
            await ensureMessageSnapshots(state)
            assertScope({ kind: 'children', chatId: existing.chatId, parentId: existing.parentId })
            await table.delete(messageId)
            wroteWorkspaceState = true
            removeMessage(state.afterMessages ?? [], messageId)
            await bumpChildList(existing.chatId, existing.parentId)
            state.summaryVersionDirty = true
            state.messageSummaryDirty = true
            state.broadcast = true
            state.changedMessageIds.add(messageId)
            affectedMessageIds.add(messageId)
            upsertAffected(state, {
              kind: 'message',
              chatId: existing.chatId,
              messageId,
            })
          },

          getChildList: async (chatId, parentId) => {
            const row = await tx
              .table<ChildListState, string>('childLists')
              .get(childListKey(chatId, parentId))
            return (
              row ?? {
                id: childListKey(chatId, parentId),
                chatId,
                parentId,
                version: 0,
                updatedAt: 0,
              }
            )
          },

          bumpChildList,

          getAttachment: async (attachmentId) =>
            tx.table<Attachment, AttachmentId>('attachments').get(attachmentId),

          putAttachment: async (attachment) => {
            assertScope({ kind: 'attachment', attachmentId: attachment.id })
            await tx.table<Attachment, AttachmentId>('attachments').put(attachment)
            wroteWorkspaceState = true
          },

          deleteAttachment: async (attachmentId) => {
            assertScope({ kind: 'attachment', attachmentId })
            const table = tx.table<Attachment, AttachmentId>('attachments')
            const existing = await table.get(attachmentId)
            if (!existing) return
            await tx
              .table<AttachmentBlob, string>('attachmentBlobs')
              .where('attachmentId')
              .equals(attachmentId)
              .delete()
            await tx
              .table<AttachmentArtifact, string>('attachmentArtifacts')
              .where('attachmentId')
              .equals(attachmentId)
              .delete()
            await tx
              .table<AttachmentJob, string>('attachmentJobs')
              .where('attachmentId')
              .equals(attachmentId)
              .delete()
            await table.delete(attachmentId)
            wroteWorkspaceState = true
          },

          getAttachmentBlob: async (blobId) =>
            tx.table<AttachmentBlob, string>('attachmentBlobs').get(blobId),

          putAttachmentBlob: async (blob) => {
            assertScope({ kind: 'attachment', attachmentId: blob.attachmentId })
            await tx.table<AttachmentBlob, string>('attachmentBlobs').put(blob)
            wroteWorkspaceState = true
          },

          deleteAttachmentBlob: async (blobId) => {
            const table = tx.table<AttachmentBlob, string>('attachmentBlobs')
            const existing = await table.get(blobId)
            if (!existing) return
            assertScope({ kind: 'attachment', attachmentId: existing.attachmentId })
            await table.delete(blobId)
            wroteWorkspaceState = true
          },

          putAttachmentArtifact: async (artifact) => {
            assertScope({ kind: 'attachment', attachmentId: artifact.attachmentId })
            await tx.table<AttachmentArtifact, string>('attachmentArtifacts').put(artifact)
            wroteWorkspaceState = true
          },

          deleteAttachmentArtifact: async (artifactId) => {
            const table = tx.table<AttachmentArtifact, string>('attachmentArtifacts')
            const existing = await table.get(artifactId)
            if (!existing) return
            assertScope({ kind: 'attachment', attachmentId: existing.attachmentId })
            await table.delete(artifactId)
            wroteWorkspaceState = true
          },

          putAttachmentJob: async (job) => {
            assertScope({ kind: 'attachment', attachmentId: job.attachmentId })
            await tx.table<AttachmentJob, string>('attachmentJobs').put(job)
            wroteWorkspaceState = true
          },

          deleteAttachmentJob: async (jobId) => {
            const table = tx.table<AttachmentJob, string>('attachmentJobs')
            const existing = await table.get(jobId)
            if (!existing) return
            assertScope({ kind: 'attachment', attachmentId: existing.attachmentId })
            await table.delete(jobId)
            wroteWorkspaceState = true
          },

          getDraft: async (chatId) => {
            const row = await tx.table<DraftRow, ChatId>('drafts').get(chatId)
            return row ? cloneDraft(row) : undefined
          },

          putDraft: async (draft) => {
            assertScope({ kind: 'draft', chatId: draft.chatId })
            const state = await ensureChatState(draft.chatId)
            const table = tx.table<DraftRow, ChatId>('drafts')
            const existing = await table.get(draft.chatId)
            const normalized = cloneDraft(draft)
            if (existing && stableStringify(cloneDraft(existing)) === stableStringify(normalized))
              return
            await table.put(normalized)
            wroteWorkspaceState = true
            state.broadcast = true
            upsertAffected(state, { kind: 'draft', chatId: draft.chatId })
          },

          deleteDraft: async (chatId) => {
            assertScope({ kind: 'draft', chatId })
            const state = await ensureChatState(chatId)
            const table = tx.table<DraftRow, ChatId>('drafts')
            const existing = await table.get(chatId)
            if (!existing) return
            await table.delete(chatId)
            wroteWorkspaceState = true
            state.broadcast = true
            upsertAffected(state, { kind: 'draft', chatId })
          },
        }

        const value = await fn(ctx)

        const chatVersions: Record<ChatId, ChatVersions> = {}
        const affectedChatIds: ChatId[] = []
        const chatTable = tx.table<Chat, ChatId>('chats')

        for (const [chatId, state] of chatStates) {
          const current = await chatTable.get(chatId)
          if (!current) throw new ChatMissingError(chatId)
          const next: Chat = {
            ...current,
            ...state.hiddenMetaPatch,
            ...state.visibleMetaPatch,
          }

          if (state.visibleMetaDirty) {
            next.metaVersion = current.metaVersion + 1
          }

          if (state.summaryVersionDirty) {
            next.updatedAt = now
            next.summaryVersion = current.summaryVersion + 1
          }

          if (state.messageSummaryDirty) {
            const afterMessages =
              state.afterMessages ??
              (await tx
                .table<Message, MessageId>('messages')
                .where('chatId')
                .equals(chatId)
                .toArray())
            const nextLeafId = findLastUpdatedLeafId(afterMessages)
            next.lastUpdatedLeafId = nextLeafId
            next.wordCount = countMessagesWords(buildBranchMessages(afterMessages, nextLeafId))
            next.totalCostUsd = computeTotalCostUsd(afterMessages)
            const beforeMessages = state.beforeMessages ?? []
            const lastBranchUpdatedAtChanged = shouldBumpLastBranchUpdatedAt(
              state.beforeChat,
              beforeMessages,
              afterMessages,
              state.changedMessageIds,
            )
            if (lastBranchUpdatedAtChanged) {
              next.lastBranchUpdatedAt = now
            }
            if (nextLeafId !== state.beforeChat.lastUpdatedLeafId || lastBranchUpdatedAtChanged) {
              await writeBranchCacheForSummary(tx, chatId, nextLeafId, afterMessages, now)
              wroteWorkspaceState = true
              pendingBranchCacheEvents.add(chatId)
            }
          }

          const summaryPatch = stripSummaryPatch(state.summaryPatch)
          const patched: Chat = { ...next, ...summaryPatch }

          const changed = stableStringify(current) !== stableStringify(patched)
          if (changed) {
            await chatTable.put(patched)
            wroteWorkspaceState = true
            affectedChatIds.push(chatId)
          }
          chatVersions[chatId] = {
            metaVersion: patched.metaVersion,
            summaryVersion: patched.summaryVersion,
          }
        }

        if (wroteWorkspaceState) {
          await bumpWorkspaceMeta(tx, now)
        }

        for (const [chatId, state] of chatStates) {
          if (!state.broadcast) continue
          const versions = chatVersions[chatId]
          if (!versions) continue
          pendingEvents.push({
            chatId,
            versions,
            affected: [...state.affected.values()],
          })
        }

        return {
          value,
          affectedChatIds,
          affectedMessageIds: [...affectedMessageIds],
          chatVersions,
        }
      }),
    )

    for (const event of pendingEvents) {
      postEvent({
        kind: 'chat-mutated',
        chatId: event.chatId,
        metaVersion: event.versions.metaVersion,
        summaryVersion: event.versions.summaryVersion,
        affected: event.affected,
      })
    }
    for (const chatId of pendingBranchCacheEvents) {
      postEvent({ kind: 'branch-cache-refreshed', chatId })
    }

    return result
  }
}

let singleton: WorkspaceRepository | null = null

export function getBrowserRepository(): WorkspaceRepository {
  singleton ??= new BrowserWorkspaceRepository()
  return singleton
}

export function __resetBrowserRepositoryForTests(): void {
  singleton = null
}
