import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useToastStore } from '../../src/store/zustand/toastStore'
import { BannerTray } from '../../src/ui/chat/BannerTray'
import { ToastTray } from '../../src/ui/chat/ToastTray'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function flushAction() {
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  vi.useRealTimers()
  useToastStore.getState().reset()
})

describe('notice actions', () => {
  it('keeps a toast pending until undo succeeds and then dismisses it', async () => {
    const result = deferred()
    const undo = vi.fn(() => result.promise)
    useToastStore.getState().push({ level: 'info', text: 'Deleted.', undo })
    render(<ToastTray />)

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))

    expect(undo).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Deleted.').closest('[data-ui="toast"]')).toHaveAttribute(
      'data-state',
      'pending',
    )
    expect(screen.getByRole('button', { name: 'Undoing…' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )

    await act(async () => {
      result.resolve()
      await result.promise
      await flushAction()
    })

    expect(screen.queryByText('Deleted.')).toBeNull()
  })

  it('retains a rejected toast action, reports the error, preserves focus, and permits retry', async () => {
    const undo = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('storage unavailable'))
      .mockResolvedValueOnce(undefined)
    useToastStore.getState().push({ level: 'info', text: 'Deleted.', undo })
    render(<ToastTray />)
    const button = screen.getByRole('button', { name: 'Undo' })
    button.focus()

    await act(async () => {
      fireEvent.click(button)
      await flushAction()
    })

    expect(screen.getByText('Deleted.')).toBeInTheDocument()
    expect(screen.getByText('Action failed. Try again.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Undo' })).toHaveFocus()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
      await flushAction()
    })

    expect(undo).toHaveBeenCalledTimes(2)
    expect(screen.queryByText('Deleted.')).toBeNull()
  })

  it('blocks duplicate toast activation and pauses auto-dismiss while the action is unsettled', async () => {
    vi.useFakeTimers()
    const result = deferred()
    const undo = vi.fn(() => result.promise)
    useToastStore.getState().push({ level: 'info', text: 'Deleted.', undo, durationMs: 100 })
    render(<ToastTray />)
    const button = screen.getByRole('button', { name: 'Undo' })

    fireEvent.click(button)
    fireEvent.click(button)
    await act(async () => vi.advanceTimersByTime(10_000))

    expect(undo).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Deleted.')).toBeInTheDocument()

    await act(async () => {
      result.resolve()
      await result.promise
      await flushAction()
    })

    expect(screen.queryByText('Deleted.')).toBeNull()
  })

  it('awaits a banner action, exposes pending state, and blocks double activation', async () => {
    const result = deferred()
    const action = vi.fn(() => result.promise)
    useToastStore.getState().pushBanner({
      kind: 'mutation-conflict',
      text: 'Conflict.',
      primary: { label: 'Retry', action },
    })
    render(<BannerTray />)
    const button = screen.getByRole('button', { name: 'Retry' })

    fireEvent.click(button)
    fireEvent.click(button)

    expect(action).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Conflict.').closest('[data-ui="banner"]')).toHaveAttribute(
      'data-state',
      'pending',
    )
    expect(screen.getByRole('button', { name: 'Working…' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )

    await act(async () => {
      result.resolve()
      await result.promise
      await flushAction()
    })

    expect(screen.queryByText('Conflict.')).toBeNull()
  })

  it('retains a rejected banner action with focused retry and dismisses only after retry succeeds', async () => {
    const action = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('conflict remained'))
      .mockResolvedValueOnce(undefined)
    useToastStore.getState().pushBanner({
      kind: 'mutation-conflict',
      text: 'Conflict.',
      primary: { label: 'Retry', action },
    })
    render(<BannerTray />)
    const button = screen.getByRole('button', { name: 'Retry' })
    button.focus()

    await act(async () => {
      fireEvent.click(button)
      await flushAction()
    })

    expect(screen.getByText('Conflict.')).toBeInTheDocument()
    expect(screen.getByText('Action failed. Try again.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toHaveFocus()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
      await flushAction()
    })

    expect(action).toHaveBeenCalledTimes(2)
    expect(screen.queryByText('Conflict.')).toBeNull()
  })
})
