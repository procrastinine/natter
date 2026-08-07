import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import {
  compareSidebarChatRows,
  SIDEBAR_SORT_OPTIONS,
  sidebarSortDirection,
  sidebarSortField,
  sidebarTitleSortKey,
} from '../../src/core/sidebar-sort'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import {
  readFolderCatalogPage,
  readSidebarPresentationPage,
  readTagCatalogPage,
} from '../../src/store/browser-catalog-queries'
import { __resetBrowserRepositoryForTests } from '../../src/store/browser-repo'
import {
  openBrowserWorkspace,
  shutdownBrowserWorkspace,
} from '../../src/store/browser-workspace-lifecycle'
import {
  CHAT_SIDEBAR_PROJECTION_LEGACY_MANIFEST_KEY,
  projectChatSidebarRow,
  rebuildChatSidebarProjectionRowsInTransaction,
} from '../../src/store/chat-sidebar-projection'
import { buildChat } from '../../src/store/chats'
import { __resetDbForTests, getDb } from '../../src/store/db'
import { createFolder } from '../../src/store/folders'
import type {
  ChatSidebarCatalogRequest,
  SidebarPresentationPage,
  SidebarPresentationRequest,
} from '../../src/store/repository'
import { createSidebarSessionController } from '../../src/store/sidebar-session'
import {
  __resetWorkspaceRepositoryForTests,
  getWorkspaceRepository,
} from '../../src/store/workspace-repository'
import { runWorkspaceRead } from '../../src/store/workspace-runtime'
import { workspaceUsableSurfaceSettlementPort } from '../../src/store/workspace-runtime-control'
import { createChat, putTestChats } from '../helpers/chats'

const DB_NAME = 'natter'

async function rebuildChatSidebarProjection(): Promise<void> {
  const db = getDb()
  await db.transaction(
    'rw',
    [db.chats, db.folders, db.chatSidebarRows, db.chatSidebarAggregates],
    (tx) => rebuildChatSidebarProjectionRowsInTransaction(tx),
  )
}

async function readSidebarPage(request: ChatSidebarCatalogRequest = {}) {
  return runWorkspaceRead('repository-query', (permit) =>
    getWorkspaceRepository()
      .query(permit, { kind: 'sidebar.catalog-page', request }, { signal: permit.signal })
      .then((envelope) => envelope.value),
  )
}

async function readPresentationPage(
  request: SidebarPresentationRequest,
): Promise<SidebarPresentationPage> {
  return runWorkspaceRead('repository-query', (permit) =>
    getWorkspaceRepository()
      .query(permit, { kind: 'sidebar.presentation-page', request }, { signal: permit.signal })
      .then((envelope) => envelope.value),
  )
}

async function resetAll() {
  __resetWorkspaceRepositoryForTests()
  __resetBrowserRepositoryForTests()
  __resetBroadcastForTests()
  __resetDbForTests()
  vi.restoreAllMocks()
  await Dexie.delete(DB_NAME)
}

beforeEach(async () => {
  await resetAll()
  await openBrowserWorkspace()
})

afterEach(async () => {
  await shutdownBrowserWorkspace()
  await resetAll()
})

describe('chat sidebar read model', () => {
  it('demand-pages large folder and tag catalogs without reducing capability', async () => {
    const cardinality = 1_000
    const folders = Array.from({ length: cardinality }, (_, index) => ({
      id: `folder-${String(index).padStart(4, '0')}`,
      name: `Folder ${String(cardinality - index).padStart(4, '0')}`,
      sortIndex: index % 17,
      createdAt: index,
      updatedAt: index,
    }))
    const tags = Array.from({ length: cardinality }, (_, index) => ({
      id: `tag-${String(index).padStart(4, '0')}`,
      name: `Tag ${String(cardinality - index).padStart(4, '0')}`,
      nameLower: `tag ${String(cardinality - index).padStart(4, '0')}`,
      createdAt: index,
      updatedAt: index,
    }))
    const db = getDb()
    await db.folders.bulkPut(folders)
    await db.tags.bulkPut(tags)
    await rebuildChatSidebarProjection()

    const firstFolders = await readFolderCatalogPage(db, { limit: 17 })
    const firstTags = await readTagCatalogPage(db, { limit: 17 })
    expect(firstFolders.rows).toHaveLength(17)
    expect(firstTags.rows).toHaveLength(17)
    expect(firstFolders.nextCursor).toBeTypeOf('string')
    expect(firstTags.nextCursor).toBeTypeOf('string')

    const seenFolders = [...firstFolders.rows]
    let folderCursor = firstFolders.nextCursor
    while (folderCursor) {
      const page = await readFolderCatalogPage(db, { cursor: folderCursor, limit: 17 })
      seenFolders.push(...page.rows)
      folderCursor = page.nextCursor
    }
    const seenTags = [...firstTags.rows]
    let tagCursor = firstTags.nextCursor
    while (tagCursor) {
      const page = await readTagCatalogPage(db, { cursor: tagCursor, limit: 17 })
      seenTags.push(...page.rows)
      tagCursor = page.nextCursor
    }

    expect(new Set(seenFolders.map((folder) => folder.id)).size).toBe(cardinality)
    expect(new Set(seenTags.map((tag) => tag.id)).size).toBe(cardinality)
    expect(seenFolders).toEqual(
      [...folders].sort(
        (left, right) =>
          left.sortIndex - right.sortIndex ||
          sidebarTitleSortKey(left.name).localeCompare(sidebarTitleSortKey(right.name)) ||
          left.id.localeCompare(right.id),
      ),
    )
    expect(seenTags.map((tag) => tag.nameLower)).toEqual(tags.map((tag) => tag.nameLower).sort())
  })

  it('projects only sidebar metadata and drops heavyweight chat fields', async () => {
    await createFolder({ id: 'folder-1', name: 'Folder 1', now: 1 })
    const chat = await createChat({
      title: 'Projection',
      settings: cloneDefaultChatSettings(),
      now: 10,
    })
    const heavyweightChat = {
      ...chat,
      titleStatus: 'manual' as const,
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
    }
    await getDb().chats.put(heavyweightChat)
    await rebuildChatSidebarProjection()

    const rows = (await readSidebarPage({ archived: 'include', limit: 500 })).rows

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

  it('supports a stable keyset window for the sidebar session', async () => {
    for (let i = 0; i < 5; i += 1) {
      await createChat({
        id: `chat-${i}`,
        title: `Chat ${i}`,
        settings: cloneDefaultChatSettings(),
        now: i,
      })
    }

    const first = await readSidebarPage({
      orderBy: 'updatedAt',
      direction: 'desc',
      limit: 1,
    })
    if (!first.nextCursor) throw new Error('expected next sidebar cursor')
    const rows = (
      await readSidebarPage({
        orderBy: 'updatedAt',
        direction: 'desc',
        cursor: first.nextCursor,
        limit: 2,
      })
    ).rows

    expect(rows.map((row) => row.id)).toEqual(['chat-3', 'chat-2'])
  })

  it('uses archive-prefixed keysets and aggregate counts instead of whole-table filtering', async () => {
    const active = await createChat({ id: 'active', title: 'Active', now: 30 })
    const archivedNewest = await createChat({ id: 'archived-new', title: 'New', now: 20 })
    const archivedOldest = await createChat({ id: 'archived-old', title: 'Old', now: 10 })
    const db = getDb()
    await db.chats.bulkPut([
      { ...active, previewText: 'Active preview' },
      { ...archivedNewest, archived: true, previewText: 'New preview' },
      { ...archivedOldest, archived: true, previewText: 'Old preview' },
    ])
    await rebuildChatSidebarProjection()
    const whereSpy = vi.spyOn(db.chatSidebarRows, 'where')
    const filterSpy = vi.spyOn(db.chatSidebarRows, 'filter')

    const first = await readSidebarPage({
      archived: 'only',
      orderBy: 'updatedAt',
      direction: 'desc',
      limit: 1,
    })
    expect(first.rows.map((row) => row.id)).toEqual(['archived-new'])
    if (!first.nextCursor) throw new Error('expected next archive cursor')
    expect(
      whereSpy.mock.calls.some(
        ([index]) =>
          typeof index === 'string' && index === '[archivedKey+updatedAt+titleSortKey+id]',
      ),
    ).toBe(true)

    const second = await readSidebarPage({
      archived: 'only',
      orderBy: 'updatedAt',
      direction: 'desc',
      cursor: first.nextCursor,
      limit: 1,
      countMode: 'omit',
    })
    expect(second.rows.map((row) => row.id)).toEqual(['archived-old'])
    if (!second.previousCursor) throw new Error('expected previous archive cursor')

    const previous = await readSidebarPage({
      archived: 'only',
      orderBy: 'updatedAt',
      direction: 'desc',
      cursor: second.previousCursor,
      pageDirection: 'backward',
      limit: 1,
      countMode: 'omit',
    })
    expect(previous.rows.map((row) => row.id)).toEqual(['archived-new'])

    await readSidebarPage({
      archived: 'exclude',
      excludeEmptyDrafts: true,
      orderBy: 'updatedAt',
      direction: 'desc',
      limit: 1,
    })
    expect(filterSpy).not.toHaveBeenCalled()
  })

  it('pages the canonical tuple without gaps in every sort and archive mode', async () => {
    const chats = Array.from({ length: 9 }, (_, index) => ({
      ...buildChat({
        id: `catalog-${index}`,
        title: index % 3 === 0 ? 'Same' : index % 3 === 1 ? 'topic 10' : 'Topic 2',
        now: 20 + (index % 3),
      }),
      titleStatus: 'manual' as const,
      createdAt: 10 + (index % 2),
      lastViewedAt: 30 + (index % 4),
      totalCostUsd: index % 2,
      wordCount: index % 3,
      archived: index % 3 === 0,
      pinned: index % 4 === 0,
      previewText: `Preview ${index}`,
    }))
    await putTestChats(chats)

    for (const { mode } of SIDEBAR_SORT_OPTIONS) {
      for (const archived of ['exclude', 'only', 'include'] as const) {
        const actual = []
        let cursor: string | undefined
        do {
          const page = await readSidebarPage({
            archived,
            orderBy: sidebarSortField(mode),
            direction: sidebarSortDirection(mode),
            limit: 2,
            countMode: cursor ? 'omit' : 'exact',
            ...(cursor ? { cursor } : {}),
          })
          actual.push(...page.rows)
          cursor = page.nextCursor
        } while (cursor)

        const expected = chats
          .filter((chat) =>
            archived === 'include' ? true : archived === 'only' ? chat.archived : !chat.archived,
          )
          .sort((left, right) => compareSidebarChatRows(left, right, mode, false))
          .map((chat) => chat.id)
        expect(
          actual.map((chat) => chat.id),
          `${mode}:${archived}`,
        ).toEqual(expected)
        expect(new Set(actual.map((chat) => chat.id)).size, `${mode}:${archived}`).toBe(
          expected.length,
        )
      }
    }
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

  it('rebuilds a stale projection through its derived-state owner and keeps reads projected', async () => {
    await createChat({ id: 'kept-a', title: 'A', now: 1 })
    await createChat({ id: 'kept-b', title: 'B', now: 2 })
    await getDb().chatSidebarRows.delete('kept-a')

    await rebuildChatSidebarProjection()

    const chatCount = vi.spyOn(getDb().chats, 'count')
    const rows = (await readSidebarPage({ archived: 'include', limit: 500 })).rows

    expect(rows.map((row) => row.id).sort()).toEqual(['kept-a', 'kept-b'])
    expect(await getDb().chatSidebarRows.get('kept-a')).toBeDefined()
    expect(chatCount).not.toHaveBeenCalled()
  })

  it('does not make current writes depend on the retired legacy projection manifest', async () => {
    await getDb().settings.delete(CHAT_SIDEBAR_PROJECTION_LEGACY_MANIFEST_KEY)

    await expect(
      createChat({ id: 'current-write', title: 'Current projection', now: 1 }),
    ).resolves.toMatchObject({ id: 'current-write' })

    expect(await getDb().chats.get('current-write')).toBeDefined()
    expect(await getDb().chatSidebarRows.get('current-write')).toMatchObject({
      id: 'current-write',
      title: 'Current projection',
    })
  })

  it('pages the pinned bucket before newer unpinned chats', async () => {
    const pinned = await createChat({ id: 'pinned-old', title: 'Pinned', now: 1 })
    const unpinned = await createChat({ id: 'unpinned-new', title: 'Unpinned', now: 100 })
    await getDb().chats.bulkPut([
      { ...pinned, pinned: true, previewText: 'Pinned preview' },
      { ...unpinned, previewText: 'Unpinned preview' },
    ])
    await rebuildChatSidebarProjection()

    const first = await readSidebarPage({
      orderBy: 'updatedAt',
      direction: 'desc',
      pinnedFirst: true,
      excludeEmptyDrafts: true,
      limit: 1,
    })
    expect(first.exactCount).toBe(2)
    expect(first.rows.map((row) => row.id)).toEqual(['pinned-old'])
    if (!first.nextCursor) throw new Error('expected pinned bucket cursor')

    const second = await readSidebarPage({
      orderBy: 'updatedAt',
      direction: 'desc',
      pinnedFirst: true,
      excludeEmptyDrafts: true,
      cursor: first.nextCursor,
      limit: 1,
    })
    expect(second.rows.map((row) => row.id)).toEqual(['unpinned-new'])
  })

  it('pages one complete expanded folder before later root rows without retaining the catalog', async () => {
    await createFolder({ id: 'large-folder', name: 'Large folder', now: 2_000 })
    await createFolder({ id: 'empty-folder', name: 'Empty folder', now: 1 })
    const children = Array.from({ length: 513 }, (_, index) => ({
      ...buildChat({
        id: `folder-chat-${index.toString().padStart(4, '0')}`,
        title: `Folder chat ${index.toString().padStart(4, '0')}`,
        now: 1_000 + index,
      }),
      titleStatus: 'manual' as const,
      folderId: 'large-folder',
      previewText: `Preview ${index}`,
    }))
    const newerRoot = {
      ...buildChat({ id: 'newer-root-chat', title: 'Newer root chat', now: 1_500 }),
      titleStatus: 'manual' as const,
      previewText: 'Newer root preview',
    }
    const root = {
      ...buildChat({ id: 'root-chat', title: 'Root chat', now: 1_499 }),
      titleStatus: 'manual' as const,
      previewText: 'Root preview',
    }
    await putTestChats([...children, newerRoot, root])

    const request = {
      mode: 'expanded' as const,
      sort: 'updatedAt-desc' as const,
      collapsedFolderIds: [],
      createdAtGroupBoundaries: [2_000, 1_900, 1_500, 1_000] as const,
      limit: 24,
    }
    const rows: SidebarPresentationPage['rows'][number][] = []
    const measurements: SidebarPresentationPage['measurement'][] = []
    const physicalPageSizes: number[] = []
    let cursor: string | undefined
    do {
      const page = await readPresentationPage({
        ...request,
        ...(cursor ? { cursor } : {}),
        countMode: cursor ? 'omit' : 'exact',
      })
      rows.push(...page.rows)
      measurements.push(page.measurement)
      physicalPageSizes.push(page.rows.length)
      cursor = page.nextCursor
    } while (cursor)

    const keys = rows.map((row) => row.key)
    const folderHeader = keys.indexOf('entry:folder:large-folder')
    const firstChild = keys.indexOf('entry:folder:large-folder:chat:folder-chat-0512')
    const lastChild = keys.indexOf('entry:folder:large-folder:chat:folder-chat-0000')
    const newerRootIndex = keys.indexOf('entry:chat:newer-root-chat')
    const rootIndex = keys.indexOf('entry:chat:root-chat')
    expect(new Set(keys).size).toBe(keys.length)
    expect(physicalPageSizes.every((size) => size > 0)).toBe(true)
    expect(keys.filter((key) => key.startsWith('entry:folder:large-folder:chat:'))).toHaveLength(
      513,
    )
    expect(folderHeader).toBeGreaterThanOrEqual(0)
    expect(firstChild).toBe(folderHeader + 1)
    expect(lastChild).toBe(folderHeader + 513)
    expect(newerRootIndex).toBeGreaterThan(lastChild)
    expect(rootIndex).toBeGreaterThan(newerRootIndex)
    expect(keys).toContain('entry:folder:empty-folder')
    expect(keys).toContain('entry:folder:empty-folder:empty')
    expect(rows).toHaveLength(518)
    expect(measurements.reduce((sum, value) => sum + value.folderChildRowsRead, 0)).toBe(513)
    expect(
      measurements.reduce((sum, value) => sum + value.rootChatRowsRead, 0),
    ).toBeLessThanOrEqual(4)
    expect(
      measurements.reduce((sum, value) => sum + value.folderCatalogRowsRead, 0),
    ).toBeLessThanOrEqual(4)

    const collapsed = await readPresentationPage({
      ...request,
      collapsedFolderIds: ['large-folder', 'empty-folder'],
      countMode: 'exact',
    })
    expect(collapsed.rows.map((row) => row.key)).toContain('entry:folder:large-folder')
    expect(collapsed.rows.some((row) => row.key.includes(':folder-chat-'))).toBe(false)
    expect(collapsed.measurement.folderChildRowsRead).toBe(0)
  })

  it('orders folders from exact child extrema in both directions and keeps pinned entries first', async () => {
    await createFolder({ id: 'mixed-folder', name: 'Mixed folder', now: 20 })
    await createFolder({ id: 'pinned-folder', name: 'Pinned folder', now: 20 })
    await putTestChats([
      {
        ...buildChat({ id: 'mixed-old', title: 'Mixed old', now: 1 }),
        folderId: 'mixed-folder',
        previewText: 'Mixed old',
      },
      {
        ...buildChat({ id: 'mixed-new', title: 'Mixed new', now: 10 }),
        folderId: 'mixed-folder',
        previewText: 'Mixed new',
      },
      {
        ...buildChat({ id: 'pinned-folder-child', title: 'Pinned folder child', now: 200 }),
        folderId: 'pinned-folder',
        previewText: 'Pinned folder child',
        pinned: true,
      },
      {
        ...buildChat({ id: 'pinned-root', title: 'Pinned root', now: 2 }),
        previewText: 'Pinned root',
        pinned: true,
      },
      {
        ...buildChat({ id: 'loose', title: 'Loose', now: 5 }),
        previewText: 'Loose',
      },
    ])

    const topLevelKeys = async (sort: 'updatedAt-asc' | 'updatedAt-desc') => {
      const page = await readPresentationPage({
        mode: 'expanded',
        sort,
        collapsedFolderIds: ['mixed-folder', 'pinned-folder'],
        createdAtGroupBoundaries: [100, 90, 40, -190],
        limit: 20,
        countMode: 'exact',
      })
      return page.rows.map((row) => row.key)
    }

    expect(await topLevelKeys('updatedAt-desc')).toEqual([
      'entry:folder:pinned-folder',
      'entry:chat:pinned-root',
      'entry:folder:mixed-folder',
      'entry:chat:loose',
    ])
    expect(await topLevelKeys('updatedAt-asc')).toEqual([
      'entry:chat:pinned-root',
      'entry:folder:pinned-folder',
      'entry:folder:mixed-folder',
      'entry:chat:loose',
    ])
  })

  it('uses one gap-free canonical tuple across every sidebar sort mode', async () => {
    const chats = [
      { id: 'tuple-z', title: 'Zulu', pinned: false },
      { id: 'tuple-a2', title: 'alpha 2', pinned: false },
      { id: 'tuple-a10', title: 'Alpha 10', pinned: false },
      { id: 'tuple-same-b', title: 'same', pinned: false },
      { id: 'tuple-same-a', title: 'same', pinned: false },
      { id: 'tuple-pinned-b', title: 'Pinned', pinned: true },
      { id: 'tuple-pinned-a', title: 'Pinned', pinned: true },
    ].map(({ id, title, pinned }) => ({
      ...buildChat({ id, title, now: 50 }),
      titleStatus: 'manual' as const,
      pinned,
      updatedAt: 50,
      createdAt: 50,
      lastViewedAt: 50,
      totalCostUsd: 7,
      wordCount: 9,
      previewText: title,
    }))
    await putTestChats(chats)

    for (const { mode } of SIDEBAR_SORT_OPTIONS) {
      const rows: SidebarPresentationPage['rows'][number][] = []
      let cursor: string | undefined
      do {
        const page = await readPresentationPage({
          mode: 'expanded',
          sort: mode,
          collapsedFolderIds: [],
          createdAtGroupBoundaries: [100, 90, 40, -190],
          limit: 2,
          countMode: cursor ? 'omit' : 'exact',
          ...(cursor ? { cursor } : {}),
        })
        rows.push(...page.rows)
        cursor = page.nextCursor
      } while (cursor)

      const direction = sidebarSortDirection(mode) === 'asc' ? 1 : -1
      const primary = (chat: (typeof chats)[number]): number | string => {
        const field = sidebarSortField(mode)
        return field === 'title' ? sidebarTitleSortKey(chat.title) : chat[field]
      }
      const compare = (left: number | string, right: number | string) =>
        left < right ? -1 : left > right ? 1 : 0
      const expected = [...chats]
        .sort(
          (left, right) =>
            Number(right.pinned) - Number(left.pinned) ||
            direction * compare(primary(left), primary(right)) ||
            direction *
              compare(sidebarTitleSortKey(left.title), sidebarTitleSortKey(right.title)) ||
            direction * compare(left.id, right.id),
        )
        .map((chat) => `entry:chat:${chat.id}`)
      const keys = rows.map((row) => row.key)
      expect(keys, mode).toEqual(expected)
      expect(new Set(keys).size, mode).toBe(chats.length)
    }
  })

  it('publishes created-time group runs as presentation rows', async () => {
    const day = 86_400_000
    const today = day * 100
    await createFolder({ id: 'dated-folder', name: 'Dated folder', now: today })
    await putTestChats([
      {
        ...buildChat({ id: 'dated-today', title: 'Today', now: today }),
        folderId: 'dated-folder',
        previewText: 'Today',
      },
      {
        ...buildChat({ id: 'dated-yesterday', title: 'Yesterday', now: today - day }),
        folderId: 'dated-folder',
        previewText: 'Yesterday',
      },
      {
        ...buildChat({ id: 'dated-older', title: 'Older', now: today - day * 40 }),
        folderId: 'dated-folder',
        previewText: 'Older',
      },
    ])

    const page = await readPresentationPage({
      mode: 'expanded',
      sort: 'createdAt-desc',
      collapsedFolderIds: [],
      createdAtGroupBoundaries: [today, today - day, today - day * 6, today - day * 29],
      limit: 20,
      countMode: 'exact',
    })
    expect(page.rows.flatMap((row) => (row.kind === 'time-group' ? [row.label] : []))).toEqual([
      'Today',
      'Yesterday',
      'Older',
    ])
    expect(page.nextCursor).toBeUndefined()
  })

  it('pages created-time groups across pinned buckets without gaps or duplicate chats', async () => {
    const day = 86_400_000
    const today = day * 100
    await createFolder({ id: 'paged-dated-folder', name: 'Paged dated folder', now: today })
    const dated = [
      { id: 'pinned-today', now: today + 2, pinned: true },
      { id: 'pinned-older', now: today - day * 40, pinned: true },
      { id: 'plain-today', now: today + 1, pinned: false },
      { id: 'plain-yesterday', now: today - day, pinned: false },
      { id: 'plain-older', now: today - day * 41, pinned: false },
    ]
    await putTestChats(
      dated.map(({ id, now, pinned }) => ({
        ...buildChat({ id, title: id, now }),
        titleStatus: 'manual' as const,
        folderId: 'paged-dated-folder',
        pinned,
        previewText: id,
      })),
    )

    const rows: SidebarPresentationPage['rows'][number][] = []
    const measurements: SidebarPresentationPage['measurement'][] = []
    const physicalPageSizes: number[] = []
    let cursor: string | undefined
    do {
      const page = await readPresentationPage({
        mode: 'expanded',
        sort: 'createdAt-desc',
        collapsedFolderIds: [],
        createdAtGroupBoundaries: [today, today - day, today - day * 6, today - day * 29],
        limit: 2,
        countMode: cursor ? 'omit' : 'exact',
        ...(cursor ? { cursor } : {}),
      })
      rows.push(...page.rows)
      measurements.push(page.measurement)
      physicalPageSizes.push(page.rows.length)
      cursor = page.nextCursor
    } while (cursor)

    expect(rows.flatMap((row) => (row.kind === 'time-group' ? [row.label] : []))).toEqual([
      'Today',
      'Older',
      'Today',
      'Yesterday',
      'Older',
    ])
    expect(rows.filter((row) => row.kind === 'chat').map((row) => row.chat.id)).toEqual(
      dated.map((row) => row.id),
    )
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length)
    expect(physicalPageSizes.every((size) => size > 0)).toBe(true)
    expect(
      measurements.reduce((sum, measurement) => sum + measurement.folderChildRowsRead, 0),
    ).toBe(dated.length)
    expect(
      measurements.reduce((sum, measurement) => sum + measurement.createdAtGroupProbeQueries, 0),
    ).toBe(0)
    expect(
      measurements.reduce((sum, measurement) => sum + measurement.createdAtGroupProbeKeysRead, 0),
    ).toBe(0)
  })

  it('rejects a presentation read aborted while compact catalogs resolve', async () => {
    const db = getDb()
    const controller = new AbortController()
    const readAggregate = db.chatSidebarAggregates.get.bind(db.chatSidebarAggregates)
    vi.spyOn(db.chatSidebarAggregates, 'get').mockImplementationOnce((key) =>
      readAggregate(key).then((aggregate) => {
        controller.abort()
        return aggregate
      }),
    )

    await expect(
      readSidebarPresentationPage(
        db,
        {
          mode: 'expanded',
          sort: 'updatedAt-desc',
          collapsedFolderIds: [],
          createdAtGroupBoundaries: [100, 90, 40, -190],
          limit: 2,
          countMode: 'exact',
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('refreshes the mounted tab session when an empty folder is created', async () => {
    const fence = await runWorkspaceRead('repository-query', (permit) =>
      getWorkspaceRepository()
        .query(permit, { kind: 'workspace.meta' }, { signal: permit.signal })
        .then(({ value }) => ({
          workspaceId: value.workspaceId,
          replacementEpoch: value.replacementEpoch,
        })),
    )
    const controller = createSidebarSessionController({
      firstPageSettlement: workspaceUsableSurfaceSettlementPort('sidebar-first-page'),
    })
    controller.request({
      ...fence,
      mode: 'expanded',
      sort: 'updatedAt-desc',
      collapsedFolderIds: [],
      pageSize: 20,
      createdAtGroupBoundaries: [100, 90, 40, -190],
    })
    await vi.waitFor(() => expect(controller.getSnapshot()?.status).toBe('ready'))

    await createFolder({ id: 'live-folder', name: 'Live folder', now: 1 })
    await vi.waitFor(() =>
      expect(controller.getSnapshot()?.page.meta.folders.map((folder) => folder.id)).toContain(
        'live-folder',
      ),
    )
    controller.dispose()
  })
})
