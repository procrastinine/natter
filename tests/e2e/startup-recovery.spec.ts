import { expect, type Page, test } from './fixtures'
import { activeWorkspaceDatabaseName, clearIndexedDb, waitForWorkspaceRunning } from './helpers'

const REGISTERED_UPGRADE_WATCHDOG_MS = 15_000

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
  await waitForWorkspaceRunning(page)
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

    const { sourceDatabaseName, destinationDatabaseName } =
      await globalThis.__natterNativeStorageFixture.control(
        { purpose: 'fault-injection' },
        async (control, request) => {
          const manifest = (await request(
            control.transaction('manifests', 'readonly').objectStore('manifests').get('workspace'),
          )) as {
            activeDatabaseName: string
            activationSequence: number
          }
          const sourceDatabaseName = manifest.activeDatabaseName
          const slots = ['natter', 'natter-workspace-a', 'natter-workspace-b']
          const destinationDatabaseName = slots[
            (slots.indexOf(sourceDatabaseName) + 1) % slots.length
          ] as string
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
          return { sourceDatabaseName, destinationDatabaseName }
        },
      )
    await globalThis.__natterNativeStorageFixture.offline(
      {
        purpose: 'fault-injection',
        databaseName: destinationDatabaseName,
        version: 1,
        upgrade: () => undefined,
      },
      () => undefined,
    )
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
      .poll(
        () =>
          openingPage.evaluate(async ({ destinationDatabaseName }) => {
            const manifest = await globalThis.__natterNativeStorageFixture.control(
              { purpose: 'read-only-assertion' },
              (database, request) =>
                request(
                  database.transaction('manifests').objectStore('manifests').get('workspace'),
                ) as Promise<{ pending?: unknown }>,
            )
            return {
              pending: manifest.pending !== undefined,
              databases: (await indexedDB.databases()).flatMap((database) =>
                database.name === undefined ? [] : [database.name],
              ),
              destinationDatabaseName,
            }
          }, replacement),
        { timeout: 15_000 },
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

test('many reloading tabs elect one bounded registered upgrade for a valid v97 workspace', async ({
  context,
  page,
}) => {
  await waitForWorkspaceRunning(page)
  const resetRoute = '**/__startup-v97-reset__'
  await page.route(resetRoute, (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Reset</title>' }),
  )
  await page.goto('/__startup-v97-reset__')
  const { databaseName, schema, rows } = await readOfflineWorkspaceSnapshot(page, true)
  await page.evaluate(
    async ({ databaseName, rows, schema }) => {
      await globalThis.__natterNativeStorageFixture.deleteOffline({
        databaseName: databaseName,
        purpose: 'legacy-fixture',
      })
      return globalThis.__natterNativeStorageFixture.offline(
        {
          purpose: 'legacy-fixture',
          databaseName: databaseName,
          version: 970,
          upgrade: (upgradeDatabase) => {
            for (const definition of schema) {
              const store = upgradeDatabase.createObjectStore(definition.name, {
                keyPath: definition.keyPath,
                autoIncrement: definition.autoIncrement,
              })
              const indexes =
                definition.name === 'chatSidebarAggregates'
                  ? definition.indexes.filter((index) => index.name === 'kind')
                  : definition.name === 'presets'
                    ? []
                    : definition.indexes
              for (const index of indexes) {
                store.createIndex(index.name, index.keyPath, {
                  unique: index.unique,
                  multiEntry: index.multiEntry,
                })
              }
            }
          },
        },
        async (database) => {
          const transaction = database.transaction(
            schema.map((definition) => definition.name),
            'readwrite',
          )
          for (const table of rows) {
            const store = transaction.objectStore(table.name)
            for (const row of table.rows) {
              if (
                table.name === 'settings' &&
                (row as { key?: unknown }).key === 'backfill:browser-workspace-current-v98'
              ) {
                continue
              }
              if (
                table.name === 'chatSidebarAggregates' &&
                (row as { id?: unknown }).id === 'workspace'
              ) {
                continue
              }
              store.put(row)
            }
          }
          transaction.objectStore('settings').put({
            key: 'backfill:browser-workspace-current-v97',
            value: {
              formatVersion: 3,
              storageVersion: 97,
              phase: 'canonical-and-derived-complete',
            },
          })
          transaction.objectStore('settings').put({
            key: 'registered-upgrade-browser-proof',
            value: 'preserved',
          })
          transaction.objectStore('chatSidebarAggregates').put({
            id: 'workspace',
            kind: 'workspace',
            projectionVersion: 2,
            totalCount: 0,
            activeCount: 0,
            archivedCount: 0,
            pinnedCount: 0,
            visibleCount: 0,
            visiblePinnedCount: 0,
            rootCount: 0,
            rootVisibleCount: 0,
            rootVisiblePinnedCount: 0,
          })
          const folders = transaction.objectStore('folders')
          for (let index = 0; index < 300; index += 1) {
            folders.put({
              id: `folder-${index}`,
              name: `Folder ${index}`,
              sortIndex: index,
              createdAt: 1,
              updatedAt: 1,
              lastUsedAt: 1,
            })
          }
        },
      )
    },
    { databaseName, rows, schema },
  )
  await page.unroute(resetRoute)

  await context.addInitScript(() => {
    const forbidden: string[] = []
    const allowedUpgradeReadStores = new Set(['chatSidebarAggregates', 'folders', 'settings'])
    const noteStoreRead = (store: IDBObjectStore, operation: string) => {
      if (store.transaction.mode === 'versionchange' && !allowedUpgradeReadStores.has(store.name)) {
        forbidden.push(`${store.name}.${operation}`)
      }
    }
    const objectStoreGet = IDBObjectStore.prototype.get
    IDBObjectStore.prototype.get = function (...args) {
      noteStoreRead(this, 'get')
      return objectStoreGet.apply(this, args)
    }
    const objectStoreGetAll = IDBObjectStore.prototype.getAll
    IDBObjectStore.prototype.getAll = function (...args) {
      noteStoreRead(this, 'getAll')
      return objectStoreGetAll.apply(this, args)
    }
    const objectStoreCount = IDBObjectStore.prototype.count
    IDBObjectStore.prototype.count = function (...args) {
      noteStoreRead(this, 'count')
      return objectStoreCount.apply(this, args)
    }
    const objectStoreGetAllKeys = IDBObjectStore.prototype.getAllKeys
    IDBObjectStore.prototype.getAllKeys = function (...args) {
      noteStoreRead(this, 'getAllKeys')
      return objectStoreGetAllKeys.apply(this, args)
    }
    const objectStoreOpenCursor = IDBObjectStore.prototype.openCursor
    IDBObjectStore.prototype.openCursor = function (...args) {
      noteStoreRead(this, 'openCursor')
      return objectStoreOpenCursor.apply(this, args)
    }
    const objectStoreOpenKeyCursor = IDBObjectStore.prototype.openKeyCursor
    IDBObjectStore.prototype.openKeyCursor = function (...args) {
      noteStoreRead(this, 'openKeyCursor')
      return objectStoreOpenKeyCursor.apply(this, args)
    }
    const indexOpenCursor = IDBIndex.prototype.openCursor
    const indexGet = IDBIndex.prototype.get
    IDBIndex.prototype.get = function (...args) {
      noteStoreRead(this.objectStore, `${this.name}.get`)
      return indexGet.apply(this, args)
    }
    const indexGetAll = IDBIndex.prototype.getAll
    IDBIndex.prototype.getAll = function (...args) {
      noteStoreRead(this.objectStore, `${this.name}.getAll`)
      return indexGetAll.apply(this, args)
    }
    const indexCount = IDBIndex.prototype.count
    IDBIndex.prototype.count = function (...args) {
      noteStoreRead(this.objectStore, `${this.name}.count`)
      return indexCount.apply(this, args)
    }
    const indexGetAllKeys = IDBIndex.prototype.getAllKeys
    IDBIndex.prototype.getAllKeys = function (...args) {
      noteStoreRead(this.objectStore, `${this.name}.getAllKeys`)
      return indexGetAllKeys.apply(this, args)
    }
    IDBIndex.prototype.openCursor = function (...args) {
      noteStoreRead(this.objectStore, `${this.name}.openCursor`)
      return indexOpenCursor.apply(this, args)
    }
    const indexOpenKeyCursor = IDBIndex.prototype.openKeyCursor
    IDBIndex.prototype.openKeyCursor = function (...args) {
      noteStoreRead(this.objectStore, `${this.name}.openKeyCursor`)
      return indexOpenKeyCursor.apply(this, args)
    }
    ;(
      globalThis as typeof globalThis & {
        __registeredUpgradeForbiddenReads?: string[]
      }
    ).__registeredUpgradeForbiddenReads = forbidden
  })

  const pages = [page, ...(await Promise.all(Array.from({ length: 5 }, () => context.newPage())))]
  try {
    await Promise.all(pages.map((candidate) => candidate.goto('/')))
    const readinessStartedAt = performance.now()
    const readiness = await Promise.all(
      pages.map((candidate, index) =>
        observeWorkspaceRunning(candidate, index, readinessStartedAt),
      ),
    )
    expect(readiness.filter((observation) => observation.outcome !== 'running')).toEqual([])
    expect(Math.max(...readiness.map((observation) => observation.elapsedMs))).toBeLessThanOrEqual(
      REGISTERED_UPGRADE_WATCHDOG_MS,
    )
    await Promise.all(
      pages.map(async (candidate) => {
        await expect(candidate.locator('[data-ui="app-shell"]')).toBeVisible()
        await expect(candidate.locator('[data-ui="workspace-bootstrap"]')).toHaveCount(0)
        await expect.poll(() => activeWorkspaceDatabaseName(candidate)).toBe(databaseName)
      }),
    )
    const proof = await page.evaluate(
      async ({ databaseName }) => {
        return globalThis.__natterNativeStorageFixture.observeNamed(
          { purpose: 'read-only-assertion', databaseName: databaseName },
          async (database, request) => {
            const transaction = database.transaction('settings', 'readonly')
            const settings = transaction.objectStore('settings')
            const values = await Promise.all([
              request(settings.get('backfill:browser-workspace-current-v97')),
              request(settings.get('backfill:browser-workspace-current-v98')),
              request(settings.get('registered-upgrade-browser-proof')),
            ])
            return {
              version: database.version,
              values,
              databases: (await indexedDB.databases()).flatMap((entry) =>
                entry.name === undefined ? [] : [entry.name],
              ),
            }
          },
        )
      },
      { databaseName },
    )
    expect(proof).toMatchObject({
      version: 980,
      values: [
        undefined,
        {
          key: 'backfill:browser-workspace-current-v98',
          value: {
            formatVersion: 4,
            storageVersion: 98,
            phase: 'canonical-and-derived-complete',
          },
        },
        { key: 'registered-upgrade-browser-proof', value: 'preserved' },
      ],
      databases: expect.not.arrayContaining(['natter-workspace-a', 'natter-workspace-b']),
    })
    for (const candidate of pages) {
      expect(
        await candidate.evaluate(
          () =>
            (
              globalThis as typeof globalThis & {
                __registeredUpgradeForbiddenReads?: string[]
              }
            ).__registeredUpgradeForbiddenReads ?? [],
        ),
      ).toEqual([])
    }
  } finally {
    await Promise.all(pages.slice(1).map((candidate) => candidate.close()))
  }
})

async function observeWorkspaceRunning(
  page: Page,
  index: number,
  startedAt: number,
): Promise<
  | { index: number; outcome: 'running'; elapsedMs: number }
  | {
      index: number
      outcome: 'not-running'
      elapsedMs: number
      state: {
        runtime: string | null
        bootstrap: {
          state: string | null
          stage: string | null
          operation: string | null
        } | null
      }
      error: string
    }
> {
  try {
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-ui="app-shell"]')
          ?.getAttribute('data-workspace-runtime-state') === 'RUNNING',
      undefined,
      { timeout: REGISTERED_UPGRADE_WATCHDOG_MS },
    )
    return { index, outcome: 'running', elapsedMs: performance.now() - startedAt }
  } catch (error) {
    const state = await page.evaluate(() => {
      const shell = document.querySelector('[data-ui="app-shell"]')
      const bootstrap = document.querySelector('[data-ui="workspace-bootstrap"]')
      return {
        runtime: shell?.getAttribute('data-workspace-runtime-state') ?? null,
        bootstrap: bootstrap
          ? {
              state: bootstrap.getAttribute('data-state'),
              stage: bootstrap.getAttribute('data-open-stage'),
              operation: bootstrap.getAttribute('data-open-operation'),
            }
          : null,
      }
    })
    return {
      index,
      outcome: 'not-running',
      elapsedMs: performance.now() - startedAt,
      state,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

test('an observed intermediate v94 workspace repairs on an inactive slot across browser engines', async ({
  context,
  page,
}) => {
  await waitForWorkspaceRunning(page)
  const legacyRows = legacyRepairFixtureRows({})
  const resetRoute = '**/__startup-v94-reset__'
  await page.route(resetRoute, (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Reset</title>' }),
  )
  await page.goto('/__startup-v94-reset__')
  const { databaseName, schema } = await readOfflineWorkspaceSnapshot(page, false)
  expect(schema.length).toBeGreaterThan(0)
  await page.evaluate(
    async ({ databaseName, legacyRows, schema }) => {
      await globalThis.__natterNativeStorageFixture.deleteOffline({
        databaseName: databaseName,
        purpose: 'legacy-fixture',
      })
      return globalThis.__natterNativeStorageFixture.offline(
        {
          purpose: 'legacy-fixture',
          databaseName: databaseName,
          version: 940,
          upgrade: (upgradeDatabase) => {
            for (const definition of schema) {
              const store = upgradeDatabase.createObjectStore(definition.name, {
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
          },
        },
        async (database) => {
          const transaction = database.transaction(
            ['settings', 'folders', 'chats', 'messages', 'messageBodies', 'messagePreviews'],
            'readwrite',
          )
          transaction.objectStore('settings').put({
            key: 'manifest-proof:chromium-v94',
            value: 'preserved',
          })
          transaction.objectStore('folders').put(legacyRows.folder)
          transaction.objectStore('chats').put(legacyRows.chat)
          for (const header of legacyRows.headers) {
            transaction.objectStore('messages').put(header)
          }
          for (const body of legacyRows.bodies) {
            transaction.objectStore('messageBodies').put(body)
          }
          for (const preview of legacyRows.previews) {
            transaction.objectStore('messagePreviews').put(preview)
          }
        },
      )
    },
    { databaseName, legacyRows, schema },
  )
  await page.unroute(resetRoute)

  const competingPage = await context.newPage()
  try {
    await Promise.all([page.goto('/'), competingPage.goto('/')])
    await Promise.all([waitForWorkspaceRunning(page), waitForWorkspaceRunning(competingPage)])
    await expect(page.locator('[data-ui="workspace-bootstrap"]')).toHaveCount(0)
    await expect(competingPage.locator('[data-ui="workspace-bootstrap"]')).toHaveCount(0)
    await expect(page.locator('[data-ui="app-shell"]')).toBeVisible()
    await expect(competingPage.locator('[data-ui="app-shell"]')).toBeVisible()
    const repairedDatabaseName = await activeWorkspaceDatabaseName(page)
    expect(repairedDatabaseName).not.toBe(databaseName)
    await expect.poll(() => activeWorkspaceDatabaseName(competingPage)).toBe(repairedDatabaseName)
    await expect
      .poll(() =>
        page.evaluate(
          async ({ databaseName, repairedDatabaseName }) => {
            return globalThis.__natterNativeStorageFixture.observeNamed(
              { purpose: 'read-only-assertion', databaseName: repairedDatabaseName },
              async (database, request) => {
                const transaction = database.transaction(
                  ['settings', 'chats', 'chatSidebarAggregates'],
                  'readonly',
                )
                const repairedRows = await Promise.all([
                  request(transaction.objectStore('settings').get('manifest-proof:chromium-v94')),
                  request(transaction.objectStore('chats').get('legacy-repair-chat')),
                  request(transaction.objectStore('chatSidebarAggregates').get('workspace')),
                  request(
                    transaction
                      .objectStore('chatSidebarAggregates')
                      .get('folder:legacy-repair-folder'),
                  ),
                ])
                return {
                  version: database.version,
                  repairedRows,
                  databases: (await indexedDB.databases()).flatMap((entry) =>
                    entry.name === undefined ? [] : [entry.name],
                  ),
                  databaseName,
                }
              },
            )
          },
          { databaseName, repairedDatabaseName },
        ),
      )
      .toMatchObject({
        version: 980,
        repairedRows: [
          {
            key: 'manifest-proof:chromium-v94',
            value: 'preserved',
          },
          expect.objectContaining({
            id: 'legacy-repair-chat',
            folderId: 'legacy-repair-folder',
            lastUpdatedLeafId: 'legacy-message-299',
            wordCount: 900,
          }),
          expect.objectContaining({
            id: 'workspace',
            kind: 'workspace',
            totalCount: 1,
          }),
          expect.objectContaining({
            id: 'folder:legacy-repair-folder',
            kind: 'folder',
            count: 1,
          }),
        ],
        databases: expect.not.arrayContaining([databaseName]),
      })
  } finally {
    await competingPage.close()
  }
})

function legacyRepairFixtureRows(settings: unknown) {
  const stored = Array.from({ length: 300 }, (_, index) => {
    const id = `legacy-message-${index.toString().padStart(3, '0')}`
    const parentId =
      index === 0 ? null : `legacy-message-${(index - 1).toString().padStart(3, '0')}`
    const text = `legacy message ${index.toString().padStart(3, '0')}`
    return {
      header: {
        id,
        chatId: 'legacy-repair-chat',
        parentId,
        siblingIndex: 0,
        turnId: `legacy-turn-${index.toString().padStart(3, '0')}`,
        turnIndex: index,
        createdAt: index + 1,
        role: index % 2 === 0 ? 'user' : 'assistant',
        origin: index % 2 === 0 ? 'user' : 'generated',
        nodeVersion: 0,
        deleted: false,
        attachmentRefs: [],
        requestContextVersion: 0,
        bodyVersion: 0,
        bodyWordCount: 0,
        bodyTextCharCount: 0,
        bodyMediaCount: 0,
        bodyRenderCost: 0,
        contextRouteFacts: {
          reasoningCarriers: [],
          hasOpenAiResponsesProviderOutput: false,
        },
        treeParentKey: parentId ?? '__root__',
        treeLive: 1,
      },
      body: {
        id,
        chatId: 'legacy-repair-chat',
        bodyVersion: 0,
        updatedAt: index + 1,
        content: [{ type: 'text', text }],
      },
      preview: {
        id,
        chatId: 'legacy-repair-chat',
        bodyVersion: 0,
        text,
      },
    }
  })
  return {
    folder: {
      id: 'legacy-repair-folder',
      name: 'Legacy repair folder',
      sortIndex: 0,
      createdAt: 1,
      updatedAt: 1,
      lastUsedAt: 1,
    },
    chat: {
      id: 'legacy-repair-chat',
      title: 'Legacy repair chat',
      titleStatus: 'manual',
      createdAt: 1,
      updatedAt: 300,
      lastViewedAt: 300,
      wordCount: 0,
      totalCostUsd: 0,
      metaVersion: 0,
      summaryVersion: 0,
      structuralVersion: 0,
      configurationVersion: 0,
      settings,
      lastUpdatedLeafId: null,
      lastBranchUpdatedAt: 300,
      archived: false,
      pinned: false,
      folderId: 'legacy-repair-folder',
      tags: [],
    },
    headers: stored.map(({ header }) => header),
    bodies: stored.map(({ body }) => body),
    previews: stored.map(({ preview }) => preview),
  }
}

test('a poisoned local database shows recovery instead of a blank root', async ({ page }) => {
  await waitForWorkspaceRunning(page)
  const resetRoute = '**/__startup-recovery-reset__'
  await page.route(resetRoute, (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Reset</title>' }),
  )
  await page.goto('/__startup-recovery-reset__')
  const { databaseName, schema } = await readOfflineWorkspaceSnapshot(page, false)
  await page.evaluate(
    async ({ databaseName, schema }) => {
      await globalThis.__natterNativeStorageFixture.deleteOffline({
        databaseName: databaseName,
        purpose: 'legacy-fixture',
      })
      return globalThis.__natterNativeStorageFixture.offline(
        {
          purpose: 'legacy-fixture',
          databaseName: databaseName,
          version: 250,
          upgrade: (upgradeDatabase) => {
            for (const definition of schema) {
              const store = upgradeDatabase.createObjectStore(definition.name, {
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
          },
        },
        async (db) => {
          const transaction = db.transaction('messages', 'readwrite')
          transaction.objectStore('messages').put({
            id: 'message-poison',
            chatId: 'chat-poison',
            bodyVersion: 0,
            nodeVersion: 0,
            requestContextVersion: 0,
          })
        },
      )
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

function readOfflineWorkspaceSnapshot(page: Page, includeRows: boolean) {
  return page.evaluate(
    (includeRows) =>
      globalThis.__natterNativeStorageFixture.active(
        { purpose: 'read-only-assertion' },
        async (database, request, binding) => {
          const names = Array.from(database.objectStoreNames)
          const transaction = database.transaction(names, 'readonly')
          const schema = names.map((name) => {
            const store = transaction.objectStore(name)
            return {
              name,
              keyPath: store.keyPath,
              autoIncrement: store.autoIncrement,
              indexes: Array.from(store.indexNames).map((name) => {
                const index = store.index(name)
                return {
                  name,
                  keyPath: index.keyPath,
                  unique: index.unique,
                  multiEntry: index.multiEntry,
                }
              }),
            }
          })
          const rows = includeRows
            ? await Promise.all(
                names.map(async (name) => ({
                  name,
                  rows: (await request(transaction.objectStore(name).getAll())) as unknown[],
                })),
              )
            : []
          return { databaseName: binding.databaseName, schema, rows }
        },
      ),
    includeRows,
  )
}
