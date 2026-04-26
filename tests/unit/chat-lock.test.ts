import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type { Chat, Message } from '../../src/core/types'
import { newId } from '../../src/lib/ulid'
import { __resetBroadcastForTests, type BroadcastEvent, onEvent } from '../../src/store/broadcast'
import {
  __resetBrowserRepositoryForTests,
  ChatMissingError,
  getBrowserRepository,
  resolveMutationTableNames,
} from '../../src/store/browser-repo'
import { __resetDbForTests, getDb, openDb } from '../../src/store/db'

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

describe('browser repository mutation executor', () => {
  it('derives the minimal browser table set from the declared scopes', () => {
    expect(resolveMutationTableNames([{ kind: 'chat-meta', chatId: 'C1' }])).toEqual([
      'chats',
      'settings',
    ])
    expect(resolveMutationTableNames([{ kind: 'draft', chatId: 'C1' }])).toEqual([
      'chats',
      'drafts',
      'settings',
    ])
    expect(resolveMutationTableNames([{ kind: 'attachment', attachmentId: 'A1' }])).toEqual([
      'attachmentArtifacts',
      'attachmentBlobs',
      'attachmentJobs',
      'attachments',
      'settings',
    ])
    expect(
      resolveMutationTableNames([
        { kind: 'message', messageId: 'M1' },
        { kind: 'children', chatId: 'C1', parentId: null },
      ]),
    ).toEqual(['chatBranchCache', 'chats', 'childLists', 'messages', 'settings'])
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
    await getDb().messages.bulkPut([first, second])

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

    const storedFirst = await getDb().messages.get(first.id)
    const storedSecond = await getDb().messages.get(second.id)
    expect((storedFirst?.content[0] as { type: 'text'; text: string }).text).toBe('edited-1')
    expect((storedSecond?.content[0] as { type: 'text'; text: string }).text).toBe('edited-2')
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

  it('serializes overlapping message scopes and increments nodeVersion on each committed rewrite', async () => {
    const repo = getBrowserRepository()
    const chat = await seedChat()
    const row = makeMessage(chat.id, { id: 'M1' })
    await getDb().messages.put(row)

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

    const stored = await getDb().messages.get(row.id)
    expect(stored?.nodeVersion).toBe(2)
    expect(['v1', 'v2']).toContain((stored?.content[0] as { type: 'text'; text: string }).text)
  })

  it('recomputes totalCostUsd on cost writes, soft delete/restore, and hard delete', async () => {
    const repo = getBrowserRepository()
    const chat = await seedChat({ lastUpdatedLeafId: 'M1' })
    const row = makeMessage(chat.id, { id: 'M1' })
    await getDb().messages.put(row)

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
