// In-memory single-flight for the privacy scrape. See
// `src/store/privacy-cache.ts::dedupedPrivacyFetch`. Two mount points
// (e.g. header lock + provider picker) sharing a (profileId, modelId)
// must not fire two scrapes.

import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import { __resetDbForTests, openDb } from '../../src/store/db'
import {
  __resetPrivacyInFlightForTests,
  dedupedPrivacyFetch,
  getCachedPrivacyPolicy,
} from '../../src/store/privacy-cache'

const DB_NAME = 'natter'

async function resetAll() {
  __resetDbForTests()
  __resetBroadcastForTests()
  __resetPrivacyInFlightForTests()
  await Dexie.delete(DB_NAME)
}

beforeEach(async () => {
  await resetAll()
  await openDb()
})

afterEach(async () => {
  await resetAll()
})

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
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

  it('shares the in-flight Promise across concurrent callers', async () => {
    let calls = 0
    const gate = deferred<{ policies: Record<string, unknown>; fetchedAt: number }>()
    const fetcher = async () => {
      calls += 1
      return gate.promise
    }
    const a = dedupedPrivacyFetch(profileId, modelId, fetcher)
    const b = dedupedPrivacyFetch(profileId, modelId, fetcher)
    expect(calls).toBe(1)
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
    await expect(
      dedupedPrivacyFetch(profileId, modelId, fetcher),
    ).rejects.toThrow('boom')
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
})
