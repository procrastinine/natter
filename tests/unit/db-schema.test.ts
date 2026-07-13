import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AttachmentReferenceEdgeMigrationError,
  rebuildAttachmentReferenceEdges,
} from '../../src/backcompat/attachment-reference-edges'
import { forEachTableBatch } from '../../src/backcompat/batched-table'
import { assertNoInlineMessageBodies } from '../../src/backcompat/message-body-split'
import { migrateProviderOutputItemRows } from '../../src/backcompat/provider-output-items'
import { canonicalizeTokenCalibrationRows } from '../../src/backcompat/token-calibration-global'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import { tokenCalibrationKey } from '../../src/core/model-ids'
import type {
  Attachment,
  AttachmentArtifact,
  AttachmentReferenceEdge,
  Chat,
  GlobalTokenCalibration,
  Message,
  MessageAttachmentRef,
} from '../../src/core/types'
import {
  attachmentHeaderFromStoredRow,
  hydrateAttachment,
} from '../../src/store/attachment-storage'
import { BROWSER_WRITER_LOCK_NAME, type BrowserLockRow } from '../../src/store/browser-lock-record'
import { putChatSidebarProjection } from '../../src/store/chat-sidebar-projection'
import type { NatterDb } from '../../src/store/db'
import {
  __resetDbForTests,
  backfillOrganizationFields,
  createDbForTests,
  openDb,
  registerSchema,
} from '../../src/store/db'
import { hydrateMessage, splitMessageForStorage } from '../../src/store/message-storage'
import type { StreamLeaseRow } from '../../src/store/repository'

// Unique DB name per test so migrations start from a clean slate. Pre-existing
// data is deleted at the top of each test so repeated runs don't pick up stale
// state from fake-indexeddb's in-memory persistence.
async function freshDb(name: string): Promise<NatterDb> {
  await Dexie.delete(name)
  return createDbForTests(name)
}

afterEach(() => {
  __resetDbForTests()
})

describe('Dexie schema', () => {
  beforeEach(async () => {
    await Dexie.delete('natter')
  })

  it('opens on a fresh IndexedDB with all declared tables', async () => {
    const db = await openDb()
    expect(db.isOpen()).toBe(true)
    expect(db.verno).toBe(23)
    const names = db.tables.map((t) => t.name).sort()
    expect(names).toEqual(
      [
        'attachmentArtifacts',
        'attachmentBlobs',
        'attachmentJobs',
        'attachmentRefEdges',
        'attachments',
        'browserLocks',
        'chatBranchCache',
        'chatSidebarRows',
        'chats',
        'childLists',
        'drafts',
        'endpoints',
        'folders',
        'generations',
        'keys',
        'messageBodies',
        'messages',
        'models',
        'presets',
        'presetResolutions',
        'privacyPolicies',
        'profiles',
        'promptPresets',
        'providers',
        'settings',
        'streamChunks',
        'streamLeases',
        'tags',
      ].sort(),
    )
    expect(db.attachmentRefEdges.schema.primKey.src).toBe('[ownerKind+ownerId+refId]')
    expect(db.attachmentRefEdges.schema.indexes.map((index) => index.src)).toEqual([
      'attachmentId',
      '[attachmentId+ownerKind]',
      '[ownerKind+ownerId]',
      'chatId',
    ])
    expect(db.streamLeases.schema.indexes.map((index) => index.src)).toContain('messageId')
    expect(await db.attachmentRefEdges.count()).toBe(0)
    expect(await db.chatSidebarRows.count()).toBe(0)
    expect((await db.settings.get('backfill:attachment-refs-v1'))?.value).toBe(1)
    expect((await db.settings.get('backfill:chat-preview-projection-v1'))?.value).toBe(1)
    expect((await db.settings.get('backfill:chat-sidebar-projection-v1'))?.value).toBe(1)
    expect((await db.settings.get('projection:chat-sidebar-v1'))?.value).toEqual({
      projectionVersion: 1,
      expectedCount: 0,
    })
    expect(await db.browserLocks.get(BROWSER_WRITER_LOCK_NAME)).toEqual({
      name: BROWSER_WRITER_LOCK_NAME,
      ownerClientId: null,
      leaseId: null,
      fencingToken: 0,
      acquiredAt: 0,
      heartbeatAt: 0,
      expiresAt: 0,
    })
  })

  it('runs the composed v23 message and attachment projection migration exactly once', async () => {
    const name = `natter-test-projections-v23-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)
    const legacy = new Dexie(name)
    legacy.version(22).stores({
      messages:
        'id, chatId, parentId, turnId, [chatId+parentId], [chatId+createdAt], [chatId+turnId], [chatId+deleted]',
      messageBodies: '&id, chatId, updatedAt, nodeVersion',
      attachments: 'id, contentHash, kind, mime, origin, refCount, createdAt, updatedAt, deletedAt',
      attachmentArtifacts: 'artifactId, attachmentId, kind, processorId, createdAt',
    })
    await legacy.open()
    const message: Message = {
      id: 'projection-message',
      chatId: 'projection-chat',
      parentId: null,
      siblingIndex: 0,
      turnId: 'projection-turn',
      turnIndex: 0,
      createdAt: 1,
      role: 'assistant',
      origin: 'generated',
      generation: {
        id: 'projection-generation',
        model: 'model',
        requestedModel: 'model',
        apiUsed: 'responses',
        delivery: 'streaming',
        costSource: 'stream',
        startedAt: 1,
        serverTools: [
          {
            type: 'web_search_call',
            source: 'responses-output',
            output: { text: 'large tool output' },
          },
        ],
      },
      content: [{ type: 'output_text', text: `  ${'preview '.repeat(1_000)}  ` }],
      nodeVersion: 0,
      deleted: false,
    }
    const split = splitMessageForStorage(message)
    const legacyHeader = structuredClone(split.header) as Record<string, unknown>
    delete legacyHeader.textPreview
    legacyHeader.generation = structuredClone(message.generation)
    const legacyBody = structuredClone(split.body)
    delete legacyBody.generationServerToolOutputs
    await legacy.table('messages').put(legacyHeader)
    await legacy.table('messageBodies').put(legacyBody)

    const artifact: AttachmentArtifact = {
      kind: 'text',
      artifactId: 'projection-artifact',
      attachmentId: 'projection-attachment',
      processorId: 'text-v1',
      text: 'x'.repeat(100_000),
      charCount: 100_000,
      createdAt: 1,
    }
    const attachment: Attachment = {
      id: 'projection-attachment',
      kind: 'document',
      mime: 'text/plain',
      filename: 'projection.txt',
      origin: 'import',
      createdAt: 1,
      updatedAt: 1,
      storage: { kind: 'missing', reason: 'import-missing', missingSince: 1 },
      artifacts: [artifact],
      processing: [],
      refCount: 0,
    }
    await legacy.table('attachments').put(attachment)
    legacy.close()

    const migrated = createDbForTests(name)
    await migrated.open()
    expect(migrated.verno).toBe(23)
    const [header, body, storedAttachment, storedArtifact] = await Promise.all([
      migrated.messages.get(message.id),
      migrated.messageBodies.get(message.id),
      migrated.attachments.get(attachment.id),
      migrated.attachmentArtifacts.get(artifact.artifactId),
    ])
    expect(header?.textPreview).toHaveLength(4_096)
    expect(header?.generation?.serverTools?.[0]).not.toHaveProperty('output')
    expect(body?.generationServerToolOutputs).toEqual([
      { index: 0, output: { text: 'large tool output' } },
    ])
    expect(header && body ? hydrateMessage(header, body) : undefined).toEqual(message)
    expect(storedAttachment).not.toHaveProperty('artifacts')
    expect(storedAttachment).toHaveProperty('artifactIds', [artifact.artifactId])
    expect(storedArtifact).toEqual(artifact)
    expect(
      storedAttachment
        ? hydrateAttachment(attachmentHeaderFromStoredRow(storedAttachment), [storedArtifact])
        : undefined,
    ).toEqual(attachment)
    migrated.close()

    const reopened = createDbForTests(name)
    await reopened.open()
    expect(reopened.verno).toBe(23)
    expect(
      (await reopened.messageBodies.get(message.id))?.generationServerToolOutputs,
    ).toHaveLength(1)
    expect(await reopened.attachmentArtifacts.count()).toBe(1)
    await reopened.delete()
  })

  it('cursor-pages large tables in deterministic bounded batches', async () => {
    const name = `natter-test-backcompat-batches-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)
    const db = new Dexie(name)
    db.version(1).stores({ rows: '&id' })
    await db.open()
    const table = db.table<{ id: string; visited: boolean }, string>('rows')
    await table.bulkPut(
      Array.from({ length: 1001 }, (_, index) => ({
        id: `row-${index.toString().padStart(4, '0')}`,
        visited: false,
      })),
    )
    const visited: string[] = []
    const observedBatchSizes: number[] = []
    const stats = await db.transaction('rw', table, async () =>
      forEachTableBatch(
        table,
        async (rows) => {
          observedBatchSizes.push(rows.length)
          visited.push(...rows.map((row) => row.id))
          await table.bulkPut(rows.map((row) => ({ ...row, visited: true })))
        },
        64,
      ),
    )

    expect(stats).toEqual({ rowCount: 1001, batchCount: 16, maxBatchSize: 64 })
    expect(Math.max(...observedBatchSizes)).toBe(64)
    expect(visited).toEqual(
      Array.from({ length: 1001 }, (_, index) => `row-${index.toString().padStart(4, '0')}`),
    )
    expect(await table.filter((row) => !row.visited).count()).toBe(0)
    await db.delete()
  })

  it('adds the browser-writer fence once on v21 to v22 and never resets its token', async () => {
    const name = `natter-test-browser-lock-v22-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)
    const legacy = new Dexie(name)
    legacy.version(21).stores({
      settings: '&key',
      messages: 'id, chatId',
      messageBodies: '&id, chatId',
      streamChunks: '&id, streamId, chatId, messageId, [streamId+seq], createdAt',
    })
    await legacy.open()
    legacy.close()

    const migrated = createDbForTests(name)
    await migrated.open()
    expect(migrated.verno).toBe(23)
    const seeded = await migrated.browserLocks.get(BROWSER_WRITER_LOCK_NAME)
    expect(seeded?.fencingToken).toBe(0)
    await migrated.browserLocks.put({
      ...(seeded as BrowserLockRow),
      ownerClientId: null,
      leaseId: null,
      fencingToken: 41,
      expiresAt: 0,
    })
    migrated.close()

    const reopened = createDbForTests(name)
    await reopened.open()
    expect((await reopened.browserLocks.get(BROWSER_WRITER_LOCK_NAME))?.fencingToken).toBe(41)
    await reopened.delete()
  })

  it('repairs stale previews in the composed v21 to v22 migration', async () => {
    const name = `natter-test-preview-v22-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)
    const legacy = new Dexie(name)
    legacy.version(21).stores({
      chats:
        'id, updatedAt, createdAt, lastViewedAt, lastUpdatedLeafId, lastBranchUpdatedAt, wordCount, totalCostUsd, archived, pinned, presetId, folderId, *tags',
      messages:
        'id, chatId, parentId, turnId, [chatId+parentId], [chatId+createdAt], [chatId+turnId], [chatId+deleted]',
      messageBodies: '&id, chatId, updatedAt, nodeVersion',
      settings: '&key',
      streamChunks: '&id, streamId, chatId, messageId, [streamId+seq], createdAt',
    })
    await legacy.open()
    const chat: Chat = {
      id: 'preview-v22-chat',
      title: 'Preview migration',
      titleStatus: 'manual',
      createdAt: 1,
      updatedAt: 1,
      lastViewedAt: 1,
      wordCount: 2,
      totalCostUsd: 0,
      metaVersion: 0,
      summaryVersion: 0,
      settings: cloneDefaultChatSettings(),
      lastUpdatedLeafId: 'preview-v22-message',
      lastBranchUpdatedAt: 1,
      archived: false,
      pinned: false,
      folderId: null,
      tags: [],
      previewText: 'stale',
    }
    const message: Message = {
      id: 'preview-v22-message',
      chatId: chat.id,
      parentId: null,
      siblingIndex: 0,
      turnId: 'preview-v22-turn',
      turnIndex: 0,
      createdAt: 1,
      role: 'user',
      origin: 'user',
      content: [{ type: 'text', text: ' migrated preview ' }],
      nodeVersion: 0,
      deleted: false,
    }
    const split = splitMessageForStorage(message)
    await legacy.table<Chat>('chats').put(chat)
    await legacy.table('messages').put(split.header)
    await legacy.table('messageBodies').put(split.body)
    legacy.close()

    const migrated = createDbForTests(name)
    await migrated.open()
    expect((await migrated.chats.get(chat.id))?.previewText).toBe('migrated preview')
    expect(await migrated.chatSidebarRows.get(chat.id)).toEqual(
      expect.objectContaining({
        id: chat.id,
        title: chat.title,
        previewText: 'migrated preview',
        projectionVersion: 1,
      }),
    )
    expect((await migrated.settings.get('backfill:chat-preview-projection-v1'))?.value).toBe(1)
    expect((await migrated.settings.get('backfill:chat-sidebar-projection-v1'))?.value).toBe(1)
    expect((await migrated.settings.get('projection:chat-sidebar-v1'))?.value).toEqual({
      projectionVersion: 1,
      expectedCount: 1,
    })
    migrated.close()

    const reopened = createDbForTests(name)
    await reopened.open()
    expect(await reopened.chatSidebarRows.get(chat.id)).toEqual(
      expect.objectContaining({ id: chat.id, previewText: 'migrated preview' }),
    )
    await reopened.delete()
  })

  it('is idempotent across repeated open calls', async () => {
    const a = await openDb()
    const b = await openDb()
    expect(a).toBe(b)
    expect(a.isOpen()).toBe(true)
  })

  it('repairs stale chat previews once and marks the repair complete', async () => {
    let db = await openDb()
    const chat: Chat = {
      id: 'preview-backfill-chat',
      title: 'Preview backfill',
      titleStatus: 'manual',
      createdAt: 1,
      updatedAt: 1,
      lastViewedAt: 1,
      wordCount: 0,
      totalCostUsd: 0,
      metaVersion: 0,
      summaryVersion: 0,
      settings: cloneDefaultChatSettings(),
      lastUpdatedLeafId: 'preview-backfill-message',
      lastBranchUpdatedAt: 1,
      archived: false,
      pinned: false,
      folderId: null,
      tags: [],
      previewText: 'stale',
    }
    const message: Message = {
      id: 'preview-backfill-message',
      chatId: chat.id,
      parentId: null,
      siblingIndex: 0,
      turnId: 'preview-backfill-turn',
      turnIndex: 0,
      createdAt: 1,
      role: 'user',
      origin: 'user',
      content: [{ type: 'text', text: ' repaired\n preview ' }],
      nodeVersion: 0,
      deleted: false,
    }
    const split = splitMessageForStorage(message)
    await db.transaction('rw', db.chats, db.chatSidebarRows, db.settings, async (tx) => {
      await db.chats.put(chat)
      await putChatSidebarProjection(tx, chat, true)
    })
    await db.messages.put(split.header)
    await db.messageBodies.put(split.body)
    await db.settings.delete('backfill:chat-preview-projection-v1')
    expect((await db.settings.get('projection:chat-sidebar-v1'))?.value).toEqual({
      projectionVersion: 1,
      expectedCount: 1,
    })
    expect((await db.chatSidebarRows.get(chat.id))?.previewText).toBe('stale')

    __resetDbForTests()
    db = await openDb()
    expect((await db.chats.get(chat.id))?.previewText).toBe('repaired preview')
    expect((await db.chatSidebarRows.get(chat.id))?.previewText).toBe('repaired preview')
    expect((await db.settings.get('backfill:chat-preview-projection-v1'))?.value).toBe(1)

    await db.chats.update(chat.id, { previewText: 'marker prevents repeat scans' })
    __resetDbForTests()
    db = await openDb()
    expect((await db.chats.get(chat.id))?.previewText).toBe('marker prevents repeat scans')
  })

  it('reopens a previously-written DB and reads existing rows', async () => {
    const name = `natter-test-reopen-${Math.random().toString(36).slice(2)}`
    const first = await freshDb(name)
    await first.open()
    await first.settings.put({ key: 'hello', value: 'world' })
    first.close()

    const second = createDbForTests(name)
    await second.open()
    const row = await second.settings.get('hello')
    expect(row?.value).toBe('world')
    expect(second.tables.map((t) => t.name)).toContain('childLists')
    await second.delete()
  })
})

// Synthetic post-schema upgrades exercised through plain Dexie instances.
// Subclassing is avoided (it trips "Type instantiation is excessively deep" under
// the NatterDb branded Table types); versions are declared directly on the base Db.

interface MinimalProfile {
  id: string
  name: string
  appTitle?: string
  [k: string]: unknown
}
interface MinimalSetting {
  key: string
  value: unknown
}

const SYNTHETIC_PROFILE_BACKFILL_VERSION = 1000
const SYNTHETIC_SETTINGS_SEED_VERSION = 1001

function registerV1(db: Dexie): void {
  registerSchema(db)
}

function registerV1Through3(db: Dexie): void {
  registerSchema(db)
  db.version(SYNTHETIC_PROFILE_BACKFILL_VERSION)
    .stores({ profiles: 'id, name, kind, lastUsedAt, archived' })
    .upgrade(async (tx) => {
      await tx
        .table<MinimalProfile>('profiles')
        .toCollection()
        .modify((row) => {
          if (row.appTitle === undefined) row.appTitle = 'Natter'
        })
    })
  db.version(SYNTHETIC_SETTINGS_SEED_VERSION)
    .stores({ settings: '&key' })
    .upgrade(async (tx) => {
      const settings = tx.table<MinimalSetting>('settings')
      const existing = await settings.get('schemaTag')
      if (!existing) await settings.put({ key: 'schemaTag', value: 'v3' })
    })
}

function registerLegacyProviderPrefsV3(db: Dexie): void {
  db.version(3).stores({
    chats:
      'id, updatedAt, createdAt, lastViewedAt, lastUpdatedLeafId, lastBranchUpdatedAt, wordCount, totalCostUsd, archived, pinned, presetId, folderId, *tags',
    messages:
      'id, chatId, parentId, turnId, [chatId+parentId], [chatId+createdAt], [chatId+turnId], [chatId+deleted]',
    childLists: 'id, [chatId+parentId], updatedAt',
    attachments: 'id, contentHash, refCount, createdAt',
    profiles: 'id, name, kind, lastUsedAt, archived',
    presets: 'id, name, connectionProfileId, lastUsedAt, archived',
    folders: 'id, name, sortIndex, lastUsedAt',
    tags: 'id, &nameLower, lastUsedAt',
    chatBranchCache: '&chatId, branchLeafId, generatedAt',
    keys: 'id, name',
    settings: '&key',
    models: '&[profileId+queryKey], fetchedAt',
    endpoints: '&[profileId+modelId], fetchedAt',
    privacyPolicies: '&[profileId+modelId], fetchedAt',
    providers: '&profileId, fetchedAt',
    generations: 'id, chatId, gen_id',
    presetResolutions: '&[profileId+presetSlug], fetchedAt',
    drafts: '&chatId, updatedAt',
  })
}

function registerLegacyAttachmentsV5(db: Dexie): void {
  db.version(5).stores({
    chats:
      'id, updatedAt, createdAt, lastViewedAt, lastUpdatedLeafId, lastBranchUpdatedAt, wordCount, totalCostUsd, archived, pinned, presetId, folderId, *tags',
    messages:
      'id, chatId, parentId, turnId, [chatId+parentId], [chatId+createdAt], [chatId+turnId], [chatId+deleted]',
    childLists: 'id, [chatId+parentId], updatedAt',
    attachments: 'id, contentHash, refCount, createdAt',
    profiles: 'id, name, kind, lastUsedAt, archived',
    presets: 'id, name, connectionProfileId, lastUsedAt, archived',
    promptPresets: 'id, kind, name, lastUsedAt',
    folders: 'id, name, sortIndex, lastUsedAt',
    tags: 'id, &nameLower, lastUsedAt',
    chatBranchCache: '&chatId, branchLeafId, generatedAt',
    keys: 'id, name',
    settings: '&key',
    models: '&[profileId+queryKey], fetchedAt',
    endpoints: '&[profileId+modelId], fetchedAt',
    privacyPolicies: '&[profileId+modelId], fetchedAt',
    providers: '&profileId, fetchedAt',
    generations: 'id, chatId, gen_id',
    presetResolutions: '&[profileId+presetSlug], fetchedAt',
    drafts: '&chatId, updatedAt',
  })
}

function registerLegacyChatSettingsV14(db: Dexie): void {
  db.version(14).stores({
    chats:
      'id, updatedAt, createdAt, lastViewedAt, lastUpdatedLeafId, lastBranchUpdatedAt, wordCount, totalCostUsd, archived, pinned, presetId, folderId, *tags',
    presets: 'id, name, connectionProfileId, lastUsedAt, archived',
    profiles: 'id, name, kind, lastUsedAt, archived',
    settings: '&key',
  })
}

function registerLegacyStreamLeasesV20(db: Dexie): void {
  db.version(20).stores({
    settings: '&key',
    messages:
      'id, chatId, parentId, turnId, [chatId+parentId], [chatId+createdAt], [chatId+turnId], [chatId+deleted]',
    messageBodies: '&id, chatId, updatedAt, nodeVersion',
    streamLeases: '&streamId, chatId, ownerClientId, heartbeatAt',
    streamChunks: '&id, streamId, chatId, messageId, [streamId+seq], createdAt',
  })
}

function registerLegacyAttemptOutcomesV21(db: Dexie): void {
  db.version(21).stores({
    settings: '&key',
    messages:
      'id, chatId, parentId, turnId, [chatId+parentId], [chatId+createdAt], [chatId+turnId], [chatId+deleted]',
    messageBodies: '&id, chatId, updatedAt, nodeVersion',
    streamChunks: '&id, streamId, chatId, messageId, [streamId+seq], createdAt',
  })
}

function registerLegacyAttachmentReferenceEdgesV21(db: Dexie): void {
  db.version(21).stores({
    attachments: 'id, refCount',
    attachmentBlobs: 'id, attachmentId',
    attachmentArtifacts: 'artifactId, attachmentId',
    attachmentJobs: 'id, attachmentId',
    messages: 'id, chatId',
    drafts: '&chatId',
    messageBodies: '&id, chatId, updatedAt, nodeVersion',
    streamChunks: '&id, streamId, chatId, messageId, [streamId+seq], createdAt',
  })
}

function canonicalAttachmentRef(
  refId: string,
  attachmentId: string,
  patch: Partial<MessageAttachmentRef> = {},
): MessageAttachmentRef {
  return {
    refId,
    attachmentId,
    includeInContext: true,
    presentation: {},
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  }
}

function findAttachmentReferenceEdgeMigrationError(
  input: unknown,
): AttachmentReferenceEdgeMigrationError | undefined {
  let current = input
  const seen = new Set<unknown>()
  while (current && typeof current === 'object' && !seen.has(current)) {
    if (current instanceof AttachmentReferenceEdgeMigrationError) return current
    seen.add(current)
    const record = current as { inner?: unknown; cause?: unknown }
    current = record.inner ?? record.cause
  }
  return undefined
}

describe('Dexie migrations', () => {
  it('rebuilds normalized attachment edges and exact refcounts once in v22', async () => {
    const name = `natter-test-attachment-edges-v22-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)

    const messageRefs = [
      canonicalAttachmentRef('message-a-1', 'attachment-a', { includeInContext: false }),
      canonicalAttachmentRef('message-b-deleted', 'attachment-b', { deletedAt: 10 }),
      canonicalAttachmentRef('message-a-2', 'attachment-a'),
    ]
    const draftRefs = [
      canonicalAttachmentRef('draft-b', 'attachment-b'),
      canonicalAttachmentRef('draft-missing-deleted', 'attachment-missing', { deletedAt: 11 }),
    ]

    const legacy = new Dexie(name)
    registerLegacyAttachmentReferenceEdgesV21(legacy)
    await legacy.open()
    await legacy.table<Record<string, unknown>>('attachments').bulkPut([
      { id: 'attachment-a', refCount: 91 },
      { id: 'attachment-b', refCount: 92 },
      { id: 'attachment-unreferenced', refCount: 93 },
    ])
    await legacy.table<Record<string, unknown>>('messages').put({
      id: 'message-1',
      chatId: 'chat-1',
      deleted: true,
      attachmentRefs: structuredClone(messageRefs),
    })
    await legacy.table<Record<string, unknown>>('messages').put({
      id: 'message-legacy-strings',
      chatId: 'chat-1',
      createdAt: 12,
      attachmentRefs: ['attachment-b'],
    })
    await legacy.table<Record<string, unknown>>('drafts').put({
      chatId: 'chat-1',
      attachmentRefs: structuredClone(draftRefs),
    })
    legacy.close()

    const migrated = createDbForTests(name)
    await migrated.open()
    expect(migrated.verno).toBe(23)
    expect(await migrated.attachmentRefEdges.toArray()).toEqual(
      expect.arrayContaining<AttachmentReferenceEdge>([
        {
          ownerKind: 'message',
          ownerId: 'message-1',
          chatId: 'chat-1',
          refId: 'message-a-1',
          attachmentId: 'attachment-a',
          ordinal: 0,
        },
        {
          ownerKind: 'message',
          ownerId: 'message-1',
          chatId: 'chat-1',
          refId: 'message-a-2',
          attachmentId: 'attachment-a',
          ordinal: 2,
        },
        {
          ownerKind: 'draft',
          ownerId: 'chat-1',
          chatId: 'chat-1',
          refId: 'draft-b',
          attachmentId: 'attachment-b',
          ordinal: 0,
        },
        {
          ownerKind: 'message',
          ownerId: 'message-legacy-strings',
          chatId: 'chat-1',
          refId: 'legacy:message-legacy-strings:0',
          attachmentId: 'attachment-b',
          ordinal: 0,
        },
      ]),
    )
    expect(await migrated.attachmentRefEdges.count()).toBe(4)
    expect((await migrated.attachments.get('attachment-a'))?.refCount).toBe(2)
    expect((await migrated.attachments.get('attachment-b'))?.refCount).toBe(2)
    expect((await migrated.attachments.get('attachment-unreferenced'))?.refCount).toBe(0)
    expect((await migrated.messages.get('message-1'))?.attachmentRefs).toEqual(messageRefs)
    expect((await migrated.messages.get('message-legacy-strings'))?.attachmentRefs).toEqual([
      expect.objectContaining({
        refId: 'legacy:message-legacy-strings:0',
        attachmentId: 'attachment-b',
      }),
    ])
    expect((await migrated.drafts.get('chat-1'))?.attachmentRefs).toEqual(draftRefs)
    expect((await migrated.settings.get('backfill:attachment-refs-v1'))?.value).toBe(1)

    const expectedEdges = await migrated.attachmentRefEdges.toArray()
    await migrated.transaction(
      'rw',
      [migrated.attachmentRefEdges, migrated.attachments, migrated.messages, migrated.drafts],
      async (tx) => {
        await rebuildAttachmentReferenceEdges(tx)
        await rebuildAttachmentReferenceEdges(tx)
      },
    )
    expect(await migrated.attachmentRefEdges.toArray()).toEqual(expectedEdges)
    await migrated.attachments.update('attachment-a', { refCount: 19 })
    migrated.close()

    const reopened = createDbForTests(name)
    await reopened.open()
    expect(await reopened.attachmentRefEdges.toArray()).toEqual(expectedEdges)
    expect((await reopened.attachments.get('attachment-a'))?.refCount).toBe(19)
    await reopened.delete()
  })

  it('scrubs stale byte-derived pointers from missing attachments once in v22', async () => {
    const name = `natter-test-missing-attachment-v22-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)
    const textArtifact = {
      kind: 'text',
      artifactId: 'artifact-text',
      attachmentId: 'attachment-missing',
      processorId: 'extract-v1',
      text: 'retained text',
      charCount: 13,
      createdAt: 1,
    }
    const blobArtifact = {
      kind: 'blob',
      artifactId: 'artifact-thumbnail',
      attachmentId: 'attachment-missing',
      processorId: 'thumbnail-v1',
      blobId: 'blob-thumbnail',
      createdAt: 1,
    }
    const legacy = new Dexie(name)
    registerLegacyAttachmentReferenceEdgesV21(legacy)
    await legacy.open()
    await legacy.table('attachments').put({
      id: 'attachment-missing',
      kind: 'plaintext',
      mime: 'text/plain',
      filename: 'missing.txt',
      origin: 'user-upload',
      createdAt: 1,
      updatedAt: 2,
      storage: {
        kind: 'missing',
        reason: 'deleted',
        missingSince: 2,
        lastKnownBlobId: 'blob-original',
      },
      thumbnailBlobId: 'blob-thumbnail',
      artifacts: [textArtifact, blobArtifact],
      processing: [
        {
          processorId: 'mixed-v1',
          inputHash: 'hash',
          status: 'succeeded',
          outputArtifactIds: ['artifact-text', 'artifact-thumbnail'],
        },
        {
          processorId: 'thumbnail-v1',
          inputHash: 'hash',
          status: 'succeeded',
          outputArtifactIds: ['artifact-thumbnail'],
        },
      ],
      refCount: 0,
    })
    await legacy.table('attachmentBlobs').bulkPut([
      { id: 'blob-original', attachmentId: 'attachment-missing' },
      { id: 'blob-thumbnail', attachmentId: 'attachment-missing' },
    ])
    await legacy.table('attachmentArtifacts').bulkPut([textArtifact, blobArtifact])
    await legacy.table('attachmentJobs').bulkPut([
      {
        id: 'arbitrary-mixed-job',
        attachmentId: 'attachment-missing',
        processorId: 'mixed-v1',
        inputHash: 'hash',
        status: 'succeeded',
        outputArtifactIds: ['artifact-text', 'artifact-thumbnail'],
        updatedAt: 2,
      },
      {
        id: 'arbitrary-thumbnail-job',
        attachmentId: 'attachment-missing',
        processorId: 'thumbnail-v1',
        inputHash: 'hash',
        status: 'succeeded',
        outputArtifactIds: ['artifact-thumbnail'],
        updatedAt: 2,
      },
    ])
    legacy.close()

    const migrated = createDbForTests(name)
    await migrated.open()
    const attachment = await migrated.attachments.get('attachment-missing')
    expect(attachment?.thumbnailBlobId).toBeUndefined()
    expect(attachment).not.toHaveProperty('artifacts')
    expect(attachment).toHaveProperty('artifactIds', [textArtifact.artifactId])
    expect(attachment?.processing).toEqual([
      expect.objectContaining({ processorId: 'mixed-v1', outputArtifactIds: ['artifact-text'] }),
    ])
    expect(await migrated.attachmentBlobs.count()).toBe(0)
    expect(await migrated.attachmentArtifacts.toArray()).toEqual([textArtifact])
    expect(await migrated.attachmentJobs.toArray()).toEqual([
      expect.objectContaining({ id: 'arbitrary-mixed-job', outputArtifactIds: ['artifact-text'] }),
    ])

    await migrated.attachments.update('attachment-missing', {
      thumbnailBlobId: 'post-migration-sentinel',
    })
    migrated.close()
    const reopened = createDbForTests(name)
    await reopened.open()
    expect((await reopened.attachments.get('attachment-missing'))?.thumbnailBlobId).toBe(
      'post-migration-sentinel',
    )
    await reopened.delete()
  })

  it.each([
    {
      label: 'duplicate ref IDs',
      expectedCode: 'duplicate-ref-id' as const,
      refs: [
        canonicalAttachmentRef('duplicate', 'attachment-a'),
        canonicalAttachmentRef('duplicate', 'attachment-a', { deletedAt: 9 }),
      ],
    },
    {
      label: 'a missing target for a live ref',
      expectedCode: 'missing-attachment' as const,
      refs: [canonicalAttachmentRef('missing', 'attachment-missing')],
    },
  ])('rejects $label and rolls the entire v22 upgrade back', async ({ expectedCode, refs }) => {
    const name = `natter-test-attachment-edges-poison-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)
    const legacy = new Dexie(name)
    registerLegacyAttachmentReferenceEdgesV21(legacy)
    await legacy.open()
    await legacy.table<Record<string, unknown>>('attachments').put({
      id: 'attachment-a',
      refCount: 77,
    })
    await legacy.table<Record<string, unknown>>('messages').put({
      id: 'message-poison',
      chatId: 'chat-poison',
      attachmentRefs: structuredClone(refs),
    })
    legacy.close()

    const attempted = createDbForTests(name)
    let failure: unknown
    try {
      await attempted.open()
    } catch (error) {
      failure = error
    }
    expect(findAttachmentReferenceEdgeMigrationError(failure)).toMatchObject({
      code: expectedCode,
      ownerKind: 'message',
      ownerId: 'message-poison',
    })
    attempted.close()

    const inspection = new Dexie(name)
    registerLegacyAttachmentReferenceEdgesV21(inspection)
    await inspection.open()
    expect(inspection.verno).toBe(21)
    expect(
      (await inspection.table<Record<string, unknown>>('attachments').get('attachment-a'))
        ?.refCount,
    ).toBe(77)
    expect(inspection.tables.some((table) => table.name === 'attachmentRefEdges')).toBe(false)
    expect(
      (await inspection.table<Record<string, unknown>>('messages').get('message-poison'))
        ?.attachmentRefs,
    ).toEqual(refs)
    if (expectedCode === 'duplicate-ref-id') {
      await inspection.table<Record<string, unknown>>('messages').update('message-poison', {
        attachmentRefs: [structuredClone(refs[0])],
      })
    } else {
      await inspection.table<Record<string, unknown>>('attachments').put({
        id: 'attachment-missing',
        refCount: 0,
      })
    }
    inspection.close()

    const retried = createDbForTests(name)
    await retried.open()
    expect(retried.verno).toBe(23)
    expect(await retried.attachmentRefEdges.count()).toBe(1)
    expect((await retried.settings.get('backfill:attachment-refs-v1'))?.value).toBe(1)
    await retried.delete()
  })

  it('opens a fresh DB at the highest declared version without replaying upgrade callbacks', async () => {
    // Dexie's contract: on a truly fresh IDB, it creates the union of all
    // declared tables at the latest version and skips upgrade() callbacks —
    // there's no data to migrate. This test pins that contract so the
    // migration-backfill tests below can rely on "upgrades only fire when
    // transitioning from a lower on-disk version."
    const name = `natter-test-mig-fresh-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)
    const db = new Dexie(name)
    registerV1Through3(db)
    await db.open()
    expect(db.verno).toBe(SYNTHETIC_SETTINGS_SEED_VERSION)
    expect(db.tables.map((t) => t.name).includes('settings')).toBe(true)
    const tag = await db.table<MinimalSetting>('settings').get('schemaTag')
    expect(tag).toBeUndefined()
    await db.delete()
  })

  it('is idempotent across re-opens — upgrade callbacks do not rerun on already-migrated data', async () => {
    const name = `natter-test-mig-reopen-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)

    const v1 = new Dexie(name)
    registerV1(v1)
    await v1.open()
    await v1.table<MinimalProfile>('profiles').put({
      id: 'P1',
      name: 'Existing',
      kind: 'openrouter',
      baseUrl: 'https://example',
      apiKeyRef: 'K1',
      defaultHeaders: {},
      appTitle: 'CustomTitle',
      appUrl: '',
      usesResponsesApiByDefault: false,
      supportsEndpointsApi: false,
      supportsGenerationApi: false,
      supportsPrivacyScrape: false,
      createdAt: 1,
      updatedAt: 1,
    })
    await v1.table<MinimalSetting>('settings').put({ key: 'schemaTag', value: 'preexisting' })
    v1.close()

    const up = new Dexie(name)
    registerV1Through3(up)
    await up.open()
    expect(up.verno).toBe(SYNTHETIC_SETTINGS_SEED_VERSION)
    const profile = await up.table<MinimalProfile>('profiles').get('P1')
    expect(profile?.appTitle).toBe('CustomTitle') // preserved — synthetic bump only fills undefined
    const tag = await up.table<MinimalSetting>('settings').get('schemaTag')
    expect(tag?.value).toBe('preexisting') // later synthetic bump only seeds when absent
    up.close()

    const reopen = new Dexie(name)
    registerV1Through3(reopen)
    await reopen.open()
    expect(reopen.verno).toBe(SYNTHETIC_SETTINGS_SEED_VERSION)
    const tag2 = await reopen.table<MinimalSetting>('settings').get('schemaTag')
    expect(tag2?.value).toBe('preexisting')
    await reopen.delete()
  })

  it('backfills defaults only for rows missing the field (second synthetic bump is a no-op when fields are present)', async () => {
    const name = `natter-test-mig-backfill-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)
    const v1 = new Dexie(name)
    registerV1(v1)
    await v1.open()
    await v1.table<MinimalProfile>('profiles').put({
      id: 'P2',
      name: 'Bare',
      kind: 'openrouter',
      baseUrl: 'https://example',
      apiKeyRef: 'K1',
      defaultHeaders: {},
      // deliberately omit appTitle — synthetic bump must set it
      appUrl: '',
      usesResponsesApiByDefault: false,
      supportsEndpointsApi: false,
      supportsGenerationApi: false,
      supportsPrivacyScrape: false,
      createdAt: 1,
      updatedAt: 1,
    })
    v1.close()

    const up = new Dexie(name)
    registerV1Through3(up)
    await up.open()
    const row = await up.table<MinimalProfile>('profiles').get('P2')
    expect(row?.appTitle).toBe('Natter') // synthetic bump backfilled
    await up.delete()
  })

  it('classifies and fences legacy stream leases in the single v20 to v22 upgrade', async () => {
    const name = `natter-test-stream-lease-v21-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)

    const legacy = new Dexie(name)
    registerLegacyStreamLeasesV20(legacy)
    await legacy.open()
    await legacy.table<Record<string, unknown>>('messages').bulkPut([
      {
        id: 'message-generating',
        chatId: 'chat-1',
        nodeVersion: 4,
        generation: { startedAt: 1 },
      },
      {
        id: 'message-complete',
        chatId: 'chat-1',
        nodeVersion: 7,
        generation: { startedAt: 1, finishedAt: 2 },
      },
      {
        id: 'message-without-generation',
        chatId: 'chat-1',
        nodeVersion: 9,
      },
    ])
    const legacyLeases: StreamLeaseRow[] = [
      {
        streamId: 'original-stream',
        chatId: 'chat-1',
        messageId: 'message-generating',
        ownerClientId: 'tab-1',
        startedAt: 1,
        heartbeatAt: 2,
      },
      {
        streamId: 'continue-stream',
        chatId: 'chat-1',
        messageId: 'message-complete',
        ownerClientId: 'tab-1',
        startedAt: 3,
        heartbeatAt: 4,
      },
      {
        streamId: 'continue-without-generation',
        chatId: 'chat-1',
        messageId: 'message-without-generation',
        ownerClientId: 'tab-1',
        startedAt: 5,
        heartbeatAt: 6,
      },
      {
        streamId: 'continue-without-header',
        chatId: 'chat-1',
        messageId: 'missing-message',
        ownerClientId: 'tab-1',
        startedAt: 7,
        heartbeatAt: 8,
      },
      {
        streamId: 'already-classified',
        chatId: 'chat-1',
        messageId: 'message-complete',
        ownerClientId: 'tab-2',
        startedAt: 9,
        heartbeatAt: 10,
        attemptKind: 'generation',
        requestedModel: 'model-a',
        apiUsed: 'responses',
      },
    ]
    await legacy.table<StreamLeaseRow>('streamLeases').bulkPut(legacyLeases)
    legacy.close()

    const migrated = createDbForTests(name)
    await migrated.open()
    expect(migrated.verno).toBe(23)
    expect(await migrated.streamLeases.get('original-stream')).toEqual({
      ...legacyLeases[0],
      attemptKind: 'generation',
      fenceToken: 'legacy:original-stream',
      replacementEpoch: 0,
    })
    expect(await migrated.streamLeases.get('continue-stream')).toEqual({
      ...legacyLeases[1],
      attemptKind: 'continuation',
      baseNodeVersion: 7,
      fenceToken: 'legacy:continue-stream',
      replacementEpoch: 0,
    })
    expect(await migrated.streamLeases.get('continue-without-generation')).toEqual({
      ...legacyLeases[2],
      attemptKind: 'continuation',
      baseNodeVersion: 9,
      fenceToken: 'legacy:continue-without-generation',
      replacementEpoch: 0,
    })
    expect(await migrated.streamLeases.get('continue-without-header')).toEqual({
      ...legacyLeases[3],
      attemptKind: 'continuation',
      fenceToken: 'legacy:continue-without-header',
      replacementEpoch: 0,
    })
    expect(await migrated.streamLeases.get('already-classified')).toEqual({
      ...legacyLeases[4],
      fenceToken: 'legacy:already-classified',
      replacementEpoch: 0,
    })
    expect(await migrated.streamLeases.get('continue-stream')).not.toHaveProperty('requestedModel')
    expect(await migrated.streamLeases.get('continue-stream')).not.toHaveProperty('apiUsed')
    expect(await migrated.streamLeases.get('continue-stream')).not.toHaveProperty(
      'continuationStrategy',
    )
    await migrated.delete()
  })

  it('does not rerun the lease classifier or fence migration after v22 is current', async () => {
    const name = `natter-test-stream-lease-v21-idempotent-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)

    const legacy = new Dexie(name)
    registerLegacyStreamLeasesV20(legacy)
    await legacy.open()
    await legacy.table<Record<string, unknown>>('messages').put({
      id: 'message-complete',
      chatId: 'chat-1',
      nodeVersion: 7,
      generation: { startedAt: 1, finishedAt: 2 },
    })
    await legacy.table<StreamLeaseRow>('streamLeases').put({
      streamId: 'continue-stream',
      chatId: 'chat-1',
      messageId: 'message-complete',
      ownerClientId: 'tab-1',
      startedAt: 3,
      heartbeatAt: 4,
    })
    legacy.close()

    const migrated = createDbForTests(name)
    await migrated.open()
    const classified = await migrated.streamLeases.get('continue-stream')
    expect(classified).toMatchObject({ attemptKind: 'continuation', baseNodeVersion: 7 })
    if (!classified) throw new Error('expected migrated stream lease')
    const manuallyChanged: StreamLeaseRow = { ...classified, attemptKind: 'generation' }
    delete manuallyChanged.baseNodeVersion
    await migrated.streamLeases.put(manuallyChanged)
    migrated.close()

    const reopened = createDbForTests(name)
    await reopened.open()
    expect(await reopened.streamLeases.get('continue-stream')).toEqual(manuallyChanged)
    await reopened.delete()
  })

  it.each([
    20, 21,
  ])('adds the workspace replacement epoch once when upgrading v%i to v22', async (legacyVersion) => {
    const name = `natter-test-workspace-meta-v${legacyVersion}-v22-${Math.random()
      .toString(36)
      .slice(2)}`
    await Dexie.delete(name)

    const legacy = new Dexie(name)
    if (legacyVersion === 20) registerLegacyStreamLeasesV20(legacy)
    else registerLegacyAttemptOutcomesV21(legacy)
    await legacy.open()
    const legacyValue = {
      workspaceId: 'browser-idb:natter',
      backendKind: 'browser-idb',
      lastMutationAt: 123,
      mutationCounter: 17,
    }
    await legacy.table('settings').put({ key: 'workspace-meta', value: legacyValue })
    legacy.close()

    const migrated = createDbForTests(name)
    await migrated.open()
    expect((await migrated.settings.get('workspace-meta'))?.value).toEqual({
      ...legacyValue,
      replacementEpoch: 0,
    })
    await migrated.settings.put({
      key: 'workspace-meta',
      value: { ...legacyValue, replacementEpoch: 9 },
    })
    migrated.close()

    const reopened = createDbForTests(name)
    await reopened.open()
    expect((await reopened.settings.get('workspace-meta'))?.value).toEqual({
      ...legacyValue,
      replacementEpoch: 9,
    })
    await reopened.delete()
  })

  it('migrates v21 attempt outcomes once and strips raw failure payloads in v22', async () => {
    const name = `natter-test-attempt-outcomes-v22-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)

    const legacy = new Dexie(name)
    registerLegacyAttemptOutcomesV21(legacy)
    await legacy.open()
    await legacy.table<Record<string, unknown>>('messages').bulkPut([
      {
        id: 'streaming',
        chatId: 'chat-1',
        generation: { startedAt: 1 },
      },
      {
        id: 'failed',
        chatId: 'chat-1',
        generation: {
          startedAt: 1,
          finishedAt: 2,
          error: {
            code: 'NETWORK',
            message: 'connection lost',
            raw: { kind: 'network', metadata: { authorization: 'raw-secret' } },
          },
        },
      },
      {
        id: 'interrupted',
        chatId: 'chat-1',
        generation: { startedAt: 1, finishedAt: 2, abortReason: 'tab-close' },
      },
      {
        id: 'done',
        chatId: 'chat-1',
        generation: { startedAt: 1, finishedAt: 2 },
      },
    ])
    await legacy.table<Record<string, unknown>>('messageBodies').put({
      id: 'failed',
      chatId: 'chat-1',
      nodeVersion: 0,
      updatedAt: 2,
      content: [],
      continuationAttempts: [
        {
          streamId: 'continue-1',
          strategy: 'prompt',
          status: 'error',
          startedAt: 1,
          finishedAt: 2,
          error: {
            code: 502,
            message: 'Bearer sk-private-value',
            raw: { kind: 'provider_error', metadata: { prompt: 'raw-secret' } },
          },
        },
      ],
    })
    await legacy.table<Record<string, unknown>>('streamChunks').put({
      id: 'stream-1:0',
      streamId: 'stream-1',
      chatId: 'chat-1',
      messageId: 'failed',
      seq: 0,
      createdAt: 2,
      event: {
        lane: 'error',
        error: {
          kind: 'provider_error',
          code: 502,
          message: 'provider failed',
          midStream: true,
          retryable: true,
          metadata: { output: 'raw-secret' },
        },
      },
    })
    legacy.close()

    const migrated = createDbForTests(name)
    await migrated.open()
    expect(migrated.verno).toBe(23)
    expect((await migrated.messages.get('streaming'))?.generation).toMatchObject({
      status: 'streaming',
      integrity: 'clean',
    })
    expect((await migrated.messages.get('failed'))?.generation).toMatchObject({
      status: 'error',
      integrity: 'clean',
      error: {
        category: 'network',
        code: 'NETWORK',
        message: 'connection lost',
      },
    })
    expect((await migrated.messages.get('interrupted'))?.generation).toMatchObject({
      status: 'interrupted',
      integrity: 'clean',
    })
    expect((await migrated.messages.get('done'))?.generation).toMatchObject({
      status: 'done',
      integrity: 'clean',
    })
    const body = await migrated.messageBodies.get('failed')
    expect(body?.continuationAttempts?.[0]).toMatchObject({
      status: 'error',
      integrity: 'clean',
      error: {
        category: 'provider',
        code: '502',
        message: 'Bearer <redacted>',
      },
    })
    const chunk = await migrated.streamChunks.get('stream-1:0')
    expect(chunk?.event).toEqual({
      lane: 'error',
      error: {
        kind: 'provider_error',
        code: '502',
        message: 'provider failed',
        midStream: true,
        retryable: true,
      },
    })
    expect(
      JSON.stringify({ failed: await migrated.messages.get('failed'), body, chunk }),
    ).not.toContain('raw-secret')

    await migrated.messages.update('done', { 'generation.integrity': 'failed' } as never)
    migrated.close()
    const reopened = createDbForTests(name)
    await reopened.open()
    expect((await reopened.messages.get('done'))?.generation?.integrity).toBe('failed')
    await reopened.delete()
  })

  it('moves released-v20 header continuation attempts into message bodies exactly once', async () => {
    const name = `natter-test-v20-continuation-attempt-body-split-${Math.random()
      .toString(36)
      .slice(2)}`
    await Dexie.delete(name)

    const legacy = new Dexie(name)
    registerLegacyStreamLeasesV20(legacy)
    await legacy.open()
    await legacy.table<Record<string, unknown>>('messages').put({
      id: 'continued-message',
      chatId: 'chat-1',
      nodeVersion: 4,
      continuationAttempts: [
        {
          streamId: 'shared-stream',
          strategy: 'prompt',
          status: 'error',
          requestedModel: 'header-requested-model',
          provider: 'header-provider',
          startedAt: 1,
          finishedAt: 2,
          error: {
            code: 'NETWORK',
            message: 'Bearer sk-header-private',
            raw: { kind: 'network', metadata: { prompt: 'raw-header-secret' } },
          },
        },
        {
          streamId: 'header-only-stream',
          strategy: 'prompt',
          status: 'error',
          startedAt: 3,
          finishedAt: 4,
          error: {
            code: 502,
            message: 'Bearer sk-header-only-private',
            raw: { kind: 'provider_error', metadata: { output: 'raw-header-only-secret' } },
          },
        },
      ],
    })
    await legacy.table<Record<string, unknown>>('messageBodies').put({
      id: 'continued-message',
      chatId: 'chat-1',
      nodeVersion: 4,
      updatedAt: 5,
      content: [],
      continuationAttempts: [
        {
          streamId: 'shared-stream',
          strategy: 'prefill',
          status: 'error',
          model: 'body-model',
          startedAt: 10,
          finishedAt: 20,
        },
        {
          streamId: 'body-only-stream',
          strategy: 'prompt',
          status: 'done',
          startedAt: 30,
          finishedAt: 40,
        },
      ],
    })
    legacy.close()

    const migrated = createDbForTests(name)
    await migrated.open()
    expect(migrated.verno).toBe(23)
    const migratedHeader = (await migrated.messages.get('continued-message')) as unknown as Record<
      string,
      unknown
    >
    expect(migratedHeader).not.toHaveProperty('continuationAttempts')
    const migratedBody = await migrated.messageBodies.get('continued-message')
    expect(migratedBody?.continuationAttempts?.map((attempt) => attempt.streamId)).toEqual([
      'shared-stream',
      'body-only-stream',
      'header-only-stream',
    ])
    expect(migratedBody?.continuationAttempts?.[0]).toMatchObject({
      streamId: 'shared-stream',
      strategy: 'prefill',
      status: 'error',
      integrity: 'clean',
      requestedModel: 'header-requested-model',
      model: 'body-model',
      provider: 'header-provider',
      startedAt: 10,
      finishedAt: 20,
      error: {
        category: 'network',
        code: 'NETWORK',
        message: 'Bearer <redacted>',
      },
    })
    expect(migratedBody?.continuationAttempts?.[1]).toMatchObject({
      streamId: 'body-only-stream',
      integrity: 'clean',
    })
    expect(migratedBody?.continuationAttempts?.[2]).toMatchObject({
      streamId: 'header-only-stream',
      integrity: 'clean',
      error: {
        category: 'provider',
        code: '502',
        message: 'Bearer <redacted>',
      },
    })
    expect(JSON.stringify(migratedBody)).not.toContain('raw-header')

    const manuallyEditedAttempts = [
      {
        ...(migratedBody?.continuationAttempts?.[0] ?? {
          streamId: 'shared-stream',
          strategy: 'prefill' as const,
          status: 'error' as const,
          startedAt: 10,
          finishedAt: 20,
        }),
        model: 'manual-model',
      },
    ]
    await migrated.messageBodies.update('continued-message', {
      continuationAttempts: manuallyEditedAttempts,
    })
    const manuallyRestoredHeaderAttempts = [
      {
        streamId: 'manual-header-stream',
        strategy: 'prompt',
        status: 'done',
        startedAt: 50,
        finishedAt: 60,
      },
    ]
    await migrated.messages.update('continued-message', {
      continuationAttempts: manuallyRestoredHeaderAttempts,
    } as never)
    migrated.close()

    const reopened = createDbForTests(name)
    await reopened.open()
    expect((await reopened.messageBodies.get('continued-message'))?.continuationAttempts).toEqual(
      manuallyEditedAttempts,
    )
    expect(
      (await reopened.messages.get('continued-message')) as unknown as Record<string, unknown>,
    ).toHaveProperty('continuationAttempts', manuallyRestoredHeaderAttempts)
    await reopened.delete()
  })

  it('populates a fresh v22 database without requiring a legacy lease pass', async () => {
    const name = `natter-test-stream-lease-v21-fresh-${Math.random().toString(36).slice(2)}`
    const db = await freshDb(name)
    await db.open()

    expect(db.verno).toBe(23)
    expect(await db.streamLeases.count()).toBe(0)
    expect((await db.settings.get('backfill:message-body-split-v1'))?.value).toBe(1)
    const lease: StreamLeaseRow = {
      streamId: 'continue-stream',
      chatId: 'chat-1',
      messageId: 'message-1',
      ownerClientId: 'tab-1',
      startedAt: 1,
      heartbeatAt: 2,
      attemptKind: 'continuation',
      continuationStrategy: 'prefill',
      baseNodeVersion: 3,
      requestedModel: 'model-a',
      apiUsed: 'responses',
    }
    await db.streamLeases.put(lease)
    expect(await db.streamLeases.get(lease.streamId)).toEqual(lease)
    await db.delete()
  })

  it('deletes the retired open-scroll preference during schema upgrade', async () => {
    const name = `natter-test-open-scroll-mig-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)

    const legacy = new Dexie(name)
    registerLegacyChatSettingsV14(legacy)
    await legacy.open()
    await legacy.table<MinimalSetting>('settings').bulkPut([
      { key: 'global:auto-scroll-open', value: false },
      { key: 'global:auto-scroll-stream', value: false },
    ])
    legacy.close()

    const migrated = createDbForTests(name)
    await migrated.open()
    expect(await migrated.settings.get('global:auto-scroll-open')).toBeUndefined()
    expect((await migrated.settings.get('global:auto-scroll-stream'))?.value).toBe(false)
    await migrated.delete()
  })

  it('seeds render-window defaults during schema upgrade', async () => {
    const name = `natter-test-render-window-mig-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)

    const legacy = new Dexie(name)
    registerLegacyChatSettingsV14(legacy)
    await legacy.open()
    await legacy
      .table<MinimalSetting>('settings')
      .put({ key: 'global:message-render-window-size', value: 33 })
    legacy.close()

    const migrated = createDbForTests(name)
    await migrated.open()
    expect(migrated.verno).toBe(23)
    expect((await migrated.settings.get('global:message-render-window-size'))?.value).toBe(33)
    expect((await migrated.settings.get('global:sidebar-render-window-size'))?.value).toBe(50)
    expect((await migrated.settings.get('global:message-render-window-load-mode'))?.value).toBe(
      'auto',
    )
    expect((await migrated.settings.get('global:sidebar-render-window-load-mode'))?.value).toBe(
      'auto',
    )
    await migrated.delete()
  })

  it('migrates legacy privacy provider refs on chats and presets into providerPrefs', async () => {
    const name = `natter-test-provider-mig-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)
    const profileId = 'profile-1'
    const modelId = 'anthropic/claude-opus-4.7'
    const baseSettings = {
      ...cloneDefaultChatSettings(),
      profileId,
      model: modelId,
      privacy: {
        ...cloneDefaultChatSettings().privacy,
        ignoreProviders: ['Anthropic'],
        onlyProviders: [],
      },
    }

    const v3 = new Dexie(name)
    registerLegacyProviderPrefsV3(v3)
    await v3.open()
    await v3.table('endpoints').put({
      profileId,
      modelId,
      fetchedAt: 1,
      payload: {
        data: {
          id: modelId,
          endpoints: [
            legacyEndpoint('Amazon Bedrock', 'amazon-bedrock', {}),
            legacyEndpoint('Anthropic', 'anthropic', { requiresUserIDs: true }),
            legacyEndpoint('Anthropic', 'anthropic/2', { requiresUserIDs: true }),
          ],
        },
      },
    })
    await v3.table<Chat>('chats').put({
      id: 'chat-1',
      title: '',
      titleStatus: 'untitled',
      createdAt: 1,
      updatedAt: 1,
      lastViewedAt: 1,
      wordCount: 0,
      totalCostUsd: 0,
      metaVersion: 0,
      summaryVersion: 0,
      settings: structuredClone(baseSettings),
      lastUpdatedLeafId: null,
      lastBranchUpdatedAt: 1,
      archived: false,
      pinned: false,
      folderId: null,
      tags: [],
    })
    await v3.table<Record<string, unknown>>('presets').put({
      id: 'preset-1',
      name: 'Preset',
      connectionProfileId: profileId,
      settings: structuredClone(baseSettings),
      createdAt: 1,
      updatedAt: 1,
    })
    v3.close()

    const migrated = createDbForTests(name)
    await migrated.open()
    const chat = await migrated.chats.get('chat-1')
    const preset = await migrated.presets.get('preset-1')
    expect('ignoreProviders' in (chat?.settings.privacy ?? {})).toBe(false)
    expect('onlyProviders' in (chat?.settings.privacy ?? {})).toBe(false)
    expect(chat?.settings.providerPrefs?.ignoreOverridesFilter).toBe(true)
    expect(chat?.settings.providerPrefs?.ignore).toEqual(['anthropic', 'anthropic/2'])
    expect('ignoreProviders' in (preset?.settings.privacy ?? {})).toBe(false)
    expect(preset?.settings.providerPrefs?.ignore).toEqual(['anthropic', 'anthropic/2'])
    await migrated.delete()
  })

  it('migrates missing OpenRouter provider sort on old chats and presets', async () => {
    const name = `natter-test-provider-sort-mig-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)
    const openRouterProfileId = 'profile-openrouter'
    const directProfileId = 'profile-direct'
    const baseSettings = cloneDefaultChatSettings()
    baseSettings.profileId = openRouterProfileId
    baseSettings.model = 'anthropic/claude-opus-4.7'
    baseSettings.privacy = {
      ...baseSettings.privacy,
      usePreferredOrdering: true,
    } as unknown as Chat['settings']['privacy']
    const directSettings = cloneDefaultChatSettings()
    directSettings.profileId = directProfileId
    directSettings.model = 'gpt-4o'
    directSettings.privacy = {
      ...directSettings.privacy,
      usePreferredOrdering: false,
    } as unknown as Chat['settings']['privacy']

    const legacy = new Dexie(name)
    registerLegacyAttachmentsV5(legacy)
    await legacy.open()
    await legacy.table('profiles').bulkPut([
      {
        id: openRouterProfileId,
        name: 'OpenRouter',
        kind: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKeyRef: 'K1',
        defaultHeaders: {},
        appTitle: 'Natter',
        appUrl: '',
        usesResponsesApiByDefault: false,
        supportsEndpointsApi: true,
        supportsGenerationApi: true,
        supportsPrivacyScrape: true,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: directProfileId,
        name: 'OpenAI',
        kind: 'openai-compatible',
        baseUrl: 'https://api.openai.com/v1',
        apiKeyRef: 'K2',
        defaultHeaders: {},
        appTitle: 'Natter',
        appUrl: '',
        usesResponsesApiByDefault: true,
        supportsEndpointsApi: false,
        supportsGenerationApi: false,
        supportsPrivacyScrape: false,
        createdAt: 1,
        updatedAt: 1,
      },
    ])
    await legacy.table<Chat>('chats').bulkPut([
      {
        id: 'chat-or',
        title: '',
        titleStatus: 'untitled',
        createdAt: 1,
        updatedAt: 1,
        lastViewedAt: 1,
        wordCount: 0,
        totalCostUsd: 0,
        metaVersion: 0,
        summaryVersion: 0,
        settings: structuredClone(baseSettings),
        lastUpdatedLeafId: null,
        lastBranchUpdatedAt: 1,
        archived: false,
        pinned: false,
        folderId: null,
        tags: [],
      },
      {
        id: 'chat-direct',
        title: '',
        titleStatus: 'untitled',
        createdAt: 1,
        updatedAt: 1,
        lastViewedAt: 1,
        wordCount: 0,
        totalCostUsd: 0,
        metaVersion: 0,
        summaryVersion: 0,
        settings: structuredClone(directSettings),
        lastUpdatedLeafId: null,
        lastBranchUpdatedAt: 1,
        archived: false,
        pinned: false,
        folderId: null,
        tags: [],
      },
    ])
    await legacy.table<Record<string, unknown>>('presets').bulkPut([
      {
        id: 'preset-or',
        name: 'OpenRouter Preset',
        connectionProfileId: openRouterProfileId,
        settings: structuredClone(baseSettings),
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'preset-direct',
        name: 'Direct Preset',
        connectionProfileId: directProfileId,
        settings: structuredClone(directSettings),
        createdAt: 1,
        updatedAt: 1,
      },
    ])
    legacy.close()

    const migrated = createDbForTests(name)
    await migrated.open()
    const openRouterChat = await migrated.chats.get('chat-or')
    const openRouterPreset = await migrated.presets.get('preset-or')
    const directChat = await migrated.chats.get('chat-direct')
    const directPreset = await migrated.presets.get('preset-direct')

    expect(openRouterChat?.settings.providerPrefs).toEqual({ sort: 'price' })
    expect(openRouterPreset?.settings.providerPrefs).toEqual({ sort: 'price' })
    expect(directChat?.settings.providerPrefs).toBeUndefined()
    expect(directPreset?.settings.providerPrefs).toBeUndefined()
    expect('usePreferredOrdering' in (openRouterChat?.settings.privacy ?? {})).toBe(false)
    expect('usePreferredOrdering' in (openRouterPreset?.settings.privacy ?? {})).toBe(false)
    expect('usePreferredOrdering' in (directChat?.settings.privacy ?? {})).toBe(false)
    expect('usePreferredOrdering' in (directPreset?.settings.privacy ?? {})).toBe(false)
    await migrated.delete()
  })

  it('migrates legacy shared server-tool settings into provider-scoped buckets', async () => {
    const name = `natter-test-provider-tools-mig-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)
    const legacySettings = cloneDefaultChatSettings() as Chat['settings'] & {
      tools?: unknown
      enabledServerToolIds?: string[]
      toolChoice?: string
      parallelToolCalls?: boolean
    }
    delete (legacySettings as { tools?: unknown }).tools
    legacySettings.enabledServerToolIds = ['datetime', 'web-fetch']
    legacySettings.toolChoice = 'auto'
    legacySettings.parallelToolCalls = false

    const legacy = new Dexie(name)
    registerLegacyAttachmentsV5(legacy)
    await legacy.open()
    await legacy.table<Chat>('chats').put({
      id: 'chat-tools',
      title: '',
      titleStatus: 'untitled',
      createdAt: 1,
      updatedAt: 1,
      lastViewedAt: 1,
      wordCount: 0,
      totalCostUsd: 0,
      metaVersion: 0,
      summaryVersion: 0,
      settings: structuredClone(legacySettings),
      lastUpdatedLeafId: null,
      lastBranchUpdatedAt: 1,
      archived: false,
      pinned: false,
      folderId: null,
      tags: [],
    })
    await legacy.table<Record<string, unknown>>('presets').put({
      id: 'preset-tools',
      name: 'Tools',
      connectionProfileId: 'profile-tools',
      settings: structuredClone(legacySettings),
      createdAt: 1,
      updatedAt: 1,
    })
    legacy.close()

    const migrated = createDbForTests(name)
    await migrated.open()
    const chat = await migrated.chats.get('chat-tools')
    const preset = await migrated.presets.get('preset-tools')

    expect(chat?.settings.tools.openrouter).toEqual({
      enabledServerToolIds: ['datetime', 'web-fetch'],
      toolChoice: 'auto',
      parallelToolCalls: false,
    })
    expect(preset?.settings.tools.openrouter).toEqual(chat?.settings.tools.openrouter)
    expect(chat?.settings.tools.openai).toEqual({ enabledServerToolIds: [] })
    expect(chat?.settings.tools.anthropic).toEqual({ enabledServerToolIds: [] })
    expect(chat?.settings.tools.google).toEqual({ enabledServerToolIds: [] })
    expect(chat?.settings.toolCallContext).toEqual({ include: true })
    expect(preset?.settings.toolCallContext).toEqual({ include: true })
    expect('enabledServerToolIds' in ((chat?.settings ?? {}) as Record<string, unknown>)).toBe(
      false,
    )
    expect('toolChoice' in ((chat?.settings ?? {}) as Record<string, unknown>)).toBe(false)
    expect('parallelToolCalls' in ((chat?.settings ?? {}) as Record<string, unknown>)).toBe(false)
    await migrated.delete()
  })

  it('completes chat and preset settings snapshots in the v15 schema migration', async () => {
    const name = `natter-test-chat-settings-snapshot-mig-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)
    const profileId = 'profile-settings-snapshot'
    const legacySettings = cloneDefaultChatSettings() as Chat['settings'] & {
      enabledServerToolIds?: string[]
      toolChoice?: string
    }
    legacySettings.profileId = profileId
    legacySettings.model = 'openai/gpt-5.4-nano'
    legacySettings.reasoning = {
      mode: 'default',
      exclude: false,
      summary: 'auto',
      carryForward: 'plaintext',
    } as unknown as Chat['settings']['reasoning']
    legacySettings.privacy = {
      ...legacySettings.privacy,
      usePreferredOrdering: true,
    } as unknown as Chat['settings']['privacy']
    legacySettings.tools = {
      openai: {
        enabledServerToolIds: ['web-search'],
        config: { 'web-search': { includeSources: true } },
      },
    } as unknown as Chat['settings']['tools']
    legacySettings.enabledServerToolIds = ['datetime']
    legacySettings.toolChoice = 'auto'
    delete (legacySettings as Partial<Chat['settings']>).toolCallContext
    delete (legacySettings as Partial<Chat['settings']>).defaultPrefill
    delete (legacySettings as Partial<Chat['settings']>).continuePrefill
    delete (legacySettings as Partial<Chat['settings']>).mediaEchoN
    delete (legacySettings as Partial<Chat['settings']>).toolContextSummarizeAfterN
    delete (legacySettings as Partial<Chat['settings']>).serviceTier

    const legacy = new Dexie(name)
    registerLegacyChatSettingsV14(legacy)
    await legacy.open()
    await legacy.table('profiles').put({
      id: profileId,
      name: 'OpenRouter',
      kind: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKeyRef: 'K1',
      defaultHeaders: {},
      appTitle: 'Natter',
      appUrl: '',
      usesResponsesApiByDefault: false,
      supportsEndpointsApi: true,
      supportsGenerationApi: true,
      supportsPrivacyScrape: true,
      createdAt: 1,
      updatedAt: 1,
    })
    await legacy.table<Chat>('chats').put({
      id: 'chat-settings-snapshot',
      title: '',
      titleStatus: 'untitled',
      createdAt: 1,
      updatedAt: 1,
      lastViewedAt: 1,
      wordCount: 0,
      totalCostUsd: 0,
      metaVersion: 0,
      summaryVersion: 0,
      settings: structuredClone(legacySettings),
      lastUpdatedLeafId: null,
      lastBranchUpdatedAt: 1,
      archived: false,
      pinned: false,
      folderId: null,
      tags: [],
    })
    const presetSettings = structuredClone(legacySettings)
    presetSettings.profileId = 'stale-profile'
    await legacy.table<Record<string, unknown>>('presets').put({
      id: 'preset-settings-snapshot',
      name: 'Snapshot',
      connectionProfileId: profileId,
      settings: presetSettings,
      createdAt: 1,
      updatedAt: 1,
    })
    legacy.close()

    const migrated = createDbForTests(name)
    await migrated.open()
    expect(migrated.verno).toBe(23)
    const chat = await migrated.chats.get('chat-settings-snapshot')
    const preset = await migrated.presets.get('preset-settings-snapshot')
    for (const settings of [chat?.settings, preset?.settings]) {
      expect(settings?.defaultPrefill).toBe('')
      expect(settings?.continuePrefill).toBe(false)
      expect(settings?.mediaEchoN).toBe(5)
      expect(settings?.toolContextSummarizeAfterN).toBe(6)
      expect(settings?.toolCallContext).toEqual({ include: true })
      expect(settings?.serviceTier).toBe('auto')
      expect(settings?.tools.openrouter).toEqual({
        enabledServerToolIds: ['datetime'],
        toolChoice: 'auto',
      })
      expect(settings?.tools.openai).toEqual({
        enabledServerToolIds: ['web-search'],
        config: { 'web-search': { includeSources: true } },
      })
      expect(settings?.tools.anthropic).toEqual({ enabledServerToolIds: [] })
      expect(settings?.tools.google).toEqual({ enabledServerToolIds: [] })
      expect(settings?.reasoning.include).toEqual({
        encrypted: false,
        summary: true,
        text: true,
      })
      expect('carryForward' in ((settings?.reasoning ?? {}) as Record<string, unknown>)).toBe(false)
      expect('usePreferredOrdering' in ((settings?.privacy ?? {}) as Record<string, unknown>)).toBe(
        false,
      )
      expect('enabledServerToolIds' in ((settings ?? {}) as Record<string, unknown>)).toBe(false)
      expect('toolChoice' in ((settings ?? {}) as Record<string, unknown>)).toBe(false)
    }
    expect(preset?.settings.profileId).toBe(profileId)
    await migrated.delete()
  })

  it('migrates provider API modes from connection profiles into chat and preset settings', async () => {
    const name = `natter-test-provider-api-mode-mig-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)
    const directSettings = cloneDefaultChatSettings()
    directSettings.profileId = 'profile-openai'
    directSettings.model = 'gpt-4o'
    directSettings.api = 'auto'
    directSettings.responses = { includeEncrypted: false, store: false } as unknown as NonNullable<
      Chat['settings']['responses']
    >
    const googleSettings = cloneDefaultChatSettings()
    googleSettings.profileId = 'profile-google'
    googleSettings.model = 'google/gemini-3.1-flash-lite-preview'
    googleSettings.api = 'auto'
    googleSettings.gemini = {
      allowImportedWithoutSignature: false,
    } as unknown as NonNullable<Chat['settings']['gemini']>
    const anthropicSettings = cloneDefaultChatSettings()
    anthropicSettings.profileId = 'profile-anthropic'
    anthropicSettings.model = 'claude-haiku-4.5'
    anthropicSettings.api = 'auto'

    const legacy = new Dexie(name)
    registerLegacyChatSettingsV14(legacy)
    await legacy.open()
    await legacy.table('profiles').bulkPut([
      {
        id: 'profile-openai',
        name: 'OpenAI',
        kind: 'openai-compatible',
        baseUrl: 'https://api.openai.com/v1',
        apiKeyRef: 'K1',
        defaultHeaders: {},
        appTitle: 'Natter',
        appUrl: '',
        usesResponsesApiByDefault: true,
        responsesDefaults: { store: true, includeEncrypted: false },
        supportsEndpointsApi: false,
        supportsGenerationApi: false,
        supportsPrivacyScrape: false,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'profile-google',
        name: 'Google',
        kind: 'google',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        apiKeyRef: 'K2',
        defaultHeaders: {},
        appTitle: 'Natter',
        appUrl: '',
        geminiMode: 'openai-compat',
        geminiDefaults: { allowImportedWithoutSignature: false },
        supportsEndpointsApi: false,
        supportsGenerationApi: false,
        supportsPrivacyScrape: false,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'profile-anthropic',
        name: 'Anthropic',
        kind: 'anthropic',
        baseUrl: 'https://api.anthropic.com/v1',
        apiKeyRef: 'K3',
        defaultHeaders: {},
        appTitle: 'Natter',
        appUrl: '',
        supportsEndpointsApi: false,
        supportsGenerationApi: false,
        supportsPrivacyScrape: false,
        createdAt: 1,
        updatedAt: 1,
      },
    ])
    const chatBase = {
      title: '',
      titleStatus: 'untitled' as const,
      createdAt: 1,
      updatedAt: 1,
      lastViewedAt: 1,
      wordCount: 0,
      totalCostUsd: 0,
      metaVersion: 0,
      summaryVersion: 0,
      lastUpdatedLeafId: null,
      lastBranchUpdatedAt: 1,
      archived: false,
      pinned: false,
      folderId: null,
      tags: [],
    }
    await legacy.table<Chat>('chats').bulkPut([
      { ...chatBase, id: 'chat-openai', settings: directSettings },
      { ...chatBase, id: 'chat-google', settings: googleSettings },
      { ...chatBase, id: 'chat-anthropic', settings: anthropicSettings },
    ])
    await legacy.table<Record<string, unknown>>('presets').put({
      id: 'preset-openai',
      name: 'OpenAI preset',
      connectionProfileId: 'profile-openai',
      settings: { ...directSettings, profileId: 'stale-profile' },
      createdAt: 1,
      updatedAt: 1,
    })
    legacy.close()

    const migrated = createDbForTests(name)
    await migrated.open()
    expect(migrated.verno).toBe(23)
    const openaiChat = await migrated.chats.get('chat-openai')
    const googleChat = await migrated.chats.get('chat-google')
    const anthropicChat = await migrated.chats.get('chat-anthropic')
    const openaiPreset = await migrated.presets.get('preset-openai')
    expect(openaiChat?.settings.api).toBe('responses')
    expect(openaiChat?.settings.responses).toEqual({ store: true })
    expect(
      'includeEncrypted' in ((openaiChat?.settings.responses ?? {}) as Record<string, unknown>),
    ).toBe(false)
    expect(googleChat?.settings.api).toBe('chat')
    expect(googleChat?.settings.gemini).toBeUndefined()
    expect(anthropicChat?.settings.api).toBe('anthropic-messages')
    expect(openaiPreset?.settings.profileId).toBe('profile-openai')
    expect(openaiPreset?.settings.api).toBe('responses')
    expect(openaiPreset?.settings.responses).toEqual({ store: true })
    for (const profile of await migrated.profiles.toArray()) {
      const row = profile as unknown as Record<string, unknown>
      expect(row.usesResponsesApiByDefault).toBeUndefined()
      expect(row.geminiMode).toBeUndefined()
      expect(row.responsesDefaults).toBeUndefined()
      expect(row.geminiDefaults).toBeUndefined()
    }
    await migrated.delete()
  })

  it('migrates chat preset picker order into dense sortIndex values', async () => {
    const name = `natter-test-preset-sort-index-mig-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)
    const settings = cloneDefaultChatSettings()
    settings.profileId = 'profile-openai'
    settings.model = 'gpt-4o'

    const legacy = new Dexie(name)
    registerLegacyChatSettingsV14(legacy)
    await legacy.open()
    await legacy.table<Record<string, unknown>>('presets').bulkPut([
      {
        id: 'preset-second',
        name: 'Second',
        connectionProfileId: 'profile-openai',
        settings,
        createdAt: 20,
        updatedAt: 20,
      },
      {
        id: 'preset-first',
        name: 'First',
        connectionProfileId: 'profile-openai',
        settings,
        createdAt: 10,
        updatedAt: 10,
      },
    ])
    legacy.close()

    const migrated = createDbForTests(name)
    await migrated.open()
    expect(migrated.verno).toBe(23)
    const rows = (await migrated.presets.toArray()).sort(
      (left, right) => left.sortIndex - right.sortIndex,
    )
    expect(rows.map((row) => [row.id, row.sortIndex])).toEqual([
      ['preset-first', 0],
      ['preset-second', 1],
    ])
    expect(
      rows.every(
        (row) => !('migrationV19SortValue' in (row as unknown as Record<string, unknown>)),
      ),
    ).toBe(true)
    expect(migrated.presets.schema.indexes.map((index) => index.src)).not.toContain(
      '[migrationV19SortValue+createdAt+id]',
    )
    await migrated.delete()
  })

  it('adds the single-newline rendering preference during schema upgrade', async () => {
    const name = `natter-test-rendering-prefs-mig-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)

    const legacy = new Dexie(name)
    registerLegacyChatSettingsV14(legacy)
    await legacy.open()
    await legacy.table<MinimalSetting>('settings').put({
      key: 'rendering-preferences',
      value: {
        shikiLight: 'tokyo-night',
        shikiDark: 'dracula',
        singleDollarTextMath: true,
      },
    })
    legacy.close()

    const migrated = createDbForTests(name)
    await migrated.open()
    expect(migrated.verno).toBe(23)
    expect((await migrated.settings.get('rendering-preferences'))?.value).toEqual({
      shikiLight: 'tokyo-night',
      shikiDark: 'dracula',
      singleDollarTextMath: true,
      singleNewlineHardBreaks: false,
    })
    await migrated.delete()
  })

  it('adds provider output items to message bodies during the provider-tools schema migration', async () => {
    const name = `natter-test-provider-output-items-mig-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)
    const legacy = new Dexie(name)
    registerLegacyAttachmentsV5(legacy)
    await legacy.open()
    await legacy.table<Chat>('chats').put({
      id: 'chat-provider-output',
      title: '',
      titleStatus: 'untitled',
      createdAt: 1,
      updatedAt: 1,
      lastViewedAt: 1,
      wordCount: 0,
      totalCostUsd: 0,
      metaVersion: 0,
      summaryVersion: 0,
      settings: cloneDefaultChatSettings(),
      lastUpdatedLeafId: 'a1',
      lastBranchUpdatedAt: 1,
      archived: false,
      pinned: false,
      folderId: null,
      tags: [],
    })
    await legacy.table<Message>('messages').put({
      id: 'a1',
      chatId: 'chat-provider-output',
      parentId: null,
      siblingIndex: 0,
      turnId: 'turn-a1',
      turnIndex: 1,
      createdAt: 1,
      role: 'assistant',
      origin: 'generated',
      content: [{ type: 'output_text', text: '55' }],
      generation: {
        id: 'gen-a1',
        model: 'gpt-5.4-nano',
        requestedModel: 'gpt-5.4-nano',
        apiUsed: 'responses',
        delivery: 'streaming',
        costSource: 'stream',
        startedAt: 1,
        finishedAt: 2,
        serverTools: [
          {
            type: 'code_interpreter_call',
            source: 'responses-output',
            id: 'ci_1',
            status: 'completed',
            outputIndex: 0,
            output: {
              id: 'ci_1',
              type: 'code_interpreter_call',
              status: 'completed',
              code: 'sum(i*i for i in range(6))',
              outputs: [{ type: 'logs', logs: '55' }],
            },
          },
        ],
      },
      nodeVersion: 0,
      deleted: false,
    })
    legacy.close()

    const migrated = createDbForTests(name)
    await migrated.open()
    const body = await migrated.messageBodies.get('a1')
    expect(body?.providerOutputItems).toEqual([
      {
        dialect: 'openai-responses',
        type: 'code_interpreter_call',
        outputIndex: 0,
        item: {
          id: 'ci_1',
          type: 'code_interpreter_call',
          status: 'completed',
          code: 'sum(i*i for i in range(6))',
          outputs: [{ type: 'logs', logs: '55' }],
        },
      },
    ])
    await migrated.delete()
  })

  it('backfills provider output items once on an already-current schema', async () => {
    const name = `natter-test-provider-output-items-backfill-${Math.random().toString(36).slice(2)}`
    const db = await freshDb(name)
    await db.open()
    const message = {
      id: 'a1',
      chatId: 'chat-provider-output',
      parentId: null,
      siblingIndex: 0,
      turnId: 'turn-a1',
      turnIndex: 1,
      createdAt: 1,
      role: 'assistant',
      origin: 'generated',
      content: [{ type: 'output_text', text: '55' }],
      generation: {
        id: 'gen-a1',
        model: 'gpt-5.4-nano',
        requestedModel: 'gpt-5.4-nano',
        apiUsed: 'responses',
        delivery: 'streaming',
        costSource: 'stream',
        startedAt: 1,
        finishedAt: 2,
        serverTools: [
          {
            type: 'code_interpreter_call',
            source: 'responses-output',
            id: 'ci_1',
            status: 'completed',
            outputIndex: 0,
            output: {
              id: 'ci_1',
              type: 'code_interpreter_call',
              status: 'completed',
              code: 'sum(i*i for i in range(6))',
              outputs: [{ type: 'logs', logs: '55' }],
            },
          },
        ],
      },
      nodeVersion: 0,
      deleted: false,
    } as Message
    const { header, body } = splitMessageForStorage(message)
    delete body.providerOutputItems
    await db.messages.put(header)
    await db.messageBodies.put(body)
    await db.settings.delete('backfill:provider-output-items-v1')

    await migrateProviderOutputItemRows(db)
    await migrateProviderOutputItemRows(db)

    expect((await db.settings.get('backfill:provider-output-items-v1'))?.value).toBe(1)
    expect((await db.messageBodies.get('a1'))?.providerOutputItems).toEqual([
      {
        dialect: 'openai-responses',
        type: 'code_interpreter_call',
        outputIndex: 0,
        item: {
          id: 'ci_1',
          type: 'code_interpreter_call',
          status: 'completed',
          code: 'sum(i*i for i in range(6))',
          outputs: [{ type: 'logs', logs: '55' }],
        },
      },
    ])
    await db.delete()
  })

  it('canonicalizes token calibration keys once on an already-current schema', async () => {
    const name = `natter-test-token-calibration-backfill-${Math.random().toString(36).slice(2)}`
    const db = await freshDb(name)
    await db.open()
    const fableKey = tokenCalibrationKey('anthropic/claude-fable-5')
    await db.chats.put({
      id: 'chat-calib',
      title: 'Calib',
      titleStatus: 'untitled',
      createdAt: 1,
      updatedAt: 1,
      lastViewedAt: 1,
      wordCount: 0,
      totalCostUsd: 0,
      metaVersion: 0,
      summaryVersion: 0,
      settings: cloneDefaultChatSettings(),
      lastUpdatedLeafId: 'm1',
      lastBranchUpdatedAt: 1,
      archived: false,
      pinned: false,
      folderId: null,
      tags: [],
      tokenCalibration: {
        'anthropic:claude-fable-5': {
          totalTextChars: 300,
          totalTextTokens: 100,
          sampleCount: 1,
          lastRatio: 3,
          updatedAt: 10,
        },
        'anthropic:anthropic:anthropic:claude-fable-5': {
          totalTextChars: 600,
          totalTextTokens: 200,
          sampleCount: 2,
          lastRatio: 3,
          updatedAt: 20,
        },
      },
    })
    const message = {
      id: 'm1',
      chatId: 'chat-calib',
      parentId: null,
      siblingIndex: 0,
      turnId: 'turn-m1',
      turnIndex: 0,
      createdAt: 1,
      role: 'user',
      origin: 'user',
      content: [{ type: 'text', text: 'hello' }],
      nodeVersion: 0,
      deleted: false,
      originalCalibrationKey: 'anthropic:anthropic:claude-fable-5',
    } as Message
    const { header, body } = splitMessageForStorage(message)
    await db.messages.put(header)
    await db.messageBodies.put(body)
    await db.settings.put({
      key: 'global:token-calibration',
      value: {
        version: 1,
        updatedAt: 20,
        byModel: {
          'anthropic:anthropic:claude-fable-5': {
            totalTextChars: 900,
            totalTextTokens: 300,
            sampleCount: 3,
            lastRatio: 3,
            updatedAt: 20,
          },
        },
      } satisfies GlobalTokenCalibration,
    })
    await db.settings.delete('backfill:token-calibration-canonicalize-v1')

    await canonicalizeTokenCalibrationRows(db)
    await canonicalizeTokenCalibrationRows(db)

    const chat = await db.chats.get('chat-calib')
    expect(chat?.tokenCalibration).toEqual({
      [fableKey]: {
        totalTextChars: 900,
        totalTextTokens: 300,
        sampleCount: 3,
        lastRatio: 3,
        updatedAt: 20,
      },
    })
    expect((await db.messages.get('m1'))?.originalCalibrationKey).toBe(fableKey)
    const global = (await db.settings.get('global:token-calibration'))
      ?.value as GlobalTokenCalibration
    expect(global.byModel[fableKey]).toMatchObject({
      totalTextChars: 900,
      totalTextTokens: 300,
      sampleCount: 3,
      lastRatio: 3,
      updatedAt: 20,
    })
    expect((await db.settings.get('backfill:token-calibration-canonicalize-v1'))?.value).toBe(1)
    await db.delete()
  })

  it('migrates old attachment-free and prototype attachment IndexedDB rows automatically', async () => {
    const name = `natter-test-attachments-mig-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)

    const legacy = new Dexie(name)
    registerLegacyAttachmentsV5(legacy)
    await legacy.open()
    await legacy.table<Chat>('chats').put({
      id: 'chat-old',
      title: 'Old chat',
      titleStatus: 'untitled',
      createdAt: 1,
      updatedAt: 1,
      lastViewedAt: 1,
      wordCount: 0,
      totalCostUsd: 0,
      metaVersion: 0,
      summaryVersion: 0,
      settings: cloneDefaultChatSettings(),
      lastUpdatedLeafId: 'msg-proto',
      lastBranchUpdatedAt: 1,
      archived: false,
      pinned: false,
      folderId: null,
      tags: [],
    })
    await legacy.table('messages').bulkPut([
      {
        id: 'msg-empty',
        chatId: 'chat-old',
        parentId: null,
        siblingIndex: 0,
        turnId: 'turn-empty',
        turnIndex: 0,
        createdAt: 2,
        role: 'user',
        origin: 'user',
        content: [{ type: 'text', text: 'old text-only message' }],
        nodeVersion: 0,
        deleted: false,
      },
      {
        id: 'msg-proto',
        chatId: 'chat-old',
        parentId: 'msg-empty',
        siblingIndex: 0,
        turnId: 'turn-proto',
        turnIndex: 0,
        createdAt: 3,
        role: 'user',
        origin: 'user',
        content: [{ type: 'text', text: 'old attachment message' }],
        attachmentRefs: ['att-old'],
        nodeVersion: 0,
        deleted: false,
      },
    ])
    await legacy.table('drafts').put({
      chatId: 'chat-old',
      text: 'legacy draft',
      attachmentRefs: ['att-old'],
      updatedAt: 4,
    })
    await legacy.table('attachments').put({
      id: 'att-old',
      contentHash: 'hash-old',
      kind: 'file',
      mime: 'text/plain',
      filename: 'old.txt',
      sizeBytes: 3,
      createdAt: 5,
      blob: new Blob(['old']),
      refCount: 0,
    })
    legacy.close()

    const migrated = createDbForTests(name)
    await migrated.open()
    expect(migrated.tables.map((t) => t.name)).toEqual(
      expect.arrayContaining(['attachmentBlobs', 'attachmentArtifacts', 'attachmentJobs']),
    )

    const emptyMessage = await migrated.messages.get('msg-empty')
    expect(Object.hasOwn(emptyMessage ?? {}, 'content')).toBe(false)
    expect(emptyMessage?.attachmentRefs).toEqual([])
    expect(await migrated.messageBodies.get('msg-empty')).toMatchObject({
      id: 'msg-empty',
      chatId: 'chat-old',
      content: [{ type: 'text', text: 'old text-only message' }],
    })

    const prototypeMessage = await migrated.messages.get('msg-proto')
    expect(Object.hasOwn(prototypeMessage ?? {}, 'content')).toBe(false)
    expect(prototypeMessage?.attachmentRefs).toEqual([
      expect.objectContaining({
        refId: 'legacy:msg-proto:0',
        attachmentId: 'att-old',
        includeInContext: true,
        presentation: {},
      }),
    ])
    expect(await migrated.messageBodies.get('msg-proto')).toMatchObject({
      id: 'msg-proto',
      chatId: 'chat-old',
      content: [{ type: 'text', text: 'old attachment message' }],
    })
    await expect(assertNoInlineMessageBodies(migrated)).resolves.toBeUndefined()

    const draft = await migrated.drafts.get('chat-old')
    expect(draft?.attachmentRefs).toEqual([
      expect.objectContaining({
        refId: 'legacy:chat-old:0',
        attachmentId: 'att-old',
        includeInContext: true,
      }),
    ])

    const attachment = await migrated.attachments.get('att-old')
    expect(attachment).toMatchObject({
      id: 'att-old',
      contentHash: 'hash-old',
      kind: 'other',
      origin: 'import',
      processing: [],
      refCount: 2,
    })
    expect(attachment).toHaveProperty('artifactIds', [])
    expect(Object.hasOwn(attachment ?? {}, 'blob')).toBe(false)

    // Real browser IndexedDB preserves Blob values; fake-indexeddb's older
    // structured clone path may not. Either path is compatible: bytes migrate
    // when available, otherwise the stored object becomes a recoverable
    // missing attachment instead of breaking old chats.
    if (attachment?.storage.kind === 'local-blob') {
      expect(attachment.storage.blobId).toBe('att-old:original')
      const blob = await migrated.attachmentBlobs.get('att-old:original')
      expect(blob).toMatchObject({
        id: 'att-old:original',
        attachmentId: 'att-old',
        role: 'original',
        contentHash: 'hash-old',
        sizeBytes: 3,
      })
    } else {
      expect(attachment?.storage).toMatchObject({
        kind: 'missing',
        reason: 'import-missing',
      })
      expect(await migrated.attachmentBlobs.count()).toBe(0)
    }

    await migrated.delete()
  })

  it('backfills legacy chat organization fields idempotently without materializing cache rows', async () => {
    const name = `natter-test-org-backfill-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)
    const db = await freshDb(name)
    await db.open()
    const chatRows = db.table<Record<string, unknown>>('chats')
    await chatRows.bulkPut([
      {
        id: 'empty',
        title: '',
        createdAt: 1,
        updatedAt: 5,
        metaVersion: 0,
        summaryVersion: 0,
        settings: cloneDefaultChatSettings(),
        lastUpdatedLeafId: 'old-leaf',
        wordCount: 123,
        totalCostUsd: 999,
        archived: false,
        pinned: false,
      },
      {
        id: 'titled',
        title: 'Model title',
        createdAt: 1,
        updatedAt: 6,
        metaVersion: 0,
        summaryVersion: 0,
        settings: cloneDefaultChatSettings(),
        archived: false,
        pinned: false,
      },
      {
        id: 'legacy-default',
        title: 'Untitled chat',
        createdAt: 1,
        updatedAt: 6,
        metaVersion: 0,
        summaryVersion: 0,
        settings: cloneDefaultChatSettings(),
        archived: false,
        pinned: false,
      },
      {
        id: 'imported',
        title: 'Imported title',
        createdAt: 1,
        updatedAt: 7,
        metaVersion: 0,
        summaryVersion: 0,
        settings: cloneDefaultChatSettings(),
        archived: false,
        pinned: false,
      },
      {
        id: 'pinned-archived',
        title: 'Pinned archive',
        createdAt: 1,
        updatedAt: 8,
        metaVersion: 0,
        summaryVersion: 0,
        settings: cloneDefaultChatSettings(),
        archived: true,
        pinned: true,
      },
      {
        id: 'branchy',
        title: 'Branch',
        createdAt: 1,
        updatedAt: 9,
        metaVersion: 0,
        summaryVersion: 0,
        settings: cloneDefaultChatSettings(),
        archived: false,
        pinned: false,
      },
      {
        id: 'tombstoned-descendants',
        title: 'Tombstones',
        createdAt: 1,
        updatedAt: 10,
        metaVersion: 0,
        summaryVersion: 0,
        settings: cloneDefaultChatSettings(),
        archived: false,
        pinned: false,
      },
    ])
    const messages = [
      legacyMessage({ id: 'i1', chatId: 'imported', origin: 'imported', text: 'imported text' }),
      legacyMessage({ id: 'root', chatId: 'branchy', text: 'root text', createdAt: 1, cost: 0.1 }),
      legacyMessage({
        id: 'old-leaf',
        chatId: 'branchy',
        parentId: 'root',
        siblingIndex: 0,
        text: 'old leaf',
        createdAt: 2,
        cost: 0.2,
      }),
      legacyMessage({
        id: 'new-leaf',
        chatId: 'branchy',
        parentId: 'root',
        siblingIndex: 1,
        text: 'new leaf',
        createdAt: 3,
        cost: 0.3,
      }),
      legacyMessage({
        id: 'tomb-root',
        chatId: 'tombstoned-descendants',
        text: 'live root',
        createdAt: 1,
        cost: 0.4,
      }),
      legacyMessage({
        id: 'tomb-child',
        chatId: 'tombstoned-descendants',
        parentId: 'tomb-root',
        text: 'deleted child',
        createdAt: 5,
        cost: 1,
        deleted: true,
      }),
      legacyMessage({
        id: 'tomb-grandchild',
        chatId: 'tombstoned-descendants',
        parentId: 'tomb-child',
        text: 'deleted grandchild',
        createdAt: 6,
        cost: 1,
        deleted: true,
      }),
    ]
    const splitMessages = messages.map((message) => splitMessageForStorage(message))
    await db.messages.bulkPut(splitMessages.map((message) => message.header))
    await db.messageBodies.bulkPut(splitMessages.map((message) => message.body))
    await db.messageBodies.delete('old-leaf')
    await db.settings.delete('backfill:organization-fields-v1')

    await backfillOrganizationFields(db)
    await backfillOrganizationFields(db)

    const empty = await db.chats.get('empty')
    expect(empty).toMatchObject({
      folderId: null,
      tags: [],
      titleStatus: 'untitled',
      lastViewedAt: 5,
      lastUpdatedLeafId: null,
      lastBranchUpdatedAt: 0,
      wordCount: 0,
      totalCostUsd: 0,
    })
    expect((await db.chats.get('titled'))?.titleStatus).toBe('auto')
    expect((await db.chats.get('legacy-default'))?.titleStatus).toBe('untitled')
    expect((await db.chats.get('imported'))?.titleStatus).toBe('untitled')
    expect(await db.chats.get('pinned-archived')).toMatchObject({
      archived: true,
      pinned: true,
      folderId: null,
      tags: [],
    })
    const branchy = await db.chats.get('branchy')
    expect(branchy).toMatchObject({
      lastUpdatedLeafId: 'new-leaf',
      wordCount: 4,
      totalCostUsd: 0.6,
    })
    expect(await db.chats.get('tombstoned-descendants')).toMatchObject({
      lastUpdatedLeafId: 'tomb-root',
      wordCount: 2,
      totalCostUsd: 0.4,
    })
    expect((await db.settings.get('backfill:organization-fields-v1'))?.value).toBe(1)
    expect(await db.chatBranchCache.count()).toBe(0)
    await db.delete()
  })

  it('backfills organization fields on an empty DB and a 1000-chat DB', async () => {
    const emptyName = `natter-test-org-empty-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(emptyName)
    const empty = await freshDb(emptyName)
    await empty.open()
    await backfillOrganizationFields(empty)
    expect(await empty.chats.count()).toBe(0)
    expect((await empty.settings.get('backfill:organization-fields-v1'))?.value).toBe(1)
    await empty.delete()

    const bulkName = `natter-test-org-1000-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(bulkName)
    const db = await freshDb(bulkName)
    await db.open()
    await db.table<Record<string, unknown>>('chats').bulkPut(
      Array.from({ length: 1000 }, (_, index) => ({
        id: `bulk-${index}`,
        title: index % 2 === 0 ? '' : `Bulk ${index}`,
        createdAt: index,
        updatedAt: index + 10,
        metaVersion: 0,
        summaryVersion: 0,
        settings: cloneDefaultChatSettings(),
        archived: index % 3 === 0,
        pinned: index % 5 === 0,
      })),
    )
    await db.settings.delete('backfill:organization-fields-v1')

    await backfillOrganizationFields(db)

    expect(await db.chats.count()).toBe(1000)
    expect(await db.chats.get('bulk-0')).toMatchObject({
      titleStatus: 'untitled',
      lastViewedAt: 10,
      lastUpdatedLeafId: null,
      folderId: null,
      tags: [],
      archived: true,
      pinned: true,
    })
    expect(await db.chats.get('bulk-999')).toMatchObject({
      titleStatus: 'auto',
      lastViewedAt: 1009,
      wordCount: 0,
      totalCostUsd: 0,
      archived: true,
      pinned: false,
    })
    expect(await db.chatBranchCache.count()).toBe(0)
    expect((await db.settings.get('backfill:organization-fields-v1'))?.value).toBe(1)
    await db.delete()
  }, 15_000)
})

function legacyEndpoint(
  provider_name: string,
  tag: string,
  policyOverrides: Record<string, unknown>,
): Record<string, unknown> {
  return {
    provider_name,
    tag,
    supported_parameters: ['provider', 'temperature'],
    context_length: 200_000,
    pricing: {},
    data_policy: {
      training: false,
      trainingOpenRouter: false,
      retainsPrompts: false,
      canPublish: false,
      termsOfServiceURL: '',
      privacyPolicyURL: '',
      ...policyOverrides,
    },
  }
}

function legacyMessage(input: {
  id: string
  chatId: string
  parentId?: string | null
  siblingIndex?: number
  text: string
  origin?: Message['origin']
  createdAt?: number
  cost?: number
  deleted?: boolean
}): Message {
  return {
    id: input.id,
    chatId: input.chatId,
    parentId: input.parentId ?? null,
    siblingIndex: input.siblingIndex ?? 0,
    turnId: `turn-${input.id}`,
    turnIndex: 0,
    createdAt: input.createdAt ?? 1,
    role: 'user',
    origin: input.origin ?? 'user',
    content: [{ type: 'text', text: input.text }],
    ...(input.cost !== undefined
      ? {
          generation: {
            id: `gen-${input.id}`,
            model: 'test',
            requestedModel: 'test',
            apiUsed: 'chat' as const,
            delivery: 'buffered' as const,
            cost: input.cost,
            costSource: 'estimated' as const,
            startedAt: 1,
          },
        }
      : {}),
    nodeVersion: 0,
    deleted: input.deleted ?? false,
  }
}
