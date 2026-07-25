import '@testing-library/jest-dom/vitest'
import 'fake-indexeddb/auto'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'
import { getBrowserRepository } from '../src/store/browser-repo'
import { resetMountedRepositoryProjectionsForTests } from '../src/store/mounted-projection-lifecycle'
import { installWorkspaceRepositoryFactory } from '../src/store/workspace-repository'
import { resetLoadedWorkspaceSessionOwnersForTests } from '../src/store/workspace-session-owner'

installWorkspaceRepositoryFactory(getBrowserRepository)

afterEach(() => {
  vi.useRealTimers()
  cleanup()
  resetLoadedWorkspaceSessionOwnersForTests()
  resetMountedRepositoryProjectionsForTests()
})
