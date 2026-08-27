import { afterEach, describe, expect, it, vi } from 'vitest'
import { modelCatalogQueryForConnectionKind, modelsCacheKey } from '../../src/core/cache-keys'
import type { ConnectionProfile } from '../../src/core/types'
import { ConfigurationDiscoveryCoordinator } from '../../src/store/configuration-discovery-coordinator'
import type { CachedModelsRow } from '../../src/store/db-rows'
import type { ConfigurationModelCatalogProjection } from '../../src/store/workspace-protocol'
import { connectionDiscoveryRevisionKey } from '../../src/store/workspace-protocol'

const discovery = vi.hoisted(() => ({
  refreshModels: vi.fn(),
  refreshEndpoints: vi.fn(),
  refreshPrivacy: vi.fn(),
  clearModels: vi.fn(),
}))

vi.mock('../../src/store/discovery-service', () => ({
  configurationDiscoveryApplication: Object.freeze({
    policy: Object.freeze({
      modelsTtlMs: 300_000,
      endpointsTtlMs: 300_000,
      privacyTtlMs: 86_400_000,
      emptyPrivacyRetryMs: 60_000,
    }),
    refreshModels: discovery.refreshModels,
    refreshEndpoints: discovery.refreshEndpoints,
    refreshPrivacy: discovery.refreshPrivacy,
    clearModels: discovery.clearModels,
    isFresh: (fetchedAt: number, ttlMs: number, now: number) => fetchedAt + ttlMs > now,
  }),
}))

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('ConfigurationDiscoveryCoordinator', () => {
  it('does not let reentrant freshness reconciliation abort an explicit refresh', async () => {
    let releaseRefresh: () => void = () => undefined
    const pendingRefresh = new Promise<void>((resolve) => {
      releaseRefresh = resolve
    })
    const signalsAtDispatch: boolean[] = []
    discovery.refreshModels.mockImplementation((...args: unknown[]) => {
      const options = args[2] as { signal: AbortSignal }
      signalsAtDispatch.push(options.signal.aborted)
      return pendingRefresh
    })

    const input = modelCatalogInput()
    const coordinator = new ConfigurationDiscoveryCoordinator({
      onChange: () => coordinator.reconcile(input),
    })
    coordinator.reconcile(input)

    coordinator.requestModels(input.surface.profileId)
    await Promise.resolve()

    expect(signalsAtDispatch).toEqual([false])
    expect(coordinator.getSnapshot().statuses.models.inFlight).toBe(true)

    releaseRefresh()
    await pendingRefresh
    await vi.waitFor(() => expect(coordinator.getSnapshot().statuses.models.inFlight).toBe(false))
    coordinator.reset()
  })

  it('leaves projection reload ownership to committed workspace effects', async () => {
    let input = modelCatalogInput()
    const coordinator = new ConfigurationDiscoveryCoordinator({
      onChange: () => coordinator.reconcile(input),
    })
    discovery.refreshModels.mockImplementation(async () => {
      const current = input.modelCatalog.models
      if (!current) throw new Error('ExpectedModelsProjection')
      input = {
        ...input,
        modelCatalog: {
          ...input.modelCatalog,
          models: { ...current, fetchedAt: current.fetchedAt + 1 },
        },
      }
      coordinator.reconcile(input)
    })
    coordinator.reconcile(input)

    coordinator.requestModels(input.surface.profileId)
    await vi.waitFor(() => expect(discovery.refreshModels).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(coordinator.getSnapshot().statuses.models.inFlight).toBe(false))

    expect(input.modelCatalog.models?.fetchedAt).toBeGreaterThan(0)
    coordinator.reset()
  })

  it('cancels an obsolete routing refresh and starts the published profile revision', async () => {
    let input = modelRoutingInput(1)
    const firstSignals: AbortSignal[] = []
    discovery.refreshEndpoints
      .mockImplementationOnce(
        (...args: unknown[]) =>
          new Promise<void>((_resolve, reject) => {
            const options = args[2] as { signal: AbortSignal }
            firstSignals.push(options.signal)
            options.signal.addEventListener('abort', () => reject(options.signal.reason), {
              once: true,
            })
          }),
      )
      .mockResolvedValueOnce(undefined)
    const coordinator = new ConfigurationDiscoveryCoordinator({ onChange: () => undefined })
    coordinator.reconcile(input)
    await vi.waitFor(() => expect(discovery.refreshEndpoints).toHaveBeenCalledOnce())

    input = modelRoutingInput(2)
    coordinator.reconcile(input)

    await vi.waitFor(() => expect(discovery.refreshEndpoints).toHaveBeenCalledTimes(2))
    expect(firstSignals[0]?.aborted).toBe(true)
    expect(discovery.refreshEndpoints.mock.calls[1]?.[0]).toMatchObject({ requestRevision: 2 })
    expect(coordinator.getSnapshot().statuses.endpoints.error).toBeNull()
    coordinator.reset()
  })

  it('keeps a failed durable baseline settled across equivalent row rematerialization', async () => {
    let input = modelCatalogInput()
    const coordinator = new ConfigurationDiscoveryCoordinator({
      onChange: () => coordinator.reconcile(input),
    })
    discovery.refreshModels.mockRejectedValueOnce(new Error('offline'))
    coordinator.reconcile(input)
    coordinator.requestModels(input.surface.profileId)
    await vi.waitFor(() => expect(coordinator.getSnapshot().statuses.models.error).toBe('offline'))

    const current = input.modelCatalog.models
    if (!current) throw new Error('ExpectedModelsProjection')
    input = {
      ...input,
      modelCatalog: {
        ...input.modelCatalog,
        models: { ...current, payload: structuredClone(current.payload) },
      },
    }
    coordinator.reconcile(input)

    expect(coordinator.getSnapshot().statuses.models.error).toBe('offline')
    expect(discovery.refreshModels).toHaveBeenCalledOnce()
    coordinator.reset()
  })

  it('clears a failed status when a newer durable row replaces its baseline', async () => {
    let input = modelCatalogInput()
    const coordinator = new ConfigurationDiscoveryCoordinator({
      onChange: () => coordinator.reconcile(input),
    })
    discovery.refreshModels.mockRejectedValueOnce(new Error('offline'))
    coordinator.reconcile(input)
    coordinator.requestModels(input.surface.profileId)
    await vi.waitFor(() => expect(coordinator.getSnapshot().statuses.models.error).toBe('offline'))

    const current = input.modelCatalog.models
    if (!current) throw new Error('ExpectedModelsProjection')
    input = {
      ...input,
      modelCatalog: {
        ...input.modelCatalog,
        models: {
          ...current,
          fetchedAt: current.fetchedAt + 1,
          payload: { data: [{ id: 'test/replacement-model' }] },
        },
      },
    }
    coordinator.reconcile(input)

    expect(coordinator.getSnapshot().statuses.models.error).toBeNull()
    coordinator.reset()
  })

  it('keeps failure settled without clock-based network readmission', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    const input = modelCatalogInput()
    const coordinator = new ConfigurationDiscoveryCoordinator({ onChange: () => undefined })
    discovery.refreshModels.mockRejectedValueOnce(new Error('offline'))
    coordinator.reconcile(input)

    coordinator.requestModels(input.surface.profileId)
    await vi.waitFor(() => expect(coordinator.getSnapshot().statuses.models.error).toBe('offline'))

    await vi.advanceTimersByTimeAsync(600_000)
    coordinator.reconcile(input)

    expect(discovery.refreshModels).toHaveBeenCalledOnce()
    expect(coordinator.getSnapshot().statuses.models).toMatchObject({
      inFlight: false,
      error: 'offline',
    })
    coordinator.reset()
  })
})

function modelCatalogInput() {
  const profile: ConnectionProfile = {
    id: 'profile-openrouter',
    name: 'OpenRouter',
    kind: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyRef: 'key-openrouter',
    defaultHeaders: {},
    appTitle: 'natter',
    appUrl: 'http://localhost',
    supportsEndpointsApi: true,
    supportsGenerationApi: true,
    supportsPrivacyScrape: true,
    requestRevision: 1,
    createdAt: 1,
    updatedAt: 1,
  }
  const revision = {
    profileId: profile.id,
    requestRevision: profile.requestRevision ?? 0,
    key: { kind: 'missing' } as const,
  }
  const models: CachedModelsRow = {
    profileId: profile.id,
    profileRevision: connectionDiscoveryRevisionKey(revision),
    queryKey: modelsCacheKey(modelCatalogQueryForConnectionKind(profile.kind)),
    fetchedAt: Date.now(),
    payload: { data: [{ id: 'test/stale-model' }] },
  }
  const modelCatalog: ConfigurationModelCatalogProjection = { profile, revision, models }
  return {
    enabled: true,
    surface: { profileId: profile.id, modelId: null, modelsDemanded: true },
    modelCatalog,
    modelRouting: null,
  } as const
}

function modelRoutingInput(requestRevision: number) {
  const base = modelCatalogInput()
  const profile = {
    ...base.modelCatalog.profile,
    requestRevision,
    updatedAt: requestRevision,
  }
  const revision = {
    profileId: profile.id,
    requestRevision,
    key: { kind: 'missing' } as const,
  }
  const modelId = 'openai/gpt-5.4'
  return {
    enabled: true,
    surface: { profileId: profile.id, modelId, modelsDemanded: false },
    modelCatalog: { profile, revision },
    modelRouting: {
      profileId: profile.id,
      revision,
      modelId,
      proxy: { url: '', secret: '' },
    },
  } as const
}
