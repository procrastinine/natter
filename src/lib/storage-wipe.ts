import { browserLocalStorage, browserSessionStorage } from './browser-storage'
import { NATTER_INDEXED_DATABASE_NAMES } from './origin-storage-names'

export interface OriginStorageWipeReport {
  readonly deletedDatabaseNames: readonly string[]
  readonly deletedCacheNames: readonly string[]
  readonly deletedOpfsEntryNames: readonly string[]
  readonly deletedStorageBucketNames: readonly string[]
  readonly unregisteredServiceWorkerScopes: readonly string[]
}

interface OriginDirectoryHandle {
  entries(): AsyncIterableIterator<[string, unknown]>
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>
}

interface OriginStorageBucketManager {
  keys(): Promise<readonly string[]>
  delete(name: string): Promise<void>
}

export async function wipeOriginStorage(): Promise<OriginStorageWipeReport> {
  const serviceWorkerResult = await settle(unregisterAndVerifyOriginServiceWorkers())
  const [databaseResult, cacheResult, opfsResult, storageBucketResult] = await Promise.allSettled([
    deleteOriginIndexedDatabases(),
    deleteAndVerifyOriginCaches(),
    deleteAndVerifyOriginPrivateFileSystem(),
    deleteAndVerifyOriginStorageBuckets(),
  ])
  const synchronousFailures: Error[] = []
  for (const operation of [
    () =>
      clearAndVerifyWebStorage(
        requiredWebStorage(browserLocalStorage(), 'localStorage'),
        'localStorage',
      ),
    () =>
      clearAndVerifyWebStorage(
        requiredWebStorage(browserSessionStorage(), 'sessionStorage'),
        'sessionStorage',
      ),
    clearAndVerifyVisibleCookies,
  ]) {
    try {
      operation()
    } catch (error) {
      synchronousFailures.push(storageWipeError(error))
    }
  }
  const failures = [
    serviceWorkerResult,
    databaseResult,
    cacheResult,
    opfsResult,
    storageBucketResult,
  ].flatMap((result) => (result.status === 'rejected' ? [storageWipeError(result.reason)] : []))
  failures.push(...synchronousFailures)
  const [singleFailure] = failures
  if (singleFailure && failures.length === 1) throw singleFailure
  if (failures.length > 1) throw new AggregateError(failures, 'OriginStorageWipeFailed')
  return {
    deletedDatabaseNames: settledValue(databaseResult),
    deletedCacheNames: settledValue(cacheResult),
    deletedOpfsEntryNames: settledValue(opfsResult),
    deletedStorageBucketNames: settledValue(storageBucketResult),
    unregisteredServiceWorkerScopes: settledValue(serviceWorkerResult),
  }
}

export function clearAndVerifySessionStorage(): void {
  clearAndVerifyWebStorage(
    requiredWebStorage(browserSessionStorage(), 'sessionStorage'),
    'sessionStorage',
  )
}

async function deleteOriginIndexedDatabases(): Promise<readonly string[]> {
  const deleted = new Set<string>()
  const canEnumerate = typeof indexedDB.databases === 'function'
  const names = new Set<string>(NATTER_INDEXED_DATABASE_NAMES)
  if (canEnumerate) {
    for (const database of await indexedDB.databases()) {
      if (database.name) names.add(database.name)
    }
  }
  const sortedNames = [...names].sort()
  const deletions = await Promise.allSettled(
    sortedNames.map(async (name) => {
      await deleteIndexedDb(name)
      deleted.add(name)
    }),
  )
  const failures = rejectedReasons(deletions)
  if (!canEnumerate) {
    throwStorageFailures(failures, 'IndexedDBDeleteFailed')
    return [...deleted].sort()
  }
  const remaining = (await indexedDB.databases())
    .flatMap((database) => (database.name ? [database.name] : []))
    .sort()
  if (remaining.length > 0) {
    failures.push(new Error(`IndexedDBDeleteOwnershipInvariantViolated:${remaining.join(',')}`))
  }
  throwStorageFailures(failures, 'IndexedDBDeleteFailed')
  return [...deleted].sort()
}

function deleteIndexedDb(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name)
    let settled = false
    const resolveOnce = () => {
      if (settled) return
      settled = true
      resolve()
    }
    const rejectOnce = (error: unknown) => {
      if (settled) return
      settled = true
      reject(storageWipeError(error))
    }
    request.onsuccess = () => {
      resolveOnce()
    }
    request.onerror = () => {
      rejectOnce(request.error ?? new Error(`IndexedDBDeleteFailed:${name}`))
    }
    request.onblocked = () => rejectOnce(new Error(`IndexedDBDeleteBlocked:${name}`))
  })
}

async function deleteAndVerifyOriginCaches(): Promise<readonly string[]> {
  if (typeof caches === 'undefined') return []
  const names = await caches.keys()
  const deletions = await Promise.allSettled(
    names.map(async (name) => {
      if (!(await caches.delete(name))) throw new Error(`CacheStorageDeleteFailed:${name}`)
    }),
  )
  const failures = rejectedReasons(deletions)
  const remaining = await caches.keys()
  if (remaining.length > 0) {
    failures.push(new Error(`CacheStorageDeleteVerificationFailed:${remaining.sort().join(',')}`))
  }
  throwStorageFailures(failures, 'CacheStorageDeleteFailed')
  return [...names].sort()
}

async function deleteAndVerifyOriginPrivateFileSystem(): Promise<readonly string[]> {
  const storage = navigator.storage as unknown as
    | {
        getDirectory?: () => Promise<OriginDirectoryHandle>
      }
    | undefined
  if (!storage) return []
  if (typeof storage.getDirectory !== 'function') return []
  const root = await storage.getDirectory()
  const names = await listOriginDirectoryEntries(root)
  const deletions = await Promise.allSettled(
    names.map((name) => root.removeEntry(name, { recursive: true })),
  )
  const failures = rejectedReasons(deletions)
  const remaining = await listOriginDirectoryEntries(root)
  if (remaining.length > 0) {
    failures.push(
      new Error(`OriginPrivateFileSystemDeleteVerificationFailed:${remaining.join(',')}`),
    )
  }
  throwStorageFailures(failures, 'OriginPrivateFileSystemDeleteFailed')
  return names
}

async function listOriginDirectoryEntries(root: OriginDirectoryHandle): Promise<readonly string[]> {
  const names: string[] = []
  for await (const [name] of root.entries()) names.push(name)
  return names.sort()
}

async function deleteAndVerifyOriginStorageBuckets(): Promise<readonly string[]> {
  const manager = (
    navigator as Navigator & { readonly storageBuckets?: Partial<OriginStorageBucketManager> }
  ).storageBuckets
  if (manager === undefined) return []
  if (typeof manager.keys !== 'function' || typeof manager.delete !== 'function') {
    throw new Error('StorageBucketApiIncomplete')
  }
  const deleteBucket = manager.delete.bind(manager)
  const names = [...(await manager.keys())].sort()
  const deletions = await Promise.allSettled(names.map((name) => deleteBucket(name)))
  const failures = rejectedReasons(deletions)
  const remaining = [...(await manager.keys())].sort()
  if (remaining.length > 0) {
    failures.push(new Error(`StorageBucketDeleteVerificationFailed:${remaining.join(',')}`))
  }
  throwStorageFailures(failures, 'StorageBucketDeleteFailed')
  return names
}

async function unregisterAndVerifyOriginServiceWorkers(): Promise<readonly string[]> {
  if (!('serviceWorker' in navigator)) return []
  const registrations = await navigator.serviceWorker.getRegistrations()
  const unregistrations = await Promise.allSettled(
    registrations.map(async (registration) => {
      if (!(await registration.unregister())) {
        throw new Error(`ServiceWorkerUnregisterFailed:${registration.scope}`)
      }
    }),
  )
  const failures = rejectedReasons(unregistrations)
  const remaining = await navigator.serviceWorker.getRegistrations()
  if (remaining.length > 0) {
    failures.push(
      new Error(
        `ServiceWorkerUnregisterVerificationFailed:${remaining
          .map((registration) => registration.scope)
          .sort()
          .join(',')}`,
      ),
    )
  }
  throwStorageFailures(failures, 'ServiceWorkerUnregisterFailed')
  return registrations.map((registration) => registration.scope).sort()
}

function clearAndVerifyWebStorage(storage: Storage, label: string): void {
  storage.clear()
  if (storage.length !== 0) throw new Error(`${label}ClearVerificationFailed:${storage.length}`)
}

function requiredWebStorage(storage: Storage | undefined, label: string): Storage {
  if (!storage) throw new Error(`${label}Unavailable`)
  return storage
}

function clearAndVerifyVisibleCookies(): void {
  const host = location.hostname
  const paths = cookiePathCandidates(location.pathname)
  for (const name of visibleCookieNames()) {
    for (const path of paths) {
      for (const domain of [host, `.${host}`, '']) {
        const domainAttr = domain ? `; domain=${domain}` : ''
        // biome-ignore lint/suspicious/noDocumentCookie: Expiring JS-visible origin cookies is the only browser API available here.
        document.cookie = `${name}=; path=${path}${domainAttr}; expires=Thu, 01 Jan 1970 00:00:00 GMT`
      }
    }
  }
  const remaining = visibleCookieNames()
  if (remaining.length > 0) {
    throw new Error(`CookieDeleteVerificationFailed:${remaining.sort().join(',')}`)
  }
}

function visibleCookieNames(): string[] {
  return document.cookie.split(';').flatMap((raw) => {
    const name = raw.split('=')[0]?.trim()
    return name ? [name] : []
  })
}

function cookiePathCandidates(pathname: string): readonly string[] {
  const paths = new Set<string>(['/'])
  const segments = pathname.split('/').filter(Boolean)
  let path = ''
  for (const segment of segments) {
    path += `/${segment}`
    paths.add(path)
    paths.add(`${path}/`)
  }
  return [...paths]
}

async function settle<T>(operation: Promise<T>): Promise<PromiseSettledResult<T>> {
  try {
    return { status: 'fulfilled', value: await operation }
  } catch (reason) {
    return { status: 'rejected', reason }
  }
}

function settledValue<T>(result: PromiseSettledResult<T>): T {
  if (result.status === 'rejected') throw storageWipeError(result.reason)
  return result.value
}

function rejectedReasons(results: readonly PromiseSettledResult<unknown>[]): Error[] {
  return results.flatMap((result) =>
    result.status === 'rejected' ? [storageWipeError(result.reason)] : [],
  )
}

function throwStorageFailures(failures: readonly Error[], label: string): void {
  if (failures.length === 0) return
  const [singleFailure] = failures
  if (singleFailure && failures.length === 1) throw singleFailure
  throw new Error(`${label}:${failures.map(storageFailureCode).join(',')}`, {
    cause: new AggregateError(failures, label),
  })
}

function storageWipeError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error('OriginStorageWipeFailed', { cause: reason })
}

function storageFailureCode(error: unknown): string {
  if (!(error instanceof Error)) return 'UnknownError'
  return error.message.replace(/[^a-zA-Z0-9:._-]/gu, '').slice(0, 160) || error.name
}
