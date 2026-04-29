// Phase 8.1 invariants: chat-fork, inline-editor plaintext round-trip,
// undo-snapshot, and the "branch = leaf selection" safety net.
//
// Focused on the new surface landed in 8.1 — the existing exhaustive
// coverage for editInPlace / regenerate / delete / insert / swipe lives
// in `tests/unit/messages.test.ts`.

import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  collectAncestorsToMessage,
  computeBranchTitle,
  forkChatFromMessage,
} from '../../src/core/chat-fork'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import { deletePair } from '../../src/core/messages'
import type { Chat, ChatId, Message, MessageId, MessageRole } from '../../src/core/types'
import { applyStructuralSnapshot, snapshotMessages } from '../../src/core/undo'
import { newId } from '../../src/lib/ulid'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import { loadChatMessages } from '../../src/store/chats'
import { __resetDbForTests, getDb, openDb } from '../../src/store/db'
import { splitMessageForStorage } from '../../src/store/message-storage'
import { plaintextOf, writeTextInto } from '../../src/ui/chat/InlineEditor'

const DB_NAME = 'natter'

async function resetAll() {
  __resetDbForTests()
  __resetBroadcastForTests()
  await Dexie.delete(DB_NAME)
}

beforeEach(async () => {
  await resetAll()
  await openDb()
})

afterEach(async () => {
  await resetAll()
})

async function seedChat(title = 'Source'): Promise<Chat> {
  const chat: Chat = {
    id: newId(),
    title,
    titleStatus: 'manual',
    createdAt: 100,
    updatedAt: 100,
    lastViewedAt: 100,
    wordCount: 0,
    totalCostUsd: 0,
    metaVersion: 0,
    summaryVersion: 0,
    settings: cloneDefaultChatSettings(),
    lastUpdatedLeafId: null,
    lastBranchUpdatedAt: 100,
    archived: false,
    pinned: false,
    folderId: null,
    tags: [],
  }
  await getDb().chats.put(chat)
  return chat
}

interface SeedMsg {
  id?: MessageId
  parentId?: MessageId | null
  siblingIndex?: number
  role?: MessageRole
  createdAt?: number
  text?: string
  deleted?: boolean
}

async function putMessage(chatId: ChatId, spec: SeedMsg = {}): Promise<Message> {
  const row: Message = {
    id: spec.id ?? newId(),
    chatId,
    parentId: spec.parentId ?? null,
    siblingIndex: spec.siblingIndex ?? 0,
    turnId: newId(),
    turnIndex: 0,
    createdAt: spec.createdAt ?? 1,
    role: spec.role ?? 'user',
    origin: 'user',
    content: [{ type: 'text', text: spec.text ?? 'x' }],
    nodeVersion: 0,
    deleted: spec.deleted ?? false,
  }
  const { header, body } = splitMessageForStorage(row)
  await getDb().messages.put(header)
  await getDb().messageBodies.put(body)
  return row
}

describe('computeBranchTitle', () => {
  it('starts at "Branch 1" on the first fork', () => {
    expect(computeBranchTitle('Design review', [])).toBe('Design review Branch 1')
  })
  it('uses "Untitled chat Branch 1" when the source has no title', () => {
    expect(computeBranchTitle('', [])).toBe('Untitled chat Branch 1')
    expect(computeBranchTitle('   ', [])).toBe('Untitled chat Branch 1')
  })
  it('skips taken branch numbers', () => {
    const existing = ['Design review', 'Design review Branch 1', 'Design review Branch 2']
    expect(computeBranchTitle('Design review', existing)).toBe('Design review Branch 3')
  })
  it('does not reuse "Branch 2" when "Branch 3" exists but 2 is free', () => {
    const existing = ['Notes', 'Notes Branch 3']
    expect(computeBranchTitle('Notes', existing)).toBe('Notes Branch 1')
  })
})

describe('collectAncestorsToMessage', () => {
  it('returns root→target in order, excluding siblings and descendants', async () => {
    const chat = await seedChat()
    await putMessage(chat.id, { id: 'R', createdAt: 1 })
    await putMessage(chat.id, {
      id: 'A',
      parentId: 'R',
      role: 'assistant',
      createdAt: 2,
    })
    await putMessage(chat.id, {
      id: 'A2',
      parentId: 'R',
      role: 'assistant',
      createdAt: 2,
      siblingIndex: 1,
    })
    await putMessage(chat.id, {
      id: 'U2',
      parentId: 'A',
      role: 'user',
      createdAt: 3,
    })
    await putMessage(chat.id, {
      id: 'A3',
      parentId: 'U2',
      role: 'assistant',
      createdAt: 4,
    })
    const rows = await loadChatMessages(chat.id)
    const ancestors = collectAncestorsToMessage(rows, 'U2')
    expect(ancestors.map((a) => a.id)).toEqual(['R', 'A', 'U2'])
  })
})

describe('forkChatFromMessage', () => {
  it('copies only the active-path ancestors into a fresh chat with a new title', async () => {
    const chat = await seedChat('Design review')
    await putMessage(chat.id, { id: 'R', text: 'root', createdAt: 1 })
    await putMessage(chat.id, {
      id: 'A',
      parentId: 'R',
      role: 'assistant',
      text: 'a',
      createdAt: 2,
    })
    await putMessage(chat.id, {
      id: 'A2',
      parentId: 'R',
      role: 'assistant',
      text: 'a2',
      createdAt: 2,
      siblingIndex: 1,
    })
    await putMessage(chat.id, {
      id: 'U2',
      parentId: 'A',
      role: 'user',
      text: 'u2',
      createdAt: 3,
    })
    const { chatId: forkId, messageCount } = await forkChatFromMessage({
      chatId: chat.id,
      messageId: 'A',
      title: 'Design review Branch 1',
      cursor: {},
    })
    expect(messageCount).toBe(2)
    const fork = await getDb().chats.get(forkId)
    expect(fork?.title).toBe('Design review Branch 1')
    expect(fork?.titleStatus).toBe('manual')
    const forkMessages = await loadChatMessages(forkId)
    expect(forkMessages).toHaveLength(2)
    const roles = forkMessages.sort((a, b) => a.createdAt - b.createdAt).map((m) => m.role)
    expect(roles).toEqual(['user', 'assistant'])
    // The sibling A2 and descendant U2 are NOT copied.
    for (const m of forkMessages) {
      expect(['root', 'a']).toContain((m.content[0] as { type: string; text: string }).text)
    }
    // Source chat is untouched.
    const sourceRows = await loadChatMessages(chat.id)
    expect(sourceRows).toHaveLength(4)
  })
})

describe('InlineEditor helpers', () => {
  it('plaintextOf concatenates text and output_text lanes, skipping other types', () => {
    expect(
      plaintextOf([
        { type: 'text', text: 'hello ' },
        { type: 'image_url', url: 'x' },
        { type: 'output_text', text: 'world' },
      ]),
    ).toBe('hello world')
  })
  it('writeTextInto replaces the first text item', () => {
    const next = writeTextInto(
      [
        { type: 'text', text: 'old' },
        { type: 'image_url', url: 'x' },
      ],
      'new',
    )
    expect(next[0]).toEqual({ type: 'text', text: 'new' })
    expect(next[1]).toEqual({ type: 'image_url', url: 'x' })
  })
  it('writeTextInto appends a text item when none existed', () => {
    const next = writeTextInto([{ type: 'image_url', url: 'x' }], 'new')
    expect(next).toHaveLength(2)
    expect(next.at(-1)).toEqual({ type: 'text', text: 'new' })
  })
})

describe('undo snapshot for structural deletes', () => {
  it('restores tombstoned rows so a delete-pair can be undone', async () => {
    const chat = await seedChat()
    const user = await putMessage(chat.id, {
      id: 'U',
      role: 'user',
      createdAt: 1,
    })
    const assistant = await putMessage(chat.id, {
      id: 'A',
      parentId: user.id,
      role: 'assistant',
      createdAt: 2,
    })
    const rowsBefore = await snapshotMessages(chat.id, [user.id, assistant.id])
    await deletePair({
      chatId: chat.id,
      messageId: assistant.id,
      cursor: {},
    })
    const afterDelete = await getDb().messages.where('chatId').equals(chat.id).toArray()
    expect(afterDelete.every((m) => m.deleted)).toBe(true)
    await applyStructuralSnapshot({
      chatId: chat.id,
      previousRows: rowsBefore,
      newMessageIds: [],
      attachmentIds: [],
    })
    const afterUndo = await getDb().messages.where('chatId').equals(chat.id).toArray()
    expect(afterUndo.find((m) => m.id === user.id)?.deleted).toBe(false)
    expect(afterUndo.find((m) => m.id === assistant.id)?.deleted).toBe(false)
  })
})
