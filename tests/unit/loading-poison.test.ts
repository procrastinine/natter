import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type { Message } from '../../src/core/types'
import {
  createChat,
  listChatSidebarRows,
  loadActiveBranchSnapshot,
  loadActiveBranchWindowSnapshot,
} from '../../src/store/chats'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import { __resetDbForTests, getDb, openDb } from '../../src/store/db'
import { splitMessageForStorage } from '../../src/store/message-storage'

const DB_NAME = 'natter'

async function resetAll(): Promise<void> {
  __resetBroadcastForTests()
  __resetDbForTests()
  vi.restoreAllMocks()
  await Dexie.delete(DB_NAME)
}

beforeEach(async () => {
  await resetAll()
  await openDb()
})

afterEach(async () => {
  await resetAll()
})

function message(chatId: string, id: string, overrides: Partial<Message> = {}): Message {
  return {
    id,
    chatId,
    parentId: null,
    siblingIndex: 0,
    turnId: id,
    turnIndex: 0,
    createdAt: 1,
    role: 'user',
    origin: 'user',
    content: [{ type: 'text', text: `body:${id}` }],
    nodeVersion: 0,
    deleted: false,
    ...overrides,
  }
}

async function putFullMessages(rows: readonly Message[]): Promise<void> {
  const split = rows.map((row) => splitMessageForStorage(row))
  const db = getDb()
  await db.messages.bulkPut(split.map((row) => row.header))
  await db.messageBodies.bulkPut(split.map((row) => row.body))
}

async function putHeaderOnly(row: Message): Promise<void> {
  await getDb().messages.put(splitMessageForStorage(row).header)
}

describe('loading poison boundaries', () => {
  it('keeps sidebar reads on chat metadata without touching messages or body rows', async () => {
    const chat = await createChat({
      id: 'sidebar-safe',
      title: 'Sidebar safe',
      settings: cloneDefaultChatSettings(),
      now: 10,
    })
    await getDb().chats.put({
      ...chat,
      titleStatus: 'manual',
      previewText: 'short preview',
      folderId: 'folder-1',
      tags: ['tag-a'],
      settings: { ...chat.settings, systemPrompt: 'large-setting-blob'.repeat(10_000) },
      tokenCalibration: {
        poison: {
          totalTextChars: 1,
          totalTextTokens: 1,
          sampleCount: 1,
          updatedAt: 1,
        },
      },
      favoriteModels: ['favorite-poison/'.repeat(5_000)],
      recentModels: ['recent-poison/'.repeat(5_000)],
    })
    await putHeaderOnly(message(chat.id, 'sidebar-message-poison'))

    const db = getDb()
    const messagesWhere = vi.spyOn(db.messages, 'where')
    const messagesToArray = vi.spyOn(db.messages, 'toArray')
    const bodiesGet = vi.spyOn(db.messageBodies, 'get')
    const bodiesBulkGet = vi.spyOn(db.messageBodies, 'bulkGet')
    const bodiesToArray = vi.spyOn(db.messageBodies, 'toArray')

    const rows = await listChatSidebarRows({ limit: 10 })

    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual(
      expect.objectContaining({
        id: chat.id,
        title: 'Sidebar safe',
        previewText: 'short preview',
        folderId: 'folder-1',
        tags: ['tag-a'],
      }),
    )
    expect('settings' in (rows[0] as Record<string, unknown>)).toBe(false)
    expect('tokenCalibration' in (rows[0] as Record<string, unknown>)).toBe(false)
    expect('favoriteModels' in (rows[0] as Record<string, unknown>)).toBe(false)
    expect('recentModels' in (rows[0] as Record<string, unknown>)).toBe(false)
    expect(messagesWhere).not.toHaveBeenCalled()
    expect(messagesToArray).not.toHaveBeenCalled()
    expect(bodiesGet).not.toHaveBeenCalled()
    expect(bodiesBulkGet).not.toHaveBeenCalled()
    expect(bodiesToArray).not.toHaveBeenCalled()
  })

  it('hydrates only active-branch bodies, not off-branch or other-chat poison rows', async () => {
    const active = await createChat({
      id: 'active-chat',
      title: 'Active',
      settings: cloneDefaultChatSettings(),
    })
    const other = await createChat({
      id: 'other-chat',
      title: 'Other',
      settings: cloneDefaultChatSettings(),
    })
    const root = message(active.id, 'branch-root', { createdAt: 1 })
    const activeLeaf = message(active.id, 'branch-active', {
      parentId: root.id,
      createdAt: 3,
    })
    const offBranch = message(active.id, 'off-branch-poison', {
      parentId: root.id,
      siblingIndex: 1,
      createdAt: 2,
      content: [{ type: 'text', text: 'OFF_BRANCH_BODY_MUST_NOT_LOAD' }],
    })
    const otherMessage = message(other.id, 'other-chat-poison', {
      content: [{ type: 'text', text: 'OTHER_CHAT_BODY_MUST_NOT_LOAD' }],
    })
    await putFullMessages([root, activeLeaf])
    await putHeaderOnly(offBranch)
    await putHeaderOnly(otherMessage)

    const bulkGet = vi.spyOn(getDb().messageBodies, 'bulkGet')

    const snapshot = await loadActiveBranchSnapshot(active.id, {})

    expect(snapshot.branch.map((row) => row.id)).toEqual(['branch-root', 'branch-active'])
    expect(bulkGet).toHaveBeenCalledTimes(1)
    expect(bulkGet.mock.calls[0]?.[0]).toEqual(['branch-root', 'branch-active'])
  })

  it('hydrates only the requested active-branch body window', async () => {
    const chat = await createChat({
      id: 'window-chat',
      title: 'Window',
      settings: cloneDefaultChatSettings(),
    })
    const w0 = message(chat.id, 'W0', { createdAt: 0 })
    const w1 = message(chat.id, 'W1', { parentId: 'W0', createdAt: 1 })
    const w2 = message(chat.id, 'W2', { parentId: 'W1', createdAt: 2 })
    const w3 = message(chat.id, 'W3', {
      parentId: 'W2',
      createdAt: 3,
      content: [{ type: 'text', text: 'WINDOW_POISON_BODY_MUST_NOT_LOAD' }],
    })
    await putHeaderOnly(w0)
    await putFullMessages([w1, w2])
    await putHeaderOnly(w3)

    const bulkGet = vi.spyOn(getDb().messageBodies, 'bulkGet')

    const snapshot = await loadActiveBranchWindowSnapshot(chat.id, {}, { offset: 1, limit: 2 })

    expect(snapshot.branchHeaders.map((row) => row.id)).toEqual(['W0', 'W1', 'W2', 'W3'])
    expect(snapshot.branchWindow.map((row) => row.id)).toEqual(['W1', 'W2'])
    expect(snapshot.branchLength).toBe(4)
    expect(bulkGet).toHaveBeenCalledTimes(1)
    expect(bulkGet.mock.calls[0]?.[0]).toEqual(['W1', 'W2'])
  })
})
