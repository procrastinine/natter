import { readFileSync } from 'node:fs'
import { expect, type Page, test } from './fixtures'
import {
  activeWorkspaceDatabaseName,
  firstChatId,
  type IndexedDbDump,
  importIndexedDbDump,
  readChatRow,
} from './helpers'

const dumpPath = process.env.NATTER_IDB_DUMP
const ANTHROPIC_MODEL = 'anthropic/claude-opus-4.7'

test.skip(!dumpPath, 'Set NATTER_IDB_DUMP=/absolute/path/to/natter-indexeddb-dump.json')

test('restored IndexedDB dump can check the exact Anthropic provider row', async ({ page }) => {
  const consoleLines: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      consoleLines.push(`${msg.type()}: ${msg.text()}`)
    }
  })
  const dump = JSON.parse(readFileSync(dumpPath as string, 'utf8')) as IndexedDbDump
  await routeOpenRouterFromDump(page, dump)
  await importIndexedDbDump(page, dump)
  await page.goto('/')
  await expect
    .poll(() => legacyProviderSettingsSummary(page))
    .toEqual({
      legacyChats: [],
      legacyPresets: [],
      legacyDisplayRefs: [],
    })

  await openMostRecentChat(page)

  const panel = page.locator('[data-ui="chat-model-panel"]')
  if ((await panel.count()) === 0) {
    await page.locator('[data-role="settings-cog"]').click()
  }
  await expect(page.locator('[data-ui="chat-model-panel"]')).toBeVisible()
  await page.getByRole('tab', { name: 'Model' }).click()
  await page.locator('[data-ui="model-picker-search-input"]').fill(ANTHROPIC_MODEL)
  await page
    .locator('[data-ui="picker-row-pick"]')
    .filter({ hasText: ANTHROPIC_MODEL })
    .first()
    .click()

  const row = page
    .locator('[data-ui="provider-picker-row"]')
    .filter({ hasText: 'Anthropic (anthropic)' })
    .first()
  await expect(row).toBeVisible()
  await expect(row).toHaveAttribute('data-allowed', 'false')
  await row.getByLabel('Use Anthropic (anthropic)', { exact: true }).click()
  await expect(row).toHaveAttribute('data-allowed', 'true')

  const chatId = page.url().match(/#\/chat\/([^/?#]+)/u)?.[1]
  if (!chatId) throw new Error('missing chat id')
  const chat = (await readChatRow(page, chatId)) as {
    settings?: { privacy?: unknown; providerPrefs?: unknown }
  }
  const state = {
    privacy: chat.settings?.privacy,
    providerPrefs: chat.settings?.providerPrefs,
  }
  expect(JSON.stringify(state)).toContain('"ignoreOverridesFilter":true')
  expect(JSON.stringify(state)).not.toContain('"ignoreProviders":["Anthropic"]')
  expect(consoleLines).toEqual([])
})

async function legacyProviderSettingsSummary(page: Page): Promise<{
  legacyChats: string[]
  legacyPresets: string[]
  legacyDisplayRefs: string[]
}> {
  const databaseName = await activeWorkspaceDatabaseName(page)
  return page.evaluate(async (databaseName) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(databaseName)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    try {
      return await new Promise<{
        legacyChats: string[]
        legacyPresets: string[]
        legacyDisplayRefs: string[]
      }>((resolve, reject) => {
        const tx = db.transaction(['chats', 'presets'], 'readonly')
        const chatReq = tx.objectStore('chats').getAll()
        const presetReq = tx.objectStore('presets').getAll()
        tx.oncomplete = () => {
          const legacyChats: string[] = []
          const legacyPresets: string[] = []
          const legacyDisplayRefs: string[] = []
          for (const chat of chatReq.result as Array<{
            id: string
            settings?: {
              privacy?: { ignoreProviders?: string[]; onlyProviders?: string[] }
              providerPrefs?: { ignore?: string[]; only?: string[]; order?: string[] }
            }
          }>) {
            if ((chat.settings?.privacy?.ignoreProviders?.length ?? 0) > 0)
              legacyChats.push(chat.id)
            if ((chat.settings?.privacy?.onlyProviders?.length ?? 0) > 0) legacyChats.push(chat.id)
            collectLegacyDisplayRefs(
              `chat:${chat.id}`,
              chat.settings?.providerPrefs,
              legacyDisplayRefs,
            )
          }
          for (const preset of presetReq.result as Array<{
            id: string
            settings?: {
              privacy?: { ignoreProviders?: string[]; onlyProviders?: string[] }
              providerPrefs?: { ignore?: string[]; only?: string[]; order?: string[] }
            }
          }>) {
            if ((preset.settings?.privacy?.ignoreProviders?.length ?? 0) > 0) {
              legacyPresets.push(preset.id)
            }
            if ((preset.settings?.privacy?.onlyProviders?.length ?? 0) > 0) {
              legacyPresets.push(preset.id)
            }
            collectLegacyDisplayRefs(
              `preset:${preset.id}`,
              preset.settings?.providerPrefs,
              legacyDisplayRefs,
            )
          }
          resolve({ legacyChats, legacyPresets, legacyDisplayRefs })
        }
        tx.onerror = () => reject(tx.error)
      })
    } finally {
      db.close()
    }

    function collectLegacyDisplayRefs(
      row: string,
      prefs: { ignore?: string[]; only?: string[]; order?: string[] } | undefined,
      out: string[],
    ) {
      for (const key of ['ignore', 'only', 'order'] as const) {
        for (const ref of prefs?.[key] ?? []) {
          if (ref === 'Anthropic') out.push(`${row}:${key}:${ref}`)
        }
      }
    }
  }, databaseName)
}

async function openMostRecentChat(page: Page): Promise<void> {
  const chatId = await firstChatId(page)
  if (!chatId) throw new Error('No chat found in IndexedDB dump')
  await page.goto(`/#/chat/${chatId}`)
}

async function routeOpenRouterFromDump(page: Page, dump: IndexedDbDump): Promise<void> {
  const modelsRows = dump.stores.models ?? []
  const endpointRows = dump.stores.endpoints ?? []
  const privacyRows = dump.stores.privacyPolicies ?? []
  await page.route('https://openrouter.ai/api/v1/models**', async (route) => {
    const row = modelsRows.find((row) => {
      const rec = row as { payload?: { data?: unknown[] } }
      return Array.isArray(rec.payload?.data) && rec.payload.data.length > 0
    }) as { payload?: unknown } | undefined
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(row?.payload ?? { data: [] }),
    })
  })
  await page.route('https://openrouter.ai/api/v1/models/**/endpoints', async (route) => {
    const url = new URL(route.request().url())
    const suffix = url.pathname.replace('/api/v1/models/', '').replace('/endpoints', '')
    const modelId = decodeURIComponent(suffix)
    const row = endpointRows.find((row) => (row as { modelId?: string }).modelId === modelId) as
      | { payload?: unknown }
      | undefined
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(row?.payload ?? { data: { id: modelId, endpoints: [] } }),
    })
  })
  await page.route('**/_or_scrape/**', async (route) => {
    const url = new URL(route.request().url())
    const target = url.searchParams.get('url') ?? url.pathname
    const row = privacyRows.find((row) =>
      target.includes((row as { modelId?: string }).modelId ?? '\u0000'),
    ) as { payload?: { policies?: Record<string, unknown> } } | undefined
    const providers = Object.entries(row?.payload?.policies ?? {}).map(
      ([provider_name, data_policy]) => ({
        provider_name,
        data_policy,
      }),
    )
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
        props: { pageProps: { providers } },
      })}</script>`,
    })
  })
}
