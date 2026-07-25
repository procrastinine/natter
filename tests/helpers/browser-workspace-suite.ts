import { afterAll } from 'vitest'
import {
  openBrowserWorkspace,
  shutdownBrowserWorkspace,
} from '../../src/store/browser-workspace-lifecycle'

export interface BrowserWorkspaceSuiteOwner {
  open(): Promise<void>
  dispose(): Promise<void>
}

export interface BrowserWorkspaceSuiteCapabilities {
  open(): Promise<void>
  shutdown(): Promise<void>
}

const browserWorkspaceSuiteCapabilities: BrowserWorkspaceSuiteCapabilities = Object.freeze({
  open: openBrowserWorkspace,
  shutdown: shutdownBrowserWorkspace,
})

export function createBrowserWorkspaceSuiteOwner(
  capabilities: BrowserWorkspaceSuiteCapabilities = browserWorkspaceSuiteCapabilities,
): BrowserWorkspaceSuiteOwner {
  let opened = false
  let disposed = false
  let opening: Promise<void> | null = null
  let disposal: Promise<void> | null = null

  const open = (): Promise<void> => {
    if (disposed) return Promise.reject(new Error('BrowserWorkspaceSuiteOwnerDisposed'))
    if (opened) return Promise.resolve()
    if (opening) return opening
    opening = capabilities
      .open()
      .then(() => {
        opened = true
      })
      .finally(() => {
        opening = null
      })
    return opening
  }

  const dispose = (): Promise<void> => {
    if (disposal) return disposal
    disposed = true
    const admittedOpen = opening
    const pending = (async () => {
      let openFailed = false
      let openFailure: unknown
      try {
        await admittedOpen
      } catch (error) {
        openFailed = true
        openFailure = error
      }
      if (opened) {
        await capabilities.shutdown()
        opened = false
      }
      if (openFailed) throw openFailure
    })()
    disposal = pending
    return pending
  }

  return Object.freeze({ open, dispose })
}

export function ownBrowserWorkspaceSuite(): BrowserWorkspaceSuiteOwner {
  const owner = createBrowserWorkspaceSuiteOwner()
  afterAll(() => owner.dispose())
  return owner
}
