import Dexie from 'dexie'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyChildListAggregate } from '../../src/core/child-list-state'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type { Chat } from '../../src/core/types'
import { __resetBroadcastForTests, subscribeWorkspaceChanges } from '../../src/store/broadcast'
import { __resetBrowserRepositoryForTests } from '../../src/store/browser-repo'
import {
  openBrowserWorkspace,
  shutdownBrowserWorkspace,
} from '../../src/store/browser-workspace-lifecycle'
import { buildChat } from '../../src/store/chats'
import { __resetDbForTests, getDb } from '../../src/store/db'
import { exportWorkspaceBackup, restoreWorkspaceBackup } from '../../src/store/import-export'
import { __setLockBackendForTests } from '../../src/store/locks'
import type { StreamLeaseRow } from '../../src/store/repository'
import {
  awaitStorageMaintenanceRuntimeIdle,
  closeStorageMaintenanceRuntime,
} from '../../src/store/storage-maintenance-runtime'
import type {
  CommitEnvelope,
  WorkspaceChange,
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
import { putTestChat } from '../helpers/chats'
import { encodeTestStreamJournalEntries } from '../helpers/stream-journal'
import { testGenerationLease } from '../helpers/stream-leases'

const DB_NAME = 'natter'

let emptyWorkspaceBackup: Awaited<ReturnType<typeof exportWorkspaceBackup>>

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
  vi.restoreAllMocks()
  __setLockBackendForTests(null)
  await restoreWorkspaceBackup(emptyWorkspaceBackup, { now: 1 })
  closeStorageMaintenanceRuntime()
  await awaitStorageMaintenanceRuntimeIdle()
})

afterAll(async () => {
  __setLockBackendForTests(null)
  await shutdownBrowserWorkspace()
})

function execute<C extends WorkspaceCommand>(
  command: C,
): Promise<CommitEnvelope<WorkspaceCommandResult<C>>> {
  return runWorkspaceAction('chat-metadata', (permit) =>
    getWorkspaceRepository().execute(permit, command),
  )
}

function query<Q extends WorkspaceQuery>(request: Q): Promise<WorkspaceQueryResult<Q>> {
  return runWorkspaceRead('repository-query', (permit) =>
    getWorkspaceRepository()
      .query(permit, request, { signal: permit.signal })
      .then((envelope) => envelope.value),
  )
}

async function seedChat(overrides: Partial<Chat> = {}): Promise<Chat> {
  const chat = {
    ...buildChat({
      ...(overrides.id === undefined ? {} : { id: overrides.id }),
      settings: cloneDefaultChatSettings(),
      ...(overrides.temporary === undefined ? {} : { temporary: overrides.temporary }),
      now: overrides.createdAt ?? 100,
    }),
    ...overrides,
  }
  return putTestChat(chat)
}

function orphanChunks(chatId: string) {
  const streamId = `${chatId}:orphan-stream`
  return encodeTestStreamJournalEntries({
    streamId,
    chatId,
    messageId: `${chatId}:missing-message`,
    fence: {
      ownerClientId: 'closed-tab',
      fenceToken: 'orphan-fence',
      replacementEpoch: 0,
      admissionSequence: 1,
    },
    entries: [{ createdAt: 100, event: { lane: 'text', text: 'recoverable' } }],
  })
}

describe('authoritative temporary chat lifecycle', () => {
  it('materializes one temporary chat with its maintenance dependency in the same commit', async () => {
    const commit = await execute({
      kind: 'chat.materialize-temporary',
      input: {
        chatId: 'temporary-materialized',
        settings: cloneDefaultChatSettings(),
        now: 100,
      },
    })

    expect(commit.value.destination.chat.id).toBe('temporary-materialized')
    expect(commit.receipt.constructions).toHaveLength(1)
    expect(commit.delta.invalidations).toContainEqual({
      kind: 'storage-maintenance',
      tasks: ['prune-empty-drafts'],
    })

    const linkedSettings = {
      ...cloneDefaultChatSettings(),
      profileId: 'profile-linked',
      systemPromptPresetId: 'system-linked',
      appendPromptPresetId: 'append-linked',
      continueSystemPromptPresetId: 'continue-system-linked',
      continueUserPromptPresetId: 'continue-user-linked',
      defaultPrefillPresetId: 'prefill-linked',
      textTemplate: 'template-linked',
    }
    const linkedCommit = await execute({
      kind: 'chat.materialize-temporary',
      input: {
        chatId: 'temporary-materialized-linked',
        settings: linkedSettings,
        presetId: 'preset-linked',
        now: 101,
      },
    })

    expect(linkedCommit.value.destination.chat.id).toBe('temporary-materialized-linked')
    expect(linkedCommit.receipt.constructions).toHaveLength(1)
  })

  it('keeps permanent and non-empty temporary chats during cleanup', async () => {
    const permanent = await seedChat({
      id: 'permanent-empty',
      title: 'Permanent',
      titleStatus: 'manual',
    })
    const withDraft = await seedChat({ id: 'temporary-with-draft', temporary: true })
    await execute({
      kind: 'draft.put',
      input: {
        draft: {
          chatId: withDraft.id,
          text: 'keep this draft',
          attachmentRefs: [],
          updatedAt: 200,
        },
        expectedUpdatedAt: null,
      },
    })

    const deleted = await execute({
      kind: 'chat.discard-empty-drafts',
      chatIds: [permanent.id, withDraft.id],
      now: 201,
    })

    expect(deleted.value).toEqual({ deletedChatIds: [], affectedAttachmentIds: [] })
    expect(await query({ kind: 'chat.get', chatId: permanent.id })).toBeDefined()
    expect(await query({ kind: 'chat.get', chatId: withDraft.id })).toMatchObject({
      temporary: true,
    })
    expect(await query({ kind: 'draft.get', chatId: withDraft.id })).toMatchObject({
      text: 'keep this draft',
    })
  })

  it('advances bounded maintenance pages without treating the page size as a chat limit', async () => {
    const temporary = await seedChat({ id: 'a-temporary-indexed', temporary: true })
    const permanent = await seedChat({
      id: 'b-permanent-zero-word',
      title: 'Permanent',
      titleStatus: 'manual',
    })
    const populated = await seedChat({
      id: 'c-populated-candidate',
      temporary: true,
      wordCount: 10,
    })
    const laterTemporary = await seedChat({ id: 'd-later-temporary', temporary: true })
    const finalTemporary = await seedChat({ id: 'e-final-temporary', temporary: true })
    const first = await execute({
      kind: 'maintenance.prune-empty-draft-chats',
      maxAgeMs: 50,
      limit: 2,
      now: 200,
    })
    expect(first.value).toEqual({
      deletedChatIds: [temporary.id, laterTemporary.id],
      affectedAttachmentIds: [],
      scannedChatIds: 2,
      done: false,
    })
    const second = await execute({
      kind: 'maintenance.prune-empty-draft-chats',
      maxAgeMs: 50,
      limit: 2,
      now: 200,
    })
    expect(second.value).toEqual({
      deletedChatIds: [finalTemporary.id],
      affectedAttachmentIds: [],
      scannedChatIds: 1,
      done: true,
    })
    expect(await query({ kind: 'chat.get', chatId: permanent.id })).toBeDefined()
    expect(await query({ kind: 'chat.get', chatId: populated.id })).toBeDefined()
  })

  it('does not reclaim a recently viewed empty chat that can still be open in another tab', async () => {
    const chat = await seedChat({
      id: 'recent-empty-in-another-tab',
      temporary: true,
      lastViewedAt: 190,
    })

    const commit = await execute({
      kind: 'maintenance.prune-empty-draft-chats',
      maxAgeMs: 20,
      limit: 32,
      now: 200,
    })

    expect(commit.value).toEqual({
      deletedChatIds: [],
      affectedAttachmentIds: [],
      scannedChatIds: 0,
      earliestDeferredAt: 190,
      done: true,
    })
    expect(await query({ kind: 'chat.get', chatId: chat.id })).toBeDefined()
  })

  it('keeps a recovery-visible temporary chat while a stream lease exists', async () => {
    const chat = await seedChat({ id: 'temporary-with-lease', temporary: true })
    const lease: StreamLeaseRow = testGenerationLease({
      streamId: 'message-less-recovery-stream',
      chatId: chat.id,
      messageId: 'pending-assistant',
      ownerClientId: 'other-tab',
      fenceToken: 'other-tab-fence',
      replacementEpoch: 0,
      startedAt: 100,
      heartbeatAt: 100,
      admissionSequence: 1,
      revision: 1,
      phase: 'reserved',
    })
    await getDb().streamLeases.put(lease)
    try {
      const commit = await execute({
        kind: 'chat.discard-empty-drafts',
        chatIds: [chat.id],
        now: 200,
      })

      expect(commit.value).toEqual({ deletedChatIds: [], affectedAttachmentIds: [] })
      expect(await query({ kind: 'chat.get', chatId: chat.id })).toBeDefined()
      expect(await query({ kind: 'stream.lease', streamId: lease.streamId })).toEqual(lease)
    } finally {
      await getDb().streamLeases.delete(lease.streamId)
    }
  })

  it('serializes duplicate cleanup and publishes the deletion exactly once', async () => {
    const chat = await seedChat({ id: 'temporary-duplicate', temporary: true })
    const changes: WorkspaceChange[] = []
    const unsubscribe = subscribeWorkspaceChanges((change) => changes.push(change))

    const commits = await Promise.all([
      execute({ kind: 'chat.discard-empty-drafts', chatIds: [chat.id], now: 200 }),
      execute({ kind: 'chat.discard-empty-drafts', chatIds: [chat.id], now: 200 }),
    ])
    unsubscribe()

    expect(commits.flatMap((commit) => commit.value.deletedChatIds)).toEqual([chat.id])
    expect(commits.filter((commit) => commit.effectScope === 'workspace')).toHaveLength(1)
    expect(changes).toHaveLength(1)
    const change = changes[0]
    expect(change?.kind).toBe('commit')
    if (change?.kind !== 'commit') throw new Error('ExpectedCommitChange')
    expect(
      change.delta.facts.some((fact) => fact.kind === 'chat-deleted' && fact.chatId === chat.id),
    ).toBe(true)
    expect(
      change.delta.facts.some(
        (fact) => fact.kind === 'sidebar-row-deleted' && fact.chatId === chat.id,
      ),
    ).toBe(true)
  })

  it('reclaims orphan stream chunks when an empty temporary chat is discarded', async () => {
    const chat = await seedChat({ id: 'temporary-orphan-chunks', temporary: true })
    await getDb().streamChunks.bulkPut(await orphanChunks(chat.id))

    const commit = await execute({
      kind: 'chat.discard-empty-drafts',
      chatIds: [chat.id],
      now: 200,
    })

    expect(commit.value).toEqual({ deletedChatIds: [chat.id], affectedAttachmentIds: [] })
    expect(await query({ kind: 'chat.get', chatId: chat.id })).toBeUndefined()
    expect(await getDb().streamChunks.where('chatId').equals(chat.id).count()).toBe(0)
  })

  it('rolls back every owned row and emits nothing when deletion fails', async () => {
    const chat = await seedChat({ id: 'temporary-rollback', temporary: true, createdAt: 100 })
    const db = getDb()
    await db.drafts.put({ chatId: chat.id, text: '', attachmentRefs: [], updatedAt: 100 })
    await db.childLists.put({
      id: `${chat.id}:__root__`,
      chatId: chat.id,
      parentId: null,
      version: 0,
      updatedAt: 100,
      ...emptyChildListAggregate(),
    })
    await db.streamChunks.bulkPut(await orphanChunks(chat.id))
    const before = {
      chat: await db.chats.get(chat.id),
      sidebar: await db.chatSidebarRows.get(chat.id),
      draft: await db.drafts.get(chat.id),
      childLists: await db.childLists.where('chatId').equals(chat.id).toArray(),
      chunks: await db.streamChunks.where('chatId').equals(chat.id).toArray(),
    }
    const changes: WorkspaceChange[] = []
    const unsubscribe = subscribeWorkspaceChanges((change) => changes.push(change))
    const failDelete = () => {
      throw new Error('injected chat deletion failure')
    }
    db.chats.hook.deleting.subscribe(failDelete)

    await expect(
      execute({ kind: 'chat.discard-empty-drafts', chatIds: [chat.id], now: 200 }),
    ).rejects.toThrow('injected chat deletion failure')

    db.chats.hook.deleting.unsubscribe(failDelete)
    unsubscribe()
    expect({
      chat: await db.chats.get(chat.id),
      sidebar: await db.chatSidebarRows.get(chat.id),
      draft: await db.drafts.get(chat.id),
      childLists: await db.childLists.where('chatId').equals(chat.id).toArray(),
      chunks: await db.streamChunks.where('chatId').equals(chat.id).toArray(),
    }).toEqual(before)
    expect(changes).toEqual([])
  })
})
