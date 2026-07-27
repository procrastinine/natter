import Dexie from 'dexie'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type {
  Attachment,
  AttachmentArtifact,
  AttachmentBlob,
  AttachmentJob,
  Chat,
  Message,
  MessageAttachmentRef,
} from '../../src/core/types'
import { newId } from '../../src/lib/ulid'
import {
  executeAttachmentBulkDelete,
  planAttachmentBulkDelete,
} from '../../src/store/attachment-bulk-delete'
import { refreshAttachmentCatalogProjectionsForRepair } from '../../src/store/attachment-catalog-projection'
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
  putWorkspaceDraft,
  relinkAttachmentRef,
  replaceAttachmentBytes,
  setAttachmentRefVisibility,
  sha256Hex,
} from '../../src/store/attachments'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import { __resetBrowserRepositoryForTests } from '../../src/store/browser-repo'
import {
  openBrowserWorkspace,
  shutdownBrowserWorkspace,
} from '../../src/store/browser-workspace-lifecycle'
import { __resetDbForTests, getDb } from '../../src/store/db'
import { exportWorkspaceBackup, restoreWorkspaceBackup } from '../../src/store/import-export'
import {
  __setLockBackendForTests,
  type AuthoritativeCommandLockSession,
  type LockBackend,
} from '../../src/store/locks'
import type {
  AttachmentCatalogSearchRequest,
  AttachmentSearchFilters,
  AttachmentSearchMeasurement,
} from '../../src/store/repository'
import type {
  CommitEnvelope,
  ReadEnvelope,
  WorkspaceCommand,
  WorkspaceCommandResult,
  WorkspaceQuery,
  WorkspaceQueryResult,
} from '../../src/store/workspace-protocol'
import {
  __resetWorkspaceRepositoryForTests,
  getWorkspaceRepository,
} from '../../src/store/workspace-repository'
import { runWorkspaceAction, runWorkspaceRead } from '../../src/store/workspace-runtime'
import { expectAttachmentReferenceInvariants } from '../helpers/attachment-reference-invariants'
import { putTestChat } from '../helpers/chats'
import { putTestMessages } from '../helpers/message-storage'

const DB_NAME = 'natter'

let emptyWorkspaceBackup: Awaited<ReturnType<typeof exportWorkspaceBackup>>

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

  async runAuthoritativeCommandSession<T>(
    _database: Dexie,
    operation: (session: AuthoritativeCommandLockSession) => Promise<T> | T,
    options: { signal?: AbortSignal } = {},
  ): Promise<T> {
    if (options.signal?.aborted) throw options.signal.reason
    return operation({
      kind: this.kind,
      withResourceLocks: (resourceNames, child) => this.run(resourceNames, child),
    })
  }
}

class RecordingLockBackend implements LockBackend {
  readonly kind = 'web-locks' as const
  readonly logicalRuns: string[][] = []
  readonly transactionTableRuns: string[][] = []

  run<T>(logicalNames: readonly string[], fn: Parameters<LockBackend['run']>[1]): Promise<T> {
    this.logicalRuns.push([...logicalNames].sort())
    return Promise.resolve(
      fn({
        kind: this.kind,
        logicalNames,
        runTransaction: (db, tables, write) => {
          this.transactionTableRuns.push(
            tables.map((table) => (typeof table === 'string' ? table : table.name)).sort(),
          )
          return db.transaction(
            'rw',
            tables.map((table) => db.table(typeof table === 'string' ? table : table.name)),
            write,
          )
        },
      }) as Promise<T>,
    )
  }

  async runAuthoritativeCommandSession<T>(
    _database: Dexie,
    operation: (session: AuthoritativeCommandLockSession) => Promise<T> | T,
    options: { signal?: AbortSignal } = {},
  ): Promise<T> {
    if (options.signal?.aborted) throw options.signal.reason
    return operation({
      kind: this.kind,
      withResourceLocks: (resourceNames, child) => this.run(resourceNames, child),
    })
  }
}

beforeAll(async () => {
  ;(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory()
  __resetWorkspaceRepositoryForTests()
  __resetBrowserRepositoryForTests()
  __resetBroadcastForTests()
  __resetDbForTests()
  await Dexie.delete(DB_NAME)
  await openBrowserWorkspace()
  emptyWorkspaceBackup = await exportWorkspaceBackup()
})

beforeEach(async () => {
  __setLockBackendForTests(null)
  await restoreWorkspaceBackup(emptyWorkspaceBackup, { now: 1 })
})

afterAll(async () => {
  __setLockBackendForTests(null)
  await shutdownBrowserWorkspace()
})

async function seedChat(id = newId()): Promise<Chat> {
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
    structuralVersion: 0,
    settings: cloneDefaultChatSettings(),
    lastUpdatedLeafId: null,
    lastBranchUpdatedAt: 1,
    archived: false,
    pinned: false,
    folderId: null,
    tags: [],
  }
  return putTestChat(chat)
}

function bytes(content: string): Blob {
  return new Blob([new TextEncoder().encode(content)])
}

function largeAttachmentPayload(attachment: Attachment, generation: 'old' | 'new') {
  const blobs = Array.from({ length: 129 }, (_, index): AttachmentBlob => {
    const blob = bytes(`${generation}-blob-${index}`)
    return {
      id: `${attachment.id}:${generation}:blob:${index}`,
      attachmentId: attachment.id,
      role: index === 0 ? 'original' : 'thumbnail',
      mime: 'application/octet-stream',
      contentHash: `${generation}-hash-${index}`,
      sizeBytes: blob.size,
      blob,
      createdAt: generation === 'old' ? 12 : 20,
    }
  })
  const artifacts = Array.from(
    { length: 129 },
    (_, index): AttachmentArtifact => ({
      kind: 'text',
      artifactId: `${attachment.id}:${generation}:artifact:${index}`,
      attachmentId: attachment.id,
      processorId: `${generation}-processor-${index}`,
      text: `${generation}-text-${index}`,
      charCount: `${generation}-text-${index}`.length,
      createdAt: generation === 'old' ? 12 : 20,
    }),
  )
  const jobs = Array.from(
    { length: 129 },
    (_, index): AttachmentJob => ({
      id: `${attachment.id}:${generation}:job:${index}`,
      attachmentId: attachment.id,
      processorId: `${generation}-processor-${index}`,
      inputHash: `${generation}-input-${index}`,
      status: 'succeeded',
      finishedAt: generation === 'old' ? 12 : 20,
      outputArtifactIds: [artifacts[index]?.artifactId ?? 'missing'],
      updatedAt: generation === 'old' ? 12 : 20,
    }),
  )
  return {
    attachment: {
      ...attachment,
      contentHash: `${generation}-bundle-hash`,
      updatedAt: generation === 'old' ? 12 : 20,
      storage: { kind: 'local-blob' as const, blobId: blobs[0]?.id ?? 'missing' },
      artifacts,
      processing: jobs.map(({ processorId, inputHash, status, finishedAt, outputArtifactIds }) => ({
        processorId,
        inputHash,
        status,
        finishedAt: finishedAt ?? 0,
        outputArtifactIds,
      })),
    },
    blobs,
    artifacts,
    jobs,
  }
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
  if (await getMessage(message.id)) return
  const chat = (await query({ kind: 'chat.get', chatId: message.chatId })).value
  if (!chat) throw new Error(`ChatMissing:${message.chatId}`)
  await putTestMessages([
    {
      ...message,
      parentId: message.parentId ?? chat.lastUpdatedLeafId,
    },
  ])
}

function query<Q extends WorkspaceQuery>(
  request: Q,
  signal?: AbortSignal,
): Promise<ReadEnvelope<WorkspaceQueryResult<Q>>> {
  return runWorkspaceRead(
    'repository-query',
    (permit) => getWorkspaceRepository().query(permit, request, { signal: permit.signal }),
    signal ? { signal } : {},
  )
}

function execute<C extends WorkspaceCommand>(
  command: C,
): Promise<CommitEnvelope<WorkspaceCommandResult<C>>> {
  return runWorkspaceAction('maintenance', (permit) =>
    getWorkspaceRepository().execute(permit, command),
  )
}

async function getMessage(messageId: string): Promise<Message | undefined> {
  return (await query({ kind: 'message.presentation', messageId })).value?.message
}

async function getDraft(chatId: string) {
  return (await query({ kind: 'draft.get', chatId })).value
}

type TestAttachmentSearchRequest = AttachmentCatalogSearchRequest & {
  signal?: AbortSignal
  onMeasure?: (measurement: AttachmentSearchMeasurement) => void
}

async function searchAttachments(request: TestAttachmentSearchRequest = {}) {
  const { signal, onMeasure, ...search } = request
  const page = (
    await query(
      { kind: 'attachment.catalog-page', search: { ...search, direction: 'forward' } },
      signal,
    )
  ).value
  onMeasure?.(page.measurement)
  return page
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
  it('bulk deletes one revision-fenced snapshot with bounded progress and reference-safe stubs', async () => {
    const chat = await seedChat()
    const message = makeMessage(chat.id)
    await putMessage(message)
    const first = await ingestAttachmentBytes({
      blob: bytes('first'),
      filename: 'bulk-first.txt',
      now: 10,
    })
    const referenced = await ingestAttachmentBytes({
      blob: bytes('referenced'),
      filename: 'bulk-referenced.txt',
      now: 11,
    })
    await addExistingAttachmentRef({
      messageId: message.id,
      attachmentId: referenced.attachment.id,
      now: 12,
    })
    const ignored = await ingestAttachmentBytes({
      blob: bytes('ignored'),
      filename: 'ignored.png',
      declaredMime: 'image/png',
      now: 13,
    })
    const plan = await planAttachmentBulkDelete({ filters: { kind: 'plaintext' } })
    const afterPlan = await ingestAttachmentBytes({
      blob: bytes('after plan'),
      filename: 'after-plan.txt',
      now: 14,
    })
    await expect(executeAttachmentBulkDelete(plan)).rejects.toThrow('AttachmentBulkDeletePlanStale')
    expect(await getAttachmentBundle(first.attachment.id)).toBeDefined()
    expect(await getAttachmentBundle(referenced.attachment.id)).toBeDefined()

    const currentPlan = await planAttachmentBulkDelete({
      query: 'bulk-',
      filters: { kind: 'plaintext' },
    })
    const progress: Array<{ processed: number; done: boolean }> = []

    const result = await executeAttachmentBulkDelete(currentPlan, {
      selectedAttachmentId: first.attachment.id,
      onProgress: (snapshot) =>
        progress.push({ processed: snapshot.processed, done: snapshot.done }),
    })

    expect(plan.matchedCount).toBe(2)
    expect(currentPlan.matchedCount).toBe(2)
    expect(result).toMatchObject({
      planned: 2,
      processed: 2,
      deleted: 1,
      stubbed: 1,
      absent: 0,
      done: true,
      selectedDisposition: 'deleted',
    })
    expect(progress.at(-1)).toEqual({ processed: 2, done: true })
    expect(await getAttachmentBundle(first.attachment.id)).toBeUndefined()
    expect((await getAttachmentBundle(referenced.attachment.id))?.attachment.storage.kind).toBe(
      'missing',
    )
    expect(await getAttachmentBundle(afterPlan.attachment.id)).toBeDefined()
    expect(await getAttachmentBundle(ignored.attachment.id)).toBeDefined()
  })

  it('aborts a bulk delete before its first atomic batch without changing membership', async () => {
    const attachment = await ingestAttachmentBytes({
      blob: bytes('cancelled'),
      filename: 'cancelled.txt',
      now: 20,
    })
    const plan = await planAttachmentBulkDelete({ query: 'cancelled.txt' })
    const controller = new AbortController()

    await expect(
      executeAttachmentBulkDelete(plan, {
        signal: controller.signal,
        onProgress: (progress) => {
          if (progress.processed === 0 && !progress.done) controller.abort()
        },
      }),
    ).rejects.toThrow()
    expect(await getAttachmentBundle(attachment.attachment.id)).toBeDefined()
  })

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
    const hits = await searchAttachments({
      query: 'notes markdown searchable',
      filters: { kind: 'plaintext' },
      onMeasure: (value) => {
        measurements.push(value)
      },
    })
    const measurement = measurements[0]
    expect(hits.rows.map((row) => row.id)).toEqual([bundle.attachment.id])
    expect(measurement).toMatchObject({
      selectedIndex: 'createdAt',
      metadataRowsRead: 9,
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
    const pageOne = await searchAttachments({
      query: '  \n\t ',
      filters: { kind: 'plaintext' },
      sort: 'created-asc',
      limit: 1,
    })
    expect(pageOne.nextCursor).toMatch(/^natter-attachment-catalog:v1:/)
    if (!pageOne.nextCursor) throw new Error('expected cursor')
    const pageTwo = await searchAttachments({
      query: '  \n\t ',
      filters: { kind: 'plaintext' },
      sort: 'created-asc',
      limit: 1,
      cursor: pageOne.nextCursor,
    })
    expect(pageTwo.rows).toHaveLength(1)
    expect(pageTwo.rows[0]?.id).not.toBe(bundle.attachment.id)
    await expect(
      searchAttachments({
        query: '  \n\t ',
        filters: { kind: 'plaintext' },
        sort: 'created-asc',
        limit: 1,
        cursor: bundle.attachment.id,
      }),
    ).rejects.toThrow('CatalogCursorVersionUnsupported')
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
      const page = await searchAttachments({
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
      searchAttachments({ query: 'anything', signal: controller.signal }),
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
    await getDb().transaction(
      'rw',
      getDb().attachments,
      getDb().attachmentRefEdges,
      getDb().attachmentCatalogRows,
      getDb().attachmentCatalogAggregate,
      async (tx) => {
        await getDb().attachments.update(markdown.id, { refCount: 3 })
        await getDb().attachmentRefEdges.bulkPut(
          Array.from({ length: 3 }, (_, index) => ({
            ownerKind: 'message' as const,
            ownerId: `search-owner-${index}`,
            chatId: 'search-chat',
            refId: `search-ref-${index}`,
            attachmentId: markdown.id,
            ordinal: 0,
            includeInContext: true,
            refUpdatedAt: 1,
          })),
        )
        await refreshAttachmentCatalogProjectionsForRepair(tx, [markdown.id])
      },
    )

    const cases: Array<{
      filters: AttachmentSearchFilters
      ids: string[]
    }> = [
      { filters: { kind: 'image' }, ids: [image.id] },
      { filters: { mime: 'text/markdown' }, ids: [markdown.id] },
      { filters: { origin: 'import' }, ids: [markdown.id] },
      {
        filters: { minRefCount: 2, maxRefCount: 4 },
        ids: [markdown.id],
      },
    ]
    for (const testCase of cases) {
      const measurements: AttachmentSearchMeasurement[] = []
      const result = await searchAttachments({
        filters: testCase.filters,
        sort: 'created-asc',
        onMeasure: (value) => measurements.push(value),
      })
      expect(
        result.rows.map((row) => row.id),
        JSON.stringify(testCase.filters),
      ).toEqual(testCase.ids)
      expect(measurements[0]).toMatchObject({
        selectedIndex: 'createdAt',
        metadataCandidates: testCase.ids.length,
      })
    }

    const narrowedMeasurements: AttachmentSearchMeasurement[] = []
    const narrowed = await searchAttachments({
      filters: { kind: 'plaintext', mime: 'text/markdown', origin: 'import' },
      onMeasure: (value) => narrowedMeasurements.push(value),
    })
    expect(narrowed.rows.map((row) => row.id)).toEqual([markdown.id])
    expect(narrowedMeasurements[0]).toMatchObject({
      selectedIndex: 'createdAt',
      indexCounts: {},
      metadataRowsRead: 3,
    })

    if (plain.sizeBytes === undefined) throw new Error('expected stored attachment size')
    const exactSizeAndStorage = await searchAttachments({
      filters: {
        kind: 'plaintext',
        storageKind: 'local-blob',
        minSizeBytes: plain.sizeBytes,
        maxSizeBytes: plain.sizeBytes,
      },
    })
    expect(exactSizeAndStorage.rows.map((row) => row.id)).toEqual([plain.id])

    const sortMeasurements: AttachmentSearchMeasurement[] = []
    await searchAttachments({
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

  it('replaces large attachment bundles in one narrow batch and rolls back sidecar collisions', async () => {
    const target = await ingestAttachmentBytes({
      blob: bytes('bundle target'),
      filename: 'bundle-target.txt',
      now: 10,
    })
    const unrelated = await ingestAttachmentBytes({
      blob: bytes('bundle unrelated'),
      filename: 'bundle-unrelated.txt',
      now: 11,
    })
    await execute({
      kind: 'attachment.bundle.write',
      input: { bundle: largeAttachmentPayload(target.attachment, 'old'), mode: 'replace' },
    })
    const headerBefore = await getDb().attachments.get(target.attachment.id)
    const catalogBefore = await getDb().attachmentCatalogAggregate.get('workspace')
    const unrelatedBefore = await getAttachmentBundle(unrelated.attachment.id)
    const backend = new RecordingLockBackend()
    __setLockBackendForTests(backend)
    const replacement = largeAttachmentPayload(target.attachment, 'new')

    const committed = await execute({
      kind: 'attachment.bundle.write',
      input: { bundle: replacement, mode: 'replace' },
    })

    expect(committed.value).toEqual({
      attachmentId: target.attachment.id,
      outcome: 'written',
      attachment: expect.objectContaining({
        id: target.attachment.id,
        refCount: target.attachment.refCount,
      }),
    })
    expect(backend.logicalRuns).toHaveLength(1)
    expect(backend.logicalRuns[0]).toEqual([`attachment:${target.attachment.id}`])
    expect(backend.transactionTableRuns).toEqual([
      [
        'attachmentArtifacts',
        'attachmentBlobs',
        'attachmentCatalogAggregate',
        'attachmentCatalogRows',
        'attachmentJobs',
        'attachments',
      ],
    ])
    const stored = await getAttachmentBundle(target.attachment.id)
    expect(stored?.blobs).toHaveLength(129)
    expect(stored?.artifacts).toHaveLength(129)
    expect(stored?.jobs).toHaveLength(129)
    expect(stored?.blobs.every((row) => row.id.includes(':new:'))).toBe(true)
    expect(stored?.artifacts.every((row) => row.artifactId.includes(':new:'))).toBe(true)
    expect(stored?.jobs.every((row) => row.id.includes(':new:'))).toBe(true)
    const headerAfter = await getDb().attachments.get(target.attachment.id)
    const catalogAfter = await getDb().attachmentCatalogAggregate.get('workspace')
    expect(headerAfter?.wireVersion).toBe((headerBefore?.wireVersion ?? 0) + 1)
    expect(catalogAfter?.projectionRevision).toBe((catalogBefore?.projectionRevision ?? 0) + 1)
    expect(await getAttachmentBundle(unrelated.attachment.id)).toEqual(unrelatedBefore)

    const unrelatedBlob = unrelatedBefore?.blobs[0]
    const replacementBlob = replacement.blobs[0]
    if (!unrelatedBlob) throw new Error('expected unrelated blob')
    if (!replacementBlob) throw new Error('expected replacement blob')
    await expect(
      execute({
        kind: 'attachment.bundle.write',
        input: {
          bundle: {
            ...replacement,
            blobs: [{ ...replacementBlob, id: unrelatedBlob.id }],
          },
          mode: 'replace',
        },
      }),
    ).rejects.toThrow()
    expect((await getDb().attachments.get(target.attachment.id))?.wireVersion).toBe(
      headerAfter?.wireVersion,
    )
    expect(await getAttachmentBundle(target.attachment.id)).toEqual(stored)
    expect(await getAttachmentBundle(unrelated.attachment.id)).toEqual(unrelatedBefore)
  })

  it('deletes an unreferenced large bundle in one transaction and rolls back a late catalog failure', async () => {
    const target = await ingestAttachmentBytes({
      blob: bytes('delete target'),
      filename: 'delete-target.txt',
      now: 10,
    })
    const unrelated = await ingestAttachmentBytes({
      blob: bytes('delete unrelated'),
      filename: 'delete-unrelated.txt',
      now: 11,
    })
    await execute({
      kind: 'attachment.bundle.write',
      input: {
        bundle: largeAttachmentPayload(target.attachment, 'old'),
        mode: 'replace',
      },
    })
    const unrelatedBefore = await getAttachmentBundle(unrelated.attachment.id)
    const catalogBefore = await getDb().attachmentCatalogAggregate.get('workspace')
    const backend = new RecordingLockBackend()
    __setLockBackendForTests(backend)

    const committed = await execute({
      kind: 'attachment.delete-if-unreferenced',
      attachmentId: target.attachment.id,
    })

    expect(committed.value).toEqual({
      deleted: true,
      refs: { messages: 0, drafts: 0 },
    })
    expect(backend.logicalRuns[0]).toEqual([`attachment:${target.attachment.id}`])
    expect(backend.transactionTableRuns[0]).toEqual([
      'attachmentArtifacts',
      'attachmentBlobs',
      'attachmentCatalogAggregate',
      'attachmentCatalogRows',
      'attachmentJobs',
      'attachmentRefEdges',
      'attachments',
    ])
    expect(await getAttachmentBundle(target.attachment.id)).toBeUndefined()
    expect(
      await getDb().attachmentBlobs.where('attachmentId').equals(target.attachment.id).count(),
    ).toBe(0)
    expect(
      await getDb().attachmentArtifacts.where('attachmentId').equals(target.attachment.id).count(),
    ).toBe(0)
    expect(
      await getDb().attachmentJobs.where('attachmentId').equals(target.attachment.id).count(),
    ).toBe(0)
    expect(await getAttachmentBundle(unrelated.attachment.id)).toEqual(unrelatedBefore)
    expect((await getDb().attachmentCatalogAggregate.get('workspace'))?.projectionRevision).toBe(
      (catalogBefore?.projectionRevision ?? 0) + 1,
    )
    expect(committed.delta.invalidations).toEqual(
      expect.arrayContaining([
        { kind: 'attachment', attachmentIds: [target.attachment.id] },
        {
          kind: 'attachment-job',
          attachmentIds: [target.attachment.id],
          jobIds: expect.arrayContaining([
            `${target.attachment.id}:old:job:0`,
            `${target.attachment.id}:old:job:128`,
          ]),
        },
      ]),
    )
    const catalogAfter = await getDb().attachmentCatalogAggregate.get('workspace')
    await expect(deleteUnreferencedAttachment(target.attachment.id)).resolves.toEqual({
      deleted: false,
      refs: { messages: 0, drafts: 0 },
    })
    expect(await getDb().attachmentCatalogAggregate.get('workspace')).toEqual(catalogAfter)

    __setLockBackendForTests(null)
    const referencedTarget = await ingestAttachmentBytes({
      blob: bytes('referenced target'),
      filename: 'referenced-target.txt',
      now: 12,
    })
    const chat = await seedChat()
    await putMessage(
      makeMessage(
        chat.id,
        Array.from({ length: 129 }, (_, index) =>
          attachmentRef(referencedTarget.attachment.id, index + 1),
        ),
      ),
    )
    const referencedBefore = await getAttachmentBundle(referencedTarget.attachment.id)
    const catalogBeforeReferencedProbe = await getDb().attachmentCatalogAggregate.get('workspace')
    const referencedBackend = new RecordingLockBackend()
    __setLockBackendForTests(referencedBackend)
    await expect(deleteUnreferencedAttachment(referencedTarget.attachment.id)).resolves.toEqual({
      deleted: false,
      refs: { messages: 1, drafts: 0 },
    })
    expect(referencedBackend.logicalRuns).toEqual([
      [`attachment:${referencedTarget.attachment.id}`],
    ])
    expect(await getAttachmentBundle(referencedTarget.attachment.id)).toEqual(referencedBefore)
    expect(await getDb().attachmentCatalogAggregate.get('workspace')).toEqual(
      catalogBeforeReferencedProbe,
    )

    __setLockBackendForTests(null)
    const rollbackTarget = await ingestAttachmentBytes({
      blob: bytes('rollback target'),
      filename: 'rollback-target.txt',
      now: 13,
    })
    const rollbackBefore = await getAttachmentBundle(rollbackTarget.attachment.id)
    await getDb().attachmentCatalogRows.delete(rollbackTarget.attachment.id)
    const aggregateBeforeFailure = await getDb().attachmentCatalogAggregate.get('workspace')
    await expect(deleteUnreferencedAttachment(rollbackTarget.attachment.id)).rejects.toThrow(
      `AttachmentCatalogRowMissing:${rollbackTarget.attachment.id}`,
    )
    expect(await getAttachmentBundle(rollbackTarget.attachment.id)).toEqual(rollbackBefore)
    expect(await getDb().attachmentCatalogAggregate.get('workspace')).toEqual(
      aggregateBeforeFailure,
    )
  })

  it('replaces bytes in-place unless the uploaded file already exists', async () => {
    const chat = await seedChat()
    const message = makeMessage(chat.id)
    await putMessage(message)
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
    await addExistingAttachmentRef({
      messageId: message.id,
      attachmentId: target.attachment.id,
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
    expect(replaced.bundle.attachment.refCount).toBe(1)
    expect(replaced.bundle.attachment.contentHash).not.toBe(target.attachment.contentHash)
    expect((await getAttachmentBundle(target.attachment.id))?.blobs).toHaveLength(1)
    expect((await getAttachmentBundle(target.attachment.id))?.attachment.refCount).toBe(1)

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
    const withRef = await getMessage(message.id)
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

    await expect(deleteUnreferencedAttachment(second.attachment.id)).resolves.toEqual({
      deleted: false,
      refs: { messages: 1, drafts: 0 },
    })
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
    expect(await getMessage(message.id)).toMatchObject({ id: message.id })
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
    await execute({
      kind: 'attachment.bundle.write',
      input: {
        mode: 'replace',
        bundle: {
          attachment: enriched,
          blobs: [...bundle.blobs, derivedBlob],
          artifacts: [...bundle.artifacts, derivedArtifact],
          jobs: [...bundle.jobs, mixedJob, blobOnlyJob],
        },
      },
    })

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
    expect((await getMessage(message.id))?.attachmentRefs).toHaveLength(1)
    expect((await getDraft(chat.id))?.attachmentRefs).toHaveLength(1)
    await expectAttachmentBundleInvariants(bundle.attachment.id)
    await expectAttachmentReferenceInvariants(getDb())
  })

  it('deletes every owned payload row in one narrow transition without truncation or replay writes', async () => {
    const bundle = await ingestAttachmentBytes({
      blob: bytes('large owner payload'),
      filename: 'large-owner.txt',
      now: 10,
    })
    const unrelated = await ingestAttachmentBytes({
      blob: bytes('unrelated payload'),
      filename: 'unrelated.txt',
      now: 11,
    })
    const header = await getDb().attachments.get(bundle.attachment.id)
    if (header?.storage.kind !== 'local-blob') throw new Error('expected local header')
    const originalBlobId = header.storage.blobId
    const retainedArtifacts = Array.from(
      { length: 129 },
      (_, index): AttachmentArtifact => ({
        kind: 'text',
        artifactId: `${bundle.attachment.id}:retained:${index}`,
        attachmentId: bundle.attachment.id,
        processorId: `text-${index}`,
        text: `retained-${index}`,
        charCount: `retained-${index}`.length,
        createdAt: 12,
      }),
    )
    const deletedArtifacts = Array.from(
      { length: 129 },
      (_, index): AttachmentArtifact => ({
        kind: 'blob',
        artifactId: `${bundle.attachment.id}:deleted:${index}`,
        attachmentId: bundle.attachment.id,
        processorId: `blob-${index}`,
        blobId: index === 0 ? originalBlobId : `${bundle.attachment.id}:blob:${index}`,
        createdAt: 12,
      }),
    )
    const blobs = Array.from({ length: 129 }, (_, index): AttachmentBlob => {
      const blob = bytes(`b${index}`)
      return {
        id: index === 0 ? originalBlobId : `${bundle.attachment.id}:blob:${index}`,
        attachmentId: bundle.attachment.id,
        role: 'original',
        mime: 'application/octet-stream',
        contentHash: `hash-${index}`,
        sizeBytes: blob.size,
        blob,
        createdAt: 12,
      }
    })
    const deletedJobs = Array.from(
      { length: 129 },
      (_, index): AttachmentJob => ({
        id: `${bundle.attachment.id}:deleted-job:${index}`,
        attachmentId: bundle.attachment.id,
        processorId: `deleted-job-${index}`,
        inputHash: `input-${index}`,
        status: 'succeeded',
        finishedAt: 12,
        outputArtifactIds: [deletedArtifacts[index]?.artifactId ?? 'missing'],
        updatedAt: 12,
      }),
    )
    const updatedJobs = Array.from(
      { length: 129 },
      (_, index): AttachmentJob => ({
        id: `${bundle.attachment.id}:updated-job:${index}`,
        attachmentId: bundle.attachment.id,
        processorId: `updated-job-${index}`,
        inputHash: `input-${index}`,
        status: 'succeeded',
        finishedAt: 12,
        outputArtifactIds: [
          retainedArtifacts[index]?.artifactId ?? 'missing',
          deletedArtifacts[index]?.artifactId ?? 'missing',
        ],
        updatedAt: 12,
      }),
    )
    await getDb().transaction(
      'rw',
      [
        getDb().attachments,
        getDb().attachmentArtifacts,
        getDb().attachmentBlobs,
        getDb().attachmentJobs,
      ],
      async () => {
        await Promise.all([
          getDb().attachmentArtifacts.where('attachmentId').equals(bundle.attachment.id).delete(),
          getDb().attachmentBlobs.where('attachmentId').equals(bundle.attachment.id).delete(),
          getDb().attachmentJobs.where('attachmentId').equals(bundle.attachment.id).delete(),
        ])
        await Promise.all([
          getDb().attachmentArtifacts.bulkPut([...retainedArtifacts, ...deletedArtifacts]),
          getDb().attachmentBlobs.bulkPut(blobs),
          getDb().attachmentJobs.bulkPut([...deletedJobs, ...updatedJobs]),
        ])
        await getDb().attachments.put({
          ...header,
          artifactIds: [...retainedArtifacts, ...deletedArtifacts].map(
            (artifact) => artifact.artifactId,
          ),
          processing: [...deletedJobs, ...updatedJobs].map(
            ({ processorId, inputHash, status, outputArtifactIds }) => ({
              processorId,
              inputHash,
              status,
              finishedAt: 12,
              outputArtifactIds,
            }),
          ),
          thumbnailBlobId: blobs.at(-1)?.id ?? originalBlobId,
        })
      },
    )
    const headerBefore = await getDb().attachments.get(bundle.attachment.id)
    const catalogBefore = await getDb().attachmentCatalogAggregate.get('workspace')
    const unrelatedBefore = await getAttachmentBundle(unrelated.attachment.id)
    const backend = new RecordingLockBackend()
    __setLockBackendForTests(backend)

    const first = await execute({
      kind: 'attachment.bytes.delete',
      input: {
        attachmentId: bundle.attachment.id,
        reason: 'deleted',
        now: 20,
      },
    })

    expect(first.value?.storage).toMatchObject({
      kind: 'missing',
      reason: 'deleted',
      lastKnownBlobId: originalBlobId,
    })
    expect(first.value?.artifacts).toHaveLength(129)
    expect(first.value?.artifacts.every((artifact) => artifact.kind === 'text')).toBe(true)
    expect(backend.logicalRuns).toEqual([[`attachment:${bundle.attachment.id}`]])
    expect(backend.transactionTableRuns).toEqual([
      [
        'attachmentArtifacts',
        'attachmentBlobs',
        'attachmentCatalogAggregate',
        'attachmentCatalogRows',
        'attachmentJobs',
        'attachments',
      ],
    ])
    const stored = await getAttachmentBundle(bundle.attachment.id)
    expect(stored?.blobs).toEqual([])
    expect(stored?.artifacts).toHaveLength(129)
    expect(stored?.jobs).toHaveLength(129)
    expect(stored?.jobs.every((job) => job.outputArtifactIds.length === 1)).toBe(true)
    expect(stored?.jobs.every((job) => job.updatedAt === 20)).toBe(true)
    const headerAfter = await getDb().attachments.get(bundle.attachment.id)
    const catalogAfter = await getDb().attachmentCatalogAggregate.get('workspace')
    expect(headerAfter?.wireVersion).toBe((headerBefore?.wireVersion ?? 0) + 1)
    expect(catalogAfter?.projectionRevision).toBe((catalogBefore?.projectionRevision ?? 0) + 1)
    expect(first.delta.invalidations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'attachment',
          attachmentIds: [bundle.attachment.id],
        }),
        expect.objectContaining({
          kind: 'attachment-job',
          attachmentIds: [bundle.attachment.id],
        }),
      ]),
    )
    expect(await getAttachmentBundle(unrelated.attachment.id)).toEqual(unrelatedBefore)

    const second = await execute({
      kind: 'attachment.bytes.delete',
      input: {
        attachmentId: bundle.attachment.id,
        reason: 'deleted',
        now: 20,
      },
    })
    expect(second.delta.invalidations).toEqual([])
    expect((await getDb().attachments.get(bundle.attachment.id))?.wireVersion).toBe(
      headerAfter?.wireVersion,
    )
    expect((await getDb().attachmentCatalogAggregate.get('workspace'))?.projectionRevision).toBe(
      catalogAfter?.projectionRevision,
    )

    const absent = await execute({
      kind: 'attachment.bytes.delete',
      input: {
        attachmentId: 'absent-attachment',
        reason: 'deleted',
        now: 21,
      },
    })
    expect(absent.value).toBeUndefined()
    expect(absent.delta.invalidations).toEqual([])
  })

  it('keeps duplicate deletion and replacement races internally consistent', async () => {
    const deleteThenReplace = await ingestAttachmentBytes({
      blob: bytes('delete then replace old bytes'),
      filename: 'delete-then-replace.txt',
      now: 8,
    })
    await deleteReferencedAttachmentBytes(deleteThenReplace.attachment.id, 'deleted', 18)
    const deleteThenReplacement = await replaceAttachmentBytes({
      attachmentId: deleteThenReplace.attachment.id,
      blob: bytes('delete then replace new bytes'),
      filename: 'delete-then-replace.txt',
      now: 19,
    })
    const deleteThenReplaceStored = await getAttachmentBundle(deleteThenReplace.attachment.id)
    expect(deleteThenReplaceStored?.attachment.storage).toEqual(
      deleteThenReplacement.bundle.attachment.storage,
    )
    expect(deleteThenReplaceStored?.blobs).toHaveLength(1)
    await expectAttachmentBundleInvariants(deleteThenReplace.attachment.id)

    const replaceThenDelete = await ingestAttachmentBytes({
      blob: bytes('replace then delete old bytes'),
      filename: 'replace-then-delete.txt',
      now: 8,
    })
    const replaceThenDeletion = await replaceAttachmentBytes({
      attachmentId: replaceThenDelete.attachment.id,
      blob: bytes('replace then delete new bytes'),
      filename: 'replace-then-delete.txt',
      now: 19,
    })
    if (replaceThenDeletion.bundle.attachment.storage.kind !== 'local-blob') {
      throw new Error('expected replacement bytes')
    }
    await deleteReferencedAttachmentBytes(replaceThenDelete.attachment.id, 'deleted', 20)
    const replaceThenDeleteStored = await getAttachmentBundle(replaceThenDelete.attachment.id)
    expect(replaceThenDeleteStored?.attachment.storage).toEqual({
      kind: 'missing',
      reason: 'deleted',
      missingSince: 20,
      lastKnownBlobId: replaceThenDeletion.bundle.attachment.storage.blobId,
    })
    expect(replaceThenDeleteStored?.blobs).toEqual([])
    await expectAttachmentBundleInvariants(replaceThenDelete.attachment.id)

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
    const [, secondResult] = await Promise.all([first, second])

    const stored = await getAttachmentBundle(bundle.attachment.id)
    expect(stored?.attachment.contentHash).toBe(secondResult.bundle.attachment.contentHash)
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
  it('tracks refcount across message write, body edit, and explicit ref detach', async () => {
    const chat = await seedChat()
    const attachment = await buildAttachment({
      blob: bytes('x'),
      filename: 'x.bin',
      mime: 'application/octet-stream',
      kind: 'file',
    })
    await putAttachment(attachment)
    const message = makeMessage(chat.id, [attachmentRef(attachment.id)])

    await putMessage(message)
    expect((await getDb().attachments.get(attachment.id))?.refCount).toBe(1)

    await execute({
      kind: 'message.edit-content',
      input: {
        chatId: chat.id,
        messageId: message.id,
        content: [{ type: 'text', text: 'updated' }],
        now: 2,
      },
    })
    expect((await getDb().attachments.get(attachment.id))?.refCount).toBe(1)

    const ref = (await getMessage(message.id))?.attachmentRefs?.[0]
    if (!ref) throw new Error('ExpectedAttachmentRef')
    await mutateMessageAttachmentRef({
      chatId: chat.id,
      messageId: message.id,
      mutation: { kind: 'detach', refId: ref.refId },
      now: 3,
    })
    expect((await getDb().attachments.get(attachment.id))?.refCount).toBe(0)
    await expectAttachmentReferenceInvariants(getDb())
  })
})

describe('attachment deletion concurrency', () => {
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
    expect((await getMessage(secondMessage.id))?.attachmentRefs).toEqual([])
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

    await execute({
      kind: 'message.edit-content',
      input: {
        chatId: chat.id,
        messageId: message.id,
        content: [{ type: 'text', text: 'stream finalization' }],
        now: 2,
      },
    })

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
    const message = makeMessage(chat.id, refs)
    await putMessage(message)

    expect((await getDb().attachments.get(attachment.id))?.refCount).toBe(2)
    expect(await countLiveRefs(attachment.id)).toEqual({ messages: 1, drafts: 0 })
    expect(
      await getDb().attachmentRefEdges.where('attachmentId').equals(attachment.id).count(),
    ).toBe(2)

    const current = await getMessage(message.id)
    if (!current?.attachmentRefs) throw new Error('expected refs')
    const tombstoned = current.attachmentRefs.map((ref) =>
      ref.refId === refs[1]?.refId ? { ...ref, deletedAt: 0 } : ref,
    )
    await execute({
      kind: 'message.edit-content',
      input: {
        chatId: chat.id,
        messageId: message.id,
        content: current.content,
        attachmentRefs: tombstoned,
        now: 2,
      },
    })
    expect((await getDb().attachments.get(attachment.id))?.refCount).toBe(1)
    await execute({
      kind: 'message.delete',
      mode: 'single',
      input: {
        chatId: chat.id,
        messageId: message.id,
        activeLeafId: message.id,
        now: 3,
      },
    })
    expect((await getDb().attachments.get(attachment.id))?.refCount).toBe(1)
    expect(await countLiveRefs(attachment.id)).toEqual({ messages: 1, drafts: 0 })
    expect(
      await getDb().attachmentRefEdges.where('attachmentId').equals(attachment.id).count(),
    ).toBe(1)
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
      execute({
        kind: 'message.edit-content',
        input: {
          chatId: chat.id,
          messageId: original.id,
          content: original.content,
          attachmentRefs: [duplicate, { ...duplicate, updatedAt: duplicate.updatedAt + 1 }],
          now: 2,
        },
      }),
    ).rejects.toThrow(`DuplicateAttachmentRefId:message:${original.id}:${duplicate.refId}`)

    const missing = makeMessage(chat.id, [attachmentRef('missing-target')])
    await expect(putTestMessages([{ ...missing, parentId: original.id }])).rejects.toThrow(
      'AttachmentMissing:missing-target',
    )
    expect(await getMessage(missing.id)).toBeUndefined()
    expect(await getMessage(original.id)).toEqual(original)
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
    ).rejects.toThrow(`AttachmentRefChanged:${firstRef.refId}`)
    expect((await getMessage(first.id))?.attachmentRefs?.[0]).toMatchObject({
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
    await putWorkspaceDraft(
      {
        chatId: chat.id,
        text: '',
        attachmentRefs: [attachmentRef(attachment.id)],
        updatedAt: 1,
      },
      null,
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
