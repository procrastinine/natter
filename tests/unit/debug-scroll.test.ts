import { afterEach, describe, expect, it, vi } from 'vitest'
import { logScrollDebug, setScrollDebugSink } from '../../src/lib/debug-scroll'
import { installDebugScroll } from '../../tools/debug-scroll'

declare global {
  interface Window {
    __debugScroll?: {
      enable(): void
      disable(): void
      status(): { enabled: boolean; entries: number }
      clear(): void
      copy(): Promise<string>
      entries(): Array<{ label: string; payload: unknown }>
    }
    __debugScrollLastCopyText?: string
  }
}

describe('debug scroll helpers', () => {
  afterEach(() => {
    window.__debugScroll?.disable()
    window.localStorage.removeItem('natter.debug.scroll')
    setScrollDebugSink(undefined)
    delete window.__debugScroll
    delete window.__debugScrollLastCopyText
    vi.restoreAllMocks()
  })

  it('captures a bounded value snapshot instead of retaining the caller payload', () => {
    installDebugScroll()
    window.__debugScroll?.enable()
    vi.spyOn(console, 'debug').mockImplementation(() => {})
    const payload = { state: 'follow', metrics: { scrollTop: 12 } }

    logScrollDebug('position', payload)
    payload.state = 'mutated'
    payload.metrics.scrollTop = 99

    expect(window.__debugScroll?.entries()).toEqual([
      {
        label: '[scroll-debug] position',
        payload: { state: 'follow', metrics: { scrollTop: 12 } },
      },
    ])
  })

  it('never falls back to retaining an unserializable payload', () => {
    installDebugScroll()
    window.__debugScroll?.enable()
    vi.spyOn(console, 'debug').mockImplementation(() => {})
    const circular: { marker: string; self?: unknown } = { marker: 'caller-owned' }
    circular.self = circular

    logScrollDebug('circular', circular)
    circular.marker = 'mutated-after-capture'

    expect(window.__debugScroll?.entries()).toEqual([
      {
        label: '[scroll-debug] circular',
        payload: {
          debugCapture: 'omitted',
          reason: 'unserializable',
          maximumPayloadBytes: 16 * 1024,
        },
      },
    ])
  })

  it('clear and disable release entries and clipboard fallback text', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    installDebugScroll()
    window.__debugScroll?.enable()
    logScrollDebug('position', { scrollTop: 12 })
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)

    await window.__debugScroll?.copy()
    expect(window.__debugScrollLastCopyText).toContain('[scroll-debug] position')
    window.__debugScroll?.clear()
    expect(window.__debugScroll?.status()).toEqual({ enabled: true, entries: 0 })
    expect(window.__debugScrollLastCopyText).toBeUndefined()

    logScrollDebug('position', { scrollTop: 24 })
    await window.__debugScroll?.copy()
    expect(window.__debugScrollLastCopyText).toContain('[scroll-debug] position')
    window.__debugScroll?.disable()
    expect(window.__debugScroll?.status()).toEqual({ enabled: false, entries: 0 })
    expect(window.__debugScrollLastCopyText).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(2)
    expect(
      warn.mock.calls.every(([message]) =>
        String(message).includes('scroll clipboard copy unavailable'),
      ),
    ).toBe(true)
  })
})
