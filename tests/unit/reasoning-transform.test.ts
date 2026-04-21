// Reasoning-mode serialization. See `plan/05-transforms-and-quirks.md §5.1`
// step 5 and `src/core/transforms.ts::buildReasoning` for the rules.
//
// Five modes:
//   - default → no `reasoning` field on the wire (provider's native default)
//   - off     → `{ enabled: false }` (explicit "don't think")
//   - enabled → `{ enabled: true }` (default-on with no knobs)
//   - effort  → `{ enabled: true, effort }`
//   - budget  → `{ enabled: true, max_tokens }`
// `summary` and `exclude` ride along the non-default modes.

import { describe, expect, it } from 'vitest'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import { toChatCompletions } from '../../src/core/transforms'
import type { ChatSettings, ReasoningMode } from '../../src/core/types'

function makeSettings(overrides: Partial<ChatSettings['reasoning']> & { mode: ReasoningMode }): ChatSettings {
  const s = cloneDefaultChatSettings()
  s.reasoning = {
    mode: overrides.mode,
    exclude: overrides.exclude ?? false,
    // Defaults.ts sets summary='auto' which would ride along on every
    // test's wire output; force to 'off' unless a test explicitly opts in.
    summary: overrides.summary ?? 'off',
    carryForward: overrides.carryForward ?? 'auto',
    include: overrides.include ?? { encrypted: false, summary: false, text: false },
    ...(overrides.effort !== undefined ? { effort: overrides.effort } : {}),
    ...(overrides.maxTokens !== undefined ? { maxTokens: overrides.maxTokens } : {}),
  }
  return s
}

function transform(settings: ChatSettings): Record<string, unknown> {
  const { wire } = toChatCompletions(settings, [], { stream: false })
  return wire as unknown as Record<string, unknown>
}

describe('buildReasoning via toChatCompletions', () => {
  it('default mode emits no reasoning field', () => {
    const settings = makeSettings({ mode: 'default' })
    const wire = transform(settings)
    expect(wire.reasoning).toBeUndefined()
  })

  it('off mode emits { enabled: false }', () => {
    const settings = makeSettings({ mode: 'off' })
    const wire = transform(settings)
    expect(wire.reasoning).toEqual({ enabled: false })
  })

  it('enabled mode with no knobs emits bare { enabled: true }', () => {
    const settings = makeSettings({ mode: 'enabled' })
    const wire = transform(settings)
    expect(wire.reasoning).toEqual({ enabled: true })
  })

  it('effort mode serializes { enabled: true, effort }', () => {
    const settings = makeSettings({ mode: 'effort', effort: 'high' })
    const wire = transform(settings)
    expect(wire.reasoning).toEqual({ enabled: true, effort: 'high' })
  })

  it('budget mode serializes { enabled: true, max_tokens }', () => {
    const settings = makeSettings({ mode: 'budget', maxTokens: 8000 })
    const wire = transform(settings)
    expect(wire.reasoning).toEqual({ enabled: true, max_tokens: 8000 })
  })

  it('summary rides along on enabled-derived modes', () => {
    const settings = makeSettings({ mode: 'enabled', summary: 'detailed' })
    const wire = transform(settings)
    expect(wire.reasoning).toMatchObject({ enabled: true, summary: 'detailed' })
  })

  it('summary=off is dropped, not forwarded', () => {
    const settings = makeSettings({ mode: 'enabled', summary: 'off' })
    const wire = transform(settings)
    expect(wire.reasoning).toEqual({ enabled: true })
  })

  it('exclude: true rides on non-default modes', () => {
    const settings = makeSettings({ mode: 'effort', effort: 'medium', exclude: true })
    const wire = transform(settings)
    expect(wire.reasoning).toMatchObject({ enabled: true, effort: 'medium', exclude: true })
  })

  it('effort with extra knobs merges cleanly', () => {
    const settings = makeSettings({
      mode: 'effort',
      effort: 'low',
      summary: 'concise',
      exclude: true,
    })
    const wire = transform(settings)
    expect(wire.reasoning).toMatchObject({
      enabled: true,
      effort: 'low',
      summary: 'concise',
      exclude: true,
    })
  })

  it('budget with summary + exclude merges', () => {
    const settings = makeSettings({
      mode: 'budget',
      maxTokens: 16000,
      summary: 'auto',
      exclude: true,
    })
    const wire = transform(settings)
    expect(wire.reasoning).toMatchObject({
      enabled: true,
      max_tokens: 16000,
      summary: 'auto',
      exclude: true,
    })
  })
})

describe('reasoning gating by capability', () => {
  it('skips emitting reasoning when the capability set excludes it', () => {
    const settings = makeSettings({ mode: 'effort', effort: 'high' })
    const { wire } = toChatCompletions(settings, [], {
      stream: false,
      capabilities: {
        supportedParameters: ['temperature', 'max_tokens'],
        streaming: 'supported',
      },
    })
    expect((wire as unknown as Record<string, unknown>).reasoning).toBeUndefined()
  })

  it('emits reasoning when the capability set includes it', () => {
    const settings = makeSettings({ mode: 'effort', effort: 'high' })
    const { wire } = toChatCompletions(settings, [], {
      stream: false,
      capabilities: {
        supportedParameters: ['temperature', 'reasoning'],
        streaming: 'supported',
      },
    })
    expect((wire as unknown as Record<string, unknown>).reasoning).toEqual({
      enabled: true,
      effort: 'high',
    })
  })
})
