import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type { Chat, Message } from '../../src/core/types'
import { newId } from '../../src/lib/ulid'
import {
  buildAttachment,
  countLiveRefs,
  decRefs,
  diffAttachmentRefs,
  incRefs,
  putAttachment,
  reapOrphanedAttachments,
  sha256Hex,
} from '../../src/store/attachments'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import {
  __resetBrowserRepositoryForTests,
  getBrowserRepository,
} from '../../src/store/browser-repo'
import { __resetDbForTests, getDb, openDb } from '../../src/store/db'

const DB_NAME = 'natter'

async function resetAll() {
  __resetBrowserRepositoryForTests()
  __resetDbForTests()
  __resetBroadcastForTests()
  await Dexie.delete(DB_NAME)
}

beforeEach(async () => {
  await resetAll()
})

afterEach(async () => {
  await resetAll()
})

async function seedChat(id = newId()): Promise<Chat> {
  const db = await openDb()
  const chat: Chat = {
    id,
    title: 'T',
    titleStatus: 'untitled',
    createdAt: 1,
    updatedAt: 1,
    lastViewedAt: 1,
    wordCount: 0,
    totalCostUsd: 0,
    metaVersion: 0,
    summaryVersion: 0,
    settings: cloneDefaultChatSettings(),
    lastUpdatedLeafId: null,
    lastBranchUpdatedAt: 1,
    archived: false,
    pinned: false,
    folderId: null,
    tags: [],
  }
  await db.chats.put(chat)
  return chat
}

function bytes(content: string): Blob {
  return new Blob([new TextEncoder().encode(content)])
}

function makeMessage(chatId: string, attachmentRefs?: string[]): Message {
  const row: Message = {
    id: newId(),
    chatId,
    parentId: null,
    siblingIndex: 0,
    turnId: newId(),
    turnIndex: 0,
    createdAt: Date.now(),
    role: 'user',
    origin: 'user',
    content: [{ type: 'text', text: 'see file' }],
    nodeVersion: 0,
    deleted: false,
  }
  if (attachmentRefs && attachmentRefs.length > 0) row.attachmentRefs = [...attachmentRefs]
  return row
}

describe('sha256Hex', () => {
  it('is deterministic for identical byte content', async () => {
    const a = await sha256Hex(bytes('hello'))
    const b = await sha256Hex(bytes('hello'))
    expect(a).toBe(b)
  })

  it('matches the known SHA-256 of "hello"', async () => {
    const digest = await sha256Hex(bytes('hello'))
    expect(digest).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
  })
})

describe('buildAttachment', () => {
  it('assigns a ULID id, hashes the blob, and starts at refCount 0', async () => {
    const attachment = await buildAttachment({
      blob: bytes('img'),
      filename: 'a.png',
      mime: 'image/png',
      kind: 'image',
    })
    expect(attachment.id).toHaveLength(26)
    expect(attachment.refCount).toBe(0)
    expect(attachment.contentHash).toHaveLength(64)
  })
})

describe('attachment refcounts under repository mutations', () => {
  it('incRefs and decRefs move refCount by one per call', async () => {
    const repo = getBrowserRepository()
    const chat = await seedChat()
    const attachment = await buildAttachment({
      blob: bytes('x'),
      filename: 'x.bin',
      mime: 'application/octet-stream',
      kind: 'file',
    })
    await putAttachment(attachment)

    await repo.runMutation([{ kind: 'attachment', attachmentId: attachment.id }], async (ctx) => {
      await incRefs(ctx, [attachment.id])
    })
    expect((await getDb().attachments.get(attachment.id))?.refCount).toBe(1)

    await repo.runMutation([{ kind: 'attachment', attachmentId: attachment.id }], async (ctx) => {
      await decRefs(ctx, [attachment.id, attachment.id])
    })
    expect((await getDb().attachments.get(attachment.id))?.refCount).toBe(0)
    expect(chat.id).toBeTruthy()
  })

  it('tracks refcount across message write, edit, and hard delete', async () => {
    const repo = getBrowserRepository()
    const chat = await seedChat()
    const attachment = await buildAttachment({
      blob: bytes('x'),
      filename: 'x.bin',
      mime: 'application/octet-stream',
      kind: 'file',
    })
    await putAttachment(attachment)
    const message = makeMessage(chat.id, [attachment.id])

    await repo.runMutation(
      [
        { kind: 'message', messageId: message.id },
        { kind: 'children', chatId: chat.id, parentId: null },
        { kind: 'attachment', attachmentId: attachment.id },
      ],
      async (ctx) => {
        await ctx.putMessage(message)
        await incRefs(ctx, [attachment.id])
      },
    )
    expect((await getDb().attachments.get(attachment.id))?.refCount).toBe(1)

    await repo.runMutation(
      [
        { kind: 'message', messageId: message.id },
        { kind: 'attachment', attachmentId: attachment.id },
      ],
      async (ctx) => {
        const current = (await ctx.getMessage(message.id)) as Message
        await ctx.putMessage({
          ...current,
          content: [{ type: 'text', text: 'updated' }],
        })
      },
    )
    expect((await getDb().attachments.get(attachment.id))?.refCount).toBe(1)

    await repo.runMutation(
      [
        { kind: 'message', messageId: message.id },
        { kind: 'children', chatId: chat.id, parentId: null },
        { kind: 'attachment', attachmentId: attachment.id },
      ],
      async (ctx) => {
        await ctx.deleteMessage(message.id)
        await decRefs(ctx, [attachment.id])
      },
    )
    expect((await getDb().attachments.get(attachment.id))?.refCount).toBe(0)
  })
})

describe('reapOrphanedAttachments', () => {
  it('reaps only older refCount-zero attachments', async () => {
    const db = await openDb()
    const old = await buildAttachment({
      blob: bytes('old'),
      filename: 'o',
      mime: 'application/octet-stream',
      kind: 'file',
      createdAt: 1000,
    })
    const recent = await buildAttachment({
      blob: bytes('new'),
      filename: 'n',
      mime: 'application/octet-stream',
      kind: 'file',
      createdAt: 9000,
    })
    await putAttachment(old)
    await putAttachment(recent)

    const reaped = await reapOrphanedAttachments({ now: 10_000, olderThanMs: 5000 })
    expect(reaped).toEqual([old.id])
    expect(await db.attachments.get(old.id)).toBeUndefined()
    expect(await db.attachments.get(recent.id)).toBeDefined()
  })

  it('keeps attachments still referenced by live messages', async () => {
    const chat = await seedChat()
    const attachment = await buildAttachment({
      blob: bytes('used'),
      filename: 'used.bin',
      mime: 'application/octet-stream',
      kind: 'file',
      createdAt: 1000,
    })
    await putAttachment(attachment)
    await getDb().messages.put(makeMessage(chat.id, [attachment.id]))

    const reaped = await reapOrphanedAttachments({ now: 10_000, olderThanMs: 5000 })
    expect(reaped).toEqual([])
    expect(await getDb().attachments.get(attachment.id)).toBeDefined()
  })
})

describe('misc attachment helpers', () => {
  it('diffAttachmentRefs returns increment and decrement sets', () => {
    expect(diffAttachmentRefs(['A', 'B'], ['B', 'C'])).toEqual({
      toInc: ['C'],
      toDec: ['A'],
    })
  })

  it('countLiveRefs scans messages and drafts', async () => {
    const chat = await seedChat()
    const attachment = await buildAttachment({
      blob: bytes('refs'),
      filename: 'refs.bin',
      mime: 'application/octet-stream',
      kind: 'file',
    })
    await putAttachment(attachment)
    await getDb().messages.put(makeMessage(chat.id, [attachment.id]))
    await getDb().drafts.put({
      chatId: chat.id,
      text: '',
      attachmentRefs: [attachment.id],
      updatedAt: 1,
    })

    expect(await countLiveRefs(attachment.id)).toEqual({ messages: 1, drafts: 1 })
  })
})
