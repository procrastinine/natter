import { describe, expect, it } from 'vitest'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import {
  parseSidebarSortMode,
  SIDEBAR_SORT_OPTIONS,
  sidebarTitleSortKey,
} from '../../src/core/sidebar-sort'
import type { Chat } from '../../src/core/types'
import { formatSidebarRowMeta, sortChats } from '../../src/ui/sidebar/chat-organization'

function chat(
  id: string,
  updatedAt: number,
  folderId: string | null = null,
  patch: Partial<Chat> = {},
): Chat {
  const row: Chat = {
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
    structuralVersion: 0,
    settings: cloneDefaultChatSettings(),
    lastUpdatedLeafId: null,
    lastBranchUpdatedAt: updatedAt,
    archived: false,
    pinned: false,
    folderId,
    tags: [],
    previewText: id,
  }
  return Object.assign(row, patch)
}

describe('sidebar organization helpers', () => {
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
      const first = sortChats(rows, option.mode).map((row) => row.id)
      const second = sortChats(rows, option.mode).map((row) => row.id)
      expect(first, option.mode).toEqual(second)
      expect(first.slice(0, 2).sort(), option.mode).toEqual(['chat-07', 'chat-33'])
      expect(new Set(first).size, option.mode).toBe(50)
    }
  })

  it('uses one environment-independent canonical title key', () => {
    const rows = [
      chat('ten', 1, null, { title: 'Topic 10' }),
      chat('two', 1, null, { title: 'Topic 2' }),
      chat('a', 1, null, { title: 'Änderung' }),
      chat('z', 1, null, { title: 'Zulu' }),
    ]

    expect(sortChats(rows, 'title-asc').map((row) => row.id)).toEqual(['ten', 'two', 'z', 'a'])
    expect(sidebarTitleSortKey('  ')).toBe('untitled chat')
    expect(sidebarTitleSortKey('\uff34\uff45\uff53\uff54')).toBe('test')
    expect(sidebarTitleSortKey(`${'a'.repeat(255)}\ud83e\uddea-trailing`)).toBe(
      `${'a'.repeat(255)}\ud83e\uddea`,
    )
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
