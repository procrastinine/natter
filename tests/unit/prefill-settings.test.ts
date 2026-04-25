import { describe, expect, it } from 'vitest'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import { prefillSettingsRecommendation } from '../../src/core/prefill-settings'
import type { ChatSettings, ModelEndpoint } from '../../src/core/types'

function settings(patch: Partial<ChatSettings>): ChatSettings {
  return {
    ...cloneDefaultChatSettings(),
    profileId: 'prof',
    ...patch,
  }
}

function endpoint(provider_name: string, provider_slug: string): ModelEndpoint {
  return {
    provider_name,
    provider_slug,
    supported_parameters: ['reasoning'],
    context_length: 200_000,
    pricing: {},
  }
}

describe('prefill settings recommendation', () => {
  it('does not recommend changes for native Gemini prefill', () => {
    const result = prefillSettingsRecommendation(
      settings({
        model: 'google/gemini-3.1-flash-lite-preview',
        reasoning: { ...cloneDefaultChatSettings().reasoning, mode: 'enabled' },
      }),
    )
    expect(result).toBeNull()
  })

  it('recommends explicit settings for toggleable OSS prefill', () => {
    const result = prefillSettingsRecommendation(
      settings({
        model: 'z-ai/glm-5.1',
        reasoning: { ...cloneDefaultChatSettings().reasoning, mode: 'default' },
        providerPrefs: { only: ['fireworks'] },
      }),
      [
        endpoint('DeepInfra', 'deepinfra'),
        endpoint('Nebius', 'nebius'),
        endpoint('Fireworks', 'fireworks'),
      ],
    )
    expect(result?.issues).toEqual(['turn reasoning off', 'use DeepInfra or Nebius providers'])
    expect(result?.patch.reasoning).toMatchObject({ mode: 'off' })
    expect(result?.patch.providerPrefs).toMatchObject({
      ignore: [],
      ignoreOverridesFilter: true,
      only: ['deepinfra', 'nebius'],
    })
  })

  it('intersects preferred providers with actual endpoints', () => {
    const result = prefillSettingsRecommendation(
      settings({
        model: 'z-ai/glm-5.1',
        reasoning: { ...cloneDefaultChatSettings().reasoning, mode: 'off' },
        providerPrefs: { only: ['fireworks'] },
      }),
      [endpoint('DeepInfra', 'deepinfra'), endpoint('Fireworks', 'fireworks')],
    )
    expect(result?.issues).toEqual(['use DeepInfra'])
    expect(result?.patch.providerPrefs).toMatchObject({
      ignoreOverridesFilter: true,
      only: ['deepinfra'],
    })
  })

  it('does not recommend provider changes when no preferred provider is available', () => {
    const result = prefillSettingsRecommendation(
      settings({
        model: 'z-ai/glm-5.1',
        reasoning: { ...cloneDefaultChatSettings().reasoning, mode: 'default' },
        providerPrefs: { only: ['fireworks'] },
      }),
      [endpoint('Fireworks', 'fireworks')],
    )
    expect(result).toBeNull()
  })

  it('does not recommend changes for forced-reasoning OSS models', () => {
    const result = prefillSettingsRecommendation(
      settings({
        model: 'deepseek/deepseek-r1',
        reasoning: { ...cloneDefaultChatSettings().reasoning, mode: 'enabled' },
      }),
      [endpoint('DeepInfra', 'deepinfra')],
    )
    expect(result).toBeNull()
  })

  it('does not recommend changes once toggleable OSS settings are already compatible', () => {
    const result = prefillSettingsRecommendation(
      settings({
        model: 'z-ai/glm-5.1',
        reasoning: { ...cloneDefaultChatSettings().reasoning, mode: 'off' },
        providerPrefs: { only: ['nebius'] },
      }),
      [endpoint('DeepInfra', 'deepinfra'), endpoint('Nebius', 'nebius')],
    )
    expect(result).toBeNull()
  })
})
