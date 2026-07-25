import { expect, type Page, test } from './fixtures'
import { activeWorkspaceDatabaseName, clearIndexedDb } from './helpers'

test.beforeEach(async ({ page }) => {
  await clearIndexedDb(page)
})

test.afterEach(async ({ page }) => {
  await clearIndexedDb(page)
})

test('startup opens the committed source while a live replacement owns selection', async ({
  context,
  page,
}) => {
  const replacement = await page.evaluate(async () => {
    let releaseSelectionGate!: () => void
    const held = new Promise<void>((resolve) => {
      releaseSelectionGate = resolve
    })
    let markSelectionGateAcquired!: () => void
    const selectionGateAcquired = new Promise<void>((resolve) => {
      markSelectionGateAcquired = resolve
    })
    const lock = navigator.locks.request(
      'natter:workspace-slot-selection:v1',
      { mode: 'exclusive' },
      async () => {
        markSelectionGateAcquired()
        await held
      },
    )
    ;(
      globalThis as typeof globalThis & {
        __releaseStartupRecoverySelectionGate?: () => void
        __startupRecoverySelectionGate?: Promise<void>
      }
    ).__releaseStartupRecoverySelectionGate = releaseSelectionGate
    ;(
      globalThis as typeof globalThis & {
        __startupRecoverySelectionGate?: Promise<void>
      }
    ).__startupRecoverySelectionGate = lock
    await selectionGateAcquired

    const control = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('natter-control')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    let sourceDatabaseName: string
    let destinationDatabaseName: string
    try {
      const manifest = await new Promise<{
        activeDatabaseName: string
        activationSequence: number
      }>((resolve, reject) => {
        const transaction = control.transaction('manifests', 'readonly')
        const request = transaction.objectStore('manifests').get('workspace')
        request.onsuccess = () => {
          const result: unknown = request.result
          resolve(result as { activeDatabaseName: string; activationSequence: number })
        }
        request.onerror = () => reject(request.error)
      })
      sourceDatabaseName = manifest.activeDatabaseName
      const slots = ['natter', 'natter-workspace-a', 'natter-workspace-b']
      destinationDatabaseName = slots[
        (slots.indexOf(sourceDatabaseName) + 1) % slots.length
      ] as string
      await new Promise<void>((resolve, reject) => {
        const transaction = control.transaction('manifests', 'readwrite')
        transaction.objectStore('manifests').put({
          ...manifest,
          id: 'workspace',
          pending: {
            nonce: crypto.randomUUID(),
            phase: 'preparing',
            sourceDatabaseName,
            destinationDatabaseName,
          },
        })
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error)
        transaction.onabort = () => reject(transaction.error)
      })
    } finally {
      control.close()
    }
    const destination = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(destinationDatabaseName)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    destination.close()
    return { sourceDatabaseName, destinationDatabaseName }
  })
  const openingPage = await context.newPage()
  try {
    await openingPage.goto('/')
    await expect(openingPage.locator('[data-ui="app-shell"]')).toBeVisible()
    await expect(openingPage.locator('[data-ui="workspace-bootstrap"]')).toHaveCount(0)
    await expect
      .poll(() => activeWorkspaceDatabaseName(openingPage))
      .toBe(replacement.sourceDatabaseName)
    await expect
      .poll(() =>
        openingPage.evaluate(async () => {
          const query = await navigator.locks.query()
          return query.held?.some(
            (lock) =>
              lock.name === 'natter:workspace-slot-selection:v1' && lock.mode === 'exclusive',
          )
        }),
      )
      .toBe(true)

    await page.evaluate(() => {
      const release = (
        globalThis as typeof globalThis & {
          __releaseStartupRecoverySelectionGate?: () => void
        }
      ).__releaseStartupRecoverySelectionGate
      if (!release) throw new Error('StartupRecoverySelectionGateReleaseMissing')
      release()
    })

    await expect
      .poll(() =>
        openingPage.evaluate(async ({ destinationDatabaseName }) => {
          const manifest = await new Promise<{
            pending?: unknown
          }>((resolve, reject) => {
            const request = indexedDB.open('natter-control')
            request.onsuccess = () => {
              const control = request.result
              const transaction = control.transaction('manifests', 'readonly')
              const read = transaction.objectStore('manifests').get('workspace')
              read.onsuccess = () => {
                const result: unknown = read.result
                control.close()
                resolve(result as { pending?: unknown })
              }
              read.onerror = () => {
                control.close()
                reject(read.error)
              }
            }
            request.onerror = () => reject(request.error)
          })
          return {
            pending: manifest.pending !== undefined,
            databases: (await indexedDB.databases()).flatMap((database) =>
              database.name === undefined ? [] : [database.name],
            ),
            destinationDatabaseName,
          }
        }, replacement),
      )
      .toMatchObject({
        pending: false,
        databases: expect.not.arrayContaining([replacement.destinationDatabaseName]),
      })
  } finally {
    await page.evaluate(() => {
      ;(
        globalThis as typeof globalThis & {
          __releaseStartupRecoverySelectionGate?: () => void
        }
      ).__releaseStartupRecoverySelectionGate?.()
    })
    await openingPage.close()
  }
})

test('an observed intermediate v94 workspace upgrades once and opens in Chromium', async ({
  page,
}) => {
  const databaseName = await activeWorkspaceDatabaseName(page)
  const schema = await readDatabaseSchema(page, databaseName)
  const resetRoute = '**/__startup-v94-reset__'
  await page.route(resetRoute, (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Reset</title>' }),
  )
  await page.goto('/__startup-v94-reset__')
  await page.evaluate(
    async ({ databaseName, schema }) => {
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(databaseName)
        request.onsuccess = () => resolve()
        request.onerror = () => reject(request.error)
        request.onblocked = () => reject(new Error('IntermediateV94DeleteBlocked'))
      })
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(databaseName, 940)
        request.onupgradeneeded = () => {
          for (const definition of schema) {
            const store = request.result.createObjectStore(definition.name, {
              keyPath: definition.keyPath,
              autoIncrement: definition.autoIncrement,
            })
            for (const index of definition.indexes) {
              store.createIndex(index.name, index.keyPath, {
                unique: index.unique,
                multiEntry: index.multiEntry,
              })
            }
          }
        }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      try {
        await new Promise<void>((resolve, reject) => {
          const transaction = database.transaction('settings', 'readwrite')
          transaction.objectStore('settings').put({
            key: 'manifest-proof:chromium-v94',
            value: 'preserved',
          })
          transaction.oncomplete = () => resolve()
          transaction.onerror = () => reject(transaction.error)
          transaction.onabort = () => reject(transaction.error)
        })
      } finally {
        database.close()
      }
    },
    { databaseName, schema },
  )
  await page.unroute(resetRoute)

  await page.goto('/')
  await expect(page.locator('[data-ui="workspace-bootstrap"]')).toHaveCount(0)
  await expect(page.locator('[data-ui="app-shell"]')).toBeVisible()
  await expect
    .poll(() =>
      page.evaluate(async (databaseName) => {
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open(databaseName)
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })
        try {
          const sentinel = await new Promise<unknown>((resolve, reject) => {
            const request = database
              .transaction('settings', 'readonly')
              .objectStore('settings')
              .get('manifest-proof:chromium-v94')
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error)
          })
          return { version: database.version, sentinel }
        } finally {
          database.close()
        }
      }, databaseName),
    )
    .toEqual({
      version: 950,
      sentinel: {
        key: 'manifest-proof:chromium-v94',
        value: 'preserved',
      },
    })
})

test('a poisoned local database shows recovery instead of a blank root', async ({
  expectRuntimeDiagnostic,
  page,
}) => {
  expectRuntimeDiagnostic({
    category: 'console-other',
    source: 'console',
    level: 'error',
    message:
      '^Failed to inspect workspace backend for persistence request Error: WaveAMessageBodyMissing:message-poison',
    count: 1,
  })
  const databaseName = await activeWorkspaceDatabaseName(page)
  const schema = await page.evaluate(async (databaseName) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      const names = Array.from(db.objectStoreNames)
      const transaction = db.transaction(names, 'readonly')
      const definitions = names.map((name) => {
        const store = transaction.objectStore(name)
        return {
          name,
          keyPath: store.keyPath,
          autoIncrement: store.autoIncrement,
          indexes: Array.from(store.indexNames).map((indexName) => {
            const index = store.index(indexName)
            return {
              name: index.name,
              keyPath: index.keyPath,
              unique: index.unique,
              multiEntry: index.multiEntry,
            }
          }),
        }
      })
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error)
        transaction.onabort = () => reject(transaction.error)
      })
      return definitions
    } finally {
      db.close()
    }
  }, databaseName)

  const resetRoute = '**/__startup-recovery-reset__'
  await page.route(resetRoute, (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Reset</title>' }),
  )
  await page.goto('/__startup-recovery-reset__')
  await page.evaluate(
    async ({ databaseName, schema }) => {
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(databaseName)
        request.onsuccess = () => resolve()
        request.onerror = () => reject(request.error)
        request.onblocked = () => reject(new Error('StartupRecoveryDeleteBlocked'))
      })
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(databaseName, 250)
        request.onupgradeneeded = () => {
          for (const definition of schema) {
            const store = request.result.createObjectStore(definition.name, {
              keyPath: definition.keyPath,
              autoIncrement: definition.autoIncrement,
            })
            for (const index of definition.indexes) {
              store.createIndex(index.name, index.keyPath, {
                unique: index.unique,
                multiEntry: index.multiEntry,
              })
            }
          }
        }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      try {
        await new Promise<void>((resolve, reject) => {
          const transaction = db.transaction('messages', 'readwrite')
          transaction.objectStore('messages').put({
            id: 'message-poison',
            chatId: 'chat-poison',
            bodyVersion: 0,
            nodeVersion: 0,
            requestContextVersion: 0,
          })
          transaction.oncomplete = () => resolve()
          transaction.onerror = () => reject(transaction.error)
          transaction.onabort = () => reject(transaction.error)
        })
      } finally {
        db.close()
      }
    },
    { databaseName, schema },
  )
  await page.unroute(resetRoute)
  await page.goto('/')
  const recovery = page.locator('[data-ui="workspace-bootstrap"]')
  await expect(recovery).toHaveAttribute('data-state', 'failed')
  await expect(recovery.getByRole('heading')).toHaveText(
    'Natter could not open the local workspace',
  )
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Reload' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Copy diagnostics' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Reset local data' })).toBeHidden()
})

function readDatabaseSchema(page: Page, databaseName: string) {
  return page.evaluate(async (databaseName) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      const names = Array.from(database.objectStoreNames)
      const transaction = database.transaction(names, 'readonly')
      return names.map((name) => {
        const store = transaction.objectStore(name)
        return {
          name,
          keyPath: store.keyPath,
          autoIncrement: store.autoIncrement,
          indexes: Array.from(store.indexNames).map((indexName) => {
            const index = store.index(indexName)
            return {
              name: index.name,
              keyPath: index.keyPath,
              unique: index.unique,
              multiEntry: index.multiEntry,
            }
          }),
        }
      })
    } finally {
      database.close()
    }
  }, databaseName)
}
