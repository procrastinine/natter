import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { EmptyState } from '../../src/ui/chat/EmptyState'
import { __resetBroadcastForTests } from '../../src/store/broadcast'

beforeEach(() => {
  ;(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory()
  __resetBroadcastForTests()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('EmptyState', () => {
  it('renders sample prompts and populates the composer via the callback', async () => {
    const onPick = vi.fn()
    render(<EmptyState onPick={onPick} />)
    await waitFor(() => {
      expect(screen.getByText(/Explain like I'm five/i)).toBeTruthy()
    })
    fireEvent.click(screen.getByText(/Explain like I'm five/i))
    expect(onPick).toHaveBeenCalledTimes(1)
    expect(onPick.mock.calls[0]?.[0]).toMatch(/TCP congestion control/i)
  })

  it('dismissed state hides the prompt grid and offers a restore button', async () => {
    const onPick = vi.fn()
    render(<EmptyState onPick={onPick} />)
    await waitFor(() => {
      expect(screen.getByText(/Dismiss sample prompts/i)).toBeTruthy()
    })
    fireEvent.click(screen.getByText(/Dismiss sample prompts/i))
    await waitFor(() => {
      expect(screen.queryByText(/Explain like I'm five/i)).toBeNull()
      expect(screen.getByText(/Show sample prompts/i)).toBeTruthy()
    })
  })
})
