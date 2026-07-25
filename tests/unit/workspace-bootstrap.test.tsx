import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode, useEffect, useLayoutEffect } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceBootstrap, type WorkspaceOpenOptions } from '../../src/app/WorkspaceBootstrap'
import { DEFAULT_SEARCH_FILTERS, useChatCatalogSearch } from '../../src/hooks/useCatalogApplication'
import { StorageAdministration } from '../../src/store/storage-administration'
import { suspendWorkspacePresentation } from '../../src/store/workspace-presentation-lifecycle'
import {
  disposeLoadedWorkspaceSessionOwners,
  resetLoadedWorkspaceSessionOwnersForTests,
} from '../../src/store/workspace-session-owner'

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
  it('acknowledges readiness only after the opened presentation commits', async () => {
    const events: string[] = []
    function Presentation() {
      useLayoutEffect(() => {
        events.push('presentation-committed')
      }, [])
      return <div>Ready presentation</div>
    }

    render(
      <WorkspaceBootstrap
        openWorkspace={() => Promise.resolve()}
        onReady={() => events.push('workspace-ready')}
      >
        <Presentation />
      </WorkspaceBootstrap>,
    )

    expect(await screen.findByText('Ready presentation')).toBeVisible()
    await waitFor(() => expect(events).toEqual(['presentation-committed', 'workspace-ready']))
  })

  it('keeps the application shell mounted and interactive while the workspace opens', async () => {
    const opening = deferred<void>()
    const onClick = vi.fn()
    render(
      <WorkspaceBootstrap openWorkspace={() => opening.promise}>
        <button type="button" onClick={onClick}>
          Application control
        </button>
      </WorkspaceBootstrap>,
    )

    expect(screen.getByRole('status')).toHaveTextContent('Opening local workspace')
    fireEvent.click(screen.getByRole('button', { name: 'Application control' }))
    expect(onClick).toHaveBeenCalledTimes(1)

    await act(async () => opening.resolve())
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Application control' })).toBeVisible()
  })

  it('reports the exact opening owner and bounded migration progress without polling', async () => {
    const opening = deferred<void>()
    let onProgress: WorkspaceOpenOptions['onProgress']
    render(
      <WorkspaceBootstrap
        openWorkspace={(options) => {
          onProgress = options.onProgress
          return opening.promise
        }}
      >
        <div>Progress workspace</div>
      </WorkspaceBootstrap>,
    )

    await waitFor(() => expect(onProgress).toBeTypeOf('function'))
    act(() => {
      onProgress?.({
        kind: 'database-selection',
        operation: 'acquire-active-slot',
        databaseName: 'natter-workspace-b',
      })
    })
    const bootstrap = screen.getByRole('status').closest('[data-ui="workspace-bootstrap"]')
    expect(bootstrap).toHaveAttribute('data-open-stage', 'database-selection')
    expect(bootstrap).toHaveAttribute('data-open-operation', 'acquire-active-slot')
    expect(
      screen.getByText(/Opening the active workspace slot \(natter-workspace-b\)/u),
    ).toBeVisible()

    act(() => {
      onProgress?.({
        kind: 'database-upgrade',
        databaseName: 'natter-workspace-b',
        fromVersion: 94,
        targetVersion: 95,
        phase: 'messages-and-attachments',
        operation: 'normalize-message-pairs',
        processedRows: 4096,
        processedBytes: 8_388_608,
      })
    })
    expect(screen.getByText(/Processed 4,096 rows/u)).toBeVisible()
    expect(screen.getByLabelText('Opening diagnostics')).toHaveTextContent(
      '"phase": "messages-and-attachments"',
    )
    expect(screen.getByLabelText('Opening diagnostics')).toHaveTextContent('"processedRows": 4096')

    await act(async () => opening.resolve())
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
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

  it('unmounts mounted catalog consumers before clear disposes terminal session owners', async () => {
    const events: string[] = []
    function CatalogConsumer() {
      useChatCatalogSearch({
        surface: 'sidebar',
        query: '',
        scope: 'last-updated-branch',
        filters: DEFAULT_SEARCH_FILTERS,
        enabled: false,
      })
      useEffect(
        () => () => {
          events.push('catalog-consumer-cleanup')
        },
        [],
      )
      return <div>Mounted catalog consumer</div>
    }
    render(
      <StrictMode>
        <WorkspaceBootstrap openWorkspace={() => Promise.resolve()}>
          <CatalogConsumer />
        </WorkspaceBootstrap>
      </StrictMode>,
    )

    expect(await screen.findByText('Mounted catalog consumer')).toBeVisible()
    events.length = 0
    const administration = new StorageAdministration({
      clientId: 'strict-mode-tab',
      transport: { subscribe: () => () => {}, post: () => {} },
      barrier: {
        ready: async () => {},
        releasePresence: async () => {},
        runExclusive: async (operation) => operation(),
      },
      quiesce: async () => {},
      terminalize: async () => {
        await suspendWorkspacePresentation()
        events.push('presentation-suspended')
        disposeLoadedWorkspaceSessionOwners()
        events.push('session-owners-disposed')
      },
      resume: async () => {},
      wipe: async () => ({
        deletedDatabaseNames: [],
        deletedCacheNames: [],
        deletedOpfsEntryNames: [],
        deletedStorageBucketNames: [],
        unregisteredServiceWorkerScopes: [],
      }),
      recreateAndVerify: async () => {},
      clearSessionStorage: () => {},
      reload: () => {},
    })
    let clearing!: Promise<unknown>
    act(() => {
      clearing = administration.clearAll({ skipReload: true })
    })

    expect(await screen.findByRole('heading', { name: 'Closing local workspace…' })).toBeVisible()
    await act(async () => clearing)
    expect(screen.queryByText('Mounted catalog consumer')).not.toBeInTheDocument()
    expect(events).toEqual([
      'catalog-consumer-cleanup',
      'presentation-suspended',
      'session-owners-disposed',
    ])
    resetLoadedWorkspaceSessionOwnersForTests()
  })

  it('shows a non-destructive recovery view and retries a rejected open', async () => {
    const openWorkspace = vi
      .fn<(options: WorkspaceOpenOptions) => Promise<void>>()
      .mockRejectedValueOnce(Object.assign(new Error('private detail'), { name: 'VersionError' }))
      .mockResolvedValueOnce()
    render(
      <WorkspaceBootstrap openWorkspace={openWorkspace}>
        <div>Recovered workspace</div>
      </WorkspaceBootstrap>,
    )

    expect(
      await screen.findByRole('heading', { name: 'This workspace needs a newer Natter version' }),
    ).toBeVisible()
    expect(screen.getByText(/did not reset your workspace/u)).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Recovered workspace')).toBeVisible()
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
