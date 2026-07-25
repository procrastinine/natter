import { afterEach, describe, expect, it, vi } from 'vitest'
import { projectReasoningEnvelope } from '../../src/core/reasoning-envelope'
import {
  applyReasoningObservationBatch,
  createReasoningObservationCodecState,
  reasoningObservationsFromDetails,
} from '../../src/core/reasoning-observation'
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

  it('summarizes current reasoning envelopes without exposing opaque carriers', () => {
    const details = [
      ...Array.from({ length: 6 }, (_, index) => ({
        type: 'reasoning.summary' as const,
        format: 'unknown' as const,
        id: `summary-${index}`,
        summary: index === 0 ? 'v'.repeat(500) : `summary ${index}`,
      })),
      {
        type: 'reasoning.text' as const,
        format: 'anthropic-claude-v1' as const,
        id: 'claude-thinking',
        text: 'visible Claude thought',
        signature: 'private-claude-signature',
      },
      {
        type: 'reasoning.encrypted' as const,
        format: 'google-gemini-v1' as const,
        id: 'gemini-signature',
        data: 'private-gemini-signature',
      },
    ]
    const codec = createReasoningObservationCodecState()
    applyReasoningObservationBatch(codec, {
      observations: reasoningObservationsFromDetails({
        details,
        mode: 'snapshot',
        dialect: 'openrouter-chat',
        bridge: 'openrouter',
        untypedVisibleKind: 'text',
      }),
    })
    const entries: Array<{ label: string; payload: unknown }> = []
    setStreamDebugSink((entry) => entries.push(entry))
    vi.spyOn(console, 'debug').mockImplementation(() => {})

    logStreamDebug('stream-1', 'message.finalize', {
      messageId: 'assistant-1',
      outcome: 'done',
      reasoningEnvelope: projectReasoningEnvelope(codec.envelope),
    })

    expect(entries).toHaveLength(1)
    expect(entries[0]?.payload).toMatchObject({
      messageId: 'assistant-1',
      reasoningEnvelope: {
        kind: 'plaintext',
        counts: { text: 1, summary: 6, opaque: 1, authentication: 1 },
        lengths: {
          text: 'visible Claude thought'.length,
          summary: 500 + 'summary 1'.length * 5,
          opaque: 'private-gemini-signature'.length,
          authentication: 'private-claude-signature'.length,
        },
        truncated: 1,
      },
    })
    const encoded = JSON.stringify(entries[0]?.payload)
    expect(encoded).toContain('"kind":"gemini-thought-signature"')
    expect(encoded).toContain(`"valueLength":${'private-gemini-signature'.length}`)
    expect(encoded).not.toContain('private-gemini-signature')
    expect(encoded).not.toContain('private-claude-signature')
    expect(encoded).toContain('<500 chars>')
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
