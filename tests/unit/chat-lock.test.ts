import Dexie from 'dexie'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type { Chat, Message } from '../../src/core/types'
import { newId } from '../../src/lib/ulid'
import { __resetBroadcastForTests, subscribeWorkspaceChanges } from '../../src/store/broadcast'
import { __resetBrowserRepositoryForTests } from '../../src/store/browser-repo'
import {
  openBrowserWorkspace,
  shutdownBrowserWorkspace,
} from '../../src/store/browser-workspace-lifecycle'
import { __resetDbForTests, getDb } from '../../src/store/db'
import { exportWorkspaceBackup, restoreWorkspaceBackup } from '../../src/store/import-export'
import {
  __resetLockTrackerForTests,
  __setLockBackendForTests,
  type LockBackend,
  LockFenceLostError,
} from '../../src/store/locks'
import { previewTextFromContent } from '../../src/store/message-storage'
import type {
  CommitEnvelope,
  ReadEnvelope,
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
import { executeMessageCommand } from '../helpers/message-commands'
import { putTestMessages, readTestMessageHeader } from '../helpers/message-storage'

const DB_NAME = 'natter'
let emptyWorkspaceBackup: Awaited<ReturnType<typeof exportWorkspaceBackup>>

beforeAll(async () => {
  ;(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory()
  __resetWorkspaceRepositoryForTests()
  __resetBrowserRepositoryForTests()
  __resetBroadcastForTests()
  __resetLockTrackerForTests()
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

function query<Q extends WorkspaceQuery>(
  request: Q,
): Promise<ReadEnvelope<WorkspaceQueryResult<Q>>> {
  return runWorkspaceRead('repository-query', (permit) =>
    getWorkspaceRepository().query(permit, request, { signal: permit.signal }),
  )
}

function execute<C extends WorkspaceCommand>(
  command: C,
): Promise<CommitEnvelope<WorkspaceCommandResult<C>>> {
  return runWorkspaceAction('maintenance', (permit) =>
    getWorkspaceRepository().execute(permit, command),
  )
}

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
    structuralVersion: 0,
    configurationVersion: 0,
    settings: cloneDefaultChatSettings(),
    lastUpdatedLeafId: null,
    lastBranchUpdatedAt: 100,
    archived: false,
    pinned: false,
    folderId: null,
    tags: [],
    previewText: '',
    ...overrides,
  }
  return putTestChat(chat)
}

function makeMessage(chatId: string, overrides: Partial<Message> = {}): Message {
  return {
    id: newId(),
    chatId,
    parentId: null,
    siblingIndex: 0,
    turnId: newId(),
    turnIndex: 0,
    createdAt: Date.now(),
    role: 'user',
    origin: 'user',
    content: [{ type: 'text', text: 'hi' }],
    nodeVersion: 0,
    deleted: false,
    ...overrides,
  }
}

async function appendMessage(message: Message, expectedLeafId: string | null) {
  await putTestMessages([{ ...message, parentId: expectedLeafId }])
}

async function getChat(chatId: string): Promise<Chat | undefined> {
  return (await query({ kind: 'chat.get', chatId })).value
}

async function getMessage(messageId: string): Promise<Message | undefined> {
  return (await query({ kind: 'message.presentation', messageId })).value?.message
}

describe('workspace command locking and projection contract', () => {
  it('keeps the earliest-user preview correct across append, edit, splice, restore, and races', async () => {
    const chat = await seedChat()
    const first = makeMessage(chat.id, {
      id: 'preview-u1',
      createdAt: 200,
      content: [{ type: 'text', text: '  First\n prompt  ' }],
    })
    const second = makeMessage(chat.id, {
      id: 'preview-u2',
      createdAt: 201,
      content: [{ type: 'text', text: 'Second prompt' }],
    })

    await appendMessage(first, null)
    expect((await getChat(chat.id))?.previewText).toBe('First prompt')
    await appendMessage(second, first.id)

    await executeMessageCommand({
      kind: 'message.edit-body',
      input: {
        chatId: chat.id,
        messageId: first.id,
        content: [{ type: 'text', text: ' Edited\tfirst ' }],
        now: 202,
      },
    })
    expect((await getChat(chat.id))?.previewText).toBe('Edited first')

    const deletion = await executeMessageCommand({
      kind: 'message.delete',
      mode: 'single',
      input: {
        chatId: chat.id,
        messageId: first.id,
        activeLeafId: second.id,
        now: 203,
      },
    })
    expect((await getChat(chat.id))?.previewText).toBe('Second prompt')

    await executeMessageCommand({
      kind: 'message.restore-structure',
      input: { snapshot: deletion.preImage },
    })
    expect((await getChat(chat.id))?.previewText).toBe('Edited first')

    await Promise.all([
      executeMessageCommand({
        kind: 'message.edit-body',
        input: {
          chatId: chat.id,
          messageId: first.id,
          content: [{ type: 'text', text: 'tab A' }],
          now: 204,
        },
      }),
      executeMessageCommand({
        kind: 'message.edit-body',
        input: {
          chatId: chat.id,
          messageId: first.id,
          content: [{ type: 'text', text: 'tab B' }],
          now: 205,
        },
      }),
    ])
    const stored = await getMessage(first.id)
    expect((await getChat(chat.id))?.previewText).toBe(
      previewTextFromContent(stored?.content ?? []),
    )
  })

  it('reads a 30M-character preview without hydrating or scanning the cold body table', async () => {
    const chat = await seedChat()
    const message = makeMessage(chat.id, {
      id: 'preview-30m',
      content: [{ type: 'text', text: 'x'.repeat(30_000_000) }],
    })
    await appendMessage(message, null)
    const header = await readTestMessageHeader(message.id)
    if (!header) throw new Error('PreviewHeaderMissing')
    const bodyGet = vi.spyOn(getDb().messageBodies, 'get')
    const bodyToArray = vi.spyOn(getDb().messageBodies, 'toArray')

    const preview = (
      await query({
        kind: 'message.preview-window',
        targets: [
          {
            messageId: message.id,
            bodyVersion: header.bodyVersion,
          },
        ],
        maxChars: 960,
      })
    ).value[0]

    expect(preview?.text).toBe(`${'x'.repeat(959)}…`)
    expect(bodyGet).not.toHaveBeenCalled()
    expect(bodyToArray).not.toHaveBeenCalled()
  })

  it('commits disjoint message edits in one chat without losing either write', async () => {
    const chat = await seedChat()
    const first = makeMessage(chat.id, { id: 'disjoint-1', createdAt: 1 })
    const second = makeMessage(chat.id, { id: 'disjoint-2', createdAt: 2 })
    await appendMessage(first, null)
    await appendMessage(second, first.id)

    await Promise.all([
      executeMessageCommand({
        kind: 'message.edit-body',
        input: {
          chatId: chat.id,
          messageId: first.id,
          content: [{ type: 'text', text: 'edited-1' }],
          now: 3,
        },
      }),
      executeMessageCommand({
        kind: 'message.edit-body',
        input: {
          chatId: chat.id,
          messageId: second.id,
          content: [{ type: 'text', text: 'edited-2' }],
          now: 4,
        },
      }),
    ])

    expect((await getMessage(first.id))?.content).toEqual([{ type: 'text', text: 'edited-1' }])
    expect((await getMessage(second.id))?.content).toEqual([{ type: 'text', text: 'edited-2' }])
  })

  it('serializes overlapping edits and commits both body versions', async () => {
    const chat = await seedChat()
    const message = makeMessage(chat.id, { id: 'overlap', createdAt: 1 })
    await appendMessage(message, null)

    await Promise.all([
      executeMessageCommand({
        kind: 'message.edit-body',
        input: {
          chatId: chat.id,
          messageId: message.id,
          content: [{ type: 'text', text: 'v1' }],
          now: 2,
        },
      }),
      executeMessageCommand({
        kind: 'message.edit-body',
        input: {
          chatId: chat.id,
          messageId: message.id,
          content: [{ type: 'text', text: 'v2' }],
          now: 3,
        },
      }),
    ])

    const presentation = (await query({ kind: 'message.presentation', messageId: message.id }))
      .value
    expect(presentation?.header.nodeVersion).toBe(2)
    expect(presentation?.bodyVersion).toBe(2)
    expect(['v1', 'v2']).toContain(
      (presentation?.message.content[0] as { type: 'text'; text: string } | undefined)?.text,
    )
  })

  it('keeps simultaneous writes in different chats independently committable', async () => {
    const left = await seedChat({ id: 'left-chat' })
    const right = await seedChat({ id: 'right-chat' })

    const [leftResult, rightResult] = await Promise.all([
      executeMessageCommand({
        kind: 'message.import',
        input: {
          chatId: left.id,
          slot: { kind: 'at-end' },
          activeLeafId: null,
          messages: [{ role: 'user', content: [{ type: 'text', text: 'left' }] }],
          now: 200,
        },
      }),
      executeMessageCommand({
        kind: 'message.import',
        input: {
          chatId: right.id,
          slot: { kind: 'at-end' },
          activeLeafId: null,
          messages: [{ role: 'user', content: [{ type: 'text', text: 'right' }] }],
          now: 200,
        },
      }),
    ])
    const leftMessageId = leftResult.newMessageIds[0]
    const rightMessageId = rightResult.newMessageIds[0]
    if (!leftMessageId || !rightMessageId) throw new Error('ParallelImportMessageMissing')

    expect(await getMessage(leftMessageId)).toMatchObject({ chatId: left.id })
    expect(await getMessage(rightMessageId)).toMatchObject({ chatId: right.id })
  })

  it('updates visible chat metadata once without recomputing message-derived summaries', async () => {
    const chat = await seedChat({
      title: 'Original',
      titleStatus: 'untitled',
      updatedAt: 150,
      wordCount: 77,
      totalCostUsd: 12.5,
      lastBranchUpdatedAt: 140,
    })
    const changes: WorkspaceChange[] = []
    const unsubscribe = subscribeWorkspaceChanges((change) => changes.push(change))

    const commit = await execute({
      kind: 'chat.set-manual-title',
      chatId: chat.id,
      title: ' Renamed ',
      now: 200,
    })
    unsubscribe()

    const stored = await getChat(chat.id)
    expect(commit.effectScope).toBe('workspace')
    expect(commit.value.value).toBe(true)
    expect(commit.receipt.chats).toHaveLength(1)
    expect(stored).toMatchObject({
      title: 'Renamed',
      titleStatus: 'manual',
      metaVersion: 1,
      summaryVersion: 1,
      wordCount: 77,
      totalCostUsd: 12.5,
      lastBranchUpdatedAt: 140,
    })
    expect(changes).toHaveLength(1)
    expect(changes[0]?.kind).toBe('commit')
    if (changes[0]?.kind !== 'commit') throw new Error('ExpectedCommitChange')
    expect(changes[0].stamp.commitId).toBe(commit.commitId)
  })

  it('keeps viewed-only metadata invisible and suppresses no-op title commits', async () => {
    const chat = await seedChat({ title: 'Same', titleStatus: 'manual' })
    const viewed = await execute({
      kind: 'chat.touch-viewed',
      chatId: chat.id,
      now: 200,
    })
    const afterViewed = await getChat(chat.id)
    expect(viewed.value.value).toBe(true)
    expect(afterViewed).toMatchObject({
      lastViewedAt: 200,
      metaVersion: 0,
      summaryVersion: 0,
    })

    const changes: WorkspaceChange[] = []
    const unsubscribe = subscribeWorkspaceChanges((change) => changes.push(change))
    const noOp = await execute({
      kind: 'chat.set-manual-title',
      chatId: chat.id,
      title: 'Same',
      now: 201,
    })
    unsubscribe()
    expect(noOp.effectScope).toBe('none')
    expect(noOp.value.value).toBe(false)
    expect(changes).toEqual([])
    expect(await getChat(chat.id)).toMatchObject({ metaVersion: 0, summaryVersion: 0 })
  })

  it('aborts before an authoritative write on a stale fallback fence and retries cleanly', async () => {
    const chat = await seedChat({ title: 'Before' })
    const backend: LockBackend = {
      kind: 'indexeddb-fence',
      run: async (logicalNames, fn) =>
        fn({
          kind: 'indexeddb-fence',
          logicalNames,
          runTransaction: async () => {
            throw new LockFenceLostError(7)
          },
        }),
      runAuthoritativeCommandSession: async (_database, operation) =>
        operation({
          kind: 'indexeddb-fence',
          withResourceLocks: (logicalNames, fn) => backend.run(logicalNames, fn),
        }),
    }
    __setLockBackendForTests(backend)
    const changes: WorkspaceChange[] = []
    const unsubscribe = subscribeWorkspaceChanges((change) => changes.push(change))

    await expect(
      execute({
        kind: 'chat.set-manual-title',
        chatId: chat.id,
        title: 'After',
        now: 200,
      }),
    ).rejects.toBeInstanceOf(LockFenceLostError)
    unsubscribe()
    expect((await getChat(chat.id))?.title).toBe('Before')
    expect(changes).toEqual([])

    __setLockBackendForTests(null)
    const retry = await execute({
      kind: 'chat.set-manual-title',
      chatId: chat.id,
      title: 'After',
      now: 201,
    })
    expect(retry.effectScope).toBe('workspace')
    expect((await getChat(chat.id))?.title).toBe('After')
  })

  it('keeps body edits out of structural header identity', async () => {
    const chat = await seedChat()
    const message = makeMessage(chat.id, { id: 'body-vs-structure', createdAt: 1 })
    await appendMessage(message, null)
    const before = await readTestMessageHeader(message.id)
    if (!before) throw new Error('ExpectedMessageHeader')

    await executeMessageCommand({
      kind: 'message.edit-body',
      input: {
        chatId: chat.id,
        messageId: message.id,
        content: [{ type: 'text', text: 'changed body' }],
        now: 2,
      },
    })

    const after = await readTestMessageHeader(message.id)
    expect(after).toMatchObject({
      id: before.id,
      chatId: before.chatId,
      parentId: before.parentId,
      siblingIndex: before.siblingIndex,
      turnId: before.turnId,
      turnIndex: before.turnIndex,
      role: before.role,
      origin: before.origin,
      createdAt: before.createdAt,
      deleted: before.deleted,
      nodeVersion: before.nodeVersion + 1,
      bodyVersion: before.bodyVersion + 1,
    })
  })

  it('recomputes message cost across soft delete and structural restore', async () => {
    const chat = await seedChat()
    const message = makeMessage(chat.id, {
      id: 'cost-message',
      role: 'assistant',
      origin: 'generated',
      generation: {
        id: 'generation',
        model: 'test',
        requestedModel: 'test',
        apiUsed: 'chat',
        delivery: 'buffered',
        cost: 0.75,
        costSource: 'estimated',
        reasoningCarryForward: 'none',
        reasoningVisibility: { disclosure: 'unknown' },
        startedAt: 1,
      },
    })
    await appendMessage(message, null)
    expect((await getChat(chat.id))?.totalCostUsd).toBe(0.75)

    const deletion = await executeMessageCommand({
      kind: 'message.delete',
      mode: 'single',
      input: {
        chatId: chat.id,
        messageId: message.id,
        activeLeafId: message.id,
        now: 2,
      },
    })
    expect((await getChat(chat.id))?.totalCostUsd).toBe(0)

    await executeMessageCommand({
      kind: 'message.restore-structure',
      input: { snapshot: deletion.preImage },
    })
    expect((await getChat(chat.id))?.totalCostUsd).toBe(0.75)
  })
})
