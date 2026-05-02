import { afterEach, describe, expect, it, vi } from 'vitest'
import { installDebugStreams, logRequestPlanDebug } from '../../src/lib/debug-streams'

declare global {
  interface Window {
    __debugStreams?: {
      version(): string
      enable(): void
      disable(): void
      enablePlans(): void
      planStatus(): { enabled: boolean; entries: number }
      dumpPlans(): string
      copy(): Promise<string>
      plans(): Array<{ label: string; payload: unknown }>
      lastPlan(): { label: string; payload: unknown } | null
      lastRequest(): unknown
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
    expect(window.__debugStreams?.version()).toBe('request-plan-full-request-v1')
    window.__debugStreams?.enablePlans()
    expect(window.localStorage.getItem('natter.debug.streams')).toBeNull()
    expect(window.__debugStreams?.planStatus()).toEqual({ enabled: true, entries: 0 })
    expect(window.__debugStreams?.dumpPlans()).toBe('')
  })

  it('keeps full request-plan payloads in plans() while compacting console output', () => {
    installDebugStreams()
    window.__debugStreams?.enablePlans()
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const prompt = `${'x'.repeat(500)} tail`

    logRequestPlanDebug('prepared', {
      request: { model: 'm', prompt },
      wireShape: { hasPrompt: true },
    })

    const entry = window.__debugStreams?.plans()[0]
    expect(entry?.payload).toMatchObject({
      request: { model: 'm', prompt },
      wireShape: { hasPrompt: true },
    })
    expect(window.__debugStreams?.lastPlan()?.payload).toMatchObject({
      request: { model: 'm', prompt },
    })
    expect(window.__debugStreams?.lastRequest()).toMatchObject({ model: 'm', prompt })
    expect(JSON.stringify(debug.mock.calls[0]?.[1])).not.toContain(prompt)
  })
})
