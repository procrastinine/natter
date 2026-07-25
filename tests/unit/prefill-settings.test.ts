import { fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import { resolveEffectiveEndpointRouting } from '../../src/core/effective-endpoint-routing'
import { EMPTY_MESSAGE_CONTEXT_ROUTE_FACTS } from '../../src/core/reasoning'
import type { CapabilityDescriptor, ChatSettings, ConnectionProfile } from '../../src/core/types'
import { PrefillSettingsPrompt } from '../../src/ui/chat/PrefillSettingsPrompt'

const configurationMocks = vi.hoisted(() => ({
  patchChatSettings: vi.fn(),
}))

vi.mock('../../src/store/configuration-application', () => ({
  configurationApplication: configurationMocks,
}))

function settings(patch: Partial<ChatSettings>): ChatSettings {
  return {
    ...cloneDefaultChatSettings(),
    profileId: 'prof',
    ...patch,
  }
}

function profile(kind: ConnectionProfile['kind'] = 'custom'): ConnectionProfile {
  return {
    id: 'prof',
    name: 'Test',
    kind,
    baseUrl: kind === 'openrouter' ? 'https://openrouter.ai/api/v1' : 'https://example.test/v1',
    defaultHeaders: {},
    appTitle: '',
    appUrl: '',
    supportsEndpointsApi: kind === 'openrouter',
    supportsGenerationApi: false,
    supportsPrivacyScrape: false,
    createdAt: 0,
    updatedAt: 0,
  }
}

function capability(prefill?: CapabilityDescriptor['prefill']): CapabilityDescriptor {
  return {
    supportedParameters: ['reasoning'],
    streaming: 'supported',
    ...(prefill ? { prefill } : {}),
  }
}

function plan(
  chatSettings: ChatSettings,
  descriptor: CapabilityDescriptor = capability(),
  connection = profile(),
) {
  return resolveEffectiveEndpointRouting({
    profile: connection,
    settings: chatSettings,
    contextFacts: EMPTY_MESSAGE_CONTEXT_ROUTE_FACTS,
    capability: descriptor,
  }).prefillPlan
}

describe('effective prefill plan', () => {
  it('does not offer compatibility patches for an explicitly unsupported Gemini model', () => {
    const result = plan(
      settings({
        model: 'google/gemini-3.6-flash',
        reasoning: { ...cloneDefaultChatSettings().reasoning, mode: 'enabled' },
      }),
    )
    expect(result).toMatchObject({
      availability: 'unsupported',
      basis: 'model-quirk',
      continueStrategy: 'prompt',
      semanticRetry: 'never',
    })
  })

  it('recommends only the visible settings change for toggleable OSS prefill', () => {
    const result = plan(
      settings({
        model: 'z-ai/glm-5.1',
        reasoning: { ...cloneDefaultChatSettings().reasoning, mode: 'default' },
        providerPrefs: { only: ['fireworks'] },
      }),
      capability({ kind: 'assistant-tail', marker: 'partial' }),
    )
    expect(result).toMatchObject({
      availability: 'supported',
      basis: 'endpoint-capability',
      serialization: { kind: 'assistant-tail', marker: 'partial' },
      recommendation: {
        issues: ['turn reasoning off'],
        patch: { reasoning: { mode: 'off' } },
      },
    })
    if (result.availability === 'unsupported') throw new Error('ExpectedSupportedPrefillPlan')
    expect(result.recommendation?.patch.providerPrefs).toBeUndefined()
  })

  it('warns once for an unknown endpoint without rewriting provider preferences', () => {
    const result = plan(
      settings({
        model: 'z-ai/glm-5.1',
        reasoning: { ...cloneDefaultChatSettings().reasoning, mode: 'off' },
        providerPrefs: { only: ['atlascloud'] },
      }),
    )
    expect(result).toMatchObject({
      availability: 'warned-attempt',
      basis: 'unknown-endpoint',
      request: 'send-once',
      semanticRetry: 'never',
      serialization: { kind: 'assistant-tail', marker: 'none' },
    })
    if (result.availability === 'unsupported') throw new Error('ExpectedWarnedPrefillPlan')
    expect(result.recommendation).toBeUndefined()
  })

  it('does not recommend changes for forced-reasoning OSS models', () => {
    const result = plan(
      settings({
        model: 'deepseek/deepseek-r1',
        reasoning: { ...cloneDefaultChatSettings().reasoning, mode: 'enabled' },
      }),
    )
    expect(result.availability).toBe('warned-attempt')
    if (result.availability === 'unsupported') throw new Error('ExpectedWarnedPrefillPlan')
    expect(result.recommendation).toBeUndefined()
  })

  it('uses the OpenRouter transport contract without endpoint-specific markers', () => {
    const result = plan(
      settings({ model: 'z-ai/glm-5.1' }),
      capability({ kind: 'assistant-tail', marker: 'prefix' }),
      profile('openrouter'),
    )
    expect(result).toMatchObject({
      availability: 'supported',
      basis: 'transport',
      serialization: { kind: 'assistant-tail', marker: 'none' },
    })
  })

  it('dismisses a recommendation without mutating chat settings', () => {
    render(
      createElement(PrefillSettingsPrompt, {
        chatId: 'chat-prefill',
        plan: {
          availability: 'supported',
          continueStrategy: 'prefill',
          request: 'send-once',
          semanticRetry: 'never',
          serialization: { kind: 'assistant-tail', marker: 'none' },
          basis: 'transport',
          recommendation: {
            issues: ['turn reasoning off'],
            patch: { reasoning: { ...cloneDefaultChatSettings().reasoning, mode: 'off' } },
          },
        },
      }),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))

    expect(screen.queryByText(/For best prefill results/u)).toBeNull()
    expect(configurationMocks.patchChatSettings).not.toHaveBeenCalled()
  })

  it('surfaces a warned one-shot attempt without offering a hidden routing patch', () => {
    render(
      createElement(PrefillSettingsPrompt, {
        chatId: 'chat-prefill',
        plan: {
          availability: 'warned-attempt',
          continueStrategy: 'prefill',
          request: 'send-once',
          semanticRetry: 'never',
          serialization: { kind: 'assistant-tail', marker: 'none' },
          basis: 'unknown-endpoint',
          warning:
            'This endpoint does not advertise prefill support; the request will be attempted once.',
        },
      }),
    )

    expect(screen.getByText(/attempted once/u)).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull()
  })
})
