import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectiveCapabilityFromEndpoints } from '../../src/core/capabilities'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type { ConnectionProfile, ModelEndpoint } from '../../src/core/types'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import { createChat, getChat } from '../../src/store/chats'
import { __resetDbForTests, openDb } from '../../src/store/db'
import { exportChatPreset } from '../../src/store/import-export'
import { createPreset, listPresets } from '../../src/store/presets'
import { createProfile } from '../../src/store/profiles'
import { ChatModelPanel } from '../../src/ui/settings/ChatModelPanel'
import { ParamForm } from '../../src/ui/settings/ParamForm'

const DB_NAME = 'natter'

function mockBlobDownloads() {
  const originalCreateObjectURL = URL.createObjectURL
  const originalRevokeObjectURL = URL.revokeObjectURL
  const createdBlobs: Blob[] = []
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn((blob: Blob) => {
      createdBlobs.push(blob)
      return `blob:natter-${createdBlobs.length}`
    }),
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn(),
  })
  const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  return {
    createdBlobs,
    clickSpy,
    restore() {
      clickSpy.mockRestore()
      Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        value: originalCreateObjectURL,
      })
      Object.defineProperty(URL, 'revokeObjectURL', {
        configurable: true,
        value: originalRevokeObjectURL,
      })
    },
  }
}

function makeEndpoint(overrides: Partial<ModelEndpoint> = {}): ModelEndpoint {
  return {
    provider_name: 'Anthropic',
    supported_parameters: ['max_tokens', 'verbosity'],
    context_length: 200000,
    pricing: {},
    ...overrides,
  }
}

function makeProfile(overrides: Partial<ConnectionProfile> = {}): ConnectionProfile {
  return {
    id: 'profile-1',
    name: 'Profile',
    kind: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyRef: 'key-1',
    defaultHeaders: {},
    appTitle: 'natter',
    appUrl: '',
    supportsEndpointsApi: true,
    supportsGenerationApi: true,
    supportsPrivacyScrape: true,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
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
  vi.restoreAllMocks()
  await resetAll()
})

describe('ParamForm verbosity reset', () => {
  it('exposes an enabled reasoning mode for adaptive Claude 4.7', async () => {
    const settings = cloneDefaultChatSettings()
    settings.model = 'anthropic/claude-opus-4.7'
    const chat = await createChat({ settings })
    const capability = effectiveCapabilityFromEndpoints(settings.model, [
      makeEndpoint({ supported_parameters: ['reasoning', 'verbosity', 'max_tokens'] }),
    ])
    const { container } = render(<ParamForm chat={chat} capability={capability} />)
    const section = container.querySelector('[data-ui-section="reasoning"]')
    expect(section).toBeTruthy()
    const modeControl = section?.querySelector('[data-ui="field-group"] [data-ui="segmented"]')
    const labels = Array.from(
      modeControl?.querySelectorAll<HTMLButtonElement>('[data-ui="segmented-option"]') ?? [],
    ).map((button) => button.textContent)
    expect(labels).toEqual(['default', 'off', 'enabled'])
    expect(section?.textContent).not.toContain('effort and budget are ignored')
    expect(section?.querySelector('[data-ui="info-hint"]')?.getAttribute('title')).toContain(
      'effort and budget are ignored',
    )
  })

  it('keeps future adaptive Claude Opus releases on the enabled-only reasoning UI', async () => {
    const settings = cloneDefaultChatSettings()
    settings.model = 'anthropic/claude-opus-4.8'
    const chat = await createChat({ settings })
    const capability = effectiveCapabilityFromEndpoints(settings.model, [
      makeEndpoint({ supported_parameters: ['reasoning', 'verbosity', 'max_tokens'] }),
    ])
    const { container } = render(<ParamForm chat={chat} capability={capability} />)
    const section = container.querySelector('[data-ui-section="reasoning"]')
    const modeControl = section?.querySelector('[data-ui="field-group"] [data-ui="segmented"]')
    const labels = Array.from(
      modeControl?.querySelectorAll<HTMLButtonElement>('[data-ui="segmented-option"]') ?? [],
    ).map((button) => button.textContent)
    expect(labels).toEqual(['default', 'off', 'enabled'])
  })

  it('keeps fixed reasoning budgets available for Claude 4.6', async () => {
    const settings = cloneDefaultChatSettings()
    settings.model = 'anthropic/claude-opus-4.6'
    const chat = await createChat({ settings })
    const capability = effectiveCapabilityFromEndpoints(settings.model, [
      makeEndpoint({ supported_parameters: ['reasoning', 'verbosity', 'max_tokens'] }),
    ])
    const { container } = render(<ParamForm chat={chat} capability={capability} />)
    const section = container.querySelector('[data-ui-section="reasoning"]')
    expect(section).toBeTruthy()
    const modeControl = section?.querySelector('[data-ui="field-group"] [data-ui="segmented"]')
    const labels = Array.from(
      modeControl?.querySelectorAll<HTMLButtonElement>('[data-ui="segmented-option"]') ?? [],
    ).map((button) => button.textContent)
    expect(labels).toEqual(['default', 'off', 'enabled', 'budget'])
    expect(section?.textContent).not.toContain('Budget uses a fixed token cap')
    expect(section?.querySelector('[data-ui="info-hint"]')?.getAttribute('title')).toContain(
      'Budget uses a fixed token cap',
    )
  })

  it('renders a leftmost default option for Claude verbosity controls', async () => {
    const settings = cloneDefaultChatSettings()
    settings.model = 'anthropic/claude-opus-4.6'
    const chat = await createChat({ settings })
    const capability = effectiveCapabilityFromEndpoints('anthropic/claude-opus-4.6', [
      makeEndpoint(),
    ])
    const { container } = render(<ParamForm chat={chat} capability={capability} />)
    const section = container.querySelector('[data-ui-section="verbosity"]')
    expect(section).toBeTruthy()
    const labels = Array.from(
      section?.querySelectorAll<HTMLButtonElement>('[data-ui="segmented-option"]') ?? [],
    ).map((button) => button.textContent)
    expect(labels).toEqual(['default', 'low', 'medium', 'high', 'max'])
    expect(screen.getByRole('button', { name: 'default' }).getAttribute('aria-pressed')).toBe(
      'true',
    )
  })

  it('clears stored verbosity when default is selected', async () => {
    const settings = cloneDefaultChatSettings()
    settings.model = 'anthropic/claude-opus-4.6'
    settings.verbosity = 'high'
    const chat = await createChat({ settings })
    const capability = effectiveCapabilityFromEndpoints('anthropic/claude-opus-4.6', [
      makeEndpoint(),
    ])
    render(<ParamForm chat={chat} capability={capability} />)
    fireEvent.click(screen.getByRole('button', { name: 'default' }))
    await waitFor(async () => {
      const updated = await getChat(chat.id)
      expect(updated?.settings.verbosity).toBeUndefined()
      expect('verbosity' in (updated?.settings ?? {})).toBe(false)
    })
  })
})

describe('ParamForm reasoning budget persistence', () => {
  it('does not persist max reasoning tokens on every drag tick, only after the value settles', async () => {
    const settings = cloneDefaultChatSettings()
    settings.model = 'openai/gpt-5.4-nano'
    settings.reasoning = { ...settings.reasoning, mode: 'budget', maxTokens: 64 }
    const chat = await createChat({ settings })
    const capability = effectiveCapabilityFromEndpoints(settings.model, [
      makeEndpoint({
        supported_parameters: ['reasoning', 'max_tokens'],
        max_completion_tokens: 32000,
      }),
    ])
    const { container } = render(<ParamForm chat={chat} capability={capability} />)

    const slider = container.querySelector<HTMLInputElement>(
      '[data-ui-section="reasoning"] [data-ui="slider"]',
    )
    expect(slider).toBeTruthy()
    fireEvent.change(slider as HTMLInputElement, { target: { value: '2048' } })

    expect((await getChat(chat.id))?.settings.reasoning.maxTokens).toBe(64)

    await new Promise((resolve) => setTimeout(resolve, 250))
    await waitFor(async () => {
      expect((await getChat(chat.id))?.settings.reasoning.maxTokens).toBe(2048)
    })
  })
})

describe('ParamForm hosted tools', () => {
  it('renders hosted-tool controls and persists checkbox changes on OpenRouter chat mode', async () => {
    const settings = cloneDefaultChatSettings()
    settings.model = 'openai/gpt-5.4-nano'
    const chat = await createChat({ settings })
    const capability = effectiveCapabilityFromEndpoints(settings.model, [
      makeEndpoint({ supported_parameters: ['tools', 'tool_choice'] }),
    ])
    const { container } = render(
      <ParamForm chat={chat} capability={capability} connectionKind="openrouter" />,
    )
    const section = container.querySelector('[data-ui-section="hosted-tools"]')
    expect(section).toBeTruthy()
    expect(section?.querySelector('h3')?.textContent).toContain('OpenRouter tools')

    fireEvent.click(screen.getByLabelText('Web search'))

    await waitFor(async () => {
      expect((await getChat(chat.id))?.settings.tools.openrouter.enabledServerToolIds).toContain(
        'web-search',
      )
    })
  })

  it('renders direct OpenAI tools and persists them in the OpenAI bucket', async () => {
    const settings = cloneDefaultChatSettings()
    settings.model = 'gpt-5.4-nano'
    const chat = await createChat({ settings })
    const capability = effectiveCapabilityFromEndpoints(settings.model, [
      makeEndpoint({ supported_parameters: ['tools', 'tool_choice'] }),
    ])
    const profile = makeProfile({
      kind: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
    })
    const { container } = render(
      <ParamForm
        chat={chat}
        capability={capability}
        connectionKind="openai-compatible"
        connectionProfile={profile}
      />,
    )
    const section = container.querySelector('[data-ui-section="hosted-tools"]')
    expect(section).toBeTruthy()
    expect(section?.querySelector('h3')?.textContent).toContain('OpenAI tools')

    fireEvent.click(screen.getByLabelText('Web search'))

    await waitFor(async () => {
      const stored = await getChat(chat.id)
      expect(stored?.settings.tools.openai.enabledServerToolIds).toContain('web-search')
      expect(stored?.settings.tools.openrouter.enabledServerToolIds).toEqual([])
    })
  })

  it('renders Gemini tools and persists them in the Google bucket', async () => {
    const settings = cloneDefaultChatSettings()
    settings.model = 'google/gemini-3.1-flash-lite-preview'
    settings.api = 'gemini-native'
    const chat = await createChat({ settings })
    const capability = effectiveCapabilityFromEndpoints(settings.model, [
      makeEndpoint({ supported_parameters: ['tools', 'tool_choice'] }),
    ])
    const profile = makeProfile({
      kind: 'google',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    })
    const { container } = render(
      <ParamForm
        chat={chat}
        capability={capability}
        connectionKind="google"
        connectionProfile={profile}
      />,
    )
    const section = container.querySelector('[data-ui-section="hosted-tools"]')
    expect(section).toBeTruthy()
    expect(section?.querySelector('h3')?.textContent).toContain('Gemini tools')

    fireEvent.click(screen.getByLabelText('Google Search'))

    await waitFor(async () => {
      const stored = await getChat(chat.id)
      expect(stored?.settings.tools.google.enabledServerToolIds).toContain('google-search')
      expect(stored?.settings.tools.openrouter.enabledServerToolIds).toEqual([])
    })
  })

  it('renders Anthropic tools and persists them in the Anthropic bucket', async () => {
    const settings = cloneDefaultChatSettings()
    settings.model = 'anthropic/claude-haiku-4.5'
    settings.api = 'anthropic-messages'
    const chat = await createChat({ settings })
    const capability = effectiveCapabilityFromEndpoints(settings.model, [
      makeEndpoint({ supported_parameters: ['tools', 'tool_choice'] }),
    ])
    const profile = makeProfile({
      kind: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
    })
    const { container } = render(
      <ParamForm
        chat={chat}
        capability={capability}
        connectionKind="anthropic"
        connectionProfile={profile}
      />,
    )
    const section = container.querySelector('[data-ui-section="hosted-tools"]')
    expect(section).toBeTruthy()
    expect(section?.querySelector('h3')?.textContent).toContain('Anthropic tools')

    fireEvent.click(screen.getByLabelText('Web search'))

    await waitFor(async () => {
      const stored = await getChat(chat.id)
      expect(stored?.settings.tools.anthropic.enabledServerToolIds).toContain('web-search')
      expect(stored?.settings.tools.openrouter.enabledServerToolIds).toEqual([])
    })
  })

  it('omits hosted-tool controls on unsupported connections and text-completions routes', async () => {
    const settings = cloneDefaultChatSettings()
    settings.model = 'openai/gpt-5.4-nano'
    const chat = await createChat({ settings })
    const capability = effectiveCapabilityFromEndpoints(settings.model, [
      makeEndpoint({ supported_parameters: ['tools', 'tool_choice'] }),
    ])
    for (const connectionKind of ['llama-server', 'custom'] as const) {
      const rendered = render(
        <ParamForm chat={chat} capability={capability} connectionKind={connectionKind} />,
      )
      expect(rendered.container.querySelector('[data-ui-section="hosted-tools"]')).toBeNull()
      rendered.unmount()
    }

    const textMode = render(
      <ParamForm
        chat={chat}
        capability={capability}
        connectionKind="openrouter"
        textCompletionsActive
      />,
    )
    expect(textMode.container.querySelector('[data-ui-section="hosted-tools"]')).toBeNull()
  })

  it('omits OpenRouter hosted-tool controls when the selected model does not support tools', async () => {
    const settings = cloneDefaultChatSettings()
    settings.model = 'openai/gpt-5.4-nano'
    const chat = await createChat({ settings })
    const capability = effectiveCapabilityFromEndpoints(settings.model, [
      makeEndpoint({ supported_parameters: ['temperature'] }),
    ])
    const { container } = render(
      <ParamForm chat={chat} capability={capability} connectionKind="openrouter" />,
    )

    expect(container.querySelector('[data-ui-section="hosted-tools"]')).toBeNull()
  })
})

describe('ChatModelPanel context tab', () => {
  it('renders the OpenAI Responses store toggle on the Model tab and persists it', async () => {
    const profile = await createProfile({
      name: 'OpenAI',
      kind: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      apiKeyRef: 'key-1',
    })
    const settings = cloneDefaultChatSettings()
    settings.profileId = profile.id
    settings.model = 'gpt-5.4-nano'
    settings.api = 'responses'
    const chat = await createChat({ settings })
    render(<ChatModelPanel chatSnapshot={chat} onClose={() => undefined} />)

    const checkbox = await screen.findByLabelText(/Pass store: true upstream/)
    expect(checkbox).not.toBeChecked()
    fireEvent.click(checkbox)

    await waitFor(async () => {
      const updated = await getChat(chat.id)
      expect(updated?.settings.responses?.store).toBe(true)
    })
  })

  it('hides tool-call context controls until a model is selected', async () => {
    const settings = cloneDefaultChatSettings()
    settings.model = ''
    const chat = await createChat({ settings })
    render(<ChatModelPanel chatSnapshot={chat} onClose={() => undefined} />)

    fireEvent.click(await screen.findByRole('tab', { name: 'Context' }))

    expect(await screen.findByText('Select a model first.')).toBeTruthy()
    expect(screen.queryByLabelText('Tool calls')).toBeNull()
  })

  it('exports chat settings presets from the preset menu', async () => {
    const profile = await createProfile({
      name: 'OpenRouter',
      kind: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKeyRef: 'key-1',
    })
    const settings = cloneDefaultChatSettings()
    settings.profileId = profile.id
    settings.model = 'openai/gpt-4o'
    const preset = await createPreset({
      name: 'Portable',
      connectionProfileId: profile.id,
      settings,
    })
    const chat = await createChat({ settings, presetId: preset.id })
    const downloads = mockBlobDownloads()
    try {
      render(<ChatModelPanel chatSnapshot={chat} onClose={() => undefined} />)

      fireEvent.click(await screen.findByRole('button', { name: /Preset:/ }))
      fireEvent.click(await screen.findByRole('button', { name: 'Export preset "Portable" JSON' }))

      await waitFor(() => expect(downloads.clickSpy).toHaveBeenCalled())
      expect(downloads.createdBlobs).toHaveLength(1)
      const exported = JSON.parse(await (downloads.createdBlobs[0] as Blob).text()) as {
        objectKind: string
        payload: { name: string; sourcePresetId: string }
      }
      expect(exported.objectKind).toBe('chat-preset')
      expect(exported.payload).toMatchObject({ name: 'Portable', sourcePresetId: preset.id })
    } finally {
      downloads.restore()
    }
  })

  it('reorders chat settings presets by dragging rows in the preset menu', async () => {
    const profile = await createProfile({
      name: 'OpenRouter',
      kind: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKeyRef: 'key-1',
    })
    const settings = cloneDefaultChatSettings()
    settings.profileId = profile.id
    settings.model = 'openai/gpt-4o'
    const first = await createPreset({
      name: 'First',
      connectionProfileId: profile.id,
      settings,
      now: 10,
    })
    const second = await createPreset({
      name: 'Second',
      connectionProfileId: profile.id,
      settings,
      now: 20,
    })
    const third = await createPreset({
      name: 'Third',
      connectionProfileId: profile.id,
      settings,
      now: 30,
    })
    const chat = await createChat({ settings, presetId: first.id })
    const { container } = render(<ChatModelPanel chatSnapshot={chat} onClose={() => undefined} />)
    const presetNames = () =>
      Array.from(container.querySelectorAll<HTMLButtonElement>('[data-ui="preset-menu-load"]')).map(
        (button) => (button.textContent ?? '').trim(),
      )

    fireEvent.click(await screen.findByRole('button', { name: /Preset:/ }))
    await waitFor(() => {
      expect(presetNames()).toEqual(['First', 'Second', 'Third'])
    })

    const firstRow = container.querySelector<HTMLElement>(
      `[data-ui="preset-menu-item"][data-preset-id="${first.id}"]`,
    )
    const secondRow = container.querySelector<HTMLElement>(
      `[data-ui="preset-menu-item"][data-preset-id="${second.id}"]`,
    )
    const thirdRow = container.querySelector<HTMLElement>(
      `[data-ui="preset-menu-item"][data-preset-id="${third.id}"]`,
    )
    expect(firstRow).toBeTruthy()
    expect(secondRow).toBeTruthy()
    expect(thirdRow).toBeTruthy()
    Object.defineProperty(firstRow, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ top: 0, bottom: 20, height: 20, left: 0, right: 200, width: 200 }),
    })
    Object.defineProperty(secondRow, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ top: 20, bottom: 40, height: 20, left: 0, right: 200, width: 200 }),
    })
    Object.defineProperty(thirdRow, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ top: 40, bottom: 60, height: 20, left: 0, right: 200, width: 200 }),
    })

    const thirdHandle = await screen.findByRole('button', {
      name: 'Drag preset "Third" to reorder',
    })
    fireEvent.pointerDown(thirdHandle, { pointerId: 1, button: 0, clientY: 50 })
    fireEvent.pointerMove(thirdHandle, { pointerId: 1, clientY: -1 })
    expect(presetNames()).toEqual(['Third', 'First', 'Second'])
    fireEvent.pointerUp(thirdHandle, { pointerId: 1, clientY: -1 })
    expect(presetNames()).toEqual(['Third', 'First', 'Second'])

    await waitFor(async () => {
      expect((await listPresets()).map((p) => p.id)).toEqual([third.id, first.id, second.id])
    })
  })

  it('imports chat settings presets from the preset menu', async () => {
    const profile = await createProfile({
      name: 'OpenRouter',
      kind: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKeyRef: 'key-1',
    })
    const settings = cloneDefaultChatSettings()
    settings.profileId = profile.id
    settings.model = 'openai/gpt-4o'
    const preset = await createPreset({
      name: 'Portable',
      connectionProfileId: profile.id,
      settings,
    })
    const envelope = await exportChatPreset(preset.id)
    const chat = await createChat({ settings, presetId: preset.id })
    const { container } = render(<ChatModelPanel chatSnapshot={chat} onClose={() => undefined} />)

    fireEvent.click(await screen.findByRole('button', { name: /Preset:/ }))
    const input = container.querySelector<HTMLInputElement>('[data-ui="preset-import-input"]')
    expect(input).toBeTruthy()
    fireEvent.change(input as HTMLInputElement, {
      target: {
        files: [new File([JSON.stringify(envelope)], 'preset.json', { type: 'application/json' })],
      },
    })

    await waitFor(async () => {
      const presets = await listPresets()
      expect(presets.map((row) => row.name).sort()).toEqual(['Portable', 'Portable (2)'])
    })
  })
})
