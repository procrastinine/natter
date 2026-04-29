// Debug helper: wipe every browser-side store this app touches and hard-reload.
// Attach to `window.__nuke` so the console can call `__nuke()` to reset state
// without futzing with DevTools' Application tab. Dev-mode only — see
// `src/main.tsx`.
//
// Wipes (this origin only):
//   - IndexedDB databases
//   - localStorage / sessionStorage
//   - cookies (best-effort; HttpOnly cookies survive)
//   - Cache Storage (Cache API)
//   - Service workers
//
// After all stores resolve, `location.reload()` is called. Errors are caught
// and logged so one failing store doesn't block the rest.

interface NukeOptions {
  /** Skip the reload at the end. Useful when chaining debug commands. */
  skipReload?: boolean
}

async function nukeSiteStorage(opts: NukeOptions = {}): Promise<void> {
  const tasks: Array<Promise<unknown>> = []

  // IndexedDB — enumerate via the modern API, fall back to the known db name.
  tasks.push(
    (async () => {
      try {
        const dbs = (await indexedDB.databases?.()) ?? []
        await Promise.all(
          dbs.map((db) =>
            db.name
              ? new Promise<void>((resolve) => {
                  const req = indexedDB.deleteDatabase(db.name as string)
                  req.onsuccess = () => resolve()
                  req.onerror = () => resolve()
                  req.onblocked = () => resolve()
                })
              : Promise.resolve(),
          ),
        )
        // Belt-and-braces: explicitly nuke the natter db in case enumeration
        // returned an empty list (Safari < 17 lacks indexedDB.databases()).
        await new Promise<void>((resolve) => {
          const req = indexedDB.deleteDatabase('natter')
          req.onsuccess = () => resolve()
          req.onerror = () => resolve()
          req.onblocked = () => resolve()
        })
      } catch (err) {
        console.warn('[nuke] IndexedDB wipe failed', err)
      }
    })(),
  )

  // localStorage + sessionStorage.
  tasks.push(
    Promise.resolve().then(() => {
      try {
        localStorage.clear()
      } catch (err) {
        console.warn('[nuke] localStorage clear failed', err)
      }
      try {
        sessionStorage.clear()
      } catch (err) {
        console.warn('[nuke] sessionStorage clear failed', err)
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
              // biome-ignore lint/suspicious/noDocumentCookie: Dev-only nuke has to expire legacy JS-visible cookies across path/domain variants.
              document.cookie = `${name}=; path=${path}${domainAttr}; expires=Thu, 01 Jan 1970 00:00:00 GMT`
            }
          }
        }
      } catch (err) {
        console.warn('[nuke] cookie clear failed', err)
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
        console.warn('[nuke] CacheStorage wipe failed', err)
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
        console.warn('[nuke] service-worker unregister failed', err)
      }
    })(),
  )

  await Promise.all(tasks)
  if (opts.skipReload) return
  location.reload()
}

export function installDebugNuke(): void {
  if (typeof window === 'undefined') return
  ;(window as unknown as { __nuke: typeof nukeSiteStorage }).__nuke = nukeSiteStorage
  // Friendly hint in the console — fires once on first load.

  console.info(
    '%c[debug] window.__nuke() — wipe IDB / storage / cookies / cache and reload.',
    'color:#888;font-style:italic',
  )
}
