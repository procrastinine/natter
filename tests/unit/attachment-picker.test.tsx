import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ingestAttachmentBytes } from '../../src/store/attachments'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import {
  __resetBrowserRepositoryForTests,
  getBrowserRepository,
} from '../../src/store/browser-repo'
import {
  openBrowserWorkspace,
  shutdownBrowserWorkspace,
} from '../../src/store/browser-workspace-lifecycle'
import { __resetDbForTests } from '../../src/store/db'
import type { AttachmentCatalogSearchRequest } from '../../src/store/repository'
import type { WorkspaceRepository } from '../../src/store/workspace-protocol'
import {
  __resetWorkspaceRepositoryForTests,
  __setWorkspaceRepositoryForTests,
} from '../../src/store/workspace-repository'
import { resetLoadedWorkspaceSessionOwnersForTests } from '../../src/store/workspace-session-owner'
import { AttachmentPicker } from '../../src/ui/attachments/AttachmentPicker'

const DB_NAME = 'natter'

async function resetDb() {
  __resetWorkspaceRepositoryForTests()
  __resetBrowserRepositoryForTests()
  __resetDbForTests()
  __resetBroadcastForTests()
  await Dexie.delete(DB_NAME)
}

function deferred<Value>() {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

afterEach(async () => {
  cleanup()
  resetLoadedWorkspaceSessionOwnersForTests()
  vi.useRealTimers()
  await Promise.resolve()
  vi.restoreAllMocks()
  await shutdownBrowserWorkspace()
  await resetDb()
})

beforeEach(async () => {
  await resetDb()
  resetLoadedWorkspaceSessionOwnersForTests()
  await openBrowserWorkspace()
})

describe('AttachmentPicker', () => {
  it('dismisses on Escape', async () => {
    const onClose = vi.fn()
    await ingestAttachmentBytes({
      blob: new Blob(['x']),
      filename: 'escape.txt',
      declaredMime: 'text/plain',
    })
    render(
      <AttachmentPicker sessionSurface="picker-composer" onClose={onClose} onPick={() => {}} />,
    )
    expect(await screen.findByText('escape.txt')).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('starts the first text search immediately, then debounces and aborts superseded searches', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const calls: Array<{ search: AttachmentCatalogSearchRequest; signal?: AbortSignal }> = []
    const pendingQueries: Promise<never>[] = []
    const target = getBrowserRepository()
    const query = ((permit, command, options) => {
      if (command.kind !== 'attachment.catalog-page') {
        return target.query(permit, command, options)
      }
      calls.push({
        search: command.search,
        ...(options?.signal ? { signal: options.signal } : {}),
      })
      const pending = new Promise<never>((_, reject) => {
        const signal = options?.signal
        if (!signal) return
        const abort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
        if (signal.aborted) abort()
        else signal.addEventListener('abort', abort, { once: true })
      })
      pendingQueries.push(pending)
      return pending
    }) as WorkspaceRepository['query']
    __setWorkspaceRepositoryForTests({
      query,
      execute: target.execute.bind(target),
      replace: target.replace.bind(target),
      subscribeChanges: target.subscribeChanges.bind(target),
    })
    const view = render(
      <AttachmentPicker
        sessionSurface="picker-inline-editor"
        onClose={() => {}}
        onPick={() => {}}
      />,
    )

    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(calls).toHaveLength(1)
    expect(calls[0]?.signal?.aborted).toBe(false)

    fireEvent.change(screen.getByPlaceholderText('Search id, name, MIME, hash, text…'), {
      target: { value: 'a' },
    })
    expect(calls[0]?.signal?.aborted).toBe(false)
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(calls).toHaveLength(2)
    expect(calls[0]?.signal?.aborted).toBe(true)
    expect(calls[1]?.search).toMatchObject({
      query: 'a',
      limit: 80,
      direction: 'forward',
      sort: 'created-desc',
    })

    fireEvent.change(screen.getByPlaceholderText('Search id, name, MIME, hash, text…'), {
      target: { value: 'alpha' },
    })
    expect(calls[1]?.signal?.aborted).toBe(false)

    await act(() => vi.advanceTimersByTimeAsync(149))
    expect(calls).toHaveLength(2)
    expect(calls[1]?.signal?.aborted).toBe(false)
    await act(() => vi.advanceTimersByTimeAsync(1))
    expect(calls).toHaveLength(3)
    expect(calls[1]?.signal?.aborted).toBe(true)
    expect(calls[2]?.search).toMatchObject({
      query: 'alpha',
      limit: 80,
      direction: 'forward',
      sort: 'created-desc',
    })
    expect(calls[2]?.signal?.aborted).toBe(false)

    view.unmount()
    expect(calls[2]?.signal?.aborted).toBe(false)
    resetLoadedWorkspaceSessionOwnersForTests()
    expect(calls[2]?.signal?.aborted).toBe(true)
    await Promise.allSettled(pendingQueries)
    vi.runAllTicks()
  })

  it('keeps a delegated mutation target pending and closes only after its commit', async () => {
    const onClose = vi.fn()
    const work = deferred<void>()
    const onPick = vi.fn(() => work.promise)
    await ingestAttachmentBytes({
      blob: new Blob(['pending']),
      filename: 'pending.txt',
      declaredMime: 'text/plain',
    })
    render(
      <AttachmentPicker
        sessionSurface="picker-message-reference"
        interactionTarget="message:message-1:ref-1"
        onClose={onClose}
        onPick={onPick}
      />,
    )
    const row = await screen.findByRole('button', { name: /pending\.txt/u })

    fireEvent.click(row)

    expect(row).toBeDisabled()
    await waitFor(() => expect(onPick).toHaveBeenCalledOnce())
    expect(onClose).not.toHaveBeenCalled()

    await act(async () => {
      work.resolve()
      await work.promise
    })
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
  })
})
