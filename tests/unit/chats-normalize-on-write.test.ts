import { createChat } from '../helpers/chats'
import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type { ChatSettings } from '../../src/core/types'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import {
  openBrowserWorkspace,
  shutdownBrowserWorkspace,
} from '../../src/store/browser-workspace-lifecycle'
import { getChat, touchLastViewed } from '../../src/store/chats'
import { configurationApplication } from '../../src/store/configuration-application'
import { __resetDbForTests } from '../../src/store/db'
import {
  subscribeWorkspaceEffects,
  WORKSPACE_EFFECT_RECOVERY_OWNED,
  type WorkspaceEffect,
} from '../../src/store/workspace-effect-hub'
import { __resetWorkspaceRepositoryForTests } from '../../src/store/workspace-repository'

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
  await openBrowserWorkspace()
})

afterEach(async () => {
  await shutdownBrowserWorkspace()
  await resetAll()
})

describe('chat configuration reasoning normalization', () => {
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

  it("backfills include when a settings patch carries a reasoning object that doesn't have it", async () => {
    const chat = await createChat()
    // A caller updates only `mode` via the full reasoning object — common
    // pattern when copy-pasting settings between chats. The reasoning slot
    // gets replaced wholesale; without normalization the include block
    // would vanish.
    await configurationApplication.patchChatSettings(chat.id, {
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

  it('publishes last-viewed writes through the workspace repository effect boundary', async () => {
    const chat = await createChat({ id: 'chat-1', now: 1 })
    const effects: WorkspaceEffect[] = []
    const unsubscribe = subscribeWorkspaceEffects({
      owner: 'chat-viewed-write-test',
      sources: ['local'],
      factKinds: ['sidebar-row-changed'],
      replacements: false,
      apply: (effect) => effects.push(effect),
      recover: () => WORKSPACE_EFFECT_RECOVERY_OWNED,
    })

    await touchLastViewed('chat-1', 50)

    expect(effects).toHaveLength(1)
    expect(effects[0]).toMatchObject({
      kind: 'changed',
      source: 'local',
      cause: 'commit',
      facts: [{ kind: 'sidebar-row-changed', chatId: chat.id, facets: ['last-viewed'] }],
    })
    expect((await getChat(chat.id))?.lastViewedAt).toBe(50)
    unsubscribe()
  })
})
