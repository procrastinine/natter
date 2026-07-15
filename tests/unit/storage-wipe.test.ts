import Dexie from 'dexie'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { wipeSiteStorage } from '../../src/lib/storage-wipe'
import { __resetDbForTests, getDb, openDb } from '../../src/store/db'

const DB_NAME = 'natter'

async function openRawDb(name: string): Promise<IDBDatabase> {
  const req = indexedDB.open(name)
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function resetAll() {
  __resetDbForTests()
  await Dexie.delete(DB_NAME)
}

describe('wipeSiteStorage', () => {
  beforeEach(async () => {
    ;(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory()
    localStorage.clear()
    sessionStorage.clear()
    await resetAll()
  })

  afterEach(async () => {
    await resetAll()
  })

  it('closes the app database before deleting IndexedDB', async () => {
    await openDb()
    await getDb().settings.put({ key: 'probe', value: { ok: true } })
    expect(await getDb().settings.count()).toBeGreaterThan(0)

    await wipeSiteStorage({ skipReload: true })

    const db = await openRawDb(DB_NAME)
    expect(Array.from(db.objectStoreNames)).toEqual([])
    db.close()
  })
})
