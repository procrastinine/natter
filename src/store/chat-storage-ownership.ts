import { childListKey } from '../core/child-list-state'
import {
  aggregateCalibrationSamples,
  GLOBAL_TOKEN_CALIBRATION_KEY,
  subtractCalibrationSamplesFromGlobalRecord,
} from '../core/token-calibration'
import type {
  AttachmentId,
  AttachmentReferenceEdge,
  Chat,
  ChatId,
  DraftRow,
  MessageId,
  TokenCalibrationSample,
} from '../core/types'
import { sameOrderedValues } from '../lib/same-value'
import { deleteAttachmentReferenceEdgesForChats } from './attachment-reference-edges'
import {
  deleteChatAuxiliaryByteOwners,
  deleteChatOwnedPhysicalStorageCollectionWithKnownBytes,
  deleteLinkedSemanticByteOwnerBatchRepairingLinks,
  deletePhysicalStorageCollection,
  putTokenCalibrationSettingByteOwner,
} from './byte-owner-mutation'
import { deleteChatSidebarProjections } from './chat-sidebar-projection'
import { chatConfigurationTargetResourceNames } from './configuration-domain-contract'
import { CONFIGURATION_LINK_MUTATION_TRANSACTION_CAPABILITY } from './configuration-profile-usage-projection'
import type { NatterDb } from './db'
import type { SettingsRow } from './db-rows'
import { exactCompoundPrefixBetween } from './indexeddb-key-ranges'
import { normalizeNamedLocks } from './locks'
import type { MessageHeaderRow } from './message-storage'
import {
  type CapabilityTables,
  type FencedTransaction,
  physicalStorageTables,
} from './physical-storage-tables'
import { ChatStreamBusyError, type StreamLeaseRow } from './repository'
import {
  estimateMessageBodyProjectionStorageBytes,
  estimateStoredValueBytes,
} from './storage-size-estimate'
import { retireStreamJournalOwnershipPage } from './stream-journal-storage'

export const CHAT_CLOSURE_BATCH_LIMIT = 32

export const CHAT_CLOSURE_TRANSACTION_CAPABILITY = physicalStorageTables(
  'attachmentCatalogAggregate',
  'attachmentCatalogRows',
  'attachmentRefEdges',
  'attachments',
  'chatSidebarAggregates',
  'chatSidebarRows',
  'chats',
  'childLists',
  'childSlotMembers',
  ...CONFIGURATION_LINK_MUTATION_TRANSACTION_CAPABILITY.tableNames,
  'drafts',
  'messageBodies',
  'messagePreviews',
  'messages',
  'settings',
  'streamChunks',
  'streamLeases',
)

type ChatClosureTransaction = FencedTransaction<
  CapabilityTables<typeof CHAT_CLOSURE_TRANSACTION_CAPABILITY>
>

export interface DeleteChatClosureResult {
  readonly deletedChatIds: readonly ChatId[]
  readonly deletedChats: readonly Chat[]
  readonly affectedAttachmentIds: readonly AttachmentId[]
}

export interface EmptyDraftChatClosurePlanEntry {
  readonly chatId: ChatId
  readonly configurationResourceNames: readonly string[]
}

export class ChatClosurePlanChangedError extends Error {}

export async function planEmptyDraftChatClosure(
  db: NatterDb,
  chatIds: readonly ChatId[],
  staleBefore: number | undefined,
): Promise<readonly EmptyDraftChatClosurePlanEntry[]> {
  const rows = await db.chats.bulkGet([...new Set(chatIds)])
  return rows.flatMap((chat) => {
    if (!chat || !isEmptyMaterializedDraftChat(chat, staleBefore)) return []
    return [
      {
        chatId: chat.id,
        configurationResourceNames: normalizeNamedLocks(chatConfigurationTargetResourceNames(chat)),
      },
    ]
  })
}

export function emptyDraftChatClosureLockNames(
  plan: readonly EmptyDraftChatClosurePlanEntry[],
  extra: readonly string[] = [],
): string[] {
  return normalizeNamedLocks([
    'chat-catalog',
    'tag-catalog',
    `setting:${GLOBAL_TOKEN_CALIBRATION_KEY}`,
    ...extra,
    ...plan.flatMap((entry) => [
      `chat-meta:${entry.chatId}`,
      `draft:${entry.chatId}`,
      ...entry.configurationResourceNames,
    ]),
  ])
}

export async function deletePlannedEmptyDraftChats(
  tx: ChatClosureTransaction,
  plan: readonly EmptyDraftChatClosurePlanEntry[],
  staleBefore: number | undefined,
  now: number,
): Promise<DeleteChatClosureResult> {
  const chats = tx.table<Chat, ChatId>('chats')
  const messages = tx.table<MessageHeaderRow, MessageId>('messages')
  const drafts = tx.table<DraftRow, ChatId>('drafts')
  const streams = tx.table<StreamLeaseRow, string>('streamLeases')
  const edges = tx.table<AttachmentReferenceEdge>('attachmentRefEdges')
  const eligible: ChatId[] = []
  for (const entry of plan) {
    const chat = await chats.get(entry.chatId)
    if (!chat || !isEmptyMaterializedDraftChat(chat, staleBefore)) continue
    if (
      !sameOrderedValues(
        entry.configurationResourceNames,
        normalizeNamedLocks(chatConfigurationTargetResourceNames(chat)),
      )
    ) {
      throw new ChatClosurePlanChangedError()
    }
    const [message, draft, stream, edge] = await Promise.all([
      messages.where('chatId').equals(entry.chatId).first(),
      drafts.get(entry.chatId),
      streams.where('chatId').equals(entry.chatId).first(),
      edges.where('chatId').equals(entry.chatId).first(),
    ])
    if (message || !isEmptyDraftRow(draft) || stream || edge) continue
    eligible.push(entry.chatId)
  }
  return deleteChatClosure(tx, eligible, now)
}

function isEmptyDraftRow(draft: DraftRow | undefined): boolean {
  return (
    draft === undefined || (draft.text.trim().length === 0 && draft.attachmentRefs.length === 0)
  )
}

function isEmptyMaterializedDraftChat(chat: Chat, staleBefore: number | undefined): boolean {
  const hasCalibration = Object.keys(chat.tokenCalibration ?? {}).length > 0
  return (
    chat.temporary === true &&
    chat.lastUpdatedLeafId === null &&
    chat.wordCount === 0 &&
    chat.totalCostUsd === 0 &&
    !hasCalibration &&
    (staleBefore === undefined ||
      Math.max(chat.createdAt, chat.updatedAt, chat.lastViewedAt) < staleBefore)
  )
}

export async function deleteChatClosure(
  tx: ChatClosureTransaction,
  requestedChatIds: readonly ChatId[],
  now: number,
): Promise<DeleteChatClosureResult> {
  const uniqueIds = [...new Set(requestedChatIds)]
  if (uniqueIds.length === 0) return emptyDeleteChatClosureResult()
  const chatTable = tx.table<Chat, ChatId>('chats')
  const chats = (await chatTable.bulkGet(uniqueIds)).filter(
    (chat): chat is Chat => chat !== undefined,
  )
  if (chats.length === 0) return emptyDeleteChatClosureResult()
  const deletedChatIds = chats.map((chat) => chat.id)
  for (const chatId of deletedChatIds) {
    const activeLease = await tx
      .table<StreamLeaseRow, string>('streamLeases')
      .where('[chatId+streamId]')
      .between(...exactCompoundPrefixBetween([chatId]))
      .first()
    if (activeLease) throw new ChatStreamBusyError(chatId, activeLease.streamId)
  }

  const affectedAttachmentIds = await deleteAttachmentReferenceEdgesForChats(
    tx,
    deletedChatIds,
    now,
  )
  let messageBodyProjectionBytes = 0
  let messageHeaderBytes = 0
  const messageCollection = tx
    .table<MessageHeaderRow, string>('messages')
    .where('chatId')
    .anyOf(deletedChatIds)
  await messageCollection.each((header) => {
    messageBodyProjectionBytes = saturatingAdd(
      messageBodyProjectionBytes,
      estimateMessageBodyProjectionStorageBytes(header),
    )
    messageHeaderBytes = saturatingAdd(messageHeaderBytes, estimateStoredValueBytes(header))
  })
  await Promise.all([
    deleteChatOwnedPhysicalStorageCollectionWithKnownBytes<MessageHeaderRow, string>(
      tx,
      'messages',
      deletedChatIds,
      messageHeaderBytes,
    ),
    deletePhysicalStorageCollection(
      tx,
      'messagePreviews',
      tx.table('messagePreviews').where('chatId').anyOf(deletedChatIds),
    ),
  ])
  await deleteLinkedSemanticByteOwnerBatchRepairingLinks(tx, 'chats', deletedChatIds, chats)
  for (;;) {
    const retired = await retireStreamJournalOwnershipPage(tx, {
      kind: 'orphan-chat-closure',
      chatIds: deletedChatIds,
    })
    if (retired.outcome === 'ineligible') {
      throw new Error('OrphanStreamJournalLeasePresent')
    }
    if (retired.done) break
  }
  await deleteChatAuxiliaryByteOwners(tx, { chatIds: deletedChatIds, messageBodyProjectionBytes })
  for (const chatId of deletedChatIds) {
    await Promise.all([
      deletePhysicalStorageCollection(
        tx,
        'childLists',
        tx
          .table('childLists')
          .where('[chatId+parentId]')
          .between(...exactCompoundPrefixBetween([chatId])),
      ),
      deletePhysicalStorageCollection(
        tx,
        'childLists',
        tx.table('childLists').where(':id').equals(childListKey(chatId, null)),
      ),
      deletePhysicalStorageCollection(
        tx,
        'childSlotMembers',
        tx
          .table('childSlotMembers')
          .where('[chatId+parentKey+position]')
          .between(...exactCompoundPrefixBetween([chatId])),
      ),
    ])
  }
  await deleteChatSidebarProjections(tx, chats)
  const removedCalibration = combinedCalibrationSamples(chats)
  if (Object.keys(removedCalibration).length > 0) {
    const settings = tx.table<SettingsRow, string>('settings')
    const global = await settings.get(GLOBAL_TOKEN_CALIBRATION_KEY)
    await putTokenCalibrationSettingByteOwner(
      tx,
      {
        key: GLOBAL_TOKEN_CALIBRATION_KEY,
        value: subtractCalibrationSamplesFromGlobalRecord(global?.value, removedCalibration, now),
      },
      global,
    )
  }
  return {
    deletedChatIds,
    deletedChats: chats.map((chat) => structuredClone(chat)),
    affectedAttachmentIds,
  }
}

function saturatingAdd(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right)
}

function emptyDeleteChatClosureResult(): DeleteChatClosureResult {
  return { deletedChatIds: [], deletedChats: [], affectedAttachmentIds: [] }
}

function combinedCalibrationSamples(
  chats: readonly Chat[],
): Record<string, TokenCalibrationSample> {
  const combined: Record<string, TokenCalibrationSample> = {}
  for (const chat of chats) {
    for (const [key, sample] of Object.entries(
      aggregateCalibrationSamples(chat.tokenCalibration),
    )) {
      const current = combined[key]
      if (!current) {
        combined[key] = { ...sample }
        continue
      }
      current.totalTextChars += sample.totalTextChars
      current.totalTextTokens += sample.totalTextTokens
      current.sampleCount += sample.sampleCount
      if (sample.updatedAt < current.updatedAt) continue
      current.updatedAt = sample.updatedAt
      if (sample.lastRatio === undefined) delete current.lastRatio
      else current.lastRatio = sample.lastRatio
    }
  }
  return combined
}
