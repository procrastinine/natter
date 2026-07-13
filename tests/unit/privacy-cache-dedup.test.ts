// Single-flight for the privacy scrape. See
// `src/store/privacy-cache.ts::dedupedPrivacyFetch`. Two mount points
// (e.g. header lock + provider picker), or many cold-started tabs sharing
// a (profileId, modelId), must not fire duplicate scrapes.

import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionProfile } from '../../src/core/types'
import { __resetBroadcastForTests, postEvent } from '../../src/store/broadcast'
import { __resetDbForTests, getDb, openDb } from '../../src/store/db'
import {
  __resetLockTrackerForTests,
  __setLockBackendForTests,
  type LockBackend,
} from '../../src/store/locks'
import { isFresh } from '../../src/store/models-cache'
import {
  __resetPrivacyInFlightForTests,
  type DedupedPrivacyFetchOptions,
  dedupedPrivacyFetch,
  getCachedPrivacyPolicy,
  PRIVACY_POLICY_TTL_MS,
} from '../../src/store/privacy-cache'
import {
  markBrowserWorkspaceReplaced,
  readBrowserWorkspaceMeta,
} from '../../src/store/workspace-meta'

const DB_NAME = 'natter'

async function resetAll() {
  __resetDbForTests()
  __resetBroadcastForTests()
  __resetPrivacyInFlightForTests()
  __resetLockTrackerForTests()
  await Dexie.delete(DB_NAME)
}

beforeEach(async () => {
  await resetAll()
  await openDb()
})

afterEach(async () => {
  await resetAll()
})

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

describe('dedupedPrivacyFetch', () => {
  const profileId = 'prof-1'
  const modelId = 'openai/gpt-5.4'
  const skipFresh: DedupedPrivacyFetchOptions = {
    isCachedFresh: (row) => !!row && isFresh(row.fetchedAt, PRIVACY_POLICY_TTL_MS),
  }

  it('shares the in-flight Promise across concurrent callers', async () => {
    let calls = 0
    const gate = deferred<{ policies: Record<string, unknown>; fetchedAt: number }>()
    const fetcher = async () => {
      calls += 1
      return gate.promise
    }
    const a = dedupedPrivacyFetch(profileId, modelId, fetcher)
    const b = dedupedPrivacyFetch(profileId, modelId, fetcher)
    await vi.waitFor(() => expect(calls).toBe(1))
    gate.resolve({ policies: {}, fetchedAt: 1 })
    await Promise.all([a, b])
    expect(calls).toBe(1)
    const cached = await getCachedPrivacyPolicy(profileId, modelId)
    expect(cached).toBeTruthy()
  })

  it('releases the slot after completion so a later call re-fetches', async () => {
    let calls = 0
    const fetcher = async () => {
      calls += 1
      return { policies: {}, fetchedAt: calls }
    }
    await dedupedPrivacyFetch(profileId, modelId, fetcher)
    await dedupedPrivacyFetch(profileId, modelId, fetcher)
    expect(calls).toBe(2)
  })

  it('releases the slot on rejection', async () => {
    let calls = 0
    const fetcher = async () => {
      calls += 1
      if (calls === 1) throw new Error('boom')
      return { policies: {}, fetchedAt: 2 }
    }
    await expect(dedupedPrivacyFetch(profileId, modelId, fetcher)).rejects.toThrow('boom')
    await dedupedPrivacyFetch(profileId, modelId, fetcher)
    expect(calls).toBe(2)
  })

  it('uses distinct slots per (profile, model) tuple', async () => {
    let calls = 0
    const fetcher = async () => {
      calls += 1
      return { policies: {}, fetchedAt: calls }
    }
    await Promise.all([
      dedupedPrivacyFetch('prof-A', modelId, fetcher),
      dedupedPrivacyFetch('prof-B', modelId, fetcher),
      dedupedPrivacyFetch(profileId, 'anthropic/claude-opus-4.7', fetcher),
    ])
    expect(calls).toBe(3)
  })

  it('does not commit a scrape fetched for a replaced connection profile', async () => {
    await getDb().profiles.put(profile(profileId))
    const gate = deferred<{ stale: true }>()
    const fetcher = vi.fn(() => gate.promise)
    const pending = dedupedPrivacyFetch(profileId, modelId, fetcher)
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce())

    await getDb().profiles.put(profile(profileId, 'https://after.example/v1'))
    gate.resolve({ stale: true })
    await pending

    expect(await getCachedPrivacyPolicy(profileId, modelId)).toBeUndefined()
  })

  it('rejects a stale scrape and releases fallback dedup after replacement', async () => {
    await getDb().profiles.put(profile(profileId))
    const staleGate = deferred<{ stale: true }>()
    const freshGate = deferred<{ fresh: true }>()
    let calls = 0
    const fetcher = () => {
      calls += 1
      return calls === 1 ? staleGate.promise : freshGate.promise
    }
    const stale = dedupedPrivacyFetch(profileId, modelId, fetcher)
    await vi.waitFor(() => expect(calls).toBe(1))

    const db = getDb()
    const before = await readBrowserWorkspaceMeta(db)
    await db.transaction('rw', db.settings, async (tx) => {
      await markBrowserWorkspaceReplaced(tx, Date.now(), before)
    })
    postEvent({ kind: 'workspace-invalidated', mutationCounter: before.mutationCounter + 1 })
    const fresh = dedupedPrivacyFetch(profileId, modelId, fetcher)
    await vi.waitFor(() => expect(calls).toBe(2))
    freshGate.resolve({ fresh: true })
    await fresh
    staleGate.resolve({ stale: true })
    await stale

    expect((await getCachedPrivacyPolicy(profileId, modelId))?.payload).toEqual({ fresh: true })
  })

  it('does not hold the workspace lock while fetching', async () => {
    let lockHeld = false
    let fetchObservedLock: boolean | undefined
    let lockCalls = 0
    const backend: LockBackend = {
      kind: 'web-locks',
      run: async (logicalNames, fn) => {
        lockCalls += 1
        lockHeld = true
        try {
          return await fn({
            kind: 'web-locks',
            logicalNames,
            runTransaction: (db, _tables, transactionFn) =>
              db.transaction(
                'rw',
                [db.table('privacyPolicies'), db.table('profiles'), db.table('settings')],
                transactionFn,
              ),
          })
        } finally {
          lockHeld = false
        }
      },
    }
    __setLockBackendForTests(backend)

    await dedupedPrivacyFetch(profileId, modelId, async () => {
      fetchObservedLock = lockHeld
      return { policies: {}, fetchedAt: Date.now() }
    })

    expect(fetchObservedLock).toBe(false)
    expect(lockCalls).toBe(1)
  })

  it('keeps a fresh competing result instead of overwriting it after a tab race', async () => {
    let calls = 0
    const firstGate = deferred<{ policies: Record<string, unknown>; fetchedAt: number }>()
    const secondGate = deferred<{ policies: Record<string, unknown>; fetchedAt: number }>()
    const fetcher = async () => {
      calls += 1
      return calls === 1 ? firstGate.promise : secondGate.promise
    }

    const first = dedupedPrivacyFetch(profileId, modelId, fetcher, skipFresh)
    await vi.waitFor(() => expect(calls).toBe(1))

    // Simulate another tab: it has no access to this module's in-memory
    // single-flight map, but its commit uses the same Web Lock/fallback lock.
    __resetPrivacyInFlightForTests()
    const second = dedupedPrivacyFetch(profileId, modelId, fetcher, skipFresh)
    await vi.waitFor(() => expect(calls).toBe(2))

    const winningPayload = {
      policies: { OpenAI: { training: false } },
      fetchedAt: Date.now(),
    }
    secondGate.resolve(winningPayload)
    await second
    firstGate.resolve({ policies: { Azure: { training: false } }, fetchedAt: Date.now() })
    await first

    expect(calls).toBe(2)
    expect((await getCachedPrivacyPolicy(profileId, modelId))?.payload).toEqual(winningPayload)
  })

  it('force refresh bypasses the under-lock cache re-check', async () => {
    await dedupedPrivacyFetch(profileId, modelId, async () => ({
      policies: { Azure: { training: false } },
      fetchedAt: Date.now(),
    }))
    let calls = 0
    await dedupedPrivacyFetch(
      profileId,
      modelId,
      async () => {
        calls += 1
        return { policies: { OpenAI: { training: false } }, fetchedAt: Date.now() }
      },
      { ...skipFresh, force: true },
    )

    expect(calls).toBe(1)
  })
})
