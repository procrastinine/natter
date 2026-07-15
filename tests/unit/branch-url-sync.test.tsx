import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { type ObservabilitySet, RangeSet } from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { navigate, refreshRouteForWorkspaceReplacement } from '../../src/app/router'
import { cursorKeyOf } from '../../src/core/active-path'
import type { ChatId, Message } from '../../src/core/types'
import {
  __setBranchHeaderMergeProbeForTests,
  __setBranchProjectionBuildProbeForTests,
  useBranchUrlSync,
  useStableStructuralHeaders,
} from '../../src/hooks/useBranchUrlSync'
import type { MessageHeaderRow } from '../../src/store/message-storage'
import {
  __setRepositoryMutationSubscriberForTests,
  type RepositoryMutationSubscriber,
} from '../../src/store/reactive-query'
import { useChatStore } from '../../src/store/zustand/chatStore'

const chatReads = vi.hoisted(() => ({
  loadMessageHeaders:
    vi.fn<(chatId: ChatId, options?: { signal?: AbortSignal }) => Promise<MessageHeaderRow[]>>(),
  loadMessageHeadersById:
    vi.fn<
      (
        messageIds: readonly string[],
        options?: { signal?: AbortSignal },
      ) => Promise<Array<MessageHeaderRow | undefined>>
    >(),
}))

vi.mock('../../src/store/chats', () => ({
  loadMessageHeaders: chatReads.loadMessageHeaders,
  loadMessageHeadersById: chatReads.loadMessageHeadersById,
}))

const CHAT_ID = 'branch-url-chat'
const DATABASE_NAME = 'branch-url-sync-test'

const silentChanges: RepositoryMutationSubscriber =
  (_listener: (parts: ObservabilitySet) => void) => () => {}

function header(input: {
  id: string
  parentId: string | null
  siblingIndex: number
  createdAt: number
  role: Message['role']
}): MessageHeaderRow {
  return {
    id: input.id,
    chatId: CHAT_ID,
    parentId: input.parentId,
    siblingIndex: input.siblingIndex,
    turnId: input.id,
    turnIndex: input.createdAt,
    createdAt: input.createdAt,
    role: input.role,
    origin: input.role === 'user' ? 'user' : 'generated',
    requestContextVersion: 0,
    bodyVersion: 0,
    bodyWordCount: 0,
    textPreview: '',
    nodeVersion: 0,
    deleted: false,
  }
}

const root = header({
  id: 'url-root',
  parentId: null,
  siblingIndex: 0,
  createdAt: 1,
  role: 'user',
})
const oldLeaf = header({
  id: 'url-old-leaf',
  parentId: root.id,
  siblingIndex: 0,
  createdAt: 2,
  role: 'assistant',
})
const firstNewLeaf = header({
  id: 'url-first-new-leaf',
  parentId: root.id,
  siblingIndex: 1,
  createdAt: 3,
  role: 'assistant',
})
const secondNewLeaf = header({
  id: 'url-second-new-leaf',
  parentId: root.id,
  siblingIndex: 2,
  createdAt: 4,
  role: 'assistant',
})
const fallbackLeaf = header({
  id: 'url-fallback-leaf',
  parentId: root.id,
  siblingIndex: 3,
  createdAt: 1.5,
  role: 'assistant',
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((next, fail) => {
    resolve = next
    reject = fail
  })
  return { promise, resolve, reject }
}

function BranchUrlProbe({ chatId }: { chatId: ChatId }) {
  const { headerById, structuralHeaders } = useBranchUrlSync(chatId)
  const headers = structuralHeaders.map(
    (structural) => headerById.get(structural.id) as MessageHeaderRow,
  )
  return (
    <>
      <output data-testid="headers">{headers.map((row) => row.id).join(',')}</output>
      <output data-testid="header-versions">
        {headers.map((row) => `${row.id}:${row.nodeVersion}`).join(',')}
      </output>
    </>
  )
}

function BranchHeaderBudgetProbe({ chatId, targetId }: { chatId: ChatId; targetId: string }) {
  const { headerById, structuralHeaders } = useBranchUrlSync(chatId)
  return (
    <output data-testid="header-budget">
      {structuralHeaders.length}:{headerById.get(targetId)?.nodeVersion ?? -1}
    </output>
  )
}

function navigateTo(messageId: string) {
  window.history.replaceState(null, '', `#/chat/${CHAT_ID}/message/${messageId}`)
  window.dispatchEvent(new HashChangeEvent('hashchange'))
}

describe('branch URL synchronization', () => {
  beforeEach(() => {
    useChatStore.getState().reset()
    chatReads.loadMessageHeaders.mockReset()
    chatReads.loadMessageHeadersById.mockReset()
    __setRepositoryMutationSubscriberForTests(silentChanges, DATABASE_NAME)
    window.history.replaceState(null, '', `#/chat/${CHAT_ID}`)
  })

  afterEach(() => {
    cleanup()
    __setBranchHeaderMergeProbeForTests(undefined)
    __setBranchProjectionBuildProbeForTests(undefined)
    __setRepositoryMutationSubscriberForTests(undefined)
    useChatStore.getState().reset()
    window.history.replaceState(null, '', '#/')
  })

  it('resolves a new URL target from a fresh header-only read instead of rejecting a stale ready cache', async () => {
    const freshRead = deferred<MessageHeaderRow[]>()
    chatReads.loadMessageHeaders
      .mockResolvedValueOnce([root, oldLeaf])
      .mockReturnValueOnce(freshRead.promise)

    render(<BranchUrlProbe chatId={CHAT_ID} />)

    await waitFor(() => {
      expect(screen.getByTestId('headers')).toHaveTextContent(`${root.id},${oldLeaf.id}`)
      expect(window.location.hash).toBe(`#/chat/${CHAT_ID}/message/${oldLeaf.id}`)
    })

    act(() => navigateTo(firstNewLeaf.id))

    expect(window.location.hash).toBe(`#/chat/${CHAT_ID}/message/${firstNewLeaf.id}`)
    expect(useChatStore.getState().getCursor(CHAT_ID)?.[cursorKeyOf(root.id)]).toBe(oldLeaf.id)

    await act(async () => {
      freshRead.resolve([root, oldLeaf, firstNewLeaf])
      await freshRead.promise
    })

    await waitFor(() => {
      expect(useChatStore.getState().getCursor(CHAT_ID)?.[cursorKeyOf(root.id)]).toBe(
        firstNewLeaf.id,
      )
      expect(window.location.hash).toBe(`#/chat/${CHAT_ID}/message/${firstNewLeaf.id}`)
    })
    expect(chatReads.loadMessageHeaders).toHaveBeenCalledTimes(2)
  })

  it('canonicalizes an invalid message pin on an empty chat to the bare chat route', async () => {
    chatReads.loadMessageHeaders.mockResolvedValue([])
    window.history.replaceState(null, '', `#/chat/${CHAT_ID}/message/missing`)

    render(<BranchUrlProbe chatId={CHAT_ID} />)

    await waitFor(() => {
      expect(window.location.hash).toBe(`#/chat/${CHAT_ID}`)
    })
    expect(screen.getByTestId('headers')).toHaveTextContent('')
  })

  it('retains a startup message pin when its fresh read fails before headers publish', async () => {
    const publishedHeaders = deferred<MessageHeaderRow[]>()
    const href = `#/chat/${CHAT_ID}/message/${firstNewLeaf.id}`
    chatReads.loadMessageHeaders
      .mockRejectedValueOnce(new DOMException('lifecycle replay', 'AbortError'))
      .mockReturnValue(publishedHeaders.promise)
    window.history.replaceState(null, '', href)

    render(<BranchUrlProbe chatId={CHAT_ID} />)

    await waitFor(() => expect(chatReads.loadMessageHeaders).toHaveBeenCalledTimes(2))
    expect(window.location.hash).toBe(href)

    await act(async () => {
      publishedHeaders.resolve([root, oldLeaf, firstNewLeaf])
      await publishedHeaders.promise
    })

    await waitFor(() => {
      expect(useChatStore.getState().getCursor(CHAT_ID)?.[cursorKeyOf(root.id)]).toBe(
        firstNewLeaf.id,
      )
      expect(window.location.hash).toBe(href)
    })
  })

  it('retries a failed fresh URL-target read and resolves the same arrival', async () => {
    const href = `#/chat/${CHAT_ID}/message/${firstNewLeaf.id}`
    chatReads.loadMessageHeaders
      .mockResolvedValueOnce([root, oldLeaf])
      .mockRejectedValueOnce(new Error('transient header read failure'))
      .mockResolvedValueOnce([root, oldLeaf, firstNewLeaf])

    render(<BranchUrlProbe chatId={CHAT_ID} />)
    await waitFor(() => expect(screen.getByTestId('headers')).toHaveTextContent(oldLeaf.id))
    act(() => navigateTo(firstNewLeaf.id))

    await waitFor(() => expect(chatReads.loadMessageHeaders).toHaveBeenCalledTimes(3))
    await waitFor(() => {
      expect(useChatStore.getState().getCursor(CHAT_ID)?.[cursorKeyOf(root.id)]).toBe(
        firstNewLeaf.id,
      )
      expect(window.location.hash).toBe(href)
    })
    expect(chatReads.loadMessageHeaders.mock.calls[1]?.[1]?.signal?.aborted).toBe(true)
  })

  it('cancels a scheduled URL-target retry when a newer arrival supersedes it', async () => {
    const newerRead = deferred<MessageHeaderRow[]>()
    chatReads.loadMessageHeaders
      .mockResolvedValueOnce([root, oldLeaf])
      .mockRejectedValueOnce(new Error('transient header read failure'))
      .mockReturnValueOnce(newerRead.promise)

    render(<BranchUrlProbe chatId={CHAT_ID} />)
    await waitFor(() => expect(screen.getByTestId('headers')).toHaveTextContent(oldLeaf.id))
    await act(async () => {
      navigateTo(firstNewLeaf.id)
      await Promise.resolve()
    })
    expect(chatReads.loadMessageHeaders).toHaveBeenCalledTimes(2)

    act(() => navigateTo(secondNewLeaf.id))
    await waitFor(() => expect(chatReads.loadMessageHeaders).toHaveBeenCalledTimes(3))
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(chatReads.loadMessageHeaders).toHaveBeenCalledTimes(3)

    await act(async () => {
      newerRead.resolve([root, oldLeaf, firstNewLeaf, secondNewLeaf])
      await newerRead.promise
    })
    await waitFor(() => {
      expect(useChatStore.getState().getCursor(CHAT_ID)?.[cursorKeyOf(root.id)]).toBe(
        secondNewLeaf.id,
      )
      expect(window.location.hash).toBe(`#/chat/${CHAT_ID}/message/${secondNewLeaf.id}`)
    })
  })

  it('cancels a scheduled URL-target retry on unmount', async () => {
    chatReads.loadMessageHeaders
      .mockResolvedValueOnce([root, oldLeaf])
      .mockRejectedValueOnce(new Error('transient header read failure'))

    const view = render(<BranchUrlProbe chatId={CHAT_ID} />)
    await waitFor(() => expect(screen.getByTestId('headers')).toHaveTextContent(oldLeaf.id))
    await act(async () => {
      navigateTo(firstNewLeaf.id)
      await Promise.resolve()
    })
    expect(chatReads.loadMessageHeaders).toHaveBeenCalledTimes(2)

    view.unmount()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(chatReads.loadMessageHeaders).toHaveBeenCalledTimes(2)
  })

  it('fences a fresh header read that ignores abort and settles after unmount', async () => {
    const freshRead = deferred<MessageHeaderRow[]>()
    const publishedHeaders = deferred<MessageHeaderRow[]>()
    const href = `#/chat/${CHAT_ID}/message/${firstNewLeaf.id}`
    chatReads.loadMessageHeaders
      .mockReturnValueOnce(freshRead.promise)
      .mockReturnValueOnce(publishedHeaders.promise)
    window.history.replaceState(null, '', href)

    const view = render(<BranchUrlProbe chatId={CHAT_ID} />)
    await waitFor(() => expect(chatReads.loadMessageHeaders).toHaveBeenCalledTimes(2))
    const cursorBeforeUnmount = useChatStore.getState().getCursor(CHAT_ID)
    view.unmount()

    await act(async () => {
      freshRead.resolve([root, oldLeaf, firstNewLeaf])
      await freshRead.promise
    })

    expect(useChatStore.getState().getCursor(CHAT_ID)).toBe(cursorBeforeUnmount)
    expect(useChatStore.getState().getCursor(CHAT_ID)?.[cursorKeyOf(root.id)]).toBeUndefined()
    expect(window.location.hash).toBe(href)
  })

  it('ignores a fresh-read completion from an older URL arrival', async () => {
    const firstRead = deferred<MessageHeaderRow[]>()
    const secondRead = deferred<MessageHeaderRow[]>()
    chatReads.loadMessageHeaders
      .mockResolvedValueOnce([root, oldLeaf])
      .mockReturnValueOnce(firstRead.promise)
      .mockReturnValueOnce(secondRead.promise)

    render(<BranchUrlProbe chatId={CHAT_ID} />)
    await waitFor(() => {
      expect(screen.getByTestId('headers')).toHaveTextContent(`${root.id},${oldLeaf.id}`)
    })

    act(() => navigateTo(firstNewLeaf.id))
    act(() => navigateTo(secondNewLeaf.id))

    expect(chatReads.loadMessageHeaders.mock.calls[1]?.[1]?.signal?.aborted).toBe(true)

    await act(async () => {
      secondRead.resolve([root, oldLeaf, firstNewLeaf, secondNewLeaf])
      await secondRead.promise
    })
    await waitFor(() => {
      expect(useChatStore.getState().getCursor(CHAT_ID)?.[cursorKeyOf(root.id)]).toBe(
        secondNewLeaf.id,
      )
    })

    await act(async () => {
      firstRead.resolve([root, oldLeaf, firstNewLeaf])
      await firstRead.promise
    })

    expect(useChatStore.getState().getCursor(CHAT_ID)?.[cursorKeyOf(root.id)]).toBe(
      secondNewLeaf.id,
    )
    expect(window.location.hash).toBe(`#/chat/${CHAT_ID}/message/${secondNewLeaf.id}`)
  })

  it('does not let a pending URL read overwrite a newer in-tab navigation', async () => {
    const freshRead = deferred<MessageHeaderRow[]>()
    chatReads.loadMessageHeaders
      .mockResolvedValueOnce([root, oldLeaf])
      .mockReturnValueOnce(freshRead.promise)

    render(<BranchUrlProbe chatId={CHAT_ID} />)
    await waitFor(() => {
      expect(screen.getByTestId('headers')).toHaveTextContent(`${root.id},${oldLeaf.id}`)
    })

    act(() => navigateTo(firstNewLeaf.id))
    act(() => {
      useChatStore.getState().navigateToCursor(CHAT_ID, {
        [cursorKeyOf(null)]: root.id,
        [cursorKeyOf(root.id)]: oldLeaf.id,
      })
    })

    await act(async () => {
      freshRead.resolve([root, oldLeaf, firstNewLeaf])
      await freshRead.promise
    })

    expect(useChatStore.getState().getCursor(CHAT_ID)?.[cursorKeyOf(root.id)]).toBe(oldLeaf.id)
    expect(window.location.hash).toBe(`#/chat/${CHAT_ID}/message/${oldLeaf.id}`)
  })

  it('does not let a never-settling URL read suppress a newer in-tab navigation', async () => {
    const neverSettles = new Promise<MessageHeaderRow[]>(() => {})
    chatReads.loadMessageHeaders
      .mockResolvedValueOnce([root, oldLeaf, fallbackLeaf])
      .mockReturnValueOnce(neverSettles)

    render(<BranchUrlProbe chatId={CHAT_ID} />)
    await waitFor(() => {
      expect(screen.getByTestId('headers')).toHaveTextContent(
        `${root.id},${oldLeaf.id},${fallbackLeaf.id}`,
      )
      expect(window.location.hash).toBe(`#/chat/${CHAT_ID}/message/${oldLeaf.id}`)
    })

    act(() => navigateTo(firstNewLeaf.id))
    act(() => {
      // A fresh explicit action may intentionally select the same cursor.
      // Its newer opaque intent must still release stale URL suppression.
      useChatStore.getState().navigateToCursor(CHAT_ID, {
        [cursorKeyOf(null)]: root.id,
        [cursorKeyOf(root.id)]: oldLeaf.id,
      })
    })
    await waitFor(() => {
      expect(window.location.hash).toBe(`#/chat/${CHAT_ID}/message/${oldLeaf.id}`)
    })

    act(() => {
      useChatStore.getState().navigateToCursor(CHAT_ID, {
        [cursorKeyOf(null)]: root.id,
        [cursorKeyOf(root.id)]: fallbackLeaf.id,
      })
    })

    await waitFor(() => {
      expect(window.location.hash).toBe(`#/chat/${CHAT_ID}/message/${fallbackLeaf.id}`)
    })
    expect(chatReads.loadMessageHeaders).toHaveBeenCalledTimes(2)
  })

  it('retries a hung URL target when the same deep link is explicitly opened again', async () => {
    const neverSettles = new Promise<MessageHeaderRow[]>(() => {})
    chatReads.loadMessageHeaders
      .mockResolvedValueOnce([root, oldLeaf])
      .mockReturnValueOnce(neverSettles)
      .mockResolvedValueOnce([root, oldLeaf, firstNewLeaf])

    render(<BranchUrlProbe chatId={CHAT_ID} />)
    await waitFor(() => {
      expect(screen.getByTestId('headers')).toHaveTextContent(`${root.id},${oldLeaf.id}`)
    })

    const href = `#/chat/${CHAT_ID}/message/${firstNewLeaf.id}`
    act(() => navigate(href))
    expect(window.location.hash).toBe(href)

    act(() => navigate(href))

    await waitFor(() => {
      expect(useChatStore.getState().getCursor(CHAT_ID)?.[cursorKeyOf(root.id)]).toBe(
        firstNewLeaf.id,
      )
    })
    expect(chatReads.loadMessageHeaders).toHaveBeenCalledTimes(3)
  })

  it('reapplies this tab deep link after workspace replacement reuses message ids', async () => {
    chatReads.loadMessageHeaders
      .mockResolvedValueOnce([root, oldLeaf])
      .mockResolvedValueOnce([root, oldLeaf, firstNewLeaf])

    render(<BranchUrlProbe chatId={CHAT_ID} />)
    await waitFor(() => {
      expect(window.location.hash).toBe(`#/chat/${CHAT_ID}/message/${oldLeaf.id}`)
    })

    act(() => {
      useChatStore.getState().resetForWorkspaceReplacement()
      refreshRouteForWorkspaceReplacement('remote')
    })

    await waitFor(() => {
      expect(useChatStore.getState().getCursor(CHAT_ID)?.[cursorKeyOf(root.id)]).toBe(oldLeaf.id)
    })
    expect(window.location.hash).toBe(`#/chat/${CHAT_ID}/message/${oldLeaf.id}`)
    expect(chatReads.loadMessageHeaders).toHaveBeenCalledTimes(2)
  })

  it('keeps a rejected URL target authoritative until a newer in-tab navigation', async () => {
    const freshRead = deferred<MessageHeaderRow[]>()
    chatReads.loadMessageHeaders
      .mockResolvedValueOnce([root, oldLeaf, fallbackLeaf])
      .mockReturnValueOnce(freshRead.promise)

    render(<BranchUrlProbe chatId={CHAT_ID} />)
    await waitFor(() => {
      expect(screen.getByTestId('headers')).toHaveTextContent(
        `${root.id},${oldLeaf.id},${fallbackLeaf.id}`,
      )
      expect(window.location.hash).toBe(`#/chat/${CHAT_ID}/message/${oldLeaf.id}`)
    })

    act(() => navigateTo(firstNewLeaf.id))
    expect(window.location.hash).toBe(`#/chat/${CHAT_ID}/message/${firstNewLeaf.id}`)

    await act(async () => {
      freshRead.reject(new Error('transient header read failure'))
      await freshRead.promise.catch(() => undefined)
    })

    expect(window.location.hash).toBe(`#/chat/${CHAT_ID}/message/${firstNewLeaf.id}`)

    act(() => {
      useChatStore.getState().navigateToCursor(CHAT_ID, {
        [cursorKeyOf(null)]: root.id,
        [cursorKeyOf(root.id)]: fallbackLeaf.id,
      })
    })
    await waitFor(() => {
      expect(window.location.hash).toBe(`#/chat/${CHAT_ID}/message/${fallbackLeaf.id}`)
    })
    expect(chatReads.loadMessageHeaders).toHaveBeenCalledTimes(2)
  })

  it('keeps the structural projection stable across body-only header revisions', () => {
    const samples: Array<ReturnType<typeof useStableStructuralHeaders>> = []
    function StructuralProbe({ rows }: { rows: readonly MessageHeaderRow[] }) {
      samples.push(useStableStructuralHeaders(rows))
      return null
    }

    const view = render(<StructuralProbe rows={[root, oldLeaf]} />)
    const initial = samples.at(-1)
    expect(initial?.[0]).not.toHaveProperty('bodyVersion')
    expect(initial?.[0]).not.toHaveProperty('nodeVersion')
    expect(initial?.[0]).not.toHaveProperty('textPreview')
    view.rerender(
      <StructuralProbe
        rows={[
          root,
          { ...oldLeaf, bodyVersion: oldLeaf.bodyVersion + 1, textPreview: 'streamed text' },
        ]}
      />,
    )
    expect(samples.at(-1)).toBe(initial)

    view.rerender(
      <StructuralProbe
        rows={[root, { ...oldLeaf, parentId: null, siblingIndex: 1, nodeVersion: 2 }]}
      />,
    )
    expect(samples.at(-1)).not.toBe(initial)
  })

  it('reconciles an arbitrary dangling cursor selection to the observed branch', async () => {
    chatReads.loadMessageHeaders.mockResolvedValue([root, oldLeaf])
    useChatStore.getState().navigateToCursor(CHAT_ID, {
      [cursorKeyOf(null)]: root.id,
      [cursorKeyOf(root.id)]: 'dangling-leaf',
    })

    render(<BranchUrlProbe chatId={CHAT_ID} />)
    await waitFor(() => {
      expect(useChatStore.getState().getCursor(CHAT_ID)?.[cursorKeyOf(root.id)]).toBe(oldLeaf.id)
    })
  })

  it('preserves an exact current pending branch selection through header lag', async () => {
    chatReads.loadMessageHeaders.mockResolvedValue([root, oldLeaf])
    const intent = useChatStore.getState().beginNavigationIntent(CHAT_ID)
    const selections = {
      [cursorKeyOf(null)]: root.id,
      [cursorKeyOf(root.id)]: 'pending-local-leaf',
    }
    expect(
      useChatStore
        .getState()
        .selectPathForIntent(CHAT_ID, intent, selections, [root.id, 'pending-local-leaf']),
    ).toBe(true)

    render(<BranchUrlProbe chatId={CHAT_ID} />)
    await waitFor(() => expect(screen.getByTestId('headers')).toHaveTextContent(oldLeaf.id))
    expect(useChatStore.getState().getCursor(CHAT_ID)?.[cursorKeyOf(root.id)]).toBe(
      'pending-local-leaf',
    )
  })

  it('mirrors the committed path leaf while repository headers are still unavailable', async () => {
    chatReads.loadMessageHeaders.mockReturnValue(new Promise<MessageHeaderRow[]>(() => undefined))
    const store = useChatStore.getState()
    const intent = store.beginNavigationIntent(CHAT_ID)
    const producer = store.registerCommittedPathProducer(CHAT_ID, intent)
    if (!producer) throw new Error('committed path producer registration failed')
    expect(
      store.selectCommittedPathForProducer(
        CHAT_ID,
        producer,
        {
          [cursorKeyOf(null)]: root.id,
          [cursorKeyOf(root.id)]: firstNewLeaf.id,
        },
        {
          phase: 'terminal',
          pathHeaders: [root, firstNewLeaf],
          presentations: [],
        },
      ),
    ).toBe(true)

    render(<BranchUrlProbe chatId={CHAT_ID} />)

    await waitFor(() => {
      expect(window.location.hash).toBe(`#/chat/${CHAT_ID}/message/${firstNewLeaf.id}`)
    })
    expect(screen.getByTestId('headers')).toHaveTextContent('')
  })

  it('never projects an interior operation node as the selected path leaf', async () => {
    chatReads.loadMessageHeaders.mockReturnValue(new Promise<MessageHeaderRow[]>(() => undefined))
    const interior = header({
      id: 'continued-assistant',
      parentId: root.id,
      siblingIndex: 4,
      createdAt: 5,
      role: 'assistant',
    })
    const descendant = header({
      id: 'continued-descendant',
      parentId: interior.id,
      siblingIndex: 0,
      createdAt: 6,
      role: 'user',
    })
    const store = useChatStore.getState()
    const intent = store.beginNavigationIntent(CHAT_ID)
    const producer = store.registerCommittedPathProducer(CHAT_ID, intent)
    if (!producer) throw new Error('committed path producer registration failed')
    expect(
      store.selectCommittedPathForProducer(
        CHAT_ID,
        producer,
        {
          [cursorKeyOf(null)]: root.id,
          [cursorKeyOf(root.id)]: interior.id,
          [cursorKeyOf(interior.id)]: descendant.id,
        },
        {
          phase: 'terminal',
          pathHeaders: [root, interior, descendant],
          presentations: [],
        },
      ),
    ).toBe(true)

    render(<BranchUrlProbe chatId={CHAT_ID} />)

    await waitFor(() => {
      expect(window.location.hash).toBe(`#/chat/${CHAT_ID}/message/${descendant.id}`)
    })
  })

  it('clears a stale repository leaf when a committed delete selects an empty path', async () => {
    chatReads.loadMessageHeaders.mockResolvedValue([root, oldLeaf])
    render(<BranchUrlProbe chatId={CHAT_ID} />)
    await waitFor(() => {
      expect(window.location.hash).toBe(`#/chat/${CHAT_ID}/message/${oldLeaf.id}`)
    })

    const store = useChatStore.getState()
    const intent = store.beginNavigationIntent(CHAT_ID)
    const producer = store.registerCommittedPathProducer(CHAT_ID, intent)
    if (!producer) throw new Error('committed path producer registration failed')
    expect(
      store.patchCursorForIntent(CHAT_ID, intent, {
        [cursorKeyOf(null)]: undefined,
        [cursorKeyOf(root.id)]: undefined,
      }),
    ).toBe(true)
    expect(
      store.selectCommittedPathForProducer(
        CHAT_ID,
        producer,
        {},
        {
          phase: 'terminal',
          pathHeaders: [],
          structuralHeaders: [
            { ...root, deleted: true, nodeVersion: 1 },
            { ...oldLeaf, deleted: true, nodeVersion: 1 },
          ],
          presentations: [],
        },
      ),
    ).toBe(true)

    await waitFor(() => {
      expect(window.location.hash).toBe(`#/chat/${CHAT_ID}`)
    })
    expect(screen.getByTestId('headers')).toHaveTextContent(`${root.id},${oldLeaf.id}`)
  })

  it('bootstraps headers once and merges exact message publications without rescanning the chat', async () => {
    let mutationListener: ((parts: ObservabilitySet) => void) | null = null
    const subscribe: RepositoryMutationSubscriber = (listener) => {
      mutationListener = listener
      return () => {
        if (mutationListener === listener) mutationListener = null
      }
    }
    __setRepositoryMutationSubscriberForTests(subscribe, DATABASE_NAME)

    const rows: MessageHeaderRow[] = [root]
    let parentId = root.id
    for (let index = 1; index < 256; index += 1) {
      const row = header({
        id: `long-chat-${index.toString().padStart(3, '0')}`,
        parentId,
        siblingIndex: 0,
        createdAt: index + 1,
        role: index % 2 === 0 ? 'user' : 'assistant',
      })
      rows.push(row)
      parentId = row.id
    }
    const current = new Map(rows.map((row) => [row.id, row]))
    chatReads.loadMessageHeaders.mockResolvedValue(rows)
    chatReads.loadMessageHeadersById.mockImplementation(async (messageIds) =>
      messageIds.map((messageId) => current.get(messageId)),
    )
    const merges: Array<{ kind: 'full' | 'delta'; rows: number }> = []
    __setBranchHeaderMergeProbeForTests((kind, rowCount) => {
      merges.push({ kind, rows: rowCount })
    })
    let projectionBuilds = 0
    __setBranchProjectionBuildProbeForTests(() => {
      projectionBuilds += 1
    })

    render(<BranchUrlProbe chatId={CHAT_ID} />)
    const target = rows.at(-1) as MessageHeaderRow
    await waitFor(() => expect(screen.getByTestId('headers')).toHaveTextContent(target.id))
    const bootstrapProjectionBuilds = projectionBuilds

    for (let version = 1; version <= 12; version += 1) {
      current.set(target.id, {
        ...(current.get(target.id) as MessageHeaderRow),
        nodeVersion: version,
        textPreview: `stream-${version}`,
      })
      act(() => mutationListener?.(messageMutation(target.id)))
      await waitFor(() =>
        expect(screen.getByTestId('header-versions')).toHaveTextContent(`${target.id}:${version}`),
      )
    }

    expect(chatReads.loadMessageHeaders).toHaveBeenCalledTimes(1)
    expect(chatReads.loadMessageHeadersById).toHaveBeenCalledTimes(12)
    expect(
      chatReads.loadMessageHeadersById.mock.calls.every(
        ([messageIds]) => messageIds.length === 1 && messageIds[0] === target.id,
      ),
    ).toBe(true)
    expect(merges).toEqual([
      { kind: 'full', rows: rows.length },
      ...Array.from({ length: 12 }, () => ({ kind: 'delta' as const, rows: 1 })),
    ])
    expect(projectionBuilds).toBe(bootstrapProjectionBuilds)
  })

  it('falls back to one full header snapshot when a publication lacks exact primary keys', async () => {
    let mutationListener: ((parts: ObservabilitySet) => void) | null = null
    __setRepositoryMutationSubscriberForTests((listener) => {
      mutationListener = listener
      return () => {
        if (mutationListener === listener) mutationListener = null
      }
    }, DATABASE_NAME)
    chatReads.loadMessageHeaders
      .mockResolvedValueOnce([root, oldLeaf])
      .mockResolvedValueOnce([root, oldLeaf, firstNewLeaf])

    render(<BranchUrlProbe chatId={CHAT_ID} />)
    await waitFor(() => expect(screen.getByTestId('headers')).toHaveTextContent(oldLeaf.id))

    act(() =>
      mutationListener?.({
        [`idb://${DATABASE_NAME}/messages/chatId`]: new RangeSet(CHAT_ID),
      }),
    )

    await waitFor(() => expect(screen.getByTestId('headers')).toHaveTextContent(firstNewLeaf.id))
    expect(chatReads.loadMessageHeaders).toHaveBeenCalledTimes(2)
    expect(chatReads.loadMessageHeadersById).not.toHaveBeenCalled()
  })

  it('merges a remote sibling without steering this tab away from its selected leaf', async () => {
    let mutationListener: ((parts: ObservabilitySet) => void) | null = null
    __setRepositoryMutationSubscriberForTests((listener) => {
      mutationListener = listener
      return () => {
        if (mutationListener === listener) mutationListener = null
      }
    }, DATABASE_NAME)
    const current = new Map<string, MessageHeaderRow>([
      [root.id, root],
      [oldLeaf.id, oldLeaf],
    ])
    chatReads.loadMessageHeaders.mockResolvedValue([...current.values()])
    chatReads.loadMessageHeadersById.mockImplementation(async (messageIds) =>
      messageIds.map((messageId) => current.get(messageId)),
    )

    render(<BranchUrlProbe chatId={CHAT_ID} />)
    await waitFor(() => {
      expect(window.location.hash).toBe(`#/chat/${CHAT_ID}/message/${oldLeaf.id}`)
    })

    current.set(firstNewLeaf.id, firstNewLeaf)
    act(() => mutationListener?.(messageMutation(firstNewLeaf.id)))
    await waitFor(() => expect(screen.getByTestId('headers')).toHaveTextContent(firstNewLeaf.id))

    expect(useChatStore.getState().getCursor(CHAT_ID)?.[cursorKeyOf(root.id)]).toBe(oldLeaf.id)
    expect(window.location.hash).toBe(`#/chat/${CHAT_ID}/message/${oldLeaf.id}`)
    expect(chatReads.loadMessageHeaders).toHaveBeenCalledTimes(1)
    expect(chatReads.loadMessageHeadersById).toHaveBeenCalledTimes(1)
  })

  it('keeps the newest-leaf default for the initial authoritative snapshot', async () => {
    chatReads.loadMessageHeaders.mockResolvedValue([root, oldLeaf, firstNewLeaf, secondNewLeaf])

    render(<BranchUrlProbe chatId={CHAT_ID} />)

    await waitFor(() => {
      expect(useChatStore.getState().getCursor(CHAT_ID)?.[cursorKeyOf(root.id)]).toBe(
        secondNewLeaf.id,
      )
      expect(window.location.hash).toBe(`#/chat/${CHAT_ID}/message/${secondNewLeaf.id}`)
    })
  })

  it('pins the earliest child when multiple remote continuations arrive atomically', async () => {
    let mutationListener: ((parts: ObservabilitySet) => void) | null = null
    __setRepositoryMutationSubscriberForTests((listener) => {
      mutationListener = listener
      return () => {
        if (mutationListener === listener) mutationListener = null
      }
    }, DATABASE_NAME)
    const earliestChild = header({
      id: 'url-atomic-earliest',
      parentId: oldLeaf.id,
      siblingIndex: 0,
      createdAt: 5,
      role: 'user',
    })
    const newestChild = header({
      id: 'url-atomic-newest',
      parentId: oldLeaf.id,
      siblingIndex: 1,
      createdAt: 6,
      role: 'user',
    })
    const current = new Map<string, MessageHeaderRow>([
      [root.id, root],
      [oldLeaf.id, oldLeaf],
    ])
    chatReads.loadMessageHeaders.mockResolvedValue([...current.values()])
    chatReads.loadMessageHeadersById.mockImplementation(async (messageIds) =>
      messageIds.map((messageId) => current.get(messageId)),
    )

    render(<BranchUrlProbe chatId={CHAT_ID} />)
    await waitFor(() => {
      expect(window.location.hash).toBe(`#/chat/${CHAT_ID}/message/${oldLeaf.id}`)
    })

    current.set(newestChild.id, newestChild)
    current.set(earliestChild.id, earliestChild)
    act(() =>
      mutationListener?.({
        [`idb://${DATABASE_NAME}/messages/`]: new RangeSet().addKeys([
          newestChild.id,
          earliestChild.id,
        ]),
        [`idb://${DATABASE_NAME}/messages/chatId`]: new RangeSet(CHAT_ID),
      }),
    )
    await waitFor(() => {
      expect(screen.getByTestId('headers')).toHaveTextContent(earliestChild.id)
      expect(screen.getByTestId('headers')).toHaveTextContent(newestChild.id)
    })

    expect(useChatStore.getState().getCursor(CHAT_ID)?.[cursorKeyOf(oldLeaf.id)]).toBe(
      earliestChild.id,
    )
    expect(window.location.hash).toBe(`#/chat/${CHAT_ID}/message/${earliestChild.id}`)
    expect(window.location.hash).not.toContain(newestChild.id)
    expect(chatReads.loadMessageHeaders).toHaveBeenCalledTimes(1)
    expect(chatReads.loadMessageHeadersById).toHaveBeenCalledTimes(1)
  })

  it('keeps normal newest defaults when entering a previously observed unpinned subtree', async () => {
    let mutationListener: ((parts: ObservabilitySet) => void) | null = null
    __setRepositoryMutationSubscriberForTests((listener) => {
      mutationListener = listener
      return () => {
        if (mutationListener === listener) mutationListener = null
      }
    }, DATABASE_NAME)
    const olderBranch = header({
      id: 'url-observed-older-branch',
      parentId: root.id,
      siblingIndex: 0,
      createdAt: 2,
      role: 'assistant',
    })
    const defaultBranch = header({
      id: 'url-observed-default-branch',
      parentId: root.id,
      siblingIndex: 1,
      createdAt: 3,
      role: 'assistant',
    })
    const olderDescendant = header({
      id: 'url-observed-older-descendant',
      parentId: olderBranch.id,
      siblingIndex: 0,
      createdAt: 4,
      role: 'user',
    })
    const newestDescendant = header({
      id: 'url-observed-newest-descendant',
      parentId: olderBranch.id,
      siblingIndex: 1,
      createdAt: 5,
      role: 'user',
    })
    const defaultDescendant = header({
      id: 'url-observed-default-descendant',
      parentId: defaultBranch.id,
      siblingIndex: 0,
      createdAt: 6,
      role: 'user',
    })
    const unrelatedNewChild = header({
      id: 'url-observed-unrelated-new-child',
      parentId: defaultBranch.id,
      siblingIndex: 1,
      createdAt: 7,
      role: 'user',
    })
    const current = new Map<string, MessageHeaderRow>(
      [root, olderBranch, defaultBranch, olderDescendant, newestDescendant, defaultDescendant].map(
        (row) => [row.id, row],
      ),
    )
    chatReads.loadMessageHeaders.mockResolvedValue([...current.values()])
    chatReads.loadMessageHeadersById.mockImplementation(async (messageIds) =>
      messageIds.map((messageId) => current.get(messageId)),
    )

    render(<BranchUrlProbe chatId={CHAT_ID} />)
    await waitFor(() => {
      expect(window.location.hash).toBe(`#/chat/${CHAT_ID}/message/${defaultDescendant.id}`)
    })

    act(() => {
      useChatStore.getState().navigateWithCursorPatch(CHAT_ID, {
        [cursorKeyOf(root.id)]: olderBranch.id,
      })
    })
    await waitFor(() => {
      expect(window.location.hash).toBe(`#/chat/${CHAT_ID}/message/${newestDescendant.id}`)
    })

    current.set(unrelatedNewChild.id, unrelatedNewChild)
    act(() => mutationListener?.(messageMutation(unrelatedNewChild.id)))
    await waitFor(() =>
      expect(screen.getByTestId('headers')).toHaveTextContent(unrelatedNewChild.id),
    )

    expect(useChatStore.getState().getCursor(CHAT_ID)?.[cursorKeyOf(olderBranch.id)]).toBe(
      newestDescendant.id,
    )
    expect(window.location.hash).toBe(`#/chat/${CHAT_ID}/message/${newestDescendant.id}`)
  })

  it('keeps repeated metadata publications delta-bounded after a 100k-header bootstrap', async () => {
    let mutationListener: ((parts: ObservabilitySet) => void) | null = null
    __setRepositoryMutationSubscriberForTests((listener) => {
      mutationListener = listener
      return () => {
        if (mutationListener === listener) mutationListener = null
      }
    }, DATABASE_NAME)
    const rows: MessageHeaderRow[] = []
    let parentId: string | null = null
    for (let index = 0; index < 100_000; index += 1) {
      const row = header({
        id: `budget-${index.toString().padStart(6, '0')}`,
        parentId,
        siblingIndex: 0,
        createdAt: index,
        role: index % 2 === 0 ? 'user' : 'assistant',
      })
      rows.push(row)
      parentId = row.id
    }
    const target = rows.at(-1) as MessageHeaderRow
    let currentTarget = target
    chatReads.loadMessageHeaders.mockResolvedValue(rows)
    chatReads.loadMessageHeadersById.mockImplementation(async (messageIds) =>
      messageIds.map((messageId) => (messageId === target.id ? currentTarget : undefined)),
    )
    const merges: Array<{ kind: 'full' | 'delta'; rows: number }> = []
    __setBranchHeaderMergeProbeForTests((kind, rowCount) => {
      merges.push({ kind, rows: rowCount })
    })
    let projectionBuilds = 0
    __setBranchProjectionBuildProbeForTests(() => {
      projectionBuilds += 1
    })

    render(<BranchHeaderBudgetProbe chatId={CHAT_ID} targetId={target.id} />)
    await waitFor(() => expect(screen.getByTestId('header-budget')).toHaveTextContent('100000:0'))
    const bootstrapProjectionBuilds = projectionBuilds

    for (let version = 1; version <= 24; version += 1) {
      currentTarget = { ...currentTarget, nodeVersion: version, cachedTokenEstimate: version }
      act(() => mutationListener?.(messageMutation(target.id)))
      await waitFor(() =>
        expect(screen.getByTestId('header-budget')).toHaveTextContent(`100000:${version}`),
      )
    }

    expect(chatReads.loadMessageHeaders).toHaveBeenCalledTimes(1)
    expect(chatReads.loadMessageHeadersById).toHaveBeenCalledTimes(24)
    expect(merges).toEqual([
      { kind: 'full', rows: 100_000 },
      ...Array.from({ length: 24 }, () => ({ kind: 'delta' as const, rows: 1 })),
    ])
    expect(projectionBuilds).toBe(bootstrapProjectionBuilds)
  }, 30_000)

  it('builds one shared projection for each ordinary structural header snapshot', async () => {
    let builds = 0
    __setBranchProjectionBuildProbeForTests(() => {
      builds += 1
    })
    chatReads.loadMessageHeaders.mockResolvedValue([root, oldLeaf, fallbackLeaf])
    const view = render(<BranchUrlProbe chatId={CHAT_ID} />)
    await waitFor(() =>
      expect(screen.getByTestId('headers')).toHaveTextContent(
        `${root.id},${oldLeaf.id},${fallbackLeaf.id}`,
      ),
    )
    expect(builds).toBe(2)

    act(() => {
      useChatStore.getState().navigateToCursor(CHAT_ID, {
        [cursorKeyOf(null)]: root.id,
        [cursorKeyOf(root.id)]: fallbackLeaf.id,
      })
    })
    view.rerender(<BranchUrlProbe chatId={CHAT_ID} />)
    expect(builds).toBe(2)
  })
})

function messageMutation(messageId: string): ObservabilitySet {
  return {
    [`idb://${DATABASE_NAME}/messages/`]: new RangeSet(messageId),
    [`idb://${DATABASE_NAME}/messages/chatId`]: new RangeSet(CHAT_ID),
  }
}
