import { act, fireEvent, render, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { modelCatalogQueryForConnectionKind, modelsCacheKey } from '../../src/core/cache-keys'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import {
  CORS_PROXY_SECRET_KEY,
  CORS_PROXY_URL_KEY,
  DEFAULT_GLOBAL_PREFERENCES,
} from '../../src/core/global-settings'
import { DEFAULT_RENDERING_PREFS } from '../../src/core/rendering-preferences'
import type { Chat, DataPolicy, ModelEndpoint } from '../../src/core/types'
import { projectModelCatalog } from '../../src/hooks/model-catalog-projection'
import { type UsePrivacyRoutingResult, useModelCatalog } from '../../src/hooks/useModelCatalog'
import {
  type ActiveConfigurationSelectionTarget,
  type ConfigurationProjectionSource,
  configurationController,
} from '../../src/store/configuration-controller'
import { buildConnectionProfile } from '../../src/store/configuration-domain-contract'
import type { ConversationSnapshot } from '../../src/store/conversation-controller'
import type { CachedModelsRow, CachedPrivacyPolicyRow } from '../../src/store/db-rows'
import { prepareLocalWorkspaceChange } from '../../src/store/workspace-effect-hub'
import type {
  ConfigurationActiveModelRead,
  ConfigurationActiveSelectionProjection,
  ConfigurationDiscoveryPayloadProjection,
  ConfigurationModelRoutingProjection,
  ConfigurationPreferencesProjection,
  ConfigurationShellProjection,
  WorkspaceDependency,
} from '../../src/store/workspace-protocol'
import {
  connectionDiscoveryRevisionKey,
  normalizeWorkspaceDependencies,
} from '../../src/store/workspace-protocol'
import { HeaderPrivacyBadge } from '../../src/ui/chat/HeaderPrivacyBadge'
import { ProviderPicker } from '../../src/ui/settings/ProviderPicker'

const discoveryMocks = vi.hoisted(() => ({
  refreshModels: vi.fn(),
  refreshEndpoints: vi.fn(),
  refreshPrivacy: vi.fn(),
  clearModels: vi.fn(),
}))

vi.mock('../../src/store/discovery-service', () => ({
  configurationDiscoveryApplication: {
    policy: {
      modelsTtlMs: 60 * 60 * 1_000,
      endpointsTtlMs: 5 * 60 * 1_000,
      privacyTtlMs: 24 * 60 * 60 * 1_000,
      emptyPrivacyRetryMs: 5 * 60 * 1_000,
    },
    refreshModels: discoveryMocks.refreshModels,
    refreshEndpoints: discoveryMocks.refreshEndpoints,
    refreshPrivacy: discoveryMocks.refreshPrivacy,
    clearModels: discoveryMocks.clearModels,
    isFresh: (fetchedAt: number, ttlMs: number, now = Date.now()) => now - fetchedAt < ttlMs,
  },
}))

const EMPTY_PRIVACY_POLICY_RETRY_MS = 5 * 60 * 1_000
const PRIVACY_POLICY_TTL_MS = 24 * 60 * 60 * 1_000
const FENCE = { workspaceId: 'privacy-policy-tests', replacementEpoch: 1 }
const POLICY: DataPolicy = {
  training: false,
  trainingOpenRouter: false,
  retainsPrompts: false,
  canPublish: false,
  termsOfServiceURL: '',
  privacyPolicyURL: '',
}

interface CatalogHarness {
  profile: ReturnType<typeof buildConnectionProfile>
  modelId: string
  target: ActiveConfigurationSelectionTarget
  publishPrivacy(row: CachedPrivacyPolicyRow): void
  replaceProxy(proxy: { readonly url: string; readonly secret: string }): void
}

beforeEach(async () => {
  for (const mock of Object.values(discoveryMocks)) mock.mockReset().mockResolvedValue(undefined)
  await configurationController.setProjectionSource(null)
  configurationController.reconcileWorkspace({
    workspaceId: FENCE.workspaceId,
    replacementEpoch: FENCE.replacementEpoch + Math.floor(Math.random() * 1_000_000),
  })
})

afterEach(async () => {
  await configurationController.setProjectionSource(null)
})

describe('privacy discovery through the canonical configuration projection', () => {
  it('keeps catalog capability visible while missing privacy leaves requests ineligible', () => {
    const modelId = 'anthropic/claude-opus-4.8'
    const profile = buildConnectionProfile({
      id: 'profile-catalog-capability',
      name: 'OpenRouter',
      kind: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKeyRef: 'key-openrouter',
      now: 1,
    })
    const settings = cloneDefaultChatSettings()
    settings.profileId = profile.id
    settings.model = modelId
    const projection = projectModelCatalog({
      settings,
      profile,
      payloads: {
        modelsPresent: true,
        models: { data: [{ id: modelId }] },
        endpoints: {
          data: {
            id: modelId,
            endpoints: [
              {
                provider_name: 'No policy fixture',
                supported_parameters: ['temperature'],
                context_length: 128_000,
                pricing: {},
              },
            ],
          },
        },
        privacyPolicies: {},
      },
      privacyLoading: false,
      privacyFailed: false,
    })

    expect(projection.effectiveRouting?.endpointAvailability).toBe('filtered-empty')
    expect(projection.effectiveRouting?.capability).toBeNull()
    expect(projection.capability?.contextLength).toBe(128_000)
  })

  it('keeps an open privacy disclosure mounted across retained routing', () => {
    const chat = makeChat()
    const routing = retainedRoutingFixture(false)
    const view = render(<HeaderPrivacyBadge chat={chat} routing={routing} />)
    fireEvent.click(view.getByRole('button', { name: 'Privacy: Privacy data unavailable' }))
    const popover = view.getByRole('dialog', { name: 'Privacy summary' })

    view.rerender(<HeaderPrivacyBadge chat={chat} routing={retainedRoutingFixture(true)} />)

    expect(view.getByRole('dialog', { name: 'Privacy summary' })).toBe(popover)
    expect(popover).toHaveAttribute('data-routing-presentation', 'retained')
    expect(popover).toHaveAttribute('aria-busy', 'true')
  })

  it('keeps retained provider rows mounted and inert instead of flashing Loading', () => {
    const chat = makeChat()
    const endpoint: ModelEndpoint = {
      provider_name: 'Old Provider',
      supported_parameters: ['temperature'],
      context_length: 128_000,
      pricing: {},
    }
    const routing: UsePrivacyRoutingResult = {
      filter: null,
      wire: null,
      effectiveRouting: null,
      endpoints: [],
      descriptor: null,
      capability: null,
      modelAvailable: null,
      loading: true,
      offline: false,
      error: null,
      scrapeApplicable: true,
      liveScrapeEnabled: true,
      isFreeModel: false,
      capabilityPresentation: {
        profileId: chat.settings.profileId,
        profile: null,
        modelId: 'old/model',
        settings: chat.settings,
        endpoints: [endpoint],
        descriptor: null,
        capability: null,
        effectiveRouting: null,
        modelAvailable: true,
        retained: true,
      },
      privacyPresentation: {
        profileId: chat.settings.profileId,
        profile: null,
        modelId: 'old/model',
        settings: chat.settings,
        filter: null,
        endpoints: [endpoint],
        scrapeApplicable: true,
        isFreeModel: false,
        retained: true,
      },
      refresh: vi.fn(),
    }

    const view = render(<ProviderPicker chat={chat} routing={routing} neededTokens={null} />)
    const section = view.getByText('Old Provider').closest('[data-ui-section="provider-picker"]')
    expect(section).toHaveAttribute('data-routing-presentation', 'retained')
    expect(section).toHaveAttribute('inert')
    expect(view.queryByText('Loading…')).toBeNull()
  })

  it('retains one inert provider presentation while a new model target loads', async () => {
    const oldModelId = 'openai/gpt-5.4'
    const newModelId = 'anthropic/claude-opus-4.7'
    const profile = buildConnectionProfile({
      id: 'profile-retained-routing',
      name: 'OpenRouter',
      kind: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKeyRef: 'key-openrouter',
      now: 1,
    })
    const revision = {
      profileId: profile.id,
      requestRevision: profile.requestRevision ?? 0,
      key: { kind: 'missing' } as const,
    }
    const profileRevision = connectionDiscoveryRevisionKey(revision)
    const now = Date.now()
    const models: CachedModelsRow = {
      profileId: profile.id,
      profileRevision,
      queryKey: modelsCacheKey(modelCatalogQueryForConnectionKind(profile.kind)),
      fetchedAt: now,
      payload: { data: [{ id: oldModelId }, { id: newModelId }] },
    }
    const oldRouting = routingProjection(profile, oldModelId, 'Old Provider', now)
    const newRouting = routingProjection(profile, newModelId, 'New Provider', now + 1)
    const newModelPending = deferred<ConfigurationActiveModelRead>()
    const settings = cloneDefaultChatSettings()
    settings.profileId = profile.id
    settings.model = oldModelId
    configurationController.rememberSeed({ profileId: profile.id, presetId: null, settings })
    const source: ConfigurationProjectionSource = {
      async loadShell() {
        return shellFixture()
      },
      async loadGlobalTokenCalibration() {
        return { version: 1, updatedAt: 0, byModel: {}, clearGeneration: 0 }
      },
      async loadTextTemplateCatalog() {
        return []
      },
      async loadActiveSelection() {
        return selectionFixture(profile)
      },
      loadActiveModel(target, _knownPayloads, includeModels) {
        return target.modelId === newModelId
          ? newModelPending.promise
          : Promise.resolve(activeModelRead(target, includeModels, models, oldRouting))
      },
    }
    await configurationController.setProjectionSource(source)
    await waitFor(() => {
      expect(configurationController.getSnapshot().frame.model.status).toBe('ready')
    })
    const chat = makeChat()
    chat.settings = structuredClone(settings)
    const activeFence = configurationController.getSnapshot().workspaceFence
    if (!activeFence) throw new Error('ConfigurationFenceMissing')
    configurationController.observeConversation({
      workspaceId: activeFence.workspaceId,
      workspaceEpoch: activeFence.replacementEpoch,
      activeChatId: chat.id,
      active: { chatId: chat.id, chat } as NonNullable<ConversationSnapshot['active']>,
    })
    await waitFor(() => {
      expect(configurationController.getSnapshot().frame.model.status).toBe('ready')
    })
    const { result, rerender } = renderHook(
      ({ target }) => useModelCatalog(target, profile, { modelsDemanded: true }),
      { initialProps: { target: activeConfigurationTarget() } },
    )
    await waitFor(() => expect(result.current.models.models).toHaveLength(2))
    expect(result.current.routing.capabilityPresentation).toMatchObject({
      modelId: oldModelId,
      retained: false,
      endpoints: [{ provider_name: 'Old Provider' }],
    })

    const synchronousPublications: ReturnType<typeof configurationController.getSnapshot>[] = []
    act(() => {
      const unsubscribe = configurationController.subscribe(() => {
        synchronousPublications.push(configurationController.getSnapshot())
      })
      configurationController.stageChatSettingsFields(chat.id, [
        { path: ['model'], value: newModelId },
      ])
      unsubscribe()
      rerender({ target: activeConfigurationTarget() })
    })
    expect(synchronousPublications).toHaveLength(1)
    expect(configurationController.projectChatConfiguration(chat).settings.model).toBe(newModelId)
    expect(synchronousPublications[0]).toMatchObject({
      frame: {
        model: {
          status: 'pending',
          target: { profileId: profile.id, modelId: newModelId },
          retained: {
            kind: 'previous-target',
            target: { profileId: profile.id, modelId: oldModelId },
          },
        },
      },
    })
    await waitFor(() => expect(result.current.routing.loading).toBe(true))
    expect(result.current.routing.endpoints).toEqual([])
    expect(result.current.routing.capability).toBeNull()
    expect(result.current.routing.capabilityPresentation).toMatchObject({
      modelId: oldModelId,
      retained: true,
      endpoints: [{ provider_name: 'Old Provider' }],
    })

    act(() => {
      const frameModel = configurationController.getSnapshot().frame.model
      if (frameModel.status !== 'pending') throw new Error('ConfigurationModelReadNotPending')
      newModelPending.resolve(activeModelRead(frameModel.target, true, models, newRouting))
    })
    await waitFor(() => expect(result.current.routing.loading).toBe(false))
    expect(result.current.routing.capabilityPresentation).toMatchObject({
      modelId: newModelId,
      retained: false,
      endpoints: [{ provider_name: 'New Provider' }],
    })
  })

  it('lets routing retain its prior exact profile while another profile stays offline', async () => {
    const oldModelId = 'openai/gpt-5.4'
    const newModelId = 'anthropic/claude-opus-4.7'
    const oldProfile = buildConnectionProfile({
      id: 'profile-routing-old',
      name: 'Old OpenRouter',
      kind: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKeyRef: 'key-old',
      now: 1,
    })
    const newProfile = buildConnectionProfile({
      id: 'profile-routing-new',
      name: 'New OpenRouter',
      kind: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKeyRef: 'key-new',
      now: 2,
    })
    const now = Date.now()
    const modelsFor = (
      profile: ReturnType<typeof buildConnectionProfile>,
      modelId: string,
    ): CachedModelsRow => {
      const revision = {
        profileId: profile.id,
        requestRevision: profile.requestRevision ?? 0,
        key: { kind: 'missing' } as const,
      }
      return {
        profileId: profile.id,
        profileRevision: connectionDiscoveryRevisionKey(revision),
        queryKey: modelsCacheKey(modelCatalogQueryForConnectionKind(profile.kind)),
        fetchedAt: now,
        payload: { data: [{ id: modelId }] },
      }
    }
    const oldModels = modelsFor(oldProfile, oldModelId)
    const newModels = modelsFor(newProfile, newModelId)
    const oldRouting = routingProjection(oldProfile, oldModelId, 'Old Provider', now)
    const newRouting = routingProjection(newProfile, newModelId, 'New Provider', now + 1)
    const { privacy: _missingPrivacy, ...newRoutingWithoutPrivacy } = newRouting
    const newModelPending = deferred<ConfigurationActiveModelRead>()
    discoveryMocks.refreshPrivacy.mockRejectedValue(new Error('offline'))
    const settings = cloneDefaultChatSettings()
    settings.profileId = oldProfile.id
    settings.model = oldModelId
    configurationController.rememberSeed({
      profileId: oldProfile.id,
      presetId: null,
      settings,
    })
    const source: ConfigurationProjectionSource = {
      async loadShell() {
        return { ...shellFixture(), totalProfileCount: 2 }
      },
      async loadGlobalTokenCalibration() {
        return { version: 1, updatedAt: 0, byModel: {}, clearGeneration: 0 }
      },
      async loadTextTemplateCatalog() {
        return []
      },
      async loadActiveSelection(target) {
        return selectionFixture(target.profileId === newProfile.id ? newProfile : oldProfile)
      },
      loadActiveModel(target, _knownPayloads, includeModels) {
        return target.profileId === newProfile.id
          ? newModelPending.promise
          : Promise.resolve(activeModelRead(target, includeModels, oldModels, oldRouting))
      },
    }
    await configurationController.setProjectionSource(source)
    const chat = makeChat()
    chat.id = 'chat-routing-profile-handoff'
    chat.settings = structuredClone(settings)
    const activeFence = configurationController.getSnapshot().workspaceFence
    if (!activeFence) throw new Error('ConfigurationFenceMissing')
    configurationController.observeConversation({
      workspaceId: activeFence.workspaceId,
      workspaceEpoch: activeFence.replacementEpoch,
      activeChatId: chat.id,
      active: { chatId: chat.id, chat } as NonNullable<ConversationSnapshot['active']>,
    })
    await waitFor(() => {
      expect(configurationController.getSnapshot().frame.model.status).toBe('ready')
    })
    const { result, rerender } = renderHook(
      ({ target, profile }) => useModelCatalog(target, profile, { modelsDemanded: true }),
      {
        initialProps: {
          target: activeConfigurationTarget(),
          profile: oldProfile,
        },
      },
    )
    await waitFor(() => {
      expect(result.current.routing.capabilityPresentation).toMatchObject({
        profileId: oldProfile.id,
        modelId: oldModelId,
        retained: false,
      })
    })
    expect(result.current.routing.privacyPresentation).toMatchObject({
      profileId: oldProfile.id,
      modelId: oldModelId,
      retained: false,
    })

    act(() => {
      configurationController.stageChatSettingsFields(chat.id, [
        { path: ['profileId'], value: newProfile.id },
        { path: ['model'], value: newModelId },
      ])
      rerender({
        target: activeConfigurationTarget(),
        profile: newProfile,
      })
    })
    await waitFor(() => {
      expect(configurationController.getSnapshot().frame.model).toMatchObject({
        status: 'pending',
        target: { profileId: newProfile.id, modelId: newModelId },
      })
    })
    expect(result.current.routing.capabilityPresentation).toMatchObject({
      profileId: oldProfile.id,
      modelId: oldModelId,
      settings: {
        profileId: oldProfile.id,
        model: oldModelId,
      },
      retained: true,
      endpoints: [{ provider_name: 'Old Provider' }],
    })

    act(() => {
      const frameModel = configurationController.getSnapshot().frame.model
      if (frameModel.status !== 'pending') throw new Error('ConfigurationModelReadNotPending')
      newModelPending.resolve(
        activeModelRead(frameModel.target, true, newModels, newRoutingWithoutPrivacy),
      )
    })
    await waitFor(() => {
      expect(result.current.routing.capabilityPresentation).toMatchObject({
        profileId: newProfile.id,
        modelId: newModelId,
        retained: false,
        endpoints: [{ provider_name: 'New Provider' }],
      })
    })
    await waitFor(() => expect(result.current.routing.offline).toBe(true))
    expect(result.current.routing.privacyPresentation).toMatchObject({
      profileId: oldProfile.id,
      modelId: oldModelId,
      retained: true,
      endpoints: [{ provider_name: 'Old Provider' }],
    })
  })

  it('negative-caches a fresh empty result while preserving explicit refresh', async () => {
    const fetchedAt = Date.now()
    const harness = await installCatalog({
      modelId: 'deepseek/deepseek-v4-flash',
      privacyFetchedAt: fetchedAt,
      policies: {},
    })
    discoveryMocks.refreshPrivacy.mockImplementation(async () => {
      harness.publishPrivacy(privacyRow(harness, Date.now(), { 'deepinfra/fp4': POLICY }))
    })

    const { result } = renderHook(() =>
      useModelCatalog(harness.target, harness.profile, { modelsDemanded: true }),
    )

    await waitFor(() => expect(result.current.models.fetchedAt).not.toBeNull())
    expect(discoveryMocks.refreshPrivacy).not.toHaveBeenCalled()

    act(() => result.current.routing.refresh())

    await waitFor(() => expect(discoveryMocks.refreshPrivacy).toHaveBeenCalledTimes(1))
    await waitFor(() => {
      expect(result.current.routing.filter?.kept[0]?.policy?.retainsPrompts).toBe(false)
    })
  })

  it('automatically refreshes an empty row after the short negative-cache TTL', async () => {
    const refreshGate = deferred<void>()
    const harnessHolder: { current: CatalogHarness | null } = { current: null }
    discoveryMocks.refreshPrivacy.mockImplementation(async () => {
      await refreshGate.promise
      const harness = harnessHolder.current
      if (!harness) throw new Error('CatalogHarnessMissing')
      harness.publishPrivacy(privacyRow(harness, Date.now(), { 'deepinfra/fp4': POLICY }))
    })
    const harness = await installCatalog({
      modelId: 'deepseek/deepseek-v4-flash',
      privacyFetchedAt: Date.now() - EMPTY_PRIVACY_POLICY_RETRY_MS - 1,
      policies: {},
    })
    harnessHolder.current = harness
    refreshGate.resolve()

    const { result } = renderHook(() =>
      useModelCatalog(harness.target, harness.profile, { modelsDemanded: true }),
    )

    await waitFor(() => expect(discoveryMocks.refreshPrivacy).toHaveBeenCalledTimes(1))
    await waitFor(() => {
      expect(result.current.routing.filter?.kept[0]?.policy?.retainsPrompts).toBe(false)
    })
    expect(result.current.routing.loading).toBe(false)
  })

  it('refreshes a mounted full policy row after the 24-hour TTL', async () => {
    const refreshGate = deferred<void>()
    const harnessHolder: { current: CatalogHarness | null } = { current: null }
    discoveryMocks.refreshPrivacy.mockImplementation(async () => {
      await refreshGate.promise
      const harness = harnessHolder.current
      if (!harness) throw new Error('CatalogHarnessMissing')
      harness.publishPrivacy(
        privacyRow(harness, Date.now(), {
          OpenAI: { ...POLICY, retainsPrompts: true, retentionDays: 30 },
        }),
      )
    })
    const harness = await installCatalog({
      modelId: 'openai/gpt-5.4',
      privacyFetchedAt: Date.now() - PRIVACY_POLICY_TTL_MS - 1,
      policies: { Azure: POLICY },
      providerName: 'OpenAI',
    })
    harnessHolder.current = harness
    refreshGate.resolve()

    const { result } = renderHook(() =>
      useModelCatalog(harness.target, harness.profile, { modelsDemanded: true }),
    )

    await waitFor(() => expect(discoveryMocks.refreshPrivacy).toHaveBeenCalledTimes(1))
    await waitFor(() => {
      expect(result.current.routing.filter?.kept[0]?.policy?.retainsPrompts).toBe(true)
    })
  })

  it('aborts an obsolete privacy transport and restarts against the exact replacement proxy', async () => {
    const attempts = [deferred<void>(), deferred<void>()]
    const signals: AbortSignal[] = []
    const proxies: Array<{ readonly url: string; readonly secret: string }> = []
    discoveryMocks.refreshPrivacy.mockImplementation(
      async (
        _profile: unknown,
        _modelId: unknown,
        options: {
          readonly signal: AbortSignal
          readonly proxy: { readonly url: string; readonly secret: string }
        },
      ) => {
        const attempt = attempts[signals.length]
        if (!attempt) throw new Error('UnexpectedPrivacyRefreshAttempt')
        signals.push(options.signal)
        proxies.push(options.proxy)
        await attempt.promise
      },
    )
    const harness = await installCatalog({
      modelId: 'openai/gpt-5.4',
      privacyFetchedAt: Date.now() - PRIVACY_POLICY_TTL_MS - 1,
      policies: { OpenAI: POLICY },
      providerName: 'OpenAI',
    })

    renderHook(() => useModelCatalog(harness.target, harness.profile, { modelsDemanded: true }))
    await waitFor(() => expect(discoveryMocks.refreshPrivacy).toHaveBeenCalledTimes(1))

    act(() => harness.replaceProxy({ url: 'https://proxy.invalid/scrape', secret: 'next' }))
    await waitFor(() => expect(discoveryMocks.refreshPrivacy).toHaveBeenCalledTimes(2))
    expect(signals[0]?.aborted).toBe(true)
    expect(signals[1]?.aborted).toBe(false)
    expect(proxies).toEqual([
      { url: '/_or_scrape', secret: '' },
      { url: 'https://proxy.invalid/scrape', secret: 'next' },
    ])

    act(() => {
      attempts[0]?.resolve()
      attempts[1]?.resolve()
    })
  })
})

function retainedRoutingFixture(retained: boolean): UsePrivacyRoutingResult {
  return {
    filter: null,
    wire: null,
    effectiveRouting: null,
    endpoints: [],
    descriptor: null,
    capability: null,
    modelAvailable: null,
    loading: true,
    offline: false,
    error: null,
    scrapeApplicable: true,
    liveScrapeEnabled: true,
    isFreeModel: false,
    capabilityPresentation: {
      profileId: null,
      profile: null,
      modelId: 'openai/gpt-5.6-sol',
      settings: cloneDefaultChatSettings(),
      endpoints: [],
      descriptor: null,
      capability: null,
      effectiveRouting: null,
      modelAvailable: null,
      retained,
    },
    privacyPresentation: {
      profileId: null,
      profile: null,
      modelId: 'openai/gpt-5.6-sol',
      settings: cloneDefaultChatSettings(),
      filter: null,
      endpoints: [],
      scrapeApplicable: true,
      isFreeModel: false,
      retained,
    },
    refresh: vi.fn(),
  }
}

function makeChat(): Chat {
  const settings = cloneDefaultChatSettings()
  settings.profileId = 'profile-retained-routing'
  settings.model = 'new/model'
  return {
    id: 'chat-retained-routing',
    title: 'Retained routing',
    titleStatus: 'manual',
    createdAt: 1,
    updatedAt: 1,
    lastViewedAt: 1,
    wordCount: 0,
    totalCostUsd: 0,
    metaVersion: 0,
    summaryVersion: 0,
    configurationVersion: 0,
    structuralVersion: 0,
    settings,
    lastUpdatedLeafId: null,
    lastBranchUpdatedAt: 1,
    archived: false,
    pinned: false,
    folderId: null,
    tags: [],
  }
}

function routingProjection(
  profile: ReturnType<typeof buildConnectionProfile>,
  modelId: string,
  providerName: string,
  fetchedAt: number,
): ConfigurationModelRoutingProjection {
  const revision = {
    profileId: profile.id,
    requestRevision: profile.requestRevision ?? 0,
    key: { kind: 'missing' } as const,
  }
  const profileRevision = connectionDiscoveryRevisionKey(revision)
  return {
    profileId: profile.id,
    revision,
    modelId,
    endpoints: {
      profileId: profile.id,
      profileRevision,
      modelId,
      fetchedAt,
      payload: {
        data: {
          id: modelId,
          endpoints: [
            {
              provider_name: providerName,
              supported_parameters: ['temperature'],
              context_length: 128_000,
              pricing: {},
            },
          ],
        },
      },
    },
    privacy: {
      profileId: profile.id,
      profileRevision,
      modelId,
      fetchedAt,
      payload: { policies: { [providerName]: POLICY }, fetchedAt },
    },
    proxy: { url: '/_or_scrape', secret: '' },
  }
}

async function installCatalog(input: {
  modelId: string
  privacyFetchedAt: number
  policies: Record<string, DataPolicy>
  providerName?: string
}): Promise<CatalogHarness> {
  const profile = buildConnectionProfile({
    id: `profile-${input.modelId}`,
    name: 'OpenRouter',
    kind: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyRef: 'key-openrouter',
    now: 1,
  })
  const revision = {
    profileId: profile.id,
    requestRevision: profile.requestRevision ?? 0,
    key: { kind: 'missing' } as const,
  }
  const profileRevision = connectionDiscoveryRevisionKey(revision)
  const now = Date.now()
  const models: CachedModelsRow = {
    profileId: profile.id,
    profileRevision,
    queryKey: modelsCacheKey(modelCatalogQueryForConnectionKind(profile.kind)),
    fetchedAt: now,
    payload: { data: [{ id: input.modelId }] },
  }
  let routing: ConfigurationModelRoutingProjection = {
    profileId: profile.id,
    revision,
    modelId: input.modelId,
    endpoints: {
      profileId: profile.id,
      profileRevision,
      modelId: input.modelId,
      fetchedAt: now,
      payload: {
        data: {
          id: input.modelId,
          endpoints: [
            {
              provider_name: input.providerName ?? 'deepinfra/fp4',
              supported_parameters: ['temperature'],
              context_length: 128_000,
              pricing: {},
            },
          ],
        },
      },
    },
    privacy: {
      profileId: profile.id,
      profileRevision,
      modelId: input.modelId,
      fetchedAt: input.privacyFetchedAt,
      payload: { policies: input.policies, fetchedAt: input.privacyFetchedAt },
    },
    proxy: { url: '/_or_scrape', secret: '' },
  }
  let shell = shellFixture()
  const settings = cloneDefaultChatSettings()
  settings.profileId = profile.id
  settings.model = input.modelId
  configurationController.rememberSeed({ profileId: profile.id, presetId: null, settings })
  const source: ConfigurationProjectionSource = {
    async loadShell() {
      return shell
    },
    async loadGlobalTokenCalibration() {
      return { version: 1, updatedAt: 0, byModel: {}, clearGeneration: 0 }
    },
    async loadTextTemplateCatalog() {
      return []
    },
    async loadActiveSelection() {
      return selectionFixture(profile)
    },
    async loadActiveModel(target, _knownPayloads, includeModels) {
      await Promise.resolve()
      return activeModelRead(target, includeModels, models, routing)
    },
  }
  configurationController.observeDiscoverySurface({
    profileId: profile.id,
    modelId: input.modelId,
    modelsDemanded: true,
  })
  await configurationController.setProjectionSource(source)
  await waitFor(() => {
    expect(configurationController.getSnapshot().frame.selection.status).toBe('ready')
  })
  return {
    profile,
    modelId: input.modelId,
    target: activeConfigurationTarget(),
    publishPrivacy(row) {
      routing = { ...routing, privacy: row }
      invalidateConfiguration([
        { kind: 'discovery-cache', profileIds: [profile.id], cacheKinds: ['privacy'] },
      ])
    },
    replaceProxy(proxy) {
      shell = shellFixture(proxy)
      invalidateConfiguration([
        { kind: 'setting', keys: [CORS_PROXY_URL_KEY, CORS_PROXY_SECRET_KEY] },
      ])
    },
  }
}

function privacyRow(
  harness: Pick<CatalogHarness, 'profile' | 'modelId'>,
  fetchedAt: number,
  policies: Record<string, DataPolicy>,
): CachedPrivacyPolicyRow {
  const revision = {
    profileId: harness.profile.id,
    requestRevision: harness.profile.requestRevision ?? 0,
    key: { kind: 'missing' } as const,
  }
  return {
    profileId: harness.profile.id,
    profileRevision: connectionDiscoveryRevisionKey(revision),
    modelId: harness.modelId,
    fetchedAt,
    payload: { policies, fetchedAt },
  }
}

function selectionFixture(
  profile: ReturnType<typeof buildConnectionProfile>,
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

function preferencesFixture(proxy?: {
  readonly url: string
  readonly secret: string
}): ConfigurationPreferencesProjection {
  return {
    global: {
      ...structuredClone(DEFAULT_GLOBAL_PREFERENCES),
      ...(proxy ? { corsProxyUrl: proxy.url, corsProxySecret: proxy.secret } : {}),
    },
    rendering: structuredClone(DEFAULT_RENDERING_PREFS),
    sidebarSortMode: 'updatedAt-desc',
    collapsedFolderIds: [],
    imageAllowlist: [],
    samplePromptsDismissed: false,
  }
}

function shellFixture(proxy?: {
  readonly url: string
  readonly secret: string
}): ConfigurationShellProjection {
  return { preferences: preferencesFixture(proxy), totalProfileCount: 1 }
}

function activeConfigurationTarget(): ActiveConfigurationSelectionTarget {
  const target = configurationController.getSnapshot().frame.target
  if (target.kind !== 'chat' && target.kind !== 'new-chat') {
    throw new Error('ConfigurationTargetMissing')
  }
  return target
}

function activeModelRead(
  target: Parameters<ConfigurationProjectionSource['loadActiveModel']>[0],
  includeModels: boolean,
  models: CachedModelsRow | undefined,
  routing: ConfigurationModelRoutingProjection | undefined,
): ConfigurationActiveModelRead {
  const matchingRouting = routing?.modelId === target.modelId ? routing : undefined
  return {
    kind: 'ready',
    projection: {
      revision: target.requestRevision,
      modelId: target.modelId,
      models: includeModels ? payloadProjection(models, 'models') : { kind: 'not-requested' },
      endpoints: target.modelId
        ? payloadProjection(matchingRouting?.endpoints, 'endpoints')
        : { kind: 'not-requested' },
      privacy: target.modelId
        ? payloadProjection(matchingRouting?.privacy, 'privacy')
        : { kind: 'not-requested' },
    },
  }
}

function payloadProjection<
  Row extends { profileRevision: string; fetchedAt: number; payload: unknown },
>(
  row: Row | undefined,
  kind: 'models' | 'endpoints' | 'privacy',
): ConfigurationDiscoveryPayloadProjection<Row> {
  if (!row) return { kind: 'missing' }
  const serialized = JSON.stringify(row.payload)
  return {
    kind: 'loaded',
    token: {
      profileRevision: row.profileRevision,
      payloadId: `${kind}:${row.fetchedAt}:${serialized}`,
      payloadByteLength: serialized.length,
      fetchedAt: row.fetchedAt,
    },
    row,
  }
}

function invalidateConfiguration(dependencies: readonly WorkspaceDependency[]): void {
  const fence = configurationController.getSnapshot().workspaceFence
  if (!fence) throw new Error('ConfigurationFenceMissing')
  configurationController.observeWorkspaceEffect(
    prepareLocalWorkspaceChange({
      kind: 'invalidate',
      ...fence,
      dependencies: normalizeWorkspaceDependencies(dependencies),
    }).effect,
  )
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}
