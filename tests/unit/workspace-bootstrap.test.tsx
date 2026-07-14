import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceBootstrap, type WorkspaceOpenOptions } from '../../src/app/WorkspaceBootstrap'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('WorkspaceBootstrap', () => {
  it('renders a boot shell immediately and mounts the app after the workspace opens', async () => {
    const opening = deferred<void>()
    render(
      <WorkspaceBootstrap openWorkspace={() => opening.promise}>
        <div>Ready workspace</div>
      </WorkspaceBootstrap>,
    )

    expect(screen.getByRole('status')).toHaveTextContent('Opening local workspace')
    expect(screen.queryByText('Ready workspace')).not.toBeInTheDocument()

    await act(async () => opening.resolve())
    expect(await screen.findByText('Ready workspace')).toBeVisible()
  })

  it('shares one open attempt across StrictMode effect replay', async () => {
    const openWorkspace = vi.fn().mockResolvedValue(undefined)
    render(
      <StrictMode>
        <WorkspaceBootstrap openWorkspace={openWorkspace}>
          <div>Strict workspace</div>
        </WorkspaceBootstrap>
      </StrictMode>,
    )

    expect(await screen.findByText('Strict workspace')).toBeVisible()
    expect(openWorkspace).toHaveBeenCalledTimes(1)
  })

  it('shows a non-destructive recovery view and retries a rejected open', async () => {
    const beforeRetry = vi.fn()
    const openWorkspace = vi
      .fn<(options: WorkspaceOpenOptions) => Promise<void>>()
      .mockRejectedValueOnce(Object.assign(new Error('private detail'), { name: 'VersionError' }))
      .mockResolvedValueOnce()
    render(
      <WorkspaceBootstrap openWorkspace={openWorkspace} beforeRetry={beforeRetry}>
        <div>Recovered workspace</div>
      </WorkspaceBootstrap>,
    )

    expect(
      await screen.findByRole('heading', { name: 'This workspace needs a newer Natter version' }),
    ).toBeVisible()
    expect(screen.getByText(/did not reset your workspace/u)).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Recovered workspace')).toBeVisible()
    expect(beforeRetry).toHaveBeenCalledTimes(1)
    expect(openWorkspace).toHaveBeenCalledTimes(2)
  })

  it('shows a real blocked-upgrade state and continues when the same open resolves', async () => {
    const opening = deferred<void>()
    let onBlocked: WorkspaceOpenOptions['onBlocked']
    render(
      <WorkspaceBootstrap
        openWorkspace={(options) => {
          onBlocked = options.onBlocked
          return opening.promise
        }}
      >
        <div>Unblocked workspace</div>
      </WorkspaceBootstrap>,
    )

    await waitFor(() => expect(onBlocked).toBeTypeOf('function'))
    act(() => {
      onBlocked?.({ oldVersion: 220, newVersion: 230 } as IDBVersionChangeEvent)
    })
    expect(screen.getByRole('heading', { name: 'Workspace upgrade is waiting' })).toBeVisible()
    expect(screen.getByText(/Close it; this page will continue automatically/u)).toBeVisible()

    await act(async () => opening.resolve())
    expect(await screen.findByText('Unblocked workspace')).toBeVisible()
  })

  it('copies bounded diagnostics without exposing error messages or sensitive fields', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const error = Object.assign(new Error('apiKey=do-not-copy'), {
      name: 'QuotaExceededError',
      apiKey: 'do-not-copy',
    })
    render(
      <WorkspaceBootstrap openWorkspace={() => Promise.reject(error)}>
        <div>Never mounted</div>
      </WorkspaceBootstrap>,
    )

    expect(
      await screen.findByRole('heading', { name: 'Local storage is unavailable or full' }),
    ).toBeVisible()
    const displayed = screen.getByLabelText('Redacted diagnostics').textContent
    expect(displayed).toContain('QuotaExceededError')
    expect(displayed).not.toContain('do-not-copy')

    fireEvent.click(screen.getByRole('button', { name: 'Copy diagnostics' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(displayed))
    expect(await screen.findByRole('button', { name: 'Copied diagnostics' })).toBeVisible()
  })

  it('keeps destructive reset behind a disclosure and confirmation', async () => {
    const resetWorkspace = vi.fn().mockRejectedValue(new Error('blocked'))
    const reload = vi.fn()
    render(
      <WorkspaceBootstrap
        openWorkspace={() => Promise.reject(new Error('open failed'))}
        resetWorkspace={resetWorkspace}
        reload={reload}
      >
        <div>Never mounted</div>
      </WorkspaceBootstrap>,
    )

    await screen.findByRole('heading', { name: 'Natter could not open the local workspace' })
    expect(screen.queryByRole('button', { name: 'Reset local data' })).not.toBeVisible()
    fireEvent.click(screen.getByText('Last resort'))
    fireEvent.click(screen.getByRole('button', { name: 'Reset local data' }))

    const cancel = screen.getByRole('button', { name: 'Cancel' })
    expect(cancel).toHaveFocus()
    fireEvent.click(cancel)
    expect(resetWorkspace).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Reset local data' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reset everything' }))
    expect(await screen.findByText(/Reset did not complete/u)).toBeVisible()
    expect(resetWorkspace).toHaveBeenCalledTimes(1)
    expect(reload).not.toHaveBeenCalled()
  })

  it('catches a root render failure and can retry rendering without reopening storage', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let shouldThrow = true
    function FlakyRoot() {
      if (shouldThrow) throw new Error('render failed')
      return <div>Rendered after retry</div>
    }
    const openWorkspace = vi.fn().mockResolvedValue(undefined)
    render(
      <WorkspaceBootstrap openWorkspace={openWorkspace}>
        <FlakyRoot />
      </WorkspaceBootstrap>,
    )

    expect(
      await screen.findByRole('heading', { name: 'Natter could not render the workspace' }),
    ).toBeVisible()
    shouldThrow = false
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Rendered after retry')).toBeVisible()
    expect(openWorkspace).toHaveBeenCalledTimes(1)
  })
})
