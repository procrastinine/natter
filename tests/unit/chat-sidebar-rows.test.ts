import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import { getBrowserRepository } from '../../src/store/browser-repo'
import { CHAT_SIDEBAR_PROJECTION_MANIFEST_KEY } from '../../src/store/chat-sidebar-projection'
import { createChat, listChatSidebarRows, projectChatSidebarRow } from '../../src/store/chats'
import { __resetDbForTests, getDb, openDb } from '../../src/store/db'

const DB_NAME = 'natter'

async function resetAll() {
  __resetBroadcastForTests()
  __resetDbForTests()
  vi.restoreAllMocks()
  await Dexie.delete(DB_NAME)
}

beforeEach(async () => {
  await resetAll()
  await openDb()
})

afterEach(async () => {
  await resetAll()
})

describe('chat sidebar read model', () => {
  it('projects only sidebar metadata and drops heavyweight chat fields', async () => {
    const chat = await createChat({
      title: 'Projection',
      settings: cloneDefaultChatSettings(),
      now: 10,
    })
    await getBrowserRepository().runMutation(
      [{ kind: 'chat-meta', chatId: chat.id }],
      async (ctx) => {
        ctx.patchChatMeta(chat.id, {
          titleStatus: 'manual',
          previewText: 'short preview',
          folderId: 'folder-1',
          tags: ['tag-1', 'tag-2'],
          settings: { ...chat.settings, systemPrompt: 'x'.repeat(100_000) },
          tokenCalibration: {
            huge: {
              totalTextChars: 1,
              totalTextTokens: 1,
              sampleCount: 1,
              updatedAt: 1,
            },
          },
          favoriteModels: ['model/'.repeat(20_000)],
          recentModels: ['recent/'.repeat(20_000)],
        })
      },
    )

    const rows = await listChatSidebarRows()

    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual(
      expect.objectContaining({
        id: chat.id,
        title: 'Projection',
        previewText: 'short preview',
        folderId: 'folder-1',
        tags: ['tag-1', 'tag-2'],
      }),
    )
    expect('settings' in (rows[0] as Record<string, unknown>)).toBe(false)
    expect('tokenCalibration' in (rows[0] as Record<string, unknown>)).toBe(false)
    expect('favoriteModels' in (rows[0] as Record<string, unknown>)).toBe(false)
    expect('recentModels' in (rows[0] as Record<string, unknown>)).toBe(false)
  })

  it('supports a recent-chat window for future paged sidebars', async () => {
    for (let i = 0; i < 5; i += 1) {
      await createChat({
        id: `chat-${i}`,
        title: `Chat ${i}`,
        settings: cloneDefaultChatSettings(),
        now: i,
      })
    }

    const rows = await listChatSidebarRows({
      orderBy: 'updatedAt',
      direction: 'desc',
      offset: 1,
      limit: 2,
    })

    expect(rows.map((row) => row.id)).toEqual(['chat-3', 'chat-2'])
  })

  it('clones tag arrays during projection', async () => {
    const chat = await createChat({
      title: 'Clone tags',
      settings: cloneDefaultChatSettings(),
      now: 1,
    })
    await getDb().chats.put({ ...chat, tags: ['tag-a'] })

    const row = projectChatSidebarRow((await getDb().chats.get(chat.id)) ?? chat)
    row.tags.push('mutated')

    expect((await getDb().chats.get(chat.id))?.tags).toEqual(['tag-a'])
  })

  it('rebuilds instead of returning a partial sidebar when a derived row is missing', async () => {
    await createChat({ id: 'kept-a', title: 'A', now: 1 })
    await createChat({ id: 'kept-b', title: 'B', now: 2 })
    await getDb().chatSidebarRows.delete('kept-a')

    const rows = await listChatSidebarRows()

    expect(rows.map((row) => row.id).sort()).toEqual(['kept-a', 'kept-b'])
    expect(await getDb().chatSidebarRows.get('kept-a')).toBeDefined()
  })

  it('repairs a checksum-drifted derived row from the authoritative chat', async () => {
    const chat = await createChat({ id: 'drifted', title: 'Authoritative', now: 1 })
    const row = await getDb().chatSidebarRows.get(chat.id)
    if (!row) throw new Error('expected sidebar projection')
    await getDb().chatSidebarRows.put({ ...row, title: 'Corrupt projection' })

    const rows = await listChatSidebarRows()

    expect(rows).toHaveLength(1)
    expect(rows[0]?.title).toBe('Authoritative')
  })

  it('repairs an invalid projection without a deferred transaction', async () => {
    await createChat({ id: 'live-repair', title: 'Live repair', now: 1 })
    await getDb().chatSidebarRows.delete('live-repair')

    const rows = await listChatSidebarRows()

    expect(rows.map((row) => row.id)).toEqual(['live-repair'])
  })

  it('rolls back a source insert when projection maintenance cannot update its manifest', async () => {
    await getDb().settings.delete(CHAT_SIDEBAR_PROJECTION_MANIFEST_KEY)

    await expect(createChat({ id: 'must-roll-back', title: 'Rollback', now: 1 })).rejects.toThrow(
      'ChatSidebarProjectionManifestMissing',
    )

    expect(await getDb().chats.get('must-roll-back')).toBeUndefined()
    expect(await getDb().chatSidebarRows.get('must-roll-back')).toBeUndefined()
  })
})
