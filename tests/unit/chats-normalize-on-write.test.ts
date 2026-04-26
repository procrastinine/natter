import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type { ChatSettings } from '../../src/core/types'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import { createChat, getChat, touchLastViewed, updateChatSettings } from '../../src/store/chats'
import { __resetDbForTests, openDb } from '../../src/store/db'
import type { WorkspaceRepository } from '../../src/store/repository'
import {
  __resetWorkspaceRepositoryForTests,
  __setWorkspaceRepositoryForTests,
} from '../../src/store/workspace-repository'

const DB_NAME = 'natter'

async function resetAll() {
  __resetBroadcastForTests()
  __resetDbForTests()
  __resetWorkspaceRepositoryForTests()
  await Dexie.delete(DB_NAME)
}

beforeEach(async () => {
  ;(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory()
  await resetAll()
  await openDb()
})

afterEach(async () => {
  await resetAll()
})

describe('createChat / updateChatSettings — reasoning normalization', () => {
  it('applies stable organization defaults to new chats', async () => {
    const chat = await createChat({ title: 'New chat', now: 123 })
    expect(chat).toMatchObject({
      title: 'New chat',
      titleStatus: 'untitled',
      createdAt: 123,
      updatedAt: 123,
      lastViewedAt: 123,
      wordCount: 0,
      totalCostUsd: 0,
      lastUpdatedLeafId: null,
      lastBranchUpdatedAt: 123,
      archived: false,
      pinned: false,
      folderId: null,
      tags: [],
    })
  })

  it('heals a chat created with reasoning.include missing', async () => {
    // Simulate a caller (older code path / corrupt sessionStorage seed)
    // handing settings without `include`.
    const malformed = cloneDefaultChatSettings()
    delete (malformed.reasoning as Partial<ChatSettings['reasoning']>).include
    const chat = await createChat({ settings: malformed })
    expect(chat.settings.reasoning.include).toEqual({
      encrypted: true,
      summary: false,
      text: false,
    })
    const reread = await getChat(chat.id)
    expect(reread?.settings.reasoning.include).toBeDefined()
  })

  it("backfills include when an updateChatSettings patch carries a reasoning object that doesn't have it", async () => {
    const chat = await createChat()
    // A caller updates only `mode` via the full reasoning object — common
    // pattern when copy-pasting settings between chats. The reasoning slot
    // gets replaced wholesale; without normalization the include block
    // would vanish.
    await updateChatSettings(chat.id, {
      reasoning: {
        mode: 'effort',
        effort: 'high',
        exclude: false,
        summary: 'auto',
      } as ChatSettings['reasoning'],
    })
    const updated = await getChat(chat.id)
    expect(updated?.settings.reasoning.include).toEqual({
      encrypted: true,
      summary: false,
      text: false,
    })
    expect(updated?.settings.reasoning.mode).toBe('effort')
    expect(updated?.settings.reasoning.effort).toBe('high')
  })

  it('routes last-viewed writes through the workspace repository abstraction', async () => {
    const patched: Array<{
      chatId: string
      patch: unknown
      options: unknown
    }> = []
    const runMutation = vi.fn(
      async (_scopes: unknown, fn: (ctx: never) => Promise<void> | void) => {
        await fn({
          getChat: async () => ({ id: 'chat-1', lastViewedAt: 1 }),
          patchChatMeta: (chatId: string, patch: unknown, options: unknown) => {
            patched.push({ chatId, patch, options })
          },
        } as never)
        return {
          value: undefined,
          affectedChatIds: [],
          affectedMessageIds: [],
          chatVersions: {},
        }
      },
    )
    const repo = { runMutation } as unknown as WorkspaceRepository
    __setWorkspaceRepositoryForTests(repo)

    await touchLastViewed('chat-1', 50)

    expect(runMutation).toHaveBeenCalledWith(
      [{ kind: 'chat-meta', chatId: 'chat-1' }],
      expect.any(Function),
    )
    expect(patched).toEqual([
      {
        chatId: 'chat-1',
        patch: { lastViewedAt: 50 },
        options: { touchVisibleState: false, broadcast: false },
      },
    ])
  })
})
