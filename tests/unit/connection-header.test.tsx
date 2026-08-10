import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createChat } from '../helpers/chats'
import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import { DEFAULT_GLOBAL_PREFERENCES } from '../../src/core/global-settings'
import { DEFAULT_RENDERING_PREFS } from '../../src/core/rendering-preferences'
import type { Chat, ConnectionProfile } from '../../src/core/types'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import {
  openBrowserWorkspace,
  shutdownBrowserWorkspace,
} from '../../src/store/browser-workspace-lifecycle'

import { configurationApplication } from '../../src/store/configuration-application'
import {
  type ConfigurationProjectionSource,
  configurationController,
} from '../../src/store/configuration-controller'
import type { ConversationSnapshot } from '../../src/store/conversation-controller'
import { __resetDbForTests } from '../../src/store/db'
import { __resetKeyCacheForTests, createKey } from '../../src/store/keys'
import type {
  ConfigurationActiveSelectionProjection,
  ConfigurationShellProjection,
} from '../../src/store/workspace-protocol'
import { ConnectionHeader } from '../../src/ui/header/ConnectionHeader'
import {
  createConfigurationChatPreset,
  createConfigurationProfile,
  getConfigurationProfile,
  listConfigurationChatPresets,
  listConfigurationProfiles,
} from '../helpers/configuration'

const DB_NAME = 'natter'

const writeActiveProfileId = (profileId: string | null) =>
  configurationController.rememberProfile(profileId)
const readActiveProfileId = () => {
  const seed = configurationController.getSnapshot().seed
  return seed.settings?.profileId || seed.profileId
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function mockOnboardingModels(...modelIds: string[]): void {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    jsonResponse({ data: modelIds.map((id) => ({ id, supported_parameters: ['tools'] })) }),
  )
}

function openRouterProbeEndpoints(modelId: string): Response {
  return jsonResponse({
    data: {
      id: modelId,
      endpoints: [
        {
          provider_name: 'OpenAI',
          supported_parameters: ['tools'],
          context_length: 128_000,
          pricing: {},
        },
      ],
    },
  })
}

async function resetAll() {
  __resetBroadcastForTests()
  __resetKeyCacheForTests()
  __resetDbForTests()
  window.localStorage.clear()
  await Dexie.delete(DB_NAME)
}

async function seedProfile(
  overrides: Partial<Parameters<typeof createConfigurationProfile>[0]> & {
    key?: string | null
  } = {},
) {
  const name = overrides.name ?? 'OpenRouter'
  const key =
    overrides.key === undefined
      ? 'sk-or-v1-test-0000000000000000000000000000000000000000'
      : overrides.key
  const apiKeyRef = key === null ? undefined : (await createKey({ name, plaintextKey: key })).id
  return createConfigurationProfile({
    name,
    kind: overrides.kind ?? 'openrouter',
    baseUrl: overrides.baseUrl ?? 'https://openrouter.ai/api/v1',
    ...(apiKeyRef ? { apiKeyRef } : {}),
  })
}

function connectionButtonMatcher(name: string): RegExp {
  return new RegExp(`Connection: ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
}

async function openConnectionPopover(name: string) {
  const button = await screen.findByRole('button', { name: connectionButtonMatcher(name) })
  await waitFor(() => expect(button).not.toBeDisabled())
  fireEvent.click(button)
  await screen.findByRole('region', { name: `Connection: ${name}` })
}

function observeActiveChat(chat: Chat | null): void {
  const fence = configurationController.getSnapshot().workspaceFence
  if (!fence) throw new Error('ConfigurationWorkspaceNotReconciled')
  configurationController.observeConversation({
    workspaceId: fence.workspaceId,
    workspaceEpoch: fence.replacementEpoch,
    activeChatId: chat?.id ?? null,
    active: chat
      ? ({ chatId: chat.id, chat } as NonNullable<ConversationSnapshot['active']>)
      : null,
  })
}

beforeEach(async () => {
  ;(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory()
  await resetAll()
  await openBrowserWorkspace()
})

afterEach(async () => {
  // Unmount the React tree BEFORE resetting the DB. The header's
  // observable queries hold a live Dexie handle; closing the DB while
  // those are still resolving makes vitest flag a `DatabaseClosedError`
  // unhandled rejection. Cleanup first cancels the subscriptions.
  cleanup()
  vi.restoreAllMocks()
  await new Promise((resolve) => setTimeout(resolve, 10))
  await shutdownBrowserWorkspace()
  await resetAll()
})

describe('ConnectionHeader', () => {
  it('renders the current OpenRouter v2 glyph', async () => {
    const profile = await seedProfile()
    writeActiveProfileId(profile.id)
    render(<ConnectionHeader variant="title-icon" />)

    const button = await screen.findByRole('button', {
      name: connectionButtonMatcher('OpenRouter'),
    })
    const icon = button.querySelector('svg[data-icon="openrouter"]')
    const path = icon?.querySelector('path')

    expect(icon).toHaveAttribute('viewBox', '0 0 401.4 293.7')
    expect(path?.getAttribute('d')).toMatch(/^M303\.9475,17\.19926/u)
  })

  it('creates a first connection from the full setup dialog with any provider + name', async () => {
    mockOnboardingModels('local/default-model')
    render(<ConnectionHeader />)
    fireEvent.click(await screen.findByText('Add connection'))
    await waitFor(() => {
      expect(screen.getByLabelText('Add connection')).toBeTruthy()
    })
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Local llama' } })
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'llama-server' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(async () => {
      expect(await listConfigurationProfiles()).toHaveLength(1)
      expect(await listConfigurationChatPresets()).toHaveLength(1)
    })
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Add connection' })).not.toBeInTheDocument()
    })
    expect(screen.queryByRole('button', { name: 'Add connection' })).toBeNull()
    const profiles = await listConfigurationProfiles()
    const presets = await listConfigurationChatPresets()
    expect(profiles).toHaveLength(1)
    expect(profiles[0]?.kind).toBe('llama-server')
    expect(profiles[0]?.name).toBe('Local llama')
    expect(presets).toHaveLength(1)
    expect(presets[0]?.settings.model).toBe('local/default-model')
  })

  it('keeps the connection popover open while its portalled setup dialog is used', async () => {
    mockOnboardingModels('models/gemini-3.5-flash')
    const profile = await seedProfile()
    writeActiveProfileId(profile.id)
    render(<ConnectionHeader variant="title-icon" />)
    await openConnectionPopover('OpenRouter')

    fireEvent.click(screen.getByRole('button', { name: 'Add new connection profile' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Google' } })
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'google' } })
    const save = screen.getByRole('button', { name: 'Save' })
    fireEvent.pointerDown(save)
    expect(screen.getByRole('region', { name: 'Connection: OpenRouter' })).toBeInTheDocument()
    fireEvent.click(save)

    const region = await screen.findByRole('region', { name: 'Connection: Google' })
    expect(region.querySelector('[data-ui="connection-name"]')).toHaveTextContent('Google')
  })

  it('shows Edit, Test, and Delete in viewer mode and tests non-llama connections', async () => {
    const profile = await seedProfile()
    writeActiveProfileId(profile.id)
    vi.spyOn(globalThis, 'fetch').mockImplementation((input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.endsWith('/models')) {
        return Promise.resolve(jsonResponse({ data: [{ id: 'openai/gpt-4o-mini' }] }))
      }
      if (url.endsWith('/endpoints')) {
        return Promise.resolve(openRouterProbeEndpoints('openai/gpt-4o-mini'))
      }
      return Promise.resolve(
        jsonResponse({
          id: 'gen-test',
          model: 'openai/gpt-4o-mini',
          choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
        }),
      )
    })
    render(<ConnectionHeader variant="title-icon" />)
    await openConnectionPopover('OpenRouter')
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy()
    expect(
      screen
        .getByRole('button', { name: 'Edit' })
        .closest('[data-ui="connection-actions-leading"]'),
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Test' })).toBeTruthy()
    expect(
      screen
        .getByRole('button', { name: 'Delete connection' })
        .closest('[data-ui="connection-actions-trailing"]'),
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Test' }))
    await waitFor(() => {
      expect(screen.getByText(/Completed test chat/i)).toBeTruthy()
    })
  })

  it('falls back to a bundled Anthropic probe model when /models is unavailable', async () => {
    const profile = await seedProfile({
      name: 'Anthropic',
      kind: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      key: 'sk-ant-test',
    })
    writeActiveProfileId(profile.id)
    vi.spyOn(globalThis, 'fetch').mockImplementation((input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.endsWith('/models')) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: { message: 'Invalid bearer token' } }), {
            status: 401,
            headers: { 'content-type': 'application/json' },
          }),
        )
      }
      return Promise.resolve(
        jsonResponse({
          id: 'gen-test',
          model: 'claude-haiku-4-5-20251001',
          choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
        }),
      )
    })
    render(<ConnectionHeader variant="title-icon" />)
    await openConnectionPopover('Anthropic')
    fireEvent.click(await screen.findByRole('button', { name: 'Test' }))
    await waitFor(() => {
      expect(screen.getByText(/Completed test chat/i)).toBeTruthy()
    })
  })

  it('clears the completed connection test result when switching profiles', async () => {
    const a = await seedProfile({ name: 'OpenRouter A' })
    const b = await seedProfile({ name: 'OpenRouter B' })
    writeActiveProfileId(a.id)
    vi.spyOn(globalThis, 'fetch').mockImplementation((input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.endsWith('/models')) {
        return Promise.resolve(jsonResponse({ data: [{ id: 'openai/gpt-4o-mini' }] }))
      }
      if (url.endsWith('/endpoints')) {
        return Promise.resolve(openRouterProbeEndpoints('openai/gpt-4o-mini'))
      }
      return Promise.resolve(
        jsonResponse({
          id: 'gen-test',
          model: 'openai/gpt-4o-mini',
          choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
        }),
      )
    })
    render(<ConnectionHeader variant="title-icon" />)
    await openConnectionPopover('OpenRouter A')
    fireEvent.click(await screen.findByRole('button', { name: 'Test' }))
    await waitFor(() => {
      expect(screen.getByText(/Completed test chat/i)).toBeTruthy()
    })

    fireEvent.change(screen.getByLabelText('Profile'), { target: { value: b.id } })

    await screen.findByRole('button', { name: connectionButtonMatcher('OpenRouter B') })
    expect(screen.queryByText(/Completed test chat/i)).toBeNull()
  })

  it('opens a confirmation dialog before deleting a connection', async () => {
    const profile = await seedProfile()
    writeActiveProfileId(profile.id)
    render(<ConnectionHeader variant="title-icon" />)
    await openConnectionPopover('OpenRouter')
    fireEvent.click(await screen.findByRole('button', { name: 'Delete connection' }))
    expect(screen.getByRole('dialog', { name: 'Delete connection?' })).toBeTruthy()
    const confirm = screen.getByRole('button', { name: 'Delete' })
    await waitFor(() => expect(confirm).toBeEnabled())
    fireEvent.click(confirm)
    await waitFor(async () => {
      expect(await listConfigurationProfiles()).toHaveLength(0)
    })
  })

  it('blocks deletion while a non-archived preset still uses the connection', async () => {
    const profile = await seedProfile()
    await createConfigurationChatPreset({
      name: 'Private reasoning',
      connectionProfileId: profile.id,
      settings: cloneDefaultChatSettings(),
    })
    writeActiveProfileId(profile.id)
    render(<ConnectionHeader variant="title-icon" />)
    await openConnectionPopover('OpenRouter')
    fireEvent.click(await screen.findByRole('button', { name: 'Delete connection' }))

    expect(await screen.findByText(/1 preset and 0 chats/u)).toBeVisible()
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled()
    expect(await getConfigurationProfile(profile.id)).toBeDefined()
  })

  it('saves in place when the name stays the same and keeps the original key when left blank', async () => {
    const profile = await seedProfile()
    writeActiveProfileId(profile.id)
    render(<ConnectionHeader variant="title-icon" />)
    await openConnectionPopover('OpenRouter')
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByLabelText('Provider'), {
      target: { value: 'openai-compatible' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy()
    })
    const updated = await getConfigurationProfile(profile.id)
    expect(updated?.kind).toBe('openai-compatible')
    expect(updated?.apiKeyRef).toBe(profile.apiKeyRef)
  })

  it('saves as new automatically when the name changes and blank key means no key', async () => {
    mockOnboardingModels('anthropic/claude-opus-4.8')
    const profile = await seedProfile()
    writeActiveProfileId(profile.id)
    render(<ConnectionHeader variant="title-icon" />)
    await openConnectionPopover('OpenRouter')
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'OpenRouter copy' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByRole('button', { name: connectionButtonMatcher('OpenRouter copy') })
    const profiles = await listConfigurationProfiles()
    const copy = profiles.find((row) => row.name === 'OpenRouter copy')
    expect(profiles).toHaveLength(2)
    expect(copy).toBeTruthy()
    if (!copy) {
      throw new Error('expected copied profile to exist')
    }
    expect(copy.apiKeyRef).toBeUndefined()
    const copyPreset = (await listConfigurationChatPresets()).find(
      (preset) => preset.connectionProfileId === copy.id,
    )
    expect(copyPreset?.settings.model).toBe('anthropic/claude-opus-4.8')
  })

  it('shows the active chat profile and remembers it as this tab new-chat seed', async () => {
    const a = await seedProfile({ name: 'OpenRouter A' })
    const b = await seedProfile({ name: 'OpenRouter B' })
    writeActiveProfileId(b.id)
    const settings = cloneDefaultChatSettings()
    settings.profileId = a.id
    const chat = await createChat({ settings })
    observeActiveChat(chat)
    const { rerender } = render(
      <ConnectionHeader variant="title-icon" activeChatId={chat.id} activeChatProfileId={a.id} />,
    )
    await screen.findByRole('button', { name: connectionButtonMatcher('OpenRouter A') })
    expect(readActiveProfileId()).toBe(a.id)
    observeActiveChat(null)
    rerender(<ConnectionHeader variant="title-icon" activeChatProfileId={null} />)
    await screen.findByRole('button', { name: connectionButtonMatcher('OpenRouter A') })
  })

  it('does not keep a cached profile visible after a later live deletion', async () => {
    const profile = await seedProfile()
    writeActiveProfileId(profile.id)
    render(<ConnectionHeader variant="title-icon" />)
    await screen.findByRole('button', { name: connectionButtonMatcher('OpenRouter') })

    await configurationApplication.execute({
      kind: 'connection.delete',
      profileId: profile.id,
      force: true,
      now: Date.now(),
    })

    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: connectionButtonMatcher('OpenRouter') }),
      ).toBeNull()
    })
  })

  it('moves an archived active connection to the remaining available connection', async () => {
    const source = await seedProfile({ name: 'Source' })
    const replacement = await seedProfile({ name: 'Replacement' })
    writeActiveProfileId(source.id)
    render(<ConnectionHeader variant="title-icon" />)
    await screen.findByRole('button', { name: connectionButtonMatcher('Source') })

    await configurationApplication.archiveConnection(source.id)

    await screen.findByRole('button', { name: connectionButtonMatcher('Replacement') })
    expect(readActiveProfileId()).toBe(replacement.id)
  })

  it('keeps a locally committed saved profile through rerenders', async () => {
    mockOnboardingModels('local/default-model')
    const view = render(<ConnectionHeader />)
    fireEvent.click(await screen.findByText('Add connection'))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Local llama' } })
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'llama-server' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Add connection' })).not.toBeInTheDocument()
    })

    view.rerender(<ConnectionHeader variant="mobile-menu" />)

    expect(screen.getByRole('region', { name: 'Connection: Local llama' })).toBeTruthy()
  })

  it('keeps the previous header state visible while the next profile load is still resolving', async () => {
    const a = await seedProfile({
      name: 'llama A',
      kind: 'llama-server',
      baseUrl: 'http://127.0.0.1:8080/v1',
      key: null,
    })
    const b = await seedProfile({
      name: 'llama B',
      kind: 'llama-server',
      baseUrl: 'http://127.0.0.1:8081/v1',
      key: null,
    })
    writeActiveProfileId(a.id)
    let releaseB!: () => void
    const bGate = new Promise<void>((resolve) => {
      releaseB = resolve
    })
    let blockB = false
    const source: ConfigurationProjectionSource = {
      async loadShell() {
        return configurationShell(2)
      },
      async loadGlobalTokenCalibration() {
        return { version: 1, updatedAt: 0, byModel: {}, clearGeneration: 0 }
      },
      async loadTextTemplateCatalog() {
        return []
      },
      async loadActiveSelection(target) {
        if (blockB && target.profileId === b.id) await bGate
        return configurationSelection(target.profileId === b.id ? b : a)
      },
      async loadActiveModel(target) {
        return {
          kind: 'ready',
          projection: {
            revision: target.requestRevision,
            modelId: target.modelId,
            models: { kind: 'not-requested' },
            endpoints: { kind: 'not-requested' },
            privacy: { kind: 'not-requested' },
          },
        }
      },
    }
    await configurationController.setProjectionSource(source)

    render(<ConnectionHeader variant="title-icon" />)
    const current = await screen.findByRole('button', {
      name: connectionButtonMatcher('llama A'),
    })
    fireEvent.pointerDown(current)

    blockB = true
    act(() => writeActiveProfileId(b.id))
    expect(screen.queryByText('No connection configured')).toBeNull()
    const retained = screen.getByRole('button', { name: connectionButtonMatcher('llama A') })
    await waitFor(() => expect(retained).toBeEnabled())
    expect(retained.closest('[data-ui="connection-title-entry"]')).toHaveAttribute(
      'data-presentation',
      'retained',
    )
    fireEvent.click(retained)
    const retainedRegion = screen.getByRole('region', { name: 'Connection: llama A' })
    expect(retainedRegion).toHaveAttribute('data-presentation', 'retained')
    expect(retainedRegion).toHaveAttribute('inert')
    expect(retainedRegion.querySelector('[data-ui="connection-row"]')).toBeDisabled()

    releaseB()

    await waitFor(() => {
      expect(screen.getByRole('region', { name: 'Connection: llama B' })).not.toHaveAttribute(
        'inert',
      )
    })
  })
})

function configurationShell(totalProfileCount: number): ConfigurationShellProjection {
  return {
    preferences: {
      global: structuredClone(DEFAULT_GLOBAL_PREFERENCES),
      rendering: structuredClone(DEFAULT_RENDERING_PREFS),
      sidebarSortMode: 'updatedAt-desc',
      collapsedFolderIds: [],
      imageAllowlist: [],
      samplePromptsDismissed: false,
    },
    totalProfileCount,
  }
}

function configurationSelection(
  profile: ConnectionProfile,
): ConfigurationActiveSelectionProjection {
  return {
    profile,
    preset: null,
    requestRevision: {
      profileId: profile.id,
      requestRevision: profile.requestRevision ?? 0,
      key: { kind: 'missing' },
    },
    dispatchKeyRevisions: [],
    promptPresets: [],
    textTemplate: null,
  }
}
