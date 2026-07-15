import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type {
  AttachmentArtifact,
  AttachmentBlob,
  AttachmentJob,
  Chat,
  Message,
  MessageAttachmentRef,
} from '../../src/core/types'
import { newId } from '../../src/lib/ulid'
import {
  addExistingAttachmentRef,
  batchRelinkAttachmentRefs,
  buildAttachment,
  countLiveRefs,
  deleteReferencedAttachmentBytes,
  deleteUnreferencedAttachment,
  getAttachmentBundle,
  ingestAttachmentBytes,
  listAttachmentReferences,
  mutateMessageAttachmentRef,
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
import {
  __resetLockTrackerForTests,
  __setLockBackendForTests,
  type LockBackend,
} from '../../src/store/locks'
import type {
  AttachmentSearchFilters,
  AttachmentSearchMeasurement,
} from '../../src/store/repository'
import { expectAttachmentReferenceInvariants } from '../helpers/attachment-reference-invariants'

const DB_NAME = 'natter'

async function resetAll() {
  __resetBrowserRepositoryForTests()
  __resetDbForTests()
  __resetBroadcastForTests()
  __resetLockTrackerForTests()
  await Dexie.delete(DB_NAME)
}

class PausableFirstLockBackend implements LockBackend {
  readonly kind = 'web-locks' as const
  private tail: Promise<void> = Promise.resolve()
  private releaseFirstRun: (() => void) | undefined
  private firstRunStarted: (() => void) | undefined
  private readonly firstRun = new Promise<void>((resolve) => {
    this.firstRunStarted = resolve
  })
  private readonly firstRelease = new Promise<void>((resolve) => {
    this.releaseFirstRun = resolve
  })
  private secondRunStarted: (() => void) | undefined
  private readonly secondRun = new Promise<void>((resolve) => {
    this.secondRunStarted = resolve
  })
  private calls = 0

  waitForFirstRun(): Promise<void> {
    return this.firstRun
  }

  releaseFirst(): void {
    this.releaseFirstRun?.()
  }

  waitForSecondRun(): Promise<void> {
    return this.secondRun
  }

  run<T>(logicalNames: readonly string[], fn: Parameters<LockBackend['run']>[1]): Promise<T> {
    const call = this.calls
    this.calls += 1
    if (call === 1) this.secondRunStarted?.()
    let releaseQueue: (() => void) | undefined
    const previous = this.tail
    this.tail = new Promise<void>((resolve) => {
      releaseQueue = resolve
    })
    return previous
      .then(async () => {
        if (call === 0) {
          this.firstRunStarted?.()
          await this.firstRelease
        }
        return fn({
          kind: 'web-locks',
          logicalNames,
          runTransaction: (db, tables, write) =>
            db.transaction(
              'rw',
              tables.map((table) => db.table(typeof table === 'string' ? table : table.name)),
              write,
            ),
        }) as Promise<T>
      })
      .finally(() => releaseQueue?.())
  }
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

async function putMessage(message: Message): Promise<void> {
  await getBrowserRepository().runMutation(
    [
      { kind: 'message', messageId: message.id },
      { kind: 'children', chatId: message.chatId, parentId: message.parentId },
      ...[...new Set((message.attachmentRefs ?? []).map((ref) => ref.attachmentId))].map(
        (attachmentId) => ({ kind: 'attachment' as const, attachmentId }),
      ),
    ],
    async (ctx) => {
      await ctx.putMessage(message)
    },
  )
}

async function expectAttachmentBundleInvariants(attachmentId: string): Promise<void> {
  const bundle = await getAttachmentBundle(attachmentId)
  if (!bundle) throw new Error(`expected attachment bundle ${attachmentId}`)
  const blobIds = new Set(bundle.blobs.map((blob) => blob.id))
  const artifactIds = new Set(bundle.artifacts.map((artifact) => artifact.artifactId))
  expect(bundle.attachment.artifacts.map((artifact) => artifact.artifactId).sort()).toEqual(
    [...artifactIds].sort(),
  )
  if (bundle.attachment.storage.kind === 'local-blob') {
    expect(blobIds.has(bundle.attachment.storage.blobId)).toBe(true)
  }
  if (bundle.attachment.thumbnailBlobId) {
    expect(blobIds.has(bundle.attachment.thumbnailBlobId)).toBe(true)
  }
  for (const artifact of bundle.artifacts) {
    if (artifact.kind === 'blob') expect(blobIds.has(artifact.blobId)).toBe(true)
  }
  for (const state of bundle.attachment.processing) {
    expect(state.outputArtifactIds.every((id) => artifactIds.has(id))).toBe(true)
  }
  for (const job of bundle.jobs) {
    expect(job.outputArtifactIds.every((id) => artifactIds.has(id))).toBe(true)
  }
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
    const storedHeader = await getDb().attachments.get(bundle.attachment.id)
    expect(storedHeader).not.toHaveProperty('artifacts')
    expect(storedHeader).toHaveProperty(
      'artifactIds',
      bundle.artifacts.map((artifact) => artifact.artifactId),
    )

    for (let index = 0; index < 8; index += 1) {
      const unrelated = await buildAttachment({
        blob: bytes(`unrelated image ${index}`),
        filename: `unrelated-${index}.png`,
        mime: 'image/png',
        kind: 'image',
        createdAt: index + 20,
      })
      await putAttachment(unrelated)
      await getDb().attachmentArtifacts.put({
        kind: 'text',
        artifactId: `unrelated-artifact-${index}`,
        attachmentId: unrelated.id,
        processorId: 'test-only',
        text: 'searchable markdown body that must not be read',
        charCount: 48,
        createdAt: index + 20,
      })
    }
    const artifactTableScan = vi.spyOn(getDb().attachmentArtifacts, 'toArray')
    const blobTableScan = vi.spyOn(getDb().attachmentBlobs, 'toArray')
    const measurements: AttachmentSearchMeasurement[] = []
    const hits = await getBrowserRepository().searchAttachments({
      query: 'notes markdown searchable',
      filters: { kind: 'plaintext' },
      onMeasure: (value) => {
        measurements.push(value)
      },
    })
    const measurement = measurements[0]
    expect(hits.rows.map((row) => row.id)).toEqual([bundle.attachment.id])
    expect(measurement).toMatchObject({
      selectedIndex: 'kind',
      metadataRowsRead: 1,
      metadataCandidates: 1,
      embeddedArtifactRowsRead: 0,
      artifactCandidateAttachments: 1,
      attachmentBlobRowsRead: 0,
      matchedRows: 1,
      returnedRows: 1,
    })
    expect(measurement?.artifactRowsRead).toBeGreaterThan(0)
    expect(artifactTableScan).not.toHaveBeenCalled()
    expect(blobTableScan).not.toHaveBeenCalled()

    await ingestAttachmentBytes({
      blob: bytes('second searchable text'),
      filename: 'other.txt',
      now: 11,
    })
    const pageOne = await getBrowserRepository().searchAttachments({
      query: '  \n\t ',
      filters: { kind: 'plaintext' },
      sort: 'created-asc',
      limit: 1,
    })
    expect(pageOne.nextCursor).toMatch(/^natter-attachment-search:v1:/)
    if (!pageOne.nextCursor) throw new Error('expected cursor')
    const pageTwo = await getBrowserRepository().searchAttachments({
      query: '  \n\t ',
      filters: { kind: 'plaintext' },
      sort: 'created-asc',
      limit: 1,
      cursor: pageOne.nextCursor,
    })
    expect(pageTwo.rows).toHaveLength(1)
    expect(pageTwo.rows[0]?.id).not.toBe(bundle.attachment.id)
    const legacyPage = await getBrowserRepository().searchAttachments({
      query: '  \n\t ',
      filters: { kind: 'plaintext' },
      sort: 'created-asc',
      limit: 1,
      cursor: bundle.attachment.id,
    })
    expect(legacyPage.rows.map((row) => row.id)).toEqual(pageTwo.rows.map((row) => row.id))
    expect(artifactTableScan).not.toHaveBeenCalled()
  })

  it('uses stable sort tuples across equal values and rejects cancelled searches', async () => {
    const rows = await Promise.all(
      ['d', 'a', 'c', 'b'].map(async (suffix) => {
        const attachment = await buildAttachment({
          blob: bytes(suffix),
          filename: `${suffix}.txt`,
          mime: 'text/plain',
          kind: 'plaintext',
          createdAt: 50,
        })
        await putAttachment(attachment)
        return attachment
      }),
    )
    const expected = [...rows].sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    )
    const seen: string[] = []
    let cursor: string | undefined
    do {
      const page = await getBrowserRepository().searchAttachments({
        filters: { kind: 'plaintext' },
        sort: 'created-asc',
        limit: 1,
        ...(cursor ? { cursor } : {}),
      })
      seen.push(...page.rows.map((row) => row.id))
      cursor = page.nextCursor
    } while (cursor)

    expect(seen).toEqual(expected.map((row) => row.id))

    const controller = new AbortController()
    controller.abort()
    const metadataScan = vi.spyOn(getDb().attachments, 'toArray')
    await expect(
      getBrowserRepository().searchAttachments({ query: 'anything', signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(metadataScan).not.toHaveBeenCalled()
  })

  it('uses existing metadata indexes and applies unindexed storage and size filters exactly', async () => {
    const markdown = await buildAttachment({
      blob: bytes('markdown'),
      filename: 'indexed.md',
      mime: 'text/markdown',
      kind: 'plaintext',
      origin: 'import',
      createdAt: 10,
    })
    const plain = await buildAttachment({
      blob: bytes('plain text is longer'),
      filename: 'indexed.txt',
      mime: 'text/plain',
      kind: 'plaintext',
      origin: 'user-upload',
      createdAt: 20,
    })
    const image = await buildAttachment({
      blob: bytes('image'),
      filename: 'indexed.png',
      mime: 'image/png',
      kind: 'image',
      origin: 'user-upload',
      createdAt: 30,
    })
    await Promise.all([putAttachment(markdown), putAttachment(plain), putAttachment(image)])
    await getDb().attachments.update(markdown.id, { refCount: 3 })

    const cases: Array<{
      filters: AttachmentSearchFilters
      selectedIndex: AttachmentSearchMeasurement['selectedIndex']
      ids: string[]
    }> = [
      { filters: { kind: 'image' }, selectedIndex: 'kind', ids: [image.id] },
      { filters: { mime: 'text/markdown' }, selectedIndex: 'mime', ids: [markdown.id] },
      { filters: { origin: 'import' }, selectedIndex: 'origin', ids: [markdown.id] },
      {
        filters: { minRefCount: 2, maxRefCount: 4 },
        selectedIndex: 'refCount',
        ids: [markdown.id],
      },
    ]
    for (const testCase of cases) {
      const measurements: AttachmentSearchMeasurement[] = []
      const result = await getBrowserRepository().searchAttachments({
        filters: testCase.filters,
        sort: 'created-asc',
        onMeasure: (value) => measurements.push(value),
      })
      expect(result.rows.map((row) => row.id)).toEqual(testCase.ids)
      expect(measurements[0]).toMatchObject({
        selectedIndex: testCase.selectedIndex,
        metadataCandidates: testCase.ids.length,
      })
    }

    const narrowedMeasurements: AttachmentSearchMeasurement[] = []
    const narrowed = await getBrowserRepository().searchAttachments({
      filters: { kind: 'plaintext', mime: 'text/markdown', origin: 'import' },
      onMeasure: (value) => narrowedMeasurements.push(value),
    })
    expect(narrowed.rows.map((row) => row.id)).toEqual([markdown.id])
    expect(narrowedMeasurements[0]).toMatchObject({
      selectedIndex: 'mime',
      indexCounts: { kind: 2, mime: 1, origin: 1 },
      metadataRowsRead: 1,
    })

    if (plain.sizeBytes === undefined) throw new Error('expected stored attachment size')
    const exactSizeAndStorage = await getBrowserRepository().searchAttachments({
      filters: {
        kind: 'plaintext',
        storageKind: 'local-blob',
        minSizeBytes: plain.sizeBytes,
        maxSizeBytes: plain.sizeBytes,
      },
    })
    expect(exactSizeAndStorage.rows.map((row) => row.id)).toEqual([plain.id])

    const sortMeasurements: AttachmentSearchMeasurement[] = []
    await getBrowserRepository().searchAttachments({
      sort: 'updated-desc',
      onMeasure: (value) => sortMeasurements.push(value),
    })
    expect(sortMeasurements[0]?.selectedIndex).toBe('updatedAt')
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
    await putMessage(message)

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

    await expect(
      getBrowserRepository().runMutation(
        [{ kind: 'attachment', attachmentId: second.attachment.id }],
        async (ctx) => {
          await ctx.deleteAttachment(second.attachment.id)
        },
      ),
    ).rejects.toThrow(`AttachmentStillReferenced:${second.attachment.id}`)
    const missing = await deleteReferencedAttachmentBytes(second.attachment.id, 'deleted', 23)
    expect(missing?.storage).toMatchObject({ kind: 'missing', reason: 'deleted' })
    const missingBundle = await getAttachmentBundle(second.attachment.id)
    expect(missingBundle?.blobs).toHaveLength(0)
    expect(missingBundle?.artifacts.length).toBeGreaterThan(0)
    expect(missingBundle?.jobs.length).toBeGreaterThan(0)
    expect(await countLiveRefs(second.attachment.id)).toEqual({ messages: 1, drafts: 0 })
    expect((await getDb().attachments.get(second.attachment.id))?.refCount).toBe(1)
    expect(
      await getDb().attachmentRefEdges.where('attachmentId').equals(second.attachment.id).count(),
    ).toBe(1)
    expect(await getBrowserRepository().getMessage(message.id)).toMatchObject({ id: message.id })
    await expectAttachmentReferenceInvariants(getDb())
  })

  it('returns the exact committed presentation for each message attachment mutation', async () => {
    const chat = await seedChat()
    const message = makeMessage(chat.id)
    await putMessage(message)
    const first = await ingestAttachmentBytes({
      blob: bytes('first exact attachment'),
      filename: 'first.txt',
      now: 10,
    })
    const second = await ingestAttachmentBytes({
      blob: bytes('second exact attachment'),
      filename: 'second.txt',
      now: 11,
    })
    const ref = await addExistingAttachmentRef({
      messageId: message.id,
      attachmentId: first.attachment.id,
      now: 12,
    })

    const hidden = await mutateMessageAttachmentRef({
      chatId: chat.id,
      messageId: message.id,
      mutation: { kind: 'visibility', refId: ref.refId, includeInContext: false },
      now: 13,
    })
    expect(hidden?.message.attachmentRefs?.[0]).toMatchObject({
      refId: ref.refId,
      includeInContext: false,
    })
    expect(hidden?.bodyVersion).toBe(hidden?.header.bodyVersion)
    expect(hidden?.message.nodeVersion).toBe(hidden?.header.nodeVersion)

    const relinked = await mutateMessageAttachmentRef({
      chatId: chat.id,
      messageId: message.id,
      mutation: {
        kind: 'relink',
        refId: ref.refId,
        newAttachmentId: second.attachment.id,
      },
      now: 14,
    })
    expect(relinked?.message.attachmentRefs?.[0]?.attachmentId).toBe(second.attachment.id)
    expect((await getDb().attachments.get(first.attachment.id))?.refCount).toBe(0)
    expect((await getDb().attachments.get(second.attachment.id))?.refCount).toBe(1)

    const detached = await mutateMessageAttachmentRef({
      chatId: chat.id,
      messageId: message.id,
      mutation: { kind: 'detach', refId: ref.refId },
      now: 15,
    })
    expect(detached?.message.attachmentRefs).toEqual([])
    expect((await getDb().attachments.get(second.attachment.id))?.refCount).toBe(0)
  })

  it('atomically removes blob-derived pointers while retaining independent artifacts', async () => {
    const chat = await seedChat()
    const message = makeMessage(chat.id)
    await putMessage(message)
    const bundle = await ingestAttachmentBytes({
      blob: bytes('searchable attachment text'),
      filename: 'source.txt',
      now: 10,
    })
    await addExistingAttachmentRef({
      messageId: message.id,
      attachmentId: bundle.attachment.id,
      now: 11,
    })
    await addExistingAttachmentRef({
      draftChatId: chat.id,
      attachmentId: bundle.attachment.id,
      now: 12,
    })

    const retainedArtifact = bundle.artifacts.find((artifact) => artifact.kind === 'text')
    if (!retainedArtifact) throw new Error('expected text artifact')
    if (bundle.attachment.storage.kind !== 'local-blob') throw new Error('expected local bytes')
    const originalBlobId = bundle.attachment.storage.blobId
    const derivedBytes = bytes('thumbnail bytes')
    const derivedBlobId = `${bundle.attachment.id}:thumbnail`
    const derivedArtifactId = `${bundle.attachment.id}:thumbnail-artifact`
    const derivedBlob: AttachmentBlob = {
      id: derivedBlobId,
      attachmentId: bundle.attachment.id,
      role: 'thumbnail',
      mime: 'image/png',
      contentHash: await sha256Hex(derivedBytes),
      sizeBytes: derivedBytes.size,
      blob: derivedBytes,
      createdAt: 12,
    }
    const derivedArtifact: AttachmentArtifact = {
      kind: 'blob',
      artifactId: derivedArtifactId,
      attachmentId: bundle.attachment.id,
      processorId: 'thumbnail-v1',
      blobId: derivedBlobId,
      createdAt: 12,
    }
    const mixedJob: AttachmentJob = {
      id: 'imported-arbitrary-mixed-job-id',
      attachmentId: bundle.attachment.id,
      processorId: 'mixed-v1',
      inputHash: bundle.attachment.contentHash ?? 'hash',
      status: 'succeeded',
      finishedAt: 12,
      outputArtifactIds: [retainedArtifact.artifactId, derivedArtifactId],
      updatedAt: 12,
    }
    const blobOnlyJob: AttachmentJob = {
      ...mixedJob,
      id: 'imported-arbitrary-blob-only-job-id',
      processorId: 'thumbnail-v1',
      outputArtifactIds: [derivedArtifactId],
    }
    const enriched = {
      ...bundle.attachment,
      thumbnailBlobId: derivedBlobId,
      artifacts: [...bundle.attachment.artifacts, derivedArtifact],
      processing: [
        ...bundle.attachment.processing,
        {
          processorId: mixedJob.processorId,
          inputHash: mixedJob.inputHash,
          status: mixedJob.status,
          finishedAt: 12,
          outputArtifactIds: mixedJob.outputArtifactIds,
        },
        {
          processorId: blobOnlyJob.processorId,
          inputHash: blobOnlyJob.inputHash,
          status: blobOnlyJob.status,
          finishedAt: 12,
          outputArtifactIds: blobOnlyJob.outputArtifactIds,
        },
      ],
    }
    await getBrowserRepository().runMutation(
      [{ kind: 'attachment', attachmentId: bundle.attachment.id }],
      async (ctx) => {
        await ctx.putAttachmentBlob(derivedBlob)
        await ctx.putAttachmentArtifact(derivedArtifact)
        await ctx.putAttachmentJob(mixedJob)
        await ctx.putAttachmentJob(blobOnlyJob)
        await ctx.putAttachment(enriched)
      },
    )

    const deleted = await deleteReferencedAttachmentBytes(bundle.attachment.id, 'deleted', 20)
    expect(deleted?.storage).toEqual({
      kind: 'missing',
      reason: 'deleted',
      missingSince: 20,
      lastKnownBlobId: originalBlobId,
    })
    expect(deleted?.thumbnailBlobId).toBeUndefined()
    expect(deleted?.artifacts.every((artifact) => artifact.kind !== 'blob')).toBe(true)
    expect(deleted?.artifacts.map((artifact) => artifact.artifactId)).toContain(
      retainedArtifact.artifactId,
    )
    expect(
      deleted?.processing.find((state) => state.processorId === 'thumbnail-v1'),
    ).toBeUndefined()
    expect(deleted?.processing.find((state) => state.processorId === 'mixed-v1')).toMatchObject({
      outputArtifactIds: [retainedArtifact.artifactId],
    })

    const stored = await getAttachmentBundle(bundle.attachment.id)
    expect(stored?.blobs).toEqual([])
    expect(stored?.artifacts.every((artifact) => artifact.kind !== 'blob')).toBe(true)
    expect(stored?.jobs.find((job) => job.id === blobOnlyJob.id)).toBeUndefined()
    expect(stored?.jobs.find((job) => job.id === mixedJob.id)).toMatchObject({
      outputArtifactIds: [retainedArtifact.artifactId],
      updatedAt: 20,
    })
    expect(await countLiveRefs(bundle.attachment.id)).toEqual({ messages: 1, drafts: 1 })
    expect(stored?.attachment.refCount).toBe(2)
    expect((await getBrowserRepository().getMessage(message.id))?.attachmentRefs).toHaveLength(1)
    expect((await getBrowserRepository().getDraft(chat.id))?.attachmentRefs).toHaveLength(1)
    await expectAttachmentBundleInvariants(bundle.attachment.id)
    await expectAttachmentReferenceInvariants(getDb())
  })

  it('keeps duplicate deletion and replacement races internally consistent', async () => {
    const bundle = await ingestAttachmentBytes({
      blob: bytes('old bytes'),
      filename: 'race.txt',
      now: 10,
    })

    const duplicateDeletes = await Promise.all([
      deleteReferencedAttachmentBytes(bundle.attachment.id, 'deleted', 20),
      deleteReferencedAttachmentBytes(bundle.attachment.id, 'deleted', 21),
      deleteReferencedAttachmentBytes(bundle.attachment.id, 'deleted', 22),
    ])
    expect(duplicateDeletes.every((attachment) => attachment?.storage.kind === 'missing')).toBe(
      true,
    )
    expect((await getAttachmentBundle(bundle.attachment.id))?.attachment.storage).toMatchObject({
      kind: 'missing',
      lastKnownBlobId: bundle.blobs[0]?.id,
    })
    await expectAttachmentBundleInvariants(bundle.attachment.id)

    await Promise.all([
      replaceAttachmentBytes({
        attachmentId: bundle.attachment.id,
        blob: bytes('replacement bytes'),
        filename: 'race.txt',
        now: 30,
      }),
      deleteReferencedAttachmentBytes(bundle.attachment.id, 'deleted', 31),
    ])
    await expectAttachmentBundleInvariants(bundle.attachment.id)
    const raced = await getAttachmentBundle(bundle.attachment.id)
    if (raced?.attachment.storage.kind === 'missing') {
      expect(raced.blobs).toEqual([])
      expect(raced.artifacts.every((artifact) => artifact.kind !== 'blob')).toBe(true)
    }
  })

  it('removes stale sidecars when two byte replacements prepare against the same bundle', async () => {
    const bundle = await ingestAttachmentBytes({
      blob: bytes('old bytes'),
      filename: 'replace-race.txt',
      now: 10,
    })
    const backend = new PausableFirstLockBackend()
    __setLockBackendForTests(backend)

    const first = replaceAttachmentBytes({
      attachmentId: bundle.attachment.id,
      blob: bytes('first replacement'),
      filename: 'replace-race.txt',
      now: 20,
    })
    await backend.waitForFirstRun()
    const second = replaceAttachmentBytes({
      attachmentId: bundle.attachment.id,
      blob: bytes('second replacement'),
      filename: 'replace-race.txt',
      now: 21,
    })
    await backend.waitForSecondRun()
    backend.releaseFirst()
    await Promise.all([first, second])

    const stored = await getAttachmentBundle(bundle.attachment.id)
    expect(stored?.blobs).toHaveLength(1)
    expect(stored?.blobs[0]?.id).toBe(
      stored?.attachment.storage.kind === 'local-blob'
        ? stored.attachment.storage.blobId
        : undefined,
    )
    expect(stored?.artifacts.map((artifact) => artifact.artifactId).sort()).toEqual(
      stored?.attachment.artifacts.map((artifact) => artifact.artifactId).sort(),
    )
    expect(stored?.jobs.map((job) => job.id).sort()).toEqual(
      stored?.attachment.processing
        .map((state) => `${bundle.attachment.id}:${state.processorId}:${state.inputHash}`)
        .sort(),
    )
    await expectAttachmentBundleInvariants(bundle.attachment.id)
  })
})

describe('attachment refcounts under repository mutations', () => {
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
      },
    )
    expect((await getDb().attachments.get(attachment.id))?.refCount).toBe(0)
    await expectAttachmentReferenceInvariants(getDb())
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
    await putMessage(makeMessage(chat.id, [attachmentRef(attachment.id)]))

    const reaped = await reapOrphanedAttachments({ now: 10_000, olderThanMs: 5000 })
    expect(reaped).toEqual([])
    expect(await getDb().attachments.get(attachment.id)).toBeDefined()
  })

  it('serializes attach and GC correctly in both commit orders', async () => {
    const chat = await seedChat()
    const firstMessage = makeMessage(chat.id)
    await putMessage(firstMessage)
    const attachWins = await buildAttachment({
      blob: bytes('attach first'),
      filename: 'attach-first.bin',
      mime: 'application/octet-stream',
      kind: 'file',
      createdAt: 1,
    })
    await putAttachment(attachWins)

    const attachFirstBackend = new PausableFirstLockBackend()
    __setLockBackendForTests(attachFirstBackend)
    const attach = addExistingAttachmentRef({
      messageId: firstMessage.id,
      attachmentId: attachWins.id,
      now: 2,
    })
    await attachFirstBackend.waitForFirstRun()
    const losingGc = deleteUnreferencedAttachment(attachWins.id)
    attachFirstBackend.releaseFirst()
    await attach
    expect(await losingGc).toEqual({
      deleted: false,
      refs: { messages: 1, drafts: 0 },
    })
    expect(await getDb().attachments.get(attachWins.id)).toBeDefined()

    __setLockBackendForTests(null)
    const secondMessage = makeMessage(chat.id)
    await putMessage(secondMessage)
    const gcWins = await buildAttachment({
      blob: bytes('gc first'),
      filename: 'gc-first.bin',
      mime: 'application/octet-stream',
      kind: 'file',
      createdAt: 1,
    })
    await putAttachment(gcWins)

    const gcFirstBackend = new PausableFirstLockBackend()
    __setLockBackendForTests(gcFirstBackend)
    const gc = deleteUnreferencedAttachment(gcWins.id)
    await gcFirstBackend.waitForFirstRun()
    const losingAttach = addExistingAttachmentRef({
      messageId: secondMessage.id,
      attachmentId: gcWins.id,
      now: 2,
    })
    gcFirstBackend.releaseFirst()
    expect(await gc).toEqual({ deleted: true, refs: { messages: 0, drafts: 0 } })
    await expect(losingAttach).rejects.toThrow(`AttachmentMissing:${gcWins.id}`)
    expect((await getBrowserRepository().getMessage(secondMessage.id))?.attachmentRefs).toEqual([])
    await expectAttachmentReferenceInvariants(getDb())
    __setLockBackendForTests(null)
  })
})

describe('attachment edge projection invariants', () => {
  it('does not touch the edge index for an attachment-unchanged body patch', async () => {
    const chat = await seedChat()
    const attachment = await buildAttachment({
      blob: bytes('hot path'),
      filename: 'hot-path.bin',
      mime: 'application/octet-stream',
      kind: 'file',
    })
    await putAttachment(attachment)
    const message = makeMessage(chat.id, [attachmentRef(attachment.id)])
    await putMessage(message)
    const edgeReads = vi.spyOn(getDb().attachmentRefEdges, 'where')

    await getBrowserRepository().runMutation(
      [{ kind: 'message', messageId: message.id }],
      async (ctx) => {
        await ctx.patchMessageBody(
          message.id,
          { content: [{ type: 'text', text: 'stream finalization' }] },
          { touchChatSummary: false, broadcast: false },
        )
      },
    )

    expect(edgeReads).not.toHaveBeenCalled()
    expect((await getDb().attachments.get(attachment.id))?.refCount).toBe(1)
    await expectAttachmentReferenceInvariants(getDb())
  })

  it('counts duplicate occurrences, hidden refs, and soft-deleted owners but excludes ref tombstones', async () => {
    const chat = await seedChat()
    const attachment = await buildAttachment({
      blob: bytes('projection'),
      filename: 'projection.bin',
      mime: 'application/octet-stream',
      kind: 'file',
    })
    await putAttachment(attachment)
    const refs = [
      { ...attachmentRef(attachment.id, 1), includeInContext: false },
      attachmentRef(attachment.id, 2),
      { ...attachmentRef(attachment.id, 3), deletedAt: 0 },
    ]
    const message = { ...makeMessage(chat.id, refs), deleted: true }
    await putMessage(message)

    expect((await getDb().attachments.get(attachment.id))?.refCount).toBe(2)
    expect(await countLiveRefs(attachment.id)).toEqual({ messages: 1, drafts: 0 })
    expect(
      await getDb().attachmentRefEdges.where('attachmentId').equals(attachment.id).count(),
    ).toBe(2)

    const current = await getBrowserRepository().getMessage(message.id)
    if (!current?.attachmentRefs) throw new Error('expected refs')
    const tombstoned = current.attachmentRefs.map((ref) =>
      ref.refId === refs[1]?.refId ? { ...ref, deletedAt: 0 } : ref,
    )
    await getBrowserRepository().runMutation(
      [
        { kind: 'message', messageId: message.id },
        { kind: 'attachment', attachmentId: attachment.id },
      ],
      async (ctx) => {
        await ctx.putMessage({ ...current, attachmentRefs: tombstoned })
      },
    )
    expect((await getDb().attachments.get(attachment.id))?.refCount).toBe(1)
    await expectAttachmentReferenceInvariants(getDb())
  })

  it('rejects duplicate ref IDs and missing live targets without partial owner writes', async () => {
    const chat = await seedChat()
    const attachment = await buildAttachment({
      blob: bytes('poison'),
      filename: 'poison.bin',
      mime: 'application/octet-stream',
      kind: 'file',
    })
    await putAttachment(attachment)
    const original = makeMessage(chat.id, [attachmentRef(attachment.id)])
    await putMessage(original)
    const duplicate = original.attachmentRefs?.[0]
    if (!duplicate) throw new Error('expected ref')

    await expect(
      getBrowserRepository().runMutation(
        [
          { kind: 'message', messageId: original.id },
          { kind: 'attachment', attachmentId: attachment.id },
        ],
        async (ctx) => {
          await ctx.putMessage({
            ...original,
            attachmentRefs: [duplicate, { ...duplicate, updatedAt: duplicate.updatedAt + 1 }],
          })
        },
      ),
    ).rejects.toThrow(`DuplicateAttachmentRefId:message:${original.id}:${duplicate.refId}`)

    const missing = makeMessage(chat.id, [attachmentRef('missing-target')])
    await expect(
      getBrowserRepository().runMutation(
        [
          { kind: 'message', messageId: missing.id },
          { kind: 'children', chatId: chat.id, parentId: null },
          { kind: 'attachment', attachmentId: 'missing-target' },
        ],
        async (ctx) => {
          await ctx.putMessage(missing)
        },
      ),
    ).rejects.toThrow('AttachmentMissing:missing-target')
    expect(await getBrowserRepository().getMessage(missing.id)).toBeUndefined()
    expect(await getBrowserRepository().getMessage(original.id)).toEqual(original)
    await expectAttachmentReferenceInvariants(getDb())
  })

  it('rolls a stale multi-owner relink back as one transaction', async () => {
    const chat = await seedChat()
    const oldAttachment = await buildAttachment({
      blob: bytes('old'),
      filename: 'old.bin',
      mime: 'application/octet-stream',
      kind: 'file',
    })
    const replacement = await buildAttachment({
      blob: bytes('new'),
      filename: 'new.bin',
      mime: 'application/octet-stream',
      kind: 'file',
    })
    await putAttachment(oldAttachment)
    await putAttachment(replacement)
    const first = makeMessage(chat.id, [attachmentRef(oldAttachment.id, 1)])
    const second = makeMessage(chat.id, [attachmentRef(oldAttachment.id, 2)])
    await putMessage(first)
    await putMessage(second)
    const firstRef = first.attachmentRefs?.[0]
    if (!firstRef) throw new Error('expected first ref')

    await expect(
      batchRelinkAttachmentRefs({
        oldAttachmentId: oldAttachment.id,
        newAttachmentId: replacement.id,
        refs: [
          { messageId: first.id, refId: firstRef.refId },
          { messageId: second.id, refId: 'stale-ref-id' },
        ],
        now: 10,
      }),
    ).rejects.toThrow('AttachmentRefMissing:stale-ref-id')
    await expect(
      batchRelinkAttachmentRefs({
        oldAttachmentId: replacement.id,
        newAttachmentId: replacement.id,
        refs: [{ messageId: first.id, refId: firstRef.refId }],
        now: 11,
      }),
    ).rejects.toThrow(`AttachmentRelinkStale:${firstRef.refId}`)
    expect((await getBrowserRepository().getMessage(first.id))?.attachmentRefs?.[0]).toMatchObject({
      attachmentId: oldAttachment.id,
    })
    expect((await getDb().attachments.get(oldAttachment.id))?.refCount).toBe(2)
    expect((await getDb().attachments.get(replacement.id))?.refCount).toBe(0)
    await expectAttachmentReferenceInvariants(getDb())
  })
})

describe('misc attachment helpers', () => {
  it('countLiveRefs scans messages and drafts', async () => {
    const chat = await seedChat()
    const attachment = await buildAttachment({
      blob: bytes('refs'),
      filename: 'refs.bin',
      mime: 'application/octet-stream',
      kind: 'file',
    })
    await putAttachment(attachment)
    await putMessage(makeMessage(chat.id, [attachmentRef(attachment.id)]))
    await getBrowserRepository().runMutation(
      [
        { kind: 'draft', chatId: chat.id },
        { kind: 'attachment', attachmentId: attachment.id },
      ],
      async (ctx) => {
        await ctx.putDraft({
          chatId: chat.id,
          text: '',
          attachmentRefs: [attachmentRef(attachment.id)],
          updatedAt: 1,
        })
      },
    )

    const messageScan = vi.spyOn(getDb().messages, 'toArray')
    const draftScan = vi.spyOn(getDb().drafts, 'toArray')
    expect(await countLiveRefs(attachment.id)).toEqual({ messages: 1, drafts: 1 })
    expect(await listAttachmentReferences(attachment.id)).toHaveLength(2)
    expect(messageScan).not.toHaveBeenCalled()
    expect(draftScan).not.toHaveBeenCalled()
    await expectAttachmentReferenceInvariants(getDb())
  })
})
