import Dexie from 'dexie'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ModelsModule from '../../src/api/models'
import { fetchEndpoints, fetchModels } from '../../src/api/models'
import type { ConnectionProfile, ModelsQuery } from '../../src/core/types'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import { __resetBrowserRepositoryForTests } from '../../src/store/browser-repo'
import { __resetDbForTests, getDb } from '../../src/store/db'
import {
  configurationDiscoveryApplication,
  resolveEndpointsDiscovery,
} from '../../src/store/discovery-service'
import { getCachedEndpoints, getCachedModels } from '../../src/store/models-cache'
import { __resetWorkspaceRepositoryForTests } from '../../src/store/workspace-repository'
import { ownBrowserWorkspaceSuite } from '../helpers/browser-workspace-suite'

vi.mock('../../src/api/models', async () => {
  const actual = await vi.importActual<typeof ModelsModule>('../../src/api/models')
  return { ...actual, fetchModels: vi.fn(), fetchEndpoints: vi.fn() }
})

const DB_NAME = 'natter'
const workspaceSuite = ownBrowserWorkspaceSuite()
const fetchModelsMock = vi.mocked(fetchModels)
const fetchEndpointsMock = vi.mocked(fetchEndpoints)
let sequence = 0

beforeAll(async () => {
  ;(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory()
  __resetWorkspaceRepositoryForTests()
  __resetBrowserRepositoryForTests()
  __resetBroadcastForTests()
  __resetDbForTests()
  await Dexie.delete(DB_NAME)
  await workspaceSuite.open()
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe('unified model discovery single-flight', () => {
  const query: ModelsQuery = { outputModalities: ['text'] }

  it('shares one models fetch for the same profile revision and normalized query', async () => {
    const selected = await seedProfile()
    const gate = deferred<ReturnType<typeof modelsPayload>>()
    fetchModelsMock.mockReturnValueOnce(gate.promise)

    const first = configurationDiscoveryApplication.refreshModels(selected, query)
    const second = configurationDiscoveryApplication.refreshModels(selected, {
      outputModalities: ['text'],
    })
    await vi.waitFor(() => expect(fetchModelsMock).toHaveBeenCalledOnce())
    gate.resolve(modelsPayload('model-a'))
    await Promise.all([first, second])

    expect(fetchModelsMock).toHaveBeenCalledOnce()
    expect((await getCachedModels(selected.id, query))?.payload).toEqual(modelsPayload('model-a'))
  })

  it('normalizes reordered array query fields to the same cache owner', async () => {
    const selected = await seedProfile()
    const firstQuery: ModelsQuery = { supportedParameters: ['tools', 'response_format'] }
    const secondQuery: ModelsQuery = { supportedParameters: ['response_format', 'tools'] }
    fetchModelsMock.mockResolvedValueOnce(modelsPayload('model-a'))

    await configurationDiscoveryApplication.refreshModels(selected, firstQuery)
    await configurationDiscoveryApplication.refreshModels(selected, secondQuery)

    expect(fetchModelsMock).toHaveBeenCalledOnce()
    expect(await getCachedModels(selected.id, secondQuery)).toBeDefined()
  })

  it('force refresh replaces a fresh row through the same service', async () => {
    const selected = await seedProfile()
    fetchModelsMock
      .mockResolvedValueOnce(modelsPayload('model-a'))
      .mockResolvedValueOnce(modelsPayload('model-b'))

    await configurationDiscoveryApplication.refreshModels(selected, query)
    await configurationDiscoveryApplication.refreshModels(selected, query, { force: true })

    expect(fetchModelsMock).toHaveBeenCalledTimes(2)
    expect((await getCachedModels(selected.id, query))?.payload).toEqual(modelsPayload('model-b'))
  })

  it('releases the coordination flight after a failed fetch', async () => {
    const selected = await seedProfile()
    fetchModelsMock
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(modelsPayload('recovered'))

    await expect(configurationDiscoveryApplication.refreshModels(selected, query)).rejects.toThrow(
      'network',
    )
    await configurationDiscoveryApplication.refreshModels(selected, query)

    expect(fetchModelsMock).toHaveBeenCalledTimes(2)
  })

  it('keeps distinct profiles and query keys independent', async () => {
    const firstProfile = await seedProfile()
    const secondProfile = await seedProfile()
    fetchModelsMock.mockImplementation(async (_input, queryString) =>
      modelsPayload(`${_input.profile.baseUrl}:${queryString?.output_modalities ?? 'all'}`),
    )

    await Promise.all([
      configurationDiscoveryApplication.refreshModels(firstProfile, {
        outputModalities: ['text'],
      }),
      configurationDiscoveryApplication.refreshModels(firstProfile, {
        outputModalities: ['image'],
      }),
      configurationDiscoveryApplication.refreshModels(secondProfile, {
        outputModalities: ['text'],
      }),
    ])

    expect(fetchModelsMock).toHaveBeenCalledTimes(3)
  })

  it('shares one endpoints fetch and then reuses the committed descriptor', async () => {
    const selected = await seedProfile()
    const gate = deferred<ReturnType<typeof endpointsPayload>>()
    fetchEndpointsMock.mockReturnValueOnce(gate.promise)

    const first = resolveEndpointsDiscovery(selected, 'openai/gpt-5.4')
    const second = resolveEndpointsDiscovery(selected, 'openai/gpt-5.4')
    await vi.waitFor(() => expect(fetchEndpointsMock).toHaveBeenCalledOnce())
    gate.resolve(endpointsPayload('openai/gpt-5.4'))
    await Promise.all([first, second])
    await resolveEndpointsDiscovery(selected, 'openai/gpt-5.4')

    expect(fetchEndpointsMock).toHaveBeenCalledOnce()
    expect(await getCachedEndpoints(selected.id, 'openai/gpt-5.4')).toBeDefined()
  })

  it('does not publish a models response captured for an obsolete profile revision', async () => {
    const selected = await seedProfile()
    const gate = deferred<ReturnType<typeof modelsPayload>>()
    fetchModelsMock.mockReturnValueOnce(gate.promise)
    const pending = configurationDiscoveryApplication.refreshModels(selected, query)
    await vi.waitFor(() => expect(fetchModelsMock).toHaveBeenCalledOnce())

    await getDb().profiles.put({ ...selected, requestRevision: 1, updatedAt: 2 })
    gate.resolve(modelsPayload('stale'))
    await pending

    expect(await getCachedModels(selected.id, query)).toBeUndefined()
  })

  it('does not publish endpoints captured for an obsolete profile revision', async () => {
    const selected = await seedProfile()
    const gate = deferred<ReturnType<typeof endpointsPayload>>()
    fetchEndpointsMock.mockReturnValueOnce(gate.promise)
    const pending = resolveEndpointsDiscovery(selected, 'openai/gpt-5.4')
    await vi.waitFor(() => expect(fetchEndpointsMock).toHaveBeenCalledOnce())

    await getDb().profiles.put({ ...selected, requestRevision: 1, updatedAt: 2 })
    gate.resolve(endpointsPayload('openai/gpt-5.4'))
    await pending

    expect(await getCachedEndpoints(selected.id, 'openai/gpt-5.4')).toBeUndefined()
  })
})

async function seedProfile(): Promise<ConnectionProfile> {
  sequence += 1
  const selected: ConnectionProfile = {
    id: `model-profile-${sequence}`,
    name: `Models ${sequence}`,
    kind: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyRef: `model-key-${sequence}`,
    defaultHeaders: {},
    appTitle: 'natter',
    appUrl: '',
    supportsEndpointsApi: true,
    supportsGenerationApi: true,
    supportsPrivacyScrape: true,
    createdAt: 1,
    updatedAt: 1,
    requestRevision: 0,
  }
  await getDb().profiles.put(selected)
  return selected
}

function modelsPayload(id: string) {
  return { data: [{ id, name: id }] }
}

function endpointsPayload(modelId: string) {
  return { modelId, endpoints: [] }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T): void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}
