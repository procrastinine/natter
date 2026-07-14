import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import Dexie, { type ObservabilitySet, RangeSet } from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatId } from '../../src/core/types'
import { loadKnownBranchPageSnapshot, loadMessageHeaders } from '../../src/store/chats'
import type { MessageHeaderRow } from '../../src/store/message-storage'
import {
  __setRepositoryMutationSubscriberForTests,
  type RepositoryMutationSubscriber,
  useRepositoryPresentationQuery,
} from '../../src/store/reactive-query'
import type { WorkspaceRepository } from '../../src/store/repository'
import {
  __resetWorkspaceRepositoryForTests,
  __setWorkspaceRepositoryForTests,
} from '../../src/store/workspace-repository'

const DATABASE_NAME = 'chat-presentation-lifecycle-test'
const CHAT_ID = 'lifecycle-chat'
const HEADER = {
  id: 'retained-header',
  chatId: CHAT_ID,
  parentId: null,
  siblingIndex: 0,
  turnId: 'retained-turn',
  turnIndex: 0,
  createdAt: 1,
  role: 'user',
  origin: 'user',
  nodeVersion: 0,
  bodyVersion: 0,
  bodyWordCount: 1,
  textPreview: 'retained',
  deleted: false,
} satisfies MessageHeaderRow

let mutationListener: ((parts: ObservabilitySet) => void) | null = null
let databaseOpen = true

const subscribe: RepositoryMutationSubscriber = (listener) => {
  mutationListener = listener
  return () => {
    if (mutationListener === listener) mutationListener = null
  }
}

beforeEach(() => {
  databaseOpen = true
  mutationListener = null
  __setRepositoryMutationSubscriberForTests(subscribe, DATABASE_NAME, () => ({
    isOpen: () => databaseOpen,
  }))
})

afterEach(() => {
  cleanup()
  __resetWorkspaceRepositoryForTests()
  __setRepositoryMutationSubscriberForTests(undefined)
})

describe('chat presentation loader lifecycle errors', () => {
  it('retains the last good message headers when the repository closes during a refresh', async () => {
    const listMessageHeaders = vi
      .fn<(chatId: ChatId, options?: { signal?: AbortSignal }) => Promise<MessageHeaderRow[]>>()
      .mockResolvedValueOnce([HEADER])
      .mockRejectedValueOnce(new Dexie.DatabaseClosedError('workspace replaced'))
    __setWorkspaceRepositoryForTests({ listMessageHeaders } as unknown as WorkspaceRepository)

    render(<HeaderProbe />)
    await waitFor(() => expect(screen.getByTestId('headers')).toHaveTextContent(HEADER.id))

    databaseOpen = false
    act(() => {
      mutationListener?.({
        [`idb://${DATABASE_NAME}/messages/chatId`]: new RangeSet(CHAT_ID),
      })
    })

    await waitFor(() => expect(listMessageHeaders).toHaveBeenCalledTimes(2))
    expect(screen.getByTestId('headers')).toHaveTextContent(HEADER.id)
    expect(screen.getByTestId('headers')).not.toHaveTextContent('empty')
  })

  it('propagates lifecycle failure from the branch-page presentation loader', async () => {
    const error = new Dexie.DatabaseClosedError('workspace replaced')
    const getKnownBranchPageSnapshot = vi.fn().mockRejectedValue(error)
    __setWorkspaceRepositoryForTests({
      getKnownBranchPageSnapshot,
    } as unknown as WorkspaceRepository)

    await expect(
      loadKnownBranchPageSnapshot(CHAT_ID, ['retained-header'], {
        offset: -1,
        limit: 1,
      }),
    ).rejects.toBe(error)
  })

  it('propagates cancellation from both presentation loaders', async () => {
    const headerAbort = new DOMException('headers superseded', 'AbortError')
    const pageAbort = new DOMException('page superseded', 'AbortError')
    __setWorkspaceRepositoryForTests({
      listMessageHeaders: vi.fn().mockRejectedValue(headerAbort),
      getKnownBranchPageSnapshot: vi.fn().mockRejectedValue(pageAbort),
    } as unknown as WorkspaceRepository)

    await expect(loadMessageHeaders(CHAT_ID)).rejects.toBe(headerAbort)
    await expect(
      loadKnownBranchPageSnapshot(CHAT_ID, ['retained-header'], {
        offset: -1,
        limit: 1,
      }),
    ).rejects.toBe(pageAbort)
  })
})

function HeaderProbe() {
  const headers = useRepositoryPresentationQuery(
    'lifecycle-message-headers',
    (signal) => loadMessageHeaders(CHAT_ID, { signal }),
    [],
    [{ table: 'messages', index: 'chatId', keys: [CHAT_ID] }],
  )
  return <span data-testid="headers">{headers.length === 0 ? 'empty' : headers[0]?.id}</span>
}
