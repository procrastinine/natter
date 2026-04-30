import { expect, type Page, test } from '@playwright/test'
import { clearIndexedDb, createChatAndOpen, firstChatId, seedFirstRun } from './helpers'

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await clearIndexedDb(page)
  await mockModelLists(page)
})

test('UI crosswalks Claude between OpenRouter and Anthropic in both directions', async ({
  page,
}) => {
  await seedFirstRun(page, { model: 'anthropic/claude-opus-4.6' })
  await createChatAndOpen(page)
  await openSettingsPanel(page)
  await expectNoUnavailableBanner(page)

  await addConnectionThroughGui(page, 'anthropic', {
    key: 'sk-ant-test',
    expectedName: 'Anthropic',
  })
  await expectStoredModel(page, 'claude-opus-4.6')
  await expectNoUnavailableBanner(page)

  await switchConnectionThroughGui(page, 'OpenRouter')
  await expectStoredModel(page, 'anthropic/claude-opus-4.6')
  await expectNoUnavailableBanner(page)
})

test('UI crosswalks Gemini between OpenRouter and Google in both directions', async ({ page }) => {
  await seedFirstRun(page, { model: 'google/gemini-3.1-pro-preview' })
  await createChatAndOpen(page)
  await openSettingsPanel(page)
  await expectNoUnavailableBanner(page)

  await addConnectionThroughGui(page, 'google', {
    key: 'AIza-test',
    expectedName: 'Google',
  })
  await expectStoredModel(page, 'models/gemini-3.1-pro-preview')
  await expectNoUnavailableBanner(page)

  await switchConnectionThroughGui(page, 'OpenRouter')
  await expectStoredModel(page, 'google/gemini-3.1-pro-preview')
  await expectNoUnavailableBanner(page)
})

test('UI crosswalks GPT between OpenRouter and OpenAI in both directions', async ({ page }) => {
  await seedFirstRun(page, { model: 'openai/gpt-5.4' })
  await createChatAndOpen(page)
  await openSettingsPanel(page)
  await expectNoUnavailableBanner(page)

  await addConnectionThroughGui(page, 'openai-compatible', {
    key: 'sk-test-openai',
    expectedName: 'OpenAI',
  })
  await expectStoredModel(page, 'gpt-5.4')
  await expectNoUnavailableBanner(page)

  await switchConnectionThroughGui(page, 'OpenRouter')
  await expectStoredModel(page, 'openai/gpt-5.4')
  await expectNoUnavailableBanner(page)
})

test('UI does not flash an unavailable warning while clearing a non-equivalent model', async ({
  page,
}) => {
  await seedFirstRun(page, { model: 'openai/gpt-5.4' })
  await createChatAndOpen(page)
  await openSettingsPanel(page)
  await expectNoUnavailableBanner(page)

  await startUnavailableWarningRecorder(page)
  await addConnectionThroughGui(page, 'anthropic', {
    key: 'sk-ant-test',
    expectedName: 'Anthropic',
  })
  await expectStoredModel(page, '')
  await expect(page.locator('[data-ui="notice-banner"][data-tone="info"]')).toContainText(
    'Pick a model for',
  )
  await expectNoRecordedUnavailableWarnings(page)
})

async function mockModelLists(page: Page): Promise<void> {
  await page.route('https://openrouter.ai/api/v1/models**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: [
          modelRow('anthropic/claude-opus-4.6'),
          modelRow('google/gemini-3.1-pro-preview'),
          modelRow('openai/gpt-5.4'),
        ],
      }),
    })
  })
  await page.route('https://api.anthropic.com/v1/models**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [] }),
    })
  })
  await page.route('https://generativelanguage.googleapis.com/v1beta/openai/models**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: [
          { id: 'models/gemini-3.1-pro-preview', object: 'model', created: 0 },
          { id: 'models/gemini-3.1-flash-lite-preview', object: 'model', created: 0 },
        ],
      }),
    })
  })
  await page.route('https://api.openai.com/v1/models**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: [
          { id: 'gpt-5.4', object: 'model', created: 0 },
          { id: 'gpt-4o', object: 'model', created: 0 },
        ],
      }),
    })
  })
}

function modelRow(id: string): Record<string, unknown> {
  return {
    id,
    name: id,
    context_length: 200000,
    architecture: {
      input_modalities: ['text'],
      output_modalities: ['text'],
      tokenizer: id.includes('gpt') ? 'o200k_base' : 'unknown',
    },
    supported_parameters: ['provider', 'max_tokens'],
  }
}

async function openSettingsPanel(page: Page): Promise<void> {
  const panel = page.locator('[data-ui="chat-model-panel"]')
  if ((await panel.count()) === 0) {
    await page.locator('[data-role="settings-cog"]').click()
  }
  await expect(panel).toBeVisible()
  await page.getByRole('tab', { name: 'Model' }).click()
}

async function expectNoUnavailableBanner(page: Page): Promise<void> {
  await openSettingsPanel(page)
  await expect(page.locator('[data-ui="notice-banner"][data-tone="warning"]')).toHaveCount(0)
}

async function startUnavailableWarningRecorder(page: Page): Promise<void> {
  await page.evaluate(() => {
    type RecorderWindow = Window & {
      __providerCrosswalkWarnings?: string[]
      __providerCrosswalkObserver?: MutationObserver
    }
    const w = window as RecorderWindow
    w.__providerCrosswalkWarnings = []
    w.__providerCrosswalkObserver?.disconnect()
    const record = () => {
      for (const el of document.querySelectorAll(
        '[data-ui="notice-banner"][data-tone="warning"]',
      )) {
        const text = el.textContent?.trim() ?? ''
        if (text.includes("isn't served")) w.__providerCrosswalkWarnings?.push(text)
      }
    }
    const observer = new MutationObserver(record)
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })
    w.__providerCrosswalkObserver = observer
    record()
  })
}

async function expectNoRecordedUnavailableWarnings(page: Page): Promise<void> {
  const warnings = await page.evaluate(() => {
    type RecorderWindow = Window & {
      __providerCrosswalkWarnings?: string[]
      __providerCrosswalkObserver?: MutationObserver
    }
    const w = window as RecorderWindow
    w.__providerCrosswalkObserver?.disconnect()
    return w.__providerCrosswalkWarnings ?? []
  })
  expect(warnings).toEqual([])
}

async function addConnectionThroughGui(
  page: Page,
  kind: 'anthropic' | 'google' | 'openai-compatible',
  opts: { key: string; expectedName: string },
): Promise<void> {
  await openConnectionDetail(page)
  await page.locator('[data-ui="connection-new"]').click()
  await page.locator('[data-ui="connection-setup-kind"]').selectOption(kind)
  await page.locator('[data-ui="connection-setup-key"]').fill(opts.key)
  await page.locator('[data-ui="connection-setup-submit"]').click()
  await page.locator('[data-ui="connection-setup-modal"]').waitFor({ state: 'detached' })
  await expect(page.locator('[data-ui="connection-name"]')).toContainText(opts.expectedName)
}

async function switchConnectionThroughGui(page: Page, profileName: string): Promise<void> {
  await openConnectionDetail(page)
  await page.locator('[data-ui="connection-profile-select"]').selectOption({ label: profileName })
  await expect(page.locator('[data-ui="connection-name"]')).toContainText(profileName)
}

async function openConnectionDetail(page: Page): Promise<void> {
  const detailAction = page.locator('[data-ui="connection-new"]')
  if (await detailAction.isVisible()) return
  const row = page.locator('[data-ui="connection-row"]')
  if ((await row.count()) === 0) {
    await page.locator('[data-ui="connection-provider-button"]').click()
    await expect(row).toBeVisible()
  }
  if ((await row.getAttribute('aria-expanded')) !== 'true') {
    await row.click()
  }
  await expect(detailAction).toBeVisible()
}

async function expectStoredModel(page: Page, expected: string): Promise<void> {
  await expect
    .poll(async () => {
      const settings = await readLatestChatSettings(page)
      return settings.model
    })
    .toBe(expected)
}

async function readLatestChatSettings(page: Page): Promise<{ model: string; profileId: string }> {
  const chatId = await firstChatId(page)
  return page.evaluate(async (id) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('natter')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    try {
      return await new Promise<{ model: string; profileId: string }>((resolve, reject) => {
        const tx = db.transaction('chats', 'readonly')
        const req = tx.objectStore('chats').get(id)
        req.onsuccess = () => {
          const settings = (req.result?.settings ?? {}) as { model?: string; profileId?: string }
          resolve({ model: settings.model ?? '', profileId: settings.profileId ?? '' })
        }
        req.onerror = () => reject(req.error)
      })
    } finally {
      db.close()
    }
  }, chatId)
}
