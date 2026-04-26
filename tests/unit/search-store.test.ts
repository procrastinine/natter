import { afterEach, describe, expect, it } from 'vitest'
import { __resetBroadcastForTests, postEvent } from '../../src/store/broadcast'
import {
  __resetSearchStoreForTests,
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

    expect(useSearchStore.getState().session?.results).toEqual([])
    expect(useSearchStore.getState().session?.deletedChatIds).toEqual(['chat-1'])
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
})
