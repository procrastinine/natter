import Dexie, { liveQuery } from 'dexie'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type { Attachment, Chat, Message, MessageAttachmentRef } from '../../src/core/types'
import { newId } from '../../src/lib/ulid'
import { __resetBroadcastForTests, type BroadcastEvent, onEvent } from '../../src/store/broadcast'
import {
  __resetBrowserRepositoryForTests,
  getBrowserRepository,
} from '../../src/store/browser-repo'
import { __resetDbForTests, getDb, openDb } from '../../src/store/db'
import {
  __resetFolderStoreForTests,
  createFolder,
  deleteFolder,
  listFolders,
  updateFolder,
} from '../../src/store/folders'
import { setChatTagsFromNames } from '../../src/store/chats'
import {
  __resetTagStoreForTests,
  createTag,
  deleteTag,
  listTags,
  mergeTagIds,
  mergeTagInto,
  updateTag,
} from '../../src/store/tags'
import { putTestMessage } from '../helpers/message-storage'

const DB_NAME = 'natter'

async function resetAll() {
  __resetBrowserRepositoryForTests()
  __resetDbForTests()
  __resetBroadcastForTests()
  __resetFolderStoreForTests()
  __resetTagStoreForTests()
  await Dexie.delete(DB_NAME)
}

beforeEach(async () => {
  await resetAll()
  await openDb()
})

afterEach(async () => {
  await resetAll()
})

async function seedChat(overrides: Partial<Chat> = {}): Promise<Chat> {
  const chat: Chat = {
    id: newId(),
    title: 'Test',
    titleStatus: 'untitled',
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
    ...overrides,
  }
  await getDb().chats.put(chat)
  return chat
}

async function seedMessage(chatId: string, overrides: Partial<Message> = {}): Promise<Message> {
  const message: Message = {
    id: newId(),
    chatId,
    parentId: null,
    siblingIndex: 0,
    turnId: newId(),
    turnIndex: 0,
    createdAt: 100,
    role: 'user',
    origin: 'user',
    content: [{ type: 'text', text: 'hello' }],
    nodeVersion: 0,
    deleted: false,
    ...overrides,
  }
  await putTestMessage(message)
  return message
}

async function seedAttachment(overrides: Partial<Attachment> = {}): Promise<Attachment> {
  const attachment: Attachment = {
    id: newId(),
    kind: 'document',
    mime: 'text/plain',
    filename: 'note.txt',
    origin: 'user-upload',
    createdAt: 100,
    updatedAt: 100,
    storage: { kind: 'missing', reason: 'import-missing', missingSince: 100 },
    artifacts: [],
    processing: [],
    refCount: 0,
    ...overrides,
  }
  await getDb().attachments.put(attachment)
  return attachment
}

function attachmentRef(attachmentId: string): MessageAttachmentRef {
  return {
    refId: `ref-${attachmentId}`,
    attachmentId,
    includeInContext: true,
    presentation: {},
    createdAt: 100,
    updatedAt: 100,
  }
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < 1000) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for condition')
}

describe('organization repository contract', () => {
  it('creates, updates, lists, and deletes folders through the repository surface', async () => {
    const events: BroadcastEvent[] = []
    const unsub = onEvent((event) => events.push(event))

    const folder = await createFolder({ id: 'folder-a', name: ' Work ', sortIndex: 2, now: 10 })
    expect(folder).toMatchObject({ id: 'folder-a', name: 'Work', sortIndex: 2 })
    await updateFolder(folder.id, { name: 'Pinned', color: '#abcdef', now: 11 })
    expect(await listFolders()).toEqual([
      expect.objectContaining({ id: folder.id, name: 'Pinned', color: '#abcdef' }),
    ])
    const result = await getBrowserRepository().deleteFolder('missing')
    expect(result).toEqual({ deleted: false, affectedChatIds: [] })
    expect(await deleteFolder(folder.id)).toBe(true)
    unsub()

    expect(events.map((event) => event.kind)).toEqual([
      'folder-mutated',
      'folder-mutated',
      'folder-deleted',
    ])
  })

  it('deleting a folder clears assigned chats and fans out chat-mutated events', async () => {
    const folder = await createFolder({ id: 'folder-b', name: 'Archive', now: 1 })
    const chat = await seedChat({ folderId: folder.id })
    const events: BroadcastEvent[] = []
    const unsub = onEvent((event) => events.push(event))

    const result = await getBrowserRepository().deleteFolder(folder.id)
    unsub()

    expect(result).toEqual({ deleted: true, affectedChatIds: [chat.id] })
    const stored = await getDb().chats.get(chat.id)
    expect(stored?.folderId).toBeNull()
    expect(stored?.metaVersion).toBe(1)
    expect(events).toContainEqual({ kind: 'folder-deleted', folderId: folder.id })
    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'chat-mutated', chatId: chat.id }),
    )
  })

  it('enforces tag nameLower uniqueness and reports rename collisions', async () => {
    const alpha = await createTag({ id: 'tag-a', name: 'Alpha', now: 1 })
    const beta = await createTag({ id: 'tag-b', name: 'Beta', now: 2 })

    await expect(createTag({ id: 'tag-dupe', name: 'alpha', now: 3 })).rejects.toHaveProperty(
      'name',
      'ConstraintError',
    )
    await expect(updateTag(beta.id, { name: 'Alpha', now: 4 })).rejects.toHaveProperty(
      'name',
      'ConstraintError',
    )
    expect((await getDb().tags.get(alpha.id))?.nameLower).toBe('alpha')
  })

  it('allows case-change-only tag renames and broadcasts exactly once', async () => {
    const tag = await createTag({ id: 'tag-case', name: 'Work', now: 1 })
    const events: BroadcastEvent[] = []
    const unsub = onEvent((event) => events.push(event))

    const updated = await updateTag(tag.id, { name: 'work', now: 2 })
    unsub()

    expect(updated).toMatchObject({
      id: tag.id,
      name: 'work',
      nameLower: 'work',
      updatedAt: 2,
    })
    expect(events).toEqual([{ kind: 'tag-mutated', tagId: tag.id }])
  })

  it('does not write or broadcast on exact no-op folder and tag updates', async () => {
    const repo = getBrowserRepository()
    const folder = await createFolder({ id: 'folder-noop', name: 'Noop folder', now: 1 })
    const tag = await createTag({ id: 'tag-noop', name: 'Noop tag', now: 2 })
    const beforeMeta = await repo.getWorkspaceMeta()
    const events: BroadcastEvent[] = []
    const unsub = onEvent((event) => events.push(event))

    const sameFolder = await updateFolder(folder.id, { name: 'Noop folder', now: 100 })
    const sameTag = await updateTag(tag.id, { name: 'Noop tag', now: 100 })
    unsub()

    const afterMeta = await repo.getWorkspaceMeta()
    expect(sameFolder?.updatedAt).toBe(1)
    expect(sameTag?.updatedAt).toBe(2)
    expect(afterMeta.mutationCounter).toBe(beforeMeta.mutationCounter)
    expect(events).toEqual([])
  })

  it('folder and tag list reads participate in live queries', async () => {
    const folderSnapshots: string[][] = []
    const tagSnapshots: string[][] = []
    const folderSubscription = liveQuery(async () =>
      (await listFolders()).map((folder) => folder.id),
    ).subscribe((ids) => folderSnapshots.push(ids))
    const tagSubscription = liveQuery(async () =>
      (await listTags()).map((tag) => tag.id),
    ).subscribe((ids) => tagSnapshots.push(ids))

    try {
      await waitForCondition(() => folderSnapshots.length > 0 && tagSnapshots.length > 0)
      await createFolder({ id: 'folder-live', name: 'Live folder', now: 1 })
      await createTag({ id: 'tag-live', name: 'Live tag', now: 2 })

      await waitForCondition(
        () =>
          folderSnapshots.some((ids) => ids.includes('folder-live')) &&
          tagSnapshots.some((ids) => ids.includes('tag-live')),
      )
    } finally {
      folderSubscription.unsubscribe()
      tagSubscription.unsubscribe()
    }
  })

  it('deleting a tag removes it from chats through repository fan-out', async () => {
    const tag = await createTag({ id: 'tag-c', name: 'Topic', now: 1 })
    const chat = await seedChat({ tags: [tag.id, 'keep'] })
    const events: BroadcastEvent[] = []
    const unsub = onEvent((event) => events.push(event))

    expect(await deleteTag(tag.id)).toBe(true)
    unsub()

    expect((await getDb().chats.get(chat.id))?.tags).toEqual(['keep'])
    expect(events).toContainEqual({ kind: 'tag-deleted', tagId: tag.id })
    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'chat-mutated', chatId: chat.id }),
    )
  })

  it('merges tags idempotently and preserves target ordering rules', async () => {
    expect(mergeTagIds(['source', 'other'], 'source', 'target')).toEqual(['target', 'other'])
    expect(mergeTagIds(['target', 'source', 'other'], 'source', 'target')).toEqual([
      'target',
      'other',
    ])

    const source = await createTag({ id: 'source', name: 'Source', now: 1 })
    const target = await createTag({ id: 'target', name: 'Target', now: 2 })
    const sourceOnly = await seedChat({ tags: [source.id, 'other'] })
    const both = await seedChat({ tags: [target.id, source.id, 'other'] })
    const neither = await seedChat({ tags: ['other'] })

    const result = await mergeTagInto(source.id, target.id, 10)

    expect(result).toEqual({ merged: true, affectedChatIds: [sourceOnly.id, both.id] })
    expect((await getDb().chats.get(sourceOnly.id))?.tags).toEqual([target.id, 'other'])
    expect((await getDb().chats.get(both.id))?.tags).toEqual([target.id, 'other'])
    expect((await getDb().chats.get(neither.id))?.tags).toEqual(['other'])
    expect(await getDb().tags.get(source.id)).toBeUndefined()
  })

  it('edits chat tags by name, creates missing tags, and prunes unused tags', async () => {
    const keep = await createTag({ id: 'tag-keep', name: 'Keep', now: 1 })
    const unused = await createTag({ id: 'tag-unused', name: 'Unused', now: 2 })
    const chat = await seedChat({ tags: [keep.id, unused.id] })
    const other = await seedChat({ tags: [keep.id] })

    const nextIds = await setChatTagsFromNames(chat.id, ['Keep', 'New', 'new', '  '], 10)

    const newTag = await getDb().tags.where('nameLower').equals('new').first()
    expect(newTag).toBeDefined()
    expect(nextIds).toEqual([keep.id, newTag?.id])
    expect((await getDb().chats.get(chat.id))?.tags).toEqual([keep.id, newTag?.id])
    expect((await getDb().chats.get(other.id))?.tags).toEqual([keep.id])
    expect(await getDb().tags.get(unused.id)).toBeUndefined()
  })

  it('permanently deletes archived chats and decrements attachment refs', async () => {
    const attachment = await seedAttachment({ id: 'att-1', refCount: 2 })
    const archived = await seedChat({ id: 'archived', archived: true })
    const live = await seedChat({ id: 'live', archived: false })
    await seedMessage(archived.id, {
      id: 'archived-message',
      attachmentRefs: [attachmentRef(attachment.id)],
    })
    await getDb().drafts.put({
      chatId: archived.id,
      text: '',
      attachmentRefs: [attachmentRef(attachment.id)],
      updatedAt: 100,
    })
    await seedMessage(live.id, { id: 'live-message' })

    const deleted = await getBrowserRepository().deleteArchivedChat(archived.id)

    expect(deleted).toBe(true)
    expect(await getDb().chats.get(archived.id)).toBeUndefined()
    expect(await getDb().messages.get('archived-message')).toBeUndefined()
    expect(await getDb().drafts.get(archived.id)).toBeUndefined()
    expect(await getDb().chats.get(live.id)).toBeDefined()
    expect((await getDb().attachments.get(attachment.id))?.refCount).toBe(0)
  })

  it('emptyArchivedChats deletes only archived chats', async () => {
    const archived = await seedChat({ id: 'archived-empty', archived: true })
    const live = await seedChat({ id: 'live-empty', archived: false })

    const result = await getBrowserRepository().emptyArchivedChats()

    expect(result.deletedChatIds).toEqual([archived.id])
    expect(await getDb().chats.get(archived.id)).toBeUndefined()
    expect(await getDb().chats.get(live.id)).toBeDefined()
  })
})
