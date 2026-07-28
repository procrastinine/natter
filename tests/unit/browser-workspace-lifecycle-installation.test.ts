import { expect, it } from 'vitest'
import {
  installBrowserWorkspaceLifecycle,
  shutdownBrowserWorkspace,
} from '../../src/store/browser-workspace-lifecycle'
import {
  disposeBrowserWorkspaceSlotCoordinator,
  installBrowserWorkspaceSlotCoordinator,
} from '../../src/store/browser-workspace-slot-coordination'
import { catalogSessionWorkspace } from '../../src/store/catalog-session-workspace'
import {
  claimBrowserWorkspaceFatalInvalidationOwner,
  releaseBrowserWorkspaceFatalInvalidationOwner,
} from '../../src/store/db'
import { registerWorkspacePresentationRoot } from '../../src/store/workspace-presentation-lifecycle'
import {
  claimWorkspaceRuntimeDemandBoundary,
  releaseWorkspaceRuntimeDemandBoundary,
} from '../../src/store/workspace-runtime'
import {
  getWorkspaceRuntimeResourceStatuses,
  WORKSPACE_RUNTIME_RESOURCE_IDS,
} from '../../src/store/workspace-runtime-control'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

it('installs the browser workspace lifecycle atomically and rolls back exact owners', async () => {
  const incumbent = installBrowserWorkspaceSlotCoordinator({
    validateQuiesce: async () => true,
    reconcile: async () => {},
  })
  expect(() => installBrowserWorkspaceLifecycle()).toThrow(
    'BrowserWorkspaceSlotCoordinatorAlreadyInstalled',
  )
  expect(getWorkspaceRuntimeResourceStatuses()).toEqual([])

  const demandProbe = claimWorkspaceRuntimeDemandBoundary(async () => {})
  releaseWorkspaceRuntimeDemandBoundary(demandProbe)
  const fatalProbe = claimBrowserWorkspaceFatalInvalidationOwner(() => {})
  releaseBrowserWorkspaceFatalInvalidationOwner(fatalProbe)

  disposeBrowserWorkspaceSlotCoordinator(incumbent)
  installBrowserWorkspaceLifecycle()
  expect(getWorkspaceRuntimeResourceStatuses()).toHaveLength(WORKSPACE_RUNTIME_RESOURCE_IDS.length)
  expect(() => installBrowserWorkspaceLifecycle()).not.toThrow()

  const presentation = deferred()
  let suspensionCount = 0
  const unregisterPresentation = registerWorkspacePresentationRoot(async () => {
    suspensionCount += 1
    await presentation.promise
  })
  const catalogSession = catalogSessionWorkspace.chatSearchFor('sidebar')
  const shutdown = shutdownBrowserWorkspace({ terminal: true })
  const joinedShutdown = shutdownBrowserWorkspace({ terminal: true })
  await Promise.resolve()

  expect(joinedShutdown).toBe(shutdown)
  expect(suspensionCount).toBe(1)
  expect(catalogSessionWorkspace.chatSearchFor('sidebar')).toBe(catalogSession)
  expect(() => claimBrowserWorkspaceFatalInvalidationOwner(() => {})).toThrow()

  presentation.resolve()
  await Promise.all([shutdown, joinedShutdown])
  unregisterPresentation()

  expect(() => catalogSessionWorkspace.chatSearchFor('sidebar')).toThrow(
    'CatalogSessionWorkspaceDisposed',
  )
  await shutdownBrowserWorkspace({ terminal: true })
  expect(suspensionCount).toBe(1)
  const releasedFatalOwner = claimBrowserWorkspaceFatalInvalidationOwner(() => {})
  releaseBrowserWorkspaceFatalInvalidationOwner(releasedFatalOwner)
})
