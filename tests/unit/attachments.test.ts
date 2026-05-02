import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type { Chat, Message, MessageAttachmentRef } from '../../src/core/types'
import { newId } from '../../src/lib/ulid'
import {
  addExistingAttachmentRef,
  buildAttachment,
  countLiveRefs,
  decRefs,
  deleteReferencedAttachmentBytes,
  deleteUnreferencedAttachment,
  diffAttachmentRefs,
  getAttachmentBundle,
  incRefs,
  ingestAttachmentBytes,
  putAttachment,
  reapOrphanedAttachments,
  relinkAttachmentRef,
  replaceAttachmentBytes,
  setAttachmentRefVisibility,
  sha256Hex,
} from '../../src/store/attachments'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import {
  __resetBrowserRepositoryForTests,
  getBrowserRepository,
} from '../../src/store/browser-repo'
import { __resetDbForTests, getDb, openDb } from '../../src/store/db'
import { putTestMessage } from '../helpers/message-storage'

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

function attachmentRef(attachmentId: string, createdAt = 1): MessageAttachmentRef {
  return {
    refId: `ref-${attachmentId}-${createdAt}`,
    attachmentId,
    includeInContext: true,
    presentation: {},
    createdAt,
    updatedAt: createdAt,
  }
}

function makeMessage(chatId: string, attachmentRefs?: MessageAttachmentRef[]): Message {
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
    expect(attachment.storage.kind).toBe('local-blob')
  })
})

describe('attachment backend storage', () => {
  it('ingests local bytes into metadata, blob, artifact, and job rows', async () => {
    const bundle = await ingestAttachmentBytes({
      blob: bytes('# Attachment backend\n\nSearchable markdown body.'),
      filename: 'notes.md',
      now: 10,
    })

    expect(bundle.attachment.kind).toBe('plaintext')
    expect(bundle.attachment.storage.kind).toBe('local-blob')
    expect(bundle.blobs).toHaveLength(1)
    expect(bundle.artifacts.some((artifact) => artifact.kind === 'text')).toBe(true)
    expect(bundle.jobs.map((job) => job.processorId)).toContain('plaintext-code-v1')

    const stored = await getAttachmentBundle(bundle.attachment.id)
    expect(stored?.blobs[0]?.sizeBytes).toBe(bundle.attachment.sizeBytes)

    const hits = await getBrowserRepository().searchAttachments({
      query: 'notes markdown searchable',
      filters: { kind: 'plaintext' },
    })
    expect(hits.rows.map((row) => row.id)).toEqual([bundle.attachment.id])

    await ingestAttachmentBytes({
      blob: bytes('second searchable text'),
      filename: 'other.txt',
      now: 11,
    })
    const pageOne = await getBrowserRepository().searchAttachments({
      filters: { kind: 'plaintext' },
      sort: 'created-asc',
      limit: 1,
    })
    expect(pageOne.nextCursor).toBe(bundle.attachment.id)
    if (!pageOne.nextCursor) throw new Error('expected cursor')
    const pageTwo = await getBrowserRepository().searchAttachments({
      filters: { kind: 'plaintext' },
      sort: 'created-asc',
      limit: 1,
      cursor: pageOne.nextCursor,
    })
    expect(pageTwo.rows).toHaveLength(1)
    expect(pageTwo.rows[0]?.id).not.toBe(bundle.attachment.id)
  })

  it('reuses an existing stored object for same filename and same hash', async () => {
    const first = await ingestAttachmentBytes({
      blob: bytes('same bytes'),
      filename: 'duplicate.txt',
      now: 10,
    })
    const second = await ingestAttachmentBytes({
      blob: bytes('same bytes'),
      filename: 'duplicate.txt',
      now: 11,
    })
    const differentName = await ingestAttachmentBytes({
      blob: bytes('same bytes'),
      filename: 'renamed.txt',
      now: 12,
    })

    expect(second.attachment.id).toBe(first.attachment.id)
    expect(differentName.attachment.id).not.toBe(first.attachment.id)
    expect(await getDb().attachments.count()).toBe(2)
  })

  it('replaces bytes in-place unless the uploaded file already exists', async () => {
    const target = await ingestAttachmentBytes({
      blob: bytes('old bytes'),
      filename: 'target.txt',
      now: 10,
    })
    const existing = await ingestAttachmentBytes({
      blob: bytes('existing bytes'),
      filename: 'existing.txt',
      now: 11,
    })

    const replaced = await replaceAttachmentBytes({
      attachmentId: target.attachment.id,
      blob: bytes('new bytes'),
      filename: 'target.txt',
      now: 12,
    })
    expect(replaced.reusedExisting).toBe(false)
    expect(replaced.bundle.attachment.id).toBe(target.attachment.id)
    expect(replaced.bundle.attachment.createdAt).toBe(target.attachment.createdAt)
    expect(replaced.bundle.attachment.contentHash).not.toBe(target.attachment.contentHash)
    expect((await getAttachmentBundle(target.attachment.id))?.blobs).toHaveLength(1)

    const reused = await replaceAttachmentBytes({
      attachmentId: target.attachment.id,
      blob: bytes('existing bytes'),
      filename: 'existing.txt',
      now: 13,
    })
    expect(reused.reusedExisting).toBe(true)
    expect(reused.bundle.attachment.id).toBe(existing.attachment.id)
  })

  it('manages refs, relinks to existing storage, and deletes referenced bytes into missing state', async () => {
    const chat = await seedChat()
    const message = makeMessage(chat.id)
    await putTestMessage(message)

    const first = await ingestAttachmentBytes({
      blob: bytes('first attachment'),
      filename: 'report.txt',
      now: 10,
    })
    const second = await ingestAttachmentBytes({
      blob: bytes('second attachment'),
      filename: 'report.txt',
      now: 11,
    })

    const ref = await addExistingAttachmentRef({
      messageId: message.id,
      attachmentId: first.attachment.id,
      now: 20,
    })
    expect((await getDb().attachments.get(first.attachment.id))?.refCount).toBe(1)
    const withRef = await getBrowserRepository().getMessage(message.id)
    expect(typeof withRef?.attachmentRefs?.[0]).toBe('object')
    expect(withRef?.attachmentRefs?.[0]).toMatchObject({
      refId: ref.refId,
      attachmentId: first.attachment.id,
      includeInContext: true,
    })

    const hidden = await setAttachmentRefVisibility({
      messageId: message.id,
      refId: ref.refId,
      includeInContext: false,
      now: 21,
    })
    expect(hidden.includeInContext).toBe(false)
    expect((await getDb().attachments.get(first.attachment.id))?.refCount).toBe(1)

    const relinked = await relinkAttachmentRef({
      messageId: message.id,
      refId: ref.refId,
      newAttachmentId: second.attachment.id,
      now: 22,
    })
    expect(relinked.attachmentId).toBe(second.attachment.id)
    expect((await getDb().attachments.get(first.attachment.id))?.refCount).toBe(0)
    expect((await getDb().attachments.get(second.attachment.id))?.refCount).toBe(1)

    expect(await deleteUnreferencedAttachment(first.attachment.id)).toMatchObject({
      deleted: true,
    })
    expect(await getDb().attachments.get(first.attachment.id)).toBeUndefined()

    const missing = await deleteReferencedAttachmentBytes(second.attachment.id, 'deleted', 23)
    expect(missing?.storage).toMatchObject({ kind: 'missing', reason: 'deleted' })
    expect((await getAttachmentBundle(second.attachment.id))?.blobs).toHaveLength(0)
    expect(await countLiveRefs(second.attachment.id)).toEqual({ messages: 1, drafts: 0 })
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
      await incRefs(ctx, [attachmentRef(attachment.id)])
    })
    expect((await getDb().attachments.get(attachment.id))?.refCount).toBe(1)

    await repo.runMutation([{ kind: 'attachment', attachmentId: attachment.id }], async (ctx) => {
      await decRefs(ctx, [attachmentRef(attachment.id), attachmentRef(attachment.id, 2)])
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
    const message = makeMessage(chat.id, [attachmentRef(attachment.id)])

    await repo.runMutation(
      [
        { kind: 'message', messageId: message.id },
        { kind: 'children', chatId: chat.id, parentId: null },
        { kind: 'attachment', attachmentId: attachment.id },
      ],
      async (ctx) => {
        await ctx.putMessage(message)
        await incRefs(ctx, message.attachmentRefs)
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
        await decRefs(ctx, message.attachmentRefs)
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
    await putTestMessage(makeMessage(chat.id, [attachmentRef(attachment.id)]))

    const reaped = await reapOrphanedAttachments({ now: 10_000, olderThanMs: 5000 })
    expect(reaped).toEqual([])
    expect(await getDb().attachments.get(attachment.id)).toBeDefined()
  })
})

describe('misc attachment helpers', () => {
  it('diffAttachmentRefs returns increment and decrement sets', () => {
    expect(
      diffAttachmentRefs(
        [attachmentRef('A'), attachmentRef('B')],
        [attachmentRef('B'), attachmentRef('C')],
      ),
    ).toEqual({
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
    await putTestMessage(makeMessage(chat.id, [attachmentRef(attachment.id)]))
    await getDb().drafts.put({
      chatId: chat.id,
      text: '',
      attachmentRefs: [attachmentRef(attachment.id)],
      updatedAt: 1,
    })

    expect(await countLiveRefs(attachment.id)).toEqual({ messages: 1, drafts: 1 })
  })
})
