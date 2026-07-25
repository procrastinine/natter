import Dexie from 'dexie'
import { IDBFactory } from 'fake-indexeddb'
import { NATTER_INDEXED_DATABASE_NAMES } from '../../src/lib/origin-storage-names'

export function installFreshFakeIndexedDbForTests(): IDBFactory {
  const indexedDB = new IDBFactory()
  globalThis.indexedDB = indexedDB
  Dexie.dependencies.indexedDB = indexedDB
  return indexedDB
}

export async function deleteNatterIndexedDatabasesForTests(): Promise<void> {
  for (const name of NATTER_INDEXED_DATABASE_NAMES) await Dexie.delete(name)
}
