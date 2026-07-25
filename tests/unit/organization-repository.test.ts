import Dexie from 'dexie'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { connectionDispatchProfileProof } from '../../src/core/connection-dispatch-proof'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import { createStreamAccumulator } from '../../src/core/stream-accumulator'
import type {
  Attachment,
  AttachmentReferenceEdge,
  Chat,
  Message,
  MessageAttachmentRef,
} from '../../src/core/types'
import { newId } from '../../src/lib/ulid'
import { refreshAttachmentCatalogProjectionsForRepair } from '../../src/store/attachment-catalog-projection'
import {
  createAttemptTerminalLeaseApplications,
  createWriterAttemptTerminalOwner,
  projectAttemptTerminal,
} from '../../src/store/attempt-terminalization'
import { __resetBroadcastForTests, subscribeWorkspaceChanges } from '../../src/store/broadcast'
import { __resetBrowserRepositoryForTests } from '../../src/store/browser-repo'
import {
  openBrowserWorkspace,
  shutdownBrowserWorkspace,
} from '../../src/store/browser-workspace-lifecycle'
import {
  CHAT_SIDEBAR_AGGREGATE_ID,
  emptyChatSidebarAggregateRow,
} from '../../src/store/chat-sidebar-projection'
import { CHAT_CLOSURE_TRANSACTION_CAPABILITY } from '../../src/store/chat-storage-ownership'
import { buildChat, deleteArchivedChatsPermanently } from '../../src/store/chats'
import {
  buildConnectionProfile,
  configurationOwnerKey,
  configurationRequestRevisionFor,
  configurationTargetKey,
} from '../../src/store/configuration-domain-contract'
import {
  CONFIGURATION_PROFILE_MANAGER_STATE_ID,
  type ConfigurationProfileManagerStateRow,
} from '../../src/store/configuration-profile-usage-projection'
import { __resetDbForTests, getDb } from '../../src/store/db'
import { exportWorkspaceBackup, restoreWorkspaceBackup } from '../../src/store/import-export'
import {
  type StreamLeaseRow,
  streamLeaseReasoningCarryForward,
  streamLeaseReasoningVisibility,
} from '../../src/store/repository'
import {
  adoptPreparedStreamLease,
  getStreamClientId,
  releaseStreamOwnershipReservation,
  reserveStreamOwnership,
  type StreamLeaseHandle,
} from '../../src/store/stream-leases'
import type {
  AttemptPrepareResult,
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
import {
  reserveWorkspaceChild,
  runWorkspaceAction,
  runWorkspaceRead,
  type WorkspaceRootKind,
} from '../../src/store/workspace-runtime'
import { expectAttachmentReferenceInvariants } from '../helpers/attachment-reference-invariants'
import { putTestChat } from '../helpers/chats'
import { putTestMessages, readTestMessageHeader } from '../helpers/message-storage'
import { encodeTestStreamJournalEntries } from '../helpers/stream-journal'
import { testStreamLeaseAdmission } from '../helpers/stream-leases'

const DB_NAME = 'natter'
const PROFILE_ID = 'organization-test-profile'
const MODEL_ID = 'organization/test-model'

let emptyWorkspaceBackup: Awaited<ReturnType<typeof exportWorkspaceBackup>>

async function resetAll(): Promise<void> {
  __resetWorkspaceRepositoryForTests()
  __resetBrowserRepositoryForTests()
  __resetDbForTests()
  __resetBroadcastForTests()
  await Dexie.delete(DB_NAME)
}

beforeAll(async () => {
  await resetAll()
  await openBrowserWorkspace()
  emptyWorkspaceBackup = await exportWorkspaceBackup()
})

beforeEach(async () => {
  await restoreWorkspaceBackup(emptyWorkspaceBackup, { now: 1 })
})

afterAll(async () => {
  await shutdownBrowserWorkspace()
  await resetAll()
})

function execute<C extends WorkspaceCommand>(
  command: C,
  root: WorkspaceRootKind = 'workspace-organization',
): Promise<CommitEnvelope<WorkspaceCommandResult<C>>> {
  return runWorkspaceAction(root, (permit) => getWorkspaceRepository().execute(permit, command))
}

function query<Q extends WorkspaceQuery>(query: Q): Promise<WorkspaceQueryResult<Q>> {
  return runWorkspaceRead('repository-query', (permit) =>
    getWorkspaceRepository()
      .query(permit, query, { signal: permit.signal })
      .then((envelope) => envelope.value),
  )
}

async function seedChat(overrides: Partial<Chat> = {}): Promise<Chat> {
  const settings = {
    ...cloneDefaultChatSettings(),
    profileId: PROFILE_ID,
    model: MODEL_ID,
  }
  const chat = {
    ...buildChat({
      id: overrides.id ?? newId(),
      title: overrides.title ?? 'Test',
      settings,
      now: overrides.createdAt ?? 100,
    }),
    ...overrides,
  }
  return putTestChat(chat)
}

async function seedMessage(chatId: string, overrides: Partial<Message> = {}): Promise<Message> {
  const message: Message = {
    id: overrides.id ?? newId(),
    chatId,
    parentId: null,
    siblingIndex: 0,
    turnId: overrides.turnId ?? newId(),
    turnIndex: 0,
    createdAt: 100,
    role: 'user',
    origin: 'user',
    content: [{ type: 'text', text: 'hello' }],
    nodeVersion: 0,
    deleted: false,
    ...overrides,
  }
  await putTestMessages([message])
  return message
}

async function seedAttachment(overrides: Partial<Attachment> = {}): Promise<Attachment> {
  const attachment: Attachment = {
    id: overrides.id ?? newId(),
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
  const commit = await execute(
    {
      kind: 'attachment.bundle.write',
      input: {
        bundle: { attachment, blobs: [], artifacts: [], jobs: [] },
        mode: 'put',
      },
    },
    'attachment',
  )
  expect(commit.value).toEqual({ attachmentId: attachment.id, outcome: 'written' })
  const stored = await query({ kind: 'attachment.get', attachmentId: attachment.id })
  if (!stored) throw new Error(`SeedAttachmentMissing:${attachment.id}`)
  return stored
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

async function seedGenerationProfile(): Promise<void> {
  const profile = buildConnectionProfile({
    id: PROFILE_ID,
    name: 'Organization test',
    kind: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    now: 1,
  })
  await execute(
    {
      kind: 'configuration.execute',
      input: { kind: 'connection.create', profile, now: 1 },
    },
    'configuration',
  )
}

function generationMessage(input: {
  id: string
  chatId: string
  parentId: string | null
  turnId: string
  turnIndex: number
  createdAt: number
  role: 'user' | 'assistant'
}): Message {
  return {
    id: input.id,
    chatId: input.chatId,
    parentId: input.parentId,
    siblingIndex: 0,
    turnId: input.turnId,
    turnIndex: input.turnIndex,
    createdAt: input.createdAt,
    role: input.role,
    origin: input.role === 'assistant' ? 'generated' : 'user',
    content: input.role === 'assistant' ? [] : [{ type: 'text', text: 'pending send' }],
    ...(input.role === 'assistant'
      ? {
          generation: {
            model: MODEL_ID,
            requestedModel: MODEL_ID,
            status: 'preparing' as const,
            integrity: 'clean' as const,
            costSource: 'stream' as const,
            reasoningCarryForward: 'none' as const,
            reasoningVisibility: { disclosure: 'unknown' as const },
            startedAt: input.createdAt,
          },
        }
      : {}),
    nodeVersion: 0,
    deleted: false,
  }
}

async function prepareGeneration(
  chatId: string,
  streamId: string,
): Promise<{ lease: StreamLeaseRow; handle: StreamLeaseHandle; prepared: AttemptPrepareResult }> {
  const startedAt = Date.now()
  const userId = `${streamId}:user`
  const assistantId = `${streamId}:assistant`
  const turnId = `${streamId}:turn`
  const user = generationMessage({
    id: userId,
    chatId,
    parentId: null,
    turnId,
    turnIndex: 0,
    createdAt: startedAt,
    role: 'user',
  })
  const assistant = generationMessage({
    id: assistantId,
    chatId,
    parentId: userId,
    turnId,
    turnIndex: 1,
    createdAt: startedAt,
    role: 'assistant',
  })
  return runWorkspaceAction('conversation-generation', async (permit) => {
    const admission = testStreamLeaseAdmission({
      streamId,
      chatId,
      messageId: assistantId,
      ownerClientId: getStreamClientId(),
      fenceToken: `fence:${streamId}`,
      replacementEpoch: permit.replacementEpoch,
      startedAt,
      heartbeatAt: startedAt,
      attemptKind: 'generation',
    })
    const chat = await getDb().chats.get(chatId)
    const profile = await getDb().profiles.get(PROFILE_ID)
    if (!profile) throw new Error(`PreparedProfileMissing:${PROFILE_ID}`)
    const child = reserveWorkspaceChild(permit, 'stream-lease')
    const reservation = await reserveStreamOwnership(child, admission, () => {})
    let prepared: CommitEnvelope<
      WorkspaceCommandResult<Extract<WorkspaceCommand, { kind: 'attempt.prepare' }>>
    >
    try {
      prepared = await getWorkspaceRepository().execute(permit, {
        kind: 'attempt.prepare',
        input: {
          strategy: 'send',
          lease: admission,
          promptPath: {
            requirement: {
              kind: 'send',
              surface: 'chat',
              chatId,
              target: { kind: 'root' },
              childSlot: 'empty',
            },
            claim: { chatId, leafId: null, headers: [] },
          },
          configurationClaim: {
            configurationVersion: chat?.configurationVersion ?? 0,
            settings: chat?.settings ?? {
              ...cloneDefaultChatSettings(),
              profileId: PROFILE_ID,
              model: MODEL_ID,
            },
            presetId: chat?.presetId ?? null,
            profile: connectionDispatchProfileProof(profile, MODEL_ID),
            requestRevision: configurationRequestRevisionFor(profile, undefined),
            dispatchKeyRevisions: [],
            preferredDispatchKeyId: null,
            workspaceSettingOverrides: [],
          },
          user,
          assistant,
        },
      })
    } catch (error) {
      await releaseStreamOwnershipReservation(reservation)
      throw error
    }
    const handle = await adoptPreparedStreamLease(
      reservation,
      prepared.value.lease,
      createAttemptTerminalLeaseApplications({
        chatId,
        streamId,
        workspaceId: permit.workspaceId,
      }),
    )
    return { lease: prepared.value.lease, handle, prepared: prepared.value }
  })
}

async function finishPreparedGeneration(active: {
  lease: StreamLeaseRow
  handle: StreamLeaseHandle
  prepared: AttemptPrepareResult
}): Promise<void> {
  const finishedAt = active.lease.startedAt + 20
  const header = active.prepared.assistantHeader
  const generation = active.prepared.assistant.generation
  if (!generation) throw new Error(`PreparedGenerationMissing:${active.lease.messageId}`)
  const outcome = await runWorkspaceAction('conversation-generation', async (permit) => {
    const owner = createWriterAttemptTerminalOwner({
      repository: getWorkspaceRepository,
      permit,
      handle: active.handle,
      journal: () => ({ settle: async () => undefined }),
    })
    return owner.complete({
      prepareTerminal: () =>
        projectAttemptTerminal({
          kind: 'generation',
          streamId: active.lease.streamId,
          messageId: active.lease.messageId,
          fence: active.handle.fence,
          accumulator: createStreamAccumulator({ initialContent: [], now: active.lease.startedAt }),
          currentGeneration: generation,
          baseline: {
            kind: 'exact',
            bodyVersion: header.bodyVersion,
            body: { content: [] },
          },
          requestedModel: MODEL_ID,
          startedAt: active.lease.startedAt,
          finishedAt,
          reasoningCarryForward: streamLeaseReasoningCarryForward(active.lease),
          reasoningVisibility: streamLeaseReasoningVisibility(active.lease),
          decision: { outcome: 'abort', abortReason: 'user' },
        }),
    })
  })
  expect(outcome.kind).toBe('retired')
}

describe('organization repository contract', () => {
  it('creates, updates, lists, and deletes folders with one delivered commit per write', async () => {
    const changes: WorkspaceChange[] = []
    const unsubscribe = subscribeWorkspaceChanges((change) => changes.push(change))

    const created = await execute({
      kind: 'folder.create',
      input: { id: 'folder-a', name: ' Work ', sortIndex: 2, now: 10 },
    })
    expect(created.effectScope).toBe('workspace')
    expect(created.value).toMatchObject({ id: 'folder-a', name: 'Work', sortIndex: 2 })
    expect(created.delta).toEqual({
      facts: [],
      invalidations: [{ kind: 'folder', folderIds: ['folder-a'] }],
    })
    expect(changes).toHaveLength(1)

    const updated = await execute({
      kind: 'folder.update',
      folderId: created.value.id,
      patch: { name: 'Pinned', color: '#abcdef', now: 11 },
    })
    expect(updated.value).toMatchObject({
      id: created.value.id,
      name: 'Pinned',
      color: '#abcdef',
    })
    expect(updated.delta.invalidations).toEqual([{ kind: 'folder', folderIds: [created.value.id] }])
    expect(changes).toHaveLength(2)
    expect(await query({ kind: 'folder.list' })).toEqual([
      expect.objectContaining({ id: created.value.id, name: 'Pinned', color: '#abcdef' }),
    ])

    const missing = await execute({ kind: 'folder.delete', folderId: 'missing' })
    expect(missing).toMatchObject({
      effectScope: 'none',
      value: { deleted: false, affectedChatIds: [] },
      delta: { facts: [], invalidations: [] },
    })
    expect(changes).toHaveLength(2)

    const deleted = await execute({ kind: 'folder.delete', folderId: created.value.id })
    unsubscribe()
    expect(deleted.value).toEqual({ deleted: true, affectedChatIds: [], changes: [] })
    expect(changes).toHaveLength(3)
    expect(
      changes.map((change) => (change.kind === 'commit' ? change.stamp.commitId : null)),
    ).toEqual([created.commitId, updated.commitId, deleted.commitId])
  })

  it('deletes a folder and clears assigned chats in one scoped commit', async () => {
    const folder = (
      await execute({ kind: 'folder.create', input: { id: 'folder-b', name: 'Archive', now: 1 } })
    ).value
    const chat = await seedChat({ folderId: folder.id })

    const commit = await execute({ kind: 'folder.delete', folderId: folder.id })

    expect(commit.value).toEqual({
      deleted: true,
      affectedChatIds: [chat.id],
      changes: [
        {
          chatId: chat.id,
          previousFolderId: folder.id,
          previousArchived: false,
          nextFolderId: null,
          nextArchived: false,
        },
      ],
    })
    const stored = await query({ kind: 'chat.get', chatId: chat.id })
    expect(stored?.folderId).toBeNull()
    expect(stored?.metaVersion).toBe(1)
    expect(commit.receipt.chats).toEqual([expect.objectContaining({ id: chat.id, folderId: null })])
    expect(commit.delta).toEqual({
      facts: [{ kind: 'sidebar-row-changed', chatId: chat.id }],
      invalidations: [
        { kind: 'folder', folderIds: [folder.id] },
        { kind: 'chat', chatIds: [chat.id] },
        { kind: 'sidebar', chatIds: [chat.id] },
      ],
    })
  })

  it('deletes a folder and archives assigned chats without changing their identity', async () => {
    const folder = (
      await execute({
        kind: 'folder.create',
        input: { id: 'folder-archive', name: 'Done', now: 1 },
      })
    ).value
    const chat = await seedChat({ id: 'folder-archive-chat', folderId: folder.id })

    const commit = await execute({
      kind: 'folder.delete',
      folderId: folder.id,
      chatDisposition: 'archive',
      now: 10,
    })

    expect(commit.value).toEqual({
      deleted: true,
      affectedChatIds: [chat.id],
      changes: [
        {
          chatId: chat.id,
          previousFolderId: folder.id,
          previousArchived: false,
          nextFolderId: null,
          nextArchived: true,
        },
      ],
    })
    const stored = await query({ kind: 'chat.get', chatId: chat.id })
    expect(stored).toMatchObject({
      id: chat.id,
      folderId: null,
      archived: true,
      metaVersion: chat.metaVersion + 1,
      summaryVersion: chat.summaryVersion + 1,
    })
    expect(commit.receipt.chats).toEqual([
      expect.objectContaining({ id: chat.id, folderId: null, archived: true }),
    ])
    expect(commit.delta).toEqual({
      facts: [{ kind: 'sidebar-row-changed', chatId: chat.id }],
      invalidations: [
        { kind: 'folder', folderIds: [folder.id] },
        { kind: 'profile', facets: ['dependent-counts'] },
        { kind: 'chat', chatIds: [chat.id] },
        { kind: 'sidebar', chatIds: [chat.id] },
      ],
    })
  })

  it('assigns chat tags by name, creates missing tags, and prunes unused tags atomically', async () => {
    const keep = {
      id: 'tag-keep',
      name: 'Keep',
      nameLower: 'keep',
      createdAt: 1,
      updatedAt: 1,
    }
    const unused = {
      id: 'tag-unused',
      name: 'Unused',
      nameLower: 'unused',
      createdAt: 2,
      updatedAt: 2,
    }
    await getDb().tags.bulkPut([keep, unused])
    const chat = await seedChat({ tags: [keep.id, unused.id] })
    const other = await seedChat({ tags: [keep.id] })

    const commit = await execute(
      {
        kind: 'chat.set-tags-from-names',
        chatIds: [chat.id],
        names: ['Keep', 'New', 'new', '  '],
        now: 10,
      },
      'chat-metadata',
    )

    const newTag = (await query({ kind: 'tag.list' })).find((row) => row.nameLower === 'new')
    if (!newTag) throw new Error('NewTagMissing')
    const stored = await query({ kind: 'chat.get', chatId: chat.id })
    expect(commit.value.value).toEqual([keep.id, newTag.id])
    expect(stored?.tags).toEqual([keep.id, newTag.id])
    expect(stored?.updatedAt).toBe(chat.updatedAt)
    expect(stored?.summaryVersion).toBe(chat.summaryVersion)
    expect(stored?.metaVersion).toBe(chat.metaVersion + 1)
    expect((await query({ kind: 'chat.get', chatId: other.id }))?.tags).toEqual([keep.id])
    expect(await getDb().tags.get(unused.id)).toBeUndefined()
    expect(commit.receipt.chats).toEqual([expect.objectContaining({ id: chat.id })])
    expect(commit.delta.invalidations).toEqual([
      { kind: 'tag', tagIds: [newTag.id, keep.id] },
      { kind: 'tag', tagIds: [unused.id] },
      { kind: 'chat', chatIds: [chat.id] },
      { kind: 'sidebar', chatIds: [chat.id] },
    ])
    expect(commit.delta.facts).toEqual([{ kind: 'sidebar-row-changed', chatId: chat.id }])
  })

  it('permanently deletes archived chats and decrements attachment refs atomically', async () => {
    const attachment = await seedAttachment({ id: 'att-1' })
    const archived = await seedChat({ id: 'archived', archived: true })
    const live = await seedChat({ id: 'live', archived: false })
    const archivedMessage = await seedMessage(archived.id, {
      id: 'archived-message',
      attachmentRefs: [attachmentRef(attachment.id)],
    })
    await execute(
      {
        kind: 'draft.put',
        input: {
          draft: {
            chatId: archived.id,
            text: '',
            attachmentRefs: [attachmentRef(attachment.id)],
            updatedAt: 100,
          },
          expectedUpdatedAt: null,
        },
      },
      'attachment',
    )
    await seedMessage(live.id, { id: 'live-message' })
    expect((await query({ kind: 'attachment.get', attachmentId: attachment.id }))?.refCount).toBe(2)

    const commit = await execute(
      { kind: 'chat.delete-archived', chatIds: [archived.id], now: 200 },
      'chat-metadata',
    )

    expect(commit.value).toEqual({
      deletedChatIds: [archived.id],
      affectedAttachmentIds: [attachment.id],
    })
    expect(await query({ kind: 'chat.get', chatId: archived.id })).toBeUndefined()
    expect(await getDb().messages.get(archivedMessage.id)).toBeUndefined()
    expect(await query({ kind: 'draft.get', chatId: archived.id })).toBeUndefined()
    expect(await query({ kind: 'chat.get', chatId: live.id })).toBeDefined()
    expect((await query({ kind: 'attachment.get', attachmentId: attachment.id }))?.refCount).toBe(0)
    expect(commit.delta.facts).toEqual([
      { kind: 'chat-deleted', chatId: archived.id },
      { kind: 'sidebar-row-deleted', chatId: archived.id },
      { kind: 'attachment-row-changed', attachmentId: attachment.id },
    ])
    expect(commit.delta.invalidations).toEqual(
      expect.arrayContaining([
        { kind: 'chat', chatIds: [archived.id] },
        { kind: 'attachment', attachmentIds: [attachment.id] },
      ]),
    )
    await expectAttachmentReferenceInvariants(getDb())
  })

  it('empty archive deletes only archived chats and emits exact deletion facts', async () => {
    const archived = await seedChat({ id: 'archived-empty', archived: true })
    const live = await seedChat({ id: 'live-empty', archived: false })

    const commit = await execute(
      { kind: 'chat.empty-archive', limit: 32, now: 200 },
      'chat-metadata',
    )

    expect(commit.value.deletedChatIds).toEqual([archived.id])
    expect(commit.value).toMatchObject({ scannedChatIds: 1, done: true })
    expect(await query({ kind: 'chat.get', chatId: archived.id })).toBeUndefined()
    expect(await query({ kind: 'chat.get', chatId: live.id })).toBeDefined()
    expect(commit.delta.facts).toEqual([
      { kind: 'chat-deleted', chatId: archived.id },
      { kind: 'sidebar-row-deleted', chatId: archived.id },
    ])
  })

  it('deletes canonical archived chats even when their sidebar projection is missing', async () => {
    const archived = await seedChat({ id: 'archived-missing-sidebar', archived: true })
    await getDb().chatSidebarRows.delete(archived.id)

    const commit = await execute(
      { kind: 'chat.delete-archived', chatIds: [archived.id], now: 200 },
      'chat-metadata',
    )

    expect(commit.value.deletedChatIds).toEqual([archived.id])
    expect(await query({ kind: 'chat.get', chatId: archived.id })).toBeUndefined()
    expect(await getDb().chatSidebarRows.count()).toBe(0)
    expect(await getDb().chatSidebarAggregates.get('workspace')).toMatchObject({
      totalCount: 0,
      activeCount: 0,
    })
  })

  it('uses one closure manifest for every chat-owned row and reconciles orphan edges', async () => {
    const attachment = await seedAttachment({ id: 'closure-attachment' })
    const archived = await seedChat({
      id: 'archived-closure',
      archived: true,
      tokenCalibration: {
        [MODEL_ID]: {
          totalTextChars: 20,
          totalTextTokens: 5,
          sampleCount: 1,
          updatedAt: 100,
        },
      },
    })
    const message = await seedMessage(archived.id, { id: 'closure-message' })
    const db = getDb()
    await db.drafts.put({ chatId: archived.id, text: '', attachmentRefs: [], updatedAt: 100 })
    await db.messageBodies.put({
      id: 'closure-orphan-message-body',
      chatId: archived.id,
      bodyVersion: 0,
      updatedAt: 100,
      content: [{ type: 'text', text: 'orphan body' }],
    })
    await db.childSlotMembers.put({
      id: 'closure-orphan-child-slot',
      chatId: archived.id,
      parentId: null,
      parentKey: `${archived.id}:__root__`,
      position: 99,
      previousMessageId: null,
      nextMessageId: null,
    })
    await db.streamChunks.bulkPut(
      await encodeTestStreamJournalEntries({
        streamId: 'closure-orphan-stream',
        chatId: archived.id,
        messageId: message.id,
        fence: {
          ownerClientId: 'closed-tab',
          fenceToken: 'closed-tab-fence',
          replacementEpoch: 0,
          admissionSequence: 1,
        },
        entries: [{ createdAt: 100, event: { lane: 'text', text: 'orphan' } }],
      }),
    )
    await db.configurationLinks.put({
      id: 'closure-orphan-configuration-link',
      ownerKind: 'chat',
      ownerId: archived.id,
      ownerKey: configurationOwnerKey('chat', archived.id),
      targetKind: 'profile',
      targetId: 'missing-profile',
      targetKey: configurationTargetKey('profile', 'missing-profile'),
      slot: 'orphan',
    })
    const orphanEdge: AttachmentReferenceEdge = {
      ownerKind: 'message',
      ownerId: 'missing-message-owner',
      chatId: archived.id,
      refId: 'orphan-ref',
      attachmentId: attachment.id,
      ordinal: 0,
      includeInContext: true,
      refUpdatedAt: 100,
    }
    await db.transaction(
      'rw',
      [
        db.attachmentCatalogAggregate,
        db.attachmentCatalogRows,
        db.attachmentRefEdges,
        db.attachments,
      ],
      async (tx) => {
        await tx.table('attachmentRefEdges').put(orphanEdge)
        await tx.table('attachments').update(attachment.id, { refCount: 1 })
        await refreshAttachmentCatalogProjectionsForRepair(tx, [attachment.id])
      },
    )
    const calibrationBefore = await db.settings.get('global:token-calibration')

    const commit = await execute(
      { kind: 'chat.delete-archived', chatIds: [archived.id], now: 200 },
      'chat-metadata',
    )

    expect(CHAT_CLOSURE_TRANSACTION_CAPABILITY.tableNames).toEqual(
      expect.arrayContaining([
        'chats',
        'chatSidebarRows',
        'messages',
        'messageBodies',
        'messagePreviews',
        'childLists',
        'childSlotMembers',
        'drafts',
        'streamLeases',
        'streamChunks',
        'configurationLinks',
        'attachmentRefEdges',
        'attachments',
        'attachmentCatalogRows',
        'attachmentCatalogAggregate',
        'settings',
      ]),
    )
    expect(commit.value).toEqual({
      deletedChatIds: [archived.id],
      affectedAttachmentIds: [attachment.id],
    })
    expect(await db.chats.get(archived.id)).toBeUndefined()
    expect(await db.chatSidebarRows.get(archived.id)).toBeUndefined()
    expect(await db.messages.where('chatId').equals(archived.id).count()).toBe(0)
    expect(await db.messageBodies.where('chatId').equals(archived.id).count()).toBe(0)
    expect(await db.messagePreviews.where('chatId').equals(archived.id).count()).toBe(0)
    expect(await db.childLists.filter((row) => row.chatId === archived.id).count()).toBe(0)
    expect(await db.childSlotMembers.filter((row) => row.chatId === archived.id).count()).toBe(0)
    expect(await db.drafts.get(archived.id)).toBeUndefined()
    expect(await db.streamChunks.where('chatId').equals(archived.id).count()).toBe(0)
    expect(
      await db.configurationLinks
        .where('ownerKey')
        .equals(configurationOwnerKey('chat', archived.id))
        .count(),
    ).toBe(0)
    expect(await db.attachmentRefEdges.where('chatId').equals(archived.id).count()).toBe(0)
    expect((await db.attachments.get(attachment.id))?.refCount).toBe(0)
    expect(await db.attachmentCatalogRows.get(attachment.id)).toMatchObject({ refCount: 0 })
    expect(await db.attachmentCatalogAggregate.get('workspace')).toMatchObject({
      referencedCount: 0,
      unreferencedCount: 1,
    })
    expect(await db.settings.get('global:token-calibration')).not.toEqual(calibrationBefore)
    await expectAttachmentReferenceInvariants(db)
  })

  it('chunks large explicit archive deletion requests without leaving a hard maximum', async () => {
    const chats: Chat[] = []
    for (let index = 0; index < 35; index += 1) {
      chats.push(
        await seedChat({ id: `archive-batch-${String(index).padStart(2, '0')}`, archived: true }),
      )
    }
    const db = getDb()
    const managerBeforeDelete = (await db.configurationCatalogAggregates.get(
      CONFIGURATION_PROFILE_MANAGER_STATE_ID,
    )) as ConfigurationProfileManagerStateRow | undefined

    const deleted = await deleteArchivedChatsPermanently(
      chats.map((chat) => chat.id),
      200,
    )

    expect(deleted).toEqual(chats.map((chat) => chat.id))
    expect(await db.chats.count()).toBe(0)
    expect(await db.chatSidebarRows.count()).toBe(0)
    expect(await db.chatSidebarAggregates.toArray()).toEqual([emptyChatSidebarAggregateRow()])
    expect(await db.chatSidebarAggregates.get(CHAT_SIDEBAR_AGGREGATE_ID)).toEqual(
      emptyChatSidebarAggregateRow(),
    )
    expect(await db.configurationLinks.count()).toBe(0)
    expect(await db.configurationProfileUsageRows.get(PROFILE_ID)).toBeUndefined()
    const managerAfterDelete = (await db.configurationCatalogAggregates.get(
      CONFIGURATION_PROFILE_MANAGER_STATE_ID,
    )) as ConfigurationProfileManagerStateRow | undefined
    expect(managerAfterDelete?.revision).toBe((managerBeforeDelete?.revision ?? 0) + 2)
  })

  it('archives and restores a chat without rewriting its message branch', async () => {
    const chat = await seedChat({ id: 'archive-roundtrip' })
    const message = await seedMessage(chat.id, { id: 'archive-roundtrip-message' })
    const beforeChat = await query({ kind: 'chat.get', chatId: chat.id })
    if (!beforeChat) throw new Error(`SeedChatMissing:${chat.id}`)
    const headerBefore = await readTestMessageHeader(message.id)

    const archived = await execute(
      { kind: 'chat.set-archived', chatIds: [chat.id], archived: true, now: 200 },
      'chat-metadata',
    )

    expect(archived.value.value).toEqual([chat.id])
    expect(await query({ kind: 'chat.get', chatId: chat.id })).toMatchObject({
      id: chat.id,
      archived: true,
      metaVersion: beforeChat.metaVersion + 1,
      summaryVersion: beforeChat.summaryVersion + 1,
    })
    expect(await readTestMessageHeader(message.id)).toEqual(headerBefore)
    expect(archived.receipt.chats).toEqual([
      expect.objectContaining({ id: chat.id, archived: true }),
    ])
    expect(archived.delta).toEqual({
      facts: [{ kind: 'sidebar-row-changed', chatId: chat.id }],
      invalidations: [
        { kind: 'profile', facets: ['dependent-counts'] },
        { kind: 'chat', chatIds: [chat.id] },
        { kind: 'sidebar', chatIds: [chat.id] },
      ],
    })

    const restored = await execute(
      { kind: 'chat.set-archived', chatIds: [chat.id], archived: false, now: 201 },
      'chat-metadata',
    )

    expect(restored.value.value).toEqual([chat.id])
    expect(await query({ kind: 'chat.get', chatId: chat.id })).toMatchObject({
      id: chat.id,
      archived: false,
      metaVersion: beforeChat.metaVersion + 2,
      summaryVersion: beforeChat.summaryVersion + 2,
    })
    expect(await readTestMessageHeader(message.id)).toEqual(headerBefore)
    expect(restored.delta).toEqual({
      facts: [{ kind: 'sidebar-row-changed', chatId: chat.id }],
      invalidations: [
        { kind: 'profile', facets: ['dependent-counts'] },
        { kind: 'chat', chatIds: [chat.id] },
        { kind: 'sidebar', chatIds: [chat.id] },
      ],
    })
  })

  it('serializes permanent deletion against stream admission in both orders', async () => {
    await seedGenerationProfile()
    const admissionFirst = await seedChat({ id: 'admission-first', archived: true })
    const active = await prepareGeneration(admissionFirst.id, 'admission-first-stream')
    const lease = active.lease
    if (active.prepared.strategy === 'continue') throw new Error('ExpectedGenerationPreparation')
    expect(active.prepared.selectionTransition).toMatchObject({
      kind: 'append-transition',
      chat: { id: admissionFirst.id },
      target: { messageId: active.prepared.assistant.id },
    })
    expect(active.prepared.selectionTransition.suffixHeaders.map((row) => row.id)).toEqual([
      active.prepared.user?.id,
      active.prepared.assistant.id,
    ])
    expect(active.prepared.selectionTransition.forks.map((fork) => fork.selectedMessageId)).toEqual(
      [active.prepared.user?.id, active.prepared.assistant.id],
    )
    expect(active.prepared.selectionTransition.presentations.map((row) => row.message.id)).toEqual([
      active.prepared.user?.id,
      active.prepared.assistant.id,
    ])

    await expect(
      execute(
        { kind: 'chat.delete-archived', chatIds: [admissionFirst.id], now: 20 },
        'chat-metadata',
      ),
    ).rejects.toMatchObject({
      name: 'ChatStreamBusyError',
      chatId: admissionFirst.id,
      streamId: lease.streamId,
    })
    expect(await query({ kind: 'chat.get', chatId: admissionFirst.id })).toBeDefined()
    expect(await query({ kind: 'stream.lease', streamId: lease.streamId })).toMatchObject({
      streamId: lease.streamId,
      chatId: lease.chatId,
      messageId: lease.messageId,
      ownerClientId: lease.ownerClientId,
      fenceToken: lease.fenceToken,
      admissionSequence: lease.admissionSequence,
    })

    const deleteFirst = await seedChat({ id: 'delete-first', archived: true })
    await expect(
      execute(
        { kind: 'chat.delete-archived', chatIds: [deleteFirst.id], now: 21 },
        'chat-metadata',
      ),
    ).resolves.toMatchObject({ value: { deletedChatIds: [deleteFirst.id] } })
    await expect(prepareGeneration(deleteFirst.id, 'delete-first-stream')).rejects.toMatchObject({
      name: 'ChatMissingError',
      chatId: deleteFirst.id,
    })
    expect(await query({ kind: 'stream.lease', streamId: 'delete-first-stream' })).toBeUndefined()

    await finishPreparedGeneration(active)
    expect(await query({ kind: 'stream.lease', streamId: lease.streamId })).toBeUndefined()
  })
})
