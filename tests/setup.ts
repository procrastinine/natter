import '@testing-library/jest-dom/vitest'
import 'fake-indexeddb/auto'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'
import { getBrowserRepository } from '../src/store/browser-repo'
import { installWorkspacePresentationForegroundDemandPort } from '../src/store/conversation-route-owner'
import { resetMountedRepositoryProjectionsForTests } from '../src/store/mounted-projection-lifecycle'
import { installWorkspaceRepositoryFactory } from '../src/store/workspace-repository'
import {
  claimWorkspaceForegroundDemand,
  releaseWorkspaceForegroundDemand,
} from '../src/store/workspace-runtime'
import { resetLoadedWorkspaceSessionOwnersForTests } from '../src/store/workspace-session-owner'

installWorkspaceRepositoryFactory(getBrowserRepository)
installWorkspacePresentationForegroundDemandPort({
  claim: () => {
    const owner = claimWorkspaceForegroundDemand()
    let released = false
    return Object.freeze({
      release: () => {
        if (released) return
        released = true
        releaseWorkspaceForegroundDemand(owner)
      },
    })
  },
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  resetLoadedWorkspaceSessionOwnersForTests()
  resetMountedRepositoryProjectionsForTests()
})
