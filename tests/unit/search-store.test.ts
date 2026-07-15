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
    })
    expect([...(useSearchStore.getState().session?.invalidatedChatIds.keys() ?? [])]).toEqual([
      'chat-1',
    ])
    expect(useSearchStore.getState().session?.tailPassChatIds.size).toBe(0)
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

    const session = useSearchStore.getState().session
    expect([...(session?.invalidatedChatIds.keys() ?? [])]).toEqual(['chat-1'])
    expect([...(session?.tailPassChatIds.keys() ?? [])]).toEqual(['chat-1'])

    useSearchStore.getState().clearTailPassChatIds(['chat-1'])
    expect(useSearchStore.getState().session?.tailPassChatIds.size).toBe(0)
  })

  it('drops deleted chats and ignores late hits for them', () => {
    startSearchStoreBroadcastListener()
    useSearchStore.getState().setQuery('needle')

    postEvent({ kind: 'chat-deleted', chatId: 'chat-1' })
    useSearchStore
      .getState()
      .applyResultBatch([{ kind: 'upsert', result: searchResult('chat-1') }], 1, 1)

    expect(useSearchStore.getState().session?.results.size).toBe(0)
    expect(useSearchStore.getState().session?.deletedChatIds.has('chat-1')).toBe(true)
  })

  it('commits 100,003 results in one immutable linear batch', () => {
    useSearchStore.getState().setQuery('needle')
    const revisions: number[] = []
    const unsubscribe = useSearchStore.subscribe((state, previous) => {
      const revision = state.session?.results.revision
      if (revision !== undefined && revision !== previous.session?.results.revision) {
        revisions.push(revision)
      }
    })
    const initial = useSearchStore.getState().session?.results
    if (!initial) throw new Error('missing search result collection')
    const count = 100_003
    const mutations = Array.from({ length: count }, (_, index) => ({
      kind: 'upsert' as const,
      result: searchResult(`chat-${index}`),
    }))
    const startedAt = performance.now()
    useSearchStore.getState().applyResultBatch(mutations, count, count)
    const elapsedMs = performance.now() - startedAt

    unsubscribe()
    const results = useSearchStore.getState().session?.results
    expect(results?.size).toBe(count)
    expect(results).not.toBe(initial)
    expect(initial.size).toBe(0)
    expect(results?.orderedIds[0]).toBe('chat-0')
    expect(results?.orderedIds.at(-1)).toBe(`chat-${count - 1}`)
    expect(orderedSearchResults(results)[50_000]?.chatId).toBe('chat-50000')
    expect(Object.isFrozen(results?.orderedIds)).toBe(true)
    expect(Object.isFrozen(orderedSearchResults(results))).toBe(true)
    expect(revisions).toEqual([1])
    expect(elapsedMs).toBeLessThan(2_500)
  })

  it('replaces a repeated chat hit in place without changing result order', () => {
    useSearchStore.getState().setQuery('needle')
    useSearchStore.getState().applyResultBatch(
      [
        { kind: 'upsert', result: searchResult('first') },
        { kind: 'upsert', result: searchResult('second') },
      ],
      2,
      2,
    )
    const initial = useSearchStore.getState().session?.results
    if (!initial) throw new Error('missing search result collection')
    useSearchStore
      .getState()
      .applyResultBatch(
        [{ kind: 'upsert', result: { ...searchResult('first'), title: 'updated' } }],
        2,
        2,
      )

    const results = useSearchStore.getState().session?.results
    expect(results).not.toBe(initial)
    expect(results?.orderedIds).toEqual(initial.orderedIds)
    expect(results?.orderedIds).not.toBe(initial.orderedIds)
    expect(results?.byChatId).not.toBe(initial.byChatId)
    expect(orderedSearchResults(results)).not.toBe(orderedSearchResults(initial))
    expect(orderedSearchResults(initial)).toMatchObject([
      { chatId: 'first', title: 'first' },
      { chatId: 'second' },
    ])
    expect(orderedSearchResults(results)).toMatchObject([
      { chatId: 'first', title: 'updated' },
      { chatId: 'second' },
    ])

    useSearchStore.getState().setProgress(2, 2)
    expect(useSearchStore.getState().session?.results).toBe(results)
  })

  it('removes misses and appends a later hit without disturbing surviving order', () => {
    useSearchStore.getState().setQuery('needle')
    useSearchStore.getState().applyResultBatch(
      ['first', 'second', 'third'].map((chatId) => ({
        kind: 'upsert' as const,
        result: searchResult(chatId),
      })),
      3,
      3,
    )

    useSearchStore.getState().applyResultBatch([{ kind: 'remove', chatId: 'second' }], 1, 1)
    expect(orderedSearchResults(useSearchStore.getState().session?.results)).toMatchObject([
      { chatId: 'first' },
      { chatId: 'third' },
    ])

    useSearchStore
      .getState()
      .applyResultBatch(
        [{ kind: 'upsert', result: { ...searchResult('second'), title: 'later' } }],
        1,
        1,
      )
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
