import { describe, expect, it, vi } from 'vitest'
import { type LifecycleDrainPage, navigatePagesForLifecycleDrain } from '../e2e/lifecycle-drain'

function createPage(options: {
  navigationError?: unknown
  reachedUrl: string
  attempts?: readonly {
    reachedUrl: string
    navigationError?: unknown
  }[]
  markerAttaches?: boolean
}) {
  let currentUrl = 'http://127.0.0.1:31515/#/chat/example'
  let markerAttached = false
  let attemptIndex = 0
  const goto = vi.fn(async (url: string) => {
    const attempt = options.attempts?.[attemptIndex]
    attemptIndex += 1
    currentUrl = attempt?.reachedUrl ?? options.reachedUrl
    if (attempt && 'navigationError' in attempt) throw attempt.navigationError
    if (!attempt && 'navigationError' in options) throw options.navigationError
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
      reachedUrl: 'http://127.0.0.1:31515/#/chat/example',
      attempts: [
        {
          reachedUrl: 'http://127.0.0.1:31515/#/chat/example',
          navigationError,
        },
        { reachedUrl: 'http://127.0.0.1:31515/#/chat/example' },
      ],
    })

    await expect(navigatePagesForLifecycleDrain([fixture.page])).rejects.toBe(navigationError)

    expect(fixture.goto).toHaveBeenCalledTimes(2)
    expect(fixture.setContent).not.toHaveBeenCalled()
    expect(fixture.waitFor).not.toHaveBeenCalled()
  })

  it('wraps a non-Error rejection without losing its diagnostic cause', async () => {
    const fixture = createPage({
      reachedUrl: 'http://127.0.0.1:31515/#/chat/example',
      attempts: [
        {
          reachedUrl: 'http://127.0.0.1:31515/#/chat/example',
          navigationError: 'BrowserNavigationPrimitiveRejection',
        },
        { reachedUrl: 'http://127.0.0.1:31515/#/chat/example' },
      ],
    })

    await expect(navigatePagesForLifecycleDrain([fixture.page])).rejects.toMatchObject({
      cause: 'BrowserNavigationPrimitiveRejection',
      message: 'RuntimeDiagnosticLifecycleDrainRejected',
    })

    expect(fixture.goto).toHaveBeenCalledTimes(2)
    expect(fixture.setContent).not.toHaveBeenCalled()
    expect(fixture.waitFor).not.toHaveBeenCalled()
  })

  it('retries one pre-commit navigation collision and still verifies the drain document', async () => {
    const navigationError = new Error('NS_BINDING_ABORTED')
    const fixture = createPage({
      reachedUrl: 'about:blank',
      attempts: [
        {
          reachedUrl: 'http://127.0.0.1:31515/#/chat/example',
          navigationError,
        },
        { reachedUrl: 'about:blank' },
      ],
    })

    await navigatePagesForLifecycleDrain([fixture.page])

    expect(fixture.goto).toHaveBeenCalledTimes(2)
    expect(fixture.setContent).toHaveBeenCalledOnce()
    expect(fixture.waitFor).toHaveBeenCalledOnce()
  })

  it('retains both diagnostics when both bounded navigation attempts reject', async () => {
    const first = new Error('FirstNavigationRejected')
    const second = new Error('SecondNavigationRejected')
    const fixture = createPage({
      reachedUrl: 'http://127.0.0.1:31515/#/chat/example',
      attempts: [
        { reachedUrl: 'http://127.0.0.1:31515/#/chat/example', navigationError: first },
        { reachedUrl: 'http://127.0.0.1:31515/#/chat/example', navigationError: second },
      ],
    })

    const rejection = navigatePagesForLifecycleDrain([fixture.page])
    await expect(rejection).rejects.toMatchObject({
      errors: [first, second],
      message: 'RuntimeDiagnosticLifecycleDrainRejected',
    })

    expect(fixture.goto).toHaveBeenCalledTimes(2)
    expect(fixture.setContent).not.toHaveBeenCalled()
    expect(fixture.waitFor).not.toHaveBeenCalled()
  })
})
