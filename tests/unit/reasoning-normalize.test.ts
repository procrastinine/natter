import { describe, expect, it } from 'vitest'
import { normalizeReasoningSettings } from '../../src/core/reasoning'
import type { ReasoningSettings } from '../../src/core/types'

describe('normalizeReasoningSettings', () => {
  it('fills in include / mode / exclude when an older shape is loaded', () => {
    // Pretend a pre-Phase-11 build wrote this — `include` was added later.
    const stored = {
      mode: 'effort',
      effort: 'high',
      summary: 'auto',
    } as unknown as ReasoningSettings
    const next = normalizeReasoningSettings(stored)
    expect(next.include).toEqual({ encrypted: true, summary: false, text: false })
    expect(next.exclude).toBe(false)
    expect(next.mode).toBe('effort')
    expect(next.effort).toBe('high')
  })

  it('returns the input verbatim when already well-formed (memo stability)', () => {
    const stored: ReasoningSettings = {
      mode: 'default',
      exclude: false,
      summary: 'auto',
      include: { encrypted: true, summary: false, text: false },
    }
    const next = normalizeReasoningSettings(stored)
    expect(next).toBe(stored)
  })

  it('translates legacy carryForward into include when present', () => {
    const stored = {
      mode: 'default',
      exclude: false,
      summary: 'auto',
      carryForward: 'plaintext',
    } as unknown as ReasoningSettings
    const next = normalizeReasoningSettings(stored)
    expect(next.include).toEqual({ encrypted: false, summary: true, text: true })
  })

  it('handles undefined input by emitting the default object', () => {
    const next = normalizeReasoningSettings(undefined)
    expect(next.mode).toBe('default')
    expect(next.exclude).toBe(false)
    expect(next.include).toEqual({ encrypted: true, summary: false, text: false })
  })
})
