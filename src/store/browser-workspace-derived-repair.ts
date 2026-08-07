import Dexie, { type IndexableType, type Table, type Transaction } from 'dexie'
import { childListKey } from '../core/child-list-state'
import type { Chat, ChatId, ChildListState, ChildSlotMember, MessageId } from '../core/types'
import type { MessageHeaderRow } from './message-storage'
import { physicalStorageTables } from './physical-storage-tables'

const REBUILD_PAGE_ROWS = 64
const MESSAGE_TREE_INDEX = '[chatId+treeParentKey+siblingIndex+id]'

export const CHILD_SLOT_DERIVED_REPAIR_TRANSACTION_CAPABILITY = physicalStorageTables(
  'chats',
  'messages',
  'childLists',
  'childSlotMembers',
)

export const MESSAGE_PREVIEW_DERIVED_REPAIR_TRANSACTION_CAPABILITY = physicalStorageTables(
  'messages',
  'messageBodies',
  'messagePreviews',
)

export async function rebuildChildSlotDerivedState(
  tx: Transaction,
  options: {
    readonly rebuiltAt?: number
    readonly checkpoint?: () => void
  } = {},
): Promise<void> {
  const checkpoint = options.checkpoint ?? (() => undefined)
  const chats = tx.table<Chat, ChatId>('chats')
  const messages = tx.table<MessageHeaderRow, MessageId>('messages')
  const states = tx.table<ChildListState, string>('childLists')
  const members = tx.table<ChildSlotMember, MessageId>('childSlotMembers')
  await Dexie.Promise.all([states.clear(), members.clear()])
  await forEachPrimaryPage(chats, async (page) => {
    checkpoint()
    await states.bulkPut(
      page.map((chat) => ({
        id: childListKey(chat.id, null),
        chatId: chat.id,
        parentId: null,
        version: 0,
        updatedAt: chat.updatedAt,
        liveCount: 0,
        firstLiveChildId: null,
        lastLiveChildId: null,
        nextSiblingIndex: 0,
      })),
    )
  })

  const rebuiltAt = options.rebuiltAt ?? Date.now()
  let slotKey: string | null = null
  let slotChatId: ChatId | null = null
  let slotParentId: MessageId | null = null
  let slotLiveCount = 0
  let slotNextSiblingIndex = 0
  let slotFirstId: MessageId | null = null
  let slotLastId: MessageId | null = null
  let pendingMember: ChildSlotMember | null = null
  const stateBuffer: ChildListState[] = []
  const memberBuffer: ChildSlotMember[] = []
  const drainStateBuffer = async (): Promise<void> => {
    if (stateBuffer.length < REBUILD_PAGE_ROWS) return
    await states.bulkPut(stateBuffer.splice(0))
  }
  const drainMemberBuffer = async (): Promise<void> => {
    if (memberBuffer.length < REBUILD_PAGE_ROWS) return
    await members.bulkPut(memberBuffer.splice(0))
  }
  const flushMember = async (nextMessageId: MessageId | null): Promise<void> => {
    if (!pendingMember) return
    memberBuffer.push({ ...pendingMember, nextMessageId })
    pendingMember = null
    await drainMemberBuffer()
  }
  const flushSlot = async (): Promise<void> => {
    if (slotKey === null || slotChatId === null) return
    await flushMember(null)
    stateBuffer.push({
      id: slotKey,
      chatId: slotChatId,
      parentId: slotParentId,
      version: 0,
      updatedAt: rebuiltAt,
      liveCount: slotLiveCount,
      firstLiveChildId: slotFirstId,
      lastLiveChildId: slotLastId,
      nextSiblingIndex: slotNextSiblingIndex,
    })
    await drainStateBuffer()
  }

  let after: IndexableType | undefined
  for (;;) {
    checkpoint()
    const rows: MessageHeaderRow[] = []
    let lastKey: IndexableType | undefined
    const collection =
      after === undefined
        ? messages.orderBy(MESSAGE_TREE_INDEX)
        : messages.where(MESSAGE_TREE_INDEX).above(after)
    await collection.limit(REBUILD_PAGE_ROWS).each((row, cursor) => {
      rows.push(row)
      lastKey = cursor.key
    })
    if (rows.length === 0) break
    for (const row of rows) {
      const currentSlotKey = childListKey(row.chatId, row.parentId)
      if (slotKey !== currentSlotKey) {
        await flushSlot()
        slotKey = currentSlotKey
        slotChatId = row.chatId
        slotParentId = row.parentId
        slotLiveCount = 0
        slotNextSiblingIndex = 0
        slotFirstId = null
        slotLastId = null
        pendingMember = null
      }
      slotNextSiblingIndex = Math.max(slotNextSiblingIndex, row.siblingIndex + 1)
      if (row.deleted) continue
      const member: ChildSlotMember = {
        id: row.id,
        chatId: row.chatId,
        parentId: row.parentId,
        parentKey: currentSlotKey,
        position: slotLiveCount,
        previousMessageId: slotLastId,
        nextMessageId: null,
      }
      if (pendingMember) await flushMember(member.id)
      pendingMember = member
      slotFirstId ??= member.id
      slotLastId = member.id
      slotLiveCount += 1
    }
    if (rows.length < REBUILD_PAGE_ROWS) break
    if (lastKey === undefined) throw new Error('MessageTreeProjectionPrimaryKeyMissing')
    after = lastKey
  }
  await flushSlot()
  if (memberBuffer.length > 0) await members.bulkPut(memberBuffer)
  if (stateBuffer.length > 0) await states.bulkPut(stateBuffer)
}

async function forEachPrimaryPage<Row, Key extends IndexableType>(
  table: Table<Row, Key>,
  visit: (rows: readonly Row[]) => Promise<void>,
): Promise<void> {
  let after: Key | undefined
  for (;;) {
    const rows: Row[] = []
    let lastPrimaryKey: Key | undefined
    const collection = after === undefined ? table.orderBy(':id') : table.where(':id').above(after)
    await collection.limit(REBUILD_PAGE_ROWS).each((row, cursor) => {
      rows.push(row)
      lastPrimaryKey = cursor.primaryKey
    })
    if (rows.length === 0) return
    await visit(rows)
    if (rows.length < REBUILD_PAGE_ROWS) return
    if (lastPrimaryKey === undefined) {
      throw new Error(`DerivedRepairPrimaryKeyMissing:${table.name}`)
    }
    after = lastPrimaryKey
  }
}
