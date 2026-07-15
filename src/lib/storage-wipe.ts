// Local wipe helper: clears every browser-side store this app touches and
// hard-reloads. Production reaches it through the storage UI; development also
// installs the console shortcut from `tools/browser-devtools.ts`.
//
// Wipes (this origin only):
//   - IndexedDB databases
//   - localStorage / sessionStorage
//   - cookies (best-effort; HttpOnly cookies survive)
//   - Cache Storage (Cache API)
//   - Service workers
//
// After all stores resolve, `location.reload()` is called. IndexedDB deletion
// failures are fatal because reloading after a blocked delete leaves data
// behind; noncritical stores log and keep going.

import { closeDb } from '../store/db'

interface StorageWipeOptions {
  /** Skip the reload when the caller is already recovering the workspace. */
  skipReload?: boolean
}

export async function wipeSiteStorage(opts: StorageWipeOptions = {}): Promise<void> {
  const tasks: Array<Promise<unknown>> = []

  // IndexedDB — enumerate via the modern API, fall back to the known db name.
  tasks.push(
    (async () => {
      closeDb()
      const listDatabases = (
        indexedDB as unknown as {
          databases?: () => Promise<IDBDatabaseInfo[]>
        }
      ).databases
      const dbs = listDatabases ? await listDatabases.call(indexedDB) : []
      const names = new Set(dbs.flatMap((db) => (db.name ? [db.name] : [])))
      // Belt-and-braces: explicitly nuke the natter db in case enumeration
      // returned an empty list (Safari < 17 lacks indexedDB.databases()).
      names.add('natter')
      for (const name of names) await deleteIndexedDb(name)
    })(),
  )

  // localStorage + sessionStorage.
  tasks.push(
    Promise.resolve().then(() => {
      try {
        localStorage.clear()
      } catch (err) {
        console.warn('[storage-wipe] localStorage clear failed', err)
      }
      try {
        sessionStorage.clear()
      } catch (err) {
        console.warn('[storage-wipe] sessionStorage clear failed', err)
      }
    }),
  )

  // Cookies — JS-visible only.
  tasks.push(
    Promise.resolve().then(() => {
      try {
        const host = location.hostname
        for (const raw of document.cookie.split(';')) {
          const name = raw.split('=')[0]?.trim()
          if (!name) continue
          // Hit a few common path / domain combos so most cookies clear.
          for (const path of ['/', location.pathname]) {
            for (const domain of [host, `.${host}`, '']) {
              const domainAttr = domain ? `; domain=${domain}` : ''
              // biome-ignore lint/suspicious/noDocumentCookie: Local data wipe has to expire legacy JS-visible cookies across path/domain variants.
              document.cookie = `${name}=; path=${path}${domainAttr}; expires=Thu, 01 Jan 1970 00:00:00 GMT`
            }
          }
        }
      } catch (err) {
        console.warn('[storage-wipe] cookie clear failed', err)
      }
    }),
  )

  // Cache Storage (Cache API).
  tasks.push(
    (async () => {
      try {
        if (typeof caches === 'undefined') return
        const keys = await caches.keys()
        await Promise.all(keys.map((k) => caches.delete(k)))
      } catch (err) {
        console.warn('[storage-wipe] CacheStorage wipe failed', err)
      }
    })(),
  )

  // Service workers.
  tasks.push(
    (async () => {
      try {
        if (!('serviceWorker' in navigator)) return
        const regs = await navigator.serviceWorker.getRegistrations()
        await Promise.all(regs.map((r) => r.unregister()))
      } catch (err) {
        console.warn('[storage-wipe] service-worker unregister failed', err)
      }
    })(),
  )

  await Promise.all(tasks)
  if (opts.skipReload) return
  location.reload()
}

function deleteIndexedDb(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name)
    const timeout = window.setTimeout(() => {
      reject(new Error(`IndexedDBDeleteBlocked:${name}`))
    }, 5000)
    req.onsuccess = () => {
      window.clearTimeout(timeout)
      resolve()
    }
    req.onerror = () => {
      window.clearTimeout(timeout)
      reject(req.error ?? new Error(`IndexedDBDeleteFailed:${name}`))
    }
    req.onblocked = () => {
      console.warn(
        `[storage-wipe] IndexedDB delete blocked for ${name}; close other tabs for this origin.`,
      )
    }
  })
}
