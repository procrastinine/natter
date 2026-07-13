// In-memory single-flight for /models + /endpoints. Two mount points
// (Shell + ChatModelPanel, say) using the same (profileId, modelId)
// must share a single Promise so the browser doesn't burn duplicate
// network roundtrips. On completion (or error) the entry is released
// so the next stale-read can re-fetch.

import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionProfile, ModelsQuery } from '../../src/core/types'
import { __resetBroadcastForTests, postEvent } from '../../src/store/broadcast'
import { __resetDbForTests, getDb, openDb } from '../../src/store/db'
import {
  __resetModelsInFlightForTests,
  dedupedEndpointsFetch,
  dedupedModelsFetch,
  getCachedEndpoints,
  getCachedModels,
} from '../../src/store/models-cache'
import {
  markBrowserWorkspaceReplaced,
  readBrowserWorkspaceMeta,
} from '../../src/store/workspace-meta'

const DB_NAME = 'natter'

async function resetAll() {
  __resetModelsInFlightForTests()
  __resetDbForTests()
  __resetBroadcastForTests()
  await Dexie.delete(DB_NAME)
}

beforeEach(async () => {
  await resetAll()
  await openDb()
})

afterEach(async () => {
  await resetAll()
})

// Build a deferred Promise so the test controls completion timing and
// can assert "only one fetch in flight."
function deferred<T>(): {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
} {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function profile(id: string, baseUrl = 'https://before.example/v1'): ConnectionProfile {
  return {
    id,
    name: 'Profile',
    kind: 'openrouter',
    baseUrl,
    apiKeyRef: 'key',
    defaultHeaders: {},
    appTitle: 'natter',
    appUrl: '',
    supportsEndpointsApi: true,
    supportsGenerationApi: true,
    supportsPrivacyScrape: true,
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('dedupedModelsFetch', () => {
  const profileId = 'prof-1'
  const query: ModelsQuery = { outputModalities: ['text'] }

  it('shares the in-flight Promise across concurrent callers', async () => {
    let calls = 0
    const gate = deferred<{ payload: string }>()
    const fetcher = async () => {
      calls += 1
      return gate.promise
    }

    const a = dedupedModelsFetch(profileId, query, fetcher)
    const b = dedupedModelsFetch(profileId, query, fetcher)
    await vi.waitFor(() => expect(calls).toBe(1))

    gate.resolve({ payload: 'ok' })
    await Promise.all([a, b])
    expect(calls).toBe(1)

    // Cache was written by the dedup helper.
    const cached = await getCachedModels(profileId, query)
    expect(cached?.payload).toEqual({ payload: 'ok' })
  })

  it('releases the slot after completion so a later call re-fetches', async () => {
    let calls = 0
    const fetcher = async () => {
      calls += 1
      return { payload: `call-${calls}` }
    }
    await dedupedModelsFetch(profileId, query, fetcher)
    await dedupedModelsFetch(profileId, query, fetcher)
    expect(calls).toBe(2)
  })

  it('releases the slot when the fetch rejects', async () => {
    let calls = 0
    const fetcher = async () => {
      calls += 1
      if (calls === 1) throw new Error('boom')
      return { payload: 'recovered' }
    }

    await expect(dedupedModelsFetch(profileId, query, fetcher)).rejects.toThrow('boom')
    // First call rejected — the next call should fire a fresh fetch
    // rather than reusing the failed Promise.
    await dedupedModelsFetch(profileId, query, fetcher)
    expect(calls).toBe(2)
    const cached = await getCachedModels(profileId, query)
    expect(cached?.payload).toEqual({ payload: 'recovered' })
  })

  it('uses a distinct slot for different query keys on the same profile', async () => {
    const a = dedupedModelsFetch(profileId, { outputModalities: ['text'] }, async () => ({
      payload: 'text-only',
    }))
    const b = dedupedModelsFetch(profileId, { outputModalities: ['text', 'image'] }, async () => ({
      payload: 'multimodal',
    }))
    await Promise.all([a, b])
    expect((await getCachedModels(profileId, { outputModalities: ['text'] }))?.payload).toEqual({
      payload: 'text-only',
    })
    expect(
      (await getCachedModels(profileId, { outputModalities: ['text', 'image'] }))?.payload,
    ).toEqual({ payload: 'multimodal' })
  })

  it('uses a distinct slot per profile', async () => {
    let calls = 0
    const fetcher = async () => {
      calls += 1
      return { payload: `call-${calls}` }
    }
    await Promise.all([
      dedupedModelsFetch('prof-A', query, fetcher),
      dedupedModelsFetch('prof-B', query, fetcher),
    ])
    expect(calls).toBe(2)
  })

  it('does not commit a response fetched for a replaced connection profile', async () => {
    await getDb().profiles.put(profile(profileId))
    const gate = deferred<{ stale: true }>()
    const fetcher = vi.fn(() => gate.promise)
    const pending = dedupedModelsFetch(profileId, query, fetcher)
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce())

    await getDb().profiles.put(profile(profileId, 'https://after.example/v1'))
    gate.resolve({ stale: true })
    await pending

    expect(await getCachedModels(profileId, query)).toBeUndefined()
  })

  it('rejects a stale response after a byte-identical replacement without a broadcast', async () => {
    await getDb().profiles.put(profile(profileId))
    const gate = deferred<{ stale: true }>()
    const fetcher = vi.fn(() => gate.promise)
    const pending = dedupedModelsFetch(profileId, query, fetcher)
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce())

    const db = getDb()
    const before = await readBrowserWorkspaceMeta(db)
    await db.transaction('rw', db.settings, async (tx) => {
      await markBrowserWorkspaceReplaced(tx, Date.now(), before)
    })
    gate.resolve({ stale: true })
    await pending

    expect(await getCachedModels(profileId, query)).toBeUndefined()
  })

  it('starts a fresh fetch after fallback invalidation while the old epoch is in flight', async () => {
    await getDb().profiles.put(profile(profileId))
    const oldGate = deferred<{ stale: true }>()
    const freshGate = deferred<{ fresh: true }>()
    let calls = 0
    const fetcher = () => {
      calls += 1
      return calls === 1 ? oldGate.promise : freshGate.promise
    }
    const stale = dedupedModelsFetch(profileId, query, fetcher)
    await vi.waitFor(() => expect(calls).toBe(1))

    const db = getDb()
    const before = await readBrowserWorkspaceMeta(db)
    await db.transaction('rw', db.settings, async (tx) => {
      await markBrowserWorkspaceReplaced(tx, Date.now(), before)
    })
    postEvent({ kind: 'workspace-invalidated', mutationCounter: before.mutationCounter + 1 })
    const fresh = dedupedModelsFetch(profileId, query, fetcher)
    await vi.waitFor(() => expect(calls).toBe(2))
    freshGate.resolve({ fresh: true })
    await fresh
    oldGate.resolve({ stale: true })
    await stale

    expect((await getCachedModels(profileId, query))?.payload).toEqual({ fresh: true })
  })
})

describe('dedupedEndpointsFetch', () => {
  const profileId = 'prof-1'
  const modelId = 'openai/gpt-5.4'

  it('shares the in-flight Promise across concurrent callers', async () => {
    let calls = 0
    const gate = deferred<{ payload: string }>()
    const fetcher = async () => {
      calls += 1
      return gate.promise
    }

    const a = dedupedEndpointsFetch(profileId, modelId, fetcher)
    const b = dedupedEndpointsFetch(profileId, modelId, fetcher)
    await vi.waitFor(() => expect(calls).toBe(1))

    gate.resolve({ payload: 'ok' })
    await Promise.all([a, b])
    expect(calls).toBe(1)

    const cached = await getCachedEndpoints(profileId, modelId)
    expect(cached?.payload).toEqual({ payload: 'ok' })
  })

  it('different (profile, model) tuples do not share the slot', async () => {
    let calls = 0
    const fetcher = async () => {
      calls += 1
      return { payload: `call-${calls}` }
    }
    await Promise.all([
      dedupedEndpointsFetch(profileId, 'openai/gpt-5.4', fetcher),
      dedupedEndpointsFetch(profileId, 'anthropic/claude-opus-4.7', fetcher),
      dedupedEndpointsFetch('prof-B', 'openai/gpt-5.4', fetcher),
    ])
    expect(calls).toBe(3)
  })

  it('releases the slot on rejection', async () => {
    let calls = 0
    const fetcher = async () => {
      calls += 1
      if (calls === 1) throw new Error('network')
      return { payload: 'ok' }
    }
    await expect(dedupedEndpointsFetch(profileId, modelId, fetcher)).rejects.toThrow('network')
    await dedupedEndpointsFetch(profileId, modelId, fetcher)
    expect(calls).toBe(2)
  })
})
