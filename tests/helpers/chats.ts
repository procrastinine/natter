import type { Transaction } from 'dexie'
import type { Chat, ChatId } from '../../src/core/types'
import { runBrowserCommandTransaction } from '../../src/store/browser-command-mutation-journal'
import {
  applyChatRowWriteTransitions,
  CHAT_ROW_LINKED_TRANSACTION_CAPABILITY,
} from '../../src/store/chat-row-transition'
import { readCurrentChatForTransaction } from '../../src/store/chat-storage-codec'
import { buildChat, type CreateChatInput } from '../../src/store/chats'
import { getDb } from '../../src/store/db'
import {
  assertPhysicalTransactionTablesDeclared,
  bindFencedTransaction,
  physicalTransactionPlan,
} from '../../src/store/physical-storage-tables'
import { registerPhysicalMutationTransaction } from '../../src/store/storage-compaction-state'

const TEST_CHAT_WRITE_PLAN = physicalTransactionPlan(CHAT_ROW_LINKED_TRANSACTION_CAPABILITY)

export async function createChat(input: CreateChatInput = {}): Promise<Chat> {
  const chat = buildChat(input)
  return putTestChat(chat)
}

export async function putTestChat(chat: Chat): Promise<Chat> {
  await putTestChats([chat])
  return structuredClone(chat)
}

export async function putTestChats(chats: readonly Chat[]): Promise<void> {
  if (chats.length === 0) return
  const rows = chats.map((chat) => structuredClone(chat))
  await runTestChatWrite(async (tx) => {
    await applyChatRowWriteTransitions(
      tx,
      rows.map((next) => ({ kind: 'add-linked', next })),
    )
  })
}

export async function updateChatForTest(chatId: ChatId, patch: Partial<Chat>): Promise<void> {
  await runTestChatWrite(async (tx) => {
    const current = await readCurrentChatForTransaction(tx, chatId)
    if (!current) throw new Error(`MissingTestChat:${chatId}`)
    await applyChatRowWriteTransitions(tx, [
      { kind: 'replace-linked', previous: current, next: { ...current, ...patch } },
    ])
  })
}

async function runTestChatWrite(operation: (tx: Transaction) => Promise<void>): Promise<void> {
  const db = getDb()
  await db.transaction(
    'rw',
    TEST_CHAT_WRITE_PLAN.tableNames.map((tableName) => db.table(tableName)),
    async (raw) => {
      registerPhysicalMutationTransaction(raw)
      const committed = await runBrowserCommandTransaction(raw, (tx) =>
        operation(bindFencedTransaction(tx, TEST_CHAT_WRITE_PLAN)),
      )
      assertPhysicalTransactionTablesDeclared(TEST_CHAT_WRITE_PLAN, committed.facts.tableNames)
    },
  )
}
