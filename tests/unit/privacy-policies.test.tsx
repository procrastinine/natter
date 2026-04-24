import { renderHook, waitFor } from '@testing-library/react'
import Dexie from 'dexie'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchPrivacyScrape } from '../../src/api/privacy-scrape'
import { usePrivacyPolicies } from '../../src/hooks/usePrivacyPolicies'
import { newId } from '../../src/lib/ulid'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import { __resetDbForTests, openDb } from '../../src/store/db'
import {
  __resetPrivacyInFlightForTests,
  EMPTY_PRIVACY_POLICY_RETRY_MS,
  putCachedPrivacyPolicy,
} from '../../src/store/privacy-cache'
import { createProfile } from '../../src/store/profiles'

vi.mock('../../src/api/privacy-scrape', async () => {
  const actual = await vi.importActual<typeof import('../../src/api/privacy-scrape')>(
    '../../src/api/privacy-scrape',
  )
  return { ...actual, fetchPrivacyScrape: vi.fn() }
})

const fetchPrivacyScrapeMock = vi.mocked(fetchPrivacyScrape)
const DB_NAME = 'natter'

async function resetAll() {
  __resetBroadcastForTests()
  __resetDbForTests()
  __resetPrivacyInFlightForTests()
  await Dexie.delete(DB_NAME)
}

beforeEach(async () => {
  ;(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory()
  vi.clearAllMocks()
  await resetAll()
  await openDb()
})

afterEach(async () => {
  vi.restoreAllMocks()
  await resetAll()
})

describe('usePrivacyPolicies', () => {
  it('automatically refreshes empty cached policy rows instead of requiring manual reload', async () => {
    const profile = await createProfile({
      name: 'OpenRouter',
      kind: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKeyRef: newId(),
    })
    const modelId = 'deepseek/deepseek-v4-flash'
    await putCachedPrivacyPolicy(
      profile.id,
      modelId,
      { policies: {}, fetchedAt: Date.now() - EMPTY_PRIVACY_POLICY_RETRY_MS - 1 },
      Date.now() - EMPTY_PRIVACY_POLICY_RETRY_MS - 1,
    )
    fetchPrivacyScrapeMock.mockResolvedValueOnce({
      modelId,
      policies: {},
      raw: {
        policies: {
          'deepinfra/fp4': {
            training: false,
            trainingOpenRouter: false,
            retainsPrompts: false,
            canPublish: false,
            termsOfServiceURL: '',
            privacyPolicyURL: '',
          },
        },
        fetchedAt: Date.now(),
      },
      fetchedAt: Date.now(),
    })

    const { result } = renderHook(() => usePrivacyPolicies(profile.id, modelId))

    await waitFor(() => expect(fetchPrivacyScrapeMock).toHaveBeenCalledTimes(1))
    await waitFor(() => {
      expect(result.current.policies['deepinfra/fp4']?.retainsPrompts).toBe(false)
    })
    expect(result.current.loading).toBe(false)
  })
})
