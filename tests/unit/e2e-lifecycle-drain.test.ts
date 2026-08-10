import { describe, expect, it, vi } from 'vitest'
import { type LifecycleDrainPage, navigatePagesForLifecycleDrain } from '../e2e/lifecycle-drain'

function createPage(options: {
  navigationError?: unknown
  reachedUrl: string
  markerAttaches?: boolean
}) {
  let currentUrl = 'http://127.0.0.1:31515/#/chat/example'
  let markerAttached = false
  const goto = vi.fn(async (url: string) => {
    currentUrl = options.reachedUrl
    if ('navigationError' in options) throw options.navigationError
    return url
  })
  const setContent = vi.fn(async () => {
    markerAttached = options.markerAttaches ?? true
  })
  const waitFor = vi.fn(async () => {
    if (!markerAttached) throw new Error('RuntimeDiagnosticDrainMarkerMissing')
  })
  const page: LifecycleDrainPage = {
    goto,
    isClosed: () => false,
    locator: (selector) => {
      expect(selector).toBe('[data-e2e-lifecycle-drain]')
      return { waitFor }
    },
    setContent,
    url: () => currentUrl,
  }
  return { goto, page, setContent, waitFor }
}

describe('browser lifecycle drain', () => {
  it('commits one browser-owned drain document and verifies its marker', async () => {
    const fixture = createPage({ reachedUrl: 'about:blank' })

    await navigatePagesForLifecycleDrain([fixture.page])

    expect(fixture.goto).toHaveBeenCalledOnce()
    expect(fixture.goto).toHaveBeenCalledWith('about:blank', { waitUntil: 'commit' })
    expect(fixture.setContent).toHaveBeenCalledOnce()
    expect(fixture.waitFor).toHaveBeenCalledOnce()
  })

  it('uses the exact reached document when the transport promise rejects after commit', async () => {
    const fixture = createPage({
      navigationError: new Error('BrowserNavigationPromiseRejected'),
      reachedUrl: 'about:blank',
    })

    await navigatePagesForLifecycleDrain([fixture.page])

    expect(fixture.goto).toHaveBeenCalledOnce()
    expect(fixture.setContent).toHaveBeenCalledOnce()
    expect(fixture.waitFor).toHaveBeenCalledOnce()
  })

  it('preserves the navigation failure when the drain document was not reached', async () => {
    const navigationError = new Error('BrowserNavigationPromiseRejected')
    const fixture = createPage({
      navigationError,
      reachedUrl: 'http://127.0.0.1:31515/#/chat/example',
    })

    await expect(navigatePagesForLifecycleDrain([fixture.page])).rejects.toBe(navigationError)

    expect(fixture.goto).toHaveBeenCalledOnce()
    expect(fixture.setContent).not.toHaveBeenCalled()
    expect(fixture.waitFor).not.toHaveBeenCalled()
  })

  it('wraps a non-Error rejection without losing its diagnostic cause', async () => {
    const fixture = createPage({
      navigationError: 'BrowserNavigationPrimitiveRejection',
      reachedUrl: 'http://127.0.0.1:31515/#/chat/example',
    })

    await expect(navigatePagesForLifecycleDrain([fixture.page])).rejects.toMatchObject({
      cause: 'BrowserNavigationPrimitiveRejection',
      message: 'RuntimeDiagnosticLifecycleDrainRejected',
    })

    expect(fixture.goto).toHaveBeenCalledOnce()
    expect(fixture.setContent).not.toHaveBeenCalled()
    expect(fixture.waitFor).not.toHaveBeenCalled()
  })
})
