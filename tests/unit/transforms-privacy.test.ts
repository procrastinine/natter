// Privacy-related transform behavior:
//   - Free-model exception strips provider.{data_collection,zdr,only,ignore,order}
//   - allowFallbacks:false surfaces as provider.allow_fallbacks:false
//   - legacy providerPrefs.allowFallbacks is ignored
//   - Pre-computed privacy wire fragments merge into the provider block
//
// See `plan/05-transforms-and-quirks.md` privacy-free-strip note and
// `plan/09-privacy.md §9.9`.

import { describe, expect, it } from 'vitest'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import { toChatCompletions } from '../../src/core/transforms'
import type { ChatSettings } from '../../src/core/types'

function makeSettings(overrides: Partial<ChatSettings> = {}): ChatSettings {
  return { ...cloneDefaultChatSettings(), ...overrides }
}

describe('toChatCompletions — privacy wire fragment', () => {
  it('merges pre-computed wire fragment into provider block', () => {
    const settings = makeSettings({ model: 'openai/gpt-5.4' })
    const { wire } = toChatCompletions(settings, [], {
      stream: false,
      allowProviderRouting: true,
      privacy: {
        ignore: ['OpenAI'],
        order: ['Azure', 'Amazon Bedrock'],
        data_collection: 'deny',
        zeroEligible: false,
      },
    })
    expect(wire.provider).toMatchObject({
      ignore: ['OpenAI'],
      order: ['Azure', 'Amazon Bedrock'],
      data_collection: 'deny',
    })
  })

  it('free model strips privacy-routing fields even when passed', () => {
    const settings = makeSettings({ model: 'deepseek/deepseek-r1:free' })
    const { wire } = toChatCompletions(settings, [], {
      stream: false,
      allowProviderRouting: true,
      privacy: {
        ignore: ['OpenAI'],
        only: ['Chutes'],
        order: ['Chutes', 'Novita'],
        data_collection: 'deny',
        zdr: true,
        zeroEligible: false,
      },
    })
    // After the free-model strip, the provider block is empty — so the
    // transform drops it entirely to keep the envelope clean.
    expect(wire.provider).toBeUndefined()
  })

  it('free model keeps allow_fallbacks:false (not a privacy-routing field)', () => {
    const settings = makeSettings({
      model: 'deepseek/deepseek-r1:free',
      allowFallbacks: false,
    })
    const { wire } = toChatCompletions(settings, [], {
      stream: false,
      allowProviderRouting: true,
      privacy: { ignore: ['A'], zeroEligible: false },
    })
    expect(wire.provider).toEqual({ allow_fallbacks: false })
  })

  it('does not emit OpenRouter provider routing unless explicitly enabled', () => {
    const settings = makeSettings({
      model: 'openai/gpt-5.4',
      allowFallbacks: false,
      providerPrefs: {
        sort: 'price',
      },
    })
    const { wire } = toChatCompletions(settings, [], {
      stream: false,
      privacy: { ignore: ['OpenAI'], data_collection: 'deny', zeroEligible: false },
    })
    expect(wire.provider).toBeUndefined()
  })

  it('allowFallbacks:false surfaces on the wire', () => {
    const settings = makeSettings({
      model: 'openai/gpt-5.4',
      allowFallbacks: false,
    })
    const { wire } = toChatCompletions(settings, [], {
      stream: false,
      allowProviderRouting: true,
    })
    expect(
      (wire.provider as Record<string, unknown> | undefined)?.allow_fallbacks,
    ).toBe(false)
  })

  it('allowFallbacks:true does not emit the field (matches OpenRouter default)', () => {
    const settings = makeSettings({
      model: 'openai/gpt-5.4',
      allowFallbacks: true,
    })
    const { wire } = toChatCompletions(settings, [], {
      stream: false,
      allowProviderRouting: true,
    })
    expect(wire.provider).toBeUndefined()
  })

  it('ignores legacy providerPrefs.allowFallbacks when top-level allowFallbacks is true', () => {
    const settings = makeSettings({
      model: 'openai/gpt-5.4',
      allowFallbacks: true,
      providerPrefs: {
        allowFallbacks: false,
      } as unknown as NonNullable<ChatSettings['providerPrefs']>,
    })
    const { wire } = toChatCompletions(settings, [], {
      stream: false,
      allowProviderRouting: true,
    })
    expect(wire.provider).toBeUndefined()
  })

  it('user-provided providerPrefs coexist with privacy fragment', () => {
    const settings = makeSettings({
      model: 'openai/gpt-5.4',
      providerPrefs: {
        sort: 'price',
        quantizations: ['bf16'],
      },
    })
    const { wire } = toChatCompletions(settings, [], {
      stream: false,
      allowProviderRouting: true,
      privacy: { ignore: ['OpenAI'], data_collection: 'deny', zeroEligible: false },
    })
    expect(wire.provider).toMatchObject({
      sort: 'price',
      quantizations: ['bf16'],
      ignore: ['OpenAI'],
      data_collection: 'deny',
    })
  })

  it('does not emit hidden legacy providerPrefs privacy knobs', () => {
    const settings = makeSettings({
      model: 'openai/gpt-5.4',
      providerPrefs: {
        dataCollection: 'deny',
        zdr: true,
      },
    })
    const { wire } = toChatCompletions(settings, [], {
      stream: false,
      allowProviderRouting: true,
    })
    expect(wire.provider).toBeUndefined()
  })

  it('privacy resolver output replaces raw provider refs that need normalization', () => {
    const settings = makeSettings({
      model: 'anthropic/claude-opus-4.7',
      providerPrefs: {
        order: ['Anthropic'],
        ignore: ['Anthropic'],
      },
    })
    const { wire } = toChatCompletions(settings, [], {
      stream: false,
      allowProviderRouting: true,
      privacy: {
        order: ['anthropic/2', 'anthropic'],
        ignore: ['anthropic/2'],
        zeroEligible: false,
      },
    })
    expect(wire.provider).toMatchObject({
      order: ['anthropic/2', 'anthropic'],
      ignore: ['anthropic/2'],
    })
  })
})
