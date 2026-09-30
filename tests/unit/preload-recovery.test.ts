import { afterEach, describe, expect, it, vi } from 'vitest'
import { installPreloadErrorRecovery } from '../../src/lib/preload-recovery'

afterEach(() => {
  vi.restoreAllMocks()
  sessionStorage.clear()
  history.replaceState(null, '', window.location.href)
  window.name = ''
  window.dispatchEvent(new Event('pageshow'))
})

describe('lazy bundle preload recovery', () => {
  it.each([false, true])(
    'leaves native departure in control without consuming recovery: denied storage=%s',
    (storageDenied) => {
      const reload = vi.fn()
      const storage = storageDenied
        ? {
            getItem: vi.fn(() => {
              throw new DOMException('storage denied', 'SecurityError')
            }),
            setItem: vi.fn(),
          }
        : sessionStorage
      const replaceState = vi.spyOn(window.history, 'replaceState')
      if (storageDenied) {
        replaceState.mockImplementation(() => {
          throw new DOMException('history denied', 'SecurityError')
        })
      }
      const uninstall = installPreloadErrorRecovery({
        buildToken: 'departing-build',
        storage: storage as Storage,
        reload,
      })
      try {
        window.dispatchEvent(new Event('beforeunload'))
        const departingFailure = new Event('vite:preloadError', { cancelable: true })
        window.dispatchEvent(departingFailure)
        expect(departingFailure.defaultPrevented).toBe(true)
        expect(reload).not.toHaveBeenCalled()
        expect(sessionStorage.getItem('natter:preload-recovery-build')).toBeNull()
        expect(replaceState).not.toHaveBeenCalled()
        expect(window.name).toBe('')
        if (storageDenied) expect(storage.getItem).not.toHaveBeenCalled()

        window.dispatchEvent(new Event('pageshow'))
        const activeFailure = new Event('vite:preloadError', { cancelable: true })
        window.dispatchEvent(activeFailure)
        expect(activeFailure.defaultPrevented).toBe(true)
        expect(reload).toHaveBeenCalledOnce()
        const repeatedFailure = new Event('vite:preloadError', { cancelable: true })
        window.dispatchEvent(repeatedFailure)
        expect(repeatedFailure.defaultPrevented).toBe(false)
        expect(reload).toHaveBeenCalledOnce()
      } finally {
        uninstall()
      }
    },
  )

  it('reloads once for a failed build and lets a repeated failure reach the error boundary', () => {
    const reload = vi.fn()
    const uninstall = installPreloadErrorRecovery({ buildToken: 'build-a', reload })
    const first = new Event('vite:preloadError', { cancelable: true })
    const repeated = new Event('vite:preloadError', { cancelable: true })

    window.dispatchEvent(first)
    window.dispatchEvent(repeated)

    uninstall()
    expect(first.defaultPrevented).toBe(true)
    expect(repeated.defaultPrevented).toBe(false)
    expect(reload).toHaveBeenCalledOnce()
  })

  it('allows one recovery reload when the entry build changes', () => {
    const firstReload = vi.fn()
    const uninstallFirst = installPreloadErrorRecovery({
      buildToken: 'build-a',
      reload: firstReload,
    })
    window.dispatchEvent(new Event('vite:preloadError', { cancelable: true }))
    uninstallFirst()

    const nextReload = vi.fn()
    const uninstallNext = installPreloadErrorRecovery({
      buildToken: 'build-b',
      reload: nextReload,
    })
    const nextBuildFailure = new Event('vite:preloadError', { cancelable: true })
    window.dispatchEvent(nextBuildFailure)
    uninstallNext()

    expect(firstReload).toHaveBeenCalledOnce()
    expect(nextBuildFailure.defaultPrevented).toBe(true)
    expect(nextReload).toHaveBeenCalledOnce()
  })

  it('uses a reload-persistent window-name guard when storage and history are unavailable', () => {
    const reload = vi.fn()
    const unavailableStorage = {
      getItem: () => {
        throw new DOMException('storage denied', 'SecurityError')
      },
      setItem: () => {
        throw new DOMException('storage denied', 'SecurityError')
      },
    } as unknown as Storage
    vi.spyOn(window.history, 'replaceState').mockImplementation(() => {
      throw new DOMException('history denied', 'SecurityError')
    })
    const uninstall = installPreloadErrorRecovery({
      buildToken: 'storage-denied-build',
      storage: unavailableStorage,
      reload,
    })
    const first = new Event('vite:preloadError', { cancelable: true })
    const repeated = new Event('vite:preloadError', { cancelable: true })

    window.dispatchEvent(first)
    uninstall()

    const uninstallAfterReload = installPreloadErrorRecovery({
      buildToken: 'storage-denied-build',
      storage: unavailableStorage,
      reload,
    })
    window.dispatchEvent(repeated)
    uninstallAfterReload()

    expect(first.defaultPrevented).toBe(true)
    expect(repeated.defaultPrevented).toBe(false)
    expect(reload).toHaveBeenCalledOnce()
  })
})
