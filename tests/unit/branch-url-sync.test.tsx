import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import type { ObservabilitySet } from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { navigate, refreshRouteForWorkspaceReplacement } from '../../src/app/router'
import { cursorKeyOf } from '../../src/core/active-path'
import type { ChatId, Message } from '../../src/core/types'
import {
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
}))

vi.mock('../../src/store/chats', () => ({
  loadMessageHeaders: chatReads.loadMessageHeaders,
}))

const CHAT_ID = 'branch-url-chat'

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
  const { headers } = useBranchUrlSync(chatId)
  return <output data-testid="headers">{headers.map((row) => row.id).join(',')}</output>
}

function navigateTo(messageId: string) {
  window.history.replaceState(null, '', `#/chat/${CHAT_ID}/message/${messageId}`)
  window.dispatchEvent(new HashChangeEvent('hashchange'))
}

describe('branch URL synchronization', () => {
  beforeEach(() => {
    useChatStore.getState().reset()
    chatReads.loadMessageHeaders.mockReset()
    __setRepositoryMutationSubscriberForTests(silentChanges, 'branch-url-sync-test')
    window.history.replaceState(null, '', `#/chat/${CHAT_ID}`)
  })

  afterEach(() => {
    cleanup()
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
      .mockReturnValueOnce(publishedHeaders.promise)
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
