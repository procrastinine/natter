import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type { Attachment, Message, MessageAttachmentRef } from '../../src/core/types'
import { NATTER_INDEXED_DATABASE_NAMES } from '../../src/lib/origin-storage-names'
import {
  attachmentCatalogProjectionRow,
  emptyAttachmentCatalogAggregateRow,
} from '../../src/store/attachment-catalog-projection'
import {
  markAttachmentIntegrityRepairPending,
  pendingAttachmentIntegrityState,
} from '../../src/store/attachment-integrity-maintenance'
import { splitAttachmentForStorage } from '../../src/store/attachment-storage'
import { ingestAttachmentBytes } from '../../src/store/attachments'
import {
  createMutationScopeChecker,
  resolveMutationTableNames,
} from '../../src/store/browser-mutation-plan'
import {
  __resetBrowserRepositoryForTests,
  getBrowserRepository,
} from '../../src/store/browser-repo'
import { browserWorkspaceCatchupTransactionTableNames } from '../../src/store/browser-workspace-catchup-journal'
import type * as BrowserWorkspaceCompaction from '../../src/store/browser-workspace-compaction'
import {
  abandonPreparedBrowserWorkspaceDatabase,
  beginBrowserWorkspaceDatabaseReplacement,
  readBrowserWorkspaceCompactionState,
  readBrowserWorkspaceDatabaseManifest,
  recordBrowserWorkspaceCompactionDebt,
} from '../../src/store/browser-workspace-database-control'
import {
  type BrowserWorkspacePromotedReplacementDrain,
  createBrowserWorkspacePromotedReplacementDrain,
  openBrowserWorkspace,
  shutdownBrowserWorkspace,
} from '../../src/store/browser-workspace-lifecycle'
import { buildChat } from '../../src/store/chats'
import { __resetDbForTests, getDb, NatterDb } from '../../src/store/db'
import {
  __setLockBackendForTests,
  type AuthoritativeCommandLockSession,
  type LockBackend,
} from '../../src/store/locks'
import { splitMessageForStorage } from '../../src/store/message-storage'
import { type StreamLeaseRow, streamLeaseHasWriteFence } from '../../src/store/repository'
import {
  readStorageCompactionState,
  STORAGE_COMPACTION_MIN_RECLAIMABLE_BYTES,
} from '../../src/store/storage-compaction-state'
import {
  attachStorageMaintenanceRuntime,
  awaitStorageMaintenanceRuntimeIdle,
  closeStorageMaintenanceRuntime,
  startStorageMaintenanceRuntime as startAttachedStorageMaintenanceRuntime,
} from '../../src/store/storage-maintenance-runtime'
import type { CanonicalStreamJournalFrameRow } from '../../src/store/stream-journal-codec'
import { pendingStreamJournalIntegritySetting } from '../../src/store/stream-journal-integrity'
import { STREAM_JOURNAL_MUTATION_TRANSACTION_CAPABILITY } from '../../src/store/stream-journal-storage'
import {
  __resetWorkspaceRepositoryForTests,
  __setWorkspaceRepositoryForTests,
} from '../../src/store/workspace-repository'
import { runWorkspaceAction } from '../../src/store/workspace-runtime'
import {
  getWorkspaceRuntimeControlSnapshot,
  getWorkspaceRuntimeResourceStatuses,
} from '../../src/store/workspace-runtime-control'
import { putTestChat } from '../helpers/chats'
import { encodeTestStreamJournalEntries } from '../helpers/stream-journal'
import { testGenerationLease, testStreamLeaseAdmission } from '../helpers/stream-leases'

const compactionProbe = vi.hoisted(() => ({ fail: false, calls: 0 }))

vi.mock('../../src/store/browser-workspace-compaction', async (importOriginal) => {
  const actual = await importOriginal<typeof BrowserWorkspaceCompaction>()
  return {
    ...actual,
    tryStartBrowserWorkspaceCompaction: async (
      ...args: Parameters<typeof actual.tryStartBrowserWorkspaceCompaction>
    ) => {
      compactionProbe.calls += 1
      if (compactionProbe.fail) {
        throw new DOMException('destination quota exhausted', 'QuotaExceededError')
      }
      return actual.tryStartBrowserWorkspaceCompaction(...args)
    },
  }
})

const DAY_MS = 24 * 60 * 60 * 1_000
const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks')
let maintenanceReplacementDrain: BrowserWorkspacePromotedReplacementDrain

class ImmediateLockManager {
  request<T>(
    name: string,
    optionsOrCallback:
      | { mode?: 'shared' | 'exclusive'; ifAvailable?: boolean }
      | ((lock: Lock) => Promise<T> | T),
    callback?: (lock: Lock) => Promise<T> | T,
  ): Promise<T> {
    const operation = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback
    if (!operation) return Promise.reject(new Error('ImmediateLockCallbackMissing'))
    const mode = typeof optionsOrCallback === 'function' ? 'exclusive' : optionsOrCallback.mode
    return Promise.resolve(operation({ name, mode: mode ?? 'exclusive' }))
  }
}

class SelectiveSlotLockManager {
  readonly busySlots = new Set<string>()
  readonly slotAttempts = new Map<string, number>()

  request<T>(
    name: string,
    optionsOrCallback:
      | { mode?: 'shared' | 'exclusive'; ifAvailable?: boolean; signal?: AbortSignal }
      | ((lock: Lock) => Promise<T> | T),
    callback?: (lock: Lock | null) => Promise<T> | T,
  ): Promise<T> {
    const operation = (typeof optionsOrCallback === 'function' ? optionsOrCallback : callback) as
      | ((lock: Lock | null) => Promise<T> | T)
      | undefined
    if (!operation) return Promise.reject(new Error('SelectiveSlotLockCallbackMissing'))
    const options = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback
    if (name.startsWith('natter:workspace-slot:') && options.ifAvailable) {
      this.slotAttempts.set(name, (this.slotAttempts.get(name) ?? 0) + 1)
      if (this.busySlots.has(name)) return Promise.resolve(operation(null))
    }
    return Promise.resolve(operation({ name, mode: options.mode ?? 'exclusive' }))
  }
}

class PausableResourceLockBackend implements LockBackend {
  readonly kind = 'web-locks' as const
  private enteredResolve: (() => void) | undefined
  private releaseResolve: (() => void) | undefined
  private readonly entered = new Promise<void>((resolve) => {
    this.enteredResolve = resolve
  })
  private readonly released = new Promise<void>((resolve) => {
    this.releaseResolve = resolve
  })

  waitForLock(): Promise<void> {
    return this.entered
  }

  release(): void {
    this.releaseResolve?.()
  }

  async run<T>(
    logicalNames: readonly string[],
    operation: Parameters<LockBackend['run']>[1],
  ): Promise<T> {
    this.enteredResolve?.()
    await this.released
    return operation({
      kind: this.kind,
      logicalNames,
      runTransaction: (db, tables, write) =>
        db.transaction(
          'rw',
          tables.map((table) => db.table(typeof table === 'string' ? table : table.name)),
          write,
        ),
    }) as Promise<T>
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

interface StreamPruneResult {
  scannedStreamIds: number
  deletedStreamIds: string[]
  deletedFrames: number
  done: boolean
}

async function journalFramesForLease(lease: StreamLeaseRow, texts: readonly string[]) {
  if (!streamLeaseHasWriteFence(lease)) throw new Error('ExpectedFencedTestLease')
  return encodeTestStreamJournalEntries({
    streamId: lease.streamId,
    chatId: lease.chatId,
    messageId: lease.messageId,
    fence: {
      ownerClientId: lease.ownerClientId,
      fenceToken: lease.fenceToken,
      replacementEpoch: lease.replacementEpoch,
      admissionSequence: lease.admissionSequence,
    },
    entries: texts.map((text, index) => ({
      createdAt: lease.startedAt + index,
      event: { lane: 'text' as const, text },
    })),
  })
}

async function resetAll(): Promise<void> {
  __resetWorkspaceRepositoryForTests()
  __resetBrowserRepositoryForTests()
  __resetDbForTests()
  for (const name of NATTER_INDEXED_DATABASE_NAMES) await Dexie.delete(name)
}

async function createNamedDatabase(name: string): Promise<void> {
  const db = new Dexie(name)
  db.version(1).stores({ rows: '&id' })
  try {
    await db.table('rows').put({ id: 'orphan' })
  } finally {
    db.close()
  }
}

async function markIntegrityPending(): Promise<void> {
  const db = getDb()
  await db.transaction('rw', [db.attachmentCatalogAggregate, db.attachmentIntegrityState], (tx) =>
    markAttachmentIntegrityRepairPending(tx),
  )
}

function attachmentRef(attachmentId: string, updatedAt: number): MessageAttachmentRef {
  return {
    refId: `ref-${attachmentId}`,
    attachmentId,
    includeInContext: true,
    presentation: {},
    createdAt: updatedAt,
    updatedAt,
  }
}

function testMessage(
  chatId: string,
  index: number,
  attachmentRefs?: MessageAttachmentRef[],
): Message {
  const suffix = String(index).padStart(3, '0')
  return {
    id: `message-${suffix}`,
    chatId,
    parentId: null,
    siblingIndex: index,
    turnId: `turn-${suffix}`,
    turnIndex: index,
    createdAt: index + 1,
    role: 'user',
    origin: 'user',
    content: [{ type: 'text', text: suffix }],
    ...(attachmentRefs ? { attachmentRefs } : {}),
    nodeVersion: 0,
    deleted: false,
  }
}

async function putDraft(
  chatId: string,
  attachmentRefs: MessageAttachmentRef[],
  expectedUpdatedAt: number | null,
  updatedAt: number,
): Promise<void> {
  await runWorkspaceAction('attachment', (permit) =>
    getBrowserRepository().execute(permit, {
      kind: 'draft.put',
      input: {
        draft: { chatId, text: '', attachmentRefs, updatedAt },
        expectedUpdatedAt,
      },
    }),
  )
}

function requestCompaction(): Promise<unknown> {
  return recordBrowserWorkspaceCompactionDebt(
    getDb().name,
    STORAGE_COMPACTION_MIN_RECLAIMABLE_BYTES,
  )
}

function startMaintenance(): void {
  const runtime = getWorkspaceRuntimeControlSnapshot()
  if (!runtime.workspaceId) throw new Error('WorkspaceRuntimeFenceMissing')
  attachStorageMaintenanceRuntime(
    {
      workspaceId: runtime.workspaceId,
      replacementEpoch: runtime.replacementEpoch,
    },
    maintenanceReplacementDrain.handoffs,
  )
  startAttachedStorageMaintenanceRuntime()
}

beforeEach(async () => {
  __setLockBackendForTests(null)
  maintenanceReplacementDrain = createBrowserWorkspacePromotedReplacementDrain()
  compactionProbe.fail = false
  compactionProbe.calls = 0
  await resetAll()
  await openBrowserWorkspace()
  expect(
    getWorkspaceRuntimeResourceStatuses().find((resource) => resource.id === 'storage-maintenance')
      ?.status,
  ).not.toBe('waiting')
  closeStorageMaintenanceRuntime()
  await awaitStorageMaintenanceRuntimeIdle()
})

afterEach(async () => {
  __setLockBackendForTests(null)
  vi.useRealTimers()
  closeStorageMaintenanceRuntime()
  await awaitStorageMaintenanceRuntimeIdle()
  maintenanceReplacementDrain.closeAdmissions()
  await maintenanceReplacementDrain.awaitIdle()
  maintenanceReplacementDrain.assertClosed()
  vi.restoreAllMocks()
  __resetWorkspaceRepositoryForTests()
  await shutdownBrowserWorkspace()
  await resetAll()
  if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks)
  else Reflect.deleteProperty(navigator, 'locks')
})

describe('storage retention', () => {
  it('drains an abandoned workspace slot under the existing retention owner', async () => {
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: new ImmediateLockManager(),
    })
    const journal = await beginBrowserWorkspaceDatabaseReplacement()
    await createNamedDatabase(journal.destinationDatabaseName)
    await abandonPreparedBrowserWorkspaceDatabase(journal)

    startMaintenance()
    await vi.waitFor(async () => {
      expect((await readBrowserWorkspaceDatabaseManifest()).pending).toBeUndefined()
      expect(await Dexie.exists(journal.destinationDatabaseName)).toBe(false)
    })
    closeStorageMaintenanceRuntime()
    await awaitStorageMaintenanceRuntimeIdle()
  })

  it('blocks pending-journal compaction before quiescing the active runtime', async () => {
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: new ImmediateLockManager(),
    })
    const chat = buildChat({
      id: 'journal-busy-chat',
      settings: cloneDefaultChatSettings(),
      now: 1,
    })
    await putTestChat(chat)
    await requestCompaction()
    await beginBrowserWorkspaceDatabaseReplacement()
    const { tryStartBrowserWorkspaceCompaction } = await import(
      '../../src/store/browser-workspace-compaction'
    )

    await expect(tryStartBrowserWorkspaceCompaction()).resolves.toEqual({ kind: 'blocked' })

    expect(getWorkspaceRuntimeControlSnapshot().state).toBe('RUNNING')
    expect(await getDb().chats.get(chat.id)).toMatchObject({ id: chat.id })
  })

  it('retries a peer-held inactive workspace only after a later retention invalidation', async () => {
    const locks = new SelectiveSlotLockManager()
    const inactiveSlot = 'natter-workspace-a'
    const inactiveSlotLock = `natter:workspace-slot:${inactiveSlot}`
    locks.busySlots.add(inactiveSlotLock)
    Object.defineProperty(navigator, 'locks', { configurable: true, value: locks })
    await createNamedDatabase(inactiveSlot)

    startMaintenance()
    await vi.waitFor(async () => {
      expect(locks.slotAttempts.get(inactiveSlotLock)).toBe(1)
      expect(await Dexie.exists(inactiveSlot)).toBe(true)
    })

    closeStorageMaintenanceRuntime()
    await awaitStorageMaintenanceRuntimeIdle()
    locks.busySlots.clear()
    startMaintenance()

    await vi.waitFor(async () => {
      expect(locks.slotAttempts.get(inactiveSlotLock)).toBe(2)
      expect(await Dexie.exists(inactiveSlot)).toBe(false)
    })
    closeStorageMaintenanceRuntime()
    await awaitStorageMaintenanceRuntimeIdle()
  })

  it('executes one requested physical copy at exact idle and preserves the live workspace', async () => {
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: new ImmediateLockManager(),
    })
    const chat = buildChat({
      id: 'physical-compaction-chat',
      settings: cloneDefaultChatSettings(),
      now: 1,
    })
    await putTestChat(chat)
    await requestCompaction()
    const before = await readBrowserWorkspaceDatabaseManifest()

    startMaintenance()
    await vi.waitFor(
      async () => {
        const after = await readBrowserWorkspaceDatabaseManifest()
        expect(after.activationSequence).toBe(before.activationSequence + 1)
        expect(after.activeDatabaseName).not.toBe(before.activeDatabaseName)
        expect(getWorkspaceRuntimeControlSnapshot().state).toBe('RUNNING')
        expect(await getDb().chats.get(chat.id)).toMatchObject({ id: chat.id })
        const compaction = await readStorageCompactionState(getDb())
        expect(compaction).toMatchObject({
          requestRevision: 1,
          completedRevision: 1,
        })
        expect(compaction.knownReclaimableBytes).toBeLessThan(
          STORAGE_COMPACTION_MIN_RECLAIMABLE_BYTES,
        )
      },
      { timeout: 5_000 },
    )
    await vi.waitFor(async () => {
      expect((await readBrowserWorkspaceDatabaseManifest()).pending).toBeUndefined()
    })
    closeStorageMaintenanceRuntime()
    await awaitStorageMaintenanceRuntimeIdle()

    expect((await readBrowserWorkspaceDatabaseManifest()).activationSequence).toBe(
      before.activationSequence + 1,
    )
  }, 15_000)

  it('keeps a failed copy durably requested without hot-looping and retries a newer request', async () => {
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: new ImmediateLockManager(),
    })
    const chat = buildChat({
      id: 'failed-physical-compaction-chat',
      settings: cloneDefaultChatSettings(),
      now: 1,
    })
    await putTestChat(chat)
    await requestCompaction()
    const before = await readBrowserWorkspaceDatabaseManifest()
    compactionProbe.fail = true
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})

    startMaintenance()
    await vi.waitFor(
      async () => {
        expect(compactionProbe.calls).toBeGreaterThan(0)
        expect((await readBrowserWorkspaceDatabaseManifest()).pending).toBeUndefined()
        expect(getWorkspaceRuntimeControlSnapshot().state).toBe('RUNNING')
      },
      { timeout: 5_000 },
    )
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(compactionProbe.calls).toBeLessThanOrEqual(2)
    expect(await readStorageCompactionState(getDb())).toMatchObject({ requestRevision: 1 })
    expect((await readBrowserWorkspaceDatabaseManifest()).activationSequence).toBe(
      before.activationSequence,
    )

    closeStorageMaintenanceRuntime()
    await awaitStorageMaintenanceRuntimeIdle()
    const failedCalls = compactionProbe.calls
    compactionProbe.fail = false
    diagnostic.mockRestore()
    await requestCompaction()

    startMaintenance()
    await vi.waitFor(
      async () => {
        expect(compactionProbe.calls).toBeGreaterThan(failedCalls)
        expect((await readBrowserWorkspaceDatabaseManifest()).activationSequence).toBe(
          before.activationSequence + 1,
        )
        expect(getWorkspaceRuntimeControlSnapshot().state).toBe('RUNNING')
        expect(await getDb().chats.get(chat.id)).toMatchObject({ id: chat.id })
      },
      { timeout: 5_000 },
    )
    await vi.waitFor(async () => {
      expect((await readBrowserWorkspaceDatabaseManifest()).pending).toBeUndefined()
    })
    closeStorageMaintenanceRuntime()
    await awaitStorageMaintenanceRuntimeIdle()
    expect(await getDb().chats.get(chat.id)).toMatchObject({ id: chat.id })
    const completed = await readStorageCompactionState(getDb())
    expect(completed).toMatchObject({
      requestRevision: 2,
      completedRevision: 2,
    })
    expect(completed.knownReclaimableBytes).toBeLessThan(STORAGE_COMPACTION_MIN_RECLAIMABLE_BYTES)
  }, 15_000)

  it('does not retry a failed replacement merely because rollback reopened the runtime', async () => {
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: new ImmediateLockManager(),
    })
    const chat = buildChat({
      id: 'rollback-compaction-chat',
      settings: cloneDefaultChatSettings(),
      now: 1,
    })
    await putTestChat(chat)
    await getDb().table<Record<string, unknown>, string>('attachmentArtifacts').put({
      artifactId: 'rollback-copy-poison',
      kind: 'text',
      processorId: 'test',
      label: 'poison',
      createdAt: 1,
    })
    await requestCompaction()
    const before = await readBrowserWorkspaceDatabaseManifest()
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})

    startMaintenance()
    await vi.waitFor(
      async () => {
        expect(compactionProbe.calls).toBeGreaterThanOrEqual(1)
        expect(getWorkspaceRuntimeControlSnapshot().state).toBe('RUNNING')
        expect(await readStorageCompactionState(getDb())).toMatchObject({
          requestRevision: 1,
          attemptedRevision: 1,
          completedRevision: 0,
        })
      },
      { timeout: 5_000 },
    )
    await vi.waitFor(async () => {
      expect((await readBrowserWorkspaceDatabaseManifest()).pending).toBeUndefined()
    })
    closeStorageMaintenanceRuntime()
    await awaitStorageMaintenanceRuntimeIdle()
    expect((await readBrowserWorkspaceDatabaseManifest()).activationSequence).toBe(
      before.activationSequence,
    )
    expect(await readStorageCompactionState(getDb())).toMatchObject({
      requestRevision: 1,
      attemptedRevision: 1,
      completedRevision: 0,
    })
    expect(await getDb().chats.get(chat.id)).toMatchObject({ id: chat.id })

    const { tryStartBrowserWorkspaceCompaction } = await import(
      '../../src/store/browser-workspace-compaction'
    )
    await expect(tryStartBrowserWorkspaceCompaction()).resolves.toEqual({ kind: 'skipped' })
    diagnostic.mockRestore()
  }, 15_000)

  it('keeps foreground work live without repeating the physical copy', async () => {
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: new ImmediateLockManager(),
    })
    const chat = buildChat({
      id: 'preempted-physical-compaction-chat',
      title: 'Before catch-up',
      settings: cloneDefaultChatSettings(),
      now: 1,
    })
    await putTestChat(chat)
    await requestCompaction()
    const before = await readBrowserWorkspaceDatabaseManifest()
    let releaseCopy!: () => void
    let markCopyHeld!: () => void
    const copyHeld = new Promise<void>((resolve) => {
      markCopyHeld = resolve
    })
    const copyGate = new Promise<void>((resolve) => {
      releaseCopy = resolve
    })
    const sourceDatabaseName = getDb().name
    const blocker = new NatterDb(sourceDatabaseName)
    await blocker.open()
    const holdSourceCopy = blocker.transaction('rw', blocker.textTemplates, async () => {
      markCopyHeld()
      await Dexie.waitFor(copyGate)
    })
    try {
      await copyHeld

      startMaintenance()
      await vi.waitFor(async () => {
        expect(await readBrowserWorkspaceCompactionState(sourceDatabaseName)).toMatchObject({
          requestRevision: 1,
          attemptedRevision: 1,
          completedRevision: 0,
        })
      })
      let foregroundCalls = 0
      const foreground = runWorkspaceAction('attachment', () => {
        foregroundCalls += 1
      })
      releaseCopy()
      await holdSourceCopy
      await foreground
      expect(foregroundCalls).toBe(1)

      await vi.waitFor(
        async () => {
          const manifest = await readBrowserWorkspaceDatabaseManifest()
          expect(compactionProbe.calls).toBe(1)
          expect(
            await readBrowserWorkspaceCompactionState(manifest.activeDatabaseName),
          ).toMatchObject({
            requestRevision: 1,
            attemptedRevision: 1,
            completedRevision: 1,
          })
          expect(manifest.activationSequence).toBe(before.activationSequence + 1)
          expect(getWorkspaceRuntimeControlSnapshot().state).toBe('RUNNING')
        },
        { timeout: 5_000 },
      )
      await expect(getDb().chats.get(chat.id)).resolves.toMatchObject({ id: chat.id })
    } finally {
      releaseCopy()
      await holdSourceCopy.catch(() => undefined)
      blocker.close()
    }
    await vi.waitFor(async () => {
      expect((await readBrowserWorkspaceDatabaseManifest()).pending).toBeUndefined()
    })
    closeStorageMaintenanceRuntime()
    await awaitStorageMaintenanceRuntimeIdle()
  }, 15_000)

  it('reclaims only day-old empty temporary chats during the normal runtime pass', async () => {
    const now = Date.now()
    const stale = buildChat({
      id: 'stale-empty-temporary-chat',
      settings: cloneDefaultChatSettings(),
      temporary: true,
      now: now - 2 * 24 * 60 * 60 * 1_000,
    })
    const recent = buildChat({
      id: 'recent-empty-temporary-chat',
      settings: cloneDefaultChatSettings(),
      temporary: true,
      now,
    })
    await putTestChat(stale)
    await putTestChat(recent)

    startMaintenance()
    await vi.waitFor(async () => {
      expect(await getDb().chats.get(stale.id)).toBeUndefined()
    })
    closeStorageMaintenanceRuntime()
    await awaitStorageMaintenanceRuntimeIdle()

    expect(await getDb().chats.get(stale.id)).toBeUndefined()
    expect(await getDb().chats.get(recent.id)).toBeDefined()
  })

  it('retires orphan chat frames in bounded pages before deleting the empty draft', async () => {
    const chat = buildChat({
      id: 'stale-empty-chat-with-orphan-frames',
      settings: cloneDefaultChatSettings(),
      temporary: true,
      now: 1,
    })
    await putTestChat(chat)
    const orphan = testGenerationLease({
      streamId: 'orphan-chat-stream',
      chatId: chat.id,
      messageId: 'orphan-chat-message',
      ownerClientId: 'gone-owner',
      fenceToken: 'orphan-chat-fence',
      replacementEpoch: 0,
      admissionSequence: 1,
      revision: 1,
      startedAt: 1,
      heartbeatAt: 1,
      phase: 'reserved',
      postCommit: { usedAt: 1, profileId: 'profile' },
    })
    await getDb().streamChunks.bulkPut(
      await journalFramesForLease(
        orphan,
        Array.from({ length: 129 }, (_, index) => `orphan-frame-${index}`),
      ),
    )

    const pages = []
    for (;;) {
      const commit = await runWorkspaceAction('maintenance', (permit) =>
        getBrowserRepository().execute(permit, {
          kind: 'maintenance.prune-empty-draft-chats',
          now: 100,
          maxAgeMs: 0,
          limit: 1,
        }),
      )
      pages.push(commit.value)
      if (commit.value.done) break
    }

    expect(pages.map((page) => page.retiredStreamFrames)).toEqual([64, 64, 1])
    expect(pages.map((page) => page.scannedChatIds)).toEqual([1, 1, 1])
    expect(pages.slice(0, 2).every((page) => page.deletedChatIds.length === 0)).toBe(true)
    expect(pages.at(-1)).toMatchObject({
      deletedChatIds: [chat.id],
      affectedAttachmentIds: [],
      retiredStreamFrames: 1,
      done: true,
    })
    expect(await getDb().streamChunks.where('chatId').equals(chat.id).count()).toBe(0)
    expect(await getDb().chats.get(chat.id)).toBeUndefined()
  })

  it('owns transient pass failures with one capped retry deadline instead of disabling retention', async () => {
    const now = Date.now()
    const stale = buildChat({
      id: 'retry-stale-empty-temporary-chat',
      settings: cloneDefaultChatSettings(),
      temporary: true,
      now: now - 2 * DAY_MS,
    })
    await putTestChat(stale)
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
    let injectedFailure = false
    const target = getBrowserRepository()
    const execute = target.execute.bind(target)
    __setWorkspaceRepositoryForTests({
      query: target.query.bind(target),
      execute: async (permit, command) => {
        if (command.kind === 'maintenance.prune-empty-draft-chats' && !injectedFailure) {
          injectedFailure = true
          throw new DOMException('transient repository failure', 'UnknownError')
        }
        return execute(permit, command)
      },
      replace: target.replace.bind(target),
      subscribeChanges: target.subscribeChanges.bind(target),
    })

    startMaintenance()
    await vi.waitFor(() => expect(diagnostic).toHaveBeenCalledTimes(1))
    expect(injectedFailure).toBe(true)
    expect(await getDb().chats.get(stale.id)).toBeDefined()
    await vi.waitFor(async () => expect(await getDb().chats.get(stale.id)).toBeUndefined(), {
      timeout: 2_500,
    })
    closeStorageMaintenanceRuntime()
    await awaitStorageMaintenanceRuntimeIdle()
  })

  it('reconciles a stale positive attachment count before the next bounded reap page', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(10 * DAY_MS)
    const ingested = await ingestAttachmentBytes({
      blob: new Blob(['orphan'], { type: 'text/plain' }),
      filename: 'stale-positive.txt',
      now: 1,
    })
    await getDb().attachments.update(ingested.attachment.id, { refCount: 99 })
    await markIntegrityPending()

    startMaintenance()
    await vi.waitFor(
      async () => {
        const attachment = await getDb().attachments.get(ingested.attachment.id)
        expect(attachment).toMatchObject({ refCount: 0 })
        expect(attachment?.unreferencedAt).toBeGreaterThanOrEqual(10 * DAY_MS)
      },
      { timeout: 2_000 },
    )
    closeStorageMaintenanceRuntime()
    await awaitStorageMaintenanceRuntimeIdle()

    vi.setSystemTime(12 * DAY_MS)
    startMaintenance()
    await vi.waitFor(
      async () => {
        expect(await getDb().attachments.get(ingested.attachment.id)).toBeUndefined()
      },
      { timeout: 2_000 },
    )
    closeStorageMaintenanceRuntime()
    await awaitStorageMaintenanceRuntimeIdle()

    expect(
      await getDb().attachmentBlobs.where('attachmentId').equals(ingested.attachment.id).count(),
    ).toBe(0)
  })

  it('starts reclamation from storage observation and resets it across owner transitions', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(100 * DAY_MS)
    const ingested = await ingestAttachmentBytes({
      blob: new Blob(['portable-old'], { type: 'text/plain' }),
      filename: 'portable-old.txt',
      now: 1,
    })
    const attachmentId = ingested.attachment.id
    expect(await getDb().attachments.get(attachmentId)).toMatchObject({
      createdAt: 1,
      refCount: 0,
      unreferencedAt: 100 * DAY_MS,
    })

    const earlyReap = await runWorkspaceAction('maintenance', async (permit) =>
      getBrowserRepository().execute(permit, {
        kind: 'attachment.reap',
        now: 100 * DAY_MS,
        maxAgeMs: DAY_MS,
      }),
    )
    expect(earlyReap.value.deletedAttachmentIds).toEqual([])
    expect(earlyReap.value.earliestDeferredAt).toBe(100 * DAY_MS)

    const chat = buildChat({
      id: 'attachment-retention-owner',
      settings: cloneDefaultChatSettings(),
      now: 1,
    })
    await putTestChat(chat)
    const ref = attachmentRef(attachmentId, 2)
    await putDraft(chat.id, [ref], null, 2)
    expect(await getDb().attachments.get(attachmentId)).toMatchObject({
      refCount: 1,
      unreferencedAt: null,
    })

    vi.setSystemTime(101 * DAY_MS)
    await putDraft(chat.id, [], 2, 3)
    expect(await getDb().attachments.get(attachmentId)).toMatchObject({
      refCount: 0,
      unreferencedAt: 101 * DAY_MS,
    })

    vi.setSystemTime(102 * DAY_MS)
    await putDraft(chat.id, [ref], 3, 4)
    await putDraft(chat.id, [], 4, 5)
    expect(await getDb().attachments.get(attachmentId)).toMatchObject({
      refCount: 0,
      unreferencedAt: 102 * DAY_MS,
    })

    const stillFresh = await runWorkspaceAction('maintenance', async (permit) =>
      getBrowserRepository().execute(permit, {
        kind: 'attachment.reap',
        now: 102 * DAY_MS,
        maxAgeMs: 0,
      }),
    )
    expect(stillFresh.value.deletedAttachmentIds).toEqual([])

    vi.setSystemTime(104 * DAY_MS)
    const expired = await runWorkspaceAction('maintenance', async (permit) =>
      getBrowserRepository().execute(permit, {
        kind: 'attachment.reap',
        now: 104 * DAY_MS,
        maxAgeMs: DAY_MS,
      }),
    )
    expect(expired.value.deletedAttachmentIds).toEqual([attachmentId])
  })

  it('publishes every attachment whose draft edge projection changed', async () => {
    const chat = buildChat({
      id: 'draft-edge-invalidations',
      settings: cloneDefaultChatSettings(),
      now: 1,
    })
    await putTestChat(chat)
    const first = await ingestAttachmentBytes({
      blob: new Blob(['first'], { type: 'text/plain' }),
      filename: 'first.txt',
      now: 1,
    })
    const second = await ingestAttachmentBytes({
      blob: new Blob(['second'], { type: 'text/plain' }),
      filename: 'second.txt',
      now: 1,
    })
    const firstRef = attachmentRef(first.attachment.id, 2)
    await putDraft(chat.id, [firstRef], null, 2)

    const replacementRef = attachmentRef(second.attachment.id, 3)
    const replacement = await runWorkspaceAction('attachment', (permit) =>
      getBrowserRepository().execute(permit, {
        kind: 'draft.put',
        input: {
          draft: { chatId: chat.id, text: '', attachmentRefs: [replacementRef], updatedAt: 3 },
          expectedUpdatedAt: 2,
        },
      }),
    )
    expect(
      replacement.delta.invalidations.find((invalidation) => invalidation.kind === 'attachment'),
    ).toEqual({
      kind: 'attachment',
      attachmentIds: [first.attachment.id, second.attachment.id],
    })

    const hiddenRef = { ...replacementRef, includeInContext: false, updatedAt: 4 }
    const visibility = await runWorkspaceAction('attachment', (permit) =>
      getBrowserRepository().execute(permit, {
        kind: 'draft.put',
        input: {
          draft: { chatId: chat.id, text: '', attachmentRefs: [hiddenRef], updatedAt: 4 },
          expectedUpdatedAt: 3,
        },
      }),
    )
    expect(
      visibility.delta.invalidations.find((invalidation) => invalidation.kind === 'attachment'),
    ).toEqual({ kind: 'attachment', attachmentIds: [second.attachment.id] })
    expect(await getDb().attachmentCatalogRows.get(second.attachment.id)).toMatchObject({
      refCount: 1,
      visibleRefCount: 0,
    })
  })

  it('replaces 129 draft edges without hydrating artifacts or touching unrelated attachments', async () => {
    const chat = buildChat({
      id: 'draft-edge-scale',
      settings: cloneDefaultChatSettings(),
      now: 1,
    })
    await putTestChat(chat)
    const attachment = (id: string): Attachment => ({
      id,
      kind: 'document',
      mime: 'text/plain',
      filename: `${id}.txt`,
      origin: 'user-upload',
      createdAt: 1,
      updatedAt: 1,
      storage: { kind: 'missing', reason: 'import-missing', missingSince: 1 },
      artifacts: [],
      processing: [],
      refCount: 0,
    })
    const firstIds = Array.from(
      { length: 129 },
      (_, index) => `draft-scale-first-${String(index).padStart(3, '0')}`,
    )
    const secondIds = Array.from(
      { length: 129 },
      (_, index) => `draft-scale-second-${String(index).padStart(3, '0')}`,
    )
    const headers = [...firstIds, ...secondIds].map((id) =>
      splitAttachmentForStorage(attachment(id), 0, 1),
    )
    await getDb().attachments.bulkPut(headers)
    await getDb().attachmentCatalogRows.bulkPut(
      headers.map((header) =>
        attachmentCatalogProjectionRow(header, {
          refCount: 0,
          messageRefCount: 0,
          draftRefCount: 0,
          visibleRefCount: 0,
        }),
      ),
    )
    await getDb().attachmentCatalogAggregate.put({
      ...emptyAttachmentCatalogAggregateRow(),
      totalCount: headers.length,
      activeCount: headers.length,
      unreferencedCount: headers.length,
      missingCount: headers.length,
    })
    const unrelated = await ingestAttachmentBytes({
      blob: new Blob(['unrelated-scale'], { type: 'text/plain' }),
      filename: 'unrelated-scale.txt',
      now: 1,
    })
    const firstRefs = firstIds.map((attachmentId, index) => ({
      ...attachmentRef(attachmentId, 2),
      refId: `first-scale-${String(index).padStart(3, '0')}`,
    }))
    const secondRefs = secondIds.map((attachmentId, index) => ({
      ...attachmentRef(attachmentId, 3),
      refId: `second-scale-${String(index).padStart(3, '0')}`,
    }))
    await putDraft(chat.id, firstRefs, null, 2)
    const unrelatedBefore = await getDb().attachments.get(unrelated.attachment.id)

    const replacementCommand = {
      kind: 'draft.put' as const,
      input: {
        draft: {
          chatId: chat.id,
          text: 'scaled',
          attachmentRefs: secondRefs,
          updatedAt: 3,
        },
        expectedUpdatedAt: 2,
      },
    }
    const replacement = await runWorkspaceAction('attachment', (permit) =>
      getBrowserRepository().execute(permit, replacementCommand),
    )

    expect(
      replacement.delta.invalidations.find((invalidation) => invalidation.kind === 'attachment'),
    ).toEqual({
      kind: 'attachment',
      attachmentIds: [...firstIds, ...secondIds].sort(),
    })
    expect(await getDb().attachmentRefEdges.where('attachmentId').anyOf(firstIds).count()).toBe(0)
    expect(await getDb().attachmentRefEdges.where('attachmentId').anyOf(secondIds).count()).toBe(
      129,
    )
    expect(await getDb().drafts.get(chat.id)).toMatchObject({
      text: 'scaled',
      attachmentRefs: secondRefs,
      updatedAt: 3,
    })
    expect(await getDb().attachments.get(unrelated.attachment.id)).toEqual(unrelatedBefore)

    await expect(
      runWorkspaceAction('attachment', (permit) =>
        getBrowserRepository().execute(permit, replacementCommand),
      ),
    ).rejects.toThrow(`DraftChanged:${chat.id}`)
    expect(await getDb().attachmentRefEdges.where('attachmentId').anyOf(secondIds).count()).toBe(
      129,
    )
  }, 30_000)

  it('never reaps before the complete persisted integrity cycle reaches a later live owner', async () => {
    const chat = buildChat({
      id: 'integrity-gates-reap',
      settings: cloneDefaultChatSettings(),
      now: 1,
    })
    await putTestChat(chat)
    const ingested = await ingestAttachmentBytes({
      blob: new Blob(['must-live'], { type: 'text/plain' }),
      filename: 'must-live.txt',
      now: 1,
    })
    const ref = attachmentRef(ingested.attachment.id, 2)
    const rows = Array.from({ length: 33 }, (_, index) =>
      testMessage(chat.id, index, index === 32 ? [ref] : undefined),
    )
    await getDb().messages.bulkPut(rows.map((message) => splitMessageForStorage(message).header))
    await getDb().attachments.update(ingested.attachment.id, {
      refCount: 0,
      unreferencedAt: Date.now() - 2 * DAY_MS,
    })
    await getDb().attachmentRefEdges.clear()
    await markIntegrityPending()

    startMaintenance()
    await vi.waitFor(
      async () => {
        expect(
          await getDb()
            .attachmentRefEdges.where('attachmentId')
            .equals(ingested.attachment.id)
            .count(),
        ).toBe(1)
      },
      { timeout: 2_000 },
    )
    expect(await getDb().attachments.get(ingested.attachment.id)).toBeDefined()
    await vi.waitFor(
      async () => {
        expect(await getDb().attachmentIntegrityState.get('workspace')).toEqual(
          expect.objectContaining({ phase: 'complete' }),
        )
      },
      { timeout: 3_000 },
    )
    closeStorageMaintenanceRuntime()
    await awaitStorageMaintenanceRuntimeIdle()

    expect(await getDb().attachments.get(ingested.attachment.id)).toMatchObject({
      refCount: 1,
      unreferencedAt: null,
    })
  })

  it('finishes one pending integrity barrier before every page of a bounded reap cycle', async () => {
    for (let index = 0; index < 70; index += 1) {
      await ingestAttachmentBytes({
        blob: new Blob([`runtime-orphan-${index}`], { type: 'text/plain' }),
        filename: `runtime-orphan-${index}.txt`,
        now: index,
      })
    }
    await getDb()
      .attachments.toCollection()
      .modify({
        unreferencedAt: Date.now() - 2 * DAY_MS,
      })
    await markIntegrityPending()

    startMaintenance()
    await vi.waitFor(
      async () => {
        expect(await getDb().attachments.count()).toBe(0)
      },
      { timeout: 3_000 },
    )
    closeStorageMaintenanceRuntime()
    await awaitStorageMaintenanceRuntimeIdle()

    expect(await getDb().storageRetentionState.get('attachment-reap')).toMatchObject({
      phase: 'idle',
      revision: 3,
    })
    expect(await getDb().attachmentIntegrityState.get('workspace')).toEqual(
      expect.objectContaining({ phase: 'complete' }),
    )
  })

  it('uses the durable complete marker without rescanning canonical attachment owners', async () => {
    await getDb().attachmentIntegrityState.put(pendingAttachmentIntegrityState())
    startMaintenance()
    closeStorageMaintenanceRuntime()
    await awaitStorageMaintenanceRuntimeIdle()

    const db = getDb()
    const messageScans = vi.spyOn(db.messages, 'orderBy')
    const draftScans = vi.spyOn(db.drafts, 'orderBy')
    const attachmentScans = vi.spyOn(db.attachments, 'orderBy')

    startMaintenance()
    closeStorageMaintenanceRuntime()
    await awaitStorageMaintenanceRuntimeIdle()

    expect(messageScans).not.toHaveBeenCalled()
    expect(draftScans).not.toHaveBeenCalled()
    expect(attachmentScans).not.toHaveBeenCalled()
  })

  it('rejects every mutation scope outside the centralized transaction plan', () => {
    const checker = createMutationScopeChecker([{ kind: 'attachment', attachmentId: 'attachment' }])

    expect(() =>
      checker.assertScope({ kind: 'attachment', attachmentId: 'attachment' }),
    ).not.toThrow()
    expect(() => checker.assertScope({ kind: 'message', messageId: 'message' })).toThrowError(
      'UndeclaredScope:message:message',
    )
  })

  it('keeps the final journal schema narrow and removes the retired branch body cache', () => {
    const db = getDb()
    expect(db.tables.map((table) => table.name)).not.toContain('chatBranchCache')
    expect(db.streamChunks.schema.indexes.map((index) => index.src)).toEqual([
      'streamId',
      'chatId',
      '[streamId+seq]',
    ])
    expect(db.streamLeases.schema.indexes.map((index) => index.src)).toEqual([
      '&targetOwnerKey',
      '[chatId+streamId]',
      '[terminalRetentionAt+streamId]',
    ])
  })

  it('repairs no-lease journal frames once in durable bounded pages without hydrating events', async () => {
    const db = getDb()
    const frames: CanonicalStreamJournalFrameRow[] = []
    const leases: StreamLeaseRow[] = []
    const retainedStreamIds = new Set<string>()
    let expectedDeletedFrames = 0
    for (let index = 0; index < 70; index += 1) {
      const streamId = `stream-${String(index).padStart(3, '0')}`
      const lease = testGenerationLease({
        streamId,
        chatId: 'chat',
        messageId: `message-${index}`,
        ownerClientId: 'owner',
        fenceToken: 'fence',
        replacementEpoch: 0,
        admissionSequence: 1,
        revision: 1,
        startedAt: index,
        heartbeatAt: index,
        phase: 'reserved',
        postCommit: { usedAt: index, profileId: 'profile' },
      })
      const streamFrames = await journalFramesForLease(
        lease,
        index === 1
          ? Array.from({ length: 129 }, (_, frameIndex) => `orphan-${frameIndex}`)
          : ['first', 'second'],
      )
      frames.push(...streamFrames)
      if (index % 3 === 0) {
        retainedStreamIds.add(streamId)
        leases.push(lease)
      } else {
        expectedDeletedFrames += streamFrames.length
      }
    }
    await db.streamChunks.bulkPut(frames)
    await db.streamLeases.bulkPut(leases)
    await db.settings.put(pendingStreamJournalIntegritySetting())
    const fullTableRead = vi.spyOn(db.streamChunks, 'toArray')
    const scans: StreamPruneResult[] = []
    for (;;) {
      const result = await runWorkspaceAction('maintenance', async (permit) => {
        const commit = await getBrowserRepository().execute(permit, {
          kind: 'maintenance.reconcile-stream-journal-integrity',
          limit: 32,
        })
        return commit.value
      })
      scans.push(result)
      if (result.done) break
    }

    expect(scans.every((scan) => scan.scannedStreamIds <= 32)).toBe(true)
    expect(scans.every((scan) => scan.deletedFrames <= 32)).toBe(true)
    expect(scans.reduce((total, scan) => total + scan.deletedFrames, 0)).toBe(expectedDeletedFrames)
    expect(fullTableRead).not.toHaveBeenCalled()
    const remaining = new Set((await db.streamChunks.orderBy('streamId').uniqueKeys()).map(String))
    expect(remaining).toEqual(retainedStreamIds)
    const completed = await runWorkspaceAction(
      'maintenance',
      async (permit) =>
        (
          await getBrowserRepository().execute(permit, {
            kind: 'maintenance.reconcile-stream-journal-integrity',
            limit: 32,
          })
        ).value,
    )
    expect(completed).toEqual({
      scannedStreamIds: 0,
      deletedStreamIds: [],
      deletedFrames: 0,
      done: true,
    })
  })

  it('reclaims old finalized journals while preserving unfinished, sealed, and metadata-pending output', async () => {
    const db = getDb()
    const now = Date.now()
    const terminal = testGenerationLease({
      streamId: 'terminal-stream',
      chatId: 'chat',
      messageId: 'terminal-message',
      custody: 'recovery',
      ownerClientId: 'recovery-owner',
      fenceToken: 'terminal-fence',
      replacementEpoch: 0,
      admissionSequence: 1,
      revision: 1,
      startedAt: now - 10,
      heartbeatAt: now,
      phase: 'metadata-committed',
      canonicalAt: now - 3,
      metadataCommittedAt: now - 2,
      postCommit: { usedAt: now - 10, profileId: 'profile' },
    })
    const unfinished = testGenerationLease({
      streamId: 'unfinished-stream',
      chatId: 'chat',
      messageId: 'unfinished-message',
      ownerClientId: 'writer-owner',
      fenceToken: 'unfinished-fence',
      replacementEpoch: 0,
      admissionSequence: 1,
      revision: 1,
      startedAt: now - 10,
      heartbeatAt: now,
      postCommit: { usedAt: now - 10, profileId: 'profile' },
    })
    const metadataPending = testGenerationLease({
      streamId: 'metadata-pending-stream',
      chatId: 'chat',
      messageId: 'metadata-pending-message',
      ownerClientId: 'writer-owner',
      fenceToken: 'metadata-pending-fence',
      replacementEpoch: 0,
      admissionSequence: 1,
      revision: 1,
      startedAt: now - 10,
      heartbeatAt: now,
      phase: 'canonical',
      canonicalAt: now - 3,
      postCommit: { usedAt: now - 10, profileId: 'profile' },
    })
    const terminalDecided = testGenerationLease({
      streamId: 'terminal-decided-stream',
      chatId: 'chat',
      messageId: 'terminal-decided-message',
      ownerClientId: 'writer-owner',
      fenceToken: 'terminal-decided-fence',
      replacementEpoch: 0,
      admissionSequence: 1,
      revision: 1,
      startedAt: now - 10,
      heartbeatAt: now,
      phase: 'terminal-decided',
      journalMaxSeq: 0,
      postCommit: { usedAt: now - 10, profileId: 'profile' },
    })
    const metadataCommitted = testGenerationLease({
      streamId: 'metadata-committed-stream',
      chatId: 'chat',
      messageId: 'metadata-committed-message',
      custody: 'recovery',
      ownerClientId: 'recovery-owner',
      fenceToken: 'metadata-committed-fence',
      replacementEpoch: 0,
      admissionSequence: 1,
      revision: 1,
      startedAt: now - 10,
      heartbeatAt: now,
      phase: 'metadata-committed',
      canonicalAt: now - 3,
      metadataCommittedAt: now - 2,
      postCommit: { usedAt: now - 10, profileId: 'profile' },
    })
    await db.streamLeases.bulkPut([
      terminal,
      unfinished,
      terminalDecided,
      metadataPending,
      metadataCommitted,
    ])
    const journalFrames: CanonicalStreamJournalFrameRow[] = []
    for (const lease of [
      terminal,
      unfinished,
      terminalDecided,
      metadataPending,
      metadataCommitted,
    ]) {
      journalFrames.push(
        ...(await journalFramesForLease(
          lease,
          lease.streamId === 'metadata-committed-stream'
            ? Array.from({ length: 129 }, (_, index) => `recoverable-${index}`)
            : ['recoverable'],
        )),
      )
    }
    await db.streamChunks.bulkPut(journalFrames)
    const commits = []
    for (;;) {
      const commit = await runWorkspaceAction('maintenance', (permit) =>
        getBrowserRepository().execute(permit, {
          kind: 'maintenance.prune-terminal-stream-journals',
          now,
          maxAgeMs: 0,
          limit: 32,
        }),
      )
      commits.push(commit)
      if (commit.value.done) break
    }

    expect(commits.every((commit) => commit.value.deletedFrames <= 32)).toBe(true)
    const deletedByCaller = commits.flatMap((commit) => commit.value.deletedStreamIds)
    expect(deletedByCaller.length).toBeGreaterThan(0)
    expect(
      deletedByCaller.every((streamId) =>
        ['metadata-committed-stream', 'terminal-stream'].includes(streamId),
      ),
    ).toBe(true)
    expect(await db.streamLeases.get('metadata-committed-stream')).toBeUndefined()
    expect(
      await db.streamChunks.where('streamId').equals('metadata-committed-stream').count(),
    ).toBe(0)
    expect(await db.streamLeases.get('terminal-stream')).toBeUndefined()
    expect(await db.streamChunks.where('streamId').equals('terminal-stream').count()).toBe(0)
    expect(await db.streamLeases.get('unfinished-stream')).toEqual(unfinished)
    expect(await db.streamChunks.where('streamId').equals('unfinished-stream').count()).toBe(1)
    expect(await db.streamLeases.get('terminal-decided-stream')).toMatchObject({
      streamId: terminalDecided.streamId,
      chatId: terminalDecided.chatId,
      messageId: terminalDecided.messageId,
      phase: terminalDecided.phase,
      terminal: terminalDecided.terminal,
      postCommit: terminalDecided.postCommit,
    })
    expect(await db.streamChunks.where('streamId').equals('terminal-decided-stream').count()).toBe(
      1,
    )
    expect(await db.streamLeases.get('metadata-pending-stream')).toMatchObject({
      streamId: metadataPending.streamId,
      chatId: metadataPending.chatId,
      messageId: metadataPending.messageId,
      phase: metadataPending.phase,
      postCommit: metadataPending.postCommit,
    })
    expect(await db.streamChunks.where('streamId').equals('metadata-pending-stream').count()).toBe(
      1,
    )
    expect(commits.at(-1)?.value.earliestDeferredAt).toBeUndefined()
    const callerInvalidations = commits.flatMap((commit) => commit.delta.invalidations)
    for (const streamId of deletedByCaller) {
      expect(callerInvalidations).toEqual(
        expect.arrayContaining([
          {
            kind: 'stream-lease',
            chatId: 'chat',
            streamIds: [streamId],
          },
          {
            kind: 'stream-chunks',
            chatId: 'chat',
            streamIds: [streamId],
          },
        ]),
      )
    }
  })

  it('reaps old zero-owner attachment bundles in bounded batches', async () => {
    const objectStore = IDBTransaction.prototype.objectStore
    const storeAccesses: Array<{ name: string; declared: string[] }> = []
    vi.spyOn(IDBTransaction.prototype, 'objectStore').mockImplementation(function (
      this: IDBTransaction,
      name,
    ) {
      storeAccesses.push({ name, declared: [...this.objectStoreNames] })
      return objectStore.call(this, name)
    })
    for (let index = 0; index < 3; index += 1) {
      const ingested = await ingestAttachmentBytes({
        blob: new Blob([`orphan-${index}`], { type: 'text/plain' }),
        filename: `orphan-${index}.txt`,
        now: index + 1,
      })
      expect(ingested.attachment.id).toBeTruthy()
    }
    await getDb().attachments.toCollection().modify({ unreferencedAt: 1 })
    expect(await getDb().attachments.count()).toBe(3)

    const batchSizes: number[] = []
    for (;;) {
      const result = await runWorkspaceAction('maintenance', async (permit) => {
        const commit = await getBrowserRepository().execute(permit, {
          kind: 'attachment.reap',
          now: 100,
          maxAgeMs: 0,
          limit: 1,
        })
        return commit.value
      })
      batchSizes.push(result.deletedAttachmentIds.length)
      if (result.done) break
    }

    expect(batchSizes).toEqual([1, 1, 1])
    expect(await getDb().attachments.count()).toBe(0)
    expect(await getDb().attachmentBlobs.count()).toBe(0)
    expect(await getDb().attachmentArtifacts.count()).toBe(0)
    expect(await getDb().attachmentJobs.count()).toBe(0)
    const attachmentPlan = resolveMutationTableNames([
      { kind: 'attachment', attachmentId: 'attachment' },
    ])
    expect(attachmentPlan).not.toContain('messages')
    const expectedDeclared = new Set(
      browserWorkspaceCatchupTransactionTableNames([
        ...attachmentPlan,
        'attachmentIntegrityState',
        'browserLocks',
        'storageRetentionState',
      ]),
    )
    const attachmentMutationAccesses = storeAccesses.filter(
      ({ declared }) =>
        declared.length === expectedDeclared.size &&
        declared.every((name) => expectedDeclared.has(name)),
    )
    expect(attachmentMutationAccesses.length).toBeGreaterThan(0)
    const messageAccesses = attachmentMutationAccesses.filter(({ name }) => name === 'messages')
    expect(messageAccesses).toEqual([])
    expect(attachmentMutationAccesses.flatMap(({ declared }) => declared)).not.toContain('messages')
    expect(attachmentMutationAccesses.flatMap(({ declared }) => declared)).not.toContain(
      'replacementCatchup__messages',
    )
  })

  it('retains a candidate whose reclamation timestamp advances after preflight', async () => {
    const ingested = await ingestAttachmentBytes({
      blob: new Blob(['refreshed candidate'], { type: 'text/plain' }),
      filename: 'refreshed-candidate.txt',
      now: 1,
    })
    await getDb().attachments.update(ingested.attachment.id, { unreferencedAt: 1 })
    const backend = new PausableResourceLockBackend()
    __setLockBackendForTests(backend)

    const reaping = runWorkspaceAction('maintenance', (permit) =>
      getBrowserRepository().execute(permit, {
        kind: 'attachment.reap',
        now: 100,
        maxAgeMs: 0,
        limit: 1,
      }),
    )
    await backend.waitForLock()
    await getDb().attachments.update(ingested.attachment.id, { unreferencedAt: 200 })
    backend.release()

    await expect(reaping).resolves.toMatchObject({
      value: {
        scanned: 1,
        deletedAttachmentIds: [],
        earliestDeferredAt: 200,
        done: true,
      },
    })
    expect(await getDb().attachments.get(ingested.attachment.id)).toMatchObject({
      unreferencedAt: 200,
    })
  })

  it('rolls back a reclaimed bundle when the active retention cycle changes before its lock', async () => {
    const ingested = await ingestAttachmentBytes({
      blob: new Blob(['revision conflict'], { type: 'text/plain' }),
      filename: 'revision-conflict.txt',
      now: 1,
    })
    const attachmentId = ingested.attachment.id
    await getDb().attachments.update(attachmentId, { unreferencedAt: 1 })
    const before = {
      header: await getDb().attachments.get(attachmentId),
      catalog: await getDb().attachmentCatalogRows.get(attachmentId),
      aggregate: await getDb().attachmentCatalogAggregate.get('workspace'),
      blobs: await getDb().attachmentBlobs.where('attachmentId').equals(attachmentId).toArray(),
    }
    const backend = new PausableResourceLockBackend()
    __setLockBackendForTests(backend)

    const reaping = runWorkspaceAction('maintenance', (permit) =>
      getBrowserRepository().execute(permit, {
        kind: 'attachment.reap',
        now: 100,
        maxAgeMs: 0,
        limit: 1,
      }),
    )
    await backend.waitForLock()
    await getDb().storageRetentionState.put({
      task: 'attachment-reap',
      formatVersion: 1,
      phase: 'active',
      revision: 1,
      cycleNow: 100,
      cutoff: 100,
    })
    backend.release()

    await expect(reaping).rejects.toThrow('StorageRetentionStateChanged:attachment-reap')
    expect(await getDb().attachments.get(attachmentId)).toEqual(before.header)
    expect(await getDb().attachmentCatalogRows.get(attachmentId)).toEqual(before.catalog)
    expect(await getDb().attachmentCatalogAggregate.get('workspace')).toEqual(before.aggregate)
    expect(
      await getDb().attachmentBlobs.where('attachmentId').equals(attachmentId).toArray(),
    ).toEqual(before.blobs)
  })

  it('advances past raced candidates and equal timestamps without head-of-line blocking', async () => {
    const attachmentIds: string[] = []
    for (let index = 0; index < 70; index += 1) {
      const ingested = await ingestAttachmentBytes({
        blob: new Blob([`orphan-${index}`], { type: 'text/plain' }),
        filename: `orphan-${index}.txt`,
        now: 1,
      })
      attachmentIds.push(ingested.attachment.id)
    }
    await getDb().attachments.toCollection().modify({ unreferencedAt: 1 })
    const racedAttachmentId = attachmentIds[0] as string
    await getDb().attachmentRefEdges.put({
      ownerKind: 'message',
      ownerId: 'raced-owner',
      chatId: 'raced-chat',
      refId: 'raced-ref',
      attachmentId: racedAttachmentId,
      ordinal: 0,
      includeInContext: true,
      refUpdatedAt: 2,
    })

    let scanned = 0
    const deleted = new Set<string>()
    const cursors: string[] = []
    for (;;) {
      const result = await runWorkspaceAction('maintenance', async (permit) => {
        const commit = await getBrowserRepository().execute(permit, {
          kind: 'attachment.reap',
          now: 100,
          maxAgeMs: 0,
          limit: 16,
        })
        return commit.value
      })
      scanned += result.scanned
      for (const attachmentId of result.deletedAttachmentIds) deleted.add(attachmentId)
      if (result.done) break
      const state = await getDb().storageRetentionState.get('attachment-reap')
      if (state?.task !== 'attachment-reap' || state.phase !== 'active' || !state.cursor) {
        throw new Error('AttachmentReapCursorMissing')
      }
      cursors.push(state.cursor.attachmentId)
    }

    expect(scanned).toBe(70)
    expect(deleted.size).toBe(69)
    expect(deleted.has(racedAttachmentId)).toBe(false)
    expect(new Set(cursors).size).toBe(cursors.length)
    expect(await getDb().attachments.toCollection().primaryKeys()).toEqual([racedAttachmentId])
  })

  it('derives optional stream table access from the transaction plan', () => {
    const admission = resolveMutationTableNames([], {
      streamAdmission: testStreamLeaseAdmission({
        streamId: 'stream',
        chatId: 'chat',
        messageId: 'message',
        ownerClientId: 'owner',
        fenceToken: 'fence',
        replacementEpoch: 0,
        startedAt: 1,
        heartbeatAt: 1,
        attemptKind: 'generation',
      }),
    })
    expect(admission).toEqual(['chats', 'messages', 'settings', 'streamLeases'])

    const canonical = resolveMutationTableNames([], {
      streamFence: {
        streamId: 'stream',
        fence: {
          ownerClientId: 'owner',
          fenceToken: 'fence',
          replacementEpoch: 0,
          admissionSequence: 1,
        },
      },
      streamCanonicalCommit: {
        streamId: 'stream',
        terminal: {
          version: 1,
          finishedAt: 2,
          journalMaxSeq: -1,
          journalCompleteness: 'settled',
          decision: { outcome: 'done' },
        },
        postCommitFinal: { completionAllowed: true },
      },
    })
    expect(canonical).toEqual(['messages', 'streamLeases'])

    expect(STREAM_JOURNAL_MUTATION_TRANSACTION_CAPABILITY.tableNames).toEqual([
      'streamLeases',
      'streamChunks',
    ])

    expect(
      resolveMutationTableNames([], {
        generationReadSet: { chatId: 'chat', messages: [], attachments: [] },
      }),
    ).toEqual(['messages'])
    expect(
      resolveMutationTableNames([], {
        generationReadSet: {
          chatId: 'chat',
          messages: [],
          attachments: [{ attachmentId: 'attachment', wireVersion: 1 }],
        },
      }),
    ).toEqual(['attachments', 'messages'])
    expect(resolveMutationTableNames([], { captureGenerationPlanningSnapshot: true })).toEqual([
      'discoveryPayloads',
      'discoveryPayloadMetadata',
      'endpoints',
      'models',
      'keys',
      'profiles',
      'privacyPolicies',
      'settings',
    ])
  })
})
