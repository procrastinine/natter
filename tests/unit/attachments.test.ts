import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import { newId } from '../../src/lib/ulid'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
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
import { __resetDbForTests, openDb } from '../../src/store/db'
import { withChatLock } from '../../src/store/locks'
import type { Chat, Message } from '../../src/core/types'

const DB_NAME = 'natter'

async function resetAll() {
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
    version: 0,
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

describe('sha256Hex', () => {
  it('is deterministic for identical byte content', async () => {
    const a = await sha256Hex(bytes('hello'))
    const b = await sha256Hex(bytes('hello'))
    expect(a).toBe(b)
  })

  it('produces a 64-char lowercase hex string', async () => {
    const digest = await sha256Hex(bytes('hello'))
    expect(digest).toHaveLength(64)
    expect(digest).toMatch(/^[0-9a-f]{64}$/)
  })

  it('matches the known SHA-256 of "hello"', async () => {
    const digest = await sha256Hex(bytes('hello'))
    expect(digest).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
  })

  it('differs when byte content differs', async () => {
    const a = await sha256Hex(bytes('hello'))
    const b = await sha256Hex(bytes('hello '))
    expect(a).not.toBe(b)
  })

  it('is identical for Blobs built from different constructor shapes of the same bytes', async () => {
    const viaString = new Blob(['hi'])
    const viaBuffer = new Blob([new TextEncoder().encode('hi')])
    const a = await sha256Hex(viaString)
    const b = await sha256Hex(viaBuffer)
    expect(a).toBe(b)
  })
})

describe('buildAttachment', () => {
  it('assigns a ULID id, hashes the blob, and starts at refCount 0', async () => {
    const att = await buildAttachment({
      blob: bytes('img'),
      filename: 'a.png',
      mime: 'image/png',
      kind: 'image',
    })
    expect(att.id).toHaveLength(26)
    expect(att.refCount).toBe(0)
    expect(att.sizeBytes).toBe(3)
    expect(att.contentHash).toHaveLength(64)
  })

  it('carries through optional dimensions and thumbnails without leaking undefined keys', async () => {
    const att = await buildAttachment({
      blob: bytes('img'),
      filename: 'a.png',
      mime: 'image/png',
      kind: 'image',
      dimensions: { width: 10, height: 20 },
      thumbnailB64: 'thumb',
    })
    expect(att.dimensions).toEqual({ width: 10, height: 20 })
    expect(att.thumbnailB64).toBe('thumb')
    expect('durationMs' in att).toBe(false)
    expect('pageCount' in att).toBe(false)
  })
})

describe('refcount primitives', () => {
  it('incRefs and decRefs move refCount by one per id', async () => {
    const chat = await seedChat()
    const db = await openDb()
    const att = await buildAttachment({
      blob: bytes('x'),
      filename: 'x.bin',
      mime: 'application/octet-stream',
      kind: 'file',
    })
    await putAttachment(att)

    await withChatLock(chat.id, async ({ tx }) => {
      await incRefs(tx, [att.id])
    })
    expect((await db.attachments.get(att.id))?.refCount).toBe(1)

    await withChatLock(chat.id, async ({ tx }) => {
      await incRefs(tx, [att.id, att.id])
    })
    expect((await db.attachments.get(att.id))?.refCount).toBe(3)

    await withChatLock(chat.id, async ({ tx }) => {
      await decRefs(tx, [att.id])
    })
    expect((await db.attachments.get(att.id))?.refCount).toBe(2)
  })

  it('decRefs clamps at zero instead of going negative', async () => {
    const chat = await seedChat()
    const db = await openDb()
    const att = await buildAttachment({
      blob: bytes('x'),
      filename: 'x.bin',
      mime: 'application/octet-stream',
      kind: 'file',
    })
    await putAttachment(att)

    await withChatLock(chat.id, async ({ tx }) => {
      await decRefs(tx, [att.id, att.id])
    })
    expect((await db.attachments.get(att.id))?.refCount).toBe(0)
  })

  it('tracks refcount across a message-send → edit → hard-delete sequence', async () => {
    const chat = await seedChat()
    const db = await openDb()
    const att = await buildAttachment({
      blob: bytes('x'),
      filename: 'x.bin',
      mime: 'application/octet-stream',
      kind: 'file',
    })
    await putAttachment(att)

    // Send: message persists with attachment ref, refCount +1.
    const msgId = newId()
    await withChatLock(chat.id, async ({ tx }) => {
      const msg: Message = {
        id: msgId,
        chatId: chat.id,
        parentId: null,
        siblingIndex: 0,
        turnId: newId(),
        turnIndex: 0,
        createdAt: Date.now(),
        role: 'user',
        origin: 'user',
        content: [{ type: 'text', text: 'see file' }],
        attachmentRefs: [att.id],
        deleted: false,
      }
      await db.messages.put(msg)
      await incRefs(tx, [att.id])
    })
    expect((await db.attachments.get(att.id))?.refCount).toBe(1)

    // In-place edit: content changes, attachmentRefs unchanged — no ref delta.
    await withChatLock(chat.id, async () => {
      const existing = await db.messages.get(msgId)
      if (!existing) throw new Error('expected message to exist')
      await db.messages.put({
        ...existing,
        content: [{ type: 'text', text: 'updated text' }],
        editedAt: Date.now(),
      })
    })
    expect((await db.attachments.get(att.id))?.refCount).toBe(1)

    // Soft-delete: message tombstoned, ref still held per §3.3.
    await withChatLock(chat.id, async () => {
      const existing = await db.messages.get(msgId)
      if (!existing) throw new Error('expected message to exist')
      await db.messages.put({ ...existing, deleted: true })
    })
    expect((await db.attachments.get(att.id))?.refCount).toBe(1)

    // Hard-delete: row removed AND refCount decremented.
    await withChatLock(chat.id, async ({ tx }) => {
      await db.messages.delete(msgId)
      await decRefs(tx, [att.id])
    })
    expect((await db.attachments.get(att.id))?.refCount).toBe(0)
  })
})

describe('reapOrphanedAttachments', () => {
  it('reaps attachments with refCount 0 older than the cutoff', async () => {
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

  it('does not reap attachments still referenced by a live message even if refCount got out of sync', async () => {
    const chat = await seedChat()
    const db = await openDb()
    const att = await buildAttachment({
      blob: bytes('img'),
      filename: 'a.png',
      mime: 'image/png',
      kind: 'image',
      createdAt: 1000,
    })
    // Simulate a bug: refCount stuck at 0 despite a live reference.
    await putAttachment(att)
    await db.messages.put({
      id: newId(),
      chatId: chat.id,
      parentId: null,
      siblingIndex: 0,
      turnId: newId(),
      turnIndex: 0,
      createdAt: Date.now(),
      role: 'user',
      origin: 'user',
      content: [{ type: 'text', text: 'x' }],
      attachmentRefs: [att.id],
      deleted: false,
    })

    const reaped = await reapOrphanedAttachments({ now: 10_000, olderThanMs: 5000 })
    expect(reaped).toEqual([])
    expect(await db.attachments.get(att.id)).toBeDefined()
  })

  it('reaps a draft-only attachment once the draft is abandoned (no draft or message references remain)', async () => {
    const chat = await seedChat()
    const db = await openDb()
    const att = await buildAttachment({
      blob: bytes('draft'),
      filename: 'd.png',
      mime: 'image/png',
      kind: 'image',
      createdAt: 1000,
    })
    await putAttachment(att)

    // Draft autosave: refCount +1 and draft row references it.
    await db.drafts.put({
      chatId: chat.id,
      text: 'later…',
      attachmentRefs: [att.id],
      updatedAt: Date.now(),
    })
    await withChatLock(chat.id, async ({ tx }) => {
      await incRefs(tx, [att.id])
    })
    expect((await db.attachments.get(att.id))?.refCount).toBe(1)

    // GC now would NOT reap — draft still references it.
    let reaped = await reapOrphanedAttachments({ now: 10_000, olderThanMs: 5000 })
    expect(reaped).toEqual([])

    // Abandon the draft: clear the row, decrement the refcount.
    await withChatLock(chat.id, async ({ tx }) => {
      await db.drafts.delete(chat.id)
      await decRefs(tx, [att.id])
    })
    expect((await db.attachments.get(att.id))?.refCount).toBe(0)

    // GC now reaps the orphaned attachment.
    reaped = await reapOrphanedAttachments({ now: 10_000, olderThanMs: 5000 })
    expect(reaped).toEqual([att.id])
    expect(await db.attachments.get(att.id)).toBeUndefined()
  })

  it('ignores attachments created within the cutoff window', async () => {
    const att = await buildAttachment({
      blob: bytes('fresh'),
      filename: 'f',
      mime: 'application/octet-stream',
      kind: 'file',
      createdAt: 9_000,
    })
    await putAttachment(att)
    const reaped = await reapOrphanedAttachments({ now: 10_000, olderThanMs: 5000 })
    expect(reaped).toEqual([])
  })
})

describe('countLiveRefs', () => {
  it('counts references across messages and drafts', async () => {
    const chat = await seedChat()
    const db = await openDb()
    const att = await buildAttachment({
      blob: bytes('x'),
      filename: 'x.bin',
      mime: 'application/octet-stream',
      kind: 'file',
    })
    await putAttachment(att)
    await db.messages.put({
      id: newId(),
      chatId: chat.id,
      parentId: null,
      siblingIndex: 0,
      turnId: newId(),
      turnIndex: 0,
      createdAt: Date.now(),
      role: 'user',
      origin: 'user',
      content: [{ type: 'text', text: 'x' }],
      attachmentRefs: [att.id, att.id], // defensive: duplicates
      deleted: false,
    })
    await db.drafts.put({
      chatId: chat.id,
      text: '',
      attachmentRefs: [att.id],
      updatedAt: Date.now(),
    })
    const counts = await countLiveRefs(att.id)
    expect(counts).toEqual({ messages: 1, drafts: 1 })
  })
})

describe('diffAttachmentRefs', () => {
  it('returns the ids added and removed between the two lists', () => {
    expect(diffAttachmentRefs(undefined, ['a', 'b'])).toEqual({
      toInc: ['a', 'b'],
      toDec: [],
    })
    expect(diffAttachmentRefs(['a', 'b'], ['a'])).toEqual({
      toInc: [],
      toDec: ['b'],
    })
    expect(diffAttachmentRefs(['a', 'b'], ['b', 'c'])).toEqual({
      toInc: ['c'],
      toDec: ['a'],
    })
    expect(diffAttachmentRefs(['a'], ['a'])).toEqual({ toInc: [], toDec: [] })
  })
})
