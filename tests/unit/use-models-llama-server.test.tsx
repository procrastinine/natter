import { act, renderHook, waitFor } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { modelCatalogQueryForConnectionKind, modelsCacheKey } from '../../src/core/cache-keys'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import { DEFAULT_GLOBAL_PREFERENCES } from '../../src/core/global-settings'
import { DEFAULT_RENDERING_PREFS } from '../../src/core/rendering-preferences'
import type { Chat, ConnectionProfile, ModelsQuery, ProfileId } from '../../src/core/types'
import { useModelCatalog } from '../../src/hooks/useModelCatalog'
import {
  type ActiveConfigurationSelectionTarget,
  type ConfigurationProjectionSource,
  configurationController,
  currentActiveConfigurationModel,
} from '../../src/store/configuration-controller'
import {
  type ConfigurationApplicationDependencies,
  createConfigurationApplication,
} from '../../src/store/configuration-domain'
import {
  buildConnectionProfile,
  type ConfigurationDomainPort,
} from '../../src/store/configuration-domain-contract'
import type { ConversationSnapshot } from '../../src/store/conversation-controller'
import type { CachedModelsRow } from '../../src/store/db-rows'
import { prepareLocalWorkspaceChange } from '../../src/store/workspace-effect-hub'
import type {
  ConfigurationActiveModelRead,
  ConfigurationActiveSelectionProjection,
  ConfigurationDiscoveryPayloadProjection,
  ConfigurationPreferencesProjection,
  ConfigurationShellProjection,
  WorkspaceDependency,
} from '../../src/store/workspace-protocol'
import { connectionDiscoveryRevisionKey } from '../../src/store/workspace-protocol'

interface RefreshOptions {
  readonly signal: AbortSignal
  readonly force: boolean
  readonly forceBaselineFetchedAt: number | null
}

type RefreshModels = (
  profile: ConnectionProfile,
  query: ModelsQuery,
  options: RefreshOptions,
) => Promise<void>
type RefreshEndpoints = (
  profile: ConnectionProfile,
  modelId: string,
  options: RefreshOptions,
) => Promise<void>
type RefreshPrivacy = (
  profile: ConnectionProfile,
  modelId: string,
  options: RefreshOptions & { readonly proxy: { readonly url: string; readonly secret: string } },
) => Promise<void>
type ClearModels = (profileId: ProfileId, query: ModelsQuery) => Promise<void>

const discoveryMocks = vi.hoisted(() => ({
  refreshModels: vi.fn<RefreshModels>(),
  refreshEndpoints: vi.fn<RefreshEndpoints>(),
  refreshPrivacy: vi.fn<RefreshPrivacy>(),
  clearModels: vi.fn<ClearModels>(),
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

beforeEach(async () => {
  for (const mock of Object.values(discoveryMocks)) mock.mockReset().mockResolvedValue(undefined)
  await configurationController.setProjectionSource(null)
  configurationController.reconcileWorkspace({
    workspaceId: `model-catalog-tests-${Math.random()}`,
    replacementEpoch: 1,
  })
})

afterEach(async () => {
  await configurationController.setProjectionSource(null)
})

describe('model discovery through the canonical configuration projection', () => {
  it.each(['openrouter', 'openai-compatible', 'custom'] as const)(
    'uses the canonical %s catalog query without starting unsupported routing discovery',
    async (kind) => {
      const profile = profileFixture(kind, {
        supportsEndpointsApi: false,
        supportsPrivacyScrape: false,
      })
      const settings = cloneDefaultChatSettings()
      settings.profileId = profile.id
      const harness = await installModelCatalog(profile, settings, modelsRow(profile, 0, []))

      renderHook(() => useModelCatalog(harness.target, profile, { modelsDemanded: true }))

      await waitFor(() => expect(discoveryMocks.refreshModels).toHaveBeenCalledTimes(1))
      expect(discoveryMocks.refreshModels.mock.calls[0]?.[1]).toEqual(
        modelCatalogQueryForConnectionKind(kind),
      )
      expect(discoveryMocks.refreshEndpoints).not.toHaveBeenCalled()
      expect(discoveryMocks.refreshPrivacy).not.toHaveBeenCalled()
    },
  )

  it('does not let a superseded active-model read overwrite a newer projection', async () => {
    const profile = profileFixture('openrouter', {
      supportsEndpointsApi: false,
      supportsPrivacyScrape: false,
    })
    const settings = cloneDefaultChatSettings()
    settings.profileId = profile.id
    const staleRow = modelsRow(profile, 1, ['stale/model'])
    const liveRow = modelsRow(profile, 2, ['live/model'])
    const harness = await installModelCatalog(profile, settings, staleRow)
    const view = renderHook(() =>
      useModelCatalog(harness.target, profile, { modelsDemanded: true }),
    )
    await waitFor(() =>
      expect(view.result.current.models.models.map((model) => model.id)).toEqual(['stale/model']),
    )

    const staleRead = deferred<ConfigurationActiveModelRead>()
    let activeModelReads = 0
    const source: ConfigurationProjectionSource = {
      ...harness.source,
      loadActiveModel(target, _knownPayloads, includeModels) {
        activeModelReads += 1
        return activeModelReads === 1
          ? staleRead.promise
          : Promise.resolve(activeModelRead(target, includeModels, liveRow))
      },
    }
    await configurationController.setProjectionSource(null)
    await configurationController.setProjectionSource(source)
    await waitFor(() => expect(activeModelReads).toBe(1))

    act(() => invalidateDiscovery(profile.id, ['models']))
    await waitFor(() =>
      expect(view.result.current.models.models.map((model) => model.id)).toEqual(['live/model']),
    )
    const modelTarget = currentActiveConfigurationModel(
      configurationController.getSnapshot().frame,
    )?.target
    if (!modelTarget) throw new Error('ConfigurationModelTargetMissing')
    staleRead.resolve(activeModelRead(modelTarget, true, staleRow))
    await Promise.resolve()
    await Promise.resolve()

    expect(view.result.current.models.models.map((model) => model.id)).toEqual(['live/model'])
  })

  it('drops stale llama-server models from the canonical projection when refresh fails', async () => {
    const profile = profileFixture('llama-server')
    const settings = cloneDefaultChatSettings()
    settings.profileId = profile.id
    const harness = await installModelCatalog(
      profile,
      settings,
      modelsRow(profile, 0, ['local/gemma-3-12b']),
    )
    discoveryMocks.refreshModels.mockReset().mockRejectedValue(new Error('ECONNREFUSED'))
    discoveryMocks.clearModels.mockImplementation(async () => {
      harness.publishModels(undefined)
    })

    const { result } = renderHook(() =>
      useModelCatalog(harness.target, profile, { modelsDemanded: true }),
    )
    act(() => result.current.models.refresh())

    await waitFor(() => expect(discoveryMocks.refreshModels).toHaveBeenCalled())
    await waitFor(() => expect(discoveryMocks.clearModels).toHaveBeenCalled())
    await waitFor(() => expect(result.current.models.models).toEqual([]))
    expect(
      currentActiveConfigurationModel(configurationController.getSnapshot().frame)?.value.models,
    ).toBeUndefined()
  })

  it('never exposes the old model or an empty catalog while a same-profile selection commits', async () => {
    const profile = profileFixture('openrouter', {
      supportsEndpointsApi: false,
      supportsPrivacyScrape: false,
    })
    const oldModel = 'openai/gpt-5.4'
    const newModel = 'anthropic/claude-opus-4.7'
    const settings = cloneDefaultChatSettings()
    settings.profileId = profile.id
    settings.model = oldModel
    await installModelCatalog(
      profile,
      settings,
      modelsRow(profile, Date.now(), [oldModel, newModel]),
    )
    let canonicalChat = chatFixture(profile, oldModel)
    publishConversation(canonicalChat)
    const entered = deferred<void>()
    const release = deferred<void>()
    const port: ConfigurationDomainPort = {
      async execute(command) {
        if (command.kind !== 'chat.settings-fields-patch') throw new Error('UnexpectedCommand')
        entered.resolve()
        await release.promise
        canonicalChat = {
          ...canonicalChat,
          settings: { ...canonicalChat.settings, model: newModel },
          configurationVersion: (canonicalChat.configurationVersion ?? 0) + 1,
        }
        publishConversation(canonicalChat)
        return {
          kind: 'chat-updated',
          chatId: canonicalChat.id,
          chat: canonicalChat,
          changed: true,
          configurationVersion: canonicalChat.configurationVersion ?? 0,
        } as never
      },
    }
    const application = createConfigurationApplication(applicationDependencies(port))
    const configurationSequence: string[] = []
    let recordConfiguration = false
    const unsubscribe = configurationController.subscribe(() => {
      if (!recordConfiguration) return
      configurationSequence.push(
        configurationController.projectChatConfiguration(canonicalChat).settings.model,
      )
    })
    const renderSequence: Array<{ modelId: string | null; modelCount: number; loading: boolean }> =
      []
    let recordRenders = false
    const { result } = renderHook(() => {
      const snapshot = useSyncExternalStore(
        configurationController.subscribe,
        configurationController.getSnapshot,
        configurationController.getSnapshot,
      )
      void snapshot.revision
      const catalog = useModelCatalog(activeConfigurationTarget(), profile, {
        modelsDemanded: true,
      })
      if (recordRenders) {
        renderSequence.push({
          modelId: catalog.modelId,
          modelCount: catalog.models.models.length,
          loading: catalog.models.loading,
        })
      }
      return catalog
    })

    await waitFor(() => expect(result.current.models.models).toHaveLength(2))
    recordConfiguration = true
    recordRenders = true
    let update: Promise<boolean>
    await act(async () => {
      update = application.patchChatSettingsFields(canonicalChat.id, [
        { path: ['model'], value: newModel },
      ])
      await entered.promise
    })

    expect(result.current.modelId).toBe(newModel)
    expect(result.current.models.models).toHaveLength(2)
    await act(async () => {
      release.resolve()
      await update
    })
    recordConfiguration = false
    recordRenders = false
    unsubscribe()

    expect(result.current.modelId).toBe(newModel)
    expect(result.current.models.models).toHaveLength(2)
    expect(configurationSequence.length).toBeGreaterThanOrEqual(3)
    expect(configurationSequence.every((modelId) => modelId === newModel)).toBe(true)
    expect(renderSequence.length).toBeGreaterThan(0)
    expect(
      renderSequence.every(
        ({ modelId, modelCount, loading }) =>
          modelId === newModel && modelCount === 2 && loading === false,
      ),
    ).toBe(true)
  })

  it('keeps one in-flight refresh alive across a hook remount', async () => {
    const profile = profileFixture('openrouter', {
      supportsEndpointsApi: false,
      supportsPrivacyScrape: false,
    })
    const settings = cloneDefaultChatSettings()
    settings.profileId = profile.id
    const staleRow = modelsRow(profile, 0, ['old/model'])
    const freshRow = modelsRow(profile, Date.now(), ['old/model', 'fresh/model'])
    const refresh = deferred<void>()
    let refreshSignal: AbortSignal | undefined
    discoveryMocks.refreshModels.mockImplementation(async (_profile, _query, options) => {
      refreshSignal = options.signal
      await refresh.promise
    })
    const harness = await installModelCatalog(profile, settings, staleRow)

    const first = renderHook(() =>
      useModelCatalog(harness.target, profile, { modelsDemanded: true }),
    )
    await waitFor(() => expect(discoveryMocks.refreshModels).toHaveBeenCalledTimes(1))
    expect(first.result.current.models.models.map((model) => model.id)).toEqual(['old/model'])
    first.unmount()
    expect(refreshSignal?.aborted).toBe(false)

    const second = renderHook(() =>
      useModelCatalog(harness.target, profile, { modelsDemanded: true }),
    )
    await act(async () => Promise.resolve())
    expect(discoveryMocks.refreshModels).toHaveBeenCalledTimes(1)
    expect(second.result.current.models.models.map((model) => model.id)).toEqual(['old/model'])

    act(() => {
      harness.publishModels(freshRow)
      refresh.resolve()
    })
    await waitFor(() =>
      expect(second.result.current.models.models.map((model) => model.id)).toEqual([
        'old/model',
        'fresh/model',
      ]),
    )
  })

  it('refreshes at the retained coordinator deadline without a React remount', async () => {
    const profile = profileFixture('openrouter', {
      supportsEndpointsApi: false,
      supportsPrivacyScrape: false,
    })
    const settings = cloneDefaultChatSettings()
    settings.profileId = profile.id
    const now = Date.now()
    vi.useFakeTimers({ now })
    try {
      const harness = await installModelCatalog(
        profile,
        settings,
        modelsRow(profile, now, ['fresh/model']),
      )
      renderHook(() => useModelCatalog(harness.target, profile, { modelsDemanded: true }))
      await act(async () => Promise.resolve())
      expect(discoveryMocks.refreshModels).not.toHaveBeenCalled()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60 * 60 * 1_000)
      })
      expect(discoveryMocks.refreshModels).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('aborts the old workspace refresh and reasserts the same surface after replacement', async () => {
    const profile = profileFixture('openrouter', {
      supportsEndpointsApi: false,
      supportsPrivacyScrape: false,
    })
    const settings = cloneDefaultChatSettings()
    settings.profileId = profile.id
    const attempts = [deferred<void>(), deferred<void>()]
    const signals: AbortSignal[] = []
    discoveryMocks.refreshModels.mockImplementation(async (_profile, _query, options) => {
      const attempt = attempts[signals.length]
      if (!attempt) throw new Error('UnexpectedRefreshAttempt')
      signals.push(options.signal)
      await attempt.promise
    })
    const firstHarness = await installModelCatalog(
      profile,
      settings,
      modelsRow(profile, 0, ['old-workspace/model']),
    )
    const view = renderHook(() =>
      useModelCatalog(firstHarness.target, profile, { modelsDemanded: true }),
    )
    await waitFor(() => expect(discoveryMocks.refreshModels).toHaveBeenCalledTimes(1))

    await act(() => configurationController.setProjectionSource(null))
    act(() => {
      configurationController.reconcileWorkspace({
        workspaceId: 'model-catalog-replacement',
        replacementEpoch: 2,
      })
    })
    expect(signals[0]?.aborted).toBe(true)

    await installModelCatalog(
      profile,
      settings,
      modelsRow(profile, 0, ['replacement-workspace/model']),
    )
    await waitFor(() => expect(discoveryMocks.refreshModels).toHaveBeenCalledTimes(2))
    expect(signals[1]?.aborted).toBe(false)
    expect(view.result.current.models.models.map((model) => model.id)).toEqual([
      'replacement-workspace/model',
    ])

    act(() => attempts[1]?.resolve())
  })

  it('retains stale rows offline, suppresses remount retries, and clears failure on manual retry', async () => {
    const profile = profileFixture('openrouter', {
      supportsEndpointsApi: false,
      supportsPrivacyScrape: false,
    })
    const settings = cloneDefaultChatSettings()
    settings.profileId = profile.id
    const staleRow = modelsRow(profile, 0, ['offline/model'])
    const freshRow = modelsRow(profile, Date.now(), ['offline/model', 'recovered/model'])
    discoveryMocks.refreshModels.mockRejectedValue(new Error('offline'))
    const harness = await installModelCatalog(profile, settings, staleRow)

    const first = renderHook(() =>
      useModelCatalog(harness.target, profile, { modelsDemanded: true }),
    )
    await waitFor(() => expect(first.result.current.models.error).toBe('offline'))
    expect(first.result.current.models.offline).toBe(true)
    expect(first.result.current.models.models.map((model) => model.id)).toEqual(['offline/model'])
    first.unmount()

    const renderSequence: string[][] = []
    let modelsDemanded = false
    const second = renderHook(() => {
      const catalog = useModelCatalog(harness.target, profile, { modelsDemanded })
      renderSequence.push(catalog.models.models.map((model) => model.id))
      return catalog
    })
    await act(async () => Promise.resolve())
    modelsDemanded = true
    second.rerender()
    await act(async () => Promise.resolve())
    expect(discoveryMocks.refreshModels).toHaveBeenCalledTimes(1)
    expect(second.result.current.models.models.map((model) => model.id)).toEqual(['offline/model'])

    discoveryMocks.refreshModels.mockImplementation(async () => {
      harness.publishModels(freshRow)
    })
    act(() => second.result.current.models.refresh())
    await waitFor(() => expect(discoveryMocks.refreshModels).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(second.result.current.models.error).toBeNull())
    expect(second.result.current.models.offline).toBe(false)
    expect(second.result.current.models.models.map((model) => model.id)).toEqual([
      'offline/model',
      'recovered/model',
    ])
    expect(renderSequence.every((modelIds) => modelIds.length > 0)).toBe(true)
  })
})

function profileFixture(
  kind: ConnectionProfile['kind'],
  overrides: Partial<ConnectionProfile> = {},
): ConnectionProfile {
  return {
    ...buildConnectionProfile({
      id: `profile-${kind}`,
      name: kind,
      kind,
      baseUrl: kind === 'openrouter' ? 'https://openrouter.ai/api/v1' : 'http://127.0.0.1:8080/v1',
      apiKeyRef: `key-${kind}`,
      now: 1,
    }),
    ...overrides,
  }
}

function revisionFor(profile: ConnectionProfile) {
  return {
    profileId: profile.id,
    requestRevision: profile.requestRevision ?? 0,
    key: { kind: 'missing' } as const,
  }
}

function modelsRow(
  profile: ConnectionProfile,
  fetchedAt: number,
  modelIds: readonly string[],
): CachedModelsRow {
  return {
    profileId: profile.id,
    profileRevision: connectionDiscoveryRevisionKey(revisionFor(profile)),
    queryKey: modelsCacheKey(modelCatalogQueryForConnectionKind(profile.kind)),
    fetchedAt,
    payload: { data: modelIds.map((id) => ({ id })) },
  }
}

interface ModelCatalogHarness {
  readonly target: ActiveConfigurationSelectionTarget
  readonly source: ConfigurationProjectionSource
  publishModels(row: CachedModelsRow | undefined): void
}

async function installModelCatalog(
  profile: ConnectionProfile,
  settings: ReturnType<typeof cloneDefaultChatSettings>,
  row: CachedModelsRow,
): Promise<ModelCatalogHarness> {
  let models: CachedModelsRow | undefined = row
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
    async loadActiveModel(target, _knownPayloads, includeModels) {
      return activeModelRead(target, includeModels, models)
    },
  }
  configurationController.rememberSeed({ profileId: profile.id, presetId: null, settings })
  configurationController.observeDiscoverySurface({
    profileId: profile.id,
    modelId: settings.model || null,
    modelsDemanded: true,
  })
  await configurationController.setProjectionSource(source)
  await waitForConfigurationSelection()
  return {
    target: activeConfigurationTarget(),
    source,
    publishModels(next) {
      models = next
      invalidateDiscovery(profile.id, ['models'])
    },
  }
}

function selectionFixture(profile: ConnectionProfile): ConfigurationActiveSelectionProjection {
  return {
    profile,
    preset: null,
    requestRevision: revisionFor(profile),
    dispatchKeyRevisions: [],
    promptPresets: [],
    textTemplate: null,
  }
}

function preferencesFixture(): ConfigurationPreferencesProjection {
  return {
    global: structuredClone(DEFAULT_GLOBAL_PREFERENCES),
    rendering: structuredClone(DEFAULT_RENDERING_PREFS),
    sidebarSortMode: 'updatedAt-desc',
    collapsedFolderIds: [],
    imageAllowlist: [],
    samplePromptsDismissed: false,
  }
}

function shellFixture(): ConfigurationShellProjection {
  return { preferences: preferencesFixture(), totalProfileCount: 1 }
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
): ConfigurationActiveModelRead {
  return {
    kind: 'ready',
    projection: {
      revision: target.requestRevision,
      modelId: target.modelId,
      models: includeModels ? payloadProjection(models, 'models') : { kind: 'not-requested' },
      endpoints: target.modelId ? { kind: 'missing' } : { kind: 'not-requested' },
      privacy: target.modelId ? { kind: 'missing' } : { kind: 'not-requested' },
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

function invalidateDiscovery(
  profileId: string,
  cacheKinds: readonly ('models' | 'endpoints' | 'privacy')[],
): void {
  const fence = configurationController.getSnapshot().workspaceFence
  if (!fence) throw new Error('ConfigurationFenceMissing')
  const dependencies: readonly WorkspaceDependency[] = [
    { kind: 'discovery-cache', profileIds: [profileId], cacheKinds },
  ]
  configurationController.observeWorkspaceEffect(
    prepareLocalWorkspaceChange({ kind: 'invalidate', ...fence, dependencies }).effect,
  )
}

async function waitForConfigurationSelection(): Promise<void> {
  for (let index = 0; index < 64; index += 1) {
    if (configurationController.getSnapshot().frame.selection.status === 'ready') return
    await Promise.resolve()
  }
  throw new Error('ConfigurationSelectionDidNotSettle')
}

function chatFixture(profile: ConnectionProfile, model: string): Chat {
  const settings = cloneDefaultChatSettings()
  settings.profileId = profile.id
  settings.model = model
  return {
    id: 'model-selection-chat',
    title: 'Model selection',
    titleStatus: 'manual',
    createdAt: 1,
    updatedAt: 1,
    lastViewedAt: 1,
    wordCount: 0,
    totalCostUsd: 0,
    metaVersion: 0,
    summaryVersion: 0,
    settings,
    lastUpdatedLeafId: null,
    lastBranchUpdatedAt: 1,
    archived: false,
    pinned: false,
    folderId: null,
    tags: [],
    configurationVersion: 0,
    structuralVersion: 0,
  }
}

function publishConversation(chat: Chat): void {
  const fence = configurationController.getSnapshot().workspaceFence
  if (!fence) throw new Error('ConfigurationFenceMissing')
  configurationController.observeConversation({
    workspaceId: fence.workspaceId,
    workspaceEpoch: fence.replacementEpoch,
    activeChatId: chat.id,
    active: { chatId: chat.id, chat } as NonNullable<ConversationSnapshot['active']>,
  })
}

function applicationDependencies(
  port: ConfigurationDomainPort,
): ConfigurationApplicationDependencies {
  return {
    port,
    async prepareKey() {
      throw new Error('UnexpectedKeyPreparation')
    },
    async loadProfileSwitchPlan() {
      return undefined
    },
    pendingConfiguration: configurationController,
  }
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
