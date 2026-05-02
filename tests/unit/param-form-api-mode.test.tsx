import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveBundledCapability } from '../../src/capabilities'
import {
  effectiveCapabilityFromDescriptor,
  effectiveCapabilityFromEndpoints,
} from '../../src/core/capabilities'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type { ConnectionProfile, Message, ModelEndpoint } from '../../src/core/types'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import { createChat, getChat } from '../../src/store/chats'
import { __resetDbForTests, openDb } from '../../src/store/db'
import { ApiModeSection, ReasoningIncludeControls } from '../../src/ui/settings/ParamForm'

const DB_NAME = 'natter'

function makeEndpoint(overrides: Partial<ModelEndpoint> = {}): ModelEndpoint {
  return {
    provider_name: 'OpenAI',
    supported_parameters: ['reasoning', 'max_tokens'],
    context_length: 128000,
    pricing: {},
    ...overrides,
  }
}

function makeProfile(kind: ConnectionProfile['kind']): ConnectionProfile {
  return {
    id: 'prof-1',
    name: 'test',
    kind,
    baseUrl: kind === 'openai-compatible' ? 'https://api.openai.com/v1' : 'https://x.y',
    apiKeyRef: 'key-1',
    defaultHeaders: {},
    appTitle: 'test',
    appUrl: '',
    supportsEndpointsApi: kind === 'openrouter',
    supportsGenerationApi: kind === 'openrouter',
    supportsPrivacyScrape: kind === 'openrouter',
    createdAt: 1,
    updatedAt: 1,
  }
}

async function resetAll() {
  __resetBroadcastForTests()
  __resetDbForTests()
  await Dexie.delete(DB_NAME)
}

beforeEach(async () => {
  ;(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory()
  await resetAll()
  await openDb()
})

afterEach(async () => {
  await resetAll()
})

describe('ApiModeSection — two-button toggle', () => {
  it('renders Chat/Responses buttons for OpenAI-family model with Responses route selected', async () => {
    // gpt-5.4-nano has responsesSupport: 'both'; on OR the new step 10
    // resolves to Responses → Responses button aria-pressed.
    const settings = cloneDefaultChatSettings()
    settings.model = 'openai/gpt-5.4-nano'
    const chat = await createChat({ settings })
    const capability = effectiveCapabilityFromEndpoints(settings.model, [makeEndpoint()])
    render(
      <ApiModeSection chat={chat} capability={capability} profile={makeProfile('openrouter')} />,
    )
    const chatBtn = screen.getByRole('button', { name: 'Chat completions' })
    const responsesBtn = screen.getByRole('button', { name: 'Responses' })
    expect(chatBtn).toBeTruthy()
    expect(responsesBtn).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Text completions' })).toBeNull()
    // No "Auto" button — collapsed with the resolved option.
    expect(screen.queryByRole('button', { name: /^Auto/ })).toBeNull()
    expect(responsesBtn.getAttribute('aria-pressed')).toBe('true')
    expect(chatBtn.getAttribute('aria-pressed')).toBe('false')
  })

  it('hides API mode for OpenRouter models whose only selectable route is chat completions', async () => {
    const settings = cloneDefaultChatSettings()
    settings.model = 'google/gemini-3.1-pro-preview'
    const chat = await createChat({ settings })
    const capability = effectiveCapabilityFromEndpoints(settings.model, [
      makeEndpoint({ supported_parameters: ['reasoning'] }),
    ])
    const { container } = render(
      <ApiModeSection chat={chat} capability={capability} profile={makeProfile('openrouter')} />,
    )
    expect(container.querySelector('[data-ui-section="api-mode"]')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Text completions' })).toBeNull()
  })

  it('persists Text completions for OpenRouter open-weight models', async () => {
    const settings = cloneDefaultChatSettings()
    settings.model = 'meta-llama/llama-3.3-70b-instruct'
    const chat = await createChat({ settings })
    const capability = effectiveCapabilityFromEndpoints(settings.model, [
      makeEndpoint({ provider_name: 'Nebius', supported_parameters: ['provider', 'max_tokens'] }),
    ])
    render(
      <ApiModeSection chat={chat} capability={capability} profile={makeProfile('openrouter')} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Text completions' }))
    await new Promise((r) => setTimeout(r, 20))
    const updated = await getChat(chat.id)
    expect(updated?.settings.api).toBe('text')
  })

  it('renders Gemini Native/OpenAI-compat as chat settings and persists compat mode', async () => {
    const settings = cloneDefaultChatSettings()
    settings.model = 'google/gemini-3.1-pro-preview'
    settings.api = 'gemini-native'
    const chat = await createChat({ settings })
    const capability = effectiveCapabilityFromEndpoints(settings.model, [
      makeEndpoint({ supported_parameters: ['reasoning'] }),
    ])
    render(<ApiModeSection chat={chat} capability={capability} profile={makeProfile('google')} />)
    expect(screen.getByRole('button', { name: 'Native' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'OpenAI-compat' }))
    await waitFor(async () => {
      const updated = await getChat(chat.id)
      expect(updated?.settings.api).toBe('chat')
    })
  })

  it('renders Anthropic Messages/OpenAI-compat as chat settings and persists compat mode', async () => {
    const settings = cloneDefaultChatSettings()
    settings.model = 'claude-haiku-4.5'
    settings.api = 'anthropic-messages'
    const chat = await createChat({ settings })
    const capability = effectiveCapabilityFromEndpoints(settings.model, [
      makeEndpoint({ supported_parameters: ['tools'] }),
    ])
    render(
      <ApiModeSection chat={chat} capability={capability} profile={makeProfile('anthropic')} />,
    )
    expect(screen.getByRole('button', { name: 'Messages' }).getAttribute('aria-pressed')).toBe(
      'true',
    )
    fireEvent.click(screen.getByRole('button', { name: 'OpenAI-compat' }))
    await waitFor(async () => {
      const updated = await getChat(chat.id)
      expect(updated?.settings.api).toBe('chat')
    })
  })

  it('persists the pin when the user clicks Chat completions', async () => {
    const settings = cloneDefaultChatSettings()
    // gpt-5.3: responsesSupport: 'both', preferApi: 'responses' (auto-picks
    // Responses), but NO requiresPhaseEcho — so clicking Chat doesn't trip
    // the phase-echo confirmation dialog.
    settings.model = 'openai/gpt-5.3'
    const chat = await createChat({ settings })
    const capability = effectiveCapabilityFromEndpoints(settings.model, [makeEndpoint()])
    render(
      <ApiModeSection chat={chat} capability={capability} profile={makeProfile('openrouter')} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Chat completions' }))
    await new Promise((r) => setTimeout(r, 20))
    const updated = await getChat(chat.id)
    expect(updated?.settings.api).toBe('chat')
  })

  it('gates the Chat pin behind a confirm() dialog on phase-echo models', async () => {
    // gpt-5.4-nano has requiresPhaseEcho — clicking Chat must trip the
    // confirmation. window.confirm is stubbed to return true, then the
    // pin is verified to persist.
    const settings = cloneDefaultChatSettings()
    settings.model = 'openai/gpt-5.4-nano'
    const chat = await createChat({ settings })
    const capability = effectiveCapabilityFromEndpoints(settings.model, [makeEndpoint()])
    const originalConfirm = window.confirm
    let prompted = false
    window.confirm = () => {
      prompted = true
      return true
    }
    try {
      render(
        <ApiModeSection chat={chat} capability={capability} profile={makeProfile('openrouter')} />,
      )
      fireEvent.click(screen.getByRole('button', { name: 'Chat completions' }))
      await new Promise((r) => setTimeout(r, 20))
    } finally {
      window.confirm = originalConfirm
    }
    expect(prompted).toBe(true)
    const updated = await getChat(chat.id)
    expect(updated?.settings.api).toBe('chat')
  })

  it('uses the active path when deciding the resolved route', async () => {
    const settings = cloneDefaultChatSettings()
    settings.model = 'openai/gpt-5.4-nano'
    const chat = await createChat({ settings })
    const capability = effectiveCapabilityFromEndpoints(settings.model, [makeEndpoint()])
    const path: readonly Message[] = [
      {
        id: 'm1',
        chatId: chat.id,
        parentId: null,
        siblingIndex: 0,
        turnId: 't1',
        turnIndex: 0,
        createdAt: 1,
        role: 'assistant',
        origin: 'generated',
        content: [{ type: 'output_text', text: 'hi' }],
        nodeVersion: 0,
        deleted: false,
        reasoningDetails: [
          {
            type: 'reasoning.encrypted',
            data: 'opaque',
            format: 'openai-responses-v1',
          },
        ],
      },
    ]
    render(
      <ApiModeSection
        chat={chat}
        capability={capability}
        profile={makeProfile('openrouter')}
        activePathMessages={path}
      />,
    )
    const chatBtn = screen.getByRole('button', { name: 'Chat completions' })
    const responsesBtn = screen.getByRole('button', { name: 'Responses' })
    expect(responsesBtn.getAttribute('aria-pressed')).toBe('true')
    expect(chatBtn.getAttribute('aria-pressed')).toBe('false')
  })
})

describe('ReasoningIncludeControls — include-in-next-turn gating', () => {
  it('shows reasoning and tool-call checkboxes for OpenAI-family model (emits encrypted)', async () => {
    const settings = cloneDefaultChatSettings()
    settings.model = 'openai/gpt-5.4-nano'
    const chat = await createChat({ settings })
    const capability = effectiveCapabilityFromEndpoints(settings.model, [makeEndpoint()])
    render(<ReasoningIncludeControls chat={chat} capability={capability} />)
    expect(screen.getByLabelText(/Encrypted reasoning/)).toBeTruthy()
    expect(screen.getByLabelText(/Visible summary/)).toBeTruthy()
    expect(screen.getByLabelText(/Visible text/)).toBeTruthy()
    expect(screen.getByLabelText('Tool calls')).toBeTruthy()
  })

  it('renders portable plaintext reasoning controls even when the target has no reasoning params', async () => {
    const settings = cloneDefaultChatSettings()
    settings.model = 'plain/model'
    const chat = await createChat({ settings })
    const capability = effectiveCapabilityFromEndpoints(settings.model, [
      makeEndpoint({ supported_parameters: ['temperature'] }),
    ])
    render(<ReasoningIncludeControls chat={chat} capability={capability} />)

    expect(screen.getByRole('heading', { name: 'Include in next turn' })).toBeTruthy()
    expect(screen.queryByLabelText(/Encrypted reasoning/)).toBeNull()
    expect(screen.getByLabelText(/Visible summary/)).toBeTruthy()
    expect(screen.getByLabelText(/Visible text/)).toBeTruthy()
    expect(screen.getByLabelText(/Send as/)).toBeTruthy()
    expect(screen.getByLabelText('Tool calls')).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Tool calls' })).toBeNull()
    expect(screen.queryByText('Include tool calls and results in next turn')).toBeNull()

    fireEvent.click(screen.getByLabelText('Tool calls'))
    await waitFor(async () => {
      const updated = await getChat(chat.id)
      expect(updated?.settings.toolCallContext.include).toBe(false)
    })
  })

  it('hides the Encrypted checkbox when the model does not emit encrypted reasoning', async () => {
    const settings = cloneDefaultChatSettings()
    // Gemini 2.5 → emitsEncryptedReasoning: 'never' (per-user directive).
    settings.model = 'google/gemini-2.5-flash'
    const chat = await createChat({ settings })
    const capability = effectiveCapabilityFromEndpoints(settings.model, [
      makeEndpoint({ supported_parameters: ['reasoning'] }),
    ])
    render(<ReasoningIncludeControls chat={chat} capability={capability} />)
    expect(screen.queryByLabelText(/Encrypted reasoning/)).toBeNull()
    expect(screen.getByLabelText(/Visible summary/)).toBeTruthy()
    expect(screen.getByLabelText(/Visible text/)).toBeTruthy()
  })

  it('shows Gemini native reasoning include options from the bundled thinking capability', async () => {
    const settings = cloneDefaultChatSettings()
    settings.model = 'google/gemini-3.1-flash-lite-preview'
    const chat = await createChat({ settings })
    const capability = effectiveCapabilityFromDescriptor(
      settings.model,
      resolveBundledCapability(
        {
          id: 'p',
          name: 'Google',
          kind: 'google',
          baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
          apiKeyRef: 'k',
          defaultHeaders: {},
          appTitle: '',
          appUrl: '',
          supportsEndpointsApi: false,
          supportsGenerationApi: false,
          supportsPrivacyScrape: false,
          createdAt: 0,
          updatedAt: 0,
        },
        settings.model,
      ),
    )
    render(<ReasoningIncludeControls chat={chat} capability={capability} />)
    expect(screen.getByLabelText(/Encrypted reasoning/)).toBeTruthy()
    expect(screen.getByLabelText(/Visible summary/)).toBeTruthy()
    expect(screen.getByLabelText(/Visible text/)).toBeTruthy()
    expect(screen.getByLabelText(/Send as/)).toBeTruthy()
    expect(screen.getByLabelText('Tool calls')).toBeTruthy()
  })

  it('hides the Encrypted checkbox for unknown-format models (DeepSeek / Qwen / Gemma)', async () => {
    const settings = cloneDefaultChatSettings()
    settings.model = 'deepseek/deepseek-v3.2'
    const chat = await createChat({ settings })
    const capability = effectiveCapabilityFromEndpoints(settings.model, [
      makeEndpoint({ supported_parameters: ['reasoning'] }),
    ])
    render(<ReasoningIncludeControls chat={chat} capability={capability} />)
    expect(screen.queryByLabelText(/Encrypted reasoning/)).toBeNull()
  })

  it('all shown checkboxes are clickable (no disabled gating per user directive)', async () => {
    const settings = cloneDefaultChatSettings()
    settings.model = 'openai/gpt-5.4-nano'
    const chat = await createChat({ settings })
    const capability = effectiveCapabilityFromEndpoints(settings.model, [makeEndpoint()])
    render(<ReasoningIncludeControls chat={chat} capability={capability} />)
    expect(screen.getByLabelText<HTMLInputElement>(/Encrypted reasoning/).disabled).toBe(false)
    expect(screen.getByLabelText<HTMLInputElement>(/Visible summary/).disabled).toBe(false)
    expect(screen.getByLabelText<HTMLInputElement>(/Visible text/).disabled).toBe(false)
  })

  it('locks Send as think on for text completions', async () => {
    const settings = cloneDefaultChatSettings()
    settings.model = 'meta-llama/llama-3.3-70b-instruct'
    settings.api = 'text'
    settings.reasoning.include = { encrypted: false, summary: false, text: false }
    settings.reasoning.echoAsThinkTags = false
    const chat = await createChat({ settings })
    const capability = effectiveCapabilityFromEndpoints(settings.model, [makeEndpoint()])
    render(<ReasoningIncludeControls chat={chat} capability={capability} />)

    const sendAsThink = screen.getByLabelText<HTMLInputElement>(/Send as/)
    expect(sendAsThink.checked).toBe(true)
    expect(sendAsThink.disabled).toBe(true)
  })
})
