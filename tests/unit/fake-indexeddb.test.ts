import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, describe, expect, it } from 'vitest'
import { installFreshFakeIndexedDbForTests } from '../helpers/fake-indexeddb'

describe('fake IndexedDB test isolation', () => {
  const originalGlobalIndexedDb = globalThis.indexedDB
  const originalDexieIndexedDb = Dexie.dependencies.indexedDB

  afterEach(() => {
    globalThis.indexedDB = originalGlobalIndexedDb
    Dexie.dependencies.indexedDB = originalDexieIndexedDb
  })

  it('replaces the IndexedDB factory used by both globals and new Dexie instances', () => {
    const replacement = installFreshFakeIndexedDbForTests()

    expect(globalThis.indexedDB).toBe(replacement)
    expect(Dexie.dependencies.indexedDB).toBe(replacement)
    expect(new Dexie('fake-indexeddb-isolation').backendDB()).toBeNull()
  })
})
