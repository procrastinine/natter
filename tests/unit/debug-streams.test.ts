import { afterEach, describe, expect, it, vi } from 'vitest'
import { installDebugStreams } from '../../src/lib/debug-streams'

declare global {
  interface Window {
    __debugStreams?: {
      enable(): void
      disable(): void
      enablePlans(): void
      planStatus(): { enabled: boolean; entries: number }
      dumpPlans(): string
      copy(): Promise<string>
    }
    __debugStreamsLastCopyText?: string
  }
}

describe('debug stream helpers', () => {
  afterEach(() => {
    window.localStorage.removeItem('natter.debug.streams')
    delete window.__debugStreams
    delete window.__debugStreamsLastCopyText
    vi.restoreAllMocks()
  })

  it('copy() falls back cleanly when the document is not focused', async () => {
    installDebugStreams()
    window.__debugStreams?.enable()
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    await expect(window.__debugStreams?.copy()).resolves.toBe('')
    expect(writeText).not.toHaveBeenCalled()
    expect(window.__debugStreamsLastCopyText).toBe('')
  })

  it('plan logging can be enabled without enabling verbose stream logging', () => {
    installDebugStreams()
    window.__debugStreams?.enablePlans()
    expect(window.localStorage.getItem('natter.debug.streams')).toBeNull()
    expect(window.__debugStreams?.planStatus()).toEqual({ enabled: true, entries: 0 })
    expect(window.__debugStreams?.dumpPlans()).toBe('')
  })
})
