import { act, fireEvent, render, screen } from '@testing-library/react'
import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ingestAttachmentBytes } from '../../src/store/attachments'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import { __resetBrowserRepositoryForTests } from '../../src/store/browser-repo'
import { __resetDbForTests } from '../../src/store/db'
import type { AttachmentSearchQuery, WorkspaceRepository } from '../../src/store/repository'
import {
  __resetWorkspaceRepositoryForTests,
  __setWorkspaceRepositoryForTests,
} from '../../src/store/workspace-repository'
import { AttachmentPicker } from '../../src/ui/attachments/AttachmentPicker'

const DB_NAME = 'natter'

async function resetDb() {
  __resetWorkspaceRepositoryForTests()
  __resetBrowserRepositoryForTests()
  __resetDbForTests()
  __resetBroadcastForTests()
  await Dexie.delete(DB_NAME)
}

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await resetDb()
})

beforeEach(async () => {
  await resetDb()
})

describe('AttachmentPicker', () => {
  it('dismisses on Escape', async () => {
    const onClose = vi.fn()
    await ingestAttachmentBytes({
      blob: new Blob(['x']),
      filename: 'escape.txt',
      declaredMime: 'text/plain',
    })
    render(<AttachmentPicker onClose={onClose} onPick={() => {}} />)
    expect(await screen.findByText('escape.txt')).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('starts the first text search immediately, then debounces and aborts superseded searches', async () => {
    vi.useFakeTimers()
    const queries: AttachmentSearchQuery[] = []
    const searchAttachments = vi.fn((query: AttachmentSearchQuery = {}) => {
      queries.push(query)
      return new Promise<{ rows: [] }>(() => {})
    })
    __setWorkspaceRepositoryForTests({ searchAttachments } as unknown as WorkspaceRepository)
    const view = render(<AttachmentPicker onClose={() => {}} onPick={() => {}} />)

    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(searchAttachments).toHaveBeenCalledTimes(1)
    expect(queries[0]?.signal?.aborted).toBe(false)

    fireEvent.change(screen.getByPlaceholderText('Search id, name, MIME, hash, text…'), {
      target: { value: 'a' },
    })
    expect(queries[0]?.signal?.aborted).toBe(true)
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(searchAttachments).toHaveBeenCalledTimes(2)
    expect(queries[1]).toMatchObject({ query: 'a', limit: 80, sort: 'created-desc' })

    fireEvent.change(screen.getByPlaceholderText('Search id, name, MIME, hash, text…'), {
      target: { value: 'alpha' },
    })
    expect(queries[1]?.signal?.aborted).toBe(true)

    await act(() => vi.advanceTimersByTimeAsync(149))
    expect(searchAttachments).toHaveBeenCalledTimes(2)
    await act(() => vi.advanceTimersByTimeAsync(1))
    expect(searchAttachments).toHaveBeenCalledTimes(3)
    expect(queries[2]).toMatchObject({ query: 'alpha', limit: 80, sort: 'created-desc' })
    expect(queries[2]?.signal?.aborted).toBe(false)

    view.unmount()
    expect(queries[2]?.signal?.aborted).toBe(true)
  })
})
