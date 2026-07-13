import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import { deleteSingleMessage, editMessageContent, sendUserMessage } from '../../src/core/messages'
import type { Chat, ContinuationAttempt, Message } from '../../src/core/types'
import { applyStructuralSnapshot, snapshotMessages } from '../../src/core/undo'
import { newId } from '../../src/lib/ulid'
import { __resetBroadcastForTests, type BroadcastEvent, onEvent } from '../../src/store/broadcast'
import {
  __resetBrowserRepositoryForTests,
  ChatMissingError,
  getBrowserRepository,
  resolveMutationTableNames,
} from '../../src/store/browser-repo'
import { __resetDbForTests, getDb, openDb } from '../../src/store/db'
import {
  __resetLockTrackerForTests,
  __setLockBackendForTests,
  type LockBackend,
  LockFenceLostError,
} from '../../src/store/locks'
import { previewTextFromContent, splitMessageForStorage } from '../../src/store/message-storage'

const DB_NAME = 'natter'

async function resetAll() {
  __resetBrowserRepositoryForTests()
  __resetDbForTests()
  __resetBroadcastForTests()
  __resetLockTrackerForTests()
  await Dexie.delete(DB_NAME)
}

beforeEach(async () => {
  await resetAll()
})

afterEach(async () => {
  await resetAll()
})

async function seedChat(overrides: Partial<Chat> = {}): Promise<Chat> {
  const db = await openDb()
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
  await db.chats.put(chat)
  return chat
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

async function putStoredMessage(row: Message): Promise<void> {
  const { header, body } = splitMessageForStorage(row)
  await getDb().messages.put(header)
  await getDb().messageBodies.put(body)
}

async function putStoredMessages(rows: readonly Message[]): Promise<void> {
  const split = rows.map((row) => splitMessageForStorage(row))
  await getDb().messages.bulkPut(split.map((row) => row.header))
  await getDb().messageBodies.bulkPut(split.map((row) => row.body))
}

describe('browser repository mutation executor', () => {
  it('commits the earliest-user preview with send, edit, splice-delete, restore, and races', async () => {
    const chat = await seedChat({ previewText: '' })
    const repo = getBrowserRepository()

    await sendUserMessage({
      chatId: chat.id,
      cursor: {},
      content: [{ type: 'text', text: '  First\n prompt  ' }],
      messageId: 'preview-u1',
      now: 200,
    })
    expect((await repo.getChat(chat.id))?.previewText).toBe('First prompt')

    await sendUserMessage({
      chatId: chat.id,
      cursor: {},
      content: [{ type: 'text', text: 'Second prompt' }],
      messageId: 'preview-u2',
      now: 201,
    })
    const beforeEditMeta = await repo.getWorkspaceMeta()
    const events: BroadcastEvent[] = []
    const unsubscribe = onEvent((event) => events.push(event))
    await editMessageContent({
      chatId: chat.id,
      messageId: 'preview-u1',
      content: [{ type: 'text', text: ' Edited\tfirst ' }],
      now: 202,
    })
    unsubscribe()
    expect((await repo.getChat(chat.id))?.previewText).toBe('Edited first')
    expect((await repo.getWorkspaceMeta()).mutationCounter).toBe(beforeEditMeta.mutationCounter + 1)
    expect(events.filter((event) => event.kind === 'chat-mutated')).toHaveLength(1)

    const previousRows = await snapshotMessages(chat.id, ['preview-u1', 'preview-u2'])
    await deleteSingleMessage({
      chatId: chat.id,
      messageId: 'preview-u1',
      cursor: {},
    })
    expect((await repo.getChat(chat.id))?.previewText).toBe('Second prompt')

    await applyStructuralSnapshot({
      chatId: chat.id,
      previousRows,
      newMessageIds: [],
      attachmentIds: [],
    })
    expect((await repo.getChat(chat.id))?.previewText).toBe('Edited first')

    await Promise.all([
      editMessageContent({
        chatId: chat.id,
        messageId: 'preview-u1',
        content: [{ type: 'text', text: 'tab A' }],
        now: 203,
      }),
      editMessageContent({
        chatId: chat.id,
        messageId: 'preview-u1',
        content: [{ type: 'text', text: 'tab B' }],
        now: 204,
      }),
    ])
    const stored = await repo.getMessage('preview-u1')
    expect((await repo.getChat(chat.id))?.previewText).toBe(
      previewTextFromContent(stored?.content ?? []),
    )
  })

  it('does not read user bodies while replacing an assistant streaming body', async () => {
    const repo = getBrowserRepository()
    const chat = await seedChat({ previewText: 'user prompt' })
    const user = makeMessage(chat.id, {
      id: 'preview-user',
      createdAt: 1,
      content: [{ type: 'text', text: 'user prompt' }],
    })
    const assistant = makeMessage(chat.id, {
      id: 'preview-assistant',
      parentId: user.id,
      createdAt: 2,
      role: 'assistant',
      origin: 'generated',
      content: [],
    })
    await putStoredMessages([user, assistant])
    const bodyGet = vi.spyOn(getDb().messageBodies, 'get')

    await repo.runMutation([{ kind: 'message', messageId: assistant.id }], async (ctx) => {
      await ctx.patchMessageBody(
        assistant.id,
        { content: [{ type: 'output_text', text: 'stream replacement' }] },
        { touchChatSummary: false, broadcast: false, replaceBody: true },
      )
    })

    expect(bodyGet).not.toHaveBeenCalled()
    expect((await repo.getChat(chat.id))?.previewText).toBe('user prompt')
  })

  it('reads a 30M-character message preview without cloning its cold body', async () => {
    const repo = getBrowserRepository()
    const chat = await seedChat()
    const message = makeMessage(chat.id, {
      id: 'preview-30m',
      content: [{ type: 'text', text: 'x'.repeat(30_000_000) }],
    })
    await putStoredMessages([message])
    const bodyGet = vi.spyOn(getDb().messageBodies, 'get')
    const bodyToArray = vi.spyOn(getDb().messageBodies, 'toArray')

    expect(await repo.getMessageTextPreview(message.id, { maxChars: 960 })).toBe(
      `${'x'.repeat(959)}…`,
    )
    expect(bodyGet).not.toHaveBeenCalled()
    expect(bodyToArray).not.toHaveBeenCalled()
  })

  it('derives the minimal browser table set from the declared scopes', () => {
    expect(resolveMutationTableNames([{ kind: 'chat-meta', chatId: 'C1' }])).toEqual([
      'chatSidebarRows',
      'chats',
      'settings',
    ])
    expect(resolveMutationTableNames([{ kind: 'draft', chatId: 'C1' }])).toEqual([
      'chatSidebarRows',
      'chats',
      'drafts',
      'settings',
    ])
    expect(resolveMutationTableNames([{ kind: 'attachment', attachmentId: 'A1' }])).toEqual([
      'attachmentArtifacts',
      'attachmentBlobs',
      'attachmentJobs',
      'attachmentRefEdges',
      'attachments',
      'settings',
    ])
    expect(
      resolveMutationTableNames([
        { kind: 'message', messageId: 'M1' },
        { kind: 'children', chatId: 'C1', parentId: null },
      ]),
    ).toEqual([
      'chatBranchCache',
      'chatSidebarRows',
      'chats',
      'childLists',
      'messages',
      'messageBodies',
      'settings',
      'streamLeases',
    ])
  })

  it('throws ChatMissingError when a scoped mutation targets a missing chat', async () => {
    const repo = getBrowserRepository()
    await openDb()
    await expect(
      repo.runMutation([{ kind: 'chat-meta', chatId: 'ghost' }], async (ctx) => {
        ctx.patchChatMeta('ghost', { title: 'nope' })
      }),
    ).rejects.toBeInstanceOf(ChatMissingError)
  })

  it('rolls back before an authoritative transaction when its fallback fence is stale', async () => {
    const chat = await seedChat({ title: 'Before' })
    const repo = getBrowserRepository()
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
    }
    __setLockBackendForTests(backend)
    const beforeWorkspace = await repo.getWorkspaceMeta()
    const events: BroadcastEvent[] = []
    const unsubscribe = onEvent((event) => events.push(event))

    await expect(
      repo.runMutation([{ kind: 'chat-meta', chatId: chat.id }], async (ctx) => {
        ctx.patchChatMeta(chat.id, { title: 'After' })
      }),
    ).rejects.toBeInstanceOf(LockFenceLostError)

    unsubscribe()
    expect((await getDb().chats.get(chat.id))?.title).toBe('Before')
    expect((await repo.getWorkspaceMeta()).mutationCounter).toBe(beforeWorkspace.mutationCounter)
    expect(events).toEqual([])
    __setLockBackendForTests(null)
  })

  it('visible chat-meta writes bump metaVersion and summaryVersion and broadcast once', async () => {
    const repo = getBrowserRepository()
    const chat = await seedChat()
    const received: BroadcastEvent[] = []
    const unsub = onEvent((event) => {
      if (event.kind === 'chat-mutated' && event.chatId === chat.id) received.push(event)
    })

    const result = await repo.runMutation([{ kind: 'chat-meta', chatId: chat.id }], async (ctx) => {
      ctx.patchChatMeta(chat.id, { title: 'Renamed', titleStatus: 'manual' })
      return 'done'
    })

    unsub()
    const stored = await getDb().chats.get(chat.id)
    expect(result.value).toBe('done')
    expect(stored?.title).toBe('Renamed')
    expect(stored?.metaVersion).toBe(1)
    expect(stored?.summaryVersion).toBe(1)
    expect(received).toEqual([
      {
        kind: 'chat-mutated',
        chatId: chat.id,
        metaVersion: 1,
        summaryVersion: 1,
        affected: [{ kind: 'chat-meta', chatId: chat.id }],
      },
    ])
  })

  it('does not recompute message-derived summary fields for chat-meta-only writes', async () => {
    const repo = getBrowserRepository()
    const chat = await seedChat({
      title: 'Original',
      updatedAt: 150,
      wordCount: 77,
      totalCostUsd: 12.5,
      lastUpdatedLeafId: 'MISSING_LEAF',
      lastBranchUpdatedAt: 140,
    })

    await repo.runMutation([{ kind: 'chat-meta', chatId: chat.id }], async (ctx) => {
      ctx.patchChatMeta(chat.id, { title: 'Renamed', titleStatus: 'manual' })
    })

    const stored = await getDb().chats.get(chat.id)
    expect(stored?.title).toBe('Renamed')
    expect(stored?.metaVersion).toBe(1)
    expect(stored?.summaryVersion).toBe(1)
    expect(stored?.updatedAt).toBeGreaterThanOrEqual(150)
    expect(stored?.wordCount).toBe(77)
    expect(stored?.totalCostUsd).toBe(12.5)
    expect(stored?.lastUpdatedLeafId).toBe('MISSING_LEAF')
    expect(stored?.lastBranchUpdatedAt).toBe(140)
  })

  it('non-visible chat-meta writes do not bump versions or broadcast', async () => {
    const repo = getBrowserRepository()
    const chat = await seedChat()
    const received: BroadcastEvent[] = []
    const unsub = onEvent((event) => {
      if (event.kind === 'chat-mutated') received.push(event)
    })

    await repo.runMutation([{ kind: 'chat-meta', chatId: chat.id }], async (ctx) => {
      ctx.patchChatMeta(
        chat.id,
        { lastViewedAt: 200 },
        { touchVisibleState: false, broadcast: false },
      )
    })

    unsub()
    const stored = await getDb().chats.get(chat.id)
    expect(stored?.lastViewedAt).toBe(200)
    expect(stored?.metaVersion).toBe(0)
    expect(stored?.summaryVersion).toBe(0)
    expect(received).toEqual([])
  })

  it('treats a no-op visible chat-meta patch as a no-op', async () => {
    const repo = getBrowserRepository()
    const chat = await seedChat({ title: 'Same', titleStatus: 'manual' })
    const beforeMeta = await repo.getWorkspaceMeta()
    const received: BroadcastEvent[] = []
    const unsub = onEvent((event) => {
      if (event.kind === 'chat-mutated' && event.chatId === chat.id) received.push(event)
    })

    await repo.runMutation([{ kind: 'chat-meta', chatId: chat.id }], async (ctx) => {
      ctx.patchChatMeta(chat.id, { title: 'Same', titleStatus: 'manual' })
    })

    unsub()
    const stored = await getDb().chats.get(chat.id)
    const afterMeta = await repo.getWorkspaceMeta()
    expect(stored?.metaVersion).toBe(0)
    expect(stored?.summaryVersion).toBe(0)
    expect(received).toEqual([])
    expect(afterMeta.mutationCounter).toBe(beforeMeta.mutationCounter)
  })

  it('persists same-parent inserts without dropping either write', async () => {
    const repo = getBrowserRepository()
    const chat = await seedChat()
    const first = makeMessage(chat.id, { id: 'M1' })
    const second = makeMessage(chat.id, { id: 'M2', siblingIndex: 1 })

    await Promise.all([
      repo.runMutation(
        [
          { kind: 'message', messageId: first.id },
          { kind: 'children', chatId: chat.id, parentId: null },
        ],
        async (ctx) => {
          await ctx.putMessage(first)
        },
      ),
      repo.runMutation(
        [
          { kind: 'message', messageId: second.id },
          { kind: 'children', chatId: chat.id, parentId: null },
        ],
        async (ctx) => {
          await ctx.putMessage(second)
        },
      ),
    ])

    const stored = await getDb().messages.where('chatId').equals(chat.id).toArray()
    expect(stored.map((message) => message.id).sort()).toEqual(['M1', 'M2'])
  })

  it('persists disjoint message-scope edits in the same chat without either write being lost', async () => {
    const repo = getBrowserRepository()
    const chat = await seedChat()
    const first = makeMessage(chat.id, { id: 'M1' })
    const second = makeMessage(chat.id, { id: 'M2', siblingIndex: 1 })
    await putStoredMessages([first, second])

    await Promise.all([
      repo.runMutation([{ kind: 'message', messageId: first.id }], async (ctx) => {
        const current = (await ctx.getMessage(first.id)) as Message
        await ctx.putMessage({
          ...current,
          content: [{ type: 'text', text: 'edited-1' }],
        })
      }),
      repo.runMutation([{ kind: 'message', messageId: second.id }], async (ctx) => {
        const current = (await ctx.getMessage(second.id)) as Message
        await ctx.putMessage({
          ...current,
          content: [{ type: 'text', text: 'edited-2' }],
        })
      }),
    ])

    const storedFirst = await repo.getMessage(first.id)
    const storedSecond = await repo.getMessage(second.id)
    expect((storedFirst?.content[0] as { type: 'text'; text: string } | undefined)?.text).toBe(
      'edited-1',
    )
    expect((storedSecond?.content[0] as { type: 'text'; text: string } | undefined)?.text).toBe(
      'edited-2',
    )
  })

  it('persists writes in different chats independently', async () => {
    const repo = getBrowserRepository()
    const left = await seedChat({ id: 'C_LEFT' })
    const right = await seedChat({ id: 'C_RIGHT' })
    const leftMessage = makeMessage(left.id, { id: 'LM1' })
    const rightMessage = makeMessage(right.id, { id: 'RM1' })

    await Promise.all([
      repo.runMutation(
        [
          { kind: 'message', messageId: leftMessage.id },
          { kind: 'children', chatId: left.id, parentId: null },
        ],
        async (ctx) => {
          await ctx.putMessage(leftMessage)
        },
      ),
      repo.runMutation(
        [
          { kind: 'message', messageId: rightMessage.id },
          { kind: 'children', chatId: right.id, parentId: null },
        ],
        async (ctx) => {
          await ctx.putMessage(rightMessage)
        },
      ),
    ])

    expect(await getDb().messages.get(leftMessage.id)).toBeDefined()
    expect(await getDb().messages.get(rightMessage.id)).toBeDefined()
  })

  it('loads an active-branch snapshot without requiring off-branch message bodies', async () => {
    const repo = getBrowserRepository()
    const chat = await seedChat()
    const otherChat = await seedChat({ id: 'other-chat' })
    const root = makeMessage(chat.id, { id: 'R', createdAt: 1 })
    const latest = makeMessage(chat.id, { id: 'L', parentId: 'R', createdAt: 3 })
    const offPath = makeMessage(chat.id, {
      id: 'O',
      parentId: 'R',
      siblingIndex: 1,
      createdAt: 2,
      content: [{ type: 'text', text: 'missing body should not load' }],
    })
    const otherChatMessage = makeMessage(otherChat.id, {
      id: 'OTHER',
      content: [{ type: 'text', text: 'other chat body should not load' }],
    })
    await putStoredMessages([root, latest])
    const offPathSplit = splitMessageForStorage(offPath)
    await getDb().messages.put(offPathSplit.header)
    const otherChatSplit = splitMessageForStorage(otherChatMessage)
    await getDb().messages.put(otherChatSplit.header)

    const snapshot = await repo.getActiveBranchSnapshot(chat.id, {})
    expect(snapshot.branch.map((message) => message.id)).toEqual(['R', 'L'])
    expect(snapshot.branch.map((message) => message.content[0])).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'text', text: 'hi' },
    ])
    expect(snapshot.siblingGroups.find((group) => group.parentId === 'R')?.siblings).toHaveLength(2)
    await expect(repo.listMessages(chat.id)).rejects.toThrow('MessageBodyMissing:O')
    await expect(repo.listMessages(otherChat.id)).rejects.toThrow('MessageBodyMissing:OTHER')
  })

  it('loads only the requested active-branch body window', async () => {
    const repo = getBrowserRepository()
    const chat = await seedChat()
    const rows = [
      makeMessage(chat.id, { id: 'W0', createdAt: 0 }),
      makeMessage(chat.id, { id: 'W1', parentId: 'W0', createdAt: 1 }),
      makeMessage(chat.id, { id: 'W2', parentId: 'W1', createdAt: 2 }),
      makeMessage(chat.id, { id: 'W3', parentId: 'W2', createdAt: 3 }),
    ]
    await putStoredMessages([rows[1] as Message, rows[2] as Message])
    for (const row of [rows[0], rows[3]]) {
      const split = splitMessageForStorage(row as Message)
      await getDb().messages.put(split.header)
    }

    const snapshot = await repo.getActiveBranchWindowSnapshot(chat.id, {}, { offset: 1, limit: 2 })

    expect(snapshot.branchHeaders.map((row) => row.id)).toEqual(['W0', 'W1', 'W2', 'W3'])
    expect(snapshot.branchWindow.map((row) => row.id)).toEqual(['W1', 'W2'])
    expect(snapshot.branchLength).toBe(4)
    await expect(repo.getActiveBranchSnapshot(chat.id, {})).rejects.toThrow('MessageBodyMissing:W0')
  })

  it('reads root child headers without querying a null compound key', async () => {
    const repo = getBrowserRepository()
    const chat = await seedChat()
    const left = makeMessage(chat.id, { id: 'R1', createdAt: 1 })
    const right = makeMessage(chat.id, { id: 'R2', siblingIndex: 1, createdAt: 2 })
    const child = makeMessage(chat.id, { id: 'C1', parentId: 'R1', createdAt: 3 })
    await putStoredMessages([left, right, child])

    expect((await repo.listChildHeaders(chat.id, null)).map((row) => row.id)).toEqual(['R1', 'R2'])
    await repo.runMutation([{ kind: 'children', chatId: chat.id, parentId: null }], async (ctx) => {
      expect((await ctx.listChildHeaders(chat.id, null)).map((row) => row.id)).toEqual(['R1', 'R2'])
    })
  })

  it('serializes overlapping message scopes and increments nodeVersion on each committed rewrite', async () => {
    const repo = getBrowserRepository()
    const chat = await seedChat()
    const row = makeMessage(chat.id, { id: 'M1' })
    await putStoredMessage(row)

    await Promise.all([
      repo.runMutation([{ kind: 'message', messageId: row.id }], async (ctx) => {
        const current = (await ctx.getMessage(row.id)) as Message
        await ctx.putMessage({
          ...current,
          content: [{ type: 'text', text: 'v1' }],
        })
      }),
      repo.runMutation([{ kind: 'message', messageId: row.id }], async (ctx) => {
        const current = (await ctx.getMessage(row.id)) as Message
        await ctx.putMessage({
          ...current,
          content: [{ type: 'text', text: 'v2' }],
        })
      }),
    ])

    const stored = await repo.getMessage(row.id)
    expect(stored?.nodeVersion).toBe(2)
    expect(['v1', 'v2']).toContain(
      (stored?.content[0] as { type: 'text'; text: string } | undefined)?.text,
    )
  })

  it('patches streaming body fields without touching chat summary state', async () => {
    const repo = getBrowserRepository()
    const chat = await seedChat()
    const row = makeMessage(chat.id, {
      id: 'M1',
      role: 'assistant',
      origin: 'generated',
      generation: {
        id: '',
        model: 'initial',
        requestedModel: 'initial',
        apiUsed: 'chat',
        delivery: 'streaming',
        costSource: 'stream',
        startedAt: 1,
      },
    })
    await putStoredMessage(row)
    const continuationAttempt: ContinuationAttempt = {
      streamId: 'continue-stream-1',
      strategy: 'prefill',
      status: 'done',
      requestedModel: 'initial',
      model: 'resolved',
      apiUsed: 'responses',
      provider: 'provider-a',
      generationId: 'continue-generation-1',
      startedAt: 2,
      finishedAt: 3,
      finishReason: 'stop',
      reasoningDetails: [{ type: 'reasoning.text', text: 'continued thinking' }],
      phase: 'final_answer',
      providerOutputItems: [
        {
          dialect: 'openai-responses',
          type: 'reasoning',
          item: { id: 'continue-item-1' },
        },
      ],
    }

    await repo.runMutation([{ kind: 'message', messageId: row.id }], async (ctx) => {
      await ctx.patchMessageBody(
        row.id,
        {
          content: [{ type: 'output_text', text: 'partial' }],
          reasoningDetails: [{ type: 'reasoning.text', text: 'thinking' }],
          continuationAttempts: [continuationAttempt],
        },
        {
          touchChatSummary: false,
          broadcast: false,
          headerPatch: {
            generation: {
              id: 'gen-1',
              model: 'resolved',
              requestedModel: 'initial',
              apiUsed: 'responses',
              delivery: 'streaming',
              costSource: 'stream',
              startedAt: 1,
            },
          },
        },
      )
    })

    const header = await getDb().messages.get(row.id)
    const body = await getDb().messageBodies.get(row.id)
    const stored = await repo.getMessage(row.id)
    expect(header).toMatchObject({
      id: row.id,
      nodeVersion: 1,
      generation: { id: 'gen-1', model: 'resolved', apiUsed: 'responses' },
    })
    expect(header && 'content' in header).toBe(false)
    expect(body).toMatchObject({
      id: row.id,
      nodeVersion: 1,
      content: [{ type: 'output_text', text: 'partial' }],
      reasoningDetails: [{ type: 'reasoning.text', text: 'thinking' }],
      continuationAttempts: [continuationAttempt],
    })
    expect(stored).toMatchObject({
      id: row.id,
      nodeVersion: 1,
      content: [{ type: 'output_text', text: 'partial' }],
      generation: { id: 'gen-1', model: 'resolved', apiUsed: 'responses' },
      continuationAttempts: [continuationAttempt],
    })
    expect((await getDb().chats.get(chat.id))?.summaryVersion).toBe(0)
  })

  it('keeps message body patches out of structural header fields', async () => {
    const repo = getBrowserRepository()
    const chat = await seedChat()
    const row = makeMessage(chat.id, {
      id: 'M1',
      reasoningDetails: [{ type: 'reasoning.text', text: 'old' }],
    })
    await putStoredMessage(row)

    await repo.runMutation([{ kind: 'message', messageId: row.id }], async (ctx) => {
      await ctx.patchMessageBody(row.id, { reasoningDetails: undefined })
    })
    expect((await repo.getMessage(row.id))?.reasoningDetails).toBeUndefined()

    await expect(
      repo.runMutation([{ kind: 'message', messageId: row.id }], async (ctx) => {
        await ctx.patchMessageBody(
          row.id,
          { content: row.content },
          { headerPatch: { parentId: 'P' } },
        )
      }),
    ).rejects.toThrow('MessageHeaderPatchForbidden:M1:parentId')
  })

  it('can replace a streaming body without reading the existing body row', async () => {
    const repo = getBrowserRepository()
    const chat = await seedChat()
    const row = makeMessage(chat.id, { id: 'M1' })
    await putStoredMessage(row)
    await getDb().messageBodies.delete(row.id)

    await repo.runMutation([{ kind: 'message', messageId: row.id }], async (ctx) => {
      await ctx.patchMessageBody(
        row.id,
        { content: [{ type: 'output_text', text: 'stream replacement' }] },
        { touchChatSummary: false, broadcast: false, replaceBody: true },
      )
    })

    const stored = await repo.getMessage(row.id)
    expect(stored).toMatchObject({
      id: row.id,
      nodeVersion: 1,
      content: [{ type: 'output_text', text: 'stream replacement' }],
    })
  })

  it('recomputes totalCostUsd on cost writes, soft delete/restore, and hard delete', async () => {
    const repo = getBrowserRepository()
    const chat = await seedChat({ lastUpdatedLeafId: 'M1' })
    const row = makeMessage(chat.id, { id: 'M1' })
    await putStoredMessage(row)

    const withCost: Message = {
      ...row,
      generation: {
        id: 'gen-M1',
        model: 'test',
        requestedModel: 'test',
        apiUsed: 'chat',
        delivery: 'buffered',
        cost: 0.75,
        costSource: 'estimated',
        startedAt: 1,
      },
    }

    await repo.runMutation([{ kind: 'message', messageId: row.id }], async (ctx) => {
      await ctx.putMessage(withCost)
    })
    expect((await getDb().chats.get(chat.id))?.totalCostUsd).toBe(0.75)

    await repo.runMutation(
      [
        { kind: 'message', messageId: row.id },
        { kind: 'children', chatId: chat.id, parentId: null },
      ],
      async (ctx) => {
        await ctx.putMessage({ ...withCost, deleted: true })
      },
    )
    expect((await getDb().chats.get(chat.id))?.totalCostUsd).toBe(0)

    await repo.runMutation(
      [
        { kind: 'message', messageId: row.id },
        { kind: 'children', chatId: chat.id, parentId: null },
      ],
      async (ctx) => {
        const current = (await ctx.getMessage(row.id)) as Message
        await ctx.putMessage({ ...current, deleted: false })
      },
    )
    expect((await getDb().chats.get(chat.id))?.totalCostUsd).toBe(0.75)

    await repo.runMutation(
      [
        { kind: 'message', messageId: row.id },
        { kind: 'children', chatId: chat.id, parentId: null },
      ],
      async (ctx) => {
        await ctx.deleteMessage(row.id)
      },
    )
    expect((await getDb().chats.get(chat.id))?.totalCostUsd).toBe(0)
  })

  it('rolls back message writes when the callback throws', async () => {
    const repo = getBrowserRepository()
    const chat = await seedChat()

    await expect(
      repo.runMutation(
        [
          { kind: 'message', messageId: 'will-not-persist' },
          { kind: 'children', chatId: chat.id, parentId: null },
        ],
        async (ctx) => {
          await ctx.putMessage(makeMessage(chat.id, { id: 'will-not-persist' }))
          throw new Error('boom')
        },
      ),
    ).rejects.toThrow('boom')

    expect(await getDb().messages.get('will-not-persist')).toBeUndefined()
  })

  it('rejects undeclared structural writes', async () => {
    const repo = getBrowserRepository()
    const chat = await seedChat()

    await expect(
      repo.runMutation([{ kind: 'message', messageId: 'M1' }], async (ctx) => {
        await ctx.putMessage(makeMessage(chat.id, { id: 'M1' }))
      }),
    ).rejects.toThrow('UndeclaredScope:children:')
  })

  it('advances workspace mutation metadata for attachment-only writes', async () => {
    const repo = getBrowserRepository()
    const before = await repo.getWorkspaceMeta()

    await repo.runMutation([{ kind: 'attachment', attachmentId: 'A1' }], async (ctx) => {
      await ctx.putAttachment({
        id: 'A1',
        contentHash: 'hash',
        kind: 'other',
        mime: 'text/plain',
        filename: 'a.txt',
        sizeBytes: 1,
        origin: 'system-fixture',
        createdAt: 1,
        updatedAt: 1,
        storage: { kind: 'local-blob', blobId: 'A1:blob' },
        artifacts: [],
        processing: [],
        refCount: 0,
      })
    })

    const after = await repo.getWorkspaceMeta()
    expect(after.lastMutationAt).toBeGreaterThanOrEqual(before.lastMutationAt)
    expect(after.mutationCounter).toBe(before.mutationCounter + 1)
  })
})
