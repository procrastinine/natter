// Reasoning-mode serialization rules.
//
// Five modes:
//   - default → no `reasoning` field on the wire (provider's native default)
//   - off     → `{ enabled: false }` (explicit "don't think")
//   - enabled → `{ enabled: true }` (default-on with no knobs)
//   - effort  → `{ enabled: true, effort }`
//   - budget  → `{ enabled: true, max_tokens }`
// OpenRouter display controls can ride independently of the reasoning mode.

import { describe, expect, it } from 'vitest'
import { toChatCompletions as toChatCompletionsWithContract } from '../../src/api/request-transforms'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import { TEXT_PROVIDER_OUTPUT_CONTRACT } from '../../src/core/provider-tool-context'
import { resolveAttemptInboundReasoningVisibility } from '../../src/core/reasoning'
import type { ChatSettings, ReasoningMode } from '../../src/core/types'
import {
  chatReasoningContractForSettings,
  TEST_ASSISTANT_TAIL_PREFILL_PLAN,
} from '../helpers/reasoning-contracts'

type ChatOptions = Omit<
  Parameters<typeof toChatCompletionsWithContract>[2],
  'reasoning' | 'providerOutput' | 'prefillPlan'
> & {
  reasoning?: Parameters<typeof toChatCompletionsWithContract>[2]['reasoning']
  providerOutput?: Parameters<typeof toChatCompletionsWithContract>[2]['providerOutput']
  prefillPlan?: Parameters<typeof toChatCompletionsWithContract>[2]['prefillPlan']
}

function toChatCompletions(
  settings: Parameters<typeof toChatCompletionsWithContract>[0],
  path: Parameters<typeof toChatCompletionsWithContract>[1],
  options: ChatOptions = {},
) {
  return toChatCompletionsWithContract(settings, path, {
    ...options,
    reasoning: options.reasoning ?? chatReasoningContractForSettings(settings),
    providerOutput: options.providerOutput ?? TEXT_PROVIDER_OUTPUT_CONTRACT,
    prefillPlan: options.prefillPlan ?? TEST_ASSISTANT_TAIL_PREFILL_PLAN,
  })
}

function makeSettings(
  overrides: Partial<ChatSettings['reasoning']> & { mode: ReasoningMode },
): ChatSettings {
  const s = cloneDefaultChatSettings()
  s.reasoning = {
    mode: overrides.mode,
    exclude: overrides.exclude ?? false,
    // Defaults.ts sets summary='auto' which would ride along on every
    // test's wire output; force to 'off' unless a test explicitly opts in.
    summary: overrides.summary ?? 'off',
    include: overrides.include ?? { encrypted: false, summary: false, text: false },
    ...(overrides.effort !== undefined ? { effort: overrides.effort } : {}),
    ...(overrides.maxTokens !== undefined ? { maxTokens: overrides.maxTokens } : {}),
  }
  return s
}

function transform(settings: ChatSettings): Record<string, unknown> {
  const { wire } = toChatCompletions(settings, [], { stream: false })
  return wire
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

  it('lets exclude dominate a simultaneous summary request', () => {
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
      exclude: true,
    })
  })

  it('does not emit a wasted summary request with budget + exclude', () => {
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
      exclude: true,
    })
  })
})

describe('reasoning gating by capability', () => {
  it('keeps display-only controls independent on OpenRouter default reasoning', () => {
    const settings = makeSettings({ mode: 'default', summary: 'auto', exclude: true })
    const result = toChatCompletions(settings, [], { stream: false })

    expect(result.wire.reasoning).toEqual({ exclude: true })
    expect(result.reasoningVisibilityEvidence).toEqual({
      kind: 'openai-family',
      dialect: 'openrouter-chat',
      activation: 'excluded',
    })
  })

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

  it('reports visibility from the emitted wire rather than unsent settings', () => {
    const disabled = makeSettings({ mode: 'off' })
    const gated = toChatCompletions(disabled, [], {
      stream: false,
      capabilities: {
        supportedParameters: ['temperature'],
        streaming: 'supported',
      },
    })
    expect(gated.reasoningVisibilityEvidence).toEqual({
      kind: 'openai-family',
      dialect: 'openrouter-chat',
      activation: 'active',
      display: 'available',
    })

    const emitted = toChatCompletions(makeSettings({ mode: 'enabled', exclude: true }), [], {
      stream: false,
    })
    expect(emitted.reasoningVisibilityEvidence).toEqual({
      kind: 'openai-family',
      dialect: 'openrouter-chat',
      activation: 'excluded',
    })
  })
})

describe('sealed inbound visibility cross-product', () => {
  const summaryPolicy = { kind: 'hidden-on-chat', otherwise: 'summary' } as const

  it.each([
    {
      dialect: 'openai-chat' as const,
      display: 'available' as const,
      expected: {
        disclosure: 'absent',
        unexpectedVisibleKind: 'summary',
        reason: 'api-mode',
      },
    },
    {
      dialect: 'openrouter-chat' as const,
      display: 'available' as const,
      expected: { disclosure: 'visible', visibleKind: 'summary' },
    },
    {
      dialect: 'openai-responses' as const,
      display: 'provider-default-omitted' as const,
      expected: {
        disclosure: 'absent',
        unexpectedVisibleKind: 'summary',
        reason: 'provider-default',
      },
    },
    {
      dialect: 'openai-responses' as const,
      display: 'available' as const,
      expected: { disclosure: 'visible', visibleKind: 'summary' },
    },
    {
      dialect: 'openrouter-responses' as const,
      display: 'available' as const,
      expected: { disclosure: 'visible', visibleKind: 'summary' },
    },
  ])('$dialect with $display seals the exact route fact', ({ dialect, display, expected }) => {
    expect(
      resolveAttemptInboundReasoningVisibility(summaryPolicy, {
        kind: 'openai-family',
        dialect,
        activation: 'active',
        display,
      }),
    ).toEqual(expected)
  })

  it('gives explicit disable and display exclusion precedence over route defaults', () => {
    expect(
      resolveAttemptInboundReasoningVisibility(summaryPolicy, {
        kind: 'openai-family',
        dialect: 'openrouter-responses',
        activation: 'disabled',
      }),
    ).toMatchObject({ disclosure: 'absent', reason: 'disabled' })
    expect(
      resolveAttemptInboundReasoningVisibility(summaryPolicy, {
        kind: 'openai-family',
        dialect: 'openrouter-chat',
        activation: 'excluded',
      }),
    ).toMatchObject({ disclosure: 'absent', reason: 'request-display' })
  })

  it('does not let a summary-omission fact hide a plaintext route', () => {
    expect(
      resolveAttemptInboundReasoningVisibility(
        { kind: 'uniform', visibleKind: 'text' },
        {
          kind: 'openai-family',
          dialect: 'openai-responses',
          activation: 'active',
          display: 'request-omitted',
        },
      ),
    ).toEqual({ disclosure: 'visible', visibleKind: 'text' })
  })

  it.each([
    ['disabled', 'disabled'],
    ['excluded', 'request-display'],
  ] as const)('maps inline %s evidence without a model heuristic', (activation, reason) => {
    expect(
      resolveAttemptInboundReasoningVisibility(
        { kind: 'uniform', visibleKind: 'text' },
        { kind: 'inline', activation },
      ),
    ).toMatchObject({ disclosure: 'absent', reason })
  })
})
