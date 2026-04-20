import { renderHook, waitFor } from '@testing-library/react'
import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useModels } from '../../src/hooks/useModels'
import { newId } from '../../src/lib/ulid'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import { __resetDbForTests, openDb } from '../../src/store/db'
import { __resetKeyCacheForTests } from '../../src/store/keys'
import { getCachedModels, putCachedModels } from '../../src/store/models-cache'
import { createProfile } from '../../src/store/profiles'

const DB_NAME = 'natter'

async function resetAll() {
  __resetBroadcastForTests()
  __resetKeyCacheForTests()
  __resetDbForTests()
  await Dexie.delete(DB_NAME)
}

beforeEach(async () => {
  ;(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory()
  await resetAll()
  await openDb()
})

afterEach(async () => {
  vi.restoreAllMocks()
  await resetAll()
})

describe('useModels (llama-server)', () => {
  it('drops stale cached models when the local server refresh fails', async () => {
    const profile = await createProfile({
      name: 'llama-server',
      kind: 'llama-server',
      baseUrl: 'http://127.0.0.1:8080/v1',
      apiKeyRef: newId(),
    })
    await putCachedModels(
      profile.id,
      {},
      {
        data: [{ id: 'local/gemma-3-12b' }],
      },
      0,
    )
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'))
    const { result } = renderHook(() => useModels(profile.id))
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled()
    })
    await waitFor(() => {
      expect(result.current.models).toEqual([])
    })
    const cached = await getCachedModels(profile.id, {})
    expect(cached).toBeUndefined()
  })
})
