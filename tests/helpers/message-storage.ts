import { findLastUpdatedLeafId } from '../../src/core/active-path'
import { buildChildSlotProjection } from '../../src/core/child-list-state'
import type {
  ChatId,
  ChildListState,
  ChildSlotMember,
  Message,
  MessageId,
} from '../../src/core/types'
import { ATTACHMENT_CATALOG_MUTATION_TRANSACTION_CAPABILITY } from '../../src/store/attachment-catalog-projection'
import {
  reconcileAttachmentRefCountsForRepair,
  replaceAttachmentReferenceOwnersForRepair,
} from '../../src/store/attachment-reference-edges'
import { runBrowserCommandTransaction } from '../../src/store/browser-command-mutation-journal'
import {
  CHILD_SLOT_DERIVED_REPAIR_TRANSACTION_CAPABILITY,
  MESSAGE_PREVIEW_DERIVED_REPAIR_TRANSACTION_CAPABILITY,
} from '../../src/store/browser-workspace-derived-repair'
import {
  CHAT_ROW_PRESERVING_LINKS_TRANSACTION_CAPABILITY,
  openPreservingChatMutation,
} from '../../src/store/chat-row-transition'
import { getDb } from '../../src/store/db'
import {
  hydrateMessage,
  type MessageBodyRow,
  type MessageHeaderRow,
  previewTextFromMessages,
  splitMessageForStorage,
} from '../../src/store/message-storage'
import {
  assertPhysicalTransactionTablesDeclared,
  bindFencedTransaction,
  type CapabilityTables,
  type FencedTransaction,
  physicalTransactionPlan,
} from '../../src/store/physical-storage-tables'
import { registerPhysicalMutationTransaction } from '../../src/store/storage-compaction-state'
import { getWorkspaceRepository } from '../../src/store/workspace-repository'
import { runWorkspaceRead } from '../../src/store/workspace-runtime'

const TEST_MESSAGE_WRITE_PLAN = physicalTransactionPlan(
  ATTACHMENT_CATALOG_MUTATION_TRANSACTION_CAPABILITY,
  CHILD_SLOT_DERIVED_REPAIR_TRANSACTION_CAPABILITY,
  MESSAGE_PREVIEW_DERIVED_REPAIR_TRANSACTION_CAPABILITY,
  CHAT_ROW_PRESERVING_LINKS_TRANSACTION_CAPABILITY,
)

type TestMessageWriteTable =
  | CapabilityTables<typeof ATTACHMENT_CATALOG_MUTATION_TRANSACTION_CAPABILITY>
  | CapabilityTables<typeof CHILD_SLOT_DERIVED_REPAIR_TRANSACTION_CAPABILITY>
  | CapabilityTables<typeof MESSAGE_PREVIEW_DERIVED_REPAIR_TRANSACTION_CAPABILITY>
  | CapabilityTables<typeof CHAT_ROW_PRESERVING_LINKS_TRANSACTION_CAPABILITY>

type TestMessageWriteTransaction = FencedTransaction<TestMessageWriteTable>

export function testChildSlotsForHeaders(
  chatId: ChatId,
  headers: readonly MessageHeaderRow[],
): readonly ChildListState[] {
  return buildChildSlotProjection(chatId, headers, { updatedAt: 0 }).states
}

export async function putTestMessages(rows: readonly Message[]): Promise<void> {
  if (rows.length === 0) return
  const split = rows.map((row) => splitMessageForStorage(row))
  const db = getDb()
  await db.transaction(
    'rw',
    TEST_MESSAGE_WRITE_PLAN.tableNames.map((tableName) => db.table(tableName)),
    async (raw) => {
      registerPhysicalMutationTransaction(raw)
      const committed = await runBrowserCommandTransaction(raw, async (tracked) => {
        const tx = bindFencedTransaction(tracked, TEST_MESSAGE_WRITE_PLAN)
        await tx.table('messages').bulkPut(split.map((row) => row.header))
        await tx.table('messageBodies').bulkPut(split.map((row) => row.body))
        await tx.table('messagePreviews').bulkPut(split.map((row) => row.preview))
        const dirtyAttachmentIds = await replaceAttachmentReferenceOwnersForRepair(
          tx,
          rows.map((row) => ({
            ownerKind: 'message' as const,
            ownerId: row.id,
            chatId: row.chatId,
            refs: row.attachmentRefs,
          })),
        )
        await reconcileAttachmentRefCountsForRepair(tx, dirtyAttachmentIds, Date.now())
        const chatMutation = openPreservingChatMutation(tx)
        for (const chatId of new Set(rows.map((row) => row.chatId))) {
          const headers = await tx
            .table<MessageHeaderRow, MessageId>('messages')
            .where('chatId')
            .equals(chatId)
            .toArray()
          const projection = buildChildSlotProjection(chatId, headers, { updatedAt: Date.now() })
          const [previousStates, previousMembers] = await Promise.all([
            tx.table<ChildListState, string>('childLists').toArray(),
            tx.table<ChildSlotMember, string>('childSlotMembers').toArray(),
          ])
          await tx
            .table<ChildListState, string>('childLists')
            .bulkDelete(previousStates.filter((row) => row.chatId === chatId).map((row) => row.id))
          await tx
            .table<ChildSlotMember, string>('childSlotMembers')
            .bulkDelete(previousMembers.filter((row) => row.chatId === chatId).map((row) => row.id))
          await tx.table<ChildListState, string>('childLists').bulkPut([...projection.states])
          await tx
            .table<ChildSlotMember, string>('childSlotMembers')
            .bulkPut([...projection.members])
          const chat = await chatMutation.read(chatId)
          if (!chat) continue
          const messages = await readTestMessagesFromTransaction(tx, chatId, headers)
          const next = {
            ...chat,
            lastUpdatedLeafId: findLastUpdatedLeafId(messages),
            previewText: previewTextFromMessages(messages),
            wordCount: headers.reduce((sum, header) => sum + header.bodyWordCount, 0),
            totalCostUsd: messages.reduce(
              (sum, message) => sum + (message.deleted ? 0 : (message.generation?.cost ?? 0)),
              0,
            ),
          }
          chatMutation.replace(chatId, () => next)
        }
        await chatMutation.commit()
      })
      assertPhysicalTransactionTablesDeclared(TEST_MESSAGE_WRITE_PLAN, committed.facts.tableNames)
    },
  )
}

async function readTestMessagesFromTransaction(
  tx: TestMessageWriteTransaction,
  chatId: ChatId,
  headers: readonly MessageHeaderRow[],
): Promise<Message[]> {
  const bodies = await tx
    .table<MessageBodyRow, MessageId>('messageBodies')
    .bulkGet(headers.map((header) => header.id))
  return headers.flatMap((header, index) => {
    const body = bodies[index]
    if (!body || body.chatId !== chatId) return []
    return [hydrateMessage(header, body)]
  })
}

export function readTestMessageHeaders(
  messageIds: readonly MessageId[],
): Promise<Array<MessageHeaderRow | undefined>> {
  return getDb().messages.bulkGet([...messageIds])
}

export function readTestMessageHeader(messageId: MessageId): Promise<MessageHeaderRow | undefined> {
  return getDb().messages.get(messageId)
}

export function readTestMessages(chatId: ChatId): Promise<Message[]> {
  return runWorkspaceRead('repository-query', async (permit) => {
    const repository = getWorkspaceRepository()
    const topology = (
      await repository.query(
        permit,
        { kind: 'message.headers-by-chat', chatId },
        { signal: permit.signal },
      )
    ).value
    if (topology.kind === 'missing') return []
    if (topology.kind === 'stale') throw new Error(`TestConversationTopologyStale:${chatId}`)
    const headers = topology.headers
    const presentations = (
      await repository.query(
        permit,
        { kind: 'message.presentations', messageIds: headers.map((header) => header.id) },
        { signal: permit.signal },
      )
    ).value
    return presentations.flatMap((presentation) => (presentation ? [presentation.message] : []))
  })
}
