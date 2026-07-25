import Dexie from 'dexie'
import { ownBrowserWorkspaceSuite } from '../helpers/browser-workspace-suite'
import { putCachedPrivacyPolicy } from '../helpers/discovery-cache'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as PrivacyScrapeModule from '../../src/api/privacy-scrape'
import { fetchPrivacyScrape, readCachedPrivacyPayload } from '../../src/api/privacy-scrape'
import { DEV_CORS_PROXY_URL } from '../../src/core/cors-proxy'
import type { ConnectionProfile, DataPolicy } from '../../src/core/types'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import { __resetBrowserRepositoryForTests } from '../../src/store/browser-repo'
import { __resetDbForTests, getDb } from '../../src/store/db'
import { resolvePrivacyDiscovery } from '../../src/store/discovery-service'
import { withNamedLock } from '../../src/store/locks'
import { getCachedPrivacyPolicy } from '../../src/store/privacy-cache'
import { __resetWorkspaceRepositoryForTests } from '../../src/store/workspace-repository'

vi.mock('../../src/api/privacy-scrape', async () => {
  const actual = await vi.importActual<typeof PrivacyScrapeModule>('../../src/api/privacy-scrape')
  return { ...actual, fetchPrivacyScrape: vi.fn() }
})

const DB_NAME = 'natter'
const workspaceSuite = ownBrowserWorkspaceSuite()
const fetchPrivacyScrapeMock = vi.mocked(fetchPrivacyScrape)
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

describe('unified privacy discovery single-flight', () => {
  it('shares one fetch across concurrent callers for the same revision and model', async () => {
    const selected = await seedProfile()
    const gate = deferred<ReturnType<typeof scrapeResult>>()
    fetchPrivacyScrapeMock.mockReturnValueOnce(gate.promise)

    const first = resolve(selected, 'openai/gpt-5.4')
    const second = resolve(selected, 'openai/gpt-5.4')
    await vi.waitFor(() => expect(fetchPrivacyScrapeMock).toHaveBeenCalledOnce())
    const now = vi.spyOn(Date, 'now').mockReturnValue(200)
    gate.resolve(scrapeResult('openai/gpt-5.4', { azure: policy() }, 100))
    const [left, right] = await Promise.all([first, second]).finally(() => now.mockRestore())

    expect(fetchPrivacyScrapeMock).toHaveBeenCalledOnce()
    expect(left.payload).toEqual(right.payload)
    expect(left.payload).toMatchObject({ fetchedAt: 200 })
    expect((await getCachedPrivacyPolicy(selected.id, 'openai/gpt-5.4'))?.payload).toEqual(
      left.payload,
    )
  })

  it('keeps network work outside the fallback writer fence so its guarded commit can finish', async () => {
    const selected = await seedProfile()
    const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks')
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined })
    const proofKey = `discovery-fetch-proof-${sequence}`
    fetchPrivacyScrapeMock.mockImplementationOnce(async (_input, modelId) => {
      const db = getDb()
      await withNamedLock(`fetch-proof:${selected.id}`, (grant) =>
        grant.runTransaction(db, [db.settings], async (tx) => {
          await tx.table('settings').put({ key: proofKey, value: true })
        }),
      )
      return scrapeResult(modelId, { azure: policy() })
    })

    try {
      await resolve(selected, 'openai/gpt-5.4')
    } finally {
      if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks)
      else Reflect.deleteProperty(navigator, 'locks')
    }

    expect((await getDb().settings.get(proofKey))?.value).toBe(true)
    expect(await getCachedPrivacyPolicy(selected.id, 'openai/gpt-5.4')).toBeDefined()
  })

  it('reuses a fresh committed row after the flight completes', async () => {
    const selected = await seedProfile()
    fetchPrivacyScrapeMock.mockResolvedValueOnce(
      scrapeResult('openai/gpt-5.4', { azure: policy() }),
    )

    await resolve(selected, 'openai/gpt-5.4')
    await resolve(selected, 'openai/gpt-5.4')

    expect(fetchPrivacyScrapeMock).toHaveBeenCalledOnce()
  })

  it('force refresh bypasses the fresh row without adding a second cache owner', async () => {
    const selected = await seedProfile()
    fetchPrivacyScrapeMock
      .mockResolvedValueOnce(scrapeResult('openai/gpt-5.4', { azure: policy() }))
      .mockResolvedValueOnce(scrapeResult('openai/gpt-5.4', { openai: policy() }))

    await resolve(selected, 'openai/gpt-5.4')
    await resolve(selected, 'openai/gpt-5.4', { force: true })

    expect(fetchPrivacyScrapeMock).toHaveBeenCalledTimes(2)
    const cached = await getCachedPrivacyPolicy(selected.id, 'openai/gpt-5.4')
    expect(readCachedPrivacyPayload(cached?.payload)?.policies.openai).toBeDefined()
  })

  it('releases the named flight after rejection', async () => {
    const selected = await seedProfile()
    fetchPrivacyScrapeMock
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(scrapeResult('openai/gpt-5.4', { azure: policy() }))

    await expect(resolve(selected, 'openai/gpt-5.4')).rejects.toThrow('boom')
    await resolve(selected, 'openai/gpt-5.4')

    expect(fetchPrivacyScrapeMock).toHaveBeenCalledTimes(2)
  })

  it('keeps different profile and model tuples independent', async () => {
    const firstProfile = await seedProfile()
    const secondProfile = await seedProfile()
    fetchPrivacyScrapeMock.mockImplementation(async (_input, modelId) =>
      scrapeResult(modelId, { azure: policy() }),
    )

    await Promise.all([
      resolve(firstProfile, 'openai/gpt-5.4'),
      resolve(firstProfile, 'anthropic/claude-opus-4.7'),
      resolve(secondProfile, 'openai/gpt-5.4'),
    ])

    expect(fetchPrivacyScrapeMock).toHaveBeenCalledTimes(3)
  })

  it('does not commit a response captured for an obsolete profile revision', async () => {
    const selected = await seedProfile()
    const gate = deferred<ReturnType<typeof scrapeResult>>()
    fetchPrivacyScrapeMock.mockReturnValueOnce(gate.promise)
    const pending = resolve(selected, 'openai/gpt-5.4')
    await vi.waitFor(() => expect(fetchPrivacyScrapeMock).toHaveBeenCalledOnce())

    await getDb().profiles.put({ ...selected, requestRevision: 1, updatedAt: 2 })
    gate.resolve(scrapeResult('openai/gpt-5.4', { azure: policy() }))
    await pending

    expect(await getCachedPrivacyPolicy(selected.id, 'openai/gpt-5.4')).toBeUndefined()
  })

  it('preserves a fresher competing cache commit', async () => {
    const selected = await seedProfile()
    const gate = deferred<ReturnType<typeof scrapeResult>>()
    fetchPrivacyScrapeMock.mockReturnValueOnce(gate.promise)
    const pending = resolve(selected, 'openai/gpt-5.4')
    await vi.waitFor(() => expect(fetchPrivacyScrapeMock).toHaveBeenCalledOnce())

    const winning = { policies: { openai: policy() }, fetchedAt: Date.now() + 1 }
    await putCachedPrivacyPolicy(selected.id, 'openai/gpt-5.4', winning, winning.fetchedAt)
    gate.resolve(scrapeResult('openai/gpt-5.4', { azure: policy() }))
    await pending

    expect((await getCachedPrivacyPolicy(selected.id, 'openai/gpt-5.4'))?.payload).toEqual(winning)
  })
})

function resolve(selected: ConnectionProfile, modelId: string, options: { force?: boolean } = {}) {
  return resolvePrivacyDiscovery(selected, modelId, {
    proxy: { url: DEV_CORS_PROXY_URL, secret: '' },
    ...options,
  })
}

async function seedProfile(): Promise<ConnectionProfile> {
  sequence += 1
  const selected: ConnectionProfile = {
    id: `privacy-profile-${sequence}`,
    name: `Privacy ${sequence}`,
    kind: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyRef: `privacy-key-${sequence}`,
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

function scrapeResult(
  modelId: string,
  policies: Record<string, DataPolicy>,
  fetchedAt = Date.now(),
) {
  return {
    modelId,
    policies,
    raw: { policies, fetchedAt },
    fetchedAt,
  }
}

function policy(overrides: Partial<DataPolicy> = {}): DataPolicy {
  return {
    training: false,
    trainingOpenRouter: false,
    retainsPrompts: false,
    canPublish: false,
    termsOfServiceURL: '',
    privacyPolicyURL: '',
    ...overrides,
  }
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
