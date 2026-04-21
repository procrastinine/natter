import type { Table, Transaction } from 'dexie'
import { findLastUpdatedLeafId, indexById, isOnPathToLeaf } from '../core/active-path'
import type {
  Attachment,
  AttachmentId,
  Chat,
  ChatId,
  ChatVersions,
  ChildListState,
  DraftRow,
  Message,
  MessageId,
  MutationScope,
} from '../core/types'
import { postEvent } from './broadcast'
import { childListKey, type NatterDb, openDb, type SettingsRow } from './db'
import { withMutationLocks } from './locks'
import type {
  ChatMutationSummary,
  MutationContext,
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
  | 'attachments'
  | 'chats'
  | 'childLists'
  | 'drafts'
  | 'messages'
  | 'settings'

const MUTATION_TABLE_ORDER: readonly BrowserMutationTableName[] = [
  'attachments',
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
  return structuredClone(message)
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

function countWords(items: readonly Message[]): number {
  let total = 0
  for (const message of items) {
    for (const item of message.content) {
      if (item.type !== 'text' && item.type !== 'output_text') continue
      const words = item.text.trim().split(/\s+/).filter(Boolean)
      total += words.length
    }
  }
  return total
}

function buildBranchMessages(messages: readonly Message[], leafId: MessageId | null): Message[] {
  if (leafId === null) return []
  const byId = indexById(messages)
  const branch: Message[] = []
  let currentId: MessageId | null = leafId
  while (currentId !== null) {
    const message = byId.get(currentId)
    if (!message || message.deleted) break
    branch.push(message)
    currentId = message.parentId
  }
  branch.reverse()
  return branch
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

export function resolveMutationTableNames(
  scopes: readonly MutationScope[],
): BrowserMutationTableName[] {
  const names = new Set<BrowserMutationTableName>(['settings'])
  for (const scope of scopes) {
    switch (scope.kind) {
      case 'attachment':
        names.add('attachments')
        break
      case 'chat-meta':
        names.add('chats')
        break
      case 'children':
        names.add('chats')
        names.add('childLists')
        names.add('messages')
        break
      case 'draft':
        names.add('chats')
        names.add('drafts')
        break
      case 'message':
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
      case 'chats':
        return db.chats as Table<unknown, unknown>
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

  async getMessage(messageId: MessageId): Promise<Message | undefined> {
    return openDb().then((db) => db.messages.get(messageId))
  }

  async listMessages(chatId: ChatId): Promise<Message[]> {
    return openDb().then((db) => db.messages.where('chatId').equals(chatId).toArray())
  }

  async getDraft(chatId: ChatId): Promise<DraftRow | undefined> {
    return openDb().then((db) => db.drafts.get(chatId))
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

          getMessage: async (messageId) => tx.table<Message, MessageId>('messages').get(messageId),

          listMessages: async (chatId) =>
            tx.table<Message, MessageId>('messages').where('chatId').equals(chatId).toArray(),

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
            return rows.filter((row) => row.parentId === parentId)
          },

          putMessage: async (message) => {
            const table = tx.table<Message, MessageId>('messages')
            const existing = await table.get(message.id)
            const chatId = existing?.chatId ?? message.chatId
            const state = await ensureChatState(chatId)
            const clone = cloneMessage(message)

            assertScope({ kind: 'message', messageId: clone.id })
            if (existing) {
              if (existing.chatId !== clone.chatId) {
                throw new Error(`CrossChatMessageMove:${clone.id}`)
              }
              const moved =
                existing.parentId !== clone.parentId || existing.siblingIndex !== clone.siblingIndex
              const deletionChanged = existing.deleted !== clone.deleted
              if (moved || deletionChanged) {
                assertScope({ kind: 'children', chatId, parentId: existing.parentId })
                assertScope({ kind: 'children', chatId, parentId: clone.parentId })
              }
              const changed = stableStringify(existing) !== stableStringify(clone)
              if (!changed) return
              await ensureMessageSnapshots(state)
              clone.nodeVersion = existing.nodeVersion + 1
              await table.put(clone)
              wroteWorkspaceState = true
              replaceMessage(state.afterMessages ?? [], clone)
              if (moved || deletionChanged) {
                await bumpChildList(chatId, existing.parentId)
                if (existing.parentId !== clone.parentId) {
                  await bumpChildList(chatId, clone.parentId)
                }
              }
            } else {
              await ensureMessageSnapshots(state)
              assertScope({ kind: 'children', chatId, parentId: clone.parentId })
              if (clone.nodeVersion === undefined) clone.nodeVersion = 0
              await table.put(clone)
              wroteWorkspaceState = true
              replaceMessage(state.afterMessages ?? [], clone)
              await bumpChildList(chatId, clone.parentId)
            }

            state.summaryVersionDirty = true
            state.messageSummaryDirty = true
            state.broadcast = true
            state.changedMessageIds.add(clone.id)
            affectedMessageIds.add(clone.id)
            upsertAffected(state, { kind: 'message', chatId, messageId: clone.id })
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
            await table.delete(attachmentId)
            wroteWorkspaceState = true
          },

          getDraft: async (chatId) => tx.table<DraftRow, ChatId>('drafts').get(chatId),

          putDraft: async (draft) => {
            assertScope({ kind: 'draft', chatId: draft.chatId })
            const state = await ensureChatState(draft.chatId)
            const table = tx.table<DraftRow, ChatId>('drafts')
            const existing = await table.get(draft.chatId)
            if (existing && stableStringify(existing) === stableStringify(draft)) return
            await table.put(draft)
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
              (await tx.table<Message, MessageId>('messages').where('chatId').equals(chatId).toArray())
            const nextLeafId = findLastUpdatedLeafId(afterMessages)
            next.lastUpdatedLeafId = nextLeafId
            next.wordCount = countWords(buildBranchMessages(afterMessages, nextLeafId))
            next.totalCostUsd = computeTotalCostUsd(afterMessages)
            const beforeMessages = state.beforeMessages ?? []
            if (
              shouldBumpLastBranchUpdatedAt(
                state.beforeChat,
                beforeMessages,
                afterMessages,
                state.changedMessageIds,
              )
            ) {
              next.lastBranchUpdatedAt = now
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
          const stored = (await tx.table<SettingsRow, string>('settings').get(WORKSPACE_META_KEY))
            ?.value as StoredWorkspaceMeta | undefined
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
          await tx.table<SettingsRow, string>('settings').put({
            key: WORKSPACE_META_KEY,
            value: nextWorkspaceMeta,
          })
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
