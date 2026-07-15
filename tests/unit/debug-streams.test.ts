import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  logRequestPlanDebug,
  logStreamDebug,
  setRequestPlanDebugSink,
  setStreamDebugSink,
} from '../../src/lib/debug-streams'
import { installDebugStreams } from '../../tools/debug-streams'

declare global {
  interface Window {
    __debugStreams?: {
      version(): string
      enable(): void
      disable(): void
      status(): { enabled: boolean; entries: number }
      clear(): void
      enablePlans(): void
      disablePlans(): void
      planStatus(): {
        enabled: boolean
        entries: number
        latestRequest:
          | { state: 'available'; bytes: number; maximumBytes: number }
          | { state: 'over-byte-cap' | 'unserializable'; maximumBytes: number }
          | { state: 'none'; maximumBytes: number }
      }
      clearPlans(): void
      dumpPlans(): string
      copy(): Promise<string>
      copyPlans(): Promise<string>
      plans(): Array<{ label: string; payload: unknown }>
      lastPlan(): { label: string; payload: unknown } | null
      lastRequest(): unknown
    }
    __debugStreamsLastCopyText?: string
  }
}

describe('debug stream helpers', () => {
  afterEach(() => {
    window.__debugStreams?.disable()
    window.__debugStreams?.disablePlans()
    window.localStorage.removeItem('natter.debug.streams')
    window.localStorage.removeItem('natter.debug.request_plans')
    setRequestPlanDebugSink(undefined)
    setStreamDebugSink(undefined)
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
    expect(window.__debugStreams?.version()).toBe('request-plan-bounded-v2')
    window.__debugStreams?.enablePlans()
    expect(window.localStorage.getItem('natter.debug.streams')).toBeNull()
    expect(window.__debugStreams?.planStatus()).toEqual({
      enabled: true,
      entries: 0,
      latestRequest: { state: 'none', maximumBytes: 1024 * 1024 },
    })
    expect(window.__debugStreams?.dumpPlans()).toBe('')
  })

  it('keeps compact plan metadata plus only the latest bounded full request', () => {
    installDebugStreams()
    window.__debugStreams?.enablePlans()
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const firstPrompt = `${'x'.repeat(500)} first`
    const latestPrompt = `${'y'.repeat(500)} latest`

    logRequestPlanDebug('prepared', {
      request: { model: 'm', prompt: firstPrompt },
      wireShape: { hasPrompt: true },
    })
    logRequestPlanDebug('prepared', {
      request: { model: 'm', prompt: latestPrompt },
      wireShape: { hasPrompt: true },
    })

    const plans = window.__debugStreams?.plans() ?? []
    expect(plans).toHaveLength(2)
    expect(JSON.stringify(plans)).not.toContain(firstPrompt)
    expect(JSON.stringify(plans)).not.toContain(latestPrompt)
    expect(window.__debugStreams?.lastPlan()?.payload).toMatchObject({
      wireShape: { hasPrompt: true },
      requestCapture: {
        state: 'available',
        maximumBytes: 1024 * 1024,
      },
    })
    const request = window.__debugStreams?.lastRequest() as { model: string; prompt: string }
    expect(request).toEqual({ model: 'm', prompt: latestPrompt })
    request.prompt = 'mutated returned copy'
    expect(window.__debugStreams?.lastRequest()).toEqual({ model: 'm', prompt: latestPrompt })
    expect(window.__debugStreams?.planStatus().latestRequest).toMatchObject({
      state: 'available',
      maximumBytes: 1024 * 1024,
    })
    expect(JSON.stringify(debug.mock.calls)).not.toContain(firstPrompt)
    expect(JSON.stringify(debug.mock.calls)).not.toContain(latestPrompt)
  })

  it('omits an oversized or unserializable latest request without retaining its object graph', () => {
    installDebugStreams()
    window.__debugStreams?.enablePlans()
    vi.spyOn(console, 'debug').mockImplementation(() => {})

    const oversized = { prompt: 'x'.repeat(1024 * 1024 + 1) }
    logRequestPlanDebug('prepared', { request: oversized, source: 'oversized' })
    expect(window.__debugStreams?.lastRequest()).toBeNull()
    expect(window.__debugStreams?.planStatus().latestRequest).toEqual({
      state: 'over-byte-cap',
      maximumBytes: 1024 * 1024,
    })
    expect(JSON.stringify(window.__debugStreams?.lastPlan())).not.toContain(oversized.prompt)

    const circular: { marker: string; self?: unknown } = { marker: 'caller-owned' }
    circular.self = circular
    logRequestPlanDebug('prepared', { request: circular, source: 'circular' })
    circular.marker = 'mutated-after-capture'
    expect(window.__debugStreams?.lastRequest()).toBeNull()
    expect(window.__debugStreams?.planStatus().latestRequest).toEqual({
      state: 'unserializable',
      maximumBytes: 1024 * 1024,
    })
    expect(JSON.stringify(window.__debugStreams?.lastPlan())).not.toContain('mutated-after-capture')
  })

  it('disable and clear release buffers, latest requests, and clipboard fallbacks', async () => {
    installDebugStreams()
    window.__debugStreams?.enable()
    window.__debugStreams?.enablePlans()
    logStreamDebug(null, 'test', { value: 1 })
    logRequestPlanDebug('prepared', { request: { prompt: 'private' }, source: 'test' })
    expect(window.__debugStreams?.status().entries).toBe(1)
    expect(window.__debugStreams?.planStatus().entries).toBe(1)

    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    await window.__debugStreams?.copyPlans()
    expect(window.__debugStreamsLastCopyText).toContain('[request-plan] prepared')

    window.__debugStreams?.clearPlans()
    expect(window.__debugStreams?.planStatus().entries).toBe(0)
    expect(window.__debugStreams?.lastRequest()).toBeNull()
    expect(window.__debugStreamsLastCopyText).toBeUndefined()

    await window.__debugStreams?.copy()
    expect(window.__debugStreamsLastCopyText).toContain('[stream-debug][global] test')
    window.__debugStreams?.disable()
    expect(window.__debugStreams?.status()).toEqual({ enabled: false, entries: 0 })
    expect(window.__debugStreamsLastCopyText).toBeUndefined()

    logRequestPlanDebug('prepared', { request: { prompt: 'again' } })
    expect(window.__debugStreams?.planStatus().entries).toBe(1)
    window.__debugStreams?.disablePlans()
    expect(window.__debugStreams?.planStatus()).toEqual({
      enabled: false,
      entries: 0,
      latestRequest: { state: 'none', maximumBytes: 1024 * 1024 },
    })
    expect(window.__debugStreams?.lastRequest()).toBeNull()
  })
})
