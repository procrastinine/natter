import type { Transaction } from 'dexie'
import {
  chatTagNameLower,
  createChatRow,
  nextChatCalibrationGeneration,
  sameOrderedIds,
  uniqueChatTagNames,
} from '../core/chat-metadata'
import { fixedConversationSelectionTarget } from '../core/messages'
import { tokenCalibrationKeyForStoredRecordKey } from '../core/model-ids'
import { sortChatFolders } from '../core/sidebar-sort'
import {
  aggregateCalibrationSamples,
  clearAllCalibrationFromGlobalRecord,
  clearCalibrationFamilyFromGlobalRecord,
  GLOBAL_TOKEN_CALIBRATION_KEY,
  subtractCalibrationSamplesFromGlobalRecord,
} from '../core/token-calibration'
import type {
  AttachmentId,
  AttachmentReferenceEdge,
  Chat,
  ChatFolder,
  ChatId,
  ChatTag,
  ChatVersions,
  FolderId,
  MessageId,
  MutationScope,
  TagId,
  TokenCalibrationSample,
} from '../core/types'
import { sameOrderedValues, stableStringify } from '../lib/same-value'
import { newId } from '../lib/ulid'
import type {
  BrowserCommandSessionPort,
  BrowserMutationCommandPort,
  BrowserMutationRunnerPort,
} from './browser-domain-mutations'
import { boundedMaintenanceLimit } from './browser-workspace-maintenance-contract'
import {
  deleteChatFolderByteOwner,
  deleteChatTagByteOwners,
  putChatFolderByteOwner,
  putChatTagByteOwners,
  putTokenCalibrationSettingByteOwner,
} from './byte-owner-mutation'
import {
  applyChatRowWriteTransitions,
  CHAT_ROW_LINKED_TRANSACTION_CAPABILITY,
  CHAT_ROW_PRESERVING_LINKS_TRANSACTION_CAPABILITY,
} from './chat-row-transition'
import { readArchivedChatIdPage } from './chat-storage-codec'
import {
  CHAT_CLOSURE_BATCH_LIMIT,
  CHAT_CLOSURE_TRANSACTION_CAPABILITY,
  ChatClosurePlanChangedError,
  deleteChatClosure,
  deletePlannedEmptyDraftChats,
  emptyDraftChatClosureLockNames,
  planEmptyDraftChatClosure,
} from './chat-storage-ownership'
import {
  type ConfigurationLink,
  chatConfigurationTargetResourceNames,
  configurationLinksForChat,
  configurationOwnerKey,
} from './configuration-domain-contract'
import { configurationProfileUsageResourceNamesForLinks } from './configuration-profile-usage-projection'
import type { NatterDb } from './db'
import type { SettingsRow } from './db-rows'
import { normalizeNamedLocks, scopeResourceName } from './locks'
import type { MessageHeaderRow } from './message-storage'
import { physicalStorageTables, physicalTransactionPlan } from './physical-storage-tables'
import type {
  CreateFolderInput,
  DeleteArchivedChatsResult,
  DeleteFolderResult,
  EnsureFolderAndMoveChatsInput,
  EnsureFolderAndMoveChatsResult,
  UpdateFolderInput,
} from './repository'
import { TransactionChatUpdateClock } from './transaction-order'
import type {
  ChatCalibrationEverywhereResult,
  ChatMetadataWriteResult,
  ChatTagAssignmentResult,
  DeleteArchivedChatMetadataResult,
  WorkspaceCommand,
} from './workspace-protocol'

const CHAT_METADATA_TRANSACTION = physicalTransactionPlan(
  CHAT_ROW_PRESERVING_LINKS_TRANSACTION_CAPABILITY,
)
const CHAT_METADATA_LINK_TRANSACTION = physicalTransactionPlan(
  CHAT_ROW_LINKED_TRANSACTION_CAPABILITY,
)
const CHAT_FOLDER_TRANSACTION = physicalTransactionPlan(
  CHAT_ROW_PRESERVING_LINKS_TRANSACTION_CAPABILITY,
  physicalStorageTables('folders'),
)
const CHAT_FOLDER_LINK_TRANSACTION = physicalTransactionPlan(
  CHAT_ROW_LINKED_TRANSACTION_CAPABILITY,
  physicalStorageTables('folders'),
)
const CHAT_TAG_TRANSACTION = physicalTransactionPlan(
  CHAT_ROW_PRESERVING_LINKS_TRANSACTION_CAPABILITY,
  physicalStorageTables('tags'),
)
const CHAT_CALIBRATION_TRANSACTION = physicalTransactionPlan(
  CHAT_ROW_PRESERVING_LINKS_TRANSACTION_CAPABILITY,
  physicalStorageTables('settings'),
)
const CHAT_CLOSURE_TRANSACTION = physicalTransactionPlan(CHAT_CLOSURE_TRANSACTION_CAPABILITY)
const FOLDER_TRANSACTION = physicalTransactionPlan(physicalStorageTables('folders'))

class ChatMetadataLinkPlanChangedError extends Error {}

function calibrationRecordWithoutFamily(
  samples: Record<string, TokenCalibrationSample> | undefined,
  calibrationKey: string,
): { changed: boolean; samples: Record<string, TokenCalibrationSample> } {
  const retained: Record<string, TokenCalibrationSample> = {}
  let changed = false
  for (const [storedKey, sample] of Object.entries(samples ?? {})) {
    if (tokenCalibrationKeyForStoredRecordKey(storedKey) === calibrationKey) {
      changed = true
      continue
    }
    retained[storedKey] = sample
  }
  return { changed, samples: aggregateCalibrationSamples(retained) }
}

function normalizeName(value: string, kind: 'Folder' | 'Tag'): string {
  const name = value.trim()
  if (name.length === 0) throw new Error(`${kind}NameRequired`)
  return name
}

function organizationNameKey(value: string): string {
  return value.trim().normalize('NFKC').toLowerCase()
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
  attachmentEdgeSignatures: string[]
  configurationResourceNames: string[]
}

async function archivedDeleteSnapshots(
  db: NatterDb,
  chatIds: readonly ChatId[],
): Promise<ArchivedChatDeleteSnapshot[]> {
  const snapshots: ArchivedChatDeleteSnapshot[] = []
  await db.transaction('r', [db.attachmentRefEdges, db.chats, db.messages], async (tx) => {
    const chats = tx.table<Chat, ChatId>('chats')
    const messages = tx.table<MessageHeaderRow, MessageId>('messages')
    const edges = tx.table<AttachmentReferenceEdge>('attachmentRefEdges')
    for (const chatId of chatIds) {
      const chat = await chats.get(chatId)
      if (!chat?.archived) continue
      const [rows, chatEdges] = await Promise.all([
        messages.where('chatId').equals(chatId).toArray(),
        edges.where('chatId').equals(chatId).toArray(),
      ])
      snapshots.push({
        chatId,
        messageIds: rows.map((message) => message.id),
        attachmentIds: [...new Set(chatEdges.map((edge) => edge.attachmentId))],
        attachmentEdgeSignatures: chatEdges.map(attachmentEdgeSignature).sort(),
        configurationResourceNames: normalizeNamedLocks(chatConfigurationTargetResourceNames(chat)),
      })
    }
  })
  return snapshots
}

function sameArchivedDeleteSnapshot(
  snapshot: ArchivedChatDeleteSnapshot,
  messages: readonly MessageHeaderRow[],
  edges: readonly AttachmentReferenceEdge[],
): boolean {
  return (
    sameOrderedValues(
      [...snapshot.messageIds].sort(),
      messages.map((message) => message.id).sort(),
    ) &&
    sameOrderedValues(snapshot.attachmentEdgeSignatures, edges.map(attachmentEdgeSignature).sort())
  )
}

function attachmentEdgeSignature(edge: AttachmentReferenceEdge): string {
  return JSON.stringify([
    edge.ownerKind,
    edge.ownerId,
    edge.chatId,
    edge.refId,
    edge.attachmentId,
    edge.ordinal,
    edge.includeInContext,
    edge.refUpdatedAt,
  ])
}

export async function materializeTemporaryChat(
  mutationPort: BrowserMutationRunnerPort,
  input: Extract<WorkspaceCommand, { kind: 'chat.materialize-temporary' }>['input'],
  replacementEpoch: number,
  commit: BrowserMutationCommandPort,
) {
  const chat = createChatRow({
    id: input.chatId,
    settings: input.settings,
    ...(input.presetId === undefined ? {} : { presetId: input.presetId }),
    temporary: true,
    now: input.now,
  })
  const result = await mutationPort.runMutation(
    [{ kind: 'chat-meta', chatId: chat.id }],
    (_ctx, mutation) => {
      mutation.requestStorageMaintenance('prune-empty-drafts')
    },
    {
      initialChat: chat,
      workspaceFence: { replacementEpoch },
      additionalLockNames: ['chat-catalog'],
    },
    commit,
    async (ctx) => {
      const committedChat = await ctx.getFinalChat(chat.id)
      if (!committedChat) throw new Error(`TemporaryChatCommitMissing:${chat.id}`)
      return {
        destination: await ctx.sealExactConversationDestination({
          chat: committedChat,
          target: fixedConversationSelectionTarget({ kind: 'default' }, null),
          tipId: null,
          exactPathHeaders: Object.freeze([]),
        }),
      }
    },
  )
  return result.value
}

export async function discardEmptyDraftChats(
  db: NatterDb,
  input: {
    chatIds: readonly ChatId[]
    exceptChatId?: ChatId | null
    now?: number
    staleBefore?: number
  },
  commit: BrowserCommandSessionPort,
): Promise<DeleteArchivedChatMetadataResult> {
  if (new Set(input.chatIds).size > CHAT_CLOSURE_BATCH_LIMIT) {
    throw new Error('ChatClosureBatchLimitExceeded')
  }
  const now = input.now ?? Date.now()
  for (;;) {
    const plan = await planEmptyDraftChatClosure(db, input.chatIds, input.staleBefore)
    if (plan.length === 0) return { deletedChatIds: [], affectedAttachmentIds: [] }
    try {
      const closure = await commit.withLocks(emptyDraftChatClosureLockNames(plan), (locked) =>
        locked.runTransaction(CHAT_CLOSURE_TRANSACTION, (tx) =>
          deletePlannedEmptyDraftChats(tx, plan, input.staleBefore, now),
        ),
      )
      return {
        deletedChatIds: closure.deletedChatIds,
        affectedAttachmentIds: closure.affectedAttachmentIds,
      }
    } catch (error) {
      if (error instanceof ChatClosurePlanChangedError) continue
      throw error
    }
  }
}

async function patchChatMetadataRows(
  db: NatterDb,
  chatIds: readonly ChatId[],
  now: number,
  commit: BrowserCommandSessionPort,
  patch: (chat: Chat) =>
    | {
        chat: Chat
        touchMeta: boolean
        touchSummary: boolean
      }
    | undefined,
  linkedResourceNames?: (chat: Chat) => readonly string[],
): Promise<ChatMetadataWriteResult<readonly ChatId[]>> {
  const uniqueChatIds = [...new Set(chatIds)].sort()
  const changedChats: Chat[] = []
  for (;;) {
    changedChats.length = 0
    let plannedResourceNames: string[] = []
    if (linkedResourceNames) {
      plannedResourceNames = await db.transaction('r', [db.chats], async (tx: Transaction) => {
        const resources: string[] = []
        const rows = await tx.table<Chat, ChatId>('chats').bulkGet(uniqueChatIds)
        for (const current of rows) {
          if (!current) continue
          resources.push(...linkedResourceNames(current))
          const change = patch(current)
          if (change) resources.push(...linkedResourceNames(change.chat))
        }
        return normalizeNamedLocks(resources)
      })
    }
    try {
      await commit.withLocks(
        [...uniqueChatIds.map((chatId) => `chat-meta:${chatId}`), ...plannedResourceNames],
        (locked) =>
          locked.runTransaction(
            linkedResourceNames ? CHAT_METADATA_LINK_TRANSACTION : CHAT_METADATA_TRANSACTION,
            async (tx) => {
              if (uniqueChatIds.length === 0) return
              const chats = tx.table<Chat, ChatId>('chats')
              const rows = await chats.bulkGet(uniqueChatIds)
              const updatedAtClock = new TransactionChatUpdateClock()
              const currentResourceNames: string[] = []
              const writes: Array<{ current: Chat; next: Chat }> = []
              for (const current of rows) {
                if (!current) continue
                if (linkedResourceNames) {
                  currentResourceNames.push(...linkedResourceNames(current))
                }
                const change = patch(current)
                if (!change) continue
                if (linkedResourceNames) {
                  currentResourceNames.push(...linkedResourceNames(change.chat))
                }
                const updatedAt = change.touchSummary
                  ? await updatedAtClock.next(tx, now)
                  : change.chat.updatedAt
                const next: Chat = {
                  ...change.chat,
                  metaVersion: current.metaVersion + (change.touchMeta ? 1 : 0),
                  summaryVersion: current.summaryVersion + (change.touchSummary ? 1 : 0),
                  updatedAt,
                }
                if (stableStringify(current) === stableStringify(next)) continue
                writes.push({ current, next })
              }
              if (
                linkedResourceNames &&
                !sameOrderedValues(plannedResourceNames, normalizeNamedLocks(currentResourceNames))
              ) {
                throw new ChatMetadataLinkPlanChangedError()
              }
              await applyChatRowWriteTransitions(
                tx,
                writes.map((write) => ({
                  kind: linkedResourceNames
                    ? ('replace-linked' as const)
                    : ('replace-preserving-links' as const),
                  previous: write.current,
                  next: write.next,
                })),
              )
              changedChats.push(...writes.map((write) => write.next))
            },
          ),
      )
      break
    } catch (error) {
      if (error instanceof ChatMetadataLinkPlanChangedError) continue
      throw error
    }
  }
  const chatVersions: Record<ChatId, ChatVersions> = {}
  for (const chat of changedChats) {
    chatVersions[chat.id] = {
      metaVersion: chat.metaVersion,
      summaryVersion: chat.summaryVersion,
      structuralVersion: chat.structuralVersion,
    }
  }
  return {
    value: changedChats.map((chat) => chat.id),
    affectedChatIds: changedChats.map((chat) => chat.id),
    chatVersions,
  }
}

export async function setChatsArchived(
  db: NatterDb,
  chatIds: readonly ChatId[],
  archived: boolean,
  now: number,
  commit: BrowserCommandSessionPort,
): Promise<ChatMetadataWriteResult<readonly ChatId[]>> {
  return patchChatMetadataRows(
    db,
    chatIds,
    now,
    commit,
    (chat) => {
      if (chat.archived === archived) return undefined
      return {
        chat: { ...chat, archived, updatedAt: now },
        touchMeta: true,
        touchSummary: true,
      }
    },
    chatConfigurationTargetResourceNames,
  )
}

export async function touchChatViewed(
  db: NatterDb,
  chatId: ChatId,
  now: number,
  commit: BrowserCommandSessionPort,
): Promise<ChatMetadataWriteResult<boolean>> {
  const result = await patchChatMetadataRows(db, [chatId], now, commit, (chat) => {
    if (chat.lastViewedAt >= now) return undefined
    return {
      chat: { ...chat, lastViewedAt: now },
      touchMeta: false,
      touchSummary: false,
    }
  })
  return { ...result, value: result.affectedChatIds.length > 0 }
}

export async function setChatManualTitle(
  db: NatterDb,
  chatId: ChatId,
  title: string,
  now: number,
  commit: BrowserCommandSessionPort,
): Promise<ChatMetadataWriteResult<boolean>> {
  const trimmed = title.trim()
  const result = await patchChatMetadataRows(db, [chatId], now, commit, (chat) => {
    if (trimmed.length === 0 || (chat.title === trimmed && chat.titleStatus === 'manual')) {
      return undefined
    }
    return {
      chat: { ...chat, title: trimmed, titleStatus: 'manual', updatedAt: now },
      touchMeta: true,
      touchSummary: true,
    }
  })
  return { ...result, value: result.affectedChatIds.length > 0 }
}

export async function moveChatRowsToFolder(
  db: NatterDb,
  chatIds: readonly ChatId[],
  folderId: FolderId | null,
  now: number,
  commit: BrowserCommandSessionPort,
): Promise<ChatMetadataWriteResult<boolean>> {
  const uniqueChatIds = [...new Set(chatIds)].sort()
  const changedChats: Chat[] = []
  for (;;) {
    changedChats.length = 0
    const plannedFolderLocks = await db.transaction('r', [db.chats], async (tx: Transaction) => {
      const rows = await tx.table<Chat, ChatId>('chats').bulkGet(uniqueChatIds)
      return normalizeNamedLocks([
        ...(folderId ? [`folder:${folderId}`] : []),
        ...rows.flatMap((row) => (row?.folderId ? [`folder:${row.folderId}`] : [])),
      ])
    })
    try {
      await commit.withLocks(
        [...plannedFolderLocks, ...uniqueChatIds.map((chatId) => `chat-meta:${chatId}`)],
        (locked) =>
          locked.runTransaction(CHAT_FOLDER_TRANSACTION, async (tx) => {
            const folders = tx.table<ChatFolder, FolderId>('folders')
            const folder = folderId ? await folders.get(folderId) : undefined
            if (folderId && !folder) return
            const chats = tx.table<Chat, ChatId>('chats')
            const rows = await chats.bulkGet(uniqueChatIds)
            const currentFolderLocks = normalizeNamedLocks([
              ...(folderId ? [`folder:${folderId}`] : []),
              ...rows.flatMap((row) => (row?.folderId ? [`folder:${row.folderId}`] : [])),
            ])
            if (!sameOrderedValues(plannedFolderLocks, currentFolderLocks)) {
              throw new ChatMetadataLinkPlanChangedError()
            }
            const updatedAtClock = new TransactionChatUpdateClock()
            const writes: Array<{ previous: Chat; next: Chat }> = []
            for (const row of rows) {
              if (!row || (row.folderId ?? null) === folderId) continue
              const next: Chat = {
                ...row,
                folderId,
                updatedAt: await updatedAtClock.next(tx, now),
                metaVersion: row.metaVersion + 1,
                summaryVersion: row.summaryVersion + 1,
              }
              writes.push({ previous: row, next })
              changedChats.push(next)
            }
            await applyChatRowWriteTransitions(
              tx,
              writes.map(({ previous, next }) => ({
                kind: 'replace-preserving-links',
                previous,
                next,
              })),
            )
            if (changedChats.length === 0) return
            if (folder) {
              await putChatFolderByteOwner(
                tx,
                {
                  ...folder,
                  lastUsedAt: Math.max(folder.lastUsedAt ?? 0, now),
                  updatedAt: Math.max(folder.updatedAt, now),
                },
                folder,
              )
            }
          }),
      )
      break
    } catch (error) {
      if (error instanceof ChatMetadataLinkPlanChangedError) continue
      throw error
    }
  }
  const chatVersions: Record<ChatId, ChatVersions> = {}
  for (const chat of changedChats) {
    chatVersions[chat.id] = {
      metaVersion: chat.metaVersion,
      summaryVersion: chat.summaryVersion,
      structuralVersion: chat.structuralVersion,
    }
  }
  return {
    value: changedChats.length > 0,
    affectedChatIds: changedChats.map((chat) => chat.id),
    chatVersions,
  }
}

export async function setChatRowsTagsFromNames(
  chatIds: readonly ChatId[],
  names: readonly string[],
  now: number,
  commit: BrowserCommandSessionPort,
): Promise<ChatTagAssignmentResult> {
  const uniqueChatIds = [...new Set(chatIds)].sort()
  const normalizedNames = uniqueChatTagNames(names)
  const changedChats: Chat[] = []
  const affectedTagIds = new Set<TagId>()
  const deletedTagIds: TagId[] = []
  const selectedTagIds: TagId[] = []
  await commit.withLocks(
    ['tag-catalog', ...uniqueChatIds.map((chatId) => `chat-meta:${chatId}`)],
    (locked) =>
      locked.runTransaction(CHAT_TAG_TRANSACTION, async (tx) => {
        if (uniqueChatIds.length === 0) return
        const chats = tx.table<Chat, ChatId>('chats')
        const targets = (await chats.bulkGet(uniqueChatIds)).filter(
          (chat): chat is Chat => chat !== undefined,
        )
        if (targets.length === 0) return

        const tags = tx.table<ChatTag, TagId>('tags')
        const existingTags = await tags.toArray()
        const byLower = new Map(existingTags.map((tag) => [tag.nameLower, tag]))
        const byId = new Map(existingTags.map((tag) => [tag.id, tag]))
        const previousById = new Map(existingTags.map((tag) => [tag.id, tag]))
        for (const name of normalizedNames) {
          const lower = chatTagNameLower(name)
          let tag = byLower.get(lower)
          if (!tag) {
            tag = {
              id: newId(),
              name,
              nameLower: lower,
              createdAt: now,
              updatedAt: now,
            }
            byLower.set(lower, tag)
            byId.set(tag.id, tag)
            affectedTagIds.add(tag.id)
          }
          selectedTagIds.push(tag.id)
        }

        const writes: Array<{ previous: Chat; next: Chat }> = []
        for (const row of targets) {
          if (sameOrderedIds(row.tags, selectedTagIds)) continue
          const next: Chat = {
            ...row,
            tags: [...selectedTagIds],
            metaVersion: row.metaVersion + 1,
          }
          writes.push({ previous: row, next })
          changedChats.push(next)
        }
        await applyChatRowWriteTransitions(
          tx,
          writes.map(({ previous, next }) => ({
            kind: 'replace-preserving-links',
            previous,
            next,
          })),
        )

        if (changedChats.length > 0) {
          for (const tagId of selectedTagIds) {
            const tag = byId.get(tagId)
            if (!tag) continue
            const touched = {
              ...tag,
              lastUsedAt: Math.max(tag.lastUsedAt ?? 0, now),
              updatedAt: Math.max(tag.updatedAt, now),
            }
            byLower.set(touched.nameLower, touched)
            byId.set(touched.id, touched)
            affectedTagIds.add(touched.id)
          }
        }

        const usedTagIds = new Set((await chats.orderBy('tags').uniqueKeys()) as TagId[])
        for (const tag of byLower.values()) {
          if (usedTagIds.has(tag.id)) continue
          deletedTagIds.push(tag.id)
        }

        const deleted = new Set(deletedTagIds)
        const tagsToPut = [...affectedTagIds]
          .filter((tagId) => !deleted.has(tagId))
          .map((tagId) => byId.get(tagId))
          .filter((tag): tag is ChatTag => tag !== undefined)
        await putChatTagByteOwners(
          tx,
          tagsToPut,
          tagsToPut.flatMap((tag) => {
            const previous = previousById.get(tag.id)
            return previous ? [previous] : []
          }),
        )
        const deletedTags = existingTags.filter((tag) => deleted.has(tag.id))
        await deleteChatTagByteOwners(tx, deletedTags)
      }),
  )
  const chatVersions: Record<ChatId, ChatVersions> = {}
  for (const chat of changedChats) {
    chatVersions[chat.id] = {
      metaVersion: chat.metaVersion,
      summaryVersion: chat.summaryVersion,
      structuralVersion: chat.structuralVersion,
    }
  }
  return {
    value: selectedTagIds,
    affectedChatIds: changedChats.map((chat) => chat.id),
    chatVersions,
    affectedTagIds: [...affectedTagIds],
    deletedTagIds,
  }
}

export async function clearChatCalibration(
  command: Extract<WorkspaceCommand, { kind: 'chat.calibration.clear' }>,
  commit: BrowserCommandSessionPort,
): Promise<ChatMetadataWriteResult<boolean>> {
  let changed = false
  let nextChat: Chat | undefined
  await commit.withLocks(
    [`chat-meta:${command.chatId}`, `setting:${GLOBAL_TOKEN_CALIBRATION_KEY}`],
    (locked) =>
      locked.runTransaction(CHAT_CALIBRATION_TRANSACTION, async (tx) => {
        const chats = tx.table<Chat, ChatId>('chats')
        const current = await chats.get(command.chatId)
        if (!current) return
        let removed: Record<string, TokenCalibrationSample>
        let tokenCalibration: Record<string, TokenCalibrationSample>
        if (command.calibrationKey === undefined) {
          removed = current.tokenCalibration ?? {}
          tokenCalibration = {}
          changed = Object.keys(removed).length > 0
        } else {
          const retained = calibrationRecordWithoutFamily(
            current.tokenCalibration,
            command.calibrationKey,
          )
          changed = retained.changed
          tokenCalibration = retained.samples
          removed = Object.fromEntries(
            Object.entries(current.tokenCalibration ?? {}).filter(
              ([storedKey]) =>
                tokenCalibrationKeyForStoredRecordKey(storedKey) === command.calibrationKey,
            ),
          )
        }
        nextChat = {
          ...current,
          tokenCalibration,
          tokenCalibrationGeneration: nextChatCalibrationGeneration(current),
        }
        await applyChatRowWriteTransitions(tx, [
          { kind: 'replace-preserving-links', previous: current, next: nextChat },
        ])
        const settings = tx.table<SettingsRow, string>('settings')
        const global = await settings.get(GLOBAL_TOKEN_CALIBRATION_KEY)
        await putTokenCalibrationSettingByteOwner(
          tx,
          {
            key: GLOBAL_TOKEN_CALIBRATION_KEY,
            value: subtractCalibrationSamplesFromGlobalRecord(global?.value, removed, command.now),
          },
          global,
        )
      }),
  )
  if (!nextChat) {
    return {
      value: false,
      affectedChatIds: [],
      chatVersions: {},
    }
  }
  return {
    value: changed,
    affectedChatIds: [nextChat.id],
    chatVersions: {
      [nextChat.id]: {
        metaVersion: nextChat.metaVersion,
        summaryVersion: nextChat.summaryVersion,
        structuralVersion: nextChat.structuralVersion,
      },
    },
  }
}

export async function clearCalibrationEverywhere(
  db: NatterDb,
  command: Extract<
    WorkspaceCommand,
    { kind: 'chat.calibration.clear-family' | 'chat.calibration.clear-all' }
  >,
  commit: BrowserCommandSessionPort,
): Promise<ChatCalibrationEverywhereResult> {
  const changedChats: Chat[] = []
  let globalChanged = false
  let chatCount = 0
  for (;;) {
    changedChats.length = 0
    chatCount = 0
    const plannedChatIds = await db.transaction(
      'r',
      [db.chats, db.settings],
      async (tx: Transaction) => {
        return normalizeNamedLocks(
          await tx.table<Chat, ChatId>('chats').toCollection().primaryKeys(),
        )
      },
    )
    try {
      await commit.withLocks(
        [
          'chat-catalog',
          `setting:${GLOBAL_TOKEN_CALIBRATION_KEY}`,
          ...plannedChatIds.map((chatId) => `chat-meta:${chatId}`),
        ],
        (locked) =>
          locked.runTransaction(CHAT_CALIBRATION_TRANSACTION, async (tx) => {
            const chats = tx.table<Chat, ChatId>('chats')
            const currentChatIds = normalizeNamedLocks(await chats.toCollection().primaryKeys())
            if (!sameOrderedValues(plannedChatIds, currentChatIds)) {
              throw new ChatMetadataLinkPlanChangedError()
            }
            const rows = (await chats.bulkGet(currentChatIds)).filter(
              (chat): chat is Chat => chat !== undefined,
            )
            for (const row of rows) {
              const cleared =
                command.kind === 'chat.calibration.clear-all'
                  ? {
                      changed: Object.keys(row.tokenCalibration ?? {}).length > 0,
                      samples: {},
                    }
                  : calibrationRecordWithoutFamily(row.tokenCalibration, command.calibrationKey)
              if (cleared.changed) chatCount += 1
              changedChats.push({
                ...row,
                tokenCalibration: cleared.samples,
                tokenCalibrationGeneration: nextChatCalibrationGeneration(row),
              })
            }
            if (changedChats.length > 0) {
              await applyChatRowWriteTransitions(
                tx,
                changedChats.map((next, index) => {
                  const previous = rows[index]
                  if (!previous) throw new Error(`CalibrationChatRowMissing:${next.id}`)
                  return { kind: 'replace-preserving-links' as const, previous, next }
                }),
              )
            }
            const settings = tx.table<SettingsRow, string>('settings')
            const stored = await settings.get(GLOBAL_TOKEN_CALIBRATION_KEY)
            const clearedGlobal =
              command.kind === 'chat.calibration.clear-all'
                ? clearAllCalibrationFromGlobalRecord(stored?.value, command.now)
                : clearCalibrationFamilyFromGlobalRecord(
                    stored?.value,
                    command.calibrationKey,
                    command.now,
                  )
            globalChanged = clearedGlobal.changed
            await putTokenCalibrationSettingByteOwner(
              tx,
              { key: GLOBAL_TOKEN_CALIBRATION_KEY, value: clearedGlobal.value },
              stored,
            )
          }),
      )
      break
    } catch (error) {
      if (error instanceof ChatMetadataLinkPlanChangedError) continue
      throw error
    }
  }
  const chatVersions: Record<ChatId, ChatVersions> = {}
  for (const chat of changedChats) {
    chatVersions[chat.id] = {
      metaVersion: chat.metaVersion,
      summaryVersion: chat.summaryVersion,
      structuralVersion: chat.structuralVersion,
    }
  }
  return {
    value: { globalChanged, chatCount },
    affectedChatIds: changedChats.map((chat) => chat.id),
    chatVersions,
  }
}

export async function deleteArchivedChatRows(
  db: NatterDb,
  chatIds: readonly ChatId[],
  now: number,
  commit: BrowserCommandSessionPort,
): Promise<DeleteArchivedChatMetadataResult> {
  const result = await deleteArchivedChats(db, chatIds, now, commit)
  return {
    deletedChatIds: result.deletedChatIds,
    affectedAttachmentIds: result.affectedAttachmentIds,
  }
}

export async function emptyArchivedChatRows(
  db: NatterDb,
  input: { afterChatId?: ChatId; limit: number; now: number },
  commit: BrowserCommandSessionPort,
) {
  const limit = Math.min(boundedMaintenanceLimit(input.limit), CHAT_CLOSURE_BATCH_LIMIT)
  const page = await readArchivedChatIdPage(db, {
    ...(input.afterChatId === undefined ? {} : { afterChatId: input.afterChatId }),
    limit,
  })
  const result = await deleteArchivedChats(db, page.chatIds, input.now, commit)
  return {
    deletedChatIds: result.deletedChatIds,
    affectedAttachmentIds: result.affectedAttachmentIds,
    scannedChatIds: page.chatIds.length,
    ...(page.nextAfterChatId === undefined ? {} : { nextAfterChatId: page.nextAfterChatId }),
    done: page.done,
  }
}

async function deleteArchivedChats(
  db: NatterDb,
  chatIds: readonly ChatId[],
  now: number,
  commit: BrowserCommandSessionPort,
): Promise<DeleteArchivedChatsResult> {
  const uniqueChatIds = [...new Set(chatIds)]
  if (uniqueChatIds.length > CHAT_CLOSURE_BATCH_LIMIT) {
    throw new Error('ChatClosureBatchLimitExceeded')
  }
  if (uniqueChatIds.length === 0) {
    return { deletedChatIds: [], deletedChats: [], affectedAttachmentIds: [] }
  }
  for (;;) {
    const snapshots = await archivedDeleteSnapshots(db, uniqueChatIds)
    if (snapshots.length === 0) {
      return { deletedChatIds: [], deletedChats: [], affectedAttachmentIds: [] }
    }
    const scopes: MutationScope[] = []
    const attachmentScopeIds = new Set<AttachmentId>()
    for (const snapshot of snapshots) {
      scopes.push({ kind: 'chat-meta', chatId: snapshot.chatId })
      scopes.push({ kind: 'draft', chatId: snapshot.chatId })
      for (const messageId of snapshot.messageIds) {
        scopes.push({ kind: 'message', messageId })
      }
      for (const attachmentId of snapshot.attachmentIds) {
        if (attachmentScopeIds.has(attachmentId)) continue
        attachmentScopeIds.add(attachmentId)
        scopes.push({ kind: 'attachment', attachmentId })
      }
    }

    let result: DeleteArchivedChatsResult = {
      deletedChatIds: [],
      deletedChats: [],
      affectedAttachmentIds: [],
    }
    try {
      await commit.withLocks(
        [
          'chat-catalog',
          'tag-catalog',
          ...snapshots.flatMap((snapshot) => snapshot.configurationResourceNames),
          ...scopes.map(scopeResourceName),
          `setting:${GLOBAL_TOKEN_CALIBRATION_KEY}`,
        ],
        async (locked) =>
          locked.runTransaction(CHAT_CLOSURE_TRANSACTION, async (tx) => {
            const chats = tx.table<Chat, ChatId>('chats')
            const messages = tx.table<MessageHeaderRow, MessageId>('messages')
            const edges = tx.table<AttachmentReferenceEdge>('attachmentRefEdges')
            const validatedChatIds: ChatId[] = []
            for (const snapshot of snapshots) {
              const chat = await chats.get(snapshot.chatId)
              if (!chat?.archived) continue
              if (
                !sameOrderedValues(
                  snapshot.configurationResourceNames,
                  normalizeNamedLocks(chatConfigurationTargetResourceNames(chat)),
                )
              ) {
                throw new ChatClosurePlanChangedError()
              }
              const [messageRows, edgeRows] = await Promise.all([
                messages.where('chatId').equals(snapshot.chatId).toArray(),
                edges.where('chatId').equals(snapshot.chatId).toArray(),
              ])
              if (!sameArchivedDeleteSnapshot(snapshot, messageRows, edgeRows)) {
                throw new ChatClosurePlanChangedError()
              }
              validatedChatIds.push(snapshot.chatId)
            }
            const closure = await deleteChatClosure(tx, validatedChatIds, now)
            result = {
              deletedChatIds: [...closure.deletedChatIds],
              deletedChats: [...closure.deletedChats],
              affectedAttachmentIds: [...closure.affectedAttachmentIds],
            }
          }),
      )
    } catch (error) {
      if (error instanceof ChatClosurePlanChangedError) continue
      throw error
    }

    return result
  }
}

export async function createFolder(
  input: CreateFolderInput,
  commit: BrowserCommandSessionPort,
): Promise<ChatFolder> {
  const now = input.now ?? Date.now()
  const folder: ChatFolder = {
    id: input.id ?? newId(),
    name: normalizeName(input.name, 'Folder'),
    sortIndex: input.sortIndex ?? now,
    createdAt: now,
    updatedAt: now,
  }
  if (input.color) folder.color = input.color

  await commit.withLocks(['folder-catalog', `folder:${folder.id}`], (locked) =>
    locked.runTransaction(FOLDER_TRANSACTION, async (tx) => {
      const table = tx.table<ChatFolder, FolderId>('folders')
      await putChatFolderByteOwner(tx, folder, await table.get(folder.id))
    }),
  )
  return folder
}

export async function updateFolder(
  folderId: FolderId,
  patch: UpdateFolderInput,
  commit: BrowserCommandSessionPort,
): Promise<ChatFolder | undefined> {
  const now = patch.now ?? Date.now()
  let next: ChatFolder | undefined
  const result = { changed: false }
  await commit.withLocks(['folder-catalog', `folder:${folderId}`], (locked) =>
    locked.runTransaction(FOLDER_TRANSACTION, async (tx) => {
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
      result.changed = true
      await putChatFolderByteOwner(tx, next, current)
    }),
  )
  return next
}

export async function ensureFolderAndMoveChats(
  db: NatterDb,
  input: EnsureFolderAndMoveChatsInput,
  commit: BrowserCommandSessionPort,
): Promise<EnsureFolderAndMoveChatsResult> {
  const now = input.now ?? Date.now()
  const name = normalizeName(input.name, 'Folder')
  const nameKey = organizationNameKey(name)
  const uniqueChatIds = [...new Set(input.chatIds)].sort()
  const createdFolderId = input.id ?? newId()
  for (;;) {
    const plan = await db.transaction('r', [db.folders, db.chats], async (tx) => {
      const folders = await tx.table<ChatFolder, FolderId>('folders').toArray()
      const target = sortChatFolders(folders).find(
        (folder) => organizationNameKey(folder.name) === nameKey,
      )
      const chats = await tx.table<Chat, ChatId>('chats').bulkGet(uniqueChatIds)
      const targetId = target?.id ?? createdFolderId
      return {
        targetId,
        targetExisted: target !== undefined,
        folderLocks: normalizeNamedLocks([
          `folder:${targetId}`,
          ...chats.flatMap((chat) => (chat?.folderId ? [`folder:${chat.folderId}`] : [])),
        ]),
      }
    })
    try {
      return await commit.withLocks(
        [
          'folder-catalog',
          ...plan.folderLocks,
          ...uniqueChatIds.map((chatId) => `chat-meta:${chatId}`),
        ],
        (locked) =>
          locked.runTransaction(CHAT_FOLDER_TRANSACTION, async (tx) => {
            const folders = tx.table<ChatFolder, FolderId>('folders')
            const allFolders = await folders.toArray()
            const matched = sortChatFolders(allFolders).find(
              (folder) => organizationNameKey(folder.name) === nameKey,
            )
            if (
              matched?.id !== (plan.targetExisted ? plan.targetId : undefined) ||
              (!plan.targetExisted && matched !== undefined)
            ) {
              throw new ChatMetadataLinkPlanChangedError()
            }
            if (!matched && (await folders.get(plan.targetId))) {
              throw new Error(`FolderIdAlreadyExists:${plan.targetId}`)
            }
            const chats = tx.table<Chat, ChatId>('chats')
            const rows = await chats.bulkGet(uniqueChatIds)
            const currentFolderLocks = normalizeNamedLocks([
              `folder:${plan.targetId}`,
              ...rows.flatMap((chat) => (chat?.folderId ? [`folder:${chat.folderId}`] : [])),
            ])
            if (!sameOrderedValues(plan.folderLocks, currentFolderLocks)) {
              throw new ChatMetadataLinkPlanChangedError()
            }
            let folder: ChatFolder = matched ?? {
              id: plan.targetId,
              name,
              sortIndex: input.sortIndex ?? now,
              createdAt: now,
              updatedAt: now,
              ...(input.color ? { color: input.color } : {}),
            }
            const created = matched === undefined
            const changes: EnsureFolderAndMoveChatsResult['changes'] = []
            const updatedAtClock = new TransactionChatUpdateClock()
            const writes: Array<{ previous: Chat; next: Chat }> = []
            for (const row of rows) {
              if (!row || (row.folderId ?? null) === folder.id) continue
              const next: Chat = {
                ...row,
                folderId: folder.id,
                updatedAt: await updatedAtClock.next(tx, now),
                metaVersion: row.metaVersion + 1,
                summaryVersion: row.summaryVersion + 1,
              }
              writes.push({ previous: row, next })
              changes.push({
                chatId: row.id,
                previousFolderId: row.folderId ?? null,
                nextFolderId: folder.id,
                previousArchived: row.archived,
                nextArchived: row.archived,
              })
            }
            await applyChatRowWriteTransitions(
              tx,
              writes.map(({ previous, next }) => ({
                kind: 'replace-preserving-links',
                previous,
                next,
              })),
            )
            const touchedFolder: ChatFolder = {
              ...folder,
              lastUsedAt: Math.max(folder.lastUsedAt ?? 0, now),
              updatedAt: Math.max(folder.updatedAt, now),
            }
            const folderChanged =
              created || stableStringify(folder) !== stableStringify(touchedFolder)
            if (folderChanged) {
              await putChatFolderByteOwner(tx, touchedFolder, matched)
              folder = touchedFolder
            }
            return {
              folder,
              created,
              affectedChatIds: changes.map((change) => change.chatId),
              changes,
            }
          }),
      )
    } catch (error) {
      if (error instanceof ChatMetadataLinkPlanChangedError) continue
      throw error
    }
  }
}

export async function deleteFolder(
  db: NatterDb,
  folderId: FolderId,
  chatDisposition: 'move-top-level' | 'archive',
  now: number,
  commit: BrowserCommandSessionPort,
): Promise<DeleteFolderResult> {
  const changedChats: Chat[] = []
  const changes: DeleteFolderResult['changes'] = []
  const result = { deleted: false }
  for (;;) {
    changedChats.length = 0
    changes.length = 0
    result.deleted = false
    const planned = await db.transaction(
      'r',
      [db.chats, db.configurationLinks],
      async (tx: Transaction) => {
        const chatIds = (
          await tx.table<Chat, ChatId>('chats').where('folderId').equals(folderId).primaryKeys()
        ).sort()
        if (chatDisposition !== 'archive' || chatIds.length === 0) {
          return { chatIds, usageResources: [] as readonly string[] }
        }
        const links = await tx
          .table<ConfigurationLink, string>('configurationLinks')
          .where('ownerKey')
          .anyOf(chatIds.map((chatId) => configurationOwnerKey('chat', chatId)))
          .toArray()
        return {
          chatIds,
          usageResources: configurationProfileUsageResourceNamesForLinks(links),
        }
      },
    )
    const plannedChatIds = planned.chatIds
    try {
      await commit.withLocks(
        [
          'folder-catalog',
          `folder:${folderId}`,
          ...plannedChatIds.map((chatId) => `chat-meta:${chatId}`),
          ...planned.usageResources,
        ],
        (locked) =>
          locked.runTransaction(
            chatDisposition === 'archive' ? CHAT_FOLDER_LINK_TRANSACTION : CHAT_FOLDER_TRANSACTION,
            async (tx) => {
              const folders = tx.table<ChatFolder, FolderId>('folders')
              const folder = await folders.get(folderId)
              if (!folder) return
              const chats = tx.table<Chat, ChatId>('chats')
              const currentChatIds = (
                await chats.where('folderId').equals(folderId).primaryKeys()
              ).sort()
              if (!sameOrderedValues(plannedChatIds, currentChatIds)) {
                throw new ChatMetadataLinkPlanChangedError()
              }
              const rows = (await chats.bulkGet(currentChatIds)).filter(
                (chat): chat is Chat => chat !== undefined,
              )
              if (chatDisposition === 'archive') {
                const currentUsageResources = normalizeNamedLocks(
                  rows.flatMap((chat) =>
                    configurationProfileUsageResourceNamesForLinks(configurationLinksForChat(chat)),
                  ),
                )
                if (!sameOrderedValues(planned.usageResources, currentUsageResources)) {
                  throw new ChatMetadataLinkPlanChangedError()
                }
              }
              await deleteChatFolderByteOwner(tx, folder)
              result.deleted = true
              const updatedAtClock = new TransactionChatUpdateClock()
              const writes: Array<{ previous: Chat; next: Chat }> = []
              for (const row of rows) {
                const archived = chatDisposition === 'archive' ? true : row.archived
                const next: Chat = {
                  ...row,
                  folderId: null,
                  archived,
                  updatedAt: await updatedAtClock.next(tx, now),
                  metaVersion: row.metaVersion + 1,
                  summaryVersion: row.summaryVersion + 1,
                }
                writes.push({ previous: row, next })
                changedChats.push(next)
                changes.push({
                  chatId: row.id,
                  previousFolderId: row.folderId,
                  nextFolderId: null,
                  previousArchived: row.archived,
                  nextArchived: archived,
                })
              }
              await applyChatRowWriteTransitions(
                tx,
                writes.map(({ previous, next }) => ({
                  kind:
                    chatDisposition === 'archive'
                      ? ('replace-linked' as const)
                      : ('replace-preserving-links' as const),
                  previous,
                  next,
                })),
              )
            },
          ),
      )
      break
    } catch (error) {
      if (error instanceof ChatMetadataLinkPlanChangedError) continue
      throw error
    }
  }
  return {
    deleted: result.deleted,
    affectedChatIds: changedChats.map((chat) => chat.id),
    changes: [...changes],
  }
}
