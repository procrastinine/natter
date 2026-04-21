import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type { ChatSettings } from '../../src/core/types'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import { createChat, getChat, updateChatSettings } from '../../src/store/chats'
import { __resetDbForTests, openDb } from '../../src/store/db'

const DB_NAME = 'natter'

async function resetAll() {
  __resetBroadcastForTests()
  __resetDbForTests()
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
})
