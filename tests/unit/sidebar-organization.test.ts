import { describe, expect, it } from 'vitest'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import { parseSidebarSortMode, SIDEBAR_SORT_OPTIONS } from '../../src/core/sidebar-sort'
import type { Chat, ChatFolder } from '../../src/core/types'
import {
  buildCreatedAtGroups,
  buildSidebarEntries,
  formatSidebarRowMeta,
  shouldRenderCreatedAtGroups,
  sortChats,
} from '../../src/ui/sidebar/chat-organization'

function chat(
  id: string,
  updatedAt: number,
  folderId: string | null = null,
  patch: Partial<Chat> = {},
): Chat {
  return {
    id,
    title: id,
    titleStatus: 'manual',
    createdAt: updatedAt,
    updatedAt,
    lastViewedAt: updatedAt,
    wordCount: 0,
    totalCostUsd: 0,
    metaVersion: 0,
    summaryVersion: 0,
    settings: cloneDefaultChatSettings(),
    lastUpdatedLeafId: null,
    lastBranchUpdatedAt: updatedAt,
    archived: false,
    pinned: false,
    folderId,
    tags: [],
    previewText: id,
    ...patch,
  }
}

function folder(id: string, updatedAt: number): ChatFolder {
  return {
    id,
    name: id,
    sortIndex: updatedAt,
    createdAt: updatedAt,
    updatedAt,
  }
}

describe('sidebar organization helpers', () => {
  it('sorts folders by the most recently updated child for default descending sort', () => {
    const entries = buildSidebarEntries(
      [chat('old-loose', 1), chat('folder-old', 2, 'folder'), chat('folder-new', 10, 'folder')],
      [folder('folder', 5)],
      'updatedAt-desc',
    )

    expect(
      entries.map((entry) => (entry.kind === 'folder' ? entry.folder.id : entry.chat.id)),
    ).toEqual(['folder', 'old-loose'])
    expect(entries[0]).toMatchObject({ kind: 'folder', sortValue: 10 })
  })

  it('sorts folders by the least recently updated child for ascending sort', () => {
    const entries = buildSidebarEntries(
      [chat('loose', 5), chat('folder-old', 1, 'folder'), chat('folder-new', 10, 'folder')],
      [folder('folder', 8)],
      'updatedAt-asc',
    )

    expect(
      entries.map((entry) => (entry.kind === 'folder' ? entry.folder.id : entry.chat.id)),
    ).toEqual(['folder', 'loose'])
    expect(entries[0]).toMatchObject({ kind: 'folder', sortValue: 1 })
  })

  it('keeps empty folders visible using the folder fallback timestamp', () => {
    const entries = buildSidebarEntries([chat('loose', 1)], [folder('empty', 20)], 'updatedAt-desc')

    expect(
      entries.map((entry) => (entry.kind === 'folder' ? entry.folder.id : entry.chat.id)),
    ).toEqual(['empty', 'loose'])
    expect(entries[0]).toMatchObject({ kind: 'folder', sortValue: 20, chats: [] })
  })

  it('accepts current persisted sort values and rejects legacy or unknown values', () => {
    expect(parseSidebarSortMode('updated-desc')).toBe('updatedAt-desc')
    expect(parseSidebarSortMode('updated-asc')).toBe('updatedAt-desc')
    expect(parseSidebarSortMode('wat')).toBe('updatedAt-desc')
    expect(parseSidebarSortMode('totalCostUsd-desc')).toBe('totalCostUsd-desc')
  })

  it('sorts deterministically for every sidebar sort key on a varied fixture', () => {
    const rows = Array.from({ length: 50 }, (_, index) =>
      chat(`chat-${index.toString().padStart(2, '0')}`, 1_000 + ((index * 37) % 23), null, {
        title: index % 2 === 0 ? `Thread ${50 - index}` : `Thread ${index}`,
        createdAt: 500 + ((index * 11) % 29),
        lastViewedAt: 750 + ((index * 17) % 31),
        wordCount: (index * 97) % 1000,
        totalCostUsd: ((index * 13) % 70) / 100,
        pinned: index === 7 || index === 33,
      }),
    )

    for (const option of SIDEBAR_SORT_OPTIONS) {
      const first = sortChats(rows, option.mode, { locale: 'en-US' }).map((row) => row.id)
      const second = sortChats(rows, option.mode, { locale: 'en-US' }).map((row) => row.id)
      expect(first, option.mode).toEqual(second)
      expect(first.slice(0, 2).sort(), option.mode).toEqual(['chat-07', 'chat-33'])
      expect(new Set(first).size, option.mode).toBe(50)
    }
  })

  it('uses Intl.Collator title sorting with locale and numeric comparison', () => {
    const rows = [
      chat('ten', 1, null, { title: 'Topic 10' }),
      chat('two', 1, null, { title: 'Topic 2' }),
      chat('a', 1, null, { title: 'Änderung' }),
      chat('z', 1, null, { title: 'Zulu' }),
    ]

    expect(sortChats(rows, 'title-asc', { locale: 'en-US' }).map((row) => row.id)).toEqual([
      'a',
      'two',
      'ten',
      'z',
    ])
    expect(sortChats(rows, 'title-asc', { locale: 'de-DE' }).map((row) => row.id)).toEqual([
      'a',
      'two',
      'ten',
      'z',
    ])
  })

  it('keeps pinned chats and folders above the active sort bucket', () => {
    const entries = buildSidebarEntries(
      [
        chat('new-loose', 100),
        chat('pinned-old', 1, null, { pinned: true }),
        chat('folder-pinned', 2, 'folder', { pinned: true }),
        chat('folder-new', 200, 'folder'),
      ],
      [folder('folder', 10)],
      'updatedAt-desc',
    )

    expect(
      entries.map((entry) => (entry.kind === 'folder' ? entry.folder.id : entry.chat.id)),
    ).toEqual(['folder', 'pinned-old', 'new-loose'])
    expect(entries[0]).toMatchObject({ kind: 'folder', pinned: true })
  })

  it('renders created-at time groups only for created sorts', () => {
    const now = new Date('2026-04-26T12:00:00').getTime()
    const day = 86_400_000
    const rows = sortChats(
      [
        chat('today', 1, 'folder', { createdAt: now }),
        chat('yesterday', 1, 'folder', { createdAt: now - day }),
        chat('older', 1, 'folder', { createdAt: now - day * 40 }),
      ],
      'createdAt-desc',
    )

    expect(shouldRenderCreatedAtGroups('createdAt-desc')).toBe(true)
    expect(shouldRenderCreatedAtGroups('totalCostUsd-desc')).toBe(false)
    expect(buildCreatedAtGroups(rows, 'createdAt-desc', now).map((group) => group.label)).toEqual([
      'Today',
      'Yesterday',
      'Older',
    ])
    expect(buildCreatedAtGroups(rows, 'updatedAt-desc', now)).toEqual([])
  })

  it('formats row metadata for the active sort key', () => {
    const row = chat('row', new Date('2026-04-26T10:30:00').getTime(), null, {
      createdAt: new Date('2026-04-25T10:30:00').getTime(),
      totalCostUsd: 0.123,
      wordCount: 1234,
    })
    const now = new Date('2026-04-26T12:00:00').getTime()

    expect(formatSidebarRowMeta(row, 'createdAt-desc', now)).toBe('Yesterday')
    expect(formatSidebarRowMeta(row, 'totalCostUsd-desc', now)).toBe('$0.12')
    expect(formatSidebarRowMeta(row, 'wordCount-desc', now)).toBe('1,234w')
  })
})
