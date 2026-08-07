import { readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { type BrowserContext, chromium, expect, type Page, test } from '@playwright/test'
import {
  GENERATED_WORKSPACE_ACTIVE_CHAT_ID,
  GENERATED_WORKSPACE_ACTIVE_TERMINAL_ID,
  GENERATED_WORKSPACE_FIXTURE_VERSION,
  GENERATED_WORKSPACE_SCALES,
  generatedWorkspaceFixtureStats,
  generateWorkspaceFixture,
} from '../../scripts/generated-workspace-fixture.mjs'
import { transformWorkspaceThroughUi } from '../../scripts/workspace-provider-fixture.mjs'
import {
  commitGeneratedWorkspaceBrowserProfile,
  type GeneratedWorkspaceStateManifest,
  type GeneratedWorkspaceStateName,
  generatedWorkspaceBrowserProfilePath,
  generatedWorkspaceCacheFingerprint,
  generatedWorkspaceDirectoryFootprint,
  generatedWorkspaceTemporaryBrowserProfilePath,
  prepareGeneratedWorkspaceCacheDirectory,
  readReusableGeneratedWorkspaceStateManifest,
  removeObsoleteGeneratedWorkspaceStateFiles,
  writeGeneratedWorkspaceStateManifest,
} from './generated-workspace-state'
import { seedFirstRun } from './helpers'

test.describe.configure({ timeout: 15 * 60_000 })

test('cache deterministic current-schema large-workspace browser states', async ({ baseURL }) => {
  if (!baseURL) throw new Error('GeneratedWorkspaceBaseUrlMissing')
  const origin = new URL(baseURL).origin
  const reusable = await readReusableGeneratedWorkspaceStateManifest(origin)
  if (reusable) {
    test.info().annotations.push({
      type: 'generated-workspace-cache',
      description: `reused ${reusable.fingerprint.slice(0, 12)}`,
    })
    return
  }

  await prepareGeneratedWorkspaceCacheDirectory()
  const states = {} as GeneratedWorkspaceStateManifest['states']
  for (const name of Object.keys(GENERATED_WORKSPACE_SCALES) as GeneratedWorkspaceStateName[]) {
    const scale = GENERATED_WORKSPACE_SCALES[name]
    const setupStartedAt = performance.now()
    const temporaryProfilePath = await generatedWorkspaceTemporaryBrowserProfilePath(name, 'build')
    const launchStartedAt = performance.now()
    const context = await chromium.launchPersistentContext(temporaryProfilePath, {
      baseURL,
      viewport: { width: 1_280, height: 720 },
    })
    const browserLaunchMs = performance.now() - launchStartedAt
    const page = context.pages()[0] ?? (await context.newPage())
    let generated: ReturnType<typeof generateWorkspaceFixture> | undefined
    let committed = false
    try {
      await installProviderCatalogFixture(context)
      await page.goto('/')
      await seedFirstRun(page)
      const importStartedAt = performance.now()
      await transformWorkspaceThroughUi(
        page,
        (backup) => {
          generated = generateWorkspaceFixture(
            backup as unknown as Parameters<typeof generateWorkspaceFixture>[0],
            scale,
          )
          return generated as unknown as Record<string, unknown>
        },
        {
          filename: `natter-generated-${name}-workspace.json`,
          returnUrl: new URL(
            `/#/chat/${GENERATED_WORKSPACE_ACTIVE_CHAT_ID}/message/${GENERATED_WORKSPACE_ACTIVE_TERMINAL_ID}`,
            baseURL,
          ).href,
        },
      )
      const publicImportMs = performance.now() - importStartedAt
      if (!generated) throw new Error(`GeneratedWorkspaceTransformMissing:${name}`)
      await expect(page.locator('[data-ui="app-shell"]')).toHaveAttribute(
        'data-workspace-runtime-state',
        'RUNNING',
        { timeout: 30_000 },
      )
      await expect(
        page.locator(
          `[data-ui="message"][data-message-id="${GENERATED_WORKSPACE_ACTIVE_TERMINAL_ID}"] [data-ui="message-body"]`,
        ),
      ).toBeVisible({ timeout: 30_000 })
      await waitForGeneratedWorkspaceStorageQuiescence(page)
      const closeStartedAt = performance.now()
      await context.close()
      const browserCloseMs = performance.now() - closeStartedAt
      const footprint = await generatedWorkspaceDirectoryFootprint(temporaryProfilePath)
      const browserProfilePath = await commitGeneratedWorkspaceBrowserProfile(
        name,
        temporaryProfilePath,
      )
      committed = true
      states[name] = {
        browserProfilePath,
        appStorageSchemaVersion: generated.appStorageSchemaVersion,
        stats: generatedWorkspaceFixtureStats(generated),
        footprint,
        setup: {
          totalMs: performance.now() - setupStartedAt,
          browserLaunchMs,
          publicImportMs,
          browserCloseMs,
        },
      }
    } finally {
      if (!context.pages().every((candidate) => candidate.isClosed())) {
        await context.close().catch(() => undefined)
      }
      if (!committed) await rm(temporaryProfilePath, { recursive: true, force: true })
    }
  }

  const playwrightPackage = JSON.parse(
    await readFile(resolve('node_modules/@playwright/test/package.json'), 'utf8'),
  ) as { version?: unknown }
  const manifest: GeneratedWorkspaceStateManifest = {
    fixtureVersion: GENERATED_WORKSPACE_FIXTURE_VERSION,
    fingerprint: await generatedWorkspaceCacheFingerprint(origin),
    origin,
    playwrightVersion:
      typeof playwrightPackage.version === 'string' ? playwrightPackage.version : 'unknown',
    generatedAt: new Date().toISOString(),
    states,
  }
  await writeGeneratedWorkspaceStateManifest(manifest)
  await removeObsoleteGeneratedWorkspaceStateFiles()
  for (const name of Object.keys(GENERATED_WORKSPACE_SCALES) as GeneratedWorkspaceStateName[]) {
    expect(states[name].browserProfilePath).toBe(generatedWorkspaceBrowserProfilePath(name))
  }
})

async function installProviderCatalogFixture(context: BrowserContext) {
  await context.route('https://openrouter.ai/api/v1/models*', (route) =>
    route.fulfill({
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({
        data: [
          {
            id: 'google/gemini-3.5-flash',
            name: 'Gemini 3.5 Flash',
            supported_parameters: ['tools'],
          },
        ],
      }),
    }),
  )
}

async function waitForGeneratedWorkspaceStorageQuiescence(page: Page) {
  await page.waitForFunction(
    async ({ controlDatabaseName, recoveryIntentPrefix }) => {
      const recoveryPending = Array.from({ length: localStorage.length }, (_value, index) =>
        localStorage.key(index),
      ).some((key) => key?.startsWith(recoveryIntentPrefix))
      if (recoveryPending) return false
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(controlDatabaseName)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      try {
        const state = await new Promise<
          | {
              readonly manifest: { activeDatabaseName?: unknown; pending?: unknown }
              readonly compaction:
                | { completedRevision?: unknown; requestRevision?: unknown }
                | undefined
            }
          | undefined
        >((resolve, reject) => {
          const transaction = database.transaction(['compactionStates', 'manifests'], 'readonly')
          const manifestRequest = transaction.objectStore('manifests').get('workspace')
          manifestRequest.onerror = () => reject(manifestRequest.error)
          manifestRequest.onsuccess = () => {
            const manifest = manifestRequest.result as
              | { activeDatabaseName?: unknown; pending?: unknown }
              | undefined
            if (!manifest || typeof manifest.activeDatabaseName !== 'string') {
              resolve(undefined)
              return
            }
            const compactionRequest = transaction
              .objectStore('compactionStates')
              .get(manifest.activeDatabaseName)
            compactionRequest.onerror = () => reject(compactionRequest.error)
            compactionRequest.onsuccess = () =>
              resolve({
                manifest,
                compaction: compactionRequest.result as
                  | { completedRevision?: unknown; requestRevision?: unknown }
                  | undefined,
              })
          }
        })
        return (
          state !== undefined &&
          state.manifest.pending === undefined &&
          typeof state.compaction?.requestRevision === 'number' &&
          typeof state.compaction.completedRevision === 'number' &&
          state.compaction.requestRevision <= state.compaction.completedRevision
        )
      } finally {
        database.close()
      }
    },
    {
      controlDatabaseName: 'natter-control',
      recoveryIntentPrefix: 'natter:storage-compaction-intent:v1:',
    },
    { timeout: 60_000 },
  )
}
