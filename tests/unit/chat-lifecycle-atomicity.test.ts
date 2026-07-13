import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Chat } from '../../src/core/types'
import { __resetBroadcastForTests, type BroadcastEvent, onEvent } from '../../src/store/broadcast'
import {
  __resetBrowserRepositoryForTests,
  getBrowserRepository,
} from '../../src/store/browser-repo'
import { createChat, discardEmptyDraftChats, markChatPermanent } from '../../src/store/chats'
import { __resetDbForTests, getDb, openDb } from '../../src/store/db'
import { __resetLockTrackerForTests } from '../../src/store/locks'

const DB_NAME = 'natter'

async function reset(): Promise<void> {
  __resetBrowserRepositoryForTests()
  __resetBroadcastForTests()
  __resetDbForTests()
  __resetLockTrackerForTests()
  await Dexie.delete(DB_NAME)
}

class WorkspaceGateLockManager {
  private shared = 0
  private exclusive = false
  private readonly queue: Array<{ mode: LockMode; run: () => void }> = []
  private readonly acquisitionCounts = new Map<LockMode, number>()
  private readonly acquisitionWaiters: Array<{
    mode: LockMode
    count: number
    resolve: () => void
  }> = []

  waitForAcquisition(mode: LockMode, count = 1): Promise<void> {
    if ((this.acquisitionCounts.get(mode) ?? 0) >= count) return Promise.resolve()
    return new Promise((resolve) => {
      this.acquisitionWaiters.push({ mode, count, resolve })
    })
  }

  request<T>(
    name: string,
    optionsOrCallback: LockOptions | ((lock: Lock | null) => T | PromiseLike<T>),
    maybeCallback?: (lock: Lock | null) => T | PromiseLike<T>,
  ): Promise<T> {
    const options = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback
    const callback =
      typeof optionsOrCallback === 'function'
        ? optionsOrCallback
        : (maybeCallback as NonNullable<typeof maybeCallback>)
    if (name !== 'workspace:authoritative') return Promise.resolve(callback(null))
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        mode: options.mode ?? 'exclusive',
        run: () => {
          const mode = options.mode ?? 'exclusive'
          if (mode === 'shared') this.shared += 1
          else this.exclusive = true
          this.recordAcquisition(mode)
          void Promise.resolve(callback(null))
            .then(resolve, reject)
            .finally(() => {
              if (mode === 'shared') this.shared -= 1
              else this.exclusive = false
              this.drain()
            })
        },
      })
      this.drain()
    })
  }

  private drain(): void {
    if (this.exclusive || this.queue.length === 0) return
    const next = this.queue[0]
    if (!next) return
    if (next.mode === 'exclusive') {
      if (this.shared !== 0) return
      this.queue.shift()?.run()
      return
    }
    while (this.queue[0]?.mode === 'shared') this.queue.shift()?.run()
  }

  private recordAcquisition(mode: LockMode): void {
    this.acquisitionCounts.set(mode, (this.acquisitionCounts.get(mode) ?? 0) + 1)
    for (let index = this.acquisitionWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.acquisitionWaiters[index]
      if (
        !waiter ||
        waiter.mode !== mode ||
        (this.acquisitionCounts.get(mode) ?? 0) < waiter.count
      ) {
        continue
      }
      this.acquisitionWaiters.splice(index, 1)
      waiter.resolve()
    }
  }
}

async function withWorkspaceGateLocks<T>(
  run: (manager: WorkspaceGateLockManager) => Promise<T>,
): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(navigator, 'locks')
  const manager = new WorkspaceGateLockManager()
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: manager,
  })
  __resetLockTrackerForTests()
  try {
    return await run(manager)
  } finally {
    __resetLockTrackerForTests()
    if (original) Object.defineProperty(navigator, 'locks', original)
    else Reflect.deleteProperty(navigator, 'locks')
  }
}

beforeEach(async () => {
  await reset()
  await openDb()
})

afterEach(reset)

describe('authoritative temporary chat lifecycle', () => {
  it('creates a chat with one workspace mutation and one accurate event', async () => {
    const repo = getBrowserRepository()
    const before = await repo.getWorkspaceMeta()
    const seen: BroadcastEvent[] = []
    const unsubscribe = onEvent((event) => seen.push(event))

    const chat = await createChat({ id: 'temporary-create', temporary: true, now: 100 })

    unsubscribe()
    expect(await getDb().chats.get(chat.id)).toEqual(chat)
    expect((await repo.getWorkspaceMeta()).mutationCounter).toBe(before.mutationCounter + 1)
    expect(seen).toEqual([
      {
        kind: 'chat-mutated',
        chatId: chat.id,
        metaVersion: 0,
        summaryVersion: 0,
        affected: [{ kind: 'chat-meta', chatId: chat.id }],
      },
    ])
  })

  it('does not discard a chat that was made permanent before cleanup starts', async () => {
    const chat = await createChat({ temporary: true })

    await markChatPermanent(chat.id)
    const deleted = await discardEmptyDraftChats({ chatIds: [chat.id] })

    expect(deleted).toEqual([])
    expect(await getDb().chats.get(chat.id)).toMatchObject({ temporary: false })
  })

  it('uses the zero-word index for global cleanup without scanning every chat row', async () => {
    const temporary = await createChat({ id: 'temporary-indexed', temporary: true })
    const permanent = await createChat({ id: 'permanent-zero-word', temporary: true })
    const populated = await createChat({ id: 'populated-not-a-candidate', temporary: true })
    await markChatPermanent(permanent.id)
    await markChatPermanent(populated.id)
    const populatedRow = await getDb().chats.get(populated.id)
    if (!populatedRow) throw new Error('expected populated chat')
    await getDb().chats.update(populated.id, {
      wordCount: 10,
      settings: {
        ...populatedRow.settings,
        systemPrompt: 'body-poison'.repeat(10_000),
      },
    })
    const readChat = vi.fn((row: Chat) => row)
    getDb().chats.hook.reading.subscribe(readChat)

    const deleted = await discardEmptyDraftChats()
    getDb().chats.hook.reading.unsubscribe(readChat)

    expect(deleted).toEqual([temporary.id])
    expect(await getDb().chats.get(permanent.id)).toBeDefined()
    expect(await getDb().chats.get(populated.id)).toBeDefined()
    expect(readChat.mock.calls.map(([row]) => row.id)).not.toContain(populated.id)
  })

  it('keeps the chat when mark-permanent enters the workspace gate first', async () => {
    const chat = await createChat({ temporary: true })

    const [, deleted] = await withWorkspaceGateLocks(async (manager) => {
      const mark = markChatPermanent(chat.id)
      await manager.waitForAcquisition('shared')
      return Promise.all([mark, discardEmptyDraftChats({ chatIds: [chat.id] })])
    })

    expect(deleted).toEqual([])
    expect(await getDb().chats.get(chat.id)).toMatchObject({ temporary: false })
  })

  it('treats a serialized cleanup win as an idempotent mark-permanent result', async () => {
    const chat = await createChat({ temporary: true })

    const [deleted] = await withWorkspaceGateLocks(async (manager) => {
      const discard = discardEmptyDraftChats({ chatIds: [chat.id] })
      await manager.waitForAcquisition('exclusive')
      return Promise.all([discard, markChatPermanent(chat.id)])
    })

    expect(deleted).toEqual([chat.id])
    expect(await getDb().chats.get(chat.id)).toBeUndefined()
  })

  it('waits for an in-flight draft mutation before deciding whether to discard', async () => {
    const chat = await createChat({ temporary: true })
    const repo = getBrowserRepository()

    const [, deleted] = await withWorkspaceGateLocks(async (manager) => {
      const draftMutation = repo.runMutation([{ kind: 'draft', chatId: chat.id }], async (ctx) => {
        await ctx.putDraft({
          chatId: chat.id,
          text: 'keep this draft',
          attachmentRefs: [],
          updatedAt: 200,
        })
      })
      await manager.waitForAcquisition('shared')
      return Promise.all([draftMutation, discardEmptyDraftChats({ chatIds: [chat.id] })])
    })

    expect(deleted).toEqual([])
    expect(await getDb().chats.get(chat.id)).toBeDefined()
    expect(await getDb().drafts.get(chat.id)).toMatchObject({ text: 'keep this draft' })
  })

  it('keeps an empty temporary chat once another tab has admitted a stream lease', async () => {
    const chat = await createChat({ temporary: true })
    const repo = getBrowserRepository()

    const [, deleted] = await withWorkspaceGateLocks(async (manager) => {
      const lease = repo.upsertStreamLease({
        streamId: 'message-less-stream',
        chatId: chat.id,
        ownerClientId: 'other-tab',
        startedAt: 100,
        heartbeatAt: 100,
      })
      await manager.waitForAcquisition('shared')
      return Promise.all([lease, discardEmptyDraftChats({ chatIds: [chat.id] })])
    })

    expect(deleted).toEqual([])
    expect(await getDb().chats.get(chat.id)).toBeDefined()
    const persistedLease = await getDb().streamLeases.get('message-less-stream')
    expect(persistedLease).toMatchObject({ chatId: chat.id })
    expect(persistedLease).not.toHaveProperty('messageId')
  })

  it('serializes duplicate discard attempts and emits deletion once', async () => {
    const chat = await createChat({ temporary: true })
    const seen: BroadcastEvent[] = []
    const unsubscribe = onEvent((event) => seen.push(event))

    const results = await Promise.all([
      discardEmptyDraftChats({ chatIds: [chat.id] }),
      discardEmptyDraftChats({ chatIds: [chat.id] }),
    ])

    unsubscribe()
    expect(results.flat()).toEqual([chat.id])
    expect(seen.filter((event) => event.kind === 'chat-deleted')).toEqual([
      { kind: 'chat-deleted', chatId: chat.id },
    ])
  })

  it('rolls back every owned row, workspace version, and event when deletion fails', async () => {
    const chat = await createChat({ id: 'temporary-rollback', temporary: true, now: 100 })
    const db = getDb()
    await db.drafts.put({ chatId: chat.id, text: '', attachmentRefs: [], updatedAt: 100 })
    await db.childLists.put({
      id: `${chat.id}:__root__`,
      chatId: chat.id,
      parentId: null,
      version: 0,
      updatedAt: 100,
    })
    await db.streamChunks.put({
      id: 'orphan-stream:0',
      streamId: 'orphan-stream',
      chatId: chat.id,
      messageId: 'missing-message',
      seq: 0,
      createdAt: 100,
      event: { lane: 'text', text: 'recoverable' },
    })
    const repo = getBrowserRepository()
    const beforeWorkspace = await repo.getWorkspaceMeta()
    const before = {
      chat: await db.chats.get(chat.id),
      draft: await db.drafts.get(chat.id),
      childLists: await db.childLists.toArray(),
      leases: await db.streamLeases.toArray(),
      chunks: await db.streamChunks.toArray(),
    }
    const seen: BroadcastEvent[] = []
    const unsubscribe = onEvent((event) => seen.push(event))
    const failDelete = () => {
      throw new Error('injected chat deletion failure')
    }
    db.chats.hook.deleting.subscribe(failDelete)

    await expect(discardEmptyDraftChats({ chatIds: [chat.id] })).rejects.toThrow(
      'injected chat deletion failure',
    )

    db.chats.hook.deleting.unsubscribe(failDelete)
    unsubscribe()
    expect({
      chat: await db.chats.get(chat.id),
      draft: await db.drafts.get(chat.id),
      childLists: await db.childLists.toArray(),
      leases: await db.streamLeases.toArray(),
      chunks: await db.streamChunks.toArray(),
    }).toEqual(before)
    expect((await repo.getWorkspaceMeta()).mutationCounter).toBe(beforeWorkspace.mutationCounter)
    expect(seen).toEqual([])
  })
})
