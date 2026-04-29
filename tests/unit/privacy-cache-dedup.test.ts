// Single-flight for the privacy scrape. See
// `src/store/privacy-cache.ts::dedupedPrivacyFetch`. Two mount points
// (e.g. header lock + provider picker), or many cold-started tabs sharing
// a (profileId, modelId), must not fire duplicate scrapes.

import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import { __resetDbForTests, openDb } from '../../src/store/db'
import { __resetLockTrackerForTests } from '../../src/store/locks'
import { isFresh } from '../../src/store/models-cache'
import {
  __resetPrivacyInFlightForTests,
  type DedupedPrivacyFetchOptions,
  dedupedPrivacyFetch,
  getCachedPrivacyPolicy,
  PRIVACY_POLICY_TTL_MS,
} from '../../src/store/privacy-cache'

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

  it('re-checks the cache inside the lock so a tab storm fetches once', async () => {
    let calls = 0
    const gate = deferred<{ policies: Record<string, unknown>; fetchedAt: number }>()
    const fetcher = async () => {
      calls += 1
      return gate.promise
    }

    const first = dedupedPrivacyFetch(profileId, modelId, fetcher, skipFresh)
    await vi.waitFor(() => expect(calls).toBe(1))

    // Simulate another tab: it has no access to this module's in-memory
    // single-flight map, but it does contend on the same Web Lock/fallback lock.
    __resetPrivacyInFlightForTests()
    const second = dedupedPrivacyFetch(profileId, modelId, fetcher, skipFresh)

    gate.resolve({ policies: { Azure: { training: false } }, fetchedAt: Date.now() })
    await Promise.all([first, second])

    expect(calls).toBe(1)
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
