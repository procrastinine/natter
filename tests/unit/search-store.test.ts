import { afterEach, describe, expect, it } from 'vitest'
import { __resetBroadcastForTests, postEvent } from '../../src/store/broadcast'
import type { SearchResult } from '../../src/store/chat-search'
import {
  __resetSearchStoreForTests,
  orderedSearchResults,
  startSearchStoreBroadcastListener,
  useSearchStore,
} from '../../src/store/zustand/searchStore'

afterEach(() => {
  __resetSearchStoreForTests()
  __resetBroadcastForTests()
})

describe('search store shell', () => {
  it('starts a debounced search session and tracks branch-cache invalidations', () => {
    startSearchStoreBroadcastListener()
    useSearchStore.getState().setQuery('needle')

    postEvent({ kind: 'branch-cache-refreshed', chatId: 'chat-1' })

    expect(useSearchStore.getState().session).toMatchObject({
      query: 'needle',
      status: 'debouncing',
      invalidatedChatIds: ['chat-1'],
      tailPassChatIds: [],
    })
  })

  it('tracks chat mutations separately for tail-pass rescans', () => {
    startSearchStoreBroadcastListener()
    useSearchStore.getState().setQuery('needle')

    postEvent({
      kind: 'chat-mutated',
      chatId: 'chat-1',
      metaVersion: 1,
      summaryVersion: 1,
      affected: [{ kind: 'message', chatId: 'chat-1' }],
    })

    expect(useSearchStore.getState().session).toMatchObject({
      invalidatedChatIds: ['chat-1'],
      tailPassChatIds: ['chat-1'],
    })

    useSearchStore.getState().clearTailPassChatIds(['chat-1'])
    expect(useSearchStore.getState().session?.tailPassChatIds).toEqual([])
  })

  it('drops deleted chats and ignores late hits for them', () => {
    startSearchStoreBroadcastListener()
    useSearchStore.getState().setQuery('needle')

    postEvent({ kind: 'chat-deleted', chatId: 'chat-1' })
    useSearchStore.getState().mergeResult({
      id: 'chat-1',
      chatId: 'chat-1',
      chat: {
        id: 'chat-1',
        title: 'late',
        titleStatus: 'manual',
        createdAt: 1,
        updatedAt: 1,
        lastViewedAt: 1,
        wordCount: 0,
        totalCostUsd: 0,
        metaVersion: 0,
        summaryVersion: 0,
        settings: {} as never,
        lastUpdatedLeafId: null,
        lastBranchUpdatedAt: 1,
        archived: false,
        pinned: false,
        folderId: null,
        tags: [],
      },
      source: 'title',
      title: 'late',
      snippet: 'late',
      highlightRanges: [],
      prefixTruncated: false,
      suffixTruncated: false,
      rank: 0,
    })

    expect(useSearchStore.getState().session?.results.size).toBe(0)
    expect(useSearchStore.getState().session?.deletedChatIds).toEqual(['chat-1'])
  })

  it('delivers 1,001 progressive ordered hits without copying or rescanning prior results', () => {
    useSearchStore.getState().setQuery('needle')
    let chatIdReads = 0
    const revisions: number[] = []
    const unsubscribe = useSearchStore.subscribe((state, previous) => {
      const revision = state.session?.results.revision
      if (revision !== undefined && revision !== previous.session?.results.revision) {
        revisions.push(revision)
      }
    })

    const first = searchResultWithTrackedChatId('chat-0', () => {
      chatIdReads += 1
    })
    useSearchStore.getState().mergeResult(first)
    const initial = useSearchStore.getState().session?.results
    if (!initial) throw new Error('missing search result collection')
    const orderedIds = initial.orderedIds
    const byChatId = initial.byChatId
    const orderedValues = orderedSearchResults(initial)

    for (let index = 1; index < 1_001; index += 1) {
      const chatId = `chat-${index}`
      const result = searchResultWithTrackedChatId(chatId, () => {
        chatIdReads += 1
      })
      useSearchStore.getState().mergeResult(result)
    }

    unsubscribe()
    const results = useSearchStore.getState().session?.results
    expect(results?.size).toBe(1_001)
    expect(results).not.toBe(initial)
    expect(results?.orderedIds).toBe(orderedIds)
    expect(results?.byChatId).toBe(byChatId)
    expect(orderedSearchResults(results)).toBe(orderedValues)
    expect(results?.orderedIds).toEqual(
      Array.from({ length: 1_001 }, (_, index) => `chat-${index}`),
    )
    expect(chatIdReads).toBe(1_001)
    expect(revisions).toEqual(Array.from({ length: 1_001 }, (_, index) => index + 1))
  })

  it('replaces a repeated chat hit in place without changing result order', () => {
    useSearchStore.getState().setQuery('needle')
    useSearchStore.getState().mergeResult(searchResult('first'))
    useSearchStore.getState().mergeResult(searchResult('second'))
    const initial = useSearchStore.getState().session?.results
    if (!initial) throw new Error('missing search result collection')
    const orderedIds = initial.orderedIds
    const byChatId = initial.byChatId
    const orderedValues = orderedSearchResults(initial)
    useSearchStore.getState().mergeResult({ ...searchResult('first'), title: 'updated' })

    const results = useSearchStore.getState().session?.results
    expect(results).not.toBe(initial)
    expect(results?.orderedIds).toBe(orderedIds)
    expect(results?.byChatId).toBe(byChatId)
    expect(orderedSearchResults(results)).toBe(orderedValues)
    expect(orderedSearchResults(results)).toMatchObject([
      { chatId: 'first', title: 'updated' },
      { chatId: 'second' },
    ])

    useSearchStore.getState().setProgress(2, 2)
    expect(useSearchStore.getState().session?.results).toBe(results)
  })

  it('removes misses and appends a later hit without disturbing surviving order', () => {
    useSearchStore.getState().setQuery('needle')
    useSearchStore.getState().mergeResult(searchResult('first'))
    useSearchStore.getState().mergeResult(searchResult('second'))
    useSearchStore.getState().mergeResult(searchResult('third'))

    useSearchStore.getState().removeResult('second')
    expect(orderedSearchResults(useSearchStore.getState().session?.results)).toMatchObject([
      { chatId: 'first' },
      { chatId: 'third' },
    ])

    useSearchStore.getState().mergeResult({ ...searchResult('second'), title: 'later' })
    expect(orderedSearchResults(useSearchStore.getState().session?.results)).toMatchObject([
      { chatId: 'first' },
      { chatId: 'third' },
      { chatId: 'second', title: 'later' },
    ])
  })

  it('invalidates sessions that reference a deleted tag filter', () => {
    startSearchStoreBroadcastListener()
    useSearchStore.getState().setQuery('needle', {
      filters: {
        includeFolderIds: [],
        excludeFolderIds: [],
        includeTagIds: ['tag-1'],
        excludeTagIds: [],
        archived: 'exclude',
        titleOnly: false,
      },
    })
    useSearchStore.getState().setStatus('done')

    postEvent({ kind: 'tag-deleted', tagId: 'tag-1' })

    expect(useSearchStore.getState().session?.status).toBe('debouncing')
    expect(useSearchStore.getState().session?.invalidatedAt).toBeTypeOf('number')
  })

  it.each([
    { kind: 'workspace-replaced' as const, replacementEpoch: 1 },
    { kind: 'workspace-invalidated' as const, mutationCounter: 7 },
  ])('clears derived search state on $kind', (event) => {
    startSearchStoreBroadcastListener()
    useSearchStore.getState().setQuery('needle')

    postEvent(event)

    expect(useSearchStore.getState().session).toBeNull()
  })
})

function searchResult(chatId: string): SearchResult {
  return {
    id: chatId,
    chatId,
    chat: {
      id: chatId,
      title: chatId,
      titleStatus: 'manual',
      createdAt: 1,
      updatedAt: 1,
      lastViewedAt: 1,
      wordCount: 0,
      totalCostUsd: 0,
      metaVersion: 0,
      summaryVersion: 0,
      settings: {} as never,
      lastUpdatedLeafId: null,
      lastBranchUpdatedAt: 1,
      archived: false,
      pinned: false,
      folderId: null,
      tags: [],
    },
    source: 'title',
    title: chatId,
    snippet: chatId,
    highlightRanges: [],
    prefixTruncated: false,
    suffixTruncated: false,
    rank: 0,
  }
}

function searchResultWithTrackedChatId(chatId: string, onRead: () => void): SearchResult {
  const result = searchResult(chatId)
  Object.defineProperty(result, 'chatId', {
    configurable: true,
    enumerable: true,
    get: () => {
      onRead()
      return chatId
    },
  })
  return result
}
