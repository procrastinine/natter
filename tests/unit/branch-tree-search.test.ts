import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Message } from '../../src/core/types'
import {
  __resetBrowserRepositoryForTests,
  getBrowserRepository,
} from '../../src/store/browser-repo'
import { __resetDbForTests, getDb, openDb } from '../../src/store/db'
import { splitMessageForStorage } from '../../src/store/message-storage'

function message(id: string, text: string, overrides: Partial<Message> = {}): Message {
  return {
    id,
    chatId: 'tree-search-chat',
    parentId: null,
    siblingIndex: 0,
    turnId: `turn-${id}`,
    turnIndex: 0,
    createdAt: 1,
    role: 'user',
    origin: 'user',
    content: [{ type: 'text', text }],
    nodeVersion: 0,
    deleted: false,
    ...overrides,
  }
}

async function putMessage(row: Message): Promise<void> {
  const stored = splitMessageForStorage(row)
  await getDb().messages.put(stored.header)
  await getDb().messageBodies.put(stored.body)
}

async function resetAll(): Promise<void> {
  __resetBrowserRepositoryForTests()
  __resetDbForTests()
  await Dexie.delete('natter')
}

beforeEach(async () => {
  await resetAll()
  await openDb()
})

afterEach(resetAll)

describe('branch-tree text reads', () => {
  it('returns every live matching node in only the requested chat', async () => {
    await putMessage(message('first', 'Alpha NEEDLE'))
    await putMessage(
      message('second', '', {
        content: [
          { type: 'text', text: 'needle' },
          { type: 'output_text', text: 'across items' },
        ],
      }),
    )
    await putMessage(message('deleted', 'needle', { deleted: true }))
    await putMessage(message('other-chat', 'needle', { chatId: 'other' }))

    await expect(
      getBrowserRepository().searchChatMessageText('tree-search-chat', 'NeEdLe'),
    ).resolves.toEqual(expect.arrayContaining(['first', 'second']))
    expect(
      await getBrowserRepository().searchChatMessageText('tree-search-chat', 'NeEdLe'),
    ).toHaveLength(2)
  })

  it('returns a bounded plaintext preview without hydrating the full message', async () => {
    await putMessage(message('long', `  ${'word '.repeat(500)}`))
    const preview = await getBrowserRepository().getMessageTextPreview('long')
    expect(preview?.length).toBeLessThanOrEqual(240)
    expect(preview?.endsWith('…')).toBe(true)
    const richerPreview = await getBrowserRepository().getMessageTextPreview('long', {
      maxChars: 960,
    })
    expect(richerPreview?.length).toBe(960)
    expect(richerPreview?.endsWith('…')).toBe(true)
  })

  it('rejects an already-cancelled preview read', async () => {
    await putMessage(message('preview-cancelled', 'preview'))
    const controller = new AbortController()
    controller.abort()
    await expect(
      getBrowserRepository().getMessageTextPreview('preview-cancelled', {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('rejects an already-cancelled search before retaining results', async () => {
    await putMessage(message('match', 'needle'))
    const controller = new AbortController()
    controller.abort()
    await expect(
      getBrowserRepository().searchChatMessageText('tree-search-chat', 'needle', {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})
