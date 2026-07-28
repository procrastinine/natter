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
import { deleteAttachmentReferenceEdgesForChats } from './attachment-reference-edges'
import {
  deleteChatAuxiliaryByteOwners,
  deleteChatOwnedPhysicalStorageCollectionWithKnownBytes,
  deleteLinkedSemanticByteOwnerBatchRepairingLinks,
  deletePhysicalStorageCollection,
  putTokenCalibrationSettingByteOwner,
} from './byte-owner-mutation'
import { deleteChatSidebarProjections } from './chat-sidebar-projection'
import { CONFIGURATION_LINK_MUTATION_TRANSACTION_CAPABILITY } from './configuration-profile-usage-projection'
import type { SettingsRow } from './db-rows'
import { exactCompoundPrefixBetween } from './indexeddb-key-ranges'
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
  readonly retiredStreamFrames: number
  readonly streamJournalRetirementPending: boolean
}

export async function deleteEligibleEmptyDraftChatClosure(
  tx: ChatClosureTransaction,
  requestedChatIds: readonly ChatId[],
  staleBefore: number | undefined,
  now: number,
  options: { readonly maxStreamJournalPages?: number } = {},
): Promise<DeleteChatClosureResult> {
  const uniqueIds = [...new Set(requestedChatIds)]
  if (uniqueIds.length === 0) return emptyDeleteChatClosureResult()
  const rows = await tx.table<Chat, ChatId>('chats').bulkGet(uniqueIds)
  const candidates = rows.filter(
    (chat): chat is Chat => chat !== undefined && isEmptyMaterializedDraftChat(chat, staleBefore),
  )
  if (candidates.length === 0) return emptyDeleteChatClosureResult()
  const candidateIds = candidates.map((chat) => chat.id)
  const [messageChatIds, drafts, edgeChatIds] = await Promise.all([
    tx
      .table<MessageHeaderRow, MessageId>('messages')
      .where('chatId')
      .anyOf(candidateIds)
      .uniqueKeys() as Promise<ChatId[]>,
    tx.table<DraftRow, ChatId>('drafts').bulkGet(candidateIds),
    tx
      .table<AttachmentReferenceEdge>('attachmentRefEdges')
      .where('chatId')
      .anyOf(candidateIds)
      .uniqueKeys() as Promise<ChatId[]>,
  ])
  const messageChats = new Set(messageChatIds)
  const edgeChats = new Set(edgeChatIds)
  const eligible = candidates.filter(
    (chat, index) =>
      !messageChats.has(chat.id) && !edgeChats.has(chat.id) && isEmptyDraftRow(drafts[index]),
  )
  return deleteKnownChatClosure(
    tx,
    eligible,
    now,
    'skip',
    options.maxStreamJournalPages ?? Number.POSITIVE_INFINITY,
  )
}

export async function deleteArchivedChatClosure(
  tx: ChatClosureTransaction,
  requestedChatIds: readonly ChatId[],
  now: number,
): Promise<DeleteChatClosureResult> {
  const uniqueIds = [...new Set(requestedChatIds)]
  if (uniqueIds.length === 0) return emptyDeleteChatClosureResult()
  const rows = await tx.table<Chat, ChatId>('chats').bulkGet(uniqueIds)
  return deleteKnownChatClosure(
    tx,
    rows.filter((chat): chat is Chat => chat?.archived === true),
    now,
    'reject',
  )
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
  const chats = (await tx.table<Chat, ChatId>('chats').bulkGet(uniqueIds)).filter(
    (chat): chat is Chat => chat !== undefined,
  )
  return deleteKnownChatClosure(tx, chats, now, 'reject')
}

async function deleteKnownChatClosure(
  tx: ChatClosureTransaction,
  candidates: readonly Chat[],
  now: number,
  activeLeasePolicy: 'reject' | 'skip',
  maxStreamJournalPages = Number.POSITIVE_INFINITY,
): Promise<DeleteChatClosureResult> {
  if (candidates.length === 0) return emptyDeleteChatClosureResult()
  const candidateIds = candidates.map((chat) => chat.id)
  const activeLeases = await tx
    .table<StreamLeaseRow, string>('streamLeases')
    .where('chatId')
    .anyOf(candidateIds)
    .toArray()
  if (activeLeasePolicy === 'reject' && activeLeases.length > 0) {
    const activeLease = activeLeases[0] as StreamLeaseRow
    throw new ChatStreamBusyError(activeLease.chatId, activeLease.streamId)
  }
  const leasedChatIds = new Set(activeLeases.map((lease) => lease.chatId))
  const chats =
    activeLeasePolicy === 'skip'
      ? candidates.filter((chat) => !leasedChatIds.has(chat.id))
      : [...candidates]
  if (chats.length === 0) return emptyDeleteChatClosureResult()
  const deletedChatIds = chats.map((chat) => chat.id)
  let retiredStreamFrames = 0
  for (let page = 0; ; page += 1) {
    const retired = await retireStreamJournalOwnershipPage(tx, {
      kind: 'orphan-chat-closure',
      chatIds: deletedChatIds,
    })
    if (retired.result.outcome === 'ineligible') {
      throw new Error('OrphanStreamJournalLeasePresent')
    }
    retiredStreamFrames += retired.result.deletedFrames
    if (retired.result.done) break
    if (page + 1 >= maxStreamJournalPages) {
      return {
        ...emptyDeleteChatClosureResult(),
        retiredStreamFrames,
        streamJournalRetirementPending: true,
      }
    }
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
    retiredStreamFrames,
    streamJournalRetirementPending: false,
  }
}

function saturatingAdd(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right)
}

function emptyDeleteChatClosureResult(): DeleteChatClosureResult {
  return {
    deletedChatIds: [],
    deletedChats: [],
    affectedAttachmentIds: [],
    retiredStreamFrames: 0,
    streamJournalRetirementPending: false,
  }
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
