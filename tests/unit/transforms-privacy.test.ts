// Privacy-related transform behavior:
//   - Free-model exception strips provider.{data_collection,zdr,only,ignore,order}
//   - allowFallbacks:false surfaces as provider.allow_fallbacks:false
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
      privacy: { ignore: ['A'], zeroEligible: false },
    })
    expect(wire.provider).toEqual({ allow_fallbacks: false })
  })

  it('allowFallbacks:false surfaces on the wire', () => {
    const settings = makeSettings({
      model: 'openai/gpt-5.4',
      allowFallbacks: false,
    })
    const { wire } = toChatCompletions(settings, [], { stream: false })
    expect(
      (wire.provider as Record<string, unknown> | undefined)?.allow_fallbacks,
    ).toBe(false)
  })

  it('allowFallbacks:true does not emit the field (matches OpenRouter default)', () => {
    const settings = makeSettings({
      model: 'openai/gpt-5.4',
      allowFallbacks: true,
    })
    const { wire } = toChatCompletions(settings, [], { stream: false })
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
      privacy: { ignore: ['OpenAI'], data_collection: 'deny', zeroEligible: false },
    })
    expect(wire.provider).toMatchObject({
      sort: 'price',
      quantizations: ['bf16'],
      ignore: ['OpenAI'],
      data_collection: 'deny',
    })
  })
})
